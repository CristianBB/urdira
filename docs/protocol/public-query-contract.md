# Public Query Contract

Status: **Approved and implemented v3 contract**

Last updated: 2026-09-09

Depends on: [Universal data model](../decisions/01-universal-data-model.md) and [Query algebra and public API](../decisions/03-query-algebra-public-api.md)

## Purpose and schema rules

This file is authoritative for the destructive public API v3 wire contract. v3 carries the supported operation, recipe, pipeline, pagination, completeness, and response guarantees; v1/v2 request aliases and legacy pipeline envelopes are not accepted. The v3 runtime also rejects every pre-v3 or early-preview v3 data root with `core:index_contract_unsupported`: there is no legacy reader or in-place migration, and activation requires a fresh root plus source reindexing. The universal data model owns the shared request and response envelopes. Generated MCP JSON Schemas must reproduce these rules and give every field the descriptions below without adding adapter-only behavior.

All objects are closed. `required` below means the field must be present; `optional` means absence has the documented default or meaning. Arrays are ordered and duplicate-free unless stated otherwise. Identifiers are namespaced strings. Counts, depths, character limits, and milliseconds are non-negative integers bounded by advertised server maxima. An empty optional selector means no restriction; it never means no results unless stated explicitly.

## Shared request values

### Subject selector

`SubjectSelector` is exactly one discriminated variant:

| `subject_type` | Required fields | Meaning |
|---|---|---|
| `entity` | `entity_id`; optional `entity_record_id` | One entity lifecycle, optionally pinned to an exact visible occurrence. |
| `record` | `record_id` | One exact canonical record. |
| `artifact` | exactly one of `artifact_id` or `path`; optional `artifact_version_id` | One exact source artifact address or pinned occurrence. `path` is normalized workspace-relative or a canonical virtual URI. |
| `symbol` | `name`; optional `context_artifact`, `context_byte_offset`, `kind_selector` | A symbol reference resolved under the selected snapshot. Context offset requires context artifact. |
| `stage_output` | `stage_id`, `output` | The complete typed subject set produced by an earlier pipeline stage. |

The first four variants are legal in an operation expression. `stage_output` is legal only in pipeline arguments. When an unpinned lifecycle or path resolves to several visible candidates, the operation returns possible candidates or a selector error according to its contract; it never chooses by database order. A pipeline binding from lexical `core:search_text` to `core:get_source` preserves each matched artifact's `artifact_id` and `artifact_version_id`, so the source stage hydrates the exact pinned artifact occurrence rather than treating it as an ordinary record.

Pipeline final outputs are sealed into the immutable execution manifest through
bounded iterators; the executor does not materialize the complete output as a
JavaScript array before cursor creation. Forward and backward cursor streams
use the same sealed ordering. Completeness is propagated from every stage;
missing provider coverage is reported as `unknown`, and continuations preserve
the signed execution completeness report instead of assuming `complete`.

For coding-agent discovery, a pipeline should normally bind an upstream `subjects` stream into the dependent operation so each artifact or entity is hydrated once. The `matches` stream remains available when each textual occurrence is itself relevant. This is a usage rule, not a relaxation of exactness: stage outputs remain complete typed subject sets under the same snapshot, scope, and completeness rules as direct operations.

### Structural filters

`StructuralFilter` has these optional conjunctive fields:

| Field | Type and default | Exact meaning |
|---|---|---|
| `paths` | array of normalized glob patterns, default all | Artifact paths that may contribute primary subjects. |
| `languages` | language-ID array, default all | Indexed language classifications accepted. Unclassified content is excluded when this is non-empty. |
| `namespaces` | namespace array, default all | Concrete-definition namespaces accepted. |
| `kind_selector` | `KindSelector`, optional | Concrete, universal, and facet constraints from the pinned registry. |
| `subject_types` | subset of `entity`, `record`, `artifact`, default operation set | Legal primary result variants. |
| `include_external` | boolean, default `false` | Whether virtual standard-library and dependency-declaration artifacts may be primary results. Relations may still cite them when false. |
| `include_generated` | boolean, default `false` | Whether policy-classified generated artifacts may be primary results when they were indexed. |

Entries within `paths` are alternatives. `*` matches within one path component;
`**` crosses directory boundaries, and `**/` also matches zero directories.
The same path semantics apply to native paged lexical search and artifact
discovery.

Filters are hard eligibility constraints applied before ordering. They cannot relax workspace inclusion or security policy.

`StructuralFilter` is a closed object. Clients must use the fields listed above;
`filter.include_globs` is not an alias for `filter.paths` and is rejected. MCP
validation errors identify the offending filter path and enumerate the valid
fields so a caller can correct the request without guessing.

### Relation selector

| Field | Presence | Exact meaning |
|---|---|---|
| `relation_kinds` | optional array | Accepted concrete relation kinds; empty accepts all allowed by the operation. |
| `universal_kinds` | optional array | Accepted core universal relation kinds; empty accepts all. |
| `roles` | optional array | Relation argument roles that must connect the traversal endpoints. Each value is validated against selected relation definitions. |
| `evidence_class` | optional `confirmed`, `possible`, or `both`; default `both` | Eligible relation certainty. `confirmed` never promotes possible evidence. |
| `possible_confidence` | optional subset of `high`, `medium`, `low`; default all | Eligible possible confidence tiers; ignored for confirmed relations. |

Concrete and universal kind fields are conjunctive when both are non-empty.

### Registry selector

| Field | Presence | Exact meaning |
|---|---|---|
| `definition_types` | optional array | Accepted families from `language`, `capability_contract`, `construct_class`, `capability_limitation`, `record_kind`, `facet`, `semantic_role`, `metric`, `effect`, `diagnostic_code`, `candidate_issue_code`, `dependency_role`, `projection_kind`, `lifecycle_reason`, `completeness_reason`, `semantic_section_kind`, `semantic_reason`, `evidence_assumption`, and `evidence_explanation`. Empty selects every agent-queryable family. |
| `namespaces` | optional array | Accepted namespaces. Empty searches the complete pinned registry. |
| `plugin_ids` | optional array | Accepted owners. Empty includes core, shared definitions, and every active plugin. A non-empty owner filter matches shared languages when at least one retained `LanguageDefinitionSupply` has that supplier. |
| `lifecycle_states` | optional subset of `active`, `deprecated`, `retired`; default `active` | Definition lifecycle states to return. Retired definitions remain discoverable only when explicitly selected. |

Administrative canonical-encoding and digest registries are not agent-queryable through this selector.

## Stable operation arguments

### `core:discover_definitions`

| Field | Presence | Exact meaning |
|---|---|---|
| `matcher` | required `DefinitionMatcher` | Exact, lexical, semantic, or hybrid definition discovery input. |
| `selector` | optional `RegistrySelector` | Hard definition-family, namespace, owner, and lifecycle filters. |
| `include_full_definitions` | optional boolean, default `false` | Returns concise definition views when false and complete agent-queryable definitions when true; large sets paginate. |

Outputs are `definitions` and `definition_set`. Match explanations identify match class and lexical terms but expose no score.

### `core:find_records`

The argument object is exactly `FindRecordsArguments { selector }`, where `selector` is `RecordStructuralSelector`:

| Field | Presence | Exact meaning |
|---|---|---|
| `record_categories` | optional non-empty subset of `entity`, `relation`, `fact`, `evidence`, `diagnostic` | Accepted canonical record categories; values combine by OR. |
| `kind_selector` | optional `KindSelector` | Accepted concrete kinds, universal kinds, and facets under its existing conjunctive rules. |
| `producer_ids` | optional non-empty identifier array | Exact plugin or core producers; values combine by OR. |
| `filter` | optional `StructuralFilter` | Hard path, language, namespace, kind/facet, subject-type, external, and generated constraints. |

At least one field must be present; present empty arrays are invalid. Different fields combine by AND. If both kind-selector locations are present, they also combine by AND. The operation enumerates all visible canonical records in the pinned snapshots that satisfy the selector. It performs no lexical or semantic matching and accepts no ranking, score, limit, approximate, capability, or definition-family field.

Output `records` is ordered by workspace participant ordinal, owner artifact normalized URI, primary source-span start and end byte with absent spans last, record category, concrete kind, and `record_id`. Membership is exact over the published index. The ordinary completeness report still states whether analyzers had complete source-level coverage for the selected record domains. Paging changes hydration only and never truncates the logical manifest.

### `core:find_artifacts`

The argument object is `FindArtifactsArguments { filter? }`. It returns every
visible source artifact subject in the explicit workspace snapshot, ordered by
normalized path (or URI), artifact identity, and artifact-version identity.
`StructuralFilter.paths` uses normalized glob patterns; `languages`,
`include_external`, and `include_generated` are hard eligibility filters.
Results are immutable and cursor-paginated through the existing `artifacts`
stream. This operation is query-contract-only and does not add an MCP tool.

### `core:resolve_symbol`

| Field | Presence | Exact meaning |
|---|---|---|
| `reference` | required non-empty string | Identifier, qualified name, or language-neutral symbol spelling to resolve. |
| `context_artifact` | optional artifact ID or path | Lexical/module context. Required with `context_byte_offset`. |
| `context_byte_offset` | optional non-negative integer | Exact UTF-8 byte position at which visibility and shadowing are evaluated. |
| `kind_selector` | optional | Hard target kind/facet constraint. |
| `resolution_scope` | optional `visible`, `workspace`, or `exports`; default `visible` when `context_artifact` is given, otherwise `workspace` | `visible` prefers declarations reachable from `context_artifact` (same-artifact, falling back to the full candidate set when nothing in-artifact matches), `workspace` finds declarations anywhere, and `exports` selects public/exported declarations where exportedness is recorded (otherwise falls back to `workspace`, documented). A bare-name lookup with neither `resolution_scope` nor `context_artifact` searches the whole workspace, not an empty "visible with no context" set. |

Outputs are `declarations` and `candidates`. Unique compiler-resolved declarations are confirmed; lexical/global alternatives are possible unless independently proven.

### `core:get_outline`

| Field | Presence | Exact meaning |
|---|---|---|
| `container` | required artifact, entity, or record `SubjectSelector` | Artifact or semantic container whose direct contents are listed. |
| `depth` | optional positive integer, default `1` | Maximum containment depth; exact within that depth. |
| `include_non_public` | optional boolean, default `true` | Whether private/local declarations are eligible. |
| `filter` | optional `StructuralFilter` | Hard output constraints. |

Output `members` orders by source span, containment depth, and canonical subject key.

Output `pending_sites` (additive, `unclassified`; 2026-09-04) lists every visible unresolved call/heritage site the v4 native structural store's `pending.sites` table still owns for `container`'s artifact -- the capability `core:find_records`' `possible` rows and `jsts:unresolved_call` diagnostics used to expose before both were folded into that table (see `docs/evidence/2026-09-04-v4-pending-sites-fold-and-member-entities.md` §1-§2, §8). When `container` resolves to a module/artifact container entity, every visible pending site of that artifact is included; for any other entity, only sites whose resolved enclosing declaration (`source_id`) is `container` itself or one of the `members` this same call returns -- NOT a byte-span containment test against `container`'s own `primary_source_span`, which now covers its full declaration body. Membership still follows enclosing-declaration identity, not incidental span containment. Each item is `{path, start, end, site_kind, reason, source_id, stable_sort_key}`: `site_kind` is `"call" | "inherits" | "implements"`; `reason` is the `PendingReasonCode` name (source of truth: `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`); `source_id` is the enclosing entity's identity key, or `null` when it does not resolve (such a site is therefore only ever visible at the module level, never narrowed to a specific member). A workspace backed by the v3 (SQLite-only) store has no `pending.sites` table and always returns an empty `pending_sites` stream, never an error.

### `core:find_references`

| Field | Presence | Exact meaning |
|---|---|---|
| `target` | required entity, record, or symbol selector | Declaration or semantic target being referenced. |
| `reference_roles` | optional role array | Accepted registered reference roles; empty accepts every reference role supported by the selected kinds. |
| `include_declarations` | optional boolean, default `false` | Whether defining occurrences are included beside uses. |
| `filter` | optional `StructuralFilter` | Hard source/result constraints. |

Outputs are `references` and `owners`. The operation reports symbol-resolution completeness separately from pagination.

For `expand.operation`, v3 pipeline bindings, and immutable recipes, `target` is a declared batchable field: a non-empty confirmed subject set is evaluated as one globally planned union, with target-to-reference provenance retained and deduplication by exact record identity. The direct operation expression still accepts exactly one `SubjectSelector`. An empty upstream set returns exact empty outputs without widening scope.

### `core:expand_relations`

| Field | Presence | Exact meaning |
|---|---|---|
| `subjects` | required non-empty subject selector array or stage output | Starting subjects. |
| `direction` | required `inbound`, `outbound`, or `both` | Direction relative to each starting subject and selected relation roles. |
| `relations` | required `RelationSelector` | Exact traversable relation semantics. |
| `min_depth` | optional positive integer, default `1` | First depth emitted. |
| `max_depth` | optional positive integer, default `1` | Last depth emitted; must be at least `min_depth`. |
| `path_policy` | optional `simple_subjects` or `simple_relations`; default `simple_subjects` | Cycle prevention rule for each emitted path. |
| `filter` | optional `StructuralFilter` | Hard eligible endpoint constraints; traversal-through behavior remains operation-defined and is not inferred from the filter. |

Outputs are `subjects`, `relations`, and `paths`. Every path retains exact relation records and argument roles.

### `core:find_paths`

| Field | Presence | Exact meaning |
|---|---|---|
| `sources` | required non-empty subject selector array or stage output | Path origins. |
| `targets` | required non-empty subject selector array or stage output | Path destinations. |
| `direction` | optional `outbound`, `inbound`, or `both`; default `outbound` | Traversal direction from sources. |
| `relations` | required `RelationSelector` | Exact traversable relation semantics. |
| `max_depth` | required positive integer | Maximum accepted path length. |
| `all_shortest` | optional boolean, default `true` | Return every shortest path when true, otherwise the canonical first shortest path per source-target pair. |

Output `paths` is exhaustive under the declared maximum and policy or the operation fails its exact work limit.

### `core:search_text`

| Field | Presence | Exact meaning |
|---|---|---|
| `pattern` | required non-empty string | Literal bytes after UTF-8 decoding or a safe-regex expression. |
| `syntax` | optional `literal` or `safe_regex`; default `literal` | Matching dialect. |
| `case_sensitive` | optional boolean, default `true` | Exact case behavior; false uses the pinned Unicode case-folding contract. |
| `word_mode` | optional `substring`, `identifier`, or `token`; default `substring` | Boundary contract for literal matches. Regex always uses its own explicit boundaries. |
| `filter` | optional `StructuralFilter` | Hard searched scope and primary result constraints. |
| `result_projection` | optional `match`, `artifact`, `record`, or `entity`; default `match` | Primary subject normalization. Ambiguous entity ownership remains a match/artifact result. |
| `subjects` | optional non-empty subject selector array or stage output | Restricts lexical matching to an earlier source-safe pipeline result, enabling `find_artifacts → search_text → get_source` without structural readiness. |

Outputs are `matches` and `subjects`. Every match contains exact artifact version and byte span.
For literal searches, path constraints and the normalized `include_generated`/`include_external` flags remain on the exact lexical source projection. While asynchronous lexical maintenance is not current, execution scans the pinned source catalog/CAS exactly; neither an incomplete lexical marker nor explicit default-false flags may widen execution into a decoded structural-corpus scan.

### `core:search_semantic` and `core:search_hybrid`

| Field | Presence | Exact meaning |
|---|---|---|
| `query_text` | required non-empty bounded string | Concept, identifier, code, or mixed search input. |
| `query_class` | required `natural_text`, `identifier`, `source_code`, or `mixed` | Structural input class used for profile compatibility; never inferred as human language. |
| `filter` | optional `StructuralFilter` | Hard searched scope and primary result constraints. |
| `require_structural_subject` | optional boolean, default `false` | Excludes artifact-only matches when true; it does not turn semantic evidence into proof. |

Output is `candidates` plus mandatory semantic coverage views. Hybrid additionally uses the exact lexical lanes defined by its ranking profile. Neither operation accepts profile IDs, scores, weights, top-k truncation, or approximate mode; all results are represented in persistent pageable order.

### `core:semantic_affected_page`

| Field | Presence | Exact meaning |
|---|---|---|
| `affected_artifact_set_id` | required identifier | The coverage view's `affected_artifact_set_id`, naming one fixed set of documents a semantic materialization pass has not yet covered. |
| `cursor` | optional | Continuation token for an earlier page of the same set. |
| `limit` | optional non-negative integer | Page size bound. |

Output is a single `semantic_affected_artifacts` stream of `SemanticAffectedArtifactPage` items (result label `affected_page`, evidence class `unclassified`), required frontier `semantic`. When `affected_artifact_set_id` or its cursor no longer names the workspace's current affected-document set, the operation returns `core:affected_set_stale` (see [core operation error codes](core-operation-error-codes.md)) naming the `current_set_id` instead of serving a mixed or partial page.

### `core:get_source`

| Field | Presence | Exact meaning |
|---|---|---|
| `subjects` | required non-empty subject selector array or stage output | Exact subjects whose source is requested. |
| `source` | required `SourceIncludeOptions` with mode other than `none` | Requested signature, relevant region, or body projection and budgets. |
| `include_related_evidence` | optional boolean, default `false` | Adds source references for hydrated evidence without widening primary subjects. |

Output `sources` contains pinned `SourceReferenceView` values and policy-permitted `SourceSnippet` values.

### `core:analyze_impact`

| Field | Presence | Exact meaning |
|---|---|---|
| `target` | required entity, record, artifact, or symbol selector | Existing element whose hypothetical change is analyzed. |
| `change` | required `ChangeDescriptor` | One closed hypothetical change variant below. |
| `include_transitive` | optional boolean, default `true` | Whether operation-defined transitive dependants are analyzed. |
| `include_tests` | optional boolean, default `true` | Whether related tests and test gaps are returned. |
| `filter` | optional `StructuralFilter` | Hard affected-result scope; it cannot hide completeness outside the filtered declared domain. |

`ChangeDescriptor.change_type` is one of:

| Variant | Additional required fields | Optional fields |
|---|---|---|
| `delete` | none | none |
| `rename` | `new_name` | none |
| `move` | `new_artifact_path` | `new_container` |
| `signature` | `new_signature` | `compatibility_assumptions[]` |
| `type` | `new_type` | `compatibility_assumptions[]` |
| `visibility` | `new_visibility` | none |
| `contract` | `contract_change_code`, `new_contract` | `compatibility_assumptions[]` |
| `behavior` | `behavior_change_code`, `description` | `affected_effects[]` |

All values are bounded declarative text or registered codes. They are parsed by the operation contract and never written to the index. Outputs are `will_break`, `must_update`, `may_be_affected`, `tests_to_run`, and `uncertain_dynamic_usage`.

### `core:find_related_tests`

| Field | Presence | Exact meaning |
|---|---|---|
| `subjects` | required non-empty subject selector array or stage output | Code or artifact subjects under test. |
| `relationship_scope` | optional `direct`, `transitive`, or `both`; default `both` | Which registered test relations and impact paths are eligible. |
| `include_fixtures` | optional boolean, default `true` | Whether fixture, mock, and helper subjects are returned in separate output sets. |
| `filter` | optional `StructuralFilter` | Hard test-artifact and result constraints. |

Outputs are `tests`, `fixtures`, `mocks`, and `helpers`, each independently classified.

### `core:inspect_architecture`

| Field | Presence | Exact meaning |
|---|---|---|
| `scope` | optional non-empty subject selector array | Roots of the architectural slice; absence selects the complete workspace query scope. |
| `views` | required non-empty subset of `entry_points`, `boundaries`, `public_surfaces`, `cycles`, `extension_points`, `layers` | Architectural projections requested. |
| `max_relation_depth` | optional positive integer, default `5` | Structural reach considered for slice membership. |
| `filter` | optional `StructuralFilter` | Hard result constraints. |

Each requested view is a separate typed output with its evidence and completeness.

### `core:compare`

This operation requires `ComparisonScope` with exactly `base` and `target` participants.

| Field | Presence | Exact meaning |
|---|---|---|
| `selection` | optional non-empty subject selector array | Elements correlated across participants; absence compares the complete filtered scopes. Stage outputs must identify their participant. |
| `comparison_kinds` | required non-empty subset of `added`, `removed`, `changed`, `moved`, `correlated` | Difference classes returned. |
| `correlation_policy` | optional `strict` or `include_possible`; default `strict` | Whether portable-key or structural possible correlations are returned beside exact correlations. |
| `filter` | optional `StructuralFilter` | Applied independently to both participants before correlation. |

Outputs preserve both participant-bound subjects. Correlations never become canonical cross-workspace identities.

### `core:build_context`

| Field | Presence | Exact meaning |
|---|---|---|
| `task` | required non-empty bounded string | Coding task whose relevant repository context is selected. |
| `query_class` | optional `natural_text`, `identifier`, `source_code`, or `mixed`; default `natural_text` | Typed semantic input class. |
| `seeds` | optional subject selector array | Known targets; empty permits hybrid discovery from `task`. |
| `facets` | required non-empty subset of `definitions`, `implementations`, `callers`, `callees`, `dependencies`, `contracts`, `effects`, `tests`, `configuration`, `analogues`, `extension_points` | Context categories requested. |
| `filter` | optional `StructuralFilter` | Hard context scope. |

Output `context` is a deduplicated ordered set of result bundles. When `tests` is requested, the indexed `core:contains`/`core:covers` projection expands the resolved seeds and subjects. The same indexed graph is also used for a bounded inbound `core:call` step; callers' covering tests are unioned with direct covering tests, preserving their evidence even when direct coverage exists. Exact identifier matches in test-shaped source artifacts supplement absent graph relationships as possible evidence. Each supplement retains its artifact version and exact match span, and hydration centers on that span; confirmed structural tests keep their classification and membership. The expansion honors the supplied structural filters and the operation's advertised work limits. If the graph projection is unavailable, the operation returns the typed `core:required_capability_unsupported` error rather than silently omitting the facet. Response and source budgets control hydration only; operation work limits are server-advertised and exact failure replaces truncation of logical membership.

When an exact lexical test match lies inside an indexed executable entity,
hydration uses the smallest containing function, method, constructor, callable,
declaration, definition, or test record. Executable recognition uses the
language-neutral universal kind as well as plugin descriptions. If no such
record exists, hydration remains centered on the exact match with the requested
context lines. This supplies a usable test body without widening membership to
the entire test artifact.

Structural context facets use the shared indexed selector and adjacency ports.
Definitions follow outbound `core:defines`; implementations follow inbound
`core:implements` and `core:overrides`; callers/callees follow inbound/outbound
`core:call`; dependencies follow outbound `core:import` and `core:depends_on`;
contracts follow outbound `core:implements` and `core:type_of`; effects follow
outbound `core:read`, `core:write`, and `core:throws`; configuration follows
`core:binds` in both directions; extension points follow outbound `core:inherits`
and `core:implements`. These are direct structural neighborhoods, not a claim
that all conceptual relevance has been discovered. Every selected endpoint
retains its relation-record provenance and possible classifications. Missing
indexed capabilities fail explicitly. Analogues require semantic retrieval;
the structural-only context path rejects that facet explicitly.

Context source projection is persisted as an internal manifest hydration
request over the original artifact versions. It is hydrated for each page
using normalized `options.snippets`, never a separate operation-wide source
allowance. Exhausting a page's source allowance advances through a cursor;
source unavailable errors are not converted to successful missing snippets.

For deterministic first-page usefulness, context ordering prioritizes explicit seeds, then declaration/definition/type/callable records when `definitions` is requested, then records obtained through the indexed `tests` facet, followed by other resolved subjects. Ties retain the indexed resolution order; this changes presentation only and does not change membership or completeness.

Without a configured semantic lane, task discovery is conservative and bounded. When explicit `seeds` are present, they alone define the context roots; identifier-shaped terms in `task` contribute deterministic ordering but do not add roots. Without explicit seeds, identifier-shaped task terms are resolved through exact indexed subject lookups. A task with no resolvable seed fails with `core:selector_unresolvable`; it must explain that structural task discovery could not identify a seed and recommend an exact symbol/path seed or `core:search_text`. It must not imply that the index contains no relevant source or widen into a complete-corpus scan. Returned subjects can be expanded with the ordinary structural operations. This keeps absence of relevance ranking explicit and prevents a precise request from expanding through common incidental member names across a large workspace.

An unanchored symbol seed in `core:build_context` retains every exact indexed declaration because broad context may need authored and generated forms together. Deterministic context ordering selects the useful lead without discarding the other declarations. Point operations that require one subject continue to report `core:selector_ambiguous`; `context_artifact` remains available when the caller explicitly needs one declaration.

### `core:index_status`

| Field | Presence | Exact meaning |
|---|---|---|
| `include_capabilities` | optional boolean, default `true` | Include compact active capability and completeness summaries. |
| `include_plugins` | optional boolean, default `true` | Include active resolution lock and plugin summaries. |
| `include_activation_issues` | optional boolean, default `false` | Include the first budgeted page of latest activation issues. |
| `include_candidate_issues` | optional boolean, default `false` | Include the first budgeted page of current candidate issues. |

Index Status API v3 adds derived `source_ready`, `structural_ready`, and
`semantic_ready` booleans plus per-layer availability, completeness, freshness,
and build-state fields. `source_ready` means that a source index is available;
it does not by itself claim current or complete coverage. `structural_ready`
means complete structural facts based on the current source snapshot;
`semantic_ready` means complete semantic materialized against the current
structural snapshot. `partial` is queryable partial data;
`unknown` is not queryable. `operation_availability` lists source-safe
operations and blocked structural operations with a required layer, reason
code, retryability, and optional retry delay. Only API v3 is accepted on the
public wire; older persisted snapshots are a storage concern and never change
the request schema.

For a v4 workspace, the response additionally includes `last_scan`: the
most recent scan's `kind` (`full`, `changed`, or `reconcile`), its
`changed_paths` when applicable, `timings`, and, only when `kind` is
`reconcile`, a `reconcile` object (`mode`, `added`/`changed`/`deleted`,
`frontier_size`, `threshold`, `fell_back_to_cold`) and, only when that
reconcile followed a `core:index_pack_export` import, an `import` object. A
v3 workspace never sets `last_scan`.

Inside `QueryRequest`, this operation uses the mandatory explicit query scope. Global workspace discovery is available only through the dedicated `urdira_index_status` MCP/CLI wrapper below, whose unscoped response additionally reports `orphaned_workspace_data` (`count`, `bytes`) from the daemon's startup orphan sweep (see the [workspace administration contract](workspace-administration-contract.md)). Both return safe display roots, never private storage/package paths.

## Pipeline operator arguments

`source.operation` has required `operation` and required closed `operation_arguments`; its outputs are the selected operation's typed outputs. `source.registry` has required `matcher`, optional `selector`, and optional `include_full_definitions` with the same semantics as `core:discover_definitions`.

`set.union`, `set.intersection`, and `set.difference` accept two or more compatible input references for union/intersection and exactly two for difference. Their arguments object is empty. They compare normalized `ResultSubject` identity.

`expand.relations` uses the `core:expand_relations` fields except `subjects`, which comes from exactly one input. `expand.operation` has required `operation`, required `input_argument` naming the operation field bound to the complete upstream set, and required `operation_arguments` containing every other field. The selected operation must declare that field batchable.

`filter` accepts one input and one required `predicate`. A predicate is exactly one of:

- `all` or `any`, with a non-empty bounded array of child predicates;
- `not`, with one child predicate;
- `path`, `language`, `namespace`, `subject_type`, `kind`, `facet`, `evidence_class`, `confidence`, `completeness`, or `participant_role`, with an operator-specific non-empty value set.

Recursion depth is server-bounded. Predicate values use the same exact registry and scope semantics as shared structural filters. Filtering cannot change evidence classification or page-level completeness.

`join` accepts exactly two inputs and required `predicate` equal to `same_subject`, `same_entity`, `same_artifact`, `portable_key_equal`, or `relation_exists`. `relation_exists` additionally requires a `RelationSelector` and direction. Required `output` is `pairs`, `left`, `right`, or `grouped`; duplicate multiplicity follows canonical subject identity.

`deduplicate` accepts one or more inputs and required `identity` equal to `subject`, `entity`, `artifact`, or `portable_key`. `portable_key` additionally requires `include_possible: true` because it is correlation rather than identity. Provenance and evidence from removed duplicates are accumulated.

`bind.record_selector` accepts exactly one registry definition-set input. It maps record-kind IDs to `KindSelector.kinds`, facet IDs to `KindSelector.any_facets`, and language IDs to `StructuralFilter.languages`; values within a family combine by OR and present families combine by AND. Its optional static `record_categories`, `producer_ids`, and `filter` fields are conjoined. An empty input produces an exact empty-result sentinel; any other definition family is rejected with `core:invalid_definition_instance_selector`. The operator is not accepted in caller-authored `PipelineExpression` under API v3; only an immutable advertised core recipe may contain it.

`bind.subject_record_selector` accepts one visible record/entity subject set, hydrates each exact selected record descriptor, and constructs `RecordStructuralSelector.kind_selector.kinds` from the duplicate-free concrete kind set plus `filter.languages` from the duplicate-free owner-language set. Kinds combine by OR, languages combine by OR, and the two dimensions combine by AND. An optional explicit structural filter is conjoined. Empty input produces an exact empty-result sentinel. The downstream membership returned by `core:find_records` is exact for that derived selector, while result assessment preserves possible relevance from any semantic upstream stage; this operator never promotes evidence. It is core-recipe-only in API v3.

`select` accepts one or more inputs and required non-empty `outputs`. Each output supplies unique `name`, input reference, result projection (`subjects`, `relations`, `paths`, `definitions`, or the exact upstream operation output), and optional `StructuralFilter`. It cannot request fields forbidden by the public result models.

No operator accepts arbitrary ranking, score, profile, SQL, graph query, script, command, plugin callback, or physical planner fields.

## MCP wrapper schemas

`urdira_query` accepts exactly one of `query` (`QueryRequest`) or `continuation` (`ContinuationRequest`). For an initial request, `scope` is inside `query` alongside `api_version` and `expression`, never beside `query`. The discriminator is `request_type = query | continuation`. Its public wrapper value is exactly one of `page` (`QueryResultPage`) or `error` (`OperationError`). The MCP adapter returns that wrapper as the single `content[0].text` block (compact plain text by default, or complete JSON for the undocumented debug renderer); source bundles preserve every snippet line admitted by the query's explicit per-snippet, total-snippet, and serialized-response budgets and are not subject to a second renderer-only line cap. The adapter does not emit `structuredContent` because the tools intentionally declare no `outputSchema`. A page is a successful tool result; an `OperationError` is an `isError: true` tool result, not a JSON-RPC protocol error.

Compact agent rendering emits a complete executable `ContinuationRequest` in
`MORE`; clients copy it literally and never reconstruct it. It contains exactly
one of `cursor` or `continuation_ref`. The compact server-local form is:

```json
{"request_type":"continuation","continuation":{"api_version":3,"continuation_ref":"<continuation_ref>"}}
```

The server retains the complete cursor and binds the reference to the original
scope, response budget, and expiry in a bounded, server-local TTL store. The
reference has an authenticated random identifier and is checked with a
constant-time signature comparison; it is never a portable replacement for
the cursor. A continuation must provide exactly one of `cursor` or
`continuation_ref`; unknown, expired, tampered, or scope/budget-mismatched
portable requests fail closed as typed request errors with recovery to the complete
portable cursor. References do not survive a server restart. The full cursor
remains available in structured output for clients that require portability or
restart.

Impact analysis uses the ordinary `urdira_query` operation envelope with
`operation: "core:analyze_impact"`; its required and optional arguments remain
those of the registered operation. Task context uses `urdira_context` or the
ordinary `urdira_query` operation envelope with
`operation: "core:build_context"`. When `urdira_context` omits
`options.freshness`, it requests `mode: "wait"`,
`required_frontier: "structural"`, and a bounded 30-second timeout; an explicit
freshness policy remains authoritative. Its public source defaults are
`mode: "relevant"`, 6,000 characters per snippet, 30,000 source characters,
and 20 surrounding lines, with a 40,000-character response page. These are
replaceable client defaults, not completeness limits: an explicit source
projection or `response_budget` remains authoritative, and remaining results
stay available through continuation.

`urdira_index_status` defaults to API v3. The MCP initial form accepts an exact
`workspace_root`; it returns layered
readiness and may report source-ready while structural analysis is still
building. Root matching is exact after provider canonicalization; the response
returns the resolved opaque `workspace_id` and a copy-ready `query_scope`
object, and never repeats the absolute root. Clients reuse `query_scope`
byte-for-byte rather than retyping or synthesizing its identifier. An
unregistered root returns `core:workspace_not_registered` with
`registration_command: "urdira workspace add <workspace-root>"`.
Configuration issues are an independently paginated status stream.

API v3 may bind a source-safe operation to
`scope.snapshot_id = source-snapshot:<generation>`. This binding is accepted
only for `core:find_artifacts`, source-projection `core:search_text`, and
artifact-selector `core:get_source`; structural pipelines and recipes remain
bound to structural snapshots.

Every wrapper field has the same meaning as its operation counterpart. Wrappers cannot change defaults, completeness, ordering, ranking, or cursor behavior.

The complete mapping between these public wrappers and MCP `2026-07-28` `tools/call` results is defined by the [MCP adapter contract](mcp-adapter-contract.md). MCP catalog pagination for `tools/list` is separate from Urdira result pagination and never accepts or returns a `ContinuationRequest` token.

## Recipe argument defaults

[Core intent recipes](core-intent-recipes.md) documents every `core:*Arguments@1` schema and its stages. As that file's `Registry rules` states, "public omission of a documented default is normalized before recipe hashing" -- a field a recipe documents with a default is `optional` in its inline argument schema, never `required`, so a `expression_type: "recipe"` call may omit it entirely. The default is injected by query-plan normalization before canonicalization, exactly like `core:resolve_symbol`'s `resolution_scope` default above: it is explicit in `normalized_expression` and therefore in `plan_digest`, never an implicit runtime fallback a caller replaying the same digest could not observe. An explicit value -- even one equal to the default -- always takes precedence over the injected default.

| Recipe | Field | Default when omitted |
|---|---|---|
| `core:locate_implementation` | `query_class` | `mixed` |
| `core:understand_change_impact` | `include_transitive` | `true` |
| `core:understand_change_impact` | `include_tests` | `true` |
| `core:prepare_new_feature` | `query_class` | `mixed` |
| `core:trace_behavior` | `direction` | `outbound` |
| `core:trace_behavior` | `relations` | `{ universal_kinds: [core:call] }` |
| `core:trace_behavior` | `max_depth` | `3` |
| `core:find_relevant_tests` | `relationship_scope` | `both` |
| `core:find_relevant_tests` | `include_fixtures` | `true` |
| `core:explain_architecture_slice` | `views` | `[entry_points, boundaries, public_surfaces, cycles, extension_points, layers]` |
| `core:explain_architecture_slice` | `max_relation_depth` | `2` |
| `core:compare_workspaces` | `comparison_kinds` | `[added, removed, changed, moved, correlated]` |
| `core:compare_workspaces` | `correlation_policy` | `strict` |
| `core:semantic_to_callers` | `query_class` | `mixed` |
| `core:semantic_to_callers` | `max_call_depth` | `2` |
| `core:resolve_and_find_references` | `include_declarations` | `true` |

Every other recipe argument stays required because it has no server-inferrable default: `reference` (`core:resolve_and_find_references`, `core:prepare_symbol_change`), `change` (`core:understand_change_impact`, `core:prepare_symbol_change`), `target` (`core:understand_change_impact`), `query_text` (`core:locate_implementation`, `core:semantic_to_callers`), `task` (`core:prepare_new_feature`), `subjects` (`core:trace_behavior`, `core:find_relevant_tests`), and `matcher` (`core:definition_to_instances`).

## Conformance

The generated JSON Schema corpus contains one valid minimal, valid maximal, and invalid interaction example for every operation, change variant, shared selector, pipeline operator, MCP wrapper, response stream, and continuation. Schema validation and logical normalization must produce identical accepted values in the MCP adapter, CLI, daemon, and canonical query-plan encoder.

## API v3 binding-oriented pipelines

Version 3 accepts a closed stage form with `stage_id`, `stage_type`, an
operation or algebra operator, static `arguments`, and explicit `bindings` to
earlier stage outputs. Bindings are typed references to complete upstream
streams; they are not expanded into a JSON array before execution. The server
validates and topologically orders the dependency DAG before starting an
expensive stage, rejects ambiguous non-batchable scalar cardinality, and preserves one
immutable snapshot across the chain. Independent branches may run in
parallel. The response contains results, provenance, completeness, freshness
and a continuation; a continuation only pages the already-produced manifest.
The canonical data port receives the sealed handle for each binding and may
consume it as a bounded iterator; adapters that only implement the legacy
operation port are isolated behind an explicit compatibility materialisation
boundary and cannot change the v3 wire semantics.


## Current implementation notes: paging and status

The query engine pages its immutable manifest by both item count and cumulative
serialized item characters. A multi-stream first response shares the character
allowance across streams. The daemon reduces effective query and continuation
allowances to at most half its configured IPC frame size; callers continue the
returned cursors for remaining items instead of requesting a larger transport
frame.

The manifest paginator admits the first item of each page internally so that a
continuation can attempt progress. Before an MCP page is returned, the adapter
measures its complete rendered envelope and rereads a smaller prefix of the
same immutable execution when necessary. This presentation fitting never
changes scope, snapshot, ordering, source projection, logical membership or the
client-selected budget. If one indivisible projected unit cannot fit, the call
returns `core:snippet_budget_impossible` with the measured minimum and recovery
guidance. No structured result or source content is silently omitted.

`core:index_status` is served by the top-level status RPC / `urdira_index_status`
MCP tool. The subject-producing query evaluator rejects it with
`core:non_subject_operation`; advertising its status model does not make it a
valid subject stage in a query pipeline or recipe.
