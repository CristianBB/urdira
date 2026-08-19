export interface InlineSchemaFieldSpec { name: string; optional: boolean; type: string; description?: string; }
export interface InlineSchemaSpec { id: string; fields: readonly InlineSchemaFieldSpec[]; }

export const inlineSchemaSpecs: readonly InlineSchemaSpec[] = [
  {
    "id": "core:Bytes@1",
    "fields": []
  },
  {
    "id": "core:AnalysisRelevantArtifactMetadata@1",
    "fields": [
      {
        "name": "metadata_schema_id",
        "optional": false,
        "type": "NamespacedIdentifier"
      },
      {
        "name": "metadata_schema_version",
        "optional": false,
        "type": "PositiveInteger"
      },
      {
        "name": "normalized_metadata",
        "optional": false,
        "type": "SchemaBoundBytes"
      }
    ]
  },
  {
    "id": "core:AnalysisConfiguration@1",
    "fields": [
      {
        "name": "configuration_schema_id",
        "optional": false,
        "type": "NamespacedIdentifier"
      },
      {
        "name": "configuration_schema_version",
        "optional": false,
        "type": "PositiveInteger"
      },
      {
        "name": "normalized_configuration",
        "optional": false,
        "type": "SchemaBoundBytes"
      }
    ]
  },
  {
    "id": "core:QueryConfiguration@1",
    "fields": [
      {
        "name": "configuration_schema_id",
        "optional": false,
        "type": "NamespacedIdentifier"
      },
      {
        "name": "configuration_schema_version",
        "optional": false,
        "type": "PositiveInteger"
      },
      {
        "name": "normalized_configuration",
        "optional": false,
        "type": "SchemaBoundBytes"
      }
    ]
  },
  {
    "id": "core:GeneratorConfiguration@1",
    "fields": [
      {
        "name": "configuration_schema_id",
        "optional": false,
        "type": "NamespacedIdentifier"
      },
      {
        "name": "configuration_schema_version",
        "optional": false,
        "type": "PositiveInteger"
      },
      {
        "name": "normalized_configuration",
        "optional": false,
        "type": "SchemaBoundBytes"
      }
    ]
  },
  {
    "id": "core:SourceProviderConfiguration@1",
    "fields": [
      {
        "name": "configuration_schema_id",
        "optional": false,
        "type": "NamespacedIdentifier"
      },
      {
        "name": "configuration_schema_version",
        "optional": false,
        "type": "PositiveInteger"
      },
      {
        "name": "normalized_configuration",
        "optional": false,
        "type": "SchemaBoundBytes"
      }
    ]
  },
  {
    "id": "core:NormalizedConfigurationLayer@1",
    "fields": [
      {
        "name": "layer_kind",
        "optional": false,
        "type": "installation_policy | user_policy | workspace_file | administrative_override"
      },
      {
        "name": "configuration_schema_id",
        "optional": false,
        "type": "NamespacedIdentifier"
      },
      {
        "name": "configuration_schema_version",
        "optional": false,
        "type": "PositiveInteger"
      },
      {
        "name": "normalized_configuration",
        "optional": false,
        "type": "SchemaBoundBytes"
      }
    ]
  },
  {
    "id": "core:AnalyzerImplementationManifest@1",
    "fields": [
      {
        "name": "plugin_id",
        "optional": false,
        "type": "NamespacedIdentifier"
      },
      {
        "name": "plugin_version",
        "optional": false,
        "type": "SemVer"
      },
      {
        "name": "analyzer_id",
        "optional": false,
        "type": "NamespacedIdentifier"
      },
      {
        "name": "analyzer_version",
        "optional": false,
        "type": "SemVer"
      },
      {
        "name": "executable_asset_digests",
        "optional": false,
        "type": "Set<Digest>"
      },
      {
        "name": "parser_asset_digests",
        "optional": false,
        "type": "Set<Digest>"
      },
      {
        "name": "rule_asset_digests",
        "optional": false,
        "type": "Set<Digest>"
      },
      {
        "name": "model_asset_digests",
        "optional": false,
        "type": "Set<Digest>"
      },
      {
        "name": "dependency_asset_digests",
        "optional": false,
        "type": "Set<Digest>"
      },
      {
        "name": "supported_capabilities",
        "optional": false,
        "type": "Set<NamespacedIdentifier>"
      }
    ]
  },
  {
    "id": "core:RuntimeComponentBehaviorManifest@1",
    "fields": [
      {
        "name": "component_id",
        "optional": false,
        "type": "NamespacedIdentifier"
      },
      {
        "name": "component_version",
        "optional": false,
        "type": "SemVer"
      },
      {
        "name": "component_kind",
        "optional": false,
        "type": "source_provider | projection_generator | embedding_renderer | embedding_segmenter | embedding_generator"
      },
      {
        "name": "contract_bindings",
        "optional": false,
        "type": "Set<RuntimeComponentContractBinding>"
      },
      {
        "name": "configuration_schema_ids",
        "optional": false,
        "type": "Set<NamespacedIdentifier>"
      },
      {
        "name": "algorithm_ids",
        "optional": false,
        "type": "Set<NamespacedIdentifier>"
      },
      {
        "name": "supported_format_ids",
        "optional": false,
        "type": "Set<NamespacedIdentifier>"
      },
      {
        "name": "deterministic_numeric_contract",
        "optional": false,
        "type": "Text"
      },
      {
        "name": "portable_behavior_rules",
        "optional": false,
        "type": "Sequence<Text>"
      }
    ]
  },
  {
    "id": "core:RuntimeComponentImplementationManifest@1",
    "fields": [
      {
        "name": "runtime_component_build_id",
        "optional": false,
        "type": "Identifier"
      },
      {
        "name": "component_id",
        "optional": false,
        "type": "NamespacedIdentifier"
      },
      {
        "name": "component_version",
        "optional": false,
        "type": "SemVer"
      },
      {
        "name": "behavior_digest",
        "optional": false,
        "type": "Digest"
      },
      {
        "name": "target_triple",
        "optional": false,
        "type": "Text"
      },
      {
        "name": "executable_asset_digests",
        "optional": false,
        "type": "Set<Digest>"
      },
      {
        "name": "native_asset_digests",
        "optional": false,
        "type": "Set<Digest>"
      },
      {
        "name": "dependency_asset_digests",
        "optional": false,
        "type": "Set<Digest>"
      }
    ]
  },
  {
    "id": "core:PluginPackageManifest@1",
    "fields": [
      {
        "name": "package_format_id",
        "optional": false,
        "type": "NamespacedIdentifier"
      },
      {
        "name": "package_format_version",
        "optional": false,
        "type": "PositiveInteger"
      },
      {
        "name": "plugin_id",
        "optional": false,
        "type": "NamespacedIdentifier"
      },
      {
        "name": "plugin_version",
        "optional": false,
        "type": "SemVer"
      },
      {
        "name": "package_files",
        "optional": false,
        "type": "OrderedSet<PackageFileEntry, core:package_file_path_order@1>"
      }
    ]
  },
  {
    "id": "core:CoreRegistryManifest@1",
    "fields": [
      {
        "name": "registry_contract_version",
        "optional": false,
        "type": "SemVer"
      },
      {
        "name": "definitions",
        "optional": false,
        "type": "OrderedSet<CoreRegistryDefinition, core:registry_definition_order@1>"
      }
    ]
  },
  {
    "id": "core:CoreRegistryDefinition@1",
    "fields": [
      {
        "name": "registry_type",
        "optional": false,
        "type": "NamespacedIdentifier"
      },
      {
        "name": "definition_id",
        "optional": false,
        "type": "NamespacedIdentifier"
      },
      {
        "name": "definition_revision",
        "optional": false,
        "type": "PositiveInteger"
      },
      {
        "name": "schema_id",
        "optional": false,
        "type": "NamespacedIdentifier"
      },
      {
        "name": "schema_version",
        "optional": false,
        "type": "PositiveInteger"
      },
      {
        "name": "definition_bytes",
        "optional": false,
        "type": "SchemaBoundBytes"
      }
    ]
  },
  {
    "id": "core:CandidateRegistryState@1",
    "fields": [
      {
        "name": "registry_contract_version",
        "optional": false,
        "type": "SemVer"
      },
      {
        "name": "core_registry_digest",
        "optional": false,
        "type": "Digest"
      },
      {
        "name": "candidate_resolution_lock_id",
        "optional": false,
        "type": "Identifier"
      },
      {
        "name": "namespace_owners",
        "optional": false,
        "type": "OrderedSet<CandidateNamespaceOwner, core:namespace_owner_order@1>"
      }
    ]
  },
  {
    "id": "core:CompatibilityRequirementValue@1",
    "fields": [
      {
        "name": "requirement_schema_id",
        "optional": false,
        "type": "NamespacedIdentifier"
      },
      {
        "name": "requirement_schema_version",
        "optional": false,
        "type": "PositiveInteger"
      },
      {
        "name": "requirement_value",
        "optional": false,
        "type": "SchemaBoundBytes"
      }
    ]
  },
  {
    "id": "core:ArtifactPartitionKey@1",
    "fields": [
      {
        "name": "workspace_id",
        "optional": false,
        "type": "Identifier"
      },
      {
        "name": "artifact_id",
        "optional": false,
        "type": "Identifier"
      },
      {
        "name": "artifact_version_id",
        "optional": false,
        "type": "Identifier"
      }
    ]
  },
  {
    "id": "core:CallablePartitionKey@1",
    "fields": [
      {
        "name": "workspace_id",
        "optional": false,
        "type": "Identifier"
      },
      {
        "name": "callable_entity_id",
        "optional": false,
        "type": "Identifier"
      },
      {
        "name": "callable_record_id",
        "optional": false,
        "type": "Identifier"
      }
    ]
  },
  {
    "id": "core:FrameworkPartitionKey@1",
    "fields": [
      {
        "name": "workspace_id",
        "optional": false,
        "type": "Identifier"
      },
      {
        "name": "framework_id",
        "optional": false,
        "type": "NamespacedIdentifier"
      },
      {
        "name": "project_partition_id",
        "optional": false,
        "type": "Identifier"
      }
    ]
  },
  {
    "id": "core:ProjectPartitionKey@1",
    "fields": [
      {
        "name": "workspace_id",
        "optional": false,
        "type": "Identifier"
      },
      {
        "name": "project_partition_id",
        "optional": false,
        "type": "Identifier"
      }
    ]
  },
  {
    "id": "core:FrozenCandidateDigestInputs@1",
    "fields": [
      {
        "name": "accepted_fact_delta_digests",
        "optional": false,
        "type": "Set<Digest>"
      },
      {
        "name": "materialization_digest",
        "optional": false,
        "type": "Digest"
      }
    ]
  },
  {
    "id": "core:ArtifactAnalysisContext@1",
    "fields": [
      {
        "name": "registry_snapshot_id",
        "optional": false,
        "type": "Identifier"
      },
      {
        "name": "configuration_revision_id",
        "optional": false,
        "type": "Identifier"
      },
      {
        "name": "dependency_plugin_digests",
        "optional": false,
        "type": "Set<Digest>"
      },
      {
        "name": "analysis_configuration_digest",
        "optional": false,
        "type": "Digest"
      }
    ]
  },
  {
    "id": "core:ProjectionSetDigestItem@1",
    "fields": [
      {
        "name": "projection_record_id",
        "optional": false,
        "type": "Identifier"
      },
      {
        "name": "content_digest",
        "optional": false,
        "type": "Digest"
      }
    ]
  },
  {
    "id": "core:QueryableVectorDigestEntry@1",
    "fields": [
      {
        "name": "projection_record_id",
        "optional": false,
        "type": "Identifier"
      },
      {
        "name": "vector_digest",
        "optional": false,
        "type": "Digest"
      }
    ]
  },
  {
    "id": "core:RecordSetDigestEntry@1",
    "fields": [
      {
        "name": "record_id",
        "optional": false,
        "type": "Identifier"
      },
      {
        "name": "record_digest",
        "optional": false,
        "type": "Digest"
      }
    ]
  },
  {
    "id": "core:RetentionRootReference@1",
    "fields": [
      {
        "name": "root_type",
        "optional": false,
        "type": "current_snapshot | snapshot_pin | snapshot_lease | query_execution | index_status_execution | index_candidate | recovery_operation | recovery_checkpoint | active_configuration | model_pack_installation"
      },
      {
        "name": "root_id",
        "optional": false,
        "type": "Identifier"
      },
      {
        "name": "workspace_id",
        "optional": true,
        "type": "Identifier"
      }
    ]
  },
  {
    "id": "core:StoredObjectReference@1",
    "fields": [
      {
        "name": "object_type",
        "optional": false,
        "type": "NamespacedIdentifier"
      },
      {
        "name": "object_id",
        "optional": false,
        "type": "Identifier"
      },
      {
        "name": "content_digest",
        "optional": true,
        "type": "Digest"
      }
    ]
  },
  {
    "id": "core:VisibleSourceStateSet@1",
    "fields": []
  },
  {
    "id": "core:NormalizedResponseBudget@1",
    "fields": [
      {
        "name": "max_items",
        "optional": false,
        "type": "PositiveInteger"
      },
      {
        "name": "max_characters",
        "optional": false,
        "type": "PositiveInteger"
      }
    ]
  },
  {
    "id": "core:NormalizedResultProjection@1",
    "fields": [
      {
        "name": "evidence",
        "optional": false,
        "type": "EvidenceIncludeOptions"
      },
      {
        "name": "diagnostics",
        "optional": false,
        "type": "DiagnosticIncludeOptions"
      },
      {
        "name": "snippets",
        "optional": false,
        "type": "SourceIncludeOptions"
      },
      {
        "name": "registry",
        "optional": false,
        "type": "RegistryIncludeOptions"
      }
    ]
  },
  {
    "id": "core:NormalizedIndexStatusProjection@1",
    "fields": [
      {
        "name": "include_capabilities",
        "optional": false,
        "type": "Boolean"
      },
      {
        "name": "include_plugins",
        "optional": false,
        "type": "Boolean"
      },
      {
        "name": "include_activation_issues",
        "optional": false,
        "type": "Boolean"
      },
      {
        "name": "include_candidate_issues",
        "optional": false,
        "type": "Boolean"
      }
    ]
  },
  {
    "id": "core:NormalizedQueryPlan@1",
    "fields": [
      {
        "name": "api_version",
        "optional": false,
        "type": "SemVer"
      },
      {
        "name": "scope",
        "optional": false,
        "type": "QueryScope"
      },
      {
        "name": "normalized_expression",
        "optional": false,
        "type": "QueryExpression"
      },
      {
        "name": "freshness",
        "optional": false,
        "type": "snapshot | current | wait_for_current"
      },
      {
        "name": "wait_timeout_ms",
        "optional": false,
        "type": "Count"
      },
      {
        "name": "coverage_requirement",
        "optional": false,
        "type": "accept_reported | require_complete"
      },
      {
        "name": "projection",
        "optional": false,
        "type": "NormalizedResultProjection"
      },
      {
        "name": "response_budget",
        "optional": false,
        "type": "NormalizedResponseBudget"
      },
      {
        "name": "operation_versions",
        "optional": false,
        "type": "OrderedSet<OperationVersionBinding, core:operation_id_order@1>"
      },
      {
        "name": "recipe_versions",
        "optional": false,
        "type": "OrderedSet<RecipeVersionBinding, core:recipe_id_order@1>"
      }
    ]
  },
  {
    "id": "core:RecipeStaticArguments@1",
    "fields": [
      {
        "name": "operation_id",
        "optional": false,
        "type": "NamespacedIdentifier"
      },
      {
        "name": "operation_version",
        "optional": false,
        "type": "PositiveInteger"
      },
      {
        "name": "partial_arguments_schema_id",
        "optional": false,
        "type": "NamespacedIdentifier"
      },
      {
        "name": "partial_arguments_schema_version",
        "optional": false,
        "type": "PositiveInteger"
      },
      {
        "name": "partial_arguments",
        "optional": false,
        "type": "SchemaBoundBytes"
      }
    ]
  },
  {
    "id": "core:LocateImplementationArguments@1",
    "fields": [
      {
        "name": "query_text",
        "optional": false,
        "type": "Text"
      },
      {
        "name": "query_class",
        "optional": true,
        "type": "natural_text | identifier | source_code | mixed"
      },
      {
        "name": "filter",
        "optional": true,
        "type": "StructuralFilter"
      }
    ]
  },
  {
    "id": "core:UnderstandChangeImpactArguments@1",
    "fields": [
      {
        "name": "target",
        "optional": false,
        "type": "SubjectSelector"
      },
      {
        "name": "change",
        "optional": false,
        "type": "ChangeDescriptor"
      },
      {
        "name": "include_transitive",
        "optional": true,
        "type": "Boolean"
      },
      {
        "name": "include_tests",
        "optional": true,
        "type": "Boolean"
      },
      {
        "name": "filter",
        "optional": true,
        "type": "StructuralFilter"
      }
    ]
  },
  {
    "id": "core:PrepareSymbolChangeArguments@1",
    "fields": [
      {
        "name": "reference",
        "optional": false,
        "type": "Text"
      },
      {
        "name": "context_artifact",
        "optional": true,
        "type": "Identifier"
      },
      {
        "name": "context_byte_offset",
        "optional": true,
        "type": "Count"
      },
      {
        "name": "kind_selector",
        "optional": true,
        "type": "KindSelector"
      },
      {
        "name": "change",
        "optional": false,
        "type": "ChangeDescriptor"
      },
      {
        "name": "filter",
        "optional": true,
        "type": "StructuralFilter"
      }
    ]
  },
  {
    "id": "core:PrepareNewFeatureArguments@1",
    "fields": [
      {
        "name": "task",
        "optional": false,
        "type": "Text"
      },
      {
        "name": "query_class",
        "optional": true,
        "type": "natural_text | identifier | source_code | mixed"
      },
      {
        "name": "filter",
        "optional": true,
        "type": "StructuralFilter"
      }
    ]
  },
  {
    "id": "core:TraceBehaviorArguments@1",
    "fields": [
      {
        "name": "subjects",
        "optional": false,
        "type": "Sequence<SubjectSelector>"
      },
      {
        "name": "direction",
        "optional": true,
        "type": "inbound | outbound | both"
      },
      {
        "name": "relations",
        "optional": true,
        "type": "RelationSelector"
      },
      {
        "name": "max_depth",
        "optional": true,
        "type": "PositiveInteger"
      },
      {
        "name": "filter",
        "optional": true,
        "type": "StructuralFilter"
      }
    ]
  },
  {
    "id": "core:FindRelevantTestsArguments@1",
    "fields": [
      {
        "name": "subjects",
        "optional": false,
        "type": "Sequence<SubjectSelector>"
      },
      {
        "name": "relationship_scope",
        "optional": true,
        "type": "direct | transitive | both"
      },
      {
        "name": "include_fixtures",
        "optional": true,
        "type": "Boolean"
      },
      {
        "name": "filter",
        "optional": true,
        "type": "StructuralFilter"
      }
    ]
  },
  {
    "id": "core:ExplainArchitectureSliceArguments@1",
    "fields": [
      {
        "name": "scope",
        "optional": true,
        "type": "Sequence<SubjectSelector>"
      },
      {
        "name": "views",
        "optional": true,
        "type": "Set<entry_points | boundaries | public_surfaces | cycles | extension_points | layers>"
      },
      {
        "name": "max_relation_depth",
        "optional": true,
        "type": "PositiveInteger"
      },
      {
        "name": "filter",
        "optional": true,
        "type": "StructuralFilter"
      }
    ]
  },
  {
    "id": "core:CompareWorkspacesArguments@1",
    "fields": [
      {
        "name": "selection",
        "optional": true,
        "type": "Sequence<SubjectSelector>"
      },
      {
        "name": "comparison_kinds",
        "optional": true,
        "type": "Set<added | removed | changed | moved | correlated>"
      },
      {
        "name": "correlation_policy",
        "optional": true,
        "type": "strict | include_possible"
      },
      {
        "name": "filter",
        "optional": true,
        "type": "StructuralFilter"
      }
    ]
  },
  {
    "id": "core:SemanticToCallersArguments@1",
    "fields": [
      {
        "name": "query_text",
        "optional": false,
        "type": "Text"
      },
      {
        "name": "query_class",
        "optional": true,
        "type": "natural_text | identifier | source_code | mixed"
      },
      {
        "name": "max_call_depth",
        "optional": true,
        "type": "PositiveInteger"
      },
      {
        "name": "filter",
        "optional": true,
        "type": "StructuralFilter"
      }
    ]
  },
  {
    "id": "core:ResolveAndFindReferencesArguments@1",
    "fields": [
      {
        "name": "reference",
        "optional": false,
        "type": "Text"
      },
      {
        "name": "context_artifact",
        "optional": true,
        "type": "Identifier"
      },
      {
        "name": "context_byte_offset",
        "optional": true,
        "type": "Count"
      },
      {
        "name": "kind_selector",
        "optional": true,
        "type": "KindSelector"
      },
      {
        "name": "reference_roles",
        "optional": true,
        "type": "Set<NamespacedIdentifier>"
      },
      {
        "name": "include_declarations",
        "optional": true,
        "type": "Boolean"
      },
      {
        "name": "filter",
        "optional": true,
        "type": "StructuralFilter"
      }
    ]
  },
  {
    "id": "core:DefinitionToInstancesArguments@1",
    "fields": [
      {
        "name": "matcher",
        "optional": false,
        "type": "DefinitionMatcher"
      },
      {
        "name": "selector",
        "optional": true,
        "type": "RegistrySelector"
      },
      {
        "name": "record_categories",
        "optional": true,
        "type": "Set<entity | relation | fact | evidence | diagnostic>"
      },
      {
        "name": "producer_ids",
        "optional": true,
        "type": "Set<NamespacedIdentifier>"
      },
      {
        "name": "filter",
        "optional": true,
        "type": "StructuralFilter"
      }
    ]
  }
];
