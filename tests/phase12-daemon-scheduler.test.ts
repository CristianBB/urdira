import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonError, DaemonScheduler, PersistentCursorRecovery, type SchedulerJobRequest } from "../packages/daemon/src/index.js";

function job<T>(overrides: Partial<SchedulerJobRequest<T>> = {}): SchedulerJobRequest<T> {
  return { job_id: "job-1", client_id: "client-1", workspace_id: "workspace-1", pool: "query", run: async () => "done" as T, ...overrides };
}

describe("Phase 12 daemon scheduler", () => {
  it("runs independent pools while enforcing global admission and client quotas", async () => {
    const scheduler = new DaemonScheduler({ pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 2, client_quotas: { "client-1": { max_in_flight: 2 } } });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = scheduler.submit(job({ job_id: "job-1", run: async () => { await held; return "one"; } }));
    const second = scheduler.submit(job({ job_id: "job-2", pool: "semantic", run: async () => "two" }));
    expect(() => scheduler.submit(job({ job_id: "job-3" }))).toThrowError(DaemonError);
    release();
    await expect(Promise.all([first.promise, second.promise])).resolves.toEqual(["one", "two"]);
    await scheduler.stop();
  });

  it("serializes publication for one workspace and reports progress", async () => {
    const scheduler = new DaemonScheduler({ pool_concurrency: { source: 2, structural: 2, semantic: 2, query: 2 }, max_active: 4, client_quotas: {} });
    const events: string[] = [];
    const make = (id: string): SchedulerJobRequest<string> => job({ job_id: id, run: async (_signal, report) => { report({ phase: id, completed: 1, total: 1 }); return id; }, publish: async (value) => { events.push(`start:${value}`); await new Promise((resolve) => setTimeout(resolve, 5)); events.push(`end:${value}`); } });
    const first = scheduler.submit(make("one"));
    const second = scheduler.submit(make("two"));
    await expect(Promise.all([first.promise, second.promise])).resolves.toEqual(["one", "two"]);
    expect(events).toEqual(["start:one", "end:one", "start:two", "end:two"]);
    expect(first.progress).toEqual([{ phase: "one", completed: 1, total: 1 }]);
    await scheduler.stop();
  });

  it("cancels work and prevents a restart lease from being released twice", async () => {
    const scheduler = new DaemonScheduler({ pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 1, client_quotas: {} });
    const handle = scheduler.submit(job({ run: async (signal) => await new Promise<string>((_resolve, reject) => { signal.addEventListener("abort", () => reject(new DaemonError("core:operation_cancelled", "cancelled")), { once: true }); }) }));
    handle.cancel();
    await expect(handle.promise).rejects.toMatchObject({ code: "core:operation_cancelled" });
    const lease = await scheduler.acquireRestartLease("client-1");
    await lease.release(); await lease.release();
    expect(scheduler.restartLeaseCount).toBe(0);
    await scheduler.stop({ force: true });
  });

  it("persists cursor recovery metadata across a new process object", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase12-cursors-"));
    try {
      const first = new PersistentCursorRecovery(join(root, "cursors.json"));
      await first.save("execution-1", { scope_digest: "scope-1", cursors: ["cursor-1"], expires_at: "2099-01-01T00:00:00.000Z" });
      const second = new PersistentCursorRecovery(join(root, "cursors.json"));
      expect(await second.load("execution-1")).toEqual({ scope_digest: "scope-1", cursors: ["cursor-1"], expires_at: "2099-01-01T00:00:00.000Z" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("settles queued jobs during forced shutdown", async () => {
    const scheduler = new DaemonScheduler({ pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 1, client_quotas: {} });
    const first = scheduler.submit(job({ job_id: "held", run: async (signal) => await new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DaemonError("core:operation_cancelled", "cancelled")), { once: true })) }));
    let queuedRuns = 0;
    const queued = scheduler.submit(job({ job_id: "queued", run: async () => { queuedRuns++; return "never"; } }));
    const stopping = scheduler.stop({ force: true });
    await expect(first.promise).rejects.toMatchObject({ code: "core:operation_cancelled" });
    await expect(queued.promise).rejects.toMatchObject({ code: "core:operation_cancelled" });
    expect(queuedRuns).toBe(0);
    await expect(stopping).resolves.toBeUndefined();
  });

  it("admits a queued query before lower-priority maintenance and exposes pressure", async () => {
    const scheduler = new DaemonScheduler({ pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 1, query_reserved_slots: 1, client_quotas: {} });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const heldHandle = scheduler.submit(job({ job_id: "held", pool: "source", run: async () => { await held; return "held"; } }));
    const maintenance = scheduler.submit(job({ job_id: "maintenance", pool: "semantic", run: async () => { order.push("semantic"); return "semantic"; } }));
    const query = scheduler.submit(job({ job_id: "query", pool: "query", run: async () => { order.push("query"); return "query"; } }));
    expect(scheduler.hasQueryPressure()).toBe(true);
    release();
    await expect(Promise.all([heldHandle.promise, query.promise, maintenance.promise])).resolves.toEqual(["held", "query", "semantic"]);
    expect(order).toEqual(["query", "semantic"]);
    expect(scheduler.hasQueryPressure()).toBe(false);
    await scheduler.stop();
  });
});
