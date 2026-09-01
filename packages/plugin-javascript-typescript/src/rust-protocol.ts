import { Buffer } from "node:buffer";

export const RUST_WORKER_PROTOCOL_IDENTITY = "urdira.ipc.v2" as const;
export const RUST_WORKER_PROTOCOL_VERSION = 3 as const;
export const MAX_RUST_WORKER_FRAME_CHUNK_BYTES = 256 * 1024;
export const MAX_RUST_WORKER_MESSAGE_BYTES = 16 * 1024 * 1024;

const LENGTH_PREFIX_BYTES = 4;
const PROTOBUF_FRAME_VERSION = 2;
const MAX_PROTOBUF_FRAME_OVERHEAD_BYTES = 320;
const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;

export interface RustWorkerFrameOptions {
  readonly stream_id: number;
  readonly cancellation_id: string;
  readonly byte_budget: number;
  readonly in_flight_budget: number;
}

export interface DecodedRustWorkerMessage {
  readonly stream_id: number;
  readonly cancellation_id: string;
  readonly byte_budget: number;
  readonly in_flight_budget: number;
  readonly payload: Buffer;
}

interface PendingStream {
  readonly cancellationId: string;
  readonly byteBudget: number;
  readonly inFlightBudget: number;
  readonly chunks: Buffer[];
  nextSequence: number;
  nextOffset: number;
}

function positiveUint32(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffff_ffff) throw new Error(`${field} must be a positive uint32.`);
  return value;
}

function uint32(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error(`${field} must be a uint32.`);
  return value;
}

function cancellationBytes(value: string): Buffer {
  if (value.length > 240 || /[\0\r\n\t]/u.test(value)) throw new Error("cancellation_id is invalid.");
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > 240) throw new Error("cancellation_id is too long.");
  return bytes;
}

function protobufVarint(value: number): Buffer {
  uint32(value, "protobuf uint32");
  const bytes: number[] = [];
  let remaining = value;
  do {
    const byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    bytes.push(byte | (remaining === 0 ? 0 : 0x80));
  } while (remaining !== 0);
  return Buffer.from(bytes);
}

function protobufVarintField(field: number, value: number): Buffer {
  return Buffer.concat([protobufVarint(field * 8 + WIRE_VARINT), protobufVarint(value)]);
}

function protobufBytesField(field: number, value: Buffer): Buffer {
  return Buffer.concat([protobufVarint(field * 8 + WIRE_LENGTH_DELIMITED), protobufVarint(value.byteLength), value]);
}

function protobufFrame(input: {
  readonly streamId: number;
  readonly sequence: number;
  readonly offset: number;
  readonly byteBudget: number;
  readonly inFlightBudget: number;
  readonly cancellation: Buffer;
  readonly payload: Buffer;
  readonly final: boolean;
}): Buffer {
  return Buffer.concat([
    protobufVarintField(1, PROTOBUF_FRAME_VERSION),
    protobufVarintField(2, input.streamId),
    protobufVarintField(3, input.sequence),
    protobufVarintField(4, input.offset),
    protobufVarintField(5, input.byteBudget),
    protobufVarintField(6, input.inFlightBudget),
    protobufBytesField(7, input.cancellation),
    protobufBytesField(8, input.payload),
    protobufVarintField(9, input.final ? 1 : 0),
  ]);
}

interface ProtobufFrame {
  readonly streamId: number;
  readonly sequence: number;
  readonly offset: number;
  readonly byteBudget: number;
  readonly inFlightBudget: number;
  readonly cancellationId: string;
  readonly payload: Buffer;
  readonly final: boolean;
}

function decodeProtobufFrame(body: Buffer): ProtobufFrame {
  let offset = 0;
  const seen = new Set<number>();
  const scalars = new Map<number, number>();
  const bytes = new Map<number, Buffer>();
  const readVarint = (): number => {
    let value = 0;
    let factor = 1;
    for (let index = 0; index < 5; index += 1) {
      const byte = body[offset++];
      if (byte === undefined) throw new Error("Rust worker Protobuf varint is truncated.");
      value += (byte & 0x7f) * factor;
      if ((byte & 0x80) === 0) return uint32(value, "protobuf uint32");
      factor *= 128;
    }
    throw new Error("Rust worker Protobuf varint exceeds uint32.");
  };
  while (offset < body.byteLength) {
    const tag = readVarint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field < 1 || field > 9 || seen.has(field)) throw new Error("Rust worker Protobuf frame has an unknown or duplicate field.");
    seen.add(field);
    if ([1, 2, 3, 4, 5, 6, 9].includes(field)) {
      if (wire !== WIRE_VARINT) throw new Error("Rust worker Protobuf scalar has the wrong wire type.");
      scalars.set(field, readVarint());
      continue;
    }
    if (wire !== WIRE_LENGTH_DELIMITED) throw new Error("Rust worker Protobuf bytes have the wrong wire type.");
    const length = readVarint();
    if (offset + length > body.byteLength) throw new Error("Rust worker Protobuf bytes are truncated.");
    bytes.set(field, body.subarray(offset, offset + length));
    offset += length;
  }
  if (seen.size !== 9 || scalars.get(1) !== PROTOBUF_FRAME_VERSION) throw new Error("Rust worker Protobuf frame version or required fields are invalid.");
  const cancellation = bytes.get(7)!;
  const cancellationId = cancellation.toString("utf8");
  if (!Buffer.from(cancellationId, "utf8").equals(cancellation)) throw new Error("Rust worker cancellation identity is not UTF-8.");
  cancellationBytes(cancellationId);
  const final = scalars.get(9);
  if (final !== 0 && final !== 1) throw new Error("Rust worker Protobuf final flag is invalid.");
  return {
    streamId: scalars.get(2)!, sequence: scalars.get(3)!, offset: scalars.get(4)!,
    byteBudget: positiveUint32(scalars.get(5)!, "frame byte_budget"),
    inFlightBudget: positiveUint32(scalars.get(6)!, "frame in_flight_budget"),
    cancellationId, payload: bytes.get(8)!, final: final === 1,
  };
}

/** Encode one closed logical message into bounded `urdira.ipc.v2` chunks. */
export function encodeRustWorkerMessage(value: unknown, options: RustWorkerFrameOptions): readonly Buffer[] {
  const streamId = uint32(options.stream_id, "stream_id");
  const byteBudget = positiveUint32(options.byte_budget, "byte_budget");
  const inFlightBudget = positiveUint32(options.in_flight_budget, "in_flight_budget");
  const cancellation = cancellationBytes(options.cancellation_id);
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength > byteBudget || payload.byteLength > inFlightBudget || payload.byteLength > MAX_RUST_WORKER_MESSAGE_BYTES) {
    throw new Error("Rust worker message exceeds its byte or in-flight budget.");
  }
  const maxPayload = MAX_RUST_WORKER_FRAME_CHUNK_BYTES - MAX_PROTOBUF_FRAME_OVERHEAD_BYTES - cancellation.byteLength;
  if (maxPayload <= 0) throw new Error("cancellation_id leaves no frame payload budget.");
  const frames: Buffer[] = [];
  let offset = 0;
  let sequence = 0;
  do {
    const remaining = payload.byteLength - offset;
    const payloadLength = Math.min(maxPayload, Math.max(0, remaining));
    const final = offset + payloadLength === payload.byteLength;
    const body = protobufFrame({
      streamId, sequence, offset, byteBudget, inFlightBudget, cancellation,
      payload: payload.subarray(offset, offset + payloadLength), final,
    });
    if (body.byteLength > MAX_RUST_WORKER_FRAME_CHUNK_BYTES) throw new Error("Rust worker Protobuf frame exceeds its chunk budget.");
    const frame = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + body.byteLength);
    frame.writeUInt32BE(body.byteLength, 0);
    body.copy(frame, LENGTH_PREFIX_BYTES);
    frames.push(frame);
    offset += payloadLength;
    sequence += 1;
  } while (offset < payload.byteLength);
  return frames;
}

/** Incremental decoder for stdout/stderr-style arbitrary stream chunks. */
export class RustWorkerFrameDecoder {
  private buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly streams = new Map<number, PendingStream>();

  constructor(private readonly maxMessageBytes = MAX_RUST_WORKER_MESSAGE_BYTES) {
    positiveUint32(maxMessageBytes, "maxMessageBytes");
  }

  push(chunk: Uint8Array): readonly DecodedRustWorkerMessage[] {
    if (chunk.byteLength === 0) return [];
    this.buffered = this.buffered.byteLength === 0
      ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      : Buffer.concat([this.buffered, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)]);
    const completed: DecodedRustWorkerMessage[] = [];
    while (this.buffered.byteLength >= LENGTH_PREFIX_BYTES) {
      const bodyLength = this.buffered.readUInt32BE(0);
      if (bodyLength < 1 || bodyLength > MAX_RUST_WORKER_FRAME_CHUNK_BYTES) throw new Error("Rust worker frame length is invalid.");
      const frameLength = LENGTH_PREFIX_BYTES + bodyLength;
      if (this.buffered.byteLength < frameLength) break;
      const body = this.buffered.subarray(LENGTH_PREFIX_BYTES, frameLength);
      this.buffered = this.buffered.subarray(frameLength);
      completed.push(...this.acceptFrame(body));
    }
    return completed;
  }

  finish(): void {
    if (this.buffered.byteLength !== 0 || this.streams.size !== 0) throw new Error("Rust worker stream ended with an incomplete frame or message.");
  }

  private acceptFrame(body: Buffer): readonly DecodedRustWorkerMessage[] {
    const decoded = decodeProtobufFrame(body);
    const { streamId, sequence, offset: byteOffset, byteBudget, inFlightBudget, cancellationId, payload } = decoded;
    let pending = this.streams.get(streamId);
    if (pending === undefined) {
      if (sequence !== 0 || byteOffset !== 0) throw new Error("Rust worker stream does not start at sequence and offset zero.");
      pending = { cancellationId, byteBudget, inFlightBudget, chunks: [], nextSequence: 0, nextOffset: 0 };
      this.streams.set(streamId, pending);
    }
    if (pending.cancellationId !== cancellationId || pending.byteBudget !== byteBudget || pending.inFlightBudget !== inFlightBudget) {
      throw new Error("Rust worker stream metadata changed between chunks.");
    }
    if (sequence !== pending.nextSequence || byteOffset !== pending.nextOffset) throw new Error("Rust worker chunks are missing, duplicated, or out of order.");
    const nextSize = pending.nextOffset + payload.byteLength;
    if (nextSize > byteBudget || nextSize > inFlightBudget || nextSize > this.maxMessageBytes) throw new Error("Rust worker message exceeds a mandatory budget.");
    pending.chunks.push(Buffer.from(payload));
    pending.nextOffset = nextSize;
    pending.nextSequence += 1;
    if (!decoded.final) return [];
    this.streams.delete(streamId);
    return [{
      stream_id: streamId,
      cancellation_id: cancellationId,
      byte_budget: byteBudget,
      in_flight_budget: inFlightBudget,
      payload: Buffer.concat(pending.chunks, nextSize),
    }];
  }
}

/** JSON decoder that rejects duplicate object keys before materialization. */
export function decodeRustWorkerMessage(payload: Uint8Array): unknown {
  const text = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf8");
  assertNoDuplicateJsonKeys(text);
  return JSON.parse(text) as unknown;
}

function assertNoDuplicateJsonKeys(text: string): void {
  let offset = 0;
  const whitespace = (): void => { while (/\s/u.test(text[offset] ?? "")) offset += 1; };
  const stringToken = (): string => {
    const start = offset;
    if (text[offset] !== '"') throw new Error("Rust worker JSON string is invalid.");
    offset += 1;
    while (offset < text.length) {
      const value = text[offset];
      if (value === '"') { offset += 1; return JSON.parse(text.slice(start, offset)) as string; }
      if (value === "\\") { offset += 2; continue; }
      if (value === undefined || value.charCodeAt(0) < 0x20) throw new Error("Rust worker JSON string is invalid.");
      offset += 1;
    }
    throw new Error("Rust worker JSON string is unterminated.");
  };
  const value = (): void => {
    whitespace();
    if (text[offset] === "{") {
      offset += 1; whitespace();
      const keys = new Set<string>();
      if (text[offset] === "}") { offset += 1; return; }
      while (true) {
        const key = stringToken();
        if (keys.has(key)) throw new Error(`Rust worker JSON contains duplicate field ${key}.`);
        keys.add(key); whitespace();
        if (text[offset] !== ":") throw new Error("Rust worker JSON object is invalid.");
        offset += 1; value(); whitespace();
        if (text[offset] === "}") { offset += 1; return; }
        if (text[offset] !== ",") throw new Error("Rust worker JSON object is invalid.");
        offset += 1; whitespace();
      }
    }
    if (text[offset] === "[") {
      offset += 1; whitespace();
      if (text[offset] === "]") { offset += 1; return; }
      while (true) {
        value(); whitespace();
        if (text[offset] === "]") { offset += 1; return; }
        if (text[offset] !== ",") throw new Error("Rust worker JSON array is invalid.");
        offset += 1;
      }
    }
    if (text[offset] === '"') { stringToken(); return; }
    const start = offset;
    while (offset < text.length && !/[\s,}\]]/u.test(text[offset]!)) offset += 1;
    if (start === offset) throw new Error("Rust worker JSON value is invalid.");
    JSON.parse(text.slice(start, offset));
  };
  value(); whitespace();
  if (offset !== text.length) throw new Error("Rust worker JSON has trailing data.");
}
