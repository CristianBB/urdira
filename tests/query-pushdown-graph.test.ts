import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CanonicalRecordQueryDataPort,
  SqliteCanonicalQuerySnapshotPort,
  expandRelations,
  findShortestPaths,
  type CanonicalQueryRecord,
  type OperationInvocation,
  type RelationEdge,
} from "../packages/engine/src/index.js";
import { buildTaskPlannerWorkspace, type PublishedTaskPlannerWorkspace } from "./support/task-planner-workspace.js";

const scope = (workspaceId: string) => ({ scope_type: "single_workspace" as const, workspace_id: workspaceId });

function operation(workspaceId: string, operationId: string, resultStreams: readonly string[], args: Readonly<Record<string, unknown>>): OperationInvocation {
  return { operation_id: operationId, result_streams: resultStreams, arguments: args, scope: scope(workspaceId) };
}

function aliases(record: CanonicalQueryRecord): readonly string[] {
  return [record.record_id, record.identity_id, record.identity_key].filter((value): value is string => value !== undefined);
}

describe("indexed graph query pushdown", () => {
  let workspace: PublishedTaskPlannerWorkspace;
  let cold: CanonicalRecordQueryDataPort;
  let warm: CanonicalRecordQueryDataPort;
  let coldSnapshot: SqliteCanonicalQuerySnapshotPort;
  let records: readonly CanonicalQueryRecord[];

  beforeAll(async () => {
    workspace = await buildTaskPlannerWorkspace("typescript");
    const seedSnapshot = new SqliteCanonicalQuerySnapshotPort(workspace.opened.database);
    records = await seedSnapshot.records(scope(workspace.workspaceId));
    for (const relation of records.filter((record) => record.category === "relation")) {
      const source = relation.body["source_id"];
      const target = relation.body["target_id"];
      if (typeof source !== "string" || typeof target !== "string") continue;
      await workspace.opened.projections.putGraphEdge({
        edge_id: `query-pushdown:${relation.record_id}`,
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
    coldSnapshot = new SqliteCanonicalQuerySnapshotPort(workspace.opened.database);
    const warmSnapshot = new SqliteCanonicalQuerySnapshotPort(workspace.opened.database);
    Object.assign(coldSnapshot, {
      records_for_query: async () => { throw new Error("graph pushdown performed a full record scan"); },
      records_for_query_batches: async function* () { throw new Error("graph pushdown performed a batched full record scan"); },
      records: async () => { throw new Error("graph pushdown populated the warm record cache"); },
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

  it("matches the fallback for outline and direct references", async () => {
    await expectDifferential(operation(workspace.workspaceId, "core:get_outline", ["members"], {
      container: { subject_type: "artifact", path: "src/services/task-service.ts" },
      depth: 2,
      include_non_public: true,
    }));
    await expectDifferential(operation(workspace.workspaceId, "core:find_references", ["references", "owners"], {
      target: { subject_type: "symbol", name: "TaskRepository" },
      include_declarations: false,
    }));
  });

  it("matches the fallback for direction, depth, expansion paths, and shortest paths", async () => {
    const byName = new Map(records.filter((record) => record.category === "entity").map((record) => [record.body["name"], record]));
    const findById = byName.get("findById");
    const startTask = byName.get("startTask");
    const save = records.find((record) => record.category === "entity" && record.body["name"] === "save" && String(record.body["path"] ?? "").includes("task-repository"));
    expect(findById).toBeDefined();
    expect(startTask).toBeDefined();
    expect(save).toBeDefined();
    await expectDifferential(operation(workspace.workspaceId, "core:expand_relations", ["subjects", "relations", "paths"], {
      subjects: [{ subject_type: "entity", entity_id: findById!.identity_id ?? aliases(findById!)[0] }],
      direction: "inbound",
      relations: { universal_kinds: ["core:call"] },
      min_depth: 1,
      max_depth: 2,
      path_policy: "simple_subjects",
    }));
    await expectDifferential(operation(workspace.workspaceId, "core:find_paths", ["paths"], {
      sources: [{ subject_type: "entity", entity_id: startTask!.identity_id ?? aliases(startTask!)[0] }],
      targets: [{ subject_type: "entity", entity_id: save!.identity_id ?? aliases(save!)[0] }],
      direction: "outbound",
      relations: { universal_kinds: ["core:call"] },
      max_depth: 2,
      all_shortest: true,
    }));
  });
});

describe("indexed traversal edge cases", () => {
  const edges: readonly RelationEdge[] = [
    { source: "a", target: "a", relation_kind: "self", classification: "confirmed", stable_sort_key: "00-self" },
    { source: "a", target: "b", relation_kind: "call", classification: "confirmed", stable_sort_key: "01-ab" },
    { source: "a", target: "b", relation_kind: "possible-call", classification: "possible", stable_sort_key: "02-ab" },
    { source: "b", target: "c", relation_kind: "call", classification: "confirmed", stable_sort_key: "03-bc" },
    { source: "c", target: "a", relation_kind: "call", classification: "confirmed", stable_sort_key: "04-ca" },
    { source: "d", target: "b", relation_kind: "call", classification: "confirmed", stable_sort_key: "05-db" },
  ];

  it("handles self-loops, cycles, multi-edges, direction, and depth deterministically", () => {
    expect(expandRelations(edges, ["a"], { direction: "outbound", min_depth: 1, max_depth: 3 }).map(({ subject, depth, relation_kind }) => ({ subject, depth, relation_kind }))).toEqual([
      { subject: "b", depth: 1, relation_kind: "call" },
      { subject: "c", depth: 2, relation_kind: "call" },
    ]);
    expect(expandRelations(edges, ["b"], { direction: "inbound", min_depth: 1, max_depth: 1 }).map(({ subject }) => subject)).toEqual(["a", "d"]);
    expect(expandRelations(edges, ["b"], { direction: "both", min_depth: 1, max_depth: 1 }).map(({ subject }) => subject)).toEqual(["a", "c", "d"]);
  });

  it("returns every deterministic shortest path without revisiting a cycle", () => {
    const paths = findShortestPaths([
      ...edges,
      { source: "a", target: "e", relation_kind: "call", classification: "confirmed", stable_sort_key: "06-ae" },
      { source: "e", target: "c", relation_kind: "call", classification: "confirmed", stable_sort_key: "07-ec" },
    ], ["a"], ["c"], { direction: "outbound", max_depth: 4, all_shortest: true });
    expect(paths.map((path) => path.subjects)).toEqual([["a", "b", "c"], ["a", "b", "c"], ["a", "e", "c"]]);
    expect(paths.map((path) => path.classification)).toEqual(["confirmed", "possible", "confirmed"]);
  });
});
