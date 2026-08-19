import { fail } from "./errors.js";

export function normalizeText(value: unknown): string {
  if (typeof value !== "string") fail("uce:schema_validation_failed", "normalize", { value_path: "", validation_kind: "TYPE_MISMATCH", expected_type: "text" });
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code >= 0xd800 && code <= 0xdbff && !isLowSurrogate(value.charCodeAt(index + 1))) || (code >= 0xdc00 && code <= 0xdfff)) fail("uce:invalid_unicode_scalar", "normalize", { value_path: "" });
  }
  return value;
}

export function normalizeBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value !== "string" || !value.startsWith("base64url:")) fail("uce:schema_validation_failed", "normalize", { value_path: "", validation_kind: "TYPE_MISMATCH", expected_type: "Bytes" });
  const encoded = value.slice("base64url:".length);
  if (!/^[A-Za-z0-9_-]*$/.test(encoded) || encoded.length % 4 === 1 || encoded.includes("=")) fail("uce:schema_validation_failed", "normalize", { value_path: "", validation_kind: "CONSTRAINT_FAILED", constraint_name: "base64url" });
  const bytes = Uint8Array.from(Buffer.from(encoded.replaceAll("-", "+").replaceAll("_", "/"), "base64"));
  if (toBase64Url(bytes) !== value) fail("uce:schema_validation_failed", "normalize", { value_path: "", validation_kind: "CONSTRAINT_FAILED", constraint_name: "base64url" });
  return bytes;
}

export function toBase64Url(value: Uint8Array): string {
  return `base64url:${Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

export function normalizeDigest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) fail("uce:schema_validation_failed", "normalize", { value_path: "", validation_kind: "TYPE_MISMATCH", expected_type: "Digest" });
  return value;
}

export function normalizeBigInteger(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value !== "string" || !value.startsWith("bigint:") || !/^-?(?:0|[1-9][0-9]*)$/.test(value.slice(7))) fail("uce:numeric_value_out_of_range", "normalize", { value_path: "", numeric_type: "big_integer", range_failure_kind: "DECIMAL_SYNTAX" });
  return BigInt(value.slice(7));
}

export function toBigIntegerText(value: bigint): `bigint:${string}` {
  return `bigint:${value.toString()}`;
}

export function normalizeExactDecimal(value: unknown, scalePolicy: "significant" | "insignificant"): string {
  if (typeof value !== "string" || !value.startsWith("decimal:") || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value.slice(8))) fail("uce:numeric_value_out_of_range", "normalize", { value_path: "", numeric_type: "exact_decimal", range_failure_kind: "DECIMAL_SYNTAX" });
  const text = value.slice(8);
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  let [integer, fraction = ""] = unsigned.split(".");
  if (scalePolicy === "insignificant") {
    fraction = fraction.replace(/0+$/, "");
    integer = (integer ?? "").replace(/^0+(?=[0-9])/, "");
    if (integer === "0" && fraction.length === 0) return "decimal:0";
  }
  return `decimal:${negative ? "-" : ""}${integer}${fraction.length > 0 ? `.${fraction}` : ""}`;
}

export function normalizeTimestamp(value: unknown): string {
  if (typeof value !== "string" || !/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{9})Z$/.test(value)) fail("uce:schema_validation_failed", "normalize", { value_path: "", validation_kind: "TIMESTAMP_INVALID" });
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{9})Z$/)!;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) fail("uce:schema_validation_failed", "normalize", { value_path: "", validation_kind: "TIMESTAMP_INVALID" });
  const date = dateFromFields(year, month, day, hour, minute, second);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) fail("uce:schema_validation_failed", "normalize", { value_path: "", validation_kind: "TIMESTAMP_INVALID" });
  return value;
}

export function timestampNanoseconds(value: string): bigint {
  normalizeTimestamp(value);
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{9})Z$/)!;
  const milliseconds = BigInt(dateFromFields(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])).getTime());
  return milliseconds * 1_000_000n + BigInt(match[7]!);
}

export function timestampFromNanoseconds(value: bigint | number): string {
  const nanoseconds = typeof value === "number" ? BigInt(value) : value;
  let milliseconds = nanoseconds / 1_000_000n;
  let remainder = nanoseconds % 1_000_000n;
  if (remainder < 0n) { milliseconds -= 1n; remainder += 1_000_000n; }
  const date = new Date(Number(milliseconds));
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) fail("uce:schema_validation_failed", "schema_validation", { value_path: "", validation_kind: "TIMESTAMP_INVALID" });
  const nanosecondsWithinSecond = BigInt(date.getUTCMilliseconds()) * 1_000_000n + remainder;
  const nanos = nanosecondsWithinSecond.toString().padStart(9, "0");
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}T${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")}.${nanos}Z`;
}

function isLowSurrogate(value: number): boolean { return value >= 0xdc00 && value <= 0xdfff; }

function dateFromFields(year: number, month: number, day: number, hour: number, minute: number, second: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date;
}
