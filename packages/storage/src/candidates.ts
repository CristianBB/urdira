import { canonicalBytes, decodeCanonical, digestBytes, digestCanonicalArray, digestLogicalValue, encodeCanonical } from "@urdira/canonical";
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
import { validateFactDeltaBatch, type FactDeltaBatch } from "@urdira/contracts";
import type { BlobStore } from "./cas.js";
import { resetTimings, snapshotTimings, timed, timedSync, timingEnabled } from "./debug-timing.js";
import { StorageError } from "./errors.js";
import type { RecordOpenMemoEntry } from "./publication-authority.js";
import type { SqliteCommand, SqliteDatabase, SqliteValue } from "./sqlite.js";
import { flattenRelationalValue, hydrateRelationalValue, relationalValueCommandsForTable, type RelationalValueRow } from "./relational-values.js";
export { canonicalFrozenCandidateBaseTuple, frozenCandidateBaseTupleDigest, normalizeObservationBatchIds, sameFrozenCandidateBaseTuple } from "./candidate-digest.js";

/**
 * The seven template arrays a sealed `CandidateMaterialization` describes
 * (see `packages/engine/src/candidate-materialization.ts`'s
 * `SealedCandidateMaterialization`), carried out-of-band from the
 * materialization itself. The materialization's Text fields hold only a
 * small, bounded `OrderedSetDescriptor` for each set (descriptor-as-text);
 * these are the real entries the descriptor describes. The active publication
 * call carries these typed arrays in memory; durable recovery replays the
 * confirmed FactDelta batches rather than persisting a second generic copy of
 * every template entry.
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

/** `set_kind` values for staged candidate template rows, in stable order. */
export const CANDIDATE_TEMPLATE_SET_KINDS = ["source_transitions", "record_opens", "record_closures", "identity_assignments", "artifact_dependencies", "lookup_dependencies", "lookup_revalidations"] as const;
export type CandidateTemplateSetKind = (typeof CANDIDATE_TEMPLATE_SET_KINDS)[number];

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
  /**
   * (3c) Carries the seal-built record-open id/digest memo, keyed by object
   * identity of each `template_sets.record_opens` entry, straight into
   * publish. `CandidateMaterializer.seal()` (`@urdira/engine`) computes each
   * open's id/digest directly from the source record while sealing;
   * `buildCandidatePublicationPlan` uses this as a lookup instead of
   * re-deriving it by `JSON.parse`ing and re-hashing `record_without_validity`
   * a second time in the very same process. Optional and covering exactly
   * `template_sets.record_opens` (verified before use, by object identity,
   * in `buildCandidatePublicationPlan`) -- absent or mismatched falls back
   * to the unchanged recompute path unconditionally (fork path, recovery
   * replay, and any caller that doesn't thread it through).
   */
  readonly record_open_memo?: ReadonlyMap<unknown, RecordOpenMemoEntry>;
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

function manifestFromRow(row: Record<string, unknown>): CandidateWorkManifest {
  try {
    return {
      work_manifest_id: String(row["work_manifest_id"]),
      ...(row["supersedes_work_manifest_id"] === null ? {} : { supersedes_work_manifest_id: String(row["supersedes_work_manifest_id"]) }),
      workspace_id: String(row["workspace_id"]),
      candidate_generation_id: String(row["candidate_generation_id"]),
      ...(row["base_snapshot_id"] === null ? {} : { base_snapshot_id: String(row["base_snapshot_id"]) }),
      artifact_work_set: JSON.parse(String(row["artifact_work_set"])),
      projection_work_set: JSON.parse(String(row["projection_work_set"])),
      invalidation_plan_id: String(row["invalidation_plan_id"]),
      target_registry_snapshot_id: String(row["target_registry_snapshot_id"]),
      target_configuration_revision_id: String(row["target_configuration_revision_id"]),
      created_at: String(row["created_at"]),
      work_digest: String(row["work_digest"]),
    } as CandidateWorkManifest;
  } catch (error) {
    throw new StorageError("storage:work_manifest_corrupt", `Work manifest ${String(row["work_manifest_id"])} has invalid relational descriptor text.`, { cause: error instanceof Error ? error.message : String(error) });
  }
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
  readonly base_snapshot_id: string | null;
  readonly base_generation: number | null;
  readonly base_registry_snapshot_id: string | null;
  readonly target_registry_snapshot_id: string;
  readonly base_configuration_revision_id: string | null;
  readonly target_configuration_revision_id: string;
  readonly trigger_kind: string;
  readonly work_manifest_id: string | null;
  readonly source_observation_batch_ids: string;
  readonly retention_lease_id: string | null;
  readonly candidate_materialization_id: string | null;
  readonly candidate_digest: string | null;
  readonly created_at: string;
  readonly analysis_started_at: string | null;
  readonly ready_at: string | null;
  readonly finished_at: string | null;
  readonly published_snapshot_id: string | null;
  readonly published_generation: number | null;
  readonly generation_manifest_id: string | null;
  readonly stale_against_snapshot_id: string | null;
  readonly failure_code: string | null;
  readonly issue_ids: string;
  readonly frozen_snapshot_id: string | null;
  readonly frozen_generation: number | null;
  readonly frozen_registry_snapshot_id: string | null;
  readonly frozen_resolution_lock_id: string | null;
  readonly frozen_configuration_revision_id: string | null;
  readonly frozen_source_state_digest: string | null;
  readonly frozen_source_observation_batch_ids: string | null;
  readonly frozen_tuple_digest: string | null;
};

function candidateFromRow(row: CandidateRow): IndexCandidate {
  return {
    candidate_generation_id: row.candidate_generation_id,
    workspace_id: row.workspace_id,
    ...(row.base_snapshot_id === null ? {} : { base_snapshot_id: row.base_snapshot_id }),
    ...(row.base_generation === null ? {} : { base_generation: row.base_generation }),
    ...(row.base_registry_snapshot_id === null ? {} : { base_registry_snapshot_id: row.base_registry_snapshot_id }),
    target_registry_snapshot_id: row.target_registry_snapshot_id,
    ...(row.base_configuration_revision_id === null ? {} : { base_configuration_revision_id: row.base_configuration_revision_id }),
    target_configuration_revision_id: row.target_configuration_revision_id,
    trigger_kind: row.trigger_kind,
    state: row.state,
    ...(row.work_manifest_id === null ? {} : { work_manifest_id: row.work_manifest_id }),
    source_observation_batch_ids: JSON.parse(row.source_observation_batch_ids) as readonly string[],
    ...(row.retention_lease_id === null ? {} : { retention_lease_id: row.retention_lease_id }),
    ...(row.candidate_materialization_id === null ? {} : { candidate_materialization_id: row.candidate_materialization_id }),
    ...(row.candidate_digest === null ? {} : { candidate_digest: row.candidate_digest }),
    created_at: row.created_at,
    ...(row.analysis_started_at === null ? {} : { analysis_started_at: row.analysis_started_at }),
    ...(row.ready_at === null ? {} : { ready_at: row.ready_at }),
    ...(row.finished_at === null ? {} : { finished_at: row.finished_at }),
    ...(row.published_snapshot_id === null ? {} : { published_snapshot_id: row.published_snapshot_id }),
    ...(row.published_generation === null ? {} : { published_generation: row.published_generation }),
    ...(row.generation_manifest_id === null ? {} : { generation_manifest_id: row.generation_manifest_id }),
    ...(row.stale_against_snapshot_id === null ? {} : { stale_against_snapshot_id: row.stale_against_snapshot_id }),
    ...(row.failure_code === null ? {} : { failure_code: row.failure_code }),
    issue_ids: JSON.parse(row.issue_ids) as readonly string[],
  };
}

function frozenBaseFromRow(row: CandidateRow): FrozenCandidateBaseTuple {
  return {
    ...(row.frozen_snapshot_id === null ? {} : { snapshot_id: row.frozen_snapshot_id }),
    ...(row.frozen_generation === null ? {} : { generation: row.frozen_generation }),
    ...(row.frozen_registry_snapshot_id === null ? {} : { registry_snapshot_id: row.frozen_registry_snapshot_id }),
    ...(row.frozen_resolution_lock_id === null ? {} : { resolution_lock_id: row.frozen_resolution_lock_id }),
    ...(row.frozen_configuration_revision_id === null ? {} : { configuration_revision_id: row.frozen_configuration_revision_id }),
    source_state_digest: row.frozen_source_state_digest ?? "",
    source_observation_batch_ids: row.frozen_source_observation_batch_ids === null ? [] : JSON.parse(row.frozen_source_observation_batch_ids) as readonly string[],
    tuple_digest: row.frozen_tuple_digest ?? "",
  };
}

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
    const existing = await this.database.get<CandidateRow>("SELECT * FROM candidate_state WHERE candidate_generation_id = ?", [candidate.candidate_generation_id]);
    const values: readonly SqliteValue[] = [candidate.workspace_id, optionalText(candidate.base_snapshot_id), optionalNumber(candidate.base_generation), optionalText(candidate.base_registry_snapshot_id), candidate.target_registry_snapshot_id, optionalText(candidate.base_configuration_revision_id), candidate.target_configuration_revision_id, candidate.trigger_kind, candidate.state, optionalText(candidate.work_manifest_id), JSON.stringify(candidate.source_observation_batch_ids), optionalText(candidate.retention_lease_id), optionalText(candidate.candidate_materialization_id), optionalText(candidate.candidate_digest), candidate.created_at, optionalText(candidate.analysis_started_at), optionalText(candidate.ready_at), optionalText(candidate.finished_at), optionalText(candidate.published_snapshot_id), optionalNumber(candidate.published_generation), optionalText(candidate.generation_manifest_id), optionalText(candidate.stale_against_snapshot_id), optionalText(candidate.failure_code), JSON.stringify(candidate.issue_ids), optionalText(frozenBase.snapshot_id), optionalNumber(frozenBase.generation), optionalText(frozenBase.registry_snapshot_id), optionalText(frozenBase.resolution_lock_id), optionalText(frozenBase.configuration_revision_id), frozenBase.source_state_digest, JSON.stringify(frozenBase.source_observation_batch_ids), frozenBase.tuple_digest];
    if (existing) {
      const decodedExisting = existing.workspace_id === this.workspaceId ? { candidate: candidateFromRow(existing), frozen_base: frozenBaseFromRow(existing) } : undefined;
      if (existing.workspace_id === this.workspaceId
        && decodedExisting !== undefined
        && sameCandidateIdentity(decodedExisting, { candidate, frozen_base: frozenBase })
        && ["queued", "published", "cleaning", "cleaned"].includes(existing.state)) return "already_present";
      if (existing.workspace_id !== this.workspaceId
        || decodedExisting === undefined || !sameCandidateIdentity(decodedExisting, { candidate, frozen_base: frozenBase })
        || await isPublished(this.database, this.workspaceId, candidate.candidate_generation_id)) conflict("candidate", candidate.candidate_generation_id);
      const updated = await this.database.run(
        `UPDATE candidate_state SET workspace_id = ?, base_snapshot_id = ?, base_generation = ?, base_registry_snapshot_id = ?,
          target_registry_snapshot_id = ?, base_configuration_revision_id = ?, target_configuration_revision_id = ?, trigger_kind = ?, state = ?,
          work_manifest_id = ?, source_observation_batch_ids = ?, retention_lease_id = ?, candidate_materialization_id = ?, candidate_digest = ?,
          created_at = ?, analysis_started_at = ?, ready_at = ?, finished_at = ?, published_snapshot_id = ?, published_generation = ?, generation_manifest_id = ?,
          stale_against_snapshot_id = ?, failure_code = ?, issue_ids = ?, frozen_snapshot_id = ?, frozen_generation = ?, frozen_registry_snapshot_id = ?, frozen_resolution_lock_id = ?, frozen_configuration_revision_id = ?, frozen_source_state_digest = ?, frozen_source_observation_batch_ids = ?, frozen_tuple_digest = ?
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
        stale_against_snapshot_id, failure_code, issue_ids, frozen_snapshot_id, frozen_generation, frozen_registry_snapshot_id, frozen_resolution_lock_id, frozen_configuration_revision_id, frozen_source_state_digest, frozen_source_observation_batch_ids, frozen_tuple_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [candidate.candidate_generation_id, ...values],
    );
    return "inserted";
  }

  async get(candidateId: string): Promise<IndexCandidate | undefined> {
    const row = await this.database.get<CandidateRow>("SELECT * FROM candidate_state WHERE workspace_id = ? AND candidate_generation_id = ?", [this.workspaceId, candidateId]);
    if (!row) return undefined;
    return candidateFromRow(row);
  }

  async getFrozenBase(candidateId: string): Promise<FrozenCandidateBaseTuple | undefined> {
    const row = await this.database.get<CandidateRow>("SELECT * FROM candidate_state WHERE workspace_id = ? AND candidate_generation_id = ?", [this.workspaceId, candidateId]);
    if (!row) return undefined;
    return frozenBaseFromRow(row);
  }

  async transition(candidateId: string, expected: IndexCandidate["state"], next: IndexCandidate["state"], patch: Readonly<Record<string, unknown>> = {}): Promise<void> {
    const row = await this.database.get<CandidateRow>("SELECT * FROM candidate_state WHERE workspace_id = ? AND candidate_generation_id = ?", [this.workspaceId, candidateId]);
    if (!row) throw new StorageError("storage:candidate_not_found", `Candidate ${candidateId} does not exist.`);
    if (row.state !== expected) throw new StorageError("storage:candidate_state_conflict", `Candidate ${candidateId} is ${row.state}, not ${expected}.`);
    if (!(transitions[expected] ?? []).includes(next)) throw new StorageError("storage:invalid_candidate_transition", `Candidate transition ${expected} -> ${next} is not allowed.`);
    const candidate = { ...candidateFromRow(row), ...patch, state: next } as IndexCandidate;
    const updates: Array<[string, SqliteValue]> = [["state", next]];
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
    const existing = await this.database.get<{ work_digest: string }>("SELECT work_digest FROM candidate_work_manifests WHERE workspace_id = ? AND work_manifest_id = ?", [this.workspaceId, manifest.work_manifest_id]);
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
    await this.database.run("INSERT INTO candidate_work_manifests (work_manifest_id, workspace_id, candidate_generation_id, supersedes_work_manifest_id, base_snapshot_id, invalidation_plan_id, target_registry_snapshot_id, target_configuration_revision_id, artifact_work_set, projection_work_set, created_at, work_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [manifest.work_manifest_id, manifest.workspace_id, manifest.candidate_generation_id, optionalText(manifest.supersedes_work_manifest_id), optionalText(manifest.base_snapshot_id), manifest.invalidation_plan_id, manifest.target_registry_snapshot_id, manifest.target_configuration_revision_id, JSON.stringify(manifest.artifact_work_set), JSON.stringify(manifest.projection_work_set), manifest.created_at, manifest.work_digest]);
    await this.database.run("UPDATE candidate_state SET work_manifest_id = ? WHERE workspace_id = ? AND candidate_generation_id = ?", [manifest.work_manifest_id, this.workspaceId, candidateId]);
    return "inserted";
  }

  async acceptDelta(delta: CandidateDeltaInput): Promise<{ status: "inserted" | "already_accepted" }> {
    assertWorkspace(this.workspaceId, delta.workspace_id);
    await this.requireCandidate(delta.candidate_generation_id);
    const existing = await this.database.get<{ delta_digest: string }>("SELECT delta_digest FROM candidate_fact_deltas WHERE workspace_id = ? AND candidate_generation_id = ? AND fact_delta_id = ?", [this.workspaceId, delta.candidate_generation_id, delta.fact_delta_id]);
    if (existing) {
      if (existing.delta_digest !== delta.delta_digest) conflict("fact delta", delta.fact_delta_id);
      return { status: "already_accepted" };
    }
    await this.database.run("INSERT INTO candidate_fact_delta_namespaces (workspace_id, candidate_generation_id, fact_delta_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", [delta.workspace_id, delta.candidate_generation_id, delta.fact_delta_id]);
    await this.database.run("INSERT INTO candidate_fact_deltas (fact_delta_id, workspace_id, candidate_generation_id, delta_digest, accepted_at) VALUES (?, ?, ?, ?, ?)", [delta.fact_delta_id, delta.workspace_id, delta.candidate_generation_id, delta.delta_digest, now()]);
    return { status: "inserted" };
  }

  /** Accepts one transferred native batch idempotently before materialisation. */
  async acceptNativeFactDeltaBatch(candidateGenerationId: string, factDeltaId: string, batch: FactDeltaBatch): Promise<"inserted" | "already_accepted"> {
    validateFactDeltaBatch(batch);
    await this.requireCandidate(candidateGenerationId);
    const [result] = await this.database.transactionChunked([{
      kind: "staged_fact_delta_batch",
      workspace_id: this.workspaceId,
      candidate_generation_id: candidateGenerationId,
      fact_delta_id: factDeltaId,
      accepted_at: now(),
      batch,
    }], 1, { transfer_params: true });
    const status = (result as { readonly status?: unknown } | undefined)?.status;
    if (status !== "inserted" && status !== "already_accepted") throw new StorageError("storage:fact_delta_batch_invalid", "SQLite returned an invalid FactDelta batch acknowledgement.");
    return status;
  }

  /** Accepts several transferred native batches under one SQLite transaction. */
  async acceptNativeFactDeltaBatches(candidateGenerationId: string, entries: readonly { readonly fact_delta_id: string; readonly batch: FactDeltaBatch }[]): Promise<void> {
    if (entries.length === 0) return;
    await this.requireCandidate(candidateGenerationId);
    for (const entry of entries) validateFactDeltaBatch(entry.batch);
    await this.database.transactionChunked(entries.map((entry) => ({
      kind: "staged_fact_delta_batch" as const,
      workspace_id: this.workspaceId,
      candidate_generation_id: candidateGenerationId,
      fact_delta_id: entry.fact_delta_id,
      accepted_at: now(),
      batch: entry.batch,
    })), 64, { transfer_params: true, discard_results: true });
  }

  async saveMaterialization(candidateId: string, materialization: CandidateMaterialization, templateSets: CandidateTemplateSets = { source_transitions: [], record_opens: [], record_closures: [], identity_assignments: [], artifact_dependencies: [], lookup_dependencies: [], lookup_revalidations: [] }): Promise<CandidateInsertResult> {
    assertWorkspace(this.workspaceId, materialization.workspace_id);
    // Reset first (nothing meaningful has accumulated in the shared bucket
    // map yet for this handoff) so `candidate_seal_persist`, timed below,
    // survives into the snapshot the log line reads at the end -- resetting
    // AFTER the timed work, as this used to, would wipe it before it's ever
    // read.
    if (timingEnabled()) resetTimings();
    // `candidate_seal_persist`: the durable persist of the sealed candidate
    // materialization -- the engine's seal() output finishing its trip to
    // storage -- covering the existing-row lookup (idempotent replay check)
    // and, on first write, the insert plus the candidate_state pointer
    // update. This is the storage-side half of the "seal handoff" the
    // engine's own `publish_handoff_post`/`publish_handoff_pre` spans
    // (`workspace-indexing-session.ts`/`candidate-indexer.ts`) bracket from
    // the caller's side.
    const { existing } = await timed("candidate_seal_persist", async () => {
      await this.requireCandidate(candidateId);
      const contractText = JSON.stringify(materialization);
      const existingRow = await this.database.get<{ materialization_digest: string; materialization_contract_text: string }>("SELECT materialization_digest, materialization_contract_text FROM candidate_materializations WHERE workspace_id = ? AND candidate_materialization_id = ?", [this.workspaceId, materialization.candidate_materialization_id]);
      if (existingRow) {
        if (existingRow.materialization_digest !== materialization.materialization_digest || existingRow.materialization_contract_text !== contractText) conflict("materialization", materialization.candidate_materialization_id);
      } else {
        await this.database.run("INSERT INTO candidate_materializations (candidate_materialization_id, workspace_id, candidate_generation_id, materialization_digest, sealed_at, materialization_contract_text) VALUES (?, ?, ?, ?, ?, ?)", [materialization.candidate_materialization_id, materialization.workspace_id, candidateId, materialization.materialization_digest, now(), contractText]);
        await this.database.run("UPDATE candidate_state SET candidate_materialization_id = ? WHERE workspace_id = ? AND candidate_generation_id = ?", [materialization.candidate_materialization_id, this.workspaceId, candidateId]);
      }
      return { existing: existingRow };
    });
    if (timingEnabled()) console.error(`[urdira] storage timings save_materialization workspace:${this.workspaceId} ms=${JSON.stringify(snapshotTimings())}`);
    return existing ? "already_present" : "inserted";
  }

  async appendIssue(issue: CandidateIssue): Promise<CandidateInsertResult> {
    assertWorkspace(this.workspaceId, (issue.scope as unknown as { workspace_id?: string }).workspace_id ?? this.workspaceId);
    await this.requireCandidate(issue.candidate_generation_id);
    const issueJson = JSON.stringify(issue.payload);
    const scopeJson = JSON.stringify(issue.scope);
    const existing = await this.database.get<Record<string, unknown>>("SELECT issue_code, phase, severity, retryability, scope_json, summary, detail, cause_references, issue_json, created_at FROM candidate_issues WHERE workspace_id = ? AND candidate_generation_id = ? AND candidate_issue_id = ?", [this.workspaceId, issue.candidate_generation_id, issue.candidate_issue_id]);
    if (existing) {
      if (!sameFields(existing, { issue_code: issue.issue_code, phase: issue.phase, severity: issue.severity, retryability: issue.retryability, scope_json: scopeJson, summary: issue.summary, detail: issue.detail, cause_references: issue.cause_references, issue_json: issueJson, created_at: issue.created_at })) conflict("issue", issue.candidate_issue_id);
      return "already_present";
    }
    await this.database.run("INSERT INTO candidate_issues (candidate_issue_id, workspace_id, candidate_generation_id, issue_code, phase, severity, retryability, scope_json, summary, detail, cause_references, issue_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [issue.candidate_issue_id, this.workspaceId, issue.candidate_generation_id, issue.issue_code, issue.phase, issue.severity, issue.retryability, scopeJson, issue.summary, issue.detail, issue.cause_references, issueJson, issue.created_at]);
    return "inserted";
  }

  async putLookupDependency(value: Record<string, unknown>): Promise<CandidateInsertResult> {
    const workspaceId = String(value["workspace_id"]);
    assertWorkspace(this.workspaceId, workspaceId);
    const id = String(value["lookup_dependency_id"]);
    const dependencyDigest = typeof value["dependency_digest"] === "string" ? value["dependency_digest"] : digestLogicalValue(value, "urdira:lookup-dependency:v2");
    const candidateId = String(value["candidate_generation_id"]);
    await this.requireCandidate(candidateId);
    const existing = await this.database.get<{ dependency_digest: string }>("SELECT dependency_digest FROM candidate_lookup_dependencies WHERE workspace_id = ? AND candidate_generation_id = ? AND lookup_dependency_id = ?", [this.workspaceId, candidateId, id]);
    if (existing) {
      if (existing.dependency_digest !== dependencyDigest) conflict("lookup dependency", id);
      return "already_present";
    }
    await this.database.run("INSERT INTO candidate_lookup_dependencies (lookup_dependency_id, workspace_id, candidate_generation_id, consumer_type, consumer_id, owner_artifact_id, owner_artifact_version_id, operation, normalized_selector_or_address, selector_digest, previous_result_set_digest, invalidation_scope, valid_from_generation, valid_to_generation, dependency_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, workspaceId, candidateId, String(value["consumer_type"]), String(value["consumer_id"]), sqliteValue(value["owner_artifact_id"] ?? null), sqliteValue(value["owner_artifact_version_id"] ?? null), String(value["operation"]), String(value["normalized_selector_or_address"]), String(value["selector_digest"]), String(value["previous_result_set_digest"]), String(value["invalidation_scope"]), sqliteValue(value["valid_from_generation"] ?? null), sqliteValue(value["valid_to_generation"] ?? null), dependencyDigest]);
    return "inserted";
  }

  async acquireLease(candidateId: string, baseSnapshotId: string | undefined, acquiredAt = now()): Promise<CandidateInsertResult> {
    await this.requireCandidate(candidateId);
    const id = `lease:${candidateId}`;
    const existing = await this.database.get<{ state: string; base_snapshot_id: string | null; acquired_at: string; released_at: string | null }>("SELECT state, base_snapshot_id, acquired_at, released_at FROM candidate_retention_leases WHERE workspace_id = ? AND candidate_generation_id = ?", [this.workspaceId, candidateId]);
    if (existing) {
      if (existing.state === "active" && existing.base_snapshot_id === (baseSnapshotId ?? null) && existing.acquired_at === acquiredAt) return "already_present";
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
        "UPDATE candidate_retention_leases SET base_snapshot_id = ?, state = 'active', acquired_at = ?, released_at = NULL WHERE workspace_id = ? AND candidate_generation_id = ? AND state = ?",
        [baseSnapshotId ?? null, acquiredAt, this.workspaceId, candidateId, existing.state],
      );
      if (reactivated.changes !== 1) conflict("retention lease", id);
      await this.database.run("UPDATE candidate_state SET retention_lease_id = ? WHERE workspace_id = ? AND candidate_generation_id = ?", [id, this.workspaceId, candidateId]);
      return "inserted";
    }
    await this.database.run("INSERT INTO candidate_retention_leases (retention_lease_id, workspace_id, candidate_generation_id, base_snapshot_id, state, acquired_at, released_at) VALUES (?, ?, ?, ?, 'active', ?, NULL)", [id, this.workspaceId, candidateId, baseSnapshotId ?? null, acquiredAt]);
    await this.database.run("UPDATE candidate_state SET retention_lease_id = ? WHERE workspace_id = ? AND candidate_generation_id = ?", [id, this.workspaceId, candidateId]);
    return "inserted";
  }

  async renewLease(candidateId: string, renewedAt = now()): Promise<void> {
    await this.requireCandidate(candidateId);
    const existing = await this.database.get<{ state: string }>("SELECT state FROM candidate_retention_leases WHERE workspace_id = ? AND candidate_generation_id = ? AND state = 'active'", [this.workspaceId, candidateId]);
    if (!existing) throw new StorageError("storage:candidate_lease_not_found", `No active retention lease exists for candidate ${candidateId}.`);
    await this.database.run("UPDATE candidate_retention_leases SET acquired_at = ? WHERE workspace_id = ? AND candidate_generation_id = ? AND state = 'active'", [renewedAt, this.workspaceId, candidateId]);
  }

  async releaseLease(candidateId: string, releasedAt = now()): Promise<"released" | "already_released"> {
    await this.requireCandidate(candidateId);
    const existing = await this.database.get<{ state: string }>("SELECT state FROM candidate_retention_leases WHERE workspace_id = ? AND candidate_generation_id = ? AND state = 'active'", [this.workspaceId, candidateId]);
    if (!existing) return "already_released";
    await this.database.run("UPDATE candidate_retention_leases SET state = 'released', released_at = ? WHERE workspace_id = ? AND candidate_generation_id = ? AND state = 'active'", [releasedAt, this.workspaceId, candidateId]);
    return "released";
  }

  async markCleanup(marker: CandidateCleanupMarker): Promise<"marked" | "already_marked"> {
    await this.requireCandidate(marker.candidate_generation_id);
    const markedAt = marker.marked_at ?? now();
    const state = marker.state ?? "pending";
    const existing = await this.database.get<{ state: string }>("SELECT state FROM candidate_cleanup_markers WHERE candidate_generation_id = ? AND resource_type = ? AND resource_id = ?", [marker.candidate_generation_id, marker.resource_type, marker.resource_id]);
    if (existing) {
      if (state === "cleaned" && existing.state !== "cleaned") {
        await this.database.run("UPDATE candidate_cleanup_markers SET state = 'cleaned', marked_at = ? WHERE candidate_generation_id = ? AND resource_type = ? AND resource_id = ?", [markedAt, marker.candidate_generation_id, marker.resource_type, marker.resource_id]);
        return "marked";
      }
      return "already_marked";
    }
    await this.database.run("INSERT INTO candidate_cleanup_markers (candidate_generation_id, resource_type, resource_id, state, marked_at) VALUES (?, ?, ?, ?, ?)", [marker.candidate_generation_id, marker.resource_type, marker.resource_id, state, markedAt]);
    return "marked";
  }

  async listRecoverable(): Promise<readonly IndexCandidate[]> {
    const rows = await this.database.all<CandidateRow>("SELECT * FROM candidate_state WHERE workspace_id = ? AND state IN ('queued', 'planning', 'analyzing', 'validating', 'projecting', 'ready', 'publishing') ORDER BY created_at, candidate_generation_id", [this.workspaceId]);
    return rows.map(candidateFromRow);
  }

  async putRoot(root: CandidateRoot): Promise<CandidateInsertResult> {
    assertWorkspace(this.workspaceId, root.workspace_id);
    await this.requireCandidate(root.candidate_generation_id);
    const existing = await this.database.get<Record<string, unknown>>("SELECT workspace_id, candidate_generation_id, resource_type, content_digest, state FROM candidate_roots WHERE workspace_id = ? AND root_id = ?", [this.workspaceId, root.root_id]);
    if (existing) {
      if (!sameFields(existing, { workspace_id: this.workspaceId, candidate_generation_id: root.candidate_generation_id, resource_type: root.resource_type, content_digest: root.content_digest, state: root.state })) conflict("candidate root", root.root_id);
      return "already_present";
    }
    await this.database.transaction([
      { kind: "run", sql: "INSERT INTO candidate_roots (root_id, workspace_id, candidate_generation_id, resource_type, content_digest, state) VALUES (?, ?, ?, ?, ?, ?)", params: [root.root_id, this.workspaceId, root.candidate_generation_id, root.resource_type, root.content_digest, root.state] },
      ...relationalValueCommandsForTable(flattenRelationalValue(this.workspaceId, root.root_id, 0, root.payload), "candidate_value_nodes"),
    ]);
    return "inserted";
  }

  async getManifest(manifestId: string): Promise<CandidateWorkManifest | undefined> {
    const row = await this.database.get<Record<string, unknown>>("SELECT * FROM candidate_work_manifests WHERE workspace_id = ? AND work_manifest_id = ?", [this.workspaceId, manifestId]);
    return row ? manifestFromRow(row) : undefined;
  }

  async listManifests(candidateId: string): Promise<readonly CandidateWorkManifest[]> {
    await this.requireCandidate(candidateId);
    const rows = await this.database.all<Record<string, unknown>>("SELECT * FROM candidate_work_manifests WHERE workspace_id = ? AND candidate_generation_id = ? ORDER BY work_manifest_id", [this.workspaceId, candidateId]);
    return rows.map(manifestFromRow);
  }

  async getDelta(candidateId: string, deltaId: string): Promise<CandidateDeltaInput | undefined> {
    await this.requireCandidate(candidateId);
    const row = await this.database.get<{ fact_delta_id: string; candidate_generation_id: string; workspace_id: string; delta_digest: string }>("SELECT fact_delta_id, candidate_generation_id, workspace_id, delta_digest FROM candidate_fact_deltas WHERE workspace_id = ? AND candidate_generation_id = ? AND fact_delta_id = ?", [this.workspaceId, candidateId, deltaId]);
    return row ? row as CandidateDeltaInput : undefined;
  }

  async listDeltas(candidateId: string): Promise<readonly CandidateDeltaInput[]> {
    await this.requireCandidate(candidateId);
    const rows = await this.database.all<{ fact_delta_id: string; candidate_generation_id: string; workspace_id: string; delta_digest: string }>("SELECT fact_delta_id, candidate_generation_id, workspace_id, delta_digest FROM candidate_fact_deltas WHERE workspace_id = ? AND candidate_generation_id = ? ORDER BY accepted_at, fact_delta_id", [this.workspaceId, candidateId]);
    return rows as CandidateDeltaInput[];
  }

  async getMaterialization(candidateId: string): Promise<CandidateMaterialization | undefined> {
    await this.requireCandidate(candidateId);
    const row = await this.database.get<{ materialization_contract_text: string }>("SELECT materialization_contract_text FROM candidate_materializations WHERE workspace_id = ? AND candidate_generation_id = ? ORDER BY sealed_at DESC LIMIT 1", [this.workspaceId, candidateId]);
    return row ? JSON.parse(row.materialization_contract_text) as CandidateMaterialization : undefined;
  }

  async listIssues(candidateId: string): Promise<readonly CandidateIssue[]> {
    await this.requireCandidate(candidateId);
    const rows = await this.database.all<{
      candidate_issue_id: string; candidate_generation_id: string; issue_code: string; phase: string;
      severity: string; retryability: string; scope_json: string; summary: string; detail: string;
      cause_references: string; issue_json: string; created_at: string;
    }>("SELECT candidate_issue_id, candidate_generation_id, issue_code, phase, severity, retryability, scope_json, summary, detail, cause_references, issue_json, created_at FROM candidate_issues WHERE workspace_id = ? AND candidate_generation_id = ? ORDER BY created_at, candidate_issue_id", [this.workspaceId, candidateId]);
    return rows.map((row) => ({
      candidate_issue_id: row.candidate_issue_id,
      candidate_generation_id: row.candidate_generation_id,
      issue_code: row.issue_code,
      phase: row.phase,
      severity: row.severity,
      retryability: row.retryability,
      scope: JSON.parse(row.scope_json) as CandidateIssue["scope"],
      summary: row.summary,
      detail: row.detail,
      cause_references: row.cause_references,
      payload: JSON.parse(row.issue_json) as CandidateIssue["payload"],
      created_at: row.created_at,
    }));
  }

  async listLookupDependencies(candidateId: string): Promise<readonly Record<string, unknown>[]> {
    await this.requireCandidate(candidateId);
    const rows = await this.database.all<Record<string, unknown>>("SELECT lookup_dependency_id, workspace_id, candidate_generation_id, consumer_type, consumer_id, owner_artifact_id, owner_artifact_version_id, operation, normalized_selector_or_address, selector_digest, previous_result_set_digest, invalidation_scope, valid_from_generation, valid_to_generation, dependency_digest FROM candidate_lookup_dependencies WHERE workspace_id = ? AND candidate_generation_id = ? ORDER BY lookup_dependency_id", [this.workspaceId, candidateId]);
    return rows.map((row) => ({ ...row, lookup_dependency_id: String(row["lookup_dependency_id"]), workspace_id: String(row["workspace_id"]), candidate_generation_id: String(row["candidate_generation_id"]) }));
  }

  async listRoots(candidateId: string): Promise<readonly CandidateRoot[]> {
    await this.requireCandidate(candidateId);
    const rows = await this.database.all<Record<string, unknown>>("SELECT * FROM candidate_roots WHERE workspace_id = ? AND candidate_generation_id = ? ORDER BY root_id", [this.workspaceId, candidateId]);
    return Promise.all(rows.map(async (row) => ({ root_id: String(row["root_id"]), workspace_id: String(row["workspace_id"]), candidate_generation_id: String(row["candidate_generation_id"]), resource_type: String(row["resource_type"]), content_digest: String(row["content_digest"]), state: String(row["state"]), payload: hydrateRelationalValue(await this.database.all<Record<string, unknown> & RelationalValueRow>("SELECT * FROM candidate_value_nodes WHERE workspace_id = ? AND record_id = ? ORDER BY value_path", [this.workspaceId, String(row["root_id"])])) })));
  }

  async getRoot(candidateId: string, rootId: string): Promise<CandidateRoot | undefined> {
    await this.requireCandidate(candidateId);
    const row = await this.database.get<Record<string, unknown>>("SELECT * FROM candidate_roots WHERE workspace_id = ? AND candidate_generation_id = ? AND root_id = ?", [this.workspaceId, candidateId, rootId]);
    if (!row) return undefined;
    return { root_id: String(row["root_id"]), workspace_id: String(row["workspace_id"]), candidate_generation_id: String(row["candidate_generation_id"]), resource_type: String(row["resource_type"]), content_digest: String(row["content_digest"]), state: String(row["state"]), payload: hydrateRelationalValue(await this.database.all<Record<string, unknown> & RelationalValueRow>("SELECT * FROM candidate_value_nodes WHERE workspace_id = ? AND record_id = ? ORDER BY value_path", [this.workspaceId, rootId])) };
  }

  async getLease(candidateId: string): Promise<Record<string, unknown> | undefined> {
    await this.requireCandidate(candidateId);
    const row = await this.database.get<Record<string, unknown>>("SELECT retention_lease_id, workspace_id, candidate_generation_id, base_snapshot_id, state, acquired_at, released_at FROM candidate_retention_leases WHERE workspace_id = ? AND candidate_generation_id = ?", [this.workspaceId, candidateId]);
    return row;
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
