# Frente S-D: semantic embed performance (n8n) and query latency

Plan `resilient-knitting-twilight.md` §0/§4. Repo `/Users/Cristian/Proyectos/urdira`,
main `9b49e82` at task start (Frente S-C merged: v4 semantic wiring, entity
record source, parallel snapshot reads in `search_semantic`). Worked in
worktree `.claude/worktrees/agent-a6008f80a86d81632`, branch
`frente-sd-embed-perf`. Machine: Apple Silicon, 10 cores, 32GB RAM (see
`uptime`/`sysctl hw.memsize` samples inline below; shared with other
concurrent agents throughout this session -- load 2.6-6.6 observed).

Input: `docs/evidence/2026-09-07-v4-semantic-wiring-and-embed-performance.md`
(profile: 75 segs/s one process, 108 segs/s two processes, 4 regresses;
CoreML rejected; `intraOpNumThreads` no gain; latency: `Promise.all` +
bounded-concurrency shard reads already applied, p99 445ms on 45 files, two
remaining named cost centers: `exactVectorScan`'s per-candidate
`canonicalVectorBytes` and `hydrateSemanticCandidates`'s sequential,
order-dependent snippet budget) and
`docs/evidence/2026-09-07-v4-n8n-parity-and-semantic-segments.md` §B
(n8n histogram: 20,148 artifacts, 326,817 candidate entity records, 17,630
eligible, p99=31 segments/entity; full n8n embed did NOT complete in 3h44m
on v3 storage, pre-Lever-1 whole-file-per-artifact embed).

---

## Part 0: a NEW P0 discovered live -- v4 semantic maintenance cannot spawn
its child process at n8n scale (`spawn EBADF`), and the reconciler's own
entity-candidate enumeration OOMs a default-heap Node child

Before any lever could be measured on the REAL n8n corpus, two blocking bugs
had to be found and fixed; neither is caused by this frente's own levers
(confirmed: both reproduce with `URDIRA_SEMANTIC_WORKERS=1`, the pre-existing
single-process path) -- both are pre-existing gaps that make v4 semantic
maintenance non-functional at real, large-corpus scale, discovered here
because this is the first time anyone has actually run it end-to-end on n8n
since Frente S-C wired it up.

### 0.1 `spawn EBADF` when forking the semantic maintenance child

Reproduced live, twice, starting a real daemon (`apps/urdira/dist/cli.js
daemon start`) with `URDIRA_NATIVE_REQUIRED=1` against the n8n corpus copy
(`~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`, 20,281 files
inspected): `submitSemanticMaintenance`'s `runSemanticReconcileInProcess`
(`packages/daemon/src/semantic-process.ts`) forks
`semantic-maintenance-process.js` and gets `Error: spawn EBADF` (`code:
'EBADF'`) EVERY time, both from the initial post-scan submission and from
the startup-prewarm resubmission after a daemon restart.

Root cause, refined beyond the PRE-EXISTING finding in
`docs/evidence/2026-09-06-v4-reconcile-threshold.md` §14.5 and
`docs/evidence/2026-09-03-v4-p3-1-incremental.md` §7.7 (from unrelated
frentes, which only measured a total fd count): `lsof -p <daemon pid>`
broken down by type shows **20,291 `REG` (regular file) + 4,611 `DIR`**
descriptors, against **20,281** corpus files inspected -- an exact,
file-for-file match, confirmed by filtering the `REG` list to paths under
the corpus root (`grep -c n8n-corpus-2026-09-02` = 20,281). Only **5**
`KQUEUE` descriptors are open -- `@parcel/watcher`'s own FSEvents/kqueue
backend is NOT the source of the fd count (it is exactly as fd-light as its
own design implies). Something else -- most plausibly a file handle opened
during the scan/watcher-registration path and never closed, one per corpus
file -- keeps a REAL, OPEN regular-file descriptor alive for the ENTIRE
daemon lifetime, not just during the scan. `ulimit -n` (1,048,576) and
`sysctl kern.maxfilesperproc` (122,880) are both far above this count -- not
ordinary fd exhaustion (`EMFILE`/`ENFILE`); `child_process.fork()`'s
`spawn()` syscall fails with `EBADF` specifically under this sustained
condition, confirmed non-transient: even a 6-attempt/500ms retry (this
session's first revision) was fully exhausted in one observed run.
Genuinely finding and closing the leaked/retained handle is a
scan/watcher-subsystem investigation, out of this module's scope; reported
here as a separate, real P0 for the owner's queue, with the exact fd-type
breakdown above as a head start for whoever picks it up (the fd count is a
consequence of a real handle leak, not a "one descriptor per watch"
architectural choice, since the watcher's own kqueue footprint is measured
here to be negligible).

**Fix (in scope, does not touch the scan/watcher subsystem)**:
`runSemanticReconcileInProcessWithRetry` (`packages/daemon/src/semantic-process.ts`,
new) wraps every `fork()` attempt with a bounded retry (20 attempts, 1000ms
backoff -- widened from an initial 6/500ms once that was observed exhausted
at n8n scale) on `error.code === "EBADF"`/`error.errno === -9`, mirroring
`scripts/v4-mutation-harness.mjs`'s own pre-existing `execFileWithEbadfRetry`
(same error-code check, same bounded-attempts shape -- not a new invention).
`runSemanticReconcileSharded` (Lever 2, below) routes every one of its
per-shard spawns and its finalize-pass spawn through this same retry
wrapper. This is the accepted mitigation the rest of the codebase already
uses for the identical error class, not a claim the underlying fd leak is
fixed.

### 0.2 Entity-candidate enumeration OOMs a default-heap semantic child

Once past 0.1, the semantic child ran and reached
`node::OOMErrorHandler`/`FATAL ERROR: ... JavaScript heap out of memory`
(observed on 3 separate attempts, both with 2 concurrent shard children and
with `semantic_process: false`'s in-process path -- the LATTER crashed the
WHOLE DAEMON, not just a child, since "in-process" means the reconciler
literally runs on the daemon's own event loop/heap).

Root cause: `createNativeSemanticEntityRecordSource`'s `entityCandidates()`
(`packages/engine/src/semantic-entity-source-v4.ts`) materializes EVERY
visible entity-category candidate record (n8n: 326,817, per the input
evidence doc's own histogram) as decoded JS objects in ONE array, BEFORE any
eligibility filtering -- comfortably exceeding Node's default ~4.1GB
old-space ceiling on this machine.

**Fix (in scope, does not touch the entity-source's own memory profile)**:
`SEMANTIC_CHILD_MAX_OLD_SPACE_MB` (`packages/daemon/src/semantic-process.ts`,
default 6144, overridable via `URDIRA_SEMANTIC_CHILD_MAX_OLD_SPACE_MB`) is
passed as `--max-old-space-size` in the child's own `execArgv`. This session
used 10240 (10GB) for the actual n8n measurement below, given 32GB physical
RAM and a single (non-sharded) child. Genuinely fixing
`entityCandidates()`'s O(corpus) eager materialization (streaming/batching
the scan instead of one giant array) is a `semantic-entity-source-v4.ts`
concern, reported here as a second real finding for the owner's queue, out
of this module's scope.

### 0.3 `exactVectorScan` rejects any real query once the native candidate set exceeds a generic 4MiB/4,096-record native batch bound

Discovered live on the FIRST real `core:search_semantic` query issued
against a real, non-trivial workspace (2,492 files, 13,454 open vectors: see
Part 1 below): every query failed with `core:execution_failed:
exactVectorTopKBatch rejected the batch: Exact vector batch exceeds the
4194304-byte bound.` -- `core:search_semantic`/`core:search_hybrid` were
**completely unusable** on any workspace past a few thousand open vectors
whenever the native exact-vector kernel is configured (the production
default whenever `URDIRA_NATIVE_REQUIRED=1`).

Root cause: `crates/urdira-native-core/src/lib.rs` enforces two generic
batch limits shared by several unrelated native operations --
`MAX_BATCH_RECORDS` (4,096 candidates) and `MAX_BATCH_FRAMED_BYTES` (4MiB,
computed as `(query_scalar_count + sum(candidate_scalar_counts)) * 8 +
sum(identifier_byte_lengths)` -- SCALAR counts, not wire bytes, since the
native side decodes every candidate to `f64` internally regardless of the
wire `element_type`). For 384-dim MiniLM vectors this caps out around
**~1,300 candidates per native call** -- `exactVectorScan`
(`packages/engine/src/semantic-retrieval.ts`) previously packed EVERY
eligible candidate (entity-grain is deliberately UNCAPPED before ranking,
per decision 17's own max-similarity aggregation) into ONE native call,
which the native side rejected outright rather than ever returning a
result. n8n-scale entity-grain candidate counts (56,976 target segment
rows) would ALWAYS exceed this -- this bug alone would have made
`core:search_semantic` permanently broken on n8n even after every embed
lever in this document shipped.

**Fix**: `nativeTopKChunked` (`packages/engine/src/semantic-retrieval.ts`,
new) chunks the eligible candidate list into native-sized batches (mirroring
the native byte/record formula above, with headroom), computes each
chunk's own top-`limit` via the EXISTING native call, then recursively
merges and re-ranks the (much smaller) union of chunk winners until the
result fits one final native call. This is **exact**, not an approximation
(decision 06: no ANN, no sampling): any candidate that could appear in the
GLOBAL top-`limit` must also appear in its OWN chunk's top-`limit` (otherwise
at least `limit` other candidates in that same chunk already outrank it, so
at least `limit` candidates outrank it globally too) -- proven by a new test
(`tests/phase10-semantic.test.ts`) that runs 9,000 synthetic candidates
(over 2x the record bound) through a fake native port which ITSELF enforces
the real byte/record bounds (throwing if violated), and asserts the merged
result exactly matches the true global top-10 regardless of chunk
boundaries.

### 0.4 A separate, NOT-fixed finding: `core:query`'s admission path reports `core:coverage_incomplete` for `core:search_semantic` on the 2,492-file workspace

After fixing 0.1-0.3, live queries against the `packages/cli` (2,492-file)
workspace via a persistent `DaemonClient` still failed with
`core:coverage_incomplete` (`blocking_stage: "3"`, listing nearly every
structural capability), taking 2+ minutes of real CPU time before returning
that error -- even though `core:index_status` reported EVERY capability
`"complete"` and `blocked_operations: []` for the SAME workspace at the SAME
moment. This contradicts the pinned spec's own framing (`docs/decisions/16`,
`canonical-query-data-port.ts`'s own doc comment) that
`search_semantic`/`search_hybrid` "must never pay corpus-load cost" and
should never reach a coverage/admission gate at all. Root cause NOT found
this session (a real, separate query-admission-planning issue, orthogonal to
every lever/fix in this document) -- reported here for the owner's queue.
Confirmed NOT scale-inherent: the identical query shape against a SEPARATE,
smaller (100-file) workspace on the SAME daemon succeeded immediately (Part
3's own small-workspace latency numbers), so this is a real, reproducible
gap specific to larger real corpora, not a hard architectural ceiling.

### 0.5 Consequence for this session's measurement plan

Given 0.1 recurring even with retry under SUSTAINED (not transient) fd
pressure at FULL n8n scale (20,281 files) -- confirmed twice more even after
widening the retry budget to 20 attempts/1000ms, including one occurrence
where the daemon's OWN structural rescan spawn (a completely different code
path, `createIndexingCoreProcessTransport`) also hit `EBADF` -- a full
20,281-file n8n embed could not be completed within this session's time
budget. This session's embed-throughput measurements (Part 1) instead use a
**real, substantial n8n SUBSET**: `packages/cli` (2,492 files, 92,027
candidate entity records, 13,454 real open vectors once embedded) --
large enough to be meaningful (13x the 187-file mini-workspace S-C's own
evidence used), small enough to complete reliably given 0.1's fd ceiling.
Lever 2's throughput multiplier (§1.2) IS measured end-to-end on this same
subset (2 concurrent shard children ran successfully without hitting 0.1).
A genuine full-n8n-scale run remains blocked on the file-watcher fd leak
(0.1) being fixed at the architecture level, which is out of this frente's
scope; the packages/cli measurements below are the best real evidence
available this session, reported honestly as a subset, not extrapolated to
claim a full-n8n number.

Before E-P0j (a concurrent frente fixing v4 entity records to publish the
FULL declaration span instead of only the identifier's own span) merged into
`main`, this session's own worktree was reset onto its merge commit
(`12ce43c`) and every native artifact rebuilt, per this task's own
instruction to measure with real entity spans -- every number below is
POST-merge (real spans, decision 17 eligibility able to actually fire on
real declarations, not just artificially long identifier names).

---

## Part 1: embed throughput per lever (real corpus: `packages/cli`, 2,492 files)

Corpus: `packages/cli` from `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`
(read-only), added directly as a v4 workspace (`URDIRA_V4=1`,
`URDIRA_NATIVE_REQUIRED=1`, local MiniLM provider, model provisioned from
`~/.urdira/models` -- never downloaded). `uptime` at each cold-scan start:
2.2-4.5 (quiet to moderate; one earlier full-n8n attempt saw 17 from other
concurrent agents on this shared machine, reported inline where relevant).
Model: `core:onnx-xenova-all-minilm-l6-v2-384`. Structural cold scan: ~30s
(unchanged by this frente). All numbers below are wall time from
structural-ready to `semantic.current: true`, all THREE levers (1, 2 where
noted, 3) active simultaneously -- this session did not have time budget for
a fully isolated "Lever 1 off" re-run (would require reverting the
step-3/step-5 reorder and re-running an equally long cold embed); the
counterfactual is instead demonstrated by the dedicated unit tests
(`tests/semantic-maintenance.test.ts`) proving Lever 1 fires and changes the
computed vector, plus the internal composition telemetry below.

### 1.1 Cold embed wall time and rows (Levers 1+3 active, `URDIRA_SEMANTIC_WORKERS=1`)

| | value |
|---|---:|
| Wall (structural-ready -> semantic.current) | **544s (9m04s)** |
| `vector_projection_rows` open | 13,454 (2,490 artifact-grain + 10,964 entity-grain) |
| `semantic_document_status` covered | artifact 2,490; entity 3,916 |
| `semantic_document_status` excluded / unsupported (entity) | 64,653 / 23,458 (candidate pool 92,027) |
| `semantic_segment_cache` rows (distinct embedded segments, cold) | 15,811 |
| `vector_shards` | 6,402 |
| Artifact documents with `segment_count > 1` (Lever 1 fired: composed from >1 entity/gap component) | 535 / 2,490 (21.5%) |
| Entity documents with `segment_count > 1` (multi-segment entity, R7/R8) | 1,322 / 3,916 (33.8%) |

Throughput: 2,492 files / 544s = **4.58 files/s**; (2,490 + 3,916) covered
documents / 544s = **11.8 documents/s**.

### 1.2 Lever 2 (parallel reconciler sharding): same corpus, `URDIRA_SEMANTIC_WORKERS=2`

Identical workspace setup, fresh cold scan+embed, `uptime` 2.2-4.2 (quiet,
comparable to §1.1's own conditions):

| | value |
|---|---:|
| Wall (structural-ready -> semantic.current) | **409s (6m49s)** |
| `vector_projection_rows` open | 13,454 (2,490 artifact-grain + 10,964 entity-grain) -- IDENTICAL document counts and coverage to the 1-worker run |
| `semantic_segment_cache` rows | 20,136 |

**Speedup: 544s / 409s = 1.33x** at 2 concurrent shard processes on this
10-core machine -- in the same order of magnitude as the S-C evidence's own
raw embed-only microbenchmark (1.44x at 2 processes on an 82-file synthetic
corpus), somewhat lower here because this is a full END-TO-END measurement
(structural readiness wait, entity-candidate re-enumeration cost paid
INDEPENDENTLY by each shard -- a real, documented overhead of Lever 2's
per-process design, see §0.2/§0.5 -- plus the unsharded finalize pass), not
an embed-only microbenchmark. Two concurrent `semantic-maintenance-process.js`
children were confirmed running simultaneously via `ps` during this run (no
`EBADF` this time -- 0.1's fd pressure did not trip at this corpus size).
Correctness: `vector_projection_rows` document-level coverage counts are
BYTE-IDENTICAL between the 1-worker and 2-worker runs (2,490/3,916 both
times), matching the sharding unit tests' own proof (`tests/semantic-maintenance.test.ts`,
"2 shards + one finalize pass produce the same rows as a single unsharded
pass").

**Open, honestly-reported discrepancy**: the INTERNAL composition detail
(how many artifact documents got `segment_count > 1`, i.e. how completely
Lever 1's entity-reuse fired) differs between the two runs -- 535/2,490
(21.5%) in the 1-worker run vs. a larger share in the 2-worker run, even
though final DOCUMENT COUNTS/COVERAGE are identical. This does not affect
correctness (every committed vector is a valid, exact mean per
`combineVectorsMeanNormalized`'s own guarantees, and both runs converge to
the same covered-document set) -- it reflects some run-to-run variance in
exactly HOW MUCH intra-pass entity-coverage each specific artifact's own
composition captured (a function of batch-commit timing relative to when
that artifact's own step-3 processing runs), not a defect in the sharding
partition itself. Root cause not fully isolated this session; reported
here rather than silently reconciled.

### 1.3 Lever 3 (segment cache): hit-rate on an edit

Live, end-to-end hit-rate measurement (not just the unit tests) was not
repeated against this real corpus given the time already spent on §1.1/§1.2
and the P0s in Part 0 -- the authoritative, passing evidence for Lever 3 is
the dedicated test suite (`tests/semantic-maintenance.test.ts`):
- "does not re-embed a segment whose exact (text, binding) pair is already
  cached, even across two different entities/files": 2 documents (2
  entities + their 2 composed artifacts, 4 total), only **1 real provider
  call** for all 4 (the second entity's byte-identical rendered text is a
  cache hit; both artifacts are Lever-1-composed from already-embedded
  components, never calling the provider directly at all).
- "a second reconcile pass over an UNCHANGED corpus makes zero additional
  provider calls... and a brand-new document with previously-seen content
  is a cache hit": a SECOND generation introducing a brand-new artifact
  whose entity renders byte-identical text to an EXISTING one costs
  **zero** new provider calls -- 100% hit rate for that edit.

The real corpus's own COLD-run cache table (15,811 distinct segments for
13,454+ committed vectors' worth of underlying segment work, entity segments
alone totaling more than the row count since a single entity can be
1-64 segments) is populated fresh in this session's own measurement above
(§1.1) and available for a follow-up incremental-edit measurement against
the SAME data root.

---

## Part 2: `exactVectorScan` chunking correctness (Lever-independent latency fix)

`tests/phase10-semantic.test.ts` (new test): 9,000 synthetic candidates (>2x
`MAX_BATCH_RECORDS`) through a fake native port that ITSELF enforces the
real native byte (4MiB) and record (4,096) bounds, throwing if either is
exceeded. Result: **>1 native batch call observed** (chunking confirmed
active), **max candidates per call stayed under the 4,096-record bound**,
and the merged top-10 result exactly matched the true global top-10 (ranks
1-10, `cand-00000`..`cand-00009`) -- proving the chunk-and-merge strategy is
EXACT, not an approximation, matching decision 06's own "no ANN, no
sampling" requirement.

---

## Part 3: query latency, before/after

### 3.1 Small workspace (100 real files: `packages/cli/src/services`, well under 200)

20x `core:search_semantic` + 20x `core:search_hybrid` over a persistent
`DaemonClient` connection (one warm-up call excluded, matching the input
evidence doc's own methodology), fully warm/complete semantic index,
`uptime` 2.9 (quiet):

| | p50 | p95 | p99 | min | max |
|---|---:|---:|---:|---:|---:|
| `core:search_semantic` | 208.2ms | 233.2ms | 233.2ms | 202.1ms | 233.2ms |
| `core:search_hybrid` | 213.8ms | 221.5ms | 221.5ms | 207.2ms | 221.5ms |

**Target (<=100ms on a <200-file workspace) NOT met** on this REAL corpus
slice -- notably slower than the input evidence doc's own tiny-fixture
reference (42.7ms p50 on a synthetic 2-3-file workspace). This 100-file
slice has real, substantial vector/entity data (unlike the 2-3-file
reference), so it is a more representative small-workspace number, but a
direct root-cause bisection of the remaining ~200ms (analogous to the input
evidence doc's own `snapshot-batch`/`rank-scan`/`hydrate` breakdown) was not
repeated this session given the time already spent on Part 0's P0s -- 0.3's
fix (chunked native top-k) and the earlier `fastCandidateBytes`/parallel-hydration
fixes are ALL exercised on this measurement (this workspace's own candidate
count is small enough that 0.3's chunking never triggers -- a single native
call handles it -- so this number reflects the OTHER latency work, not 0.3
specifically).

### 3.2 Larger real workspace (2,492 files, n8n-scale `packages/cli`)

**Not obtained this session** -- blocked by the `core:coverage_incomplete`
finding (§0.4), itself discovered only after 0.1-0.3 were fixed and query
attempts became possible at all on this workspace. Before 0.3's fix, every
query on this workspace failed outright (`exactVectorTopKBatch rejected the
batch`) -- 0.3 is confirmed necessary (queries against 13,454 open vectors
literally could not execute at all beforehand) but the FULL before/after
latency comparison the plan asked for on n8n-hot-scale data is incomplete,
honestly reported as blocked by §0.4 rather than fabricated or
extrapolated.

---

## Final counts (literal)

- Files changed (this frente, on top of `9b49e82` + E-P0j's `12ce43c`):
  `packages/engine/src/{semantic-reconciler,semantic-provider,semantic-runtime,semantic-retrieval,canonical-query-data-port,index}.ts`,
  `packages/daemon/src/{semantic-process,semantic-maintenance-process,runtime,index}.ts`,
  `apps/urdira/src/index.ts`, `packages/storage/sql/{workspace-v3,workspace-v4-semantic}.sql`
  (+ their generated `.ts` counterparts), `tests/{semantic-maintenance,phase-canonical-query-data-port,phase-daemon-v4-semantic,phase10-semantic}.test.ts`,
  `docs/decisions/{16-semantic-search-wiring,17-entity-grain-semantic-documents}.md`
  (amended), this file (new).
- New exported surface: `shardIndexFor`, `runSemanticReconcileSharded`,
  `runSemanticReconcileInProcessWithRetry`, `resolveSemanticShardCount`,
  `vectorValues` (re-exported), `semantic_segment_cache` table.
- P0s discovered and disposed: `spawn EBADF` at large-corpus scale
  (mitigated, root cause reported), entity-candidate enumeration OOM
  (mitigated, root cause reported), `exactVectorScan` native batch bound
  (FIXED, exact chunking), `core:query` admission `core:coverage_incomplete`
  on a 2,492-file workspace (reported, NOT fixed this session).
- Embed throughput (`packages/cli`, 2,492 files, 13,454 vectors): 544s
  (1 worker) -> 409s (2 workers), **1.33x**.
- Segment cache: 100% hit rate on a same-content edit (unit tests); 15,811
  distinct segments cached on the real cold corpus run.
- Query latency (100-file real workspace): p50 208.2ms / p99 233.2ms for
  `search_semantic` -- target (<=100ms) not met; n8n-scale (2,492-file) hot
  latency not obtained this session (blocked by §0.4).
- `pnpm typecheck`/`pnpm lint`: clean (only the 6 pre-existing, unrelated
  fixture errors under `tests/fixtures/codebases/typescript/{barrel-method-call,multi-hop-barrel-rename}`).
- Required test files run together: `tests/semantic-maintenance.test.ts`
  (41 tests), `tests/phase-canonical-query-data-port.test.ts` (100 tests),
  `tests/phase-daemon-v4-semantic.test.ts` (2 tests + 1 expected skip),
  `tests/phase10-semantic.test.ts` (15 tests), `tests/embedding-local.test.ts`,
  `tests/semantic-provider.test.ts`, `tests/phase-daemon-indexing-integration.test.ts`,
  `tests/architecture-guardrails.test.ts`, `tests/app-native-runtime-binding.test.ts`,
  `tests/semantic-neural-host.test.ts` -- all green.
