# Decision 21: Native pipeline and relational storage

Status: Approved and implemented in Urdira v3

## Decision

Urdira v3 does not use a universal byte serializer on its indexing hot path.
Source providers yield `AsyncIterable<Uint8Array>`. The core consumes each
chunk once, writes source content to CAS, validates the declared length and
SHA-256, and passes ownership through native `ArrayBuffer` transfer when a
worker boundary is required. A sender must not read a transferred buffer
again; another stage reads the immutable source from CAS when it needs the
bytes again.

Analyzer and SQLite workers exchange bounded `FactDeltaBatch` column buffers:
UTF-8 arenas with `Uint32Array` offsets, numeric typed arrays, enum columns,
presence flags, and separate records, edges, identities, and dependency
sections. A batch is limited to 4 MiB or 4096 rows. SQLite receives the
buffers through `transferList`, validates them through views, and writes
prepared relational rows under backpressure.

SQLite tables are the operational authority for indexed facts, relationships,
identities, dependencies, staging, and candidate materialization. In v3 the
typed record envelope and its indexes remain relational, while the selected
record body's logical value is a deterministic canonical payload stored on the
occurrence with its digest and byte length. Hydration decodes only selected
rows. Candidate materialization descriptors retain counts and digests only;
active publication carries typed template batches in memory, while durable
recovery replays confirmed FactDelta batches instead of persisting a second
generic copy of every template entry.

Relational child-value projections that remain in use apply a stricter
`RelationalValueBatchWriter` window: at most 1,024 rows, 13,312 bound
parameters, or 4 MiB of estimated parameter payload, whichever limit is
reached first. A record occurrence's compact body payload is bounded by the
same 4 MiB per-row publication guardrail. Neither path may silently bypass the
4 MiB/4096-row FactDelta transport contract.

The high-volume staging lanes use SQLite `WITHOUT ROWID` tables with
`(fact_delta_key, row_ordinal)` as their sole storage B-tree; redundant indexes
over the same key are not created. `fact_delta_key` is allocated in a small
namespace table by the first accepted batch, so staged rows do not repeat the
workspace, candidate and FactDelta text keys. CAS stores source content and
other immutable large blobs; candidate staging does not use aggregate binary
payloads.

Fact-delta batches are accepted in sequence order and receipt-checked by
`workspace_id`, candidate generation, fact-delta identity, and sequence. A
large logical delta is emitted as multiple bounded batches; only the final
batch closes the sequence. Namespace allocation, receipt and staged rows are
atomic, so batches may arrive before the final accepted-delta authority row
without losing isolation or retry safety. Bounded multi-row SQLite inserts
avoid one statement boundary per scalar. This is an implementation guardrail,
not a relaxation of the 4 MiB/4096-row batch contract.

The production JavaScript/TypeScript host uses the raw FactDelta as the single
worker response representation. It derives bounded native batches only after
validation and persists them in small ordered groups (flushing at most 64
batches per SQLite transaction), so the worker does not return a second array
containing the complete native projection and each group remains bounded in
memory. Receipt and sequence checks still apply to every batch. Once accepted,
the host retains only the FactDelta identity, plugin provenance, dependencies,
completeness claims, replacement sets, and validated staging bindings required
for candidate sealing; provider proposal arrays are released. Direct plugin
callers that do not opt into host-side batch persistence retain the response
transport for compatibility.

Digests are computed incrementally over logical fields, with explicit field
identity, presence, type tags, lengths, declared sequence order, and
canonical set order. They never hash a transport message. Canonical record
sets use the record-id-ordered streaming recipe approved by Decision 22;
components that retain Merkle structures keep their own registered recipes.

JSON is limited to human-readable configuration and the MCP projection. MCP
returns UTF-8 text or an opaque reference containing `digest`, `byte_length`,
and `media_type`; it never embeds encoded bytes. Protobuf-ES is reserved for
future cross-process providers, sandboxed plugins, and explicit portable
import/export. It is not persisted and never participates in IDs, digests, or
ordering. Local worker threads use native transfer instead.

The process boundary uses the `urdira.ipc.v2` chunk contract. Every chunk is
length-prefixed with `uint32_be`, capped at 256 KiB, and carries a stream id,
sequence, byte offset, final marker, cancellation id, and mandatory byte and
in-flight budgets. Closed messages reject duplicate or unknown fields. Boundary
counters report bytes read, transferred, copied, decoded, and retained; an
acceptance run fails when a copy is not declared.

## Compatibility and migration

This v2 transport/storage decision is superseded by the destructive v3 data
root. A v3 daemon has no reader for v1, v2, or early-preview v3 indexes and
rejects an unsupported index contract with
`core:index_contract_unsupported`. Legacy inventory and backup are external
administrative actions; activation requires a fresh v3 root and source
reindexing. CAS content may be reused only when its complete workspace scope,
length, and digest are verified. No legacy catalog, cursor, staging table, or
compatibility decoder is opened by the v3 runtime.

## Readiness and isolation

Structural publication is progressive: syntax, declarations, and modules are
queryable before resolution and semantic stages finish. Every workspace,
worktree, clone, and virtual binding owns its SQLite generations and caches;
only immutable CAS content can be shared. Query warm-up prepares connections,
statements, generation metadata, and capabilities; it never loads the complete
record corpus.

For large workspaces (at least 4,096 source artifacts or 128 MiB of source
bytes), the host streams owner plans. It builds one owner request, keeps one
worker response in flight, accepts the result, and only then builds the next
owner request. The large-workspace path therefore does not retain a
corpus-sized `plans` or `shards` graph; small workspaces keep the existing
multi-shard pipeline for throughput. Ordering, access manifests, replacement
scopes, provenance, and completeness are unchanged.

Large streaming publications apply the same producer-side rule to fixed-width
`record_occurrences` and `projection_occurrences`: at most 512 occurrence rows
are assembled per statement, followed by their foreign-key-dependent values,
facets, and dependencies. Checkpoints and row-change assertions cover the
whole bounded statement. The legacy small-publication path keeps its shared
value writer and one-row occurrence commands, so this optimization changes no
ordering, conflict, provenance, or replay semantics.

Initial publications with at least 10,000 identity assignments use a compact
in-process transport tuple containing the transport tag, workspace, identity
type and key, record id, and owner artifact/version. It is not a persisted or
public schema. Publication reconstructs the exact logical assignment before
digest verification, conflict checks, and relational insertion. Smaller and
incremental publications retain the full template representation. This avoids
retaining the same property names and nested owner objects millions of times
without changing identity ids, canonical digests, provenance, or query
behavior.
