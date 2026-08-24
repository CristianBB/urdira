# Entity-Grain Semantic Documents

Status: **Approved and implemented**
Last updated: 2026-08-24
Depends on: [Semantic search and ranking](06-semantic-search-ranking.md) and [semantic runtime](16-semantic-search-wiring.md)

## Current contract

Semantic maintenance publishes two document grains under the same exact
provider identity:

- one artifact document for each eligible textual artifact; and
- one entity document for each eligible visible source entity.

Entity documents allow semantic and hybrid queries to return a declaration and
its exact source span instead of only the containing file.

## Eligibility and rendering

An entity is eligible when it is top-level or exported, belongs to a supported
source kind, and meets the configured minimum source length. Parameters,
locals, module/whole-file entities, invalid spans, oversized inputs, empty
renderings, and unsupported content are excluded with explicit maintenance
counts.

The entity policy is deterministic and contributes an
`entity_policy_digest`. Changing eligibility or rendering therefore makes the
previous semantic completion marker inapplicable.

An entity document contains its kind, qualified name, leading documentation
when available, and bounded source-span text. Its `document_id` is derived from
the owning visible record and its `document_ref` identifies that exact record.
The vector row retains the artifact owner and declaration span used to render
the document.

## Maintenance

Artifact and entity lanes share the same generation-held-still rule, provider
identity, failure semantics, and stale-close discipline. Maintenance:

1. closes rows whose source artifact, entity record, provider, or policy is no
   longer current;
2. reuses exact current rows;
3. embeds missing eligible documents under bounded provider batches; and
4. advances `semantic_index_state` only when both grains have completed for the
   same structural generation.

The completion marker contains
`document_grains: ["artifact", "entity"]` and the current
`entity_policy_digest`. A marker without either proof is incomplete and causes
the missing lane to be reconciled.

Embedding failure leaves the affected row absent and withholds the completion
marker. It never publishes a partial row under `complete` coverage and never
invalidates the structural snapshot.

## Query behavior

`core:search_semantic` filters artifact and entity candidates through
`subject_types`. Hybrid retrieval fuses lexical, semantic-artifact, and
semantic-entity lanes through the registered deterministic rank-fusion rules.

Entity candidates hydrate through their owning record and preserve the exact
source span. Artifact and entity rows are deduplicated within their own
identity domains; an entity result is not collapsed into its owner artifact.

Coverage reports artifact and entity totals separately. A missing entity lane
cannot be represented as complete merely because artifact vectors are current.

## Current boundary

Primary retrieval scans document vectors. Urdira does not currently publish a
separate persisted per-window segment-vector lane, and it does not use an ANN
index. Long-document windowing remains an internal provider operation whose
pooled document vector participates in exact scan.

Cross-workspace vector sharing is unsupported. Content-identical documents
under different workspace/provider bindings are reconciled independently.
