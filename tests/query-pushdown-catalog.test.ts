import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CanonicalRecordQueryDataPort,
  NativeCanonicalQuerySnapshotPort,
  SqliteCanonicalQuerySnapshotPort,
  convertV3WorkspaceToNativeStore,
  loadNativeStructuralStoreAddon,
  type CanonicalQueryRecord,
  type OperationInvocation,
} from "../packages/engine/src/index.js";
import { buildTaskPlannerWorkspace, type PublishedTaskPlannerWorkspace } from "./support/task-planner-workspace.js";

let addonAvailable = true;
try {
  loadNativeStructuralStoreAddon();
} catch {
  addonAvailable = false;
}
const maybeDescribe = addonAvailable ? describe : describe.skip;
if (!addonAvailable) {
  console.warn("[query-pushdown-catalog.test] native addon not built; skipping the native-port analyze_impact scan-free proof. Run: node scripts/build-native.mjs");
}

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

  /**
   * Frente Q-4 (2026-09-08): decision 25's Q-3 amendment (§5.3 of
   * `docs/evidence/2026-09-08-v4-full-pushdown-catalog.md`) diagnosed
   * `core:analyze_impact`/`core:find_related_tests`'s real, measured
   * n8n/VS-Code-scale cost center precisely: `target`/`subjects`'s
   * `entity_id`-shaped selector resolves through `resolveIndexedGraphSelectors`
   * -> `records_by_ids`, and on the NATIVE port (the one this diagnosis and
   * `docs/evidence/2026-09-08-v4-identity-lookup-and-compare.md`'s own
   * measurement are both about) that fell into `scanAll(generation)` --
   * this file's own `cold`/`warm` harness above (`SqliteCanonicalQuery
   * SnapshotPort`) cannot exercise that at all: `SqliteCanonicalQuery
   * SnapshotPort.records_by_ids` already resolves every id form in O(1) via
   * its in-memory `by_any_id` map. This converts the SAME already-seeded
   * fixture (real `core:call` relation, real `source_id`/`target_id`) to a
   * native structural store and re-runs `core:analyze_impact` through
   * `NativeCanonicalQuerySnapshotPort`, spying on the native handle's
   * `iterVisibleBatch` (`scanAll`'s only FFI call) to prove the diagnosed
   * gap is closed, not just that `tests/native-query-snapshot-port.test.ts`'s
   * OWN synthetic fixture proves it.
   */
  (addonAvailable ? describe : describe.skip)("core:analyze_impact on the native structural store (decision 25 Q-3 diagnosis, closed by Q-4)", () => {
    it("resolves an entity_id-shaped target via the indexed identity lookup, never scanAll, matching the SQLite-port answer", async () => {
      const storeDir = await mkdtemp(join(tmpdir(), "urdira-query-pushdown-catalog-native-"));
      try {
        await convertV3WorkspaceToNativeStore(workspace.opened.database, workspace.workspaceId, 1, storeDir);
        const sqliteSnapshot = new SqliteCanonicalQuerySnapshotPort(workspace.opened.database);
        const nativeSqliteFallback = new SqliteCanonicalQuerySnapshotPort(workspace.opened.database);
        const addon = loadNativeStructuralStoreAddon();
        const iterVisibleBatchSpy = vi.spyOn(addon.NativeStructuralStoreHandle.prototype, "iterVisibleBatch");
        const nativeSnapshot = NativeCanonicalQuerySnapshotPort.open(workspace.opened.database, storeDir, nativeSqliteFallback);
        try {
          const invocation = operation(workspace.workspaceId, "core:analyze_impact", ["will_break", "must_update", "may_be_affected", "tests_to_run", "uncertain_dynamic_usage"], {
            target: { subject_type: "entity", entity_id: callTarget.identity_id ?? callTarget.record_id },
            change: { change_kind: "signature_change" },
          });
          const sqlitePort = new CanonicalRecordQueryDataPort(sqliteSnapshot);
          const nativePort = new CanonicalRecordQueryDataPort(nativeSnapshot);
          const sqliteResult = await sqlitePort.execute(invocation);
          const nativeResult = await nativePort.execute(invocation);
          expect((nativeResult.streams["will_break"] ?? []).length).toBeGreaterThan(0);
          expect(nativeResult.streams["will_break"]).toEqual(sqliteResult.streams["will_break"]);
          expect(iterVisibleBatchSpy).not.toHaveBeenCalled();
        } finally {
          iterVisibleBatchSpy.mockRestore();
        }
      } finally {
        await rm(storeDir, { recursive: true, force: true });
      }
    });
  });
});
