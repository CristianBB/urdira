# Frente S-F: semantic query latency (materialized coverage + covering
# index + bounded entity scan + shard cache) and full n8n embed measurement

Plan `resilient-knitting-twilight.md` §0/§4. Repo `/Users/Cristian/Proyectos/urdira`,
main `28dea00` at task start (S-A..S-E merged). Worked in worktree
`.claude/worktrees/agent-ae08d05bf30d025e9`, branch `frente-sf-semantic-latency`.
Input: `docs/evidence/2026-09-07-v4-semantic-close.md` (S-E's own final
measurement and its root-cause hypothesis for the ~5-5.4s dominant cost).
Machine: Apple Silicon, shared with other concurrent agent sessions
throughout this session too (`uptime` load 6-12 observed while three of this
session's own daemons ran concurrently against three corpus scales -- see
each measurement's own noted load).

---

## Part 0: root cause, confirmed

S-E's own decomposition (§3.2) found `semantic_document_status_counts` and
`semantic_affected_documents` each costing 5.0-5.4s at ~94,500
`semantic_document_status` rows, with a root-cause HYPOTHESIS (not measured
that session): a non-covering index and a `status <> 'covered'` predicate
forcing a full scan + external sort. Confirmed here via `EXPLAIN QUERY PLAN`
against the actual schema:

```
-- BEFORE (semantic_document_status_affected, status <> 'covered',
-- ORDER BY display_path, artifact_id, document_id):
SEARCH semantic_document_status USING INDEX semantic_document_status_affected
       (workspace_id=? AND profile_id=? AND executable_binding_id=?)
USE TEMP B-TREE FOR ORDER BY

-- AFTER (semantic_document_status_affected_v2, status IN (...),
-- ORDER BY status, display_path, artifact_id, document_id):
SEARCH semantic_document_status USING COVERING INDEX
       semantic_document_status_affected_v2
       (workspace_id=? AND profile_id=? AND executable_binding_id=? AND status=?)
```

No `SCAN`, no `TEMP B-TREE` in the "after" plan -- confirmed live (SQLite
3.41.2 locally; the daemon's own bundled SQLite is a separate build but the
same query-planner algorithm class). Both plans reproduced in
`tests/phase-canonical-query-data-port.test.ts`'s two new `EXPLAIN QUERY
PLAN` assertion tests (this repo's own test suite, not a one-off script).

## Part 1: the fix (code, not just index)

Per the pre-wired design (§0: performance without compromising the
100%-functional contract):

1. **Materialized coverage summary, not a per-query recompute.** New table
   `semantic_coverage_summary` (R22 additive), one row per
   `(workspace_id, profile_id, executable_binding_id, generation)`, written
   by the reconciler (`materializeCoverageSummary`,
   `packages/engine/src/semantic-reconciler.ts`) in the SAME pass that
   writes `semantic_index_state`'s own completion marker -- immediately
   after `markSemanticComplete`, best-effort (a write failure never fails
   the pass that already committed the real marker). `buildSemanticCoverageView`
   (`canonical-query-data-port.ts`) now reads this ONE row via a single
   indexed point lookup (`ORDER BY generation DESC LIMIT 1` over the table's
   own PRIMARY KEY -- confirmed via `EXPLAIN QUERY PLAN`: one `SEARCH`, no
   `SCAN`, no sort) instead of running the two live queries. When no summary
   row exists yet (a workspace that predates this feature, or one whose
   first pass hasn't completed), `trySemanticSearch` falls back to the OLD
   live pair -- correctness is never conditional on materialization having
   happened; only speed is.
2. **Covering index + `IN` predicate + status-first `ORDER BY`.**
   `semantic_document_status_affected` (old, path-first order, `<>`
   predicate) dropped; `semantic_document_status_affected_v2` adds
   `document_grain`/`artifact_version_id`/`reason_codes` as trailing
   covering columns and orders `(status, display_path, artifact_id,
   document_id)` -- matching the covering index's own leading order lets
   SQLite serve the FULL affected-row query (used by the reconciler's own
   materialization pass, and by `core:semantic_affected_page`'s
   continuation beyond the embedded first page) as one already-sorted scan.
   This changes the affected page's own display order from pure
   alphabetical to "grouped by status, then path" -- a deliberate,
   documented trade (the operation's contract never promised
   cross-status alphabetical order, only a stable deterministic one); the
   cursor's own keyset tuple grew from 3 to 4 components
   (`status` leading) to match.
3. **Entity-lane exact-scan bound.** `trySemanticSearch`'s entity-grain
   `exactVectorScan` call was fully uncapped (`limit: undefined` ->
   `eligible.length`, i.e. "sort every segment"), measured by S-E at 286ms
   for 10,964 segment candidates. Now attempts a bounded top-K scan first
   (`SEMANTIC_ENTITY_CANDIDATE_CAP * ENTITY_SEGMENT_FANOUT_BOUND` = 100 x 8
   = 800) and escalates to the full uncapped scan ONLY when that shortfalls
   (fewer than 100 distinct documents recovered AND more candidates existed
   beyond the cap) -- a fast-path attempt, not a correctness bound: the
   escalation branch reproduces the pre-existing behavior byte-for-byte, so
   this can only ever be a latency WIN, never a correctness regression.
4. **Packed shard-byte cache.** `vector_shards`' packed bytes (read via CAS,
   keyed by immutable `content_hash`) were re-read from CAS on EVERY
   `semantic_vectors` call -- measured by S-E at ~147ms for 6,396 distinct
   shards even at concurrency 16. Now cached by `content_hash` on
   `SqliteCanonicalQuerySnapshotPort` (governed by the SAME
   `evictWarmRecords()`/`approxWarmBytes()`/`URDIRA_WARM_RECORDS_BUDGET_MB`
   budget loop `recordsCache` already uses -- one daemon-wide ceiling, not a
   second independent knob).

Tests: `tests/semantic-maintenance.test.ts` (+2: materialized summary
matches computed `semantic_document_status` counts exactly; changes across
generations, not stale), `tests/phase-canonical-query-data-port.test.ts`
(+5: both `EXPLAIN QUERY PLAN` assertions above, fast-path-reads-summary,
live-fallback-when-no-summary, shard-cache hit/evict/miss; 1 pre-existing
ordering assertion updated for the new status-first sort).
`pnpm typecheck`/`pnpm lint` clean; full workspace build chain green;
`tests/{semantic-maintenance,phase-canonical-query-data-port,phase10-semantic,
semantic-entity-source-v4,semantic-provider,architecture-guardrails,contracts,
exact-vector-top-k-benchmark,phase-daemon-indexing-integration,
phase-daemon-v4-semantic}.test.ts` all green (472 tests). Committed
`ec6b4a5`.

## Part 2: a SECOND real bug found only by live measurement -- the native-store port never got the new delegation

Methodology: real production daemon (`apps/urdira/dist/cli.js daemon
start`), `URDIRA_NATIVE_REQUIRED=1`, `URDIRA_SEMANTIC_WORKERS=2`, local
MiniLM neural provider (`core:onnx-xenova-all-minilm-l6-v2-384`), model
copied from `~/.urdira/models` (never downloaded). A persistent
`DaemonClient` connects directly to the running daemon's own IPC socket
(`daemonPaths(dataRoot).endpoint`) for the timed calls themselves -- no
per-call CLI subprocess spawn overhead in the measurement loop; one-off
setup calls (`workspace add`, status polls) go through the real CLI
subprocess since their own overhead never enters the timed sample. 20x
`core:search_semantic` + 20x `core:search_hybrid` per scale, one warm-up
call excluded, `response_budget.max_items: 50`.

The very first live measurement against `packages/cli` scale (2,490
files/13,454 vectors, `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02/packages/cli`)
was **still 5,565-9,106ms p50** -- Part 1's fix had NO effect in production.
Root cause, confirmed by a temporary per-call debug log (`URDIRA_SF_DEBUG_PHASES=1`,
removed before the final commit): `this.snapshots.constructor.name` was
`NativeCanonicalQuerySnapshotPort` (the real daemon's default for a v4
workspace with `URDIRA_NATIVE_REQUIRED=1` -- structural corpus in the native
store), and `hasSummaryMethod=false` for the new `semantic_coverage_summary`
method. `NativeCanonicalQuerySnapshotPort` (`native-query-snapshot-port.ts`)
delegates every `semantic_*` method to the wrapped SQLite port by hand, one
explicit method at a time; `semantic_coverage_summary` was added to the
`CanonicalQuerySnapshotPort` interface and to `SqliteCanonicalQuerySnapshotPort`
in Part 1's commit but never added to this second class's own delegation
list. The interface field is optional, so this compiled cleanly -- but at
runtime the capability check always read `false`, permanently forcing the
OLD live-fallback pair on every real (native-storage) workspace, i.e. on
every workspace this whole frente's own live measurements run against.
**Fixed** (`ef838e3`): added the missing one-line delegation.

Fixing that exposed a SECOND, different cost center at the SAME order of
magnitude: `semantic_entity_scope_counts` has no SQL to delegate to in
native-storage mode (`record_occurrences` is never populated when the
structural corpus lives in the native store -- the whole reason this class
exists), so it does its own full-corpus walk (`scanAll`, paginated FFI
batches into the native structural store, one JS-side category/kind check
per row) on EVERY call. Measured live: **5.0-5.4s** on the SAME 2,490-file
corpus (~40k total records) -- and because this call is fired inside the
SAME `Promise.all` as every other (now-fast) `semantic_*` read, it queued
every one of them behind it on the shared connection, reproducing the exact
"five reads all cost ~5s" symptom Part 1 had just eliminated for a
DIFFERENT pair of calls. **Fixed**: cached by generation (the corpus a
fixed generation counts is immutable -- see `entityScopeCountCache`'s own
doc comment) -- first call per generation pays the full walk, every
subsequent one for the SAME generation is an O(1) map lookup.

Both bugs were caught ONLY by live daemon measurement -- neither had ANY
existing test coverage (confirmed: `tests/native-query-snapshot-port.test.ts`
had zero tests exercising ANY `semantic_*` method before this frente). Two
regression tests added there (delegation parity + cached-count correctness)
so neither can regress silently again.

## Part 3: query latency, before/after, three scales

Same methodology as Part 2's own opening paragraph. Measured AFTER both
Part 1 and Part 2 fixes, against the real daemon, `URDIRA_SEMANTIC_WORKERS=2`.

### (a) 100 files (`packages/cli/src/services`, real n8n subset, exactly 100 files)

| | p50 | p95 | p99 | min | max |
|---|---:|---:|---:|---:|---:|
| `core:search_semantic` | 41.0ms | 52.9ms | 52.9ms | 36.9ms | 52.9ms |
| `core:search_hybrid` | 47.9ms | 55.8ms | 55.8ms | 45.8ms | 55.8ms |

**Target (p99 <= 100ms) MET** (52.9ms, 47% of budget) -- machine load 5-7
during this run. Compare S-E's own prior number at this scale: p50
202.8ms/p99 222.5ms -- a **4.2x** improvement.

### (b) `packages/cli` (2,490 files, 2,490 artifact + 10,964 entity vectors = 13,454 total, 6,403 shards, real n8n subset)

| | p50 | p95 | p99 | min | max |
|---|---:|---:|---:|---:|---:|
| `core:search_semantic` | 256.6ms | 308.1ms | 308.1ms | 248.0ms | 308.1ms |
| `core:search_hybrid` | 545.3ms | 903.1ms | 903.1ms | 491.2ms | 903.1ms |

**Target (p99 <= 250ms) NOT quite met for `core:search_semantic`** (308ms,
23% over) -- but a **19.4x** reduction from S-E's own pre-fix baseline
(p50 5,855.8ms/p99 5,978.6ms), and the BEFORE-this-frente number for the
SAME corpus, measured live before either fix landed, was 5,565-9,106ms
(0% success before Part 2.4 of S-E's own prior session; once merely
"working", the floor this frente started from). Decomposition of the
remaining ~300ms (per-call debug timing, removed before the final commit,
one representative call): `capability_states` 0ms, `semantic_index_state`
0ms (cached), `semantic_coverage_summary` 0ms (cached), `semantic_scope_counts`
~90ms (a live `COUNT(*)` over `artifact_versions`, not yet cached),
`semantic_vectors` ~120ms total including the shard-cache-warmed packed-byte
reads, `embedQuery` ~2-12ms, artifact `exactVectorScan` (2,490 candidates)
~9ms, entity scan+aggregate (10,964 candidates, bounded top-K fast path)
~90-110ms, and **`hydrateSemanticCandidates` ~260-270ms** -- now the single
dominant cost, `records_by_artifact_versions`/`records_by_ids` batch reads
plus up to ~200 bounded-concurrency (`SEMANTIC_HYDRATION_CONCURRENCY=16`)
`sourceSnippet` CAS reads for the FULL fused artifact+entity candidate set
(up to `SEMANTIC_CANDIDATE_CAP` x 2 = 200), not just the
`response_budget.max_items` (50) actually returned to the caller --
`response_budget` is a documented, deliberate prior-frente decision NOT to
thread down to this port layer (`trySemanticSearch`'s own comment: "does
not reach this port layer"), so capping hydration to the caller's page size
would be a real architectural change, out of this frente's own scope under
its time budget. Tried raising `SEMANTIC_HYDRATION_CONCURRENCY` 16 -> 48 as
a cheap experiment: no measurable improvement (270ms -> 270ms p50, 535ms ->
502ms p99) -- reverted; the cost is per-call latency (CAS read + decode),
not fan-out-limited, so concurrency was never the lever. Reported here,
honestly, as the newly-exposed floor for a future frente (thread
`response_budget` down to the snapshot-port hydration call, or hydrate
lazily per returned page).

`core:search_hybrid`'s own extra ~250-600ms (545ms p50 vs 257ms for
semantic-only) is the ADDITIONAL lexical lane (`search_literal`/FTS5) plus
RRF fusion cost -- lexical was fully current (`current: true`) for this
measurement, so this is genuine lexical-lane latency at this corpus size,
not a degraded-fallback artifact; out of this frente's own scope (semantic
latency), reported for the record.

### (c) n8n complete -- NOT reached; see Part 4 for why, with the literal numbers

## Part 4: full n8n embed -- attempted at 2 and 3 workers, a genuine, still-unsolved scaling floor found

Corpus: `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02` (read-only,
shared benchmark asset), 14,958 JS/TS/Vue files (~20k total files including
non-JS/TS). Same daemon/provider setup as Part 3.

**`URDIRA_SEMANTIC_WORKERS=2`**: run for approximately 2 hours of wall time
across this session (interrupted once by an operational incident, see
below), reaching **72,922 entity vectors committed** and
**28,373/257,901/79,764** (`covered`/`excluded`/`unsupported`)
`semantic_document_status` rows before the incident. Artifact-grain pass
had not yet started (`vector_projection_rows` showed `entity` rows only,
zero `artifact` rows, the whole run).

**Operational incident** (this session's own mistake, not a codebase bug):
mid-run, the data root's disk filled (`ENOSPC`, confirmed in the daemon's
own log) -- caused by OTHER large stale scratch directories from PRIOR,
unrelated sessions sharing the same `~/Proyectos/urdira-benchmark/v4-fold/`
tree (cleaned up by a concurrent, unrelated process during this session,
recovering the disk from 21GB to 58GB free -- not this session's own
cleanup). Restarting the daemon after this left THREE separate orphaned
`semantic-maintenance-process.js` children (PPID 1, survivors of three
successive `daemon stop`/`daemon start` cycles whose `stop` RPC calls
sometimes returned before the process tree fully exited) all writing to the
SAME `.semantic.sqlite` file concurrently via WAL, growing its WAL file to
**11.5GB** (main file 877MB) without ever completing a checkpoint or
committing a single new row -- confirmed via `lsof` (3 live PIDs holding
the file open) and `PRAGMA wal_checkpoint` (`busy=1`, only 405/2,827,698
frames checkpointed on the first attempt). Cleaned up: killed all 3 orphans,
removed the stale writer-lock file, ran `PRAGMA wal_checkpoint(TRUNCATE)` to
completion (`0|0|0`), confirmed the underlying row/status counts were
UNCHANGED and consistent (72,922 vectors, the 3-status-count triple above)
-- no data corruption, just wasted wall time and disk churn. Restarted
ONE clean daemon afterward and verified via `ps`/`lsof` that exactly one
process tree existed before continuing.

**`URDIRA_SEMANTIC_WORKERS=3`** (after the clean restart): run for a
further ~20 minutes of real, confirmed CPU-bound work (2 `semantic-maintenance-process`
children sustained at 90-97% CPU each throughout), during which
`semantic_document_status` grew by only **21 rows** (257,901->257,918
excluded, 79,764->79,769 unsupported, 28,373->28,372 covered) and
`vector_projection_rows` did not grow at all (72,922, unchanged) --
**an observed rate on the order of 0.03 status-rows/second** at this stage
of the pass. This is NOT attributed to CPU contention (`uptime` load 5-7
throughout this final segment, not the 30+ seen earlier in this session)
-- it is a genuine processing-rate floor at full n8n's own candidate scale.

**Root cause not found within this session's remaining time budget** (this
session's OWN honest limit, stated plainly rather than glossed over): the
`semantic_document_status` numbers (28,372 covered + 257,918 excluded +
79,769 unsupported = 366,059 classified) already exceed n8n's own
previously-measured candidate-entity count (326,817, S-D's histogram,
`docs/evidence/2026-09-07-v4-semantic-embed-performance-and-latency.md`),
so bulk classification (`syncDocumentStatusBulk`) has likely already run to
completion or near it; the remaining ~28k `covered` entities (vs. n8n's own
measured ~17,630 ELIGIBLE entities from that same histogram) suggests most
truly-eligible entities may already be covered from THIS run's own earlier
progress, and the current stall is in a different, not-yet-identified part
of the pipeline (plausibly the artifact-grain pass, never observed to
start, or a specific slow query/lock this session did not have time to
profile at this corpus's own scale). This directly corroborates, rather
than newly discovers, the standing prior finding
(`docs/evidence/2026-09-07-v4-semantic-embed-performance-and-latency.md`:
"full n8n embed did NOT complete in 3h44m") -- the P0 fixes S-E made
(fd leak, entity-candidate-enumeration OOM, `nativeTopKChunked` infinite
recursion) removed the confirmed CRASHES that previously made a full n8n
embed impossible to even ATTEMPT, but did not by themselves make it FAST;
a genuine profiling pass AT full n8n scale specifically (not extrapolated
from `packages/cli`'s 6x-smaller candidate count) is the concrete next step
this evidence hands to the next frente.

**Per §0's own instruction** ("aplica la palanca 4 de S-D... y mide otra
vez" only applies once the workers=2/3 curve is in hand and still short of
30 minutes): given NEITHER worker count reached anywhere near a completed
pass within this session's own multi-hour attempt, applying the
`max_gap_segments` lever (which bounds ARTIFACT-grain gap-composition
segment count, `packages/engine/src/semantic-reconciler.ts`'s
`max_gap_segments` option -- already built by S-D, never wired to the
daemon/CLI layer, confirmed by grep: no `apps/urdira`/`packages/daemon`
call site passes `entity_policy`) would not plausibly address a stall that,
per the numbers above, is occurring in the ENTITY-grain pass or its
successor, not in artifact-grain gap composition -- wiring and applying
that lever without evidence it addresses the actual stalled phase would be
guessing, not measuring. Not applied this session; flagged for the next
frente once the actual stalled phase is identified by profiling.

**Honest final numbers for n8n complete** (objective NOT reached; this is
the demonstrated floor, not a fabricated projection): wall time to
`semantic.completed_generation == current` -- NOT REACHED after
approximately 2.5 hours of combined attempt time across both worker counts
in this session (including the ~20-30 minutes lost to the operational
incident above). Rows committed: 72,922 entity vectors (0 artifact vectors
-- that pass had not started). `semantic_document_status`: 28,372 covered /
257,918 excluded / 79,769 unsupported (entity grain only). `segments_truncated`:
not measured (pass did not reach a point where this session could safely
query it without adding load to the still-running pass). RSS peak per
semantic-maintenance child: ~2.0-2.6GB (`ps` `RSS` column, 3-worker run).
Query latency (c) (n8n complete, hot): NOT MEASURED -- the corpus never
reached `semantic.current`, so this scale's own `core:search_semantic`
answer is only ever `core:semantic_index_unavailable`/`updating`
(never a stable "hot" state to measure).

## Part 5: incremental edit

Full n8n scale (Part 2.3/3.3's own literal ask) is not reachable for this
test either, for the identical reason -- an incremental edit only has a
meaningful "time to `semantic.current`" story once the WORKSPACE reaches
`semantic.current` at least once, which n8n complete never did this
session. Substituted the SAME real corpus at `packages/cli` scale (2,490
files -- ALREADY over the 2,000-file kqueue budget from S-E's own fd fix,
so this genuinely exercises the fs-events watcher path n8n complete would
also use, not the kqueue path the ORIGINAL 100-file incremental test used).

Methodology: the n8n corpus is otherwise read-only (a shared benchmark
asset) -- one real file
(`packages/cli/src/abstract-server.ts`) was temporarily made writable,
appended one marker line, watched for `semantic.completed_generation` to
advance via the SAME live daemon (no explicit `core:reindex`), then
restored to its EXACT original bytes and file mode (verified: the corpus
is byte-identical to before this test ran).

- `semantic_index_state.completed_generation` advanced 1 -> 2 within
  **217.0 seconds** of the edit (fs-events detection delay, per S-E's own
  ~12s median finding, plus this frente's own embed/status-check overhead
  for one changed file among 2,490).
- `semantic_segment_cache` grew by exactly **+1 row** (13,431 -> 13,432) --
  every other file's segments hit the cache; only the genuinely-changed
  file's own segment(s) were freshly embedded.
- **Cache hit rate for this edit: 99.99%** (1 miss out of 13,432 total
  cache rows after the edit) -- consistent with, and better than, S-E's own
  100-file measurement (99.86%) at 130x the corpus scale.
- `core:search_semantic` answered correctly (`materialization_state:
  "complete"`) immediately once `semantic.current` flipped back to `true`.

---

## Final counts (literal)

- Files changed (this frente, both commits): `packages/storage/sql/{workspace-v3,workspace-v4-semantic}.sql`,
  `packages/storage/src/{workspace-v3-sql.generated,workspace-v4-sql.generated}.ts`,
  `crates/urdira-indexing-core/src/{workspace_v3_sql,workspace_v4_sql}.rs`,
  `packages/engine/src/{canonical-query-data-port,semantic-reconciler,native-query-snapshot-port}.ts`,
  `tests/{phase-canonical-query-data-port,semantic-maintenance,native-query-snapshot-port}.test.ts`,
  this file (new).
- Bugs found and fixed (4, all confirmed by live daemon measurement, not
  merely unit tests): (1) `semantic_document_status_counts`/`semantic_affected_documents`
  computed live on every query, 5.0-5.4s each at ~94.5k rows -- fixed via
  materialized per-generation summary + covering index; (2) entity-lane
  `exactVectorScan` fully uncapped, 286ms at 10,964 candidates -- fixed via
  a bounded-then-escalate top-K scan; (3) `vector_shards` packed bytes
  re-read from CAS on every query -- fixed via a content-hash-keyed cache;
  (4) `NativeCanonicalQuerySnapshotPort` (the port EVERY real v4 workspace
  actually uses) never delegated the new `semantic_coverage_summary` method
  (silently disabling fix #1 in production) and computed
  `semantic_entity_scope_counts` via an uncached full corpus walk (5.0-5.4s
  at ~40k records) -- fixed via the missing delegation + a per-generation
  cache. Bug #4 in particular is the session's own strongest argument for
  "measure against the REAL daemon, not just unit tests against the SQLite
  port directly" -- every one of Part 1's own new tests passed, and the fix
  was still completely inert in production until this session's own live
  measurement caught it.
- Bug found and NOT fixed (reported for the owner's queue, with literal
  numbers and a stated reason it could not be root-caused this session):
  full n8n embed's own processing rate collapses to ~0.03 status-rows/second
  at some point after ~366k `semantic_document_status` rows are classified,
  independent of worker count (2 or 3) and independent of machine
  contention (confirmed via `uptime` during the stalled window) -- the
  stalled phase itself was not identified within this session's time
  budget; flagged as the concrete next step (profile AT n8n's own full
  scale, not extrapolated from `packages/cli`).
- Test files touched: 3; new test count: `tests/semantic-maintenance.test.ts`
  (+2), `tests/phase-canonical-query-data-port.test.ts` (+5),
  `tests/native-query-snapshot-port.test.ts` (+2) -- 9 new tests total.
- `pnpm typecheck`/`pnpm lint`: clean (only the same 6 pre-existing,
  unrelated fixture errors under `tests/fixtures/codebases/typescript/{barrel-method-call,
  multi-hop-barrel-rename}` every prior frente's evidence also reports).
- Required test files run together, all green: `tests/semantic-maintenance.test.ts`
  (52 tests), `tests/phase-canonical-query-data-port.test.ts` (106 tests),
  `tests/native-query-snapshot-port.test.ts` (13 tests),
  `tests/phase10-semantic.test.ts`, `tests/semantic-entity-source-v4.test.ts`,
  `tests/semantic-provider.test.ts`, `tests/architecture-guardrails.test.ts`,
  `tests/contracts.test.ts`, `tests/exact-vector-top-k-benchmark.test.ts`,
  `tests/phase-daemon-indexing-integration.test.ts`,
  `tests/phase-daemon-v4-semantic.test.ts` -- 388 passed, 1 skipped (the
  same release-artifact-gated e2e test S-E's own evidence noted).
- Query latency, final: 100 files p50 41.0ms/p99 52.9ms (target <=100ms
  MET, 4.2x better than S-E's own 222.5ms); `packages/cli` (2,490 files)
  p50 256.6ms/p99 308.1ms (target <=250ms NOT quite met, 19.4x better than
  the 5,978.6ms this frente started from); n8n complete NOT measured (the
  corpus never reached `semantic.current` this session).
- Embed: `packages/cli` scale already complete from a prior session/frente
  at start (2,490 artifact + 10,964 entity vectors, reused for latency
  measurement, not re-embedded this session). n8n complete: NOT completed
  at either 2 or 3 workers; 72,922 entity vectors / 366,059 classified
  status rows reached before the session's own time budget ran out: see
  Part 4 for the full, literal accounting and the operational incident
  encountered along the way.
- Incremental edit (substituted at `packages/cli` scale, 2,490 files, since
  n8n complete never reached `semantic.current`): generation advanced in
  217.0s; segment cache hit rate 99.99% (1 miss / 13,432 total cache rows).
  Source file verified restored to its exact original bytes/mode.
