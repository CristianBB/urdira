# Semantic Search and Ranking

Status: **Approved**  
Last updated: 2026-08-08  
Depends on: Universal data model, query algebra, and storage architecture

## Decision objective

Define local semantic discovery, hybrid retrieval, structural reranking, semantic-document generation, embedding lifecycle, and confidence boundaries without treating vector similarity as canonical knowledge or structural proof.

The [universal data model](01-universal-data-model.md) is the single source of truth for every model name and field shape. This specification owns semantic behavior, generation rules, and remaining retrieval decisions.

## Approved semantic architecture

Semantic retrieval is a source-owned derived pipeline:

```text
artifact eligibility
  -> artifact and entity semantic documents
  -> profile-specific embedding segments
  -> canonical vector bytes
  -> snapshot-pinned semantic materialization
```

The approved logical models are `EmbeddingProfile`, `DerivedSemanticEligibility`, `DerivedSemanticDocument`, `DerivedEmbeddingSegment`, `DerivedEmbeddingVector`, `SemanticArtifactCoverage`, `SemanticIndexMaterialization`, `QueryEmbedding`, `SemanticIndexBinding`, and `SemanticCoverageView`.

They remain derived or control-plane state. None is a canonical entity, relation, fact, evidence record, or diagnostic merely because a semantic generator emitted it.

## Discovery and proof boundary

- Semantic search discovers candidates; it never proves calls, dependencies, data flow, containment, compatibility, or change impact.
- A semantic candidate resolves to a canonical entity, record, or exact artifact occurrence before structural expansion.
- Semantic evidence is possible evidence only. Confirmed structural results require independently valid structural evidence.
- A composed query may use semantic discovery and then perform callers, callees, dependency, test, impact, or architecture expansion in one execution.
- Agent-facing provenance identifies semantic discovery as heuristic and retains the evidence path needed to verify later structural claims. Embedding profiles, lane scores, similarity values, feature values, weights, and ranking contributions are internal execution details and are not projected into normal MCP results.

## Exact retrieval and explicit incompleteness

Every public semantic operation evaluates similarity exactly over the complete vector set declared queryable by its snapshot-pinned `SemanticIndexMaterialization`, after applying its exact scope and structural filters. The initial public contract has no `approximate` or `auto` retrieval mode and never silently replaces exact retrieval with approximate nearest-neighbor search, sampling, or a bounded best-effort candidate scan.

Physical indexes, caches, pruning strategies, and parallel execution are implementation details. They may be used only when they preserve the same selected candidates, scores, deterministic tie-breaking, and final order as the normative exact evaluation. If Urdira cannot execute that contract within an applicable resource limit, it returns a structured operation error rather than an approximate candidate set.

Exact retrieval is distinct from semantic coverage and evidentiary certainty. When embeddings are pending, unsupported, or failed, an accepted partial-coverage query evaluates exactly over the vectors that the pinned materialization declares available and reports the missing scope through `SemanticCoverageView` and `CompletenessReport`. It must not imply that the candidate set is exhaustive for the intended source scope. A request requiring complete semantic coverage follows the approved wait-and-error behavior. Semantic similarity remains candidate discovery even when both retrieval and coverage are complete; structural claims still require independent evidence.

An explicitly non-authoritative exploratory retrieval operation may be considered in a future contract if measured repository-scale requirements justify it. It is not part of the initial agent-facing API and cannot be introduced as a physical optimization beneath an existing exact operation.

## Deterministic hybrid rank fusion

Hybrid discovery produces one deterministic order inside each independent `confirmed` or `possible` result stream. The streams are never fused with each other: ranking cannot cause a possible result to precede, replace, or be presented as a confirmed result.

The `possible` stream is partitioned lexicographically by its approved confidence vocabulary before relevance ordering: every `high` result precedes every `medium` result, and every `medium` result precedes every `low` result. The selected intent-specific ranking profile orders candidates only within the same confidence tier. Confidence is never converted to a numeric feature, added to a fusion score, or recalibrated by ranking. The `confirmed` stream has no confidence tier and is ordered directly by its selected profile.

Request selectors such as workspace, snapshot participant, path, language, kind, namespace, facet, and other declared filters are hard eligibility constraints. They are applied before ranking and are never interpreted merely as score boosts. Each eligible lexical or semantic discovery lane produces its own exact deterministic ranking. Native scores are internal values and scores from different algorithms or vector spaces are never compared or added directly.

The initial fusion family is versioned weighted reciprocal-rank fusion. For candidate `d`, the base contribution of lane `l` is defined by the selected ranking contract as `weight_l / (rank_constant_l + rank_l(d))`; an absent candidate contributes zero for that lane. The contract pins every lane role, weight, rank constant, eligibility rule, and numeric representation. Changing any output-affecting value creates a new ranking-contract version. The selected contract is pinned internally by `QueryExecution`; its scores and contributions are not agent-facing result data.

### Intent-specific ranking profiles

Urdira does not use one universal ranking configuration for every investigation. A common versioned fusion contract defines shared semantics, while each stable operation or named recipe selects an immutable intent-specific ranking profile appropriate to its task. Locating an implementation, finding affected tests, tracing change impact, and discovering architectural extension points may therefore prioritize different structural features without changing the public meaning of evidence or completeness.

The normalized operation plan resolves exactly one ranking profile for each ranked result set. The selected profile pins its identifier, version, definition digest, base-fusion contract, lane roles and parameters, structural and architectural features, calibration rules, and canonical ordering tuple. A named recipe version resolves the same profile version until the recipe itself is versioned; a stable operation resolves through the execution's pinned API and configuration revisions. Any change capable of changing membership or order requires a new profile version and therefore changes the normalized query-plan hash.

The initial agent-facing API does not accept arbitrary lane weights, rank constants, feature coefficients, or calibration functions. The agent states intent through the stable operation or recipe and may use its declared semantic filters and options; it does not construct a numeric ranking model. This keeps MCP requests concise and prevents accidental selection of incomparable or unevaluated weights. Future expert customization would require a core-owned, validated, and versioned query profile through a contract explicitly separate from language-plugin contributions; a plugin can never supply or override ranking behavior.

Normal agent requests and responses contain no ranking-profile selector, profile identity, score, weight, feature value, calibration value, or contribution field. Query materialization pins the exact profile binding internally until execution expiry, while the immutable result manifests preserve only the final order and the non-ranking data required for hydration. Intermediate ranking values may be discarded once materialization succeeds.

After base fusion, a versioned deterministic reranker may apply the approved structural and architectural features derived only from the execution's pinned canonical records and projections. The reranker may reorder candidates inside their existing result stream but cannot change evidence classification, manufacture structural proof, or hide the semantic origin of a candidate. Exact feature codes and value domains are defined below; each immutable ranking-profile registry entry pins its rational calibration, weights, and complete tie-breaking tuple.

### Typed rational reranking

The initial reranker is transparent and rule-based; it does not use a learned ranking model. Every usable ranking feature has a stable namespaced code and versioned definition describing its exact meaning, typed value domain, source requirements, evidence requirements, deterministic extraction procedure, missing-value behavior, and calibration function. Runtime plans cannot invent undeclared features.

Ranking definitions and profiles are owned by the core query contract, not the plugin registry. Plugins influence ranking only indirectly by contributing valid canonical records, universal-kind mappings, facets, relations, evidence, diagnostics, completeness, and derived projections that the core profile is already defined to interpret. No plugin callback executes during candidate selection, fusion, reranking, ordering, or pagination, and plugin-private scores are ignored.

### Initial core feature catalog

The initial ranking contract has a closed core-owned feature catalog. Exact feature codes, value domains, extraction functions, and calibrations are versioned by the core query contract, but every feature belongs to one of these approved semantic families:

- Exact identity match: exact agreement with a requested canonical identity, qualified name, simple name, or normalized source path under the selected operation's declared matcher.
- Retrieval match: deterministic lexical term coverage and independently ranked semantic-lane position. Native lexical and semantic scores remain confined to their own lanes.
- Relationship role: the universal relation kind, direction, semantic role, and operation-defined relevance of the path connecting the candidate to an explicit target.
- Structural distance: direct versus transitive reachability and exact proven path depth under the operation's traversal contract.
- Scope proximity: exact shared artifact, module, package, project, or other canonical containment scope with an explicit target.
- Universal semantic fit: agreement with requested universal kinds, facets, effects, and architecture-neutral roles.
- Architectural role: canonical evidence that the candidate is an entry point, public contract, implementation, extension point, test, configuration surface, persistence boundary, event boundary, or another core-defined architectural role.
- Evidence directness: whether the selected supporting path is direct observation, deterministic derivation, or a longer valid evidence chain, without changing its approved classification or confidence.
- Result-subject preference: operation-defined preference among entity, canonical-record, and artifact subjects after the approved artifact/entity normalization rule.

Core profiles may select and weight only the families relevant to their declared intent. A feature must be computed from snapshot-pinned canonical data or core-derived projections and must use universal semantics; it cannot inspect a language namespace to create hidden language-specific behavior.

The initial profiles explicitly exclude popularity, raw caller or reference counts used as generic importance, file size, line count, file age, commit recency, change frequency, author identity, repository popularity, arbitrary naming-style heuristics, plugin-private scores, and other indirect proxies. Such signals cannot influence ordering merely because they are available. Introducing another signal requires an explicit core-contract decision, a versioned feature definition, reproducible evaluation, and a new affected profile version.

### Feature availability and completeness

Before ranking one result set, the core evaluates every selected profile feature against the complete snapshot-pinned query scope and relevant capability dimensions. A feature is active only when its declared source requirements have complete coverage across that whole scope. Candidate-local availability is insufficient: Urdira never applies a feature to covered candidates while silently assigning zero or a missing default to candidates whose required knowledge is incomplete.

When a feature lacks complete coverage and the operation accepts partial knowledge, Urdira omits that feature uniformly from the entire ranked result set. The `CompletenessReport` retains the affected capability, workspace bindings, registered reasons, affected artifacts when known, and relevant diagnostics. Unknown is never interpreted as false or zero. An inapplicable feature whose declared predicate is known not to apply remains distinct from an unavailable feature.

If the operation or request requires complete coverage for the missing capability, materialization fails with a structured operation error instead of changing the requirement or silently using a weaker order. A named recipe or operation contract declares which capability requirements permit explicit partial execution; plugins cannot make this choice.

The normalized plan and persistent `QueryExecution` pin the exact ranking profile plus the complete active and omitted feature sets and their availability causes. That selection participates in the query-plan hash. Later index or projection progress cannot activate another feature, improve completeness, or reorder an existing execution; a new execution is required. Uniform omission under an explicitly partial completeness report is the exact ordering contract for that degraded execution, not approximate candidate retrieval.

Feature values may be boolean, ordinal, integer, or exact rational values as declared by their definitions. Calibration maps each accepted raw value to an exact rational value. Profile weights are also exact rational values, and a feature contribution is the exact product of its calibrated value and profile weight. The final within-tier relevance score is the profile-defined combination of the exact reciprocal-rank-fusion score and every applicable feature contribution.

Rational values use a canonical reduced signed-numerator and positive-denominator structure with bounded magnitudes defined by the query contract. This is a schema-defined pair of existing UCE integer values, not a new UCE primitive or CBOR numeric tag. Addition, multiplication, comparison, ordering, persistence, and explanation use exact arithmetic; binary floating-point values and platform-dependent rounding cannot affect membership or order. A zero contribution is valid only when produced by the declared calibration or missing-value rule, never as an implicit fallback for an extraction failure.

During materialization, every computed contribution is bound to its feature code and version, raw typed value or declared missing state, calibrated value, profile weight, and exact contribution. The profile definition and digest pin the ordered feature set, coefficients, fusion parameters, aggregation rule, and canonical tie-breaking tuple. Changing any of those values creates a new profile version. These intermediate values are validated before ordering but need not be persisted or exposed after the ordered manifest is committed.

Learned rerankers are outside the initial public contract. A future learned profile would require a separately versioned deterministic model contract, pinned model assets, reproducible inference, evaluation thresholds, and an explanation contract; it cannot replace a transparent profile beneath the same identifier or version.

### Artifact and entity candidate normalization

Duplicate collapse occurs before rank fusion by normalizing every lane match to its exact `ResultSubject`. Repeated segments or semantic documents resolving to the same entity occurrence become one entity candidate; repeated matches resolving to the same artifact occurrence become one artifact candidate. All originating lanes, native ranks, scores, matched sections, source spans, and later fusion contributions remain attached to the normalized candidate until final ordering is materialized.

An artifact-view match is normalized to an entity result only when its source-mapped semantic content can be attributed unambiguously to exactly one visible entity occurrence in the same artifact version. This requires the artifact candidate's contributing source-text spans to be wholly represented by that entity's semantic document and requires no independently matched file-level content. Repeated path, identity, or container context does not prevent collapse because it is not source-text coverage. When this rule succeeds, the entity is the primary result, contributions from both views are accumulated before fusion, and the owner artifact remains available through provenance and source context.

An artifact remains an independent primary result when its match includes imports, exports not owned by one entity, top-level initialization, module documentation, configuration, markup, data, or any other source text not wholly represented by one entity. Ambiguous overlap, including content attributable to several nested or adjacent entities without one unique subject, is never collapsed heuristically. The artifact and entity candidates remain distinct; their ordinary provenance and source context preserve the reason they are separate without exposing ranking calculations.

Normalization never discards a lane contribution or silently moves evidence between subjects. It changes candidate identity only under the exact rule above, before the reciprocal-rank calculation, so duplicate views cannot consume separate result positions or distort final ranking.

Fusion cannot consume arbitrary per-lane top-N truncations. The executor either evaluates the complete eligible lane rankings or uses a threshold algorithm with conservative upper bounds and stops only after proving that no unseen candidate can enter or tie the requested materialized result domain. If that proof cannot be established within applicable limits, exact execution fails explicitly. Final ties use the contract's canonical stable sort key, ending with workspace participant ordinal, result-subject discriminator, and exact typed subject identifiers.

The final ordering tuple is closed. The possible stream first uses confidence tier (`high`, `medium`, `low`), while the confirmed stream has no such component. Both then use the selected profile's exact final rational relevance score in descending order. If scores remain mathematically equal, Urdira compares the workspace participant ordinal and then the UCE canonical bytes of the normalized `ResultSubject` under the query contract's pinned schema version. The resulting value is persisted as `ResultManifestEntry.stable_sort_key`.

This canonical fallback has no relevance meaning. It exists only to produce a total, portable, repeatable order. Name, path, file size, popularity, source age, discovery timing, database row identity, insertion order, thread scheduling, and other implicit values cannot participate in tie-breaking unless an approved profile has already modeled an allowed semantic feature before the fallback.

Ranking, reranking, duplicate handling, and stable ordering run once while the persistent `QueryExecution` is materialized. `QueryExecution` pins the exact internal ranking profile, and the query cache stores immutable ordered `ResultManifestEntry` sequences for the confirmed and possible streams without agent-facing ranking metadata. Forward and backward cursors only select slices of those manifests; they never repeat retrieval, graph expansion, scoring, fusion, or reranking. Later index, embedding, configuration, or ranking changes cannot affect an existing execution. If its cache entry expires, Urdira returns the approved cursor-expiration error instead of silently reexecuting the query.

## Dual document views

Every eligible textual artifact produces an artifact semantic document. Its source-text sections cover the complete decoded file without gaps, including imports, comments, top-level initialization, configuration, and text that is not represented by a canonical entity.

Entities produce additional documents for precise functions, types, endpoints, tests, modules, and other source-owned semantic units. Entity documents complement rather than replace the artifact view.

Documents use deterministic structured sections containing relevant path, language, identity, signature, documentation, implementation, locally observed relationship names, source content, and keywords. Generated natural-language summaries are forbidden in the base contract.

A document remains local to one owner artifact. It may render locally observed qualified names but cannot copy foreign code or documentation. Cross-file context is supplied later through the canonical graph and ranking stages, preventing one foreign change from forcing a transitive repository-wide re-embedding cascade.

## Eligibility

All textual artifacts inside configured source scope are eligible by default, including prose, configuration, markup, data, and unclassified text. Binaries are represented as explicit exclusions. Generated, minified, vendored, or very large files may be excluded only by visible deterministic policy.

User-selected exclusions change the declared scope and do not make that scope incomplete. A textual artifact inside scope that cannot be decoded, documented, segmented, or supported by the selected profile degrades semantic completeness. Every eligibility and coverage decision retains the exact artifact version and a registered reason.

## Segmentation

Semantic documents are independent from embedding models. Segments are profile-specific because tokenizer behavior, templates, and token limits are profile properties.

Segmentation priority is:

1. Plugin-provided semantic region.
2. Plugin-provided semantic subregion.
3. Contiguous packing of semantically compatible adjacent regions.
4. Deterministic overlapping windows as the final fallback.

Unrelated non-contiguous regions cannot be packed merely to fill the model window. Every segment maps exact UTF-8 ranges back to ordered `SourceSpan` values, has a primary source location, stores the exact rendered model input, and declares its token count. Silent truncation is forbidden.

The union of primary segment parts for an artifact document covers every source-text byte. Repeated path, identity, or container context does not count as source coverage and is never returned as if it were a source snippet.

## Immutable embedding profiles

An embedding profile permanently identifies one vector space, including exact model and tokenizer identities, document and query input renderers, segmentation contract, token limits, dimensions, element representation, byte encoding, normalization, distance metric, language support, and content classes.

Any behavior change capable of changing segmentation, model input, vector bytes, or score semantics creates a new profile identifier. Profile definition revisions may improve description or guidance only.

The concrete default local model is deliberately not selected yet. It will be chosen through reproducible multilingual code-retrieval evaluation. Model choice does not change the public semantic contracts.

## Canonical vector output

Vector projection payloads contain canonical bytes rather than an opaque vector-database row identifier. The profile defines dimensions, element representation, packing, byte order, normalization, and distance semantics. The vector digest covers the exact bytes; the projection content digest additionally covers profile, segment, generator, ownership, and provenance.

Generators must be byte deterministic for the same input, profile, exact local runtime-build implementation digest, and output-affecting configuration. Non-finite vectors, invalid lengths, incompatible normalization, and mismatched input digests are rejected before publication.

Ordinary agent responses never return raw vector bytes. A physical vector engine may deduplicate, compress, or index them without changing the logical projection.

## Multiple languages and profiles

One vector retrieval lane uses exactly one profile, generator lock, and vector space. A composed query may execute several independent lanes when no one model covers every selected language or content class.

Raw similarity scores from different spaces are never compared directly. A later deterministic fusion stage may combine independently ranked lists while preserving each match's original profile and similarity.

Unsupported languages or content inside query scope produce explicit semantic coverage gaps. Plugins remain free to introduce new language identifiers and semantic section kinds through the registry without changing the core engine or public query algebra.

`EmbeddingProfile.language_support` applies only to indexed programming and content-language classifications. Urdira does not detect or assign a human language to a project, artifact, section, or query. Profiles instead declare the structural query classes they accept: `natural_text`, `identifier`, `source_code`, and `mixed`. The normalized operation supplies that class from its typed input shape rather than guessing from query text. Human-language quality, including multilingual behavior, is a model-evaluation property and descriptive guidance, not a routing key or completeness claim.

## Core-owned embedding infrastructure and plugin semantic preparation

Urdira owns every `EmbeddingProfile` and every component capable of changing vector bytes: model and tokenizer assets, document and query renderers, segmenters, generators, inference runtimes, vector encoding, normalization, and distance semantics. The distribution ships with at least one complete generic local code profile and may offer additional core-owned profiles through integrity-verified data-only Urdira model packs. A pack may contain immutable weights, tokenizer data, templates, declarative configuration, profile definitions, provenance, licenses, and evaluation metadata, but no executable code, bytecode, native library, script, command hook, callback, or runtime implementation. It references platform-neutral behavior releases; compatible executable builds are supplied and verified separately by the exact local Urdira installation. Supporting a new model architecture therefore requires an Urdira engine update rather than execution of pack-provided code. Language and framework plugins cannot register, package, replace, or execute embedding infrastructure.

The logical pack is a deterministic canonical manifest plus its complete digest-addressed asset set. Offline bundles and explicit online installation are alternate delivery paths to the same local content. Delivery locators and transport packaging do not affect pack identity. A pack becomes selectable only after every required asset and engine-component reference verifies locally and the installation publishes atomically. Semantic document generation, vector generation, retrieval, and query replay never fetch missing assets from the network.

The manifest embeds a non-empty canonical set of complete `EmbeddingProfile` definitions rather than referencing a separate definition asset. Installation recomputes every `profile_digest` and validates all referenced assets and core runtime contracts before profile registration. Every profile has one exact segmenter and one exact generator `ModelPackRuntimeConfiguration` envelope whose closed typed values are schema-bound to the selected core components. Identical profile definitions supplied by several packs share one portable registry meaning only when all four behavior requirements and both runtime configurations also match; any portable difference under the same profile ID is rejected. Workspace activation then resolves four exact local builds into an executable binding.

Plugins instead contribute model-independent knowledge used by the core semantic pipeline: canonical records, semantic sections, language-aware regions and subregions, exact source mappings, locally observed relationship context, diagnostics, and coverage. Those inputs can improve document construction and segmentation without coupling the plugin to one neural model. The core profile remains solely responsible for transforming the normalized semantic document into model input and canonical vectors.

A plugin compatibility declaration may include a duplicate-free ordered `recommended_embedding_profile_ids` list. It never declares compatibility: each core profile's own language, content-class, and query-class contracts are the sole compatibility source. During construction of a new workspace configuration, the core skips unknown, unavailable, policy-forbidden, or incompatible recommendations and uses the first usable entry for each semantic scope. An installed recommendation may therefore enter the new active configuration even when it was not active previously. If none qualifies, the resolver selects Urdira's generic core profile when compatible. Recommendations are advisory installation and configuration metadata, not embedding definitions, dependencies, direct activation commands, or query-time decisions. Explicit workspace policy may replace the default; the exact resolved profile set is published and pinned before indexing.

Embedding-profile and model-pack activation are independent from structural plugin activation. Missing core model assets never disable parsing, symbol resolution, relation extraction, evidence, diagnostics, or another valid plugin capability. When a new workspace configuration requires a profile, configuration activation verifies every core-owned component and asset before publication; failure leaves the previously published configuration and materializations unchanged. Once a verified profile is active, an artifact-specific or transient generation failure follows the approved pending or degraded coverage lifecycle and does not roll back otherwise valid structural snapshot publication.

Adding, removing, or changing an active core profile creates a new configuration revision and new semantic materializations; it never rewrites an existing materialization. Several profiles may be active concurrently, and each distinct vector space remains an independent retrieval lane.

### Profile fallback resolution

Embedding fallback is a configuration-resolution decision made before indexing, never a runtime substitution. Workspace configuration may activate the generic core profile alongside a specialized profile or may declare a fallback policy whose resolution publishes another explicit configuration revision before any replacement materialization is built. The resolved active profile and exact executable-binding set is pinned by the workspace snapshot and each semantic materialization.

Once a profile has been selected for a materialization, missing assets, runtime incompatibility, generation failure, or temporary unavailability cannot cause Urdira to emit vectors from another profile under that materialization. A generic vector is not a substitute for a specialized vector even when both cover the same source language. Their profile identifiers, input contracts, dimensions, bytes, metrics, and vector spaces remain distinct.

A selected-profile failure therefore produces `pending`, `failed`, `unsupported`, or `unavailable` semantic state under the approved coverage rules. Queries may continue only with other profiles that were already independently activated and materialized, and their lanes remain explicit. Moving future work to a generic or replacement profile requires another configuration revision and new materialization; retained snapshots and cursor-pinned executions keep their original profile bindings.

### Automatic active-lane selection

Normal semantic and hybrid operations do not accept embedding-profile identifiers. For each ranked scope, the core selects every profile that is active in the pinned workspace configuration, has a materialization in the selected snapshot, covers the relevant indexed language and content classes, and accepts the operation's deterministic query class. Installed but inactive profiles are never added during query execution.

The core renders and embeds the query independently under every selected profile and searches only that profile's exact vector space. All selected lanes are recorded in the complete ordered `QueryExecution.semantic_index_bindings` set before retrieval, then combined only through the core-owned fusion contract. The agent expresses search intent and structural filters rather than model topology.

All selected active lanes form part of the configured semantic contract for that execution. If any one is pending, failed, unsupported, or unavailable for relevant scope, the semantic completeness dimension is non-complete even when another selected lane covers the same artifacts. Coverage by a different vector space cannot prove that the missing lane would add no candidates or change no ordering. The response's semantic coverage views identify the affected scope without requiring the agent to choose another profile.

Profile activation, materialization progress, or compatibility changes after execution start cannot add, remove, or replace a lane. Every continuation page preserves the original binding set, lane coverage, completeness, candidate order, and result manifest.

No plugin code executes during semantic query planning, query rendering, query-vector generation, retrieval, fusion, ranking, or pagination. The core uses the already indexed model-independent plugin knowledge plus its own selected profile and component lock. Query input never crosses into a language-plugin runtime.

## Incremental update lifecycle

Source modification or deletion closes old semantic projections in the same published generation that closes their source occurrence. A changed or deleted file's old vector is never visible in the new snapshot.

Vector generation does not block publication. Semantic reconciliation is admitted as background work, checks foreground query pressure before each document and vector commit, and caps each semantic commit at 16 vector updates. Queries remain pinned to their admitted structural snapshot and compatible semantic materialization; a paused semantic lane is reported as updating rather than exposing a mixed generation:

1. The source generation publishes new documents and segments when available and marks missing vectors as pending.
2. Semantic and hybrid queries may use unaffected vectors, with explicit partial coverage.
3. Completed vector work publishes through a later projection-only generation.
4. Work based on an obsolete snapshot is rejected and replanned.
5. Reappearance after closure creates new projection and coverage identities, even for identical content.

Temporary absence is preferred to stale presence: a result may be missing while embeddings update, but removed or superseded code cannot remain discoverable through the current snapshot.

## Reuse across files and workspaces

Vector computation may be physically reused only when the embedding input digest, profile identity, generator identity, generator version, resolved runtime-component implementation digest, and generator configuration digest are identical. Reuse shares numeric bytes, not logical identity.

Model packs are portable across supported systems, but semantic materializations are exact-build artifacts. Moving an index to a host without the same runtime-build implementation digests preserves canonical structural knowledge but makes those semantic materializations unavailable. Urdira resolves platform-appropriate builds into a new executable binding and rebuilds embeddings; it never treats vectors from another build as if their provenance were unchanged.

Different executable bindings under the same portable profile are separate vector lanes. Their vectors are never mixed in one index or compared through raw similarity; cross-workspace comparison ranks each lane independently and uses the same deterministic fusion stage applied to different profile spaces.

Every workspace still owns independent documents, segments, vectors, artifact coverage, source versions, and validity intervals. A reused vector remains independently invalidatable by its owner artifact. Content reappearance can reuse computation while creating a new logical occurrence.

## Materialization and coverage

Each published snapshot has an immutable semantic materialization for every available profile. It pins the profile, generator, queryable vector set, pageable artifact coverage manifest, exact counts, and aggregate state.

States are:

- `complete`: all included compatible artifacts are covered, including a valid empty corpus.
- `updating`: scheduled vector work is still pending and no permanent gap exists.
- `degraded`: failed or unsupported included content exists while some semantic results remain usable.
- `unavailable`: the materialization cannot supply its retrieval contract because its vector set is missing or unreadable; zero matches or a fully covered empty corpus do not make it unavailable.

An artifact is `covered`, `pending`, `excluded`, `unsupported`, or `failed`. Explicit exclusions are outside the effective semantic scope. Pending, unsupported, and failed entries are affected artifacts.

Every semantic query response always repeats a compact coverage view. It includes counts and an initial bounded page of affected artifact paths. Large affected sets are immutable, bidirectionally pageable, and share the query execution lifetime.

The query `CompletenessReport` includes `core:semantic_retrieval`. Updating coverage is `partial`, not an empty complete result. The report and coverage views remain unchanged through result pagination.

## Query embedding lifecycle

Query embeddings are ephemeral execution values, not source projections. They use the exact profile and generator lock of their semantic lane. After the ordered result manifest is materialized, query input and vector values may be discarded without affecting cursors.

Local privacy policy may retain query embeddings for less time than the query execution. Snapshot, materialization, profile, completeness, and final result order remain pinned independently.

## Error behavior

- A hybrid query may continue with lexical or structural lanes while clearly reporting semantic degradation.
- A required semantic-only stage with no usable index returns `core:semantic_index_unavailable`.
- Invalid profile identifiers or incompatible profile selections in configuration and administrative validation return their specific stable errors. Normal semantic and hybrid query operations have no profile selector and therefore cannot require an agent to discover model identifiers first.
- A query requiring complete semantic coverage may wait up to its explicit limit. If coverage remains incomplete, it returns `core:semantic_coverage_incomplete` rather than silently relaxing the requirement.
- Persistent artifact-specific document, segmentation, or embedding failures publish explicitly produced source diagnostics.
- Private build failures remain `CandidateIssue` values and never become diagnostics automatically.

## Migration and retention

A new profile builds in parallel with the old profile. The configuration selects which profile new query plans use; it does not rewrite old materializations. Different vector spaces can coexist but never share a retrieval lane.

Retained snapshots retain their documents, segments, vectors, materialization manifests, profiles, registry definitions, and original generator lock. Existing paginated executions need only their result manifests and source hydration state, not the original query vector.

A historical semantic query requires the original model and generator assets. Such assets cannot be collected while policy promises semantic queryability for a reachable materialization. Exact physical asset storage and collection are owned by the storage and lifecycle specifications.

## Normative validation scenarios

The eventual implementation must verify:

- Complete textual byte coverage and exact source mapping.
- Bit-deterministic embedding generation.
- Immediate negative invalidation on modification and deletion.
- New logical identity after identical reappearance.
- Rejection of stale concurrent builds.
- Independent ownership under cross-workspace computation reuse.
- Parallel profile migration without raw-score mixing.
- Snapshot and cursor retention.
- Explicit updating, degraded, and failed completeness.
- Bidirectional affected-artifact pagination under response budgets.
- Scope exclusion before document, input-cache, or vector generation.
- Rebuild of exact-result-preserving physical indexes from the same logical vectors.

Representative fixtures must include JavaScript/TypeScript, Rust, prose or configuration with no code entities, and a mixed-language artifact.

### Representative fit examples

- A TypeScript file containing imports, top-level initialization, `authorizePayment`, and `capturePayment` produces one complete artifact document plus separate callable documents. The artifact segments retain imports and initialization even though neither needs a standalone entity; callable matches resolve to their exact entity records and spans.
- A Rust file containing attributes, a trait, an `impl` block, macros, and free functions uses Rust-provided semantic regions and section kinds while the core document, segment, vector, ownership, and query contracts remain unchanged.
- A Markdown architecture guide with no code entity still produces one complete artifact document and source-mapped sections, so conceptual search can retrieve it as an exact artifact result.
- A mixed-language component assigns language IDs per section. One multilingual profile may cover all sections, or independent lanes may cover different languages. Unsupported sections remain explicit coverage gaps and raw scores from those lanes are never mixed.

## Approved registries

The design adds registered semantic section kinds, semantic reasons, and immutable embedding profiles. Initial core projection kinds are:

- `core:semantic_eligibility`
- `core:semantic_document`
- `core:embedding_segment`
- `core:embedding_vector`

Initial section kinds are:

- `core:path`
- `core:identity`
- `core:signature`
- `core:documentation`
- `core:implementation`
- `core:relationship_context`
- `core:source_content`
- `core:keywords`

The initial projection, section, semantic reason, and completeness definitions are documented in [Core semantic registry](../semantic/core-semantic-reasons.md). Source diagnostic definitions remain in [Core diagnostic codes](../diagnostics/core-diagnostic-codes.md).

## Release-bound semantic registries

The architecture deliberately does not hard-code one model asset or learned weight set into this decision. Those are immutable release data selected by the evaluation policy, represented through the already approved registries, and pinned by every workspace configuration and execution.

Every Urdira release must ship one active generic profile through a preinstalled data-only model pack. Its acceptance contract requires local CPU execution, the four structural query classes, source-code and prose content, the MVP language set, deterministic vector bytes under each shipped runtime build, and the quality and resource gates in the performance specification. The release manifest publishes the exact pack coordinate, profile digest, model and tokenizer digests, runtime requirements, configurations, supported languages/content classes, and evaluation-report digest. Changing any of those values creates another pack/profile definition and never mutates retained materializations.

The initial ranking feature codes are `core:exact_identity_match`, `core:retrieval_match`, `core:relationship_role`, `core:structural_distance`, `core:scope_proximity`, `core:universal_semantic_fit`, `core:architectural_role`, `core:evidence_directness`, and `core:result_subject_preference`. Their value domains are respectively boolean, ordered lane rank, registered relation-role class, non-negative hop count, registered scope-distance class, registered universal-fit class, registered architectural-role class, registered evidence-derivation class, and registered result-subject class.

Each operation ranking profile converts those typed values through a closed monotonic rational calibration table and combines them with exact rational weights. The profile registry stores every table entry, weight, feature-availability requirement, fusion constant, and final ordering tuple. Calibration may reward or penalize only according to the feature definition; no unregistered value, missing-value guess, floating-point coefficient, or runtime-learned parameter is legal. Release evaluation chooses the numeric values and records the evaluation-report digest. Any numeric change creates a new profile version and changes the query-plan hash.

Evaluation datasets, metrics, acceptance thresholds, performance budgets, and privacy defaults are normative in the performance and configuration specifications. They are release gates rather than unresolved semantic behavior.

## Completion criteria

This decision is architecturally complete. A concrete release is acceptable only when its immutable model pack and ranking-profile registry pass the semantic, deterministic, resource, and privacy gates defined by the dependent specifications.
