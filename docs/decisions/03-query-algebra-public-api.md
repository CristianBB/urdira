# Query Algebra and Public API

Status: **Approved**  
Last updated: 2026-08-08  
Depends on: Universal data model and capability contract

## Decision objective

Define stable agent-oriented operations, composed-query semantics, uniform responses, evidence paths, pagination, and transport-neutral API contracts.

## Existing constraints

- One agent question should normally require one Urdira call.
- The API supports individual operations, declarative pipelines, and versioned intent recipes.
- Language and framework plugins contribute queryable data and registered semantics only. They cannot add or override query operators, recipes, ranking profiles, feature weights, ordering rules, pagination behavior, or response schemas; all such behavior belongs to the core query engine.
- Every source query carries explicit workspace scope: a single-workspace request includes `workspaceId`, while a comparison enumerates every participant workspace in the request. No workspace is inferred from the MCP connection.
- Source snippets are optional and budgeted.
- Results distinguish proven structure from heuristic or semantic inference.
- Public operations evaluate their declared logical candidate domain exactly. They expose coverage gaps through completeness and never silently substitute approximate, sampled, or bounded best-effort retrieval.
- Results expose independent `confirmed` and `possible` streams with independent totals and cursors.
- Possible results use only the ordered confidence levels `high`, `medium`, and `low`; confirmed results have no confidence value.
- Completeness is evaluated for the full snapshot-pinned execution and is independent of pagination and result certainty.
- Evidence defaults to a bounded summary and supports cursor-based expansion without rerunning the parent query.
- Diagnostics default to the query-relevant set, retain aggregate counts when item details are omitted, and support snapshot-pinned pagination.
- Source-owned `DiagnosticRecord` values are distinct from structured `OperationError` protocol failures.
- Pagination is persistent, bidirectional, snapshot-pinned, and bounded by response size.
- MCP exposes a small, clear tool surface.
- Every agent-visible JSON Schema field has a concise description covering meaning, presence rules, allowed values, defaults, limits, units or ordering, interactions, and pagination behavior when applicable.
- Kind selectors support concrete kinds, universal kinds, and all/any/excluded facet logic with deterministic validation.
- Responses include deduplicated definitions for every registry entry used by the current page by default; full registry expansion is explicitly selectable and paginated.
- Every execution and continuation page repeats the immutable registry and code snapshot selected for each participating workspace binding.
- The normalized execution contains one immutable `WorkspaceSnapshotBinding` per participant. Each binding pins its snapshot, registry, resolution lock, configuration revision, freshness checkpoint, and retention lease; comparison acquisition is atomic.
- The pinned registry is a composable query source: an agent can discover every agent-queryable semantic, diagnostic, derivation, and evidence definition across all namespaces and feed its typed identifiers into later stages in the same request. Low-level canonical encoding contracts use separate administrative/schema introspection.
- Namespace and plugin-owner filters are optional. Omitting them searches the complete pinned registry, so an agent never needs prior knowledge of installed plugins.
- Definition discovery supports deterministic exact or lexical matching and explicitly selected semantic or hybrid discovery. Semantic definition matches are candidates, not structural proof, and pin the model version.
- An inline definition matcher is required as concise syntax for simple one-operation queries; namespace enumeration remains optional and paginated.
- MCP intelligence operations cannot install, resolve, activate, upgrade, downgrade, or select inactive plugins. Every query uses the already published resolution lock for its explicit workspace.
- `urdira_index_status` exposes the active registry snapshot and resolution lock, concise negotiated plugin and capability summaries, and the state of the latest activation attempt.
- Compatibility issues and detailed plugin state are optional, response-budgeted, and cursor-paginated; package paths, sensitive configuration, and unbounded logs are never exposed.

## Approved decisions

- Every execution normalizes scope into one or more immutable `WorkspaceSnapshotBinding` values.
- Single-workspace execution contains exactly one binding; explicit comparisons contain at least two and acquire every participant lease atomically.
- Each binding pins snapshot, generation, registry, plugin resolution, analysis configuration, freshness checkpoint, and retention lease.
- Every continuation supplies the original explicit workspace scope and preserves the complete binding set, completeness report, and result ordering.
- Primary result subjects are typed as entities, canonical records, or exact source artifacts rather than forcing physical files into entity records.
- Every semantic retrieval lane pins one `EmbeddingProfile`, generator lock, query vector, and `SemanticIndexMaterialization` per participating workspace binding. Different vector spaces remain separate lanes.
- Normal semantic and hybrid requests contain no embedding-profile selector. The core selects every active profile compatible with the pinned scope and typed query class; installed inactive profiles are ignored. The resulting complete lane set is fixed in `QueryExecution` before retrieval.
- Every selected active lane contributes to semantic completeness. Another lane covering the same artifacts cannot make a pending, failed, unsupported, or unavailable selected lane complete, because distinct vector spaces may produce different candidates and ordering.
- Semantic responses always expose a compact `SemanticCoverageView`. Pending, unsupported, and failed artifact sets are execution-pinned and bidirectionally pageable.
- A semantic updating state degrades `core:semantic_retrieval` completeness to `partial`; it never converts a valid empty candidate set into a falsely complete result.
- Accepted partial coverage changes the declared completeness of the candidate domain, not the exactness of evaluation over the data published as available. A request requiring complete coverage fails explicitly if that requirement cannot be met.
- Hybrid discovery returns one deterministic fused order inside each independent confirmed or possible stream. It uses the approved versioned reciprocal-rank-fusion family followed by deterministic structural and architectural reranking; native lane scores are internal execution values and are never compared directly across incompatible spaces.
- Each stable operation or versioned recipe selects an immutable intent-specific ranking profile over the common fusion contract. Normal agent requests express intent rather than arbitrary numeric weights. The cached execution pins the exact profile internally, but normal MCP responses expose no profile, score, weight, feature, or ranking-contribution fields.
- Initial reranking uses versioned typed features and exact rational calibration and weights. Binary floating-point arithmetic and learned rerankers cannot affect initial public result membership or ordering. Intermediate feature values and contributions may be discarded after the final manifest is materialized.
- The initial feature catalog is closed and core-owned: exact identity and retrieval match, relationship role, structural distance, scope proximity, universal semantic fit, architectural role, evidence directness, and operation-defined result-subject preference. Plugins cannot extend or reinterpret it.
- A ranking feature is active only with complete source-capability coverage across its complete ranked scope. Otherwise an operation accepting partial knowledge omits it uniformly and reports the coverage cause through ordinary completeness; a complete-coverage requirement fails explicitly. Candidate-local silent defaults are forbidden.
- The possible stream is ordered first by the non-numeric confidence tiers `high`, `medium`, and `low`, then by its selected relevance profile within each tier. Ranking never changes classification or confidence. The confirmed stream has no confidence tier.
- Exact score ties use workspace participant ordinal followed by the UCE canonical bytes of the normalized `ResultSubject`. This final fallback is stable but semantically neutral and cannot include undeclared heuristics.
- Artifact and entity views normalize to one entity candidate before fusion only when the matched source content belongs unambiguously to that entity. Their contributions are accumulated; file-level or ambiguous content remains an independent artifact result with visible overlap provenance.
- Ranking and reranking execute exactly once during query materialization. Cursor continuation hydrates immutable ordered manifests and never repeats discovery, traversal, scoring, fusion, or reranking.
- `ResultBundle` explains why a result belongs through evidence, provenance, classification, confidence when applicable, and completeness. It does not explain why the result received one ordinal rather than another; final result order is the only agent-facing ranking projection.
- The approved semantic operation-error subset is documented in [Core operation error codes](../protocol/core-operation-error-codes.md).

## Public request contract

The authoritative fields and presence rules for `QueryRequest`, its three expression variants, query scopes, stages, options, response budgets, and `ContinuationRequest` are defined in the universal data model. Every operation-specific argument, shared selector, pipeline-operator argument, and MCP wrapper field is defined in the [Public query contract](../protocol/public-query-contract.md). Public JSON uses lower camel case while canonical logical names use snake case; the API-versioned schema defines the mechanical mapping and rejects unknown fields.

Every query is one of:

- an `operation`, for one stable investigation primitive;
- a `pipeline`, for an acyclic composition evaluated in one execution; or
- a `recipe`, for a core-owned versioned pipeline with a concise task-shaped input.

The request never accepts an SQL, Cypher, regular-expression-as-program, scripting, ranking-weight, embedding-profile, storage, or planner escape hatch. Regular expressions are data only in the lexical operation and use the documented safe expression dialect.

## Stable operation registry

The initial operation identifiers and their output domains are:

| Operation | Required input | Primary output |
|---|---|---|
| `core:discover_definitions` | `DefinitionMatcher` plus optional registry selector | Typed registry definitions and match explanations |
| `core:find_records` | non-empty structural record selector | every exactly matching visible canonical record |
| `core:find_artifacts` | optional structural filter | every exactly matching visible source artifact |
| `core:resolve_symbol` | name, optional location and `KindSelector` | exact declarations and ambiguous candidates |
| `core:get_outline` | artifact or container subject | ordered contained declarations |
| `core:find_references` | entity subject and reference-role selector | referencing records or entities |
| `core:expand_relations` | subjects, direction, relation selector, depth | reachable typed subjects with provenance paths |
| `core:find_paths` | source subjects, target subjects, relation selector | deterministic shortest structural paths |
| `core:search_text` | text or safe regex, path and kind filters | exact artifact, record, or entity matches |
| `core:search_semantic` | typed query text and hard filters | possible semantic candidates plus coverage |
| `core:search_hybrid` | typed query text and hard filters | deterministic fused lexical/semantic candidates |
| `core:get_source` | exact subjects and snippet projection | pinned source references and snippets |
| `core:analyze_impact` | target plus change descriptor | classified affected code, contracts, and tests |
| `core:find_related_tests` | subjects and test-relation policy | confirmed and possible test subjects |
| `core:inspect_architecture` | scope and requested architectural views | entry points, boundaries, public surfaces, cycles, and extension points |
| `core:compare` | role-bound participant subjects or scopes | added, removed, changed, and correlated subjects |
| `core:build_context` | task statement, seeds, desired context facets | bounded deduplicated task context |
| `core:index_status` | explicit query workspace scope plus include options | workspace, snapshot, freshness, capability, and activation state |

Each operation definition is immutable within one public API version and contains the closed argument schema in the public query contract, legal scope kinds and participant roles, required capabilities, fallback policy, result subject types, evidence policy, completeness dimensions, ranking profile, deterministic ordering, and resource class. Adding an optional field with observable behavior requires a new API version; metadata-only description corrections do not.

`analyze_impact` accepts existing targets and hypothetical descriptors for rename, move, delete, signature, type, visibility, contract, and behavior changes. Hypothetical values are query inputs only and never enter the canonical index. Its classifications are `will_break`, `must_update`, `may_be_affected`, `tests_to_run`, and `uncertain_dynamic_usage`, each backed by operation-defined evidence requirements.

## Pipeline algebra

The initial core-owned operators are:

- `source.operation`: run one stable operation as a source stage.
- `source.registry`: select definitions from the pinned registry using an exact selector or `DefinitionMatcher`.
- `set.union`, `set.intersection`, and `set.difference`: combine compatible typed subject sets.
- `expand.relations`: traverse registered relation kinds from an earlier subject set.
- `expand.operation`: invoke a stable operation once over the complete typed upstream set, allowing batching and global planning.
- `filter`: apply closed structural, path, language, namespace, kind, facet, evidence-class, confidence, or completeness predicates.
- `join`: join two typed sets only through a registered equality or canonical relation predicate.
- `deduplicate`: normalize equivalent result subjects under a declared identity projection.
- `bind.record_selector`: map record-kind, facet, and language definitions to a structural record selector; this deterministic operator is reserved for immutable core recipes.
- `bind.subject_record_selector`: derive an exact kind/language selector from visible record subjects; this deterministic operator is reserved for immutable core recipes and preserves upstream evidence classification.
- `select`: choose named stage outputs and agent-facing projections.

There is no public `rank` operator. Every source or expansion operation that returns an ordered candidate set owns one core ranking profile, and set/join operators have fixed order semantics. This prevents plugins or callers from altering how facts are selected or ordered.

Stages form a finite DAG. References may point only backward in the submitted order, stage IDs are unique, and every referenced output type must satisfy the receiving operator. Cycles, unconsumed invalid outputs, incompatible joins, and registry identifiers outside the pinned snapshot are rejected before any expensive work. A stage receives the entire logical upstream set even when its final response will be paginated.

`set.union` preserves the best canonical occurrence of a subject and accumulates provenance; `intersection` retains subjects present in every input; `difference` preserves the left order after removing right-side identities. `join` emits one result per canonical pair or operation-defined grouped subject. Every multiplicity rule is part of the operator version and never depends on database row order.

A definition-set output may feed kind, facet, role, diagnostic, capability, evidence, or semantic-reason selectors later in the same pipeline. The matcher explanation includes the matched definition identity, definition type, namespace, match class (`exact`, `lexical`, or `semantic_candidate`), and the query terms responsible for a lexical match. It exposes no embedding score or ranking internals.

## Recipes

The initial recipes are:

- `core:locate_implementation`
- `core:understand_change_impact`
- `core:prepare_symbol_change`
- `core:prepare_new_feature`
- `core:trace_behavior`
- `core:find_relevant_tests`
- `core:explain_architecture_slice`
- `core:compare_workspaces`
- `core:semantic_to_callers`
- `core:resolve_and_find_references`
- `core:definition_to_instances`

The complete immutable definitions of all eleven initial recipes are the [core intent recipe registry](../protocol/core-intent-recipes.md). This list is only its identity summary.

A recipe version pins its normalized pipeline, stage/operator versions, operation versions, ranking profiles, defaults, guards, output projection, and complete argument schema. An API release maps each recipe ID to one default version. Existing versions remain executable while advertised as supported; changing membership, evidence semantics, completeness, or order requires a new version. Plugins cannot add recipes.

Representative one-call compositions include:

```text
semantic or hybrid locate "authorization decision"
  -> resolve matched artifact regions to entities
  -> expand inbound core:call relations
  -> find related tests
  -> select implementations, callers, tests, evidence, and snippets
```

```text
discover definitions matching "HTTP route"
  -> use the returned kind set in a structural filter
  -> find analogous entry points
  -> expand implementation and test relations
  -> build a bounded new-feature context
```

```text
resolve PaymentService.capture
  -> analyze hypothetical signature change
  -> join affected callers with owning modules
  -> expand test relationships
  -> select must-update and tests-to-run streams
```

All stages are materialized as one `QueryExecution`; pagination never reruns these steps.

## Result envelope, ordering, and deduplication

`QueryResultPage`, `ResultStreamPage`, `ResultBundle`, `ResultAssessment`, `CompletenessReport`, evidence, diagnostics, snippets, registry bundles, semantic coverage, and cursor claims use the exact universal-data-model fields. Every first page and continuation repeats the immutable workspace bindings, total counts, completeness report, diagnostic report, and semantic coverage views. Registry mode `none` omits only the registry stream. Mode `used` pins one page-specific `RegistryUsageSet` whose cursor remains valid independently of parent-stream hydration; mode `full` pins the complete selected agent registry.

Every selected result set has independent confirmed and possible streams, totals, and cursors. Every bundle also repeats its `result_set`, so a composed callers/tests/implementations response remains independently understandable and any selected set can be paginated without consuming another set first. Possible results are partitioned `high`, then `medium`, then `low`; ranking applies inside a tier. Deduplication uses `result_set + normalized ResultSubject`: the same entity occurrence found through several stages for the same selected output appears once with accumulated provenance and evidence, while the same subject may legitimately appear in different result sets. An exact record or artifact remains distinct unless the operation's declared subject projection proves one unambiguous entity normalization. Within one result set, a subject classified both possible and confirmed appears only in confirmed, while its possible evidence may remain in the evidence summary.

`ResultSetPage` values follow normalized selected-output order. Inside each result-set/classification stream, stable operation-specific order applies; exact ties use participant ordinal followed by canonical `ResultSubject` bytes. Paths order by hop count, then relation-role sequence, then subject fallback. Registry definitions order by definition type, namespace, identifier, version, and canonical bytes. Source outlines order by source span and canonical identity. No insertion time, thread schedule, physical row ID, host path, or locale affects order.

Source snippets are optional with modes `none`, `signature`, `relevant`, or `body`. `signature` and `relevant` select operation-defined exact spans; `body` may return the containing declaration. Every mode is subject to per-snippet and response character budgets. Truncation is explicit, UTF-8 boundaries are preserved, and `SourceSnippet.span` identifies the exact selected source range. If security policy replaces sensitive substrings, the snippet explicitly carries its redaction mappings and never describes the marker text as original source.

## Workspaces, comparisons, and freshness

Every operation definition declares `single_workspace`, `comparison`, or both. Comparison operations declare exact roles. The initial `core:compare` and `core:compare_workspaces` recipe require `base` and `target`; roles cannot be swapped by normalization. General multi-workspace discovery uses caller order and participant ordinal but creates no canonical cross-workspace relation.

If any requested participant, snapshot, registry, or lease cannot be acquired, the whole execution fails before materialization. A request never silently drops a participant. Cross-workspace correlation uses portable symbol keys, exact paths, content digests, and operation-defined structural evidence; it returns derived correlations and never merges entity identities.

Freshness `current` returns the latest published state immediately and reports observed pending changes as `stale`. `wait_for_current` waits until every participant has an equivalent checkpoint or the explicit timeout expires. Explicit retained snapshots use `snapshot` and are never described as stale merely because newer generations exist.

## Persistent cursors

After complete discovery, traversal, classification, ranking, and ordering, Urdira stores immutable ordered manifests under `query_execution_id`. The first page and every continuation only hydrate adjacent slices. Forward and backward cursors identify one stream and stable boundary; pages are always rendered in canonical forward order. Query cursors and index-status cursors are distinct closed variants and cannot cross request wrappers.

The server persists execution state, not a mutable client cursor position. Tokens are opaque authenticated locators over persisted claims, may be issued repeatedly, and contain no source content. A continuation repeats the original explicit scope and may reduce either hydration-budget component relative to the initial normalized ceiling. That reduction is page-local: a later continuation may again request any budget up to the original ceiling. It cannot change snippets, evidence, diagnostics, registry mode, projection, filters, or operation arguments.

Execution expiry releases every snapshot lease atomically. An expired, evicted, unknown, scope-mismatched, or projection-mismatched cursor fails with its distinct operation code and never reruns the query. Previous tokens remain valid until the execution expires; navigating backward and then forward reaches the identical manifest entries.

## Complete operation-error families

The core registry defines closed codes in these families:

- request: malformed request, unsupported API version, unknown field, invalid option interaction, budget invalid;
- scope: workspace not found, duplicate participant, invalid participant role, snapshot not found, snapshot expired, scope mismatch;
- planning: operation unknown, recipe unknown or unsupported, stage reference invalid, stage type mismatch, selector invalid, registry definition unavailable, required capability unsupported;
- freshness and coverage: wait timeout, required coverage incomplete, semantic coverage incomplete;
- execution: exact execution resource limit, cancelled, internal execution failure;
- index: unavailable, contract unsupported, integrity failed;
- pagination: cursor invalid, expired, execution evicted, scope mismatch, stream mismatch, projection mismatch;
- semantic: profile missing or incompatible, index unavailable, query generation failed;
- hydration: source unavailable, snippet budget impossible, retained definition unavailable.

Every exact code, trigger, non-meaning, retryability, recovery action, and closed details schema is authoritative in [Core operation error codes](../protocol/core-operation-error-codes.md). Errors never return partial result manifests unless the operation contract explicitly represents the condition as completeness instead.

## MCP surface

The adapter exposes exactly four intelligence tools:

- `urdira_query`: accepts `QueryRequest` or `ContinuationRequest` and covers operations, pipelines, recipes, and every cursor stream.
- `urdira_analyze_change`: a concise wrapper over `core:analyze_impact`; it requires explicit scope, target, change descriptor, options, and budget.
- `urdira_build_context`: a concise wrapper over `core:build_context`; it requires explicit scope, task, optional seeds, desired context facets, options, and budget.
- `urdira_index_status`: lists discoverable workspaces when unscoped or returns pinned freshness, capability, plugin, activation, and repair-status views for explicit workspace IDs.

`urdira_index_status` is backed by `IndexStatusExecution`, not a live row-by-row scan. Its initial request freezes workspace summaries, activation issues, and candidate issues at one `observed_at` into independent ordered streams. Continuations repeat the exact ordered `workspace_ids`, may change only their page-local budget within the original ceiling, and cannot accept a query cursor.

Tool descriptions state purpose, when to use the tool, workspace requirement, continuation behavior, and the fact that Urdira never edits or executes project code. JSON Schemas use discriminated unions, forbid additional properties at every object level, describe every field directly, publish defaults and server maxima, and include one short operation and one composed-query example. Shared definitions are referenced within each tool schema rather than described inconsistently.

The MCP adapter performs only JSON-name conversion, schema validation, MCP revision handling, response-budget enforcement, and transport error mapping. Its modern protocol lifecycle, capability advertisement, tool-result mapping, progress, cancellation, and stdio behavior are authoritative in the [MCP adapter contract](../protocol/mcp-adapter-contract.md). It cannot add implicit workspaces, change operation defaults, collapse completeness, or expose ranking internals.

## Compatibility policy

The public API uses monotonically increasing major versions with immutable closed schemas. A server may support several exact versions simultaneously through lossless adapters. Unknown fields are errors. A behavioral change that can alter result membership, classification, completeness, evidence meaning, cursor behavior, or order requires a new API or explicitly selected recipe version.

Adding registry definitions, plugin knowledge, or newly indexed source can change results without changing the API because those changes are pinned by workspace snapshots and registry bindings. Replaying the same normalized request against the same complete binding set, configuration, contract versions, and resource limits produces the same manifest.

## Completion criteria

Representative discovery, impact, testing, architecture, semantic, and pagination workflows are expressible in one typed request with deterministic response semantics. Implementation acceptance requires public-schema conformance fixtures for every operation, operator, recipe, cursor stream, and error code.
