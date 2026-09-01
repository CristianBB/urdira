import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  JSTS_RUST_SYNTAX_BUILD_IDENTITY,
  RUST_WORKER_PROTOCOL_IDENTITY,
  RUST_WORKER_PROTOCOL_VERSION,
  createJavascriptTypescriptProcessTransport,
  createIndexingCoreProcessTransport,
  createRustSyntaxAnalyzeRequest,
  type JavascriptTypescriptProcessTransport,
} from "../packages/plugin-javascript-typescript/src/index.js";

async function fakeIndexingCoreWorker(behavior: "normal" | "hang" | "bad_event" | "unknown_request" | "missing_request" | "error_event" | "handshake_mismatch" | "exit" | "stderr" = "normal"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "urdira-indexing-core-transport-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "worker.mjs");
  const protocolPath = join(process.cwd(), "packages/plugin-javascript-typescript/dist/rust-protocol.js");
  await writeFile(path, `
    import { encodeRustWorkerMessage } from ${JSON.stringify(protocolPath)};
    import { Buffer } from "node:buffer";
    const behavior = ${JSON.stringify(behavior)};
    let pending = Buffer.alloc(0);
    let sequence = 0;
    const readVarint = (body, state) => { let value = 0; let factor = 1; while (true) { const byte = body[state.offset++]; value += (byte & 127) * factor; if ((byte & 128) === 0) return value; factor *= 128; } };
    const payloadOf = (body) => { const state = { offset: 0 }; while (state.offset < body.length) { const tag = readVarint(body, state); const field = Math.floor(tag / 8); if (tag % 8 === 0) { readVarint(body, state); } else { const length = readVarint(body, state); const value = body.subarray(state.offset, state.offset + length); state.offset += length; if (field === 8) return JSON.parse(value.toString("utf8")); } } throw new Error("missing payload"); };
    const respond = (request) => { if (behavior === "hang") return; sequence += 1; const event = behavior === "bad_event" ? 1 : behavior === "missing_request" ? { kind: "completed" } : behavior === "error_event" ? { kind: "error", request_id: request.request_id, code: "core:test", message: "test failure" } : behavior === "unknown_request" ? { kind: "completed", request_id: "indexing-core:unknown", operation_id: "op", generation: 1, group_count: 0, owner_count: 0, row_count: 0, ordered_digest: "sha256:test" } : request.kind === "handshake" ? { kind: "handshake_ack", request_id: request.request_id, protocol_identity: behavior === "handshake_mismatch" ? "urdira.indexing-core.wrong" : "urdira.indexing-core.v1", protocol_version: 1 } : request.kind === "shutdown" ? { kind: "shutdown_ack", request_id: request.request_id } : { kind: "completed", request_id: request.request_id, operation_id: request.operation_id ?? "op", generation: 1, group_count: 0, owner_count: 0, row_count: 0, ordered_digest: "sha256:test" }; for (const frame of encodeRustWorkerMessage(event, { stream_id: 100 + sequence, cancellation_id: request.request_id, byte_budget: 16 * 1024 * 1024, in_flight_budget: 16 * 1024 * 1024 })) process.stdout.write(frame); if (behavior === "exit") process.exit(0); };
    if (behavior === "stderr") process.stderr.write("x".repeat(70 * 1024));
    process.stdin.on("data", (chunk) => { pending = Buffer.concat([pending, chunk]); while (pending.length >= 4) { const length = pending.readUInt32BE(0); if (pending.length < length + 4) return; const body = pending.subarray(4, length + 4); pending = pending.subarray(length + 4); respond(payloadOf(body)); } });
  `, "utf8");
  await chmod(path, 0o700);
  return path;
}

type FakeWorkerBehavior = "normal" | "hang_analyze" | "hang_read" | "stdout_eof" | "abort";

const temporaryDirectories: string[] = [];
const transports: JavascriptTypescriptProcessTransport[] = [];

afterEach(async () => {
  await Promise.allSettled(transports.splice(0).map((transport) => transport.terminate()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fakeWorker(buildIdentity: string, behavior: FakeWorkerBehavior = "normal"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "urdira-rust-worker-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "worker.mjs");
  const source = `
    import { Buffer } from "node:buffer";
    const behavior = ${JSON.stringify(behavior)};
    const buildIdentity = ${JSON.stringify(buildIdentity)};
    const protocolIdentity = ${JSON.stringify(RUST_WORKER_PROTOCOL_IDENTITY)};
    const protocolVersion = ${JSON.stringify(RUST_WORKER_PROTOCOL_VERSION)};
    const varint = (value) => {
      const bytes = [];
      do { const byte = value % 128; value = Math.floor(value / 128); bytes.push(byte | (value === 0 ? 0 : 128)); } while (value !== 0);
      return Buffer.from(bytes);
    };
    const scalar = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);
    const bytes = (field, value) => Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
    const decodeFrame = (body) => {
      let offset = 0;
      const readVarint = () => { let value = 0; let factor = 1; while (true) { const byte = body[offset++]; value += (byte & 127) * factor; if ((byte & 128) === 0) return value; factor *= 128; } };
      const fields = new Map();
      while (offset < body.length) {
        const tag = readVarint(); const field = Math.floor(tag / 8); const wire = tag % 8;
        if (wire === 0) fields.set(field, readVarint());
        else { const length = readVarint(); fields.set(field, body.subarray(offset, offset + length)); offset += length; }
      }
      return fields;
    };
    const respond = (requestFrame, payload, cancellation = requestFrame.get(7)) => {
      const response = Buffer.from(JSON.stringify(payload));
      const responseBody = Buffer.concat([
        scalar(1, 2), scalar(2, requestFrame.get(2)), scalar(3, 0), scalar(4, 0),
        scalar(5, 16777216), scalar(6, 16777216), bytes(7, cancellation),
        bytes(8, response), scalar(9, 1),
      ]);
      const framed = Buffer.alloc(4 + responseBody.length);
      framed.writeUInt32BE(responseBody.length, 0);
      responseBody.copy(framed, 4);
      process.stdout.write(framed);
    };
    let pending = Buffer.alloc(0);
    let activeAnalysis;
    let cancelObserved = false;
    const handle = (requestFrame) => {
      const payload = JSON.parse(requestFrame.get(8).toString("utf8"));
      if (payload.kind === "handshake") {
        respond(requestFrame, {
          kind: "handshake_ack",
          request_id: payload.request_id,
          protocol_identity: protocolIdentity,
          protocol_version: protocolVersion,
          worker_build_identity: buildIdentity,
          max_frame_chunk_bytes: 262144,
          max_message_bytes: 16777216,
        }, Buffer.alloc(0));
        return;
      }
      if (payload.kind === "analyze" && behavior === "hang_analyze") return;
      if ((payload.kind === "read_facts" || payload.kind === "read_facts_group") && behavior === "hang_read") return;
      if (payload.kind === "analyze" && behavior === "stdout_eof") {
        process.stdout.end();
        setInterval(() => undefined, 1_000);
        return;
      }
      if (payload.kind === "analyze" && behavior === "abort") {
        activeAnalysis = { requestFrame, payload };
        return;
      }
      if (payload.kind === "cancel") {
        cancelObserved = true;
        respond(requestFrame, { kind: "cancel_ack", request_id: payload.request_id, cancellation_id: payload.cancellation_id });
        if (activeAnalysis !== undefined) {
          const cancelled = activeAnalysis;
          activeAnalysis = undefined;
          setTimeout(() => respond(cancelled.requestFrame, {
            kind: "cancelled",
            request_id: cancelled.payload.request_id,
            cancellation_id: cancelled.payload.cancellation_id,
          }), 10);
        }
        return;
      }
      if (payload.kind === "reset") {
        respond(requestFrame, { kind: "reset_ack", request_id: payload.request_id, reset_projects: cancelObserved ? 1 : 0 }, Buffer.alloc(0));
        return;
      }
      if (payload.kind === "shutdown") {
        respond(requestFrame, { kind: "shutdown_ack", request_id: payload.request_id }, Buffer.alloc(0));
        process.stdin.destroy();
        return;
      }
      if (payload.kind === "commit_analysis") {
        respond(requestFrame, { kind: "commit_analysis_ack", request_id: payload.request_id, project_key: payload.project_key, analysis_token: payload.analysis_token }, Buffer.alloc(0));
        return;
      }
      if (payload.kind === "read_facts") {
        respond(requestFrame, {
          kind: "facts_result",
          request_id: payload.request_id,
          cancellation_id: payload.cancellation_id,
          project_key: payload.project_key,
          path: payload.path,
          content_digest: "sha256:" + "1".repeat(64),
          language: "typescript",
          script_kind: "ts",
          byte_length: 1,
          parsed: true,
          direct_imports: [],
          records: [],
          dependencies: [],
          diagnostics: [],
          metrics: { bytes_transferred: 0, bytes_copied: 0 },
        });
        return;
      }
      if (payload.kind === "read_facts_group") {
        respond(requestFrame, {
          kind: "facts_group_result",
          request_id: payload.request_id,
          cancellation_id: payload.cancellation_id,
          project_key: payload.project_key,
          pages: payload.entries.map((entry) => ({
            kind: "facts_result",
            request_id: payload.request_id,
            cancellation_id: payload.cancellation_id,
            project_key: payload.project_key,
            path: entry.path,
            content_digest: "sha256:" + "1".repeat(64),
            language: "typescript",
            script_kind: "ts",
            byte_length: 1,
            parsed: true,
            direct_imports: [],
            records: [],
            dependencies: [],
            diagnostics: [],
            metrics: { bytes_transferred: 0, bytes_copied: 0 },
          })),
          metrics: { bytes_transferred: 0, bytes_copied: 0 },
        });
        return;
      }
      if (payload.kind === "analyze") {
        respond(requestFrame, {
          kind: "analysis_result",
          request_id: payload.request_id,
          cancellation_id: payload.cancellation_id,
          project_key: payload.project_key,
          analysis_token: "analysis:test",
          build: "unchanged",
          changed_files: [],
          affected_files: [],
          metrics: { bytes_read: 0, bytes_transferred: 0, bytes_copied: 0, bytes_decoded: 0, bytes_retained: 0 },
        });
      }
    };
    process.stdin.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const length = pending.readUInt32BE(0);
        if (pending.length < length + 4) return;
        const body = pending.subarray(4, length + 4);
        pending = pending.subarray(length + 4);
        handle(decodeFrame(body));
      }
    });
  `;
  await writeFile(path, source, "utf8");
  await chmod(path, 0o700);
  return path;
}

function transportFor(script: string, requestTimeoutMs = 500): JavascriptTypescriptProcessTransport {
  const transport = createJavascriptTypescriptProcessTransport({
    command: process.execPath,
    args: [script],
    expected_build_identity: JSTS_RUST_SYNTAX_BUILD_IDENTITY,
    request_timeout_ms: requestTimeoutMs,
  });
  transports.push(transport);
  return transport;
}

function analyzeRequest(requestId: string, cancellationId = `cancel:${requestId}`) {
  return createRustSyntaxAnalyzeRequest({
    request_id: requestId,
    cancellation_id: cancellationId,
    project_key: "project:test",
    configuration_digest: `sha256:${"0".repeat(64)}`,
    root_names: ["source.ts"],
    files: [{
      path: "source.ts",
      artifact_id: "artifact:test",
      artifact_version_id: "artifact-version:test",
      content_digest: `sha256:${"1".repeat(64)}`,
      source_blob_path: join(tmpdir(), "urdira-fake-source.ts"),
      byte_length: 1,
    }],
    max_output_bytes: 1024 * 1024,
    max_files: 1,
    max_source_bytes: 1024,
  });
}

describe("JavaScript/TypeScript Rust process transport", () => {
  it("accepts only the exact protocol and worker build identity", async () => {
    const script = await fakeWorker(JSTS_RUST_SYNTAX_BUILD_IDENTITY);
    const transport = transportFor(script);
    await expect(transport.ready()).resolves.toBeUndefined();
    expect(transport.is_healthy()).toBe(true);
    expect(transport.process_id).toBeGreaterThan(0);
  });

  it("rejects invalid process descriptors before spawning a writer", () => {
    expect(() => createIndexingCoreProcessTransport({ command: "" })).toThrow(/command is required/iu);
    expect(() => createIndexingCoreProcessTransport({ command: process.execPath, max_message_bytes: 0 })).toThrow(/max_message_bytes is invalid/iu);
    expect(() => createIndexingCoreProcessTransport({ command: process.execPath, request_timeout_ms: 0 })).toThrow(/request_timeout_ms is invalid/iu);
  });

  it.each(["hang", "bad_event", "unknown_request", "missing_request", "error_event", "handshake_mismatch"] as const)("fails closed on composition-worker %s", async (behavior) => {
    const script = await fakeIndexingCoreWorker(behavior);
    const transport = createIndexingCoreProcessTransport({ command: process.execPath, args: [script], request_timeout_ms: 1_000 });
    await expect(transport.ready()).rejects.toThrow();
    await expect(transport.terminate()).resolves.toBeUndefined();
  });

  it("fails closed when the composition worker exits without shutdown", async () => {
    const script = await fakeIndexingCoreWorker("exit");
    const transport = createIndexingCoreProcessTransport({ command: process.execPath, args: [script], request_timeout_ms: 250 });
    await expect(transport.ready()).resolves.toBeUndefined();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(transport.status("operation:test")).rejects.toThrow(/exited|unavailable/iu);
    await expect(transport.terminate()).resolves.toBeUndefined();
  });

  it("fails closed on a build mismatch and never exposes an in-process fallback", async () => {
    const script = await fakeWorker("sha256:wrong-build");
    const transport = transportFor(script);
    await expect(transport.ready()).rejects.toThrow(/build identity/iu);
    expect(transport.is_healthy()).toBe(false);
    expect("fallback" in transport).toBe(false);
  });

  it("terminates a worker when analyze exceeds its per-call deadline", async () => {
    const script = await fakeWorker(JSTS_RUST_SYNTAX_BUILD_IDENTITY, "hang_analyze");
    const transport = transportFor(script, 1_000);
    await transport.ready();
    await expect(transport.analyze(analyzeRequest("analyze:timeout"), {
      deadline_ms: Date.now() + 75,
    })).rejects.toThrow(/analyze request timed out/iu);
    expect(transport.is_healthy()).toBe(false);
  });

  it("terminates a worker when read_facts exceeds the descriptor timeout", async () => {
    const script = await fakeWorker(JSTS_RUST_SYNTAX_BUILD_IDENTITY, "hang_read");
    const transport = transportFor(script, 75);
    await transport.ready();
    await expect(transport.readFacts({
      project_key: "project:test",
      path: "source.ts",
      max_output_bytes: 1024 * 1024,
      max_rows: 4096,
      cancellation_id: "cancel:read-timeout",
    })).rejects.toThrow(/read_facts request timed out/iu);
    expect(transport.is_healthy()).toBe(false);
  });

  it("returns owner-delimited pages from one grouped facts request", async () => {
    const script = await fakeWorker(JSTS_RUST_SYNTAX_BUILD_IDENTITY);
    const transport = transportFor(script);
    await transport.ready();
    const result = await transport.readFactsGroup({
      project_key: "project:test",
      entries: [{ path: "a.ts" }, { path: "b.ts" }],
      max_output_bytes: 1024 * 1024,
      max_rows: 4096,
      cancellation_id: "cancel:read-group",
    });
    expect(result.pages.map((page) => page.path)).toEqual(["a.ts", "b.ts"]);
    expect(result.pages.every((page) => page.request_id === result.request_id)).toBe(true);
  });

  it("fails closed when stdout ends while the worker remains alive", async () => {
    const script = await fakeWorker(JSTS_RUST_SYNTAX_BUILD_IDENTITY, "stdout_eof");
    const transport = transportFor(script);
    await transport.ready();
    await expect(transport.analyze(analyzeRequest("analyze:eof"))).rejects.toThrow(/stdout ended before clean termination/iu);
    expect(transport.is_healthy()).toBe(false);
  });

  it("accepts stdout termination only after an acknowledged shutdown", async () => {
    const script = await fakeWorker(JSTS_RUST_SYNTAX_BUILD_IDENTITY);
    const transport = transportFor(script);
    await transport.ready();
    await expect(transport.shutdown({ deadline_ms: Date.now() + 500 })).resolves.toBeUndefined();
    expect(transport.is_healthy()).toBe(false);
  });

  it("cancels an aborted analysis, discards its late response, and remains healthy", async () => {
    const script = await fakeWorker(JSTS_RUST_SYNTAX_BUILD_IDENTITY, "abort");
    const transport = transportFor(script);
    await transport.ready();
    const controller = new AbortController();
    const analysis = transport.analyze(analyzeRequest("analyze:abort"), { signal: controller.signal });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error("test cancellation"));
    await expect(analysis).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(transport.is_healthy()).toBe(true);
    await expect(transport.reset("project:test")).resolves.toBe(1);
  });

  it("keeps the structural cutover on one framed Rust composition boundary", async () => {
    const script = await fakeIndexingCoreWorker();
    const transport = createIndexingCoreProcessTransport({ command: process.execPath, args: [script], request_timeout_ms: 1_000 });
    try {
      await expect(transport.ready()).resolves.toBeUndefined();
      const request = {
        operation_id: "operation:test", workspace_id: "workspace:test", candidate_generation_id: "candidate:test", database_path: ":memory:",
        cas_root: "/tmp/urdira-cas",
        source_snapshot_id: "snapshot:test", source_state_digest: "sha256:test", base_generation: 0,
        registry_snapshot_id: "registry:test", configuration_revision_id: "configuration:test", resolution_lock_id: "resolution:test",
        change_set: { kind: "full" as const }, engine: { engine_id: "engine:test", engine_version: "1", implementation_digest: "sha256:test" },
      };
      await expect(transport.indexGeneration(request)).resolves.toMatchObject({ kind: "completed" });
      await expect(transport.acceptGroup("operation:test", { owners: [] })).resolves.toMatchObject({ kind: "completed" });
      await expect(transport.analyzeSemanticGroup("operation:test", [])).resolves.toMatchObject({ kind: "completed" });
      await expect(transport.invokeSemantic("operation:test", {})).resolves.toMatchObject({ kind: "completed" });
      await expect(transport.acceptCanonicalGroup("operation:test", { owners: [] })).resolves.toMatchObject({ kind: "completed" });
      await expect(transport.finalizeGeneration("operation:test", { publication: "rust" })).resolves.toMatchObject({ kind: "completed" });
      await expect(transport.cancel("operation:test")).resolves.toMatchObject({ kind: "completed" });
      await expect(transport.status("operation:test")).resolves.toMatchObject({ kind: "completed" });
      await expect(transport.shutdown()).resolves.toBeUndefined();
    } finally {
      await transport.terminate();
    }
  });

  it("keeps a private cancellation sidecar alive while a generation is running", async () => {
    const script = await fakeIndexingCoreWorker("hang");
    const transport = createIndexingCoreProcessTransport({ command: process.execPath, args: [script], request_timeout_ms: 75 });
    const request = {
      operation_id: "operation:sidecar", workspace_id: "workspace:test", candidate_generation_id: "candidate:test", database_path: join(dirname(script), "workspace.sqlite"),
      cas_root: "/tmp/urdira-cas",
      source_snapshot_id: "snapshot:test", source_state_digest: "sha256:test", base_generation: 0,
      registry_snapshot_id: "registry:test", configuration_revision_id: "configuration:test", resolution_lock_id: "resolution:test",
      change_set: { kind: "full" as const }, engine: { engine_id: "engine:test", engine_version: "1", implementation_digest: "sha256:test" },
    };
    const generation = transport.indexGeneration(request);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const cancellation = transport.cancel("operation:sidecar");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const entries = await readdir(dirname(script));
    expect(entries.some((entry) => entry.includes(".urdira-cancel-"))).toBe(true);
    await Promise.allSettled([generation, cancellation]);
    expect((await readdir(dirname(script))).some((entry) => entry.includes(".urdira-cancel-"))).toBe(false);
    await transport.terminate();
  });
});
