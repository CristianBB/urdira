import { describe, expect, it } from "vitest";
import { computeDigest, computeDigestOverArrayPayload, computeDigestOverMapPayloadWithArrayField, decodeCanonical, encodeCanonical } from "@urdira/canonical";

/**
 * Regression coverage for the phase-1 hotspot fixes: the canonical text
 * encoder must count code points without materializing a per-code-point
 * array (the previous `[...value].length` was the literal "Invalid array
 * length" crash on multi-hundred-MB aggregates), and large collections must
 * encode without spread-as-arguments call-stack overflows.
 */
describe("phase 1 hotspot fixes", () => {
  it("counts astral-plane code points exactly for the text limit", () => {
    // Three astral code points = six UTF-16 code units.
    const threeEmoji = "\u{1F600}\u{1F601}\u{1F602}";
    expect(() => encodeCanonical(threeEmoji, { max_text_code_points: 3 })).not.toThrow();
    expect(() => encodeCanonical(`${threeEmoji}\u{1F603}`, { max_text_code_points: 3 }))
      .toThrowError(expect.objectContaining({ code: "uce:resource_limit_exceeded" }));
    // Mixed BMP + astral: "a" + emoji + "b" is three code points.
    expect(() => encodeCanonical("a\u{1F600}b", { max_text_code_points: 3 })).not.toThrow();
    expect(() => encodeCanonical("a\u{1F600}bc", { max_text_code_points: 3 }))
      .toThrowError(expect.objectContaining({ code: "uce:resource_limit_exceeded" }));
  });

  it("enforces the decode-side code point limit for astral text", () => {
    const bytes = encodeCanonical("\u{1F600}\u{1F601}");
    expect(decodeCanonical(bytes, { max_text_code_points: 2 })).toBe("\u{1F600}\u{1F601}");
    expect(() => decodeCanonical(bytes, { max_text_code_points: 1 }))
      .toThrowError(expect.objectContaining({ code: "uce:resource_limit_exceeded" }));
  });

  it("encodes and round-trips a 200k-element array without a call-stack overflow", () => {
    const values = Array.from({ length: 200_000 }, (_, index) => index % 251);
    const bytes = encodeCanonical(values);
    expect(decodeCanonical(bytes)).toEqual(values);
  });

  it("encodes and round-trips a map with 150k entries without a call-stack overflow", () => {
    const record: Record<string, number> = {};
    for (let index = 0; index < 150_000; index += 1) record[`k${index}`] = index % 97;
    const bytes = encodeCanonical(record, { max_elements: 400_000 });
    expect(decodeCanonical(bytes, { max_elements: 400_000 })).toEqual(record);
  });

  it("keeps encoder output byte-identical across surrogate, multibyte, and nested fixtures", () => {
    const fixtures: unknown[] = [
      { z: 1, a: [true, "hello"], empty: null },
      "café ñandú 你好 \u{1F680}",
      ["\u{10000}", { nested: ["߿ࠀ", 3.5, -12, -(2n ** 70n)] }],
      { text: "line\nbreak\tand \"quotes\" and \\ backslash" },
    ];
    for (const fixture of fixtures) {
      const bytes = encodeCanonical(fixture);
      expect(decodeCanonical(bytes)).toEqual(fixture);
    }
    // Pinned hex vector shared with the canonical suite: proves the concat and
    // code-point-count rewrites changed no output byte.
    expect(Buffer.from(encodeCanonical({ z: 1, a: [true, "hello"], empty: null })).toString("hex"))
      .toBe("a3616182f56568656c6c6f617a0165656d707479f6");
  });

  it("computes computeDigestOverArrayPayload byte-identically to computeDigest for array payloads", () => {
    const payloads: ReadonlyArray<readonly unknown[]> = [
      [],
      [{ record_id: "record:a", record_digest: "sha256:b" }],
      Array.from({ length: 2_000 }, (_, index) => ({ record_id: `record:${index}`, record_digest: `sha256:${index}`, nested: ["café", index, { deep: true }] })),
    ];
    for (const payload of payloads) {
      expect(computeDigestOverArrayPayload("core:canonical_record_set", "core:snapshot_record_set_digest", 1, "core:SnapshotRecordSetDigestPayload", 1, payload))
        .toBe(computeDigest("core:canonical_record_set", "core:snapshot_record_set_digest", 1, "core:SnapshotRecordSetDigestPayload", 1, payload));
    }
  });

  it("computes computeDigestOverMapPayloadWithArrayField byte-identically to computeDigest for map payloads", () => {
    const cases: ReadonlyArray<{ scalars: Record<string, unknown>; field: string; entries: readonly unknown[] }> = [
      { scalars: { projection_kind: "lexical", generator: "core:lexical", generator_version: "1", generator_configuration_digest: "sha256:x" }, field: "entries", entries: [] },
      { scalars: { a: 1, zzz: "café" }, field: "entries", entries: Array.from({ length: 1_500 }, (_, index) => ({ id: `p:${index}`, payload: { nested: [index, "✓"] } })) },
      { scalars: { entry_like: "sorts after entries?" }, field: "aaa_first", entries: [1, 2, 3] },
    ];
    for (const { scalars, field, entries } of cases) {
      expect(computeDigestOverMapPayloadWithArrayField("core:projection_set", "core:projection_set_digest", 1, "core:ProjectionSetDigestPayload", 1, scalars, field, entries))
        .toBe(computeDigest("core:projection_set", "core:projection_set_digest", 1, "core:ProjectionSetDigestPayload", 1, { ...scalars, [field]: entries }));
    }
  });
});
