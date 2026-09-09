# Decision 21: Native pipeline and relational storage

Status: Accepted

Current scope: this decision governs the v3 structural pipeline (SQLite
relational tables as the structural authority). Since 2026-09-04 the v4
immutable segment structural store (`crates/urdira-structural-store`,
[decision 26](26-v4-structural-store.md)) is the default for newly added
workspaces; the v3 pipeline described below remains the implementation for
workspaces opted out with `URDIRA_V4=0` and for the compatibility/oracle
route. Decisions 27-29 own the v4-specific digest, semantic, and scan
mechanisms that replace the corresponding v3 behavior described here.

Current cutover authority: the historical TypeScript analyzer/SQLite worker
description below is retained for wire and compatibility context only. In the
production structural route, `urdira-indexing-core` and the persistent Rust
composition worker own validation, canonicalization, receipts, staging,
publication, recovery and the workspace SQLite connection. TypeScript is the
source/CAS and query shell; its owner planner/writer is test-only.

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
payloads. The complete canonical record body is stored only in the primary
record/dependency lane that consumes it. Graph-edge and identity lanes carry
their promoted relational keys and omit the body instead of duplicating the
same payload in three staging tables. New databases use incremental
auto-vacuum; background staging cleanup reclaims a bounded number of free
pages per pass so reclamation cannot monopolize the indexing writer.

Fact-delta batches are accepted in sequence order and receipt-checked by
`workspace_id`, candidate generation, fact-delta identity, and sequence. A
large logical delta is emitted as multiple bounded batches; only the final
batch closes the sequence. Namespace allocation, receipt and staged rows are
atomic, so batches may arrive before the final accepted-delta authority row
without losing isolation or retry safety. Bounded multi-row SQLite inserts
avoid one statement boundary per scalar. This is an implementation guardrail,
not a relaxation of the 4 MiB/4096-row batch contract.

The host may carry at most 64 logical owner streams, 4,096 combined staged
rows, or 16 MiB of native batch buffers in one physical acceptance group.
Every stream is validated independently against the unchanged `FactDelta`
contract. Ordinary groups insert all staged rows and make all final receipts
durable in one SQLite transaction. A single owner that exceeds a group limit
uses multiple idempotent staging transactions; its receipt becomes durable
only after the complete stream validates, and no partial staging is visible to
materialization or queries.

Existing plugins may use the raw `FactDelta@1` compatibility response. The
built-in JavaScript/TypeScript plugin uses `FactDeltaStream@2`: it emits a
validated header followed by full-fidelity bounded row batches, allowing the
host to validate, compute logical digests, and stage rows without retaining a
second corpus-sized projection. The v1 adapter derives bounded native batches
after validation and persists them in small ordered groups (flushing at most 64
batches per SQLite transaction). Receipt and sequence checks still apply to every batch. Once accepted,
the host retains only the FactDelta identity, plugin provenance, dependencies,
completeness claims, replacement sets, and validated staging bindings required
for candidate sealing; provider proposal arrays are released. Direct plugin
callers that do not opt into host-side batch persistence retain the response
transport for compatibility.

The JavaScript/TypeScript Rust syntax worker supplies stage-one input to that
stream as Rust-built record and dependency rows. Its private fact protocol may
carry ordered groups of at most 64 owners, 4,096 rows, or 16 MiB while retaining
the existing per-owner cursor. Responses remain delimited by owner and each
owner is independently validated before the group is durably accepted. The
host never collects the complete native corpus or reconstructs stage-one
records from an AST-like transfer object.

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

## Supported data-root boundary

A v3 daemon has no reader for earlier or preview index formats and
rejects an unsupported index contract with
`core:index_contract_unsupported`. Inventory and backup of unsupported roots are external
administrative actions; activation requires a fresh v3 root and source
reindexing. CAS content may be reused only when its complete workspace scope,
length, and digest are verified. No incompatible catalog, cursor, staging table, or
compatibility decoder is opened by the current runtime.

## Readiness and isolation

Structural publication is progressive: syntax, declarations, and modules are
queryable before resolution and semantic stages finish. Every workspace,
worktree, clone, and virtual binding owns its SQLite generations and caches;
only immutable CAS content can be shared. Query warm-up prepares connections,
statements, generation metadata, and capabilities; it never loads the complete
record corpus.

When the Rust composition worker is active, this progressive capability
frontier is accepted into one atomic generation: the syntax rows and the
accumulated semantic stage-2/3 rows are staged and published together. The
portable compatibility route may still expose the historical intermediate
frontier. Rust therefore does not re-analyze or re-promote the same cold owner
set merely to preserve a UI readiness boundary; the visible-set digest and
stage-specific record vocabulary remain unchanged.

On a genuine initial publication in the portable compatibility route, a plugin
may declare a contiguous final stage group whose facts are accumulated into one
candidate and published at the coordinate of the group's last stage. The syntax
frontier remains an independent visible and recoverable snapshot there. The
grouped final publication must contain the exact ordered union of every grouped stage's records,
dependencies, diagnostics, capabilities, provenance and completeness claims;
incremental publications retain each declared frontier. Recovery may use the
group only while the visible predecessor is the stage immediately before it;
an already-visible member is resumed through the ordinary stage sequence.

For large workspaces (at least 4,096 source artifacts or 128 MiB of source
bytes), the Rust composition worker streams physical owner groups and keeps
one bounded response in flight. It validates and accepts each group before
requesting the next one; the application does not build a `plans` or `shards`
graph on the production cutover route. The former host-side bounded planner is
retained only by the differential/oracle harness. Ordering, access manifests,
replacement scopes, provenance, and completeness are unchanged.

Publication may use persistent, candidate-scoped typed staging tables that are
additive within format v3 and reconstructible from accepted deltas. A sealed
descriptor records row count, byte count, first and last key, and registered
sequence/chunk digests. Initial publication consumes a validated descriptor
with a fixed number of set-based `INSERT ... SELECT`, update, index-build, and
row-count checks; replay compares staging with authority by joins or `EXCEPT`.
Only a complete atomic publication can advance the visible snapshot.

For a fresh structural generation, the native structural kernel may attach a
closed publication projection to each validated record row: content-derived
record identity, relational body digest and byte count, exact UCE body bytes,
facets, source-span scalars, and created-identity scalars. The projection is
stored beside the complete canonical FactDelta record in the existing typed
lane and is covered by the same owner receipt. SQLite promotes the projection
to candidate publication staging with ordered `INSERT ... SELECT`; TypeScript
does not decode or reconstruct each record between acceptance and staging.
If any row lacks an exact native projection, the portable compatibility/oracle
route uses the ordinary canonical materializer. A Rust-owned generation instead
fails closed; it never falls back to the TypeScript materializer or writer. A
progressive initial successor may still promote exact native rows after its
syntax frontier is visible when it contains only first opens and no closures.
Incremental record closures are staged in a candidate-scoped typed relation and
applied with one set-based update. Replacement or absence-salted opens remain
on the Rust route and are rejected until their native lifecycle descriptor is
complete.

Large streaming publications apply the same producer-side rule to fixed-width
`record_occurrences` and `projection_occurrences`: at most 512 occurrence rows
are assembled per statement, followed by their foreign-key-dependent values,
facets, and dependencies. Checkpoints and row-change assertions cover the
whole bounded statement. The small-publication path keeps its shared
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

For a progressive initial publication with at least 10,000 source artifacts,
each accepted owner delta is also released after its materialisation templates
have been appended to bounded, externally sorted spool chunks. Record opens
are merged by record id and compact identity tuples by proposal order through
an immutable iterable; seal and publication consume those sequences directly
without reconstructing corpus-sized JavaScript arrays. The spool is private,
mode-restricted, removed after publication or failure, and never participates
in a public digest. A resumed initial progressive publication preserves this
mode through its durable checkpoint.

## Rust-owned structural mutation

The structural coordination described above is now owned by the
`urdira-indexing-core` Rust runtime. TypeScript remains the source/CAS snapshot
and query shell, but it no longer plans owners, frames per-owner responses,
accepts FactDelta rows, builds publication command arrays, or opens a competing
structural writer connection. A captured `index_generation` is sent to the
persistent per-workspace Rust composition worker, which validates the closed
generation coordinates, groups owners (64 owners, 4,096 rows, or 16 MiB),
records idempotent receipts, seals UCE/IDs/digests, stages through `rusqlite`,
publishes set-based inside one transaction, and only then acknowledges the
language engine. The existing TypeScript implementation is retained solely as
a conformance oracle until the Rust route has passed the evidence gates; it is
not a production fallback after activation.

Structural and lexical writes share an exclusive workspace writer schedule.
Readers use read-only connections. Lexical reconciliation is a Rust-scheduled
post-publication phase and may not race the structural transaction; WAL
checkpoints are measured and bounded, while `busy_timeout` is only lock
protection and never an unbounded retry policy. SQLite v3 schema, canonical
bytes, public queries, snapshots, and pagination are unchanged.

Candidate identity and work-manifest rows follow the same ownership rule. The
application may construct their immutable values for the generation envelope,
but the Rust core inserts them and records the `analyzing` to `published` (or
`failed`) lifecycle on its writer connection. TypeScript does not insert
candidate rows or receipts on the cutover route.

## Change history

- **2026-08-29** (Rust cutover): structural mutation ownership moved from the
  TypeScript owner loop to the persistent `urdira-indexing-core` Rust
  composition worker; TypeScript retained only as source/CAS and query shell
  plus a compatibility/oracle route.
- **2026-09-04** (v4 default): the v4 structural store ([decision 26](26-v4-structural-store.md))
  became the default for newly added workspaces; this decision's own scope
  narrowed to the v3/`URDIRA_V4=0` path.
