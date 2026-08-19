import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTaskPlannerWorkspace, taskPlannerQuery, type PublishedTaskPlannerWorkspace } from "./support/task-planner-workspace.js";

/**
 * End-to-end coverage (real publish pipeline, real SQLite-backed
 * `CanonicalRecordQueryDataPort`) for Bug Group 2.2 (symbol selectors),
 * Bug Group 3 (get_outline artifact/path containers + typed errors), and
 * Bug Group 4 (inbound `expand_relations` finding real callers, now that
 * the analyzer attributes module-top-level calls to the module entity).
 */
describe("symbol selectors, get_outline containers, and inbound expand_relations (Bug Groups 2/3/4)", () => {
  let workspace: PublishedTaskPlannerWorkspace;

  beforeAll(async () => {
    workspace = await buildTaskPlannerWorkspace("typescript");
  }, 60_000);

  afterAll(async () => {
    await workspace.close();
  });

  it("core:find_references resolves a bare {subject_type: symbol, name} selector directly, with no prior resolve_symbol call", async () => {
    const page = await workspace.engine.execute(taskPlannerQuery(workspace.workspaceId, "core:find_references", {
      target: { subject_type: "symbol", name: "TaskRepository" },
      include_declarations: false,
    }));
    expect(page.streams["references"]?.items.length ?? 0).toBeGreaterThan(0);
    const owners = (page.streams["owners"]?.items ?? []).map((entry) => (entry.value as { body?: { name?: string } }).body?.name);
    expect(owners).toContain("InMemoryTaskRepository");
  });

  it("core:get_source resolves a bare {subject_type: symbol, name} selector", async () => {
    const page = await workspace.engine.execute(taskPlannerQuery(workspace.workspaceId, "core:get_source", {
      subjects: [{ subject_type: "symbol", name: "TaskService" }],
      source: { mode: "signature", max_characters_per_snippet: 2000, max_total_characters: 20000, context_lines: 0 },
    }));
    expect(page.streams["sources"]?.items.length ?? 0).toBeGreaterThan(0);
  });

  it("core:get_outline resolves an artifact-by-path container to the owning module and lists its members", async () => {
    const page = await workspace.engine.execute(taskPlannerQuery(workspace.workspaceId, "core:get_outline", {
      // depth: 2 -- the module contains the TaskService class, which
      // contains these methods (a path-resolved container is the MODULE
      // entity, one level above the class the prior e2e test resolved via
      // resolve_symbol directly).
      container: { subject_type: "artifact", path: "src/services/task-service.ts" },
      depth: 2,
    }));
    const names = (page.streams["members"]?.items ?? []).map((entry) => (entry.value as { body?: { name?: string } }).body?.name);
    expect(names).toEqual(expect.arrayContaining(["createTask", "startTask", "completeTask", "getOpenTasks"]));
  });

  it("core:get_outline raises a typed selector error for an unresolvable container instead of a silent empty success", async () => {
    await expect(workspace.engine.execute(taskPlannerQuery(workspace.workspaceId, "core:get_outline", {
      container: { subject_type: "artifact", path: "src/does/not/exist.ts" },
      depth: 1,
    }))).rejects.toMatchObject({ code: "core:selector_not_found" });
  });

  it("inbound core:expand_relations from a callable finds its real callers, including the module-top-level call site fixed in Bug Group 4.1", async () => {
    const resolved = await workspace.engine.execute(taskPlannerQuery(workspace.workspaceId, "core:resolve_symbol", { reference: "createTask" }));
    const declaration = resolved.streams["declarations"]?.items[0]?.value as { entity_id: string } | undefined;
    expect(declaration).toBeDefined();
    const expanded = await workspace.engine.execute(taskPlannerQuery(workspace.workspaceId, "core:expand_relations", {
      subjects: [{ subject_type: "entity", entity_id: declaration!.entity_id }],
      direction: "inbound",
      relations: { universal_kinds: ["core:call"] },
      min_depth: 1,
      max_depth: 1,
    }));
    const callerNames = (expanded.streams["subjects"]?.items ?? []).map((entry) => (entry.value as { body?: { name?: string } }).body?.name);
    // `main.ts` calls `tasks.createTask(...)` at module top level -- before
    // Bug Group 4.1's fix this call site emitted no `core:call` relation at
    // all (no callable owner), so this caller was structurally invisible.
    expect(callerNames).toContain("src/main.ts");
  });

  it("multi-hop inbound core:expand_relations honors max_depth and populates paths when path_policy is set", async () => {
    const resolved = await workspace.engine.execute(taskPlannerQuery(workspace.workspaceId, "core:resolve_symbol", { reference: "findById" }));
    const declaration = resolved.streams["declarations"]?.items.find((entry) => (entry.value as { body?: { name?: string } }).body?.name === "findById")?.value as { entity_id: string } | undefined;
    expect(declaration).toBeDefined();
    const expanded = await workspace.engine.execute(taskPlannerQuery(workspace.workspaceId, "core:expand_relations", {
      subjects: [{ subject_type: "entity", entity_id: declaration!.entity_id }],
      direction: "inbound",
      relations: { universal_kinds: ["core:call"] },
      min_depth: 1,
      max_depth: 2,
      path_policy: "simple_subjects",
    }));
    const callerNames = (expanded.streams["subjects"]?.items ?? []).map((entry) => (entry.value as { body?: { name?: string } }).body?.name);
    // Depth 1: `transition` (TaskService) calls `repository.findById`.
    // Depth 2: `startTask`/`completeTask` call `transition`.
    expect(callerNames).toContain("transition");
    expect(callerNames).toEqual(expect.arrayContaining(["startTask", "completeTask"]));
    expect((expanded.streams["paths"]?.items.length ?? 0)).toBeGreaterThan(0);
  });
});
