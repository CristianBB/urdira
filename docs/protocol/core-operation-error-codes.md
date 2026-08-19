# Core Operation Error Codes

Status: **Approved initial registry**  
Last updated: 2026-08-08  
Depends on: [Universal data model](../decisions/01-universal-data-model.md), [Query algebra and public API](../decisions/03-query-algebra-public-api.md), and [Semantic search and ranking](../decisions/06-semantic-search-ranking.md)

## Registry contract

This file is authoritative for the complete initial set of core `OperationErrorCodeDefinition` values.

Every details payload is a closed object. Fields not listed by the selected code are rejected. An operation error is protocol state, not canonical knowledge and not a `DiagnosticRecord`.

Every definition has `definition_revision: 1`, `schema_version: 1`, `lifecycle_state: active`, and no deprecation, retirement, or replacement fields. The registry is core-only under the initial public API contract; a future extension mechanism requires an explicit query-API contract revision.

## Common initial definitions

The following table is normative. `Details fields` is the complete closed details object for that code; `none` means `details` is omitted. Every identifier is a non-empty string, every list is deterministically ordered and duplicate-free, counts and byte or time values are non-negative integers, and field names ending in `_ms` are milliseconds.

| Code | Exact trigger | Retryable | Recovery actions | Details fields |
|---|---|---:|---|---|
| `core:request_invalid` | Input is not an instance of the selected closed request schema after JSON decoding. | no | `correct_request` | `schema_pointer`, `violation` |
| `core:api_version_unsupported` | `api_version` is syntactically valid but not one of the server's exact supported versions. | no | `select_supported_version` | `requested_version`, `supported_versions[]` |
| `core:unknown_field` | A closed request object contains at least one undeclared field. | no | `remove_unknown_fields` | `object_pointer`, `field_names[]` |
| `core:option_conflict` | Individually valid options violate a documented presence or interaction rule. | no | `correct_request` | `option_pointers[]`, `rule_code` |
| `core:budget_invalid` | An item, character, depth, work, or wait budget is zero, negative, above the advertised maximum, or illegal for the selected operation. | no | `use_advertised_budget` | `budget_field`, `provided`, `minimum`, `maximum` |
| `core:workspace_not_registered` | An explicit API v2 workspace root has no exact registered workspace after canonicalization. | no | `register_workspace` | `registration_command` |
| `core:workspace_not_found` | An explicit workspace ID has no registered workspace. | no | `inspect_index_status`, `register_workspace` | `workspace_id` |
| `core:duplicate_comparison_participant` | A comparison duplicates a role or exact workspace-snapshot coordinate, or repeats one workspace without distinct explicit snapshots. | no | `correct_scope` | `workspace_id`, `snapshot_ids[]`, `roles[]`, `participant_ordinals[]` |
| `core:participant_role_invalid` | A required role is missing, duplicated, unknown, or illegal for the selected operation. | no | `correct_scope` | `operation`, `provided_roles[]`, `required_roles[]` |
| `core:snapshot_not_found` | An explicit snapshot ID is unknown or belongs to another workspace. | no | `inspect_index_status`, `select_snapshot` | `workspace_id`, `snapshot_id` |
| `core:snapshot_expired` | The snapshot identity is known but its queryable payload has been collected. | no | `select_retained_snapshot`, `reexecute_current` | `workspace_id`, `snapshot_id`, `generation`, `expired_at` |
| `core:scope_mismatch` | Explicit continuation scope differs from the execution's ordered workspace IDs, comparison roles, or snapshot selectors. | no | `use_original_scope` | `query_execution_id`, `expected_scope_digest`, `provided_scope_digest` |
| `core:operation_unknown` | No operation definition exists for the exact identifier under the selected API version. | no | `select_supported_operation` | `operation`, `api_version` |
| `core:recipe_unknown` | No recipe exists for the exact recipe ID. | no | `select_supported_recipe` | `recipe_id` |
| `core:recipe_version_unsupported` | The recipe exists but the requested exact version is unsupported. | no | `select_supported_recipe_version` | `recipe_id`, `requested_version`, `supported_versions[]` |
| `core:stage_reference_invalid` | A stage input names a missing, later, or non-output stage coordinate. | no | `correct_pipeline` | `stage_id`, `input_ordinal`, `referenced_stage_id`, `referenced_output` |
| `core:stage_type_mismatch` | An existing stage output type cannot satisfy the receiving operator input type. | no | `correct_pipeline` | `stage_id`, `input_ordinal`, `actual_type`, `expected_types[]` |
| `core:selector_invalid` | A kind, facet, path, regex, namespace, registry, relation, or evidence selector violates its closed grammar or registry constraints. | no | `correct_selector`, `discover_definitions` | `selector_pointer`, `reason_code`, `definition_ids[]` |
| `core:selector_not_found` | A recipe guard requiring one existing confirmed subject receives no confirmed subject. | no | `correct_selector`, `discover_definitions`, `inspect_completeness` | `recipe_id`, `stage_id`, `selector_pointer`, `possible_candidate_ids[]` |
| `core:selector_ambiguous` | A recipe guard requiring one confirmed subject receives more than one confirmed subject. | no | `add_symbol_context`, `select_exact_subject` | `recipe_id`, `stage_id`, `selector_pointer`, `confirmed_candidate_ids[]`, `possible_candidate_ids[]` |
| `core:invalid_query_scope` | A recipe's closed scope guard rejects an otherwise schema-valid query scope. | no | `correct_scope` | `recipe_id`, `required_scope_kind`, `required_roles[]`, `provided_scope_kind`, `provided_roles[]` |
| `core:invalid_definition_instance_selector` | `core:definition_to_instances` receives a selected definition family other than record kind, facet, or language. Empty exact discovery is valid and does not trigger this code. | no | `correct_selector`, `discover_definitions` | `recipe_id`, non-empty `definition_ids[]`, non-empty `definition_types[]`, `reason_code` |
| `core:registry_definition_unavailable` | A request references a definition absent from at least one required pinned registry. | no | `discover_definitions`, `select_available_definition` | `definition_id`, `definition_type`, `registry_snapshot_ids[]` |
| `core:required_capability_unsupported` | A mandatory operation capability is unsupported in at least one selected scope and the operation defines no accepted fallback. | no | `inspect_index_status`, `select_supported_scope` | `capability`, `workspace_snapshot_binding_ids[]`, `reason_codes[]` |
| `core:freshness_wait_timeout` | `wait_for_current` reaches its explicit timeout before every participant has an equivalent freshness checkpoint. | yes | `retry_after_progress`, `increase_wait_limit`, `accept_current` | `workspace_ids[]`, `waited_ms`, `pending_observation_counts[]`, `retry_after_ms?` |
| `core:coverage_incomplete` | `require_complete` reaches its wait boundary while a non-semantic required capability remains non-complete. | yes | `retry_after_progress`, `accept_reported_coverage`, `inspect_index_status` | `capabilities[]`, `workspace_snapshot_binding_ids[]`, `statuses[]`, `waited_ms` |
| `core:execution_resource_limit` | Exact evaluation cannot finish within a declared hard work, memory, time, or intermediate-result limit. | conditional | `increase_limit`, `narrow_scope`, `split_investigation` | `limit_kind`, `configured_limit`, `observed_or_required`, `stage_id?` |
| `core:operation_cancelled` | Caller cancellation is observed before a ready manifest is published. | yes | `retry_operation` | `stage_id?` |
| `core:execution_failed` | An unexpected core execution failure prevents a trustworthy manifest and no narrower registered code applies. | conditional | `retry_operation`, `inspect_daemon_status` | `failure_id`, `phase` |
| `core:index_unavailable` | A required workspace has no published queryable snapshot. | yes | `wait_for_index`, `inspect_index_status`, `reindex` | `workspace_id`, `index_state`, `candidate_generation_id?` |

| `core:daemon_restart_required` | `urdira mcp` detects a live daemon for the selected data root whose engine build or private interface is incompatible, and safe coordinated replacement cannot proceed. No domain request is forwarded. | conditional | `wait_for_active_work`, `restart_urdira`, `use_matching_urdira_version`, `inspect_daemon_status` | `data_root_id`, `detected_engine_build_id`, `required_engine_build_id`, `blocking_reason`, `safe_automatic_restart` |
| `core:cursor_invalid` | Cursor decoding, authentication, required claims, or execution lookup fails and expiry is not established. | no | `reexecute_query` | `reason_code` |
| `core:cursor_expired` | The cursor's execution lifetime has ended. | no | `reexecute_query` | `query_execution_id`, `expired_at` |
| `core:query_execution_evicted` | The execution expired early under an explicitly advertised emergency-eviction policy. | no | `reexecute_query` | `query_execution_id`, `evicted_at`, `reason_code` |
| `core:cursor_kind_mismatch` | A query cursor is supplied to index-status continuation or an index-status cursor is supplied to query continuation. No execution hydration is attempted. | no | `use_matching_continuation` | `expected_cursor_kind`, `actual_cursor_kind`, `execution_id` |
| `core:cursor_stream_mismatch` | A cursor is supplied to an endpoint or continuation variant that cannot hydrate its selected stream. | no | `use_query_continuation` | `query_execution_id`, `result_stream` |
| `core:cursor_projection_mismatch` | Continuation attempts to change a result, evidence, diagnostic, registry, semantic-coverage, snippet, or status projection fixed by the cursor. | no | `use_original_projection`, `reexecute_query` | `execution_id`, `expected_projection_digest`, `provided_projection_digest` |
| `core:query_embedding_failed` | A mandatory semantic lane cannot create the exact query vector under its pinned executable binding. | yes | `retry_operation`, `restore_generator`, `inspect_semantic_coverage` | `semantic_lane_id`, `embedding_profile_id`, `failure_code` |
| `core:source_unavailable` | Hydration cannot read a source blob required by a selected result from its retained snapshot. | conditional | `verify_index`, `restore_verified_data`, `reexecute_without_snippets` | `workspace_snapshot_binding_id`, `artifact_id`, `artifact_version_id`, `content_digest` |
| `core:snippet_budget_impossible` | The requested mandatory snippet projection cannot emit even one valid unit within the supplied character budget. | no | `increase_budget`, `reduce_snippet_projection` | `required_minimum_characters`, `provided_max_characters` |
| `core:retained_definition_unavailable` | Hydration cannot load a registry definition required to interpret a retained result page. | no | `verify_index`, `restore_verified_data` | `registry_snapshot_id`, `definition_ids[]` |

Source-first v3 structural coverage failures may additionally include
`required_layer`, `reason_codes`, `retry_after_ms`, and
`source_safe_fallback_operations`. These details are advisory only when the
closed error code is already known; clients must still follow the registered
retryability and recovery mapping above.

`core:execution_resource_limit.retryable` is true only when the occurrence names an accepted larger limit or scope reduction; otherwise false. `core:execution_failed.retryable` and `core:source_unavailable.retryable` are set only when the recorded failure class is transient. These are occurrence-level values constrained by their definitions, not guesses by the adapter.

For `core:selector_not_found` and `core:selector_ambiguous`, `selector_pointer` is the exact recipe-argument pointer supplying the guarded selector; candidate arrays are complete when they fit the error budget and otherwise use the ordinary diagnostic cursor rather than silent truncation. `core:invalid_definition_instance_selector.reason_code` is exactly `unsupported_definition_type`; every listed definition and type is an offending selected value. `core:invalid_query_scope` repeats normalized roles in participant order.

`core:daemon_restart_required.blocking_reason` is exactly `active_publication`, `active_migration`, `active_administrative_operation`, `active_clients`, `restart_lease_denied`, `restart_lease_timeout`, `storage_upgrade_required`, or `owner_mismatch`. `safe_automatic_restart` is false for the reported occurrence; it exists to prevent a client from inferring safety from a generic retryable flag. The occurrence is retryable only for the first six transient reasons and never for `storage_upgrade_required` or `owner_mismatch` without the named administrative recovery action.

## `core:embedding_profile_not_found`

| Definition field | Value |
|---|---|
| Description | A profile pinned by the workspace configuration or retained semantic materialization is absent from at least one required registry snapshot. |
| Exact trigger | Core-owned profile resolution for the normalized plan resolves no active or retained definition for a required workspace binding. Normal query input never supplies the profile identifier. |
| Does not mean | It does not mean that no other compatible profile is installed or materialized. |
| Retryable default | `false` |
| Recovery actions | `inspect_index_status`, `repair_workspace_configuration`, `install_required_model_pack`, `reindex` |

Details schema:

| Field | Type | Presence and exact meaning |
|---|---|---|
| `embedding_profile_id` | string | Required exact core-owned identifier referenced by the pinned configuration or materialization. It is never copied from a normal agent query selector. |
| `workspace_snapshot_binding_ids` | non-empty string array | Required bindings whose registries do not contain the profile. |

## `core:embedding_profile_incompatible`

| Definition field | Value |
|---|---|
| Description | A known core-owned embedding profile cannot execute a semantic lane selected from pinned workspace configuration because a hard language, content, query-class, materialization, or generator condition is false. |
| Exact trigger | Profile resolution succeeds, but at least one hard compatibility condition required by the stage is false. |
| Does not mean | It does not describe temporary pending vector coverage; that condition uses completeness. |
| Retryable default | `false` |
| Recovery actions | `inspect_semantic_coverage`, `repair_workspace_configuration`, `install_compatible_model_pack`, `reindex` |

Details schema:

| Field | Type | Presence and exact meaning |
|---|---|---|
| `embedding_profile_id` | string | Required selected profile. |
| `semantic_lane_id` | string | Required normalized lane that cannot use it. |
| `incompatibility_reasons` | non-empty enum array | Required subset of `language`, `content_class`, `query_class`, `dimensions`, `encoding`, `distance_metric`, `generator_lock`, or `materialization`. |
| `workspace_snapshot_binding_ids` | non-empty string array | Required affected bindings. |

## `core:semantic_index_unavailable`

| Definition field | Value |
|---|---|
| Description | A mandatory semantic stage has no usable index or exact query generator for one or more required bindings. |
| Exact trigger | The normalized stage forbids fallback and a required semantic binding is `unavailable` or its pinned query generator cannot run. |
| Does not mean | It is not emitted merely because some artifacts are pending while a usable partial materialization exists. |
| Retryable default | `true` |
| Recovery actions | `wait_for_index`, `restore_generator`, `repair_workspace_configuration`, `allow_fallback` |

Details schema:

| Field | Type | Presence and exact meaning |
|---|---|---|
| `semantic_lane_id` | string | Required failed lane. |
| `embedding_profile_id` | string | Required selected profile. |
| `workspace_snapshot_binding_ids` | non-empty string array | Required bindings with no usable semantic retrieval. |
| `unavailability_reason` | enum | Required: `materialization_missing`, `materialization_unavailable`, `query_generator_unavailable`, or `vector_set_unreadable`. |
| `last_materialization_id` | string | Optional latest known materialization when one exists. |

## `core:semantic_coverage_incomplete`

| Definition field | Value |
|---|---|
| Description | A query requiring complete semantic coverage reached its explicit wait limit while relevant coverage remained non-complete. |
| Exact trigger | `require_complete_semantic` is true and at least one relevant semantic coverage view is still `updating`, `degraded`, or `unavailable` when its wait limit expires. |
| Does not mean | It does not invalidate results from a different request that explicitly accepts partial semantic coverage. |
| Retryable default | `true` |
| Recovery actions | `retry_after_progress`, `increase_wait_limit`, `accept_partial_coverage`, `inspect_semantic_coverage` |

Details schema:

| Field | Type | Presence and exact meaning |
|---|---|---|
| `semantic_lane_ids` | non-empty string array | Required lanes that remained incomplete. |
| `workspace_snapshot_binding_ids` | non-empty string array | Required affected bindings. |
| `materialization_ids` | string array | Required known materializations; empty only when none exists. |
| `pending_artifact_count` | non-negative integer | Required exact pending total at failure time. |
| `unsupported_artifact_count` | non-negative integer | Required exact unsupported total at failure time. |
| `failed_artifact_count` | non-negative integer | Required exact failed total at failure time. |
| `waited_milliseconds` | non-negative integer | Required elapsed wait governed by the request limit. |
| `retry_after_milliseconds` | positive integer | Optional server estimate; informational and not a guarantee. |

## `core:index_contract_unsupported`

| Definition field | Value |
|---|---|
| Description | The requested retained or imported index state requires a canonical encoding, hash algorithm, schema, digest domain, comparator, digest recipe, digest reference, or verifier contract that this engine cannot interpret losslessly. |
| Exact trigger | Contract resolution reaches one exact required contract with no supported implementation or complete adapter while the affected state must remain interpretable. |
| Does not mean | It does not mean the indexed source or stored bytes are corrupt. |
| Retryable default | `false` |
| Recovery actions | `restore_compatible_decoder`, `update_engine`, `restore_verifier`, `inspect_index_contracts` |

Details schema:

| Field | Type | Presence and exact meaning |
|---|---|---|
| `contract_kind` | enum | Required: `canonical_encoding`, `hash_algorithm`, `schema`, `digest_domain`, `canonical_comparator`, `digest_recipe`, `digest_reference`, or `external_verifier`. |
| `registry_snapshot_ids` | non-empty string array | Required exact retained registries whose reachable state needs the contract. |
| `uce_error_code` | string | Required underlying stable UCE error code. |
| `canonical_encoding_version` | positive integer | Required exactly for `canonical_encoding`. |
| `hash_algorithm` | string | Required exactly for `hash_algorithm`. |
| `schema_id` | string | Required exactly for `schema`. |
| `schema_version` | positive integer | Required with `schema_id`. |
| `digest_domain` | string | Required exactly for `digest_domain`. |
| `comparator_id` | string | Required exactly for `canonical_comparator`. |
| `comparator_version` | positive integer | Required with `comparator_id`. |
| `digest_recipe_id` | string | Required exactly for `digest_recipe`. |
| `digest_recipe_version` | positive integer | Required with `digest_recipe_id`. |
| `digest_reference_id` | string | Required exactly for `digest_reference`. |
| `external_verification_contract_id` | string | Required exactly for `external_verifier`. |
| `external_verification_contract_version` | positive integer | Required with `external_verification_contract_id`. |

Exactly one contract-specific identifier group is present and it agrees with `contract_kind`. No approximate fallback or implicit migration is legal.

## `core:index_integrity_failed`

| Definition field | Value |
|---|---|
| Description | A mandatory requested snapshot or index component failed canonical digest or structural-integrity verification and cannot be returned as trusted intelligence. |
| Exact trigger | Verification produces a specific integrity failure for state required by the operation, after any atomic read retry needed to exclude an in-progress write. |
| Does not mean | It does not describe an unsupported contract, a source analysis limitation, or incomplete but valid semantic coverage. |
| Retryable default | `true` |
| Recovery actions | `verify_index`, `restore_verified_data`, `rebuild_from_retained_inputs`, `select_another_snapshot` |

Details schema:

| Field | Type | Presence and exact meaning |
|---|---|---|
| `snapshot_ids` | non-empty string array | Required exact snapshots whose mandatory state is affected. |
| `component_kind` | enum | Required: `manifest`, `canonical_record`, `source_blob`, `registry`, `projection`, `query_manifest`, or `storage_index`. |
| `component_ids` | string array | Required bounded exact affected identifiers; empty only when corruption prevents safe enumeration. |
| `integrity_failure_kind` | enum | Required: `digest_mismatch`, `missing_required_component`, `schema_invalid`, `reference_invalid`, or `atomicity_violation`. |
| `uce_error_code` | string | Optional underlying stable UCE cause; required for a UCE decoding, schema, recipe, or digest failure. |
| `expected_digest` | Digest | Optional expected value; present together with `actual_digest`. |
| `actual_digest` | Digest | Optional recomputed value; present together with `expected_digest`. |
| `affected_capability` | string | Optional capability when an otherwise optional projection is the only affected component. |

This code is returned only when the failed component is mandatory for the requested operation. An optional semantic materializer continues to use `core:semantic_index_unavailable` with its integrity cause, preserving the narrower recovery contract.
