import { frozenCandidateBaseTupleDigest, type CandidatePublicationInput, type FrozenCandidateBaseTuple, type WorkspaceDatabase } from "@urdira/storage";
import type { CandidateCleanupResource, CandidateIssuePort, CandidatePublicationResult, CandidateStatePort, CandidateWorkspacePort } from "./candidate-indexer.js";

/**
 * Parses a snapshot's `source_observation_watermarks` column just enough to
 * pull out the `source_observation_batch_ids` array it carries. A small,
 * deliberately equivalent re-parse of the same public field
 * (`SnapshotRepository.get`, `@urdira/storage`) rather than a new dependency
 * on storage internals -- mirrors `workspace-indexing-session.ts`'s private
 * `priorObservationBatchIds`, which the same watermarks shape is read by on
 * the scan-time path.
 */
function currentObservationBatchIds(sourceObservationWatermarks: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(sourceObservationWatermarks);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const batchIds = (parsed as Record<string, unknown>)["source_observation_batch_ids"];
    if (!Array.isArray(batchIds)) return [];
    return batchIds.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

/**
 * Builds a `FrozenCandidateBaseTuple` snapshotting the workspace's CURRENT
 * live tuple (as of the call) -- for `CandidateIndexer.recover()`'s
 * staleness pre-check (`packages/engine/src/candidate-indexer.ts`) to
 * compare against a recoverable candidate's own FROZEN base
 * (`WorkspaceCandidateRepository.getFrozenBase`, captured once at candidate
 * creation and never updated thereafter). Mirrors the `baseAgrees`/`expected`
 * construction `WorkspaceDatabase.publishCandidateSerialized`
 * (`packages/storage/src/storage.ts`) itself uses to validate a publish --
 * same source tables, same fields -- so a candidate `recover()` deems fresh
 * here is exactly the one `publishCandidate` would actually accept.
 *
 * Before this helper existed, `currentBase` below called the exact same
 * per-candidate `getFrozenBase` lookup as the candidate's own `frozen` base,
 * making the two trivially equal on every comparison: `recover()` could
 * never detect that the workspace had moved on since a crashed candidate
 * was sealed (a later scan published, or the tree changed under it), so a
 * post-seal-crash candidate's stale sealed materialization got replayed
 * into `publishCandidate` forever, failing every time with
 * `storage:publication_conflict` (the "crashed candidate wedge" -- see
 * `CandidateIndexer.recover()`'s regression test).
 */
async function currentBaseTuple(database: WorkspaceDatabase): Promise<FrozenCandidateBaseTuple | undefined> {
  const current = await database.repositories.snapshots.getCurrent();
  if (!current) return undefined;
  const currentSnapshot = await database.repositories.snapshots.get(current.current_snapshot_id);
  const core = {
    snapshot_id: current.current_snapshot_id,
    generation: current.current_generation,
    registry_snapshot_id: current.current_registry_snapshot_id,
    resolution_lock_id: current.current_resolution_lock_id,
    configuration_revision_id: current.current_configuration_revision_id,
    source_state_digest: currentSnapshot?.source_state_digest ?? "",
    source_observation_batch_ids: currentSnapshot === undefined ? [] : currentObservationBatchIds(currentSnapshot.source_observation_watermarks),
  };
  return { ...core, tuple_digest: frozenCandidateBaseTupleDigest({ ...core, tuple_digest: "" }) };
}

/**
 * Composes a {@link CandidateWorkspacePort} directly over a real, opened
 * {@link WorkspaceDatabase}. This is pure composition over already-durable
 * storage primitives (`WorkspaceCandidateRepository`, `publishCandidate`) —
 * it adds no business logic beyond mapping method names and return shapes,
 * apart from `currentBase`'s small snapshot-plus-current-state read above.
 */
export function createWorkspaceCandidatePort(database: WorkspaceDatabase): CandidateWorkspacePort {
  const candidates: CandidateStatePort = database.candidates;
  const issues: CandidateIssuePort = { append: async (issue) => { await database.candidates.appendIssue(issue); } };
  return {
    candidates,
    issues,
    acquireBaseLease: async (candidate) => { await database.candidates.acquireLease(candidate.candidate_generation_id, candidate.base_snapshot_id); },
    renewBaseLease: (candidateId) => database.candidates.renewLease(candidateId),
    releaseBaseLease: (candidateId) => database.candidates.releaseLease(candidateId),
    publishCandidate: (input: CandidatePublicationInput): Promise<CandidatePublicationResult> => database.publishCandidate(input),
    committedPublication: (candidateId) => database.candidates.getPublication(candidateId),
    cleanupResource: async (candidateId, resource: CandidateCleanupResource) => {
      const result = await database.candidates.markCleanup({ candidate_generation_id: candidateId, resource_type: resource.resource_type, resource_id: resource.resource_id, state: "cleaned" });
      return result === "marked" ? "cleaned" : "already_clean";
    },
    currentBase: () => currentBaseTuple(database),
  };
}
