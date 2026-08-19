import { canonicalBytes, decodeCanonical, digestBytes, digestCanonicalArray, encodeArrayHeader, encodeCanonical } from "@urdira/canonical";
import type {
  CandidateIssue,
  CandidateMaterialization,
  CandidateWorkManifest,
  GenerationChangeManifest,
  IndexCandidate,
  PluginResolutionLock,
  RegistrySnapshot,
  WorkspaceConfigurationRevision,
  WorkspaceCurrentState,
  WorkspaceFreshnessCheckpoint,
} from "@urdira/contracts";
import type { BlobStore } from "./cas.js";
import { resetTimings, snapshotTimings, timed, timedSync, timingEnabled } from "./debug-timing.js";
import { StorageError } from "./errors.js";
import type { SqliteDatabase, SqliteValue } from "./sqlite.js";
export { canonicalFrozenCandidateBaseTuple, frozenCandidateBaseTupleDigest, normalizeObservationBatchIds, sameFrozenCandidateBaseTuple } from "./candidate-digest.js";

/**
 * The seven template arrays a sealed `CandidateMaterialization` describes
 * (see `packages/engine/src/candidate-materialization.ts`'s
 * `SealedCandidateMaterialization`), carried out-of-band from the
 * materialization itself. The materialization's Text fields hold only a
 * small, bounded `OrderedSetDescriptor` for each set (descriptor-as-text);
 * these are the real entries the descriptor describes, transported so
 * `WorkspaceCandidateRepository.saveMaterialization` can persist them as
 * CAS-backed segments and `buildCandidatePublicationPlan`
 * (`./publication-authority.js`) can install them without ever parsing a
 * giant JSON string.
 */
export interface CandidateTemplateSets {
  readonly source_transitions: readonly unknown[];
  readonly record_opens: readonly unknown[];
  readonly record_closures: readonly unknown[];
  readonly identity_assignments: readonly unknown[];
  readonly artifact_dependencies: readonly unknown[];
  readonly lookup_dependencies: readonly unknown[];
  readonly lookup_revalidations: readonly unknown[];
}

/** `set_kind` values for `candidate_template_segments`, in a stable, exported order. */
export const CANDIDATE_TEMPLATE_SET_KINDS = ["source_transitions", "record_opens", "record_closures", "identity_assignments", "artifact_dependencies", "lookup_dependencies", "lookup_revalidations"] as const;
export type CandidateTemplateSetKind = (typeof CANDIDATE_TEMPLATE_SET_KINDS)[number];

// Keep every segment below the canonical decoder's 16 MiB default limit, but
// avoid unnecessarily small CAS objects for compact record templates. The
// previous 500-entry/4 MiB bounds produced 1,030 CAS segments for the
// 979-file Excalidraw cold scan even though the largest observed segment was
// < 1 MiB; each segment still incurs a durable file fsync. These bounds keep a
// large safety margin under 16 MiB while reducing that durable-object count.
const TEMPLATE_SEGMENT_MAX_ENTRIES = 10_000;
const TEMPLATE_SEGMENT_TARGET_BYTES = 8 * 1024 * 1024;

// Bounded-memory batch size for persisting template segments' CAS blobs:
// `BlobStore.cas.putMany` already runs each blob's write/fsync work
// concurrently (bounded by `DEFAULT_PUT_CONCURRENCY` in cas.ts) and coalesces
// directory fsyncs across the whole call, turning what used to be hundreds
// of SERIAL file-fsync + dir-fsync round trips (one per `cas.put` call, one
// call per segment) into a handful of concurrent batches. Kept modest so
// persisting one candidate's whole segment set (which can run into the
// hundreds for a very large workspace) never holds more than this many
// segments' encoded payload bytes in memory at once -- segments are streamed
// (`streamTemplateSetSegments`/`streamAllTemplateSetSegments`, below) rather
// than all built and held before any persistence begins.
const TEMPLATE_SEGMENT_CAS_BATCH_SIZE = 16;

interface PendingTemplateSegment {
  readonly setKind: CandidateTemplateSetKind;
  readonly segmentOrdinal: number;
  readonly firstOrdinal: number;
  readonly lastOrdinal: number;
  readonly entryCount: number;
  readonly payload: Uint8Array;
  readonly contentDigest: string;
}

export interface FrozenCandidateBaseTuple {
  readonly snapshot_id?: string;
  readonly generation?: number;
  readonly registry_snapshot_id?: string;
  readonly resolution_lock_id?: string;
  readonly configuration_revision_id?: string;
  readonly source_state_digest: string;
  readonly source_observation_batch_ids: readonly string[];
  readonly tuple_digest: string;
}

export interface CandidatePublicationInput {
  readonly candidate: IndexCandidate;
  readonly frozen_base: FrozenCandidateBaseTuple;
  readonly materialization: CandidateMaterialization;
  readonly target_registry: RegistrySnapshot;
  readonly target_resolution_lock: PluginResolutionLock;
  readonly target_configuration: WorkspaceConfigurationRevision;
  readonly freshness_checkpoint: WorkspaceFreshnessCheckpoint;
  readonly publication_kind: GenerationChangeManifest["publication_kind"];
  /** Exact source-layer snapshot represented by this structural publication. */
  readonly source_snapshot_id?: string;
  readonly publication_stage_id?: string;
  readonly publication_stage_ordinal?: number;
  readonly publication_stage_count?: number;
  readonly template_sets: CandidateTemplateSets;
}

export interface CandidatePublicationResult {
  readonly candidate_generation_id: string;
  readonly snapshot_id: string;
  readonly generation_manifest_id: string;
  readonly generation: number;
  readonly published_at: string;
  readonly status: "published" | "already_published";
}

export interface CandidateDeltaInput extends Record<string, unknown> {
  readonly fact_delta_id: string;
  readonly candidate_generation_id: string;
  readonly workspace_id: string;
  readonly delta_digest: string;
}

export interface CandidateCleanupMarker {
  readonly candidate_generation_id: string;
  readonly resource_type: string;
  readonly resource_id: string;
  readonly state?: "pending" | "cleaned";
  readonly marked_at?: string;
}

export interface CandidateRoot {
  readonly root_id: string;
  readonly workspace_id: string;
  readonly candidate_generation_id: string;
  readonly resource_type: string;
  readonly content_digest: string;
  readonly state: string;
  readonly payload: unknown;
}

export type CandidateInsertResult = "inserted" | "already_present";

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new StorageError("storage:invalid_blob", "SQLite returned a non-binary payload.");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

// `CandidateMaterialization`'s template-set fields are now each a small, bounded
// `OrderedSetDescriptor` encoded as Text (descriptor-as-text -- see
// `packages/engine/src/candidate-materialization.ts`), not the template array itself, so
// the persisted materialization blob is small and the ordinary shared canonical-encoding
// defaults (`@urdira/canonical`'s `encodeCanonical`/`decodeCanonical`) apply to it like
// any other row payload.

function optionalText(value: string | undefined): SqliteValue { return value ?? null; }
function optionalNumber(value: number | undefined): SqliteValue { return value ?? null; }
function now(): string { return new Date().toISOString(); }
function canonicalSha256(value: unknown): string { return digestBytes(canonicalBytes(value)); }
function sqliteValue(value: unknown): SqliteValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return value;
  return encodeCanonical(value);
}

function assertWorkspace(expected: string, actual: string): void {
  if (expected !== actual) throw new StorageError("storage:workspace_mismatch", `Object workspace ${actual} does not match database workspace ${expected}.`);
}

function conflict(kind: string, id: string): never {
  throw new StorageError("storage:candidate_digest_conflict", `Immutable ${kind} ${id} was written with a different digest.`, { kind, id });
}

function sameFields(row: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => {
    const actual = row[key];
    if (value instanceof Uint8Array) return actual !== undefined && sameBytes(bytes(actual), value);
    return actual === value;
  });
}

const transitions: Readonly<Record<string, readonly string[]>> = {
  queued: ["planning", "failed", "stale"],
  planning: ["analyzing", "failed", "stale"],
  analyzing: ["validating", "failed", "stale"],
  validating: ["projecting", "ready", "failed", "stale"],
  projecting: ["ready", "failed", "stale"],
  ready: ["publishing", "failed", "stale"],
  publishing: ["published", "failed", "stale"],
  published: ["cleaning", "cleaned"],
  cleaning: ["cleaned", "failed"],
  cleaned: [],
  failed: ["cleaning", "cleaned"],
  stale: ["cleaning", "cleaned"],
};

type CandidateRow = {
  readonly candidate_generation_id: string;
  readonly workspace_id: string;
  readonly state: string;
  readonly candidate_payload: unknown;
};

// `insert`'s conflict guard exists to catch a genuine identity collision (the
// same content-derived `candidate_generation_id` proposed with DIFFERENT
// content -- a real bug, or a hash collision). But a LATER scan recomputing
// the exact SAME `candidate_generation_id` -- workspace id + resolution lock
// + observation-batch id, and the batch id is content-derived, so this
// happens whenever disk is unchanged since a prior attempt, independent of
// wall-clock time -- is not always that: it is also exactly what a
// crash-recovery retry looks like. A REAL incident hit this after a scan's
// `publishCandidate` call was killed by SIGKILL mid-flight: stage-1
// cataloging (a separate, already-durable commit -- see
// `currentOccurrencesSlimAsOf`'s doc comment, `packages/storage/src/source-index.ts`)
// had already landed, but the kill hit the process directly, so NONE of
// `CandidateIndexer.run`'s own cleanup ever ran either -- no catch-driven
// `"...", "failed"` transition, nothing -- leaving the row parked in
// whatever NON-terminal state it was in when the process died (`"publishing"`
// in the live case: `ready_at` set, `finished_at` NULL, no `failure_code`).
// The next scan against unchanged disk recomputed the identical candidate id
// and got permanently `storage:candidate_digest_conflict`ed against its own
// abandoned predecessor -- a state-based check (e.g. "only `failed`/`stale`
// are reclaimable") does NOT cover this: a real crash never reaches any
// state-machine transition at all, so the row can be stuck at literally any
// state.
//
// The one reliable, ALREADY-authoritative signal for "did this candidate
// identity ever actually finish publishing" is `candidate_publication_journal`
// (`isPublished`, below): `buildCandidatePublicationPlan`
// (`publication-authority.ts`) writes a journal row in the SAME atomic
// transaction that flips `candidate_state.state` to `"published"` -- so a
// journal row exists if and only if this candidate id genuinely, durably
// published, regardless of what `candidate_state.state` currently says. When
// no journal row exists, this candidate identity never finished; when one
// DOES exist, this is a genuinely immutable, already-published candidate (or
// a "torn" success whose own `candidate_state.state` update did not land,
// which is `CandidateIndexer.recover()`'s job to finalize, not `insert`'s to
// paper over) -- never reclaimable.
async function isPublished(database: SqliteDatabase, workspaceId: string, candidateId: string): Promise<boolean> {
  const row = await database.get<{ candidate_generation_id: string }>("SELECT candidate_generation_id FROM candidate_publication_journal WHERE workspace_id = ? AND candidate_generation_id = ?", [workspaceId, candidateId]);
  return row !== undefined;
}

// `IndexCandidate` fields `CandidateIndexer`'s state machine (`transition`,
// above) legitimately progresses over ONE run's lifetime -- and that a fresh
// `insert()` call, by construction, always submits unset (`state` is always
// `"queued"`; the rest are simply absent on a just-built candidate, see
// `runFullWorkspaceScan`, `packages/engine/src/workspace-indexing-session.ts`).
// A crash-recovery retry's freshly rebuilt candidate can therefore never
// byte-match a PRIOR attempt's stored payload once that attempt progressed
// past `"queued"` (its `ready_at`/`candidate_materialization_id`/etc. are
// populated; the retry's aren't) -- exactly the fields this set names.
// `created_at` is the one core-identity-looking field ALSO excluded here: it
// is stamped from `now()` (real wall-clock in production; `runFullWorkspaceScan`'s
// own frozen-clock `now` option only matters in tests), so two genuinely
// identical retries of the same content minted at different real times will
// disagree on it even though nothing else about the candidate changed.
//
// Everything else -- `base_snapshot_id`/`base_generation`/`base_registry_snapshot_id`/
// `base_configuration_revision_id`/`target_registry_snapshot_id`/
// `target_configuration_revision_id`/`trigger_kind`/`source_observation_batch_ids`,
// plus `frozen_base` in its entirety -- is this candidate's actual IMMUTABLE
// identity: for the SAME `candidate_generation_id` (itself derived from
// workspace id + resolution lock + a content-derived observation-batch id),
// these must always agree for a genuine crash-recovery retry, and disagreeing
// on any of them is exactly the real tamper/collision `insert`'s conflict
// guard exists to catch (see `tests/phase9-publication.test.ts`'s "requires
// an owned ready candidate and never overwrites its immutable payload").
const CANDIDATE_PROGRESSIVE_FIELDS = new Set<keyof IndexCandidate>([
  "state", "created_at", "work_manifest_id", "retention_lease_id", "candidate_materialization_id", "candidate_digest",
  "analysis_started_at", "ready_at", "finished_at", "published_snapshot_id", "published_generation", "generation_manifest_id",
  "stale_against_snapshot_id", "failure_code", "issue_ids",
]);

function candidateIdentityCore(candidate: IndexCandidate): Record<string, unknown> {
  const core: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate)) if (!CANDIDATE_PROGRESSIVE_FIELDS.has(key as keyof IndexCandidate)) core[key] = value;
  return core;
}

/**
 * `true` when `existing` and `incoming` are the SAME candidate attempt at
 * different points in its lifecycle (a legitimate crash-recovery retry
 * reclaim target), not a genuinely different candidate that happens to
 * collide on `candidate_generation_id`. Compares `frozen_base` in full
 * (always fully immutable, never touched by `transition`) and `candidate`
 * with every progressive/volatile field (`CANDIDATE_PROGRESSIVE_FIELDS`)
 * stripped from both sides first.
 */
function sameCandidateIdentity(existing: { readonly candidate: IndexCandidate; readonly frozen_base: FrozenCandidateBaseTuple }, incoming: { readonly candidate: IndexCandidate; readonly frozen_base: FrozenCandidateBaseTuple }): boolean {
  return digestBytes(canonicalBytes({ candidate: candidateIdentityCore(existing.candidate), frozen_base: existing.frozen_base }))
    === digestBytes(canonicalBytes({ candidate: candidateIdentityCore(incoming.candidate), frozen_base: incoming.frozen_base }));
}

export class WorkspaceCandidateRepository {
  constructor(private readonly database: SqliteDatabase, private readonly workspaceId: string, private readonly blobs?: BlobStore) {}

  async insert(candidate: IndexCandidate, frozenBase: FrozenCandidateBaseTuple): Promise<CandidateInsertResult> {
    assertWorkspace(this.workspaceId, candidate.workspace_id);
    const payload = encodeCanonical({ candidate, frozen_base: frozenBase });
    const existing = await this.database.get<CandidateRow>("SELECT candidate_generation_id, workspace_id, state, candidate_payload FROM candidate_state WHERE candidate_generation_id = ?", [candidate.candidate_generation_id]);
    const values: readonly SqliteValue[] = [candidate.workspace_id, optionalText(candidate.base_snapshot_id), optionalNumber(candidate.base_generation), optionalText(candidate.base_registry_snapshot_id), candidate.target_registry_snapshot_id, optionalText(candidate.base_configuration_revision_id), candidate.target_configuration_revision_id, candidate.trigger_kind, candidate.state, optionalText(candidate.work_manifest_id), JSON.stringify(candidate.source_observation_batch_ids), optionalText(candidate.retention_lease_id), optionalText(candidate.candidate_materialization_id), optionalText(candidate.candidate_digest), candidate.created_at, optionalText(candidate.analysis_started_at), optionalText(candidate.ready_at), optionalText(candidate.finished_at), optionalText(candidate.published_snapshot_id), optionalNumber(candidate.published_generation), optionalText(candidate.generation_manifest_id), optionalText(candidate.stale_against_snapshot_id), optionalText(candidate.failure_code), JSON.stringify(candidate.issue_ids), payload];
    if (existing) {
      if (existing.workspace_id === this.workspaceId && sameBytes(bytes(existing.candidate_payload), payload)) return "already_present";
      const decodedExisting = existing.workspace_id === this.workspaceId
        ? decodeCanonical(bytes(existing.candidate_payload)) as { candidate: IndexCandidate; frozen_base: FrozenCandidateBaseTuple }
        : undefined;
      if (existing.workspace_id !== this.workspaceId
        || decodedExisting === undefined || !sameCandidateIdentity(decodedExisting, { candidate, frozen_base: frozenBase })
        || await isPublished(this.database, this.workspaceId, candidate.candidate_generation_id)) conflict("candidate", candidate.candidate_generation_id);
      const updated = await this.database.run(
        `UPDATE candidate_state SET workspace_id = ?, base_snapshot_id = ?, base_generation = ?, base_registry_snapshot_id = ?,
          target_registry_snapshot_id = ?, base_configuration_revision_id = ?, target_configuration_revision_id = ?, trigger_kind = ?, state = ?,
          work_manifest_id = ?, source_observation_batch_ids = ?, retention_lease_id = ?, candidate_materialization_id = ?, candidate_digest = ?,
          created_at = ?, analysis_started_at = ?, ready_at = ?, finished_at = ?, published_snapshot_id = ?, published_generation = ?, generation_manifest_id = ?,
          stale_against_snapshot_id = ?, failure_code = ?, issue_ids = ?, candidate_payload = ?
         WHERE candidate_generation_id = ? AND state = ?`,
        [...values, candidate.candidate_generation_id, existing.state],
      );
      if (updated.changes !== 1) conflict("candidate", candidate.candidate_generation_id);
      return "inserted";
    }
    await this.database.run(
      `INSERT INTO candidate_state (candidate_generation_id, workspace_id, base_snapshot_id, base_generation, base_registry_snapshot_id,
        target_registry_snapshot_id, base_configuration_revision_id, target_configuration_revision_id, trigger_kind, state,
        work_manifest_id, source_observation_batch_ids, retention_lease_id, candidate_materialization_id, candidate_digest,
        created_at, analysis_started_at, ready_at, finished_at, published_snapshot_id, published_generation, generation_manifest_id,
        stale_against_snapshot_id, failure_code, issue_ids, candidate_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [candidate.candidate_generation_id, ...values],
    );
    return "inserted";
  }

  async get(candidateId: string): Promise<IndexCandidate | undefined> {
    const row = await this.database.get<CandidateRow>("SELECT candidate_generation_id, workspace_id, state, candidate_payload FROM candidate_state WHERE workspace_id = ? AND candidate_generation_id = ?", [this.workspaceId, candidateId]);
    if (!row) return undefined;
    const decoded = decodeCanonical(bytes(row.candidate_payload)) as { candidate: IndexCandidate; frozen_base: FrozenCandidateBaseTuple };
    return { ...decoded.candidate, state: row.state };
  }

  async getFrozenBase(candidateId: string): Promise<FrozenCandidateBaseTuple | undefined> {
    const row = await this.database.get<{ candidate_payload: unknown }>("SELECT candidate_payload FROM candidate_state WHERE workspace_id = ? AND candidate_generation_id = ?", [this.workspaceId, candidateId]);
    if (!row) return undefined;
    return (decodeCanonical(bytes(row.candidate_payload)) as { frozen_base: FrozenCandidateBaseTuple }).frozen_base;
  }

  async transition(candidateId: string, expected: IndexCandidate["state"], next: IndexCandidate["state"], patch: Readonly<Record<string, unknown>> = {}): Promise<void> {
    const row = await this.database.get<CandidateRow>("SELECT candidate_generation_id, workspace_id, state, candidate_payload FROM candidate_state WHERE workspace_id = ? AND candidate_generation_id = ?", [this.workspaceId, candidateId]);
    if (!row) throw new StorageError("storage:candidate_not_found", `Candidate ${candidateId} does not exist.`);
    if (row.state !== expected) throw new StorageError("storage:candidate_state_conflict", `Candidate ${candidateId} is ${row.state}, not ${expected}.`);
    if (!(transitions[expected] ?? []).includes(next)) throw new StorageError("storage:invalid_candidate_transition", `Candidate transition ${expected} -> ${next} is not allowed.`);
    const decoded = decodeCanonical(bytes(row.candidate_payload)) as { candidate: IndexCandidate; frozen_base: FrozenCandidateBaseTuple };
    const candidate = { ...decoded.candidate, ...patch, state: next } as IndexCandidate;
    const updates: Array<[string, SqliteValue]> = [["state", next], ["candidate_payload", encodeCanonical({ candidate, frozen_base: decoded.frozen_base })]];
    const columns = new Set(["work_manifest_id", "retention_lease_id", "candidate_materialization_id", "candidate_digest", "analysis_started_at", "ready_at", "finished_at", "published_snapshot_id", "published_generation", "generation_manifest_id", "stale_against_snapshot_id", "failure_code", "issue_ids"]);
    for (const [key, value] of Object.entries(patch)) {
      if (!columns.has(key)) continue;
      updates.push([key, value === undefined ? null : typeof value === "number" || typeof value === "string" ? value : JSON.stringify(value)]);
    }
    const setSql = updates.map(([key]) => `${key} = ?`).join(", ");
    await this.database.run(`UPDATE candidate_state SET ${setSql} WHERE workspace_id = ? AND candidate_generation_id = ? AND state = ?`, [...updates.map(([, value]) => value), this.workspaceId, candidateId, expected]);
    if ((await this.database.get<{ state: string }>("SELECT state FROM candidate_state WHERE workspace_id = ? AND candidate_generation_id = ?", [this.workspaceId, candidateId]))?.state !== next) throw new StorageError("storage:candidate_state_conflict", `Candidate ${candidateId} changed while transitioning.`);
  }

  async selectManifest(candidateId: string, manifest: CandidateWorkManifest): Promise<CandidateInsertResult> {
    assertWorkspace(this.workspaceId, manifest.workspace_id);
    await this.requireCandidate(candidateId, manifest.candidate_generation_id);
    const payload = encodeCanonical(manifest);
    const existing = await this.database.get<{ work_digest: string; work_manifest_payload: unknown }>("SELECT work_digest, work_manifest_payload FROM candidate_work_manifests WHERE workspace_id = ? AND work_manifest_id = ?", [this.workspaceId, manifest.work_manifest_id]);
    if (existing) {
      // `work_digest` (`stableId("workspace-scan-work-digest", ...)`,
      // `packages/engine/src/workspace-indexing-session.ts`) is already the
      // authoritative, purely content-derived identity for this manifest --
      // unlike `manifest.created_at` (real wall-clock, embedded INSIDE the
      // compared `payload` unlike every sibling method's own `now()` column,
      // which stays OUTSIDE its encoded payload), which legitimately differs
      // between a crashed attempt and its retry even when the manifest's
      // actual content (`work_manifest_id`, `artifact_work_set`,
      // `projection_work_set`, targets) is byte-identical. Trusting
      // `work_digest` alone (dropping the extra full-payload byte compare)
      // is the same "reclaim a legitimate retry, still catch a real content
      // mismatch" fix as `insert`'s `sameCandidateIdentity`, above -- a real
      // incident hit this exact conflict live, immediately after `insert`'s
      // own fix unblocked the candidate row itself.
      if (existing.work_digest !== manifest.work_digest) conflict("work manifest", manifest.work_manifest_id);
      return "already_present";
    }
    await this.database.run("INSERT INTO candidate_work_manifests (work_manifest_id, workspace_id, candidate_generation_id, supersedes_work_manifest_id, base_snapshot_id, invalidation_plan_id, target_registry_snapshot_id, target_configuration_revision_id, work_digest, work_manifest_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [manifest.work_manifest_id, manifest.workspace_id, manifest.candidate_generation_id, optionalText(manifest.supersedes_work_manifest_id), optionalText(manifest.base_snapshot_id), manifest.invalidation_plan_id, manifest.target_registry_snapshot_id, manifest.target_configuration_revision_id, manifest.work_digest, payload]);
    await this.database.run("UPDATE candidate_state SET work_manifest_id = ? WHERE workspace_id = ? AND candidate_generation_id = ?", [manifest.work_manifest_id, this.workspaceId, candidateId]);
    return "inserted";
  }

  async acceptDelta(delta: CandidateDeltaInput): Promise<{ status: "inserted" | "already_accepted" }> {
    assertWorkspace(this.workspaceId, delta.workspace_id);
    await this.requireCandidate(delta.candidate_generation_id);
    const payload = encodeCanonical(delta);
    const existing = await this.database.get<{ delta_digest: string; delta_payload: unknown }>("SELECT delta_digest, delta_payload FROM candidate_fact_deltas WHERE workspace_id = ? AND candidate_generation_id = ? AND fact_delta_id = ?", [this.workspaceId, delta.candidate_generation_id, delta.fact_delta_id]);
    if (existing) {
      if (existing.delta_digest !== delta.delta_digest || !sameBytes(bytes(existing.delta_payload), payload)) conflict("fact delta", delta.fact_delta_id);
      return { status: "already_accepted" };
    }
    await this.database.run("INSERT INTO candidate_fact_deltas (fact_delta_id, workspace_id, candidate_generation_id, delta_digest, accepted_at, delta_payload) VALUES (?, ?, ?, ?, ?, ?)", [delta.fact_delta_id, delta.workspace_id, delta.candidate_generation_id, delta.delta_digest, now(), payload]);
    return { status: "inserted" };
  }

  async saveMaterialization(candidateId: string, materialization: CandidateMaterialization, templateSets: CandidateTemplateSets = { source_transitions: [], record_opens: [], record_closures: [], identity_assignments: [], artifact_dependencies: [], lookup_dependencies: [], lookup_revalidations: [] }): Promise<CandidateInsertResult> {
    assertWorkspace(this.workspaceId, materialization.workspace_id);
    await this.requireCandidate(candidateId);
    const payload = encodeCanonical(materialization);
    const existing = await this.database.get<{ materialization_digest: string; materialization_payload: unknown }>("SELECT materialization_digest, materialization_payload FROM candidate_materializations WHERE workspace_id = ? AND candidate_materialization_id = ?", [this.workspaceId, materialization.candidate_materialization_id]);
    if (existing) {
      if (existing.materialization_digest !== materialization.materialization_digest || !sameBytes(bytes(existing.materialization_payload), payload)) conflict("materialization", materialization.candidate_materialization_id);
    } else {
      await this.database.run("INSERT INTO candidate_materializations (candidate_materialization_id, workspace_id, candidate_generation_id, materialization_digest, sealed_at, materialization_payload) VALUES (?, ?, ?, ?, ?, ?)", [materialization.candidate_materialization_id, materialization.workspace_id, candidateId, materialization.materialization_digest, now(), payload]);
      await this.database.run("UPDATE candidate_state SET candidate_materialization_id = ? WHERE workspace_id = ? AND candidate_generation_id = ?", [materialization.candidate_materialization_id, this.workspaceId, candidateId]);
    }
    if (timingEnabled()) resetTimings();
    const anySegmentInserted = await this.persistTemplateSegments(materialization.candidate_materialization_id, templateSets);
    if (timingEnabled()) console.error(`[urdira] storage timings save_materialization workspace:${this.workspaceId} ms=${JSON.stringify(snapshotTimings())}`);
    return existing ? (anySegmentInserted ? "inserted" : "already_present") : "inserted";
  }

  /**
   * Chunks `entries` into segments bounded by BOTH an entry cap and a byte
   * target, yielding each as a pure-CPU {@link PendingTemplateSegment}
   * (encode/chunk/digest only -- no I/O). Byte-aware chunking matters
   * because template entries embed record bodies: a fixed entry count could
   * produce a segment exceeding the default canonical `max_bytes` decode
   * limit. Each segment payload is assembled from per-entry encodings
   * (`encodeArrayHeader` + concatenated element bytes is exactly the
   * canonical array encoding), so no whole-chunk encode occurs. A generator
   * (rather than building the whole set kind's segment array up front) so
   * `persistTemplateSegments` can bound how many segments' payload bytes it
   * holds in memory at once across the whole materialization, not just
   * within one set kind.
   */
  private *streamTemplateSetSegments(setKind: CandidateTemplateSetKind, entries: readonly unknown[]): Generator<PendingTemplateSegment> {
    let segmentOrdinal = 0;
    let firstOrdinal = 0;
    let chunkParts: Uint8Array[] = [];
    let chunkBytes = 0;
    const buildSegment = (): PendingTemplateSegment => {
      const header = encodeArrayHeader(chunkParts.length);
      const payload = new Uint8Array(header.length + chunkBytes);
      payload.set(header, 0);
      let offset = header.length;
      for (const part of chunkParts) { payload.set(part, offset); offset += part.length; }
      const contentDigest = timedSync("segment_digest", () => digestBytes(payload));
      const lastOrdinal = firstOrdinal + chunkParts.length - 1;
      const segment: PendingTemplateSegment = { setKind, segmentOrdinal, firstOrdinal, lastOrdinal, entryCount: chunkParts.length, payload, contentDigest };
      firstOrdinal += chunkParts.length;
      segmentOrdinal += 1;
      chunkParts = [];
      chunkBytes = 0;
      return segment;
    };
    for (const entry of entries) {
      const encoded = timedSync("segment_encode", () => encodeCanonical(entry));
      if (chunkParts.length > 0 && (chunkParts.length >= TEMPLATE_SEGMENT_MAX_ENTRIES || chunkBytes + encoded.length > TEMPLATE_SEGMENT_TARGET_BYTES)) yield buildSegment();
      chunkParts.push(encoded);
      chunkBytes += encoded.length;
    }
    if (chunkParts.length > 0) yield buildSegment();
  }

  /** `streamTemplateSetSegments` across every set kind, in `CANDIDATE_TEMPLATE_SET_KINDS`'s stable order. */
  private *streamAllTemplateSetSegments(templateSets: CandidateTemplateSets): Generator<PendingTemplateSegment> {
    for (const setKind of CANDIDATE_TEMPLATE_SET_KINDS) yield* this.streamTemplateSetSegments(setKind, templateSets[setKind]);
  }

  /**
   * Persists every set kind's template segments for one materialization.
   * Replaces the former per-segment `await cas.put(...)` loop (755 SERIAL
   * file-fsync + dir-fsync round trips, measured on a 981-file workspace)
   * with `BlobStore.cas.putMany` over bounded batches
   * (`TEMPLATE_SEGMENT_CAS_BATCH_SIZE`), which runs each batch's blobs'
   * write/fsync work concurrently and coalesces directory fsyncs per batch
   * instead of per blob. Existence/conflict checking is still done up front
   * (`SELECT ... WHERE workspace_id = ? AND candidate_materialization_id =
   * ?`, unfiltered by set_kind/segment_ordinal): one round trip returning
   * every row already persisted for this materialization -- cheap (no blob
   * bytes, just the small digest/ordinal columns) regardless of how many of
   * this call's own segments turn out to already exist, and equivalent to
   * the old per-segment `SELECT ... AND set_kind = ? AND segment_ordinal =
   * ?` lookups because each row is independently keyed by
   * `(workspace_id, candidate_materialization_id, set_kind, segment_ordinal)`
   * and nothing here writes a row this materialization's own segment stream
   * won't also independently re-derive on any retry.
   */
  private async persistTemplateSegments(candidateMaterializationId: string, templateSets: CandidateTemplateSets): Promise<boolean> {
    if (CANDIDATE_TEMPLATE_SET_KINDS.every((setKind) => templateSets[setKind].length === 0)) return false;
    if (!this.blobs) throw new StorageError("storage:template_segment_storage_unavailable", "Candidate template segments require a content-addressed blob store.");
    const existingRows = await timed("segment_sql", () => this.database.all<{ set_kind: string; segment_ordinal: number; content_digest: string }>("SELECT set_kind, segment_ordinal, content_digest FROM candidate_template_segments WHERE workspace_id = ? AND candidate_materialization_id = ?", [this.workspaceId, candidateMaterializationId]));
    const existingByKey = new Map(existingRows.map((row) => [`${row.set_kind} ${row.segment_ordinal}`, row.content_digest]));
    let inserted = false;
    let batch: PendingTemplateSegment[] = [];
    const flushBatch = async (): Promise<void> => {
      if (batch.length === 0) return;
      const blobs = await timed("segment_cas_put", () => this.blobs!.cas.putMany(batch.map((segment) => ({ bytes: segment.payload, options: { media_type: "application/urdira-template-segment" } }))));
      for (let index = 0; index < batch.length; index += 1) {
        const segment = batch[index]!;
        const blob = blobs[index]!;
        await timed("segment_sql", () => this.database.run("INSERT INTO candidate_template_segments (workspace_id, candidate_materialization_id, set_kind, segment_ordinal, entry_count, first_ordinal, last_ordinal, content_digest, storage_reference, byte_length) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [this.workspaceId, candidateMaterializationId, segment.setKind, segment.segmentOrdinal, segment.entryCount, segment.firstOrdinal, segment.lastOrdinal, segment.contentDigest, blob.storage_reference, segment.payload.byteLength]));
        inserted = true;
      }
      batch = [];
    };
    for (const segment of this.streamAllTemplateSetSegments(templateSets)) {
      const key = `${segment.setKind} ${segment.segmentOrdinal}`;
      const existingDigest = existingByKey.get(key);
      if (existingDigest !== undefined) {
        if (existingDigest !== segment.contentDigest) conflict("template segment", `${candidateMaterializationId}/${segment.setKind}/${segment.segmentOrdinal}`);
        continue;
      }
      batch.push(segment);
      if (batch.length >= TEMPLATE_SEGMENT_CAS_BATCH_SIZE) await flushBatch();
    }
    await flushBatch();
    return inserted;
  }

  /** Loads a template set's segments in ordinal order, CAS-verifying and concatenating their entries. */
  async readTemplateSet(candidateMaterializationId: string, setKind: string): Promise<readonly unknown[]> {
    if (!this.blobs) throw new StorageError("storage:template_segment_storage_unavailable", "Candidate template segments require a content-addressed blob store.");
    const segments = await this.database.all<{ content_digest: string }>("SELECT content_digest FROM candidate_template_segments WHERE workspace_id = ? AND candidate_materialization_id = ? AND set_kind = ? ORDER BY segment_ordinal", [this.workspaceId, candidateMaterializationId, setKind]);
    const entries: unknown[] = [];
    for (const segment of segments) {
      const payload = await this.blobs.cas.read(segment.content_digest);
      if (digestBytes(payload) !== segment.content_digest) throw new StorageError("storage:template_segment_corrupt", `Template segment ${candidateMaterializationId}/${setKind} failed digest verification.`);
      const decoded = decodeCanonical(payload);
      if (!Array.isArray(decoded)) throw new StorageError("storage:template_segment_corrupt", `Template segment ${candidateMaterializationId}/${setKind} did not decode to an array.`);
      entries.push(...decoded);
    }
    return entries;
  }

  async appendIssue(issue: CandidateIssue): Promise<CandidateInsertResult> {
    assertWorkspace(this.workspaceId, (issue.scope as unknown as { workspace_id?: string }).workspace_id ?? this.workspaceId);
    await this.requireCandidate(issue.candidate_generation_id);
    const payload = encodeCanonical(issue.payload);
    const scopePayload = encodeCanonical(issue.scope);
    const existing = await this.database.get<Record<string, unknown>>("SELECT issue_code, phase, severity, retryability, scope_payload, summary, detail, cause_references, payload, created_at FROM candidate_issues WHERE workspace_id = ? AND candidate_generation_id = ? AND candidate_issue_id = ?", [this.workspaceId, issue.candidate_generation_id, issue.candidate_issue_id]);
    if (existing) {
      if (!sameFields(existing, { issue_code: issue.issue_code, phase: issue.phase, severity: issue.severity, retryability: issue.retryability, scope_payload: scopePayload, summary: issue.summary, detail: issue.detail, cause_references: issue.cause_references, payload, created_at: issue.created_at })) conflict("issue", issue.candidate_issue_id);
      return "already_present";
    }
    await this.database.run("INSERT INTO candidate_issues (candidate_issue_id, workspace_id, candidate_generation_id, issue_code, phase, severity, retryability, scope_payload, summary, detail, cause_references, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [issue.candidate_issue_id, this.workspaceId, issue.candidate_generation_id, issue.issue_code, issue.phase, issue.severity, issue.retryability, scopePayload, issue.summary, issue.detail, issue.cause_references, payload, issue.created_at]);
    return "inserted";
  }

  async putLookupDependency(value: Record<string, unknown>): Promise<CandidateInsertResult> {
    const workspaceId = String(value["workspace_id"]);
    assertWorkspace(this.workspaceId, workspaceId);
    const id = String(value["lookup_dependency_id"]);
    const payload = encodeCanonical(value);
    const dependencyDigest = typeof value["dependency_digest"] === "string" ? value["dependency_digest"] : canonicalSha256(value);
    const candidateId = String(value["candidate_generation_id"]);
    await this.requireCandidate(candidateId);
    const existing = await this.database.get<{ dependency_digest: string; dependency_payload: unknown }>("SELECT dependency_digest, dependency_payload FROM candidate_lookup_dependencies WHERE workspace_id = ? AND candidate_generation_id = ? AND lookup_dependency_id = ?", [this.workspaceId, candidateId, id]);
    if (existing) {
      if (existing.dependency_digest !== dependencyDigest || !sameBytes(bytes(existing.dependency_payload), payload)) conflict("lookup dependency", id);
      return "already_present";
    }
    await this.database.run("INSERT INTO candidate_lookup_dependencies (lookup_dependency_id, workspace_id, candidate_generation_id, consumer_type, consumer_id, owner_artifact_id, owner_artifact_version_id, operation, normalized_selector_or_address, selector_digest, previous_result_set_digest, invalidation_scope, valid_from_generation, valid_to_generation, dependency_digest, dependency_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, workspaceId, candidateId, String(value["consumer_type"]), String(value["consumer_id"]), sqliteValue(value["owner_artifact_id"] ?? null), sqliteValue(value["owner_artifact_version_id"] ?? null), String(value["operation"]), String(value["normalized_selector_or_address"]), String(value["selector_digest"]), String(value["previous_result_set_digest"]), String(value["invalidation_scope"]), sqliteValue(value["valid_from_generation"] ?? null), sqliteValue(value["valid_to_generation"] ?? null), dependencyDigest, payload]);
    return "inserted";
  }

  async acquireLease(candidateId: string, baseSnapshotId: string | undefined, acquiredAt = now()): Promise<CandidateInsertResult> {
    await this.requireCandidate(candidateId);
    const id = `lease:${candidateId}`;
    const payload = encodeCanonical({ retention_lease_id: id, candidate_generation_id: candidateId, ...(baseSnapshotId === undefined ? {} : { base_snapshot_id: baseSnapshotId }), acquired_at: acquiredAt });
    const existing = await this.database.get<{ state: string; lease_payload: unknown }>("SELECT state, lease_payload FROM candidate_retention_leases WHERE workspace_id = ? AND candidate_generation_id = ?", [this.workspaceId, candidateId]);
    if (existing) {
      if (existing.state === "active" && sameBytes(bytes(existing.lease_payload), payload)) return "already_present";
      // `CandidateIndexer.run` (`packages/engine/src/candidate-indexer.ts`)
      // always calls `candidates.insert` BEFORE `acquireBaseLease`, and
      // `insert`'s own reclaim above already conflicts outright for any
      // candidate id that durably published (`isPublished`) -- so by the
      // time `acquireLease` is reached at all, this candidate id is
      // guaranteed NOT to have published, and this codebase's concurrency
      // model (one daemon process per data root via `ProcessLock`, one
      // in-flight scan per workspace via `scanInFlight`) means no OTHER
      // process can be genuinely, concurrently holding this SAME lease
      // right now either. An `active` row with a mismatched payload here can
      // therefore only be a crashed prior attempt's lease, left `active`
      // because the crash (a real SIGKILL) hit before `releaseBaseLease`
      // ever got to run -- exactly as abandoned as a `released` one. This
      // row's own `acquired_at`/`released_at` always carry the PRIOR
      // attempt's real wall-clock timestamps (`now()`, this file's
      // module-local always-real-time helper -- unlike
      // `runFullWorkspaceScan`'s own frozen-clock `now` option, never
      // threaded down into lease bookkeeping), so a legitimate crash-recovery
      // retry's freshly computed `payload` can never byte-match a stored one
      // even when every OTHER field (candidate id, base snapshot) agrees.
      // Conflicting here would re-wedge exactly the same crash-recovery retry
      // `insert`'s own reclaim (above) exists to unblock. Reclaim it:
      // reactivate the row for this fresh attempt instead of erroring.
      const reactivated = await this.database.run(
        "UPDATE candidate_retention_leases SET base_snapshot_id = ?, state = 'active', acquired_at = ?, released_at = NULL, lease_payload = ? WHERE workspace_id = ? AND candidate_generation_id = ? AND state = ?",
        [baseSnapshotId ?? null, acquiredAt, payload, this.workspaceId, candidateId, existing.state],
      );
      if (reactivated.changes !== 1) conflict("retention lease", id);
      await this.database.run("UPDATE candidate_state SET retention_lease_id = ? WHERE workspace_id = ? AND candidate_generation_id = ?", [id, this.workspaceId, candidateId]);
      return "inserted";
    }
    await this.database.run("INSERT INTO candidate_retention_leases (retention_lease_id, workspace_id, candidate_generation_id, base_snapshot_id, state, acquired_at, released_at, lease_payload) VALUES (?, ?, ?, ?, 'active', ?, NULL, ?)", [id, this.workspaceId, candidateId, baseSnapshotId ?? null, acquiredAt, payload]);
    await this.database.run("UPDATE candidate_state SET retention_lease_id = ? WHERE workspace_id = ? AND candidate_generation_id = ?", [id, this.workspaceId, candidateId]);
    return "inserted";
  }

  async renewLease(candidateId: string, renewedAt = now()): Promise<void> {
    await this.requireCandidate(candidateId);
    const existing = await this.database.get<{ lease_payload: unknown }>("SELECT lease_payload FROM candidate_retention_leases WHERE workspace_id = ? AND candidate_generation_id = ? AND state = 'active'", [this.workspaceId, candidateId]);
    if (!existing) throw new StorageError("storage:candidate_lease_not_found", `No active retention lease exists for candidate ${candidateId}.`);
    const decoded = decodeCanonical(bytes(existing.lease_payload)) as Record<string, unknown>;
    const payload = encodeCanonical({ ...decoded, acquired_at: renewedAt });
    await this.database.run("UPDATE candidate_retention_leases SET acquired_at = ?, lease_payload = ? WHERE workspace_id = ? AND candidate_generation_id = ? AND state = 'active'", [renewedAt, payload, this.workspaceId, candidateId]);
  }

  async releaseLease(candidateId: string, releasedAt = now()): Promise<"released" | "already_released"> {
    await this.requireCandidate(candidateId);
    const existing = await this.database.get<{ lease_payload: unknown }>("SELECT lease_payload FROM candidate_retention_leases WHERE workspace_id = ? AND candidate_generation_id = ? AND state = 'active'", [this.workspaceId, candidateId]);
    if (!existing) return "already_released";
    const decoded = decodeCanonical(bytes(existing.lease_payload)) as Record<string, unknown>;
    const payload = encodeCanonical({ ...decoded, released_at: releasedAt });
    await this.database.run("UPDATE candidate_retention_leases SET state = 'released', released_at = ?, lease_payload = ? WHERE workspace_id = ? AND candidate_generation_id = ? AND state = 'active'", [releasedAt, payload, this.workspaceId, candidateId]);
    return "released";
  }

  async markCleanup(marker: CandidateCleanupMarker): Promise<"marked" | "already_marked"> {
    await this.requireCandidate(marker.candidate_generation_id);
    const markedAt = marker.marked_at ?? now();
    const state = marker.state ?? "pending";
    const payload = encodeCanonical({ ...marker, state, marked_at: markedAt });
    const existing = await this.database.get<{ state: string; marker_payload: unknown }>("SELECT state, marker_payload FROM candidate_cleanup_markers WHERE candidate_generation_id = ? AND resource_type = ? AND resource_id = ?", [marker.candidate_generation_id, marker.resource_type, marker.resource_id]);
    if (existing) {
      if (state === "cleaned" && existing.state !== "cleaned") {
        await this.database.run("UPDATE candidate_cleanup_markers SET state = 'cleaned', marked_at = ?, marker_payload = ? WHERE candidate_generation_id = ? AND resource_type = ? AND resource_id = ?", [markedAt, payload, marker.candidate_generation_id, marker.resource_type, marker.resource_id]);
        return "marked";
      }
      return "already_marked";
    }
    await this.database.run("INSERT INTO candidate_cleanup_markers (candidate_generation_id, resource_type, resource_id, state, marked_at, marker_payload) VALUES (?, ?, ?, ?, ?, ?)", [marker.candidate_generation_id, marker.resource_type, marker.resource_id, state, markedAt, payload]);
    return "marked";
  }

  async listRecoverable(): Promise<readonly IndexCandidate[]> {
    const rows = await this.database.all<CandidateRow>("SELECT candidate_generation_id, workspace_id, state, candidate_payload FROM candidate_state WHERE workspace_id = ? AND state IN ('queued', 'planning', 'analyzing', 'validating', 'projecting', 'ready', 'publishing') ORDER BY created_at, candidate_generation_id", [this.workspaceId]);
    return rows.map((row) => ({ ...(decodeCanonical(bytes(row.candidate_payload)) as { candidate: IndexCandidate }).candidate, state: row.state }));
  }

  async putRoot(root: CandidateRoot): Promise<CandidateInsertResult> {
    assertWorkspace(this.workspaceId, root.workspace_id);
    await this.requireCandidate(root.candidate_generation_id);
    const payload = encodeCanonical(root.payload);
    const existing = await this.database.get<Record<string, unknown>>("SELECT workspace_id, candidate_generation_id, resource_type, content_digest, state, root_payload FROM candidate_roots WHERE workspace_id = ? AND root_id = ?", [this.workspaceId, root.root_id]);
    if (existing) {
      if (!sameFields(existing, { workspace_id: this.workspaceId, candidate_generation_id: root.candidate_generation_id, resource_type: root.resource_type, content_digest: root.content_digest, state: root.state, root_payload: payload })) conflict("candidate root", root.root_id);
      return "already_present";
    }
    await this.database.run("INSERT INTO candidate_roots (root_id, workspace_id, candidate_generation_id, resource_type, content_digest, state, root_payload) VALUES (?, ?, ?, ?, ?, ?, ?)", [root.root_id, this.workspaceId, root.candidate_generation_id, root.resource_type, root.content_digest, root.state, payload]);
    return "inserted";
  }

  async getManifest(manifestId: string): Promise<CandidateWorkManifest | undefined> {
    const row = await this.database.get<{ work_manifest_payload: unknown }>("SELECT work_manifest_payload FROM candidate_work_manifests WHERE workspace_id = ? AND work_manifest_id = ?", [this.workspaceId, manifestId]);
    return row ? decodeCanonical(bytes(row.work_manifest_payload)) as CandidateWorkManifest : undefined;
  }

  async listManifests(candidateId: string): Promise<readonly CandidateWorkManifest[]> {
    await this.requireCandidate(candidateId);
    const rows = await this.database.all<{ work_manifest_payload: unknown }>("SELECT work_manifest_payload FROM candidate_work_manifests WHERE workspace_id = ? AND candidate_generation_id = ? ORDER BY work_manifest_id", [this.workspaceId, candidateId]);
    return rows.map((row) => decodeCanonical(bytes(row.work_manifest_payload)) as CandidateWorkManifest);
  }

  async getDelta(candidateId: string, deltaId: string): Promise<CandidateDeltaInput | undefined> {
    await this.requireCandidate(candidateId);
    const row = await this.database.get<{ delta_payload: unknown }>("SELECT delta_payload FROM candidate_fact_deltas WHERE workspace_id = ? AND candidate_generation_id = ? AND fact_delta_id = ?", [this.workspaceId, candidateId, deltaId]);
    return row ? decodeCanonical(bytes(row.delta_payload)) as CandidateDeltaInput : undefined;
  }

  async listDeltas(candidateId: string): Promise<readonly CandidateDeltaInput[]> {
    await this.requireCandidate(candidateId);
    const rows = await this.database.all<{ delta_payload: unknown }>("SELECT delta_payload FROM candidate_fact_deltas WHERE workspace_id = ? AND candidate_generation_id = ? ORDER BY accepted_at, fact_delta_id", [this.workspaceId, candidateId]);
    return rows.map((row) => decodeCanonical(bytes(row.delta_payload)) as CandidateDeltaInput);
  }

  async getMaterialization(candidateId: string): Promise<CandidateMaterialization | undefined> {
    await this.requireCandidate(candidateId);
    const row = await this.database.get<{ materialization_payload: unknown }>("SELECT materialization_payload FROM candidate_materializations WHERE workspace_id = ? AND candidate_generation_id = ? ORDER BY sealed_at DESC LIMIT 1", [this.workspaceId, candidateId]);
    return row ? decodeCanonical(bytes(row.materialization_payload)) as CandidateMaterialization : undefined;
  }

  async listIssues(candidateId: string): Promise<readonly CandidateIssue[]> {
    await this.requireCandidate(candidateId);
    const rows = await this.database.all<{
      candidate_issue_id: string; candidate_generation_id: string; issue_code: string; phase: string;
      severity: string; retryability: string; scope_payload: unknown; summary: string; detail: string;
      cause_references: string; payload: unknown; created_at: string;
    }>("SELECT candidate_issue_id, candidate_generation_id, issue_code, phase, severity, retryability, scope_payload, summary, detail, cause_references, payload, created_at FROM candidate_issues WHERE workspace_id = ? AND candidate_generation_id = ? ORDER BY created_at, candidate_issue_id", [this.workspaceId, candidateId]);
    return rows.map((row) => ({
      candidate_issue_id: row.candidate_issue_id,
      candidate_generation_id: row.candidate_generation_id,
      issue_code: row.issue_code,
      phase: row.phase,
      severity: row.severity,
      retryability: row.retryability,
      scope: decodeCanonical(bytes(row.scope_payload)) as CandidateIssue["scope"],
      summary: row.summary,
      detail: row.detail,
      cause_references: row.cause_references,
      payload: decodeCanonical(bytes(row.payload)) as CandidateIssue["payload"],
      created_at: row.created_at,
    }));
  }

  async listLookupDependencies(candidateId: string): Promise<readonly Record<string, unknown>[]> {
    await this.requireCandidate(candidateId);
    const rows = await this.database.all<{ dependency_payload: unknown }>("SELECT dependency_payload FROM candidate_lookup_dependencies WHERE workspace_id = ? AND candidate_generation_id = ? ORDER BY lookup_dependency_id", [this.workspaceId, candidateId]);
    return rows.map((row) => decodeCanonical(bytes(row.dependency_payload)) as Record<string, unknown>);
  }

  async listRoots(candidateId: string): Promise<readonly CandidateRoot[]> {
    await this.requireCandidate(candidateId);
    const rows = await this.database.all<Record<string, unknown> & { root_payload: unknown }>("SELECT * FROM candidate_roots WHERE workspace_id = ? AND candidate_generation_id = ? ORDER BY root_id", [this.workspaceId, candidateId]);
    return rows.map((row) => ({ root_id: String(row["root_id"]), workspace_id: String(row["workspace_id"]), candidate_generation_id: String(row["candidate_generation_id"]), resource_type: String(row["resource_type"]), content_digest: String(row["content_digest"]), state: String(row["state"]), payload: decodeCanonical(bytes(row.root_payload)) }));
  }

  async getRoot(candidateId: string, rootId: string): Promise<CandidateRoot | undefined> {
    await this.requireCandidate(candidateId);
    const row = await this.database.get<Record<string, unknown> & { root_payload: unknown }>("SELECT * FROM candidate_roots WHERE workspace_id = ? AND candidate_generation_id = ? AND root_id = ?", [this.workspaceId, candidateId, rootId]);
    return row ? { root_id: String(row["root_id"]), workspace_id: String(row["workspace_id"]), candidate_generation_id: String(row["candidate_generation_id"]), resource_type: String(row["resource_type"]), content_digest: String(row["content_digest"]), state: String(row["state"]), payload: decodeCanonical(bytes(row.root_payload)) } : undefined;
  }

  async getLease(candidateId: string): Promise<Record<string, unknown> | undefined> {
    await this.requireCandidate(candidateId);
    const row = await this.database.get<{ lease_payload: unknown }>("SELECT lease_payload FROM candidate_retention_leases WHERE workspace_id = ? AND candidate_generation_id = ?", [this.workspaceId, candidateId]);
    return row ? decodeCanonical(bytes(row.lease_payload)) as Record<string, unknown> : undefined;
  }

  private async requireCandidate(candidateId: string, expectedCandidateId = candidateId): Promise<void> {
    const row = await this.database.get<{ candidate_generation_id: string }>("SELECT candidate_generation_id FROM candidate_state WHERE workspace_id = ? AND candidate_generation_id = ?", [this.workspaceId, candidateId]);
    if (!row || row.candidate_generation_id !== expectedCandidateId) throw new StorageError("storage:candidate_not_found", `Candidate ${candidateId} does not exist in workspace ${this.workspaceId}.`);
  }

  async getPublication(candidateId: string): Promise<CandidatePublicationResult | undefined> {
    const row = await this.database.get<Record<string, unknown>>("SELECT candidate_generation_id, snapshot_id, generation_manifest_id, generation, published_at, CASE WHEN status = 'published' THEN 'published' ELSE 'already_published' END AS status FROM candidate_publication_journal WHERE workspace_id = ? AND candidate_generation_id = ?", [this.workspaceId, candidateId]);
    if (!row) return undefined;
    return { candidate_generation_id: String(row["candidate_generation_id"]), snapshot_id: String(row["snapshot_id"]), generation_manifest_id: String(row["generation_manifest_id"]), generation: Number(row["generation"]), published_at: String(row["published_at"]), status: row["status"] === "published" ? "published" : "already_published" };
  }

  async getPublicationBySnapshot(snapshotId: string): Promise<CandidatePublicationResult | undefined> {
    const row = await this.database.get<Record<string, unknown>>("SELECT candidate_generation_id, snapshot_id, generation_manifest_id, generation, published_at, CASE WHEN status = 'published' THEN 'published' ELSE 'already_published' END AS status FROM candidate_publication_journal WHERE workspace_id = ? AND snapshot_id = ?", [this.workspaceId, snapshotId]);
    if (!row) return undefined;
    return { candidate_generation_id: String(row["candidate_generation_id"]), snapshot_id: String(row["snapshot_id"]), generation_manifest_id: String(row["generation_manifest_id"]), generation: Number(row["generation"]), published_at: String(row["published_at"]), status: row["status"] === "published" ? "published" : "already_published" };
  }
}
