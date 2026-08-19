# Language Plugin and Capability Contract

Status: **Approved**  
Last updated: 2026-08-08  
Depends on: Universal data model

## Decision objective

Define the contract that allows a new language to be added without changing Urdira's core engine or public API.

## Existing constraints

- JavaScript and TypeScript are the first implementation, not core special cases.
- Plugins produce Schema-IR-validated canonical records and reverse artifact dependencies. Public or transport JSON is normalized before the core computes UCE digests.
- Plugins declare supported capabilities and precision levels.
- Plugin-specific record kinds are namespaced and versioned.
- The public API remains language-neutral.
- Plugins participate only in source acquisition, analysis, resolution, enrichment, and derived-data production. They contribute validated knowledge, projections, diagnostics, coverage, capabilities, provenance, and the definitions required to interpret that output; they do not contribute query operators, intent recipes, ranking profiles, ranking features, weights, fusion rules, ordering, pagination, or result-envelope behavior.
- Every logical plugin has one immutable `plugin_id`, one immutable compact namespace, and one atomic closed registry contribution containing its canonical schemas, digest domains, structural comparators, external verification contracts, runtime components, digest recipes, digest references, and semantic definitions.
- The atomic contribution includes every plugin-emittable typed definition: record kinds, facets, semantic roles, metrics, effects, diagnostic codes, candidate issue codes, dependency roles, projection kinds, lifecycle reasons, completeness reasons, semantic section kinds, semantic reasons, evidence assumptions, and evidence explanations. Embedding profiles and embedding runtime components are core-owned and absent from plugin contributions.
- Namespace ownership is exclusive per index; installation warns about collisions and activation rejects them.
- `LanguageDefinition` is the sole shared-definition exception to namespace ownership. Several plugins may supply the same canonical language coordinate only when the complete bytes and digest are identical; the registry deduplicates it while retaining supplier associations. A differing supply rejects activation. Aliases are discovery-only and never stored as language IDs.
- Every plugin kind maps to one core universal kind; other extension values use only sound registered implications.
- Plugins enrich foreign records through independently owned facts and relations rather than mutation.
- Foreign definition references require mandatory declared dependencies; optional integrations are separate bridge plugins.
- Registry contributions and their exact namespace bindings are persisted in immutable registry snapshots referenced by code snapshots.
- Plugin package versions and capability-contract versions use SemVer 2.0.0 with canonical structured ranges and exact per-workspace resolution locks.
- Runtime plugin contracts, registry contracts, plugin package versions, and public query API versions are negotiated independently.
- Negotiation selects one exact closed contract version; unknown fields and future variants are rejected rather than ignored.
- Registry compatibility and analyzer compatibility are separate. A changed verified `analysis_digest` conservatively reanalyzes all artifacts owned by that plugin in the first implementation.
- Plugin runtime negotiation includes required UCE support. Plugins never choose serialization or hash algorithms per analysis call and never supply authoritative computed digests.
- Every plugin-owned source provider and projection generator has a platform-neutral registered runtime-component definition and separately verified package-local executable builds. Embedding renderers, segmenters, generators, and inference runtimes—including every platform-specific build—are supplied exclusively by Urdira. Integrity-verified model packs are data-only: they add core-owned profiles, weights, tokenizer data, templates, and declarative configuration while referencing only portable core behavior releases; local build selection never enters pack identity.
- Canonical records are never rewritten by plugin migration scripts. Incompatible knowledge changes are re-extracted from exact source versions into an atomic candidate generation.
- Upgrade, downgrade, and explicit rollback share one transactional candidate pipeline; failures leave the previous published snapshot, registry, and lock unchanged.
- Capabilities are required by identifier and semantic contract version. Precision or derivation method and coverage are independent dimensions rather than one ordered level.

The authoritative model shapes and field semantics are defined under **Namespaced plugin extensions** in [Universal data model](01-universal-data-model.md). This contract must consume `PluginRegistryContribution`, `PluginDependencyRequirement`, `NamespaceBinding`, and `RegistrySnapshot` without defining parallel variants.

## Approved decisions

- Plugin registration is one atomic closed contribution covering every typed identifier the plugin may emit.
- Candidate execution output uses `FactDelta`; invalid output creates `CandidateIssue` control-plane state and never canonical diagnostics.
- Runtime, registry, package, capability, analyzer, and public API versions remain independent compatibility axes.
- Relation identities proposed by a plugin use pre-canonical anchor references; the core finalizes keys only after candidate entity identities are assigned.
- Query planning, selection, traversal, fusion, ranking, ordering, pagination, and public result projection are owned exclusively by the language-neutral core. Plugin data can affect a result only through its validated canonical meaning, universal mappings, evidence, capabilities, completeness, and derived projections; plugin code is never invoked to decide how a query is answered or ordered.
- The initial core ranking-feature catalog is closed to plugins. A plugin may supply canonical data that satisfies a core feature's universal predicate, but it cannot register another ranking feature or reinterpret an existing one.
- Plugins contribute model-independent semantic sections, language-aware regions, exact source mappings, and coverage. Their compatibility declaration may carry a duplicate-free ordered `recommended_embedding_profile_ids` list containing only core profile identifiers, but plugins cannot declare profile compatibility or contribute profiles, model assets, tokenizers, renderers, segmenters, generators, inference runtimes, or vector-space semantics.
- A recommendation is advisory and never a dependency: unknown, unavailable, forbidden, or profile-incompatible entries do not block plugin activation. The core derives compatibility exclusively from each profile contract and resolves the first usable recommendation per semantic scope while constructing a new workspace configuration. An installed recommendation may enter that new active configuration even when it was not active previously. If none is usable, the resolver selects the compatible generic core profile. Explicit workspace policy may override the default. The resolved set is pinned before indexing; recommendations cannot activate a profile directly or affect a query dynamically.
- No plugin code executes during semantic query rendering, vector generation, retrieval, fusion, ranking, or pagination. Queries consume only already published plugin knowledge and core-owned semantic materializations.
- Structural plugin activation and core embedding-profile activation are independent capability transactions. Unavailable model packs cannot disable valid structural analysis. A workspace configuration requiring a profile validates core-owned assets atomically before publication, while later per-artifact generation failures degrade only semantic coverage.

## Runtime discovery and activation

Plugins are discovered only from administrator-configured local package roots. Discovery reads a closed package manifest and never executes the package. Installation verifies package bytes, the compatibility declaration, the complete registry contribution, namespace ownership, runtime-component definitions, and executable-build manifests. Installation makes a package *available*; it does not activate it for any workspace.

Workspace activation is an explicit configuration transaction. The resolver selects one exact package version and contract tuple per logical plugin, writes a `PluginResolutionLock`, starts the candidate pipeline, and publishes the new registry, lock, configuration, and code snapshot atomically. A package may be installed, available to new resolutions, active in some workspaces, retained only by historical snapshots, or removable. Removing package bytes is forbidden while an active workspace, retained analyzer replay requirement, or runtime-component binding still needs them. Registry definitions required by retained snapshots remain stored independently of package availability.

One plugin package is executed in a supervised worker process, never inside the daemon address space. Workers receive no ambient workspace path, shell, environment-variable, credential, or network access. The core supplies immutable typed inputs and bounded content blobs through the negotiated protocol. A plugin may use only its package-local executable closure and an explicitly granted private scratch directory. Operating-system sandboxing is defense in depth; the protocol boundary and absence of ambient capabilities are normative on every platform.

A worker is keyed by exact package digest, runtime-contract version, and executable-build digest. Workers may be pooled across workspaces only when no workspace state is retained between calls. Every request is self-contained, every response is Schema-IR validated, and the core treats worker memory as disposable. Activation, draining, restart, and termination never change canonical knowledge without a successful candidate publication.

## Project discovery and analysis partitions

The core owns source enumeration and content access. Discovery, analysis, and projection receive the same immutable `PluginAnalysisContext`, exposed by the official SDK as a read-only virtual artifact and knowledge view. It may return deterministic analysis partitions describing project or compilation contexts, their member artifacts, configuration artifacts, ordered resolution roots, and a stable partition key. Partitions are analysis inputs, not public workspace identities and cannot hide artifacts from another plugin.

Discovery is pure over that view and cannot traverse the filesystem independently. Every configuration file, manifest, declaration bundle, generated type surface, external definition, structural record lookup, and empty lookup that changes a partition or result is captured automatically in the accepted access manifest. Overlapping partitions are legal; the work manifest disambiguates them through the registered `partition_key` in each replacement scope.

Language-neutral enrichers omit `language_id` and declare the universal kinds, facets, and capability outputs they consume. Language plugins require exactly one primary `language_id` per capability declaration and may list additional accepted artifact-language identifiers in their declared coverage.

Every declared language resolves to an active canonical `LanguageDefinition` in the candidate registry. A plugin may carry the identical shared definition or reference one supplied by core or a mandatory dependency. Alternative analyzers for the same language therefore use the same `language_id` without sharing a plugin namespace or redefining query behavior.

## Extraction protocol

The negotiated runtime exposes four core-owned calls: `describe`, `discover_partitions`, `analyze_artifact`, and `generate_projection`. `describe` returns the already installed compatibility declaration and contribution digests for verification; it cannot vary by workspace. `discover_partitions` implements the pure discovery contract above. `analyze_artifact` consumes one frozen `ArtifactWorkItem` and produces exactly one `FactDelta`. `generate_projection` consumes one frozen `ProjectionWorkItem` and produces one complete projection replacement set.

```text
PluginWorkerRequestEnvelope
  protocol_version
  request_id
  request_digest
  call
  deadline
  cancellation_id
  payload

PluginWorkerResponseEnvelope
  protocol_version
  request_id
  request_digest
  call
  outcome
  payload

PluginDescribeRequest
  plugin_id
  plugin_version
  package_digest

PluginDescribeResult
  compatibility_declaration_digest
  registry_contribution_digest
  supported_calls[]

DiscoverPartitionsRequest
  candidate_generation_id
  context
  resource_budget

DiscoverPartitionsResult
  partitions[]
  plugin_input_access_manifest_id
  plugin_input_access_manifest_digest
  analysis_input_digest

AnalysisPartition
  partition_key
  language_ids[]
  member_artifact_ids[]
  configuration_artifact_ids[]
  resolution_roots[]
  capabilities[]

AnalyzeArtifactRequest
  candidate_generation_id
  work_item
  context
  resource_budget

AnalyzeArtifactSuccess
  fact_delta
  plugin_input_access_manifest_id
  plugin_input_access_manifest_digest
  analysis_input_digest

GenerateProjectionRequest
  candidate_generation_id
  projection_work_item
  context
  resource_budget

GenerateProjectionSuccess
  projection_replacement_set
  plugin_input_access_manifest_id
  plugin_input_access_manifest_digest
  analysis_input_digest

PluginAnalysisContext
  analysis_view
  resource_budget

PluginAnalysisView
  analysis_view_digest
  workspace_id
  candidate_generation_id
  base_snapshot_id?
  source_overlay_digest
  prerequisite_stage_set_digest
  target_registry_snapshot_id
  resolution_lock_id
  configuration_revision_id

PluginArtifactView
  artifact_id
  artifact_version_id
  normalized_uri
  artifact_kind
  content_hash
  byte_length
  encoding
  language_ids[]
  content_access

PluginRecordView = BasePluginRecordView | StagedPluginRecordView

BasePluginRecordView
  view_type = base
  record_id
  record_digest
  category
  kind
  universal_kind
  facets[]
  owner_artifact_id
  owner_artifact_version_id
  source_span?
  body

StagedPluginRecordView
  view_type = staged
  staged_record_id
  producing_work_item_id
  proposal_record_key
  validated_record_digest
  category
  kind
  universal_kind
  facets[]
  owner_artifact_id
  owner_artifact_version_id
  source_span?
  body

PluginInputRecordEntry = BasePluginInputRecordEntry | StagedPluginInputRecordEntry

BasePluginInputRecordEntry
  input_type = base_record
  record_id
  record_digest

StagedPluginInputRecordEntry
  input_type = staged_record
  staged_record_id
  producing_work_item_id
  proposal_record_key
  validated_record_digest

PluginInputLookupEntry
  operation
  normalized_selector_or_address
  analysis_view_digest
  result_set_digest
  result_count
  completeness

PluginInputAccessManifest
  plugin_input_access_manifest_id
  request_id
  analysis_view_digest
  artifact_version_entries[]
  record_entries[]
  lookup_entries[]
  transitive_artifact_version_ids[]
  manifest_digest

PluginLookupInvalidationDependency
  lookup_dependency_id
  workspace_id
  consumer_type
  consumer_id
  owner_artifact_id?
  owner_artifact_version_id?
  operation
  normalized_selector_or_address
  selector_digest
  previous_result_set_digest
  invalidation_scope
  valid_from_generation
  valid_to_generation?

PluginResourceBudget
  deadline
  max_memory_bytes
  max_output_bytes
  max_records
  max_dependencies
  max_context_operations
  max_context_bytes
  max_recursion_depth

PluginInputsIncomplete
  candidate_issue_code
  retryability
  message
  details

PluginUnsupported
  candidate_issue_code
  retryability
  message
  details

PluginCancelled
  candidate_issue_code
  retryability
  message
  details

PluginResourceExhausted
  candidate_issue_code
  retryability
  message
  details

PluginFailed
  candidate_issue_code
  retryability
  message
  details
```

Request `call` is exactly `describe`, `discover_partitions`, `analyze_artifact`, or `generate_projection`, and selects its one payload type. Response `outcome` is `success`, `inputs_incomplete`, `unsupported`, `cancelled`, `resource_exhausted`, or `failed` and selects one closed result variant. Unknown fields or variants reject the response. Every non-success value contains `candidate_issue_code`, `retryability`, a bounded safe `message`, and closed code-specific `details`; it never contains a stack trace, absolute host path, environment value, arbitrary log, or secret.

`PluginAnalysisView` is the exact base snapshot plus validated candidate source overlay and only validated staged outputs of prerequisite DAG work. It excludes base records scheduled for closure or replacement and excludes unvalidated, failed, concurrent non-prerequisite, and downstream staged output. The same digest yields the same visible bytes and records regardless of scheduling. `content_access` is `readable` or `metadata_only` under policy.

The SDK exposes `artifacts.list(filter?)`, `artifacts.find(normalized_uri)`, `artifacts.read(artifact_id)`, `records.get(record_reference)`, and `records.query(selector)`. Filters and record selectors are closed structural values; no operation accepts semantic ranking, arbitrary expressions, query recipes, callbacks, host paths, or mutable live-workspace bytes. A record reference is exactly a base `record_id` or candidate-scoped `staged_record_id`. Staged IDs are deterministic within the candidate DAG but never become public canonical IDs.

`PluginInputLookupEntry.operation` is `artifact_list`, `artifact_find`, `record_get`, or `record_query`. `normalized_selector_or_address` is the exact closed filter, selector, URI, or record reference for that operation. `completeness` is `complete` or `policy_limited`; policy-limited membership cannot support an authoritative absence conclusion. `result_set_digest` covers the complete canonically ordered returned identity/digest entries, including an explicit empty set.

`PluginLookupInvalidationDependency.consumer_type` is `record_set`, `projection_set`, or `partition_set`. `owner_artifact_id` and version are required for record/projection consumers and absent for a partition-set consumer. `invalidation_scope` is `exact_address`, `exact_selector`, `plugin_partition`, `plugin`, or `workspace`. The dependency is control/index state rather than canonical source knowledge; it never receives fictitious ownership when its consumer is a plugin partition set. Its half-open generation interval follows the published consumer.

Every numeric budget is positive, except a zero context count/byte limit deliberately denies context operations. `deadline` is the same absolute deadline as the request envelope. Exceeding any component returns `PluginResourceExhausted`; a worker cannot trade one resource dimension for another or emit partial accepted output.

Successful analysis returns a `FactDelta` whose fields and replacement semantics are defined in the universal data model. Every requested replacement scope is present exactly once, including valid empty output. The delta repeats the authoritative work item, owner, candidate, analyzer, and configuration identities. The core rejects output outside those scopes, unknown definitions, missing dependencies, dangling proposal references, conflicting idempotency identities, or incomplete authoritative output.

Projection generation follows the same rules but returns only the registered `DerivedProjectionEnvelope` family authorized by the work item. A projection generator cannot create canonical records, invoke query logic, or read data outside its frozen source selection.

`request_digest` commits to every pre-execution field and governs request-ID idempotency; it does not pretend to know dynamic reads. Reusing an identity with another request digest is a protocol violation. The final `analysis_input_digest` commits to the request digest, analysis view, accepted access-manifest digest, plugin implementation/configuration, and call payload. A retry may reuse output only after re-evaluating all prior returned items and lookups against the same view and reproducing both final digests. The core may retry only `retry_same` outcomes without replanning. Changed bases, expired deadlines, and configuration changes require a new work item. A cancellation token is edge-triggered and cooperative; after cancellation, any later response is discarded. Timeout or worker loss has the same publication effect as cancellation: no partial output is accepted.

`PluginInputsIncomplete`, `PluginUnsupported`, `PluginCancelled`, `PluginResourceExhausted`, and `PluginFailed` are the five non-success payload types with the common fields above and code-specific closed details. `inputs_incomplete` is reserved for a required source root or provider capability absent from the pinned view. Ordinary imports, includes, declarations, module resolution, configuration discovery, and cross-file reads use the virtual context in one execution and do not trigger replanning merely because they were not predeclared.

## Cross-file resolution and invalidation ownership

The plugin owns the language semantics needed to resolve names, overloads, dispatch, types, imports, modules, macros, generated declarations, and framework conventions. The core owns input freezing, identity assignment, reference canonicalization, dependency closure validation, reverse indexes, invalidation planning, candidate concurrency, and publication.

Every context operation is recorded by the core. Returned artifacts and base records retain exact IDs and digests; staged records retain their producing work/proposal identity and validated digest. Membership-sensitive operations also create `PluginInputLookupEntry`, including empty `list`/`query` and absent `find`/`get` outcomes. Entries are duplicate-free and canonically ordered, so concurrent read interleaving is not semantic.

The accepted manifest expands every base record through its complete `RecordArtifactDependency` closure and every staged record through the transitive artifact-input closure already proven for its producer. `FactDelta.input_artifact_version_ids` and `input_record_ids` are core/SDK-derived direct artifact/base-record projections; staged inputs remain committed through the manifest. The plugin may supply a narrower registered role, but it never duplicates ordinary read bookkeeping. Over-reading broadens invalidation and cannot narrow it unsafely.

Every lookup entry is lowered to a reverse-indexed `PluginLookupInvalidationDependency` attached to its record, projection, or partition-set consumer. Exact addresses index URI or record identity. Structural selectors index every dimension supported by the change journal. If those indexes cannot prove detection of every future matching addition, removal, or mutation, the selected capability contract requires `plugin_partition`, `plugin`, or `workspace` fallback. Relevant later changes re-evaluate the lookup and invalidate when the complete result-set digest differs, including empty-to-non-empty transitions. Persisting a lookup digest without this invalidation binding is invalid output.

Resolution may produce confirmed, ambiguous, or unresolved targets. Confirmed targets require evidence allowed by the capability contract. Ambiguous and unresolved observations are retained with possible evidence and exact diagnostic or completeness reasons; the plugin never selects a candidate merely to make the graph connected.

## Capability contract

Capabilities are stable behavioral contracts, not marketing feature flags. The initial core vocabulary is:

- `core:syntax_structure`
- `core:symbol_declarations`
- `core:symbol_resolution`
- `core:type_information`
- `core:module_dependencies`
- `core:call_relationships`
- `core:inheritance_and_implementation`
- `core:control_flow`
- `core:data_flow`
- `core:effects`
- `core:test_relationships`
- `core:framework_semantics`
- `core:semantic_preparation`

Each capability has an independently versioned definition stating legal output kinds, required evidence bases, replacement-scope partitions, completeness rules, dependency obligations, and whether confirmed conclusions are permitted. A plugin declaration provides the exact contract version, primary language when applicable, derivation precision, declared coverage selector, and structured limitations.

`precision` is one of `syntactic`, `resolved`, `typed`, `flow_sensitive`, `modeled`, or `heuristic`. These values describe the principal derivation method and are deliberately not a quality ordering. A capability contract restricts which values are legal and what claim classes they may emit. Coverage is a closed selector over canonical language identifiers, the closed `SourceArtifact.artifact_kind` vocabulary, project-context requirements, and excluded constructs. Limitations are registered code plus applicability selector and resulting completeness status; free text is descriptive only.

Runtime coverage is never inferred from the declaration alone. Every published snapshot contains `SnapshotCapabilityStateEntry` values and source-specific `CompletenessClaim` values. Queries use those actual states. An installed capability that is unsupported for one construct remains useful elsewhere without pretending that the affected scope is complete.

## Diagnostics and partial constructs

Valid analysis limitations are canonical `DiagnosticRecord` values owned by the artifact that contains the limiting construct. A diagnostic code declares its exact trigger, scope, severity, completeness effect, recovery behavior, payload schema, and agent guidance. Unsupported syntax, unresolved imports, ambiguous dispatch, unavailable external declarations, truncated macro expansion, unsupported generated code, and framework-model gaps use distinct registered codes. A generic analyzer failure is never converted into a source diagnostic; it remains a `CandidateIssue` and prevents publication of the affected authoritative scope.

If a plugin can produce a sound subset, it emits that subset, a non-complete claim, and the required diagnostics. If authoritative replacement cannot be established, it returns failure and the previous published scope remains current. `partial` never means that old records were silently retained beside new output.

## Framework and bridge enrichers

Framework enrichers are ordinary plugins with mandatory dependencies on the language or other plugin definitions they consume. They run after their dependency capabilities have produced validated staged canonical records and before derived projections are finalized. The core constructs an acyclic execution DAG from declared plugin dependencies and capability inputs; equal-depth enrichers run concurrently.

Enrichers add independently owned facts, relations, evidence, diagnostics, semantic sections, and projections. They cannot mutate, suppress, relabel, or replace another producer's records. Their replacement scopes are keyed by their own plugin, capability, owner artifact, and optional registered partition.

An enricher declares exact record and artifact dependency roles. Changes invalidate only its affected scopes when those declarations prove sufficiency; otherwise the core widens to the entire enricher partition or plugin. One enricher's failure blocks only candidate scopes whose completeness contract requires it. Optional enrichers may publish the structural candidate with an explicit non-complete capability state; required enrichers fail the candidate atomically.

## Analyzer digests and reuse

Every compatibility declaration includes immutable digests for the parser, project discoverer, resolver, type analyzer, flow analyzer, framework models, and semantic-preparation implementation when present. `analysis_digest` commits to the ordered set of all output-affecting subcomponent digests, negotiated runtime contract, registry contribution digest, package executable closure, and analysis defaults. Workspace configuration is committed separately by `analysis_configuration_digest`.

The first implementation invalidates all plugin-owned artifact scopes whenever `analysis_digest` changes. A later implementation may reuse a capability scope only when its registered digest recipe names the exact subcomponent subset, configuration subset, dependency context, and input records that determine it. Missing or unregistered fine-grained dependency metadata always falls back to whole-plugin reanalysis. Subcomponent digests never weaken the authoritative replacement or snapshot rules.

## Failure containment

Each request has independent time, memory, output-byte, record-count, dependency-count, and recursion budgets. Exceeding one terminates that request and records a candidate issue. Repeated crashes place the exact plugin build in workspace-local quarantine; the last published snapshot remains queryable and its freshness reports pending or degraded state. Other workspaces and plugins continue normally.

No worker can publish, update current pointers, write canonical storage, issue cursors, or alter another plugin's namespace. Only the core validates and commits output. Restarting the daemon reconstructs worker state from persisted locks and candidates; it never trusts worker-local caches as authoritative.

## Compatibility and conformance

Plugin packages use SemVer for distribution, but all executable interactions negotiate exact closed protocol versions. A backward-compatible adapter must be lossless, deterministic, and covered by conformance fixtures; unknown request or response fields are rejected.

Every plugin release must pass shared fixtures for deterministic full reindex, incremental equivalence, deletion and reappearance, missed-input replanning, ambiguous resolution, worker cancellation, timeout, crash isolation, malformed output, and registry collisions. At least one JavaScript/TypeScript fixture and one structurally different reference fixture—Rust is the initial contract reference—must produce valid output without core language branches.

## Completion criteria

The contract is sufficient to describe JavaScript/TypeScript and a structurally different language such as Rust without adding language-specific behavior to the core. Implementation acceptance requires the conformance suite above.

### Ordered structural publication

Plugins may declare ordered atomic structural stages using a stable stage ID,
contiguous ordinal, total count, prerequisite stage IDs, and capabilities
unlocked by that stage. An intentionally partial stage is queryable when its
replacement scope is complete; a half-published candidate is never visible.
Plugins without declarations retain one complete legacy stage. The core
validates IDs, capabilities, contiguous ordering, and acyclic prerequisites,
and persists stage coordinates on capability state and FactDelta/candidate
digests. Snapshot v2 records the exact `source_snapshot_id`; later stages use
that same source identity and publish gapless generations. Source supersession
restarts at stage one, while a crash leaves the last fully published stage.
