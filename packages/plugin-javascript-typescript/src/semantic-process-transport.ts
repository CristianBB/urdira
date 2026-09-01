import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { deserialize, serialize } from "node:v8";
import type { FactDeltaStreamBatch } from "@urdira/contracts";
import { buildSealedFactDeltaStreamBatch, validateFactDeltaStreamBatch, validateFactDeltaStreamHeader, type FactDeltaStream, type PluginWorkerRequestEnvelope, type WorkerTransport } from "@urdira/plugin-sdk";
import { JAVASCRIPT_TYPESCRIPT_VERSION, TYPESCRIPT_COMPILER_VERSION } from "./analyzer.js";
import { decodeRustWorkerMessage, MAX_RUST_WORKER_MESSAGE_BYTES, RustWorkerFrameDecoder } from "./rust-protocol.js";
import type { JavascriptTypescriptWorkerDescriptor } from "./worker.js";

export const JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION = "1.9.0" as const;
export const JSTS_SEMANTIC_PROCESS_BUILD_IDENTITY = `urdira:jsts-semantic-process:${JAVASCRIPT_TYPESCRIPT_VERSION}:typescript-${TYPESCRIPT_COMPILER_VERSION}:protocol-1.9.native-observation-projection-v1` as const;
export const JSTS_SEMANTIC_PROCESS_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
export const JSTS_SEMANTIC_GROUP_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const JSTS_SEMANTIC_GROUP_MAX_OWNERS = 32;

export type JavascriptTypescriptSemanticWorkerDescriptor = Omit<
  JavascriptTypescriptWorkerDescriptor,
  "on_analysis_build" | "on_analysis_cache_load" | "on_analysis_incremental" | "on_rust_semantic_owner_analyze"
>;

export interface JavascriptTypescriptSemanticProcessDescriptor {
  /** Exact Node executable selected by the prepared runtime or autonomous launcher. */
  readonly node_executable: string;
  readonly worker: JavascriptTypescriptSemanticWorkerDescriptor;
  /** Test-only entrypoint override. Production resolves the package-owned worker. */
  readonly worker_entrypoint?: string | URL;
  /** Exact core-owned addon already verified by the composition root. */
  readonly structural_kernel_addon_path?: string;
  readonly max_message_bytes?: number;
  readonly handshake_timeout_ms?: number;
  readonly control_timeout_ms?: number;
  readonly termination_grace_ms?: number;
  readonly max_in_flight_requests?: number;
}

export interface JavascriptTypescriptSemanticProcessTransport extends WorkerTransport {
  readonly process_id: number;
  ready(): Promise<void>;
  is_healthy(): boolean;
  invokeFactDeltaStream(request: PluginWorkerRequestEnvelope): Promise<FactDeltaStream>;
  invokeFactDeltaStreamGroup(requests: readonly PluginWorkerRequestEnvelope[]): Promise<readonly FactDeltaStream[]>;
}

interface PendingResponse {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

const MAX_NODE_TIMEOUT_MS = 2_147_000_000;

type HostMessage =
  | { readonly protocol_version: typeof JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION; readonly kind: "handshake"; readonly request_id: string; readonly build_identity: typeof JSTS_SEMANTIC_PROCESS_BUILD_IDENTITY; readonly max_message_bytes: number; readonly structural_kernel_addon_path: string | null; readonly worker: JavascriptTypescriptSemanticWorkerDescriptor }
  | { readonly protocol_version: typeof JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION; readonly kind: "invoke"; readonly request_id: string; readonly request: PluginWorkerRequestEnvelope }
  | { readonly protocol_version: typeof JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION; readonly kind: "stream_start"; readonly request_id: string; readonly request: PluginWorkerRequestEnvelope }
  | { readonly protocol_version: typeof JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION; readonly kind: "stream_next"; readonly request_id: string; readonly stream_id: string; readonly expected_sequence: number }
  | { readonly protocol_version: typeof JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION; readonly kind: "semantic_group_start"; readonly request_id: string; readonly requests: readonly PluginWorkerRequestEnvelope[] }
  | { readonly protocol_version: typeof JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION; readonly kind: "semantic_group_next"; readonly request_id: string; readonly group_id: string; readonly expected_owner_index: number }
  | { readonly protocol_version: typeof JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION; readonly kind: "cancel"; readonly request_id: string; readonly cancellation_id: string }
  | { readonly protocol_version: typeof JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION; readonly kind: "reset"; readonly request_id: string }
  | { readonly protocol_version: typeof JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION; readonly kind: "shutdown"; readonly request_id: string };

type WorkerMessage =
  | { readonly protocol_version: typeof JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION; readonly kind: "handshake_ack"; readonly request_id: string; readonly build_identity: string; readonly node_version: string; readonly max_message_bytes: number }
  | { readonly protocol_version: typeof JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION; readonly kind: "result"; readonly request_id: string; readonly result: unknown }
  | { readonly protocol_version: typeof JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION; readonly kind: "stream_header"; readonly request_id: string; readonly stream_id: string; readonly header: FactDeltaStream["header"] }
  | { readonly protocol_version: typeof JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION; readonly kind: "stream_batch"; readonly request_id: string; readonly stream_id: string; readonly batch: FactDeltaStreamBatch }
  | { readonly protocol_version: typeof JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION; readonly kind: "semantic_group_header"; readonly request_id: string; readonly group_id: string; readonly streams: readonly { readonly owner_index: number; readonly stream_id: string; readonly header: FactDeltaStream["header"] }[] }
  | { readonly protocol_version: typeof JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION; readonly kind: "semantic_group_batch"; readonly request_id: string; readonly group_id: string; readonly next_owner_index: number; readonly final: boolean; readonly owners: readonly { readonly owner_index: number; readonly stream_id: string; readonly batches: readonly PackedSemanticBatch[] }[] }
  | { readonly protocol_version: typeof JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION; readonly kind: "error"; readonly request_id: string; readonly error: { readonly name: string; readonly message: string } }
  | { readonly protocol_version: typeof JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION; readonly kind: "cancel_ack"; readonly request_id: string; readonly cancellation_id: string }
  | { readonly protocol_version: typeof JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION; readonly kind: "shutdown_ack"; readonly request_id: string };

type PackedSemanticBatch = {
  readonly metadata: Omit<FactDeltaStreamBatch, "records" | "dependencies">;
  readonly canonical_records: readonly string[];
  readonly canonical_dependencies: readonly string[];
};

const PACKED_BATCH_METADATA_KEYS = [
  "protocol_version", "schema_id", "fact_delta_id", "sequence", "final",
  "record_count", "dependency_count", "row_count", "byte_length", "chunk_digest",
] as const;

function validatePackedSemanticBatch(value: unknown): PackedSemanticBatch {
  const packed = recordOf(value);
  const metadata = recordOf(packed?.["metadata"]);
  if (packed === undefined || !hasExactKeys(packed, ["metadata", "canonical_records", "canonical_dependencies"])
    || metadata === undefined || !hasExactKeys(metadata, PACKED_BATCH_METADATA_KEYS)) {
    throw new Error("JavaScript/TypeScript semantic worker returned an invalid packed batch envelope.");
  }
  const canonicalRecords = packed["canonical_records"];
  const canonicalDependencies = packed["canonical_dependencies"];
  if (!Number.isSafeInteger(metadata["sequence"]) || Number(metadata["sequence"]) < 0
    || typeof metadata["final"] !== "boolean"
    || !Number.isSafeInteger(metadata["record_count"]) || !Number.isSafeInteger(metadata["dependency_count"])
    || !Array.isArray(canonicalRecords) || canonicalRecords.length !== metadata["record_count"] || canonicalRecords.some((row) => typeof row !== "string")
    || !Array.isArray(canonicalDependencies) || canonicalDependencies.length !== metadata["dependency_count"] || canonicalDependencies.some((row) => typeof row !== "string")) {
    throw new Error("JavaScript/TypeScript semantic worker returned an inconsistent packed batch.");
  }
  return {
    metadata: metadata as unknown as PackedSemanticBatch["metadata"],
    canonical_records: canonicalRecords as string[],
    canonical_dependencies: canonicalDependencies as string[],
  };
}

function unpackSemanticBatch(value: PackedSemanticBatch): FactDeltaStreamBatch {
  return buildSealedFactDeltaStreamBatch(value.metadata, {
    canonical_records: value.canonical_records,
    canonical_dependencies: value.canonical_dependencies,
  });
}

function semanticWorkerEntrypoint(): URL {
  const indexUrl = import.meta.resolve("@urdira/plugin-javascript-typescript");
  return new URL("semantic-process-worker.js", indexUrl);
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateWorkerMessage(value: unknown): WorkerMessage {
  const message = recordOf(value);
  if (message === undefined || message["protocol_version"] !== JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION || typeof message["request_id"] !== "string") {
    throw new Error("JavaScript/TypeScript semantic worker returned an invalid protocol envelope.");
  }
  switch (message["kind"]) {
    case "handshake_ack":
      if (!hasExactKeys(message, ["protocol_version", "kind", "request_id", "build_identity", "node_version", "max_message_bytes"])
        || typeof message["build_identity"] !== "string" || typeof message["node_version"] !== "string" || !Number.isSafeInteger(message["max_message_bytes"])) break;
      return message as unknown as WorkerMessage;
    case "result":
      if (!hasExactKeys(message, ["protocol_version", "kind", "request_id", "result"])) break;
      return message as unknown as WorkerMessage;
    case "stream_header":
      if (!hasExactKeys(message, ["protocol_version", "kind", "request_id", "stream_id", "header"]) || typeof message["stream_id"] !== "string") break;
      validateFactDeltaStreamHeader(message["header"]);
      return message as unknown as WorkerMessage;
    case "stream_batch":
      if (!hasExactKeys(message, ["protocol_version", "kind", "request_id", "stream_id", "batch"]) || typeof message["stream_id"] !== "string") break;
      validateFactDeltaStreamBatch(message["batch"]);
      return message as unknown as WorkerMessage;
    case "semantic_group_header": {
      if (!hasExactKeys(message, ["protocol_version", "kind", "request_id", "group_id", "streams"])
        || typeof message["group_id"] !== "string" || !Array.isArray(message["streams"])
        || message["streams"].length === 0 || message["streams"].length > JSTS_SEMANTIC_GROUP_MAX_OWNERS) break;
      const seenOwners = new Set<number>();
      const seenStreams = new Set<string>();
      let validGroup = true;
      for (const value of message["streams"]) {
        const stream = recordOf(value);
        if (stream === undefined || !hasExactKeys(stream, ["owner_index", "stream_id", "header"])
          || !Number.isSafeInteger(stream["owner_index"]) || Number(stream["owner_index"]) < 0
          || Number(stream["owner_index"]) >= message["streams"].length || typeof stream["stream_id"] !== "string"
        ) { validGroup = false; break; }
        const ownerIndex = Number(stream["owner_index"]);
        if (seenOwners.has(ownerIndex) || seenStreams.has(stream["stream_id"])) { validGroup = false; break; }
        seenOwners.add(ownerIndex);
        seenStreams.add(stream["stream_id"]);
        validateFactDeltaStreamHeader(stream["header"]);
      }
      if (!validGroup || seenOwners.size !== message["streams"].length) break;
      return message as unknown as WorkerMessage;
    }
    case "semantic_group_batch": {
      if (!hasExactKeys(message, ["protocol_version", "kind", "request_id", "group_id", "next_owner_index", "final", "owners"])
        || typeof message["group_id"] !== "string" || !Number.isSafeInteger(message["next_owner_index"])
        || Number(message["next_owner_index"]) < 0 || typeof message["final"] !== "boolean"
        || !Array.isArray(message["owners"]) || message["owners"].length === 0 || message["owners"].length > JSTS_SEMANTIC_GROUP_MAX_OWNERS) break;
      let priorOwner = -1;
      let validGroup = true;
      const normalizedOwners: { owner_index: number; stream_id: string; batches: PackedSemanticBatch[] }[] = [];
      for (const value of message["owners"]) {
        const owner = recordOf(value);
        if (owner === undefined || !hasExactKeys(owner, ["owner_index", "stream_id", "batches"])
          || !Number.isSafeInteger(owner["owner_index"]) || Number(owner["owner_index"]) <= priorOwner
          || typeof owner["stream_id"] !== "string" || !Array.isArray(owner["batches"]) || owner["batches"].length === 0) {
          validGroup = false;
          break;
        }
        priorOwner = Number(owner["owner_index"]);
        normalizedOwners.push({
          owner_index: priorOwner,
          stream_id: owner["stream_id"],
          batches: owner["batches"].map(validatePackedSemanticBatch),
        });
      }
      if (!validGroup) break;
      return { ...message, owners: normalizedOwners } as unknown as WorkerMessage;
    }
    case "error": {
      const error = recordOf(message["error"]);
      if (!hasExactKeys(message, ["protocol_version", "kind", "request_id", "error"]) || error === undefined
        || !hasExactKeys(error, ["name", "message"]) || typeof error["name"] !== "string" || typeof error["message"] !== "string") break;
      return message as unknown as WorkerMessage;
    }
    case "cancel_ack":
      if (!hasExactKeys(message, ["protocol_version", "kind", "request_id", "cancellation_id"]) || typeof message["cancellation_id"] !== "string") break;
      return message as unknown as WorkerMessage;
    case "shutdown_ack":
      if (!hasExactKeys(message, ["protocol_version", "kind", "request_id"])) break;
      return message as unknown as WorkerMessage;
  }
  throw new Error("JavaScript/TypeScript semantic worker returned a non-closed protocol message.");
}

class LengthPrefixedDecoder {
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  constructor(private readonly maxMessageBytes: number) {}

  push(chunk: Buffer): unknown[] {
    this.#buffer = this.#buffer.byteLength === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const messages: unknown[] = [];
    while (this.#buffer.byteLength >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0 || length > this.maxMessageBytes) throw new Error("JavaScript/TypeScript semantic worker response exceeds the message limit.");
      if (this.#buffer.byteLength < length + 4) break;
      messages.push(deserialize(this.#buffer.subarray(4, length + 4)));
      this.#buffer = this.#buffer.subarray(length + 4);
    }
    if (this.#buffer.byteLength > this.maxMessageBytes + 4) throw new Error("JavaScript/TypeScript semantic worker exceeded the bounded receive buffer.");
    return messages;
  }
}

function encodeMessage(message: HostMessage, maxMessageBytes: number): Buffer {
  const payload = serialize(message);
  if (payload.byteLength === 0 || payload.byteLength > maxMessageBytes) {
    throw new Error(`JavaScript/TypeScript semantic process message exceeds the ${maxMessageBytes}-byte message limit.`);
  }
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

function positiveBoundedInteger(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) throw new Error(`${label} is invalid.`);
  return selected;
}

export function createJavascriptTypescriptSemanticProcessTransport(
  descriptor: JavascriptTypescriptSemanticProcessDescriptor,
): JavascriptTypescriptSemanticProcessTransport {
  if (descriptor.node_executable.length === 0 || !isAbsolute(descriptor.node_executable)) throw new Error("The exact absolute Node executable is required for the JavaScript/TypeScript semantic process.");
  const maxMessageBytes = positiveBoundedInteger(descriptor.max_message_bytes, JSTS_SEMANTIC_PROCESS_MAX_MESSAGE_BYTES, JSTS_SEMANTIC_PROCESS_MAX_MESSAGE_BYTES, "Semantic process max_message_bytes");
  const handshakeTimeoutMs = positiveBoundedInteger(descriptor.handshake_timeout_ms, 5_000, 60_000, "Semantic process handshake_timeout_ms");
  const controlTimeoutMs = positiveBoundedInteger(descriptor.control_timeout_ms, 5_000, 60_000, "Semantic process control_timeout_ms");
  const terminationGraceMs = positiveBoundedInteger(descriptor.termination_grace_ms, 1_000, 10_000, "Semantic process termination_grace_ms");
  const maxInFlightRequests = positiveBoundedInteger(descriptor.max_in_flight_requests, 4, 64, "Semantic process max_in_flight_requests");
  const entrypoint = descriptor.worker_entrypoint ?? semanticWorkerEntrypoint();
  const entrypointPath = entrypoint instanceof URL ? fileURLToPath(entrypoint) : entrypoint;
  if (!isAbsolute(entrypointPath)) throw new Error("The JavaScript/TypeScript semantic worker entrypoint must be absolute.");
  if (descriptor.structural_kernel_addon_path !== undefined && !isAbsolute(descriptor.structural_kernel_addon_path)) throw new Error("The structural kernel addon path must be absolute.");
  const child = spawn(descriptor.node_executable, [entrypointPath], {
    cwd: tmpdir(),
    env: {},
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  if (child.pid === undefined) {
    child.kill();
    throw new Error("JavaScript/TypeScript semantic worker did not expose a process identity.");
  }
  const processId = child.pid;
  const decoder = new LengthPrefixedDecoder(maxMessageBytes);
  const streamDecoder = new RustWorkerFrameDecoder(MAX_RUST_WORKER_MESSAGE_BYTES);
  const streamOutput = child.stdio[3];
  if (streamOutput === null || streamOutput === undefined) throw new Error("JavaScript/TypeScript semantic worker stream channel is unavailable.");
  const pending = new Map<string, PendingResponse>();
  const streamCancellationById = new Map<string, string>();
  let nextRequestId = 1;
  let healthy = true;
  let handshakeComplete = false;
  let terminating = false;
  let expectedExit = false;
  let exited = false;
  let writeChain = Promise.resolve();

  const clearPendingTimer = (entry: PendingResponse): void => {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
  };
  const failClosed = (cause: unknown): Error => {
    const error = errorOf(cause);
    if (healthy) {
      healthy = false;
      for (const entry of pending.values()) {
        clearPendingTimer(entry);
        entry.reject(error);
      }
      pending.clear();
      if (!child.killed && !exited) child.kill();
    }
    return error;
  };
  const write = (message: HostMessage): Promise<void> => {
    let frame: Buffer;
    try { frame = encodeMessage(message, maxMessageBytes); }
    catch (error) { return Promise.reject(errorOf(error)); }
    const operation = writeChain.then(() => new Promise<void>((resolve, reject) => {
      if (!healthy || terminating || child.stdin.destroyed) { reject(new Error("JavaScript/TypeScript semantic worker process is unavailable.")); return; }
      child.stdin.write(frame, (error) => error === null || error === undefined ? resolve() : reject(error));
    }));
    writeChain = operation.catch(() => undefined);
    return operation.catch((error) => { throw failClosed(error); });
  };
  const send = (message: HostMessage, timeoutMs?: number, timeoutLabel = "control request"): Promise<unknown> => {
    if (!healthy || terminating) return Promise.reject(new Error("JavaScript/TypeScript semantic worker process is unavailable."));
    if (pending.has(message.request_id)) return Promise.reject(failClosed(new Error("JavaScript/TypeScript semantic process request identity is already in flight.")));
    const pendingLimit = message.kind === "invoke" ? maxInFlightRequests : maxInFlightRequests + 1;
    if (pending.size >= pendingLimit) return Promise.reject(new Error("JavaScript/TypeScript semantic process in-flight request budget is exhausted."));
    let entry: PendingResponse;
    const response = new Promise<unknown>((resolve, reject) => {
      entry = { resolve, reject };
      if (timeoutMs !== undefined) {
        const expiresAt = Date.now() + timeoutMs;
        const armTimeout = (): void => {
          const remaining = expiresAt - Date.now();
          if (remaining <= 0) { failClosed(new Error(`JavaScript/TypeScript semantic process ${timeoutLabel} timed out.`)); return; }
          entry.timer = setTimeout(armTimeout, Math.min(remaining, MAX_NODE_TIMEOUT_MS));
          entry.timer.unref?.();
        };
        armTimeout();
      }
      pending.set(message.request_id, entry);
    });
    void write(message).catch((error) => {
      const current = pending.get(message.request_id);
      if (current === undefined) return;
      pending.delete(message.request_id);
      clearPendingTimer(current);
      current.reject(errorOf(error));
    });
    return response;
  };

  const acceptWorkerMessage = (decoded: unknown): WorkerMessage => {
    const message = validateWorkerMessage(decoded);
    const entry = pending.get(message.request_id);
    if (entry === undefined) throw new Error("JavaScript/TypeScript semantic worker returned an unknown or duplicate request identity.");
    pending.delete(message.request_id);
    clearPendingTimer(entry);
    if (message.kind === "error") entry.reject(new Error(`${message.error.name}: ${message.error.message}`));
    else entry.resolve(message);
    return message;
  };
  child.stdout.on("data", (chunk: Buffer) => {
    try { for (const decoded of decoder.push(chunk)) acceptWorkerMessage(decoded); }
    catch (error) { failClosed(error); }
  });
  streamOutput.on("data", (chunk: Buffer) => {
    try {
      for (const framed of streamDecoder.push(chunk)) {
        const message = validateWorkerMessage(decodeRustWorkerMessage(framed.payload));
        const expectedCancellation = message.kind === "stream_header"
          ? message.header.cancellation_id
          : message.kind === "stream_batch" ? streamCancellationById.get(message.stream_id) : undefined;
        if (expectedCancellation === undefined || expectedCancellation !== framed.cancellation_id) throw new Error("JavaScript/TypeScript semantic stream cancellation identity changed across framing.");
        acceptWorkerMessage(message);
      }
    } catch (error) { failClosed(error); }
  });
  let stderrBytes = 0;
  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-8 * 1024);
    if (stderrBytes > 64 * 1024) failClosed(new Error("JavaScript/TypeScript semantic worker exceeded its bounded stderr allowance."));
  });
  child.once("error", (error) => failClosed(error));
  child.once("exit", (code, signal) => {
    exited = true;
    if (!terminating && healthy && (!expectedExit || pending.size > 0)) {
      const detail = stderrTail.replace(/[\0\r\n]+/gu, " ").trim();
      failClosed(new Error(`JavaScript/TypeScript semantic worker exited before shutdown (${code ?? signal ?? "unknown"})${detail.length === 0 ? "" : `: ${detail}`}.`));
    }
  });

  const handshakeRequestId = `handshake:${nextRequestId++}`;
  const handshake = send({
    protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION,
    kind: "handshake",
    request_id: handshakeRequestId,
    build_identity: JSTS_SEMANTIC_PROCESS_BUILD_IDENTITY,
    max_message_bytes: maxMessageBytes,
    structural_kernel_addon_path: descriptor.structural_kernel_addon_path ?? null,
    worker: descriptor.worker,
  }, handshakeTimeoutMs, "handshake").then((value) => {
    const message = value as WorkerMessage;
    if (message.kind !== "handshake_ack") throw failClosed(new Error("JavaScript/TypeScript semantic worker did not acknowledge the handshake."));
    if (message.build_identity !== JSTS_SEMANTIC_PROCESS_BUILD_IDENTITY) throw failClosed(new Error("JavaScript/TypeScript semantic worker build identity does not match the installed package."));
    if (message.node_version !== process.versions.node) throw failClosed(new Error("JavaScript/TypeScript semantic worker Node version does not match the supervising runtime."));
    if (message.max_message_bytes !== maxMessageBytes) throw failClosed(new Error("JavaScript/TypeScript semantic worker advertised an incompatible message limit."));
    handshakeComplete = true;
  });
  handshake.catch(() => undefined);

  const ready = async (): Promise<void> => {
    await handshake;
    if (!healthy || !handshakeComplete || terminating) throw new Error("JavaScript/TypeScript semantic worker handshake was not accepted.");
  };
  const control = async (message: HostMessage): Promise<WorkerMessage> => {
    await ready();
    return await send(message, controlTimeoutMs) as WorkerMessage;
  };

  return {
    process_id: processId,
    ready,
    is_healthy: () => healthy && handshakeComplete && !terminating && !exited,
    async invoke(request): Promise<unknown> {
      await ready();
      const deadlineAt = Date.parse(request.deadline);
      if (!Number.isFinite(deadlineAt)) throw new Error("JavaScript/TypeScript semantic request deadline is invalid.");
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new Error("JavaScript/TypeScript semantic request deadline has already expired.");
      const requestId = `invoke:${nextRequestId++}`;
      const value = await send({ protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION, kind: "invoke", request_id: requestId, request }, remaining, "request deadline");
      const message = value as WorkerMessage;
      if (message.kind !== "result") throw failClosed(new Error("JavaScript/TypeScript semantic worker returned the wrong response kind for invoke."));
      return message.result;
    },
    async invokeFactDeltaStream(request): Promise<FactDeltaStream> {
      await ready();
      if (request.call !== "analyze_artifact") throw new Error("Direct FactDeltaStream emission is limited to analyze_artifact.");
      const deadlineAt = Date.parse(request.deadline);
      if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) throw new Error("JavaScript/TypeScript semantic request deadline is invalid or expired.");
      const startRequestId = `stream-start:${nextRequestId++}`;
      const start = await send({ protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION, kind: "stream_start", request_id: startRequestId, request }, deadlineAt - Date.now(), "stream start deadline") as WorkerMessage;
      if (start.kind !== "stream_header") throw failClosed(new Error("JavaScript/TypeScript semantic worker did not return a stream header."));
      const streamId = start.stream_id;
      const header = validateFactDeltaStreamHeader(start.header);
      streamCancellationById.set(streamId, header.cancellation_id);
      let closed = false;
      const batches = (async function* () {
        let sequence = 0;
        try {
          while (!closed) {
            const remaining = deadlineAt - Date.now();
            if (remaining <= 0) throw failClosed(new Error("JavaScript/TypeScript semantic stream deadline expired."));
            const requestId = `stream-next:${nextRequestId++}`;
            const value = await send({ protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION, kind: "stream_next", request_id: requestId, stream_id: streamId, expected_sequence: sequence }, remaining, "stream batch deadline") as WorkerMessage;
            if (value.kind !== "stream_batch" || value.stream_id !== streamId) throw failClosed(new Error("JavaScript/TypeScript semantic worker returned the wrong stream batch identity."));
            const batch = validateFactDeltaStreamBatch(value.batch);
            if (batch.sequence !== sequence) throw failClosed(new Error("JavaScript/TypeScript semantic worker returned an out-of-order stream batch."));
            sequence += 1;
            closed = batch.final;
            if (closed) streamCancellationById.delete(streamId);
            yield batch;
          }
        } finally {
          if (!closed && healthy && !terminating) {
            try {
              const requestId = `cancel:${nextRequestId++}`;
              await send({ protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION, kind: "cancel", request_id: requestId, cancellation_id: header.cancellation_id }, controlTimeoutMs, "semantic stream cancellation");
            } catch { /* fail-closed state already owns termination */ }
          }
          streamCancellationById.delete(streamId);
        }
      })();
      return { header, batches };
    },
    async invokeFactDeltaStreamGroup(requests): Promise<readonly FactDeltaStream[]> {
      await ready();
      if (requests.length === 0 || requests.length > JSTS_SEMANTIC_GROUP_MAX_OWNERS) throw new Error("A semantic owner group must contain between 1 and 32 requests.");
      if (requests.some((request) => request.call !== "analyze_artifact")) throw new Error("Grouped FactDeltaStream emission is limited to analyze_artifact.");
      if (serialize(requests).byteLength > JSTS_SEMANTIC_GROUP_MAX_MESSAGE_BYTES) throw new Error("The semantic owner group exceeds the 16 MiB request budget.");
      const deadlineAt = Math.min(...requests.map((request) => Date.parse(request.deadline)));
      if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) throw new Error("A JavaScript/TypeScript semantic group deadline is invalid or expired.");
      const startRequestId = `semantic-group-start:${nextRequestId++}`;
      const start = await send({
        protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION,
        kind: "semantic_group_start",
        request_id: startRequestId,
        requests,
      }, deadlineAt - Date.now(), "semantic group start deadline") as WorkerMessage;
      if (start.kind !== "semantic_group_header" || start.streams.length !== requests.length) throw failClosed(new Error("JavaScript/TypeScript semantic worker did not return a complete group header."));
      const ordered = [...start.streams].sort((left, right) => left.owner_index - right.owner_index);
      const queuedBatches = ordered.map(() => [] as FactDeltaStreamBatch[]);
      const expectedSequences = ordered.map(() => 0);
      const remotelyClosed = ordered.map(() => false);
      let nextRemoteOwner = 0;
      let remoteGroupClosed = false;
      let pumpChain = Promise.resolve();

      const pump = (wantedOwner: number): Promise<void> => {
        const operation = pumpChain.then(async () => {
          while (queuedBatches[wantedOwner]!.length === 0 && !remotelyClosed[wantedOwner]!) {
            if (remoteGroupClosed) throw failClosed(new Error("JavaScript/TypeScript semantic group ended before every owner reached a final batch."));
            const remaining = deadlineAt - Date.now();
            if (remaining <= 0) throw failClosed(new Error("JavaScript/TypeScript semantic group deadline expired."));
            const requestId = `semantic-group-next:${nextRequestId++}`;
            const value = await send({
              protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION,
              kind: "semantic_group_next",
              request_id: requestId,
              group_id: start.group_id,
              expected_owner_index: nextRemoteOwner,
            }, remaining, "semantic group batch deadline") as WorkerMessage;
            if (value.kind !== "semantic_group_batch" || value.group_id !== start.group_id) {
              throw failClosed(new Error("JavaScript/TypeScript semantic group returned the wrong bounded group identity."));
            }
            for (const owner of value.owners) {
              const expected = ordered[owner.owner_index];
              if (expected === undefined || expected.stream_id !== owner.stream_id) {
                throw failClosed(new Error("JavaScript/TypeScript semantic group returned the wrong owner stream identity."));
              }
              for (const packedBatch of owner.batches) {
                const batch = unpackSemanticBatch(packedBatch);
                if (remotelyClosed[owner.owner_index] || batch.sequence !== expectedSequences[owner.owner_index]) {
                  throw failClosed(new Error("JavaScript/TypeScript semantic group returned an out-of-order owner batch."));
                }
                expectedSequences[owner.owner_index]! += 1;
                queuedBatches[owner.owner_index]!.push(batch);
                if (batch.final) remotelyClosed[owner.owner_index] = true;
              }
            }
            if (value.next_owner_index < nextRemoteOwner || value.next_owner_index > ordered.length
              || (value.final !== (value.next_owner_index === ordered.length))) {
              throw failClosed(new Error("JavaScript/TypeScript semantic group continuation is invalid."));
            }
            nextRemoteOwner = value.next_owner_index;
            remoteGroupClosed = value.final;
          }
        });
        pumpChain = operation.catch(() => undefined);
        return operation;
      };

      const streams = ordered.map(({ owner_index: ownerIndex, stream_id: streamId, header: rawHeader }) => {
        const header = validateFactDeltaStreamHeader(rawHeader);
        if (ownerIndex >= requests.length || header.cancellation_id !== requests[ownerIndex]!.cancellation_id) throw failClosed(new Error("JavaScript/TypeScript semantic group owner identity is invalid."));
        streamCancellationById.set(streamId, header.cancellation_id);
        let closed = false;
        const batches = (async function* () {
          try {
            while (!closed) {
              if (queuedBatches[ownerIndex]!.length === 0) await pump(ownerIndex);
              const batch = queuedBatches[ownerIndex]!.shift();
              if (batch === undefined) throw failClosed(new Error("JavaScript/TypeScript semantic group did not provide the requested owner batch."));
              closed = batch.final;
              if (closed) streamCancellationById.delete(streamId);
              yield batch;
            }
          } finally {
            if (!closed && healthy && !terminating) {
              try {
                const requestId = `cancel:${nextRequestId++}`;
                await send({ protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION, kind: "cancel", request_id: requestId, cancellation_id: header.cancellation_id }, controlTimeoutMs, "semantic group owner cancellation");
              } catch { /* fail-closed state already owns process cleanup */ }
            }
            streamCancellationById.delete(streamId);
          }
        })();
        return Object.freeze({ header, batches });
      });
      return Object.freeze(streams);
    },
    async cancel(input): Promise<void> {
      const requestId = `cancel:${nextRequestId++}`;
      const message = await control({ protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION, kind: "cancel", request_id: requestId, cancellation_id: input.cancellation_id });
      if (message.kind !== "cancel_ack" || message.cancellation_id !== input.cancellation_id) throw failClosed(new Error("JavaScript/TypeScript semantic worker cancellation acknowledgement is invalid."));
    },
    async reset(): Promise<unknown> {
      const requestId = `reset:${nextRequestId++}`;
      const message = await control({ protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION, kind: "reset", request_id: requestId });
      if (message.kind !== "result") throw failClosed(new Error("JavaScript/TypeScript semantic worker reset acknowledgement is invalid."));
      return message.result;
    },
    async terminate(): Promise<void> {
      if (terminating || exited) return;
      if (healthy && handshakeComplete) {
        expectedExit = true;
        const requestId = `shutdown:${nextRequestId++}`;
        try {
          const message = await send({ protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION, kind: "shutdown", request_id: requestId }, controlTimeoutMs) as WorkerMessage;
          if (message.kind !== "shutdown_ack") throw new Error("JavaScript/TypeScript semantic worker shutdown acknowledgement is invalid.");
        } catch {
          // Termination remains best-effort after a prior fail-closed transition.
        }
      }
      terminating = true;
      healthy = false;
      child.stdin.end();
      if (!exited) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { if (!exited) child.kill(); resolve(); }, terminationGraceMs);
          timer.unref?.();
          child.once("exit", () => { clearTimeout(timer); resolve(); });
        });
      }
    },
  };
}
