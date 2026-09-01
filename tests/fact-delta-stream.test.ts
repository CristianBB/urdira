import { afterEach, describe, expect, it } from "vitest";

import type { FactDelta, ProposedRecord, ProposedRecordDependency } from "@urdira/contracts";
import { generateJsonSchema, factDeltaStreamBatchSchemaV2 } from "@urdira/contracts";
import { canonicalBytes, digestBytes } from "@urdira/canonical";
import {
  FACT_DELTA_STREAM_MAX_BYTES,
  FACT_DELTA_STREAM_MAX_ROWS,
  FactDeltaStreamValidator,
  acceptSealedFactDeltaStreamBatch,
  adaptFactDeltaV1ToStream,
  buildFactDeltaStreamBatch,
  buildSealedFactDeltaStreamBatch,
  canonicalJson,
  canonicalSha256,
  configureStructuralKernelPort,
  factDeltaStreamHeaderDigest,
  factDeltaStreamNativeBatch,
  factDeltaStreamSealedRows,
  prepareFactDeltaStreamStructuralGroup,
  validateFactDeltaStreamBatch,
} from "@urdira/plugin-sdk";
import { FactDeltaStreamAcceptanceService } from "../packages/engine/src/fact-delta.js";

const digest = (value: unknown): string => canonicalSha256(value);

afterEach(() => configureStructuralKernelPort(undefined));

function record(key: string, body: unknown = { name: key }): ProposedRecord {
  return {
    proposal_record_key: key,
    category: "entity",
    kind: "test:symbol",
    universal_kind: "core:symbol",
    facets: "[]",
    schema_version: 1,
    source_span: "",
    identity_key: `identity:${key}`,
    body: body as never,
    evidence_references: "[]",
  };
}

function dependency(key: string): ProposedRecordDependency {
  return {
    proposed_dependency_id: `dependency:${key}`,
    proposal_record_key: key,
    dependency_artifact_id: "artifact:dependency",
    dependency_artifact_version_id: "version:dependency",
    dependency_role: "test:imports",
    dependency_basis: "direct_input",
    source_reference: { reference_type: "local_proposal", proposal_record_key: key },
  };
}

function delta(overrides: Partial<FactDelta> = {}): FactDelta {
  const base: FactDelta = {
    fact_delta_id: "delta:stream",
    candidate_generation_id: "candidate:stream",
    workspace_id: "workspace:stream",
    base_snapshot_id: "snapshot:base",
    work_item_id: "work:stream",
    plugin_id: "plugin:test",
    plugin_version: "1.0.0",
    analysis_digest: digest("analysis"),
    analysis_configuration_digest: digest("configuration"),
    owner_artifact_id: "artifact:owner",
    owner_artifact_version_id: "version:owner",
    replacement_scopes: [{
      replacement_scope_id: "scope:stream",
      owner_artifact_id: "artifact:owner",
      owner_artifact_version_id: "version:owner",
      capability: "core:symbol_declarations",
      record_categories: ["entity"],
      record_kinds: ["test:symbol"],
      base_record_set_digest: digest([]),
      output_completeness: "complete",
    }],
    input_artifact_version_ids: ["version:dependency"],
    input_record_ids: [],
    plugin_input_access_manifest_id: "manifest:stream",
    plugin_input_access_manifest_digest: digest("manifest"),
    analysis_input_digest: digest("input"),
    proposed_records: [record("record:one"), record("record:two")],
    proposed_dependencies: [dependency("record:one")],
    completeness_claims: [{
      completeness_claim_id: "completeness:stream",
      capability: "core:symbol_declarations",
      replacement_scope_ids: "[\"scope:stream\"]",
      status: "complete",
      reason_codes: "[]",
      affected_artifact_ids: "[]",
      diagnostic_proposal_keys: "[]",
    }],
    created_at: "2026-08-27T00:00:00.000Z",
    delta_digest: "",
  };
  const value = { ...base, ...overrides };
  const { fact_delta_id: _id, created_at: _created, delta_digest: _digest, ...payload } = value;
  return { ...value, delta_digest: digest(payload) };
}

async function materialize(input: ReturnType<typeof adaptFactDeltaV1ToStream>) {
  const batches = [];
  for await (const batch of input.batches) batches.push(batch);
  return { header: input.header, batches };
}

function resealHeader(header: ReturnType<typeof adaptFactDeltaV1ToStream>["header"], changes: Partial<typeof header>) {
  const changed = { ...header, ...changes };
  const { stream_digest: _streamDigest, ...payload } = changed;
  return { ...payload, stream_digest: factDeltaStreamHeaderDigest(payload) };
}

describe("FactDeltaStream@2", () => {
  it("keeps grouped canonical rows opaque until an independent Rust acceptance pass", async () => {
    const adapted = await materialize(adaptFactDeltaV1ToStream(delta(), { cancellation_id: "cancel:sealed" }));
    const ordinary = adapted.batches[0]!;
    const { records, dependencies, ...metadata } = ordinary;
    const canonicalRecords = records.map(canonicalJson);
    const canonicalDependencies = dependencies.map(canonicalJson);
    const sealedBatch = () => buildSealedFactDeltaStreamBatch(metadata, {
      canonical_records: canonicalRecords,
      canonical_dependencies: canonicalDependencies,
    });
    const sealed = sealedBatch();

    expect(sealed.records).toEqual([]);
    expect(sealed.dependencies).toEqual([]);
    expect(factDeltaStreamSealedRows(sealed)).toEqual({
      canonical_records: canonicalRecords,
      canonical_dependencies: canonicalDependencies,
    });
    expect(() => factDeltaStreamNativeBatch(sealed)).toThrow(/core acceptance/iu);

    const validator = new FactDeltaStreamValidator(adapted.header);
    validator.accept_batch(sealed);
    expect(validator.finish()).toMatchObject({ record_count: records.length, dependency_count: dependencies.length });

    expect(() => buildSealedFactDeltaStreamBatch({ ...metadata, record_count: metadata.record_count + 1 }, {
      canonical_records: canonicalRecords,
      canonical_dependencies: canonicalDependencies,
    })).toThrow(/counts|bounds/iu);
    expect(() => buildSealedFactDeltaStreamBatch({ ...metadata, chunk_digest: digest("wrong") }, {
      canonical_records: canonicalRecords,
      canonical_dependencies: canonicalDependencies,
    })).toThrow(/digest/iu);

    configureStructuralKernelPort({ structuralKernelBatch() {
      throw new Error("ordinary path is not used");
    } });
    expect(() => acceptSealedFactDeltaStreamBatch(sealed, [])).toThrow(/verified core-owned Rust binding/iu);

    configureStructuralKernelPort({
      structuralKernelBatch() { throw new Error("ordinary path is not used"); },
      structuralKernelCanonicalBatch() { throw new Error("rejected by Rust"); },
    });
    expect(() => acceptSealedFactDeltaStreamBatch(sealedBatch(), [])).toThrow(/kernel rejected/iu);

    configureStructuralKernelPort({
      structuralKernelBatch() { throw new Error("ordinary path is not used"); },
      structuralKernelCanonicalBatch(batch) {
        const acceptedRecords = batch.canonical_records.map((value) => JSON.parse(value) as ProposedRecord);
        const acceptedDependencies = batch.canonical_dependencies.map((value) => JSON.parse(value) as ProposedRecordDependency);
        const recordDigests = acceptedRecords.map((value) => digestBytes(canonicalBytes(value)));
        const kernel = {
          canonical_records: batch.canonical_records,
          canonical_dependencies: batch.canonical_dependencies,
          record_facets: acceptedRecords.map(() => [] as string[]),
          record_structural_attestations: acceptedRecords.map(() => true),
          record_digests: recordDigests,
          record_ids: recordDigests.map((value) => `record:${value.slice("sha256:".length)}`),
          publication_records: acceptedRecords.map((value, index) => ({
            record_id: `record:${recordDigests[index]!.slice("sha256:".length)}`,
            record_digest: recordDigests[index]!,
            body_digest: digestBytes(canonicalBytes(value.body)),
            body_byte_length: canonicalBytes(value.body).byteLength,
            schema_version: value.schema_version,
            facets: [],
            primary_source_span: null,
            identity_type: "entity",
            identity_key: value.identity_key,
            identity_id: `entity:${"0".repeat(64)}`,
            identity_key_digest: digestBytes(canonicalBytes(value.identity_key)),
            identity_assignment_id: digestBytes(canonicalBytes({ record_id: recordDigests[index], identity_key: value.identity_key })),
          })),
          record_body_payload_hexes: acceptedRecords.map((value) => Buffer.from(canonicalBytes(value.body)).toString("hex")),
          publication_descriptor: {
            record_count: acceptedRecords.length,
            body_byte_length: acceptedRecords.reduce((total, value) => total + canonicalBytes(value.body).byteLength, 0),
            first_record_id: acceptedRecords.length === 0 ? null : `record:${recordDigests[0]!.slice("sha256:".length)}`,
            last_record_id: acceptedRecords.length === 0 ? null : `record:${recordDigests.at(-1)!.slice("sha256:".length)}`,
            sequence_digest: canonicalSha256(recordDigests),
          },
          records_digest: canonicalSha256(acceptedRecords),
          dependencies_digest: canonicalSha256(acceptedDependencies),
          canonical_byte_length: [...batch.canonical_records, ...batch.canonical_dependencies].reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0),
        };
        return {
          kernel,
          records: acceptedRecords.map((value) => ({
            proposal_record_key: value.proposal_record_key,
            category: value.category,
            kind: value.kind,
            universal_kind: value.universal_kind,
            schema_version: value.schema_version,
            identity_key: value.identity_key,
          })),
          dependencies: acceptedDependencies,
          record_schema_attestations: acceptedRecords.map(() => true),
        };
      },
    });
    const accepted = acceptSealedFactDeltaStreamBatch(sealed, []);
    expect(accepted?.record_schema_attestations).toEqual(records.map(() => true));
    expect(acceptSealedFactDeltaStreamBatch(sealed, [])).toBe(accepted);
    expect(factDeltaStreamNativeBatch(sealed).records.row_count).toBe(records.length);
    expect(factDeltaStreamNativeBatch(sealed).dependencies.row_count).toBe(dependencies.length);
    expect(acceptSealedFactDeltaStreamBatch(ordinary, [])).toBeUndefined();

    configureStructuralKernelPort({
      structuralKernelBatch() { throw new Error("ordinary path is not used"); },
      structuralKernelCanonicalBatch() {
        return { ...accepted!, records: [] };
      },
    });
    expect(() => acceptSealedFactDeltaStreamBatch(sealedBatch(), [])).toThrow(/inconsistent sealed result/iu);
  });

  it("uses the structural kernel bytes without changing canonical stream results", async () => {
    const remoteBatch = buildFactDeltaStreamBatch({ fact_delta_id: "delta:remote-kernel", sequence: 0, final: true, records: [record("record:remote")], dependencies: [] });
    const nearLimitRemoteBatch = buildFactDeltaStreamBatch({ fact_delta_id: "delta:remote-kernel-near-limit", sequence: 0, final: true, records: [record("record:remote-near-limit", { payload: "x".repeat(1_500_000) })], dependencies: [] });
    let calls = 0;
    configureStructuralKernelPort({
      structuralKernelBatch(batch) {
        calls += 1;
        const canonical_records = batch.records.map(canonicalJson);
        const canonical_dependencies = batch.dependencies.map(canonicalJson);
        const record_digests = batch.records.map((record) => digestBytes(canonicalBytes(record)));
        return {
          canonical_records,
          canonical_dependencies,
          record_facets: batch.records.map((record) => JSON.parse(record.facets) as string[]),
          record_structural_attestations: batch.records.map(() => true),
          record_digests,
          record_ids: record_digests.map((value) => `record:${value.slice("sha256:".length)}`),
          publication_records: batch.records.map((record, index) => ({
            record_id: `record:${record_digests[index]!.slice("sha256:".length)}`,
            record_digest: record_digests[index]!, body_digest: digestBytes(canonicalBytes(record.body)), body_byte_length: canonicalBytes(record.body).byteLength, schema_version: record.schema_version,
            facets: JSON.parse(record.facets) as string[], primary_source_span: null, identity_type: record.category === "relation" ? "relation" : record.category === "diagnostic" ? "diagnostic" : "entity",
            identity_key: record.identity_key, identity_id: `entity:${"0".repeat(64)}`, identity_key_digest: digestBytes(canonicalBytes(record.identity_key)), identity_assignment_id: digestBytes(canonicalBytes({ record_id: `record:${record_digests[index]!.slice("sha256:".length)}`, identity_key: record.identity_key })),
          })),
          record_body_payload_hexes: batch.records.map((record) => Buffer.from(canonicalBytes(record.body)).toString("hex")),
          publication_descriptor: { record_count: batch.records.length, body_byte_length: batch.records.reduce((total, record) => total + canonicalBytes(record.body).byteLength, 0), first_record_id: batch.records.length === 0 ? null : `record:${record_digests[0]!.slice("sha256:".length)}`, last_record_id: batch.records.length === 0 ? null : `record:${record_digests.at(-1)!.slice("sha256:".length)}`, sequence_digest: canonicalSha256(record_digests) },
          records_digest: canonicalSha256(batch.records),
          dependencies_digest: canonicalSha256(batch.dependencies),
          canonical_byte_length: [...canonical_records, ...canonical_dependencies].reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0),
        };
      },
    });
    const receivedRemoteBatch = validateFactDeltaStreamBatch(structuredClone(remoteBatch));
    expect(factDeltaStreamNativeBatch(receivedRemoteBatch).records.strings.row_offsets[1]! - factDeltaStreamNativeBatch(receivedRemoteBatch).records.strings.row_offsets[0]!).toBe(8);
    const receivedNearLimitBatch = validateFactDeltaStreamBatch(structuredClone(nearLimitRemoteBatch));
    expect(factDeltaStreamNativeBatch(receivedNearLimitBatch).records.strings.row_offsets[1]! - factDeltaStreamNativeBatch(receivedNearLimitBatch).records.strings.row_offsets[0]!).toBe(6);
    const adapted = await materialize(adaptFactDeltaV1ToStream(delta(), { cancellation_id: "cancel:native-kernel", max_rows: 2 }));
    const validator = new FactDeltaStreamValidator(adapted.header);
    for (const batch of adapted.batches) validator.accept_batch(batch);
    expect(validator.finish()).toMatchObject({ record_count: 2, dependency_count: 1 });
    const native = adapted.batches.map((batch) => factDeltaStreamNativeBatch(batch));
    expect(native.reduce((total, batch) => total + batch.records.row_count, 0)).toBe(2);
    expect(native.reduce((total, batch) => total + batch.dependencies.row_count, 0)).toBe(1);
    expect(native.every((batch) => batch.graph_edges.row_count === 0)).toBe(true);
    expect(native.every((batch) => batch.identities.row_count === 0)).toBe(true);
    expect(native.flatMap((batch) => batch.records.row_count === 0 ? [] : [batch.records.strings.row_offsets[1]! - batch.records.strings.row_offsets[0]!]).every((width) => width === 8)).toBe(true);
    expect(calls).toBeGreaterThan(0);

    const beforeSingleSeal = calls;
    const singleSeal = buildFactDeltaStreamBatch({ fact_delta_id: "delta:single-native-pass", sequence: 0, final: true, records: [record("record:single-native-pass")], dependencies: [] });
    factDeltaStreamNativeBatch(singleSeal);
    validateFactDeltaStreamBatch(singleSeal);
    expect(calls - beforeSingleSeal).toBe(1);

    const groupedRecords = [record("record:group-a"), record("record:group-b")];
    const beforeGroupSeal = calls;
    expect(prepareFactDeltaStreamStructuralGroup([
      { records: [groupedRecords[0]!], dependencies: [] },
      { records: [groupedRecords[1]!], dependencies: [] },
    ])).toBe(true);
    expect(calls - beforeGroupSeal).toBe(1);
    buildFactDeltaStreamBatch({ fact_delta_id: "delta:group-a", sequence: 0, final: true, records: [groupedRecords[0]!], dependencies: [] });
    buildFactDeltaStreamBatch({ fact_delta_id: "delta:group-b", sequence: 0, final: true, records: [groupedRecords[1]!], dependencies: [] });
    expect(calls - beforeGroupSeal).toBe(1);

    configureStructuralKernelPort({ structuralKernelBatch() {
      return { canonical_records: [], canonical_dependencies: [], record_facets: [], record_structural_attestations: [], record_digests: [], record_ids: [], publication_records: [], record_body_payload_hexes: [], publication_descriptor: { record_count: 0, body_byte_length: 0, first_record_id: null, last_record_id: null, sequence_digest: digest([]) }, records_digest: digest([]), dependencies_digest: digest([]), canonical_byte_length: 0 };
    } });
    const corruptRecord = record("record:corrupt-group");
    expect(prepareFactDeltaStreamStructuralGroup([{ records: [corruptRecord], dependencies: [] }])).toBe(false);
    expect(() => buildFactDeltaStreamBatch({ fact_delta_id: "delta:corrupt-kernel", sequence: 0, final: true, records: [corruptRecord], dependencies: [] }))
      .toThrow(/structural kernel returned an invalid result/iu);
    expect(() => prepareFactDeltaStreamStructuralGroup(Array.from({ length: 65 }, () => ({ records: [], dependencies: [] })))).toThrow(/64 owners/iu);
  });

  it("adapts FactDelta@1 without losing rows and validates the ordered final stream", async () => {
    const adapted = await materialize(adaptFactDeltaV1ToStream(delta(), {
      cancellation_id: "cancel:stream",
      max_in_flight_batches: 1,
      max_rows: 1,
    }));
    const validator = new FactDeltaStreamValidator(adapted.header);
    for (const batch of adapted.batches) validator.accept_batch(batch);
    expect(validator.finish()).toMatchObject({ batch_count: 3, record_count: 2, dependency_count: 1 });
    expect(adapted.batches.at(-1)?.final).toBe(true);
    expect(adapted.batches.flatMap((batch) => batch.records)).toEqual(delta().proposed_records);
    expect(adapted.batches.flatMap((batch) => batch.dependencies)).toEqual(delta().proposed_dependencies);
  });

  it("rejects duplicates, out-of-order chunks, chunks after final, and missing final chunks", async () => {
    const { header, batches } = await materialize(adaptFactDeltaV1ToStream(delta(), { cancellation_id: "cancel:order", max_rows: 1 }));
    expect(() => new FactDeltaStreamValidator({ ...header, unknown_field: true })).toThrow(/structurally invalid/i);
    const duplicate = new FactDeltaStreamValidator(header);
    duplicate.accept_batch(batches[0]!);
    expect(() => duplicate.accept_batch(batches[0]!)).toThrow(/sequence|duplicate|order/i);

    const outOfOrder = new FactDeltaStreamValidator(header);
    expect(() => outOfOrder.accept_batch(batches[1]!)).toThrow(/sequence|order/i);

    const afterFinal = new FactDeltaStreamValidator(header);
    for (const batch of batches) afterFinal.accept_batch(batch);
    expect(() => afterFinal.accept_batch({ ...batches.at(-1)!, sequence: batches.length })).toThrow(/final|closed/i);

    const missingFinal = new FactDeltaStreamValidator(header);
    missingFinal.accept_batch({ ...batches[0]!, final: false });
    expect(() => missingFinal.finish()).toThrow(/final/i);
  });

  it("rejects oversized batches, invalid chunk digests, and aggregate count or digest mismatches", async () => {
    expect(generateJsonSchema(factDeltaStreamBatchSchemaV2)).toMatchObject({
      additionalProperties: false,
      properties: { rowCount: { maximum: FACT_DELTA_STREAM_MAX_ROWS }, byteLength: { maximum: FACT_DELTA_STREAM_MAX_BYTES } },
    });
    expect(() => buildFactDeltaStreamBatch({
      fact_delta_id: "delta:oversized-rows",
      sequence: 0,
      final: true,
      records: Array.from({ length: FACT_DELTA_STREAM_MAX_ROWS + 1 }, (_, index) => record(`record:${String(index)}`)),
      dependencies: [],
    })).toThrow(/rows/i);
    expect(() => buildFactDeltaStreamBatch({
      fact_delta_id: "delta:oversized-bytes",
      sequence: 0,
      final: true,
      records: [record("record:large", { text: "x".repeat(FACT_DELTA_STREAM_MAX_BYTES) })],
      dependencies: [],
    })).toThrow(/bytes/i);

    const { header, batches } = await materialize(adaptFactDeltaV1ToStream(delta(), { cancellation_id: "cancel:digest" }));
    const badChunk = new FactDeltaStreamValidator(header);
    expect(() => badChunk.accept_batch({ ...batches[0]!, chunk_digest: digest("wrong") })).toThrow(/digest/i);

    const badCount = new FactDeltaStreamValidator(resealHeader(header, { proposed_record_count: header.proposed_record_count + 1 }));
    for (const batch of batches) badCount.accept_batch(batch);
    expect(() => badCount.finish()).toThrow(/count/i);

    const badDigest = new FactDeltaStreamValidator(resealHeader(header, { proposed_records_digest: digest("wrong") }));
    for (const batch of batches) badDigest.accept_batch(batch);
    expect(() => badDigest.finish()).toThrow(/digest/i);
  });

  it("awaits each staging acknowledgement and propagates cancellation without completing", async () => {
    const stream = adaptFactDeltaV1ToStream(delta({ proposed_records: [record("record:one"), record("record:two")] }), {
      cancellation_id: "cancel:backpressure",
      max_rows: 1,
    });
    let inFlight = 0;
    let maxInFlight = 0;
    let completed = 0;
    const service = new FactDeltaStreamAcceptanceService({
      async stageFactDeltaStreamBatch(_header, _batch, _nativeBatch) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return "inserted";
      },
      async completeFactDeltaStream() { completed += 1; return "inserted"; },
    });
    await expect(service.accept(stream)).resolves.toMatchObject({ record_count: 2, dependency_count: 1 });
    expect(maxInFlight).toBe(1);
    expect(completed).toBe(1);

    const controller = new AbortController();
    controller.abort("cancelled by test");
    await expect(service.accept(adaptFactDeltaV1ToStream(delta(), { cancellation_id: "cancel:aborted" }), { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(completed).toBe(1);
  });
});
