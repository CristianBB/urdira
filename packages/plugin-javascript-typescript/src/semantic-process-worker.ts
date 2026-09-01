import { createWriteStream } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { deserialize, serialize } from "node:v8";
import { configureStructuralKernelPort, factDeltaStreamCanonicalRow, factDeltaStreamSealedRows, type PluginWorkerRequestEnvelope, type StructuralKernelPort } from "@urdira/plugin-sdk";
import type { FactDeltaStreamBatch } from "@urdira/contracts";
import {
  JSTS_SEMANTIC_PROCESS_BUILD_IDENTITY,
  JSTS_SEMANTIC_GROUP_MAX_MESSAGE_BYTES,
  JSTS_SEMANTIC_GROUP_MAX_OWNERS,
  JSTS_SEMANTIC_PROCESS_MAX_MESSAGE_BYTES,
  JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION,
  type JavascriptTypescriptSemanticWorkerDescriptor,
} from "./semantic-process-transport.js";
import { encodeRustWorkerMessage, MAX_RUST_WORKER_MESSAGE_BYTES } from "./rust-protocol.js";
import { createJavascriptTypescriptWorker, type JavascriptTypescriptWorkerTransport } from "./worker.js";

interface HostEnvelope {
  readonly protocol_version: string;
  readonly kind: string;
  readonly request_id: string;
  readonly [key: string]: unknown;
}

let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
let negotiatedMessageBytes: number | undefined;
let worker: JavascriptTypescriptWorkerTransport | undefined;
let shuttingDown = false;
let writeChain = Promise.resolve();
let streamWriteChain = Promise.resolve();
let nextFrameStreamId = 1;
const streamOutput = createWriteStream("", { fd: 3, autoClose: false });
const activeStreams = new Map<string, {
  readonly cancellation_id: string;
  readonly iterator: AsyncIterator<FactDeltaStreamBatch>;
  next_sequence: number;
  pending_batch?: FactDeltaStreamBatch;
}>();
const activeSemanticGroups = new Map<string, {
  readonly stream_ids: readonly string[];
  next_owner_index: number;
}>();

type PackedSemanticBatch = {
  readonly metadata: Omit<FactDeltaStreamBatch, "records" | "dependencies">;
  readonly canonical_records: readonly string[];
  readonly canonical_dependencies: readonly string[];
};

function packSemanticBatch(batch: FactDeltaStreamBatch): PackedSemanticBatch {
  const { records: _records, dependencies: _dependencies, ...metadata } = batch;
  const sealed = factDeltaStreamSealedRows(batch);
  return {
    metadata,
    canonical_records: sealed?.canonical_records ?? batch.records.map(factDeltaStreamCanonicalRow),
    canonical_dependencies: sealed?.canonical_dependencies ?? batch.dependencies.map(factDeltaStreamCanonicalRow),
  };
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value);
}

function validateWorkerDescriptor(value: unknown): JavascriptTypescriptSemanticWorkerDescriptor {
  const descriptor = recordOf(value);
  const allowed = new Set([
    "compatibility_declaration_digest", "registry_contribution_digest", "analysis_digest", "analysis_configuration_digest",
    "runtime_executable_binding_digest",
    "cas_root", "source_load_concurrency", "source_load_max_in_flight_bytes", "analysis_cache_dir", "analysis_cache_max_entries",
    "native_batch_transport",
  ]);
  if (descriptor === undefined || Object.keys(descriptor).some((key) => !allowed.has(key))) throw new Error("Semantic worker descriptor is invalid.");
  for (const key of ["compatibility_declaration_digest", "registry_contribution_digest", "analysis_digest", "analysis_configuration_digest", "cas_root", "analysis_cache_dir"] as const) {
    if (descriptor[key] !== undefined && !nonemptyString(descriptor[key])) throw new Error(`Semantic worker descriptor ${key} is invalid.`);
  }
  if (descriptor["runtime_executable_binding_digest"] !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(String(descriptor["runtime_executable_binding_digest"]))) {
    throw new Error("Semantic worker descriptor runtime_executable_binding_digest is invalid.");
  }
  for (const key of ["source_load_concurrency", "source_load_max_in_flight_bytes", "analysis_cache_max_entries"] as const) {
    if (descriptor[key] !== undefined && (!Number.isSafeInteger(descriptor[key]) || Number(descriptor[key]) <= 0)) throw new Error(`Semantic worker descriptor ${key} is invalid.`);
  }
  if (descriptor["native_batch_transport"] !== undefined && descriptor["native_batch_transport"] !== "response" && descriptor["native_batch_transport"] !== "host") {
    throw new Error("Semantic worker native_batch_transport is invalid.");
  }
  return descriptor as JavascriptTypescriptSemanticWorkerDescriptor;
}

function validateHostEnvelope(value: unknown): HostEnvelope {
  const message = recordOf(value);
  if (message === undefined || message["protocol_version"] !== JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION || !nonemptyString(message["request_id"]) || typeof message["kind"] !== "string") {
    throw new Error("Semantic process host envelope is invalid.");
  }
  return message as HostEnvelope;
}

function encode(message: unknown): Buffer {
  const payload = serialize(message);
  const limit = negotiatedMessageBytes ?? JSTS_SEMANTIC_PROCESS_MAX_MESSAGE_BYTES;
  if (payload.byteLength === 0 || payload.byteLength > limit) throw new Error("Semantic process response exceeds the negotiated message limit.");
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

function send(message: unknown): Promise<void> {
  const frame = encode(message);
  const operation = writeChain.then(() => new Promise<void>((resolve, reject) => {
    process.stdout.write(frame, (error) => error === null || error === undefined ? resolve() : reject(error));
  }));
  writeChain = operation.catch(() => undefined);
  return operation;
}

function sendStream(message: unknown, cancellationId: string): Promise<void> {
  const frames = encodeRustWorkerMessage(message, {
    stream_id: nextFrameStreamId++,
    cancellation_id: cancellationId,
    byte_budget: MAX_RUST_WORKER_MESSAGE_BYTES,
    in_flight_budget: MAX_RUST_WORKER_MESSAGE_BYTES,
  });
  const operation = streamWriteChain.then(async () => {
    for (const frame of frames) await new Promise<void>((resolve, reject) => {
      streamOutput.write(frame, (error) => error === null || error === undefined ? resolve() : reject(error));
    });
  });
  streamWriteChain = operation.catch(() => undefined);
  return operation;
}

async function closeStreams(cancellationId?: string): Promise<void> {
  for (const [streamId, active] of activeStreams) {
    if (cancellationId !== undefined && active.cancellation_id !== cancellationId) continue;
    activeStreams.delete(streamId);
    await active.iterator.return?.();
  }
  for (const [groupId, group] of activeSemanticGroups) {
    if (group.stream_ids.every((streamId) => !activeStreams.has(streamId))) activeSemanticGroups.delete(groupId);
  }
}

async function closeSemanticGroup(groupId: string): Promise<void> {
  const group = activeSemanticGroups.get(groupId);
  if (group === undefined) return;
  activeSemanticGroups.delete(groupId);
  for (const streamId of group.stream_ids) {
    const active = activeStreams.get(streamId);
    if (active === undefined) continue;
    activeStreams.delete(streamId);
    await active.iterator.return?.();
  }
}

function errorDetails(error: unknown): { readonly name: string; readonly message: string } {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return { name: name.slice(0, 120), message: message.replace(/[\0\r\n]/gu, " ").slice(0, 1_024) };
}

async function handleHandshake(message: HostEnvelope): Promise<void> {
  const raw = message as Record<string, unknown>;
  if (worker !== undefined || !hasExactKeys(raw, ["protocol_version", "kind", "request_id", "build_identity", "max_message_bytes", "structural_kernel_addon_path", "worker"])
    || raw["kind"] !== "handshake" || raw["build_identity"] !== JSTS_SEMANTIC_PROCESS_BUILD_IDENTITY
    || !Number.isSafeInteger(raw["max_message_bytes"]) || Number(raw["max_message_bytes"]) <= 0 || Number(raw["max_message_bytes"]) > JSTS_SEMANTIC_PROCESS_MAX_MESSAGE_BYTES) {
    throw new Error("Semantic process handshake is incompatible.");
  }
  const descriptor = validateWorkerDescriptor(raw["worker"]);
  const addonPath = raw["structural_kernel_addon_path"];
  if (addonPath !== null) {
    if (!nonemptyString(addonPath) || !isAbsolute(addonPath)) throw new Error("Semantic process structural kernel path is invalid.");
    const loaded = createRequire(import.meta.url)(addonPath) as Partial<StructuralKernelPort> & { readonly nativeApiVersion?: () => number };
    if (typeof loaded.nativeApiVersion !== "function" || loaded.nativeApiVersion() !== 16
      || typeof loaded.structuralKernelBatch !== "function" || typeof loaded.structuralKernelCanonicalBatch !== "function"
      || typeof loaded.structuralObservationBatch !== "function") {
      throw new Error("Semantic process structural kernel binding is incompatible.");
    }
    configureStructuralKernelPort({
      structuralKernelBatch: (batch) => loaded.structuralKernelBatch!(batch),
      structuralKernelCanonicalBatch: (batch) => loaded.structuralKernelCanonicalBatch!(batch),
      structuralObservationBatch: (request) => loaded.structuralObservationBatch!(request),
    });
  }
  negotiatedMessageBytes = Number(raw["max_message_bytes"]);
  worker = createJavascriptTypescriptWorker(descriptor);
  await send({
    protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION,
    kind: "handshake_ack",
    request_id: message.request_id,
    build_identity: JSTS_SEMANTIC_PROCESS_BUILD_IDENTITY,
    node_version: process.versions.node,
    max_message_bytes: negotiatedMessageBytes,
  });
}

async function handleMessage(value: unknown): Promise<void> {
  const message = validateHostEnvelope(value);
  if (worker === undefined) { await handleHandshake(message); return; }
  const raw = message as Record<string, unknown>;
  try {
    switch (message.kind) {
      case "invoke": {
        if (!hasExactKeys(raw, ["protocol_version", "kind", "request_id", "request"])) throw new Error("Semantic process invoke message is invalid.");
        const result = await worker.invoke(raw["request"] as PluginWorkerRequestEnvelope);
        await send({ protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION, kind: "result", request_id: message.request_id, result });
        return;
      }
      case "stream_start": {
        if (!hasExactKeys(raw, ["protocol_version", "kind", "request_id", "request"])) throw new Error("Semantic process stream start message is invalid.");
        const request = raw["request"] as PluginWorkerRequestEnvelope;
        const stream = await worker.invokeFactDeltaStream(request);
        const streamId = `fact-delta:${message.request_id}`;
        if (activeStreams.has(streamId)) throw new Error("Semantic process stream identity is already active.");
        activeStreams.set(streamId, { cancellation_id: stream.header.cancellation_id, iterator: stream.batches[Symbol.asyncIterator](), next_sequence: 0 });
        await sendStream({ protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION, kind: "stream_header", request_id: message.request_id, stream_id: streamId, header: stream.header }, stream.header.cancellation_id);
        return;
      }
      case "semantic_group_start": {
        if (!hasExactKeys(raw, ["protocol_version", "kind", "request_id", "requests"]) || !Array.isArray(raw["requests"])
          || raw["requests"].length === 0 || raw["requests"].length > JSTS_SEMANTIC_GROUP_MAX_OWNERS
          || serialize(raw["requests"]).byteLength > JSTS_SEMANTIC_GROUP_MAX_MESSAGE_BYTES) {
          throw new Error("Semantic process group start message is invalid.");
        }
        const requests = raw["requests"] as PluginWorkerRequestEnvelope[];
        const streams = await worker.invokeFactDeltaStreamGroup(requests);
        if (streams.length !== requests.length) throw new Error("Semantic process group returned the wrong owner count.");
        const groupId = `semantic-group:${message.request_id}`;
        if (activeSemanticGroups.has(groupId)) throw new Error("Semantic process group identity is already active.");
        const headers = streams.map((stream, ownerIndex) => {
          const streamId = `${groupId}:${ownerIndex}`;
          if (activeStreams.has(streamId)) throw new Error("Semantic process group stream identity is already active.");
          activeStreams.set(streamId, { cancellation_id: stream.header.cancellation_id, iterator: stream.batches[Symbol.asyncIterator](), next_sequence: 0 });
          return { owner_index: ownerIndex, stream_id: streamId, header: stream.header };
        });
        activeSemanticGroups.set(groupId, { stream_ids: headers.map((entry) => entry.stream_id), next_owner_index: 0 });
        await send({ protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION, kind: "semantic_group_header", request_id: message.request_id, group_id: groupId, streams: headers });
        return;
      }
      case "semantic_group_next": {
        if (!hasExactKeys(raw, ["protocol_version", "kind", "request_id", "group_id", "expected_owner_index"])
          || !nonemptyString(raw["group_id"]) || !Number.isSafeInteger(raw["expected_owner_index"]) || Number(raw["expected_owner_index"]) < 0) {
          throw new Error("Semantic process group-next message is invalid.");
        }
        const group = activeSemanticGroups.get(raw["group_id"]);
        if (group === undefined || group.next_owner_index !== raw["expected_owner_index"]) throw new Error("Semantic process group continuation is not active.");
        const owners: { owner_index: number; stream_id: string; batches: PackedSemanticBatch[] }[] = [];
        let serializedBytes = serialize({
          protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION,
          kind: "semantic_group_batch",
          request_id: message.request_id,
          group_id: raw["group_id"],
          next_owner_index: group.next_owner_index,
          final: false,
          owners: [],
        }).byteLength;
        let ownerIndex = group.next_owner_index;
        drain: while (ownerIndex < group.stream_ids.length) {
          const streamId = group.stream_ids[ownerIndex]!;
          const active = activeStreams.get(streamId);
          if (active === undefined) throw new Error("Semantic process group owner stream is not active.");
          const owner = { owner_index: ownerIndex, stream_id: streamId, batches: [] as PackedSemanticBatch[] };
          while (true) {
            const batch = active.pending_batch ?? (await active.iterator.next()).value;
            delete active.pending_batch;
            if (batch === undefined || batch.sequence !== active.next_sequence) throw new Error("Semantic process group owner batch sequence is invalid.");
            const packedBatch = packSemanticBatch(batch);
            // Sum independently serialized owner frames. This deliberately
            // overestimates the combined V8 envelope (repeated keys and stream
            // ids are counted again) and avoids serializing a growing result
            // for every owner, which would make draining quadratic.
            const batchBytes = serialize({ owner_index: ownerIndex, stream_id: streamId, batches: [packedBatch] }).byteLength;
            if (serializedBytes + batchBytes > JSTS_SEMANTIC_GROUP_MAX_MESSAGE_BYTES) {
              if (owners.length === 0 && owner.batches.length === 0) throw new Error("A semantic group owner batch exceeds the bounded response budget.");
              active.pending_batch = batch;
              if (owner.batches.length > 0) owners.push(owner);
              break drain;
            }
            serializedBytes += batchBytes;
            owner.batches.push(packedBatch);
            active.next_sequence += 1;
            if (!batch.final) continue;
            activeStreams.delete(streamId);
            owners.push(owner);
            ownerIndex += 1;
            group.next_owner_index = ownerIndex;
            continue drain;
          }
        }
        if (owners.length === 0) throw new Error("Semantic process group drain produced no owner batches.");
        const final = group.next_owner_index === group.stream_ids.length;
        if (final) activeSemanticGroups.delete(raw["group_id"]);
        const response = {
          protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION,
          kind: "semantic_group_batch",
          request_id: message.request_id,
          group_id: raw["group_id"],
          next_owner_index: group.next_owner_index,
          final,
          owners,
        };
        if (serialize(response).byteLength > JSTS_SEMANTIC_GROUP_MAX_MESSAGE_BYTES) throw new Error("Semantic process group drain exceeded its bounded response budget.");
        await send(response);
        return;
      }
      case "stream_next": {
        if (!hasExactKeys(raw, ["protocol_version", "kind", "request_id", "stream_id", "expected_sequence"]) || !nonemptyString(raw["stream_id"]) || !Number.isSafeInteger(raw["expected_sequence"]) || Number(raw["expected_sequence"]) < 0) throw new Error("Semantic process stream-next message is invalid.");
        const active = activeStreams.get(raw["stream_id"]);
        if (active === undefined) throw new Error("Semantic process stream is not active.");
        const next = await active.iterator.next();
        if (next.done || next.value.sequence !== raw["expected_sequence"]) throw new Error("Semantic process stream batch sequence is invalid.");
        if (next.value.final) activeStreams.delete(raw["stream_id"]);
        await sendStream({ protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION, kind: "stream_batch", request_id: message.request_id, stream_id: raw["stream_id"], batch: next.value }, active.cancellation_id);
        return;
      }
      case "cancel": {
        if (!hasExactKeys(raw, ["protocol_version", "kind", "request_id", "cancellation_id"]) || !nonemptyString(raw["cancellation_id"])) throw new Error("Semantic process cancellation message is invalid.");
        await closeStreams(raw["cancellation_id"]);
        await worker.cancel({ cancellation_id: raw["cancellation_id"] });
        await send({ protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION, kind: "cancel_ack", request_id: message.request_id, cancellation_id: raw["cancellation_id"] });
        return;
      }
      case "reset": {
        if (!hasExactKeys(raw, ["protocol_version", "kind", "request_id"])) throw new Error("Semantic process reset message is invalid.");
        await closeStreams();
        const result = await worker.reset();
        await send({ protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION, kind: "result", request_id: message.request_id, result });
        return;
      }
      case "shutdown": {
        if (!hasExactKeys(raw, ["protocol_version", "kind", "request_id"])) throw new Error("Semantic process shutdown message is invalid.");
        shuttingDown = true;
        await closeStreams();
        await worker.terminate();
        await send({ protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION, kind: "shutdown_ack", request_id: message.request_id });
        await Promise.all([writeChain, streamWriteChain]);
        process.exit(0);
      }
      default:
        throw new Error("Semantic process message kind is not closed.");
    }
  } catch (error) {
    await send({ protocol_version: JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION, kind: "error", request_id: message.request_id, error: errorDetails(error) });
  }
}

function fatal(error: unknown): void {
  if (!shuttingDown) process.stderr.write(`JavaScript/TypeScript semantic worker protocol failure: ${errorDetails(error).message}\n`);
  process.exit(1);
}

process.stdin.on("data", (chunk: Buffer) => {
  try {
    const limit = negotiatedMessageBytes ?? JSTS_SEMANTIC_PROCESS_MAX_MESSAGE_BYTES;
    buffered = buffered.byteLength === 0 ? chunk : Buffer.concat([buffered, chunk]);
    while (buffered.byteLength >= 4) {
      const length = buffered.readUInt32BE(0);
      if (length === 0 || length > limit) throw new Error("Semantic process request exceeds the negotiated message limit.");
      if (buffered.byteLength < length + 4) break;
      const message = deserialize(buffered.subarray(4, length + 4));
      buffered = buffered.subarray(length + 4);
      void handleMessage(message).catch(fatal);
    }
    if (buffered.byteLength > limit + 4) throw new Error("Semantic process receive buffer exceeded its limit.");
  } catch (error) {
    fatal(error);
  }
});
process.stdin.once("end", () => { if (!shuttingDown) fatal(new Error("Semantic process input closed before shutdown.")); });
process.once("uncaughtException", fatal);
process.once("unhandledRejection", fatal);
