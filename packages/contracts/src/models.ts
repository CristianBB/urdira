export type Identifier = string;
export type NamespacedIdentifier = string;
export type Digest = string;
export type JsonValue = string | number | boolean | null | ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue };
export type ClosedPayloadValue = string | number | boolean | null | ReadonlyArray<string | number | boolean | null> | Readonly<Record<string, string | number | boolean | null>>;
export type OperationErrorDetails = Readonly<Record<string, ClosedPayloadValue>>;
export type DiagnosticPayload = Readonly<Record<string, ClosedPayloadValue>>;
export type CandidateIssuePayload = Readonly<Record<string, ClosedPayloadValue>>;
export interface PayloadPropertyDefinition { type: "string" | "integer" | "boolean" | "array" | "object"; description: string; enum?: ReadonlyArray<string>; items?: PayloadPropertyDefinition; properties?: Readonly<Record<string, PayloadPropertyDefinition>>; required?: ReadonlyArray<string>; minimum?: number; maximum?: number; }
export interface ClosedPayloadSchema { type: "object"; additionalProperties: false; properties: Readonly<Record<string, PayloadPropertyDefinition>>; required: ReadonlyArray<string>; }

export interface SchemaFieldDefinition { field_name: string; description: string; presence: "required" | "optional"; value_type: CanonicalTypeExpression; }
export interface SchemaVariantDefinition { discriminator_value: string; description: string; fields: ReadonlyArray<SchemaFieldDefinition>; }
export interface CanonicalNamedTypeDefinition { type_name: string; description: string; type_expression: CanonicalTypeExpression; }
export interface NullTypeExpression { type_kind: "null"; }
export interface BooleanTypeExpression { type_kind: "boolean"; }
export interface SafeIntegerTypeExpression { type_kind: "safe_integer"; minimum?: number; maximum?: number; }
export interface BigIntegerTypeExpression { type_kind: "big_integer"; minimum?: string; maximum?: string; }
export interface Float64TypeExpression { type_kind: "float64"; minimum?: number; maximum?: number; }
export interface ExactDecimalTypeExpression { type_kind: "exact_decimal"; minimum?: string; maximum?: string; scale_policy: "significant" | "insignificant"; }
export interface TextTypeExpression { type_kind: "text"; identifier_kind?: "identifier" | "namespaced_identifier" | "semver" | "uri"; minimum_code_point_count?: number; maximum_code_point_count?: number; }
export interface BytesTypeExpression { type_kind: "bytes"; minimum_byte_length?: number; maximum_byte_length?: number; bound_schema_id_field?: string; bound_schema_version_field?: string; }
export interface TimestampTypeExpression { type_kind: "timestamp"; earliest?: string; latest?: string; }
export interface DigestTypeExpression { type_kind: "digest"; allowed_hash_algorithms: ReadonlyArray<string>; }
export interface EnumTypeExpression { type_kind: "enum"; values: ReadonlyArray<string>; }
export interface SequenceTypeExpression { type_kind: "sequence"; element_type: CanonicalTypeExpression; minimum_item_count?: number; maximum_item_count?: number; }
export interface SetTypeExpression { type_kind: "set"; element_type: CanonicalTypeExpression; minimum_item_count?: number; maximum_item_count?: number; }
export interface OrderedSetTypeExpression { type_kind: "ordered_set"; element_type: CanonicalTypeExpression; comparator_id: string; comparator_version: number; minimum_item_count?: number; maximum_item_count?: number; }
export interface MapTypeExpression { type_kind: "map"; value_type: CanonicalTypeExpression; minimum_entry_count?: number; maximum_entry_count?: number; }
export interface RecordTypeExpression { type_kind: "record"; fields: ReadonlyArray<SchemaFieldDefinition>; }
export interface UnionTypeExpression { type_kind: "union"; discriminator_field: string; discriminator_description: string; variants: ReadonlyArray<SchemaVariantDefinition>; }
export interface SchemaReferenceTypeExpression { type_kind: "schema_reference"; reference_scope: "local" | "external"; type_name: string; schema_id?: string; schema_version?: number; }
export type CanonicalTypeExpression = NullTypeExpression | BooleanTypeExpression | SafeIntegerTypeExpression | BigIntegerTypeExpression | Float64TypeExpression | ExactDecimalTypeExpression | TextTypeExpression | BytesTypeExpression | TimestampTypeExpression | DigestTypeExpression | EnumTypeExpression | SequenceTypeExpression | SetTypeExpression | OrderedSetTypeExpression | MapTypeExpression | RecordTypeExpression | UnionTypeExpression | SchemaReferenceTypeExpression;
export interface CanonicalSchemaDefinition { schema_id: string; definition_revision: number; schema_version: number; description: string; root_type: CanonicalTypeExpression; type_definitions: ReadonlyArray<CanonicalNamedTypeDefinition>; plugin_owner?: string; lifecycle_state: "active" | "deprecated" | "retired"; deprecated_since?: number; retired_since?: number; replacement_schema?: string; }

export interface RecordEnvelope<Payload = JsonValue> {
  record_id: Identifier;
  category: "entity" | "relation" | "fact" | "evidence" | "diagnostic";
  kind: string;
  universal_kind: string;
  facets: ReadonlyArray<string>;
  schema_version: number;
  workspace_id: Identifier;
  owner_artifact_id: Identifier;
  owner_artifact_version_id: Identifier;
  primary_source_span?: SourceSpan;
  valid_from_generation: number;
  valid_to_generation?: number;
  producer_id: string;
  producer_version: string;
  analysis_digest: Digest;
  analysis_configuration_digest: Digest;
  artifact_dependency_digest: Digest;
  payload: Payload;
  record_digest: Digest;
}
export interface EntityRecord<Payload = JsonValue> extends RecordEnvelope<Payload> { category: "entity"; }
export interface RelationRecord<Payload = JsonValue> extends RecordEnvelope<Payload> { category: "relation"; }
export interface FactRecord<Payload = JsonValue> extends RecordEnvelope<Payload> { category: "fact"; }
export interface EvidenceRecord<Payload = JsonValue> extends RecordEnvelope<Payload> { category: "evidence"; }
export interface DiagnosticRecord<Payload = JsonValue> extends RecordEnvelope<Payload> { category: "diagnostic"; }

export interface SingleWorkspaceScope { scope_type: "single_workspace"; workspace_id: Identifier; snapshot_id?: Identifier; }
export interface QueryParticipant { workspace_id: string; role: string; snapshot_id?: string; }
export interface ComparisonScope { scope_type: "comparison"; participants: ReadonlyArray<QueryParticipant>; }
export type QueryScope = SingleWorkspaceScope | ComparisonScope;
export interface OperationExpression { expression_type: "operation"; operation: string; arguments: OperationArguments; }
export interface PipelineExpression { expression_type: "pipeline"; stages: ReadonlyArray<QueryStage>; outputs: ReadonlyArray<StageOutputReference>; }
export interface RecipeExpression { expression_type: "recipe"; recipe_id: string; recipe_version?: number; arguments: RecipeArguments; }
export type QueryExpression = OperationExpression | PipelineExpression | RecipeExpression;
export interface QueryStage { stage_id: string; operator: string; inputs: ReadonlyArray<StageOutputReference>; arguments: QueryStageArguments; }
export interface StageOutputReference { stage_id: string; output: string; }
export interface ResponseBudget { max_items: number; max_characters: number; }
export interface QueryOptions { freshness: "snapshot" | "current" | "wait_for_current"; wait_timeout_ms: number; coverage_requirement: "accept_reported" | "require_complete"; evidence: EvidenceIncludeOptions; diagnostics: DiagnosticIncludeOptions; snippets: SourceIncludeOptions; registry: RegistryIncludeOptions; response_budget: ResponseBudget; }
export interface QueryRequest { api_version: number; scope: QueryScope; expression: QueryExpression; options: QueryOptions; }
export interface ContinuationRequest { api_version: number; scope: QueryScope; cursor: string; response_budget: ResponseBudget; }
export interface DefinitionMatcher { text: string; mode: "exact" | "prefix" | "contains" | "semantic" | "hybrid"; definition_types?: ReadonlyArray<string>; namespaces?: ReadonlyArray<string>; limit?: number; }
export interface DefinitionSetReference { stage_id: string; output: string; }
export interface FindRecordsArguments { selector: RecordStructuralSelector; }
export interface DiscoverDefinitionsArguments { matcher: DefinitionMatcher; selector?: RegistrySelector; include_full_definitions?: boolean; }
export interface ResolveSymbolArguments { reference: string; context_artifact?: Identifier; context_byte_offset?: number; kind_selector?: KindSelector; resolution_scope?: "visible" | "workspace" | "exports"; }
export interface GetOutlineArguments { container: SubjectSelector; depth?: number; include_non_public?: boolean; filter?: StructuralFilter; }
export interface FindReferencesArguments { target: SubjectSelector; reference_roles?: ReadonlyArray<string>; include_declarations?: boolean; filter?: StructuralFilter; }
export interface ExpandRelationsArguments { subjects: ReadonlyArray<SubjectSelector> | StageOutputSubjectSelector; direction: "inbound" | "outbound" | "both"; relations: RelationSelector; min_depth?: number; max_depth?: number; path_policy?: "simple_subjects" | "simple_relations"; filter?: StructuralFilter; }
export interface FindPathsArguments { sources: ReadonlyArray<SubjectSelector> | StageOutputSubjectSelector; targets: ReadonlyArray<SubjectSelector> | StageOutputSubjectSelector; direction?: "outbound" | "inbound" | "both"; relations: RelationSelector; max_depth: number; all_shortest?: boolean; }
export interface FindArtifactsArguments { filter?: StructuralFilter; }
export interface SearchTextArguments { pattern: string; syntax?: "literal" | "safe_regex"; case_sensitive?: boolean; word_mode?: "substring" | "identifier" | "token"; filter?: StructuralFilter; result_projection?: "match" | "artifact" | "record" | "entity"; }
export interface SearchSemanticArguments { query_text: string; query_class: "natural_text" | "identifier" | "source_code" | "mixed"; filter?: StructuralFilter; require_structural_subject?: boolean; }
export type SearchHybridArguments = SearchSemanticArguments;
export interface GetSourceArguments { subjects: ReadonlyArray<SubjectSelector> | StageOutputSubjectSelector; source: SourceIncludeOptions; include_related_evidence?: boolean; }
export interface AnalyzeImpactArguments { target: SubjectSelector; change: ChangeDescriptor; include_transitive?: boolean; include_tests?: boolean; filter?: StructuralFilter; }
export interface FindRelatedTestsArguments { subjects: ReadonlyArray<SubjectSelector> | StageOutputSubjectSelector; relationship_scope?: "direct" | "transitive" | "both"; include_fixtures?: boolean; filter?: StructuralFilter; }
export interface InspectArchitectureArguments { scope?: ReadonlyArray<SubjectSelector>; views: ReadonlyArray<"entry_points" | "boundaries" | "public_surfaces" | "cycles" | "extension_points" | "layers">; max_relation_depth?: number; filter?: StructuralFilter; }
export interface CompareArguments { selection?: ReadonlyArray<SubjectSelector>; comparison_kinds: ReadonlyArray<"added" | "removed" | "changed" | "moved" | "correlated">; correlation_policy?: "strict" | "include_possible"; filter?: StructuralFilter; }
export interface BuildContextArguments { task: string; query_class?: "natural_text" | "identifier" | "source_code" | "mixed"; seeds?: ReadonlyArray<SubjectSelector>; facets: ReadonlyArray<"definitions" | "implementations" | "callers" | "callees" | "dependencies" | "contracts" | "effects" | "tests" | "configuration" | "analogues" | "extension_points">; filter?: StructuralFilter; }
export interface IndexStatusArguments { include_capabilities?: boolean; include_plugins?: boolean; include_activation_issues?: boolean; include_candidate_issues?: boolean; }
export type OperationArguments = DiscoverDefinitionsArguments | FindRecordsArguments | ResolveSymbolArguments | GetOutlineArguments | FindReferencesArguments | ExpandRelationsArguments | FindPathsArguments | FindArtifactsArguments | SearchTextArguments | SearchSemanticArguments | GetSourceArguments | AnalyzeImpactArguments | FindRelatedTestsArguments | InspectArchitectureArguments | CompareArguments | BuildContextArguments | IndexStatusArguments;
export type RecipeArguments = LocateImplementationArguments | UnderstandChangeImpactArguments | PrepareSymbolChangeArguments | PrepareNewFeatureArguments | TraceBehaviorArguments | FindRelevantTestsArguments | ExplainArchitectureSliceArguments | CompareWorkspacesArguments | SemanticToCallersArguments | ResolveAndFindReferencesArguments | DefinitionToInstancesArguments;
export type QueryStageArguments = OperationArguments | RecipeStaticArguments;
export interface KindSelector { kinds?: ReadonlyArray<string>; universal_kinds?: ReadonlyArray<string>; any_facets?: ReadonlyArray<string>; }
export interface RecordStructuralSelector { record_categories?: ReadonlyArray<"entity" | "relation" | "fact" | "evidence" | "diagnostic">; kind_selector?: KindSelector; producer_ids?: ReadonlyArray<string>; filter?: StructuralFilter; }
export interface EntitySubjectSelector { subject_type: "entity"; entity_id: Identifier; entity_record_id?: Identifier; }
export interface RecordSubjectSelector { subject_type: "record"; record_id: Identifier; }
export interface ArtifactIdSubjectSelector { subject_type: "artifact"; artifact_id: Identifier; artifact_version_id?: Identifier; }
export interface ArtifactPathSubjectSelector { subject_type: "artifact"; path: string; artifact_version_id?: Identifier; }
export type ArtifactSubjectSelector = ArtifactIdSubjectSelector | ArtifactPathSubjectSelector;
export interface SymbolSubjectSelector { subject_type: "symbol"; name: string; context_artifact?: Identifier | string; context_byte_offset?: number; kind_selector?: KindSelector; }
export interface StageOutputSubjectSelector { subject_type: "stage_output"; stage_id: string; output: string; }
export type SubjectSelector = EntitySubjectSelector | RecordSubjectSelector | ArtifactSubjectSelector | SymbolSubjectSelector | StageOutputSubjectSelector;
export interface StructuralFilter { paths?: ReadonlyArray<string>; languages?: ReadonlyArray<string>; namespaces?: ReadonlyArray<string>; kind_selector?: KindSelector; subject_types?: ReadonlyArray<"entity" | "record" | "artifact">; include_external?: boolean; include_generated?: boolean; }
export interface RelationSelector { relation_kinds?: ReadonlyArray<string>; universal_kinds?: ReadonlyArray<string>; roles?: ReadonlyArray<string>; evidence_class?: "confirmed" | "possible" | "both"; possible_confidence?: ReadonlyArray<"high" | "medium" | "low">; }
export interface RegistrySelector { definition_types?: ReadonlyArray<string>; namespaces?: ReadonlyArray<string>; plugin_ids?: ReadonlyArray<string>; lifecycle_states?: ReadonlyArray<"active" | "deprecated" | "retired">; }
export interface RegistryQueryOptions { mode: "none" | "used" | "full"; selector?: RegistrySelector; }
export interface DeleteChangeDescriptor { change_type: "delete"; }
export interface RenameChangeDescriptor { change_type: "rename"; new_name: string; }
export interface MoveChangeDescriptor { change_type: "move"; new_artifact_path: string; new_container?: string; }
export interface SignatureChangeDescriptor { change_type: "signature"; new_signature: string; compatibility_assumptions?: ReadonlyArray<string>; }
export interface TypeChangeDescriptor { change_type: "type"; new_type: string; compatibility_assumptions?: ReadonlyArray<string>; }
export interface VisibilityChangeDescriptor { change_type: "visibility"; new_visibility: string; }
export interface ContractChangeDescriptor { change_type: "contract"; contract_change_code: string; new_contract: string; compatibility_assumptions?: ReadonlyArray<string>; }
export interface BehaviorChangeDescriptor { change_type: "behavior"; behavior_change_code: string; description: string; affected_effects?: ReadonlyArray<string>; }
export type ChangeDescriptor = DeleteChangeDescriptor | RenameChangeDescriptor | MoveChangeDescriptor | SignatureChangeDescriptor | TypeChangeDescriptor | VisibilityChangeDescriptor | ContractChangeDescriptor | BehaviorChangeDescriptor;
export interface OperationError { code: string; message: string; retryable: boolean; recovery_action?: string; workspace_id?: Identifier; query_execution_id?: Identifier; details?: OperationErrorDetails; }
export interface OperationErrorCodeDefinition { code: string; definition_revision: number; schema_version: number; description: string; retryable_default: boolean; recovery_actions: ReadonlyArray<string>; details_schema: ClosedPayloadSchema; lifecycle_state: "active" | "deprecated" | "retired"; }
export interface AnalysisConfiguration { configuration_schema_id: NamespacedIdentifier; configuration_schema_version: number; normalized_configuration: Uint8Array; }
export interface ArtifactChange { artifact_change_id: string; workspace_id: string; artifact_id: string; change_kind: "created" | "updated" | "deleted" | "excluded" | "recreated" | "reincluded"; previous_artifact_version_id?: string; new_artifact_version_id?: string; previous_tombstone_id?: string; new_tombstone_id?: string; cause_references: ReadonlyArray<ChangeCauseReference>; lineage_evidence_record_ids: ReadonlyArray<string>; }
export const artifactChangeKinds = ["created", "updated", "deleted", "excluded", "recreated", "reincluded"] as const;
export interface PresentSourceStateEntry { state_kind: "present"; workspace_id: string; artifact_id: string; normalized_uri: string; artifact_kind: string; artifact_version_id: string; content_hash: string; byte_length: number; encoding: string; language_hint?: string; analysis_metadata_digest: string; valid_from_generation: number; }
export interface AbsentSourceStateEntry { state_kind: "absent"; workspace_id: string; artifact_id: string; normalized_uri: string; artifact_kind: string; artifact_tombstone_id: string; absence_kind: "deleted" | "excluded"; absence_reason_code: string; last_artifact_version_id?: string; valid_from_generation: number; }
export type VisibleSourceStateEntry = PresentSourceStateEntry | AbsentSourceStateEntry;
export type VisibleSourceStateSet = ReadonlyArray<VisibleSourceStateEntry>;

export interface Codebase {
  codebase_id: string;
  display_name: string;
  vcs_identity?: string;
  created_at: string;
  removed_at?: string;
}
export interface Workspace {
  workspace_id: string;
  codebase_id?: string;
  canonical_root: string;
  display_root: string;
  source_provider_bindings: ReadonlyArray<WorkspaceSourceProviderBinding>;
  current_snapshot_id?: string;
  status: string;
  vcs_state?: string;
  registered_at: string;
  relocated_at?: string;
  suspended_at?: string;
  removed_at?: string;
}
export interface WorkspaceConfigurationRevision {
  configuration_revision_id: string;
  schema_version: number;
  workspace_id: string;
  parent_configuration_revision_id?: string;
  effective_configuration_schema_id: NamespacedIdentifier;
  effective_configuration_schema_version: number;
  effective_configuration: Uint8Array;
  installation_policy_digest: Digest;
  user_policy_digest: Digest;
  workspace_file_digest: Digest;
  administrative_override_digest: Digest;
  analysis_configuration_digest: Digest;
  query_configuration_digest: Digest;
  resolved_embedding_binding_digests: ReadonlyArray<Digest>;
  created_at: string;
  reason_code: string;
  revision_digest: Digest;
}
export interface WorkspaceSourceProviderBinding {
  source_provider_binding_id: string;
  source_provider: string;
  source_provider_version: string;
  provider_role: string;
  binding_identity: string;
  configuration_digest: string;
}
export interface VcsState {
  provider: string;
  common_repository_id?: string;
  head_revision?: string;
  ref_kind?: string;
  ref_name?: string;
  detached: boolean;
  dirty: string;
  captured_at: string;
}
export interface Snapshot {
  snapshot_id: string;
  workspace_id: string;
  generation: number;
  parent_snapshot_id: string;
  generation_manifest_id: string;
  registry_snapshot_id: string;
  resolution_lock_id: string;
  configuration_revision_id: string;
  source_state_digest: string;
  /** Exact immutable source snapshot represented by this structural snapshot. */
  source_snapshot_id?: string;
  /** Versioned snapshot payload contract; omitted on legacy v1 rows. */
  snapshot_contract_version?: number;
  publication_stage_id?: string;
  publication_stage_ordinal?: number;
  publication_stage_count?: number;
  source_observation_watermarks: string;
  canonical_record_set_digest: string;
  projection_set_digests: string;
  capability_state_digest: string;
  published_at: string;
  snapshot_digest: string;
}
export interface WorkspaceCurrentState {
  workspace_id: string;
  current_snapshot_id: string;
  current_generation: number;
  current_registry_snapshot_id: string;
  current_resolution_lock_id: string;
  current_configuration_revision_id: string;
  current_freshness_checkpoint_id: string;
  state_revision: number;
  updated_at: string;
}
export interface WorkspaceFreshnessCheckpoint {
  freshness_checkpoint_id: string;
  workspace_id: string;
  snapshot_id: string;
  source_state_digest: string;
  provider_watermarks: string;
  verification_status: string;
  unavailable_artifact_ids: string;
  verified_at: string;
  checkpoint_digest: string;
}
export interface ProviderWatermark {
  source_provider_binding_id: string;
  source_provider: string;
  source_provider_version: string;
  ordering_domain: string;
  watermark_value: string;
  watermark_digest: string;
}
export interface ProjectionSetDigestEntry {
  projection_kind: string;
  generator: string;
  generator_version: string;
  generator_configuration_digest: string;
  projection_set_digest: string;
}
export interface SnapshotCapabilityStateEntry {
  capability: string;
  capability_contract_version: string;
  provider_id: string;
  provider_version: string;
  status: string;
  reason_codes: ReadonlyArray<string>;
  affected_artifact_ids: ReadonlyArray<string>;
  diagnostic_record_ids: ReadonlyArray<string>;
  /** Ordered structural publication coordinate, when the provider supports stages. */
  publication_stage_id?: string;
  publication_stage_ordinal?: number;
  publication_stage_count?: number;
}

/** Generic, language-neutral declaration of an ordered structural publication stage. */
export interface PluginStructuralStageDeclaration {
  stage_id: string;
  ordinal: number;
  stage_count: number;
  depends_on_stage_ids: ReadonlyArray<string>;
  capabilities: ReadonlyArray<string>;
}
export interface OrderedSetDescriptor {
  descriptor_id: string;
  element_type: string;
  element_schema_version: string;
  comparator_id: string;
  comparator_version: string;
  entry_count: number;
  content_digest: string;
}
export interface HashAlgorithmDefinition {
  hash_algorithm: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  digest_byte_length: string;
  specification_uri: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_hash_algorithm?: string;
}
export interface DigestDomainDefinition {
  digest_domain: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_digest_domain?: string;
}
export interface CanonicalComparatorDefinition {
  comparator_id: string;
  definition_revision: number;
  schema_version: number;
  comparator_version: string;
  description: string;
  sort_keys: ReadonlyArray<CanonicalComparatorSortKey>;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_comparator?: string;
}
export interface CanonicalComparatorSortKey {
  value_path: string;
  comparison_mode: string;
  direction: string;
  absent_order: string;
}
export interface ExternalVerificationContractDefinition {
  external_verification_contract_id: string;
  definition_revision: number;
  schema_version: number;
  contract_version: string;
  description: string;
  verified_input_schema_id: string;
  verified_input_schema_version: string;
  terminal_digest_recipe_id: string;
  terminal_digest_recipe_version: string;
  verification_semantics: string;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_external_verification_contract?: string;
}
export interface RuntimeComponentDefinition {
  component_id: string;
  definition_revision: number;
  schema_version: number;
  component_version: string;
  component_contracts: ReadonlyArray<RuntimeComponentContractBinding>;
  description: string;
  behavior_digest: string;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_component?: string;
}
export interface RuntimeComponentContractBinding {
  component_kind: string;
  contract_version: string;
  configuration_schema_id?: string;
  configuration_schema_version?: string;
}
export interface RuntimeComponentBuild {
  runtime_component_build_id: string;
  schema_version: number;
  component_id: string;
  component_version: string;
  behavior_digest: string;
  implementation_digest: string;
  available_from: string;
  selectable_to: string;
  removed_at: string;
}
export interface DigestRecipeDefinition {
  digest_recipe_id: string;
  definition_revision: number;
  schema_version: number;
  recipe_version: string;
  target_schema_id: string;
  target_schema_version: string;
  target_field: string;
  digest_domain: string;
  canonical_encoding_version: string;
  hash_algorithm: string;
  payload_schema_id: string;
  payload_schema_version: string;
  verified_input_schema_id?: string;
  verified_input_schema_version?: string;
  payload_binding: string;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_digest_recipe?: string;
}
export interface DigestComputationContext {
  target: JsonValue;
  verified_input?: string;
}
export type DigestPayloadBinding = ScalarDigestPayloadBinding | RecordDigestPayloadBinding;
export interface ScalarDigestPayloadBinding {
  binding_kind: string;
  source_path: string;
}
export interface RecordDigestPayloadBinding {
  binding_kind: string;
  field_bindings: ReadonlyArray<DigestPayloadFieldBinding>;
}
export interface DigestPayloadFieldBinding {
  payload_field: string;
  source_path: string;
  value_mode: string;
  referenced_digest_recipe_id?: string;
  referenced_digest_recipe_version?: string;
}
export interface DigestReferenceDefinition {
  digest_reference_id: string;
  definition_revision: number;
  schema_version: number;
  target_schema_id: string;
  target_schema_version: string;
  target_field: string;
  source_digest_recipe_id: string;
  source_digest_recipe_version: string;
  reference_kind: string;
  locator_bindings: ReadonlyArray<DigestLocatorBinding>;
  external_verification_contract_id?: string;
  external_verification_contract_version?: string;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_digest_reference?: string;
}
export interface DigestLocatorBinding {
  target_source_path: string;
  source_key_path: string;
}
export interface CanonicalEncodingErrorCodeDefinition {
  code: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  allowed_phases: ReadonlyArray<"decode" | "normalize" | "schema_validation" | "recipe_validation" | "hash" | "verify">;
  details_schema: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_code?: string;
}
export interface CanonicalEncodingConformanceCase {
  case_id: string;
  corpus_revision: string;
  input_kind: string;
  logical_input?: string;
  encoded_input_hex?: string;
  schema_id: string;
  schema_version: number;
  digest_recipe_id?: string;
  recipe_version?: string;
  expected_outcome: string;
  expected_cbor_hex?: string;
  expected_digest_text?: string;
  expected_error_code?: string;
}
export interface SourceProvider {
  component_id: string;
  component_version: string;
  describe: string;
  enumerate: string;
  read: string;
  watch: string;
  reconcile: string;
}
export interface SourceProviderRequestEnvelope {
  protocol_version: string;
  request_id: string;
  request_digest: string;
  call: string;
  workspace_id: string;
  source_provider_binding_id: string;
  component_id: string;
  component_version: string;
  deadline_at: string;
  cancellation_id: string;
  resource_budget: string;
  payload: JsonValue;
}
export interface SourceProviderResponseEnvelope {
  protocol_version: string;
  request_id: string;
  request_digest: string;
  call: string;
  workspace_id: string;
  source_provider_binding_id: string;
  component_id: string;
  component_version: string;
  outcome: string;
  payload?: JsonValue;
  error?: string;
}
export interface SourceProviderDescribeRequest {
  binding_configuration_digest: string;
}
export interface SourceProviderDescribeResult {
  provider_kind: string;
  immutable_binding_identity: string;
  features: string;
  source_state_fingerprint: string;
}
export interface SourceProviderEnumerateRequest {
  coverage_scopes: ReadonlyArray<ObservationCoverageScope>;
  previous_watermark?: string;
}
export interface SourceProviderEnumerateResult {
  observation_batch: string;
  watermark: string;
  capture_start_fingerprint: string;
  capture_end_fingerprint: string;
}
export interface SourceProviderReadRequest {
  artifact_id: string;
  normalized_uri: string;
  observed_content_hash: string;
  observed_metadata_digest: string;
  provider_version_token: string;
}
export interface SourceProviderReadResult {
  artifact_id: string;
  provider_version_token: string;
  content_bytes: string;
  content_hash: string;
  byte_length: number;
  metadata_digest: string;
}
export interface SourceProviderWatchRequest {
  after_watermark?: string;
  coverage_scopes: ReadonlyArray<ObservationCoverageScope>;
  max_wait_ms: number;
}
export interface SourceProviderWatchResult {
  events: ReadonlyArray<SourceProviderWatchEvent>;
  watermark: string;
}
export interface SourceProviderWatchEvent {
  ordering_domain: string;
  event_token?: string;
  provider_sequence?: string;
  event_class: string;
  normalized_uri: string;
  authority: string;
}
export interface SourceProviderReconcileRequest {
  coverage_scopes: ReadonlyArray<ObservationCoverageScope>;
  previous_watermark?: string;
}
export interface SourceProviderReconcileResult {
  observation_batch: string;
  watermark: string;
  capture_start_fingerprint: string;
  capture_end_fingerprint: string;
  stable: boolean;
}
export interface SourceProviderResourceBudget {
  max_duration_ms: number;
  max_response_bytes: number;
  max_observations: number;
  max_watch_events: number;
}
export interface SourceProviderFeatureSet {
  supports_watch: boolean;
  supports_authoritative_delete_events: boolean;
  supports_complete_enumeration: boolean;
  supports_stable_reconciliation: boolean;
  supports_virtual_artifacts: boolean;
  case_behavior: string;
  read_only: boolean;
}
export interface SourceProviderError {
  error_code: string;
  retryability: string;
  detail_code?: string;
}
export interface AnalysisRelevantArtifactMetadata {
  metadata_schema_id: string;
  metadata_schema_version: number;
  normalized_metadata: Uint8Array;
}
export interface QueryConfiguration {
  configuration_schema_id: string;
  configuration_schema_version: number;
  normalized_configuration: Uint8Array;
}
export interface GeneratorConfiguration {
  configuration_schema_id: string;
  configuration_schema_version: number;
  normalized_configuration: Uint8Array;
}
export interface SourceProviderConfiguration {
  configuration_schema_id: string;
  configuration_schema_version: number;
  normalized_configuration: Uint8Array;
}
export interface NormalizedConfigurationLayer {
  layer_kind: "installation_policy" | "user_policy" | "workspace_file" | "administrative_override";
  configuration_schema_id: string;
  configuration_schema_version: number;
  normalized_configuration: Uint8Array;
}
export interface AnalyzerImplementationManifest {
  plugin_id: string;
  plugin_version: string;
  analyzer_id: string;
  analyzer_version: string;
  executable_asset_digests: ReadonlyArray<string>;
  parser_asset_digests: ReadonlyArray<string>;
  rule_asset_digests: ReadonlyArray<string>;
  model_asset_digests: ReadonlyArray<string>;
  dependency_asset_digests: ReadonlyArray<string>;
  supported_capabilities: ReadonlyArray<string>;
}
export interface RuntimeComponentBehaviorManifest {
  component_id: string;
  component_version: string;
  component_kind: "source_provider" | "projection_generator" | "embedding_renderer" | "embedding_segmenter" | "embedding_generator";
  contract_bindings: ReadonlyArray<RuntimeComponentContractBinding>;
  configuration_schema_ids: ReadonlyArray<string>;
  algorithm_ids: ReadonlyArray<string>;
  supported_format_ids: ReadonlyArray<string>;
  deterministic_numeric_contract: string;
  portable_behavior_rules: ReadonlyArray<string>;
}
export interface RuntimeComponentImplementationManifest {
  runtime_component_build_id: string;
  component_id: string;
  component_version: string;
  behavior_digest: string;
  target_triple: string;
  executable_asset_digests: ReadonlyArray<string>;
  native_asset_digests: ReadonlyArray<string>;
  dependency_asset_digests: ReadonlyArray<string>;
}
export interface PluginPackageManifest {
  package_format_id: string;
  package_format_version: number;
  plugin_id: string;
  plugin_version: string;
  package_files: ReadonlyArray<PackageFileEntry>;
}
export interface PackageFileEntry {
  normalized_relative_path: string;
  content_digest: string;
  byte_length: number;
  executable: boolean;
}
export interface CoreRegistryManifest {
  registry_contract_version: string;
  definitions: ReadonlyArray<CoreRegistryDefinition>;
}
export interface CoreRegistryDefinition {
  registry_type: string;
  definition_id: string;
  definition_revision: number;
  schema_id: string;
  schema_version: number;
  definition_bytes: Uint8Array;
}
export interface CandidateRegistryState {
  registry_contract_version: string;
  core_registry_digest: string;
  candidate_resolution_lock_id: string;
  namespace_owners: ReadonlyArray<CandidateNamespaceOwner>;
}
export interface CandidateNamespaceOwner {
  namespace: string;
  plugin_id: string;
  plugin_version: string;
  contribution_digest: string;
}
export interface CompatibilityRequirementValue {
  requirement_schema_id: string;
  requirement_schema_version: number;
  requirement_value: Uint8Array;
}
export interface ArtifactPartitionKey {
  workspace_id: string;
  artifact_id: string;
  artifact_version_id: string;
}
export interface CallablePartitionKey {
  workspace_id: string;
  callable_entity_id: string;
  callable_record_id: string;
}
export interface FrameworkPartitionKey {
  workspace_id: string;
  framework_id: string;
  project_partition_id: string;
}
export interface ProjectPartitionKey {
  workspace_id: string;
  project_partition_id: string;
}
export interface FrozenCandidateDigestInputs {
  accepted_fact_delta_digests: ReadonlyArray<string>;
  materialization_digest: string;
}
export interface ArtifactAnalysisContext {
  registry_snapshot_id: string;
  configuration_revision_id: string;
  dependency_plugin_digests: ReadonlyArray<string>;
  analysis_configuration_digest: string;
}
export interface ProjectionSetDigestItem {
  projection_record_id: string;
  content_digest: string;
}
export interface QueryableVectorDigestEntry {
  projection_record_id: string;
  vector_digest: string;
}
export interface RecordSetDigestEntry {
  record_id: string;
  record_digest: string;
}
export interface RetentionRootReference {
  root_type: "current_snapshot" | "snapshot_pin" | "snapshot_lease" | "query_execution" | "index_status_execution" | "index_candidate" | "recovery_operation" | "recovery_checkpoint" | "active_configuration" | "model_pack_installation";
  root_id: string;
  workspace_id?: string;
}
export interface StoredObjectReference {
  object_type: string;
  object_id: string;
  content_digest?: string;
}
export interface NormalizedResponseBudget {
  max_items: number;
  max_characters: number;
}
export interface NormalizedResultProjection {
  evidence: EvidenceIncludeOptions;
  diagnostics: DiagnosticIncludeOptions;
  snippets: SourceIncludeOptions;
  registry: RegistryIncludeOptions;
}
export interface NormalizedIndexStatusProjection {
  include_capabilities: boolean;
  include_plugins: boolean;
  include_activation_issues: boolean;
  include_candidate_issues: boolean;
}
export interface NormalizedQueryPlan {
  api_version: string;
  scope: QueryScope;
  normalized_expression: QueryExpression;
  freshness: "snapshot" | "current" | "wait_for_current";
  wait_timeout_ms: number;
  coverage_requirement: "accept_reported" | "require_complete";
  projection: NormalizedResultProjection;
  response_budget: NormalizedResponseBudget;
  operation_versions: ReadonlyArray<OperationVersionBinding>;
  recipe_versions: ReadonlyArray<RecipeVersionBinding>;
}
export interface OperationVersionBinding {
  operation_id: string;
  operation_version: number;
}
export interface RecipeVersionBinding {
  recipe_id: string;
  recipe_version: number;
}
export interface RecipeStaticArguments {
  operation_id: string;
  operation_version: number;
  partial_arguments_schema_id: string;
  partial_arguments_schema_version: number;
  partial_arguments: Uint8Array;
}
export interface LocateImplementationArguments {
  query_text: string;
  query_class?: "natural_text" | "identifier" | "source_code" | "mixed";
  filter?: StructuralFilter;
}
export interface UnderstandChangeImpactArguments {
  target: SubjectSelector;
  change: ChangeDescriptor;
  include_transitive?: boolean;
  include_tests?: boolean;
  filter?: StructuralFilter;
}
export interface PrepareSymbolChangeArguments {
  reference: string;
  context_artifact?: string;
  context_byte_offset?: number;
  kind_selector?: KindSelector;
  change: ChangeDescriptor;
  filter?: StructuralFilter;
}
export interface PrepareNewFeatureArguments {
  task: string;
  query_class?: "natural_text" | "identifier" | "source_code" | "mixed";
  filter?: StructuralFilter;
}
export interface TraceBehaviorArguments {
  subjects: ReadonlyArray<SubjectSelector>;
  direction?: "inbound" | "outbound" | "both";
  relations?: RelationSelector;
  max_depth?: number;
  filter?: StructuralFilter;
}
export interface FindRelevantTestsArguments {
  subjects: ReadonlyArray<SubjectSelector>;
  relationship_scope?: "direct" | "transitive" | "both";
  include_fixtures?: boolean;
  filter?: StructuralFilter;
}
export interface ExplainArchitectureSliceArguments {
  scope?: ReadonlyArray<SubjectSelector>;
  views?: ReadonlyArray<"entry_points" | "boundaries" | "public_surfaces" | "cycles" | "extension_points" | "layers">;
  max_relation_depth?: number;
  filter?: StructuralFilter;
}
export interface CompareWorkspacesArguments {
  selection?: ReadonlyArray<SubjectSelector>;
  comparison_kinds?: ReadonlyArray<"added" | "removed" | "changed" | "moved" | "correlated">;
  correlation_policy?: "strict" | "include_possible";
  filter?: StructuralFilter;
}
export interface SemanticToCallersArguments {
  query_text: string;
  query_class?: "natural_text" | "identifier" | "source_code" | "mixed";
  max_call_depth?: number;
  filter?: StructuralFilter;
}
export interface ResolveAndFindReferencesArguments {
  reference: string;
  context_artifact?: string;
  context_byte_offset?: number;
  kind_selector?: KindSelector;
  reference_roles?: ReadonlyArray<string>;
  include_declarations?: boolean;
  filter?: StructuralFilter;
}
export interface DefinitionToInstancesArguments {
  matcher: DefinitionMatcher;
  selector?: RegistrySelector;
  record_categories?: ReadonlyArray<"entity" | "relation" | "fact" | "evidence" | "diagnostic">;
  producer_ids?: ReadonlyArray<string>;
  filter?: StructuralFilter;
}
export interface SourceArtifact {
  artifact_id: string;
  workspace_id: string;
  normalized_uri: string;
  normalized_path?: string;
  display_path?: string;
  artifact_kind: string;
}
export interface ArtifactVersion {
  artifact_version_id: string;
  workspace_id: string;
  artifact_id: string;
  content_blob_id: string;
  content_hash: string;
  byte_length: number;
  encoding: string;
  language_hint: string;
  analysis_metadata_digest: string;
  created_from_observation_id: string;
  valid_from_generation: number;
  valid_to_generation: number;
}
export interface ArtifactTombstone {
  artifact_tombstone_id: string;
  workspace_id: string;
  artifact_id: string;
  absence_kind: string;
  absence_reason_code: string;
  last_artifact_version_id: string;
  valid_from_generation: number;
  valid_to_generation: number;
  opening_artifact_change_id: string;
  closing_artifact_change_id: string;
  replacement_artifact_version_id: string;
  cause_references: string;
  lineage_evidence_record_ids: string;
}
export interface SourceObservation {
  source_observation_id: string;
  observation_batch_id: string;
  workspace_id: string;
  artifact_id: string;
  source_provider_binding_id: string;
  source_provider: string;
  source_provider_version: string;
  ordering_domain: string;
  observation_mode: string;
  observed_state: string;
  observed_content_hash: string;
  observed_metadata_digest: string;
  provider_event_token: string;
  provider_sequence: string;
  observed_at: string;
  received_at: string;
}
export interface SourceObservationDigestEntry {
  artifact_id: string;
  observed_state: string;
  observed_content_hash: string;
  observed_metadata_digest: string;
  provider_event_token?: string;
  provider_sequence?: string;
}
export interface SourceObservationBatch {
  observation_batch_id: string;
  workspace_id: string;
  source_provider_binding_id: string;
  source_provider: string;
  source_provider_version: string;
  ordering_domain: string;
  observation_mode: string;
  coverage_scopes: string;
  coverage_completeness: string;
  deletion_authority: string;
  provider_cursor_before: string;
  provider_cursor_after: string;
  started_at: string;
  completed_at: string;
  observation_count: number;
  unavailable_count: number;
  batch_digest: string;
}
export interface ObservationCoverageScope {
  scope_type: string;
  source_provider_binding_id: string;
  source_provider: string;
  normalized_scope_key: string;
}
export interface ChangeCauseReference {
  cause_type: string;
  cause_id: string;
}
export interface ContentBlob {
  content_blob_id: string;
  content_hash: string;
  byte_length: number;
  storage_reference: string;
}
export interface SourceSpan {
  artifact_version_id: string;
  start_byte: string;
  end_byte: string;
  start_line?: string;
  end_line?: string;
}
export interface RecordKindDefinition {
  kind: string;
  category: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  payload_schema: string;
  universal_kind: string;
  required_facets: ReadonlyArray<string>;
  allowed_facets: ReadonlyArray<string>;
  relation_definition?: string;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_kind?: string;
}
export interface FacetDefinition {
  facet: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  applicable_categories: ReadonlyArray<"entity" | "relation" | "fact" | "evidence" | "diagnostic">;
  applicable_universal_kinds: ReadonlyArray<string>;
  implied_facets: ReadonlyArray<string>;
  incompatible_facets: ReadonlyArray<string>;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_facet?: string;
}
export interface SemanticRoleDefinition {
  role: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  allowed_subject_universal_kinds: ReadonlyArray<string>;
  allowed_subject_facets: ReadonlyArray<string>;
  implied_roles: ReadonlyArray<string>;
  incompatible_roles: ReadonlyArray<string>;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_role?: string;
}
export interface MetricDefinition {
  metric: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  value_type: string;
  unit: string;
  allowed_subject_universal_kinds: ReadonlyArray<string>;
  supported_aggregations: ReadonlyArray<"count" | "sum" | "min" | "max" | "avg" | "distinct">;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_metric?: string;
}
export interface EffectDefinition {
  effect: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  allowed_subject_universal_kinds: ReadonlyArray<string>;
  propagation_policy: string;
  implied_effects: ReadonlyArray<string>;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_effect?: string;
}
export interface DependencyRoleDefinition {
  dependency_role: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  invalidation_semantics: string;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_dependency_role?: string;
}
export interface ProjectionKindDefinition {
  projection_kind: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  payload_schema: string;
  generator_contract_version: string;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_projection_kind?: string;
}
export interface LifecycleReasonCodeDefinition {
  reason_code: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  applicable_domains: ReadonlyArray<string>;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_reason_code?: string;
}
export interface CompletenessReasonDefinition {
  reason_code: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  allowed_statuses: ReadonlyArray<"complete" | "partial" | "unknown" | "unsupported" | "stale">;
  affected_capabilities: ReadonlyArray<string>;
  agent_guidance: string;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_reason_code?: string;
}
export interface LanguageDefinition {
  language_id: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  display_name: string;
  aliases: ReadonlyArray<string>;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_language_id?: string;
}
export interface LanguageDefinitionSupply {
  language_id: string;
  definition_revision: number;
  definition_digest: string;
  supplier_plugin_id: string;
  supplier_plugin_version: string;
}
export interface CapabilityContractDefinition {
  capability: string;
  capability_contract_version: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  allowed_precisions: ReadonlyArray<string>;
  allowed_record_categories: ReadonlyArray<"entity" | "relation" | "fact" | "evidence" | "diagnostic">;
  allowed_universal_kinds: ReadonlyArray<string>;
  allowed_evidence_bases: ReadonlyArray<string>;
  allowed_claim_classes: ReadonlyArray<string>;
  partition_key_schema?: string;
  dependency_obligations: ReadonlyArray<CapabilityDependencyObligation>;
  confirmed_claims_allowed: boolean;
  completeness_semantics: string;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_capability?: string;
}
export interface CapabilityDependencyObligation {
  dependency_basis: string;
  required: string;
  transitive_artifact_closure: string;
  fallback_scope: string;
}
export interface CapabilityCompletenessSemantics {
  complete_requires_authoritative_replacement: boolean;
  partial_allowed: boolean;
  unknown_allowed: boolean;
  unsupported_allowed: boolean;
  non_complete_reason_required: boolean;
  affected_scope_rule: string;
}
export interface ConstructClassDefinition {
  construct_code: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  applicable_capabilities: ReadonlyArray<string>;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_construct_code?: string;
}
export interface CapabilityLimitationDefinition {
  limitation_code: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  allowed_capabilities: ReadonlyArray<string>;
  allowed_statuses: ReadonlyArray<"complete" | "partial" | "unknown" | "unsupported" | "stale">;
  agent_guidance: string;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_limitation_code?: string;
}
export interface SemanticSectionKindDefinition {
  section_kind: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  allowed_origin_kinds: ReadonlyArray<string>;
  agent_guidance: string;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_section_kind?: string;
}
export interface SemanticReasonDefinition {
  reason_code: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  allowed_eligibility_statuses: ReadonlyArray<string>;
  allowed_coverage_statuses: ReadonlyArray<string>;
  completeness_reason_code?: string;
  agent_guidance: string;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_reason_code?: string;
}
export interface EmbeddingProfile {
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
  deprecated_since?: string;
  retired_since?: string;
  replacement_embedding_profile_id?: string;
  profile_digest: string;
}
export interface EmbeddingInputContract {
  renderer_id: string;
  renderer_version: string;
  template_digest: string;
  input_purpose: string;
}
export interface EmbeddingSegmentationContract {
  segmenter_id: string;
  segmenter_version: string;
  configuration_digest: string;
}
export interface EmbeddingLanguageSupport {
  mode: string;
  language_ids: string;
  supports_unclassified_text: boolean;
}
export interface ModelPackManifest {
  manifest_schema_version: string;
  model_pack_id: string;
  model_pack_version: string;
  embedding_profiles: ReadonlyArray<EmbeddingProfile>;
  assets: ReadonlyArray<ModelPackAssetEntry>;
  required_runtime_components: ReadonlyArray<ModelPackRuntimeRequirement>;
  manifest_digest: string;
}
export interface ModelPackAssetEntry {
  content_digest: string;
  decoded_byte_length: number;
  media_type: string;
  semantic_role: string;
}
export interface ModelAssetManifest {
  schema_version: number;
  model_provider_id: string;
  model_id: string;
  model_revision: string;
  architecture_id: string;
  model_format: string;
  configuration_asset_digests: ReadonlyArray<Digest>;
  weight_asset_digests: ReadonlyArray<Digest>;
  model_identity_digest: Digest;
}
export interface TokenizerAssetManifest {
  schema_version: number;
  tokenizer_id: string;
  tokenizer_revision: string;
  tokenizer_format: string;
  configuration_asset_digests: ReadonlyArray<string>;
  tokenizer_data_asset_digests: ReadonlyArray<string>;
  tokenizer_digest: string;
}
export interface ModelPackRuntimeConfiguration {
  schema_version: number;
  embedding_profile_id: string;
  runtime_role: string;
  component_id: string;
  component_version: string;
  contract_version: string;
  configuration_schema_id: string;
  configuration: Uint8Array;
  configuration_digest: string;
}
export interface ModelPackRuntimeRequirement {
  embedding_profile_id: string;
  runtime_role: string;
  component_id: string;
  component_version: string;
  behavior_digest: string;
  contract_version: string;
}
export interface ResolvedModelPackRuntimeBuild {
  embedding_profile_id: string;
  runtime_role: string;
  component_id: string;
  component_version: string;
  behavior_digest: string;
  contract_version: string;
  runtime_component_build_id: string;
  implementation_digest: string;
}
export interface ModelPackCoordinateReservation {
  schema_version: number;
  model_pack_id: string;
  model_pack_version: string;
  manifest_digest: string;
  first_registered_at: string;
}
export interface ModelPackInstallation {
  model_pack_installation_id: string;
  schema_version: number;
  model_pack_id: string;
  model_pack_version: string;
  manifest_digest: string;
  installed_at: string;
  removed_at: string;
  removal_reason_code: string;
}
export interface EmbeddingProfileExecutableBinding {
  schema_version: number;
  embedding_profile_id: string;
  embedding_profile_digest: string;
  runtime_requirements: string;
  runtime_configurations: string;
  operational_asset_digests: string;
  portable_binding_digest: string;
  resolved_runtime_builds: string;
  executable_binding_digest: string;
}
export interface ModelPackProfileSupply {
  model_pack_profile_supply_id: string;
  schema_version: number;
  model_pack_installation_id: string;
  embedding_profile_id: string;
  portable_binding_digest: string;
  supplied_at: string;
  released_at: string;
  release_reason_code: string;
}
export interface EvidenceAssumptionDefinition {
  assumption_code: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  satisfaction_contract: string;
  agent_guidance: string;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_assumption_code?: string;
}
export interface EvidenceExplanationDefinition {
  explanation_code: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  allowed_bases: ReadonlyArray<string>;
  allowed_derivations: ReadonlyArray<string>;
  agent_guidance: string;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_explanation_code?: string;
}
export interface PluginRegistryContribution {
  plugin_id: string;
  plugin_version: string;
  namespace: string;
  registry_contract_version: string;
  dependencies: ReadonlyArray<PluginDependencyRequirement>;
  canonical_schema_definitions: ReadonlyArray<CanonicalSchemaDefinition>;
  digest_domain_definitions: ReadonlyArray<DigestDomainDefinition>;
  canonical_comparator_definitions: ReadonlyArray<CanonicalComparatorDefinition>;
  external_verification_contract_definitions: ReadonlyArray<ExternalVerificationContractDefinition>;
  runtime_component_definitions: ReadonlyArray<RuntimeComponentDefinition>;
  digest_recipe_definitions: ReadonlyArray<DigestRecipeDefinition>;
  digest_reference_definitions: ReadonlyArray<DigestReferenceDefinition>;
  language_definitions: ReadonlyArray<LanguageDefinition>;
  capability_contract_definitions: ReadonlyArray<CapabilityContractDefinition>;
  structural_stage_definitions?: ReadonlyArray<JsonValue>;
  construct_class_definitions: ReadonlyArray<ConstructClassDefinition>;
  capability_limitation_definitions: ReadonlyArray<CapabilityLimitationDefinition>;
  record_kind_definitions: ReadonlyArray<RecordKindDefinition>;
  facet_definitions: ReadonlyArray<FacetDefinition>;
  semantic_role_definitions: ReadonlyArray<SemanticRoleDefinition>;
  metric_definitions: ReadonlyArray<MetricDefinition>;
  effect_definitions: ReadonlyArray<EffectDefinition>;
  diagnostic_code_definitions: ReadonlyArray<DiagnosticCodeDefinition>;
  candidate_issue_code_definitions: ReadonlyArray<CandidateIssueCodeDefinition>;
  dependency_role_definitions: ReadonlyArray<DependencyRoleDefinition>;
  projection_kind_definitions: ReadonlyArray<ProjectionKindDefinition>;
  lifecycle_reason_code_definitions: ReadonlyArray<LifecycleReasonCodeDefinition>;
  completeness_reason_definitions: ReadonlyArray<CompletenessReasonDefinition>;
  semantic_section_kind_definitions: ReadonlyArray<SemanticSectionKindDefinition>;
  semantic_reason_definitions: ReadonlyArray<SemanticReasonDefinition>;
  evidence_assumption_definitions: ReadonlyArray<EvidenceAssumptionDefinition>;
  evidence_explanation_definitions: ReadonlyArray<EvidenceExplanationDefinition>;
  contribution_digest: string;
}
export interface PluginDependencyRequirement {
  plugin_id: string;
  namespace: string;
  version_requirement: string;
  required_capabilities: ReadonlyArray<string>;
}
export interface NamespaceBinding {
  namespace_binding_id: string;
  workspace_id: string;
  namespace: string;
  plugin_id: string;
  plugin_version: string;
  contribution_digest: string;
  emission_valid_from_generation: string;
  emission_valid_to_generation?: string;
}
export interface RegistryNamespaceBindingEntry {
  namespace_binding_id: string;
  workspace_id: string;
  namespace: string;
  plugin_id: string;
  plugin_version: string;
  contribution_digest: string;
  emission_valid_from_generation: string;
  emission_valid_to_generation?: string;
}
export interface RegistrySnapshot {
  registry_snapshot_id: string;
  registry_contract_version: string;
  core_registry_digest: string;
  resolution_lock_id: string;
  namespace_bindings: ReadonlyArray<RegistryNamespaceBindingEntry>;
  registry_digest: string;
}
export interface VersionRequirement {
  alternatives: ReadonlyArray<VersionInterval>;
  allow_prerelease: boolean;
}
export interface VersionInterval {
  minimum?: number;
  minimum_inclusive?: string;
  maximum?: number;
  maximum_inclusive?: string;
}
export interface CapabilityRequirement {
  capability: string;
  version_requirement: string;
}
export interface PluginCompatibilityDeclaration {
  declaration_schema_version: string;
  plugin_id: string;
  plugin_version: string;
  namespace: string;
  supported_plugin_contract_versions: ReadonlyArray<number>;
  supported_registry_contract_versions: ReadonlyArray<number>;
  dependencies: ReadonlyArray<PluginDependencyRequirement>;
  offered_capabilities: ReadonlyArray<CapabilityRequirement>;
  recommended_embedding_profile_ids: ReadonlyArray<string>;
  package_digest: string;
  analysis_digest: string;
  declaration_digest: string;
}
export interface PluginResolutionLock {
  resolution_lock_id: string;
  workspace_id: string;
  resolver_version: string;
  resolved_plugins: ReadonlyArray<ResolvedPlugin>;
  lock_digest: string;
  created_at: string;
}
export interface ResolvedPlugin {
  plugin_id: string;
  plugin_version: string;
  namespace: string;
  package_digest: string;
  declaration_digest: string;
  contribution_digest: string;
  analysis_digest: string;
  analysis_configuration_digest: string;
  plugin_contract_version: string;
  registry_contract_version: string;
  resolved_dependency_plugin_ids: ReadonlyArray<string>;
  effective_capabilities: ReadonlyArray<string>;
}
export interface RegistryCompatibilityAssessment {
  assessment_id: string;
  workspace_id: string;
  base_registry_snapshot_id: string;
  base_resolution_lock_id: string;
  candidate_resolution_lock_id: string;
  candidate_registry_digest: string;
  overall_classification: string;
  definition_changes: ReadonlyArray<DefinitionChangeAssessment>;
  plugin_analysis_changes: ReadonlyArray<PluginAnalysisChange>;
  required_actions: ReadonlyArray<string>;
  assessment_digest: string;
  created_at: string;
}
export interface DefinitionChangeAssessment {
  registry_type: string;
  identifier: string;
  change_type: string;
  from_definition_revision?: string;
  to_definition_revision?: string;
  from_schema_version?: string;
  to_schema_version?: string;
  classification: string;
  reason_codes: ReadonlyArray<string>;
  required_actions: ReadonlyArray<string>;
  affected_projection_kinds: ReadonlyArray<string>;
  explanation: string;
}
export interface PluginAnalysisChange {
  plugin_id: string;
  change_type: string;
  from_plugin_version?: string;
  to_plugin_version?: string;
  from_analysis_digest: string;
  to_analysis_digest: string;
  reanalysis_scope: string;
  reason_codes: ReadonlyArray<string>;
}
export interface IndexCandidate {
  candidate_generation_id: string;
  workspace_id: string;
  base_snapshot_id?: string;
  base_generation?: number;
  base_registry_snapshot_id?: string;
  target_registry_snapshot_id: string;
  base_configuration_revision_id?: string;
  target_configuration_revision_id: string;
  trigger_kind: string;
  state: string;
  work_manifest_id?: string;
  source_observation_batch_ids: ReadonlyArray<string>;
  retention_lease_id?: string;
  candidate_materialization_id?: string;
  candidate_digest?: string;
  created_at: string;
  analysis_started_at?: string;
  ready_at?: string;
  finished_at?: string;
  published_snapshot_id?: string;
  published_generation?: number;
  generation_manifest_id?: string;
  stale_against_snapshot_id?: string;
  failure_code?: string;
  issue_ids: ReadonlyArray<string>;
}
export interface CandidateMaterialization {
  candidate_materialization_id: string;
  workspace_id: string;
  candidate_generation_id?: string;
  accepted_fact_delta_digests: ReadonlyArray<string>;
  source_transition_template_set: string;
  record_open_template_set: string;
  record_closure_template_set: string;
  identity_assignment_template_set: string;
  projection_open_template_sets: ReadonlyArray<CandidateProjectionOpenTemplate>;
  projection_closure_template_sets: ReadonlyArray<CandidateProjectionClosureTemplate>;
  capability_state_entries: ReadonlyArray<SnapshotCapabilityStateEntry>;
  source_observation_watermarks: ReadonlyArray<ProviderWatermark>;
  artifact_dependency_template_set?: string;
  lookup_dependency_template_set?: string;
  lookup_revalidation_template_set?: string;
  materialization_digest: string;
}
export type CandidateArtifactVersionTemplate = Omit<ArtifactVersion, "language_hint" | "valid_from_generation" | "valid_to_generation"> & { readonly language_hint?: string };
export type CandidateArtifactTombstoneTemplate = Omit<ArtifactTombstone, "valid_from_generation" | "valid_to_generation" | "closing_artifact_change_id" | "replacement_artifact_version_id">;
export interface CandidateSourceTransitionTemplate {
  artifact_change: ArtifactChange;
  target_artifact_version_without_generation?: CandidateArtifactVersionTemplate;
  target_artifact_tombstone_without_generation?: CandidateArtifactTombstoneTemplate;
}
export interface CandidateRecordOpenTemplate {
  record_without_validity: string;
  open_reason_code: string;
  previous_record_id?: string;
  owner_artifact_id: string;
  owner_artifact_version_id: string;
  cause_references: ReadonlyArray<ChangeCauseReference>;
}
export interface CandidateRecordClosureTemplate {
  record_id: string;
  workspace_id: string;
  owner_artifact_id: string;
  owner_artifact_version_id: string;
  category: string;
  kind: string;
  universal_kind: string;
  closure_reason_code: string;
  replacement_record_id?: string;
  cause_references: ReadonlyArray<ChangeCauseReference>;
}
export interface CandidateIdentityAssignmentTemplate {
  identity_assignment_id: string;
  workspace_id: string;
  identity_type: string;
  identity_id: string;
  assignment_kind: string;
  identity_key: string;
  identity_key_digest: string;
  record_id: string;
  previous_record_id?: string;
  owner_artifact_id: string;
  owner_artifact_version_id: string;
}
export interface CandidateProjectionOpenTemplate {
  projection: string;
}
export interface CandidateProjectionTemplate {
  projection_record_id: string;
  projection_kind: string;
  projection_key: string;
  workspace_id: string;
  owner_artifact_id: string;
  owner_artifact_version_id: string;
  source_artifact_version_ids: ReadonlyArray<string>;
  source_record_ids: ReadonlyArray<string>;
  source_projection_record_ids: ReadonlyArray<string>;
  generator: string;
  generator_version: string;
  generator_configuration_digest: string;
  payload: JsonValue;
}
export interface CandidateProjectionClosureTemplate {
  projection_record_id: string;
  projection_kind: string;
  projection_key: string;
  workspace_id: string;
  owner_artifact_id: string;
  owner_artifact_version_id: string;
  generator: string;
  generator_version: string;
  generator_configuration_digest: string;
  change_reason_code: string;
  replacement_projection_record_id?: string;
  cause_references: ReadonlyArray<ChangeCauseReference>;
}
export interface CandidateWorkManifest {
  work_manifest_id: string;
  supersedes_work_manifest_id?: string;
  workspace_id: string;
  candidate_generation_id: string;
  base_snapshot_id?: string;
  artifact_work_set: OrderedSetDescriptor;
  projection_work_set: OrderedSetDescriptor;
  invalidation_plan_id: string;
  target_registry_snapshot_id: string;
  target_configuration_revision_id: string;
  created_at: string;
  work_digest: string;
}
export interface ArtifactWorkItem {
  work_item_id: string;
  workspace_id: string;
  artifact_id: string;
  base_artifact_version_id?: string;
  base_tombstone_id?: string;
  target_artifact_version_id?: string;
  target_tombstone_id?: string;
  operation: string;
  plugin_id: string;
  plugin_version: string;
  capabilities: ReadonlyArray<string>;
  expected_replacement_scopes: ReadonlyArray<ReplacementScope>;
  reason_codes: ReadonlyArray<string>;
  cause_references: ReadonlyArray<ChangeCauseReference>;
  analysis_context_digest: string;
  work_item_digest: string;
}
export interface ProjectionWorkItem {
  projection_work_item_id: string;
  workspace_id: string;
  owner_artifact_id: string;
  owner_artifact_version_id?: string;
  target_tombstone_id?: string;
  projection_kind: string;
  operation: string;
  generator: string;
  generator_version: string;
  generator_configuration_digest: string;
  source_selection: JsonValue;
  base_projection_set_digest: string;
  reason_codes: ReadonlyArray<string>;
  cause_references: ReadonlyArray<ChangeCauseReference>;
  work_item_digest: string;
}
export interface InvalidationPlan {
  invalidation_plan_id: string;
  workspace_id: string;
  candidate_generation_id: string;
  base_snapshot_id?: string;
  seed_change_set: OrderedSetDescriptor;
  affected_artifact_set: OrderedSetDescriptor;
  affected_record_set: OrderedSetDescriptor;
  affected_projection_set: OrderedSetDescriptor;
  dependency_index_digest: string;
  maximum_scope: string;
  fallback_scopes: ReadonlyArray<string>;
  completeness: CompletenessReport;
  created_at: string;
  plan_digest: string;
}
export interface CandidateIssue {
  candidate_issue_id: string;
  candidate_generation_id: string;
  issue_code: string;
  phase: string;
  severity: string;
  scope: CandidateIssueScope;
  retryability: string;
  summary: string;
  detail: string;
  cause_references: string;
  payload: CandidateIssuePayload;
  created_at: string;
}
export interface CandidateIssueCodeDefinition {
  issue_code: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  allowed_phases: string;
  default_severity: string;
  allowed_severities: string;
  default_retryability: string;
  allowed_retryabilities: string;
  payload_schema: ClosedPayloadSchema;
  plugin_owner: string;
  lifecycle_state: string;
  deprecated_since: string;
  retired_since: string;
  replacement_issue_code: string;
}
export type CandidateIssueScope = WorkspaceCandidateIssueScope | ArtifactCandidateIssueScope | WorkItemCandidateIssueScope | FactDeltaCandidateIssueScope | ReplacementScopeCandidateIssueScope | ProposalCandidateIssueScope | ProjectionCandidateIssueScope;
export interface WorkspaceCandidateIssueScope {
  scope_type: string;
  workspace_id: string;
}
export interface ArtifactCandidateIssueScope {
  scope_type: string;
  artifact_id: string;
  artifact_version_id?: string;
}
export interface WorkItemCandidateIssueScope {
  scope_type: string;
  work_item_type: string;
  work_item_id: string;
}
export interface FactDeltaCandidateIssueScope {
  scope_type: string;
  fact_delta_id: string;
}
export interface ReplacementScopeCandidateIssueScope {
  scope_type: string;
  fact_delta_id: string;
  replacement_scope_id: string;
}
export interface ProposalCandidateIssueScope {
  scope_type: string;
  fact_delta_id: string;
  proposal_record_key: string;
}
export interface ProjectionCandidateIssueScope {
  scope_type: string;
  projection_work_item_id: string;
  projection_record_id?: string;
}
export interface InvalidationPathStep {
  ordinal: number;
  step_type: string;
  from_reference: string;
  to_reference: string;
  dependency_role?: string;
  reason_code: string;
}
export interface InvalidationNodeReference {
  reference_type: string;
  reference_id: string;
}
export interface AffectedArtifactEntry {
  artifact_id: string;
  artifact_version_id?: string;
  required_operation: string;
  cause_references: ReadonlyArray<ChangeCauseReference>;
  invalidation_path: ReadonlyArray<InvalidationPathStep>;
}
export interface AffectedRecordEntry {
  record_id: string;
  owner_artifact_id: string;
  owner_artifact_version_id: string;
  required_operation: string;
  cause_references: ReadonlyArray<ChangeCauseReference>;
  invalidation_path: ReadonlyArray<InvalidationPathStep>;
}
export interface AffectedProjectionEntry {
  projection_record_id: string;
  projection_kind: string;
  owner_artifact_id: string;
  owner_artifact_version_id: string;
  required_operation: string;
  cause_references: ReadonlyArray<ChangeCauseReference>;
  invalidation_path: ReadonlyArray<InvalidationPathStep>;
}
export interface PluginUpgradePlan {
  upgrade_plan_id: string;
  workspace_id: string;
  base_snapshot_id: string;
  base_registry_snapshot_id: string;
  base_resolution_lock_id: string;
  candidate_resolution_lock_id: string;
  compatibility_assessment_id: string;
  work_manifest_id: string;
  publication_policy: string;
  plan_digest: string;
  created_at: string;
}
export interface PluginActivationAttempt {
  activation_attempt_id: string;
  workspace_id: string;
  base_snapshot_id: string;
  base_resolution_lock_id: string;
  upgrade_plan_id?: string;
  candidate_generation_id?: string;
  candidate_materialization_id?: string;
  state: string;
  phase: string;
  completed_work_items: string;
  total_work_items: string;
  candidate_registry_snapshot_id?: string;
  published_snapshot_id?: string;
  compatibility_issue_ids: ReadonlyArray<string>;
  candidate_issue_ids: ReadonlyArray<string>;
  started_at: string;
  finished_at?: string;
}
export interface PluginCompatibilityIssue {
  issue_id: string;
  code: string;
  severity: string;
  phase: string;
  plugin_ids: ReadonlyArray<string>;
  definition_references: ReadonlyArray<RegistryDefinitionReference>;
  requirement_references: ReadonlyArray<CompatibilityRequirementReference>;
  summary: string;
  detail?: string;
  payload: JsonValue;
  required_action: string;
  retryable: string;
  created_at: string;
}
export interface PluginCompatibilityIssueCodeDefinition {
  code: string;
  definition_revision: number;
  schema_version: number;
  title: string;
  description: string;
  non_meaning: string;
  emission_condition: string;
  allowed_phases: ReadonlyArray<string>;
  default_severity: string;
  allowed_severities: ReadonlyArray<"info" | "warning" | "error">;
  payload_schema: string;
  allowed_required_actions: ReadonlyArray<string>;
  default_retryable: string;
  retryable_condition?: string;
  agent_guidance: string;
  examples: ReadonlyArray<string>;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_code?: string;
}
export interface RegistryDefinitionReference {
  registry_type: string;
  identifier: string;
  definition_revision: number;
}
export interface CompatibilityRequirementReference {
  requirement_type: string;
  declaring_plugin_id?: string;
  target_plugin_id?: string;
  capability?: string;
  requirement_digest: string;
}
export interface KindDescriptor {
  kind: string;
  universal_kind: string;
  facets: ReadonlyArray<string>;
}
export interface KindSelector {
  kinds?: ReadonlyArray<string>;
  universal_kinds?: ReadonlyArray<string>;
  all_facets?: ReadonlyArray<string>;
  any_facets?: ReadonlyArray<string>;
  excluded_facets?: ReadonlyArray<string>;
}
export interface KindDefinitionView {
  kind: string;
  category: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  universal_kind: string;
  required_facets: ReadonlyArray<string>;
  allowed_facets: ReadonlyArray<string>;
  relation_definition?: string;
  payload_schema?: string;
  plugin_owner?: string;
  lifecycle_state: string;
  deprecated_since?: string;
  retired_since?: string;
  replacement_kind?: string;
}
export interface RegistryIncludeOptions {
  registry: "none" | "used" | "full";
  include_payload_schemas: boolean;
}
export interface RegistryBundle {
  registry_usage_set_id?: string;
  language_definitions: ReadonlyArray<LanguageDefinition>;
  capability_contract_definitions: ReadonlyArray<CapabilityContractDefinition>;
  construct_class_definitions: ReadonlyArray<ConstructClassDefinition>;
  capability_limitation_definitions: ReadonlyArray<CapabilityLimitationDefinition>;
  kind_definitions: ReadonlyArray<KindDefinitionView>;
  facet_definitions: ReadonlyArray<FacetDefinition>;
  semantic_role_definitions: ReadonlyArray<SemanticRoleDefinition>;
  metric_definitions: ReadonlyArray<MetricDefinition>;
  effect_definitions: ReadonlyArray<EffectDefinition>;
  diagnostic_code_definitions: ReadonlyArray<DiagnosticCodeDefinition>;
  candidate_issue_code_definitions: ReadonlyArray<CandidateIssueCodeDefinition>;
  dependency_role_definitions: ReadonlyArray<DependencyRoleDefinition>;
  projection_kind_definitions: ReadonlyArray<ProjectionKindDefinition>;
  lifecycle_reason_code_definitions: ReadonlyArray<LifecycleReasonCodeDefinition>;
  completeness_reason_definitions: ReadonlyArray<CompletenessReasonDefinition>;
  semantic_section_kind_definitions: ReadonlyArray<SemanticSectionKindDefinition>;
  semantic_reason_definitions: ReadonlyArray<SemanticReasonDefinition>;
  evidence_assumption_definitions: ReadonlyArray<EvidenceAssumptionDefinition>;
  evidence_explanation_definitions: ReadonlyArray<EvidenceExplanationDefinition>;
  has_more: boolean;
  cursor?: string;
}
export interface RelationArgument {
  argument_id: string;
  role: string;
  position?: number;
  target: RelationTarget;
  resolution_state: string;
  confidence_level?: string;
  evidence_record_ids: ReadonlyArray<string>;
}
export interface RelationKindDefinition {
  kind: string;
  roles: ReadonlyArray<RelationRoleDefinition>;
  identity_roles: ReadonlyArray<string>;
  anchor_role?: string;
}
export interface RelationRoleDefinition {
  name: string;
  allowed_target_types: ReadonlyArray<string>;
  allowed_universal_kinds: ReadonlyArray<string>;
  required_target_facets: ReadonlyArray<string>;
  min_count: number;
  max_count?: number;
  ordered: string;
  identity_part: string;
}
export interface RelationIdentityInput {
  relation_kind: string;
  anchor_reference: string;
  local_relation_key: string;
  additional_identity_components: ReadonlyArray<string>;
}
export type RelationTarget = EntityTarget | RecordTarget | ArtifactTarget;
export interface EntityTarget {
  target_type: string;
  entity_id: string;
  entity_record_id?: string;
}
export interface RecordTarget {
  target_type: string;
  record_id: string;
}
export interface ArtifactTarget {
  target_type: string;
  artifact_id: string;
  artifact_version_id?: string;
}
export interface LiteralTarget {
  target_type: string;
  value_type: string;
  value: JsonValue;
}
export interface UnresolvedTarget {
  target_type: string;
  symbol: string;
  namespace?: string;
  candidate_entity_ids: ReadonlyArray<string>;
}
export type EvidenceSubject = RecordSubject | RelationArgumentSubject;
export interface RecordSubject { subject_type: "record"; record_id: string; }
export interface RelationArgumentSubject { subject_type: "relation_argument"; relation_record_id: string; argument_id: string; }
export interface SourceReference { artifact_id: string; artifact_version_id: string; span?: SourceSpan; }
export type DiagnosticScope = RecordDiagnosticScope | ArtifactDiagnosticScope | CapabilityDiagnosticScope;
export interface RecordDiagnosticScope { scope_type: "record"; record_id: string; }
export interface ArtifactDiagnosticScope { scope_type: "artifact"; artifact_id: string; artifact_version_id?: string; }
export interface CapabilityDiagnosticScope { scope_type: "capability"; capability: string; }
export interface DiagnosticRecovery { state: "automatic" | "action_required" | "unrecoverable"; actions: ReadonlyArray<string>; }
export interface DiagnosticCodeDefinition { code: string; definition_revision: number; schema_version: number; diagnostic_category: string; title: string; description: string; emission_condition: string; default_severity: "info" | "warning" | "error"; allowed_severities: ReadonlyArray<"info" | "warning" | "error">; allowed_scope_types: ReadonlyArray<"record" | "artifact" | "capability">; payload_schema: ClosedPayloadSchema; lifecycle_state: "active" | "deprecated" | "retired"; }
export interface DerivedProjectionEnvelope {
  projection_record_id: string;
  projection_kind: string;
  projection_key: string;
  workspace_id: string;
  owner_artifact_id: string;
  owner_artifact_version_id: string;
  source_artifact_version_ids: string;
  source_record_ids: string;
  source_projection_record_ids: string;
  generator: string;
  generator_version: string;
  generator_configuration_digest: string;
  created_from_snapshot_id: string;
  valid_from_generation: number;
  valid_to_generation: number;
  payload: JsonValue;
  content_digest: string;
}
export interface ProjectionChange {
  projection_change_id: string;
  change_action: string;
  projection_record_id: string;
  projection_kind: string;
  projection_key: string;
  workspace_id: string;
  owner_artifact_id: string;
  owner_artifact_version_id: string;
  source_artifact_version_ids: string;
  source_record_ids: string;
  source_projection_record_ids: string;
  generator: string;
  generator_version: string;
  generator_configuration_digest: string;
  generation: number;
  change_reason_code: string;
  previous_projection_record_id: string;
  replacement_projection_record_id: string;
  cause_references: string;
}
export interface DerivedSemanticEligibility { artifact_id: string; artifact_version_id: string; content_class: string; language_ids: ReadonlyArray<string>; eligibility_status: string; reason_codes: ReadonlyArray<string>; matched_policy_rule_ids: ReadonlyArray<string>; diagnostic_record_ids: ReadonlyArray<string>; }
export interface DerivedSemanticDocument {
  semantic_content_digest: string;
}
export interface SemanticDocumentSubject { artifact_id: string; artifact_version_id: string; document_id: string; }
export interface ArtifactSemanticDocumentSubject {
  subject_type: string;
  artifact_id: string;
  artifact_version_id: string;
}
export interface EntitySemanticDocumentSubject {
  subject_type: string;
  entity_id: string;
  entity_record_id: string;
}
export interface SemanticDocumentSection {
  section_digest: string;
}
export interface DerivedEmbeddingSegment {
  embedding_input_digest: string;
  implementation_digest: string;
  generator_configuration_digest: string;
}
export interface EmbeddingSegmentPart { segment_id: string; part_ordinal: number; text_span: SourceSpan; }
export interface DerivedEmbeddingVector {
  vector_digest: string;
  implementation_digest: string;
  generator_configuration_digest: string;
  embedding_input_digest: string;
}
export interface SemanticArtifactCoverage {
  artifact_projection_set_digest: string;
  coverage_digest: string;
}
export interface SemanticCoverageManifest {
  content_digest: string;
}
export interface SemanticIndexMaterialization {
  queryable_vector_set_digest: string;
  materialization_digest: string;
  generator_configuration_digest: string;
  executable_binding_digest: string;
  embedding_profile_digest: string;
  coverage_manifest_digest: string;
}
export interface RecordArtifactDependency {
  dependency_entry_id: string;
  workspace_id: string;
  record_id: string;
  owner_artifact_id: string;
  owner_artifact_version_id: string;
  dependency_artifact_id: string;
  dependency_artifact_version_id: string;
  dependency_role: string;
  producer_id: string;
  producer_version: string;
  valid_from_generation: number;
  valid_to_generation?: number;
}
export interface RecordArtifactDependencyDigestEntry {
  workspace_id: string;
  record_id: string;
  owner_artifact_id: string;
  owner_artifact_version_id: string;
  dependency_artifact_id: string;
  dependency_artifact_version_id: string;
  dependency_role: string;
  producer_id: string;
  producer_version: string;
  valid_from_generation: number;
}
export interface GenerationChangeManifest {
  generation_manifest_id: string;
  workspace_id: string;
  candidate_generation_id: string;
  generation: number;
  snapshot_id: string;
  base_snapshot_id: string;
  registry_snapshot_id: string;
  publication_kind: string;
  published_at: string;
  artifact_change_set: string;
  record_open_set: string;
  record_closure_set: string;
  identity_assignment_set: string;
  projection_change_sets: string;
  manifest_digest: string;
}
export interface ChangeSetDescriptor {
  change_set_id: string;
  change_set_kind: string;
  entry_schema_version: string;
  comparator_id: string;
  comparator_version: string;
  entry_count: number;
  content_digest: string;
}
export interface ProjectionChangeSetDescriptor {
  projection_kind: string;
  generator: string;
  generator_version: string;
}
export interface RecordOpen {
  record_id: string;
  workspace_id: string;
  owner_artifact_id: string;
  owner_artifact_version_id: string;
  category: string;
  kind: string;
  universal_kind: string;
  valid_from_generation: number;
  open_reason_code: string;
  previous_record_id: string;
  cause_references: string;
}
export interface RecordClosure {
  record_id: string;
  workspace_id: string;
  owner_artifact_id: string;
  owner_artifact_version_id: string;
  category: string;
  kind: string;
  universal_kind: string;
  valid_to_generation: number;
  closure_reason_code: string;
  replacement_record_id: string;
  cause_references: string;
}
export interface IdentityAssignment {
  identity_assignment_id: string;
  workspace_id: string;
  identity_type: string;
  identity_id: string;
  assignment_kind: string;
  identity_key: string;
  identity_key_digest: string;
  record_id: string;
  previous_record_id: string;
  owner_artifact_id: string;
  owner_artifact_version_id: string;
  assigned_at_generation: string;
}
export interface FactDelta {
  fact_delta_id: string;
  candidate_generation_id: string;
  workspace_id: string;
  base_snapshot_id?: string;
  work_item_id: string;
  plugin_id: string;
  plugin_version: string;
  analysis_digest: string;
  analysis_configuration_digest: string;
  publication_stage_id?: string;
  owner_artifact_id: string;
  owner_artifact_version_id: string;
  replacement_scopes: ReadonlyArray<ReplacementScope>;
  input_artifact_version_ids: ReadonlyArray<string>;
  input_record_ids: ReadonlyArray<string>;
  plugin_input_access_manifest_id: string;
  plugin_input_access_manifest_digest: string;
  analysis_input_digest: string;
  proposed_records: ReadonlyArray<ProposedRecord>;
  proposed_dependencies: ReadonlyArray<ProposedRecordDependency>;
  completeness_claims: ReadonlyArray<CompletenessClaim>;
  created_at: string;
  delta_digest: string;
}
export interface ReplacementScope {
  replacement_scope_id: string;
  owner_artifact_id: string;
  owner_artifact_version_id: string;
  capability: string;
  record_categories: ReadonlyArray<string>;
  record_kinds: ReadonlyArray<string>;
  partition_key?: JsonValue;
  base_record_set_digest: string;
  output_completeness: string;
}
export interface ProposedRecord {
  proposal_record_key: string;
  category: string;
  kind: string;
  universal_kind: string;
  facets: string;
  schema_version: number;
  source_span: string;
  identity_key: string;
  body: JsonValue;
  evidence_references: string;
}
export interface ProposedReference { reference_kind: string; target_id?: string; resolution_status: string; }
export interface LocalProposalReference {
  reference_type: string;
  proposal_record_key: string;
}
export interface CandidateIdentityReference {
  reference_type: string;
  identity_type: string;
  identity_key: string;
  expected_kinds: string;
  required_facets: string;
}
export interface BaseRecordReference {
  reference_type: string;
  record_id: string;
}
export interface UnresolvedReference {
  reference_type: string;
  symbolic_key: string;
  candidate_identity_keys: string;
  resolution_reason_code: string;
}
export interface ProposedRecordDependency {
  proposed_dependency_id: string;
  proposal_record_key: string;
  dependency_artifact_id: string;
  dependency_artifact_version_id: string;
  dependency_role: string;
  dependency_basis: string;
  source_reference: JsonValue;
}
export interface CompletenessClaim {
  completeness_claim_id: string;
  capability: string;
  replacement_scope_ids: string;
  status: string;
  reason_codes: string;
  affected_artifact_ids: string;
  diagnostic_proposal_keys: string;
}
export interface PluginCapabilityDeclaration { plugin_id: string; plugin_version: string; language_id?: string; capability: string; capability_contract_version: string; precision: string; coverage: CapabilityCoverage; limitations: ReadonlyArray<CapabilityLimitation>; publication_stage_id?: string; }
export interface CapabilityCoverage { language_ids: ReadonlyArray<string>; artifact_kinds: ReadonlyArray<string>; project_context_required: boolean; excluded_construct_codes: ReadonlyArray<string>; }
export interface CapabilityLimitation { limitation_code: string; applicable_language_ids: ReadonlyArray<string>; applicable_artifact_kinds: ReadonlyArray<string>; applicable_construct_codes: ReadonlyArray<string>; resulting_status: string; description: string; }
export interface PluginWorkerRequestEnvelope {
  protocol_version: string;
  request_id: string;
  request_digest: string;
  call: string;
  deadline: string;
  cancellation_id: string;
  payload: JsonValue;
}
export interface PluginWorkerResponseEnvelope {
  protocol_version: string;
  request_id: string;
  request_digest: string;
  call: string;
  outcome: string;
  payload: JsonValue;
}
export interface PluginDescribeRequest {
  plugin_id: string;
  plugin_version: string;
  package_digest: string;
}
export interface PluginDescribeResult {
  compatibility_declaration_digest: string;
  registry_contribution_digest: string;
  supported_calls: ReadonlyArray<string>;
}
export interface DiscoverPartitionsRequest {
  candidate_generation_id: string;
  context: string;
  resource_budget: string;
}
export interface DiscoverPartitionsResult {
  partitions: ReadonlyArray<AnalysisPartition>;
  plugin_input_access_manifest_id: string;
  plugin_input_access_manifest_digest: string;
  analysis_input_digest: string;
}
export interface AnalysisPartition {
  partition_key: ArtifactPartitionKey | CallablePartitionKey | FrameworkPartitionKey | ProjectPartitionKey;
  language_ids: ReadonlyArray<string>;
  member_artifact_ids: ReadonlyArray<string>;
  configuration_artifact_ids: ReadonlyArray<string>;
  resolution_roots: ReadonlyArray<string>;
  capabilities: ReadonlyArray<string>;
}
export interface AnalyzeArtifactRequest {
  candidate_generation_id: string;
  work_item: string;
  context: string;
  resource_budget: string;
}
export interface AnalyzeArtifactSuccess {
  fact_delta: string;
  plugin_input_access_manifest_id: string;
  plugin_input_access_manifest_digest: string;
  analysis_input_digest: string;
}
export interface GenerateProjectionRequest {
  candidate_generation_id: string;
  projection_work_item: string;
  context: string;
  resource_budget: string;
}
export interface GenerateProjectionSuccess {
  projection_replacement_set: string;
  plugin_input_access_manifest_id: string;
  plugin_input_access_manifest_digest: string;
  analysis_input_digest: string;
}
export interface PluginAnalysisContext {
  analysis_view: string;
  resource_budget: string;
}
export interface PluginAnalysisView {
  analysis_view_digest: string;
  workspace_id: string;
  candidate_generation_id: string;
  base_snapshot_id?: string;
  source_overlay_digest: string;
  prerequisite_stage_set_digest: string;
  target_registry_snapshot_id: string;
  resolution_lock_id: string;
  configuration_revision_id: string;
}
export interface PluginArtifactView {
  artifact_id: string;
  artifact_version_id: string;
  normalized_uri: string;
  artifact_kind: string;
  content_hash: string;
  byte_length: number;
  encoding: string;
  language_ids: ReadonlyArray<string>;
  content_access: string;
}
export interface PluginRecordView { record_id: string; category: string; kind: string; payload: JsonValue; }
export interface BasePluginRecordView {
  view_type: string;
  record_id: string;
  record_digest: string;
  category: string;
  kind: string;
  universal_kind: string;
  facets: ReadonlyArray<string>;
  owner_artifact_id: string;
  owner_artifact_version_id: string;
  source_span?: string;
  body: JsonValue;
}
export interface StagedPluginRecordView {
  view_type: string;
  staged_record_id: string;
  producing_work_item_id: string;
  proposal_record_key: string;
  validated_record_digest: string;
  category: string;
  kind: string;
  universal_kind: string;
  facets: ReadonlyArray<string>;
  owner_artifact_id: string;
  owner_artifact_version_id: string;
  source_span?: string;
  body: JsonValue;
}
export interface PluginInputLookupEntry {
  operation: string;
  normalized_selector_or_address: string;
  analysis_view_digest: string;
  result_set_digest: string;
  result_count: number;
  completeness: CompletenessReport;
}
export interface PluginInputRecordEntry { record_id: string; record: PluginRecordView; access_mode: string; }
export interface BasePluginInputRecordEntry {
  input_type: string;
  record_id: string;
  record_digest: string;
}
export interface StagedPluginInputRecordEntry {
  input_type: string;
  staged_record_id: string;
  producing_work_item_id: string;
  proposal_record_key: string;
  validated_record_digest: string;
}
export interface PluginInputAccessManifest {
  plugin_input_access_manifest_id: string;
  request_id: string;
  analysis_view_digest: string;
  artifact_version_entries: ReadonlyArray<JsonValue>;
  record_entries: ReadonlyArray<JsonValue>;
  lookup_entries: ReadonlyArray<JsonValue>;
  transitive_artifact_version_ids: ReadonlyArray<JsonValue>;
  manifest_digest: string;
}
export interface PluginLookupInvalidationDependency {
  lookup_dependency_id: string;
  workspace_id: string;
  consumer_type: string;
  consumer_id: string;
  owner_artifact_id?: string;
  owner_artifact_version_id?: string;
  operation: string;
  normalized_selector_or_address: string;
  selector_digest: string;
  previous_result_set_digest: string;
  invalidation_scope: string;
  valid_from_generation: number;
  valid_to_generation?: number;
}
export interface PluginResourceBudget {
  deadline: string;
  max_memory_bytes: string;
  max_output_bytes: string;
  max_records: string;
  max_dependencies: string;
  max_context_operations: string;
  max_context_bytes: string;
  max_recursion_depth: string;
}
export interface PluginInputsIncomplete {
  candidate_issue_code: string;
  retryability: string;
  message: string;
  details: JsonValue;
}
export interface PluginUnsupported {
  candidate_issue_code: string;
  retryability: string;
  message: string;
  details: JsonValue;
}
export interface PluginCancelled {
  candidate_issue_code: string;
  retryability: string;
  message: string;
  details: JsonValue;
}
export interface PluginResourceExhausted {
  candidate_issue_code: string;
  retryability: string;
  message: string;
  details: JsonValue;
}
export interface PluginFailed {
  candidate_issue_code: string;
  retryability: string;
  message: string;
  details: JsonValue;
}
export interface IntentRecipeDefinition {
  recipe_id: string;
  recipe_version: number;
  public_api_version: number;
  description: string;
  argument_schema_id: string;
  argument_schema_version: number;
  stages: ReadonlyArray<IntentRecipeStageDefinition>;
  outputs: ReadonlyArray<IntentRecipeOutputDefinition>;
  required_capabilities: ReadonlyArray<string>;
  completeness_policy: "report" | "require_complete";
  ranking_bindings: ReadonlyArray<IntentRecipeRankingBinding>;
  guards: ReadonlyArray<IntentRecipeGuardDefinition>;
  pagination_streams: ReadonlyArray<IntentRecipePaginationStream>;
  recipe_digest: string;
}
export type RecipeStaticArgumentValue = string | number | boolean | null | ReadonlyArray<RecipeStaticArgumentValue> | { readonly [key: string]: RecipeStaticArgumentValue } | SourceIncludeOptions | StructuralFilter | RelationSelector | KindSelector | ChangeDescriptor;
export interface IntentRecipeStageDefinition { stage_id: string; operator_id: string; operator_version: number; inputs: ReadonlyArray<StageOutputReference>; static_arguments_schema_id: string; static_arguments_schema_version: number; static_arguments_schema_coordinate: string; static_arguments: Readonly<Record<string, RecipeStaticArgumentValue>>; partial_arguments_schema_id: string; partial_arguments_schema_version: number; partial_arguments_schema_coordinate: string; argument_bindings: ReadonlyArray<RecipeArgumentBinding>; }
export interface RecipeArgumentBinding { recipe_argument_path?: string; source_output_reference?: string; stage_id: string; stage_argument_path: string; }
export interface IntentRecipeOutputDefinition { output_name: string; stage_id: string; stage_output: string; projection: "subjects" | "relations" | "paths" | "definitions"; }
export interface IntentRecipeRankingBinding { stage_id: string; ranking_profile_id: string; ranking_profile_version: number; }
export interface IntentRecipeGuardDefinition { guard_id: string; evaluation_point: "before_stage" | "after_stage" | "before_output"; predicate_code: string; failure_error_code: ReadonlyArray<string>; guard_code: string; stage_id: string; failure_code: string; }
export interface IntentRecipePaginationStream { stream_name: string; output_name: string; ordering_id: string; ordering_version: number; classifications: ReadonlyArray<"confirmed" | "possible" | "unclassified">; result_set?: string; classification?: "confirmed" | "possible" | "unclassified"; }
export interface QueryExecution {
  query_plan_hash: string;
}
export interface WorkspaceSnapshotBinding { workspace_snapshot_binding_id: string; participant_ordinal: number; participant_role?: string; workspace_id: string; snapshot_id: string; generation: number; registry_snapshot_id: string; resolution_lock_id: string; configuration_revision_id: string; freshness_checkpoint_id: string; retention_lease_id: string; }
export interface QueryEmbedding {
  query_embedding_digest: string;
  embedding_input_digest: string;
  vector_digest: string;
  generator_configuration_digest: string;
  executable_binding_digest: string;
  embedding_profile_digest: string;
}
export interface SemanticIndexBinding {
  binding_digest: string;
  generator_configuration_digest: string;
  executable_binding_digest: string;
  embedding_profile_digest: string;
  queryable_vector_set_digest: string;
}
export interface SemanticCoverageView { semantic_index_binding_id: string; materialization_state: string; artifact_count: number; covered_artifact_count: number; pending_artifact_count: number; excluded_artifact_count: number; unsupported_artifact_count: number; failed_artifact_count: number; affected_artifact_set_id?: string; affected_artifact_count: number; affected_artifact_page?: SemanticAffectedArtifactPage; }
export interface SemanticAffectedArtifactView { artifact_id: string; artifact_version_id: string; display_path: string; coverage_status: string; reason_codes: ReadonlyArray<string>; diagnostic_record_ids: ReadonlyArray<string>; }
export interface SemanticAffectedArtifactPage { affected_artifact_set_id: string; artifacts: ReadonlyArray<SemanticAffectedArtifactView>; total: number; next_cursor?: string; previous_cursor?: string; has_next: boolean; has_previous: boolean; }
export interface ResultManifestEntry { query_execution_id: string; ordinal: number; result_set: string; primary_result: ResultSubject; evidence_path_record_ids: ReadonlyArray<string>; result_classification: "confirmed" | "possible"; rank: number; stage_id: string; source_projection: string; stable_sort_key: string; }
export type ProvenancePathStep = StageOutputReference | RecordSubject;
export interface ResultBundle { result_set: string; primary_result: PrimaryResultView; assessment: ResultAssessment; provenance_path: ReadonlyArray<ProvenancePathStep>; essential_related_entities: ReadonlyArray<EntityPrimaryResultView>; optional_source_snippets: ReadonlyArray<SourceSnippet>; }
export type ResultSubject = EntityResultSubject | RecordResultSubject | ArtifactResultSubject;
export interface EntityResultSubject { result_type: "entity"; workspace_snapshot_binding_id: string; entity_id: string; entity_record_id: string; }
export interface RecordResultSubject { result_type: "record"; workspace_snapshot_binding_id: string; record_id: string; }
export interface ArtifactResultSubject { result_type: "artifact"; workspace_snapshot_binding_id: string; artifact_id: string; artifact_version_id: string; }
export type PrimaryResultView = EntityPrimaryResultView | RecordPrimaryResultView | ArtifactPrimaryResultView;
export interface EntityPrimaryResultView { result_type: "entity"; subject: EntityResultSubject; record: EntityRecord; }
export interface RecordPrimaryResultView { result_type: "record"; subject: RecordResultSubject; record: RecordEnvelope; }
export interface ArtifactPrimaryResultView { result_type: "artifact"; subject: ArtifactResultSubject; artifact: SourceArtifact; artifact_version: ArtifactVersion; }
export interface CompletenessReport { workspace_snapshot_binding_ids: ReadonlyArray<string>; overall_status: "complete" | "partial" | "unknown" | "unsupported" | "stale"; dimensions: ReadonlyArray<CompletenessDimension>; diagnostic_record_ids: ReadonlyArray<string>; }
export interface CompletenessDimension { workspace_snapshot_binding_ids: ReadonlyArray<string>; capability: string; status: "complete" | "partial" | "unknown" | "unsupported" | "stale"; reason_codes: ReadonlyArray<string>; affected_artifact_count?: number; affected_artifact_ids: ReadonlyArray<string>; affected_artifact_set_id?: string; diagnostic_record_ids: ReadonlyArray<string>; }
export interface ResultAssessment { classification: "confirmed" | "possible"; confidence_level?: "high" | "medium" | "low"; evidence_summary?: EvidenceSummary; completeness: CompletenessReport["overall_status"]; }
export interface EvidenceSummary { primary_basis: string; primary_derivation: string; explanation_code: string; evidence_count: number; assumption_codes: ReadonlyArray<string>; citations: ReadonlyArray<EvidenceCitation>; has_more_evidence: boolean; evidence_cursor?: string; }
export interface EvidenceCitation { evidence_record_id: string; basis: string; derivation: string; claim_class: string; confidence_level?: "high" | "medium" | "low"; explanation_code: string; source: SourceReferenceView; }
export interface SourceReferenceView { artifact_id: string; artifact_version_id: string; path: string; span?: SourceSpan; snippet?: SourceSnippet; }
export interface SourceSnippet { text: string; span: SourceSpan; truncated: boolean; redacted: boolean; redactions: ReadonlyArray<SnippetRedaction>; }
export interface SnippetRedaction { source_span: SourceSpan; output_start_character: number; output_end_character: number; reason_code: string; }
export interface EvidenceIncludeOptions { evidence: "none" | "summary" | "full"; evidence_chain_depth: number; }
export interface SourceIncludeOptions { mode: "none" | "signature" | "relevant" | "body"; max_characters_per_snippet: number; max_total_characters: number; context_lines: number; }
export interface DiagnosticReport { total: number; returned: number; by_severity: Readonly<Record<"info" | "warning" | "error", number>>; by_completeness_effect: Readonly<Record<"none" | "local" | "capability", number>>; diagnostics: ReadonlyArray<DiagnosticView>; has_more: boolean; cursor?: string; }
export interface DiagnosticView { diagnostic_record_id: string; diagnostic_code: string; code_definition_revision: number; code_schema_version: number; title: string; diagnostic_category: string; severity: "info" | "warning" | "error"; completeness_effect: "none" | "local" | "capability"; completeness_status?: string; summary: string; detail?: string; affected_scopes: ReadonlyArray<DiagnosticScope>; recovery: DiagnosticRecovery; agent_guidance: string; source: SourceReferenceView; evidence_summary?: EvidenceSummary; }
export interface DiagnosticIncludeOptions { diagnostics: "none" | "relevant" | "all"; diagnostic_detail: boolean; }
export type CursorTokenClaims = QueryCursorTokenClaims | IndexStatusCursorTokenClaims;
export interface QueryCursorTokenClaims {
  workspace_scope_digest: string;
}
export interface IndexStatusCursorTokenClaims {
  workspace_status_scope_digest: string;
}
export interface RegistryUsageSet {
  registry_usage_set_id: string;
  query_execution_id: string;
  parent_slices: ReadonlyArray<RegistryUsageParentSlice>;
  registry_snapshot_ids: ReadonlyArray<string>;
  definition_set: string;
  usage_set_digest: string;
}
export interface RegistryUsageParentSlice {
  result_stream: string;
  stable_start_position: string;
  stable_end_position_exclusive: string;
  projection_digest: string;
}
export interface ResultSetPage { result_set: string; confirmed: ResultStreamPage; possible: ResultStreamPage; }
export interface ResultStreamPage { classification: "confirmed" | "possible"; page_mode: "hydrated" | "summary"; result_bundles: ReadonlyArray<ResultBundle>; total: number; next_cursor?: string; previous_cursor?: string; has_next: boolean; has_previous: boolean; }
export interface QueryResultPage { query_execution_id: string; scope_kind: "single_workspace" | "comparison"; workspace_snapshot_bindings: ReadonlyArray<WorkspaceSnapshotBinding>; semantic_coverage_views: ReadonlyArray<SemanticCoverageView>; result_sets: ReadonlyArray<ResultSetPage>; expires_at: string; returned_items: number; returned_characters: number; estimated_tokens?: number; completeness_report: CompletenessReport; diagnostic_report: DiagnosticReport; registry_bundle?: RegistryBundle; }
export type IndexStatusRequest = IndexStatusInitialRequest | IndexStatusInitialRequestV2 | IndexStatusInitialRequestV3 | IndexStatusInitialListRequestV3 | IndexStatusContinuationRequest;
/** API v2 initial status request. A root lookup is intentionally disjoint from ID lookup. */
export interface IndexStatusInitialRequestV2 {
  request_type: "initial";
  api_version: 2;
  workspace_ids: [];
  workspace_root: string;
  include_capabilities: boolean;
  include_plugins: boolean;
  include_activation_issues: boolean;
  include_candidate_issues: boolean;
  include_configuration_issues: boolean;
  response_budget: ResponseBudget;
}
export type IndexStatusRequestV2 = IndexStatusInitialRequestV2 | IndexStatusContinuationRequest;
/** API v3 status request. v3 keeps v2 root lookup and adds layered readiness fields to the response. */
export interface IndexStatusInitialRequestV3 {
  request_type: "initial";
  api_version: 3;
  workspace_ids: [];
  workspace_root: string;
  include_capabilities: boolean;
  include_plugins: boolean;
  include_activation_issues: boolean;
  include_candidate_issues: boolean;
  include_configuration_issues: boolean;
  response_budget: ResponseBudget;
}
/** API v3 list request. An empty workspace_ids list asks for all registered workspaces. */
export interface IndexStatusInitialListRequestV3 {
  request_type: "initial";
  api_version: 3;
  workspace_ids: [];
  include_capabilities: boolean;
  include_plugins: boolean;
  include_activation_issues: boolean;
  include_candidate_issues: boolean;
  response_budget: ResponseBudget;
}
export type IndexStatusRequestV3 = IndexStatusInitialRequestV3 | IndexStatusInitialListRequestV3 | IndexStatusContinuationRequest;
export interface IndexStatusInitialRequest {
  request_type: "initial";
  api_version: number;
  workspace_ids: ReadonlyArray<string>;
  include_capabilities: boolean;
  include_plugins: boolean;
  include_activation_issues: boolean;
  include_candidate_issues: boolean;
  response_budget: ResponseBudget;
}
export interface IndexStatusContinuationRequest {
  request_type: "continuation";
  api_version: number;
  workspace_ids: ReadonlyArray<string>;
  cursor: string;
  response_budget: ResponseBudget;
}
export interface IndexStatusExecution {
  index_status_execution_id: string;
  workspace_ids: ReadonlyArray<string>;
  include_capabilities: boolean;
  include_plugins: boolean;
  include_activation_issues: boolean;
  include_candidate_issues: boolean;
  workspace_status_set: string;
  activation_issue_status_set: string;
  candidate_issue_status_set: string;
  response_budget_ceiling: string;
  projection_digest: string;
  execution_status: string;
  observed_at: string;
  created_at: string;
  expires_at: string;
}
export interface IndexStatusPage {
  index_status_execution_id: string;
  workspace_ids: ReadonlyArray<string>;
  workspaces: string;
  activation_issues: string;
  candidate_issues: string;
  observed_at: string;
  expires_at: string;
  returned_items: string;
  returned_characters: string;
}
export interface WorkspaceStatusStreamPage {
  workspaces: ReadonlyArray<WorkspaceIndexStatusView>;
  total: string;
  next_cursor?: string;
  previous_cursor?: string;
  has_next: boolean;
  has_previous: boolean;
}
export type ReadinessAvailability = "available" | "unavailable";
export type ReadinessCompleteness = "complete" | "partial" | "unknown" | "unsupported" | "stale";
export type ReadinessBuildState = "not_started" | "building" | "idle" | "failed" | "disabled";
export type ReadinessFreshness = "equivalent" | "changes_pending" | "degraded";
export interface SourceSnapshot { source_snapshot_id: string; workspace_id: string; generation: number; source_state_digest?: string; provider_watermarks: JsonValue; lexical_coverage: JsonValue; }
export interface IndexLayerReadinessView { availability: ReadinessAvailability; completeness: ReadinessCompleteness; freshness?: ReadinessFreshness; build_state: ReadinessBuildState; snapshot_id?: string; based_on_source_snapshot_id?: string; based_on_structural_snapshot_id?: string; reason_codes: ReadonlyArray<string>; retry_after_ms?: number; }
export interface WorkspaceReadinessView { source: IndexLayerReadinessView; structural: IndexLayerReadinessView; semantic: IndexLayerReadinessView; }
export interface OperationAvailabilityView { available_now: ReadonlyArray<string>; blocked: ReadonlyArray<{ operation: string; required_layer: "source" | "structural" | "semantic"; retryable: boolean; reason_code: string; retry_after_ms?: number }>; }
export interface WorkspaceIndexStatusView {
  workspace_id: string;
  display_root: string;
  workspace_status: string;
  startup_phase: string;
  current_snapshot_id?: string;
  current_generation?: string;
  freshness_checkpoint_id?: string;
  freshness_status: string;
  last_scan_error_code?: string;
  last_scan_error_at?: string;
  current_candidate?: string;
  active_registry_snapshot_id?: string;
  active_resolution_lock_id?: string;
  plugins: ReadonlyArray<WorkspacePluginStatusView>;
  capabilities: ReadonlyArray<WorkspaceCapabilityStatusView>;
  structural_progress?: ReadonlyArray<JsonValue>;
  semantic_materializations: ReadonlyArray<SemanticMaterializationStatusView>;
  latest_activation_attempt?: string;
  /** Derived source-first readiness booleans. They are never persisted independently. */
  source_ready?: boolean;
  structural_ready?: boolean;
  semantic_ready?: boolean;
  source_snapshot_id?: string;
  structural_snapshot_id?: string;
  structural_source_snapshot_id?: string;
  source_availability?: "available" | "unavailable";
  source_completeness?: "complete" | "partial" | "unknown" | "unsupported" | "stale";
  source_freshness?: "equivalent" | "changes_pending" | "degraded";
  source_build_state?: "not_started" | "building" | "idle" | "failed" | "disabled";
  structural_availability?: "available" | "unavailable";
  structural_completeness?: "complete" | "partial" | "unknown" | "unsupported" | "stale";
  structural_freshness?: "equivalent" | "changes_pending" | "degraded";
  structural_build_state?: "not_started" | "building" | "idle" | "failed" | "disabled";
  semantic_availability?: "available" | "unavailable";
  semantic_completeness?: "complete" | "partial" | "unknown" | "unsupported" | "stale";
  semantic_build_state?: "not_started" | "building" | "idle" | "failed" | "disabled";
  readiness_reason_codes?: ReadonlyArray<string>;
  retry_after_ms?: number;
  available_operations?: ReadonlyArray<string>;
  blocked_operations?: ReadonlyArray<string>;
  /** Detailed v3 readiness block; flattened fields above keep legacy consumers simple. */
  readiness?: WorkspaceReadinessView;
  operation_availability?: OperationAvailabilityView;
}
export type WorkspaceConfigurationAttemptState = "proposed" | "confirmed" | "running" | "succeeded" | "failed" | "superseded";
export type WorkspaceConfigurationIssueSeverity = "info" | "warning" | "error";
export type WorkspaceConfigurationIssueCode = "invalid_config" | "stale_proposal" | "plugin_unavailable" | "plugin_incompatible" | "technology_unconfirmed" | "reindex_required";
export type WorkspaceConfigurationImpact = "query_only" | "analysis" | "source_selection" | "plugin_resolution" | "semantic_projection";
export interface WorkspaceTechnologyEvidence {
  path: string;
  rule: string;
  value?: string;
}
export interface WorkspaceTechnology {
  technology_id: string;
  kind: "language" | "framework";
  confidence: number;
  evidence: ReadonlyArray<WorkspaceTechnologyEvidence>;
  compatible_plugin_ids: ReadonlyArray<string>;
}
export interface WorkspaceTechnologyProposal {
  proposal_id: string;
  workspace_root: string;
  provider_fingerprint: string;
  git_state_fingerprint: string;
  plugin_catalog_fingerprint: string;
  proposal_fingerprint: string;
  technologies: ReadonlyArray<WorkspaceTechnology>;
  selected_technology_ids: ReadonlyArray<string>;
  selected_plugin_ids: ReadonlyArray<string>;
  phase: "technology" | "plugins" | "confirmed" | "stale";
}
export interface WorkspaceConfigurationIssue {
  issue_id: string;
  code: WorkspaceConfigurationIssueCode;
  severity: WorkspaceConfigurationIssueSeverity;
  message: string;
  path?: string;
}
export interface WorkspaceConfigurationAttempt {
  attempt_id: string;
  workspace_id: string;
  state: WorkspaceConfigurationAttemptState;
  impact: WorkspaceConfigurationImpact;
  proposal_fingerprint: string;
  configuration_digest: string;
  technologies: ReadonlyArray<WorkspaceTechnology>;
  issues: ReadonlyArray<WorkspaceConfigurationIssue>;
  started_at: string;
  completed_at?: string;
}
export interface WorkspaceIndexStatusViewV2 extends WorkspaceIndexStatusView {
  latest_configuration_attempt?: WorkspaceConfigurationAttempt;
  configuration_issues: ReadonlyArray<WorkspaceConfigurationIssue>;
}
export interface IndexCandidateStatusView {
  candidate_generation_id: string;
  trigger_kind: string;
  state: string;
  base_snapshot_id?: string;
  target_registry_snapshot_id: string;
  target_configuration_revision_id: string;
  issue_count: number;
  created_at: string;
  analysis_started_at?: string;
  ready_at?: string;
}
export interface WorkspacePluginStatusView {
  plugin_id: string;
  plugin_version: string;
  activation_status: string;
  capability_declarations: ReadonlyArray<PluginCapabilityDeclaration>;
}
export interface WorkspaceCapabilityStatusView {
  capability: string;
  capability_contract_version: string;
  provider_id: string;
  provider_version: string;
  status: string;
  reason_codes: ReadonlyArray<string>;
  affected_artifact_count: number;
  availability?: "available" | "unavailable";
  completeness?: "complete" | "partial" | "unknown" | "unsupported" | "stale";
  build_state?: "not_started" | "building" | "idle" | "failed" | "disabled";
  languages?: ReadonlyArray<string>;
  retry_after_ms?: number;
  publication_stage_id?: string;
  publication_stage_ordinal?: number;
  publication_stage_count?: number;
}
export interface WorkspaceStructuralProgressView {
  provider_id: string;
  provider_version: string;
  source_snapshot_id?: string;
  current_stage_id?: string;
  completed_stage_ordinal: number;
  stage_count: number;
  completeness: string;
}
export interface SemanticMaterializationStatusView {
  semantic_materialization_id: string;
  embedding_profile_id: string;
  source_snapshot_id: string;
  materialization_state: string;
  coverage_status: string;
  pending_document_count: number;
  pending_segment_count: number;
}
export interface ActivationAttemptStatusView {
  activation_attempt_id: string;
  state: string;
  phase: string;
  candidate_generation_id?: string;
  published_snapshot_id?: string;
  issue_count: number;
  started_at: string;
  finished_at?: string;
}
export interface ActivationIssueStatusView {
  issue_id: string;
  code: string;
  severity: string;
  phase: string;
  plugin_ids: ReadonlyArray<string>;
  summary: string;
  required_action: string;
  retryable: string;
  created_at: string;
}
export interface CandidateIssueStatusView {
  candidate_issue_id: string;
  candidate_generation_id: string;
  issue_code: string;
  phase: string;
  severity: string;
  scope: CandidateIssueScope;
  retryability: string;
  summary: string;
  created_at: string;
}
export interface ActivationIssueStatusStreamPage {
  issues: ReadonlyArray<ActivationIssueStatusView>;
  total: string;
  next_cursor?: string;
  previous_cursor?: string;
  has_next: boolean;
  has_previous: boolean;
}
export interface CandidateIssueStatusStreamPage {
  issues: ReadonlyArray<CandidateIssueStatusView>;
  total: string;
  next_cursor?: string;
  previous_cursor?: string;
  has_next: boolean;
  has_previous: boolean;
}
export interface RetentionLease {
  retention_lease_id: string;
  workspace_id: string;
  snapshot_id: string;
  holder_type: string;
  holder_id: string;
  acquired_at: string;
  last_renewed_at: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  released_at: string;
  release_reason: string;
}
export interface SnapshotRetentionPin {
  retention_pin_id: string;
  workspace_id: string;
  snapshot_id: string;
  pin_kind: string;
  reason_code: string;
  source_reference: SourceReference;
  created_at: string;
  expires_at: string;
  released_at: string;
  release_reason: string;
}
export interface SnapshotExpirationMarker {
  snapshot_expiration_id: string;
  workspace_id: string;
  snapshot_id: string;
  generation: number;
  expired_at: string;
  expiration_reason_code: string;
  garbage_collection_epoch_id: string;
  snapshot_digest: string;
}
export interface SnapshotRetentionStatus {
  workspace_id: string;
  snapshot_id: string;
  generation: number;
  availability: string;
  is_current: boolean;
  active_pin_count: number;
  active_lease_count: number;
  retention_reasons: string;
  earliest_expiration_at: string;
}
export interface GarbageCollectionEpoch {
  garbage_collection_epoch_id: string;
  state: string;
  started_at: string;
  mark_completed_at: string;
  sweep_started_at: string;
  completed_at: string;
  workspace_boundaries: string;
  retention_root_digest: string;
  candidate_object_count: number;
  candidate_object_digest: string;
  deleted_object_count: number;
  deleted_object_digest: string;
  failure_code: string;
}
export interface WorkspaceGcBoundary {
  workspace_id: string;
  current_generation: string;
  minimum_retained_generation: string;
  evaluated_at: string;
}
