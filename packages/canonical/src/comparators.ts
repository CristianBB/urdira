import type { ComparatorDefinition, ComparatorSortKeyDefinition } from "@urdira/contracts";
import { compareBytes, encodeCanonical } from "./cbor.js";
import { fail } from "./errors.js";
import { normalizeBigInteger, normalizeExactDecimal, normalizeText, normalizeTimestamp, timestampNanoseconds } from "./scalars.js";

export type CanonicalComparator = Pick<ComparatorDefinition, "comparator_id" | "comparator_version" | "sort_keys"> | {
  readonly comparator_id: string;
  readonly comparator_version: number;
  readonly sort_keys: readonly ComparatorSortKeyDefinition[];
};

export function compareCanonicalValues(left: unknown, right: unknown, comparator: CanonicalComparator): number {
  for (const key of comparator.sort_keys) {
    const leftValue = readPointer(left, key.value_path);
    const rightValue = readPointer(right, key.value_path);
    const leftAbsent = leftValue === ABSENT;
    const rightAbsent = rightValue === ABSENT;
    if (leftAbsent || rightAbsent) {
      if (leftAbsent && rightAbsent) continue;
      if (key.absent_order === "forbidden") fail("uce:schema_validation_failed", "schema_validation", { value_path: key.value_path, validation_kind: "REQUIRED_FIELD_MISSING" });
      const absentResult = leftAbsent ? -1 : 1;
      return key.absent_order === "first" ? absentResult : -absentResult;
    }
    const result = compareByMode(leftValue, rightValue, key.comparison_mode, key.value_path);
    if (result !== 0) return key.direction === "ascending" ? result : -result;
  }
  return compareBytes(encodeCanonical(left), encodeCanonical(right));
}

export function sortCanonicalValues<T>(values: readonly T[], comparator: CanonicalComparator): T[] {
  return values.toSorted((left, right) => compareCanonicalValues(left, right, comparator));
}

export function canonicalSetValues<T>(values: readonly T[]): T[] {
  const sorted = values.toSorted((left, right) => compareBytes(encodeCanonical(left), encodeCanonical(right)));
  for (let index = 1; index < sorted.length; index += 1) {
    if (compareBytes(encodeCanonical(sorted[index - 1]), encodeCanonical(sorted[index])) === 0) {
      fail("uce:schema_validation_failed", "schema_validation", { value_path: `/${index}`, validation_kind: "DUPLICATE_SET_ELEMENT" });
    }
  }
  return sorted;
}

export function readCanonicalPointer(value: unknown, pointer: string): unknown {
  const result = readPointer(value, pointer);
  if (result === ABSENT) fail("uce:digest_binding_invalid", "recipe_validation", { binding_failure_kind: "SOURCE_PATH_INVALID", source_path: pointer });
  return result;
}

const ABSENT = Symbol("absent");

function readPointer(value: unknown, pointer: string): unknown | typeof ABSENT {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) return ABSENT;
  let current: unknown = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return ABSENT;
      const index = Number(key);
      if (index >= current.length) return ABSENT;
      current = current[index];
    } else if (current !== null && typeof current === "object" && Object.hasOwn(current, key)) {
      current = (current as Record<string, unknown>)[key];
    } else return ABSENT;
  }
  return current;
}

function compareByMode(left: unknown, right: unknown, mode: string, path: string): number {
  switch (mode) {
    case "uce_bytes": return compareBytes(encodeCanonical(left), encodeCanonical(right));
    case "text_utf8": return compareBytes(textBytes(left, path), textBytes(right, path));
    case "bytes_lexicographic": return compareBytes(byteValue(left, path), byteValue(right, path));
    case "safe_integer_numeric": return compareNumbers(left, right, path);
    case "big_integer_numeric": return compareBigInts(left, right, path);
    case "float64_numeric": return compareNumbers(left, right, path);
    case "exact_decimal_numeric": return compareDecimals(left, right, path);
    case "timestamp_chronological": return compareTimestamps(left, right, path);
    case "digest_bytes": return compareDigestBytes(left, right, path);
    default: fail("uce:schema_validation_failed", "schema_validation", { value_path: path, validation_kind: "CONSTRAINT_FAILED", comparison_mode: mode });
  }
}

function textBytes(value: unknown, path: string): Uint8Array {
  if (typeof value !== "string") fail("uce:schema_validation_failed", "schema_validation", { value_path: path, validation_kind: "TYPE_MISMATCH", expected_type: "text" });
  return new TextEncoder().encode(normalizeText(value));
}

function byteValue(value: unknown, path: string): Uint8Array {
  if (!(value instanceof Uint8Array)) fail("uce:schema_validation_failed", "schema_validation", { value_path: path, validation_kind: "TYPE_MISMATCH", expected_type: "bytes" });
  return value;
}

function compareNumbers(left: unknown, right: unknown, path: string): number {
  if (typeof left !== "number" || typeof right !== "number" || !Number.isFinite(left) || !Number.isFinite(right)) fail("uce:schema_validation_failed", "schema_validation", { value_path: path, validation_kind: "TYPE_MISMATCH", expected_type: "finite_number" });
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareBigInts(left: unknown, right: unknown, path: string): number {
  try {
    const l = typeof left === "bigint" ? left : normalizeBigInteger(left);
    const r = typeof right === "bigint" ? right : normalizeBigInteger(right);
    return l < r ? -1 : l > r ? 1 : 0;
  } catch {
    fail("uce:schema_validation_failed", "schema_validation", { value_path: path, validation_kind: "TYPE_MISMATCH", expected_type: "big_integer" });
  }
}

function compareDecimals(left: unknown, right: unknown, path: string): number {
  if (typeof left !== "string" || typeof right !== "string") fail("uce:schema_validation_failed", "schema_validation", { value_path: path, validation_kind: "TYPE_MISMATCH", expected_type: "exact_decimal" });
  const normalizedLeft = normalizeExactDecimal(left, "insignificant").slice(8);
  const normalizedRight = normalizeExactDecimal(right, "insignificant").slice(8);
  const [leftInteger, leftFraction = ""] = normalizedLeft.replace(/^-/, "").split(".");
  const [rightInteger, rightFraction = ""] = normalizedRight.replace(/^-/, "").split(".");
  const leftNegative = normalizedLeft.startsWith("-") && normalizedLeft !== "0";
  const rightNegative = normalizedRight.startsWith("-") && normalizedRight !== "0";
  if (leftNegative !== rightNegative) return leftNegative ? -1 : 1;
  const sign = leftNegative ? -1 : 1;
  const l = `${leftInteger}${leftFraction}`.replace(/^0+(?=[0-9])/, "") + "0".repeat(Math.max(0, rightFraction.length - leftFraction.length));
  const r = `${rightInteger}${rightFraction}`.replace(/^0+(?=[0-9])/, "") + "0".repeat(Math.max(0, leftFraction.length - rightFraction.length));
  return sign * (l.length === r.length ? (l < r ? -1 : l > r ? 1 : 0) : l.length < r.length ? -1 : 1);
}

function compareTimestamps(left: unknown, right: unknown, path: string): number {
  if (typeof left !== "string" || typeof right !== "string") fail("uce:schema_validation_failed", "schema_validation", { value_path: path, validation_kind: "TYPE_MISMATCH", expected_type: "timestamp" });
  const l = timestampNanoseconds(normalizeTimestamp(left));
  const r = timestampNanoseconds(normalizeTimestamp(right));
  return l < r ? -1 : l > r ? 1 : 0;
}

function compareDigestBytes(left: unknown, right: unknown, path: string): number {
  if (typeof left !== "string" || typeof right !== "string" || !/^sha256:[0-9a-f]{64}$/.test(left) || !/^sha256:[0-9a-f]{64}$/.test(right)) fail("uce:schema_validation_failed", "schema_validation", { value_path: path, validation_kind: "TYPE_MISMATCH", expected_type: "digest" });
  return compareBytes(hexToBytes(left.slice(7)), hexToBytes(right.slice(7)));
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
