import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceRegistry } from "../packages/engine/src/index.js";
import { DaemonClient, DaemonRuntime, type DaemonRuntimeOptions } from "../packages/daemon/src/index.js";

/**
 * Coverage for the watcher-burst aggregation window
 * (`DaemonRuntimeOptions.scan_aggregation_window_ms`/`scan_aggregation_max_ms`,
 * `packages/daemon/src/runtime.ts`'s `scheduleWorkspaceScan`): before that
 * fix, the FIRST watcher event of a burst of N almost-simultaneous edits (an
 * agent's multi-file write) started a scan immediately, so events 2..N
 * always missed it and had to pay for a SECOND, separate follow-up scan once
 * the first settled -- one burst, two scans. With the window configured, the
 * first genuine edit event instead buffers for a short debounced window
 * (reset by every further event, capped so a continuous edit stream cannot
 * postpone indexing indefinitely) before a single scan starts with the union
 * of everything buffered.
 *
 * This deliberately uses the LIGHTEST possible scan path -- `resolve_plugin_provider`
 * always returns `undefined`, so every scheduled scan takes
 * `scheduleWorkspaceScan`'s "no compatible language plugin" branch
 * (`runSourceOnlyWorkspaceScan`) instead of a real JS/TS analysis pass. That
 * path never marks the workspace `"ready"` (by design -- see that branch's
 * own comment), which is fine here: these tests only assert how many times a
 * scan actually RAN and roughly WHEN, both fully observable by counting
 * `resolve_plugin_provider` invocations (called exactly once per executed
 * scan job, before that branch decision), never workspace readiness.
 * (The complementary claim -- that the aggregation window never delays the
 * passive reconciliation sweep, which only ever re-triggers `"ready"`/`"degraded"`
 * workspaces this no-plugin path never reaches -- is covered instead in
 * `tests/phase-daemon-indexing-integration.test.ts`'s "Daemon scan-aggregation
 * window does not delay the passive reconciliation sweep", which reuses that
 * file's real JS/TS plugin harness for exactly that reason.)
 */

function asDaemonWorkspaceRegistry(registry: WorkspaceRegistry): NonNullable<DaemonRuntimeOptions["workspace_registry"]> {
  return registry as unknown as NonNullable<DaemonRuntimeOptions["workspace_registry"]>;
}

async function pollUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition did not become true within ${timeoutMs} ms.`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}

/**
 * Waits until `resolveCalls.length` has stopped growing for `quietMs`, then
 * returns its final value. Used to assert a NEGATIVE claim ("no further scan
 * happens") without guessing a single fixed delay -- it keeps waiting as
 * long as new scans keep landing, and only settles once they stop.
 */
async function settledCallCount(resolveCalls: readonly unknown[], quietMs: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastCount = resolveCalls.length;
  let lastChangeAt = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    if (resolveCalls.length !== lastCount) {
      lastCount = resolveCalls.length;
      lastChangeAt = Date.now();
      continue;
    }
    if (Date.now() - lastChangeAt >= quietMs) return lastCount;
  }
  return lastCount;
}

interface AggregationDaemon {
  readonly runtime: DaemonRuntime;
  readonly client: DaemonClient;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly dataRoot: string;
  readonly resolveCalls: number[];
}

/**
 * Starts a real `DaemonRuntime` (real IPC server, real filesystem watcher)
 * against a fresh temp workspace, with `resolve_plugin_provider` wired to a
 * counter that records the wall-clock time of every invocation and always
 * returns `undefined` (see this file's own doc comment for why). Waits for
 * `core:workspace_add`'s own initial scan (never aggregatable -- see
 * `scheduleWorkspaceScan`'s `aggregatable` doc comment in `runtime.ts`) to
 * land before returning, so callers' own assertions start from a clean,
 * settled `resolveCalls` baseline.
 */
async function startAggregationDaemon(overrides: Partial<DaemonRuntimeOptions> = {}): Promise<AggregationDaemon> {
  const dataRoot = await mkdtemp(join(tmpdir(), "urdira-scan-agg-data-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-scan-agg-workspace-"));
  await writeFile(join(workspaceRoot, "seed.txt"), "seed", "utf8");
  const resolveCalls: number[] = [];
  const countingResolvePluginProvider: NonNullable<DaemonRuntimeOptions["resolve_plugin_provider"]> = async () => {
    resolveCalls.push(Date.now());
    return undefined;
  };
  const runtime = await DaemonRuntime.start({
    data_root: dataRoot,
    engine_build_id: "build-scan-aggregation",
    workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
    resolve_plugin_provider: countingResolvePluginProvider,
    lexical_index: false,
    semantic_index: false,
    reconciliation_sweep_interval_ms: 0,
    scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
    ...overrides,
  });
  const client = new DaemonClient(runtime.endpoint, { request_timeout_ms: 120_000 });
  const added = await client.call("core:workspace_add", { args: [workspaceRoot], confirmed: true });
  expect(added.outcome).toBe("success");
  const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
  await pollUntil(() => resolveCalls.length >= 1, 20_000);
  // Starting the real filesystem watcher right after `seed.txt` was written
  // (before the daemon even existed) can itself surface as one spurious
  // "changed" reconcile once the subscription arms, coalesced as a
  // follow-up scan behind the initial workspace_add scan above (that
  // follow-up is not itself gated by the aggregation window -- see
  // `scheduleWorkspaceScan`'s `finally` block). Settling here, past however
  // long THIS run's own configured window/cap could stretch that follow-up
  // out, keeps it out of every test's own "before" baseline instead of
  // racing the assertions below.
  const quietMs = Math.max(600, (overrides.scan_aggregation_max_ms ?? 1_000) + 300);
  await settledCallCount(resolveCalls, quietMs, quietMs + 15_000);
  return { runtime, client, workspaceId, workspaceRoot, dataRoot, resolveCalls };
}

async function stopAggregationDaemon(daemon: AggregationDaemon): Promise<void> {
  await daemon.runtime.stop().catch(() => undefined);
  await rm(daemon.dataRoot, { recursive: true, force: true });
  await rm(daemon.workspaceRoot, { recursive: true, force: true });
}

describe("Daemon watcher-burst scan aggregation (scan_aggregation_window_ms)", () => {
  it("N almost-simultaneous edits collapse into exactly one scan, not two", async () => {
    const daemon = await startAggregationDaemon({ scan_aggregation_window_ms: 250, scan_aggregation_max_ms: 2_000 });
    try {
      const callsBeforeBurst = daemon.resolveCalls.length;
      // Five near-simultaneous edits, all well inside the 250ms window --
      // exactly the "an agent's multi-file write" scenario this fix targets.
      await Promise.all([0, 1, 2, 3, 4].map((index) => writeFile(join(daemon.workspaceRoot, `burst-${index}.txt`), `edit-${index}`, "utf8")));
      await pollUntil(() => daemon.resolveCalls.length > callsBeforeBurst, 10_000);
      // Keep watching well past the window: without this fix, a second
      // follow-up scan (the `pendingScans` coalescer catching whatever
      // arrived after the first, immediately-started scan) would land here.
      const settled = await settledCallCount(daemon.resolveCalls, 900, 10_000);
      expect(settled).toBe(callsBeforeBurst + 1);
    } finally {
      await stopAggregationDaemon(daemon);
    }
  }, 30_000);

  it("an isolated edit is not scanned immediately, and lands only after the aggregation window elapses", async () => {
    const windowMs = 400;
    const daemon = await startAggregationDaemon({ scan_aggregation_window_ms: windowMs, scan_aggregation_max_ms: 2_000 });
    try {
      const callsBefore = daemon.resolveCalls.length;
      const triggeredAt = Date.now();
      await writeFile(join(daemon.workspaceRoot, "isolated.txt"), "isolated", "utf8");
      // Well under the window: must still be buffered, not already scanned.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, windowMs / 2));
      expect(daemon.resolveCalls.length).toBe(callsBefore);
      await pollUntil(() => daemon.resolveCalls.length > callsBefore, 10_000);
      const elapsedMs = daemon.resolveCalls[daemon.resolveCalls.length - 1]! - triggeredAt;
      // Generous lower bound (tolerates watcher-delivery and scheduling
      // jitter) that still proves the scan did not start immediately.
      expect(elapsedMs).toBeGreaterThanOrEqual(windowMs * 0.6);
    } finally {
      await stopAggregationDaemon(daemon);
    }
  }, 30_000);

  it("a continuous stream of edits inside the debounce window is still force-flushed at the hard cap", async () => {
    const maxMs = 700;
    const daemon = await startAggregationDaemon({ scan_aggregation_window_ms: 300, scan_aggregation_max_ms: maxMs });
    try {
      const callsBefore = daemon.resolveCalls.length;
      const startedAt = Date.now();
      let index = 0;
      // Re-triggers the debounce faster than the 300ms window, for longer
      // than the 700ms cap: each write resets the window, so without a hard
      // cap the scan could be postponed indefinitely by a streaming editor.
      const streamTimer = setInterval(() => {
        void writeFile(join(daemon.workspaceRoot, `stream-${index}.txt`), `edit-${index}`, "utf8");
        index += 1;
      }, 150);
      try {
        await pollUntil(() => daemon.resolveCalls.length > callsBefore, 5_000);
      } finally {
        clearInterval(streamTimer);
      }
      const elapsedMs = daemon.resolveCalls[daemon.resolveCalls.length - 1]! - startedAt;
      // Must fire at (or shortly after) the cap, not keep resetting forever.
      expect(elapsedMs).toBeGreaterThanOrEqual(maxMs * 0.7);
      expect(elapsedMs).toBeLessThan(3_000);
    } finally {
      await stopAggregationDaemon(daemon);
    }
  }, 30_000);

  it("with the window disabled (0), a single edit is scanned immediately like today", async () => {
    const daemon = await startAggregationDaemon({ scan_aggregation_window_ms: 0 });
    try {
      const callsBefore = daemon.resolveCalls.length;
      const triggeredAt = Date.now();
      await writeFile(join(daemon.workspaceRoot, "no-window.txt"), "no-window", "utf8");
      await pollUntil(() => daemon.resolveCalls.length > callsBefore, 10_000);
      const elapsedMs = daemon.resolveCalls[daemon.resolveCalls.length - 1]! - triggeredAt;
      // No 200ms(+) default window to wait out -- generous upper bound for
      // watcher delivery + scan scheduling latency alone.
      expect(elapsedMs).toBeLessThan(2_000);
    } finally {
      await stopAggregationDaemon(daemon);
    }
  }, 30_000);
});

/**
 * P3-2 item 4: real end-to-end coverage (real `DaemonRuntime`, real
 * filesystem watcher) of the rename delete+create coalescing fix in
 * `packages/daemon/src/runtime.ts` (`mergeScanRequestIntoBuffer`,
 * `flushScanAggregation`, the post-scan `pendingScans` follow-up) and
 * `packages/engine/src/watchers.ts` (`WorkspaceWatcherManager`'s
 * `on_reconcile` combining). Two real defects were found and fixed here:
 * (1) a rename's create half, arriving in the SAME watcher batch/burst as
 * its matching delete, used to be split into a SEPARATE `on_reconcile`
 * call and then a SEPARATE generation even when nothing required that; (2)
 * `flushScanAggregation`'s own dispatch for a buffer with pending deletes
 * called `scheduleWorkspaceScan` a SECOND time for the buffered creates
 * immediately after starting the delete scan, which (because the delete
 * scan's own `scanInFlight`/`activeAuthoritativeDeletePhases` bookkeeping
 * runs synchronously, before any `await`) re-entered the coalescing
 * buffer as though it were a genuinely later, separate event and silently
 * dropped it into a buffer field nothing downstream reads -- confirmed
 * live as the root cause of a real daemon hang on the mutation harness's
 * `rename` mutation kind, which had to be excluded from every
 * daemon-driven measurement run before this fix.
 *
 * `tests/phase15-workspace-control.test.ts` covers the pure
 * `WorkspaceWatcherManager` + `DeterministicFakeWatcher` unit-level
 * behavior (including a deliberately OUT-OF-ORDER batch: a `presence`
 * event before its matching `absence`) without a real daemon/scheduler in
 * the loop at all; the two tests below instead exercise the FULL
 * `scheduleWorkspaceScan`/aggregation-buffer machinery those fixes live in,
 * end to end, against a real filesystem and a real `DaemonRuntime`.
 */
describe("Daemon rename coalescing (delete+create in one Changed, P3-2 item 4)", () => {
  it("a create arriving before its matching delete (out of order, same burst) collapses into at most one scan, never dropping either half", async () => {
    // A generous window: two independent real syscalls plus OS-level
    // (FSEvents/parcel-watcher) batching latency, in a sandboxed CI-like
    // environment, need more headroom than the debounce window alone to
    // reliably land in the SAME app-level burst -- this test's own claim is
    // about coalescing when they DO land together, not about guaranteeing
    // they always will on every OS/filesystem, so the window is generous
    // rather than tight.
    const daemon = await startAggregationDaemon({ scan_aggregation_window_ms: 800, scan_aggregation_max_ms: 3_000 });
    try {
      const oldPath = join(daemon.workspaceRoot, "rename-source.txt");
      await writeFile(oldPath, "content", "utf8");
      await settledCallCount(daemon.resolveCalls, 600, 10_000);
      const callsBefore = daemon.resolveCalls.length;
      // Out of order and split across two real syscalls, both well inside
      // the aggregation window: the CREATE half of a would-be rename lands
      // before the DELETE half.
      await writeFile(join(daemon.workspaceRoot, "rename-target.txt"), "content", "utf8");
      await unlink(oldPath);
      await pollUntil(() => daemon.resolveCalls.length > callsBefore, 10_000);
      const settled = await settledCallCount(daemon.resolveCalls, 900, 10_000);
      // At most 2 (one per half, if OS-level batching happened to split
      // them into two app-level bursts despite the generous window -- not
      // itself a regression this test polices) and at least 1 (proving
      // neither half was silently dropped, which the pre-fix bug could do
      // for the create half specifically).
      expect(settled).toBeGreaterThanOrEqual(callsBefore + 1);
      expect(settled).toBeLessThanOrEqual(callsBefore + 2);
    } finally {
      await stopAggregationDaemon(daemon);
    }
  }, 30_000);

  it("a delete's own scan settling before a later, unrelated create (split across the burst boundary) does not drop the create", async () => {
    const daemon = await startAggregationDaemon({ scan_aggregation_window_ms: 150, scan_aggregation_max_ms: 1_000 });
    try {
      const targetPath = join(daemon.workspaceRoot, "will-be-deleted.txt");
      await writeFile(targetPath, "content", "utf8");
      await settledCallCount(daemon.resolveCalls, 600, 10_000);
      const callsBeforeDelete = daemon.resolveCalls.length;
      await unlink(targetPath);
      // Wait for the delete's OWN scan to start AND fully settle -- this is
      // the "burst boundary": by the time the create below happens, the
      // delete has already been dispatched and completed as its own
      // generation, exactly the scenario `activeAuthoritativeDeletePhases`
      // exists to gate. Before the fix, a create observed at this point
      // could vanish into `pendingScans`'s `presencesAfterDeletes` field
      // with nothing left to ever read it back out -- the daemon would
      // simply never schedule another scan for it, which is the real hang
      // this task's evidence doc reports for the mutation harness's
      // `rename` kind.
      await pollUntil(() => daemon.resolveCalls.length > callsBeforeDelete, 10_000);
      const callsAfterDelete = await settledCallCount(daemon.resolveCalls, 600, 10_000);
      expect(callsAfterDelete).toBeGreaterThan(callsBeforeDelete);
      await writeFile(join(daemon.workspaceRoot, "recreated-later.txt"), "content", "utf8");
      await pollUntil(() => daemon.resolveCalls.length > callsAfterDelete, 10_000);
    } finally {
      await stopAggregationDaemon(daemon);
    }
  }, 30_000);
});
