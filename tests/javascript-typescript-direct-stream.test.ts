import { describe, expect, it } from "vitest";

import {
  analyzeProject,
  buildJavascriptTypescriptFactDelta,
  buildJavascriptTypescriptFactDeltaStream,
  buildJavascriptTypescriptNativeFactDeltaStream,
  buildJavascriptTypescriptNativeFactDeltaHeader,
  prepareJavascriptTypescriptFactDeltaStream,
  prepareJavascriptTypescriptProjectedFactDeltaStream,
  createJavascriptTypescriptSemanticProcessTransport,
  javascriptTypescriptProposedDependencyId,
  javascriptTypescriptProposalRecordKey,
  type AnalyzerFile,
  type JavascriptTypescriptFactDeltaInput,
} from "../packages/plugin-javascript-typescript/src/index.js";
import { canonicalJson, FACT_DELTA_STREAM_MAX_BYTES, FACT_DELTA_STREAM_MAX_ROWS, FactDeltaStreamValidator, factDeltaStreamSealedRows } from "@urdira/plugin-sdk";

const files: readonly AnalyzerFile[] = [
  { path: "src/main.ts", text: "import { value } from './value.js'; export function main(): number { return value; }" },
  { path: "src/value.ts", text: "export const value: number = 1;" },
];

function input(inputFiles: readonly AnalyzerFile[] = files): JavascriptTypescriptFactDeltaInput {
  const owner = inputFiles[0]!.path;
  return {
    analysis: analyzeProject({ files: inputFiles, root_names: inputFiles.map((file) => file.path) }),
    work_item: {
      candidate_generation_id: "candidate:direct-stream",
      workspace_id: "workspace:direct-stream",
      artifact_id: "artifact:main",
      target_artifact_version_id: "version:main",
      work_item_id: "work:main",
      plugin_id: "urdira:javascript_typescript",
      plugin_version: "0.2.0",
      expected_replacement_scopes: [{
        replacement_scope_id: "scope:main",
        owner_artifact_id: "artifact:main",
        owner_artifact_version_id: "version:main",
        capability: "core:call_relationships",
        record_categories: ["entity", "relation", "diagnostic"],
        record_kinds: [
          "jsts:entity_type", "jsts:entity_callable", "jsts:entity_container", "jsts:entity_parameter", "jsts:entity_variable",
          "jsts:relation_contains", "jsts:relation_import", "jsts:relation_export", "jsts:relation_references", "jsts:relation_call",
          "jsts:relation_implements", "jsts:relation_inherits", "jsts:relation_covers", "jsts:diagnostic",
        ],
        base_record_set_digest: `sha256:${"0".repeat(64)}`,
        output_completeness: "accept_reported",
      }],
    },
    accepted_manifest: {
      plugin_input_access_manifest_id: "manifest:main",
      manifest_digest: `sha256:${"1".repeat(64)}`,
      artifact_version_entries: inputFiles.map((file) => ({ artifact_version_id: `version:${file.path}` })),
      record_entries: [],
    },
    analysis_digest: `sha256:${"2".repeat(64)}`,
    analysis_configuration_digest: `sha256:${"3".repeat(64)}`,
    analysis_input_digest: `sha256:${"4".repeat(64)}`,
    created_at: "2026-08-27T00:00:00.000Z",
    owner_path: owner,
    files: inputFiles.map((file) => ({
      path: file.path,
      artifact_id: `artifact:${file.path}`,
      artifact_version_id: `version:${file.path}`,
      content_hash: `sha256:${"5".repeat(64)}`,
    })),
  };
}

function request() {
  const value = input();
  return {
    protocol_version: "1.0.0",
    request_id: "request:direct-stream",
    request_digest: value.analysis_input_digest,
    call: "analyze_artifact" as const,
    deadline: "2099-01-01T00:00:00.000Z",
    cancellation_id: "cancel:direct-stream",
    payload: {
      files,
      root_names: files.map((file) => file.path),
      owner_path: files[0]!.path,
      work_item: value.work_item,
      accepted_manifest: value.accepted_manifest,
      analysis_digest: value.analysis_digest,
      analysis_configuration_digest: value.analysis_configuration_digest,
      analysis_input_digest: value.analysis_input_digest,
      created_at: value.created_at,
    },
  };
}

async function rows(stream: Awaited<ReturnType<typeof buildJavascriptTypescriptFactDeltaStream>>) {
  const validator = new FactDeltaStreamValidator(stream.header);
  const records = [];
  const dependencies = [];
  for await (const batch of stream.batches) {
    expect(batch.row_count).toBeLessThanOrEqual(FACT_DELTA_STREAM_MAX_ROWS);
    expect(batch.byte_length).toBeLessThanOrEqual(FACT_DELTA_STREAM_MAX_BYTES);
    validator.accept_batch(batch);
    records.push(...batch.records);
    dependencies.push(...batch.dependencies);
  }
  return { records, dependencies, summary: validator.finish() };
}

describe("built-in JavaScript/TypeScript direct FactDeltaStream@2", () => {
  it("keeps dependency proposal identities bounded for long resolved imports", async () => {
    const ownerPath = "packages/@n8n/agents/src/__tests__/integration/custom-message-suspend-resume.test.ts";
    const targetPath = "packages/@n8n/agents/src/__tests__/integration/helpers.ts";
    const longFiles: readonly AnalyzerFile[] = [
      { path: ownerPath, text: `${" ".repeat(63)}import { helper } from './helpers';\nexport const value = helper;` },
      { path: targetPath, text: "export const helper = 1;" },
    ];
    const base = input(longFiles);
    const artifactVersionId = `artifact-version:${"a".repeat(64)}`;
    const goldenRelationId = "jsts:import:packages/@n8n/agents/src/__tests__/integration/custom-message-suspend-resume.test.ts:63:98:jsts:module:packages/@n8n/agents/src/__tests__/integration/custom-message-suspend-resume.test.ts:0:packages/@n8n/agents/src/__tests__/integration/custom-message-suspend-resume.test.ts:jsts:module:packages/@n8n/agents/src/__tests__/integration/helpers.ts:0:packages/@n8n/agents/src/__tests__/integration/helpers.ts";
    expect(javascriptTypescriptProposedDependencyId(goldenRelationId, artifactVersionId)).toBe(
      "jsts:dependency:sha256:c4cb48ff9d4b05bd4f48fe07c66328e84e1e2884d94e4e7852fb157059a97041",
    );
    const goldenRecordIdentity = "jsts:contains:packages/@n8n/ai-utilities/src/__tests__/utils/failed-attempt-handler/n8nDefaultFailedAttemptHandler.test.ts:1089:1103:jsts:module:packages/@n8n/ai-utilities/src/__tests__/utils/failed-attempt-handler/n8nDefaultFailedAttemptHandler.test.ts:0:packages/@n8n/ai-utilities/src/__tests__/utils/failed-attempt-handler/n8nDefaultFailedAttemptHandler.test.ts:jsts:class:packages/@n8n/ai-utilities/src/__tests__/utils/failed-attempt-handler/n8nDefaultFailedAttemptHandler.test.ts:1089:MockAbortError";
    expect(javascriptTypescriptProposalRecordKey(goldenRecordIdentity)).toBe(
      "jsts:record:sha256:738f6e2eded71e09664e8b83a97da348bfe55276f1bdbf215189cc83e14b9d5f",
    );
    const value: JavascriptTypescriptFactDeltaInput = {
      ...base,
      accepted_manifest: {
        ...base.accepted_manifest,
        artifact_version_entries: longFiles.map(() => ({ artifact_version_id: artifactVersionId })),
      },
      files: base.files!.map((file) => ({ ...file, artifact_version_id: artifactVersionId })),
    };

    const expected = buildJavascriptTypescriptFactDelta(value);
    for (const record of expected.proposed_records) {
      expect(record.proposal_record_key).toMatch(/^jsts:record:sha256:[0-9a-f]{64}$/u);
      expect([...record.proposal_record_key].length).toBeLessThanOrEqual(512);
    }
    expect(expected.proposed_dependencies.length).toBeGreaterThan(0);
    for (const dependency of expected.proposed_dependencies) {
      expect(dependency.proposed_dependency_id).toMatch(/^jsts:dependency:sha256:[0-9a-f]{64}$/u);
      expect([...dependency.proposed_dependency_id].length).toBeLessThanOrEqual(512);
    }

    const stream = await buildJavascriptTypescriptFactDeltaStream(value, { cancellation_id: "cancel:long-dependency" });
    const emitted = await rows(stream);
    expect(emitted.dependencies).toEqual(expected.proposed_dependencies);
  });

  it("emits rows directly with exact FactDelta@1 content and digest equivalence", async () => {
    const expected = buildJavascriptTypescriptFactDelta(input());
    const stream = await buildJavascriptTypescriptFactDeltaStream(input(), { cancellation_id: "cancel:direct-stream" });
    const emitted = await rows(stream);
    expect(emitted.records).toEqual(expected.proposed_records);
    expect(emitted.dependencies).toEqual(expected.proposed_dependencies);
    expect(stream.header.delta_digest).toBe(expected.delta_digest);
    expect(emitted.summary).toMatchObject({
      record_count: expected.proposed_records.length,
      dependency_count: expected.proposed_dependencies.length,
    });
  });

  it("accepts Rust-built stage-one rows without reconstructing analyzer entities in TypeScript", async () => {
    const legacyInput = input();
    const expected = buildJavascriptTypescriptFactDelta(legacyInput);
    const { analysis: _analysis, ...nativeCore } = legacyInput;
    const stream = buildJavascriptTypescriptNativeFactDeltaStream({
      ...nativeCore,
      owner_path: legacyInput.owner_path!,
      records: expected.proposed_records,
      dependencies: expected.proposed_dependencies,
      diagnostic_codes: [],
    }, { cancellation_id: "cancel:direct-stream" });

    const emitted = await rows(stream);
    expect(emitted.records).toEqual(expected.proposed_records);
    expect(emitted.dependencies).toEqual(expected.proposed_dependencies);
    expect(stream.header.delta_digest).toBe(expected.delta_digest);
    expect(buildJavascriptTypescriptNativeFactDeltaHeader({
      ...nativeCore,
      owner_path: legacyInput.owner_path!,
      records: expected.proposed_records,
      dependencies: expected.proposed_dependencies,
      diagnostic_codes: [],
    }, { cancellation_id: "cancel:direct-stream" })).toEqual(stream.header);
  });

  it("frames native-projected canonical rows without reconstructing logical records", async () => {
    const value = input();
    const portable = prepareJavascriptTypescriptFactDeltaStream(value, { cancellation_id: "cancel:portable-projection" });
    const { analysis: _analysis, ...projectedInput } = value;
    const stream = prepareJavascriptTypescriptProjectedFactDeltaStream({
      ...projectedInput,
      owner_path: value.owner_path!,
      projection: {
        canonical_records: portable.records.map(canonicalJson),
        canonical_dependencies: portable.dependencies.map(canonicalJson),
        record_headers: portable.records.map((record) => ({ proposal_record_key: record.proposal_record_key, category: record.category, kind: record.kind, universal_kind: record.universal_kind, identity_key: record.identity_key })),
        dependency_headers: portable.dependencies.map((dependency) => ({ proposed_dependency_id: dependency.proposed_dependency_id, proposal_record_key: dependency.proposal_record_key, dependency_artifact_id: dependency.dependency_artifact_id, dependency_artifact_version_id: dependency.dependency_artifact_version_id, dependency_role: dependency.dependency_role })),
        diagnostic_codes: [],
      },
    }, { cancellation_id: "cancel:projected-projection" }).seal();
    const validator = new FactDeltaStreamValidator(stream.header);
    const canonicalRecords: string[] = [];
    const canonicalDependencies: string[] = [];
    for await (const batch of stream.batches) {
      expect(batch.records).toEqual([]);
      expect(batch.dependencies).toEqual([]);
      validator.accept_batch(batch);
      const sealed = factDeltaStreamSealedRows(batch)!;
      canonicalRecords.push(...sealed.canonical_records);
      canonicalDependencies.push(...sealed.canonical_dependencies);
    }
    expect(validator.finish()).toMatchObject({ record_count: portable.records.length, dependency_count: portable.dependencies.length });
    expect(canonicalRecords).toEqual(portable.records.map(canonicalJson));
    expect(canonicalDependencies).toEqual(portable.dependencies.map(canonicalJson));
  });

  it("pulls one acknowledged batch at a time across the supervised Node process", async () => {
    const transport = createJavascriptTypescriptSemanticProcessTransport({ node_executable: process.execPath, worker: {} });
    try {
      const stream = await transport.invokeFactDeltaStream(request());
      expect(stream.header.schema_id).toBe("core:FactDeltaStream");
      expect(stream.header.backpressure).toEqual({ acknowledgement_mode: "per_batch", max_in_flight_batches: 1 });
      const emitted = await rows(stream);
      expect(emitted.summary.record_count).toBeGreaterThan(0);
      expect(transport.is_healthy()).toBe(true);
    } finally {
      await transport.terminate();
    }
  });
});
