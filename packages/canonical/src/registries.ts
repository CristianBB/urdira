import {
  canonicalSchemaRegistry as contractSchemaRegistry,
  coreSchemaDefinitions,
  comparatorRegistry as contractComparatorRegistry,
  type CanonicalEncodingErrorCodeDefinition,
} from "@urdira/contracts";
import type { CanonicalEncodingPhase } from "./errors.js";
import {
  documentedDigestContractRows,
  documentedDigestFieldContracts,
  documentedDigestRecipeCoordinates,
  phase3DigestFieldContractRows,
  type DocumentedDigestContractRow,
} from "./documented-digest-contracts.js";
import type { DigestLocatorBinding } from "@urdira/contracts";
import {
  digestPayloadSchemaDefinitions,
  payloadBindingFor,
  payloadSchemaIdFor,
  recipeTargetSchemaId,
  verifiedInputSchemaFor,
} from "./digest-payload-schemas.js";

export { documentedDigestContractRows, documentedDigestFieldContracts, documentedDigestRecipeCoordinates, phase3DigestFieldContractRows } from "./documented-digest-contracts.js";

export const canonicalSchemaRegistry = contractSchemaRegistry;
export const canonicalComparatorRegistry = contractComparatorRegistry;
export const canonicalSchemaDefinitions = coreSchemaDefinitions;
export const canonicalComparatorDefinitions = canonicalComparatorRegistry;
export { digestPayloadSchemaDefinitions } from "./digest-payload-schemas.js";

export const hashAlgorithmRegistry = Object.freeze([{
  hash_algorithm: "sha256",
  definition_revision: 1,
  schema_version: 1,
  description: "SHA-256 as specified by FIPS 180-4",
  digest_byte_length: 32,
  specification_uri: "https://csrc.nist.gov/pubs/fips/180-4/upd1/final",
  lifecycle_state: "active" as const,
}]);

const terminalDigestDomainNames = [
  "artifact_content", "artifact_analysis_metadata", "source_state", "analyzer_implementation", "runtime_component_behavior", "runtime_component_implementation", "analysis_configuration", "query_configuration", "generator_configuration", "source_provider_configuration", "configuration_layer", "plugin_package", "model_identity", "tokenizer_identity", "embedding_template", "model_pack_runtime_configuration", "embedding_input", "embedding_vector_bytes", "query_plan", "response_budget", "core_registry_manifest",
];
export const digestDomainRegistry = Object.freeze([
  ...new Set([
    ...terminalDigestDomainNames.map((name) => `core:${name}`),
    ...documentedDigestRecipeCoordinates.map((coordinate) => coordinate.digest_domain),
  ]),
].map((digest_domain) => {
  const recipes = [...new Set(documentedDigestRecipeCoordinates.filter((coordinate) => coordinate.digest_domain === digest_domain).map((coordinate) => coordinate.digest_recipe_id))].toSorted();
  if (recipes.length === 0) throw new Error(`Digest domain ${digest_domain} has no authoritative recipe definition`);
  return { digest_domain, definition_revision: 1, schema_version: 1, description: `Digest space governed by recipes: ${recipes.join(", ")}`, lifecycle_state: "active" as const };
}));

const errorEntries = [
  ["uce:trailing_data", ["decode"]],
  ["uce:non_canonical_encoding", ["decode"]],
  ["uce:forbidden_cbor_feature", ["decode"]],
  ["uce:duplicate_map_key", ["decode"]],
  ["uce:invalid_utf8", ["decode"]],
  ["uce:invalid_unicode_scalar", ["normalize"]],
  ["uce:unsupported_encoding_version", ["decode", "recipe_validation", "verify"]],
  ["uce:unsupported_hash_algorithm", ["recipe_validation", "hash", "verify"]],
  ["uce:unknown_schema", ["schema_validation", "verify"]],
  ["uce:unsupported_schema_version", ["schema_validation", "verify"]],
  ["uce:schema_validation_failed", ["schema_validation"]],
  ["uce:unknown_digest_domain", ["recipe_validation", "verify"]],
  ["uce:unknown_canonical_comparator", ["schema_validation", "recipe_validation", "verify"]],
  ["uce:unsupported_canonical_comparator_version", ["schema_validation", "recipe_validation", "verify"]],
  ["uce:unknown_digest_recipe", ["recipe_validation", "verify"]],
  ["uce:unsupported_digest_recipe_version", ["recipe_validation", "verify"]],
  ["uce:digest_recipe_cycle", ["recipe_validation"]],
  ["uce:digest_binding_invalid", ["recipe_validation"]],
  ["uce:unknown_digest_reference", ["recipe_validation", "verify"]],
  ["uce:digest_reference_invalid", ["recipe_validation"]],
  ["uce:unknown_external_verification_contract", ["recipe_validation", "verify"]],
  ["uce:unsupported_external_verification_contract_version", ["recipe_validation", "verify"]],
  ["uce:numeric_value_out_of_range", ["normalize", "schema_validation"]],
  ["uce:digest_mismatch", ["verify"]],
  ["uce:resource_limit_exceeded", ["decode", "normalize", "schema_validation", "recipe_validation", "hash", "verify"]],
] as readonly [string, readonly CanonicalEncodingPhase[]][];

const errorDescriptions: Readonly<Record<string, string>> = {
  "uce:trailing_data": "A valid root CBOR item ends before the supplied byte sequence ends.",
  "uce:non_canonical_encoding": "The input is valid within the UCE data model but uses a non-minimal integer, length, tag, float width, or incorrect deterministic map-key order.",
  "uce:forbidden_cbor_feature": "The input uses an indefinite length, unknown tag, shared reference, embedded CBOR, forbidden simple value, non-finite float, or another CBOR feature excluded by UCE v1.",
  "uce:duplicate_map_key": "One map contains the same decoded key more than once.",
  "uce:invalid_utf8": "A CBOR text string contains malformed, overlong, truncated, or otherwise invalid UTF-8 bytes.",
  "uce:invalid_unicode_scalar": "A public or in-memory text value contains a lone surrogate or another value that is not a Unicode scalar.",
  "uce:unsupported_encoding_version": "The digest envelope or retained contract selects a UCE version the engine cannot interpret losslessly.",
  "uce:unsupported_hash_algorithm": "A recipe or digest selects a hash algorithm unsupported by the active engine contract.",
  "uce:unknown_schema": "No schema with the requested exact `schema_id` exists in the pinned registry snapshot.",
  "uce:unsupported_schema_version": "The schema identifier exists but its requested version is unavailable in the pinned registry snapshot or decoder set.",
  "uce:schema_validation_failed": "A logical value violates its selected closed schema after public normalization.",
  "uce:unknown_digest_domain": "A recipe selects a digest domain absent from the pinned registry snapshot.",
  "uce:unknown_canonical_comparator": "A schema or ordered set selects a comparator lineage absent from the pinned registry snapshot.",
  "uce:unsupported_canonical_comparator_version": "The comparator lineage exists but the requested immutable ordering version is unavailable.",
  "uce:unknown_digest_recipe": "No recipe with the requested exact identifier exists in the pinned registry snapshot.",
  "uce:unsupported_digest_recipe_version": "The recipe identifier exists but the requested immutable version is unavailable.",
  "uce:digest_recipe_cycle": "The complete candidate recipe graph contains a direct or indirect `referenced_digest` cycle.",
  "uce:digest_binding_invalid": "A binding reads the target digest, writes a payload field twice, omits a required payload field, selects an invalid source path, or contradicts its selected value mode.",
  "uce:unknown_digest_reference": "The selected target digest field has no exact `DigestReferenceDefinition` in the pinned registry snapshot.",
  "uce:digest_reference_invalid": "A digest reference is ambiguous, cannot locate its authoritative model, fails its external verifier contract, forms a cycle, or does not terminate at the declared computation recipe.",
  "uce:unknown_external_verification_contract": "An external-asset reference selects a verifier lineage absent from the pinned registry snapshot.",
  "uce:unsupported_external_verification_contract_version": "The verifier lineage exists but the requested immutable contract version or retained implementation is unavailable.",
  "uce:numeric_value_out_of_range": "A number is non-finite, exceeds the selected logical type or schema bounds, has a forbidden decimal representation, or cannot preserve its required scale.",
  "uce:digest_mismatch": "Recomputing the selected recipe over verified logical input produces a digest different from the supplied or stored value.",
  "uce:resource_limit_exceeded": "Decoding, normalization, ordering, hashing, or verification would exceed an explicit configured safety limit before the value can be accepted.",
};

const authoritativeErrorDetailSchemas: Readonly<Record<string, string>> = {
  "uce:trailing_data": "core:trailing_data_details",
  "uce:non_canonical_encoding": "core:non_canonical_encoding_details",
  "uce:forbidden_cbor_feature": "core:forbidden_cbor_feature_details",
  "uce:duplicate_map_key": "core:duplicate_map_key_details",
  "uce:invalid_utf8": "core:invalid_utf8_details",
  "uce:invalid_unicode_scalar": "core:invalid_unicode_scalar_details",
  "uce:unsupported_encoding_version": "core:unsupported_encoding_version_details",
  "uce:unsupported_hash_algorithm": "core:unsupported_hash_algorithm_details",
  "uce:unknown_schema": "core:unknown_schema_details",
  "uce:unsupported_schema_version": "core:unsupported_schema_version_details",
  "uce:schema_validation_failed": "core:schema_validation_failed_details",
  "uce:unknown_digest_domain": "core:unknown_digest_domain_details",
  "uce:unknown_canonical_comparator": "core:unknown_canonical_comparator_details",
  "uce:unsupported_canonical_comparator_version": "core:unsupported_canonical_comparator_version_details",
  "uce:unknown_digest_recipe": "core:unknown_digest_recipe_details",
  "uce:unsupported_digest_recipe_version": "core:unsupported_digest_recipe_version_details",
  "uce:digest_recipe_cycle": "core:digest_recipe_cycle_details",
  "uce:digest_binding_invalid": "core:digest_binding_invalid_details",
  "uce:unknown_digest_reference": "core:unknown_digest_reference_details",
  "uce:digest_reference_invalid": "core:digest_reference_invalid_details",
  "uce:unknown_external_verification_contract": "core:unknown_external_verification_contract_details",
  "uce:unsupported_external_verification_contract_version": "core:unsupported_external_verification_contract_version_details",
  "uce:numeric_value_out_of_range": "core:numeric_value_out_of_range_details",
  "uce:digest_mismatch": "core:digest_mismatch_details",
  "uce:resource_limit_exceeded": "core:resource_limit_exceeded_details",
};

export interface CanonicalEncodingErrorDetailContract {
  readonly code: string;
  readonly required_details: readonly string[];
  readonly optional_details: readonly string[];
}

const authoritativeErrorDetailRows = [
  ["uce:trailing_data", ["byte_offset"], []],
  ["uce:non_canonical_encoding", ["byte_offset", "canonicality_kind"], ["value_path"]],
  ["uce:forbidden_cbor_feature", ["byte_offset", "feature_kind"], ["value_path"]],
  ["uce:duplicate_map_key", ["byte_offset", "duplicate_key"], ["value_path"]],
  ["uce:invalid_utf8", ["byte_offset"], ["value_path"]],
  ["uce:invalid_unicode_scalar", ["value_path"], []],
  ["uce:unsupported_encoding_version", ["canonical_encoding_version", "supported_encoding_versions"], ["digest_recipe_id", "recipe_version"]],
  ["uce:unsupported_hash_algorithm", ["hash_algorithm", "supported_hash_algorithms"], ["digest_recipe_id", "recipe_version"]],
  ["uce:unknown_schema", ["schema_id", "registry_snapshot_id"], []],
  ["uce:unsupported_schema_version", ["schema_id", "schema_version", "available_schema_versions"], ["registry_snapshot_id"]],
  ["uce:schema_validation_failed", ["schema_id", "schema_version", "value_path", "validation_kind"], ["expected_type", "actual_type", "constraint_name"]],
  ["uce:unknown_digest_domain", ["digest_domain", "registry_snapshot_id"], ["digest_recipe_id", "recipe_version"]],
  ["uce:unknown_canonical_comparator", ["comparator_id", "registry_snapshot_id"], ["schema_id", "schema_version"]],
  ["uce:unsupported_canonical_comparator_version", ["comparator_id", "comparator_version", "available_comparator_versions"], ["registry_snapshot_id", "schema_id", "schema_version"]],
  ["uce:unknown_digest_recipe", ["digest_recipe_id", "registry_snapshot_id"], []],
  ["uce:unsupported_digest_recipe_version", ["digest_recipe_id", "recipe_version", "available_recipe_versions"], ["registry_snapshot_id"]],
  ["uce:digest_recipe_cycle", ["cycle_path"], ["registry_snapshot_id"]],
  ["uce:digest_binding_invalid", ["digest_recipe_id", "recipe_version", "binding_failure_kind"], ["source_path", "payload_field"]],
  ["uce:unknown_digest_reference", ["target_schema_id", "target_field", "registry_snapshot_id"], ["digest_reference_id"]],
  ["uce:digest_reference_invalid", ["digest_reference_id", "digest_reference_failure_kind"], ["target_schema_id", "target_field", "source_digest_recipe_id", "source_digest_recipe_version"]],
  ["uce:unknown_external_verification_contract", ["external_verification_contract_id", "registry_snapshot_id"], ["digest_reference_id"]],
  ["uce:unsupported_external_verification_contract_version", ["external_verification_contract_id", "external_verification_contract_version"], ["registry_snapshot_id", "digest_reference_id"]],
  ["uce:numeric_value_out_of_range", ["value_path", "numeric_type", "range_failure_kind"], ["minimum", "maximum", "actual_value"]],
  ["uce:digest_mismatch", ["digest_recipe_id", "recipe_version", "expected_digest", "actual_digest"], ["value_path"]],
  ["uce:resource_limit_exceeded", ["phase", "limit_name", "configured_limit", "observed_value"], ["value_path"]],
] as const;

export const canonicalEncodingErrorDetailContracts: readonly CanonicalEncodingErrorDetailContract[] = Object.freeze(authoritativeErrorDetailRows.map(([code, required_details, optional_details]) => ({ code, required_details, optional_details })));

export const canonicalEncodingErrorCodeRegistry: readonly CanonicalEncodingErrorCodeDefinition[] = errorEntries.map(([code, phases]) => ({
  code,
  definition_revision: 1,
  schema_version: 1,
  description: errorDescriptions[code] ?? (() => { throw new Error(`Missing authoritative description for ${code}`); })(),
  allowed_phases: phases as CanonicalEncodingErrorCodeDefinition["allowed_phases"],
  details_schema: authoritativeErrorDetailSchemas[code] ?? (() => { throw new Error(`Missing authoritative details schema for ${code}`); })(),
  lifecycle_state: "active" as const,
}));

export interface DigestFieldContract {
  readonly target_field: string;
  readonly target_fields: readonly string[];
  readonly contract_kind: "computation" | "reference";
  readonly digest_recipe_id: string;
  readonly recipe_version: number;
  readonly target_schema_id: string;
  readonly target_schema_version: number;
  readonly target_schema_ids?: readonly string[];
  readonly digest_domain: string;
  readonly payload_schema_id?: string;
  readonly payload_schema_version?: number;
  readonly source_location: string;
  readonly binding_summary: string;
  readonly reference_kind?: "model" | "external_asset";
  readonly locator_bindings: readonly DigestLocatorBinding[];
  readonly verifier_contract_id?: string;
}

const documentedRecipeByTarget = new Map<string, string>();
const documentedCoordinateByRecipe = new Map<string, (typeof documentedDigestRecipeCoordinates)[number]>();
const documentedRowByTarget = new Map<string, DocumentedDigestContractRow>();
for (const coordinate of documentedDigestRecipeCoordinates) {
  const key = `${coordinate.digest_recipe_id}\u0000${coordinate.digest_domain}`;
  const existing = documentedCoordinateByRecipe.get(key);
  if (!existing || coordinate.contract_kind === "terminal_recipe") documentedCoordinateByRecipe.set(key, coordinate);
  for (const target of coordinate.target_fields) documentedRecipeByTarget.set(target, coordinate.digest_recipe_id);
}
for (const row of documentedDigestContractRows) {
  if (row[0] === "terminal_recipe") continue;
  for (const target of splitTargetFields(row[1])) documentedRowByTarget.set(target, row);
}

const externalAssetReferenceTargets = new Set([
  "RecordEnvelope.analysis_digest",
  "RecordEnvelope.analysis_configuration_digest",
  "ResolvedPlugin.package_digest",
  "ResolvedPlugin.analysis_digest",
  "PluginAnalysisChange.from_analysis_digest",
  "PluginAnalysisChange.to_analysis_digest",
  "DerivedProjectionEnvelope.generator_configuration_digest",
  "ProjectionChange.generator_configuration_digest",
  "ProjectionSetDigestEntry.generator_configuration_digest",
  "QueryEmbedding.embedding_input_digest",
  "QueryEmbedding.vector_digest",
  "FactDelta.analysis_digest",
  "FactDelta.analysis_configuration_digest",
  "SourceObservation.observed_content_hash",
  "SourceObservation.observed_metadata_digest",
  "SourceObservationDigestEntry.observed_content_hash",
  "SourceObservationDigestEntry.observed_metadata_digest",
  "SourceProviderDescribeRequest.binding_configuration_digest",
  "SourceProviderReadRequest.observed_content_hash",
  "SourceProviderReadRequest.observed_metadata_digest",
  "SourceProviderReadResult.content_hash",
  "SourceProviderReadResult.metadata_digest",
  "WorkspaceFreshnessCheckpoint.source_state_digest",
]);

const authoritativeExternalVerificationContractIds = new Map<string, string>([
  ["core:raw_artifact_content_digest", "core:raw_artifact_content_verification_contract"],
  ["core:artifact_analysis_metadata_digest", "core:artifact_analysis_metadata_verification_contract"],
  ["core:source_state_digest", "core:source_state_verification_contract"],
  ["core:analyzer_implementation_digest", "core:analyzer_implementation_verification_contract"],
  ["core:runtime_component_behavior_digest", "core:runtime_component_behavior_verification_contract"],
  ["core:runtime_component_implementation_digest", "core:runtime_component_implementation_verification_contract"],
  ["core:analysis_configuration_digest", "core:analysis_configuration_verification_contract"],
  ["core:query_configuration_digest", "core:query_configuration_verification_contract"],
  ["core:generator_configuration_digest", "core:generator_configuration_verification_contract"],
  ["core:source_provider_configuration_digest", "core:source_provider_configuration_verification_contract"],
  ["core:configuration_layer_digest", "core:configuration_layer_verification_contract"],
  ["core:plugin_package_digest", "core:plugin_package_verification_contract"],
  ["core:model_identity_digest", "core:model_identity_verification_contract"],
  ["core:tokenizer_identity_digest", "core:tokenizer_identity_verification_contract"],
  ["core:embedding_template_digest", "core:embedding_template_verification_contract"],
  ["core:model_pack_runtime_configuration_digest", "core:model_pack_runtime_configuration_verification_contract"],
  ["core:embedding_input_digest", "core:embedding_input_verification_contract"],
  ["core:embedding_vector_bytes_digest", "core:embedding_vector_bytes_verification_contract"],
  ["core:query_plan_digest", "core:query_plan_verification_contract"],
  ["core:response_budget_digest", "core:response_budget_verification_contract"],
  ["core:core_registry_manifest_digest", "core:core_registry_manifest_verification_contract"],
]);

// These paths are the structured locator coordinates transcribed from the
// approved model-reference table. The prose summary remains available on the
// contract for human semantics but never enters a public locator binding.
const authoritativeModelLocatorPaths = new Map<string, string>([
  ["SourceProviderResponseEnvelope.request_digest", "/request_id"],
  ["PresentSourceStateEntry.content_hash", "/artifact_version_id"],
  ["PresentSourceStateEntry.analysis_metadata_digest", "/artifact_version_id"],
  ["NamespaceBinding.contribution_digest", "/plugin_id"],
  ["RegistryNamespaceBindingEntry.contribution_digest", "/plugin_id"],
  ["ResolvedPlugin.declaration_digest", "/plugin_id"],
  ["ResolvedPlugin.contribution_digest", "/plugin_id"],
  ["ModelPackManifest.embedding_profiles[].profile_digest", "/embedding_profiles"],
  ["ModelPackCoordinateReservation.manifest_digest", "/model_pack_id"],
  ["ModelPackInstallation.manifest_digest", "/model_pack_id"],
  ["EmbeddingProfile.model_identity_digest", "/model_provider_id"],
  ["ModelAssetManifest.configuration_asset_digests[]", "/configuration_asset_digests"],
  ["ModelAssetManifest.weight_asset_digests[]", "/weight_asset_digests"],
  ["EmbeddingProfile.tokenizer_digest", "/tokenizer_id"],
  ["TokenizerAssetManifest.configuration_asset_digests[]", "/configuration_asset_digests"],
  ["TokenizerAssetManifest.tokenizer_data_asset_digests[]", "/tokenizer_data_asset_digests"],
  ["ModelPackRuntimeRequirement.behavior_digest", "/component_id"],
  ["RuntimeComponentBuild.behavior_digest", "/component_id"],
  ["ResolvedModelPackRuntimeBuild.behavior_digest", "/component_id"],
  ["ResolvedModelPackRuntimeBuild.implementation_digest", "/runtime_component_build_id"],
  ["EmbeddingSegmentationContract.configuration_digest", "/embedding_profile_id"],
  ["EmbeddingProfileExecutableBinding.embedding_profile_digest", "/embedding_profile_id"],
  ["EmbeddingProfileExecutableBinding.operational_asset_digests[]", "/operational_asset_digests"],
  ["ModelPackProfileSupply.portable_binding_digest", "/embedding_profile_id"],
  ["DerivedEmbeddingSegment.implementation_digest", "/runtime_component_build_id"],
  ["DerivedEmbeddingVector.implementation_digest", "/runtime_component_build_id"],
  ["DerivedEmbeddingSegment.generator_configuration_digest", "/embedding_profile_id"],
  ["DerivedEmbeddingVector.generator_configuration_digest", "/embedding_profile_id"],
  ["SemanticIndexMaterialization.generator_configuration_digest", "/embedding_profile_id"],
  ["SemanticIndexMaterialization.executable_binding_digest", "/embedding_profile_id"],
  ["QueryEmbedding.generator_configuration_digest", "/embedding_profile_id"],
  ["QueryEmbedding.executable_binding_digest", "/embedding_profile_id"],
  ["SemanticIndexBinding.generator_configuration_digest", "/embedding_profile_id"],
  ["SemanticIndexBinding.executable_binding_digest", "/embedding_profile_id"],
  ["Snapshot.source_observation_watermarks[].watermark_digest", "/source_observation_watermarks"],
  ["Snapshot.projection_set_digests[].projection_set_digest", "/projection_set_digests"],
  ["GenerationChangeManifest.*_change_set.content_digest", "/change_sets"],
  ["GenerationChangeManifest.projection_change_sets[].content_digest", "/projection_change_sets"],
  ["CandidateWorkManifest.artifact_work_set.content_digest", "/artifact_work_set/descriptor_id"],
  ["CandidateWorkManifest.projection_work_set.content_digest", "/projection_work_set/descriptor_id"],
  ["ProjectionWorkItem.base_projection_set_digest", "/base_projection_set_digest"],
  ["InvalidationPlan.dependency_index_digest", "/dependency_index_digest"],
  ["SnapshotExpirationMarker.snapshot_digest", "/snapshot_id"],
  ["DerivedEmbeddingVector.embedding_input_digest", "/embedding_segment_projection_id"],
  ["SemanticIndexMaterialization.embedding_profile_digest", "/embedding_profile_id"],
  ["SemanticIndexMaterialization.coverage_manifest_digest", "/coverage_manifest_id"],
  ["QueryEmbedding.embedding_profile_digest", "/embedding_profile_id"],
  ["SemanticIndexBinding.embedding_profile_digest", "/embedding_profile_id"],
  ["SemanticIndexBinding.queryable_vector_set_digest", "/semantic_index_materialization_id"],
  ["CandidateProjectionTemplate.generator_configuration_digest", "/generator_configuration_digest"],
  ["CandidateProjectionClosureTemplate.generator_configuration_digest", "/generator_configuration_digest"],
]);

const authoritativeModelLocatorBindings = new Map<string, { readonly target_source_path: string; readonly source_key_path: string }>([
  ["ModelPackManifest.embedding_profiles[].profile_digest", { target_source_path: "/embedding_profiles", source_key_path: "/embedding_profile_id" }],
  ["ModelAssetManifest.configuration_asset_digests[]", { target_source_path: "/configuration_asset_digests", source_key_path: "/content_digest" }],
  ["ModelAssetManifest.weight_asset_digests[]", { target_source_path: "/weight_asset_digests", source_key_path: "/content_digest" }],
  ["TokenizerAssetManifest.configuration_asset_digests[]", { target_source_path: "/configuration_asset_digests", source_key_path: "/content_digest" }],
  ["TokenizerAssetManifest.tokenizer_data_asset_digests[]", { target_source_path: "/tokenizer_data_asset_digests", source_key_path: "/content_digest" }],
  ["EmbeddingProfileExecutableBinding.operational_asset_digests[]", { target_source_path: "/operational_asset_digests", source_key_path: "/content_digest" }],
  ["Snapshot.source_observation_watermarks[].watermark_digest", { target_source_path: "/source_observation_watermarks", source_key_path: "/watermark_id" }],
  ["Snapshot.projection_set_digests[].projection_set_digest", { target_source_path: "/projection_set_digests", source_key_path: "/projection_kind" }],
  ["GenerationChangeManifest.*_change_set.content_digest", { target_source_path: "/change_sets", source_key_path: "/change_set_id" }],
  ["GenerationChangeManifest.projection_change_sets[].content_digest", { target_source_path: "/projection_change_sets", source_key_path: "/change_set_id" }],
]);

function locatorPairs(...pairs: readonly (readonly [string, string])[]): readonly DigestLocatorBinding[] {
  return pairs.map(([target_source_path, source_key_path]) => ({ target_source_path, source_key_path }));
}

/** Exact multi-field model locators transcribed from the approved reference table. */
const authoritativeModelLocatorBindingSets = new Map<string, readonly DigestLocatorBinding[]>([
  ["ArtifactVersion.content_hash", locatorPairs(["/content_blob_id", "/content_blob_id"])],
  ["SourceProviderResponseEnvelope.request_digest", locatorPairs(
    ["/protocol_version", "/protocol_version"],
    ["/request_id", "/request_id"],
    ["/call", "/call"],
    ["/workspace_id", "/workspace_id"],
    ["/source_provider_binding_id", "/source_provider_binding_id"],
    ["/component_id", "/component_id"],
    ["/component_version", "/component_version"],
  )],
  ["PresentSourceStateEntry.content_hash", locatorPairs(["/artifact_version_id", "/artifact_version_id"])],
  ["PresentSourceStateEntry.analysis_metadata_digest", locatorPairs(["/artifact_version_id", "/artifact_version_id"])],
  ["NamespaceBinding.contribution_digest", locatorPairs(
    ["/plugin_id", "/plugin_id"],
    ["/plugin_version", "/plugin_version"],
    ["/contribution_digest", "/contribution_digest"],
  )],
  ["RegistryNamespaceBindingEntry.contribution_digest", locatorPairs(
    ["/plugin_id", "/plugin_id"],
    ["/plugin_version", "/plugin_version"],
    ["/contribution_digest", "/contribution_digest"],
  )],
  ["ResolvedPlugin.declaration_digest", locatorPairs(
    ["/plugin_id", "/plugin_id"],
    ["/plugin_version", "/plugin_version"],
    ["/declaration_digest", "/declaration_digest"],
  )],
  ["ResolvedPlugin.contribution_digest", locatorPairs(
    ["/plugin_id", "/plugin_id"],
    ["/plugin_version", "/plugin_version"],
    ["/contribution_digest", "/contribution_digest"],
  )],
  ["ModelPackManifest.embedding_profiles[].profile_digest", locatorPairs(["/embedding_profiles", "/embedding_profile_id"])],
  ["ModelPackCoordinateReservation.manifest_digest", locatorPairs(
    ["/model_pack_id", "/model_pack_id"],
    ["/model_pack_version", "/model_pack_version"],
  )],
  ["ModelPackInstallation.manifest_digest", locatorPairs(
    ["/model_pack_id", "/model_pack_id"],
    ["/model_pack_version", "/model_pack_version"],
    ["/manifest_digest", "/manifest_digest"],
  )],
  ["EmbeddingProfile.model_identity_digest", locatorPairs(
    ["/model_provider_id", "/model_provider_id"],
    ["/model_id", "/model_id"],
    ["/model_revision", "/model_revision"],
  )],
  ["ModelAssetManifest.configuration_asset_digests[]", locatorPairs(["/configuration_asset_digests", "/content_digest"])],
  ["ModelAssetManifest.weight_asset_digests[]", locatorPairs(["/weight_asset_digests", "/content_digest"])],
  ["EmbeddingProfile.tokenizer_digest", locatorPairs(
    ["/tokenizer_id", "/tokenizer_id"],
    ["/tokenizer_revision", "/tokenizer_revision"],
  )],
  ["TokenizerAssetManifest.configuration_asset_digests[]", locatorPairs(["/configuration_asset_digests", "/content_digest"])],
  ["TokenizerAssetManifest.tokenizer_data_asset_digests[]", locatorPairs(["/tokenizer_data_asset_digests", "/content_digest"])],
  ["ModelPackRuntimeRequirement.behavior_digest", locatorPairs(
    ["/component_id", "/component_id"],
    ["/component_version", "/component_version"],
  )],
  ["RuntimeComponentBuild.behavior_digest", locatorPairs(
    ["/component_id", "/component_id"],
    ["/component_version", "/component_version"],
  )],
  ["ResolvedModelPackRuntimeBuild.behavior_digest", locatorPairs(
    ["/embedding_profile_id", "/embedding_profile_id"],
    ["/runtime_role", "/runtime_role"],
    ["/component_id", "/component_id"],
    ["/component_version", "/component_version"],
  )],
  ["ResolvedModelPackRuntimeBuild.implementation_digest", locatorPairs(["/runtime_component_build_id", "/runtime_component_build_id"])],
  ["EmbeddingSegmentationContract.configuration_digest", locatorPairs(
    ["/segmenter_id", "/component_id"],
    ["/segmenter_version", "/component_version"],
  )],
  ["EmbeddingProfileExecutableBinding.embedding_profile_digest", locatorPairs(["/embedding_profile_id", "/embedding_profile_id"])],
  ["EmbeddingProfileExecutableBinding.operational_asset_digests[]", locatorPairs(["/operational_asset_digests", "/content_digest"])],
  ["ModelPackProfileSupply.portable_binding_digest", locatorPairs(["/embedding_profile_id", "/embedding_profile_id"])],
  ["DerivedEmbeddingSegment.implementation_digest", locatorPairs(["/implementation_digest", "/implementation_digest"])],
  ["DerivedEmbeddingVector.implementation_digest", locatorPairs(["/implementation_digest", "/implementation_digest"])],
  ["DerivedEmbeddingSegment.generator_configuration_digest", locatorPairs(
    ["/embedding_profile_id", "/embedding_profile_id"],
    ["/generator", "/component_id"],
    ["/generator_version", "/component_version"],
  )],
  ["DerivedEmbeddingVector.generator_configuration_digest", locatorPairs(
    ["/embedding_profile_id", "/embedding_profile_id"],
    ["/generator", "/component_id"],
    ["/generator_version", "/component_version"],
  )],
  ["SemanticIndexMaterialization.generator_configuration_digest", locatorPairs(
    ["/embedding_profile_id", "/embedding_profile_id"],
    ["/generator", "/component_id"],
    ["/generator_version", "/component_version"],
  )],
  ["SemanticIndexMaterialization.executable_binding_digest", locatorPairs(
    ["/embedding_profile_id", "/embedding_profile_id"],
    ["/executable_binding_digest", "/executable_binding_digest"],
  )],
  ["QueryEmbedding.generator_configuration_digest", locatorPairs(
    ["/embedding_profile_id", "/embedding_profile_id"],
    ["/generator", "/component_id"],
    ["/generator_version", "/component_version"],
  )],
  ["QueryEmbedding.executable_binding_digest", locatorPairs(
    ["/embedding_profile_id", "/embedding_profile_id"],
    ["/executable_binding_digest", "/executable_binding_digest"],
  )],
  ["SemanticIndexBinding.generator_configuration_digest", locatorPairs(
    ["/embedding_profile_id", "/embedding_profile_id"],
    ["/generator", "/component_id"],
    ["/generator_version", "/component_version"],
  )],
  ["SemanticIndexBinding.executable_binding_digest", locatorPairs(
    ["/embedding_profile_id", "/embedding_profile_id"],
    ["/executable_binding_digest", "/executable_binding_digest"],
  )],
  ["Snapshot.source_observation_watermarks[].watermark_digest", locatorPairs(["/source_observation_watermarks", "/watermark_id"])],
  ["Snapshot.projection_set_digests[].projection_set_digest", locatorPairs(["/projection_set_digests", "/projection_kind"])],
  ["GenerationChangeManifest.*_change_set.content_digest", locatorPairs(["/artifact_change_set", "/change_set_id"])],
  ["GenerationChangeManifest.projection_change_sets[].content_digest", locatorPairs(["/projection_change_sets", "/change_set_id"])],
  ["CandidateWorkManifest.artifact_work_set.content_digest", locatorPairs(["/artifact_work_set", "/descriptor_id"])],
  ["CandidateWorkManifest.projection_work_set.content_digest", locatorPairs(["/projection_work_set", "/descriptor_id"])],
  ["ProjectionWorkItem.base_projection_set_digest", locatorPairs(["/base_projection_set_digest", "/projection_set_digest"])],
  ["InvalidationPlan.dependency_index_digest", locatorPairs(["/dependency_index_digest", "/projection_set_digest"])],
  ["SnapshotExpirationMarker.snapshot_digest", locatorPairs(
    ["/workspace_id", "/workspace_id"],
    ["/snapshot_id", "/snapshot_id"],
    ["/generation", "/generation"],
  )],
  ["DerivedEmbeddingVector.embedding_input_digest", locatorPairs(["/embedding_segment_projection_id", "/projection_record_id"])],
  ["SemanticIndexMaterialization.embedding_profile_digest", locatorPairs(["/embedding_profile_id", "/embedding_profile_id"])],
  ["SemanticIndexMaterialization.coverage_manifest_digest", locatorPairs(
    ["/coverage_manifest_id", "/coverage_manifest_id"],
    ["/semantic_index_materialization_id", "/semantic_index_materialization_id"],
  )],
  ["QueryEmbedding.embedding_profile_digest", locatorPairs(["/embedding_profile_id", "/embedding_profile_id"])],
  ["SemanticIndexBinding.embedding_profile_digest", locatorPairs(["/embedding_profile_id", "/embedding_profile_id"])],
  ["SemanticIndexBinding.queryable_vector_set_digest", locatorPairs(["/semantic_index_materialization_id", "/semantic_index_materialization_id"])],
  ["CandidateProjectionTemplate.generator_configuration_digest", locatorPairs(
    ["/generator", "/component_id"],
    ["/generator_version", "/component_version"],
    ["/generator_configuration_digest", "/configuration_digest"],
  )],
  ["CandidateProjectionClosureTemplate.generator_configuration_digest", locatorPairs(
    ["/generator", "/component_id"],
    ["/generator_version", "/component_version"],
    ["/generator_configuration_digest", "/configuration_digest"],
  )],
]);

function splitTargetFields(value: string): readonly string[] {
  return value.replaceAll("`", "").split(/,\s*/).map((target) => target.trim()).filter(Boolean);
}

function targetSchemaCoordinate(targetField: string): { readonly schema_id: string; readonly schema_version: number } {
  const model = targetField.slice(0, targetField.indexOf("."));
  if (!model) throw new Error(`Malformed digest target coordinate: ${targetField}`);
  return { schema_id: `core:${model}`, schema_version: 1 };
}

function targetFieldPointer(targetField: string): string {
  const field = targetField.slice(targetField.indexOf(".") + 1);
  return `/${field.split("/").map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function coordinateFieldPointer(coordinate: string): string | undefined {
  const cleaned = coordinate.replaceAll("`", "").replace(/[.]+$/, "").trim();
  const field = cleaned.slice(cleaned.indexOf(".") + 1);
  if (!cleaned.includes(".") || !field) return undefined;
  return `/${field.split("/").map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function sourceKeyPath(source: string, locatorSummary: string, targetField: string): string {
  const exactSet = authoritativeModelLocatorBindingSets.get(targetField);
  if (exactSet?.[0]) return exactSet[0].source_key_path;
  const exact = authoritativeModelLocatorBindings.get(targetField);
  if (exact) return exact.source_key_path;
  const arrowSource = locatorSummary.match(/->\s*([A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*(?:\[\])?)/)?.[1];
  const bareArrowSource = locatorSummary.match(/->\s*([a-z][a-z0-9_]*(?:\[\])?)/)?.[1];
  const sourcePath = arrowSource ? coordinateFieldPointer(arrowSource) : bareArrowSource ? `/${bareArrowSource}` : coordinateFieldPointer(source);
  if (sourcePath) return sourcePath;
  const authoritativePath = authoritativeModelLocatorPaths.get(targetField);
  if (!authoritativePath) throw new Error(`Missing authoritative locator source path for ${targetField}`);
  return authoritativePath;
}

function targetSourcePath(locatorSummary: string, targetField: string): string {
  const exactSet = authoritativeModelLocatorBindingSets.get(targetField);
  if (exactSet?.[0]) return exactSet[0].target_source_path;
  const exact = authoritativeModelLocatorBindings.get(targetField);
  if (exact) return exact.target_source_path;
  const arrowTarget = locatorSummary.match(/([A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*(?:\[\])?)\s*->/)?.[1];
  if (arrowTarget) return coordinateFieldPointer(arrowTarget)!;
  const bareArrowTarget = locatorSummary.match(/([a-z][a-z0-9_]*(?:\[\])?)\s*->/)?.[1];
  if (bareArrowTarget) return `/${bareArrowTarget}`;
  const authoritativePath = authoritativeModelLocatorPaths.get(targetField);
  if (!authoritativePath) throw new Error(`Missing authoritative locator target path for ${targetField}`);
  return authoritativePath;
}

function sourceRecipeCoordinate(source: string, visited = new Set<string>()): { readonly digest_recipe_id: string; readonly digest_domain: string } {
  const cleaned = source.replaceAll("`", "").trim();
  if (visited.has(cleaned)) throw new Error(`Cyclic digest reference source: ${source}`);
  visited.add(cleaned);
  if (cleaned.includes(" / ")) {
    const [digest_recipe_id, digest_domain] = cleaned.split(" / ");
    if (!digest_recipe_id || !digest_domain) throw new Error(`Malformed digest recipe coordinate: ${source}`);
    return { digest_recipe_id, digest_domain };
  }
  const digest_recipe_id = cleaned.startsWith("core:") ? cleaned : documentedRecipeByTarget.get(cleaned);
  if (digest_recipe_id) {
    const coordinate = [...documentedCoordinateByRecipe.values()].find((candidate) => candidate.digest_recipe_id === digest_recipe_id);
    if (!coordinate?.digest_domain) throw new Error(`Unresolved digest reference domain: ${source}`);
    return { digest_recipe_id, digest_domain: coordinate.digest_domain };
  }
  const sourceRow = documentedRowByTarget.get(cleaned);
  if (!sourceRow || sourceRow[0] === "terminal_recipe") throw new Error(`Unresolved digest reference source: ${source}`);
  return sourceRecipeCoordinate(sourceRow[2], visited);
}

function materializeComputationContract(row: DocumentedDigestContractRow, rowIndex: number): readonly DigestFieldContract[] {
  const [kind, rawTarget, recipeAndDomain, bindingSummary] = row;
  if (kind !== "computation") throw new Error(`Expected computation row at ${rowIndex}`);
  const { digest_recipe_id, digest_domain } = sourceRecipeCoordinate(recipeAndDomain);
  const coordinate = documentedCoordinateByRecipe.get(`${digest_recipe_id}\u0000${digest_domain}`);
  return splitTargetFields(rawTarget).map((target_field) => {
    const target = targetSchemaCoordinate(target_field);
    return {
      target_field,
      target_fields: [target_field],
      contract_kind: "computation" as const,
      digest_recipe_id,
      recipe_version: 1,
      target_schema_id: target.schema_id,
      target_schema_version: target.schema_version,
      digest_domain,
      source_location: `core-digest-field-contracts.md#row-${rowIndex + 1}`,
      binding_summary: bindingSummary,
      locator_bindings: [],
      ...(coordinate?.payload_schema_id ? { payload_schema_id: coordinate.payload_schema_id, payload_schema_version: coordinate.payload_schema_version ?? 1 } : {}),
    };
  });
}

function materializeReferenceContract(row: DocumentedDigestContractRow, rowIndex: number): readonly DigestFieldContract[] {
  const [kind, rawTarget, source, locatorSummary] = row;
  if (kind !== "reference") throw new Error(`Expected reference row at ${rowIndex}`);
  const sourceCoordinate = sourceRecipeCoordinate(source);
  return splitTargetFields(rawTarget).map((target_field) => {
    const target = targetSchemaCoordinate(target_field);
    const reference_kind = externalAssetReferenceTargets.has(target_field) ? "external_asset" : "model";
    return {
      target_field,
      target_fields: [target_field],
      contract_kind: "reference" as const,
      digest_recipe_id: sourceCoordinate.digest_recipe_id,
      recipe_version: 1,
      target_schema_id: target.schema_id,
      target_schema_version: target.schema_version,
      digest_domain: sourceCoordinate.digest_domain,
      source_location: `core-digest-field-contracts.md#row-${rowIndex + 1}`,
      binding_summary: locatorSummary,
      reference_kind,
      locator_bindings: reference_kind === "model"
        ? authoritativeModelLocatorBindingSets.get(target_field)
          ?? [{ target_source_path: targetSourcePath(locatorSummary, target_field), source_key_path: sourceKeyPath(source, locatorSummary, target_field) }]
        : [],
      ...(reference_kind === "external_asset" ? { verifier_contract_id: authoritativeExternalVerificationContractIds.get(sourceCoordinate.digest_recipe_id) ?? (() => { throw new Error(`Missing authoritative verifier contract for ${sourceCoordinate.digest_recipe_id}`); })() } : {}),
    };
  });
}

function materializeDocumentedFieldContracts(rows: readonly DocumentedDigestContractRow[]): readonly DigestFieldContract[] {
  return rows.flatMap((row) => {
    const sourceRowIndex = (documentedDigestContractRows as readonly DocumentedDigestContractRow[]).indexOf(row);
    if (sourceRowIndex < 0) throw new Error("Digest contract row is not part of the authoritative source registry");
    return row[0] === "computation"
      ? materializeComputationContract(row, sourceRowIndex)
      : row[0] === "reference" ? materializeReferenceContract(row, sourceRowIndex) : [];
  });
}

function materializeDocumentedSourceRows(rows: readonly DocumentedDigestContractRow[]): readonly DigestFieldContract[] {
  return rows.flatMap((row) => {
    const sourceRowIndex = (documentedDigestContractRows as readonly DocumentedDigestContractRow[]).indexOf(row);
    if (sourceRowIndex < 0) throw new Error("Digest contract row is not part of the authoritative source registry");
    const expanded = row[0] === "computation"
      ? materializeComputationContract(row, sourceRowIndex)
      : row[0] === "reference" ? materializeReferenceContract(row, sourceRowIndex) : [];
    if (expanded.length === 0) return [];
    const target_fields = splitTargetFields(row[1]);
    const first = expanded[0]!;
    return [{
      ...first,
      target_field: target_fields.join(", "),
      target_fields,
      target_schema_ids: expanded.map((contract) => contract.target_schema_id),
      locator_bindings: expanded.flatMap((contract) => contract.locator_bindings),
    }];
  });
}

const phase3SourceRows = phase3DigestFieldContractRows;

export const expandedDigestFieldContracts: readonly DigestFieldContract[] = Object.freeze(materializeDocumentedFieldContracts(phase3SourceRows));

export const expandedAllDigestFieldContracts: readonly DigestFieldContract[] = Object.freeze(materializeDocumentedFieldContracts(documentedDigestFieldContracts));

/** The normative Phase 3 count is the 142 source contract rows, before grouped target expansion. */
export const digestFieldContracts: readonly DigestFieldContract[] = Object.freeze(materializeDocumentedSourceRows(phase3SourceRows));

/** The complete normative count is the 175 non-terminal source contract rows. */
export const allDigestFieldContracts: readonly DigestFieldContract[] = Object.freeze(materializeDocumentedSourceRows(documentedDigestFieldContracts));

export const digestReferenceContracts: readonly DigestFieldContract[] = expandedAllDigestFieldContracts.filter((contract) => contract.contract_kind === "reference");

const exactRecipeCoordinates = [...documentedCoordinateByRecipe.values()];
export const digestRecipeRegistry = Object.freeze(exactRecipeCoordinates);

const exactRecipeCoordinateVariants = [...new Map(documentedDigestRecipeCoordinates.map((coordinate) => [
  [
    coordinate.digest_recipe_id,
    coordinate.digest_domain,
    coordinate.payload_schema_id ?? "",
    String(coordinate.payload_schema_version ?? ""),
    coordinate.target_field ?? "",
    coordinate.target_fields.join(","),
    coordinate.binding_summary ?? "",
  ].join("\u0000"),
  coordinate,
])).values()];

function payloadBindingMode(coordinate: (typeof exactRecipeCoordinates)[number]): string {
  const binding = payloadBindingFor(coordinate);
  return typeof binding === "string" ? binding : binding.binding_kind;
}

function materializeDigestRecipeDefinition(coordinate: (typeof documentedDigestRecipeCoordinates)[number]) {
  const verifiedInput = verifiedInputSchemaFor(coordinate);
  return {
  digest_recipe_id: coordinate.digest_recipe_id,
  definition_revision: 1,
  schema_version: 1,
  recipe_version: "1",
  target_schema_id: coordinate.target_field ? recipeTargetSchemaId(coordinate) : payloadSchemaIdFor(coordinate),
  target_schema_version: "1",
  target_field: coordinate.target_field ? targetFieldPointer(coordinate.target_field) : "",
  digest_domain: coordinate.digest_domain,
  canonical_encoding_version: "1",
  hash_algorithm: "sha256",
  payload_schema_id: payloadSchemaIdFor(coordinate),
  payload_schema_version: "1",
  ...(verifiedInput ? { verified_input_schema_id: verifiedInput.schema_id, verified_input_schema_version: String(verifiedInput.schema_version) } : {}),
  payload_binding: payloadBindingMode(coordinate),
  lifecycle_state: "active",
  };
}

export const digestRecipeDefinitions = Object.freeze(digestRecipeRegistry.map(materializeDigestRecipeDefinition));

/**
 * Every terminal row owns one exact external verification contract. The
 * contract retains the source row's schema coordinate, terminal recipe, and
 * complete capture/selection/exclusion semantics; references keep only the
 * stable contract coordinate and resolve this registry at verification time.
 */
export const externalVerificationContractDefinitions = Object.freeze(
  documentedDigestContractRows
    .filter((row) => row[0] === "terminal_recipe")
    .map((row) => {
      const recipeId = row[1];
      const recipe = digestRecipeDefinitions.find((candidate) => candidate.digest_recipe_id === recipeId);
      if (!recipe?.verified_input_schema_id) throw new Error(`Missing terminal verifier schema for ${recipeId}`);
      const external_verification_contract_id = `${recipeId.replace(/_digest$/, "")}_verification_contract`;
      return {
        external_verification_contract_id,
        definition_revision: 1,
        schema_version: 1,
        contract_version: "1",
        description: row[3],
        verified_input_schema_id: recipe.verified_input_schema_id,
        verified_input_schema_version: recipe.verified_input_schema_version ?? "1",
        terminal_digest_recipe_id: recipeId,
        terminal_digest_recipe_version: "1",
        verification_semantics: row[3],
        lifecycle_state: "active" as const,
      };
    }),
);

const externalVerificationContractByRecipe: ReadonlyMap<string, (typeof externalVerificationContractDefinitions)[number]> = new Map(
  externalVerificationContractDefinitions.map((definition) => [definition.terminal_digest_recipe_id, definition]),
);

/**
 * Exact executable variants are retained separately when one recipe coordinate
 * has multiple authoritative payload schemas, such as query and index-status
 * cursor projections. The primary registry remains one definition per recipe.
 */
export const digestRecipeVariantDefinitions = Object.freeze(exactRecipeCoordinateVariants.map(materializeDigestRecipeDefinition));

/**
 * The complete architecture-backed row inventory, including terminal recipes
 * and references that do not correspond to a local computed field.
 */
export const digestContractRowRegistry = documentedDigestContractRows;

export const terminalDigestRecipeDefinitions = [
  ["core:raw_artifact_content_digest", "core:artifact_content", "core:Bytes"],
  ["core:artifact_analysis_metadata_digest", "core:artifact_analysis_metadata", "core:AnalysisRelevantArtifactMetadata"],
  ["core:source_state_digest", "core:source_state", "core:VisibleSourceStateSet"],
  ["core:analyzer_implementation_digest", "core:analyzer_implementation", "core:AnalyzerImplementationManifest"],
  ["core:runtime_component_behavior_digest", "core:runtime_component_behavior", "core:RuntimeComponentBehaviorManifest"],
  ["core:runtime_component_implementation_digest", "core:runtime_component_implementation", "core:RuntimeComponentImplementationManifest"],
  ["core:analysis_configuration_digest", "core:analysis_configuration", "core:AnalysisConfiguration"],
  ["core:query_configuration_digest", "core:query_configuration", "core:QueryConfiguration"],
  ["core:generator_configuration_digest", "core:generator_configuration", "core:GeneratorConfiguration"],
  ["core:source_provider_configuration_digest", "core:source_provider_configuration", "core:SourceProviderConfiguration"],
  ["core:configuration_layer_digest", "core:configuration_layer", "core:NormalizedConfigurationLayer"],
  ["core:plugin_package_digest", "core:plugin_package", "core:PluginPackageManifest"],
  ["core:model_identity_digest", "core:model_identity", "core:ModelAssetManifest"],
  ["core:tokenizer_identity_digest", "core:tokenizer_identity", "core:TokenizerAssetManifest"],
  ["core:embedding_template_digest", "core:embedding_template", "core:Bytes"],
  ["core:model_pack_runtime_configuration_digest", "core:model_pack_runtime_configuration", "core:ModelPackRuntimeConfiguration"],
  ["core:embedding_input_digest", "core:embedding_input", "core:Bytes"],
  ["core:embedding_vector_bytes_digest", "core:embedding_vector_bytes", "core:Bytes"],
  ["core:query_plan_digest", "core:query_plan", "core:NormalizedQueryPlan"],
  ["core:response_budget_digest", "core:response_budget", "core:NormalizedResponseBudget"],
  ["core:core_registry_manifest_digest", "core:core_registry_manifest", "core:CoreRegistryManifest"],
].map(([digest_recipe_id, digest_domain, payload_schema_id]) => ({
  digest_recipe_id,
  definition_revision: 1,
  schema_version: 1,
  recipe_version: "1",
  target_schema_id: payload_schema_id,
  target_schema_version: "1",
  target_field: "",
  digest_domain,
  canonical_encoding_version: "1",
  hash_algorithm: "sha256",
  payload_schema_id,
  payload_schema_version: "1",
  verified_input_schema_id: payload_schema_id,
  verified_input_schema_version: "1",
  payload_binding: "verified_input",
  lifecycle_state: "active",
}));

export const canonicalEncodingConformanceCases = [
  { case_id: "uce-v1-empty-bytes", corpus_revision: "1", input_kind: "typed", logical_input: "base64url:", encoded_input_hex: "40", schema_id: "core:Bytes", schema_version: 1, expected_outcome: "accepted", expected_cbor_hex: "40" },
  { case_id: "uce-v1-bytes", corpus_revision: "1", input_kind: "typed", logical_input: "base64url:AAE", encoded_input_hex: "420001", schema_id: "core:Bytes", schema_version: 1, expected_outcome: "accepted", expected_cbor_hex: "420001" },
  { case_id: "uce-v1-single-byte", corpus_revision: "1", input_kind: "typed", logical_input: "base64url:AA", encoded_input_hex: "4100", schema_id: "core:Bytes", schema_version: 1, expected_outcome: "accepted", expected_cbor_hex: "4100" },
  { case_id: "uce-v1-noncanonical-bytes-length", corpus_revision: "1", input_kind: "encoded", encoded_input_hex: "580100", schema_id: "core:Bytes", schema_version: 1, expected_outcome: "rejected", expected_error_code: "uce:non_canonical_encoding" },
  { case_id: "uce-v1-indefinite-bytes", corpus_revision: "1", input_kind: "encoded", encoded_input_hex: "5fff", schema_id: "core:Bytes", schema_version: 1, expected_outcome: "rejected", expected_error_code: "uce:forbidden_cbor_feature" },
  { case_id: "uce-v1-forbidden-tag", corpus_revision: "1", input_kind: "encoded", encoded_input_hex: "c100", schema_id: "core:Bytes", schema_version: 1, expected_outcome: "rejected", expected_error_code: "uce:forbidden_cbor_feature" },
  { case_id: "uce-v1-trailing-data", corpus_revision: "1", input_kind: "encoded", encoded_input_hex: "4000", schema_id: "core:Bytes", schema_version: 1, expected_outcome: "rejected", expected_error_code: "uce:trailing_data" },
  { case_id: "uce-v1-noncanonical-integer", corpus_revision: "1", input_kind: "encoded", encoded_input_hex: "1817", schema_id: "core:Bytes", schema_version: 1, expected_outcome: "rejected", expected_error_code: "uce:non_canonical_encoding" },
  { case_id: "uce-v1-map-order", corpus_revision: "1", input_kind: "encoded", encoded_input_hex: "a2616201616102", schema_id: "core:Bytes", schema_version: 1, expected_outcome: "rejected", expected_error_code: "uce:non_canonical_encoding" },
  { case_id: "uce-v1-duplicate-map-key", corpus_revision: "1", input_kind: "encoded", encoded_input_hex: "a2616101616102", schema_id: "core:Bytes", schema_version: 1, expected_outcome: "rejected", expected_error_code: "uce:duplicate_map_key" },
  { case_id: "uce-v1-invalid-utf8", corpus_revision: "1", input_kind: "encoded", encoded_input_hex: "61ff", schema_id: "core:Bytes", schema_version: 1, expected_outcome: "rejected", expected_error_code: "uce:invalid_utf8" },
  { case_id: "uce-v1-indefinite-array", corpus_revision: "1", input_kind: "encoded", encoded_input_hex: "9fff", schema_id: "core:Bytes", schema_version: 1, expected_outcome: "rejected", expected_error_code: "uce:forbidden_cbor_feature" },
  { case_id: "uce-v1-forbidden-simple", corpus_revision: "1", input_kind: "encoded", encoded_input_hex: "f801", schema_id: "core:Bytes", schema_version: 1, expected_outcome: "rejected", expected_error_code: "uce:forbidden_cbor_feature" },
  { case_id: "uce-v1-noncanonical-float", corpus_revision: "1", input_kind: "encoded", encoded_input_hex: "fa3fc00000", schema_id: "core:Bytes", schema_version: 1, expected_outcome: "rejected", expected_error_code: "uce:non_canonical_encoding" },
  { case_id: "uce-v1-wide-noncanonical-integer", corpus_revision: "1", input_kind: "encoded", encoded_input_hex: "1b0000000000000017", schema_id: "core:Bytes", schema_version: 1, expected_outcome: "rejected", expected_error_code: "uce:non_canonical_encoding" },
  { case_id: "uce-v1-wide-noncanonical-float", corpus_revision: "1", input_kind: "encoded", encoded_input_hex: "fb3ff8000000000000", schema_id: "core:Bytes", schema_version: 1, expected_outcome: "rejected", expected_error_code: "uce:non_canonical_encoding" },
  { case_id: "uce-v1-forbidden-embedded-cbor", corpus_revision: "1", input_kind: "encoded", encoded_input_hex: "d81840", schema_id: "core:Bytes", schema_version: 1, expected_outcome: "rejected", expected_error_code: "uce:forbidden_cbor_feature" },
];

export const canonicalTypedConformanceCases = [
  { case_id: "uce-v1-record", type_expression: { type_kind: "record" as const, fields: [{ field_name: "name", description: "Name.", presence: "required" as const, value_type: { type_kind: "text" as const } }] }, logical_input: { name: "n" }, expected_cbor_hex: "a1646e616d65616e" },
  { case_id: "uce-v1-map", type_expression: { type_kind: "map" as const, value_type: { type_kind: "text" as const } }, logical_input: { a: "b" }, expected_cbor_hex: "a161616162" },
  { case_id: "uce-v1-union", type_expression: { type_kind: "union" as const, discriminator_field: "kind", discriminator_description: "Kind.", variants: [{ discriminator_value: "item", description: "Item.", fields: [{ field_name: "value", description: "Value.", presence: "required" as const, value_type: { type_kind: "text" as const } }] }] }, logical_input: { kind: "item", value: "x" }, expected_cbor_hex: "a2646b696e64646974656d6576616c75656178" },
  { case_id: "uce-v1-set", type_expression: { type_kind: "set" as const, element_type: { type_kind: "text" as const } }, logical_input: ["b", "a"], expected_cbor_hex: "8261616162" },
  { case_id: "uce-v1-ordered-set", type_expression: { type_kind: "ordered_set" as const, element_type: { type_kind: "record" as const, fields: [{ field_name: "record_id", description: "Record ID.", presence: "required" as const, value_type: { type_kind: "text" as const } }] }, comparator_id: "core:record_id_order", comparator_version: 1 }, logical_input: [{ record_id: "b" }, { record_id: "a" }], expected_cbor_hex: "82a1697265636f72645f69646161a1697265636f72645f69646162" },
  { case_id: "uce-v1-json", type_expression: { type_kind: "schema_reference" as const, reference_scope: "external" as const, type_name: "JsonValue", schema_id: "core:JsonValue", schema_version: 1 }, logical_input: { a: [true] }, expected_cbor_hex: "a1616181f5" },
  { case_id: "uce-v1-text-boundary", type_expression: { type_kind: "text" as const, minimum_code_point_count: 0, maximum_code_point_count: 1 }, logical_input: "é", expected_cbor_hex: "62c3a9" },
  { case_id: "uce-v1-bytes-boundary", type_expression: { type_kind: "bytes" as const, minimum_byte_length: 0, maximum_byte_length: 1 }, logical_input: Uint8Array.of(255), expected_cbor_hex: "41ff" },
  { case_id: "uce-v1-text-unicode", type_expression: { type_kind: "text" as const, minimum_code_point_count: 1, maximum_code_point_count: 2 }, logical_input: "é", expected_cbor_hex: "62c3a9" },
  { case_id: "uce-v1-safe-integer-boundary", type_expression: { type_kind: "safe_integer" as const, minimum: 24 }, logical_input: 24, expected_cbor_hex: "1818" },
  { case_id: "uce-v1-big-integer", type_expression: { type_kind: "big_integer" as const }, logical_input: "bigint:3", expected_cbor_hex: "03" },
  { case_id: "uce-v1-exact-decimal", type_expression: { type_kind: "exact_decimal" as const, scale_policy: "significant" as const }, logical_input: "decimal:1.50", expected_cbor_hex: "c482211896" },
  { case_id: "uce-v1-timestamp", type_expression: { type_kind: "timestamp" as const }, logical_input: "2026-08-09T00:00:00.000000000Z", expected_cbor_hex: "1b18c9f9fecdde0000" },
  { case_id: "uce-v1-map-multiple", type_expression: { type_kind: "map" as const, value_type: { type_kind: "text" as const } }, logical_input: { a: "b", c: "d" }, expected_cbor_hex: "a26161616261636164" },
  { case_id: "uce-v1-record-multiple", type_expression: { type_kind: "record" as const, fields: [{ field_name: "a", description: "A.", presence: "required" as const, value_type: { type_kind: "text" as const } }, { field_name: "b", description: "B.", presence: "required" as const, value_type: { type_kind: "safe_integer" as const } }] }, logical_input: { a: "x", b: 1 }, expected_cbor_hex: "a261616178616201" },
  { case_id: "uce-v1-json-nested", type_expression: { type_kind: "schema_reference" as const, reference_scope: "external" as const, type_name: "JsonValue", schema_id: "core:JsonValue", schema_version: 1 }, logical_input: { a: [true, null] }, expected_cbor_hex: "a1616182f5f6" },
];

export const digestReferenceDefinitions = digestReferenceContracts.map((contract) => ({
  digest_reference_id: `core:${contract.target_field.split(".").map((part) => toSnakeCase(part)).join("_")}_reference`,
  definition_revision: 1,
  schema_version: 1,
  target_schema_id: contract.target_schema_id,
  target_schema_version: "1",
  target_field: targetFieldPointer(contract.target_field),
  source_digest_recipe_id: contract.digest_recipe_id,
  source_digest_recipe_version: "1",
  reference_kind: contract.reference_kind ?? "model",
  locator_bindings: contract.locator_bindings,
      ...(contract.verifier_contract_id
        ? {
            external_verification_contract_id: externalVerificationContractByRecipe.get(contract.digest_recipe_id)?.external_verification_contract_id
              ?? (() => { throw new Error(`Missing external verification definition for ${contract.digest_recipe_id}`); })(),
            external_verification_contract_version: externalVerificationContractByRecipe.get(contract.digest_recipe_id)?.contract_version
              ?? (() => { throw new Error(`Missing external verification version for ${contract.digest_recipe_id}`); })(),
          }
        : {}),
  lifecycle_state: "active",
}));

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}
