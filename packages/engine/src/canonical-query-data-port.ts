import { canonicalBytes, decodeCanonical, digestBytes } from "@urdira/canonical";
import { facetRegistry, languageRegistry, universalEntityKinds, universalRelationKinds, type QueryScope, type SemanticCoverageView, type SingleWorkspaceScope, type SnapshotCapabilityStateEntry, type SourceSpan, type StructuralFilter } from "@urdira/contracts";
import type { SqliteDatabase } from "@urdira/storage";
import { EngineError, EngineErrorWithDetails } from "./errors.js";
import { QueryPlanError } from "./query-plan.js";
import { expandRelations, findShortestPaths, type OperationEvaluation, type OperationInvocation, type QueryDataPort, type QueryStreamItem, type RelationEdge } from "./query-operators.js";
import type { RecordBodyInterner } from "./record-body-interner.js";
import type { ResolvedSemanticProvider } from "./semantic-provider.js";
import { exactVectorScan, fuseSemanticLanes, rerankSemanticMatches } from "./semantic-retrieval.js";

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

export interface CanonicalQuerySnapshotPort {
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
  /**
   * Literal-substring search over the workspace's trigram-backed lexical
   * projection (`lexical_documents`/`lexical_trigrams`, built asynchronously
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
   * `packages/storage/src/projections.ts`, whose case/trigram semantics this
   * mirrors), one entry per non-overlapping match. `path_prefixes`, when
   * supplied, is an exact hard filter applied by the lexical provider before
   * candidate caps and hydration; providers that cannot honor it should omit
   * this pushdown capability rather than widen the answer.
   */
  readonly search_literal?: (scope: QueryScope, pattern: string, options: { readonly case_sensitive?: boolean; readonly path_prefixes?: readonly string[] }) => Promise<readonly LexicalSearchMatch[] | undefined>;
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
   * an in-memory `category: "artifact"` record straight from `artifact_versions`
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
}

export interface SemanticIndexStateSnapshot {
  readonly generation: number;
  readonly completed_generation?: number;
  readonly profile_id?: string;
  readonly executable_binding_id?: string;
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
// matching `RecordRow` -- record_payload bytes included -- in ONE
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
const DELTA_ID_CHUNK_SIZE = 500;
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
// Must track the reconciler's own `max_document_bytes` default
// (`semantic-reconciler.ts`'s `ReconcileSemanticProjectionInput.max_document_bytes`,
// default 2_000_000) for `semantic_scope_counts`'s `oversized_count` to mean
// the same thing here as it does during maintenance. The query port has no
// channel back to the reconciler's actual configured value (a future
// refinement could persist it alongside `semantic_index_state`); until then,
// this constant is a duplicated-but-documented assumption, not a derived one.
const SEMANTIC_MAX_DOCUMENT_BYTES = 2_000_000;

type RecordRow = {
  readonly record_id: string; readonly workspace_id: string; readonly category: string; readonly kind: string; readonly universal_kind: string;
  readonly owner_artifact_id: string; readonly owner_artifact_version_id: string; readonly record_payload: Uint8Array;
  readonly primary_source_span_artifact_version_id: string | number | null;
  readonly primary_source_span_start_byte: string | number | null;
  readonly primary_source_span_end_byte: string | number | null;
  readonly primary_source_span_start_line: string | number | null;
  readonly primary_source_span_end_line: string | number | null;
  readonly identity_id: string | null; readonly identity_key: string | null;
};

function primarySourceSpan(row: RecordRow): SourceSpan | undefined {
  if (row.primary_source_span_artifact_version_id == null || row.primary_source_span_start_byte == null || row.primary_source_span_end_byte == null) return undefined;
  return {
    artifact_version_id: String(row.primary_source_span_artifact_version_id),
    start_byte: String(row.primary_source_span_start_byte),
    end_byte: String(row.primary_source_span_end_byte),
    ...(row.primary_source_span_start_line == null ? {} : { start_line: String(row.primary_source_span_start_line) }),
    ...(row.primary_source_span_end_line == null ? {} : { end_line: String(row.primary_source_span_end_line) }),
  };
}

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
// (rather than imported) because `lexicalTrigrams`/`normalizedTerm`
// (`packages/storage/src/projections.ts`) are storage-internal, not exported
// from `@urdira/storage`'s package index -- the query port's pushdown SQL is
// intentionally its own implementation, consistent with how `records_by_*`
// above already duplicate the record-row query shape rather than delegating
// to storage. Trigrams are computed over `normalizedTerm(text)`, not the raw
// string, making a document's trigram set a normalization-insensitive
// superset of any substring it contains -- see `search_literal` above for why
// that makes one trigram prefilter valid for both case modes.
function normalizedTerm(value: string): string { return value.normalize("NFKC").toLocaleLowerCase("en-US"); }

function patternTrigrams(pattern: string): readonly string[] {
  const source = new TextEncoder().encode(normalizedTerm(pattern));
  const result = new Set<string>();
  for (let index = 0; index + 3 <= source.length; index += 1) result.add(Array.from(source.slice(index, index + 3), (value) => value.toString(16).padStart(2, "0")).join(""));
  return [...result].sort();
}

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
  // `record_payload` byte length visible at `generation` -- feeding
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
    // Query API v2 source bindings intentionally use a synthetic immutable
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
   * `row.record_id` proves `row.record_payload`'s bytes are IDENTICAL to
   * whatever a prior decode of that same id already produced -- there is no
   * need to `decodeCanonical` this row's payload at all. Both `body` and
   * `facets` (also content-derived from the same payload bytes, under a
   * second, derived interner key -- see `RecordBodyInterner`'s own doc
   * comment) must hit for this shortcut; a miss on either falls back to a
   * full decode, exactly as if no interner were configured, and registers
   * both for future hits.
   */
  private decodeRow(row: RecordRow): CanonicalQueryRecord {
    const internedBody = this.interner?.lookup(row.record_id);
    const internedFacets = internedBody === undefined ? undefined : this.interner?.lookup(facetsInternerKey(row.record_id));
    let body: Record<string, unknown>;
    let facets: readonly string[];
    if (internedBody !== undefined && internedFacets !== undefined) {
      body = internedBody as Record<string, unknown>;
      facets = strings(internedFacets["facets"]);
    } else {
      const payload = decodeCanonical(row.record_payload) as Record<string, unknown>;
      body = object(payload["body"]);
      facets = [];
      if (typeof payload["facets"] === "string") {
        try { facets = strings(JSON.parse(payload["facets"] as string)); } catch { facets = []; }
      }
      this.interner?.register(row.record_id, body);
      this.interner?.register(facetsInternerKey(row.record_id), { facets });
    }
    const sourceSpan = primarySourceSpan(row);
    return {
      record_id: row.record_id,
      workspace_id: row.workspace_id,
      category: row.category,
      kind: row.kind,
      universal_kind: row.universal_kind,
      owner_artifact_id: row.owner_artifact_id,
      owner_artifact_version_id: row.owner_artifact_version_id,
      ...(sourceSpan === undefined ? {} : { primary_source_span: sourceSpan }),
      ...(row.identity_id === null ? {} : { identity_id: row.identity_id }),
      ...(row.identity_key === null ? {} : { identity_key: row.identity_key }),
      facets,
      body,
    };
  }

  /**
   * Runs the shared records+identity join, visible at `generation`, with one
   * extra caller-supplied SQL condition ANDed in, and an optional `LIMIT`.
   * When `limit` is given, runs as a single query exactly as before (see
   * `ROW_FETCH_BATCH_SIZE`'s own doc comment for why the bounded-`limit`
   * callers don't need pagination). When `limit` is omitted, keyset-paginates
   * on `records.record_id` instead of running one unbounded query.
   */
  private async queryRecordRows(workspaceId: string, generation: number, extraCondition: string, extraParams: ReadonlyArray<string | number>, limit?: number): Promise<readonly RecordRow[]> {
    const baseSql =
      `SELECT records.record_id, records.workspace_id, records.category, records.kind, records.universal_kind,
              records.owner_artifact_id, records.owner_artifact_version_id,
              records.primary_source_span_artifact_version_id, records.primary_source_span_start_byte,
              records.primary_source_span_end_byte, records.primary_source_span_start_line,
              records.primary_source_span_end_line, records.record_payload,
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
      return await this.database.all<RecordRow>(`${baseSql} ORDER BY records.record_id LIMIT ?`, [...baseParams, limit]);
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
    return rows;
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
   * `approxWarmBytes()`'s per-workspace input: the total `record_payload`
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
      "SELECT COALESCE(SUM(LENGTH(record_payload)), 0) AS bytes FROM record_occurrences WHERE workspace_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)",
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
   * ENCODED `record_payload` byte lengths, not measured decoded-heap RSS --
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
      `SELECT records.record_id, records.workspace_id, records.category, records.kind, records.universal_kind,
              records.owner_artifact_id, records.owner_artifact_version_id, records.record_payload,
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
    return rows.map((row) => this.decodeRow(row)).filter((record) => identityKeyTail(record.identity_key) === name);
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
        conditions.push(`${column} IN (${values.map(() => "?").join(", ")})`);
        params.push(...values);
      }
    }
    const extraCondition = conditions.length > 0 ? conditions.join(" AND ") : "1 = 1";
    const rows = await this.queryRecordRows(workspaceId, generation, extraCondition, params, limit);
    return rows.map((row) => this.decodeRow(row));
  }

  /**
   * Synthesizes one `category: "artifact"` `CanonicalQueryRecord` per
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
          category: "artifact",
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
   * NOTE on implementation: `vector_projection_rows.vector_payload` is NOT
   * the raw vector -- like `record_occurrences.record_payload` elsewhere in
   * this file, it is a canonical-encoded audit/idempotency wrapper (see
   * `WorkspaceProjectionRepository.putVectors`, `packages/storage/src/projections.ts`).
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
    if (this.content === undefined) return [];
    const generation = await this.currentGeneration(scope);
    if (generation === undefined) return [];
    const rows = await this.database.all<{ projection_record_id: string; owner_artifact_id: string; owner_artifact_version_id: string; shard_id: string; shard_offset: number; byte_length: number; dimensions: number; element_type: string; normalization: string; distance_metric: string; document_grain: string | null; document_ref: string | null }>(
      `SELECT projection_record_id, owner_artifact_id, owner_artifact_version_id, shard_id, shard_offset, byte_length, dimensions, element_type, normalization, distance_metric, document_grain, document_ref
         FROM vector_projection_rows
        WHERE workspace_id = ? AND profile_id = ? AND executable_binding_id = ?
          AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)
        ORDER BY projection_record_id`,
      [scope.workspace_id, profileId, executableBindingId, generation, generation],
    );
    if (rows.length === 0) return [];
    const shardIds = [...new Set(rows.map((row) => row.shard_id))];
    const shardRows = await this.database.all<{ shard_id: string; content_hash: string }>(
      `SELECT shard_id, content_hash FROM vector_shards WHERE workspace_id = ? AND shard_id IN (${shardIds.map(() => "?").join(", ")})`,
      [scope.workspace_id, ...shardIds],
    );
    const shardBytes = new Map<string, Uint8Array>();
    for (const shard of shardRows) {
      try { shardBytes.set(shard.shard_id, await this.content.read(shard.content_hash)); } catch { /* unreadable shard -> its rows are dropped below, same "best effort" discipline artifact_text's CAS-read catch uses */ }
    }
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
      result.push({
        projection_record_id: row.projection_record_id, owner_artifact_id: row.owner_artifact_id, owner_artifact_version_id: row.owner_artifact_version_id,
        vector_payload: packed.slice(row.shard_offset, row.shard_offset + row.byte_length), dimensions: row.dimensions, element_type: row.element_type,
        normalization: row.normalization, distance_metric: row.distance_metric,
        ...(isEntity ? { document_grain: "entity" as const, document_ref: row.document_ref as string } : {}),
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

  /**
   * D1/D6: literal-substring search over `lexical_documents`/`lexical_trigrams`,
   * trusted only when `lexical_index_state.completed_generation` equals
   * `scope`'s current generation (otherwise `undefined`, meaning "fall back").
   * Trigram candidate filtering, and the raw-vs-normalized verification split
   * between case modes, mirror `WorkspaceProjectionRepository.searchLiteral`
   * (`packages/storage/src/projections.ts`) exactly -- see that function's
   * doc comment for the case/offset semantics this reproduces. Verification
   * reuses `artifact_text` (this class's own CAS-backed, cached text reader)
   * rather than re-reading `lexical_documents.storage_reference` directly, so
   * repeated searches (and `get_source` snippet reads for the same file) share
   * one cache.
   */
  async search_literal(scope: QueryScope, pattern: string, options: { readonly case_sensitive?: boolean; readonly path_prefixes?: readonly string[] } = {}): Promise<readonly LexicalSearchMatch[] | undefined> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical SQLite queries require one explicit workspace; comparison binds each participant separately.");
    if (this.content === undefined) return undefined;
    const workspaceId = scope.workspace_id;
    const generation = await this.currentGeneration(scope);
    if (generation === undefined) return undefined;
    const sourceOnly = scope.snapshot_id?.startsWith("source-snapshot:") === true;
    const completion = sourceOnly ? undefined : await this.database.get<{ completed_generation: number }>("SELECT completed_generation FROM lexical_index_state WHERE workspace_id = ?", [workspaceId]);
    if (!sourceOnly && completion?.completed_generation !== generation) return undefined;

    const normalizedPattern = normalizedTerm(pattern);
    const visibilitySql = " AND lexical_documents.valid_from_generation <= ? AND (lexical_documents.valid_to_generation IS NULL OR lexical_documents.valid_to_generation > ?)";
    const pathPrefixes = options.path_prefixes?.filter((prefix) => prefix.length > 0) ?? [];
    const pathFilterSql = pathPrefixes.length === 0
      ? ""
      : ` AND (${pathPrefixes.map(() => "source_artifacts.normalized_path LIKE ? ESCAPE '\\'").join(" OR ")})`;
    const pathParams = pathPrefixes.map((prefix) => `${escapeLikePattern(prefix)}%`);
    const candidateRows = sourceOnly
      ? await this.database.all<{ artifact_id: string; artifact_version_id: string }>(
          `SELECT version.artifact_id, version.artifact_version_id FROM artifact_versions AS version
             JOIN source_artifacts ON source_artifacts.workspace_id = version.workspace_id AND source_artifacts.artifact_id = version.artifact_id
            WHERE version.workspace_id = ?${pathFilterSql}
              AND version.valid_from_generation <= ? AND (version.valid_to_generation IS NULL OR version.valid_to_generation > ?)
            ORDER BY version.artifact_id, version.artifact_version_id`,
          [workspaceId, ...pathParams, generation, generation],
        )
      : new TextEncoder().encode(normalizedPattern).byteLength >= 3
      ? await this.database.all<{ artifact_id: string; artifact_version_id: string }>(
          `SELECT DISTINCT lexical_trigrams.artifact_id, lexical_trigrams.artifact_version_id FROM lexical_trigrams
             JOIN lexical_documents ON lexical_documents.workspace_id = lexical_trigrams.workspace_id
              AND lexical_documents.artifact_id = lexical_trigrams.artifact_id
              AND lexical_documents.artifact_version_id = lexical_trigrams.artifact_version_id
             JOIN source_artifacts ON source_artifacts.workspace_id = lexical_documents.workspace_id
              AND source_artifacts.artifact_id = lexical_documents.artifact_id
            WHERE lexical_trigrams.workspace_id = ? AND lexical_trigrams.trigram IN (SELECT value FROM json_each(?))${pathFilterSql}${visibilitySql}
            ORDER BY lexical_trigrams.artifact_id, lexical_trigrams.artifact_version_id`,
          [workspaceId, JSON.stringify(patternTrigrams(pattern)), ...pathParams, generation, generation],
        )
      : await this.database.all<{ artifact_id: string; artifact_version_id: string }>(
          `SELECT lexical_documents.artifact_id, lexical_documents.artifact_version_id FROM lexical_documents
             JOIN source_artifacts ON source_artifacts.workspace_id = lexical_documents.workspace_id
              AND source_artifacts.artifact_id = lexical_documents.artifact_id
            WHERE lexical_documents.workspace_id = ?${pathFilterSql}${visibilitySql}
            ORDER BY lexical_documents.artifact_id, lexical_documents.artifact_version_id`,
          [workspaceId, ...pathParams, generation, generation],
        );

    const matches: LexicalSearchMatch[] = [];
    for (const candidate of candidateRows) {
      const file = await this.artifact_text(scope, candidate.artifact_version_id);
      if (file === undefined) continue;
      // Case-insensitive verification runs against normalizedTerm(source), so
      // returned offsets are indices into the normalized string, not the raw
      // source -- this caveat predates this change (see
      // `WorkspaceProjectionRepository.searchLiteral`). Case-sensitive
      // verification runs against the exact raw source and raw pattern.
      const comparable = options.case_sensitive ? file.text : normalizedTerm(file.text);
      const needle = options.case_sensitive ? pattern : normalizedPattern;
      const offsets: number[] = [];
      const lineSpans: Pick<SourceSpan, "start_line" | "end_line">[] = [];
      let start = 0;
      while (true) {
        const offset = comparable.indexOf(needle, start);
        if (offset < 0) break;
        offsets.push(offset);
        lineSpans.push({
          start_line: String(lineNumberAt(comparable, offset)),
          end_line: String(lineNumberAt(comparable, Math.max(offset + needle.length - 1, offset))),
        });
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
    const rows = await this.database.all<{ payload: Uint8Array }>("SELECT payload FROM control_plane_state WHERE workspace_id = ? AND state_kind = 'capability_state' ORDER BY updated_at, state_key", [workspaceId]);
    const latest = new Map<string, SnapshotCapabilityStateEntry>();
    for (const row of rows) {
      const state = decodeCanonical(row.payload) as SnapshotCapabilityStateEntry;
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

function sourceArtifactRecord(workspaceId: string, row: { readonly artifact_id: string; readonly artifact_version_id: string; readonly normalized_uri: string; readonly normalized_path: string | null }): CanonicalQueryRecord {
  return {
    record_id: `artifact-record:${row.artifact_version_id}`,
    workspace_id: workspaceId,
    category: "artifact",
    kind: "core:source_file",
    universal_kind: "core:artifact",
    owner_artifact_id: row.artifact_id,
    owner_artifact_version_id: row.artifact_version_id,
    facets: [],
    body: { path: row.normalized_path ?? row.normalized_uri, artifact_id: row.artifact_id, artifact_version_id: row.artifact_version_id },
  };
}

function item(record: CanonicalQueryRecord, classification: "confirmed" | "possible" = "confirmed"): QueryStreamItem {
  return { value: recordValue(record, classification), stable_sort_key: `${classification}\0${record.identity_key ?? record.record_id}` };
}

function relationClassification(record: CanonicalQueryRecord): "confirmed" | "possible" {
  return record.body["classification"] === "possible" ? "possible" : "confirmed";
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function subjectIdentity(value: unknown): string | undefined {
  const record = object(value);
  for (const field of ["entity_id", "relation_id", "diagnostic_id", "record_id", "identity_key"]) if (typeof record[field] === "string") return record[field] as string;
  return undefined;
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
      if (container !== undefined) {
        const narrowed = candidates.filter((record) => record.owner_artifact_id === container.owner_artifact_id);
        if (narrowed.length > 0) candidates = narrowed;
      }
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
    for (const id of [record.record_id, record.identity_id, record.identity_key]) if (id !== undefined) byAnyId.set(id, record);
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

async function sourceSnippet(snapshots: CanonicalQuerySnapshotPort, scope: QueryScope, record: CanonicalQueryRecord, mode: "signature" | "relevant" | "body", maxCharactersPerSnippet: number, contextLines: number, remainingBudget: number): Promise<SourceSnippetValue | undefined> {
  if (remainingBudget <= 0) return undefined;
  const bodyStart = record.body["start"];
  const bodyEnd = record.body["end"];
  const canonicalSpan = record.primary_source_span;
  const start = typeof bodyStart === "number" ? bodyStart : canonicalSpan === undefined ? undefined : Number(canonicalSpan.start_byte);
  const end = typeof bodyEnd === "number" ? bodyEnd : canonicalSpan === undefined ? undefined : Number(canonicalSpan.end_byte);
  if (typeof start !== "number" || typeof end !== "number" || start < 0 || end < start) return undefined;
  const file = await snapshots.artifact_text?.(scope, record.owner_artifact_version_id);
  if (file === undefined || end > file.text.length) return undefined;
  const text = file.text;
  let coreEnd = end;
  if (mode === "signature") {
    const newline = text.indexOf("\n", start);
    coreEnd = newline === -1 || newline >= end ? end : newline;
  }
  const { start: sliceStart, end: sliceEnd } = extendSpanForContext(text, start, coreEnd, contextLines);
  let snippetText = text.slice(sliceStart, sliceEnd);
  let truncated = false;
  if (snippetText.length > maxCharactersPerSnippet) { snippetText = snippetText.slice(0, maxCharactersPerSnippet); truncated = true; }
  if (snippetText.length > remainingBudget) { snippetText = snippetText.slice(0, remainingBudget); truncated = true; }
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
 * entire file's worth of entity candidates down to one. The reconciler's own
 * entity stale-close/missing-insert queries (`semantic-reconciler.ts` steps
 * 4-5) already guarantee at most one OPEN row per `(document_ref,
 * profile_id, executable_binding_id)`, so this is -- like
 * `dedupeVectorsByOwner` for the artifact case -- a defensive no-op in
 * practice, not a case this file has any way to construct.
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
}): EntitySemanticCoverageView {
  const { provider, marker, isCurrent, counts, coveredCount, indexSupported, entityCount, coveredEntityCount } = inputs;
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
    unsupported_artifact_count: 0,
    failed_artifact_count: 0,
    affected_artifact_count: pending,
    entity_count: entityCount,
    covered_entity_count: coveredEntityCount,
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

/** Candidate stream item for both `core:search_semantic` and `core:search_hybrid` -- the registry pins both operations' `candidates` stream to `possible`-only (`registries.ts`), so unlike `item()` above there is no `confirmed` case to branch on. `rank` is always the FINAL, post-hydration output position (1-based, contiguous, no gaps even if some ranked ids failed to hydrate) -- never a fusion-internal or exact-scan-internal rank, which could contain gaps once un-hydratable ids are dropped. */
function semanticCandidateItem(record: CanonicalQueryRecord, rank: number): QueryStreamItem {
  const identity = record.identity_key ?? record.record_id;
  return { value: recordValue(record, "possible"), stable_sort_key: `possible\0${String(rank).padStart(6, "0")}\0${identity}` };
}

/**
 * Language-neutral evaluator over one immutable canonical record snapshot.
 * It never invokes plugin code; JavaScript/TypeScript records participate only
 * through their registered universal kinds and validated relation endpoints.
 */
export class CanonicalRecordQueryDataPort implements QueryDataPort {
  constructor(private readonly snapshots: CanonicalQuerySnapshotPort, private readonly options: { readonly semantic?: ResolvedSemanticProvider } = {}) {}

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
    const records = await this.snapshots.records(scope);
    await this.snapshots.capability_states?.(scope);
    await cachedIdentityMaps(records);
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
    if (operation.operation_id === "core:get_source" && this.snapshots.records_by_ids !== undefined) {
      const selectors = Array.isArray(args["subjects"]) ? args["subjects"] : [];
      const ids = selectors.map(subjectIdentity).filter((value): value is string => value !== undefined);
      const rows = await this.snapshots.records_by_ids(operation.scope, ids);
      const byAnyId = new Map<string, CanonicalQueryRecord>();
      for (const record of rows) for (const id of [record.record_id, record.identity_id, record.identity_key]) if (id !== undefined) byAnyId.set(id, record);
      const subjects = selectors.flatMap((selector) => {
        const id = subjectIdentity(selector);
        const record = id === undefined ? undefined : byAnyId.get(id);
        return record === undefined ? [] : [record];
      });
      const hydratedArtifacts = await hydrateArtifactSelectorRecords(this.snapshots, operation.scope, selectors, subjects);
      const capabilityStates = await this.snapshots.capability_states?.(operation.scope) ?? [];
      return result(await buildGetSourceStreams(this.snapshots, operation.scope, [...subjects, ...hydratedArtifacts], args), capabilityStates);
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
   * and `filter` absent, empty, or limited to the supported `paths` field
   * (path narrowing is applied after artifact hydration). Returns `undefined` -- meaning "fall back
   * to the full in-memory path, byte-for-byte identical to before this
   * change" -- when ineligible, or when `search_literal` itself returns
   * `undefined` (lexical projection not yet complete for this generation).
   */
  private async trySearchTextPushdown(operation: OperationInvocation): Promise<OperationEvaluation | undefined> {
    if (operation.operation_id !== "core:search_text" || this.snapshots.search_literal === undefined || this.snapshots.records_by_artifact_versions === undefined) return undefined;
    const args = object(operation.arguments);
    const syntax = args["syntax"];
    if (syntax !== undefined && syntax !== "literal") return undefined;
    if (args["word_mode"]) return undefined;
    const filterArg = args["filter"];
    const filter = object(filterArg);
    const filterKeys = Object.keys(filter);
    if (filterKeys.some((key) => key !== "paths")) return undefined;
    const pathPrefixes = strings(filter["paths"]);
    const pattern = String(args["pattern"] ?? "");
    const caseSensitive = args["case_sensitive"] === true;

    const matches = await this.snapshots.search_literal(operation.scope, pattern, { case_sensitive: caseSensitive, path_prefixes: pathPrefixes });
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
    const matches = await this.snapshots.search_literal(operation.scope, queryText, { case_sensitive: false, path_prefixes: pathPrefixes });
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
  private async hydrateSemanticCandidates(scope: QueryScope, rankedEntries: readonly { readonly id: string; readonly grain: "artifact" | "entity" }[]): Promise<readonly QueryStreamItem[]> {
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
    for (const entry of rankedEntries) {
      const record = entry.grain === "entity" ? byRecordId.get(entry.id) : byVersionId.get(entry.id);
      if (record !== undefined) items.push(semanticCandidateItem(record, items.length + 1));
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
    const capabilityStates = await this.snapshots.capability_states?.(operation.scope) ?? [];

    const marker = portReady ? await this.snapshots.semantic_index_state!(operation.scope) : undefined;
    const isCurrent = isSemanticMarkerCurrent(marker, provider);
    const allVectors = portReady && provider !== undefined && marker !== undefined
      ? await this.snapshots.semantic_vectors!(operation.scope, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest)
      : [];
    // Decision 17: an entity-grain row must NEVER enter `dedupeVectorsByOwner`
    // (many legitimately share one `owner_artifact_version_id` -- every
    // eligible entity in one file) -- so the combined `allVectors` list is
    // split by grain FIRST, and each half deduplicated by its own correct
    // key (`dedupeVectorsByDocumentRef` for entity rows).
    const dedupedVectors = dedupeVectorsByOwner(allVectors.filter((vector) => vector.document_grain !== "entity"));
    const dedupedEntityVectors = dedupeVectorsByDocumentRef(allVectors.filter((vector) => vector.document_grain === "entity"));
    const counts = portReady ? await this.snapshots.semantic_scope_counts!(operation.scope, SEMANTIC_MAX_DOCUMENT_BYTES) : { artifact_count: 0, oversized_count: 0 };
    const entityCounts = this.snapshots.semantic_entity_scope_counts !== undefined ? await this.snapshots.semantic_entity_scope_counts(operation.scope) : { entity_count: 0 };

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
      const coverage = buildSemanticCoverageView({ provider, marker, isCurrent: false, counts, coveredCount: 0, indexSupported: false, entityCount: entityCounts.entity_count, coveredEntityCount: 0 });
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
    let entityVectorsForScan = includeEntityLane ? dedupedEntityVectors : [];
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
    // Decision 17: the entity lane's OWN exact-scan, keyed by `document_ref`
    // (the owning record's own `record_id` -- NEVER `owner_artifact_version_id`,
    // which many entity rows from one file legitimately share) and capped
    // separately (`SEMANTIC_ENTITY_CANDIDATE_CAP`).
    const entityRanks = exactVectorScan(
      entityVectorsForScan.map((vector) => ({ projection_record_id: vector.document_ref!, profile_id: provider!.profile.embedding_profile_id, executable_binding_id: provider!.binding.executable_binding_digest, vector: vector.vector_payload })),
      queryVector.vector,
      { profile_id: provider!.profile.embedding_profile_id, executable_binding_id: provider!.binding.executable_binding_digest, dimensions: provider!.profile.dimensions, element_type: provider!.profile.element_type as "float32" | "float64", distance_metric: "cosine", normalization: provider!.profile.normalization as "none" | "l2", limit: SEMANTIC_ENTITY_CANDIDATE_CAP },
    );

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

    const candidates = await this.hydrateSemanticCandidates(operation.scope, finalRanked.map((entry) => ({ id: entry.projection_record_id, grain: grainById.get(entry.projection_record_id) ?? "artifact" })));
    // Coverage counts come from `semantic_scope_counts`/`semantic_entity_scope_counts`
    // + `dedupedVectors`/`dedupedEntityVectors` (the FULL, unfiltered,
    // uncapped visible-vector sets) -- never from
    // `artifactVectorsForScan`/`entityVectorsForScan`/`semanticRanks`/
    // `entityRanks`/`candidates` -- so a narrow `paths` filter or either
    // lane's own cap never makes the coverage view understate how much of
    // the workspace is actually materialized.
    const coverage = buildSemanticCoverageView({ provider, marker, isCurrent, counts, coveredCount: dedupedVectors.length, indexSupported: true, entityCount: entityCounts.entity_count, coveredEntityCount: dedupedEntityVectors.length });
    return result({ candidates, semantic_coverage: [coverageItem(coverage)] }, capabilityStates, semanticEvaluationState(coverage.materialization_state));
  }

  async execute(operation: OperationInvocation): Promise<OperationEvaluation> {
    const pushedSearchText = await this.trySearchTextPushdown(operation);
    if (pushedSearchText !== undefined) return pushedSearchText;
    const pushedSemantic = await this.trySemanticSearch(operation);
    if (pushedSemantic !== undefined) return pushedSemantic;
    const warm = (await this.snapshots.has_warm_records?.(operation.scope)) ?? false;
    if (!warm) {
      const pushed = await this.tryPushdown(operation);
      if (pushed !== undefined) return pushed;
    }
    if (operation.operation_id === "core:find_artifacts" && this.snapshots.artifacts_by_filter !== undefined) {
      const artifacts = await this.snapshots.artifacts_by_filter(operation.scope, object(operation.arguments)["filter"] as StructuralFilter | undefined);
      const capabilityStates = await this.snapshots.capability_states?.(operation.scope) ?? [];
      return result({ artifacts: artifacts.map((record) => item(record)) }, capabilityStates);
    }
    const records = await this.snapshots.records(operation.scope);
    const capabilityStates = await this.snapshots.capability_states?.(operation.scope) ?? [];
    const evaluated = (streams: Readonly<Record<string, readonly QueryStreamItem[]>>): OperationEvaluation => result(streams, capabilityStates);
    const maps = await cachedIdentityMaps(records);
    const args = object(operation.arguments);
    if (operation.operation_id === "core:find_records") {
      return evaluated({ records: records.filter((record) => selected(record, args["selector"])).map((record) => item(record)) });
    }
    if (operation.operation_id === "core:resolve_symbol") {
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
    if (operation.operation_id === "core:get_outline") {
      const containers = resolveSelectorsToRecords(args["container"] === undefined ? [] : [args["container"]], maps);
      const container = containers[0];
      // Bug Group 3: an unresolvable container (including the artifact/path
      // variants `subjectIdentity` alone never read) used to fall through
      // to a silent `evaluated({members: []})` SUCCESS. A missing container
      // is a selector error, not an empty-but-valid outline.
      if (container === undefined) throw new EngineErrorWithDetails("core:selector_not_found", "The get_outline container could not be resolved.", { selector_pointer: "/container" });
      const depth = typeof args["depth"] === "number" ? args["depth"] : 1;
      const seen = new Set<string>([container.identity_key ?? container.record_id]);
      let frontier = [container];
      const members: CanonicalQueryRecord[] = [];
      for (let level = 0; level < depth; level += 1) {
        const next: CanonicalQueryRecord[] = [];
        for (const parent of frontier) for (const relation of maps.relations.filter((entry) => entry.universal_kind === "core:contains")) {
          const endpoints = relationEndpoints(relation, maps.by_any_id);
          if (endpoints.source !== parent || endpoints.target === undefined) continue;
          const key = endpoints.target.identity_key ?? endpoints.target.record_id;
          if (!seen.has(key)) { seen.add(key); members.push(endpoints.target); next.push(endpoints.target); }
        }
        frontier = next;
      }
      return evaluated({ members: members.map((record) => item(record)) });
    }
    if (operation.operation_id === "core:find_references") {
      const targets = resolveSelectorsToRecords(args["target"] === undefined ? [] : [args["target"]], maps);
      const target = targets[0];
      const relations = target === undefined ? [] : maps.relations.filter((record) => relationEndpoints(record, maps.by_any_id).target === target);
      const owners = relations.flatMap((record) => {
        const source = relationEndpoints(record, maps.by_any_id).source;
        return source === undefined ? [] : [source];
      });
      return evaluated({ references: relations.map((record) => item(record, relationClassification(record))), owners: [...new Map(owners.map((record) => [record.record_id, record])).values()].map((record) => item(record)) });
    }
    if (operation.operation_id === "core:expand_relations") {
      // Bug Group 4.2: real multi-hop BFS (adapted from `expandRelations`/
      // `findShortestPaths` in `query-operators.ts`), honoring
      // direction/min_depth/max_depth instead of the prior single-hop
      // filter, and populating `paths` when `path_policy` is present
      // instead of always returning `[]`. Also resolves `subjects` through
      // `resolveSelectorsToRecords` so a `symbol` selector seed works too.
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
      const pathPolicy = args["path_policy"];
      const paths = pathPolicy === undefined || discoveredIds.size === 0 || rootIds.length === 0
        ? []
        : findShortestPaths(edges, rootIds, [...discoveredIds.keys()], { direction, max_depth: maxDepth, all_shortest: false, ...(relationKinds.length > 0 ? { relation_kinds: relationKinds } : {}) }).map((path): QueryStreamItem => ({
            value: {
              subjects: path.subjects.map((id) => maps.by_any_id.get(id)).filter((value): value is CanonicalQueryRecord => value !== undefined).map((record) => recordValue(record)),
              relation_kinds: path.relation_kinds,
              length: path.subjects.length - 1,
              classification: path.classification,
            },
            stable_sort_key: path.stable_sort_key,
            result_classification: path.classification,
          }));
      return evaluated({ subjects: [...discoveredIds.values()].map((record) => item(record)), relations: relationsUsed.map((record) => item(record, relationClassification(record))), paths });
    }
    if (operation.operation_id === "core:find_paths") {
      const sourceIds = resolveSelectorsToRecords(args["sources"], maps).map((record) => record.record_id);
      const targetRecords = new Set(resolveSelectorsToRecords(args["targets"], maps));
      const relationKinds = strings(object(args["relations"])["universal_kinds"]);
      const maxDepth = typeof args["max_depth"] === "number" ? args["max_depth"] : 4;
      const queue = sourceIds.flatMap((id) => { const source = maps.by_any_id.get(id); return source === undefined ? [] : [{ node: source, path: [] as CanonicalQueryRecord[] }]; });
      const found: CanonicalQueryRecord[] = [];
      const seen = new Set(queue.map((entry) => entry.node.record_id));
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (targetRecords.has(current.node)) { found.push(...current.path); break; }
        if (current.path.length >= maxDepth) continue;
        for (const relation of maps.relations) {
          if (relationKinds.length > 0 && !relationKinds.includes(relation.universal_kind)) continue;
          const endpoints = relationEndpoints(relation, maps.by_any_id);
          if (endpoints.source !== current.node || endpoints.target === undefined || seen.has(endpoints.target.record_id)) continue;
          seen.add(endpoints.target.record_id);
          queue.push({ node: endpoints.target, path: [...current.path, relation] });
        }
      }
      return evaluated({ paths: found.map((record) => item(record, relationClassification(record))) });
    }
    if (operation.operation_id === "core:get_source") {
      const selectors = Array.isArray(args["subjects"]) ? args["subjects"] : [];
      const subjects = resolveSelectorsToRecords(selectors, maps);
      const hydratedArtifacts = await hydrateArtifactSelectorRecords(this.snapshots, operation.scope, selectors, subjects);
      return evaluated(await buildGetSourceStreams(this.snapshots, operation.scope, [...subjects, ...hydratedArtifacts], args));
    }
    if (operation.operation_id === "core:search_text") {
      const pattern = String(args["pattern"] ?? "").toLocaleLowerCase("en-US");
      const matches = records.filter((record) => JSON.stringify(record.body).toLocaleLowerCase("en-US").includes(pattern));
      return evaluated({ matches: matches.map((record) => item(record)), subjects: matches.map((record) => item(record)) });
    }
    if (operation.operation_id === "core:analyze_impact") {
      const targets = resolveSelectorsToRecords(args["target"] === undefined ? [] : [args["target"]], maps);
      const target = targets[0];
      const callerRecords = target === undefined ? [] : maps.relations.filter((record) => record.universal_kind === "core:call" && relationEndpoints(record, maps.by_any_id).target === target).flatMap((record) => {
        const source = relationEndpoints(record, maps.by_any_id).source;
        return source === undefined ? [] : [source];
      });
      const tests = relatedTests([...callerRecords, ...(target === undefined ? [] : [target])], maps);
      return evaluated({ will_break: callerRecords.map((record) => item(record)), must_update: [], may_be_affected: [], tests_to_run: tests.map((record) => item(record)), uncertain_dynamic_usage: [] });
    }
    if (operation.operation_id === "core:find_related_tests") {
      const subjects = resolveSelectorsToRecords(args["subjects"], maps);
      return evaluated({ tests: relatedTests(subjects, maps).map((record) => item(record)), fixtures: [], mocks: [], helpers: [] });
    }
    if (operation.operation_id === "core:inspect_architecture") {
      const containers = maps.entities.filter((record) => record.universal_kind === "core:container");
      const publicSurfaces = maps.entities.filter((record) => record.universal_kind === "core:type" && !String(record.body["name"] ?? "").startsWith("_"));
      return evaluated({ entry_points: containers.map((record) => item(record)), public_surfaces: publicSurfaces.map((record) => item(record)), layers: [] });
    }
    if (operation.operation_id === "core:discover_definitions") {
      return evaluated(discoverDefinitions(args));
    }
    return evaluated(Object.fromEntries(operation.result_streams.map((stream) => [stream, []])));
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
