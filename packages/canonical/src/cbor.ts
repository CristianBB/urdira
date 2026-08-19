import { CanonicalEncodingError, fail } from "./errors.js";

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
type EncodingState = Required<CanonicalEncodingLimits> & { element_count: number };

// --- Streaming encode writer ------------------------------------------------
//
// `encodeCanonical` is synchronous and never re-enters itself (the recursive
// tree walk below -- `encodeValue`/`encodeText`/`encodeNumber`/`encodeBigInt`
// -- calls no user code, only itself), so a single module-level growable
// buffer is safe to reuse across the whole encode instead of allocating a
// fresh `Uint8Array` per token and concatenating. `writerLength` resets to 0
// at the start of every top-level `encodeCanonical` call; every exit point
// that hands bytes back to a caller (`encodeCanonical`, `encodeFloat64`)
// returns a fresh `.slice()` copy of the written region, so callers that hold
// on to multiple encoded results at once (e.g. sorting an array of encoded
// map entries) never see the buffer mutated out from under them.
let writer = new Uint8Array(64 * 1024);
let writerLength = 0;

function ensureCapacity(additional: number): void {
  const required = writerLength + additional;
  if (required <= writer.length) return;
  let size = writer.length * 2;
  while (size < required) size *= 2;
  const next = new Uint8Array(size);
  next.set(writer.subarray(0, writerLength));
  writer = next;
}

function writeByte(byte: number): void {
  ensureCapacity(1);
  writer[writerLength] = byte;
  writerLength += 1;
}

function writeRawBytes(bytes: Uint8Array): void {
  ensureCapacity(bytes.length);
  writer.set(bytes, writerLength);
  writerLength += bytes.length;
}

// Shortest-form CBOR header for `major` with a non-negative `value` that is a
// safe JS integer (array/map/string/byte-string lengths, and the fast
// integer path in `encodeNumber`, are always within this range).
function writeHeader(major: number, value: number): void {
  const top = major << 5;
  if (value < 24) { writeByte(top | value); return; }
  if (value <= 0xff) {
    ensureCapacity(2);
    writer[writerLength] = top | 24;
    writer[writerLength + 1] = value;
    writerLength += 2;
    return;
  }
  if (value <= 0xffff) {
    ensureCapacity(3);
    writer[writerLength] = top | 25;
    writer[writerLength + 1] = (value >>> 8) & 0xff;
    writer[writerLength + 2] = value & 0xff;
    writerLength += 3;
    return;
  }
  if (value <= 0xffffffff) {
    ensureCapacity(5);
    writer[writerLength] = top | 26;
    writer[writerLength + 1] = (value >>> 24) & 0xff;
    writer[writerLength + 2] = (value >>> 16) & 0xff;
    writer[writerLength + 3] = (value >>> 8) & 0xff;
    writer[writerLength + 4] = value & 0xff;
    writerLength += 5;
    return;
  }
  // Safe integer >= 2^32: split into two 32-bit halves via exact double
  // arithmetic (value <= Number.MAX_SAFE_INTEGER, so both hi and lo are
  // exactly representable).
  ensureCapacity(9);
  const hi = Math.floor(value / 0x100000000);
  const lo = value % 0x100000000;
  writer[writerLength] = top | 27;
  writer[writerLength + 1] = (hi >>> 24) & 0xff;
  writer[writerLength + 2] = (hi >>> 16) & 0xff;
  writer[writerLength + 3] = (hi >>> 8) & 0xff;
  writer[writerLength + 4] = hi & 0xff;
  writer[writerLength + 5] = (lo >>> 24) & 0xff;
  writer[writerLength + 6] = (lo >>> 16) & 0xff;
  writer[writerLength + 7] = (lo >>> 8) & 0xff;
  writer[writerLength + 8] = lo & 0xff;
  writerLength += 9;
}

// Same shortest-form header, but for a bigint magnitude that can span the
// full unsigned 64-bit range (used only by `encodeBigInt`, for actual
// `bigint` input values).
function writeHeaderBig(major: number, value: bigint): void {
  const top = major << 5;
  if (value < 24n) { writeByte(top | Number(value)); return; }
  if (value <= 0xffn) { writeByte(top | 24); writeByte(Number(value)); return; }
  if (value <= 0xffffn) { writeByte(top | 25); writeBigBytes(value, 2); return; }
  if (value <= 0xffffffffn) { writeByte(top | 26); writeBigBytes(value, 4); return; }
  writeByte(top | 27);
  writeBigBytes(value, 8);
}

function writeBigBytes(value: bigint, width: number): void {
  ensureCapacity(width);
  for (let index = width - 1; index >= 0; index -= 1) {
    writer[writerLength + index] = Number(value & 0xffn);
    value >>= 8n;
  }
  writerLength += width;
}

// Map keys repeat constantly across large record sets (the same field names
// over and over); memoize their encoded CBOR text bytes (header + UTF-8
// payload) so repeat keys skip the scan/validate/encode work entirely.
// Capped to short keys and a bounded entry count so it can never become an
// unbounded memory sink.
const KEY_MEMO_MAX_KEY_LENGTH = 64;
const KEY_MEMO_MAX_ENTRIES = 16_384;
const keyEncodingMemo = new Map<string, Uint8Array>();

function encodeMapKey(key: string, limits: EncodingState): void {
  if (key.length > KEY_MEMO_MAX_KEY_LENGTH) { encodeText(key, limits); return; }
  // A memo hit skips `encodeText`'s per-call limit checks, so it is only
  // taken when this call's limits provably cannot reject a <=64-UTF-16-unit
  // key anyway (<=64 code points, <=3 bytes per unit): restrictive-limit
  // callers keep the exact pre-memo failure behavior.
  const cached = limits.max_text_code_points >= KEY_MEMO_MAX_KEY_LENGTH && limits.max_bytes >= 3 * KEY_MEMO_MAX_KEY_LENGTH ? keyEncodingMemo.get(key) : undefined;
  if (cached !== undefined) { writeRawBytes(cached); return; }
  const start = writerLength;
  encodeText(key, limits);
  if (keyEncodingMemo.size >= KEY_MEMO_MAX_ENTRIES) keyEncodingMemo.clear();
  keyEncodingMemo.set(key, writer.slice(start, writerLength));
}

export function encodeCanonical(value: unknown, limits: CanonicalEncodingLimits = {}): Uint8Array {
  const config: EncodingState = { ...DEFAULT_LIMITS, ...limits, element_count: 0 };
  writerLength = 0;
  encodeValue(value, 0, config);
  if (writerLength > config.max_bytes) {
    fail("uce:resource_limit_exceeded", "normalize", { phase: "normalize", limit_name: "max_bytes", configured_limit: config.max_bytes, observed_value: writerLength });
  }
  return writer.slice(0, writerLength);
}

export const canonicalBytes = encodeCanonical;

function encodeValue(value: unknown, depth: number, limits: EncodingState): void {
  checkDepth(depth, limits, "normalize");
  if (value === null) { writeByte(0xf6); return; }
  if (typeof value === "boolean") { writeByte(value ? 0xf5 : 0xf4); return; }
  if (typeof value === "string") { encodeText(value, limits); return; }
  if (typeof value === "bigint") { encodeBigInt(value); return; }
  if (typeof value === "number") { encodeNumber(value); return; }
  if (value instanceof Uint8Array) {
    if (value.length > limits.max_bytes) limit("normalize", "max_bytes", limits.max_bytes, value.length);
    writeHeader(2, value.length);
    writeRawBytes(value);
    return;
  }
  if (Array.isArray(value)) {
    consumeElements(limits, value.length);
    writeHeader(4, value.length);
    for (const item of value) encodeValue(item, depth + 1, limits);
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null) {
      fail("uce:forbidden_cbor_feature", "normalize", { feature_kind: "language_object" });
    }
    const keys = Object.keys(record);
    const count = keys.length;
    writeHeader(5, count);
    const keyStarts: number[] = new Array(count);
    const keyEnds: number[] = new Array(count);
    const entryEnds: number[] = new Array(count);
    for (let index = 0; index < count; index += 1) {
      const key = keys[index]!;
      keyStarts[index] = writerLength;
      encodeMapKey(key, limits);
      keyEnds[index] = writerLength;
      encodeValue(record[key], depth + 1, limits);
      entryEnds[index] = writerLength;
    }
    finalizeMapEntries(keys, keyStarts, keyEnds, entryEnds, limits);
    return;
  }
  fail("uce:forbidden_cbor_feature", "normalize", { feature_kind: "unsupported_value" });
}

// Sorts the just-encoded entries by their encoded key bytes (already written,
// back-to-back, immediately after the map header), rejects duplicate keys the
// same way the previous allocate-per-entry implementation did, and -- only
// when the original (Object.keys) order wasn't already sorted -- copies the
// entries region once and rewrites it in sorted order. Objects parsed from
// canonical JSON are already key-sorted, so that copy is skipped entirely in
// the common case.
function finalizeMapEntries(keys: readonly string[], keyStarts: readonly number[], keyEnds: readonly number[], entryEnds: readonly number[], limits: EncodingState): void {
  const count = keys.length;
  const compareEntries = (left: number, right: number): number => compareBytes(writer.subarray(keyStarts[left]!, keyEnds[left]!), writer.subarray(keyStarts[right]!, keyEnds[right]!));
  const order: number[] = new Array(count);
  for (let index = 0; index < count; index += 1) order[index] = index;
  let sorted = true;
  for (let index = 1; index < count; index += 1) {
    if (compareEntries(order[index - 1]!, order[index]!) > 0) { sorted = false; break; }
  }
  if (!sorted) order.sort(compareEntries);
  consumeElements(limits, count);
  for (let index = 1; index < count; index += 1) {
    if (compareEntries(order[index - 1]!, order[index]!) === 0) {
      fail("uce:duplicate_map_key", "normalize", { byte_offset: 0, duplicate_key: keys[order[index]!] });
    }
  }
  if (sorted || count === 0) return;
  const regionStart = keyStarts[0]!;
  const regionEnd = entryEnds[count - 1]!;
  const scratch = writer.slice(regionStart, regionEnd);
  let cursor = regionStart;
  for (const index of order) {
    const start = keyStarts[index]! - regionStart;
    const end = entryEnds[index]! - regionStart;
    writer.set(scratch.subarray(start, end), cursor);
    cursor += end - start;
  }
}

function encodeText(value: string, limits: EncodingState): void {
  let codePointCount = 0;
  let byteLength = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) fail("uce:invalid_unicode_scalar", "normalize", { value_path: "" });
      index += 1;
      byteLength += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail("uce:invalid_unicode_scalar", "normalize", { value_path: "" });
    } else if (code < 0x80) {
      byteLength += 1;
    } else if (code < 0x800) {
      byteLength += 2;
    } else {
      byteLength += 3;
    }
    codePointCount += 1;
  }
  if (codePointCount > limits.max_text_code_points) limit("normalize", "max_text_code_points", limits.max_text_code_points, codePointCount);
  if (byteLength > limits.max_bytes) limit("normalize", "max_bytes", limits.max_bytes, byteLength);
  writeHeader(3, byteLength);
  ensureCapacity(byteLength);
  encoder.encodeInto(value, writer.subarray(writerLength, writerLength + byteLength));
  writerLength += byteLength;
}

function encodeNumber(value: number, forceFloat = false): void {
  if (!Number.isFinite(value)) fail("uce:forbidden_cbor_feature", "normalize", { feature_kind: "NON_FINITE_FLOAT" });
  if (Object.is(value, -0)) value = 0;
  if (!forceFloat && Number.isSafeInteger(value)) {
    if (value >= 0) writeHeader(0, value);
    else writeHeader(1, -1 - value);
    return;
  }
  const half = numberToHalf(value);
  if (half !== undefined && halfToNumber(half) === value) {
    writeByte(0xf9);
    writeByte((half >> 8) & 0xff);
    writeByte(half & 0xff);
    return;
  }
  const float32 = Math.fround(value);
  if (float32 === value) {
    ensureCapacity(5);
    writer[writerLength] = 0xfa;
    new DataView(writer.buffer, writer.byteOffset + writerLength + 1, 4).setFloat32(0, value, false);
    writerLength += 5;
    return;
  }
  ensureCapacity(9);
  writer[writerLength] = 0xfb;
  new DataView(writer.buffer, writer.byteOffset + writerLength + 1, 8).setFloat64(0, value, false);
  writerLength += 9;
}

function encodeBigInt(value: bigint): void {
  if (value >= 0n && value <= 0xffffffffffffffffn) { writeHeaderBig(0, value); return; }
  if (value < 0n && value >= -0x10000000000000000n) { writeHeaderBig(1, -1n - value); return; }
  const negative = value < 0n;
  let magnitude = negative ? -1n - value : value;
  const bytes: number[] = [];
  while (magnitude > 0n) {
    bytes.unshift(Number(magnitude & 0xffn));
    magnitude >>= 8n;
  }
  if (bytes.length === 0) bytes.push(0);
  writeByte(negative ? 0xc3 : 0xc2);
  writeHeader(2, bytes.length);
  ensureCapacity(bytes.length);
  for (const byte of bytes) { writer[writerLength] = byte; writerLength += 1; }
}

// --- Standalone (non-writer) helpers ----------------------------------------
//
// These exported helpers can be called independently of any in-progress
// `encodeCanonical` traversal (e.g. `hash.update(encodeArrayHeader(n))` while
// streaming a digest), so they build their own small, independent
// `Uint8Array` rather than touching the shared writer above.

function encodeUnsigned(major: number, value: bigint): Uint8Array {
  if (value < 24n) return Uint8Array.of((major << 5) | Number(value));
  if (value <= 0xffn) return concat(Uint8Array.of((major << 5) | 24), Uint8Array.of(Number(value)));
  if (value <= 0xffffn) return concat(Uint8Array.of((major << 5) | 25), uintBytes(value, 2));
  if (value <= 0xffffffffn) return concat(Uint8Array.of((major << 5) | 26), uintBytes(value, 4));
  return concat(Uint8Array.of((major << 5) | 27), uintBytes(value, 8));
}

function encodeHeader(major: number, length: number): Uint8Array {
  return encodeUnsigned(major, BigInt(length));
}

/**
 * The canonical CBOR major-4 (array) header for an array of `length`
 * elements, with no elements encoded. Canonical CBOR array bytes are exactly
 * `encodeArrayHeader(n)` followed by each element's own `encodeCanonical`
 * bytes concatenated in order -- so a caller that already has each element's
 * encoded bytes (for example to hash them incrementally, one at a time,
 * without ever concatenating the whole array in memory) can reproduce the
 * exact canonical array encoding without calling `encodeCanonical` on the
 * whole array.
 */
export function encodeArrayHeader(length: number): Uint8Array {
  return encodeHeader(4, length);
}

/** The canonical CBOR major-5 (map) header for a map of `length` entries; see {@link encodeArrayHeader}. */
export function encodeMapHeader(length: number): Uint8Array {
  return encodeHeader(5, length);
}

function uintBytes(value: bigint, width: number): Uint8Array {
  const bytes = new Uint8Array(width);
  for (let index = width - 1; index >= 0; index -= 1) {
    bytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

export function decodeCanonical(bytes: Uint8Array, limits: CanonicalEncodingLimits = {}): unknown {
  const config = { ...DEFAULT_LIMITS, ...limits };
  if (bytes.length > config.max_bytes) limit("decode", "max_bytes", config.max_bytes, bytes.length);
  const reader = new Reader(bytes, config);
  const value = reader.value(0);
  if (!reader.done) fail("uce:trailing_data", "decode", { byte_offset: reader.offset });
  return value;
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

class Reader {
  offset = 0;
  elementCount = 0;
  readonly bytes: Uint8Array;
  readonly limits: Required<CanonicalEncodingLimits>;

  constructor(bytes: Uint8Array, limits: Required<CanonicalEncodingLimits>) {
    this.bytes = bytes;
    this.limits = limits;
  }

  get done(): boolean { return this.offset === this.bytes.length; }

  value(depth: number): unknown {
    checkDepth(depth, this.limits, "decode");
    const start = this.offset;
    const initial = this.readByte();
    const major = initial >> 5;
    const additional = initial & 0x1f;
    if (major <= 1) {
      const argument = this.argument(additional, start);
      const integer = major === 0 ? argument : -1n - argument;
      return integer <= BigInt(Number.MAX_SAFE_INTEGER) && integer >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(integer) : integer;
    }
    if (major === 2 || major === 3) {
      const length = this.length(additional, start);
      if (length > this.limits.max_bytes) limit("decode", "max_bytes", this.limits.max_bytes, length);
      const data = this.readBytes(length);
      if (major === 2) return data;
      let text: string;
      try {
        text = UTF8_DECODER.decode(data);
      } catch {
        fail("uce:invalid_utf8", "decode", { byte_offset: start });
      }
      // Checked outside the decode try/catch so a limit violation reports
      // uce:resource_limit_exceeded instead of being masked as invalid UTF-8.
      const textCodePoints = countCodePoints(text);
      if (textCodePoints > this.limits.max_text_code_points) limit("decode", "max_text_code_points", this.limits.max_text_code_points, textCodePoints);
      return text;
    }
    if (major === 4) {
      const length = this.length(additional, start);
      this.consumeElements(length);
      return Array.from({ length }, () => this.value(depth + 1));
    }
    if (major === 5) return this.map(additional, start, depth);
    if (major === 6) return this.tag(additional, start, depth);
    return this.simple(additional, start);
  }

  private map(additional: number, start: number, depth: number): Record<string, unknown> {
    const length = this.length(additional, start);
    this.consumeElements(length);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    let previousKey: Uint8Array | undefined;
    for (let index = 0; index < length; index += 1) {
      const keyStart = this.offset;
      const key = this.value(depth + 1);
      const keyBytes = this.bytes.slice(keyStart, this.offset);
      if (typeof key !== "string") fail("uce:schema_validation_failed", "decode", { value_path: "", validation_kind: "TYPE_MISMATCH" }, "UCE maps require text keys");
      if (previousKey && compareBytes(previousKey, keyBytes) >= 0) {
        if (compareBytes(previousKey, keyBytes) === 0) fail("uce:duplicate_map_key", "decode", { byte_offset: keyStart, duplicate_key: key });
        fail("uce:non_canonical_encoding", "decode", { byte_offset: keyStart, canonicality_kind: "MAP_KEY_ORDER" });
      }
      if (Object.hasOwn(result, key)) fail("uce:duplicate_map_key", "decode", { byte_offset: keyStart, duplicate_key: key });
      result[key] = this.value(depth + 1);
      previousKey = keyBytes;
    }
    return result;
  }

  private tag(additional: number, start: number, depth: number): bigint | { readonly tag: 4; readonly value: unknown } {
    const tag = this.argument(additional, start);
    if (tag === 4n) {
      const value = this.value(depth + 1);
      if (!Array.isArray(value) || value.length !== 2 || !isIntegerValue(value[0]) || !isIntegerValue(value[1])) fail("uce:schema_validation_failed", "decode", { byte_offset: start, validation_kind: "TYPE_MISMATCH", expected_type: "decimal_fraction" });
      return { tag: 4, value };
    }
    if (tag !== 2n && tag !== 3n) fail("uce:forbidden_cbor_feature", "decode", { byte_offset: start, feature_kind: "UNKNOWN_TAG" });
    const initial = this.readByte();
    if (initial >> 5 !== 2) fail("uce:forbidden_cbor_feature", "decode", { byte_offset: this.offset - 1, feature_kind: "UNKNOWN_TAG" });
    const length = this.length(initial & 0x1f, this.offset - 1);
    const magnitudeBytes = this.readBytes(length);
    if (magnitudeBytes.length === 0 || magnitudeBytes[0] === 0) fail("uce:non_canonical_encoding", "decode", { byte_offset: start, canonicality_kind: "TAG_WIDTH" });
    let magnitude = 0n;
    for (const byte of magnitudeBytes) magnitude = (magnitude << 8n) | BigInt(byte);
    if (magnitude <= 0xffffffffffffffffn) fail("uce:non_canonical_encoding", "decode", { byte_offset: start, canonicality_kind: "TAG_WIDTH" });
    return tag === 2n ? magnitude : -1n - magnitude;
  }

  private simple(additional: number, start: number): boolean | null | number {
    if (additional === 20) return false;
    if (additional === 21) return true;
    if (additional === 22) return null;
    if (additional === 25 || additional === 26 || additional === 27) {
      const value = additional === 25 ? halfToNumber(this.readUint(2)) : additional === 26 ? new DataView(this.readBytes(4).buffer).getFloat32(0, false) : new DataView(this.readBytes(8).buffer).getFloat64(0, false);
      if (!Number.isFinite(value) || Object.is(value, -0)) fail("uce:forbidden_cbor_feature", "decode", { byte_offset: start, feature_kind: Object.is(value, -0) ? "NEGATIVE_ZERO" : "NON_FINITE_FLOAT" });
      if (additional === 26 && (Math.fround(value) !== value || (numberToHalf(value) !== undefined && halfToNumber(numberToHalf(value)!) === value))) fail("uce:non_canonical_encoding", "decode", { byte_offset: start, canonicality_kind: "FLOAT_WIDTH" });
      if (additional === 27 && numberToHalf(value) !== undefined && halfToNumber(numberToHalf(value)!) === value) fail("uce:non_canonical_encoding", "decode", { byte_offset: start, canonicality_kind: "FLOAT_WIDTH" });
      if (additional === 27 && Math.fround(value) === value) fail("uce:non_canonical_encoding", "decode", { byte_offset: start, canonicality_kind: "FLOAT_WIDTH" });
      return value;
    }
    fail("uce:forbidden_cbor_feature", "decode", { byte_offset: start, feature_kind: additional === 23 ? "UNDEFINED" : "UNASSIGNED_SIMPLE_VALUE" });
  }

  private argument(additional: number, start: number): bigint {
    if (additional < 24) return BigInt(additional);
    if (additional === 24) { const value = BigInt(this.readUint(1)); if (value < 24n) this.nonCanonical(start, "INTEGER_WIDTH"); return value; }
    if (additional === 25) { const value = BigInt(this.readUint(2)); if (value <= 0xffn) this.nonCanonical(start, "INTEGER_WIDTH"); return value; }
    if (additional === 26) { const value = BigInt(this.readUint(4)); if (value <= 0xffffn) this.nonCanonical(start, "INTEGER_WIDTH"); return value; }
    if (additional === 27) { const value = this.readUintBig(8); if (value <= 0xffffffffn) this.nonCanonical(start, "INTEGER_WIDTH"); return value; }
    fail("uce:forbidden_cbor_feature", "decode", { byte_offset: start, feature_kind: "INDEFINITE_LENGTH" });
  }

  private length(additional: number, start: number): number {
    const value = this.argument(additional, start);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) limit("decode", "max_bytes", this.limits.max_bytes, Number.MAX_SAFE_INTEGER);
    return Number(value);
  }

  private readByte(): number {
    if (this.offset >= this.bytes.length) fail("uce:trailing_data", "decode", { byte_offset: this.offset });
    return this.bytes[this.offset++]!;
  }

  private readBytes(length: number): Uint8Array {
    if (length > this.bytes.length - this.offset) fail("uce:trailing_data", "decode", { byte_offset: this.offset });
    const result = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  private readUint(width: number): number {
    return Number(this.readUintBig(width));
  }

  private readUintBig(width: number): bigint {
    const bytes = this.readBytes(width);
    let result = 0n;
    for (const byte of bytes) result = (result << 8n) | BigInt(byte);
    return result;
  }

  private nonCanonical(byteOffset: number, canonicality_kind: string): never {
    fail("uce:non_canonical_encoding", "decode", { byte_offset: byteOffset, canonicality_kind });
  }

  private consumeElements(count: number): void {
    this.elementCount += count;
    if (this.elementCount > this.limits.max_elements) limit("decode", "max_elements", this.limits.max_elements, this.elementCount);
  }
}

function isIntegerValue(value: unknown): value is number | bigint {
  return typeof value === "bigint" || (typeof value === "number" && Number.isSafeInteger(value));
}

function checkDepth(depth: number, limits: Required<CanonicalEncodingLimits>, phase: "decode" | "normalize"): void {
  if (depth > limits.max_depth) limit(phase, "max_depth", limits.max_depth, depth);
}

function limit(phase: "decode" | "normalize", limit_name: string, configured_limit: number, observed_value: number): never {
  fail("uce:resource_limit_exceeded", phase, { phase, limit_name, configured_limit, observed_value });
}

function consumeElements(limits: EncodingState, count: number): void {
  limits.element_count += count;
  if (limits.element_count > limits.max_elements) limit("normalize", "max_elements", limits.max_elements, limits.element_count);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  return concatAll(parts);
}

// Array-accepting form: spreading large part lists as call arguments overflows
// the call stack at ~125k elements.
function concatAll(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

// Counting via [...value] materializes a per-code-point array; on multi-hundred-MB
// strings that alone exceeds V8's array length limit.
function countCodePoints(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) index += 1;
    count += 1;
  }
  return count;
}

export function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! < right[index]! ? -1 : 1;
  }
  return left.length - right.length;
}

export function encodeDecimalFraction(exponent: bigint, mantissa: bigint): Uint8Array {
  return concat(Uint8Array.of(0xc4), encodeCanonical([exponent, mantissa]));
}

export function encodeFloat64(value: number): Uint8Array {
  writerLength = 0;
  encodeNumber(value, true);
  return writer.slice(0, writerLength);
}

function numberToHalf(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const sign = value < 0 ? 0x8000 : 0;
  const absolute = Math.abs(value);
  if (absolute === 0) return sign;
  if (absolute > 65504) return undefined;
  if (absolute < 2 ** -24) return sign | Math.round(absolute / 2 ** -24);
  const exponent = Math.floor(Math.log2(absolute));
  const mantissa = Math.round((absolute / 2 ** exponent - 1) * 1024);
  let halfExponent = exponent + 15;
  let halfMantissa = mantissa;
  if (halfMantissa === 1024) { halfExponent += 1; halfMantissa = 0; }
  if (halfExponent <= 0) return sign | Math.round(absolute / 2 ** -24);
  if (halfExponent >= 31) return undefined;
  return sign | (halfExponent << 10) | halfMantissa;
}

function halfToNumber(bits: number): number {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * mantissa / 1024;
  if (exponent === 31) return mantissa === 0 ? sign * Infinity : NaN;
  return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

export { CanonicalEncodingError };
