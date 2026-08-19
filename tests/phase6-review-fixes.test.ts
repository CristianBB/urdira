import { mkdir, mkdtemp, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalBytes, computeDigest, decodeCanonical, digestBytes } from "@urdira/canonical";
import {
  AdministrativeModelPackDownloader,
  assertAllowedExternalRoot,
  FileStagingStore,
  stagingFileEntryName,
  stagingOperationEntryName,
  ModelPackLifecycleManager,
  PluginPackageLifecycleManager,
  classifySecret,
  inspectModelPack,
  inspectPluginPackage,
  evaluateInclusion,
  normalizeWorkspacePath,
  redactSnippet,
  resolveSafePath,
  safeLogEvent,
} from "@urdira/security";

interface TestProfile {
  embedding_profile_id: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  embedding_contract_version: string;
  model_provider_id: string;
  model_id: string;
  model_revision: string;
  model_identity_digest: string;
  tokenizer_id: string;
  tokenizer_revision: string;
  tokenizer_digest: string;
  document_input_contract: string;
  query_input_contract: string;
  segmentation_contract: string;
  maximum_document_tokens: string;
  maximum_query_tokens: string;
  dimensions: number;
  element_type: string;
  vector_encoding: string;
  normalization: string;
  distance_metric: string;
  language_support: string;
  supported_query_classes: string;
  supported_content_classes: string;
  agent_guidance: string;
  lifecycle_state: string;
  profile_digest: string;
}

function authoritativeProfileDigest(profile: Omit<TestProfile, "profile_digest">): string {
  return digestBytes(canonicalBytes({
    embedding_profile_id: profile.embedding_profile_id, embedding_contract_version: profile.embedding_contract_version, model_provider_id: profile.model_provider_id, model_id: profile.model_id, model_revision: profile.model_revision, model_identity_digest: profile.model_identity_digest,
    tokenizer_id: profile.tokenizer_id, tokenizer_revision: profile.tokenizer_revision, tokenizer_digest: profile.tokenizer_digest, document_input_contract: profile.document_input_contract, query_input_contract: profile.query_input_contract, segmentation_contract: profile.segmentation_contract,
    maximum_document_tokens: profile.maximum_document_tokens, maximum_query_tokens: profile.maximum_query_tokens, dimensions: profile.dimensions, element_type: profile.element_type, vector_encoding: profile.vector_encoding, normalization: profile.normalization, distance_metric: profile.distance_metric, language_support: profile.language_support, supported_query_classes: profile.supported_query_classes, supported_content_classes: profile.supported_content_classes,
  }));
}

function makeProfile(id = "profile:test"): TestProfile {
  const body = {
    embedding_profile_id: id, definition_revision: 1, schema_version: 1, description: "test", embedding_contract_version: "1", model_provider_id: "core", model_id: "model", model_revision: "1", model_identity_digest: "sha256:" + "1".repeat(64), tokenizer_id: "tokenizer", tokenizer_revision: "1", tokenizer_digest: "sha256:" + "2".repeat(64), document_input_contract: "doc", query_input_contract: "query", segmentation_contract: "segment", maximum_document_tokens: "128", maximum_query_tokens: "64", dimensions: 3, element_type: "float32", vector_encoding: "float32-le", normalization: "none", distance_metric: "cosine", language_support: "all_text", supported_query_classes: "natural_text", supported_content_classes: "prose", agent_guidance: "test", lifecycle_state: "active",
  };
  return { ...body, profile_digest: authoritativeProfileDigest(body) };
}

function makeRequirement(profileId: string, role: string, component = `core:${role}`) {
  return { embedding_profile_id: profileId, runtime_role: role, component_id: component, component_version: "1", behavior_digest: `sha256:${role.padEnd(64, "0")}`, contract_version: "1" };
}

function makeConfiguration(profileId: string, role: "segmenter" | "generator", component: string) {
  const body = { schema_version: 1, embedding_profile_id: profileId, runtime_role: role, component_id: component, component_version: "1", contract_version: "1", configuration_schema_id: `core:${role}:configuration`, configuration: new Uint8Array([1, 2, 3]) };
  return { ...body, configuration_digest: digestBytes(canonicalBytes(body)) };
}

function makeManifest(options: { profiles?: readonly TestProfile[]; requirements?: readonly ReturnType<typeof makeRequirement>[]; configurations?: readonly ReturnType<typeof makeConfiguration>[]; assets?: readonly { content_digest: string; decoded_byte_length: number; media_type: string; semantic_role: string }[]; asset_references?: readonly { asset_digest: string; referenced_asset_digests: readonly string[] }[] } = {}) {
  const profile = makeProfile();
  const profiles = options.profiles ?? [profile];
  const requirements = options.requirements ?? ["document_renderer", "query_renderer", "segmenter", "generator"].map((role) => makeRequirement(profile.embedding_profile_id, role));
  const configurations = options.configurations ?? [makeConfiguration(profile.embedding_profile_id, "segmenter", "core:segmenter"), makeConfiguration(profile.embedding_profile_id, "generator", "core:generator")];
  const body = { manifest_schema_version: "1", model_pack_id: "core:test", model_pack_version: "1.0.0", embedding_profiles: profiles, assets: options.assets ?? [], required_runtime_components: requirements, runtime_configurations: configurations, asset_references: options.asset_references ?? [] };
  return { ...body, manifest_digest: digestBytes(canonicalBytes(body)) };
}

type TestManifest = ReturnType<typeof makeManifest>;

function makeClosedTypedPack() {
  const modelConfiguration = new Uint8Array([9]);
  const modelWeight = new Uint8Array([8]);
  const tokenizerData = new Uint8Array([7]);
  const modelConfigurationDigest = digestBytes(modelConfiguration);
  const modelWeightDigest = digestBytes(modelWeight);
  const tokenizerDataDigest = digestBytes(tokenizerData);
  const modelIdentityBody = { schema_version: 1, model_provider_id: "core:provider", model_id: "model", model_revision: "1", architecture_id: "core:test-architecture", model_format: "core:test-format", configuration_asset_digests: [modelConfigurationDigest], weight_asset_digests: [modelWeightDigest] };
  const modelIdentityDigest = digestBytes(canonicalBytes(modelIdentityBody));
  const modelManifest = { ...modelIdentityBody, model_identity_digest: modelIdentityDigest };
  const modelManifestBytes = canonicalBytes(modelManifest);
  const modelManifestDigest = digestBytes(modelManifestBytes);
  const tokenizerIdentityBody = { schema_version: 1, tokenizer_id: "tokenizer", tokenizer_revision: "1", tokenizer_format: "core:test-tokenizer", configuration_asset_digests: [], tokenizer_data_asset_digests: [tokenizerDataDigest] };
  const tokenizerIdentityDigest = digestBytes(canonicalBytes(tokenizerIdentityBody));
  const tokenizerManifest = { ...tokenizerIdentityBody, tokenizer_digest: tokenizerIdentityDigest };
  const tokenizerManifestBytes = canonicalBytes(tokenizerManifest);
  const tokenizerManifestDigest = digestBytes(tokenizerManifestBytes);
  const documentTemplate = new TextEncoder().encode("document {{text}}");
  const queryTemplate = new TextEncoder().encode("query {{text}}");
  const documentTemplateLogicalDigest = computeDigest("core:embedding_template_digest", "core:embedding_template", 1, "core:Bytes", 1, documentTemplate);
  const queryTemplateLogicalDigest = computeDigest("core:embedding_template_digest", "core:embedding_template", 1, "core:Bytes", 1, queryTemplate);
  const documentTemplateDigest = digestBytes(documentTemplate);
  const queryTemplateDigest = digestBytes(queryTemplate);
  const profileBody = { ...makeProfile("profile-test"), model_provider_id: "core:provider", model_identity_digest: modelIdentityDigest, tokenizer_digest: tokenizerIdentityDigest, document_input_contract: documentTemplateLogicalDigest, query_input_contract: queryTemplateLogicalDigest, segmentation_contract: "" };
  const segmenterConfigurationBody = { ...makeConfiguration(profileBody.embedding_profile_id, "segmenter", "core:segmenter"), component_version: "1.0.0", contract_version: 1, configuration_schema_id: "core:Bytes", configuration: canonicalBytes(new Uint8Array([1, 2, 3])) };
  const generatorConfigurationBody = { ...makeConfiguration(profileBody.embedding_profile_id, "generator", "core:generator"), component_version: "1.0.0", contract_version: 1, configuration_schema_id: "core:Bytes", configuration: canonicalBytes(new Uint8Array([4, 5, 6])) };
  const { configuration_digest: _segmenterDigest, ...segmenterWithoutDigest } = segmenterConfigurationBody;
  const { configuration_digest: _generatorDigest, ...generatorWithoutDigest } = generatorConfigurationBody;
  const segmenterConfiguration = { ...segmenterConfigurationBody, configuration_digest: digestBytes(canonicalBytes(segmenterWithoutDigest)) };
  const generatorConfiguration = { ...generatorConfigurationBody, configuration_digest: digestBytes(canonicalBytes(generatorWithoutDigest)) };
  const profileWithContracts = { ...profileBody, segmentation_contract: segmenterConfiguration.configuration_digest };
  const { profile_digest: _profileDigest2, ...profileWithoutDigest } = profileWithContracts;
  const profile = { ...profileWithContracts, profile_digest: authoritativeProfileDigest(profileWithoutDigest) };
  const requirements = ["document_renderer", "query_renderer", "segmenter", "generator"].map((role) => ({ ...makeRequirement(profile.embedding_profile_id, role, `core:${role}`), component_version: "1.0.0", behavior_digest: "sha256:" + "a".repeat(64), contract_version: 1 }));
  const segmenterConfigurationBytes = canonicalBytes(segmenterConfiguration);
  const generatorConfigurationBytes = canonicalBytes(generatorConfiguration);
  const segmenterConfigurationDigest = digestBytes(segmenterConfigurationBytes);
  const generatorConfigurationDigest = digestBytes(generatorConfigurationBytes);
  const assets = [
    { content_digest: modelManifestDigest, decoded_byte_length: modelManifestBytes.byteLength, media_type: "application/vnd.urdira.model-asset-manifest+cbor", semantic_role: "model_manifest" },
    { content_digest: modelWeightDigest, decoded_byte_length: modelWeight.byteLength, media_type: "application/octet-stream", semantic_role: "model_weight" },
    { content_digest: modelConfigurationDigest, decoded_byte_length: modelConfiguration.byteLength, media_type: "application/octet-stream", semantic_role: "model_configuration" },
    { content_digest: tokenizerManifestDigest, decoded_byte_length: tokenizerManifestBytes.byteLength, media_type: "application/vnd.urdira.tokenizer-asset-manifest+cbor", semantic_role: "tokenizer_manifest" },
    { content_digest: tokenizerDataDigest, decoded_byte_length: tokenizerData.byteLength, media_type: "application/octet-stream", semantic_role: "tokenizer_data" },
    { content_digest: queryTemplateDigest, decoded_byte_length: queryTemplate.byteLength, media_type: "text/plain", semantic_role: "input_template" },
    { content_digest: documentTemplateDigest, decoded_byte_length: documentTemplate.byteLength, media_type: "text/plain", semantic_role: "input_template" },
    { content_digest: segmenterConfigurationDigest, decoded_byte_length: segmenterConfigurationBytes.byteLength, media_type: "application/vnd.urdira.model-pack-runtime-configuration+cbor", semantic_role: "segmentation_configuration" },
    { content_digest: generatorConfigurationDigest, decoded_byte_length: generatorConfigurationBytes.byteLength, media_type: "application/vnd.urdira.model-pack-runtime-configuration+cbor", semantic_role: "generator_configuration" },
    { content_digest: digestBytes(new Uint8Array([6])), decoded_byte_length: 1, media_type: "text/plain", semantic_role: "license" },
  ];
  const body = { manifest_schema_version: "1", model_pack_id: "core:test", model_pack_version: "1.0.0", embedding_profiles: [profile], assets, required_runtime_components: requirements };
  return {
    manifest: { ...body, manifest_digest: digestBytes(canonicalBytes(body)) } as unknown as TestManifest,
    blobs: new Map<string, Uint8Array>([
      [modelManifestDigest, modelManifestBytes], [modelConfigurationDigest, modelConfiguration], [modelWeightDigest, modelWeight],
      [tokenizerManifestDigest, tokenizerManifestBytes], [tokenizerDataDigest, tokenizerData], [documentTemplateDigest, documentTemplate], [queryTemplateDigest, queryTemplate], [segmenterConfigurationDigest, segmenterConfigurationBytes],
      [generatorConfigurationDigest, generatorConfigurationBytes], [digestBytes(new Uint8Array([6])), new Uint8Array([6])],
    ]),
    operationalDigests: [modelManifestDigest, modelConfigurationDigest, modelWeightDigest, tokenizerManifestDigest, tokenizerDataDigest, documentTemplateDigest, queryTemplateDigest, segmenterConfigurationDigest, generatorConfigurationDigest].sort(),
    metadataDigests: [digestBytes(new Uint8Array([6]))],
  };
}

function buildSet(manifest: { required_runtime_components: readonly { runtime_role: string; component_id: string; component_version: string; behavior_digest: string; contract_version: string | number }[] }, profileId = "profile:test") {
  return manifest.required_runtime_components.map((requirement) => ({ embedding_profile_id: profileId, runtime_role: requirement.runtime_role, component_id: requirement.component_id, component_version: requirement.component_version, behavior_digest: requirement.behavior_digest, contract_version: requirement.contract_version as string, runtime_component_build_id: `build:${requirement.runtime_role}`, implementation_digest: "sha256:" + "b".repeat(64) }));
}

describe("Phase 6 review regressions", () => {
  it("rejects manifest extensions and accepts only the closed typed asset closure", () => {
    const extended = inspectModelPack(makeManifest() as never, new Map());
    expect(extended.issues.map((item) => item.code)).toContain("security:model_manifest_unknown_field");
    const typed = makeClosedTypedPack();
    expect(inspectModelPack(typed.manifest, typed.blobs)).toMatchObject({ valid: true });
  });

  it("rejects empty profiles, duplicate roles, missing configurations, and unsafe asset roles", () => {
    const typed = makeClosedTypedPack();
    const profile = typed.manifest.embedding_profiles[0]!;
    const empty = inspectModelPack({ ...typed.manifest, embedding_profiles: [] }, typed.blobs);
    expect(empty.issues.map((item) => item.code)).toContain("security:model_manifest_invalid");
    const duplicateRole = inspectModelPack({ ...typed.manifest, required_runtime_components: [...typed.manifest.required_runtime_components, typed.manifest.required_runtime_components[3]!] }, typed.blobs);
    expect(duplicateRole.issues.map((item) => item.code)).toContain("security:model_runtime_role_duplicate");
    const missingConfig = inspectModelPack({ ...typed.manifest, assets: typed.manifest.assets.filter((asset) => asset.semantic_role !== "segmentation_configuration") }, new Map([...typed.blobs].filter(([digest]) => typed.manifest.assets.some((asset) => asset.content_digest === digest && asset.semantic_role !== "segmentation_configuration"))));
    expect(missingConfig.issues.map((item) => item.code)).toContain("security:model_runtime_configuration_missing");
    const extraRole = inspectModelPack({ ...typed.manifest, required_runtime_components: [...typed.manifest.required_runtime_components, { ...typed.manifest.required_runtime_components[0]!, runtime_role: "other" }] }, typed.blobs);
    expect(extraRole.issues.map((item) => item.code)).toContain("security:model_runtime_role_invalid");
    const badConfiguration = inspectModelPack(typed.manifest, new Map([...typed.blobs].map(([digest, bytes]) => [digest, digest === typed.manifest.assets.find((asset) => asset.semantic_role === "segmentation_configuration")?.content_digest ? new Uint8Array([0]) : bytes])));
    expect(badConfiguration.issues.map((item) => item.code)).toContain("security:model_runtime_configuration_invalid");
    const unsafeAsset = inspectModelPack({ ...typed.manifest, assets: [...typed.manifest.assets, { content_digest: "sha256:" + "3".repeat(64), decoded_byte_length: 1, media_type: "application/javascript", semantic_role: "executable" }] }, new Map([...typed.blobs, ["sha256:" + "3".repeat(64), new Uint8Array([1])]]));
    expect(unsafeAsset.issues.map((item) => item.code)).toEqual(expect.arrayContaining(["security:model_semantic_role_invalid", "security:model_media_type_forbidden"]));
  });

  it("returns typed issues for malformed manifest members instead of throwing", () => {
    const typed = makeClosedTypedPack();
    for (const candidate of [
      { ...typed.manifest, assets: [null] },
      { ...typed.manifest, embedding_profiles: [null] },
      { ...typed.manifest, required_runtime_components: [null] },
      { ...typed.manifest, assets: ["not-an-asset"] },
    ]) {
      expect(() => inspectModelPack(candidate as never, typed.blobs)).not.toThrow();
      expect(inspectModelPack(candidate as never, typed.blobs).issues.map((item) => item.code)).toContain("security:model_manifest_invalid");
    }
  });

  it("rejects arbitrary profile enum and class values", () => {
    const typed = makeClosedTypedPack();
    const profile = typed.manifest.embedding_profiles[0]!;
    const invalidValues: Readonly<Record<string, string>> = {
      element_type: "float128",
      vector_encoding: "vendor-private-layout",
      normalization: "unit-normalized",
      distance_metric: "manhattan",
      language_support: "english",
      supported_query_classes: "freeform",
      supported_content_classes: "binary",
      lifecycle_state: "paused",
    };
    for (const [field, value] of Object.entries(invalidValues)) {
      const { profile_digest: _profileDigest, ...withoutDigest } = { ...profile, [field]: value };
      const candidate = { ...withoutDigest, profile_digest: authoritativeProfileDigest(withoutDigest) };
      const result = inspectModelPack({ ...typed.manifest, embedding_profiles: [candidate] }, typed.blobs);
      expect(result.issues.map((item) => item.code), field).toContain("security:model_manifest_invalid");
    }
  });

  it("allows one content-addressed blob to serve distinct model and tokenizer roles", () => {
    const typed = makeClosedTypedPack();
    const tokenizerManifestAsset = typed.manifest.assets.find((asset) => asset.semantic_role === "tokenizer_manifest")!;
    const tokenizerDataAsset = typed.manifest.assets.find((asset) => asset.semantic_role === "tokenizer_data")!;
    const modelWeightAsset = typed.manifest.assets.find((asset) => asset.semantic_role === "model_weight")!;
    const tokenizerManifest = decodeCanonical(typed.blobs.get(tokenizerManifestAsset.content_digest)!) as Record<string, unknown>;
    const { tokenizer_digest: _tokenizerDigest, ...tokenizerIdentity } = tokenizerManifest;
    const sharedTokenizerIdentity = { ...tokenizerIdentity, tokenizer_data_asset_digests: [modelWeightAsset.content_digest] };
    const sharedTokenizerDigest = digestBytes(canonicalBytes(sharedTokenizerIdentity));
    const sharedTokenizerBytes = canonicalBytes({ ...sharedTokenizerIdentity, tokenizer_digest: sharedTokenizerDigest });
    const profile = typed.manifest.embedding_profiles[0]!;
    const { profile_digest: _profileDigest, ...profileWithoutDigest } = { ...profile, tokenizer_digest: sharedTokenizerDigest };
    const sharedProfile = { ...profileWithoutDigest, profile_digest: authoritativeProfileDigest(profileWithoutDigest) };
    const assets = typed.manifest.assets
      .filter((asset) => asset !== tokenizerDataAsset)
      .map((asset) => asset === tokenizerManifestAsset ? { ...asset, content_digest: digestBytes(sharedTokenizerBytes), decoded_byte_length: sharedTokenizerBytes.byteLength } : asset)
      .concat({ ...modelWeightAsset, semantic_role: "tokenizer_data" });
    const assetOrder = ["model_manifest", "model_weight", "model_configuration", "tokenizer_manifest", "tokenizer_data", "input_template", "segmentation_configuration", "generator_configuration", "license"];
    assets.sort((left, right) => assetOrder.indexOf(left.semantic_role) - assetOrder.indexOf(right.semantic_role) || left.content_digest.localeCompare(right.content_digest));
    const blobs = new Map([...typed.blobs]
      .filter(([digest]) => digest !== tokenizerManifestAsset.content_digest && digest !== tokenizerDataAsset.content_digest)
      .concat([[digestBytes(sharedTokenizerBytes), sharedTokenizerBytes]]));
    const body = { ...typed.manifest, embedding_profiles: [sharedProfile], assets };
    const { manifest_digest: _manifestDigest, ...withoutManifestDigest } = body;
    const manifest = { ...withoutManifestDigest, manifest_digest: digestBytes(canonicalBytes(withoutManifestDigest)) };
    const result = inspectModelPack(manifest, blobs);
    expect(result.valid).toBe(true);
  });

  it("rejects conflicting metadata for a reused content digest", () => {
    const typed = makeClosedTypedPack();
    const modelWeight = typed.manifest.assets.find((asset) => asset.semantic_role === "model_weight")!;
    const conflicting = { ...modelWeight, semantic_role: "tokenizer_data", decoded_byte_length: modelWeight.decoded_byte_length + 1 };
    const result = inspectModelPack({ ...typed.manifest, assets: [...typed.manifest.assets, conflicting] }, typed.blobs);
    expect(result.issues.map((item) => item.code)).toContain("security:model_manifest_invalid");
  });

  it("roots every declared asset while active and rejects undeclared blob entries", async () => {
    const typed = makeClosedTypedPack();
    const manager = new ModelPackLifecycleManager();
    const installed = await manager.install(typed.manifest, typed.blobs);
    expect(installed.rooted_asset_digests).toEqual(typed.manifest.assets.map((asset) => asset.content_digest).sort());
    const orphan = new Uint8Array([99]);
    const orphanDigest = digestBytes(orphan);
    const inspection = inspectModelPack(typed.manifest, new Map([...typed.blobs, [orphanDigest, orphan]]));
    expect(inspection.issues.map((item) => item.code)).toContain("security:model_undeclared_asset");
  });

  it("rejects closure references that are missing or cyclic", () => {
    const typed = makeClosedTypedPack();
    const manifestBytes = typed.blobs.get(typed.manifest.assets.find((asset) => asset.semantic_role === "model_manifest")!.content_digest)!;
    const malformedModelManifest = canonicalBytes({ schema_version: 1, model_provider_id: "core:provider", model_id: "model", model_revision: "1", architecture_id: "core:test-architecture", model_format: "core:test-format", configuration_asset_digests: [], weight_asset_digests: ["sha256:" + "4".repeat(64)], model_identity_digest: typed.manifest.embedding_profiles[0]!.model_identity_digest });
    const malformedDigest = digestBytes(malformedModelManifest);
    const manifest = { ...typed.manifest, assets: typed.manifest.assets.map((asset) => asset.semantic_role === "model_manifest" ? { ...asset, content_digest: malformedDigest, decoded_byte_length: malformedModelManifest.byteLength } : asset) };
    const blobs = new Map([...typed.blobs].filter(([digest]) => digest !== typed.manifest.assets.find((asset) => asset.semantic_role === "model_manifest")!.content_digest));
    blobs.set(malformedDigest, malformedModelManifest);
    const result = inspectModelPack(manifest, blobs);
    expect(result.issues.map((item) => item.code)).toContain("security:model_closure_reference_missing");
    expect(manifestBytes.byteLength).toBeGreaterThan(0);

    const cycleA = "sha256:" + "a".repeat(64);
    const cycleB = "sha256:" + "b".repeat(64);
    const cycleABytes = canonicalBytes({ schema_version: 1, model_provider_id: "core:provider", model_id: "model-a", model_revision: "1", architecture_id: "core:test-architecture", model_format: "core:test-format", configuration_asset_digests: [], weight_asset_digests: [cycleB], model_identity_digest: typed.manifest.embedding_profiles[0]!.model_identity_digest });
    const cycleBBytes = canonicalBytes({ schema_version: 1, model_provider_id: "core:provider", model_id: "model-b", model_revision: "1", architecture_id: "core:test-architecture", model_format: "core:test-format", configuration_asset_digests: [], weight_asset_digests: [cycleA], model_identity_digest: typed.manifest.embedding_profiles[0]!.model_identity_digest });
    const cycleBody = { ...typed.manifest, assets: [...typed.manifest.assets.filter((asset) => asset.semantic_role !== "model_manifest"), { content_digest: cycleA, decoded_byte_length: cycleABytes.byteLength, media_type: "application/vnd.urdira.model-asset-manifest+cbor", semantic_role: "model_manifest" }, { content_digest: cycleB, decoded_byte_length: cycleBBytes.byteLength, media_type: "application/vnd.urdira.model-asset-manifest+cbor", semantic_role: "model_manifest" }] };
    const { manifest_digest: _cycleDigest, ...cycleWithoutDigest } = cycleBody;
    const cycleManifest = { ...cycleBody, manifest_digest: digestBytes(canonicalBytes(cycleWithoutDigest)) };
    const cycleBlobs = new Map([...typed.blobs].filter(([digest]) => digest !== typed.manifest.assets.find((asset) => asset.semantic_role === "model_manifest")!.content_digest));
    cycleBlobs.set(cycleA, cycleABytes);
    cycleBlobs.set(cycleB, cycleBBytes);
    expect(() => inspectModelPack(cycleManifest as never, cycleBlobs)).not.toThrow();
    expect(inspectModelPack(cycleManifest as never, cycleBlobs).issues.map((item) => item.code)).toContain("security:model_closure_cycle");
  });

  it("rejects missing and wrongly typed required profile fields as typed issues", () => {
    const typed = makeClosedTypedPack();
    const profile = typed.manifest.embedding_profiles[0]!;
    const missingDescription = { ...profile } as Record<string, unknown>;
    delete missingDescription["description"];
    const wrongDimensions = { ...profile, dimensions: "three" };
    for (const candidate of [missingDescription, wrongDimensions, { ...profile, model_identity_digest: null }]) {
      const body = { ...typed.manifest, embedding_profiles: [candidate] };
      const { manifest_digest: _manifestDigest, ...withoutDigest } = body;
      const manifest = { ...body, manifest_digest: digestBytes(canonicalBytes(withoutDigest)) };
      expect(() => inspectModelPack(manifest as never, typed.blobs)).not.toThrow();
      expect(inspectModelPack(manifest as never, typed.blobs).issues.map((item) => item.code)).toContain("security:model_manifest_invalid");
    }
  });

  it("rejects malformed runtime configuration assets without throwing", () => {
    const typed = makeClosedTypedPack();
    const original = typed.manifest.assets.find((asset) => asset.semantic_role === "segmentation_configuration")!;
    const malformedBytes = canonicalBytes({ schema_version: 1, embedding_profile_id: "profile-test", runtime_role: "segmenter" });
    const malformedDigest = digestBytes(malformedBytes);
    const body = { ...typed.manifest, assets: typed.manifest.assets.map((asset) => asset === original ? { ...asset, content_digest: malformedDigest, decoded_byte_length: malformedBytes.byteLength } : asset) };
    const { manifest_digest: _manifestDigest, ...withoutDigest } = body;
    const manifest = { ...body, manifest_digest: digestBytes(canonicalBytes(withoutDigest)) };
    const blobs = new Map([...typed.blobs].filter(([digest]) => digest !== original.content_digest));
    blobs.set(malformedDigest, malformedBytes);
    expect(() => inspectModelPack(manifest as never, blobs)).not.toThrow();
    expect(inspectModelPack(manifest as never, blobs).issues.map((item) => item.code)).toContain("security:model_runtime_configuration_invalid");
  });

  it("validates digest references inside declarative model manifests", () => {
    const referenced = "sha256:" + "6".repeat(64);
    const typed = makeClosedTypedPack();
    const originalAsset = typed.manifest.assets.find((asset) => asset.semantic_role === "model_manifest")!;
    const manifestBytes = canonicalBytes({ schema_version: 1, model_provider_id: "core:provider", model_id: "model", model_revision: "1", architecture_id: "core:test-architecture", model_format: "core:test-format", configuration_asset_digests: [], weight_asset_digests: [referenced], model_identity_digest: typed.manifest.embedding_profiles[0]!.model_identity_digest });
    const manifestDigest = digestBytes(manifestBytes);
    const pack = { ...typed.manifest, assets: typed.manifest.assets.map((asset) => asset === originalAsset ? { ...asset, content_digest: manifestDigest, decoded_byte_length: manifestBytes.byteLength } : asset) };
    const blobs = new Map([...typed.blobs].filter(([digest]) => digest !== originalAsset.content_digest));
    blobs.set(manifestDigest, manifestBytes);
    const result = inspectModelPack(pack, blobs);
    expect(result.issues.map((item) => item.code)).toContain("security:model_closure_reference_missing");
  });

  it("rejects model closure references declared under the wrong semantic role", () => {
    const typed = makeClosedTypedPack();
    const originalModelManifest = typed.manifest.assets.find((asset) => asset.semantic_role === "model_manifest")!;
    const modelConfiguration = typed.manifest.assets.find((asset) => asset.semantic_role === "model_configuration")!;
    const modelWeight = typed.manifest.assets.find((asset) => asset.semantic_role === "model_weight")!;
    const modelIdentityBody = {
      schema_version: 1,
      model_provider_id: "core:provider",
      model_id: "model",
      model_revision: "1",
      architecture_id: "core:test-architecture",
      model_format: "core:test-format",
      configuration_asset_digests: [modelWeight.content_digest],
      weight_asset_digests: [modelConfiguration.content_digest],
    };
    const modelManifestBytes = canonicalBytes({ ...modelIdentityBody, model_identity_digest: digestBytes(canonicalBytes(modelIdentityBody)) });
    const modelManifestDigest = digestBytes(modelManifestBytes);
    const originalProfile = typed.manifest.embedding_profiles[0]!;
    const { profile_digest: _profileDigest, ...profileWithoutDigest } = { ...originalProfile, model_identity_digest: digestBytes(canonicalBytes(modelIdentityBody)) };
    const profile = { ...profileWithoutDigest, profile_digest: authoritativeProfileDigest(profileWithoutDigest) };
    const body = {
      ...typed.manifest,
      embedding_profiles: [profile],
      assets: typed.manifest.assets.map((asset) => asset === originalModelManifest ? { ...asset, content_digest: modelManifestDigest, decoded_byte_length: modelManifestBytes.byteLength } : asset),
    };
    const { manifest_digest: _manifestDigest, ...withoutDigest } = body;
    const manifest = { ...body, manifest_digest: digestBytes(canonicalBytes(withoutDigest)) };
    const blobs = new Map([...typed.blobs].filter(([digest]) => digest !== originalModelManifest.content_digest));
    blobs.set(modelManifestDigest, modelManifestBytes);
    expect(inspectModelPack(manifest, blobs).issues.map((item) => item.code)).toContain("security:model_closure_reference_invalid");
  });

  it("requires a declared profile and exactly four compatible activation builds", async () => {
    const typed = makeClosedTypedPack();
    const manifest = typed.manifest;
    const manager = new ModelPackLifecycleManager();
    const installed = await manager.install(manifest, typed.blobs);
    expect(() => manager.activate(installed.model_pack_installation_id, "profile:missing", [])).toThrow("security:model_activation_invalid");
    expect(() => manager.activate(installed.model_pack_installation_id, "profile-test", [])).toThrow("security:model_activation_invalid");
    const incompatible = buildSet(manifest, "profile-test").map((build, index) => index === 0 ? { ...build, component_id: "core:wrong" } : build);
    expect(() => manager.activate(installed.model_pack_installation_id, "profile-test", incompatible)).toThrow("security:model_activation_invalid");
    expect(() => manager.activate(installed.model_pack_installation_id, "profile-test", [...buildSet(manifest, "profile-test"), ...buildSet(manifest, "profile-test").slice(0, 1)])).toThrow("security:model_activation_invalid");
    expect(manager.activate(installed.model_pack_installation_id, "profile-test", buildSet(manifest, "profile-test")).retained_binding_digests).toHaveLength(1);
  });

  it("retains operational assets and allocates a new occurrence after removal", async () => {
    const typed = makeClosedTypedPack();
    const manifest = typed.manifest;
    const manager = new ModelPackLifecycleManager();
    const first = await manager.install(manifest, typed.blobs);
    const activated = manager.activate(first.model_pack_installation_id, "profile-test", buildSet(manifest, "profile-test"));
    expect(activated.rooted_asset_digests).toEqual(manifest.assets.map((asset) => asset.content_digest).sort());
    const removed = manager.remove(first.model_pack_installation_id);
    expect(removed.rooted_asset_digests).toEqual(typed.operationalDigests);
    expect(removed.rooted_asset_digests).not.toContain(typed.metadataDigests[0]);
    const second = await manager.install(manifest, typed.blobs);
    expect(second.model_pack_installation_id).not.toBe(first.model_pack_installation_id);
    const conflictLicense = new Uint8Array([5]);
    const conflictLicenseDigest = digestBytes(conflictLicense);
    const conflictBody = { ...manifest, assets: [...manifest.assets, { content_digest: conflictLicenseDigest, decoded_byte_length: conflictLicense.byteLength, media_type: "text/plain", semantic_role: "provenance" }] };
    const { manifest_digest: _ignoredDigest, ...conflictWithoutDigest } = conflictBody;
    const conflict = { ...conflictBody, manifest_digest: digestBytes(canonicalBytes(conflictWithoutDigest)) };
    await expect(manager.install(conflict, new Map([...typed.blobs, [conflictLicenseDigest, conflictLicense]]))).rejects.toThrow("security:model_coordinate_collision");
  });

  it("detects cross-pack profile collisions and recovers lifecycle identities across manager restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase6-model-recovery-"));
    const typed = makeClosedTypedPack();
    const firstManager = new ModelPackLifecycleManager(new FileStagingStore(root));
    const first = await firstManager.install(typed.manifest, typed.blobs);
    const firstBinding = firstManager.activate(first.model_pack_installation_id, "profile-test", buildSet(typed.manifest, "profile-test"));

    const conflictingProfileBase = { ...typed.manifest.embedding_profiles[0]!, maximum_query_tokens: "63" };
    const conflictingProfileWithoutDigest = { embedding_profile_id: conflictingProfileBase.embedding_profile_id, embedding_contract_version: conflictingProfileBase.embedding_contract_version, model_provider_id: conflictingProfileBase.model_provider_id, model_id: conflictingProfileBase.model_id, model_revision: conflictingProfileBase.model_revision, model_identity_digest: conflictingProfileBase.model_identity_digest, tokenizer_id: conflictingProfileBase.tokenizer_id, tokenizer_revision: conflictingProfileBase.tokenizer_revision, tokenizer_digest: conflictingProfileBase.tokenizer_digest, document_input_contract: conflictingProfileBase.document_input_contract, query_input_contract: conflictingProfileBase.query_input_contract, segmentation_contract: conflictingProfileBase.segmentation_contract, maximum_document_tokens: conflictingProfileBase.maximum_document_tokens, maximum_query_tokens: conflictingProfileBase.maximum_query_tokens, dimensions: conflictingProfileBase.dimensions, element_type: conflictingProfileBase.element_type, vector_encoding: conflictingProfileBase.vector_encoding, normalization: conflictingProfileBase.normalization, distance_metric: conflictingProfileBase.distance_metric, language_support: conflictingProfileBase.language_support, supported_query_classes: conflictingProfileBase.supported_query_classes, supported_content_classes: conflictingProfileBase.supported_content_classes };
    const conflictingProfile = { ...conflictingProfileBase, profile_digest: digestBytes(canonicalBytes(conflictingProfileWithoutDigest)) };
    const conflictBody = { ...typed.manifest, model_pack_id: "core:other", embedding_profiles: [conflictingProfile] };
    const { manifest_digest: _manifestDigest, ...conflictWithoutDigest } = conflictBody;
    const conflictingManifest = { ...conflictBody, manifest_digest: digestBytes(canonicalBytes(conflictWithoutDigest)) };
    await expect(firstManager.install(conflictingManifest as never, typed.blobs)).rejects.toThrow("security:model_profile_collision");

    const restarted = new ModelPackLifecycleManager(new FileStagingStore(root));
    expect(restarted.list()).toHaveLength(1);
    expect(restarted.list()[0]?.state).toBe("active");
    await restarted.recover();
    expect(restarted.list()).toHaveLength(1);
    restarted.remove(first.model_pack_installation_id);
    const second = await restarted.install(typed.manifest, typed.blobs);
    expect(second.model_pack_installation_id).not.toBe(first.model_pack_installation_id);
    const secondBinding = restarted.activate(second.model_pack_installation_id, "profile-test", buildSet(typed.manifest, "profile-test"));
    expect(secondBinding.retained_binding_digests).toEqual(firstBinding.retained_binding_digests);
    const afterActivationRestart = new ModelPackLifecycleManager(new FileStagingStore(root));
    await afterActivationRestart.recover();
    expect(afterActivationRestart.list()[0]?.retained_binding_digests).toEqual(secondBinding.retained_binding_digests);
    const durableCatalog = JSON.parse(await readFile(join(root, "catalog.json"), "utf8")) as { state?: { installations?: readonly { blob_roots?: Record<string, unknown>; bindings?: readonly { builds?: readonly unknown[] }[] }[] } };
    expect(Object.keys(durableCatalog.state?.installations?.[0]?.blob_roots ?? {})).toEqual(expect.arrayContaining(typed.manifest.assets.map((asset) => asset.content_digest)));
    expect(durableCatalog.state?.installations?.[0]?.bindings?.[0]?.builds).toHaveLength(4);
    const interruptedStore = new FileStagingStore(root);
    await interruptedStore.stage("interrupted-state-check", [{ path: "marker", bytes: new Uint8Array([1]) }]);
    await interruptedStore.markInterrupted("interrupted-state-check");
    const afterInterruptedRecovery = new ModelPackLifecycleManager(new FileStagingStore(root));
    await afterInterruptedRecovery.recover();
    expect(afterInterruptedRecovery.list()[0]?.retained_binding_digests).toEqual(secondBinding.retained_binding_digests);
    const removed = afterActivationRestart.remove(second.model_pack_installation_id);
    const afterRemovalRestart = new ModelPackLifecycleManager(new FileStagingStore(root));
    await afterRemovalRestart.recover();
    expect(afterRemovalRestart.list().find((record) => record.model_pack_installation_id === second.model_pack_installation_id)).toEqual(removed);
    expect(afterRemovalRestart.list().find((record) => record.model_pack_installation_id === second.model_pack_installation_id)?.state).toBe("removed");
  });

  it("includes runtime configurations and the complete operational closure in portable profile identity", async () => {
    const typed = makeClosedTypedPack();
    const root = await mkdtemp(join(tmpdir(), "urdira-phase6-profile-identity-"));
    const equivalentBody = { ...typed.manifest, model_pack_id: "core:equivalent" };
    const { manifest_digest: _equivalentDigest, ...equivalentWithoutDigest } = equivalentBody;
    const equivalent = { ...equivalentBody, manifest_digest: digestBytes(canonicalBytes(equivalentWithoutDigest)) };
    const manager = new ModelPackLifecycleManager(new FileStagingStore(root));
    await manager.install(typed.manifest, typed.blobs);
    await expect(manager.install(equivalent as never, typed.blobs)).resolves.toBeDefined();

    const configurationBytes = canonicalBytes(new Uint8Array([9, 9]));
    const configurationBody = { schema_version: 1, embedding_profile_id: "profile-test", runtime_role: "segmenter", component_id: "core:segmenter", component_version: "1.0.0", contract_version: 1, configuration_schema_id: "core:Bytes", configuration: configurationBytes };
    const { configuration_digest: _configurationDigest, ...configurationWithoutDigest } = configurationBody as typeof configurationBody & { configuration_digest?: string };
    const configuration = { ...configurationBody, configuration_digest: digestBytes(canonicalBytes(configurationWithoutDigest)) };
    const changedConfigurationBytes = canonicalBytes(configuration);
    const changedConfigurationDigest = digestBytes(changedConfigurationBytes);
    const original = typed.manifest.assets.find((asset) => asset.semantic_role === "segmentation_configuration")!;
    const changedProfileBase = { ...typed.manifest.embedding_profiles[0]!, segmentation_contract: configuration.configuration_digest };
    const { profile_digest: _changedProfileDigest, ...changedProfileWithoutDigest } = changedProfileBase;
    const changedProfile = { ...changedProfileBase, profile_digest: authoritativeProfileDigest(changedProfileWithoutDigest) };
    const changedBody = { ...typed.manifest, model_pack_id: "core:changed", embedding_profiles: [changedProfile], assets: typed.manifest.assets.map((asset) => asset === original ? { ...asset, content_digest: changedConfigurationDigest, decoded_byte_length: changedConfigurationBytes.byteLength } : asset) };
    const { manifest_digest: _changedDigest, ...changedWithoutDigest } = changedBody;
    const changed = { ...changedBody, manifest_digest: digestBytes(canonicalBytes(changedWithoutDigest)) };
    const changedBlobs = new Map([...typed.blobs].filter(([digest]) => digest !== original.content_digest));
    changedBlobs.set(changedConfigurationDigest, changedConfigurationBytes);
    await expect(manager.install(changed as never, changedBlobs)).rejects.toThrow("security:model_profile_collision");
  });

  it("replays durable model repair roots when a state snapshot is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase6-model-repair-recovery-"));
    const typed = makeClosedTypedPack();
    const first = new ModelPackLifecycleManager(new FileStagingStore(root));
    const installed = await first.install(typed.manifest, typed.blobs);
    first.activate(installed.model_pack_installation_id, "profile-test", buildSet(typed.manifest, "profile-test"));
    const staleCatalog = JSON.parse(await readFile(join(root, "catalog.json"), "utf8")) as { state?: unknown; operations?: Record<string, unknown> };
    const repairedDigest = typed.manifest.assets.find((asset) => asset.semantic_role === "model_weight")!.content_digest;
    await first.repair(installed.model_pack_installation_id, new Map([[repairedDigest, typed.blobs.get(repairedDigest)!]]));
    await first.repair(installed.model_pack_installation_id, new Map([[repairedDigest, typed.blobs.get(repairedDigest)!]]));
    const currentCatalog = JSON.parse(await readFile(join(root, "catalog.json"), "utf8")) as { state?: unknown; operations?: Record<string, unknown> };
    const reversedOperations = Object.fromEntries(Object.entries(currentCatalog.operations ?? {}).reverse());
    await writeFile(join(root, "catalog.json"), JSON.stringify({ ...currentCatalog, operations: reversedOperations, state: staleCatalog.state }));

    const restarted = new ModelPackLifecycleManager(new FileStagingStore(root));
    await restarted.recover();
    expect(restarted.list()).toEqual([expect.objectContaining({ model_pack_installation_id: installed.model_pack_installation_id, state: "active", rooted_asset_digests: typed.manifest.assets.map((asset) => asset.content_digest).sort() })]);
    const recoveredCatalog = JSON.parse(await readFile(join(root, "catalog.json"), "utf8")) as { state?: { installations?: readonly { blob_roots?: Record<string, { operation_id?: string }>; bindings?: readonly { builds?: readonly unknown[] }[] }[] } };
    const recoveredInstallation = recoveredCatalog.state?.installations?.find((entry) => entry.blob_roots?.[repairedDigest]);
    expect(recoveredInstallation?.blob_roots?.[repairedDigest]?.operation_id).toMatch(/-3$/u);
    expect(recoveredInstallation?.bindings?.[0]?.builds).toHaveLength(4);
  });

  it("uses the authoritative profile digest and deterministic manifest ordering", () => {
    const typed = makeClosedTypedPack();
    const profile = typed.manifest.embedding_profiles[0]!;
    const expected = digestBytes(canonicalBytes({
      embedding_profile_id: profile.embedding_profile_id,
      embedding_contract_version: profile.embedding_contract_version,
      model_provider_id: profile.model_provider_id,
      model_id: profile.model_id,
      model_revision: profile.model_revision,
      model_identity_digest: profile.model_identity_digest,
      tokenizer_id: profile.tokenizer_id,
      tokenizer_revision: profile.tokenizer_revision,
      tokenizer_digest: profile.tokenizer_digest,
      document_input_contract: profile.document_input_contract,
      query_input_contract: profile.query_input_contract,
      segmentation_contract: profile.segmentation_contract,
      maximum_document_tokens: profile.maximum_document_tokens,
      maximum_query_tokens: profile.maximum_query_tokens,
      dimensions: profile.dimensions,
      element_type: profile.element_type,
      vector_encoding: profile.vector_encoding,
      normalization: profile.normalization,
      distance_metric: profile.distance_metric,
      language_support: profile.language_support,
      supported_query_classes: profile.supported_query_classes,
      supported_content_classes: profile.supported_content_classes,
    }));
    expect(profile.profile_digest).toBe(expected);
    const metadataBody = { ...typed.manifest, embedding_profiles: [{ ...profile, description: "metadata changed", agent_guidance: "metadata changed" }] };
    const { manifest_digest: _metadataDigest, ...metadataWithoutDigest } = metadataBody;
    expect(inspectModelPack({ ...metadataBody, manifest_digest: digestBytes(canonicalBytes(metadataWithoutDigest)) }, typed.blobs)).toMatchObject({ valid: true });
    expect(inspectModelPack({ ...typed.manifest, assets: [...typed.manifest.assets].reverse() }, typed.blobs)).toMatchObject({ valid: true });
  });

  it("rejects runtime configurations that do not match the profile contract", () => {
    const typed = makeClosedTypedPack();
    const original = typed.manifest.embedding_profiles[0]!;
    const changedProfileBody = { ...original, embedding_contract_version: "2" };
    const { profile_digest: _profileDigest, ...changedProfileWithoutDigest } = changedProfileBody;
    const changedProfile = { ...changedProfileBody, profile_digest: digestBytes(canonicalBytes({
      embedding_profile_id: changedProfileWithoutDigest.embedding_profile_id,
      embedding_contract_version: changedProfileWithoutDigest.embedding_contract_version,
      model_provider_id: changedProfileWithoutDigest.model_provider_id,
      model_id: changedProfileWithoutDigest.model_id,
      model_revision: changedProfileWithoutDigest.model_revision,
      model_identity_digest: changedProfileWithoutDigest.model_identity_digest,
      tokenizer_id: changedProfileWithoutDigest.tokenizer_id,
      tokenizer_revision: changedProfileWithoutDigest.tokenizer_revision,
      tokenizer_digest: changedProfileWithoutDigest.tokenizer_digest,
      document_input_contract: changedProfileWithoutDigest.document_input_contract,
      query_input_contract: changedProfileWithoutDigest.query_input_contract,
      segmentation_contract: changedProfileWithoutDigest.segmentation_contract,
      maximum_document_tokens: changedProfileWithoutDigest.maximum_document_tokens,
      maximum_query_tokens: changedProfileWithoutDigest.maximum_query_tokens,
      dimensions: changedProfileWithoutDigest.dimensions,
      element_type: changedProfileWithoutDigest.element_type,
      vector_encoding: changedProfileWithoutDigest.vector_encoding,
      normalization: changedProfileWithoutDigest.normalization,
      distance_metric: changedProfileWithoutDigest.distance_metric,
      language_support: changedProfileWithoutDigest.language_support,
      supported_query_classes: changedProfileWithoutDigest.supported_query_classes,
      supported_content_classes: changedProfileWithoutDigest.supported_content_classes,
    })) };
    const body = { ...typed.manifest, embedding_profiles: [changedProfile] };
    const { manifest_digest: _manifestDigest, ...withoutDigest } = body;
    const result = inspectModelPack({ ...body, manifest_digest: digestBytes(canonicalBytes(withoutDigest)) }, typed.blobs);
    expect(result.issues.map((item) => item.code)).toContain("security:model_runtime_configuration_invalid");
  });

  it("enforces exact template/runtime media and template reference retention semantics", () => {
    const typed = makeClosedTypedPack();
    const template = typed.manifest.assets.find((asset) => asset.semantic_role === "input_template")!;
    const wrongTemplateMedia = { ...typed.manifest, assets: typed.manifest.assets.map((asset) => asset === template ? { ...asset, media_type: "application/cbor" } : asset) };
    const { manifest_digest: _wrongDigest, ...wrongWithoutDigest } = wrongTemplateMedia;
    expect(inspectModelPack({ ...wrongTemplateMedia, manifest_digest: digestBytes(canonicalBytes(wrongWithoutDigest)) }, typed.blobs).issues.map((item) => item.code)).toContain("security:model_media_type_invalid");
    const orphanBytes = new Uint8Array([11]);
    const orphanDigest = digestBytes(orphanBytes);
    const orphanBody = { ...typed.manifest, assets: [...typed.manifest.assets, { content_digest: orphanDigest, decoded_byte_length: 1, media_type: "text/plain", semantic_role: "input_template" }] };
    const { manifest_digest: _orphanDigest, ...orphanWithoutDigest } = orphanBody;
    expect(inspectModelPack({ ...orphanBody, manifest_digest: digestBytes(canonicalBytes(orphanWithoutDigest)) }, new Map([...typed.blobs, [orphanDigest, orphanBytes]])).issues.map((item) => item.code)).toContain("security:model_closure_reference_invalid");
    const genericManifestMedia = { ...typed.manifest, assets: typed.manifest.assets.map((asset) => asset.semantic_role === "model_manifest" || asset.semantic_role === "tokenizer_manifest" ? { ...asset, media_type: "application/cbor" } : asset) };
    const { manifest_digest: _genericDigest, ...genericWithoutDigest } = genericManifestMedia;
    expect(inspectModelPack({ ...genericManifestMedia, manifest_digest: digestBytes(canonicalBytes(genericWithoutDigest)) }, typed.blobs).issues.map((item) => item.code)).toContain("security:model_media_type_invalid");
  });

  it("rejects malicious templates outside the closed renderer vocabulary", () => {
    const typed = makeClosedTypedPack();
    const originalAsset = typed.manifest.assets.find((asset) => asset.semantic_role === "input_template")!;
    for (const malicious of ["{{file_path}}", "{{text}} include ../outside/secret.txt", "{{text}} https://evil.example/x", "{{text}}; $(cat /etc/passwd)"]) {
      const bytes = new TextEncoder().encode(malicious);
      const contentDigest = digestBytes(bytes);
      const logicalDigest = computeDigest("core:embedding_template_digest", "core:embedding_template", 1, "core:Bytes", 1, bytes);
      const profileBase = { ...typed.manifest.embedding_profiles[0]!, document_input_contract: logicalDigest };
      const { profile_digest: _profileDigest, ...profileWithoutDigest } = profileBase;
      const profile = { ...profileBase, profile_digest: authoritativeProfileDigest(profileWithoutDigest) };
      const body = { ...typed.manifest, embedding_profiles: [profile], assets: typed.manifest.assets.map((asset) => asset === originalAsset ? { ...asset, content_digest: contentDigest, decoded_byte_length: bytes.byteLength } : asset) };
      const { manifest_digest: _manifestDigest, ...withoutDigest } = body;
      const blobs = new Map([...typed.blobs].filter(([digest]) => digest !== originalAsset.content_digest));
      blobs.set(contentDigest, bytes);
      const result = inspectModelPack({ ...body, manifest_digest: digestBytes(canonicalBytes(withoutDigest)) }, blobs);
      expect(result.issues.map((item) => item.code)).toContain("security:model_template_invalid");
    }
  });

  it("rejects package files outside the manifest and supports activation and repair", async () => {
    const bytes = Buffer.from("worker");
    const manifest = { package_format_id: "core:plugin", package_format_version: 1, plugin_id: "plugin:review", plugin_version: "1.0.0", package_files: [{ normalized_relative_path: "worker.js", content_digest: digestBytes(bytes), byte_length: bytes.length, executable: true }] };
    const extra = inspectPluginPackage(manifest, new Map([["worker.js", bytes], ["extra.txt", Buffer.from("extra")]]));
    expect(extra.issues.map((item) => item.code)).toContain("security:package_extra_file");
    const manager = new PluginPackageLifecycleManager();
    const installed = await manager.install(manifest, new Map([["worker.js", bytes]]));
    expect(() => manager.activate("plugin:review", "1.0.0", "sha256:" + "0".repeat(64))).toThrow("security:package_activation_invalid");
    expect(manager.activate("plugin:review", "1.0.0", installed.package_digest).state).toBe("active");
    await expect(manager.repair("plugin:review", "1.0.0", manifest, new Map([["worker.js", bytes]]))).resolves.toMatchObject({ package_digest: installed.package_digest });
    expect(manager.remove("plugin:review", "1.0.0").state).toBe("removed");
    expect((await manager.install(manifest, new Map([["worker.js", bytes]]))).state).toBe("installed");
    const changed = { ...manifest, package_files: [{ ...manifest.package_files[0]!, content_digest: digestBytes(Buffer.from("changed")), byte_length: 7 }] };
    await expect(manager.repair("plugin:review", "1.0.0", changed, new Map([["worker.js", Buffer.from("changed")]]))).rejects.toThrow("security:package_coordinate_collision");
  });

  it("rejects empty or malformed plugin manifests", () => {
    expect(inspectPluginPackage({ package_format_id: "core:plugin", package_format_version: 1, plugin_id: "plugin:test", plugin_version: "1.0.0", package_files: [] }, new Map()).valid).toBe(false);
    expect(inspectPluginPackage({ package_format_id: "bad", package_format_version: 1, plugin_id: "../outside", plugin_version: "1.0", package_files: [] }, new Map()).issues.map((item) => item.code)).toEqual(expect.arrayContaining(["security:package_manifest_invalid", "security:package_plugin_id_invalid", "security:package_version_invalid"]));
  });

  it("repairs plugin bytes through staged publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase6-plugin-repair-"));
    const store = new FileStagingStore(root);
    const replacement = Buffer.from("repair");
    const manifest = { package_format_id: "core:plugin", package_format_version: 1, plugin_id: "plugin:repair", plugin_version: "1.0.0", package_files: [{ normalized_relative_path: "worker.js", content_digest: digestBytes(replacement), byte_length: replacement.length, executable: true }] };
    const manager = new PluginPackageLifecycleManager(store);
    const installed = await manager.install(manifest, new Map([["worker.js", replacement]]));
    const operationDirectory = (await readdir(join(root, "published")))[0]!;
    await writeFile(join(root, "published", operationDirectory, stagingFileEntryName("worker.js")), Buffer.from("corrupt"));
    await manager.repair("plugin:repair", "1.0.0", manifest, new Map([["worker.js", replacement]]));
    const repairDirectory = (await readdir(join(root, "published"))).find((entry) => entry !== operationDirectory)!;
    expect(await readFile(join(root, "published", repairDirectory, stagingFileEntryName("worker.js")))).toEqual(replacement);
    expect(installed.state).toBe("installed");
  });

  it("reconstructs plugin lifecycle state after manager restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase6-plugin-restart-"));
    const bytes = Buffer.from("restartable-worker");
    const manifest = { package_format_id: "core:plugin", package_format_version: 1, plugin_id: "plugin:restart", plugin_version: "1.0.0", package_files: [{ normalized_relative_path: "worker.js", content_digest: digestBytes(bytes), byte_length: bytes.length, executable: true }] };
    const first = new PluginPackageLifecycleManager(new FileStagingStore(root));
    const installed = await first.install(manifest, new Map([["worker.js", bytes]]));
    first.activate("plugin:restart", "1.0.0", installed.package_digest);
    const active = new PluginPackageLifecycleManager(new FileStagingStore(root));
    expect(active.list()).toEqual([expect.objectContaining({ plugin_id: "plugin:restart", state: "active" })]);
    await active.recover();
    await active.repair("plugin:restart", "1.0.0", manifest, new Map([["worker.js", bytes]]));
    const removed = active.remove("plugin:restart", "1.0.0");
    const afterRemoval = new PluginPackageLifecycleManager(new FileStagingStore(root));
    expect(afterRemoval.list()).toEqual([removed]);
  });

  it("persists staged operation state and cleans interrupted files after a new instance recovers", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase6-staging-"));
    const first = new FileStagingStore(root);
    await first.stage("operation", [{ path: "blob", bytes: new Uint8Array([1]) }]);
    await first.markInterrupted("operation");
    const second = new FileStagingStore(root);
    expect(await second.recoverAll()).toEqual([{ operation_id: "operation", state: "discarded", removed_paths: ["blob"] }]);
    await expect(stat(join(root, "staging", "operation"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(root, "catalog.json"), "utf8"))).toEqual({ operations: {} });
    await mkdir(join(root, "published", "orphan"), { recursive: true });
    await writeFile(join(root, "published", "orphan", "blob"), new Uint8Array([1]));
    await second.recoverAll();
    await expect(stat(join(root, "published", "orphan"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("completes a filesystem publication marked durable before a crash", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase6-publish-recovery-"));
    const store = new FileStagingStore(root);
    await store.stage("operation", [{ path: "blob", bytes: new Uint8Array([2]) }]);
    await writeFile(join(root, "catalog.json"), JSON.stringify({ operations: { operation: { state: "publishing", paths: ["blob"], publication: { kind: "test", value: { record: "durable" } } } } }));
    const operationEntry = stagingOperationEntryName("operation");
    await rename(join(root, "staging", operationEntry), join(root, "published", operationEntry));
    const recovered = await new FileStagingStore(root).recoverAll();
    expect(recovered).toEqual([{ operation_id: "operation", state: "committed", removed_paths: [] }]);
    expect(await readFile(join(root, "published", operationEntry, stagingFileEntryName("blob")))).toEqual(Buffer.from([2]));
  });

  it("recovers a commit crash after atomic rename without losing publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase6-commit-recovery-"));
    const faulted = new FileStagingStore(root, { fault_injector: (point) => { if (point === "staging.commit.after_rename") throw new Error("injected-commit-fault"); } });
    await faulted.stage("commit-fault", [{ path: "blob", bytes: new Uint8Array([3]) }]);
    await expect(faulted.commit("commit-fault")).rejects.toThrow("injected-commit-fault");
    expect(await new FileStagingStore(root).recoverAll()).toEqual([{ operation_id: "commit-fault", state: "committed", removed_paths: [] }]);
    expect(await readFile(join(root, "published", stagingOperationEntryName("commit-fault"), stagingFileEntryName("blob")))).toEqual(Buffer.from([3]));
  });

  it("recovers a staged-file power loss before publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase6-stage-fault-"));
    const faulted = new FileStagingStore(root, { fault_injector: (point) => { if (point === "staging.stage.after_file_sync") throw new Error("injected-stage-fault"); } });
    await expect(faulted.stage("stage-fault", [{ path: "blob", bytes: new Uint8Array([4]) }])).rejects.toThrow("injected-stage-fault");
    expect(await new FileStagingStore(root).recoverAll()).toEqual([]);
    await expect(stat(join(root, "staging", "stage-fault"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fsyncs synchronous lifecycle state around catalog publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase6-sync-state-fault-"));
    const faulted = new FileStagingStore(root, { fault_injector_sync: (point) => { if (point === "staging.catalog.after_directory_fsync") throw new Error("injected-catalog-fault"); } });
    expect(() => faulted.persistStateSync!({ marker: "durable" })).toThrow("injected-catalog-fault");
    expect(new FileStagingStore(root).readStateSync!()).toEqual({ marker: "durable" });
  });

  it("flushes installed files instead of opening directories on Windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase6-windows-staging-"));
    const flushedFiles: string[] = [];
    const store = new FileStagingStore(root, {
      platform: "win32",
      sync_directory: () => { throw new Error("Windows must not use the POSIX directory fsync path"); },
      sync_file: (path) => { flushedFiles.push(path); },
    });

    await store.stage("operation", [{ path: "blob", bytes: new Uint8Array([5]) }]);
    await store.commit("operation");

    expect(flushedFiles).toContain(join(root, "catalog.json"));
    expect(flushedFiles).toContain(join(root, "published", stagingOperationEntryName("operation"), stagingFileEntryName("blob")));
  });

  it("uses UTF-8 byte spans and redacts PEM content without leaking multibyte secrets", () => {
    const text = "prefix TOKEN=é秘密 suffix";
    const bytes = Buffer.from(text, "utf8");
    const detections = classifySecret({ normalized_path: "config.txt", media_type: "text/plain" }, bytes);
    const detection = detections.find((item) => item.rule_code === "secret:token_assignment");
    expect(detection?.start_byte).toBe(Buffer.byteLength("prefix TOKEN=", "utf8"));
    expect(detection?.end_byte).toBe(Buffer.byteLength("prefix TOKEN=é秘密", "utf8"));
    expect(redactSnippet(text, detections, { max_characters: 100 }).text).not.toContain("é秘密");
    const pem = "-----BEGIN PRIVATE KEY-----\nsecret-bytes\n-----END PRIVATE KEY-----";
    expect(JSON.stringify(safeLogEvent({ event_code: "test", message: pem }))).not.toContain("secret-bytes");
  });

  it("enforces aggregate/time/ratio/redirect/cancellation download limits", async () => {
    const manifestBytes = Buffer.from("manifest");
    const blobBytes = Buffer.from("blob");
    const response = async (locator: string) => locator.includes("manifest") ? { status: 200, headers: {}, body: manifestBytes, compressed_byte_length: 1 } : { status: 200, headers: {}, body: blobBytes, compressed_byte_length: 1 };
    const downloader = new AdministrativeModelPackDownloader({ fetch: response });
    await expect(downloader.download({ authorized_manifest_digest: digestBytes(manifestBytes), manifest_locator: "file:///manifest", blob_locators: { [digestBytes(blobBytes)]: "file:///blob" }, limits: { max_total_bytes: 5 } })).rejects.toThrow("security:download_limit_exceeded");
    await expect(downloader.download({ authorized_manifest_digest: digestBytes(manifestBytes), manifest_locator: "file:///manifest", blob_locators: {}, limits: { max_decompression_ratio: 2 } })).rejects.toThrow("security:download_limit_exceeded");
    const redirected = new AdministrativeModelPackDownloader({ fetch: async () => ({ status: 302, headers: {}, body: new Uint8Array(), final_locator: "https://example.test/next", redirect_hops: 6 }) });
    await expect(redirected.download({ authorized_manifest_digest: digestBytes(manifestBytes), manifest_locator: "https://example.test/start", blob_locators: {}, limits: { max_redirect_hops: 5 } })).rejects.toThrow("security:download_redirect_forbidden");
    let now = 0;
    await expect(downloader.download({ authorized_manifest_digest: digestBytes(manifestBytes), manifest_locator: "file:///manifest", blob_locators: {}, limits: { max_time_ms: 1 }, clock: () => (now += 2) })).rejects.toThrow("security:download_time_exceeded");
    let cleaned = false;
    const controller = new AbortController();
    controller.abort();
    await expect(downloader.download({ authorized_manifest_digest: digestBytes(manifestBytes), manifest_locator: "file:///manifest", blob_locators: {}, signal: controller.signal, cleanup: async () => { cleaned = true; } })).rejects.toThrow("security:download_cancelled");
    expect(cleaned).toBe(true);
    await expect(downloader.download({ authorized_manifest_digest: digestBytes(manifestBytes), manifest_locator: "file:///manifest", blob_locators: {}, limits: { max_concurrency: 0 } })).rejects.toThrow("security:download_concurrency_exceeded");
  });

  it("times out hanging transports and never exceeds the configured concurrency", async () => {
    let active = 0;
    let peak = 0;
    const pending = new Set<AbortSignal>();
    const transport = { fetch: (locator: string, options: { signal?: AbortSignal; max_bytes: number }) => new Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>((resolve, reject) => {
      active += 1;
      peak = Math.max(peak, active);
      if (options.signal) pending.add(options.signal);
      const finish = (): void => { active -= 1; if (options.signal) pending.delete(options.signal); };
      options.signal?.addEventListener("abort", () => { finish(); reject(new Error(`aborted:${locator}`)); }, { once: true });
      if (locator.includes("manifest")) { finish(); resolve({ status: 200, headers: {}, body: manifestBytes }); }
      else setTimeout(() => { finish(); reject(new Error(`transport-hung:${locator}`)); }, 20);
    }) };
    const manifestBytes = Buffer.from("manifest");
    let cleaned = false;
    const downloader = new AdministrativeModelPackDownloader(transport);
    await expect(downloader.download({ authorized_manifest_digest: digestBytes(manifestBytes), manifest_locator: "https://example.test/manifest", blob_locators: { [digestBytes(Buffer.from("one"))]: "https://example.test/one", [digestBytes(Buffer.from("two"))]: "https://example.test/two" }, limits: { max_time_ms: 5, max_concurrency: 1 }, cleanup: async () => { cleaned = true; } })).rejects.toThrow("security:download_time_exceeded");
    expect(peak).toBeLessThanOrEqual(1);
    expect(pending.size).toBe(0);
    expect(cleaned).toBe(true);
  });

  it("applies ordered inclusion rules and Git-ignore negation predictably", async () => {
    const observation = { normalized_path: "src/keep.ts", is_symlink: false, is_directory: false, byte_length: 1, media_type: "text/plain" };
    expect(evaluateInclusion(observation, { include: [], exclude: [], allow_external_root: false, ordered_rules: [{ kind: "exclude", pattern: "src/**" }, { kind: "include", pattern: "src/keep.ts" }] }, { enabled: false, patterns: [] }).included).toBe(true);
    expect(evaluateInclusion(observation, { include: [], exclude: [], allow_external_root: false, ordered_rules: [{ kind: "include", pattern: "src/keep.ts" }, { kind: "exclude", pattern: "src/**" }] }, { enabled: false, patterns: [] }).included).toBe(false);
    expect(evaluateInclusion({ ...observation, normalized_path: "nested/file.log" }, { include: [], exclude: [], allow_external_root: false }, { enabled: true, patterns: ["*.log", "!nested/file.log"] }).included).toBe(true);
    expect(normalizeWorkspacePath("/workspace", "src/e\u0301.ts")).toBe("src/é.ts");
    const root = await mkdtemp(join(tmpdir(), "urdira-phase6-external-root-"));
    const allowed = await mkdtemp(join(tmpdir(), "urdira-phase6-allowed-"));
    const outside = await mkdtemp(join(tmpdir(), "urdira-phase6-outside-"));
    await symlink(outside, join(allowed, "escape"));
    await expect(resolveSafePath(root, join(allowed, "escape", "file"), [allowed])).rejects.toThrow("security:path_outside_workspace");
    assertAllowedExternalRoot(allowed.replaceAll("/", "\\"), [allowed]);
    expect(() => assertAllowedExternalRoot(outside, [allowed])).toThrow("security:external_root_forbidden");
  });

  it("redacts absolute and traversal paths from safe logs", () => {
    const log = safeLogEvent({ event_code: "test", message: "read ../outside/secret.txt and /Users/alice/private.txt path=/Users/alice/private.txt AWS_SECRET_ACCESS_KEY=abc Authorization: Bearer bearer-token" , artifact_path: "../outside/secret.txt" });
    expect(JSON.stringify(log)).not.toContain("../outside/secret.txt");
    expect(JSON.stringify(log)).not.toContain("/Users/alice/private.txt");
    expect(JSON.stringify(log)).not.toContain("AWS_SECRET_ACCESS_KEY=abc");
    expect(JSON.stringify(log)).not.toContain("Authorization: Bearer bearer-token");
  });

  it("passes only the remaining aggregate byte allowance to concurrent transports", async () => {
    const manifestBytes = Buffer.from("manifest");
    const blobOne = Buffer.from("one");
    const blobTwo = Buffer.from("two");
    const allowances: number[] = [];
    const transport = {
      fetch: async (locator: string, options: { max_bytes: number }) => {
        allowances.push(options.max_bytes);
        const body = locator.includes("manifest") ? manifestBytes : locator.endsWith("one") ? blobOne : blobTwo;
        return { status: 200, headers: {}, body, compressed_byte_length: body.byteLength };
      },
    };
    const downloader = new AdministrativeModelPackDownloader(transport);
    await expect(downloader.download({
      authorized_manifest_digest: digestBytes(manifestBytes),
      manifest_locator: "file:///manifest",
      blob_locators: { [digestBytes(blobOne)]: "file:///one", [digestBytes(blobTwo)]: "file:///two" },
      limits: { max_total_bytes: 10, max_concurrency: 2 },
    })).rejects.toThrow("security:download_limit_exceeded");
    expect(allowances[0]).toBe(10);
    expect(allowances.slice(1).reduce((sum, allowance) => sum + allowance, 0)).toBeLessThanOrEqual(2);
  });
});
