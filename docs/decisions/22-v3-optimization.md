# Decision 22: Urdira v3 bounded pipelines, digests and migration

Status: approved and implemented

Urdira v3 keeps SQLite as the relational authority and CAS as the immutable
content store. The public query contract accepts binding-oriented pipelines:
each stage has an explicit `stage_id`, `stage_type`, operation/operator and
bindings to earlier outputs. The daemon lowers this closed wire shape to the
query algebra only after validating the complete dependency graph, operation
versions, output cardinality and budgets. A cursor reads the immutable final
manifest and never re-runs a stage.

Intermediate stage data is handled as bounded relational sets. Operators use
canonical subject identities, indexed joins and set membership; they do not
compare whole JSON values or silently select the first item of a multi-value
binding. The final response is the only object hydration boundary.

The query executor may spill those sets to an execution-scoped SQLite spool;
the spool is deleted on completion or failure and is never used as the cursor
manifest. Typed staging lanes mirror the published relational sections, so a
candidate contains only its delta and dependency closure rather than a second
generic copy of the workspace. Batch insertion is capped by both row/byte
budgets and SQLite's conservative variable limit. The first batch for a
FactDelta allocates one stable integer staging namespace. Every staged row is
keyed only by that integer plus its row ordinal; it does not repeat workspace,
candidate and FactDelta text. Namespace allocation, receipt and staged rows
share the batch transaction.

Candidate publication applies the same bounded write-set discipline. For a
large record or projection delta, the canonical and projection phases are
lazy command streams consumed directly by `transactionChunked`; the planner
does not retain a second array containing every occurrence or relational-value
INSERT. Small publications retain the materialized compatibility path so
existing callers and replay tests keep their exact command representation.
Both paths use the same phase order, checkpoints, immutable-row assertions,
fault boundaries, atomic current-state swap, and rollback semantics. Relational
value writers flush at the 1,024-row/13,312-parameter/4 MiB caps, including
when fed from a publication stream.

Pipeline algebra is lazy after sealing: filter, set union/intersection/
difference, deduplicate, select, and handle-native relation joins consume
`StageSetHandle` iterators and write their next output directly to the spool.
Final pipeline outputs are streamed into the immutable manifest (including a
reverse iterator for backward cursors), so the executor does not first build a
JavaScript array for the complete result. Only the final response page is
hydrated. A stage without an explicit completeness report is `unknown`, never
implicitly `complete`, and signed cursor claims preserve that report across
continuations. `QueryDataPort` adapters that do not advertise
`consumes_stage_handles` retain the selector-array
compatibility path; the canonical SQLite adapter consumes stage-output tokens
with the execution-local handles, and relation joins retain only identity and
stable-key maps rather than duplicating full payload arrays.

Logical digests use `urdira.logical-digest.v3` field/presence/type framing and
incremental writers. The canonical record-set digest streams the exact
`{record_id, record_digest}` pairs in ascending `record_id` order into the
canonical array recipe. The first publication consumes already ordered record
opens directly; later publications merge the prior ordered corpus with opens
and closures. This uses O(1) digest-writer auxiliary memory and one hash per
visible member. No aggregate JSON array is materialized. Earlier index, cursor,
and plan formats are not accepted by the current runtime.

Plugin projection sets use the same v3 logical writer at the worker boundary.
The execution and materialisation validators accept the pre-existing canonical
projection digest while rolling data forward, but new workers emit
`urdira:projection-set:v3`. Relational payload digests also hash the logical
value directly; flattened SQLite value rows remain a storage projection only.
Dependency and record-set planning uses incremental exact digests and counts
rather than an aggregate digest array. Digest metrics expose bytes hashed,
collection ordering and corpus rereads. Merkle counters remain defined for
components that still use Merkle structures, but canonical record publication
no longer constructs one.

Candidate template arrays are deeply frozen before their ordered-set digest is
computed. The canonical package memoizes a digest only for that exact frozen
array identity and mapping. Publication may reuse that seal-time digest for
the in-process array; reconstructed, mutable and recovery inputs still undergo
complete canonical verification.

On an eligible first publication, record-body digests may be computed by one
bounded worker while plugin analysis is still producing compact FactDeltas.
The main thread retains digest strings only and assembles templates after
analysis, preserving the analysis-memory boundary. At seal time the two
corpus-scale ordered-set digests may run on two bounded workers while the main
thread prepares the remaining materialization. Both optimizations fail closed
to the synchronous recipes: a skipped delta, worker error, count mismatch, or
disabled worker leaves the logical bytes, descriptor, and publication checks
unchanged.

For a large initial identity set, materialisation may replace the full
assignment object with the closed
`urdira:created-identity:v1` seven-string transport tuple after computing the
logical template digest. The publication authority decodes that tuple into the
same logical assignment and recomputes the identity id and assignment digest;
the tuple is never stored as the canonical value and is not accepted by the
public contract. The compact lane begins at 10,000 assignments. Incremental
and smaller publications keep the ordinary object lane so recovery and
compatibility tests continue to exercise the fully explicit representation.

For v3 record occurrences, the logical `body` is stored as one deterministic
canonical payload with its digest and byte length beside the typed envelope.
Queries decode only selected rows. Source ownership, spans, kinds, validity,
analysis digests and every indexed selector remain typed columns, and facets
and dependencies remain separately indexed. Identity assignment ownership is
derived through its immutable record occurrence instead of duplicating both
owner strings in every assignment row.

On a large first publication, the empty canonical secondary indexes are
dropped and rebuilt by SQLite after the bounded record and identity streams
finish. The drop, bulk inserts, index builds, immutable-row checks and current
pointer swap remain in the same publication transaction; rollback restores the
empty indexed schema. Incremental generations keep every index online and use
the ordinary point-update path.

## Supported data-root boundary

On startup a v3 daemon rejects every unsupported or preview data root with
typed `core:index_contract_unsupported`. There is no compatibility reader,
compatibility adapter, in-place upgrade or table backfill. An operator may
inventory and back up an unsupported root out of process, but the runtime requires a
fresh v3 root and reindexes source observations from scratch. CAS objects may
be reused only when scope, byte length and SHA-256 digest all verify. An unsupported
root is never attached to the v3 daemon.

The dependency-free bootstrap enforces this destructive boundary during
explicit runtime preparation. Its dry-run reads only the catalog contract
marker and identifies the exact pre-v3 data root that confirmation will
permanently remove. Confirmed preparation first stages and validates the new
runtime outside that root, refuses deletion while a live daemon owns it,
rechecks the contract to close the inspection/deletion race, then removes the
complete legacy root and activates a clean v3 runtime. It never resets a root
whose catalog carries the v3 marker, and an unreadable or unclassifiable
catalog fails closed. No legacy workspace, cursor, cache, model, CAS object, or
runtime directory survives this reset; source workspaces are registered and
indexed again.

## Operational budgets

FactDelta batches are capped at 4 MiB or 4096 rows. Generated SQLite
multi-row statements use the conservative 999-variable limit. Query spill is
bounded at 256 MiB with a 1 GiB ordinary hard limit; cancellation removes
execution spool and incomplete staging while retaining the last published
snapshot. Source, syntax, structural and semantic frontiers are published
independently, so semantic materialization never blocks source or structural
queries.

Lexical candidate generation uses SQLite FTS5 with the trigram tokenizer and
always verifies candidates against the stored document bytes. Relational
trigram projection tables are not part of the current schema. If FTS5 is not
complete for a generation, the
query falls back to an exact selected-scope scan and reports the corresponding
freshness/completeness state; it never returns an approximate result.
