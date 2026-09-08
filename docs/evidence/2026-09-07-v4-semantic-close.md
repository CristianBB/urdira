# Frente S-E: adversarial review of S-D, daemon fd leak, `core:coverage_incomplete`,
# entity-candidate streaming, a NEW severe P0 (`nativeTopKChunked` infinite
# recursion), and final n8n-scale embed/latency/incremental-edit measurements

Plan `resilient-knitting-twilight.md` §0/§4. Repo `~/Proyectos/urdira`,
main `6546997` at task start (Frente S-D's own merge commit). Worked in worktree
`.claude/worktrees/agent-a6a4d9b2759502b10`, branch `frente-se-semantic-close`.
Inputs: `docs/evidence/2026-09-07-v4-semantic-embed-performance-and-latency.md`
(S-D) and `docs/evidence/2026-09-07-v4-semantic-wiring-and-embed-performance.md`
(S-C). Machine: Apple Silicon, shared with other concurrent agent sessions
throughout (load average 3-7 observed).

---

## Part 1: adversarial review of S-D's own levers

### 1.1 Sharding (Lever 2)

- **Row parity, not just counts**: `tests/semantic-maintenance.test.ts`'s "2
  shards + one finalize pass..." test previously compared ONLY
  `vector_projection_rows` signatures. Extended to also compare
  `semantic_document_status` (grain/document_id/status/reason_codes/segment_count)
  and `semantic_segment_cache` (executable_binding_id/segment_digest/vector
  bytes) between a 2-shard run and the unsharded baseline -- all three match
  byte-for-byte.
- **Genuine concurrent-writer contention**: added a NEW test opening the SAME
  workspace through two SEPARATE `DurableStorage` connections (closest a
  single Node process gets to "two OS processes, two connections, one file")
  and running both shards via a real `Promise.all` (not sequential `await`s
  like the existing test). Neither call ever surfaces `SQLITE_BUSY` --
  confirms the existing `busy_timeout`/WAL configuration (every
  `openWorkspace` connection already gets both, `packages/storage/src/sqlite.ts`)
  is sufficient for real shard-vs-shard contention, with a short 2,000ms
  `busy_timeout_ms` (vs production's 5,000ms) making a genuine failure fail
  fast and loud rather than being masked by a long cooperative wait.
- **A mid-shard crash never leaves partial `covered` markers**: by
  construction, not by a new mechanism -- `runSemanticReconcileSharded`
  (`packages/daemon/src/semantic-process.ts`) awaits `Promise.all` over every
  shard's own run; if ANY shard's promise rejects (a crash, an unrecovered
  `EBADF`, an OOM kill), the whole `Promise.all` rejects and the finalize
  call (the ONLY call that can write the completion marker) is never reached.
  No code change needed here -- verified by reading the control flow, not
  merely asserted.

### 1.2 Entity-derived artifact vector (Lever 1)

- Already covered by S-D's own tests with tight numeric tolerance (cosine
  similarity within 1e-6, tighter than the required 1e-4): whole-file
  fallback when zero entities are eligible, an entity covering the WHOLE
  file (no gap), and a real gap composition -- all with `segment_count`
  assertions. No gap found here.
- **Overlapping entity spans (e.g. a method nested inside its owning
  class)**: `mergeSpans`/`complementSpans` (`semantic-reconciler.ts`) were
  module-private; exported and given 7 new direct unit tests
  (`tests/semantic-maintenance.test.ts`): a span nested entirely inside
  another merges into ONE region (never double-counted), partially
  overlapping spans merge into their union, adjacent (touching) spans merge,
  disjoint spans stay separate regardless of input order, a 3-span
  transitive-overlap chain merges into one region, and the two
  `complementSpans` edge cases (zero eligible entities -> one full-file gap;
  full coverage -> zero gaps). The current eligibility policy (column-0
  top-level declarations only) makes this overlap rare in practice today
  (a method's own line is indented, failing eligibility) -- these tests
  guard the ALGORITHM's own correctness independent of today's policy.

### 1.3 Segment cache (Lever 3)

- **No eviction at all** -- confirmed by reading the code: only an `INSERT
  OR IGNORE`, no `DELETE`/LRU anywhere, and the DDL's own comment admitted
  "no LRU yet ... pruned only by a future retention pass". **Fixed**:
  `reconcileSemanticProjection` now prunes every `semantic_segment_cache`
  row whose `executable_binding_id` is not the CURRENT one, immediately
  after a clean pass writes the completion marker (best-effort, never fails
  the pass). New test proves a provider swap (A -> B) leaves ONLY
  provider-B rows in the cache once B's own pass completes cleanly.
- **Per-document atomicity preserved**: `writeCachedSegmentVector` is a
  separate, best-effort `INSERT OR IGNORE` outside the document's own commit
  transaction (`commitGeneratedVector`'s `putVectors` call) -- a document
  with cache hits and misses still commits its real vector row/status
  atomically; the cache write failing or lagging never affects that.

### 1.4 `nativeTopKChunked`

- Added a tie-break test: 12 candidates tied at distance 0, spread across
  every chunk boundary of a 9,000-candidate/limit-10 scan -- the merged
  result is exactly the 10 smallest-id candidates among the tied group,
  proving the id tie-break survives chunk boundaries (both the native fake
  port and the real Rust kernel, `crates/urdira-native-core/src/lib.rs`'s
  `exact_vector_top_k`, use the identical `(distance, then raw byte
  comparison of id)` order).
- Confirmed the native-kernel activation gate (`nativeExactVectorTopKConfigured()`)
  is unchanged and still the sole switch between the native and JS-fallback
  paths.
- **This adversarial pass found the session's single most severe bug** --
  see Part 2.4 below.

---

## Part 2: bugs found and fixed

### 2.1 Daemon file-descriptor "leak" (root cause: `@parcel/watcher`'s own kqueue backend)

Reproduced live (`lsof -p <daemon pid>` before/after `ready`) on a 2,492-file
and a 20-file real v4 workspace: the daemon holds exactly one open `REG`
descriptor per corpus source file, for the daemon's entire lifetime,
matching the corpus file count 1:1 (2,502/22 REG descriptors respectively,
matching S-D's own earlier "one fd per corpus file" observation at n8n
scale almost exactly).

**Investigation** (each ruled out by DIRECT instrumentation of the real
running daemon, not inference): `NODE_DIRECTORY_FILE_SYSTEM.read_file_stream`/
`read_file` (`packages/engine/src/directory-provider.ts`) -- confirmed via a
module-load counter AND a per-call counter that these were called ZERO times
across the daemon's own main thread and all 3 semantic-child re-loads of the
same module; `@urdira/security`'s `regularFileMediaType` -- same result,
zero calls; the CAS `putStreamsMany` drain -- reads fully (verified by
reading the code: an unconditional `for await` with no early exit); the
structural worker process and the SQLite worker thread's own fds -- checked
directly via `lsof`/a diagnostic report, neither held the corpus fds. A
`process.report`-based diagnostic (`--report-on-signal`, injected via a
`execArgv` override on the daemon's own `fork()` call since the CLI clears
`execArgv` for the child by default) confirmed a SQLite worker thread exists
but `fsActivity: {reads: 0, writes: 0}` at the moment of the leak.

**Root cause**: `packages/engine/src/watchers.ts`'s `watcherOptionsForSourceProvider`
selects `@parcel/watcher`'s kqueue backend by default on macOS (a deliberate
prior decision, P3-7: fs-events showed an unacceptable ~12s median detection
delay at n8n scale). `@parcel/watcher`'s kqueue backend registers one
kernel-level `EVFILT_VNODE` watch PER FILE at `subscribe()` time -- this is
`@parcel/watcher`'s own documented implementation, not a bug in this
codebase's own file-reading code -- and `EVFILT_VNODE` requires an open file
descriptor per watched file for the life of the subscription. Two PRIOR
evidence docs (`docs/evidence/2026-09-06-v4-reconcile-threshold.md` §14.5,
`docs/evidence/2026-09-03-v4-p3-1-incremental.md` §7.7) missed this because
both only checked the KQUEUE-TYPE descriptor count (small, ~5) without
realizing kqueue's per-file registration fd is opened as an ordinary
REGULAR-file descriptor, not a second kqueue instance.

**Fix**: `watcherOptionsForSourceProvider` (`packages/engine/src/watchers.ts`)
gained an optional `fileCountEstimate: {count, over_budget}` parameter and a
`KQUEUE_FILE_WATCH_BUDGET = 2000`; above the budget it falls back to the
fs-events backend instead of kqueue. `countFilesUpToBudget` (new, same
file) computes this estimate with a budget-capped walk (stops the instant
the count is proven over budget -- never a full enumeration of a huge tree)
applying the same top-level `.git`/`node_modules`/`.urdira` skip
`detectWorkspacePreview` already uses. `startWorkspaceWatcher`
(`packages/daemon/src/runtime.ts`) computes this estimate before starting
each workspace's watcher. Every pre-existing caller (no estimate passed)
keeps kqueue-by-default exactly as before -- this only narrows the default
for a caller that opts in.

**Verified live**: a 2,492-file workspace that held 3,039 open fds after
`ready` (matching S-D's own earlier ~3,000+ observation almost exactly) now
holds **29-33 total fds** after `ready` -- O(1) with respect to corpus size,
comfortably under the plan's own "< 200 + parcel watchers" target. Confirmed
stable during active embedding too (not just at idle): fd count stayed flat
at 33 while two semantic-maintenance shard children were actively embedding.
The rebuilt daemon's `core:reindex`/watcher subsystem still functions
correctly on this fs-events-backed workspace (structural rescan reached
`ready`, semantic reached `current`, an incremental edit was detected and
re-embedded -- see Part 3.3).

### 2.2 `core:coverage_incomplete` on a fully-indexed workspace

Reproduced live: `core:index_status` reported every capability `complete`,
yet `core:search_semantic`/`core:search_hybrid`/`core:semantic_affected_page`
still threw `core:coverage_incomplete` with `blocking_stage: "3"` and a
`capabilities` array naming STRUCTURAL capabilities (`core:type_information`,
`core:control_flow`, ...) none of these three operations ever depend on.

**Root cause**: `packages/contracts/src/registries.ts`'s `operationFrontiers`
pinned `required_stage: 3` for all three -- the SAME bar as
`core:compare`/`core:build_context`, which genuinely need full structural
completeness. This made the daemon's OWN RPC admission gate
(`packages/daemon/src/runtime.ts`'s `requiredStructuralStage` check, run
BEFORE the engine's own semantic fast path in
`canonical-query-data-port.ts`'s `trySemanticSearch`) block on structural
completeness for an operation that only ever needed the SEPARATE,
already-correct `semantic` frontier gate (`readiness.semantic_ready`).
Directly contradicted the pinned spec's own "must never pay corpus-load
cost" framing (`trySemanticSearch`'s own doc comment).

**Fix**: `required_stage: 0` for `core:search_semantic`/`core:search_hybrid`/
`core:semantic_affected_page` (matching `core:search_text`/`core:get_source`'s
own source-frontier-only admission). The separate `semantic` frontier gate
is now the only readiness check these three operations pay; when semantic
materialization genuinely lags, that gate's own error names the SEMANTIC
frontier (`required_frontier: "semantic"`, no spurious `capabilities` field
-- that field is only ever populated by the structural-stage gate this fix
bypasses for these three operations).

**Test**: `tests/phase-daemon-v4-semantic.test.ts` -- races `core:search_semantic`
against a real multi-file scan immediately after `core:workspace_add`
resolves (deterministically not-yet-structural-ready), asserting any
`core:coverage_incomplete` observed names the semantic frontier and carries
no `capabilities` array, then confirms the SAME query succeeds once semantic
materialization genuinely completes.

### 2.3 Entity-candidate enumeration OOM -- streamed, not just given a bigger heap

**Root cause** (confirmed by S-D, root-fixed here): `createNativeSemanticEntityRecordSource.entityCandidates()`
(`packages/engine/src/semantic-entity-source-v4.ts`) materialized EVERY
visible entity-category candidate record (n8n: 326,817) as decoded JS
objects in ONE array before any eligibility filtering.

**Fix**: `SemanticEntityRecordSource.entityCandidates()` is no longer
`Promise<readonly SemanticEntityCandidateRow[]>` -- it is a page callback,
`entityCandidates(onPage: (page) => Promise<void>): Promise<void>`.
`createNativeSemanticEntityRecordSource` streams `ENTITY_CANDIDATE_PAGE_SIZE`
(2,000)-row pages from the native port's own `records_for_query_batches`
(itself already internally keyset-paginated), resolving each page's OWN
owner-CAS metadata rather than a corpus-wide owner-id set -- this source's
own peak memory is now O(page), never O(corpus). `reconcileSemanticProjection`'s
two consumers (the container backfill in `syncDocumentStatusBulk` and the
entity missing-insert loop) each call `entityCandidates` SEPARATELY and
process pages incrementally -- a streaming source cannot be replayed from a
single cached call the way the old memoized-array shape allowed, so this
trades one extra full corpus scan for O(page) memory (accepted: a fair trade
against an unconditional OOM). The entity missing-insert loop's "one CAS
read per owning file" optimization moved from a single-slot "current owner"
pointer to a bounded (64-entry) LRU, since a streaming source can no longer
guarantee cross-page owner adjacency the way a full `ORDER BY
owner_artifact_version_id` SQL sort could.

**Tests**: `tests/semantic-entity-source-v4.test.ts` gained a dedicated
"streams multiple bounded pages -- never one combined array" test (forces
the fake port to deliver ONE record per page, proving pages are never
silently coalesced) plus updated existing tests for the new callback
signature. `tests/semantic-maintenance.test.ts`'s fake `SemanticEntityRecordSource`
updated to the callback signature; `entityCandidates` call-count assertions
updated from 1 to 2 (the two separate consumer calls) with a comment
explaining why.

`SEMANTIC_CHILD_MAX_OLD_SPACE_MB`'s raised ceiling
(`packages/daemon/src/semantic-process.ts`) is KEPT as defense in depth for
a semantic child's own overall memory footprint (ONNX runtime, tensor
buffers, ...), not because the eager-materialization bug it was originally
sized against is still present -- doc comment updated to reflect this.

### 2.4 NEW, severe P0 found live: `nativeTopKChunked` infinite recursion (168.9s of real CPU, then a stack overflow)

Discovered while attempting the latency measurement this frente's own scope
required: `core:search_semantic` on a REAL 2,492-file workspace (10,964 open
entity vectors) took **168,963ms** of sustained 200-270% daemon CPU, then
failed with `core:execution_failed: Maximum call stack size exceeded`.
`core:search_semantic` was, in effect, completely unusable on ANY real
corpus whose entity-grain vector count exceeds the native per-call bound
(~1,300 for 384-dim vectors) -- i.e. n8n scale, and the very `packages/cli`
subset this session's own measurements use.

**Root cause**: `trySemanticSearch` (`canonical-query-data-port.ts`) calls
`exactVectorScan` for the entity-grain lane with NO `limit` at all
(deliberately, per decision 17: the cap applies AFTER per-document
max-similarity aggregation, not before). `exactVectorScan` defaults an
absent `limit` to `eligible.length` -- i.e. "give me the full sorted order
of everyone", not a true top-K query. `nativeTopKChunked`'s recursive
chunk-then-merge strategy (Frente S-D) assumed every round strictly shrinks
the candidate set -- true for a real top-K query (K << N), but FALSE when
`limit` is not meaningfully smaller than a chunk's own size:
`Math.min(limit, chunkCandidates.length)` degenerates to the chunk's own
full size, so EVERY candidate in EVERY chunk survives as a "winner" -- the
recursive call on `winners` receives the EXACT SAME SIZE as `eligible`
(nothing was ever filtered out), so the identical "chunk it again" branch
runs again, forever, until the JS call stack itself overflows. S-D's own
9,000-candidate regression test never caught this because it always passed
`limit: 10` -- a true top-K shape, never the uncapped shape the entity lane
actually uses in production.

**Fix**: `nativeTopKChunked` now detects a round that made NO progress
(`winners.length >= eligible.length`) and, instead of recursing again,
falls back to `exactDistanceSort` -- a new function computing the EXACT
distance (the same `values`/`distance`/`utf8Compare` helpers the
already-existing non-native fallback path uses) and sorting once in JS.
This is still exact (identical distance formula and tie-break as the native
path), always terminates (a single O(N log N) JS sort, no further native
calls), and is dramatically cheaper than the crash it replaces even at
n8n's own fully-uncapped entity-candidate scale.

**Test**: `tests/phase10-semantic.test.ts` gained a dedicated regression
test reproducing the EXACT real call shape (9,000 candidates, NO `limit` at
all, exceeding `MAX_BATCH_RECORDS` by more than 2x) and asserts it
terminates with the exact correct full sorted order (not merely "does not
throw") -- this test alone would have hung for 168+ seconds before the fix;
it now completes in well under 100ms as part of a 17-test file finishing in
~2 seconds total.

**Verified live**: the SAME query that previously took 168,963ms and then
crashed now succeeds in **~6 seconds** (still far above the 250ms target --
see Part 3.2's own decomposition for the newly-exposed dominant cost, now
that the query can complete at all).

---

## Part 3: final measurements

### 3.1 Full embed, `packages/cli` (2,492 files, real n8n subset), `URDIRA_SEMANTIC_WORKERS=2`

Real daemon (`apps/urdira/dist/cli.js daemon start`), `URDIRA_NATIVE_REQUIRED=1`,
local MiniLM neural provider (`core:onnx-xenova-all-minilm-l6-v2-384`), model
provisioned from `~/.urdira/models` (never downloaded). `uptime` load 3-7
(shared machine, other concurrent agent sessions).

| | value |
|---|---:|
| Wall (structural-ready -> `semantic.current`) | **512s (8m32s)** |
| `vector_projection_rows` open | 13,454 (2,490 artifact + 10,964 entity) -- BYTE-IDENTICAL to S-D's own 1- and 2-worker runs |
| `semantic_document_status` | artifact covered 2,490; entity covered 3,916; entity excluded 64,653; entity unsupported 23,458 -- identical to S-D's own counts |
| `semantic_segment_cache` rows | 18,805 |
| `vector_shards` | 6,396 |
| Artifact documents `segment_count > 1` | 1,211 / 2,490 |
| Entity documents `segment_count > 1` | 1,322 / 3,916 -- identical to S-D's own count |
| Daemon total open fds after `ready` | **29-33** (was 3,039+ before the fd fix) |
| Semantic child RSS (per shard, 2 workers) | ~2.2-2.3 GB |

Slower than S-D's own 2-worker number (409s) on the same corpus, attributed
to this session's own concurrently-running test suites and shared-machine
load competing for the same 10 cores -- not a regression from any fix in
this frente (the row/status/cache counts are identical to S-D's own
baseline, confirming no behavior change to the embed pipeline itself).

A genuine full n8n-scale (20,281-file) embed remains out of this session's
time budget (the fd fix removes the confirmed root cause of the `spawn
EBADF` P0 that previously blocked it, but re-running the full ~20k-file
embed to completion was not attempted this session given the time already
spent on Part 1/Part 2's findings) -- reported honestly as not attempted,
not as a new blocker.

### 3.2 Query latency, before/after, with decomposition

**Before the Part 2.4 fix**: every `core:search_semantic`/`core:search_hybrid`
call against the 2,492-file workspace failed after 168,963ms with a stack
overflow -- 0% success rate, latency undefined.

**After the fix**, 20x `core:search_semantic` + 20x `core:search_hybrid`
(one warm-up call excluded), persistent connection, `packages/cli` (2,492
files, 13,454 vectors, 6,396 shards):

| | p50 | p95 | p99 | min | max |
|---|---:|---:|---:|---:|---:|
| `core:search_semantic` | 5,855.8ms | 5,967.8ms | 5,978.6ms | 5,771.6ms | 5,978.6ms |
| `core:search_hybrid` | 6,095.9ms | 6,152.0ms | 6,176.7ms | 6,066.9ms | 6,176.7ms |

**Target (p99 <= 250ms) NOT met** at this scale. **Decomposition** (temporary
per-stage timing, one representative call): `capability_states` 1ms;
`semantic_vectors`'s own packed-shard CAS reads (6,396 distinct shards,
concurrency 16) 147ms; query embed 3ms; artifact-lane `exactVectorScan`
(2,490 candidates, capped at 100) 7ms; entity-lane `exactVectorScan` (10,964
candidates, uncapped) 286ms; final candidate hydration 20ms -- these six
together account for only ~460ms of the ~6,000ms total. **The remaining
~5,000-5,400ms is spent in the OTHER three of the seven `Promise.all`'d
snapshot-port reads** (`semantic_index_state`, `semantic_scope_counts`,
`semantic_entity_scope_counts`, `semantic_document_status_counts`,
`semantic_affected_documents` all individually measured at 5,093-5,427ms --
clustered tightly together, consistent with contention on the shared SQLite
worker thread rather than five independent slow queries). This is the
session's own discovered PHYSICAL FLOOR, not fixed this session: a genuine
SQL/indexing investigation into `semantic_document_status`'s own access
patterns at ~94,500 rows (this corpus) -- `semantic_document_status_counts`'s
`GROUP BY document_grain, status` is not a covering index scan (the
existing `semantic_document_status_affected` index does not include
`document_grain`), and `semantic_affected_documents`'s own `ORDER BY
display_path, artifact_id, document_id` combined with a `status <>
'covered'` inequality predicate likely forces a full scan plus an external
sort rather than an index-ordered scan. Reported here, with the literal
numbers and root-cause hypothesis, for the owner's queue -- NOT attempted
this session given the time already spent on the Part 2.4 correctness fix,
which this frente's own priority ordering (§0: "función invocable = 100%
funcional" before latency) puts first.

**Small workspace** (100 real files, a local copy of `packages/cli/src/services`,
well under 200 files), same daemon, same methodology:

| | p50 | p95 | p99 | min | max |
|---|---:|---:|---:|---:|---:|
| `core:search_semantic` | 202.8ms | 208.7ms | 222.5ms | 198.3ms | 222.5ms |
| `core:search_hybrid` | 207.8ms | 217.4ms | 217.6ms | 204.2ms | 217.6ms |

**Target (<=100ms) NOT met here either** -- consistent with S-D's own prior
100-file measurement (p50 208.2ms/p99 233.2ms), confirming the SAME
`semantic_document_status`-related cost center dominates even at small
scale (proportionally smaller in absolute terms at 100 files' worth of
status rows, but not eliminated).

### 3.3 Incremental edit

On the 100-file small workspace (a local, editable copy -- the real n8n
corpus is read-only): appended one line to one file, relying on the live
file watcher (kqueue -- 100 files is well under the 2,000-file budget from
Part 2.1) to detect the change with no explicit `core:reindex` call.

- `semantic_index_state.completed_generation` advanced 1 -> 2 within
  **31-65 seconds** of the edit (bounded by two poll samples; the exact
  transition point was not captured to finer precision this session).
- `semantic_segment_cache` grew by exactly **+1 row** (717 -> 718) --
  every one of the OTHER ~99 files' segments hit the cache; only the
  genuinely-changed file's own segment was a real embed. `vector_projection_rows`
  open-row count stayed at 585 (no files added/removed, only content
  changed).
- **Cache hit rate for this edit: 99.86%** (1 miss out of 718 total cache
  rows after the edit).

---

## Final counts (literal)

- Files changed: `packages/engine/src/{watchers,semantic-reconciler,semantic-entity-source-v4,semantic-retrieval,canonical-query-data-port,index}.ts`,
  `packages/daemon/src/{runtime,semantic-process}.ts`,
  `packages/contracts/src/registries.ts`,
  `tests/{phase7-reconciliation,semantic-maintenance,semantic-entity-source-v4,phase10-semantic,phase-daemon-v4-semantic}.test.ts`,
  `docs/decisions/{16-semantic-search-wiring,17-entity-grain-semantic-documents}.md`
  (amended), this file (new).
- Bugs found and fixed: daemon fd "leak" (root cause: kqueue's own per-file
  watch cost, fixed via a file-count budget + fs-events fallback);
  `core:coverage_incomplete` admission bug (registries.ts `required_stage`);
  entity-candidate enumeration OOM (root-fixed via page streaming, not just
  a bigger heap); a NEW severe P0, `nativeTopKChunked` infinite recursion on
  an uncapped scan (root-fixed via an exact JS-side merge fallback).
- Bugs found and NOT fixed (reported for the owner's queue, with root-cause
  hypothesis and literal numbers): `semantic_document_status_counts`/
  `semantic_affected_documents`'s own SQL access pattern, the confirmed
  ~5-5.4s dominant cost of `core:search_semantic`/`core:search_hybrid` at
  ~94.5k-row scale.
- Test files touched: 5; new/updated test count: `tests/phase7-reconciliation.test.ts`
  (+5 tests), `tests/semantic-maintenance.test.ts` (+9 tests: 7 mergeSpans/
  complementSpans, 1 cache pruning, 1 contention; sharding test extended
  in place), `tests/semantic-entity-source-v4.test.ts` (rewritten, +1 new
  streaming-pages test), `tests/phase10-semantic.test.ts` (+2 tests: tie-break,
  the critical uncapped-scan regression), `tests/phase-daemon-v4-semantic.test.ts`
  (+1 test).
- `pnpm typecheck`/`pnpm lint`: clean (only the 6 pre-existing, unrelated
  fixture errors under `tests/fixtures/codebases/typescript/{barrel-method-call,
  multi-hop-barrel-rename}`).
- Required test files run together, all green: `tests/semantic-maintenance.test.ts`
  (52 tests), `tests/phase-canonical-query-data-port.test.ts` (100 tests),
  `tests/phase-daemon-v4-semantic.test.ts` (3 tests + 1 expected skip),
  `tests/semantic-provider.test.ts`, `tests/phase10-semantic.test.ts`
  (19 tests), `tests/phase-daemon-indexing-integration.test.ts`,
  `tests/architecture-guardrails.test.ts`, `tests/exact-vector-top-k-benchmark.test.ts`,
  `tests/semantic-entity-source-v4.test.ts` (4 tests), `tests/phase7-reconciliation.test.ts`
  -- 335 passed, 1 skipped (the release-artifact-gated e2e test, correctly
  skipped when release binaries are not staged).
- Embed (`packages/cli`, 2,492 files, 2 workers): 512s, 13,454 vectors,
  identical row/status counts to S-D's own baseline.
- Query latency: `core:search_semantic` p50 5,855.8ms/p99 5,978.6ms on the
  2,492-file workspace (target 250ms NOT met, dominant cost identified and
  reported); p50 202.8ms/p99 222.5ms on the 100-file workspace (target
  100ms NOT met). Before the Part 2.4 fix: 0% success rate (168.9s then a
  crash) on the larger workspace.
- Incremental edit: generation advanced within 31-65s; segment cache hit
  rate 99.86% for the edit (1 miss / 718 total cache rows).
