import { describe, expect, it, vi } from "vitest";
import { AnalysisWorkerPool } from "../apps/urdira/src/analysis-worker-pool.js";
import { canonicalSha256, type WorkerTransport } from "@urdira/plugin-sdk";
import {
  createJavascriptTypescriptWorker,
  type JavascriptTypescriptWorkerDescriptor,
} from "../packages/plugin-javascript-typescript/src/index.js";

/** A minimal fake `WorkerTransport`: records `terminate()` calls so tests can
 * assert eviction happened without spinning up a real TypeScript worker. */
function fakeTransport(): WorkerTransport & { readonly terminated: () => boolean } {
  let terminated = false;
  return {
    async invoke() { return {}; },
    async cancel() { return; },
    async reset() { return {}; },
    async terminate() { terminated = true; },
    terminated: () => terminated,
  };
}

describe("AnalysisWorkerPool", () => {
  it("reuses the same worker for a key across two acquire/release cycles with the same descriptor digest", () => {
    let createCount = 0;
    const pool = new AnalysisWorkerPool<{ readonly tag: string }>({ create: () => { createCount += 1; return fakeTransport(); } });
    const first = pool.acquire("workspace:a", { tag: "v1" }, "digest:v1");
    pool.release("workspace:a");
    const second = pool.acquire("workspace:a", { tag: "v1" }, "digest:v1");
    pool.release("workspace:a");
    expect(second).toBe(first);
    expect(createCount).toBe(1);
  });

  it("does not reuse across two different keys (separate workspaces get separate workers)", () => {
    let createCount = 0;
    const pool = new AnalysisWorkerPool<{ readonly tag: string }>({ create: () => { createCount += 1; return fakeTransport(); } });
    pool.acquire("workspace:a", { tag: "v1" }, "digest:v1");
    pool.release("workspace:a");
    pool.acquire("workspace:b", { tag: "v1" }, "digest:v1");
    pool.release("workspace:b");
    expect(createCount).toBe(2);
    expect(pool.size).toBe(2);
  });

  it("rejects a second lease for the same key and enforces the global active-worker cap", async () => {
    const pool = new AnalysisWorkerPool<{ readonly tag: string }>({ create: () => fakeTransport(), max_active: 1 });
    pool.acquire("workspace:a", { tag: "v1" }, "digest:v1");
    expect(() => pool.acquire("workspace:a", { tag: "v1" }, "digest:v1")).toThrow(/already leased/);
    expect(() => pool.acquire("workspace:b", { tag: "v1" }, "digest:v1")).toThrow(/admission exhausted/);
    expect(pool.active).toBe(1);
    pool.release("workspace:a");
    expect(pool.active).toBe(0);
    await pool.closeAll();
  });

  it("evicts and replaces the pooled worker when the descriptor digest changes for the same key", async () => {
    const created: ReturnType<typeof fakeTransport>[] = [];
    const pool = new AnalysisWorkerPool<{ readonly tag: string }>({ create: () => { const worker = fakeTransport(); created.push(worker); return worker; } });
    const first = pool.acquire("workspace:a", { tag: "v1" }, "digest:v1");
    pool.release("workspace:a");
    const second = pool.acquire("workspace:a", { tag: "v2" }, "digest:v2");
    pool.release("workspace:a");
    expect(second).not.toBe(first);
    // Give the fire-and-forget terminate a tick to run.
    await Promise.resolve();
    expect(created[0]!.terminated()).toBe(true);
    expect(created[1]!.terminated()).toBe(false);
  });

  it("evict(key) closes and removes the pooled worker for that key only", async () => {
    const pool = new AnalysisWorkerPool<{ readonly tag: string }>({ create: () => fakeTransport() });
    const a = pool.acquire("workspace:a", { tag: "v1" }, "digest:v1") as ReturnType<typeof fakeTransport>;
    pool.release("workspace:a");
    const b = pool.acquire("workspace:b", { tag: "v1" }, "digest:v1") as ReturnType<typeof fakeTransport>;
    pool.release("workspace:b");
    await pool.evict("workspace:a");
    expect(a.terminated()).toBe(true);
    expect(b.terminated()).toBe(false);
    expect(pool.size).toBe(1);
    // Evicting an unknown/already-evicted key is a safe no-op.
    await expect(pool.evict("workspace:a")).resolves.toBeUndefined();
  });

  it("evictWorkspace closes the closure worker and every deterministic shard", async () => {
    const created: ReturnType<typeof fakeTransport>[] = [];
    const pool = new AnalysisWorkerPool<{ readonly tag: string }>({ create: () => { const worker = fakeTransport(); created.push(worker); return worker; }, max_active: 2 });
    pool.acquire("workspace:a:closure", { tag: "v1" }, "digest:v1");
    pool.release("workspace:a:closure");
    pool.acquire("workspace:a:shard:0", { tag: "v1" }, "digest:v1");
    pool.release("workspace:a:shard:0");
    pool.acquire("workspace:b:closure", { tag: "v1" }, "digest:v1");
    pool.release("workspace:b:closure");
    await pool.evictWorkspace("workspace:a");
    expect(created[0]!.terminated()).toBe(true);
    expect(created[1]!.terminated()).toBe(true);
    expect(created[2]!.terminated()).toBe(false);
  });

  it("closeAll() closes every pooled worker", async () => {
    const pool = new AnalysisWorkerPool<{ readonly tag: string }>({ create: () => fakeTransport() });
    const a = pool.acquire("workspace:a", { tag: "v1" }, "digest:v1") as ReturnType<typeof fakeTransport>;
    pool.release("workspace:a");
    const b = pool.acquire("workspace:b", { tag: "v1" }, "digest:v1") as ReturnType<typeof fakeTransport>;
    pool.release("workspace:b");
    await pool.closeAll();
    expect(a.terminated()).toBe(true);
    expect(b.terminated()).toBe(true);
    expect(pool.size).toBe(0);
  });

  it("evicts idle entries beyond max_entries (LRU), never an in-use one", async () => {
    const pool = new AnalysisWorkerPool<{ readonly tag: string }>({ create: () => fakeTransport(), max_entries: 2 });
    const a = pool.acquire("workspace:a", { tag: "v1" }, "digest:v1") as ReturnType<typeof fakeTransport>;
    pool.release("workspace:a");
    const b = pool.acquire("workspace:b", { tag: "v1" }, "digest:v1") as ReturnType<typeof fakeTransport>;
    pool.release("workspace:b");
    // Third distinct workspace, still on loan (not released): must not evict
    // an in-use entry, but MUST evict the LRU idle one ("workspace:a").
    pool.acquire("workspace:c", { tag: "v1" }, "digest:v1");
    await Promise.resolve();
    expect(a.terminated()).toBe(true);
    expect(b.terminated()).toBe(false);
    expect(pool.size).toBe(2);
  });

  it("evicts an idle entry after its TTL elapses", async () => {
    vi.useFakeTimers();
    try {
      const pool = new AnalysisWorkerPool<{ readonly tag: string }>({ create: () => fakeTransport(), idle_ttl_ms: 1_000 });
      const a = pool.acquire("workspace:a", { tag: "v1" }, "digest:v1") as ReturnType<typeof fakeTransport>;
      pool.release("workspace:a");
      expect(a.terminated()).toBe(false);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(a.terminated()).toBe(true);
      expect(pool.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("acquiring again before the TTL elapses cancels the pending eviction", async () => {
    vi.useFakeTimers();
    try {
      const pool = new AnalysisWorkerPool<{ readonly tag: string }>({ create: () => fakeTransport(), idle_ttl_ms: 1_000 });
      const a = pool.acquire("workspace:a", { tag: "v1" }, "digest:v1") as ReturnType<typeof fakeTransport>;
      pool.release("workspace:a");
      await vi.advanceTimersByTimeAsync(500);
      const reacquired = pool.acquire("workspace:a", { tag: "v1" }, "digest:v1");
      expect(reacquired).toBe(a);
      pool.release("workspace:a");
      await vi.advanceTimersByTimeAsync(500);
      // Only 500ms have elapsed since the SECOND release; the original TTL
      // window (which would have fired at the 1000ms mark from the first
      // release) must have been cancelled by the re-acquire.
      expect(a.terminated()).toBe(false);
      await vi.advanceTimersByTimeAsync(501);
      expect(a.terminated()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("end to end with the real JS/TS worker: two acquire/release cycles for the same workspace take the session's incremental analyze path on the second, via on_analysis_incremental", async () => {
    let incrementalCount = 0;
    let buildCount = 0;
    const pool = new AnalysisWorkerPool<JavascriptTypescriptWorkerDescriptor>({
      create: (descriptor) => createJavascriptTypescriptWorker({
        ...descriptor,
        on_analysis_build: () => { buildCount += 1; },
        on_analysis_incremental: () => { incrementalCount += 1; },
      }),
    });
    const descriptor: JavascriptTypescriptWorkerDescriptor = {};
    const digest = canonicalSha256(descriptor);

    const filesV1 = [
      { path: "a.ts", text: "export const a = 1;\n" },
      { path: "b.ts", text: "import { a } from './a';\nexport const b = a + 1;\n" },
      { path: "c.ts", text: "export const c = 3;\n" },
      { path: "d.ts", text: "export const d = 4;\n" },
    ];
    const closureRequest = (files: typeof filesV1) => ({
      protocol_version: "1.0.0", request_id: "req:closure", request_digest: "digest:closure", call: "analyze_closure" as const,
      deadline: "2030-01-01T00:00:00.000Z", cancellation_id: "cancel:closure",
      payload: { files, root_names: files.map((file) => file.path) },
    });

    const workerA = pool.acquire("workspace:pool-e2e", descriptor, digest);
    await workerA.invoke(closureRequest(filesV1));
    pool.release("workspace:pool-e2e");
    expect(buildCount).toBe(1);
    expect(incrementalCount).toBe(0);

    // Second scan: the SAME pooled worker (and therefore the same
    // `JsTsAnalysisSession`) must be reused, so a one-file content edit
    // takes the incremental path.
    const filesV2 = filesV1.map((file) => (file.path === "a.ts" ? { ...file, text: "export const a = 100;\n" } : file));
    const workerB = pool.acquire("workspace:pool-e2e", descriptor, digest);
    expect(workerB).toBe(workerA);
    await workerB.invoke(closureRequest(filesV2));
    pool.release("workspace:pool-e2e");
    expect(buildCount).toBe(2);
    expect(incrementalCount).toBe(1);

    await pool.closeAll();
  });
});
