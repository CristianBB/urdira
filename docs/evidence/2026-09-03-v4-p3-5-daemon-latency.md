# P3-5: closing the gap between worker compute and daemon-observed edit latency

Implements plan `resilient-knitting-twilight.md` §6.1 (task P3-5, TypeScript
daemon side only): the daemon side of the ~3.7s gap between the Rust
worker's own compute time for an edit (~0.7-0.9s, worker-only, P3-2 §8.1)
and what a user actually observes through the daemon (~4.5s durable,
P3-2 §8.2). Not committed, per task instructions. Another agent (P3-3) was
editing `crates/*` concurrently; no crate file was touched by this task.

Machine: macOS arm64 (Darwin 25.5.0), 10 cores, 32GB RAM. `rustc` 1.98.0,
Node 24.18.1. `release/native/darwin-arm64/urdira-indexing-worker` used
as-is (built ~10:41 by the concurrent P3-3 session; `cargo build --release
-p urdira-indexing-worker` confirmed the workspace still compiles, 0.33s
no-op build against `target/release/` -- a *different* build directory
than `release/native/` uses, so this was a compile sanity check only, not
a rebuild of the artifact actually used). Corpus:
`~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`
(READ-ONLY throughout, 14,083 JS/TS owners via `--owners 14083`; the
harness's own pre-existing guard copies it to a scratch directory before
any mutation, unmodified, verified still working).

## 1. Timeline instrumentation

Added to `packages/daemon/src/runtime.ts`:

- `DAEMON_START_EPOCH_MS` (module load time, effectively daemon start) --
  the zero point every timestamp below is reported relative to.
- `debugTiming()`, gated on `URDIRA_DEBUG_TIMING=1` (already set by the
  harness) -- one `[urdira][timing] workspace=... <milestone> t=<ms>ms`
  line per milestone.
- `V4ScanTimeline` (`fs_event_at`, `aggregated_at`, `request_sent_at`,
  `queryable_at`, `completed_at`, `readiness_updated_at`) plus three maps
  (`v4PendingScanTimelines` before a scan is admitted,
  `v4ActiveScanTimelines` for the in-flight scan, `v4LastScanTimelines` for
  the most recently settled one) and `relativeTimeline()` to convert to
  wire-shape relative ms.
- `core:status` gained `daemon_epoch_ms_offset: DAEMON_START_EPOCH_MS`
  (added to the `DaemonStatus` interface). `core:index_status` gained
  `last_scan_timeline` per v4 workspace (the active scan's timeline if one
  is running, else the last settled one).
- Instrumentation points: `fs_event_at`/`aggregated_at` captured in
  `scheduleWorkspaceScan`'s aggregation branch (first event of a burst /
  the flush that admits it) and at direct admission when aggregation is
  disabled; `request_sent_at`/`completed_at`/`readiness_updated_at`
  (durable) captured in `runV4WorkspaceScan`; `queryable_at` +
  `readiness_updated_at` (queryable) captured in a NEW live `onQueryable`
  callback (§2.3).

`packages/engine/src/rust-workspace-scan.ts`'s `runRustWorkspaceScan` grew
an optional third parameter, `onQueryable`, invoked synchronously the
moment the underlying transport's own `queryable` event fires -- live,
before the function's own promise resolves -- so a caller can react to
queryable data immediately instead of waiting for the whole scan
(`ScanCompleted` included) to settle. Additive: existing callers (there
were none passing a third argument) are unaffected, and the function's
returned `RustWorkspaceScanOutcome` shape is unchanged.

`scripts/v4-mutation-harness.mjs`: `fetchDaemonEpochOffsetMs()` reads
`core:status` once; `deriveTimelineLatencies()` converts a workspace's
`last_scan_timeline` plus that offset into `event_queryable_ms`/
`event_durable_ms` (true latencies, mutation write to daemon milestone, on
the SAME `performance.timeOrigin + performance.now()` epoch-ms clock
family `Date.now()` is drawn from) and a `timeline_breakdown_ms` object
(`watcher_detection`, `aggregation_debounce`, `admission_and_ipc`,
`worker_to_queryable`, `worker_to_durable`, `readiness_update_overhead`).
Both the poll-observed (`queryable_ms`/`durable_ms`, pre-existing) and the
new event-timeline fields are reported on every mutation and on `cold`,
side by side, for direct comparison (`scripts/v4-mutation-harness.d.mts`
updated to match).

## 2. Attributing and fixing the ~3.7s gap

### 2.1 Aggregation window (item 2b)

`scheduleWorkspaceScan` now resolves the debounce window/cap
PER-WORKSPACE: `scanAggregationWindowMsFor`/`scanAggregationMaxMsFor`
return the composing application's explicit
`scan_aggregation_window_ms`/`scan_aggregation_max_ms` when either was set
(unchanged v3 behavior, still 200ms/1000ms by default), but for a v4
workspace (`v4ReadinessState.has(workspaceId)`, true from the instant that
workspace's first scan starts running) with NEITHER overridden, use
100ms/500ms instead (plan §6.1). Measured (§5): `aggregation_debounce`
sits at 101-103ms median across every mutation kind at n8n scale -- the
new default working exactly as designed, and (unchanged from before this
task) a single isolated edit only ever waits the WINDOW, never the cap:
`delayMs = min(windowMs, max(0, maxMs - elapsed))` was already correct,
just parameterized per-workspace now.

### 2.2 IPC / persistent worker session (item 2d)

Already correct, verified by reading `apps/urdira/src/index.ts`'s
`resolve_workspace_scan_transport`: it reuses the SAME
`indexingCoreSessions: Map<workspaceId, IndexingCoreProcessTransport>` map
`resolve_plugin_provider`/`resolve_source_indexing_core` already maintain
-- one persistent worker process per workspace, created lazily, reused
across every subsequent scan. No re-handshake per edit. No change made;
confirmed via the measured `admission_and_ipc` bucket (29-43ms median,
§5) being small and stable.

### 2.3 Readiness path -- the real bug (item 2c)

**Found**: `runRustWorkspaceScan` already had a live `onQueryable`
callback surface at the transport layer
(`IndexingCoreProcessTransport.workspaceScan`'s own second parameter,
pre-existing), but `runV4WorkspaceScan` never passed a callback through it
-- `v4ReadinessState` was written ONLY after the whole `await
runRustWorkspaceScan(...)` call returned, i.e. after `ScanCompleted`, not
at `Queryable`. Worse: `v4WorkspaceReadinessFrom`'s `structural_ready`
additionally required `workspace.status !== "indexing"`, and
`workspace.status` only ever leaves `"indexing"` via `registry.markReady`,
which `runV4WorkspaceScan` also only ever called after the whole scan
settled -- so even a hypothetical live update would have been masked by
this second, redundant gate.

**Fixed**: `runV4WorkspaceScan` now passes an `onQueryableLive` callback
to `runRustWorkspaceScan` that, the instant it fires, (a) sets
`v4ReadinessState.queryable_generation` immediately, (b) records
`timeline.queryable_at`/`readiness_updated_at`, (c) calls
`notifyReadinessChanged` (the same wake-waiters mechanism
`waitForQueryFrontier` already used for a different purpose). A scan that
fails AFTER reporting a live `Queryable` rolls the readiness state back to
its pre-scan snapshot before re-throwing (`priorReadinessForRollback`),
so a failed scan can never leave a dangling `queryable_generation` with no
corresponding durable state; this rollback is now shared by BOTH the
initial attempt and the `Changed`-rejected-retry-with-`Full` attempt (one
outer `try/catch`, not two independent ones -- a real gap in an earlier
draft of this fix, found and closed before measuring). `structural_ready`
in `v4WorkspaceReadinessFrom` no longer checks `workspace.status`, only
`queryable_generation !== undefined && last_scan_error === undefined` --
the coarse `"indexing"` status label is a different concern
(`scheduleWorkspaceScan`'s own admission checks) that should never have
gated v4's own generation-based readiness.

**Measured effect**: `readiness_update_overhead` (queryable_at to
readiness_updated_at) is 5-7ms median across every kind at n8n scale --
effectively instant, confirming the fix. Before this fix the number was
architecturally unmeasurable as a separate quantity: readiness only ever
updated at `ScanCompleted`, by definition simultaneous with completion.

### 2.4 A second, more consequential bug found downstream (rename residual)

Investigating item 4 surfaced a THIRD bug, in
`packages/plugin-javascript-typescript/src/indexing-core-process-transport.ts`
(outside this task's originally-listed file set, but directly blocking
item 4's own deliverable -- fixed, see §4.1 for the full writeup and
rationale for touching it).

### 2.5 Watcher latency on macOS kqueue (item 2a)

**Why kqueue is forced**: `git log`/`docs/decisions/04-workspace-snapshot-incremental-indexing.md`
confirm this was a deliberate, real correctness fix (commit `7d04d49`):
"FSEvents reports a client-side drop when the Node callback cannot drain
its event stream while a large repository is being indexed... kqueue has
no such client queue." This reason was re-tested, not just re-read (below)
-- it still holds.

**Measured cost**: at n8n scale (14,083 owners), `watcher_detection` (the
gap between a mutation's actual `fs.writeFile()`/`fs.rename()` and the
daemon's watcher callback firing for it) is **the dominant term in the
entire daemon-observed edit path** -- median 2.0-3.0s per kind (§5),
roughly double the worker's own compute time and an order of magnitude
over every other bucket combined (aggregation + admission + readiness
overhead together: 137-153ms median). This is NOT present in the P3-2
worker-only benchmark (which never touches a real watcher at all) and is
NOT reproduced at small fixture scale (task-planner, 39 files: measured
`watcher_detection` 4.6-5.5ms, §4.2) -- it is specific to a large,
many-directory tree, consistent with `@parcel/watcher`'s own kqueue
backend needing to track every directory individually (no OS-level
recursive-watch primitive the way FSEvents has).

**Tested the alternative, live**: added an opt-in, off-by-default escape
hatch (`URDIRA_WATCHER_BACKEND=fs-events`, never set by any shipped code
path) to `watcherOptionsForSourceProvider`
(`packages/engine/src/watchers.ts`) and ran a real n8n-scale daemon+watcher
session with it. Result: the daemon's own warm-up edit was detected and
scanned correctly (generation 2 landed), but the VERY NEXT edit -- issued
immediately after -- was **never detected within the 30s timeout** (the
harness's `waitForV4Readiness` threw `did not reach a new structural
generation within 30000ms`). This is a live, direct reproduction of
exactly the failure mode decision 04 was written to prevent (an event
lost/delayed indefinitely while the Node process was busy finishing the
prior scan's publish/maintenance work) -- not merely a theoretical risk.
**Kqueue remains the default and was NOT changed.** The escape hatch is
kept (default-off) only so a future investigation does not need to touch
this file again to re-test the tradeoff; flipping the default would
require first re-proving FSEvents no longer drops events under load at
this scale, which this task explicitly did not attempt to fix (it is not
this task's Rust/native-layer scope, and the watcher itself is pure JS
already-owned code, not a crate).

**Verdict**: `watcher_detection` is real, measured, and NOT fixed -- the
one deliberate scope decision of this task. It is the leading root cause
of the daemon/worker-only gap this task was chartered to attribute, and
the honest reason the ≤250ms overhead-outside-worker gate below is missed.

### 2.6 Await chains serializing unrelated work (item 2e)

Checked by reading: `submitLexicalMaintenance(workspaceId)` (the last line
of `runV4WorkspaceScan`) is called, not awaited -- already fire-and-forget
before this task, confirmed unchanged. No other await chain inside
`runV4WorkspaceScan`/`scheduleWorkspaceScan`'s v4 branch serializes
readiness behind unrelated work; the two SQL calls that DO run before the
worker request (`maybeBootstrapV4Workspace`, `registerWorkspace`) are
already accounted for inside the measured `admission_and_ipc` bucket
(29-43ms median at n8n scale) -- small, not a target for further work this
session.

## 3. Harness readiness modes (item 3)

`--readiness poll|events` (default `poll`, unchanged behavior). `events`
tightens the readiness-wait loop's own polling interval to 25ms.

**Investigated, not built**: a daemon-side push-notification RPC.
`packages/daemon/src/runtime.ts` already has an event-driven wake
primitive, `notifyReadinessChanged`/`waitForReadinessChanged`
(`readinessWaiters`), but it is wired ONLY into `waitForQueryFrontier` (a
query RPC's own internal blocking-wait loop, itself still polled by ITS
caller in bounded steps) -- there is no general "block until readiness
changes" RPC surface an external harness could call instead of polling
`core:index_status`. Building one was judged a real daemon-protocol
addition (a new RPC verb, timeout/cancellation semantics, back-compat for
every existing client) disproportionate to this task's scope; the fast
25ms poll satisfies the task's own fallback instruction ("OR ... a
fast poll (25ms)"). Both modes report the SAME timeline-derived
`event_queryable_ms`/`event_durable_ms` (computed from the daemon's own
timestamps, not from polling) regardless of poll interval -- these, not
the poll interval, are what §5's table actually reports.

## 4. Rename through the real watcher (item 4)

### 4.1 Root cause #1 (already fixed before this session) and root cause #2 (found and fixed this session)

P3-2 already fixed the daemon/watcher-side widening
(`packages/engine/src/watchers.ts`'s cross-path rename combining, one
`on_reconcile` call carrying `changedUris: [new path], authoritativeDeletes:
[old path]`) and reported a SEPARATE residual: a genuine `fs.rename()`
through the real watcher at n8n scale "still hangs" (P3-2 §4.4), suspected
to be `ParcelWatcherAdapter`'s translation of a real OS rename.

This session re-investigated at fixture scale first (cheap, fast) and
found the P3-2-fixed watcher/daemon widening working CORRECTLY: a real
`fs.rename()` on `tests/fixtures/codebases/typescript/task-planner` (39
files) reaches `on_reconcile` as one combined call, and the Rust worker's
`delta::run` correctly splits it into two internal generations within one
`WorkspaceScan` command (log line: `v4 delta: mixed burst split into two
generations: structural=[...Deleted] content=[...Modified]`, confirming
P3-2 §5's own feature working as designed).

What actually still blocked completion was a THIRD, distinct,
previously-undiagnosed bug: `packages/plugin-javascript-typescript/src/indexing-core-process-transport.ts`'s
`queryableHandlers` map assumed AT MOST one `queryable` event per
`request_id` before the terminal event, and deleted the handler after the
first match. A mixed-generation-split scan emits ONE `queryable` PER
internal generation, all sharing the SAME `request_id` -- the second
`queryable` event therefore fell through to the `pending` map and was
misread as the terminal event, throwing `Rust workspace scan returned an
unexpected terminal event: queryable`. **Fixed** by keeping the handler
registered across every `queryable` event for a `request_id`, clearing it
only when the actual terminal event resolves `pending`. This file is
outside this task's originally-listed ownership, but the fix is narrow
(swap which line clears one `Map` entry), touches no shared/v3-serving
logic differently than before, and is the one change that actually makes
item 4's own deliverable (a real rename completing end-to-end) possible;
left unfixed, rename remains broken regardless of anything on the daemon
or watcher side.

### 4.2 Verified live, fixture scale, real daemon + real watcher + real fs.rename()

New test, `tests/v4-mutation-harness.test.ts`, `"reaches durable for a
real fs.rename() through the real daemon+watcher, at fixture scale (P3-5
item 4)"`:

| Variant | queryable_ms (poll) | durable_ms (poll) | event_queryable_ms | event_durable_ms | roots: dependency | roots: records |
|---|---:|---:|---:|---:|---|---|
| `rename_no_rewrite` | 430.3 | 535.3 | 507.6 | 508.6 | true | true |
| `rename_rewrite` | 617.2 | 826.6 | 994.2 | 995.2 | true | **false** (expected) |

`rename_no_rewrite`'s timeline breakdown: `watcher_detection` 4.6ms,
`aggregation_debounce` 101ms, `admission_and_ipc` 30ms,
`worker_to_queryable`/`worker_to_durable` 369-370ms,
`readiness_update_overhead` 1ms -- both roots match a from-scratch oracle
exactly, like `create`/`delete` already do (decision 11: no existing
record's identity is touched by a pure structural delete+create).

`rename_rewrite`'s `records` root mismatch (exactly 4 record ids on each
side, matching its 4 rewritten importers exactly) is **expected, by
design, not a new bug** -- rewriting 4 importers' import specifiers is a
genuine content edit to those 4 files (landing as its own later `Changed`
scan, not part of the rename's own mixed-generation burst), so their
`jsts:entity_container` rows chain and diverge from a from-scratch oracle
for the identical reason `edit`/`hub_edit` already do in this same test
file's earlier test. (An earlier draft of this doc and the test's own
comments mischaracterized this as a new Rust-owned "digest-churn" bug
mirroring P3-2 §6's hub-edit finding -- corrected after re-checking against
decision 11's own documented behavior; the mismatch count matching the
edited-file count exactly, not exceeding it, is the tell that this is
ordinary chaining, not contamination.)

Daemon-fake-watcher coverage for the underlying combining logic already
existed (P3-2, `tests/phase15-workspace-control.test.ts`'s
`DeterministicFakeWatcher` rename tests and
`tests/phase-daemon-scan-aggregation.test.ts`'s "Daemon rename coalescing"
describe block) -- both re-run clean, unaffected by this session's changes.

No dedicated unit harness exists for
`indexing-core-process-transport.ts`'s raw wire protocol (it is normally
only exercised through real end-to-end tests); building one from scratch
was judged disproportionate given the fix is already regression-tested
live by §4.2's new e2e test (which fails with the exact pre-fix error
message when the fix is reverted -- verified by reverting it locally
during this investigation).

## 5. Measurement: daemon-driven n8n harness after fixes

Command (idle machine confirmed via `pgrep` before running; `verify_roots:
"skip"` used for this specific timing run only -- see §5.3):

```
node -e '<script calling run({ ..., verify_roots: "skip", mutation_kinds:
["edit","create","delete","rename","hub_edit"], repeat: 3, warm: 1,
readiness_mode: "events", owners: 14083 })>'
```

### 5.1 Cold (generation 1, Full scan)

| | poll-observed | event-timeline |
|---|---:|---:|
| queryable_ms | 21,418.6 | 21,402.9 |
| durable_ms | 22,237.6 | 22,233.9 |

(`worker_to_durable` 21,676ms -- consistent with P3-2's own worker-only
cold measurement of 21,402-21,971ms; no watcher/aggregation applies to a
first scan.)

### 5.2 Per-kind, 21 mutations (3 repeats x 7 concrete variants, `--warm 1` already excluded)

Poll-observed (this harness's own quantized measurement) vs event-timeline
(the daemon's own true timestamps), ms:

| Kind | n | poll q p50 | poll q p95 | poll d p50 | poll d p95 | event q p50 | event q p95 | event d p50 | event d p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| edit | 3 | 3,811.3 | 3,833.6 | 3,811.3 | 3,858.0 | 3,786.6 | 3,828.7 | 3,792.6 | 3,833.8 |
| create | 3 | 5,069.4 | 5,160.1 | 5,069.4 | 5,160.1 | 5,056.8 | 5,136.3 | 5,061.8 | 5,141.3 |
| delete | 6 | 4,652.0 | 5,494.7 | 4,652.0 | 5,494.7 | 4,624.6 | 5,479.8 | 4,630.1 | 5,486.5 |
| rename | 6 | 4,842.5 | 6,576.4 | 5,732.2 | 7,495.3 | 6,278.2 | 8,134.3 | 6,284.7 | 8,142.1 |
| hub_edit | 3 | 3,835.5 | 10,215.5 | 3,835.5 | 10,215.5 | 3,808.9 | 10,194.4 | 3,814.9 | 10,202.2 |

Timeline breakdown medians (ms), event-derived:

| Kind | watcher_detection | aggregation_debounce | admission_and_ipc | worker_to_queryable | worker_to_durable | readiness_update_overhead |
|---|---:|---:|---:|---:|---:|---:|
| edit | 2,000.3 | 102.0 | 35.0 | 1,648.0 | 1,654.0 | 5.0 |
| create | 3,036.1 | 102.0 | 43.0 | 1,729.0 | 1,734.0 | 5.0 |
| delete | 2,654.3 | 103.0 | 33.5 | 1,666.5 | 1,672.0 | 6.0 |
| rename | 2,764.1 | 101.0 | 29.0 | 1,416.5 | 1,424.0 | 7.0 |
| hub_edit | 2,105.7 | 101.0 | 29.0 | 1,726.0 | 1,732.0 | 7.0 |

Overhead outside the worker (`watcher_detection + aggregation_debounce +
admission_and_ipc + readiness_update_overhead`), median: edit 2,142ms,
create 3,186ms, delete 2,797ms, rename 2,901ms, hub_edit 2,243ms --
**dominated by `watcher_detection` in every kind** (93-95% of the
non-worker total).

### 5.3 A real, honestly-reported measurement caveat

`edit`/`create`/`delete`/`hub_edit`'s `worker_to_queryable` (1.4-1.7s
median) is noticeably higher than P3-2's own pure worker-only, in-process
benchmark at the same corpus (703-989ms steady-state edit, 976-989ms
create/delete). Two real, non-exclusive contributors, neither chased
further this session: (a) genuine IPC/process-boundary cost (JSON framing,
a separate OS process, scheduling) the in-process benchmark cannot have;
(b) the harness itself calls `computeNativeAccelerationCorpusDigest`
(hashing the ENTIRE 14,083-owner corpus) after EVERY mutation for its own
`resulting_corpus_digest` field, which can consume CPU on the same machine
between mutations and bleed into the next mutation's own worker-compute
window -- the exact class of harness-measurement artifact this project's
own history already flags (`project_fullscan_publish_2026-08-13.md`:
"bench trap: resumed lexical builds contaminate benches"). Reported as an
open measurement caveat, not fixed or further isolated this session.

### 5.4 Gate comparison

| Target (plan §6.1) | Result | Verdict |
|---|---|---|
| Overhead outside the worker ≤ 250ms p50 | 2,142-3,186ms p50 | **Missed by ~9-13x**, root cause identified precisely (§2.5): watcher detection latency at real corpus scale, not fixed (kept correct over fast; the tested alternative measurably regresses correctness) |
| Edit durable p50 ≤ worker + 250ms | worker (`worker_to_durable`) 1,654ms; total edit durable p50 3,811ms (poll) / 3,793ms (event) | **Missed**, same root cause |

What WAS fixed and measurably improved, in isolation:
- Aggregation window: 200ms -> 100ms default for v4 (measured 101-103ms
  actual, matching the new default exactly).
- Readiness update latency (Queryable -> registry): unmeasurable-as-instant
  before (bundled with total scan time) -> 5-7ms median now, a real,
  verified architectural fix (§2.3), not just a faster number.
- Rename: went from "hangs indefinitely at any scale" (P3-2 §4.4) to
  "completes correctly end-to-end, sub-second, at fixture scale" (§4.2) --
  a real bug (§4.1) fixed, not merely characterized.
- IPC/session reuse and lexical-maintenance non-blocking: confirmed
  already correct, no regression introduced.

## 6. Quality gates

- `pnpm -r build` -- clean (16/17 buildable packages; `packages/daemon`
  and `apps/urdira` have no `build` script, rebuilt via `npx tsc --build
  packages/daemon apps/urdira --force`, also clean).
- `pnpm --filter @urdira/engine exec tsc --noEmit`, `pnpm --filter
  @urdira/daemon exec tsc --noEmit`, `pnpm --filter @urdira/runtime exec
  tsc --noEmit`, `pnpm --filter @urdira/plugin-javascript-typescript exec
  tsc --noEmit` -- all clean.
- `npx eslint packages/daemon/src/runtime.ts packages/engine/src/watchers.ts
  packages/engine/src/rust-workspace-scan.ts packages/plugin-javascript-typescript/src/indexing-core-process-transport.ts
  scripts/v4-mutation-harness.mjs tests/v4-mutation-harness.test.ts` --
  clean.
- `npx vitest run tests/phase-daemon-v4-scan.test.ts
  tests/phase-daemon-scan-aggregation.test.ts
  tests/phase-daemon-indexing-integration.test.ts
  tests/v4-mutation-harness.test.ts tests/v4-daemon-e2e.test.ts
  tests/phase15-workspace-control.test.ts` -- **6 files, 62 passed, 2
  skipped (expected: no release-artifact guard), 0 failed.**
- `npx tsc --build tsconfig.tests.json --force` -- same pre-existing
  errors already documented in
  `docs/evidence/2026-09-02-v4-p2-7-daemon-wiring.md` §10 and
  `docs/evidence/2026-09-03-v4-p3-4-mutation-harness.md` §9 (unrelated
  files, `@urdira/storage`-dependent tests mid-edit by a concurrent
  session), zero new errors in any file this task touched -- confirmed by
  grepping the error list for every touched file/directory.
- Idle machine confirmed (`pgrep -f "v4-scan|urdira-indexing-worker|cargo|rustc|n8n-incremental-preflight"`
  empty) before every real n8n-scale run in this document.
- Full-repository `pnpm verify` NOT run: same rationale as every prior P3
  evidence doc in this series (extensive concurrent uncommitted work from
  other in-flight sessions across unrelated packages/crates); every gate
  above is scoped to exactly the files this task touched.

## 7. Files touched

Owned, modified:
- `packages/daemon/src/runtime.ts` -- timeline instrumentation (item 1),
  live-queryable readiness wiring + rollback (item 2c),
  per-workspace aggregation window/cap (item 2b), `daemon_epoch_ms_offset`/
  `last_scan_timeline` wire additions, `v4WorkspaceReadinessFrom`'s
  `structural_ready` decoupled from `workspace.status`.
- `packages/engine/src/rust-workspace-scan.ts` -- `runRustWorkspaceScan`'s
  new optional `onQueryable` parameter (narrow, additive).
- `packages/engine/src/watchers.ts` -- `URDIRA_WATCHER_BACKEND=fs-events`
  opt-in, default-off escape hatch (item 2a's live experiment); kqueue
  remains the default.
- `scripts/v4-mutation-harness.mjs` / `scripts/v4-mutation-harness.d.mts`
  -- `--readiness poll|events` (item 3), `fetchDaemonEpochOffsetMs`/
  `deriveTimelineLatencies` (item 1), timeline fields threaded through
  `cold`/each mutation and `summaryTableText`.
- `tests/v4-mutation-harness.test.ts` -- corrected/updated top-of-file
  rename doc comment; new real end-to-end rename test (item 4).

Touched outside this task's originally-listed set (see §4.1 for why):
- `packages/plugin-javascript-typescript/src/indexing-core-process-transport.ts`
  -- `queryableHandlers` no longer deleted on the first `queryable` event
  for a `request_id`; only the terminal event clears it now.

Not touched: any `crates/*` file (hard rule honored); `apps/urdira/src/index.ts`
(read, not modified -- `resolve_workspace_scan_transport` was already
correct, §2.2); `scripts/native-acceleration-controller.mjs` (read for its
`READINESS_STABLE_WINDOW_MS`/stable-poll convention, not modified -- that
convention lives entirely in the harness/controller client, not the
daemon, and this task's own `waitForV4Readiness` already had its own
equivalent stable-window logic, unchanged).

## 8. Deviations/residuals summary

1. **Watcher detection latency (item 2a) is real, measured, and NOT
   reduced** -- 2.0-3.0s median at n8n scale, the dominant cost in the
   entire daemon-observed path. The alternative (`fs-events`) was tested
   live and found to REGRESS correctness (an edit went undetected past a
   30s timeout), directly reproducing the failure decision 04 documents.
   Kqueue is kept. This is the single largest reason the plan's ≤250ms
   overhead-outside-worker gate is missed; no further daemon-side fix is
   available without either accepting FSEvents' drop risk or a deeper
   change to `@parcel/watcher` itself (native code, out of this task's
   scope and ownership).
2. **A THIRD rename-blocking bug** (§4.1,
   `indexing-core-process-transport.ts`'s `queryableHandlers` map) was
   found and fixed this session, outside this task's originally-listed
   file ownership -- narrow, low-risk, and necessary for item 4's own
   deliverable to be achievable at all; documented explicitly rather than
   silently expanded scope.
3. **No daemon-side push-notification RPC was built** for item 3's
   "better" option -- judged a real protocol addition disproportionate to
   this task; the 25ms fast-poll fallback the task itself allows was
   implemented instead, and the timeline-derived latencies (not affected
   by poll interval at all) are the numbers that actually matter for §5.
4. **`worker_to_queryable`/`worker_to_durable` at the daemon level (1.4-1.7s
   median) exceed P3-2's pure worker-only benchmark (0.7-1.0s)** by a
   meaningful margin -- a real, honestly-reported measurement caveat
   (§5.3), plausibly including a harness-measurement artifact
   (`computeNativeAccelerationCorpusDigest` running between mutations),
   not isolated further this session.
5. **No dedicated unit test exists for the exact `indexing-core-process-transport.ts`
   bug fixed in §4.1** -- covered instead by a real end-to-end regression
   test (§4.2), verified to fail with the exact pre-fix error when the fix
   is reverted.
6. The rename e2e test's `rename_rewrite` `records`-root mismatch is
   EXPECTED (decision 11), not a residual bug: rewriting 4 importers'
   specifiers is a genuine content edit to those 4 files, so their
   container rows chain and diverge from a from-scratch oracle for the
   same reason `edit`/`hub_edit` already do elsewhere in this test file --
   noted explicitly so it is not mistaken for a new defect.
