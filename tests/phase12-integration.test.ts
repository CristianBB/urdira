import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonClient, DaemonRuntime } from "../packages/daemon/src/index.js";

describe("Phase 12 daemon runtime", () => {
  it("starts with an owner-bound endpoint and serves correlated local IPC", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase12-runtime-"));
    try {
      const runtime = await DaemonRuntime.start({ data_root: root, engine_build_id: "build-1", scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 2, client_quotas: {} } });
      const client = new DaemonClient(runtime.endpoint);
      await expect(client.call("core:status", {})).resolves.toMatchObject({ outcome: "success", payload: { state: "ready", engine_build_id: "build-1" } });
      await runtime.stop();
      await expect(client.call("core:status", {})).rejects.toBeDefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("dispatches registered read-only calls without exposing command execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase12-runtime-"));
    try {
      const runtime = await DaemonRuntime.start({ data_root: root, engine_build_id: "build-1", scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 2, client_quotas: {} }, calls: { "core:echo": async (request) => request.payload } });
      const response = await new DaemonClient(runtime.endpoint).call("core:echo", { read_only: true });
      expect(response).toMatchObject({ outcome: "success", payload: { read_only: true } });
      await runtime.stop();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("restarts from the last-known-good checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase12-runtime-"));
    try {
      const options = { data_root: root, engine_build_id: "build-1", scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 2, client_quotas: {} } } as const;
      const first = await DaemonRuntime.start(options); await first.rememberCursor("execution-1", { scope_digest: "scope-1", cursors: ["cursor-1"], expires_at: "2099-01-01T00:00:00.000Z" }); await first.stop();
      const second = await DaemonRuntime.start(options);
      await expect(new DaemonClient(second.endpoint).call("core:status", {})).resolves.toMatchObject({ outcome: "success" });
      expect(second.recovered_cursor_ids).toContain("execution-1");
      await expect(second.recoverCursor("execution-1")).resolves.toMatchObject({ scope_digest: "scope-1" });
      await second.stop();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
