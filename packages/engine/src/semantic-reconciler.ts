import { canonicalBytes, decodeCanonical, digestBytes } from "@urdira/canonical";
import { canonicalVectorBytes as storageCanonicalVectorBytes, hydrateRelationalValue, type RelationalValueRow, type SqliteCommand, type VectorProjectionInput, type WorkspaceDatabase } from "@urdira/storage";
import { buildSemanticDocument } from "./semantic-documents.js";
import type { ResolvedSemanticProvider } from "./semantic-provider.js";
import { canonicalVectorBytes as engineCanonicalVectorBytes, vectorValues, type Segmentation, type SemanticGeneratedVector } from "./semantic-runtime.js";

/**
 * Stable identity for one workspace-generation-profile materialization,
 * used by the daemon's `core:index_status` view (`SemanticMaterializationStatusView`,
 * `packages/daemon/src/runtime.ts`). Lives here rather than in the daemon
 * because the digest primitives are `@urdira/canonical`, which the daemon's
 * architecture manifest deliberately does not allow it to import directly --
 * identity construction is engine-owned, like `semanticMaterializationId` in
 * `semantic-updater.ts` (which digests a different, snapshot-keyed input and
 * so cannot be reused for this per-profile view id).
 */
export function semanticMaterializationIdentity(input: { readonly workspace_id: string; readonly generation: number; readonly profile_id: string }): string {
  return `semantic-materialization:${digestBytes(canonicalBytes({ workspace_id: input.workspace_id, generation: input.generation, profile_id: input.profile_id }))}`;
}

/**
 * Identity of one vector projection row: the semantic document's own id
 * (a pure function of `(artifact_id, artifact_version_id)`, or -- for an
 * entity-grain document, decision 17 -- a pure function of the owning entity
 * RECORD id, see `entityDocumentId` below) SCOPED BY the exact vector space
 * that produced the vector. The profile/binding pair MUST participate here
 * because `vector_projection_rows`'s primary key is `(workspace_id,
 * projection_record_id, valid_from_generation)` -- NOT profile-scoped -- and
 * `generation` only ever advances when source content changes. A provider
 * swap over an UNCHANGED workspace therefore rebuilds every vector at the
 * exact same generation its predecessor was written under; with an unscoped
 * id the new row would collide with the just-closed old-profile row's
 * primary key on every document and could never succeed until an unrelated
 * source edit happened to move the generation (observed live: swapping
 * `core:local-hash-256-v1` -> `core:onnx-...` on an already ready workspace
 * failed all 975 inserts, forever). Scoping the id by vector space makes
 * cross-profile collision structurally impossible and keeps closed rows from
 * every previous provider intact as history.
 */
export function semanticVectorProjectionRecordId(input: { readonly document_id: string; readonly profile_id: string; readonly executable_binding_id: string; readonly segment_index?: number }): string {
  // Frente S-B (2026-09-06, decision 17 segmentation): `segment_index`
  // folds into this id for an entity-grain document (one vector PER
  // segment, plan §4.5) -- omitted (not `0`) for every artifact-grain call
  // and every pre-segmentation entity call, so a caller that never
  // segments (single-segment documents, the common case) keeps computing
  // the IDENTICAL id it always has; only a document with 2+ segments ever
  // needs more than one distinct id for the same `document_id`.
  return `semantic-vector:${digestBytes(canonicalBytes({ document_id: input.document_id, profile_id: input.profile_id, executable_binding_id: input.executable_binding_id, ...(input.segment_index === undefined ? {} : { segment_index: input.segment_index }) }))}`;
}

/**
 * Decision 17: `document_id` for an entity-grain semantic document -- a PURE
 * function of the owning entity RECORD id alone (no policy knob, no file
 * content, no owner artifact version), so an entity record reused unchanged
 * across a file edit (same `record_id`, decision 11's content-derived
 * identity) keeps the exact same `document_id`, and therefore the exact same
 * `semanticVectorProjectionRecordId` once scoped by vector space -- its
 * vector survives the edit untouched, never closed and re-embedded. Distinct
 * digest input shape (`{record_id}` only, no `artifact_id`/`artifact_version_id`
 * fields) than `buildSemanticDocument`'s artifact-grain `document_id`, so the
 * two id spaces can never collide even before the `entity-document:` prefix
 * is considered.
 */
function entityDocumentId(recordId: string): string {
  return `entity-document:${digestBytes(canonicalBytes({ record_id: recordId }))}`;
}

/**
 * Minimal content-addressed reader the reconciler needs to fetch a version's
 * raw bytes by `content_hash`; `ContentAddressedStore` (`@urdira/storage`,
 * `DurableStorage.cas`) satisfies this directly -- same shape as
 * `LexicalReconcilerContentReader` (`lexical-reconciler.ts`) and
 * `CanonicalQuerySnapshotPort`'s `ContentReader` (`canonical-query-data-port.ts`).
 */
export interface SemanticReconcilerContentReader {
  readonly read: (content_hash: string) => Promise<Uint8Array>;
}

/**
 * v4 storage wiring (2026-09-07): one candidate entity-category record, already
 * decoded, from whatever store actually holds the structural corpus -- v3's
 * default source (below) reads `record_occurrences`/`record_value_nodes` via
 * `sql`, exactly as this reconciler always has; a v4-storage caller
 * (`packages/daemon/src/runtime.ts`/`semantic-maintenance-process.ts`) instead
 * builds one on top of the native structural store's `CanonicalQuerySnapshotPort`
 * (`createNativeSemanticEntityRecordSource`, `semantic-entity-source-v4.ts`),
 * since `record_occurrences`/`record_value_nodes` do not exist at all in the
 * v4 catalog schema (docs/evidence/2026-09-02-v4-p2-1-schema.md) -- every
 * OTHER table this reconciler touches (`artifact_versions`, `source_artifacts`,
 * `vector_projection_rows`, `semantic_document_status`, `semantic_index_state`)
 * is kept byte-identical between v3 and v4, so only the entity-candidate
 * enumeration and stale-visibility check below need a pluggable source at all.
 * `body` is ALWAYS already decoded here (unlike `MissingEntityRow.body_payload`'s
 * lazy v3 decode) -- a v4 native-store scan has already paid that cost by the
 * time a record reaches this shape, so there is no laziness left to preserve.
 */
export interface SemanticEntityCandidateRow {
  readonly record_id: string;
  /** The record `kind` column value (e.g. `"jsts:entity_container"`, matching `INELIGIBLE_ENTITY_RECORD_KIND`, or a real entity kind). */
  readonly record_kind: string;
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly content_hash: string;
  readonly byte_length: number;
  readonly display_path: string | null;
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * Pluggable entity-record source (see `SemanticEntityCandidateRow`'s own doc
 * comment for why this exists). `ReconcileSemanticProjectionInput.entity_record_source`
 * left `undefined` (every v3 caller, and every existing test in
 * `tests/semantic-maintenance.test.ts`) keeps this reconciler's original,
 * unmodified `record_occurrences`/`record_value_nodes`-backed behavior byte-
 * for-byte -- this interface, and the branches that consult it, are pure
 * additions, never a rewrite of the v3 path.
 */
export interface SemanticEntityRecordSource {
  /**
   * Streams every visible entity-category candidate record at the
   * workspace's CURRENT generation, including the ineligible container kind
   * (the caller splits by `record_kind` itself, mirroring the two separate
   * v3 SQL queries this replaces) and excluding any record whose owning
   * file is missing/binary. Frente S-E (2026-09-07): this used to return
   * one `Promise<readonly SemanticEntityCandidateRow[]>` holding EVERY
   * candidate at once -- a confirmed OOM at n8n scale (326,817 candidates,
   * see `createNativeSemanticEntityRecordSource`'s own doc comment). Now a
   * page-callback: `onPage` is invoked once per bounded page (order not
   * contractually significant -- NOT globally sorted, since a streaming
   * source cannot guarantee cross-page adjacency; callers that benefit from
   * owner-version grouping for CAS text-read locality must cache across
   * pages themselves, e.g. a small bounded LRU), and the returned promise
   * resolves once every page has been delivered and every `onPage` call has
   * itself resolved. A caller that needs the data more than once (this
   * reconciler's container-backfill step and its entity missing-insert step
   * both do) must call this method AGAIN for the second need -- a streaming
   * source cannot be replayed from a cache without reintroducing the exact
   * O(corpus) buffering this change removes. This trades one extra full
   * corpus scan for O(page) memory, a fair trade against an unconditional
   * OOM.
   */
  entityCandidates(onPage: (page: readonly SemanticEntityCandidateRow[]) => Promise<void>): Promise<void>;
  /** Of the given record ids, the subset that is STILL VISIBLE at the workspace's CURRENT generation -- used both for the entity stale-close step and the orphaned-status-row sweep. Documented simplification versus v3 (see `createNativeSemanticEntityRecordSource`'s own doc comment): a v4 caller cannot recover the EXACT generation a now-invisible record stopped being visible at, only that it currently is not -- every v4-sourced close/sweep therefore closes/deletes AS OF the pass's own current generation, never a historically exact one. */
  visibleRecordIds(ids: readonly string[]): Promise<ReadonlySet<string>>;
}

export interface ReconcileSemanticProjectionInput {
  readonly database: WorkspaceDatabase;
  readonly workspace_id: string;
  readonly content: SemanticReconcilerContentReader;
  /** The resolved embedding provider (profile identity + runtime binding) this pass embeds and writes vectors under. See the profile-swap-close step below for what happens when this differs from whatever provider a PRIOR pass used. */
  readonly provider: ResolvedSemanticProvider;
  /**
   * Documents whose declared `byte_length` exceeds this are skipped entirely
   * (never read from CAS, never embedded) -- same bound and same rationale as
   * `ReconcileLexicalProjectionInput.max_document_bytes` (`lexical-reconciler.ts`):
   * it caps per-file cost on giant bundled/generated files. Defaults to 2 MB.
   * Applies identically to the entity pass's own owning-file reads (step 5
   * below): an entity whose owning file is oversized is skipped along with
   * every other entity in that same file, without ever reading its text.
   */
  readonly max_document_bytes?: number;
  /**
   * How many pending documents (post empty-filter, post oversized/undecodable
   * skip) the missing-vector insert loops (steps 3 and 5 below) collect
   * before calling the provider, so that ONE call embeds up to this many
   * documents at once via `provider.binding.generateVectors` (when the
   * binding implements it) instead of one `generateVector` call per document.
   * Defaults to 16. Set to `1` to disable batching outright: every batch
   * then holds exactly one document, which reproduces the pre-batching
   * behavior exactly, INCLUDING its abort-checkpoint granularity (see
   * `should_abort`'s doc comment below -- with batches of size 1, "check
   * between batches" is once again "check before every document"). Threaded
   * by the composing application (`apps/urdira`) from the
   * `URDIRA_SEMANTIC_EMBED_BATCH` environment variable; a non-positive-integer
   * value is treated as unset (falls back to the default). The artifact pass
   * (step 3) and the entity pass (step 5) each collect their OWN batch of up
   * to this many documents -- they do not share one combined batch across
   * the two passes, but both dispatch through the exact same embed+commit
   * machinery (`commitGeneratedVector`/`embedAndCommitBatch` below), so
   * batching behavior (including this abort-checkpoint granularity) is
   * identical for both.
   */
  readonly embed_batch_size?: number;
  /**
   * Decision 17 eligibility policy knobs for the entity pass (step 5),
   * defaulted when omitted. Unlike `max_document_bytes`/`embed_batch_size`,
   * these never participate in any document's `document_id` or
   * `projection_record_id` (see `entityDocumentId`'s own doc comment for why
   * that identity is pinned to the record id alone) -- they only gate WHICH
   * visible entity records this pass attempts to render and embed at all.
   * A policy change is therefore never retroactive: raising the threshold
   * does not close vectors already embedded under a looser prior policy (no
   * step re-evaluates a previously-eligible, still-visible record's
   * eligibility), and lowering it simply lets previously-skipped records
   * start showing up as "missing" on the next pass, same as any other
   * previously-ineligible-now-eligible transition.
   */
  readonly entity_policy?: {
    /** Minimum `end - start` character span (decision 17's measured policy). Defaults to 120. */
    readonly min_span_length?: number;
    /**
     * Frente S-D (2026-09-07, Lever 1/4): caps how many gap segments (the
     * file text NOT covered by any eligible entity span) the artifact-vector
     * composition embeds for one document, independent of the provider's own
     * `max_segments` (R8, `DEFAULT_MAX_SEGMENTS` = 64). Gaps are typically
     * small (imports/exports/module comments -- plan §4's own framing), so
     * this is left undefined (no extra cap beyond the provider's own) unless
     * n8n-scale measurement shows the provider's full cap is still too
     * costly for gaps specifically, in which case a smaller value (plan's
     * own suggested floor: 16) truncates further, folding
     * `reason_code: "segments_truncated"` into the artifact's status row
     * exactly like any other truncation (R8's own "never silent" rule) --
     * never applied to entity-grain segmentation, which stays governed by
     * the provider's own `max_segments` alone (entity vector fidelity is
     * explicitly out of scope for this lever).
     */
    readonly max_gap_segments?: number;
  };
  /**
   * Optional cooperative-cancellation check, polled once per stale-vector
   * close (right before each row's own work begins, alongside the existing
   * per-row `yieldToEventLoop` checkpoint -- see that function's doc
   * comment) and, in the missing-vector insert loops (steps 3 and 5), once
   * per BATCH of up to `embed_batch_size` documents -- right before the
   * FIRST row of a fresh batch does any of its own read/decode/filter work,
   * not before every individual document's own work, which the batch itself
   * already amortizes (see `embed_batch_size`'s own doc comment for the `1`
   * special case that restores per-document granularity exactly, since a
   * batch of one returns to "empty" -- and therefore re-checked -- after
   * every single document). This exactly mirrors `ReconcileLexicalProjectionInput.should_abort`'s
   * semantics one layer up: when it returns `true`, the pass stops
   * immediately -- it does NOT run the current-generation recheck and does
   * NOT call `markSemanticComplete`, so a later pass simply resumes from
   * wherever the missing-vector query finds gaps. Rows already committed
   * before the abort was observed stay committed -- each is its own atomic
   * `putVectors` call (or, for closes, its own atomic single-row `UPDATE`);
   * a batch that was still being collected (or already collected but not yet
   * dispatched) when the abort fired is simply discarded uncommitted (no
   * read/decode work it did is persisted anywhere), safe because the next
   * pass's own queries find the exact same rows again.
   */
  readonly should_abort?: () => boolean;
  /** Wait for foreground query work to drain before background generation or
   * a vector commit begins. */
  readonly wait_for_query_drain?: () => Promise<void>;
  /**
   * v4 storage wiring (2026-09-07): when provided, the entity stale-close
   * step (4), the entity missing-insert step (5), and the two entity-shaped
   * bulk status statements inside `syncDocumentStatusBulk` (the ineligible-
   * container backfill and the orphan sweep) all use THIS source instead of
   * their default `record_occurrences`/`record_value_nodes` SQL -- see
   * `SemanticEntityRecordSource`'s own doc comment. Every other step
   * (profile-swap close, artifact stale-close, artifact missing-insert,
   * the artifact-shaped bulk status statements) is untouched by this field
   * -- `artifact_versions`/`source_artifacts` are identical in v3 and v4.
   * Left `undefined` (every v3 caller), this reconciler's original
   * behavior is completely unmodified.
   */
  readonly entity_record_source?: SemanticEntityRecordSource;
  /**
   * Frente S-D (2026-09-07, Lever 2): when provided, this call handles only
   * documents whose OWNING artifact id hashes to `index` (of `count` total
   * shards, deterministic via `shardIndexFor` below) -- the artifact and
   * entity missing-insert loops (steps 3 and 5) are filtered to that subset,
   * so a caller runs `count` CONCURRENT calls (typically one per child
   * process, see `@urdira/daemon`'s `runSemanticReconcileSharded`) each with
   * a distinct `index`, splitting the embed work across processes to use
   * more than one CPU core (measured ~1.44x at 2 concurrent processes on a
   * 10-core machine, `docs/evidence/2026-09-07-v4-semantic-wiring-and-embed-performance.md`
   * §2.3). Sharding is BY OWNING ARTIFACT (never by entity record or
   * segment) so an artifact document and every one of its own eligible
   * entities always land in the SAME shard/process -- required for Lever 1's
   * `entityCoverageByOwner` to ever fire inside a sharded call (an entity
   * embedded by a DIFFERENT process could never be composed into this
   * process's artifact vector).
   *
   * A sharded call NEVER runs steps 1/2/4 (workspace-wide, grain-agnostic or
   * artifact-stale-close/entity-stale-close -- unscoped by shard, so running
   * them from every shard would race redundant writes against the same
   * SQLite catalog) except when `index === 0` (one designated shard still
   * runs them, since SOMEONE must -- harmless if another shard's identical,
   * idempotent statements also ran, since `UPDATE ... WHERE valid_to_generation
   * IS NULL AND ...` naturally finds zero matching rows the second time).
   * A sharded call NEVER runs `syncDocumentStatusBulk` and NEVER writes the
   * completion marker, regardless of `index` or how clean its own pass was
   * -- see `runSemanticReconcileSharded`'s own doc comment for why: only the
   * ORCHESTRATOR, after every shard resolves, can safely conclude "the whole
   * workspace is caught up," by making one final UNSHARDED call (which finds
   * nothing left to do in the common case and reaches this function's
   * ordinary marker-write logic naturally, self-healing any single shard's
   * `failed`/`entity_failed` rows as a side effect of retrying them
   * unsharded). `marker_written` is therefore always `false` in a sharded
   * call's own result.
   */
  readonly shard?: { readonly index: number; readonly count: number };
}

/**
 * Frente S-D (2026-09-07, Lever 2): deterministic shard assignment for one
 * owning artifact id -- the low 32 bits of `digestBytes(artifactId)` (SHA-256,
 * `@urdira/canonical`) reduced mod `shardCount`. Pure and stable across
 * processes/hosts/runs (SHA-256 of the same UTF-8 bytes is always the same
 * bytes), which is the whole point: every shard process computes the IDENTICAL
 * assignment for the same `artifactId` independently, with no coordination.
 */
export function shardIndexFor(artifactId: string, shardCount: number): number {
  if (!Number.isSafeInteger(shardCount) || shardCount <= 0) throw new Error("shardIndexFor shardCount must be a positive integer.");
  const digest = digestBytes(new TextEncoder().encode(artifactId));
  const hex = digest.slice(digest.length - 8);
  return Number(BigInt(`0x${hex}`) % BigInt(shardCount));
}

export interface ReconcileSemanticProjectionResult {
  /** The workspace generation this pass reconciled against (`0` if the workspace has never published). */
  readonly generation: number;
  /** Artifact-grain vector rows closed this pass -- profile-swap closes (step 1, any grain), artifact stale closes (step 2), AND entity stale closes (step 4) all add to this combined total; see `entity_closed` for the entity-only breakdown. */
  readonly closed: number;
  /** Artifact-grain vectors newly embedded and written this pass (step 3). */
  readonly inserted: number;
  /** Visible, non-`binary`-encoded versions skipped because their declared byte length exceeded `max_document_bytes`. */
  readonly skipped_oversized: number;
  /** Visible, non-`binary`-encoded versions skipped because their CAS bytes did not actually decode as clean UTF-8 text (same defensive re-check as `reconcileLexicalProjection`'s `decodeText`). */
  readonly skipped_undecodable: number;
  /** Decodable versions skipped because their rendered document text contained no embeddable token (no `[A-Za-z0-9_$]` character) -- see the doc comment on the empty-text check below for why this is a pre-check rather than a caught provider throw. */
  readonly skipped_empty: number;
  /** Versions whose embedding provider call threw for a reason OTHER than "no embeddable token" -- left missing, retried on the next pass (see the doc comment on the insert loop for the retry-forever tradeoff this implies). */
  readonly failed: number;
  /** Decision 17: entity-grain vectors newly embedded and written this pass (step 5). Frente S-B (2026-09-06): counts SEGMENTS, not documents -- a multi-segment entity contributes one unit here per segment successfully committed, not one per document (a single-segment entity, the common case, still contributes exactly one, unchanged from before segmentation existed). */
  readonly entity_inserted: number;
  /** Decision 17: entity-grain vector rows closed this pass (step 4) because their owning entity record is no longer visible. A SUBSET of `closed` above, not an addition to it -- see `closed`'s own doc comment. Frente S-B: counts individual SEGMENT rows closed, not documents. */
  readonly entity_closed: number;
  /** Decision 17: candidate entity records skipped because their OWNING FILE's declared byte length exceeded `max_document_bytes` -- every other entity in that same file is skipped for the identical reason, without ever reading its text. */
  readonly entity_skipped_oversized: number;
  /** Decision 17: candidate entity records skipped because their owning file's CAS bytes did not decode as clean UTF-8 text. */
  readonly entity_skipped_undecodable: number;
  /** Decision 17: candidate entity records whose owning file WAS readable, but which failed the eligibility policy itself (body `kind` is `"parameter"`, span shorter than `min_span_length`, or not a top-level (column-0) declaration -- see `evaluateEntityEligibility`). Permanent for this content, same as `skipped_oversized`/`skipped_undecodable`/`skipped_empty` -- never retried unless the record's own content changes or the policy is loosened. */
  readonly entity_skipped_ineligible: number;
  /** Decision 17: eligible, decodable entity documents skipped because their rendered text contained no embeddable token. */
  readonly entity_skipped_empty: number;
  /** Decision 17: entity documents whose embedding provider call threw for a reason other than "no embeddable token" -- left missing, retried on the next pass, and (like `failed`) withholds the completion marker until it clears. Frente S-B: counts SEGMENTS, not documents (see `entity_inserted`'s own doc comment) -- one failed segment marks its WHOLE owning document `failed` in `semantic_document_status` (`recordEntitySegmentOutcome`), even though only that one segment's own row failed to write. */
  readonly entity_failed: number;
  /** Whether `semantic_index_state.completed_generation` (plus the provider identity fields, plus `document_grains: ["artifact", "entity"]`) was advanced to `generation` -- `false` when a concurrent scan bumped the workspace's current generation while this pass ran, or when either the artifact or the entity step left any `failed`/`entity_failed` row behind (see the function doc comment). */
  readonly marker_written: boolean;
  /**
   * `true` only when `should_abort` fired and stopped this pass early.
   * Omitted (not merely `false`) on every ordinary completed pass, so exact-
   * shape assertions in `tests/semantic-maintenance.test.ts` (`expect(...).toEqual({...})`)
   * keep passing unchanged: Vitest/Jest's `toEqual` treats an absent key the
   * same as one explicitly set to `undefined`, but NOT the same as one set to
   * `false` -- see `ReconcileLexicalProjectionResult.aborted`'s identical
   * doc comment for the full reasoning.
   */
  readonly aborted?: boolean;
}

const DEFAULT_MAX_DOCUMENT_BYTES = 2_000_000;
/** Default for `ReconcileSemanticProjectionInput.embed_batch_size` -- see its own doc comment. */
const DEFAULT_EMBED_BATCH_SIZE = 16;
/** v4 storage wiring: batch size for the `entity_record_source`-backed bulk status statements (`syncDocumentStatusBulk`'s container backfill and orphan sweep) -- bounds both the SQLite parameter/statement count per `sql.transaction`/`IN (...)` call and, for the sweep, keeps a single `IN` clause well under any runtime's bound-variable ceiling. */
const ENTITY_STATUS_BATCH_SIZE = 200;

function chunk<T>(values: readonly T[], size: number): readonly T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

/**
 * Frente S-D (2026-09-07, Lever 1): merges a set of `[start, end)` character
 * spans (`end > start`, both UTF-16 code unit offsets into the same owning
 * text) into their minimal sorted, disjoint form -- adjacent (`span.start <=
 * last.end`) or overlapping spans collapse into one. Pure; does not mutate
 * `spans`. Used by `reconcileSemanticProjection`'s artifact-vector
 * composition to turn a file's ELIGIBLE entity spans into the covered-region
 * set before `complementSpans` computes the "gap" (not-covered) text.
 * Frente S-E (2026-09-07): exported (was module-private) so
 * `tests/semantic-maintenance.test.ts` exercises this exact merge algorithm
 * directly -- in particular the "a method's span nested inside its owning
 * class's span" case (both eligible under a hypothetical looser policy, or
 * simply two spans that happen to overlap): the wider span absorbs the
 * narrower one into ONE merged region, so `complementSpans`'s gap
 * computation -- and therefore the composed artifact vector's mean-pool --
 * never double-counts the overlapping text as two separate components.
 */
export function mergeSpans(spans: readonly { readonly start: number; readonly end: number }[]): readonly { readonly start: number; readonly end: number }[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<{ start: number; end: number }> = [{ ...sorted[0]! }];
  for (const span of sorted.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/**
 * Frente S-D (2026-09-07, Lever 1): the complement of `coveredSpans` (already
 * merged, sorted, disjoint -- callers pass `mergeSpans`'s own output) within
 * `[0, length)` -- the file-text regions NOT covered by any eligible entity,
 * i.e. the "gap" text the artifact-vector composition still embeds fresh
 * (plan §4's own framing: "huecos... típicamente imports/exports/comentarios:
 * pequeño"). An empty `coveredSpans` returns `[{start: 0, end: length}]` (the
 * whole text is one gap) -- the "zero eligible entities" fallback case.
 */
export function complementSpans(coveredSpans: readonly { readonly start: number; readonly end: number }[], length: number): readonly { readonly start: number; readonly end: number }[] {
  const gaps: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const span of coveredSpans) {
    if (span.start > cursor) gaps.push({ start: cursor, end: span.start });
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < length) gaps.push({ start: cursor, end: length });
  return gaps;
}

/**
 * Frente S-D (2026-09-07, Lever 1): the artifact-vector composition itself --
 * decodes every already-embedded packed `vectors` component back to raw
 * values (`vectorValues`, `./semantic-runtime.js`), takes their plain
 * elementwise mean (every component -- an entity segment or a gap segment --
 * counts equally, mirroring `@urdira/embedding-local`'s own
 * `meanPoolWindowVectors` "every window counts equally" convention for
 * intra-document window pooling), then re-encodes through the SAME canonical
 * decode/normalize/encode pass (`canonicalVectorBytes`, same module) every
 * other vector this codebase produces goes through -- never a hand-duplicated
 * approximation of it (see `commitGeneratedVector`'s own doc comment for the
 * regression a duplicated normalize pass caused previously). Throws when
 * `vectors` is empty; callers must never invoke this for a document with zero
 * available components (see the `skipped_empty` handling at this function's
 * own call site in `reconcileSemanticProjection`).
 */
function combineVectorsMeanNormalized(vectors: readonly Uint8Array[], profile: { readonly dimensions: number; readonly element_type: string; readonly normalization: string }): Uint8Array {
  if (vectors.length === 0) throw new Error("combineVectorsMeanNormalized requires at least one component vector.");
  const elementType = profile.element_type === "float64" ? "float64" as const : "float32" as const;
  const decoded = vectors.map((vector) => vectorValues(vector, { dimensions: profile.dimensions, element_type: elementType, normalization: "none" }));
  const mean = new Array<number>(profile.dimensions).fill(0);
  for (const values of decoded) for (let index = 0; index < profile.dimensions; index += 1) mean[index]! += values[index]! / decoded.length;
  return engineCanonicalVectorBytes(mean, { dimensions: profile.dimensions, element_type: elementType, normalization: profile.normalization === "l2" ? "l2" : "none" });
}
// Frente S-B (2026-09-06, plan §4.4/S-B.1): `DEFAULT_MIN_ENTITY_SPAN_LENGTH`,
// `evaluateEntityEligibility`, `renderEntityDocument`, `leadingDocComment`,
// `decodeEntityRecordBody`, `EntityEligibility`, and the two ineligibility
// constants below are exported (were module-private) so
// `scripts/semantic-window-histogram.mjs` -- and this package's own
// `tests/`, and any future caller -- enumerate/render CANDIDATE documents
// using the EXACT SAME algorithm this reconciler's own entity pass (step 5)
// runs, never a duplicated, driftable reimplementation.
/** Default for `ReconcileSemanticProjectionInput.entity_policy.min_span_length` -- decision 17's measured policy (excalidraw-scale gate: 2,544 eligible docs at this threshold). */
export const DEFAULT_MIN_ENTITY_SPAN_LENGTH = 120;
/** The record `kind` column value for whole-file/module entity records -- decision 17's measurement-driven policy amendment: these duplicate the artifact-grain document of the same file (654 of them on the bench corpus, some 400KB+), so they are never entity-eligible regardless of span length. See `packages/plugin-javascript-typescript/src/fact-delta.ts`'s `proposalRecord` for where this kind string is produced. */
export const INELIGIBLE_ENTITY_RECORD_KIND = "jsts:entity_container";
/** Body `kind` values (the analyzer's own per-entity `kind`, e.g. `"function"`/`"class"`/`"variable"`/`"parameter"`) that are never entity-eligible regardless of span or position. */
export const INELIGIBLE_ENTITY_BODY_KINDS = new Set(["parameter"]);

/**
 * Hands control back to the event loop's I/O phase between documents -- the
 * exact same rationale as `lexical-reconciler.ts`'s `yieldToEventLoop` (see
 * its doc comment for the full measurement-backed argument for `setImmediate`
 * specifically over a resolved promise or `setTimeout(fn, 0)`). It applies
 * here just as much as it does to lexical FTS5 maintenance: the bundled
 * local hash embedder's `generateVector` (`semantic-provider.ts`) is a
 * synchronous, allocation-heavy regex/hash/accumulation pass over an entire
 * document's text, run on THIS thread, for every document this loop touches.
 * An HTTP-backed provider's `generateVector` instead spends most of its time
 * awaiting a real network round trip, which already yields to the event loop
 * on its own -- but yielding again afterward is harmless and keeps this
 * reconciler's behavior uniform across providers rather than conditional on
 * which one happens to be configured.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Mirrors `lexical-reconciler.ts`'s `decodeText` (itself mirroring
 * `source-indexer.ts`'s scan-time decision) exactly: a version containing a
 * NUL byte, or bytes that are not well-formed UTF-8, is not "text" regardless
 * of its stored `encoding` label. Every version this reconciler considers
 * already has `encoding <> 'binary'` (see the missing-vector queries below),
 * which the current single writer of that column (`source-indexer.ts`'s
 * `applyBatch`) only ever sets from this exact predicate -- so this re-check
 * is expected to always pass for versions written by this codebase's own
 * scan path, and exists purely as a defensive guard against a differently-
 * produced or hand-repaired `artifact_versions` row.
 */
function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.some((byte) => byte === 0)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return undefined; }
}

/**
 * The bundled local hash embedder's own tokenizer (`extractLocalHashTokens`,
 * `semantic-provider.ts`) extracts `[A-Za-z0-9_$]+` runs and throws when none
 * exist -- but an HTTP-backed provider has no such contract, and reaching
 * into a provider's internals (or matching a specific thrown `Error` message)
 * to detect "empty" would couple this reconciler to one specific
 * implementation. Running the SAME regex here, BEFORE ever calling
 * `provider.binding.generateVector`, classifies "no embeddable token" the
 * same way for every provider without depending on any of them, and it means
 * an empty document costs nothing beyond a single `.test()` call -- no
 * network round trip, no provider-specific error inspection. Any OTHER
 * provider throw (network failure, malformed response, timeout, ...) is
 * therefore unambiguously a real failure (`failed`/`entity_failed`), never
 * `skipped_empty`/`entity_skipped_empty`.
 */
const EMBEDDABLE_TOKEN_PATTERN = /[A-Za-z0-9_$]/;

/** A run of Unicode whitespace, used by `leadingDocComment`'s backward scan. */
const WHITESPACE_PATTERN = /\s/;

// `type` (not `interface`) so these structurally satisfy the `SqliteDatabase.all<T
// extends Record<string, unknown>>` constraint without an explicit index
// signature -- matching `StaleDocumentRow`/`MissingDocumentRow` in
// `lexical-reconciler.ts` and `RecordRow` in `canonical-query-data-port.ts`.
type StaleVectorRow = {
  readonly projection_record_id: string;
  readonly valid_from_generation: number;
  readonly closing_generation: number;
  /** Plan 2026-09-06 (Frente S-A): the `semantic_document_status` document id this row's status entry is keyed by -- `owner_artifact_version_id` for step 2's artifact-grain query, `document_ref` (the owning entity record id) for step 4's entity-grain query -- aliased to this one column name by both queries. */
  readonly document_id: string;
};

type MissingVectorRow = {
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly content_hash: string;
  readonly byte_length: number;
  readonly valid_from_generation: number;
  readonly display_path: string | null;
};

/** Decision 17: one candidate entity record for the entity missing-insert step (step 5), joined against its CURRENT owning artifact version's CAS/encoding metadata in one query -- see that step's own doc comment for why this owner may be a CLOSED (historical) version. */
type MissingEntityRow = {
  readonly record_id: string;
  readonly record_kind: string;
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly valid_from_generation: number;
  readonly content_hash: string;
  readonly byte_length: number;
  readonly display_path: string | null;
  readonly body_payload: Uint8Array | ArrayBuffer | null;
};

export function decodeEntityRecordBody(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Decision 17 eligibility (PINNED, see the spec's "Eligibility" section):
 * the record `kind` column must not be the whole-file/module kind
 * (`INELIGIBLE_ENTITY_RECORD_KIND`); the BODY `kind` field (the analyzer's
 * own per-entity kind, e.g. `"function"`/`"class"`/`"namespace"`) must not be
 * `"parameter"`; the span `end - start` must be at least `minSpanLength`
 * characters; and the declaration's LINE must start at column 0, i.e. the
 * line containing `start` must not begin with indentation. The line-based
 * test (not `start === 0 || fileText[start - 1] === "\n"`) is load-bearing
 * and matches the doc's measurement bench exactly: a top-level
 * `const x = ...` variable's entity `start` points at the
 * VariableDeclaration node (`x`, AFTER the `const `/`export const `
 * keywords), so a declaration-position test silently rejects every
 * top-level variable -- 2,008 of the doc's 2,544 measured eligible docs
 * (observed live: 541 entity vectors instead of ~2.5k). Indented
 * locals/members still fail (their line starts with whitespace); top-level
 * declarations of every kind (including namespaces) pass. `fileText` is the
 * OWNING FILE's full decoded text -- `start`/`end` are UTF-16 code unit
 * offsets into it, exactly as the TypeScript compiler produced them
 * (`packages/plugin-javascript-typescript/src/analyzer.ts`'s `JsTsEntity.start`/`.end`),
 * so they index `fileText` directly with no translation.
 */
export type EntityEligibility =
  | { readonly eligible: false }
  | { readonly eligible: true; readonly kind: string; readonly label: string; readonly start: number; readonly end: number };

export function evaluateEntityEligibility(recordKind: string, body: Record<string, unknown>, fileText: string, minSpanLength: number): EntityEligibility {
  if (recordKind === INELIGIBLE_ENTITY_RECORD_KIND) return { eligible: false };
  const kind = typeof body["kind"] === "string" ? body["kind"] as string : undefined;
  if (kind === undefined || INELIGIBLE_ENTITY_BODY_KINDS.has(kind)) return { eligible: false };
  const start = typeof body["start"] === "number" ? body["start"] : undefined;
  const end = typeof body["end"] === "number" ? body["end"] : undefined;
  if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end)) return { eligible: false };
  if (start < 0 || end > fileText.length || end - start < minSpanLength) return { eligible: false };
  let lineStart = start;
  while (lineStart > 0 && fileText[lineStart - 1] !== "\n") lineStart -= 1;
  if (lineStart !== start && (fileText[lineStart] === " " || fileText[lineStart] === "\t")) return { eligible: false };
  const name = typeof body["name"] === "string" ? body["name"] : undefined;
  const qualifiedName = typeof body["qualified_name"] === "string" ? body["qualified_name"] : undefined;
  const label = qualifiedName ?? name;
  if (label === undefined) return { eligible: false };
  return { eligible: true, kind, label, start, end };
}

/**
 * Decision 17 leading-doc-comment scan (PINNED): starting at `start`, walk
 * backward over Unicode whitespace only; if the text immediately before that
 * whitespace run is a `/** ... *\/` block, return it verbatim (comment
 * delimiters included) -- otherwise `undefined`. Deliberately naive (a plain
 * `lastIndexOf("/**", ...)`, not a real comment/string-literal-aware
 * tokenizer): a `/**` occurring inside an unrelated string literal earlier in
 * the file could in principle be mismatched into this scan, but only when it
 * is itself immediately followed by a matching `*\/` and then only
 * whitespace up to `start` -- a false positive here costs nothing but a
 * slightly odd-looking rendered document, never a correctness problem for
 * embedding eligibility itself.
 */
export function leadingDocComment(text: string, start: number): string | undefined {
  let index = start;
  while (index > 0 && WHITESPACE_PATTERN.test(text[index - 1]!)) index -= 1;
  if (index < 2 || text[index - 2] !== "*" || text[index - 1] !== "/") return undefined;
  const openIndex = text.lastIndexOf("/**", index - 3);
  if (openIndex === -1) return undefined;
  return text.slice(openIndex, index);
}

/** Decision 17 rendering (PINNED): `<kind> <label>\n<leading doc comment if present>\n<source span text>`. Truncation to the provider's own document budget happens inside the provider itself (see `semantic-provider.ts`'s `HTTP_INPUT_TEXT_CAP` for the HTTP path; the bundled local providers embed the full text) -- exactly how the artifact pass's own rendered text already reaches the provider today, so this function does no truncation of its own. */
export function renderEntityDocument(input: { readonly kind: string; readonly label: string; readonly docComment: string | undefined; readonly spanText: string }): string {
  const lines = [`${input.kind} ${input.label}`];
  if (input.docComment !== undefined) lines.push(input.docComment);
  lines.push(input.spanText);
  return lines.join("\n");
}

/**
 * Plan 2026-09-06 (Frente S-A): `semantic_document_status` is the source of
 * truth for "which documents are affected (not covered)" -- `core:search_semantic`'s
 * coverage view and `core:semantic_affected_page` both read it, never
 * `vector_projection_rows` directly for anything but the `covered` count.
 * Fixed reason-code vocabulary (plan §4.1): `binary`, `oversized`,
 * `below_min_length`, `unsupported_kind`, `provider_error:*`,
 * `segments_truncated` (segmentation, Frente S-B, not written by this wave),
 * `pending_embed`.
 */
type SemanticDocumentStatus = "covered" | "pending" | "excluded" | "unsupported" | "failed";

/** One `semantic_document_status` upsert -- see that table's own DDL comment (`packages/storage/sql/workspace-v4-semantic.sql`). Reason codes are sorted for a deterministic stored JSON array. `segmentCount` defaults to `1` for `covered` documents (one artifact-or-entity vector; Frente S-B's per-segment count is out of this wave's scope) and `0` otherwise. */
function documentStatusUpsertCommand(input: {
  readonly workspaceId: string; readonly profileId: string; readonly executableBindingId: string;
  readonly documentGrain: "artifact" | "entity"; readonly documentId: string;
  readonly artifactId: string; readonly artifactVersionId: string; readonly displayPath: string;
  readonly status: SemanticDocumentStatus; readonly reasonCodes: readonly string[];
  readonly segmentCount?: number; readonly generation: number; readonly updatedAt: string;
}): SqliteCommand {
  return {
    kind: "run",
    sql: `INSERT INTO semantic_document_status (workspace_id, profile_id, executable_binding_id, document_grain, document_id, artifact_id, artifact_version_id, display_path, status, reason_codes, segment_count, generation, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (workspace_id, profile_id, executable_binding_id, document_grain, document_id) DO UPDATE SET
            artifact_id = excluded.artifact_id, artifact_version_id = excluded.artifact_version_id, display_path = excluded.display_path,
            status = excluded.status, reason_codes = excluded.reason_codes, segment_count = excluded.segment_count,
            generation = excluded.generation, updated_at = excluded.updated_at`,
    params: [
      input.workspaceId, input.profileId, input.executableBindingId, input.documentGrain, input.documentId,
      input.artifactId, input.artifactVersionId, input.displayPath, input.status,
      JSON.stringify([...input.reasonCodes].sort()), input.segmentCount ?? (input.status === "covered" ? 1 : 0),
      input.generation, input.updatedAt,
    ],
  };
}

/** Deletes one `semantic_document_status` row -- used when its underlying artifact version/entity record is no longer visible (plan §4.1's "cierre de versiones"). */
function documentStatusDeleteCommand(input: { readonly workspaceId: string; readonly profileId: string; readonly executableBindingId: string; readonly documentGrain: "artifact" | "entity"; readonly documentId: string }): SqliteCommand {
  return {
    kind: "run",
    sql: "DELETE FROM semantic_document_status WHERE workspace_id = ? AND profile_id = ? AND executable_binding_id = ? AND document_grain = ? AND document_id = ?",
    params: [input.workspaceId, input.profileId, input.executableBindingId, input.documentGrain, input.documentId],
  };
}

/**
 * D-slice semantic sibling of `reconcileLexicalProjection`
 * (`lexical-reconciler.ts`): the async, post-ready maintenance pass the
 * daemon submits after every successful scan, bringing `vector_projection_rows`
 * up to date with `artifact_versions` (and with the CURRENTLY configured
 * embedding provider) as of the workspace's current generation. Source text
 * is read from CAS by `content_hash`, exactly like the lexical reconciler and
 * `core:get_source`.
 *
 * Decision 17 grows a SECOND pass alongside the original artifact pass: one
 * vector per eligible top-level entity RECORD (steps 4-5 below), sharing this
 * function's marker/failure/skip/abort discipline and its embed+commit
 * machinery, but with its own stale-close join (record visibility, not
 * artifact-version visibility -- an unchanged entity record legitimately
 * outlives its original owner artifact version) and its own eligibility
 * policy. `document_grain`/`document_ref` (`vector_projection_rows`,
 * `schema.ts`) discriminate the two lanes; NULL/absent `document_grain`
 * means "artifact" everywhere in this file, matching every row this table
 * held before this column existed.
 *
 * Idempotent and safe to re-run concurrently or after a crash, with one
 * important difference from the lexical reconciler: one artifact version can
 * legitimately have vector rows from SEVERAL vector spaces over its lifetime
 * (every provider swap retires one space and builds another), so a row's
 * identity is the semantic document id scoped by its exact vector space --
 * see `semanticVectorProjectionRecordId`'s doc comment above for why the
 * scoping is load-bearing and not just tidy. The only same-primary-key
 * collision that remains possible is swapping BACK to a previously used
 * provider at an unchanged generation, and that one is resolved by REOPENING
 * the (byte-identical) closed row instead of inserting -- see the insert
 * loop's `catch`.
 */
export async function reconcileSemanticProjection(input: ReconcileSemanticProjectionInput): Promise<ReconcileSemanticProjectionResult> {
  const { database, workspace_id: workspaceId, content, provider, should_abort: shouldAbort } = input;
  const waitForQueryDrain = input.wait_for_query_drain ?? (async () => undefined);
  const maxDocumentBytes = input.max_document_bytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  const embedBatchSize = Number.isSafeInteger(input.embed_batch_size) && input.embed_batch_size! > 0 ? input.embed_batch_size! : DEFAULT_EMBED_BATCH_SIZE;
  const minEntitySpanLength = Number.isSafeInteger(input.entity_policy?.min_span_length) && input.entity_policy!.min_span_length! > 0 ? input.entity_policy!.min_span_length! : DEFAULT_MIN_ENTITY_SPAN_LENGTH;
  const sql = database.database;
  const profileId = provider.profile.embedding_profile_id;
  const executableBindingId = provider.binding.executable_binding_digest;
  const entitySource = input.entity_record_source;
  // Frente S-E (2026-09-07): NO LONGER memoized into one cached array --
  // `entitySource.entityCandidates()` now streams bounded pages (see its own
  // doc comment for why: the prior "materialize everything once, memoize
  // it" shape is exactly the O(corpus) buffering that OOM'd a semantic
  // maintenance child at n8n scale). `syncDocumentStatusBulk`'s container
  // backfill and step 5's missing-insert loop each call `entityCandidates`
  // SEPARATELY (a streaming source cannot be replayed from a cache) -- one
  // extra full corpus scan, traded for O(page) memory instead of O(corpus).

  const currentGeneration = async (): Promise<number | undefined> => {
    const row = await sql.get<{ current_generation: number }>("SELECT current_generation FROM workspace_current_state WHERE workspace_id = ?", [workspaceId]);
    return row?.current_generation;
  };

  // Every counter this function reports, gathered in one mutable record so
  // every return path (including every early abort/unpublished/already-
  // complete return) can build an exact-shape result from whatever has
  // actually happened so far via `buildResult` below, without repeating the
  // full field list at each call site.
  const counts = {
    closed: 0, inserted: 0, skipped_oversized: 0, skipped_undecodable: 0, skipped_empty: 0, failed: 0,
    entity_inserted: 0, entity_closed: 0, entity_skipped_oversized: 0, entity_skipped_undecodable: 0, entity_skipped_ineligible: 0, entity_skipped_empty: 0, entity_failed: 0,
  };
  const buildResult = (generation: number, markerWritten: boolean, aborted?: boolean): ReconcileSemanticProjectionResult => ({
    generation, ...counts, marker_written: markerWritten, ...(aborted === undefined ? {} : { aborted }),
  });

  // Digest of the entity-eligibility policy this pass runs under: the
  // predicate revision (bumped whenever `evaluateEntityEligibility`'s shape
  // changes what qualifies -- revision 2 is the line-based column-0 test
  // that admitted top-level variables) plus the span-length knob. Stored
  // with the completion marker and required to MATCH by the fast path below,
  // so a policy change reaches workspaces whose marker already says
  // "complete": their stored digest (or NULL, for markers predating policy
  // tracking) no longer matches, the fast path falls through, and the entity
  // steps backfill under the new policy while the artifact steps find
  // nothing to do.
  const entityPolicyDigest = digestBytes(canonicalBytes({ predicate: "line-column-0", revision: 2, min_span_length: Number.isSafeInteger(input.entity_policy?.min_span_length) && input.entity_policy!.min_span_length! > 0 ? input.entity_policy!.min_span_length! : DEFAULT_MIN_ENTITY_SPAN_LENGTH }));

  const generation = await currentGeneration();
  if (generation === undefined) return buildResult(0, false);

  const nowIso = (): string => new Date().toISOString();

  /** Cheap existence probe: does `semantic_document_status` already hold at least one row for this exact vector space? Gates whether the fast path below also needs to run the (idempotent, near-zero-cost-once-populated) bulk classification, for a legacy sidecar that predates this table. */
  const hasAnyDocumentStatus = async (): Promise<boolean> => {
    const row = await sql.get<{ present: number }>(
      "SELECT 1 AS present FROM semantic_document_status WHERE workspace_id = ? AND profile_id = ? AND executable_binding_id = ? LIMIT 1",
      [workspaceId, profileId, executableBindingId],
    );
    return row !== undefined;
  };

  /**
   * Bulk, idempotent status-table maintenance that complements the
   * per-document writes steps 3/5 make inline as they process the
   * missing-vector queries: it classifies documents those queries never see
   * at all (binary artifact versions; whole-file/module "container" entity
   * records -- both excluded by the missing-vector queries' own SQL `WHERE`
   * clauses), backfills `covered` rows for documents a prior pass (or a
   * pre-`semantic_document_status` version of this reconciler) already
   * vectorized without ever writing a status row, and sweeps orphaned rows
   * whose underlying artifact version/entity record is no longer visible.
   * Every statement is a single bulk `INSERT ... SELECT` / `DELETE ... WHERE
   * NOT EXISTS` scoped by a `NOT EXISTS` against `semantic_document_status`
   * itself (or, for the sweep, the reverse direction) -- so after the first
   * pass over a given corpus, every one of these becomes a near-zero-row
   * no-op scan, safe to run on every reconcile pass (including ones the fast
   * path would otherwise skip entirely -- see `hasAnyDocumentStatus` above).
   */
  const syncDocumentStatusBulk = async (): Promise<void> => {
    const updatedAt = nowIso();
    await sql.run(
      `INSERT OR IGNORE INTO semantic_document_status (workspace_id, profile_id, executable_binding_id, document_grain, document_id, artifact_id, artifact_version_id, display_path, status, reason_codes, segment_count, generation, updated_at)
       SELECT ?, ?, ?, 'artifact', artifact_versions.artifact_version_id, artifact_versions.artifact_id, artifact_versions.artifact_version_id, COALESCE(source_artifacts.display_path, artifact_versions.artifact_id), 'excluded', '["binary"]', 0, ?, ?
         FROM artifact_versions
         JOIN source_artifacts ON source_artifacts.workspace_id = artifact_versions.workspace_id AND source_artifacts.artifact_id = artifact_versions.artifact_id
        WHERE artifact_versions.workspace_id = ? AND artifact_versions.encoding = 'binary'
          AND artifact_versions.valid_from_generation <= ? AND (artifact_versions.valid_to_generation IS NULL OR artifact_versions.valid_to_generation > ?)
          AND NOT EXISTS (
            SELECT 1 FROM semantic_document_status
             WHERE semantic_document_status.workspace_id = artifact_versions.workspace_id AND semantic_document_status.profile_id = ? AND semantic_document_status.executable_binding_id = ?
               AND semantic_document_status.document_grain = 'artifact' AND semantic_document_status.document_id = artifact_versions.artifact_version_id
          )`,
      [workspaceId, profileId, executableBindingId, generation, updatedAt, workspaceId, generation, generation, profileId, executableBindingId],
    );
    if (entitySource === undefined) {
      await sql.run(
        `INSERT OR IGNORE INTO semantic_document_status (workspace_id, profile_id, executable_binding_id, document_grain, document_id, artifact_id, artifact_version_id, display_path, status, reason_codes, segment_count, generation, updated_at)
         SELECT ?, ?, ?, 'entity', record_occurrences.record_id, record_occurrences.owner_artifact_id, record_occurrences.owner_artifact_version_id, COALESCE(source_artifacts.display_path, record_occurrences.owner_artifact_id), 'unsupported', '["unsupported_kind"]', 0, ?, ?
           FROM record_occurrences
           JOIN source_artifacts ON source_artifacts.workspace_id = record_occurrences.workspace_id AND source_artifacts.artifact_id = record_occurrences.owner_artifact_id
          WHERE record_occurrences.workspace_id = ? AND record_occurrences.category = 'entity' AND record_occurrences.kind = ?
            AND record_occurrences.valid_from_generation <= ? AND (record_occurrences.valid_to_generation IS NULL OR record_occurrences.valid_to_generation > ?)
            AND NOT EXISTS (
              SELECT 1 FROM semantic_document_status
               WHERE semantic_document_status.workspace_id = record_occurrences.workspace_id AND semantic_document_status.profile_id = ? AND semantic_document_status.executable_binding_id = ?
                 AND semantic_document_status.document_grain = 'entity' AND semantic_document_status.document_id = record_occurrences.record_id
            )`,
        [workspaceId, profileId, executableBindingId, generation, updatedAt, workspaceId, INELIGIBLE_ENTITY_RECORD_KIND, generation, generation, profileId, executableBindingId],
      );
    } else {
      // v4 equivalent: `INSERT OR IGNORE` makes this idempotent per row, so
      // no upfront "already present" check is needed -- a container record
      // this pass has already backfilled a status row for is simply a no-op
      // conflict on every later pass. Frente S-E (2026-09-07): streamed
      // page-by-page (never accumulating the workspace's whole container
      // set) -- each page's own containers are chunked and inserted
      // immediately, so this step's own peak memory is O(page), not
      // O(corpus).
      await entitySource!.entityCandidates(async (page) => {
        const containers = page.filter((row) => row.record_kind === INELIGIBLE_ENTITY_RECORD_KIND);
        for (const group of chunk(containers, ENTITY_STATUS_BATCH_SIZE)) {
          await sql.transaction(group.map((row) => ({
            kind: "run" as const,
            sql: `INSERT OR IGNORE INTO semantic_document_status (workspace_id, profile_id, executable_binding_id, document_grain, document_id, artifact_id, artifact_version_id, display_path, status, reason_codes, segment_count, generation, updated_at)
                  VALUES (?, ?, ?, 'entity', ?, ?, ?, ?, 'unsupported', '["unsupported_kind"]', 0, ?, ?)`,
            params: [workspaceId, profileId, executableBindingId, row.record_id, row.owner_artifact_id, row.owner_artifact_version_id, row.display_path ?? row.owner_artifact_id, generation, updatedAt],
          })));
        }
      });
    }
    await sql.run(
      `INSERT OR IGNORE INTO semantic_document_status (workspace_id, profile_id, executable_binding_id, document_grain, document_id, artifact_id, artifact_version_id, display_path, status, reason_codes, segment_count, generation, updated_at)
       SELECT vector_projection_rows.workspace_id, vector_projection_rows.profile_id, vector_projection_rows.executable_binding_id,
              CASE WHEN vector_projection_rows.document_grain = 'entity' THEN 'entity' ELSE 'artifact' END,
              CASE WHEN vector_projection_rows.document_grain = 'entity' THEN vector_projection_rows.document_ref ELSE vector_projection_rows.owner_artifact_version_id END,
              vector_projection_rows.owner_artifact_id, vector_projection_rows.owner_artifact_version_id,
              COALESCE(source_artifacts.display_path, vector_projection_rows.owner_artifact_id), 'covered', '[]', 1, ?, ?
         FROM vector_projection_rows
         LEFT JOIN source_artifacts ON source_artifacts.workspace_id = vector_projection_rows.workspace_id AND source_artifacts.artifact_id = vector_projection_rows.owner_artifact_id
        WHERE vector_projection_rows.workspace_id = ? AND vector_projection_rows.profile_id = ? AND vector_projection_rows.executable_binding_id = ? AND vector_projection_rows.valid_to_generation IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM semantic_document_status
             WHERE semantic_document_status.workspace_id = vector_projection_rows.workspace_id AND semantic_document_status.profile_id = vector_projection_rows.profile_id AND semantic_document_status.executable_binding_id = vector_projection_rows.executable_binding_id
               AND semantic_document_status.document_grain = CASE WHEN vector_projection_rows.document_grain = 'entity' THEN 'entity' ELSE 'artifact' END
               AND semantic_document_status.document_id = CASE WHEN vector_projection_rows.document_grain = 'entity' THEN vector_projection_rows.document_ref ELSE vector_projection_rows.owner_artifact_version_id END
          )`,
      [generation, updatedAt, workspaceId, profileId, executableBindingId],
    );
    await sql.run(
      `DELETE FROM semantic_document_status
        WHERE workspace_id = ? AND profile_id = ? AND executable_binding_id = ? AND document_grain = 'artifact'
          AND NOT EXISTS (
            SELECT 1 FROM artifact_versions
             WHERE artifact_versions.workspace_id = semantic_document_status.workspace_id AND artifact_versions.artifact_version_id = semantic_document_status.document_id
               AND artifact_versions.valid_from_generation <= ? AND (artifact_versions.valid_to_generation IS NULL OR artifact_versions.valid_to_generation > ?)
          )`,
      [workspaceId, profileId, executableBindingId, generation, generation],
    );
    if (entitySource === undefined) {
      await sql.run(
        `DELETE FROM semantic_document_status
          WHERE workspace_id = ? AND profile_id = ? AND executable_binding_id = ? AND document_grain = 'entity'
            AND NOT EXISTS (
              SELECT 1 FROM record_occurrences
               WHERE record_occurrences.workspace_id = semantic_document_status.workspace_id AND record_occurrences.record_id = semantic_document_status.document_id
                 AND record_occurrences.valid_from_generation <= ? AND (record_occurrences.valid_to_generation IS NULL OR record_occurrences.valid_to_generation > ?)
            )`,
        [workspaceId, profileId, executableBindingId, generation, generation],
      );
    } else {
      const openStatusRows = await sql.all<{ document_id: string }>(
        "SELECT document_id FROM semantic_document_status WHERE workspace_id = ? AND profile_id = ? AND executable_binding_id = ? AND document_grain = 'entity'",
        [workspaceId, profileId, executableBindingId],
      );
      const openIds = openStatusRows.map((row) => row.document_id);
      const visible = await entitySource.visibleRecordIds(openIds);
      const staleIds = openIds.filter((id) => !visible.has(id));
      for (const group of chunk(staleIds, ENTITY_STATUS_BATCH_SIZE)) {
        await sql.run(
          `DELETE FROM semantic_document_status WHERE workspace_id = ? AND profile_id = ? AND executable_binding_id = ? AND document_grain = 'entity' AND document_id IN (${group.map(() => "?").join(", ")})`,
          [workspaceId, profileId, executableBindingId, ...group],
        );
      }
    }
  };

  // Already-complete fast path: the completion marker is only ever written
  // (below) after a full close+insert pass against exactly this generation
  // AND this exact provider identity AND both document grains completing
  // clean, and vector rows are never mutated outside this function once it
  // lands -- so a matching marker (generation AND profile AND binding AND
  // `document_grains` covering both `"artifact"` and `"entity"`) proves there
  // is nothing to close or insert in EITHER pass. A marker written by a
  // pre-entity-pass daemon (or one whose entity pass never completed clean)
  // fails the `document_grains` check here even though generation/profile/
  // binding all match -- this pass then proceeds past the fast path, but
  // steps 1-3 (artifact) find nothing to do (their own queries return empty,
  // since the artifact side really is already caught up) and only steps 4-5
  // (entity) do real work: exactly the "triggers the entity backfill without
  // disturbing artifact vectors" behavior the pinned spec asks for. This is
  // what makes the daemon's startup re-submission for every ready workspace
  // cost two point lookups instead of a full reconcile scan, same as
  // `reconcileLexicalProjection`'s fast path, once BOTH grains are caught up.
  const indexState = await database.projections.semanticIndexState();
  const documentGrainsComplete = indexState?.document_grains !== undefined && indexState.document_grains.includes("artifact") && indexState.document_grains.includes("entity");
  // `entity_policy_digest` must also match: a marker that is grain-complete
  // under a DIFFERENT eligibility policy (or one written before policy
  // tracking, read back as undefined) is not complete for THIS policy -- see
  // `entityPolicyDigest`'s comment above.
  if (indexState !== undefined && indexState.completed_generation === generation && indexState.profile_id === profileId && indexState.executable_binding_id === executableBindingId && documentGrainsComplete && indexState.entity_policy_digest === entityPolicyDigest) {
    // Plan 2026-09-06 (Frente S-A) backfill: a marker already satisfying the
    // fast path proves every vector is in place, but says nothing about
    // whether `semantic_document_status` has ever been populated for this
    // exact vector space -- a sidecar that reached "complete" under a
    // pre-`semantic_document_status` build of this reconciler (or one whose
    // status rows were later wiped) would otherwise stay invisible to
    // `core:semantic_affected_page`/the coverage view forever, since the
    // fast path would keep returning here without ever reaching the slow
    // path's own per-document writes. `hasAnyDocumentStatus` makes the
    // common (already-backfilled) case a single indexed point lookup.
    // Frente S-D (2026-09-07, Lever 2): a sharded call never runs
    // workspace-wide bulk maintenance -- see `shard`'s own doc comment. The
    // orchestrator's final unsharded call performs this backfill instead.
    if (input.shard === undefined && !(await hasAnyDocumentStatus())) await syncDocumentStatusBulk();
    return buildResult(generation, true);
  }

  // Frente S-D (2026-09-07, Lever 2): steps 1, 2, and (further down) 4 are
  // workspace-wide and grain-agnostic-or-artifact/entity-stale-close --
  // unscoped by shard. A sharded call other than index 0 skips them entirely
  // (see `shard`'s own doc comment); shard 0 (or an unsharded call) still
  // runs them exactly as before.
  if (input.shard === undefined || input.shard.index === 0) {
    // Step 1 (profile-swap close): every OPEN vector row written under a
    // DIFFERENT (profile_id, executable_binding_id) than the CURRENTLY
    // configured provider can never again be a valid answer for
    // `core:search_semantic`/`core:search_hybrid` (both only ever compare
    // vectors sharing one exact profile+binding pair -- see
    // `exactVectorScan`'s filter) -- so it is closed outright, "at CURRENT
    // generation" (not at whatever generation its owning version happens to
    // have closed at, if ever): this row's vector space is retired as of NOW,
    // independent of its content's own lifecycle. Deliberately grain-agnostic
    // (no `document_grain` filter): a provider swap invalidates an entity
    // vector exactly as completely as it invalidates an artifact vector, for
    // the identical reason, so both close together in this one statement. A
    // single raw `UPDATE` (the vector shard bytes are opaque and immutable,
    // unlike the relational lexical metadata,
    // it carries no `valid_to_generation` field for a close to keep in sync,
    // so this needs no value rewrite alongside the column; consistency of
    // `StorageMaintenance.verify`'s "vector" integrity check with this is
    // Agent S's storage-slice concern, not this reconciler's) closes every such
    // row in one statement rather than a per-row loop -- there is no per-row
    // work to interleave a `yieldToEventLoop` between, unlike the stale-close
    // and insert loops below.
    const swapClose = await sql.run(
      "UPDATE vector_projection_rows SET valid_to_generation = ? WHERE workspace_id = ? AND valid_to_generation IS NULL AND (profile_id <> ? OR executable_binding_id <> ?)",
      [generation, workspaceId, profileId, executableBindingId],
    );
    counts.closed += swapClose.changes;

    // Step 2 (close stale, ARTIFACT grain only): every remaining OPEN
    // ARTIFACT-grain vector row -- which, after step 1, can only belong to the
    // CURRENT provider -- whose owning `artifact_versions` row has ITSELF
    // already closed can never be visible at any currently-or-future
    // generation, so it is closed to the same generation its version closed
    // at (the historically accurate value, unlike step 1's "at CURRENT
    // generation"). Restricted to `document_grain IS NULL` (artifact rows)
    // DELIBERATELY: an entity row's `owner_artifact_id`/`owner_artifact_version_id`
    // point at whichever artifact version most recently OWNED its record, and
    // -- per decision 17 -- a reused entity record legitimately outlives that
    // owner version closing (see step 4's own doc comment for the entity
    // stale-close join this reconciler uses instead). Without this filter, an
    // entity vector whose owner version had simply closed on an unrelated
    // later edit would be closed here even though its underlying record is
    // still visible and unchanged -- silently losing a perfectly good vector
    // and forcing a needless re-embed. Same no-payload-rewrite reasoning as
    // step 1 applies to the per-row `UPDATE` here.
    const staleRows = await sql.all<StaleVectorRow>(
      `SELECT vector_projection_rows.projection_record_id AS projection_record_id, vector_projection_rows.valid_from_generation AS valid_from_generation,
              artifact_versions.valid_to_generation AS closing_generation, vector_projection_rows.owner_artifact_version_id AS document_id
         FROM vector_projection_rows
         JOIN artifact_versions ON artifact_versions.workspace_id = vector_projection_rows.workspace_id
          AND artifact_versions.artifact_id = vector_projection_rows.owner_artifact_id
          AND artifact_versions.artifact_version_id = vector_projection_rows.owner_artifact_version_id
        WHERE vector_projection_rows.workspace_id = ? AND vector_projection_rows.valid_to_generation IS NULL
          AND vector_projection_rows.document_grain IS NULL
          AND artifact_versions.valid_to_generation IS NOT NULL`,
      [workspaceId],
    );
    for (const row of staleRows) {
      // Checked before each row's own work, mirroring `reconcileLexicalProjection`'s
      // identical checkpoint: an abort observed here means this row (and every
      // row after it) is simply left OPEN for the next pass to close instead.
      if (shouldAbort?.()) return buildResult(generation, false, true);
      await waitForQueryDrain();
      // Plan 2026-09-06 (Frente S-A): the vector close and its
      // `semantic_document_status` row's removal land in one transaction --
      // the underlying artifact version is already gone, so this document has
      // no place in the status table at all (never re-inserted as `pending`
      // by a later pass, since the missing-vector query it would come from
      // requires the version to be VISIBLE).
      await sql.transaction([
        { kind: "run", sql: "UPDATE vector_projection_rows SET valid_to_generation = ? WHERE workspace_id = ? AND projection_record_id = ? AND valid_from_generation = ?", params: [row.closing_generation, workspaceId, row.projection_record_id, row.valid_from_generation] },
        documentStatusDeleteCommand({ workspaceId, profileId, executableBindingId, documentGrain: "artifact", documentId: row.document_id }),
      ]);
      counts.closed += 1;
      await yieldToEventLoop();
    }
  }

  // One document collected in either insert loop below, past every skip
  // filter, waiting for its provider embed call -- shared verbatim by the
  // artifact loop (step 3) and the entity loop (step 5), which is what lets
  // both dispatch through the exact same batching/commit machinery
  // (`commitGeneratedVector`/`embedAndCommitBatch`) rather than duplicating
  // it. `documentGrain`/`documentRef` are omitted for an artifact item
  // (`putVectors` then writes `document_grain`/`document_ref` as NULL, the
  // "artifact" convention) and set to `"entity"`/the owning record's id for
  // an entity item.
  type PendingEmbedItem = {
    readonly embeddingText: string;
    readonly projectionRecordId: string;
    readonly ownerArtifactId: string;
    readonly ownerArtifactVersionId: string;
    readonly validFromGeneration: number;
    readonly documentGrain?: "entity";
    readonly documentRef?: string;
    /** Plan 2026-09-06 (Frente S-A): carried through so `commitGeneratedVector`/`embedAndCommitBatch` can write this item's `semantic_document_status` row without a second query. */
    readonly displayPath: string;
    /**
     * Frente S-B (2026-09-06, decision 17 segmentation): which segment of
     * its owning ENTITY document this item is -- always present for an
     * entity item (`documentGrain === "entity"`), always absent for an
     * artifact item (R9: the artifact lane stays one vector, no segment
     * identity of its own). `segmentStart`/`segmentEnd` are the segment's
     * own `[start, end)` UTF-16 offsets into the entity's rendered
     * `embeddingText` (the WHOLE document's text, before this item's own
     * `embeddingText` was narrowed to just this one segment's slice).
     */
    readonly segmentIndex?: number;
    readonly segmentStart?: number;
    readonly segmentEnd?: number;
    /**
     * Frente S-D (2026-09-07, Lever 1): explicit `semantic_document_status.segment_count`
     * for a COMPOSED artifact item (entity-segment reuse) -- the real count
     * of entity + gap segment vectors mean-pooled into this artifact vector.
     * Omitted for every whole-file artifact item (falls back to
     * `documentStatusUpsertCommand`'s own default of `1`) and every entity
     * item (irrelevant there -- entity segment counting is
     * `EntityDocumentAggregate.totalSegments`, unrelated to this field).
     */
    readonly artifactSegmentCount?: number;
    /** Frente S-D (2026-09-07, Lever 1): extra reason codes (currently only ever `["segments_truncated"]`, R8) folded into a COMPOSED artifact item's `covered` status row. Omitted for every other item, matching `artifactSegmentCount`'s own convention. */
    readonly artifactReasonCodes?: readonly string[];
  };

  const bumpInserted = (item: PendingEmbedItem): void => { if (item.documentGrain === "entity") counts.entity_inserted += 1; else counts.inserted += 1; };
  const bumpFailed = (item: PendingEmbedItem): void => { if (item.documentGrain === "entity") counts.entity_failed += 1; else counts.failed += 1; };

  /** Plan 2026-09-06 (Frente S-A): the `semantic_document_status` document id for one pending item -- the owning entity record id for an entity item, the artifact version id for an artifact item (mirrors `entityDocumentId`'s own natural-id convention for this table, see the DDL's own comment: "artifact_version_id or the entity record id"). */
  const documentIdOf = (item: PendingEmbedItem): string => item.documentGrain === "entity" ? item.documentRef! : item.ownerArtifactVersionId;

  /** Plan 2026-09-06 (Frente S-A): immediate (non-transactional) status upsert -- used wherever there is no companion vector write to be atomic WITH (a permanent skip classification, or a `failed` classification). Reads `generation`/`workspaceId`/`profileId`/`executableBindingId` from the enclosing closure. */
  const writeStatusRow = async (input: { readonly documentGrain: "artifact" | "entity"; readonly documentId: string; readonly artifactId: string; readonly artifactVersionId: string; readonly displayPath: string; readonly status: SemanticDocumentStatus; readonly reasonCodes: readonly string[]; readonly segmentCount?: number }): Promise<void> => {
    const command = documentStatusUpsertCommand({ workspaceId, profileId, executableBindingId, generation, updatedAt: nowIso(), ...input });
    if (command.kind !== "run") throw new Error("unreachable: documentStatusUpsertCommand always returns a run command");
    await sql.run(command.sql, command.params ?? []);
  };

  /**
   * Frente S-B (2026-09-06) fix, item #5 (adversarial review, plan §4.5): a
   * segment that WOULD be written on success is never applied to
   * `vector_projection_rows` the instant its own embed call resolves --
   * doing that (the original shape of this code) let a crash between two
   * `embedAndCommitBatch` flushes of the SAME multi-segment document leave
   * SOME of its segment rows durably committed and the rest never retried:
   * the next pass's "missing entity rows" query excludes any `document_ref`
   * with at least one OPEN row, so the surviving segment(s) alone made the
   * whole document look already handled, and `syncDocumentStatusBulk`'s
   * covered-backfill (which only checks "at least one open row exists, no
   * status row yet") then durably certified that permanently-incomplete
   * document as `"covered"` -- silent, permanent data loss for exactly the
   * documents large enough to need more than one segment, in direct
   * violation of R8's "never silent" rule. Each successful segment's WOULD-BE
   * write is instead buffered here (`pendingWrites`) and the entire
   * document's segments are committed in ONE transaction
   * (`applyEntityDocumentOutcome` below) only once every sibling has
   * settled -- so a crash at any point before that leaves EXACTLY ZERO rows
   * for the document (it is retried from scratch next pass), never a
   * partial set.
   */
  type EntitySegmentWrite =
    | { readonly kind: "insert"; readonly value: VectorProjectionInput }
    | { readonly kind: "reopen"; readonly projectionRecordId: string; readonly validFromGeneration: number; readonly wasClosed: boolean };

  /**
   * Frente S-B (2026-09-06, decision 17 segmentation): per-ENTITY-RECORD
   * aggregation state for its (possibly many) segments -- `semantic_document_status`
   * holds exactly ONE row per `(document_grain, document_id)` (unchanged by
   * this frente), so N segment-level outcomes for the SAME entity record
   * must be reduced to ONE final status write, never N competing writes
   * racing to overwrite each other's `status`/`reason_codes`. An entry is
   * created (via `registerEntityDocument` below) BEFORE any of its
   * segments' `PendingEmbedItem`s are pushed into `entityPendingBatch`, and
   * removed the instant its `settled` count reaches `total_segments` --
   * whichever batch flush's `commitGeneratedVector`/`embedAndCommitBatch`
   * call happens to settle the LAST outstanding segment performs the one
   * real DB write, via `applyEntityDocumentOutcome` below.
   */
  type EntityDocumentAggregate = {
    readonly artifactId: string;
    readonly artifactVersionId: string;
    readonly displayPath: string;
    readonly totalSegments: number;
    readonly truncated: boolean;
    /** Frente S-D (2026-09-07, Lever 1): this entity's own file-absolute `[start, end)` span (`evaluateEntityEligibility`'s own `start`/`end`) -- captured so a clean finalize can register this span (and its freshly-inserted vectors) into `entityCoverageByOwner` for `artifactVersionId`. */
    readonly spanStart: number;
    readonly spanEnd: number;
    settled: number;
    failed: boolean;
    readonly reasonCodes: Set<string>;
    readonly pendingWrites: EntitySegmentWrite[];
  };
  const entityDocumentAggregates = new Map<string, EntityDocumentAggregate>();

  /**
   * Frente S-D (2026-09-07, Lever 1): per-OWNER-FILE entity coverage,
   * captured live as `recordEntitySegmentOutcome` (below) finalizes each
   * entity document THIS pass -- consumed by the (moved) artifact insert
   * step once the entity insert step has fully run, see this function's own
   * "step 3 now runs after step 5" doc comment further down. Only an entity
   * whose EVERY segment was a fresh INSERT this pass (never a "reopen" of an
   * already-parked row) ever contributes an entry: a reopened row's packed
   * bytes are not sitting in memory at commit time, and this map is never
   * populated by a speculative extra CAS read just to backfill it -- see
   * `recordEntitySegmentOutcome`'s own call site for the exact condition.
   * A file whose entities contribute no entries here (zero eligible
   * entities, or every one of them reopened rather than inserted) simply
   * has no key here at all -- its artifact vector then falls back to a
   * fresh whole-file embed, identical to this reconciler's pre-Lever-1
   * behavior.
   */
  const entityCoverageByOwner = new Map<string, Array<{ readonly start: number; readonly end: number; readonly vectors: readonly Uint8Array[] }>>();

  const registerEntityDocument = (recordId: string, input: { readonly artifactId: string; readonly artifactVersionId: string; readonly displayPath: string; readonly totalSegments: number; readonly truncated: boolean; readonly spanStart: number; readonly spanEnd: number }): void => {
    entityDocumentAggregates.set(recordId, { ...input, settled: 0, failed: false, reasonCodes: new Set(), pendingWrites: [] });
  };

  /**
   * Records one segment's OWN outcome for its owning entity record, applying
   * the record's ENTIRE buffered write set -- every sibling segment's
   * `insert`/`reopen`, plus the record's single `semantic_document_status`
   * row (`covered`, with `reason_codes: ["segments_truncated"]` when
   * `truncated` was set at registration per R8, or `failed`, union of every
   * failed segment's own reason codes) -- in ONE transaction, only once
   * every one of its segments has settled. Idempotent per call: a record
   * already finalized (defensively -- should not happen, since
   * `entityDocumentAggregates` is deleted the instant it finalizes) is a
   * no-op rather than a crash or a duplicate write.
   *
   * A `"failed"` outcome for ANY segment discards every OTHER segment's own
   * buffered write for this same document -- nothing beyond the single
   * `"failed"` status row is ever written, so a partially-successful
   * multi-segment embed can never leave a partial row set behind (see this
   * type's own doc comment for the crash-recovery gap this closes). The next
   * pass's "missing entity rows" query still finds every one of this
   * document's segments missing (since none were written) and retries all of
   * them from scratch -- a small amount of redundant re-embedding for the
   * segments that did succeed this time, in exchange for the guarantee that
   * a partially-failed multi-segment document is never silently left
   * incomplete forever. Legacy self-heal note: an EARLIER build of this
   * function wrote each segment's row immediately and closed already-written
   * siblings on a LATER sibling's failure; that close is now unreachable by
   * construction (nothing is ever written before every sibling succeeds), so
   * it is retired rather than kept as dead code.
   */
  const recordEntitySegmentOutcome = async (recordId: string, status: "covered" | "failed", reasonCodes: readonly string[], write?: EntitySegmentWrite): Promise<void> => {
    const aggregate = entityDocumentAggregates.get(recordId);
    if (aggregate === undefined) return;
    aggregate.settled += 1;
    if (status === "failed") { aggregate.failed = true; for (const code of reasonCodes) aggregate.reasonCodes.add(code); }
    else if (write !== undefined) aggregate.pendingWrites.push(write);
    if (aggregate.settled < aggregate.totalSegments) return;
    entityDocumentAggregates.delete(recordId);
    const finalStatus: SemanticDocumentStatus = aggregate.failed ? "failed" : "covered";
    const finalReasonCodes = aggregate.failed ? [...aggregate.reasonCodes] : aggregate.truncated ? ["segments_truncated"] : [];
    const statusCommand = documentStatusUpsertCommand({
      workspaceId, profileId, executableBindingId, generation, updatedAt: nowIso(),
      documentGrain: "entity", documentId: recordId, artifactId: aggregate.artifactId, artifactVersionId: aggregate.artifactVersionId,
      displayPath: aggregate.displayPath, status: finalStatus, reasonCodes: finalReasonCodes, segmentCount: aggregate.totalSegments,
    });
    // `aggregate.failed`: nothing was ever written for this document's
    // segments (every success buffered, never applied) -- only the status
    // row lands.
    if (aggregate.failed) {
      await sql.transaction([statusCommand]);
      return;
    }
    const inserts = aggregate.pendingWrites.filter((entry): entry is Extract<EntitySegmentWrite, { readonly kind: "insert" }> => entry.kind === "insert");
    const reopens = aggregate.pendingWrites.filter((entry): entry is Extract<EntitySegmentWrite, { readonly kind: "reopen" }> => entry.kind === "reopen");
    const reopenCommands: SqliteCommand[] = reopens
      .filter((entry) => entry.wasClosed)
      .map((entry) => ({ kind: "run", sql: "UPDATE vector_projection_rows SET valid_to_generation = NULL WHERE workspace_id = ? AND projection_record_id = ? AND valid_from_generation = ?", params: [workspaceId, entry.projectionRecordId, entry.validFromGeneration] }));
    // `putVectors` (`@urdira/storage`) rejects an EMPTY `values` array
    // outright (`storage:invalid_vector_batch`) -- a document whose every
    // segment reopened an already-parked row (no fresh insert at all) must
    // run its reopen UPDATEs + status upsert as a plain transaction instead.
    try {
      if (inserts.length > 0) await database.projections.putVectors(inserts.map((entry) => entry.value), [...reopenCommands, statusCommand]);
      else await sql.transaction([...reopenCommands, statusCommand]);
    } catch {
      // The bulk apply itself failed (shard conflict, invalid vector, DB
      // error, ...) -- since it is all-or-nothing (a single `putVectors`
      // call or a single `sql.transaction`), nothing was written, so falling
      // back to a `failed` status row is safe and matches every other
      // provider-failure path in this reconciler (left missing, retried next
      // pass, marker withheld).
      await sql.transaction([documentStatusUpsertCommand({
        workspaceId, profileId, executableBindingId, generation, updatedAt: nowIso(),
        documentGrain: "entity", documentId: recordId, artifactId: aggregate.artifactId, artifactVersionId: aggregate.artifactVersionId,
        displayPath: aggregate.displayPath, status: "failed", reasonCodes: ["provider_error:vector_write_failed"], segmentCount: aggregate.totalSegments,
      })]);
      counts.entity_failed += aggregate.pendingWrites.length;
      return;
    }
    counts.entity_inserted += aggregate.pendingWrites.length;
    // Frente S-D (2026-09-07, Lever 1): register this entity's coverage for
    // its owning file ONLY when every one of its segments was a fresh
    // INSERT this pass (`reopens.length === 0`) -- a mix of insert+reopen
    // for the SAME entity (rare: possible when a multi-segment entity's
    // segments independently digest-match some parked rows but not others)
    // is deliberately excluded rather than contributing a partial vector
    // set, since `entityCoverageByOwner`'s consumer needs EVERY segment of
    // an entity it counts as "covered" to build a faithful mean.
    if (reopens.length === 0 && inserts.length > 0) {
      const owner = entityCoverageByOwner.get(aggregate.artifactVersionId) ?? [];
      owner.push({ start: aggregate.spanStart, end: aggregate.spanEnd, vectors: inserts.map((entry) => entry.value.vector) });
      entityCoverageByOwner.set(aggregate.artifactVersionId, owner);
    }
  };

  /**
   * `writeStatusRow` for a `PendingEmbedItem` -- see that function's own doc
   * comment. Frente S-B (2026-09-06): an ENTITY item (`documentGrain ===
   * "entity"`) NEVER writes its own row directly -- every entity item is
   * one SEGMENT of a multi-segment document sharing one status row with its
   * siblings, so this routes through `recordEntitySegmentOutcome`'s
   * per-record aggregation instead (only `"covered"`/`"failed"` are ever
   * passed for an entity item; `"pending"`/`"excluded"`/`"unsupported"` are
   * only ever used for the whole-document skip classifications in step 5's
   * OWN pre-segmentation checks, which call `writeStatusRow` directly, never
   * this function -- see the doc comment on `evaluateEntityEligibility`'s
   * call site below).
   */
  const writeItemStatus = async (item: PendingEmbedItem, status: SemanticDocumentStatus, reasonCodes: readonly string[]): Promise<void> => {
    if (item.documentGrain === "entity") {
      if (status !== "covered" && status !== "failed") throw new Error(`unreachable: an entity PendingEmbedItem only ever settles as covered or failed, got ${status}.`);
      await recordEntitySegmentOutcome(item.documentRef!, status, reasonCodes);
      return;
    }
    await writeStatusRow({ documentGrain: "artifact", documentId: documentIdOf(item), artifactId: item.ownerArtifactId, artifactVersionId: item.ownerArtifactVersionId, displayPath: item.displayPath, status, reasonCodes });
  };

  // Commits ONE already-generated vector for ONE pending item: the exact
  // same parked-row-reopen-or-insert decision the pre-batching loop made
  // inline, pulled out so both the batch-success path and the per-document
  // fallback path in `embedAndCommitBatch` below share it verbatim -- this
  // is what keeps per-document failure accounting (and the parked-row
  // digest-mismatch/reopen semantics) byte-for-byte identical to before,
  // regardless of which path produced `generated`, and identical across both
  // grains.
  const commitGeneratedVector = async (item: PendingEmbedItem, generated: SemanticGeneratedVector): Promise<void> => {
    await waitForQueryDrain();
    // With vector-space-scoped ids the only same-primary-key row this insert
    // could hit is this SAME provider's own earlier row for this same
    // document -- i.e. the workspace swapped away from this provider and
    // back again without the generation moving, and step 1 of the
    // intermediate pass closed the original row. The vector bytes are a
    // deterministic function of (content, vector space), so when the parked
    // row's digest matches the freshly generated one, the correct statement
    // is "this vector is valid again": REOPEN it (clear `valid_to_generation`)
    // instead of inserting. This MUST be checked BEFORE `putVectors`, not in
    // a catch around it: `putVectors` deliberately no-ops (does not throw)
    // on a byte-identical already-present row, which would count as a
    // successful insert here while silently leaving the row CLOSED --
    // covered but invisible, the worst combination. Validity intervals are
    // already the mutable part of this table (step 1/2/4 write them); the
    // payload stays untouched. A digest MISMATCH against the parked row (a
    // non-deterministic provider under an unchanged binding digest) can
    // never insert successfully either, so it counts as failed -- retried
    // next pass, marker withheld.
    const parked = await sql.get<{ vector_digest: string; valid_to_generation: number | null }>(
      "SELECT vector_digest, valid_to_generation FROM vector_projection_rows WHERE workspace_id = ? AND projection_record_id = ? AND valid_from_generation = ?",
      [workspaceId, item.projectionRecordId, item.validFromGeneration],
    );
    if (parked !== undefined) {
      // Frente S-B (2026-09-06) fix: compare against the digest
      // `putVectors` (`@urdira/storage`) will ACTUALLY store -- never
      // `generated.vector_digest` as-is. `putVectors` re-applies its own
      // decode/L2-renormalize/re-encode pass to whatever bytes it receives
      // (a defensive step for a caller that hands it non-normalized raw
      // values), and that re-normalization is NOT perfectly bit-idempotent
      // on an ALREADY-unit-norm float32 vector: re-dividing by a norm that
      // float32 rounding put at, say, 0.9999999 or 1.0000001 instead of
      // exactly 1.0 can flip the last bit of one or more components on
      // re-encoding. Reusing `@urdira/storage`'s OWN exported
      // `canonicalVectorBytes` (Frente S-B, adversarial review item #7 --
      // see that export's own doc comment) means this comparison can never
      // silently drift from `putVectors`'s actual behavior the way a
      // hand-duplicated copy of the same transform did: discovered live via
      // the entity segmentation self-heal path (a segment closed then
      // reopened one pass later), but the underlying gap predates
      // segmentation entirely -- ANY reopened row (e.g. a provider swapped
      // back to a previous identity) was equally at risk of a spurious
      // `provider_error:vector_digest_mismatch` on an actually-unchanged,
      // fully-deterministic provider. `canonicalVectorBytes` is also
      // STRICTER than the old duplicate (throws on a non-finite value or an
      // exact-zero L2 norm, rather than silently passing one through) --
      // caught here and folded into the SAME digest-mismatch failure path,
      // since either way `putVectors` itself could never have stored this
      // vector successfully.
      let rehashedDigest: string;
      try {
        rehashedDigest = digestBytes(storageCanonicalVectorBytes(generated.vector, provider.profile.dimensions, {
          element_type: provider.profile.element_type as "float32" | "float64",
          vector_encoding: provider.profile.vector_encoding as "float32-le" | "float64-le",
          normalization: provider.profile.normalization as "none" | "l2",
          distance_metric: provider.profile.distance_metric as "squared_l2" | "cosine",
        }));
      } catch {
        rehashedDigest = "";
      }
      if (parked.vector_digest !== rehashedDigest) {
        bumpFailed(item);
        // Plan 2026-09-06 (Frente S-A): a non-deterministic provider under an
        // unchanged binding digest -- structurally distinguishable from every
        // other failure mode here, so it gets its own reason code.
        await writeItemStatus(item, "failed", ["provider_error:vector_digest_mismatch"]);
        return;
      }
      if (item.documentGrain === "entity") {
        // Frente S-B (2026-09-06) fix, item #5: buffered, never applied
        // immediately -- see `recordEntitySegmentOutcome`'s own doc comment
        // for the crash-recovery gap this closes. `bumpInserted`/counts land
        // once the WHOLE document's segments are actually written, inside
        // `recordEntitySegmentOutcome` itself.
        await recordEntitySegmentOutcome(item.documentRef!, "covered", [], { kind: "reopen", projectionRecordId: item.projectionRecordId, validFromGeneration: item.validFromGeneration, wasClosed: parked.valid_to_generation !== null });
        await yieldToEventLoop();
        return;
      }
      // Artifact item: the reopen (when needed) and the `covered` status
      // upsert land in one transaction, exactly as before -- an artifact
      // document is always exactly one row, so there is no multi-segment
      // atomicity concern here.
      const statusCommand = documentStatusUpsertCommand({
        workspaceId, profileId, executableBindingId, documentGrain: "artifact", documentId: documentIdOf(item),
        artifactId: item.ownerArtifactId, artifactVersionId: item.ownerArtifactVersionId, displayPath: item.displayPath,
        status: "covered", reasonCodes: item.artifactReasonCodes ?? [], ...(item.artifactSegmentCount === undefined ? {} : { segmentCount: item.artifactSegmentCount }), generation, updatedAt: nowIso(),
      });
      const reopenUpdate: SqliteCommand = { kind: "run", sql: "UPDATE vector_projection_rows SET valid_to_generation = NULL WHERE workspace_id = ? AND projection_record_id = ? AND valid_from_generation = ?", params: [workspaceId, item.projectionRecordId, item.validFromGeneration] };
      const reopenCommands: SqliteCommand[] = parked.valid_to_generation !== null ? [reopenUpdate, statusCommand] : [statusCommand];
      await sql.transaction(reopenCommands);
      // An OPEN parked row (valid_to already NULL) cannot normally reach here
      // (the missing-rows queries exclude documents with an open current-
      // profile row), treated as already-covered either way.
      bumpInserted(item);
      await yieldToEventLoop();
      return;
    }
    if (item.documentGrain === "entity") {
      // Frente S-B (2026-09-06) fix, item #5: buffered, never applied
      // immediately -- see `recordEntitySegmentOutcome`'s own doc comment.
      const value: VectorProjectionInput = {
        projection_record_id: item.projectionRecordId,
        owner_artifact_id: item.ownerArtifactId,
        owner_artifact_version_id: item.ownerArtifactVersionId,
        profile_id: profileId,
        executable_binding_id: executableBindingId,
        dimensions: provider.profile.dimensions,
        element_type: provider.profile.element_type,
        vector: generated.vector,
        vector_encoding: provider.profile.vector_encoding as "float32-le" | "float64-le",
        normalization: provider.profile.normalization as "none" | "l2",
        distance_metric: provider.profile.distance_metric as "squared_l2" | "cosine",
        valid_from_generation: item.validFromGeneration,
        document_grain: item.documentGrain,
        document_ref: item.documentRef!,
        ...(item.segmentIndex === undefined ? {} : { segment_index: item.segmentIndex }),
        ...(item.segmentStart === undefined ? {} : { segment_start: item.segmentStart }),
        ...(item.segmentEnd === undefined ? {} : { segment_end: item.segmentEnd }),
      };
      await recordEntitySegmentOutcome(item.documentRef!, "covered", [], { kind: "insert", value });
      await yieldToEventLoop();
      return;
    }
    try {
      await database.projections.putVectors([{
        projection_record_id: item.projectionRecordId,
        owner_artifact_id: item.ownerArtifactId,
        owner_artifact_version_id: item.ownerArtifactVersionId,
        profile_id: profileId,
        executable_binding_id: executableBindingId,
        dimensions: provider.profile.dimensions,
        element_type: provider.profile.element_type,
        vector: generated.vector,
        vector_encoding: provider.profile.vector_encoding as "float32-le" | "float64-le",
        normalization: provider.profile.normalization as "none" | "l2",
        distance_metric: provider.profile.distance_metric as "squared_l2" | "cosine",
        valid_from_generation: item.validFromGeneration,
      }], [
        // Plan 2026-09-06 (Frente S-A): the `covered` status row commits in
        // the SAME transaction as the vector insert (`putVectors`'s own
        // `extraCommands` parameter) -- a crash between the two can never
        // leave one written without the other.
        documentStatusUpsertCommand({
          workspaceId, profileId, executableBindingId, documentGrain: "artifact", documentId: documentIdOf(item),
          artifactId: item.ownerArtifactId, artifactVersionId: item.ownerArtifactVersionId, displayPath: item.displayPath,
          status: "covered", reasonCodes: item.artifactReasonCodes ?? [], ...(item.artifactSegmentCount === undefined ? {} : { segmentCount: item.artifactSegmentCount }), generation, updatedAt: nowIso(),
        }),
      ]);
    } catch {
      // putVectors rejected the batch (shard conflict, invalid vector, ...):
      // left missing, retried next pass, marker withheld below.
      bumpFailed(item);
      await writeItemStatus(item, "failed", ["provider_error:vector_write_failed"]);
      return;
    }
    bumpInserted(item);
    // See `yieldToEventLoop`'s doc comment: this is the loop whose combined
    // per-document embedding cost is the one actually at risk of starving
    // the event loop across a large pass -- unchanged by batching, since a
    // yield still happens after every individual document's own write.
    await yieldToEventLoop();
  };

  /**
   * Frente S-D (2026-09-07, Lever 3): digest identity for the segment cache
   * -- a pure function of the exact (NFC-normalized) text a provider call
   * would embed, deliberately INDEPENDENT of `segment_index`/`purpose`/which
   * document the text came from: the underlying model's output for a given
   * input text is deterministic regardless of those (they are bookkeeping
   * metadata the PROVIDER folds into its own `input_digest`, never an input
   * to the actual embedding computation), so two different entities -- or
   * the same entity re-embedded after an edit shifted its `segment_index`,
   * or a gap segment that happens to render identically to an entity segment
   * elsewhere -- sharing byte-identical rendered text safely share one cache
   * row.
   */
  function segmentCacheDigest(text: string): string {
    return digestBytes(new TextEncoder().encode(text.normalize("NFC")));
  }

  /**
   * Frente S-D (2026-09-07, Lever 3): reads a previously-cached vector for
   * this exact `(executable_binding_id, segment_digest)` pair, scoped to
   * this workspace -- `undefined` on a cache miss. A hit means this exact
   * text was already embedded (in ANY prior generation, by ANY document, in
   * this OR another shard process -- the cache is workspace+binding scoped,
   * not document- or generation-scoped) under the CURRENT vector space, so
   * the provider call for it can be skipped entirely.
   */
  const readCachedSegmentVector = async (digest: string): Promise<Uint8Array | undefined> => {
    const row = await sql.get<{ vector: Uint8Array }>(
      "SELECT vector FROM semantic_segment_cache WHERE workspace_id = ? AND executable_binding_id = ? AND segment_digest = ?",
      [workspaceId, executableBindingId, digest],
    );
    return row?.vector;
  };

  /**
   * Frente S-D (2026-09-07, Lever 3): best-effort cache write -- `INSERT OR
   * IGNORE` so a row already written (by an earlier pass, or by ANOTHER
   * concurrent shard process embedding the identical text independently,
   * Lever 2) is a silent no-op rather than a primary-key conflict, and a
   * write failure of any other kind is swallowed rather than failing the
   * embed it is piggybacking on: this cache is purely an optimization -- a
   * row that fails to write just means the identical text gets embedded
   * again next time, never a correctness problem (the cached vector, when
   * present, is always exactly what the provider would compute fresh for
   * that text, since embedding is deterministic per vector space).
   */
  const writeCachedSegmentVector = async (digest: string, vector: Uint8Array): Promise<void> => {
    try {
      await sql.run(
        "INSERT OR IGNORE INTO semantic_segment_cache (workspace_id, executable_binding_id, segment_digest, vector, dimensions, element_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [workspaceId, executableBindingId, digest, vector, provider.profile.dimensions, provider.profile.element_type, nowIso()],
      );
    } catch { /* best-effort, see this function's own doc comment */ }
  };

  /**
   * Frente S-D (2026-09-07, Lever 1): embeds a plain list of texts (the
   * artifact-vector composition's own GAP segments -- never a
   * document-identified `PendingEmbedItem`) and returns their packed vector
   * bytes in order, trying `provider.binding.generateVectors` first and
   * falling back to sequential `generateVector` calls on rejection -- the
   * SAME batch-then-fallback shape `embedAndCommitBatch` below already uses,
   * minus the per-item commit step (nothing here writes to the database; the
   * caller mean-pools these bytes with the file's entity vectors into ONE
   * composed artifact vector before ever writing anything). Throws
   * (propagating to the caller) if even the sequential fallback cannot embed
   * every text -- the composed artifact document this call is part of is
   * then left uncommitted for this pass and marked `failed` by the caller,
   * retried next pass, exactly like any other provider failure this
   * reconciler already tolerates.
   */
  const embedPlainTexts = async (texts: readonly string[]): Promise<readonly Uint8Array[]> => {
    if (texts.length === 0) return [];
    // Frente S-D (2026-09-07, Lever 3): cache lookup first -- only texts that
    // MISS ever reach the provider. `result` is filled in cache-index order
    // and returned in the ORIGINAL `texts` order regardless of which indices
    // hit vs. missed.
    const digests = texts.map((text) => segmentCacheDigest(text));
    const cached = await Promise.all(digests.map((digest) => readCachedSegmentVector(digest)));
    const result = new Array<Uint8Array | undefined>(texts.length);
    const missIndices: number[] = [];
    for (let index = 0; index < texts.length; index += 1) {
      if (cached[index] !== undefined) result[index] = cached[index];
      else missIndices.push(index);
    }
    if (missIndices.length > 0) {
      const missTexts = missIndices.map((index) => texts[index]!);
      let missVectors: readonly Uint8Array[];
      const generateVectors = provider.binding.generateVectors;
      if (generateVectors !== undefined) {
        try {
          const generated = await generateVectors(missTexts.map((text) => ({ profile: provider.profile, purpose: "document" as const, text })));
          if (generated.length !== missTexts.length) throw new Error(`Semantic runtime binding generateVectors returned ${generated.length} vectors for ${missTexts.length} input segments.`);
          missVectors = generated.map((item) => item.vector);
        } catch {
          // Fall through to the sequential fallback below -- same rationale
          // as `embedAndCommitBatch`'s own identical catch.
          const out: Uint8Array[] = [];
          for (const text of missTexts) out.push((await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text })).vector);
          missVectors = out;
        }
      } else {
        const out: Uint8Array[] = [];
        for (const text of missTexts) out.push((await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text })).vector);
        missVectors = out;
      }
      for (let index = 0; index < missIndices.length; index += 1) {
        const originalIndex = missIndices[index]!;
        result[originalIndex] = missVectors[index]!;
        await writeCachedSegmentVector(digests[originalIndex]!, missVectors[index]!);
      }
    }
    return result as readonly Uint8Array[];
  };

  // Embeds and commits ONE batch of pending documents: tries
  // `provider.binding.generateVectors` first (when the binding implements
  // it); on that call REJECTING (network failure, malformed response, one
  // poison document among many otherwise-fine ones, ...) -- or when the
  // binding has no batch method at all -- falls back to per-document
  // `generateVector` calls for this exact batch, which isolates whichever
  // single document actually poisoned it: every OTHER document in the batch
  // still succeeds and only the genuinely failing one counts as failed,
  // preserving today's per-document failure accounting exactly (see
  // `SemanticRuntimeBinding.generateVectors`'s own doc comment for why this
  // method is deliberately all-or-nothing rather than returning mixed
  // per-item results). Shared verbatim by the artifact and entity insert
  // loops.
  const embedAndCommitBatch = async (pending: readonly PendingEmbedItem[]): Promise<void> => {
    if (pending.length === 0) return;
    await waitForQueryDrain();
    // Frente S-D (2026-09-07, Lever 3): cache lookup FIRST, for the whole
    // batch, before any provider call -- an item whose `embeddingText`
    // matches an already-cached `(executable_binding_id, digest)` pair skips
    // the provider entirely and commits immediately from the cached bytes.
    // Only cache MISSES are ever collected into `misses` below and reach the
    // generateVectors/generateVector logic that follows, unchanged in shape
    // from before this lever (same batch-then-fallback, same per-item
    // failure isolation) except it now runs over a possibly-smaller list.
    const digests = pending.map((item) => segmentCacheDigest(item.embeddingText));
    const cachedVectors = await Promise.all(digests.map((digest) => readCachedSegmentVector(digest)));
    const misses: PendingEmbedItem[] = [];
    const missDigests: string[] = [];
    for (let index = 0; index < pending.length; index += 1) {
      const cached = cachedVectors[index];
      if (cached === undefined) { misses.push(pending[index]!); missDigests.push(digests[index]!); continue; }
      await commitGeneratedVector(pending[index]!, { vector: cached, vector_digest: digestBytes(cached), input_digest: "segment-cache-hit", profile_digest: provider.profile.profile_digest });
    }
    if (misses.length === 0) return;
    const generateVectors = provider.binding.generateVectors;
    if (generateVectors !== undefined) {
      try {
        const generated = await generateVectors(misses.map((item) => ({ profile: provider.profile, purpose: "document" as const, text: item.embeddingText, ...(item.segmentIndex === undefined ? {} : { segment_index: item.segmentIndex }) })));
        if (generated.length !== misses.length) throw new Error(`Semantic runtime binding generateVectors returned ${generated.length} vectors for ${misses.length} inputs.`);
        for (let index = 0; index < misses.length; index += 1) {
          await commitGeneratedVector(misses[index]!, generated[index]!);
          await writeCachedSegmentVector(missDigests[index]!, generated[index]!.vector);
        }
        return;
      } catch {
        // Batch rejected (or shaped wrong): fall through to the per-document
        // fallback below instead of counting the whole batch as failed --
        // see this function's own doc comment.
      }
    }
    for (let index = 0; index < misses.length; index += 1) {
      const item = misses[index]!;
      let generated: SemanticGeneratedVector;
      try {
        generated = await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text: item.embeddingText, ...(item.segmentIndex === undefined ? {} : { segment_index: item.segmentIndex }) });
      } catch {
        // The embedding provider itself threw (network failure, malformed
        // response, timeout, ...) -- the bundled local providers never throw
        // here at all, since "no embeddable token" was already filtered out
        // below by `EMBEDDABLE_TOKEN_PATTERN` before an item is ever added to
        // a batch, so this is realistically an HTTP/model-runtime concern.
        // The row is left missing rather than failing the whole pass -- the
        // same "retry forever, next pass just re-finds it via its own
        // missing-vector query" tradeoff `reconcileLexicalProjection` accepts
        // for undecodable/oversized rows, except here the underlying
        // condition (a flaky provider, or one poison document) is expected
        // to clear on its own. A persistently failing row costs one more
        // provider call on every pass until it clears or its underlying
        // content closes -- accepted because there is no separate "poison
        // document" quarantine mechanism in this increment. The marker below
        // is withheld while either failure counter is nonzero so the fast
        // path can never seal these rows out of retry.
        bumpFailed(item);
        await writeItemStatus(item, "failed", ["provider_error:generate_vector_failed"]);
        continue;
      }
      await commitGeneratedVector(item, generated);
      await writeCachedSegmentVector(missDigests[index]!, generated.vector);
    }
  };

  // Step 3 (insert missing, ARTIFACT grain) MOVED (Frente S-D, 2026-09-07,
  // Lever 1): its query and loop now run AFTER step 5 (the entity insert
  // loop), further down this function -- see the doc comment right before
  // `missingRows` there for why this ordering is load-bearing: the artifact
  // pass consumes `entityCoverageByOwner`, which step 5 populates as it
  // commits fresh entity-segment vectors THIS pass. Steps 1-2 above (both
  // grain-agnostic or artifact-only) are untouched by this move; step 4
  // (entity stale-close) runs next, unchanged.

  // Step 4 (entity stale-close, decision 17): every OPEN entity-grain vector
  // row for the CURRENT (profile_id, executable_binding_id) -- which, after
  // step 1, is every entity row this reconciler could still consider open --
  // whose owning entity RECORD is NOT visible at `generation` (closed,
  // superseded, or -- defensively -- simply gone) is closed. Deliberately
  // joined against `record_occurrences` by `document_ref = record_id`, NEVER
  // against `artifact_versions` by owner columns (that is step 2's join, and
  // step 2 is scoped away from entity rows precisely so this distinct join
  // can apply to them instead) -- an unchanged entity record legitimately
  // outlives its original owner artifact version, so closing on OWNER
  // version lifecycle would incorrectly close a still-valid, unchanged
  // entity vector on every unrelated edit to its owning file. The closing
  // generation is the record's own `valid_to_generation` when it has closed
  // (historically accurate, mirroring step 2's identical choice) or -- the
  // defensive case where no `record_occurrences` row is found at all, which
  // should not happen for a `document_ref` this reconciler itself wrote --
  // falls back to the CURRENT generation via `COALESCE`.
  // v4 storage wiring: `entitySource` present replaces the `record_occurrences`
  // LEFT JOIN entirely -- fetch every OPEN entity-grain row's `document_ref`,
  // ask the source which of those record ids are still visible, and treat
  // the rest as stale, closing AS OF the current generation (see
  // `SemanticEntityRecordSource.visibleRecordIds`'s own doc comment for why
  // this cannot recover an exact historical `valid_to_generation` the way
  // the v3 join does).
  // Frente S-D (2026-09-07, Lever 2): workspace-wide, unscoped by shard --
  // see the identical guard around steps 1/2 above for why only shard 0 (or
  // an unsharded call) runs it.
  if (input.shard === undefined || input.shard.index === 0) {
    const staleEntityRows: readonly StaleVectorRow[] = entitySource === undefined
      ? await sql.all<StaleVectorRow>(
          `SELECT vector_projection_rows.projection_record_id AS projection_record_id, vector_projection_rows.valid_from_generation AS valid_from_generation,
                  COALESCE(record_occurrences.valid_to_generation, ?) AS closing_generation, vector_projection_rows.document_ref AS document_id
             FROM vector_projection_rows
             LEFT JOIN record_occurrences ON record_occurrences.workspace_id = vector_projection_rows.workspace_id
              AND record_occurrences.record_id = vector_projection_rows.document_ref
            WHERE vector_projection_rows.workspace_id = ? AND vector_projection_rows.valid_to_generation IS NULL
              AND vector_projection_rows.document_grain = 'entity'
              AND vector_projection_rows.profile_id = ? AND vector_projection_rows.executable_binding_id = ?
              AND (record_occurrences.record_id IS NULL OR NOT (
                record_occurrences.valid_from_generation <= ? AND (record_occurrences.valid_to_generation IS NULL OR record_occurrences.valid_to_generation > ?)
              ))`,
          [generation, workspaceId, profileId, executableBindingId, generation, generation],
        )
      : await (async (): Promise<readonly StaleVectorRow[]> => {
          const openRows = await sql.all<{ projection_record_id: string; valid_from_generation: number; document_ref: string }>(
            `SELECT projection_record_id, valid_from_generation, document_ref
               FROM vector_projection_rows
              WHERE workspace_id = ? AND valid_to_generation IS NULL AND document_grain = 'entity'
                AND profile_id = ? AND executable_binding_id = ?`,
            [workspaceId, profileId, executableBindingId],
          );
          if (openRows.length === 0) return [];
          const visible = await entitySource.visibleRecordIds([...new Set(openRows.map((row) => row.document_ref))]);
          return openRows.filter((row) => !visible.has(row.document_ref)).map((row) => ({
            projection_record_id: row.projection_record_id, valid_from_generation: row.valid_from_generation,
            closing_generation: generation, document_id: row.document_ref,
          }));
        })();
    for (const row of staleEntityRows) {
      if (shouldAbort?.()) return buildResult(generation, false, true);
      // Plan 2026-09-06 (Frente S-A): same one-transaction close+delete as
      // step 2's identical stale-close loop above.
      await sql.transaction([
        { kind: "run", sql: "UPDATE vector_projection_rows SET valid_to_generation = ? WHERE workspace_id = ? AND projection_record_id = ? AND valid_from_generation = ?", params: [row.closing_generation, workspaceId, row.projection_record_id, row.valid_from_generation] },
        documentStatusDeleteCommand({ workspaceId, profileId, executableBindingId, documentGrain: "entity", documentId: row.document_id }),
      ]);
      counts.closed += 1;
      counts.entity_closed += 1;
      await yieldToEventLoop();
    }
  }

  // Step 5 (insert missing, ENTITY grain, decision 17): every visible entity
  // RECORD (category `'entity'`, record kind not the whole-file/module kind)
  // at `generation` with no OPEN entity-grain vector row (keyed by
  // `document_ref = record_id`, NOT by owner artifact version -- see step 4)
  // under the CURRENT (profile_id, executable_binding_id). Joined against
  // `artifact_versions`/`source_artifacts` to fetch the record's CURRENT
  // owner's CAS metadata for the text read below -- deliberately WITHOUT an
  // owner-version visibility filter (unlike step 3's artifact query): a
  // reused record's owner version may be a CLOSED, historical one (see step
  // 4's doc comment), and its CAS bytes remain the correct, retained source
  // of truth for that record's span regardless. `encoding <> 'binary'` is
  // still asserted defensively even though no entity record can realistically
  // own a binary file (the JS/TS analyzer that produces entity records only
  // ever runs against text it already parsed).
  // v4 storage wiring: normalized row shape both branches populate --
  // `body` is set (pre-decoded) only for a v4-sourced row; `body_payload` is
  // set (or `null`, meaning "decode via `record_value_nodes`") only for a
  // v3-sourced row. The per-row decode below stays exactly as lazy for v3 as
  // it always was (only reached once `fileState.status === "ok"`); a v4 row
  // has nothing left to decode, since `entityCandidates()` already returned
  // it decoded.
  type EntityInsertRow = {
    readonly record_id: string;
    readonly record_kind: string;
    readonly owner_artifact_id: string;
    readonly owner_artifact_version_id: string;
    readonly valid_from_generation: number;
    readonly content_hash: string;
    readonly byte_length: number;
    readonly display_path: string | null;
    readonly body_payload?: Uint8Array | ArrayBuffer | null;
    readonly body?: Readonly<Record<string, unknown>>;
  };
  // Frente S-E (2026-09-07): owning-file text state, read (and its
  // oversized/undecodable outcome cached) once per distinct owning artifact
  // version -- a bounded LRU (not a single "current owner" slot) because the
  // v4 streaming path below (see `entitySource.entityCandidates`'s own doc
  // comment) can no longer guarantee every entity from the same owning file
  // arrives adjacently: pages come from `records_for_query_batches` in
  // whatever order the store's own keyset pagination yields, not sorted by
  // owner. A single-slot cache would silently degrade to "re-read on every
  // row" the instant two different owners interleave across a page boundary
  // -- the v3 path (still `ORDER BY owner_artifact_version_id`) only ever
  // needs slot 1 of this cache in practice, so this is a strict superset of
  // its old behavior, never a regression for it.
  const OWNER_FILE_STATE_CACHE_CAP = 64;
  type OwningFileState = { readonly status: "ok"; readonly text: string } | { readonly status: "oversized" } | { readonly status: "undecodable" };
  const ownerFileStateCache = new Map<string, OwningFileState>();
  const ownerFileState = async (ownerVersionId: string, byteLength: number, contentHash: string): Promise<OwningFileState> => {
    const cached = ownerFileStateCache.get(ownerVersionId);
    if (cached !== undefined) {
      // Refresh recency (Map iteration/insertion order) for the LRU evict below.
      ownerFileStateCache.delete(ownerVersionId);
      ownerFileStateCache.set(ownerVersionId, cached);
      return cached;
    }
    let state: OwningFileState;
    if (byteLength > maxDocumentBytes) state = { status: "oversized" };
    else {
      const bytes = await content.read(contentHash);
      const text = decodeText(bytes);
      state = text === undefined ? { status: "undecodable" } : { status: "ok", text };
    }
    ownerFileStateCache.set(ownerVersionId, state);
    if (ownerFileStateCache.size > OWNER_FILE_STATE_CACHE_CAP) {
      const oldest = ownerFileStateCache.keys().next().value;
      if (oldest !== undefined) ownerFileStateCache.delete(oldest);
    }
    return state;
  };

  let entityPendingBatch: PendingEmbedItem[] = [];
  let entityLoopAborted = false;
  const processMissingEntityRow = async (row: EntityInsertRow): Promise<void> => {
    // Same batch-scoped abort checkpoint as step 3's loop -- see its own
    // comment. The owning-file read below is part of "this row's own work"
    // the checkpoint protects, exactly like step 3's `content.read` call.
    if (entityPendingBatch.length === 0 && shouldAbort?.()) { entityLoopAborted = true; return; }
    const fileState = await ownerFileState(row.owner_artifact_version_id, row.byte_length, row.content_hash);
    const entityDisplayPath = row.display_path ?? row.owner_artifact_id;
    if (fileState.status === "oversized") {
      counts.entity_skipped_oversized += 1;
      await writeStatusRow({ documentGrain: "entity", documentId: row.record_id, artifactId: row.owner_artifact_id, artifactVersionId: row.owner_artifact_version_id, displayPath: entityDisplayPath, status: "excluded", reasonCodes: ["oversized"] });
      return;
    }
    if (fileState.status === "undecodable") {
      counts.entity_skipped_undecodable += 1;
      await writeStatusRow({ documentGrain: "entity", documentId: row.record_id, artifactId: row.owner_artifact_id, artifactVersionId: row.owner_artifact_version_id, displayPath: entityDisplayPath, status: "excluded", reasonCodes: ["binary"] });
      return;
    }
    // v4 storage wiring: `row.body` is already decoded (native-store scan) --
    // never re-decode it, and never fall into the v3-only `record_value_nodes`
    // fallback (that table does not exist in the v4 catalog schema at all).
    const body = row.body !== undefined
      ? row.body
      : row.body_payload == null
        ? decodeEntityRecordBody(hydrateRelationalValue(await sql.all<Record<string, unknown> & RelationalValueRow>("SELECT workspace_id, record_id, valid_from_generation, value_path, parent_path, sequence_ordinal, map_key, value_kind, text_value, integer_value, real_value, bool_value, bytes_value FROM record_value_nodes WHERE workspace_id = ? AND record_id = ? AND valid_from_generation = ? ORDER BY value_path", [workspaceId, row.record_id, row.valid_from_generation])))
        : decodeEntityRecordBody(decodeCanonical(row.body_payload instanceof Uint8Array ? row.body_payload : new Uint8Array(row.body_payload)));
    const eligibility = evaluateEntityEligibility(row.record_kind, body, fileState.text, minEntitySpanLength);
    if (!eligibility.eligible) {
      counts.entity_skipped_ineligible += 1;
      // Decided in implementation: a body `kind` this reconciler never
      // embeds regardless of span/position (`INELIGIBLE_ENTITY_BODY_KINDS`,
      // e.g. `"parameter"`) is `unsupported_kind`; every other ineligibility
      // reason `evaluateEntityEligibility` checks (span too short, or not a
      // top-level/column-0 declaration) is `below_min_length` -- the closest
      // fit in the fixed vocabulary for "this span/position never
      // qualifies".
      const bodyKind = typeof body["kind"] === "string" ? body["kind"] as string : undefined;
      const reasonCode = bodyKind !== undefined && INELIGIBLE_ENTITY_BODY_KINDS.has(bodyKind) ? "unsupported_kind" : "below_min_length";
      await writeStatusRow({ documentGrain: "entity", documentId: row.record_id, artifactId: row.owner_artifact_id, artifactVersionId: row.owner_artifact_version_id, displayPath: entityDisplayPath, status: reasonCode === "unsupported_kind" ? "unsupported" : "excluded", reasonCodes: [reasonCode] });
      return;
    }
    const spanText = fileState.text.slice(eligibility.start, eligibility.end);
    const docComment = leadingDocComment(fileState.text, eligibility.start);
    const embeddingText = renderEntityDocument({ kind: eligibility.kind, label: eligibility.label, docComment, spanText });
    if (!EMBEDDABLE_TOKEN_PATTERN.test(embeddingText)) {
      counts.entity_skipped_empty += 1;
      await writeStatusRow({ documentGrain: "entity", documentId: row.record_id, artifactId: row.owner_artifact_id, artifactVersionId: row.owner_artifact_version_id, displayPath: entityDisplayPath, status: "excluded", reasonCodes: ["below_min_length"] });
      return;
    }
    // Identity is a pure function of the RECORD id alone (see
    // `entityDocumentId`'s own doc comment) -- back-dated to the RECORD's own
    // `valid_from_generation` (not the owning file's), so a reused record
    // that keeps an OLD owner version still gets a vector visible from
    // exactly when the RECORD itself became visible.
    const documentId = entityDocumentId(row.record_id);
    // Frente S-B (2026-09-06, decision 17 segmentation): the CURRENT
    // provider's OWN segmenter (`.binding.segment`) splits this entity's
    // rendered text into its per-segment spans -- a binding that has not
    // implemented `segment` (should not happen for any of the three shipped
    // providers, kept for architectural symmetry with `generateVectors`'
    // identical optionality) is treated as "one segment covering the whole
    // text", per `SemanticRuntimeBinding.segment`'s own doc comment.
    const segmentation = provider.binding.segment !== undefined
      ? await provider.binding.segment(embeddingText)
      : { segments: [{ index: 0, text: embeddingText, start_char: 0, end_char: embeddingText.length }], truncated: false };
    if (segmentation.segments.length === 0) {
      // Defensive: `embeddingText` already passed `EMBEDDABLE_TOKEN_PATTERN`
      // above, so a real segmenter should never produce zero segments here --
      // treated the same as the empty-text skip immediately above it.
      counts.entity_skipped_empty += 1;
      await writeStatusRow({ documentGrain: "entity", documentId: row.record_id, artifactId: row.owner_artifact_id, artifactVersionId: row.owner_artifact_version_id, displayPath: entityDisplayPath, status: "excluded", reasonCodes: ["below_min_length"] });
      return;
    }
    // Registered BEFORE any of this record's segment items are pushed into
    // `entityPendingBatch` -- see `EntityDocumentAggregate`'s own doc
    // comment for why this ordering is load-bearing (a segment can settle,
    // and therefore look up this aggregate, the instant its OWN batch flush
    // resolves, which can happen before every sibling segment has even been
    // pushed if `embedBatchSize` is smaller than this record's own segment
    // count -- but never before ALL of THIS record's segments have been
    // pushed in THIS same loop iteration, since nothing yields control back
    // to another `for` iteration between here and the loop below).
    registerEntityDocument(row.record_id, {
      artifactId: row.owner_artifact_id, artifactVersionId: row.owner_artifact_version_id, displayPath: entityDisplayPath,
      totalSegments: segmentation.segments.length, truncated: segmentation.truncated,
      spanStart: eligibility.start, spanEnd: eligibility.end,
    });
    for (const segment of segmentation.segments) {
      const projectionRecordId = semanticVectorProjectionRecordId({ document_id: documentId, profile_id: profileId, executable_binding_id: executableBindingId, segment_index: segment.index });
      entityPendingBatch.push({
        embeddingText: segment.text, projectionRecordId,
        ownerArtifactId: row.owner_artifact_id, ownerArtifactVersionId: row.owner_artifact_version_id,
        validFromGeneration: row.valid_from_generation, documentGrain: "entity", documentRef: row.record_id,
        displayPath: entityDisplayPath, segmentIndex: segment.index, segmentStart: segment.start_char, segmentEnd: segment.end_char,
      });
      if (entityPendingBatch.length < embedBatchSize) continue;
      await embedAndCommitBatch(entityPendingBatch);
      entityPendingBatch = [];
    }
  };

  if (entitySource === undefined) {
    // v3 path: UNCHANGED shape (one `ORDER BY owner_artifact_version_id,
    // record_id` query, one array, one `for` loop) -- `record_occurrences`
    // is small enough at v3 scale that this never needed streaming, and this
    // frente never rewrites the v3 path (see this file's own recurring
    // doc-comment convention).
    const missingEntityRows = await sql.all<MissingEntityRow>(
      `SELECT record_occurrences.record_id AS record_id, record_occurrences.kind AS record_kind,
              record_occurrences.owner_artifact_id AS owner_artifact_id, record_occurrences.owner_artifact_version_id AS owner_artifact_version_id,
              record_occurrences.valid_from_generation AS valid_from_generation,
              artifact_versions.content_hash AS content_hash, artifact_versions.byte_length AS byte_length,
              source_artifacts.display_path AS display_path, record_occurrences.body_payload AS body_payload
         FROM record_occurrences
         JOIN artifact_versions ON artifact_versions.workspace_id = record_occurrences.workspace_id
          AND artifact_versions.artifact_id = record_occurrences.owner_artifact_id
          AND artifact_versions.artifact_version_id = record_occurrences.owner_artifact_version_id
         JOIN source_artifacts ON source_artifacts.workspace_id = record_occurrences.workspace_id AND source_artifacts.artifact_id = record_occurrences.owner_artifact_id
        WHERE record_occurrences.workspace_id = ? AND record_occurrences.category = 'entity' AND record_occurrences.kind <> ?
          AND artifact_versions.encoding <> 'binary'
          AND record_occurrences.valid_from_generation <= ?
          AND (record_occurrences.valid_to_generation IS NULL OR record_occurrences.valid_to_generation > ?)
          AND NOT EXISTS (
            SELECT 1 FROM vector_projection_rows
             WHERE vector_projection_rows.workspace_id = record_occurrences.workspace_id
               AND vector_projection_rows.document_grain = 'entity'
               AND vector_projection_rows.document_ref = record_occurrences.record_id
               AND vector_projection_rows.valid_to_generation IS NULL
               AND vector_projection_rows.profile_id = ? AND vector_projection_rows.executable_binding_id = ?
          )
        ORDER BY record_occurrences.owner_artifact_version_id, record_occurrences.record_id`,
      [workspaceId, INELIGIBLE_ENTITY_RECORD_KIND, generation, generation, profileId, executableBindingId],
    );
    // Frente S-D (2026-09-07, Lever 2): shard filter -- BY OWNING ARTIFACT (see `shard`'s own doc comment).
    const shardedMissingEntityRows = input.shard === undefined ? missingEntityRows : missingEntityRows.filter((row) => shardIndexFor(row.owner_artifact_id, input.shard!.count) === input.shard!.index);
    for (const row of shardedMissingEntityRows) {
      if (entityLoopAborted) break;
      await processMissingEntityRow(row);
    }
  } else {
    // Frente S-E (2026-09-07): v4 path -- STREAMS pages from
    // `entitySource.entityCandidates` instead of materializing one
    // corpus-wide array (see that method's own doc comment for the OOM this
    // fixes). `openIds` (which entities already have an open vector row) is
    // its own small, bounded query -- unrelated to the OOM this fixes, since
    // it holds only ids, not decoded bodies.
    const openRows = await sql.all<{ document_ref: string }>(
      `SELECT document_ref FROM vector_projection_rows
        WHERE workspace_id = ? AND document_grain = 'entity' AND valid_to_generation IS NULL
          AND profile_id = ? AND executable_binding_id = ?`,
      [workspaceId, profileId, executableBindingId],
    );
    const openIds = new Set(openRows.map((row) => row.document_ref));
    await entitySource.entityCandidates(async (page) => {
      if (entityLoopAborted) return;
      const missing = page
        .filter((row) => row.record_kind !== INELIGIBLE_ENTITY_RECORD_KIND && !openIds.has(row.record_id))
        .filter((row) => input.shard === undefined || shardIndexFor(row.owner_artifact_id, input.shard.count) === input.shard.index)
        .map((row): EntityInsertRow => ({
          record_id: row.record_id, record_kind: row.record_kind, owner_artifact_id: row.owner_artifact_id,
          owner_artifact_version_id: row.owner_artifact_version_id, valid_from_generation: generation,
          content_hash: row.content_hash, byte_length: row.byte_length, display_path: row.display_path, body: row.body,
        }))
        // Page-local sort only (see `ownerFileState`'s own doc comment for
        // why a global sort is no longer possible/needed): maximizes
        // consecutive-same-owner runs WITHIN this page, cheap (one page's
        // worth of lightweight rows, no CAS reads yet).
        .sort((left, right) => left.owner_artifact_version_id.localeCompare(right.owner_artifact_version_id) || left.record_id.localeCompare(right.record_id));
      for (const row of missing) {
        if (entityLoopAborted) break;
        await processMissingEntityRow(row);
      }
    });
  }
  if (entityLoopAborted) return buildResult(generation, false, true);
  if (entityPendingBatch.length > 0) await embedAndCommitBatch(entityPendingBatch);

  // Step 3 (insert missing, ARTIFACT grain): every version visible at
  // `generation`, whose scan-time encoding decision was "not binary", that
  // has no OPEN ARTIFACT-grain vector row for the CURRENT (profile_id,
  // executable_binding_id) -- this covers both a version that has NEVER been
  // embedded under any provider, and a version whose only prior row(s) were
  // just closed above (profile swap or stale close). Restricted to
  // `vector_projection_rows.document_grain IS NULL` in the `NOT EXISTS`
  // subquery for the identical reason step 2 restricts its own join: an
  // entity vector can share this exact `(owner_artifact_id,
  // owner_artifact_version_id)` pair with the file's OWN artifact document
  // (every entity produced by this same scan of this same file does, by
  // construction) -- without this filter, that entity row alone would make
  // this query believe the file's artifact-grain document was "already
  // covered" and skip embedding it entirely, the first time this reconciler
  // ever ran on a fresh workspace.
  //
  // Frente S-D (2026-09-07, Lever 1 -- MOVED here, after step 5): this step
  // used to run right after step 2, before any entity work. It now runs
  // AFTER step 5 (the entity insert loop above) so that `entityCoverageByOwner`
  // is fully populated by the time this loop starts -- every entity this
  // pass freshly embedded for a given owning file is already committed and
  // captured there (see that map's own doc comment). For a document with a
  // non-empty coverage entry, the artifact vector is composed from those
  // entity segment vectors plus fresh vectors of only the file text NOT
  // covered by any eligible entity span ("gap" text) -- see the branch
  // inside the loop below. For every other document (no coverage this pass:
  // zero eligible entities, or every one of them reopened rather than
  // inserted -- see `entityCoverageByOwner`'s doc comment), this step is
  // BYTE-FOR-BYTE the same fresh whole-file embed it always was.
  const missingRows = await sql.all<MissingVectorRow>(
    `SELECT artifact_versions.artifact_id AS artifact_id, artifact_versions.artifact_version_id AS artifact_version_id,
            artifact_versions.content_hash AS content_hash, artifact_versions.byte_length AS byte_length,
            artifact_versions.valid_from_generation AS valid_from_generation, source_artifacts.display_path AS display_path
       FROM artifact_versions
       JOIN source_artifacts ON source_artifacts.workspace_id = artifact_versions.workspace_id AND source_artifacts.artifact_id = artifact_versions.artifact_id
      WHERE artifact_versions.workspace_id = ? AND artifact_versions.encoding <> 'binary'
        AND artifact_versions.valid_from_generation <= ?
        AND (artifact_versions.valid_to_generation IS NULL OR artifact_versions.valid_to_generation > ?)
        AND NOT EXISTS (
          SELECT 1 FROM vector_projection_rows
           WHERE vector_projection_rows.workspace_id = artifact_versions.workspace_id
             AND vector_projection_rows.owner_artifact_id = artifact_versions.artifact_id
             AND vector_projection_rows.owner_artifact_version_id = artifact_versions.artifact_version_id
             AND vector_projection_rows.valid_to_generation IS NULL
             AND vector_projection_rows.document_grain IS NULL
             AND vector_projection_rows.profile_id = ? AND vector_projection_rows.executable_binding_id = ?
        )
      ORDER BY artifact_versions.artifact_id, artifact_versions.artifact_version_id`,
    [workspaceId, generation, generation, profileId, executableBindingId],
  );
  // Frente S-D (2026-09-07, Lever 2): shard filter -- same rationale as
  // `shardedMissingEntityRows` above (BY OWNING ARTIFACT, keeping a file's
  // artifact document in the SAME shard as its own entities).
  const shardedMissingRows = input.shard === undefined ? missingRows : missingRows.filter((row) => shardIndexFor(row.artifact_id, input.shard!.count) === input.shard!.index);

  let pendingBatch: PendingEmbedItem[] = [];
  for (const row of shardedMissingRows) {
    // Checked exactly once per BATCH (whole-file path) or once per DOCUMENT
    // (composed path, see below) -- right before the FIRST row of a fresh
    // batch (or the composed document itself) does any of its own
    // read/decode/filter work. This is what makes `embed_batch_size: 1`
    // reproduce the pre-batching per-document checkpoint exactly (see that
    // field's own doc comment): with batches of size one, `pendingBatch`
    // returns to empty after every single document's own embed+commit, so
    // this fires before every row's read, same as before. For a larger
    // batch, every row AFTER the first one already collecting into a
    // non-empty `pendingBatch` skips this check -- the batch itself is the
    // atom the checkpoint now protects, not each individual row's read.
    if (pendingBatch.length === 0 && shouldAbort?.()) return buildResult(generation, false, true);
    const displayPath = row.display_path ?? row.artifact_id;
    if (row.byte_length > maxDocumentBytes) {
      counts.skipped_oversized += 1;
      await writeStatusRow({ documentGrain: "artifact", documentId: row.artifact_version_id, artifactId: row.artifact_id, artifactVersionId: row.artifact_version_id, displayPath, status: "excluded", reasonCodes: ["oversized"] });
      continue;
    }
    const bytes = await content.read(row.content_hash);
    const text = decodeText(bytes);
    if (text === undefined) {
      counts.skipped_undecodable += 1;
      // Decided in implementation: the fixed reason-code vocabulary (plan
      // §4.1) has no separate code for "declared non-binary but does not
      // decode as clean UTF-8" -- reusing `binary` here is the closest fit
      // (both mean "not real embeddable text"), never silently dropped from
      // the affected view.
      await writeStatusRow({ documentGrain: "artifact", documentId: row.artifact_version_id, artifactId: row.artifact_id, artifactVersionId: row.artifact_version_id, displayPath, status: "excluded", reasonCodes: ["binary"] });
      continue;
    }

    // Frente S-D (2026-09-07, Lever 1): does THIS pass's entity step already
    // have fresh, current-generation entity-segment vectors for THIS EXACT
    // `artifact_version_id`? If so, compose the artifact vector from them
    // instead of a fresh whole-file embed.
    const coverage = entityCoverageByOwner.get(row.artifact_version_id);
    if (coverage !== undefined && coverage.length > 0) {
      await waitForQueryDrain();
      const mergedCovered = mergeSpans(coverage.map((entry) => ({ start: entry.start, end: entry.end })));
      const gapRanges = complementSpans(mergedCovered, text.length);
      const gapText = gapRanges.map((range) => text.slice(range.start, range.end)).join("\n");
      const entityVectors = coverage.flatMap((entry) => entry.vectors);
      let gapVectors: readonly Uint8Array[] = [];
      let gapTruncated = false;
      if (EMBEDDABLE_TOKEN_PATTERN.test(gapText)) {
        const gapSegmentation: Segmentation = provider.binding.segment !== undefined
          ? await provider.binding.segment(gapText)
          : { segments: [{ index: 0, text: gapText, start_char: 0, end_char: gapText.length }], truncated: false };
        const gapCap = Number.isSafeInteger(input.entity_policy?.max_gap_segments) && input.entity_policy!.max_gap_segments! > 0 ? input.entity_policy!.max_gap_segments! : undefined;
        const cappedSegments = gapCap !== undefined && gapSegmentation.segments.length > gapCap ? gapSegmentation.segments.slice(0, gapCap) : gapSegmentation.segments;
        gapTruncated = gapSegmentation.truncated || cappedSegments.length < gapSegmentation.segments.length;
        try {
          gapVectors = await embedPlainTexts(cappedSegments.map((segment) => segment.text));
        } catch {
          // Same "left missing, retried next pass" tradeoff every other
          // provider failure in this reconciler accepts -- see
          // `embedAndCommitBatch`'s own identical doc comment.
          counts.failed += 1;
          await writeStatusRow({ documentGrain: "artifact", documentId: row.artifact_version_id, artifactId: row.artifact_id, artifactVersionId: row.artifact_version_id, displayPath, status: "failed", reasonCodes: ["provider_error:generate_vector_failed"] });
          continue;
        }
      }
      const allVectors = [...entityVectors, ...gapVectors];
      if (allVectors.length === 0) {
        // Defensive: an eligible entity's own span is, by construction,
        // non-empty, so `entityVectors` alone should never be empty here --
        // handled the same way the ordinary whole-file empty-text check is,
        // never silently skipped.
        counts.skipped_empty += 1;
        await writeStatusRow({ documentGrain: "artifact", documentId: row.artifact_version_id, artifactId: row.artifact_id, artifactVersionId: row.artifact_version_id, displayPath, status: "excluded", reasonCodes: ["below_min_length"] });
        continue;
      }
      const combinedVector = combineVectorsMeanNormalized(allVectors, provider.profile);
      const generated: SemanticGeneratedVector = {
        vector: combinedVector,
        vector_digest: digestBytes(combinedVector),
        input_digest: digestBytes(canonicalBytes({ kind: "artifact-composition", entity_segments: entityVectors.length, gap_segments: gapVectors.length })),
        profile_digest: provider.profile.profile_digest,
      };
      const composedDocument = buildSemanticDocument({ artifact_id: row.artifact_id, artifact_version_id: row.artifact_version_id, display_path: displayPath, content_class: "source", language_ids: [], source_text: text });
      const projectionRecordId = semanticVectorProjectionRecordId({ document_id: composedDocument.document_id, profile_id: profileId, executable_binding_id: executableBindingId });
      const composedItem: PendingEmbedItem = {
        embeddingText: "", // Unused: `commitGeneratedVector` never reads `.embeddingText`, only `generated.vector` (already computed above).
        projectionRecordId, ownerArtifactId: row.artifact_id, ownerArtifactVersionId: row.artifact_version_id,
        validFromGeneration: row.valid_from_generation, displayPath,
        artifactSegmentCount: allVectors.length, ...(gapTruncated ? { artifactReasonCodes: ["segments_truncated"] } : {}),
      };
      await commitGeneratedVector(composedItem, generated);
      continue;
    }

    const document = buildSemanticDocument({
      artifact_id: row.artifact_id,
      artifact_version_id: row.artifact_version_id,
      display_path: displayPath,
      content_class: "source",
      language_ids: [],
      source_text: text,
    });
    const embeddingText = document.sections.map((section) => section.text).join("\n");
    // See `EMBEDDABLE_TOKEN_PATTERN`'s doc comment: classified BEFORE ever
    // calling the provider, so this never costs a network round trip (HTTP
    // provider) or risks matching the wrong thrown error (local provider).
    if (!EMBEDDABLE_TOKEN_PATTERN.test(embeddingText)) {
      counts.skipped_empty += 1;
      // Decided in implementation: an empty/degenerate document is
      // permanently unembeddable content, closest to `below_min_length` in
      // the fixed vocabulary (there is no dedicated "empty" code).
      await writeStatusRow({ documentGrain: "artifact", documentId: row.artifact_version_id, artifactId: row.artifact_id, artifactVersionId: row.artifact_version_id, displayPath, status: "excluded", reasonCodes: ["below_min_length"] });
      continue;
    }
    // Every new row is back-dated to the version's own
    // `valid_from_generation`, same as `reconcileLexicalProjection` does for
    // lexical documents: it makes the vector visible starting from exactly
    // when its content became visible, not merely from whenever this
    // reconcile pass happened to run. This is safe unconditionally --
    // including for the profile-swap-rebuild case where the same version's
    // OLD vector row was just closed by step 1 at this exact generation --
    // because `projection_record_id` is scoped by vector space (see
    // `semanticVectorProjectionRecordId`), so the old and new rows can never
    // share a primary key.
    const projectionRecordId = semanticVectorProjectionRecordId({ document_id: document.document_id, profile_id: profileId, executable_binding_id: executableBindingId });
    pendingBatch.push({ embeddingText, projectionRecordId, ownerArtifactId: row.artifact_id, ownerArtifactVersionId: row.artifact_version_id, validFromGeneration: row.valid_from_generation, displayPath });
    if (pendingBatch.length < embedBatchSize) continue;
    await embedAndCommitBatch(pendingBatch);
    pendingBatch = [];
  }
  // A trailing partial batch (fewer than `embedBatchSize` documents left)
  // already had its one abort check above, at the point its first row
  // started it from empty -- nothing further to check before this dispatch.
  if (pendingBatch.length > 0) await embedAndCommitBatch(pendingBatch);

  // Frente S-D (2026-09-07, Lever 2): a sharded call stops here -- it never
  // runs the workspace-wide bulk status maintenance below, and never writes
  // the completion marker, regardless of how clean its OWN portion was (see
  // `shard`'s own doc comment for why only the orchestrator's final,
  // unsharded call may conclude the whole workspace is caught up).
  // `marker_written` is therefore always `false` here for a sharded call.
  if (input.shard !== undefined) return buildResult(generation, false);

  // Plan 2026-09-06 (Frente S-A): bulk status-table maintenance -- binary/
  // unsupported-kind classification, covered-from-vectors backfill, and the
  // orphan sweep (see `syncDocumentStatusBulk`'s own doc comment). Runs on
  // every slow-path pass; each statement is a `NOT EXISTS`-scoped bulk
  // operation that becomes a near-zero-row no-op once the corpus has been
  // classified once, so this is cheap in the (common) steady state.
  await syncDocumentStatusBulk();

  // Only publish the completion marker if the workspace's current generation
  // is still exactly what step 1 (generation read) read -- same reasoning as
  // `reconcileLexicalProjection`'s identical recheck: a concurrent scan that
  // bumped it while this pass ran means what was just reconciled is already
  // stale, so this pass must not claim completeness for the NEW generation.
  //
  // UNLIKE the lexical reconciler, this also withholds the marker whenever
  // EITHER `failed` or `entity_failed` is nonzero: the `skipped_*`/
  // `entity_skipped_*` counters are permanent, deterministic functions of a
  // document's immutable content -- retrying them next pass would just
  // reproduce the identical skip, so marking the generation complete despite
  // them (matching lexical's behavior) is correct. A `failed`/`entity_failed`
  // row is the opposite: it is explicitly meant to be retried (see the doc
  // comment on the `catch` around `putVectors` above). If the marker were
  // written anyway, THIS function's own fast path (`semanticIndexState()`
  // matching `generation`+profile+binding+both document grains, at the very
  // top) would short-circuit every subsequent pass before it ever re-ran the
  // missing-vector queries -- permanently abandoning the failed row instead
  // of retrying it. Withholding the marker keeps the fast path closed until
  // every failure clears. `document_grains: ["artifact", "entity"]` is
  // therefore ALWAYS what gets written when the marker is written at all --
  // this reconciler always attempts both passes in one run, so "the marker
  // is current" and "both grains are current" are the same event now.
  const generationAfter = await currentGeneration();
  const cleanPass = counts.failed === 0 && counts.entity_failed === 0;
  const markerWritten = generationAfter === generation && cleanPass;
  if (markerWritten) {
    await database.projections.markSemanticComplete({ completed_generation: generation, profile_id: profileId, executable_binding_id: executableBindingId, document_grains: ["artifact", "entity"], entity_policy_digest: entityPolicyDigest });
    // Frente S-E (2026-09-07, adversarial review of Lever 3): the segment
    // cache (`semantic_segment_cache`) had no eviction at all -- its own DDL
    // comment admitted "no LRU yet ... pruned only by a future retention
    // pass". A cleanly-completed generation (the marker was just written,
    // above) is the natural point to prune: every row belonging to a NO
    // LONGER ACTIVE `executable_binding_id` (a retired provider/segmenter
    // version -- see `semanticVectorProjectionRecordId`'s own doc comment
    // for why a vector space retires wholesale on a provider swap) can never
    // be a cache hit again, since every embed call this reconciler makes is
    // scoped to the CURRENT `executableBindingId` alone
    // (`readCachedSegmentVector`/`writeCachedSegmentVector`, above). This
    // bounds the cache to at most one active vector space's worth of
    // distinct segment content per workspace, rather than accumulating one
    // generation of history per provider swap forever. Best-effort: a
    // failure here never fails the pass that already committed real vectors
    // and the marker -- the cache is purely an optimization, exactly like
    // its own read/write helpers' doc comments already establish.
    try {
      await sql.run("DELETE FROM semantic_segment_cache WHERE workspace_id = ? AND executable_binding_id <> ?", [workspaceId, executableBindingId]);
    } catch { /* best-effort pruning, see this block's own doc comment */ }
  }

  return buildResult(generation, markerWritten);
}
