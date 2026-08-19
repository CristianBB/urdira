# Core Intent Recipes

Status: **Approved initial registry**  
Last updated: 2026-08-08  
Depends on: [Public query contract](public-query-contract.md), [Query algebra](../decisions/03-query-algebra-public-api.md), and [Universal data model](../decisions/01-universal-data-model.md)

## Registry rules

This file is authoritative for the eleven core `IntentRecipeDefinition` values in public API v1. Every definition has `recipe_version = 1`, `public_api_version = 1`, uses operator and stable-operation version `1`, and is core-owned. Plugins cannot add, replace, reorder, rank, or intercept recipes.

Recipe argument schemas are the exact `core:*Arguments@1` inline schemas in the [core canonical schema registry](../serialization/core-canonical-schemas.md). Public omission of a documented default is normalized before recipe hashing. Every stage's `static_arguments_schema_id + static_arguments_schema_version` is `core:RecipeStaticArguments@1`; its `partial_arguments_schema_id + version` is the selected operation's public v1 argument schema. `argument_bindings` are the exact RFC 6901 copies listed below. A stage input written `stage.output -> field` is an `expand.operation` binding of the complete logical upstream set, not the current response page.

All recipes use `completeness_policy = report`. A caller selecting `QueryOptions.coverage_requirement = require_complete` raises the same recipe to complete-required without changing its definition. Required capabilities are complete requirement coordinates for capability contract version `1.0.0`. Every output is materialized before paging; forward and backward cursor pages reuse the stored manifest and never rerun or rerank a stage.

The initial ranking binding `core:search_hybrid_default@1` is the immutable core-owned ranking profile of `core:search_hybrid@1`. It is used only where explicitly listed, is pinned in the query execution, and is never exposed as a score or caller option. Every stream uses the core canonical comparator `core:query_manifest_stream_order@1`: result-set name, result classification in confirmed-before-possible order, and contiguous manifest ordinal. The ordinal is assigned only after the selected stable operation's deterministic order. Plugins cannot contribute or replace this ordering.

Closed guard predicates are:

| Predicate | Exact condition | Failure code |
|---|---|---|
| `core:one_confirmed_subject` | The named stage has exactly one confirmed subject; possible alternatives may additionally be returned only in an ambiguity error detail. | `core:selector_ambiguous` or `core:selector_not_found` according to cardinality |
| `core:comparison_roles_base_target` | Query scope is `comparison` with exactly one `base` and one `target` participant. | `core:invalid_query_scope` |
| `core:instance_definition_families` | Every selected definition, when any exist, is a `record_kind`, `facet`, or `language`. An empty exact definition set passes. | `core:invalid_definition_instance_selector` |

## Definition notation

For each recipe, `Arguments` gives the exact schema and public defaults. `Stages` lists `stage_id: operation(input bindings; static values)`. Recipe-argument bindings use `$` followed by their argument pointer. `Outputs` lists `output_name <- stage.output / projection`. `Streams` names independently pageable output/classification streams; each supports both directions and uses the common manifest order above. Unlisted static operation fields take the stable operation's public default.

## `core:locate_implementation@1`

Description: find concrete implementation-bearing definitions relevant to a task in one call.

- Arguments: `core:LocateImplementationArguments@1`; defaults are `query_class = mixed`, `filter` absent.
- Required capabilities: `core:symbol_declarations`, `core:semantic_preparation`.
- Stages:
  1. `search: core:search_hybrid(query_text <- $/query_text, query_class <- $/query_class, filter <- $/filter; require_structural_subject = true)`.
  2. `implementations: filter(search.candidates; facet contains core:definition)`.
  3. `source: core:get_source(implementations.subjects -> subjects; source.mode = relevant, include_related_evidence = true)`.
- Outputs: `implementations <- implementations.subjects / subjects`; `sources <- source.sources / subjects`.
- Ranking bindings: `search -> core:search_hybrid_default@1`.
- Guards: none.
- Streams: `implementations.confirmed`, `implementations.possible`, and `sources`, each independent.

## `core:understand_change_impact@1`

Description: obtain affected code, contracts, tests, uncertainty, evidence, and source for one hypothetical change.

- Arguments: `core:UnderstandChangeImpactArguments@1`; defaults are `include_transitive = true`, `include_tests = true`, `filter` absent.
- Required capabilities: `core:symbol_resolution`, `core:call_relationships`, `core:module_dependencies`, `core:test_relationships`.
- Stages:
  1. `impact: core:analyze_impact(target <- $/target, change <- $/change, include_transitive <- $/include_transitive, include_tests <- $/include_tests, filter <- $/filter)`.
  2. `source: core:get_source(impact.all_classified_subjects -> subjects; source.mode = relevant, include_related_evidence = true)`.
- Outputs: the five unchanged impact outputs `will_break`, `must_update`, `may_be_affected`, `tests_to_run`, `uncertain_dynamic_usage`; and `sources <- source.sources`.
- Ranking bindings: none. Guards: none.
- Streams: one confirmed/possible stream for each impact output plus one `sources` stream.

## `core:prepare_symbol_change@1`

Description: resolve a symbol once and return its impact, references, tests, and exact relevant source.

- Arguments: `core:PrepareSymbolChangeArguments@1`; `filter` defaults absent.
- Required capabilities: `core:symbol_declarations`, `core:symbol_resolution`, `core:call_relationships`, `core:test_relationships`.
- Stages:
  1. `resolve: core:resolve_symbol(reference <- $/reference, context_artifact <- $/context_artifact, context_byte_offset <- $/context_byte_offset, kind_selector <- $/kind_selector)`.
  2. Guard `core:one_confirmed_subject` after `resolve.declarations`.
  3. `impact: core:analyze_impact(resolve.declarations -> target, change <- $/change, filter <- $/filter; include_transitive = true, include_tests = true)`.
  4. `references: core:find_references(resolve.declarations -> target, filter <- $/filter; include_declarations = false)`.
  5. `tests: core:find_related_tests(resolve.declarations -> subjects, filter <- $/filter; relationship_scope = both, include_fixtures = true)`.
  6. `source: core:get_source(impact.all_classified_subjects + references.references + tests.tests -> subjects; source.mode = relevant, include_related_evidence = true)`.
- Outputs: `target`, all five impact outputs, `references`, `tests`, `fixtures`, `mocks`, `helpers`, and `sources` from their namesake stages.
- Ranking bindings: none.
- Streams: every named output is independent; evidence classification creates confirmed/possible substreams.

## `core:prepare_new_feature@1`

Description: find extension points, analogous implementations, architectural boundaries, tests, and bounded task context for new code.

- Arguments: `core:PrepareNewFeatureArguments@1`; defaults are `query_class = mixed`, `filter` absent.
- Required capabilities: `core:semantic_preparation`, `core:symbol_declarations`, `core:module_dependencies`, `core:framework_semantics`, `core:test_relationships`.
- Stages:
  1. `seeds: core:search_hybrid(query_text <- $/task, query_class <- $/query_class, filter <- $/filter; require_structural_subject = true)`.
  2. `analogue_selector: bind.subject_record_selector(seeds.candidates; filter <- $/filter)`.
  3. `analogues: core:find_records(analogue_selector.selector -> selector)`; exact structural membership retains the semantic seed provenance and therefore possible task relevance.
  4. `architecture: core:inspect_architecture(filter <- $/filter; views = [entry_points, boundaries, public_surfaces, extension_points, layers], max_relation_depth = 5)`.
  5. `context: core:build_context(task <- $/task, query_class <- $/query_class, filter <- $/filter; facets = [definitions, implementations, dependencies, contracts, effects, tests, configuration, analogues, extension_points])`.
  6. `tests: core:find_related_tests(analogues.records -> subjects, filter <- $/filter; relationship_scope = both, include_fixtures = true)`.
- Outputs: `analogues`, each requested architecture view, `context`, `tests`, `fixtures`, `mocks`, and `helpers`.
- Ranking bindings: `seeds -> core:search_hybrid_default@1`; exact analogue enumeration uses the fixed structural record order, while the context operation retains its own operation-pinned order.
- Guards: none. Streams: every output/classification pair is independent.

## `core:trace_behavior@1`

Description: trace structurally evidenced behavior from explicit subjects without semantic retrieval.

- Arguments: `core:TraceBehaviorArguments@1`; `subjects` is non-empty; defaults are `direction = outbound`, `relations = { universal_kinds: [core:call] }`, `max_depth = 3`, `filter` absent.
- Required capabilities: `core:call_relationships`, `core:control_flow`, `core:data_flow`, `core:effects`.
- Stages:
  1. `trace: core:expand_relations(subjects <- $/subjects, direction <- $/direction, relations <- $/relations, max_depth <- $/max_depth, filter <- $/filter; min_depth = 1, path_policy = simple_relations)`.
  2. `source: core:get_source(trace.subjects -> subjects; source.mode = relevant, include_related_evidence = true)`.
- Outputs: `subjects`, `relations`, and `paths` from `trace`; `sources` from `source`.
- Ranking bindings: none. Guards: none.
- Streams: `subjects.confirmed`, `subjects.possible`, `relations.confirmed`, `relations.possible`, `paths.confirmed`, `paths.possible`, and `sources`.

## `core:find_relevant_tests@1`

Description: return related tests and their fixtures, mocks, helpers, evidence, and source.

- Arguments: `core:FindRelevantTestsArguments@1`; defaults are `relationship_scope = both`, `include_fixtures = true`, `filter` absent.
- Required capabilities: `core:test_relationships`, `core:symbol_resolution`, `core:call_relationships`.
- Stages:
  1. `tests: core:find_related_tests(subjects <- $/subjects, relationship_scope <- $/relationship_scope, include_fixtures <- $/include_fixtures, filter <- $/filter)`.
  2. `source: core:get_source(tests.tests + tests.fixtures + tests.mocks + tests.helpers -> subjects; source.mode = relevant, include_related_evidence = true)`.
- Outputs: `tests`, `fixtures`, `mocks`, `helpers`, and `sources`.
- Ranking bindings: none. Guards: none. Streams: every output/classification pair is independent.

## `core:explain_architecture_slice@1`

Description: return an evidenced architectural slice and the source necessary to understand it.

- Arguments: `core:ExplainArchitectureSliceArguments@1`; defaults are absent `scope`, `views = [entry_points, boundaries, public_surfaces, cycles, extension_points, layers]`, `max_relation_depth = 2`, absent `filter`.
- Required capabilities: `core:symbol_declarations`, `core:module_dependencies`, `core:call_relationships`, `core:framework_semantics`.
- Stages:
  1. `architecture: core:inspect_architecture(scope <- $/scope, views <- $/views, max_relation_depth <- $/max_relation_depth, filter <- $/filter)`.
  2. `source: core:get_source(architecture.all_requested_views -> subjects; source.mode = relevant, include_related_evidence = true)`.
- Outputs: one output retaining each requested view name and `sources`.
- Ranking bindings: none. Guards: none. Streams: each requested view and `sources` paginate independently.

## `core:compare_workspaces@1`

Description: compare two explicitly role-bound immutable workspace snapshots in one frozen execution.

- Arguments: `core:CompareWorkspacesArguments@1`; defaults are absent `selection`, `comparison_kinds = [added, removed, changed, moved, correlated]`, `correlation_policy = strict`, absent `filter`.
- Required capabilities: `core:symbol_declarations`, `core:symbol_resolution`.
- Guards: `core:comparison_roles_base_target` before the first stage.
- Stages: `compare: core:compare(selection <- $/selection, comparison_kinds <- $/comparison_kinds, correlation_policy <- $/correlation_policy, filter <- $/filter)`.
- Outputs: `added`, `removed`, `changed`, `moved`, and `correlated`; outputs not requested in `comparison_kinds` are absent rather than empty.
- Ranking bindings: none.
- Streams: every requested comparison output has independent confirmed/possible streams and retains both participant bindings.

## `core:semantic_to_callers@1`

Description: combine semantic discovery, structural caller traversal, related tests, and source without an agent round trip.

- Arguments: `core:SemanticToCallersArguments@1`; defaults are `query_class = mixed`, `max_call_depth = 2`, absent `filter`.
- Required capabilities: `core:semantic_preparation`, `core:symbol_resolution`, `core:call_relationships`, `core:test_relationships`.
- Stages:
  1. `search: core:search_hybrid(query_text <- $/query_text, query_class <- $/query_class, filter <- $/filter; require_structural_subject = true)`.
  2. `callers: core:expand_relations(search.candidates -> subjects, filter <- $/filter; direction = inbound, relations.universal_kinds = [core:call], min_depth = 1, max_depth <- $/max_call_depth, path_policy = simple_relations)`.
  3. `tests: core:find_related_tests(callers.subjects -> subjects, filter <- $/filter; relationship_scope = both, include_fixtures = false)`.
  4. `source: core:get_source(search.candidates + callers.subjects + tests.tests -> subjects; source.mode = relevant, include_related_evidence = true)`.
- Outputs: `matches`, `callers`, `call_paths`, `tests`, and `sources`.
- Ranking bindings: `search -> core:search_hybrid_default@1`. Guards: none.
- Streams: every named output has independent confirmed/possible streams except unclassified `sources`.

## `core:resolve_and_find_references@1`

Description: resolve a symbol and find all structurally indexed references in one frozen request.

- Arguments: `core:ResolveAndFindReferencesArguments@1`; defaults are `include_declarations = true`, absent `reference_roles`, absent `filter`.
- Required capabilities: `core:symbol_declarations`, `core:symbol_resolution`.
- Stages:
  1. `resolve: core:resolve_symbol(reference <- $/reference, context_artifact <- $/context_artifact, context_byte_offset <- $/context_byte_offset, kind_selector <- $/kind_selector)`.
  2. `references: core:find_references(resolve.declarations -> target, reference_roles <- $/reference_roles, include_declarations <- $/include_declarations, filter <- $/filter)`; the batchable target binding preserves declaration-to-reference provenance.
  3. `source: core:get_source(resolve.declarations + references.references -> subjects; source.mode = relevant, include_related_evidence = true)`.
- Outputs: `declarations`, `candidates`, `references`, `owners`, and `sources`. Possible resolution candidates are never fed to reference lookup.
- Ranking bindings: none.
- Guards: none. Zero confirmed declarations produce exact empty reference/owner sets. Multiple confirmed declarations produce their union with provenance retained.
- Streams: declarations, candidates, references, owners, and sources are independently pageable; evidence-bearing outputs split confirmed and possible classifications.

## `core:definition_to_instances@1`

Description: discover unfamiliar registered record kinds, facets, or languages and enumerate their exact visible record instances without a second agent call.

- Arguments: `core:DefinitionToInstancesArguments@1`; `selector`, `record_categories`, `producer_ids`, and `filter` default absent.
- Required capabilities: none beyond the capabilities reported for the selected record domains.
- Guards: `core:instance_definition_families` after definition discovery.
- Stages:
  1. `definitions: core:discover_definitions(matcher <- $/matcher; selector.definition_types = [record_kind, facet, language], selector.namespaces/plugin_ids/lifecycle_states <- corresponding optional $/selector fields, include_full_definitions = false)`.
  2. `record_selector: bind.record_selector(definitions.definition_set; record_categories <- $/record_categories, producer_ids <- $/producer_ids, filter <- $/filter)`.
  3. `instances: core:find_records(record_selector.selector -> selector)`.
- Outputs: `definitions <- definitions.definitions / definitions`; `instances <- instances.records / subjects`.
- Ranking bindings: none. Definition matching uses the explicit matcher mode and never exposes scores.
- Streams: `definitions` and `instances` are independent bidirectional streams.

`bind.record_selector@1` is a core internal deterministic pipeline operator. It maps every selected `record_kind` definition to `KindSelector.kinds`, every `facet` to `KindSelector.any_facets`, and every `language` to `StructuralFilter.languages`; values within one family combine by OR and the present families combine by AND. It then conjoins the explicit category, producer, and filter fields. It rejects every other definition family, including capability contracts. Capability discovery is answered by index/provider coverage status because capabilities describe production guarantees, not record-instance types.

When definition discovery is empty, `bind.record_selector` emits an exact empty selector-result sentinel and `instances.records` is an exact empty set without invoking an unbounded `core:find_records`. Empty discovery is therefore not an error and cannot accidentally mean “all records.”

## Digest and validation

`IntentRecipeDefinition.recipe_digest` uses `core:intent_recipe_definition_digest` in domain `core:intent_recipe_definition` over every definition field except `recipe_digest`, in declared order. Stage arrays remain topological and caller-significant; capability, ranking, guard, and stream arrays are duplicate-free canonical sets under their registered identifiers.

Activation rejects a recipe whose argument schema is missing, stage graph is cyclic, operator or operation version is unknown, binding path is invalid or overlaps static data, upstream output type is incompatible, capability is unregistered, ranked stage lacks its exact binding, unranked stage has one, guard code is unknown, output is unreachable, stream is duplicated, or digest mismatches. Conformance fixtures execute every recipe with minimal, maximal, empty-result, ambiguous-selector, incomplete-coverage, forward-page, backward-page, expired-cursor, and reduced-continuation-budget cases.
