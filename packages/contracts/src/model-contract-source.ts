/** Generated from packages/contracts/src/models.ts, schema-ir.ts, and their closed union declarations. */
export interface ModelSourceField { readonly name: string; readonly presence: "required" | "optional"; readonly logical_type: string; }
export const authoritativeModelSourceFields = {
  "Codebase": [
    {
      "name": "codebase_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "display_name",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "vcs_identity",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "created_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "removed_at",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "Workspace": [
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "codebase_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "canonical_root",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "display_root",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_provider_bindings",
      "presence": "required",
      "logical_type": "Sequence<WorkspaceSourceProviderBinding>"
    },
    {
      "name": "current_snapshot_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "status",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "vcs_state",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "registered_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "relocated_at",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "suspended_at",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "removed_at",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "WorkspaceConfigurationRevision": [
    {
      "name": "configuration_revision_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "parent_configuration_revision_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "effective_configuration_schema_id",
      "presence": "required",
      "logical_type": "NamespacedIdentifier"
    },
    {
      "name": "effective_configuration_schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "effective_configuration",
      "presence": "required",
      "logical_type": "Uint8Array"
    },
    {
      "name": "installation_policy_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "user_policy_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "workspace_file_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "administrative_override_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "analysis_configuration_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "query_configuration_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "resolved_embedding_binding_digests",
      "presence": "required",
      "logical_type": "Sequence<Digest>"
    },
    {
      "name": "created_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "reason_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "revision_digest",
      "presence": "required",
      "logical_type": "Digest"
    }
  ],
  "WorkspaceSourceProviderBinding": [
    {
      "name": "source_provider_binding_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_provider",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_provider_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "provider_role",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "binding_identity",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "configuration_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "VcsState": [
    {
      "name": "provider",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "common_repository_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "head_revision",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "ref_kind",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "ref_name",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "detached",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "dirty",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "captured_at",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "Snapshot": [
    {
      "name": "snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "parent_snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generation_manifest_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "registry_snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "resolution_lock_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "configuration_revision_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_state_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_snapshot_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "snapshot_contract_version",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "publication_stage_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "publication_stage_ordinal",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "publication_stage_count",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "source_observation_watermarks",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "canonical_record_set_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "projection_set_digests",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "capability_state_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "published_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "snapshot_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "WorkspaceCurrentState": [
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "current_snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "current_generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "current_registry_snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "current_resolution_lock_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "current_configuration_revision_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "current_freshness_checkpoint_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "state_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "updated_at",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "WorkspaceFreshnessCheckpoint": [
    {
      "name": "freshness_checkpoint_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_state_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "provider_watermarks",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "verification_status",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "unavailable_artifact_ids",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "verified_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "checkpoint_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ProviderWatermark": [
    {
      "name": "source_provider_binding_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_provider",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_provider_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "ordering_domain",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "watermark_value",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "watermark_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ProjectionSetDigestEntry": [
    {
      "name": "projection_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator_configuration_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "projection_set_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SnapshotCapabilityStateEntry": [
    {
      "name": "capability",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "capability_contract_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "provider_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "provider_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "status",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "reason_codes",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "affected_artifact_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "diagnostic_record_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "publication_stage_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "publication_stage_ordinal",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "publication_stage_count",
      "presence": "optional",
      "logical_type": "Count"
    }
  ],
  "OrderedSetDescriptor": [
    {
      "name": "descriptor_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "element_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "element_schema_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "comparator_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "comparator_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "entry_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "content_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "CanonicalSchemaDefinition": [
    {
      "name": "schema_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "root_type",
      "presence": "required",
      "logical_type": "CanonicalTypeExpression"
    },
    {
      "name": "type_definitions",
      "presence": "required",
      "logical_type": "Sequence<CanonicalNamedTypeDefinition>"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "LifecycleState"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "replacement_schema",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "CanonicalNamedTypeDefinition": [
    {
      "name": "type_name",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "type_expression",
      "presence": "required",
      "logical_type": "CanonicalTypeExpression"
    }
  ],
  "CanonicalTypeExpression": [
    {
      "name": "type_kind",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "NullTypeExpression": [
    {
      "name": "type_kind",
      "presence": "required",
      "logical_type": "null"
    }
  ],
  "BooleanTypeExpression": [
    {
      "name": "type_kind",
      "presence": "required",
      "logical_type": "boolean"
    }
  ],
  "SafeIntegerTypeExpression": [
    {
      "name": "type_kind",
      "presence": "required",
      "logical_type": "safe_integer"
    },
    {
      "name": "minimum",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "maximum",
      "presence": "optional",
      "logical_type": "Count"
    }
  ],
  "BigIntegerTypeExpression": [
    {
      "name": "type_kind",
      "presence": "required",
      "logical_type": "big_integer"
    },
    {
      "name": "minimum",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "maximum",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "Float64TypeExpression": [
    {
      "name": "type_kind",
      "presence": "required",
      "logical_type": "float64"
    },
    {
      "name": "minimum",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "maximum",
      "presence": "optional",
      "logical_type": "Count"
    }
  ],
  "ExactDecimalTypeExpression": [
    {
      "name": "type_kind",
      "presence": "required",
      "logical_type": "exact_decimal"
    },
    {
      "name": "minimum",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "maximum",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "scale_policy",
      "presence": "required",
      "logical_type": "significant | insignificant"
    }
  ],
  "TextTypeExpression": [
    {
      "name": "type_kind",
      "presence": "required",
      "logical_type": "text"
    },
    {
      "name": "identifier_kind",
      "presence": "optional",
      "logical_type": "identifier | namespaced_identifier | semver | uri"
    },
    {
      "name": "minimum_code_point_count",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "maximum_code_point_count",
      "presence": "optional",
      "logical_type": "Count"
    }
  ],
  "BytesTypeExpression": [
    {
      "name": "type_kind",
      "presence": "required",
      "logical_type": "bytes"
    },
    {
      "name": "minimum_byte_length",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "maximum_byte_length",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "bound_schema_id_field",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "bound_schema_version_field",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "TimestampTypeExpression": [
    {
      "name": "type_kind",
      "presence": "required",
      "logical_type": "timestamp"
    },
    {
      "name": "earliest",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "latest",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "DigestTypeExpression": [
    {
      "name": "type_kind",
      "presence": "required",
      "logical_type": "digest"
    },
    {
      "name": "allowed_hash_algorithms",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "EnumTypeExpression": [
    {
      "name": "type_kind",
      "presence": "required",
      "logical_type": "enum"
    },
    {
      "name": "values",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "SequenceTypeExpression": [
    {
      "name": "type_kind",
      "presence": "required",
      "logical_type": "sequence"
    },
    {
      "name": "element_type",
      "presence": "required",
      "logical_type": "CanonicalTypeExpression"
    },
    {
      "name": "minimum_item_count",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "maximum_item_count",
      "presence": "optional",
      "logical_type": "Count"
    }
  ],
  "SetTypeExpression": [
    {
      "name": "type_kind",
      "presence": "required",
      "logical_type": "set"
    },
    {
      "name": "element_type",
      "presence": "required",
      "logical_type": "CanonicalTypeExpression"
    },
    {
      "name": "minimum_item_count",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "maximum_item_count",
      "presence": "optional",
      "logical_type": "Count"
    }
  ],
  "OrderedSetTypeExpression": [
    {
      "name": "type_kind",
      "presence": "required",
      "logical_type": "ordered_set"
    },
    {
      "name": "element_type",
      "presence": "required",
      "logical_type": "CanonicalTypeExpression"
    },
    {
      "name": "comparator_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "comparator_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "minimum_item_count",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "maximum_item_count",
      "presence": "optional",
      "logical_type": "Count"
    }
  ],
  "MapTypeExpression": [
    {
      "name": "type_kind",
      "presence": "required",
      "logical_type": "map"
    },
    {
      "name": "value_type",
      "presence": "required",
      "logical_type": "CanonicalTypeExpression"
    },
    {
      "name": "minimum_entry_count",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "maximum_entry_count",
      "presence": "optional",
      "logical_type": "Count"
    }
  ],
  "RecordTypeExpression": [
    {
      "name": "type_kind",
      "presence": "required",
      "logical_type": "record"
    },
    {
      "name": "fields",
      "presence": "required",
      "logical_type": "Sequence<SchemaFieldDefinition>"
    }
  ],
  "UnionTypeExpression": [
    {
      "name": "type_kind",
      "presence": "required",
      "logical_type": "union"
    },
    {
      "name": "discriminator_field",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "discriminator_description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "variants",
      "presence": "required",
      "logical_type": "Sequence<SchemaVariantDefinition>"
    }
  ],
  "SchemaReferenceTypeExpression": [
    {
      "name": "type_kind",
      "presence": "required",
      "logical_type": "schema_reference"
    },
    {
      "name": "reference_scope",
      "presence": "required",
      "logical_type": "local | external"
    },
    {
      "name": "type_name",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "schema_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "schema_version",
      "presence": "optional",
      "logical_type": "Count"
    }
  ],
  "SchemaFieldDefinition": [
    {
      "name": "field_name",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "presence",
      "presence": "required",
      "logical_type": "Presence"
    },
    {
      "name": "value_type",
      "presence": "required",
      "logical_type": "CanonicalTypeExpression"
    }
  ],
  "SchemaVariantDefinition": [
    {
      "name": "discriminator_value",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "fields",
      "presence": "required",
      "logical_type": "Sequence<SchemaFieldDefinition>"
    }
  ],
  "HashAlgorithmDefinition": [
    {
      "name": "hash_algorithm",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "digest_byte_length",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "specification_uri",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_hash_algorithm",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "DigestDomainDefinition": [
    {
      "name": "digest_domain",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_digest_domain",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "CanonicalComparatorDefinition": [
    {
      "name": "comparator_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "comparator_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "sort_keys",
      "presence": "required",
      "logical_type": "Sequence<CanonicalComparatorSortKey>"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_comparator",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "CanonicalComparatorSortKey": [
    {
      "name": "value_path",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "comparison_mode",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "direction",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "absent_order",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ExternalVerificationContractDefinition": [
    {
      "name": "external_verification_contract_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "contract_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "verified_input_schema_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "verified_input_schema_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "terminal_digest_recipe_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "terminal_digest_recipe_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "verification_semantics",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_external_verification_contract",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "RuntimeComponentDefinition": [
    {
      "name": "component_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "component_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "component_contracts",
      "presence": "required",
      "logical_type": "Sequence<RuntimeComponentContractBinding>"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "behavior_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_component",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "RuntimeComponentContractBinding": [
    {
      "name": "component_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "contract_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "configuration_schema_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "configuration_schema_version",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "RuntimeComponentBuild": [
    {
      "name": "runtime_component_build_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "component_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "component_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "behavior_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "implementation_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "available_from",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "selectable_to",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "removed_at",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "DigestRecipeDefinition": [
    {
      "name": "digest_recipe_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "recipe_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "target_schema_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "target_schema_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "target_field",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "digest_domain",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "canonical_encoding_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "hash_algorithm",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "payload_schema_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "payload_schema_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "verified_input_schema_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "verified_input_schema_version",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "payload_binding",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_digest_recipe",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "DigestComputationContext": [
    {
      "name": "target",
      "presence": "required",
      "logical_type": "JsonValue"
    },
    {
      "name": "verified_input",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "DigestPayloadBinding": [
    {
      "name": "binding_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_path",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "field_bindings",
      "presence": "optional",
      "logical_type": "Sequence<DigestPayloadFieldBinding>"
    }
  ],
  "ScalarDigestPayloadBinding": [
    {
      "name": "binding_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_path",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "RecordDigestPayloadBinding": [
    {
      "name": "binding_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "field_bindings",
      "presence": "required",
      "logical_type": "Sequence<DigestPayloadFieldBinding>"
    }
  ],
  "DigestPayloadFieldBinding": [
    {
      "name": "payload_field",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_path",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "value_mode",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "referenced_digest_recipe_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "referenced_digest_recipe_version",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "DigestReferenceDefinition": [
    {
      "name": "digest_reference_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "target_schema_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "target_schema_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "target_field",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_digest_recipe_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_digest_recipe_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "reference_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "locator_bindings",
      "presence": "required",
      "logical_type": "Sequence<DigestLocatorBinding>"
    },
    {
      "name": "external_verification_contract_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "external_verification_contract_version",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_digest_reference",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "DigestLocatorBinding": [
    {
      "name": "target_source_path",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_key_path",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "CanonicalEncodingErrorCodeDefinition": [
    {
      "name": "code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "allowed_phases",
      "presence": "required",
      "logical_type": "Sequence<decode | normalize | schema_validation | recipe_validation | hash | verify>"
    },
    {
      "name": "details_schema",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_code",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "CanonicalEncodingConformanceCase": [
    {
      "name": "case_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "corpus_revision",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "input_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "logical_input",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "encoded_input_hex",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "schema_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "digest_recipe_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "recipe_version",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "expected_outcome",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "expected_cbor_hex",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "expected_digest_text",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "expected_error_code",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "SourceProvider": [
    {
      "name": "component_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "component_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "describe",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "enumerate",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "read",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "watch",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "reconcile",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SourceProviderRequestEnvelope": [
    {
      "name": "protocol_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "request_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "request_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "call",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_provider_binding_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "component_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "component_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deadline_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "cancellation_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "resource_budget",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "payload",
      "presence": "required",
      "logical_type": "JsonValue"
    }
  ],
  "SourceProviderResponseEnvelope": [
    {
      "name": "protocol_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "request_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "request_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "call",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_provider_binding_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "component_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "component_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "outcome",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "payload",
      "presence": "optional",
      "logical_type": "JsonValue"
    },
    {
      "name": "error",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "SourceProviderDescribeRequest": [
    {
      "name": "binding_configuration_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SourceProviderDescribeResult": [
    {
      "name": "provider_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "immutable_binding_identity",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "features",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_state_fingerprint",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SourceProviderEnumerateRequest": [
    {
      "name": "coverage_scopes",
      "presence": "required",
      "logical_type": "Sequence<ObservationCoverageScope>"
    },
    {
      "name": "previous_watermark",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "SourceProviderEnumerateResult": [
    {
      "name": "observation_batch",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "watermark",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "capture_start_fingerprint",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "capture_end_fingerprint",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SourceProviderReadRequest": [
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "normalized_uri",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "observed_content_hash",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "observed_metadata_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "provider_version_token",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SourceProviderReadResult": [
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "provider_version_token",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "content_bytes",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "content_hash",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "byte_length",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "metadata_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SourceProviderWatchRequest": [
    {
      "name": "after_watermark",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "coverage_scopes",
      "presence": "required",
      "logical_type": "Sequence<ObservationCoverageScope>"
    },
    {
      "name": "max_wait_ms",
      "presence": "required",
      "logical_type": "Count"
    }
  ],
  "SourceProviderWatchResult": [
    {
      "name": "events",
      "presence": "required",
      "logical_type": "Sequence<SourceProviderWatchEvent>"
    },
    {
      "name": "watermark",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SourceProviderWatchEvent": [
    {
      "name": "ordering_domain",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "event_token",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "provider_sequence",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "event_class",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "normalized_uri",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "authority",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SourceProviderReconcileRequest": [
    {
      "name": "coverage_scopes",
      "presence": "required",
      "logical_type": "Sequence<ObservationCoverageScope>"
    },
    {
      "name": "previous_watermark",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "SourceProviderReconcileResult": [
    {
      "name": "observation_batch",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "watermark",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "capture_start_fingerprint",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "capture_end_fingerprint",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "stable",
      "presence": "required",
      "logical_type": "Boolean"
    }
  ],
  "SourceProviderResourceBudget": [
    {
      "name": "max_duration_ms",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "max_response_bytes",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "max_observations",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "max_watch_events",
      "presence": "required",
      "logical_type": "Count"
    }
  ],
  "SourceProviderFeatureSet": [
    {
      "name": "supports_watch",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "supports_authoritative_delete_events",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "supports_complete_enumeration",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "supports_stable_reconciliation",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "supports_virtual_artifacts",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "case_behavior",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "read_only",
      "presence": "required",
      "logical_type": "Boolean"
    }
  ],
  "SourceProviderError": [
    {
      "name": "error_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "retryability",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "detail_code",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "AnalysisRelevantArtifactMetadata": [
    {
      "name": "metadata_schema_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "metadata_schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "normalized_metadata",
      "presence": "required",
      "logical_type": "Uint8Array"
    }
  ],
  "AnalysisConfiguration": [
    {
      "name": "configuration_schema_id",
      "presence": "required",
      "logical_type": "NamespacedIdentifier"
    },
    {
      "name": "configuration_schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "normalized_configuration",
      "presence": "required",
      "logical_type": "Uint8Array"
    }
  ],
  "QueryConfiguration": [
    {
      "name": "configuration_schema_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "configuration_schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "normalized_configuration",
      "presence": "required",
      "logical_type": "Uint8Array"
    }
  ],
  "GeneratorConfiguration": [
    {
      "name": "configuration_schema_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "configuration_schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "normalized_configuration",
      "presence": "required",
      "logical_type": "Uint8Array"
    }
  ],
  "SourceProviderConfiguration": [
    {
      "name": "configuration_schema_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "configuration_schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "normalized_configuration",
      "presence": "required",
      "logical_type": "Uint8Array"
    }
  ],
  "NormalizedConfigurationLayer": [
    {
      "name": "layer_kind",
      "presence": "required",
      "logical_type": "installation_policy | user_policy | workspace_file | administrative_override"
    },
    {
      "name": "configuration_schema_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "configuration_schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "normalized_configuration",
      "presence": "required",
      "logical_type": "Uint8Array"
    }
  ],
  "AnalyzerImplementationManifest": [
    {
      "name": "plugin_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analyzer_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analyzer_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "executable_asset_digests",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "parser_asset_digests",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "rule_asset_digests",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "model_asset_digests",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "dependency_asset_digests",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "supported_capabilities",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "RuntimeComponentBehaviorManifest": [
    {
      "name": "component_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "component_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "component_kind",
      "presence": "required",
      "logical_type": "source_provider | projection_generator | embedding_renderer | embedding_segmenter | embedding_generator"
    },
    {
      "name": "contract_bindings",
      "presence": "required",
      "logical_type": "Sequence<RuntimeComponentContractBinding>"
    },
    {
      "name": "configuration_schema_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "algorithm_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "supported_format_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "deterministic_numeric_contract",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "portable_behavior_rules",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "RuntimeComponentImplementationManifest": [
    {
      "name": "runtime_component_build_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "component_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "component_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "behavior_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "target_triple",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "executable_asset_digests",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "native_asset_digests",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "dependency_asset_digests",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "PluginPackageManifest": [
    {
      "name": "package_format_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "package_format_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "plugin_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "package_files",
      "presence": "required",
      "logical_type": "Sequence<PackageFileEntry>"
    }
  ],
  "PackageFileEntry": [
    {
      "name": "normalized_relative_path",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "content_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "byte_length",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "executable",
      "presence": "required",
      "logical_type": "Boolean"
    }
  ],
  "CoreRegistryManifest": [
    {
      "name": "registry_contract_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definitions",
      "presence": "required",
      "logical_type": "Sequence<CoreRegistryDefinition>"
    }
  ],
  "CoreRegistryDefinition": [
    {
      "name": "registry_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "definition_bytes",
      "presence": "required",
      "logical_type": "Uint8Array"
    }
  ],
  "CandidateRegistryState": [
    {
      "name": "registry_contract_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "core_registry_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "candidate_resolution_lock_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "namespace_owners",
      "presence": "required",
      "logical_type": "Sequence<CandidateNamespaceOwner>"
    }
  ],
  "CandidateNamespaceOwner": [
    {
      "name": "namespace",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "contribution_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "CompatibilityRequirementValue": [
    {
      "name": "requirement_schema_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "requirement_schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "requirement_value",
      "presence": "required",
      "logical_type": "Uint8Array"
    }
  ],
  "ArtifactPartitionKey": [
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "CallablePartitionKey": [
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "callable_entity_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "callable_record_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "FrameworkPartitionKey": [
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "framework_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "project_partition_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ProjectPartitionKey": [
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "project_partition_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "FrozenCandidateDigestInputs": [
    {
      "name": "accepted_fact_delta_digests",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "materialization_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ArtifactAnalysisContext": [
    {
      "name": "registry_snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "configuration_revision_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "dependency_plugin_digests",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "analysis_configuration_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ProjectionSetDigestItem": [
    {
      "name": "projection_record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "content_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "QueryableVectorDigestEntry": [
    {
      "name": "projection_record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "vector_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "RecordSetDigestEntry": [
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "record_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "RetentionRootReference": [
    {
      "name": "root_type",
      "presence": "required",
      "logical_type": "current_snapshot | snapshot_pin | snapshot_lease | query_execution | index_status_execution | index_candidate | recovery_operation | recovery_checkpoint | active_configuration | model_pack_installation"
    },
    {
      "name": "root_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "StoredObjectReference": [
    {
      "name": "object_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "object_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "content_digest",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "VisibleSourceStateSet": [
    {
      "name": "entries",
      "presence": "required",
      "logical_type": "Sequence<VisibleSourceStateEntry>"
    }
  ],
  "NormalizedResponseBudget": [
    {
      "name": "max_items",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "max_characters",
      "presence": "required",
      "logical_type": "Count"
    }
  ],
  "NormalizedResultProjection": [
    {
      "name": "evidence",
      "presence": "required",
      "logical_type": "EvidenceIncludeOptions"
    },
    {
      "name": "diagnostics",
      "presence": "required",
      "logical_type": "DiagnosticIncludeOptions"
    },
    {
      "name": "snippets",
      "presence": "required",
      "logical_type": "SourceIncludeOptions"
    },
    {
      "name": "registry",
      "presence": "required",
      "logical_type": "RegistryIncludeOptions"
    }
  ],
  "NormalizedIndexStatusProjection": [
    {
      "name": "include_capabilities",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "include_plugins",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "include_activation_issues",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "include_candidate_issues",
      "presence": "required",
      "logical_type": "Boolean"
    }
  ],
  "NormalizedQueryPlan": [
    {
      "name": "api_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "scope",
      "presence": "required",
      "logical_type": "QueryScope"
    },
    {
      "name": "normalized_expression",
      "presence": "required",
      "logical_type": "QueryExpression"
    },
    {
      "name": "freshness",
      "presence": "required",
      "logical_type": "snapshot | current | wait_for_current"
    },
    {
      "name": "wait_timeout_ms",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "coverage_requirement",
      "presence": "required",
      "logical_type": "accept_reported | require_complete"
    },
    {
      "name": "projection",
      "presence": "required",
      "logical_type": "NormalizedResultProjection"
    },
    {
      "name": "response_budget",
      "presence": "required",
      "logical_type": "NormalizedResponseBudget"
    },
    {
      "name": "operation_versions",
      "presence": "required",
      "logical_type": "Sequence<OperationVersionBinding>"
    },
    {
      "name": "recipe_versions",
      "presence": "required",
      "logical_type": "Sequence<RecipeVersionBinding>"
    }
  ],
  "OperationVersionBinding": [
    {
      "name": "operation_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "operation_version",
      "presence": "required",
      "logical_type": "Count"
    }
  ],
  "RecipeVersionBinding": [
    {
      "name": "recipe_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "recipe_version",
      "presence": "required",
      "logical_type": "Count"
    }
  ],
  "RecipeStaticArguments": [
    {
      "name": "operation_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "operation_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "partial_arguments_schema_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "partial_arguments_schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "partial_arguments",
      "presence": "required",
      "logical_type": "Uint8Array"
    }
  ],
  "LocateImplementationArguments": [
    {
      "name": "query_text",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "query_class",
      "presence": "optional",
      "logical_type": "natural_text | identifier | source_code | mixed"
    },
    {
      "name": "filter",
      "presence": "optional",
      "logical_type": "StructuralFilter"
    }
  ],
  "UnderstandChangeImpactArguments": [
    {
      "name": "target",
      "presence": "required",
      "logical_type": "SubjectSelector"
    },
    {
      "name": "change",
      "presence": "required",
      "logical_type": "ChangeDescriptor"
    },
    {
      "name": "include_transitive",
      "presence": "optional",
      "logical_type": "Boolean"
    },
    {
      "name": "include_tests",
      "presence": "optional",
      "logical_type": "Boolean"
    },
    {
      "name": "filter",
      "presence": "optional",
      "logical_type": "StructuralFilter"
    }
  ],
  "PrepareSymbolChangeArguments": [
    {
      "name": "reference",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "context_artifact",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "context_byte_offset",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "kind_selector",
      "presence": "optional",
      "logical_type": "KindSelector"
    },
    {
      "name": "change",
      "presence": "required",
      "logical_type": "ChangeDescriptor"
    },
    {
      "name": "filter",
      "presence": "optional",
      "logical_type": "StructuralFilter"
    }
  ],
  "PrepareNewFeatureArguments": [
    {
      "name": "task",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "query_class",
      "presence": "optional",
      "logical_type": "natural_text | identifier | source_code | mixed"
    },
    {
      "name": "filter",
      "presence": "optional",
      "logical_type": "StructuralFilter"
    }
  ],
  "TraceBehaviorArguments": [
    {
      "name": "subjects",
      "presence": "required",
      "logical_type": "Sequence<SubjectSelector>"
    },
    {
      "name": "direction",
      "presence": "optional",
      "logical_type": "inbound | outbound | both"
    },
    {
      "name": "relations",
      "presence": "optional",
      "logical_type": "RelationSelector"
    },
    {
      "name": "max_depth",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "filter",
      "presence": "optional",
      "logical_type": "StructuralFilter"
    }
  ],
  "FindRelevantTestsArguments": [
    {
      "name": "subjects",
      "presence": "required",
      "logical_type": "Sequence<SubjectSelector>"
    },
    {
      "name": "relationship_scope",
      "presence": "optional",
      "logical_type": "direct | transitive | both"
    },
    {
      "name": "include_fixtures",
      "presence": "optional",
      "logical_type": "Boolean"
    },
    {
      "name": "filter",
      "presence": "optional",
      "logical_type": "StructuralFilter"
    }
  ],
  "ExplainArchitectureSliceArguments": [
    {
      "name": "scope",
      "presence": "optional",
      "logical_type": "Sequence<SubjectSelector>"
    },
    {
      "name": "views",
      "presence": "optional",
      "logical_type": "Sequence<entry_points | boundaries | public_surfaces | cycles | extension_points | layers>"
    },
    {
      "name": "max_relation_depth",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "filter",
      "presence": "optional",
      "logical_type": "StructuralFilter"
    }
  ],
  "CompareWorkspacesArguments": [
    {
      "name": "selection",
      "presence": "optional",
      "logical_type": "Sequence<SubjectSelector>"
    },
    {
      "name": "comparison_kinds",
      "presence": "optional",
      "logical_type": "Sequence<added | removed | changed | moved | correlated>"
    },
    {
      "name": "correlation_policy",
      "presence": "optional",
      "logical_type": "strict | include_possible"
    },
    {
      "name": "filter",
      "presence": "optional",
      "logical_type": "StructuralFilter"
    }
  ],
  "SemanticToCallersArguments": [
    {
      "name": "query_text",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "query_class",
      "presence": "optional",
      "logical_type": "natural_text | identifier | source_code | mixed"
    },
    {
      "name": "max_call_depth",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "filter",
      "presence": "optional",
      "logical_type": "StructuralFilter"
    }
  ],
  "ResolveAndFindReferencesArguments": [
    {
      "name": "reference",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "context_artifact",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "context_byte_offset",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "kind_selector",
      "presence": "optional",
      "logical_type": "KindSelector"
    },
    {
      "name": "reference_roles",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "include_declarations",
      "presence": "optional",
      "logical_type": "Boolean"
    },
    {
      "name": "filter",
      "presence": "optional",
      "logical_type": "StructuralFilter"
    }
  ],
  "DefinitionToInstancesArguments": [
    {
      "name": "matcher",
      "presence": "required",
      "logical_type": "DefinitionMatcher"
    },
    {
      "name": "selector",
      "presence": "optional",
      "logical_type": "RegistrySelector"
    },
    {
      "name": "record_categories",
      "presence": "optional",
      "logical_type": "Sequence<entity | relation | fact | evidence | diagnostic>"
    },
    {
      "name": "producer_ids",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "filter",
      "presence": "optional",
      "logical_type": "StructuralFilter"
    }
  ],
  "SourceArtifact": [
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "normalized_uri",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "normalized_path",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "display_path",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "artifact_kind",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ArtifactVersion": [
    {
      "name": "artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "content_blob_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "content_hash",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "byte_length",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "encoding",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "language_hint",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analysis_metadata_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "created_from_observation_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "valid_from_generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "valid_to_generation",
      "presence": "required",
      "logical_type": "Count"
    }
  ],
  "ArtifactTombstone": [
    {
      "name": "artifact_tombstone_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "absence_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "absence_reason_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "last_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "valid_from_generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "valid_to_generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "opening_artifact_change_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "closing_artifact_change_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "replacement_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "cause_references",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "lineage_evidence_record_ids",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ArtifactChange": [
    {
      "name": "artifact_change_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "change_kind",
      "presence": "required",
      "logical_type": "created | updated | deleted | excluded | recreated | reincluded"
    },
    {
      "name": "previous_artifact_version_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "new_artifact_version_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "previous_tombstone_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "new_tombstone_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "cause_references",
      "presence": "required",
      "logical_type": "Sequence<ChangeCauseReference>"
    },
    {
      "name": "lineage_evidence_record_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "SourceObservation": [
    {
      "name": "source_observation_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "observation_batch_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_provider_binding_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_provider",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_provider_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "ordering_domain",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "observation_mode",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "observed_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "observed_content_hash",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "observed_metadata_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "provider_event_token",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "provider_sequence",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "observed_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "received_at",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SourceObservationDigestEntry": [
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "observed_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "observed_content_hash",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "observed_metadata_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "provider_event_token",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "provider_sequence",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "VisibleSourceStateEntry": [
    {
      "name": "state_kind",
      "presence": "required",
      "logical_type": "present | absent"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "normalized_uri",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_version_id",
      "presence": "optional",
      "logical_type": "Identifier"
    },
    {
      "name": "content_hash",
      "presence": "optional",
      "logical_type": "Digest"
    },
    {
      "name": "byte_length",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "encoding",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "language_hint",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "analysis_metadata_digest",
      "presence": "optional",
      "logical_type": "Digest"
    },
    {
      "name": "valid_from_generation",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "artifact_tombstone_id",
      "presence": "optional",
      "logical_type": "Identifier"
    },
    {
      "name": "absence_kind",
      "presence": "optional",
      "logical_type": "deleted | excluded"
    },
    {
      "name": "absence_reason_code",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "last_artifact_version_id",
      "presence": "optional",
      "logical_type": "Identifier"
    }
  ],
  "PresentSourceStateEntry": [
    {
      "name": "state_kind",
      "presence": "required",
      "logical_type": "present"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "normalized_uri",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "content_hash",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "byte_length",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "encoding",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "language_hint",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "analysis_metadata_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "valid_from_generation",
      "presence": "required",
      "logical_type": "Count"
    }
  ],
  "AbsentSourceStateEntry": [
    {
      "name": "state_kind",
      "presence": "required",
      "logical_type": "absent"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "normalized_uri",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_tombstone_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "absence_kind",
      "presence": "required",
      "logical_type": "deleted | excluded"
    },
    {
      "name": "absence_reason_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "last_artifact_version_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "valid_from_generation",
      "presence": "required",
      "logical_type": "Count"
    }
  ],
  "SourceObservationBatch": [
    {
      "name": "observation_batch_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_provider_binding_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_provider",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_provider_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "ordering_domain",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "observation_mode",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "coverage_scopes",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "coverage_completeness",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deletion_authority",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "provider_cursor_before",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "provider_cursor_after",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "started_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "completed_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "observation_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "unavailable_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "batch_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ObservationCoverageScope": [
    {
      "name": "scope_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_provider_binding_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_provider",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "normalized_scope_key",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ChangeCauseReference": [
    {
      "name": "cause_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "cause_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ContentBlob": [
    {
      "name": "content_blob_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "content_hash",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "byte_length",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "storage_reference",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SourceSpan": [
    {
      "name": "artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "start_byte",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "end_byte",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "start_line",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "end_line",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "RecordEnvelope": [
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "category",
      "presence": "required",
      "logical_type": "entity | relation | fact | evidence | diagnostic"
    },
    {
      "name": "kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "universal_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "facets",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "primary_source_span",
      "presence": "optional",
      "logical_type": "SourceSpan"
    },
    {
      "name": "valid_from_generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "valid_to_generation",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "producer_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "producer_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analysis_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "analysis_configuration_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "artifact_dependency_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "payload",
      "presence": "required",
      "logical_type": "JsonValue"
    },
    {
      "name": "record_digest",
      "presence": "required",
      "logical_type": "Digest"
    }
  ],
  "RecordKindDefinition": [
    {
      "name": "kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "category",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "payload_schema",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "universal_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "required_facets",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "allowed_facets",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "relation_definition",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_kind",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "FacetDefinition": [
    {
      "name": "facet",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "applicable_categories",
      "presence": "required",
      "logical_type": "Sequence<entity | relation | fact | evidence | diagnostic>"
    },
    {
      "name": "applicable_universal_kinds",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "implied_facets",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "incompatible_facets",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_facet",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "SemanticRoleDefinition": [
    {
      "name": "role",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "allowed_subject_universal_kinds",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "allowed_subject_facets",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "implied_roles",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "incompatible_roles",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_role",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "MetricDefinition": [
    {
      "name": "metric",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "value_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "unit",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "allowed_subject_universal_kinds",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "supported_aggregations",
      "presence": "required",
      "logical_type": "Sequence<count | sum | min | max | avg | distinct>"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_metric",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "EffectDefinition": [
    {
      "name": "effect",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "allowed_subject_universal_kinds",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "propagation_policy",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "implied_effects",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_effect",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "DependencyRoleDefinition": [
    {
      "name": "dependency_role",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "invalidation_semantics",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_dependency_role",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "ProjectionKindDefinition": [
    {
      "name": "projection_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "payload_schema",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator_contract_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_projection_kind",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "LifecycleReasonCodeDefinition": [
    {
      "name": "reason_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "applicable_domains",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_reason_code",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "CompletenessReasonDefinition": [
    {
      "name": "reason_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "allowed_statuses",
      "presence": "required",
      "logical_type": "Sequence<complete | partial | unknown | unsupported | stale>"
    },
    {
      "name": "affected_capabilities",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "agent_guidance",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_reason_code",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "LanguageDefinition": [
    {
      "name": "language_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "display_name",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "aliases",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_language_id",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "LanguageDefinitionSupply": [
    {
      "name": "language_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "definition_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "supplier_plugin_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "supplier_plugin_version",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "CapabilityContractDefinition": [
    {
      "name": "capability",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "capability_contract_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "allowed_precisions",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "allowed_record_categories",
      "presence": "required",
      "logical_type": "Sequence<entity | relation | fact | evidence | diagnostic>"
    },
    {
      "name": "allowed_universal_kinds",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "allowed_evidence_bases",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "allowed_claim_classes",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "partition_key_schema",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "dependency_obligations",
      "presence": "required",
      "logical_type": "Sequence<CapabilityDependencyObligation>"
    },
    {
      "name": "confirmed_claims_allowed",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "completeness_semantics",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_capability",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "CapabilityDependencyObligation": [
    {
      "name": "dependency_basis",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "required",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "transitive_artifact_closure",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "fallback_scope",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "CapabilityCompletenessSemantics": [
    {
      "name": "complete_requires_authoritative_replacement",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "partial_allowed",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "unknown_allowed",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "unsupported_allowed",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "non_complete_reason_required",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "affected_scope_rule",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ConstructClassDefinition": [
    {
      "name": "construct_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "applicable_capabilities",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_construct_code",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "CapabilityLimitationDefinition": [
    {
      "name": "limitation_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "allowed_capabilities",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "allowed_statuses",
      "presence": "required",
      "logical_type": "Sequence<complete | partial | unknown | unsupported | stale>"
    },
    {
      "name": "agent_guidance",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_limitation_code",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "SemanticSectionKindDefinition": [
    {
      "name": "section_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "allowed_origin_kinds",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "agent_guidance",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_section_kind",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "SemanticReasonDefinition": [
    {
      "name": "reason_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "allowed_eligibility_statuses",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "allowed_coverage_statuses",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "completeness_reason_code",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "agent_guidance",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_reason_code",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "EmbeddingProfile": [
    {
      "name": "embedding_profile_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "embedding_contract_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "model_provider_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "model_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "model_revision",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "model_identity_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "tokenizer_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "tokenizer_revision",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "tokenizer_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "document_input_contract",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "query_input_contract",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "segmentation_contract",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "maximum_document_tokens",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "maximum_query_tokens",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "dimensions",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "element_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "vector_encoding",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "normalization",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "distance_metric",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "language_support",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "supported_query_classes",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "supported_content_classes",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "agent_guidance",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_embedding_profile_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "profile_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "EmbeddingInputContract": [
    {
      "name": "renderer_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "renderer_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "template_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "input_purpose",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "EmbeddingSegmentationContract": [
    {
      "name": "segmenter_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "segmenter_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "configuration_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "EmbeddingLanguageSupport": [
    {
      "name": "mode",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "language_ids",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "supports_unclassified_text",
      "presence": "required",
      "logical_type": "Boolean"
    }
  ],
  "ModelPackManifest": [
    {
      "name": "manifest_schema_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "model_pack_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "model_pack_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "embedding_profiles",
      "presence": "required",
      "logical_type": "Sequence<EmbeddingProfile>"
    },
    {
      "name": "assets",
      "presence": "required",
      "logical_type": "Sequence<ModelPackAssetEntry>"
    },
    {
      "name": "required_runtime_components",
      "presence": "required",
      "logical_type": "Sequence<ModelPackRuntimeRequirement>"
    },
    {
      "name": "manifest_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ModelPackAssetEntry": [
    {
      "name": "content_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "decoded_byte_length",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "media_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "semantic_role",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ModelAssetManifest": [
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "model_provider_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "model_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "model_revision",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "architecture_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "model_format",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "configuration_asset_digests",
      "presence": "required",
      "logical_type": "Sequence<Digest>"
    },
    {
      "name": "weight_asset_digests",
      "presence": "required",
      "logical_type": "Sequence<Digest>"
    },
    {
      "name": "model_identity_digest",
      "presence": "required",
      "logical_type": "Digest"
    }
  ],
  "TokenizerAssetManifest": [
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "tokenizer_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "tokenizer_revision",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "tokenizer_format",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "configuration_asset_digests",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "tokenizer_data_asset_digests",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "tokenizer_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ModelPackRuntimeConfiguration": [
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "embedding_profile_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "runtime_role",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "component_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "component_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "contract_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "configuration_schema_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "configuration",
      "presence": "required",
      "logical_type": "Uint8Array"
    },
    {
      "name": "configuration_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ModelPackRuntimeRequirement": [
    {
      "name": "embedding_profile_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "runtime_role",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "component_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "component_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "behavior_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "contract_version",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ResolvedModelPackRuntimeBuild": [
    {
      "name": "embedding_profile_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "runtime_role",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "component_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "component_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "behavior_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "contract_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "runtime_component_build_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "implementation_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ModelPackCoordinateReservation": [
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "model_pack_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "model_pack_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "manifest_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "first_registered_at",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ModelPackInstallation": [
    {
      "name": "model_pack_installation_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "model_pack_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "model_pack_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "manifest_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "installed_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "removed_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "removal_reason_code",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "EmbeddingProfileExecutableBinding": [
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "embedding_profile_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "embedding_profile_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "runtime_requirements",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "runtime_configurations",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "operational_asset_digests",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "portable_binding_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "resolved_runtime_builds",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "executable_binding_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ModelPackProfileSupply": [
    {
      "name": "model_pack_profile_supply_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "model_pack_installation_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "embedding_profile_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "portable_binding_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "supplied_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "released_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "release_reason_code",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "EvidenceAssumptionDefinition": [
    {
      "name": "assumption_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "satisfaction_contract",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "agent_guidance",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_assumption_code",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "EvidenceExplanationDefinition": [
    {
      "name": "explanation_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "allowed_bases",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "allowed_derivations",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "agent_guidance",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_explanation_code",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "PluginRegistryContribution": [
    {
      "name": "plugin_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "namespace",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "registry_contract_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "dependencies",
      "presence": "required",
      "logical_type": "Sequence<PluginDependencyRequirement>"
    },
    {
      "name": "canonical_schema_definitions",
      "presence": "required",
      "logical_type": "Sequence<CanonicalSchemaDefinition>"
    },
    {
      "name": "digest_domain_definitions",
      "presence": "required",
      "logical_type": "Sequence<DigestDomainDefinition>"
    },
    {
      "name": "canonical_comparator_definitions",
      "presence": "required",
      "logical_type": "Sequence<CanonicalComparatorDefinition>"
    },
    {
      "name": "external_verification_contract_definitions",
      "presence": "required",
      "logical_type": "Sequence<ExternalVerificationContractDefinition>"
    },
    {
      "name": "runtime_component_definitions",
      "presence": "required",
      "logical_type": "Sequence<RuntimeComponentDefinition>"
    },
    {
      "name": "digest_recipe_definitions",
      "presence": "required",
      "logical_type": "Sequence<DigestRecipeDefinition>"
    },
    {
      "name": "digest_reference_definitions",
      "presence": "required",
      "logical_type": "Sequence<DigestReferenceDefinition>"
    },
    {
      "name": "language_definitions",
      "presence": "required",
      "logical_type": "Sequence<LanguageDefinition>"
    },
    {
      "name": "capability_contract_definitions",
      "presence": "required",
      "logical_type": "Sequence<CapabilityContractDefinition>"
    },
    {
      "name": "structural_stage_definitions",
      "presence": "optional",
      "logical_type": "Sequence<JsonValue>"
    },
    {
      "name": "construct_class_definitions",
      "presence": "required",
      "logical_type": "Sequence<ConstructClassDefinition>"
    },
    {
      "name": "capability_limitation_definitions",
      "presence": "required",
      "logical_type": "Sequence<CapabilityLimitationDefinition>"
    },
    {
      "name": "record_kind_definitions",
      "presence": "required",
      "logical_type": "Sequence<RecordKindDefinition>"
    },
    {
      "name": "facet_definitions",
      "presence": "required",
      "logical_type": "Sequence<FacetDefinition>"
    },
    {
      "name": "semantic_role_definitions",
      "presence": "required",
      "logical_type": "Sequence<SemanticRoleDefinition>"
    },
    {
      "name": "metric_definitions",
      "presence": "required",
      "logical_type": "Sequence<MetricDefinition>"
    },
    {
      "name": "effect_definitions",
      "presence": "required",
      "logical_type": "Sequence<EffectDefinition>"
    },
    {
      "name": "diagnostic_code_definitions",
      "presence": "required",
      "logical_type": "Sequence<DiagnosticCodeDefinition>"
    },
    {
      "name": "candidate_issue_code_definitions",
      "presence": "required",
      "logical_type": "Sequence<CandidateIssueCodeDefinition>"
    },
    {
      "name": "dependency_role_definitions",
      "presence": "required",
      "logical_type": "Sequence<DependencyRoleDefinition>"
    },
    {
      "name": "projection_kind_definitions",
      "presence": "required",
      "logical_type": "Sequence<ProjectionKindDefinition>"
    },
    {
      "name": "lifecycle_reason_code_definitions",
      "presence": "required",
      "logical_type": "Sequence<LifecycleReasonCodeDefinition>"
    },
    {
      "name": "completeness_reason_definitions",
      "presence": "required",
      "logical_type": "Sequence<CompletenessReasonDefinition>"
    },
    {
      "name": "semantic_section_kind_definitions",
      "presence": "required",
      "logical_type": "Sequence<SemanticSectionKindDefinition>"
    },
    {
      "name": "semantic_reason_definitions",
      "presence": "required",
      "logical_type": "Sequence<SemanticReasonDefinition>"
    },
    {
      "name": "evidence_assumption_definitions",
      "presence": "required",
      "logical_type": "Sequence<EvidenceAssumptionDefinition>"
    },
    {
      "name": "evidence_explanation_definitions",
      "presence": "required",
      "logical_type": "Sequence<EvidenceExplanationDefinition>"
    },
    {
      "name": "contribution_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "PluginDependencyRequirement": [
    {
      "name": "plugin_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "namespace",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "version_requirement",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "required_capabilities",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "NamespaceBinding": [
    {
      "name": "namespace_binding_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "namespace",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "contribution_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "emission_valid_from_generation",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "emission_valid_to_generation",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "RegistryNamespaceBindingEntry": [
    {
      "name": "namespace_binding_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "namespace",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "contribution_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "emission_valid_from_generation",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "emission_valid_to_generation",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "RegistrySnapshot": [
    {
      "name": "registry_snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "registry_contract_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "core_registry_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "resolution_lock_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "namespace_bindings",
      "presence": "required",
      "logical_type": "Sequence<RegistryNamespaceBindingEntry>"
    },
    {
      "name": "registry_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "VersionRequirement": [
    {
      "name": "alternatives",
      "presence": "required",
      "logical_type": "Sequence<VersionInterval>"
    },
    {
      "name": "allow_prerelease",
      "presence": "required",
      "logical_type": "Boolean"
    }
  ],
  "VersionInterval": [
    {
      "name": "minimum",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "minimum_inclusive",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "maximum",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "maximum_inclusive",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "CapabilityRequirement": [
    {
      "name": "capability",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "version_requirement",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "PluginCompatibilityDeclaration": [
    {
      "name": "declaration_schema_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "namespace",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "supported_plugin_contract_versions",
      "presence": "required",
      "logical_type": "Sequence<Count>"
    },
    {
      "name": "supported_registry_contract_versions",
      "presence": "required",
      "logical_type": "Sequence<Count>"
    },
    {
      "name": "dependencies",
      "presence": "required",
      "logical_type": "Sequence<PluginDependencyRequirement>"
    },
    {
      "name": "offered_capabilities",
      "presence": "required",
      "logical_type": "Sequence<CapabilityRequirement>"
    },
    {
      "name": "recommended_embedding_profile_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "package_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analysis_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "declaration_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "PluginResolutionLock": [
    {
      "name": "resolution_lock_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "resolver_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "resolved_plugins",
      "presence": "required",
      "logical_type": "Sequence<ResolvedPlugin>"
    },
    {
      "name": "lock_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "created_at",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ResolvedPlugin": [
    {
      "name": "plugin_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "namespace",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "package_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "declaration_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "contribution_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analysis_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analysis_configuration_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_contract_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "registry_contract_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "resolved_dependency_plugin_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "effective_capabilities",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "RegistryCompatibilityAssessment": [
    {
      "name": "assessment_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "base_registry_snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "base_resolution_lock_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "candidate_resolution_lock_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "candidate_registry_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "overall_classification",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_changes",
      "presence": "required",
      "logical_type": "Sequence<DefinitionChangeAssessment>"
    },
    {
      "name": "plugin_analysis_changes",
      "presence": "required",
      "logical_type": "Sequence<PluginAnalysisChange>"
    },
    {
      "name": "required_actions",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "assessment_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "created_at",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "DefinitionChangeAssessment": [
    {
      "name": "registry_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "identifier",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "change_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "from_definition_revision",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "to_definition_revision",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "from_schema_version",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "to_schema_version",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "classification",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "reason_codes",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "required_actions",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "affected_projection_kinds",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "explanation",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "PluginAnalysisChange": [
    {
      "name": "plugin_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "change_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "from_plugin_version",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "to_plugin_version",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "from_analysis_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "to_analysis_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "reanalysis_scope",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "reason_codes",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "IndexCandidate": [
    {
      "name": "candidate_generation_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "base_snapshot_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "base_generation",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "base_registry_snapshot_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "target_registry_snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "base_configuration_revision_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "target_configuration_revision_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "trigger_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "work_manifest_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "source_observation_batch_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "retention_lease_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "candidate_materialization_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "candidate_digest",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "created_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analysis_started_at",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "ready_at",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "finished_at",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "published_snapshot_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "published_generation",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "generation_manifest_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "stale_against_snapshot_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "failure_code",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "issue_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "CandidateMaterialization": [
    {
      "name": "candidate_materialization_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "candidate_generation_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "accepted_fact_delta_digests",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "source_transition_template_set",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "record_open_template_set",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "record_closure_template_set",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "identity_assignment_template_set",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "projection_open_template_sets",
      "presence": "required",
      "logical_type": "Sequence<CandidateProjectionOpenTemplate>"
    },
    {
      "name": "projection_closure_template_sets",
      "presence": "required",
      "logical_type": "Sequence<CandidateProjectionClosureTemplate>"
    },
    {
      "name": "capability_state_entries",
      "presence": "required",
      "logical_type": "Sequence<SnapshotCapabilityStateEntry>"
    },
    {
      "name": "source_observation_watermarks",
      "presence": "required",
      "logical_type": "Sequence<ProviderWatermark>"
    },
    {
      "name": "artifact_dependency_template_set",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lookup_dependency_template_set",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lookup_revalidation_template_set",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "materialization_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "CandidateSourceTransitionTemplate": [
    {
      "name": "artifact_change",
      "presence": "required",
      "logical_type": "ArtifactChange"
    },
    {
      "name": "target_artifact_version_without_generation",
      "presence": "optional",
      "logical_type": "CandidateArtifactVersionTemplate"
    },
    {
      "name": "target_artifact_tombstone_without_generation",
      "presence": "optional",
      "logical_type": "CandidateArtifactTombstoneTemplate"
    }
  ],
  "CandidateRecordOpenTemplate": [
    {
      "name": "record_without_validity",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "open_reason_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "previous_record_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "cause_references",
      "presence": "required",
      "logical_type": "Sequence<ChangeCauseReference>"
    }
  ],
  "CandidateRecordClosureTemplate": [
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "category",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "universal_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "closure_reason_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "replacement_record_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "cause_references",
      "presence": "required",
      "logical_type": "Sequence<ChangeCauseReference>"
    }
  ],
  "CandidateIdentityAssignmentTemplate": [
    {
      "name": "identity_assignment_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "identity_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "identity_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "assignment_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "identity_key",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "identity_key_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "previous_record_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "CandidateProjectionOpenTemplate": [
    {
      "name": "projection",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "CandidateProjectionTemplate": [
    {
      "name": "projection_record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "projection_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "projection_key",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_artifact_version_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "source_record_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "source_projection_record_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "generator",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator_configuration_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "payload",
      "presence": "required",
      "logical_type": "JsonValue"
    }
  ],
  "CandidateProjectionClosureTemplate": [
    {
      "name": "projection_record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "projection_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "projection_key",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator_configuration_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "change_reason_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "replacement_projection_record_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "cause_references",
      "presence": "required",
      "logical_type": "Sequence<ChangeCauseReference>"
    }
  ],
  "CandidateWorkManifest": [
    {
      "name": "work_manifest_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "supersedes_work_manifest_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "candidate_generation_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "base_snapshot_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "artifact_work_set",
      "presence": "required",
      "logical_type": "OrderedSetDescriptor"
    },
    {
      "name": "projection_work_set",
      "presence": "required",
      "logical_type": "OrderedSetDescriptor"
    },
    {
      "name": "invalidation_plan_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "target_registry_snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "target_configuration_revision_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "created_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "work_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ArtifactWorkItem": [
    {
      "name": "work_item_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "base_artifact_version_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "base_tombstone_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "target_artifact_version_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "target_tombstone_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "operation",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "capabilities",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "expected_replacement_scopes",
      "presence": "required",
      "logical_type": "Sequence<ReplacementScope>"
    },
    {
      "name": "reason_codes",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "cause_references",
      "presence": "required",
      "logical_type": "Sequence<ChangeCauseReference>"
    },
    {
      "name": "analysis_context_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "work_item_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ProjectionWorkItem": [
    {
      "name": "projection_work_item_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "target_tombstone_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "projection_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "operation",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator_configuration_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_selection",
      "presence": "required",
      "logical_type": "JsonValue"
    },
    {
      "name": "base_projection_set_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "reason_codes",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "cause_references",
      "presence": "required",
      "logical_type": "Sequence<ChangeCauseReference>"
    },
    {
      "name": "work_item_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "InvalidationPlan": [
    {
      "name": "invalidation_plan_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "candidate_generation_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "base_snapshot_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "seed_change_set",
      "presence": "required",
      "logical_type": "OrderedSetDescriptor"
    },
    {
      "name": "affected_artifact_set",
      "presence": "required",
      "logical_type": "OrderedSetDescriptor"
    },
    {
      "name": "affected_record_set",
      "presence": "required",
      "logical_type": "OrderedSetDescriptor"
    },
    {
      "name": "affected_projection_set",
      "presence": "required",
      "logical_type": "OrderedSetDescriptor"
    },
    {
      "name": "dependency_index_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "maximum_scope",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "fallback_scopes",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "completeness",
      "presence": "required",
      "logical_type": "CompletenessReport"
    },
    {
      "name": "created_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plan_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "CandidateIssue": [
    {
      "name": "candidate_issue_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "candidate_generation_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "issue_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "phase",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "severity",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "scope",
      "presence": "required",
      "logical_type": "CandidateIssueScope"
    },
    {
      "name": "retryability",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "summary",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "detail",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "cause_references",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "payload",
      "presence": "required",
      "logical_type": "CandidateIssuePayload"
    },
    {
      "name": "created_at",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "CandidateIssueCodeDefinition": [
    {
      "name": "issue_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "allowed_phases",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "default_severity",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "allowed_severities",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "default_retryability",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "allowed_retryabilities",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "payload_schema",
      "presence": "required",
      "logical_type": "ClosedPayloadSchema"
    },
    {
      "name": "plugin_owner",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "replacement_issue_code",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "CandidateIssueScope": [
    {
      "name": "scope_type",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "WorkspaceCandidateIssueScope": [
    {
      "name": "scope_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ArtifactCandidateIssueScope": [
    {
      "name": "scope_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_version_id",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "WorkItemCandidateIssueScope": [
    {
      "name": "scope_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "work_item_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "work_item_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "FactDeltaCandidateIssueScope": [
    {
      "name": "scope_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "fact_delta_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ReplacementScopeCandidateIssueScope": [
    {
      "name": "scope_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "fact_delta_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "replacement_scope_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ProposalCandidateIssueScope": [
    {
      "name": "scope_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "fact_delta_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "proposal_record_key",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ProjectionCandidateIssueScope": [
    {
      "name": "scope_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "projection_work_item_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "projection_record_id",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "InvalidationPathStep": [
    {
      "name": "ordinal",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "step_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "from_reference",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "to_reference",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "dependency_role",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "reason_code",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "InvalidationNodeReference": [
    {
      "name": "reference_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "reference_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "AffectedArtifactEntry": [
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_version_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "required_operation",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "cause_references",
      "presence": "required",
      "logical_type": "Sequence<ChangeCauseReference>"
    },
    {
      "name": "invalidation_path",
      "presence": "required",
      "logical_type": "Sequence<InvalidationPathStep>"
    }
  ],
  "AffectedRecordEntry": [
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "required_operation",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "cause_references",
      "presence": "required",
      "logical_type": "Sequence<ChangeCauseReference>"
    },
    {
      "name": "invalidation_path",
      "presence": "required",
      "logical_type": "Sequence<InvalidationPathStep>"
    }
  ],
  "AffectedProjectionEntry": [
    {
      "name": "projection_record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "projection_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "required_operation",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "cause_references",
      "presence": "required",
      "logical_type": "Sequence<ChangeCauseReference>"
    },
    {
      "name": "invalidation_path",
      "presence": "required",
      "logical_type": "Sequence<InvalidationPathStep>"
    }
  ],
  "PluginUpgradePlan": [
    {
      "name": "upgrade_plan_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "base_snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "base_registry_snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "base_resolution_lock_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "candidate_resolution_lock_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "compatibility_assessment_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "work_manifest_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "publication_policy",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plan_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "created_at",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "PluginActivationAttempt": [
    {
      "name": "activation_attempt_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "base_snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "base_resolution_lock_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "upgrade_plan_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "candidate_generation_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "candidate_materialization_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "phase",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "completed_work_items",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "total_work_items",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "candidate_registry_snapshot_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "published_snapshot_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "compatibility_issue_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "candidate_issue_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "started_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "finished_at",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "PluginCompatibilityIssue": [
    {
      "name": "issue_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "severity",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "phase",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "definition_references",
      "presence": "required",
      "logical_type": "Sequence<RegistryDefinitionReference>"
    },
    {
      "name": "requirement_references",
      "presence": "required",
      "logical_type": "Sequence<CompatibilityRequirementReference>"
    },
    {
      "name": "summary",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "detail",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "payload",
      "presence": "required",
      "logical_type": "JsonValue"
    },
    {
      "name": "required_action",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "retryable",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "created_at",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "PluginCompatibilityIssueCodeDefinition": [
    {
      "name": "code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "title",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "non_meaning",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "emission_condition",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "allowed_phases",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "default_severity",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "allowed_severities",
      "presence": "required",
      "logical_type": "Sequence<info | warning | error>"
    },
    {
      "name": "payload_schema",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "allowed_required_actions",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "default_retryable",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "retryable_condition",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "agent_guidance",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "examples",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_code",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "RegistryDefinitionReference": [
    {
      "name": "registry_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "identifier",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    }
  ],
  "CompatibilityRequirementReference": [
    {
      "name": "requirement_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "declaring_plugin_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "target_plugin_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "capability",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "requirement_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "KindDescriptor": [
    {
      "name": "kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "universal_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "facets",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "KindSelector": [
    {
      "name": "kinds",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "universal_kinds",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "all_facets",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "any_facets",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "excluded_facets",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    }
  ],
  "KindDefinitionView": [
    {
      "name": "kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "category",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "universal_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "required_facets",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "allowed_facets",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "relation_definition",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "payload_schema",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "plugin_owner",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deprecated_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "retired_since",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "replacement_kind",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "RegistryIncludeOptions": [
    {
      "name": "registry",
      "presence": "required",
      "logical_type": "none | used | full"
    },
    {
      "name": "include_payload_schemas",
      "presence": "required",
      "logical_type": "Boolean"
    }
  ],
  "RegistryBundle": [
    {
      "name": "registry_usage_set_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "language_definitions",
      "presence": "required",
      "logical_type": "Sequence<LanguageDefinition>"
    },
    {
      "name": "capability_contract_definitions",
      "presence": "required",
      "logical_type": "Sequence<CapabilityContractDefinition>"
    },
    {
      "name": "construct_class_definitions",
      "presence": "required",
      "logical_type": "Sequence<ConstructClassDefinition>"
    },
    {
      "name": "capability_limitation_definitions",
      "presence": "required",
      "logical_type": "Sequence<CapabilityLimitationDefinition>"
    },
    {
      "name": "kind_definitions",
      "presence": "required",
      "logical_type": "Sequence<KindDefinitionView>"
    },
    {
      "name": "facet_definitions",
      "presence": "required",
      "logical_type": "Sequence<FacetDefinition>"
    },
    {
      "name": "semantic_role_definitions",
      "presence": "required",
      "logical_type": "Sequence<SemanticRoleDefinition>"
    },
    {
      "name": "metric_definitions",
      "presence": "required",
      "logical_type": "Sequence<MetricDefinition>"
    },
    {
      "name": "effect_definitions",
      "presence": "required",
      "logical_type": "Sequence<EffectDefinition>"
    },
    {
      "name": "diagnostic_code_definitions",
      "presence": "required",
      "logical_type": "Sequence<DiagnosticCodeDefinition>"
    },
    {
      "name": "candidate_issue_code_definitions",
      "presence": "required",
      "logical_type": "Sequence<CandidateIssueCodeDefinition>"
    },
    {
      "name": "dependency_role_definitions",
      "presence": "required",
      "logical_type": "Sequence<DependencyRoleDefinition>"
    },
    {
      "name": "projection_kind_definitions",
      "presence": "required",
      "logical_type": "Sequence<ProjectionKindDefinition>"
    },
    {
      "name": "lifecycle_reason_code_definitions",
      "presence": "required",
      "logical_type": "Sequence<LifecycleReasonCodeDefinition>"
    },
    {
      "name": "completeness_reason_definitions",
      "presence": "required",
      "logical_type": "Sequence<CompletenessReasonDefinition>"
    },
    {
      "name": "semantic_section_kind_definitions",
      "presence": "required",
      "logical_type": "Sequence<SemanticSectionKindDefinition>"
    },
    {
      "name": "semantic_reason_definitions",
      "presence": "required",
      "logical_type": "Sequence<SemanticReasonDefinition>"
    },
    {
      "name": "evidence_assumption_definitions",
      "presence": "required",
      "logical_type": "Sequence<EvidenceAssumptionDefinition>"
    },
    {
      "name": "evidence_explanation_definitions",
      "presence": "required",
      "logical_type": "Sequence<EvidenceExplanationDefinition>"
    },
    {
      "name": "has_more",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "cursor",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "EntityRecord": [
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "category",
      "presence": "required",
      "logical_type": "entity | relation | fact | evidence | diagnostic"
    },
    {
      "name": "kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "universal_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "facets",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "primary_source_span",
      "presence": "optional",
      "logical_type": "SourceSpan"
    },
    {
      "name": "valid_from_generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "valid_to_generation",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "producer_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "producer_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analysis_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "analysis_configuration_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "artifact_dependency_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "payload",
      "presence": "required",
      "logical_type": "JsonValue"
    },
    {
      "name": "record_digest",
      "presence": "required",
      "logical_type": "Digest"
    }
  ],
  "RelationRecord": [
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "category",
      "presence": "required",
      "logical_type": "entity | relation | fact | evidence | diagnostic"
    },
    {
      "name": "kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "universal_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "facets",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "primary_source_span",
      "presence": "optional",
      "logical_type": "SourceSpan"
    },
    {
      "name": "valid_from_generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "valid_to_generation",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "producer_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "producer_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analysis_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "analysis_configuration_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "artifact_dependency_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "payload",
      "presence": "required",
      "logical_type": "JsonValue"
    },
    {
      "name": "record_digest",
      "presence": "required",
      "logical_type": "Digest"
    }
  ],
  "RelationArgument": [
    {
      "name": "argument_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "role",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "position",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "target",
      "presence": "required",
      "logical_type": "RelationTarget"
    },
    {
      "name": "resolution_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "confidence_level",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "evidence_record_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "RelationKindDefinition": [
    {
      "name": "kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "roles",
      "presence": "required",
      "logical_type": "Sequence<RelationRoleDefinition>"
    },
    {
      "name": "identity_roles",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "anchor_role",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "RelationRoleDefinition": [
    {
      "name": "name",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "allowed_target_types",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "allowed_universal_kinds",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "required_target_facets",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "min_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "max_count",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "ordered",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "identity_part",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "RelationIdentityInput": [
    {
      "name": "relation_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "anchor_reference",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "local_relation_key",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "additional_identity_components",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "RelationTarget": [
    {
      "name": "target_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "entity_id",
      "presence": "optional",
      "logical_type": "Identifier"
    },
    {
      "name": "record_id",
      "presence": "optional",
      "logical_type": "Identifier"
    }
  ],
  "EntityTarget": [
    {
      "name": "target_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "entity_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "entity_record_id",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "RecordTarget": [
    {
      "name": "target_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ArtifactTarget": [
    {
      "name": "target_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_version_id",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "LiteralTarget": [
    {
      "name": "target_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "value_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "value",
      "presence": "required",
      "logical_type": "JsonValue"
    }
  ],
  "UnresolvedTarget": [
    {
      "name": "target_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "symbol",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "namespace",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "candidate_entity_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "FactRecord": [
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "category",
      "presence": "required",
      "logical_type": "entity | relation | fact | evidence | diagnostic"
    },
    {
      "name": "kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "universal_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "facets",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "primary_source_span",
      "presence": "optional",
      "logical_type": "SourceSpan"
    },
    {
      "name": "valid_from_generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "valid_to_generation",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "producer_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "producer_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analysis_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "analysis_configuration_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "artifact_dependency_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "payload",
      "presence": "required",
      "logical_type": "JsonValue"
    },
    {
      "name": "record_digest",
      "presence": "required",
      "logical_type": "Digest"
    }
  ],
  "EvidenceRecord": [
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "category",
      "presence": "required",
      "logical_type": "entity | relation | fact | evidence | diagnostic"
    },
    {
      "name": "kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "universal_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "facets",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "primary_source_span",
      "presence": "optional",
      "logical_type": "SourceSpan"
    },
    {
      "name": "valid_from_generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "valid_to_generation",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "producer_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "producer_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analysis_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "analysis_configuration_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "artifact_dependency_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "payload",
      "presence": "required",
      "logical_type": "JsonValue"
    },
    {
      "name": "record_digest",
      "presence": "required",
      "logical_type": "Digest"
    }
  ],
  "EvidenceSubject": [
    {
      "name": "subject_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "record_id",
      "presence": "optional",
      "logical_type": "Identifier"
    },
    {
      "name": "relation_record_id",
      "presence": "optional",
      "logical_type": "Identifier"
    },
    {
      "name": "argument_id",
      "presence": "optional",
      "logical_type": "Identifier"
    }
  ],
  "RecordSubject": [
    {
      "name": "subject_type",
      "presence": "required",
      "logical_type": "record"
    },
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "RelationArgumentSubject": [
    {
      "name": "subject_type",
      "presence": "required",
      "logical_type": "relation_argument"
    },
    {
      "name": "relation_record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "argument_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SourceReference": [
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "span",
      "presence": "optional",
      "logical_type": "SourceSpan"
    }
  ],
  "DiagnosticRecord": [
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "category",
      "presence": "required",
      "logical_type": "entity | relation | fact | evidence | diagnostic"
    },
    {
      "name": "kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "universal_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "facets",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "primary_source_span",
      "presence": "optional",
      "logical_type": "SourceSpan"
    },
    {
      "name": "valid_from_generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "valid_to_generation",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "producer_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "producer_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analysis_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "analysis_configuration_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "artifact_dependency_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "payload",
      "presence": "required",
      "logical_type": "JsonValue"
    },
    {
      "name": "record_digest",
      "presence": "required",
      "logical_type": "Digest"
    }
  ],
  "DiagnosticScope": [
    {
      "name": "scope_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "artifact_version_id",
      "presence": "optional",
      "logical_type": "Identifier"
    },
    {
      "name": "capability",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "RecordDiagnosticScope": [
    {
      "name": "scope_type",
      "presence": "required",
      "logical_type": "record"
    },
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ArtifactDiagnosticScope": [
    {
      "name": "scope_type",
      "presence": "required",
      "logical_type": "artifact"
    },
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_version_id",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "CapabilityDiagnosticScope": [
    {
      "name": "scope_type",
      "presence": "required",
      "logical_type": "capability"
    },
    {
      "name": "capability",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "DiagnosticRecovery": [
    {
      "name": "state",
      "presence": "required",
      "logical_type": "automatic | action_required | unrecoverable"
    },
    {
      "name": "actions",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "DiagnosticCodeDefinition": [
    {
      "name": "code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "diagnostic_category",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "title",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "emission_condition",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "default_severity",
      "presence": "required",
      "logical_type": "info | warning | error"
    },
    {
      "name": "allowed_severities",
      "presence": "required",
      "logical_type": "Sequence<info | warning | error>"
    },
    {
      "name": "allowed_scope_types",
      "presence": "required",
      "logical_type": "Sequence<record | artifact | capability>"
    },
    {
      "name": "payload_schema",
      "presence": "required",
      "logical_type": "ClosedPayloadSchema"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "active | deprecated | retired"
    }
  ],
  "DerivedProjectionEnvelope": [
    {
      "name": "projection_record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "projection_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "projection_key",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_artifact_version_ids",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_record_ids",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_projection_record_ids",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator_configuration_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "created_from_snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "valid_from_generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "valid_to_generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "payload",
      "presence": "required",
      "logical_type": "JsonValue"
    },
    {
      "name": "content_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ProjectionChange": [
    {
      "name": "projection_change_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "change_action",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "projection_record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "projection_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "projection_key",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_artifact_version_ids",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_record_ids",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_projection_record_ids",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator_configuration_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "change_reason_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "previous_projection_record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "replacement_projection_record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "cause_references",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "DerivedSemanticEligibility": [
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "content_class",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "language_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "eligibility_status",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "reason_codes",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "matched_policy_rule_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "diagnostic_record_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "DerivedSemanticDocument": [
    {
      "name": "semantic_content_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SemanticDocumentSubject": [
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "document_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ArtifactSemanticDocumentSubject": [
    {
      "name": "subject_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "EntitySemanticDocumentSubject": [
    {
      "name": "subject_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "entity_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "entity_record_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SemanticDocumentSection": [
    {
      "name": "section_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "DerivedEmbeddingSegment": [
    {
      "name": "embedding_input_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "implementation_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator_configuration_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "EmbeddingSegmentPart": [
    {
      "name": "segment_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "part_ordinal",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "text_span",
      "presence": "required",
      "logical_type": "SourceSpan"
    }
  ],
  "DerivedEmbeddingVector": [
    {
      "name": "vector_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "implementation_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator_configuration_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "embedding_input_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SemanticArtifactCoverage": [
    {
      "name": "artifact_projection_set_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "coverage_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SemanticCoverageManifest": [
    {
      "name": "content_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SemanticIndexMaterialization": [
    {
      "name": "queryable_vector_set_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "materialization_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator_configuration_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "executable_binding_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "embedding_profile_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "coverage_manifest_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "RecordArtifactDependency": [
    {
      "name": "dependency_entry_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "dependency_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "dependency_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "dependency_role",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "producer_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "producer_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "valid_from_generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "valid_to_generation",
      "presence": "optional",
      "logical_type": "Count"
    }
  ],
  "RecordArtifactDependencyDigestEntry": [
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "dependency_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "dependency_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "dependency_role",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "producer_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "producer_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "valid_from_generation",
      "presence": "required",
      "logical_type": "Count"
    }
  ],
  "GenerationChangeManifest": [
    {
      "name": "generation_manifest_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "candidate_generation_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "base_snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "registry_snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "publication_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "published_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_change_set",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "record_open_set",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "record_closure_set",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "identity_assignment_set",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "projection_change_sets",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "manifest_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ChangeSetDescriptor": [
    {
      "name": "change_set_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "change_set_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "entry_schema_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "comparator_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "comparator_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "entry_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "content_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ProjectionChangeSetDescriptor": [
    {
      "name": "projection_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator_version",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "RecordOpen": [
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "category",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "universal_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "valid_from_generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "open_reason_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "previous_record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "cause_references",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "RecordClosure": [
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "category",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "universal_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "valid_to_generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "closure_reason_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "replacement_record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "cause_references",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "IdentityAssignment": [
    {
      "name": "identity_assignment_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "identity_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "identity_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "assignment_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "identity_key",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "identity_key_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "previous_record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "assigned_at_generation",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "FactDelta": [
    {
      "name": "fact_delta_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "candidate_generation_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "base_snapshot_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "work_item_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analysis_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analysis_configuration_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "publication_stage_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "replacement_scopes",
      "presence": "required",
      "logical_type": "Sequence<ReplacementScope>"
    },
    {
      "name": "input_artifact_version_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "input_record_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "plugin_input_access_manifest_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_input_access_manifest_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analysis_input_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "proposed_records",
      "presence": "required",
      "logical_type": "Sequence<ProposedRecord>"
    },
    {
      "name": "proposed_dependencies",
      "presence": "required",
      "logical_type": "Sequence<ProposedRecordDependency>"
    },
    {
      "name": "completeness_claims",
      "presence": "required",
      "logical_type": "Sequence<CompletenessClaim>"
    },
    {
      "name": "created_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "delta_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ReplacementScope": [
    {
      "name": "replacement_scope_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "capability",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "record_categories",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "record_kinds",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "partition_key",
      "presence": "optional",
      "logical_type": "JsonValue"
    },
    {
      "name": "base_record_set_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "output_completeness",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ProposedRecord": [
    {
      "name": "proposal_record_key",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "category",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "universal_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "facets",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "source_span",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "identity_key",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "body",
      "presence": "required",
      "logical_type": "JsonValue"
    },
    {
      "name": "evidence_references",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ProposedReference": [
    {
      "name": "reference_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "target_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "resolution_status",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "LocalProposalReference": [
    {
      "name": "reference_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "proposal_record_key",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "CandidateIdentityReference": [
    {
      "name": "reference_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "identity_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "identity_key",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "expected_kinds",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "required_facets",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "BaseRecordReference": [
    {
      "name": "reference_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "UnresolvedReference": [
    {
      "name": "reference_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "symbolic_key",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "candidate_identity_keys",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "resolution_reason_code",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ProposedRecordDependency": [
    {
      "name": "proposed_dependency_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "proposal_record_key",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "dependency_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "dependency_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "dependency_role",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "dependency_basis",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_reference",
      "presence": "required",
      "logical_type": "JsonValue"
    }
  ],
  "CompletenessClaim": [
    {
      "name": "completeness_claim_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "capability",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "replacement_scope_ids",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "status",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "reason_codes",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "affected_artifact_ids",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "diagnostic_proposal_keys",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "PluginCapabilityDeclaration": [
    {
      "name": "plugin_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "language_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "capability",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "capability_contract_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "precision",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "coverage",
      "presence": "required",
      "logical_type": "CapabilityCoverage"
    },
    {
      "name": "limitations",
      "presence": "required",
      "logical_type": "Sequence<CapabilityLimitation>"
    },
    {
      "name": "publication_stage_id",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "CapabilityCoverage": [
    {
      "name": "language_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "artifact_kinds",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "project_context_required",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "excluded_construct_codes",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "CapabilityLimitation": [
    {
      "name": "limitation_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "applicable_language_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "applicable_artifact_kinds",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "applicable_construct_codes",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "resulting_status",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "PluginWorkerRequestEnvelope": [
    {
      "name": "protocol_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "request_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "request_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "call",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deadline",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "cancellation_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "payload",
      "presence": "required",
      "logical_type": "JsonValue"
    }
  ],
  "PluginWorkerResponseEnvelope": [
    {
      "name": "protocol_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "request_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "request_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "call",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "outcome",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "payload",
      "presence": "required",
      "logical_type": "JsonValue"
    }
  ],
  "PluginDescribeRequest": [
    {
      "name": "plugin_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "package_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "PluginDescribeResult": [
    {
      "name": "compatibility_declaration_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "registry_contribution_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "supported_calls",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "DiscoverPartitionsRequest": [
    {
      "name": "candidate_generation_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "context",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "resource_budget",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "DiscoverPartitionsResult": [
    {
      "name": "partitions",
      "presence": "required",
      "logical_type": "Sequence<AnalysisPartition>"
    },
    {
      "name": "plugin_input_access_manifest_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_input_access_manifest_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analysis_input_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "AnalysisPartition": [
    {
      "name": "partition_key",
      "presence": "required",
      "logical_type": "ArtifactPartitionKey | CallablePartitionKey | FrameworkPartitionKey | ProjectPartitionKey"
    },
    {
      "name": "language_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "member_artifact_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "configuration_artifact_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "resolution_roots",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "capabilities",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "AnalyzeArtifactRequest": [
    {
      "name": "candidate_generation_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "work_item",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "context",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "resource_budget",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "AnalyzeArtifactSuccess": [
    {
      "name": "fact_delta",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_input_access_manifest_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_input_access_manifest_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analysis_input_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "GenerateProjectionRequest": [
    {
      "name": "candidate_generation_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "projection_work_item",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "context",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "resource_budget",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "GenerateProjectionSuccess": [
    {
      "name": "projection_replacement_set",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_input_access_manifest_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_input_access_manifest_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analysis_input_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "PluginAnalysisContext": [
    {
      "name": "analysis_view",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "resource_budget",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "PluginAnalysisView": [
    {
      "name": "analysis_view_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "candidate_generation_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "base_snapshot_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "source_overlay_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "prerequisite_stage_set_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "target_registry_snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "resolution_lock_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "configuration_revision_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "PluginArtifactView": [
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "normalized_uri",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "content_hash",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "byte_length",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "encoding",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "language_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "content_access",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "PluginRecordView": [
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "category",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "payload",
      "presence": "required",
      "logical_type": "JsonValue"
    }
  ],
  "BasePluginRecordView": [
    {
      "name": "view_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "record_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "category",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "universal_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "facets",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_span",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "body",
      "presence": "required",
      "logical_type": "JsonValue"
    }
  ],
  "StagedPluginRecordView": [
    {
      "name": "view_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "staged_record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "producing_work_item_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "proposal_record_key",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "validated_record_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "category",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "universal_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "facets",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "owner_artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_span",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "body",
      "presence": "required",
      "logical_type": "JsonValue"
    }
  ],
  "PluginInputLookupEntry": [
    {
      "name": "operation",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "normalized_selector_or_address",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analysis_view_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "result_set_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "result_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "completeness",
      "presence": "required",
      "logical_type": "CompletenessReport"
    }
  ],
  "PluginInputRecordEntry": [
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "record",
      "presence": "required",
      "logical_type": "PluginRecordView"
    },
    {
      "name": "access_mode",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "BasePluginInputRecordEntry": [
    {
      "name": "input_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "record_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "StagedPluginInputRecordEntry": [
    {
      "name": "input_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "staged_record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "producing_work_item_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "proposal_record_key",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "validated_record_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "PluginInputAccessManifest": [
    {
      "name": "plugin_input_access_manifest_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "request_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analysis_view_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_version_entries",
      "presence": "required",
      "logical_type": "Sequence<JsonValue>"
    },
    {
      "name": "record_entries",
      "presence": "required",
      "logical_type": "Sequence<JsonValue>"
    },
    {
      "name": "lookup_entries",
      "presence": "required",
      "logical_type": "Sequence<JsonValue>"
    },
    {
      "name": "transitive_artifact_version_ids",
      "presence": "required",
      "logical_type": "Sequence<JsonValue>"
    },
    {
      "name": "manifest_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "PluginLookupInvalidationDependency": [
    {
      "name": "lookup_dependency_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "consumer_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "consumer_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "owner_artifact_version_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "operation",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "normalized_selector_or_address",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "selector_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "previous_result_set_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "invalidation_scope",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "valid_from_generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "valid_to_generation",
      "presence": "optional",
      "logical_type": "Count"
    }
  ],
  "PluginResourceBudget": [
    {
      "name": "deadline",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "max_memory_bytes",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "max_output_bytes",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "max_records",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "max_dependencies",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "max_context_operations",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "max_context_bytes",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "max_recursion_depth",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "PluginInputsIncomplete": [
    {
      "name": "candidate_issue_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "retryability",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "message",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "details",
      "presence": "required",
      "logical_type": "JsonValue"
    }
  ],
  "PluginUnsupported": [
    {
      "name": "candidate_issue_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "retryability",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "message",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "details",
      "presence": "required",
      "logical_type": "JsonValue"
    }
  ],
  "PluginCancelled": [
    {
      "name": "candidate_issue_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "retryability",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "message",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "details",
      "presence": "required",
      "logical_type": "JsonValue"
    }
  ],
  "PluginResourceExhausted": [
    {
      "name": "candidate_issue_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "retryability",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "message",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "details",
      "presence": "required",
      "logical_type": "JsonValue"
    }
  ],
  "PluginFailed": [
    {
      "name": "candidate_issue_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "retryability",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "message",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "details",
      "presence": "required",
      "logical_type": "JsonValue"
    }
  ],
  "QueryRequest": [
    {
      "name": "api_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "scope",
      "presence": "required",
      "logical_type": "QueryScope"
    },
    {
      "name": "expression",
      "presence": "required",
      "logical_type": "QueryExpression"
    },
    {
      "name": "options",
      "presence": "required",
      "logical_type": "QueryOptions"
    }
  ],
  "QueryScope": [
    {
      "name": "scope_type",
      "presence": "required",
      "logical_type": "single_workspace | comparison"
    },
    {
      "name": "workspace_id",
      "presence": "optional",
      "logical_type": "Identifier"
    },
    {
      "name": "participants",
      "presence": "optional",
      "logical_type": "Sequence<QueryParticipant>"
    }
  ],
  "SingleWorkspaceScope": [
    {
      "name": "scope_type",
      "presence": "required",
      "logical_type": "single_workspace"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "snapshot_id",
      "presence": "optional",
      "logical_type": "Identifier"
    }
  ],
  "ComparisonScope": [
    {
      "name": "scope_type",
      "presence": "required",
      "logical_type": "comparison"
    },
    {
      "name": "participants",
      "presence": "required",
      "logical_type": "Sequence<QueryParticipant>"
    }
  ],
  "QueryParticipant": [
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "role",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "snapshot_id",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "QueryExpression": [
    {
      "name": "expression_type",
      "presence": "required",
      "logical_type": "operation | pipeline | recipe"
    }
  ],
  "OperationExpression": [
    {
      "name": "expression_type",
      "presence": "required",
      "logical_type": "operation"
    },
    {
      "name": "operation",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "arguments",
      "presence": "required",
      "logical_type": "OperationArguments"
    }
  ],
  "PipelineExpression": [
    {
      "name": "expression_type",
      "presence": "required",
      "logical_type": "pipeline"
    },
    {
      "name": "stages",
      "presence": "required",
      "logical_type": "Sequence<QueryStage>"
    },
    {
      "name": "outputs",
      "presence": "required",
      "logical_type": "Sequence<StageOutputReference>"
    }
  ],
  "RecipeExpression": [
    {
      "name": "expression_type",
      "presence": "required",
      "logical_type": "recipe"
    },
    {
      "name": "recipe_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "recipe_version",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "arguments",
      "presence": "required",
      "logical_type": "RecipeArguments"
    }
  ],
  "QueryStage": [
    {
      "name": "stage_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "operator",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "inputs",
      "presence": "required",
      "logical_type": "Sequence<StageOutputReference>"
    },
    {
      "name": "arguments",
      "presence": "required",
      "logical_type": "QueryStageArguments"
    }
  ],
  "StageOutputReference": [
    {
      "name": "stage_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "output",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "DefinitionMatcher": [
    {
      "name": "text",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "mode",
      "presence": "required",
      "logical_type": "exact | prefix | contains | semantic | hybrid"
    },
    {
      "name": "definition_types",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "namespaces",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "limit",
      "presence": "optional",
      "logical_type": "Count"
    }
  ],
  "DefinitionSetReference": [
    {
      "name": "stage_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "output",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SubjectSelector": [
    {
      "name": "subject_type",
      "presence": "required",
      "logical_type": "entity | record | artifact | symbol | stage_output"
    },
    {
      "name": "entity_id",
      "presence": "optional",
      "logical_type": "Identifier"
    },
    {
      "name": "entity_record_id",
      "presence": "optional",
      "logical_type": "Identifier"
    },
    {
      "name": "record_id",
      "presence": "optional",
      "logical_type": "Identifier"
    },
    {
      "name": "artifact_id",
      "presence": "optional",
      "logical_type": "Identifier"
    },
    {
      "name": "artifact_version_id",
      "presence": "optional",
      "logical_type": "Identifier"
    },
    {
      "name": "path",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "name",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "context_artifact",
      "presence": "optional",
      "logical_type": "Identifier"
    },
    {
      "name": "context_byte_offset",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "kind_selector",
      "presence": "optional",
      "logical_type": "KindSelector"
    },
    {
      "name": "stage_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "output",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "StructuralFilter": [
    {
      "name": "paths",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "languages",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "namespaces",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "kind_selector",
      "presence": "optional",
      "logical_type": "KindSelector"
    },
    {
      "name": "subject_types",
      "presence": "optional",
      "logical_type": "Sequence<entity | record | artifact>"
    },
    {
      "name": "include_external",
      "presence": "optional",
      "logical_type": "Boolean"
    },
    {
      "name": "include_generated",
      "presence": "optional",
      "logical_type": "Boolean"
    }
  ],
  "RelationSelector": [
    {
      "name": "relation_kinds",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "universal_kinds",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "roles",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "evidence_class",
      "presence": "optional",
      "logical_type": "confirmed | possible | both"
    },
    {
      "name": "possible_confidence",
      "presence": "optional",
      "logical_type": "Sequence<high | medium | low>"
    }
  ],
  "RegistrySelector": [
    {
      "name": "definition_types",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "namespaces",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "plugin_ids",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "lifecycle_states",
      "presence": "optional",
      "logical_type": "Sequence<active | deprecated | retired>"
    }
  ],
  "ChangeDescriptor": [
    {
      "name": "change_type",
      "presence": "required",
      "logical_type": "delete | rename | move | signature | type | visibility | contract | behavior"
    },
    {
      "name": "new_name",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "new_artifact_path",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "new_container",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "new_signature",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "compatibility_assumptions",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "new_type",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "new_visibility",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "contract_change_code",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "new_contract",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "behavior_change_code",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "description",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "affected_effects",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    }
  ],
  "FindRecordsArguments": [
    {
      "name": "selector",
      "presence": "required",
      "logical_type": "RecordStructuralSelector"
    }
  ],
  "RecordStructuralSelector": [
    {
      "name": "record_categories",
      "presence": "optional",
      "logical_type": "Sequence<entity | relation | fact | evidence | diagnostic>"
    },
    {
      "name": "kind_selector",
      "presence": "optional",
      "logical_type": "KindSelector"
    },
    {
      "name": "producer_ids",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "filter",
      "presence": "optional",
      "logical_type": "StructuralFilter"
    }
  ],
  "QueryOptions": [
    {
      "name": "freshness",
      "presence": "required",
      "logical_type": "snapshot | current | wait_for_current"
    },
    {
      "name": "wait_timeout_ms",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "coverage_requirement",
      "presence": "required",
      "logical_type": "accept_reported | require_complete"
    },
    {
      "name": "evidence",
      "presence": "required",
      "logical_type": "EvidenceIncludeOptions"
    },
    {
      "name": "diagnostics",
      "presence": "required",
      "logical_type": "DiagnosticIncludeOptions"
    },
    {
      "name": "snippets",
      "presence": "required",
      "logical_type": "SourceIncludeOptions"
    },
    {
      "name": "registry",
      "presence": "required",
      "logical_type": "RegistryIncludeOptions"
    },
    {
      "name": "response_budget",
      "presence": "required",
      "logical_type": "ResponseBudget"
    }
  ],
  "ResponseBudget": [
    {
      "name": "max_items",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "max_characters",
      "presence": "required",
      "logical_type": "Count"
    }
  ],
  "ContinuationRequest": [
    {
      "name": "api_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "scope",
      "presence": "required",
      "logical_type": "QueryScope"
    },
    {
      "name": "cursor",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "response_budget",
      "presence": "required",
      "logical_type": "ResponseBudget"
    }
  ],
  "IntentRecipeDefinition": [
    {
      "name": "recipe_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "recipe_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "public_api_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "argument_schema_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "argument_schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "stages",
      "presence": "required",
      "logical_type": "Sequence<IntentRecipeStageDefinition>"
    },
    {
      "name": "outputs",
      "presence": "required",
      "logical_type": "Sequence<IntentRecipeOutputDefinition>"
    },
    {
      "name": "required_capabilities",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "completeness_policy",
      "presence": "required",
      "logical_type": "report | require_complete"
    },
    {
      "name": "ranking_bindings",
      "presence": "required",
      "logical_type": "Sequence<IntentRecipeRankingBinding>"
    },
    {
      "name": "guards",
      "presence": "required",
      "logical_type": "Sequence<IntentRecipeGuardDefinition>"
    },
    {
      "name": "pagination_streams",
      "presence": "required",
      "logical_type": "Sequence<IntentRecipePaginationStream>"
    },
    {
      "name": "recipe_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "IntentRecipeStageDefinition": [
    {
      "name": "stage_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "operator_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "operator_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "inputs",
      "presence": "required",
      "logical_type": "Sequence<StageOutputReference>"
    },
    {
      "name": "static_arguments_schema_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "static_arguments_schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "static_arguments_schema_coordinate",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "static_arguments",
      "presence": "required",
      "logical_type": "Readonly<Record<string, RecipeStaticArgumentValue>>"
    },
    {
      "name": "partial_arguments_schema_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "partial_arguments_schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "partial_arguments_schema_coordinate",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "argument_bindings",
      "presence": "required",
      "logical_type": "Sequence<RecipeArgumentBinding>"
    }
  ],
  "RecipeArgumentBinding": [
    {
      "name": "recipe_argument_path",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "source_output_reference",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "stage_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "stage_argument_path",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "IntentRecipeOutputDefinition": [
    {
      "name": "output_name",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "stage_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "stage_output",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "projection",
      "presence": "required",
      "logical_type": "subjects | relations | paths | definitions"
    }
  ],
  "IntentRecipeRankingBinding": [
    {
      "name": "stage_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "ranking_profile_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "ranking_profile_version",
      "presence": "required",
      "logical_type": "Count"
    }
  ],
  "IntentRecipeGuardDefinition": [
    {
      "name": "guard_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "evaluation_point",
      "presence": "required",
      "logical_type": "before_stage | after_stage | before_output"
    },
    {
      "name": "predicate_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "failure_error_code",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "guard_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "stage_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "failure_code",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "IntentRecipePaginationStream": [
    {
      "name": "stream_name",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "output_name",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "ordering_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "ordering_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "classifications",
      "presence": "required",
      "logical_type": "Sequence<confirmed | possible | unclassified>"
    },
    {
      "name": "result_set",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "classification",
      "presence": "optional",
      "logical_type": "confirmed | possible | unclassified"
    }
  ],
  "QueryExecution": [
    {
      "name": "query_plan_hash",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "WorkspaceSnapshotBinding": [
    {
      "name": "workspace_snapshot_binding_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "participant_ordinal",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "participant_role",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "registry_snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "resolution_lock_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "configuration_revision_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "freshness_checkpoint_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "retention_lease_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "QueryEmbedding": [
    {
      "name": "query_embedding_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "embedding_input_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "vector_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator_configuration_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "executable_binding_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "embedding_profile_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SemanticIndexBinding": [
    {
      "name": "binding_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generator_configuration_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "executable_binding_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "embedding_profile_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "queryable_vector_set_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SemanticCoverageView": [
    {
      "name": "semantic_index_binding_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "materialization_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "covered_artifact_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "pending_artifact_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "excluded_artifact_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "unsupported_artifact_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "failed_artifact_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "affected_artifact_set_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "affected_artifact_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "affected_artifact_page",
      "presence": "optional",
      "logical_type": "SemanticAffectedArtifactPage"
    }
  ],
  "SemanticAffectedArtifactView": [
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "display_path",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "coverage_status",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "reason_codes",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "diagnostic_record_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "SemanticAffectedArtifactPage": [
    {
      "name": "affected_artifact_set_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifacts",
      "presence": "required",
      "logical_type": "Sequence<SemanticAffectedArtifactView>"
    },
    {
      "name": "total",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "next_cursor",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "previous_cursor",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "has_next",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "has_previous",
      "presence": "required",
      "logical_type": "Boolean"
    }
  ],
  "ResultManifestEntry": [
    {
      "name": "query_execution_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "ordinal",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "result_set",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "primary_result",
      "presence": "required",
      "logical_type": "ResultSubject"
    },
    {
      "name": "evidence_path_record_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "result_classification",
      "presence": "required",
      "logical_type": "confirmed | possible"
    },
    {
      "name": "rank",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "stage_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_projection",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "stable_sort_key",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ResultBundle": [
    {
      "name": "result_set",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "primary_result",
      "presence": "required",
      "logical_type": "PrimaryResultView"
    },
    {
      "name": "assessment",
      "presence": "required",
      "logical_type": "ResultAssessment"
    },
    {
      "name": "provenance_path",
      "presence": "required",
      "logical_type": "Sequence<ProvenancePathStep>"
    },
    {
      "name": "essential_related_entities",
      "presence": "required",
      "logical_type": "Sequence<EntityPrimaryResultView>"
    },
    {
      "name": "optional_source_snippets",
      "presence": "required",
      "logical_type": "Sequence<SourceSnippet>"
    }
  ],
  "ResultSubject": [
    {
      "name": "result_type",
      "presence": "required",
      "logical_type": "entity | record | artifact"
    },
    {
      "name": "workspace_snapshot_binding_id",
      "presence": "required",
      "logical_type": "Identifier"
    },
    {
      "name": "entity_id",
      "presence": "optional",
      "logical_type": "Identifier"
    },
    {
      "name": "entity_record_id",
      "presence": "optional",
      "logical_type": "Identifier"
    },
    {
      "name": "record_id",
      "presence": "optional",
      "logical_type": "Identifier"
    },
    {
      "name": "artifact_id",
      "presence": "optional",
      "logical_type": "Identifier"
    },
    {
      "name": "artifact_version_id",
      "presence": "optional",
      "logical_type": "Identifier"
    }
  ],
  "EntityResultSubject": [
    {
      "name": "result_type",
      "presence": "required",
      "logical_type": "entity"
    },
    {
      "name": "workspace_snapshot_binding_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "entity_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "entity_record_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "RecordResultSubject": [
    {
      "name": "result_type",
      "presence": "required",
      "logical_type": "record"
    },
    {
      "name": "workspace_snapshot_binding_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "record_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ArtifactResultSubject": [
    {
      "name": "result_type",
      "presence": "required",
      "logical_type": "artifact"
    },
    {
      "name": "workspace_snapshot_binding_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "PrimaryResultView": [
    {
      "name": "result_type",
      "presence": "required",
      "logical_type": "entity | record | artifact"
    },
    {
      "name": "subject",
      "presence": "required",
      "logical_type": "ResultSubject"
    },
    {
      "name": "record",
      "presence": "optional",
      "logical_type": "RecordEnvelope"
    },
    {
      "name": "artifact",
      "presence": "optional",
      "logical_type": "SourceArtifact"
    },
    {
      "name": "artifact_version",
      "presence": "optional",
      "logical_type": "ArtifactVersion"
    }
  ],
  "EntityPrimaryResultView": [
    {
      "name": "result_type",
      "presence": "required",
      "logical_type": "entity"
    },
    {
      "name": "subject",
      "presence": "required",
      "logical_type": "EntityResultSubject"
    },
    {
      "name": "record",
      "presence": "required",
      "logical_type": "EntityRecord"
    }
  ],
  "RecordPrimaryResultView": [
    {
      "name": "result_type",
      "presence": "required",
      "logical_type": "record"
    },
    {
      "name": "subject",
      "presence": "required",
      "logical_type": "RecordResultSubject"
    },
    {
      "name": "record",
      "presence": "required",
      "logical_type": "RecordEnvelope"
    }
  ],
  "ArtifactPrimaryResultView": [
    {
      "name": "result_type",
      "presence": "required",
      "logical_type": "artifact"
    },
    {
      "name": "subject",
      "presence": "required",
      "logical_type": "ArtifactResultSubject"
    },
    {
      "name": "artifact",
      "presence": "required",
      "logical_type": "SourceArtifact"
    },
    {
      "name": "artifact_version",
      "presence": "required",
      "logical_type": "ArtifactVersion"
    }
  ],
  "CompletenessReport": [
    {
      "name": "workspace_snapshot_binding_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "overall_status",
      "presence": "required",
      "logical_type": "complete | partial | unknown | unsupported | stale"
    },
    {
      "name": "dimensions",
      "presence": "required",
      "logical_type": "Sequence<CompletenessDimension>"
    },
    {
      "name": "diagnostic_record_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "CompletenessDimension": [
    {
      "name": "workspace_snapshot_binding_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "capability",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "status",
      "presence": "required",
      "logical_type": "complete | partial | unknown | unsupported | stale"
    },
    {
      "name": "reason_codes",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "affected_artifact_count",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "affected_artifact_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "affected_artifact_set_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "diagnostic_record_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    }
  ],
  "ResultAssessment": [
    {
      "name": "classification",
      "presence": "required",
      "logical_type": "confirmed | possible"
    },
    {
      "name": "confidence_level",
      "presence": "optional",
      "logical_type": "high | medium | low"
    },
    {
      "name": "evidence_summary",
      "presence": "optional",
      "logical_type": "EvidenceSummary"
    },
    {
      "name": "completeness",
      "presence": "required",
      "logical_type": "CompletenessReport[\"overall_status\"]"
    }
  ],
  "EvidenceSummary": [
    {
      "name": "primary_basis",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "primary_derivation",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "explanation_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "evidence_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "assumption_codes",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "citations",
      "presence": "required",
      "logical_type": "Sequence<EvidenceCitation>"
    },
    {
      "name": "has_more_evidence",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "evidence_cursor",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "EvidenceCitation": [
    {
      "name": "evidence_record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "basis",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "derivation",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "claim_class",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "confidence_level",
      "presence": "optional",
      "logical_type": "high | medium | low"
    },
    {
      "name": "explanation_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source",
      "presence": "required",
      "logical_type": "SourceReferenceView"
    }
  ],
  "SourceReferenceView": [
    {
      "name": "artifact_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "artifact_version_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "path",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "span",
      "presence": "optional",
      "logical_type": "SourceSpan"
    },
    {
      "name": "snippet",
      "presence": "optional",
      "logical_type": "SourceSnippet"
    }
  ],
  "SourceSnippet": [
    {
      "name": "text",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "span",
      "presence": "required",
      "logical_type": "SourceSpan"
    },
    {
      "name": "truncated",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "redacted",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "redactions",
      "presence": "required",
      "logical_type": "Sequence<SnippetRedaction>"
    }
  ],
  "SnippetRedaction": [
    {
      "name": "source_span",
      "presence": "required",
      "logical_type": "SourceSpan"
    },
    {
      "name": "output_start_character",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "output_end_character",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "reason_code",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "EvidenceIncludeOptions": [
    {
      "name": "evidence",
      "presence": "required",
      "logical_type": "none | summary | full"
    },
    {
      "name": "evidence_chain_depth",
      "presence": "required",
      "logical_type": "Count"
    }
  ],
  "SourceIncludeOptions": [
    {
      "name": "mode",
      "presence": "required",
      "logical_type": "none | signature | relevant | body"
    },
    {
      "name": "max_characters_per_snippet",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "max_total_characters",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "context_lines",
      "presence": "required",
      "logical_type": "Count"
    }
  ],
  "DiagnosticReport": [
    {
      "name": "total",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "returned",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "by_severity",
      "presence": "required",
      "logical_type": "Readonly<Record<\"info\" | \"warning\" | \"error\", number>>"
    },
    {
      "name": "by_completeness_effect",
      "presence": "required",
      "logical_type": "Readonly<Record<\"none\" | \"local\" | \"capability\", number>>"
    },
    {
      "name": "diagnostics",
      "presence": "required",
      "logical_type": "Sequence<DiagnosticView>"
    },
    {
      "name": "has_more",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "cursor",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "DiagnosticView": [
    {
      "name": "diagnostic_record_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "diagnostic_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "code_definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "code_schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "title",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "diagnostic_category",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "severity",
      "presence": "required",
      "logical_type": "info | warning | error"
    },
    {
      "name": "completeness_effect",
      "presence": "required",
      "logical_type": "none | local | capability"
    },
    {
      "name": "completeness_status",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "summary",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "detail",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "affected_scopes",
      "presence": "required",
      "logical_type": "Sequence<DiagnosticScope>"
    },
    {
      "name": "recovery",
      "presence": "required",
      "logical_type": "DiagnosticRecovery"
    },
    {
      "name": "agent_guidance",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source",
      "presence": "required",
      "logical_type": "SourceReferenceView"
    },
    {
      "name": "evidence_summary",
      "presence": "optional",
      "logical_type": "EvidenceSummary"
    }
  ],
  "DiagnosticIncludeOptions": [
    {
      "name": "diagnostics",
      "presence": "required",
      "logical_type": "none | relevant | all"
    },
    {
      "name": "diagnostic_detail",
      "presence": "required",
      "logical_type": "Boolean"
    }
  ],
  "OperationError": [
    {
      "name": "code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "message",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "retryable",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "recovery_action",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "optional",
      "logical_type": "Identifier"
    },
    {
      "name": "query_execution_id",
      "presence": "optional",
      "logical_type": "Identifier"
    },
    {
      "name": "details",
      "presence": "optional",
      "logical_type": "OperationErrorDetails"
    }
  ],
  "OperationErrorCodeDefinition": [
    {
      "name": "code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "definition_revision",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "schema_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "description",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "retryable_default",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "recovery_actions",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "details_schema",
      "presence": "required",
      "logical_type": "ClosedPayloadSchema"
    },
    {
      "name": "lifecycle_state",
      "presence": "required",
      "logical_type": "active | deprecated | retired"
    }
  ],
  "CursorTokenClaims": [
    {
      "name": "workspace_scope_digest",
      "presence": "required",
      "logical_type": "Digest"
    },
    {
      "name": "workspace_status_scope_digest",
      "presence": "required",
      "logical_type": "Digest"
    }
  ],
  "QueryCursorTokenClaims": [
    {
      "name": "workspace_scope_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "IndexStatusCursorTokenClaims": [
    {
      "name": "workspace_status_scope_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "RegistryUsageSet": [
    {
      "name": "registry_usage_set_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "query_execution_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "parent_slices",
      "presence": "required",
      "logical_type": "Sequence<RegistryUsageParentSlice>"
    },
    {
      "name": "registry_snapshot_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "definition_set",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "usage_set_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "RegistryUsageParentSlice": [
    {
      "name": "result_stream",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "stable_start_position",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "stable_end_position_exclusive",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "projection_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ResultSetPage": [
    {
      "name": "result_set",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "confirmed",
      "presence": "required",
      "logical_type": "ResultStreamPage"
    },
    {
      "name": "possible",
      "presence": "required",
      "logical_type": "ResultStreamPage"
    }
  ],
  "ResultStreamPage": [
    {
      "name": "classification",
      "presence": "required",
      "logical_type": "confirmed | possible"
    },
    {
      "name": "page_mode",
      "presence": "required",
      "logical_type": "hydrated | summary"
    },
    {
      "name": "result_bundles",
      "presence": "required",
      "logical_type": "Sequence<ResultBundle>"
    },
    {
      "name": "total",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "next_cursor",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "previous_cursor",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "has_next",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "has_previous",
      "presence": "required",
      "logical_type": "Boolean"
    }
  ],
  "QueryResultPage": [
    {
      "name": "query_execution_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "scope_kind",
      "presence": "required",
      "logical_type": "single_workspace | comparison"
    },
    {
      "name": "workspace_snapshot_bindings",
      "presence": "required",
      "logical_type": "Sequence<WorkspaceSnapshotBinding>"
    },
    {
      "name": "semantic_coverage_views",
      "presence": "required",
      "logical_type": "Sequence<SemanticCoverageView>"
    },
    {
      "name": "result_sets",
      "presence": "required",
      "logical_type": "Sequence<ResultSetPage>"
    },
    {
      "name": "expires_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "returned_items",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "returned_characters",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "estimated_tokens",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "completeness_report",
      "presence": "required",
      "logical_type": "CompletenessReport"
    },
    {
      "name": "diagnostic_report",
      "presence": "required",
      "logical_type": "DiagnosticReport"
    },
    {
      "name": "registry_bundle",
      "presence": "optional",
      "logical_type": "RegistryBundle"
    }
  ],
  "IndexStatusRequest": [
    {
      "name": "request_type",
      "presence": "required",
      "logical_type": "initial | continuation"
    },
    {
      "name": "api_version",
      "presence": "required",
      "logical_type": "PositiveInteger"
    },
    {
      "name": "workspace_ids",
      "presence": "required",
      "logical_type": "Sequence<Identifier>"
    },
    {
      "name": "include_capabilities",
      "presence": "optional",
      "logical_type": "Boolean"
    },
    {
      "name": "include_plugins",
      "presence": "optional",
      "logical_type": "Boolean"
    },
    {
      "name": "include_activation_issues",
      "presence": "optional",
      "logical_type": "Boolean"
    },
    {
      "name": "include_candidate_issues",
      "presence": "optional",
      "logical_type": "Boolean"
    },
    {
      "name": "cursor",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "response_budget",
      "presence": "required",
      "logical_type": "ResponseBudget"
    }
  ],
  "IndexStatusInitialRequest": [
    {
      "name": "request_type",
      "presence": "required",
      "logical_type": "initial"
    },
    {
      "name": "api_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "workspace_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "include_capabilities",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "include_plugins",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "include_activation_issues",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "include_candidate_issues",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "response_budget",
      "presence": "required",
      "logical_type": "ResponseBudget"
    }
  ],
  "IndexStatusContinuationRequest": [
    {
      "name": "request_type",
      "presence": "required",
      "logical_type": "continuation"
    },
    {
      "name": "api_version",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "workspace_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "cursor",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "response_budget",
      "presence": "required",
      "logical_type": "ResponseBudget"
    }
  ],
  "IndexStatusExecution": [
    {
      "name": "index_status_execution_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "include_capabilities",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "include_plugins",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "include_activation_issues",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "include_candidate_issues",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "workspace_status_set",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "activation_issue_status_set",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "candidate_issue_status_set",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "response_budget_ceiling",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "projection_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "execution_status",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "observed_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "created_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "expires_at",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "IndexStatusPage": [
    {
      "name": "index_status_execution_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "workspaces",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "activation_issues",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "candidate_issues",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "observed_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "expires_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "returned_items",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "returned_characters",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "WorkspaceStatusStreamPage": [
    {
      "name": "workspaces",
      "presence": "required",
      "logical_type": "Sequence<WorkspaceIndexStatusView>"
    },
    {
      "name": "total",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "next_cursor",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "previous_cursor",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "has_next",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "has_previous",
      "presence": "required",
      "logical_type": "Boolean"
    }
  ],
  "WorkspaceIndexStatusView": [
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "display_root",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_status",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "startup_phase",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "current_snapshot_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "current_generation",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "freshness_checkpoint_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "freshness_status",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "last_scan_error_code",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "last_scan_error_at",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "current_candidate",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "active_registry_snapshot_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "active_resolution_lock_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "plugins",
      "presence": "required",
      "logical_type": "Sequence<WorkspacePluginStatusView>"
    },
    {
      "name": "capabilities",
      "presence": "required",
      "logical_type": "Sequence<WorkspaceCapabilityStatusView>"
    },
    {
      "name": "structural_progress",
      "presence": "optional",
      "logical_type": "Sequence<JsonValue>"
    },
    {
      "name": "semantic_materializations",
      "presence": "required",
      "logical_type": "Sequence<SemanticMaterializationStatusView>"
    },
    {
      "name": "latest_activation_attempt",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "source_ready",
      "presence": "optional",
      "logical_type": "Boolean"
    },
    {
      "name": "structural_ready",
      "presence": "optional",
      "logical_type": "Boolean"
    },
    {
      "name": "semantic_ready",
      "presence": "optional",
      "logical_type": "Boolean"
    },
    {
      "name": "source_snapshot_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "structural_snapshot_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "structural_source_snapshot_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "source_availability",
      "presence": "optional",
      "logical_type": "available | unavailable"
    },
    {
      "name": "source_completeness",
      "presence": "optional",
      "logical_type": "complete | partial | unknown | unsupported | stale"
    },
    {
      "name": "source_freshness",
      "presence": "optional",
      "logical_type": "equivalent | changes_pending | degraded"
    },
    {
      "name": "source_build_state",
      "presence": "optional",
      "logical_type": "not_started | building | idle | failed | disabled"
    },
    {
      "name": "structural_availability",
      "presence": "optional",
      "logical_type": "available | unavailable"
    },
    {
      "name": "structural_completeness",
      "presence": "optional",
      "logical_type": "complete | partial | unknown | unsupported | stale"
    },
    {
      "name": "structural_freshness",
      "presence": "optional",
      "logical_type": "equivalent | changes_pending | degraded"
    },
    {
      "name": "structural_build_state",
      "presence": "optional",
      "logical_type": "not_started | building | idle | failed | disabled"
    },
    {
      "name": "semantic_availability",
      "presence": "optional",
      "logical_type": "available | unavailable"
    },
    {
      "name": "semantic_completeness",
      "presence": "optional",
      "logical_type": "complete | partial | unknown | unsupported | stale"
    },
    {
      "name": "semantic_build_state",
      "presence": "optional",
      "logical_type": "not_started | building | idle | failed | disabled"
    },
    {
      "name": "readiness_reason_codes",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "retry_after_ms",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "available_operations",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "blocked_operations",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "readiness",
      "presence": "optional",
      "logical_type": "WorkspaceReadinessView"
    },
    {
      "name": "operation_availability",
      "presence": "optional",
      "logical_type": "OperationAvailabilityView"
    }
  ],
  "IndexCandidateStatusView": [
    {
      "name": "candidate_generation_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "trigger_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "base_snapshot_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "target_registry_snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "target_configuration_revision_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "issue_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "created_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "analysis_started_at",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "ready_at",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "WorkspacePluginStatusView": [
    {
      "name": "plugin_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "activation_status",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "capability_declarations",
      "presence": "required",
      "logical_type": "Sequence<PluginCapabilityDeclaration>"
    }
  ],
  "WorkspaceCapabilityStatusView": [
    {
      "name": "capability",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "capability_contract_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "provider_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "provider_version",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "status",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "reason_codes",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "affected_artifact_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "availability",
      "presence": "optional",
      "logical_type": "available | unavailable"
    },
    {
      "name": "completeness",
      "presence": "optional",
      "logical_type": "complete | partial | unknown | unsupported | stale"
    },
    {
      "name": "build_state",
      "presence": "optional",
      "logical_type": "not_started | building | idle | failed | disabled"
    },
    {
      "name": "languages",
      "presence": "optional",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "retry_after_ms",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "publication_stage_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "publication_stage_ordinal",
      "presence": "optional",
      "logical_type": "Count"
    },
    {
      "name": "publication_stage_count",
      "presence": "optional",
      "logical_type": "Count"
    }
  ],
  "SemanticMaterializationStatusView": [
    {
      "name": "semantic_materialization_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "embedding_profile_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "materialization_state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "coverage_status",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "pending_document_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "pending_segment_count",
      "presence": "required",
      "logical_type": "Count"
    }
  ],
  "ActivationAttemptStatusView": [
    {
      "name": "activation_attempt_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "phase",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "candidate_generation_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "published_snapshot_id",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "issue_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "started_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "finished_at",
      "presence": "optional",
      "logical_type": "Text"
    }
  ],
  "ActivationIssueStatusView": [
    {
      "name": "issue_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "severity",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "phase",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "plugin_ids",
      "presence": "required",
      "logical_type": "Sequence<Text>"
    },
    {
      "name": "summary",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "required_action",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "retryable",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "created_at",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "CandidateIssueStatusView": [
    {
      "name": "candidate_issue_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "candidate_generation_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "issue_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "phase",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "severity",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "scope",
      "presence": "required",
      "logical_type": "CandidateIssueScope"
    },
    {
      "name": "retryability",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "summary",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "created_at",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "ActivationIssueStatusStreamPage": [
    {
      "name": "issues",
      "presence": "required",
      "logical_type": "Sequence<ActivationIssueStatusView>"
    },
    {
      "name": "total",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "next_cursor",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "previous_cursor",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "has_next",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "has_previous",
      "presence": "required",
      "logical_type": "Boolean"
    }
  ],
  "CandidateIssueStatusStreamPage": [
    {
      "name": "issues",
      "presence": "required",
      "logical_type": "Sequence<CandidateIssueStatusView>"
    },
    {
      "name": "total",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "next_cursor",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "previous_cursor",
      "presence": "optional",
      "logical_type": "Text"
    },
    {
      "name": "has_next",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "has_previous",
      "presence": "required",
      "logical_type": "Boolean"
    }
  ],
  "RetentionLease": [
    {
      "name": "retention_lease_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "holder_type",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "holder_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "acquired_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "last_renewed_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "idle_expires_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "absolute_expires_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "released_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "release_reason",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SnapshotRetentionPin": [
    {
      "name": "retention_pin_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "pin_kind",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "reason_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "source_reference",
      "presence": "required",
      "logical_type": "SourceReference"
    },
    {
      "name": "created_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "expires_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "released_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "release_reason",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SnapshotExpirationMarker": [
    {
      "name": "snapshot_expiration_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "expired_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "expiration_reason_code",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "garbage_collection_epoch_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "snapshot_digest",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "SnapshotRetentionStatus": [
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "snapshot_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "generation",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "availability",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "is_current",
      "presence": "required",
      "logical_type": "Boolean"
    },
    {
      "name": "active_pin_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "active_lease_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "retention_reasons",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "earliest_expiration_at",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "GarbageCollectionEpoch": [
    {
      "name": "garbage_collection_epoch_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "state",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "started_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "mark_completed_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "sweep_started_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "completed_at",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "workspace_boundaries",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "retention_root_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "candidate_object_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "candidate_object_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "deleted_object_count",
      "presence": "required",
      "logical_type": "Count"
    },
    {
      "name": "deleted_object_digest",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "failure_code",
      "presence": "required",
      "logical_type": "Text"
    }
  ],
  "WorkspaceGcBoundary": [
    {
      "name": "workspace_id",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "current_generation",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "minimum_retained_generation",
      "presence": "required",
      "logical_type": "Text"
    },
    {
      "name": "evaluated_at",
      "presence": "required",
      "logical_type": "Text"
    }
  ]
} as const;
