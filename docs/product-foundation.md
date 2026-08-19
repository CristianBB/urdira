# Urdira Product Foundation

Status: Living decision record  
Last updated: 2026-08-19

## Purpose of this document

This document records the product decisions agreed during Urdira's initial architecture definition and links to their authoritative specifications. Release-bound component selections remain governed by explicit evaluation gates rather than being mistaken for architectural gaps.

For a map of the repository documentation and the authority rules between
decisions, registries, audits, evidence, and implementation records, see the
[documentation guide](README.md).

## Decision specification index

Detailed decisions are maintained as separate specifications so that every unresolved design area has an explicit scope and completion state.

Status meanings:

- **In progress**: the design is actively being defined and contains approved decisions, but it is not complete.
- **Pending definition**: the decision area and constraints are known, but its formal design has not started.
- **Approved**: the specification has been reviewed and accepted for implementation planning.

| Order | Decision area | Status | Specification |
|---:|---|---|---|
| 1 | Universal data model | Approved | [Universal data model](decisions/01-universal-data-model.md) |
| 2 | Language plugin and capability contract | Approved | [Language plugin and capability contract](decisions/02-language-plugin-contract.md) |
| 3 | Query algebra and public API | Approved | [Query algebra and public API](decisions/03-query-algebra-public-api.md) |
| 4 | Workspace, snapshot, and incremental indexing | Approved | [Workspace, snapshot, and incremental indexing](decisions/04-workspace-snapshot-incremental-indexing.md) |
| 5 | Storage and projection architecture | Approved | [Storage and projection architecture](decisions/05-storage-projection-architecture.md) |
| 6 | Semantic search and ranking | Approved | [Semantic search and ranking](decisions/06-semantic-search-ranking.md) |
| 7 | JavaScript and TypeScript MVP | Approved | [JavaScript and TypeScript MVP](decisions/07-javascript-typescript-mvp.md) |
| 8 | Performance, reliability, and evaluation | Approved | [Performance, reliability, and evaluation](decisions/08-performance-reliability-evaluation.md) |
| 9 | Configuration, security, and lifecycle | Approved | [Configuration, security, and lifecycle](decisions/09-configuration-security-lifecycle.md) |
| 10 | Daemon, MCP integration, and packaging | Approved | [Daemon, MCP integration, and packaging](decisions/10-daemon-mcp-packaging.md) |
| 11 | Content-derived record identity | Approved | [Content-derived record identity](decisions/11-content-derived-record-identity.md) |
| 12 | Workspace fork | Approved | [Workspace fork](decisions/12-workspace-fork.md) |
| 13 | Transactional projection digests | Approved | [Transactional projection digests](decisions/13-transactional-projection-digests.md) |
| 14 | Plugin upgrade relock | Approved | [Plugin upgrade relock](decisions/14-plugin-upgrade-relock.md) |
| 15 | Durable analysis cache | Approved | [Durable analysis cache](decisions/15-durable-analysis-cache.md) |
| 16 | Semantic search wiring | Approved | [Semantic search wiring](decisions/16-semantic-search-wiring.md) |
| 17 | Entity-grain semantic documents | Approved | [Entity-grain semantic documents](decisions/17-entity-grain-semantic-documents.md) |
| 18 | Evaluated semantic model pack | Rejected; outcome recorded | [Evaluated semantic model pack](decisions/18-semantic-model-pack.md) |
| 19 | Coding-agent search integration | Approved for implementation | [Coding-agent search integration](decisions/19-agent-search-integration.md) |
| 20 | Source-first readiness and layered publication | Approved | [Source-first readiness and layered publication](decisions/19-source-first-readiness.md) |

The order reflects design dependencies, not implementation sequencing. A later specification may be explored early, but it cannot be marked approved while it relies on an unresolved upstream contract.

The final pre-implementation consistency review passed with no remaining blocking definitions. Its non-authoritative evidence and exact counts are recorded in the [final architecture consistency audit](audits/2026-08-08-final-architecture-audit.md).

`decisions/01-universal-data-model.md` is the complete inventory and source of truth for shared logical model names and shapes. Operation-specific public argument schemas are linked from that inventory to the single authoritative [Public query contract](protocol/public-query-contract.md); no document may define a parallel or legacy variant.

## Supporting registry index

Stable registries governed by the decision specifications are documented separately and versioned without duplicating their governing models.

| Registry | Status | Governing decision | Specification |
|---|---|---|---|
| Core taxonomy | Approved initial registry | Universal data model | [Core taxonomy](taxonomy/core-taxonomy.md) |
| Core diagnostic codes | Approved initial registry | Universal data model | [Core diagnostic codes](diagnostics/core-diagnostic-codes.md) |
| Plugin compatibility issue codes | Approved initial registry | Universal data model | [Plugin compatibility issue codes](compatibility/plugin-compatibility-issue-codes.md) |
| Core candidate issue codes | Approved initial registry | Universal data model | [Core candidate issue codes](indexing/core-candidate-issue-codes.md) |
| Core semantic registry | Approved initial registry | Semantic search and ranking | [Core semantic registry](semantic/core-semantic-reasons.md) |
| Urdira Canonical Encoding | Approved | Universal data model | [Urdira Canonical Encoding](serialization/urdira-canonical-encoding.md) |
| Core digest field contracts | Approved initial registry | Universal data model | [Core digest field contracts](serialization/core-digest-field-contracts.md) |
| Core canonical schemas | Approved initial registry | Universal data model | [Core canonical schemas](serialization/core-canonical-schemas.md) |
| Core canonical comparators | Approved initial registry | Universal data model | [Core canonical comparators](serialization/core-canonical-comparators.md) |
| Core canonical encoding errors | Approved initial registry | Universal data model | [Core canonical encoding errors](serialization/core-canonical-encoding-error-codes.md) |
| Core operation error codes | Approved initial registry | Query algebra and public API | [Core operation error codes](protocol/core-operation-error-codes.md) |
| Public query contract | Approved initial contract | Query algebra and public API | [Public query contract](protocol/public-query-contract.md) |
| Core intent recipes | Approved initial registry | Query algebra and public API | [Core intent recipes](protocol/core-intent-recipes.md) |
| MCP server contract | Approved initial contract | Daemon, MCP integration, and packaging | [MCP server contract](protocol/mcp-adapter-contract.md) |

## Product name

The project is named **Urdira**.

The name is derived from the idea of weaving individual threads into a coherent structure. It reflects the product's purpose: connecting isolated facts about a codebase into a model that an agent can query and understand.

## Product vision

Urdira is a local, open-source code-intelligence engine designed specifically for coding agents.

It analyzes a workspace, maintains a rich and continuously updated model of the codebase, and exposes deterministic operations that let an agent understand it quickly and with verifiable evidence. Typical questions include:

- Where is a behavior implemented?
- Which symbols, files, tests, contracts, or entry points depend on a target?
- What is the likely impact of modifying, renaming, moving, or deleting an existing element?
- What context is relevant when adding a new feature?
- Which architectural conventions and extension points should new code follow?

Urdira is intended to be the agent's code-intelligence interface for reading and understanding a codebase.

## Settled product boundaries

### Local and open source

Urdira runs locally against workspaces available on the user's machine. The initial product is not a hosted service and does not require uploading source code to a remote platform.

### Read-only intelligence

The public product surface is strictly read-only.

Urdira may inspect, parse, index, and monitor repository contents, but it does not:

- Modify source files.
- Apply patches.
- Run arbitrary shell commands on behalf of an agent.
- Expose general command execution.

Editing, building, testing, and command execution remain responsibilities of the coding agent or its other tools. Urdira is the authoritative intelligence and retrieval layer.

### Real-time working-tree awareness

Urdira must detect modified files and update its internal model immediately or near-immediately. An agent should be able to edit a file and query the updated repository state without waiting for a full re-index.

The index must represent the current working tree, including changes that have not been committed to Git.

Every indexed fact must retain precise source provenance, including at least:

- The exact owner artifact and its normalized URI; physical workspace artifacts additionally retain their normalized workspace-relative path.
- Exact source range when applicable.
- The exact artifact version and workspace generation.
- Enough identity information to detect stale results.

### Workspace-scoped indexing

Urdira indexes source workspaces, not Git repositories or branches. Git enriches a workspace with useful metadata and reuse opportunities but never defines its identity.

The settled source-context hierarchy is:

```text
Codebase
  └─ Workspace
       └─ Snapshot
```

A `Codebase` is an optional logical grouping. It may represent a Git repository and group several related worktrees or checkouts, but non-Git workspaces do not require one.

A `Workspace` is one concrete, mutable source root observed by Urdira. Each workspace receives a stable, persistent, unique `workspaceId` assigned by Urdira. The identifier is not derived from a branch name, commit, remote URL, or path alone.

A `Snapshot` is an immutable indexed generation of exactly one workspace. Queries and pagination executions are pinned to snapshots so that concurrent updates cannot change results during execution.

The model must support:

- Git worktrees on different branches.
- Ordinary Git checkouts whose active branch can change.
- Detached Git checkouts.
- Multiple independent clones of the same repository.
- Directories that are not Git repositories.
- Git branches, tags, or commits indexed as virtual read-only source trees.
- Multiple agents querying and modifying different workspaces concurrently.

Branch names are metadata and must not form part of the stable identity of a workspace or entity. A workspace keeps its identity when it switches branches and publishes a new snapshot after reconciliation.

### Source providers

Source acquisition is abstracted behind a language-independent provider contract with responsibilities equivalent to enumerating files, reading files, observing changes, and capturing a stable source state.

The reserved initial provider-component lineages are:

- `core:directory_source_provider`: a normal filesystem directory, whether or not it uses version control.
- `core:git_worktree_source_provider`: a concrete directory enriched with Git common-directory, commit, branch, detached, and dirty-state metadata.
- `core:git_reference_source_provider`: a branch, tag, or commit read from Git objects without changing a user's checkout.

When an analyzer requires physical files for a virtual Git reference, Urdira may materialize a private read-only representation inside its own cache. It must never alter the user's checkout to index another reference.

### Concurrent workspace maintenance

Each live workspace has an independent change watcher, incremental update queue, generation sequence, and current snapshot. New snapshots are published atomically after affected facts and relationships have been updated.

Queries already running remain pinned to their original snapshots. If two agents modify the same physical directory, Urdira observes one shared filesystem state and cannot infer ownership of individual edits. Agents that require isolated source states must use separate workspaces.

Urdira should reuse analysis across related workspaces only through content-addressed inputs keyed by source content, the verified analyzer `analysis_digest`, analysis-configuration digest, and every exact dependency context capable of changing output. Local syntax and embedding computation may be reused under their own stricter keys, while resolved cross-file relationships remain scoped to a particular workspace snapshot.

### File ownership and reverse invalidation

File ownership is a mandatory invariant of Urdira's knowledge model:

> Every record in the knowledge plane has one indexed owner artifact, an optional precise source span, and a reverse-indexed set of all additional source artifacts required to derive or validate it.

This invariant applies to all source-derived entities, relations, facts, evidence, lexical entries, semantic documents, embeddings, and derived metrics.

The authoritative `RecordEnvelope`, source-catalog, tombstone, and temporal schemas are defined only in the [universal data model](decisions/01-universal-data-model.md). `owner_artifact_id` and `owner_artifact_version_id` are mandatory indexed fields on every source-derived knowledge record and projection.

`SourceArtifact` identifies a normalized address within one workspace. `ArtifactVersion` identifies an exact content occurrence at that address, and `ContentBlob` allows identical content to be shared safely. Canonical renames are delete-and-create operations with optional lineage evidence. The artifact abstraction covers physical files and virtual sources such as language-standard-library definitions or Git references. Physical workspace files always retain their exact normalized repository-relative path.

Records that occupy a precise part of an artifact include canonical byte offsets. Human-readable line and column coordinates are derived or cached presentation data; their exact encoding convention remains part of the plugin and query contracts.

A single owner is insufficient for cross-file derivations. Urdira therefore materializes the authoritative `RecordArtifactDependency` model from the universal data-model specification.

For example, a call relation is owned by the file containing the call site and additionally depends on the artifact containing the resolved target. Modifying either artifact can therefore locate the affected relation without scanning the complete graph.

At minimum, storage projections must support efficient lookup through indexes equivalent to:

```text
(workspace_id, owner_artifact_id, valid_to_generation)
(workspace_id, dependency_artifact_id, record_id)
(workspace_id, normalized_path)
```

When an artifact changes, Urdira finds and closes its owned records in the new generation, finds cross-file records through the reverse dependency index, schedules the affected derivations for recomputation, and publishes a new snapshot atomically.

Snapshot retention means invalidation and physical deletion are separate operations. Records are removed from the current generation immediately through validity intervals or tombstones, while physical deletion is deferred until no retained snapshot or query execution can reference them.

This ownership invariant must be preserved by every derived projection, including graph, lexical, vector, evidence, and metric indexes. Each projection must support invalidation by owner artifact.

Operational metadata belongs to a separate control plane. Records such as workspaces, snapshots, plugin registrations, query executions, and cursor-cache entries do not receive fictitious source files because they are not part of the source-derived knowledge plane.

### Language-agnostic core

JavaScript and TypeScript are the first supported language ecosystem, while the public engine remains language-agnostic.

Adding another language should require implementing a language plugin rather than changing the core query engine or public API. Language-specific parsing, symbol resolution, and semantic analysis belong behind a stable plugin contract.

Plugins only acquire, analyze, resolve, enrich, and project source knowledge into validated language-neutral models and namespaced extensions. They never define or override query operations, intent recipes, ranking profiles, ranking features, weights, fusion, ordering, pagination, or response schemas. Those decisions belong exclusively to Urdira's core query engine. Plugin output may influence an answer only through the canonical data, universal mappings, evidence, capabilities, diagnostics, completeness, and projections it contributes.

The core must not encode JavaScript- or TypeScript-specific assumptions into its public model.

Every canonical record exposes one precise concrete kind, one universal core kind in the same category, and validated structural facets. Public selectors can combine concrete kinds, universal kinds, and all/any/excluded facet constraints. Plugin-specific precision remains available without making language-agnostic operations depend on plugin namespaces.

Every logical plugin owns one compact canonical namespace, publishes one closed atomic registry contribution, and maps every concrete kind to the closed core universal taxonomy. The contribution contains its canonical schemas, digest domains, structural comparators, external verifier contracts, platform-neutral source-provider and projection-generator runtime definitions, digest recipes, digest references, and every typed value it may emit, including dependency, projection, lifecycle, completeness, and evidence codes; runtime output cannot invent identifiers. Executable builds are verified separately. Embedding profiles and all vector-producing components are core-owned and cannot appear in a plugin contribution. Namespace, behavior-release, and build-identity collisions are warnings at installation and hard failures when competing meanings or executable bytes would become active in the same index. Cross-plugin enrichment is additive through independently evidenced facts and relations; plugins never mutate another producer's records. Code snapshots pin an immutable persisted registry snapshot whose digest commits to the complete core registry and every exact plugin contribution, so retained data remains interpretable after plugin removal or upgrade.

Plugin dependencies use canonical structured SemVer requirements that resolve to an immutable exact lock per workspace. Runtime plugin contracts, registry contracts, plugin package versions, capability contracts, and the public query API evolve independently. Negotiation selects one exact closed contract version, and Urdira never ignores unknown future fields to simulate compatibility.

Definition evolution distinguishes complete `definition_revision` values from stored-record `schema_version` values. Compatibility is classified as `metadata_only`, `backward_compatible`, `reanalysis_required`, or `new_identifier_required`. Canonical records are never rewritten by plugin migrations: incompatible changes are reanalyzed from exact source versions in a candidate generation and published atomically with its registry and lock. Schema and analyzer compatibility remain separate through verified contribution and analysis digests.

Plugin activation failures before candidate creation are paginated `PluginCompatibilityIssue` values rather than source diagnostics. After candidate creation, planning, analysis, validation, projection, publication, and cleanup failures are `CandidateIssue` values from the dedicated candidate registry. Neither failure family is inserted into canonical source knowledge. The agent-facing MCP remains read-only: it can inspect the active lock, negotiated capabilities, activation attempt, candidate identity, and both issue streams but cannot change plugins.

Registry definitions referenced by a result page are included once by default, deduplicated and budgeted, so an agent can interpret unfamiliar plugin kinds, codes, roles, and evidence semantics without another call. Universal semantic meanings remain governed by the [Core taxonomy](taxonomy/core-taxonomy.md).

### Deterministic, agent-oriented operations

Urdira is not primarily a chat interface and is not merely a vector search engine. Its main interface will be a stable set of typed operations designed around tasks coding agents perform.

The same query against the same indexed revision and configuration should produce the same result. Results must expose evidence, provenance, completeness, and uncertainty instead of presenting heuristic conclusions as proven facts.

Public intelligence operations use exact logical evaluation over their declared snapshot, scope, filters, available capabilities, and published materializations. Urdira does not silently substitute approximate retrieval, sampled traversal, bounded best-effort discovery, or another non-exhaustive algorithm. A physical optimization is valid only when it preserves the exact result and deterministic order required by the logical operation.

Exact evaluation does not imply that every capability is available or every heuristic conclusion is proven. Known coverage gaps, including embeddings that are still being generated, remain legal only when the response exposes them through its pinned completeness and coverage models. A request that requires complete coverage fails explicitly when that requirement cannot be satisfied; resource exhaustion or inability to execute exactly also produces a structured operation error rather than an approximate result. An explicitly non-authoritative exploratory operation may be designed in the future, but no such mode belongs to the initial public contract.

Source-owned analysis limitations are stored as typed `DiagnosticRecord` knowledge and affect completeness only when their explicit scopes intersect a query. Attention severity is independent from coverage impact. Protocol or service failures use structured `OperationError` responses and never receive fictitious source ownership.

Every emitted `diagnostic_code` must have a stable, versioned registry definition covering its exact emission condition, non-meaning, allowed severity and scope, completeness effect, recovery, agent guidance, closed payload schema, and valid example. Core definitions are maintained in [Core diagnostic codes](diagnostics/core-diagnostic-codes.md). Agent responses include relevant code guidance directly so normal investigations do not require a second registry lookup.

### Layered API

The agreed API strategy is layered:

1. Stable, high-level operations are the primary agent-facing interface.
2. Reusable structural primitives support those operations internally and may be exposed for advanced use.
3. A generic graph query mechanism may exist as an expert escape hatch, but agents should not need it for normal work.

The agent-facing API must remain stable as new language plugins are introduced.

### One-call agent investigations

Urdira should optimize for agent turns, not merely for the number of internal engine operations. The governing interaction principle is:

> One agent question should normally require one Urdira call.

An agent must not need to perform semantic discovery in one call and then issue separate calls for callers, entry points, tests, or source context. Urdira must be able to execute dependent stages internally and return one bounded, evidence-backed result.

This requires more than batching independent requests. Urdira will support composed queries in which later stages consume entities produced by earlier stages. The composition model will be declarative and typed; it will not allow arbitrary code or command execution.

The agent-facing API will provide three complementary levels:

1. **Individual operations** for precise questions about already known entities.
2. **Declarative pipelines** for dependent discovery, traversal, filtering, ranking, and projection in one request.
3. **Intent recipes** for common investigations such as understanding a behavior, analyzing a change, or building task context.

Intent recipes are deterministic, versioned query plans built from the same stable primitives. They reduce the amount of query-planning logic that every coding agent would otherwise need to reproduce.

Each stable operation or intent-recipe version selects an immutable intent-specific ranking profile over Urdira's common exact fusion contract. Agents state the investigation they want rather than supplying arbitrary numeric weights. The normalized plan and persistent query execution pin the exact profile version and digest internally, and cursor pages reuse its already materialized order without reevaluation. Normal MCP requests and responses expose no ranking profiles, scores, weights, features, or contributions.

Initial reranking is internally transparent and deterministic. Profiles use versioned typed features and canonical exact-rational calibration and weights. Learned rerankers and platform-dependent floating-point ordering are outside the initial contract, but ordinary agents receive only final order; evidence, provenance, classification, confidence, and completeness explain result meaning.

The initial core ranking catalog is closed to exact identity and retrieval match, relationship role, structural distance, scope proximity, universal semantic fit, architectural role, evidence directness, and operation-defined result-subject preference. Plugins may contribute canonical data consumed by those definitions but cannot add or reinterpret ranking features. Popularity, raw fan-in, file size, age, change history, author identity, and comparable indirect proxies do not affect initial ordering.

A ranking feature is enabled only when its required knowledge is complete over the entire ranked scope. Partial operations omit an unavailable feature uniformly and expose the underlying capability gap through the normal completeness report; complete-required operations fail explicitly. Urdira never gives covered candidates a hidden ranking advantage by treating unknown feature values on other candidates as zero. The execution pins the active feature set, so later indexing progress cannot reorder cursor pages.

Ranking ties are resolved only after confidence partitioning and exact profile scoring. The final fallback compares workspace participant ordinal and then the UCE canonical bytes of the normalized result subject. This fallback is intentionally semantically neutral: it provides a portable total order without introducing hidden preferences based on names, paths, popularity, insertion order, or execution timing.

The active extension registry is itself a composable query source. An agent may discover kinds or other registered values across every active namespace and feed those typed identifiers into later stages of the same request. Namespace filters are optional, and simple operations provide an inline definition matcher, so unfamiliar installed plugins never force a separate discovery call.

### Persistent, bidirectional pagination

Every operation that can return an unbounded result set must support pagination. This is especially critical for composed queries because MCP clients and coding agents impose response-size and context-window limits.

A composed query will produce a persistent, revision-pinned result stream that can be traversed forward and backward within explicit response-size budgets. An agent must be able to continue an existing investigation without resubmitting or recomputing its earlier stages.

Pagination is part of the core query contract rather than an MCP-specific workaround. Transport adapters may expose it differently, but they must preserve the same execution identity, ordering, snapshot, and continuation semantics.

### Explicit MCP workspace scope

Every MCP request that reads or analyzes source code must explicitly include `workspaceId` for a normal operation or the complete `workspaceIds` set for an approved comparison. Urdira must not infer query scope from the MCP connection, current directory, active branch, most recently used workspace, or another hidden default.

The only unscoped exception is workspace discovery and global index-status inspection. Missing, unknown, or ambiguous workspace identifiers must produce a structured error rather than trigger fallback behavior.

Every response repeats every resolved workspace binding and its snapshot metadata. This allows agents to verify which source states produced the answer and prevents accidental mixing of results from related worktrees.

### Small and clear MCP surface

The internal operation registry may contain many stable operations, but the MCP adapter should expose a small tool surface. Registering every primitive as a separate MCP tool would consume agent context, complicate tool selection, and encourage unnecessary round trips.

The agent launches only `urdira mcp`. This command directly serves the MCP interface and transparently starts or shares Urdira's per-user daemon. The daemon exists to keep watchers, indexes, workers, and cursor executions alive across MCP processes; its local interface is private, has no agent-visible configuration, and is not a second Urdira API.

The approved MCP surface is:

- `urdira_query`: execute an individual operation, composed pipeline, or named investigation recipe.
- `urdira_analyze_change`: analyze an existing or hypothetical change through a focused schema.
- `urdira_build_context`: build a bounded context package for a coding task.
- `urdira_index_status`: report repository, revision, capability, and freshness information.

The formal schemas and adapter behavior are defined by the query and daemon specifications.

The MCP schemas must be clear and concise enough for an agent to use correctly without consulting separate documentation. They should:

- Use descriptive field names and discriminated request variants.
- Prefer typed JSON objects over opaque query strings.
- Keep nesting shallow unless it represents a genuine dependency.
- Give every agent-visible field its own concise JSON Schema `description` stating its type-level meaning, whether and when it is required or omitted, allowed values, defaults, limits, units or ordering, interactions with other fields, and pagination behavior when applicable.
- State defaults, limits, and important interactions directly in field descriptions rather than relying on external documentation.
- Make required and mutually exclusive fields unambiguous.
- Use the same names for shared concepts such as entities, source selection, budgets, evidence, and revisions.
- Include short representative examples without embedding a long manual in every tool description.
- Reject invalid stage references and unsupported capabilities before execution.
- Avoid transport-specific concepts in the core engine so that MCP remains an adapter rather than the domain model.

### Optional source snippets

Operations may optionally return short source snippets to provide immediate context and evidence.

Snippet inclusion is controlled per request. Callers must be able to request no source, signatures only, relevant excerpts, or larger bodies subject to explicit budgets. Responses must include the file, source range, source revision or hash, and truncation status.

Source snippets are supporting evidence, not a replacement for structured results.

### Unified search and intelligence

Urdira should provide all repository-reading and discovery mechanisms an agent normally needs, including:

- File and module discovery.
- Exact text and regular-expression search.
- Symbol and reference lookup.
- Structural dependency traversal.
- Call, control-flow, and data-flow analysis where supported.
- Change-impact analysis.
- Semantic search.
- Relevant source snippets.
- Working-tree and index-status inspection.

The agent should not need a separate code-search or repository-exploration tool to understand the project.

## Search strategy

Urdira will combine complementary retrieval mechanisms:

- **Lexical search** for names, exact text, and regular expressions.
- **Semantic search** for concepts, intent, and similar implementations when vocabulary differs.
- **Structural analysis** for resolved symbols and demonstrable relationships.
- **Structural ranking** for architectural importance, proximity, and relevance.

Semantic search is a discovery mechanism, not a source of structural truth. A semantic match may identify candidate entities, after which Urdira resolves them against the structured model and expands their verified relationships.

Embeddings must never be presented as proof that two code elements are structurally related.

Every indexed textual artifact has a complete artifact-level semantic view, while source entities have additional precise views. Documents are model-independent; profile-specific segments and canonical vector bytes are rebuildable projections. Source changes remove obsolete semantic projections immediately, and newly scheduled vectors may arrive through later projection-only generations. Queries always report semantic coverage so an agent can distinguish a complete empty result from temporarily incomplete retrieval.

Urdira owns every embedding profile, model, tokenizer, renderer, segmenter, generator, inference runtime, asset, and vector-space contract. The 0.1 line uses the core-owned local `Xenova/all-MiniLM-L6-v2` profile. Its weights are not shipped: a confirmed configuration operation downloads them with a visible notice, after which startup, indexing, querying, pagination, and replay remain offline. Language plugins contribute model-independent semantic sections, language-aware regions, exact source mappings, and an optional ordered list recommending core profiles; they never declare profile compatibility, package, or execute embedding infrastructure. Profile contracts are the sole compatibility source. The core alone constructs model input, generates and stores vectors, performs exact retrieval, fuses and ranks lanes, caches executions, and paginates results. No query input is sent to plugin code.

The model-pack schemas and lifecycle rules below remain implemented compatibility and storage contracts, but no model pack is bundled, published, or active in the 0.1 distribution. The explicit rejection and permanent configure-time acquisition flow are recorded in [decision 18](decisions/18-semantic-model-pack.md). Reintroducing a distributed pack requires a new owner decision.

A model pack has one delivery-independent identity: a deterministic canonical manifest committing to the complete set of digest-addressed assets. Identical blobs are stored once in Urdira's local content-addressed store. Offline bundles include the manifest and every required blob; an explicitly requested online installation may obtain the same blobs through non-authoritative external delivery locators. URLs, mirrors, credentials, compression, and archive layout never affect identity. Installation becomes visible atomically only after complete local verification. Indexing and queries never download or lazily fetch model content.

Model packs use no signing keys, signatures, trust store, certificates, or authenticated publisher identity. An administrator authorizes one exact manifest digest explicitly. Digests prove byte identity and integrity, not authorship or endorsement; publisher, provenance, license, evaluation, catalog, and source-location claims remain unauthenticated metadata. The same pack ID and version with another manifest digest is a hard collision and cannot replace or outrank the approved content implicitly.

The canonical identity of a pack is `model_pack_id + model_pack_version + manifest_digest`. The ID is stable and namespaced within an installation, the version is normalized SemVer 2.0.0, and the digest covers the complete immutable canonical manifest except itself. Reinstalling the exact triple is idempotent. Any canonical change requires another version; the same coordinates with different content are invalid.

Each manifest embeds one or more complete `EmbeddingProfile` definitions in canonical profile-ID order. Definitions are validated and their `profile_digest` values recomputed before model assets are opened; they are never indirect files or remotely resolved metadata. Several packs may contain the same exact profile only when its complete four-role runtime requirements and its segmenter and generator runtime configurations also match; Urdira then deduplicates the portable binding while retaining pack references. Reusing a profile ID with another definition, runtime requirement, or runtime configuration is an activation collision.

Each asset is represented by `ModelPackAssetEntry` and identified only by the digest of its exact decoded bytes. Byte length, canonical media type, and a closed semantic role are validation metadata; asset IDs, names, paths, URLs, archive members, and CAS locations have no canonical meaning. Declarative model/tokenizer manifests reference same-pack subordinate blobs by digest and make shard order explicit. Identical blobs are physically shared even when used by several packs.

The closed `ModelPackManifest` contains exactly seven fields: its schema version, pack ID, immutable SemVer, complete embedded profiles, complete assets, complete required core runtime components, and its self-excluding digest. No publisher, signature, descriptive, timestamp, delivery, filesystem, or installation-state field belongs to the canonical manifest.

For each embedded profile, four `ModelPackRuntimeRequirement` entries pin the exact platform-neutral document renderer, query renderer, segmenter, and generator behavior by component ID, behavior release, behavior digest, and contract version. All four roles are mandatory and unique; packs contain no operating-system or architecture-specific build identity and cannot express alternatives, ranges, fallbacks, dynamic discovery, or executable implementations.

Each profile also has exactly two canonical-CBOR `ModelPackRuntimeConfiguration` assets: one for its segmenter and one for its generator. Each envelope repeats the exact profile, role, component, version, and contract binding; selects the closed configuration schema already registered by that exact core component; contains a fully Schema-IR-validated typed value; and commits everything through `configuration_digest`. The segmenter digest equals the profile's segmentation contract. The generator digest is copied into indexed vectors, semantic materializations, and query-vector bindings, so indexing and querying cannot diverge. Environment variables, paths, arbitrary flags, platform probing, and adaptive defaults are forbidden.

If model-pack delivery is approved in a future version, pack ID/version coordinates permanently reserve one manifest digest locally. Each uninterrupted installation and each installation-to-profile supply are monotonic occurrences; removal followed by reinstall creates new occurrences without allowing another manifest to reuse the version.

Installation derives one canonical portable binding per profile from its profile digest, four runtime requirements, two runtime configurations, and complete operational asset closure. Exact portable bindings deduplicate across packs. Active supplies make one eligible for new workspace configurations; existing configurations, materializations, snapshots, and query executions can retain their exact executable binding after the last supply is removed. Active packs root every asset, while retained bindings root only operational assets and resolved runtime builds. Removal releases roots and global reachability collection performs physical deletion safely.

The portable profile binding is resolved against four exact locally installed Urdira runtime builds only when a workspace configuration is activated. The resulting executable binding pins every build and implementation digest. Therefore one model pack works across supported systems while existing vectors are never silently reinterpreted: moving an index to a host without the exact builds requires rebuilding its semantic materialization, while canonical structural knowledge remains portable.

Each profile's model identity resolves to one same-pack canonical-CBOR `ModelAssetManifest`. It fixes provider, model, immutable revision, core-supported architecture and format, ordered configuration assets, and non-empty ordered weight shards. The logical `model_identity_digest` covers those decoded fields; the separate asset content digest covers the complete encoded bytes. No loader code, path, implicit sidecar, or cross-pack asset lookup is permitted.

Each tokenizer identity similarly resolves to one same-pack canonical-CBOR `TokenizerAssetManifest`. It fixes tokenizer ID, immutable revision, core-supported format, optional ordered configuration assets, and non-empty ordered tokenizer data. The two lists are disjoint and their positions are format-defined. Segmenter and generator must support that exact format; no environment vocabulary, sidecar, path, download, or tokenizer code is allowed.

Document and query input templates are direct strict UTF-8 `text/plain` assets rather than nested manifests. Storage and template domains independently digest the same bytes. The exact core renderer contract defines a closed placeholder and escaping vocabulary; templates cannot import files or assets, access environment or network state, or contain executable expressions.

Embedding profiles declare indexed programming or content languages separately from supported structural query classes (`natural_text`, `identifier`, `source_code`, and `mixed`). Urdira never attempts to infer whether a project, comment, identifier, or query is written in English, Spanish, or another human language. Multilingual quality is evaluated as a model property and cannot create a routing or completeness claim.

Generic-versus-specialized embedding fallback is resolved only through versioned workspace configuration before indexing. For each plugin semantic scope, the default resolver chooses the first available, allowed recommendation compatible under the profile's own contract; when none qualifies, it chooses Urdira's compatible generic profile. Explicit workspace policy may replace that default. Once a snapshot and materialization pin a profile, asset or generator failure cannot substitute another model silently. It degrades semantic coverage for that profile; a generic profile can continue only when it was already activated as its own independently identified lane. Switching future work requires another configuration revision and new materialization.

Normal agent queries never select embedding profiles. Urdira automatically uses every active profile compatible with the pinned source scope and structural query class, searches each vector space independently, and fuses the resulting lanes in the core. Installed inactive profiles are ignored. Every selected lane contributes independently to completeness, so another profile covering the same artifacts cannot hide a pending or failed lane. The complete lane set and its coverage remain fixed through all cursor pages.

Core embedding profiles are activated independently from language plugins. Missing or unhealthy model assets never disable otherwise valid parsing, symbol resolution, evidence, or structural indexing. A configuration that requires a profile is validated atomically before publication; failures after successful activation affect semantic coverage only.

## Initial operation families

The approved stable operation registry covers the following families. Exact operation identifiers and request contracts are defined in the [query algebra and public API](decisions/03-query-algebra-public-api.md).

### Discovery and symbol resolution

- Find and resolve symbols.
- Retrieve definitions, references, implementations, and overrides.
- Retrieve file outlines and module public APIs.

### Dependencies and structure

- Retrieve dependencies and dependants of symbols, files, modules, or packages.
- Find import paths, cycles, module boundaries, and public surfaces.

### Execution relationships

- Find callers and callees.
- Find paths between callables.
- Find entry points that can reach a target.
- Inspect possible dynamic-dispatch targets.

### Data and effects

- Trace parameters and data flow.
- Find reads, writes, state mutations, side effects, and external interactions.
- Identify errors produced or propagated by a callable.

### Change impact

- Analyze the impact of modifying, deleting, renaming, or moving a target.
- Analyze hypothetical signature, type, or visibility changes.
- Classify results such as `will_break`, `must_update`, `may_be_affected`, `tests_to_run`, and `uncertain_dynamic_usage`.

### Testing intelligence

- Find tests, fixtures, mocks, and helpers related to a target.
- Determine the test impact of a proposed change.
- Identify a minimal relevant test set when evidence permits.

### Architecture and new-code guidance

- Find feature analogues and extension points.
- Identify conventions and likely placement for a new artifact.
- Retrieve a feature slice across entry points, implementation, persistence, configuration, and tests.
- Validate proposed architectural placement against observed constraints.

### Incremental-index state

- Report index freshness and current workspace snapshot generation.
- Report modified entities and the impact of current changes.
- Compare indexed revisions.
- Allow callers to wait for a specific working-tree state to be indexed.

### Semantic and hybrid retrieval

- Search semantically or through a hybrid lexical, semantic, and structural pipeline.
- Find concepts, similar code, analogous features, and usage examples.
- Build a bounded task-context package for an agent.

## Composed query model

A composed query starts from one or more source operations and applies dependent stages to their outputs. The approved core-owned algebra includes:

- `source.operation` and `source.registry` to produce typed initial sets.
- `set.union`, `set.intersection`, and `set.difference` to combine compatible sets.
- `expand.relations` and `expand.operation` to derive dependent knowledge.
- `filter`, `join`, and `deduplicate` with closed deterministic semantics.
- `select` to choose outputs and agent-facing projections.

Stage references are explicit and validated. Every returned entity retains the stage and evidence path through which it was produced.

Ranking is selected by stable operations and recipes, never by a caller or plugin. Response, snippet, and work budgets are query options rather than algebra stages. The authoritative one-call examples are maintained in the query specification so this foundation does not preserve obsolete request shapes.

The normative examples cover semantic discovery followed by callers and tests, registry discovery feeding a structural kind filter, and hypothetical change analysis feeding affected callers and related tests. They use the closed `QueryRequest` pipeline and recipe variants and are defined in the query specification.

## Materialized query executions

Urdira will paginate a materialized query execution rather than rerunning the original query for every page. This guarantees stable ordering, prevents repeated semantic searches, graph traversals, scoring, fusion, and reranking, and allows bidirectional navigation.

Each resolved query creates the persistent `QueryExecution` defined in the [universal data model](decisions/01-universal-data-model.md). It normalizes both ordinary and comparison requests into one immutable `WorkspaceSnapshotBinding` per participant, including the exact snapshot, registry, resolution lock, configuration revision, freshness checkpoint, and retention lease.

The execution identifier must be unique and unguessable. The record is stored in a local persistent cache so that an agent can continue pagination after a Urdira process restart, provided that the execution has not expired and its index snapshot remains available.

### Compact result manifests

The cache should not duplicate complete rendered responses or source files. It persists the compact, deterministically ordered manifest models defined in the universal data model, including stable typed result, evidence-path, classification, rank, stage, source-projection, and ordering references.

When serving a page, Urdira hydrates those references from the pinned index snapshot and renders any requested source snippets. This provides stable pages without storing large copies of repository content in the query cache.

The exact result ordering is stored in independent confirmed and possible manifests for every selected result set. Candidate identity is normalized before fusion: duplicate artifact and entity views collapse to the unique entity only when the matched source content is wholly and unambiguously attributable to it, while true file-level or ambiguous content remains an artifact result. The persistent execution pins its internal ranking profile, while manifest entries retain the result-set name, final ordinal, stable typed subject, evidence and hydration references, and stable sort key without scores or contribution traces. Stable sort keys validate that order and support deterministic continuation; they are not permission to recompute ranking under a newer contract. Changes in an index, plugin, embedding model, configuration, feature calibration, or ranking implementation must not alter an existing query execution.

### Self-contained result bundles

Composed-query responses must not paginate isolated graph rows that lose their meaning when separated from related evidence. The pagination unit is the self-contained `ResultBundle` defined in the universal data model.

Each bundle contains enough context to be understood independently. Its assessment separates `confirmed` from `possible`, uses only `high`, `medium`, or `low` confidence for possible results, summarizes evidence, and reports relevant completeness. It preserves the path from discovery to conclusion, including which stages were heuristic and which relationships were structurally proven.

Each selected result set exposes confirmed and possible bundles as independent streams with separate totals and continuation cursors. No result set or classification stream may be omitted merely because another consumed the current response budget. The possible stream orders all `high` confidence results before `medium`, and all `medium` results before `low`; intent-specific relevance ranking applies only within each tier. The confirmed stream has no confidence value.

Result sets follow normalized selection order. Inside each classification stream, bundles use the operation's deterministic rank, result type, and stable typed result identifier.

## Cursor contract

Clients receive opaque cursor tokens and must not inspect, construct, or modify them. A cursor identifies a position and direction within one cached query execution.

A cursor token opaquely authenticates and references:

- Query execution identifier.
- Result stream or projection.
- Stable position or sort key.
- Pagination direction.
- Projection and response-budget hash.
- Expiration time.
- Transport-authentication data that is never exposed as a public field.

Urdira persists the query execution and manifest, not every individual cursor token. Forward and backward cursor tokens are generated from the same execution state.

An initial response may return either stream in summary mode so its cursor starts at the first bundle. Continuing in either direction uses the authoritative `ContinuationRequest`: exact API version, the original explicit `QueryScope`, the opaque cursor, and a response budget. It never resubmits the query expression.

The corresponding MCP request variant must remain concise. The cursor already identifies the query plan, projection, binding set, direction, and position. Urdira validates that the explicit workspace or complete workspace set matches the scope digest embedded in the cursor and rejects missing, additional, reordered, or substituted participants.

A continuation cursor selects one stream. That stream is returned as a hydrated page; the other mandatory result stream is returned as a summary with its immutable total and a cursor starting from its first result when non-empty. Urdira never remembers an implicit per-agent position for an unselected stream. Backward navigation selects the preceding slice but still renders its bundles in canonical forward order.

## Response-size budgets

Composed queries must remain bounded. A request can limit traversal depth, stage fan-out, entity count, relationship count, execution time, and returned source.

Pagination cannot rely only on a record count because result bundles and snippets vary greatly in size. `ResponseBudget` therefore requires deterministic item and serialized-character limits, while snippet projection carries its own character ceiling.

Urdira adds complete result bundles until adding the next bundle would exceed the first applicable limit. A single bundle that exceeds the total page budget must be reduced according to the source projection and truncation rules while preserving its structured identity and evidence.

Serialized-character counts are the enforceable response limits. Estimated token counts are informational because tokenization depends on the agent model and transport environment.

When results remain, Urdira returns explicit completeness metadata and forward and backward cursors. Following a cursor resumes the existing execution instead of repeating semantic discovery or earlier graph traversals.

## Snapshot consistency and cache lifecycle

Every query execution is pinned to the complete immutable `WorkspaceSnapshotBinding` set on which it was evaluated. If repository files or freshness checkpoints change while an agent paginates, remaining pages continue to use the original snapshots and original freshness assessment. Urdira must never silently combine results, evidence, or source snippets from different workspace generations or refresh completeness against a later checkpoint.

The cache retains the query execution and every snapshot named by its binding set for the fixed execution lifetime. Ordinary capacity pressure removes expired executions first and rejects new admission rather than evicting a promised non-expired cursor. Explicit emergency eviction expires the complete execution atomically, releases all leases, and returns its dedicated operation error.

If an execution or snapshot is no longer available, Urdira returns the registered structured cursor or snapshot error rather than silently rerunning against the latest index.

Reexecution creates a new query execution identifier and may produce different results because the repository, analyzers, ranking models, or capabilities may have changed.

## Workspace discovery and query scoping

`urdira_index_status` may be called without a workspace identifier to enumerate the workspaces known to the local daemon. It returns safe display roots, workspace and codebase IDs, provider summaries, current snapshot, freshness, VCS metadata, capabilities, and activation state without exposing private storage or package paths.

Every ordinary source query then selects one concrete workspace through `SingleWorkspaceScope`; comparison variants provide the complete role-bound `ComparisonScope`.

The result repeats the complete immutable `WorkspaceSnapshotBinding` set in the common `QueryResultPage`; it does not introduce a second ad hoc scope envelope.

### Workspace-state guards

State-sensitive requests pin an explicit `snapshot_id` in their query scope. Branch and path are presentation metadata and are not accepted as substitutes for immutable snapshot identity. A missing, expired, or wrong-workspace snapshot returns its registered operation error before execution.

### Explicit multi-workspace operations

Normal queries operate on exactly one workspace. Comparing or combining source states requires an operation or recipe that accepts `ComparisonScope`, whose participants declare operation-defined roles such as `base` and `target`.

Urdira must never merge or search across workspace indexes implicitly.

## Uniform response requirements

Stable operations should share a common response envelope. Where applicable, a response should report:

- Every immutable workspace binding used, including snapshot, generation, registry, configuration, and freshness checkpoint.
- Returned entities and their precise source locations.
- The relationship path or evidence supporting each conclusion.
- Confidence and completeness.
- Known limitations or unsupported language capabilities.
- Optional, budgeted source snippets.
- Whether any result was truncated.
- The composed query stages or intent-recipe version that produced the result.
- Forward and backward cursor tokens when additional pages exist within the same investigation.
- The query execution identifier, pinned binding set, and cursor expiration when pagination is active.
- Forward and backward cursor availability without requiring the original query to be resubmitted.
- The explicit workspace identifier or comparison participant set and every resolved immutable binding for the source query.

The API must distinguish compiler- or analyzer-proven facts from heuristic or semantic inferences.

## Approved model direction

The logical model is an extensible, source-owned, temporally versioned record system. It represents small composable knowledge rather than storing precomputed answers to every possible agent question.

Universal concepts include:

- Projects, packages, modules, files, and source ranges.
- Symbols, types, callables, parameters, variables, fields, blocks, and expressions.
- Definitions, references, containment, imports, exports, calls, inheritance, implementation, reads, writes, and data flow.
- Framework-level concepts such as endpoints, events, persistence entities, configuration, and tests when recognized by plugins or enrichers.

Change impact should normally be computed from primitive facts and relationship paths rather than stored as a permanent edge. This allows impact rules to evolve without requiring language plugins to re-extract every repository fact.

Language-specific extensions use registered namespaced kinds, facets, relations, diagnostics, and capabilities without changing the language-neutral engine or public query algebra.

Canonical persistence, integrity, and digest computation use deterministic CBOR under the strict versioned Urdira Canonical Encoding profile. Public MCP requests and responses remain concise JSON projections and are never hashed directly. Every digest field has one explicit computed or referenced contract pinned by the registry snapshot.

## Architecture definition status

The ten linked decision specifications are approved and collectively define the implementation architecture. Concrete release artifacts—such as the exact bundled model-pack coordinate, TypeScript compiler release, supported minimum operating-system versions, and benchmark corpus commits—are selected by the documented release gates and recorded in release manifests; they are not unresolved architectural behavior.

The next milestone is implementation planning and sequencing against these approved contracts. Any implementation discovery that would change identity, ownership, exactness, evidence, completeness, plugin isolation, query semantics, storage durability, privacy, or compatibility requires a new decision revision rather than an undocumented implementation shortcut.
