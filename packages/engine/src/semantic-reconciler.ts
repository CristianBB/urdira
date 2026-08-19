import { canonicalBytes, decodeCanonical, digestBytes } from "@urdira/canonical";
import type { WorkspaceDatabase } from "@urdira/storage";
import { buildSemanticDocument } from "./semantic-documents.js";
import type { ResolvedSemanticProvider } from "./semantic-provider.js";
import type { SemanticGeneratedVector } from "./semantic-runtime.js";

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
export function semanticVectorProjectionRecordId(input: { readonly document_id: string; readonly profile_id: string; readonly executable_binding_id: string }): string {
  return `semantic-vector:${digestBytes(canonicalBytes({ document_id: input.document_id, profile_id: input.profile_id, executable_binding_id: input.executable_binding_id }))}`;
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
  /** Decision 17: entity-grain vectors newly embedded and written this pass (step 5). */
  readonly entity_inserted: number;
  /** Decision 17: entity-grain vector rows closed this pass (step 4) because their owning entity record is no longer visible. A SUBSET of `closed` above, not an addition to it -- see `closed`'s own doc comment. */
  readonly entity_closed: number;
  /** Decision 17: candidate entity records skipped because their OWNING FILE's declared byte length exceeded `max_document_bytes` -- every other entity in that same file is skipped for the identical reason, without ever reading its text. */
  readonly entity_skipped_oversized: number;
  /** Decision 17: candidate entity records skipped because their owning file's CAS bytes did not decode as clean UTF-8 text. */
  readonly entity_skipped_undecodable: number;
  /** Decision 17: candidate entity records whose owning file WAS readable, but which failed the eligibility policy itself (body `kind` is `"parameter"`, span shorter than `min_span_length`, or not a top-level (column-0) declaration -- see `evaluateEntityEligibility`). Permanent for this content, same as `skipped_oversized`/`skipped_undecodable`/`skipped_empty` -- never retried unless the record's own content changes or the policy is loosened. */
  readonly entity_skipped_ineligible: number;
  /** Decision 17: eligible, decodable entity documents skipped because their rendered text contained no embeddable token. */
  readonly entity_skipped_empty: number;
  /** Decision 17: entity documents whose embedding provider call threw for a reason other than "no embeddable token" -- left missing, retried on the next pass, and (like `failed`) withholds the completion marker until it clears. */
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
/** Default for `ReconcileSemanticProjectionInput.entity_policy.min_span_length` -- decision 17's measured policy (excalidraw-scale gate: 2,544 eligible docs at this threshold). */
const DEFAULT_MIN_ENTITY_SPAN_LENGTH = 120;
/** The record `kind` column value for whole-file/module entity records -- decision 17's measurement-driven policy amendment: these duplicate the artifact-grain document of the same file (654 of them on the bench corpus, some 400KB+), so they are never entity-eligible regardless of span length. See `packages/plugin-javascript-typescript/src/fact-delta.ts`'s `proposalRecord` for where this kind string is produced. */
const INELIGIBLE_ENTITY_RECORD_KIND = "jsts:entity_container";
/** Body `kind` values (the analyzer's own per-entity `kind`, e.g. `"function"`/`"class"`/`"variable"`/`"parameter"`) that are never entity-eligible regardless of span or position. */
const INELIGIBLE_ENTITY_BODY_KINDS = new Set(["parameter"]);

/**
 * Hands control back to the event loop's I/O phase between documents -- the
 * exact same rationale as `lexical-reconciler.ts`'s `yieldToEventLoop` (see
 * its doc comment for the full measurement-backed argument for `setImmediate`
 * specifically over a resolved promise or `setTimeout(fn, 0)`). It applies
 * here just as much as it does to lexical trigram computation: the bundled
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
  readonly record_payload: Uint8Array;
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly valid_from_generation: number;
  readonly content_hash: string;
  readonly byte_length: number;
  readonly display_path: string | null;
};

/**
 * Decodes ONE `record_occurrences.record_payload` blob (a canonical-encoded
 * `RecordEnvelope`) down to its `body` object -- mirrors `SqliteCanonicalQuerySnapshotPort.decodeRow`
 * (`canonical-query-data-port.ts`) exactly, minus that class's interner (this
 * reconciler runs once per record candidate, never re-decodes the same
 * record twice within a pass, so there is no repeat-decode cost to amortize).
 * Never throws: a malformed payload (should not happen for a row this
 * codebase's own writers produced) decodes to an empty body, which
 * `evaluateEntityEligibility` below then correctly rejects as ineligible
 * (missing `kind`/`start`/`end`) rather than crashing the whole pass over one
 * bad row.
 */
function decodeEntityRecordBody(payload: Uint8Array): Record<string, unknown> {
  try {
    const decoded = decodeCanonical(payload) as Record<string, unknown>;
    const body = decoded["body"];
    return body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
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
type EntityEligibility =
  | { readonly eligible: false }
  | { readonly eligible: true; readonly kind: string; readonly label: string; readonly start: number; readonly end: number };

function evaluateEntityEligibility(recordKind: string, body: Record<string, unknown>, fileText: string, minSpanLength: number): EntityEligibility {
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
function leadingDocComment(text: string, start: number): string | undefined {
  let index = start;
  while (index > 0 && WHITESPACE_PATTERN.test(text[index - 1]!)) index -= 1;
  if (index < 2 || text[index - 2] !== "*" || text[index - 1] !== "/") return undefined;
  const openIndex = text.lastIndexOf("/**", index - 3);
  if (openIndex === -1) return undefined;
  return text.slice(openIndex, index);
}

/** Decision 17 rendering (PINNED): `<kind> <label>\n<leading doc comment if present>\n<source span text>`. Truncation to the provider's own document budget happens inside the provider itself (see `semantic-provider.ts`'s `HTTP_INPUT_TEXT_CAP` for the HTTP path; the bundled local providers embed the full text) -- exactly how the artifact pass's own rendered text already reaches the provider today, so this function does no truncation of its own. */
function renderEntityDocument(input: { readonly kind: string; readonly label: string; readonly docComment: string | undefined; readonly spanText: string }): string {
  const lines = [`${input.kind} ${input.label}`];
  if (input.docComment !== undefined) lines.push(input.docComment);
  lines.push(input.spanText);
  return lines.join("\n");
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
    return buildResult(generation, true);
  }

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
  // single raw `UPDATE` (`vector_projection_rows.vector_payload` is opaque,
  // immutable, raw vector bytes -- unlike `lexical_documents.document_payload`,
  // it carries no `valid_to_generation` field for a close to keep in sync,
  // so this needs no payload rewrite alongside the column; consistency of
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
            artifact_versions.valid_to_generation AS closing_generation
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
    await sql.run(
      "UPDATE vector_projection_rows SET valid_to_generation = ? WHERE workspace_id = ? AND projection_record_id = ? AND valid_from_generation = ?",
      [row.closing_generation, workspaceId, row.projection_record_id, row.valid_from_generation],
    );
    counts.closed += 1;
    await yieldToEventLoop();
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
  };

  const bumpInserted = (item: PendingEmbedItem): void => { if (item.documentGrain === "entity") counts.entity_inserted += 1; else counts.inserted += 1; };
  const bumpFailed = (item: PendingEmbedItem): void => { if (item.documentGrain === "entity") counts.entity_failed += 1; else counts.failed += 1; };

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
      if (parked.vector_digest !== generated.vector_digest) { bumpFailed(item); return; }
      if (parked.valid_to_generation !== null) {
        await sql.run(
          "UPDATE vector_projection_rows SET valid_to_generation = NULL WHERE workspace_id = ? AND projection_record_id = ? AND valid_from_generation = ?",
          [workspaceId, item.projectionRecordId, item.validFromGeneration],
        );
      }
      // An OPEN parked row (valid_to already NULL) cannot normally reach here
      // (the missing-rows queries exclude documents with an open current-
      // profile row), treated as already-covered either way.
      bumpInserted(item);
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
        // Omitted (not set to a literal `undefined`) for an artifact item:
        // `encodeCanonical` (`@urdira/canonical`) rejects an object property
        // whose value is `undefined` outright (`uce:forbidden_cbor_feature`)
        // -- unlike `JSON.stringify`, which silently drops such keys -- so
        // this must be a conditional spread, not a bare `document_grain:
        // item.documentGrain`.
        ...(item.documentGrain === undefined ? {} : { document_grain: item.documentGrain }),
        ...(item.documentRef === undefined ? {} : { document_ref: item.documentRef }),
      }]);
    } catch {
      // putVectors rejected the batch (shard conflict, invalid vector, ...):
      // left missing, retried next pass, marker withheld below.
      bumpFailed(item);
      return;
    }
    bumpInserted(item);
    // See `yieldToEventLoop`'s doc comment: this is the loop whose combined
    // per-document embedding cost is the one actually at risk of starving
    // the event loop across a large pass -- unchanged by batching, since a
    // yield still happens after every individual document's own write.
    await yieldToEventLoop();
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
    const generateVectors = provider.binding.generateVectors;
    if (generateVectors !== undefined) {
      try {
        const generated = await generateVectors(pending.map((item) => ({ profile: provider.profile, purpose: "document" as const, text: item.embeddingText })));
        if (generated.length !== pending.length) throw new Error(`Semantic runtime binding generateVectors returned ${generated.length} vectors for ${pending.length} inputs.`);
        for (let index = 0; index < pending.length; index += 1) await commitGeneratedVector(pending[index]!, generated[index]!);
        return;
      } catch {
        // Batch rejected (or shaped wrong): fall through to the per-document
        // fallback below instead of counting the whole batch as failed --
        // see this function's own doc comment.
      }
    }
    for (const item of pending) {
      let generated: SemanticGeneratedVector;
      try {
        generated = await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text: item.embeddingText });
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
        continue;
      }
      await commitGeneratedVector(item, generated);
    }
  };

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

  let pendingBatch: PendingEmbedItem[] = [];
  for (const row of missingRows) {
    // Checked exactly once per BATCH -- right before the FIRST row of a
    // fresh batch does any of its own read/decode/filter work, i.e.
    // whenever `pendingBatch` is currently empty. This is what makes
    // `embed_batch_size: 1` reproduce the pre-batching per-document
    // checkpoint exactly (see that field's own doc comment): with batches
    // of size one, `pendingBatch` returns to empty after every single
    // document's own embed+commit, so this fires before every row's read,
    // same as before. For a larger batch, every row AFTER the first one
    // already collecting into a non-empty `pendingBatch` skips this check --
    // the batch itself is the atom the checkpoint now protects, not each
    // individual row's read.
    if (pendingBatch.length === 0 && shouldAbort?.()) return buildResult(generation, false, true);
    if (row.byte_length > maxDocumentBytes) { counts.skipped_oversized += 1; continue; }
    const bytes = await content.read(row.content_hash);
    const text = decodeText(bytes);
    if (text === undefined) { counts.skipped_undecodable += 1; continue; }
    const document = buildSemanticDocument({
      artifact_id: row.artifact_id,
      artifact_version_id: row.artifact_version_id,
      display_path: row.display_path ?? row.artifact_id,
      content_class: "source",
      language_ids: [],
      source_text: text,
    });
    const embeddingText = document.sections.map((section) => section.text).join("\n");
    // See `EMBEDDABLE_TOKEN_PATTERN`'s doc comment: classified BEFORE ever
    // calling the provider, so this never costs a network round trip (HTTP
    // provider) or risks matching the wrong thrown error (local provider).
    if (!EMBEDDABLE_TOKEN_PATTERN.test(embeddingText)) { counts.skipped_empty += 1; continue; }
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
    pendingBatch.push({ embeddingText, projectionRecordId, ownerArtifactId: row.artifact_id, ownerArtifactVersionId: row.artifact_version_id, validFromGeneration: row.valid_from_generation });
    if (pendingBatch.length < embedBatchSize) continue;
    await embedAndCommitBatch(pendingBatch);
    pendingBatch = [];
  }
  // A trailing partial batch (fewer than `embedBatchSize` documents left)
  // already had its one abort check above, at the point its first row
  // started it from empty -- nothing further to check before this dispatch.
  if (pendingBatch.length > 0) await embedAndCommitBatch(pendingBatch);

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
  const staleEntityRows = await sql.all<StaleVectorRow>(
    `SELECT vector_projection_rows.projection_record_id AS projection_record_id, vector_projection_rows.valid_from_generation AS valid_from_generation,
            COALESCE(record_occurrences.valid_to_generation, ?) AS closing_generation
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
  );
  for (const row of staleEntityRows) {
    if (shouldAbort?.()) return buildResult(generation, false, true);
    await sql.run(
      "UPDATE vector_projection_rows SET valid_to_generation = ? WHERE workspace_id = ? AND projection_record_id = ? AND valid_from_generation = ?",
      [row.closing_generation, workspaceId, row.projection_record_id, row.valid_from_generation],
    );
    counts.closed += 1;
    counts.entity_closed += 1;
    await yieldToEventLoop();
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
  const missingEntityRows = await sql.all<MissingEntityRow>(
    `SELECT record_occurrences.record_id AS record_id, record_occurrences.kind AS record_kind, record_occurrences.record_payload AS record_payload,
            record_occurrences.owner_artifact_id AS owner_artifact_id, record_occurrences.owner_artifact_version_id AS owner_artifact_version_id,
            record_occurrences.valid_from_generation AS valid_from_generation,
            artifact_versions.content_hash AS content_hash, artifact_versions.byte_length AS byte_length,
            source_artifacts.display_path AS display_path
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

  // Owning-file text state for the CURRENT `owner_artifact_version_id` group
  // -- read (and its oversized/undecodable outcome cached) exactly ONCE per
  // distinct owning artifact version, never once per entity record, per the
  // embed-throughput constraint's "one CAS text read per owning file, no
  // per-entity CAS reads". Rows are grouped by `ORDER BY
  // record_occurrences.owner_artifact_version_id` above, so a plain
  // "did the owner id change" check below is sufficient -- no separate GROUP
  // BY or sort step needed.
  type OwningFileState = { readonly status: "ok"; readonly text: string } | { readonly status: "oversized" } | { readonly status: "undecodable" };
  let currentOwnerVersionId: string | undefined;
  let currentFileState: OwningFileState | undefined;

  let entityPendingBatch: PendingEmbedItem[] = [];
  for (const row of missingEntityRows) {
    // Same batch-scoped abort checkpoint as step 3's loop -- see its own
    // comment. The owning-file read below (when the owner id changes) is
    // part of "this row's own work" the checkpoint protects, exactly like
    // step 3's `content.read` call.
    if (entityPendingBatch.length === 0 && shouldAbort?.()) return buildResult(generation, false, true);
    if (row.owner_artifact_version_id !== currentOwnerVersionId) {
      currentOwnerVersionId = row.owner_artifact_version_id;
      if (row.byte_length > maxDocumentBytes) {
        currentFileState = { status: "oversized" };
      } else {
        const bytes = await content.read(row.content_hash);
        const text = decodeText(bytes);
        currentFileState = text === undefined ? { status: "undecodable" } : { status: "ok", text };
      }
    }
    const fileState = currentFileState!;
    if (fileState.status === "oversized") { counts.entity_skipped_oversized += 1; continue; }
    if (fileState.status === "undecodable") { counts.entity_skipped_undecodable += 1; continue; }
    const body = decodeEntityRecordBody(row.record_payload);
    const eligibility = evaluateEntityEligibility(row.record_kind, body, fileState.text, minEntitySpanLength);
    if (!eligibility.eligible) { counts.entity_skipped_ineligible += 1; continue; }
    const spanText = fileState.text.slice(eligibility.start, eligibility.end);
    const docComment = leadingDocComment(fileState.text, eligibility.start);
    const embeddingText = renderEntityDocument({ kind: eligibility.kind, label: eligibility.label, docComment, spanText });
    if (!EMBEDDABLE_TOKEN_PATTERN.test(embeddingText)) { counts.entity_skipped_empty += 1; continue; }
    // Identity is a pure function of the RECORD id alone (see
    // `entityDocumentId`'s own doc comment) -- back-dated to the RECORD's own
    // `valid_from_generation` (not the owning file's), so a reused record
    // that keeps an OLD owner version still gets a vector visible from
    // exactly when the RECORD itself became visible.
    const documentId = entityDocumentId(row.record_id);
    const projectionRecordId = semanticVectorProjectionRecordId({ document_id: documentId, profile_id: profileId, executable_binding_id: executableBindingId });
    entityPendingBatch.push({
      embeddingText, projectionRecordId,
      ownerArtifactId: row.owner_artifact_id, ownerArtifactVersionId: row.owner_artifact_version_id,
      validFromGeneration: row.valid_from_generation, documentGrain: "entity", documentRef: row.record_id,
    });
    if (entityPendingBatch.length < embedBatchSize) continue;
    await embedAndCommitBatch(entityPendingBatch);
    entityPendingBatch = [];
  }
  if (entityPendingBatch.length > 0) await embedAndCommitBatch(entityPendingBatch);

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
  if (markerWritten) await database.projections.markSemanticComplete({ completed_generation: generation, profile_id: profileId, executable_binding_id: executableBindingId, document_grains: ["artifact", "entity"], entity_policy_digest: entityPolicyDigest });

  return buildResult(generation, markerWritten);
}
