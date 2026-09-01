# Large-repository indexing performance findings and optimization handoff

Date: 2026-08-29

Status: **Investigation complete; large-repository optimization incomplete**

This is non-normative engineering evidence. The approved product and runtime
boundaries remain in Decisions 02, 04, 08, 10, 21, 22, and 25. If an
optimization proposed here conflicts with one of those decisions, update the
authority first rather than weakening correctness in implementation code.

## Purpose

This report is a self-contained handoff for a fresh session focused on making
Urdira's complete JavaScript/TypeScript indexing path finish in seconds rather
than tens of minutes or hours. It records:

- the exact large corpus and runtime used;
- measured timings, memory, disk, and failure behavior;
- confirmed bottlenecks and discarded hypotheses;
- fixes already present in the dirty worktree;
- changes that are implemented but not yet validated on the real corpus;
- the recommended implementation order and bounded performance gates; and
- the evidence and commands needed to resume without repeating the
  investigation.

## Executive conclusion

The current route is not acceptable for a production code-intelligence tool.
On the n8n corpus, structural stage 1 became visible after approximately 9 to
9.7 minutes. Structural stage 2 then spent 33.2 minutes in its combined
checker/stream-acceptance path, followed by an immutable-row SQLite preflight
that was still running more than 32 minutes later. The complete index never
reached stage 3 or `ready`. The observed path therefore exceeded one hour
without completing, and one controller request eventually failed at its
absolute IPC deadline.

The evidence does **not** show that Rust is intrinsically slow. It shows that
fast native syntax work is scalarized into 14,082 owner-level interactions and
then followed by repeated TypeScript, canonicalization, staging, digest, and
SQLite work. Rust owns the correct structural frontier, but the surrounding
host pipeline prevents that speed from appearing end to end.

The immediate goal should be a cold complete n8n index below 60 seconds, with
a stretch target below 30 seconds, and content-only incremental P95 below two
seconds. A single-digit cold target should not be promised until row volume,
required checker semantics, and SQLite write amplification are measured after
the set-based redesign. “Seconds, not hours” is realistic; “always under ten
seconds” is not yet supported by evidence.

Do not run another complete n8n campaign before bounded preflights project a
runtime inside that budget. The current architecture would otherwise consume
another hour while adding little diagnostic value.

## Reproducible environment

### Urdira checkout

- Checkout: `<urdira-checkout>`
- Base commit: `7d04d4970ab82e2442f865757c60cc7032affe38`
- Base commit subject: `fix: stabilize indexing and refresh benchmark evidence`
- Worktree: intentionally dirty; it contains the complete native migration
  and subsequent performance fixes. Do not reset or discard unrelated files.
- Node: `v24.18.1`
- pnpm: `11.20.0`
- Rust: `rustc 1.98.0`, Cargo `1.98.0`, edition 2024
- Host: macOS arm64
- Xcode: 26.6, build 17F113
- Xcode license/first-launch status: accepted (`xcodebuild
  -checkFirstLaunchStatus` exits 0)
- Clang: available through the Xcode default toolchain

### Real corpus

- Repository: n8n source tree
- Source coordinate captured during corpus preparation:
  `b3a34fcd...`
- Copied corpus path:
  `<retained-evidence-root>/urdira-n8n-file-backed/corpus`
- The retained copy intentionally has no `.git` directory; use the captured
  source coordinate rather than attempting `git rev-parse` inside it.
- Corpus directory size: approximately 184 MiB
- Workspace files inspected by the controller: 20,279
- JavaScript/TypeScript owners selected by Urdira: 14,082
- Selected JS/TS source bytes: 82,435,420
- A raw extension count returns 14,083 files; the runtime-selected count of
  14,082 is authoritative for benchmark comparisons.
- Corpus digest:
  `sha256:1dd28be497b20c5f1b3585dd7438e69060ef5a2fbe5660a5e7f5d728a492d2ed`
- Mutation trace digest:
  `sha256:72e3a085c88c7aff07a61157f00a534f9debed9ae526651dcdad3b9e3aeff9de`

### Native closure

- Retained closure:
  `<retained-evidence-root>/urdira-n8n-file-backed/native-closure`
- Closure size: approximately 119 MiB
- Target: `darwin-arm64` / `aarch64-apple-darwin`
- Build ID:
  `sha256:cdf72c3b3ec707c4aa66fc1cb98ebfe2a4799675b24df97d5d9f581650aa5042`
- N-API addon digest:
  `sha256:bd31d985cd26992dc6f939905c0bec45e88d924f1e09976549f85373b5c54153`
- Rust syntax worker digest:
  `sha256:c967b4f315b7704320ea81d9f6e1b99c623ee97f3d59c7696e16e40aae63a28e`
- Launcher digest:
  `sha256:5d82f2ee8f199c8eacc46863b93d2c2c13757f592b60febffbf27ecc58799720`
- Private Node digest:
  `sha256:f480e325ee0ca9cb9eef00b5ca6057a2a104807a1b073f1bc373a55c67facff5`

The transient Urdira data root and large spool directories were deleted after
the aborted run to reclaim disk. The corpus, native closure, requests, and
compressed evidence remain available. Approximately 37 GiB was free when this
report was written.

## What the current architecture actually does

The production route is progressive:

1. The source provider enumerates files, reads source content, verifies
   digests, and writes immutable CAS blobs.
2. Rust/Oxc owns structural stage 1: source decoding, syntax parsing,
   declaration/import extraction, direct/reverse dependency state, affected
   closure, and structural fact construction.
3. The host requests Rust facts owner by owner, constructs one
   `FactDeltaStream@2` per owner, validates every row, and stages each stream
   in SQLite.
4. The engine materializes and seals file-backed template sequences, computes
   ordered digests, and publishes the stage into immutable SQLite tables.
5. One supervised Node process prepares a TypeScript program for stages 2 and
   3. Rust remains authoritative for the affected set and dependency graph.
6. The TypeScript process walks one owner at a time for checker-backed
   references, calls, inheritance, inferred types, and diagnostics. Stage 2
   writes the stage-3 subset to a process-local spool so stage 3 does not walk
   the checker a second time.
7. Every semantic owner result again crosses IPC as a separate stream, is
   validated, staged, materialized, sealed, and published.

This division is semantically sound, but owner-level framing and row-level
publication turn bounded native work into tens of thousands of control and
transaction boundaries.

## Measured large-corpus timeline

The following numbers are nested measurements. For example,
`fact_delta_accept` is inside `plugin_analyze`, and the scan's `publish` span
contains analysis, sealing, and the final SQLite transaction. Do not add every
row together.

### Structural stage 1 across four diagnostic runs

| Run | Stage-1 visible | Plugin analyze | FactDelta acceptance | Ordered digests | SQLite publication transaction |
|---|---:|---:|---:|---:|---:|
| Stage-2 accumulation investigation | 581.248 s | 402.707 s | 273.144 s | 19.805 s | 40.365 s |
| Streaming accumulator | 543.809 s | 368.817 s | 245.111 s | 18.547 s | 37.045 s |
| File-backed/FD fix | 578.729 s | 395.801 s | 255.705 s | 30.965 s | 45.834 s |
| SQL-preflight investigation | 563.013 s | 385.692 s | 249.234 s | 30.900 s | 40.900 s |

The last run additionally measured:

- enumeration: 9.273 s;
- source catalog: 83.570 s;
- source ready: 92.845 s total;
- seal: 31.842 s;
- publication-plan construction: 9.994 s;
- publication command count: 71,025;
- plain `run` command count before worker-side execution: 23,678; and
- SQLite transaction message chunks: 579.

The 14,082 stream acceptances alone cost 249.234 s, or approximately 17.7 ms
per owner before accounting for Rust fact-page retrieval and the rest of host
processing. This is a transaction/granularity problem, not an Oxc throughput
problem.

### Structural stage 2

The most complete diagnostic run measured:

- TypeScript semantic program/closure preparation: 4.371 s;
- 14,082 owners completed in the combined checker, IPC, validation, staging,
  and accumulator span: 1,993.004 s (33.22 minutes);
- one semantic shard, no demotion; and
- after owner analysis completed, immutable publication preflight remained in
  SQLite for more than 32 additional minutes before the run was stopped.

No trustworthy split between checker time and acceptance time exists for this
run because the current `worker_wait` and `acceptance` telemetry start before
the same loop and stop after the same loop. Both fields therefore report
1,993.004 s. The separate stage-1 `fact_delta_accept` aggregate proves that
acceptance is material, but stage 2 must be re-instrumented before assigning
all 33.2 minutes to TypeScript.

### End-to-end outcome

- The complete cold index did not finish.
- Stage 3 was never reached in the real n8n run.
- No real n8n incremental mutation result is valid yet.
- The request eventually reported
  `core:ipc_timeout: IPC request exceeded its absolute deadline`.
- Shutdown while the long SQLite operation was active also produced
  `core:daemon_restart_required: The previous daemon did not release its lock
  before the shutdown deadline`.

### Small-fixture evidence

A separate 59-file native fixture completed cold progressive indexing in
1.458 s and incremental progressive indexing in 0.483 s. This confirms that
the architecture can be fast at small scale, but it does not qualify the large
route. The scaling failure is dominated by per-owner fixed costs and repeated
corpus-scale publication work.

## Memory and disk findings

### Original stage-2 accumulation failure

Before the streaming/file-backed fixes, stage 2 accumulated project-sized
arrays in V8 and duplicated each canonical record body into three staging
lanes: records, graph edges, and identities. At approximately 7,000 owners,
each lane had about 1,045,274 rows and occupied roughly 4.86 GiB. The worker
and host retained accepted deltas for later stages, so memory and disk grew
without a useful bound.

### After the fixes

- The complete process-tree RSS sampled during stage 2 oscillated around
  1.4-2.8 GiB, with an observed peak near 2.7 GiB.
- The defective route had already approached roughly 4.9 GiB around owner
  2,000 and continued growing.
- Full canonical bodies now remain only in the primary records/dependencies
  lanes; graph-edge and identity lanes retain indexed fields only.
- Accepted deltas are fed to the accumulator immediately and released.
- Large first publications use externally sorted file-backed sequences with
  32,768-entry chunks and a heap merge.
- The stage-1 candidate spool was approximately 1.3 GiB.
- The later candidate/materialization spool grew to approximately 4.5 GiB.
- A separate bounded semantic spool sample was approximately 21 MiB for 1,900
  owners; do not confuse it with the much larger materialization spool.
- The file-descriptor leak caused by reading only the first entry of a
  file-backed iterator was fixed; the diagnostic run observed no leaked spool
  descriptors after publication.

Memory is materially better, but 2.7 GiB and multi-gigabyte temporary spools
are still too high for the desired tool profile. The next design must reduce
write amplification rather than merely moving retained objects from RAM to
disk.

## Confirmed bottlenecks

### 1. Source catalog and CAS preparation: 92.8 seconds before analysis

**What happens**

The controller spends 9.3 seconds enumerating and 83.6 seconds cataloging
20,147 source artifacts before stage 1 can begin. Instrumented subspans include
about 9.75 seconds waiting for provider batches, 9.41 seconds verifying source
batch digests, 7.07 seconds in 20,147 provider reads, and thousands of CAS file
and directory sync operations. A large portion of the 83.6-second catalog wall
time remains insufficiently attributed.

**Why it is expensive**

- Every source file crosses the Node source-provider path even though the Rust
  worker later reads verified CAS blobs.
- Digest verification and CAS writing may reread or rehash bytes.
- Durability is paid at a very fine granularity.
- Readiness polling performs additional SQLite work while cataloging and
  analysis are active.

**How to fix it**

1. Add non-overlapping timings for filesystem read, hash, CAS existence check,
   CAS write, file sync, directory sync, metadata serialization, and SQLite
   commit.
2. Make first-ingest source reading, hashing, and CAS writing a single pass.
   Use the native digest batch where it removes JavaScript copies, but retain
   host ownership of source access.
3. Skip writes and syncs for CAS blobs that already exist with verified size
   and digest.
4. Batch durability barriers by CAS shard/directory where the storage decision
   permits it; do not silently weaken crash durability.
5. Replace 100 ms readiness polling with an event/status cache or at least a
   one-second benchmark interval. One captured diagnostic reported 359 ms
   average DB-section time across the first 100 readiness polls, demonstrating
   avoidable contention.

### 2. Owner-level Rust fact transfer and FactDelta acceptance

**What happens**

Rust computes and retains structural facts, but the host calls `readFacts` for
one owner, builds one stream, validates it, stages it, promotes its receipt,
and only then requests the next owner. Stage 1 performs this sequence 14,082
times. A typical one-batch delta causes receipt lookup, latest-sequence lookup,
namespace insert, namespace lookup, typed-row inserts, batch-receipt insert,
and final FactDelta promotion.

Relevant code:

- `apps/urdira/src/index.ts`: `readNativeOwnerRows`,
  `consumePlanResponse`, and the `nativeStageOne` owner loop;
- `packages/engine/src/fact-delta.ts`:
  `FactDeltaStreamAcceptanceService.acceptValidated`;
- `packages/storage/src/candidates.ts`:
  `acceptNativeFactDeltaBatch`, `stageFactDeltaStreamBatch`, and
  `completeFactDeltaStream`; and
- `packages/storage/src/sqlite.ts`: `executeStagedFactDeltaBatch`.

**Why it is expensive**

The bounded stream protocol is being used as a scalar RPC protocol. The 4 MiB
and 4,096-row limits bound memory, but they do not require one owner per SQLite
transaction or one process-control round trip per owner.

**How to fix it**

1. Add a private transport-level owner batch that packs multiple existing
   `analyze_artifact`/fact-page requests into one IPC envelope while retaining
   one logical header, scope, digest, and receipt per owner. This need not
   change the public plugin call set.
2. Validate a bounded group by total rows and bytes, not only by owner count.
   A reasonable initial cap is 32-64 owners, 4,096 total rows, or 16 MiB,
   whichever is reached first.
3. Stage all validated batches in one SQLite transaction using the existing
   plural `acceptNativeFactDeltaBatches` machinery or a stricter successor.
   The direct stream path currently calls only the singular method.
4. Batch final FactDelta receipt promotion as part of the same durable group.
5. Replace namespace insert-plus-select with `INSERT ... RETURNING` for fresh
   namespaces and perform exact conflict reads only when a uniqueness conflict
   occurs.
6. Preserve backpressure and fail-closed cancellation at batch boundaries.
   Never retain an unbounded number of completed deltas.

### 3. TypeScript checker owner loop and synchronous RPC granularity

**What happens**

One TypeScript program is prepared correctly, but 14,082 owners are walked
sequentially. Each owner collects identifiers and declarations, makes batched
symbol/type calls for that owner, resolves signatures and aliases, requests
syntactic/bind/semantic diagnostics, builds arrays, constructs a FactDelta,
and performs stream IPC. The remote symbol registry is rotated every 128
owners by disposing and refreshing the snapshot.

Relevant code:

- `packages/plugin-javascript-typescript/src/analyzer.ts`:
  `prepareRustSemanticState`, `analyzeRustSemanticOwner`, and
  `walkRustSemanticOwner`;
- `packages/plugin-javascript-typescript/src/worker.ts`: Rust-authoritative
  `analyze_closure` and `analyze_artifact` branches; and
- `packages/plugin-javascript-typescript/src/semantic-process-transport.ts`:
  one `stream_start` followed by one or more `stream_next` messages per owner.

**What is already correct**

- TypeScript does not rebuild Rust's dependency graph or stage-1 facts.
- Exactly one checker is retained for a Rust-authoritative workspace.
- Symbols and inferred types are already requested in per-owner arrays.
- Alias resolution is guarded by `SymbolFlags.Alias`.
- Stage 2 writes the stage-3 projection to a semantic spool; stage 3 reuses it
  instead of walking the checker again.

**How to fix it**

1. Add precise timings for program prepare/update, AST collection, symbol
   batch, type batch, signature resolution, diagnostics, snapshot rotation,
   FactDelta construction, stream serialization, and semantic spool writing.
2. Analyze bounded groups of owners inside one process call and one checker
   snapshot. Collect identifiers and typed declarations across the group so
   symbol/type APIs operate on larger arrays with fewer synchronous RPC
   boundaries.
3. Return owner-framed results incrementally so the host can validate and
   stage bounded groups without retaining the whole project.
4. Measure snapshot rotation cost. If material, raise the 128-owner interval
   adaptively under an RSS ceiling or add an explicit remote-handle release
   API that does not rebuild/refresh the snapshot.
5. Measure diagnostics separately. If per-file semantic diagnostics dominate,
   batch through a compiler-supported API or compute them once per affected
   project and route them to owners without repeating AST/symbol work.
6. Keep TypeScript as the semantic authority. Replacing the checker with Oxc
   would change meaning and is outside the approved boundary.

A bounded interactive preflight improved 512 semantic owners from about
22.5 seconds to 12.2 seconds while preserving 82,719 relations. That result is
promising but was not stored in the compressed campaign archives; reproduce it
with the new split telemetry before using it as release evidence.

### 4. Misleading timing telemetry

**What happens**

`apps/urdira/src/index.ts` starts `acceptanceStartedAt` before the complete
owner loop and reports it at the same point as `worker_wait`. Consequently the
two values are identical even though the loop contains checker work, stream
IPC, row validation, SQLite staging, and accumulator/spool work.

**How to fix it**

Track additive, non-overlapping counters:

- `worker_request_wait_ms`;
- `stream_batch_wait_ms`;
- `stream_validation_ms`;
- `sqlite_staging_ms`;
- `fact_delta_receipt_ms`;
- `accepted_delta_accumulator_ms`;
- `semantic_spool_write_ms`; and
- `idle_or_backpressure_ms`.

Record count, rows, bytes, and P50/P95/P99 per owner/batch in addition to total
time. Instrumentation must be cheap and disabled by default outside campaigns.

### 5. Immutable-row preflight degenerates on progressive stage 2

**What happens**

`assertPublicationImmutableRows` assumes that rows in the current generation
imply replay. That is false during an initial progressive publication: stage 1
has already published identity assignments in generation 1 when stage 2 uses
the same generation. The stage-2 `identityCount` is therefore non-zero.

The preflight then walks roughly two million new assignments in chunks of
4,096. `fetchExistingRowsById` splits each chunk again into 900-ID `IN (...)`
queries to remain below SQLite's variable limit. A sampled worker stack was in
`node::sqlite::StatementSync::All -> sqlite3_step`, consistent with repeated
random B-tree reads. The loop was still running after more than 32 minutes.

Relevant code:

- `packages/storage/src/publication-authority.ts`:
  `fetchExistingRowsById`, `assertPublicationImmutableRows`, and the
  `identity_assignments` branch.

**Fix already present but not yet real-corpus validated**

The worktree now marks engine-owned file-backed sequences with
`Symbol.for("urdira.file_backed_readonly_array")`. When the candidate state is
`ready`, both record and identity sequences are file-backed, and the publish is
fresh rather than a `publishing` replay, the corpus-scale preflight is skipped.
Every streamed insert window still uses `ON CONFLICT DO NOTHING` followed by an
exact `assert_transaction_changes`; a collision therefore rolls back. A true
`publishing` replay retains exact row comparison.

The focused test is
`tests/phase9-publication.test.ts`:
“reserves corpus-scale immutable-row preflight for replayed file-backed
publications”. It proves the fresh route issues no record/identity count or
`SELECT * ... IN (...)` preflight queries.

This change passed the focused suite but was implemented after the long n8n
run. It still needs a bounded real SQLite preflight and then a complete corpus
run.

**Longer-term fix**

For genuine replay, do not materialize all IDs in JavaScript and issue
thousands of `IN` queries. Compare candidate staging to authoritative tables
with indexed set-based joins or a temporary keyed table, returning only
mismatches. The replay path must remain exact and diagnostic.

### 6. Final publication is command-oriented instead of set-oriented

**What happens**

Stage 1 builds 71,025 publication commands and executes the main transaction
in 37-46 seconds. The code batches adjacent identical commands and streams
512-row occurrence inserts, but the host still transforms candidate rows into
large command/parameter streams after the same information was already staged
relationally.

**Why it is expensive**

- JavaScript builds parameters row by row.
- Parameters cross the worker boundary in hundreds of chunks.
- SQLite maintains secondary indexes during millions of inserts.
- Candidate staging is read, transformed, and then written again.
- Progressive stage 2 sees an existing snapshot and cannot use the narrow
  “first publication” index-drop condition even though it is still part of
  the same initial publication.

**How to fix it**

1. Publish with `INSERT ... SELECT` from candidate staging tables wherever
   final IDs and fields are already known. Keep SQLite as authority; eliminate
   JavaScript command construction rather than replacing SQLite.
2. Materialize deterministic final IDs and digests into a publication-ready
   staging table once, using bounded Rust N-API batches only for pure kernels
   that SQLite cannot express efficiently.
3. Use the persisted `initial_publication` coordinate across all progressive
   stages. During a genuine initial publication, defer or rebuild secondary
   canonical indexes at a deliberate stage boundary rather than maintaining
   all of them row by row in stages 1 and 2.
4. Preserve stage visibility and rollback semantics. If stage 1 must be
   queryable before stage 2, retain the minimum indexes required for that
   contract and defer only optional accelerators.
5. Measure WAL bytes, rows inserted, index pages written, and transaction time
   per final table.

### 7. Repeated spool, canonicalization, and digest passes

**What happens**

The file-backed template sequence is read repeatedly for descriptor
verification, record-set digest, snapshot digest fields, manifest descriptors,
immutability checks, and final insertion. Canonical record bodies are created
for stream validation, packed into staging, reconstructed for materialization,
and encoded again for publication/digests.

The file-backed representation solved the heap failure, but repeated external
merge passes now consume wall time and several gigabytes of temporary disk.

**How to fix it**

1. Make the external-sort merge produce a sealed descriptor containing count,
   ordered digest, byte count, first/last key, and chunk digests.
2. In one verified merge pass, write a publication-ready relational spool and
   calculate all compatible ordered digests incrementally.
3. Let later consumers verify chunk/descriptor digests and stream the exact
   bytes once instead of independently re-canonicalizing every record.
4. Keep different digest domains separate. Fusion means one traversal feeding
   several registered hash writers, not reusing a digest for another contract.
5. Audit N-API call sites to ensure a native canonical/digest result is not
   recomputed by TypeScript in production. TypeScript remains a differential
   test oracle only.

### 8. Cancellation and daemon shutdown are not responsive during long SQLite work

**What happens**

The controller timed out, but the SQLite worker remained inside a synchronous
statement and the daemon could not release its lock before the shutdown
deadline. This turns a performance defect into an operational reliability
problem.

**How to fix it**

1. Remove the pathological query first.
2. Add bounded statement/query budgets and SQLite progress interruption where
   supported.
3. Execute replay diagnostics in bounded segments that return to the worker
   event loop between segments.
4. Make cancellation stop requesting new semantic owners, close active stream
   iterators, interrupt cancellable SQLite work, and preserve the last
   published snapshot.
5. Add a test that cancels during a million-row replay check and proves the
   daemon releases its lock within the shutdown deadline.

## Work duplication audit

### Duplication already removed

- TypeScript no longer emits stage-1 declarations, imports, containment, or
  graph facts on the native route.
- TypeScript no longer computes an affected closure independently of Rust.
- A native stage cannot create the semantic process.
- Native-bound later stages require the exact Rust-authoritative scope.
- Stage 3 reads stage-2 semantic spool output instead of walking the checker
  again.
- Source bytes verified during semantic preparation are represented by
  metadata-only owner payloads afterward.

### Duplication still present

- One logical owner result is validated, encoded into a native column batch,
  exploded into candidate staging, reconstructed into materialization
  templates, re-encoded for digests, and transformed again for final SQLite
  publication.
- Multiple full passes traverse the same file-backed sorted sequence.
- Fresh publication performs replay-style checks unless the new file-backed
  fast path is selected.
- Source bytes may be hashed/read in more than one catalog/CAS step.

### Discarded hypothesis

There is no confirmed duplicate `invokeFactDeltaStream` call per TypeScript
owner in the current large-workspace loop. A truncated command output appeared
to show the assignment twice, but numbered source inspection confirmed one
invocation. Do not optimize or report this as a bug unless a call-count test
demonstrates it.

TypeScript parsing while constructing its semantic checker is also not an
accidental duplicate of Rust output. It is required by the TypeScript compiler
to provide authoritative symbols and types. What must remain forbidden is a
second TypeScript extraction of Rust-owned structural facts.

## Fixes already in the worktree

The dirty worktree includes the following relevant changes:

- Rust workspace, safe core, N-API addon, Oxc syntax worker, protocol, and
  autonomous launcher.
- Mandatory target-bound native closure with no production TypeScript fallback
  for Rust-owned work.
- Exclusive-work ledger between Rust structural operations and TypeScript
  semantic program work.
- Rust-owned direct/reverse graph and incremental affected set.
- `FactDeltaStream@2` direct streaming for the built-in JS/TS plugin.
- TypeScript owner walk narrowed to checker-only facts.
- Per-owner batched symbol/type calls and alias guard.
- Stage-2 to stage-3 semantic spool reuse.
- Streaming acceptance callbacks on every initial progressive stage, allowing
  accepted deltas to be released immediately.
- Externally sorted file-backed candidate accumulators for large first scans.
- Explicit iterator closure to prevent file-descriptor leaks.
- Full body removal from graph-edge and identity staging lanes.
- Incremental auto-vacuum for new databases and bounded cleanup vacuum.
- Persisted `initial_publication` coordinate across progressive recovery.
- Fresh file-backed publication skip for record/identity replay preflight;
  true replay retains exact comparison.
- Exact vector top-k Rust kernel remains active by explicit product choice.

The latest publication-preflight fix has not been exercised by a complete n8n
run. Treat it as implemented and focused-tested, not performance-qualified.

## Query-engine status

The public query engine is not responsible for the hour-long cold index. The
observed `StatementSync.all` stack came from publication's immutable-row
preflight, not a user query operation.

The native exact-vector kernel should remain active. The retained darwin-arm64
report records:

- 1.47x large-workload kernel throughput;
- 31.65% end-to-end improvement;
- 9.32% peak-RSS reduction;
- exact ordered and tie equivalence; and
- no small-query regression.

Continue the approved SQL pushdowns and segmented cursor manifests, but do not
rewrite the complete query engine in Rust or let query work distract from the
indexing critical path.

## Recommended implementation sequence

### Phase 0: trustworthy stage telemetry

Implement the non-overlapping timers described above and add counters for
owners, batches, rows, bytes, IPC frames, SQLite transactions, statements,
WAL bytes, spool bytes, spool passes, snapshot rotations, and process-tree RSS.

Gate: a 512-owner semantic preflight must reconcile total wall time to named
subspans within 5%, with no overlapping fields presented as additive.

### Phase 1: batch owner transport and SQLite acceptance

Batch Rust fact pages and TypeScript owner analyses at the private transport
layer. Add bounded multi-stream validation and stage 32-64 owners per SQLite
transaction. Batch final delta receipts. Preserve individual owner identities,
digests, scopes, and replay semantics.

Gate on 1,000 real n8n owners:

- at least 5x fewer IPC control messages;
- at least 20x fewer SQLite transactions;
- byte-identical accepted deltas and materialization digests;
- peak RSS no higher than the current bounded route; and
- projected full-stage time below 30 seconds for stage 1 acceptance and below
  30 seconds for stage 2 checker plus acceptance.

### Phase 2: set-based publication

Replace JavaScript publication command generation with SQLite
`INSERT ... SELECT` from publication-ready staging. Use explicit initial
progressive publication state to manage secondary indexes once per initial
generation. Retain transaction change assertions and exact replay comparison.

Gate on a scaled staging fixture with the same row distribution as n8n:

- publication transaction below 10 seconds at one million rows and below 15
  seconds at the measured stage-2 volume;
- no more than two full staging-table scans per published table;
- exact snapshot, manifest, record-set, and identity digests; and
- crash/replay tests at every transaction checkpoint.

### Phase 3: checker group walk

Collect lookup nodes across owner groups and use larger symbol/type batches.
Measure and optimize diagnostics and snapshot rotation. Keep one checker and
reuse the stage-3 spool.

Gate on the same fixed 512/1,000-owner n8n slices:

- at least 2x checker throughput relative to the current 12.2-second
  512-owner preflight;
- exact relations, diagnostics, types, ordering, and digests; and
- bounded remote-handle and whole-process RSS growth.

### Phase 4: source catalog single-pass path

Remove duplicate source reads/hashes, batch CAS durability, and stop readiness
polling from contending with the writer.

Gate: complete source readiness for this 184 MiB corpus below 10 seconds on
the reference macOS host, with identical source-state and CAS digests.

### Phase 5: fuse spool and digest traversals

Produce sealed descriptors and publication-ready rows in one external merge.
Feed all registered digest writers from the same ordered traversal while
preserving separate domains.

Gate:

- no more than one full read of each sealed large sequence before SQL
  publication;
- temporary disk below 1.5x final indexed database size;
- no duplicate canonical body serialization in production; and
- exact differential equivalence against the current TypeScript oracle.

### Phase 6: bounded real-corpus run, then campaign

Only after phases 0-5 meet their slice gates:

1. Run one cold n8n index with a 120-second fail-fast stage budget.
2. If complete and below 60 seconds, run one content-only incremental edit.
3. If incremental P95 projection is below two seconds, run the 60-mutation
   sequence.
4. Then run the required three independent macOS-arm64/Linux-x64 campaigns and
   the five-target release qualification.

## Proposed performance budget

This budget is an engineering target for the next session, not an approved
contract yet.

| Component | Cold n8n target |
|---|---:|
| Enumerate + source/CAS ready | <= 10 s |
| Rust syntax/graph/fact production | <= 5 s |
| Rust fact transfer + validation/staging | <= 8 s |
| TypeScript program prepare | <= 5 s |
| Checker owner groups + semantic staging | <= 15 s |
| Materialization + all ordered digests | <= 8 s |
| Set-based final SQLite publication | <= 10 s |
| Complete cold index, allowing overlap | <= 60 s; stretch <= 30 s |
| Content-only incremental P95 | <= 2 s; stretch <= 1 s |
| Peak process-tree RSS | <= 2 GiB; stretch <= 1.5 GiB |

Forecast and abort a run when a bounded sample projects more than twice its
stage budget. Do not wait an hour to confirm a linear per-owner cost.

## Correctness and reliability gates

Every optimization must retain:

- 100% visible digest equivalence between full and incremental results;
- exact ordering, diagnostics, provenance, spans, and dependency identities;
- one producer for every Rust-owned structural operation;
- TypeScript authority for resolution, symbols, types, and diagnostics;
- bounded framing, backpressure, cancellation, and memory;
- immutable snapshots and exact cursor behavior;
- crash/retry/replay correctness at every durable boundary;
- no silent fallback to TypeScript stage 1 or an unverified native build; and
- last-published-snapshot preservation on every failure.

Required focused scenarios include create, delete, rename, broken import,
cycles, `tsconfig`, manifests, compiler options, worker crash, false handshake,
corrupt spool, SQLite conflict, cancellation, quarantine, and memory pressure.

## Current verification state

Verification recorded before the grouped follow-up implementation:

```text
pnpm typecheck
  PASS

pnpm exec vitest run \
  tests/phase9-publication.test.ts \
  tests/phase9-materialization.test.ts \
  tests/phase-workspace-indexing-session.test.ts
  3 files passed, 171 tests passed
```

Earlier, before the latest large-corpus fixes, `pnpm verify` passed with 116
test files, 1,892 tests, Rust tests, format, clippy, architecture, lint,
typecheck, and coverage gates. That result must not be presented as a full
verification of the current dirty worktree. Run the complete gate only after
the next focused implementation cycle stabilizes.

Release qualification is still incomplete on darwin-x64, linux-arm64-gnu,
linux-x64-gnu, and win32-x64. Cross-compilation alone is not acceptance.

## Evidence inventory

The following compressed archives contain `run.log`, `controller.json`,
`requests.ndjson`, and `result.ndjson`. They are in a host-local retained
evidence root and may not
survive a reboot; preserve them before machine cleanup if they are still
needed.

- `<retained-evidence-root>/urdira-n8n-stage2-accumulation-evidence-20260829.tgz`
  (`sha256:349e3fc5c342a58ed56a4e5d3ad806a4b433207649b14d1bc570703d8f3aef2d`)
- `<retained-evidence-root>/urdira-n8n-stream-accumulator-evidence-20260829.tgz`
  (`sha256:08e74d64caf46bd92c8511a11ecca72786831cc466d4c1087317330b3ce2ef55`)
- `<retained-evidence-root>/urdira-n8n-file-backed-fd-evidence-20260829.tgz`
  (`sha256:306ec860bedf97caa26f637ea8afab2ea24f76a5c9fab491c16e6b75e74c52b7`)
- `<retained-evidence-root>/urdira-n8n-file-backed-sql-preflight-evidence-20260829.tgz`
  (`sha256:8c51a82b4f6203b6c944ab5d6b0a415d3c4e62b04f5b4497bf2a25ea9953cbc2`)
- `<retained-evidence-root>/urdira-n8n-third-run-aborted-evidence-20260829.tgz`
  (`sha256:bbdd8399d22122e45011eb758e46ae7afcf2d46cbe9c878ca9e271aec7ac4ce8`)

Other relevant repository evidence:

- `docs/evidence/2026-08-28-rust-native-route.md`
- `docs/decisions/25-rust-native-acceleration.md`
- `release/reports/exact-vector-top-k-darwin-arm64-2026-08-28.json`
- `release/benchmarks/native-acceleration/typescript-b465fdb-60.trace.json`

The third run was deliberately stopped around structural-stage-1 owner 6,900
because another complete campaign was not justified before fixing the known
bottlenecks. No benchmark process remains active. Two per-user Urdira daemons
from an installed runtime were observed separately and were intentionally not
terminated because they are not owned by this campaign.

## High-value files for the fresh session

- `apps/urdira/src/index.ts`: stage orchestration, per-owner loops, Rust/TS
  exclusivity, stream acceptance, and currently misleading timing fields.
- `packages/plugin-javascript-typescript/src/analyzer.ts`: checker preparation,
  owner walk, symbol/type batching, diagnostics, and snapshot rotation.
- `packages/plugin-javascript-typescript/src/worker.ts`: Rust-authoritative
  semantic route and stage-2/stage-3 spool.
- `packages/plugin-javascript-typescript/src/semantic-process-transport.ts`:
  process framing and one-owner stream protocol.
- `packages/engine/src/fact-delta.ts`: stream validation and sequential staging
  acknowledgement.
- `packages/engine/src/candidate-materialization.ts`: external sorted spool,
  packed identities, and file-backed descriptors.
- `packages/engine/src/workspace-indexing-session.ts`: progressive stage state,
  immediate accumulator feeding, and persisted `initial_publication`.
- `packages/storage/src/candidates.ts`: singular/plural native batch acceptance
  and FactDelta promotion.
- `packages/storage/src/sqlite.ts`: synchronous SQLite worker execution and
  typed staging inserts.
- `packages/storage/src/publication-authority.ts`: immutable preflight, repeated
  sequence passes, final command generation, index management, and transaction.
- `packages/storage/src/storage.ts`: candidate cleanup and bounded incremental
  vacuum.
- `tests/phase9-publication.test.ts`: fresh file-backed preflight and publication
  batching tests.
- `tests/phase9-materialization.test.ts`: file-backed accumulator behavior.
- `tests/javascript-typescript-incremental-analysis.test.ts`: full/incremental
  semantic differential authority.
- `tests/javascript-typescript-semantic-process-transport.test.ts`: semantic
  process protocol and failure behavior.

## Fresh-session starting instructions

Start by reading this report and Decisions 21, 22, and 25. Preserve the dirty
worktree. Do not launch the complete n8n corpus yet.

The first implementation should be narrowly scoped:

1. Replace the overlapping owner-loop timers with non-overlapping metrics.
2. Add a deterministic 512/1,000-owner n8n preflight that reports checker,
   IPC, validation, SQLite staging, accumulator, and RSS separately.
3. Implement bounded owner-group transport and plural SQLite staging without
   changing per-owner semantic identities.
4. Prove exact digest/result equivalence and a large reduction in transaction
   count.
5. Then implement set-based publication and validate the fresh-preflight skip
   on the real SQLite shape.

Suggested opening prompt for the new session:

> Read `docs/evidence/2026-08-29-indexing-performance-findings.md` and the
> authoritative Decisions 21, 22, and 25. Continue from the existing dirty
> worktree. Do not run a complete n8n campaign. First fix the overlapping
> telemetry, create a bounded 512/1,000-owner real-corpus preflight, and batch
> owner IPC plus FactDelta SQLite acceptance while preserving exact per-owner
> scopes, digests, replay, cancellation, and Rust/TypeScript exclusive-work
> boundaries. Demonstrate that no Rust-owned or checker-owned operation is
> repeated by the other runtime, then proceed to set-based publication only
> after the measured split identifies the remaining dominant cost.

## Implementation update: bounded groups and one-pass native capture

The follow-up implementation replaced the singular private hot paths while
preserving the per-owner logical contract:

- Rust stage-one facts cross the process boundary in groups bounded by 64
  owners, 4,096 rows, and 16 MiB. Per-owner continuation cursors preserve giant
  owner identity and ordering.
- FactDelta streams remain independently validated. Normal physical groups
  stage typed rows and durable receipts atomically in one SQLite transaction;
  scalar staging remains a compatibility fallback.
- The TypeScript semantic process accepts ordered groups of at most 32 owners,
  returns owner-delimited streams, keeps one compiler program for the
  generation, and releases group source handles at group close. A result group
  over its row/byte budget is split deterministically without reordering.
- Native directory enumeration uses one digest pass with per-file
  stat-before/stat-after validation. It retains a canonical byte prefix under
  the 64 MiB budget for direct CAS hand-off, caps reads at eight lanes, and
  eagerly registers remaining hand-off promises before consumption. Excluded
  binary files release provisional byte reservations immediately.
- Source catalog SQL uses 512-row `run_batch` commands. Internal readiness is
  event-driven with a one-second fallback poll. Debug timing is disabled by
  default and emits non-overlapping totals plus nearest-rank P50/P95/P99.

Focused verification after these changes:

```text
pnpm typecheck
  PASS

pnpm exec vitest run \
  tests/phase9-deltas.test.ts \
  tests/fact-delta-batch.test.ts \
  tests/javascript-typescript-semantic-process-transport.test.ts \
  tests/javascript-typescript-incremental-analysis.test.ts \
  tests/phase7-indexing.test.ts \
  tests/phase7-providers.test.ts \
  tests/indexing-debug-timing.test.ts
  7 files passed, 115 tests passed
```

The 4,300-file, two-fragment hand-off regression completed in 6.85 seconds in
its focused test. That measurement includes fixture creation, enumeration,
stream claims, content consumption, and post-read boundary checks; it is a
regression gate, not an n8n SLA result.

No complete n8n run or P95 campaign was executed for this update. The
30-second cold SLA, 2-second incremental SLA, RSS/disk limits, and the
512/1,000-owner projection remain unqualified until the bounded preflights and
exact differential evidence pass.

The repository-wide verification then completed 117 test files and 1,900
tests, with 90.20 percent line coverage and all architecture, Rust format,
clippy, Rust test, lint, typecheck, coverage, and critical-region gates
passing. Its final publication-hygiene step identified the host-local paths in
this historical report. After replacing those paths with portable evidence
root markers, the exact final checks passed:

```text
pnpm check:publication
  PASS (755 files checked)

git diff --check
  PASS
```

## Bounded n8n preflight result after grouping

The deterministic preflight command now verifies the retained n8n corpus
digest before creating canonical 512- and 1,000-owner slices. It records the
slice owner-manifest digest, non-overlapping phase timings, process-tree RSS,
final data-root bytes, the visible-set digest, wall/subspan reconciliation,
and a checksum for a successful report. It stages either an already verified
native closure or raw artifacts for the current host. The command is:

```text
pnpm preflight:structural-indexing -- \
  --corpus <retained-n8n-corpus> \
  --mutation-trace <retained-n8n-mutation-trace> \
  --native-root <current-native-artifacts> \
  --output <temporary-output>/structural-preflight.json
```

The latest 512-owner cold attempt used the required corpus digest
`sha256:1dd28be497b20c5f1b3585dd7438e69060ef5a2fbe5660a5e7f5d728a492d2ed`
and the current darwin-arm64 native workers. It did not pass the admission
gate. All three structural stages published, but the controller then reached
its 120-second deadline because its historical 50-poll quiescence rule became
a 50-second wait when this preflight selected a one-second fallback interval.
That harness defect is now fixed by expressing the same historical 500 ms
window as elapsed time with at least two identical observations. The stage
timings below remain valid performance evidence even though that attempt did
not emit its final reconciled JSON report:

| Stage | Source ready | Plugin analysis | Seal | Publish span | Stage total |
| --- | ---: | ---: | ---: | ---: | ---: |
| `jsts:structural_stage_1` | 1.394 s | 6.810 s | 1.200 s | 9.905 s | 11.329 s |
| `jsts:structural_stage_2` | 0.092 s | 27.409 s | 4.339 s | 47.205 s | 47.299 s |
| `jsts:structural_stage_3` | 0.638 s | 15.781 s | 1.328 s | 31.666 s | 32.306 s |

These stage totals are sequential readiness boundaries and sum to 90.934
seconds. The `publish` span includes analysis and seal; it must not be added
to those nested values. The non-overlapping grouped analysis split reports:

| Stage | Worker wait | Acceptance/staging | Grouped wall |
| --- | ---: | ---: | ---: |
| stage 1 | 3.585 s | 3.158 s | 6.744 s |
| stage 2 | 5.512 s | 21.413 s | 26.924 s |
| stage 3 | 1.190 s | 14.113 s | 15.302 s |

Publication command compaction reduced the fixed transaction plans to 320,
1,010, and 409 commands for stages 1, 2, and 3 respectively. The corresponding
SQLite transaction spans were 1.128 s, 8.218 s, and 3.183 s. Stage 2 therefore
still misses the plan's 15-second stage-volume gate, and the complete
structural path remains well above the bounded 45-second admission threshold
and the final 30-second SLA.

The preflight also proved that source capture/CAS is no longer the dominant
cost on this bounded slice. The remaining dominant path is per-record
semantic validation/canonicalization/staging followed by three independently
sealed and published generations. Collapsing those publications is not
permitted by the current progressive-publication contract, which makes each
stage independently visible and recoverable. Reaching the SLA therefore
requires either the specified core-owned Rust validation/canonicalization
kernel plus a genuinely set-based publication transaction, or an approved
initial-generation accumulation contract that publishes all structural stages
once without weakening crash recovery.

Per the admission rules, the 1,000-owner preflight, complete n8n cold run,
incremental mutation, and P95 campaigns were not run. This result is a failed
performance gate, not an SLA qualification. A post-fix retry against the
currently available n8n checkout was rejected before indexing because its
corpus digest did not match the retained authority; no substitute corpus was
used to manufacture a passing report.

## Set-based publication and final bounded retry

The implementation follow-up added the core-owned Rust UCE kernel for exact
record validation, canonicalization, and digest projection; accumulated the
initial stage-2/stage-3 frontier into one owner-group route; staged canonical
records, facets, identities, projections, dependencies, and value nodes into
candidate-scoped typed tables; and replaced per-row final publication commands
with a fixed set of `INSERT ... SELECT` statements. The TypeScript checker now
retains one `Program`, accepts bounded owner groups, and computes the three
compiler diagnostic categories once per program before partitioning them back
into their original per-owner category order. Reconstructible typed staging is
cleaned after the visible commit instead of extending the atomic publication
transaction.

The one-million-row SQLite microgate passed without a Rust SQLite fallback:

| Metric | Result | Gate |
| --- | ---: | ---: |
| Published rows | 1,000,000 | 1,000,000 |
| Transaction | 9,454.544 ms | <10,000 ms |
| Publication statements | 7 | fixed count |
| Final/integrity rows | 1,000,000 / `ok` | exact |
| Staging rows after commit | 0 | 0 |
| Peak observed bytes / final DB | 1.988x | <=1.5x |

The transaction gate therefore passes and does not authorize a `rusqlite`
implementation. The temporary-space ratio remains a failed resource gate and
must be reduced independently. The checksummed evidence is
`release/benchmarks/sqlite-publication-microgate-2026-08-29.json`
(`sha256:b56925a79987bb032836ee4478d39f5dd247bc92d3f309128dd87d67b579197a`).

The final admissible 512-owner retry used the retained authority digest
`sha256:1dd28be497b20c5f1b3585dd7438e69060ef5a2fbe5660a5e7f5d728a492d2ed`
and produced this result:

| Metric | Result | Gate |
| --- | ---: | ---: |
| Wall time | 68,309.906 ms | <45,000 ms admission; <=30,000 ms SLA |
| Reconciliation error | 0.0349% | <=5% |
| Peak process-tree RSS | 2,456,797,184 bytes | <=2 GiB |
| Final data root | 2,394,100,465 bytes | observation |
| Visible-set digest | `sha256:b0bca5901be3cdc71c500ff3180df59c663b5e77645c4165cd0779b8703e0934` | exact baseline |

The exact output is unchanged and the result improves on the previous valid
71,969.758 ms grouped retry, but both the 45-second admission threshold and RSS
gate still fail. The remaining measured critical path is no longer SQLite's
set-based million-row transaction: stage-3 grouped checker plus validation and
staging consumed 25.949 seconds, candidate sealing consumed 5.568 seconds, and
the stage-3 publish span consumed 52.284 seconds, including 10.581 seconds of
plan construction and 7.904 seconds in the final SQL transaction. These spans
identify duplicate generic FactDelta staging/materialization and candidate
replay comparison as the next optimization targets; changing database engines
would not address the dominant measured work.

The report and sidecar are
`release/benchmarks/n8n-structural-preflight-512-2026-08-29-global-diagnostics.json`
and `.sha256`
(`sha256:868adf610d28ef7dc17d6201440733440b43eee00c564bab5d6342317cf91f3c`).
Because the exact 512-owner wall time is not below 45 seconds, the 1,000-owner
preflight, complete n8n run, incremental mutation, and P95 campaign were not
executed.

## Rust-sealed typed publication follow-up

The next implementation removes the remaining JavaScript reconstruction loop
from the eligible fresh-record path. Native binding API v14 emits the record
id/digest, relational body digest and byte count, exact UCE body payload,
facets, and created-identity fields in the same bounded structural-kernel
result. Those fields travel beside the complete canonical FactDelta row and
are promoted to candidate publication staging by ordered SQL window queries.
Rows whose body-key order cannot prove exact equivalence with the historical
logical writer fail closed to the existing materializer; replacement-salted
incremental records are not eligible.

Replay now compares sealed staging to authority with null-safe SQL joins and a
bounded `EXCEPT` probe instead of corpus-sized JavaScript id arrays. Workspace
publication remains in WAL mode and requests best-effort truncating
checkpoints before and after the initial transaction. The isolated microgate
uses `DELETE` journal mode with `synchronous=FULL` only because it owns every
connection and has no concurrent reader.

The repeated one-million-row microgate passed:

| Metric | Result | Gate |
| --- | ---: | ---: |
| Published rows | 1,000,000 | 1,000,000 |
| Transaction | 5,677.647 ms | <10,000 ms |
| Publication statements | 7 | fixed count |
| Integrity | `ok` | exact |
| Peak observed bytes / final DB | 1.000x | <=1.5x |

The transaction remains below the Rust-SQLite fallback threshold, so a
`rusqlite` writer is still not authorized. Checksummed evidence is retained at
`release/benchmarks/sqlite-publication-microgate-2026-08-29-rust-typed.json`
and its `.sha256` sidecar. The 512-owner preflight is the next and only
repository-scale gate; 1,000 owners and full n8n remain blocked unless it is
strictly below 45 seconds.

### Final API v14 512-owner gate

The bounded retry exposed and then closed two private-transport edge cases:
the process-neutral stream byte length could not depend on whether the
receiving process had activated the typed kernel, and a near-limit valid
stream could not be rejected merely because the additive UCE-hex projection
exceeded the private physical batch budget. The stable six-column stream is
now authoritative for the protocol length; oversized typed projections fail
closed to the complete canonical materializer.

The completed retry produced:

| Metric | Result | Gate |
| --- | ---: | ---: |
| Wall time | 68,958.846 ms | <45,000 ms admission; <=30,000 ms SLA |
| Reconciliation error | 0.0343% | <=5% |
| Peak process-tree RSS | 2,414,034,944 bytes | <=2 GiB |
| Final data root | 2,414,248,687 bytes | observation |
| Visible-set digest | `sha256:b0bca5901be3cdc71c500ff3180df59c663b5e77645c4165cd0779b8703e0934` | exact baseline |

Stage 1 reached structural readiness in 11.821 seconds and its publication
plan/transaction fell to 1.501/0.582 seconds. This confirms the direct typed
route works where its first-generation identity proof applies. The combined
stage-3 path remains dominant: grouped checker and acceptance consumed 30.199
seconds, sealing 5.548 seconds, and the stage reached readiness at 53.408
seconds. Its publication still used the exact generic fallback and consumed
6.259 seconds planning plus 7.074 seconds in the SQL transaction.

The report and sidecar are
`release/benchmarks/n8n-structural-preflight-512-2026-08-29-rust-typed.json`
and `.sha256`
(`sha256:c206ecdb64cba4686b37aefaa45b49ab1b5a2e52094b2929bd249eafccdaf4fa`).
Because 512 owners remain above 45 seconds, the 1,000-owner preflight, complete
n8n run, incremental mutation, and P95 campaign were not executed.

The completed preflight also exposed a lexical-maintenance lock while the
runtime experiment attempted to switch the workspace from WAL to `DELETE`
journal mode. The structural snapshot still completed with the exact digest,
but changing journal mode in a composed daemon is incompatible with concurrent
readers. The runtime journal switch was therefore removed after this run:
workspace publication now stays in WAL and treats its surrounding truncating
checkpoints as best-effort maintenance. The 512-owner benchmark was not
repeated, so its timing above describes the measured API v14 run before that
correctness correction. The final WAL-only runtime passed the focused storage,
publication, and application-runtime suite (206 tests), including a regression
that pins a concurrent reader to the preceding snapshot. `pnpm verify` then
passed with 1,902 tests, 90.11% measured repository line coverage, 100% critical
branch coverage, and publication hygiene over 783 files.

## Generic cold/incremental fast-path result

The next implementation step made the optimized route an explicit
language-neutral protocol rather than a JavaScript/TypeScript publication
special case. The TypeScript compiler is now only the first semantic-oracle
adapter. Core-owned validation, canonicalization, typed staging, receipt
durability, lifecycle closures and set-based SQLite publication remain reusable
by future language adapters. The normative internal contract is
`docs/protocol/structural-indexing-fast-path.md`.

Semantic process protocol 1.3 now returns group headers without batches and
pulls each owner with `semantic_group_next`. One prepared checker performs the
group-wide symbol/type lookups and remains live for the generation. The first
512 attempt exposed an important boundary error: the checker process treated
its lookup group as if it were also the 4,096-row durability group and rejected
a valid result after earlier owners had already streamed. The corrected route
keeps lookup grouping and durability grouping separate. Owner frames continue
unchanged, while the generic core acceptance service seals physical groups at
64 owners, 4,096 rows or 16 MiB and isolates an oversized owner. A regression
uses two owners whose combined semantic output exceeds 4,096 rows.

Progressive initial successors can now use native typed publication even when
the earlier syntax snapshot is already visible, provided the stage contains
only first opens with exact promoted identities. Incremental record closures
are persisted in the additive v3
`candidate_publication_record_closures` relation and applied by one set-based
`UPDATE`; replacement-salted or absence-barrier opens retain the exact
canonical fallback.

The final repository gate passed after these changes:

```text
pnpm verify
  117 test files passed, 1,903 tests passed, 7 skipped
  repository line coverage 90.10%
  critical branches 100.00%
  publication hygiene passed (788 files checked)
```

The one-million-row SQLite gate also passed without authorizing a `rusqlite`
fallback:

| Metric | Result | Gate |
| --- | ---: | ---: |
| Published/final rows | 1,000,000 / 1,000,000 | exact |
| Transaction | 5,782.481 ms | <10,000 ms |
| Publication statements | 7 | fixed count |
| Integrity / residual staging | `ok` / 0 | exact |
| Peak observed bytes / final DB | 1.000x | <=1.5x |

Evidence is retained at
`release/benchmarks/sqlite-publication-microgate-2026-08-29-generic-fast-path.json`
and its sidecar
(`sha256:d6ee5a31ecc2b291aea227c5de1d433e874cd585eacea76009ce02bcff50acea`).

The admitted 512-owner retry completed with exact visible output but remained
above both the time and RSS gates:

| Metric | Result | Gate |
| --- | ---: | ---: |
| Wall time | 66,476.498 ms | <45,000 ms admission; <=30,000 ms SLA |
| Reconciliation error | 0.0356% | <=5% |
| Peak process-tree RSS | 2,251,423,744 bytes | <=2 GiB |
| Final data root | 2,359,775,985 bytes | observation |
| Visible-set digest | `sha256:b0bca5901be3cdc71c500ff3180df59c663b5e77645c4165cd0779b8703e0934` | exact baseline |

This is a 2,482.348 ms improvement over the preceding 68,958.846 ms API-v14
run, but not an admission pass. Stage one reached readiness in 11.858 seconds.
The accumulated stage-three route remained dominant at 51.266 seconds:
checker/acceptance was 27.221 seconds (26.890 seconds acceptance), sealing was
5.531 seconds, typed staging was 4.797 seconds, and publication planning/SQL
were 7.109/7.070 seconds. The visible-set digest and owner-manifest digest
(`sha256:24bb7b73b29409221e69c3622d4ed9dbed308914fe9e8df5444ab6b9d9ea559b`)
match the retained baseline.

The report and sidecar are
`release/benchmarks/n8n-structural-preflight-512-2026-08-29-generic-fast-path.json`
and `.sha256`
(`sha256:f51ef2b28c37d218f24cc0295f605d099995761fac99f875ea599763e195d2bd`).
Because 512 is not below 45 seconds, the 1,000-owner preflight, complete n8n
run, incremental mutation and P95 campaign were not executed.

## Rust preseal inside the semantic process

The next implementation moves the generic structural-kernel execution to the
far side of the remaining TypeScript process boundary. Semantic protocol 1.4
receives the exact addon path already verified by the composition root and
rejects ambient, relative or API-incompatible bindings. JavaScript/TypeScript
continues to own checker semantics; the addon owns only canonicalization,
content identities, registered digests and typed publication scalars.

Each owner now constructs its proposed records and dependencies once. The
previous path reconstructed records for diagnostic discovery, aggregate
digests and stream emission, then invoked the same native kernel again while
changing provisional framing into final framing. The new owner-local preseal
uses one immutable row set, primes canonical bytes during physical budgeting,
reuses them for the delta/header digests, and suppresses the duplicate N-API
pass. Owner rows are still released after acknowledgement, so incremental work
uses the identical path without retaining a corpus-wide result.

Focused protocol, direct-stream, native-runtime and FactDelta tests passed, as
did the complete repository gate (117 test files and 1,904 tests, with 7
skipped; 90.10% repository line coverage and 100% critical branches).

The admitted 512-owner run then proved that pre-sealing alone was placed too
early to remove the dominant host cost:

| Metric | Result | Prior generic fast path |
| --- | ---: | ---: |
| Wall time | 66,534.160 ms | 66,476.498 ms |
| Reconciliation error | 0.0343% | 0.0356% |
| Peak process-tree RSS | 2,340,651,008 bytes | 2,251,423,744 bytes |
| Final data root | 2,414,314,225 bytes | 2,359,775,985 bytes |
| Visible-set digest | `sha256:b0bca5901be3cdc71c500ff3180df59c663b5e77645c4165cd0779b8703e0934` | exact match |

The semantic checker wait fell to 329 ms, but host acceptance consumed 29,185
ms. Row validation itself accounted for only 276 ms; the protocol still issued
one synchronous `semantic_group_next` round trip for every owner even though
the checker had prepared a 32-owner group. Typed staging used 4,841 ms, sealing
5,420 ms, and publication planning/SQL 6,926/7,110 ms. The report is retained
at `release/benchmarks/n8n-structural-preflight-512-2026-08-29-rust-preseal.json`
with checksum
`sha256:937284dc84ee075fc6b970a651596688afbc5a185b89544116656d38ae8ce0df`.
The 1,000-owner and full-n8n gates remain blocked.

Protocol 1.5 therefore replaces the per-owner continuation with one bounded
owner-group drain. A response carries as many ordered, owner-delimited batches
as fit under 16 MiB plus the exact next-owner cursor; an oversized owner keeps
its own sequence and continues without merging logical identity or durability.
The core still validates every logical row and controls the downstream 4,096
row/16 MiB transaction boundary. Focused TypeScript compilation and the
result-heavy semantic transport/FactDelta tests pass. No second 512-owner run
is recorded until the full verification gate for protocol 1.5 passes.

The verified protocol-1.5 512-owner run showed that control-frame latency was
not the remaining acceptance cost:

| Metric | Protocol 1.5 result | Rust-preseal result |
| --- | ---: | ---: |
| Wall time | 68,363.314 ms | 66,534.160 ms |
| Semantic checker wait | 353 ms | 329 ms |
| Host acceptance | 29,099 ms | 29,185 ms |
| Group commits | 4,518 ms / 37 groups | observation |
| Record validation | 285 ms | 276 ms |
| Typed staging | 5,026 ms | 4,841 ms |
| Seal | 5,522 ms | 5,420 ms |
| Publication planning / SQL | 7,264 / 7,229 ms | 6,926 / 7,110 ms |
| Peak process-tree RSS | 2,644,426,752 bytes | 2,340,651,008 bytes |
| Visible-set digest | `sha256:b0bca5901be3cdc71c500ff3180df59c663b5e77645c4165cd0779b8703e0934` | exact match |

The report is retained at
`release/benchmarks/n8n-structural-preflight-512-2026-08-29-group-drain.json`
with checksum
`sha256:4fccad23c1f377a07f90720cf131a727e019c8be5914310b98515fc79feafd7b`.
The bounded drain reduced control frames but left V8 serializing and
deserializing 221,748 nested logical row objects. The 1,000-owner and full-n8n
gates therefore remain blocked.

Protocol 1.6 attempted the next measured step: the semantic process used the
exact core addon to return owner-delimited `FactDeltaBatch` arenas plus closed
stream metadata. The host no longer asks V8 to clone each nested record and
dependency graph. It restores exclusive backing-buffer ownership after V8
decoding, validates the typed batch, extracts the canonical logical-row column,
and runs the unchanged `FactDeltaStreamBatch` validator before the core creates
its own staging projection. This deliberately preserves the plugin trust
boundary: producer-supplied typed scalars are transport data and cannot become
publication authority without core validation.

That experiment was exact but regressed both limits:

| Metric | Protocol 1.6 typed transport | Protocol 1.5 |
| --- | ---: | ---: |
| Wall time | 69,750.828 ms | 68,363.314 ms |
| Host acceptance | 31,835 ms | 29,099 ms |
| Semantic checker wait | 379 ms | 353 ms |
| Peak process-tree RSS | 3,558,293,504 bytes | 2,644,426,752 bytes |
| Final data root | 2,414,367,473 bytes | 2,336,457,457 bytes |
| Visible-set digest | `sha256:b0bca5901be3cdc71c500ff3180df59c663b5e77645c4165cd0779b8703e0934` | exact match |

The report is retained at
`release/benchmarks/n8n-structural-preflight-512-2026-08-29-columnar-semantic.json`
with checksum
`sha256:943807994adbef8db80ef16636691f869246b563d68d560f0fe4cf156c43cb3e`.
The ownership copies required after `node:v8` deserialization duplicated the
large arenas while the host still reconstructed every logical row. That exact
implementation was therefore removed rather than retained as an optimization.

Protocol 1.7 keeps the useful bounded owner cursor but transports only the
canonical record and dependency rows already cached by the Rust preseal. It
does not send producer-owned staging columns, shared typed arenas or nested row
graphs. The core parses and validates the closed logical rows, then creates its
own trusted typed staging projection. This is the last admissible optimization
that still reconstructs logical rows in the host; if it does not remove the
acceptance span, the next implementation boundary is a core-owned Rust
acceptance/materialization service that consumes the sealed rows and emits the
candidate staging descriptor and receipt directly.

The verified protocol-1.7 run was exact, but it did not remove that span:

| Metric | Protocol 1.7 sealed rows | Protocol 1.5 |
| --- | ---: | ---: |
| Wall time | 67,333.198 ms | 68,363.314 ms |
| Host acceptance | 29,101 ms | 29,099 ms |
| Semantic checker wait | 342 ms | 353 ms |
| Group commits | 4,485 ms / 37 groups | 4,518 ms / 37 groups |
| Record validation | 322 ms | 285 ms |
| Typed staging | 4,604 ms | 5,026 ms |
| Seal | 5,393 ms | 5,522 ms |
| Publication planning / SQL | 6,623 / 7,126 ms | 7,264 / 7,229 ms |
| Peak process-tree RSS | 2,912,485,376 bytes | 2,644,426,752 bytes |
| Final data root | 2,338,640,623 bytes | 2,336,457,457 bytes |
| Visible-set digest | `sha256:b0bca5901be3cdc71c500ff3180df59c663b5e77645c4165cd0779b8703e0934` | exact match |

The 1.030-second wall improvement is only 1.5%, while RSS increases by about
10%. More importantly, acceptance remains effectively unchanged. The bounded
transport is therefore useful protocol hygiene, but it is not the performance
boundary required by the SLA. The report is retained at
`release/benchmarks/n8n-structural-preflight-512-2026-08-29-sealed-canonical.json`
with checksum
`sha256:b2260fa8552b8b162c82dd3fd9a25ccbfcddc187341ae2593e0a6a6bea185065`.
Because the result remains above 45 seconds, the 1,000-owner and complete-n8n
gates remain blocked. The next implementation must remove host logical-row
reconstruction entirely and place validation, materialization, IDs, registered
digests, typed staging and the sealed receipt behind a generic core-owned Rust
port. Language engines may supply facts to that port, but cannot specialize or
bypass it.

The first implementation step after that failed gate batches the already
core-owned structural kernel across prepared semantic owners. The generic
`prepareFactDeltaStreamStructuralGroup` port accepts at most 64 owners and
4,096 rows, invokes Rust once for the physical partition, and caches the result
against each immutable row before the JavaScript/TypeScript adapter seals the
independent streams. Owners above the row bound retain their own cursor. A
failed group preseal falls through to the unchanged scalar validator, so it
cannot weaken validation or receipts. Focused direct-stream, semantic-process
and FactDelta tests pass.

The subsequent exact 512-owner measurement completed in 67,132.475 ms with
the same visible-set and owner-manifest digests. Group preseal reduced peak RSS
to 2,737,569,792 bytes, but acceptance remained 29,097 ms; the 201 ms wall
change is noise relative to the SLA. Typed staging was 4,602 ms, sealing 5,518
ms, and publication planning/SQL 6,383/7,027 ms. The report is retained at
`release/benchmarks/n8n-structural-preflight-512-2026-08-29-group-rust-preseal.json`
with checksum
`sha256:c366b4d1374618eb485467b6e883192b1d3b28fb337cd3d1dd5d5fd87bb2a520`.
The 1,000-owner and complete-n8n gates remain blocked.

This result moves the next cut inside the Rust kernel itself. The original
kernel converted every typed record into a generic JSON value, then walked the
record and body repeatedly for canonical JSON, UCE, logical-value digests,
body payloads and identity objects. The replacement writes the canonical row
and UCE record digest directly from the typed Rust structure, emits the body
logical digest and UCE payload in one recursive traversal, and derives identity
digests without allocating temporary JSON objects. The TypeScript native-API
oracle remains byte-for-byte authoritative; the optimized addon passes its
canonical row, digest, body payload and identity checks.

The exact 512-owner measurement for that internal one-pass rewrite did not
improve the gate:

| Metric | One-pass Rust kernel | Group Rust preseal |
| --- | ---: | ---: |
| Wall time | 69,319.193 ms | 67,132.475 ms |
| Reconciliation error | 0.0353% | within 5% |
| Peak process-tree RSS | 2,752,249,856 bytes | 2,737,569,792 bytes |
| Final data root | 2,359,743,217 bytes | 2,347,107,057 bytes |
| Visible-set digest | `sha256:b0bca5901be3cdc71c500ff3180df59c663b5e77645c4165cd0779b8703e0934` | exact match |

The 2.187-second difference is a regression in this single observation, not a
qualifying distribution, but it is sufficient to show that allocator removal
inside the already-small kernel cannot satisfy the gate. The report is retained
at
`release/benchmarks/n8n-structural-preflight-512-2026-08-29-one-pass-rust-kernel.json`
with checksum
`sha256:6f060f0d6af8ccf58e50838a0c934436a0ed6ec66cdc34f2876f1ef2ce517adf`.
Because 512 owners remain above 45 seconds, no 1,000-owner or complete-n8n run
was admitted.

## Opaque receiving-core Rust acceptance

Native binding API v15 and semantic protocol 1.8 implement the next measured
boundary rather than another transport representation. Group continuations
still carry the exact Rust-sealed canonical rows, but the host no longer calls
`JSON.parse` for every record and reconstructs its nested body, source span,
facets and evidence graph. It creates only a bounded opaque batch envelope.
The independent receiving-core entrypoint `structuralKernelCanonicalBatch`
parses the closed row structs in Rust, rejects non-canonical bytes, checks the
target record category, universal kind, schema version, facets and closed body
schema, and emits compact accepted record fields, dependencies, IDs, digests,
typed publication scalars and the sealed descriptor in one result.

The engine retains authority for candidate/work-item identity, owner and
replacement scopes, accepted manifests, dependency closure, completeness,
receipts and publication. The producer's preseal result is never trusted as
the receiver result. Typed staging accepts only the second core-owned pass.
The same transport and acceptance route is used by cold and incremental
generations, and its port contains no JavaScript/TypeScript identifier or
record-kind special case. Future language engines provide observations and
registered schemas, then use this exact downstream route.

The native differential test proves the ordinary object kernel and canonical
receiver produce byte-identical kernel output, accepted fields, dependencies,
body payloads and schema attestations; it also proves non-canonical input is
rejected. Focused native, semantic transport, stream, staging and
materialization checks must pass before the single allowed 512-owner retry.

## Native API v15 512-owner result and consume-once stage handoff

The admitted API-v15 retry is retained at
`release/benchmarks/n8n-structural-preflight-512-2026-08-29-opaque-rust-acceptance.json`
with checksum
`sha256:ffc7dc1c2ce75e7ee7abb7850c64d97d727dbf2148e5686a26d8f5eff1c360bf`.
It used the retained corpus authority digest
`sha256:1dd28be497b20c5f1b3585dd7438e69060ef5a2fbe5660a5e7f5d728a492d2ed`
and reproduced the exact owner manifest and visible-set digests.

| Metric | API v15 opaque receiving core |
| --- | ---: |
| Wall time | 64,713.691 ms |
| Phase reconciliation error | 0.0373% |
| Stage-one structural ready | 10,937 ms |
| Stage-three structural ready | 49,490 ms |
| Stage-three plugin analysis | 27,330 ms |
| Stage-three FactDelta acceptance | 26,478 ms |
| Receiving-core Rust acceptance | 4,968 ms / 516 owners |
| Group commits | 3,774 ms / 37 groups |
| Typed staging | 5,311 ms |
| Seal | 5,795 ms |
| Publication planning / SQL | 7,553 / 7,213 ms |
| Peak process-tree RSS | 2,647,982,080 bytes |
| Final data root | 2,414,187,249 bytes |
| Visible-set digest | `sha256:b0bca5901be3cdc71c500ff3180df59c663b5e77645c4165cd0779b8703e0934` |

The wall improvement over the one-pass-kernel observation is 4,605.502 ms,
but 64.714 seconds still fails the 45-second admission gate. No 1,000-owner or
complete-n8n run was executed. The measurement also exposed that stage three
prepared every checker group before immediately reading the exact stage-three
rows that stage two had already sealed into the spool. That duplicate work was
inside `fact_delta_accept`, not inside the 4.968-second Rust receiving-core
span.

The corrected generic rule is now consume-once: stage three skips checker group
preparation only when every requested owner has an exact generation-scoped
stage-three spool entry. Any miss selects the complete checker-backed path for
the entire bounded group. A focused regression test proves that stage two
prepares the checker once, stage three drains the sealed rows without a second
preparation, and the resulting type entities and relations remain unchanged.
This handoff contract is shared by cold and incremental generations and does
not encode JavaScript/TypeScript record kinds in the core path.

The first API-v15 benchmark attempt completed indexing but the evidence harness
encountered a CAS temporary file that disappeared between directory enumeration
and `stat`. The harness now ignores only that expected `ENOENT` race while
propagating every other filesystem error; focused tests cover both cases. The
failed harness attempt is not qualification evidence.

## Stage-three consume-once result and API v16 projection boundary

The consume-once correction was measured once at the admitted 512-owner size.
The report is retained at
`release/benchmarks/n8n-structural-preflight-512-2026-08-29-stage3-consume-once.json`
with checksum
`sha256:afdc80cd6017ff0e326f20833f4ef91066b470ffc678e1fd6898654a2c039e4c`.
It reproduced the exact corpus, owner-manifest and visible-set digests, including
visible-set digest
`sha256:b0bca5901be3cdc71c500ff3180df59c663b5e77645c4165cd0779b8703e0934`.

| Metric | Consume-once measurement |
| --- | ---: |
| Wall time | 66,114.094 ms |
| Stage one | 11,022 ms |
| Stage three | 50,608 ms |
| Plugin analysis | 27,251 ms |
| Outer FactDelta acceptance | 26,442 ms |
| Receiving-core Rust | 4,955 ms |
| Group commits | 3,752 ms / 37 groups |
| Seal | 6,004 ms |
| Typed staging | 5,819 ms |
| Publication plan / SQL | 7,909 / 7,756 ms |
| Peak process-tree RSS | 2,877,521,920 bytes |
| Final data root | 2,414,256,881 bytes |

This run did not exercise the spool-only branch on the cold route: the initial
publication groups stages two and three and invokes the semantic owner oracle
once at the accumulated stage-three coordinate. The `fact_delta_accept` outer
span also starts before awaiting lazy stream creation. It therefore contains
producer-side checker-observation projection and preseal in addition to the
independently measured 4.955-second receiving core and 3.752-second grouped
SQLite commits. The earlier attribution of that entire span to SQLite was
incorrect. Because wall time remains above 45 seconds, no 1,000-owner or full
n8n run was admitted.

Native API v16 implements the next boundary. The addon exposes a closed
`structuralObservationBatch` dispatcher. The first language-owned Rust crate
registers `urdira:jsts-semantic-observations:v1`, converts compact checker
entities, relations, diagnostics and artifact bindings directly into ordinary
FactDelta records and dependencies, and runs the language-neutral producer seal
in that same call. It returns canonical rows, compact identity headers and
diagnostic codes rather than nested logical objects. Producer TypeScript no
longer constructs bodies, facets, spans, evidence, bounded proposal identities
or dependency rows, and does not invoke a second producer kernel. It computes
the exact stream and delta digests directly over the immutable canonical rows.
The independent receiving-core pass remains authoritative for validation, IDs,
registered digests, UCE payloads and typed staging. The private semantic
handshake is now protocol 1.9 and rejects addons below API v16. A byte-for-byte
differential test compares the native projection with the portable TypeScript
mapper, including canonical rows and aggregate digests. The same code path is
selected for cold and incremental owner groups; an oversized owner retains the
existing paged portable path.

## Native API v16 projection measurements

The first API-v16 implementation returned the complete projected logical
objects together with the kernel result. Its exact 512-owner run completed in
66,199.099 ms, demonstrating that materializing those objects across Node-API
paid much of the removed TypeScript cost again. The report is retained at
`release/benchmarks/n8n-structural-preflight-512-2026-08-29-native-observation-projection.json`
with checksum
`sha256:3236b380c19e31b223b86407e493200c39a03f73e864b131c21041e625adc034`.

The opaque response replaced those objects with canonical rows and compact
headers. That exact run completed in 62,621.831 ms and peaked at 2,657,337,344
bytes RSS. It retained visible-set digest
`sha256:b0bca5901be3cdc71c500ff3180df59c663b5e77645c4165cd0779b8703e0934`.
The report is retained at
`release/benchmarks/n8n-structural-preflight-512-2026-08-29-sealed-observation-projection.json`
with checksum
`sha256:0ef94c310bb80ddf2ea13fbff3b824f2dd2fee03c942da1510ad848664951a30`.

The final implementation also replaced the full producer-side structural
kernel with a lightweight canonical seal. Acceptance still runs the complete
kernel independently. Its admitted 512-owner result is:

| Metric | Lightweight native observation seal |
| --- | ---: |
| Wall time | 64,063.163 ms |
| Phase reconciliation error | 0.0453% |
| Stage-one structural ready | 11,108 ms |
| Stage-three structural ready | 48,549 ms |
| Stage-three plugin analysis | 24,586 ms |
| Outer FactDelta acceptance | 23,727 ms |
| Receiving-core Rust acceptance | 5,213 ms / 516 batches |
| Group commits | 4,042 ms / 37 groups |
| Seal | 5,959 ms |
| Typed staging | 5,910 ms |
| Publication planning / SQL | 8,282 / 8,042 ms |
| Peak process-tree RSS | 2,737,356,800 bytes |
| Final data root | 2,414,314,225 bytes |
| Visible-set digest | `sha256:b0bca5901be3cdc71c500ff3180df59c663b5e77645c4165cd0779b8703e0934` |

The report is retained at
`release/benchmarks/n8n-structural-preflight-512-2026-08-29-light-native-observation-seal.json`
with checksum
`sha256:6c17ccc1fc4dd361befbbe1d896c8029b41d9779b6ee4475a37f42aab59e261c`.
It uses corpus authority digest
`sha256:1dd28be497b20c5f1b3585dd7438e69060ef5a2fbe5660a5e7f5d728a492d2ed`
and reproduces the exact owner-manifest and visible-set digests.

The 1.441-second difference from the opaque result is a regression in one
observation, not a qualifying distribution. More importantly, the trace shows
that removing full producer-kernel work does not remove the dominant lazy
producer lifecycle inside the outer acceptance span. The receiver itself is
5.213 seconds and grouped commits are 4.042 seconds; approximately 14.5 seconds
remain around them in owner production, framing and per-owner orchestration.
The next high-potential boundary is therefore a core-owned physical-group
receiver that accepts the sealed owner group once and stages it directly,
returning only owner receipts and the sealed generation descriptor. It must be
language-neutral and shared by cold and incremental engines. SQLite remains
authoritative: the existing one-million-row microgate is below ten seconds, so
this result does not authorize a database-engine change or a `rusqlite`
publication fork.

Because this exact result remains above 45 seconds, the 1,000-owner preflight
and complete n8n index were not admitted. The background lexical-maintenance
worker also reported a database-lock warning after structural readiness; it did
not alter the completed structural report, but remains a recovery/concurrency
issue to address before release qualification.

The architecture conclusion, Rust-core ownership boundary, lexical-writer fix,
fast evidence ladder and fresh-session execution brief are consolidated in
[`2026-08-29-rust-core-indexing-handoff.md`](2026-08-29-rust-core-indexing-handoff.md).

## n8n cold/incremental focus (2026-08-31)

The 1,000-owner n8n slice is functionally valid on the Rust route, but it is no
longer being used as a proxy for the complete repository. The retained runs
show a real spread rather than a regression: the best run measured 36.737
seconds wall time (35.778 seconds structural readiness), while a later run
measured 44.9 seconds wall time (43.6 seconds structural readiness). The best
run used the 400 MiB Rust cache setting, had approximately 2.44 GiB peak RSS,
and produced visible-set digest
`sha256:1132ed3e7e70679df33878a15d5140ee9ce7557e246b519c9a1b1004a4b1489d`.
Its machine-readable evidence is
``n8n-structural-preflight-1000-2026-08-31-rust-cache-400m.json``
(`sha256:fab493cad1efed2f2b6ec93359bf1248ae5d24769274c4901d859c995a5bda7b`).
This confirms the earlier sub-45-second result; it is not evidence that the
complete n8n repository meets the target.

The complete 14,083-owner n8n cold run was allowed a 600-second readiness
budget after source-commit IPC was chunked below the private 16 MiB frame
limit. Source capture completed in five bounded Rust commits (4,096, 8,192,
12,288 and 14,235 artifacts, followed by the idempotent verification commit),
and all 445 semantic groups were accepted. It did not publish a ready
snapshot: SQLite record/identity promotion remained in B-tree/WAL I/O after
the Rust core reported a 36.9-second promotion subspan, the WAL reached about
4.2 GiB and the temporary staging file about 10.9 GiB, and the controller
timed out at 600 seconds. This is a failed admission result, not a usable
cold-time datapoint.

The incremental harness now generates real n8n edits (content exports,
create/delete/rename, tsconfig and manifest changes) and records every
mutation phase and digest. Its first run exposed that comment-only edits are
structurally equivalent and that the source operation id could collide when a
watcher reuses an observation batch id. The source commit id now includes the
captured generation and artifact-version digest. A complete 60-mutation n8n
result is still pending; no incremental P95 is claimed until the source
frontier and visible snapshot advance are observed for each mutation.

The actionable cold conclusion is therefore SQLite promotion, not IPC or
checker transport: further reductions in owner framing cannot bring the full
n8n repository below 45 seconds while the set-based record/identity promotion
scales into multi-minute I/O. The next optimization must reduce the rows and
indexes touched by that promotion (or prove a safe incremental affected-set
plan), while preserving the exact v3 bytes and visible digest.

### Incremental frontier correction and focused result (2026-08-31)

The incremental no-op observed by the first harness run was a coordinator bug,
not an equivalent source result. Rust deliberately emits a compact source plan
with no TypeScript transition array; `CandidateIndexer` was using the empty
array as an unconditional equivalent signal and skipped the Rust generation
even when the deferred source commit contained a new version. The coordinator
now forces a Rust candidate when the source frontier or deferred commit has a
real change, while preserving the cheap equivalent path for duplicate
observations.

The Rust direct publisher also now restricts identity-predecessor lookups to
the affected owner keys, uses the owner-key index, and does not close a record
whose ID is re-proposed in the same generation. The focused n8n evidence at
64 owners is retained in
``n8n-incremental-preflight-64-2026-08-31.json``
(`sha256:9d2c2db210507127291e86c4ee40f0b36953392e9c8b1dc867c2e4918eebffbb`).
It records 2,830 ms structural cold readiness and 925 ms for a real content
edit, including readiness polling; Rust publication for that edit was 92 ms
and lexical reconciliation closed/inserted one document. The resulting visible
set digest changed from
`sha256:6648c923d53e87be3f1782063c5a25d25246273273005885e637ea15f247d3e7` to
`sha256:8bda7b6d9787cb386fc261d055f012ad97c76fe91c819b9529957ebace1e3453`.

A 100-owner trace still exceeds the 20-second focused readiness budget for
the first mutation because that edit's dependency closure produces a much
larger structural replacement set; it is intentionally not reported as a
passing P95. The next n8n-specific optimization is therefore affected-owner
closure reduction for broad dependency fan-out, not another 1,000-owner
proxy run. No 60-mutation P95 or complete-cold n8n claim is made yet.

The implementation verification for this cutover is green for the focused
Rust and publication gates: `cargo fmt --all -- --check`, Rust core/worker/
protocol tests (33 passed), `pnpm check:architecture`, `pnpm check:native`,
`pnpm typecheck`, `pnpm check:publication`, and the storage/publication focus
(189 tests passed). The last complete `pnpm verify` reached the test suites
(1,933 passed, 8 skipped) but remains release-blocked by the repository line
coverage gate at 89.96% versus the required 90%; this is separate from the
n8n timing result.

### n8n cold/incremental follow-up (2026-08-31)

The real n8n slice now has an explicit cold and incremental comparison. At 64
owners, cold structural readiness was 2,486 ms and a content edit completed in
1,281 ms of readiness (1,285 ms including mutation and digest phases). The
machine-readable report is
``n8n-incremental-preflight-64-edit10-2026-08-31.json``
(`sha256:e75e268bd61a2c2612a09fc14bf5cc22939e9686ac5a80fd7cecfdd7d9b4382c`).

At 1,000 owners, cold structural readiness remained around 44--45 s, while a
single content edit reached the Rust publication boundary in about 11.8 s and
the harness reported 15.9 s including its stability window. The report is
``n8n-incremental-preflight-1000-edit10-2026-08-31.json``
(`sha256:969e61aed305bf554d4e3df54f5b27217d60dc63bf57c4364d7249bb283fc96e`).
This is a substantial improvement over the previous 85 s result: the syntax
and semantic checker process now analyzes one affected owner, but final v3
publication still touches enough durable rows and digest/snapshot state to
remain above the 2 s incremental target at this scale.

A create mutation is intentionally recorded separately: changing the file set
forces the syntax project to rebuild its manifest and measured 73.5 s at 1,000
owners (``n8n-incremental-preflight-1000-create-2026-08-31.json``,
`sha256:0545efc343bf44eac899829dc28bb623904f489c019ba596d81818f32d14ac27`). It is not a
representative content-edit P95 and should not be conflated with the bounded
incremental path. The n8n cold conclusion is now clear: the checker span is no
longer the dominant incremental cost; durable publication and whole-visible-set
digest/snapshot maintenance are the remaining barriers. No complete 14,083-file
n8n readiness claim is made.

### Rust-owned candidate cutover follow-up (2026-08-31)

The production Rust route no longer enters the TypeScript candidate lifecycle.
`CandidateIndexer` now exposes a control-only `runRustOwned` path: it invokes
the plugin's bounded Rust generation and the Rust publication callback without
candidate inserts/transitions, leases, materialization, template accumulation,
or a TypeScript publication writer. The existing lifecycle remains available
only to the compatibility/oracle route used by tests.

The resulting n8n replay at 1,000 owners measured 44,282 ms structural cold
readiness and 12,318 ms for one content edit at the Rust publication boundary.
The machine-readable harness, which includes its stability window, recorded
44,981 ms cold readiness, 15,311 ms incremental readiness, and 60,908 ms cold
wall time. The exact report is
``n8n-incremental-preflight-1000-edit10-rustowned-2026-08-31.json``
(`sha256:9e33677cb640d3dc3c4547fb6e6303da68e9f6a5ce9731d580810625518929b2`).
Compared with the preceding 44,5 s / 15,9 s run, this removes the remaining
TypeScript lifecycle overhead; the cold gate is within the 45 s admission
threshold but not the 30 s product target. Incremental time is still dominated
by Rust's durable record/identity promotion and visible-set digest/snapshot
maintenance, so another owner-count proxy is unlikely to be informative until
that SQLite span is reduced.

### n8n semantic lanes and streamed snapshot digest (2026-08-31)

An instrumented replay identified that the 1,000-owner cold shape was still
using the serial semantic checker lane: the automatic cutoff was 1,024 affected
owners. The cutoff is now 768, so the n8n cold run uses four bounded verified
checker processes while one- and few-owner incremental closures remain on one
lane. A second change streams projection-set digest bytes directly from SQLite
using the existing logical codec instead of materializing one JSON object per
projection row; the digest contract and visible rows are unchanged and are
covered by a Rust byte-for-byte test.

The rebuilt current n8n slice (1,000 owners, first real content edit) measured
32,115 ms structural cold readiness and 12,648 ms incremental readiness. The
harness, including its stability window, recorded 33,333.9 ms cold readiness
and 16,519.1 ms for the edit; the cold wall including one mutation was
50,125.9 ms. The exact report is
``n8n-incremental-preflight-1000-edit00-rustowned-2026-08-31.json``
(`sha256:a52f9de0abd327c0da544d2820dc02d9ddf5022610092806ce484f77039dc0a6`).

The debug breakdown is now approximately 2.5 s source capture, 19.0 s
JS/TS analysis, and 10.2 s Rust publication for cold. The remaining margin to
the 30 s product target is therefore about 2.1 s on this slice; incremental
readiness remains an order of magnitude above the 2 s target because its
durable promotion transaction takes about 12.1 s even when only one owner
changes. This is the relevant n8n conclusion: further owner framing work is
unlikely to help; the next optimization must target the Rust SQLite promotion
and its affected-owner closure plan, followed by a fresh full-corpus/P95 run.

### Incremental owner-closure index correction (2026-08-31)

The 12-second incremental publication was then reproduced with debug timings
and traced to the identity-predecessor CTE in Rust's direct publication
metadata promotion. SQLite was not choosing the owner-key index for the two
historical identity lookups, so a one-owner edit still walked the complete
identity history. The query now uses an explicit `INDEXED BY
identity_assignments_owner_key_idx` hint; no schema, row, or digest semantics
change.

The rebuilt 1,000-owner n8n run produced the same visible-set digest as its
preceding edit and reduced the application structural span to 1,474 ms (1,078
ms Rust publish). The harness, including its stability window, measured 4,498
ms for that edit, so the ≤2 s end-to-end incremental P95 is not yet qualified
even though the Rust publication subspan is below it. The cold structural
readiness was 32,678 ms (33,327 ms in the harness readiness phase), so cold
remains about 2.7--3.3 s above the ≤30 s product target but inside the ≤45 s
admission door. The exact report is
``n8n-incremental-preflight-1000-edit00-rustowned-indexhint-2026-08-31.json``
(`sha256:9eb961a3a111396d6e0ad231461d74defce384dfed4fe222f5b58150cd7ad0ad`).

This changes the optimization conclusion: incremental readiness is no longer
the blocker for a one-owner content edit; the remaining n8n work is cold
semantic analysis/publication margin and validation across the complete
mutation trace. A broad dependency-fan-out edit can still exceed 2 s and must
be measured separately.

### n8n cold cache tuning follow-up (2026-08-31)

The remaining cold publication span was split into its SQLite components. On
1,000 owners the seven rebuildable destination indexes account for roughly
3.4--4.0 s of the Rust publish interval; the streamed visible/projection
digest itself is below 0.8 s. Raising the connection-local SQLite page cache
from 112 MiB to 1 GiB reduced the measured cold structural span to 32,784 ms
(the same run's harness readiness was 34,163 ms) and kept the first content
edit at 1,358 ms application time. The harness reported 7,191 ms for that
edit because its 500 ms stability window also observed the post-publication
watcher/lexical settling; this is not a structural Rust publish regression.

The exact local replay is retained as `/tmp/n8n-1000-cache1g.json`; it is not a
release gate because it has no retained checksum artifact and the complete
n8n/P95 campaign is still pending. An eight-lane semantic experiment was
also rejected: contention increased cold readiness to about 34.3 s, so the
default remains four lanes. The next useful optimization is therefore the
checker preparation/semantic span or a measured reduction in cold index
rebuild work; more owner-count proxy runs will not answer that question.

### Rust-owned secondary-index maintenance (2026-08-31)

The cold path now rebuilds only `record_occurrences_visible_idx` and
`identity_assignments_owner_key_idx` before publishing. The remaining five
derived indexes are rebuilt by a bounded Rust maintenance worker after lexical
reconciliation, under the same per-workspace writer lease; structural source
commits take priority and the maintenance retries instead of failing a scan.
Rows and visible-set bytes are unchanged, and scans remain correct while a
derived index is absent.

The retained n8n 1,000-owner replay measured 29,092 ms application structural
readiness (29,727 ms harness readiness) and 1,397 ms for the first content
edit. The visible-set digest is
`sha256:f9092957ad4e01eafe54845a666d41bf86ad74309d8555fe64dd7af448c8aa17`.
The machine-readable report is
``n8n-incremental-preflight-1000-edit00-rustowned-asyncindex-2026-08-31.json``
(`sha256:786ca6b11efb204a06abd098fd1bba144a3b60a3c80ab2ca1ddfbe84c64c2b6e`).
The harness edit interval was 6.83 s because it waits for stable watcher
observations; the application structural span remains below 2 s. Full n8n
and P95 qualification are still pending.

### n8n semantic parallelism and writer-priority follow-up (2026-08-31)

The next n8n-only iteration increased the automatic Rust semantic checker
parallelism from four to six lanes for generations with at least 768 affected
owners. This is a bounded time optimisation: it does not duplicate staging,
candidate materialization, or SQLite publication, and its process-tree RSS is
allowed to exceed the advisory 2 GiB sample threshold when the hard time and
digest gates pass. The same run also makes lexical/secondary maintenance
pre-emptible: a newer structural generation invalidates queued maintenance and
gets the workspace writer first.

On the 1,000-owner n8n slice with the real `content-10` edit, the application
reported 28,724 ms structural cold readiness and 2,245 ms for the edit. The
harness measured 29,332 ms cold readiness (30,052 ms including its phase
bookkeeping) and 7,200 ms for the edit because it waits for stable watcher
observations. The exact report is
``n8n-incremental-preflight-1000-edit10-rustowned-sem6-2026-08-31.json``
(`sha256:ab5101f0966a114dc602a2a495dd860e0b0be5f9d0439deeab392c7166841f7d`).
The debug split was approximately 7.0 s Oxc facts extraction, 11.9 s semantic
checker work, 2.5 s source capture, and 5.0 s Rust publication. This puts a
single cold sample just inside the 30-second application target but does not
qualify P95; the incremental application span is still slightly above the
2-second target and the harness interval is not the structural P95 metric.
The complete n8n corpus, mutation-trace distribution, RSS, and lock-safety
campaign remain open.

### Rust-owned source frontier handoff (2026-08-31)

The production generation envelope no longer carries an owner-sized
`engine_input.files` or `root_names` array. After the source capture commits
are visible, `urdira-indexing-core` reads the current artifact/version frontier
from its leased SQLite connection; the JS/TS engine filters language paths and
derives verified CAS coordinates inside the Rust worker. This removes the last
structural source-manifest duplication from the application/Rust IPC boundary while
preserving the exact visible-set digests (`sha256:c6e3ba24ca38b559ab5fe3b10f3278818dcfbef8588ed8f8af343b157ae2a069` cold and `sha256:4fa621d9ca52c068e6cca9ea069e9f63af8f31a99afa18460a80c59ff97dff9` for `content-10`).

The first rebuilt replay after this handoff was functionally exact but showed
high run-to-run variance (38.4--39.9 s application cold structural readiness,
2.7--2.8 s for the one-owner edit) versus the earlier six-lane sample. That
sample is diagnostic, not a new performance gate; it confirms that removing
the IPC manifest does not change rows or digests, while the remaining time is
still concentrated in the checker and SQLite publication spans. A fresh
benchmark campaign is required before attributing the variance to the
handoff.

### Rebuilt frontier-budget control (2026-08-31)

The first run after rebuilding both the application and native bundle exposed
and fixed an envelope-budget mismatch: with the manifest intentionally omitted,
the application had been sending `max_files=1` and `max_source_bytes=1` while
Rust resolved the real frontier. The production envelope now uses the closed
protocol ceiling when its source manifest is omitted; the Rust worker still
filters the frontier to JS/TS paths and validates the resulting bytes.

The 1,000-owner control replay completed with exact structural output, but is
not a passing performance gate: cold harness readiness was 41,617 ms
(application structural span 40,967 ms) and the first content mutation took
22,765 ms at the harness boundary. The mutation's internal Rust scan was
2,557 ms; the remaining interval was watcher re-observation/stability delay.
Cold debug spans were approximately 8.3 s fact extraction, 16.1 s semantic
checker work, and 13.5 s Rust publication. This confirms the useful remaining
work is checker/publication variance and readiness scheduling, not owner-sized
TypeScript/Rust manifest transfer. The result is diagnostic and does not
qualify cold P95 or incremental P95.

### Direct Rust lifecycle cutover (2026-08-31)

The production `indexingCore` route no longer constructs or invokes
`CandidateIndexer`; source commit, engine analysis, cancellation, and the
external publication callback now execute directly against the Rust-owned
generation contract. The TypeScript planner/indexer remains only on the
compatibility/oracle route. A rebuilt 1,000-owner n8n control retained the
exact cold digest above and the mutation digest
`sha256:f9092957ad4e01eafe54845a666d41bf86ad74309d8555fe64dd7af448c8aa17`.
Harness cold readiness was 41,809 ms (application structural span 41,105 ms);
the first mutation was 19,541 ms at the harness boundary while its internal
Rust structural span was 2,545 ms. The direct cutover removes the remaining
TS lifecycle wrapper but does not yet meet the product P95 gates; watcher
stability/re-observation and checker/publication variance remain the next
measured limits.

### Full n8n cold attempt (2026-08-31)

The first full-corpus run used the direct Rust lifecycle with the requested
14,083-owner bound. The corpus exposed 14,082 JS/TS owners. Source capture
completed (14,235 source files across five commit batches), syntax analysis
completed in 876 ms, and facts extraction reached approximately 117 s for
230 groups. The run then failed inside the Rust indexing core with
`database or disk is full` while semantic groups were still being processed.
No visible snapshot or digest was published and no benchmark JSON was
emitted, so this is a failed capacity run rather than a performance gate.
The full-corpus RSS/temporary-space and lock-safety requirements therefore
remain unmeasured; a subsequent run needs a verified disk budget and explicit
temporary-database accounting.

### Syntax fact-page serialization fast path (2026-08-31)

The Rust syntax worker now probes the complete remaining fact page once and
only enters the bounded binary search when that complete page exceeds the
response budget. This removes the previous O(log(rows)) repeated JSON
serialization for the normal small-file case while preserving the exact page
bytes, cursor semantics, and closed 4,096-row/16 MiB limits. The focused
`urdira-jsts-syntax-worker` suite (19 tests) passes. It has not yet been
re-measured on full n8n because the preceding full-corpus attempt exhausted
the available SQLite/temp storage; no timing claim is made from this change.

### Compatibility route and test-storage hygiene (2026-08-31)

The TypeScript candidate coordinator is now structurally isolated to the
explicit compatibility/oracle branch. Rust-owned scans do not retain a second
external-publication callback or Rust-shaped invalidation path in that branch;
the production composition worker remains the sole staging and publication
owner.

Vitest global setup/teardown removes abandoned project-scoped `urdira-*`
temporary roots after interrupted runs, excluding user-managed model and
interactive-agent caches. This prevents scale fixtures from consuming the
volume between performance campaigns; no source, release, or build artifact is
removed by the hook.

### Full n8n Rust cutover measurement (2026-08-31, latest run)

A single capacity-safe full-corpus run was repeated after reclaiming abandoned
project temporaries and rebuilding the native/runtime artifacts. The request
covered 14,083 owners (14,082 JS/TS owners discovered). Source capture and
syntax completed; facts extraction produced 14,082 owners in 230 groups and
semantic extraction produced 952 groups. Rust then reached 3,183,253 direct
structural rows. The run did not reach the readiness boundary within the
600,000 ms harness deadline because the detached lexical phase repeatedly hit
`database is locked` while opening the shared workspace database. No benchmark
JSON was emitted and no complete full-corpus digest was recorded.

This is not evidence that the structural rows were incorrect, nor a passing
45-second gate: it identifies a remaining full-corpus coordination defect in
the post-publication writer/lock path. The bounded retry loop stopped after its
configured attempts; it did not spin indefinitely. The run's temporary root
was removed and the host volume remained healthy after cleanup. Full n8n P95,
RSS/temporary-space ratio, and concurrent lock-safety qualification remain
open.

### Rust post-publication connection handoff (2026-08-31)

The full-corpus lock was traced to the detached lexical scheduler opening a
second `IndexingCore` connection while the just-published operation still held
its SQLite connection and TEMP staging tables. The worker now transports the
immutable lexical/checkpoint envelope out of `FinalizeGeneration`, drops the
active operation, and only then opens the post-publication writer.

A focused n8n smoke run with 64 owners and one declared mutation completed
through the same Rust route: cold readiness 4,333.838 ms, incremental
readiness 937.087 ms, and lexical reconciliation reported `wal_busy=0` with
all frames checkpointed. This validates the lock handoff but is not a full
n8n performance gate; the previously observed 14,082-owner run remains the
full-corpus baseline and must be rerun only as a deliberate final validation.

The follow-up full run with the corrected connection handoff completed Rust's
publication after the harness had already reached its 600-second readiness
deadline: the worker logged `rust core publish ms=469634` and the application
logged `structural_ready_ms=950825`. Because the controller had already begun
shutdown, its temporary database was removed before the final completion
event could be observed. This confirms eventual publication, but it is not a
substitute for a retained successful JSON/digest run.

### Full n8n correctness run and bounded lexical retry (2026-08-31)

A subsequent full run was allowed to finish with a 30-minute readiness
window. It completed and retained a JSON result for 14,083 requested owners
(14,082 JS/TS owners discovered): cold elapsed `1,318,331 ms`, cold visible
set digest `sha256:cdcf24684b27b1053cde86066134b6bc2c67cd5301c456c1b8a1f15649d47cf8`,
and one content mutation elapsed `166,771 ms` with visible-set digest
`sha256:ba6172394b47834400c4d117ed2311f900d7c3d52c519f7f330d146390e8aef7`.
Structural publication completed; the run is correctness evidence, not a
timing pass. The cold readiness interval includes the harness waiting for
post-publication activity and is therefore far above the product target.

The run also exposed that the detached lexical pass's former 20-attempt loop
covered only a few seconds and could lose a normal race with the next
structural generation. The Rust worker now retries until a bounded ten-minute
deadline with capped backoff. A rebuilt 64-owner n8n smoke run completed both
cold and incremental indexing, and lexical reconciliation reported
`wal_busy=0` with all WAL frames checkpointed. Generated temporary roots and
benchmark reports were removed after verification.
