import { describe, expect, it } from "vitest";
import {
  canonicalSetValues,
  canonicalize,
  compareCanonicalValues,
  compareBytes,
  computeDigest,
  computeDigestRecipe,
  decodeCanonical,
  decodeDigest,
  digestBytes,
  digestEnvelope,
  digestPayloadBytes,
  digestToBytes,
  digestRecipeDefinitions,
  encodeDigest,
  encodeCanonical,
  encodeFloat64,
  encodeSchemaValue,
  normalizeBigInteger,
  normalizeBytes,
  normalizeDigest,
  normalizeExactDecimal,
  normalizeText,
  normalizeTimestamp,
  readCanonicalPointer,
  sortCanonicalValues,
  timestampFromNanoseconds,
  timestampNanoseconds,
  toBase64Url,
  toBigIntegerText,
  validateDigestRecipeGraph,
  verifyDigest,
  type CanonicalComparator,
} from "../packages/canonical/src/index.js";

const comparator = (mode: string, absent_order: "first" | "last" | "forbidden" = "forbidden"): CanonicalComparator => ({
  comparator_id: `coverage:${mode}`,
  comparator_version: 1,
  sort_keys: [{ value_path: "/value", direction: "ascending" as const, comparison_mode: mode, absent_order }],
}) as unknown as CanonicalComparator;

describe("canonical repository coverage vectors", () => {
  it("exercises every persisted scalar and comparator representation", () => {
    expect(compareCanonicalValues({ value: "a" }, { value: "b" }, comparator("uce_bytes"))).toBeLessThan(0);
    expect(compareCanonicalValues({ value: "a" }, { value: "b" }, comparator("text_utf8"))).toBeLessThan(0);
    expect(compareCanonicalValues({ value: new Uint8Array([1]) }, { value: new Uint8Array([2]) }, comparator("bytes_lexicographic"))).toBeLessThan(0);
    expect(compareCanonicalValues({ value: 1 }, { value: 2 }, comparator("safe_integer_numeric"))).toBeLessThan(0);
    expect(compareCanonicalValues({ value: "bigint:1" }, { value: "bigint:2" }, comparator("big_integer_numeric"))).toBeLessThan(0);
    expect(compareCanonicalValues({ value: 1.5 }, { value: 2.5 }, comparator("float64_numeric"))).toBeLessThan(0);
    expect(compareCanonicalValues({ value: "decimal:1.20" }, { value: "decimal:1.30" }, comparator("exact_decimal_numeric"))).toBeLessThan(0);
    expect(compareCanonicalValues({ value: "2026-08-09T00:00:00.000000000Z" }, { value: "2026-08-09T00:00:00.000000001Z" }, comparator("timestamp_chronological"))).toBeLessThan(0);
    expect(compareCanonicalValues({ value: "sha256:0000000000000000000000000000000000000000000000000000000000000000" }, { value: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" }, comparator("digest_bytes"))).toBeLessThan(0);
    expect(compareCanonicalValues({}, { value: 1 }, comparator("safe_integer_numeric", "first"))).toBeLessThan(0);
    expect(compareCanonicalValues({ value: 1 }, {}, comparator("safe_integer_numeric", "last"))).toBeLessThan(0);
    expect(sortCanonicalValues([{ value: 2 }, { value: 1 }], comparator("safe_integer_numeric"))).toEqual([{ value: 1 }, { value: 2 }]);
    expect(canonicalSetValues(["b", "a"])).toEqual(["a", "b"]);
    expect(readCanonicalPointer({ a: [{ b: "ok" }] }, "/a/0/b")).toBe("ok");
    expect(compareBytes(new Uint8Array([1]), new Uint8Array([2]))).toBeLessThan(0);
    expect(canonicalize({ z: -0, a: [2, { b: 1 }] })).toEqual({ a: [2, { b: 1 }], z: 0 });
  });

  it("exercises canonical scalar normalization and temporal round trips", () => {
    expect(normalizeText("raw")).toBe("raw");
    expect(() => normalizeText(42)).toThrow();
    expect(() => normalizeText(String.fromCharCode(0xd800))).toThrow();
    expect(normalizeBytes("base64url:AA")).toEqual(new Uint8Array([0]));
    expect(() => normalizeBytes("invalid")).toThrow();
    expect(() => normalizeBytes("base64url:A")).toThrow();
    expect(toBase64Url(new Uint8Array([0]))).toBe("base64url:AA");
    expect(normalizeDigest("sha256:" + "0".repeat(64))).toContain("sha256:");
    expect(() => normalizeDigest("invalid")).toThrow();
    expect(normalizeBigInteger("bigint:42")).toBe(42n);
    expect(() => normalizeBigInteger("invalid")).toThrow();
    expect(toBigIntegerText(42n)).toBe("bigint:42");
    expect(normalizeExactDecimal("decimal:1.200", "insignificant")).toBe("decimal:1.2");
    expect(() => normalizeExactDecimal("invalid", "significant")).toThrow();
    const timestamp = "2026-08-09T00:00:00.123456789Z";
    expect(normalizeTimestamp(timestamp)).toBe(timestamp);
    expect(timestampFromNanoseconds(timestampNanoseconds(timestamp))).toBe(timestamp);
    expect(() => normalizeTimestamp("invalid")).toThrow();
  });

  it("round-trips digest envelopes and recipe graph metadata", () => {
    const digest = computeDigest("coverage", "coverage:recipe", 1, "coverage:payload", 1, { value: "ok" });
    const envelope = digestEnvelope("coverage", "coverage:recipe", 1, "coverage:payload", 1, { value: "ok" });
    expect(digestBytes(new Uint8Array([1, 2]))).toMatch(/^sha256:/);
    expect(digestPayloadBytes({ value: "ok" })).toEqual(expect.any(Uint8Array));
    expect(digestToBytes(digest)).toHaveLength(32);
    expect(decodeDigest(encodeDigest(digest))).toBe(digest);
    expect(envelope[0]).toBe("urdira");
    expect(validateDigestRecipeGraph([])).toEqual({ recipes: [] });
    verifyDigest(digest, digest, "coverage:recipe", 1);
    expect(() => digestEnvelope("coverage", "coverage:recipe", 0, "coverage:payload", 1, {})).toThrow();
    expect(() => digestEnvelope("coverage", "coverage:recipe", 1, "coverage:payload", 1, {}, { canonical_encoding_version: 2 })).toThrow();
    expect(() => decodeDigest(new Uint8Array([0]))).toThrow();
    expect(() => digestToBytes("invalid")).toThrow();
    expect(() => verifyDigest("a", "b")).toThrow();
    const recipe = digestRecipeDefinitions[0]!;
    expect(() => computeDigestRecipe({ ...recipe, payload_binding: "unsupported" } as never, { target: {} } as never)).toThrow();
    expect(() => computeDigestRecipe({ ...recipe, recipe_version: 2 } as never, { target: {} } as never)).toThrow();
    expect(() => computeDigestRecipe({ ...recipe, digest_domain: "unknown" } as never, { target: {} } as never)).toThrow();
    expect(() => computeDigestRecipe({ ...recipe, payload_schema_id: "unknown" } as never, { target: {} } as never)).toThrow();
  });

  it("covers canonical encoding limits and rejected wire forms", () => {
    expect(encodeFloat64(Math.PI)).toHaveLength(9);
    expect(encodeFloat64(Math.fround(1.1))).toHaveLength(5);
    expect(() => encodeCanonical("x", { max_bytes: 0 })).toThrow();
    expect(() => encodeCanonical(Symbol("unsupported"))).toThrow();
    expect(() => encodeCanonical(new Date())).toThrow();
    expect(() => encodeCanonical(Number.NaN)).toThrow();
    expect(() => encodeCanonical("x", { max_text_code_points: 0 })).toThrow();
    expect(() => encodeCanonical([1], { max_elements: 0 })).toThrow();
    expect(() => encodeCanonical([[[1]]], { max_depth: 1 })).toThrow();
    expect(() => encodeCanonical(new Uint8Array([1]), { max_bytes: 0 })).toThrow();
    expect(() => decodeCanonical(new Uint8Array([0x63, 0xff, 0xff, 0xff]))).toThrow();
    expect(() => decodeCanonical(new Uint8Array([0x18, 0x01]))).toThrow();
    expect(() => decodeCanonical(new Uint8Array([0x9f]))).toThrow();
    expect(() => decodeCanonical(new Uint8Array([0xc1, 0x00]))).toThrow();
    expect(() => decodeCanonical(new Uint8Array([0xc2, 0x01]))).toThrow();
    expect(() => decodeCanonical(new Uint8Array([0xf7]))).toThrow();
    expect(() => decodeCanonical(new Uint8Array([0x82, 0x01]))).toThrow();
  });

  it("validates a local schema through the public canonical boundary", () => {
    const schema = { schema_id: "coverage:Text", definition_revision: 1, schema_version: 1, description: "coverage", root_type: { type_kind: "text" as const }, type_definitions: [], lifecycle_state: "active" as const };
    expect(encodeSchemaValue("ok", schema, { schemas: [schema] })).toEqual(expect.any(Uint8Array));
    expect(() => encodeSchemaValue(42, schema, { schemas: [schema] })).toThrow();
  });
});
