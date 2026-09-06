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

## Amendment 2026-09-06 (Frente S-A): per-document status table

"Coverage reports artifact and entity totals separately" (above) is now
backed by a real per-document ledger, `semantic_document_status`
(`packages/storage/sql/workspace-v4-semantic.sql`, mirrored additively into
`workspace-v3.sql` so the one shared reconciler implementation works
unmodified against either schema). One row per `(workspace_id, profile_id,
executable_binding_id, document_grain, document_id)` -- `document_id` is the
artifact version id for an artifact-grain row, the owning entity record id
for an entity-grain row -- carrying `status` (`covered | pending | excluded |
unsupported | failed`) and a sorted JSON `reason_codes` array from a fixed
vocabulary: `binary`, `oversized`, `below_min_length`, `unsupported_kind`,
`provider_error:*`, `segments_truncated` (segmentation is a later increment;
no row uses this code yet), `pending_embed`.

The reconciler writes this table in the SAME per-document enumeration it
already runs for embedding (steps 3/5 of `reconcileSemanticProjection`):
`covered` commits in the same transaction as the vector write; permanent
skips (oversized, undecodable/binary content, empty rendering, ineligible
entity kind/span) are written as `excluded` or `unsupported` at the exact
point they are classified; a provider throw or a post-generation digest
mismatch is written `failed` with a `provider_error:*` reason. Two
bulk-classification passes (binary artifact versions and whole-file/module
"container" entity records -- both excluded from the reconciler's own
missing-document queries by their `WHERE` clauses, so they would otherwise
never reach the ledger at all) and a backfill pass (covering a sidecar that
predates this table, populated from `vector_projection_rows` directly) run
once per reconcile pass, each scoped by a `NOT EXISTS` against the status
table itself so they cost nothing once the corpus has been classified. An
orphan sweep deletes a document's row when its underlying artifact
version/entity record stops being visible, closing the gap the ordinary
stale-close joins (scoped to documents that had an OPEN vector) cannot
cover: a `pending`/`excluded`/`unsupported`/`failed` document that never had
a vector at all.

`core:search_semantic`/`core:search_hybrid`'s coverage view and the new
`core:semantic_affected_page` operation both read this table exclusively for
`unsupported`/`failed`/entity counts and the affected-document list -- see
[Semantic search and ranking](06-semantic-search-ranking.md)'s own 2026-09-06
amendment for the pagination mechanism built on top of it.
