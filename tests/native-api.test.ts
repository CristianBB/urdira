import { describe, expect, it } from "vitest";
import { canonicalBytes, digestBytes, LogicalDigestWriter } from "../packages/canonical/src/index.js";
import { createNativeLogicalDigestPort, createNativeStructuralKernelPort } from "../packages/native/src/index.js";
import { acceptSealedFactDeltaStreamBatch, buildFactDeltaStreamBatch, buildSealedFactDeltaStreamBatch, canonicalJson, canonicalSha256, configureStructuralKernelPort, FactDeltaStreamValidator, factDeltaStreamCanonicalRow, factDeltaStreamNativeBatch, factDeltaStreamSealedRows, projectStructuralObservationGroup } from "@urdira/plugin-sdk";
import { loadNativeBinding } from "../packages/native/src/loader.js";
import { resolveNativeTarget } from "../packages/native/src/targets.js";
import type { LogicalField, LogicalRecord, LogicalValue, NativeBinding } from "../packages/native/src/types.js";
import { analyzeProject, JAVASCRIPT_TYPESCRIPT_NATIVE_PROJECTION_PROFILE, javascriptTypescriptNativeProjectionOwner, prepareJavascriptTypescriptFactDeltaStream, prepareJavascriptTypescriptProjectedFactDeltaStream, type JavascriptTypescriptFactDeltaInput } from "../packages/plugin-javascript-typescript/src/index.js";

const binaryPath = process.env["URDIRA_NATIVE_TEST_BINARY"];
const nativeDescribe = binaryPath === undefined ? describe.skip : describe;

function writeValue(writer: LogicalDigestWriter, value: LogicalValue): void {
  switch (value.type) {
    case "null": writer.null(); break;
    case "boolean": writer.boolean(value.value); break;
    case "integer": writer.integer(BigInt(value.value)); break;
    case "real": writer.real(value.value); break;
    case "text": writer.text(0, value.value); break;
    case "bytes": writer.bytes(Uint8Array.from(value.value)); break;
    case "sequence":
      writer.sequence(value.values.length);
      for (const entry of value.values) writeValue(writer, entry);
      break;
    case "set":
      writer.set(value.values.length);
      for (const entry of value.values) writeValue(writer, entry);
      break;
    case "record":
      writer.set(value.fields.length);
      for (const field of value.fields) writeField(writer, field);
      break;
  }
}

function writeField(writer: LogicalDigestWriter, field: LogicalField): void {
  writer.field(field.identifier, field.present, () => {
    if (field.value === undefined) throw new Error("Oracle field is missing its value.");
    writeValue(writer, field.value);
  });
}

function oracle(record: LogicalRecord): string {
  const writer = new LogicalDigestWriter(record.domain);
  for (const field of record.fields) writeField(writer, field);
  return writer.digest();
}

function loadBuiltBinding(): NativeBinding {
  const target = resolveNativeTarget();
  return loadNativeBinding({
    ...(binaryPath === undefined ? {} : { artifact_path: binaryPath }),
    platform: target.platform,
    arch: target.arch,
    ...(target.libc === undefined ? {} : { libc: target.libc }),
  });
}

function float64Bytes(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat64(index * 8, value, true));
  return bytes;
}

nativeDescribe("@urdira/native N-API batches", () => {
  it("projects compact JavaScript/TypeScript observations byte-identically to the portable mapper", async () => {
    const native = loadBuiltBinding();
    const files = [
      { path: "src/main.ts", text: "import { value } from './value.js'; export function main(): number { return value; }", artifact_id: "artifact:main", artifact_version_id: "version:main", content_hash: `sha256:${"1".repeat(64)}` },
      { path: "src/value.ts", text: "export const value: number = 1;", artifact_id: "artifact:value", artifact_version_id: "version:value", content_hash: `sha256:${"2".repeat(64)}` },
    ] as const;
    const input: JavascriptTypescriptFactDeltaInput = {
      analysis: analyzeProject({ files, root_names: files.map((file) => file.path) }),
      owner_path: "src/main.ts",
      files,
      work_item: {
        candidate_generation_id: "candidate:native-projection", workspace_id: "workspace:native-projection", artifact_id: "artifact:main",
        target_artifact_version_id: "version:main", work_item_id: "work:main", plugin_id: "urdira:javascript_typescript", plugin_version: "0.4.0",
        expected_replacement_scopes: [{ replacement_scope_id: "scope:main", owner_artifact_id: "artifact:main", owner_artifact_version_id: "version:main", capability: "core:semantic_preparation", record_categories: ["entity", "relation", "diagnostic"], record_kinds: ["jsts:entity_type", "jsts:entity_callable", "jsts:entity_container", "jsts:entity_parameter", "jsts:entity_variable", "jsts:entity_inferred_type", "jsts:relation_contains", "jsts:relation_import", "jsts:relation_export", "jsts:relation_references", "jsts:relation_call", "jsts:relation_implements", "jsts:relation_inherits", "jsts:relation_covers", "jsts:relation_type_of", "jsts:diagnostic"], base_record_set_digest: `sha256:${"0".repeat(64)}`, output_completeness: "accept_reported" }],
      },
      accepted_manifest: { plugin_input_access_manifest_id: "manifest:main", manifest_digest: `sha256:${"3".repeat(64)}`, artifact_version_entries: files.map((file) => ({ artifact_version_id: file.artifact_version_id })), record_entries: [] },
      analysis_digest: `sha256:${"4".repeat(64)}`, analysis_configuration_digest: `sha256:${"5".repeat(64)}`,
      analysis_input_digest: `sha256:${"6".repeat(64)}`, created_at: "2026-08-29T00:00:00.000Z",
    };
    const portable = prepareJavascriptTypescriptFactDeltaStream(input, { cancellation_id: "cancel:native-projection" });
    const projected = native.structuralObservationBatch({ profile_id: JAVASCRIPT_TYPESCRIPT_NATIVE_PROJECTION_PROFILE, batch: { owners: [javascriptTypescriptNativeProjectionOwner(input)] } });
    expect(projected.owners).toHaveLength(1);
    expect(projected.owners[0]!.canonical_records).toEqual(portable.records.map(canonicalJson));
    expect(projected.owners[0]!.canonical_dependencies).toEqual(portable.dependencies.map(canonicalJson));
    expect(projected.owners[0]!.record_headers).toEqual(portable.records.map((record) => ({ proposal_record_key: record.proposal_record_key, category: record.category, kind: record.kind, universal_kind: record.universal_kind, identity_key: record.identity_key })));
    expect(projected.owners[0]!.dependency_headers).toEqual(portable.dependencies.map((dependency) => ({ proposed_dependency_id: dependency.proposed_dependency_id, proposal_record_key: dependency.proposal_record_key, dependency_artifact_id: dependency.dependency_artifact_id, dependency_artifact_version_id: dependency.dependency_artifact_version_id, dependency_role: dependency.dependency_role })));
    configureStructuralKernelPort(createNativeStructuralKernelPort(native));
    try {
      const accepted = projectStructuralObservationGroup(JAVASCRIPT_TYPESCRIPT_NATIVE_PROJECTION_PROFILE, { owners: [javascriptTypescriptNativeProjectionOwner(input)] });
      expect(accepted?.[0]?.canonical_records).toEqual(portable.records.map(factDeltaStreamCanonicalRow));
      expect(accepted?.[0]?.canonical_dependencies).toEqual(portable.dependencies.map(factDeltaStreamCanonicalRow));
      const { analysis: _analysis, ...projectedInput } = input;
      const stream = prepareJavascriptTypescriptProjectedFactDeltaStream({ ...projectedInput, owner_path: input.owner_path!, projection: accepted![0]! }, { cancellation_id: "cancel:native-projected-stream" }).seal();
      const validator = new FactDeltaStreamValidator(stream.header);
      const sealedRecords: string[] = [];
      const sealedDependencies: string[] = [];
      for await (const batch of stream.batches) {
        validator.accept_batch(batch);
        const rows = factDeltaStreamSealedRows(batch)!;
        sealedRecords.push(...rows.canonical_records);
        sealedDependencies.push(...rows.canonical_dependencies);
      }
      expect(validator.finish()).toMatchObject({ record_count: portable.records.length, dependency_count: portable.dependencies.length });
      expect(sealedRecords).toEqual(portable.records.map(canonicalJson));
      expect(sealedDependencies).toEqual(portable.dependencies.map(canonicalJson));
    } finally {
      configureStructuralKernelPort(undefined);
    }
    expect(() => native.structuralObservationBatch({ profile_id: "unknown", batch: { owners: [] } })).toThrow(/unknown profile/iu);
  });

  it("matches the TypeScript structural-row canonical and digest oracle", () => {
    const native = loadBuiltBinding();
    const records = [{
      proposal_record_key: "proposal:é", category: "entity", kind: "jsts:declaration", universal_kind: "core:declaration",
      facets: "[]", schema_version: 1, source_span: "", identity_key: "identity:é",
      body: { z: 1, e: "é", a: ["text"] }, evidence_references: "[]",
    }];
    const dependencies = [{
      proposed_dependency_id: "dependency:é", proposal_record_key: "proposal:é", dependency_artifact_id: "artifact:dependency",
      dependency_artifact_version_id: "artifact-version:dependency", dependency_role: "core:imports", dependency_basis: "proposal",
      source_reference: { reference_type: "local_proposal", proposal_record_key: "proposal:é" },
    }];
    const result = native.structuralKernelBatch({ records, dependencies });
    expect(result.canonical_records).toEqual(records.map(canonicalJson));
    expect(result.canonical_dependencies).toEqual(dependencies.map(canonicalJson));
    expect(result.record_facets).toEqual([[]]);
    expect(result.record_structural_attestations).toEqual([true]);
    expect(result.record_digests).toEqual(records.map((record) => digestBytes(canonicalBytes(record))));
    expect(result.record_ids).toEqual(result.record_digests.map((digest) => `record:${digest.slice("sha256:".length)}`));
    expect(result.publication_records).toEqual([expect.objectContaining({
      record_id: result.record_ids[0],
      record_digest: result.record_digests[0],
      body_digest: new LogicalDigestWriter("urdira:relational-value:v3").value(records[0]!.body).digest(),
      body_byte_length: new LogicalDigestWriter("urdira:relational-value:v3").value(records[0]!.body).byteLength(),
      identity_type: "entity",
      identity_key: "identity:é",
    })]);
    expect(Buffer.from(result.record_body_payload_hexes[0]!, "hex")).toEqual(Buffer.from(canonicalBytes(records[0]!.body)));
    expect(result.publication_descriptor).toMatchObject({
      record_count: 1,
      body_byte_length: new LogicalDigestWriter("urdira:relational-value:v3").value(records[0]!.body).byteLength(),
      first_record_id: result.record_ids[0],
      last_record_id: result.record_ids[0],
    });
    expect(result.records_digest).toBe(canonicalSha256(records));
    expect(result.dependencies_digest).toBe(canonicalSha256(dependencies));
    expect(result.canonical_byte_length).toBe([...result.canonical_records, ...result.canonical_dependencies].reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0));

    const sealed = native.structuralKernelCanonicalBatch({
      canonical_records: result.canonical_records,
      canonical_dependencies: result.canonical_dependencies,
      record_definitions: [{
        kind: "jsts:declaration", category: "entity", universal_kind: "core:declaration", schema_version: 1,
        allowed_facets: [], required_facets: [],
        body_schema: { type: "object", additionalProperties: false, properties: {
          z: { type: "integer", description: "z" }, e: { type: "string", description: "e" },
          a: { type: "array", description: "a", items: { type: "string", description: "item" } },
        }, required: ["z", "e"] },
      }],
    });
    expect(sealed.kernel).toEqual(result);
    expect(sealed.records).toEqual([{ proposal_record_key: "proposal:é", category: "entity", kind: "jsts:declaration", universal_kind: "core:declaration", schema_version: 1, identity_key: "identity:é" }]);
    expect(sealed.record_schema_attestations).toEqual([true]);
    expect(sealed.dependencies).toEqual(dependencies);
    expect(() => native.structuralKernelCanonicalBatch({
      canonical_records: [`{ "proposal_record_key": "proposal:é" }`],
      canonical_dependencies: [],
      record_definitions: [],
    })).toThrow(/canonical|record/iu);

    configureStructuralKernelPort(createNativeStructuralKernelPort(native));
    try {
      const ordinary = buildFactDeltaStreamBatch({ fact_delta_id: "delta:sealed-native", sequence: 0, final: true, records, dependencies });
      const { records: _records, dependencies: _dependencies, ...metadata } = ordinary;
      const opaque = buildSealedFactDeltaStreamBatch(metadata, {
        canonical_records: result.canonical_records,
        canonical_dependencies: result.canonical_dependencies,
      });
      expect(opaque.records).toEqual([]);
      expect(opaque.dependencies).toEqual([]);
      const accepted = acceptSealedFactDeltaStreamBatch(opaque, [{
        kind: "jsts:declaration", category: "entity", universal_kind: "core:declaration", schema_version: 1,
        allowed_facets: [], required_facets: [], body_schema: { type: "object", additionalProperties: false, properties: {
          z: { type: "integer", description: "z" }, e: { type: "string", description: "e" },
          a: { type: "array", description: "a", items: { type: "string", description: "item" } },
        }, required: ["z", "e"] },
      }]);
      expect(accepted?.record_schema_attestations).toEqual([true]);
      expect(factDeltaStreamNativeBatch(opaque).records.row_count).toBe(1);
      expect(factDeltaStreamNativeBatch(opaque).dependencies.row_count).toBe(1);
    } finally {
      configureStructuralKernelPort(undefined);
    }
  });

  it("matches the TypeScript logical-digest.v3 oracle for ordered fields and UTF-8", () => {
    const native = loadBuiltBinding();
    const records: readonly LogicalRecord[] = [
      {
        domain: "urdira:test-record:v3",
        fields: [
          { identifier: "zeta", present: true, value: { type: "text", value: "héllø 世界" } },
          { identifier: "alpha", present: true, value: { type: "integer", value: "42" } },
          { identifier: "bytes", present: true, value: { type: "bytes", value: [0, 127, 128, 255] } },
          {
            identifier: "nested",
            present: true,
            value: {
              type: "record",
              fields: [
                { identifier: "z", present: true, value: { type: "text", value: "last-by-schema" } },
                { identifier: "a", present: true, value: { type: "text", value: "first-by-name" } },
              ],
            },
          },
          { identifier: "optional", present: false },
        ],
      },
      {
        domain: "urdira:nested:v3",
        fields: [{
          identifier: "items",
          present: true,
          value: { type: "sequence", values: [{ type: "boolean", value: true }, { type: "real", value: 1.5 }] },
        }],
      },
    ];
    const results = native.logicalDigestBatch(records);
    expect(results.map((result) => result.digest)).toEqual(records.map(oracle));
    expect(results.every((result) => result.byte_length > 0)).toBe(true);

    const reordered = { ...records[0]!, fields: [...records[0]!.fields].reverse() };
    expect(native.logicalDigestBatch([reordered])[0]!.digest).not.toBe(results[0]!.digest);
  });

  it("verifies digest batches without accepting a mismatch", () => {
    const native = loadBuiltBinding();
    const record: LogicalRecord = {
      domain: "records",
      fields: [{ identifier: "name", present: true, value: { type: "text", value: "alpha" } }],
    };
    const expected = oracle(record);
    const result = native.verifyLogicalRecordBatch([
      { ...record, expected_digest: expected },
      { ...record, expected_digest: `sha256:${"0".repeat(64)}` },
    ]);
    expect(result.map((item) => item.valid)).toEqual([true, false]);
    expect(result[0]!.actual_digest).toBe(expected);
  });

  it("matches the TypeScript value oracle for publication-shaped nested values", () => {
    const native = createNativeLogicalDigestPort(loadBuiltBinding());
    const value = [{ z: "last", a: 42, optional: undefined, nested: [true, { bytes: Uint8Array.from([0, 255]) }] }];
    const expected = new LogicalDigestWriter("urdira:projection-set:v3").value(value).digest();
    const [digested] = native.logicalValueDigestBatch([{ domain: "urdira:projection-set:v3", value }]);
    expect(digested?.digest).toBe(expected);
    expect(native.verifyLogicalValueBatch([{ domain: "urdira:projection-set:v3", value, expected_digest: expected }])[0])
      .toMatchObject({ valid: true, actual_digest: expected });
  });

  it("uses deterministic vector ties and rejects cosine zero vectors", () => {
    const native = loadBuiltBinding();
    const [matches] = native.exactVectorTopKBatch([{
      query: float64Bytes([1, 0]),
      candidates: float64Bytes([1, 0, 1, 0, 0, 1]),
      projectionRecordIds: ["b", "a", "c"],
      dimensions: 2,
      elementType: "float64_le",
      k: 2,
      metric: "cosine",
    }]);
    expect(matches).toEqual([
      { projection_record_id: "a", rank: 1 },
      { projection_record_id: "b", rank: 2 },
    ]);
    expect(() => native.exactVectorTopKBatch([{
      query: float64Bytes([0, 0]),
      candidates: float64Bytes([1, 0]),
      projectionRecordIds: ["a"],
      dimensions: 2,
      elementType: "float64_le",
      k: 1,
      metric: "cosine",
    }])).toThrow(/zero/iu);
  });
});
