import { authoritativeModelNames } from "./model-names.js";
import { modelContractRegistry, type ModelFieldContract } from "./generated-model-contracts.js";
import type { ChangeDescriptor, KindSelector, RecipeStaticArgumentValue, RelationSelector, SourceIncludeOptions, StructuralFilter } from "./models.js";
import { authoritativePayloadMetadata } from "./registry-payload-authority.js";
import { authoritativeRegistryDescriptions } from "./registry-descriptions.js";
import { createHash } from "node:crypto";

export interface RegistryEntry {
  id: string;
  description: string;
  definition_revision: number;
  schema_version: number;
  lifecycle_state: "active" | "deprecated" | "retired";
}

export interface ModelRegistryEntry {
  name: (typeof authoritativeModelNames)[number];
  description: string;
  owner_decision: string;
  fields: readonly ModelFieldContract[];
}

const entry = (id: string, description: string): RegistryEntry => ({ id, description: (authoritativeRegistryDescriptions as Readonly<Record<string, string>>)[id.replace(/@\d+$/, "")] ?? (authoritativeRegistryDescriptions as Readonly<Record<string, string>>)[id] ?? description, definition_revision: 1, schema_version: 1, lifecycle_state: "active" });

export const modelRegistry: ModelRegistryEntry[] = modelContractRegistry.map((model) => ({
  name: model.name,
  description: `The ${model.name} fields are defined by ${model.owner_decision}.`,
  owner_decision: model.owner_decision,
  fields: model.fields,
}));

const operationRegistryEntries = [
  entry("core:discover_definitions", "Stable core operation discover definitions."),
  entry("core:find_records", "Stable core operation find records."),
  entry("core:resolve_symbol", "Stable core operation resolve symbol."),
  entry("core:get_outline", "Stable core operation get outline."),
  entry("core:find_references", "Stable core operation find references."),
  entry("core:expand_relations", "Stable core operation expand relations."),
  entry("core:find_paths", "Stable core operation find paths."),
  entry("core:find_artifacts", "Stable core operation find artifacts."),
  entry("core:search_text", "Stable core operation search text."),
  entry("core:search_semantic", "Stable core operation search semantic."),
  entry("core:search_hybrid", "Stable core operation search hybrid."),
  entry("core:get_source", "Stable core operation get source."),
  entry("core:analyze_impact", "Stable core operation analyze impact."),
  entry("core:find_related_tests", "Stable core operation find related tests."),
  entry("core:inspect_architecture", "Stable core operation inspect architecture."),
  entry("core:compare", "Stable core operation compare."),
  entry("core:build_context", "Stable core operation build context."),
  entry("core:index_status", "Stable core operation index status.")
];

const recipeRegistryEntries = [
  entry("core:locate_implementation@1", "Core intent recipe locate implementation."),
  entry("core:understand_change_impact@1", "Core intent recipe understand change impact."),
  entry("core:prepare_symbol_change@1", "Core intent recipe prepare symbol change."),
  entry("core:prepare_new_feature@1", "Core intent recipe prepare new feature."),
  entry("core:trace_behavior@1", "Core intent recipe trace behavior."),
  entry("core:find_relevant_tests@1", "Core intent recipe find relevant tests."),
  entry("core:explain_architecture_slice@1", "Core intent recipe explain architecture slice."),
  entry("core:compare_workspaces@1", "Core intent recipe compare workspaces."),
  entry("core:semantic_to_callers@1", "Core intent recipe semantic to callers."),
  entry("core:resolve_and_find_references@1", "Core intent recipe resolve and find references."),
  entry("core:definition_to_instances@1", "Core intent recipe definition to instances.")
];

export const canonicalSchemaRegistry = [
  entry("core:Bytes@1", "Approved core canonical schema coordinate core:Bytes@1."),
  entry("core:AnalysisRelevantArtifactMetadata@1", "Approved core canonical schema coordinate core:AnalysisRelevantArtifactMetadata@1."),
  entry("core:AnalysisConfiguration@1", "Approved core canonical schema coordinate core:AnalysisConfiguration@1."),
  entry("core:QueryConfiguration@1", "Approved core canonical schema coordinate core:QueryConfiguration@1."),
  entry("core:GeneratorConfiguration@1", "Approved core canonical schema coordinate core:GeneratorConfiguration@1."),
  entry("core:SourceProviderConfiguration@1", "Approved core canonical schema coordinate core:SourceProviderConfiguration@1."),
  entry("core:NormalizedConfigurationLayer@1", "Approved core canonical schema coordinate core:NormalizedConfigurationLayer@1."),
  entry("core:AnalyzerImplementationManifest@1", "Approved core canonical schema coordinate core:AnalyzerImplementationManifest@1."),
  entry("core:RuntimeComponentBehaviorManifest@1", "Approved core canonical schema coordinate core:RuntimeComponentBehaviorManifest@1."),
  entry("core:RuntimeComponentImplementationManifest@1", "Approved core canonical schema coordinate core:RuntimeComponentImplementationManifest@1."),
  entry("core:PluginPackageManifest@1", "Approved core canonical schema coordinate core:PluginPackageManifest@1."),
  entry("core:CoreRegistryManifest@1", "Approved core canonical schema coordinate core:CoreRegistryManifest@1."),
  entry("core:CoreRegistryDefinition@1", "Approved core canonical schema coordinate core:CoreRegistryDefinition@1."),
  entry("core:CandidateRegistryState@1", "Approved core canonical schema coordinate core:CandidateRegistryState@1."),
  entry("core:CompatibilityRequirementValue@1", "Approved core canonical schema coordinate core:CompatibilityRequirementValue@1."),
  entry("core:ArtifactPartitionKey@1", "Approved core canonical schema coordinate core:ArtifactPartitionKey@1."),
  entry("core:CallablePartitionKey@1", "Approved core canonical schema coordinate core:CallablePartitionKey@1."),
  entry("core:FrameworkPartitionKey@1", "Approved core canonical schema coordinate core:FrameworkPartitionKey@1."),
  entry("core:ProjectPartitionKey@1", "Approved core canonical schema coordinate core:ProjectPartitionKey@1."),
  entry("core:FrozenCandidateDigestInputs@1", "Approved core canonical schema coordinate core:FrozenCandidateDigestInputs@1."),
  entry("core:ArtifactAnalysisContext@1", "Approved core canonical schema coordinate core:ArtifactAnalysisContext@1."),
  entry("core:ProjectionSetDigestItem@1", "Approved core canonical schema coordinate core:ProjectionSetDigestItem@1."),
  entry("core:QueryableVectorDigestEntry@1", "Approved core canonical schema coordinate core:QueryableVectorDigestEntry@1."),
  entry("core:RecordSetDigestEntry@1", "Approved core canonical schema coordinate core:RecordSetDigestEntry@1."),
  entry("core:RetentionRootReference@1", "Approved core canonical schema coordinate core:RetentionRootReference@1."),
  entry("core:StoredObjectReference@1", "Approved core canonical schema coordinate core:StoredObjectReference@1."),
  entry("core:VisibleSourceStateSet@1", "Approved core canonical schema coordinate core:VisibleSourceStateSet@1."),
  entry("core:NormalizedResponseBudget@1", "Approved core canonical schema coordinate core:NormalizedResponseBudget@1."),
  entry("core:NormalizedResultProjection@1", "Approved core canonical schema coordinate core:NormalizedResultProjection@1."),
  entry("core:NormalizedIndexStatusProjection@1", "Approved core canonical schema coordinate core:NormalizedIndexStatusProjection@1."),
  entry("core:NormalizedQueryPlan@1", "Approved core canonical schema coordinate core:NormalizedQueryPlan@1."),
  entry("core:RecipeStaticArguments@1", "Approved core canonical schema coordinate core:RecipeStaticArguments@1."),
  entry("core:LocateImplementationArguments@1", "Approved core canonical schema coordinate core:LocateImplementationArguments@1."),
  entry("core:UnderstandChangeImpactArguments@1", "Approved core canonical schema coordinate core:UnderstandChangeImpactArguments@1."),
  entry("core:PrepareSymbolChangeArguments@1", "Approved core canonical schema coordinate core:PrepareSymbolChangeArguments@1."),
  entry("core:PrepareNewFeatureArguments@1", "Approved core canonical schema coordinate core:PrepareNewFeatureArguments@1."),
  entry("core:TraceBehaviorArguments@1", "Approved core canonical schema coordinate core:TraceBehaviorArguments@1."),
  entry("core:FindRelevantTestsArguments@1", "Approved core canonical schema coordinate core:FindRelevantTestsArguments@1."),
  entry("core:ExplainArchitectureSliceArguments@1", "Approved core canonical schema coordinate core:ExplainArchitectureSliceArguments@1."),
  entry("core:CompareWorkspacesArguments@1", "Approved core canonical schema coordinate core:CompareWorkspacesArguments@1."),
  entry("core:SemanticToCallersArguments@1", "Approved core canonical schema coordinate core:SemanticToCallersArguments@1."),
  entry("core:ResolveAndFindReferencesArguments@1", "Approved core canonical schema coordinate core:ResolveAndFindReferencesArguments@1."),
  entry("core:DefinitionToInstancesArguments@1", "Approved core canonical schema coordinate core:DefinitionToInstancesArguments@1."),
  entry("core:ModelAssetManifest@1", "Approved core canonical schema coordinate core:ModelAssetManifest@1."),
  entry("core:ModelPackRuntimeConfiguration@1", "Approved core canonical schema coordinate core:ModelPackRuntimeConfiguration@1."),
  entry("core:TokenizerAssetManifest@1", "Approved core canonical schema coordinate core:TokenizerAssetManifest@1.")
];

const comparatorRegistryEntries = [
  entry("core:record_artifact_dependency_order@1", "Approved core canonical comparator core:record_artifact_dependency_order@1."),
  entry("core:source_observation_order@1", "Approved core canonical comparator core:source_observation_order@1."),
  entry("core:visible_source_state_order@1", "Approved core canonical comparator core:visible_source_state_order@1."),
  entry("core:record_id_order@1", "Approved core canonical comparator core:record_id_order@1."),
  entry("core:projection_record_id_order@1", "Approved core canonical comparator core:projection_record_id_order@1."),
  entry("core:capability_state_order@1", "Approved core canonical comparator core:capability_state_order@1."),
  entry("core:retention_root_order@1", "Approved core canonical comparator core:retention_root_order@1."),
  entry("core:stored_object_order@1", "Approved core canonical comparator core:stored_object_order@1."),
  entry("core:semantic_projection_order@1", "Approved core canonical comparator core:semantic_projection_order@1."),
  entry("core:semantic_coverage_order@1", "Approved core canonical comparator core:semantic_coverage_order@1."),
  entry("core:queryable_vector_order@1", "Approved core canonical comparator core:queryable_vector_order@1."),
  entry("core:participant_ordinal_order@1", "Approved core canonical comparator core:participant_ordinal_order@1."),
  entry("core:registry_definition_order@1", "Approved core canonical comparator core:registry_definition_order@1."),
  entry("core:package_file_path_order@1", "Approved core canonical comparator core:package_file_path_order@1."),
  entry("core:namespace_owner_order@1", "Approved core canonical comparator core:namespace_owner_order@1."),
  entry("core:operation_id_order@1", "Approved core canonical comparator core:operation_id_order@1."),
  entry("core:recipe_id_order@1", "Approved core canonical comparator core:recipe_id_order@1."),
  entry("core:query_manifest_stream_order@1", "Approved core canonical comparator core:query_manifest_stream_order@1.")
];

const operationErrorRegistryEntries = [
  entry("core:request_invalid", "Registered core operation error core:request_invalid."),
  entry("core:api_version_unsupported", "Registered core operation error core:api_version_unsupported."),
  entry("core:unknown_field", "Registered core operation error core:unknown_field."),
  entry("core:option_conflict", "Registered core operation error core:option_conflict."),
  entry("core:budget_invalid", "Registered core operation error core:budget_invalid."),
  entry("core:workspace_not_registered", "Registered core operation error core:workspace_not_registered."),
  entry("core:workspace_not_found", "Registered core operation error core:workspace_not_found."),
  entry("core:duplicate_comparison_participant", "Registered core operation error core:duplicate_comparison_participant."),
  entry("core:participant_role_invalid", "Registered core operation error core:participant_role_invalid."),
  entry("core:snapshot_not_found", "Registered core operation error core:snapshot_not_found."),
  entry("core:snapshot_expired", "Registered core operation error core:snapshot_expired."),
  entry("core:scope_mismatch", "Registered core operation error core:scope_mismatch."),
  entry("core:operation_unknown", "Registered core operation error core:operation_unknown."),
  entry("core:recipe_unknown", "Registered core operation error core:recipe_unknown."),
  entry("core:recipe_version_unsupported", "Registered core operation error core:recipe_version_unsupported."),
  entry("core:stage_reference_invalid", "Registered core operation error core:stage_reference_invalid."),
  entry("core:stage_type_mismatch", "Registered core operation error core:stage_type_mismatch."),
  entry("core:selector_invalid", "Registered core operation error core:selector_invalid."),
  entry("core:selector_not_found", "Registered core operation error core:selector_not_found."),
  entry("core:selector_ambiguous", "Registered core operation error core:selector_ambiguous."),
  entry("core:invalid_query_scope", "Registered core operation error core:invalid_query_scope."),
  entry("core:invalid_definition_instance_selector", "Registered core operation error core:invalid_definition_instance_selector."),
  entry("core:registry_definition_unavailable", "Registered core operation error core:registry_definition_unavailable."),
  entry("core:required_capability_unsupported", "Registered core operation error core:required_capability_unsupported."),
  entry("core:freshness_wait_timeout", "Registered core operation error core:freshness_wait_timeout."),
  entry("core:coverage_incomplete", "Registered core operation error core:coverage_incomplete."),
  entry("core:execution_resource_limit", "Registered core operation error core:execution_resource_limit."),
  entry("core:operation_cancelled", "Registered core operation error core:operation_cancelled."),
  entry("core:execution_failed", "Registered core operation error core:execution_failed."),
  entry("core:index_unavailable", "Registered core operation error core:index_unavailable."),
  entry("core:daemon_restart_required", "Registered core operation error core:daemon_restart_required."),
  entry("core:cursor_invalid", "Registered core operation error core:cursor_invalid."),
  entry("core:cursor_expired", "Registered core operation error core:cursor_expired."),
  entry("core:query_execution_evicted", "Registered core operation error core:query_execution_evicted."),
  entry("core:cursor_kind_mismatch", "Registered core operation error core:cursor_kind_mismatch."),
  entry("core:cursor_stream_mismatch", "Registered core operation error core:cursor_stream_mismatch."),
  entry("core:cursor_projection_mismatch", "Registered core operation error core:cursor_projection_mismatch."),
  entry("core:query_embedding_failed", "Registered core operation error core:query_embedding_failed."),
  entry("core:source_unavailable", "Registered core operation error core:source_unavailable."),
  entry("core:snippet_budget_impossible", "Registered core operation error core:snippet_budget_impossible."),
  entry("core:retained_definition_unavailable", "Registered core operation error core:retained_definition_unavailable."),
  entry("core:embedding_profile_not_found", "Registered core operation error core:embedding_profile_not_found."),
  entry("core:embedding_profile_incompatible", "Registered core operation error core:embedding_profile_incompatible."),
  entry("core:semantic_index_unavailable", "Registered core operation error core:semantic_index_unavailable."),
  entry("core:semantic_coverage_incomplete", "Registered core operation error core:semantic_coverage_incomplete."),
  entry("core:index_contract_unsupported", "Registered core operation error core:index_contract_unsupported."),
  entry("core:index_integrity_failed", "Registered core operation error core:index_integrity_failed.")
];

const diagnosticRegistryEntries = [
  entry("core:parse_failed", "Registered core diagnostic core:parse_failed."),
  entry("core:unsupported_construct", "Registered core diagnostic core:unsupported_construct."),
  entry("core:unresolved_symbol", "Registered core diagnostic core:unresolved_symbol."),
  entry("core:ambiguous_target", "Registered core diagnostic core:ambiguous_target."),
  entry("core:missing_dependency", "Registered core diagnostic core:missing_dependency."),
  entry("core:capability_unavailable", "Registered core diagnostic core:capability_unavailable."),
  entry("core:framework_model_incomplete", "Registered core diagnostic core:framework_model_incomplete."),
  entry("core:semantic_document_generation_failed", "Registered core diagnostic core:semantic_document_generation_failed."),
  entry("core:embedding_segmentation_failed", "Registered core diagnostic core:embedding_segmentation_failed."),
  entry("core:embedding_generation_failed", "Registered core diagnostic core:embedding_generation_failed.")
];

const candidateIssueRegistryEntries = [
  entry("core:invalidation_plan_incomplete", "Registered core candidate issue core:invalidation_plan_incomplete."),
  entry("core:work_manifest_inconsistent", "Registered core candidate issue core:work_manifest_inconsistent."),
  entry("core:source_observation_conflict", "Registered core candidate issue core:source_observation_conflict."),
  entry("core:source_input_unavailable", "Registered core candidate issue core:source_input_unavailable."),
  entry("core:source_provider_state_changed", "Registered core candidate issue core:source_provider_state_changed."),
  entry("core:source_provider_unavailable", "Registered core candidate issue core:source_provider_unavailable."),
  entry("core:source_provider_deadline_exceeded", "Registered core candidate issue core:source_provider_deadline_exceeded."),
  entry("core:source_provider_resource_exhausted", "Registered core candidate issue core:source_provider_resource_exhausted."),
  entry("core:source_provider_failed", "Registered core candidate issue core:source_provider_failed."),
  entry("core:analysis_context_unavailable", "Registered core candidate issue core:analysis_context_unavailable."),
  entry("core:analyzer_failed", "Registered core candidate issue core:analyzer_failed."),
  entry("core:analyzer_timeout", "Registered core candidate issue core:analyzer_timeout."),
  entry("core:plugin_inputs_incomplete", "Registered core candidate issue core:plugin_inputs_incomplete."),
  entry("core:plugin_unsupported", "Registered core candidate issue core:plugin_unsupported."),
  entry("core:plugin_cancelled", "Registered core candidate issue core:plugin_cancelled."),
  entry("core:plugin_resource_exhausted", "Registered core candidate issue core:plugin_resource_exhausted."),
  entry("core:plugin_failed", "Registered core candidate issue core:plugin_failed."),
  entry("core:required_delta_missing", "Registered core candidate issue core:required_delta_missing."),
  entry("core:delta_id_conflict", "Registered core candidate issue core:delta_id_conflict."),
  entry("core:delta_base_mismatch", "Registered core candidate issue core:delta_base_mismatch."),
  entry("core:delta_scope_mismatch", "Registered core candidate issue core:delta_scope_mismatch."),
  entry("core:undeclared_input", "Registered core candidate issue core:undeclared_input."),
  entry("core:record_schema_invalid", "Registered core candidate issue core:record_schema_invalid."),
  entry("core:unregistered_identifier", "Registered core candidate issue core:unregistered_identifier."),
  entry("core:reference_validation_failed", "Registered core candidate issue core:reference_validation_failed."),
  entry("core:dependency_validation_failed", "Registered core candidate issue core:dependency_validation_failed."),
  entry("core:replacement_scope_incomplete", "Registered core candidate issue core:replacement_scope_incomplete."),
  entry("core:identity_assignment_conflict", "Registered core candidate issue core:identity_assignment_conflict."),
  entry("core:candidate_digest_mismatch", "Registered core candidate issue core:candidate_digest_mismatch."),
  entry("core:projection_generator_failed", "Registered core candidate issue core:projection_generator_failed."),
  entry("core:projection_output_invalid", "Registered core candidate issue core:projection_output_invalid."),
  entry("core:projection_digest_mismatch", "Registered core candidate issue core:projection_digest_mismatch."),
  entry("core:base_snapshot_changed", "Registered core candidate issue core:base_snapshot_changed."),
  entry("core:base_registry_changed", "Registered core candidate issue core:base_registry_changed."),
  entry("core:base_configuration_changed", "Registered core candidate issue core:base_configuration_changed."),
  entry("core:publication_conflict", "Registered core candidate issue core:publication_conflict."),
  entry("core:atomic_publication_failed", "Registered core candidate issue core:atomic_publication_failed."),
  entry("core:candidate_cleanup_failed", "Registered core candidate issue core:candidate_cleanup_failed.")
];

export const languageRegistry = [
  entry("javascript", "ECMAScript source and declaration semantics, including configured JSX syntax."),
  entry("typescript", "TypeScript source and declaration semantics, including configured TSX syntax."),
];

export const universalEntityKinds = [
  "core:container", "core:type", "core:callable", "core:value", "core:operation", "core:resource", "core:construct",
  "core:declaration", "core:definition", "core:scope", "core:member", "core:member_container", "core:parameter", "core:type_parameter", "core:literal",
] as const;

export const universalRelationKinds = [
  "core:contains", "core:defines", "core:aliases", "core:type_of", "core:references", "core:call", "core:read", "core:write", "core:import", "core:export",
  "core:inherits", "core:implements", "core:overrides", "core:returns", "core:binds_argument", "core:captures", "core:throws", "core:handles", "core:depends_on", "core:binds", "core:covers",
] as const;

export const capabilityRegistry = [
  "core:syntax_structure", "core:symbol_declarations", "core:symbol_resolution", "core:type_information",
  "core:module_dependencies", "core:call_relationships", "core:inheritance_and_implementation", "core:control_flow",
  "core:data_flow", "core:effects", "core:test_relationships", "core:framework_semantics", "core:semantic_preparation", "core:semantic_retrieval",
] as const;

export const constructRegistry = [
  "core:dynamic_import", "core:computed_property", "core:runtime_dispatch", "core:generated_declaration",
  "core:external_declaration", "core:macro_expansion", "core:reflection", "core:eval_like_execution",
] as const;

export const limitationRegistry = [
  "core:unsupported_construct", "core:ambiguous_resolution", "core:external_input_unavailable",
  "core:analysis_budget_exhausted", "core:generated_source_unavailable", "core:framework_model_missing",
] as const;

export const facetRegistry = [
  "core:declaration", "core:definition", "core:scope", "core:member", "core:member_container", "core:parameter",
  "core:type_parameter", "core:literal", "core:constructible", "core:abstract", "core:async", "core:generator",
  "core:call_site", "core:read_site", "core:write_site", "core:return_site", "core:import_site", "core:export_site",
  "core:branch_site", "core:flow_step", "core:synthetic", "core:implicit", "core:generated", "core:external",
  "core:structural_relation", "core:reference_relation", "core:dependency_relation", "core:flow_relation", "core:binding_relation",
  "core:construction", "core:conditional", "core:indirect", "core:type_only", "core:reexport",
] as const;

export const semanticRoleRegistry = [
  "core:entry_point", "core:test", "core:endpoint", "core:configuration", "core:persistence", "core:event_handler", "core:event_source", "core:event_sink",
] as const;

export const effectRegistry = [
  "core:mutation", "core:io", "core:network", "core:persistence", "core:exception", "core:concurrency", "core:nondeterminism",
] as const;

export const factKindRegistry = [
  "core:semantic_role", "core:metric", "core:constant_value", "core:reachability", "core:effect", "core:deprecation", "core:assertion",
] as const;

export interface OperationDefinition {
  operation_id: string;
  operation_version: number;
  public_api_version: number;
  description: string;
  argument_schema_id: string;
  argument_schema_version: number;
  allowed_scope_kinds: readonly ("single_workspace" | "comparison")[];
  result_subject_types: readonly string[];
  argument_fields: readonly ModelFieldContract[];
  argument_schema: OperationArgumentSchema;
  result_streams: readonly string[];
  result_stream_definitions: readonly OperationResultStreamDefinition[];
  batchable_fields: readonly string[];
  ordering_comparator_id: string;
  ordering_comparator_version: number;
  lifecycle_state: "active" | "deprecated" | "retired";
}

export interface PayloadPropertySchema {
  type: "string" | "integer" | "boolean" | "array" | "object";
  description: string;
  enum?: readonly string[];
  items?: PayloadPropertySchema;
  properties?: Readonly<Record<string, PayloadPropertySchema>>;
  required?: readonly string[];
  additionalProperties?: false;
  schema_id?: string;
  schema_version?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  oneOf?: readonly PayloadPropertySchema[];
  anyOf?: readonly PayloadPropertySchema[];
}

export interface OperationArgumentSchema {
  type: "object";
  additionalProperties: false;
  properties: Readonly<Record<string, PayloadPropertySchema>>;
  required: readonly string[];
}

export interface OperationResultStreamDefinition {
  stream_name: string;
  item_type: string;
  item_schema_id: string;
  item_schema_version: number;
  classifications: readonly string[];
  fields: readonly string[];
}

export interface RecipeArgumentBindingDefinition {
  recipe_argument_path?: string;
  source_output_reference?: string;
  stage_id: string;
  stage_argument_path: string;
}

export interface RecipeStageDefinition {
  stage_id: string;
  operator_id: string;
  operator_version: number;
  input_references: readonly string[];
  static_arguments: Readonly<Record<string, RecipeStaticArgumentValue>>;
  static_arguments_schema_id: string;
  static_arguments_schema_version: number;
  static_arguments_schema_coordinate: string;
  partial_arguments_schema_id: string;
  partial_arguments_schema_version: number;
  partial_arguments_schema_coordinate: string;
  argument_bindings: readonly RecipeArgumentBindingDefinition[];
}

export interface RecipeGuardDefinition {
  guard_id: string;
  evaluation_point: "before_stage" | "after_stage" | "before_output";
  predicate_code: string;
  failure_error_code: readonly string[];
  guard_code: string;
  stage_id: string;
  failure_code: string;
}

export interface RecipeOutputDefinition {
  output_name: string;
  stage_id: string;
  stage_output: string;
  projection: "subjects" | "relations" | "paths" | "definitions";
}

export interface RecipePaginationStreamDefinition {
  stream_name: string;
  output_name: string;
  classification: "confirmed" | "possible" | "unclassified";
  classifications: readonly ("confirmed" | "possible" | "unclassified")[];
  ordering_id: string;
  ordering_comparator_id: string;
  ordering_comparator_version: number;
}

export interface RecipeDefinition {
  recipe_id: string;
  recipe_version: number;
  public_api_version: number;
  description: string;
  argument_schema_id: string;
  argument_schema_version: number;
  stages: readonly RecipeStageDefinition[];
  operation_stages: readonly RecipeStageDefinition[];
  argument_bindings: readonly RecipeArgumentBindingDefinition[];
  guards: readonly RecipeGuardDefinition[];
  streams: readonly RecipePaginationStreamDefinition[];
  required_capabilities: readonly string[];
  ranking_bindings: readonly { stage_id: string; ranking_profile_id: string; ranking_profile_version: number }[];
  outputs: readonly RecipeOutputDefinition[];
  pagination_streams: readonly RecipePaginationStreamDefinition[];
  completeness_policy: "report";
  recipe_digest: string;
  lifecycle_state: "active" | "deprecated" | "retired";
}

export interface ComparatorSortKeyDefinition {
  value_path: string;
  comparison_mode: "uce_bytes" | "text_utf8" | "bytes_lexicographic" | "safe_integer_numeric" | "big_integer_numeric" | "float64_numeric" | "exact_decimal_numeric" | "timestamp_chronological" | "digest_bytes";
  direction: "ascending" | "descending";
  absent_order: "forbidden" | "first" | "last";
}

export interface ComparatorDefinition {
  comparator_id: string;
  comparator_version: number;
  definition_revision: number;
  schema_version: number;
  description: string;
  sort_keys: readonly ComparatorSortKeyDefinition[];
  lifecycle_state: "active" | "deprecated" | "retired";
}

export interface RegistryPayloadSchema {
  type: "object";
  additionalProperties: false;
  properties: Readonly<Record<string, PayloadPropertySchema>>;
  required: readonly string[];
}

export interface OperationErrorDefinition {
  code: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  retryable_default: boolean | "conditional";
  recovery_actions: readonly string[];
  details_schema: RegistryPayloadSchema;
  lifecycle_state: "active" | "deprecated" | "retired";
}

export interface DiagnosticDefinition {
  code: string;
  definition_revision: number;
  schema_version: number;
  diagnostic_category: string;
  title: string;
  description: string;
  emission_condition: string;
  default_severity: "info" | "warning" | "error";
  allowed_severities: readonly ("info" | "warning" | "error")[];
  allowed_scope_types: readonly ("record" | "artifact" | "capability")[];
  payload_schema: RegistryPayloadSchema;
  lifecycle_state: "active" | "deprecated" | "retired";
}

export interface CandidateIssueDefinition {
  issue_code: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  issue_category: "planning" | "analysis" | "validation" | "projection" | "publication" | "cleanup";
  allowed_phases: readonly string[];
  default_severity: "info" | "warning" | "error";
  allowed_severities: readonly ("info" | "warning" | "error")[];
  default_retryability: "retry_same" | "reanalyze" | "replan" | "not_retryable";
  allowed_retryabilities: readonly ("retry_same" | "reanalyze" | "replan" | "not_retryable")[];
  payload_schema: RegistryPayloadSchema;
  lifecycle_state: "active" | "deprecated" | "retired";
}

const operationErrorDetails: Readonly<Record<string, readonly string[]>> = {
  "core:workspace_not_registered": ["registration_command"],
  "core:request_invalid": ["schema_pointer", "violation"], "core:api_version_unsupported": ["requested_version", "supported_versions"], "core:unknown_field": ["object_pointer", "field_names"], "core:option_conflict": ["option_pointers", "rule_code"], "core:budget_invalid": ["budget_field", "provided", "minimum", "maximum"], "core:workspace_not_found": ["workspace_id"], "core:duplicate_comparison_participant": ["workspace_id", "snapshot_ids", "roles", "participant_ordinals"], "core:participant_role_invalid": ["operation", "provided_roles", "required_roles"], "core:snapshot_not_found": ["workspace_id", "snapshot_id"], "core:snapshot_expired": ["workspace_id", "snapshot_id", "generation", "expired_at"], "core:scope_mismatch": ["query_execution_id", "expected_scope_digest", "provided_scope_digest"], "core:operation_unknown": ["operation", "api_version"], "core:recipe_unknown": ["recipe_id"], "core:recipe_version_unsupported": ["recipe_id", "requested_version", "supported_versions"], "core:stage_reference_invalid": ["stage_id", "input_ordinal", "referenced_stage_id", "referenced_output"], "core:stage_type_mismatch": ["stage_id", "input_ordinal", "actual_type", "expected_types"], "core:selector_invalid": ["selector_pointer", "reason_code", "definition_ids"], "core:selector_not_found": ["recipe_id", "stage_id", "selector_pointer", "possible_candidate_ids"], "core:selector_ambiguous": ["recipe_id", "stage_id", "selector_pointer", "confirmed_candidate_ids", "possible_candidate_ids"], "core:invalid_query_scope": ["recipe_id", "required_scope_kind", "required_roles", "provided_scope_kind", "provided_roles"], "core:invalid_definition_instance_selector": ["recipe_id", "definition_ids", "definition_types", "reason_code"], "core:registry_definition_unavailable": ["definition_id", "definition_type", "registry_snapshot_ids"], "core:required_capability_unsupported": ["capability", "workspace_snapshot_binding_ids", "reason_codes"], "core:freshness_wait_timeout": ["workspace_ids", "waited_ms", "pending_observation_counts", "retry_after_ms?"], "core:coverage_incomplete": ["capabilities", "workspace_snapshot_binding_ids", "statuses", "waited_ms"], "core:execution_resource_limit": ["limit_kind", "configured_limit", "observed_or_required", "stage_id?"], "core:operation_cancelled": ["stage_id?"], "core:execution_failed": ["failure_id", "phase"], "core:index_unavailable": ["workspace_id", "index_state", "candidate_generation_id?"], "core:daemon_restart_required": ["data_root_id", "detected_engine_build_id", "required_engine_build_id", "blocking_reason", "safe_automatic_restart"], "core:cursor_invalid": ["reason_code"], "core:cursor_expired": ["query_execution_id", "expired_at"], "core:query_execution_evicted": ["query_execution_id", "evicted_at", "reason_code"], "core:cursor_kind_mismatch": ["expected_cursor_kind", "actual_cursor_kind", "execution_id"], "core:cursor_stream_mismatch": ["query_execution_id", "result_stream"], "core:cursor_projection_mismatch": ["execution_id", "expected_projection_digest", "provided_projection_digest"], "core:query_embedding_failed": ["semantic_lane_id", "embedding_profile_id", "failure_code"], "core:source_unavailable": ["workspace_snapshot_binding_id", "artifact_id", "artifact_version_id", "content_digest"], "core:snippet_budget_impossible": ["required_minimum_characters", "provided_max_characters"], "core:retained_definition_unavailable": ["registry_snapshot_id", "definition_ids"],
  "core:embedding_profile_not_found": ["embedding_profile_id", "workspace_snapshot_binding_ids"], "core:embedding_profile_incompatible": ["embedding_profile_id", "semantic_lane_id", "incompatibility_reasons", "workspace_snapshot_binding_ids"], "core:semantic_index_unavailable": ["semantic_lane_id", "embedding_profile_id", "workspace_snapshot_binding_ids", "unavailability_reason", "last_materialization_id?"], "core:semantic_coverage_incomplete": ["semantic_lane_ids", "workspace_snapshot_binding_ids", "materialization_ids", "pending_artifact_count", "unsupported_artifact_count", "failed_artifact_count", "waited_milliseconds", "retry_after_milliseconds?"], "core:index_contract_unsupported": ["contract_kind", "registry_snapshot_ids", "uce_error_code", "canonical_encoding_version?", "hash_algorithm?", "schema_id?", "schema_version?", "digest_domain?", "comparator_id?", "comparator_version?", "digest_recipe_id?", "digest_recipe_version?", "digest_reference_id?", "external_verification_contract_id?", "external_verification_contract_version?"], "core:index_integrity_failed": ["snapshot_ids", "component_kind", "component_ids", "integrity_failure_kind", "uce_error_code?", "expected_digest?", "actual_digest?", "affected_capability?"]
};

const errorPolicy: Readonly<Record<string, { retryable: boolean | "conditional"; recovery: readonly string[] }>> = {
  "core:workspace_not_registered": { retryable: false, recovery: ["register_workspace"] },
  "core:request_invalid": { retryable: false, recovery: ["correct_request"] }, "core:api_version_unsupported": { retryable: false, recovery: ["select_supported_version"] }, "core:unknown_field": { retryable: false, recovery: ["remove_unknown_fields"] }, "core:option_conflict": { retryable: false, recovery: ["correct_request"] }, "core:budget_invalid": { retryable: false, recovery: ["use_advertised_budget"] }, "core:workspace_not_found": { retryable: false, recovery: ["inspect_index_status", "register_workspace"] }, "core:duplicate_comparison_participant": { retryable: false, recovery: ["correct_scope"] }, "core:participant_role_invalid": { retryable: false, recovery: ["correct_scope"] }, "core:snapshot_not_found": { retryable: false, recovery: ["inspect_index_status", "select_snapshot"] }, "core:snapshot_expired": { retryable: false, recovery: ["select_retained_snapshot", "reexecute_current"] }, "core:scope_mismatch": { retryable: false, recovery: ["use_original_scope"] }, "core:operation_unknown": { retryable: false, recovery: ["select_supported_operation"] }, "core:recipe_unknown": { retryable: false, recovery: ["select_supported_recipe"] }, "core:recipe_version_unsupported": { retryable: false, recovery: ["select_supported_recipe_version"] }, "core:stage_reference_invalid": { retryable: false, recovery: ["correct_pipeline"] }, "core:stage_type_mismatch": { retryable: false, recovery: ["correct_pipeline"] }, "core:selector_invalid": { retryable: false, recovery: ["correct_selector", "discover_definitions"] }, "core:selector_not_found": { retryable: false, recovery: ["correct_selector", "discover_definitions", "inspect_completeness"] }, "core:selector_ambiguous": { retryable: false, recovery: ["add_symbol_context", "select_exact_subject"] }, "core:invalid_query_scope": { retryable: false, recovery: ["correct_scope"] }, "core:invalid_definition_instance_selector": { retryable: false, recovery: ["correct_selector", "discover_definitions"] }, "core:registry_definition_unavailable": { retryable: false, recovery: ["discover_definitions", "select_available_definition"] }, "core:required_capability_unsupported": { retryable: false, recovery: ["inspect_index_status", "select_supported_scope"] }, "core:freshness_wait_timeout": { retryable: true, recovery: ["retry_after_progress", "increase_wait_limit", "accept_current"] }, "core:coverage_incomplete": { retryable: true, recovery: ["retry_after_progress", "accept_reported_coverage", "inspect_index_status"] }, "core:execution_resource_limit": { retryable: "conditional", recovery: ["increase_limit", "narrow_scope", "split_investigation"] }, "core:operation_cancelled": { retryable: true, recovery: ["retry_operation"] }, "core:execution_failed": { retryable: "conditional", recovery: ["retry_operation", "inspect_daemon_status"] }, "core:index_unavailable": { retryable: true, recovery: ["wait_for_index", "inspect_index_status", "reindex"] }, "core:daemon_restart_required": { retryable: "conditional", recovery: ["wait_for_active_work", "restart_urdira", "use_matching_urdira_version", "inspect_daemon_status"] }, "core:cursor_invalid": { retryable: false, recovery: ["reexecute_query"] }, "core:cursor_expired": { retryable: false, recovery: ["reexecute_query"] }, "core:query_execution_evicted": { retryable: false, recovery: ["reexecute_query"] }, "core:cursor_kind_mismatch": { retryable: false, recovery: ["use_matching_continuation"] }, "core:cursor_stream_mismatch": { retryable: false, recovery: ["use_query_continuation"] }, "core:cursor_projection_mismatch": { retryable: false, recovery: ["use_original_projection", "reexecute_query"] }, "core:query_embedding_failed": { retryable: true, recovery: ["retry_operation", "restore_generator", "inspect_semantic_coverage"] }, "core:source_unavailable": { retryable: "conditional", recovery: ["verify_index", "restore_verified_data", "reexecute_without_snippets"] }, "core:snippet_budget_impossible": { retryable: false, recovery: ["increase_budget", "reduce_snippet_projection"] }, "core:retained_definition_unavailable": { retryable: false, recovery: ["verify_index", "restore_verified_data"] }, "core:embedding_profile_not_found": { retryable: false, recovery: ["inspect_index_status", "repair_workspace_configuration", "install_required_model_pack", "reindex"] }, "core:embedding_profile_incompatible": { retryable: false, recovery: ["inspect_semantic_coverage", "repair_workspace_configuration", "install_compatible_model_pack", "reindex"] }, "core:semantic_index_unavailable": { retryable: true, recovery: ["wait_for_index", "restore_generator", "repair_workspace_configuration", "allow_fallback"] }, "core:semantic_coverage_incomplete": { retryable: true, recovery: ["retry_after_progress", "increase_wait_limit", "accept_partial_coverage", "inspect_semantic_coverage"] }, "core:index_contract_unsupported": { retryable: false, recovery: ["restore_compatible_decoder", "update_engine", "restore_verifier", "inspect_index_contracts"] }, "core:index_integrity_failed": { retryable: true, recovery: ["verify_index", "restore_verified_data", "rebuild_from_retained_inputs", "select_another_snapshot"] },
};

const payloadProperty = (code: string, name: string): PayloadPropertySchema => {
  const authority = authoritativePayloadMetadata[`${code}.${name}` as keyof typeof authoritativePayloadMetadata] as PayloadPropertySchema | undefined;
  if (!authority) throw new Error(`Missing authoritative payload metadata for ${code}.${name}`);
  const arrayNames = new Set(["supported_versions", "field_names", "option_pointers", "provided_roles", "required_roles", "definition_ids", "possible_candidate_ids", "confirmed_candidate_ids", "registry_snapshot_ids", "workspace_ids", "capabilities", "workspace_snapshot_binding_ids", "pending_observation_counts", "semantic_lane_ids", "materialization_ids", "snapshot_ids", "work_item_ids", "source_observation_ids", "replacement_scope_ids", "undeclared_ids", "json_pointers", "uce_error_codes", "missing_capabilities", "embedding_segment_projection_ids", "replacement_scope_ids", "identity_ids", "record_ids", "proposal_record_keys", "candidate_identity_keys", "missing_proposal_keys", "missing_partition_keys", "component_ids", "definition_types", "reason_codes"]);
  const integerNames = new Set(["requested_version", "api_version", "schema_version", "generation", "participant_ordinals", "waited_ms", "retry_after_ms", "waited_milliseconds", "retry_after_milliseconds", "pending_artifact_count", "unsupported_artifact_count", "failed_artifact_count", "failure_offset", "recovered_region_count", "observed_dimensions", "elapsed_ms", "observed_or_required", "provided", "minimum", "maximum", "configured_limit", "timeout_ms", "expected_dimensions", "validation_error_count", "invalid_projection_count", "required_minimum_characters", "provided_max_characters", "maximum_document_tokens", "canonical_encoding_version", "comparator_version", "digest_recipe_version", "external_verification_contract_version", "unresolved_scope_count"]);
  const booleanNames = new Set(["safe_automatic_restart", "fallback_attempted", "transaction_rolled_back", "candidate_set_complete"]);
  const inferred: PayloadPropertySchema = booleanNames.has(name)
    ? { type: "boolean", description: authority.description }
    : integerNames.has(name)
      ? { type: "integer", minimum: ["requested_version", "api_version", "schema_version", "canonical_encoding_version", "comparator_version", "digest_recipe_version", "external_verification_contract_version", "retry_after_milliseconds", "validation_error_count", "invalid_projection_count", "configured_limit", "timeout_ms", "expected_dimensions", "required_minimum_characters", "provided_max_characters", "maximum_document_tokens", "unresolved_scope_count"].includes(name) ? 1 : 0, description: authority.description }
      : arrayNames.has(name) || name.endsWith("_ids") || name.endsWith("_codes") || name.endsWith("_pointers")
        ? { type: "array", ...(["workspace_snapshot_binding_ids", "semantic_lane_ids", "missing_capabilities", "embedding_segment_projection_ids", "undeclared_ids", "reason_codes"].includes(name) ? { minItems: 1 } : {}), items: { type: "string", description: "A registered payload identifier." }, description: authority.description }
        : { type: "string", description: authority.description };
  return { ...inferred, ...authority };
};
const closedPayload = (code: string): RegistryPayloadSchema => {
  const names = operationErrorDetails[code];
  if (!names || names.length === 0) throw new Error(`Missing operation-error details schema for ${code}`);
  const properties = Object.fromEntries(names.map((name) => { const fieldName = name.replace(/\?$/, ""); return [fieldName, payloadProperty(code, fieldName)]; }));
  return { type: "object", additionalProperties: false, properties, required: names.filter((name) => !name.endsWith("?")).map((name) => name.replace(/\?$/, "")) };
};

const diagnosticPayloadFields: Readonly<Record<string, readonly string[]>> = {
  "core:parse_failed": ["language_id", "parser_error_code?", "failure_offset?", "recovered_region_count"],
  "core:unsupported_construct": ["language_id", "construct_kind", "missing_capabilities", "support_level"],
  "core:unresolved_symbol": ["symbol", "namespace?", "resolution_phase", "candidate_entity_ids"],
  "core:ambiguous_target": ["relation_kind", "symbol", "candidate_entity_ids", "candidate_set_complete"],
  "core:missing_dependency": ["specifier", "dependency_kind", "requested_from_artifact_id", "expected_source_kind?"],
  "core:capability_unavailable": ["capability", "reason", "construct_kind"],
  "core:framework_model_incomplete": ["framework_id", "model_version", "construct_kind", "missing_model_feature"],
  "core:semantic_document_generation_failed": ["subject_type", "entity_id", "generation_phase", "generator_error_code", "violated_invariant"],
  "core:embedding_segmentation_failed": ["embedding_profile_id", "semantic_document_projection_id", "segmentation_phase", "segmenter_error_code", "maximum_document_tokens", "violated_invariant"],
  "core:embedding_generation_failed": ["embedding_profile_id", "embedding_segment_projection_ids", "failure_kind", "generator_error_code", "expected_dimensions", "observed_dimensions"],
};
const diagnosticCategories: Readonly<Record<string, string>> = { "core:parse_failed": "syntax", "core:unsupported_construct": "capability", "core:unresolved_symbol": "resolution", "core:ambiguous_target": "resolution", "core:missing_dependency": "dependency", "core:capability_unavailable": "capability", "core:framework_model_incomplete": "framework_model", "core:semantic_document_generation_failed": "semantic_projection", "core:embedding_segmentation_failed": "semantic_projection", "core:embedding_generation_failed": "semantic_projection" };
const diagnosticTitles: Readonly<Record<string, string>> = { "core:parse_failed": "Parse failed", "core:unsupported_construct": "Unsupported source construct", "core:unresolved_symbol": "Symbol could not be resolved", "core:ambiguous_target": "Multiple targets remain possible", "core:missing_dependency": "Required analysis dependency is unavailable", "core:capability_unavailable": "Required capability is unavailable", "core:framework_model_incomplete": "Framework model is incomplete", "core:semantic_document_generation_failed": "Semantic document generation failed", "core:embedding_segmentation_failed": "Embedding segmentation failed", "core:embedding_generation_failed": "Embedding generation failed" };
const diagnosticEmissionConditions: Readonly<Record<string, string>> = {
  "core:parse_failed": "Emit only when the selected language parser cannot produce the syntax representation required for one or more regions of an exact artifact version.",
  "core:unsupported_construct": "Emit only when the producer recognizes a concrete source construct but does not implement one or more semantic capabilities required to model it.",
  "core:unresolved_symbol": "Emit only after the configured resolution pipeline finishes without binding a concrete symbol reference to a confirmed entity.",
  "core:ambiguous_target": "Emit only when resolution retains two or more mutually competing target entities and cannot confirm one unique target for the exact relation argument.",
  "core:missing_dependency": "Emit only when a concrete source construct names or requires a dependency whose source or semantic model cannot be obtained through the configured source providers and resolvers.",
  "core:capability_unavailable": "Emit only when a concrete source construct requires a capability that no active compatible producer supplies for that construct and artifact.",
  "core:framework_model_incomplete": "Emit only when a recognized framework construct is within the selected model's domain but the identified model version lacks a rule or metadata needed to derive the requested semantics.",
  "core:semantic_document_generation_failed": "Emit only after semantic scope selection when text preparation or document construction terminates unsuccessfully or violates the registered document schema or complete artifact-text coverage invariant.",
  "core:embedding_segmentation_failed": "Emit only when a valid semantic document exists but segment construction fails or violates mapping, source coverage, ordering, or token-limit validation.",
  "core:embedding_generation_failed": "Emit only when inference terminates unsuccessfully or output fails profile dimension, encoding, finiteness, normalization, digest, or repeatability validation.",
};
const diagnosticSeverities: Readonly<Record<string, "info" | "warning" | "error">> = { "core:parse_failed": "error", "core:unsupported_construct": "warning", "core:unresolved_symbol": "warning", "core:ambiguous_target": "warning", "core:missing_dependency": "warning", "core:capability_unavailable": "warning", "core:framework_model_incomplete": "warning", "core:semantic_document_generation_failed": "warning", "core:embedding_segmentation_failed": "warning", "core:embedding_generation_failed": "warning" };
const diagnosticAllowedSeverities: Readonly<Record<string, readonly ("info" | "warning" | "error")[]>> = { "core:parse_failed": ["warning", "error"], "core:unsupported_construct": ["info", "warning", "error"], "core:unresolved_symbol": ["info", "warning", "error"], "core:ambiguous_target": ["info", "warning"], "core:missing_dependency": ["warning", "error"], "core:capability_unavailable": ["info", "warning", "error"], "core:framework_model_incomplete": ["warning", "error"], "core:semantic_document_generation_failed": ["warning", "error"], "core:embedding_segmentation_failed": ["warning", "error"], "core:embedding_generation_failed": ["warning", "error"] };
const diagnosticScopes: Readonly<Record<string, readonly ("record" | "artifact" | "capability")[]>> = { "core:parse_failed": ["artifact", "capability"], "core:unsupported_construct": ["record", "artifact", "capability"], "core:unresolved_symbol": ["record", "artifact", "capability"], "core:ambiguous_target": ["record", "artifact", "capability"], "core:missing_dependency": ["artifact", "capability"], "core:capability_unavailable": ["artifact", "capability"], "core:framework_model_incomplete": ["record", "artifact", "capability"], "core:semantic_document_generation_failed": ["record", "artifact", "capability"], "core:embedding_segmentation_failed": ["artifact", "capability"], "core:embedding_generation_failed": ["artifact", "capability"] };
const diagnosticPayloads: Readonly<Record<string, RegistryPayloadSchema>> = Object.fromEntries(Object.entries(diagnosticPayloadFields).map(([code, fields]) => [code, { type: "object", additionalProperties: false, properties: Object.fromEntries(fields.map((name) => { const fieldName = name.replace(/\?$/, ""); return [fieldName, payloadProperty(code, fieldName)]; })), required: fields.filter((name) => !name.endsWith("?")).map((name) => name.replace(/\?$/, "")) }]));

const candidateIssueFields: Readonly<Record<string, readonly string[]>> = {
  "core:invalidation_plan_incomplete": ["invalidation_plan_id", "unresolved_scope_count", "reason_codes", "fallback_attempted", "representative_artifact_ids?"], "core:work_manifest_inconsistent": ["work_manifest_id", "invariant_code", "work_item_ids", "json_pointer?"], "core:source_observation_conflict": ["artifact_id", "source_observation_ids", "conflict_kind", "provider_sequence_values?"], "core:source_input_unavailable": ["artifact_id", "source_observation_id", "availability_code", "provider_error_code?"], "core:source_provider_state_changed": ["request_id", "source_provider_binding_id", "call", "request_digest", "provider_error_code?"], "core:source_provider_unavailable": ["request_id", "source_provider_binding_id", "call", "request_digest", "provider_error_code?", "provider_detail_code?"], "core:source_provider_deadline_exceeded": ["request_id", "source_provider_binding_id", "call", "timeout_ms", "provider_error_code?"], "core:source_provider_resource_exhausted": ["request_id", "source_provider_binding_id", "call", "resource_kind", "configured_limit", "observed_or_required", "provider_error_code?"], "core:source_provider_failed": ["request_id", "source_provider_binding_id", "call", "provider_error_code", "provider_detail_code?"], "core:analysis_context_unavailable": ["missing_context_kind", "missing_context_id", "plugin_id?", "plugin_version?"],
  "core:analyzer_failed": ["work_item_id", "plugin_id", "plugin_version", "analyzer_error_code", "failure_stage", "provider_detail_code?"], "core:analyzer_timeout": ["work_item_id", "plugin_id", "timeout_ms", "elapsed_ms"], "core:plugin_inputs_incomplete": ["request_id", "plugin_id", "call", "missing_input_kind", "missing_input_reference?"], "core:plugin_unsupported": ["request_id", "plugin_id", "call", "capability", "provider_detail_code?"], "core:plugin_cancelled": ["request_id", "plugin_id", "call", "cancellation_id"], "core:plugin_resource_exhausted": ["request_id", "plugin_id", "call", "resource_kind", "configured_limit", "observed_or_required"], "core:plugin_failed": ["request_id", "plugin_id", "call", "failure_code", "provider_detail_code?"], "core:required_delta_missing": ["work_item_id", "replacement_scope_ids", "received_fact_delta_ids?"], "core:delta_id_conflict": ["fact_delta_id", "accepted_digest", "conflicting_digest", "work_item_id?"],
  "core:delta_base_mismatch": ["fact_delta_id", "expected_base_snapshot_id", "actual_base_snapshot_id"], "core:delta_scope_mismatch": ["fact_delta_id", "work_item_id", "mismatch_kind", "replacement_scope_id?"], "core:undeclared_input": ["fact_delta_id", "input_type", "undeclared_ids", "proposal_record_key?"], "core:record_schema_invalid": ["fact_delta_id", "proposal_record_key", "kind", "schema_version", "validation_error_count", "json_pointers?", "uce_error_codes?"], "core:unregistered_identifier": ["fact_delta_id", "proposal_record_key", "identifier_type", "identifier"], "core:reference_validation_failed": ["fact_delta_id", "proposal_record_key", "reference_path", "reference_failure_kind", "target_id?", "candidate_identity_keys?"], "core:dependency_validation_failed": ["fact_delta_id", "proposal_record_key", "dependency_failure_kind", "dependency_artifact_id?", "dependency_artifact_version_id?", "dependency_role?"], "core:replacement_scope_incomplete": ["fact_delta_id", "replacement_scope_id", "incompleteness_kind", "missing_proposal_keys?", "missing_partition_keys?", "missing_capabilities?"], "core:identity_assignment_conflict": ["identity_type", "identity_key_digest", "conflict_kind", "identity_ids?", "record_ids?", "proposal_record_keys?"], "core:candidate_digest_mismatch": ["candidate_generation_id", "expected_digest", "actual_digest", "digest_component"],
  "core:projection_generator_failed": ["projection_work_item_id", "projection_kind", "generator", "generator_version", "generator_error_code", "provider_detail_code?"], "core:projection_output_invalid": ["projection_work_item_id", "projection_kind", "validation_kind", "invalid_projection_count", "projection_record_ids?", "source_record_ids?"], "core:projection_digest_mismatch": ["projection_work_item_id", "expected_digest", "actual_digest", "projection_record_id?"], "core:base_snapshot_changed": ["expected_base_snapshot_id", "current_snapshot_id"], "core:base_registry_changed": ["expected_registry_snapshot_id", "current_registry_snapshot_id"], "core:base_configuration_changed": ["expected_configuration_revision_id", "current_configuration_revision_id"], "core:publication_conflict": ["workspace_id", "conflict_kind", "conflicting_id?", "current_snapshot_id?"], "core:atomic_publication_failed": ["publication_step", "storage_cause_code", "transaction_rolled_back", "recovery_operation_id?"], "core:candidate_cleanup_failed": ["resource_type", "resource_id", "cleanup_operation", "cleanup_error_code"],
};
const candidatePayloads: Readonly<Record<string, RegistryPayloadSchema>> = Object.fromEntries(Object.entries(candidateIssueFields).map(([code, fields]) => [code, { type: "object", additionalProperties: false, properties: Object.fromEntries(fields.map((name) => { const fieldName = name.replace(/\?$/, ""); return [fieldName, payloadProperty(code, fieldName)]; })), required: fields.filter((name) => !name.endsWith("?")).map((name) => name.replace(/\?$/, "")) }]));
const candidatePlanningCodes = new Set(["core:invalidation_plan_incomplete", "core:work_manifest_inconsistent", "core:source_observation_conflict", "core:source_input_unavailable", "core:source_provider_state_changed", "core:source_provider_unavailable", "core:source_provider_deadline_exceeded", "core:source_provider_resource_exhausted", "core:source_provider_failed", "core:analysis_context_unavailable"]);
const candidateAnalysisCodes = new Set(["core:analyzer_failed", "core:analyzer_timeout", "core:plugin_inputs_incomplete", "core:plugin_unsupported", "core:plugin_cancelled", "core:plugin_resource_exhausted", "core:plugin_failed", "core:required_delta_missing"]);
const candidateValidationCodes = new Set(["core:delta_id_conflict", "core:delta_base_mismatch", "core:delta_scope_mismatch", "core:undeclared_input", "core:record_schema_invalid", "core:unregistered_identifier", "core:reference_validation_failed", "core:dependency_validation_failed", "core:replacement_scope_incomplete", "core:identity_assignment_conflict", "core:candidate_digest_mismatch"]);
const candidateProjectionCodes = new Set(["core:projection_generator_failed", "core:projection_output_invalid", "core:projection_digest_mismatch"]);
const candidatePublicationCodes = new Set(["core:base_snapshot_changed", "core:base_registry_changed", "core:base_configuration_changed", "core:publication_conflict", "core:atomic_publication_failed"]);
const candidateIssueCategories: Readonly<Record<string, CandidateIssueDefinition["issue_category"]>> = Object.fromEntries(candidateIssueRegistryEntries.map((issue) => [issue.id, candidatePlanningCodes.has(issue.id) ? "planning" : candidateAnalysisCodes.has(issue.id) ? "analysis" : candidateValidationCodes.has(issue.id) ? "validation" : candidateProjectionCodes.has(issue.id) ? "projection" : candidatePublicationCodes.has(issue.id) ? "publication" : "cleanup"]));
const candidateIssuePhaseMap: Readonly<Record<string, readonly string[]>> = {
  "core:invalidation_plan_incomplete": ["planning"], "core:work_manifest_inconsistent": ["planning"], "core:source_observation_conflict": ["planning"], "core:source_input_unavailable": ["planning"], "core:source_provider_state_changed": ["planning"], "core:source_provider_unavailable": ["planning"], "core:source_provider_deadline_exceeded": ["planning"], "core:source_provider_resource_exhausted": ["planning"], "core:source_provider_failed": ["planning"], "core:analysis_context_unavailable": ["planning"],
  "core:analyzer_failed": ["analysis"], "core:analyzer_timeout": ["analysis"], "core:plugin_inputs_incomplete": ["planning", "analysis", "projection"], "core:plugin_unsupported": ["planning", "analysis", "projection"], "core:plugin_cancelled": ["planning", "analysis", "projection"], "core:plugin_resource_exhausted": ["planning", "analysis", "projection"], "core:plugin_failed": ["planning", "analysis", "projection"], "core:required_delta_missing": ["analysis"], "core:delta_id_conflict": ["validation"],
  "core:delta_base_mismatch": ["validation"], "core:delta_scope_mismatch": ["validation"], "core:undeclared_input": ["validation"], "core:record_schema_invalid": ["validation"], "core:unregistered_identifier": ["validation"], "core:reference_validation_failed": ["validation"], "core:dependency_validation_failed": ["validation"], "core:replacement_scope_incomplete": ["validation"], "core:identity_assignment_conflict": ["validation"], "core:candidate_digest_mismatch": ["validation", "publication"],
  "core:projection_generator_failed": ["projection"], "core:projection_output_invalid": ["projection"], "core:projection_digest_mismatch": ["projection"],
  "core:base_snapshot_changed": ["publication"], "core:base_registry_changed": ["publication"], "core:base_configuration_changed": ["publication"], "core:publication_conflict": ["publication"], "core:atomic_publication_failed": ["publication"], "core:candidate_cleanup_failed": ["cleanup"],
};
const candidateWarningCodes = new Set(["core:source_provider_state_changed", "core:plugin_cancelled", "core:base_snapshot_changed", "core:base_registry_changed", "core:base_configuration_changed", "core:candidate_cleanup_failed"]);
const candidateIssueSeverities: Readonly<Record<string, "info" | "warning" | "error">> = Object.fromEntries(candidateIssueRegistryEntries.map((issue) => [issue.id, candidateWarningCodes.has(issue.id) ? "warning" : "error"]));
const candidateIssueAllowedSeverities: Readonly<Record<string, readonly ("info" | "warning" | "error")[]>> = Object.fromEntries(candidateIssueRegistryEntries.map((issue) => {
  const severity = candidateIssueSeverities[issue.id];
  if (!severity) throw new Error(`Missing candidate-issue severity for ${issue.id}`);
  return [issue.id, [severity] as const];
}));
const candidateIssueRetryability: Readonly<Record<string, CandidateIssueDefinition["default_retryability"]>> = {
  "core:invalidation_plan_incomplete": "replan", "core:work_manifest_inconsistent": "replan", "core:source_observation_conflict": "replan", "core:source_input_unavailable": "replan", "core:source_provider_state_changed": "replan", "core:source_provider_unavailable": "retry_same", "core:source_provider_deadline_exceeded": "retry_same", "core:source_provider_resource_exhausted": "retry_same", "core:source_provider_failed": "retry_same", "core:analysis_context_unavailable": "replan", "core:analyzer_failed": "reanalyze", "core:analyzer_timeout": "reanalyze", "core:plugin_inputs_incomplete": "replan", "core:plugin_unsupported": "not_retryable", "core:plugin_cancelled": "retry_same", "core:plugin_resource_exhausted": "reanalyze", "core:plugin_failed": "retry_same", "core:required_delta_missing": "reanalyze", "core:delta_id_conflict": "not_retryable", "core:delta_base_mismatch": "replan", "core:delta_scope_mismatch": "not_retryable", "core:undeclared_input": "not_retryable", "core:record_schema_invalid": "not_retryable", "core:unregistered_identifier": "not_retryable", "core:reference_validation_failed": "not_retryable", "core:dependency_validation_failed": "not_retryable", "core:replacement_scope_incomplete": "reanalyze", "core:identity_assignment_conflict": "replan", "core:candidate_digest_mismatch": "replan", "core:projection_generator_failed": "retry_same", "core:projection_output_invalid": "not_retryable", "core:projection_digest_mismatch": "retry_same", "core:base_snapshot_changed": "replan", "core:base_registry_changed": "replan", "core:base_configuration_changed": "replan", "core:publication_conflict": "replan", "core:atomic_publication_failed": "retry_same", "core:candidate_cleanup_failed": "retry_same",
};
const candidateIssueAllowedRetryability: Readonly<Record<string, readonly CandidateIssueDefinition["default_retryability"][]>> = Object.fromEntries(candidateIssueRegistryEntries.map((issue) => {
  const retryability = candidateIssueRetryability[issue.id];
  if (!retryability) throw new Error(`Missing candidate-issue retryability for ${issue.id}`);
  return [issue.id, [retryability]];
}));
const candidateIssuePayloads = candidatePayloads;

const operationArgumentLogicalTypes: Readonly<Record<string, string>> = {
  matcher: "DefinitionMatcher", selector: "RecordStructuralSelector", include_full_definitions: "Boolean", reference: "Text", context_artifact: "Text", context_byte_offset: "Count", kind_selector: "KindSelector", resolution_scope: "visible | workspace | exports", container: "SubjectSelector", depth: "PositiveInteger", include_non_public: "Boolean", filter: "StructuralFilter", target: "SubjectSelector", reference_roles: "Sequence<Text>", include_declarations: "Boolean", subjects: "Sequence<SubjectSelector>", direction: "inbound | outbound | both", relations: "RelationSelector", min_depth: "PositiveInteger", max_depth: "PositiveInteger", path_policy: "simple_subjects | simple_relations", sources: "Sequence<SubjectSelector>", targets: "Sequence<SubjectSelector>", all_shortest: "Boolean", pattern: "Text", syntax: "literal | safe_regex", case_sensitive: "Boolean", word_mode: "substring | identifier | token", result_projection: "match | artifact | record | entity", query_text: "Text", query_class: "natural_text | identifier | source_code | mixed", require_structural_subject: "Boolean", source: "SourceIncludeOptions", include_related_evidence: "Boolean", change: "ChangeDescriptor", include_transitive: "Boolean", include_tests: "Boolean", relationship_scope: "direct | transitive | both", include_fixtures: "Boolean", scope: "Sequence<SubjectSelector>", views: "Sequence<entry_points | boundaries | public_surfaces | cycles | extension_points | layers>", max_relation_depth: "PositiveInteger", selection: "Sequence<SubjectSelector>", comparison_kinds: "Sequence<added | removed | changed | moved | correlated>", correlation_policy: "strict | include_possible", task: "Text", seeds: "Sequence<SubjectSelector>", facets: "Sequence<definitions | implementations | callers | callees | dependencies | contracts | effects | tests | configuration | analogues | extension_points>", include_capabilities: "Boolean", include_plugins: "Boolean", include_activation_issues: "Boolean", include_candidate_issues: "Boolean",
};

// Source-backed public-query cardinalities consumed by both the published
// JSON Schema and runtime argument validator.
const publicQueryMinimumItemCounts: Readonly<Record<string, number>> = {
  subjects: 1,
  sources: 1,
  targets: 1,
  scope: 1,
  views: 1,
  selection: 1,
  comparison_kinds: 1,
  facets: 1,
};

const operationArgumentField = (name: string, presence: "required" | "optional" = "required", logical_type = operationArgumentLogicalTypes[name] ?? (() => { throw new Error(`Missing authoritative public-query logical type for ${name}`); })()): ModelFieldContract => ({
  name,
  presence,
  description: publicQueryArgumentDescriptions[name] ?? (() => { throw new Error(`Missing authoritative public-query argument description for ${name}`); })(),
  source: "protocol/public-query-contract.md",
  logical_type,
  ...(publicQueryMinimumItemCounts[name] === undefined ? {} : { minimum_item_count: publicQueryMinimumItemCounts[name] }),
});

const publicQueryArgumentDescriptions: Readonly<Record<string, string>> = {
  matcher: "Exact, lexical, semantic, or hybrid definition discovery input.", selector: "Hard definition-family, namespace, owner, and lifecycle filters.", include_full_definitions: "Returns concise definition views when false and complete agent-queryable definitions when true; large sets paginate.",
  reference: "Identifier, qualified name, or language-neutral symbol spelling to resolve.", context_artifact: "Lexical/module context.", context_byte_offset: "Exact non-negative UTF-8 byte position at which visibility and shadowing are evaluated.", kind_selector: "Hard target kind/facet constraint.", resolution_scope: "Resolution scope: visible, workspace, or exports.",
  container: "Artifact or semantic container whose direct contents are listed.", depth: "Maximum containment depth.", include_non_public: "Whether private/local declarations are eligible.", filter: "Hard searched scope and primary result constraints.", target: "Declaration or semantic target being referenced.", reference_roles: "Accepted registered reference roles.", include_declarations: "Whether defining occurrences are included beside uses.",
  subjects: "Starting subjects.", direction: "Direction relative to each starting subject and selected relation roles.", relations: "Exact traversable relation semantics.", min_depth: "First depth emitted.", max_depth: "Last depth emitted.", path_policy: "Cycle prevention rule for each emitted path.", sources: "Path origins.", targets: "Path destinations.", all_shortest: "Return every shortest path when true.",
  pattern: "Literal bytes after UTF-8 decoding or a safe-regex expression.", syntax: "Matching dialect.", case_sensitive: "Exact case behavior.", word_mode: "Boundary contract for literal matches.", result_projection: "Primary subject normalization.", query_text: "Concept, identifier, code, or mixed search input.", query_class: "Structural input class used for profile compatibility.", require_structural_subject: "Excludes artifact-only matches when true.",
  source: "Requested signature, relevant region, or body projection and budgets.", include_related_evidence: "Adds source references for hydrated evidence without widening primary subjects.", change: "One closed hypothetical change variant.", include_transitive: "Whether operation-defined transitive dependants are analyzed.", include_tests: "Whether related tests and test gaps are returned.", relationship_scope: "Relationship traversal scope.", include_fixtures: "Whether fixtures are included.", scope: "Hard architecture subject scope.", views: "Architecture views to return.", max_relation_depth: "Maximum relation traversal depth.", selection: "Subjects selected for workspace comparison.", comparison_kinds: "Comparison result families to return.", correlation_policy: "Policy for correlating comparison participants.", task: "Task or feature description used for context construction.", seeds: "Initial context subjects.", facets: "Context facets to materialize.", include_capabilities: "Whether capability state is returned.", include_plugins: "Whether plugin state is returned.", include_activation_issues: "Whether activation diagnostics are returned.", include_candidate_issues: "Whether candidate issues are returned.",
};

const operationSpecs: Readonly<Record<string, { schema: string; fields: readonly ModelFieldContract[]; streams: readonly string[]; scopes: readonly ("single_workspace" | "comparison")[]; batchable: readonly string[] }>> = {
  "core:discover_definitions": { schema: "core:DiscoverDefinitionsArguments", fields: [operationArgumentField("matcher"), operationArgumentField("selector", "optional", "RegistrySelector"), operationArgumentField("include_full_definitions", "optional")], streams: ["definitions", "definition_set"], scopes: ["single_workspace", "comparison"], batchable: [] },
  "core:find_records": { schema: "core:FindRecordsArguments", fields: [operationArgumentField("selector", "required", "RecordStructuralSelector")], streams: ["records"], scopes: ["single_workspace", "comparison"], batchable: [] },
  "core:resolve_symbol": { schema: "core:ResolveSymbolArguments", fields: [operationArgumentField("reference"), operationArgumentField("context_artifact", "optional"), operationArgumentField("context_byte_offset", "optional"), operationArgumentField("kind_selector", "optional"), operationArgumentField("resolution_scope", "optional")], streams: ["declarations", "candidates"], scopes: ["single_workspace", "comparison"], batchable: [] },
  "core:get_outline": { schema: "core:GetOutlineArguments", fields: [operationArgumentField("container", "required", "OutlineContainerSelector"), operationArgumentField("depth", "optional"), operationArgumentField("include_non_public", "optional"), operationArgumentField("filter", "optional")], streams: ["members"], scopes: ["single_workspace", "comparison"], batchable: [] },
  "core:find_references": { schema: "core:FindReferencesArguments", fields: [operationArgumentField("target", "required", "ReferenceTargetSelector"), operationArgumentField("reference_roles", "optional"), operationArgumentField("include_declarations", "optional"), operationArgumentField("filter", "optional")], streams: ["references", "owners"], scopes: ["single_workspace", "comparison"], batchable: ["target"] },
  "core:expand_relations": { schema: "core:ExpandRelationsArguments", fields: [operationArgumentField("subjects"), operationArgumentField("direction"), operationArgumentField("relations"), operationArgumentField("min_depth", "optional"), operationArgumentField("max_depth", "optional"), operationArgumentField("path_policy", "optional"), operationArgumentField("filter", "optional")], streams: ["subjects", "relations", "paths"], scopes: ["single_workspace", "comparison"], batchable: ["subjects"] },
  "core:find_paths": { schema: "core:FindPathsArguments", fields: [operationArgumentField("sources"), operationArgumentField("targets"), operationArgumentField("direction", "optional"), operationArgumentField("relations"), operationArgumentField("max_depth"), operationArgumentField("all_shortest", "optional")], streams: ["paths"], scopes: ["single_workspace", "comparison"], batchable: ["sources", "targets"] },
  "core:find_artifacts": { schema: "core:FindArtifactsArguments", fields: [operationArgumentField("filter", "optional", "StructuralFilter")], streams: ["artifacts"], scopes: ["single_workspace"], batchable: [] },
  "core:search_text": { schema: "core:SearchTextArguments", fields: [operationArgumentField("pattern"), operationArgumentField("syntax", "optional"), operationArgumentField("case_sensitive", "optional"), operationArgumentField("word_mode", "optional"), operationArgumentField("filter", "optional"), operationArgumentField("result_projection", "optional")], streams: ["matches", "subjects"], scopes: ["single_workspace", "comparison"], batchable: [] },
  "core:search_semantic": { schema: "core:SearchSemanticArguments", fields: [operationArgumentField("query_text"), operationArgumentField("query_class"), operationArgumentField("filter", "optional"), operationArgumentField("require_structural_subject", "optional")], streams: ["candidates", "semantic_coverage"], scopes: ["single_workspace", "comparison"], batchable: [] },
  "core:search_hybrid": { schema: "core:SearchHybridArguments", fields: [operationArgumentField("query_text"), operationArgumentField("query_class"), operationArgumentField("filter", "optional"), operationArgumentField("require_structural_subject", "optional")], streams: ["candidates", "semantic_coverage"], scopes: ["single_workspace", "comparison"], batchable: [] },
  "core:get_source": { schema: "core:GetSourceArguments", fields: [operationArgumentField("subjects"), operationArgumentField("source"), operationArgumentField("include_related_evidence", "optional")], streams: ["sources"], scopes: ["single_workspace", "comparison"], batchable: ["subjects"] },
  "core:analyze_impact": { schema: "core:AnalyzeImpactArguments", fields: [operationArgumentField("target"), operationArgumentField("change"), operationArgumentField("include_transitive", "optional"), operationArgumentField("include_tests", "optional"), operationArgumentField("filter", "optional")], streams: ["will_break", "must_update", "may_be_affected", "tests_to_run", "uncertain_dynamic_usage"], scopes: ["single_workspace", "comparison"], batchable: [] },
  "core:find_related_tests": { schema: "core:FindRelatedTestsArguments", fields: [operationArgumentField("subjects"), operationArgumentField("relationship_scope", "optional"), operationArgumentField("include_fixtures", "optional"), operationArgumentField("filter", "optional")], streams: ["tests", "fixtures", "mocks", "helpers"], scopes: ["single_workspace", "comparison"], batchable: ["subjects"] },
  "core:inspect_architecture": { schema: "core:InspectArchitectureArguments", fields: [operationArgumentField("scope", "optional"), operationArgumentField("views"), operationArgumentField("max_relation_depth", "optional"), operationArgumentField("filter", "optional")], streams: ["entry_points", "boundaries", "public_surfaces", "cycles", "extension_points", "layers"], scopes: ["single_workspace", "comparison"], batchable: [] },
  "core:compare": { schema: "core:CompareArguments", fields: [operationArgumentField("selection", "optional"), operationArgumentField("comparison_kinds"), operationArgumentField("correlation_policy", "optional"), operationArgumentField("filter", "optional")], streams: ["added", "removed", "changed", "moved", "correlated"], scopes: ["comparison"], batchable: [] },
  "core:build_context": { schema: "core:BuildContextArguments", fields: [operationArgumentField("task"), operationArgumentField("query_class", "optional"), operationArgumentField("seeds", "optional"), operationArgumentField("facets"), operationArgumentField("filter", "optional")], streams: ["context"], scopes: ["single_workspace", "comparison"], batchable: [] },
  "core:index_status": { schema: "core:IndexStatusArguments", fields: [operationArgumentField("include_capabilities", "optional"), operationArgumentField("include_plugins", "optional"), operationArgumentField("include_activation_issues", "optional"), operationArgumentField("include_candidate_issues", "optional")], streams: ["workspaces", "activation_issues", "candidate_issues"], scopes: ["single_workspace"], batchable: [] },
};

const operationResultSubjectTypes: Readonly<Record<string, readonly string[]>> = {
  "core:discover_definitions": ["definition"],
  "core:find_records": ["record"],
  "core:resolve_symbol": ["entity"],
  "core:get_outline": ["entity"],
  "core:find_references": ["relation"],
  "core:expand_relations": ["entity", "relation"],
  "core:find_paths": ["relation"],
  "core:find_artifacts": ["artifact"],
  "core:search_text": ["artifact", "entity"],
  "core:search_semantic": ["entity", "record", "artifact"],
  "core:search_hybrid": ["entity", "record", "artifact"],
  "core:get_source": ["artifact"],
  "core:analyze_impact": ["entity", "record"],
  "core:find_related_tests": ["entity", "artifact"],
  "core:inspect_architecture": ["entity", "relation"],
  "core:compare": ["entity", "record", "artifact"],
  "core:build_context": ["entity", "record"],
  "core:index_status": ["workspace"],
};
const operationStreamFields: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  "core:discover_definitions": { definitions: ["definition", "match_class", "match_terms"], definition_set: ["definition_set"] },
  "core:find_records": { records: ["record"] },
  "core:resolve_symbol": { declarations: ["subject", "resolution_class"], candidates: ["subject", "candidate_reason"] },
  "core:get_outline": { members: ["subject", "containment_depth", "source_span"] },
  "core:find_references": { references: ["relation", "source_span"], owners: ["subject", "owner_artifact"] },
  "core:expand_relations": { subjects: ["subject", "depth"], relations: ["relation", "path_id"], paths: ["path", "length"] },
  "core:find_paths": { paths: ["path", "source", "target", "length"] },
  "core:find_artifacts": { artifacts: ["subject", "path", "artifact_version"] },
  "core:search_text": { matches: ["match", "source_span"], subjects: ["subject", "match_count"] },
  "core:search_semantic": { candidates: ["subject", "semantic_evidence"], semantic_coverage: ["coverage"] },
  "core:search_hybrid": { candidates: ["subject", "lexical_evidence", "semantic_evidence"], semantic_coverage: ["coverage"] },
  "core:get_source": { sources: ["source", "snippets"] },
  "core:analyze_impact": { will_break: ["subject", "impact"], must_update: ["subject", "impact"], may_be_affected: ["subject", "impact"], tests_to_run: ["subject", "impact"], uncertain_dynamic_usage: ["subject", "impact"] },
  "core:find_related_tests": { tests: ["subject", "relationship"], fixtures: ["subject", "relationship"], mocks: ["subject", "relationship"], helpers: ["subject", "relationship"] },
  "core:inspect_architecture": { entry_points: ["subject", "architecture_role"], boundaries: ["subject", "boundary"], public_surfaces: ["subject", "surface"], cycles: ["cycle"], extension_points: ["subject", "extension_point"], layers: ["subject", "layer"] },
  "core:compare": { added: ["subject", "participant"], removed: ["subject", "participant"], changed: ["change"], moved: ["move"], correlated: ["correlation"] },
  "core:build_context": { context: ["result_bundle", "evidence_summary"] },
  "core:index_status": { workspaces: ["workspace_status"], activation_issues: ["diagnostic"], candidate_issues: ["candidate_issue"] },
};
const operationStreamClassifications: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  "core:discover_definitions": { definitions: ["confirmed", "possible"], definition_set: ["confirmed"] },
  "core:find_records": { records: ["confirmed"] },
  "core:resolve_symbol": { declarations: ["confirmed", "possible"], candidates: ["possible"] },
  "core:get_outline": { members: ["confirmed"] },
  "core:find_references": { references: ["confirmed", "possible"], owners: ["confirmed", "possible"] },
  "core:expand_relations": { subjects: ["confirmed", "possible"], relations: ["confirmed", "possible"], paths: ["confirmed", "possible"] },
  "core:find_paths": { paths: ["confirmed", "possible"] },
  "core:find_artifacts": { artifacts: ["confirmed"] },
  "core:search_text": { matches: ["confirmed", "possible"], subjects: ["confirmed", "possible"] },
  "core:search_semantic": { candidates: ["possible"], semantic_coverage: ["unclassified"] },
  "core:search_hybrid": { candidates: ["possible"], semantic_coverage: ["unclassified"] },
  "core:get_source": { sources: ["unclassified"] },
  "core:analyze_impact": { will_break: ["confirmed", "possible"], must_update: ["confirmed", "possible"], may_be_affected: ["confirmed", "possible"], tests_to_run: ["confirmed", "possible"], uncertain_dynamic_usage: ["possible"] },
  "core:find_related_tests": { tests: ["confirmed", "possible"], fixtures: ["confirmed", "possible"], mocks: ["confirmed", "possible"], helpers: ["confirmed", "possible"] },
  "core:inspect_architecture": { entry_points: ["confirmed", "possible"], boundaries: ["confirmed", "possible"], public_surfaces: ["confirmed", "possible"], cycles: ["confirmed"], extension_points: ["confirmed", "possible"], layers: ["confirmed", "possible"] },
  "core:compare": { added: ["confirmed", "possible"], removed: ["confirmed", "possible"], changed: ["confirmed", "possible"], moved: ["confirmed", "possible"], correlated: ["confirmed", "possible"] },
  "core:build_context": { context: ["confirmed", "possible"] },
  "core:index_status": { workspaces: ["unclassified"], activation_issues: ["unclassified"], candidate_issues: ["unclassified"] },
};
const operationStreamItemSchemas: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "core:discover_definitions": { definitions: "core:DefinitionView", definition_set: "core:DefinitionSetView" },
  "core:find_records": { records: "core:RecordEnvelope" },
  "core:resolve_symbol": { declarations: "core:ResultSubject", candidates: "core:ResultSubject" },
  "core:get_outline": { members: "core:ResultSubject" },
  "core:find_references": { references: "core:ResultSubject", owners: "core:ResultSubject" },
  "core:expand_relations": { subjects: "core:ResultSubject", relations: "core:RelationRecord", paths: "core:RelationPath" },
  "core:find_paths": { paths: "core:RelationPath" },
  "core:find_artifacts": { artifacts: "core:ResultSubject" },
  "core:search_text": { matches: "core:TextMatch", subjects: "core:ResultSubject" },
  "core:search_semantic": { candidates: "core:ResultSubject", semantic_coverage: "core:SemanticCoverageView" },
  "core:search_hybrid": { candidates: "core:ResultSubject", semantic_coverage: "core:SemanticCoverageView" },
  "core:get_source": { sources: "core:SourceReferenceView" },
  "core:analyze_impact": { will_break: "core:ResultSubject", must_update: "core:ResultSubject", may_be_affected: "core:ResultSubject", tests_to_run: "core:ResultSubject", uncertain_dynamic_usage: "core:ResultSubject" },
  "core:find_related_tests": { tests: "core:ResultSubject", fixtures: "core:ResultSubject", mocks: "core:ResultSubject", helpers: "core:ResultSubject" },
  "core:inspect_architecture": { entry_points: "core:ResultSubject", boundaries: "core:ResultSubject", public_surfaces: "core:ResultSubject", cycles: "core:ResultSubject", extension_points: "core:ResultSubject", layers: "core:ResultSubject" },
  "core:compare": { added: "core:ResultSubject", removed: "core:ResultSubject", changed: "core:ResultSubject", moved: "core:ResultSubject", correlated: "core:ResultSubject" },
  "core:build_context": { context: "core:ResultBundle" },
  "core:index_status": { workspaces: "core:WorkspaceIndexStatusView", activation_issues: "core:DiagnosticView", candidate_issues: "core:CandidateIssueView" },
};

export const operationDefinitions: readonly OperationDefinition[] = operationRegistryEntries.map((operation) => {
  const spec = operationSpecs[operation.id];
  if (!spec) throw new Error(`Missing public operation definition for ${operation.id}`);
  const argument_schema: OperationArgumentSchema = {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(spec.fields.map((field) => [toPublicFieldName(field.name), operationArgumentProperty(field)])) as Readonly<Record<string, PayloadPropertySchema>>,
    required: spec.fields.filter((field) => field.presence === "required").map((field) => toPublicFieldName(field.name)),
  };
  const resultItemTypes: Readonly<Record<string, string>> = {
    "core:discover_definitions": "DefinitionView", "core:find_records": "RecordEnvelope", "core:resolve_symbol": "ResultSubject", "core:get_outline": "ResultSubject", "core:find_references": "ResultSubject", "core:expand_relations": "RelationRecord", "core:find_paths": "RelationPath", "core:find_artifacts": "ResultSubject", "core:search_text": "TextMatch", "core:search_semantic": "ResultSubject", "core:search_hybrid": "ResultSubject", "core:get_source": "SourceReferenceView", "core:analyze_impact": "ResultSubject", "core:find_related_tests": "ResultSubject", "core:inspect_architecture": "ResultSubject", "core:compare": "ResultSubject", "core:build_context": "ResultBundle", "core:index_status": "WorkspaceIndexStatusView",
  };
  const result_stream_definitions = spec.streams.map((stream) => ({
    stream_name: stream,
    item_type: resultItemTypes[operation.id] ?? (() => { throw new Error(`Missing result item type for ${operation.id}`); })(),
    item_schema_id: operationStreamItemSchemas[operation.id]?.[stream] ?? (() => { throw new Error(`Missing authoritative stream item schema for ${operation.id}.${stream}`); })(),
    item_schema_version: 1,
    classifications: operationStreamClassifications[operation.id]?.[stream] ?? (() => { throw new Error(`Missing authoritative stream classifications for ${operation.id}.${stream}`); })(),
    fields: operationStreamFields[operation.id]?.[stream] ?? (() => { throw new Error(`Missing authoritative stream fields for ${operation.id}.${stream}`); })(),
  }));
  return {
    operation_id: operation.id,
    operation_version: 1,
    public_api_version: 1,
    description: operation.description,
    argument_schema_id: spec.schema,
    argument_schema_version: 1,
    argument_fields: spec.fields,
    argument_schema,
    result_streams: spec.streams,
    result_stream_definitions,
    batchable_fields: spec.batchable,
    allowed_scope_kinds: spec.scopes,
    result_subject_types: operationResultSubjectTypes[operation.id] ?? (() => { throw new Error(`Missing authoritative result subject types for ${operation.id}`); })(),
    ordering_comparator_id: "core:query_manifest_stream_order",
    ordering_comparator_version: 1,
    lifecycle_state: operation.lifecycle_state,
  };
});

function operationArgumentProperty(field: ModelFieldContract): PayloadPropertySchema {
  const logicalType = field.logical_type;
  if (logicalType === "Boolean") return { type: "boolean", description: field.description };
  if (logicalType === "Count" || logicalType === "PositiveInteger") return { type: "integer", minimum: logicalType === "PositiveInteger" ? 1 : 0, description: field.description };
  if (["Text", "Identifier", "NamespacedIdentifier", "SemVer", "URI"].includes(logicalType)) return { type: "string", description: field.description };
  const collection = logicalType.match(/^(?:Sequence|Set|OrderedSet)<(.+)>/);
  if (collection) return { type: "array", description: field.description, items: operationLogicalItemProperty(collection[1] ?? ""), ...(field.minimum_item_count === undefined ? {} : { minItems: field.minimum_item_count }) };
  const enumValues = closedEnumValues(logicalType);
  if (enumValues) return { type: "string", description: field.description, enum: enumValues };
  return operationLogicalObjectProperty(logicalType, field.description);
}

function operationLogicalItemProperty(logicalType: string): PayloadPropertySchema {
  if (["Text", "Identifier", "NamespacedIdentifier", "SemVer", "URI"].includes(logicalType)) return { type: "string", description: `The ${logicalType} collection element.` };
  if (logicalType === "Boolean") return { type: "boolean", description: "The Boolean collection element." };
  if (logicalType === "Count" || logicalType === "PositiveInteger") return { type: "integer", minimum: logicalType === "PositiveInteger" ? 1 : 0, description: `The ${logicalType} collection element.` };
  const enumValues = closedEnumValues(logicalType);
  if (enumValues) return { type: "string", description: `The ${logicalType} collection element.`, enum: enumValues };
  return operationLogicalObjectProperty(logicalType, `The closed ${logicalType} value.`);
}

function closedEnumValues(logicalType: string): readonly string[] | undefined {
  const values = logicalType.split("|").map((value) => value.trim()).filter(Boolean);
  return values.length > 1 && values.every((value) => /^[a-z][a-z0-9_]*$/.test(value)) ? values : undefined;
}

function operationLogicalObjectProperty(logicalType: string, description: string): PayloadPropertySchema {
  if (logicalType === "SubjectSelector") return subjectSelectorSchema(description);
  if (logicalType === "OutlineContainerSelector") return subjectSelectorSchema(description, ["entity", "record", "artifact"]);
  if (logicalType === "ReferenceTargetSelector") return subjectSelectorSchema(description, ["entity", "record", "symbol"]);
  if (logicalType === "DefinitionMatcher") return definitionMatcherSchema(description);
  if (logicalType === "KindSelector") return kindSelectorSchema(description);
  if (logicalType === "StructuralFilter") return structuralFilterSchema(description);
  if (logicalType === "RelationSelector") return relationSelectorSchema(description);
  if (logicalType === "RegistrySelector") return registrySelectorSchema(description);
  if (logicalType === "RecordStructuralSelector") return recordStructuralSelectorSchema(description);
  if (logicalType === "ChangeDescriptor") return changeDescriptorSchema(description);
  const model = modelContractRegistry.find((candidate) => candidate.name === logicalType);
  if (!model) throw new Error(`Missing authoritative public-query model ${logicalType}`);
  const properties = Object.fromEntries(model.fields.map((field) => [toPublicFieldName(field.name), operationArgumentProperty(field)]));
  return { type: "object", description, schema_id: `core:${logicalType}`, schema_version: 1, additionalProperties: false, properties, required: model.fields.filter((field) => field.presence === "required").map((field) => toPublicFieldName(field.name)) };
}

function sharedTextArray(description: string, nonEmpty = false): PayloadPropertySchema {
  return {
  type: "array",
  description,
  items: { type: "string", description: "A non-empty registered text value." },
  ...(nonEmpty ? { minItems: 1 } : {}),
  };
}

function sharedEnumArray(description: string, values: readonly string[], nonEmpty = false): PayloadPropertySchema {
  return {
  type: "array",
  description,
  items: { type: "string", description: "A member of the closed enum.", enum: values },
  ...(nonEmpty ? { minItems: 1 } : {}),
  };
}

function definitionMatcherSchema(description: string): PayloadPropertySchema {
  const matcherDescription = "`DefinitionMatcher.text` is non-empty bounded UTF-8. `mode` is `exact`, `prefix`, `contains`, `semantic`, or `hybrid`; semantic modes classify matches as candidates rather than proof. `definition_types` and `namespaces` are optional filters represented by empty arrays for all values. `limit` is a positive server-bounded candidate limit that affects the normalized plan.";
  return {
    type: "object",
    description,
    schema_id: "core:DefinitionMatcher",
    schema_version: 1,
    additionalProperties: false,
    properties: {
      text: { type: "string", description: matcherDescription },
      mode: { type: "string", description: matcherDescription, enum: ["exact", "prefix", "contains", "semantic", "hybrid"] },
      definitionTypes: sharedTextArray("Optional definition-family filters; an empty array selects every family."),
      namespaces: sharedTextArray("Optional namespace filters; an empty array selects the complete pinned registry."),
      limit: { type: "integer", minimum: 1, description: "Positive server-bounded candidate limit affecting the normalized plan." },
    },
    required: ["text", "mode"],
  };
}

function kindSelectorSchema(description: string): PayloadPropertySchema {
  const selectorDescription = "A present non-empty dimension combines with the other dimensions by logical AND; every value must resolve in the pinned registry.";
  return {
    type: "object", schema_id: "core:KindSelector", schema_version: 1, additionalProperties: false,
    properties: {
      kinds: sharedTextArray("Concrete namespaced kinds matching any listed value."),
      universalKinds: sharedTextArray("Universal base kinds matching any listed value."),
      allFacets: sharedTextArray("Facets all of which must be present."),
      anyFacets: sharedTextArray("Facets of which at least one must be present."),
      excludedFacets: sharedTextArray("Facets whose presence rejects the record."),
    },
    required: [],
    description: `${description} ${selectorDescription}`,
  };
}

function structuralFilterSchema(description: string): PayloadPropertySchema {
  return {
    type: "object", description, schema_id: "core:StructuralFilter", schema_version: 1, additionalProperties: false,
    properties: {
      paths: sharedTextArray("Artifact paths that may contribute primary subjects."),
      languages: sharedTextArray("Indexed language classifications accepted."),
      namespaces: sharedTextArray("Concrete-definition namespaces accepted."),
      kindSelector: kindSelectorSchema("Concrete, universal, and facet constraints from the pinned registry."),
      subjectTypes: sharedEnumArray("Legal primary result variants.", ["entity", "record", "artifact"]),
      includeExternal: { type: "boolean", description: "Whether virtual standard-library and dependency-declaration artifacts may be primary results." },
      includeGenerated: { type: "boolean", description: "Whether policy-classified generated artifacts may be primary results when indexed." },
    },
    required: [],
  };
}

function relationSelectorSchema(description: string): PayloadPropertySchema {
  return {
    type: "object", description, schema_id: "core:RelationSelector", schema_version: 1, additionalProperties: false,
    properties: {
      relationKinds: sharedTextArray("Accepted concrete relation kinds; empty accepts all allowed by the operation."),
      universalKinds: sharedTextArray("Accepted core universal relation kinds; empty accepts all."),
      roles: sharedTextArray("Relation argument roles that must connect traversal endpoints."),
      evidenceClass: { type: "string", description: "Eligible relation certainty.", enum: ["confirmed", "possible", "both"] },
      possibleConfidence: sharedEnumArray("Eligible possible confidence tiers; ignored for confirmed relations.", ["high", "medium", "low"]),
    },
    required: [],
  };
}

function registrySelectorSchema(description: string): PayloadPropertySchema {
  return {
    type: "object", description, schema_id: "core:RegistrySelector", schema_version: 1, additionalProperties: false,
    properties: {
      definitionTypes: sharedTextArray("Accepted agent-queryable registry families."),
      namespaces: sharedTextArray("Accepted namespaces."),
      pluginIds: sharedTextArray("Accepted definition owners."),
      lifecycleStates: sharedEnumArray("Definition lifecycle states to return.", ["active", "deprecated", "retired"]),
    },
    required: [],
  };
}

function recordStructuralSelectorSchema(description: string): PayloadPropertySchema {
  const fields = {
    recordCategories: sharedEnumArray("Accepted canonical record categories; values combine by OR.", ["entity", "relation", "fact", "evidence", "diagnostic"], true),
    kindSelector: kindSelectorSchema("Accepted concrete kinds, universal kinds, and facets under their conjunctive rules."),
    producerIds: sharedTextArray("Exact plugin or core producer identities; values combine by OR.", true),
    filter: structuralFilterSchema("Hard path, language, namespace, kind/facet, subject-type, external, and generated constraints."),
  } as const;
  const base: PayloadPropertySchema = { type: "object", description, schema_id: "core:RecordStructuralSelector", schema_version: 1, additionalProperties: false, properties: fields, required: [] };
  return {
    ...base,
    anyOf: [
      { ...base, required: ["recordCategories"] },
      { ...base, required: ["kindSelector"] },
      { ...base, required: ["producerIds"] },
      { ...base, required: ["filter"] },
    ],
  };
}

function changeDescriptorSchema(description: string): PayloadPropertySchema {
  const text = (fieldDescription: string): PayloadPropertySchema => ({ type: "string", description: fieldDescription });
  const variant = (changeType: string, required: readonly string[], optional: Readonly<Record<string, PayloadPropertySchema>> = {}): PayloadPropertySchema => ({
    type: "object", description, additionalProperties: false,
    properties: { changeType: { type: "string", enum: [changeType], description: "The closed change discriminator." }, ...optional },
    required: ["changeType", ...required],
  });
  return {
    type: "object", description, schema_id: "core:ChangeDescriptor", schema_version: 1, oneOf: [
      variant("delete", []),
      variant("rename", ["newName"], { newName: text("Replacement declaration name.") }),
      variant("move", ["newArtifactPath"], { newArtifactPath: text("Replacement normalized artifact path."), newContainer: text("Replacement containing subject.") }),
      variant("signature", ["newSignature"], { newSignature: text("Replacement signature."), compatibilityAssumptions: sharedTextArray("Declared compatibility assumptions.") }),
      variant("type", ["newType"], { newType: text("Replacement type."), compatibilityAssumptions: sharedTextArray("Declared compatibility assumptions.") }),
      variant("visibility", ["newVisibility"], { newVisibility: text("Replacement visibility." ) }),
      variant("contract", ["contractChangeCode", "newContract"], { contractChangeCode: text("Registered contract-change code."), newContract: text("Replacement contract."), compatibilityAssumptions: sharedTextArray("Declared compatibility assumptions.") }),
      variant("behavior", ["behaviorChangeCode", "description"], { behaviorChangeCode: text("Registered behavior-change code."), description: text("Bounded behavior-change description."), affectedEffects: sharedTextArray("Registered effects affected by the change.") }),
    ],
  };
}

function toPublicFieldName(name: string): string { return name.replace(/_([a-z])/g, (_, character: string) => character.toUpperCase()); }

function subjectSelectorSchema(description: string, allowedSubjectTypes?: readonly string[]): PayloadPropertySchema {
  const variant = (subjectType: string, fields: Readonly<Record<string, PayloadPropertySchema>>, required: readonly string[]): PayloadPropertySchema => ({
    type: "object", description, additionalProperties: false, properties: { subjectType: { type: "string", enum: [subjectType], description: "The exact SubjectSelector discriminator." }, ...fields }, required,
  });
  const artifactVariant: PayloadPropertySchema = { type: "object", description, additionalProperties: false, oneOf: [
    variant("artifact", { artifactId: { type: "string", description: "The exact source artifact identifier." }, artifactVersionId: { type: "string", description: "The optional pinned artifact version identifier." } }, ["subjectType", "artifactId"]),
    variant("artifact", { path: { type: "string", description: "The normalized workspace-relative or canonical virtual path." }, artifactVersionId: { type: "string", description: "The optional pinned artifact version identifier." } }, ["subjectType", "path"]),
  ] };
  const variants: PayloadPropertySchema[] = [
    variant("entity", { entityId: { type: "string", description: "The entity lifecycle identifier." }, entityRecordId: { type: "string", description: "The optional exact entity record identifier." } }, ["subjectType", "entityId"]),
    variant("record", { recordId: { type: "string", description: "The exact canonical record identifier." } }, ["subjectType", "recordId"]),
    artifactVariant,
    variant("symbol", { name: { type: "string", description: "The symbol spelling." }, contextArtifact: { type: "string", description: "The optional lexical context artifact." }, contextByteOffset: { type: "integer", minimum: 0, description: "The optional UTF-8 context byte offset." }, kindSelector: operationLogicalObjectProperty("KindSelector", "The optional target kind selector.") }, ["subjectType", "name"]),
    variant("stage_output", { stageId: { type: "string", description: "The producing pipeline stage identifier." }, output: { type: "string", description: "The producing stage output name." } }, ["subjectType", "stageId", "output"]),
  ];
  const isAllowed = (candidate: PayloadPropertySchema): boolean => candidate.properties?.["subjectType"]?.enum?.some((value) => allowedSubjectTypes?.includes(String(value)) ?? true) ?? candidate.oneOf?.some(isAllowed) ?? false;
  return { type: "object", description, schema_id: "core:SubjectSelector", schema_version: 1, oneOf: allowedSubjectTypes ? variants.filter(isAllowed) : variants };
}

const recipeSpecs: Readonly<Record<string, { schema: string; stages: readonly string[]; bindings: readonly string[]; guards: readonly string[]; outputs: readonly string[]; streams: readonly string[]; capabilities: readonly string[]; rankings: readonly string[] }>> = {
  "core:locate_implementation": { schema: "core:LocateImplementationArguments", stages: ["search:core:search_hybrid@1", "implementations:filter", "source:core:get_source@1"], bindings: ["$/query_text->search.query_text", "$/query_class->search.query_class", "$/filter->search.filter", "search.candidates->implementations", "implementations.subjects->source.subjects"], guards: [], outputs: ["implementations", "sources"], streams: ["implementations.confirmed", "implementations.possible", "sources"], capabilities: ["core:semantic_preparation", "core:symbol_declarations"], rankings: ["search=core:search_hybrid_default@1"] },
  "core:understand_change_impact": { schema: "core:UnderstandChangeImpactArguments", stages: ["impact:core:analyze_impact@1", "source:core:get_source@1"], bindings: ["$/target->impact.target", "$/change->impact.change", "$/include_transitive->impact.include_transitive", "$/include_tests->impact.include_tests", "$/filter->impact.filter", "impact.all_classified_subjects->source.subjects"], guards: [], outputs: ["will_break", "must_update", "may_be_affected", "tests_to_run", "uncertain_dynamic_usage", "sources"], streams: ["will_break.confirmed", "will_break.possible", "must_update.confirmed", "must_update.possible", "may_be_affected.confirmed", "may_be_affected.possible", "tests_to_run.confirmed", "tests_to_run.possible", "uncertain_dynamic_usage.confirmed", "uncertain_dynamic_usage.possible", "sources"], capabilities: ["core:symbol_resolution", "core:call_relationships", "core:module_dependencies", "core:test_relationships"], rankings: [] },
  "core:prepare_symbol_change": { schema: "core:PrepareSymbolChangeArguments", stages: ["resolve:core:resolve_symbol@1", "impact:core:analyze_impact@1", "references:core:find_references@1", "tests:core:find_related_tests@1", "source:core:get_source@1"], bindings: ["$/reference->resolve.reference", "$/context_artifact->resolve.context_artifact", "$/context_byte_offset->resolve.context_byte_offset", "$/kind_selector->resolve.kind_selector", "resolve.declarations->impact.target", "$/change->impact.change", "$/filter->impact.filter", "resolve.declarations->references.target", "$/filter->references.filter", "resolve.declarations->tests.subjects", "$/filter->tests.filter", "impact.all_classified_subjects+references.references+tests.tests->source.subjects"], guards: ["core:one_confirmed_subject"], outputs: ["target", "will_break", "must_update", "may_be_affected", "tests_to_run", "uncertain_dynamic_usage", "references", "tests", "fixtures", "mocks", "helpers", "sources"], streams: ["target.confirmed", "target.possible", "will_break.confirmed", "will_break.possible", "must_update.confirmed", "must_update.possible", "may_be_affected.confirmed", "may_be_affected.possible", "tests_to_run.confirmed", "tests_to_run.possible", "uncertain_dynamic_usage.confirmed", "uncertain_dynamic_usage.possible", "references.confirmed", "references.possible", "tests.confirmed", "tests.possible", "fixtures.confirmed", "fixtures.possible", "mocks.confirmed", "mocks.possible", "helpers.confirmed", "helpers.possible", "sources"], capabilities: ["core:symbol_declarations", "core:symbol_resolution", "core:call_relationships", "core:test_relationships"], rankings: [] },
  "core:prepare_new_feature": { schema: "core:PrepareNewFeatureArguments", stages: ["seeds:core:search_hybrid@1", "analogue_selector:bind.subject_record_selector@1", "analogues:core:find_records@1", "architecture:core:inspect_architecture@1", "context:core:build_context@1", "tests:core:find_related_tests@1"], bindings: ["$/task->seeds.query_text", "$/query_class->seeds.query_class", "$/filter->seeds.filter", "seeds.candidates->analogue_selector", "$/filter->analogue_selector.filter", "analogue_selector.selector->analogues.selector", "$/filter->analogues.filter", "$/filter->architecture.filter", "$/task->context.task", "$/query_class->context.query_class", "$/filter->context.filter", "analogues.records->tests.subjects", "$/filter->tests.filter"], guards: [], outputs: ["analogues", "architecture", "context", "tests", "fixtures", "mocks", "helpers"], streams: ["analogues.confirmed", "analogues.possible", "architecture.confirmed", "architecture.possible", "context.confirmed", "context.possible", "tests.confirmed", "tests.possible", "fixtures.confirmed", "fixtures.possible", "mocks.confirmed", "mocks.possible", "helpers.confirmed", "helpers.possible"], capabilities: ["core:semantic_preparation", "core:symbol_declarations", "core:module_dependencies", "core:framework_semantics", "core:test_relationships"], rankings: ["seeds=core:search_hybrid_default@1"] },
  "core:trace_behavior": { schema: "core:TraceBehaviorArguments", stages: ["trace:core:expand_relations@1", "source:core:get_source@1"], bindings: ["$/subjects->trace.subjects", "$/direction->trace.direction", "$/relations->trace.relations", "$/max_depth->trace.max_depth", "$/filter->trace.filter", "trace.subjects->source.subjects"], guards: [], outputs: ["subjects", "relations", "paths", "sources"], streams: ["subjects.confirmed", "subjects.possible", "relations.confirmed", "relations.possible", "paths.confirmed", "paths.possible", "sources"], capabilities: ["core:call_relationships", "core:control_flow", "core:data_flow", "core:effects"], rankings: [] },
  "core:find_relevant_tests": { schema: "core:FindRelevantTestsArguments", stages: ["tests:core:find_related_tests@1", "source:core:get_source@1"], bindings: ["$/subjects->tests.subjects", "$/relationship_scope->tests.relationship_scope", "$/include_fixtures->tests.include_fixtures", "$/filter->tests.filter", "tests.tests+tests.fixtures+tests.mocks+tests.helpers->source.subjects"], guards: [], outputs: ["tests", "fixtures", "mocks", "helpers", "sources"], streams: ["tests.confirmed", "tests.possible", "fixtures.confirmed", "fixtures.possible", "mocks.confirmed", "mocks.possible", "helpers.confirmed", "helpers.possible", "sources"], capabilities: ["core:test_relationships", "core:symbol_resolution", "core:call_relationships"], rankings: [] },
  "core:explain_architecture_slice": { schema: "core:ExplainArchitectureSliceArguments", stages: ["architecture:core:inspect_architecture@1", "source:core:get_source@1"], bindings: ["$/scope->architecture.scope", "$/views->architecture.views", "$/max_relation_depth->architecture.max_relation_depth", "$/filter->architecture.filter", "architecture.all_requested_views->source.subjects"], guards: [], outputs: ["architecture", "sources"], streams: ["architecture.confirmed", "architecture.possible", "sources"], capabilities: ["core:symbol_declarations", "core:module_dependencies", "core:call_relationships", "core:framework_semantics"], rankings: [] },
  "core:compare_workspaces": { schema: "core:CompareWorkspacesArguments", stages: ["compare:core:compare@1"], bindings: ["$/selection->compare.selection", "$/comparison_kinds->compare.comparison_kinds", "$/correlation_policy->compare.correlation_policy", "$/filter->compare.filter"], guards: ["core:comparison_roles_base_target"], outputs: ["added", "removed", "changed", "moved", "correlated"], streams: ["added.confirmed", "added.possible", "removed.confirmed", "removed.possible", "changed.confirmed", "changed.possible", "moved.confirmed", "moved.possible", "correlated.confirmed", "correlated.possible"], capabilities: ["core:symbol_declarations", "core:symbol_resolution"], rankings: [] },
  "core:semantic_to_callers": { schema: "core:SemanticToCallersArguments", stages: ["search:core:search_hybrid@1", "callers:core:expand_relations@1", "tests:core:find_related_tests@1", "source:core:get_source@1"], bindings: ["$/query_text->search.query_text", "$/query_class->search.query_class", "$/filter->search.filter", "search.candidates->callers.subjects", "$/filter->callers.filter", "$/max_call_depth->callers.max_depth", "callers.subjects->tests.subjects", "$/filter->tests.filter", "search.candidates+callers.subjects+tests.tests->source.subjects"], guards: [], outputs: ["matches", "callers", "call_paths", "tests", "sources"], streams: ["matches.confirmed", "matches.possible", "callers.confirmed", "callers.possible", "call_paths.confirmed", "call_paths.possible", "tests.confirmed", "tests.possible", "sources"], capabilities: ["core:semantic_preparation", "core:symbol_resolution", "core:call_relationships", "core:test_relationships"], rankings: ["search=core:search_hybrid_default@1"] },
  "core:resolve_and_find_references": { schema: "core:ResolveAndFindReferencesArguments", stages: ["resolve:core:resolve_symbol@1", "references:core:find_references@1", "source:core:get_source@1"], bindings: ["$/reference->resolve.reference", "$/context_artifact->resolve.context_artifact", "$/context_byte_offset->resolve.context_byte_offset", "$/kind_selector->resolve.kind_selector", "resolve.declarations->references.target", "$/reference_roles->references.reference_roles", "$/include_declarations->references.include_declarations", "$/filter->references.filter", "resolve.declarations+references.references->source.subjects"], guards: [], outputs: ["declarations", "candidates", "references", "owners", "sources"], streams: ["declarations.confirmed", "declarations.possible", "candidates.confirmed", "candidates.possible", "references.confirmed", "references.possible", "owners.confirmed", "owners.possible", "sources"], capabilities: ["core:symbol_declarations", "core:symbol_resolution"], rankings: [] },
  "core:definition_to_instances": { schema: "core:DefinitionToInstancesArguments", stages: ["definitions:core:discover_definitions@1", "record_selector:bind.record_selector@1", "instances:core:find_records@1"], bindings: ["$/matcher->definitions.matcher", "$/selector.definition_types->definitions.selector.definition_types", "$/selector.namespaces->definitions.selector.namespaces", "$/selector.plugin_ids->definitions.selector.plugin_ids", "$/selector.lifecycle_states->definitions.selector.lifecycle_states", "definitions.definition_set->record_selector", "$/record_categories->record_selector.record_categories", "$/producer_ids->record_selector.producer_ids", "$/filter->record_selector.filter", "record_selector.selector->instances.selector"], guards: ["core:instance_definition_families"], outputs: ["definitions", "instances"], streams: ["definitions", "instances"], capabilities: [], rankings: [] },
};

const recipeStaticArguments: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, RecipeStaticArgumentValue>>>>>> = {
  "core:locate_implementation": { search: { require_structural_subject: true }, implementations: { filter: { kind_selector: { any_facets: ["core:definition"] } } }, source: { source: { mode: "relevant" }, include_related_evidence: true } },
  "core:understand_change_impact": { impact: { include_transitive: true, include_tests: true }, source: { source: { mode: "relevant" }, include_related_evidence: true } },
  "core:prepare_symbol_change": { impact: { include_transitive: true, include_tests: true }, references: { include_declarations: false }, tests: { relationship_scope: "both", include_fixtures: true }, source: { source: { mode: "relevant" }, include_related_evidence: true } },
  "core:prepare_new_feature": { seeds: { require_structural_subject: true }, architecture: { views: ["entry_points", "boundaries", "public_surfaces", "extension_points", "layers"], max_relation_depth: 5 }, context: { facets: ["definitions", "implementations", "dependencies", "contracts", "effects", "tests", "configuration", "analogues", "extension_points"] }, tests: { relationship_scope: "both", include_fixtures: true } },
  "core:trace_behavior": { trace: { min_depth: 1, path_policy: "simple_relations" }, source: { source: { mode: "relevant" }, include_related_evidence: true } },
  "core:find_relevant_tests": { tests: { relationship_scope: "both", include_fixtures: true }, source: { source: { mode: "relevant" }, include_related_evidence: true } },
  "core:explain_architecture_slice": { architecture: { max_relation_depth: 5 }, source: { source: { mode: "relevant" }, include_related_evidence: true } },
  "core:compare_workspaces": { compare: { correlation_policy: "strict" } },
  "core:semantic_to_callers": { search: { require_structural_subject: true }, callers: { direction: "inbound", relations: { universal_kinds: ["core:call"] }, min_depth: 1, path_policy: "simple_relations" }, tests: { relationship_scope: "both", include_fixtures: false }, source: { source: { mode: "relevant" }, include_related_evidence: true } },
  "core:resolve_and_find_references": { references: { include_declarations: false }, source: { source: { mode: "relevant" }, include_related_evidence: true } },
  "core:definition_to_instances": { definitions: { include_full_definitions: false, selector: { definition_types: ["record_kind", "facet", "language"] } } },
};

const recipeGuardDefinitions: Readonly<Record<string, ReadonlyArray<{ guard_id: string; stage_id: string; evaluation_point: "before_stage" | "after_stage" | "before_output"; predicate_code: string; failure_error_code: readonly string[] }>>> = {
  "core:prepare_symbol_change": [{ guard_id: "core:one_confirmed_subject", stage_id: "resolve", evaluation_point: "after_stage", predicate_code: "core:one_confirmed_subject", failure_error_code: ["core:selector_ambiguous", "core:selector_not_found"] },
  ],
  "core:compare_workspaces": [{ guard_id: "core:comparison_roles_base_target", stage_id: "compare", evaluation_point: "before_stage", predicate_code: "core:comparison_roles_base_target", failure_error_code: ["core:invalid_query_scope"] }],
  "core:definition_to_instances": [{ guard_id: "core:instance_definition_families", stage_id: "definitions", evaluation_point: "after_stage", predicate_code: "core:instance_definition_families", failure_error_code: ["core:invalid_definition_instance_selector"] }],
};
const recipeOutputStages: Readonly<Record<string, Readonly<Record<string, { stage_id: string; stage_output: string; projection: "subjects" | "relations" | "paths" | "definitions" }>>>> = {
  "core:locate_implementation": { implementations: { stage_id: "implementations", stage_output: "subjects", projection: "subjects" }, sources: { stage_id: "source", stage_output: "sources", projection: "subjects" } },
  "core:understand_change_impact": { will_break: { stage_id: "impact", stage_output: "will_break", projection: "subjects" }, must_update: { stage_id: "impact", stage_output: "must_update", projection: "subjects" }, may_be_affected: { stage_id: "impact", stage_output: "may_be_affected", projection: "subjects" }, tests_to_run: { stage_id: "impact", stage_output: "tests_to_run", projection: "subjects" }, uncertain_dynamic_usage: { stage_id: "impact", stage_output: "uncertain_dynamic_usage", projection: "subjects" }, sources: { stage_id: "source", stage_output: "sources", projection: "subjects" } },
  "core:prepare_symbol_change": { target: { stage_id: "resolve", stage_output: "declarations", projection: "subjects" }, will_break: { stage_id: "impact", stage_output: "will_break", projection: "subjects" }, must_update: { stage_id: "impact", stage_output: "must_update", projection: "subjects" }, may_be_affected: { stage_id: "impact", stage_output: "may_be_affected", projection: "subjects" }, tests_to_run: { stage_id: "impact", stage_output: "tests_to_run", projection: "subjects" }, uncertain_dynamic_usage: { stage_id: "impact", stage_output: "uncertain_dynamic_usage", projection: "subjects" }, references: { stage_id: "references", stage_output: "references", projection: "relations" }, tests: { stage_id: "tests", stage_output: "tests", projection: "subjects" }, fixtures: { stage_id: "tests", stage_output: "fixtures", projection: "subjects" }, mocks: { stage_id: "tests", stage_output: "mocks", projection: "subjects" }, helpers: { stage_id: "tests", stage_output: "helpers", projection: "subjects" }, sources: { stage_id: "source", stage_output: "sources", projection: "subjects" } },
  "core:prepare_new_feature": { analogues: { stage_id: "analogues", stage_output: "records", projection: "subjects" }, architecture: { stage_id: "architecture", stage_output: "all_requested_views", projection: "subjects" }, context: { stage_id: "context", stage_output: "context", projection: "subjects" }, tests: { stage_id: "tests", stage_output: "tests", projection: "subjects" }, fixtures: { stage_id: "tests", stage_output: "fixtures", projection: "subjects" }, mocks: { stage_id: "tests", stage_output: "mocks", projection: "subjects" }, helpers: { stage_id: "tests", stage_output: "helpers", projection: "subjects" } },
  "core:trace_behavior": { subjects: { stage_id: "trace", stage_output: "subjects", projection: "subjects" }, relations: { stage_id: "trace", stage_output: "relations", projection: "relations" }, paths: { stage_id: "trace", stage_output: "paths", projection: "paths" }, sources: { stage_id: "source", stage_output: "sources", projection: "subjects" } },
  "core:find_relevant_tests": { tests: { stage_id: "tests", stage_output: "tests", projection: "subjects" }, fixtures: { stage_id: "tests", stage_output: "fixtures", projection: "subjects" }, mocks: { stage_id: "tests", stage_output: "mocks", projection: "subjects" }, helpers: { stage_id: "tests", stage_output: "helpers", projection: "subjects" }, sources: { stage_id: "source", stage_output: "sources", projection: "subjects" } },
  "core:explain_architecture_slice": { architecture: { stage_id: "architecture", stage_output: "all_requested_views", projection: "subjects" }, sources: { stage_id: "source", stage_output: "sources", projection: "subjects" } },
  "core:compare_workspaces": { added: { stage_id: "compare", stage_output: "added", projection: "subjects" }, removed: { stage_id: "compare", stage_output: "removed", projection: "subjects" }, changed: { stage_id: "compare", stage_output: "changed", projection: "subjects" }, moved: { stage_id: "compare", stage_output: "moved", projection: "subjects" }, correlated: { stage_id: "compare", stage_output: "correlated", projection: "subjects" } },
  "core:semantic_to_callers": { matches: { stage_id: "search", stage_output: "candidates", projection: "subjects" }, callers: { stage_id: "callers", stage_output: "subjects", projection: "subjects" }, call_paths: { stage_id: "callers", stage_output: "paths", projection: "paths" }, tests: { stage_id: "tests", stage_output: "tests", projection: "subjects" }, sources: { stage_id: "source", stage_output: "sources", projection: "subjects" } },
  "core:resolve_and_find_references": { declarations: { stage_id: "resolve", stage_output: "declarations", projection: "subjects" }, candidates: { stage_id: "resolve", stage_output: "candidates", projection: "subjects" }, references: { stage_id: "references", stage_output: "references", projection: "relations" }, owners: { stage_id: "references", stage_output: "owners", projection: "subjects" }, sources: { stage_id: "source", stage_output: "sources", projection: "subjects" } },
  "core:definition_to_instances": { definitions: { stage_id: "definitions", stage_output: "definitions", projection: "definitions" }, instances: { stage_id: "instances", stage_output: "records", projection: "subjects" } },
};

const operatorArgumentSchemaCoordinates: Readonly<Record<string, string>> = {
    "core:discover_definitions": "core:DiscoverDefinitionsArguments", "core:find_records": "core:FindRecordsArguments", "core:resolve_symbol": "core:ResolveSymbolArguments", "core:get_outline": "core:GetOutlineArguments", "core:find_references": "core:FindReferencesArguments", "core:expand_relations": "core:ExpandRelationsArguments", "core:find_paths": "core:FindPathsArguments", "core:find_artifacts": "core:FindArtifactsArguments", "core:search_text": "core:SearchTextArguments", "core:search_semantic": "core:SearchSemanticArguments", "core:search_hybrid": "core:SearchHybridArguments", "core:get_source": "core:GetSourceArguments", "core:analyze_impact": "core:AnalyzeImpactArguments", "core:find_related_tests": "core:FindRelatedTestsArguments", "core:inspect_architecture": "core:InspectArchitectureArguments", "core:compare": "core:CompareArguments", "core:build_context": "core:BuildContextArguments", "core:index_status": "core:IndexStatusArguments", "bind.record_selector": "core:RecipeStaticArguments", "bind.subject_record_selector": "core:RecipeStaticArguments", "filter": "core:RecipeStaticArguments",
};

export const recipeDefinitions: readonly RecipeDefinition[] = recipeRegistryEntries.map((recipe) => {
  const [recipe_id = recipe.id, versionText = "1"] = recipe.id.split("@");
  const spec = recipeSpecs[recipe_id];
  if (!spec) throw new Error(`Missing public recipe definition for ${recipe_id}`);
  const stages = materializeRecipeStages(recipe_id, spec.stages, spec.bindings);
  const argument_bindings = materializeRecipeBindings(spec.bindings);
  const guards = (recipeGuardDefinitions[recipe_id] ?? []).map((guard) => ({ ...guard, guard_code: guard.guard_id, failure_code: guard.failure_error_code[0] ?? "" }));
  const outputs = spec.outputs.map((output) => { const exact = recipeOutputStages[recipe_id]?.[output]; if (!exact) throw new Error(`Missing authoritative recipe output mapping for ${recipe_id}.${output}`); return { output_name: output, ...exact }; });
  const streams = spec.streams.map((stream) => { const [output_name = stream, rawClassification = "unclassified"] = stream.split("."); const classification = (rawClassification === "confirmed" || rawClassification === "possible" ? rawClassification : "unclassified") as "confirmed" | "possible" | "unclassified"; return { stream_name: stream, output_name, classification, classifications: [classification], ordering_id: "core:query_manifest_stream_order", ordering_comparator_id: "core:query_manifest_stream_order", ordering_comparator_version: 1 }; });
  const ranking_bindings = spec.rankings.map((ranking) => { const [stage_id = "", profile = ""] = ranking.split("="); const [ranking_profile_id = profile, versionText = "1"] = profile.split("@"); return { stage_id, ranking_profile_id, ranking_profile_version: Number(versionText) }; });
  const definition = {
    recipe_id,
    recipe_version: Number(versionText),
    public_api_version: 1,
    description: recipe.description,
    argument_schema_id: spec.schema,
    argument_schema_version: 1,
    stages,
    operation_stages: stages,
    argument_bindings,
    guards,
    outputs,
    streams,
    pagination_streams: streams,
    required_capabilities: spec.capabilities,
    ranking_bindings,
    lifecycle_state: recipe.lifecycle_state,
    completeness_policy: "report" as const,
    recipe_digest: "",
  };
  const recipe_digest = `sha256:${createHash("sha256").update(JSON.stringify(definition)).digest("hex")}`;
  return { ...definition, recipe_digest };
});

function materializeRecipeStages(recipeId: string, stageSpecs: readonly string[], bindingSpecs: readonly string[]): readonly RecipeStageDefinition[] {
  return stageSpecs.map((stageSpec) => {
    const separator = stageSpec.indexOf(":");
    const stage_id = separator < 0 ? stageSpec : stageSpec.slice(0, separator);
    const operator = separator < 0 ? stageSpec : stageSpec.slice(separator + 1);
    const [operator_id = operator, versionText = "1"] = operator.split("@");
    const argument_bindings = materializeRecipeBindings(bindingSpecs).filter((binding) => binding.stage_id === stage_id);
    const static_arguments = recipeStaticArguments[recipeId]?.[stage_id] ?? {};
    const partial_arguments_schema_id = operatorArgumentSchemaCoordinates[operator_id];
    if (!partial_arguments_schema_id) throw new Error(`Missing authoritative recipe stage argument schema for ${operator_id}`);
    return { stage_id, operator_id, operator_version: Number(versionText), input_references: argument_bindings.flatMap((binding) => binding.source_output_reference ? [binding.source_output_reference] : []), static_arguments, static_arguments_schema_id: "core:RecipeStaticArguments", static_arguments_schema_version: 1, static_arguments_schema_coordinate: "core:RecipeStaticArguments@1", partial_arguments_schema_id, partial_arguments_schema_version: 1, partial_arguments_schema_coordinate: `${partial_arguments_schema_id}@1`, argument_bindings };
  });
}

function materializeRecipeBindings(bindingSpecs: readonly string[]): readonly RecipeArgumentBindingDefinition[] {
  return bindingSpecs.map((binding) => {
    const [source = "", target = ""] = binding.split("->");
    const [stage_id = "", ...fieldParts] = target.split(".");
    const stage_argument_path = fieldParts.length > 0 ? `/${fieldParts.join("/")}` : "";
    return source.startsWith("$/")
      ? { recipe_argument_path: source, stage_id, stage_argument_path }
      : { source_output_reference: source, stage_id, stage_argument_path };
  });
}

const comparatorSortKeys: Readonly<Record<string, readonly ComparatorSortKeyDefinition[]>> = {
  "core:source_observation_order": [{ value_path: "", comparison_mode: "uce_bytes", direction: "ascending", absent_order: "forbidden" }],
  "core:visible_source_state_order": [{ value_path: "", comparison_mode: "uce_bytes", direction: "ascending", absent_order: "forbidden" }],
  "core:capability_state_order": [{ value_path: "", comparison_mode: "uce_bytes", direction: "ascending", absent_order: "forbidden" }],
  "core:retention_root_order": [{ value_path: "", comparison_mode: "uce_bytes", direction: "ascending", absent_order: "forbidden" }],
  "core:stored_object_order": [{ value_path: "", comparison_mode: "uce_bytes", direction: "ascending", absent_order: "forbidden" }],
  "core:registry_definition_order": [{ value_path: "", comparison_mode: "uce_bytes", direction: "ascending", absent_order: "forbidden" }],
  "core:record_artifact_dependency_order": [
    { value_path: "/record_id", comparison_mode: "text_utf8", direction: "ascending", absent_order: "forbidden" },
    { value_path: "/dependency_artifact_version_id", comparison_mode: "text_utf8", direction: "ascending", absent_order: "forbidden" },
    { value_path: "/dependency_role", comparison_mode: "text_utf8", direction: "ascending", absent_order: "forbidden" },
  ],
  "core:record_id_order": [{ value_path: "/record_id", comparison_mode: "text_utf8", direction: "ascending", absent_order: "forbidden" }],
  "core:projection_record_id_order": [{ value_path: "/projection_record_id", comparison_mode: "text_utf8", direction: "ascending", absent_order: "forbidden" }],
  "core:semantic_projection_order": [{ value_path: "/projection_record_id", comparison_mode: "text_utf8", direction: "ascending", absent_order: "forbidden" }],
  "core:semantic_coverage_order": [
    { value_path: "/owner_artifact_id", comparison_mode: "text_utf8", direction: "ascending", absent_order: "forbidden" },
    { value_path: "/semantic_artifact_coverage_id", comparison_mode: "text_utf8", direction: "ascending", absent_order: "forbidden" },
  ],
  "core:queryable_vector_order": [{ value_path: "/projection_record_id", comparison_mode: "text_utf8", direction: "ascending", absent_order: "forbidden" }],
  "core:participant_ordinal_order": [{ value_path: "/participant_ordinal", comparison_mode: "safe_integer_numeric", direction: "ascending", absent_order: "forbidden" }],
  "core:package_file_path_order": [{ value_path: "/normalized_relative_path", comparison_mode: "text_utf8", direction: "ascending", absent_order: "forbidden" }],
  "core:namespace_owner_order": [
    { value_path: "/namespace", comparison_mode: "text_utf8", direction: "ascending", absent_order: "forbidden" },
    { value_path: "/plugin_id", comparison_mode: "text_utf8", direction: "ascending", absent_order: "forbidden" },
    { value_path: "/plugin_version", comparison_mode: "text_utf8", direction: "ascending", absent_order: "forbidden" },
    { value_path: "/contribution_digest", comparison_mode: "digest_bytes", direction: "ascending", absent_order: "forbidden" },
  ],
  "core:operation_id_order": [
    { value_path: "/operation_id", comparison_mode: "text_utf8", direction: "ascending", absent_order: "forbidden" },
    { value_path: "/operation_version", comparison_mode: "safe_integer_numeric", direction: "ascending", absent_order: "forbidden" },
  ],
  "core:recipe_id_order": [
    { value_path: "/recipe_id", comparison_mode: "text_utf8", direction: "ascending", absent_order: "forbidden" },
    { value_path: "/recipe_version", comparison_mode: "safe_integer_numeric", direction: "ascending", absent_order: "forbidden" },
  ],
  "core:query_manifest_stream_order": [
    { value_path: "/result_set", comparison_mode: "text_utf8", direction: "ascending", absent_order: "forbidden" },
    { value_path: "/result_classification", comparison_mode: "text_utf8", direction: "ascending", absent_order: "forbidden" },
    { value_path: "/ordinal", comparison_mode: "safe_integer_numeric", direction: "ascending", absent_order: "forbidden" },
  ],
};

export const comparatorDefinitions: readonly ComparatorDefinition[] = comparatorRegistryEntries.map((comparator) => {
  const [comparator_id = comparator.id, versionText = "1"] = comparator.id.split("@");
  const sort_keys = comparatorSortKeys[comparator_id];
  if (!sort_keys || sort_keys.length === 0) throw new Error(`Missing authoritative comparator sort keys for ${comparator_id}@${versionText}`);
  return {
    comparator_id,
    comparator_version: Number(versionText),
    definition_revision: comparator.definition_revision,
    schema_version: comparator.schema_version,
    description: comparator.description,
    sort_keys,
    lifecycle_state: comparator.lifecycle_state,
  };
});

export const operationErrorDefinitions: readonly OperationErrorDefinition[] = operationErrorRegistryEntries.map((error) => ({
  code: error.id,
  definition_revision: error.definition_revision,
  schema_version: error.schema_version,
  description: error.description,
  retryable_default: errorPolicy[error.id]?.retryable ?? (() => { throw new Error(`Missing operation-error policy for ${error.id}`); })(),
  recovery_actions: errorPolicy[error.id]?.recovery ?? (() => { throw new Error(`Missing operation-error recovery for ${error.id}`); })(),
  details_schema: closedPayload(error.id),
  lifecycle_state: error.lifecycle_state,
}));

export const diagnosticDefinitions: readonly DiagnosticDefinition[] = diagnosticRegistryEntries.map((diagnostic) => ({
  code: diagnostic.id,
  definition_revision: diagnostic.definition_revision,
  schema_version: diagnostic.schema_version,
  diagnostic_category: diagnosticCategories[diagnostic.id] ?? (() => { throw new Error(`Missing diagnostic category for ${diagnostic.id}`); })(),
  title: diagnosticTitles[diagnostic.id] ?? (() => { throw new Error(`Missing diagnostic title for ${diagnostic.id}`); })(),
  description: diagnostic.description,
  emission_condition: diagnosticEmissionConditions[diagnostic.id] ?? (() => { throw new Error(`Missing diagnostic emission condition for ${diagnostic.id}`); })(),
  default_severity: diagnosticSeverities[diagnostic.id] ?? (() => { throw new Error(`Missing diagnostic severity for ${diagnostic.id}`); })(),
  allowed_severities: diagnosticAllowedSeverities[diagnostic.id] ?? (() => { throw new Error(`Missing diagnostic severities for ${diagnostic.id}`); })(),
  allowed_scope_types: diagnosticScopes[diagnostic.id] ?? (() => { throw new Error(`Missing diagnostic scopes for ${diagnostic.id}`); })(),
  payload_schema: diagnosticPayloads[diagnostic.id] ?? (() => { throw new Error(`Missing diagnostic payload for ${diagnostic.id}`); })(),
  lifecycle_state: diagnostic.lifecycle_state,
}));

export const candidateIssueDefinitions: readonly CandidateIssueDefinition[] = candidateIssueRegistryEntries.map((issue) => ({
  issue_code: issue.id,
  definition_revision: issue.definition_revision,
  schema_version: issue.schema_version,
  description: issue.description,
  issue_category: candidateIssueCategories[issue.id] ?? (() => { throw new Error(`Missing candidate-issue category for ${issue.id}`); })(),
  allowed_phases: candidateIssuePhaseMap[issue.id] ?? (() => { throw new Error(`Missing candidate-issue phases for ${issue.id}`); })(),
  default_severity: candidateIssueSeverities[issue.id] ?? (() => { throw new Error(`Missing candidate-issue severity for ${issue.id}`); })(),
  allowed_severities: candidateIssueAllowedSeverities[issue.id] ?? (() => { throw new Error(`Missing candidate-issue severities for ${issue.id}`); })(),
  default_retryability: candidateIssueRetryability[issue.id] ?? (() => { throw new Error(`Missing candidate-issue retryability for ${issue.id}`); })(),
  allowed_retryabilities: candidateIssueAllowedRetryability[issue.id] ?? (() => { throw new Error(`Missing candidate-issue retryabilities for ${issue.id}`); })(),
  payload_schema: candidateIssuePayloads[issue.id] ?? (() => { throw new Error(`Missing candidate-issue payload for ${issue.id}`); })(),
  lifecycle_state: issue.lifecycle_state,
}));

export const operationRegistry: readonly OperationDefinition[] = operationDefinitions;
export const recipeRegistry: readonly RecipeDefinition[] = recipeDefinitions;
export const comparatorRegistry: readonly ComparatorDefinition[] = comparatorDefinitions;
export const operationErrorRegistry: readonly OperationErrorDefinition[] = operationErrorDefinitions;
export const diagnosticRegistry: readonly DiagnosticDefinition[] = diagnosticDefinitions;
export const candidateIssueRegistry: readonly CandidateIssueDefinition[] = candidateIssueDefinitions;
export const coreOperationErrorCodeRegistry = operationErrorRegistry;
export const diagnosticCodeRegistry = diagnosticRegistry;
