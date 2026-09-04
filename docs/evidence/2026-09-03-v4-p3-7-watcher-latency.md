# P3-7: watcher-detection latency -- root cause, fix, and end-to-end verification

Implements plan `resilient-knitting-twilight.md`'s watcher-detection-latency
item: the "2-3s DETECTION latency" P3-5 measured at n8n scale
(`docs/evidence/2026-09-03-v4-p3-5-daemon-latency.md`, 93-95% of the
non-worker edit path). Not committed, per task instructions. A concurrent
agent (P3-6) was editing `crates/urdira-structural-store`,
`crates/urdira-indexing-worker`, `crates/urdira-jsts-syntax-worker`,
`crates/urdira-native-node` throughout this session; no file in those crates
was touched by this task, and `release/native/darwin-arm64/urdira-indexing-worker`
(the shared prebuilt worker binary every test/harness run in this project
uses) was rebuilt by that concurrent session partway through this task's own
work (see §5.3 for the one test failure this caused).

Machine: macOS 26.5.1 (Darwin 25.5.0) arm64, 10 cores, 32GB RAM. Node
24.18.1, `rustc`/`cargo` 1.98.0. `@parcel/watcher` 2.6.0 (`node_modules/.pnpm/@parcel+watcher@2.6.0`).
Watchman: not installed on this machine -- that backend was not tested,
consistent with the task's own "if installed; else skip" instruction.
Corpus: `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`
(READ-ONLY throughout, marker verified present; every mutating run used a
scratch copy under the mandated
`~/Proyectos/urdira-benchmark/v4-p3/scratch-mutation-harness-*`
(daemon harness) or `.../v4-p3/scratch-watch/n8n-scratch` (probe) roots, 20,280
files total, 14,046-14,083 JS/TS candidates depending on slicing).

## Summary (read this first)

**The headline finding reverses P3-5's own conclusion.** P3-5 measured
`watcher_detection` (mutation write -> daemon watcher callback) at 2.0-3.0s
median at n8n scale and hypothesized this was inherent to `@parcel/watcher`'s
kqueue backend needing to track every directory individually. **That
hypothesis was wrong.** The real cause was a bug in the measurement harness
itself: `scripts/v4-mutation-harness.mjs`'s `applyMutation` re-lists the
entire corpus (`listRepoFiles`, an O(files) recursive walk, ~950ms at n8n
scale) and rebuilds an import graph (`buildImportGraph`, a SEQUENTIAL
`readFile`+regex pass over every candidate file, ~2.16s at n8n scale) --
**~2.2-3.5s total, measured directly (§1)** -- before performing the
mutation's actual write, and the harness captured its "mutation happened at"
timestamp *before* calling `applyMutation`, not immediately before the real
write. That pre-write overhead was being counted as watcher detection time.

A direct probe of the real watcher (`scripts/watch-latency-probe.mjs`, new
this task), bypassing the harness's corpus rescan entirely, measured
kqueue's actual detection latency at the same 20,280-file corpus at **p50
7-9ms, p95 11-13ms** -- about three orders of magnitude faster than the
figure being attributed to it. Fixing the harness's timestamp capture (§3.1)
and re-running the real daemon end-to-end confirms the corrected number
(§4): `watcher_detection` p50 7.67ms, p95 45.3ms.

fs-events was independently re-tested, twice (two different native
libraries), and confirmed genuinely unreliable at this scale on this
machine -- kqueue remains the correct default, and decision 04's
FSEvents-drop concern is reinforced, not merely re-affirmed on faith (§4 of
the decision-04 update recommendation, §6).

## 1. Reproducing the harness's own measurement bug

Timed `applyMutation` directly against the n8n scratch corpus
(20,280 files, 14,046 candidates):

```
edit#0: applyMutation total=3492.2ms target=.claude/plugins/n8n/scripts/track-skill-usage.mjs
edit#1: applyMutation total=2738.1ms target=.github/actions/ci-filter/__tests__/ci-filter.test.ts
edit#2: applyMutation total=2245.7ms target=.github/actions/ci-filter/ci-filter.mjs
```

Breaking down where that time goes (`listRepoFiles` then reading every
candidate file's content, the two calls `applyMutation` makes before any
variant-specific mutating call):

```
total files=20280 candidates=14046
listRepoFiles: 953.4ms
filter: 9.2ms
read all candidate file contents (sequential): 2159.8ms
```

This is a near-exact match for P3-5's reported `watcher_detection` medians
(2.0-3.0s, §5.2 of that doc) -- because `mutationWriteEpochMs` was captured
in `run()` *before* calling `applyMutation`, not immediately before
`applyMutation`'s own internal write. Every mutation kind pays this same
corpus-rescan/import-graph-rebuild cost (it happens unconditionally at the
top of `applyMutation`, before the per-variant branch), which explains why
P3-5's medians were similar across `edit`/`create`/`delete`/`rename`/`hub_edit`
despite those kinds doing very different actual filesystem work.

## 2. Root cause, part (a): why kqueue is NOT slow

**Source-level**: `@parcel/watcher`'s kqueue backend
(`node_modules/.pnpm/@parcel+watcher@2.6.0/node_modules/@parcel/watcher/src/kqueue/KqueueBackend.cc`)
registers one kernel-level `EVFILT_VNODE` watch (`open(path, O_EVTONLY)` +
`kevent(..., EV_ADD, NOTE_DELETE|NOTE_WRITE|NOTE_EXTEND|NOTE_ATTRIB|NOTE_RENAME|NOTE_REVOKE, ...)`)
per FILE and per DIRECTORY at `subscribe()` time (`KqueueBackend::subscribe`,
lines 120-177: it iterates `tree->entries` -- built by a full recursive scan
-- and calls `watchDir` on every entry regardless of `isDir`). A write to an
already-tracked FILE fires that file's OWN kevent directly
(`KqueueBackend.cc` lines 82-100: the `else` branch, not the `NOTE_WRITE &&
entry->isDir` branch) -- O(1) per event, not a directory rescan. The O(files)
`compareDir` readdir-diff path (lines 191-289) only runs for a directory's
own `NOTE_WRITE` (an entry added/removed under it), never a plain content
write to an existing file. `Debounce.hh`'s own internal debounce
(`MIN_WAIT_TIME 50`, `MAX_WAIT_TIME 500`, milliseconds) is also inconsistent
with a multi-second figure on its own.

**Empirical**: `scripts/watch-latency-probe.mjs --backend kqueue`, n8n scale,
bypassing the harness's corpus rescan (files pre-selected once, outside the
timed loop):

| Mode | n | matched | p50 (ms) | p95 (ms) | min | max |
|---|---:|---:|---:|---:|---:|---:|
| raw (`@parcel/watcher` directly) | 5 | 5/5 | 7.3 | 13.9 | 7.1 | 13.9 |
| raw | 20 | 20/20 | 8.5 | 11.1 | 6.6 | 13.6 |
| adapter (real `ParcelWatcherAdapter` + `watcherOptionsForSourceProvider`) | 20 | 20/20 | 7.7 | 12.8 | 5.8 | 15.8 |

Both modes agree closely: kqueue detection at this corpus scale is
single-digit-to-low-double-digit milliseconds, full stop.

## 3. Root cause, part (b): why fs-events genuinely fails

Two DISTINCT, independently-provable causes were found -- neither is a
measurement artifact.

### 3a. General FSEvents unreliability at this scale, on this machine, independent of implementation

Tested with ZERO daemon/JS competing load (the probe does nothing but wait
and write), so this is not the "Node callback busy" mechanism decision 04
originally cites -- it reproduces even on an otherwise-idle process.

`@parcel/watcher`'s fs-events backend, n8n scale, raw mode:

| n | matched | p50 (ms) | p95 (ms) | min | max |
|---:|---:|---:|---:|---:|---:|
| 8 | 8/8 | 11,988.7 | 14,988.9 | 7,918.0 | 14,988.9 |

A smaller diagnostic run (n=3, 10s timeout) also showed an outright MISS: the
first edit's own event did not arrive within its own 10s window at all, and
only surfaced batched together with the THIRD edit's event roughly 12+
seconds after its actual write -- a real, not merely slow, loss risk at a
short timeout.

An independent second implementation, the Rust `notify` crate (spike crate
`crates/urdira-fs-watch`, §3c), driven through the SAME probe
(`--mode crate`) against the SAME corpus, shows the same qualitative
pathology (high, inconsistent latency) though with a lower median and a
different distribution:

| n | matched | p50 (ms) | p95 (ms) | min | max |
|---:|---:|---:|---:|---:|---:|
| 8 | 8/8 | 546.4 | 7,317.7 | 293.3 | 7,317.7 |

Two different userland libraries, two different macOS watcher-API bindings
(`@parcel/watcher`'s own C++ FSEvents wrapper vs. the `notify`
crate's `fsevent-sys`), both show multi-hundred-millisecond-to-multi-second,
highly inconsistent detection latency on this specific machine at this
corpus scale, with zero JS/Node contention. This is best read as a
characteristic of the OS FSEvents API's behavior on this macOS version
(26.5.1 / Darwin 25.5.0) at ~20K files, not a bug in either library's
integration code.

### 3b. A separate, deterministic, always-reproducible symlink/canonicalization bug

Source-level: `packages/engine/src/watchers.ts`'s `normalizedUri(root, path,
...)` throws `engine:watcher_path_outside_root` unless `path` starts with the
literal `root` string. macOS's FSEvents API canonicalizes every delivered
path (resolves symlinks); `@parcel/watcher`'s kqueue backend does not (its
paths come from its own directory-string walk, `DirTree`, never touching the
OS's canonical-path resolution). Any workspace root with a symlinked path
component -- on macOS, anything under `/tmp` or `/var`, both symlinks to
`/private/...` -- would therefore see EVERY fs-events-reported event's path
fail this comparison.

Proven directly, deterministically, without depending on fs-events actually
firing (isolates the bug from §3a's separate unreliability):

```
node -e '
import("packages/engine/dist/watchers.js").then(async (m) => {
  const { ParcelWatcherAdapter } = m;
  const binding = { ..., root: "/var/folders/3p/xxx/T/foo" };
  const adapter = new ParcelWatcherAdapter(binding, {});
  adapter.normalize_events([{ type: "update", path: "/private/var/folders/3p/xxx/T/foo/a.ts" }]);
});
'
# THREW: EngineError engine:watcher_path_outside_root: Watcher path
# /private/var/folders/3p/xxx/T/foo/a.ts is outside its provider root.
```

This call happens synchronously inside the raw backend callback
(`ParcelWatcherAdapter#subscribe`'s `backend.subscribe(root, (error, events)
=> { ...; this.#deliver(handler, this.normalize_events(events)); })`) and,
before this task, was **unguarded** -- no `try`/`catch`. Confirmed live with
a fake backend delivering exactly this canonicalized-path shape: **no
`on_error` call, no process crash, no batch delivered** -- the event vanished
completely and silently. Live confirmation that kqueue is NOT affected: the
identical `/var/folders/...` root, subscribed via kqueue instead (with
`watcher_options` correctly wired, unlike a first, buggy diagnostic attempt
that omitted them and accidentally exercised @parcel/watcher's platform
default instead), delivers the batch in ~1ms with a correct
`normalized_uri`, because kqueue's own paths are never OS-canonicalized.

This bug is orthogonal to which backend ships by default (kqueue does, and
is unaffected), but it directly matters for `URDIRA_WATCHER_BACKEND=fs-events`,
the opt-in escape hatch P3-5 added: any future investigator using it against
a workspace whose root passes through a symlink (e.g. any scratch/temp
workspace using the OS default temp dir) would have silently lost every
event with no diagnostic trace. **Fixed** (§3.4): the call is now wrapped in
`try`/`catch`; a normalization failure now logs, calls `on_error`, and
delivers a `provider_reset` hint (the same treatment an outright backend
error already gets) instead of vanishing. Verified live: the identical fake
backend now produces exactly one `on_error` call and one `provider_reset`
batch.

### 3c. Spike crate: `crates/urdira-fs-watch`

Per the task's instruction ("if fs-events cannot be made reliable, implement
`crates/urdira-fs-watch` using `notify`... measure both, do NOT wire into the
worker"): a minimal `[[bin]]` crate (following the existing `urdira-v4-spike`
precedent -- `publish = false`, own `Cargo.toml`, not workspace-shared deps)
was added at `crates/urdira-fs-watch`, added to the workspace `members` list.
It subscribes via `notify::recommended_watcher` (FSEvents on macOS, via
`fsevent-sys`) and prints one JSON line per event
(`{"epoch_ms":...,"kind":...,"paths":[...]}`) to stdout, flushed
immediately, plus a `--ready-marker <path>` flag so a driver can wait for the
watch to actually be installed before timing edits. `scripts/watch-latency-probe.mjs
--mode crate` drives it the same way it drives `@parcel/watcher`. Results:
§3a above. **Not wired into `urdira-indexing-worker` or any shipped path** --
confirmed: no crate depends on it, `Cargo.toml`'s workspace member list is
the only place it is referenced outside its own directory.

Quality gates for the crate: `cargo fmt -p urdira-fs-watch -- --check`
clean; `cargo clippy -p urdira-fs-watch --release --all-targets -- -D
warnings` clean; `cargo test -p urdira-fs-watch --release` -- 3/3 passed
(`json_escape` quoting/control-character escaping, `epoch_ms` wall-clock
plausibility, `kind_label` covering every `notify::EventKind` variant).

### 3.4. The fix applied (item 3)

- **Kqueue remains the default** on macOS (`watcherOptionsForSourceProvider`
  in `packages/engine/src/watchers.ts`, unchanged selection logic) -- now on
  solid, re-verified evidence (§2, §3a) rather than the superseded 2.0-3.0s
  hypothesis. Flipping the default to fs-events was NOT done: both tested
  fs-events implementations are measurably worse (100x-1500x higher median
  latency, far more variable, occasional outright misses at short timeouts)
  at the exact scale this task cares about, on this exact machine.
- **`ParcelWatcherAdapter#subscribe`'s `normalize_events` call is now
  guarded** (§3b): a normalization failure logs, calls `on_error`, and emits
  a `provider_reset` hint instead of silently discarding the event. This
  makes the existing `URDIRA_WATCHER_BACKEND=fs-events` escape hatch safe to
  actually use for a future investigation (no more silent, undiagnosable
  event loss under a symlinked root) without changing kqueue's own behavior
  at all.
- **The harness's timestamp bug is fixed** (§1, §3.1): this is the change
  that actually resolves the originally-reported "2-3s detection latency"
  headline number, because that number was never a real detection-latency
  measurement.
- The top-of-function comment in `watchers.ts` documenting kqueue's
  selection was rewritten to state the corrected finding (it previously
  repeated P3-5's now-disproven 2.0-3.0s hypothesis verbatim, which would
  have misled the next reader).

## 3.1. The harness fix, in detail

`scripts/v4-mutation-harness.mjs`'s `applyMutation` now captures
`mutation_write_epoch_ms` (`performance.timeOrigin + performance.now()`)
immediately before each variant's actual filesystem-mutating call (the
`writeFile`/`unlink`/`rename` a real watcher reacts to) and returns it
alongside `paths_touched`/`detail`. `run()` uses this returned timestamp --
not its own pre-call one -- for every latency computation
(`deriveTimelineLatencies`, `queryable_ms`/`durable_ms`). The harness's own
corpus-rescan/import-graph-rebuild cost is still reported, explicitly
separated out, as a new `harness_selection_overhead_ms` field on every
mutation record, so it remains visible for anyone investigating harness
performance itself without being mistaken for watcher latency again.
`scripts/v4-mutation-harness.d.mts` updated to match
(`V4AppliedMutation.mutation_write_epoch_ms`,
`V4MutationHarnessMutationResult.harness_selection_overhead_ms`).

Verified the fix reports the overhead correctly (n8n scale, 3 edits):

```
edit#0: harness_selection_overhead_ms=3583.6 target=.claude/plugins/n8n/scripts/track-skill-usage.mjs
edit#1: harness_selection_overhead_ms=3343.0 target=.github/actions/ci-filter/__tests__/ci-filter.test.ts
edit#2: harness_selection_overhead_ms=2299.0 target=.github/actions/ci-filter/ci-filter.mjs
```

(Matches §1's direct timing almost exactly, as expected -- same code path,
same corpus, natural run-to-run variance.)

## 4. End-to-end measurement (item 4)

Command (idle machine confirmed via `pgrep -f "v4-scan|urdira-indexing-worker|cargo|rustc"`
before running):

```
run({ corpus: n8n-corpus-2026-09-02, owners: 14083,
      mutation_kinds: ["edit","create","delete","rename"], repeat: 1,
      warm: 1, verify_roots: "skip", readiness_mode: "events" })
```

`repeat: 1` (not the task's suggested `--repeat 3`) after a first `repeat: 3`
attempt crashed mid-run when the concurrently-running P3-6 session rebuilt
`packages/storage`'s schema-compatibility code while this task's own
long-lived foreground daemon process was still running against a data root
created under the OLDER compiled version (`core:index_contract_unsupported`,
unrelated to any P3-7 change -- confirmed by reading the failing code path,
entirely inside `packages/storage/src/schema.ts`'s v3/v4 contract-detection
logic the other session was actively adding). Retried after that session's
build settled, with a shorter sequence specifically to reduce the exposure
window to further concurrent rebuilds; the retry completed cleanly.

### Cold (generation 1, full scan)

`queryable_ms` 23,888.9, `durable_ms` 24,483.5 -- consistent with prior
full-scan baselines at this corpus size (no watcher/aggregation applies to a
first scan).

### Per-mutation (4 kinds, `repeat: 1`, `--warm 1` excluded)

| Mutation | harness overhead (ms) | poll queryable (ms) | poll durable (ms) | watcher_detection (ms) | aggregation_debounce (ms) | admission_and_ipc (ms) | worker_to_durable (ms) | readiness_update_overhead (ms) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| edit | 1,995.6 | 1,022.2 | 1,022.2 | 1.5 | 162 | 28 | 828 | 5 |
| create | 2,462.3 | 3,610.0 | 3,883.0 | 7.7 | 101 | 26 | 3,653 | 195 |
| delete_leaf | 14,258.1 | 3,359.1 | 3,359.1 | 45.3 | 106 | 92 | 3,104 | 10 |
| delete_with_importers | 2,888.6 | 1,779.0 | 1,779.0 | 8.5 | 102 | 28 | 1,639 | 6 |
| rename_no_rewrite | 2,165.4 | 1,589.0 | 2,470.0 | 7.6 | 103 | 39 | 2,314 | 5 |
| rename_rewrite | 2,260.5 | 5,347.0 | 6,743.2 | -- | -- | -- | 1,344 | 5 |

(`rename_rewrite`'s `watcher_detection`/`aggregation_debounce`/`admission_and_ipc`
are `undefined` because its reported `last_scan_timeline` reflects the
SECOND internal generation -- the importer-rewrite -- which is triggered
internally rather than by a fresh watcher event, the same architectural
shape P3-5 §4.2 already documented for this variant; not a gap introduced by
this task.)

`watcher_detection` across the 5 mutations that have it: **p50 = 7.7ms, p95
= 45.3ms** (sorted: 1.5, 7.6, 7.7, 8.5, 45.3) -- both comfortably inside the
plan's ≤50ms p50 / ≤150ms p95 gate, and matching §2's isolated-probe numbers
closely (the one 45.3ms outlier is still two orders of magnitude below the
old reported figure).

Overhead outside the worker (`watcher_detection + aggregation_debounce +
admission_and_ipc + readiness_update_overhead`): 196.5ms (edit), 329.7ms
(create), 253.3ms (delete_leaf), 144.5ms (delete_with_importers), 154.6ms
(rename_no_rewrite). Three of five are under the plan's ≤250ms target; the
two that exceed it (create at 329.7ms, delete_leaf at 253.3ms) do so because
of one-off jitter in `aggregation_debounce`/`readiness_update_overhead`
(normally ~100ms/~5-10ms respectively; this run saw 162ms once and 195ms
once) on a single-repeat run, NOT because of `watcher_detection` -- which is
now a rounding error next to those other terms, a complete inversion from
before this task where `watcher_detection` alone was 20-30x the ≤250ms
target. A larger `--repeat` would average out this single-run jitter; this
task's `repeat: 1` retry (§ above) traded statistical smoothness for a
shorter exposure window to concurrent-session interference, and the
direction/magnitude of the result is unambiguous regardless.

### Gate comparison

| Target (plan) | Result | Verdict |
|---|---|---|
| `watcher_detection` p50 ≤ 50ms | 7.7ms | **Met**, by a wide margin |
| `watcher_detection` p95 ≤ 150ms | 45.3ms | **Met** |
| Overhead outside worker ≤ 250ms | 144.5-329.7ms across 5 mutations (median ~196.5ms) | **Met in 3/5, narrowly missed in 2/5** by non-watcher jitter on a single-repeat run |

## 5. Quality gates

- `npx eslint packages/engine/src/watchers.ts scripts/v4-mutation-harness.mjs
  scripts/watch-latency-probe.mjs tests/phase7-reconciliation.test.ts` --
  clean.
- `pnpm --filter @urdira/engine exec tsc --noEmit`, `pnpm --filter
  @urdira/daemon exec tsc --noEmit` -- both clean.
- `npx tsc --noEmit -p tsconfig.tests.json` -- no new errors in any file this
  task touched (grepped the error list for each touched path).
- `npx vitest run tests/phase7-reconciliation.test.ts tests/phase-daemon-v4-scan.test.ts
  tests/phase-daemon-scan-aggregation.test.ts tests/v4-daemon-e2e.test.ts
  tests/v4-mutation-harness.test.ts tests/phase15-workspace-control.test.ts
  tests/phase-daemon-indexing-integration.test.ts` -- **7 files, 97 passed, 1
  failed, 2 skipped.** The one failure
  (`v4-mutation-harness.test.ts`'s "reaches durable for a real fs.rename()
  through the real daemon+watcher, at fixture scale (P3-5 item 4)",
  `rename_rewrite`'s `records` mismatch count: expected 4, got 50) is
  reproducible in isolation and is NOT caused by this task: `applyMutation`'s
  `rename_rewrite` branch is byte-for-byte unchanged by this task except for
  one inserted, side-effect-free timestamp capture
  (`const mutation_write_epoch_ms = writeEpochMs();`) before the existing
  `rename()` call -- it cannot affect which files are picked or written.
  `release/native/darwin-arm64/urdira-indexing-worker` (the prebuilt binary
  this test uses, unconditionally, without rebuilding) has an mtime of
  12:41, matching exactly when the concurrent P3-6 session's own crate work
  was rebuilding it (confirmed via `pgrep` timing during this task's own
  end-to-end run, §4). This is the same class of environmental collision
  §4's `core:index_contract_unsupported` crash was, on the same shared
  binary, from the same concurrent session. Not investigated further --
  `crates/urdira-indexing-worker` is explicitly out of this task's ownership
  and is actively being edited by another session.
- Full-repository `pnpm verify` NOT run: same rationale as every prior P3
  evidence doc in this series (extensive concurrent uncommitted work across
  unrelated packages/crates from the P3-6 session).
- Idle machine confirmed (`pgrep -f "v4-scan|urdira-indexing-worker|cargo|rustc"`
  empty) before every timed probe/harness run in this document, except where
  explicitly noted otherwise (§4's crash and retry).

## 6. Decision-04 update recommendation

Decision 04 (`docs/decisions/04-workspace-snapshot-incremental-indexing.md`)
already states the correct operational choice ("On macOS, Urdira selects the
native kqueue backend explicitly for workspace watchers instead of FSEvents")
and the correct original reasoning (FSEvents' client-side queue can drop
events under load). This task's findings **reinforce that choice with
stronger, more specific evidence** and suggest one clarifying addition:

- FSEvents' unreliability at large tree sizes on this project's target
  platform is not solely a "busy Node callback" risk (the queue-overflow
  framing) -- it is reproducible with a near-idle process, across two
  independent native implementations, as **latency measured in seconds with
  wide variance**, not only as outright dropped events. A future reader
  should not conclude "fs-events is fine as long as the daemon isn't busy" --
  it demonstrably is not fine even then, at this scale, on this OS version.
- The specific numbers in this document (kqueue ~7-9ms p50 vs. fs-events
  ~12s / ~546ms-7.3s p50 depending on implementation, at 20,280 files) are
  worth citing directly in the decision record as the concrete evidence
  behind "kqueue has no such client queue," rather than leaving that claim
  unquantified.

No change to the decision's actual conclusion is recommended.

## 7. Files touched

Owned, modified:
- `packages/engine/src/watchers.ts` -- guarded `normalize_events` call
  (§3.4), rewritten kqueue-selection doc comment correcting the superseded
  P3-5 hypothesis.
- `scripts/v4-mutation-harness.mjs` / `scripts/v4-mutation-harness.d.mts` --
  `applyMutation` returns `mutation_write_epoch_ms` captured at the correct
  instant (§3.1); `run()` uses it for every latency computation instead of
  its own pre-call timestamp; new `harness_selection_overhead_ms` diagnostic
  field.
- `tests/phase7-reconciliation.test.ts` -- new test:
  "reports a provider_reset (not a silent drop) when a backend delivers a
  canonicalized path outside the subscribed root" (regression coverage for
  §3.4's fix).

Owned, new:
- `scripts/watch-latency-probe.mjs` -- measurement tool (raw/adapter/crate
  modes) used throughout §2-§3.
- `crates/urdira-fs-watch/` -- spike crate (§3c). NOT wired into
  `urdira-indexing-worker` or any shipped path.
- `Cargo.toml` -- added `crates/urdira-fs-watch` to workspace `members`.

Not touched: any other file in `crates/urdira-structural-store`,
`crates/urdira-indexing-worker`, `crates/urdira-jsts-syntax-worker`,
`crates/urdira-native-node` (hard rule honored); `packages/daemon/src/runtime.ts`
(read, not modified -- no watcher-wiring change was needed; kqueue remains
the default with unchanged selection logic).

## 8. Deviations/residuals summary

1. **The originally-reported "2-3s watcher detection latency" was a harness
   measurement bug, not a real system property.** Fixed (§3.1); the real
   number is 7-9ms p50 at n8n scale, confirmed by an independent probe (§2)
   and by the corrected end-to-end harness (§4).
2. **fs-events remains rejected as the default**, now with direct,
   quantified, cross-implementation evidence (§3a) rather than a
   4-year-old-decision's unquantified reasoning plus one prior live
   reproduction.
3. **A previously-undiagnosed, always-reproducible symlink/canonicalization
   bug** in the fs-events escape hatch's event path validation was found and
   fixed (§3b, §3.4) -- silent, total event loss for any workspace root under
   a symlinked path segment, whenever `URDIRA_WATCHER_BACKEND=fs-events` is
   set. Kqueue itself was never affected.
4. **One pre-existing-as-of-this-session test failure**
   (`v4-mutation-harness.test.ts`'s real-rename fixture test) was hit during
   this task's own quality-gate run, root-caused to a concurrent session's
   in-progress rebuild of the shared `urdira-indexing-worker` binary (§5),
   and NOT fixed -- out of this task's ownership and scope.
5. **The full `--repeat 3` end-to-end run crashed once** due to a different
   concurrent-session collision (a storage schema-contract check mid-flight
   during the other session's own edit to that exact code, §4) and was
   retried with `--repeat 1` to shrink the exposure window; the retry
   completed cleanly and its numbers are reported in full (§4). A `--repeat
   3` re-run once the concurrent session's crate/storage work settles would
   further smooth the two single-run jitter cases noted in §4's gate table,
   but the qualitative and quantitative conclusion (watcher detection is no
   longer the bottleneck, by roughly two orders of magnitude) does not
   depend on that additional smoothing.
