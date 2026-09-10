import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeCanonical } from "../packages/canonical/src/index.js";
import { WorkspaceRegistry, sidecarDatabasePathFor, sidecarScanDirFor, structuralStoreDirFor, type RustWorkspaceScanTransport, type WorkspaceScanRequest } from "../packages/engine/src/index.js";
import { DaemonClient, DaemonRuntime, type DaemonRuntimeOptions } from "../packages/daemon/src/index.js";
import { createDurableStorage, openSqliteDatabase, readStructuralStore } from "../packages/storage/src/index.js";

/**
 * Coverage for task P2-7 (plan `resilient-knitting-twilight.md` §1/§9):
 * daemon wiring for the `URDIRA_V4=1` route -- `ensureV4Workspace`
 * (`packages/engine/src/workspace-v4-bootstrap.ts`), `scheduleWorkspaceScan`'s
 * v4 branch and `runV4WorkspaceScan` (`packages/daemon/src/runtime.ts`), and
 * the v4 readiness/`core:index_status` surface (`v4WorkspaceReadinessFrom`,
 * `readinessPayload`'s `structural_durable`/`queryable_generation`/
 * `durable_generation`/`lexical.completed_generation` additions).
 *
 * Uses a FAKE `RustWorkspaceScanTransport` (no real Rust worker process, no
 * cargo build) -- this file is the fast, hermetic unit-level coverage for
 * the daemon's OWN wiring logic; `tests/v4-daemon-e2e.test.ts` is the
 * complementary end-to-end test against the real worker binary.
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
  readonly structural_durable?: boolean;
  readonly readiness?: {
    readonly structural?: { readonly queryable_generation?: number; readonly durable_generation?: number };
    readonly lexical?: { readonly completed_generation?: number };
  };
  // P4-d (plan §9, user-facing status surfaces): `v4StatusFields`'s
  // additive top-level fields (`packages/daemon/src/runtime.ts`).
  readonly storage_format?: "v3" | "v4";
  readonly structural?: { readonly queryable_generation?: number; readonly durable_generation?: number; readonly queryable?: boolean };
  readonly lexical?: { readonly completed_generation?: number; readonly current?: boolean };
  readonly semantic?: { readonly completed_generation?: number; readonly current?: boolean; readonly profile_id?: string };
  // P1-D-c (decision 28): the background residual tsgo pass's own lane.
  readonly semantic_upgrade?: { readonly completed_generation?: number; readonly pending_sites?: number; readonly running: boolean };
  readonly last_scan?: { readonly kind?: "full" | "changed"; readonly changed_paths?: number; readonly timings?: { readonly total_ms?: number }; readonly timeline?: Readonly<Record<string, number>> };
  readonly search_text_ready?: boolean;
  readonly search_semantic_ready?: boolean;
  readonly calls_upgraded?: boolean;
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

/** Records every `workspace_scan` request the daemon sends, and controls whether `ScanScope::Changed` succeeds. P3-1 landed the real incremental path server-side (`crates/urdira-indexing-worker/src/v4/delta.rs`); the ONE legitimate rejection left is "no prior generation cached for this workspace" (`supportsChanged = false` mirrors exactly that, and its rejection message here is byte-identical to `delta::run`'s real one). */
class FakeTransportState {
  readonly calls: WorkspaceScanRequest[] = [];
  readonly requestIds: string[] = [];
  supportsChanged = false;
  generation = 0;
  // P1-D-c: registered by `runtime.ts`'s own subscription (via
  // `onUpgradeCompleted`) the first time this fake transport is handed to
  // it -- a test calls `emitUpgradeCompleted` to simulate the Rust
  // worker's asynchronous residual-pass completion arriving on this same
  // transport, without needing a real tsgo binary or structural store.
  readonly upgradeHandlers = new Set<(event: { readonly request_id: string; readonly generation: number; readonly upgraded_sites: number; readonly external_sites: number; readonly unresolved_sites: number; readonly timings: { readonly total_ms: number } }) => void>();

  emitUpgradeCompleted(event: { readonly request_id: string; readonly generation: number; readonly upgraded_sites: number; readonly external_sites: number; readonly unresolved_sites: number; readonly timings: { readonly total_ms: number } }): void {
    for (const handler of this.upgradeHandlers) handler(event);
  }
}

function createFakeV4Transport(state: FakeTransportState): RustWorkspaceScanTransport {
  return {
    onUpgradeCompleted: (handler) => {
      state.upgradeHandlers.add(handler);
      return () => state.upgradeHandlers.delete(handler);
    },
    workspaceScan: async (request, onQueryable) => {
      state.calls.push(request);
      if (request.scope.kind === "changed" && !state.supportsChanged) {
        return {
          kind: "error",
          code: "core:workspace_scan_failed",
          message: "v4 WorkspaceScan{scope: Changed} requires a prior generation; send scope: Full for a new workspace",
        };
      }
      state.generation += 1;
      const generation = state.generation;
      onQueryable?.({ generation, manifest_path: join(request.structural_root, "MANIFEST"), timings: { total_ms: 1 } });
      const hex = (byte: string): string => byte.repeat(64);
      const requestId = `request:fake:${generation}`;
      state.requestIds.push(requestId);
      return {
        kind: "scan_completed",
        request_id: requestId,
        generation,
        snapshot_id: `snapshot:fake:${generation}`,
        roots: { records: `sha256:${hex("a")}`, dependency: `sha256:${hex("b")}`, graph: `sha256:${hex("c")}`, metric: `sha256:${hex("d")}` },
        timings: { total_ms: 2 },
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
  const dataRoot = await mkdtemp(join(tmpdir(), "urdira-v4-scan-data-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-v4-scan-workspace-"));
  await writeFile(join(workspaceRoot, "seed.ts"), "export const seed = 1;\n", "utf8");
  const transportState = new FakeTransportState();
  const runtime = await DaemonRuntime.start({
    data_root: dataRoot,
    engine_build_id: "build-v4-daemon-scan",
    workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
    // A v4 workspace's scan never resolves a language plugin at all
    // (`scheduleWorkspaceScan`'s v4 branch checks `readStructuralStore`
    // and calls `runV4WorkspaceScan` BEFORE `resolvePluginProvider` is
    // ever invoked) -- this stub throwing proves that boundary holds.
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

describe("Daemon v4 workspace-scan wiring (URDIRA_V4 default + explicit opt-out/opt-in)", () => {
  const originalFlag = process.env["URDIRA_V4"];
  afterEach(() => {
    if (originalFlag === undefined) delete process.env["URDIRA_V4"];
    else process.env["URDIRA_V4"] = originalFlag;
  });

  it("bootstraps the v4 catalog schema/meta and structural/sidecar directories, and sends Full on the first scan", async () => {
    process.env["URDIRA_V4"] = "1";
    const daemon = await startV4Daemon();
    try {
      await pollUntilStructuralReady(daemon.client, daemon.workspaceId);
      expect(daemon.transportState.calls).toHaveLength(1);
      expect(daemon.transportState.calls[0]?.scope).toEqual({ kind: "full" });

      const inspection = await createDurableStorage({ rootDir: daemon.dataRoot, skip_startup_recovery: true });
      try {
        const registration = await inspection.catalog.getWorkspace(daemon.workspaceId);
        if (registration === undefined) throw new Error("workspace registration missing");
        const databasePath = registration.database_path;
        expect(existsSync(structuralStoreDirFor(databasePath))).toBe(true);
        expect(existsSync(sidecarScanDirFor(databasePath))).toBe(true);
        expect(existsSync(sidecarDatabasePathFor(databasePath, "lexical"))).toBe(true);
        expect(existsSync(sidecarDatabasePathFor(databasePath, "semantic"))).toBe(false);

        const raw = await openSqliteDatabase({ filename: databasePath, read_only: true });
        try {
          expect(await readStructuralStore(raw)).toBe("native");
          const contract = await raw.get<{ value: unknown }>("SELECT value FROM workspace_meta WHERE key = 'index_contract'");
          const contractBytes = contract?.value instanceof Uint8Array ? contract.value : new Uint8Array(contract?.value as ArrayBuffer);
          expect(contractBytes.byteLength).toBe(1);
          expect(contractBytes[0]).toBe(0x34);
          const identity = await raw.get<{ value: unknown }>("SELECT value FROM workspace_meta WHERE key = 'identity_format'");
          const identityBytes = identity?.value instanceof Uint8Array ? identity.value : new Uint8Array(identity?.value as ArrayBuffer);
          expect(decodeCanonical(identityBytes)).toBe(3);
        } finally {
          await raw.close();
        }
      } finally {
        await inspection.close();
      }
    } finally {
      await stopV4Daemon(daemon);
    }
  }, 30_000);

  it("readiness flips to structural_ready/structural_durable once Queryable/ScanCompleted land, and reports both generations", async () => {
    process.env["URDIRA_V4"] = "1";
    const daemon = await startV4Daemon();
    try {
      const status = await pollUntilStructuralReady(daemon.client, daemon.workspaceId);
      expect(status.structural_durable).toBe(true);
      expect(status.readiness?.structural?.queryable_generation).toBe(1);
      expect(status.readiness?.structural?.durable_generation).toBe(1);
      expect(status.workspace_status).toBe("ready");
    } finally {
      await stopV4Daemon(daemon);
    }
  }, 30_000);

  it("reports the P4-d v4 status surface: storage_format, structural/lexical/semantic lanes, last_scan, and search_*_ready", async () => {
    process.env["URDIRA_V4"] = "1";
    const daemon = await startV4Daemon();
    try {
      const afterFirstScan = await pollUntilStructuralReady(daemon.client, daemon.workspaceId);
      expect(afterFirstScan.storage_format).toBe("v4");
      expect(afterFirstScan.structural).toEqual({ queryable_generation: 1, durable_generation: 1, queryable: true });
      // `search_semantic` is never wired for a v4 workspace yet
      // (`runV4WorkspaceScan`'s own doc comment) -- always unavailable,
      // independent of how long the daemon has been running.
      expect(afterFirstScan.semantic?.current).toBe(false);
      expect(afterFirstScan.search_semantic_ready).toBe(false);
      // The fake transport's `scan_completed` timings (`createFakeV4Transport`
      // above) are `{ total_ms: 2 }`; the first-ever scan is always `Full`.
      expect(afterFirstScan.last_scan).toMatchObject({ kind: "full", timings: { total_ms: 2 } });
      expect(afterFirstScan.last_scan?.changed_paths).toBeUndefined();

      // Lexical maintenance (`reconcileLexicalProjection`) is submitted the
      // moment `ScanCompleted` lands and runs asynchronously against the
      // real workspace database -- with this fake transport, the structural
      // catalog it reads from has no real artifact rows (only a real Rust
      // worker writes those), so it never finds anything to mark complete.
      // That is a legitimate, stable "lagging" state to assert on: give the
      // job a moment to run, then confirm `lexical.current`/`search_text_ready`
      // report it honestly rather than defaulting to a misleading "true".
      await sleep(500);
      const afterLexicalAttempt = await fetchIndexStatus(daemon.client, daemon.workspaceId);
      expect(afterLexicalAttempt.lexical?.current).toBe(false);
      expect(afterLexicalAttempt.search_text_ready).toBe(false);

      // A watcher-driven edit with the fake transport's `supportsChanged`
      // flag on sends `ScanScope::Changed`, and the resulting `last_scan`
      // reflects that scope's kind and path count.
      daemon.transportState.supportsChanged = true;
      await writeFile(join(daemon.workspaceRoot, "edit.ts"), "export const edited = 2;\n", "utf8");
      await pollUntil(() => daemon.transportState.calls.length >= 2, 20_000);
      const afterChangedScan = await pollUntilStructuralReady(daemon.client, daemon.workspaceId);
      expect(afterChangedScan.structural?.durable_generation).toBe(2);
      expect(afterChangedScan.last_scan).toMatchObject({ kind: "changed", timings: { total_ms: 2 } });
      expect(afterChangedScan.last_scan?.changed_paths).toBeGreaterThan(0);
    } finally {
      await stopV4Daemon(daemon);
    }
  }, 30_000);

  it("reports the P1-D-c semantic_upgrade lane and calls_upgraded once the residual pass reports in", async () => {
    process.env["URDIRA_V4"] = "1";
    const originalResidualFlag = process.env["URDIRA_V4_RESIDUAL"];
    // The daemon reads this SAME env var (forwarded to the real worker
    // child process by `indexing-core-process-transport.ts`, but read
    // directly here since this test's fake transport never spawns one) to
    // decide whether `upgrade_running` should optimistically latch `true`
    // on scan completion -- see `runV4WorkspaceScan`'s own comment.
    process.env["URDIRA_V4_RESIDUAL"] = "1";
    try {
      const daemon = await startV4Daemon();
      try {
        const afterFirstScan = await pollUntilStructuralReady(daemon.client, daemon.workspaceId);
        // No `upgrade_completed` event has arrived yet -- the pass is
        // presumed running (optimistically) the moment the triggering scan
        // completes with the feature enabled.
        expect(afterFirstScan.semantic_upgrade).toEqual({ running: true });
        expect(afterFirstScan.calls_upgraded).toBe(false);

        const requestId = daemon.transportState.requestIds[0];
        if (requestId === undefined) throw new Error("no workspace_scan request was recorded");
        daemon.transportState.emitUpgradeCompleted({
          request_id: requestId,
          generation: 2,
          upgraded_sites: 7,
          external_sites: 1,
          unresolved_sites: 3,
          timings: { total_ms: 500 },
        });

        // `handleV4UpgradeCompleted` is synchronous (a `Map.set` plus a
        // readiness-changed notification, no I/O) -- the very next
        // `core:index_status` call already reflects it, no polling needed.
        const afterUpgrade = await fetchIndexStatus(daemon.client, daemon.workspaceId);
        expect(afterUpgrade.semantic_upgrade).toEqual({ completed_generation: 2, pending_sites: 3, running: false });
        expect(afterUpgrade.calls_upgraded).toBe(true);
        // Structural readiness (a completely separate concern) is
        // untouched by the residual pass's own completion.
        expect(afterUpgrade.structural).toEqual({ queryable_generation: 1, durable_generation: 1, queryable: true });

        // A second scan (the watcher-driven edit path already exercised
        // above) must carry `upgrade_completed_generation`/`upgrade_pending_sites`
        // FORWARD rather than wiping them -- only a later `upgrade_completed`
        // event should ever change them again.
        await writeFile(join(daemon.workspaceRoot, "edit.ts"), "export const edited = 2;\n", "utf8");
        daemon.transportState.supportsChanged = true;
        await pollUntil(() => daemon.transportState.calls.length >= 2, 20_000);
        await pollUntilStructuralReady(daemon.client, daemon.workspaceId);
        const afterSecondScan = await fetchIndexStatus(daemon.client, daemon.workspaceId);
        expect(afterSecondScan.semantic_upgrade).toEqual({ completed_generation: 2, pending_sites: 3, running: true });
        expect(afterSecondScan.calls_upgraded).toBe(true);
      } finally {
        await stopV4Daemon(daemon);
      }
    } finally {
      if (originalResidualFlag === undefined) delete process.env["URDIRA_V4_RESIDUAL"];
      else process.env["URDIRA_V4_RESIDUAL"] = originalResidualFlag;
    }
  }, 30_000);

  it("reports storage_format: v3 (and no v4 lane fields) for a v3 workspace", async () => {
    process.env["URDIRA_V4"] = "0";
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-v4-scan-status-v3-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-v4-scan-status-v3-workspace-"));
    await writeFile(join(workspaceRoot, "seed.txt"), "seed", "utf8");
    let runtime: DaemonRuntime | undefined;
    try {
      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-v4-scan-status-v3",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        resolve_plugin_provider: async () => undefined,
        lexical_index: false,
        semantic_index: false,
        reconciliation_sweep_interval_ms: 0,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
      });
      const client = new DaemonClient(runtime.endpoint, { request_timeout_ms: 120_000 });
      const added = await client.call("core:workspace_add", { args: [workspaceRoot], confirmed: true });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      const status = await fetchIndexStatus(client, workspaceId);
      expect(status.storage_format).toBe("v3");
      expect(status.last_scan).toBeUndefined();
    } finally {
      await runtime?.stop().catch(() => undefined);
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("submits lexical maintenance on ScanCompleted, opening the sidecar file via openSidecar", async () => {
    process.env["URDIRA_V4"] = "1";
    const daemon = await startV4Daemon();
    try {
      await pollUntilStructuralReady(daemon.client, daemon.workspaceId);
      const inspection = await createDurableStorage({ rootDir: daemon.dataRoot, skip_startup_recovery: true });
      let lexicalSidecarPath: string;
      try {
        const registration = await inspection.catalog.getWorkspace(daemon.workspaceId);
        if (registration === undefined) throw new Error("workspace registration missing");
        lexicalSidecarPath = registration.database_path.endsWith(".sqlite")
          ? `${registration.database_path.slice(0, -".sqlite".length)}.lexical.sqlite`
          : `${registration.database_path}.lexical.sqlite`;
      } finally {
        await inspection.close();
      }
      await pollUntil(() => existsSync(lexicalSidecarPath), 20_000);
    } finally {
      await stopV4Daemon(daemon);
    }
  }, 30_000);

  it("a watcher-driven edit sends ScanScope::Changed with the mapped path when the worker supports it", async () => {
    process.env["URDIRA_V4"] = "1";
    const daemon = await startV4Daemon();
    try {
      await pollUntilStructuralReady(daemon.client, daemon.workspaceId);
      expect(daemon.transportState.calls).toHaveLength(1);
      daemon.transportState.supportsChanged = true;
      await writeFile(join(daemon.workspaceRoot, "edit.ts"), "export const edited = 2;\n", "utf8");
      await pollUntil(() => daemon.transportState.calls.length >= 2, 20_000);
      const changedCall = daemon.transportState.calls[1];
      expect(changedCall?.scope.kind).toBe("changed");
      if (changedCall?.scope.kind === "changed") {
        expect(changedCall.scope.paths.length).toBeGreaterThan(0);
        expect(changedCall.scope.paths.some((path) => path.path.includes("edit.ts"))).toBe(true);
      }
      await pollUntilStructuralReady(daemon.client, daemon.workspaceId);
    } finally {
      await stopV4Daemon(daemon);
    }
  }, 30_000);

  it("falls back to Full and logs once when the worker rejects ScanScope::Changed for lack of a prior generation", async () => {
    process.env["URDIRA_V4"] = "1";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const daemon = await startV4Daemon();
    try {
      await pollUntilStructuralReady(daemon.client, daemon.workspaceId);
      expect(daemon.transportState.calls).toHaveLength(1);
      // `transportState.supportsChanged` defaults to `false`, simulating a
      // worker with no prior generation cached for this workspace (P3-1:
      // `crates/urdira-indexing-worker/src/v4/delta.rs`'s ONE legitimate
      // `Changed` rejection reason now that the path is really implemented).
      await writeFile(join(daemon.workspaceRoot, "edit.ts"), "export const edited = 2;\n", "utf8");
      // One rejected "changed" attempt, then one successful "full" fallback.
      await pollUntil(() => daemon.transportState.calls.length >= 3, 20_000);
      expect(daemon.transportState.calls[1]?.scope.kind).toBe("changed");
      expect(daemon.transportState.calls[2]?.scope).toEqual({ kind: "full" });
      await pollUntilStructuralReady(daemon.client, daemon.workspaceId);
      const warnedLines = warnSpy.mock.calls.flat().map((call) => String(call));
      const fallbackWarnings = warnedLines.filter((line) => line.includes("no prior generation cached"));
      expect(fallbackWarnings.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
      await stopV4Daemon(daemon);
    }
  }, 30_000);

  it("records a diagnosable last_scan_error_code when URDIRA_V4=1 but no resolve_workspace_scan_transport is configured", async () => {
    process.env["URDIRA_V4"] = "1";
    // Reproduces a composing application that turns on `URDIRA_V4` without
    // wiring `DaemonRuntimeOptions.resolve_workspace_scan_transport` at all
    // (the option is simply omitted below, unlike `startV4Daemon`'s own
    // default) -- `runV4WorkspaceScan`'s `resolveTransport?.(workspace)`
    // then resolves to `undefined`, and it throws its own documented error
    // instead of silently doing nothing.
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-v4-scan-no-transport-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-v4-scan-no-transport-workspace-"));
    await writeFile(join(workspaceRoot, "seed.ts"), "export const seed = 1;\n", "utf8");
    let runtime: DaemonRuntime | undefined;
    try {
      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-v4-daemon-scan-no-transport",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        resolve_plugin_provider: async () => { throw new Error("resolve_plugin_provider must not be called for a v4 workspace."); },
        semantic_index: false,
        reconciliation_sweep_interval_ms: 0,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
      });
      const client = new DaemonClient(runtime.endpoint, { request_timeout_ms: 120_000 });
      const added = await client.call("core:workspace_add", { args: [workspaceRoot], confirmed: true });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;

      const deadline = Date.now() + 20_000;
      let payload: (IndexStatusWorkspaceView & { readonly last_scan_error_code?: string; readonly last_scan_error_at?: string }) | undefined;
      while (Date.now() < deadline) {
        const response = await client.call("core:index_status", { workspace_ids: [workspaceId] });
        expect(response.outcome).toBe("success");
        const workspaces = (response.payload as { readonly workspaces: readonly (IndexStatusWorkspaceView & { readonly last_scan_error_code?: string; readonly last_scan_error_at?: string })[] }).workspaces;
        payload = workspaces[0];
        if (payload?.last_scan_error_code !== undefined) break;
        await sleep(50);
      }
      // `scanFailureErrorCode` falls back to this generic code for a plain
      // `Error` with no `.code` (`runV4WorkspaceScan`'s transport-missing
      // throw is exactly that).
      expect(payload?.last_scan_error_code).toBe("core:workspace_scan_failed");
      // 2026-09-08 P0 fix (docs/evidence/2026-09-07-v4-vscode-campaign.md
      // §4.0): this is the workspace's very first-ever scan
      // (`priorSnapshotId` is `undefined`, no prior generation to re-pin
      // `markReady(..., "degraded")` to) -- BEFORE the fix, the terminal-
      // failure handler had nothing to re-pin to at all and left
      // `workspace_status` at `"indexing"` forever, with no way for a
      // caller polling `core:index_status`/`core:workspace_admin_show` to
      // tell a genuinely stuck daemon from one still working (reproduced
      // live: over 100 minutes, daemon fully idle). `WorkspaceRegistry
      // #recordScanFailure` (`packages/engine/src/workspaces.ts`) now flips
      // straight to `"degraded"` in exactly this case.
      expect(payload?.workspace_status).toBe("degraded");
      // `core:reindex` must be able to relaunch the scan from this
      // "degraded, no index at all" state -- it is unconditional on the
      // workspace's current status (`packages/daemon/src/runtime.ts`'s
      // `core:reindex` handler calls `beginReconciliation` regardless), but
      // this test still confirms it live rather than trusting that by
      // inspection alone. The retry hits the exact same missing-transport
      // failure again (this harness never wires one), so the observable
      // effect is: `reindex_started: true`, and the workspace is briefly
      // `"indexing"` again before settling back to `"degraded"` with a
      // FRESH `last_scan_error_at`.
      const beforeReindexErrorAt = payload?.last_scan_error_at;
      const reindexed = await client.call("core:reindex", { args: [workspaceId] });
      expect(reindexed.outcome).toBe("success");
      expect((reindexed.payload as { readonly reindex_started?: boolean }).reindex_started).toBe(true);
      const reindexDeadline = Date.now() + 20_000;
      let afterReindex: (IndexStatusWorkspaceView & { readonly last_scan_error_code?: string; readonly last_scan_error_at?: string }) | undefined;
      while (Date.now() < reindexDeadline) {
        const response = await client.call("core:index_status", { workspace_ids: [workspaceId] });
        const workspaces = (response.payload as { readonly workspaces: readonly (IndexStatusWorkspaceView & { readonly last_scan_error_code?: string; readonly last_scan_error_at?: string })[] }).workspaces;
        afterReindex = workspaces[0];
        if (afterReindex?.workspace_status === "degraded" && afterReindex.last_scan_error_at !== beforeReindexErrorAt) break;
        await sleep(50);
      }
      expect(afterReindex?.workspace_status).toBe("degraded");
      expect(afterReindex?.last_scan_error_code).toBe("core:workspace_scan_failed");
      expect(afterReindex?.last_scan_error_at).not.toBe(beforeReindexErrorAt);
    } finally {
      await runtime?.stop().catch(() => undefined);
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("bootstraps v4 by default when URDIRA_V4 is left unset (P4-b-2 default flip)", async () => {
    // No `startV4Daemon` here on purpose: that helper always wires
    // `resolve_workspace_scan_transport` itself, which would mask the
    // question this test asks -- does `isV4Enabled()` itself default to
    // v4 with the flag simply absent, with no explicit "1" anywhere. This
    // is the production default (`packages/daemon/src/runtime.ts`'s
    // `isV4Enabled`); `vitest.config.ts`'s suite-wide `env: { URDIRA_V4: "0"
    // }` baseline is deliberately overridden right here, per-test, the same
    // way every other test in this file already overrides that baseline.
    delete process.env["URDIRA_V4"];
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-v4-scan-default-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-v4-scan-default-workspace-"));
    await writeFile(join(workspaceRoot, "seed.ts"), "export const seed = 1;\n", "utf8");
    const transportState = new FakeTransportState();
    let runtime: DaemonRuntime | undefined;
    try {
      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-v4-scan-default-flip",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        resolve_plugin_provider: async () => { throw new Error("resolve_plugin_provider must not be called for a v4 workspace."); },
        resolve_workspace_scan_transport: async () => createFakeV4Transport(transportState),
        semantic_index: false,
        reconciliation_sweep_interval_ms: 0,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
      });
      const client = new DaemonClient(runtime.endpoint, { request_timeout_ms: 120_000 });
      const added = await client.call("core:workspace_add", { args: [workspaceRoot], confirmed: true });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      await pollUntilStructuralReady(client, workspaceId);
      expect(transportState.calls).toHaveLength(1);
      expect(transportState.calls[0]?.scope.kind).toBe("full");

      const inspection = await createDurableStorage({ rootDir: dataRoot, skip_startup_recovery: true });
      try {
        const registration = await inspection.catalog.getWorkspace(workspaceId);
        if (registration === undefined) throw new Error("workspace registration missing");
        expect(existsSync(structuralStoreDirFor(registration.database_path))).toBe(true);
        const raw = await openSqliteDatabase({ filename: registration.database_path, read_only: true });
        try {
          expect(await readStructuralStore(raw)).toBe("native");
        } finally {
          await raw.close();
        }
      } finally {
        await inspection.close();
      }
    } finally {
      await runtime?.stop().catch(() => undefined);
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not bootstrap v4 for a workspace added with URDIRA_V4=0 (opt-out honored)", async () => {
    process.env["URDIRA_V4"] = "0";
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-v4-scan-v3-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-v4-scan-v3-workspace-"));
    await writeFile(join(workspaceRoot, "seed.txt"), "seed", "utf8");
    const resolveCalls: number[] = [];
    let runtime: DaemonRuntime | undefined;
    try {
      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-v4-scan-v3-untouched",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        // No compatible plugin: the generic source-only path never marks
        // "ready", so this test only needs to observe that a scan RAN and
        // that no v4 bootstrap occurred -- both v3 facts, unaffected by
        // this flag being off.
        resolve_plugin_provider: async () => { resolveCalls.push(Date.now()); return undefined; },
        lexical_index: false,
        semantic_index: false,
        reconciliation_sweep_interval_ms: 0,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
      });
      const client = new DaemonClient(runtime.endpoint, { request_timeout_ms: 120_000 });
      const added = await client.call("core:workspace_add", { args: [workspaceRoot], confirmed: true });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      await pollUntil(() => resolveCalls.length >= 1, 20_000);

      const inspection = await createDurableStorage({ rootDir: dataRoot, skip_startup_recovery: true });
      try {
        const registration = await inspection.catalog.getWorkspace(workspaceId);
        if (registration === undefined) throw new Error("workspace registration missing");
        expect(existsSync(structuralStoreDirFor(registration.database_path))).toBe(false);
        expect(existsSync(sidecarScanDirFor(registration.database_path))).toBe(false);
        const raw = await openSqliteDatabase({ filename: registration.database_path, read_only: true });
        try {
          expect(await readStructuralStore(raw)).toBeUndefined();
        } finally {
          await raw.close();
        }
      } finally {
        await inspection.close();
      }
    } finally {
      await runtime?.stop().catch(() => undefined);
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
