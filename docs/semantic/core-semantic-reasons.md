# Core Semantic Registry

Status: **Approved initial registry**  
Last updated: 2026-08-08  
Depends on: [Universal data model](../decisions/01-universal-data-model.md) and [Semantic search and ranking](../decisions/06-semantic-search-ranking.md)

## Registry contract

This file is the authoritative initial registry for core semantic projection kinds, semantic section kinds, `SemanticReasonDefinition` values, and the paired `CompletenessReasonDefinition` values used by semantic retrieval. Every definition has `definition_revision: 1`, `schema_version: 1`, `plugin_owner` omitted, and `lifecycle_state: active`. Lifecycle and replacement fields are omitted.

A semantic reason explains one artifact eligibility or coverage state. It does not replace a source diagnostic, private `CandidateIssue`, or operation error. A reason with `completeness_reason_code` degrades query completeness exactly through that paired definition. A reason without that mapping describes an intentional scope decision and cannot degrade completeness.

No initial `EmbeddingProfile` is registered yet. The default local profile will be added only after model evaluation; the profile schema and activation rules are already approved.

## Projection kind definitions

| Projection kind | Description | Payload schema | Generator contract version |
|---|---|---|---:|
| `core:semantic_eligibility` | Deterministic source-owned semantic eligibility for one artifact occurrence. | `DerivedSemanticEligibility` payload | 1 |
| `core:semantic_document` | Model-independent artifact or entity retrieval document with exact section provenance. | `DerivedSemanticDocument` payload | 1 |
| `core:embedding_segment` | Profile-specific, token-bounded embedding input mapped to one semantic document and exact source spans. | `DerivedEmbeddingSegment` payload | 1 |
| `core:embedding_vector` | Canonically encoded deterministic vector for one exact embedding segment. | `DerivedEmbeddingVector` payload | 1 |

Each row is a complete `ProjectionKindDefinition` with the common revision, schema, ownership, and lifecycle values stated above. `payload_schema` is the closed model referenced in the table. A generator must satisfy the selected contract and the stronger invariants in the semantic-search decision.

## Semantic section kind definitions

| Section kind | Description | Allowed origin kinds | Agent guidance |
|---|---|---|---|
| `core:path` | Normalized artifact address and source-location context. | `artifact_metadata` | Use as retrieval context, never as source code. |
| `core:identity` | Deterministic subject name, qualified name, kind, and containing identity. | `record_rendering`, `artifact_metadata` | Use to resolve the match back to its canonical subject. |
| `core:signature` | Source or canonical rendering of a callable, type, declaration, schema, or equivalent interface signature. | `source_text`, `record_rendering` | Prefer the source span when presenting code. |
| `core:documentation` | Source-owned comments, docstrings, prose, or documentation attached to the subject. | `source_text`, `record_rendering` | Treat rendered metadata as context and source text as citable content. |
| `core:implementation` | Source-owned implementation body or semantically bounded implementation region. | `source_text` | This section contributes primary source coverage. |
| `core:relationship_context` | Deterministic local rendering of names and kinds from canonical relations observed in the owner artifact. | `record_rendering` | It names discovery context but does not prove a relationship to the query. |
| `core:source_content` | Generic source text not represented more precisely by another section kind. | `source_text` | This section ensures complete artifact-level text coverage. |
| `core:keywords` | Deterministic normalized retrieval terms derived from local source or canonical records. | `source_text`, `record_rendering`, `artifact_metadata` | Keywords affect discovery only and are not independent facts. |

Every row is a complete `SemanticSectionKindDefinition` with the common values stated above. Plugins may register more precise section kinds in their namespaces, but cannot weaken origin or source-provenance validation.

## Semantic reason definitions

### `core:binary_not_semantic_text`

| Definition field | Value |
|---|---|
| Description | The artifact content is binary under the pinned decoder contract and is not semantic-text input. |
| Allowed eligibility statuses | `excluded` |
| Allowed coverage statuses | `excluded` |
| Completeness mapping | None |
| Exact trigger | The decoder deterministically classifies the complete artifact occurrence as binary before semantic document construction. |
| Does not mean | It does not mean the artifact is corrupt, irrelevant, or outside the general source catalog. |
| Agent guidance | Treat the artifact as explicitly outside semantic-text scope; use metadata or a format-specific plugin if available. |

### `core:excluded_by_semantic_policy`

| Definition field | Value |
|---|---|
| Description | An explicit pinned configuration rule excludes the artifact from semantic indexing. |
| Allowed eligibility statuses | `excluded` |
| Allowed coverage statuses | `excluded` |
| Completeness mapping | None |
| Exact trigger | At least one recorded policy rule selects exclusion and no higher-priority rule includes the artifact. |
| Does not mean | It does not mean the content is unsupported or that semantic generation failed. |
| Agent guidance | Inspect the matched policy rule when the excluded artifact should participate in semantic search. |

### `core:text_decoding_unsupported`

| Definition field | Value |
|---|---|
| Description | Text is inside semantic scope, but no active deterministic decoder can produce the required complete text representation. |
| Allowed eligibility statuses | `unsupported` |
| Allowed coverage statuses | `unsupported` |
| Completeness mapping | `core:semantic_content_unsupported` |
| Exact trigger | The artifact is not classified as binary, yet its declared or detected encoding is unsupported by the pinned decoder contract. |
| Does not mean | It does not mean that the source bytes are invalid for every external decoder. |
| Agent guidance | Semantic results may omit this artifact; add a compatible decoder or change the pinned source configuration. |

### `core:semantic_document_failed`

| Definition field | Value |
|---|---|
| Description | Deterministic semantic-document construction failed for an included artifact occurrence. |
| Allowed eligibility statuses | `failed` |
| Allowed coverage statuses | `failed` |
| Completeness mapping | `core:semantic_projection_failed` |
| Exact trigger | Semantic scope selection succeeds, but eligibility text preparation or document generation terminates unsuccessfully or produces invalid output. |
| Does not mean | It does not mean parsing, canonical extraction, or the source program as a whole failed. |
| Agent guidance | Inspect `core:semantic_document_generation_failed`; lexical and structural results may remain valid. |

### `core:embedding_profile_language_unsupported`

| Definition field | Value |
|---|---|
| Description | The selected embedding profile does not declare support for a language present in the artifact. |
| Allowed eligibility statuses | None |
| Allowed coverage statuses | `unsupported` |
| Completeness mapping | `core:semantic_content_unsupported` |
| Exact trigger | The profile uses explicit language support and at least one source-text region required by the selected semantic lane has an unsupported classified language. |
| Does not mean | It does not mean another profile or non-semantic retrieval cannot search the artifact. |
| Agent guidance | Treat semantic results for the affected language as incomplete and use valid lexical or structural results. Activating a compatible core profile is an administrative workspace-configuration action, not a query option. |

### `core:embedding_profile_content_unsupported`

| Definition field | Value |
|---|---|
| Description | The selected profile does not support the artifact's textual content class. |
| Allowed eligibility statuses | None |
| Allowed coverage statuses | `unsupported` |
| Completeness mapping | `core:semantic_content_unsupported` |
| Exact trigger | Eligibility succeeds, but the artifact content class is absent from the profile's supported content classes. |
| Does not mean | It does not classify the content as binary or globally unsupported. |
| Agent guidance | Treat semantic results for the affected content as incomplete and rely on lexical or structural retrieval when allowed. Activating a supporting core profile is an administrative workspace-configuration action, not a query option. |

### `core:embedding_vectors_pending`

| Definition field | Value |
|---|---|
| Description | One or more current embedding segments have scheduled vector work that is not yet published. |
| Allowed eligibility statuses | None |
| Allowed coverage statuses | `pending` |
| Completeness mapping | `core:embedding_projection_updating` |
| Exact trigger | At least one current segment lacks a vector and an active or scheduled candidate work item covers it. |
| Does not mean | It does not indicate failure, stale-vector use, or unsupported content. |
| Agent guidance | Treat semantic results as potentially incomplete for the listed artifacts and retry after index progress advances. |

### `core:embedding_segmentation_failed`

| Definition field | Value |
|---|---|
| Description | The profile-specific segmenter failed or could not satisfy source coverage and token-limit invariants. |
| Allowed eligibility statuses | None |
| Allowed coverage statuses | `failed` |
| Completeness mapping | `core:semantic_projection_failed` |
| Exact trigger | Document construction succeeds, but segmentation terminates unsuccessfully or produces invalid coverage, mapping, ordering, or token counts. |
| Does not mean | It does not mean the semantic document or canonical source model is invalid. |
| Agent guidance | Inspect `core:embedding_segmentation_failed`; results for successful artifacts and non-semantic capabilities remain usable. |

### `core:embedding_generation_failed`

| Definition field | Value |
|---|---|
| Description | The pinned generator failed to produce a valid deterministic vector for one or more current segments. |
| Allowed eligibility statuses | None |
| Allowed coverage statuses | `failed` |
| Completeness mapping | `core:semantic_projection_failed` |
| Exact trigger | Inference fails or output violates profile dimensions, encoding, normalization, finiteness, digest, or determinism requirements. |
| Does not mean | It does not mean the source content is semantically irrelevant or unsupported by every embedding profile. |
| Agent guidance | Inspect `core:embedding_generation_failed`; retry only when its payload and recovery state permit it. |

## Paired completeness reason definitions

### `core:embedding_projection_updating`

| Definition field | Value |
|---|---|
| Description | Current semantic vectors are still being generated after negative invalidation removed superseded vectors. |
| Allowed statuses | `partial` |
| Affected capabilities | `core:semantic_retrieval` |
| Agent guidance | Returned semantic candidates are valid but may not be exhaustive; inspect the semantic coverage view before concluding that no match exists. |

### `core:semantic_content_unsupported`

| Definition field | Value |
|---|---|
| Description | Included textual content cannot be represented by the selected decoder or embedding profile. |
| Allowed statuses | `partial`, `unsupported` |
| Affected capabilities | `core:semantic_retrieval` |
| Agent guidance | Do not treat missing semantic matches as exhaustive. Use an allowed lexical or structural path; changing the decoder or active core profiles requires administrative workspace reconfiguration and reindexing. |

### `core:semantic_projection_failed`

| Definition field | Value |
|---|---|
| Description | Source-owned semantic document, segmentation, or embedding generation failed for part of the selected scope. |
| Allowed statuses | `partial`, `unknown` |
| Affected capabilities | `core:semantic_retrieval` |
| Agent guidance | Inspect cited diagnostics and affected artifacts; do not interpret missing semantic matches as exhaustive. |

### `core:semantic_index_unavailable`

| Definition field | Value |
|---|---|
| Description | No queryable semantic materialization exists for a required workspace binding and profile. |
| Allowed statuses | `unsupported` |
| Affected capabilities | `core:semantic_retrieval` |
| Agent guidance | Use an allowed lexical or structural fallback or wait for a materialization to publish. Activating or repairing a usable core profile is an administrative workspace-configuration action. |

### `core:semantic_query_generator_unavailable`

| Definition field | Value |
|---|---|
| Description | Indexed vectors exist, but the exact pinned query-vector generator is unavailable. |
| Allowed statuses | `unsupported` |
| Affected capabilities | `core:semantic_retrieval` |
| Agent guidance | Restore the exact generator assets; Urdira will not substitute another runtime silently. |

## Consistency rules

- `pending` always maps to `partial`; it never maps to `stale` because obsolete vectors have already been removed from the snapshot.
- An excluded artifact has no completeness mapping and is not included in affected-artifact counts.
- `unsupported` may produce overall `partial` when another lane or scope portion remains usable, or `unsupported` when a required semantic capability has no accepted fallback.
- A failed artifact cites the matching source diagnostic. The semantic reason explains coverage; the diagnostic explains the concrete occurrence.
- Workspace-wide runtime absence has no fictitious source diagnostic. It uses completeness metadata and, when the semantic stage is mandatory, a structured operation error.
