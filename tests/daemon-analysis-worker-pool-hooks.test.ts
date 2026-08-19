import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceRegistry } from "../packages/engine/src/index.js";
import { DaemonClient, DaemonRuntime, type DaemonRuntimeOptions } from "../packages/daemon/src/index.js";

// `@urdira/daemon` has no dependency on any production language plugin
// (AGENTS.md), so it never constructs or knows about an `AnalysisWorkerPool`
// (`apps/urdira/src/analysis-worker-pool.ts`) itself -- it only ever calls
// the two plain-function hooks `apps/urdira`'s `defaultDaemonOptions` binds
// to its own pool instance: `analysis_worker_pool_evict` on
// `core:workspace_remove`, `analysis_worker_pool_close_all` on `stop()`.
// This tests `packages/daemon/src/runtime.ts`'s wiring of those two hooks
// directly, independent of the real pool/worker -- no JS/TS plugin or real
// scan is needed since neither hook's call site depends on scan state.
function asDaemonWorkspaceRegistry(registry: WorkspaceRegistry): NonNullable<DaemonRuntimeOptions["workspace_registry"]> {
  return registry as unknown as NonNullable<DaemonRuntimeOptions["workspace_registry"]>;
}

describe("DaemonRuntimeOptions.analysis_worker_pool_evict / analysis_worker_pool_close_all wiring", () => {
  it("calls analysis_worker_pool_evict exactly once, with the removed workspace's id, on core:workspace_remove", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-worker-pool-evict-"));
    const evict = vi.fn(async (_workspaceId: string) => undefined);
    let runtime: DaemonRuntime | undefined;
    try {
      runtime = await DaemonRuntime.start({
        data_root: root,
        engine_build_id: "build-pool-evict",
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 2, client_quotas: {} },
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        analysis_worker_pool_evict: evict,
      });
      const client = new DaemonClient(runtime.endpoint);
      const added = await client.call("core:workspace_add", { args: [root], confirmed: false });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      expect(evict).not.toHaveBeenCalled();

      const removed = await client.call("core:workspace_remove", { args: [workspaceId] });
      expect(removed.outcome).toBe("success");

      expect(evict).toHaveBeenCalledTimes(1);
      expect(evict).toHaveBeenCalledWith(workspaceId);
    } finally {
      if (runtime) await runtime.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never calls analysis_worker_pool_evict when no workspace was removed (unset hook, no crash either)", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-worker-pool-evict-noop-"));
    let runtime: DaemonRuntime | undefined;
    try {
      runtime = await DaemonRuntime.start({
        data_root: root,
        engine_build_id: "build-pool-evict-noop",
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 2, client_quotas: {} },
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        // No `analysis_worker_pool_evict`/`analysis_worker_pool_close_all` at
        // all: today's byte-for-byte default behavior must not throw or
        // otherwise change just because these optional hooks are absent.
      });
      const client = new DaemonClient(runtime.endpoint);
      const status = await client.call("core:status", {});
      expect(status.outcome).toBe("success");
    } finally {
      if (runtime) await runtime.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("calls analysis_worker_pool_close_all exactly once on stop()", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-worker-pool-close-all-"));
    const closeAll = vi.fn(async () => undefined);
    const runtime = await DaemonRuntime.start({
      data_root: root,
      engine_build_id: "build-pool-close-all",
      scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 2, client_quotas: {} },
      analysis_worker_pool_close_all: closeAll,
    });
    try {
      expect(closeAll).not.toHaveBeenCalled();
    } finally {
      await runtime.stop();
      await rm(root, { recursive: true, force: true });
    }
    expect(closeAll).toHaveBeenCalledTimes(1);
  });
});
