import { describe, expect, it, vi } from "vitest";
import { CandidateIndexer, createWorkspaceCandidatePort, type CandidateRunTrigger, type CandidateWorkspacePort } from "../packages/engine/src/index.js";

/**
 * Regression coverage for the "crashed candidate wedge": a scan that seals
 * (candidate reaches `ready`/`publishing` with a saved materialization) but
 * whose publish never commits -- a crash between seal and publish. Later
 * edits land and further scans/recoveries run. Before this fix,
 * `CandidateIndexer.recover()` (`packages/engine/src/candidate-indexer.ts`)
 * would replay that stale sealed materialization straight into
 * `publishCandidate`, which is GUARANTEED to reject it with
 * `storage:publication_conflict` (the workspace's current tuple has moved
 * on since the candidate's own frozen base was captured) -- and every
 * subsequent recovery attempt repeated the exact same conflict forever,
 * because the failure re-thrown out of `run()` also escaped `recover()`
 * uncaught, wedging the workspace until a manual remove+re-add.
 */

const RECOVERABLE_STATES = ["queued", "planning", "analyzing", "validating", "projecting", "ready", "publishing"];

function candidateFixture(overrides: Record<string, unknown> = {}): any {
  return {
    candidate_generation_id: "candidate:crashed-after-seal",
    workspace_id: "workspace:one",
    target_registry_snapshot_id: "registry:one",
    target_configuration_revision_id: "configuration:one",
    trigger_kind: "source_change",
    state: "publishing",
    source_observation_batch_ids: ["batch:one"],
    retention_lease_id: "lease:crashed-after-seal",
    candidate_materialization_id: "materialization:crashed-after-seal",
    created_at: "2026-08-13T00:00:00.000Z",
    issue_ids: [],
    ...overrides,
  };
}

// This candidate's OWN frozen base -- captured once, at candidate creation,
// before the scan that later crashed after seal (the tree at generation 1).
const candidateOwnFrozenBase = {
  snapshot_id: "snapshot:one",
  generation: 1,
  registry_snapshot_id: "registry:one",
  resolution_lock_id: "lock:one",
  configuration_revision_id: "configuration:one",
  source_state_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  source_observation_batch_ids: ["batch:one"],
  tuple_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
} as const;

// The workspace's CURRENT live tuple by the time recovery runs: a different
// scan published generation 2 in between (the crashed candidate never
// advanced the current pointer itself -- its own publish never committed).
const workspaceCurrentBase = {
  ...candidateOwnFrozenBase,
  snapshot_id: "snapshot:two",
  generation: 2,
  source_state_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  tuple_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
} as const;

/** Minimal trigger that carries `run()` all the way to `publishCandidate`, mirroring `tests/phase9-indexing.test.ts`'s `trigger()`. */
function fullTrigger(candidate: any, frozenBase: Record<string, unknown>): CandidateRunTrigger {
  return {
    candidate,
    frozen_base: frozenBase,
    source_plan: { transitions: [], seeds: [], equivalent: false, next_freshness_checkpoint: {} as never },
    buildPlan: async () => ({ manifest: { work_manifest_id: "manifest:one", work_digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333" } as never, dag: { levels: [], prerequisites: new Map(), dag_digest: "sha256:4444444444444444444444444444444444444444444444444444444444444444", work_items: new Map() } as never, invalidation: {} as never, artifact_work_items: [], projection_work_items: [], lookup_decisions: [] }),
    execute: async () => [],
    seal: async () => ({ materialization: { candidate_materialization_id: `materialization:${candidate.candidate_generation_id}`, workspace_id: "workspace:one", accepted_fact_delta_digests: [], source_transition_template_set: "[]", record_open_template_set: "[]", record_closure_template_set: "[]", identity_assignment_template_set: "[]", projection_open_template_sets: [], projection_closure_template_sets: [], capability_state_entries: [], source_observation_watermarks: [], materialization_digest: "sha256:5555555555555555555555555555555555555555555555555555555555555555" } as never }),
    publication: async (context: { materialization: unknown }) => ({ candidate: { ...candidate, state: "ready" }, frozen_base: frozenBase, materialization: context.materialization, target_registry: {} as never, target_resolution_lock: {} as never, target_configuration: {} as never, freshness_checkpoint: {} as never, publication_kind: "incremental" as never }),
  } as unknown as CandidateRunTrigger;
}

/** A port whose only recoverable candidate is sealed-but-uncommitted, and whose `getFrozenBase`/`currentBase` disagree (the workspace moved on). */
function stalePort() {
  const candidate = candidateFixture();
  const released: string[] = [];
  const publishedCandidateIds: string[] = [];
  const port: CandidateWorkspacePort = {
    candidates: {
      insert: vi.fn(async () => "already_present" as const),
      get: vi.fn(async () => candidate),
      transition: vi.fn(async (_id, _expected, next, patch) => { candidate.state = next as never; Object.assign(candidate, patch); }),
      selectManifest: vi.fn(async () => undefined),
      saveMaterialization: vi.fn(async () => "already_present" as const),
      listRecoverable: vi.fn(async () => (RECOVERABLE_STATES.includes(candidate.state) ? [candidate] : [])),
      getFrozenBase: vi.fn(async () => candidateOwnFrozenBase),
    },
    issues: { append: vi.fn(async () => undefined) },
    acquireBaseLease: vi.fn(async () => undefined),
    renewBaseLease: vi.fn(async () => undefined),
    releaseBaseLease: vi.fn(async (id: string) => { released.push(id); return "released" as const; }),
    publishCandidate: vi.fn(async (input: { candidate: { candidate_generation_id: string } }) => {
      publishedCandidateIds.push(input.candidate.candidate_generation_id);
      return { candidate_generation_id: input.candidate.candidate_generation_id, snapshot_id: "snapshot:three", generation_manifest_id: "manifest:three", generation: 3, published_at: "2026-08-13T00:00:02.000Z", status: "published" as const };
    }),
    committedPublication: vi.fn(async () => undefined),
    cleanupResource: vi.fn(async () => "already_clean" as const),
    currentBase: vi.fn(async () => workspaceCurrentBase),
  };
  return { port, candidate, released, publishedCandidateIds };
}

/** A port modeling storage's `getPublication`-less first recoverable pass with no cheap staleness signal available (no `getFrozenBase`/`currentBase`), so `recover()` must fall through straight to `resume` -- and that resumed replay itself fails with a publication conflict. */
function resumeConflictPort() {
  const candidate = candidateFixture({ candidate_generation_id: "candidate:resume-conflict" });
  const released: string[] = [];
  const port: CandidateWorkspacePort = {
    candidates: {
      insert: vi.fn(async () => "already_present" as const),
      get: vi.fn(async () => candidate),
      transition: vi.fn(async (_id, _expected, next, patch) => { candidate.state = next as never; Object.assign(candidate, patch); }),
      selectManifest: vi.fn(async () => undefined),
      saveMaterialization: vi.fn(async () => "already_present" as const),
      listRecoverable: vi.fn(async () => (RECOVERABLE_STATES.includes(candidate.state) ? [candidate] : [])),
    },
    issues: { append: vi.fn(async () => undefined) },
    acquireBaseLease: vi.fn(async () => undefined),
    renewBaseLease: vi.fn(async () => undefined),
    releaseBaseLease: vi.fn(async (id: string) => { released.push(id); return "released" as const; }),
    publishCandidate: vi.fn(async () => { throw Object.assign(new Error("The frozen candidate base tuple is stale."), { code: "storage:publication_conflict" }); }),
    committedPublication: vi.fn(async () => undefined),
    cleanupResource: vi.fn(async () => "already_clean" as const),
  };
  return { port, candidate, released };
}

/**
 * A minimal `WorkspaceDatabase`-shaped fake: just enough surface
 * (`repositories.snapshots.getCurrent`/`.get`, `candidates.getFrozenBase`)
 * for `createWorkspaceCandidatePort`'s `currentBase` wiring to exercise the
 * SAME code path production runs, instead of a hand-built
 * `CandidateWorkspacePort` (as the other tests in this file use) that would
 * bypass the wiring bug entirely.
 */
function fakeWorkspaceDatabase(): { currentState: unknown } {
  const currentState = {
    current_snapshot_id: "snapshot:two",
    current_generation: 2,
    current_registry_snapshot_id: "registry:one",
    current_resolution_lock_id: "lock:one",
    current_configuration_revision_id: "configuration:one",
  };
  const currentSnapshot = {
    source_state_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    source_observation_watermarks: JSON.stringify({ source_observation_batch_ids: ["batch:two"] }),
  };
  const database = {
    repositories: {
      snapshots: {
        getCurrent: vi.fn(async () => currentState),
        get: vi.fn(async () => currentSnapshot),
      },
    },
    candidates: {
      // The candidate's OWN frozen base, immutable since creation --
      // deliberately identical in shape to `candidateOwnFrozenBase` above
      // but with its own distinct values, so a wiring bug that just
      // re-reads this for `currentBase` is caught even if the two literal
      // objects elsewhere in this file happened to be reference-equal.
      getFrozenBase: vi.fn(async () => ({
        snapshot_id: "snapshot:one",
        generation: 1,
        registry_snapshot_id: "registry:one",
        resolution_lock_id: "lock:one",
        configuration_revision_id: "configuration:one",
        source_state_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        source_observation_batch_ids: ["batch:one"],
        tuple_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      })),
    },
  };
  return database as never;
}

describe("crashed candidate wedge (post-seal crash, publication never committed)", () => {
  it("wires currentBase to the workspace's CURRENT live tuple, not the candidate's own frozen base", async () => {
    const database = fakeWorkspaceDatabase();
    const port = createWorkspaceCandidatePort(database as never);

    const frozen = await (database as any).candidates.getFrozenBase("candidate:crashed-after-seal");
    const currentBase = await port.currentBase!("candidate:crashed-after-seal");

    expect(currentBase).toMatchObject({ snapshot_id: "snapshot:two", generation: 2, source_state_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222" });
    // The bug this guards against: `currentBase` used to be wired to call
    // the SAME `getFrozenBase(candidateId)` lookup as the candidate's own
    // frozen base, making the two trivially, always identical -- so
    // `CandidateIndexer.recover()`'s staleness pre-check could never fire.
    expect(currentBase).not.toEqual(frozen);
  });


  it("discards a sealed candidate whose frozen base has fallen behind the workspace's current tuple, and never replays it into publishCandidate", async () => {
    const { port, candidate, released, publishedCandidateIds } = stalePort();
    const indexer = new CandidateIndexer({ workspace: port });

    const recovered = await indexer.recover();

    expect(publishedCandidateIds).toEqual([]);
    expect(candidate.state).toBe("stale");
    expect(released).toEqual([candidate.candidate_generation_id]);
    expect(recovered).toEqual([]);
    // Not wedged: a follow-up recovery pass finds nothing left to recover
    // for this candidate (its state is terminal, so it drops out of
    // `listRecoverable()`), instead of repeating the same conflict forever.
    await expect(indexer.recover()).resolves.toEqual([]);
  });

  it("still lets a freshly replanned scan publish over a discarded stale candidate", async () => {
    const { port, publishedCandidateIds } = stalePort();
    const replannedCandidate = candidateFixture({ candidate_generation_id: "candidate:replanned-after-edit", state: "queued" });
    const indexer = new CandidateIndexer({
      workspace: port,
      replan: async () => fullTrigger(replannedCandidate, workspaceCurrentBase),
    });

    const recovered = await indexer.recover();

    expect(recovered).toContainEqual(expect.objectContaining({ generation: 3, state: "published", replanned_from_candidate_id: "candidate:crashed-after-seal" }));
    // The stale candidate's own sealed materialization was never the thing
    // published -- only the replanned (current-state) candidate was.
    expect(publishedCandidateIds).toEqual(["candidate:replanned-after-edit"]);
  });

  it("does not throw out of recover() when a resumed replay itself fails with a publication conflict, and does not repeat it on the next pass", async () => {
    const { port, candidate, released } = resumeConflictPort();
    const indexer = new CandidateIndexer({
      workspace: port,
      resume: async (resumeCandidate) => fullTrigger({ ...resumeCandidate, state: "queued" }, candidateOwnFrozenBase),
    });

    const recovered = await indexer.recover();

    expect(recovered).toEqual([expect.objectContaining({ status: "discarded_conflict", state: "stale", replanned_from_candidate_id: candidate.candidate_generation_id })]);
    expect(candidate.state).toBe("stale");
    expect(released).toContain(candidate.candidate_generation_id);
    // Not wedged: the candidate is terminal now, so a second recovery pass
    // over the same workspace does not find it, let alone re-conflict.
    await expect(indexer.recover()).resolves.toEqual([]);
  });
});
