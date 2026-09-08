import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CanonicalRecordQueryDataPort,
  SqliteCanonicalQuerySnapshotPort,
  type CanonicalQueryRecord,
  type OperationInvocation,
} from "../packages/engine/src/index.js";
import { buildTaskPlannerWorkspace, type PublishedTaskPlannerWorkspace } from "./support/task-planner-workspace.js";

/**
 * Frente Q-3 (2026-09-08): differential tests for the three pushdowns this
 * frente added to `CanonicalRecordQueryDataPort.tryPushdown`
 * (`tryAnalyzeImpactPushdown`/`tryFindRelatedTestsPushdown`/`tryInspect
 * ArchitecturePushdown`, `canonical-query-data-port.ts`) plus the `core:
 * discover_definitions` full-corpus-avoidance fix (`execute`). Mirrors
 * `tests/query-pushdown-graph.test.ts`'s own cold/warm harness exactly: a
 * `cold` port whose `records`/`records_for_query`/`records_for_query_batches`
 * all throw (so ANY execution reaching the generic fallback fails the test
 * outright, proving the pushdown never touches the corpus) versus a `warm`
 * port pre-loaded so `execute()` skips `tryPushdown` and answers from the
 * pre-Q-3 in-memory fallback -- `expect(pushed).toEqual(fallback)` proves
 * byte-for-byte parity between the two paths.
 */
const scope = (workspaceId: string) => ({ scope_type: "single_workspace" as const, workspace_id: workspaceId });

function operation(workspaceId: string, operationId: string, resultStreams: readonly string[], args: Readonly<Record<string, unknown>>): OperationInvocation {
  return { operation_id: operationId, result_streams: resultStreams, arguments: args, scope: scope(workspaceId) };
}

describe("core:analyze_impact / core:find_related_tests / core:inspect_architecture / core:discover_definitions pushdown", () => {
  let workspace: PublishedTaskPlannerWorkspace;
  let cold: CanonicalRecordQueryDataPort;
  let warm: CanonicalRecordQueryDataPort;
  let coldSnapshot: SqliteCanonicalQuerySnapshotPort;
  let callTarget: CanonicalQueryRecord;
  let caller: CanonicalQueryRecord;

  beforeAll(async () => {
    workspace = await buildTaskPlannerWorkspace("typescript");
    const seedSnapshot = new SqliteCanonicalQuerySnapshotPort(workspace.opened.database);
    const records = await seedSnapshot.records(scope(workspace.workspaceId));
    for (const relation of records.filter((record) => record.category === "relation")) {
      const source = relation.body["source_id"];
      const target = relation.body["target_id"];
      if (typeof source !== "string" || typeof target !== "string") continue;
      await workspace.opened.projections.putGraphEdge({
        edge_id: `query-pushdown-catalog:${relation.record_id}`,
        source_subject_id: source,
        target_subject_id: target,
        relation_record_id: relation.record_id,
        relation_kind: relation.universal_kind,
        role: "target",
        evidence_class: relation.body["classification"] === "possible" ? "possible" : "confirmed",
        owner_artifact_id: relation.owner_artifact_id,
        owner_artifact_version_id: relation.owner_artifact_version_id,
        valid_from_generation: 1,
      });
    }

    const byAnyId = new Map<string, CanonicalQueryRecord>();
    for (const record of records) for (const id of [record.record_id, record.identity_id, record.identity_key]) if (typeof id === "string") byAnyId.set(id, record);
    const callRelation = records.find((record) => record.category === "relation" && record.universal_kind === "core:call" && record.body["classification"] !== "possible" && typeof record.body["source_id"] === "string" && typeof record.body["target_id"] === "string" && byAnyId.has(record.body["source_id"] as string) && byAnyId.has(record.body["target_id"] as string));
    expect(callRelation, "fixture must contain at least one confirmed core:call relation with both endpoints resolvable").toBeDefined();
    caller = byAnyId.get(callRelation!.body["source_id"] as string)!;
    callTarget = byAnyId.get(callRelation!.body["target_id"] as string)!;
    expect(caller).toBeDefined();
    expect(callTarget).toBeDefined();

    // This fixture has no *.test.ts files, so no real "core:covers" relation
    // exists to reuse -- add one synthetic edge (an unrelated entity standing
    // in as the "test" that covers `callTarget`) purely to exercise
    // `relatedTestsPushdown`'s exact-relation-kind BFS the same way a real
    // test-coverage producer would.
    const syntheticTest = records.find((record) => record.category === "entity" && record.record_id !== callTarget.record_id && record.record_id !== caller.record_id);
    expect(syntheticTest, "fixture must contain a third entity to stand in as a synthetic covering test").toBeDefined();
    await workspace.opened.projections.putGraphEdge({
      edge_id: "query-pushdown-catalog:synthetic-covers",
      source_subject_id: syntheticTest!.record_id,
      target_subject_id: callTarget.record_id,
      relation_record_id: "query-pushdown-catalog:synthetic-covers-relation",
      relation_kind: "core:covers",
      role: "target",
      evidence_class: "confirmed",
      owner_artifact_id: syntheticTest!.owner_artifact_id,
      owner_artifact_version_id: syntheticTest!.owner_artifact_version_id,
      valid_from_generation: 1,
    });

    coldSnapshot = new SqliteCanonicalQuerySnapshotPort(workspace.opened.database);
    const warmSnapshot = new SqliteCanonicalQuerySnapshotPort(workspace.opened.database);
    Object.assign(coldSnapshot, {
      records_for_query: async () => { throw new Error("pushdown performed a full record scan"); },
      records_for_query_batches: async function* () { throw new Error("pushdown performed a batched full record scan"); },
      records: async () => { throw new Error("pushdown populated the warm record cache"); },
    });
    cold = new CanonicalRecordQueryDataPort(coldSnapshot);
    warm = new CanonicalRecordQueryDataPort(warmSnapshot);
    await warm.warm(scope(workspace.workspaceId));
    expect(await coldSnapshot.has_warm_records(scope(workspace.workspaceId))).toBe(false);
  }, 60_000);

  afterAll(async () => {
    await workspace.close();
  });

  async function expectDifferential(invocation: OperationInvocation): Promise<void> {
    const pushed = await cold.execute(invocation);
    const fallback = await warm.execute(invocation);
    expect(pushed).toEqual(fallback);
    expect(await coldSnapshot.has_warm_records(scope(workspace.workspaceId))).toBe(false);
  }

  it("core:analyze_impact matches the full-corpus fallback for direct callers and covering tests", async () => {
    await expectDifferential(operation(workspace.workspaceId, "core:analyze_impact", ["will_break", "must_update", "may_be_affected", "tests_to_run", "uncertain_dynamic_usage"], {
      target: { subject_type: "entity", entity_id: callTarget.identity_id ?? callTarget.record_id },
      change: { change_kind: "signature_change" },
    }));
  });

  it("core:analyze_impact resolves an unresolvable target to empty streams, matching the fallback", async () => {
    await expectDifferential(operation(workspace.workspaceId, "core:analyze_impact", ["will_break", "must_update", "may_be_affected", "tests_to_run", "uncertain_dynamic_usage"], {
      target: { subject_type: "entity", entity_id: "entity:does-not-exist" },
      change: { change_kind: "signature_change" },
    }));
  });

  it("core:find_related_tests matches the full-corpus fallback via the containment-ancestor closure", async () => {
    await expectDifferential(operation(workspace.workspaceId, "core:find_related_tests", ["tests", "fixtures", "mocks", "helpers"], {
      subjects: [{ subject_type: "entity", entity_id: callTarget.identity_id ?? callTarget.record_id }],
    }));
  });

  it("core:find_related_tests matches the full-corpus fallback for a caller subject with no direct coverage", async () => {
    await expectDifferential(operation(workspace.workspaceId, "core:find_related_tests", ["tests", "fixtures", "mocks", "helpers"], {
      subjects: [{ subject_type: "entity", entity_id: caller.identity_id ?? caller.record_id }],
    }));
  });

  it("core:inspect_architecture matches the full-corpus fallback for entry points and public surfaces", async () => {
    await expectDifferential(operation(workspace.workspaceId, "core:inspect_architecture", ["entry_points", "boundaries", "public_surfaces", "cycles", "extension_points", "layers"], {
      views: ["entry_points", "public_surfaces"],
    }));
  });

  it("core:discover_definitions never reaches the full-corpus fallback", async () => {
    await expectDifferential(operation(workspace.workspaceId, "core:discover_definitions", ["definitions", "definition_set"], {
      matcher: { text: "core:call", mode: "exact" },
    }));
  });
});
