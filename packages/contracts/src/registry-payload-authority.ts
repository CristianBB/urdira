/** Mechanically transcribed from the core operation-error, diagnostic, and candidate-issue registries. */
export const authoritativePayloadMetadata = {
  "core:discover_definitions.matcher": {
    "description": "Exact, lexical, semantic, or hybrid definition discovery input."
  },
  "core:discover_definitions.selector": {
    "description": "Hard definition-family, namespace, owner, and lifecycle filters."
  },
  "core:discover_definitions.include_full_definitions": {
    "description": "Returns concise definition views when false and complete agent-queryable definitions when true; large sets paginate."
  },
  "core:find_records.record_categories": {
    "description": "Accepted canonical record categories; values combine by OR."
  },
  "core:find_records.kind_selector": {
    "description": "Accepted concrete kinds, universal kinds, and facets under its existing conjunctive rules."
  },
  "core:find_records.producer_ids": {
    "description": "Exact plugin or core producers; values combine by OR."
  },
  "core:find_records.filter": {
    "description": "Hard path, language, namespace, kind/facet, subject-type, external, and generated constraints."
  },
  "core:resolve_symbol.reference": {
    "description": "Identifier, qualified name, or language-neutral symbol spelling to resolve."
  },
  "core:resolve_symbol.context_artifact": {
    "description": "Lexical/module context. Required with `context_byte_offset`."
  },
  "core:resolve_symbol.context_byte_offset": {
    "description": "Exact UTF-8 byte position at which visibility and shadowing are evaluated."
  },
  "core:resolve_symbol.kind_selector": {
    "description": "Hard target kind/facet constraint."
  },
  "core:resolve_symbol.resolution_scope": {
    "description": "`visible` applies language visibility from context, `workspace` finds declarations anywhere, and `exports` selects public/exported declarations."
  },
  "core:get_outline.container": {
    "description": "Artifact or semantic container whose direct contents are listed."
  },
  "core:get_outline.depth": {
    "description": "Maximum containment depth; exact within that depth."
  },
  "core:get_outline.include_non_public": {
    "description": "Whether private/local declarations are eligible."
  },
  "core:get_outline.filter": {
    "description": "Hard output constraints."
  },
  "core:find_references.target": {
    "description": "Declaration or semantic target being referenced."
  },
  "core:find_references.reference_roles": {
    "description": "Accepted registered reference roles; empty accepts every reference role supported by the selected kinds."
  },
  "core:find_references.include_declarations": {
    "description": "Whether defining occurrences are included beside uses."
  },
  "core:find_references.filter": {
    "description": "Hard source/result constraints."
  },
  "core:expand_relations.subjects": {
    "description": "Starting subjects."
  },
  "core:expand_relations.direction": {
    "description": "Direction relative to each starting subject and selected relation roles."
  },
  "core:expand_relations.relations": {
    "description": "Exact traversable relation semantics."
  },
  "core:expand_relations.min_depth": {
    "description": "First depth emitted."
  },
  "core:expand_relations.max_depth": {
    "description": "Last depth emitted; must be at least `min_depth`."
  },
  "core:expand_relations.path_policy": {
    "description": "Cycle prevention rule for each emitted path."
  },
  "core:expand_relations.filter": {
    "description": "Hard eligible endpoint constraints; traversal-through behavior remains operation-defined and is not inferred from the filter."
  },
  "core:find_paths.sources": {
    "description": "Path origins."
  },
  "core:find_paths.targets": {
    "description": "Path destinations."
  },
  "core:find_paths.direction": {
    "description": "Traversal direction from sources."
  },
  "core:find_paths.relations": {
    "description": "Exact traversable relation semantics."
  },
  "core:find_paths.max_depth": {
    "description": "Maximum accepted path length."
  },
  "core:find_paths.all_shortest": {
    "description": "Return every shortest path when true, otherwise the canonical first shortest path per source-target pair."
  },
  "core:search_text.pattern": {
    "description": "Literal bytes after UTF-8 decoding or a safe-regex expression."
  },
  "core:search_text.syntax": {
    "description": "Matching dialect."
  },
  "core:search_text.case_sensitive": {
    "description": "Exact case behavior; false uses the pinned Unicode case-folding contract."
  },
  "core:search_text.word_mode": {
    "description": "Boundary contract for literal matches. Regex always uses its own explicit boundaries."
  },
  "core:search_text.filter": {
    "description": "Hard searched scope and primary result constraints."
  },
  "core:search_text.result_projection": {
    "description": "Primary subject normalization. Ambiguous entity ownership remains a match/artifact result."
  },
  "core:search_semantic.query_text": {
    "description": "Concept, identifier, code, or mixed search input."
  },
  "core:search_semantic.query_class": {
    "description": "Structural input class used for profile compatibility; never inferred as human language."
  },
  "core:search_semantic.filter": {
    "description": "Hard searched scope and primary result constraints."
  },
  "core:search_semantic.require_structural_subject": {
    "description": "Excludes artifact-only matches when true; it does not turn semantic evidence into proof."
  },
  "core:get_source.subjects": {
    "description": "Exact subjects whose source is requested."
  },
  "core:get_source.source": {
    "description": "Requested signature, relevant region, or body projection and budgets."
  },
  "core:get_source.include_related_evidence": {
    "description": "Adds source references for hydrated evidence without widening primary subjects."
  },
  "core:analyze_impact.target": {
    "description": "Existing element whose hypothetical change is analyzed."
  },
  "core:analyze_impact.change": {
    "description": "One closed hypothetical change variant below."
  },
  "core:analyze_impact.include_transitive": {
    "description": "Whether operation-defined transitive dependants are analyzed."
  },
  "core:analyze_impact.include_tests": {
    "description": "Whether related tests and test gaps are returned."
  },
  "core:analyze_impact.filter": {
    "description": "Hard affected-result scope; it cannot hide completeness outside the filtered declared domain."
  },
  "core:analyze_impact.delete": {
    "description": "none"
  },
  "core:analyze_impact.rename": {
    "description": "none"
  },
  "core:analyze_impact.move": {
    "description": "`new_container`"
  },
  "core:analyze_impact.signature": {
    "description": "`compatibility_assumptions[]`"
  },
  "core:analyze_impact.type": {
    "description": "`compatibility_assumptions[]`"
  },
  "core:analyze_impact.visibility": {
    "description": "none"
  },
  "core:analyze_impact.contract": {
    "description": "`compatibility_assumptions[]`"
  },
  "core:analyze_impact.behavior": {
    "description": "`affected_effects[]`"
  },
  "core:find_related_tests.subjects": {
    "description": "Code or artifact subjects under test."
  },
  "core:find_related_tests.relationship_scope": {
    "description": "Which registered test relations and impact paths are eligible."
  },
  "core:find_related_tests.include_fixtures": {
    "description": "Whether fixture, mock, and helper subjects are returned in separate output sets."
  },
  "core:find_related_tests.filter": {
    "description": "Hard test-artifact and result constraints."
  },
  "core:inspect_architecture.scope": {
    "description": "Roots of the architectural slice; absence selects the complete workspace query scope."
  },
  "core:inspect_architecture.views": {
    "description": "Architectural projections requested."
  },
  "core:inspect_architecture.max_relation_depth": {
    "description": "Structural reach considered for slice membership."
  },
  "core:inspect_architecture.filter": {
    "description": "Hard result constraints."
  },
  "core:compare.selection": {
    "description": "Elements correlated across participants; absence compares the complete filtered scopes. Stage outputs must identify their participant."
  },
  "core:compare.comparison_kinds": {
    "description": "Difference classes returned."
  },
  "core:compare.correlation_policy": {
    "description": "Whether portable-key or structural possible correlations are returned beside exact correlations."
  },
  "core:compare.filter": {
    "description": "Applied independently to both participants before correlation."
  },
  "core:build_context.task": {
    "description": "Coding task whose relevant repository context is selected."
  },
  "core:build_context.query_class": {
    "description": "Typed semantic input class."
  },
  "core:build_context.seeds": {
    "description": "Known targets; empty permits hybrid discovery from `task`."
  },
  "core:build_context.facets": {
    "description": "Context categories requested."
  },
  "core:build_context.filter": {
    "description": "Hard context scope."
  },
  "core:index_status.include_capabilities": {
    "description": "Include compact active capability and completeness summaries."
  },
  "core:index_status.include_plugins": {
    "description": "Include active resolution lock and plugin summaries."
  },
  "core:index_status.include_activation_issues": {
    "description": "Include the first budgeted page of latest activation issues."
  },
  "core:index_status.include_candidate_issues": {
    "description": "Include the first budgeted page of current candidate issues."
  },
  "core:parse_failed.language_id": {
    "description": "Required language identifier selected for the artifact."
  },
  "core:parse_failed.parser_error_code": {
    "description": "Optional stable parser-owned error code; it is not a Urdira diagnostic code."
  },
  "core:parse_failed.failure_offset": {
    "description": "Optional byte offset at which parsing first became unusable. It must lie within the owner artifact version.",
    "type": "integer",
    "minimum": 0
  },
  "core:parse_failed.recovered_region_count": {
    "description": "Required number of disjoint regions for which the parser still produced usable syntax.",
    "type": "integer",
    "minimum": 0
  },
  "core:unsupported_construct.language_id": {
    "description": "Required language identifier of the construct."
  },
  "core:unsupported_construct.construct_kind": {
    "description": "Required producer-stable syntax or semantic construct identifier."
  },
  "core:unsupported_construct.missing_capabilities": {
    "description": "Required namespaced capabilities the producer cannot provide for this construct.",
    "type": "array",
    "minItems": 1,
    "items": {
      "type": "string"
    }
  },
  "core:unsupported_construct.support_level": {
    "description": "Required: `none` when no useful semantics were extracted, or `partial` when some declared semantics were extracted.",
    "enum": [
      "none",
      "partial"
    ]
  },
  "core:unresolved_symbol.symbol": {
    "description": "Required exact symbolic spelling used by the unresolved source reference."
  },
  "core:unresolved_symbol.namespace": {
    "description": "Optional language- or plugin-defined lookup namespace."
  },
  "core:unresolved_symbol.resolution_phase": {
    "description": "Required stable phase identifier at which resolution stopped."
  },
  "core:unresolved_symbol.candidate_entity_ids": {
    "description": "Required deduplicated candidates retained by the resolver; empty means no candidate was found. Candidates are not confirmed targets."
  },
  "core:ambiguous_target.relation_kind": {
    "description": "Required namespaced kind of the ambiguous relation."
  },
  "core:ambiguous_target.symbol": {
    "description": "Required source spelling or stable description of the ambiguous target expression."
  },
  "core:ambiguous_target.candidate_entity_ids": {
    "description": "Required deduplicated array containing at least two candidate entities.",
    "type": "array",
    "minItems": 2,
    "items": {
      "type": "string"
    }
  },
  "core:ambiguous_target.candidate_set_complete": {
    "description": "Required; true only when the producer guarantees that no additional target candidate exists within the declared scope and model."
  },
  "core:missing_dependency.specifier": {
    "description": "Required exact dependency specifier or canonical lookup key."
  },
  "core:missing_dependency.dependency_kind": {
    "description": "Required: `source`, `package`, `module`, `configuration`, or `model`.",
    "enum": [
      "source",
      "package",
      "module",
      "configuration",
      "model"
    ]
  },
  "core:missing_dependency.requested_from_artifact_id": {
    "description": "Required artifact whose construct requested the dependency; it must equal or depend on the owner artifact."
  },
  "core:missing_dependency.expected_source_kind": {
    "description": "Optional source-provider or semantic-model kind expected by the resolver."
  },
  "core:capability_unavailable.capability": {
    "description": "Required namespaced capability unavailable for the concrete construct."
  },
  "core:capability_unavailable.reason": {
    "description": "Required: `not_declared`, `disabled`, `no_provider`, or `incompatible_version`.",
    "enum": [
      "not_declared",
      "disabled",
      "no_provider",
      "incompatible_version"
    ]
  },
  "core:capability_unavailable.construct_kind": {
    "description": "Required stable kind of source construct that requires the capability."
  },
  "core:framework_model_incomplete.framework_id": {
    "description": "Required stable framework identifier."
  },
  "core:framework_model_incomplete.model_version": {
    "description": "Required exact framework-model version used for analysis."
  },
  "core:framework_model_incomplete.construct_kind": {
    "description": "Required stable recognized construct kind."
  },
  "core:framework_model_incomplete.missing_model_feature": {
    "description": "Required stable identifier for the absent modeling rule or metadata."
  },
  "core:semantic_document_generation_failed.subject_type": {
    "description": "Required: `artifact` or `entity`.",
    "enum": [
      "artifact",
      "entity"
    ]
  },
  "core:semantic_document_generation_failed.entity_id": {
    "description": "Required exactly when `subject_type` is `entity`; omitted otherwise."
  },
  "core:semantic_document_generation_failed.generation_phase": {
    "description": "Required: `decode`, `section_build`, `render`, `coverage_validation`, or `schema_validation`.",
    "enum": [
      "decode",
      "section_build",
      "render",
      "coverage_validation",
      "schema_validation"
    ]
  },
  "core:semantic_document_generation_failed.generator_error_code": {
    "description": "Optional stable generator-owned code; it is not a Urdira diagnostic code."
  },
  "core:semantic_document_generation_failed.violated_invariant": {
    "description": "Required for a validation phase and optional otherwise; stable identifier of the failed contract."
  },
  "core:embedding_segmentation_failed.embedding_profile_id": {
    "description": "Required immutable profile being segmented."
  },
  "core:embedding_segmentation_failed.semantic_document_projection_id": {
    "description": "Required exact document that failed segmentation."
  },
  "core:embedding_segmentation_failed.segmentation_phase": {
    "description": "Required: `semantic_region`, `semantic_pack`, `fallback_window`, `token_validation`, or `coverage_validation`.",
    "enum": [
      "semantic_region",
      "semantic_pack",
      "fallback_window",
      "token_validation",
      "coverage_validation"
    ]
  },
  "core:embedding_segmentation_failed.segmenter_error_code": {
    "description": "Optional stable segmenter-owned code."
  },
  "core:embedding_segmentation_failed.maximum_document_tokens": {
    "description": "Required profile limit applied.",
    "type": "integer",
    "minimum": 1
  },
  "core:embedding_segmentation_failed.violated_invariant": {
    "description": "Required for validation phases and optional otherwise."
  },
  "core:embedding_generation_failed.embedding_profile_id": {
    "description": "Required immutable profile."
  },
  "core:embedding_generation_failed.embedding_segment_projection_ids": {
    "description": "Required exact failed segments, all owned by this diagnostic's artifact version.",
    "type": "array",
    "minItems": 1,
    "items": {
      "type": "string"
    }
  },
  "core:embedding_generation_failed.failure_kind": {
    "description": "The closed inference-output failure category observed for the embedding generation attempt.",
    "enum": [
      "inference_error",
      "invalid_dimensions",
      "invalid_encoding",
      "non_finite_value",
      "normalization_mismatch",
      "digest_mismatch",
      "determinism_mismatch"
    ]
  },
  "core:embedding_generation_failed.generator_error_code": {
    "description": "Optional stable generator- or runtime-owned code."
  },
  "core:embedding_generation_failed.expected_dimensions": {
    "description": "Required profile dimension.",
    "type": "integer",
    "minimum": 1
  },
  "core:embedding_generation_failed.observed_dimensions": {
    "description": "Optional observed output dimension when an output was produced.",
    "type": "integer",
    "minimum": 0
  },
  "core:invalidation_plan_incomplete.invalidation_plan_id": {
    "description": "The `invalidation_plan_id` is the closed detail value for `core:invalidation_plan_incomplete`; normative emission trigger: The planner cannot prove that every record or projection affected by the candidate seeds is covered, even after applying registered fallback scopes. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:invalidation_plan_incomplete.unresolved_scope_count": {
    "description": "The number of affected scopes that remain unresolved after the registered fallback scopes were applied.",
    "type": "integer",
    "minimum": 1
  },
  "core:invalidation_plan_incomplete.reason_codes": {
    "description": "The non-empty registered reasons why the invalidation plan cannot prove complete coverage.",
    "type": "array",
    "minItems": 1,
    "items": {
      "type": "string"
    }
  },
  "core:invalidation_plan_incomplete.fallback_attempted": {
    "description": "The `fallback_attempted` is the closed detail value for `core:invalidation_plan_incomplete`; normative emission trigger: The planner cannot prove that every record or projection affected by the candidate seeds is covered, even after applying registered fallback scopes. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:invalidation_plan_incomplete.representative_artifact_ids": {
    "description": "The `representative_artifact_ids` is the ordered identifier set for `core:invalidation_plan_incomplete`; normative emission trigger: The planner cannot prove that every record or projection affected by the candidate seeds is covered, even after applying registered fallback scopes. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:work_manifest_inconsistent.work_manifest_id": {
    "description": "The `work_manifest_id` is the closed detail value for `core:work_manifest_inconsistent`; normative emission trigger: The frozen work manifest violates a structural or context invariant. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:work_manifest_inconsistent.invariant_code": {
    "description": "The closed invariant identifier violated by the frozen work manifest.",
    "enum": [
      "DUPLICATE_WORK_ITEM",
      "INVALID_ARTIFACT_TRANSITION",
      "SCOPE_NOT_COVERED",
      "DIGEST_MISMATCH",
      "DIGEST_CONTRACT_MISMATCH",
      "CONTEXT_MISMATCH"
    ]
  },
  "core:work_manifest_inconsistent.work_item_ids": {
    "description": "The non-empty work-item identifiers covered by the inconsistent frozen manifest.",
    "type": "array",
    "minItems": 1,
    "items": {
      "type": "string"
    }
  },
  "core:work_manifest_inconsistent.json_pointer": {
    "description": "The `json_pointer` is the closed detail value for `core:work_manifest_inconsistent`; normative emission trigger: The frozen work manifest violates a structural or context invariant. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_observation_conflict.artifact_id": {
    "description": "The `artifact_id` is the closed detail value for `core:source_observation_conflict`; normative emission trigger: Two accepted observations cannot both be true under one provider ordering and coverage contract. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_observation_conflict.at": {
    "description": "The `at` is the closed detail value for `core:source_observation_conflict`; normative emission trigger: Two accepted observations cannot both be true under one provider ordering and coverage contract. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_observation_conflict.least": {
    "description": "The `least` is the closed detail value for `core:source_observation_conflict`; normative emission trigger: Two accepted observations cannot both be true under one provider ordering and coverage contract. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_observation_conflict.two": {
    "description": "The `two` is the closed detail value for `core:source_observation_conflict`; normative emission trigger: Two accepted observations cannot both be true under one provider ordering and coverage contract. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_observation_conflict.source_observation_ids": {
    "description": "The at-least-two accepted observation identifiers that contradict one another.",
    "type": "array",
    "minItems": 2,
    "items": {
      "type": "string"
    }
  },
  "core:source_observation_conflict.conflict_kind": {
    "description": "The closed conflict category explaining why the accepted observations cannot coexist.",
    "enum": [
      "STATE_MISMATCH",
      "SEQUENCE_REGRESSION",
      "TOKEN_REUSE",
      "COVERAGE_CONTRADICTION"
    ]
  },
  "core:source_observation_conflict.provider_sequence_values": {
    "description": "The `provider_sequence_values` is the closed detail value for `core:source_observation_conflict`; normative emission trigger: Two accepted observations cannot both be true under one provider ordering and coverage contract. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_input_unavailable.artifact_id": {
    "description": "The `artifact_id` is the closed detail value for `core:source_input_unavailable`; normative emission trigger: A required exact artifact version cannot be read or verified for candidate analysis. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_input_unavailable.source_observation_id": {
    "description": "The `source_observation_id` is the closed detail value for `core:source_input_unavailable`; normative emission trigger: A required exact artifact version cannot be read or verified for candidate analysis. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_input_unavailable.availability_code": {
    "description": "The closed availability outcome explaining why the requested source input cannot be read.",
    "enum": [
      "READ_FAILED",
      "PROVIDER_UNAVAILABLE",
      "CONTENT_CHANGED_DURING_READ",
      "CONTENT_VERIFICATION_FAILED"
    ]
  },
  "core:source_input_unavailable.provider_error_code": {
    "description": "The `provider_error_code` is the closed detail value for `core:source_input_unavailable`; normative emission trigger: A required exact artifact version cannot be read or verified for candidate analysis. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_provider_state_changed.request_id": {
    "description": "The `request_id` is the closed detail value for `core:source_provider_state_changed`; normative emission trigger: An `enumerate`, `read`, or `reconcile` call returns `source_changed`, so its requested frozen source view cannot be accepted. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_provider_state_changed.source_provider_binding_id": {
    "description": "The `source_provider_binding_id` is the closed detail value for `core:source_provider_state_changed`; normative emission trigger: An `enumerate`, `read`, or `reconcile` call returns `source_changed`, so its requested frozen source view cannot be accepted. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_provider_state_changed.call": {
    "description": "The exact provider call whose accepted state changed during the request.",
    "enum": [
      "enumerate",
      "read",
      "reconcile"
    ]
  },
  "core:source_provider_state_changed.request_digest": {
    "description": "The canonical digest value carried by core:source_provider_state_changed.",
    "type": "string",
    "pattern": "^(?:sha256):[0-9a-f]{64}$"
  },
  "core:source_provider_state_changed.provider_error_code": {
    "description": "The `provider_error_code` is the closed detail value for `core:source_provider_state_changed`; normative emission trigger: An `enumerate`, `read`, or `reconcile` call returns `source_changed`, so its requested frozen source view cannot be accepted. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_provider_unavailable.request_id": {
    "description": "The `request_id` is the closed detail value for `core:source_provider_unavailable`; normative emission trigger: A required `describe`, `enumerate`, `read`, `watch`, or `reconcile` call returns `unavailable` while constructing or refreshing the candidate. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_provider_unavailable.source_provider_binding_id": {
    "description": "The `source_provider_binding_id` is the closed detail value for `core:source_provider_unavailable`; normative emission trigger: A required `describe`, `enumerate`, `read`, `watch`, or `reconcile` call returns `unavailable` while constructing or refreshing the candidate. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_provider_unavailable.call": {
    "description": "The exact provider call that could not be served because the provider was unavailable.",
    "enum": [
      "describe",
      "enumerate",
      "read",
      "watch",
      "reconcile"
    ]
  },
  "core:source_provider_unavailable.request_digest": {
    "description": "The canonical digest value carried by core:source_provider_unavailable.",
    "type": "string",
    "pattern": "^(?:sha256):[0-9a-f]{64}$"
  },
  "core:source_provider_unavailable.provider_error_code": {
    "description": "The `provider_error_code` is the closed detail value for `core:source_provider_unavailable`; normative emission trigger: A required `describe`, `enumerate`, `read`, `watch`, or `reconcile` call returns `unavailable` while constructing or refreshing the candidate. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_provider_unavailable.provider_detail_code": {
    "description": "The `provider_detail_code` is the closed detail value for `core:source_provider_unavailable`; normative emission trigger: A required `describe`, `enumerate`, `read`, `watch`, or `reconcile` call returns `unavailable` while constructing or refreshing the candidate. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_provider_deadline_exceeded.request_id": {
    "description": "The `request_id` is the closed detail value for `core:source_provider_deadline_exceeded`; normative emission trigger: A required source-provider call returns `deadline_exceeded` before a complete valid result is accepted. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_provider_deadline_exceeded.source_provider_binding_id": {
    "description": "The `source_provider_binding_id` is the closed detail value for `core:source_provider_deadline_exceeded`; normative emission trigger: A required source-provider call returns `deadline_exceeded` before a complete valid result is accepted. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_provider_deadline_exceeded.call": {
    "description": "The exact provider call that exceeded its configured deadline.",
    "enum": [
      "describe",
      "enumerate",
      "read",
      "watch",
      "reconcile"
    ]
  },
  "core:source_provider_deadline_exceeded.timeout_ms": {
    "description": "The `timeout_ms` is the numeric measurement for `core:source_provider_deadline_exceeded`; normative emission trigger: A required source-provider call returns `deadline_exceeded` before a complete valid result is accepted. (source: indexing/core-candidate-issue-codes.md).",
    "type": "integer",
    "minimum": 1
  },
  "core:source_provider_deadline_exceeded.provider_error_code": {
    "description": "The `provider_error_code` is the closed detail value for `core:source_provider_deadline_exceeded`; normative emission trigger: A required source-provider call returns `deadline_exceeded` before a complete valid result is accepted. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_provider_resource_exhausted.request_id": {
    "description": "The `request_id` is the closed detail value for `core:source_provider_resource_exhausted`; normative emission trigger: A required source-provider call returns `resource_exhausted` for one exact resource limit. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_provider_resource_exhausted.source_provider_binding_id": {
    "description": "The `source_provider_binding_id` is the closed detail value for `core:source_provider_resource_exhausted`; normative emission trigger: A required source-provider call returns `resource_exhausted` for one exact resource limit. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_provider_resource_exhausted.call": {
    "description": "The exact provider call that exhausted the named resource.",
    "enum": [
      "describe",
      "enumerate",
      "read",
      "watch",
      "reconcile"
    ]
  },
  "core:source_provider_resource_exhausted.resource_kind": {
    "description": "The closed provider resource class whose configured limit was reached.",
    "enum": [
      "deadline",
      "response_bytes",
      "observations",
      "watch_events"
    ]
  },
  "core:source_provider_resource_exhausted.configured_limit": {
    "description": "The `configured_limit` is the closed detail value for `core:source_provider_resource_exhausted`; normative emission trigger: A required source-provider call returns `resource_exhausted` for one exact resource limit. (source: indexing/core-candidate-issue-codes.md).",
    "type": "integer",
    "minimum": 1
  },
  "core:source_provider_resource_exhausted.observed_or_required": {
    "description": "The `observed_or_required` is the closed detail value for `core:source_provider_resource_exhausted`; normative emission trigger: A required source-provider call returns `resource_exhausted` for one exact resource limit. (source: indexing/core-candidate-issue-codes.md).",
    "type": "integer",
    "minimum": 0
  },
  "core:source_provider_resource_exhausted.provider_error_code": {
    "description": "The `provider_error_code` is the closed detail value for `core:source_provider_resource_exhausted`; normative emission trigger: A required source-provider call returns `resource_exhausted` for one exact resource limit. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_provider_failed.request_id": {
    "description": "The `request_id` is the closed detail value for `core:source_provider_failed`; normative emission trigger: A required source-provider call returns `failed` and no more specific source-provider code applies. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_provider_failed.source_provider_binding_id": {
    "description": "The `source_provider_binding_id` is the closed detail value for `core:source_provider_failed`; normative emission trigger: A required source-provider call returns `failed` and no more specific source-provider code applies. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_provider_failed.call": {
    "description": "The exact provider call that returned the recorded provider failure.",
    "enum": [
      "describe",
      "enumerate",
      "read",
      "watch",
      "reconcile"
    ]
  },
  "core:source_provider_failed.provider_error_code": {
    "description": "The `provider_error_code` is the closed detail value for `core:source_provider_failed`; normative emission trigger: A required source-provider call returns `failed` and no more specific source-provider code applies. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:source_provider_failed.provider_detail_code": {
    "description": "The `provider_detail_code` is the closed detail value for `core:source_provider_failed`; normative emission trigger: A required source-provider call returns `failed` and no more specific source-provider code applies. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:analysis_context_unavailable.missing_context_kind": {
    "description": "The `missing_context_kind` is the closed detail value for `core:analysis_context_unavailable`; normative emission trigger: A frozen registry, configuration, plugin resolution, analyzer package, or required plugin dependency cannot be loaded and verified. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:analysis_context_unavailable.missing_context_id": {
    "description": "The `missing_context_id` is the closed detail value for `core:analysis_context_unavailable`; normative emission trigger: A frozen registry, configuration, plugin resolution, analyzer package, or required plugin dependency cannot be loaded and verified. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:analysis_context_unavailable.plugin_id": {
    "description": "The `plugin_id` is the closed detail value for `core:analysis_context_unavailable`; normative emission trigger: A frozen registry, configuration, plugin resolution, analyzer package, or required plugin dependency cannot be loaded and verified. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:analysis_context_unavailable.plugin_version": {
    "description": "The `plugin_version` is the closed detail value for `core:analysis_context_unavailable`; normative emission trigger: A frozen registry, configuration, plugin resolution, analyzer package, or required plugin dependency cannot be loaded and verified. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:analyzer_failed.work_item_id": {
    "description": "The `work_item_id` is the closed detail value for `core:analyzer_failed`; normative emission trigger: A registered analyzer terminates without producing a valid complete delta for its work item. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:analyzer_failed.plugin_id": {
    "description": "The `plugin_id` is the closed detail value for `core:analyzer_failed`; normative emission trigger: A registered analyzer terminates without producing a valid complete delta for its work item. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:analyzer_failed.plugin_version": {
    "description": "The `plugin_version` is the closed detail value for `core:analyzer_failed`; normative emission trigger: A registered analyzer terminates without producing a valid complete delta for its work item. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:analyzer_failed.analyzer_error_code": {
    "description": "The `analyzer_error_code` is the closed detail value for `core:analyzer_failed`; normative emission trigger: A registered analyzer terminates without producing a valid complete delta for its work item. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:analyzer_failed.failure_stage": {
    "description": "The closed analyzer lifecycle stage at which analysis failed.",
    "enum": [
      "startup",
      "input_loading",
      "parsing",
      "semantic_analysis",
      "output_generation",
      "shutdown"
    ]
  },
  "core:analyzer_failed.provider_detail_code": {
    "description": "The `provider_detail_code` is the closed detail value for `core:analyzer_failed`; normative emission trigger: A registered analyzer terminates without producing a valid complete delta for its work item. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:analyzer_timeout.work_item_id": {
    "description": "The `work_item_id` is the closed detail value for `core:analyzer_timeout`; normative emission trigger: Analyzer execution exceeds the configured work-item deadline. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:analyzer_timeout.plugin_id": {
    "description": "The `plugin_id` is the closed detail value for `core:analyzer_timeout`; normative emission trigger: Analyzer execution exceeds the configured work-item deadline. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:analyzer_timeout.timeout_ms": {
    "description": "The `timeout_ms` is the numeric measurement for `core:analyzer_timeout`; normative emission trigger: Analyzer execution exceeds the configured work-item deadline. (source: indexing/core-candidate-issue-codes.md).",
    "type": "integer",
    "minimum": 1
  },
  "core:analyzer_timeout.negative": {
    "description": "The `negative` is the closed detail value for `core:analyzer_timeout`; normative emission trigger: Analyzer execution exceeds the configured work-item deadline. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:analyzer_timeout.elapsed_ms": {
    "description": "The `elapsed_ms` is the numeric measurement for `core:analyzer_timeout`; normative emission trigger: Analyzer execution exceeds the configured work-item deadline. (source: indexing/core-candidate-issue-codes.md).",
    "type": "integer",
    "minimum": 0
  },
  "core:plugin_inputs_incomplete.request_id": {
    "description": "The `request_id` is the closed detail value for `core:plugin_inputs_incomplete`; normative emission trigger: A plugin request requires a source root or provider capability that the pinned analysis view cannot represent; ordinary undeclared cross-file reads do not qualify. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:plugin_inputs_incomplete.plugin_id": {
    "description": "The `plugin_id` is the closed detail value for `core:plugin_inputs_incomplete`; normative emission trigger: A plugin request requires a source root or provider capability that the pinned analysis view cannot represent; ordinary undeclared cross-file reads do not qualify. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:plugin_inputs_incomplete.call": {
    "description": "The `call` is the closed detail value for `core:plugin_inputs_incomplete`; normative emission trigger: A plugin request requires a source root or provider capability that the pinned analysis view cannot represent; ordinary undeclared cross-file reads do not qualify. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:plugin_inputs_incomplete.missing_input_kind": {
    "description": "The `missing_input_kind` is the closed detail value for `core:plugin_inputs_incomplete`; normative emission trigger: A plugin request requires a source root or provider capability that the pinned analysis view cannot represent; ordinary undeclared cross-file reads do not qualify. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:plugin_inputs_incomplete.missing_input_reference": {
    "description": "The `missing_input_reference` is the closed detail value for `core:plugin_inputs_incomplete`; normative emission trigger: A plugin request requires a source root or provider capability that the pinned analysis view cannot represent; ordinary undeclared cross-file reads do not qualify. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:plugin_unsupported.request_id": {
    "description": "The `request_id` is the closed detail value for `core:plugin_unsupported`; normative emission trigger: The negotiated plugin build explicitly does not implement the requested registered call/capability combination although activation selected it. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:plugin_unsupported.plugin_id": {
    "description": "The `plugin_id` is the closed detail value for `core:plugin_unsupported`; normative emission trigger: The negotiated plugin build explicitly does not implement the requested registered call/capability combination although activation selected it. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:plugin_unsupported.call": {
    "description": "The `call` is the closed detail value for `core:plugin_unsupported`; normative emission trigger: The negotiated plugin build explicitly does not implement the requested registered call/capability combination although activation selected it. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:plugin_unsupported.capability": {
    "description": "The `capability` is the closed detail value for `core:plugin_unsupported`; normative emission trigger: The negotiated plugin build explicitly does not implement the requested registered call/capability combination although activation selected it. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:plugin_unsupported.provider_detail_code": {
    "description": "The `provider_detail_code` is the closed detail value for `core:plugin_unsupported`; normative emission trigger: The negotiated plugin build explicitly does not implement the requested registered call/capability combination although activation selected it. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:plugin_cancelled.request_id": {
    "description": "The `request_id` is the closed detail value for `core:plugin_cancelled`; normative emission trigger: The candidate or request cancellation identity is observed before a complete response is accepted. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:plugin_cancelled.plugin_id": {
    "description": "The `plugin_id` is the closed detail value for `core:plugin_cancelled`; normative emission trigger: The candidate or request cancellation identity is observed before a complete response is accepted. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:plugin_cancelled.call": {
    "description": "The `call` is the closed detail value for `core:plugin_cancelled`; normative emission trigger: The candidate or request cancellation identity is observed before a complete response is accepted. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:plugin_cancelled.cancellation_id": {
    "description": "The `cancellation_id` is the closed detail value for `core:plugin_cancelled`; normative emission trigger: The candidate or request cancellation identity is observed before a complete response is accepted. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:plugin_resource_exhausted.request_id": {
    "description": "The `request_id` is the closed detail value for `core:plugin_resource_exhausted`; normative emission trigger: A plugin request exceeds one exact `PluginResourceBudget` component before complete output is accepted. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:plugin_resource_exhausted.plugin_id": {
    "description": "The `plugin_id` is the closed detail value for `core:plugin_resource_exhausted`; normative emission trigger: A plugin request exceeds one exact `PluginResourceBudget` component before complete output is accepted. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:plugin_resource_exhausted.call": {
    "description": "The `call` is the closed detail value for `core:plugin_resource_exhausted`; normative emission trigger: A plugin request exceeds one exact `PluginResourceBudget` component before complete output is accepted. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:plugin_resource_exhausted.resource_kind": {
    "description": "The closed plugin resource class whose configured limit was reached.",
    "enum": [
      "deadline",
      "memory_bytes",
      "output_bytes",
      "records",
      "dependencies",
      "context_operations",
      "context_bytes",
      "recursion_depth"
    ]
  },
  "core:plugin_resource_exhausted.configured_limit": {
    "description": "The `configured_limit` is the closed detail value for `core:plugin_resource_exhausted`; normative emission trigger: A plugin request exceeds one exact `PluginResourceBudget` component before complete output is accepted. (source: indexing/core-candidate-issue-codes.md).",
    "type": "integer",
    "minimum": 1
  },
  "core:plugin_resource_exhausted.observed_or_required": {
    "description": "The `observed_or_required` is the closed detail value for `core:plugin_resource_exhausted`; normative emission trigger: A plugin request exceeds one exact `PluginResourceBudget` component before complete output is accepted. (source: indexing/core-candidate-issue-codes.md).",
    "type": "integer",
    "minimum": 0
  },
  "core:plugin_failed.request_id": {
    "description": "The `request_id` is the closed detail value for `core:plugin_failed`; normative emission trigger: A plugin call other than the more specific analyzer/projection failures terminates without a complete valid response. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:plugin_failed.plugin_id": {
    "description": "The `plugin_id` is the closed detail value for `core:plugin_failed`; normative emission trigger: A plugin call other than the more specific analyzer/projection failures terminates without a complete valid response. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:plugin_failed.call": {
    "description": "The `call` is the closed detail value for `core:plugin_failed`; normative emission trigger: A plugin call other than the more specific analyzer/projection failures terminates without a complete valid response. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:plugin_failed.failure_code": {
    "description": "The `failure_code` is the closed detail value for `core:plugin_failed`; normative emission trigger: A plugin call other than the more specific analyzer/projection failures terminates without a complete valid response. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:plugin_failed.provider_detail_code": {
    "description": "The `provider_detail_code` is the closed detail value for `core:plugin_failed`; normative emission trigger: A plugin call other than the more specific analyzer/projection failures terminates without a complete valid response. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:required_delta_missing.work_item_id": {
    "description": "The `work_item_id` is the closed detail value for `core:required_delta_missing`; normative emission trigger: Analysis finishes but no accepted delta covers one or more expected replacement scopes. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:required_delta_missing.replacement_scope_ids": {
    "description": "The non-empty replacement scopes for which no accepted delta was received.",
    "type": "array",
    "minItems": 1,
    "items": {
      "type": "string"
    }
  },
  "core:required_delta_missing.received_fact_delta_ids": {
    "description": "The `received_fact_delta_ids` is the ordered identifier set for `core:required_delta_missing`; normative emission trigger: Analysis finishes but no accepted delta covers one or more expected replacement scopes. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:delta_id_conflict.fact_delta_id": {
    "description": "The `fact_delta_id` is the closed detail value for `core:delta_id_conflict`; normative emission trigger: The same `fact_delta_id` is received with a digest different from the already accepted digest. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:delta_id_conflict.accepted_digest": {
    "description": "The canonical digest value carried by core:delta_id_conflict.",
    "type": "string",
    "pattern": "^(?:sha256):[0-9a-f]{64}$"
  },
  "core:delta_id_conflict.conflicting_digest": {
    "description": "The canonical digest value carried by core:delta_id_conflict.",
    "type": "string",
    "pattern": "^(?:sha256):[0-9a-f]{64}$"
  },
  "core:delta_id_conflict.work_item_id": {
    "description": "The `work_item_id` is the closed detail value for `core:delta_id_conflict`; normative emission trigger: The same `fact_delta_id` is received with a digest different from the already accepted digest. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:delta_base_mismatch.fact_delta_id": {
    "description": "The `fact_delta_id` is the closed detail value for `core:delta_base_mismatch`; normative emission trigger: A delta names a base snapshot different from its candidate or work item. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:delta_base_mismatch.expected_base_snapshot_id": {
    "description": "The `expected_base_snapshot_id` is the closed detail value for `core:delta_base_mismatch`; normative emission trigger: A delta names a base snapshot different from its candidate or work item. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:delta_base_mismatch.actual_base_snapshot_id": {
    "description": "The `actual_base_snapshot_id` is the closed detail value for `core:delta_base_mismatch`; normative emission trigger: A delta names a base snapshot different from its candidate or work item. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:delta_scope_mismatch.fact_delta_id": {
    "description": "The `fact_delta_id` is the closed detail value for `core:delta_scope_mismatch`; normative emission trigger: Delta owner, plugin, version, capability, or replacement scope exceeds or contradicts its work item. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:delta_scope_mismatch.work_item_id": {
    "description": "The `work_item_id` is the closed detail value for `core:delta_scope_mismatch`; normative emission trigger: Delta owner, plugin, version, capability, or replacement scope exceeds or contradicts its work item. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:delta_scope_mismatch.mismatch_kind": {
    "description": "The `mismatch_kind` is the closed detail value for `core:delta_scope_mismatch`; normative emission trigger: Delta owner, plugin, version, capability, or replacement scope exceeds or contradicts its work item. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:delta_scope_mismatch.replacement_scope_id": {
    "description": "The `replacement_scope_id` is the closed detail value for `core:delta_scope_mismatch`; normative emission trigger: Delta owner, plugin, version, capability, or replacement scope exceeds or contradicts its work item. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:undeclared_input.fact_delta_id": {
    "description": "The `fact_delta_id` is the closed detail value for `core:undeclared_input`; normative emission trigger: A proposal references an artifact version, base record, or staged record absent from the core-observed accepted access manifest or its proved transitive closure. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:undeclared_input.input_type": {
    "description": "The `input_type` is the closed detail value for `core:undeclared_input`; normative emission trigger: A proposal references an artifact version, base record, or staged record absent from the core-observed accepted access manifest or its proved transitive closure. (source: indexing/core-candidate-issue-codes.md).",
    "enum": [
      "artifact_version",
      "base_record",
      "staged_record"
    ]
  },
  "core:undeclared_input.undeclared_ids": {
    "description": "The non-empty artifact, base-record, or staged-record identifiers absent from the accepted access manifest.",
    "type": "array",
    "minItems": 1,
    "items": {
      "type": "string"
    }
  },
  "core:undeclared_input.proposal_record_key": {
    "description": "The `proposal_record_key` is the closed detail value for `core:undeclared_input`; normative emission trigger: A proposal references an artifact version, base record, or staged record absent from the core-observed accepted access manifest or its proved transitive closure. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:record_schema_invalid.fact_delta_id": {
    "description": "The `fact_delta_id` is the closed detail value for `core:record_schema_invalid`; normative emission trigger: A proposed record fails its registered envelope, kind, category-body, payload Schema IR, or canonical logical-type constraints. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:record_schema_invalid.proposal_record_key": {
    "description": "The `proposal_record_key` is the closed detail value for `core:record_schema_invalid`; normative emission trigger: A proposed record fails its registered envelope, kind, category-body, payload Schema IR, or canonical logical-type constraints. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:record_schema_invalid.kind": {
    "description": "The `kind` is the closed detail value for `core:record_schema_invalid`; normative emission trigger: A proposed record fails its registered envelope, kind, category-body, payload Schema IR, or canonical logical-type constraints. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:record_schema_invalid.schema_version": {
    "description": "The `schema_version` is the closed detail value for `core:record_schema_invalid`; normative emission trigger: A proposed record fails its registered envelope, kind, category-body, payload Schema IR, or canonical logical-type constraints. (source: indexing/core-candidate-issue-codes.md).",
    "type": "integer",
    "minimum": 1
  },
  "core:record_schema_invalid.validation_error_count": {
    "description": "The `validation_error_count` is the numeric measurement for `core:record_schema_invalid`; normative emission trigger: A proposed record fails its registered envelope, kind, category-body, payload Schema IR, or canonical logical-type constraints. (source: indexing/core-candidate-issue-codes.md).",
    "type": "integer",
    "minimum": 1
  },
  "core:record_schema_invalid.json_pointers": {
    "description": "The `json_pointers` is the ordered pointer set for `core:record_schema_invalid`; normative emission trigger: A proposed record fails its registered envelope, kind, category-body, payload Schema IR, or canonical logical-type constraints. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:record_schema_invalid.uce_error_codes": {
    "description": "The `uce_error_codes` is the ordered code set for `core:record_schema_invalid`; normative emission trigger: A proposed record fails its registered envelope, kind, category-body, payload Schema IR, or canonical logical-type constraints. (source: indexing/core-candidate-issue-codes.md).",
    "type": "array",
    "items": {
      "type": "string"
    }
  },
  "core:unregistered_identifier.fact_delta_id": {
    "description": "The `fact_delta_id` is the closed detail value for `core:unregistered_identifier`; normative emission trigger: A proposal uses a kind, facet, role, code, capability, dependency role, or other registry identifier absent from the target registry. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:unregistered_identifier.proposal_record_key": {
    "description": "The `proposal_record_key` is the closed detail value for `core:unregistered_identifier`; normative emission trigger: A proposal uses a kind, facet, role, code, capability, dependency role, or other registry identifier absent from the target registry. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:unregistered_identifier.identifier_type": {
    "description": "The `identifier_type` is the closed detail value for `core:unregistered_identifier`; normative emission trigger: A proposal uses a kind, facet, role, code, capability, dependency role, or other registry identifier absent from the target registry. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:unregistered_identifier.identifier": {
    "description": "The `identifier` is the closed detail value for `core:unregistered_identifier`; normative emission trigger: A proposal uses a kind, facet, role, code, capability, dependency role, or other registry identifier absent from the target registry. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:reference_validation_failed.fact_delta_id": {
    "description": "The `fact_delta_id` is the closed detail value for `core:reference_validation_failed`; normative emission trigger: A proposed reference cannot satisfy its declared or governing target contract. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:reference_validation_failed.proposal_record_key": {
    "description": "The `proposal_record_key` is the closed detail value for `core:reference_validation_failed`; normative emission trigger: A proposed reference cannot satisfy its declared or governing target contract. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:reference_validation_failed.reference_path": {
    "description": "The `reference_path` is the closed detail value for `core:reference_validation_failed`; normative emission trigger: A proposed reference cannot satisfy its declared or governing target contract. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:reference_validation_failed.reference_failure_kind": {
    "description": "The `reference_failure_kind` is the closed detail value for `core:reference_validation_failed`; normative emission trigger: A proposed reference cannot satisfy its declared or governing target contract. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:reference_validation_failed.target_id": {
    "description": "The `target_id` is the closed detail value for `core:reference_validation_failed`; normative emission trigger: A proposed reference cannot satisfy its declared or governing target contract. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:reference_validation_failed.candidate_identity_keys": {
    "description": "The `candidate_identity_keys` is the closed detail value for `core:reference_validation_failed`; normative emission trigger: A proposed reference cannot satisfy its declared or governing target contract. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:dependency_validation_failed.fact_delta_id": {
    "description": "The `fact_delta_id` is the closed detail value for `core:dependency_validation_failed`; normative emission trigger: A proposed or derived artifact dependency is undeclared, inconsistent, unregistered, or cannot be closed deterministically. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:dependency_validation_failed.proposal_record_key": {
    "description": "The `proposal_record_key` is the closed detail value for `core:dependency_validation_failed`; normative emission trigger: A proposed or derived artifact dependency is undeclared, inconsistent, unregistered, or cannot be closed deterministically. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:dependency_validation_failed.dependency_failure_kind": {
    "description": "The `dependency_failure_kind` is the closed detail value for `core:dependency_validation_failed`; normative emission trigger: A proposed or derived artifact dependency is undeclared, inconsistent, unregistered, or cannot be closed deterministically. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:dependency_validation_failed.dependency_artifact_id": {
    "description": "The `dependency_artifact_id` is the closed detail value for `core:dependency_validation_failed`; normative emission trigger: A proposed or derived artifact dependency is undeclared, inconsistent, unregistered, or cannot be closed deterministically. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:dependency_validation_failed.dependency_artifact_version_id": {
    "description": "The `dependency_artifact_version_id` is the closed detail value for `core:dependency_validation_failed`; normative emission trigger: A proposed or derived artifact dependency is undeclared, inconsistent, unregistered, or cannot be closed deterministically. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:dependency_validation_failed.dependency_role": {
    "description": "The `dependency_role` is the closed detail value for `core:dependency_validation_failed`; normative emission trigger: A proposed or derived artifact dependency is undeclared, inconsistent, unregistered, or cannot be closed deterministically. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:replacement_scope_incomplete.fact_delta_id": {
    "description": "The `fact_delta_id` is the closed detail value for `core:replacement_scope_incomplete`; normative emission trigger: A delta claiming complete replacement omits required output, coverage claims, or scope partitions. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:replacement_scope_incomplete.replacement_scope_id": {
    "description": "The `replacement_scope_id` is the closed detail value for `core:replacement_scope_incomplete`; normative emission trigger: A delta claiming complete replacement omits required output, coverage claims, or scope partitions. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:replacement_scope_incomplete.incompleteness_kind": {
    "description": "The `incompleteness_kind` is the closed detail value for `core:replacement_scope_incomplete`; normative emission trigger: A delta claiming complete replacement omits required output, coverage claims, or scope partitions. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:replacement_scope_incomplete.missing_proposal_keys": {
    "description": "The `missing_proposal_keys` is the closed detail value for `core:replacement_scope_incomplete`; normative emission trigger: A delta claiming complete replacement omits required output, coverage claims, or scope partitions. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:replacement_scope_incomplete.missing_partition_keys": {
    "description": "The `missing_partition_keys` is the closed detail value for `core:replacement_scope_incomplete`; normative emission trigger: A delta claiming complete replacement omits required output, coverage claims, or scope partitions. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:replacement_scope_incomplete.missing_capabilities": {
    "description": "The `missing_capabilities` is the closed detail value for `core:replacement_scope_incomplete`; normative emission trigger: A delta claiming complete replacement omits required output, coverage claims, or scope partitions. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:identity_assignment_conflict.identity_type": {
    "description": "The `identity_type` is the closed detail value for `core:identity_assignment_conflict`; normative emission trigger: Core identity resolution cannot produce one legal created or continued assignment. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:identity_assignment_conflict.identity_key_digest": {
    "description": "The canonical digest value carried by core:identity_assignment_conflict.",
    "type": "string",
    "pattern": "^(?:sha256):[0-9a-f]{64}$"
  },
  "core:identity_assignment_conflict.conflict_kind": {
    "description": "The closed identity-assignment conflict category observed for the candidate.",
    "enum": [
      "MULTIPLE_ACTIVE_MATCHES",
      "DUPLICATE_CREATED_ID",
      "CONTINUATION_PREDECESSOR_MISMATCH",
      "CLOSED_ID_REUSE"
    ]
  },
  "core:identity_assignment_conflict.identity_ids": {
    "description": "The `identity_ids` is the ordered identifier set for `core:identity_assignment_conflict`; normative emission trigger: Core identity resolution cannot produce one legal created or continued assignment. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:identity_assignment_conflict.record_ids": {
    "description": "The `record_ids` is the ordered identifier set for `core:identity_assignment_conflict`; normative emission trigger: Core identity resolution cannot produce one legal created or continued assignment. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:identity_assignment_conflict.proposal_record_keys": {
    "description": "The `proposal_record_keys` is the closed detail value for `core:identity_assignment_conflict`; normative emission trigger: Core identity resolution cannot produce one legal created or continued assignment. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:candidate_digest_mismatch.candidate_generation_id": {
    "description": "The `candidate_generation_id` is the closed detail value for `core:candidate_digest_mismatch`; normative emission trigger: Recomputed candidate content does not match its frozen `candidate_digest`. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:candidate_digest_mismatch.expected_digest": {
    "description": "The canonical digest value carried by core:candidate_digest_mismatch.",
    "type": "string",
    "pattern": "^(?:sha256):[0-9a-f]{64}$"
  },
  "core:candidate_digest_mismatch.actual_digest": {
    "description": "The canonical digest value carried by core:candidate_digest_mismatch.",
    "type": "string",
    "pattern": "^(?:sha256):[0-9a-f]{64}$"
  },
  "core:candidate_digest_mismatch.digest_component": {
    "description": "The `digest_component` is the closed detail value for `core:candidate_digest_mismatch`; normative emission trigger: Recomputed candidate content does not match its frozen `candidate_digest`. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:projection_generator_failed.projection_work_item_id": {
    "description": "The `projection_work_item_id` is the closed detail value for `core:projection_generator_failed`; normative emission trigger: A registered projection generator cannot finish its work item. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:projection_generator_failed.projection_kind": {
    "description": "The `projection_kind` is the closed detail value for `core:projection_generator_failed`; normative emission trigger: A registered projection generator cannot finish its work item. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:projection_generator_failed.generator": {
    "description": "The `generator` is the closed detail value for `core:projection_generator_failed`; normative emission trigger: A registered projection generator cannot finish its work item. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:projection_generator_failed.generator_version": {
    "description": "The `generator_version` is the closed detail value for `core:projection_generator_failed`; normative emission trigger: A registered projection generator cannot finish its work item. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:projection_generator_failed.generator_error_code": {
    "description": "The `generator_error_code` is the closed detail value for `core:projection_generator_failed`; normative emission trigger: A registered projection generator cannot finish its work item. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:projection_generator_failed.provider_detail_code": {
    "description": "The `provider_detail_code` is the closed detail value for `core:projection_generator_failed`; normative emission trigger: A registered projection generator cannot finish its work item. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:projection_output_invalid.projection_work_item_id": {
    "description": "The `projection_work_item_id` is the closed detail value for `core:projection_output_invalid`; normative emission trigger: Generated output violates projection schema, ownership, source, key, or visibility invariants. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:projection_output_invalid.projection_kind": {
    "description": "The `projection_kind` is the closed detail value for `core:projection_output_invalid`; normative emission trigger: Generated output violates projection schema, ownership, source, key, or visibility invariants. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:projection_output_invalid.validation_kind": {
    "description": "The closed validation category violated by the projection output.",
    "enum": [
      "SCHEMA_INVALID",
      "OWNER_MISMATCH",
      "SOURCE_SET_EMPTY",
      "SOURCE_NOT_VISIBLE",
      "KEY_COLLISION",
      "UNDECLARED_SOURCE"
    ]
  },
  "core:projection_output_invalid.invalid_projection_count": {
    "description": "The `invalid_projection_count` is the numeric measurement for `core:projection_output_invalid`; normative emission trigger: Generated output violates projection schema, ownership, source, key, or visibility invariants. (source: indexing/core-candidate-issue-codes.md).",
    "type": "integer",
    "minimum": 1
  },
  "core:projection_output_invalid.projection_record_ids": {
    "description": "The `projection_record_ids` is the ordered identifier set for `core:projection_output_invalid`; normative emission trigger: Generated output violates projection schema, ownership, source, key, or visibility invariants. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:projection_output_invalid.source_record_ids": {
    "description": "The `source_record_ids` is the ordered identifier set for `core:projection_output_invalid`; normative emission trigger: Generated output violates projection schema, ownership, source, key, or visibility invariants. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:projection_digest_mismatch.projection_work_item_id": {
    "description": "The `projection_work_item_id` is the closed detail value for `core:projection_digest_mismatch`; normative emission trigger: The complete generated projection set does not match the computed expected digest. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:projection_digest_mismatch.expected_digest": {
    "description": "The canonical digest value carried by core:projection_digest_mismatch.",
    "type": "string",
    "pattern": "^(?:sha256):[0-9a-f]{64}$"
  },
  "core:projection_digest_mismatch.actual_digest": {
    "description": "The canonical digest value carried by core:projection_digest_mismatch.",
    "type": "string",
    "pattern": "^(?:sha256):[0-9a-f]{64}$"
  },
  "core:projection_digest_mismatch.projection_record_id": {
    "description": "The `projection_record_id` is the closed detail value for `core:projection_digest_mismatch`; normative emission trigger: The complete generated projection set does not match the computed expected digest. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:base_snapshot_changed.expected_base_snapshot_id": {
    "description": "The `expected_base_snapshot_id` is the closed detail value for `core:base_snapshot_changed`; normative emission trigger: Publication sees a different current snapshot from the candidate base. The candidate becomes stale. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:base_snapshot_changed.current_snapshot_id": {
    "description": "The `current_snapshot_id` is the closed detail value for `core:base_snapshot_changed`; normative emission trigger: Publication sees a different current snapshot from the candidate base. The candidate becomes stale. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:base_registry_changed.expected_registry_snapshot_id": {
    "description": "The `expected_registry_snapshot_id` is the closed detail value for `core:base_registry_changed`; normative emission trigger: Publication sees a different current registry from the candidate base. The candidate becomes stale. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:base_registry_changed.current_registry_snapshot_id": {
    "description": "The `current_registry_snapshot_id` is the closed detail value for `core:base_registry_changed`; normative emission trigger: Publication sees a different current registry from the candidate base. The candidate becomes stale. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:base_configuration_changed.expected_configuration_revision_id": {
    "description": "The `expected_configuration_revision_id` is the closed detail value for `core:base_configuration_changed`; normative emission trigger: Publication sees a different current configuration from the candidate base. The candidate becomes stale. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:base_configuration_changed.current_configuration_revision_id": {
    "description": "The `current_configuration_revision_id` is the closed detail value for `core:base_configuration_changed`; normative emission trigger: Publication sees a different current configuration from the candidate base. The candidate becomes stale. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:publication_conflict.workspace_id": {
    "description": "The `workspace_id` is the closed detail value for `core:publication_conflict`; normative emission trigger: A uniqueness, compare-and-swap, generation, identity, or prior-publication conflict prevents this candidate from committing. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:publication_conflict.conflict_kind": {
    "description": "The `conflict_kind` is the closed detail value for `core:publication_conflict`; normative emission trigger: A uniqueness, compare-and-swap, generation, identity, or prior-publication conflict prevents this candidate from committing. (source: indexing/core-candidate-issue-codes.md).",
    "enum": [
      "CURRENT_POINTER_CAS_FAILED",
      "GENERATION_ALREADY_ASSIGNED",
      "MANIFEST_ALREADY_PUBLISHED",
      "IDENTITY_ASSIGNMENT_COLLISION",
      "UNIQUE_INDEX_CONFLICT"
    ]
  },
  "core:publication_conflict.conflicting_id": {
    "description": "The `conflicting_id` is the closed detail value for `core:publication_conflict`; normative emission trigger: A uniqueness, compare-and-swap, generation, identity, or prior-publication conflict prevents this candidate from committing. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:publication_conflict.current_snapshot_id": {
    "description": "The `current_snapshot_id` is the closed detail value for `core:publication_conflict`; normative emission trigger: A uniqueness, compare-and-swap, generation, identity, or prior-publication conflict prevents this candidate from committing. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:atomic_publication_failed.publication_step": {
    "description": "The closed atomic-publication step at which the transaction failed.",
    "enum": [
      "BEGIN",
      "VALIDATE_BASE",
      "INSTALL_SOURCE_STATE",
      "INSTALL_CANONICAL",
      "INSTALL_PROJECTIONS",
      "INSTALL_MANIFEST",
      "SWAP_CURRENT_POINTER",
      "COMMIT"
    ]
  },
  "core:atomic_publication_failed.storage_cause_code": {
    "description": "The `storage_cause_code` is the closed detail value for `core:atomic_publication_failed`; normative emission trigger: The storage transaction cannot install the complete candidate tuple atomically. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:atomic_publication_failed.transaction_rolled_back": {
    "description": "The `transaction_rolled_back` is the closed detail value for `core:atomic_publication_failed`; normative emission trigger: The storage transaction cannot install the complete candidate tuple atomically. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:atomic_publication_failed.recovery_operation_id": {
    "description": "The `recovery_operation_id` is the closed detail value for `core:atomic_publication_failed`; normative emission trigger: The storage transaction cannot install the complete candidate tuple atomically. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:candidate_cleanup_failed.resource_type": {
    "description": "The closed candidate resource class that could not be cleaned up.",
    "enum": [
      "candidate_materialization",
      "retention_lease",
      "temporary_projection",
      "temporary_blob"
    ]
  },
  "core:candidate_cleanup_failed.resource_id": {
    "description": "The `resource_id` is the closed detail value for `core:candidate_cleanup_failed`; normative emission trigger: Candidate-private materialization or an ended lease cannot be cleaned after the candidate reaches a terminal state. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:candidate_cleanup_failed.cleanup_operation": {
    "description": "The closed cleanup operation that failed for the candidate resource.",
    "enum": [
      "release",
      "delete",
      "compact"
    ]
  },
  "core:candidate_cleanup_failed.cleanup_error_code": {
    "description": "The `cleanup_error_code` is the closed detail value for `core:candidate_cleanup_failed`; normative emission trigger: Candidate-private materialization or an ended lease cannot be cleaned after the candidate reaches a terminal state. (source: indexing/core-candidate-issue-codes.md)."
  },
  "core:request_invalid.schema_pointer": {
    "description": "The `schema_pointer` is the closed detail value for `core:request_invalid`; normative emission trigger: Input is not an instance of the selected closed request schema after JSON decoding. (source: protocol/core-operation-error-codes.md)."
  },
  "core:request_invalid.violation": {
    "description": "The `violation` is the closed detail value for `core:request_invalid`; normative emission trigger: Input is not an instance of the selected closed request schema after JSON decoding. (source: protocol/core-operation-error-codes.md)."
  },
  "core:api_version_unsupported.requested_version": {
    "description": "The `requested_version` is the closed detail value for `core:api_version_unsupported`; normative emission trigger: `api_version` is syntactically valid but not one of the server's exact supported versions. (source: protocol/core-operation-error-codes.md).",
    "type": "integer",
    "minimum": 1
  },
  "core:api_version_unsupported.supported_versions": {
    "description": "The `supported_versions` is the closed detail value for `core:api_version_unsupported`; normative emission trigger: `api_version` is syntactically valid but not one of the server's exact supported versions. (source: protocol/core-operation-error-codes.md)."
  },
  "core:unknown_field.object_pointer": {
    "description": "The `object_pointer` is the closed detail value for `core:unknown_field`; normative emission trigger: A closed request object contains at least one undeclared field. (source: protocol/core-operation-error-codes.md)."
  },
  "core:unknown_field.field_names": {
    "description": "The `field_names` is the closed detail value for `core:unknown_field`; normative emission trigger: A closed request object contains at least one undeclared field. (source: protocol/core-operation-error-codes.md)."
  },
  "core:option_conflict.option_pointers": {
    "description": "The `option_pointers` is the ordered pointer set for `core:option_conflict`; normative emission trigger: Individually valid options violate a documented presence or interaction rule. (source: protocol/core-operation-error-codes.md)."
  },
  "core:option_conflict.rule_code": {
    "description": "The `rule_code` is the closed detail value for `core:option_conflict`; normative emission trigger: Individually valid options violate a documented presence or interaction rule. (source: protocol/core-operation-error-codes.md)."
  },
  "core:budget_invalid.budget_field": {
    "description": "The canonical request pointer naming the budget whose supplied value is outside the operation's advertised bounds."
  },
  "core:budget_invalid.provided": {
    "description": "The supplied numeric budget value that failed the selected operation's bounds.",
    "type": "integer",
    "minimum": 0
  },
  "core:budget_invalid.minimum": {
    "description": "The inclusive minimum permitted value for the named budget.",
    "type": "integer",
    "minimum": 0
  },
  "core:budget_invalid.maximum": {
    "description": "The inclusive maximum permitted value for the named budget.",
    "type": "integer",
    "minimum": 0
  },
  "core:workspace_not_registered.registration_command": {
    "description": "The `registration_command` is the closed detail value for `core:workspace_not_registered`; normative emission trigger: An explicit API v2 workspace root has no exact registered workspace after canonicalization. (source: protocol/core-operation-error-codes.md)."
  },
  "core:workspace_not_found.workspace_id": {
    "description": "The `workspace_id` is the closed detail value for `core:workspace_not_found`; normative emission trigger: An explicit workspace ID has no registered workspace. (source: protocol/core-operation-error-codes.md)."
  },
  "core:duplicate_comparison_participant.workspace_id": {
    "description": "The `workspace_id` is the closed detail value for `core:duplicate_comparison_participant`; normative emission trigger: A comparison duplicates a role or exact workspace-snapshot coordinate, or repeats one workspace without distinct explicit snapshots. (source: protocol/core-operation-error-codes.md)."
  },
  "core:duplicate_comparison_participant.snapshot_ids": {
    "description": "The exact snapshot identifiers associated with the duplicated comparison participant.",
    "type": "array",
    "minItems": 1,
    "items": {
      "type": "string"
    }
  },
  "core:duplicate_comparison_participant.roles": {
    "description": "The `roles` is the closed detail value for `core:duplicate_comparison_participant`; normative emission trigger: A comparison duplicates a role or exact workspace-snapshot coordinate, or repeats one workspace without distinct explicit snapshots. (source: protocol/core-operation-error-codes.md)."
  },
  "core:duplicate_comparison_participant.participant_ordinals": {
    "description": "The `participant_ordinals` is the closed detail value for `core:duplicate_comparison_participant`; normative emission trigger: A comparison duplicates a role or exact workspace-snapshot coordinate, or repeats one workspace without distinct explicit snapshots. (source: protocol/core-operation-error-codes.md)."
  },
  "core:participant_role_invalid.operation": {
    "description": "The `operation` is the closed detail value for `core:participant_role_invalid`; normative emission trigger: A required role is missing, duplicated, unknown, or illegal for the selected operation. (source: protocol/core-operation-error-codes.md)."
  },
  "core:participant_role_invalid.provided_roles": {
    "description": "The `provided_roles` is the closed detail value for `core:participant_role_invalid`; normative emission trigger: A required role is missing, duplicated, unknown, or illegal for the selected operation. (source: protocol/core-operation-error-codes.md)."
  },
  "core:participant_role_invalid.required_roles": {
    "description": "The `required_roles` is the closed detail value for `core:participant_role_invalid`; normative emission trigger: A required role is missing, duplicated, unknown, or illegal for the selected operation. (source: protocol/core-operation-error-codes.md)."
  },
  "core:snapshot_not_found.workspace_id": {
    "description": "The `workspace_id` is the closed detail value for `core:snapshot_not_found`; normative emission trigger: An explicit snapshot ID is unknown or belongs to another workspace. (source: protocol/core-operation-error-codes.md)."
  },
  "core:snapshot_not_found.snapshot_id": {
    "description": "The `snapshot_id` is the closed detail value for `core:snapshot_not_found`; normative emission trigger: An explicit snapshot ID is unknown or belongs to another workspace. (source: protocol/core-operation-error-codes.md)."
  },
  "core:snapshot_expired.workspace_id": {
    "description": "The `workspace_id` is the closed detail value for `core:snapshot_expired`; normative emission trigger: The snapshot identity is known but its queryable payload has been collected. (source: protocol/core-operation-error-codes.md)."
  },
  "core:snapshot_expired.snapshot_id": {
    "description": "The `snapshot_id` is the closed detail value for `core:snapshot_expired`; normative emission trigger: The snapshot identity is known but its queryable payload has been collected. (source: protocol/core-operation-error-codes.md)."
  },
  "core:snapshot_expired.generation": {
    "description": "The `generation` is the closed detail value for `core:snapshot_expired`; normative emission trigger: The snapshot identity is known but its queryable payload has been collected. (source: protocol/core-operation-error-codes.md)."
  },
  "core:snapshot_expired.expired_at": {
    "description": "The `expired_at` is the closed detail value for `core:snapshot_expired`; normative emission trigger: The snapshot identity is known but its queryable payload has been collected. (source: protocol/core-operation-error-codes.md)."
  },
  "core:scope_mismatch.query_execution_id": {
    "description": "The `query_execution_id` is the closed detail value for `core:scope_mismatch`; normative emission trigger: Explicit continuation scope differs from the execution's ordered workspace IDs, comparison roles, or snapshot selectors. (source: protocol/core-operation-error-codes.md)."
  },
  "core:scope_mismatch.expected_scope_digest": {
    "description": "The canonical digest value carried by core:scope_mismatch.",
    "type": "string",
    "pattern": "^(?:sha256):[0-9a-f]{64}$"
  },
  "core:scope_mismatch.provided_scope_digest": {
    "description": "The canonical digest value carried by core:scope_mismatch.",
    "type": "string",
    "pattern": "^(?:sha256):[0-9a-f]{64}$"
  },
  "core:operation_unknown.operation": {
    "description": "The `operation` is the closed detail value for `core:operation_unknown`; normative emission trigger: No operation definition exists for the exact identifier under the selected API version. (source: protocol/core-operation-error-codes.md)."
  },
  "core:operation_unknown.api_version": {
    "description": "The `api_version` is the closed detail value for `core:operation_unknown`; normative emission trigger: No operation definition exists for the exact identifier under the selected API version. (source: protocol/core-operation-error-codes.md).",
    "type": "integer",
    "minimum": 1
  },
  "core:recipe_unknown.recipe_id": {
    "description": "The `recipe_id` is the closed detail value for `core:recipe_unknown`; normative emission trigger: No recipe exists for the exact recipe ID. (source: protocol/core-operation-error-codes.md)."
  },
  "core:recipe_version_unsupported.recipe_id": {
    "description": "The `recipe_id` is the closed detail value for `core:recipe_version_unsupported`; normative emission trigger: The recipe exists but the requested exact version is unsupported. (source: protocol/core-operation-error-codes.md)."
  },
  "core:recipe_version_unsupported.requested_version": {
    "description": "The `requested_version` is the closed detail value for `core:recipe_version_unsupported`; normative emission trigger: The recipe exists but the requested exact version is unsupported. (source: protocol/core-operation-error-codes.md).",
    "type": "integer",
    "minimum": 1
  },
  "core:recipe_version_unsupported.supported_versions": {
    "description": "The `supported_versions` is the closed detail value for `core:recipe_version_unsupported`; normative emission trigger: The recipe exists but the requested exact version is unsupported. (source: protocol/core-operation-error-codes.md)."
  },
  "core:stage_reference_invalid.stage_id": {
    "description": "The `stage_id` is the closed detail value for `core:stage_reference_invalid`; normative emission trigger: A stage input names a missing, later, or non-output stage coordinate. (source: protocol/core-operation-error-codes.md)."
  },
  "core:stage_reference_invalid.input_ordinal": {
    "description": "The `input_ordinal` is the closed detail value for `core:stage_reference_invalid`; normative emission trigger: A stage input names a missing, later, or non-output stage coordinate. (source: protocol/core-operation-error-codes.md)."
  },
  "core:stage_reference_invalid.referenced_stage_id": {
    "description": "The `referenced_stage_id` is the closed detail value for `core:stage_reference_invalid`; normative emission trigger: A stage input names a missing, later, or non-output stage coordinate. (source: protocol/core-operation-error-codes.md)."
  },
  "core:stage_reference_invalid.referenced_output": {
    "description": "The `referenced_output` is the closed detail value for `core:stage_reference_invalid`; normative emission trigger: A stage input names a missing, later, or non-output stage coordinate. (source: protocol/core-operation-error-codes.md)."
  },
  "core:stage_type_mismatch.stage_id": {
    "description": "The `stage_id` is the closed detail value for `core:stage_type_mismatch`; normative emission trigger: An existing stage output type cannot satisfy the receiving operator input type. (source: protocol/core-operation-error-codes.md)."
  },
  "core:stage_type_mismatch.input_ordinal": {
    "description": "The `input_ordinal` is the closed detail value for `core:stage_type_mismatch`; normative emission trigger: An existing stage output type cannot satisfy the receiving operator input type. (source: protocol/core-operation-error-codes.md)."
  },
  "core:stage_type_mismatch.actual_type": {
    "description": "The `actual_type` is the closed detail value for `core:stage_type_mismatch`; normative emission trigger: An existing stage output type cannot satisfy the receiving operator input type. (source: protocol/core-operation-error-codes.md)."
  },
  "core:stage_type_mismatch.expected_types": {
    "description": "The `expected_types` is the closed detail value for `core:stage_type_mismatch`; normative emission trigger: An existing stage output type cannot satisfy the receiving operator input type. (source: protocol/core-operation-error-codes.md)."
  },
  "core:selector_invalid.selector_pointer": {
    "description": "The `selector_pointer` is the closed detail value for `core:selector_invalid`; normative emission trigger: A kind, facet, path, regex, namespace, registry, relation, or evidence selector violates its closed grammar or registry constraints. (source: protocol/core-operation-error-codes.md)."
  },
  "core:selector_invalid.reason_code": {
    "description": "The `reason_code` is the closed detail value for `core:selector_invalid`; normative emission trigger: A kind, facet, path, regex, namespace, registry, relation, or evidence selector violates its closed grammar or registry constraints. (source: protocol/core-operation-error-codes.md)."
  },
  "core:selector_invalid.definition_ids": {
    "description": "The `definition_ids` is the ordered identifier set for `core:selector_invalid`; normative emission trigger: A kind, facet, path, regex, namespace, registry, relation, or evidence selector violates its closed grammar or registry constraints. (source: protocol/core-operation-error-codes.md)."
  },
  "core:selector_not_found.recipe_id": {
    "description": "The `recipe_id` is the closed detail value for `core:selector_not_found`; normative emission trigger: A recipe guard requiring one existing confirmed subject receives no confirmed subject. (source: protocol/core-operation-error-codes.md)."
  },
  "core:selector_not_found.stage_id": {
    "description": "The `stage_id` is the closed detail value for `core:selector_not_found`; normative emission trigger: A recipe guard requiring one existing confirmed subject receives no confirmed subject. (source: protocol/core-operation-error-codes.md)."
  },
  "core:selector_not_found.selector_pointer": {
    "description": "The `selector_pointer` is the closed detail value for `core:selector_not_found`; normative emission trigger: A recipe guard requiring one existing confirmed subject receives no confirmed subject. (source: protocol/core-operation-error-codes.md)."
  },
  "core:selector_not_found.possible_candidate_ids": {
    "description": "The `possible_candidate_ids` is the ordered identifier set for `core:selector_not_found`; normative emission trigger: A recipe guard requiring one existing confirmed subject receives no confirmed subject. (source: protocol/core-operation-error-codes.md)."
  },
  "core:selector_ambiguous.recipe_id": {
    "description": "The `recipe_id` is the closed detail value for `core:selector_ambiguous`; normative emission trigger: A recipe guard requiring one confirmed subject receives more than one confirmed subject. (source: protocol/core-operation-error-codes.md)."
  },
  "core:selector_ambiguous.stage_id": {
    "description": "The `stage_id` is the closed detail value for `core:selector_ambiguous`; normative emission trigger: A recipe guard requiring one confirmed subject receives more than one confirmed subject. (source: protocol/core-operation-error-codes.md)."
  },
  "core:selector_ambiguous.selector_pointer": {
    "description": "The `selector_pointer` is the closed detail value for `core:selector_ambiguous`; normative emission trigger: A recipe guard requiring one confirmed subject receives more than one confirmed subject. (source: protocol/core-operation-error-codes.md)."
  },
  "core:selector_ambiguous.confirmed_candidate_ids": {
    "description": "The `confirmed_candidate_ids` is the ordered identifier set for `core:selector_ambiguous`; normative emission trigger: A recipe guard requiring one confirmed subject receives more than one confirmed subject. (source: protocol/core-operation-error-codes.md)."
  },
  "core:selector_ambiguous.possible_candidate_ids": {
    "description": "The `possible_candidate_ids` is the ordered identifier set for `core:selector_ambiguous`; normative emission trigger: A recipe guard requiring one confirmed subject receives more than one confirmed subject. (source: protocol/core-operation-error-codes.md)."
  },
  "core:invalid_query_scope.recipe_id": {
    "description": "The `recipe_id` is the closed detail value for `core:invalid_query_scope`; normative emission trigger: A recipe's closed scope guard rejects an otherwise schema-valid query scope. (source: protocol/core-operation-error-codes.md)."
  },
  "core:invalid_query_scope.required_scope_kind": {
    "description": "The `required_scope_kind` is the closed detail value for `core:invalid_query_scope`; normative emission trigger: A recipe's closed scope guard rejects an otherwise schema-valid query scope. (source: protocol/core-operation-error-codes.md)."
  },
  "core:invalid_query_scope.required_roles": {
    "description": "The `required_roles` is the closed detail value for `core:invalid_query_scope`; normative emission trigger: A recipe's closed scope guard rejects an otherwise schema-valid query scope. (source: protocol/core-operation-error-codes.md)."
  },
  "core:invalid_query_scope.provided_scope_kind": {
    "description": "The `provided_scope_kind` is the closed detail value for `core:invalid_query_scope`; normative emission trigger: A recipe's closed scope guard rejects an otherwise schema-valid query scope. (source: protocol/core-operation-error-codes.md)."
  },
  "core:invalid_query_scope.provided_roles": {
    "description": "The `provided_roles` is the closed detail value for `core:invalid_query_scope`; normative emission trigger: A recipe's closed scope guard rejects an otherwise schema-valid query scope. (source: protocol/core-operation-error-codes.md)."
  },
  "core:invalid_definition_instance_selector.recipe_id": {
    "description": "The `recipe_id` is the closed detail value for `core:invalid_definition_instance_selector`; normative emission trigger: `core:definition_to_instances` receives a selected definition family other than record kind, facet, or language. Empty exact discovery is valid and does not trigger this code. (source: protocol/core-operation-error-codes.md)."
  },
  "core:invalid_definition_instance_selector.definition_ids": {
    "description": "The non-empty selected definition identifiers that belong to unsupported definition families.",
    "type": "array",
    "minItems": 1,
    "items": {
      "type": "string"
    }
  },
  "core:invalid_definition_instance_selector.definition_types": {
    "description": "The non-empty selected definition families that are not record kind, facet, or language.",
    "type": "array",
    "minItems": 1,
    "items": {
      "type": "string"
    }
  },
  "core:invalid_definition_instance_selector.reason_code": {
    "description": "The `reason_code` is the closed detail value for `core:invalid_definition_instance_selector`; normative emission trigger: `core:definition_to_instances` receives a selected definition family other than record kind, facet, or language. Empty exact discovery is valid and does not trigger this code. (source: protocol/core-operation-error-codes.md)."
  },
  "core:registry_definition_unavailable.definition_id": {
    "description": "The `definition_id` is the closed detail value for `core:registry_definition_unavailable`; normative emission trigger: A request references a definition absent from at least one required pinned registry. (source: protocol/core-operation-error-codes.md)."
  },
  "core:registry_definition_unavailable.definition_type": {
    "description": "The `definition_type` is the closed detail value for `core:registry_definition_unavailable`; normative emission trigger: A request references a definition absent from at least one required pinned registry. (source: protocol/core-operation-error-codes.md)."
  },
  "core:registry_definition_unavailable.registry_snapshot_ids": {
    "description": "The `registry_snapshot_ids` is the ordered identifier set for `core:registry_definition_unavailable`; normative emission trigger: A request references a definition absent from at least one required pinned registry. (source: protocol/core-operation-error-codes.md)."
  },
  "core:required_capability_unsupported.capability": {
    "description": "The `capability` is the closed detail value for `core:required_capability_unsupported`; normative emission trigger: A mandatory operation capability is unsupported in at least one selected scope and the operation defines no accepted fallback. (source: protocol/core-operation-error-codes.md)."
  },
  "core:required_capability_unsupported.workspace_snapshot_binding_ids": {
    "description": "The `workspace_snapshot_binding_ids` is the ordered identifier set for `core:required_capability_unsupported`; normative emission trigger: A mandatory operation capability is unsupported in at least one selected scope and the operation defines no accepted fallback. (source: protocol/core-operation-error-codes.md).",
    "type": "array",
    "minItems": 1,
    "items": {
      "type": "string"
    }
  },
  "core:required_capability_unsupported.reason_codes": {
    "description": "The `reason_codes` is the ordered code set for `core:required_capability_unsupported`; normative emission trigger: A mandatory operation capability is unsupported in at least one selected scope and the operation defines no accepted fallback. (source: protocol/core-operation-error-codes.md)."
  },
  "core:freshness_wait_timeout.workspace_ids": {
    "description": "The exact workspace identifiers whose freshness checkpoints did not reach the requested boundary."
  },
  "core:freshness_wait_timeout.waited_ms": {
    "description": "The elapsed non-negative wait in milliseconds before the freshness boundary expired.",
    "type": "integer",
    "minimum": 0
  },
  "core:freshness_wait_timeout.pending_observation_counts": {
    "description": "The non-negative pending observation count for each workspace, in the same order as workspace_ids.",
    "type": "array",
    "items": {
      "type": "integer",
      "minimum": 0
    }
  },
  "core:freshness_wait_timeout.retry_after_ms": {
    "description": "The optional non-negative server estimate in milliseconds before another freshness attempt may make progress.",
    "type": "integer",
    "minimum": 0
  },
  "core:coverage_incomplete.capabilities": {
    "description": "The `capabilities` is the closed detail value for `core:coverage_incomplete`; normative emission trigger: `require_complete` reaches its wait boundary while a non-semantic required capability remains non-complete. (source: protocol/core-operation-error-codes.md)."
  },
  "core:coverage_incomplete.workspace_snapshot_binding_ids": {
    "description": "The `workspace_snapshot_binding_ids` is the ordered identifier set for `core:coverage_incomplete`; normative emission trigger: `require_complete` reaches its wait boundary while a non-semantic required capability remains non-complete. (source: protocol/core-operation-error-codes.md)."
  },
  "core:coverage_incomplete.statuses": {
    "description": "The `statuses` is the closed detail value for `core:coverage_incomplete`; normative emission trigger: `require_complete` reaches its wait boundary while a non-semantic required capability remains non-complete. (source: protocol/core-operation-error-codes.md)."
  },
  "core:coverage_incomplete.waited_ms": {
    "description": "The `waited_ms` is the numeric measurement for `core:coverage_incomplete`; normative emission trigger: `require_complete` reaches its wait boundary while a non-semantic required capability remains non-complete. (source: protocol/core-operation-error-codes.md).",
    "type": "integer",
    "minimum": 0
  },
  "core:execution_resource_limit.limit_kind": {
    "description": "The `limit_kind` is the closed detail value for `core:execution_resource_limit`; normative emission trigger: Exact evaluation cannot finish within a declared hard work, memory, time, or intermediate-result limit. (source: protocol/core-operation-error-codes.md)."
  },
  "core:execution_resource_limit.configured_limit": {
    "description": "The `configured_limit` is the closed detail value for `core:execution_resource_limit`; normative emission trigger: Exact evaluation cannot finish within a declared hard work, memory, time, or intermediate-result limit. (source: protocol/core-operation-error-codes.md).",
    "type": "integer",
    "minimum": 1
  },
  "core:execution_resource_limit.observed_or_required": {
    "description": "The `observed_or_required` is the closed detail value for `core:execution_resource_limit`; normative emission trigger: Exact evaluation cannot finish within a declared hard work, memory, time, or intermediate-result limit. (source: protocol/core-operation-error-codes.md).",
    "type": "integer",
    "minimum": 0
  },
  "core:execution_resource_limit.stage_id": {
    "description": "The `stage_id` is the closed detail value for `core:execution_resource_limit`; normative emission trigger: Exact evaluation cannot finish within a declared hard work, memory, time, or intermediate-result limit. (source: protocol/core-operation-error-codes.md)."
  },
  "core:operation_cancelled.stage_id": {
    "description": "The `stage_id` is the closed detail value for `core:operation_cancelled`; normative emission trigger: Caller cancellation is observed before a ready manifest is published. (source: protocol/core-operation-error-codes.md)."
  },
  "core:execution_failed.failure_id": {
    "description": "The `failure_id` is the closed detail value for `core:execution_failed`; normative emission trigger: An unexpected core execution failure prevents a trustworthy manifest and no narrower registered code applies. (source: protocol/core-operation-error-codes.md)."
  },
  "core:execution_failed.phase": {
    "description": "The `phase` is the closed detail value for `core:execution_failed`; normative emission trigger: An unexpected core execution failure prevents a trustworthy manifest and no narrower registered code applies. (source: protocol/core-operation-error-codes.md)."
  },
  "core:index_unavailable.workspace_id": {
    "description": "The `workspace_id` is the closed detail value for `core:index_unavailable`; normative emission trigger: A required workspace has no published queryable snapshot. (source: protocol/core-operation-error-codes.md)."
  },
  "core:index_unavailable.index_state": {
    "description": "The `index_state` is the closed detail value for `core:index_unavailable`; normative emission trigger: A required workspace has no published queryable snapshot. (source: protocol/core-operation-error-codes.md)."
  },
  "core:index_unavailable.candidate_generation_id": {
    "description": "The `candidate_generation_id` is the closed detail value for `core:index_unavailable`; normative emission trigger: A required workspace has no published queryable snapshot. (source: protocol/core-operation-error-codes.md)."
  },
  "core:daemon_restart_required.data_root_id": {
    "description": "The `data_root_id` is the closed detail value for `core:daemon_restart_required`; normative emission trigger: `urdira mcp` detects a live daemon for the selected data root whose engine build or private interface is incompatible, and safe coordinated replacement cannot proceed. No domain request is forwarded. (source: protocol/core-operation-error-codes.md)."
  },
  "core:daemon_restart_required.detected_engine_build_id": {
    "description": "The `detected_engine_build_id` is the closed detail value for `core:daemon_restart_required`; normative emission trigger: `urdira mcp` detects a live daemon for the selected data root whose engine build or private interface is incompatible, and safe coordinated replacement cannot proceed. No domain request is forwarded. (source: protocol/core-operation-error-codes.md)."
  },
  "core:daemon_restart_required.required_engine_build_id": {
    "description": "The `required_engine_build_id` is the closed detail value for `core:daemon_restart_required`; normative emission trigger: `urdira mcp` detects a live daemon for the selected data root whose engine build or private interface is incompatible, and safe coordinated replacement cannot proceed. No domain request is forwarded. (source: protocol/core-operation-error-codes.md)."
  },
  "core:daemon_restart_required.blocking_reason": {
    "description": "The `blocking_reason` is the closed detail value for `core:daemon_restart_required`; normative emission trigger: `urdira mcp` detects a live daemon for the selected data root whose engine build or private interface is incompatible, and safe coordinated replacement cannot proceed. No domain request is forwarded. (source: protocol/core-operation-error-codes.md).",
    "enum": [
      "active_publication",
      "active_migration",
      "active_administrative_operation",
      "active_clients",
      "restart_lease_denied",
      "restart_lease_timeout",
      "storage_upgrade_required",
      "owner_mismatch"
    ]
  },
  "core:daemon_restart_required.safe_automatic_restart": {
    "description": "The `safe_automatic_restart` is the closed detail value for `core:daemon_restart_required`; normative emission trigger: `urdira mcp` detects a live daemon for the selected data root whose engine build or private interface is incompatible, and safe coordinated replacement cannot proceed. No domain request is forwarded. (source: protocol/core-operation-error-codes.md)."
  },
  "core:cursor_invalid.reason_code": {
    "description": "The `reason_code` is the closed detail value for `core:cursor_invalid`; normative emission trigger: Cursor decoding, authentication, required claims, or execution lookup fails and expiry is not established. (source: protocol/core-operation-error-codes.md)."
  },
  "core:cursor_expired.query_execution_id": {
    "description": "The `query_execution_id` is the closed detail value for `core:cursor_expired`; normative emission trigger: The cursor's execution lifetime has ended. (source: protocol/core-operation-error-codes.md)."
  },
  "core:cursor_expired.expired_at": {
    "description": "The `expired_at` is the closed detail value for `core:cursor_expired`; normative emission trigger: The cursor's execution lifetime has ended. (source: protocol/core-operation-error-codes.md)."
  },
  "core:query_execution_evicted.query_execution_id": {
    "description": "The `query_execution_id` is the closed detail value for `core:query_execution_evicted`; normative emission trigger: The execution expired early under an explicitly advertised emergency-eviction policy. (source: protocol/core-operation-error-codes.md)."
  },
  "core:query_execution_evicted.evicted_at": {
    "description": "The `evicted_at` is the closed detail value for `core:query_execution_evicted`; normative emission trigger: The execution expired early under an explicitly advertised emergency-eviction policy. (source: protocol/core-operation-error-codes.md)."
  },
  "core:query_execution_evicted.reason_code": {
    "description": "The `reason_code` is the closed detail value for `core:query_execution_evicted`; normative emission trigger: The execution expired early under an explicitly advertised emergency-eviction policy. (source: protocol/core-operation-error-codes.md)."
  },
  "core:cursor_kind_mismatch.expected_cursor_kind": {
    "description": "The `expected_cursor_kind` is the closed detail value for `core:cursor_kind_mismatch`; normative emission trigger: A query cursor is supplied to index-status continuation or an index-status cursor is supplied to query continuation. No execution hydration is attempted. (source: protocol/core-operation-error-codes.md)."
  },
  "core:cursor_kind_mismatch.actual_cursor_kind": {
    "description": "The `actual_cursor_kind` is the closed detail value for `core:cursor_kind_mismatch`; normative emission trigger: A query cursor is supplied to index-status continuation or an index-status cursor is supplied to query continuation. No execution hydration is attempted. (source: protocol/core-operation-error-codes.md)."
  },
  "core:cursor_kind_mismatch.execution_id": {
    "description": "The `execution_id` is the closed detail value for `core:cursor_kind_mismatch`; normative emission trigger: A query cursor is supplied to index-status continuation or an index-status cursor is supplied to query continuation. No execution hydration is attempted. (source: protocol/core-operation-error-codes.md)."
  },
  "core:cursor_stream_mismatch.query_execution_id": {
    "description": "The `query_execution_id` is the closed detail value for `core:cursor_stream_mismatch`; normative emission trigger: A cursor is supplied to an endpoint or continuation variant that cannot hydrate its selected stream. (source: protocol/core-operation-error-codes.md)."
  },
  "core:cursor_stream_mismatch.result_stream": {
    "description": "The `result_stream` is the closed detail value for `core:cursor_stream_mismatch`; normative emission trigger: A cursor is supplied to an endpoint or continuation variant that cannot hydrate its selected stream. (source: protocol/core-operation-error-codes.md)."
  },
  "core:cursor_projection_mismatch.execution_id": {
    "description": "The `execution_id` is the closed detail value for `core:cursor_projection_mismatch`; normative emission trigger: Continuation attempts to change a result, evidence, diagnostic, registry, semantic-coverage, snippet, or status projection fixed by the cursor. (source: protocol/core-operation-error-codes.md)."
  },
  "core:cursor_projection_mismatch.expected_projection_digest": {
    "description": "The canonical digest value carried by core:cursor_projection_mismatch.",
    "type": "string",
    "pattern": "^(?:sha256):[0-9a-f]{64}$"
  },
  "core:cursor_projection_mismatch.provided_projection_digest": {
    "description": "The canonical digest value carried by core:cursor_projection_mismatch.",
    "type": "string",
    "pattern": "^(?:sha256):[0-9a-f]{64}$"
  },
  "core:query_embedding_failed.semantic_lane_id": {
    "description": "The `semantic_lane_id` is the closed detail value for `core:query_embedding_failed`; normative emission trigger: A mandatory semantic lane cannot create the exact query vector under its pinned executable binding. (source: protocol/core-operation-error-codes.md)."
  },
  "core:query_embedding_failed.embedding_profile_id": {
    "description": "The `embedding_profile_id` is the closed detail value for `core:query_embedding_failed`; normative emission trigger: A mandatory semantic lane cannot create the exact query vector under its pinned executable binding. (source: protocol/core-operation-error-codes.md)."
  },
  "core:query_embedding_failed.failure_code": {
    "description": "The `failure_code` is the closed detail value for `core:query_embedding_failed`; normative emission trigger: A mandatory semantic lane cannot create the exact query vector under its pinned executable binding. (source: protocol/core-operation-error-codes.md)."
  },
  "core:source_unavailable.workspace_snapshot_binding_id": {
    "description": "The `workspace_snapshot_binding_id` is the closed detail value for `core:source_unavailable`; normative emission trigger: Hydration cannot read a source blob required by a selected result from its retained snapshot. (source: protocol/core-operation-error-codes.md)."
  },
  "core:source_unavailable.artifact_id": {
    "description": "The `artifact_id` is the closed detail value for `core:source_unavailable`; normative emission trigger: Hydration cannot read a source blob required by a selected result from its retained snapshot. (source: protocol/core-operation-error-codes.md)."
  },
  "core:source_unavailable.artifact_version_id": {
    "description": "The `artifact_version_id` is the closed detail value for `core:source_unavailable`; normative emission trigger: Hydration cannot read a source blob required by a selected result from its retained snapshot. (source: protocol/core-operation-error-codes.md)."
  },
  "core:source_unavailable.content_digest": {
    "description": "The canonical digest value carried by core:source_unavailable.",
    "type": "string",
    "pattern": "^(?:sha256):[0-9a-f]{64}$"
  },
  "core:snippet_budget_impossible.required_minimum_characters": {
    "description": "The `required_minimum_characters` is the closed detail value for `core:snippet_budget_impossible`; normative emission trigger: The requested mandatory snippet projection cannot emit even one valid unit within the supplied character budget. (source: protocol/core-operation-error-codes.md).",
    "type": "integer",
    "minimum": 1
  },
  "core:snippet_budget_impossible.provided_max_characters": {
    "description": "The `provided_max_characters` is the closed detail value for `core:snippet_budget_impossible`; normative emission trigger: The requested mandatory snippet projection cannot emit even one valid unit within the supplied character budget. (source: protocol/core-operation-error-codes.md).",
    "type": "integer",
    "minimum": 1
  },
  "core:retained_definition_unavailable.registry_snapshot_id": {
    "description": "The `registry_snapshot_id` is the closed detail value for `core:retained_definition_unavailable`; normative emission trigger: Hydration cannot load a registry definition required to interpret a retained result page. (source: protocol/core-operation-error-codes.md)."
  },
  "core:retained_definition_unavailable.definition_ids": {
    "description": "The `definition_ids` is the ordered identifier set for `core:retained_definition_unavailable`; normative emission trigger: Hydration cannot load a registry definition required to interpret a retained result page. (source: protocol/core-operation-error-codes.md)."
  },
  "core:embedding_profile_not_found.embedding_profile_id": {
    "description": "Required exact core-owned identifier referenced by the pinned configuration or materialization. It is never copied from a normal agent query selector."
  },
  "core:embedding_profile_not_found.workspace_snapshot_binding_ids": {
    "description": "Required bindings whose registries do not contain the profile."
  },
  "core:embedding_profile_incompatible.embedding_profile_id": {
    "description": "Required selected profile."
  },
  "core:embedding_profile_incompatible.semantic_lane_id": {
    "description": "Required normalized lane that cannot use it."
  },
  "core:embedding_profile_incompatible.incompatibility_reasons": {
    "description": "The non-empty closed set of embedding-profile dimensions that failed hard compatibility checks.",
    "type": "array",
    "minItems": 1,
    "items": {
      "type": "string",
      "enum": [
        "language",
        "content_class",
        "query_class",
        "dimensions",
        "encoding",
        "distance_metric",
        "generator_lock",
        "materialization"
      ]
    }
  },
  "core:embedding_profile_incompatible.workspace_snapshot_binding_ids": {
    "description": "Required affected bindings.",
    "type": "array",
    "minItems": 1,
    "items": {
      "type": "string"
    }
  },
  "core:semantic_index_unavailable.semantic_lane_id": {
    "description": "Required failed lane."
  },
  "core:semantic_index_unavailable.embedding_profile_id": {
    "description": "Required selected profile."
  },
  "core:semantic_index_unavailable.workspace_snapshot_binding_ids": {
    "description": "Required bindings with no usable semantic retrieval."
  },
  "core:semantic_index_unavailable.unavailability_reason": {
    "description": "The registered reason the semantic index cannot serve the requested query.",
    "type": "string",
    "enum": [
      "materialization_missing",
      "materialization_unavailable",
      "query_generator_unavailable",
      "vector_set_unreadable"
    ]
  },
  "core:semantic_index_unavailable.last_materialization_id": {
    "description": "Optional latest known materialization when one exists."
  },
  "core:semantic_coverage_incomplete.semantic_lane_ids": {
    "description": "Required lanes that remained incomplete.",
    "type": "array",
    "minItems": 1,
    "items": {
      "type": "string"
    }
  },
  "core:semantic_coverage_incomplete.workspace_snapshot_binding_ids": {
    "description": "Required affected bindings.",
    "type": "array",
    "minItems": 1,
    "items": {
      "type": "string"
    }
  },
  "core:semantic_coverage_incomplete.materialization_ids": {
    "description": "Required known materializations; empty only when none exists."
  },
  "core:semantic_coverage_incomplete.pending_artifact_count": {
    "description": "Required exact pending total at failure time.",
    "type": "integer",
    "minimum": 0
  },
  "core:semantic_coverage_incomplete.unsupported_artifact_count": {
    "description": "Required exact unsupported total at failure time.",
    "type": "integer",
    "minimum": 0
  },
  "core:semantic_coverage_incomplete.failed_artifact_count": {
    "description": "Required exact failed total at failure time.",
    "type": "integer",
    "minimum": 0
  },
  "core:semantic_coverage_incomplete.waited_milliseconds": {
    "description": "Required elapsed wait governed by the request limit.",
    "type": "integer",
    "minimum": 0
  },
  "core:semantic_coverage_incomplete.retry_after_milliseconds": {
    "description": "The positive delay in milliseconds after which the caller may retry semantic coverage acquisition.",
    "type": "integer",
    "minimum": 1
  },
  "core:index_contract_unsupported.contract_kind": {
    "description": "The closed index contract family that the active implementation does not support.",
    "type": "string",
    "enum": [
      "canonical_encoding",
      "hash_algorithm",
      "schema",
      "digest_domain",
      "canonical_comparator",
      "digest_recipe",
      "digest_reference",
      "external_verifier"
    ]
  },
  "core:index_contract_unsupported.registry_snapshot_ids": {
    "description": "Required exact retained registries whose reachable state needs the contract.",
    "type": "array",
    "minItems": 1,
    "items": {
      "type": "string"
    }
  },
  "core:index_contract_unsupported.uce_error_code": {
    "description": "Required underlying stable UCE error code."
  },
  "core:index_contract_unsupported.canonical_encoding_version": {
    "description": "The positive canonical-encoding contract version required by the index.",
    "type": "integer",
    "minimum": 1
  },
  "core:index_contract_unsupported.hash_algorithm": {
    "description": "Required exactly for `hash_algorithm`."
  },
  "core:index_contract_unsupported.schema_id": {
    "description": "Required exactly for `schema`."
  },
  "core:index_contract_unsupported.schema_version": {
    "description": "Required with `schema_id`.",
    "type": "integer",
    "minimum": 1
  },
  "core:index_contract_unsupported.digest_domain": {
    "description": "Required exactly for `digest_domain`."
  },
  "core:index_contract_unsupported.comparator_id": {
    "description": "Required exactly for `canonical_comparator`."
  },
  "core:index_contract_unsupported.comparator_version": {
    "description": "Required with `comparator_id`.",
    "type": "integer",
    "minimum": 1
  },
  "core:index_contract_unsupported.digest_recipe_id": {
    "description": "Required exactly for `digest_recipe`."
  },
  "core:index_contract_unsupported.digest_recipe_version": {
    "description": "Required with `digest_recipe_id`.",
    "type": "integer",
    "minimum": 1
  },
  "core:index_contract_unsupported.digest_reference_id": {
    "description": "Required exactly for `digest_reference`."
  },
  "core:index_contract_unsupported.external_verification_contract_id": {
    "description": "Required exactly for `external_verifier`."
  },
  "core:index_contract_unsupported.external_verification_contract_version": {
    "description": "Required with `external_verification_contract_id`.",
    "type": "integer",
    "minimum": 1
  },
  "core:index_integrity_failed.snapshot_ids": {
    "description": "Required exact snapshots whose mandatory state is affected.",
    "type": "array",
    "minItems": 1,
    "items": {
      "type": "string"
    }
  },
  "core:index_integrity_failed.component_kind": {
    "description": "The closed component family whose integrity check failed.",
    "type": "string",
    "enum": [
      "manifest",
      "canonical_record",
      "source_blob",
      "registry",
      "projection",
      "query_manifest",
      "storage_index"
    ]
  },
  "core:index_integrity_failed.component_ids": {
    "description": "Required bounded exact affected identifiers; empty only when corruption prevents safe enumeration."
  },
  "core:index_integrity_failed.integrity_failure_kind": {
    "description": "The closed integrity failure category observed while validating the index component.",
    "type": "string",
    "enum": [
      "digest_mismatch",
      "missing_required_component",
      "schema_invalid",
      "reference_invalid",
      "atomicity_violation"
    ]
  },
  "core:index_integrity_failed.uce_error_code": {
    "description": "Optional underlying stable UCE cause; required for a UCE decoding, schema, recipe, or digest failure."
  },
  "core:index_integrity_failed.expected_digest": {
    "description": "The canonical digest value carried by core:index_integrity_failed.",
    "type": "string",
    "pattern": "^(?:sha256):[0-9a-f]{64}$"
  },
  "core:index_integrity_failed.actual_digest": {
    "description": "The canonical digest value carried by core:index_integrity_failed.",
    "type": "string",
    "pattern": "^(?:sha256):[0-9a-f]{64}$"
  },
  "core:index_integrity_failed.affected_capability": {
    "description": "Optional capability when an otherwise optional projection is the only affected component."
  },
  "core:syntax_structure.syntax": {
    "description": "The `syntax` is the closed detail value for `core:syntax_structure`; normative emission trigger: syntactic (source: taxonomy/core-taxonomy.md)."
  },
  "core:symbol_declarations.syntax": {
    "description": "The `syntax` is the closed detail value for `core:symbol_declarations`; normative emission trigger: syntactic, resolved (source: taxonomy/core-taxonomy.md)."
  },
  "core:symbol_declarations.symbol_resolution": {
    "description": "The `symbol_resolution` is the closed detail value for `core:symbol_declarations`; normative emission trigger: syntactic, resolved (source: taxonomy/core-taxonomy.md)."
  },
  "core:symbol_resolution.symbol_resolution": {
    "description": "The `symbol_resolution` is the closed detail value for `core:symbol_resolution`; normative emission trigger: resolved, typed, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:symbol_resolution.type_analysis": {
    "description": "The `type_analysis` is the closed detail value for `core:symbol_resolution`; normative emission trigger: resolved, typed, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:symbol_resolution.framework_model": {
    "description": "The `framework_model` is the closed detail value for `core:symbol_resolution`; normative emission trigger: resolved, typed, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:symbol_resolution.heuristic": {
    "description": "The `heuristic` is the closed detail value for `core:symbol_resolution`; normative emission trigger: resolved, typed, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:type_information.type_analysis": {
    "description": "The `type_analysis` is the closed detail value for `core:type_information`; normative emission trigger: typed, flow_sensitive, modeled (source: taxonomy/core-taxonomy.md)."
  },
  "core:type_information.control_flow": {
    "description": "The `control_flow` is the closed detail value for `core:type_information`; normative emission trigger: typed, flow_sensitive, modeled (source: taxonomy/core-taxonomy.md)."
  },
  "core:type_information.data_flow": {
    "description": "The `data_flow` is the closed detail value for `core:type_information`; normative emission trigger: typed, flow_sensitive, modeled (source: taxonomy/core-taxonomy.md)."
  },
  "core:type_information.framework_model": {
    "description": "The `framework_model` is the closed detail value for `core:type_information`; normative emission trigger: typed, flow_sensitive, modeled (source: taxonomy/core-taxonomy.md)."
  },
  "core:module_dependencies.syntax": {
    "description": "The `syntax` is the closed detail value for `core:module_dependencies`; normative emission trigger: syntactic, resolved, modeled (source: taxonomy/core-taxonomy.md)."
  },
  "core:module_dependencies.symbol_resolution": {
    "description": "The `symbol_resolution` is the closed detail value for `core:module_dependencies`; normative emission trigger: syntactic, resolved, modeled (source: taxonomy/core-taxonomy.md)."
  },
  "core:module_dependencies.configuration": {
    "description": "The `configuration` is the closed detail value for `core:module_dependencies`; normative emission trigger: syntactic, resolved, modeled (source: taxonomy/core-taxonomy.md)."
  },
  "core:module_dependencies.framework_model": {
    "description": "The `framework_model` is the closed detail value for `core:module_dependencies`; normative emission trigger: syntactic, resolved, modeled (source: taxonomy/core-taxonomy.md)."
  },
  "core:call_relationships.symbol_resolution": {
    "description": "The `symbol_resolution` is the closed detail value for `core:call_relationships`; normative emission trigger: resolved, typed, flow_sensitive, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:call_relationships.type_analysis": {
    "description": "The `type_analysis` is the closed detail value for `core:call_relationships`; normative emission trigger: resolved, typed, flow_sensitive, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:call_relationships.control_flow": {
    "description": "The `control_flow` is the closed detail value for `core:call_relationships`; normative emission trigger: resolved, typed, flow_sensitive, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:call_relationships.framework_model": {
    "description": "The `framework_model` is the closed detail value for `core:call_relationships`; normative emission trigger: resolved, typed, flow_sensitive, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:call_relationships.heuristic": {
    "description": "The `heuristic` is the closed detail value for `core:call_relationships`; normative emission trigger: resolved, typed, flow_sensitive, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:inheritance_and_implementation.symbol_resolution": {
    "description": "The `symbol_resolution` is the closed detail value for `core:inheritance_and_implementation`; normative emission trigger: resolved, typed, modeled (source: taxonomy/core-taxonomy.md)."
  },
  "core:inheritance_and_implementation.type_analysis": {
    "description": "The `type_analysis` is the closed detail value for `core:inheritance_and_implementation`; normative emission trigger: resolved, typed, modeled (source: taxonomy/core-taxonomy.md)."
  },
  "core:inheritance_and_implementation.framework_model": {
    "description": "The `framework_model` is the closed detail value for `core:inheritance_and_implementation`; normative emission trigger: resolved, typed, modeled (source: taxonomy/core-taxonomy.md)."
  },
  "core:control_flow.control_flow": {
    "description": "The `control_flow` is the closed detail value for `core:control_flow`; normative emission trigger: `predecessor E:operation 1`; `successor E:operation 1`; `condition E:value,operation,L 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:control_flow.framework_model": {
    "description": "The `framework_model` is the closed detail value for `core:control_flow`; normative emission trigger: `predecessor E:operation 1`; `successor E:operation 1`; `condition E:value,operation,L 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:control_flow.heuristic": {
    "description": "The `heuristic` is the closed detail value for `core:control_flow`; normative emission trigger: `predecessor E:operation 1`; `successor E:operation 1`; `condition E:value,operation,L 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:control_flow.direct": {
    "description": "The `direct` is the closed detail value for `core:control_flow`; normative emission trigger: `predecessor E:operation 1`; `successor E:operation 1`; `condition E:value,operation,L 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:control_flow.possible": {
    "description": "The `possible` is the closed detail value for `core:control_flow`; normative emission trigger: `predecessor E:operation 1`; `successor E:operation 1`; `condition E:value,operation,L 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:control_flow.transfer": {
    "description": "The `transfer` is the closed detail value for `core:control_flow`; normative emission trigger: `predecessor E:operation 1`; `successor E:operation 1`; `condition E:value,operation,L 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:control_flow.of": {
    "description": "The `of` is the closed detail value for `core:control_flow`; normative emission trigger: `predecessor E:operation 1`; `successor E:operation 1`; `condition E:value,operation,L 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:control_flow.control": {
    "description": "The `control` is the closed detail value for `core:control_flow`; normative emission trigger: `predecessor E:operation 1`; `successor E:operation 1`; `condition E:value,operation,L 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:control_flow.paths": {
    "description": "The `paths` is the closed detail value for `core:control_flow`; normative emission trigger: `predecessor E:operation 1`; `successor E:operation 1`; `condition E:value,operation,L 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:control_flow.are": {
    "description": "The `are` is the closed detail value for `core:control_flow`; normative emission trigger: `predecessor E:operation 1`; `successor E:operation 1`; `condition E:value,operation,L 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:control_flow.derived": {
    "description": "The `derived` is the closed detail value for `core:control_flow`; normative emission trigger: `predecessor E:operation 1`; `successor E:operation 1`; `condition E:value,operation,L 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:control_flow.traversals": {
    "description": "The `traversals` is the closed detail value for `core:control_flow`; normative emission trigger: `predecessor E:operation 1`; `successor E:operation 1`; `condition E:value,operation,L 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:data_flow.data_flow": {
    "description": "The `data_flow` is the closed detail value for `core:data_flow`; normative emission trigger: `source E,R,L 1..*`; `sink E,R 1..*`; `flow_step E:operation+flow_step 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:data_flow.control_flow": {
    "description": "The `control_flow` is the closed detail value for `core:data_flow`; normative emission trigger: `source E,R,L 1..*`; `sink E,R 1..*`; `flow_step E:operation+flow_step 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:data_flow.type_analysis": {
    "description": "The `type_analysis` is the closed detail value for `core:data_flow`; normative emission trigger: `source E,R,L 1..*`; `sink E,R 1..*`; `flow_step E:operation+flow_step 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:data_flow.framework_model": {
    "description": "The `framework_model` is the closed detail value for `core:data_flow`; normative emission trigger: `source E,R,L 1..*`; `sink E,R 1..*`; `flow_step E:operation+flow_step 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:data_flow.heuristic": {
    "description": "The `heuristic` is the closed detail value for `core:data_flow`; normative emission trigger: `source E,R,L 1..*`; `sink E,R 1..*`; `flow_step E:operation+flow_step 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:data_flow.direct": {
    "description": "The `direct` is the closed detail value for `core:data_flow`; normative emission trigger: `source E,R,L 1..*`; `sink E,R 1..*`; `flow_step E:operation+flow_step 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:data_flow.modeled": {
    "description": "The `modeled` is the closed detail value for `core:data_flow`; normative emission trigger: `source E,R,L 1..*`; `sink E,R 1..*`; `flow_step E:operation+flow_step 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:data_flow.propagation": {
    "description": "The `propagation` is the closed detail value for `core:data_flow`; normative emission trigger: `source E,R,L 1..*`; `sink E,R 1..*`; `flow_step E:operation+flow_step 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:data_flow.step": {
    "description": "The `step` is the closed detail value for `core:data_flow`; normative emission trigger: `source E,R,L 1..*`; `sink E,R 1..*`; `flow_step E:operation+flow_step 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:data_flow.from": {
    "description": "The `from` is the closed detail value for `core:data_flow`; normative emission trigger: `source E,R,L 1..*`; `sink E,R 1..*`; `flow_step E:operation+flow_step 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:data_flow.sources": {
    "description": "The `sources` is the closed detail value for `core:data_flow`; normative emission trigger: `source E,R,L 1..*`; `sink E,R 1..*`; `flow_step E:operation+flow_step 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:data_flow.to": {
    "description": "The `to` is the closed detail value for `core:data_flow`; normative emission trigger: `source E,R,L 1..*`; `sink E,R 1..*`; `flow_step E:operation+flow_step 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:data_flow.sinks": {
    "description": "The `sinks` is the closed detail value for `core:data_flow`; normative emission trigger: `source E,R,L 1..*`; `sink E,R 1..*`; `flow_step E:operation+flow_step 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:effects.type_analysis": {
    "description": "The `type_analysis` is the closed detail value for `core:effects`; normative emission trigger: typed, flow_sensitive, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:effects.control_flow": {
    "description": "The `control_flow` is the closed detail value for `core:effects`; normative emission trigger: typed, flow_sensitive, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:effects.data_flow": {
    "description": "The `data_flow` is the closed detail value for `core:effects`; normative emission trigger: typed, flow_sensitive, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:effects.framework_model": {
    "description": "The `framework_model` is the closed detail value for `core:effects`; normative emission trigger: typed, flow_sensitive, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:effects.heuristic": {
    "description": "The `heuristic` is the closed detail value for `core:effects`; normative emission trigger: typed, flow_sensitive, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:test_relationships.symbol_resolution": {
    "description": "The `symbol_resolution` is the closed detail value for `core:test_relationships`; normative emission trigger: resolved, typed, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:test_relationships.type_analysis": {
    "description": "The `type_analysis` is the closed detail value for `core:test_relationships`; normative emission trigger: resolved, typed, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:test_relationships.framework_model": {
    "description": "The `framework_model` is the closed detail value for `core:test_relationships`; normative emission trigger: resolved, typed, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:test_relationships.configuration": {
    "description": "The `configuration` is the closed detail value for `core:test_relationships`; normative emission trigger: resolved, typed, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:test_relationships.heuristic": {
    "description": "The `heuristic` is the closed detail value for `core:test_relationships`; normative emission trigger: resolved, typed, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:framework_semantics.syntax": {
    "description": "The `syntax` is the closed detail value for `core:framework_semantics`; normative emission trigger: resolved, typed, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:framework_semantics.symbol_resolution": {
    "description": "The `symbol_resolution` is the closed detail value for `core:framework_semantics`; normative emission trigger: resolved, typed, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:framework_semantics.type_analysis": {
    "description": "The `type_analysis` is the closed detail value for `core:framework_semantics`; normative emission trigger: resolved, typed, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:framework_semantics.framework_model": {
    "description": "The `framework_model` is the closed detail value for `core:framework_semantics`; normative emission trigger: resolved, typed, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:framework_semantics.configuration": {
    "description": "The `configuration` is the closed detail value for `core:framework_semantics`; normative emission trigger: resolved, typed, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:framework_semantics.heuristic": {
    "description": "The `heuristic` is the closed detail value for `core:framework_semantics`; normative emission trigger: resolved, typed, modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:semantic_preparation.syntax": {
    "description": "The `syntax` is the closed detail value for `core:semantic_preparation`; normative emission trigger: syntactic, resolved, typed, modeled (source: taxonomy/core-taxonomy.md)."
  },
  "core:semantic_preparation.symbol_resolution": {
    "description": "The `symbol_resolution` is the closed detail value for `core:semantic_preparation`; normative emission trigger: syntactic, resolved, typed, modeled (source: taxonomy/core-taxonomy.md)."
  },
  "core:semantic_preparation.type_analysis": {
    "description": "The `type_analysis` is the closed detail value for `core:semantic_preparation`; normative emission trigger: syntactic, resolved, typed, modeled (source: taxonomy/core-taxonomy.md)."
  },
  "core:semantic_preparation.framework_model": {
    "description": "The `framework_model` is the closed detail value for `core:semantic_preparation`; normative emission trigger: syntactic, resolved, typed, modeled (source: taxonomy/core-taxonomy.md)."
  },
  "core:semantic_preparation.configuration": {
    "description": "The `configuration` is the closed detail value for `core:semantic_preparation`; normative emission trigger: syntactic, resolved, typed, modeled (source: taxonomy/core-taxonomy.md)."
  },
  "core:semantic_retrieval.semantic_similarity": {
    "description": "The `semantic_similarity` is the closed detail value for `core:semantic_retrieval`; normative emission trigger: modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:semantic_retrieval.heuristic": {
    "description": "The `heuristic` is the closed detail value for `core:semantic_retrieval`; normative emission trigger: modeled, heuristic (source: taxonomy/core-taxonomy.md)."
  },
  "core:declaration.entity": {
    "description": "The `entity` is the closed detail value for `core:declaration`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:declaration.introduces": {
    "description": "The `introduces` is the closed detail value for `core:declaration`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:declaration.or": {
    "description": "The `or` is the closed detail value for `core:declaration`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:declaration.declares": {
    "description": "The `declares` is the closed detail value for `core:declaration`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:declaration.a": {
    "description": "The `a` is the closed detail value for `core:declaration`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:declaration.semantic": {
    "description": "The `semantic` is the closed detail value for `core:declaration`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:declaration.name": {
    "description": "The `name` is the closed detail value for `core:declaration`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:declaration.identity": {
    "description": "The `identity` is the closed detail value for `core:declaration`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:declaration.in": {
    "description": "The `in` is the closed detail value for `core:declaration`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:declaration.source": {
    "description": "The `source` is the closed detail value for `core:declaration`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:declaration.generated": {
    "description": "The `generated` is the closed detail value for `core:declaration`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:declaration.semantics": {
    "description": "The `semantics` is the closed detail value for `core:declaration`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:definition.entity": {
    "description": "The `entity` is the closed detail value for `core:definition`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:definition.supplies": {
    "description": "The `supplies` is the closed detail value for `core:definition`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:definition.implementation": {
    "description": "The `implementation` is the closed detail value for `core:definition`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:definition.storage": {
    "description": "The `storage` is the closed detail value for `core:definition`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:definition.members": {
    "description": "The `members` is the closed detail value for `core:definition`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:definition.or": {
    "description": "The `or` is the closed detail value for `core:definition`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:definition.material": {
    "description": "The `material` is the closed detail value for `core:definition`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:definition.semantics": {
    "description": "The `semantics` is the closed detail value for `core:definition`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:definition.rather": {
    "description": "The `rather` is the closed detail value for `core:definition`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:definition.than": {
    "description": "The `than` is the closed detail value for `core:definition`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:definition.only": {
    "description": "The `only` is the closed detail value for `core:definition`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:definition.declaring": {
    "description": "The `declaring` is the closed detail value for `core:definition`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:definition.them": {
    "description": "The `them` is the closed detail value for `core:definition`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:scope.entity": {
    "description": "The `entity` is the closed detail value for `core:scope`; normative emission trigger: container, type, callable, operation, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:scope.introduces": {
    "description": "The `introduces` is the closed detail value for `core:scope`; normative emission trigger: container, type, callable, operation, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:scope.a": {
    "description": "The `a` is the closed detail value for `core:scope`; normative emission trigger: container, type, callable, operation, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:scope.lookup": {
    "description": "The `lookup` is the closed detail value for `core:scope`; normative emission trigger: container, type, callable, operation, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:scope.binding": {
    "description": "The `binding` is the closed detail value for `core:scope`; normative emission trigger: container, type, callable, operation, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:scope.lexical": {
    "description": "The `lexical` is the closed detail value for `core:scope`; normative emission trigger: container, type, callable, operation, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:scope.or": {
    "description": "The `or` is the closed detail value for `core:scope`; normative emission trigger: container, type, callable, operation, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:scope.control": {
    "description": "The `control` is the closed detail value for `core:scope`; normative emission trigger: container, type, callable, operation, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:scope.scope": {
    "description": "The `scope` is the closed detail value for `core:scope`; normative emission trigger: container, type, callable, operation, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:scope.recognized": {
    "description": "The `recognized` is the closed detail value for `core:scope`; normative emission trigger: container, type, callable, operation, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:scope.by": {
    "description": "The `by` is the closed detail value for `core:scope`; normative emission trigger: container, type, callable, operation, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:scope.the": {
    "description": "The `the` is the closed detail value for `core:scope`; normative emission trigger: container, type, callable, operation, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:scope.producer": {
    "description": "The `producer` is the closed detail value for `core:scope`; normative emission trigger: container, type, callable, operation, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member.entity": {
    "description": "The `entity` is the closed detail value for `core:member`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member.participates": {
    "description": "The `participates` is the closed detail value for `core:member`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member.as": {
    "description": "The `as` is the closed detail value for `core:member`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member.a": {
    "description": "The `a` is the closed detail value for `core:member`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member.named": {
    "description": "The `named` is the closed detail value for `core:member`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member.or": {
    "description": "The `or` is the closed detail value for `core:member`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member.addressable": {
    "description": "The `addressable` is the closed detail value for `core:member`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member.member": {
    "description": "The `member` is the closed detail value for `core:member`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member.of": {
    "description": "The `of` is the closed detail value for `core:member`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member.another": {
    "description": "The `another` is the closed detail value for `core:member`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member.itself": {
    "description": "The `itself` is the closed detail value for `core:member`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member.is": {
    "description": "The `is` is the closed detail value for `core:member`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member.represented": {
    "description": "The `represented` is the closed detail value for `core:member`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member.by": {
    "description": "The `by` is the closed detail value for `core:member`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member.core": {
    "description": "The `core` is the closed detail value for `core:member`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member.contains": {
    "description": "The `contains` is the closed detail value for `core:member`; normative emission trigger: container, type, callable, value, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member_container.entity": {
    "description": "The `entity` is the closed detail value for `core:member_container`; normative emission trigger: container, type, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member_container.can": {
    "description": "The `can` is the closed detail value for `core:member_container`; normative emission trigger: container, type, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member_container.contain": {
    "description": "The `contain` is the closed detail value for `core:member_container`; normative emission trigger: container, type, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member_container.named": {
    "description": "The `named` is the closed detail value for `core:member_container`; normative emission trigger: container, type, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member_container.members": {
    "description": "The `members` is the closed detail value for `core:member_container`; normative emission trigger: container, type, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member_container.under": {
    "description": "The `under` is the closed detail value for `core:member_container`; normative emission trigger: container, type, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member_container.the": {
    "description": "The `the` is the closed detail value for `core:member_container`; normative emission trigger: container, type, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member_container.language": {
    "description": "The `language` is the closed detail value for `core:member_container`; normative emission trigger: container, type, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member_container.or": {
    "description": "The `or` is the closed detail value for `core:member_container`; normative emission trigger: container, type, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member_container.model": {
    "description": "The `model` is the closed detail value for `core:member_container`; normative emission trigger: container, type, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:member_container.semantics": {
    "description": "The `semantics` is the closed detail value for `core:member_container`; normative emission trigger: container, type, resource, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:parameter.value": {
    "description": "The `value` is the closed detail value for `core:parameter`; normative emission trigger: value (source: taxonomy/core-taxonomy.md)."
  },
  "core:parameter.is": {
    "description": "The `is` is the closed detail value for `core:parameter`; normative emission trigger: value (source: taxonomy/core-taxonomy.md)."
  },
  "core:parameter.an": {
    "description": "The `an` is the closed detail value for `core:parameter`; normative emission trigger: value (source: taxonomy/core-taxonomy.md)."
  },
  "core:parameter.input": {
    "description": "The `input` is the closed detail value for `core:parameter`; normative emission trigger: value (source: taxonomy/core-taxonomy.md)."
  },
  "core:parameter.binding": {
    "description": "The `binding` is the closed detail value for `core:parameter`; normative emission trigger: value (source: taxonomy/core-taxonomy.md)."
  },
  "core:parameter.of": {
    "description": "The `of` is the closed detail value for `core:parameter`; normative emission trigger: value (source: taxonomy/core-taxonomy.md)."
  },
  "core:parameter.a": {
    "description": "The `a` is the closed detail value for `core:parameter`; normative emission trigger: value (source: taxonomy/core-taxonomy.md)."
  },
  "core:parameter.callable": {
    "description": "The `callable` is the closed detail value for `core:parameter`; normative emission trigger: value (source: taxonomy/core-taxonomy.md)."
  },
  "core:parameter.or": {
    "description": "The `or` is the closed detail value for `core:parameter`; normative emission trigger: value (source: taxonomy/core-taxonomy.md)."
  },
  "core:parameter.equivalent": {
    "description": "The `equivalent` is the closed detail value for `core:parameter`; normative emission trigger: value (source: taxonomy/core-taxonomy.md)."
  },
  "core:parameter.operation": {
    "description": "The `operation` is the closed detail value for `core:parameter`; normative emission trigger: value (source: taxonomy/core-taxonomy.md)."
  },
  "core:type_parameter.type": {
    "description": "The `type` is the closed detail value for `core:type_parameter`; normative emission trigger: type (source: taxonomy/core-taxonomy.md)."
  },
  "core:type_parameter.entity": {
    "description": "The `entity` is the closed detail value for `core:type_parameter`; normative emission trigger: type (source: taxonomy/core-taxonomy.md)."
  },
  "core:type_parameter.is": {
    "description": "The `is` is the closed detail value for `core:type_parameter`; normative emission trigger: type (source: taxonomy/core-taxonomy.md)."
  },
  "core:type_parameter.a": {
    "description": "The `a` is the closed detail value for `core:type_parameter`; normative emission trigger: type (source: taxonomy/core-taxonomy.md)."
  },
  "core:type_parameter.generic": {
    "description": "The `generic` is the closed detail value for `core:type_parameter`; normative emission trigger: type (source: taxonomy/core-taxonomy.md)."
  },
  "core:type_parameter.or": {
    "description": "The `or` is the closed detail value for `core:type_parameter`; normative emission trigger: type (source: taxonomy/core-taxonomy.md)."
  },
  "core:type_parameter.polymorphic": {
    "description": "The `polymorphic` is the closed detail value for `core:type_parameter`; normative emission trigger: type (source: taxonomy/core-taxonomy.md)."
  },
  "core:type_parameter.parameter": {
    "description": "The `parameter` is the closed detail value for `core:type_parameter`; normative emission trigger: type (source: taxonomy/core-taxonomy.md)."
  },
  "core:literal.entity": {
    "description": "The `entity` is the closed detail value for `core:literal`; normative emission trigger: value, operation, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:literal.directly": {
    "description": "The `directly` is the closed detail value for `core:literal`; normative emission trigger: value, operation, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:literal.represents": {
    "description": "The `represents` is the closed detail value for `core:literal`; normative emission trigger: value, operation, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:literal.a": {
    "description": "The `a` is the closed detail value for `core:literal`; normative emission trigger: value, operation, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:literal.literal": {
    "description": "The `literal` is the closed detail value for `core:literal`; normative emission trigger: value, operation, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:literal.source": {
    "description": "The `source` is the closed detail value for `core:literal`; normative emission trigger: value, operation, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:literal.or": {
    "description": "The `or` is the closed detail value for `core:literal`; normative emission trigger: value, operation, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:literal.generated": {
    "description": "The `generated` is the closed detail value for `core:literal`; normative emission trigger: value, operation, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:literal.value": {
    "description": "The `value` is the closed detail value for `core:literal`; normative emission trigger: value, operation, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:literal.rather": {
    "description": "The `rather` is the closed detail value for `core:literal`; normative emission trigger: value, operation, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:literal.than": {
    "description": "The `than` is the closed detail value for `core:literal`; normative emission trigger: value, operation, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:literal.named": {
    "description": "The `named` is the closed detail value for `core:literal`; normative emission trigger: value, operation, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:literal.binding": {
    "description": "The `binding` is the closed detail value for `core:literal`; normative emission trigger: value, operation, construct (source: taxonomy/core-taxonomy.md)."
  },
  "core:constructible.type": {
    "description": "The `type` is the closed detail value for `core:constructible`; normative emission trigger: type (source: taxonomy/core-taxonomy.md)."
  },
  "core:constructible.may": {
    "description": "The `may` is the closed detail value for `core:constructible`; normative emission trigger: type (source: taxonomy/core-taxonomy.md)."
  },
  "core:constructible.be": {
    "description": "The `be` is the closed detail value for `core:constructible`; normative emission trigger: type (source: taxonomy/core-taxonomy.md)."
  },
  "core:constructible.instantiated": {
    "description": "The `instantiated` is the closed detail value for `core:constructible`; normative emission trigger: type (source: taxonomy/core-taxonomy.md)."
  },
  "core:constructible.directly": {
    "description": "The `directly` is the closed detail value for `core:constructible`; normative emission trigger: type (source: taxonomy/core-taxonomy.md)."
  },
  "core:constructible.under": {
    "description": "The `under` is the closed detail value for `core:constructible`; normative emission trigger: type (source: taxonomy/core-taxonomy.md)."
  },
  "core:constructible.the": {
    "description": "The `the` is the closed detail value for `core:constructible`; normative emission trigger: type (source: taxonomy/core-taxonomy.md)."
  },
  "core:constructible.declared": {
    "description": "The `declared` is the closed detail value for `core:constructible`; normative emission trigger: type (source: taxonomy/core-taxonomy.md)."
  },
  "core:constructible.language": {
    "description": "The `language` is the closed detail value for `core:constructible`; normative emission trigger: type (source: taxonomy/core-taxonomy.md)."
  },
  "core:constructible.and": {
    "description": "The `and` is the closed detail value for `core:constructible`; normative emission trigger: type (source: taxonomy/core-taxonomy.md)."
  },
  "core:constructible.analysis": {
    "description": "The `analysis` is the closed detail value for `core:constructible`; normative emission trigger: type (source: taxonomy/core-taxonomy.md)."
  },
  "core:constructible.configuration": {
    "description": "The `configuration` is the closed detail value for `core:constructible`; normative emission trigger: type (source: taxonomy/core-taxonomy.md)."
  },
  "core:abstract.entity": {
    "description": "The `entity` is the closed detail value for `core:abstract`; normative emission trigger: type, callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:abstract.declares": {
    "description": "The `declares` is the closed detail value for `core:abstract`; normative emission trigger: type, callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:abstract.incomplete": {
    "description": "The `incomplete` is the closed detail value for `core:abstract`; normative emission trigger: type, callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:abstract.behavior": {
    "description": "The `behavior` is the closed detail value for `core:abstract`; normative emission trigger: type, callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:abstract.or": {
    "description": "The `or` is the closed detail value for `core:abstract`; normative emission trigger: type, callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:abstract.contract": {
    "description": "The `contract` is the closed detail value for `core:abstract`; normative emission trigger: type, callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:abstract.semantics": {
    "description": "The `semantics` is the closed detail value for `core:abstract`; normative emission trigger: type, callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:abstract.and": {
    "description": "The `and` is the closed detail value for `core:abstract`; normative emission trigger: type, callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:abstract.cannot": {
    "description": "The `cannot` is the closed detail value for `core:abstract`; normative emission trigger: type, callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:abstract.be": {
    "description": "The `be` is the closed detail value for `core:abstract`; normative emission trigger: type, callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:abstract.directly": {
    "description": "The `directly` is the closed detail value for `core:abstract`; normative emission trigger: type, callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:abstract.materialized": {
    "description": "The `materialized` is the closed detail value for `core:abstract`; normative emission trigger: type, callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:abstract.in": {
    "description": "The `in` is the closed detail value for `core:abstract`; normative emission trigger: type, callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:abstract.its": {
    "description": "The `its` is the closed detail value for `core:abstract`; normative emission trigger: type, callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:abstract.own": {
    "description": "The `own` is the closed detail value for `core:abstract`; normative emission trigger: type, callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:abstract.right": {
    "description": "The `right` is the closed detail value for `core:abstract`; normative emission trigger: type, callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:async.or": {
    "description": "The `or` is the closed detail value for `core:async`; normative emission trigger: callable, operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:async.evaluation": {
    "description": "The `evaluation` is the closed detail value for `core:async`; normative emission trigger: callable, operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:async.has": {
    "description": "The `has` is the closed detail value for `core:async`; normative emission trigger: callable, operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:async.intrinsic": {
    "description": "The `intrinsic` is the closed detail value for `core:async`; normative emission trigger: callable, operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:async.asynchronous": {
    "description": "The `asynchronous` is the closed detail value for `core:async`; normative emission trigger: callable, operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:async.semantics": {
    "description": "The `semantics` is the closed detail value for `core:async`; normative emission trigger: callable, operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:async.in": {
    "description": "The `in` is the closed detail value for `core:async`; normative emission trigger: callable, operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:async.the": {
    "description": "The `the` is the closed detail value for `core:async`; normative emission trigger: callable, operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:async.source": {
    "description": "The `source` is the closed detail value for `core:async`; normative emission trigger: callable, operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:async.language": {
    "description": "The `language` is the closed detail value for `core:async`; normative emission trigger: callable, operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:async.model": {
    "description": "The `model` is the closed detail value for `core:async`; normative emission trigger: callable, operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:generator.intrinsically": {
    "description": "The `intrinsically` is the closed detail value for `core:generator`; normative emission trigger: callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:generator.produces": {
    "description": "The `produces` is the closed detail value for `core:generator`; normative emission trigger: callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:generator.an": {
    "description": "The `an` is the closed detail value for `core:generator`; normative emission trigger: callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:generator.iterator": {
    "description": "The `iterator` is the closed detail value for `core:generator`; normative emission trigger: callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:generator.generator": {
    "description": "The `generator` is the closed detail value for `core:generator`; normative emission trigger: callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:generator.or": {
    "description": "The `or` is the closed detail value for `core:generator`; normative emission trigger: callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:generator.resumable": {
    "description": "The `resumable` is the closed detail value for `core:generator`; normative emission trigger: callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:generator.sequence": {
    "description": "The `sequence` is the closed detail value for `core:generator`; normative emission trigger: callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:generator.under": {
    "description": "The `under` is the closed detail value for `core:generator`; normative emission trigger: callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:generator.the": {
    "description": "The `the` is the closed detail value for `core:generator`; normative emission trigger: callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:generator.source": {
    "description": "The `source` is the closed detail value for `core:generator`; normative emission trigger: callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:generator.semantics": {
    "description": "The `semantics` is the closed detail value for `core:generator`; normative emission trigger: callable (source: taxonomy/core-taxonomy.md)."
  },
  "core:call_site.operation": {
    "description": "The `operation` is the closed detail value for `core:call_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:call_site.is": {
    "description": "The `is` is the closed detail value for `core:call_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:call_site.the": {
    "description": "The `the` is the closed detail value for `core:call_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:call_site.source": {
    "description": "The `source` is the closed detail value for `core:call_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:call_site.anchor": {
    "description": "The `anchor` is the closed detail value for `core:call_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:call_site.of": {
    "description": "The `of` is the closed detail value for `core:call_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:call_site.an": {
    "description": "The `an` is the closed detail value for `core:call_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:call_site.invocation": {
    "description": "The `invocation` is the closed detail value for `core:call_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:call_site.relation": {
    "description": "The `relation` is the closed detail value for `core:call_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:read_site.operation": {
    "description": "The `operation` is the closed detail value for `core:read_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:read_site.reads": {
    "description": "The `reads` is the closed detail value for `core:read_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:read_site.a": {
    "description": "The `a` is the closed detail value for `core:read_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:read_site.value": {
    "description": "The `value` is the closed detail value for `core:read_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:read_site.or": {
    "description": "The `or` is the closed detail value for `core:read_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:read_site.storage": {
    "description": "The `storage` is the closed detail value for `core:read_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:read_site.location": {
    "description": "The `location` is the closed detail value for `core:read_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:read_site.may": {
    "description": "The `may` is the closed detail value for `core:read_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:read_site.also": {
    "description": "The `also` is the closed detail value for `core:read_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:read_site.be": {
    "description": "The `be` is the closed detail value for `core:read_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:read_site.write": {
    "description": "The `write` is the closed detail value for `core:read_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:read_site.site": {
    "description": "The `site` is the closed detail value for `core:read_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:read_site.for": {
    "description": "The `for` is the closed detail value for `core:read_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:read_site.read": {
    "description": "The `read` is the closed detail value for `core:read_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:read_site.modify": {
    "description": "The `modify` is the closed detail value for `core:read_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:read_site.constructs": {
    "description": "The `constructs` is the closed detail value for `core:read_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:write_site.operation": {
    "description": "The `operation` is the closed detail value for `core:write_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:write_site.writes": {
    "description": "The `writes` is the closed detail value for `core:write_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:write_site.a": {
    "description": "The `a` is the closed detail value for `core:write_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:write_site.value": {
    "description": "The `value` is the closed detail value for `core:write_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:write_site.or": {
    "description": "The `or` is the closed detail value for `core:write_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:write_site.storage": {
    "description": "The `storage` is the closed detail value for `core:write_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:write_site.location": {
    "description": "The `location` is the closed detail value for `core:write_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:write_site.may": {
    "description": "The `may` is the closed detail value for `core:write_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:write_site.also": {
    "description": "The `also` is the closed detail value for `core:write_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:write_site.be": {
    "description": "The `be` is the closed detail value for `core:write_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:write_site.read": {
    "description": "The `read` is the closed detail value for `core:write_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:write_site.site": {
    "description": "The `site` is the closed detail value for `core:write_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:return_site.operation": {
    "description": "The `operation` is the closed detail value for `core:return_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:return_site.explicitly": {
    "description": "The `explicitly` is the closed detail value for `core:return_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:return_site.or": {
    "description": "The `or` is the closed detail value for `core:return_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:return_site.implicitly": {
    "description": "The `implicitly` is the closed detail value for `core:return_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:return_site.returns": {
    "description": "The `returns` is the closed detail value for `core:return_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:return_site.control": {
    "description": "The `control` is the closed detail value for `core:return_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:return_site.a": {
    "description": "The `a` is the closed detail value for `core:return_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:return_site.value": {
    "description": "The `value` is the closed detail value for `core:return_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:return_site.from": {
    "description": "The `from` is the closed detail value for `core:return_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:return_site.callable": {
    "description": "The `callable` is the closed detail value for `core:return_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:import_site.operation": {
    "description": "The `operation` is the closed detail value for `core:import_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:import_site.is": {
    "description": "The `is` is the closed detail value for `core:import_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:import_site.the": {
    "description": "The `the` is the closed detail value for `core:import_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:import_site.source": {
    "description": "The `source` is the closed detail value for `core:import_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:import_site.anchor": {
    "description": "The `anchor` is the closed detail value for `core:import_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:import_site.of": {
    "description": "The `of` is the closed detail value for `core:import_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:import_site.an": {
    "description": "The `an` is the closed detail value for `core:import_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:import_site.import": {
    "description": "The `import` is the closed detail value for `core:import_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:import_site.relation": {
    "description": "The `relation` is the closed detail value for `core:import_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:export_site.operation": {
    "description": "The `operation` is the closed detail value for `core:export_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:export_site.is": {
    "description": "The `is` is the closed detail value for `core:export_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:export_site.the": {
    "description": "The `the` is the closed detail value for `core:export_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:export_site.source": {
    "description": "The `source` is the closed detail value for `core:export_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:export_site.anchor": {
    "description": "The `anchor` is the closed detail value for `core:export_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:export_site.of": {
    "description": "The `of` is the closed detail value for `core:export_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:export_site.an": {
    "description": "The `an` is the closed detail value for `core:export_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:export_site.export": {
    "description": "The `export` is the closed detail value for `core:export_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:export_site.relation": {
    "description": "The `relation` is the closed detail value for `core:export_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:branch_site.operation": {
    "description": "The `operation` is the closed detail value for `core:branch_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:branch_site.selects": {
    "description": "The `selects` is the closed detail value for `core:branch_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:branch_site.among": {
    "description": "The `among` is the closed detail value for `core:branch_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:branch_site.two": {
    "description": "The `two` is the closed detail value for `core:branch_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:branch_site.or": {
    "description": "The `or` is the closed detail value for `core:branch_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:branch_site.more": {
    "description": "The `more` is the closed detail value for `core:branch_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:branch_site.possible": {
    "description": "The `possible` is the closed detail value for `core:branch_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:branch_site.control": {
    "description": "The `control` is the closed detail value for `core:branch_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:branch_site.flow": {
    "description": "The `flow` is the closed detail value for `core:branch_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:branch_site.successors": {
    "description": "The `successors` is the closed detail value for `core:branch_site`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:flow_step.operation": {
    "description": "The `operation` is the closed detail value for `core:flow_step`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:flow_step.is": {
    "description": "The `is` is the closed detail value for `core:flow_step`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:flow_step.addressable": {
    "description": "The `addressable` is the closed detail value for `core:flow_step`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:flow_step.as": {
    "description": "The `as` is the closed detail value for `core:flow_step`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:flow_step.one": {
    "description": "The `one` is the closed detail value for `core:flow_step`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:flow_step.direct": {
    "description": "The `direct` is the closed detail value for `core:flow_step`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:flow_step.control": {
    "description": "The `control` is the closed detail value for `core:flow_step`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:flow_step.or": {
    "description": "The `or` is the closed detail value for `core:flow_step`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:flow_step.data": {
    "description": "The `data` is the closed detail value for `core:flow_step`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:flow_step.flow": {
    "description": "The `flow` is the closed detail value for `core:flow_step`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:flow_step.step": {
    "description": "The `step` is the closed detail value for `core:flow_step`; normative emission trigger: operation (source: taxonomy/core-taxonomy.md)."
  },
  "core:synthetic.analyzer": {
    "description": "The `analyzer` is the closed detail value for `core:synthetic`; normative emission trigger: any entity base (source: taxonomy/core-taxonomy.md)."
  },
  "core:synthetic.created": {
    "description": "The `created` is the closed detail value for `core:synthetic`; normative emission trigger: any entity base (source: taxonomy/core-taxonomy.md)."
  },
  "core:synthetic.the": {
    "description": "The `the` is the closed detail value for `core:synthetic`; normative emission trigger: any entity base (source: taxonomy/core-taxonomy.md)."
  },
  "core:synthetic.entity": {
    "description": "The `entity` is the closed detail value for `core:synthetic`; normative emission trigger: any entity base (source: taxonomy/core-taxonomy.md)."
  },
  "core:synthetic.to": {
    "description": "The `to` is the closed detail value for `core:synthetic`; normative emission trigger: any entity base (source: taxonomy/core-taxonomy.md)."
  },
  "core:synthetic.model": {
    "description": "The `model` is the closed detail value for `core:synthetic`; normative emission trigger: any entity base (source: taxonomy/core-taxonomy.md)."
  },
  "core:synthetic.semantics": {
    "description": "The `semantics` is the closed detail value for `core:synthetic`; normative emission trigger: any entity base (source: taxonomy/core-taxonomy.md)."
  },
  "core:synthetic.and": {
    "description": "The `and` is the closed detail value for `core:synthetic`; normative emission trigger: any entity base (source: taxonomy/core-taxonomy.md)."
  },
  "core:synthetic.no": {
    "description": "The `no` is the closed detail value for `core:synthetic`; normative emission trigger: any entity base (source: taxonomy/core-taxonomy.md)."
  },
  "core:synthetic.one": {
    "description": "The `one` is the closed detail value for `core:synthetic`; normative emission trigger: any entity base (source: taxonomy/core-taxonomy.md)."
  },
  "core:synthetic.source": {
    "description": "The `source` is the closed detail value for `core:synthetic`; normative emission trigger: any entity base (source: taxonomy/core-taxonomy.md)."
  },
  "core:synthetic.construct": {
    "description": "The `construct` is the closed detail value for `core:synthetic`; normative emission trigger: any entity base (source: taxonomy/core-taxonomy.md)."
  },
  "core:synthetic.exists": {
    "description": "The `exists` is the closed detail value for `core:synthetic`; normative emission trigger: any entity base (source: taxonomy/core-taxonomy.md)."
  },
  "core:synthetic.owner": {
    "description": "The `owner` is the closed detail value for `core:synthetic`; normative emission trigger: any entity base (source: taxonomy/core-taxonomy.md)."
  },
  "core:synthetic.artifact": {
    "description": "The `artifact` is the closed detail value for `core:synthetic`; normative emission trigger: any entity base (source: taxonomy/core-taxonomy.md)."
  },
  "core:synthetic.remains": {
    "description": "The `remains` is the closed detail value for `core:synthetic`; normative emission trigger: any entity base (source: taxonomy/core-taxonomy.md)."
  },
  "core:synthetic.mandatory": {
    "description": "The `mandatory` is the closed detail value for `core:synthetic`; normative emission trigger: any entity base (source: taxonomy/core-taxonomy.md)."
  },
  "core:implicit.language": {
    "description": "The `language` is the closed detail value for `core:implicit`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:implicit.or": {
    "description": "The `or` is the closed detail value for `core:implicit`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:implicit.framework": {
    "description": "The `framework` is the closed detail value for `core:implicit`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:implicit.semantics": {
    "description": "The `semantics` is the closed detail value for `core:implicit`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:implicit.create": {
    "description": "The `create` is the closed detail value for `core:implicit`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:implicit.the": {
    "description": "The `the` is the closed detail value for `core:implicit`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:implicit.entity": {
    "description": "The `entity` is the closed detail value for `core:implicit`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:implicit.relation": {
    "description": "The `relation` is the closed detail value for `core:implicit`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:implicit.although": {
    "description": "The `although` is the closed detail value for `core:implicit`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:implicit.it": {
    "description": "The `it` is the closed detail value for `core:implicit`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:implicit.is": {
    "description": "The `is` is the closed detail value for `core:implicit`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:implicit.not": {
    "description": "The `not` is the closed detail value for `core:implicit`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:implicit.explicitly": {
    "description": "The `explicitly` is the closed detail value for `core:implicit`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:implicit.written": {
    "description": "The `written` is the closed detail value for `core:implicit`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:implicit.at": {
    "description": "The `at` is the closed detail value for `core:implicit`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:implicit.primary": {
    "description": "The `primary` is the closed detail value for `core:implicit`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:implicit.span": {
    "description": "The `span` is the closed detail value for `core:implicit`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:generated.entity": {
    "description": "The `entity` is the closed detail value for `core:generated`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:generated.or": {
    "description": "The `or` is the closed detail value for `core:generated`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:generated.relation": {
    "description": "The `relation` is the closed detail value for `core:generated`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:generated.originates": {
    "description": "The `originates` is the closed detail value for `core:generated`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:generated.from": {
    "description": "The `from` is the closed detail value for `core:generated`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:generated.generated": {
    "description": "The `generated` is the closed detail value for `core:generated`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:generated.source": {
    "description": "The `source` is the closed detail value for `core:generated`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:generated.a": {
    "description": "The `a` is the closed detail value for `core:generated`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:generated.deterministic": {
    "description": "The `deterministic` is the closed detail value for `core:generated`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:generated.generation": {
    "description": "The `generation` is the closed detail value for `core:generated`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:generated.model": {
    "description": "The `model` is the closed detail value for `core:generated`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:external.entity": {
    "description": "The `entity` is the closed detail value for `core:external`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:external.or": {
    "description": "The `or` is the closed detail value for `core:external`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:external.relation": {
    "description": "The `relation` is the closed detail value for `core:external`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:external.is": {
    "description": "The `is` is the closed detail value for `core:external`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:external.defined": {
    "description": "The `defined` is the closed detail value for `core:external`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:external.outside": {
    "description": "The `outside` is the closed detail value for `core:external`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:external.the": {
    "description": "The `the` is the closed detail value for `core:external`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:external.physical": {
    "description": "The `physical` is the closed detail value for `core:external`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:external.workspace": {
    "description": "The `workspace` is the closed detail value for `core:external`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:external.and": {
    "description": "The `and` is the closed detail value for `core:external`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:external.represented": {
    "description": "The `represented` is the closed detail value for `core:external`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:external.through": {
    "description": "The `through` is the closed detail value for `core:external`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:external.a": {
    "description": "The `a` is the closed detail value for `core:external`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:external.virtual": {
    "description": "The `virtual` is the closed detail value for `core:external`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:external.external": {
    "description": "The `external` is the closed detail value for `core:external`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:external.source": {
    "description": "The `source` is the closed detail value for `core:external`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:external.artifact": {
    "description": "The `artifact` is the closed detail value for `core:external`; normative emission trigger: any entity base; any relation base (source: taxonomy/core-taxonomy.md)."
  },
  "core:contains.semantic": {
    "description": "The `semantic` is the closed detail value for `core:contains`; normative emission trigger: `container E:container,type,callable,resource,construct 1`; `contained E 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:contains.or": {
    "description": "The `or` is the closed detail value for `core:contains`; normative emission trigger: `container E:container,type,callable,resource,construct 1`; `contained E 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:contains.lexical": {
    "description": "The `lexical` is the closed detail value for `core:contains`; normative emission trigger: `container E:container,type,callable,resource,construct 1`; `contained E 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:contains.containment": {
    "description": "The `containment` is the closed detail value for `core:contains`; normative emission trigger: `container E:container,type,callable,resource,construct 1`; `contained E 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:contains.is": {
    "description": "The `is` is the closed detail value for `core:contains`; normative emission trigger: `container E:container,type,callable,resource,construct 1`; `contained E 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:contains.a": {
    "description": "The `a` is the closed detail value for `core:contains`; normative emission trigger: `container E:container,type,callable,resource,construct 1`; `contained E 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:contains.derived": {
    "description": "The `derived` is the closed detail value for `core:contains`; normative emission trigger: `container E:container,type,callable,resource,construct 1`; `contained E 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:contains.traversal": {
    "description": "The `traversal` is the closed detail value for `core:contains`; normative emission trigger: `container E:container,type,callable,resource,construct 1`; `contained E 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:contains.not": {
    "description": "The `not` is the closed detail value for `core:contains`; normative emission trigger: `container E:container,type,callable,resource,construct 1`; `contained E 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:contains.another": {
    "description": "The `another` is the closed detail value for `core:contains`; normative emission trigger: `container E:container,type,callable,resource,construct 1`; `contained E 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:contains.canonical": {
    "description": "The `canonical` is the closed detail value for `core:contains`; normative emission trigger: `container E:container,type,callable,resource,construct 1`; `contained E 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:contains.relation": {
    "description": "The `relation` is the closed detail value for `core:contains`; normative emission trigger: `container E:container,type,callable,resource,construct 1`; `contained E 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:defines.declaration": {
    "description": "The `declaration` is the closed detail value for `core:defines`; normative emission trigger: `declaration E+declaration 1`; `definition E+definition 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:defines.is": {
    "description": "The `is` is the closed detail value for `core:defines`; normative emission trigger: `declaration E+declaration 1`; `definition E+definition 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:defines.implemented": {
    "description": "The `implemented` is the closed detail value for `core:defines`; normative emission trigger: `declaration E+declaration 1`; `definition E+definition 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:defines.stored": {
    "description": "The `stored` is the closed detail value for `core:defines`; normative emission trigger: `declaration E+declaration 1`; `definition E+definition 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:defines.or": {
    "description": "The `or` is the closed detail value for `core:defines`; normative emission trigger: `declaration E+declaration 1`; `definition E+definition 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:defines.materially": {
    "description": "The `materially` is the closed detail value for `core:defines`; normative emission trigger: `declaration E+declaration 1`; `definition E+definition 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:defines.realized": {
    "description": "The `realized` is the closed detail value for `core:defines`; normative emission trigger: `declaration E+declaration 1`; `definition E+definition 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:defines.by": {
    "description": "The `by` is the closed detail value for `core:defines`; normative emission trigger: `declaration E+declaration 1`; `definition E+definition 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:defines.a": {
    "description": "The `a` is the closed detail value for `core:defines`; normative emission trigger: `declaration E+declaration 1`; `definition E+definition 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:defines.definition": {
    "description": "The `definition` is the closed detail value for `core:defines`; normative emission trigger: `declaration E+declaration 1`; `definition E+definition 1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:aliases.alias": {
    "description": "The `alias` is the closed detail value for `core:aliases`; normative emission trigger: `alias E 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:aliases.provides": {
    "description": "The `provides` is the closed detail value for `core:aliases`; normative emission trigger: `alias E 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:aliases.another": {
    "description": "The `another` is the closed detail value for `core:aliases`; normative emission trigger: `alias E 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:aliases.semantic": {
    "description": "The `semantic` is the closed detail value for `core:aliases`; normative emission trigger: `alias E 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:aliases.name": {
    "description": "The `name` is the closed detail value for `core:aliases`; normative emission trigger: `alias E 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:aliases.or": {
    "description": "The `or` is the closed detail value for `core:aliases`; normative emission trigger: `alias E 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:aliases.identity": {
    "description": "The `identity` is the closed detail value for `core:aliases`; normative emission trigger: `alias E 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:aliases.path": {
    "description": "The `path` is the closed detail value for `core:aliases`; normative emission trigger: `alias E 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:aliases.to": {
    "description": "The `to` is the closed detail value for `core:aliases`; normative emission trigger: `alias E 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:aliases.the": {
    "description": "The `the` is the closed detail value for `core:aliases`; normative emission trigger: `alias E 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:aliases.target": {
    "description": "The `target` is the closed detail value for `core:aliases`; normative emission trigger: `alias E 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:aliases.candidates": {
    "description": "The `candidates` is the closed detail value for `core:aliases`; normative emission trigger: `alias E 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:type_of.or": {
    "description": "The `or` is the closed detail value for `core:type_of`; normative emission trigger: `subject E 1`; `type E:type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:type_of.inferred": {
    "description": "The `inferred` is the closed detail value for `core:type_of`; normative emission trigger: `subject E 1`; `type E:type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:type_of.type": {
    "description": "The `type` is the closed detail value for `core:type_of`; normative emission trigger: `subject E 1`; `type E:type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:type_of.candidates": {
    "description": "The `candidates` is the closed detail value for `core:type_of`; normative emission trigger: `subject E 1`; `type E:type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:type_of.of": {
    "description": "The `of` is the closed detail value for `core:type_of`; normative emission trigger: `subject E 1`; `type E:type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:type_of.an": {
    "description": "The `an` is the closed detail value for `core:type_of`; normative emission trigger: `subject E 1`; `type E:type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:type_of.entity": {
    "description": "The `entity` is the closed detail value for `core:type_of`; normative emission trigger: `subject E 1`; `type E:type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:references.semantic": {
    "description": "The `semantic` is the closed detail value for `core:references`; normative emission trigger: `reference_site E:operation,construct 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:references.reference": {
    "description": "The `reference` is the closed detail value for `core:references`; normative emission trigger: `reference_site E:operation,construct 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:references.for": {
    "description": "The `for` is the closed detail value for `core:references`; normative emission trigger: `reference_site E:operation,construct 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:references.which": {
    "description": "The `which` is the closed detail value for `core:references`; normative emission trigger: `reference_site E:operation,construct 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:references.no": {
    "description": "The `no` is the closed detail value for `core:references`; normative emission trigger: `reference_site E:operation,construct 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:references.more": {
    "description": "The `more` is the closed detail value for `core:references`; normative emission trigger: `reference_site E:operation,construct 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:references.specific": {
    "description": "The `specific` is the closed detail value for `core:references`; normative emission trigger: `reference_site E:operation,construct 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:references.universal": {
    "description": "The `universal` is the closed detail value for `core:references`; normative emission trigger: `reference_site E:operation,construct 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:references.relation": {
    "description": "The `relation` is the closed detail value for `core:references`; normative emission trigger: `reference_site E:operation,construct 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:references.applies": {
    "description": "The `applies` is the closed detail value for `core:references`; normative emission trigger: `reference_site E:operation,construct 1`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:call.including": {
    "description": "The `including` is the closed detail value for `core:call`; normative emission trigger: `caller E:callable,container 1`; `call_site E:operation+call_site 1`; `target E:callable,type,resource,U 1..*`; `argument E:value,operation,resource,type,L 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:call.construction": {
    "description": "The `construction` is the closed detail value for `core:call`; normative emission trigger: `caller E:callable,container 1`; `call_site E:operation+call_site 1`; `target E:callable,type,resource,U 1..*`; `argument E:value,operation,resource,type,L 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:call.through": {
    "description": "The `through` is the closed detail value for `core:call`; normative emission trigger: `caller E:callable,container 1`; `call_site E:operation+call_site 1`; `target E:callable,type,resource,U 1..*`; `argument E:value,operation,resource,type,L 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:call.the": {
    "description": "The `the` is the closed detail value for `core:call`; normative emission trigger: `caller E:callable,container 1`; `call_site E:operation+call_site 1`; `target E:callable,type,resource,U 1..*`; `argument E:value,operation,resource,type,L 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:call.facet": {
    "description": "The `facet` is the closed detail value for `core:call`; normative emission trigger: `caller E:callable,container 1`; `call_site E:operation+call_site 1`; `target E:callable,type,resource,U 1..*`; `argument E:value,operation,resource,type,L 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:call.and": {
    "description": "The `and` is the closed detail value for `core:call`; normative emission trigger: `caller E:callable,container 1`; `call_site E:operation+call_site 1`; `target E:callable,type,resource,U 1..*`; `argument E:value,operation,resource,type,L 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:call.multiple": {
    "description": "The `multiple` is the closed detail value for `core:call`; normative emission trigger: `caller E:callable,container 1`; `call_site E:operation+call_site 1`; `target E:callable,type,resource,U 1..*`; `argument E:value,operation,resource,type,L 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:call.dispatch": {
    "description": "The `dispatch` is the closed detail value for `core:call`; normative emission trigger: `caller E:callable,container 1`; `call_site E:operation+call_site 1`; `target E:callable,type,resource,U 1..*`; `argument E:value,operation,resource,type,L 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:call.candidates": {
    "description": "The `candidates` is the closed detail value for `core:call`; normative emission trigger: `caller E:callable,container 1`; `call_site E:operation+call_site 1`; `target E:callable,type,resource,U 1..*`; `argument E:value,operation,resource,type,L 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:read.a": {
    "description": "The `a` is the closed detail value for `core:read`; normative emission trigger: `context E:callable,container 1`; `read_site E:operation+read_site 1`; `target E:value,resource,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:read.value": {
    "description": "The `value` is the closed detail value for `core:read`; normative emission trigger: `context E:callable,container 1`; `read_site E:operation+read_site 1`; `target E:value,resource,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:read.or": {
    "description": "The `or` is the closed detail value for `core:read`; normative emission trigger: `context E:callable,container 1`; `read_site E:operation+read_site 1`; `target E:value,resource,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:read.storage": {
    "description": "The `storage` is the closed detail value for `core:read`; normative emission trigger: `context E:callable,container 1`; `read_site E:operation+read_site 1`; `target E:value,resource,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:read.location": {
    "description": "The `location` is the closed detail value for `core:read`; normative emission trigger: `context E:callable,container 1`; `read_site E:operation+read_site 1`; `target E:value,resource,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:write.or": {
    "description": "The `or` is the closed detail value for `core:write`; normative emission trigger: `context E:callable,container 1`; `write_site E:operation+write_site 1`; `target E:value,resource,U 1..*`; `value E:value,operation,resource,L,U 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:write.assigning": {
    "description": "The `assigning` is the closed detail value for `core:write`; normative emission trigger: `context E:callable,container 1`; `write_site E:operation+write_site 1`; `target E:value,resource,U 1..*`; `value E:value,operation,resource,L,U 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:write.a": {
    "description": "The `a` is the closed detail value for `core:write`; normative emission trigger: `context E:callable,container 1`; `write_site E:operation+write_site 1`; `target E:value,resource,U 1..*`; `value E:value,operation,resource,L,U 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:write.target": {
    "description": "The `target` is the closed detail value for `core:write`; normative emission trigger: `context E:callable,container 1`; `write_site E:operation+write_site 1`; `target E:value,resource,U 1..*`; `value E:value,operation,resource,L,U 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:write.optionally": {
    "description": "The `optionally` is the closed detail value for `core:write`; normative emission trigger: `context E:callable,container 1`; `write_site E:operation+write_site 1`; `target E:value,resource,U 1..*`; `value E:value,operation,resource,L,U 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:write.with": {
    "description": "The `with` is the closed detail value for `core:write`; normative emission trigger: `context E:callable,container 1`; `write_site E:operation+write_site 1`; `target E:value,resource,U 1..*`; `value E:value,operation,resource,L,U 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:write.the": {
    "description": "The `the` is the closed detail value for `core:write`; normative emission trigger: `context E:callable,container 1`; `write_site E:operation+write_site 1`; `target E:value,resource,U 1..*`; `value E:value,operation,resource,L,U 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:write.assigned": {
    "description": "The `assigned` is the closed detail value for `core:write`; normative emission trigger: `context E:callable,container 1`; `write_site E:operation+write_site 1`; `target E:value,resource,U 1..*`; `value E:value,operation,resource,L,U 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:write.source": {
    "description": "The `source` is the closed detail value for `core:write`; normative emission trigger: `context E:callable,container 1`; `write_site E:operation+write_site 1`; `target E:value,resource,U 1..*`; `value E:value,operation,resource,L,U 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:write.value": {
    "description": "The `value` is the closed detail value for `core:write`; normative emission trigger: `context E:callable,container 1`; `write_site E:operation+write_site 1`; `target E:value,resource,U 1..*`; `value E:value,operation,resource,L,U 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:import.artifacts": {
    "description": "The `artifacts` is the closed detail value for `core:import`; normative emission trigger: `importer E:container 1`; `import_site E:operation+import_site 1`; `imported E,A,U 1..* ordered`; `local_binding E:value,type,container 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:import.or": {
    "description": "The `or` is the closed detail value for `core:import`; normative emission trigger: `importer E:container 1`; `import_site E:operation+import_site 1`; `imported E,A,U 1..* ordered`; `local_binding E:value,type,container 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:import.semantic": {
    "description": "The `semantic` is the closed detail value for `core:import`; normative emission trigger: `importer E:container 1`; `import_site E:operation+import_site 1`; `imported E,A,U 1..* ordered`; `local_binding E:value,type,container 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:import.entities": {
    "description": "The `entities` is the closed detail value for `core:import`; normative emission trigger: `importer E:container 1`; `import_site E:operation+import_site 1`; `imported E,A,U 1..* ordered`; `local_binding E:value,type,container 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:import.into": {
    "description": "The `into` is the closed detail value for `core:import`; normative emission trigger: `importer E:container 1`; `import_site E:operation+import_site 1`; `imported E,A,U 1..* ordered`; `local_binding E:value,type,container 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:import.a": {
    "description": "The `a` is the closed detail value for `core:import`; normative emission trigger: `importer E:container 1`; `import_site E:operation+import_site 1`; `imported E,A,U 1..* ordered`; `local_binding E:value,type,container 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:import.container": {
    "description": "The `container` is the closed detail value for `core:import`; normative emission trigger: `importer E:container 1`; `import_site E:operation+import_site 1`; `imported E,A,U 1..* ordered`; `local_binding E:value,type,container 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:import.ordered": {
    "description": "The `ordered` is the closed detail value for `core:import`; normative emission trigger: `importer E:container 1`; `import_site E:operation+import_site 1`; `imported E,A,U 1..* ordered`; `local_binding E:value,type,container 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:import.positions": {
    "description": "The `positions` is the closed detail value for `core:import`; normative emission trigger: `importer E:container 1`; `import_site E:operation+import_site 1`; `imported E,A,U 1..* ordered`; `local_binding E:value,type,container 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:import.associate": {
    "description": "The `associate` is the closed detail value for `core:import`; normative emission trigger: `importer E:container 1`; `import_site E:operation+import_site 1`; `imported E,A,U 1..* ordered`; `local_binding E:value,type,container 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:import.imported": {
    "description": "The `imported` is the closed detail value for `core:import`; normative emission trigger: `importer E:container 1`; `import_site E:operation+import_site 1`; `imported E,A,U 1..* ordered`; `local_binding E:value,type,container 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:import.items": {
    "description": "The `items` is the closed detail value for `core:import`; normative emission trigger: `importer E:container 1`; `import_site E:operation+import_site 1`; `imported E,A,U 1..* ordered`; `local_binding E:value,type,container 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:import.with": {
    "description": "The `with` is the closed detail value for `core:import`; normative emission trigger: `importer E:container 1`; `import_site E:operation+import_site 1`; `imported E,A,U 1..* ordered`; `local_binding E:value,type,container 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:import.local": {
    "description": "The `local` is the closed detail value for `core:import`; normative emission trigger: `importer E:container 1`; `import_site E:operation+import_site 1`; `imported E,A,U 1..* ordered`; `local_binding E:value,type,container 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:import.bindings": {
    "description": "The `bindings` is the closed detail value for `core:import`; normative emission trigger: `importer E:container 1`; `import_site E:operation+import_site 1`; `imported E,A,U 1..* ordered`; `local_binding E:value,type,container 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:export.entities": {
    "description": "The `entities` is the closed detail value for `core:export`; normative emission trigger: `exporter E:container 1`; `export_site E:operation+export_site 1`; `exported E 1..* ordered`; `alias E:value,type,container,L 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:export.outside": {
    "description": "The `outside` is the closed detail value for `core:export`; normative emission trigger: `exporter E:container 1`; `export_site E:operation+export_site 1`; `exported E 1..* ordered`; `alias E:value,type,container,L 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:export.a": {
    "description": "The `a` is the closed detail value for `core:export`; normative emission trigger: `exporter E:container 1`; `export_site E:operation+export_site 1`; `exported E 1..* ordered`; `alias E:value,type,container,L 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:export.container": {
    "description": "The `container` is the closed detail value for `core:export`; normative emission trigger: `exporter E:container 1`; `export_site E:operation+export_site 1`; `exported E 1..* ordered`; `alias E:value,type,container,L 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:export.optionally": {
    "description": "The `optionally` is the closed detail value for `core:export`; normative emission trigger: `exporter E:container 1`; `export_site E:operation+export_site 1`; `exported E 1..* ordered`; `alias E:value,type,container,L 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:export.under": {
    "description": "The `under` is the closed detail value for `core:export`; normative emission trigger: `exporter E:container 1`; `export_site E:operation+export_site 1`; `exported E 1..* ordered`; `alias E:value,type,container,L 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:export.ordered": {
    "description": "The `ordered` is the closed detail value for `core:export`; normative emission trigger: `exporter E:container 1`; `export_site E:operation+export_site 1`; `exported E 1..* ordered`; `alias E:value,type,container,L 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:export.aliases": {
    "description": "The `aliases` is the closed detail value for `core:export`; normative emission trigger: `exporter E:container 1`; `export_site E:operation+export_site 1`; `exported E 1..* ordered`; `alias E:value,type,container,L 0..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:inherits.inheritance": {
    "description": "The `inheritance` is the closed detail value for `core:inherits`; normative emission trigger: `subtype E:type 1`; `inheritance_site E:operation,construct 1`; `supertype E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:inherits.or": {
    "description": "The `or` is the closed detail value for `core:inherits`; normative emission trigger: `subtype E:type 1`; `inheritance_site E:operation,construct 1`; `supertype E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:inherits.extension": {
    "description": "The `extension` is the closed detail value for `core:inherits`; normative emission trigger: `subtype E:type 1`; `inheritance_site E:operation,construct 1`; `supertype E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:inherits.does": {
    "description": "The `does` is the closed detail value for `core:inherits`; normative emission trigger: `subtype E:type 1`; `inheritance_site E:operation,construct 1`; `supertype E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:inherits.not": {
    "description": "The `not` is the closed detail value for `core:inherits`; normative emission trigger: `subtype E:type 1`; `inheritance_site E:operation,construct 1`; `supertype E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:inherits.represent": {
    "description": "The `represent` is the closed detail value for `core:inherits`; normative emission trigger: `subtype E:type 1`; `inheritance_site E:operation,construct 1`; `supertype E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:inherits.interface": {
    "description": "The `interface` is the closed detail value for `core:inherits`; normative emission trigger: `subtype E:type 1`; `inheritance_site E:operation,construct 1`; `supertype E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:inherits.protocol": {
    "description": "The `protocol` is the closed detail value for `core:inherits`; normative emission trigger: `subtype E:type 1`; `inheritance_site E:operation,construct 1`; `supertype E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:inherits.conformance": {
    "description": "The `conformance` is the closed detail value for `core:inherits`; normative emission trigger: `subtype E:type 1`; `inheritance_site E:operation,construct 1`; `supertype E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:inherits.when": {
    "description": "The `when` is the closed detail value for `core:inherits`; normative emission trigger: `subtype E:type 1`; `inheritance_site E:operation,construct 1`; `supertype E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:inherits.core": {
    "description": "The `core` is the closed detail value for `core:inherits`; normative emission trigger: `subtype E:type 1`; `inheritance_site E:operation,construct 1`; `supertype E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:inherits.implements": {
    "description": "The `implements` is the closed detail value for `core:inherits`; normative emission trigger: `subtype E:type 1`; `inheritance_site E:operation,construct 1`; `supertype E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:inherits.applies": {
    "description": "The `applies` is the closed detail value for `core:inherits`; normative emission trigger: `subtype E:type 1`; `inheritance_site E:operation,construct 1`; `supertype E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:implements.to": {
    "description": "The `to` is the closed detail value for `core:implements`; normative emission trigger: `implementer E:type,callable 1`; `implementation_site E:operation,construct 1`; `contract E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:implements.an": {
    "description": "The `an` is the closed detail value for `core:implements`; normative emission trigger: `implementer E:type,callable 1`; `implementation_site E:operation,construct 1`; `contract E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:implements.interface": {
    "description": "The `interface` is the closed detail value for `core:implements`; normative emission trigger: `implementer E:type,callable 1`; `implementation_site E:operation,construct 1`; `contract E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:implements.trait": {
    "description": "The `trait` is the closed detail value for `core:implements`; normative emission trigger: `implementer E:type,callable 1`; `implementation_site E:operation,construct 1`; `contract E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:implements.protocol": {
    "description": "The `protocol` is the closed detail value for `core:implements`; normative emission trigger: `implementer E:type,callable 1`; `implementation_site E:operation,construct 1`; `contract E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:implements.callable": {
    "description": "The `callable` is the closed detail value for `core:implements`; normative emission trigger: `implementer E:type,callable 1`; `implementation_site E:operation,construct 1`; `contract E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:implements.contract": {
    "description": "The `contract` is the closed detail value for `core:implements`; normative emission trigger: `implementer E:type,callable 1`; `implementation_site E:operation,construct 1`; `contract E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:implements.or": {
    "description": "The `or` is the closed detail value for `core:implements`; normative emission trigger: `implementer E:type,callable 1`; `implementation_site E:operation,construct 1`; `contract E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:implements.equivalent": {
    "description": "The `equivalent` is the closed detail value for `core:implements`; normative emission trigger: `implementer E:type,callable 1`; `implementation_site E:operation,construct 1`; `contract E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:implements.abstraction": {
    "description": "The `abstraction` is the closed detail value for `core:implements`; normative emission trigger: `implementer E:type,callable 1`; `implementation_site E:operation,construct 1`; `contract E:type,U 1..* ordered` (source: taxonomy/core-taxonomy.md)."
  },
  "core:overrides.replacement": {
    "description": "The `replacement` is the closed detail value for `core:overrides`; normative emission trigger: `overriding E:callable,value 1`; `overridden E:callable,value,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:overrides.of": {
    "description": "The `of` is the closed detail value for `core:overrides`; normative emission trigger: `overriding E:callable,value 1`; `overridden E:callable,value,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:overrides.inherited": {
    "description": "The `inherited` is the closed detail value for `core:overrides`; normative emission trigger: `overriding E:callable,value 1`; `overridden E:callable,value,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:overrides.or": {
    "description": "The `or` is the closed detail value for `core:overrides`; normative emission trigger: `overriding E:callable,value 1`; `overridden E:callable,value,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:overrides.implemented": {
    "description": "The `implemented` is the closed detail value for `core:overrides`; normative emission trigger: `overriding E:callable,value 1`; `overridden E:callable,value,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:overrides.members": {
    "description": "The `members` is the closed detail value for `core:overrides`; normative emission trigger: `overriding E:callable,value 1`; `overridden E:callable,value,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:returns.or": {
    "description": "The `or` is the closed detail value for `core:returns`; normative emission trigger: `callable E:callable 1`; `return_site E:operation+return_site 1`; `value E:value,operation,resource,L,U 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:returns.implicit": {
    "description": "The `implicit` is the closed detail value for `core:returns`; normative emission trigger: `callable E:callable 1`; `return_site E:operation+return_site 1`; `value E:value,operation,resource,L,U 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:returns.return": {
    "description": "The `return` is the closed detail value for `core:returns`; normative emission trigger: `callable E:callable 1`; `return_site E:operation+return_site 1`; `value E:value,operation,resource,L,U 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:returns.of": {
    "description": "The `of` is the closed detail value for `core:returns`; normative emission trigger: `callable E:callable 1`; `return_site E:operation+return_site 1`; `value E:value,operation,resource,L,U 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:returns.control": {
    "description": "The `control` is the closed detail value for `core:returns`; normative emission trigger: `callable E:callable 1`; `return_site E:operation+return_site 1`; `value E:value,operation,resource,L,U 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:returns.and": {
    "description": "The `and` is the closed detail value for `core:returns`; normative emission trigger: `callable E:callable 1`; `return_site E:operation+return_site 1`; `value E:value,operation,resource,L,U 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:returns.an": {
    "description": "The `an` is the closed detail value for `core:returns`; normative emission trigger: `callable E:callable 1`; `return_site E:operation+return_site 1`; `value E:value,operation,resource,L,U 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:returns.value": {
    "description": "The `value` is the closed detail value for `core:returns`; normative emission trigger: `callable E:callable 1`; `return_site E:operation+return_site 1`; `value E:value,operation,resource,L,U 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds_argument.between": {
    "description": "The `between` is the closed detail value for `core:binds_argument`; normative emission trigger: `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds_argument.one": {
    "description": "The `one` is the closed detail value for `core:binds_argument`; normative emission trigger: `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds_argument.call": {
    "description": "The `call` is the closed detail value for `core:binds_argument`; normative emission trigger: `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds_argument.argument": {
    "description": "The `argument` is the closed detail value for `core:binds_argument`; normative emission trigger: `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds_argument.and": {
    "description": "The `and` is the closed detail value for `core:binds_argument`; normative emission trigger: `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds_argument.or": {
    "description": "The `or` is the closed detail value for `core:binds_argument`; normative emission trigger: `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds_argument.more": {
    "description": "The `more` is the closed detail value for `core:binds_argument`; normative emission trigger: `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds_argument.possible": {
    "description": "The `possible` is the closed detail value for `core:binds_argument`; normative emission trigger: `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds_argument.parameters": {
    "description": "The `parameters` is the closed detail value for `core:binds_argument`; normative emission trigger: `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds_argument.local": {
    "description": "The `local` is the closed detail value for `core:binds_argument`; normative emission trigger: `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds_argument.relation": {
    "description": "The `relation` is the closed detail value for `core:binds_argument`; normative emission trigger: `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds_argument.key": {
    "description": "The `key` is the closed detail value for `core:binds_argument`; normative emission trigger: `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds_argument.includes": {
    "description": "The `includes` is the closed detail value for `core:binds_argument`; normative emission trigger: `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds_argument.the": {
    "description": "The `the` is the closed detail value for `core:binds_argument`; normative emission trigger: `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds_argument.source": {
    "description": "The `source` is the closed detail value for `core:binds_argument`; normative emission trigger: `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds_argument.position": {
    "description": "The `position` is the closed detail value for `core:binds_argument`; normative emission trigger: `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds_argument.without": {
    "description": "The `without` is the closed detail value for `core:binds_argument`; normative emission trigger: `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds_argument.using": {
    "description": "The `using` is the closed detail value for `core:binds_argument`; normative emission trigger: `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds_argument.its": {
    "description": "The `its` is the closed detail value for `core:binds_argument`; normative emission trigger: `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds_argument.resolved": {
    "description": "The `resolved` is the closed detail value for `core:binds_argument`; normative emission trigger: `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds_argument.identity": {
    "description": "The `identity` is the closed detail value for `core:binds_argument`; normative emission trigger: `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:captures.capture": {
    "description": "The `capture` is the closed detail value for `core:captures`; normative emission trigger: `callable E:callable 1`; `captured_value E:value 1..*`; `capture_site E:operation,construct 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:captures.of": {
    "description": "The `of` is the closed detail value for `core:captures`; normative emission trigger: `callable E:callable 1`; `captured_value E:value 1..*`; `capture_site E:operation,construct 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:captures.values": {
    "description": "The `values` is the closed detail value for `core:captures`; normative emission trigger: `callable E:callable 1`; `captured_value E:value 1..*`; `capture_site E:operation,construct 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:captures.by": {
    "description": "The `by` is the closed detail value for `core:captures`; normative emission trigger: `callable E:callable 1`; `captured_value E:value 1..*`; `capture_site E:operation,construct 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:captures.a": {
    "description": "The `a` is the closed detail value for `core:captures`; normative emission trigger: `callable E:callable 1`; `captured_value E:value 1..*`; `capture_site E:operation,construct 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:captures.callable": {
    "description": "The `callable` is the closed detail value for `core:captures`; normative emission trigger: `callable E:callable 1`; `captured_value E:value 1..*`; `capture_site E:operation,construct 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:captures.or": {
    "description": "The `or` is the closed detail value for `core:captures`; normative emission trigger: `callable E:callable 1`; `captured_value E:value 1..*`; `capture_site E:operation,construct 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:captures.closure": {
    "description": "The `closure` is the closed detail value for `core:captures`; normative emission trigger: `callable E:callable 1`; `captured_value E:value 1..*`; `capture_site E:operation,construct 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:captures.like": {
    "description": "The `like` is the closed detail value for `core:captures`; normative emission trigger: `callable E:callable 1`; `captured_value E:value 1..*`; `capture_site E:operation,construct 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:captures.construct": {
    "description": "The `construct` is the closed detail value for `core:captures`; normative emission trigger: `callable E:callable 1`; `captured_value E:value 1..*`; `capture_site E:operation,construct 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:throws.or": {
    "description": "The `or` is the closed detail value for `core:throws`; normative emission trigger: `callable E:callable,container 1`; `throw_site E:operation 1`; `value_or_type E:value,operation,type,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:throws.propagation": {
    "description": "The `propagation` is the closed detail value for `core:throws`; normative emission trigger: `callable E:callable,container 1`; `throw_site E:operation 1`; `value_or_type E:value,operation,type,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:throws.of": {
    "description": "The `of` is the closed detail value for `core:throws`; normative emission trigger: `callable E:callable,container 1`; `throw_site E:operation 1`; `value_or_type E:value,operation,type,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:throws.an": {
    "description": "The `an` is the closed detail value for `core:throws`; normative emission trigger: `callable E:callable,container 1`; `throw_site E:operation 1`; `value_or_type E:value,operation,type,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:throws.exception": {
    "description": "The `exception` is the closed detail value for `core:throws`; normative emission trigger: `callable E:callable,container 1`; `throw_site E:operation 1`; `value_or_type E:value,operation,type,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:throws.error": {
    "description": "The `error` is the closed detail value for `core:throws`; normative emission trigger: `callable E:callable,container 1`; `throw_site E:operation 1`; `value_or_type E:value,operation,type,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:throws.value": {
    "description": "The `value` is the closed detail value for `core:throws`; normative emission trigger: `callable E:callable,container 1`; `throw_site E:operation 1`; `value_or_type E:value,operation,type,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:throws.language": {
    "description": "The `language` is the closed detail value for `core:throws`; normative emission trigger: `callable E:callable,container 1`; `throw_site E:operation 1`; `value_or_type E:value,operation,type,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:throws.equivalent": {
    "description": "The `equivalent` is the closed detail value for `core:throws`; normative emission trigger: `callable E:callable,container 1`; `throw_site E:operation 1`; `value_or_type E:value,operation,type,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:throws.effect": {
    "description": "The `effect` is the closed detail value for `core:throws`; normative emission trigger: `callable E:callable,container 1`; `throw_site E:operation 1`; `value_or_type E:value,operation,type,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:throws.at": {
    "description": "The `at` is the closed detail value for `core:throws`; normative emission trigger: `callable E:callable,container 1`; `throw_site E:operation 1`; `value_or_type E:value,operation,type,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:throws.a": {
    "description": "The `a` is the closed detail value for `core:throws`; normative emission trigger: `callable E:callable,container 1`; `throw_site E:operation 1`; `value_or_type E:value,operation,type,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:throws.concrete": {
    "description": "The `concrete` is the closed detail value for `core:throws`; normative emission trigger: `callable E:callable,container 1`; `throw_site E:operation 1`; `value_or_type E:value,operation,type,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:throws.site": {
    "description": "The `site` is the closed detail value for `core:throws`; normative emission trigger: `callable E:callable,container 1`; `throw_site E:operation 1`; `value_or_type E:value,operation,type,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:handles.callable": {
    "description": "The `callable` is the closed detail value for `core:handles`; normative emission trigger: `handler E:callable,resource 1`; `handled E:value,type,resource,U 1..*`; `handler_site E:operation,construct 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:handles.or": {
    "description": "The `or` is the closed detail value for `core:handles`; normative emission trigger: `handler E:callable,resource 1`; `handled E:value,type,resource,U 1..*`; `handler_site E:operation,construct 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:handles.resource": {
    "description": "The `resource` is the closed detail value for `core:handles`; normative emission trigger: `handler E:callable,resource 1`; `handled E:value,type,resource,U 1..*`; `handler_site E:operation,construct 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:handles.handles": {
    "description": "The `handles` is the closed detail value for `core:handles`; normative emission trigger: `handler E:callable,resource 1`; `handled E:value,type,resource,U 1..*`; `handler_site E:operation,construct 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:handles.errors": {
    "description": "The `errors` is the closed detail value for `core:handles`; normative emission trigger: `handler E:callable,resource 1`; `handled E:value,type,resource,U 1..*`; `handler_site E:operation,construct 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:handles.events": {
    "description": "The `events` is the closed detail value for `core:handles`; normative emission trigger: `handler E:callable,resource 1`; `handled E:value,type,resource,U 1..*`; `handler_site E:operation,construct 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:handles.requests": {
    "description": "The `requests` is the closed detail value for `core:handles`; normative emission trigger: `handler E:callable,resource 1`; `handled E:value,type,resource,U 1..*`; `handler_site E:operation,construct 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:handles.another": {
    "description": "The `another` is the closed detail value for `core:handles`; normative emission trigger: `handler E:callable,resource 1`; `handled E:value,type,resource,U 1..*`; `handler_site E:operation,construct 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:handles.modeled": {
    "description": "The `modeled` is the closed detail value for `core:handles`; normative emission trigger: `handler E:callable,resource 1`; `handled E:value,type,resource,U 1..*`; `handler_site E:operation,construct 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:handles.input": {
    "description": "The `input` is the closed detail value for `core:handles`; normative emission trigger: `handler E:callable,resource 1`; `handled E:value,type,resource,U 1..*`; `handler_site E:operation,construct 0..1` (source: taxonomy/core-taxonomy.md)."
  },
  "core:depends_on.explicit": {
    "description": "The `explicit` is the closed detail value for `core:depends_on`; normative emission trigger: `dependent E 1`; `dependency E,A,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:depends_on.dependency": {
    "description": "The `dependency` is the closed detail value for `core:depends_on`; normative emission trigger: `dependent E 1`; `dependency E,A,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:depends_on.not": {
    "description": "The `not` is the closed detail value for `core:depends_on`; normative emission trigger: `dependent E 1`; `dependency E,A,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:depends_on.represented": {
    "description": "The `represented` is the closed detail value for `core:depends_on`; normative emission trigger: `dependent E 1`; `dependency E,A,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:depends_on.more": {
    "description": "The `more` is the closed detail value for `core:depends_on`; normative emission trigger: `dependent E 1`; `dependency E,A,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:depends_on.precisely": {
    "description": "The `precisely` is the closed detail value for `core:depends_on`; normative emission trigger: `dependent E 1`; `dependency E,A,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:depends_on.by": {
    "description": "The `by` is the closed detail value for `core:depends_on`; normative emission trigger: `dependent E 1`; `dependency E,A,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:depends_on.import": {
    "description": "The `import` is the closed detail value for `core:depends_on`; normative emission trigger: `dependent E 1`; `dependency E,A,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:depends_on.reference": {
    "description": "The `reference` is the closed detail value for `core:depends_on`; normative emission trigger: `dependent E 1`; `dependency E,A,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:depends_on.call": {
    "description": "The `call` is the closed detail value for `core:depends_on`; normative emission trigger: `dependent E 1`; `dependency E,A,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:depends_on.type": {
    "description": "The `type` is the closed detail value for `core:depends_on`; normative emission trigger: `dependent E 1`; `dependency E,A,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:depends_on.or": {
    "description": "The `or` is the closed detail value for `core:depends_on`; normative emission trigger: `dependent E 1`; `dependency E,A,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:depends_on.flow": {
    "description": "The `flow` is the closed detail value for `core:depends_on`; normative emission trigger: `dependent E 1`; `dependency E,A,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:depends_on.relations": {
    "description": "The `relations` is the closed detail value for `core:depends_on`; normative emission trigger: `dependent E 1`; `dependency E,A,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds.configuration": {
    "description": "The `configuration` is the closed detail value for `core:binds`; normative emission trigger: `binding_site E:operation,construct 1`; `source E,L,U 1..*`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds.or": {
    "description": "The `or` is the closed detail value for `core:binds`; normative emission trigger: `binding_site E:operation,construct 1`; `source E,L,U 1..*`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds.modeled": {
    "description": "The `modeled` is the closed detail value for `core:binds`; normative emission trigger: `binding_site E:operation,construct 1`; `source E,L,U 1..*`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds.runtime": {
    "description": "The `runtime` is the closed detail value for `core:binds`; normative emission trigger: `binding_site E:operation,construct 1`; `source E,L,U 1..*`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds.association": {
    "description": "The `association` is the closed detail value for `core:binds`; normative emission trigger: `binding_site E:operation,construct 1`; `source E,L,U 1..*`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds.between": {
    "description": "The `between` is the closed detail value for `core:binds`; normative emission trigger: `binding_site E:operation,construct 1`; `source E,L,U 1..*`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds.sources": {
    "description": "The `sources` is the closed detail value for `core:binds`; normative emission trigger: `binding_site E:operation,construct 1`; `source E,L,U 1..*`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds.and": {
    "description": "The `and` is the closed detail value for `core:binds`; normative emission trigger: `binding_site E:operation,construct 1`; `source E,L,U 1..*`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:binds.targets": {
    "description": "The `targets` is the closed detail value for `core:binds`; normative emission trigger: `binding_site E:operation,construct 1`; `source E,L,U 1..*`; `target E,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:covers.or": {
    "description": "The `or` is the closed detail value for `core:covers`; normative emission trigger: `test E:callable,container,resource 1`; `covered E 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:covers.observed": {
    "description": "The `observed` is the closed detail value for `core:covers`; normative emission trigger: `test E:callable,container,resource 1`; `covered E 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:covers.test": {
    "description": "The `test` is the closed detail value for `core:covers`; normative emission trigger: `test E:callable,container,resource 1`; `covered E 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:covers.coverage": {
    "description": "The `coverage` is the closed detail value for `core:covers`; normative emission trigger: `test E:callable,container,resource 1`; `covered E 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:covers.of": {
    "description": "The `of` is the closed detail value for `core:covers`; normative emission trigger: `test E:callable,container,resource 1`; `covered E 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:covers.semantic": {
    "description": "The `semantic` is the closed detail value for `core:covers`; normative emission trigger: `test E:callable,container,resource 1`; `covered E 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:covers.entities": {
    "description": "The `entities` is the closed detail value for `core:covers`; normative emission trigger: `test E:callable,container,resource 1`; `covered E 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:covers.evidence": {
    "description": "The `evidence` is the closed detail value for `core:covers`; normative emission trigger: `test E:callable,container,resource 1`; `covered E 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:covers.states": {
    "description": "The `states` is the closed detail value for `core:covers`; normative emission trigger: `test E:callable,container,resource 1`; `covered E 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:covers.whether": {
    "description": "The `whether` is the closed detail value for `core:covers`; normative emission trigger: `test E:callable,container,resource 1`; `covered E 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:covers.is": {
    "description": "The `is` is the closed detail value for `core:covers`; normative emission trigger: `test E:callable,container,resource 1`; `covered E 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:covers.inferred": {
    "description": "The `inferred` is the closed detail value for `core:covers`; normative emission trigger: `test E:callable,container,resource 1`; `covered E 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:covers.measured": {
    "description": "The `measured` is the closed detail value for `core:covers`; normative emission trigger: `test E:callable,container,resource 1`; `covered E 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:association.for": {
    "description": "The `for` is the closed detail value for `core:association`; normative emission trigger: `source E 1`; `target E,R,A,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:association.a": {
    "description": "The `a` is the closed detail value for `core:association`; normative emission trigger: `source E 1`; `target E,R,A,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:association.genuine": {
    "description": "The `genuine` is the closed detail value for `core:association`; normative emission trigger: `source E 1`; `target E,R,A,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:association.navigable": {
    "description": "The `navigable` is the closed detail value for `core:association`; normative emission trigger: `source E 1`; `target E,R,A,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:association.relation": {
    "description": "The `relation` is the closed detail value for `core:association`; normative emission trigger: `source E 1`; `target E,R,A,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:association.with": {
    "description": "The `with` is the closed detail value for `core:association`; normative emission trigger: `source E 1`; `target E,R,A,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:association.no": {
    "description": "The `no` is the closed detail value for `core:association`; normative emission trigger: `source E 1`; `target E,R,A,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:association.truthful": {
    "description": "The `truthful` is the closed detail value for `core:association`; normative emission trigger: `source E 1`; `target E,R,A,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:association.specialized": {
    "description": "The `specialized` is the closed detail value for `core:association`; normative emission trigger: `source E 1`; `target E,R,A,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:association.base": {
    "description": "The `base` is the closed detail value for `core:association`; normative emission trigger: `source E 1`; `target E,R,A,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:association.concrete": {
    "description": "The `concrete` is the closed detail value for `core:association`; normative emission trigger: `source E 1`; `target E,R,A,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:association.kind": {
    "description": "The `kind` is the closed detail value for `core:association`; normative emission trigger: `source E 1`; `target E,R,A,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:association.must": {
    "description": "The `must` is the closed detail value for `core:association`; normative emission trigger: `source E 1`; `target E,R,A,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:association.document": {
    "description": "The `document` is the closed detail value for `core:association`; normative emission trigger: `source E 1`; `target E,R,A,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:association.why": {
    "description": "The `why` is the closed detail value for `core:association`; normative emission trigger: `source E 1`; `target E,R,A,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:association.another": {
    "description": "The `another` is the closed detail value for `core:association`; normative emission trigger: `source E 1`; `target E,R,A,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:association.universal": {
    "description": "The `universal` is the closed detail value for `core:association`; normative emission trigger: `source E 1`; `target E,R,A,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:association.does": {
    "description": "The `does` is the closed detail value for `core:association`; normative emission trigger: `source E 1`; `target E,R,A,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:association.not": {
    "description": "The `not` is the closed detail value for `core:association`; normative emission trigger: `source E 1`; `target E,R,A,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  },
  "core:association.apply": {
    "description": "The `apply` is the closed detail value for `core:association`; normative emission trigger: `source E 1`; `target E,R,A,L,U 1..*` (source: taxonomy/core-taxonomy.md)."
  }
} as const;
