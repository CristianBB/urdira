import { createHash } from "node:crypto";
import { sdkError } from "./errors.js";

export type CanonicalJsonValue = null | boolean | number | string | readonly CanonicalJsonValue[] | { readonly [key: string]: CanonicalJsonValue };

const UTF8_ENCODER = new TextEncoder();

function compareEncodedEqualityTieBreak(left: string, right: string): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

export function compareUtf8Bytes(left: string, right: string): number {
  const leftBytes = UTF8_ENCODER.encode(left);
  const rightBytes = UTF8_ENCODER.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  const lengthDifference = leftBytes.length - rightBytes.length;
  if (lengthDifference !== 0) return lengthDifference;
  return compareEncodedEqualityTieBreak(left, right);
}

// `encode()`'s object-key sort used to call `compareUtf8Bytes` (which
// `TextEncoder.encode`s BOTH strings) on every comparison -- O(k log k)
// re-encodes per object across 177k+ objects. Encode each key's UTF-8 bytes
// once instead, memoized (short keys repeat constantly across records), then
// sort by the precomputed bytes with the same byte-lexicographic-then-UTF-16
// tie-break semantics as `compareUtf8Bytes` itself (left unchanged below --
// other callers use it directly).
const KEY_BYTES_MEMO_MAX_KEY_LENGTH = 64;
const KEY_BYTES_MEMO_MAX_ENTRIES = 16_384;
const keyBytesMemo = new Map<string, Uint8Array>();

function keyUtf8Bytes(key: string): Uint8Array {
  if (key.length > KEY_BYTES_MEMO_MAX_KEY_LENGTH) return UTF8_ENCODER.encode(key);
  const cached = keyBytesMemo.get(key);
  if (cached !== undefined) return cached;
  const bytes = UTF8_ENCODER.encode(key);
  if (keyBytesMemo.size >= KEY_BYTES_MEMO_MAX_ENTRIES) keyBytesMemo.clear();
  keyBytesMemo.set(key, bytes);
  return bytes;
}

function compareKeyEntries(left: { readonly key: string; readonly bytes: Uint8Array }, right: { readonly key: string; readonly bytes: Uint8Array }): number {
  const sharedLength = Math.min(left.bytes.length, right.bytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left.bytes[index]! - right.bytes[index]!;
    if (difference !== 0) return difference;
  }
  const lengthDifference = left.bytes.length - right.bytes.length;
  if (lengthDifference !== 0) return lengthDifference;
  return compareEncodedEqualityTieBreak(left.key, right.key);
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) throw sdkError("plugin-sdk:canonical_value_invalid", "Canonical JSON numbers must be finite safe integers.");
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (value instanceof Uint8Array) return JSON.stringify({ $bytes: Buffer.from(value).toString("base64") });
  if (typeof value !== "object") throw sdkError("plugin-sdk:canonical_value_invalid", "Canonical JSON contains an unsupported value.");
  if (ancestors.has(value)) throw sdkError("plugin-sdk:canonical_value_invalid", "Canonical JSON contains a cycle.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => encode(item, ancestors)).join(",")}]`;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw sdkError("plugin-sdk:canonical_value_invalid", "Canonical JSON requires plain objects.");
    const record = value as Record<string, unknown>;
    const keyed = Object.keys(record).map((key) => ({ key, bytes: keyUtf8Bytes(key) }));
    keyed.sort(compareKeyEntries);
    return `{${keyed.map(({ key }) => `${JSON.stringify(key)}:${encode(record[key], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return encode(value, new Set());
}

export function canonicalSha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

export function sha256Bytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function hasExactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value instanceof Uint8Array) return value;
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
