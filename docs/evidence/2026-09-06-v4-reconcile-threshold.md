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
