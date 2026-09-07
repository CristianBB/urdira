import { canonicalBytes, digestBytes, digestCanonicalArray } from "@urdira/canonical";
import { facetRegistry, languageRegistry, universalEntityKinds, universalRelationKinds, type QueryScope, type SemanticAffectedArtifactPage, type SemanticAffectedArtifactView, type SemanticCoverageView, type SingleWorkspaceScope, type SnapshotCapabilityStateEntry, type SourceSpan, type StructuralFilter } from "@urdira/contracts";
import type { RelationalValueRow } from "@urdira/storage";
import type { SqliteDatabase } from "@urdira/storage";
import { mapWithConcurrency } from "./concurrency.js";
import { EngineError, EngineErrorWithDetails } from "./errors.js";
import { QueryPlanError } from "./query-plan.js";
import { toSubjectSelector } from "./recipe-executor.js";
import { expandRelations, findShortestPaths, type OperationEvaluation, type OperationInvocation, type QueryDataPort, type QueryStreamItem, type RelationEdge } from "./query-operators.js";
import { decodeRow, object, type RecordRow } from "./query-record-decode.js";
import type { RecordBodyInterner } from "./record-body-interner.js";
import type { ResolvedSemanticProvider } from "./semantic-provider.js";
import { exactVectorScan, fuseSemanticLanes, rerankSemanticMatches, type RankedSemanticCandidate } from "./semantic-retrieval.js";
import type { StageSetHandle } from "./stage-set-handle.js";

export interface CanonicalQueryRecord {
  readonly record_id: string;
  readonly workspace_id: string;
  readonly category: string;
  readonly kind: string;
  readonly universal_kind: string;
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly primary_source_span?: SourceSpan;
  readonly identity_id?: string;
  readonly identity_key?: string;
  readonly facets?: readonly string[];
  readonly body: Readonly<Record<string, unknown>>;
}

/** Column-expressible subset of `RecordStructuralSelector` that `records_by_selector` can push down to SQL. */
export interface RecordColumnSelector {
  readonly categories?: readonly string[];
  readonly universal_kinds?: readonly string[];
  readonly kinds?: readonly string[];
}

export interface IndexedGraphEdge {
  readonly edge_id: string;
  readonly source_subject_id: string;
  readonly target_subject_id: string;
  readonly relation_record_id: string;
  readonly relation_kind: string;
  readonly role: string;
  readonly evidence_class: string;
}

export interface CanonicalQuerySnapshotPort {
  /**
   * Query-only fallback for operations whose predicate is not yet expressible
   * as a bounded SQL projection. Implementations must use paginated SQL and
   * must not populate the warm corpus cache. The legacy `records` method is
   * retained only for non-SQL adapters and compatibility tests.
   */
  readonly records_for_query?: (scope: QueryScope) => Promise<readonly CanonicalQueryRecord[]>;
  /** Bounded query reader for graph/set operations. Implementations must not
   * retain the complete decoded corpus while yielding batches. */
  readonly records_for_query_batches?: (scope: QueryScope, batch_size?: number) => AsyncIterable<readonly CanonicalQueryRecord[]>;
  readonly records: (scope: QueryScope) => Promise<readonly CanonicalQueryRecord[]>;
  readonly capability_states?: (scope: QueryScope) => Promise<readonly SnapshotCapabilityStateEntry[]>;
  readonly artifact_text?: (scope: QueryScope, artifact_version_id: string) => Promise<{ readonly text: string } | undefined>;
  /**
   * True iff a complete corpus for `scope`'s current generation is already
   * sitting in the generation-keyed cache -- i.e. a `records()` call right
   * now would resolve synchronously from cache rather than paying a full
   * load or delta. Must never itself trigger a load: it exists so callers
   * (namely `CanonicalRecordQueryDataPort.execute`) can decide whether the
   * in-memory path is already "free" (skip pushdown, use it) or would
   * require paying the full corpus cost first (try pushdown instead).
   * Optional: ports that have no such cache (or none of the pushdown
   * methods below) simply omit it, which callers treat as "not warm".
   */
  readonly has_warm_records?: (scope: QueryScope) => Promise<boolean>;
  /**
   * Resolves records by any of the three id forms a `SubjectSelector`
   * carries (`record_id`, `identity_id`, or `identity_key`), decoding and
   * mapping only the matching rows -- for `core:get_source`'s subject
   * resolution without paying for a full corpus load. Visibility-filtered
   * exactly like `records()`. Order of the result is unspecified; callers
   * that care about order look records up by id afterward.
   */
  /**
   * Also the entity-grain candidate hydration path (decision 17):
   * `trySemanticSearch` resolves entity semantic candidates (ranked by
   * `document_ref`, i.e. the owning entity record's own `record_id`) through
   * this SAME method rather than a separate one -- an entity candidate id IS
   * exactly a `record_id`, so no new port method was needed for it.
   */
  readonly records_by_ids?: (scope: QueryScope, ids: readonly string[]) => Promise<readonly CanonicalQueryRecord[]>;
  /**
   * Resolves records whose `identity_key`'s final `:`-delimited segment is
   * exactly `name` (a case-sensitive, whole-segment match -- never a
   * partial-suffix false positive), for `core:resolve_symbol`'s name-based
   * lookup without a full corpus load. Visibility-filtered like `records()`.
   */
  readonly records_by_name?: (scope: QueryScope, name: string) => Promise<readonly CanonicalQueryRecord[]>;
  /**
   * Resolves up to `limit` records matching the column-expressible parts of
   * a `core:find_records` selector (category/universal_kind/kind), ordered
   * deterministically by `record_id`, for pushdown without a full corpus
   * load. Callers that get back exactly `limit` rows cannot tell whether
   * more would-be matches exist beyond the cutoff and must treat the result
   * as incomplete (typically: fall back to the full in-memory path) --
   * passing `limit + 1` and checking for overflow is the intended pattern.
   * Visibility-filtered like `records()`.
   */
  readonly records_by_selector?: (scope: QueryScope, selector: RecordColumnSelector, limit: number) => Promise<readonly CanonicalQueryRecord[]>;
  /** Resolves container records through indexed artifact identity/path columns. */
  readonly container_records_by_artifact_references?: (scope: QueryScope, references: readonly string[]) => Promise<readonly CanonicalQueryRecord[]>;
  /** Reads the exact visible adjacency slice touching `subject_ids`. Returning
   * `undefined` means this snapshot has no authoritative graph projection and
   * requires the canonical-record fallback. */
  readonly graph_edges_by_subject_ids?: (scope: QueryScope, subject_ids: readonly string[], direction: "inbound" | "outbound" | "both") => Promise<readonly IndexedGraphEdge[] | undefined>;
  /** Indexed relation join over subject record ids. This is the preferred
   * handle-native path; it reads graph edge columns only and never hydrates
   * the complete record corpus. */
  readonly relation_pairs_by_subject_ids?: (scope: QueryScope, left_ids: readonly string[], right_ids: readonly string[], relation_selector: unknown, direction: "inbound" | "outbound" | "both") => Promise<ReadonlySet<string> | undefined>;
  /**
   * Literal-substring search over the workspace's FTS5-backed lexical
   * projection (`lexical_documents`/`lexical_fts`, built asynchronously
   * post-ready by `reconcileLexicalProjection`, `@urdira/engine`'s
   * `lexical-reconciler.ts`) for `core:search_text` pushdown -- this searches
   * real file text, unlike the in-memory corpus path (which only matches
   * against record body JSON). Returns `undefined` whenever the lexical
   * projection cannot be trusted as complete for `scope`'s current
   * generation (no port implementation, or `lexical_index_state.completed_generation`
   * does not equal the current generation), which callers must treat as "fall
   * back to the full in-memory path" -- never as "zero matches". Offsets are
   * string indices into the searched text (case-insensitive offsets are
   * indices into its NFKC-lowercased normalized form -- see
   * `WorkspaceProjectionRepository.searchLiteral`,
   * `packages/storage/src/projections.ts`, whose case/FTS5 semantics this
   * mirrors), one entry per non-overlapping match. `path_patterns`, when
   * supplied, is an exact glob filter applied by the lexical provider before
   * candidate caps and hydration; providers that cannot honor it should omit
   * this pushdown capability rather than widen the answer.
   */
  readonly search_literal?: (scope: QueryScope, pattern: string, options: { readonly case_sensitive?: boolean; readonly word_mode?: "substring" | "identifier" | "token"; readonly path_patterns?: readonly string[]; readonly include_generated?: boolean; readonly include_external?: boolean }) => Promise<readonly LexicalSearchMatch[] | undefined>;
  /**
   * Resolves one artifact-shaped `CanonicalQueryRecord` per given
   * `artifact_version_id`, for turning `search_literal` matches into
   * `core:search_text` stream items without a full corpus load.
   * Visibility-filtered like `records()`; chunked internally like
   * `records_by_ids`.
   *
   * NOTE on implementation, not just interface: `record_occurrences.category`
   * has a real, storage-layer `CHECK (category IN ('entity', 'relation',
   * 'fact', 'evidence', 'diagnostic'))` constraint (`packages/storage/src/schema.ts`)
   * -- `'artifact'` is not, and cannot become, a real persisted record
   * category. So despite the name, `SqliteCanonicalQuerySnapshotPort`'s
   * implementation does NOT query `record_occurrences` at all; it synthesizes
   * an in-memory `category: "artifact_subject"` record straight from `artifact_versions`
   * joined with `source_artifacts` (never persisted, so the CHECK constraint
   * never applies to it) -- see that method's doc comment for the reasoning.
   */
  readonly records_by_artifact_versions?: (scope: QueryScope, version_ids: readonly string[]) => Promise<readonly CanonicalQueryRecord[]>;
  /** Resolves the visible artifact subjects for `core:find_artifacts` without loading the record corpus. */
  readonly artifacts_by_filter?: (scope: QueryScope, filter?: StructuralFilter) => Promise<readonly CanonicalQueryRecord[]>;
  /**
   * The async post-ready semantic maintenance job's last-known state for
   * `scope`'s workspace, alongside `scope`'s CURRENT generation (so callers
   * never need a second round trip just to learn whether the marker is
   * current) -- mirrors `search_literal`'s `lexical_index_state` discipline,
   * except the marker also pins the embedding provider identity (see
   * `packages/storage/src/projections.ts`'s `SemanticIndexState` doc comment
   * for why `completed_generation` alone cannot answer "is this trustworthy
   * for the CURRENTLY configured provider"). `undefined` means "this
   * workspace has never been published" (no current generation at all) --
   * the same meaning `currentGeneration` returning `undefined` has
   * everywhere else in this class. A workspace that HAS been published but
   * has never completed a semantic maintenance pass still returns a defined
   * result, just with `completed_generation`/`profile_id`/`executable_binding_id`
   * all absent -- callers (namely `trySemanticSearch`) distinguish "never
   * published" from "published but not yet semantically indexed" exactly
   * that way.
   */
  readonly semantic_index_state?: (scope: QueryScope) => Promise<SemanticIndexStateSnapshot | undefined>;
  /**
   * Every OPEN-or-visible-at-the-current-generation vector row for
   * `(profile_id, executable_binding_id)`, ordered by `projection_record_id`
   * for determinism. Unfiltered, uncapped, and unranked -- `trySemanticSearch`
   * is responsible for structural filtering, deduplication, the exact-scan
   * cap, and ranking; this method's only job is "what is visible right now
   * under this exact provider identity," same division of labor
   * `search_literal`'s trigram candidates have relative to its caller.
   */
  readonly semantic_vectors?: (scope: QueryScope, profile_id: string, executable_binding_id: string) => Promise<readonly SemanticVectorRow[]>;
  /**
   * Cheap aggregate counts over `scope`'s visible, non-binary
   * `artifact_versions` -- how many exist at all, and how many of those
   * exceed `max_document_bytes` (and are therefore permanently ineligible
   * for embedding, mirroring the reconciler's own oversized-skip guard).
   * Exists so `trySemanticSearch`'s coverage view can report honest
   * artifact/pending/excluded counts computed from the SAME source the
   * reconciler counts against, rather than from whatever subset of vectors a
   * capped, filtered scan happened to touch.
   */
  readonly semantic_scope_counts?: (scope: QueryScope, max_document_bytes: number) => Promise<{ readonly artifact_count: number; readonly oversized_count: number }>;
  /**
   * Decision 17: a cheap aggregate count of visible entity records eligible
   * to CANDIDATE for the entity pass -- category `"entity"` and record `kind`
   * not the whole-file/module kind, exactly like `reconcileSemanticProjection`'s
   * own entity missing-insert query filters, but WITHOUT that query's
   * per-record body-decode eligibility checks (span length, `kind !==
   * "parameter"`, top-level position) -- those require the owning file's
   * text, which this method deliberately never reads, keeping it a single
   * `COUNT(*)` regardless of corpus size. Like `semantic_scope_counts`, this
   * is therefore an OVER-count relative to the reconciler's true eligible
   * set (mirroring how `semantic_scope_counts`'s own artifact "eligible"
   * count is also an approximation, not the reconciler's exact decode-and-
   * validate logic) -- an orientation number for the coverage view, not an
   * exact denominator.
   */
  readonly semantic_entity_scope_counts?: (scope: QueryScope) => Promise<{ readonly entity_count: number }>;
  /**
   * Plan 2026-09-06 (Frente S-A): real, per-`semantic_document_status`
   * counts for one exact vector space -- a single `GROUP BY document_grain,
   * status` over the status table. Replaces `semantic_scope_counts`/
   * `semantic_entity_scope_counts`'s inferred/over-counted
   * `unsupported_artifact_count`/`failed_artifact_count`/`entity_count`/
   * `covered_entity_count` in `buildSemanticCoverageView` whenever the port
   * implements this method; `undefined` keeps the pre-existing inferred
   * arithmetic exactly as it was (a v3/legacy-sidecar port with no status
   * table simply omits this, same optional-capability convention every other
   * `semantic_*` method here already uses).
   */
  readonly semantic_document_status_counts?: (scope: QueryScope, profile_id: string, executable_binding_id: string) => Promise<SemanticDocumentStatusCounts>;
  /**
   * Plan 2026-09-06 (Frente S-A): every AFFECTED (`status <> 'covered'`)
   * document's identity/status/reasons for one exact vector space, ordered
   * by `(display_path, artifact_id, document_id)` in ONE bulk read -- the
   * single pass `core:search_semantic`/`core:search_hybrid`'s embedded first
   * page and `core:semantic_affected_page`'s own keyset pagination both
   * paginate over in memory (never re-queried per page: this method's own
   * result IS the complete, stably-ordered affected set for this exact
   * `(generation, profile_id, executable_binding_id)`). Bounded by corpus
   * size, not by any page `limit` -- the same order of magnitude
   * `semantic_vectors` (unfiltered, uncapped) already accepts on every
   * semantic search call, so this is not a new performance-class cost.
   * `undefined` disables the "affected page" capability entirely (no
   * `affected_artifact_set_id`/`affected_artifact_page` on the coverage view,
   * and `core:semantic_affected_page` answers `core:required_capability_unsupported`).
   */
  readonly semantic_affected_documents?: (scope: QueryScope, profile_id: string, executable_binding_id: string) => Promise<readonly SemanticAffectedDocumentRow[]>;
  /**
   * `core:get_outline`'s additive `pending_sites` stream (evidence doc
   * 2026-09-04 §8): every visible `pending.sites` row
   * (`crates/urdira-structural-store`) owned by one artifact -- the
   * unresolved call/heritage sites `core:find_records`'s `possible`
   * rows and `jsts:unresolved_call` diagnostics used to expose before
   * that generation's fold, restored here as their own stream rather
   * than as records (they carry no graph-edge value, per that doc's
   * §1). `owner_artifact_version_id` narrows the ordinal lookup exactly
   * like `findArtifactOrdinal` elsewhere in this file (`container_records_by_artifact_references`'s
   * own pattern); `owner_artifact_id` alone still resolves when the
   * version id does not (or cannot) narrow further. Optional: a
   * v3/SQLite-backed port has no such table and simply omits this
   * method, which `pendingSitesStreamForOutline` treats as "empty,"
   * never an error -- the same convention every other optional
   * pushdown capability in this interface uses.
   */
  readonly pending_sites_by_owner_artifact?: (scope: QueryScope, owner_artifact_id: string, owner_artifact_version_id: string) => Promise<readonly PendingSiteRow[]>;
}

/** One `pending_sites_by_owner_artifact` row -- see that method's doc comment. */
export interface PendingSiteRow {
  readonly start: number;
  readonly end: number;
  readonly site_kind: "call" | "inherits" | "implements";
  readonly reason: string;
  readonly source_id?: string;
}

export interface SemanticIndexStateSnapshot {
  readonly generation: number;
  readonly completed_generation?: number;
  readonly profile_id?: string;
  readonly executable_binding_id?: string;
}

/** Plan 2026-09-06 (Frente S-A): `semantic_document_status_counts`'s own doc comment. */
export interface SemanticDocumentStatusCounts {
  readonly unsupported_artifact_count: number;
  readonly failed_artifact_count: number;
  readonly entity_count: number;
  readonly covered_entity_count: number;
}

/** Plan 2026-09-06 (Frente S-A): `semantic_affected_documents`'s own doc comment -- one row of `semantic_document_status`, minus the columns the affected view never surfaces (`segment_count`, `generation`, `updated_at`). */
export interface SemanticAffectedDocumentRow {
  readonly document_grain: "artifact" | "entity";
  readonly document_id: string;
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly display_path: string;
  readonly status: string;
  readonly reason_codes: readonly string[];
}

/**
 * One visible vector row as `semantic_vectors` returns it -- raw enough that
 * `trySemanticSearch` can feed it straight into `exactVectorScan`'s
 * `ExactVectorCandidate` shape without another round trip.
 *
 * `document_grain`/`document_ref` (decision 17): `document_grain` is
 * `"entity"` for a row produced by the entity pass, `undefined` for every
 * artifact-grain row (mirroring the storage column's NULL-means-artifact
 * convention, `vector_projection_rows` in `packages/storage/src/schema.ts`).
 * `document_ref` is the owning entity RECORD id for an entity row,
 * `undefined` for an artifact row -- `trySemanticSearch` keys its entity
 * lane's exact-scan candidates by THIS field (never by
 * `owner_artifact_version_id`, which many entity rows from the same file
 * legitimately share).
 */
export interface SemanticVectorRow {
  readonly projection_record_id: string;
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly vector_payload: Uint8Array;
  readonly dimensions: number;
  readonly element_type: string;
  readonly normalization: string;
  readonly distance_metric: string;
  readonly document_grain?: "artifact" | "entity";
  readonly document_ref?: string;
  /**
   * Frente S-B (2026-09-06, decision 17 segmentation): which segment of its
   * owning ENTITY document this row's vector was embedded from -- `0` for
   * every artifact-grain row and every pre-segmentation entity row (both
   * "segment 0 of 1" by construction, matching `vector_projection_rows.segment_index`'s
   * own `NOT NULL DEFAULT 0` column). `segment_start`/`segment_end` are the
   * segment's own `[start, end)` UTF-16 offsets into the entity's rendered
   * document text -- `undefined` (both together) for an un-segmented row.
   */
  readonly segment_index: number;
  readonly segment_start?: number;
  readonly segment_end?: number;
}

export interface LexicalSearchMatch {
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly offsets: readonly number[];
  /**
   * One source line span per offset, when the lexical provider can derive it
   * without changing its offset semantics. This is optional so adapters that
   * only expose offsets remain valid; callers must never fabricate line
   * numbers from an offset whose coordinate space they do not own.
   */
  readonly line_spans?: readonly (Pick<SourceSpan, "start_line" | "end_line">)[];
}

interface ContentReader {
  readonly read: (content_hash: string) => Promise<Uint8Array>;
}

const TEXT_CACHE_LIMIT = 64;
// Above this fraction of churned/added/identity-reassigned records (relative
// to the cached array's size), a windowed delta touches nearly as much work
// as a full reload while paying extra query/merge overhead on top -- so a
// full reload is strictly better. A full-reconciliation republish (e.g. a
// rebuilt index) is exactly the case meant to fall back here.
// Batch size for `yieldToEventLoop` breaks in the corpus-decode loops below
// (`loadAllRecords`/`deltaRecords`). Same pattern, same rationale, as
// `packages/engine/src/lexical-reconciler.ts`'s own `yieldToEventLoop`: a
// tight, fully-synchronous `decodeCanonical` loop over a multi-GB corpus
// (measured 8-11s for a full reload) starves the event loop for its entire
// duration, and `packages/daemon/src/runtime.ts`'s startup warm-up runs this
// sequentially, once per ready workspace, blocking `core:status`/`core:index_status`
// RPCs the whole time. `setImmediate` (not a resolved promise, not
// `setTimeout(fn, 0)`) queues onto the "check" phase, which runs after
// pending I/O callbacks for the current loop turn -- see the lexical
// reconciler's own doc comment for why that specific API matters here. Per
// record this loop's own work (JSON parse + a handful of object-shape
// checks in `decodeRow`) is far cheaper than one trigram-extraction pass
// was for the lexical reconciler, so yielding every single record would add
// far more relative overhead here than it did there -- batching every
// `RECORDS_YIELD_BATCH_SIZE` records instead keeps the per-yield "check
// phase" round-trip a small fraction of the batch's own decode work
// (empirically comfortably under the 5% overhead budget), while still
// yielding often enough (thousands of times across a multi-million-record
// corpus) to keep status RPCs responsive throughout the load.
const RECORDS_YIELD_BATCH_SIZE = 2_000;
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// The `decodeRows` yield above only covers the JS-side decode loop; it does
// nothing about the SQL fetch that loop's `rows` come from. `queryRecordRows`
// (below) runs one query with no `LIMIT` for the full-corpus and
// delta-refresh callers, and `SqliteDatabase.all` (see
// `packages/storage/src/sqlite.ts`'s `SqliteWorkerAdapter.all`) returns every
// matching `RecordRow` -- relational value rows are hydrated in bounded
// batches -- in ONE
// structured-clone `postMessage` from the SQLite worker thread. For a
// corpus-scale result that single clone is itself a synchronous stall (on
// both the worker thread building the message and the main thread receiving
// it) with no yield point inside it at all, same failure mode as the
// unyielded decode loop this file already fixed, just one layer earlier.
// `queryRecordRows` closes that gap by keyset-paginating those callers on
// `records.record_id` -- the same column every query here already
// `ORDER BY`s by, so this changes how many round trips produce the result,
// never the order or contents of the result itself -- fetching
// `ROW_FETCH_BATCH_SIZE` rows per round trip and yielding between them.
// Callers that pass an explicit `limit` (the pushdown paths in `tryPushdown`,
// and `records_by_ids`/`records_by_artifact_versions`'s small `IN (...)`
// chunks bounded by `DELTA_ID_CHUNK_SIZE`) already cap their own row count
// far below one batch, so for them this still runs as a single query exactly
// as before -- pagination only kicks in for the otherwise-unbounded
// full-corpus/delta fetches it exists to protect.
const ROW_FETCH_BATCH_SIZE = 10_000;

const DELTA_CHURN_FALLBACK_RATIO = 0.3;
// SQLite's bound-parameter cap (SQLITE_MAX_VARIABLE_NUMBER, commonly 999 or
// higher depending on build) is comfortably above this; 500 keeps each `IN
// (...)` statement well clear of it while still batching effectively, matching
// the batch size other large-IN-list code in this repo targets.
const DELTA_ID_CHUNK_SIZE = 200;
/** Bounds concurrent CAS reads in `semantic_vectors` (Frente S-C, 2026-09-07) -- same magnitude as `source-indexer.ts`'s `DEFAULT_READ_CONCURRENCY`/`directory-provider.ts`'s `DEFAULT_WALK_CONCURRENCY`. */
const SEMANTIC_SHARD_READ_CONCURRENCY = 16;
// A selector can legally contain a large registered kind/category set.  Keep
// every generated statement below SQLite's smallest supported variable limit,
// including the five visibility parameters added by queryRecordRows().
const SELECTOR_VALUE_CHUNK_SIZE = 200;
// Safety cap for the `core:find_records` pushdown path (see `tryPushdown`):
// `records_by_selector` is asked for one more than this many rows. Getting
// back the full LIMIT+1 means there may be further matches beyond the
// cutoff that a `LIMIT`-bounded scan cannot see -- at that point pushdown
// can no longer prove its result is complete, so `tryPushdown` returns
// `undefined` and `execute` falls back to the full in-memory path (correct,
// just not cold-fast) rather than ever silently truncating a response. Below
// the cap, pushdown is both complete and byte-identical to the in-memory
// path's filter. Chosen well above realistic `response_budget.max_items`
// values (tens to low hundreds) so ordinary point-ish selectors resolve
// entirely from the pushdown path, while still bounding worst-case pushdown
// query/decode cost far under a full corpus load.
const FIND_RECORDS_PUSHDOWN_LIMIT = 5000;
// Defensive caps for `core:search_text`'s lexical pushdown (see
// `trySearchTextPushdown`), applied to `search_literal`'s result BEFORE
// paying for `records_by_artifact_versions`: at most this many distinct
// artifacts, and at most this many total offsets summed across them. A
// search producing more than either is already an unusably large result for
// a caller to consume; these bound worst-case pushdown cost rather than
// trying to stay exhaustive up to some higher limit.
const SEARCH_TEXT_PUSHDOWN_ARTIFACT_CAP = 200;
const SEARCH_TEXT_PUSHDOWN_OFFSET_CAP = 2000;
// Exact-scan cap for `trySemanticSearch`'s semantic AND lexical lanes alike
// (see the pinned spec's "v1 grain" decision: exact scan, no ANN). Structural
// filters (`paths`/`subject_types`) are applied BEFORE this cap, same
// discipline as `SEARCH_TEXT_PUSHDOWN_ARTIFACT_CAP` above, so a filtered
// query is exact even though an unfiltered one is bounded.
const SEMANTIC_CANDIDATE_CAP = 100;
// Decision 17: the entity lane's OWN exact-scan cap, kept at the same value
// as the artifact lane's -- the pinned spec leaves this "same value... unless
// something argues otherwise", and nothing in the entity-grain measurement
// gate (docs/decisions/17-entity-grain-semantic-documents.md) suggests a
// different one; entity vectors never share the artifact cap's candidate
// pool since the two lanes run separate `exactVectorScan` calls (see
// `trySemanticSearch`).
const SEMANTIC_ENTITY_CANDIDATE_CAP = SEMANTIC_CANDIDATE_CAP;
/** Plan 2026-09-06 (Frente S-A, §4.2): the coverage view's embedded first affected page size -- `min(response_budget.max_items, 20)`; see `trySemanticSearch`'s own call site for why the plain `20` is used here (`response_budget` does not reach this layer). */
const SEMANTIC_AFFECTED_FIRST_PAGE_LIMIT = 20;
/** `core:semantic_affected_page`'s own default/maximum `limit` -- default mirrors the coverage view's embedded first page, maximum bounds a single continuation call's cost the same way `MAX_MCP_PAGE_ITEMS` bounds `response_budget.max_items` one layer up. */
const SEMANTIC_AFFECTED_PAGE_MAX_LIMIT = 200;
// Must track the reconciler's own `max_document_bytes` default
// (`semantic-reconciler.ts`'s `ReconcileSemanticProjectionInput.max_document_bytes`,
// default 2_000_000) for `semantic_scope_counts`'s `oversized_count` to mean
// the same thing here as it does during maintenance. The query port has no
// channel back to the reconciler's actual configured value (a future
// refinement could persist it alongside `semantic_index_state`); until then,
// this constant is a duplicated-but-documented assumption, not a derived one.
const SEMANTIC_MAX_DOCUMENT_BYTES = 2_000_000;

function chunk<T>(values: readonly T[], size: number): readonly T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += size) chunks.push(values.slice(start, start + size));
  return chunks;
}

// A NUL byte can never appear in a real `record_id` (SQLite TEXT columns
// storing UTF-8-derived content-hash-based ids), so this can never collide
// with a genuine `record_id` key in the same `RecordBodyInterner` instance --
// see `decodeRow`'s own doc comment for why `facets` shares the body
// interner under this derived key instead of its own separate cache.
function facetsInternerKey(recordId: string): string {
  return `${recordId}\0facets`;
}

// D1/D7: NFKC + toLocaleLowerCase("en-US") normalization, duplicated here
// (rather than imported) because `normalizedTerm`
// (`packages/storage/src/projections.ts`) are storage-internal, not exported
// from `@urdira/storage`'s package index -- the query port's pushdown SQL is
// intentionally its own implementation, consistent with how `records_by_*`
// above already duplicate the record-row query shape rather than delegating
// to storage. FTS5 performs candidate generation; exact CAS verification below
// preserves the public case and offset semantics.
function normalizedTerm(value: string): string { return value.normalize("NFKC").toLocaleLowerCase("en-US"); }

/**
 * Sorted merge of a base array (already sorted by `record_id`, per SQLite
 * binary text ordering) with a set of replacement/addition records; `base`
 * is never mutated. `base` is corpus-scale (it's `cached.records`, a whole
 * prior generation's worth of records), so the merge loop below yields to
 * the event loop every `RECORDS_YIELD_BATCH_SIZE` pushes, same rationale and
 * constant as `decodeRows`'s own yield.
 */
async function mergeSortedByRecordId(base: readonly CanonicalQueryRecord[], additions: readonly CanonicalQueryRecord[]): Promise<readonly CanonicalQueryRecord[]> {
  if (additions.length === 0) return base;
  const sortedAdditions = [...additions].sort((left, right) => (left.record_id < right.record_id ? -1 : left.record_id > right.record_id ? 1 : 0));
  const merged: CanonicalQueryRecord[] = [];
  let baseIndex = 0; let additionIndex = 0;
  while (baseIndex < base.length && additionIndex < sortedAdditions.length) {
    merged.push(base[baseIndex]!.record_id < sortedAdditions[additionIndex]!.record_id ? base[baseIndex++]! : sortedAdditions[additionIndex++]!);
    if (merged.length % RECORDS_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();
  }
  while (baseIndex < base.length) { merged.push(base[baseIndex++]!); if (merged.length % RECORDS_YIELD_BATCH_SIZE === 0) await yieldToEventLoop(); }
  while (additionIndex < sortedAdditions.length) { merged.push(sortedAdditions[additionIndex++]!); if (merged.length % RECORDS_YIELD_BATCH_SIZE === 0) await yieldToEventLoop(); }
  return merged;
}

/** Durable immutable-snapshot reader used by daemon query composition. */
export class SqliteCanonicalQuerySnapshotPort implements CanonicalQuerySnapshotPort {
  // `bytes` is `approxCorpusBytes`'s reading at load/delta time -- the total
  // relational body byte length visible at `generation` -- feeding
  // `approxWarmBytes()` below (see that method's own doc comment for why
  // this is a fresh cheap aggregate per generation rather than bookkeeping
  // accumulated incrementally across loads/deltas).
  private readonly recordsCache = new Map<string, { readonly generation: number; readonly records: readonly CanonicalQueryRecord[]; readonly bytes: number }>();
  // Single-flight: while a records() load/delta for a workspace is in
  // flight, every concurrent caller awaits this same promise instead of
  // starting duplicate SQLite work (each of which would otherwise pay the
  // full 8-11s reload independently). Cleared once the load settles, on
  // both success and rejection, so a failed load does not wedge the
  // workspace into perpetually returning a stale rejected promise.
  //
  // `evictWarmRecords()` below deliberately never touches this map: clearing
  // `recordsCache`/`capabilityCache`/`textCache` concurrently with an
  // in-flight load is safe (a `Map.clear()` never invalidates an object
  // reference a caller already captured from it -- e.g. `deltaRecords`'s own
  // `cached` parameter, read once at the top of `resolveRecords` before any
  // `await`), and the in-flight load still resolves normally and simply
  // repopulates the cache when it settles.
  private readonly recordsLoading = new Map<string, Promise<readonly CanonicalQueryRecord[]>>();
  private readonly capabilityCache = new Map<string, { readonly generation: number; readonly states: readonly SnapshotCapabilityStateEntry[] }>();
  private readonly textCache = new Map<string, string>();
  private readonly graphAvailabilityCache = new Map<string, boolean>();

  /**
   * `interner` (optional -- omitted, this port behaves exactly as before
   * cross-workspace body sharing existed) is shared by the daemon across
   * every `SqliteCanonicalQuerySnapshotPort` it constructs (one per
   * workspace, `packages/daemon/src/runtime.ts`'s `acquireWorkspaceQueryEngine`)
   * so content-identical records decoded by DIFFERENT workspaces' ports
   * share one `body` object -- see `RecordBodyInterner`'s own doc comment.
   */
  constructor(private readonly database: SqliteDatabase, private readonly content?: ContentReader, private readonly interner?: RecordBodyInterner) {}

  /**
   * Resolves `scope`'s workspace to its current generation, and -- the fix
   * for the `scope.snapshot_id` pin silently being ignored -- honors an
   * explicit pin by rejecting a read rather than ever silently substituting
   * the current generation for it. Serving an arbitrary *historical*
   * `snapshot_id` was investigated and rejected as "not cheap": every
   * `records_by_*`/`search_literal`/`capability_states`/`artifact_text`
   * method below (and the generation-keyed `recordsCache`) is built around
   * "visible at the CURRENT generation", and older generations' underlying
   * rows are not guaranteed to still be intact (see `retention_leases`,
   * `snapshot_expiration_markers`, `garbage_collection_epochs` in
   * `packages/storage/src/schema.ts`) -- correctly threading a historical
   * generation through all of that is a much larger change than this fix.
   * Failing loudly is strictly safer than quietly answering from the wrong
   * generation. The one extra `snapshots` lookup only runs on the rare
   * mismatch path, so the common (unpinned, or pin matches current) case
   * pays no extra query beyond the `current_snapshot_id` column this SELECT
   * already had to widen to include.
   */
  private async currentGeneration(scope: QueryScope): Promise<number | undefined> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    const workspaceId = scope.workspace_id;
    // Query API v3 source bindings intentionally use a synthetic immutable
    // identifier. Source catalog generations are already interval-versioned
    // in artifact_versions, so they can be read without requiring a plugin
    // snapshot or a structural publication.
    if (scope.snapshot_id?.startsWith("source-snapshot:")) {
      const generation = Number(scope.snapshot_id.slice("source-snapshot:".length));
      if (!Number.isSafeInteger(generation) || generation < 1) throw new QueryPlanError("core:snapshot_not_found", `Source snapshot "${scope.snapshot_id}" is invalid.`);
      const source = await this.database.get<{ current_generation: number }>("SELECT current_generation FROM source_index_state WHERE workspace_id = ?", [workspaceId]);
      if (source === undefined || generation > source.current_generation) throw new QueryPlanError("core:snapshot_not_found", `Source snapshot "${scope.snapshot_id}" is not available for workspace "${workspaceId}".`);
      return generation;
    }
    const current = await this.database.get<{ current_generation: number; current_snapshot_id: string }>("SELECT current_generation, current_snapshot_id FROM workspace_current_state WHERE workspace_id = ?", [workspaceId]);
    if (current === undefined) return undefined;
    if (scope.snapshot_id !== undefined && scope.snapshot_id !== current.current_snapshot_id) await this.rejectSnapshotPin(workspaceId, scope.snapshot_id, current.current_snapshot_id);
    return current.current_generation;
  }

  /**
   * Distinguishes, honestly, why a pinned `scope.snapshot_id` cannot be
   * served: `core:snapshot_expired` when it names a real prior snapshot of
   * this workspace (recorded permanently in `snapshots`, one row per
   * generation) that simply is not the current one -- pinned historical
   * reads are not supported -- versus `core:snapshot_not_found` when it
   * names no snapshot of this workspace at all (typo, or a snapshot id from
   * a different workspace). Both are registered `core:` operation error
   * codes (`packages/contracts/src/registries.ts`); neither was wired to
   * any caller before this fix, so the pin was silently ignored instead.
   */
  private async rejectSnapshotPin(workspaceId: string, requestedSnapshotId: string, currentSnapshotId: string): Promise<never> {
    const historical = await this.database.get<{ generation: number }>("SELECT generation FROM snapshots WHERE workspace_id = ? AND snapshot_id = ?", [workspaceId, requestedSnapshotId]);
    if (historical !== undefined) {
      throw new QueryPlanError("core:snapshot_expired", `scope.snapshot_id "${requestedSnapshotId}" (generation ${historical.generation}) is no longer the current snapshot of workspace "${workspaceId}" (current snapshot: "${currentSnapshotId}"). Pinned historical-snapshot queries are not supported; re-query without a snapshot_id to read the current generation.`);
    }
    throw new QueryPlanError("core:snapshot_not_found", `scope.snapshot_id "${requestedSnapshotId}" is not a known snapshot of workspace "${workspaceId}" (current snapshot: "${currentSnapshotId}").`);
  }

  /**
   * `record_id` is content-derived (decision 11), so an `interner` hit for
   * `row.record_id` proves the relational body is IDENTICAL to whatever a
   * prior hydration of that same id already produced. Both `body` and
   * `facets` (also content-derived from the same payload bytes, under a
   * second, derived interner key -- see `RecordBodyInterner`'s own doc
   * comment) must hit for this shortcut; a miss on either falls back to a
   * full decode, exactly as if no interner were configured, and registers
   * both for future hits.
   */
  /** Thin forward to the shared `decodeRow` (`query-record-decode.ts`,
   * extracted verbatim in P2-5 so `NativeCanonicalQuerySnapshotPort` can
   * reuse it byte-for-byte) -- kept as a method so every `this.decodeRow(...)`
   * call site below is unaffected by the extraction. */
  private decodeRow(row: RecordRow): CanonicalQueryRecord {
    return decodeRow(row, this.interner);
  }

  private async attachRelationalValues(rows: readonly RecordRow[]): Promise<readonly RecordRow[]> {
    if (rows.length === 0) return rows;
    const byRecord = new Map<string, RelationalValueRow[]>();
    const relationalRecordIds = rows.filter((row) => row.body_payload == null).map((row) => row.record_id);
    for (const ids of chunk(relationalRecordIds, DELTA_ID_CHUNK_SIZE)) {
      const values = await this.database.all<Record<string, unknown> & RelationalValueRow>(
        `SELECT workspace_id, record_id, valid_from_generation, value_path, parent_path, sequence_ordinal, map_key, value_kind, text_value, integer_value, real_value, bool_value, bytes_value
           FROM record_value_nodes WHERE workspace_id = ? AND record_id IN (${ids.map(() => "?").join(", ")}) ORDER BY record_id, value_path`,
        [rows[0]!.workspace_id, ...ids],
      );
      for (const value of values) {
        const bucket = byRecord.get(value.record_id) ?? [];
        bucket.push(value);
        byRecord.set(value.record_id, bucket);
      }
    }
    const facetsByRecord = new Map<string, string[]>();
    // Keep the facet hydration bound by the conservative SQLite variable
    // budget as well.  Search pushdown can return tens of thousands of rows;
    // the old single IN-list then failed with "too many SQL variables" even
    // though the record-value query above was already chunked.
    for (const ids of chunk(rows.map((row) => row.record_id), DELTA_ID_CHUNK_SIZE)) {
      const facets = await this.database.all<{ record_id: string; facet: string }>(
        `SELECT record_id, facet FROM record_facets WHERE workspace_id = ? AND record_id IN (${ids.map(() => "?").join(", ")}) ORDER BY record_id, facet_ordinal`,
        [rows[0]!.workspace_id, ...ids],
      );
      for (const facet of facets) {
        const values = facetsByRecord.get(facet.record_id) ?? [];
        values.push(facet.facet);
        facetsByRecord.set(facet.record_id, values);
      }
    }
    return rows.map((row) => ({ ...row, value_rows: byRecord.get(row.record_id) ?? [], facet_rows: facetsByRecord.get(row.record_id) ?? [] }));
  }

  /**
   * Runs the shared records+identity join, visible at `generation`, with one
   * extra caller-supplied SQL condition ANDed in, and an optional `LIMIT`.
   * When `limit` is given, runs as a single query exactly as before (see
   * `ROW_FETCH_BATCH_SIZE`'s own doc comment for why the bounded-`limit`
   * callers don't need pagination). When `limit` is omitted, keyset-paginates
   * on `records.record_id` instead of running one unbounded query.
   */
  private async queryRecordRows(workspaceId: string, generation: number, extraCondition: string, extraParams: ReadonlyArray<string | number>, limit?: number, afterRecordId?: string): Promise<readonly RecordRow[]> {
    const baseSql =
      `SELECT records.record_id, records.workspace_id, records.category, records.kind, records.universal_kind, records.body_payload,
              records.owner_artifact_id, records.owner_artifact_version_id,
              records.primary_source_span_artifact_version_id, records.primary_source_span_start_byte,
              records.primary_source_span_end_byte, records.primary_source_span_start_line,
              records.primary_source_span_end_line,
              identities.identity_id, identities.identity_key
         FROM record_occurrences AS records
         LEFT JOIN identity_assignments AS identities
           ON identities.workspace_id = records.workspace_id AND identities.record_id = records.record_id
          AND identities.valid_from_generation <= ? AND (identities.valid_to_generation IS NULL OR identities.valid_to_generation > ?)
        WHERE records.workspace_id = ? AND records.valid_from_generation <= ?
          AND (records.valid_to_generation IS NULL OR records.valid_to_generation > ?)
          AND ${extraCondition}`;
    const baseParams = [generation, generation, workspaceId, generation, generation, ...extraParams];
    if (limit !== undefined) {
      const cursorCondition = afterRecordId === undefined ? "" : " AND records.record_id > ?";
      return this.attachRelationalValues(await this.database.all<RecordRow>(`${baseSql}${cursorCondition} ORDER BY records.record_id LIMIT ?`, [...baseParams, ...(afterRecordId === undefined ? [] : [afterRecordId]), limit]));
    }
    const rows: RecordRow[] = [];
    let cursor: string | undefined;
    while (true) {
      const cursorCondition = cursor === undefined ? "" : " AND records.record_id > ?";
      const cursorParams = cursor === undefined ? [] : [cursor];
      const batch = await this.database.all<RecordRow>(
        `${baseSql}${cursorCondition} ORDER BY records.record_id LIMIT ?`,
        [...baseParams, ...cursorParams, ROW_FETCH_BATCH_SIZE],
      );
      rows.push(...batch);
      if (batch.length < ROW_FETCH_BATCH_SIZE) break;
      cursor = batch[batch.length - 1]!.record_id;
      await yieldToEventLoop();
    }
    return this.attachRelationalValues(rows);
  }

  /** Decodes every row in `rows`, yielding to the event loop every `RECORDS_YIELD_BATCH_SIZE` records -- see that constant's own doc comment. Shared by every decode loop in this class that can run over corpus-scale row counts (a full load, or a large delta). */
  private async decodeRows(rows: readonly RecordRow[]): Promise<readonly CanonicalQueryRecord[]> {
    const records: CanonicalQueryRecord[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      records.push(this.decodeRow(rows[index]!));
      if ((index + 1) % RECORDS_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();
    }
    return records;
  }

  private async loadAllRecords(workspaceId: string, generation: number): Promise<readonly CanonicalQueryRecord[]> {
    const rows = await this.queryRecordRows(workspaceId, generation, "1 = 1", []);
    return this.decodeRows(rows);
  }

  /**
   * Windowed delta from `cached` (last loaded at generation `gOld`) up to
   * `generation` (`gNew` > `gOld`): counts churn cheaply first, and returns
   * `undefined` (meaning "fall back to a full reload") when that churn
   * exceeds `DELTA_CHURN_FALLBACK_RATIO` of the cached array's size --
   * otherwise fetches only the removed/added/identity-reassigned rows and
   * splices them into a fresh copy of `cached.records` (never mutating it,
   * since other in-flight query executions may still hold a reference to it).
   */
  private async deltaRecords(workspaceId: string, cached: { readonly generation: number; readonly records: readonly CanonicalQueryRecord[] }, generation: number): Promise<readonly CanonicalQueryRecord[] | undefined> {
    const gOld = cached.generation;
    const gNew = generation;
    const [removalsCount, additionsCount, identityChurnCount] = await Promise.all([
      this.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM record_occurrences WHERE workspace_id = ? AND valid_to_generation > ? AND valid_to_generation <= ?", [workspaceId, gOld, gNew]),
      this.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM record_occurrences WHERE workspace_id = ? AND valid_from_generation > ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)", [workspaceId, gOld, gNew, gNew]),
      this.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM identity_assignments WHERE workspace_id = ? AND ((valid_from_generation > ? AND valid_from_generation <= ?) OR (valid_to_generation > ? AND valid_to_generation <= ?))", [workspaceId, gOld, gNew, gOld, gNew]),
    ]);
    const churn = (removalsCount?.count ?? 0) + (additionsCount?.count ?? 0) + (identityChurnCount?.count ?? 0);
    if (churn > cached.records.length * DELTA_CHURN_FALLBACK_RATIO) return undefined;

    const [removedRows, identityChangedRows] = await Promise.all([
      this.database.all<{ record_id: string }>("SELECT record_id FROM record_occurrences WHERE workspace_id = ? AND valid_to_generation > ? AND valid_to_generation <= ?", [workspaceId, gOld, gNew]),
      this.database.all<{ record_id: string }>("SELECT DISTINCT record_id FROM identity_assignments WHERE workspace_id = ? AND ((valid_from_generation > ? AND valid_from_generation <= ?) OR (valid_to_generation > ? AND valid_to_generation <= ?))", [workspaceId, gOld, gNew, gOld, gNew]),
    ]);
    const removedIds = new Set(removedRows.map((row) => row.record_id));
    const identityChangedIds = identityChangedRows.map((row) => row.record_id);
    const identityChangedIdSet = new Set(identityChangedIds);

    const refreshed = new Map<string, CanonicalQueryRecord>();
    for (const record of await this.decodeRows(await this.queryRecordRows(workspaceId, gNew, "records.valid_from_generation > ? AND records.valid_from_generation <= ?", [gOld, gNew]))) refreshed.set(record.record_id, record);
    for (const idsChunk of chunk(identityChangedIds, DELTA_ID_CHUNK_SIZE)) {
      if (idsChunk.length === 0) continue;
      for (const record of await this.decodeRows(await this.queryRecordRows(workspaceId, gNew, `records.record_id IN (${idsChunk.map(() => "?").join(", ")})`, idsChunk))) refreshed.set(record.record_id, record);
    }

    // `cached.records` is corpus-scale, so -- like `decodeRows`/`mergeSortedByRecordId`
    // above -- this filters it in a chunked loop rather than one synchronous
    // `Array.prototype.filter` pass, yielding every `RECORDS_YIELD_BATCH_SIZE` records.
    const survivors: CanonicalQueryRecord[] = [];
    for (let index = 0; index < cached.records.length; index += 1) {
      const record = cached.records[index]!;
      if (!removedIds.has(record.record_id) && !identityChangedIdSet.has(record.record_id)) survivors.push(record);
      if ((index + 1) % RECORDS_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();
    }
    return await mergeSortedByRecordId(survivors, [...refreshed.values()]);
  }

  private async resolveRecords(scope: QueryScope, workspaceId: string): Promise<readonly CanonicalQueryRecord[]> {
    const generation = await this.currentGeneration(scope);
    if (generation === undefined) return [];
    const cached = this.recordsCache.get(workspaceId);
    if (cached !== undefined && cached.generation === generation) return cached.records;
    const delta = cached !== undefined && cached.generation < generation ? await this.deltaRecords(workspaceId, cached, generation) : undefined;
    const records = delta ?? await this.loadAllRecords(workspaceId, generation);
    const bytes = await this.approxCorpusBytes(workspaceId, generation);
    this.recordsCache.set(workspaceId, { generation, records, bytes });
    return records;
  }

  /**
   * `approxWarmBytes()`'s per-workspace input: the total logical body
   * byte length of every row visible at `generation`, read with one cheap
   * SQL aggregate rather than accumulated from whichever rows a load or
   * delta happened to fetch this time. A windowed `deltaRecords` only fetches
   * the CHANGED rows, not the (usually much larger) surviving portion carried
   * over from `cached.records` -- accumulating only what was just fetched
   * would silently undercount the warm cache's true size after every delta,
   * defeating the whole point of a byte BUDGET. `LENGTH()` on a `BLOB`
   * column reads a row's stored length, not its full content, so this is a
   * fast indexed-range scan even over a corpus-scale table, not another full
   * corpus fetch -- negligible next to the load/delta this always runs
   * alongside.
   */
  private async approxCorpusBytes(workspaceId: string, generation: number): Promise<number> {
    const row = await this.database.get<{ bytes: number }>(
            "SELECT COALESCE(SUM(body_byte_length), 0) AS bytes FROM record_occurrences WHERE workspace_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)",
      [workspaceId, generation, generation],
    );
    return row?.bytes ?? 0;
  }

  /**
   * Approximate total warm bytes this port is currently holding onto across
   * every workspace it has a cached `recordsCache` entry for (in production,
   * daemon usage, exactly one -- each `SqliteCanonicalQuerySnapshotPort` is
   * backed by one workspace's own database file, see
   * `packages/daemon/src/runtime.ts`'s `acquireWorkspaceQueryEngine`). Feeds
   * the daemon's `URDIRA_WARM_RECORDS_BUDGET_MB` LRU eviction loop.
   *
   * "Approximate" in two specific, documented ways: (1) it is a sum of
   * logical body byte lengths, not measured decoded-heap RSS --
   * the decoded `CanonicalQueryRecord` tree a payload expands into is
   * typically larger than its encoded bytes, so this under-counts true
   * memory pressure by roughly the same expansion factor for every
   * workspace, which is a consistent (if not exact) basis for LRU ordering
   * between workspaces. (2) When a `RecordBodyInterner` is configured and a
   * decode hits a shared body from ANOTHER workspace, this workspace's own
   * `approxCorpusBytes` still counts that record's full payload length --
   * i.e. two forks of the same donor each report roughly the donor's whole
   * corpus size even though their `body` objects are the SAME heap objects
   * underneath, so the sum across a forked fleet over-counts vs actual
   * shared RSS. Both biases are accepted (per the pinned spec) as the
   * simplest robust approximation: exact shared-RSS accounting would need
   * either per-object size instrumentation or reference counting neither
   * this port nor `RecordBodyInterner` do (and deliberately do not -- see
   * that class's own doc comment on holding no strong references).
   */
  approxWarmBytes(): number {
    let total = 0;
    for (const cached of this.recordsCache.values()) total += cached.bytes;
    return total;
  }

  /**
   * Drops every currently cached decoded corpus (`recordsCache`) plus the
   * capability-state and artifact-text caches this port also holds -- the
   * RAM `approxWarmBytes()` measures. `has_warm_records` is `false` for
   * every workspace immediately after this returns (until a new load
   * repopulates it); the next `records()` call for any workspace reloads
   * normally through the existing full-load/delta path, producing results
   * byte-identical to what a warm cache would have returned.
   *
   * Deliberately does NOT touch `recordsLoading` (the single-flight
   * in-flight-load map): an eviction concurrent with an in-flight
   * `records()` load never corrupts or aborts that load. `Map.clear()`
   * never invalidates an object reference a caller already captured from
   * the map earlier -- `deltaRecords`'s own `cached` parameter, read once at
   * the top of `resolveRecords` before any `await`, keeps pointing at its
   * (now-detached-from-the-map) prior entry regardless of a concurrent
   * `evictWarmRecords()` call, so an in-flight delta still computes and
   * returns its correct result; `resolveRecords`'s trailing
   * `this.recordsCache.set(...)` then simply repopulates the entry once
   * that in-flight load settles (functionally: the eviction was deferred
   * until the in-flight load's own completion, whether it landed before or
   * after this call).
   */
  evictWarmRecords(): void {
    this.recordsCache.clear();
    this.capabilityCache.clear();
    this.textCache.clear();
  }

  async records(scope: QueryScope): Promise<readonly CanonicalQueryRecord[]> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    const workspaceId = scope.workspace_id;
    // `recordsLoading`'s single-flight is keyed by `workspaceId` alone (see
    // its own doc comment), so a pinned request joining an already-in-flight
    // unpinned (or differently-pinned) load would otherwise silently inherit
    // that OTHER request's answer without ever having its own pin checked --
    // exactly the "silently substitute" failure mode this fix exists to
    // rule out. Validating the pin here, before ever consulting
    // `recordsLoading`, closes that gap: a mismatch throws immediately
    // regardless of what else is in flight for this workspace. This costs
    // one extra cheap indexed lookup only on the rare pinned path; the
    // unpinned hot path (`scope.snapshot_id === undefined`) is unchanged.
    if (scope.snapshot_id !== undefined) await this.currentGeneration(scope);
    const inFlight = this.recordsLoading.get(workspaceId);
    if (inFlight !== undefined) return inFlight;
    const promise = this.resolveRecords(scope, workspaceId).finally(() => { this.recordsLoading.delete(workspaceId); });
    this.recordsLoading.set(workspaceId, promise);
    return promise;
  }

  /**
   * Cold query fallback. It deliberately bypasses `recordsCache` and
   * `recordsLoading`: a complex graph operation may need a broad candidate
   * set, but it must not turn that one query into a process-wide warm corpus
   * or make future requests pay for it. The underlying row reader remains
   * keyset-paginated and relational values are hydrated only for this query.
   */
  async records_for_query(scope: QueryScope): Promise<readonly CanonicalQueryRecord[]> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    const generation = await this.currentGeneration(scope);
    if (generation === undefined) return [];
    return this.decodeRows(await this.queryRecordRows(scope.workspace_id, generation, "1 = 1", []));
  }

  async *records_for_query_batches(scope: QueryScope, batchSize = ROW_FETCH_BATCH_SIZE): AsyncIterable<readonly CanonicalQueryRecord[]> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > ROW_FETCH_BATCH_SIZE) throw new RangeError("Query record batch size is outside the bounded range.");
    const generation = await this.currentGeneration(scope);
    if (generation === undefined) return;
    let cursor: string | undefined;
    while (true) {
      const rows = await this.queryRecordRows(scope.workspace_id, generation, "1 = 1", [], batchSize, cursor);
      if (rows.length === 0) return;
      yield await this.decodeRows(rows);
      if (rows.length < batchSize) return;
      cursor = rows[rows.length - 1]!.record_id;
      await yieldToEventLoop();
    }
  }

  /** See `CanonicalQuerySnapshotPort.has_warm_records` -- deliberately never calls `resolveRecords`/`records()`, only the cheap generation lookup, so it can never trigger a load. */
  async has_warm_records(scope: QueryScope): Promise<boolean> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    const workspaceId = scope.workspace_id;
    const generation = await this.currentGeneration(scope);
    if (generation === undefined) return false;
    const cached = this.recordsCache.get(workspaceId);
    return cached !== undefined && cached.generation === generation;
  }

  async records_by_ids(scope: QueryScope, ids: readonly string[]): Promise<readonly CanonicalQueryRecord[]> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    const workspaceId = scope.workspace_id;
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];
    const generation = await this.currentGeneration(scope);
    if (generation === undefined) return [];
    const found = new Map<string, CanonicalQueryRecord>();
    if (scope.snapshot_id?.startsWith("source-snapshot:")) {
      for (const idsChunk of chunk(uniqueIds, DELTA_ID_CHUNK_SIZE)) {
        const placeholders = idsChunk.map(() => "?").join(", ");
        const rows = await this.database.all<{ artifact_id: string; artifact_version_id: string; normalized_uri: string; normalized_path: string | null }>(
          `SELECT version.artifact_id AS artifact_id, version.artifact_version_id AS artifact_version_id,
                  artifact.normalized_uri AS normalized_uri, artifact.normalized_path AS normalized_path
             FROM artifact_versions AS version
             JOIN source_artifacts AS artifact ON artifact.workspace_id = version.workspace_id AND artifact.artifact_id = version.artifact_id
            WHERE version.workspace_id = ? AND (version.artifact_id IN (${placeholders}) OR version.artifact_version_id IN (${placeholders}))
              AND version.valid_from_generation <= ? AND (version.valid_to_generation IS NULL OR version.valid_to_generation > ?)
            ORDER BY artifact.normalized_uri, version.artifact_version_id`,
          [workspaceId, ...idsChunk, ...idsChunk, generation, generation],
        );
        for (const row of rows) found.set(row.artifact_version_id, sourceArtifactRecord(workspaceId, row));
      }
      return [...found.values()];
    }
    for (const idsChunk of chunk(uniqueIds, DELTA_ID_CHUNK_SIZE)) {
      const placeholders = idsChunk.map(() => "?").join(", ");
      // A subject's id can be a record_id, an identity_id, or an identity_key
      // (see `subjectIdentity` in this module) -- the caller does not say
      // which, so match the same id list against all three columns.
      const condition = `(records.record_id IN (${placeholders}) OR identities.identity_id IN (${placeholders}) OR identities.identity_key IN (${placeholders}))`;
      const rows = await this.queryRecordRows(workspaceId, generation, condition, [...idsChunk, ...idsChunk, ...idsChunk]);
      for (const row of rows) found.set(row.record_id, this.decodeRow(row));
    }
    return [...found.values()];
  }

  async records_by_name(scope: QueryScope, name: string): Promise<readonly CanonicalQueryRecord[]> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    const workspaceId = scope.workspace_id;
    const generation = await this.currentGeneration(scope);
    if (generation === undefined) return [];
    // `identity_key` has no dedicated "name" column -- it is a colon-joined
    // path ending in the entity's name (e.g.
    // `jsts:parameter:packages/excalidraw/scene/export.ts:5578:createCanvas`).
    // The LIKE scan is a cheap superset (SQLite has no bind-parameter
    // escaping concern here since `%`/`_` inside `name` only ever widen the
    // match, never narrow it); `identityKeyTail` below re-checks the exact
    // final segment in JS so a `name` that happens to contain `%`/`_` can
    // never produce a false positive.
    const rows = await this.database.all<RecordRow>(
      `SELECT records.record_id, records.workspace_id, records.category, records.kind, records.universal_kind, records.body_payload,
              records.owner_artifact_id, records.owner_artifact_version_id,
              identities.identity_id, identities.identity_key
         FROM identity_assignments AS identities
         JOIN record_occurrences AS records
           ON records.workspace_id = identities.workspace_id AND records.record_id = identities.record_id
          AND records.valid_from_generation <= ? AND (records.valid_to_generation IS NULL OR records.valid_to_generation > ?)
        WHERE identities.workspace_id = ? AND identities.valid_from_generation <= ?
          AND (identities.valid_to_generation IS NULL OR identities.valid_to_generation > ?)
          AND identities.identity_key LIKE '%:' || ?
        ORDER BY records.record_id`,
      [generation, generation, workspaceId, generation, generation, name]);
    const hydrated = await this.attachRelationalValues(rows);
    return hydrated.map((row) => this.decodeRow(row)).filter((record) => identityKeyTail(record.identity_key) === name);
  }

  async records_by_selector(scope: QueryScope, selector: RecordColumnSelector, limit: number): Promise<readonly CanonicalQueryRecord[]> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    const workspaceId = scope.workspace_id;
    const generation = await this.currentGeneration(scope);
    if (generation === undefined) return [];
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    for (const [column, values] of [["records.category", selector.categories], ["records.universal_kind", selector.universal_kinds], ["records.kind", selector.kinds]] as const) {
      if (values !== undefined && values.length > 0) {
        const clauses: string[] = [];
        for (let start = 0; start < values.length; start += SELECTOR_VALUE_CHUNK_SIZE) {
          const part = values.slice(start, start + SELECTOR_VALUE_CHUNK_SIZE);
          clauses.push(`${column} IN (${part.map(() => "?").join(", ")})`);
          params.push(...part);
        }
        conditions.push(clauses.length === 1 ? clauses[0]! : `(${clauses.join(" OR ")})`);
      }
    }
    const extraCondition = conditions.length > 0 ? conditions.join(" AND ") : "1 = 1";
    const rows = await this.queryRecordRows(workspaceId, generation, extraCondition, params, limit);
    return rows.map((row) => this.decodeRow(row));
  }

  async container_records_by_artifact_references(scope: QueryScope, references: readonly string[]): Promise<readonly CanonicalQueryRecord[]> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    const unique = [...new Set(references)];
    if (unique.length === 0) return [];
    const generation = await this.currentGeneration(scope);
    if (generation === undefined) return [];
    const found = new Map<string, CanonicalQueryRecord>();
    for (const part of chunk(unique, DELTA_ID_CHUNK_SIZE)) {
      const placeholders = part.map(() => "?").join(", ");
      const condition = `records.universal_kind = 'core:container' AND (records.owner_artifact_version_id IN (${placeholders}) OR EXISTS (
        SELECT 1 FROM source_artifacts AS artifacts
         WHERE artifacts.workspace_id = records.workspace_id AND artifacts.artifact_id = records.owner_artifact_id
           AND (artifacts.artifact_id IN (${placeholders}) OR artifacts.normalized_path IN (${placeholders}) OR artifacts.normalized_uri IN (${placeholders}))
      ))`;
      const rows = await this.queryRecordRows(scope.workspace_id, generation, condition, [...part, ...part, ...part, ...part]);
      for (const row of rows) found.set(row.record_id, this.decodeRow(row));
    }
    return [...found.values()].sort((left, right) => left.record_id.localeCompare(right.record_id));
  }

  private async graphProjectionAvailable(workspaceId: string, generation: number): Promise<boolean> {
    const key = `${workspaceId}\u0000${generation}`;
    const cached = this.graphAvailabilityCache.get(key);
    if (cached !== undefined) return cached;
    const row = await this.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM graph_edges WHERE workspace_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)", [workspaceId, generation, generation]);
    const available = (row?.count ?? 0) > 0;
    this.graphAvailabilityCache.set(key, available);
    while (this.graphAvailabilityCache.size > 8) this.graphAvailabilityCache.delete(this.graphAvailabilityCache.keys().next().value as string);
    return available;
  }

  async graph_edges_by_subject_ids(scope: QueryScope, subjectIds: readonly string[], direction: "inbound" | "outbound" | "both"): Promise<readonly IndexedGraphEdge[] | undefined> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    const generation = await this.currentGeneration(scope);
    if (generation === undefined) return [];
    if (!await this.graphProjectionAvailable(scope.workspace_id, generation)) return undefined;
    const unique = [...new Set(subjectIds)];
    if (unique.length === 0) return [];
    const found = new Map<string, IndexedGraphEdge>();
    const read = async (column: "source_subject_id" | "target_subject_id", ids: readonly string[]): Promise<void> => {
      const placeholders = ids.map(() => "?").join(", ");
      const rows = await this.database.all<IndexedGraphEdge & Record<string, unknown>>(
        `SELECT edge_id, source_subject_id, target_subject_id, relation_record_id, relation_kind, role, evidence_class
           FROM graph_edges
          WHERE workspace_id = ? AND valid_from_generation <= ?
            AND (valid_to_generation IS NULL OR valid_to_generation > ?)
            AND ${column} IN (${placeholders})
          ORDER BY relation_record_id, edge_id`,
        [scope.workspace_id, generation, generation, ...ids],
      );
      for (const row of rows) found.set(row.edge_id, row);
    };
    for (const ids of chunk(unique, DELTA_ID_CHUNK_SIZE)) {
      if (direction === "outbound" || direction === "both") await read("source_subject_id", ids);
      if (direction === "inbound" || direction === "both") await read("target_subject_id", ids);
    }
    return [...found.values()].sort((left, right) => left.relation_record_id.localeCompare(right.relation_record_id) || left.edge_id.localeCompare(right.edge_id));
  }

  async relation_pairs_by_subject_ids(scope: QueryScope, leftIds: readonly string[], rightIds: readonly string[], relationSelector: unknown, direction: "inbound" | "outbound" | "both"): Promise<ReadonlySet<string> | undefined> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    if (leftIds.length === 0 || rightIds.length === 0) return new Set();
    const generation = await this.currentGeneration(scope);
    if (generation === undefined) return new Set();
    // Some providers publish canonical relation records without the optional
    // graph projection. Returning undefined keeps the complete record-based
    // fallback authoritative instead of treating an absent projection as an
    // empty relation set.
    if (!await this.graphProjectionAvailable(scope.workspace_id, generation)) return undefined;
    const right = new Set(rightIds);
    const selector = object(relationSelector);
    const kinds = new Set(strings(selector["universal_kinds"]));
    const output = new Set<string>();
    for (let offset = 0; offset < leftIds.length; offset += DELTA_ID_CHUNK_SIZE) {
      const chunk = leftIds.slice(offset, offset + DELTA_ID_CHUNK_SIZE);
      const left = new Set(chunk);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = await this.database.all<{ source_subject_id: string; target_subject_id: string; relation_kind: string }>(
        `SELECT source_subject_id, target_subject_id, relation_kind
           FROM graph_edges
          WHERE workspace_id = ? AND valid_from_generation <= ?
            AND (valid_to_generation IS NULL OR valid_to_generation > ?)
            AND (source_subject_id IN (${placeholders}) OR target_subject_id IN (${placeholders}))`,
        [scope.workspace_id, generation, generation, ...chunk, ...chunk],
      );
      for (const row of rows) {
        if (kinds.size > 0 && !kinds.has(row.relation_kind)) continue;
        if ((direction === "outbound" || direction === "both") && left.has(row.source_subject_id) && right.has(row.target_subject_id)) output.add(`${row.source_subject_id}\u0000${row.target_subject_id}`);
        if ((direction === "inbound" || direction === "both") && left.has(row.target_subject_id) && right.has(row.source_subject_id)) output.add(`${row.target_subject_id}\u0000${row.source_subject_id}`);
      }
    }
    return output;
  }

  /**
   * Synthesizes one `category: "artifact_subject"` `CanonicalQueryRecord` per
   * requested `artifact_version_id` directly from `artifact_versions` joined
   * with `source_artifacts` -- NOT from `record_occurrences` (see the
   * interface doc comment on `CanonicalQuerySnapshotPort.records_by_artifact_versions`
   * for why: `record_occurrences.category`'s `CHECK` constraint makes
   * `'artifact'` an impossible persisted category, so there is no
   * `record_occurrences` row to query in the first place). These records
   * exist only in memory, for exactly as long as one `core:search_text`
   * pushdown evaluation needs them to build `matches`/`subjects` stream
   * items; nothing else reads or persists them.
   */
  async records_by_artifact_versions(scope: QueryScope, versionIds: readonly string[]): Promise<readonly CanonicalQueryRecord[]> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    const workspaceId = scope.workspace_id;
    const uniqueIds = [...new Set(versionIds)];
    if (uniqueIds.length === 0) return [];
    const generation = await this.currentGeneration(scope);
    if (generation === undefined) return [];
    const found = new Map<string, CanonicalQueryRecord>();
    for (const idsChunk of chunk(uniqueIds, DELTA_ID_CHUNK_SIZE)) {
      const placeholders = idsChunk.map(() => "?").join(", ");
      const rows = await this.database.all<{ artifact_id: string; artifact_version_id: string; normalized_uri: string; normalized_path: string | null }>(
        `SELECT version.artifact_id AS artifact_id, version.artifact_version_id AS artifact_version_id,
                artifact.normalized_uri AS normalized_uri, artifact.normalized_path AS normalized_path
           FROM artifact_versions AS version
           JOIN source_artifacts AS artifact ON artifact.workspace_id = version.workspace_id AND artifact.artifact_id = version.artifact_id
          WHERE version.workspace_id = ? AND version.artifact_version_id IN (${placeholders})
            AND version.valid_from_generation <= ? AND (version.valid_to_generation IS NULL OR version.valid_to_generation > ?)`,
        [workspaceId, ...idsChunk, generation, generation],
      );
      for (const row of rows) {
        found.set(row.artifact_version_id, {
          record_id: `artifact-record:${row.artifact_version_id}`,
          workspace_id: workspaceId,
          category: "artifact_subject",
          kind: "core:source_file",
          universal_kind: "core:artifact",
          owner_artifact_id: row.artifact_id,
          owner_artifact_version_id: row.artifact_version_id,
          facets: [],
          body: { path: row.normalized_path ?? row.normalized_uri, artifact_id: row.artifact_id, artifact_version_id: row.artifact_version_id },
        });
      }
    }
    return [...found.values()];
  }

  /**
   * Returns one deterministic, visible artifact subject per current artifact
   * version. Artifact filtering is deliberately conservative: path globs and
   * language hints are applied in-process, while generated/external artifacts
   * are recognized from the closed artifact-kind vocabulary used by source
   * providers. Unknown kinds remain visible so the query never silently drops
   * a provider-owned artifact.
   */
  async artifacts_by_filter(scope: QueryScope, filter?: StructuralFilter): Promise<readonly CanonicalQueryRecord[]> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    const generation = await this.currentGeneration(scope);
    if (generation === undefined) return [];
    const rows = await this.database.all<{ artifact_id: string; artifact_version_id: string; normalized_uri: string; normalized_path: string | null; artifact_kind: string; language_hint: string | null }>(
      `SELECT version.artifact_id AS artifact_id, version.artifact_version_id AS artifact_version_id,
              artifact.normalized_uri AS normalized_uri, artifact.normalized_path AS normalized_path,
              artifact.artifact_kind AS artifact_kind, version.language_hint AS language_hint
         FROM artifact_versions AS version
         JOIN source_artifacts AS artifact
           ON artifact.workspace_id = version.workspace_id AND artifact.artifact_id = version.artifact_id
        WHERE version.workspace_id = ?
          AND version.valid_from_generation <= ?
          AND (version.valid_to_generation IS NULL OR version.valid_to_generation > ?)
        ORDER BY COALESCE(artifact.normalized_path, artifact.normalized_uri), version.artifact_id, version.artifact_version_id`,
      [scope.workspace_id, generation, generation],
    );
    const paths = filter?.paths ?? [];
    const languages = filter?.languages ?? [];
    return rows.filter((row) => {
      const path = row.normalized_path ?? row.normalized_uri;
      if (paths.length > 0 && !paths.some((pattern) => matchesArtifactGlob(path, pattern))) return false;
      if (languages.length > 0 && (row.language_hint === null || !languages.includes(row.language_hint))) return false;
      const kind = row.artifact_kind.toLowerCase();
      if (filter?.include_generated !== true && kind.includes("generated")) return false;
      if (filter?.include_external !== true && kind.includes("external")) return false;
      return true;
    }).map((row) => ({
      record_id: `artifact-record:${row.artifact_version_id}`,
      workspace_id: scope.workspace_id,
      category: "artifact_subject",
      kind: "core:source_file",
      universal_kind: "core:artifact",
      owner_artifact_id: row.artifact_id,
      owner_artifact_version_id: row.artifact_version_id,
      facets: [],
      body: { path: row.normalized_path ?? row.normalized_uri, artifact_id: row.artifact_id, artifact_version_id: row.artifact_version_id, artifact_kind: row.artifact_kind, language: row.language_hint },
    }));
  }

  /** See `CanonicalQuerySnapshotPort.semantic_index_state`'s own doc comment for the "never published" vs "published but never semantically indexed" distinction this preserves. */
  async semantic_index_state(scope: QueryScope): Promise<SemanticIndexStateSnapshot | undefined> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    const generation = await this.currentGeneration(scope);
    if (generation === undefined) return undefined;
    const marker = await this.database.get<{ completed_generation: number; profile_id: string; executable_binding_id: string }>("SELECT completed_generation, profile_id, executable_binding_id FROM semantic_index_state WHERE workspace_id = ?", [scope.workspace_id]);
    return marker === undefined ? { generation } : { generation, completed_generation: marker.completed_generation, profile_id: marker.profile_id, executable_binding_id: marker.executable_binding_id };
  }

  /** See `CanonicalQuerySnapshotPort.semantic_vectors`'s own doc comment. */
  /**
   * NOTE on implementation: the row contains typed vector metadata and a
   * reference to immutable shard bytes; it does not contain an aggregate
   * vector value.
   * The raw vector bytes live in a CAS-backed, packed shard (`vector_shards`),
   * sliced out via `shard_id`/`shard_offset`/`byte_length` -- exactly what
   * `WorkspaceProjectionRepository.readVector` does for one id at a time.
   * This method does the batched equivalent: one query for the candidate
   * rows, then one CAS read per DISTINCT shard they reference (never one per
   * row -- a shard can, in principle, pack many vectors), via `this.content`
   * (the same CAS-backed reader `search_literal`/`artifact_text` already
   * use). No `this.content` configured => `[]`, same "cannot answer" meaning
   * `search_literal`/`artifact_text` give for the same condition.
   */
  async semantic_vectors(scope: QueryScope, profileId: string, executableBindingId: string): Promise<readonly SemanticVectorRow[]> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    // Captured into a local `const` (not left as `this.content` accesses
    // below) so TypeScript's narrowing from the guard above survives into
    // the `mapWithConcurrency` callback closure -- a per-call member-access
    // narrow does not persist across a nested function boundary.
    const content = this.content;
    if (content === undefined) return [];
    const generation = await this.currentGeneration(scope);
    if (generation === undefined) return [];
    const rows = await this.database.all<{ projection_record_id: string; owner_artifact_id: string; owner_artifact_version_id: string; shard_id: string; shard_offset: number; byte_length: number; dimensions: number; element_type: string; normalization: string; distance_metric: string; document_grain: string | null; document_ref: string | null; segment_index: number | null; segment_start: number | null; segment_end: number | null }>(
      `SELECT projection_record_id, owner_artifact_id, owner_artifact_version_id, shard_id, shard_offset, byte_length, dimensions, element_type, normalization, distance_metric, document_grain, document_ref, segment_index, segment_start, segment_end
         FROM vector_projection_rows
        WHERE workspace_id = ? AND profile_id = ? AND executable_binding_id = ?
          AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)
        ORDER BY projection_record_id`,
      [scope.workspace_id, profileId, executableBindingId, generation, generation],
    );
    if (rows.length === 0) return [];
    const shardIds = [...new Set(rows.map((row) => row.shard_id))];
    // SQLite's variable ceiling is a runtime property (and can be as low as
    // 999). A semantic result may reference many packed shards, so never
    // construct one unbounded IN-list here -- each chunk is still its own
    // bounded query, but the chunks themselves run concurrently (Frente S-C,
    // 2026-09-07 latency work) rather than one after another.
    const shardRowChunks = await Promise.all(chunk(shardIds, DELTA_ID_CHUNK_SIZE).map((ids) =>
      this.database.all<{ shard_id: string; content_hash: string }>(
        `SELECT shard_id, content_hash FROM vector_shards WHERE workspace_id = ? AND shard_id IN (${ids.map(() => "?").join(", ")})`,
        [scope.workspace_id, ...ids],
      ),
    ));
    const shardRows = shardRowChunks.flat();
    // Latency (2026-09-07, Frente S-C): a real workspace's vectors span many
    // DISTINCT packed shards (one per embed-batch commit -- see
    // `semantic-reconciler.ts`'s `embedAndCommitBatch`), and this used to
    // read them one at a time in a plain sequential loop -- measured live as
    // the dominant cost of `core:search_semantic`'s own latency on a
    // realistically-sized corpus (far more than the query embedding itself,
    // which is ~1-2ms against an already-warm resident model -- see
    // `trySemanticSearch`'s own doc comment on the snapshot-port batching
    // right above it). `mapWithConcurrency` bounds fan-out the same way
    // `source-indexer.ts`/`directory-provider.ts` already bound their own
    // CAS/filesystem read concurrency, so a workspace with thousands of
    // shards cannot exhaust file descriptors just to answer one query.
    const shardBytes = new Map<string, Uint8Array>();
    await mapWithConcurrency(shardRows, SEMANTIC_SHARD_READ_CONCURRENCY, async (shard) => {
      try { shardBytes.set(shard.shard_id, await content.read(shard.content_hash)); } catch { /* unreadable shard -> its rows are dropped below, same "best effort" discipline artifact_text's CAS-read catch uses */ }
    });
    const result: SemanticVectorRow[] = [];
    for (const row of rows) {
      const packed = shardBytes.get(row.shard_id);
      if (packed === undefined) continue;
      // `document_grain === "entity"` (with a non-null `document_ref`) is
      // the only combination this pair of columns ever takes besides a bare
      // NULL `document_grain` (see the schema columns' own comment) -- any
      // other stored value (should never happen) is defensively treated as
      // "artifact", the same fallback every pre-decision-17 row already
      // gets. The keys are OMITTED (not set to a literal `undefined`) for
      // an artifact row -- this project's `exactOptionalPropertyTypes: true`
      // tsconfig setting rejects assigning `undefined` to an optional
      // property outright, so this must be a conditional spread, not a bare
      // ternary-valued property.
      const isEntity = row.document_grain === "entity" && row.document_ref !== null;
      // Frente S-B: `segment_start`/`segment_end` are omitted together
      // (never one without the other) -- both are non-NULL for a REAL
      // segment span, and both are NULL for every un-segmented row
      // (`segment_index` alone is never NULL, defaulting to `0`).
      const hasSegmentSpan = row.segment_start !== null && row.segment_end !== null;
      result.push({
        projection_record_id: row.projection_record_id, owner_artifact_id: row.owner_artifact_id, owner_artifact_version_id: row.owner_artifact_version_id,
        vector_payload: packed.slice(row.shard_offset, row.shard_offset + row.byte_length), dimensions: row.dimensions, element_type: row.element_type,
        normalization: row.normalization, distance_metric: row.distance_metric, segment_index: row.segment_index ?? 0,
        ...(isEntity ? { document_grain: "entity" as const, document_ref: row.document_ref as string } : {}),
        ...(hasSegmentSpan ? { segment_start: row.segment_start as number, segment_end: row.segment_end as number } : {}),
      });
    }
    return result;
  }

  /** See `CanonicalQuerySnapshotPort.semantic_scope_counts`'s own doc comment. `encoding <> 'binary'` mirrors the reconciler's own ARTIFACT-grain insert-eligibility guard (`semantic-reconciler.ts` step 3) exactly, so `artifact_count` here means the same "could ever be embedded" set the reconciler counts against. */
  async semantic_scope_counts(scope: QueryScope, maxDocumentBytes: number): Promise<{ readonly artifact_count: number; readonly oversized_count: number }> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    const generation = await this.currentGeneration(scope);
    if (generation === undefined) return { artifact_count: 0, oversized_count: 0 };
    const row = await this.database.get<{ artifact_count: number; oversized_count: number }>(
      `SELECT COUNT(*) AS artifact_count, COALESCE(SUM(CASE WHEN byte_length > ? THEN 1 ELSE 0 END), 0) AS oversized_count
         FROM artifact_versions
        WHERE workspace_id = ? AND encoding <> 'binary'
          AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)`,
      [maxDocumentBytes, scope.workspace_id, generation, generation],
    );
    return { artifact_count: row?.artifact_count ?? 0, oversized_count: row?.oversized_count ?? 0 };
  }

  /** See `CanonicalQuerySnapshotPort.semantic_entity_scope_counts`'s own doc comment. */
  async semantic_entity_scope_counts(scope: QueryScope): Promise<{ readonly entity_count: number }> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    const generation = await this.currentGeneration(scope);
    if (generation === undefined) return { entity_count: 0 };
    const row = await this.database.get<{ entity_count: number }>(
      `SELECT COUNT(*) AS entity_count
         FROM record_occurrences
        WHERE workspace_id = ? AND category = 'entity' AND kind <> 'jsts:entity_container'
          AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)`,
      [scope.workspace_id, generation, generation],
    );
    return { entity_count: row?.entity_count ?? 0 };
  }

  /** See `CanonicalQuerySnapshotPort.semantic_document_status_counts`'s own doc comment. */
  async semantic_document_status_counts(scope: QueryScope, profileId: string, executableBindingId: string): Promise<SemanticDocumentStatusCounts> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    const rows = await this.database.all<{ document_grain: string; status: string; n: number }>(
      "SELECT document_grain, status, COUNT(*) AS n FROM semantic_document_status WHERE workspace_id = ? AND profile_id = ? AND executable_binding_id = ? GROUP BY document_grain, status",
      [scope.workspace_id, profileId, executableBindingId],
    );
    let unsupportedArtifacts = 0, failedArtifacts = 0, entityCount = 0, coveredEntityCount = 0;
    for (const row of rows) {
      if (row.document_grain === "entity") {
        entityCount += row.n;
        if (row.status === "covered") coveredEntityCount += row.n;
      } else {
        if (row.status === "unsupported") unsupportedArtifacts += row.n;
        else if (row.status === "failed") failedArtifacts += row.n;
      }
    }
    return { unsupported_artifact_count: unsupportedArtifacts, failed_artifact_count: failedArtifacts, entity_count: entityCount, covered_entity_count: coveredEntityCount };
  }

  /** See `CanonicalQuerySnapshotPort.semantic_affected_documents`'s own doc comment. */
  async semantic_affected_documents(scope: QueryScope, profileId: string, executableBindingId: string): Promise<readonly SemanticAffectedDocumentRow[]> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    const rows = await this.database.all<{ document_grain: string; document_id: string; artifact_id: string; artifact_version_id: string; display_path: string; status: string; reason_codes: string }>(
      `SELECT document_grain, document_id, artifact_id, artifact_version_id, display_path, status, reason_codes
         FROM semantic_document_status
        WHERE workspace_id = ? AND profile_id = ? AND executable_binding_id = ? AND status <> 'covered'
        ORDER BY display_path, artifact_id, document_id`,
      [scope.workspace_id, profileId, executableBindingId],
    );
    return rows.map((row) => ({
      document_grain: row.document_grain === "entity" ? "entity" as const : "artifact" as const,
      document_id: row.document_id, artifact_id: row.artifact_id, artifact_version_id: row.artifact_version_id, display_path: row.display_path, status: row.status,
      reason_codes: parseReasonCodes(row.reason_codes),
    }));
  }

  /**
   * D1/D6: literal-substring search over `lexical_documents`/`lexical_fts`,
   * trusted only when `lexical_index_state.completed_generation` equals
   * `scope`'s current generation (otherwise `undefined`, meaning "fall back").
   * FTS5 trigram candidate filtering, and the raw-vs-normalized verification split
   * between case modes, mirror `WorkspaceProjectionRepository.searchLiteral`
   * (`packages/storage/src/projections.ts`) exactly -- see that function's
   * doc comment for the case/offset semantics this reproduces. Verification
   * reuses `artifact_text` (this class's own CAS-backed, cached text reader)
   * rather than re-reading `lexical_documents.storage_reference` directly, so
   * repeated searches (and `get_source` snippet reads for the same file) share
   * one cache.
   */
  async search_literal(scope: QueryScope, pattern: string, options: { readonly case_sensitive?: boolean; readonly word_mode?: "substring" | "identifier" | "token"; readonly path_patterns?: readonly string[]; readonly include_generated?: boolean; readonly include_external?: boolean } = {}): Promise<readonly LexicalSearchMatch[] | undefined> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    if (this.content === undefined) return undefined;
    const workspaceId = scope.workspace_id;
    const generation = await this.currentGeneration(scope);
    if (generation === undefined) return undefined;
    const sourceOnly = scope.snapshot_id?.startsWith("source-snapshot:") === true;
    const completion = sourceOnly ? undefined : await this.database.get<{ completed_generation: number }>("SELECT completed_generation FROM lexical_index_state WHERE workspace_id = ?", [workspaceId]);
    // Lexical maintenance is asynchronous. Until its completion marker is
    // current, `core:search_text` must remain source-safe and exact instead
    // of falling through to the decoded structural corpus. Scan the current
    // interval-versioned source catalog/CAS directly; once maintenance is
    // current, the normal FTS candidate lane takes over again.
    const sourceState = !sourceOnly && completion?.completed_generation !== generation
      ? await this.database.get<{ current_generation: number }>("SELECT current_generation FROM source_index_state WHERE workspace_id = ?", [workspaceId])
      : undefined;
    const scanSourceCatalog = sourceOnly || sourceState !== undefined;
    const effectiveGeneration = sourceState?.current_generation ?? generation;
    const effectiveScope: QueryScope = scanSourceCatalog && !sourceOnly
      ? { ...scope, snapshot_id: `source-snapshot:${effectiveGeneration}` }
      : scope;

    const normalizedPattern = normalizedTerm(pattern);
    const ftsQuery = `"${normalizedPattern.replaceAll('"', '""')}"`;
    const visibilitySql = " AND lexical_documents.valid_from_generation <= ? AND (lexical_documents.valid_to_generation IS NULL OR lexical_documents.valid_to_generation > ?)";
    const pathPatterns = options.path_patterns?.filter((pattern) => pattern.length > 0) ?? [];
    const pathPrefixes = pathPatterns.map(literalGlobPrefix);
    const pathFilterSql = pathPrefixes.length === 0 || pathPrefixes.some((prefix) => prefix.length === 0)
      ? ""
      : ` AND (${pathPrefixes.map(() => "source_artifacts.normalized_path LIKE ? ESCAPE '\\'").join(" OR ")})`;
    const pathParams = pathFilterSql.length === 0 ? [] : pathPrefixes.map((prefix) => `${escapeLikePattern(prefix)}%`);
    const artifactKindFilterSql = `${options.include_generated === true ? "" : " AND LOWER(source_artifacts.artifact_kind) NOT LIKE '%generated%'"}${options.include_external === true ? "" : " AND LOWER(source_artifacts.artifact_kind) NOT LIKE '%external%'"}`;
    let candidateRows = scanSourceCatalog
      ? await this.database.all<{ artifact_id: string; artifact_version_id: string; normalized_path: string | null }>(
          `SELECT version.artifact_id, version.artifact_version_id, source_artifacts.normalized_path FROM artifact_versions AS version
             JOIN source_artifacts ON source_artifacts.workspace_id = version.workspace_id AND source_artifacts.artifact_id = version.artifact_id
            WHERE version.workspace_id = ?${pathFilterSql}${artifactKindFilterSql}
              AND version.valid_from_generation <= ? AND (version.valid_to_generation IS NULL OR version.valid_to_generation > ?)
            ORDER BY version.artifact_id, version.artifact_version_id`,
          [workspaceId, ...pathParams, effectiveGeneration, effectiveGeneration],
        )
      : Array.from(normalizedPattern).length >= 3
      ? await this.database.all<{ artifact_id: string; artifact_version_id: string; normalized_path: string | null }>(
          `SELECT lexical_fts.artifact_id, lexical_fts.artifact_version_id, source_artifacts.normalized_path FROM lexical_fts
             JOIN lexical_documents ON lexical_documents.workspace_id = lexical_fts.workspace_id
              AND lexical_documents.artifact_id = lexical_fts.artifact_id
              AND lexical_documents.artifact_version_id = lexical_fts.artifact_version_id
             JOIN source_artifacts ON source_artifacts.workspace_id = lexical_documents.workspace_id
              AND source_artifacts.artifact_id = lexical_documents.artifact_id
            WHERE lexical_fts.workspace_id = ? AND lexical_fts MATCH ?${pathFilterSql}${artifactKindFilterSql}${visibilitySql}
            ORDER BY lexical_fts.artifact_id, lexical_fts.artifact_version_id`,
          [workspaceId, ftsQuery, ...pathParams, generation, generation],
        )
      : await this.database.all<{ artifact_id: string; artifact_version_id: string; normalized_path: string | null }>(
          `SELECT lexical_documents.artifact_id, lexical_documents.artifact_version_id, source_artifacts.normalized_path FROM lexical_documents
             JOIN source_artifacts ON source_artifacts.workspace_id = lexical_documents.workspace_id
              AND source_artifacts.artifact_id = lexical_documents.artifact_id
            WHERE lexical_documents.workspace_id = ?${pathFilterSql}${artifactKindFilterSql}${visibilitySql}
            ORDER BY lexical_documents.artifact_id, lexical_documents.artifact_version_id`,
        [workspaceId, ...pathParams, generation, generation],
      );
    if (pathPatterns.length > 0) candidateRows = candidateRows.filter((candidate) => candidate.normalized_path !== null && pathPatterns.some((pathPattern) => matchesArtifactGlob(candidate.normalized_path!, pathPattern)));
    const matches: LexicalSearchMatch[] = [];
    for (const candidate of candidateRows) {
      const file = await this.artifact_text(effectiveScope, candidate.artifact_version_id);
      if (file === undefined) continue;
      // Case-insensitive verification runs against normalizedTerm(source), so
      // returned offsets are indices into the normalized string, not the raw
      // source -- this caveat predates this change (see
      // `WorkspaceProjectionRepository.searchLiteral`). Case-sensitive
      // verification runs against the exact raw source and raw pattern.
      // This storage-facing port keeps its historical false default; the
      // public operation layer always supplies the contract default (true).
      const caseSensitive = options.case_sensitive === true;
      const comparable = caseSensitive ? file.text : normalizedTerm(file.text);
      const needle = caseSensitive ? pattern : normalizedPattern;
      const wordMode = options.word_mode ?? "substring";
      const offsets: number[] = [];
      const lineSpans: Pick<SourceSpan, "start_line" | "end_line">[] = [];
      let start = 0;
      while (true) {
        const offset = comparable.indexOf(needle, start);
        if (offset < 0) break;
        if (matchesWordMode(comparable, offset, needle.length, wordMode)) {
          offsets.push(offset);
          lineSpans.push({
            start_line: String(lineNumberAt(comparable, offset)),
            end_line: String(lineNumberAt(comparable, Math.max(offset + needle.length - 1, offset))),
          });
        }
        start = offset + Math.max(1, needle.length);
      }
      if (offsets.length > 0) matches.push({ artifact_id: candidate.artifact_id, artifact_version_id: candidate.artifact_version_id, offsets, line_spans: lineSpans });
    }
    return matches;
  }

  async capability_states(scope: QueryScope): Promise<readonly SnapshotCapabilityStateEntry[]> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    const workspaceId = scope.workspace_id;
    const generation = await this.currentGeneration(scope);
    if (generation === undefined) return [];
    const cached = this.capabilityCache.get(workspaceId);
    if (cached !== undefined && cached.generation === generation) return cached.states;
    const rows = await this.database.all<{ state_json: string }>("SELECT state_json FROM control_plane_state WHERE workspace_id = ? AND state_kind = 'capability_state' ORDER BY updated_at, state_key", [workspaceId]);
    const latest = new Map<string, SnapshotCapabilityStateEntry>();
    for (const row of rows) {
      const state = JSON.parse(row.state_json) as SnapshotCapabilityStateEntry;
      latest.set(`${state.capability}\0${state.provider_id}`, state);
    }
    const states = [...latest.values()].sort((left, right) => `${left.capability}\0${left.provider_id}`.localeCompare(`${right.capability}\0${right.provider_id}`));
    this.capabilityCache.set(workspaceId, { generation, states });
    return states;
  }

  async artifact_text(scope: QueryScope, artifactVersionId: string): Promise<{ readonly text: string } | undefined> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    if (this.content === undefined) return undefined;
    const cachedText = this.textCache.get(artifactVersionId);
    if (cachedText !== undefined) return { text: cachedText };
    const row = await this.database.get<{ content_hash: string; encoding: string }>("SELECT content_hash, encoding FROM artifact_versions WHERE workspace_id = ? AND artifact_version_id = ?", [scope.workspace_id, artifactVersionId]);
    if (row === undefined) return undefined;
    let bytes: Uint8Array;
    try { bytes = await this.content.read(row.content_hash); } catch { return undefined; }
    let decoder: TextDecoder;
    try { decoder = new TextDecoder(row.encoding); } catch { decoder = new TextDecoder("utf-8"); }
    const text = decoder.decode(bytes);
    this.textCache.set(artifactVersionId, text);
    if (this.textCache.size > TEXT_CACHE_LIMIT) { const oldest = this.textCache.keys().next().value; if (oldest !== undefined) this.textCache.delete(oldest); }
    return { text };
  }
}

function recordValue(record: CanonicalQueryRecord, classification: "confirmed" | "possible" = "confirmed"): Readonly<Record<string, unknown>> {
  if (record.category === "artifact_subject") {
    return {
      subject_type: "artifact",
      artifact_id: record.owner_artifact_id,
      artifact_version_id: record.owner_artifact_version_id,
      path: record.body["path"],
      universal_kind: record.universal_kind,
      kind: record.kind,
      classification,
      body: record.body,
    };
  }
  const subjectType = record.category === "relation" ? "relation" : record.category === "diagnostic" ? "diagnostic" : "entity";
  return {
    subject_type: subjectType,
    record_id: record.record_id,
    ...(record.identity_id === undefined ? {} : { [`${subjectType}_id`]: record.identity_id }),
    ...(record.identity_key === undefined ? {} : { identity_key: record.identity_key }),
    universal_kind: record.universal_kind,
    kind: record.kind,
    classification,
    ...(record.facets === undefined ? {} : { facets: record.facets }),
    ...(record.primary_source_span === undefined ? {} : { source_span: record.primary_source_span }),
    body: record.body,
  };
}

/**
 * Extracts only identifier-shaped terms from a natural-language task. Plain
 * prose words are intentionally excluded: `records_by_name` is an exact
 * symbol lookup, so querying every word both wastes IPC time and gives a
 * misleading impression that natural-language ranking happened here.
 * Camel/Pascal case, underscores and dollar-prefixed names are stable,
 * language-neutral signals that the caller supplied a code identifier.
 */
function contextIdentifierCandidates(task: string, queryClass: unknown): readonly string[] {
  const tokens = task.match(/[$_\p{L}][$_\p{L}\p{N}]*/gu) ?? [];
  const identifiers = tokens.filter((token) => token.includes("_") || token.includes("$") || /[\p{Ll}\p{N}][\p{Lu}]/u.test(token));
  if ((queryClass === "identifier" || queryClass === "source_code") && tokens.length === 1) identifiers.push(tokens[0]!);
  return [...new Set(identifiers)];
}

function sourceArtifactRecord(workspaceId: string, row: { readonly artifact_id: string; readonly artifact_version_id: string; readonly normalized_uri: string; readonly normalized_path: string | null }): CanonicalQueryRecord {
  return {
    record_id: `artifact-record:${row.artifact_version_id}`,
    workspace_id: workspaceId,
    category: "artifact_subject",
    kind: "core:source_file",
    universal_kind: "core:artifact",
    owner_artifact_id: row.artifact_id,
    owner_artifact_version_id: row.artifact_version_id,
    facets: [],
    body: { path: row.normalized_path ?? row.normalized_uri, artifact_id: row.artifact_id, artifact_version_id: row.artifact_version_id },
  };
}

/**
 * Plan 2026-09-06 (Frente N, §5.1): per-operation inline-snippet policy for
 * structural/discovery bundles that, before this plan, never carried a
 * source preview at all (only `core:get_source`/`core:search_text` did --
 * this file's own diagnosis, and `packages/mcp/src/index.ts`'s
 * `describeBundle`, both note this). "line" hydrates the exact source line
 * the record's own span covers (`sourceSnippet`'s new `"line"` mode, below);
 * "signature" hydrates the record's opening line (the pre-existing
 * `"signature"` mode, called here with `context_lines: 0`). Both share
 * `INLINE_SNIPPET_MAX_CHARS_PER_SNIPPET` (R13: 200 chars/bundle) and one
 * `INLINE_SNIPPET_TOTAL_BUDGET` per operation call (R13: 50 x 200 = 10k <
 * 20k -- mirrors `DEFAULT_QUERY_OPTIONS.snippets.max_total_characters` in
 * packages/mcp/src/index.ts, since none of these three operations has a
 * `source`-style argument of its own to carry a caller override through
 * `OperationInvocation.arguments` -- the same reason
 * `tryBuildContextPushdown`, above, already hardcodes its own 20,000
 * character budget instead of reading one from the caller).
 *
 * Table (decided in implementation for the entries the plan's own wording
 * left ambiguous):
 *  - `core:find_references` -> "line", applied to the `references` stream
 *    only (the reference occurrence itself, exactly "la línea del span de
 *    la referencia" per the plan). `owners` (the deduplicated declaring
 *    entities) is left unsnippeted: cheaply re-fetchable via
 *    `core:get_outline`/`core:get_source`, and outside the plan's own
 *    wording.
 *  - `core:get_outline` -> "signature", LEVEL-0 members only (direct
 *    children of the requested container -- "solo la raíz" per the plan):
 *    a deeper `depth` can return hundreds of nested members, well past the
 *    tens-of-bundles cost accounting R13 assumes.
 *  - `core:search_hybrid` / `core:search_semantic` -> "line" over
 *    `semantic_evidence.matched_segment.start_char` once Frente S-B
 *    populates it, else "signature" (`hydrateSemanticCandidates`, below).
 *    S-B has not landed in this worktree, so this always takes the
 *    "signature" fallback today.
 *  - `core:locate_implementation` (a recipe, not a primitive operation --
 *    see its entry in `packages/contracts/src/registries.ts`): decided in
 *    implementation -- its `implementations` stream is exactly
 *    `core:search_hybrid`'s own (kind-filtered) candidate objects
 *    (`search:core:search_hybrid@1 -> implementations:filter`, a
 *    pass-through filter with no re-fetch), so it inherits
 *    `core:search_hybrid`'s policy automatically with no separate wiring;
 *    its `sources` stream is `core:get_source` with its own pre-existing,
 *    much larger `mode:"relevant"` snippet configuration and is unaffected
 *    by this table. `packages/engine/src/recipe-executor.ts` is not in
 *    Frente N's file list and is not touched.
 */
const INLINE_SNIPPET_MAX_CHARS_PER_SNIPPET = 200;
const INLINE_SNIPPET_TOTAL_BUDGET = 20_000;

function item(record: CanonicalQueryRecord, classification: "confirmed" | "possible" = "confirmed", snippet?: SourceSnippetValue): QueryStreamItem {
  const value = recordValue(record, classification);
  return { value: snippet === undefined ? value : { ...value, optional_source_snippets: [snippet] }, stable_sort_key: `${classification}\0${record.identity_key ?? record.record_id}` };
}

function relationClassification(record: CanonicalQueryRecord): "confirmed" | "possible" {
  return record.body["classification"] === "possible" ? "possible" : "confirmed";
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function relationScopeKey(scope: QueryScope): string {
  if (scope.scope_type === "single_workspace") return `single\u0000${scope.workspace_id}\u0000${scope.snapshot_id ?? "current"}`;
  return `comparison\u0000${scope.participants.map((participant) => `${participant.workspace_id}\u0000${participant.snapshot_id ?? "current"}`).join("\u0001")}`;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function subjectIdentity(value: unknown): string | undefined {
  const record = object(value);
  for (const field of ["entity_id", "relation_id", "diagnostic_id", "record_id", "identity_key"]) if (typeof record[field] === "string") return record[field] as string;
  return undefined;
}

function subjectIdentities(value: unknown): readonly string[] {
  const record = object(value);
  return ["entity_id", "relation_id", "diagnostic_id", "record_id", "identity_key"].flatMap((field) => typeof record[field] === "string" ? [record[field] as string] : []);
}

/** Resolve execution-local pipeline bindings at the data boundary. The
 * executor passes stage_output tokens together with their sealed handles so a
 * dependent stage never receives an expanded selector array from JavaScript.
 * This adapter hydrates only the selectors required by the concrete legacy
 * operation implementation; SQL-aware adapters may consume `input_handles`
 * directly and skip this compatibility materialisation. */
async function materializeHandleBindings(value: unknown, handles: ReadonlyMap<string, unknown> | undefined): Promise<unknown> {
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const entry of value) {
      if (isStageOutputToken(entry)) {
        const handle = handles?.get(`${entry.stage_id}.${entry.output}`) as StageSetHandle | undefined;
        if (handle?.iterate === undefined) { output.push(entry); continue; }
        for await (const item of handle.iterate()) output.push(toSubjectSelector(item));
      } else output.push(await materializeHandleBindings(entry, handles));
    }
    return output;
  }
  if (isStageOutputToken(value)) {
    const handle = handles?.get(`${value.stage_id}.${value.output}`) as StageSetHandle | undefined;
    if (handle?.iterate === undefined) return value;
    if (handle.row_count !== 1) throw new EngineErrorWithDetails("core:stage_type_mismatch", "A scalar stage binding must resolve to exactly one row.", { referenced_stage_id: value.stage_id, referenced_output: value.output, actual_count: handle.row_count, cardinality: "one" });
    for await (const item of handle.iterate()) return toSubjectSelector(item);
    return value;
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) output[key] = await materializeHandleBindings(entry, handles);
    return output;
  }
  return value;
}

function isStageOutputToken(value: unknown): value is { readonly subject_type: "stage_output"; readonly stage_id: string; readonly output: string } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>)["subject_type"] === "stage_output"
    && typeof (value as Record<string, unknown>)["stage_id"] === "string"
    && typeof (value as Record<string, unknown>)["output"] === "string";
}

/** The final `:`-delimited segment of an `identity_key` (e.g. `createCanvas` out of `jsts:parameter:...:5578:createCanvas`) -- the entity/relation name, per the jsts identity-key format `records_by_name` pushes its LIKE scan down against. */
function identityKeyTail(identityKey: string | undefined): string | undefined {
  if (identityKey === undefined) return undefined;
  const index = identityKey.lastIndexOf(":");
  return index === -1 ? identityKey : identityKey.slice(index + 1);
}

/** Filters `records` down to those matching a `KindSelector`-shaped value's `kinds`/`universal_kinds` (an empty or absent list on either dimension is unrestricted, matching `selected()`'s own convention). Shared by symbol-selector resolution and `core:resolve_symbol`'s own filtering so both apply identical semantics. */
function filterByKindSelector(records: readonly CanonicalQueryRecord[], kindSelectorValue: unknown): readonly CanonicalQueryRecord[] {
  const kindSelector = object(kindSelectorValue);
  const kinds = strings(kindSelector["kinds"]);
  const universalKinds = strings(kindSelector["universal_kinds"]);
  if (kinds.length === 0 && universalKinds.length === 0) return records;
  return records.filter((record) => (kinds.length === 0 || kinds.includes(record.kind)) && (universalKinds.length === 0 || universalKinds.includes(record.universal_kind)));
}

/**
 * Resolves a `context_artifact` (an artifact id OR a workspace-relative
 * path -- Bug Group 2.3: the field's logical type was relaxed from a
 * pattern-constrained `Identifier` to unconstrained `Text` so paths
 * containing `/` validate at all) to its owning module/container entity.
 * The jsts module entity's `identity_key`/`body.name` IS the
 * workspace-relative path (`analyzer.ts`'s `stableId("module", file.path, ...)`),
 * so a plain `body.name`/`body.path` match covers the common case without a
 * dedicated path index.
 */
function resolveArtifactContainer(reference: string, maps: IdentityMaps): CanonicalQueryRecord | undefined {
  const direct = maps.by_any_id.get(reference);
  if (direct !== undefined && direct.universal_kind === "core:container") return direct;
  return maps.entities.find((record) => record.universal_kind === "core:container" && (record.body["path"] === reference || record.body["name"] === reference || record.owner_artifact_id === reference));
}

/**
 * Resolves ONE raw `SubjectSelector`-shaped value to zero or more records.
 * Handles every selector variant `subjectIdentity` alone cannot (Bug Group
 * 2.2/3): `{subject_type: "symbol", name, context_artifact?, kind_selector?}`
 * resolves by bare-name/qualified-name lookup (the same predicate
 * `core:resolve_symbol` uses), narrowed by `kind_selector` and, when a
 * `context_artifact` is given, preferentially narrowed to declarations
 * owned by that artifact; `{subject_type: "artifact", artifact_id | path}`
 * resolves to the owning module/container entity. Every other selector
 * variant (`entity`/`record`/`stage_output`) falls back to
 * `subjectIdentity` + direct id lookup, unchanged from before. A symbol
 * selector that resolves to more than one declaration (with no
 * `context_artifact` narrowing it to exactly one) throws
 * `core:selector_ambiguous` listing every candidate id, rather than
 * silently returning nothing or picking one at random.
 */
function resolveSelectorToRecords(selectorValue: unknown, maps: IdentityMaps): readonly CanonicalQueryRecord[] {
  const selector = object(selectorValue);
  if (selector["subject_type"] === "symbol") {
    const name = String(selector["name"] ?? "");
    let candidates: readonly CanonicalQueryRecord[] = maps.entities.filter((record) => record.body["name"] === name || record.body["qualified_name"] === name);
    candidates = filterByKindSelector(candidates, selector["kind_selector"]);
    const contextArtifact = typeof selector["context_artifact"] === "string" ? selector["context_artifact"] : undefined;
    if (contextArtifact !== undefined) {
      const container = resolveArtifactContainer(contextArtifact, maps);
      // A structural snapshot normally contains a module/container record,
      // but source-safe or partially materialized snapshots can expose the
      // declaration's path before that container is present in `maps`. The
      // declaration path is authoritative in both cases, so use it as a
      // direct narrowing key and fall back to the owning artifact id when a
      // container record is available. Without the direct check, a valid
      // `context_artifact` was silently ignored and `core:get_source` still
      // returned `core:selector_ambiguous`.
      const narrowed = candidates.filter((record) =>
        record.body["path"] === contextArtifact ||
        record.body["name"] === contextArtifact ||
        record.owner_artifact_id === contextArtifact ||
        (container !== undefined && record.owner_artifact_id === container.owner_artifact_id),
      );
      if (narrowed.length > 0) candidates = narrowed;
    }
    if (candidates.length === 0) return [];
    if (candidates.length > 1) {
      throw new EngineErrorWithDetails("core:selector_ambiguous", `Symbol "${name}" resolved to ${candidates.length} declarations; narrow with context_artifact or kind_selector.`, {
        selector_pointer: "/target",
        confirmed_candidate_ids: candidates.map((record) => record.identity_id ?? record.record_id),
        possible_candidate_ids: [],
      });
    }
    return [candidates[0]!];
  }
  if (selector["subject_type"] === "artifact") {
    if (typeof selector["artifact_id"] === "string") {
      const byId = maps.by_any_id.get(selector["artifact_id"]);
      if (byId !== undefined) return [byId];
      const byOwner = maps.entities.find((record) => record.universal_kind === "core:container" && record.owner_artifact_id === selector["artifact_id"]);
      return byOwner === undefined ? [] : [byOwner];
    }
    if (typeof selector["path"] === "string") {
      const container = resolveArtifactContainer(selector["path"], maps);
      return container === undefined ? [] : [container];
    }
    return [];
  }
  const id = subjectIdentity(selectorValue);
  const record = id === undefined ? undefined : maps.by_any_id.get(id);
  return record === undefined ? [] : [record];
}

/** `resolveSelectorToRecords` mapped over an array of selectors, in order, flattened -- the common shape every `subjects`/`sources`/`targets` array argument needs. */
function resolveSelectorsToRecords(selectorValues: unknown, maps: IdentityMaps): readonly CanonicalQueryRecord[] {
  return Array.isArray(selectorValues) ? selectorValues.flatMap((value) => resolveSelectorToRecords(value, maps)) : [];
}

function artifactSelectorMatches(record: CanonicalQueryRecord, selector: Record<string, unknown>): boolean {
  if (typeof selector["artifact_version_id"] !== "string" || record.owner_artifact_version_id !== selector["artifact_version_id"]) return false;
  if (typeof selector["artifact_id"] === "string" && record.owner_artifact_id !== selector["artifact_id"]) return false;
  if (typeof selector["path"] === "string" && record.body["path"] !== selector["path"]) return false;
  return true;
}

function selectorSourceSpan(selector: Record<string, unknown>): SourceSpan | undefined {
  const value = object(selector["source_span"]);
  if (typeof value["artifact_version_id"] !== "string" || typeof value["start_byte"] !== "string" || typeof value["end_byte"] !== "string") return undefined;
  return {
    artifact_version_id: value["artifact_version_id"],
    start_byte: value["start_byte"],
    end_byte: value["end_byte"],
    ...(typeof value["start_line"] === "string" ? { start_line: value["start_line"] } : {}),
    ...(typeof value["end_line"] === "string" ? { end_line: value["end_line"] } : {}),
  };
}

/** Hydrates the synthetic artifact records emitted by lexical search when a pipeline binds them into `core:get_source`. */
async function hydrateArtifactSelectorRecords(snapshots: CanonicalQuerySnapshotPort, scope: QueryScope, selectorValues: readonly unknown[], existing: readonly CanonicalQueryRecord[]): Promise<readonly CanonicalQueryRecord[]> {
  if (snapshots.records_by_artifact_versions === undefined) return [];
  const selectors = selectorValues.map(object).filter((selector) => selector["subject_type"] === "artifact" && typeof selector["artifact_version_id"] === "string");
  const versionIds = [...new Set(selectors.map((selector) => selector["artifact_version_id"] as string))];
  if (versionIds.length === 0) return [];
  const records = await snapshots.records_by_artifact_versions(scope, versionIds);
  const existingIds = new Set(existing.map((record) => record.record_id));
  const byVersion = new Map(records.map((record) => [record.owner_artifact_version_id, record]));
  return selectors.flatMap((selector) => {
    const record = byVersion.get(selector["artifact_version_id"] as string);
    if (record === undefined || !artifactSelectorMatches(record, selector) || existingIds.has(record.record_id)) return [];
    const sourceSpan = selectorSourceSpan(selector);
    return [sourceSpan === undefined ? record : { ...record, primary_source_span: sourceSpan }];
  });
}

function selected(record: CanonicalQueryRecord, selectorValue: unknown): boolean {
  const selector = object(selectorValue);
  const categories = strings(selector["record_categories"]);
  if (categories.length > 0 && !categories.includes(record.category)) return false;
  const kindSelector = object(selector["kind_selector"]);
  const universalKinds = strings(kindSelector["universal_kinds"]);
  const kinds = strings(kindSelector["kinds"]);
  if (universalKinds.length > 0 && !universalKinds.includes(record.universal_kind)) return false;
  if (kinds.length > 0 && !kinds.includes(record.kind)) return false;
  const filter = object(selector["filter"]);
  const languages = strings(filter["languages"]);
  if (languages.length > 0 && !languages.includes(String(record.body["language"] ?? ""))) return false;
  return true;
}

interface IdentityMaps {
  readonly by_any_id: ReadonlyMap<string, CanonicalQueryRecord>;
  readonly entities: readonly CanonicalQueryRecord[];
  readonly relations: readonly CanonicalQueryRecord[];
}

/**
 * Builds `by_any_id` (every record indexed by whichever of `record_id`/
 * `identity_id`/`identity_key` it has) plus the `entities`/`relations`
 * category slices, in one pass over `records` rather than a map-building loop
 * plus two separate full-corpus `filter`s -- both cheaper and, per this
 * function's corpus-scale caller (`cachedIdentityMaps`, memoized off `warm`/
 * `execute`), yields to the event loop every `RECORDS_YIELD_BATCH_SIZE`
 * records for the same reason `decodeRows` does: this can run over the same
 * multi-hundred-thousand-record corpus that load does, and was previously one
 * uninterrupted synchronous pass with no yield point at all. `entities`/
 * `relations` preserve `records`' relative order, same as the `filter` calls
 * they replace.
 */
async function identityMaps(records: readonly CanonicalQueryRecord[]): Promise<IdentityMaps> {
  const byAnyId = new Map<string, CanonicalQueryRecord>();
  const entities: CanonicalQueryRecord[] = [];
  const relations: CanonicalQueryRecord[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    for (const id of [record.record_id, record.identity_id, record.identity_key, record.body["entity_id"], record.body["relation_id"], record.body["diagnostic_id"]]) if (typeof id === "string") byAnyId.set(id, record);
    if (record.category === "entity") entities.push(record);
    else if (record.category === "relation") relations.push(record);
    if ((index + 1) % RECORDS_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();
  }
  return { by_any_id: byAnyId, entities, relations };
}

const identityMapsCache = new WeakMap<readonly CanonicalQueryRecord[], IdentityMaps>();

/**
 * Memoizes `identityMaps` per `records` array identity (a WeakMap, so it
 * never outlives the array itself -- see `recordsCache`'s reference-identity
 * invariant this relies on). Not single-flighted: two concurrent callers
 * (e.g. two overlapping `execute()` calls) can both miss the cache and both
 * `await identityMaps(records)` concurrently -- each pays the build cost, but
 * both computations are pure functions of the same `records` array, so the
 * results are equivalent and whichever `.set()` runs last simply wins. That
 * duplicate work is accepted as harmless (it can only happen once per fresh
 * `records` array, not on every call) rather than adding an in-flight-promise
 * map here too.
 */
async function cachedIdentityMaps(records: readonly CanonicalQueryRecord[]): Promise<IdentityMaps> {
  const cached = identityMapsCache.get(records);
  if (cached !== undefined) return cached;
  const computed = await identityMaps(records);
  identityMapsCache.set(records, computed);
  return computed;
}

function relationEndpoints(record: CanonicalQueryRecord, byAnyId: ReadonlyMap<string, CanonicalQueryRecord>): { readonly source?: CanonicalQueryRecord; readonly target?: CanonicalQueryRecord } {
  const sourceId = typeof record.body["source_id"] === "string" ? record.body["source_id"] : undefined;
  const targetId = typeof record.body["target_id"] === "string" ? record.body["target_id"] : undefined;
  const source = sourceId === undefined ? undefined : byAnyId.get(sourceId);
  const target = targetId === undefined ? undefined : byAnyId.get(targetId);
  return { ...(source === undefined ? {} : { source }), ...(target === undefined ? {} : { target }) };
}

function ancestors(record: CanonicalQueryRecord, maps: IdentityMaps): readonly CanonicalQueryRecord[] {
  const result: CanonicalQueryRecord[] = [];
  let current = record;
  const seen = new Set<string>();
  while (!seen.has(current.record_id)) {
    seen.add(current.record_id);
    const parent = maps.relations.filter((entry) => entry.universal_kind === "core:contains").map((entry) => relationEndpoints(entry, maps.by_any_id)).find((entry) => entry.target === current)?.source;
    if (parent === undefined) break;
    result.push(parent);
    current = parent;
  }
  return result;
}

function relatedTests(subjects: readonly CanonicalQueryRecord[], maps: IdentityMaps): readonly CanonicalQueryRecord[] {
  const covered = new Set(subjects.flatMap((subject) => [subject, ...ancestors(subject, maps)]));
  const tests = maps.relations.filter((record) => record.universal_kind === "core:covers").flatMap((record) => {
    const endpoints = relationEndpoints(record, maps.by_any_id);
    return endpoints.source !== undefined && endpoints.target !== undefined && covered.has(endpoints.target) ? [endpoints.source] : [];
  });
  return [...new Map(tests.map((record) => [record.record_id, record])).values()];
}

interface SourceSnippetValue {
  readonly text: string;
  readonly span: SourceSpan;
  readonly truncated: boolean;
  readonly redacted: boolean;
  readonly redactions: readonly [];
}

function lineStart(text: string, index: number): number {
  const newline = text.lastIndexOf("\n", index - 1);
  return newline === -1 ? 0 : newline + 1;
}

function lineEnd(text: string, index: number): number {
  const newline = text.indexOf("\n", index);
  return newline === -1 ? text.length : newline + 1;
}

// Adversarial review 2026-09-06 (Frente N): `sourceSnippet`'s two truncation
// points below (`maxCharactersPerSnippet`, `remainingBudget`) previously cut
// with a plain `String.prototype.slice(0, limit)`. For any line whose
// content puts a UTF-16 surrogate pair (an astral character -- most emoji,
// some CJK extension characters) exactly on that boundary, a plain slice
// keeps the high surrogate and drops its low surrogate, leaving a lone
// (unpaired) surrogate in `snippet.text`. That string round-trips through
// JSON fine (JSON allows unpaired surrogates as `\uXXXX` escapes) but is
// invalid Unicode text once decoded by a consumer that enforces well-formed
// UTF-16/UTF-8 (a strict `TextEncoder`/`JSON.parse` reviver, a terminal that
// rejects WTF-8, `Buffer.from(text, "utf8")` substituting U+FFFD, ...) --
// exactly the "line >200 chars" truncation case Frente N's adversarial
// review asked to check "¿corta en medio de un code point UTF-16
// surrogate?" for. `codePointBefore`/`codePointAt` above already apply the
// identical one-unit backup for glob-pattern matching; this mirrors that.
function truncateWithoutSplittingSurrogatePair(text: string, limit: number): string {
  if (limit >= text.length) return text;
  if (limit <= 0) return "";
  const trailing = text.charCodeAt(limit - 1);
  const boundary = trailing >= 0xd800 && trailing <= 0xdbff ? limit - 1 : limit;
  return text.slice(0, boundary);
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (text[cursor] === "\n") line += 1;
  return line;
}

function extendSpanForContext(text: string, start: number, end: number, contextLines: number): { readonly start: number; readonly end: number } {
  if (contextLines <= 0) return { start, end };
  let extendedStart = lineStart(text, start);
  let extendedEnd = lineEnd(text, Math.max(end - 1, start));
  for (let line = 0; line < contextLines; line += 1) {
    if (extendedStart > 0) extendedStart = lineStart(text, extendedStart - 1);
    if (extendedEnd < text.length) extendedEnd = lineEnd(text, extendedEnd);
  }
  return { start: extendedStart, end: extendedEnd };
}

async function sourceSnippet(snapshots: CanonicalQuerySnapshotPort, scope: QueryScope, record: CanonicalQueryRecord, mode: "signature" | "relevant" | "body" | "line", maxCharactersPerSnippet: number, contextLines: number, remainingBudget: number): Promise<SourceSnippetValue | undefined> {
  if (remainingBudget <= 0) return undefined;
  const file = await snapshots.artifact_text?.(scope, record.owner_artifact_version_id);
  if (file === undefined) return undefined;
  const bodyStart = record.body["start"];
  const bodyEnd = record.body["end"];
  const canonicalSpan = record.primary_source_span;
  // A source-catalog artifact represents the complete file and therefore has
  // no entity span. Treat its implicit span as the full artifact; requiring a
  // structural container solely to manufacture start=0/end=file.length would
  // defeat source-ready direct artifact reads and force a full corpus load.
  const wholeArtifact = record.category === "artifact_subject";
  const start = typeof bodyStart === "number" ? bodyStart : canonicalSpan === undefined ? wholeArtifact ? 0 : undefined : Number(canonicalSpan.start_byte);
  const end = typeof bodyEnd === "number" ? bodyEnd : canonicalSpan === undefined ? wholeArtifact ? file.text.length : undefined : Number(canonicalSpan.end_byte);
  if (typeof start !== "number" || typeof end !== "number" || start < 0 || end < start) return undefined;
  if (end > file.text.length) return undefined;
  const text = file.text;
  let coreEnd = end;
  if (mode === "signature") {
    const newline = text.indexOf("\n", start);
    coreEnd = newline === -1 || newline >= end ? end : newline;
  }
  // Plan 2026-09-06 (Frente N, SNIPPET_POLICY): "line" always renders the
  // FULL source line the span starts on -- not merely `[start, coreEnd)`
  // (which, for a reference occurrence, is often just the identifier
  // token) -- regardless of `contextLines` (inline policy snippets always
  // call this with `contextLines: 0`, since "one more line of context"
  // would defeat R13's one-line-per-bundle budget accounting).
  const { start: sliceStart, end: sliceEnd } = mode === "line"
    ? { start: lineStart(text, start), end: lineEnd(text, Math.max(coreEnd - 1, start)) }
    : extendSpanForContext(text, start, coreEnd, contextLines);
  let snippetText = text.slice(sliceStart, sliceEnd);
  let truncated = false;
  if (snippetText.length > maxCharactersPerSnippet) { snippetText = truncateWithoutSplittingSurrogatePair(snippetText, maxCharactersPerSnippet); truncated = true; }
  if (snippetText.length > remainingBudget) { snippetText = truncateWithoutSplittingSurrogatePair(snippetText, remainingBudget); truncated = true; }
  const useStoredLines = contextLines === 0 && canonicalSpan !== undefined;
  return {
    text: snippetText,
    span: {
      artifact_version_id: canonicalSpan?.artifact_version_id ?? record.owner_artifact_version_id,
      start_byte: String(sliceStart),
      end_byte: String(sliceEnd),
      start_line: useStoredLines && canonicalSpan?.start_line !== undefined ? canonicalSpan.start_line : String(lineNumberAt(text, sliceStart)),
      end_line: useStoredLines && canonicalSpan?.end_line !== undefined ? canonicalSpan.end_line : String(lineNumberAt(text, Math.max(sliceEnd - 1, sliceStart))),
    },
    truncated,
    redacted: false,
    redactions: [],
  };
}

/**
 * `core:get_source`'s subject-to-snippet body, shared by the full in-memory
 * path and the pushdown path in `CanonicalRecordQueryDataPort.execute` --
 * once `subjects` is resolved (by either path's own id-lookup), the rest of
 * the operation (mode/budget handling, `sourceSnippet` calls) is identical.
 */
async function buildGetSourceStreams(snapshots: CanonicalQuerySnapshotPort, scope: QueryScope, subjects: readonly CanonicalQueryRecord[], args: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, readonly QueryStreamItem[]>>> {
  const sourceOptions = object(args["source"]);
  const mode = sourceOptions["mode"] === "none" || sourceOptions["mode"] === "signature" || sourceOptions["mode"] === "relevant" || sourceOptions["mode"] === "body" ? sourceOptions["mode"] : "body";
  const maxCharactersPerSnippet = typeof sourceOptions["max_characters_per_snippet"] === "number" ? sourceOptions["max_characters_per_snippet"] : 4000;
  const maxTotalCharacters = typeof sourceOptions["max_total_characters"] === "number" ? sourceOptions["max_total_characters"] : 16000;
  const contextLines = typeof sourceOptions["context_lines"] === "number" ? sourceOptions["context_lines"] : 0;
  let remainingBudget = maxTotalCharacters;
  const sources: QueryStreamItem[] = [];
  for (const record of subjects) {
    const snippet = mode === "none" ? undefined : await sourceSnippet(snapshots, scope, record, mode, maxCharactersPerSnippet, contextLines, remainingBudget);
    if (snippet !== undefined) remainingBudget -= snippet.text.length;
    sources.push({
      value: { result_set: "sources", primary_result: recordValue(record), assessment: { classification: "confirmed", completeness: "complete" }, provenance_path: [], essential_related_entities: [], optional_source_snippets: snippet === undefined ? [] : [snippet] },
      stable_sort_key: `confirmed\0${record.identity_key ?? record.record_id}`,
    });
  }
  return { sources };
}

/** Optional third argument only ever supplied by `trySemanticSearch` -- every other caller's evaluation has no semantic lane, so `OperationEvaluation.semantic_state` stays absent for them exactly as before this field existed. */
// Query completeness dimensions are a public, response-budgeted projection of
// the much larger persisted SnapshotCapabilityStateEntry values. Keeping the
// complete affected-artifact arrays on the internal snapshot state is required
// for publication verification, but sending every id with every operation
// makes an ordinary query response exceed the daemon's 256 KiB UCE frame. The
// public contract explicitly permits a deterministic inline prefix plus an
// immutable set id when the complete enumerable set does not fit inline.
const COMPLETENESS_ARTIFACT_ID_PREFIX_CAP = 8;

function completenessDimensions(states: readonly SnapshotCapabilityStateEntry[]): readonly Record<string, unknown>[] {
  return states.map((state) => {
    const affectedArtifactIds = [...new Set(state.affected_artifact_ids)].sort();
    const truncated = affectedArtifactIds.length > COMPLETENESS_ARTIFACT_ID_PREFIX_CAP;
    return {
      workspace_snapshot_binding_ids: [],
      capability: state.capability,
      status: state.status,
      reason_codes: state.reason_codes,
      affected_artifact_count: affectedArtifactIds.length,
      affected_artifact_ids: truncated ? affectedArtifactIds.slice(0, COMPLETENESS_ARTIFACT_ID_PREFIX_CAP) : affectedArtifactIds,
      ...(truncated ? { affected_artifact_set_id: digestOf({ capability: state.capability, provider_id: state.provider_id, provider_version: state.provider_version, affected_artifact_ids: affectedArtifactIds }) } : {}),
      diagnostic_record_ids: state.diagnostic_record_ids,
    };
  });
}

function result(streams: Readonly<Record<string, readonly QueryStreamItem[]>>, states: readonly SnapshotCapabilityStateEntry[], semanticState?: OperationEvaluation["semantic_state"]): OperationEvaluation {
  const rank = new Map([["complete", 0], ["partial", 1], ["unknown", 2], ["unsupported", 3], ["stale", 4]]);
  const overall = states.reduce((worst, state) => (rank.get(state.status) ?? 2) > (rank.get(worst) ?? 2) ? state.status : worst, "complete");
  return { streams, completeness: { overall_status: overall, dimensions: completenessDimensions(states) }, diagnostics: [], ...(semanticState === undefined ? {} : { semantic_state: semanticState }) };
}

/**
 * Thrown by `trySemanticSearch` for the three semantic-search-specific
 * registered operation error codes (`core:semantic_index_unavailable`,
 * `core:query_embedding_failed`, `core:required_capability_unsupported`).
 * `EngineError` itself (`errors.ts`) is deliberately minimal -- just a code
 * and a message -- so this module-local subclass adds the `details` payload
 * those registered codes require (`packages/contracts/src/registries.ts`'s
 * `operationErrorDetails`), the same pattern `QueryPlanError`/`CursorCacheError`
 * (`query-plan.ts`/`cursor-cache.ts`) already use for their own
 * code-narrowing subclasses -- without widening `EngineError` itself for
 * every other caller in the engine that has no use for structured details.
 */
class SemanticQueryError extends EngineError {
  constructor(code: string, message: string, readonly details: Readonly<Record<string, unknown>>) {
    super(code, message);
    this.name = "SemanticQueryError";
  }
}

function digestOf(value: unknown): string {
  return digestBytes(canonicalBytes(value));
}

/** Plan 2026-09-06 (Frente S-A): defensive decode of `semantic_document_status.reason_codes` -- always written by this codebase's own reconciler as a JSON array of strings, but never trusted blindly against a hand-edited or foreign-tool-written row. */
function parseReasonCodes(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch { return []; }
}

/**
 * Collapses `vectors` (as `semantic_vectors` returns them: every visible row
 * for one provider identity, unfiltered, unranked) to at most one row per
 * `owner_artifact_version_id`, keeping the first occurrence in
 * `projection_record_id` order (already the query's own `ORDER BY`, so this
 * is deterministic). v1's reconciler only ever writes one vector per visible
 * artifact version, so this is a defensive no-op today -- see the pinned
 * spec's "dedupe multiple vector rows per owner artifact version" note --
 * not a case this file has any way to construct in practice.
 */
function dedupeVectorsByOwner(vectors: readonly SemanticVectorRow[]): readonly SemanticVectorRow[] {
  const byOwner = new Map<string, SemanticVectorRow>();
  for (const vector of vectors) if (!byOwner.has(vector.owner_artifact_version_id)) byOwner.set(vector.owner_artifact_version_id, vector);
  return [...byOwner.values()];
}

/**
 * Decision 17 sibling of `dedupeVectorsByOwner`, above -- but keyed by
 * `document_ref` (the owning entity RECORD id), NEVER by
 * `owner_artifact_version_id`: unlike artifact-grain vectors, many entity
 * rows legitimately share one owner artifact version (every eligible entity
 * in the same file), so deduping by owner here would wrongly collapse an
 * entire file's worth of entity candidates down to one.
 *
 * Frente S-B (2026-09-06, decision 17 segmentation): this is now ONLY "best
 * by document" in the trivial, similarity-blind sense of "one arbitrary
 * representative row per document" -- used SOLELY for the coverage view's
 * `covered_entity_count` (a plain distinct-document count, where WHICH
 * segment represents a document does not matter). It is NO LONGER how the
 * entity lane's SEARCH RANKING picks a document's winning segment -- that is
 * `trySemanticSearch`'s own max-similarity reduction over `entitySegmentRanks`
 * (see its doc comment), which walks the ALREADY-SCORED, best-first exact-scan
 * result instead of this function's first-occurrence-in-storage-order pick.
 * A multi-segment entity now legitimately has SEVERAL open rows sharing one
 * `document_ref` (one per segment), so "at most one open row per document_ref"
 * is no longer the invariant this dedup happens to be defensive against --
 * it is now doing real, necessary collapsing work for that count.
 */
function dedupeVectorsByDocumentRef(vectors: readonly SemanticVectorRow[]): readonly SemanticVectorRow[] {
  const byRef = new Map<string, SemanticVectorRow>();
  for (const vector of vectors) {
    if (vector.document_ref === undefined) continue;
    if (!byRef.has(vector.document_ref)) byRef.set(vector.document_ref, vector);
  }
  return [...byRef.values()];
}

/** True iff `marker` reflects a semantic maintenance pass that is BOTH caught up to the scope's current generation AND embedded under the CURRENTLY configured provider's exact identity -- a marker current under a since-replaced provider is not "current" for this provider's purposes, mirroring the reconciler's own profile-swap-close discipline. */
function isSemanticMarkerCurrent(marker: SemanticIndexStateSnapshot | undefined, provider: ResolvedSemanticProvider | undefined): boolean {
  return marker !== undefined && provider !== undefined && marker.completed_generation === marker.generation && marker.profile_id === provider.profile.embedding_profile_id && marker.executable_binding_id === provider.binding.executable_binding_digest;
}

function matchesPathPrefix(path: string | undefined, pathPrefixes: readonly string[]): boolean {
  if (pathPrefixes.length === 0) return true;
  return path !== undefined && pathPrefixes.some((prefix) => path.startsWith(prefix));
}

function matchesArtifactGlob(path: string, pattern: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedPattern = pattern.replaceAll("\\", "/");
  let expression = "^";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index] ?? "";
    if (character === "*" && normalizedPattern[index + 1] === "*") {
      // `**/` also matches zero directories, as in the native Glob tools;
      // plain `.*` would incorrectly require at least one nested directory
      // for patterns such as `src/**/*.ts`.
      if (normalizedPattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
  }
  return new RegExp(`${expression}$`).test(normalizedPath);
}

function literalGlobPrefix(pattern: string): string {
  const normalized = pattern.replaceAll("\\", "/");
  const wildcard = normalized.search(/[?*]/u);
  return wildcard < 0 ? normalized : normalized.slice(0, wildcard);
}

function codePointBefore(value: string, offset: number): string {
  if (offset <= 0) return "";
  const trailing = value.charCodeAt(offset - 1);
  return trailing >= 0xdc00 && trailing <= 0xdfff && offset >= 2 ? value.slice(offset - 2, offset) : value.slice(offset - 1, offset);
}

function codePointAt(value: string, offset: number): string {
  if (offset >= value.length) return "";
  const width = (value.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
  return value.slice(offset, offset + width);
}

function matchesWordMode(value: string, offset: number, length: number, mode: "substring" | "identifier" | "token"): boolean {
  if (mode === "substring") return true;
  const boundaryCharacter = mode === "identifier" ? /[$\p{ID_Continue}]/u : /[_\p{L}\p{M}\p{N}]/u;
  const before = codePointBefore(value, offset);
  const after = codePointAt(value, offset + length);
  return (before.length === 0 || !boundaryCharacter.test(before)) && (after.length === 0 || !boundaryCharacter.test(after));
}

/**
 * Builds the single `SemanticCoverageView` item `trySemanticSearch` emits.
 * State machine (see the pinned spec's coverage bullet, and this module's
 * own report on the choices made where the spec left room):
 * - `indexSupported: false` (no provider configured, the snapshot port lacks
 *   the three semantic methods, or -- the "fully unavailable" case for
 *   `core:search_hybrid` -- zero visible vectors and no current marker) =>
 *   `"unavailable"`. Treated with the SAME pending/excluded arithmetic as
 *   `"updating"` below (nothing has been materialized either way; only the
 *   REASON differs) -- documented here because the pinned spec does not
 *   spell out this branch's arithmetic explicitly.
 * - Marker current (`isCurrent`) => `"complete"` when every eligible
 *   (non-oversized) artifact is covered, else `"degraded"`; `pending` is
 *   always 0 (the pass considers itself DONE; any shortfall is permanent for
 *   this generation, hence `excluded`, never `pending`).
 * - Marker stale or missing (and index otherwise supported) => `"updating"`;
 *   `pending` is the eligible-but-not-yet-covered count, `excluded` is only
 *   the oversized count (the shortfall is expected to close on the next
 *   maintenance pass, not permanent).
 * `unsupported_artifact_count`/`failed_artifact_count` are always 0 and
 * `affected_artifact_page` is always omitted -- this port has no channel
 * back to the reconciler's own skip/failure bookkeeping (only
 * `semantic_index_state`'s pass/fail marker, not itemized reasons), so v1
 * reports only what it can actually observe from SQL; `affected_artifact_count`
 * is set to `pending` for the same reason.
 *
 * Decision 17 additive fields (`entity_count`/`covered_entity_count`, on
 * `EntitySemanticCoverageView` below): a deliberately MINIMAL extension --
 * two raw counts (eligible-candidate entity records vs currently-covered
 * entity vectors), computed and reported unconditionally alongside the
 * artifact numbers, but NOT folded into `materialization_state`/`pending_artifact_count`/
 * `excluded_artifact_count`, which stay exactly as they were before this
 * decision (artifact-only, byte-for-byte). Entity coverage completeness is a
 * genuinely separate question this v1 extension answers informationally, not
 * yet a gate on the overall semantic lane's readiness state.
 */
/**
 * Plan 2026-09-06 (Frente S-A, R11): the stateless, self-contained
 * `core:semantic_affected_page` cursor -- a hex-encoded JSON object `{set,
 * k, dir}` (hexadecimal, NOT base64/base64url: `scripts/check-architecture.mjs`'s
 * `checkNativePipelineContracts` guardrail bans `Buffer`/`toString` base64
 * framing repo-wide, and `packages/engine/src/cursor-cache.ts`'s own opaque
 * cursor tokens already establish hex as this codebase's one local-handle
 * encoding -- see that file's `encode`/`decode` for the identical
 * convention this mirrors). `set` is the `affected_artifact_set_id` the
 * cursor was minted against (a cursor whose `set` disagrees with the
 * CURRENT set id is rejected outright, never silently mixed into a page --
 * see `pageAffectedRows`'s caller); `k` is the `(display_path, artifact_id,
 * document_id)` keyset tuple of the row the cursor is anchored to; `dir` is
 * `"next"` (this cursor was minted from a page's LAST row, so the next page
 * starts strictly after `k`) or `"prev"` (minted from a page's FIRST row, so
 * the previous page ends strictly before `k`).
 */
interface AffectedCursor {
  readonly set: string;
  readonly k: readonly [string, string, string];
  readonly dir: "next" | "prev";
}

/** Thrown by `decodeAffectedCursor` for a structurally malformed cursor -- `execute`'s caller (`trySemanticAffectedPage`) turns this into a registered `core:invalid_argument`-shaped error, never an unhandled throw. */
export class AffectedCursorError extends Error {}

function encodeAffectedCursor(cursor: AffectedCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("hex");
}

function decodeAffectedCursor(token: string): AffectedCursor {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(token, "hex").toString("utf8")); }
  catch { throw new AffectedCursorError("Malformed core:semantic_affected_page cursor: not valid hex-encoded JSON."); }
  if (typeof parsed !== "object" || parsed === null) throw new AffectedCursorError("Malformed core:semantic_affected_page cursor: expected a JSON object.");
  const record = parsed as Record<string, unknown>;
  const set = record["set"];
  const k = record["k"];
  const dir = record["dir"];
  if (typeof set !== "string" || !Array.isArray(k) || k.length !== 3 || !k.every((value): value is string => typeof value === "string") || (dir !== "next" && dir !== "prev")) {
    throw new AffectedCursorError("Malformed core:semantic_affected_page cursor: expected {set: string, k: [string, string, string], dir: \"next\" | \"prev\"}.");
  }
  return { set, k: [k[0] as string, k[1] as string, k[2] as string], dir };
}

/** Lexicographic order over an affected row's `(display_path, artifact_id, document_id)` keyset tuple -- the exact tie-break chain `semantic_affected_documents`'s own `ORDER BY` uses, so binary-searching this array with this comparator agrees with the array's own order. */
function compareAffectedKeys(left: readonly [string, string, string], right: readonly [string, string, string]): number {
  for (let index = 0; index < 3; index += 1) {
    const a = left[index]!, b = right[index]!;
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

function affectedKeyOf(row: SemanticAffectedDocumentRow): readonly [string, string, string] {
  return [row.display_path, row.artifact_id, row.document_id];
}

/**
 * Plan 2026-09-06 (Frente S-A): slices `rows` (already ordered by
 * `affectedKeyOf`, `semantic_affected_documents`'s own contract) into one
 * page, entirely in memory -- a binary search locates the cursor's anchor in
 * O(log n), then a plain array slice produces the page, so pagination cost
 * is independent of how many earlier pages were walked. `cursor` absent
 * means "first page, ascending, from the start."
 */
function pageAffectedRows(rows: readonly SemanticAffectedDocumentRow[], limit: number, cursor?: { readonly k: readonly [string, string, string]; readonly dir: "next" | "prev" }): { readonly page: readonly SemanticAffectedDocumentRow[]; readonly startIndex: number } {
  if (cursor === undefined) return { page: rows.slice(0, limit), startIndex: 0 };
  if (cursor.dir === "next") {
    // First index whose key is strictly greater than the cursor's anchor.
    let lo = 0, hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareAffectedKeys(affectedKeyOf(rows[mid]!), cursor.k) <= 0) lo = mid + 1; else hi = mid;
    }
    return { page: rows.slice(lo, lo + limit), startIndex: lo };
  }
  // "prev": first index whose key is NOT strictly less than the cursor's
  // anchor (i.e. the exclusive end of "everything before the anchor"), then
  // take up to `limit` rows immediately preceding it.
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareAffectedKeys(affectedKeyOf(rows[mid]!), cursor.k) < 0) lo = mid + 1; else hi = mid;
  }
  const start = Math.max(0, lo - limit);
  return { page: rows.slice(start, lo), startIndex: start };
}

/**
 * Plan 2026-09-06 (Frente S-A): builds one `SemanticAffectedArtifactPage`
 * (§4.2/§4.3) from the complete, already-ordered affected-row set
 * (`semantic_affected_documents`) plus an optional decoded cursor -- shared
 * verbatim by `buildSemanticCoverageView`'s embedded first page and
 * `trySemanticAffectedPage`'s own continuation operation, so the two can
 * never disagree about set id computation or page-boundary arithmetic.
 * `setId` is computed ONCE per call over every row in `rows` (R11's
 * "accumulated digest over the sorted keys"), independent of `limit`/`cursor`,
 * so it is stable across every page of the SAME underlying set.
 */
/** The `affected_artifact_set_id` component of `buildAffectedArtifactPage` -- split out so `trySemanticAffectedPage` can validate a requested set id/cursor against the CURRENT set BEFORE paying for `pageAffectedRows`, and so the coverage view's embedded-first-page call site and the continuation operation's own call site never compute this digest twice for the same `rows`/identity. */
function computeAffectedSetId(rows: readonly SemanticAffectedDocumentRow[], inputs: { readonly bindingId: string; readonly generation: number; readonly profileId: string; readonly executableBindingId: string }): string {
  const keysDigest = digestCanonicalArray(rows.map(affectedKeyOf));
  return digestOf({ binding_id: inputs.bindingId, generation: inputs.generation, profile_id: inputs.profileId, executable_binding_id: inputs.executableBindingId, total: rows.length, keys_digest: keysDigest });
}

function buildAffectedArtifactPage(rows: readonly SemanticAffectedDocumentRow[], inputs: { readonly setId: string; readonly limit: number; readonly cursor?: { readonly k: readonly [string, string, string]; readonly dir: "next" | "prev" } }): SemanticAffectedArtifactPage {
  const setId = inputs.setId;
  const { page, startIndex } = pageAffectedRows(rows, inputs.limit, inputs.cursor);
  const hasPrevious = startIndex > 0;
  const hasNext = startIndex + page.length < rows.length;
  const artifacts: readonly SemanticAffectedArtifactView[] = page.map((row) => ({
    artifact_id: row.artifact_id, artifact_version_id: row.artifact_version_id, display_path: row.display_path,
    coverage_status: row.status, reason_codes: row.reason_codes, diagnostic_record_ids: [],
  }));
  return {
    affected_artifact_set_id: setId,
    artifacts,
    total: rows.length,
    ...(hasNext && page.length > 0 ? { next_cursor: encodeAffectedCursor({ set: setId, k: affectedKeyOf(page[page.length - 1]!), dir: "next" }) } : {}),
    ...(hasPrevious && page.length > 0 ? { previous_cursor: encodeAffectedCursor({ set: setId, k: affectedKeyOf(page[0]!), dir: "prev" }) } : {}),
    has_next: hasNext,
    has_previous: hasPrevious,
  };
}

type EntitySemanticCoverageView = SemanticCoverageView & {
  /** Decision 17: cheap over-count of candidate entity records (`CanonicalQuerySnapshotPort.semantic_entity_scope_counts`'s own doc comment explains why this over-counts relative to the reconciler's true eligible set). `0` when the port does not implement that method. */
  readonly entity_count: number;
  /** Decision 17: entity-grain vectors currently visible under the resolved provider identity (deduplicated by `document_ref`, mirroring `covered_artifact_count`'s own dedup-by-owner). `0` when the index is unavailable or no entity vectors have been embedded yet. */
  readonly covered_entity_count: number;
};

function buildSemanticCoverageView(inputs: {
  readonly provider: ResolvedSemanticProvider | undefined;
  readonly marker: SemanticIndexStateSnapshot | undefined;
  readonly isCurrent: boolean;
  readonly counts: { readonly artifact_count: number; readonly oversized_count: number };
  readonly coveredCount: number;
  readonly indexSupported: boolean;
  readonly entityCount: number;
  readonly coveredEntityCount: number;
  /**
   * Plan 2026-09-06 (Frente S-A): real `semantic_document_status` counts
   * (`unsupported`/`failed` artifacts, exact entity counts), when the port
   * implements `semantic_document_status_counts` -- overrides the
   * corresponding inferred/over-counted fields below. `undefined` keeps this
   * function's pre-existing inferred arithmetic byte-for-byte.
   */
  readonly realCounts: SemanticDocumentStatusCounts | undefined;
  /** Plan 2026-09-06 (Frente S-A): the embedded first affected page (§4.2), built by the caller via `buildAffectedArtifactPage`. `undefined` when the port has no `semantic_affected_documents` capability -- `affected_artifact_set_id`/`affected_artifact_page` are then omitted entirely, same as before this plan. */
  readonly affectedPage: SemanticAffectedArtifactPage | undefined;
}): EntitySemanticCoverageView {
  const { provider, marker, isCurrent, counts, coveredCount, indexSupported, entityCount, coveredEntityCount, realCounts, affectedPage } = inputs;
  const eligible = Math.max(0, counts.artifact_count - counts.oversized_count);
  const materializationState: "complete" | "degraded" | "updating" | "unavailable" = !indexSupported ? "unavailable" : isCurrent ? (coveredCount >= eligible ? "complete" : "degraded") : "updating";
  const settled = materializationState === "complete" || materializationState === "degraded";
  const pending = settled ? 0 : Math.max(0, eligible - coveredCount);
  const excluded = settled ? counts.oversized_count + Math.max(0, eligible - coveredCount) : counts.oversized_count;
  const profileId = provider?.profile.embedding_profile_id ?? marker?.profile_id ?? "core:no-provider-configured";
  const executableBindingId = provider?.binding.executable_binding_digest ?? marker?.executable_binding_id ?? "core:no-binding-configured";
  return {
    semantic_index_binding_id: digestOf({ profile_id: profileId, executable_binding_id: executableBindingId }),
    materialization_state: materializationState,
    artifact_count: counts.artifact_count,
    covered_artifact_count: coveredCount,
    pending_artifact_count: pending,
    excluded_artifact_count: excluded,
    unsupported_artifact_count: realCounts?.unsupported_artifact_count ?? 0,
    failed_artifact_count: realCounts?.failed_artifact_count ?? 0,
    // Invariant (plan 2026-09-06): affected = status <> 'covered'. Real total
    // from the affected page when available; the old "pending" heuristic
    // otherwise (a port with no status-table capability at all).
    affected_artifact_count: affectedPage?.total ?? pending,
    entity_count: realCounts?.entity_count ?? entityCount,
    covered_entity_count: realCounts?.covered_entity_count ?? coveredEntityCount,
    ...(affectedPage === undefined ? {} : { affected_artifact_set_id: affectedPage.affected_artifact_set_id, affected_artifact_page: affectedPage }),
  };
}

/** `OperationEvaluation.semantic_state` for `materializationState`. `"failed"` is never produced by this port -- reserved for a future provider-level hard failure this port cannot currently distinguish from `"unavailable"`; see this module's own report for why `"unsupported"` (not `"failed"`) was picked for the no-index branch. */
function semanticEvaluationState(materializationState: SemanticCoverageView["materialization_state"]): NonNullable<OperationEvaluation["semantic_state"]> {
  return materializationState === "complete" ? "ready" : materializationState === "degraded" ? "partial" : materializationState === "updating" ? "updating" : "unsupported";
}

/** `trySemanticSearch`'s own narrowing check, same rejection message as every `SqliteCanonicalQuerySnapshotPort` method above -- `QueryScope` is a union (a comparison scope has no single `workspace_id`), but every registered error detail this method throws needs one concrete workspace id. */
function requireSingleWorkspaceScope(scope: QueryScope): SingleWorkspaceScope {
  if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
  return scope;
}

function coverageItem(view: EntitySemanticCoverageView): QueryStreamItem {
  return { value: view, stable_sort_key: `unclassified\0${view.semantic_index_binding_id}` };
}

/**
 * Candidate stream item for both `core:search_semantic` and
 * `core:search_hybrid` -- the registry pins both operations' `candidates`
 * stream to `possible`-only (`registries.ts`), so unlike `item()` above
 * there is no `confirmed` case to branch on. `rank` is always the FINAL,
 * post-hydration output position (1-based, contiguous, no gaps even if some
 * ranked ids failed to hydrate) -- never a fusion-internal or
 * exact-scan-internal rank, which could contain gaps once un-hydratable ids
 * are dropped.
 *
 * `snippet` (Frente N, SNIPPET_POLICY): the one-line inline snippet hydrated
 * for this candidate, when the source text was available.
 *
 * `matchedSegment` (Frente S-B, decision 17 segmentation): present only for
 * an entity candidate whose winning row carries a real segment span --
 * folded into the emitted value's `semantic_evidence.matched_segment` field
 * so a caller can point directly at the segment that actually matched,
 * rather than the whole entity's span. Absent for every artifact candidate
 * and every entity candidate with no segment span recorded (a
 * pre-segmentation row).
 */
function semanticCandidateItem(record: CanonicalQueryRecord, rank: number, snippet?: SourceSnippetValue, matchedSegment?: { readonly index: number; readonly start_char: number; readonly end_char: number }): QueryStreamItem {
  const identity = record.identity_key ?? record.record_id;
  const value = {
    ...recordValue(record, "possible"),
    ...(matchedSegment === undefined ? {} : { semantic_evidence: { matched_segment: matchedSegment } }),
    ...(snippet === undefined ? {} : { optional_source_snippets: [snippet] }),
  };
  return { value, stable_sort_key: `possible\0${String(rank).padStart(6, "0")}\0${identity}` };
}

/**
 * Language-neutral evaluator over one immutable canonical record snapshot.
 * It never invokes plugin code; JavaScript/TypeScript records participate only
 * through their registered universal kinds and validated relation endpoints.
 */
export class CanonicalRecordQueryDataPort implements QueryDataPort {
  readonly consumes_stage_handles = true;
  /** Relation joins retain only identities and endpoint pairs, never complete
   * decoded records (which would duplicate the corpus in the join cache). */
  private readonly relationIndexCache = new Map<string, { readonly byAnyId: ReadonlyMap<string, string>; readonly pairs: ReadonlyMap<string, ReadonlySet<string>> }>();

  constructor(private readonly snapshots: CanonicalQuerySnapshotPort, private readonly options: { readonly semantic?: ResolvedSemanticProvider } = {}) {}

  private async resolveIndexedGraphSelectors(scope: QueryScope, selectorValues: unknown): Promise<readonly CanonicalQueryRecord[] | undefined> {
    const selectors = Array.isArray(selectorValues) ? selectorValues : [];
    const directIds = selectors.map(subjectIdentity).filter((value): value is string => value !== undefined);
    const symbols = selectors.map(object).filter((selector) => selector["subject_type"] === "symbol");
    const artifacts = selectors.map(object).filter((selector) => selector["subject_type"] === "artifact");
    if (directIds.length > 0 && this.snapshots.records_by_ids === undefined) return undefined;
    if (symbols.length > 0 && this.snapshots.records_by_name === undefined) return undefined;
    if ((artifacts.length > 0 || symbols.some((selector) => typeof selector["context_artifact"] === "string")) && this.snapshots.container_records_by_artifact_references === undefined) return undefined;
    if (symbols.some((selector) => String(selector["name"] ?? "").includes("."))) return undefined;
    const rows: CanonicalQueryRecord[] = [];
    if (directIds.length > 0) rows.push(...await this.snapshots.records_by_ids!(scope, directIds));
    for (const name of [...new Set(symbols.map((selector) => String(selector["name"] ?? "")))]) rows.push(...await this.snapshots.records_by_name!(scope, name));
    const artifactReferences = [...new Set([
      ...artifacts.flatMap((selector) => [selector["artifact_id"], selector["artifact_version_id"], selector["path"]]),
      ...symbols.map((selector) => selector["context_artifact"]),
    ].filter((value): value is string => typeof value === "string"))];
    if (artifactReferences.length > 0) rows.push(...await this.snapshots.container_records_by_artifact_references!(scope, artifactReferences));
    const unique = [...new Map(rows.map((record) => [record.record_id, record])).values()].sort((left, right) => left.record_id.localeCompare(right.record_id));
    const maps = await identityMaps(unique);
    return selectors.flatMap((selector) => resolveSelectorToRecords(selector, maps));
  }

  private async indexedGraphRecords(scope: QueryScope, traversalRoots: readonly CanonicalQueryRecord[], retainedRecords: readonly CanonicalQueryRecord[], direction: "inbound" | "outbound" | "both", maxDepth: number): Promise<readonly CanonicalQueryRecord[] | undefined> {
    if (this.snapshots.graph_edges_by_subject_ids === undefined || this.snapshots.records_by_ids === undefined) return undefined;
    const records = new Map<string, CanonicalQueryRecord>();
    for (const record of [...traversalRoots, ...retainedRecords]) records.set(record.record_id, record);
    const edgeRows = new Map<string, IndexedGraphEdge>();
    const seen = new Set(traversalRoots.map((record) => record.record_id));
    let frontier = [...traversalRoots];
    const aliasMap = (): Map<string, CanonicalQueryRecord> => {
      const aliases = new Map<string, CanonicalQueryRecord>();
      for (const record of records.values()) for (const id of [record.record_id, record.identity_id, record.identity_key, record.body["entity_id"], record.body["relation_id"]]) if (typeof id === "string") aliases.set(id, record);
      return aliases;
    };
    const hydrate = async (rows: readonly IndexedGraphEdge[]): Promise<void> => {
      const ids = [...new Set(rows.flatMap((edge) => [edge.source_subject_id, edge.target_subject_id, edge.relation_record_id]))];
      for (const record of await this.snapshots.records_by_ids!(scope, ids)) records.set(record.record_id, record);
      for (const edge of rows) edgeRows.set(edge.edge_id, edge);
    };
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const frontierAliases = new Set(frontier.flatMap((record) => [record.record_id, record.identity_id, record.identity_key].filter((value): value is string => value !== undefined)));
      const rows = await this.snapshots.graph_edges_by_subject_ids(scope, [...frontierAliases], direction);
      if (rows === undefined) return undefined;
      await hydrate(rows);
      const byAlias = aliasMap();
      const next: CanonicalQueryRecord[] = [];
      for (const edge of rows) {
        const endpointIds: string[] = [];
        if ((direction === "outbound" || direction === "both") && frontierAliases.has(edge.source_subject_id)) endpointIds.push(edge.target_subject_id);
        if ((direction === "inbound" || direction === "both") && frontierAliases.has(edge.target_subject_id)) endpointIds.push(edge.source_subject_id);
        for (const endpointId of endpointIds) {
          const record = byAlias.get(endpointId);
          if (record !== undefined && !seen.has(record.record_id)) { seen.add(record.record_id); next.push(record); }
        }
      }
      frontier = next;
    }
    // The fallback's expansion relation stream includes every selected edge
    // whose endpoints are both reachable, including cycle/back edges touching
    // the final frontier. Fetch that closed adjacency without traversing it.
    const allAliases = [...new Set([...records.values()].flatMap((record) => [record.record_id, record.identity_id, record.identity_key].filter((value): value is string => value !== undefined)))];
    const closure = await this.snapshots.graph_edges_by_subject_ids(scope, allAliases, "both");
    if (closure === undefined) return undefined;
    await hydrate(closure);
    return [...records.values()].sort((left, right) => left.record_id.localeCompare(right.record_id));
  }

  private async evaluateGraphOperation(operation: OperationInvocation, records: readonly CanonicalQueryRecord[], maps: IdentityMaps, capabilityStates: readonly SnapshotCapabilityStateEntry[]): Promise<OperationEvaluation | undefined> {
    const args = object(operation.arguments);
    const evaluated = (streams: Readonly<Record<string, readonly QueryStreamItem[]>>): OperationEvaluation => result(streams, capabilityStates);
    if (operation.operation_id === "core:get_outline") {
      const container = resolveSelectorsToRecords(args["container"] === undefined ? [] : [args["container"]], maps)[0];
      if (container === undefined) throw new EngineErrorWithDetails("core:selector_not_found", "The get_outline container could not be resolved.", { selector_pointer: "/container" });
      const depth = typeof args["depth"] === "number" ? args["depth"] : 1;
      const contains = new Map<CanonicalQueryRecord, CanonicalQueryRecord[]>();
      for (const relation of maps.relations) {
        if (relation.universal_kind !== "core:contains") continue;
        const endpoints = relationEndpoints(relation, maps.by_any_id);
        if (endpoints.source === undefined || endpoints.target === undefined) continue;
        const children = contains.get(endpoints.source) ?? [];
        children.push(endpoints.target);
        contains.set(endpoints.source, children);
      }
      // 2026-09-06 flecos-v4 fidelity fix: `maps.relations`' own order is
      // NOT guaranteed to be declaration order (it is whatever order the
      // underlying `records` array holds `core:contains` rows in, which for
      // some producers -- e.g. `jsts:entity_parameter`'s own `contains` rows,
      // emitted by iterating a `BTreeMap<entity_id, _>` -- sorts by the
      // ENTITY ID STRING, not numerically by byte offset: `"10"` sorts
      // before `"9"` lexicographically). An agent reading `get_outline`
      // expects a callable's parameters listed left-to-right as declared, so
      // sort each parent's children by their own `primary_source_span.
      // start_byte` (numeric) before emitting -- falling back to `start_line`
      // then to `identity_key`/`record_id` only when a span is missing
      // entirely (e.g. a synthetic `external_module`/`external_symbol`
      // entity, whose span is always `0`/`0`, so those simply keep whatever
      // stable order `Array.prototype.sort` gives ties).
      for (const children of contains.values()) {
        children.sort((left, right) => {
          const leftStart = left.primary_source_span?.start_byte;
          const rightStart = right.primary_source_span?.start_byte;
          if (leftStart !== undefined && rightStart !== undefined) {
            const diff = Number(leftStart) - Number(rightStart);
            if (diff !== 0) return diff;
          } else if (leftStart !== undefined) return -1;
          else if (rightStart !== undefined) return 1;
          return (left.identity_key ?? left.record_id).localeCompare(right.identity_key ?? right.record_id);
        });
      }
      const seen = new Set<string>([container.identity_key ?? container.record_id]);
      let frontier = [container];
      const members: CanonicalQueryRecord[] = [];
      // Plan 2026-09-06 (Frente N, SNIPPET_POLICY): tracks which members were
      // discovered at level 0 (direct children of `container`) -- exactly
      // "solo la raíz" -- so the snippet hydration loop below can skip
      // deeper-nested members instead of paying for (and returning) a
      // snippet on every one of a potentially large `depth > 1` outline.
      const rootLevelKeys = new Set<string>();
      for (let level = 0; level < depth; level += 1) {
        const next: CanonicalQueryRecord[] = [];
        for (const parent of frontier) for (const child of contains.get(parent) ?? []) {
          const key = child.identity_key ?? child.record_id;
          if (!seen.has(key)) { seen.add(key); members.push(child); next.push(child); if (level === 0) rootLevelKeys.add(key); }
        }
        frontier = next;
      }
      const inScopeIdentityKeys = new Set<string>([container.identity_key ?? container.record_id, ...members.map((record) => record.identity_key ?? record.record_id)]);
      const pendingSites = await this.pendingSitesStreamForOutline(operation.scope, container, inScopeIdentityKeys);
      let remainingOutlineSnippetBudget = INLINE_SNIPPET_TOTAL_BUDGET;
      const memberItems: QueryStreamItem[] = [];
      for (const record of members) {
        const key = record.identity_key ?? record.record_id;
        if (!rootLevelKeys.has(key)) { memberItems.push(item(record)); continue; }
        const snippet = await sourceSnippet(this.snapshots, operation.scope, record, "signature", INLINE_SNIPPET_MAX_CHARS_PER_SNIPPET, 0, remainingOutlineSnippetBudget);
        if (snippet !== undefined) remainingOutlineSnippetBudget -= snippet.text.length;
        memberItems.push(item(record, "confirmed", snippet));
      }
      return evaluated({ members: memberItems, pending_sites: pendingSites });
    }
    if (operation.operation_id === "core:find_references") {
      const target = resolveSelectorsToRecords(args["target"] === undefined ? [] : [args["target"]], maps)[0];
      const relations = target === undefined ? [] : maps.relations.filter((record) => relationEndpoints(record, maps.by_any_id).target === target);
      const owners = relations.flatMap((record) => {
        const source = relationEndpoints(record, maps.by_any_id).source;
        return source === undefined ? [] : [source];
      });
      let remainingReferenceSnippetBudget = INLINE_SNIPPET_TOTAL_BUDGET;
      const referenceItems: QueryStreamItem[] = [];
      for (const record of relations) {
        const snippet = await sourceSnippet(this.snapshots, operation.scope, record, "line", INLINE_SNIPPET_MAX_CHARS_PER_SNIPPET, 0, remainingReferenceSnippetBudget);
        if (snippet !== undefined) remainingReferenceSnippetBudget -= snippet.text.length;
        referenceItems.push(item(record, relationClassification(record), snippet));
      }
      return evaluated({ references: referenceItems, owners: [...new Map(owners.map((record) => [record.record_id, record])).values()].map((record) => item(record)) });
    }
    if (operation.operation_id === "core:expand_relations") {
      const rootRecords = resolveSelectorsToRecords(args["subjects"], maps);
      const idOf = (record: CanonicalQueryRecord): string => record.identity_key ?? record.record_id;
      const rootIds = rootRecords.map(idOf);
      const direction = args["direction"] === "inbound" ? "inbound" : args["direction"] === "both" ? "both" : "outbound";
      const relationKinds = strings(object(args["relations"])["universal_kinds"]);
      const minDepth = typeof args["min_depth"] === "number" ? args["min_depth"] : 1;
      const maxDepth = typeof args["max_depth"] === "number" ? args["max_depth"] : 1;
      const edges: RelationEdge[] = maps.relations.flatMap((record) => {
        const endpoints = relationEndpoints(record, maps.by_any_id);
        if (endpoints.source === undefined || endpoints.target === undefined) return [];
        if (relationKinds.length > 0 && !relationKinds.includes(record.universal_kind)) return [];
        return [{ source: idOf(endpoints.source), target: idOf(endpoints.target), relation_kind: record.universal_kind, classification: relationClassification(record), stable_sort_key: record.identity_key ?? record.record_id }];
      });
      const expanded = rootIds.length === 0 ? [] : expandRelations(edges, rootIds, { direction, min_depth: minDepth, max_depth: maxDepth, ...(relationKinds.length > 0 ? { relation_kinds: relationKinds } : {}) });
      const discoveredIds = new Map<string, CanonicalQueryRecord>();
      for (const entry of expanded) {
        const record = maps.by_any_id.get(entry.subject);
        if (record !== undefined && !discoveredIds.has(entry.subject)) discoveredIds.set(entry.subject, record);
      }
      const reachableIds = new Set([...rootIds, ...discoveredIds.keys()]);
      const relationsUsed = maps.relations.filter((record) => {
        if (relationKinds.length > 0 && !relationKinds.includes(record.universal_kind)) return false;
        const endpoints = relationEndpoints(record, maps.by_any_id);
        return endpoints.source !== undefined && endpoints.target !== undefined && reachableIds.has(idOf(endpoints.source)) && reachableIds.has(idOf(endpoints.target));
      });
      const paths = args["path_policy"] === undefined || discoveredIds.size === 0 || rootIds.length === 0
        ? []
        : findShortestPaths(edges, rootIds, [...discoveredIds.keys()], { direction, max_depth: maxDepth, all_shortest: false, ...(relationKinds.length > 0 ? { relation_kinds: relationKinds } : {}) }).map((path): QueryStreamItem => ({
            value: { subjects: path.subjects.map((id) => maps.by_any_id.get(id)).filter((value): value is CanonicalQueryRecord => value !== undefined).map((record) => recordValue(record)), relation_kinds: path.relation_kinds, length: path.subjects.length - 1, classification: path.classification },
            stable_sort_key: path.stable_sort_key,
            result_classification: path.classification,
          }));
      return evaluated({ subjects: [...discoveredIds.values()].map((record) => item(record)), relations: relationsUsed.map((record) => item(record, relationClassification(record))), paths });
    }
    if (operation.operation_id === "core:find_paths") {
      const sources = resolveSelectorsToRecords(args["sources"], maps);
      const targets = new Set(resolveSelectorsToRecords(args["targets"], maps));
      const direction = args["direction"] === "inbound" ? "inbound" : args["direction"] === "both" ? "both" : "outbound";
      const relationKinds = strings(object(args["relations"])["universal_kinds"]);
      const maxDepth = typeof args["max_depth"] === "number" ? args["max_depth"] : 4;
      const adjacent = new Map<CanonicalQueryRecord, Array<{ readonly target: CanonicalQueryRecord; readonly relation: CanonicalQueryRecord }>>();
      const add = (source: CanonicalQueryRecord, target: CanonicalQueryRecord, relation: CanonicalQueryRecord): void => {
        const entries = adjacent.get(source) ?? [];
        entries.push({ target, relation });
        adjacent.set(source, entries);
      };
      for (const relation of maps.relations) {
        if (relationKinds.length > 0 && !relationKinds.includes(relation.universal_kind)) continue;
        const endpoints = relationEndpoints(relation, maps.by_any_id);
        if (endpoints.source === undefined || endpoints.target === undefined) continue;
        if (direction === "outbound" || direction === "both") add(endpoints.source, endpoints.target, relation);
        if ((direction === "inbound" || direction === "both") && endpoints.source !== endpoints.target) add(endpoints.target, endpoints.source, relation);
      }
      const queue = sources.map((node) => ({ node, path: [] as CanonicalQueryRecord[] }));
      let queueIndex = 0;
      const found: CanonicalQueryRecord[] = [];
      const seen = new Set(sources.map((record) => record.record_id));
      while (queueIndex < queue.length) {
        const current = queue[queueIndex++]!;
        if (targets.has(current.node)) { found.push(...current.path); break; }
        if (current.path.length >= maxDepth) continue;
        for (const edge of adjacent.get(current.node) ?? []) {
          if (seen.has(edge.target.record_id)) continue;
          seen.add(edge.target.record_id);
          queue.push({ node: edge.target, path: [...current.path, edge.relation] });
        }
      }
      return evaluated({ paths: found.map((record) => item(record, relationClassification(record))) });
    }
    return undefined;
  }

  /**
   * `core:get_outline`'s additive `pending_sites` stream (task brief:
   * `docs/evidence/2026-09-04-v4-pending-sites-fold-and-member-entities.md`
   * §8 -- unresolved call/heritage sites used to be readable as `possible`
   * records/`jsts:unresolved_call` diagnostics; both are gone, and this
   * restores the capability without a new operation or record category).
   * `container.universal_kind === "core:container"` is exactly the
   * module/artifact-container test `resolveArtifactContainer`/
   * `resolveSelectorToRecords`'s `subject_type: "artifact"` branch already
   * use elsewhere in this file -- when true, every visible pending site of
   * the owning artifact is in scope.
   *
   * For any other entity, "whose span lies inside the entity's span" (the
   * task brief's own wording) turns out NOT to mean byte-range containment
   * against `primary_source_span`: verified live against the task-planner
   * fixture that an entity record's `primary_source_span` is its NAME
   * token's span only (e.g. `InvalidTaskTransitionError` at bytes
   * [183,209), 26 bytes for a 27-character identifier) -- never the
   * declaration's full body range a `super(...)` call or `extends` clause
   * deeper in that same declaration would fall inside. A pending site's
   * REAL enclosing declaration is instead its already-resolved
   * `source_id` (the same identity key `residual.rs`'s `source_subject ->
   * ... -> identity_key` chain resolves), so scoping asks the same
   * question `members` above just answered: is the site's enclosing
   * entity the container itself, or one of the members this SAME call
   * already listed (a class's own constructor/method entities are direct
   * `core:contains` children of it, per §2.4's member-entity synthesis)?
   * `callerInScopeIdentityKeys` is exactly `{container} ∪ members`, so
   * this reuses the SAME containment BFS/`depth` semantics `members`
   * already applied -- no separate unlimited-depth traversal, and no
   * behavior beyond what `depth` already surfaced as in scope.
   *
   * Returns `[]` (never throws) when the port has no
   * `pending_sites_by_owner_artifact` capability (a v3/SQLite-backed
   * snapshot port) -- the same "absent capability degrades to empty,
   * never an error" convention every other optional pushdown method in
   * this file follows.
   */
  private async pendingSitesStreamForOutline(scope: QueryScope, container: CanonicalQueryRecord, inScopeIdentityKeys: ReadonlySet<string>): Promise<readonly QueryStreamItem[]> {
    if (this.snapshots.pending_sites_by_owner_artifact === undefined) return [];
    const rows = await this.snapshots.pending_sites_by_owner_artifact(scope, container.owner_artifact_id, container.owner_artifact_version_id);
    if (rows.length === 0) return [];
    const path = (await this.hydratePaths(scope, [container.owner_artifact_version_id])).get(container.owner_artifact_version_id) ?? (typeof container.body["path"] === "string" ? container.body["path"] : "");
    const isModuleContainer = container.universal_kind === "core:container";
    const scoped = isModuleContainer ? rows : rows.filter((row) => row.source_id !== undefined && inScopeIdentityKeys.has(row.source_id));
    return scoped.map((row): QueryStreamItem => ({
      value: { path, start: row.start, end: row.end, site_kind: row.site_kind, reason: row.reason, source_id: row.source_id ?? null },
      stable_sort_key: `${path}\0${String(row.start).padStart(12, "0")}\0${String(row.end).padStart(12, "0")}\0${row.site_kind}`,
      result_classification: "unclassified",
    }));
  }

  private async tryGraphPushdown(operation: OperationInvocation): Promise<OperationEvaluation | undefined> {
    if (!["core:get_outline", "core:find_references", "core:expand_relations", "core:find_paths"].includes(operation.operation_id)) return undefined;
    const args = object(operation.arguments);
    const sourceSelectors = operation.operation_id === "core:get_outline" ? [args["container"]]
      : operation.operation_id === "core:find_references" ? [args["target"]]
      : operation.operation_id === "core:expand_relations" ? args["subjects"]
      : args["sources"];
    const roots = await this.resolveIndexedGraphSelectors(operation.scope, sourceSelectors);
    if (roots === undefined) return undefined;
    const retained = operation.operation_id === "core:find_paths" ? await this.resolveIndexedGraphSelectors(operation.scope, args["targets"]) : [];
    if (retained === undefined) return undefined;
    const direction = operation.operation_id === "core:get_outline" ? "outbound"
      : operation.operation_id === "core:find_references" ? "inbound"
      : args["direction"] === "inbound" ? "inbound" : args["direction"] === "both" ? "both" : "outbound";
    const maxDepth = operation.operation_id === "core:get_outline" ? (typeof args["depth"] === "number" ? args["depth"] : 1)
      : operation.operation_id === "core:find_references" ? 1
      : typeof args["max_depth"] === "number" ? args["max_depth"] : operation.operation_id === "core:find_paths" ? 4 : 1;
    const records = await this.indexedGraphRecords(operation.scope, roots, retained, direction, maxDepth);
    if (records === undefined) return undefined;
    const capabilityStates = await this.snapshots.capability_states?.(operation.scope) ?? [];
    return this.evaluateGraphOperation(operation, records, await identityMaps(records), capabilityStates);
  }

  private async relationIndex(scope: QueryScope): Promise<{ readonly byAnyId: ReadonlyMap<string, string>; readonly pairs: ReadonlyMap<string, ReadonlySet<string>> }> {
    const scopeKey = relationScopeKey(scope);
    let index = this.relationIndexCache.get(scopeKey);
    if (index !== undefined) return index;
    const byAnyId = new Map<string, string>();
    const relationRows: Array<{ readonly source_id: string; readonly target_id: string; readonly relation_kind: string }> = [];
    const consume = (records: readonly CanonicalQueryRecord[]): void => {
      for (const record of records) {
        for (const id of [record.record_id, record.identity_id, record.identity_key, record.body["entity_id"], record.body["relation_id"]]) if (typeof id === "string") byAnyId.set(id, record.record_id);
        if (record.category === "relation" && typeof record.body["source_id"] === "string" && typeof record.body["target_id"] === "string") relationRows.push({ source_id: record.body["source_id"], target_id: record.body["target_id"], relation_kind: record.universal_kind });
      }
    };
    if (this.snapshots.records_for_query_batches !== undefined) {
      for await (const batch of this.snapshots.records_for_query_batches(scope)) consume(batch);
    } else {
      consume(this.snapshots.records_for_query !== undefined ? await this.snapshots.records_for_query(scope) : await this.snapshots.records(scope));
    }
    const pairs = new Map<string, Set<string>>();
    for (const relation of relationRows) {
      const sourceId = byAnyId.get(relation.source_id);
      const targetId = byAnyId.get(relation.target_id);
      if (sourceId === undefined || targetId === undefined) continue;
      const key = `${sourceId}\u0000${targetId}`;
      const kinds = pairs.get(key) ?? new Set<string>();
      kinds.add(relation.relation_kind);
      pairs.set(key, kinds);
    }
    index = { byAnyId, pairs };
    this.relationIndexCache.set(scopeKey, index);
    while (this.relationIndexCache.size > 4) this.relationIndexCache.delete(this.relationIndexCache.keys().next().value as string);
    return index;
  }

  /**
   * Indexed relation predicate for pipeline v3 joins.  The method resolves
   * only the two participating subjects and scans the relation slice, so a
   * join does not need to hydrate or compare the complete workspace in
   * JavaScript.  SQL-backed snapshot adapters can replace this with a direct
   * indexed implementation without changing the public contract.
   */
  readonly relation_exists = async (scope: QueryScope, left: QueryStreamItem, right: QueryStreamItem, relationSelector: unknown, direction: "inbound" | "outbound" | "both"): Promise<boolean> => {
    // Relation endpoints are separate records. Build one exact, immutable
    // endpoint index per snapshot scope and reuse it for every pair in a
    // pipeline join; the old fallback reloaded and rescanned the entire
    // relation corpus once per left/right pair (quadratic I/O).
    const index = await this.relationIndex(scope);
    const leftRecordId = index.byAnyId.get(subjectIdentity(left.value) ?? "");
    const rightRecordId = index.byAnyId.get(subjectIdentity(right.value) ?? "");
    if (leftRecordId === undefined || rightRecordId === undefined) return false;
    const selectorObject = object(relationSelector);
    const kinds = Array.isArray(selectorObject["universal_kinds"]) ? new Set(selectorObject["universal_kinds"].filter((value): value is string => typeof value === "string")) : new Set<string>();
    const hasKind = (key: string): boolean => {
      const available = index!.pairs.get(key);
      return available !== undefined && (kinds.size === 0 || [...available].some((kind) => kinds.has(kind)));
    };
    const outbound = hasKind(`${leftRecordId}\u0000${rightRecordId}`);
    const inbound = hasKind(`${rightRecordId}\u0000${leftRecordId}`);
    return direction === "outbound" ? outbound : direction === "inbound" ? inbound : outbound || inbound;
  };

  readonly relation_pairs = async (scope: QueryScope, left: readonly QueryStreamItem[], right: readonly QueryStreamItem[], relationSelector: unknown, direction: "inbound" | "outbound" | "both"): Promise<ReadonlySet<string>> => {
    const index = await this.relationIndex(scope);
    const selectorObject = object(relationSelector);
    const kinds = Array.isArray(selectorObject["universal_kinds"]) ? new Set(selectorObject["universal_kinds"].filter((value): value is string => typeof value === "string")) : new Set<string>();
    const leftIds = new Map(left.map((item) => [subjectIdentity(item.value) ?? "", item.stable_sort_key]));
    const rightIds = new Map(right.map((item) => [subjectIdentity(item.value) ?? "", item.stable_sort_key]));
    const output = new Set<string>();
    for (const [key, available] of index.pairs) {
      if (kinds.size > 0 && ![...available].some((kind) => kinds.has(kind))) continue;
      const [source, target] = key.split("\u0000");
      const add = (leftId: string | undefined, rightId: string | undefined) => {
        const leftKey = leftIds.get(leftId ?? ""); const rightKey = rightIds.get(rightId ?? "");
        if (leftKey !== undefined && rightKey !== undefined) output.add(`${leftKey}\u0000${rightKey}`);
      };
      if (direction === "outbound" || direction === "both") add(source, target);
      if (direction === "inbound" || direction === "both") add(target, source);
    }
    return output;
  };

  /** Handle-native variant used by large v3 pipelines. Only compact stable
   * keys are retained while the relational index is probed; full subject
   * payloads stay in the execution spool until the final operator hydrates
   * its page. */
  readonly relation_pairs_handles = async (scope: QueryScope, left: StageSetHandle, right: StageSetHandle, relationSelector: unknown, direction: "inbound" | "outbound" | "both"): Promise<ReadonlySet<string>> => {
    if (left.iterate === undefined || right.iterate === undefined) throw new EngineError("core:required_capability_unsupported", "The relational spool handle cannot be iterated for a batch join.");
    // Keep only the compact identity -> stable-key maps required to form the
    // join result. Payloads remain in the execution spool and are never
    // duplicated in a second left/right array (the old compatibility path did
    // exactly that and was the dominant memory spike for large joins).
    const leftIds = new Map<string, string>();
    const rightIds = new Map<string, string>();
    for await (const item of left.iterate()) for (const id of subjectIdentities(item.value)) leftIds.set(id, item.stable_sort_key);
    for await (const item of right.iterate()) for (const id of subjectIdentities(item.value)) rightIds.set(id, item.stable_sort_key);
    if (this.snapshots.relation_pairs_by_subject_ids !== undefined) {
      const ids = await this.snapshots.relation_pairs_by_subject_ids(scope, [...leftIds.keys()], [...rightIds.keys()], relationSelector, direction);
      if (ids === undefined) return this.relationPairsFromCachedIndex(scope, leftIds, rightIds, relationSelector, direction);
      const output = new Set<string>();
      for (const pair of ids) {
        const separator = pair.indexOf("\u0000");
        if (separator <= 0) continue;
        const leftKey = leftIds.get(pair.slice(0, separator));
        const rightKey = rightIds.get(pair.slice(separator + 1));
        if (leftKey !== undefined && rightKey !== undefined) output.add(`${leftKey}\u0000${rightKey}`);
      }
      return output;
    }
    const index = await this.relationIndex(scope);
    const selectorObject = object(relationSelector);
    const kinds = Array.isArray(selectorObject["universal_kinds"]) ? new Set(selectorObject["universal_kinds"].filter((value): value is string => typeof value === "string")) : new Set<string>();
    const output = new Set<string>();
    for (const [key, available] of index.pairs) {
      if (kinds.size > 0 && ![...available].some((kind) => kinds.has(kind))) continue;
      const [source, target] = key.split("\u0000");
      const add = (leftId: string | undefined, rightId: string | undefined) => {
        const leftKey = leftIds.get(leftId ?? ""); const rightKey = rightIds.get(rightId ?? "");
        if (leftKey !== undefined && rightKey !== undefined) output.add(`${leftKey}\u0000${rightKey}`);
      };
      if (direction === "outbound" || direction === "both") add(source, target);
      if (direction === "inbound" || direction === "both") add(target, source);
    }
    return output;
  };

  private async relationPairsFromCachedIndex(scope: QueryScope, leftIds: ReadonlyMap<string, string>, rightIds: ReadonlyMap<string, string>, relationSelector: unknown, direction: "inbound" | "outbound" | "both"): Promise<ReadonlySet<string>> {
    const index = await this.relationIndex(scope);
    const selectorObject = object(relationSelector);
    const kinds = Array.isArray(selectorObject["universal_kinds"]) ? new Set(selectorObject["universal_kinds"].filter((value): value is string => typeof value === "string")) : new Set<string>();
    const output = new Set<string>();
    for (const [key, available] of index.pairs) {
      if (kinds.size > 0 && ![...available].some((kind) => kinds.has(kind))) continue;
      const [source, target] = key.split("\u0000");
      const add = (leftId: string | undefined, rightId: string | undefined) => {
        const leftKey = leftIds.get(leftId ?? ""); const rightKey = rightIds.get(rightId ?? "");
        if (leftKey !== undefined && rightKey !== undefined) output.add(`${leftKey}\u0000${rightKey}`);
      };
      if (direction === "outbound" || direction === "both") add(source, target);
      if (direction === "inbound" || direction === "both") add(target, source);
    }
    return output;
  }

  /**
   * Pre-loads this scope's records and capability states (paying whatever a
   * cold `records()` call would cost -- full reload or delta, per
   * `SqliteCanonicalQuerySnapshotPort`'s own caching) and primes the
   * `identityMaps` memo for the resulting records array, so the first real
   * query against this scope after a daemon start or a fresh scan
   * publication hits warm caches instead of paying that cost inline. Errors
   * (a closed database, a workspace that vanished mid-warm, etc.) are not
   * swallowed here; callers that treat warming as best-effort must catch
   * around this call themselves.
   */
  async warm(scope: QueryScope): Promise<void> {
    // Query warm-up is metadata-only. Never materialize the record corpus at
    // startup: SQL pushdowns and bounded hydration are the query path.
    await this.snapshots.capability_states?.(scope);
  }

  /**
   * Bounded implementation of `core:build_context`. The former generic
   * fallback decoded the complete structural corpus and built global identity
   * maps even though no `build_context` branch existed afterward, then
   * returned an empty stream. On large workspaces that was both useless and
   * capable of exhausting the daemon's memory budget.
   *
   * Context discovery now starts from explicit seed selectors and exact
   * identifier-shaped task terms through the snapshot port's indexed point
   * lookups. This is deliberately conservative: prose-only tasks without a
   * semantic lane return an honest empty context, never a widened full-corpus
   * scan pretending to be relevance ranking. Agents can then use the normal
   * structural operations to expand any returned seed.
   */
  private async tryBuildContextPushdown(operation: OperationInvocation): Promise<OperationEvaluation | undefined> {
    if (operation.operation_id !== "core:build_context") return undefined;
    const args = object(operation.arguments);
    const task = String(args["task"] ?? "");
    const selectors = Array.isArray(args["seeds"]) ? args["seeds"] : [];
    const records: CanonicalQueryRecord[] = [];

    const directIds = selectors.map(subjectIdentity).filter((value): value is string => value !== undefined);
    if (directIds.length > 0 && this.snapshots.records_by_ids !== undefined) records.push(...await this.snapshots.records_by_ids(operation.scope, [...new Set(directIds)]));

    const seedNames = selectors.flatMap((selector) => {
      const value = object(selector);
      return value["subject_type"] === "symbol" && typeof value["name"] === "string" ? [value["name"]] : [];
    });
    const taskNames = contextIdentifierCandidates(task, args["query_class"]);
    if (this.snapshots.records_by_name !== undefined) {
      for (const name of [...new Set([...seedNames, ...taskNames])]) records.push(...await this.snapshots.records_by_name(operation.scope, name));
    }

    const unique = [...new Map(records.map((record) => [record.record_id, record])).values()];
    const filter = object(args["filter"]);
    const paths = strings(filter["paths"]);
    const languages = strings(filter["languages"]);
    let artifactPaths = new Map<string, string>();
    if (paths.length > 0 && this.snapshots.records_by_artifact_versions !== undefined) {
      const artifacts = await this.snapshots.records_by_artifact_versions(operation.scope, [...new Set(unique.map((record) => record.owner_artifact_version_id))]);
      artifactPaths = new Map(artifacts.map((record) => [record.owner_artifact_version_id, String(record.body["path"] ?? "")]));
    }
    const filtered = unique.filter((record) => {
      const path = typeof record.body["path"] === "string" ? record.body["path"] : artifactPaths.get(record.owner_artifact_version_id);
      if (paths.length > 0 && (path === undefined || !paths.some((pattern) => matchesArtifactGlob(path, pattern)))) return false;
      if (languages.length > 0 && !languages.includes(String(record.body["language"] ?? ""))) return false;
      return true;
    });

    let remainingSnippetBudget = 20_000;
    const context: QueryStreamItem[] = [];
    for (const record of filtered) {
      const snippet = await sourceSnippet(this.snapshots, operation.scope, record, "relevant", 2_000, 2, remainingSnippetBudget);
      if (snippet !== undefined) remainingSnippetBudget -= snippet.text.length;
      context.push({
        value: {
          result_set: "context",
          primary_result: recordValue(record),
          assessment: { classification: "confirmed", completeness: "complete" },
          provenance_path: [],
          essential_related_entities: [],
          optional_source_snippets: snippet === undefined ? [] : [snippet],
        },
        stable_sort_key: `confirmed\0${String(context.length).padStart(6, "0")}\0${record.identity_key ?? record.record_id}`,
      });
    }
    const capabilityStates = await this.snapshots.capability_states?.(operation.scope) ?? [];
    return result({ context }, capabilityStates);
  }

  /**
   * Cold-path pushdown: for the three operations that are fully answerable
   * from indexed SQLite columns without decoding the whole corpus
   * (`core:resolve_symbol`, `core:get_source`, and column-only
   * `core:find_records` selectors), tries to answer directly against the
   * snapshot port's optional `records_by_*` methods. Returns `undefined`
   * when the operation isn't one of these three, when the port doesn't
   * implement the needed method (non-SQLite ports simply don't have one),
   * or when `core:find_records`'s pushdown can't prove completeness (see
   * `FIND_RECORDS_PUSHDOWN_LIMIT`) -- in every `undefined` case the caller
   * falls back to the full in-memory path. Never touches `this.snapshots.records`,
   * so it can never trigger or wait on a full corpus load or delta, and never
   * writes into the corpus cache.
   */
  private async tryPushdown(operation: OperationInvocation): Promise<OperationEvaluation | undefined> {
    const args = object(operation.arguments);
    const graph = await this.tryGraphPushdown(operation);
    if (graph !== undefined) return graph;
    if (operation.operation_id === "core:resolve_symbol" && this.snapshots.records_by_name !== undefined) {
      const reference = String(args["reference"] ?? "");
      // A record's plain `name` never contains "." for any known producer,
      // while `qualified_name` always does (it is built as
      // `${parent.qualified_name ?? parent.name}.${name}`) -- so a
      // dotted `reference` can only resolve via a qualified_name match,
      // which `identity_key`'s tail (plain name only) cannot see. Fall back
      // to the full path rather than risk an incomplete pushdown answer.
      if (reference.includes(".")) return undefined;
      // A present `context_artifact` (narrowing by owner_artifact_id) or
      // `kind_selector` both need the full record set this pushdown does
      // not fetch -- fall back to the full in-memory path, which
      // implements them. `resolution_scope` alone never needs a bail-out:
      // absent a `context_artifact` to narrow by, `visible`/`exports`
      // degrade to exactly `workspace`'s unfiltered result (see the
      // in-memory handler below), so pushdown stays correct regardless of
      // which scope value is requested.
      if (args["context_artifact"] !== undefined || args["kind_selector"] !== undefined) return undefined;
      const rows = await this.snapshots.records_by_name(operation.scope, reference);
      // Mirrors the in-memory path's exact predicate (declarations are
      // entities whose `name` or `qualified_name` equals `reference`) as a
      // safety re-check over the name-tail-matched rows pushdown fetched;
      // `resolution_scope`/`context_artifact`/`kind_selector` are accepted
      // arguments the in-memory path itself does not filter on either.
      const declarations = rows.filter((record) => record.category === "entity" && (record.body["name"] === reference || record.body["qualified_name"] === reference));
      const capabilityStates = await this.snapshots.capability_states?.(operation.scope) ?? [];
      return result({ declarations: declarations.map((record) => item(record)), candidates: [] }, capabilityStates);
    }
    if (operation.operation_id === "core:get_source" && (this.snapshots.records_by_ids !== undefined || this.snapshots.records_by_name !== undefined)) {
      const selectors = Array.isArray(args["subjects"]) ? args["subjects"] : [];
      const directArtifactSelectors = selectors.filter((selector) => {
        const value = object(selector);
        return value["subject_type"] === "artifact" && typeof value["artifact_version_id"] !== "string";
      });
      // Direct artifact_id/path selectors are source-catalog identities, not
      // structural record identities. Resolve them against the bounded
      // artifact catalog rather than falling back to records_for_query(),
      // which decodes the complete structural corpus on large workspaces.
      if (directArtifactSelectors.length > 0 && this.snapshots.artifacts_by_filter === undefined) return undefined;
      const artifactCatalog = directArtifactSelectors.length === 0
        ? []
        : await this.snapshots.artifacts_by_filter!(operation.scope, { include_generated: true, include_external: true });
      const directArtifactRecords = directArtifactSelectors.flatMap((selectorValue) => {
        const selector = object(selectorValue);
        return artifactCatalog.filter((record) =>
          (typeof selector["artifact_id"] !== "string" || record.owner_artifact_id === selector["artifact_id"])
          && (typeof selector["path"] !== "string" || record.body["path"] === selector["path"]));
      });
      const ids = selectors.map(subjectIdentity).filter((value): value is string => value !== undefined);
      const symbolNames = selectors.flatMap((selector) => {
        const value = object(selector);
        return value["subject_type"] === "symbol" && typeof value["name"] === "string" ? [value["name"]] : [];
      });
      if (selectors.some((selector) => object(selector)["subject_type"] === "symbol") && this.snapshots.records_by_name === undefined) return undefined;
      const directRows = this.snapshots.records_by_ids === undefined || ids.length === 0 ? [] : await this.snapshots.records_by_ids(operation.scope, ids);
      const namedRows = this.snapshots.records_by_name === undefined ? [] : (await Promise.all([...new Set(symbolNames)].map((name) => this.snapshots.records_by_name!(operation.scope, name)))).flat();
      const rows = [...new Map([...directRows, ...namedRows].map((record) => [record.record_id, record])).values()];
      const byAnyId = new Map<string, CanonicalQueryRecord>();
      for (const record of rows) for (const id of [record.record_id, record.identity_id, record.identity_key]) if (id !== undefined) byAnyId.set(id, record);
      const maps = await identityMaps(rows);
      const subjects = selectors.flatMap((selector) => {
        const value = object(selector);
        if (value["subject_type"] !== "artifact" || typeof value["artifact_version_id"] === "string") return resolveSelectorToRecords(selector, maps);
        return directArtifactRecords.filter((record) =>
          (typeof value["artifact_id"] !== "string" || record.owner_artifact_id === value["artifact_id"])
          && (typeof value["path"] !== "string" || record.body["path"] === value["path"]));
      });
      const hydratedArtifacts = await hydrateArtifactSelectorRecords(this.snapshots, operation.scope, selectors, subjects);
      const capabilityStates = await this.snapshots.capability_states?.(operation.scope) ?? [];
      const resolved = [...new Map([...subjects, ...hydratedArtifacts].map((record) => [record.record_id, record])).values()];
      return result(await buildGetSourceStreams(this.snapshots, operation.scope, resolved, args), capabilityStates);
    }
    if (operation.operation_id === "core:find_records" && this.snapshots.records_by_selector !== undefined) {
      const selectorArg = object(args["selector"]);
      const categories = strings(selectorArg["record_categories"]);
      const kindSelector = object(selectorArg["kind_selector"]);
      const universalKinds = strings(kindSelector["universal_kinds"]);
      const kinds = strings(kindSelector["kinds"]);
      const rows = await this.snapshots.records_by_selector(operation.scope, { categories, universal_kinds: universalKinds, kinds }, FIND_RECORDS_PUSHDOWN_LIMIT + 1);
      if (rows.length > FIND_RECORDS_PUSHDOWN_LIMIT) return undefined;
      // Re-applies the full in-memory `selected()` predicate (category/kind
      // redundantly, plus `filter.languages`, which lives in the decoded
      // body and has no column of its own) over the pushdown-fetched rows.
      const capabilityStates = await this.snapshots.capability_states?.(operation.scope) ?? [];
      return result({ records: rows.filter((record) => selected(record, selectorArg)).map((record) => item(record)) }, capabilityStates);
    }
    return undefined;
  }

  /**
   * D6: `core:search_text` lexical pushdown, tried BEFORE the corpus load in
   * the same early-pushdown spot `tryPushdown` uses for its three operations
   * -- but, unlike `tryPushdown`, tried unconditionally in `execute` below,
   * even when the in-memory corpus is already warm. That is deliberate, not
   * an oversight: the corpus scan only ever matches against *record body
   * JSON* (symbol metadata), while this pushdown searches the artifacts'
   * *real file text* via the trigram index -- the lexical answer is the
   * semantically correct one regardless of whether the corpus happens to be
   * cheap to use right now.
   *
   * Eligible only when the port implements both `search_literal` and
   * `records_by_artifact_versions`, and the request's arguments are ones the
   * lexical index can answer: `syntax` absent or `"literal"` (never
   * `"safe_regex"`), `word_mode` absent/falsy (only plain substring search),
   * and `filter` absent, empty, or limited to paths plus the generated and
   * external inclusion flags emitted by the normalized public contract.
   * Literal `word_mode` boundaries and path globs are enforced by the lexical
   * provider before candidate caps. Returns `undefined` -- meaning "fall back
   * to the full in-memory path, byte-for-byte identical to before this
   * change" -- when ineligible, or when `search_literal` itself returns
   * `undefined` (lexical projection not yet complete for this generation).
   */
  private async trySearchTextPushdown(operation: OperationInvocation): Promise<OperationEvaluation | undefined> {
    if (operation.operation_id !== "core:search_text" || this.snapshots.search_literal === undefined || this.snapshots.records_by_artifact_versions === undefined) return undefined;
    const args = object(operation.arguments);
    const syntax = args["syntax"];
    if (syntax !== undefined && syntax !== "literal") return undefined;
    const wordMode = args["word_mode"] === "identifier" || args["word_mode"] === "token" ? args["word_mode"] : "substring";
    const filterArg = args["filter"];
    const filter = object(filterArg);
    const filterKeys = Object.keys(filter);
    if (filterKeys.some((key) => key !== "paths" && key !== "include_generated" && key !== "include_external")) return undefined;
    const pathPatterns = strings(filter["paths"]);
    const pattern = String(args["pattern"] ?? "");
    const caseSensitive = args["case_sensitive"] !== false;

    const matches = await this.snapshots.search_literal(operation.scope, pattern, {
      case_sensitive: caseSensitive,
      word_mode: wordMode,
      path_patterns: pathPatterns,
      include_generated: filter["include_generated"] === true,
      include_external: filter["include_external"] === true,
    });
    if (matches === undefined) return undefined;

    const cappedArtifacts = matches.slice(0, SEARCH_TEXT_PUSHDOWN_ARTIFACT_CAP);
    let offsetBudget = SEARCH_TEXT_PUSHDOWN_OFFSET_CAP;
    const boundedMatches = cappedArtifacts
      .map((match) => {
        const offsets = match.offsets.slice(0, Math.max(0, offsetBudget));
        offsetBudget -= offsets.length;
        return { ...match, offsets, line_spans: match.line_spans?.slice(0, offsets.length) };
      })
      .filter((match) => match.offsets.length > 0);

    const versionIds = [...new Set(boundedMatches.map((match) => match.artifact_version_id))];
    const records = await this.snapshots.records_by_artifact_versions(operation.scope, versionIds);
    const byVersionId = new Map(records.map((record) => [record.owner_artifact_version_id, record]));

    const matchItems: QueryStreamItem[] = [];
    const subjectItems: QueryStreamItem[] = [];
    for (const match of boundedMatches) {
      const record = byVersionId.get(match.artifact_version_id);
      if (record === undefined) continue;
      const recordIdentity = record.identity_key ?? record.record_id;
      const recordBody = recordValue(record);
      for (const [offsetIndex, offset] of match.offsets.entries()) {
        const start = offset;
        const end = offset + pattern.length;
        const lineSpan = match.line_spans?.[offsetIndex];
        matchItems.push({
          value: { ...recordBody, source_span: { artifact_version_id: match.artifact_version_id, start_byte: String(start), end_byte: String(end), ...(lineSpan ?? {}) } },
          // Zero-padded so lexicographic (string) ordering agrees with numeric
          // offset ordering within one artifact -- offsets never exceed a
          // realistic file's byte length, so 12 digits is comfortably wide.
          stable_sort_key: `confirmed\0${recordIdentity}\0${String(start).padStart(12, "0")}`,
        });
      }
      const firstOffset = match.offsets[0];
      const firstLineSpan = match.line_spans?.[0];
      subjectItems.push({
        value: {
          ...recordBody,
          match_count: match.offsets.length,
          ...(firstOffset === undefined ? {} : {
            source_span: {
              artifact_version_id: match.artifact_version_id,
              start_byte: String(firstOffset),
              end_byte: String(firstOffset + pattern.length),
              ...(firstLineSpan ?? {}),
            },
          }),
        },
        stable_sort_key: `confirmed\0${recordIdentity}`,
      });
    }
    const capabilityStates = await this.snapshots.capability_states?.(operation.scope) ?? [];
    return result({ matches: matchItems, subjects: subjectItems }, capabilityStates);
  }

  /** Hydrates `path` (the same `body.path` field `records_by_artifact_versions` synthesizes) for every id in `versionIds`, for the `paths` structural filter. Returns an empty map when the port has no `records_by_artifact_versions` (paths filtering degrades to "nothing matches" via `matchesPathPrefix`'s `undefined`-path case, never to "everything matches"). */
  private async hydratePaths(scope: QueryScope, versionIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (this.snapshots.records_by_artifact_versions === undefined || versionIds.length === 0) return new Map();
    const records = await this.snapshots.records_by_artifact_versions(scope, versionIds);
    return new Map(records.map((record) => [record.owner_artifact_version_id, String(record.body["path"] ?? "")]));
  }

  /**
   * `provider.binding.generateVector({purpose: "query", ...})`, translating
   * any thrown error into the registered `core:query_embedding_failed`
   * detail shape. The local hash provider (`semantic-provider.ts`) throws
   * specifically when a text has no extractable tokens (all-zero
   * accumulation) -- an empty `query_text`, or one made entirely of
   * punctuation/whitespace, hits exactly this path -- so `failure_code`
   * distinguishes that case from a generic provider error via a simple
   * message sniff; there is no structured error taxonomy to key off instead
   * (`SemanticRuntimeBinding.generateVector` only ever throws a plain `Error`).
   */
  private async embedQuery(provider: ResolvedSemanticProvider, operation: OperationInvocation, queryText: string): Promise<{ readonly vector: Uint8Array }> {
    try {
      return await provider.binding.generateVector({ profile: provider.profile, purpose: "query", text: queryText });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SemanticQueryError("core:query_embedding_failed", `Failed to embed the query text for "${operation.operation_id}": ${message}`, {
        semantic_lane_id: "semantic",
        embedding_profile_id: provider.profile.embedding_profile_id,
        failure_code: /token/i.test(message) ? "empty_or_untokenizable_query_text" : "embedding_provider_error",
      });
    }
  }

  /**
   * The `core:search_hybrid` lexical lane, ranked (match count desc, then
   * `artifact_version_id` asc for a stable tie-break) and capped at
   * `SEMANTIC_CANDIDATE_CAP` -- structural filters apply BEFORE that cap,
   * same discipline as the semantic lane. Returns `undefined` exactly when
   * `search_literal` does (lexical index not current for this generation),
   * which callers must treat as "no lexical lane" (semantic-only), never as
   * "lexical lane found nothing" (that case returns `[]`, distinguishable by
   * design -- `artifactSubjectsExcluded` short-circuits to `[]` for the same
   * reason: a filter that excludes every candidate is a valid, complete
   * answer, not a degraded one).
   */
  private async rankedLexicalMatches(operation: OperationInvocation, queryText: string, pathPrefixes: readonly string[], artifactSubjectsExcluded: boolean): Promise<readonly { readonly artifact_version_id: string; readonly rank: number }[] | undefined> {
    if (artifactSubjectsExcluded) return [];
    if (this.snapshots.search_literal === undefined) return undefined;
    const matches = await this.snapshots.search_literal(operation.scope, queryText, { case_sensitive: false, word_mode: "substring", path_patterns: pathPrefixes });
    if (matches === undefined) return undefined;
    let filtered = matches;
    if (pathPrefixes.length > 0) {
      const paths = await this.hydratePaths(operation.scope, matches.map((match) => match.artifact_version_id));
      filtered = matches.filter((match) => matchesPathPrefix(paths.get(match.artifact_version_id), pathPrefixes));
    }
    const sorted = [...filtered].sort((left, right) => right.offsets.length - left.offsets.length || left.artifact_version_id.localeCompare(right.artifact_version_id));
    return sorted.slice(0, SEMANTIC_CANDIDATE_CAP).map((match, index) => ({ artifact_version_id: match.artifact_version_id, rank: index + 1 }));
  }

  /**
   * Hydrates `rankedEntries` (in order) into candidate stream items --
   * artifact entries via `records_by_artifact_versions` (keyed by
   * `owner_artifact_version_id`, as before decision 17), entity entries
   * (decision 17) via `records_by_ids` (keyed by `record_id` -- an entity
   * candidate's fused id IS its owning record's `record_id`, see
   * `SemanticVectorRow.document_ref`'s own doc comment) -- dropping any id
   * that fails to hydrate (should not happen in practice -- every id came
   * from a vector or lexical row visible moments ago -- but a dropped id
   * must never silently shift another candidate into its rank slot, hence
   * recomputing `rank` from the OUTPUT position, not reusing the input
   * index).
   */
  private async hydrateSemanticCandidates(scope: QueryScope, rankedEntries: readonly { readonly id: string; readonly grain: "artifact" | "entity" }[], matchedSegmentsByDocumentRef?: ReadonlyMap<string, { readonly index: number; readonly start_char: number; readonly end_char: number }>): Promise<readonly QueryStreamItem[]> {
    const artifactIds = rankedEntries.filter((entry) => entry.grain === "artifact").map((entry) => entry.id);
    const entityIds = rankedEntries.filter((entry) => entry.grain === "entity").map((entry) => entry.id);
    const hydratedArtifacts = await this.snapshots.records_by_artifact_versions?.(scope, artifactIds) ?? [];
    // `records_by_ids` is only ever called when there is at least one entity
    // id to resolve -- keeps a plain artifact-only search (every corpus
    // before decision 17, and every corpus without entity vectors yet) from
    // ever touching a port method it does not need, same discipline
    // `hydratePaths` already applies to `records_by_artifact_versions`.
    const hydratedEntities = entityIds.length > 0 ? await this.snapshots.records_by_ids?.(scope, entityIds) ?? [] : [];
    const byVersionId = new Map(hydratedArtifacts.map((record) => [record.owner_artifact_version_id, record]));
    const byRecordId = new Map(hydratedEntities.map((record) => [record.record_id, record]));
    const items: QueryStreamItem[] = [];
    // Plan 2026-09-06 (Frente N, SNIPPET_POLICY): "line" over
    // `semantic_evidence.matched_segment.start_char` once Frente S-B
    // populates it on `rankedEntries`, else "signature" -- `rankedEntries`
    // carries no segment offset in this worktree (S-B not merged here), so
    // this always takes the "signature" branch today.
    let remainingCandidateSnippetBudget = INLINE_SNIPPET_TOTAL_BUDGET;
    for (const entry of rankedEntries) {
      const record = entry.grain === "entity" ? byRecordId.get(entry.id) : byVersionId.get(entry.id);
      if (record === undefined) continue;
      const matchedSegment = entry.grain === "entity" ? matchedSegmentsByDocumentRef?.get(entry.id) : undefined;
      const snippet = await sourceSnippet(this.snapshots, scope, record, "signature", INLINE_SNIPPET_MAX_CHARS_PER_SNIPPET, 0, remainingCandidateSnippetBudget);
      if (snippet !== undefined) remainingCandidateSnippetBudget -= snippet.text.length;
      items.push(semanticCandidateItem(record, items.length + 1, snippet, matchedSegment));
    }
    return items;
  }

  /**
   * `core:search_semantic` / `core:search_hybrid`, tried in `execute` right
   * after `trySearchTextPushdown` -- BEFORE the warm check and `records()`
   * corpus load, per the pinned spec: these two operations must never pay
   * corpus-load cost, since v1's whole answer comes from
   * `semantic_vectors`/`records_by_artifact_versions` (and, for hybrid,
   * `search_literal`), none of which touch the in-memory corpus. Returns
   * `undefined` only when `operation.operation_id` is neither of the two --
   * every matched call is fully handled here (a thrown error, or a complete
   * evaluation), never falls through to the corpus path.
   *
   * Filter handling (`filter.languages`/`filter.namespaces`/`filter.kind_selector`):
   * v1's semantic lane has no structural projection to filter those against
   * (no per-language/namespace/kind index over vectors) -- rather than
   * silently ignoring a hard filter the caller explicitly asked for (which
   * would silently WIDEN the result the caller believes is narrowed), a
   * non-empty value for any of the three throws the closest registered
   * operation error, `core:required_capability_unsupported` (the "unsupported
   * capability" reading fits better than, say, `core:option_conflict`, which
   * registries.ts pins to mutually-exclusive OPTIONS rather than an
   * unsupported hard constraint). `paths` and `subject_types` -- the two
   * filters `StructuralFilter` defines that v1 CAN honor exactly -- are
   * applied BEFORE `SEMANTIC_CANDIDATE_CAP`, so a filtered query is exact
   * even though an unfiltered one is capped.
   *
   * `require_structural_subject`: read but never branched on. Every subject
   * this port can ever produce is a `category: "artifact"` record hydrated
   * straight from a real `artifact_versions`/`source_artifacts` row (see
   * `records_by_artifact_versions`'s own doc comment) -- i.e. already exactly
   * the "structural artifact occurrence" `require_structural_subject: true`
   * asks for. There is no non-structural (speculative/synthesized-without-a-
   * real-row) subject kind in v1 for this flag to exclude, so honoring it is
   * a no-op by construction, not an oversight.
   */
  private async trySemanticSearch(operation: OperationInvocation): Promise<OperationEvaluation | undefined> {
    if (operation.operation_id !== "core:search_semantic" && operation.operation_id !== "core:search_hybrid") return undefined;
    const isHybrid = operation.operation_id === "core:search_hybrid";
    const workspaceScope = requireSingleWorkspaceScope(operation.scope);
    const args = object(operation.arguments);
    const queryText = String(args["query_text"] ?? "");
    const filterArg = object(args["filter"]);

    const languages = strings(filterArg["languages"]);
    const namespaces = strings(filterArg["namespaces"]);
    const kindSelectorArg = object(filterArg["kind_selector"]);
    if (languages.length > 0 || namespaces.length > 0 || Object.keys(kindSelectorArg).length > 0) {
      throw new SemanticQueryError(
        "core:required_capability_unsupported",
        `${operation.operation_id}'s vector lane has no per-language/namespace/kind structural projection to filter against -- v1 semantic search only honors "paths" and "subject_types" as hard filters. Narrow the request to those, or drop this filter and post-filter the returned candidates.`,
        { capability: "core:semantic_structural_filter", workspace_snapshot_binding_ids: [workspaceScope.workspace_id], reason_codes: ["unsupported_structural_filter_for_semantic_lane"] },
      );
    }
    const pathPrefixes = strings(filterArg["paths"]);
    const subjectTypes = strings(filterArg["subject_types"]);
    // Decision 17: `subject_types` now discriminates BETWEEN the two grains
    // -- includes `"artifact"` (or is empty/absent) => artifact lane
    // scanned; includes `"entity"` (or is empty/absent) => entity lane
    // scanned. `includeArtifactLane`/`includeEntityLane` replace the old
    // single `artifactSubjectsExcluded` flag this port used before entity
    // candidates existed. An unfiltered request (the common case, and every
    // pre-decision-17 caller) gets both `true`, preserving the exact
    // artifact-only behavior those callers already depend on whenever no
    // entity vectors happen to exist yet.
    const includeArtifactLane = subjectTypes.length === 0 || subjectTypes.includes("artifact");
    const includeEntityLane = subjectTypes.length === 0 || subjectTypes.includes("entity");

    const provider = this.options.semantic;
    const portReady = this.snapshots.semantic_index_state !== undefined && this.snapshots.semantic_vectors !== undefined && this.snapshots.semantic_scope_counts !== undefined;
    // Latency (2026-09-07, Frente S-C): these seven snapshot-port reads are
    // mutually independent (none consumes another's RESULT -- `semantic_vectors`
    // only ever gated the original sequential code on whether a marker
    // exists at all, never on the marker's VALUE, and `semantic_vectors`
    // resolves its own current generation internally, exactly like
    // `semantic_index_state` does) -- so they are fired together and
    // awaited once, instead of one at a time. Measured live against a real
    // daemon with the neural provider (a workspace database served through
    // the SQLite worker-thread adapter): the original sequential form paid
    // one worker-thread IPC round trip PER call, back to back, dominating
    // `core:search_semantic`'s own ~300ms p50/p99 (query embedding itself,
    // separately measured against the SAME persistent neural host, costs
    // ~1-2ms -- the model was already resident/warm, never the bottleneck
    // this task's own brief speculated it might be). `semantic_vectors` is
    // fetched unconditionally now (previously skipped when no marker existed
    // yet) -- a one-time, harmless extra read on a workspace whose semantic
    // index has never initialized at all; every other branch's result is
    // unchanged, and the "unused-when-marker-is-undefined" result is
    // dropped exactly as before via `allVectors` below.
    const [capabilityStates, marker, allVectorsRaw, counts, entityCounts, realCounts, affectedRows] = await Promise.all([
      this.snapshots.capability_states?.(operation.scope) ?? Promise.resolve([]),
      portReady ? this.snapshots.semantic_index_state!(operation.scope) : Promise.resolve(undefined),
      portReady && provider !== undefined
        ? this.snapshots.semantic_vectors!(operation.scope, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest)
        : Promise.resolve([]),
      portReady ? this.snapshots.semantic_scope_counts!(operation.scope, SEMANTIC_MAX_DOCUMENT_BYTES) : Promise.resolve({ artifact_count: 0, oversized_count: 0 }),
      this.snapshots.semantic_entity_scope_counts !== undefined ? this.snapshots.semantic_entity_scope_counts(operation.scope) : Promise.resolve({ entity_count: 0 }),
      // Plan 2026-09-06 (Frente S-A): real status-table counts and the
      // embedded first affected page, computed ONCE for whichever coverage
      // view this call ends up returning (the unavailable/hybrid-degrade
      // branch below, or the normal ranked-result branch further down) --
      // both share the exact same real-coverage inputs. `undefined` whenever
      // there is no resolved provider (nothing to key the status table by)
      // or the port lacks the new capability, preserving the pre-existing
      // inferred/`0` fields exactly.
      provider !== undefined && this.snapshots.semantic_document_status_counts !== undefined
        ? this.snapshots.semantic_document_status_counts(operation.scope, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest)
        : Promise.resolve(undefined),
      provider !== undefined && this.snapshots.semantic_affected_documents !== undefined
        ? this.snapshots.semantic_affected_documents(operation.scope, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest)
        : Promise.resolve(undefined),
    ]);
    const isCurrent = isSemanticMarkerCurrent(marker, provider);
    const allVectors = marker !== undefined ? allVectorsRaw : [];
    // Decision 17: an entity-grain row must NEVER enter `dedupeVectorsByOwner`
    // (many legitimately share one `owner_artifact_version_id` -- every
    // eligible entity in one file) -- so the combined `allVectors` list is
    // split by grain FIRST, and each half deduplicated by its own correct
    // key (`dedupeVectorsByDocumentRef` for entity rows).
    const dedupedVectors = dedupeVectorsByOwner(allVectors.filter((vector) => vector.document_grain !== "entity"));
    const dedupedEntityVectors = dedupeVectorsByDocumentRef(allVectors.filter((vector) => vector.document_grain === "entity"));
    const affectedPage = provider !== undefined && affectedRows !== undefined
      ? buildAffectedArtifactPage(affectedRows, {
          setId: computeAffectedSetId(affectedRows, {
            bindingId: digestOf({ profile_id: provider.profile.embedding_profile_id, executable_binding_id: provider.binding.executable_binding_digest }),
            generation: marker?.generation ?? 0, profileId: provider.profile.embedding_profile_id, executableBindingId: provider.binding.executable_binding_digest,
          }),
          // Plan §4.2: `limit = min(response_budget.max_items, 20)`. Decided
          // in implementation: `response_budget` does not reach this port
          // layer (it is resolved above the canonical query engine, in the
          // MCP/query-execution shedding path) -- the plan's own stated
          // upper bound (20) is used directly, which equals the min() result
          // for every default-or-larger budget (`DEFAULT_RESPONSE_BUDGET.max_items`
          // is 50), and is never wider than the plan's ceiling for a smaller
          // one either.
          limit: SEMANTIC_AFFECTED_FIRST_PAGE_LIMIT,
        })
      : undefined;

    // `allVectors.length === 0` (not `dedupedVectors.length === 0`, its v1
    // pre-decision-17 form) so a workspace with ONLY entity vectors and no
    // artifact vectors is not mistaken for unavailable.
    const indexUnavailable = provider === undefined || !portReady || (allVectors.length === 0 && !isCurrent);

    if (indexUnavailable) {
      if (!isHybrid) {
        throw new SemanticQueryError(
          "core:semantic_index_unavailable",
          `No semantic index is available to answer core:search_semantic for workspace "${workspaceScope.workspace_id}".`,
          {
            semantic_lane_id: "semantic",
            embedding_profile_id: provider?.profile.embedding_profile_id ?? "core:no-provider-configured",
            workspace_snapshot_binding_ids: [workspaceScope.workspace_id],
            unavailability_reason: provider === undefined ? "no_provider_configured" : !portReady ? "snapshot_port_unsupported" : "not_yet_materialized",
          },
        );
      }
      // Hybrid has no corpus fallback either, but it DOES have a second
      // lane: degrade to lexical-only rather than failing the whole request.
      // Lexical-only degrade stays artifact-grain-only -- decision 17 gives
      // the lexical lane no entity-shaped candidate source.
      const lexicalRanked = await this.rankedLexicalMatches(operation, queryText, pathPrefixes, !includeArtifactLane);
      const ranked = lexicalRanked ?? [];
      const candidates = await this.hydrateSemanticCandidates(operation.scope, ranked.map((match) => ({ id: match.artifact_version_id, grain: "artifact" as const })));
      const coverage = buildSemanticCoverageView({ provider, marker, isCurrent: false, counts, coveredCount: 0, indexSupported: false, entityCount: entityCounts.entity_count, coveredEntityCount: 0, realCounts, affectedPage });
      return result({ candidates, semantic_coverage: [coverageItem(coverage)] }, capabilityStates, semanticEvaluationState(coverage.materialization_state));
    }

    // Index IS available past this point: `provider` and every `semantic_*`
    // port method are defined, and either the marker is current or there is
    // at least one visible vector (either grain) under this exact provider
    // identity.
    let artifactVectorsForScan = includeArtifactLane ? dedupedVectors : [];
    if (includeArtifactLane && pathPrefixes.length > 0) {
      const paths = await this.hydratePaths(operation.scope, artifactVectorsForScan.map((vector) => vector.owner_artifact_version_id));
      artifactVectorsForScan = artifactVectorsForScan.filter((vector) => matchesPathPrefix(paths.get(vector.owner_artifact_version_id), pathPrefixes));
    }
    // Decision 17: `paths` applies to entity rows via their OWNER artifact
    // version's path -- `hydratePaths` resolves that from
    // `records_by_artifact_versions` exactly as it does for artifact rows;
    // an entity vector's `owner_artifact_version_id` names the file it
    // currently belongs to (whether or not that's the SAME version that
    // originally produced it -- see the reconciler's own step 4/5 doc
    // comments on why a reused record can outlive its original owner).
    // Frente S-B (decision 17 segmentation): the RAW, un-deduplicated set of
    // every visible entity-grain SEGMENT row -- NOT `dedupedEntityVectors`
    // (which keeps only the FIRST-occurrence segment per `document_ref`,
    // fine for a coverage COUNT but wrong for ranking: the winning segment
    // for a query is whichever one scores highest, not whichever happened
    // to sort first). `aggregateEntityRanksByMaxSimilarity` below does the
    // real per-document reduction, AFTER scoring every segment.
    let entityVectorsForScan = includeEntityLane ? allVectors.filter((vector) => vector.document_grain === "entity") : [];
    if (includeEntityLane && pathPrefixes.length > 0) {
      const paths = await this.hydratePaths(operation.scope, entityVectorsForScan.map((vector) => vector.owner_artifact_version_id));
      entityVectorsForScan = entityVectorsForScan.filter((vector) => matchesPathPrefix(paths.get(vector.owner_artifact_version_id), pathPrefixes));
    }

    const queryVector = await this.embedQuery(provider!, operation, queryText);
    // Re-keyed to `owner_artifact_version_id` rather than the vector's own
    // `projection_record_id`: v1 writes exactly one (deduplicated) artifact
    // vector per owner, so this is a lossless bijection, and it gives the
    // artifact lane the SAME fusion key the lexical lane (`search_literal`,
    // artifact-version-keyed by construction) already uses -- `fuseSemanticLanes`
    // matches lanes by this id, so both lanes must agree on what it means.
    const semanticRanks = exactVectorScan(
      artifactVectorsForScan.map((vector) => ({ projection_record_id: vector.owner_artifact_version_id, profile_id: provider!.profile.embedding_profile_id, executable_binding_id: provider!.binding.executable_binding_digest, vector: vector.vector_payload })),
      queryVector.vector,
      { profile_id: provider!.profile.embedding_profile_id, executable_binding_id: provider!.binding.executable_binding_digest, dimensions: provider!.profile.dimensions, element_type: provider!.profile.element_type as "float32" | "float64", distance_metric: "cosine", normalization: provider!.profile.normalization as "none" | "l2", limit: SEMANTIC_CANDIDATE_CAP },
    );
    // Frente S-B (decision 17 segmentation): the entity lane's OWN exact-scan
    // runs over EVERY visible SEGMENT row, keyed by its own unique
    // `projection_record_id` (never `document_ref` -- a multi-segment entity
    // now has SEVERAL rows sharing one `document_ref`, so keying the scan by
    // `document_ref` would violate `exactVectorScan`'s own "candidate
    // identifiers must be unique" invariant the instant a document has 2+
    // segments). Deliberately UNCAPPED here (no `limit`) -- the cap
    // (`SEMANTIC_ENTITY_CANDIDATE_CAP`) applies to the AGGREGATED,
    // one-per-document result below, not to the raw per-segment scan.
    const entitySegmentRanks = exactVectorScan(
      entityVectorsForScan.map((vector) => ({ projection_record_id: vector.projection_record_id, profile_id: provider!.profile.embedding_profile_id, executable_binding_id: provider!.binding.executable_binding_digest, vector: vector.vector_payload })),
      queryVector.vector,
      { profile_id: provider!.profile.embedding_profile_id, executable_binding_id: provider!.binding.executable_binding_digest, dimensions: provider!.profile.dimensions, element_type: provider!.profile.element_type as "float32" | "float64", distance_metric: "cosine", normalization: provider!.profile.normalization as "none" | "l2" },
    );
    // Reduces the per-segment ranking above to ONE row per `document_ref`,
    // keeping the HIGHEST-similarity (best-ranked) segment for each --
    // `exactVectorScan`'s own result is already sorted best-first, so a
    // plain "first occurrence per document_ref, in rank order" walk IS the
    // max-similarity reduction; no separate similarity comparison needed
    // here. Capped at `SEMANTIC_ENTITY_CANDIDATE_CAP` DISTINCT documents
    // (plan §4.5: "cap 100 tras agregar"), and remembers each winning
    // document's own matched segment (`matched_segment`) for
    // `hydrateSemanticCandidates` to attach as evidence.
    const entityVectorByProjectionId = new Map(entityVectorsForScan.map((vector) => [vector.projection_record_id, vector]));
    const seenEntityDocuments = new Set<string>();
    const entityRanks: RankedSemanticCandidate[] = [];
    const matchedSegmentByDocumentRef = new Map<string, { readonly index: number; readonly start_char: number; readonly end_char: number }>();
    for (const match of entitySegmentRanks) {
      if (entityRanks.length >= SEMANTIC_ENTITY_CANDIDATE_CAP) break;
      const vector = entityVectorByProjectionId.get(match.projection_record_id);
      const documentRef = vector?.document_ref;
      if (vector === undefined || documentRef === undefined || seenEntityDocuments.has(documentRef)) continue;
      seenEntityDocuments.add(documentRef);
      entityRanks.push({ projection_record_id: documentRef, rank: entityRanks.length + 1 });
      if (vector.segment_start !== undefined && vector.segment_end !== undefined) matchedSegmentByDocumentRef.set(documentRef, { index: vector.segment_index, start_char: vector.segment_start, end_char: vector.segment_end });
    }

    // Grain lookup for the FUSED ranked ids below -- artifact ids
    // (`owner_artifact_version_id`) and entity ids (`record_id`) are
    // distinct id spaces by construction (decision 11's content-derived
    // record ids never collide with an artifact-version id), so one flat
    // map keyed by the fused id string is unambiguous.
    const grainById = new Map<string, "artifact" | "entity">();
    for (const rank of semanticRanks) grainById.set(rank.projection_record_id, "artifact");
    for (const rank of entityRanks) grainById.set(rank.projection_record_id, "entity");

    // Decision 17: BOTH grains feed the result stream even for plain
    // `core:search_semantic` -- the pinned spec's own words, "artifact and
    // entity lanes both feed the result stream" -- via the SAME
    // `fuseSemanticLanes`/`rerankSemanticMatches` RRF machinery hybrid
    // already used, rather than a separate code path. With only one
    // non-empty lane (every workspace before entity vectors exist, and every
    // request that filters `subject_types` down to one grain), RRF over a
    // single lane's own strictly-decreasing-by-rank scores reproduces that
    // lane's own rank order exactly (no ties are possible among unique
    // positive integer ranks) -- so this is behaviorally IDENTICAL to the
    // old "use `semanticRanks` directly, skip fusion" path whenever
    // `entityRanks` is empty, not merely similar to it.
    const lanes: { readonly lane_id: string; readonly candidates: readonly { readonly projection_record_id: string; readonly rank: number }[] }[] = [
      { lane_id: "semantic", candidates: semanticRanks },
      { lane_id: "semantic-entity", candidates: entityRanks },
    ];
    if (isHybrid) {
      const lexicalRanked = await this.rankedLexicalMatches(operation, queryText, pathPrefixes, !includeArtifactLane);
      // `undefined` here means the LEXICAL lane specifically is stale/missing
      // -- the semantic lanes just proved themselves available above -- so
      // hybrid degrades to semantic-only (both grains) for this call, not to
      // full unavailability.
      if (lexicalRanked !== undefined) {
        for (const match of lexicalRanked) if (!grainById.has(match.artifact_version_id)) grainById.set(match.artifact_version_id, "artifact");
        lanes.push({ lane_id: "lexical", candidates: lexicalRanked.map((match) => ({ projection_record_id: match.artifact_version_id, rank: match.rank })) });
      }
    }
    const fused = fuseSemanticLanes(lanes);
    const finalRanked = rerankSemanticMatches(fused);

    const candidates = await this.hydrateSemanticCandidates(operation.scope, finalRanked.map((entry) => ({ id: entry.projection_record_id, grain: grainById.get(entry.projection_record_id) ?? "artifact" })), matchedSegmentByDocumentRef);
    // Coverage counts come from `semantic_scope_counts`/`semantic_entity_scope_counts`
    // + `dedupedVectors`/`dedupedEntityVectors` (the FULL, unfiltered,
    // uncapped visible-vector sets) -- never from
    // `artifactVectorsForScan`/`entityVectorsForScan`/`semanticRanks`/
    // `entityRanks`/`candidates` -- so a narrow `paths` filter or either
    // lane's own cap never makes the coverage view understate how much of
    // the workspace is actually materialized.
    const coverage = buildSemanticCoverageView({ provider, marker, isCurrent, counts, coveredCount: dedupedVectors.length, indexSupported: true, entityCount: entityCounts.entity_count, coveredEntityCount: dedupedEntityVectors.length, realCounts, affectedPage });
    return result({ candidates, semantic_coverage: [coverageItem(coverage)] }, capabilityStates, semanticEvaluationState(coverage.materialization_state));
  }

  /**
   * Plan 2026-09-06 (Frente S-A, §4.3): `core:semantic_affected_page` --
   * pages through the AFFECTED (`status <> 'covered'`) documents named by a
   * prior `semantic_coverage.affected_artifact_set_id`. The requested
   * `affected_artifact_set_id` (and, when present, the cursor's own embedded
   * `set`) is validated against the CURRENT set id BEFORE any page is
   * sliced -- a mismatch means the workspace's affected documents changed
   * since that id/cursor was minted, and this throws `core:affected_set_stale`
   * rather than ever returning a page that mixes two different sets or
   * silently reinterprets a stale cursor against new data (R11).
   */
  private async trySemanticAffectedPage(operation: OperationInvocation): Promise<OperationEvaluation | undefined> {
    if (operation.operation_id !== "core:semantic_affected_page") return undefined;
    const scope = requireSingleWorkspaceScope(operation.scope);
    const args = object(operation.arguments);
    const requestedSetId = typeof args["affected_artifact_set_id"] === "string" ? args["affected_artifact_set_id"] as string : "";
    const cursorToken = typeof args["cursor"] === "string" ? args["cursor"] as string : undefined;
    const requestedLimit = typeof args["limit"] === "number" && Number.isSafeInteger(args["limit"]) && (args["limit"] as number) > 0
      ? Math.min(args["limit"] as number, SEMANTIC_AFFECTED_PAGE_MAX_LIMIT)
      : SEMANTIC_AFFECTED_FIRST_PAGE_LIMIT;

    const provider = this.options.semantic;
    if (provider === undefined || this.snapshots.semantic_affected_documents === undefined) {
      throw new SemanticQueryError(
        "core:required_capability_unsupported",
        `core:semantic_affected_page requires a configured semantic provider and an affected-documents-capable snapshot port for workspace "${scope.workspace_id}".`,
        { capability: "core:semantic_affected_documents", workspace_snapshot_binding_ids: [scope.workspace_id], reason_codes: [provider === undefined ? "no_provider_configured" : "snapshot_port_unsupported"] },
      );
    }

    let decodedCursor: AffectedCursor | undefined;
    if (cursorToken !== undefined) {
      try { decodedCursor = decodeAffectedCursor(cursorToken); }
      catch (error) { throw new SemanticQueryError("core:cursor_invalid", error instanceof Error ? error.message : "Malformed core:semantic_affected_page cursor.", { reason_code: "malformed_cursor" }); }
    }

    const marker = this.snapshots.semantic_index_state !== undefined ? await this.snapshots.semantic_index_state(operation.scope) : undefined;
    const rows = await this.snapshots.semantic_affected_documents(operation.scope, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
    const currentSetId = computeAffectedSetId(rows, {
      bindingId: digestOf({ profile_id: provider.profile.embedding_profile_id, executable_binding_id: provider.binding.executable_binding_digest }),
      generation: marker?.generation ?? 0, profileId: provider.profile.embedding_profile_id, executableBindingId: provider.binding.executable_binding_digest,
    });
    // Never a mixed/partial page (R11 + this plan's own invariant): a
    // cursor with a `set` different from `currentSetId`, OR an
    // `affected_artifact_set_id` argument different from it, is rejected
    // outright before `pageAffectedRows` ever runs.
    if (requestedSetId !== currentSetId || (decodedCursor !== undefined && decodedCursor.set !== currentSetId)) {
      throw new SemanticQueryError(
        "core:affected_set_stale",
        `The affected document set for workspace "${scope.workspace_id}" has changed since this affected_artifact_set_id/cursor was minted; re-run core:search_semantic or core:search_hybrid to read the current semantic_coverage.affected_artifact_set_id.`,
        { current_set_id: currentSetId },
      );
    }

    const page = buildAffectedArtifactPage(rows, { setId: currentSetId, limit: requestedLimit, ...(decodedCursor === undefined ? {} : { cursor: { k: decodedCursor.k, dir: decodedCursor.dir } }) });
    const capabilityStates = await this.snapshots.capability_states?.(operation.scope) ?? [];
    // ONE synthetic item carrying the complete `SemanticAffectedArtifactPage`
    // (`next_cursor`/`previous_cursor`/`has_next`/`has_previous`/`total`
    // included) -- the same "one structured view per item" convention
    // `coverageItem` already uses for `semantic_coverage`. This is
    // deliberate, not incidental: R11's cursor is a stateless value that
    // round-trips through THIS operation's own `cursor` ARGUMENT on a fresh
    // call, never through the generic per-stream `request_type: continuation`
    // mechanism (`QueryEngine.continue`) -- emitting N per-artifact items
    // instead would both hide the page's cursors from every caller (no
    // per-item field carries them) and let the generic engine's OWN
    // `response_budget.max_items` keyset-paginate this stream independently
    // of `limit`, double-paginating in a way this operation's own contract
    // never promises. A single item is always far under any budget, so the
    // generic wrapper is a no-op pass-through here.
    return result({ semantic_affected_artifacts: [{ value: page, stable_sort_key: `unclassified\0${currentSetId}` }] }, capabilityStates);
  }

  async execute(operation: OperationInvocation): Promise<OperationEvaluation> {
    const boundArguments = await materializeHandleBindings(operation.arguments, operation.input_handles);
    const boundOperation: OperationInvocation = boundArguments === operation.arguments ? operation : { ...operation, arguments: boundArguments };
    const pushedSearchText = await this.trySearchTextPushdown(boundOperation);
    if (pushedSearchText !== undefined) return pushedSearchText;
    const pushedContext = await this.tryBuildContextPushdown(boundOperation);
    if (pushedContext !== undefined) return pushedContext;
    const pushedSemantic = await this.trySemanticSearch(boundOperation);
    if (pushedSemantic !== undefined) return pushedSemantic;
    const pushedAffectedPage = await this.trySemanticAffectedPage(boundOperation);
    if (pushedAffectedPage !== undefined) return pushedAffectedPage;
    const warm = (await this.snapshots.has_warm_records?.(boundOperation.scope)) ?? false;
    if (!warm) {
      const pushed = await this.tryPushdown(boundOperation);
      if (pushed !== undefined) return pushed;
    }
    if (boundOperation.operation_id === "core:find_artifacts" && this.snapshots.artifacts_by_filter !== undefined) {
      const artifacts = await this.snapshots.artifacts_by_filter(boundOperation.scope, object(boundOperation.arguments)["filter"] as StructuralFilter | undefined);
      const capabilityStates = await this.snapshots.capability_states?.(boundOperation.scope) ?? [];
      return result({ artifacts: artifacts.map((record) => item(record)) }, capabilityStates);
    }
    // SQL-backed production ports use the uncached paginated query path.
    // `records()` remains only as a compatibility fallback for adapters that
    // predate the v2 query port.
    const records = this.snapshots.records_for_query !== undefined
      ? await this.snapshots.records_for_query(boundOperation.scope)
      : await this.snapshots.records(boundOperation.scope);
    const capabilityStates = await this.snapshots.capability_states?.(boundOperation.scope) ?? [];
    const evaluated = (streams: Readonly<Record<string, readonly QueryStreamItem[]>>): OperationEvaluation => result(streams, capabilityStates);
    const maps = await cachedIdentityMaps(records);
    const args = object(boundOperation.arguments);
    const graphEvaluation = await this.evaluateGraphOperation(boundOperation, records, maps, capabilityStates);
    if (graphEvaluation !== undefined) return graphEvaluation;
    if (boundOperation.operation_id === "core:find_records") {
      return evaluated({ records: records.filter((record) => selected(record, args["selector"])).map((record) => item(record)) });
    }
    if (boundOperation.operation_id === "core:resolve_symbol") {
      const reference = String(args["reference"] ?? "");
      let declarations: readonly CanonicalQueryRecord[] = maps.entities.filter((record) => record.body["name"] === reference || record.body["qualified_name"] === reference);
      declarations = filterByKindSelector(declarations, args["kind_selector"]);
      const contextArtifact = typeof args["context_artifact"] === "string" ? args["context_artifact"] : undefined;
      // Bug Group 2.1: `resolution_scope` defaults to `visible` (with a
      // context) or `workspace` (without one) -- injected explicitly by
      // `normalizeQueryRequest` for direct `core:resolve_symbol` calls, and
      // defaulted here too so recipe-invoked `resolve` stages (which never
      // carry `resolution_scope` in their own argument models) get the same
      // correct behavior rather than an implicit empty-visible-scope trap.
      const resolutionScope = typeof args["resolution_scope"] === "string" ? args["resolution_scope"] : contextArtifact !== undefined ? "visible" : "workspace";
      if (resolutionScope !== "workspace" && contextArtifact !== undefined) {
        const container = resolveArtifactContainer(contextArtifact, maps);
        if (container !== undefined) {
          const sameArtifact = declarations.filter((record) => record.owner_artifact_id === container.owner_artifact_id);
          // `exports`: exportedness is not recorded on stored entity records
          // today, so it cannot be distinguished from an ordinary
          // same-artifact declaration -- per this bug group's own guidance,
          // an undeliverable `exports` narrowing degrades to `workspace`
          // (the full candidate set) rather than silently under-reporting.
          // `visible`: prefer same-artifact declarations; when none exist,
          // fall back to the full candidate set (a sane approximation of
          // "+ exported declarations elsewhere" absent an exportedness
          // signal to distinguish "elsewhere and exported" from "elsewhere
          // and private").
          if (resolutionScope === "visible" && sameArtifact.length > 0) declarations = sameArtifact;
        }
      }
      return evaluated({ declarations: declarations.map((record) => item(record)), candidates: [] });
    }
    if (boundOperation.operation_id === "core:get_source") {
      const selectors = Array.isArray(args["subjects"]) ? args["subjects"] : [];
      const subjects = resolveSelectorsToRecords(selectors, maps);
      const hydratedArtifacts = await hydrateArtifactSelectorRecords(this.snapshots, boundOperation.scope, selectors, subjects);
      return evaluated(await buildGetSourceStreams(this.snapshots, boundOperation.scope, [...subjects, ...hydratedArtifacts], args));
    }
    if (boundOperation.operation_id === "core:search_text") {
      const pattern = String(args["pattern"] ?? "").toLocaleLowerCase("en-US");
      const subjectInput = args["subjects"];
      const selected = subjectInput === undefined
        ? records
        : resolveSelectorsToRecords(Array.isArray(subjectInput) ? subjectInput : [subjectInput], maps);
      const matches = selected.filter((record) => JSON.stringify(record.body).toLocaleLowerCase("en-US").includes(pattern));
      return evaluated({ matches: matches.map((record) => item(record)), subjects: matches.map((record) => item(record)) });
    }
    if (boundOperation.operation_id === "core:analyze_impact") {
      const targets = resolveSelectorsToRecords(args["target"] === undefined ? [] : [args["target"]], maps);
      const target = targets[0];
      const callerRecords = target === undefined ? [] : maps.relations.filter((record) => record.universal_kind === "core:call" && relationEndpoints(record, maps.by_any_id).target === target).flatMap((record) => {
        const source = relationEndpoints(record, maps.by_any_id).source;
        return source === undefined ? [] : [source];
      });
      const tests = relatedTests([...callerRecords, ...(target === undefined ? [] : [target])], maps);
      return evaluated({ will_break: callerRecords.map((record) => item(record)), must_update: [], may_be_affected: [], tests_to_run: tests.map((record) => item(record)), uncertain_dynamic_usage: [] });
    }
    if (boundOperation.operation_id === "core:find_related_tests") {
      const subjects = resolveSelectorsToRecords(args["subjects"], maps);
      return evaluated({ tests: relatedTests(subjects, maps).map((record) => item(record)), fixtures: [], mocks: [], helpers: [] });
    }
    if (boundOperation.operation_id === "core:inspect_architecture") {
      const containers = maps.entities.filter((record) => record.universal_kind === "core:container");
      const publicSurfaces = maps.entities.filter((record) => record.universal_kind === "core:type" && !String(record.body["name"] ?? "").startsWith("_"));
      return evaluated({ entry_points: containers.map((record) => item(record)), public_surfaces: publicSurfaces.map((record) => item(record)), layers: [] });
    }
    if (boundOperation.operation_id === "core:discover_definitions") {
      return evaluated(discoverDefinitions(args));
    }
    return evaluated(Object.fromEntries(boundOperation.result_streams.map((stream) => [stream, []])));
  }
}

/**
 * Minimal `core:discover_definitions` implementation: matches `matcher.text`
 * against the REGISTRY definition inventory (universal entity/relation
 * kinds as the `record_kind` family, `facetRegistry` as the `facet` family,
 * `languageRegistry` as the `language` family) -- not against workspace
 * records, which is a different, already-implemented, operation
 * (`core:find_records`). Needed end-to-end so the `core:definition_to_instances`
 * recipe's `bind.record_selector` stage (Bug Group 1) has a real upstream
 * `definition_set` to bind from; not itself one of the four listed bug
 * groups, but the recipe cannot be exercised without it. `semantic`/`hybrid`
 * matcher modes degrade to `contains` here (no embedding model is involved
 * in matching registry definition names), which is a deliberate, documented
 * simplification.
 */
function discoverDefinitions(args: Record<string, unknown>): Readonly<Record<string, readonly QueryStreamItem[]>> {
  const matcher = object(args["matcher"]);
  const text = String(matcher["text"] ?? "");
  const mode = String(matcher["mode"] ?? "exact");
  const matcherTypes = strings(matcher["definition_types"]);
  const selectorTypes = strings(object(args["selector"])["definition_types"]);
  const allowedTypes = selectorTypes.length > 0 ? new Set(selectorTypes) : matcherTypes.length > 0 ? new Set(matcherTypes) : undefined;
  const inventory: { readonly definition_type: string; readonly definition_id: string }[] = [
    ...universalEntityKinds.map((kind) => ({ definition_type: "record_kind", definition_id: kind })),
    ...universalRelationKinds.map((kind) => ({ definition_type: "record_kind", definition_id: kind })),
    ...facetRegistry.map((facet) => ({ definition_type: "facet", definition_id: facet })),
    ...languageRegistry.map((language) => ({ definition_type: "language", definition_id: language.id })),
  ];
  const matches = (id: string): boolean => {
    const local = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
    if (mode === "exact") return id === text || local === text;
    if (mode === "prefix") return id.startsWith(text) || local.startsWith(text);
    return id.includes(text) || local.includes(text);
  };
  const matched = inventory.filter((definition) => (allowedTypes === undefined || allowedTypes.has(definition.definition_type)) && (text.length === 0 || matches(definition.definition_id)));
  const definitions: QueryStreamItem[] = matched.map((definition, index) => ({
    value: { subject_type: "definition", definition_type: definition.definition_type, definition_id: definition.definition_id, match_class: mode === "exact" ? "exact" : "lexical", match_terms: [text] },
    stable_sort_key: `confirmed\0${String(index).padStart(6, "0")}\0${definition.definition_id}`,
  }));
  const definitionSet: QueryStreamItem[] = matched.length === 0 ? [] : [{ value: { definitions: matched }, stable_sort_key: "0" }];
  return { definitions, definition_set: definitionSet };
}
