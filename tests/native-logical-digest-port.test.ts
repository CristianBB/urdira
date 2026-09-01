import { describe, expect, it } from "vitest";
import { createNativeLogicalDigestPort, NATIVE_API_VERSION } from "../packages/native/src/index.js";
import type { LogicalValueRecord, LogicalValueVerification, NativeBinding } from "../packages/native/src/types.js";

describe("native logical digest publication adapter", () => {
  it("converts call-owned JavaScript values to bounded logical values without retaining them", () => {
    let digests: readonly LogicalValueRecord[] = [];
    let verifications: readonly LogicalValueVerification[] = [];
    const binding: NativeBinding = {
      nativeApiVersion: () => NATIVE_API_VERSION,
      nativeTargetTriple: () => "aarch64-apple-darwin",
      logicalDigestBatch: () => [],
      verifyLogicalRecordBatch: () => [],
      logicalValueDigestBatch: (records) => { digests = records; return records.map(() => ({ digest: `sha256:${"1".repeat(64)}`, byte_length: 7 })); },
      verifyLogicalValueBatch: (records) => { verifications = records; return records.map(() => ({ valid: true, actual_digest: `sha256:${"2".repeat(64)}`, byte_length: 9 })); },
      structuralKernelBatch: () => ({ canonical_records: [], canonical_dependencies: [], record_facets: [], record_structural_attestations: [], record_digests: [], record_ids: [], publication_records: [], record_body_payload_hexes: [], publication_descriptor: { record_count: 0, body_byte_length: 0, first_record_id: null, last_record_id: null, sequence_digest: `sha256:${"0".repeat(64)}` }, records_digest: `sha256:${"0".repeat(64)}`, dependencies_digest: `sha256:${"0".repeat(64)}`, canonical_byte_length: 0 }),
      structuralKernelCanonicalBatch: () => ({ kernel: { canonical_records: [], canonical_dependencies: [], record_facets: [], record_structural_attestations: [], record_digests: [], record_ids: [], publication_records: [], record_body_payload_hexes: [], publication_descriptor: { record_count: 0, body_byte_length: 0, first_record_id: null, last_record_id: null, sequence_digest: `sha256:${"0".repeat(64)}` }, records_digest: `sha256:${"0".repeat(64)}`, dependencies_digest: `sha256:${"0".repeat(64)}`, canonical_byte_length: 0 }, records: [], dependencies: [], record_schema_attestations: [] }),
      structuralObservationBatch: () => ({ owners: [] }),
      exactVectorTopKBatch: () => [],
    };
    const port = createNativeLogicalDigestPort(binding);
    const source = { b: [true, Uint8Array.from([0, 255])], absent: undefined, a: 7 };
    expect(port.logicalValueDigestBatch([{ domain: "domain", value: source }])).toEqual([{ digest: `sha256:${"1".repeat(64)}`, byte_length: 7 }]);
    expect(port.verifyLogicalValueBatch([{ domain: "domain", value: source, expected_digest: `sha256:${"0".repeat(64)}` }])).toEqual([{ valid: true, actual_digest: `sha256:${"2".repeat(64)}`, byte_length: 9 }]);
    expect(digests).toEqual([{ domain: "domain", value: { type: "record", fields: [
      { identifier: "a", present: true, value: { type: "integer", value: "7" } },
      { identifier: "absent", present: false },
      { identifier: "b", present: true, value: { type: "sequence", values: [{ type: "boolean", value: true }, { type: "bytes", value: [0, 255] }] } },
    ] } }]);
    expect(verifications[0]).toEqual({ ...digests[0], expected_digest: `sha256:${"0".repeat(64)}` });
    source.b[0] = false;
    expect(digests[0]).not.toBe(source);
    expect((digests[0]?.value as { readonly fields: readonly unknown[] }).fields).not.toBe(source);
  });

  it("rejects unsupported values before crossing N-API", () => {
    let called = false;
    const binding = {
      logicalValueDigestBatch: () => { called = true; return []; },
      verifyLogicalValueBatch: () => { called = true; return []; },
    } as unknown as NativeBinding;
    const port = createNativeLogicalDigestPort(binding);
    expect(() => port.logicalValueDigestBatch([{ domain: "domain", value: Symbol("unsupported") }])).toThrow(/unsupported logical digest value/iu);
    expect(called).toBe(false);
  });
});
