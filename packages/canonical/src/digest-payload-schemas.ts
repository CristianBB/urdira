import { createHash } from "node:crypto";
import {
  coreSchemaDefinitions,
  modelContractRegistry,
  type CanonicalSchemaDefinition,
  type CanonicalTypeExpression,
  type SchemaFieldDefinition,
} from "@urdira/contracts";
import { documentedDigestRecipeCoordinates, type DocumentedDigestRecipeCoordinate } from "./documented-digest-contracts.js";

/**
 * Payload coordinates that are explicitly named by the digest-contract
 * inventory. The closed-record field list remains authoritative in the
 * corresponding row; these coordinates give each row an immutable schema
 * identity instead of silently dropping inline payloads.
 */
const inlinePayloadSchemaCoordinates: Readonly<Record<string, string>> = {
  "core:compatibility_requirement_digest": "core:CompatibilityRequirementDigestPayload",
  "core:record_artifact_dependency_digest": "core:RecordArtifactDependencyDigestPayload",
  "core:record_digest": "core:RecordDigestPayload",
  "core:source_observation_batch_digest": "core:SourceObservationBatchDigestPayload",
  "core:provider_watermark_digest": "core:ProviderWatermarkDigestPayload",
  "core:workspace_configuration_revision_digest": "core:WorkspaceConfigurationRevisionDigestPayload",
  "core:source_provider_request_digest": "core:SourceProviderRequestDigestPayload",
  "core:freshness_checkpoint_digest": "core:FreshnessCheckpointDigestPayload",
  "core:snapshot_record_set_digest": "core:SnapshotRecordSetDigestPayload",
  "core:projection_set_digest": "core:ProjectionSetDigestPayload",
  "core:snapshot_capability_state_digest": "core:SnapshotCapabilityStateDigestPayload",
  "core:snapshot_digest": "core:SnapshotDigestPayload",
  "core:embedding_profile_digest": "core:EmbeddingProfileDigestPayload",
  "core:model_pack_manifest_digest": "core:ModelPackManifestDigestPayload",
  "core:embedding_profile_portable_binding_digest": "core:EmbeddingProfilePortableBindingDigestPayload",
  "core:embedding_profile_executable_binding_digest": "core:EmbeddingProfileExecutableBindingDigestPayload",
  "core:plugin_registry_contribution_digest": "core:PluginRegistryContributionDigestPayload",
  "core:language_definition_digest": "core:LanguageDefinitionDigestPayload",
  "core:registry_snapshot_digest": "core:RegistrySnapshotDigestPayload",
  "core:plugin_compatibility_declaration_digest": "core:PluginCompatibilityDeclarationDigestPayload",
  "core:plugin_resolution_lock_digest": "core:PluginResolutionLockDigestPayload",
  "core:registry_compatibility_assessment_digest": "core:RegistryCompatibilityAssessmentDigestPayload",
  "core:plugin_upgrade_plan_digest": "core:PluginUpgradePlanDigestPayload",
  "core:ordered_set_content_digest": "core:OrderedSetContentDigestPayload",
  "core:change_set_content_digest": "core:ChangeSetContentDigestPayload",
  "core:generation_change_manifest_digest": "core:GenerationChangeManifestDigestPayload",
  "core:identity_key_digest": "core:IdentityKeyDigestPayload",
  "core:candidate_materialization_digest": "core:CandidateMaterializationDigestPayload",
  "core:candidate_work_manifest_digest": "core:CandidateWorkManifestDigestPayload",
  "core:artifact_analysis_context_digest": "core:ArtifactAnalysisContextDigestPayload",
  "core:index_candidate_digest": "core:IndexCandidateDigestPayload",
  "core:artifact_work_item_digest": "core:ArtifactWorkItemDigestPayload",
  "core:projection_work_item_digest": "core:ProjectionWorkItemDigestPayload",
  "core:invalidation_plan_digest": "core:InvalidationPlanDigestPayload",
  "core:retention_root_set_digest": "core:RetentionRootSetDigestPayload",
  "core:gc_candidate_object_set_digest": "core:GCCandidateObjectSetDigestPayload",
  "core:gc_deleted_object_set_digest": "core:GCDeletedObjectSetDigestPayload",
  "core:derived_projection_content_digest": "core:DerivedProjectionContentDigestPayload",
  "core:semantic_document_section_digest": "core:SemanticDocumentSectionDigestPayload",
  "core:semantic_document_content_digest": "core:SemanticDocumentContentDigestPayload",
  "core:semantic_artifact_projection_set_digest": "core:SemanticArtifactProjectionSetDigestPayload",
  "core:semantic_artifact_coverage_digest": "core:SemanticArtifactCoverageDigestPayload",
  "core:semantic_coverage_manifest_digest": "core:SemanticCoverageManifestDigestPayload",
  "core:queryable_vector_set_digest": "core:QueryableVectorSetDigestPayload",
  "core:semantic_index_materialization_digest": "core:SemanticIndexMaterializationDigestPayload",
  "core:fact_delta_digest": "core:FactDeltaDigestPayload",
  "core:plugin_input_access_manifest_digest": "core:PluginInputAccessManifestDigestPayload",
  "core:plugin_analysis_input_digest": "core:PluginAnalysisInputDigestPayload",
  "core:plugin_worker_request_digest": "core:PluginWorkerRequestDigestPayload",
  "core:plugin_analysis_view_digest": "core:PluginAnalysisViewDigestPayload",
  "core:plugin_source_overlay_digest": "core:PluginSourceOverlayDigestPayload",
  "core:plugin_prerequisite_stage_set_digest": "core:PluginPrerequisiteStageSetDigestPayload",
  "core:plugin_lookup_result_set_digest": "core:PluginLookupResultSetDigestPayload",
  "core:plugin_lookup_selector_digest": "core:PluginLookupSelectorDigestPayload",
  "core:replacement_scope_base_record_set_digest": "core:ReplacementScopeBaseRecordSetDigestPayload",
  "core:query_embedding_digest": "core:QueryEmbeddingDigestPayload",
  "core:semantic_index_binding_digest": "core:SemanticIndexBindingDigestPayload",
  "core:cursor_workspace_scope_digest": "core:CursorWorkspaceScopeDigestPayload",
  "core:index_status_scope_digest": "core:IndexStatusScopeDigestPayload",
  "core:registry_usage_set_digest": "core:RegistryUsageSetDigestPayload",
  "core:intent_recipe_definition_digest": "core:IntentRecipeDefinitionDigestPayload",
};

const terminalPayloadSchemaCoordinates: Readonly<Record<string, string>> = {
  "core:raw_artifact_content_digest": "core:Bytes",
  "core:artifact_analysis_metadata_digest": "core:AnalysisRelevantArtifactMetadata",
  "core:source_state_digest": "core:VisibleSourceStateSet",
  "core:analyzer_implementation_digest": "core:AnalyzerImplementationManifest",
  "core:runtime_component_behavior_digest": "core:RuntimeComponentBehaviorManifest",
  "core:runtime_component_implementation_digest": "core:RuntimeComponentImplementationManifest",
  "core:analysis_configuration_digest": "core:AnalysisConfiguration",
  "core:query_configuration_digest": "core:QueryConfiguration",
  "core:generator_configuration_digest": "core:GeneratorConfiguration",
  "core:source_provider_configuration_digest": "core:SourceProviderConfiguration",
  "core:configuration_layer_digest": "core:NormalizedConfigurationLayer",
  "core:plugin_package_digest": "core:PluginPackageManifest",
  "core:model_identity_digest": "core:ModelAssetManifest",
  "core:tokenizer_identity_digest": "core:TokenizerAssetManifest",
  "core:embedding_template_digest": "core:Bytes",
  "core:model_pack_runtime_configuration_digest": "core:ModelPackRuntimeConfiguration",
  "core:embedding_input_digest": "core:Bytes",
  "core:embedding_vector_bytes_digest": "core:Bytes",
  "core:query_plan_digest": "core:NormalizedQueryPlan",
  "core:response_budget_digest": "core:NormalizedResponseBudget",
  "core:core_registry_manifest_digest": "core:CoreRegistryManifest",
};

const knownSchemas = new Map(coreSchemaDefinitions.map((schema) => [schema.schema_id, schema]));

function splitTopLevel(value: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "<") depth += 1;
    else if (character === ">") depth -= 1;
    else if (character === "," && depth === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

function logicalType(logical: string, field?: { readonly schema_bound_coordinates?: readonly [string, string] }): CanonicalTypeExpression {
  const sequence = logical.match(/^Sequence<(.+)>$/);
  if (sequence) return { type_kind: "sequence", element_type: logicalType(sequence[1]!) };
  const set = logical.match(/^Set<(.+)>$/);
  if (set) return { type_kind: "set", element_type: logicalType(set[1]!) };
  const ordered = logical.match(/^OrderedSet<(.+),\s*(core:[^>]+)>$/);
  if (ordered) return { type_kind: "ordered_set", element_type: logicalType(ordered[1]!), comparator_id: ordered[2]!.replace(/@\d+$/, ""), comparator_version: 1 };
  const union = logical.split("|").map((value) => value.trim()).filter(Boolean);
  if (union.length > 1) return { type_kind: "enum", values: union };
  if (logical === "Boolean") return { type_kind: "boolean" };
  if (logical === "PositiveInteger") return { type_kind: "safe_integer", minimum: 1 };
  if (logical === "Count") return { type_kind: "safe_integer", minimum: 0 };
  if (logical === "Identifier") return { type_kind: "text", identifier_kind: "identifier" };
  if (logical === "NamespacedIdentifier") return { type_kind: "text", identifier_kind: "namespaced_identifier" };
  if (logical === "SemVer") return { type_kind: "text", identifier_kind: "semver" };
  if (logical === "URI") return { type_kind: "text", identifier_kind: "uri" };
  if (logical === "Text") return { type_kind: "text" };
  if (logical === "Digest") return { type_kind: "digest", allowed_hash_algorithms: ["sha256"] };
  if (logical === "Bytes" || logical === "SchemaBoundBytes") {
    return {
      type_kind: "bytes",
      ...(field?.schema_bound_coordinates ? { bound_schema_id_field: field.schema_bound_coordinates[0], bound_schema_version_field: field.schema_bound_coordinates[1] } : {}),
    };
  }
  if (logical === "JsonValue") return { type_kind: "schema_reference", reference_scope: "external", type_name: "JsonValue", schema_id: "core:JsonValue", schema_version: 1 };
  return { type_kind: "schema_reference", reference_scope: "external", type_name: logical, schema_id: `core:${logical}`, schema_version: 1 };
}

function modelNameForCoordinate(coordinate: DocumentedDigestRecipeCoordinate): string | undefined {
  const target = coordinate.target_field?.split(".")[0];
  return target;
}

function modelFields(modelName: string | undefined): ReadonlyMap<string, { readonly logical_type: string; readonly presence: "required" | "optional"; readonly description: string; readonly schema_bound_coordinates?: readonly [string, string] }> {
  const model = modelName ? modelContractRegistry.find((candidate) => candidate.name === modelName) : undefined;
  return new Map((model?.fields ?? []).map((field) => [field.name, field]));
}

function sharedAuthoritativeField(fieldName: string): { readonly logical_type: string; readonly presence: "required" | "optional"; readonly description: string; readonly schema_bound_coordinates?: readonly [string, string] } | undefined {
  const matches = modelContractRegistry.flatMap((model) => model.fields.filter((field) => field.name === fieldName));
  const logicalTypes = new Set(matches.map((field) => field.logical_type));
  if (matches.length === 0 || logicalTypes.size !== 1) return undefined;
  return matches[0];
}

function rowFieldNames(summary: string): readonly { readonly name: string; readonly optional: boolean }[] {
  const match = summary.match(/^\{([^}]*)\}/);
  if (!match) return [];
  return splitTopLevel(match[1]!).map((field) => {
    const name = field.trim().replace(/\?$/, "");
    return { name, optional: field.trim().endsWith("?") };
  }).filter((field) => /^[a-z][a-z0-9_]*$/.test(field.name));
}

function nestedInputType(summary: string, fieldName: string): CanonicalTypeExpression | undefined {
  const pattern = new RegExp(`${fieldName}\\s*=\\s*input\\(([^)]+)\\)`);
  const match = summary.match(pattern);
  if (!match) return undefined;
  return inputType(match[1]!);
}

function inputType(value: string): CanonicalTypeExpression {
  let clean = value.replace(/`/g, "").trim();
  if (clean.startsWith("ordered_set(") && !clean.endsWith(")")) clean += ")";
  if (clean === "Bytes") return { type_kind: "bytes" };
  const ordered = clean.match(/^ordered_set\(([^,]+),\s*(core:[^@)]+)@?(\d+)?\)$/);
  if (ordered) {
    const elementName = ordered[1]!.trim().replace(/@\d+$/, "").replace(/^core:/, "");
    return {
      type_kind: "ordered_set",
      element_type: { type_kind: "schema_reference", reference_scope: "external", type_name: elementName, schema_id: `core:${elementName}`, schema_version: Number(ordered[3] ?? 1) },
      comparator_id: ordered[2]!.trim(),
      comparator_version: Number(ordered[3] ?? 1),
    };
  }
  if (clean.startsWith("ordered_set(")) {
    // The contract deliberately leaves element_type/comparator_id as payload
    // coordinates. The enclosing record carries those coordinates, so this
    // field is represented as a sequence until the selected runtime schema is
    // available; it is never treated as an arbitrary executable value.
    return { type_kind: "sequence", element_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "JsonValue", schema_id: "core:JsonValue", schema_version: 1 } };
  }
  const coordinate = clean.match(/^(core:[A-Za-z0-9_]+)(?:@(\d+))?$/);
  if (coordinate) return { type_kind: "schema_reference", reference_scope: "external", type_name: coordinate[1]!.slice(5), schema_id: coordinate[1]!, schema_version: Number(coordinate[2] ?? 1) };
  return { type_kind: "schema_reference", reference_scope: "external", type_name: clean, schema_id: `core:${clean}`, schema_version: 1 };
}

const completePayloadModels: Readonly<Record<string, string>> = {
  "core:language_definition_digest": "LanguageDefinition",
  "core:candidate_materialization_digest": "CandidateMaterialization",
};

const payloadFieldTypeOverrides: Readonly<Record<string, Readonly<Record<string, CanonicalTypeExpression>>>> = {
  "core:compatibility_requirement_digest": {
    requirement: {
      type_kind: "record",
      fields: [
        { field_name: "requirement_schema_id", description: "The exact adjacent schema coordinate.", presence: "required", value_type: { type_kind: "text", identifier_kind: "namespaced_identifier" } },
        { field_name: "requirement_schema_version", description: "The exact adjacent schema version.", presence: "required", value_type: { type_kind: "safe_integer", minimum: 1 } },
        { field_name: "requirement_value", description: "The UCE bytes validated against the adjacent schema coordinate.", presence: "required", value_type: { type_kind: "bytes", minimum_byte_length: 1, bound_schema_id_field: "requirement_schema_id", bound_schema_version_field: "requirement_schema_version" } },
      ],
    },
  },
  "core:index_candidate_digest": {
    accepted_fact_delta_digests: { type_kind: "set", element_type: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] } },
    materialization_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
  },
  "core:artifact_analysis_context_digest": {
    registry_snapshot_id: { type_kind: "text", identifier_kind: "identifier" },
    configuration_revision_id: { type_kind: "text", identifier_kind: "identifier" },
    dependency_plugin_digests: { type_kind: "set", element_type: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] } },
    analysis_configuration_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
  },
  "core:semantic_coverage_manifest_digest": {
    semantic_index_materialization_id: { type_kind: "text", identifier_kind: "identifier" },
    element_type: { type_kind: "text" },
    element_schema_version: { type_kind: "safe_integer", minimum: 1 },
    comparator_id: { type_kind: "text", identifier_kind: "namespaced_identifier" },
    comparator_version: { type_kind: "safe_integer", minimum: 1 },
    entry_count: { type_kind: "safe_integer", minimum: 0 },
    entries: inputType("ordered_set(SemanticArtifactCoverage, core:semantic_coverage_order@1)"),
  },
  "core:change_set_content_digest": {
    change_set_kind: { type_kind: "text" },
    entry_schema_version: { type_kind: "safe_integer", minimum: 1 },
    comparator_id: { type_kind: "text", identifier_kind: "namespaced_identifier" },
    comparator_version: { type_kind: "safe_integer", minimum: 1 },
    entry_count: { type_kind: "safe_integer", minimum: 0 },
    projection_kind: { type_kind: "text" },
    generator: { type_kind: "text", identifier_kind: "identifier" },
    generator_version: { type_kind: "text", identifier_kind: "semver" },
    entries: { type_kind: "sequence", element_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "JsonValue", schema_id: "core:JsonValue", schema_version: 1 } },
  },
  "core:semantic_document_section_digest": {
    section_key: { type_kind: "text", identifier_kind: "identifier" },
    ordinal: { type_kind: "safe_integer", minimum: 0 },
    section_kind: { type_kind: "text" },
    language_id: { type_kind: "text", identifier_kind: "identifier" },
    origin_kind: { type_kind: "text" },
    text: { type_kind: "text" },
    source_spans: { type_kind: "sequence", element_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "SourceSpan", schema_id: "core:SourceSpan", schema_version: 1 } },
    source_record_ids: { type_kind: "sequence", element_type: { type_kind: "text", identifier_kind: "identifier" } },
  },
  "core:semantic_document_content_digest": {
    subject: { type_kind: "text" },
    content_class: { type_kind: "text" },
    language_ids: { type_kind: "sequence", element_type: { type_kind: "text", identifier_kind: "identifier" } },
    display_title: { type_kind: "text" },
    sections: { type_kind: "sequence", element_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "SemanticDocumentSection", schema_id: "core:SemanticDocumentSection", schema_version: 1 } },
  },
  "core:semantic_artifact_coverage_digest": {
    semantic_artifact_coverage_id: { type_kind: "text", identifier_kind: "identifier" },
    semantic_index_materialization_id: { type_kind: "text", identifier_kind: "identifier" },
    workspace_id: { type_kind: "text", identifier_kind: "identifier" },
    snapshot_id: { type_kind: "text", identifier_kind: "identifier" },
    generation: { type_kind: "safe_integer", minimum: 0 },
    embedding_profile_id: { type_kind: "text", identifier_kind: "identifier" },
    owner_artifact_id: { type_kind: "text", identifier_kind: "identifier" },
    owner_artifact_version_id: { type_kind: "text", identifier_kind: "identifier" },
    eligibility_projection_record_id: { type_kind: "text", identifier_kind: "identifier" },
    coverage_status: { type_kind: "text" },
    semantic_document_count: { type_kind: "safe_integer", minimum: 0 },
    embedding_segment_count: { type_kind: "safe_integer", minimum: 0 },
    embedding_vector_count: { type_kind: "safe_integer", minimum: 0 },
    reason_codes: { type_kind: "sequence", element_type: { type_kind: "text" } },
    diagnostic_record_ids: { type_kind: "sequence", element_type: { type_kind: "text", identifier_kind: "identifier" } },
    artifact_projection_set_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
  },
  "core:semantic_index_materialization_digest": {
    semantic_index_materialization_id: { type_kind: "text", identifier_kind: "identifier" },
    schema_version: { type_kind: "safe_integer", minimum: 1 },
    workspace_id: { type_kind: "text", identifier_kind: "identifier" },
    snapshot_id: { type_kind: "text", identifier_kind: "identifier" },
    generation: { type_kind: "safe_integer", minimum: 0 },
    embedding_profile_id: { type_kind: "text", identifier_kind: "identifier" },
    embedding_profile_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
    executable_binding_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
    generator: { type_kind: "text", identifier_kind: "identifier" },
    generator_version: { type_kind: "text", identifier_kind: "semver" },
    generator_configuration_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
    materialization_state: { type_kind: "text" },
    coverage_manifest_id: { type_kind: "text", identifier_kind: "identifier" },
    coverage_manifest_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
    artifact_count: { type_kind: "safe_integer", minimum: 0 },
    covered_artifact_count: { type_kind: "safe_integer", minimum: 0 },
    pending_artifact_count: { type_kind: "safe_integer", minimum: 0 },
    excluded_artifact_count: { type_kind: "safe_integer", minimum: 0 },
    unsupported_artifact_count: { type_kind: "safe_integer", minimum: 0 },
    failed_artifact_count: { type_kind: "safe_integer", minimum: 0 },
    semantic_document_count: { type_kind: "safe_integer", minimum: 0 },
    embedding_segment_count: { type_kind: "safe_integer", minimum: 0 },
    embedding_vector_count: { type_kind: "safe_integer", minimum: 0 },
    queryable_vector_set_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
    predecessor_materialization_id: { type_kind: "text", identifier_kind: "identifier" },
    published_at: { type_kind: "timestamp" },
  },
  "core:plugin_analysis_input_digest": {
    request_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
    analysis_view_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
    plugin_input_access_manifest_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
    plugin_id: { type_kind: "text", identifier_kind: "identifier" },
    plugin_version: { type_kind: "text", identifier_kind: "semver" },
    analysis_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
    analysis_configuration_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
    call: { type_kind: "text" },
    call_payload: { type_kind: "schema_reference", reference_scope: "external", type_name: "JsonValue", schema_id: "core:JsonValue", schema_version: 1 },
  },
  "core:plugin_lookup_result_set_digest": {
    operation: { type_kind: "text" },
    normalized_selector_or_address: { type_kind: "text" },
    analysis_view_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
    completeness: { type_kind: "schema_reference", reference_scope: "external", type_name: "CompletenessReport", schema_id: "core:CompletenessReport", schema_version: 1 },
    results: { type_kind: "sequence", element_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "JsonValue", schema_id: "core:JsonValue", schema_version: 1 } },
  },
  "core:replacement_scope_base_record_set_digest": {
    owner_artifact_id: { type_kind: "text", identifier_kind: "identifier" },
    owner_artifact_version_id: { type_kind: "text", identifier_kind: "identifier" },
    capability: { type_kind: "text" },
    record_categories: { type_kind: "sequence", element_type: { type_kind: "text" } },
    record_kinds: { type_kind: "sequence", element_type: { type_kind: "text" } },
    partition_key: { type_kind: "schema_reference", reference_scope: "external", type_name: "JsonValue", schema_id: "core:JsonValue", schema_version: 1 },
    records: inputType("ordered_set(core:RecordSetDigestEntry@1, core:record_id_order@1)"),
  },
  "core:query_embedding_digest": {
    semantic_lane_id: { type_kind: "text", identifier_kind: "identifier" },
    embedding_profile_id: { type_kind: "text", identifier_kind: "identifier" },
    embedding_profile_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
    executable_binding_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
    generator: { type_kind: "text", identifier_kind: "identifier" },
    generator_version: { type_kind: "text", identifier_kind: "semver" },
    generator_configuration_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
    embedding_input: { type_kind: "text" },
    embedding_input_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
    token_count: { type_kind: "safe_integer", minimum: 0 },
    dimensions: { type_kind: "safe_integer", minimum: 1 },
    element_type: { type_kind: "text" },
    vector_encoding: { type_kind: "text" },
    normalization: { type_kind: "text" },
    vector_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
  },
  "core:semantic_index_binding_digest": {
    semantic_index_binding_id: { type_kind: "text", identifier_kind: "identifier" },
    semantic_lane_id: { type_kind: "text", identifier_kind: "identifier" },
    workspace_snapshot_binding_id: { type_kind: "text", identifier_kind: "identifier" },
    semantic_index_materialization_id: { type_kind: "text", identifier_kind: "identifier" },
    embedding_profile_id: { type_kind: "text", identifier_kind: "identifier" },
    embedding_profile_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
    executable_binding_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
    generator: { type_kind: "text", identifier_kind: "identifier" },
    generator_version: { type_kind: "text", identifier_kind: "semver" },
    generator_configuration_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
    queryable_vector_set_digest: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] },
  },
  "core:index_status_scope_digest": {
    workspace_ids: { type_kind: "sequence", element_type: { type_kind: "text", identifier_kind: "identifier" } },
    include_capabilities: { type_kind: "boolean" },
    include_plugins: { type_kind: "boolean" },
    include_activation_issues: { type_kind: "boolean" },
    include_candidate_issues: { type_kind: "boolean" },
    observed_at: { type_kind: "timestamp" },
    workspace_status_set: { type_kind: "sequence", element_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "JsonValue", schema_id: "core:JsonValue", schema_version: 1 } },
    activation_issue_status_set: { type_kind: "sequence", element_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "JsonValue", schema_id: "core:JsonValue", schema_version: 1 } },
    candidate_issue_status_set: { type_kind: "sequence", element_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "JsonValue", schema_id: "core:JsonValue", schema_version: 1 } },
  },
};

const excludedPayloadFields: Readonly<Record<string, ReadonlySet<string>>> = {
  "core:language_definition_digest": new Set(["definition_digest"]),
  "core:candidate_materialization_digest": new Set(["candidate_materialization_id", "materialization_digest", "created_at"]),
};

function scalarPayloadType(coordinate: DocumentedDigestRecipeCoordinate, summary: string): CanonicalTypeExpression {
  const input = summary.match(/Scalar `input\((.*)\)`/);
  if (input) return inputType(input[1]!);
  const model = modelFields(modelNameForCoordinate(coordinate));
  const targetField = coordinate.target_field?.split(".").slice(1).join(".") ?? "";
  const field = model.get(targetField);
  return logicalType(field?.logical_type ?? "Text", field);
}

function payloadType(coordinate: DocumentedDigestRecipeCoordinate): CanonicalTypeExpression {
  const summary = coordinate.binding_summary ?? "";
  const fields = rowFieldNames(summary);
  const recipeId = coordinate.digest_recipe_id;
  const sourceFields = modelFields(completePayloadModels[recipeId] ?? modelNameForCoordinate(coordinate));
  if (fields.length === 0 && !completePayloadModels[recipeId]) return scalarPayloadType(coordinate, summary);
  const names = fields.length > 0 ? fields : [...sourceFields.keys()].map((name) => ({ name, optional: false }));
  if (names.length === 0) return scalarPayloadType(coordinate, summary);
  const overrides = payloadFieldTypeOverrides[recipeId] ?? {};
  const digestField = coordinate.target_field?.split(".").slice(1).join(".");
  const definitions: SchemaFieldDefinition[] = names.map(({ name, optional }) => {
    if (excludedPayloadFields[recipeId]?.has(name) || name === digestField) return undefined;
    const source = sourceFields.get(name) ?? sharedAuthoritativeField(name);
    const nested = nestedInputType(summary, name);
    const explicit = overrides[name];
    if (!source && !nested && !explicit) throw new Error(`Missing authoritative payload field type for ${recipeId}.${name}`);
    return {
      field_name: name,
      description: source?.description || `Digest payload field ${name}.`,
      presence: (optional || source?.presence === "optional" ? "optional" : "required") as "optional" | "required",
      value_type: explicit ?? nested ?? logicalType(source!.logical_type, source),
    };
  }).filter((field): field is SchemaFieldDefinition => field !== undefined);
  return { type_kind: "record", fields: definitions };
}

function targetSchemaId(coordinate: DocumentedDigestRecipeCoordinate): string {
  const model = modelNameForCoordinate(coordinate);
  return model ? `core:${model}` : coordinate.payload_schema_id ?? "core:Bytes";
}

function coordinateIdentityKey(coordinate: DocumentedDigestRecipeCoordinate): string {
  return [
    coordinate.digest_recipe_id,
    coordinate.digest_domain,
    coordinate.payload_schema_id ?? "",
    String(coordinate.payload_schema_version ?? ""),
    coordinate.target_field ?? "",
    coordinate.target_fields.join(","),
    coordinate.binding_summary ?? "",
  ].join("\u0000");
}

const exactCoordinateMap = new Map<string, DocumentedDigestRecipeCoordinate>();
for (const coordinate of documentedDigestRecipeCoordinates) {
  exactCoordinateMap.set(coordinateIdentityKey(coordinate), coordinate);
}
const exactCoordinates = [...exactCoordinateMap.values()];
const primaryCoordinateMap = new Map<string, DocumentedDigestRecipeCoordinate>();
for (const coordinate of exactCoordinates) {
  const key = `${coordinate.digest_recipe_id}\u0000${coordinate.digest_domain}`;
  const existing = primaryCoordinateMap.get(key);
  if (!existing || coordinate.contract_kind === "terminal_recipe") primaryCoordinateMap.set(key, coordinate);
}
const primaryCoordinates = [...primaryCoordinateMap.values()];

function schemaIdForCoordinate(coordinate: DocumentedDigestRecipeCoordinate): string {
  const primary = primaryCoordinateMap.get(`${coordinate.digest_recipe_id}\u0000${coordinate.digest_domain}`);
  const isPrimary = primary !== undefined && coordinateIdentityKey(primary) === coordinateIdentityKey(coordinate);
  const explicit = inlinePayloadSchemaCoordinates[coordinate.digest_recipe_id];
  if (explicit && isPrimary) return explicit;
  const terminal = terminalPayloadSchemaCoordinates[coordinate.digest_recipe_id];
  if (terminal && isPrimary) return terminal;
  if (coordinate.payload_schema_id && knownSchemas.has(coordinate.payload_schema_id)) return coordinate.payload_schema_id;
  if (isPrimary && primary?.payload_schema_id && knownSchemas.has(primary.payload_schema_id)) return primary.payload_schema_id;
  const base = explicit ?? terminal ?? (primary ? `core:${primary.digest_recipe_id.replace(/^core:/, "")}Payload` : undefined);
  if (base) {
    const suffix = createHash("sha256").update(coordinateIdentityKey(coordinate)).digest("hex").slice(0, 12);
    return `${base}_${suffix}`;
  }
  throw new Error(`Missing authoritative payload schema coordinate for ${coordinate.digest_recipe_id}`);
}

export const digestPayloadSchemaCoordinates: ReadonlyMap<string, string> = new Map(
  [...exactCoordinates, ...primaryCoordinates].map((coordinate) => [
    coordinateIdentityKey(coordinate),
    schemaIdForCoordinate(coordinate),
  ]),
);

export function payloadSchemaIdFor(coordinate: DocumentedDigestRecipeCoordinate): string {
  return digestPayloadSchemaCoordinates.get(coordinateIdentityKey(coordinate))
    ?? (() => { throw new Error(`Missing payload schema coordinate for ${coordinate.digest_recipe_id}`); })();
}

export const digestPayloadSchemaDefinitions: readonly CanonicalSchemaDefinition[] = Object.freeze(
  exactCoordinates
    .filter((coordinate) => !knownSchemas.has(payloadSchemaIdFor(coordinate)))
    .map((coordinate) => ({
      schema_id: payloadSchemaIdFor(coordinate),
      definition_revision: 1,
      schema_version: 1,
      description: coordinate.binding_summary ?? `Payload schema for ${coordinate.digest_recipe_id}.`,
      root_type: payloadType(coordinate),
      type_definitions: [],
      lifecycle_state: "active" as const,
    })),
);

const payloadSchemaDefinitionByCoordinate = new Map<string, CanonicalSchemaDefinition>();
for (const schema of digestPayloadSchemaDefinitions) {
  const key = `${schema.schema_id}@${schema.schema_version}`;
  const existing = payloadSchemaDefinitionByCoordinate.get(key);
  if (existing && JSON.stringify(existing.root_type) !== JSON.stringify(schema.root_type)) {
    throw new Error(`Conflicting digest payload schema definitions for ${key}`);
  }
  payloadSchemaDefinitionByCoordinate.set(key, schema);
}

export const digestPayloadSchemas = Object.freeze([...coreSchemaDefinitions, ...digestPayloadSchemaDefinitions]);

export function verifiedInputSchemaFor(coordinate: DocumentedDigestRecipeCoordinate): { readonly schema_id: string; readonly schema_version: number } | undefined {
  const summary = coordinate.binding_summary ?? "";
  if (coordinate.contract_kind === "terminal_recipe") {
    return coordinate.payload_schema_id ? { schema_id: coordinate.payload_schema_id, schema_version: coordinate.payload_schema_version ?? 1 } : undefined;
  }
  const input = summary.match(/input\((Bytes|core:[A-Za-z0-9_]+)(?:@(\d+))?\)/);
  if (input) {
    const schema_id = input[1] === "Bytes" ? "core:Bytes" : input[1]!;
    return { schema_id, schema_version: Number(input[2] ?? 1) };
  }
  return summary.includes("input(") && isWholeVerifiedInput(coordinate)
    ? { schema_id: payloadSchemaIdFor(coordinate), schema_version: 1 }
    : undefined;
}

export function isWholeVerifiedInput(coordinate: DocumentedDigestRecipeCoordinate): boolean {
  return /^Scalar `input\(/.test(coordinate.binding_summary ?? "");
}

export function payloadBindingFor(coordinate: DocumentedDigestRecipeCoordinate): "verified_input" | "direct_value" | { readonly binding_kind: "scalar"; readonly source_path: string } | { readonly binding_kind: "record"; readonly field_bindings: readonly { readonly payload_field: string; readonly source_path: string; readonly value_mode: "direct_value" }[] } {
  if (coordinate.contract_kind === "terminal_recipe" || isWholeVerifiedInput(coordinate)) return "verified_input";
  const scalarValue = (coordinate.binding_summary ?? "").match(/^Scalar `value\(([^)]+)\)`/);
  if (scalarValue) return { binding_kind: "scalar", source_path: scalarValue[1]! };
  const fields = rowFieldNames(coordinate.binding_summary ?? "");
  if (fields.length === 0) return "direct_value";
  const inputFields = new Set<string>();
  for (const field of fields) if (nestedInputType(coordinate.binding_summary ?? "", field.name)) inputFields.add(field.name);
  return {
    binding_kind: "record",
    field_bindings: fields.map((field) => ({
      payload_field: field.name,
      source_path: inputFields.has(field.name) ? "/verified_input" : `/target/${field.name}`,
      value_mode: "direct_value" as const,
    })),
  };
}

export function recipeTargetSchemaId(coordinate: DocumentedDigestRecipeCoordinate): string {
  return targetSchemaId(coordinate);
}
