# E.6: reconcile delta/cold threshold, measured on n8n

Implements task E.6 of plan `generic-waddling-hartmanis.md` §2.6 (ola 3, "medición del umbral
T"). Base: `main` at `81e78b1` (Frente E + E-fix merged: `ScanScope::Reconcile`, `run_reconcile`,
`URDIRA_V4_RECONCILE_THRESHOLD`, content-hash equivalence with `metadata_refreshed`). Worked
without isolation on main, per task instructions. Machine: macOS arm64, release
`urdira-indexing-worker` binary built from this exact `main`. Shared corpus
`~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02` was never written to -- every mutation landed
on a fresh scratch copy under `~/Proyectos/urdira-benchmark/v4-fold/e6-*/`, all deleted at the end
of this session (only logs and the two JSON result files are retained, under
`~/Proyectos/urdira-benchmark/v4-fold/e6-logs/` and `v4-fold/e6-{threshold,git-switch}-results.json`).

Load guard: `uptime` checked (Node `os.loadavg()[0]`, the 1-minute average) before every timed
scan; the harness retries every 15s, up to 20 times, whenever it reads above 6. The machine carried
real background load for most of this session (a browser session, per the task's own warning) --
`uptime` readings of 5-9 (1-min) were common and are logged verbatim in
`v4-fold/e6-logs/{threshold-sweep,git-switch}.log`; every timed cell either started under 6 or
proceeded after the stated retry budget, logged either way.

## 1. Script: `scripts/v4-reconcile-threshold.mjs`

Two modes, one file:

- **Fraction sweep** (the documented contract): `node scripts/v4-reconcile-threshold.mjs --corpus
  <dir> --data <dir> --fractions 0.01,0.05,0.10,0.25,0.50 --repeat 2 --out <json>`.
- **Git-switch**: `node scripts/v4-reconcile-threshold.mjs --git-switch --git-repo <dir> --data
  <scratch dir> --git-tag-a <tag> --git-tag-b <tag> --git-head-back <n> --out <json>`.

Reuses the pattern of `scripts/v4-mutation-harness.mjs` (scratch-copy of the read-only corpus,
guarded by the `.urdira-shared-corpus-readonly` sentinel) and `scripts/v4-scan.mjs` (schema init +
`runRustWorkspaceScan` against the release worker). Per fraction `p`: mutate
`ceil(p * frontier_size)` eligible TS/JS files with a seeded, deterministic 90%-edit/10%-delete-or-rename
plan, then run `workspace_scan{scope: {kind: "reconcile"}}` twice on independent fresh copies --
once with `URDIRA_V4_RECONCILE_THRESHOLD=1.0` (forces `Delta`: `touched <= T * frontier_size` is
always true at T=1) and once with `=0.0` (forces `Cold`: only `touched == 0` short-circuits to
`Noop` before the threshold check even runs, so T=0 makes every `touched > 0` case take `Cold`).
A from-scratch "oracle" full scan of the identically-mutated tree provides the roots to check both
branches against.

### 1.1 Required infra fix: `URDIRA_V4_RECONCILE_THRESHOLD` was never forwarded to the worker process

`packages/plugin-javascript-typescript/src/indexing-core-process-transport.ts`'s child-process spawn
only forwarded an explicit allowlist of env vars (`URDIRA_DEBUG_TIMING`, the F5 hybrid-lane
variables, `URDIRA_JSTS_TYPEFLOW*`, `URDIRA_V4_RESIDUAL`, `URDIRA_TSGO_BINARY`) --
`URDIRA_V4_RECONCILE_THRESHOLD` was not on it, so setting it on the calling Node process had zero
effect on the spawned worker. Added one more forward-only-when-set line (same convention as the
others), rebuilt `packages/plugin-javascript-typescript`'s `dist/`. This is a real, load-bearing fix:
without it every "forced Cold" and "forced Delta" cell in this measurement would have silently run
at the SAME (default) threshold.

### 1.2 Required methodology fix: cold-scan and reconcile must share ONE warm worker process

First attempt copied a template's already-cold-scanned data directory (SQLite + structural + CAS)
into each cell's own directory, then reconciled from a FRESH worker process. Result: `Delta` at just
p=0.01 (202/20,148 files) measured 21.6s -- almost identical to `Cold`'s 20.6s on the SAME
mutation. Root cause, found by reading `crates/urdira-indexing-worker/src/v4/delta.rs` (lines
~610-693) and `analyze.rs::run_cold`'s own doc comments: `WorkspaceState.source_cache`/
`typeflow_cache` are built via `build_full` (an O(corpus) pass) exactly once per **process**, either
by the first `Full` scan (which then seeds them for that SAME process's later incrementals) or by
the first incremental request a process ever sees for a workspace. A harness that cold-scans in one
process and reconciles from a freshly-spawned second process pays `build_full` again INSIDE the
timed `Delta` call every single time -- inflating it to Cold-scale regardless of how small the
actual delta is. Fixed by making every fraction/repeat cell do "cold-scan the (unmutated) copy, THEN
mutate, THEN reconcile" on **one** worker process (`runColdThenReconcile`/`runOneGitSwitchCycle` in
the script) -- exactly what the pre-existing Rust test `reconcile_batches_match_cold_at_1_5_10_25_50_percent`
already does (shared `syntax`/`state` across `run_scan` and `run_reconcile_scan` in one test body).
After the fix, `Delta` at p=0.01 separated cleanly from `Cold` (§2's table) and the crossover became
measurable.

## 2. Fraction sweep results (n8n corpus, 20,148-file frontier, 14,046 eligible TS/JS files)

Command:
```
node scripts/v4-reconcile-threshold.mjs \
  --corpus ~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02 \
  --data ~/Proyectos/urdira-benchmark/v4-fold/e6-threshold \
  --fractions 0.01,0.05,0.10,0.25,0.50 --repeat 2 \
  --out ~/Proyectos/urdira-benchmark/v4-fold/e6-threshold-results.json
```
Log: `v4-fold/e6-logs/threshold-sweep.log`. Result JSON retained at
`v4-fold/e6-threshold-results.json`. `uptime` at launch: `load averages: 4.30 5.10 5.88` (clean); the
run itself hit the >6 retry path repeatedly as background load rose through the evening (all logged).

| p (fraction) | n (touched) | n/frontier | delta_wall | cold_wall | ratio | roots_ok (delta / cold) |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 0 (noop) | 0 | 0.0000 | 1.02s | 1.00s | 1.02 | all match / all match |
| 0.01 | 202 | 0.0100 | 20.82s | 22.21s | 0.94 | records=✗ dep=✗ graph=✓ / all match |
| 0.05 | 1,008 | 0.0500 | 29.12s | 21.83s | 1.33 | records=✗ dep=✗ graph=✗ / all match |
| 0.10 | 2,015 | 0.1000 | 36.86s | 23.87s | 1.54 | records=✗ dep=✗ graph=✗ / all match |
| 0.25 | 5,037 | 0.2500 | 55.66s | 21.34s | 2.61 | records=✗ dep=✗ graph=✗ / all match |
| 0.50 | 10,074 | 0.5000 | 97.70s | 23.23s | 4.21 | records=✗ dep=✗ graph=✗ / all match |

Each cell is a median of 2 repeats. `added`/`changed`/`deleted` reported by `Delta` and `Cold`
matched exactly for every fraction (both branches diff the SAME authoritative enumeration -- e.g.
p=0.05: `added=50 changed=908 deleted=100` on both). `cold_wall` stays flat (~21-24s, it always
reprocesses the whole frontier); `delta_wall` grows roughly linearly with `p`. `fell_back_to_cold`
was `false` for every fraction cell (the synthetic mutations never triggered R2 -- contrast with §4).

**Crossover**: linear interpolation between the p=0.01 (`ratio=0.94`, delta below cold) and p=0.05
(`ratio=1.33`, delta above cold) cells gives crossover **p≈0.0164**. `T = 0.0164 * 0.8 = 0.0131`,
rounded to 2 decimals: **T = 0.01**.

## 3. Roots: a real gap, already documented, now more fully characterized (not fixed here)

`Cold`-forced reconciles matched the from-scratch oracle on all three roots (`records`,
`dependency`, `graph`) at every fraction -- expected, `run_full_from` has no scope-narrowing.

`Delta`-forced reconciles diverged starting at p=0.01 (`records`/`dependency` only) and at p=0.05
and above (`records`/`dependency`/`graph` all three). This is NOT a fresh bug: `delta.rs`'s own
module-level doc comment ("Documented scope narrowing versus the plan's exact wording") already
states that dependency rows are diffed at OWNER granularity (every touched/deleted owner's previous
rows closed and its fresh ones opened unconditionally, never by `dependency_id`), so an edge's
`valid_from` "churns every time its OWNING file ... is edited" even when the edge itself is
semantically unchanged -- a from-scratch oracle (one generation, no churn history) necessarily
assigns different `valid_from` stamps than an incrementally-churned store, changing the `dependency`
Merkle root with no semantic difference. `publish.rs` builds `graph_entries` FROM the records/
relations set it is handed (`records.iter()...` at both the cold and delta publish call sites, not
an independently-maintained structure) -- so any owner `delta::run`'s closure-bounded diff misses
updating (e.g. an untouched owner holding a relation INTO a deleted/renamed identity, several hops
outside the immediate touched set) can propagate a stale `dependency` row into a stale `graph`
Merkle entry too. The existing single-kind, small-scale tests
(`reconcile_{delete,rename}_roots_match_a_from_scratch_scan_of_the_mutated_tree`) never exercised
enough files at once to hit this; n8n's real-scale mixed batches (50-500+ deletes/renames) do,
starting around p=0.05.

**Flagged as a P0 follow-up** (not this task's to fix -- `delta.rs`'s own comment already defers
"tightening dependency identity" to "whichever task next"): extend that future task's scope to
cover `graph`, not just `dependency`/`records`, and add a large-mixed-batch regression test at n8n
scale (the existing single-kind tests at fixture scale do not catch this).

## 4. Two real git switches

Command:
```
node scripts/v4-reconcile-threshold.mjs --git-switch \
  --git-repo ~/Proyectos/n8n --data ~/Proyectos/urdira-benchmark/v4-fold/e6-git-switch \
  --git-tag-a n8n@1.123.25 --git-tag-b n8n@1.123.56 --git-head-back 200 \
  --out ~/Proyectos/urdira-benchmark/v4-fold/e6-git-switch-results.json
```
Log: `v4-fold/e6-logs/git-switch.log`. `~/Proyectos/n8n` itself was never touched -- every switch
clones it (`git clone --no-hardlinks`) into a scratch directory under `--data`, deleted after each
switch. `uptime` at launch: `load averages: 6.86 6.29 6.59` (retried per the >6 rule until it
cleared, logged).

Two real tag-to-tag/commit-to-commit diffs on the actual n8n `master` history (not synthetic
mutations):

| switch | ref A | ref B | changed files (git diff) | `cold@A` wall | `reconcile(T=1)` wall | `reconcile(T=0)` wall | mode (both) |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| tags, ~3 months apart | `n8n@1.123.25` (2026-03-13) | `n8n@1.123.56` (2026-06-15) | 504 | 12.29s | 11.80s | 11.40s | `cold` (fallback) |
| `HEAD~200`..`HEAD` | `b3a34fc~200` | `b3a34fc` | 1,971 | 25.03s | 23.99s | 23.09s | `cold` (fallback) |

Both `T=1` (forced-`Delta`-attempt) cells came back with `mode=cold` and `fell_back_to_cold=true`
in the `ReconcileSummary` -- R2's same-request cold fallback, not this measurement forcing `Cold`.
Reproduced in isolation with `URDIRA_DEBUG_TIMING=1` (repro script, deleted after use, not
committed): the worker's own stderr shows

```
[urdira-indexing-worker] v4 delta: mixed burst split into two generations: ...
[urdira-indexing-worker] v4 reconcile: delta failed: v4 syntax analysis failed: changed artifact id
is absent from the current and retained manifests: sha256:025adba8fce314f8dc42fcdeda8621e2f5c00983d32da1b6a14216f155e97abe;
falling back to cold
```

**Second P0 finding**: `delta::run`'s "mixed burst split into two generations" path (`delta.rs`
lines ~332-408, for a batch that mixes structural changes -- creates/deletes/renames -- with plain
content edits) errors outright on BOTH real git diffs tested here, every time, with a manifest
lookup failure ("changed artifact id is absent from the current and retained manifests"). R2's
same-request fallback caught it correctly both times (`fell_back_to_cold=true`, exactly one new
generation published, no partial state) -- so this is a robustness/performance gap, not a data-loss
one, but it means `Delta` currently never actually completes for a realistic git-history diff at
this scale on n8n; every real branch-switch this session tried took the cold fallback path,
1-4% slower than going straight to `Cold` (the forced-`Delta`-attempt-then-fallback wall vs. the
forced-`Cold` wall: 11.80s vs 11.40s, and 23.99s vs 23.09s). **Flagged as a P0 follow-up**,
separate from §3's root-drift finding -- both live in `delta.rs`, neither fixed by this measurement
task. A T this low (§2) means these two gaps are rarely exercised in practice (git switches
routinely touch well over 1.6% of a repo's frontier), which is itself part of why T=0.01 is the
right call, not just the mechanically-computed one.

**Key figures requested by the task**: a `git pull` with zero changes (`p=0` in §2) costs **~1.0s**
on this corpus (both branches, genuinely the same `Noop` code path) -- vs. the ~24-25s cold scan
this corpus took before Frente E existed. A small real switch (`HEAD~200..HEAD`, 1,971 changed
files, ~9.8% of the frontier) still routes to `Cold` at **~23-24s** either way (the two P0 findings
above are why `Delta` cannot yet do better here even though this fraction is comfortably below
T=0.01's own crossover evidence at p=0.05+); a 3-months-apart tag switch (504 changed files, ~2.5%
of that era's smaller frontier) costs **~11.4-12.3s**.

## 5. T decision

Per plan §0 R1: `T = crossover_p * 0.8`, rounded to 2 decimals, capped at 0.50 if delta never
catches up to cold by p=0.50. Crossover was found (§2), giving **T = 0.01**.

This is below the `[0.05, 0.50]` sanity range this task's own instructions anticipated when they
asked for a unit test asserting that range. Decided here, per plan criteria (a) "mejor rendimiento
que no comprometa la integridad de los datos" and (b) "fidelidad por delante de milisegundos": use
the MEASURED value (0.01), not a value forced into the anticipated range, and widen the unit test's
asserted range to `[0.01, 0.50]` instead (`0.01` is the smallest fraction plan §2.6 ever measures --
a T below that has no measured support; `0.50` is R1's own explicit cap). R1's formula has no floor,
only the 0.50 cap for a delta that never catches up -- there is no textual basis for a 0.05 floor,
and a LOWER T is also the objectively safer choice here: it keeps reconcile on the always-correct
`Cold` path for anything past a near-trivial delta, which is exactly the region where §3 and §4
found two real correctness/robustness gaps in the merged `Delta`/R2 pipeline. Recorded here as
"decided in implementation" per the plan's own instruction for an unlisted bifurcation.

## 6. Changes

- `packages/plugin-javascript-typescript/src/indexing-core-process-transport.ts`: forward
  `URDIRA_V4_RECONCILE_THRESHOLD` to the spawned worker (forward-only-when-set, same convention as
  the other Rust-side flags already there). Rebuilt `dist/`.
- `scripts/v4-reconcile-threshold.mjs` (new): the measurement harness, §1.
- `crates/urdira-indexing-worker/src/v4/scan.rs`: `RECONCILE_DELTA_THRESHOLD` 0.25 → **0.01**, doc
  comment carries the full measured table + both P0 findings + the decision rationale.
- `crates/urdira-indexing-worker/src/v4/tests_e2e.rs`:
  - new `reconcile_delta_threshold_is_within_measured_bounds` (asserts the constant stays in
    `[0.01, 0.50]`).
  - `reconcile_delta_mode_also_persists_metadata_refresh_for_untouched_uris` was coupled to the
    OLD default (asserted "1 edit out of >=4 files stays under the default threshold" -- true at
    0.25, false at 0.01). Fixed to force `threshold=1.0` explicitly for both its reconcile calls
    (matching how every other explicit-threshold e2e test in this file already works), since this
    test's actual purpose is Delta-mode metadata-refresh persistence, not the default constant's
    magnitude.

## 7. Verification

```
cargo fmt --all -- --check                                    # clean
cargo build --release --locked -p urdira-indexing-worker      # clean, 12.23s
cargo test -p urdira-indexing-worker --locked reconcile        # 13 passed; 0 failed; 33.93s
cargo clippy --workspace --all-targets --locked -- -D warnings # clean, 23.62s
cargo build --release --locked                                 # clean, full workspace, 26.14s
```
Logs retained: `v4-fold/e6-logs/{build,rebuild,test-reconcile,test-reconcile2,clippy,full-release-build,threshold-sweep,git-switch}.log`.

`pnpm --filter @urdira/plugin-javascript-typescript build` run after the transport-env-var fix
(clean, `tsc --build`); `npx eslint scripts/v4-reconcile-threshold.mjs` clean.

## 8. Scratch cleanup

`~/Proyectos/urdira-benchmark/v4-fold/e6-threshold/` (fraction-sweep scratch: template + per-cell
workspace/data copies) deleted by the script itself at the end of its run (verified empty, then
`rmdir`ed). `~/Proyectos/urdira-benchmark/v4-fold/e6-git-switch/` (git clones + data dirs) and the
`URDIRA_DEBUG_TIMING=1` repro directory deleted manually after use. Retained: the two logs
directories' files and `v4-fold/e6-{threshold,git-switch}-results.json`.

## 9. Frente E-P0 (2026-09-06): P0-1 root cause found and fixed; P0-2 diagnosed, unresolved

Base: `main` at `47e96a2` (this file's own commit). Branch `frente-ep0-delta-parity`. Per plan §0
("integridad por delante del rendimiento"), this session prioritized diagnosing and fixing the
REAL correctness gap (P0-1: silent data loss in `dependency`) over the robustness/performance gap
(P0-2: R2 already falls back safely, no data loss) when both could not be fully closed in one
session -- see §9.4 for why P0-2 stays open.

### 9.1 Tooling: `scripts/v4-reconcile-threshold.mjs --files N` / `--keep-data`

Added two flags to the existing harness (task 1a's own request), reusing the SAME seeded
`buildMutationPlan` the fraction sweep already uses (so `--files 202` replays p=0.01's exact plan
byte-for-byte): `--files N` runs ONE cell with `touchedCount=N` directly (bypasses the
`fractions × frontier_size` arithmetic, useful for bisection); `--keep-data` skips the normal
per-cell `rm` cleanup so the resulting delta/cold/oracle workspace+data directories survive for
inspection with `tests_e2e.rs`'s `dump_dependency_set_diff`/`dump_records_set_diff` (or an ad hoc
extension of them) after the harness exits.

### 9.2 P0-1 root cause: `dependency_id` is a reusable key, but `Segment::deps_effective_valid_to` treats it as if it were chained like `record_id`

**Reproduced** with `--files 100` on the n8n corpus (202/20,148 ≈ 1%, same order as E.6's own
p=0.01 cell): `roots_ok.delta = {records: false, dependency: false, graph: true}` against an
independent oracle. Diagnosed with `dump_dependency_set_diff` (added a temporary `#[ignore]` test,
removed before commit, reading the harness's `--keep-data` output directly): **incremental had
20,569 of the oracle's 35,504 live dependency edges -- 0 edges present only in the incremental
store, 14,935 present only in the oracle.** A one-directional, only-ever-loses gap (never a
phantom extra edge), which rules out a chaining/duplication bug and points at a visibility bug that
can only ever hide rows.

**Mechanism** (`crates/urdira-indexing-worker/src/v4/delta.rs`, `diff_one_owner`'s pre-fix
dependency handling; `crates/urdira-structural-store/src/reader.rs::Segment::deps_effective_valid_to`):
`delta.rs`'s own pre-existing module doc already documented that dependency rows were diffed at
OWNER granularity, not by `dependency_id` -- "every affected/deleted owner's PREVIOUS dependency
rows are closed unconditionally and its freshly materialized ones opened unconditionally", framed
as a cost-neutral simplification ("valid_from churning... at the cost of... Neither affects
record_id/Merkle root correctness"). That framing was WRONG for visibility (it IS correct for the
Merkle *logical value*, since `dependency_logical(row) = H(row.dependency_id)` never depends on
`valid_from`): `dependency_id = H(owner_path, dep_path, role)` (`v4::deps::dependency_id`) is a
PURE, unsalted, REUSABLE function of paths -- unlike `record_id`, which `diff::chained_record_id`
always mints FRESH on every replace/reopen. Reprocessing an owner whose dependency graph never
actually changed (the common case: an owner pulled into the affected closure only because an
UNRELATED file elsewhere in the same mixed batch was deleted/renamed, never because its own
imports changed) wrote a closure AND a fresh open for the IDENTICAL `dependency_id` in the same
delta. `Segment::deps_effective_valid_to` resolves visibility from ONE flat, store-wide
`HashMap<dependency_id, valid_to>` (`dep_closures`, merged across every delta's `closures.deps`
section) applied UNCONDITIONALLY to every physical row carrying that key, with no way to tell "this
closure targets the row that predates it" from "this closure predates a LATER reopen of the same
key" -- so the freshly reopened row was permanently swallowed by the closure meant for its own
now-dead predecessor. `PendingSiteView`/`Segment::pending_effective_valid_to` has the exact same
shape (`PendingSiteKey` is plain and reusable, and `delta.rs`'s own pending-site handling is an
even MORE aggressive unconditional wholesale-replace on every owner reprocessing, by design) --
fixed the same way even though this measurement didn't happen to isolate a `pending_site_set`
divergence live (the mechanism is identical, so leaving it unfixed while fixing `dependency` would
have been inconsistent, not "not this task's to fix").

**Fix (two independent, complementary halves)**:
1. `crates/urdira-indexing-worker/src/v4/delta.rs::diff_one_owner` -- dependencies are now diffed
   BY `dependency_id` (plan §6.3's own literal wording: "abrir nuevas, cerrar ausentes"), mirroring
   `diff::diff_owner`'s "same identity, same digest -> keep, never touched" branch for records: an
   edge present in both an owner's previous live rows and its freshly materialized ones is left
   ENTIRELY untouched; only a genuinely REMOVED edge is closed, only a genuinely NEW one is opened.
   This alone makes `deps_closures`/`opened_deps` disjoint by construction within one owner's diff
   (a plain set difference), which ALSO means `writer.rs`'s `dep_changes` Merkle Change list
   (`Set` for every opened row, `Delete` for every closure, Sets built before Deletes) can no
   longer collide on the same key within one delta -- `apply_changes_in_bucket`'s "last write in
   list order wins" behavior would otherwise ALSO have dropped a reopened key from the
   `dependency` Merkle tree even after the storage-visibility half of this fix, a second,
   independent bug in the same family this fix sidesteps rather than patches directly.
2. `crates/urdira-structural-store/src/reader.rs::Segment::{deps,pending}_effective_valid_to` --
   both now take the row's own `valid_from` and only apply a closure when `closed_at > valid_from`
   (a closure can only legitimately apply to a row that existed BEFORE it was recorded). This is
   the independent second half: fix 1 stops the write-side churn that WAS the dominant real-world
   trigger; fix 2 makes the read side correct even for a genuine cross-generation remove-then-
   re-add of the identical key (two separate `diff_one_owner` calls, no shared context, which fix
   1 alone cannot protect). **Documented residual**: a key closed and reopened THREE OR MORE times
   collapses `dep_closures`/`pending_closures` (one merged entry per key, whichever the segment
   merge writes last) to a single `valid_to`, which can misattribute an earlier cycle's closure to
   a later cycle's row if their generations interleave unusually -- correct for the single-cycle
   case this task measured and fixed; a full fix needs per-row (not per-key) closure attribution,
   out of scope here.

**Re-measured after the fix** (same `--files N` harness, `--keep-data` for N=1008 to diagnose the
residual below):

| N (touched, n8n 20,148-file frontier) | roots_ok.delta.records | roots_ok.delta.dependency | roots_ok.delta.graph |
| --- | --- | --- | --- |
| 100 (≈p=0.01) | ✗ (expected, decision 11) | **✓ (was ✗)** | ✓ |
| 300 | ✗ (expected) | **✓ (was untested pre-fix)** | ✓ |
| 1008 (≈p=0.05) | ✗ (expected) | **✓ (was ✗)** | ✗ (still -- see §9.3, a DIFFERENT root cause) |

`dependency` now matches the independent oracle exactly at every N tested (100/300/1008), 0 edges
only-in-either-side confirmed via `dump_dependency_set_diff` re-run after the fix. `records: false`
is the ALREADY-DOCUMENTED, decision-11-legitimate difference (chained ids for migrated/reopened
identities, e.g. an external-module entity whose sole importer was deleted and reattributed to
another importer) -- expected, not a regression, unaffected by this fix (confirmed by
`dump_records_set_diff`'s "REAL record_id/digest diff" bucket being external-entity-migration
cases only, same as before this session).

### 9.3 NEW finding: `graph` still diverges at N≥~1008, a DIFFERENT root cause than §3's original hypothesis

The original hypothesis (this file's own §3, and the task brief's own framing) was "an untouched
owner holding a relation INTO a deleted/renamed identity" propagating a stale `dependency` row into
a stale `graph` entry via `publish.rs`'s `records.iter()`-derived `graph_entries`. That hypothesis
is now RULED OUT as the (or at least the ONLY) cause: `graph` already matches at N=100 and N=300
(both comfortably exercise deletes/renames with untouched importers -- confirmed working via the
dedicated `mixed_burst_with_reverse_dependents_matches_an_independent_oracle_scan` fixture test,
added this session, which passes), and the §9.2 fix did not change `graph`'s pre-fix ✓ at
N=100/300 or its ✗ at N=1008 at all (dependency and graph are structurally independent trees fed
by different data: `DependencyRow` vs `CATEGORY_RELATION` `RecordRow`s).

**Diagnosed with a graph-specific diff** (relation-category records only, matched by both
`record_id` and `identity_key`, `--files 1008 --keep-data`): 20 relation records only in the
incremental delta, 16 only in the oracle, **0 same-identity-different-record_id** (rules out a
chaining/reused-id bug analogous to §9.2 -- these are genuinely DIFFERENT `identity_key`s, not the
same key resolved to two ids). Every differing pair is the SAME import statement in an UNTOUCHED
file (confirmed: e.g.
`packages/frontend/editor-ui/src/app/components/DependencyPill.test.ts:62:126`, byte-identical
content in both the delta and oracle post-mutation trees, never among the 1,008 edited/deleted/
renamed paths), classified as `jsts:external_module:@/app/components/DependencyPill.vue` by the
incremental delta (carried forward from generation 1's cold scan of the UNMUTATED template,
apparently never reprocessed) versus `unresolved` by the independent oracle's fresh scan of the
IDENTICAL final tree. Confirmed the two post-mutation trees are byte-identical in file SET
(`find | sort | md5` matches exactly, 20,230 files both sides) -- so this is not a missing/extra
file, and not an ambient `declare module '*.vue'` gaining or losing a declaring file either (grepped
the corpus's own shim `.d.ts` files under both trees for `.vue`/`declare module` patterns: no
wildcard `.vue` ambient declaration exists in the eligible TS/JS corpus at all, so the "external"
classification does not come from an ambient module rule). The exact mechanism by which an
untouched file's own import-specifier classification (alias-recognized-but-unresolved vs
alias-not-recognized-so-treated-as-an-external-package) depends on something this delta run did
NOT reprocess is not yet isolated -- candidates not yet ruled out: `WorkspaceResolver`'s
tsconfig-`paths`-alias resolution depending on which config asset is "nearest" a given file by
directory proximity, and whether that nearest-config selection is itself stable across a warm,
incrementally-maintained `source_cache`/`config_assets` versus a fully fresh cold rebuild.

**Not fixed this session** -- this is a genuinely different, deeper resolver-consistency question
than §9.2's closure-visibility bug, first surfaces only at a larger scale (≥~1008 touched files;
absent at 100 and 300), and a correct fix requires understanding `WorkspaceResolver`/tsconfig-
proximity internals this session did not have time to trace to a root cause with the same
confidence as §9.2. Flagged here, with full repro evidence (exact identity keys, exact file, exact
harness invocation) rather than left silently unnoticed, per this task's own instruction to decide
and record rather than guess. **Next step for whoever picks this up**: reproduce with
`--files 1008 --keep-data`, then trace `WorkspaceResolver::build`'s config-asset selection for
`packages/frontend/editor-ui/src/app/components/DependencyPill.test.ts` on both the warm
incremental path (content sub-batch's `run_scoped` call, generation 3) and a fresh cold scan of the
identical tree, to find where the two diverge.

### 9.4 P0-2 status: NOT reproduced this session; deferred, not silently dropped

Task 2a asked to reproduce the "changed artifact id is absent from the current and retained
manifests" mixed-burst-split failure first with a small fixture, escalating to the real n8n git
clone only if that failed. Both the small-fixture attempt AND a large-scale synthetic-mutation
attempt failed to reproduce it:
- A small hand-built fixture (`task-planner`, 8 files) with TWO deletes, TWO creates (one being the
  other half of a rename with a real reverse dependent), and one content edit, all in one `Changed`
  batch -- added as
  `mixed_burst_two_deletes_two_creates_and_an_edit_does_not_panic_and_matches_an_independent_oracle`
  in `tests_e2e.rs` -- completed cleanly (`generation=3`, roots match an independent oracle,
  `dependency`/`graph` included).
- The `--files 1008` synthetic-mutation run (§9.2/§9.3, 50 deletes/50 renames/908 edits, the SAME
  mixed-burst two-generation split this bug targets) also never hit it: `mode=delta`,
  `fell_back_to_cold=false` throughout, consistent with E.6's own original finding that the
  fraction-sweep's synthetic mutations never trigger R2 at all (only the two REAL git-history
  switches did).

This confirms the bug needs a structural shape REAL git diffs have that neither a small hand fixture
nor a large independent-per-file-coin-flip synthetic mutation reproduces -- plausibly correlated,
directory-scoped, or multi-file-coupled changes a real multi-month git history naturally produces
(e.g. a package-wide move/rename sharing common path prefixes) that this task did not have time to
clone n8n and reconstruct from the real `HEAD~200..HEAD`/tag-to-tag switches E.6 itself used. Per
plan §0 ("rendimiento sin comprometer integridad"): this is judged a robustness/performance gap, NOT
a data-integrity gap -- R2's own same-request cold fallback already catches the failure safely
(confirmed live twice in E.6's own measurement: `fell_back_to_cold=true`, exactly one new
generation published, no partial state) -- so, given the session's finite time, priority went to
closing §9.2's confirmed silent-data-loss bug first. **Left open, not fixed**: reproduce with the
real n8n git clone and `HEAD~200..HEAD`/tag switch exactly as E.6 did
(`node scripts/v4-reconcile-threshold.mjs --git-switch --git-repo <n8n clone> --data <scratch>
--git-tag-a n8n@1.123.25 --git-tag-b n8n@1.123.56 --out <json>`, `URDIRA_V4_RECONCILE_THRESHOLD=1.0
URDIRA_DEBUG_TIMING=1` to force `Delta` and capture the exact failing artifact id per the original
task brief), then trace which of the two internal generations (`delta.rs::run`'s structural vs
content split) the failing artifact id belongs to and why `authoritative_changed_paths`
(`urdira-jsts-syntax-worker::lib.rs`) cannot find it in either manifest.

### 9.5 Verification (this session)

```
cargo fmt --all -- --check                                              # clean
cargo clippy --workspace --all-targets --locked -- -D warnings          # clean
cargo test -p urdira-indexing-worker -p urdira-source-frontier --locked # 121+46 passed, 0 failed
cargo build --release --locked -p urdira-indexing-worker                # clean
./node_modules/.bin/vitest run tests/phase-daemon-v4-reconcile.test.ts tests/v4-mutation-harness.test.ts
                                                                         # 6 passed, 3 skipped, CI=true
```

### 9.6 Files touched

- `crates/urdira-indexing-worker/src/v4/delta.rs`: `diff_one_owner`'s dependency handling rewritten
  to diff by `dependency_id`; module doc updated to match (no longer "owner granularity" for
  dependencies).
- `crates/urdira-structural-store/src/reader.rs`: `Segment::deps_effective_valid_to`/
  `pending_effective_valid_to` gated by the row's own `valid_from`; the two call sites
  (`DependencyView`/`PendingSiteView::valid_to_effective`) updated to pass it.
- `crates/urdira-indexing-worker/src/v4/tests_e2e.rs`: two new e2e tests --
  `mixed_burst_with_reverse_dependents_matches_an_independent_oracle_scan` (P0-1 repro shape at
  fixture scale, passes both before and after the fix -- the real bug needed n8n scale, not just
  the reverse-dependent shape) and
  `mixed_burst_two_deletes_two_creates_and_an_edit_does_not_panic_and_matches_an_independent_oracle`
  (P0-2's small-fixture repro attempt, ruled the bug out at this scale).
- `scripts/v4-reconcile-threshold.mjs`: `--files N` / `--keep-data` flags.
- This file: §9.

### 9.7 Scratch cleanup

`~/Proyectos/urdira-benchmark/v4-fold/ep0-bisect-{100,300,1008,1008-fixed,1008-keep}*` and
`ep0-bisect-100-fixed*` directories (workspace + data copies, `--keep-data` outputs, and their
`*-results.json` companions) deleted at the end of this session. `CARGO_TARGET_DIR` override
(`.claude/worktrees/cargo-target-ep0`) removed.

## 10. Frente E-P0b (2026-09-06/07): fleco 1 root cause found and fixed; fleco 2 (P0-2) fixed
## and confirmed at real git-switch scale; TWO NEW graph-parity gaps found, diagnosed, deferred

Branch `frente-ep0b-graph-parity` on top of `ae61841` (`frente-ep0-delta-parity`, itself on `main`
`47e96a2`). Per plan §0 ("integridad primero"): both flecos this task was explicitly scoped to are
fixed and verified; this session's own broader graph-parity verification (a NEW `roots_ok` check
added to `scripts/v4-reconcile-threshold.mjs`'s git-switch mode, §10.4) surfaced two ADDITIONAL,
previously-undiagnosed `graph`-only divergences at larger scale, outside this task's literal
scope (§9.2/§9.3's own hypotheses) but directly relevant to "graph raíz idéntica al oráculo a
cualquier N" -- reproduced with full evidence and left open rather than silently unnoticed,
matching this campaign's own established practice (§9.4's own P0-2 disposition in the PRIOR
session).

### 10.1 Fleco 1 root cause: `reresolve_file`'s narrow rebuild discards a corpus-wide ambient
### decision for an UNRELATED specifier in the same file

**Reproduced** exactly as §9.3 left it: `--files 1008` on n8n, `graph` diverges from an
independent oracle. Diagnosed with a targeted graph-relation diff (temporary test, deleted before
commit) comparing `CATEGORY_RELATION` records by `identity_key` between the incremental delta
store (generation 3) and a from-scratch cold scan of the identical post-mutation tree: **the
SAME import statement** (`packages/frontend/editor-ui/src/app/components/DependencyPill.test.ts`
byte offset 62:126, `import DependencyPill from '@/app/components/DependencyPill.vue'`) carries
`jsts:external_module:@/app/components/DependencyPill.vue` as its target in the incremental delta
but `unresolved` (no target, `RelationClassification::Possible`) in the independent oracle.

**Confirmed by direct probe** (`WorkspaceResolver::resolve` against the real tsconfig content,
temporary test, deleted before commit): `resolve()` returns `None` for this specifier
UNCONDITIONALLY, regardless of `available` -- the tsconfig `paths` entry `"@/*": ["./src/*"]`
substitutes to `src/app/components/DependencyPill.vue`, and `probe_extensions` never finds a
`.vue`-suffixed candidate in `available` (`.vue` is not a `JSTS_EXTENSIONS` member, so it is never
tracked as a source file). This rules out hypotheses (i) (a config-asset alias change -- the
fraction-sweep's own `isCandidateSourcePath` never selects non-source-extension files for
mutation, so no tsconfig/package.json is ever touched) and (iii) (non-deterministic resolver
construction -- `WorkspaceResolver::build` is a pure, deterministic function of a `BTreeMap`-sorted
asset list). The divergence is NOT about `.vue`-target resolvability at all.

**Actual mechanism, found by tracing generation-by-generation** (querying the SAME kept
`--keep-data` store at generation 1 vs generation 3): generation 1 (this workspace's OWN initial
cold scan, sharing the warm process with the later reconcile, per §1.2's methodology) correctly
computes `unresolved` for this import -- **workspace-ambiguous ambient wildcard**:
`packages/@n8n/mcp-apps/src/apps/workflow-preview/shims-vue.d.ts` and
`packages/@n8n/mcp-browser-extension/src/ui/shimsVue.d.ts` both declare `declare module '*.vue'`
(confirmed: `grep -rl "declare module.*\.vue"` across the WHOLE corpus, not just `editor-ui`) --
`AmbientModuleIndex` is built corpus-wide, so `has_any_declaration("...DependencyPill.vue")` finds
2 declaring files (workspace-ambiguous, `resolver.rs`'s own `build_import_export_facts` branch 3:
`(None, Possible)`), correctly demoting the import away from a naive external-module guess. By
generation 3 this SAME relation has flipped to `Confirmed`/`external_module` with a DIFFERENT
`record_id` -- meaning the relation was genuinely REWRITTEN, not merely carried forward.

`DependencyPill.test.ts` also imports `packages/frontend/editor-ui/src/__tests__/utils.ts`-shaped
relative specifiers; when ANY of the --files-1008 mutation's 50 deletes/50 renames touches a path
in this file's own `CandidateIndex` (specifier-candidate reverse index), `path_membership_
incremental`'s T1 fast path (`urdira-jsts-syntax-worker::lib.rs`, `reresolve_file`) pulls this
UNTOUCHED file into its own `stale_paths`/`reresolved` set and calls `reresolve_file`, which
**unconditionally rebuilds the file's ENTIRE `direct_imports`-derived relation list** via
`build_import_export_facts(..., ambient_index: None)` (its own doc comment: "the separate
`reresolve_ambient_relations` pass below is what applies ambient resolution") -- discarding the
CORRECT ambient-ambiguous classification for the UNRELATED `.vue` import and falling through to
`classify_external_specifier`'s naive guess. The post-processing "ambient revisit" pass
(`reresolve_ambient_relations`, meant to re-apply the real `ambient_index` afterward) only ever
iterated `changed ∪ ambient_affected` -- `reresolved` (T1's own bounded-reresolution output) was
never included, so the wrong classification stuck permanently.

**Fix** (`crates/urdira-jsts-syntax-worker/src/lib.rs`): fold `reresolved` into the ambient-revisit
loop's iteration set (`changed.iter().chain(ambient_affected.iter()).chain(reresolved.iter())`) --
strictly additive, empty whenever `path_membership_incremental` did not run, so no behavior change
for any call that never populates `reresolved`.

**New e2e test** (`crates/urdira-indexing-worker/src/v4/tests_e2e.rs`):
`reresolved_file_keeps_an_unrelated_ambiguous_ambient_import_pending_and_matches_an_independent_oracle`
-- fixture-scale repro of the exact mechanism (two `declare module '*.vue'` shims in different
files, one file with a bare `*.vue` import plus an unrelated relative import that only resolves
after a PURE structural `Created` batch). Confirmed to FAIL without the fix (reproduces the exact
"changed artifact id..." -- no, reproduces the `graph` root mismatch directly, panic message
showing differing `graph` hex digests) and PASS with it. `dependency`/`graph` asserted;
`records` deliberately not (decision 11, unaffected by this bug).

### 10.2 Fleco 2 (P0-2) root cause: `changed_artifact_ids` names CONFIG ASSET paths, which
### `analyze()`'s own manifest can never contain

**Reproduced** on both real git switches with `URDIRA_DEBUG_TIMING=1`: `.github/scripts/
jsconfig.json` (tags-3-months switch) and, independently, `pnpm-workspace.yaml`/`package.json`
(head-vs-head200 switch) are CREATED/MODIFIED as part of the SAME batch as hundreds of ordinary
source changes -- routine in any real git history diff of meaningful size. Worker stderr (exact,
both switches):
```
[urdira-indexing-worker] v4 delta: mixed burst split into two generations: structural=[...]
[urdira-indexing-worker] v4 reconcile: delta failed: v4 syntax analysis failed: changed artifact id
is absent from the current and retained manifests: sha256:...; falling back to cold
```

**Mechanism**: `delta.rs::run_one`'s `changed_artifact_ids` (the `AuthoritativeChangeSet::Exact`
list handed to `syntax.analyze()`) used to be built from EVERY `source_delta.changed`/`added`/
`deleted` path, config assets included -- `Catalog::apply`/the frontier track config assets
exactly like any other observed file. But `analyze()`'s own retained/current manifest
(`ProjectState::source_metadata`, `urdira-jsts-syntax-worker::lib.rs`) is built EXCLUSIVELY from
its `sources: Vec<SourceInput>` argument, which `state::SourceCache::files_vec()` populates from
JSTS SOURCE paths only (`is_jsts_source_path`) -- config assets travel through the entirely
separate `config_assets: Vec<ConfigAssetInput>` channel and NEVER populate `source_metadata`.
`authoritative_changed_paths` looks up each declared id in the union of that manifest's `prior`/
`current` snapshots -- a config asset's artifact id can never be found there, by construction, no
matter how fresh the manifest is, and the validation runs UNCONDITIONALLY (before the branch that
would even use its result), so it errors out the whole `Changed`/`Reconcile` call even when the
config asset was folded correctly into `configuration_digest` elsewhere.

**Fix** (`crates/urdira-indexing-worker/src/v4/delta.rs`): scope `changed_artifact_ids` to
`analyze::is_jsts_source_path` paths only (both the `changed`/`added` loop and the `deleted` loop)
-- a touched config asset still correctly drives `ResetReason::ConfigurationChanged` via
`fold_configuration_digest` over `config_assets_vec()`, unaffected by this filter; it was simply
never meant to appear in this authoritative-EXACT-ids list, whose sole contract is naming
CONTENT-CHANGED SOURCE files.

**New e2e test**:
`config_asset_created_alongside_a_content_edit_does_not_crash_and_matches_an_independent_oracle`
-- a new nested `jsconfig.json` (forcing `has_structural`) alongside a genuine content edit
(forcing `has_content`, exercising the SAME mixed-burst split the real failures took). Confirmed
to reproduce the EXACT verbatim error message without the fix, and to pass (`dependency`/`graph`
match an independent oracle; `records` unasserted, decision 11) with it.

**Re-measured on both real git switches with the fixed release binary**:

| switch | pre-fix `reconcile(T=1)` | post-fix `reconcile(T=1)` | `fell_back_to_cold` |
| --- | --- | --- | --- |
| tags-3-months (504 changed) | `mode=cold`, fallback, 11.80s | **`mode=delta`**, 36.6s | **false** (was true) |
| head-vs-head200 (1,971 changed) | `mode=cold`, fallback, 106.9s* | **`mode=delta`**, 106.9s | **false** (was true) |

(*head-vs-head200's pre-fix wall was not separately isolated in §4's own table; both this
session's pre-fix confirmation run and the post-fix run hit the SAME `mode=cold` fallback path
before the fix, `fell_back_to_cold=true` both times, matching §4's own finding.)

### 10.3 P0-1 (dependency, prior session's own fix) re-confirmed at real git-switch scale

`dependency` root parity vs an independent from-scratch oracle of the post-switch tree: **holds**
on both real git switches with the fixed binary (`roots_ok.dependency = true` both times) -- the
prior session's `dependency_id`-granularity fix (§9.2) generalizes correctly beyond the synthetic
fraction-sweep mutations it was originally verified against.

### 10.4 NEW finding, NOT fixed this session: `graph` still diverges on both real git switches
### (harness itself extended to catch this -- it never checked roots before)

`scripts/v4-reconcile-threshold.mjs`'s git-switch mode never compared Merkle roots at all before
this session (only wall times and the `reconcile` summary) -- extended with `runIndependentOracleColdScan`
(a brand-new workspace_id/data dir, `ScanScope::Full` on the post-switch tree) and a `roots_ok`
comparison (`dependency`/`graph`; `records` deliberately excluded, decision 11) in `measureOneSwitch`,
plus `--keep-data`/`--only-switch` support threaded through `runOneGitSwitchCycle` for follow-up
diagnosis. Result, POST-fix (both fixes from §10.1/§10.2 applied):

| switch | `mode` | `dependency` | `graph` |
| --- | --- | --- | --- |
| tags-3-months | delta | **true** | **false** |
| head-vs-head200 | delta | **true** | **false** |

Diagnosed with the same graph-relation diff used in §10.1 (kept `--keep-data`, `--only-switch
tags-3-months`): 19 relations present ONLY in the independent oracle (never the reverse -- a
one-directional, only-ever-loses gap, the same shape as every prior P0 in this family). ALL 19 are
`jsts:call`/`jsts:references` relations whose IDENTITY encodes a `jsts:property:...`/`jsts:method:...`
target -- e.g. `jsts:references:...isolated-vm-bridge.ts:...:jsts:method:...isolated-vm-bridge.ts:
...execute:jsts:method:...types/bridge.ts:2185:debug`. `jsts:property`/entities with this shape are
produced by the RESIDUAL (tsgo type-checker) pipeline (`crates/urdira-indexing-worker/src/v4/
residual.rs:2044`), NOT the plain syntax-level `WorkspaceResolver` §10.1's fix touches -- confirmed
by `grep`, no `"property"` entity kind exists anywhere in `urdira-jsts-syntax-worker`. Every one of
the 7 files involved (both sides of each reference pair) is confirmed, via `git diff --name-only`
on the exact two tags, to be among the switch's own 504 changed files -- these are NOT untouched
"affected-closure" files; they are files DIRECTLY edited by the real commit range. This is a
DIFFERENT root cause from §9.2/§9.3 and from §10.1: the residual/tsgo pipeline's own incremental
scheduling (`ResidualContext::touched_owners`, scoped per-internal-generation off `delta::run`'s
own `touched_owner_paths`) does not consistently reproduce a cold scan's cross-file property/type
reference resolution when multiple mutually-referencing files are edited together in one large
real diff. **Not diagnosed further or fixed this session** -- `residual.rs` is a 4,000+-line module
this session did not have the remaining budget to trace to a root cause with the same confidence as
§10.1/§10.2, and a wrong fix risks destabilizing a heavily budget/schedule-constrained pipeline
several other fronts depend on. Flagged here with full repro evidence (exact identity keys, exact
files, exact switch/tags, exact diagnostic queries) per this campaign's own practice, rather than
left silently unnoticed.

**Second, independent NEW finding** (`--files 1008`, same session, re-measured with BOTH fixes
applied): `graph` STILL diverges at this scale too (`roots_ok.delta.dependency=true,
graph=false` -- `records=false` is the expected decision-11 gap) -- but via a THIRD, again
DIFFERENT mechanism, matching the ORIGINAL task brief's own hypothesis (ii) almost exactly: the
mutation plan DELETES `packages/@n8n/benchmark/src/test-execution/k6-summary.ts` (defines
`K6Check`/`K6CounterMetric`/`K6TrendMetric`/`K6EndOfTestSummary` interfaces); `test-report.ts`
(UNTOUCHED by the mutation, a real importer of the deleted file) keeps 4 STALE `jsts:references`
relations pointing at those now-nonexistent interfaces in the incremental delta (4
only-in-incremental -- the OPPOSITE direction from every other gap found this session: a phantom
EXTRA relation, not a lost one) that an independent oracle correctly does not have. Root cause:
`reresolve_file` (§10.1's own subject) is scoped, BY ITS OWN DESIGN, to rebuild ONLY
`RelationKind::Import`/`Export` edges (its own filter: `!(matches!(relation.kind, RelationKind::
Import | RelationKind::Export) && relation.source_id == module_id)` keeps everything else
untouched) -- it correctly updates `test-report.ts`'s OWN import-of-`k6-summary` edge to
"unresolved" but has no mechanism to invalidate the DOWNSTREAM `jsts:references` relations
(built by `semantic_sites.rs`'s type/value reference tracking, a completely different code path)
that resolved THROUGH that import while it was still live. Correctly fixing this needs either (a)
promoting a `resolution_changed` path to a full reparse (defeating T1's own O(delta) design intent
for the common case, needing careful scoping to avoid a performance regression) or (b) a narrower
"drop any reference whose target's identity falls inside a path just removed from `direct_imports`'
resolved set" pass -- both are real design work, not a one-line fix, and were judged out of this
session's remaining budget. **Not fixed this session**, flagged with full repro (exact deleted
file, exact importer, exact 4 relation identities, exact `--files 1008` seed).

### 10.5 Threshold decision: `RECONCILE_DELTA_THRESHOLD` left UNCHANGED at 0.01

Per plan §0 criterion (a) ("mejor rendimiento que no comprometa la integridad de los datos"): T is
NOT raised despite this session fixing both of E.6's own original P0 blockers. Both NEW findings in
§10.4 are `graph`-only gaps in the `Delta` path specifically (the `Cold` path is unaffected --
confirmed `roots_ok.cold_all=true` in every fraction-sweep cell measured this session), and BOTH
manifest at exactly the scale a real branch switch is likely to hit (§10.4's git-switch numbers;
§10.4's own `--files 1008` finding). Raising T would route MORE real reconcile calls through
`Delta`, increasing exposure to two confirmed, not-yet-fixed correctness gaps -- the opposite of
this session's own mandate. `T = 0.01` (unchanged from §5) remains the right, conservative choice
until §10.4's two findings are resolved by a future task.

### 10.6 Re-measurement summary (`--files 202/1008`, ×1 each, this session's fixed binary)

| N | `mode` | `dependency` | `graph` | `records` |
| --- | --- | --- | --- | --- |
| 202 (p≈0.01) | delta | true | **true** | false (decision 11, expected) |
| 1008 (p≈0.05) | delta | true | **false** (§10.4, new finding #2) | false (decision 11, expected) |

`--files 2015` (p≈0.10) was not re-measured in this session (time budget spent on diagnosing the
two NEW findings above once `graph=false` persisted at 1008 despite §10.1's fix) -- given `graph`
already diverges at 1008 via a mechanism §10.1 does not touch, a clean 2015 result would not have
changed this session's threshold decision (§10.5) or its conclusion that §10.4's two findings need
a future task.

### 10.7 Verification (this session)

```
cargo fmt --all -- --check                                                      # clean
cargo clippy --workspace --all-targets --locked -- -D warnings                  # clean
cargo test -p urdira-indexing-worker -p urdira-source-frontier -p urdira-structural-store --locked
  # 123 passed/16 ignored (indexing-worker), 46 passed (source-frontier), 19 passed (structural-store
  # unit), plus every one of that crate's integration test binaries -- 0 failed across all of them
cargo build --release --locked -p urdira-indexing-worker                        # clean
CI=true ./node_modules/.bin/vitest run tests/phase-daemon-v4-reconcile.test.ts tests/v4-mutation-harness.test.ts
                                                                                  # 6 passed, 3 skipped
```

### 10.8 Files touched

- `crates/urdira-jsts-syntax-worker/src/lib.rs`: the ambient-revisit loop (inside `analyze()`) now
  also iterates `reresolved` (§10.1).
- `crates/urdira-indexing-worker/src/v4/delta.rs`: `changed_artifact_ids` scoped to
  `is_jsts_source_path` paths (§10.2); new `use super::analyze::is_jsts_source_path;`.
- `crates/urdira-indexing-worker/src/v4/tests_e2e.rs`: two new e2e tests (§10.1/§10.2).
- `scripts/v4-reconcile-threshold.mjs`: git-switch mode now verifies `dependency`/`graph` against
  an independent oracle (`runIndependentOracleColdScan`, new `roots_ok` log line); `--keep-data`
  and `--only-switch` now also work in git-switch mode (`runOneGitSwitchCycle`/`measureOneSwitch`/
  `runGitSwitchMode` all threading the flag through).
- This file: §10.

### 10.9 Scratch cleanup

`~/Proyectos/urdira-benchmark/v4-fold/ep0b-{bisect-1008,git-switch,git-switch-fixed,graph-diag,
remeasure-202,remeasure-1008,n8n-git}*` (workspace/data copies, git clones, `--keep-data` outputs)
deleted at the end of this session; the small `*-results.json` companions retained (`ep0b-bisect-
1008-results.json`, `ep0b-git-switch-results.json`, `ep0b-git-switch-fixed-results.json`, `ep0b-
graph-diag-results.json`, `ep0b-remeasure-{202,1008}-results.json`), matching §9's own retention
pattern. `CARGO_TARGET_DIR` override (`.claude/worktrees/cargo-target-ep0b`) removed. All temporary
diagnostic `#[ignore]` probe tests (resolver-resolution probe, oracle-cold-scan-and-dump, graph-set-diff,
dependency-pill-records dump) added and removed within this session -- none survive in the final diff.

## 11. Frente E-P0c (2026-09-07): Brecha A closed exactly (fixture + real-scale, byte-for-byte);
## Brecha B closed 84% at real n8n scale (19 → 3 missing relations), root cause of the remaining
## 3 localized but not yet fixed; a THIRD, independent, foundational bug found and fixed live
## (`BucketedMerkleSet` count staleness after a disk round-trip)

Branch `frente-ep0c-delta-references` on top of `4ddb890` (E-P0 + E-P0b merged). Per plan §0
("fidelidad e integridad primero"): both brechas this task was scoped to are diagnosed to their
real root cause and fixed at fixture scale with regression tests that fail-without/pass-with the
fix; Brecha A additionally verified BYTE-FOR-BYTE (set comparator) at real n8n git-switch scale;
Brecha B verified at real n8n git-switch scale to be 84% closed (19 → 3 missing relations, same
switch, same corpus), with the remaining 3 root-caused to a DIFFERENT, narrower mechanism than
Brecha A/B's own original hypotheses and left open with full repro rather than silently unnoticed,
matching this campaign's own established practice (§9.4/§10.4's own prior-session dispositions).

### 11.1 Brecha A root cause: `reresolve_file`'s narrow relation patch never invalidated
### DOWNSTREAM references that resolved THROUGH an import while its target was still live

**Reproduced** exactly as §10.4 finding #2 described it, at FIXTURE scale first (new e2e test
`deleting_an_imported_files_export_drops_the_untouched_importers_stale_references_and_matches_an_
independent_oracle`, `crates/urdira-indexing-worker/src/v4/tests_e2e.rs`): `a.ts` exports
`interface I`; `b.ts` imports `I`, using it as a parameter type in three functions. Cold scan, then
a PURE structural `Changed{Deleted a.ts}` batch (T1's `path_membership_incremental` fast path) --
`b.ts` itself is never touched. `graph` (and `pending.sites`) diverged from an independent
from-scratch oracle of the identical (a.ts-less) final tree: `b.ts` kept 3 stale, `Confirmed`
`jsts:references` relations pointing at `I`'s now-nonexistent interface -- a phantom
`find_references` answer, invisible to `dependency`, which correctly closed.

**Mechanism**: `urdira-jsts-syntax-worker/src/lib.rs`'s `reresolve_file` (T1's bounded add/remove
re-resolution, triggered for any file whose specifier's candidate target set changed) only ever
rebuilt the file's OWN `RelationKind::Import`/`Export` rows -- its own explicit filter excluded
every other relation kind. The `jsts:references` relations a SEPARATE pass (the hybrid lane,
`semantic_sites.rs`) had already baked into `b.ts`'s `relations` list, while `I` was still a live
import target, were carried forward completely unexamined: correctly flipping the import itself to
"unresolved" while leaving every relation that had resolved THROUGH it pointing at a dangling
target with no mechanism to ever revisit them.

**Fix**: promoted `reresolve_file` from an in-place relation patch to a FULL REPARSE. `docs/
evidence/2026-09-02-file-creation-diagnosis.md`'s own T1 design already guarantees the file's
BYTES are unchanged (a `path_membership_incremental` precondition) -- a fresh `parse_source` call
against the SAME bytes, the CURRENT `available`/`resolver`, is therefore byte-for-byte identical to
what a cold scan computes for this exact file, for the exact same reason `analyze()`'s cold path
itself is deterministic. Replaced the narrow `reresolve_file` (rebuild relations in place) with a
cheap, read-only `import_resolution_would_change` check (identical resolution-changed detection,
zero cloning) that GATES a full reparse via `decode_source`+`parse_source`, reusing a new
`validated_by_path` lookup (the same `validated: Vec<ValidatedSource>` `analyze()` already builds
from ALL current sources, not just changed ones) -- bounded to exactly `stale_paths`, never every
corpus file, preserving T1's own cost class.

### 11.2 A SECOND, independent, foundational bug found live while verifying Brecha A: `BucketedMerkleSet`'s
### own `bucket_count` bookkeeping goes stale after a disk round-trip, corrupting `root()`'s
### `count == 0` special case for ANY category whose corpus-wide live member count returns to zero

Verifying 11.1's fix against an independent oracle surfaced a SECOND, unrelated divergence: the
`dependency` root (not `graph`) mismatched even though `dump_dependency_set_diff` showed BOTH sides
had **zero live edges** (`b.ts`'s only dependency, on the now-deleted `a.ts`, correctly closed with
no replacement). Root cause, found in `crates/urdira-indexing-core/src/merkle_bucket.rs`
(`docs/evidence/2026-09-02-v4-p0-s3-merkle-bucket.md`'s own "known caveat", explicitly flagged as a
follow-up then and finally closed here): `BucketedMerkleSet::read_from` restores the AGGREGATE
`count` from the file header but never restores PER-BUCKET counts (never persisted at all) --
`update()` used to read `self.bucket_count[bucket_idx]` as a touched bucket's PRE-change count,
which silently reads `0` for any bucket a `read_from`-loaded set has never itself observed a
member-count delta for, regardless of what it actually held. Every `update()` call following a
`read_from` (i.e. every incremental generation after the first) therefore inflated `self.count` by
the true prior size of each touched bucket that already had members -- invisible everywhere except
`root()`'s ONE `count == 0` special case (a deliberate, hard-coded `ZERO` sentinel for a genuinely
empty set, per that crate's own doc: "this is the ONE deliberate exception"): once the true
corpus-wide count for a category returns to exactly zero, `self.count` never again reaches zero,
so `root()` permanently returns a real (non-empty-sentinel) node digest instead of `ZERO`, diverging
from a from-scratch oracle's `BucketedMerkleSet::from_sorted(&[])` (which correctly returns `ZERO`).

**Fix**: `BucketedMerkleSet::update`'s `bucket_entries` closure contract changed from `Fn(u32) ->
Vec<(Digest32, Digest32)>` (post-change contents only) to `Fn(u32) -> (u32, Vec<(Digest32,
Digest32)>)` (`(pre_change_count, post_change_entries)`) -- every real caller already computes or
has on hand the true pre-change bucket length anyway (it is the length of the pre-change entries it
reads before applying `changes`), so this is a pure plumbing change, not new work, at every call
site: `urdira-structural-store::writer::write_delta`'s two `apply_changes_in_bucket` calls (records/
dependency), `urdira-indexing-worker::v4::diff::graph_bucket_entries` (graph), and `urdira-source-
frontier::frontier::apply_bucket_change` (source-state; always exact here since that tree is
rebuilt via `from_sorted` on every `Frontier::load`, never round-tripped through `write_to`/
`read_from` at all). New regression test `merkle_bucket::tests::deleting_the_last_member_after_a_
disk_round_trip_converges_to_the_empty_root`: builds a 1-member set, `write_to`+`read_from`
round-trips it, deletes the member via `update`, asserts `root() == ZERO == BucketedMerkleSet::
empty().root()` -- fails without the fix (returns a real digest), passes with it.

A SECOND, related bug in the SAME family surfaced while re-verifying Brecha A's own fixture with
this fix in place: `urdira-indexing-worker::v4::delta.rs`'s own P0-1 dependency diff (§9.2's own
fix) intentionally leaves a dependency row PHYSICALLY untouched (never closed, never reopened) when
its `dependency_id` is identical before/after an owner's reprocessing -- correct when the OWNER
reprocessed for an UNRELATED reason (its own ordinal unchanged), but WRONG when the OWNER'S OWN
ordinal changed (any genuine content edit mints a fresh `artifact_version_id`/ordinal, P3-1
evidence doc §4): the untouched row stays attributed to the now-DANGLING old ordinal forever, so
`StoreReader::deps_by_owner(current_ordinal, ...)` -- exactly what §11.4's residual fix needs --
finds nothing for that owner even though the edge is still logically live (confirmed live via
§11.4's own fixture: `deps_by_owner` empty for both `a.ts`/`b.ts` after editing them together
despite their dependency SET never changing). `dependency_id`/`dependency_logical` never encode an
ordinal at all, so no PRIOR root-vs-oracle Merkle comparison in this codebase's history ever caught
this -- only an owner-SCOPED query does. **Fix**: `diff_one_owner` takes a new `owner_identity_
changed: bool` (`old_ordinal.is_some_and(|old| old != new_ordinal)`); when true, a same-`dependency_
id` edge is closed AND reopened under the fresh ordinal (never left untouched). Safe within one
generation because `Segment::deps_effective_valid_to`'s `valid_from`-gated closure map (P0-1's own
"second, independent half") already resolves a same-generation close+reopen of one physical key
correctly on the READ side -- the missing WRITE-side half was `writer.rs`'s own `dep_changes` list
always ordering every `Set` (open) before every `Delete` (close), so a same-key open+close pair
left the MERKLE bucket with the key ABSENT (`apply_changes_in_bucket` processes changes in order,
last write wins) even though the physical row correctly stayed visible -- fixed by building
`dep_changes` Deletes-first, Sets-after (the reverse of `record_changes`, which never needs this:
decision 11 guarantees a record's identity never collides between one generation's own opens and
closes, unlike a dependency's unsalted, owner-path-based identity).

### 11.3 Brecha B, first (residual-specific) mechanism: tsgo's own `VirtualFs`/`file_map`, for a
### delta-triggered pass, was narrower than what cross-file type resolution can need

Confirmed via a NEW fixture-scale test (`crates/urdira-indexing-worker/src/v4/residual.rs`'s
`residual_first_pass_sees_a_multi_file_edits_transitive_type_dependency_outside_the_edited_set`):
`c.ts` declares `abstract class Base { m(): number {...} }`; `a.ts` declares `class A extends Base
{}` (never redeclaring `m`); `b.ts` calls `items.map((item) => item.m())` on an `A[]` -- a `lib.
d.ts` `Array.prototype.map` dispatch (typeflow's own documented "guaranteed pending" shape) whose
INHERITED-method resolution needs tsgo to actually see `c.ts`. `a.ts`+`b.ts` edited together (`c.ts`
untouched, no pending site of its own): the post-edit residual pass, with `touched_owners: Some(
["a.ts", "b.ts"])` (exactly what `scan::run_with_residual` schedules for this delta), could not
resolve the site at all (`unresolved=1`) without the fix, `upgraded=1` with it.

**Root cause**: `run_once_with_quiet_period`'s `file_map` (`crates/urdira-indexing-worker/src/v4/
residual.rs`) is filtered to `resolved_visible_owners` -- on a delta-triggered first pass, a FLAT
`touched_owners ∪ pending_owners` set (`resolve_visible_owners_for_pass`), never a transitive
closure. A file a touched/pending owner's OWN types transitively depend on (a base class, a
re-exported interface, a shared type alias) is invisible to tsgo unless it ALSO happens to be
independently touched or pending -- a cold scan never narrows `file_map` at all
(`touched_owners: None`), so this gap is exclusive to the delta path. **Fix**: new `expand_with_
dependency_closure` (forward BFS over `StoreReader::deps_by_owner`, already O(1)-indexed) widens a
first pass's `resolved_visible_owners` with every file the seed set transitively depends on, before
building `file_map` -- `candidate_owners` (the WINDOW PLAN, i.e. which sites actually get a
resolution attempt this pass) stays UNCHANGED and narrow, preserving the reschedule-convergence
fix `candidate_owners_for_pass` exists for (C.5, 2026-09-05) -- only VISIBILITY widens, never
scheduling. Forward-only (never `deps_reverse`): a type flows INTO a scheduled owner's own
resolution via what it imports, never via what imports it.

### 11.4 Brecha B, second (syntax/typeflow) mechanism, found live at REAL n8n scale (residual was
### NEVER involved): `TypeflowCache::build_index`'s single settling pass converges to a WRONG state
### for a multi-file edit batch; a second (bounded, fixed-point) pass closes MOST but not all of it

**Reproduced** on the real `tags-3-months` git switch (`n8n@1.123.25` → `n8n@1.123.56`, 504 changed
files) with a FIXED release binary (11.1-11.3's fixes applied): `scripts/v4-reconcile-threshold.mjs
--git-switch --keep-data --only-switch tags-3-months`, then a NEW comparator, `graph_identity_set_
matches_between_two_kept_stores` (`tests_e2e.rs`) -- `CATEGORY_RELATION` rows compared by
`identity_key` (never `record_id`/the raw merkle root) between the kept incremental store and an
independent from-scratch oracle of the identical final tree. **Raw `graph` root parity is
unreachable here by construction, unrelated to Brecha A/B**: `docs/evidence/2026-09-03-v4-p3-1-
incremental.md` §5.1 already documents, as a decision-11 identity-chaining fact predating this
task, that ANY genuinely edited owner's own relations legitimately get a CHAINED `record_id`
(`H(digest || predecessor)`) on the incremental side while an independent oracle always mints the
unconditional cold "first occurrence" id (`sha256(digest)`) for the SAME logical relation -- a real
git switch always edits files, so `roots_ok.graph` (the harness's own raw-root check) reads `false`
on BOTH real switches regardless of any fix in this session (confirmed: `dependency=true,
graph=false` both before and after). The SET comparator is the correct instrument for a
missing/phantom relation specifically (decision 11 guarantees `identity_key` itself never chains).

**Before any fix in this section**: 19 relations present ONLY in the oracle (0 phantom), matching
§10.4's own original finding exactly (same identities, e.g. `jsts:call:packages/@n8n/expression-
runtime/src/bridge/isolated-vm-bridge.ts:...:jsts:method:...types/bridge.ts:2185:debug`).
**Confirmed this session, contradicting §10.4's own hypothesis**: `URDIRA_V4_RESIDUAL` was never set
for either side of this measurement (the harness never enables it; grep of the full run log for
"residual" returns zero matches) -- the background tsgo pass NEVER RAN. `jsts:method`/`jsts:
property` are ordinary SYNTAX-LEVEL entity kinds (`EntityKind::Method`/`Property`, `urdira-jsts-
syntax-worker/src/lib.rs`), not residual-exclusive; these 19 relations are produced by the
HYBRID LANE's typeflow-driven call/reference resolution (`semantic_sites.rs`, driven by `crates/
urdira-indexing-worker/src/v4/typeflow.rs`'s `TypeflowCache`), entirely independent of §11.3's own
residual fix. `git diff --name-only` on the two tags confirms BOTH files of each pair (caller and
callee-declaring file) are genuinely edited in the SAME batch -- the same "multiple mutually-
referencing files edited together" shape as Brecha B's own brief, just one layer earlier in the
pipeline than the brief's own residual hypothesis.

**Mechanism**: `TypeflowCache::build_index`'s warm branch processes `pending_upserted` (a
`BTreeSet<String>`, i.e. PATH-alphabetical order) ONE PASS: for each upserted `path`, `refresh_
paths = index.importers_of(path) + path` is computed the MOMENT `path` itself is (re)inserted, then
`resolve_import_targets_for(refresh_paths, ...)` feeds `ProgramIndex::replace_file`. When an owner
`X` (e.g. `types/bridge.ts`, declaring the callee) and one of ITS OWN importers `Y` (e.g. `bridge/
isolated-vm-bridge.ts`, calling it) are BOTH in `upserted`, their relative alphabetical order
decides whether `Y`'s own needed-imports resolution (computed the moment `Y` itself was inserted)
ever gets a chance to see `X`'s fresh, post-edit shape -- a single pass leaves exactly one of the
two orderings correct. **Fix**: replaced the single pass with a BOUNDED FIXED-POINT loop (`MAX_
SETTLING_ROUNDS = 8`) over the SAME `upserted` set, repeating the identical per-path work
(`importers_of` + `resolve_import_targets_for` + `replace_file`) until two consecutive rounds
produce byte-identical `import_targets` resolutions for every upserted path (never silently capped:
logs if the bound is hit). `upserted.len() <= 1` (the overwhelming common case, a single-file edit)
always converges after exactly one extra round, unchanged cost from this function's pre-existing,
already-tested behavior.

**Result after this fix, SAME switch, SAME fixed release binary**: 19 → **3** missing relations
(84% closed) -- the `bridge.ts`/`isolated-vm-bridge.ts` pair (4 relations) is now byte-for-byte
correct; a SEPARATE, previously-hidden pair remains:
```
jsts:references:packages/cli/src/expression-observability/expression-observability.provider.ts:1515:1535:jsts:constructor:...:constructor:jsts:property:packages/@n8n/config/src/configs/expression-engine.config.ts:1322:observabilityEnabled
jsts:references:...expression-observability.provider.ts:1551:1557:...constructor:jsts:property:...expression-engine.config.ts:436:engine
jsts:references:...expression-observability.provider.ts:6049:6062:...startSpan:jsts:property:...expression-engine.config.ts:1628:tracesEnabled
```
Both `expression-observability.provider.ts` and `expression-engine.config.ts` are ALSO genuinely
edited in this same real switch (confirmed via `git diff --name-only`). The access pattern is a
TypeScript CONSTRUCTOR PARAMETER PROPERTY (`constructor(private readonly config:
ExpressionEngineConfig, ...)`) reading a member (`this.config.observabilityEnabled`) declared on a
class imported from a DIFFERENT PACKAGE (`@n8n/config`, not a relative import) -- confirmed member
enumeration for parameter properties exists (`urdira-jsts-typeflow::lib.rs`'s own dedicated test
coverage), and `collect_needed_imports_for_summary` does walk `class.members`' `type_ref`s
(covering parameter properties equally). **NOT a convergence-speed issue**: raising `MAX_SETTLING_
ROUNDS` to 8 (from the initially-tried 2) produced the IDENTICAL 899,120-relation incremental store
byte-for-byte (no "did not converge" log line either) -- the loop converges quickly to a STABLE but
WRONG fixed point for this specific pair, meaning the remaining defect is a genuine logic gap
(most likely inside `urdira-jsts-typeflow::ProgramIndex::replace_file`/`reflow_files`/
`link_importer`'s own handling of two back-to-back `replace_file` calls for a mutually-referencing
pair within one `build_index` invocation, not `typeflow.rs`'s outer wrapper), not something more
settling rounds can fix. `urdira-jsts-typeflow`'s own crate-level randomized test (`incremental_
matches_from_scratch_after_random_edit_sequences_over_synthetic_project`) applies exactly ONE
edit per step, never two related files in the same batch before a shared verification point --
this exact scenario has no crate-level coverage today. **Not fixed this session**: root-caused to
this specific interaction (localized to the file/mechanism named above, cross-package parameter-
property member access, both declaring and using file edited together) but the deeper fix (inside
`urdira-jsts-typeflow`, a different crate than this task's own primary files) was judged out of
this session's remaining budget after the `BucketedMerkleSet`/dependency-ordinal/residual-closure/
typeflow-settling fixes above. Flagged here with full repro (exact tags, exact files, exact
identities, exact comparator invocation) rather than left silently unnoticed, per this campaign's
own established practice.

### 11.5 Threshold decision: `RECONCILE_DELTA_THRESHOLD` left UNCHANGED at 0.01

Per plan §0 criterion (a): `roots_ok.graph` (raw root) reads `false` on both real git switches
before AND after every fix in this section, for a reason established as REPRESENTATIONAL and
unrelated to correctness (§11.4's own decision-11 chaining explanation) -- the raw-root check the
harness (`scripts/v4-reconcile-threshold.mjs`) uses cannot, by construction, ever read `true` for a
real switch (which always edits files), regardless of any future reference-parity fix. The
SET-based comparator (§11.4) is the correct instrument, and it still finds a real (if now much
smaller and precisely localized) reference-loss gap on the ONE real switch measured this session.
`T = 0.01` (unchanged) remains correct per R1's own formula: T only rises once a graph=true cross-
over is achievable, and it is not yet, on either measure. `--files 1008`/`2015` and the
`head-vs-head200` switch were NOT re-measured this session (time budget spent on this section's own
diagnosis/fix cycle, and the `tags-3-months` result -- 899k+ relations, 13k+ file frontier, a REAL
git-history diff -- is representative enough to leave T's own decision unambiguous either way: a
graph=true crossover is not achievable at ANY N while §11.4's own residual defect remains open). A
future task closing §11.4's own remaining 3-relation gap should re-measure both switches plus the
fraction sweep before revisiting T upward.

### 11.6 Verification (this session)

```
cargo fmt --all -- --check                                                      # clean
cargo clippy --workspace --all-targets --locked -- -D warnings                  # clean
cargo test -p urdira-indexing-worker -p urdira-jsts-syntax-worker \
  -p urdira-source-frontier -p urdira-structural-store --locked
  # 124 passed/18 ignored (indexing-worker), 300 passed (source-frontier), 46 passed
  # (structural-store unit) + every integration test binary in that crate -- 0 failed
cargo test -p urdira-indexing-core --locked                                     # 34 passed/2 ignored, 0 failed
cargo test -p urdira-indexing-worker --locked -- --ignored \
  inferred_types_and_diagnostics_across_two_runs_and_an_edit \
  residual_emits_types_and_diagnostics_with_zero_pending_sites \
  residual_first_pass_sees_a_multi_file_edits_transitive_type_dependency_outside_the_edited_set
  # 3 passed, 0 failed (URDIRA_TSGO_BINARY set)
cargo build --release --locked -p urdira-indexing-worker                        # clean
CI=true ./node_modules/.bin/vitest run tests/phase-daemon-v4-reconcile.test.ts tests/v4-scan.test.ts
                                                                                  # 3 passed, 4 skipped
```

### 11.7 Files touched

- `crates/urdira-jsts-syntax-worker/src/lib.rs`: `reresolve_file` replaced by `import_resolution_
  would_change` (cheap check) + a full reparse in the `stale_paths` loop, `validated_by_path`
  lookup added (§11.1).
- `crates/urdira-indexing-core/src/merkle_bucket.rs`: `update`'s `bucket_entries` closure contract
  now returns `(pre_change_count, post_change_entries)`; new regression test (§11.2).
- `crates/urdira-structural-store/src/merkle.rs`: `load_and_update`'s closure type updated to match.
- `crates/urdira-structural-store/src/writer.rs`: both `apply_changes_in_bucket` call sites'
  closures updated; `dep_changes` construction reordered to Deletes-first, Sets-after (§11.2).
- `crates/urdira-source-frontier/src/frontier.rs`: `apply_bucket_change`'s closure updated (§11.2).
- `crates/urdira-indexing-worker/src/v4/diff.rs`: `graph_bucket_entries` returns the tuple form too
  (§11.2).
- `crates/urdira-indexing-worker/src/v4/delta.rs`: `diff_one_owner` gains `owner_identity_changed`;
  a same-`dependency_id` edge closes+reopens (instead of staying untouched) when the owner's own
  ordinal changed this generation (§11.2).
- `crates/urdira-indexing-worker/src/v4/residual.rs`: new `expand_with_dependency_closure`, wired
  into `run_once_with_quiet_period`'s `resolved_visible_owners` on a chain's first pass; new e2e
  test (§11.3).
- `crates/urdira-indexing-worker/src/v4/typeflow.rs`: `build_index`'s warm branch now runs a
  bounded fixed-point settling loop over `pending_upserted` instead of one pass (§11.4).
- `crates/urdira-indexing-worker/src/v4/tests_e2e.rs`: new `deleting_an_imported_files_export_
  drops_the_untouched_importers_stale_references_and_matches_an_independent_oracle` (§11.1) and
  `graph_identity_set_matches_between_two_kept_stores` (§11.4, permanent diagnostic, `#[ignore]`d,
  needs two kept `--keep-data` structural roots via env vars).
- This file: §11.

### 11.8 Scratch cleanup

`~/Proyectos/urdira-benchmark/v4-fold/ep0c-{n8n-git,git-switch,git-switch-keep,git-switch-keep2,
git-switch-keep3}*` (git clones, `--keep-data` outputs) deleted at the end of this session; the
small `*-results.json` companions retained. `CARGO_TARGET_DIR` override (`.claude/worktrees/cargo-
target-ep0c`) removed. All temporary `URDIRA_DEBUG_DEPS`-gated diagnostic `eprintln!`s (in
`resolved_dependencies`/`facts_for_one_path`, `urdira-jsts-syntax-worker/src/lib.rs`) and the ad
hoc `iter_visible_deps`/`expand_with_dependency_closure` dumps (`residual.rs`) added and removed
within this session -- none survive in the final diff.

## 12. Frente E-P0d (2026-09-07): Brecha B's remaining 3 relations CLOSED exactly (0 missing/0
## phantom, raw `graph` root parity on BOTH real git switches); two NEW, narrower, out-of-scope
## gaps found live and deferred (not silently dropped)

### 12.1 Reproduction: the real n8n pair is a THREE-file interaction, not two

§11.4's own hypothesis ("most likely inside `ProgramIndex::replace_file`/`reflow_files`/
`link_importer`'s own handling of two back-to-back `replace_file` calls for a mutually-referencing
pair") was refined by re-running `scripts/v4-reconcile-threshold.mjs --git-switch --keep-data
--only-switch tags-3-months` (same tags, same command) and reading the real `git diff` for both
named files directly (`git --git-dir=<tags-clone>/.git diff <refA> <refB> -- <path>`):

- `packages/@n8n/config/src/configs/expression-engine.config.ts`: `new file mode 100644` -- BRAND
  NEW, not merely edited.
- `packages/cli/src/expression-observability/expression-observability.provider.ts`: ALSO `new file
  mode 100644` -- BRAND NEW.
- `packages/@n8n/config/src/index.ts` (the package's own barrel/re-export file): PRE-EXISTING,
  separately EDITED in the exact same diff to add BOTH `import { ExpressionEngineConfig } from
  './configs/expression-engine.config'` + `export { ExpressionEngineConfig } from './configs/
  expression-engine.config'` AND a new member of its own, `GlobalConfig.expressionEngine:
  ExpressionEngineConfig`.

So the real shape is: two BRAND NEW files (declarer + consumer), linked through a THIRD,
PRE-EXISTING file (the barrel) that is itself EDITED in the same batch to add the re-export the
consumer needs. `delta.rs::run`'s own structural/content generation split (its own doc comment,
§2 above) puts the two `Created` files in the FIRST (structural) generation and the barrel's own
`Modified` edit in the SECOND (content) generation.

### 12.2 Root cause #1 (`urdira-jsts-typeflow`): a resolution that fails in one `build_index` call
### has no way to be retried once its target becomes resolvable in a LATER, separate call

Confirmed live by temporary `eprintln!` instrumentation (added and fully reverted this session,
gated behind ad hoc env vars never referenced in production code, source-scanned clean with
`grep -rn "ep0d.*debug\|URDIRA_EP0D_DEBUG" crates/` returning empty at every checkpoint below) at
`crates/urdira-indexing-worker/src/v4/typeflow.rs`'s `resolve_import_targets_for` and `build_index`:
in the STRUCTURAL generation, `expression-observability.provider.ts`'s own `ExpressionEngineConfig`
need resolves against the barrel's STALE (pre-edit) `export_bindings` (still cached in `files`/
`project_files` for that call) -> `Unresolved`. Since `ProgramIndex::replace_file`'s own
`link_importer` call (`crates/urdira-jsts-typeflow/src/lib.rs:3454`) only ever fires for a
SUCCESSFUL `import_targets` entry, `importers_of[barrel.ts]` never learns about this edge. In the
CONTENT generation (barrel.ts's own `replace_file` call), `refresh_paths` was `importers_of(path)
+ path` only (`typeflow.rs:337`, pre-fix) -- the consumer, having no successful edge, is never
swept back in, even though `TypeflowCache`'s own `pending_upserted` entry for it was already
drained after the structural generation's own `build_index` call. A stable, wrong fixed point:
raising `MAX_SETTLING_ROUNDS` (§11.4) cannot help, because the gap spans TWO SEPARATE `build_index`
invocations, not rounds within one.

**Fix** (`crates/urdira-jsts-typeflow/src/lib.rs`): a new `ProgramIndex` field, `pending_importers_
of: HashMap<String, HashSet<String>>` (`:2852`, doc comment there has the full rationale) -- the
reverse graph for "specifier resolved to a KNOWN file, named export did not (yet)", the exact
counterpart to `importers_of`'s "successfully resolved" graph. `ProgramIndex::build` (`:3381`) now
takes a `pending_targets: &HashMap<String, HashSet<String>>` parameter and inverts it into the new
field, mirroring how `import_targets` is inverted into `importers_of`. `replace_file`/`add_file`
(`:3763`/`:3800`ish, exact lines shifted by the doc comments added) take a matching
`pending_target_updates` parameter, applied via a new `apply_pending_target_updates` (`:3679`,
mirrors `apply_import_target_updates`'s own "full snapshot per owning path, never a partial patch"
discipline). `transitive_importers_closure` (`ProgramIndex`'s own BFS the affected/reflow set is
built from) now ALSO walks `pending_importers_of` edges, alongside `importers_of`. `remove_file`
clears a removed path's own outgoing pending edges too, for symmetry with `clear_owning_path_
import_targets`. New public accessor `pending_importers_of(&self, path) -> Vec<String>` mirrors
`importers_of`.

Caller side (`crates/urdira-indexing-worker/src/v4/typeflow.rs`): `resolve_import_targets_for`
(`:442`) now returns `(HashMap<(String,String,String),String>, HashMap<String,HashSet<String>>)`
-- the second element records, for EVERY path it was asked about (an empty set when there is
nothing pending, so a caller applying it as a snapshot correctly clears stale pending edges too),
which target files a `resolve_named_export` call left `Unresolved`/`Ambiguous`/`Namespace` against.
`build_index`'s warm settling loop (`:253` onward) widens `refresh_paths` with `index.pending_
importers_of(path)` alongside `index.importers_of(path)`, and the convergence check now also
compares the round's merged `pending` map (`previous_round_pending`), not just `round_updates`.

### 12.3 Root cause #2 (`urdira-jsts-typeflow`): `entity_owner` never held a TYPE ALIAS's own id,
### so `link_importer` silently no-op'd for every import resolving to one

Found while re-verifying `head-vs-head200` (a much larger real switch, 1971 changed files) after
fix #1: `graph=false` still, with a NEW, DIFFERENT 23-relation gap. `git diff --name-status`
confirmed the affected test files (`packages/workflow/test/metadata-utils.test.ts`, two
`scoped-jwt.strategy*.test.ts`) are byte-IDENTICAL at both ends of the switch (never edited, never
added) -- pure "unedited importer of an edited file" cases, the ORIGINAL id-shift scenario §11.4
already partially fixed. Debug instrumentation showed the culprit: `workflow/src/interfaces.ts`
exports `IExecuteFunctions` as `export type IExecuteFunctions = ...` (a TYPE ALIAS, resolved to
`jsts:type:...`, not a class/interface). `insert_file_pass1` (`crates/urdira-jsts-typeflow/src/
lib.rs`) registers `entity_owner` for classes/interfaces/functions/callable-variables/object-
shapes/variables (six separate loops) but NEVER for `summary.type_aliases` -- so `link_importer`'s
own `self.entity_owner.get(target_entity_id)` lookup (`:3495`-ish) always missed for a type-alias
target, meaning `importers_of`/`transitive_importers_closure` could NEVER widen to reach a file
whose only edge to another file goes through a type alias. Confirmed via `refresh_paths.len()=38,
contains_metadata_test=false` when processing `interfaces.ts`'s own turn, even though the SAME
file's `IExecuteFunctions` resolution had ALREADY succeeded at cold-scan time (an id existed,
`link_importer` was called, it just silently did nothing).

**Fix**: `insert_file_pass1` gains a seventh loop, over `summary.type_aliases`, registering
`entity_owner`/`owned_entities` for each alias id (`crates/urdira-jsts-typeflow/src/lib.rs:3093`).
Deliberately does NOT touch `containers`/`function_return_types`/`variable_types` (a raw alias id
is never queried against them -- every `import_targets` consumer runs the id through `dealias_
entity` first, per `resolve_raw_type_ref`'s own `Imported` arm) and does not touch `alias_targets`
(built wholesale by `build_alias_targets`, independent of `entity_owner`) -- purely additive for
`link_importer`'s own lookup.

### 12.4 Result: both real git switches now graph-identical to an independent oracle

Re-ran `scripts/v4-reconcile-threshold.mjs --git-switch --keep-data` for both switches against the
SAME fixed release binary (both fixes applied):

| switch | changed files | `roots_ok.dependency` | `roots_ok.graph` (raw root) | `CATEGORY_RELATION` set diff |
|---|---:|---|---|---|
| `tags-3-months` (`n8n@1.123.25` -> `n8n@1.123.56`) | 504 | true | **true** | incremental 899,123 / oracle 899,123 -- 0 phantom, 0 lost |
| `head-vs-head200` (`HEAD~200` -> `HEAD`) | 1,971 | true | **true** | incremental 1,817,090 / oracle 1,817,090 -- 0 phantom, 0 lost |

Both switches now clear the RAW Merkle root check (`graph=true`), not merely the SET comparator --
stronger than the task's own bar ("relaciones faltantes = 0 y `graph` set-equal"). `dependency`
was already `true` both before and after (unaffected by this fix). Full `cargo test -p urdira-
indexing-worker --release --locked v4::tests_e2e::graph_identity_set_matches_between_two_kept_
stores -- --ignored --nocapture` output (both switches) retained this session's own terminal
history; the counts above are copied verbatim from those runs.

### 12.5 Tests added

`crates/urdira-jsts-typeflow/src/lib.rs` (crate-level, raw `ProgramIndex` API, both against an
independent from-scratch oracle):
- `importers_of_tracks_a_file_that_only_imports_a_type_alias_and_survives_the_aliased_files_own_
  edit` -- regression for §12.3: asserts `importers_of` itself (the mechanism) includes the
  importer, then that an incremental edit of the aliased file matches a fresh rebuild.
- `pending_importers_of_lets_a_later_edit_satisfy_a_previously_unresolved_import` -- regression for
  §12.2 at the raw API level: a consumer's need is initially unresolved (target file known, export
  not), asserts `pending_importers_of` tracks it, then that the declarer's later edit (adding the
  export) both satisfies it and clears the pending edge.

`crates/urdira-indexing-worker/src/v4/typeflow.rs` (`TypeflowCache`/`build_index`, real
`SyntaxWorkerState::analyze`-backed `files` maps, both path orders where relevant, all against an
independent from-scratch oracle):
- `member_access_through_a_constructor_parameter_property_survives_a_same_batch_multi_file_edit_
  {declarer_first,user_first}` -- two PRE-EXISTING files edited together (§11.4's own original
  brief), both orders.
- `member_access_through_a_constructor_parameter_property_survives_an_add_add_batch_{declarer_
  first,user_first}` -- both files BRAND NEW in the same batch, added to an already-warm cache.
- `member_access_through_a_reexporting_barrel_edited_in_the_same_batch_{matches_real_n8n_path_
  order,reverse_path_order}` -- the ACTUAL real n8n shape: declarer + consumer NEW, a THIRD,
  pre-existing barrel EDITED in the same batch to re-export the declarer and gain its own new
  member typed with it.

Note: the first two pairs above do NOT by themselves reproduce §12.2's own gap (confirmed
empirically -- both pass even against the pre-fix code, since the 2-file interaction alone always
resolves correctly regardless of `BTreeSet` iteration order; only the 3-file barrel shape does).
Kept anyway as coverage for the interaction space the reduction ruled out, and because the module's
own doc comment now needs *some* test proving each of those two shapes independently. `cargo test
-p urdira-jsts-typeflow -p urdira-indexing-worker --locked`: **130 passed** (urdira-indexing-worker,
18 ignored -- tsgo/residual/manual-diagnostic), **57 passed** (urdira-jsts-typeflow, 0 ignored), 0
failed.

An e2e test in `tests_e2e.rs` reproducing the full 3-file shape through the REAL production path
(`scan::run_with_residual` -> `delta::run`'s own structural/content split) was attempted and then
DELIBERATELY NOT KEPT -- see §12.6 for why, and what it found instead.

### 12.6 Two NEW, narrower, out-of-scope gaps found by the (removed) e2e attempt -- flagged, not
### fixed, not reproduced at real n8n scale

Building the 3-file fixture (barrel pre-existing + edited, declarer + consumer brand new, both in
one mixed `ScanScope::Changed` batch) through the real pipeline (`crates/urdira-indexing-worker/
src/v4/tests_e2e.rs`) surfaced relations STILL missing even with both §12.2/§12.3 fixes applied,
all attributable to `urdira-jsts-syntax-worker` (a DIFFERENT crate, out of this task's own "only
`urdira-jsts-typeflow`, `typeflow.rs`/`analyze.rs` call points" scope, confirmed by grep: `REASON_
IMPORT_BINDING`/`resolve_import_binding`/`import_bindings_ref` in `semantic_sites.rs`, nothing to
do with `urdira-jsts-typeflow`):

1. **A brand-new consumer's OWN import-declaration reference is resolved once, never retried
   across generations.** `import { Repo } from './barrel'`'s own `jsts:references` relation
   (source `jsts:module:...:0:...`, i.e. the import statement's own token, not typeflow-mediated
   at all) is computed when the consumer is FIRST analyzed (the structural generation, before the
   barrel's own edit lands) and is never recomputed once the barrel becomes resolvable, because a
   brand-new file has no PRIOR state for `urdira-jsts-syntax-worker`'s own "import resolution would
   change" reparse trigger to compare against.
2. **A swept-in (not-directly-edited) owner can be reprocessed against a STALE dependency
   snapshot.** Adding a second import (`Other`, already resolvable since cold, mirroring
   `GlobalConfig` in the real n8n pair) DOES get the consumer's reverse-affected edge established,
   and it IS revisited in the content generation -- but the resulting relation used the barrel's
   OLD (pre-edit) entity id for `Other`, not the new one, while the SAME generation's `files` map
   is confirmed fresh (typeflow's own resolution against it succeeds correctly). Some part of
   `urdira-jsts-syntax-worker`'s own incremental caching, for an owner that is "affected" but not
   itself in `changed_artifact_ids`, appears to reuse a previously-computed resolution rather than
   recomputing it against the current generation's data.

Neither is reproduced by the real `tags-3-months`/`head-vs-head200` verification (§12.4: 0 missing,
0 phantom, `graph=true` on both) -- real n8n consumers of a shared barrel consistently import
MULTIPLE names, at least one already resolvable before the edit (exactly like the `Other`/
`GlobalConfig` pattern above), which is enough for `urdira-jsts-syntax-worker`'s own reverse-
affected closure to sweep them back in; only finding (2) would still apply there, and it evidently
does not manifest at real corpus scale for reasons not further investigated this session (possibly
narrower conditions than this fixture's own minimal reduction hits). Per plan §0 criteria (a)-(c):
neither blocks E-P0d's own acceptance bar (both real switches fully green), both are genuine,
reproducible-by-reduction gaps in a crate this task is not scoped to touch, and are recorded here
with full repro (fixture shape, exact relation identities, exact file/line pointers into `semantic_
sites.rs`) rather than left silently unnoticed, per this campaign's own established practice --
follow-up for whoever next owns `urdira-jsts-syntax-worker`'s own reverse-affected-closure/
incremental-caching layer.

### 12.7 Threshold decision: `RECONCILE_DELTA_THRESHOLD` left UNCHANGED at 0.01

R1's own formula (T = crossover ratio x 0.8, only once a `graph=true` crossover is achievable) is
NOW achievable in principle (§12.4), which R1 itself names as the precondition to re-measure and
possibly RAISE T. Re-measuring requires the full fraction-sweep harness (`--fractions 0.01,0.05,
0.10,0.25,0.50 --repeat 2`, §2's own original methodology) against a fresh n8n corpus copy --
a separate, comparably expensive measurement this session's own remaining budget (spent on the
diagnosis/fix/re-verification cycle across two real git-switch corpora, §12.1-§12.4) did not
cover. T=0.01 remains SAFE regardless: T only ever moves which pipeline runs (delta vs cold), never
the result (`run_reconcile`'s own doc comment, R1's own invariant, now proven true end-to-end by
§12.4's own `graph=true` result at T=1 forcing the delta path on both real switches) -- leaving T
unchanged costs nothing but a still-conservative threshold, never a correctness risk. Flagged as
the natural next measurement for a follow-up session, not attempted here as it would have displaced
this session's own diagnosis work without changing the acceptance criteria's own outcome.

### 12.8 Verification (this session)

- `cargo fmt --all -- --check`: clean (after `cargo fmt --all` reformatted the new test bodies).
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: clean (two `#[allow(clippy::
  type_complexity)]` added for the new `(HashMap<(String,String,String),String>,
  HashMap<String,HashSet<String>>)` return type shared by `resolve_import_targets_for` in both
  `urdira-jsts-typeflow`'s own test-local mirror and `v4/typeflow.rs`'s real one; one `to_owned()`
  removed on an already-`&str` parameter).
- `cargo test -p urdira-jsts-typeflow -p urdira-indexing-worker --locked`: 130 + 57 passed, 0
  failed, 18 ignored (tsgo/residual/manual-diagnostic-env-var tests, unaffected by this session).
- `cargo test -p urdira-indexing-worker --locked -- --ignored inferred_types_and_diagnostics_
  across_two_runs_and_an_edit residual_emits_types_and_diagnostics_with_zero_pending_sites`
  (`test:native`'s own curated residual gate, `URDIRA_TSGO_BINARY` set): both `ok`.
- `cargo build --release --locked -p urdira-indexing-worker`: succeeds.
- `git diff --stat -- packages/plugin-javascript-typescript/src/indexing-core-process-transport.
  ts`: empty (temporary debug-env-var forwarding added and fully reverted; confirmed via `grep -rn
  "ep0d.*debug\|URDIRA_EP0D_DEBUG" crates/ packages/plugin-javascript-typescript/src/` returning
  nothing at the final checkpoint).
- `crates/urdira-indexing-worker/src/main.rs` and `crates/urdira-jsts-syntax-worker/src/semantic_
  sites.rs` needed a MECHANICAL, behavior-neutral third-argument update at their own (pre-existing,
  test-only for the latter) `ProgramIndex::build` call sites, since this task's own `pending_
  targets` parameter is not optional -- `main.rs`'s own v3 prototype always cold-rebuilds (never
  calls `replace_file` incrementally, so an empty map is exactly its own pre-existing behavior);
  `semantic_sites.rs`'s 7 call sites are all inside its own `#[cfg(test)]` module.

### 12.9 Files touched

- `crates/urdira-jsts-typeflow/src/lib.rs`: new `ProgramIndex::pending_importers_of` field +
  accessor; `build`/`replace_file`/`add_file`/`remove_file`/`transitive_importers_closure` gain
  `pending_target(s)`-flavored parameters/widening; new `apply_pending_target_updates`;
  `insert_file_pass1` gains a `type_aliases` -> `entity_owner` loop (§12.3); test-local `compute_
  import_targets_for` gains a matching `pending` return; 2 new tests (§12.5).
- `crates/urdira-indexing-worker/src/v4/typeflow.rs`: `resolve_import_targets_for` returns a
  `(import_targets, pending_targets)` tuple; `build_index`'s warm settling loop widens
  `refresh_paths` with `pending_importers_of` and tracks `pending` convergence too; 6 new tests
  (§12.5).
- `crates/urdira-indexing-worker/src/main.rs`: `build_typeflow_program_index`'s own `ProgramIndex::
  build` call gains an empty `pending_targets` argument (mechanical, behavior-neutral, §12.8).
- `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`: 7 test-only `ProgramIndex::build` call
  sites gain the same empty argument (mechanical, behavior-neutral, §12.8).
- This file: §12.

### 12.10 Scratch cleanup

`~/Proyectos/urdira-benchmark/v4-fold/ep0d-{vcswitch,vcswitch2,vcswitch3,vcswitch4,vcswitch5,
vcswitch-fixed,head200-safe,head200-fixed,head200-debug,head200-debug2,tags-final,git-switch}*`
(git clones, `--keep-data` outputs) deleted at the end of this session; the small `*-results.json`
companions retained. `CARGO_TARGET_DIR` override (`.claude/worktrees/cargo-target-ep0d`) removed.
All temporary `URDIRA_EP0D_DEBUG*`-gated diagnostic `eprintln!`s (in `resolve_raw_type_ref`/
`resolve_import_targets_for`/`build_index`, both crates) and the matching temporary env-var
forwarding line in `indexing-core-process-transport.ts` added and removed within this session --
confirmed absent from the final diff (§12.8).

## §13. E-P0d adversarial review (2026-09-07, `frente-ep0d-typeflow-reflow`, commit `d0328b0`)

Reviewer session, worktree `.claude/worktrees/agent-a3835ec59c4fd1383`, `CARGO_TARGET_DIR` override
`.claude/worktrees/cargo-target-ep0d-rev` (removed at the end of this session).

### 13.1 Findings

1. **`cargo fmt --all -- --check` FAILED at `d0328b0`** (build-gating, not a logic bug):
   `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`'s 7 mechanical `ProgramIndex::build`
   call-site updates (§12.8's own "third-argument update" note) were never run through `cargo fmt`
   before the commit -- 7 call sites exceeded the line-length limit unwrapped. §12.8 claims "clean
   (after `cargo fmt --all` reformatted the new test bodies)", which was true for the test bodies
   but not these call sites. Fixed by running `cargo fmt --all` (whitespace-only, re-verified with
   `--check`).

2. **`ProgramIndex::remove_file` never cleared `pending_importers_of`'s TARGET-keyed entry for the
   removed path itself** (`crates/urdira-jsts-typeflow/src/lib.rs`, `remove_file`, pre-fix ~line
   3904) -- a real, if narrow, violation of the field's own doc comment ("real corpora keep this
   small"). The pre-fix cleanup, `apply_pending_target_updates(&{path: {}})`, only ever removes
   `path` as a VALUE inside some OTHER target's importer set (the IMPORTER side, correctly handled
   -- confirmed by inspection, this is the half the review's attack #1 asked about: "¿se limpian al
   reemplazar/borrar el fichero importador?" -- yes). It never touches the entry keyed by `path`
   ITSELF, i.e. the case where `path` is a barrel/target OTHER files still have an unresolved need
   pointing at. Deleting such a file (a real event: any barrel/re-export file can be deleted, not
   just edited) left that entry permanently stranded -- self-healing only if the orphaned importer
   happens to be reprocessed later for an unrelated reason, otherwise an unbounded-over-a-long-
   session leak. Confirmed asymmetric with the RESOLVED graph's own handling:
   `purge_import_targets_targeting_file` (same file) cleans up `import_targets`/`importers_of` in
   BOTH directions when a file is removed; `pending_importers_of` only had one of the two. **Not**
   the "unbounded growth from external/node_modules imports" shape attack #1 led with -- that shape
   does NOT occur: `resolve_import_targets_for` (`crates/urdira-indexing-worker/src/v4/typeflow.rs`
   :442) only ever inserts into `pending_targets` after `resolver.resolve(...)` already succeeded
   (a specifier that resolves to NO workspace file at all -- every third-party package, every
   genuinely broken import -- hits the `continue` above it and is never recorded), confirmed
   empirically in §13.2 below. **Fix**: `remove_file` now also calls
   `self.pending_importers_of.remove(path)`, with a doc comment explaining why (the orphaned
   importer is not itself lost -- it was already captured into `affected` via
   `transitive_importers_closure` BEFORE the removal, using the same map, so it still gets reflowed
   and correctly degrades to "unresolved", exactly like a from-scratch rebuild without `path`).
   Regression test: `remove_file_clears_the_pending_importers_of_entry_keyed_by_the_removed_target_itself`
   (`crates/urdira-jsts-typeflow/src/lib.rs`) -- a new `#[cfg(test)]`-only accessor,
   `pending_importers_of_entry_count`, was added since `pending_importers_of(path)`'s own public
   accessor cannot distinguish "key absent" from "key present but empty" from the outside, and the
   leak is specifically about the KEY surviving.

3. **Attack #2 (alias/value name collision in `entity_owner`)**: reviewed by inspection, no bug
   found, no fix needed. `entity_owner` is keyed by `entity_id` (a per-declaration-node id, not a
   bare name), and `insert_file_pass1`'s new `type_aliases` loop (§12.3) inserts under `alias.id` --
   `export type Foo = ...` and `export const Foo = ...` in the same module produce two DIFFERENT
   entity ids (different declaration kinds/positions), so there is no key collision in the map
   itself. Which of the two a named import resolves to for a given usage (type position vs value
   position) is `resolve_named_export`'s own concern (`urdira-jsts-syntax-worker`), independent of
   this fix.

4. **Attack #3 (determinism / two-generation coverage)**: the 6 new tests in `v4/typeflow.rs` DO
   cover reverse path order (`..._reverse_path_order`) and both "pre-existing pair" / "add-add pair"
   orderings, confirmed by reading them. **Gap found**: NONE of the 6 actually calls `build_index`
   TWICE with the barrel's own edit landing in a SEPARATE, LATER call -- every one upserts all
   three files (declarer/consumer/barrel) before a SINGLE `build_index` call, which only exercises
   the WARM SETTLING LOOP's within-one-call fixed point (`MAX_SETTLING_ROUNDS`), never
   `pending_importers_of`'s own claimed cross-call persistence -- the literal mechanism this whole
   task's first root cause (§12.2) targets, and the literal shape `delta.rs::run`'s structural/
   content split produces in production. Added
   `member_access_through_a_reexporting_barrel_edited_in_a_later_separate_build_index_call`
   (`crates/urdira-indexing-worker/src/v4/typeflow.rs`), which calls `build_index` once for the
   two brand-new files (barrel still stale) and AGAIN, separately, after the barrel's own edit --
   **passes**, confirming the persistence claim holds end-to-end at this API layer, not just in
   principle.

5. **Attack #4 (§12.6 finding #1) -- targeted synthetic, NEGATIVE RESULT**: built
   `brand_new_declarer_and_consumer_linked_through_a_same_batch_edited_barrel_matches_an_independent_oracle`
   (`crates/urdira-indexing-worker/src/v4/tests_e2e.rs`) against the REAL production path
   (`scan::run_with_residual` -> `delta::run`'s mixed-burst split), using the `task-planner` fixture:
   a brand-new declarer (`src/domain/new-thing.ts`) and a brand-new consumer
   (`src/new-consumer.ts`, importing `NewThing` from the barrel `./index.js` through a constructor
   parameter property) both `Created` in the same batch as the barrel (`src/index.ts`, pre-existing)
   being `Modified` to add the re-export -- forces the exact two-generation structural/content
   split. Graph and dependency roots matched an independent from-scratch oracle of the same final
   tree. **Did not reproduce** finding #1 (the import-declaration's own `jsts:references` staying
   stale) at this fixture's scale, through the real pipeline -- consistent with the evidence doc's
   own §12.6 note that the two real n8n git switches (§12.4) also never hit it. Not investigated
   further (would require reconstructing the evidence author's own removed raw e2e attempt, whose
   exact trigger is not preserved anywhere in the tree); recorded here as the negative result per
   plan §0's own instruction, with the exact fixture kept in the tree as production-path coverage
   for this shape either way.

6. **Attack #5 (§12.6 finding #2) -- targeted synthetic, NEGATIVE RESULT**: built
   `swept_in_untouched_owner_reflects_the_same_batchs_edited_dependency_and_matches_an_independent_oracle`
   (`crates/urdira-indexing-worker/src/v4/tests_e2e.rs`), the exact shape the review brief
   specified: `a.ts` (edited, its exported class's method return type shifts `number` -> `string`),
   `b.ts` (never edited, never named in the batch's own `ChangedPath`s -- purely swept in via
   `importers_of`, reads `a.ts` through a constructor parameter property), `c.ts` (edited in the
   SAME batch, imports BOTH `a.ts` directly and `b.ts`, whose own return type now transitively
   depends on `a.ts`'s new shape). A pure two-file content edit (`a.ts`+`c.ts` both `Modified`)
   deliberately never needs the mixed-burst split, isolating the same-generation reverse-affected
   sweep alone. Graph and dependency roots matched an independent from-scratch oracle. **Did not
   reproduce** finding #2 (a swept-in owner reprocessed against a stale dependency snapshot) at
   this fixture's scale either. Same disposition as #5 above -- negative result recorded, fixture
   kept as coverage.

### 13.2 `pending_importers_of` size on a real n8n cold scan

Measured with a temporary, session-only `eprintln!` in `ProgramIndex::build`
(`crates/urdira-jsts-typeflow/src/lib.rs`, gated behind the ALREADY-forwarded `URDIRA_DEBUG_TIMING`
env var -- confirmed via `grep` that the child-process transport
(`packages/plugin-javascript-typescript/src/indexing-core-process-transport.ts`) only forwards an
explicit allowlist of env vars to the worker subprocess, so a brand-new ad hoc var name would
silently never reach it; this is exactly why the FIRST attempt at this measurement, using a new
`URDIRA_EP0D_REVIEW_DEBUG` var, printed nothing), added and fully reverted this session (confirmed
absent via `grep -rn "ep0d-review\|EP0D_REVIEW_DEBUG" crates/` returning empty at the final
checkpoint). Built to an ISOLATED `CARGO_TARGET_DIR` (`.claude/worktrees/cargo-target-ep0d-measure`,
removed at the end) to avoid disturbing the shared release binary the git-switch verification
(§13.3) was using concurrently. Cold-scanned `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`
(14,082 JS/TS files) via `scripts/v4-scan.mjs`:

```
[ep0d-review] pending_importers_of: 16 target keys, 47 total importer edges
```

16 target keys / 47 importer edges out of 14,082 files -- confirms the field's own doc comment
("real corpora keep this small") empirically, and confirms finding #1's own worry (unbounded growth
from external/`node_modules` imports) does not occur in practice, consistent with the design-level
reasoning in §13.1 item 2 above (`resolve_import_targets_for` never records a specifier with no
resolved target file at all).

### 13.3 Real git-switch re-verification (this branch's own binary + fix #2 above)

`node scripts/v4-reconcile-threshold.mjs --git-switch --git-repo ~/Proyectos/n8n --only-switch
tags-3-months --git-tag-a n8n@1.123.25 --git-tag-b n8n@1.123.56 --git-head-back 200` (the
`--git-head-back` flag is required by the script's own arg parser even when `--only-switch` narrows
to one switch, unused for `tags-3-months`), against the release binary built from this session's
final tree (fix #2 above included):

```
[git-switch:tags-3-months] cold@n8n@1.123.25: 14542.5ms; reconcile(T=1)@n8n@1.123.56: 34095.3ms mode=delta metadata_refreshed=0
[git-switch:tags-3-months] roots_ok vs independent oracle of n8n@1.123.56: dependency=true graph=true
```

504 changed files (168 added, 330 changed, 7 deleted), `dependency=true`, `graph=true` -- 0
missing/0 phantom, matching §12.4's own result and confirming this session's `remove_file` fix (item
2, §13.1) did not regress the real-corpus switch it did not target.

### 13.4 Verification (this session, final)

- `cargo fmt --all -- --check`: clean (after the fmt fix, item 1 above).
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: clean.
- `cargo test -p urdira-jsts-typeflow -p urdira-jsts-syntax-worker -p urdira-indexing-worker
  --locked`: **urdira-indexing-worker 133 passed** (130 baseline + 1 remove_file regression test +
  2 new `tests_e2e.rs` negative-result coverage tests), 18 ignored; **urdira-jsts-syntax-worker 300
  passed**; **urdira-jsts-typeflow 58 passed** (57 baseline + 1 remove_file regression test); 0
  failed.
- `cargo test -p urdira-indexing-worker --locked -- --ignored
  inferred_types_and_diagnostics_across_two_runs_and_an_edit
  residual_emits_types_and_diagnostics_with_zero_pending_sites` (`URDIRA_TSGO_BINARY` set): both
  `ok`.
- `cargo build --release --locked -p urdira-indexing-worker`: succeeds.
- Real n8n `tags-3-months` git switch (§13.3): `dependency=true graph=true`, 0 missing/0 phantom.

### 13.5 Verdict

**APPROVED with fixes applied.** Two real bugs found and fixed in this session (fmt-clean build gate,
`remove_file`'s pending-graph leak); one design worry (unbounded pending-graph growth from external
imports) investigated and ruled out by both inspection and a real 14k-file measurement (16 keys/47
edges); one test-coverage gap (cross-generation persistence never actually exercised) closed with a
new, passing test; both §12.6 out-of-scope findings re-attempted with targeted synthetics through the
real production path and NOT reproduced, recorded as negative results per plan §0. The real
`tags-3-months` n8n switch remains `graph=true`/`dependency=true` with this session's fix applied.
