import { createServer, connect, type Server, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { DaemonError } from "./errors.js";

export const IPC_PROTOCOL_VERSION = 2;
export const IPC_DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
export const IPC_MAX_CHUNK_BYTES = 256 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function normalizeLocalIpcEndpoint(endpoint: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32" || endpoint.startsWith("\\\\.\\pipe\\")) return endpoint;
  const digest = createHash("sha256").update(endpoint).digest("hex");
  return `\\\\.\\pipe\\urdira-${digest}`;
}

export interface IpcRequest {
  readonly protocol_version: number;
  readonly request_id: string;
  readonly call: string;
  readonly deadline_at: string;
  readonly cancellation_id: string;
  readonly payload: unknown;
}

export interface IpcResponse {
  readonly protocol_version: number;
  readonly request_id: string;
  readonly outcome: "success" | "error" | "cancelled";
  readonly payload?: unknown;
  readonly error?: { readonly code: string; readonly message: string; readonly details?: Readonly<Record<string, unknown>> };
}

export interface IpcProgress {
  readonly protocol_version: number;
  readonly request_id: string;
  readonly event: "progress";
  readonly progress: { readonly phase: string; readonly completed: number; readonly total?: number; readonly message?: string };
}

export type IpcFrame = IpcRequest | IpcResponse | IpcProgress;

export interface ProcessByteChunk {
  readonly protocol_version: typeof IPC_PROTOCOL_VERSION;
  readonly stream_id: string;
  readonly sequence: number;
  readonly offset: bigint;
  readonly payload: Uint8Array;
  readonly final: boolean;
  readonly cancellation_id: string;
  readonly max_bytes: bigint;
  readonly max_in_flight: number;
  readonly max_in_flight_bytes: bigint;
  readonly chunk_kind: "source_bytes" | "fact_delta";
}
export type SourceBytesChunk = ProcessByteChunk & { readonly chunk_kind: "source_bytes" };
export type FactDeltaChunk = ProcessByteChunk & { readonly chunk_kind: "fact_delta" };

function validateProcessByteChunk(chunk: ProcessByteChunk): void {
  if (chunk.protocol_version !== IPC_PROTOCOL_VERSION || chunk.stream_id.length === 0 || chunk.cancellation_id.length === 0 || !Number.isSafeInteger(chunk.sequence) || chunk.sequence < 0 || chunk.offset < 0n || chunk.max_bytes <= 0n || !Number.isSafeInteger(chunk.max_in_flight) || chunk.max_in_flight <= 0 || chunk.max_in_flight_bytes <= 0n || chunk.max_in_flight_bytes > chunk.max_bytes || BigInt(chunk.payload.byteLength) > chunk.max_in_flight_bytes || chunk.payload.byteLength > IPC_MAX_CHUNK_BYTES || chunk.offset + BigInt(chunk.payload.byteLength) > chunk.max_bytes) throw new DaemonError("core:ipc_chunk_invalid", "Process byte chunk violates its protocol or resource budget.");
}

function encodeProcessByteChunk(chunk: ProcessByteChunk): Uint8Array {
  validateProcessByteChunk(chunk);
  const writer = new BinaryWriter();
  writer.tag(1, WireType.Varint).uint32(chunk.protocol_version);
  writer.tag(2, WireType.LengthDelimited).string(chunk.stream_id);
  writer.tag(3, WireType.Varint).uint32(chunk.sequence);
  writer.tag(4, WireType.Varint).uint64(chunk.offset);
  writer.tag(5, WireType.LengthDelimited).bytes(chunk.payload);
  writer.tag(6, WireType.Varint).bool(chunk.final);
  writer.tag(7, WireType.LengthDelimited).string(chunk.cancellation_id);
  writer.tag(8, WireType.Varint).uint64(chunk.max_bytes);
  writer.tag(9, WireType.Varint).uint32(chunk.max_in_flight);
  writer.tag(10, WireType.LengthDelimited).string(chunk.chunk_kind);
  writer.tag(11, WireType.Varint).uint64(chunk.max_in_flight_bytes);
  return writer.finish();
}

function decodeProcessByteChunkBody(body: Uint8Array): ProcessByteChunk {
  const reader = new BinaryReader(body);
  let protocolVersion: number | undefined; let streamId: string | undefined; let sequence: number | undefined; let offset: bigint | undefined; let payload: Uint8Array | undefined; let final: boolean | undefined; let cancellationId: string | undefined; let maxBytes: bigint | undefined; let maxInFlight: number | undefined; let chunkKind: ProcessByteChunk["chunk_kind"] | undefined; let maxInFlightBytes: bigint | undefined;
  const seen = new Set<number>();
  while (reader.pos < reader.len) {
    const [field, wireType] = reader.tag();
    if (seen.has(field)) throw new DaemonError("core:ipc_chunk_invalid", `Duplicate protobuf chunk field ${field}.`);
    seen.add(field);
    if (field === 1 && wireType === WireType.Varint) protocolVersion = reader.uint32();
    else if (field === 2 && wireType === WireType.LengthDelimited) streamId = reader.string();
    else if (field === 3 && wireType === WireType.Varint) sequence = reader.uint32();
    else if (field === 4 && wireType === WireType.Varint) { const value = reader.uint64(); offset = typeof value === "bigint" ? value : BigInt(value); }
    else if (field === 5 && wireType === WireType.LengthDelimited) payload = new Uint8Array(reader.bytes());
    else if (field === 6 && wireType === WireType.Varint) final = reader.bool();
    else if (field === 7 && wireType === WireType.LengthDelimited) cancellationId = reader.string();
    else if (field === 8 && wireType === WireType.Varint) { const value = reader.uint64(); maxBytes = typeof value === "bigint" ? value : BigInt(value); }
    else if (field === 9 && wireType === WireType.Varint) maxInFlight = reader.uint32();
    else if (field === 10 && wireType === WireType.LengthDelimited) { const value = reader.string(); if (value !== "source_bytes" && value !== "fact_delta") throw new DaemonError("core:ipc_chunk_invalid", "Chunk kind is not registered."); chunkKind = value; }
    else if (field === 11 && wireType === WireType.Varint) { const value = reader.uint64(); maxInFlightBytes = typeof value === "bigint" ? value : BigInt(value); }
    else throw new DaemonError("core:ipc_chunk_invalid", `Unknown or invalid protobuf chunk field ${field}.`);
  }
  if (protocolVersion === undefined || streamId === undefined || sequence === undefined || offset === undefined || payload === undefined || final === undefined || cancellationId === undefined || maxBytes === undefined || maxInFlight === undefined || maxInFlightBytes === undefined || chunkKind === undefined) throw new DaemonError("core:ipc_chunk_invalid", "Protobuf chunk is missing a required field.");
  const result = { protocol_version: protocolVersion, stream_id: streamId, sequence, offset, payload, final, cancellation_id: cancellationId, max_bytes: maxBytes, max_in_flight: maxInFlight, max_in_flight_bytes: maxInFlightBytes, chunk_kind: chunkKind } as ProcessByteChunk;
  validateProcessByteChunk(result);
  return result;
}

function encodeChunk(chunk: ProcessByteChunk): Buffer { const body = Buffer.from(encodeProcessByteChunk(chunk)); const encoded = Buffer.allocUnsafe(body.byteLength + 4); encoded.writeUInt32BE(body.byteLength, 0); body.copy(encoded, 4); return encoded; }
export function encodeSourceBytesChunk(chunk: Omit<SourceBytesChunk, "chunk_kind">): Buffer { return encodeChunk({ ...chunk, chunk_kind: "source_bytes" }); }
export function encodeFactDeltaChunk(chunk: Omit<FactDeltaChunk, "chunk_kind">): Buffer { return encodeChunk({ ...chunk, chunk_kind: "fact_delta" }); }
export function decodeProcessByteChunk(encoded: Uint8Array): SourceBytesChunk | FactDeltaChunk {
  if (encoded.byteLength < 4) throw new DaemonError("core:ipc_chunk_invalid", "Protobuf chunk is missing its length prefix.");
  const length = Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength).readUInt32BE(0);
  if (length > IPC_MAX_CHUNK_BYTES || encoded.byteLength !== length + 4) throw new DaemonError("core:ipc_chunk_invalid", "Protobuf chunk length is invalid.");
  return decodeProcessByteChunkBody(Buffer.from(encoded.buffer, encoded.byteOffset + 4, length)) as SourceBytesChunk | FactDeltaChunk;
}

function writeString(writer: BinaryWriter, field: number, value: string | undefined): void {
  if (value !== undefined) writer.tag(field, WireType.LengthDelimited).string(value);
}

function compareUtf8(left: string, right: string): number {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
}

/** A small protobuf value union used only by the daemon IPC envelope. It is
 * deliberately not persisted, hashed, or used for canonical comparison. */
function encodeValue(value: unknown): Uint8Array {
  const writer = new BinaryWriter();
  if (value === null) writer.tag(1, WireType.Varint).bool(true);
  else if (typeof value === "boolean") writer.tag(2, WireType.Varint).bool(value);
  else if (typeof value === "number" && Number.isFinite(value)) writer.tag(3, WireType.Bit64).double(value);
  else if (typeof value === "string") writer.tag(4, WireType.LengthDelimited).string(value);
  else if (value instanceof Uint8Array) writer.tag(5, WireType.LengthDelimited).bytes(value);
  else if (Array.isArray(value)) {
    if (value.length === 0) writer.tag(8, WireType.Varint).bool(true);
    else for (const entry of value) writer.tag(6, WireType.LengthDelimited).bytes(encodeValue(entry));
  }
  else if (record(value)) {
    const keys = Object.keys(value).sort(compareUtf8);
    if (keys.length === 0) writer.tag(9, WireType.Varint).bool(true);
    for (const key of keys) {
      const entry = new BinaryWriter();
      entry.tag(1, WireType.LengthDelimited).string(key);
      entry.tag(2, WireType.LengthDelimited).bytes(encodeValue(value[key]));
      writer.tag(7, WireType.LengthDelimited).bytes(entry.finish());
    }
  } else {
    throw new DaemonError("core:ipc_frame_invalid", "IPC payload contains a value that is not supported by the closed protobuf value union.");
  }
  return writer.finish();
}

function decodeValue(body: Uint8Array): unknown {
  const reader = new BinaryReader(body);
  let kind: "null" | "boolean" | "number" | "string" | "bytes" | "array" | "object" | undefined;
  let scalar: unknown;
  const array: unknown[] = [];
  const object: Record<string, unknown> = {};
  while (reader.pos < reader.len) {
    const [field, wireType] = reader.tag();
    if (field === 1 && wireType === WireType.Varint) { if (kind !== undefined) throw new DaemonError("core:ipc_frame_invalid", "IPC value has multiple protobuf kinds."); kind = "null"; reader.bool(); }
    else if (field === 2 && wireType === WireType.Varint) { if (kind !== undefined) throw new DaemonError("core:ipc_frame_invalid", "IPC value has multiple protobuf kinds."); kind = "boolean"; scalar = reader.bool(); }
    else if (field === 3 && wireType === WireType.Bit64) { if (kind !== undefined) throw new DaemonError("core:ipc_frame_invalid", "IPC value has multiple protobuf kinds."); kind = "number"; scalar = reader.double(); }
    else if (field === 4 && wireType === WireType.LengthDelimited) { if (kind !== undefined) throw new DaemonError("core:ipc_frame_invalid", "IPC value has multiple protobuf kinds."); kind = "string"; scalar = reader.string(); }
    else if (field === 5 && wireType === WireType.LengthDelimited) { if (kind !== undefined) throw new DaemonError("core:ipc_frame_invalid", "IPC value has multiple protobuf kinds."); kind = "bytes"; scalar = reader.bytes(); }
    else if (field === 6 && wireType === WireType.LengthDelimited) { if (kind !== undefined && kind !== "array") throw new DaemonError("core:ipc_frame_invalid", "IPC value has multiple protobuf kinds."); kind = "array"; array.push(decodeValue(reader.bytes())); }
    else if (field === 7 && wireType === WireType.LengthDelimited) {
      if (kind !== undefined && kind !== "object") throw new DaemonError("core:ipc_frame_invalid", "IPC value has multiple protobuf kinds.");
      kind = "object";
      const entryReader = new BinaryReader(reader.bytes());
      let key: string | undefined;
      let entryValue: unknown;
      while (entryReader.pos < entryReader.len) {
        const [entryField, entryWireType] = entryReader.tag();
        if (entryField === 1 && entryWireType === WireType.LengthDelimited && key === undefined) key = entryReader.string();
        else if (entryField === 2 && entryWireType === WireType.LengthDelimited && entryValue === undefined) entryValue = decodeValue(entryReader.bytes());
        else throw new DaemonError("core:ipc_frame_invalid", "IPC object entry is invalid or contains an unknown field.");
      }
      if (key === undefined || entryValue === undefined || Object.hasOwn(object, key)) throw new DaemonError("core:ipc_frame_invalid", "IPC object entry is incomplete or duplicated.");
      object[key] = entryValue;
    } else if (field === 8 && wireType === WireType.Varint) { if (kind !== undefined) throw new DaemonError("core:ipc_frame_invalid", "IPC value has multiple protobuf kinds."); kind = "array"; reader.bool(); }
    else if (field === 9 && wireType === WireType.Varint) { if (kind !== undefined) throw new DaemonError("core:ipc_frame_invalid", "IPC value has multiple protobuf kinds."); kind = "object"; reader.bool(); }
    else throw new DaemonError("core:ipc_frame_invalid", `Unknown closed protobuf value field ${field}.`);
  }
  if (kind === "null") return null;
  if (kind === "boolean" || kind === "number" || kind === "string" || kind === "bytes") return scalar;
  if (kind === "array") return array;
  if (kind === "object") return object;
  throw new DaemonError("core:ipc_frame_invalid", "IPC value is empty.");
}

function writeValue(writer: BinaryWriter, field: number, value: unknown): void {
  if (value !== undefined) writer.tag(field, WireType.LengthDelimited).bytes(encodeValue(value));
}

/** Protobuf-ES wire message for the local daemon frame. */
function encodeProtoFrame(frame: IpcFrame): Uint8Array {
  const writer = new BinaryWriter();
  writer.tag(1, WireType.Varint).uint32(frame.protocol_version);
  writeString(writer, 2, frame.request_id);
  if ("call" in frame) {
    writeString(writer, 3, "request");
    writeString(writer, 4, frame.call);
    writeString(writer, 5, frame.deadline_at);
    writeString(writer, 6, frame.cancellation_id);
    writeValue(writer, 7, frame.payload);
  } else if ("outcome" in frame) {
    writeString(writer, 3, "response");
    writeString(writer, 8, frame.outcome);
    writeValue(writer, 7, frame.payload);
    writeValue(writer, 9, frame.error);
  } else {
    writeString(writer, 3, "progress");
    writeValue(writer, 10, frame.progress);
  }
  return writer.finish();
}

function decodeProtoFrame(body: Uint8Array): IpcFrame {
  const reader = new BinaryReader(body);
  let protocolVersion: number | undefined;
  let requestId: string | undefined;
  let kind: string | undefined;
  let call: string | undefined;
  let deadline: string | undefined;
  let cancellation: string | undefined;
  let payload: unknown;
  let outcome: IpcResponse["outcome"] | undefined;
  let error: IpcResponse["error"] | undefined;
  let progress: IpcProgress["progress"] | undefined;
  while (reader.pos < reader.len) {
    const [field, wireType] = reader.tag();
    if (wireType !== WireType.Varint && wireType !== WireType.LengthDelimited) throw new DaemonError("core:ipc_frame_invalid", "Protobuf frame uses an unsupported wire type.");
    switch (field) {
      case 1: protocolVersion = reader.uint32(); break;
      case 2: requestId = reader.string(); break;
      case 3: kind = reader.string(); break;
      case 4: call = reader.string(); break;
      case 5: deadline = reader.string(); break;
      case 6: cancellation = reader.string(); break;
      case 7: payload = decodeValue(reader.bytes()); break;
      case 8: outcome = reader.string() as IpcResponse["outcome"]; break;
      case 9: error = decodeValue(reader.bytes()) as IpcResponse["error"]; break;
      case 10: progress = decodeValue(reader.bytes()) as IpcProgress["progress"]; break;
      default: throw new DaemonError("core:ipc_frame_invalid", `Unknown closed protobuf frame field ${field}.`);
    }
  }
  if (protocolVersion !== IPC_PROTOCOL_VERSION || requestId === undefined || requestId.length === 0 || kind === undefined) throw new DaemonError("core:ipc_frame_invalid", "Protobuf frame is missing required control fields.");
  if (kind === "request" && call !== undefined && deadline !== undefined && cancellation !== undefined && payload !== undefined) return validateFrame({ protocol_version: protocolVersion, request_id: requestId, call, deadline_at: deadline, cancellation_id: cancellation, payload });
  if (kind === "response" && outcome !== undefined) return validateFrame({ protocol_version: protocolVersion, request_id: requestId, outcome, ...(payload === undefined ? {} : { payload }), ...(error === undefined ? {} : { error }) });
  if (kind === "progress" && progress !== undefined) return validateFrame({ protocol_version: protocolVersion, request_id: requestId, event: "progress", progress });
  throw new DaemonError("core:ipc_frame_invalid", "Protobuf frame does not match its closed message kind.");
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** Namespaced registered error codes, e.g. `storage:repair_source_missing`, `core:execution_failed`, `jsts:unresolved_call`. */
const REGISTERED_CODE_PATTERN = /^[a-z][a-z0-9_-]*:[a-z0-9_]+$/;

/**
 * If a value the handler threw already carries a registered namespaced
 * `code` (from a `StorageError`, `EngineError`, or similar cross-package
 * error), preserve that code, message, and any plain-object `details` as-is
 * on the wire. Returns `undefined` for anything else -- including plain
 * `Error`s and Node system errors like `ENOENT`/`EACCES`, whose bare `code`
 * is not namespaced and must not leak onto the wire.
 */
function foreignWireError(error: unknown): { readonly code: string; readonly message: string; readonly details: Readonly<Record<string, unknown>> } | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || !REGISTERED_CODE_PATTERN.test(code)) return undefined;
  const details = (error as { details?: unknown }).details;
  return { code, message: error.message, details: record(details) ? details : {} };
}

function scheduleAt(deadline: number, callback: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  const schedule = (): void => {
    if (cancelled) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) { callback(); return; }
    timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };
  schedule();
  return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
}

function validateFrame(value: unknown): IpcFrame {
  if (!record(value) || value["protocol_version"] !== IPC_PROTOCOL_VERSION || typeof value["request_id"] !== "string" || value["request_id"].length === 0) throw new DaemonError("core:ipc_frame_invalid", "IPC frame has invalid protocol or correlation claims.");
  if (value["event"] === "progress") {
    const progress = value["progress"];
    if (!record(progress) || typeof progress["phase"] !== "string" || typeof progress["completed"] !== "number") throw new DaemonError("core:ipc_frame_invalid", "IPC progress frame is incomplete.");
    return value as unknown as IpcProgress;
  }
  if (typeof value["call"] === "string" && typeof value["deadline_at"] === "string" && typeof value["cancellation_id"] === "string" && "payload" in value) return value as unknown as IpcRequest;
  if (value["outcome"] === "success" || value["outcome"] === "error" || value["outcome"] === "cancelled") return value as unknown as IpcResponse;
  throw new DaemonError("core:ipc_frame_invalid", "IPC frame kind is not registered.");
}

export function encodeIpcFrame(frame: IpcFrame, maxFrameBytes = IPC_DEFAULT_MAX_FRAME_BYTES): Buffer {
  const body = Buffer.from(encodeProtoFrame(frame));
  if (body.byteLength > maxFrameBytes) throw new DaemonError("core:ipc_frame_too_large", `IPC frame is ${body.byteLength} bytes; maximum is ${maxFrameBytes}.`);
  const encoded = Buffer.allocUnsafe(body.byteLength + 4);
  encoded.writeUInt32BE(body.byteLength, 0);
  body.copy(encoded, 4);
  return encoded;
}

export function decodeIpcFrame(encoded: Uint8Array, maxFrameBytes = IPC_DEFAULT_MAX_FRAME_BYTES): IpcFrame {
  if (encoded.byteLength < 4) throw new DaemonError("core:ipc_frame_invalid", "IPC frame is missing its length prefix.");
  const length = Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength).readUInt32BE(0);
  if (length > maxFrameBytes) throw new DaemonError("core:ipc_frame_too_large", `IPC frame is ${length} bytes; maximum is ${maxFrameBytes}.`);
  if (encoded.byteLength !== length + 4) throw new DaemonError("core:ipc_frame_invalid", "IPC frame length does not match its payload.");
  try { return decodeProtoFrame(Buffer.from(encoded.buffer, encoded.byteOffset + 4, length)); }
  catch (error) { if (error instanceof DaemonError) throw error; throw new DaemonError("core:ipc_frame_invalid", "Protobuf frame is invalid."); }
}

export class LengthPrefixedDecoder {
  private pending = Buffer.alloc(0);
  constructor(private readonly maxFrameBytes = IPC_DEFAULT_MAX_FRAME_BYTES) {}
  push(chunk: Uint8Array): IpcFrame[] {
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);
    const frames: IpcFrame[] = [];
    while (this.pending.byteLength >= 4) {
      const length = this.pending.readUInt32BE(0);
      if (length > this.maxFrameBytes) throw new DaemonError("core:ipc_frame_too_large", `IPC frame is ${length} bytes; maximum is ${this.maxFrameBytes}.`);
      if (this.pending.byteLength < length + 4) break;
      frames.push(decodeIpcFrame(this.pending.subarray(0, length + 4), this.maxFrameBytes));
      this.pending = this.pending.subarray(length + 4);
    }
    return frames;
  }
}

export interface IpcRequestContext {
  readonly signal: AbortSignal;
  /** Absolute request deadline shared by MCP, IPC, and daemon execution. */
  readonly deadline_at: string;
  readonly reportProgress: (progress: IpcProgress["progress"]) => void;
}
export type IpcRequestHandler = (request: IpcRequest, context: IpcRequestContext) => Promise<unknown>;

export interface LocalIpcServerOptions {
  readonly endpoint: string;
  readonly handler: IpcRequestHandler;
  readonly max_frame_bytes?: number;
}

export class LocalIpcServer {
  private readonly server: Server;
  private readonly controllers = new Map<string, AbortController>();
  private readonly maxFrameBytes: number;
  constructor(private readonly options: LocalIpcServerOptions) {
    this.maxFrameBytes = options.max_frame_bytes ?? IPC_DEFAULT_MAX_FRAME_BYTES;
    this.server = createServer((socket) => this.handleSocket(socket));
  }
  async listen(): Promise<void> { await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(normalizeLocalIpcEndpoint(this.options.endpoint), () => { this.server.removeListener("error", reject); resolve(); }); }); }
  async close(): Promise<void> { for (const controller of this.controllers.values()) controller.abort(); await new Promise<void>((resolve) => this.server.close(() => resolve())); }
  private handleSocket(socket: Socket): void {
    const decoder = new LengthPrefixedDecoder(this.maxFrameBytes);
    const seenRequestIds = new Set<string>();
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      try { for (const frame of decoder.push(chunk)) void this.handleFrame(socket, frame, seenRequestIds); }
      catch (error) { socket.destroy(error instanceof Error ? error : undefined); }
    });
  }
  private async handleFrame(socket: Socket, frame: IpcFrame, seenRequestIds: Set<string>): Promise<void> {
    if (!("call" in frame)) return;
    const request = frame;
    if (seenRequestIds.has(request.request_id)) { this.write(socket, { protocol_version: IPC_PROTOCOL_VERSION, request_id: request.request_id, outcome: "error", error: { code: "core:ipc_request_invalid", message: "IPC request id was already used on this connection." } }); return; }
    seenRequestIds.add(request.request_id);
    const cancelId = request.call === "core:cancel" && record(request.payload) && typeof request.payload["cancellation_id"] === "string" ? request.payload["cancellation_id"] : undefined;
    if (cancelId) { this.controllers.get(cancelId)?.abort(); this.write(socket, { protocol_version: IPC_PROTOCOL_VERSION, request_id: request.request_id, outcome: "success", payload: { cancelled: true } }, request.call); return; }
    const controller = new AbortController();
    const startedAt = Date.now();
    this.controllers.set(request.cancellation_id, controller);
    const reportProgress = (progress: IpcProgress["progress"]): void => this.write(socket, { protocol_version: IPC_PROTOCOL_VERSION, request_id: request.request_id, event: "progress", progress }, request.call);
    const deadline = Date.parse(request.deadline_at); let timedOut = false;
    const cancelTimeout = Number.isFinite(deadline) && deadline > Date.now() ? scheduleAt(deadline, () => { timedOut = true; controller.abort(); }) : undefined;
    try {
      if (!Number.isFinite(deadline)) throw new DaemonError("core:ipc_request_invalid", "IPC request deadline is not a valid timestamp.");
      if (deadline <= Date.now()) throw new DaemonError("core:ipc_timeout", "IPC request deadline has expired.", { deadline_at: request.deadline_at, elapsed_ms: Math.max(0, Date.now() - startedAt), phase: "daemon_admission" });
      const payload = await this.options.handler(request, { signal: controller.signal, deadline_at: request.deadline_at, reportProgress });
      if (timedOut) throw new DaemonError("core:ipc_timeout", "IPC request exceeded its deadline.");
      this.write(socket, { protocol_version: IPC_PROTOCOL_VERSION, request_id: request.request_id, outcome: controller.signal.aborted ? "cancelled" : "success", ...(controller.signal.aborted ? {} : { payload }) }, request.call);
    } catch (error) {
      const wireError = timedOut
        ? { code: "core:ipc_timeout", message: "IPC request exceeded its deadline.", details: { deadline_at: request.deadline_at, elapsed_ms: Math.max(0, Date.now() - startedAt), phase: "daemon_execution" } }
        : error instanceof DaemonError
        ? { code: error.code, message: error.message, details: error.details }
        : foreignWireError(error) ?? { code: "core:execution_failed", message: error instanceof Error ? error.message : "IPC request failed.", details: {} };
      this.write(socket, { protocol_version: IPC_PROTOCOL_VERSION, request_id: request.request_id, outcome: timedOut ? "error" : controller.signal.aborted ? "cancelled" : "error", error: wireError }, request.call);
    } finally { cancelTimeout?.(); this.controllers.delete(request.cancellation_id); }
  }
  /**
   * `encodeIpcFrame` throws `core:ipc_frame_too_large` (a registered
   * `DaemonError`) when a frame's JSON-encoded body exceeds `maxFrameBytes`
   * -- reachable in practice whenever a handler's result embeds a large
   * value (e.g. `core:find_records` returning a record whose body is huge).
   * The old behavior swallowed that error into a bare `socket.destroy()`,
   * which orphaned the request: the client had no error frame to key its
   * rejection on and could only ever discover the failure by hitting its own
   * request-timeout deadline (`LocalIpcClient`'s `cancelTimeout`), long after
   * the daemon already knew what went wrong. Every other write failure
   * (frame-invalid encode errors, a socket that's already gone, etc.) keeps
   * the original destroy-and-give-up behavior -- those aren't a size problem
   * a smaller frame can route around.
   *
   * `call` (the originating request's `call` name, when known -- omitted
   * only for internal frames that were never routed through a request) lets
   * the compact fallback error name which operation's response overflowed,
   * not just that some response somewhere did.
   */
  private write(socket: Socket, frame: IpcFrame, call?: string): void {
    if (socket.destroyed) return;
    try {
      socket.write(encodeIpcFrame(frame, this.maxFrameBytes));
      return;
    } catch (error) {
      const response: IpcResponse | undefined = "outcome" in frame ? frame : undefined;
      const isFrameTooLarge = error instanceof DaemonError && error.code === "core:ipc_frame_too_large";
      if (!response || !isFrameTooLarge) {
        socket.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const operation = call ?? response.request_id;
      const fallback: IpcResponse = {
        protocol_version: IPC_PROTOCOL_VERSION,
        request_id: response.request_id,
        outcome: "error",
        error: { code: "core:ipc_frame_too_large", message: `The response for "${operation}" exceeded the maximum IPC frame size (${error.message})`, details: {} },
      };
      try { socket.write(encodeIpcFrame(fallback, this.maxFrameBytes)); }
      catch { socket.destroy(); }
    }
  }
}

export interface LocalIpcClientOptions { readonly endpoint: string; readonly max_frame_bytes?: number; readonly request_timeout_ms?: number; }
export interface LocalIpcRequestOptions {
  readonly signal?: AbortSignal;
  readonly on_progress?: (progress: IpcProgress["progress"]) => void;
  /** Absolute ISO deadline shared by the caller and daemon. */
  readonly deadline_at?: string;
}

export class LocalIpcClient {
  private sequence = 0;
  constructor(private readonly options: LocalIpcClientOptions) {}
  async request(call: string, payload: unknown, options: LocalIpcRequestOptions = {}): Promise<IpcResponse> {
    const max = this.options.max_frame_bytes ?? IPC_DEFAULT_MAX_FRAME_BYTES;
    const requestId = `ipc-${process.pid}-${this.sequence++}`;
    const cancellationId = `${requestId}:cancel`;
    const startedAt = Date.now();
    const defaultDeadlineMs = startedAt + (this.options.request_timeout_ms ?? 30_000);
    const deadline = options.deadline_at ?? new Date(defaultDeadlineMs).toISOString();
    const deadlineMs = Date.parse(deadline);
    if (!Number.isFinite(deadlineMs)) return Promise.reject(new DaemonError("core:ipc_request_invalid", "IPC request deadline is not a valid timestamp."));
    return new Promise<IpcResponse>((resolve, reject) => {
      const socket = connect(normalizeLocalIpcEndpoint(this.options.endpoint));
      const decoder = new LengthPrefixedDecoder(max);
      let settled = false; let requestSent = false; let cancelRequested = options.signal?.aborted ?? false;
      let cancelTimeout: (() => void) | undefined;
      const finish = (response: IpcResponse): void => {
        if (settled) return;
        settled = true;
        cancelTimeout?.();
        socket.end();
        if (response.outcome === "error" && response.error?.code === "core:ipc_timeout") {
          reject(new DaemonError("core:ipc_timeout", response.error.message, response.error.details ?? {}));
          return;
        }
        resolve(response);
      };
      socket.once("error", (error) => { if (!settled) { settled = true; cancelTimeout?.(); reject(error); } });
      socket.on("data", (chunk) => { for (const frame of decoder.push(chunk)) { if ("event" in frame) options.on_progress?.(frame.progress); else if ("outcome" in frame && frame.request_id === requestId) finish(frame); } });
      const cancel = (): void => { cancelRequested = true; if (!settled && requestSent) socket.write(encodeIpcFrame({ protocol_version: IPC_PROTOCOL_VERSION, request_id: `${requestId}:cancel`, call: "core:cancel", deadline_at: new Date(Date.now() + 1_000).toISOString(), cancellation_id: `${cancellationId}:request`, payload: { cancellation_id: cancellationId } }, max)); };
      socket.once("connect", () => { requestSent = true; socket.write(encodeIpcFrame({ protocol_version: IPC_PROTOCOL_VERSION, request_id: requestId, call, deadline_at: deadline, cancellation_id: cancellationId, payload }, max)); if (cancelRequested) cancel(); });
      if (options.signal && !options.signal.aborted) options.signal.addEventListener("abort", cancel, { once: true });
      cancelTimeout = scheduleAt(deadlineMs, () => { if (settled) return; cancel(); settled = true; socket.destroy(); reject(new DaemonError("core:ipc_timeout", `IPC request exceeded its absolute deadline ${deadline}.`, { deadline_at: deadline, elapsed_ms: Math.max(0, Date.now() - startedAt), phase: "client_transport" })); });
    });
  }
}
