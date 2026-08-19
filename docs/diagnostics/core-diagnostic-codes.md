# Core Diagnostic Codes

Status: **Approved initial registry**  
Last updated: 2026-08-08  
Depends on: [Universal data model](../decisions/01-universal-data-model.md)

## Registry contract

This file is the authoritative initial registry for `core:*` diagnostic codes. A producer may emit a core code only under its exact emission condition and with a payload accepted by the documented schema.

Every payload is a closed object: fields not listed for that code are rejected. Array fields are deduplicated unless explicitly ordered. Identifier fields use the canonical identifiers from the universal data model. All examples are complete logical `DiagnosticRecord` emissions; optional fields are omitted when they do not apply.

Every definition in this initial registry has `definition_revision: 1`, `schema_version: 1`, and `lifecycle_state: active`; lifecycle transition and replacement fields are omitted. Metadata-only revisions and occurrence-schema versions evolve independently under the compatibility rules in the universal data model.

Plugin-owned codes use the same `DiagnosticCodeDefinition` contract in their own namespace. Mentioning a possible plugin code in design documentation does not register it.

## `core:parse_failed`

| Definition field | Value |
|---|---|
| Schema version | `1` |
| Diagnostic category | `syntax` |
| Title | Parse failed |
| Description | The configured parser did not produce a complete analysis-suitable syntax representation for the exact owner artifact version. |
| Emission condition | Emit only when the selected language parser cannot produce the syntax representation required for one or more regions of an exact artifact version. |
| Does not mean | It does not prove that the source is invalid according to another compiler, parser version, build configuration, or language mode. |
| Default severity | `error`; allowed: `warning`, `error` |
| Default completeness | Effect `local`, status `partial` |
| Allowed completeness | Effects: `local`, `capability`; statuses: `partial`, `unknown` |
| Allowed scopes | `artifact`, `capability` |
| Affected capabilities | `core:syntax_structure`, `core:symbol_resolution`, `core:type_information`, `core:call_relationships`, `core:data_flow` |
| Recovery | `action_required`: `source_change`, `configuration_change`, `plugin_upgrade`, `reindex` |
| Agent guidance | Do not treat analysis of the affected region as exhaustive. Inspect the parser failure and prefer a newer complete snapshot or source-level reasoning for that region. |

Payload schema:

| Field | Type | Presence and exact meaning |
|---|---|---|
| `language_id` | string | Required language identifier selected for the artifact. |
| `parser_error_code` | string | Optional stable parser-owned error code; it is not a Urdira diagnostic code. |
| `failure_offset` | non-negative integer | Optional byte offset at which parsing first became unusable. It must lie within the owner artifact version. |
| `recovered_region_count` | non-negative integer | Required number of disjoint regions for which the parser still produced usable syntax. |

Valid emission:

```json
{"record_id":"rec_diag_parse_12","category":"diagnostic","kind":"core:diagnostic","universal_kind":"core:diagnostic","facets":[],"schema_version":1,"workspace_id":"ws_app","owner_artifact_id":"art_router_ts","owner_artifact_version_id":"artv_router_12","valid_from_generation":12,"producer_version":"1.0.0","payload":{"language_id":"typescript","parser_error_code":"TS1005","failure_offset":418,"recovered_region_count":2},"diagnostic_id":"diag_parse_router","diagnostic_key":"parse:art_router_ts:TS1005:semantic-router","diagnostic_code":"core:parse_failed","diagnostic_category":"syntax","severity":"error","completeness_effect":"local","completeness_status":"partial","affected_scopes":[{"scope_type":"artifact","artifact_id":"art_router_ts","artifact_version_id":"artv_router_12"}],"recoverability":{"state":"action_required","actions":["source_change","configuration_change","plugin_upgrade","reindex"]},"summary":"The TypeScript parser could not analyze part of src/router.ts.","evidence_record_ids":[],"producer_id":"typescript","analysis_digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","analysis_configuration_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","artifact_dependency_digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","record_digest":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}
```

## `core:unsupported_construct`

| Definition field | Value |
|---|---|
| Schema version | `1` |
| Diagnostic category | `capability` |
| Title | Unsupported source construct |
| Description | The construct was recognized, but one or more requested semantic capabilities are not implemented for it. |
| Emission condition | Emit only when the producer recognizes a concrete source construct but does not implement one or more semantic capabilities required to model it. |
| Does not mean | It does not mean the construct is invalid, unreachable, insecure, or unsupported by the language runtime. |
| Default severity | `warning`; allowed: `info`, `warning`, `error` |
| Default completeness | Effect `local`, status `partial` |
| Allowed completeness | Effects: `local`, `capability`; statuses: `partial`, `unknown`, `unsupported` |
| Allowed scopes | `record`, `artifact`, `capability` |
| Affected capabilities | Supplied by `payload.missing_capabilities`; the registry declares no additional implicit capability. |
| Recovery | `action_required`: `model_update`, `plugin_upgrade`, `configuration_change` |
| Agent guidance | Treat conclusions depending on the listed capabilities as incomplete for this construct; unrelated capabilities remain usable. |

Payload schema:

| Field | Type | Presence and exact meaning |
|---|---|---|
| `language_id` | string | Required language identifier of the construct. |
| `construct_kind` | string | Required producer-stable syntax or semantic construct identifier. |
| `missing_capabilities` | non-empty string array | Required namespaced capabilities the producer cannot provide for this construct. |
| `support_level` | enum | Required: `none` when no useful semantics were extracted, or `partial` when some declared semantics were extracted. |

Valid emission:

```json
{"record_id":"rec_diag_construct_12","category":"diagnostic","kind":"core:diagnostic","universal_kind":"core:diagnostic","facets":[],"schema_version":1,"workspace_id":"ws_app","owner_artifact_id":"art_controller_ts","owner_artifact_version_id":"artv_controller_12","valid_from_generation":12,"producer_version":"1.0.0","payload":{"language_id":"typescript","construct_kind":"legacy_parameter_decorator","missing_capabilities":["core:framework_semantics"],"support_level":"partial"},"diagnostic_id":"diag_construct_decorator","diagnostic_key":"unsupported:legacy_parameter_decorator:ent_param","diagnostic_code":"core:unsupported_construct","diagnostic_category":"capability","severity":"warning","completeness_effect":"local","completeness_status":"partial","affected_scopes":[{"scope_type":"artifact","artifact_id":"art_controller_ts","artifact_version_id":"artv_controller_12"},{"scope_type":"capability","capability":"core:framework_semantics","artifact_ids":["art_controller_ts"]}],"recoverability":{"state":"action_required","actions":["model_update","plugin_upgrade","configuration_change"]},"summary":"Framework binding is only partially modeled for this parameter decorator.","evidence_record_ids":[],"producer_id":"typescript","analysis_digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","analysis_configuration_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","artifact_dependency_digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","record_digest":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}
```

## `core:unresolved_symbol`

| Definition field | Value |
|---|---|
| Schema version | `1` |
| Diagnostic category | `resolution` |
| Title | Symbol could not be resolved |
| Description | The configured resolution pipeline completed without a confirmed entity binding for the referenced symbol. |
| Emission condition | Emit only after the configured resolution pipeline finishes without binding a concrete symbol reference to a confirmed entity. |
| Does not mean | It does not prove that no runtime target exists or that the source fails to compile. Dynamic, generated, external, or configuration-provided targets may exist. |
| Default severity | `warning`; allowed: `info`, `warning`, `error` |
| Default completeness | Effect `local`, status `partial` |
| Allowed completeness | Effects: `local`, `capability`; statuses: `partial`, `unknown` |
| Allowed scopes | `record`, `artifact`, `capability` |
| Affected capabilities | `core:symbol_resolution` plus any capability named by the affected capability scope |
| Recovery | `automatic`: `source_change`, `dependency_change`, `configuration_change`, `reindex` |
| Agent guidance | Do not interpret the absence of a resolved edge as proof of no relationship. Include the unresolved site in possible impact results. |

Payload schema:

| Field | Type | Presence and exact meaning |
|---|---|---|
| `symbol` | string | Required exact symbolic spelling used by the unresolved source reference. |
| `namespace` | string | Optional language- or plugin-defined lookup namespace. |
| `resolution_phase` | string | Required stable phase identifier at which resolution stopped. |
| `candidate_entity_ids` | entity ID array | Required deduplicated candidates retained by the resolver; empty means no candidate was found. Candidates are not confirmed targets. |

Valid emission:

```json
{"record_id":"rec_diag_unresolved_12","category":"diagnostic","kind":"core:diagnostic","universal_kind":"core:diagnostic","facets":[],"schema_version":1,"workspace_id":"ws_app","owner_artifact_id":"art_dispatch_ts","owner_artifact_version_id":"artv_dispatch_12","valid_from_generation":12,"producer_version":"1.0.0","payload":{"symbol":"handler","namespace":"value","resolution_phase":"computed_property_lookup","candidate_entity_ids":["ent_create","ent_delete"]},"diagnostic_id":"diag_unresolved_handler","diagnostic_key":"unresolved:callsite_dispatch:handler","diagnostic_code":"core:unresolved_symbol","diagnostic_category":"resolution","severity":"warning","completeness_effect":"local","completeness_status":"partial","affected_scopes":[{"scope_type":"record","record_id":"rec_call_dispatch_12"},{"scope_type":"capability","capability":"core:call_relationships","artifact_ids":["art_dispatch_ts"]}],"recoverability":{"state":"automatic","actions":["source_change","dependency_change","configuration_change","reindex"]},"summary":"The computed handler reference could not be resolved to one confirmed target.","evidence_record_ids":["rec_ev_handler_lookup_12"],"producer_id":"typescript","analysis_digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","analysis_configuration_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","artifact_dependency_digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","record_digest":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}
```

## `core:ambiguous_target`

| Definition field | Value |
|---|---|
| Schema version | `1` |
| Diagnostic category | `resolution` |
| Title | Multiple targets remain possible |
| Description | Resolution retained at least two competing targets and could not establish one unique confirmed target. |
| Emission condition | Emit only when resolution retains two or more mutually competing target entities and cannot confirm one unique target for the exact relation argument. |
| Does not mean | It does not mean every candidate executes, that candidates are equally likely, or that the candidate set is exhaustive. |
| Default severity | `warning`; allowed: `info`, `warning` |
| Default completeness | Effect `none`; status omitted |
| Allowed completeness | Effects: `none`, `local`; statuses: `partial`, `unknown` when the effect is `local` |
| Allowed scopes | `record`, `artifact`, `capability` |
| Affected capabilities | Determined by `payload.relation_kind` and explicit capability scopes |
| Recovery | `automatic`: `source_change`, `dependency_change`, `configuration_change`, `reindex` |
| Agent guidance | Return every candidate in the possible stream with independent evidence. If the candidate set is not complete, also degrade the relevant completeness dimension. |

Payload schema:

| Field | Type | Presence and exact meaning |
|---|---|---|
| `relation_kind` | string | Required namespaced kind of the ambiguous relation. |
| `symbol` | string | Required source spelling or stable description of the ambiguous target expression. |
| `candidate_entity_ids` | entity ID array | Required deduplicated array containing at least two candidate entities. |
| `candidate_set_complete` | boolean | Required; true only when the producer guarantees that no additional target candidate exists within the declared scope and model. |

Valid emission:

```json
{"record_id":"rec_diag_ambiguous_12","category":"diagnostic","kind":"core:diagnostic","universal_kind":"core:diagnostic","facets":[],"schema_version":1,"workspace_id":"ws_app","owner_artifact_id":"art_service_ts","owner_artifact_version_id":"artv_service_12","valid_from_generation":12,"producer_version":"1.0.0","payload":{"relation_kind":"core:call","symbol":"service.run","candidate_entity_ids":["ent_a_run","ent_b_run"],"candidate_set_complete":true},"diagnostic_id":"diag_ambiguous_run","diagnostic_key":"ambiguous:callsite_run:target","diagnostic_code":"core:ambiguous_target","diagnostic_category":"resolution","severity":"warning","completeness_effect":"none","affected_scopes":[{"scope_type":"record","record_id":"rec_call_run_12"}],"recoverability":{"state":"automatic","actions":["source_change","dependency_change","configuration_change","reindex"]},"summary":"The call target is one of two complete candidates, but neither is uniquely confirmed.","evidence_record_ids":["rec_ev_run_a_12","rec_ev_run_b_12"],"producer_id":"typescript","analysis_digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","analysis_configuration_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","artifact_dependency_digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","record_digest":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}
```

If `candidate_set_complete` is false, the occurrence must override `completeness_effect` to `local` and set `completeness_status` to `partial` or `unknown` according to the producer capability contract.

## `core:missing_dependency`

| Definition field | Value |
|---|---|
| Schema version | `1` |
| Diagnostic category | `dependency` |
| Title | Required analysis dependency is unavailable |
| Description | A concrete source construct requires dependency source or semantics that configured providers and resolvers could not supply. |
| Emission condition | Emit only when a concrete source construct names or requires a dependency whose source or semantic model cannot be obtained through the configured source providers and resolvers. |
| Does not mean | It does not prove that the dependency is absent at build or runtime, incorrectly declared, or unusable by the program. |
| Default severity | `warning`; allowed: `warning`, `error` |
| Default completeness | Effect `capability`, status `partial` |
| Allowed completeness | Effects: `local`, `capability`; statuses: `partial`, `unknown` |
| Allowed scopes | `artifact`, `capability` |
| Affected capabilities | `core:module_dependencies` plus every capability explicitly scoped by the occurrence |
| Recovery | `automatic`: `dependency_change`, `configuration_change`, `reindex` |
| Agent guidance | Treat cross-boundary relationships involving this dependency as incomplete and avoid concluding that unresolved exports, types, or callers do not exist. |

Payload schema:

| Field | Type | Presence and exact meaning |
|---|---|---|
| `specifier` | string | Required exact dependency specifier or canonical lookup key. |
| `dependency_kind` | enum | Required: `source`, `package`, `module`, `configuration`, or `model`. |
| `requested_from_artifact_id` | artifact ID | Required artifact whose construct requested the dependency; it must equal or depend on the owner artifact. |
| `expected_source_kind` | string | Optional source-provider or semantic-model kind expected by the resolver. |

Valid emission:

```json
{"record_id":"rec_diag_dependency_12","category":"diagnostic","kind":"core:diagnostic","universal_kind":"core:diagnostic","facets":[],"schema_version":1,"workspace_id":"ws_app","owner_artifact_id":"art_api_ts","owner_artifact_version_id":"artv_api_12","valid_from_generation":12,"producer_version":"1.0.0","payload":{"specifier":"@vendor/contracts","dependency_kind":"package","requested_from_artifact_id":"art_api_ts","expected_source_kind":"typescript_declarations"},"diagnostic_id":"diag_missing_contracts","diagnostic_key":"missing-dependency:art_api_ts:@vendor/contracts","diagnostic_code":"core:missing_dependency","diagnostic_category":"dependency","severity":"warning","completeness_effect":"capability","completeness_status":"partial","affected_scopes":[{"scope_type":"artifact","artifact_id":"art_api_ts","artifact_version_id":"artv_api_12"},{"scope_type":"capability","capability":"core:type_information","artifact_ids":["art_api_ts"]}],"recoverability":{"state":"automatic","actions":["dependency_change","configuration_change","reindex"]},"summary":"Type information for @vendor/contracts is unavailable to the configured source providers.","evidence_record_ids":[],"producer_id":"typescript","analysis_digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","analysis_configuration_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","artifact_dependency_digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","record_digest":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}
```

## `core:capability_unavailable`

| Definition field | Value |
|---|---|
| Schema version | `1` |
| Diagnostic category | `capability` |
| Title | Required capability is unavailable |
| Description | No active compatible producer supplies a required analysis capability for the concrete source construct and artifact. |
| Emission condition | Emit only when a concrete source construct requires a capability that no active compatible producer supplies for that construct and artifact. Workspace-wide absence without a concrete source occurrence is reported only in completeness metadata. |
| Does not mean | It does not mean the source construct is invalid or that every other analysis capability is unavailable. |
| Default severity | `warning`; allowed: `info`, `warning`, `error` |
| Default completeness | Effect `capability`, status `unsupported` |
| Allowed completeness | Effect: `capability`; status: `unsupported` |
| Allowed scopes | `artifact`, `capability` |
| Affected capabilities | Exactly `payload.capability` |
| Recovery | `action_required`: `configuration_change`, `model_update`, `plugin_upgrade` |
| Agent guidance | Do not request conclusions that require the unavailable capability for this scope; use available structural evidence or report the limitation explicitly. |

Payload schema:

| Field | Type | Presence and exact meaning |
|---|---|---|
| `capability` | string | Required namespaced capability unavailable for the concrete construct. |
| `reason` | enum | Required: `not_declared`, `disabled`, `no_provider`, or `incompatible_version`. |
| `construct_kind` | string | Required stable kind of source construct that requires the capability. |

Valid emission:

```json
{"record_id":"rec_diag_capability_12","category":"diagnostic","kind":"core:diagnostic","universal_kind":"core:diagnostic","facets":[],"schema_version":1,"workspace_id":"ws_app","owner_artifact_id":"art_template_vue","owner_artifact_version_id":"artv_template_12","valid_from_generation":12,"producer_version":"1.0.0","payload":{"capability":"vue:template_data_flow","reason":"no_provider","construct_kind":"vue_template_expression"},"diagnostic_id":"diag_template_flow","diagnostic_key":"capability:template_data_flow:expr_submit","diagnostic_code":"core:capability_unavailable","diagnostic_category":"capability","severity":"warning","completeness_effect":"capability","completeness_status":"unsupported","affected_scopes":[{"scope_type":"artifact","artifact_id":"art_template_vue","artifact_version_id":"artv_template_12"},{"scope_type":"capability","capability":"vue:template_data_flow","artifact_ids":["art_template_vue"]}],"recoverability":{"state":"action_required","actions":["configuration_change","model_update","plugin_upgrade"]},"summary":"No active producer provides template data-flow analysis for this expression.","evidence_record_ids":[],"producer_id":"vue","analysis_digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","analysis_configuration_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","artifact_dependency_digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","record_digest":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}
```

## `core:framework_model_incomplete`

| Definition field | Value |
|---|---|
| Schema version | `1` |
| Diagnostic category | `framework_model` |
| Title | Framework model is incomplete |
| Description | A recognized framework construct requires a semantic rule or metadata absent from the selected framework-model version. |
| Emission condition | Emit only when a recognized framework construct is within the selected model's domain but the identified model version lacks a rule or metadata needed to derive the requested semantics. |
| Does not mean | It does not mean the framework is unsupported as a whole, that the source is wrong, or that runtime behavior cannot exist. |
| Default severity | `warning`; allowed: `info`, `warning`, `error` |
| Default completeness | Effect `local`, status `partial` |
| Allowed completeness | Effects: `local`, `capability`; statuses: `partial`, `unknown` |
| Allowed scopes | `record`, `artifact`, `capability` |
| Affected capabilities | Supplied by the occurrence's capability scopes |
| Recovery | `action_required`: `configuration_change`, `model_update`, `plugin_upgrade` |
| Agent guidance | Treat framework-derived routes, injections, bindings, or lifecycle edges in this scope as incomplete while retaining language-level structural results. |

Payload schema:

| Field | Type | Presence and exact meaning |
|---|---|---|
| `framework_id` | string | Required stable framework identifier. |
| `model_version` | string | Required exact framework-model version used for analysis. |
| `construct_kind` | string | Required stable recognized construct kind. |
| `missing_model_feature` | string | Required stable identifier for the absent modeling rule or metadata. |

Valid emission:

```json
{"record_id":"rec_diag_framework_12","category":"diagnostic","kind":"core:diagnostic","universal_kind":"core:diagnostic","facets":[],"schema_version":1,"workspace_id":"ws_app","owner_artifact_id":"art_module_ts","owner_artifact_version_id":"artv_module_12","valid_from_generation":12,"producer_version":"2.1.0","payload":{"framework_id":"nestjs","model_version":"2.1.0","construct_kind":"dynamic_module_factory","missing_model_feature":"runtime_provider_token_expansion"},"diagnostic_id":"diag_nest_dynamic_module","diagnostic_key":"framework-model:nestjs:dynamic-module:createFeature","diagnostic_code":"core:framework_model_incomplete","diagnostic_category":"framework_model","severity":"warning","completeness_effect":"local","completeness_status":"partial","affected_scopes":[{"scope_type":"record","record_id":"rec_dynamic_module_12"},{"scope_type":"capability","capability":"core:framework_semantics","artifact_ids":["art_module_ts"]}],"recoverability":{"state":"action_required","actions":["configuration_change","model_update","plugin_upgrade"]},"summary":"The NestJS model cannot expand provider tokens returned by this dynamic module factory.","evidence_record_ids":["rec_ev_nest_factory_12"],"producer_id":"nestjs-model","analysis_digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","analysis_configuration_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","artifact_dependency_digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","record_digest":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}
```

## `core:semantic_document_generation_failed`

| Definition field | Value |
|---|---|
| Schema version | `1` |
| Diagnostic category | `semantic_projection` |
| Title | Semantic document generation failed |
| Description | The deterministic semantic-document generator could not produce a valid complete document for the exact owner artifact version or one of its entities. |
| Emission condition | Emit only after semantic scope selection when text preparation or document construction terminates unsuccessfully or violates the registered document schema or complete artifact-text coverage invariant. |
| Does not mean | It does not mean canonical parsing, source extraction, or every non-semantic query capability failed. |
| Default severity | `warning`; allowed: `warning`, `error` |
| Default completeness | Effect `local`, status `partial` |
| Allowed completeness | Effects: `local`, `capability`; statuses: `partial`, `unknown` |
| Allowed scopes | `record`, `artifact`, `capability` |
| Affected capabilities | `core:semantic_preparation` |
| Recovery | `automatic`: `source_change`, `reindex`; `action_required`: `model_update`, `configuration_change` |
| Agent guidance | Semantic matches may omit this artifact or entity. Lexical and structural records remain usable unless independently degraded. |

Payload schema:

| Field | Type | Presence and exact meaning |
|---|---|---|
| `subject_type` | enum | Required: `artifact` or `entity`. |
| `entity_id` | entity ID | Required exactly when `subject_type` is `entity`; omitted otherwise. |
| `generation_phase` | enum | Required: `decode`, `section_build`, `render`, `coverage_validation`, or `schema_validation`. |
| `generator_error_code` | string | Optional stable generator-owned code; it is not a Urdira diagnostic code. |
| `violated_invariant` | string | Required for a validation phase and optional otherwise; stable identifier of the failed contract. |

Valid emission:

```json
{"record_id":"rec_diag_semantic_doc_18","category":"diagnostic","kind":"core:diagnostic","universal_kind":"core:diagnostic","facets":[],"schema_version":1,"workspace_id":"ws_app","owner_artifact_id":"art_readme","owner_artifact_version_id":"artv_readme_18","valid_from_generation":18,"producer_version":"1.0.0","payload":{"subject_type":"artifact","generation_phase":"coverage_validation","violated_invariant":"complete_artifact_text_coverage"},"diagnostic_id":"diag_semantic_doc_readme","diagnostic_key":"semantic-document:artifact:art_readme","diagnostic_code":"core:semantic_document_generation_failed","diagnostic_category":"semantic_projection","severity":"warning","completeness_effect":"local","completeness_status":"partial","affected_scopes":[{"scope_type":"artifact","artifact_id":"art_readme","artifact_version_id":"artv_readme_18"},{"scope_type":"capability","capability":"core:semantic_preparation","artifact_ids":["art_readme"]}],"recoverability":{"state":"automatic","actions":["source_change","reindex"]},"summary":"The semantic document did not cover the complete README source text.","evidence_record_ids":[],"producer_id":"core-semantic-document","analysis_digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","analysis_configuration_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","artifact_dependency_digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","record_digest":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}
```

## `core:embedding_segmentation_failed`

| Definition field | Value |
|---|---|
| Schema version | `1` |
| Diagnostic category | `semantic_projection` |
| Title | Embedding segmentation failed |
| Description | The pinned profile segmenter could not produce valid source-mapped, token-bounded segments for a semantic document. |
| Emission condition | Emit only when a valid semantic document exists but segment construction fails or violates mapping, source coverage, ordering, or token-limit validation. |
| Does not mean | It does not mean the semantic document or embedding model is globally unusable. |
| Default severity | `warning`; allowed: `warning`, `error` |
| Default completeness | Effect `local`, status `partial` |
| Allowed completeness | Effects: `local`, `capability`; statuses: `partial`, `unknown` |
| Allowed scopes | `artifact`, `capability` |
| Affected capabilities | `core:semantic_preparation` |
| Recovery | `automatic`: `source_change`, `reindex`; `action_required`: `model_update`, `configuration_change` |
| Agent guidance | Semantic results may omit some or all content from this artifact for the named profile. Inspect profile and segmenter details before retrying. |

Payload schema:

| Field | Type | Presence and exact meaning |
|---|---|---|
| `embedding_profile_id` | string | Required immutable profile being segmented. |
| `semantic_document_projection_id` | projection record ID | Required exact document that failed segmentation. |
| `segmentation_phase` | enum | Required: `semantic_region`, `semantic_pack`, `fallback_window`, `token_validation`, or `coverage_validation`. |
| `segmenter_error_code` | string | Optional stable segmenter-owned code. |
| `maximum_document_tokens` | positive integer | Required profile limit applied. |
| `violated_invariant` | string | Required for validation phases and optional otherwise. |

Valid emission:

```json
{"record_id":"rec_diag_segment_21","category":"diagnostic","kind":"core:diagnostic","universal_kind":"core:diagnostic","facets":[],"schema_version":1,"workspace_id":"ws_app","owner_artifact_id":"art_generated_ts","owner_artifact_version_id":"artv_generated_21","valid_from_generation":21,"producer_version":"1.0.0","payload":{"embedding_profile_id":"fixture:code_embedding_v1","semantic_document_projection_id":"proj_doc_generated_21","segmentation_phase":"coverage_validation","maximum_document_tokens":8192,"violated_invariant":"primary_parts_cover_source_text"},"diagnostic_id":"diag_segment_generated","diagnostic_key":"embedding-segmentation:fixture_code_embedding_v1:proj_doc_generated_21","diagnostic_code":"core:embedding_segmentation_failed","diagnostic_category":"semantic_projection","severity":"warning","completeness_effect":"local","completeness_status":"partial","affected_scopes":[{"scope_type":"artifact","artifact_id":"art_generated_ts","artifact_version_id":"artv_generated_21"},{"scope_type":"capability","capability":"core:semantic_preparation","artifact_ids":["art_generated_ts"]}],"recoverability":{"state":"automatic","actions":["source_change","reindex"]},"summary":"Embedding segments did not cover all source text for the selected profile.","evidence_record_ids":[],"producer_id":"core-embedding-segmenter","analysis_digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","analysis_configuration_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","artifact_dependency_digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","record_digest":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}
```

## `core:embedding_generation_failed`

| Definition field | Value |
|---|---|
| Schema version | `1` |
| Diagnostic category | `semantic_projection` |
| Title | Embedding generation failed |
| Description | The exact pinned generator failed to produce valid deterministic vector bytes for one or more current segments owned by the artifact. |
| Emission condition | Emit only when inference terminates unsuccessfully or output fails profile dimension, encoding, finiteness, normalization, digest, or repeatability validation. |
| Does not mean | It does not mean the source is semantically irrelevant, invalid, or unsupported by every embedding profile. |
| Default severity | `warning`; allowed: `warning`, `error` |
| Default completeness | Effect `local`, status `partial` |
| Allowed completeness | Effects: `local`, `capability`; statuses: `partial`, `unknown` |
| Allowed scopes | `artifact`, `capability` |
| Affected capabilities | `core:semantic_preparation` |
| Recovery | `automatic`: `reindex`; `action_required`: `model_update`, `configuration_change` |
| Agent guidance | Valid vectors from other artifacts remain usable, but semantic absence is not exhaustive for this artifact. Restoring the exact core generator or activating another core profile requires administrative model-pack or workspace-configuration repair followed by reindexing; it is not a query option. |

Payload schema:

| Field | Type | Presence and exact meaning |
|---|---|---|
| `embedding_profile_id` | string | Required immutable profile. |
| `embedding_segment_projection_ids` | non-empty projection record ID array | Required exact failed segments, all owned by this diagnostic's artifact version. |
| `failure_kind` | enum | Required: `inference_error`, `invalid_dimensions`, `invalid_encoding`, `non_finite_value`, `normalization_mismatch`, `digest_mismatch`, or `determinism_mismatch`. |
| `generator_error_code` | string | Optional stable generator- or runtime-owned code. |
| `expected_dimensions` | positive integer | Required profile dimension. |
| `observed_dimensions` | non-negative integer | Optional observed output dimension when an output was produced. |

Valid emission:

```json
{"record_id":"rec_diag_embedding_24","category":"diagnostic","kind":"core:diagnostic","universal_kind":"core:diagnostic","facets":[],"schema_version":1,"workspace_id":"ws_app","owner_artifact_id":"art_service_ts","owner_artifact_version_id":"artv_service_24","valid_from_generation":24,"producer_version":"1.0.0","payload":{"embedding_profile_id":"fixture:code_embedding_v1","embedding_segment_projection_ids":["proj_segment_service_24_3"],"failure_kind":"invalid_dimensions","expected_dimensions":768,"observed_dimensions":384},"diagnostic_id":"diag_embedding_service","diagnostic_key":"embedding-generation:fixture_code_embedding_v1:art_service_ts","diagnostic_code":"core:embedding_generation_failed","diagnostic_category":"semantic_projection","severity":"warning","completeness_effect":"local","completeness_status":"partial","affected_scopes":[{"scope_type":"artifact","artifact_id":"art_service_ts","artifact_version_id":"artv_service_24"},{"scope_type":"capability","capability":"core:semantic_preparation","artifact_ids":["art_service_ts"]}],"recoverability":{"state":"automatic","actions":["reindex"]},"summary":"The embedding generator returned a vector with the wrong dimension.","evidence_record_ids":[],"producer_id":"core-embedding-generator","analysis_digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","analysis_configuration_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","artifact_dependency_digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","record_digest":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}
```
