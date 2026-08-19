import { describe, expect, it, vi } from "vitest";
import { CandidateIndexer, type CandidateRunTrigger, type CandidateWorkspacePort } from "../packages/engine/src/index.js";

const baseCandidate = {
  candidate_generation_id: "candidate:one",
  workspace_id: "workspace:one",
  base_snapshot_id: "snapshot:one",
  base_generation: 1,
  base_registry_snapshot_id: "registry:one",
  target_registry_snapshot_id: "registry:two",
  base_configuration_revision_id: "configuration:one",
  target_configuration_revision_id: "configuration:two",
  trigger_kind: "source_change",
  state: "queued",
  source_observation_batch_ids: ["batch:one"],
  created_at: "2026-08-10T00:00:00.000Z",
  issue_ids: [],
} as const;

const frozenBase = {
  snapshot_id: "snapshot:one",
  generation: 1,
  registry_snapshot_id: "registry:one",
  resolution_lock_id: "lock:one",
  configuration_revision_id: "configuration:one",
  source_state_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  source_observation_batch_ids: ["batch:one"],
  tuple_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
} as const;

function workspace(): CandidateWorkspacePort & { events: string[]; candidatesById: Map<string, any> } {
  const events: string[] = [];
  const candidatesById = new Map<string, any>();
  const candidates = {
    insert: vi.fn(async (candidate: any) => { candidatesById.set(candidate.candidate_generation_id, candidate); return "inserted" as const; }),
    get: vi.fn(async (candidateId: string) => candidatesById.get(candidateId)),
    transition: vi.fn(async (candidateId: string, expected: string, next: string, patch: Record<string, unknown>) => {
      const candidate = candidatesById.get(candidateId);
      expect(candidate.state).toBe(expected);
      candidatesById.set(candidateId, { ...candidate, ...patch, state: next });
      events.push(`${candidateId}:${expected}->${next}`);
    }),
    selectManifest: vi.fn(async () => undefined),
    saveMaterialization: vi.fn(async () => "inserted" as const),
    listRecoverable: vi.fn(async () => [...candidatesById.values()]),
  };
  return {
    candidates,
    issues: { append: vi.fn(async () => undefined) },
    acquireBaseLease: vi.fn(async () => { events.push("lease:acquire"); }),
    renewBaseLease: vi.fn(async () => { events.push("lease:renew"); }),
    releaseBaseLease: vi.fn(async () => { events.push("lease:release"); return "released" as const; }),
    publishCandidate: vi.fn(async (input: any) => { events.push(`publish:${input.candidate.candidate_generation_id}`); return { candidate_generation_id: input.candidate.candidate_generation_id, snapshot_id: `snapshot:${input.candidate.candidate_generation_id}`, generation_manifest_id: `manifest:${input.candidate.candidate_generation_id}`, generation: 2, published_at: "2026-08-10T00:00:01.000Z", status: "published" as const }; }),
    committedPublication: vi.fn(async () => undefined),
    cleanupResource: vi.fn(async (_candidateId: string, resource: any) => { events.push(`cleanup:${resource.resource_type}:${resource.resource_id}`); return "cleaned" as const; }),
    events,
    candidatesById,
  };
}

function trigger(workspacePort: CandidateWorkspacePort, overrides: Partial<CandidateRunTrigger> = {}): CandidateRunTrigger {
  return {
    candidate: { ...baseCandidate },
    frozen_base: { ...frozenBase },
    source_plan: { transitions: [], seeds: [], equivalent: false, next_freshness_checkpoint: {} as never },
    buildPlan: async () => ({ manifest: { work_manifest_id: "manifest:one", work_digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333" } as never, dag: { levels: [], prerequisites: new Map(), dag_digest: "sha256:4444444444444444444444444444444444444444444444444444444444444444", work_items: new Map() } as never, invalidation: {} as never, artifact_work_items: [], projection_work_items: [], lookup_decisions: [] }),
    execute: async () => [],
    seal: async () => ({ materialization: { candidate_materialization_id: "materialization:one", workspace_id: "workspace:one", accepted_fact_delta_digests: [], source_transition_template_set: "[]", record_open_template_set: "[]", record_closure_template_set: "[]", identity_assignment_template_set: "[]", projection_open_template_sets: [], projection_closure_template_sets: [], capability_state_entries: [], source_observation_watermarks: [], materialization_digest: "sha256:5555555555555555555555555555555555555555555555555555555555555555" } as never }),
    publication: async (materialization: any) => ({ candidate: { ...baseCandidate, state: "ready" }, frozen_base: { ...frozenBase }, materialization, target_registry: {} as never, target_resolution_lock: {} as never, target_configuration: {} as never, freshness_checkpoint: {} as never, publication_kind: "incremental" as never }),
    workspace: workspacePort,
    ...overrides,
  } as CandidateRunTrigger;
}

describe("Phase 9 candidate coordinator", () => {
  it("drives the closed lifecycle and publishes only after the sealed materialization", async () => {
    const port = workspace();
    const result = await new CandidateIndexer({ workspace: port }).run(trigger(port));

    expect(result).toMatchObject({ generation: 2, state: "published" });
    expect(port.events).toEqual([
      "lease:acquire",
      "candidate:one:queued->planning",
      "candidate:one:planning->analyzing",
      "candidate:one:analyzing->validating",
      "candidate:one:validating->projecting",
      "candidate:one:projecting->ready",
      "candidate:one:ready->publishing",
      "publish:candidate:one",
      "lease:release",
    ]);
  });

  it("publishes confirmed absence before identical reappearance", async () => {
    const port = workspace();
    const first = trigger(port, { candidate: { ...baseCandidate, candidate_generation_id: "candidate:delete", trigger_kind: "confirmed_delete" } as never });
    const second = trigger(port, { candidate: { ...baseCandidate, candidate_generation_id: "candidate:reappear", trigger_kind: "identical_reappearance" } as never });
    let generation = 1;
    port.publishCandidate = vi.fn(async (input: any) => ({ candidate_generation_id: input.candidate.candidate_generation_id, snapshot_id: `snapshot:${input.candidate.candidate_generation_id}`, generation_manifest_id: `manifest:${input.candidate.candidate_generation_id}`, generation: ++generation, published_at: "2026-08-10T00:00:01.000Z", status: "published" as const }));

    const results = await new CandidateIndexer({ workspace: port }).runBarrier([first, second]);

    expect(results.map((entry) => entry.generation)).toEqual([2, 3]);
    const publishMock = port.publishCandidate as unknown as ReturnType<typeof vi.fn>;
    expect(publishMock.mock.invocationCallOrder[0]).toBeLessThan(publishMock.mock.invocationCallOrder[1]!);
  });

  it("releases the base lease when analysis fails and leaves the candidate failed", async () => {
    const port = workspace();
    const triggerValue = trigger(port, {
      execute: async () => { throw Object.assign(new Error("worker failed"), { code: "core:analyzer_failed" }); },
    });

    await expect(new CandidateIndexer({ workspace: port }).run(triggerValue)).rejects.toMatchObject({ code: "core:analyzer_failed" });
    expect(port.events).toContain("lease:release");
    expect(port.candidatesById.get("candidate:one")).toMatchObject({ state: "failed" });
  });

  it("cleans every persisted private root independently and is retry-safe", async () => {
    const port = workspace();
    (port.candidates as any).listRoots = vi.fn(async () => [
      { resource_type: "temporary_projection", root_id: "projection:one" },
      { resource_type: "temporary_blob", root_id: "blob:one" },
    ]);
    const candidate = { ...baseCandidate, state: "published", retention_lease_id: "lease:published", candidate_materialization_id: "materialization:published" };
    port.candidatesById.set(candidate.candidate_generation_id, candidate);

    const indexer = new CandidateIndexer({ workspace: port });
    await indexer.cleanup(candidate.candidate_generation_id);
    await indexer.cleanup(candidate.candidate_generation_id);

    expect(port.events).toEqual([
      "candidate:one:published->cleaning",
      "lease:release",
      "cleanup:retention_lease:lease:published",
      "cleanup:candidate_materialization:materialization:published",
      "cleanup:temporary_projection:projection:one",
      "cleanup:temporary_blob:blob:one",
      "candidate:one:cleaning->cleaned",
      "lease:release",
      "cleanup:retention_lease:lease:published",
      "cleanup:candidate_materialization:materialization:published",
      "cleanup:temporary_projection:projection:one",
      "cleanup:temporary_blob:blob:one",
    ]);
  });
});
