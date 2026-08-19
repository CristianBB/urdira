import { canonicalBytes, computeDigest, decodeCanonical, digestBytes } from "@urdira/canonical";
import { coreSchemaDefinitions, validateSchemaValue, type CanonicalIRSchemaDefinition, type ModelAssetManifest, type ModelPackManifest, type ModelPackRuntimeConfiguration, type ResolvedModelPackRuntimeBuild, type TokenizerAssetManifest } from "@urdira/contracts";
import { SecurityError, issue, type SecurityIssue } from "./errors.js";
import { InMemoryStagingStore, type StagingStore } from "./staging.js";

export interface ModelPackInspectionLimits { readonly max_asset_bytes?: number; readonly max_total_bytes?: number; readonly compressed_total_bytes?: number; readonly max_compression_ratio?: number; readonly configuration_schemas?: readonly CanonicalIRSchemaDefinition[]; }
export interface ModelPackInspection { readonly valid: boolean; readonly issues: readonly SecurityIssue[]; readonly computed_manifest_digest?: string; readonly operational_asset_digests?: readonly string[]; readonly profile_operational_asset_digests?: Readonly<Record<string, readonly string[]>>; readonly profile_portable_digests?: Readonly<Record<string, string>>; }
export interface ModelPackInspectionOptions { readonly configuration_schemas?: readonly CanonicalIRSchemaDefinition[]; }
export type ModelPackManifestInput = ModelPackManifest;

const manifestKeys = new Set(["manifest_schema_version", "model_pack_id", "model_pack_version", "embedding_profiles", "assets", "required_runtime_components", "manifest_digest"]);
const profileKeys = new Set(["embedding_profile_id", "definition_revision", "schema_version", "description", "embedding_contract_version", "model_provider_id", "model_id", "model_revision", "model_identity_digest", "tokenizer_id", "tokenizer_revision", "tokenizer_digest", "document_input_contract", "query_input_contract", "segmentation_contract", "maximum_document_tokens", "maximum_query_tokens", "dimensions", "element_type", "vector_encoding", "normalization", "distance_metric", "language_support", "supported_query_classes", "supported_content_classes", "agent_guidance", "lifecycle_state", "deprecated_since", "retired_since", "replacement_embedding_profile_id", "profile_digest"]);
const requirementKeys = new Set(["embedding_profile_id", "runtime_role", "component_id", "component_version", "behavior_digest", "contract_version"]);
const assetKeys = new Set(["content_digest", "decoded_byte_length", "media_type", "semantic_role"]);
const semanticRoles = new Set(["model_manifest", "model_weight", "model_configuration", "tokenizer_manifest", "tokenizer_data", "input_template", "segmentation_configuration", "generator_configuration", "license", "provenance", "evaluation"]);
const runtimeRoles = ["document_renderer", "query_renderer", "segmenter", "generator"] as const;
const operationalRoles = new Set(["model_manifest", "model_weight", "model_configuration", "tokenizer_manifest", "tokenizer_data", "input_template", "segmentation_configuration", "generator_configuration"]);
const assetRoleOrder = ["model_manifest", "model_weight", "model_configuration", "tokenizer_manifest", "tokenizer_data", "input_template", "segmentation_configuration", "generator_configuration", "license", "provenance", "evaluation"] as const;
const runtimeRoleOrder = ["document_renderer", "query_renderer", "segmenter", "generator"] as const;
const requiredAssetMedia: Readonly<Record<string, string>> = {
  model_manifest: "application/vnd.urdira.model-asset-manifest+cbor",
  model_weight: "application/octet-stream",
  model_configuration: "application/octet-stream",
  tokenizer_manifest: "application/vnd.urdira.tokenizer-asset-manifest+cbor",
  tokenizer_data: "application/octet-stream",
  input_template: "text/plain",
  segmentation_configuration: "application/vnd.urdira.model-pack-runtime-configuration+cbor",
  generator_configuration: "application/vnd.urdira.model-pack-runtime-configuration+cbor",
};
const profileElementTypes = new Set(["float32", "float16", "int8", "uint8"]);
const profileVectorEncodings: Readonly<Record<string, string>> = { float32: "float32-le", float16: "float16-le", int8: "int8", uint8: "uint8" };
const profileNormalizations = new Set(["none", "l2"]);
const profileDistanceMetrics = new Set(["cosine", "dot_product", "euclidean"]);
const profileLanguageSupport = new Set(["explicit", "all_text"]);
const profileQueryClasses = new Set(["natural_text", "identifier", "source_code", "mixed"]);
const profileContentClasses = new Set(["source_code", "prose", "configuration", "markup", "data", "unknown_text"]);
const profileLifecycleStates = new Set(["active", "deprecated", "retired"]);

function ownKeys(value: unknown): readonly string[] { return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : []; }
function hasOnlyKeys(value: unknown, allowed: ReadonlySet<string>): boolean { return ownKeys(value).every((key) => allowed.has(key)); }
function digest(value: string): boolean { return /^sha256:[0-9a-f]{64}$/u.test(value); }
function identifier(value: string): boolean { return /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*(?::[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)?$/u.test(value); }
function semver(value: string): boolean { return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value); }
function recordValue(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validAssetMember(value: unknown): value is ModelPackManifest["assets"][number] {
  return recordValue(value) && typeof value["content_digest"] === "string" && typeof value["decoded_byte_length"] === "number" && typeof value["media_type"] === "string" && typeof value["semantic_role"] === "string";
}
function validProfileMember(value: unknown): value is ModelPackManifest["embedding_profiles"][number] { return recordValue(value); }
function validRequirementMember(value: unknown): value is ModelPackManifest["required_runtime_components"][number] { return recordValue(value); }
function nonEmptyText(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function positiveIntegerText(value: unknown): value is string { return typeof value === "string" && /^[1-9]\d*$/u.test(value); }

function validProfileShape(value: unknown): boolean {
  if (!recordValue(value) || !hasOnlyKeys(value, profileKeys)) return false;
  const integerFields = ["definition_revision", "schema_version", "dimensions"];
  const textFields = ["embedding_profile_id", "description", "embedding_contract_version", "model_provider_id", "model_id", "model_revision", "tokenizer_id", "tokenizer_revision", "document_input_contract", "query_input_contract", "segmentation_contract", "element_type", "vector_encoding", "normalization", "distance_metric", "language_support", "supported_query_classes", "supported_content_classes", "agent_guidance", "lifecycle_state"];
  if (!integerFields.every((field) => positiveInteger(value[field]))) return false;
  if (!textFields.every((field) => nonEmptyText(value[field]))) return false;
  if (!["embedding_profile_id", "model_provider_id", "model_id", "tokenizer_id"].every((field) => identifier(value[field] as string))) return false;
  if (!positiveIntegerText(value["embedding_contract_version"])) return false;
  if (!positiveIntegerText(value["maximum_document_tokens"]) || !positiveIntegerText(value["maximum_query_tokens"])) return false;
  if (!digest(value["model_identity_digest"] as string) || !digest(value["tokenizer_digest"] as string) || !digest(value["profile_digest"] as string)) return false;
  if (!profileElementTypes.has(value["element_type"] as string) || profileVectorEncodings[value["element_type"] as string] !== value["vector_encoding"] || !profileNormalizations.has(value["normalization"] as string) || !profileDistanceMetrics.has(value["distance_metric"] as string)) return false;
  if (!profileLanguageSupport.has(value["language_support"] as string) || !profileQueryClasses.has(value["supported_query_classes"] as string) || !profileContentClasses.has(value["supported_content_classes"] as string) || !profileLifecycleStates.has(value["lifecycle_state"] as string)) return false;
  const lifecycle = value["lifecycle_state"] as string;
  const deprecatedSince = value["deprecated_since"];
  const retiredSince = value["retired_since"];
  const replacement = value["replacement_embedding_profile_id"];
  if (lifecycle === "active" && (deprecatedSince !== undefined || retiredSince !== undefined || replacement !== undefined)) return false;
  if (lifecycle === "deprecated" && (!nonEmptyText(deprecatedSince) || retiredSince !== undefined)) return false;
  if (lifecycle === "retired" && (!nonEmptyText(deprecatedSince) || !nonEmptyText(retiredSince))) return false;
  if ((lifecycle === "deprecated" || lifecycle === "retired") && replacement !== undefined && !identifier(replacement as string)) return false;
  return ["deprecated_since", "retired_since"].every((field) => value[field] === undefined || nonEmptyText(value[field]));
}

function validRequirementShape(value: unknown): boolean {
  return recordValue(value) && hasOnlyKeys(value, requirementKeys) && identifier(value["embedding_profile_id"] as string) && runtimeRoles.includes(value["runtime_role"] as typeof runtimeRoles[number]) && identifier(value["component_id"] as string) && semver(value["component_version"] as string) && digest(value["behavior_digest"] as string) && (positiveInteger(value["contract_version"]) || positiveIntegerText(value["contract_version"]));
}

function validRuntimeConfigurationShape(value: unknown): boolean {
  return recordValue(value) && hasOnlyKeys(value, new Set(["schema_version", "embedding_profile_id", "runtime_role", "component_id", "component_version", "contract_version", "configuration_schema_id", "configuration", "configuration_digest"])) && positiveInteger(value["schema_version"]) && identifier(value["embedding_profile_id"] as string) && (value["runtime_role"] === "segmenter" || value["runtime_role"] === "generator") && identifier(value["component_id"] as string) && semver(value["component_version"] as string) && (positiveInteger(value["contract_version"]) || positiveIntegerText(value["contract_version"])) && nonEmptyText(value["configuration_schema_id"]) && value["configuration"] instanceof Uint8Array && digest(value["configuration_digest"] as string);
}

function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

function profileDigest(profile: ModelPackManifest["embedding_profiles"][number]): string {
  return digestBytes(canonicalBytes({
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
}

function normalizedManifest(manifest: ModelPackManifestInput): ModelPackManifestInput {
  const profiles = [...manifest.embedding_profiles].sort((left, right) => compareText(left.embedding_profile_id, right.embedding_profile_id));
  const assets = [...manifest.assets].sort((left, right) => {
    const roleDifference = assetRoleOrder.indexOf(left.semantic_role as typeof assetRoleOrder[number]) - assetRoleOrder.indexOf(right.semantic_role as typeof assetRoleOrder[number]);
    return roleDifference || compareText(left.content_digest, right.content_digest) || compareText(left.media_type, right.media_type) || left.decoded_byte_length - right.decoded_byte_length;
  });
  const requirements = [...manifest.required_runtime_components].sort((left, right) => {
    const profileDifference = compareText(left.embedding_profile_id, right.embedding_profile_id);
    const roleDifference = runtimeRoleOrder.indexOf(left.runtime_role as typeof runtimeRoleOrder[number]) - runtimeRoleOrder.indexOf(right.runtime_role as typeof runtimeRoleOrder[number]);
    return profileDifference || roleDifference || compareText(left.component_id, right.component_id);
  });
  return { ...manifest, embedding_profiles: profiles, assets, required_runtime_components: requirements };
}

function manifestDigest(manifest: ModelPackManifestInput): string {
  const normalized = normalizedManifest(manifest);
  const { manifest_digest: _manifestDigest, ...withoutDigest } = normalized;
  return digestBytes(canonicalBytes(withoutDigest));
}

function runtimeConfigurationDigest(configuration: ModelPackRuntimeConfiguration): string {
  const { configuration_digest: _configurationDigest, ...withoutDigest } = configuration;
  return digestBytes(canonicalBytes(withoutDigest));
}

function validateTemplateText(text: string): boolean {
  if (!text || /(?:https?|file|ftp):\/\//iu.test(text) || /(?:^|[\s'"`])(?:\.\.?\/|\/|[A-Za-z]:[\\/])/u.test(text) || /(?:\b(?:include|import|source|exec|command|shell|readfile|load)\b|\$\(|\$\{|`|<%|%>)/iu.test(text)) return false;
  const placeholders = [...text.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/gu)];
  if (placeholders.length === 0 || placeholders.some((match) => match[1] !== "text")) return false;
  const remainder = text.replace(/\{\{[a-z][a-z0-9_]*\}\}/gu, "");
  return !/[{}]/u.test(remainder);
}

function schemaFor(name: string, options: ModelPackInspectionOptions): CanonicalIRSchemaDefinition | undefined {
  return [...(options.configuration_schemas ?? []), ...coreSchemaDefinitions].find((schema) => schema.schema_id === name && schema.schema_version === 1);
}

function decodeTyped<T>(bytes: Uint8Array, schemaName: string, options: ModelPackInspectionOptions, issues: SecurityIssue[], label: string): T | undefined {
  try {
    const value = decodeCanonical(bytes);
    const schema = schemaFor(schemaName, options);
    if (!schema) { issues.push(issue("security:model_runtime_configuration_invalid", `No closed schema is registered for ${label}.`)); return undefined; }
    validateSchemaValue(schema, value, { schemas: [...(options.configuration_schemas ?? []), ...coreSchemaDefinitions] });
    const encoded = canonicalBytes(value);
    if (encoded.length === bytes.length && encoded.every((byte, index) => byte === bytes[index])) return value as T;
    issues.push(issue("security:model_closure_reference_invalid", `${label} is not canonically encoded.`));
  } catch { issues.push(issue("security:model_closure_reference_invalid", `${label} is not a valid typed canonical asset.`)); }
  return undefined;
}

function addReference(graph: Map<string, readonly string[]>, declared: ReadonlySet<string>, origin: string, references: readonly string[], expectedRoles: ReadonlySet<string>, roles: ReadonlyMap<string, ReadonlySet<string>>, issues: SecurityIssue[]): void {
  graph.set(origin, [...(graph.get(origin) ?? []), ...references]);
  const seen = new Set<string>();
  for (const target of references) {
    if (!digest(target) || !declared.has(target)) issues.push(issue("security:model_closure_reference_missing", `Declarative asset reference ${target} is not a declared same-pack asset.`));
    if (seen.has(target)) issues.push(issue("security:model_closure_reference_invalid", `Declarative asset reference ${target} is duplicated.`));
    seen.add(target);
    if (declared.has(target) && ![...(roles.get(target) ?? [])].some((role) => expectedRoles.has(role))) issues.push(issue("security:model_closure_reference_invalid", `Declarative asset reference ${target} has an incompatible semantic role.`));
  }
}

function validateTypedClosure(manifest: ModelPackManifestInput, blobs: ReadonlyMap<string, Uint8Array>, options: ModelPackInspectionOptions, issues: SecurityIssue[]): { readonly runtimeConfigurations: readonly ModelPackRuntimeConfiguration[]; readonly operationalRoots: readonly string[]; readonly profileRoots: Readonly<Record<string, readonly string[]>> } {
  const assets = manifest.assets.filter(validAssetMember);
  const profiles = manifest.embedding_profiles.filter(validProfileMember);
  const declared = new Set(assets.map((asset) => asset.content_digest));
  const roles = new Map<string, Set<string>>();
  for (const asset of assets) (roles.get(asset.content_digest) ?? (roles.set(asset.content_digest, new Set()), roles.get(asset.content_digest)!)).add(asset.semantic_role);
  const graph = new Map<string, readonly string[]>();
  const modelManifests: Array<{ assetDigest: string; value: ModelAssetManifest }> = [];
  const tokenizerManifests: Array<{ assetDigest: string; value: TokenizerAssetManifest }> = [];
  const runtimeConfigurations: ModelPackRuntimeConfiguration[] = [];
  const templateLogicalDigests = new Map<string, { readonly logical_digest: string; readonly text: string }>();
  for (const asset of assets) {
    const bytes = blobs.get(asset.content_digest);
    if (!bytes) continue;
    if (asset.semantic_role === "model_manifest") {
      const value = decodeTyped<ModelAssetManifest>(bytes, "core:ModelAssetManifest", options, issues, `Model manifest ${asset.content_digest}`);
      if (!value) continue;
      const { model_identity_digest: _digest, ...identity } = value;
      if (digestBytes(canonicalBytes(identity)) !== value.model_identity_digest) issues.push(issue("security:model_manifest_digest_mismatch", `Model identity digest ${asset.content_digest} is invalid.`));
      if (value.weight_asset_digests.length === 0) issues.push(issue("security:model_closure_reference_invalid", `Model manifest ${asset.content_digest} has no weight shards.`));
      addReference(graph, declared, asset.content_digest, value.configuration_asset_digests, new Set(["model_configuration"]), roles, issues);
      addReference(graph, declared, asset.content_digest, value.weight_asset_digests, new Set(["model_weight"]), roles, issues);
      modelManifests.push({ assetDigest: asset.content_digest, value });
    } else if (asset.semantic_role === "tokenizer_manifest") {
      const value = decodeTyped<TokenizerAssetManifest>(bytes, "core:TokenizerAssetManifest", options, issues, `Tokenizer manifest ${asset.content_digest}`);
      if (!value) continue;
      const { tokenizer_digest: _digest, ...identity } = value;
      if (digestBytes(canonicalBytes(identity)) !== value.tokenizer_digest) issues.push(issue("security:model_manifest_digest_mismatch", `Tokenizer identity digest ${asset.content_digest} is invalid.`));
      if (value.tokenizer_data_asset_digests.length === 0) issues.push(issue("security:model_closure_reference_invalid", `Tokenizer manifest ${asset.content_digest} has no tokenizer data.`));
      const references = [...value.configuration_asset_digests, ...value.tokenizer_data_asset_digests];
      if (new Set(value.configuration_asset_digests).size !== value.configuration_asset_digests.length || new Set(value.tokenizer_data_asset_digests).size !== value.tokenizer_data_asset_digests.length || value.configuration_asset_digests.some((digestValue) => value.tokenizer_data_asset_digests.includes(digestValue))) issues.push(issue("security:model_closure_reference_invalid", `Tokenizer manifest ${asset.content_digest} has overlapping or duplicate closure lists.`));
      addReference(graph, declared, asset.content_digest, references, new Set(["tokenizer_data"]), roles, issues);
      tokenizerManifests.push({ assetDigest: asset.content_digest, value });
    } else if (asset.semantic_role === "segmentation_configuration" || asset.semantic_role === "generator_configuration") {
      const value = decodeTyped<ModelPackRuntimeConfiguration>(bytes, "core:ModelPackRuntimeConfiguration", options, issues, `Runtime configuration ${asset.content_digest}`);
      if (value) {
        if (!validRuntimeConfigurationShape(value)) { issues.push(issue("security:model_runtime_configuration_invalid", `Runtime configuration ${asset.content_digest} has an invalid closed shape.`)); continue; }
        if ((value.runtime_role === "segmenter" && asset.semantic_role !== "segmentation_configuration") || (value.runtime_role === "generator" && asset.semantic_role !== "generator_configuration")) issues.push(issue("security:model_runtime_configuration_invalid", `Runtime configuration ${asset.content_digest} has the wrong semantic role.`));
        try { if (runtimeConfigurationDigest(value) !== value.configuration_digest) issues.push(issue("security:model_runtime_configuration_invalid", `Runtime configuration ${asset.content_digest} has an unexpected digest.`)); } catch { issues.push(issue("security:model_runtime_configuration_invalid", `Runtime configuration ${asset.content_digest} is not canonically encodable.`)); }
        runtimeConfigurations.push(value);
      } else issues.push(issue("security:model_runtime_configuration_invalid", `Runtime configuration ${asset.content_digest} is not a complete typed configuration asset.`));
    } else if (asset.semantic_role === "input_template") {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        templateLogicalDigests.set(asset.content_digest, { logical_digest: computeDigest("core:embedding_template_digest", "core:embedding_template", 1, "core:Bytes", 1, bytes), text });
      } catch { issues.push(issue("security:model_closure_reference_invalid", `Input template ${asset.content_digest} is not strict UTF-8.`)); }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (assetDigest: string): void => {
    if (visiting.has(assetDigest)) { issues.push(issue("security:model_closure_cycle", `Model asset closure contains a cycle at ${assetDigest}.`)); return; }
    if (visited.has(assetDigest)) return;
    visiting.add(assetDigest);
    for (const target of graph.get(assetDigest) ?? []) if (graph.has(target)) visit(target);
    visiting.delete(assetDigest);
    visited.add(assetDigest);
  };
  for (const assetDigest of graph.keys()) visit(assetDigest);
  const operationalRoots = new Set<string>();
  const profileRoots: Record<string, readonly string[]> = {};
  for (const profile of profiles) {
    const model = modelManifests.find((candidate) => candidate.value.model_identity_digest === profile.model_identity_digest);
    const tokenizer = tokenizerManifests.find((candidate) => candidate.value.tokenizer_digest === profile.tokenizer_digest);
    if (!model) issues.push(issue("security:model_closure_reference_missing", `Profile ${profile.embedding_profile_id} has no matching model manifest closure.`));
    if (!tokenizer) issues.push(issue("security:model_closure_reference_missing", `Profile ${profile.embedding_profile_id} has no matching tokenizer manifest closure.`));
    if (model && (model.value.model_provider_id !== profile.model_provider_id || model.value.model_id !== profile.model_id || model.value.model_revision !== profile.model_revision)) issues.push(issue("security:model_closure_reference_invalid", `Profile ${profile.embedding_profile_id} model coordinates do not match its model manifest closure.`));
    if (tokenizer && (tokenizer.value.tokenizer_id !== profile.tokenizer_id || tokenizer.value.tokenizer_revision !== profile.tokenizer_revision)) issues.push(issue("security:model_closure_reference_invalid", `Profile ${profile.embedding_profile_id} tokenizer coordinates do not match its tokenizer manifest closure.`));
    const profileRootSet = new Set<string>();
    const closureVisited = new Set<string>();
    const closureVisiting = new Set<string>();
    const addClosure = (root: string): void => {
      if (![...(roles.get(root) ?? [])].some((role) => operationalRoles.has(role))) return;
      operationalRoots.add(root);
      profileRootSet.add(root);
      if (closureVisiting.has(root) || closureVisited.has(root)) return;
      closureVisiting.add(root);
      for (const target of graph.get(root) ?? []) addClosure(target);
      closureVisiting.delete(root);
      closureVisited.add(root);
    };
    if (model) addClosure(model.assetDigest);
    if (tokenizer) addClosure(tokenizer.assetDigest);
    for (const contract of [profile.document_input_contract, profile.query_input_contract]) {
      const template = [...templateLogicalDigests.entries()].find(([, value]) => value.logical_digest === contract);
      if (!template) issues.push(issue("security:model_closure_reference_missing", `Profile ${profile.embedding_profile_id} references a missing input template.`));
      else {
        if (!validateTemplateText(template[1].text)) issues.push(issue("security:model_template_invalid", `Input template ${template[0]} is outside the closed renderer vocabulary.`));
        addClosure(template[0]);
      }
    }
    for (const configuration of runtimeConfigurations.filter((candidate) => candidate.embedding_profile_id === profile.embedding_profile_id)) {
      const asset = assets.find((candidate) => candidate.semantic_role === (configuration.runtime_role === "segmenter" ? "segmentation_configuration" : "generator_configuration") && blobs.has(candidate.content_digest));
      if (asset && operationalRoles.has(asset.semantic_role)) { operationalRoots.add(asset.content_digest); profileRootSet.add(asset.content_digest); }
    }
    profileRoots[profile.embedding_profile_id] = [...profileRootSet].sort();
  }
  const referencedTemplates = new Set(Object.values(profileRoots).flatMap((roots) => roots.filter((root) => roles.get(root)?.has("input_template"))));
  for (const asset of assets.filter((candidate) => candidate.semantic_role === "input_template")) if (!referencedTemplates.has(asset.content_digest)) issues.push(issue("security:model_closure_reference_invalid", `Input template ${asset.content_digest} is not referenced by an embedding profile.`));
  return { runtimeConfigurations, operationalRoots: [...operationalRoots].sort(), profileRoots };
}

export function inspectModelPack(manifest: ModelPackManifestInput, blobs: ReadonlyMap<string, Uint8Array>, limits: ModelPackInspectionLimits = {}): ModelPackInspection {
  const issues: SecurityIssue[] = [];
  const candidate = manifest as unknown;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate) || !Array.isArray((candidate as { embedding_profiles?: unknown }).embedding_profiles) || !Array.isArray((candidate as { assets?: unknown }).assets) || !Array.isArray((candidate as { required_runtime_components?: unknown }).required_runtime_components)) return { valid: false, issues: [issue("security:model_manifest_invalid", "Model-pack manifest is not a complete closed manifest.")] };
  const assets = manifest.assets.filter(validAssetMember);
  const profiles = manifest.embedding_profiles.filter(validProfileMember);
  const requirements = manifest.required_runtime_components.filter(validRequirementMember);
  if (assets.length !== manifest.assets.length) issues.push(issue("security:model_manifest_invalid", "Model-pack manifest contains a malformed asset member."));
  if (profiles.length !== manifest.embedding_profiles.length) issues.push(issue("security:model_manifest_invalid", "Model-pack manifest contains a malformed embedding profile member."));
  if (requirements.length !== manifest.required_runtime_components.length) issues.push(issue("security:model_manifest_invalid", "Model-pack manifest contains a malformed runtime requirement member."));
  const options: ModelPackInspectionOptions = limits;
  if (!hasOnlyKeys(manifest, manifestKeys)) issues.push(issue("security:model_manifest_unknown_field", "Model-pack manifest contains a field outside the closed seven-field schema."));
  if (!semver(manifest.model_pack_version) || !identifier(manifest.model_pack_id) || !manifest.model_pack_id.includes(":") || manifest.manifest_schema_version !== "1") issues.push(issue("security:model_manifest_invalid", "Model-pack identity or schema version is invalid."));
  if (profiles.length === 0) issues.push(issue("security:model_manifest_invalid", "A model pack must declare at least one embedding profile."));
  const assetDigests = new Set<string>();
  const assetDeclarations = new Map<string, { readonly decoded_byte_length: number; readonly media_type: string; readonly semantic_roles: Set<string> }>();
  let total = 0;
  for (const asset of assets) {
    if (!hasOnlyKeys(asset, assetKeys)) issues.push(issue("security:model_manifest_invalid", `Model asset ${asset.content_digest} has an unknown field.`));
    if (!semanticRoles.has(asset.semantic_role)) issues.push(issue("security:model_semantic_role_invalid", `Model asset role ${asset.semantic_role} is not registered.`));
    if (!digest(asset.content_digest) || !Number.isSafeInteger(asset.decoded_byte_length) || asset.decoded_byte_length < 0 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(asset.media_type)) issues.push(issue("security:model_manifest_invalid", `Model asset ${asset.content_digest} has invalid typed metadata.`));
    if (requiredAssetMedia[asset.semantic_role] !== undefined && asset.media_type !== requiredAssetMedia[asset.semantic_role]) issues.push(issue("security:model_media_type_invalid", `Model asset ${asset.content_digest} has the wrong media type for ${asset.semantic_role}.`));
    if (asset.media_type === "application/javascript" || /(?:wasm|x-executable|x-sharedlib|x-dosexec)/iu.test(asset.media_type)) issues.push(issue("security:model_media_type_forbidden", `Model asset media type ${asset.media_type} is executable or invalid.`));
    const prior = assetDeclarations.get(asset.content_digest);
    if (prior) {
      if (prior.decoded_byte_length !== asset.decoded_byte_length || prior.media_type !== asset.media_type) issues.push(issue("security:model_manifest_invalid", `Model asset ${asset.content_digest} has conflicting declarations.`));
      if (prior.semantic_roles.has(asset.semantic_role)) issues.push(issue("security:model_manifest_invalid", `Model asset ${asset.content_digest} is duplicated for semantic role ${asset.semantic_role}.`));
      prior.semantic_roles.add(asset.semantic_role);
    } else assetDeclarations.set(asset.content_digest, { decoded_byte_length: asset.decoded_byte_length, media_type: asset.media_type, semantic_roles: new Set([asset.semantic_role]) });
    assetDigests.add(asset.content_digest);
    const bytes = blobs.get(asset.content_digest);
    if (!bytes) { issues.push(issue("security:model_asset_digest_mismatch", `Model asset ${asset.content_digest} is missing.`)); continue; }
    if (!prior) total += bytes.byteLength;
    if (limits.max_asset_bytes !== undefined && asset.decoded_byte_length > limits.max_asset_bytes) issues.push(issue("security:download_limit_exceeded", "Model asset exceeds the configured byte limit."));
    if (bytes.byteLength !== asset.decoded_byte_length) issues.push(issue("security:model_asset_length_mismatch", `Model asset ${asset.content_digest} has an unexpected decoded length.`));
    if (digestBytes(bytes) !== asset.content_digest) issues.push(issue("security:model_asset_digest_mismatch", `Model asset ${asset.content_digest} has unexpected bytes.`));
  }
  for (const digestValue of blobs.keys()) if (!assetDigests.has(digestValue)) issues.push(issue("security:model_undeclared_asset", `Blob ${digestValue} is not declared by the model-pack manifest.`));
  if (limits.max_total_bytes !== undefined && total > limits.max_total_bytes) issues.push(issue("security:download_limit_exceeded", "Model pack exceeds the total byte limit."));
  if (limits.compressed_total_bytes !== undefined && limits.max_compression_ratio !== undefined && limits.compressed_total_bytes > 0 && total / limits.compressed_total_bytes > limits.max_compression_ratio) issues.push(issue("security:download_limit_exceeded", "Model pack exceeds the decompression ratio limit."));
  const profileIds = new Set<string>();
  for (const profile of profiles) {
    if (!validProfileShape(profile)) issues.push(issue("security:model_manifest_invalid", `Embedding profile ${String(profile.embedding_profile_id)} is not a complete typed profile.`));
    if (!hasOnlyKeys(profile, profileKeys)) issues.push(issue("security:model_manifest_invalid", `Embedding profile ${profile.embedding_profile_id} has an unknown field.`));
    if (profileIds.has(profile.embedding_profile_id)) issues.push(issue("security:model_profile_collision", `Embedding profile ${profile.embedding_profile_id} is duplicated.`));
    profileIds.add(profile.embedding_profile_id);
    try { if (profileDigest(profile) !== profile.profile_digest) issues.push(issue("security:model_manifest_digest_mismatch", `Embedding profile ${profile.embedding_profile_id} has an unexpected digest.`)); } catch { issues.push(issue("security:model_manifest_invalid", `Embedding profile ${profile.embedding_profile_id} is not canonically encodable.`)); }
  }
  for (const requirement of requirements) {
    if (!validRequirementShape(requirement)) issues.push(issue("security:model_manifest_invalid", `Runtime requirement for ${String(requirement.embedding_profile_id)}/${String(requirement.runtime_role)} is not a complete typed requirement.`));
    const contractVersion = requirement.contract_version;
    const validContractVersion = (typeof contractVersion === "number" && Number.isSafeInteger(contractVersion) && contractVersion > 0) || (typeof contractVersion === "string" && /^[1-9]\d*$/u.test(contractVersion));
    if (!hasOnlyKeys(requirement, requirementKeys) || !identifier(requirement.embedding_profile_id) || !identifier(requirement.component_id) || !semver(requirement.component_version) || !digest(requirement.behavior_digest) || !validContractVersion) issues.push(issue("security:model_manifest_invalid", `Runtime requirement for ${requirement.embedding_profile_id}/${requirement.runtime_role} is not a complete typed requirement.`));
  }
  const typedClosure = validateTypedClosure(manifest, blobs, options, issues);
  for (const profileId of profileIds) {
    const profile = profiles.find((candidate) => candidate.embedding_profile_id === profileId);
    if (!profile) continue;
    const profileRequirements = requirements.filter((requirement) => requirement.embedding_profile_id === profileId);
    for (const rendererRole of ["document_renderer", "query_renderer"] as const) {
      const renderer = profileRequirements.find((requirement) => requirement.runtime_role === rendererRole);
      if (!renderer || String(renderer.contract_version) !== String(profile.embedding_contract_version)) issues.push(issue("security:model_template_invalid", `Renderer requirement for ${profileId}/${rendererRole} is incompatible with the profile template contract.`));
    }
    if (profileRequirements.length !== runtimeRoles.length) issues.push(issue("security:model_manifest_invalid", `Embedding profile ${profileId} must declare exactly four runtime requirements.`));
    const roleCounts = new Map<string, number>();
    for (const requirement of profileRequirements) {
      if (!(runtimeRoles as readonly string[]).includes(requirement.runtime_role)) issues.push(issue("security:model_runtime_role_invalid", `Runtime role ${requirement.runtime_role} is not supported.`));
      roleCounts.set(requirement.runtime_role, (roleCounts.get(requirement.runtime_role) ?? 0) + 1);
    }
    for (const role of runtimeRoles) {
      const count = roleCounts.get(role) ?? 0;
      if (count === 0) issues.push(issue("security:model_manifest_invalid", `Embedding profile ${profileId} is missing runtime role ${role}.`));
      if (count > 1) issues.push(issue("security:model_runtime_role_duplicate", `Embedding profile ${profileId} declares runtime role ${role} more than once.`));
    }
    const allConfigurations = typedClosure.runtimeConfigurations.filter((configuration) => configuration.embedding_profile_id === profileId);
    const configurations = allConfigurations.filter((configuration) => configuration.runtime_role === "segmenter" || configuration.runtime_role === "generator");
    if (configurations.length !== 2) issues.push(issue("security:model_manifest_invalid", `Embedding profile ${profileId} must declare exactly two runtime configurations.`));
    for (const role of ["segmenter", "generator"] as const) {
      const matching = configurations.filter((configuration) => configuration.runtime_role === role);
      if (matching.length === 0) issues.push(issue("security:model_runtime_configuration_missing", `Embedding profile ${profileId} is missing ${role} runtime configuration.`));
      if (matching.length > 1) issues.push(issue("security:model_runtime_role_duplicate", `Embedding profile ${profileId} declares ${role} runtime configuration more than once.`));
      const configuration = matching[0];
      const requirement = profileRequirements.find((candidate) => candidate.runtime_role === role);
      if (configuration && requirement && (configuration.component_id !== requirement.component_id || configuration.component_version !== requirement.component_version || String(configuration.contract_version) !== String(requirement.contract_version))) issues.push(issue("security:model_runtime_configuration_invalid", `Runtime configuration for ${profileId}/${role} does not match its requirement.`));
      if (configuration && String(configuration.contract_version) !== String(profile.embedding_contract_version)) issues.push(issue("security:model_runtime_configuration_invalid", `Runtime configuration for ${profileId}/${role} does not match the profile contract version.`));
      if (requirement && String(requirement.contract_version) !== String(profile.embedding_contract_version)) issues.push(issue("security:model_runtime_configuration_invalid", `Runtime requirement for ${profileId}/${role} does not match the profile contract version.`));
      if (configuration && role === "segmenter" && configuration.configuration_digest !== profile.segmentation_contract) issues.push(issue("security:model_runtime_configuration_invalid", `Segmenter configuration for ${profileId} does not match the profile segmentation contract.`));
      if (configuration) {
        const configurationSchema = schemaFor(configuration.configuration_schema_id, options);
        if (!configurationSchema) issues.push(issue("security:model_runtime_configuration_invalid", `Runtime configuration for ${profileId}/${role} selects an unknown closed configuration schema.`));
        else {
          try { validateSchemaValue(configurationSchema, decodeCanonical(configuration.configuration), { schemas: [...(options.configuration_schemas ?? []), ...coreSchemaDefinitions] }); } catch { issues.push(issue("security:model_runtime_configuration_invalid", `Runtime configuration for ${profileId}/${role} contains an untyped configuration value.`)); }
        }
      }
    }
  }
  const profilePortableDigests: Record<string, string> = {};
  for (const profile of profiles) {
    try {
      profilePortableDigests[profile.embedding_profile_id] = digestBytes(canonicalBytes({
        schema_version: 1,
        embedding_profile_id: profile.embedding_profile_id,
        embedding_profile_digest: profile.profile_digest,
        runtime_requirements: requirements.filter((requirement) => requirement.embedding_profile_id === profile.embedding_profile_id).sort((left, right) => runtimeRoleOrder.indexOf(left.runtime_role as typeof runtimeRoleOrder[number]) - runtimeRoleOrder.indexOf(right.runtime_role as typeof runtimeRoleOrder[number])),
        runtime_configurations: typedClosure.runtimeConfigurations.filter((configuration) => configuration.embedding_profile_id === profile.embedding_profile_id).sort((left, right) => runtimeRoleOrder.indexOf(left.runtime_role as typeof runtimeRoleOrder[number]) - runtimeRoleOrder.indexOf(right.runtime_role as typeof runtimeRoleOrder[number])),
        operational_asset_digests: [...(typedClosure.profileRoots[profile.embedding_profile_id] ?? [])].sort(compareText),
      }));
    } catch { issues.push(issue("security:model_manifest_invalid", `Embedding profile ${String(profile.embedding_profile_id)} is not canonically encodable.`)); }
  }
  let computedManifestDigest: string | undefined;
  try { computedManifestDigest = manifestDigest(manifest); if (computedManifestDigest !== manifest.manifest_digest) issues.push(issue("security:model_manifest_digest_mismatch", "Model manifest digest does not match its canonical bytes.")); } catch { issues.push(issue("security:model_manifest_invalid", "Model manifest is not canonically encodable.")); }
  return { valid: issues.length === 0, issues, ...(computedManifestDigest ? { computed_manifest_digest: computedManifestDigest } : {}), operational_asset_digests: typedClosure.operationalRoots, profile_operational_asset_digests: typedClosure.profileRoots, profile_portable_digests: profilePortableDigests };
}

export interface ModelPackInstallationRecord { readonly model_pack_installation_id: string; readonly model_pack_id: string; readonly model_pack_version: string; readonly manifest_digest: string; readonly state: "active" | "removed"; readonly rooted_asset_digests: readonly string[]; readonly retained_binding_digests: readonly string[]; }

interface DurableBlobRoot { readonly operation_id: string; readonly path: string; }
interface DurableBinding { readonly binding_digest: string; readonly profile_id: string; readonly builds: readonly ResolvedModelPackRuntimeBuild[]; readonly roots: readonly string[]; }
interface ModelInstallationPublicationValue { readonly operation_id: string; readonly coordinate: string; readonly manifest_digest: string; readonly record: ModelPackInstallationRecord; readonly manifest: ModelPackManifestInput; readonly occurrence: number; readonly profile_digests: Readonly<Record<string, string>>; readonly profile_roots: Readonly<Record<string, readonly string[]>>; readonly blob_roots: Readonly<Record<string, DurableBlobRoot>>; }
interface ModelRepairPublicationValue { readonly operation_id: string; readonly installationId: string; readonly occurrence: number; readonly digests: readonly string[]; readonly blob_roots: Readonly<Record<string, DurableBlobRoot>>; readonly binding_roots: readonly string[]; readonly bindings: readonly DurableBinding[]; }
interface ModelLifecycleState { readonly state_version: 1; readonly occurrence: number; readonly reservations: Readonly<Record<string, string>>; readonly profile_reservations: Readonly<Record<string, string>>; readonly installations: readonly { readonly record: ModelPackInstallationRecord; readonly manifest: ModelPackManifestInput; readonly profile_roots: Readonly<Record<string, readonly string[]>>; readonly profile_portable_digests: Readonly<Record<string, string>>; readonly binding_roots: readonly string[]; readonly blob_roots: Readonly<Record<string, DurableBlobRoot>>; readonly bindings: readonly DurableBinding[] }[]; }

function durableBlobRoots(value: unknown): value is Readonly<Record<string, DurableBlobRoot>> {
  if (!recordValue(value)) return false;
  return Object.values(value).every((root) => recordValue(root) && typeof root["operation_id"] === "string" && typeof root["path"] === "string");
}

export class ModelPackLifecycleManager {
  private readonly reservations = new Map<string, string>();
  private readonly records = new Map<string, ModelPackInstallationRecord>();
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly manifests = new Map<string, ModelPackManifestInput>();
  private readonly profileRoots = new Map<string, Readonly<Record<string, readonly string[]>>>();
  private readonly profilePortableDigests = new Map<string, Readonly<Record<string, string>>>();
  private readonly profileReservations = new Map<string, string>();
  private readonly bindingRoots = new Map<string, Set<string>>();
  private readonly blobRoots = new Map<string, Readonly<Record<string, DurableBlobRoot>>>();
  private readonly bindings = new Map<string, readonly DurableBinding[]>();
  private readonly staging: StagingStore;
  private occurrence = 0;

  constructor(staging: StagingStore = new InMemoryStagingStore()) { this.staging = staging; this.restoreState(this.staging.readStateSync?.()); }

  private stateSnapshot(): ModelLifecycleState {
    return {
      state_version: 1,
      occurrence: this.occurrence,
      reservations: Object.fromEntries(this.reservations),
      profile_reservations: Object.fromEntries(this.profileReservations),
      installations: [...this.records].map(([installationId, record]) => ({
        record,
        manifest: this.manifests.get(installationId)!,
        profile_roots: this.profileRoots.get(installationId) ?? {},
        profile_portable_digests: this.profilePortableDigests.get(installationId) ?? {},
        binding_roots: [...(this.bindingRoots.get(installationId) ?? [])].sort(),
        blob_roots: this.blobRoots.get(installationId) ?? {},
        bindings: this.bindings.get(installationId) ?? [],
      })),
    };
  }

  private persistState(): void { this.staging.persistStateSync?.(this.stateSnapshot()); }

  private async hydrateDurableBlobs(): Promise<void> {
    for (const roots of this.blobRoots.values()) for (const [digestValue, root] of Object.entries(roots)) {
      if (typeof root?.operation_id !== "string" || typeof root.path !== "string") continue;
      const bytes = await this.staging.readPublishedFile?.(root.operation_id, root.path);
      if (bytes) this.blobs.set(digestValue, bytes);
    }
  }

  private applyInstallationPublication(value: Partial<ModelInstallationPublicationValue>): boolean {
    if (!recordValue(value.record) || !recordValue(value.manifest) || typeof value.coordinate !== "string" || typeof value.occurrence !== "number" || !recordValue(value.profile_digests) || !recordValue(value.profile_roots)) return false;
    const record = value.record as ModelPackInstallationRecord;
    if (typeof record.model_pack_installation_id !== "string" || typeof record.manifest_digest !== "string") return false;
    const installationId = record.model_pack_installation_id;
    const existing = this.records.get(installationId);
    this.reservations.set(value.coordinate, record.manifest_digest);
    this.occurrence = Math.max(this.occurrence, value.occurrence);
    if (existing) {
      const currentRoots = this.blobRoots.get(installationId) ?? {};
      if (durableBlobRoots(value.blob_roots)) this.blobRoots.set(installationId, { ...value.blob_roots, ...currentRoots });
      return false;
    }
    this.records.set(installationId, record);
    this.manifests.set(installationId, value.manifest as ModelPackManifestInput);
    this.profileRoots.set(installationId, value.profile_roots);
    this.profilePortableDigests.set(installationId, value.profile_digests);
    this.bindingRoots.set(installationId, new Set());
    this.blobRoots.set(installationId, durableBlobRoots(value.blob_roots) ? value.blob_roots : {});
    this.bindings.set(installationId, []);
    for (const [profileId, profileDigest] of Object.entries(value.profile_digests)) this.profileReservations.set(profileId, profileDigest);
    return true;
  }

  private applyRepairPublication(value: Partial<ModelRepairPublicationValue>): boolean {
    if (typeof value.installationId !== "string" || typeof value.occurrence !== "number" || !durableBlobRoots(value.blob_roots)) return false;
    if (!this.records.has(value.installationId)) return false;
    const currentRoots = this.blobRoots.get(value.installationId) ?? {};
    this.blobRoots.set(value.installationId, { ...currentRoots, ...value.blob_roots });
    if (Array.isArray(value.binding_roots)) this.bindingRoots.set(value.installationId, new Set(value.binding_roots.filter((root): root is string => typeof root === "string")));
    if (Array.isArray(value.bindings)) this.bindings.set(value.installationId, value.bindings);
    this.occurrence = Math.max(this.occurrence, value.occurrence);
    return true;
  }

  private restoreState(value: unknown): boolean {
    if (!recordValue(value) || value["state_version"] !== 1 || !Array.isArray(value["installations"]) || !recordValue(value["reservations"]) || !recordValue(value["profile_reservations"]) || !positiveInteger(value["occurrence"])) return false;
    this.reservations.clear();
    this.records.clear();
    this.blobs.clear();
    this.manifests.clear();
    this.profileRoots.clear();
    this.profilePortableDigests.clear();
    this.profileReservations.clear();
    this.bindingRoots.clear();
    this.blobRoots.clear();
    this.bindings.clear();
    this.occurrence = value["occurrence"];
    for (const [coordinate, manifestDigest] of Object.entries(value["reservations"])) if (typeof manifestDigest === "string") this.reservations.set(coordinate, manifestDigest);
    for (const [profileId, profileDigest] of Object.entries(value["profile_reservations"])) if (typeof profileDigest === "string") this.profileReservations.set(profileId, profileDigest);
    for (const entry of value["installations"]) {
      if (!recordValue(entry) || !recordValue(entry["record"]) || !recordValue(entry["manifest"]) || !recordValue(entry["profile_roots"]) || !recordValue(entry["profile_portable_digests"]) || !Array.isArray(entry["binding_roots"])) return false;
      const record = entry["record"] as unknown as ModelPackInstallationRecord;
      if (typeof record.model_pack_installation_id !== "string" || !Array.isArray(record.rooted_asset_digests) || !Array.isArray(record.retained_binding_digests)) return false;
      this.records.set(record.model_pack_installation_id, record);
      this.manifests.set(record.model_pack_installation_id, entry["manifest"] as unknown as ModelPackManifestInput);
      this.profileRoots.set(record.model_pack_installation_id, entry["profile_roots"] as Readonly<Record<string, readonly string[]>>);
      this.profilePortableDigests.set(record.model_pack_installation_id, entry["profile_portable_digests"] as Readonly<Record<string, string>>);
      this.bindingRoots.set(record.model_pack_installation_id, new Set(entry["binding_roots"].filter((root): root is string => typeof root === "string")));
      this.blobRoots.set(record.model_pack_installation_id, recordValue(entry["blob_roots"]) ? entry["blob_roots"] as Readonly<Record<string, DurableBlobRoot>> : {});
      this.bindings.set(record.model_pack_installation_id, Array.isArray(entry["bindings"]) ? entry["bindings"] as readonly DurableBinding[] : []);
    }
    return true;
  }

  async recover(): Promise<void> {
    await this.staging.recoverAll?.();
    const publications = await this.staging.listPublications?.() ?? [];
    this.reservations.clear();
    this.records.clear();
    this.blobs.clear();
    this.manifests.clear();
    this.profileRoots.clear();
    this.profilePortableDigests.clear();
    this.profileReservations.clear();
    this.bindingRoots.clear();
    this.blobRoots.clear();
    this.bindings.clear();
    this.occurrence = 0;
    const stateRestored = this.restoreState(await this.staging.readState?.());
    const orderedPublications = [...publications].sort((left, right) => {
      const leftValue = recordValue(left.value) && typeof left.value["occurrence"] === "number" ? left.value["occurrence"] as number : Number.MAX_SAFE_INTEGER;
      const rightValue = recordValue(right.value) && typeof right.value["occurrence"] === "number" ? right.value["occurrence"] as number : Number.MAX_SAFE_INTEGER;
      return leftValue - rightValue;
    });
    let replayed = false;
    for (const publication of orderedPublications) {
      if (!recordValue(publication.value)) continue;
      if (publication.kind === "model-pack-installation") replayed = this.applyInstallationPublication(publication.value as Partial<ModelInstallationPublicationValue>) || replayed;
      else if (publication.kind === "model-pack-repair") replayed = this.applyRepairPublication(publication.value as Partial<ModelRepairPublicationValue>) || replayed;
    }
    await this.hydrateDurableBlobs();
    if (stateRestored || replayed) this.persistState();
  }

  async install(manifest: ModelPackManifestInput, blobs: ReadonlyMap<string, Uint8Array>, limits: ModelPackInspectionLimits = {}): Promise<ModelPackInstallationRecord> {
    const inspection = inspectModelPack(manifest, blobs, limits);
    if (!inspection.valid) throw new SecurityError(inspection.issues[0]?.code ?? "security:model_manifest_invalid", inspection.issues[0]?.message ?? "Model-pack inspection failed.");
    const canonicalManifest = { ...normalizedManifest(manifest), manifest_digest: inspection.computed_manifest_digest ?? manifest.manifest_digest };
    const coordinate = `${canonicalManifest.model_pack_id}@${canonicalManifest.model_pack_version}`;
    const reserved = this.reservations.get(coordinate);
    if (reserved && reserved !== canonicalManifest.manifest_digest) throw new SecurityError("security:model_coordinate_collision", `Model-pack coordinate ${coordinate} is reserved for another manifest digest.`);
    const existing = [...this.records.values()].find((record) => record.model_pack_id === canonicalManifest.model_pack_id && record.model_pack_version === canonicalManifest.model_pack_version && record.manifest_digest === canonicalManifest.manifest_digest && record.state === "active");
    if (existing) return existing;
    const profileDigests = inspection.profile_portable_digests ?? {};
    for (const [profileId, profileDigest] of Object.entries(profileDigests)) {
      const reservedProfile = this.profileReservations.get(profileId);
      if (reservedProfile && reservedProfile !== profileDigest) throw new SecurityError("security:model_profile_collision", `Embedding profile ${profileId} is reserved for another portable definition.`);
    }
    const operationId = `model-pack:${canonicalManifest.manifest_digest}:${this.occurrence + 1}`;
    await this.staging.stage(operationId, [...blobs].map(([path, bytes]) => ({ path, bytes })));
    const blobRoots = Object.fromEntries([...blobs.keys()].map((digestValue) => [digestValue, { operation_id: operationId, path: digestValue }]));
    const nextOccurrence = this.occurrence + 1;
    const record: ModelPackInstallationRecord = { model_pack_installation_id: `installation:${canonicalManifest.manifest_digest}:${nextOccurrence}`, model_pack_id: canonicalManifest.model_pack_id, model_pack_version: canonicalManifest.model_pack_version, manifest_digest: canonicalManifest.manifest_digest, state: "active", rooted_asset_digests: canonicalManifest.assets.map((asset) => asset.content_digest).sort(compareText), retained_binding_digests: [] };
    const publication = { kind: "model-pack-installation", value: { operation_id: operationId, coordinate, manifest_digest: canonicalManifest.manifest_digest, record, manifest: canonicalManifest, occurrence: nextOccurrence, profile_digests: profileDigests, profile_roots: inspection.profile_operational_asset_digests ?? {}, blob_roots: blobRoots } satisfies ModelInstallationPublicationValue };
    if (this.staging.publish) await this.staging.publish(operationId, publication); else await this.staging.commit(operationId);
    this.reservations.set(coordinate, canonicalManifest.manifest_digest);
    for (const [digest, bytes] of blobs) this.blobs.set(digest, new Uint8Array(bytes));
    this.occurrence = nextOccurrence;
    this.records.set(record.model_pack_installation_id, record);
    this.manifests.set(record.model_pack_installation_id, canonicalManifest);
    this.profileRoots.set(record.model_pack_installation_id, inspection.profile_operational_asset_digests ?? {});
    this.profilePortableDigests.set(record.model_pack_installation_id, profileDigests);
    this.bindingRoots.set(record.model_pack_installation_id, new Set());
    this.blobRoots.set(record.model_pack_installation_id, blobRoots);
    this.bindings.set(record.model_pack_installation_id, []);
    for (const [profileId, profileDigest] of Object.entries(profileDigests)) this.profileReservations.set(profileId, profileDigest);
    this.persistState();
    return record;
  }

  activate(installationId: string, profileId: string, builds: readonly ResolvedModelPackRuntimeBuild[]): ModelPackInstallationRecord {
    const record = this.records.get(installationId);
    const manifest = this.manifests.get(installationId);
    if (!record || !manifest || record.state !== "active") throw new SecurityError("security:model_activation_invalid", `Model-pack installation ${installationId} is unavailable.`);
    const profile = manifest.embedding_profiles.find((candidate) => candidate.embedding_profile_id === profileId);
    const requirements = manifest.required_runtime_components.filter((requirement) => requirement.embedding_profile_id === profileId);
    if (!profile || requirements.length !== 4 || builds.length !== 4 || new Set(builds.map((build) => build.runtime_role)).size !== 4) throw new SecurityError("security:model_activation_invalid", `Activation requires one declared profile and exactly four runtime builds.`);
    for (const requirement of requirements) {
      const build = builds.find((candidate) => candidate.runtime_role === requirement.runtime_role);
      if (!build || build.embedding_profile_id !== profileId || build.component_id !== requirement.component_id || build.component_version !== requirement.component_version || build.behavior_digest !== requirement.behavior_digest || String(build.contract_version) !== String(requirement.contract_version) || !build.runtime_component_build_id || !build.implementation_digest) throw new SecurityError("security:model_activation_invalid", `Runtime build for ${profileId}/${requirement.runtime_role} is incompatible.`);
    }
    const portableProfileDigest = this.profilePortableDigests.get(installationId)?.[profileId];
    if (!portableProfileDigest) throw new SecurityError("security:model_activation_invalid", `Portable profile identity for ${profileId} is unavailable.`);
    const resolvedBuilds = [...builds].sort((left, right) => runtimeRoleOrder.indexOf(left.runtime_role as typeof runtimeRoleOrder[number]) - runtimeRoleOrder.indexOf(right.runtime_role as typeof runtimeRoleOrder[number]));
    const binding = digestBytes(canonicalBytes({ schema_version: 1, portable_binding_digest: portableProfileDigest, resolved_runtime_builds: resolvedBuilds }));
    const roots = this.bindingRoots.get(installationId) ?? new Set<string>();
    for (const root of this.profileRoots.get(installationId)?.[profileId] ?? []) roots.add(root);
    this.bindingRoots.set(installationId, roots);
    const bindingState: DurableBinding = { binding_digest: binding, profile_id: profileId, builds: resolvedBuilds, roots: [...(this.profileRoots.get(installationId)?.[profileId] ?? [])].sort(compareText) };
    this.bindings.set(installationId, [...(this.bindings.get(installationId) ?? []).filter((candidate) => candidate.binding_digest !== binding), bindingState]);
    const rootedAssets = new Set(record.rooted_asset_digests);
    for (const root of roots) rootedAssets.add(root);
    const updated = { ...record, rooted_asset_digests: [...rootedAssets].sort(compareText), retained_binding_digests: [...new Set([...record.retained_binding_digests, binding])].sort() };
    this.records.set(installationId, updated);
    this.persistState();
    return updated;
  }

  remove(installationId: string): ModelPackInstallationRecord {
    const record = this.records.get(installationId);
    if (!record) throw new SecurityError("security:model_manifest_invalid", `Model-pack installation ${installationId} is not installed.`);
    const retainedRoots = this.bindingRoots.get(installationId) ?? new Set<string>();
    const updated = { ...record, state: "removed" as const, rooted_asset_digests: record.retained_binding_digests.length > 0 ? [...retainedRoots].sort() : [] };
    this.records.set(installationId, updated);
    this.persistState();
    return updated;
  }

  async repair(installationId: string, blobs: ReadonlyMap<string, Uint8Array>): Promise<ModelPackInstallationRecord> {
    const record = this.records.get(installationId);
    if (!record) throw new SecurityError("security:model_manifest_invalid", `Model-pack installation ${installationId} is not installed.`);
    const manifest = this.manifests.get(installationId);
    const declared = new Set(manifest?.assets.map((asset) => asset.content_digest) ?? []);
    for (const [digest, bytes] of blobs) {
      if (!declared.has(digest)) throw new SecurityError("security:model_closure_reference_invalid", `Repair blob ${digest} is not declared by the installed manifest.`);
      if (digestBytes(bytes) !== digest) throw new SecurityError("security:model_asset_digest_mismatch", `Repair bytes do not match ${digest}.`);
    }
    const operationId = `model-repair-${installationId}-${++this.occurrence}`;
    await this.staging.stage(operationId, [...blobs].map(([digest, bytes]) => ({ path: digest, bytes })));
    const repairedRoots = Object.fromEntries([...blobs.keys()].map((digestValue) => [digestValue, { operation_id: operationId, path: digestValue }])) satisfies Readonly<Record<string, DurableBlobRoot>>;
    const repairPublication = { kind: "model-pack-repair", value: { operation_id: operationId, installationId, occurrence: this.occurrence, digests: [...blobs.keys()].sort(), blob_roots: repairedRoots, binding_roots: [...(this.bindingRoots.get(installationId) ?? [])].sort(compareText), bindings: this.bindings.get(installationId) ?? [] } satisfies ModelRepairPublicationValue };
    if (this.staging.publish) await this.staging.publish(operationId, repairPublication); else await this.staging.commit(operationId);
    for (const [digest, bytes] of blobs) this.blobs.set(digest, new Uint8Array(bytes));
    this.blobRoots.set(installationId, { ...(this.blobRoots.get(installationId) ?? {}), ...repairedRoots });
    this.persistState();
    return record;
  }

  list(): readonly ModelPackInstallationRecord[] { return [...this.records.values()].sort((left, right) => left.model_pack_installation_id.localeCompare(right.model_pack_installation_id)); }
}
