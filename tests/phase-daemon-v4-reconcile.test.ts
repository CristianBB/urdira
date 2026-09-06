import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceRegistry, type RustWorkspaceScanTransport, type WorkspaceScanRequest } from "../packages/engine/src/index.js";
import { DaemonClient, DaemonRuntime, type DaemonRuntimeOptions } from "../packages/daemon/src/index.js";

/**
 * Frente E (plan `generic-waddling-hartmanis.md` §2.4): daemon wiring for
 * `ScanScope::Reconcile` -- the scope decision in `runV4WorkspaceScan`
 * (`packages/daemon/src/runtime.ts`, ~L2170): a scan whose caller has no
 * concrete URI list (`requestedUris === undefined`) now defaults to
 * `reconcile` instead of unconditionally `full`, UNLESS the workspace is
 * on its first-ever scan or `forceFullScans` names it (populated by
 * `core:reindex` and the outdated-workspace-format recovery sweep).
 *
 * Sibling to `tests/phase-daemon-v4-scan.test.ts` (same hermetic pattern:
 * a fake `RustWorkspaceScanTransport`, no real Rust worker process) rather
 * than an addition to that file, per this front's own test-family naming.
 *
 * Test 1 below exercises the scope decision via the periodic reconciliation
 * sweep (`DaemonRuntimeOptions.reconciliation_sweep_interval_ms`), not a
 * literal git branch switch -- **decided in implementation**: a real
 * `branch_changed` event requires the workspace to be registered under
 * `core:git_worktree_source_provider` (a plain `core:workspace_add` directory
 * workspace has `.git/**` EXCLUDED from its watch, `watchers.ts::
 * watcherOptionsForSourceProvider`'s own filter) and a real `@parcel/watcher`
 * subscription picking up an actual `git checkout` -- a much heavier,
 * flakier integration test for exactly the same code path this test already
 * exercises hermetically: the sweep calls the IDENTICAL `scheduleWorkspaceScan
 * (id, undefined, [], ...)` shape `watchers.ts`'s `branch_changed`/
 * `events_lost`/`provider_reset` handling also produces (`runtime.ts`'s own
 * diagnostic comment: "siempre con changedUris === undefined") and reaches
 * the SAME scope-decision branch in `runV4WorkspaceScan`. Fidelity to the
 * scope decision itself, not to the literal trigger, is what this test
 * needs to prove.
 */

function asDaemonWorkspaceRegistry(registry: WorkspaceRegistry): NonNullable<DaemonRuntimeOptions["workspace_registry"]> {
  return registry as unknown as NonNullable<DaemonRuntimeOptions["workspace_registry"]>;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function pollUntil(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition did not become true within ${timeoutMs} ms.`);
    await sleep(25);
  }
}

interface IndexStatusWorkspaceView {
  readonly workspace_id: string;
  readonly workspace_status: string;
  readonly structural_ready?: boolean;
  readonly last_scan?: {
    readonly kind?: "full" | "changed" | "reconcile";
    readonly changed_paths?: number;
    readonly reconcile?: {
      readonly mode: "noop" | "delta" | "cold";
      readonly added: number;
      readonly changed: number;
      readonly deleted: number;
      readonly frontier_size: number;
      readonly threshold: number;
      readonly fell_back_to_cold: boolean;
      readonly metadata_refreshed: number;
    };
  };
}

async function fetchIndexStatus(client: DaemonClient, workspaceId: string): Promise<IndexStatusWorkspaceView> {
  const response = await client.call("core:index_status", { workspace_ids: [workspaceId] });
  if (response.outcome !== "success") throw new Error(`core:index_status did not succeed: ${JSON.stringify(response)}`);
  const payload = response.payload as { readonly workspaces: readonly IndexStatusWorkspaceView[] };
  const workspace = payload.workspaces[0];
  if (workspace === undefined) throw new Error(`core:index_status reported no workspace for ${workspaceId}.`);
  return workspace;
}

async function pollUntilStructuralReady(client: DaemonClient, workspaceId: string, timeoutMs = 20_000): Promise<IndexStatusWorkspaceView> {
  const deadline = Date.now() + timeoutMs;
  let last: IndexStatusWorkspaceView | undefined;
  while (Date.now() < deadline) {
    last = await fetchIndexStatus(client, workspaceId);
    if (last.structural_ready === true) return last;
    await sleep(50);
  }
  throw new Error(`Workspace ${workspaceId} did not reach structural_ready within ${timeoutMs}ms (last observed: ${JSON.stringify(last)}).`);
}

/**
 * Minimal fake transport for this file's two tests: `full` and `reconcile`
 * always succeed (each request carries its own generation counter, exactly
 * like `phase-daemon-v4-scan.test.ts`'s own `createFakeV4Transport`); a
 * `reconcile` success reports a synthetic `ReconcileSummary` (`mode:
 * "delta"`) so `last_scan.reconcile` has something real to assert on.
 * `changed` is not exercised by this file at all -- rejected outright, so a
 * bug that accidentally routes a scan through `changed` instead of
 * `reconcile` fails loudly rather than silently succeeding.
 */
class FakeTransportState {
  readonly calls: WorkspaceScanRequest[] = [];
  generation = 0;
}

function createFakeV4Transport(state: FakeTransportState): RustWorkspaceScanTransport {
  return {
    workspaceScan: async (request, onQueryable) => {
      state.calls.push(request);
      if (request.scope.kind === "changed") {
        return { kind: "error", code: "core:workspace_scan_failed", message: "not supported by this fake transport" };
      }
      state.generation += 1;
      const generation = state.generation;
      onQueryable?.({ generation, manifest_path: join(request.structural_root, "MANIFEST"), timings: { total_ms: 1 } });
      const hex = (byte: string): string => byte.repeat(64);
      return {
        kind: "scan_completed",
        request_id: `request:fake:${generation}`,
        generation,
        snapshot_id: `snapshot:fake:${generation}`,
        roots: { records: `sha256:${hex("a")}`, dependency: `sha256:${hex("b")}`, graph: `sha256:${hex("c")}`, metric: `sha256:${hex("d")}` },
        timings: { total_ms: 2 },
        ...(request.scope.kind === "reconcile"
          ? { reconcile: { mode: "delta" as const, added: 1, changed: 0, deleted: 0, frontier_size: 3, threshold: 0.25, fell_back_to_cold: false, metadata_refreshed: 0 } }
          : {}),
      };
    },
  };
}

interface V4Daemon {
  readonly runtime: DaemonRuntime;
  readonly client: DaemonClient;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly dataRoot: string;
  readonly transportState: FakeTransportState;
}

async function startV4Daemon(overrides: Partial<DaemonRuntimeOptions> = {}): Promise<V4Daemon> {
  const dataRoot = await mkdtemp(join(tmpdir(), "urdira-v4-reconcile-data-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-v4-reconcile-workspace-"));
  await writeFile(join(workspaceRoot, "seed.ts"), "export const seed = 1;\n", "utf8");
  const transportState = new FakeTransportState();
  const runtime = await DaemonRuntime.start({
    data_root: dataRoot,
    engine_build_id: "build-v4-daemon-reconcile",
    workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
    resolve_plugin_provider: async () => { throw new Error("resolve_plugin_provider must not be called for a v4 workspace."); },
    resolve_workspace_scan_transport: async () => createFakeV4Transport(transportState),
    semantic_index: false,
    reconciliation_sweep_interval_ms: 0,
    scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
    ...overrides,
  });
  const client = new DaemonClient(runtime.endpoint, { request_timeout_ms: 120_000 });
  const added = await client.call("core:workspace_add", { args: [workspaceRoot], confirmed: true });
  expect(added.outcome).toBe("success");
  const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
  return { runtime, client, workspaceId, workspaceRoot, dataRoot, transportState };
}

async function stopV4Daemon(daemon: V4Daemon): Promise<void> {
  await daemon.runtime.stop().catch(() => undefined);
  await rm(daemon.dataRoot, { recursive: true, force: true });
  await rm(daemon.workspaceRoot, { recursive: true, force: true });
}

describe("Daemon v4 ScanScope::Reconcile wiring (Frente E)", () => {
  const originalFlag = process.env["URDIRA_V4"];
  afterEach(() => {
    if (originalFlag === undefined) delete process.env["URDIRA_V4"];
    else process.env["URDIRA_V4"] = originalFlag;
  });

  it("an 'unknown extent of change' scan on an already-ready workspace (requestedUris === undefined) sends scope: reconcile, and core:index_status.last_scan reflects it", async () => {
    process.env["URDIRA_V4"] = "1";
    // Small interval so the periodic reconciliation sweep fires quickly --
    // see this file's own module doc for why the sweep (not a literal git
    // branch switch) is used to reach the `requestedUris === undefined`
    // scope-decision branch hermetically.
    const daemon = await startV4Daemon({ reconciliation_sweep_interval_ms: 50 });
    try {
      await pollUntilStructuralReady(daemon.client, daemon.workspaceId);
      expect(daemon.transportState.calls).toHaveLength(1);
      expect(daemon.transportState.calls[0]?.scope).toEqual({ kind: "full" });

      await pollUntil(() => daemon.transportState.calls.length >= 2, 20_000);
      expect(daemon.transportState.calls[1]?.scope).toEqual({ kind: "reconcile" });

      const status = await pollUntilStructuralReady(daemon.client, daemon.workspaceId);
      expect(status.last_scan?.kind).toBe("reconcile");
      expect(status.last_scan?.reconcile).toEqual({ mode: "delta", added: 1, changed: 0, deleted: 0, frontier_size: 3, threshold: 0.25, fell_back_to_cold: false, metadata_refreshed: 0 });
    } finally {
      await stopV4Daemon(daemon);
    }
  }, 30_000);

  it("core:reindex still sends scope: full, even though the workspace is already ready", async () => {
    process.env["URDIRA_V4"] = "1";
    const daemon = await startV4Daemon();
    try {
      await pollUntilStructuralReady(daemon.client, daemon.workspaceId);
      expect(daemon.transportState.calls).toHaveLength(1);
      expect(daemon.transportState.calls[0]?.scope).toEqual({ kind: "full" });

      const reindexed = await daemon.client.call("core:reindex", { args: [daemon.workspaceId] });
      expect(reindexed.outcome).toBe("success");

      await pollUntil(() => daemon.transportState.calls.length >= 2, 20_000);
      expect(daemon.transportState.calls[1]?.scope).toEqual({ kind: "full" });

      const status = await pollUntilStructuralReady(daemon.client, daemon.workspaceId);
      expect(status.last_scan?.kind).toBe("full");
    } finally {
      await stopV4Daemon(daemon);
    }
  }, 30_000);
});
