# Decision 22: Urdira v3 bounded pipelines, digests and migration

Status: approved and implemented

Structural cutover note: the TypeScript command/materialization paths described
in this decision remain compatibility and differential-oracle implementations
only. Production structural generations use the generic Rust indexing core for
acceptance, staging, sealing and SQLite publication; no TypeScript writer is a
fallback after the Rust worker is selected.

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
INSERT. Small compatibility/oracle publications retain the materialized path
so existing non-production callers and replay tests keep their exact command
representation; Rust-owned structural generations never select it.
Both paths use the same phase order, checkpoints, immutable-row assertions,
fault boundaries, atomic current-state swap, and rollback semantics. Relational
value writers flush at the 1,024-row/13,312-parameter/4 MiB caps, including
when fed from a publication stream.

Large publication streams may additionally populate persistent typed
candidate-scoped staging tables. These tables are internal, additive format-v3
state, never canonical or query-visible, and are reconstructed from accepted
`FactDelta` authority when absent or invalid. One ordered merge produces final
rows, canonical bodies, identities, and every registered digest writer, then
seals a descriptor containing counts, bytes, boundary keys, and sequence/chunk
digests. A valid descriptor is consumed once by a fixed set of `INSERT ...
SELECT`, update, index-build, and `changes()` checks. Initial empty-authority
publication omits only the conflict replay that cannot find a prior row;
retries use relational joins or `EXCEPT` and report exact conflicting IDs.
Confirmed staging is cleaned after commit. Incomplete staging survives only
for bounded recovery and is removed when its descriptor fails validation.

The typed relation set also includes incremental record closures. Publication
validates their staged count and applies the complete relation with one
candidate-scoped `UPDATE ... IN (SELECT ...)` plus an exact `changes()`
assertion; it never emits one JavaScript command per closed record. Open rows
that require replacement or absence salts may use the canonical materializer
only on the portable compatibility/oracle route. When the Rust composition
worker is selected, a missing native lifecycle descriptor is a closed error and
there is no TypeScript writer fallback; the set-based closure operation remains
unchanged.

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

Large progressive first publications may expose the same logical template
sequence through a read-only file-backed iterable rather than an in-memory
array. Producers sort bounded chunks and the consumer performs a heap merge,
so auxiliary heap and open-file counts are bounded independently of the number
of records. Every iterator closes all chunk readers on completion or early
return. Ordered-set digests, immutability checks, identity conflict validation,
and publication all consume the exact sequence; the representation changes no
logical field, order, digest, or failure rule.

When an approved initial-publication stage group is active, its analyzer emits
the grouped logical rows once into the same typed candidate staging lanes and
the materializer seals one descriptor at the final stage coordinate. This is
physical accumulation only: the final record, dependency, diagnostic,
capability and digest sets are byte-identical to sequential publication. A
crash before the final current-state swap leaves the preceding syntax snapshot
visible and the grouped staging reconstructible from accepted owner receipts.

On an eligible first publication, record-body digests may be computed by one
bounded worker while plugin analysis is still producing compact FactDeltas.
The main thread retains digest strings only and assembles templates after
analysis, preserving the analysis-memory boundary. At seal time the two
corpus-scale ordered-set digests may run on two bounded workers while the main
thread prepares the remaining materialization. Both optimizations fail closed
to the synchronous recipes: a skipped delta, worker error, count mismatch, or
disabled worker leaves the logical bytes, descriptor, and publication checks
unchanged.

The core-owned Rust library may implement these registered logical-digest
writers through bounded Node-API batch calls. It does not define another
serializer or digest recipe, and TypeScript/Rust golden vectors must remain
byte-identical. Missing or invalid native artifacts fail runtime activation as
specified by Decision 25 rather than selecting a production JavaScript
fallback.

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

Replay comparison for a sealed typed publication is relational. Null-safe
joins compare every immutable canonical column and a bounded `EXCEPT` probe
detects authoritative rows outside the candidate relation. JavaScript does
not build corpus-sized id lists or issue chunked point lookups for this path;
the diagnostic result is still bounded to the first conflicting identity.

Workspace publication remains in WAL mode so lexical maintenance and every
other concurrent reader keep a stable snapshot throughout the transaction.
Fresh publication requests a best-effort truncating checkpoint before and
after the atomic transaction; a pinned reader may defer either checkpoint and
must never make publication fail or change its committed result. The isolated
million-row microgate may use SQLite's `DELETE` rollback journal with
`synchronous=FULL` because it owns every connection and has no concurrent
reader. That benchmark-only journal choice is not available to the composed
daemon, incremental publication, or replay.

The composed Rust writer disables SQLite's page-count auto-checkpoint for the
foreground structural transaction. After the visible tuple is committed, the
Rust scheduler performs one passive, bounded WAL checkpoint in its
post-publication maintenance phase (lexical reconciliation when present, or a
standalone maintenance task otherwise). Checkpoint latency therefore cannot
extend structural readiness, while WAL durability, `BEGIN IMMEDIATE`, bounded
busy protection, and the exact publication result remain unchanged.

For a genuinely cold direct publication, the Rust core also skips construction
of its three temporary join indexes: the temporary relations' primary keys
already cover every join and there is no durable row set to probe. Replays and
incremental generations retain the indexed path. This is an execution-plan
optimization only; it does not change the SQL authority, transaction shape,
conflict handling, or published bytes.

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

## 2026-08-29 cutover amendment

The bounded pipeline is executed by the Rust indexing core rather than by the
TypeScript owner loop. Cold and incremental generations use the same SQLite
transaction and publication recipe; only the captured base generation, exact
change set, and affected-owner manifest differ. Candidate acceptance,
canonicalization, receipt replay, staging, sealing, and atomic swap are core
operations. The TypeScript path remains a test oracle and is not a production
fallback once the Rust worker is enabled.

The same Rust transaction owns candidate identity and work-manifest lifecycle
metadata. The application passes those immutable values in the generation
envelope; it does not insert candidate rows or receipts before the worker
publishes.
