# Core Candidate Issue Codes

Status: **Approved initial registry**  
Last updated: 2026-08-08  
Governing model: [Universal data model](../decisions/01-universal-data-model.md)

## Purpose

This registry defines every initial `core:*` `CandidateIssueCodeDefinition` accepted by `CandidateIssue`. Candidate issues describe indexing control-plane attempts and never replace source-owned `DiagnosticRecord` knowledge. Payloads are closed: fields not listed for the selected code are rejected.

Every definition has `definition_revision: 1`, `schema_version: 1`, and `lifecycle_state: active`; `plugin_owner`, deprecation, retirement, and replacement fields are omitted. The exact trigger column is the normative `description`, including the condition under which the code may be emitted and the event it must not be generalized beyond.

Common field types:

- Every `*_id` is a non-empty opaque identifier of the named model.
- Every digest is a canonical UCE `Digest` governed by the snapshot-pinned computation or reference contract.
- Counts are non-negative integers unless explicitly required to be positive.
- Identifier arrays are deduplicated and deterministically ordered.
- `representative_artifact_ids` is bounded diagnostic context and never claims to be the complete affected set.

## Planning codes

| Code | Exact trigger | Severity | Retryability | Required payload | Optional payload |
|---|---|---|---|---|---|
| `core:invalidation_plan_incomplete` | The planner cannot prove that every record or projection affected by the candidate seeds is covered, even after applying registered fallback scopes. | `error` | `replan` | `invalidation_plan_id`, positive `unresolved_scope_count`, non-empty `reason_codes`, `fallback_attempted` | `representative_artifact_ids` |
| `core:work_manifest_inconsistent` | The frozen work manifest violates a structural or context invariant. | `error` | `replan` | `work_manifest_id`, `invariant_code`, non-empty `work_item_ids` | `json_pointer` |
| `core:source_observation_conflict` | Two accepted observations cannot both be true under one provider ordering and coverage contract. | `error` | `replan` | `artifact_id`, at least two `source_observation_ids`, `conflict_kind` | `provider_sequence_values` |
| `core:source_input_unavailable` | A required exact artifact version cannot be read or verified for candidate analysis. | `error` | `replan` | `artifact_id`, `source_observation_id`, `availability_code` | `provider_error_code` |
| `core:source_provider_state_changed` | An `enumerate`, `read`, or `reconcile` call returns `source_changed`, so its requested frozen source view cannot be accepted. | `warning` | `replan` | `request_id`, `source_provider_binding_id`, `call`, `request_digest` | `provider_error_code` |
| `core:source_provider_unavailable` | A required `describe`, `enumerate`, `read`, `watch`, or `reconcile` call returns `unavailable` while constructing or refreshing the candidate. | `error` | `retry_same` | `request_id`, `source_provider_binding_id`, `call`, `request_digest` | `provider_error_code`, `provider_detail_code` |
| `core:source_provider_deadline_exceeded` | A required source-provider call returns `deadline_exceeded` before a complete valid result is accepted. | `error` | `retry_same` | `request_id`, `source_provider_binding_id`, `call`, positive `timeout_ms` | `provider_error_code` |
| `core:source_provider_resource_exhausted` | A required source-provider call returns `resource_exhausted` for one exact resource limit. | `error` | `retry_same` | `request_id`, `source_provider_binding_id`, `call`, `resource_kind`, `configured_limit`, `observed_or_required` | `provider_error_code` |
| `core:source_provider_failed` | A required source-provider call returns `failed` and no more specific source-provider code applies. | `error` | `retry_same` | `request_id`, `source_provider_binding_id`, `call`, `provider_error_code` | `provider_detail_code` |
| `core:analysis_context_unavailable` | A frozen registry, configuration, plugin resolution, analyzer package, or required plugin dependency cannot be loaded and verified. | `error` | `replan` | `missing_context_kind`, `missing_context_id` | `plugin_id`, `plugin_version` |

Closed values:

- `work_manifest_inconsistent.invariant_code`: `DUPLICATE_WORK_ITEM`, `INVALID_ARTIFACT_TRANSITION`, `SCOPE_NOT_COVERED`, `DIGEST_MISMATCH`, `DIGEST_CONTRACT_MISMATCH`, or `CONTEXT_MISMATCH`.
- `source_observation_conflict.conflict_kind`: `STATE_MISMATCH`, `SEQUENCE_REGRESSION`, `TOKEN_REUSE`, or `COVERAGE_CONTRADICTION`.
- `source_input_unavailable.availability_code`: `READ_FAILED`, `PROVIDER_UNAVAILABLE`, `CONTENT_CHANGED_DURING_READ`, or `CONTENT_VERIFICATION_FAILED`.
- Source-provider `call` is exactly `describe`, `enumerate`, `read`, `watch`, or `reconcile`. `source_provider_state_changed` permits only `enumerate`, `read`, or `reconcile`; a watch hint cannot freeze source state. `source_provider_resource_exhausted.resource_kind` is `deadline`, `response_bytes`, `observations`, or `watch_events`. Counts and limits are non-negative integers and `configured_limit` is positive.
- A provider `cancelled` outcome caused by candidate cancellation creates no standalone issue because cancellation is already the candidate terminal cause. A cancellation not matching the candidate cancellation identity is invalid protocol output and maps to `core:source_provider_failed` with a registered protocol error code.
- `core:source_input_unavailable` is emitted only after a successful observation selected an exact artifact but a required stable read cannot be obtained through the permitted replanning/retry policy. The five `core:source_provider_*` codes describe individual protocol-call outcomes and therefore take precedence for their originating occurrence.
- `analysis_context_unavailable.missing_context_kind`: `REGISTRY_SNAPSHOT`, `CONFIGURATION_REVISION`, `PLUGIN_RESOLUTION`, `PLUGIN_PACKAGE`, `PLUGIN_DEPENDENCY`, `RUNTIME_COMPONENT`, `CANONICAL_ENCODING_CONTRACT`, `DIGEST_RECIPE`, or `DIGEST_REFERENCE`.

## Analysis codes

| Code | Exact trigger | Severity | Retryability | Required payload | Optional payload |
|---|---|---|---|---|---|
| `core:analyzer_failed` | A registered analyzer terminates without producing a valid complete delta for its work item. | `error` | `reanalyze` | `work_item_id`, `plugin_id`, `plugin_version`, `analyzer_error_code`, `failure_stage` | `provider_detail_code` |
| `core:analyzer_timeout` | Analyzer execution exceeds the configured work-item deadline. | `error` | `reanalyze` | `work_item_id`, `plugin_id`, positive `timeout_ms`, non-negative `elapsed_ms` | None |
| `core:plugin_inputs_incomplete` | A plugin request requires a source root or provider capability that the pinned analysis view cannot represent; ordinary undeclared cross-file reads do not qualify. | `error` | `replan` | `request_id`, `plugin_id`, `call`, `missing_input_kind` | `missing_input_reference` |
| `core:plugin_unsupported` | The negotiated plugin build explicitly does not implement the requested registered call/capability combination although activation selected it. | `error` | `not_retryable` | `request_id`, `plugin_id`, `call`, `capability` | `provider_detail_code` |
| `core:plugin_cancelled` | The candidate or request cancellation identity is observed before a complete response is accepted. | `warning` | `retry_same` | `request_id`, `plugin_id`, `call`, `cancellation_id` | None |
| `core:plugin_resource_exhausted` | A plugin request exceeds one exact `PluginResourceBudget` component before complete output is accepted. | `error` | `reanalyze` | `request_id`, `plugin_id`, `call`, `resource_kind`, `configured_limit`, `observed_or_required` | None |
| `core:plugin_failed` | A plugin call other than the more specific analyzer/projection failures terminates without a complete valid response. | `error` | `retry_same` | `request_id`, `plugin_id`, `call`, `failure_code` | `provider_detail_code` |
| `core:required_delta_missing` | Analysis finishes but no accepted delta covers one or more expected replacement scopes. | `error` | `reanalyze` | `work_item_id`, non-empty `replacement_scope_ids` | `received_fact_delta_ids` |
| `core:delta_id_conflict` | The same `fact_delta_id` is received with a digest different from the already accepted digest. | `error` | `not_retryable` | `fact_delta_id`, `accepted_digest`, `conflicting_digest` | `work_item_id` |

`failure_stage` is `startup`, `input_loading`, `parsing`, `semantic_analysis`, `output_generation`, or `shutdown`. Analyzer and provider detail codes are producer-owned bounded strings and do not alter core retry semantics.

`plugin_inputs_incomplete.missing_input_kind` is `source_root` or `provider_capability`. `plugin_resource_exhausted.resource_kind` is `deadline`, `memory_bytes`, `output_bytes`, `records`, `dependencies`, `context_operations`, `context_bytes`, or `recursion_depth`. `call` in all five codes is one of the four worker calls. Cancellation caused by abandonment of the entire candidate may terminate it rather than retry; the occurrence retryability still describes the same frozen request.

The five `core:plugin_*` protocol-outcome codes allow `planning` for `discover_partitions`, `analysis` for `analyze_artifact`, and `projection` for `generate_projection`; `describe` failure occurs before a candidate work call and maps to `core:analysis_context_unavailable` instead. The occurrence phase must match its call. More specific analyzer timeout/failure and projection generator codes take precedence when their exact triggers apply.

## Validation codes

| Code | Exact trigger | Severity | Retryability | Required payload | Optional payload |
|---|---|---|---|---|---|
| `core:delta_base_mismatch` | A delta names a base snapshot different from its candidate or work item. | `error` | `replan` | `fact_delta_id`, `expected_base_snapshot_id`, `actual_base_snapshot_id` | None |
| `core:delta_scope_mismatch` | Delta owner, plugin, version, capability, or replacement scope exceeds or contradicts its work item. | `error` | `not_retryable` | `fact_delta_id`, `work_item_id`, `mismatch_kind` | `replacement_scope_id` |
| `core:undeclared_input` | A proposal references an artifact version, base record, or staged record absent from the core-observed accepted access manifest or its proved transitive closure. | `error` | `not_retryable` | `fact_delta_id`, `input_type`, non-empty `undeclared_ids` | `proposal_record_key` |
| `core:record_schema_invalid` | A proposed record fails its registered envelope, kind, category-body, payload Schema IR, or canonical logical-type constraints. | `error` | `not_retryable` | `fact_delta_id`, `proposal_record_key`, `kind`, `schema_version`, positive `validation_error_count` | `json_pointers`, `uce_error_codes` |
| `core:unregistered_identifier` | A proposal uses a kind, facet, role, code, capability, dependency role, or other registry identifier absent from the target registry. | `error` | `not_retryable` | `fact_delta_id`, `proposal_record_key`, `identifier_type`, `identifier` | None |
| `core:reference_validation_failed` | A proposed reference cannot satisfy its declared or governing target contract. | `error` | `not_retryable` | `fact_delta_id`, `proposal_record_key`, `reference_path`, `reference_failure_kind` | `target_id`, `candidate_identity_keys` |
| `core:dependency_validation_failed` | A proposed or derived artifact dependency is undeclared, inconsistent, unregistered, or cannot be closed deterministically. | `error` | `not_retryable` | `fact_delta_id`, `proposal_record_key`, `dependency_failure_kind` | `dependency_artifact_id`, `dependency_artifact_version_id`, `dependency_role` |
| `core:replacement_scope_incomplete` | A delta claiming complete replacement omits required output, coverage claims, or scope partitions. | `error` | `reanalyze` | `fact_delta_id`, `replacement_scope_id`, `incompleteness_kind` | `missing_proposal_keys`, `missing_partition_keys`, `missing_capabilities` |
| `core:identity_assignment_conflict` | Core identity resolution cannot produce one legal created or continued assignment. | `error` | `replan` | `identity_type`, `identity_key_digest`, `conflict_kind` | `identity_ids`, `record_ids`, `proposal_record_keys` |
| `core:candidate_digest_mismatch` | Recomputed candidate content does not match its frozen `candidate_digest`. | `error` | `replan` | `candidate_generation_id`, `expected_digest`, `actual_digest`, `digest_component` | None |

`core:candidate_digest_mismatch` permits phases `validation` and `publication`. Validation is legal only while sealing or recovering an already sealed ready materialization; publication is legal only during pre-transaction digest verification. It is forbidden before `candidate_digest` exists and cannot describe a generation-dependent digest computed inside a rolled-back transaction.

Closed values:

- `delta_scope_mismatch.mismatch_kind`: `OWNER_ARTIFACT`, `OWNER_VERSION`, `PLUGIN_ID`, `PLUGIN_VERSION`, `CAPABILITY`, `REPLACEMENT_SCOPE`, or `ANALYSIS_CONTEXT`.
- `undeclared_input.input_type`: `artifact_version`, `base_record`, or `staged_record`.
- `unregistered_identifier.identifier_type`: `canonical_schema`, `digest_domain`, `canonical_comparator`, `external_verification_contract`, `runtime_component`, `digest_recipe`, `digest_reference`, `language`, `capability_contract`, `construct_class`, `capability_limitation`, `record_kind`, `universal_kind`, `facet`, `relation_role`, `semantic_role`, `metric`, `effect`, `diagnostic_code`, `candidate_issue_code`, `dependency_role`, `projection_kind`, `lifecycle_reason`, `completeness_reason`, `semantic_section_kind`, `semantic_reason`, `embedding_profile`, `evidence_assumption`, or `evidence_explanation`.
- For `relation_role`, `identifier` is the local role name resolved under the proposal's already selected `relation_kind`; it is the only value in this list that is not a global typed-registry lineage.
- `reference_validation_failed.reference_failure_kind`: `TARGET_MISSING`, `TARGET_OUTSIDE_INPUTS`, `TARGET_TYPE_MISMATCH`, `TARGET_KIND_MISMATCH`, `TARGET_FACET_MISMATCH`, `BASE_RECORD_CLOSING`, or `AMBIGUOUS_FOR_REQUIRED_EXACT`.
- `dependency_validation_failed.dependency_failure_kind`: `UNDECLARED_ARTIFACT_INPUT`, `VERSION_MISMATCH`, `ROLE_UNREGISTERED`, `TRANSITIVE_CLOSURE_FAILED`, or `DEPENDENCY_DIGEST_MISMATCH`.
- `replacement_scope_incomplete.incompleteness_kind`: `MISSING_OUTPUT`, `MISSING_PARTITION`, `MISSING_COMPLETENESS_CLAIM`, or `BASE_SET_DIGEST_MISMATCH`.
- `identity_assignment_conflict.conflict_kind`: `MULTIPLE_ACTIVE_MATCHES`, `DUPLICATE_CREATED_ID`, `CONTINUATION_PREDECESSOR_MISMATCH`, or `CLOSED_ID_REUSE`.
- `candidate_digest_mismatch.digest_component`: `INPUTS`, `WORK_MANIFEST`, `FACT_DELTAS`, `ANALYSIS_CONTEXT`, or `MATERIALIZATION`.
- `record_schema_invalid.uce_error_codes` is an optional deduplicated bounded array of exact `uce:*` causes corresponding one-to-one with the reported validation failures. It never replaces the exact `json_pointers` when those paths are available.

## Projection codes

| Code | Exact trigger | Severity | Retryability | Required payload | Optional payload |
|---|---|---|---|---|---|
| `core:projection_generator_failed` | A registered projection generator cannot finish its work item. | `error` | `retry_same` | `projection_work_item_id`, `projection_kind`, `generator`, `generator_version`, `generator_error_code` | `provider_detail_code` |
| `core:projection_output_invalid` | Generated output violates projection schema, ownership, source, key, or visibility invariants. | `error` | `not_retryable` | `projection_work_item_id`, `projection_kind`, `validation_kind`, positive `invalid_projection_count` | `projection_record_ids`, `source_record_ids` |
| `core:projection_digest_mismatch` | The complete generated projection set does not match the computed expected digest. | `error` | `retry_same` | `projection_work_item_id`, `expected_digest`, `actual_digest` | `projection_record_id` |

`projection_output_invalid.validation_kind` is `SCHEMA_INVALID`, `OWNER_MISMATCH`, `SOURCE_SET_EMPTY`, `SOURCE_NOT_VISIBLE`, `KEY_COLLISION`, or `UNDECLARED_SOURCE`.

## Publication and lifecycle codes

| Code | Exact trigger | Severity | Retryability | Required payload | Optional payload |
|---|---|---|---|---|---|
| `core:base_snapshot_changed` | Publication sees a different current snapshot from the candidate base. The candidate becomes stale. | `warning` | `replan` | `expected_base_snapshot_id`, `current_snapshot_id` | None |
| `core:base_registry_changed` | Publication sees a different current registry from the candidate base. The candidate becomes stale. | `warning` | `replan` | `expected_registry_snapshot_id`, `current_registry_snapshot_id` | None |
| `core:base_configuration_changed` | Publication sees a different current configuration from the candidate base. The candidate becomes stale. | `warning` | `replan` | `expected_configuration_revision_id`, `current_configuration_revision_id` | None |
| `core:publication_conflict` | A uniqueness, compare-and-swap, generation, identity, or prior-publication conflict prevents this candidate from committing. | `error` | `replan` | `workspace_id`, `conflict_kind` | `conflicting_id`, `current_snapshot_id` |
| `core:atomic_publication_failed` | The storage transaction cannot install the complete candidate tuple atomically. | `error` | `retry_same` | `publication_step`, `storage_cause_code`, `transaction_rolled_back` | `recovery_operation_id` |
| `core:candidate_cleanup_failed` | Candidate-private materialization or an ended lease cannot be cleaned after the candidate reaches a terminal state. | `warning` | `retry_same` | `resource_type`, `resource_id`, `cleanup_operation`, `cleanup_error_code` | None |

Closed values:

- `publication_conflict.conflict_kind`: `CURRENT_POINTER_CAS_FAILED`, `GENERATION_ALREADY_ASSIGNED`, `MANIFEST_ALREADY_PUBLISHED`, `IDENTITY_ASSIGNMENT_COLLISION`, or `UNIQUE_INDEX_CONFLICT`.
- `atomic_publication_failed.publication_step`: `BEGIN`, `VALIDATE_BASE`, `INSTALL_SOURCE_STATE`, `INSTALL_CANONICAL`, `INSTALL_PROJECTIONS`, `INSTALL_MANIFEST`, `SWAP_CURRENT_POINTER`, or `COMMIT`.
- `transaction_rolled_back` is a required boolean. If rollback cannot be established, the workspace enters a recovery-required control-plane state and the same candidate is not retried blindly.
- `candidate_cleanup_failed.resource_type`: `candidate_materialization`, `retention_lease`, `temporary_projection`, or `temporary_blob`.
- `candidate_cleanup_failed.cleanup_operation`: `release`, `delete`, or `compact`.

## Extension rule

Core may add a code only in a new candidate-issue registry contract revision. Plugins may register codes only in their canonical namespace. Activation validates collisions, exact payload schemas, allowed phases, severities, retryability values, and summaries before any namespaced candidate issue can be emitted.
