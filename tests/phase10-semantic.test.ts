import { describe, expect, it } from "vitest";
import {
  DeterministicSemanticRuntime,
  DeterministicOnnxInferencePort,
  CoreDocumentRenderer,
  CoreQueryRenderer,
  CoreSegmenter,
  CoreTokenizer,
  SemanticRuntimeRegistry,
  buildSemanticDocument,
  canonicalVectorBytes,
  exactVectorScan,
  fuseSemanticLanes,
  rerankSemanticMatches,
  selectBundledProfile,
  SemanticUpdater,
  type SemanticMaterialization,
  type SemanticMaterializationStore,
  type SemanticProfileLane,
} from "../packages/engine/src/index.js";

const profile = {
  embedding_profile_id: "core:test-profile",
  definition_revision: 1,
  schema_version: 1,
  description: "test profile",
  embedding_contract_version: "1",
  model_provider_id: "core",
  model_id: "deterministic",
  model_revision: "1",
  model_identity_digest: "sha256:model",
  tokenizer_id: "core:test-tokenizer",
  tokenizer_revision: "1",
  tokenizer_digest: "sha256:tokenizer",
  document_input_contract: "sha256:document-template",
  query_input_contract: "sha256:query-template",
  segmentation_contract: "sha256:segmenter",
  maximum_document_tokens: "8",
  maximum_query_tokens: "8",
  dimensions: 2,
  element_type: "float32",
  vector_encoding: "float32-le",
  normalization: "l2",
  distance_metric: "cosine",
  language_support: "all",
  supported_query_classes: "all",
  supported_content_classes: "all",
  agent_guidance: "test",
  lifecycle_state: "active",
  profile_digest: "sha256:profile",
} as const;

function lane(overrides: Partial<SemanticProfileLane> = {}): SemanticProfileLane {
  return {
    profile,
    executable_binding_digest: "sha256:binding",
    runtime_binding_id: "core:deterministic",
    ...overrides,
  };
}

describe("Phase 10 semantic engine", () => {
  it("builds a complete generic document and keeps enrichment optional", () => {
    const first = buildSemanticDocument({
      artifact_id: "artifact-1",
      artifact_version_id: "version-1",
      display_path: "src/example.ts",
      content_class: "source_code",
      language_ids: ["typescript"],
      source_text: "export const answer = 42;",
      enrichment: [{ section_kind: "definitions", text: "answer" }],
    });
    const second = buildSemanticDocument({
      artifact_id: "artifact-1",
      artifact_version_id: "version-1",
      display_path: "src/example.ts",
      content_class: "source_code",
      language_ids: ["typescript"],
      source_text: "export const answer = 42;",
    });

    expect(first.sections[0]).toMatchObject({ origin_kind: "generic_source", text: "export const answer = 42;" });
    expect(first.sections.some((section) => section.origin_kind === "plugin_enrichment")).toBe(true);
    expect(second.sections).toHaveLength(1);
    expect(first.semantic_content_digest).not.toBe(second.semantic_content_digest);
    expect(first.source_content_digest).toBe(second.source_content_digest);
  });

  it("normalizes vectors into canonical little-endian bytes", () => {
    const first = canonicalVectorBytes([3, 4], { dimensions: 2, element_type: "float32", normalization: "l2" });
    const second = canonicalVectorBytes([0.6, 0.8], { dimensions: 2, element_type: "float32", normalization: "l2" });
    expect([...first]).toEqual([...second]);
    expect(first.byteLength).toBe(8);
  });

  it("uses core-owned deterministic bindings and an injected ONNX port", async () => {
    const calls: string[] = [];
    const runtime = new DeterministicSemanticRuntime({
      inference: {
        async infer(input) {
          calls.push(input.purpose);
          return [3, 4];
        },
      },
    });
    const registry = new SemanticRuntimeRegistry([runtime.binding("core:deterministic", "sha256:binding")]);
    const document = buildSemanticDocument({ artifact_id: "a", artifact_version_id: "v", display_path: "a.ts", content_class: "source_code", language_ids: ["typescript"], source_text: "one two three" });

    const generated = await registry.generateVector({ runtime_binding_id: "core:deterministic", executable_binding_digest: "sha256:binding", profile, purpose: "document", text: document.sections[0]!.text });
    expect(generated.vector.byteLength).toBe(8);
    expect(calls).toEqual(["document"]);
    expect(registry.binding("core:deterministic", "sha256:binding").runtime_binding_id).toBe("core:deterministic");
  });

  it("keeps rendering, tokenization, segmentation, and ONNX inference core-owned", async () => {
    const tokenizer = new CoreTokenizer();
    const segmenter = new CoreSegmenter();
    expect(new CoreDocumentRenderer().render("document text")).toBe("document text");
    expect(new CoreQueryRenderer().render("query text")).toBe("query text");
    expect(tokenizer.tokenize("one two three")).toHaveLength(3);
    expect(segmenter.segment(tokenizer.tokenize("one two three"), 2)).toEqual([["one", "two"], ["three"]]);
    const generated = await new DeterministicOnnxInferencePort().infer({ purpose: "query", profile, text: "query", token_ids: tokenizer.tokenize("query"), input_digest: "sha256:input" });
    expect(generated).toHaveLength(2);
  });

  it("rejects executable bindings outside the core namespace", () => {
    expect(() => new DeterministicSemanticRuntime().binding("plugin:runtime", "sha256:binding")).toThrow(/core namespace/i);
  });

  it("performs an exact filtered vector scan without exposing distances", () => {
    const result = exactVectorScan([
      { projection_record_id: "a", profile_id: "p", executable_binding_id: "b", vector: [1, 0], metadata: { language_id: "typescript" } },
      { projection_record_id: "b", profile_id: "p", executable_binding_id: "b", vector: [0, 1], metadata: { language_id: "rust" } },
      { projection_record_id: "c", profile_id: "other", executable_binding_id: "b", vector: [1, 0], metadata: { language_id: "typescript" } },
    ], [1, 0], { profile_id: "p", executable_binding_id: "b", dimensions: 2, distance_metric: "cosine", filter: { language_id: "typescript" } });

    expect(result.map((item) => item.projection_record_id)).toEqual(["a"]);
    expect(result[0]).not.toHaveProperty("distance");
    expect(result[0]).toMatchObject({ rank: 1 });
  });

  it("applies the declared normalization to every exact-scan vector", () => {
    const result = exactVectorScan([
      { projection_record_id: "normalized", profile_id: "p", executable_binding_id: "b", vector: [3, 4] },
      { projection_record_id: "raw", profile_id: "p", executable_binding_id: "b", vector: [0.5, 0.5] },
    ], [0.6, 0.8], { profile_id: "p", executable_binding_id: "b", dimensions: 2, distance_metric: "squared_l2", normalization: "l2" });
    expect(result[0]?.projection_record_id).toBe("normalized");
  });

  it("fuses lanes and reranks with exact rational comparisons and stable ties", () => {
    const fused = fuseSemanticLanes([
      { lane_id: "semantic", candidates: [{ projection_record_id: "b", rank: 1 }, { projection_record_id: "a", rank: 2 }] },
      { lane_id: "lexical", candidates: [{ projection_record_id: "a", rank: 1 }, { projection_record_id: "b", rank: 2 }] },
    ]);
    const reranked = rerankSemanticMatches(fused, { lane_weights: { semantic: { numerator: 1n, denominator: 1n }, lexical: { numerator: 1n, denominator: 1n } } });
    expect(reranked.map((item) => item.projection_record_id)).toEqual(["a", "b"]);
    expect(reranked.every((item) => !Object.hasOwn(item, "score"))).toBe(true);
  });

  it("updates multiple profile lanes explicitly and preserves immutable materializations", async () => {
    const records: SemanticMaterialization[] = [];
    const store: SemanticMaterializationStore = {
      async read() { return records.at(-1); },
      async put(value) { records.push(value); },
    };
    const updater = new SemanticUpdater(store, new DeterministicSemanticRuntime());
    const document = buildSemanticDocument({ artifact_id: "a", artifact_version_id: "v", display_path: "a.ts", content_class: "source_code", language_ids: ["typescript"], source_text: "one two" });
    const result = await updater.update({ source_snapshot_id: "snapshot-1", generation: 1, documents: [document], lanes: [lane(), lane({ profile: { ...profile, embedding_profile_id: "core:other-profile", profile_digest: "sha256:other" } })] });

    expect(result.lanes).toHaveLength(2);
    expect(result.lanes.every((value) => value.coverage_status === "complete")).toBe(true);
    expect(records).toHaveLength(1);
    await expect(updater.update({ source_snapshot_id: "snapshot-1", generation: 1, documents: [document], lanes: [lane(), lane({ profile: { ...profile, embedding_profile_id: "core:other-profile", profile_digest: "sha256:other" } })] })).resolves.toMatchObject({ materialization_digest: result.materialization_digest });
    expect(records).toHaveLength(1);
  });

  it("reports partial coverage and does not publish a failed update", async () => {
    const records: SemanticMaterialization[] = [];
    const store: SemanticMaterializationStore = { async read() { return records.at(-1); }, async put(value) { records.push(value); } };
    const runtime = new DeterministicSemanticRuntime({ failFor: new Set(["core:unsupported"]) });
    const updater = new SemanticUpdater(store, runtime);
    const document = buildSemanticDocument({ artifact_id: "a", artifact_version_id: "v", display_path: "a.ts", content_class: "source_code", language_ids: ["typescript"], source_text: "one two" });

    const partial = await updater.update({ source_snapshot_id: "snapshot-1", generation: 1, documents: [document], lanes: [lane({ runtime_binding_id: "core:unsupported" })], allow_partial: true });
    expect(partial.lanes[0]).toMatchObject({ coverage_status: "failed" });
    expect(records).toHaveLength(1);
    const before = records[0];
    await expect(updater.update({ source_snapshot_id: "snapshot-2", generation: 2, documents: [document], lanes: [lane({ runtime_binding_id: "core:unsupported" })] })).rejects.toThrow(/semantic/i);
    expect(records[0]).toBe(before);
  });

  it("selects bundled profiles only through frozen evaluation gates", () => {
    const selected = selectBundledProfile([
      { profile, evaluation_digest: "sha256:evaluation-a", passed_gate_ids: ["gate:quality"] },
      { profile: { ...profile, embedding_profile_id: "core:rejected", profile_digest: "sha256:rejected" }, evaluation_digest: "sha256:evaluation-b", passed_gate_ids: [] },
    ], [{ gate_id: "gate:quality", gate_version: 1, evaluation_digest: "sha256:evaluation-a" }]);
    expect(selected.profile.embedding_profile_id).toBe(profile.embedding_profile_id);
    expect(selected).not.toHaveProperty("score");
    expect(() => selectBundledProfile([{ profile, evaluation_digest: "sha256:wrong", passed_gate_ids: ["gate:quality"] }], [{ gate_id: "gate:quality", gate_version: 1, evaluation_digest: "sha256:evaluation-a" }])).toThrow(/evaluation gate/i);
  });
});
