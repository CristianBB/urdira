import { fail } from "./errors.js";

/** Limits applied while encoding or decoding logical values. */
export interface CanonicalEncodingLimits {
  readonly max_depth?: number;
  readonly max_bytes?: number;
  readonly max_text_code_points?: number;
  readonly max_elements?: number;
}

const DEFAULT_LIMITS: Required<CanonicalEncodingLimits> = {
  max_depth: 128,
  max_bytes: 16 * 1024 * 1024,
  max_text_code_points: 4 * 1024 * 1024,
  max_elements: 1_000_000,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * A small, private logical-value framing used only while a value is being
 * reconstructed by the current storage adapters. It is deliberately not a
 * general interchange format: the hot path uses typed rows and arenas, and
 * this framing is retained only for legacy adapter boundaries during the v2
 * migration. It has no versioned wire or persistence contract.
 */
export function encodeCanonical(value: unknown, limits: CanonicalEncodingLimits = {}): Uint8Array {
  const state: State = { ...DEFAULT_LIMITS, ...limits, elements: 0, bytes: 0 };
  const writer = new Writer(state);
  writeValue(writer, value, 0, state);
  return writer.finish();
}

export const canonicalBytes = encodeCanonical;

export function decodeCanonical(bytes: Uint8Array, limits: CanonicalEncodingLimits = {}): unknown {
  const state: State = { ...DEFAULT_LIMITS, ...limits, elements: 0, bytes: bytes.length };
  if (bytes.length > state.max_bytes) limit(state, "max_bytes", bytes.length);
  const reader = new Reader(bytes, state);
  const value = reader.value(0);
  if (!reader.done) fail("uce:trailing_data", "decode", { byte_offset: reader.offset });
  return value;
}

export function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1;
  }
  return left.length - right.length;
}

export function encodeArrayHeader(length: number): Uint8Array {
  return Uint8Array.from([5, ...varint(length)]);
}

export function encodeMapHeader(length: number): Uint8Array {
  return Uint8Array.from([6, ...varint(length)]);
}

export function encodeFloat64(value: number): Uint8Array {
  if (!Number.isFinite(value) || Object.is(value, -0)) fail("uce:schema_validation_failed", "normalize", { value_path: "", validation_kind: "TYPE_MISMATCH" });
  const result = new Uint8Array(9);
  result[0] = 7;
  new DataView(result.buffer).setFloat64(1, value, false);
  return result;
}

export function encodeDecimalFraction(exponent: bigint, mantissa: bigint): Uint8Array {
  return encodeCanonical([exponent, mantissa]);
}

interface State extends Required<CanonicalEncodingLimits> {
  elements: number;
  bytes: number;
}

class Writer {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;
  constructor(private readonly state: State) {}
  write(value: Uint8Array): void {
    this.length += value.length;
    if (this.length > this.state.max_bytes) limit(this.state, "max_bytes", this.length);
    this.chunks.push(value);
  }
  finish(): Uint8Array {
    const result = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  }
}

function writeValue(writer: Writer, value: unknown, depth: number, state: State): void {
  if (depth > state.max_depth) limit(state, "max_depth", depth);
  if (value === null) { writer.write(Uint8Array.of(0)); return; }
  if (value === false) { writer.write(Uint8Array.of(1)); return; }
  if (value === true) { writer.write(Uint8Array.of(2)); return; }
  if (typeof value === "string") { writeText(writer, value, state); return; }
  if (value instanceof Uint8Array) { writeBytes(writer, value, state); return; }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("uce:schema_validation_failed", "normalize", { value_path: "", validation_kind: "TYPE_MISMATCH" });
    writer.write(encodeFloat64(Object.is(value, -0) ? 0 : value));
    return;
  }
  if (typeof value === "bigint") { writeBigInt(writer, value, state); return; }
  if (Array.isArray(value)) {
    consume(state, value.length);
    writer.write(Uint8Array.of(5)); writer.write(varint(value.length));
    for (const item of value) writeValue(writer, item, depth + 1, state);
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) fail("uce:schema_validation_failed", "normalize", { value_path: "", validation_kind: "TYPE_MISMATCH" });
    const entries = Object.keys(record).map((key) => ({ key, keyBytes: encoder.encode(key), value: record[key] }));
    entries.sort((left, right) => compareBytes(left.keyBytes, right.keyBytes));
    consume(state, entries.length);
    writer.write(Uint8Array.of(6)); writer.write(varint(entries.length));
    let previous: Uint8Array | undefined;
    for (const entry of entries) {
      if (previous && compareBytes(previous, entry.keyBytes) === 0) fail("uce:duplicate_map_key", "normalize", { byte_offset: 0, duplicate_key: entry.key });
      writeText(writer, entry.key, state);
      writeValue(writer, entry.value, depth + 1, state);
      previous = entry.keyBytes;
    }
    return;
  }
  fail("uce:schema_validation_failed", "normalize", { value_path: "", validation_kind: "TYPE_MISMATCH" });
}

function writeText(writer: Writer, value: string, state: State): void {
  validateUnicode(value, state);
  const bytes = encoder.encode(value);
  writer.write(Uint8Array.of(3)); writer.write(varint(bytes.length)); writer.write(bytes);
}

function writeBytes(writer: Writer, value: Uint8Array, state: State): void {
  if (value.length > state.max_bytes) limit(state, "max_bytes", value.length);
  writer.write(Uint8Array.of(4)); writer.write(varint(value.length)); writer.write(value);
}

function writeBigInt(writer: Writer, value: bigint, state: State): void {
  const negative = value < 0n;
  let magnitude = negative ? -value : value;
  const bytes: number[] = [];
  do { bytes.unshift(Number(magnitude & 0xffn)); magnitude >>= 8n; } while (magnitude > 0n);
  consume(state, bytes.length);
  writer.write(Uint8Array.of(8, negative ? 1 : 0)); writer.write(varint(bytes.length)); writer.write(Uint8Array.from(bytes));
}

class Reader {
  private offsetValue = 0;
  private elements = 0;
  constructor(private readonly bytes: Uint8Array, private readonly state: State) {}
  get offset(): number { return this.offsetValue; }
  get done(): boolean { return this.offsetValue === this.bytes.length; }
  value(depth: number): unknown {
    if (depth > this.state.max_depth) limit(this.state, "max_depth", depth);
    const tag = this.byte();
    if (tag === 0) return null;
    if (tag === 1) return false;
    if (tag === 2) return true;
    if (tag === 3) {
      const text = decoder.decode(this.bytesValue());
      validateUnicode(text, this.state);
      return text;
    }
    if (tag === 4) return this.bytesValue();
    if (tag === 5) return this.array(depth);
    if (tag === 6) return this.map(depth);
    if (tag === 7) {
      const bytes = this.readBytes(8);
      const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, false);
      if (!Number.isFinite(value) || Object.is(value, -0)) fail("uce:schema_validation_failed", "decode", { value_path: "", validation_kind: "TYPE_MISMATCH" });
      return value;
    }
    if (tag === 8) {
      const negative = this.byte() === 1;
      const magnitude = this.bytesValue();
      let result = 0n;
      for (const byte of magnitude) result = (result << 8n) | BigInt(byte);
      return negative ? -result : result;
    }
    fail("uce:schema_validation_failed", "decode", { value_path: "", validation_kind: "TYPE_MISMATCH" });
  }
  private array(depth: number): unknown[] {
    const length = this.count(); const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) result.push(this.value(depth + 1));
    return result;
  }
  private map(depth: number): Record<string, unknown> {
    const length = this.count(); const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    let previous: Uint8Array | undefined;
    for (let index = 0; index < length; index += 1) {
      const keyStart = this.offset;
      const key = this.value(depth + 1);
      const keyBytes = typeof key === "string" ? encoder.encode(key) : this.bytes.slice(keyStart, this.offset);
      if (typeof key !== "string") fail("uce:schema_validation_failed", "decode", { value_path: "", validation_kind: "TYPE_MISMATCH" });
      if (previous && compareBytes(previous, keyBytes) >= 0) fail(previous.length === keyBytes.length && compareBytes(previous, keyBytes) === 0 ? "uce:duplicate_map_key" : "uce:non_canonical_encoding", "decode", { byte_offset: keyStart });
      result[key] = this.value(depth + 1); previous = keyBytes;
    }
    return result;
  }
  private bytesValue(): Uint8Array { return this.readBytes(this.lengthValue()); }
  private count(): number {
    const value = this.lengthValue();
    this.elements += value;
    if (this.elements > this.state.max_elements) limit(this.state, "max_elements", this.elements);
    return value;
  }
  private lengthValue(): number { return readVarint(this); }
  private byte(): number { return this.readBytes(1)[0]!; }
  readBytes(length: number): Uint8Array {
    if (length < 0 || length > this.bytes.length - this.offsetValue) fail("uce:trailing_data", "decode", { byte_offset: this.offsetValue });
    const result = this.bytes.slice(this.offsetValue, this.offsetValue + length); this.offsetValue += length; return result;
  }
}

function readVarint(reader: Reader): number {
  let result = 0; let shift = 0;
  for (let index = 0; index < 5; index += 1) {
    const byte = reader.readBytes(1)[0]!;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(result)) fail("uce:resource_limit_exceeded", "decode", { limit_name: "max_bytes", observed_value: result });
      return result;
    }
    shift += 7;
  }
  fail("uce:resource_limit_exceeded", "decode", { limit_name: "max_bytes", observed_value: Number.MAX_SAFE_INTEGER });
}

function varint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("logical length must be a non-negative safe integer");
  const bytes: number[] = [];
  do { const next = value % 128; value = Math.floor(value / 128); bytes.push(next | (value > 0 ? 0x80 : 0)); } while (value > 0);
  return Uint8Array.from(bytes);
}

function consume(state: State, count: number): void {
  state.elements += count;
  if (state.elements > state.max_elements) limit(state, "max_elements", state.elements);
}

function validateUnicode(value: string, state: State): void {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) fail("uce:invalid_unicode_scalar", "normalize", { value_path: "" });
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) fail("uce:invalid_unicode_scalar", "normalize", { value_path: "" });
    count += 1;
  }
  if (count > state.max_text_code_points) limit(state, "max_text_code_points", count);
}

function limit(state: State, limitName: string, observed: number): never {
  fail("uce:resource_limit_exceeded", "normalize", { phase: "normalize", limit_name: limitName, configured_limit: state[limitName as keyof State] as number, observed_value: observed });
}
