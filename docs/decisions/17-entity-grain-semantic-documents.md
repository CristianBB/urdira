# Entity-Grain Semantic Documents

Status: **Accepted**
Last updated: 2026-09-08
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

A per-document ledger, `semantic_document_status` (one row per
`(workspace_id, profile_id, executable_binding_id, document_grain,
document_id)`), backs the coverage totals above with `status` (`covered |
pending | excluded | unsupported | failed`) and a sorted `reason_codes` array
from a fixed vocabulary (`binary`, `oversized`, `below_min_length`,
`unsupported_kind`, `provider_error:*`, `segments_truncated`,
`pending_embed`). The reconciler writes it in the same per-document
enumeration it already runs for embedding; an orphan sweep deletes a
document's row once its underlying artifact version or entity record stops
being visible. `core:search_semantic`/`core:search_hybrid`'s coverage view
and `core:semantic_affected_page` read this table exclusively for
`unsupported`/`failed`/entity counts and the affected-document list (see
[Semantic search and ranking](06-semantic-search-ranking.md)).

## Query behavior

`core:search_semantic` filters artifact and entity candidates through
`subject_types`. Hybrid retrieval fuses lexical, semantic-artifact, and
semantic-entity lanes through the registered deterministic rank-fusion rules.

Entity candidates hydrate through their owning record and preserve the exact
source span. Artifact and entity rows are deduplicated within their own
identity domains; an entity result is not collapsed into its owner artifact.

Coverage reports artifact and entity totals separately. A missing entity lane
cannot be represented as complete merely because artifact vectors are current.

## Segmentation and per-segment entity vectors

Every provider segments a document's rendered text into 256-token windows
(MiniLM's own trained `max_seq_length`) with a 32-token overlap, so a match
spanning a window boundary is never split into two half-strength vectors, up
to `max_segments` (default 64, `DEFAULT_MAX_SEGMENTS`; exceeding it sets
`truncated: true`, surfaced as the `segments_truncated` reason code, never
silent). The entity lane writes one `vector_projection_rows` row PER SEGMENT,
uncapped; `semantic_document_status` still holds exactly one row per
document, aggregated from every segment's own outcome (`covered` only once
every segment settles clean; a `failed` aggregate closes every sibling
segment so the whole document retries from scratch). The artifact-grain lane
stays one vector per document: when a file's entities were embedded in the
same reconcile pass, the artifact vector is composed from the mean of those
entity vectors plus the embedding of the file's remaining ("gap") text —
never a fresh whole-file embed when entity coverage already exists — and
otherwise falls back to embedding the whole file directly.

A segmenter-parameter change folds into every provider's
`executable_binding_digest` (`segmenter:v2:w<N>:o<N>:max<N>`) and mints a new
binding identity, forcing one full re-embed. Retrieval's entity lane runs its
exact scan over every visible segment row and reduces the result to one
candidate per `document_ref` by keeping the highest-similarity occurrence
(max-similarity aggregation), attaching the winning segment's own
`(index, start_char, end_char)` as `semantic_evidence.matched_segment` before
applying the existing 100-candidate cap. At real-corpus scale the entity
lane's exact scan first attempts a bounded top-K pass and escalates to the
same full uncapped scan only when that shortfalls (fewer than 100 distinct
documents recovered and more candidates existed); the escalation branch is
byte-identical to the unbounded scan, so this can never change a result,
only how fast the common case reaches it. Urdira does not use an ANN index;
every scan above remains exact per [Semantic search and ranking](06-semantic-search-ranking.md).

A `semantic_segment_cache` table lets the reconciler skip re-embedding any
segment whose exact rendered text was already embedded under the same
provider identity, by any document, in any prior generation or concurrent
shard; it is pruned to the current binding after every clean pass. Semantic
maintenance may run as several concurrent reconciler shards
(`URDIRA_SEMANTIC_WORKERS`, default 2), each deterministically assigned a
disjoint set of owning artifacts so an artifact and its entities always land
in the same shard; one unsharded finalize pass closes out bulk/status work
and self-heals any shard's failures.

Cross-workspace vector sharing is unsupported. Content-identical documents
under different workspace/provider bindings are reconciled independently.

## Historial de cambios

- **2026-09-06** (`8497e9c`, Frente S-A): added the `semantic_document_status` per-document ledger, folded into "Maintenance" above.
- **2026-09-06** (`4404e6b`, Frente S-B): added the 256-token/32-token-overlap segmenter and per-segment entity vectors, folded into "Segmentation and per-segment entity vectors" above.
- **2026-09-07** (`docs/evidence/2026-09-07-v4-semantic-wiring-and-embed-performance.md`, Frente S-C): profiled local-provider embed throughput; rejected an explicit `intraOpNumThreads` override and the CoreML execution provider (both measured with no real gain, CoreML also diverged numerically); found process-level sharding (~1.44x at 2 processes) and artifact-vector reuse from entity segments as real, unshipped levers — both shipped the next day (Frente S-D).
- **2026-09-07** (`6546997`/`cfd5a6b`, Frente S-D): shipped artifact-vector composition from entity segments plus gap text, parallel reconciler sharding (`URDIRA_SEMANTIC_WORKERS`), and the segment cache — folded into "Segmentation and per-segment entity vectors" above. Found two pre-existing bugs (a `spawn EBADF` under fd load; entity-candidate enumeration OOMing at n8n scale), mitigated but not yet root-fixed.
- **2026-09-07** (`d244d07`, Frente S-E): root-fixed both bugs found by S-D — the fd budget (decision 16's `KQUEUE_FILE_WATCH_BUDGET`) and entity-candidate enumeration, converted from one materialized array to paged streaming (`entityCandidates`, 2,000-row pages); added segment-cache pruning to the current binding only.
- **2026-09-08** (`9b20fbb`, Frente S-F): bounded the entity lane's exact scan with an escalate-on-shortfall fast path and cached `vector_shards` CAS reads, folded into "Segmentation and per-segment entity vectors" above; materialized the coverage-summary row this decision's status table backs (see decision 16).
