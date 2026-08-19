import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DaemonError,
  EndpointDescriptorStore,
  LastKnownGoodStore,
  ProcessLock,
  LocalIpcClient,
  LocalIpcServer,
  normalizeLocalIpcEndpoint,
  daemonPaths,
  encodeUceFrame,
  LengthPrefixedDecoder,
  decodeUceFrame,
  type UceRequest,
  type UceResponse,
} from "../packages/daemon/src/index.js";
import { StorageError } from "../packages/storage/src/index.js";
import { EngineError } from "../packages/engine/src/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function request(overrides: Partial<UceRequest> = {}): UceRequest {
  return { protocol_version: 1, request_id: "request-1", call: "core:status", deadline_at: "2026-08-10T17:00:00.000Z", cancellation_id: "cancel-1", payload: { workspace_ids: ["workspace-1"] }, ...overrides };
}

describe("Phase 12 bounded UCE and daemon startup state", () => {
  it("maps filesystem socket paths to deterministic Windows named pipes", () => {
    const endpoint = normalizeLocalIpcEndpoint("C:\\Users\\runner\\urdira.sock", "win32");
    expect(endpoint).toMatch(/^\\\\\.\\pipe\\urdira-[0-9a-f]{64}$/);
    expect(normalizeLocalIpcEndpoint("C:\\Users\\runner\\urdira.sock", "win32")).toBe(endpoint);
  });

  it("round-trips a bounded length-prefixed request and rejects oversized frames", () => {
    const encoded = encodeUceFrame(request(), 4_096);
    expect(encoded.readUInt32BE(0)).toBe(encoded.byteLength - 4);
    expect(decodeUceFrame(encoded, 4_096)).toEqual(request());
    const decoder = new LengthPrefixedDecoder(4_096);
    expect(decoder.push(encoded.subarray(0, 3))).toEqual([]);
    expect(decoder.push(encoded.subarray(3))).toEqual([request()]);
    expect(() => encodeUceFrame(request({ payload: "x".repeat(5_000) }), 128)).toThrowError(DaemonError);
  });

  it("creates owner-only paths and writes an atomic endpoint descriptor", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase12-")); roots.push(root);
    const paths = await daemonPaths(root);
    expect(paths.data_root).toBe(root);
    const store = new EndpointDescriptorStore(paths);
    const descriptor = await store.write({ protocol_version: 1, endpoint: paths.endpoint, pid: process.pid, owner_uid: process.getuid?.() ?? 0, engine_build_id: "build-1", started_at: "2026-08-10T16:00:00.000Z" });
    expect(await store.read()).toMatchObject(descriptor);
    expect((await readFile(paths.endpoint_descriptor, "utf8")).length).toBeGreaterThan(0);
  });

  it("rejects a live process lock and recovers a stale lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase12-")); roots.push(root);
    const paths = await daemonPaths(root);
    const first = await ProcessLock.acquire(paths.process_lock, { pid: process.pid, started_at: "2026-08-10T16:00:00.000Z" });
    await expect(ProcessLock.acquire(paths.process_lock, { pid: process.pid, started_at: "2026-08-10T16:01:00.000Z" })).rejects.toMatchObject({ code: "core:daemon_already_running" });
    await first.release();
    const stale = await ProcessLock.acquire(paths.process_lock, { pid: 999_999_999, started_at: "2026-08-10T16:00:00.000Z" });
    await stale.release();
    expect(await readFile(paths.process_lock, "utf8").catch(() => "")).toBe("");
  });

  it("persists and verifies the last-known-good checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase12-")); roots.push(root);
    const paths = await daemonPaths(root);
    const store = new LastKnownGoodStore(paths);
    await store.write({ engine_build_id: "build-1", checkpoint_id: "checkpoint-1", workspaces: ["workspace-1"], cursors: ["cursor-1"], written_at: "2026-08-10T16:00:00.000Z" });
    expect(await store.read()).toMatchObject({ checkpoint_id: "checkpoint-1", cursors: ["cursor-1"] });
    await expect(store.verify({ engine_build_id: "build-2" })).rejects.toMatchObject({ code: "core:daemon_restart_required" });
  });

  it("correlates progress and cancellation over the local socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase12-")); roots.push(root);
    const endpoint = join(root, "ipc.sock");
    const server = new LocalIpcServer({ endpoint, handler: async (_request, context) => {
      context.reportProgress({ phase: "started", completed: 0, total: 1 });
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { finished: !context.signal.aborted };
    } });
    await server.listen();
    const progress: string[] = []; const controller = new AbortController();
    const responsePromise = new LocalIpcClient({ endpoint }).request("core:wait", {}, { signal: controller.signal, on_progress: (event) => progress.push(event.phase) });
    await new Promise((resolve) => setTimeout(resolve, 5)); controller.abort();
    await expect(responsePromise).resolves.toMatchObject({ outcome: "cancelled" });
    expect(progress).toEqual(["started"]);
    await server.close();
  });

  it("enforces a deadline and rejects duplicate correlation ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase12-")); roots.push(root);
    const endpoint = join(root, "deadline.sock"); let duplicateCalls = 0;
    const server = new LocalIpcServer({ endpoint, handler: async (requestValue, context) => { if (requestValue.request_id === "duplicate") { duplicateCalls++; return { done: true }; } await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true })); return { done: true }; } });
    await server.listen();
    await expect(new LocalIpcClient({ endpoint, request_timeout_ms: 10 }).request("core:wait", {})).rejects.toMatchObject({ code: "core:ipc_timeout" });
    const socket = connect(normalizeLocalIpcEndpoint(endpoint)); const decoder = new LengthPrefixedDecoder(); const responses: unknown[] = [];
    socket.on("data", (chunk) => responses.push(...decoder.push(chunk).filter((frame) => "outcome" in frame)));
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const duplicateRequest = request({ request_id: "duplicate", call: "core:echo", deadline_at: "2099-01-01T00:00:00.000Z" });
    socket.write(encodeUceFrame(duplicateRequest));
    socket.write(encodeUceFrame(duplicateRequest));
    await new Promise((resolve) => setTimeout(resolve, 20)); socket.end();
    expect(responses).toHaveLength(2);
    const duplicateError = responses.find((response) => (response as { error?: { code: string } }).error) as { error?: { code: string } } | undefined;
    expect(duplicateError?.error?.code).toBe("core:ipc_request_invalid");
    expect(duplicateCalls).toBe(1);
    await server.close();
  });

  it("preserves a StorageError's registered code and details across the wire", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase12-")); roots.push(root);
    const endpoint = join(root, "storage-error.sock");
    const server = new LocalIpcServer({ endpoint, handler: async () => { throw new StorageError("storage:repair_source_missing", "Exact CAS repair requires a verified backup directory.", { component_kind: "cas" }); } });
    await server.listen();
    const response = await new LocalIpcClient({ endpoint }).request("core:repair", {});
    expect(response.outcome).toBe("error");
    expect(response.error).toEqual({ code: "storage:repair_source_missing", message: "Exact CAS repair requires a verified backup directory.", details: { component_kind: "cas" } });
    await server.close();
  });

  it("preserves an EngineError's registered code across the wire", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase12-")); roots.push(root);
    const endpoint = join(root, "engine-error.sock");
    const server = new LocalIpcServer({ endpoint, handler: async () => { throw new EngineError("core:semantic_index_unavailable", "No semantic index is available."); } });
    await server.listen();
    const response = await new LocalIpcClient({ endpoint }).request("core:query", {});
    expect(response.outcome).toBe("error");
    expect(response.error?.code).toBe("core:semantic_index_unavailable");
    // `EngineError`'s own `message` is always `${code}: ${message}`.
    expect(response.error?.message).toBe("core:semantic_index_unavailable: No semantic index is available.");
    expect(response.error?.details).toEqual({});
    await server.close();
  });

  it("still wraps a plain Error as core:execution_failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase12-")); roots.push(root);
    const endpoint = join(root, "plain-error.sock");
    const server = new LocalIpcServer({ endpoint, handler: async () => { throw new Error("boom"); } });
    await server.listen();
    const response = await new LocalIpcClient({ endpoint }).request("core:status", {});
    expect(response.outcome).toBe("error");
    expect(response.error?.code).toBe("core:execution_failed");
    expect(response.error?.message).toBe("boom");
    await server.close();
  });

  it("still wraps a Node system error with a non-namespaced code as core:execution_failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase12-")); roots.push(root);
    const endpoint = join(root, "enoent-error.sock");
    const server = new LocalIpcServer({ endpoint, handler: async () => {
      const error = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    } });
    await server.listen();
    const response = await new LocalIpcClient({ endpoint }).request("core:status", {});
    expect(response.outcome).toBe("error");
    expect(response.error?.code).toBe("core:execution_failed");
    expect(response.error?.message).toBe("ENOENT: no such file or directory");
    await server.close();
  });

  it("resolves an oversized response as a typed error promptly, not via the client's own request timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase12-")); roots.push(root);
    const endpoint = join(root, "oversized-response-client.sock");
    // A handler result too large to fit `max_frame_bytes` -- mirrors
    // `core:find_records` embedding a huge record body. Before this fix, the
    // server's `LocalIpcServer.write` swallowed `encodeUceFrame`'s
    // `core:ipc_frame_too_large` into a bare `socket.destroy()`, leaving the
    // client with no error frame to key off of: it only ever discovered the
    // failure by hitting its own `request_timeout_ms` deadline.
    const server = new LocalIpcServer({ endpoint, max_frame_bytes: 4_096, handler: async () => ({ record: { body: "x".repeat(20_000) } }) });
    await server.listen();
    const startedAt = Date.now();
    const response = await new LocalIpcClient({ endpoint, request_timeout_ms: 2_000 }).request("core:find_records", {});
    const elapsedMs = Date.now() - startedAt;
    expect(response.outcome).toBe("error");
    expect(response.error?.code).toBe("core:ipc_frame_too_large");
    expect(response.error?.message).toContain("core:find_records");
    // Resolved via the compact fallback error frame, not the client's own
    // 2-second deadline -- proves the daemon answered instead of the socket
    // just hanging until the client gave up.
    expect(elapsedMs).toBeLessThan(1_000);
    await server.close();
  });

  it("keeps a connection alive after an oversized response, so a later request on the same socket still completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase12-")); roots.push(root);
    const endpoint = join(root, "oversized-response-socket.sock");
    const server = new LocalIpcServer({
      endpoint,
      max_frame_bytes: 4_096,
      handler: async (requestValue) => (requestValue.call === "core:find_records" ? { record: { body: "x".repeat(20_000) } } : { ok: true }),
    });
    await server.listen();
    const socket = connect(normalizeLocalIpcEndpoint(endpoint));
    const decoder = new LengthPrefixedDecoder();
    const responses: UceResponse[] = [];
    socket.on("data", (chunk) => responses.push(...decoder.push(chunk).filter((frame): frame is UceResponse => "outcome" in frame)));
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(encodeUceFrame(request({ request_id: "oversized-1", call: "core:find_records", deadline_at: "2099-01-01T00:00:00.000Z" })));
    await new Promise<void>((resolve) => { const check = (): void => (responses.length >= 1 ? resolve() : void setTimeout(check, 5)); check(); });
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ request_id: "oversized-1", outcome: "error", error: { code: "core:ipc_frame_too_large" } });
    expect(socket.destroyed).toBe(false);
    // The socket was kept alive (not destroyed) by the fix above -- a
    // normal, small-response request on the SAME connection still completes.
    socket.write(encodeUceFrame(request({ request_id: "after-oversized", call: "core:status", deadline_at: "2099-01-01T00:00:00.000Z" })));
    await new Promise<void>((resolve) => { const check = (): void => (responses.length >= 2 ? resolve() : void setTimeout(check, 5)); check(); });
    expect(responses).toHaveLength(2);
    expect(responses[1]).toMatchObject({ request_id: "after-oversized", outcome: "success" });
    socket.end();
    await server.close();
  });
});
