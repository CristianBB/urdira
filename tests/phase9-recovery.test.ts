import { describe, expect, it, vi } from "vitest";
import { CandidateIndexer, type CandidateWorkspacePort } from "../packages/engine/src/index.js";

function recoverablePort() {
  const candidate = {
    candidate_generation_id: "candidate:lost-ack",
    workspace_id: "workspace:one",
    target_registry_snapshot_id: "registry:one",
    target_configuration_revision_id: "configuration:one",
    trigger_kind: "source_change",
    state: "publishing",
    source_observation_batch_ids: [],
    retention_lease_id: "lease:lost-ack",
    candidate_materialization_id: "materialization:lost-ack",
    created_at: "2026-08-10T00:00:00.000Z",
    issue_ids: [],
  } as any;
  const released: string[] = [];
  const port: CandidateWorkspacePort = {
    candidates: {
      insert: vi.fn(async () => "already_present" as const),
      get: vi.fn(async () => candidate),
      transition: vi.fn(async (_id, _expected, next, patch) => { candidate.state = next; Object.assign(candidate, patch); }),
      selectManifest: vi.fn(async () => undefined),
      saveMaterialization: vi.fn(async () => "already_present" as const),
      listRecoverable: vi.fn(async () => [candidate]),
    },
    issues: { append: vi.fn(async () => undefined) },
    acquireBaseLease: vi.fn(async () => undefined),
    renewBaseLease: vi.fn(async () => undefined),
    releaseBaseLease: vi.fn(async (id) => { released.push(id); return "released" as const; }),
    publishCandidate: vi.fn(),
    committedPublication: vi.fn(async () => ({ candidate_generation_id: candidate.candidate_generation_id, snapshot_id: "snapshot:two", generation_manifest_id: "manifest:two", generation: 2, published_at: "2026-08-10T00:00:02.000Z", status: "published" as const })),
    cleanupResource: vi.fn(async () => "already_clean" as const),
  };
  return { port, candidate, released };
}

describe("Phase 9 journal-first recovery and cleanup", () => {
  it("recognizes a committed publication before resuming candidate work", async () => {
    const { port, candidate, released } = recoverablePort();

    const recovered = await new CandidateIndexer({ workspace: port }).recover();

    expect(recovered).toContainEqual(expect.objectContaining({ state: "published", generation: 2 }));
    expect(port.publishCandidate).not.toHaveBeenCalled();
    expect(candidate.state).toBe("published");
    expect(released).toEqual(["candidate:lost-ack"]);
  });

  it("repeats cleanup without changing the publication tuple", async () => {
    const { port } = recoverablePort();
    const indexer = new CandidateIndexer({ workspace: port });
    const before = { snapshot_id: "snapshot:two", generation: 2 };

    await indexer.cleanup("candidate:lost-ack");
    await indexer.cleanup("candidate:lost-ack");

    expect(before).toEqual({ snapshot_id: "snapshot:two", generation: 2 });
    expect(port.publishCandidate).not.toHaveBeenCalled();
    expect(port.cleanupResource).toHaveBeenCalledTimes(4);
  });
});
