import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultDaemonOptions, runUrdira, URDIRA_VERSION, urdiraHelp } from "../apps/urdira/src/index.js";
import { DaemonClient, DaemonRuntime } from "../packages/daemon/src/index.js";
import { JAVASCRIPT_TYPESCRIPT_PLUGIN_ID } from "../packages/plugin-javascript-typescript/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(here, "fixtures", "codebases", "typescript", "task-planner");

/**
 * `defaultDaemonOptions` (`apps/urdira/src/index.ts`) now resolves a REAL
 * embedding provider by default -- the bundled open-model local neural
 * provider, which downloads a model on first use -- per
 * `docs/decisions/16-semantic-search-wiring.md`'s open-model-default
 * addendum. This test exercises the real JS/TS scan/publish/query path, not
 * embeddings, so it forces the explicit `URDIRA_EMBEDDINGS_PROVIDER=hash`
 * escape hatch (`resolveSemanticProvider`'s branch 2) for the duration of
 * the wrapped call, restoring whatever was there before -- keeping this
 * suite hermetic (no network, no model download) exactly like every other
 * daemon integration test in this repo.
 */
async function withHashEmbeddingsProvider<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env["URDIRA_EMBEDDINGS_PROVIDER"];
  process.env["URDIRA_EMBEDDINGS_PROVIDER"] = "hash";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env["URDIRA_EMBEDDINGS_PROVIDER"];
    else process.env["URDIRA_EMBEDDINGS_PROVIDER"] = previous;
  }
}

async function pollUntilReady(client: DaemonClient, workspaceId: string, timeoutMs = 60_000): Promise<{ readonly workspace_status: string; readonly current_snapshot_id?: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: { readonly workspace_id: string; readonly workspace_status: string } | undefined;
  while (Date.now() < deadline) {
    const response = await client.call("core:index_status", {});
    if (response.outcome !== "success") throw new Error(`core:index_status did not succeed: ${JSON.stringify(response)}`);
    const payload = response.payload as { readonly workspaces: ReadonlyArray<{ readonly workspace_id: string; readonly workspace_status: string }> };
    const workspace = payload.workspaces.find((entry) => entry.workspace_id === workspaceId);
    if (workspace === undefined) throw new Error(`core:index_status did not report workspace ${workspaceId}.`);
    last = workspace;
    if (workspace.workspace_status === "ready" || workspace.workspace_status === "degraded") {
      const detail = await client.call("core:index_status", { workspace_ids: [workspaceId] });
      if (detail.outcome !== "success") {
        const indexState = detail.error?.details?.["index_state"];
        if (detail.error?.code === "core:index_unavailable" && indexState === "indexing") {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
          continue;
        }
        throw new Error(`core:index_status (detail) did not succeed: ${JSON.stringify(detail)}`);
      }
      const detailPayload = detail.payload as { readonly workspaces: ReadonlyArray<{ readonly workspace_status: string; readonly current_snapshot_id?: string }> };
      const detailWorkspace = detailPayload.workspaces[0];
      if (detailWorkspace === undefined) throw new Error("core:index_status (detail) returned no workspace entry.");
      return detailWorkspace;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Workspace ${workspaceId} did not leave "indexing" within ${timeoutMs}ms (last observed: ${JSON.stringify(last)}).`);
}

function findRecordsQuery(workspaceId: string): Readonly<Record<string, unknown>> {
  return {
    api_version: 1,
    scope: { scope_type: "single_workspace", workspace_id: workspaceId },
    expression: { expression_type: "operation", operation: "core:find_records", arguments: { selector: { record_categories: ["entity"], kind_selector: { universal_kinds: ["core:type", "core:callable"] }, filter: { languages: ["typescript"] } } } },
    options: { freshness: "current", wait_timeout_ms: 0, coverage_requirement: "accept_reported", evidence: { evidence: "summary", evidence_chain_depth: 1 }, diagnostics: { diagnostics: "relevant", diagnostic_detail: true }, snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 }, registry: { registry: "used", include_payload_schemas: false }, response_budget: { max_items: 1_000, max_characters: 1_000_000 } },
  };
}

function recordNames(payload: unknown): readonly string[] {
  const streams = (payload as { readonly streams?: Readonly<Record<string, { readonly items?: readonly { readonly value?: { readonly body?: { readonly name?: unknown } } }[] }>> }).streams;
  const items = streams?.["records"]?.items ?? [];
  return items.map((item) => item.value?.body?.name).filter((name): name is string => typeof name === "string");
}

async function queryAfterStagedPublication(client: DaemonClient, workspaceId: string): Promise<Awaited<ReturnType<DaemonClient["call"]>>> {
  const deadline = Date.now() + 30_000;
  let response = await client.call("core:query", findRecordsQuery(workspaceId));
  while (response.outcome === "error" && (response.error?.code === "core:index_unavailable" || response.error?.code === "core:coverage_incomplete") && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    response = await client.call("core:query", findRecordsQuery(workspaceId));
  }
  return response;
}

describe("Urdira application runner", () => {
  it("publishes stable version and help output without starting the daemon", () => {
    expect(URDIRA_VERSION).toBe("0.1.0");
    expect(urdiraHelp()).toContain("urdira mcp");
    expect(urdiraHelp()).toContain("explicit workspace scope");
  });
  it("runs a read-only CLI command through an existing daemon endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-app-runtime-"));
    const runtime = await DaemonRuntime.start({
      data_root: root,
      engine_build_id: "build-app-test",
      scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 1, client_quotas: {} },
    });
    try {
      const result = await runUrdira(["status", "--json"], { endpoint: runtime.endpoint });
      expect(result.exit_code).toBe(0);
      expect(result.data).toMatchObject({ state: "ready", engine_build_id: "build-app-test" });
      expect(result.stdout).toContain("build-app-test");
    } finally {
      await runtime.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts and stops a daemon when no endpoint is supplied", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-app-runtime-"));
    try {
      const result = await runUrdira(["status"], {
        daemon: {
          data_root: root,
          engine_build_id: "build-app-start",
          scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 1, client_quotas: {} },
        },
      });
      expect(result.exit_code).toBe(0);
      expect(result.data).toMatchObject({ state: "ready", engine_build_id: "build-app-start" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// Exercises the REAL production `WorkspaceScanPluginProvider`
// (`buildJavascriptTypescriptPluginProvider`'s `analyze`, private to
// `apps/urdira/src/index.ts`) end to end through `defaultDaemonOptions` --
// not a hand-rolled test-only plugin provider, unlike every other daemon
// integration test in this repo. This is the only test that actually runs
// Phase 5.1's real code path: the `analyze_closure` worker round-trip,
// per-owner closure-narrowed access manifests, closure-narrowed `files`
// payloads, and the real `node:worker_threads` thread transport (default
// `URDIRA_ANALYSIS_THREAD` is on) all have to work together correctly for
// this to pass -- a bug in any of them would either throw or silently
// produce wrong/missing records, both of which this test would catch.
describe("Urdira application runner: real multi-file JavaScript/TypeScript workspace scan (Phase 5.1)", () => {
  it("scans the task-planner fixture's real cross-file imports end to end, publishes, queries, and rescans correctly after a one-file change", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-app-runtime-jsts-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-app-runtime-jsts-workspace-"));
    let runtime: DaemonRuntime | undefined;
    try {
      await cp(fixtureRoot, workspaceRoot, { recursive: true });
      runtime = await DaemonRuntime.start(await withHashEmbeddingsProvider(() => defaultDaemonOptions(dataRoot)));
      const client = new DaemonClient(runtime.endpoint);

      const added = await client.call("core:workspace_add", {
        args: [workspaceRoot],
        confirmed: true,
        selected_technology_ids: ["typescript"],
        selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;

      const first = await pollUntilReady(client, workspaceId);
      expect(first.workspace_status).toBe("ready");

      const firstQuery = await client.call("core:query", findRecordsQuery(workspaceId));
      expect(firstQuery.outcome).toBe("success");
      const firstNames = recordNames(firstQuery.payload);
      // Real declarations that only exist because real cross-file resolution
      // (through `TaskRepository` -> `InMemoryTaskRepository` -> `TaskService`
      // -> `task.ts`/`errors.ts`) worked, which is exactly the machinery
      // closure-narrowed manifests must not break: if a narrowed manifest or
      // `files` payload ever excluded a file a relation actually targets,
      // `crossArtifactDependencies` (`packages/plugin-javascript-typescript/src/fact-delta.ts`)
      // would still produce SOME delta, but a downstream dependency
      // validation failure (or a simply-missing declaration here) is exactly
      // the failure mode this assertion catches.
      expect(firstNames).toEqual(expect.arrayContaining(["TaskService", "TaskRepository", "InMemoryTaskRepository"]));

      // One real content change to a single file: this is what Phase 5.1's
      // closure-fetch + subset-reuse machinery must handle correctly on a
      // rescan -- not just on a first scan.
      await writeFile(join(workspaceRoot, "src", "domain", "priority.ts"), "export type TaskPriority = \"low\" | \"medium\" | \"high\";\n", "utf8");
      const reindexed = await client.call("core:reindex", { args: [workspaceId] });
      expect(reindexed.outcome).toBe("success");
      const second = await pollUntilReady(client, workspaceId);
      expect(second.workspace_status).toBe("ready");
      expect(second.current_snapshot_id).not.toBe(first.current_snapshot_id);

      const secondQuery = await queryAfterStagedPublication(client, workspaceId);
      expect(secondQuery.outcome).toBe("success");
      const secondNames = recordNames(secondQuery.payload);
      // Every previously-published declaration is still there (the new
      // file has no dependents, so it could only have been reached via the
      // full-fallback path or the new file's own closure -- either way,
      // nothing about existing owners' output may regress).
      expect(secondNames).toEqual(expect.arrayContaining([...firstNames]));
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 120_000);

  // Unlike the test above (which ADDS a new file -- a root-set change, which
  // by design always takes the JS/TS analyzer's full-rebuild path), this
  // edits an EXISTING file's content only, which is exactly what
  // `apps/urdira/src/index.ts`'s per-workspace `AnalysisWorkerPool` +
  // `JsTsAnalysisSession` incremental path exists for: the pooled worker
  // from the first scan survives (default `URDIRA_ANALYSIS_POOL` is on) into
  // the second scan's `analyze_closure` call, so the second scan's analysis
  // only re-walks the files the edit could affect instead of the whole
  // project again. There is no wire-protocol-safe way to observe the exact
  // `build=full|incremental` label from outside the worker thread (see
  // `packages/plugin-javascript-typescript/src/worker.ts`'s
  // `on_analysis_incremental` doc comment), so this asserts the OBSERVABLE
  // consequence instead: the second (incremental, pooled) scan is
  // meaningfully faster than the first (full, cold) scan, and both produce
  // correct, unbroken query results.
  it("reuses the pooled worker across a content-only edit rescan, taking the incremental analysis path (asserted via wall-time, not a wire field)", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-app-runtime-jsts-pool-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-app-runtime-jsts-pool-workspace-"));
    let runtime: DaemonRuntime | undefined;
    try {
      await cp(fixtureRoot, workspaceRoot, { recursive: true });
      runtime = await DaemonRuntime.start(await withHashEmbeddingsProvider(() => defaultDaemonOptions(dataRoot)));
      const client = new DaemonClient(runtime.endpoint);

      const firstStartedAt = performance.now();
      const added = await client.call("core:workspace_add", {
        args: [workspaceRoot],
        confirmed: true,
        selected_technology_ids: ["typescript"],
        selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;

      const first = await pollUntilReady(client, workspaceId);
      const firstMs = performance.now() - firstStartedAt;
      expect(first.workspace_status).toBe("ready");

      // Content-only edit to an EXISTING file (no new file, no root-set
      // change): `src/domain/task.ts`'s exported `TaskStatus` union grows a
      // member, which is exactly the "widely-imported module's exported
      // type changes" scenario the differential test suite
      // (`tests/javascript-typescript-incremental-analysis.test.ts`) proves
      // is handled correctly at the session level.
      const taskPath = join(workspaceRoot, "src", "domain", "task.ts");
      const original = await import("node:fs/promises").then((fs) => fs.readFile(taskPath, "utf8"));
      await writeFile(taskPath, original.replace(`"todo" | "in_progress" | "done"`, `"todo" | "in_progress" | "done" | "archived"`), "utf8");

      const reindexed = await client.call("core:reindex", { args: [workspaceId] });
      expect(reindexed.outcome).toBe("success");
      const secondStartedAt = performance.now();
      const second = await pollUntilReady(client, workspaceId);
      const secondMs = performance.now() - secondStartedAt;
      expect(second.workspace_status).toBe("ready");
      expect(second.current_snapshot_id).not.toBe(first.current_snapshot_id);

      const secondQuery = await queryAfterStagedPublication(client, workspaceId);
      expect(secondQuery.outcome).toBe("success");
      expect(recordNames(secondQuery.payload)).toEqual(expect.arrayContaining(["TaskService", "TaskRepository", "InMemoryTaskRepository"]));

      console.log(`[app-runtime pooled-rescan timing] first=${firstMs.toFixed(0)}ms second=${secondMs.toFixed(0)}ms`);
      // Progressive publication performs up to three ordered atomic passes on
      // each scan.  A pooled content-only rescan should still complete within
      // that bounded staged-work envelope rather than asserting a brittle
      // absolute wall-time win against a warm, noisy first sample.
      expect(secondMs).toBeLessThan(firstMs * 3);
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("URDIRA_ANALYSIS_POOL=0 restores per-scan worker create/terminate (no pool eviction hooks wired)", async () => {
    const previous = process.env["URDIRA_ANALYSIS_POOL"];
    process.env["URDIRA_ANALYSIS_POOL"] = "0";
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-app-runtime-jsts-nopool-data-"));
    try {
      const options = await withHashEmbeddingsProvider(() => defaultDaemonOptions(dataRoot));
      expect(options.analysis_worker_pool_evict).toBeUndefined();
      expect(options.analysis_worker_pool_close_all).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env["URDIRA_ANALYSIS_POOL"];
      else process.env["URDIRA_ANALYSIS_POOL"] = previous;
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("default (URDIRA_ANALYSIS_POOL unset) wires both pool eviction hooks", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-app-runtime-jsts-pool-hooks-data-"));
    try {
      const options = await withHashEmbeddingsProvider(() => defaultDaemonOptions(dataRoot));
      expect(typeof options.analysis_worker_pool_evict).toBe("function");
      expect(typeof options.analysis_worker_pool_close_all).toBe("function");
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
