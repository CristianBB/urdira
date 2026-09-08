# Rust Native Acceleration

Status: **Approved**
Last updated: 2026-08-30
Depends on: Language plugin contract, JavaScript/TypeScript MVP, performance evaluation, packaging, native pipeline, and v3 optimization

## Decision objective

Define the mandatory, cross-platform Rust components used to reduce structural
indexing latency and process-tree memory while preserving Urdira's public,
semantic, storage, and snapshot contracts. Rust owns structural mutation and
SQLite publication; the TypeScript application remains the source/CAS and query
shell only.

## Approved boundary

Urdira remains a TypeScript/Node application with SQLite as the relational
authority, but structural indexing mutation is owned by Rust. Rust is used
through three explicit boundaries:

- a small core-owned Node-API library for bounded, pure query-kernel and
  differential-oracle operations over v3 logical-digest values and packed
  numeric buffers;
- supervised persistent language workers; and
- the persistent per-workspace `urdira-indexing-worker`, whose generic
  `urdira-indexing-core` connection is the sole production structural/lexical
  writer and publication authority.

The native query/oracle library does not own schemas, registries, ordering
rules, query semantics, or source access. The indexing core validates the
closed generation, stages typed rows, records receipts, seals canonical bytes,
publishes set-based in SQLite, recovers and reconciles lexical data. It uses the
shared v3 SQL authority and retains no JavaScript object or buffer after a
call. Query connections remain read-only.

The JavaScript/TypeScript plugin uses a Rust syntax worker as the exclusive
production implementation for stage-one source decoding, parsing, declaration
and containment extraction, syntactic import/export extraction, content-keyed
syntax facts, direct dependency graph maintenance, reverse affected-set
calculation, and stage-one fact construction. The pinned TypeScript compiler
remains authoritative for binding, module resolution, symbols, types, and
compiler-compatible flow facts in later stages. A construct that the Rust
frontier cannot represent faithfully fails the candidate closed and preserves
the last published snapshot; production never routes it through the legacy
TypeScript stage-one implementation.

Oxc parses `.d.ts`, `.d.mts`, and `.d.cts` inputs with their detected
definition-file grammar and module kind, but its TS1038 ambient-context
diagnostic is deferred rather than promoted to stage-one authority. The pinned
TypeScript checker alone evaluates that declaration-file semantic rule in
later stages. Oxc panics and every other grammar or parser diagnostic still
fail the native candidate closed.

A non-initial Rust full reset caused by a root-set, file-set, or configuration
change atomically rebuilds native syntax state and evicts every retained
TypeScript semantic process for that workspace. Stage one does not start a
semantic process merely to acknowledge the reset, and it never delegates
closure or fact authority back to TypeScript. Later semantic stages construct
a fresh compiler state from the affected source manifest. This conservative
boundary covers create, delete, rename, roots, manifests, and compiler-option
changes without mixing state from different generations.

The host enforces an exclusive-work ledger for `source_decode`, `syntax_parse`,
`declaration_extract`, `import_extract`, `direct_graph`, `affected_set`, and
`stage_one_fact_build`. Claiming any operation twice in one work item is a
closed runtime error. A native stage-one request also rejects semantic-process
creation. TypeScript's compiler-internal parsing needed to construct its
checker is recorded as `semantic_program_build`, but the host-side semantic
route cannot walk the corpus to extract declarations, imports, containment, or
other stage-one output and cannot emit stage-one records.

The analysis response carries only build/reset identities, one session-local
analysis token, and the sorted changed and affected paths. Structural facts
remain in Rust state and are read through ordered `read_facts_group` requests
capped at 64 owners, 16 MiB, and 4,096 total import, record, and dependency
rows. Each returned page retains its owner identity and ordinary per-owner
cursor; pagination therefore continues inside a single large file and a row
that cannot fit alone fails closed. Every page carries Rust-built stage-one
records and dependencies rather than analyzer entities for Node to reconstruct.
The host independently validates every complete owner stream and atomically
accepts the bounded group before requesting the next, then acknowledges the
analysis token. Until that acknowledgement
an identical analysis request replays the pending affected set instead of
reporting an empty `unchanged` result. Node never mirrors the complete native
syntax state and never decodes source or rebuilds Rust-owned stage-one facts.

JavaScript/TypeScript proposal keys and dependency proposal identities are
bounded independently of source-path and symbol length. The Rust authority and
TypeScript conformance path compute `jsts:record:sha256:<hex>` from the full
record identity and `jsts:dependency:sha256:<hex>` from the relation identity
plus target artifact-version identity. Both use UTF-8, an eight-byte unsigned
big-endian byte length before each value, SHA-256, and respectively the domains
`urdira:jsts-proposal-record:v1` and
`urdira:jsts-proposed-dependency:v1`. Full record identities, proposal
references, and target artifact coordinates remain in their normative row
fields; the digests are only delta-local immutable keys. Changing either
framing changes the worker build identity and therefore the analysis digest.

Every persistent native request receives the complete current source manifest
plus a separate exact changed-artifact set. A targeted capture may narrow work,
but never the project state from which Rust maintains direct and reverse
dependencies. Request deadlines and cancellation cover analysis, fact-page
reads, acknowledgement, reset, and shutdown; process EOF is terminal.

The same Rust result is retained as the authority for later semantic stages.
Their closed `analyze_closure` call carries the exact changed and affected
paths with authority `urdira:jsts-syntax-worker`. The TypeScript process uses
that call only to create or update one compiler program; it does not walk source
ASTs or materialize a corpus-sized semantic or structural result during
preparation. It returns `semantic_state_prepared` and the Rust authority
identity; returning a TypeScript dependency graph, transitive closure, or
affected set is an exclusive-work violation. Each later semantic request may
walk an ordered lookup group capped at 32 owners and a 16 MiB request through
the same prepared checker, derives stable relation endpoints on demand from
resolved declarations, and returns owner-delimited frames. Result rows are
admitted into separate core-owned physical groups capped at 64 owners, 4,096
rows, or 16 MiB; crossing that boundary seals the preceding group without
replaying checker work. The remote
symbol/type handles for that group are explicitly released when it closes; the
program and checker remain live for the complete generation and are not
periodically reconstructed. Neither a snapshot per owner nor an unbounded
corpus-wide registry is permitted. Stage three emits
semantic type entities and `core:type_of` relations instead of reconstructing
Rust declaration records.

Semantic process protocol 1.8 implements a bounded, sealed-row pull stream for those
groups. `semantic_group_start` returns only owner-delimited headers and stream
identities. `semantic_group_next(group_id, expected_owner_index)` then drains
as many ordered owner batches as fit in one 16 MiB response, returning the next
owner cursor. An oversized owner continues at its own batch sequence. When a
group requires checker work, the checker collects its identifier and
typed-declaration nodes and performs the available symbol/type bulk operations
once for the group. Stage two seals the exact stage-three projection in the
generation-scoped spool. A stage-three group for which every owner is an exact
spool hit consumes those rows without preparing or walking another checker
group. If any owner is absent, stale or invalid, the complete bounded group
uses the checker-backed path; partial mixed-authority groups are forbidden.
Compiler handles are released at group close while the prepared `Program` and
checker remain live. A group header may never retain or transport the
materialized result corpus. Result continuations encode records
and dependencies as canonical rows already sealed by the core-owned Rust
kernel, so V8 does not serialize the nested logical object graph. The host
retains the rows as opaque text and the receiving Rust core independently
parses, canonical-checks, schema-checks and projects them before the ordinary
owner/scope/dependency/completeness validation continues. No producer-owned
staging scalar crosses this trust boundary.

The production semantic process additionally receives the absolute path of the
same core-owned addon whose bytes and API identity were verified by the
composition root. The path is explicit in the closed handshake; it is never
resolved from `PATH`, the current directory or plugin-controlled input. This
does not transfer semantic authority to the core. The language oracle still
chooses the observations and registered meanings, while the generic structural
kernel owns the mechanical canonicalization, IDs, digests and typed publication
projection.

Each owner constructs its logical output rows exactly once. Before the owner
header is sealed, the semantic oracle prepares the complete bounded lookup
group without framing it. The generic core partitions those prepared owners at
the 4,096-row physical limit and runs one Rust kernel call per partition,
caching immutable canonical rows against their owner-local objects. Header and
delta digests plus final stream framing reuse those bytes; neither the language
adapter nor a second N-API call may recreate them. A single owner above the
physical row bound retains its existing owner cursor and scalar batch preseal.
A rejected group is not accepted through a fallback: ordinary scalar framing
replays the normative validator and produces the closed error. The cache
disappears when the acknowledged owner stream is released, so this rule applies
identically to cold and incremental generations without retaining a corpus-wide
result. The grouping port is language-neutral and cannot inspect plugin IDs,
record namespaces or semantic kinds.

Within one generation, stage two writes each complete checker-owned owner
result once to a process-local, length-indexed binary spool under the daemon's
analysis-cache directory. Stage three reads that exact result instead of
walking the same owner a second time. The spool is generation-keyed by ordered
source content hashes, compiler options, and analyzer identity; reset,
generation mismatch, process exit, or corruption closes and removes it. It is
an ephemeral duplicate-work barrier, never semantic authority or a production
fallback. Identifier symbols and exported declaration types are requested from
the TypeScript API in per-owner batches; alias resolution is invoked only for
symbols carrying the compiler's alias flag.

Every native-bound `analyze_artifact` request carries the same Rust authority,
narrowed only to the owner's verified transitive source closure. Omitting that
scope is a closed exclusive-work error because it would select the legacy
TypeScript analysis key and repeat graph and declaration work. A
Rust-authoritative route admits exactly one persistent TypeScript checker per
workspace, irrespective of the development sharding setting. Once that
checker has verified the immutable CAS hashes, owner publication and stage
three reuse metadata-only source descriptors; they do not reread, rehash, or
UTF-8 decode the same CAS blobs per owner.

The semantic-process supervisor retains at most the final 8 KiB of stderr
inside its existing 64 KiB total allowance and attaches that bounded tail to a
premature-exit error. Process failure therefore remains diagnosable without an
unbounded log buffer or a masked generic workspace-scan error.

Before stage one becomes visible, the engine durably checkpoints the exact
changed-artifact set under the source snapshot, registry snapshot, resolution
lock, configuration revision, and ordered stage-sequence digest. A process
restart after stage one reuses that checkpoint for stages two and three; it
never derives an empty set by comparing against the already-published stage-one
snapshot. Missing, corrupt, or coordinate-mismatched checkpoints fail closed.

## v3 digest and transport rule

Rust does not introduce a universal canonical serializer. The native core
implements the existing `urdira.logical-digest.v3` field, presence, type,
length, sequence, and set-order framing. TypeScript remains the conformance
oracle until byte-for-byte differential fixtures pass; after native activation
it remains a test oracle, not a production fallback.

Native binding API v14 additionally emits a bounded typed publication
projection and per-batch sealed descriptor in the same owned structural-row
pass. It does not change canonical schemas or digest recipes. The host accepts
the projection only for body shapes whose historical logical field ordering
is provably byte-identical; otherwise that native-binding attempt is rejected
and remains available only to the differential-test oracle. Once the
composition worker is active, production never falls back to the portable
TypeScript writer.
The stream's public byte length is measured over its stable six transport
columns and is independent of native activation. If adding typed publication
columns would exceed the private physical batch budget, that batch retains the
complete six-column form and makes the candidate ineligible for direct typed
promotion; it never rejects an otherwise valid owner stream.
SQLite remains authoritative and the native kernel never opens a workspace
database.

Native binding API v15 adds the independent receiving-core entrypoint
`structuralKernelCanonicalBatch`. A language oracle may send exact canonical
record and dependency rows, but the host does not parse those rows into nested
JavaScript objects. The core-owned binding rejects non-canonical bytes, parses
the closed row structs in Rust, validates registered category, universal kind,
schema version, facets and closed body schemas, and returns only compact
accepted fields, dependency authority and typed publication scalars. The
engine still validates candidate, owner, scope, manifest, closure,
completeness and dependency context before the grouped receipt is durable.
Producer-side Rust preseal and receiver-side Rust acceptance are intentionally
separate trust passes. This route is mandatory for both cold and incremental
generations and is language-neutral; an adapter may define observations, not a
different acceptance or staging route.

Native binding API v16 adds `structuralObservationBatch`. The entrypoint takes
a closed, versioned profile identity plus bounded compact observations. Profile
implementations live in language-owned Rust crates; the addon dispatch table is
closed at build time, while `urdira-native-core` remains language-neutral. A
profile emits ordinary `StructuralKernelRecord` and dependency rows, and the
common producer seal canonicalizes them in the same Rust call. The result
contains only canonical record/dependency rows, compact identity headers and
diagnostic codes; nested logical rows, IDs, registered digests and typed
publication objects do not cross Node-API at this boundary. TypeScript computes
the exact owner header digests over those immutable canonical bytes and frames
the stream without reconstructing record bodies or invoking another producer
kernel. The independent receiving core remains the sole acceptance authority:
it reparses and validates the opaque rows, then produces IDs, registered
digests, UCE payloads and typed staging scalars. Unknown profiles, extra fields
and groups above the 4,096-row bound fail closed. Oversized owners retain the
existing cursor-backed portable mapper. Cold and incremental semantic
generations call the identical profile boundary.

Plugin output may use the additive `FactDeltaStream@2` contract. Its header
commits explicit candidate, work-item, plugin, replacement-scope,
completeness, count, and digest coordinates. Full-fidelity rows are sent in
ordered batches capped at 4 MiB or 4,096 rows. Cross-process chunks use
`urdira.ipc.v2`, are length-prefixed, and are capped at 256 KiB. The core
validates and stages batches sequentially and computes authoritative logical
digests without materializing a second corpus-sized result. `FactDelta@1`
remains accepted through a bounded compatibility adapter for existing plugin
packages.

Every stage of a genuine initial progressive publication releases its accepted
owner delta after feeding a bounded materialisation accumulator. At large-corpus
scale that accumulator uses externally sorted file-backed sequences, rather
than retaining the Rust or TypeScript proposal graph in V8. Later stages do not
recreate Rust-owned syntax facts, and the initial-publication coordinate is
persisted across recovery so a restarted semantic stage cannot silently return
to the corpus-sized compatibility path.

The bundled JavaScript/TypeScript implementation groups structural stages two
and three on a genuine initial publication. One persistent checker produces
the exact union of resolution, call, inheritance, type, diagnostic and
semantic-preparation facts directly into typed candidate staging, and the core
publishes that union at the existing stage-three coordinate. Stage one remains
independently visible. Incremental generations and recovery from an already
visible stage-two snapshot keep the ordinary three-stage sequence.

These JavaScript/TypeScript components are the first adapter to the
[language-neutral structural indexing fast path](../protocol/structural-indexing-fast-path.md),
not a storage or engine specialization. Future language adapters may replace
the syntax process and semantic oracle, but reuse the core-owned validation,
canonicalization, typed staging, receipt, publication and recovery route.

## Worker and executable identity

Production language analysis uses supervised processes. In-process and worker
thread transports are test-only and are not a fallback for a missing or
failed native build. The closed plugin call set includes `analyze_closure` in
addition to `describe`, `discover_partitions`, `analyze_artifact`, and
`generate_projection`.

`PluginRuntimeExecutableBinding@1` binds a resolved plugin to one exact local
target, runtime contract, component build, implementation digest, package
digest, and binding digest. `RuntimeComponentImplementationManifest@2`
identifies one exact entrypoint asset and one registered runtime target. The
selected Rust build participates in the analyzer implementation manifest,
`analysis_digest`, resolution continuity, worker key, and cache key. A build
change creates a new candidate and cannot be substituted during a request.
For the built-in JavaScript/TypeScript plugin, the package digest additionally
commits every shipped JavaScript module in the supervised semantic process and
a path/length/digest inventory of every regular file in the installed pinned
TypeScript package. The Rust worker is the v2 entrypoint; the semantic-process
entrypoint and its complete package-local module set remain executable assets
of the same implementation manifest. The host rechecks the Rust worker digest
immediately before launch and rejects post-preparation replacement.

A worker receives no ambient checkout path, credentials, network, shell, or
host environment. Source bytes or verified worker-scratch blobs are supplied
explicitly with their length and content digest. Reset acknowledgement is
required before a process can be reused across workspace state.

## Query and storage boundary

Graph, lexical, snapshot, cursor, and relational authority remain in SQLite.
Common graph operations first use indexed joins and recursive CTEs rather than
hydrating a workspace corpus. Query normalization, completeness, limits,
ranking, deterministic ordering, and cursor manifests remain core-owned.
The opt-in diagnostic query path records bounded per-operation samples for
duration, decoded and serialized logical bytes, rows, copies, event-loop delay,
and RSS, and reports exact P50/P95/P99 over the retained window together with
lifetime totals. Instrumentation remains internal and never enters MCP or query
response models; resource probes are injectable so reference campaigns can
replace process-local estimates with host or process-tree measurements.

The exact vector top-k native kernel is active whenever the verified production
native closure is selected. Core retains filtering, canonical vector encoding,
limits, ranking integration, and result validation; Rust receives call-owned
packed buffers and returns only exact ordered identifiers and ranks. A selected
kernel never falls back silently to the TypeScript oracle after a native error
or malformed result. Development and tests without a selected native closure
may use the behaviorally equivalent TypeScript oracle.

Activation requires a real target-matched addon, fixed-scale samples, exact
ordered-result and UTF-8 tie equivalence, at least fifteen percent large
end-to-end latency improvement, and no more than five percent small-query
regression. Two times kernel throughput, thirty percent lower peak memory, and
real-query attribution at or above twenty percent remain recorded stretch
targets and rollback diagnostics, not activation prerequisites. A Rust graph
kernel still requires separate evidence after SQL pushdown and is not part of
the initial implementation.

## Distribution

Rust 1.98.0, the Cargo lock digest, Node-API version, worker protocol version,
parser version, behavior and implementation digests, target, and binary
checksums are release metadata. Release builds are required for:

- `aarch64-apple-darwin`;
- `x86_64-apple-darwin`;
- `aarch64-unknown-linux-gnu`;
- `x86_64-unknown-linux-gnu`; and
- `x86_64-pc-windows-msvc`.

No destination compilation is allowed. The confirmed npm preparation installs
the exact host package and validates it before atomic activation. The offline
archive contains only its target's native closure. Missing, wrong-target,
corrupt, incompatible, or handshake-mismatched native artifacts fail
preparation or startup while preserving the previously active runtime and last
published snapshot.

## Acceptance

Native activation requires exact full/incremental visible-set equivalence,
shared TypeScript/Rust golden vectors, framing and parser fuzzing, crash and
quarantine tests, and real execution on all five targets. On the frozen large
corpus and at least three independent reference-host campaigns it additionally
requires at least 25 percent lower cold P50/P95, 40 percent lower complete
incremental P95, and 25 percent lower peak process-tree RSS while retaining all
absolute limits from the performance decision. For the named n8n preflight,
the 2 GiB process-tree RSS figure is an advisory budget: an exact sample that
passes its agreed time gate remains admissible when RSS is higher, with the
overage reported for optimization. OOM termination, incomplete publication,
digest mismatch, and time-gate failure remain hard failures.

Qualifying evidence uses the closed native-acceleration report v2 contract.
Each reference target contributes exactly three counterbalanced campaigns;
each lane retains 60 incremental times, 61 visible-set digests, the exact
controller v2 protocol log with phase timings, stderr, and a raw process-tree
RSS series. Reports bind the corpus, trace, manifest, runner, controller
configuration and executable, runtime module, Cargo lock, and native closure by
SHA-256 digest. The release gate independently verifies those artifacts, the
Decision 08 tier and host profile, absolute limits, equivalence, and relative
improvements. Engineering runs on non-reference hosts cannot authorize the
mandatory cutover.

Every cold or incremental sample is accepted only after the same complete,
structurally ready snapshot remains unchanged for the controller's bounded
quiescence window. Any intervening scan, snapshot transition, incomplete state,
or scan error resets that window. This prevents a following declared mutation
from overlapping watcher follow-up scans and makes each retained timing and
visible-set digest an isolated sample.

The campaign controller applies declared writes to existing files in place so
content, import, compiler-option, and manifest samples retain filesystem entry
identity and are observed as modifications. Declared creations write their
final path directly with exclusive creation. Harness-induced temporary siblings
or delete/create lifecycles must not replace the intended workload or force a
conservative native/semantic reset.

## 2026-08-29 cutover amendment: indexing-core and composition worker

Rust is now the production owner of structural indexing mutation. The closed
`LanguageEngine` port (`describe`, `prepare`, `analyze_group`, `acknowledge`,
`cancel`, `shutdown`) feeds `urdira-indexing-core`; the persistent
`urdira-indexing-worker` is the sole application boundary for a workspace
generation. It owns generation validation, bounded physical groups, receipt
idempotency/conflict detection, canonical/UCE identity sealing, typed
`rusqlite` staging, set-based publication, recovery, cancellation, and write
metrics. The JavaScript/TypeScript adapter reuses Oxc syntax state and the
native projection; its checker is a private subprocess serving bounded groups
and acknowledges only after the visible SQLite commit. Structural rows never
return to V8 or cross Node-API per owner. The current TypeScript coordinator
remains available only as a differential-test oracle; there is no production
writer fallback after cutover.

The progressive semantic stages use the same cutover boundary: the Rust
composition worker launches the pinned checker through the engine descriptor,
forwards opaque plugin envelopes to it, drains bounded canonical observations,
and commits them through the generic Rust sink. The application receives only
progress and the final operation result; it does not create or supervise a
semantic process and does not invoke a TypeScript acceptance/staging service
when the composition worker is active. Rust coalesces pages up to the
64-owner/4,096-row/16 MiB physical limits, so transaction count follows
physical groups rather than owners and future language engines can reuse the
identical SQLite path.

The checker process and its incremental TypeScript snapshot are retained by
the per-workspace composition worker after a successful generation. A following
generation reuses that state when the verified engine descriptor is unchanged;
descriptor changes, cancellation, failure and shutdown close it before any new
state is admitted. This persistence is an execution optimization only: Rust
continues to own validation, receipts, staging, publication and acknowledgement.

The physical group limit is 64 owners, 4,096 rows, or 16 MiB. The checker
oracle may use 32 owners/16 MiB and a dedicated cursor for a giant owner. The
Rust core uses one exclusive writer schedule per workspace for structural and
lexical phases, `BEGIN IMMEDIATE`, bounded WAL checkpoints, and finite lock
protection. SQLite v3, canonical bytes, IDs, digests, snapshots, queries,
MCP, and pagination remain unchanged.

Any retained TypeScript compatibility mutation (for example, maintenance of a
workspace imported from a legacy index pack) acquires the same
`<database>.urdira-writer.lock` before opening its writable SQLite connection.
It therefore cannot overlap a Rust structural or lexical mutation; it is not
an alternative structural publication route.

## 2026-08-31 source frontier handoff amendment

The production `index_generation` envelope carries engine configuration and
verified coordinates, but no owner-sized JS/TS `files` or `root_names` arrays.
After the generic source commit is visible, `urdira-indexing-core` reads the
current artifact/version frontier from its leased SQLite connection and the
JSTS engine derives verified CAS paths inside Rust. The private array fields
remain available only to differential/oracle tests; they are not part of the
production composition path.

## 2026-09-08 Q1 amendment: a query-plan-layer bug, not a pushdown-boundary gap

`docs/evidence/2026-09-08-v4-vscode-query-latency.md` traces a P0 (`core:
resolve_symbol -> core:find_references` measured at 116-160s on VS Code's
~4.5M-record native structural store, cold and warm alike; reproduced on
n8n's own 2.2M-record store too, exceeding a 30s deadline pre-fix). The
"Query and storage boundary" section above already commits `NativeCanonical
QuerySnapshotPort` to indexed pushdown for graph traversal
(`records_by_ids`/`records_by_name`/`graph_edges_by_subject_ids`/
`container_records_by_artifact_references`, `native-query-snapshot-port.ts`),
and that commitment held: every pushdown method was correctly implemented
and indexed. The defect was one layer higher, in the language-neutral query
engine shared by every port (`packages/engine/src/recipe-executor.ts`'s
`toSubjectSelector`), which mislabeled a resolved declaration's logical
`entity_id` under a downstream `SubjectSelector`'s `record_id` field
whenever a pipeline stage bound one operation's output into another's
argument (`bindings: {target: {stage_id, output}}` -- the documented
`core:resolve_symbol -> core:find_references` pattern in `packages/mcp/
src/index.ts`'s own `PIPELINE_EXAMPLE_RESOLVE_TO_REFERENCES`). Against
`SqliteCanonicalQuerySnapshotPort`, this was invisible: that port's
in-memory `by_any_id` map indexes every record under all three identity
forms (`record_id`/`identity_id`/`identity_key`), so a selector carrying
either form under the `record_id` field resolved identically. Against the
native port's own indexed `records_by_ids` (this decision's own
"Structural methods ... read the native store directly" contract), a
`record_id` field must actually decode as `record:<64-hex>` to hit the
`by_identity`-backed lookup; anything else -- including a mislabeled
`identity_id` -- falls into the documented `otherIds` fallback, one linear
decode of the entire visible generation (`scanAll`), repeated on every such
call with no corpus cache to warm.

Fix: `toSubjectSelector` now uses the record's own `record_id` field
directly (falling back to the prior priority order only when a `ResultSubject`
somehow lacks one) -- the selector field is literally named `record_id`, so
it must carry that value, never a different identity mislabeled under it.
Hardening, defense in depth for a caller that legitimately supplies an
`entity_id`/`relation_id` selector by hand: `NativeCanonicalQuerySnapshotPort
.records_by_ids`'s `otherIds` fallback now stops scanning once every
requested id has been found, rather than always walking the complete
generation.

This amendment does not change the pushdown boundary, the native store
format, or which methods are indexed -- it corrects the query-plan-layer
selector construction that fed those already-correct pushdown methods a
wrong identity. `find_references` p50: VS Code ~416ms cold / ~260-270ms
warm (was 116-160s, cold=warm); n8n (heavily-referenced symbol, 50 capped
references/29 owners) ~2.1-2.7s cold / ~540-640ms warm (was >30s, timed
out pre-fix). See the evidence doc for the full before/after table, the
CPU profile pinning `scanAll` at 78.8% of wall time, and two P1/P2 gaps
found live but left unfixed (`core:search_text`'s lexical pushdown declining
even when `search_text_ready` reports true; `core:get_outline`'s
multi-second variance traced to native-store mmap page-fault warm-up, not
an algorithmic full scan).
