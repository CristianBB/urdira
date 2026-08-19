# Core Canonical Encoding Error Codes

Status: **Approved initial registry**  
Last updated: 2026-08-07  
Depends on: [Urdira Canonical Encoding](urdira-canonical-encoding.md) and the [universal data model](../decisions/01-universal-data-model.md)

## Registry contract

This file is authoritative for initial `CanonicalEncodingErrorCodeDefinition` values. These machine-readable errors describe canonical decoding, schema validation, recipe resolution, hashing, and resource-boundary failures. They are internal or administrative causes, not source `DiagnosticRecord` values and not public `OperationError.code` values.

Every definition has `definition_revision: 1`, `schema_version: 1`, and `lifecycle_state: active`. Deprecation, retirement, and replacement fields are omitted. Every details payload is a closed record. `phase` is one of `decode`, `normalize`, `schema_validation`, `recipe_validation`, `hash`, or `verify`.

Common detail fields use these exact meanings:

- `byte_offset` is a zero-based offset in the received UCE document.
- `schema_id` and `schema_version` select an exact canonical schema.
- `digest_domain` selects one exact registered semantic digest space.
- `comparator_id` and `comparator_version` select one exact immutable structural ordering contract.
- `digest_recipe_id` and `recipe_version` select an exact digest recipe.
- `external_verification_contract_id` and `external_verification_contract_version` select one exact retained provenance-verification contract.
- `value_path` is a canonical RFC 6901 JSON Pointer into the logical value.
- `limit_name`, `configured_limit`, and `observed_value` describe a bounded resource check; values are non-negative `SafeInteger` values.
- `expected_digest` and `actual_digest` are canonical `Digest` values.

## Definitions

| Code | Phase | Exact trigger | Required details | Optional details |
|---|---|---|---|---|
| `uce:trailing_data` | `decode` | A valid root CBOR item ends before the supplied byte sequence ends. | `byte_offset` | None |
| `uce:non_canonical_encoding` | `decode` | The input is valid within the UCE data model but uses a non-minimal integer, length, tag, float width, or incorrect deterministic map-key order. | `byte_offset`, `canonicality_kind` | `value_path` |
| `uce:forbidden_cbor_feature` | `decode` | The input uses an indefinite length, unknown tag, shared reference, embedded CBOR, forbidden simple value, non-finite float, or another CBOR feature excluded by UCE v1. | `byte_offset`, `feature_kind` | `value_path` |
| `uce:duplicate_map_key` | `decode` | One map contains the same decoded key more than once. | `byte_offset`, `duplicate_key` | `value_path` |
| `uce:invalid_utf8` | `decode` | A CBOR text string contains malformed, overlong, truncated, or otherwise invalid UTF-8 bytes. | `byte_offset` | `value_path` |
| `uce:invalid_unicode_scalar` | `normalize` | A public or in-memory text value contains a lone surrogate or another value that is not a Unicode scalar. | `value_path` | None |
| `uce:unsupported_encoding_version` | `decode`, `recipe_validation`, `verify` | The digest envelope or retained contract selects a UCE version the engine cannot interpret losslessly. | `canonical_encoding_version`, `supported_encoding_versions` | `digest_recipe_id`, `recipe_version` |
| `uce:unsupported_hash_algorithm` | `recipe_validation`, `hash`, `verify` | A recipe or digest selects a hash algorithm unsupported by the active engine contract. | `hash_algorithm`, `supported_hash_algorithms` | `digest_recipe_id`, `recipe_version` |
| `uce:unknown_schema` | `schema_validation`, `verify` | No schema with the requested exact `schema_id` exists in the pinned registry snapshot. | `schema_id`, `registry_snapshot_id` | None |
| `uce:unsupported_schema_version` | `schema_validation`, `verify` | The schema identifier exists but its requested version is unavailable in the pinned registry snapshot or decoder set. | `schema_id`, `schema_version`, `available_schema_versions` | `registry_snapshot_id` |
| `uce:schema_validation_failed` | `schema_validation` | A logical value violates its selected closed schema after public normalization. | `schema_id`, `schema_version`, `value_path`, `validation_kind` | `expected_type`, `actual_type`, `constraint_name` |
| `uce:unknown_digest_domain` | `recipe_validation`, `verify` | A recipe selects a digest domain absent from the pinned registry snapshot. | `digest_domain`, `registry_snapshot_id` | `digest_recipe_id`, `recipe_version` |
| `uce:unknown_canonical_comparator` | `schema_validation`, `recipe_validation`, `verify` | A schema or ordered set selects a comparator lineage absent from the pinned registry snapshot. | `comparator_id`, `registry_snapshot_id` | `schema_id`, `schema_version` |
| `uce:unsupported_canonical_comparator_version` | `schema_validation`, `recipe_validation`, `verify` | The comparator lineage exists but the requested immutable ordering version is unavailable. | `comparator_id`, `comparator_version`, `available_comparator_versions` | `registry_snapshot_id`, `schema_id`, `schema_version` |
| `uce:unknown_digest_recipe` | `recipe_validation`, `verify` | No recipe with the requested exact identifier exists in the pinned registry snapshot. | `digest_recipe_id`, `registry_snapshot_id` | None |
| `uce:unsupported_digest_recipe_version` | `recipe_validation`, `verify` | The recipe identifier exists but its requested immutable version is unavailable. | `digest_recipe_id`, `recipe_version`, `available_recipe_versions` | `registry_snapshot_id` |
| `uce:digest_recipe_cycle` | `recipe_validation` | The complete candidate recipe graph contains a direct or indirect `referenced_digest` cycle. | `cycle_path` | `registry_snapshot_id` |
| `uce:digest_binding_invalid` | `recipe_validation` | A binding reads the target digest, writes a payload field twice, omits a required payload field, selects an invalid source path, or contradicts its selected value mode. | `digest_recipe_id`, `recipe_version`, `binding_failure_kind` | `source_path`, `payload_field` |
| `uce:unknown_digest_reference` | `recipe_validation`, `verify` | The selected target digest field has no exact `DigestReferenceDefinition` in the pinned registry snapshot. | `target_schema_id`, `target_field`, `registry_snapshot_id` | `digest_reference_id` |
| `uce:digest_reference_invalid` | `recipe_validation` | A digest reference is ambiguous, cannot locate its authoritative model, fails its external verifier contract, forms a cycle, or does not terminate at the declared computation recipe. | `digest_reference_id`, `digest_reference_failure_kind` | `target_schema_id`, `target_field`, `source_digest_recipe_id`, `source_digest_recipe_version` |
| `uce:unknown_external_verification_contract` | `recipe_validation`, `verify` | An external-asset reference selects a verifier lineage absent from the pinned registry snapshot. | `external_verification_contract_id`, `registry_snapshot_id` | `digest_reference_id` |
| `uce:unsupported_external_verification_contract_version` | `recipe_validation`, `verify` | The verifier lineage exists but the requested immutable contract version or retained implementation is unavailable. | `external_verification_contract_id`, `external_verification_contract_version` | `registry_snapshot_id`, `digest_reference_id` |
| `uce:numeric_value_out_of_range` | `normalize`, `schema_validation` | A number is non-finite, exceeds the selected logical type or schema bounds, has a forbidden decimal representation, or cannot preserve its required scale. | `value_path`, `numeric_type`, `range_failure_kind` | `minimum`, `maximum`, `actual_value` |
| `uce:digest_mismatch` | `verify` | Recomputing the selected recipe over verified logical input produces a digest different from the supplied or stored value. | `digest_recipe_id`, `recipe_version`, `expected_digest`, `actual_digest` | `value_path` |
| `uce:resource_limit_exceeded` | all six phases | Decoding, normalization, ordering, hashing, or verification would exceed an explicit configured safety limit before the value can be accepted. | `phase`, `limit_name`, `configured_limit`, `observed_value` | `value_path` |

## Closed detail values

- `canonicality_kind`: `INTEGER_WIDTH`, `LENGTH_WIDTH`, `TAG_WIDTH`, `FLOAT_WIDTH`, `MAP_KEY_ORDER`, or `DECIMAL_FORM`.
- `feature_kind`: `INDEFINITE_LENGTH`, `UNKNOWN_TAG`, `SHARED_REFERENCE`, `EMBEDDED_CBOR`, `UNDEFINED`, `UNASSIGNED_SIMPLE_VALUE`, `NON_FINITE_FLOAT`, or `NEGATIVE_ZERO`.
- `validation_kind`: `TYPE_MISMATCH`, `REQUIRED_FIELD_MISSING`, `UNKNOWN_FIELD`, `NULL_FORBIDDEN`, `ENUM_VALUE_INVALID`, `DUPLICATE_SET_ELEMENT`, `COLLECTION_SIZE_INVALID`, `TEXT_LENGTH_INVALID`, `BYTES_LENGTH_INVALID`, `TIMESTAMP_INVALID`, `CONSTRAINT_FAILED`, or `REFERENCE_INVALID`.
- `binding_failure_kind`: `SELF_REFERENCE`, `SOURCE_PATH_INVALID`, `PAYLOAD_FIELD_UNKNOWN`, `PAYLOAD_FIELD_DUPLICATE`, `PAYLOAD_FIELD_MISSING`, `VALUE_MODE_INVALID`, or `REFERENCED_RECIPE_INVALID`.
- `digest_reference_failure_kind`: `SOURCE_NOT_FOUND`, `SOURCE_AMBIGUOUS`, `LOCATOR_INVALID`, `EXTERNAL_VERIFIER_UNAVAILABLE`, `EXTERNAL_VERIFICATION_FAILED`, `REFERENCE_CYCLE`, or `TERMINAL_RECIPE_MISMATCH`.
- `numeric_type`: `safe_integer`, `big_integer`, `float64`, or `exact_decimal`.
- `range_failure_kind`: `BELOW_MINIMUM`, `ABOVE_MAXIMUM`, `SAFE_INTEGER_OVERFLOW`, `NON_FINITE`, `DECIMAL_SYNTAX`, or `DECIMAL_SCALE`. Public negative zero is normalized to positive zero; encoded negative zero uses `uce:forbidden_cbor_feature`.

`uce:resource_limit_exceeded` is the only definition whose phase is supplied by the occurrence; it must be the exact phase where work stopped. No code is a generic catch-all. Implementations must choose the most specific applicable definition.

## Mapping to surrounding registries

- Plugin runtime negotiation that cannot supply required UCE support emits `PLUGIN_CONTRACT_INCOMPATIBLE`.
- Invalid contributed schemas, domains, comparators, verifier contracts, recipes, references, duplicate lineage ownership, or dependency cycles emit `REGISTRY_CONTRIBUTION_INVALID` with the UCE code in bounded validation details.
- Candidate record schema failures emit `core:record_schema_invalid`.
- Candidate and projection digest disagreement use `core:candidate_digest_mismatch` or `core:projection_digest_mismatch`.
- A public operation that cannot interpret retained contracts emits `core:index_contract_unsupported`.
- A public operation encountering verified corruption emits `core:index_integrity_failed`, unless a narrower optional-capability error governs the failed stage.
