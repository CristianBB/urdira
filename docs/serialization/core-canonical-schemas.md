# Core Canonical Schemas

Status: **Approved initial registry**  
Last updated: 2026-08-08  
Depends on: [Universal data model](../decisions/01-universal-data-model.md) and [Urdira Canonical Encoding](urdira-canonical-encoding.md)

## Authority and notation

This file is the single coordinate registry for every named `core:*@1` canonical schema referenced by UCE v1, digest recipes, protocol envelopes, manifests, or verified inputs. Each coordinate has exactly one definition form:

- `model_reference` points to one approved model in the universal data model. The referenced model's declared field order, field table, closed enums, presence rules, and UCE logical types are authoritative; this file does not duplicate them.
- `inline_schema` defines one synthetic digest input or manifest value here. Its shape below is the authoritative closed Schema IR source.

Generated CDDL, JSON Schema, TypeScript, database, or validator artifacts are derived outputs and cannot amend these definitions. Comparator coordinates such as `core:record_id_order@1` belong to the canonical-comparator registry and are never schema coordinates. Unknown fields, implicit defaults, arbitrary JSON, recursive values, and floating schema references are rejected.

Notation uses `T?` for an optional field, `Sequence<T>` for caller-significant order, `Set<T>` for a duplicate-free canonically ordered set, and `OrderedSet<T, comparator@version>` for a duplicate-free set ordered by the named comparator. `SchemaBoundBytes` means exact UCE bytes already validated against the adjacent exact `schema_id + schema_version`; it is not arbitrary or untyped data. `Identifier`, `NamespacedIdentifier`, `SemVer`, and `URI` are constrained `Text`; `Count` and `PositiveInteger` are safe integers; `Digest`, `Bytes`, `Timestamp`, and `Boolean` are the UCE logical types of those names.

## Model-reference schemas

| Schema coordinate | Form | Authoritative model |
|---|---|---|
| `core:ModelAssetManifest@1` | `model_reference` | `ModelAssetManifest` in the [universal data model](../decisions/01-universal-data-model.md) |
| `core:ModelPackRuntimeConfiguration@1` | `model_reference` | `ModelPackRuntimeConfiguration` in the [universal data model](../decisions/01-universal-data-model.md) |
| `core:TokenizerAssetManifest@1` | `model_reference` | `TokenizerAssetManifest` in the [universal data model](../decisions/01-universal-data-model.md) |

The canonical schema version is the model's approved `schema_version = 1`. If a referenced model later changes its canonical shape, a new schema coordinate is mandatory; editing the meaning of `@1` is forbidden.

## Primitive and normalized configuration schemas

```text
core:Bytes@1 = Bytes

core:AnalysisRelevantArtifactMetadata@1
  metadata_schema_id : NamespacedIdentifier
  metadata_schema_version : PositiveInteger
  normalized_metadata : SchemaBoundBytes

core:AnalysisConfiguration@1
  configuration_schema_id : NamespacedIdentifier
  configuration_schema_version : PositiveInteger
  normalized_configuration : SchemaBoundBytes

core:QueryConfiguration@1
  configuration_schema_id : NamespacedIdentifier
  configuration_schema_version : PositiveInteger
  normalized_configuration : SchemaBoundBytes

core:GeneratorConfiguration@1
  configuration_schema_id : NamespacedIdentifier
  configuration_schema_version : PositiveInteger
  normalized_configuration : SchemaBoundBytes

core:SourceProviderConfiguration@1
  configuration_schema_id : NamespacedIdentifier
  configuration_schema_version : PositiveInteger
  normalized_configuration : SchemaBoundBytes

core:NormalizedConfigurationLayer@1
  layer_kind : installation_policy | user_policy | workspace_file | administrative_override
  configuration_schema_id : NamespacedIdentifier
  configuration_schema_version : PositiveInteger
  normalized_configuration : SchemaBoundBytes
```

Every normalized byte field contains exactly one complete UCE value under the adjacent schema coordinate. The coordinate and bytes are both digest input. Configuration schemas cannot read environment state, defaults, secrets, paths, or mutable files during verification; those values must already have been resolved into the normalized value. Secret bytes are forbidden, while stable secret-version references may be fields of the selected configuration schema.

## Implementation and package manifest schemas

```text
core:AnalyzerImplementationManifest@1
  plugin_id : NamespacedIdentifier
  plugin_version : SemVer
  analyzer_id : NamespacedIdentifier
  analyzer_version : SemVer
  executable_asset_digests : Set<Digest>
  parser_asset_digests : Set<Digest>
  rule_asset_digests : Set<Digest>
  model_asset_digests : Set<Digest>
  dependency_asset_digests : Set<Digest>
  supported_capabilities : Set<NamespacedIdentifier>

core:RuntimeComponentBehaviorManifest@1
  component_id : NamespacedIdentifier
  component_version : SemVer
  component_kind : source_provider | projection_generator | embedding_renderer | embedding_segmenter | embedding_generator
  contract_bindings : Set<RuntimeComponentContractBinding>
  configuration_schema_ids : Set<NamespacedIdentifier>
  algorithm_ids : Set<NamespacedIdentifier>
  supported_format_ids : Set<NamespacedIdentifier>
  deterministic_numeric_contract : Text
  portable_behavior_rules : Sequence<Text>

core:RuntimeComponentImplementationManifest@1
  runtime_component_build_id : Identifier
  component_id : NamespacedIdentifier
  component_version : SemVer
  behavior_digest : Digest
  target_triple : Text
  executable_asset_digests : Set<Digest>
  native_asset_digests : Set<Digest>
  dependency_asset_digests : Set<Digest>

core:PluginPackageManifest@1
  package_format_id : NamespacedIdentifier
  package_format_version : PositiveInteger
  plugin_id : NamespacedIdentifier
  plugin_version : SemVer
  package_files : OrderedSet<PackageFileEntry, core:package_file_path_order@1>

PackageFileEntry
  normalized_relative_path : Text
  content_digest : Digest
  byte_length : Count
  executable : Boolean
```

Asset sets are complete transitive closures for the named role. A digest appearing in several roles remains present in each semantic set. `package_files` covers every package file after the package format's explicitly registered integrity exclusions; paths obey canonical relative-path rules and are unique.

## Registry and compatibility input schemas

```text
core:CoreRegistryManifest@1
  registry_contract_version : SemVer
  definitions : OrderedSet<CoreRegistryDefinition, core:registry_definition_order@1>

core:CoreRegistryDefinition@1
  registry_type : NamespacedIdentifier
  definition_id : NamespacedIdentifier
  definition_revision : PositiveInteger
  schema_id : NamespacedIdentifier
  schema_version : PositiveInteger
  definition_bytes : SchemaBoundBytes

core:CandidateRegistryState@1
  registry_contract_version : SemVer
  core_registry_digest : Digest
  candidate_resolution_lock_id : Identifier
  namespace_owners : OrderedSet<CandidateNamespaceOwner, core:namespace_owner_order@1>

CandidateNamespaceOwner
  namespace : Text
  plugin_id : NamespacedIdentifier
  plugin_version : SemVer
  contribution_digest : Digest

core:CompatibilityRequirementValue@1
  requirement_schema_id : NamespacedIdentifier
  requirement_schema_version : PositiveInteger
  requirement_value : SchemaBoundBytes
```

`CoreRegistryDefinition.definition_bytes` is the exact UCE encoding under its adjacent schema coordinate, not a second schema authority. Registry type, identifier, and revision must equal the decoded definition. Namespace-owner order is lexicographic by namespace, plugin ID, plugin version, and digest; the named comparator must be registered before activation.

## Candidate, partition, and set-entry schemas

```text
core:ArtifactPartitionKey@1
  workspace_id : Identifier
  artifact_id : Identifier
  artifact_version_id : Identifier

core:CallablePartitionKey@1
  workspace_id : Identifier
  callable_entity_id : Identifier
  callable_record_id : Identifier

core:FrameworkPartitionKey@1
  workspace_id : Identifier
  framework_id : NamespacedIdentifier
  project_partition_id : Identifier

core:ProjectPartitionKey@1
  workspace_id : Identifier
  project_partition_id : Identifier

core:FrozenCandidateDigestInputs@1
  accepted_fact_delta_digests : Set<Digest>
  materialization_digest : Digest

core:ArtifactAnalysisContext@1
  registry_snapshot_id : Identifier
  configuration_revision_id : Identifier
  dependency_plugin_digests : Set<Digest>
  analysis_configuration_digest : Digest

core:ProjectionSetDigestItem@1
  projection_record_id : Identifier
  content_digest : Digest

core:QueryableVectorDigestEntry@1
  projection_record_id : Identifier
  vector_digest : Digest

core:RecordSetDigestEntry@1
  record_id : Identifier
  record_digest : Digest

core:RetentionRootReference@1
  root_type : current_snapshot | snapshot_pin | snapshot_lease | query_execution | index_status_execution | index_candidate | recovery_operation | recovery_checkpoint | active_configuration | model_pack_installation
  root_id : Identifier
  workspace_id : Identifier?

core:StoredObjectReference@1
  object_type : NamespacedIdentifier
  object_id : Identifier
  content_digest : Digest?

core:VisibleSourceStateSet@1 = OrderedSet<VisibleSourceStateEntry, core:visible_source_state_order@1>
```

Partition-key variants are selected by the exact capability contract; a plugin cannot substitute one variant for another. All identifiers name objects in the frozen candidate workspace and view. Optional `workspace_id` on a retention root is present exactly for workspace-owned roots. `content_digest` on a stored object is present exactly when that object has an authoritative digest field.

## Query normalization schemas

```text
core:NormalizedResponseBudget@1
  max_items : PositiveInteger
  max_characters : PositiveInteger

core:NormalizedResultProjection@1
  evidence : EvidenceIncludeOptions
  diagnostics : DiagnosticIncludeOptions
  snippets : SourceIncludeOptions
  registry : RegistryIncludeOptions

core:NormalizedIndexStatusProjection@1
  include_capabilities : Boolean
  include_plugins : Boolean
  include_activation_issues : Boolean
  include_candidate_issues : Boolean

core:NormalizedQueryPlan@1
  api_version : SemVer
  scope : QueryScope
  normalized_expression : QueryExpression
  freshness : snapshot | current | wait_for_current
  wait_timeout_ms : Count
  coverage_requirement : accept_reported | require_complete
  projection : NormalizedResultProjection
  response_budget : NormalizedResponseBudget
  operation_versions : OrderedSet<OperationVersionBinding, core:operation_id_order@1>
  recipe_versions : OrderedSet<RecipeVersionBinding, core:recipe_id_order@1>

OperationVersionBinding
  operation_id : NamespacedIdentifier
  operation_version : PositiveInteger

RecipeVersionBinding
  recipe_id : NamespacedIdentifier
  recipe_version : PositiveInteger
```

All referenced query values are the closed public models in the universal data model and public query contract. `NormalizedIndexStatusProjection` is the complete status hydration shape; response budget and workspace scope are committed separately. Normalization expands every default, resolves recipe and operation versions, pins workspace snapshots, and removes presentation-only JSON distinctions before encoding. Ranking implementation details, physical plans, timing, cache state, and plugin policy are absent.

## Intent-recipe argument and template schemas

```text
core:RecipeStaticArguments@1
  operation_id : NamespacedIdentifier
  operation_version : PositiveInteger
  partial_arguments_schema_id : NamespacedIdentifier
  partial_arguments_schema_version : PositiveInteger
  partial_arguments : SchemaBoundBytes

core:LocateImplementationArguments@1
  query_text : Text
  query_class : (natural_text | identifier | source_code | mixed)?
  filter : StructuralFilter?

core:UnderstandChangeImpactArguments@1
  target : SubjectSelector
  change : ChangeDescriptor
  include_transitive : Boolean?
  include_tests : Boolean?
  filter : StructuralFilter?

core:PrepareSymbolChangeArguments@1
  reference : Text
  context_artifact : Identifier?
  context_byte_offset : Count?
  kind_selector : KindSelector?
  change : ChangeDescriptor
  filter : StructuralFilter?

core:PrepareNewFeatureArguments@1
  task : Text
  query_class : (natural_text | identifier | source_code | mixed)?
  filter : StructuralFilter?

core:TraceBehaviorArguments@1
  subjects : Sequence<SubjectSelector>
  direction : (inbound | outbound | both)?
  relations : RelationSelector?
  max_depth : PositiveInteger?
  filter : StructuralFilter?

core:FindRelevantTestsArguments@1
  subjects : Sequence<SubjectSelector>
  relationship_scope : (direct | transitive | both)?
  include_fixtures : Boolean?
  filter : StructuralFilter?

core:ExplainArchitectureSliceArguments@1
  scope : Sequence<SubjectSelector>?
  views : Set<entry_points | boundaries | public_surfaces | cycles | extension_points | layers>?
  max_relation_depth : PositiveInteger?
  filter : StructuralFilter?

core:CompareWorkspacesArguments@1
  selection : Sequence<SubjectSelector>?
  comparison_kinds : Set<added | removed | changed | moved | correlated>?
  correlation_policy : (strict | include_possible)?
  filter : StructuralFilter?

core:SemanticToCallersArguments@1
  query_text : Text
  query_class : (natural_text | identifier | source_code | mixed)?
  max_call_depth : PositiveInteger?
  filter : StructuralFilter?

core:ResolveAndFindReferencesArguments@1
  reference : Text
  context_artifact : Identifier?
  context_byte_offset : Count?
  kind_selector : KindSelector?
  reference_roles : Set<NamespacedIdentifier>?
  include_declarations : Boolean?
  filter : StructuralFilter?

core:DefinitionToInstancesArguments@1
  matcher : DefinitionMatcher
  selector : RegistrySelector?
  record_categories : Set<entity | relation | fact | evidence | diagnostic>?
  producer_ids : Set<NamespacedIdentifier>?
  filter : StructuralFilter?
```

`RecipeStaticArguments.partial_arguments` is validated against the adjacent exact partial-operation schema before recipe argument bindings are applied. The completed object must then validate against the stable operation's complete argument schema. Recipe defaults shown as required booleans, enums, and depths are expanded during public request normalization; callers may omit only fields whose recipe definition explicitly supplies that default. Subject arrays and view/comparison sets are non-empty whenever present. Context artifact and byte offset obey symbol-resolution presence rules. `DefinitionToInstancesArguments.selector`, when present, may select only `record_kind`, `facet`, or `language`; capability and other definition families are invalid for this recipe.

## Completeness rules

- Every named schema used by a core digest recipe, external verifier, protocol, or manifest must have exactly one entry in this file before registry activation.
- `model_reference` and `inline_schema` are mutually exclusive for one coordinate.
- Every inline field has the meaning stated here; adjacent schema coordinates are mandatory wherever `SchemaBoundBytes` appears.
- A comparator used by an ordered set must exist at the exact version in the canonical-comparator registry. Comparator definitions are not schemas.
- Schema references are acyclic. Historical coordinates remain immutable while retained data uses them.
- Activation mechanically rejects a missing coordinate, duplicate coordinate, unknown logical type, absent comparator, invalid model reference, or generated artifact whose compiled Schema IR differs from this authority.
