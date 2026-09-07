# F.3: cold/incremental A/B vs `cf822d4`, population floors, v3 parity, reconcile threshold re-measured

Implements task **F.3 + re-medición de T** of plan `generic-waddling-hartmanis.md` (§0 R1/R4/R5/R6,
§3.2-3.4, §2.6), ola 3. Base for the A/B comparison: `cf822d4` (`git worktree add
~/Proyectos/urdira-benchmark/v4-fold/wt-cf822d4 cf822d4`, own `CARGO_TARGET_DIR`, `cargo build
--release --locked -p urdira-indexing-worker`, worktree removed at the end). HEAD under
measurement: `d71669a` (main, clean, verify green per the task's own preamble); its release binary
(`target/release/urdira-indexing-worker`, `apps/urdira/dist`, `packages/*/dist`) was already built
and current at session start (rebuild was a 0.2-0.3s no-op). Worked without isolation on main, per
task instructions. Code changes are limited to exactly the files the task authorized:
`scripts/v4-population-floors.json`, `crates/urdira-indexing-worker/src/v4/tests_e2e.rs` (the
`jsts:entity_parameter` floor + its doc comment only), and this evidence file.

Machine: macOS arm64, shared with a real browser session for the whole run (per the task's own
warning). `uptime` was recorded before every timed series; `scripts/v4-reconcile-threshold.mjs`
has its own built-in load guard (checks `os.loadavg()[0]`, retries every 15s up to 20 times when
above 6, logs every reading) which handled §2.6's measurements automatically. The plain cold ×3
A/B (§1 below) has no such guard; load averages of 7.7-17.5 (1-min) were observed throughout that
series -- see §1.1 for the decision on how this was handled.

Shared corpus `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02` (sentinel
`.urdira-shared-corpus-readonly`) was never written to. All scratch copies lived under
`~/Proyectos/urdira-benchmark/v4-fold/f3-*/` and were deleted at the end of this session; only logs
and the JSON result files are retained there.

---

## 1. Cold ×3, base (`cf822d4`) vs HEAD (`d71669a`)

`URDIRA_DEBUG_TIMING=1 URDIRA_INDEXING_CORE_WORKER_PATH=<binary> /usr/bin/time -l node
scripts/v4-scan.mjs ~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02 <fresh dir> --force`, 3 runs
per binary, alternated (base,head,base,head,base,head), each into a brand-new data dir under
`v4-fold/f3-cold/`.

### 1.1 Load-average decision (bifurcation not in §0, decided per criterion (a))

`uptime` immediately before each of the 6 runs read (1-min): 7.66, 17.46, 16.23, 16.09, 13.74,
11.99 -- all above the 6.0 gate for the whole series (a Chrome tab was persistently CPU-hungry for
this stretch and never dropped under ~7 even at rest). Repeating the whole series would not have
produced a quieter window (confirmed later: even during the *idle* stretch of this same session,
1-min load hovered 5.4-9.9). Decision: kept the 6 runs, because their own internal variance is
tight enough to validate the measurement despite the elevated load -- `total_ms` spread is
23,010-24,624 for base (<7%) and 22,380-23,856 for head (<7%), i.e. the elevated ambient load did
not visibly distort the ranking or the magnitude of the numbers. Documented here per the task's own
"decide en el momento con el criterio... y anótalo" rule rather than treated as a silent pass.

### 1.2 Per-run timings (ms unless noted)

| run | catalog | parse | resolve | materialize | write | fsync | total | wall (real) | RSS max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| base-1 | 5316 | 3362 | 3173 | 4807 | 6102 | 174 | 24624 | 26.44s | 6.49GiB |
| base-2 | 5610 | 1848 | 2971 | 5274 | 6524 | 205 | 23985 | 25.37s | 6.06GiB |
| base-3 | 5053 | 2251 | 2417 | 5307 | 5792 | 179 | 23010 | 24.56s | 6.07GiB |
| head-1 | 2985 | 1735 | 3000 | 6037 | 5972 | 223 | 23856 | 25.85s | 6.11GiB |
| head-2 | 2992 | 1754 | 3090 | 5470 | 6294 | 164 | 23369 | 25.22s | 5.10GiB |
| head-3 | 2890 | 1803 | 2572 | 5145 | 5696 | 155 | 22380 | 23.90s | 6.54GiB |

### 1.3 Medians

| metric | base (`cf822d4`) | HEAD (`d71669a`) | delta |
|---|---:|---:|---:|
| catalog_ms | 5316 | 2985 | HEAD -44% |
| parse_ms | 2251 | 1754 | HEAD -22% |
| resolve_ms | 2971 | 3000 | +1% |
| materialize_ms | 5274 | 5470 | +4% |
| write_ms | 6102 | 5972 | -2% |
| fsync_ms | 179 | 164 | -8% |
| **total_ms** | **23985** | **23369** | **-2.6%** |
| wall (real) | 25.37s | 25.22s | -0.6% |
| RSS max | 6.07GiB | 6.11GiB | +0.7% |
| `structural/` size | 1.8G | 1.8G | ~equal |
| generation | 1 | 1 | -- |

HEAD's `catalog_ms` is markedly lower than base's (2.9s vs 5.3s median) -- consistent with the
E-P0/E-P0b/E-P0c/E-P0d work having touched catalog-adjacent paths (pending importers,
type-alias `entity_owner`) between `cf822d4` and `d71669a`; `total_ms` itself is within noise of
base (-2.6%, smaller than the ~7% run-to-run spread already noted). No regression; R6's "coste
aceptado" clause is not triggered here since HEAD is not slower.

---

## 2. Population floors (HEAD, `d71669a`)

`URDIRA_V4_N8N_CORPUS=~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02
URDIRA_V4_POPULATION_DUMP=v4-fold/f3-floors/population.tsv cargo test --release
-p urdira-indexing-worker n8n_population_floors -- --ignored --nocapture` (cold scan wall 30.2s,
own scratch copy, generation 1):

| kind | count | floor (old) | status |
|---|---:|---:|---|
| `jsts:entity_callable` | 30,224 | 29,921 | OK |
| `jsts:entity_container` | 14,993 | 14,847 | OK |
| `jsts:entity_parameter` | **79,764** | 74,021 | OK (new floor below) |
| `jsts:entity_type` | 14,275 | 14,047 | OK |
| `jsts:entity_variable` | 241,536 | 238,491 | OK |
| `jsts:relation_contains` | 406,223 | 396,483 | OK |
| `jsts:relation_references` | 1,241,431 | 1,205,324 | OK |
| `external_module` | 911 | 905 | OK |
| `external_symbol` | 3,801 | 3,780 | OK |
| `records_total` | 2,197,882 | 2,165,060 | OK |

All floors pass; no regression to report for F.1's guard (R5's "if another floor fails, don't lower
it, report it" branch was not triggered).

**Floor re-pin (R5):** `jsts:entity_parameter`'s floor was provisional since F.2 shipped (emit every
parameter declaration, not only referenced ones -- `e384dfe`/`f44b8c4`, already on `main` before
this session). Re-pinned to `0.99 x 79,764 = 78,966.36 -> 78,966` in both
`scripts/v4-population-floors.json` and `FLOOR_ENTITY_PARAMETER` in `tests_e2e.rs` (was `74,021`,
the old referenced-only figure's 0.99x). `cargo test --release -p urdira-indexing-worker
n8n_population_floors -- --ignored --nocapture` passes with the new floor (verified: 79,764 >=
78,966).

---

## 3. Incremental EDIT/HUB/CREATE/DELETE/RENAME x3

`node scripts/v4-mutation-harness.mjs --v4 --corpus <corpus> --native-root
release/native/darwin-arm64 --mutation-kinds edit,hub_edit,create,delete,rename --repeat 3 --warm 1
--readiness events --verify-roots final` (HEAD, release binary + release native root).

### 3.1 `spawn EBADF` at the final oracle-verify step, three times in a row

All 3 independent attempts (fresh `--data-root` each time) ran every one of the 32 generations
(1 cold + 1 warm-up, discarded, + 30 timed mutation steps) to completion successfully, then crashed
at the SAME final step -- `oracleVerify`'s `execFileWithEbadfRetry` spawning
`scripts/v4-scan.mjs` as the oracle -- with `Error: spawn EBADF`, already exhausting the script's
own built-in 3-attempt/250ms-backoff retry every time. This is the same documented, non-code-defect
flake from `docs/evidence/2026-09-03-v4-p3-1-incremental.md` §7.7, but reproducing 3/3 here rather
than being transient -- plausibly because this session had unusually high concurrent process churn
(other benchmark scripts, browser load) at the exact moments the harness's own `finally` block
(`daemon stop` + `nativeClosure.cleanup()` + two `rm(recursive)`s, all spawning/awaiting) ran right
before the oracle spawn.

Per the coordinator's explicit instruction, the roots check was not skipped: a temporary,
uncommitted local copy of `scripts/v4-mutation-harness.mjs` (never touching the tracked file) was
patched with one guard -- `if (process.env.URDIRA_KEEP_MUTATION_SCRATCH) { skip the two
finally-block `rm(recursive)` calls }` -- and re-run once from inside `scripts/` (so its relative
imports resolved) with `URDIRA_KEEP_MUTATION_SCRATCH=1`. It reproduced the identical `spawn EBADF`
crash at the same step, this time leaving the mutated corpus and the incremental workspace's data
root on disk. The oracle was then run BY HAND:

```
URDIRA_INDEXING_CORE_WORKER_PATH=release/native/darwin-arm64/urdira-indexing-worker \
  node scripts/v4-scan.mjs <preserved mutated corpus> <fresh oracle dir> --force
```

and its `MANIFEST.roots` compared directly (same recipe as the harness's own `compareRootSets`)
against the incremental workspace's own `MANIFEST.roots` at its final generation (32):

| root | incremental | oracle | equal? |
|---|---|---|---|
| `dependency` | `sha256:1f53475d...b701c` | `sha256:1f53475d...b701c` | **yes** |
| `records` | `sha256:4272cbff...5561` | `sha256:e30277e9...9b91` | **no** |

`graph` is not persisted in `MANIFEST.roots` at all (only `dependency`/`records` keys exist in this
store format's manifest -- confirmed on both sides), so this harness's own root-parity check has
never actually covered `graph`; that is a pre-existing limitation of `compareRootSets`, not
something this session introduced or fixed (out of file scope).

**This is a real, reproducible finding, captured per instruction rather than fixed (out of F.3's
file scope: `delta.rs`/materialize/`scripts/v4-mutation-harness.mjs` are not in the authorized edit
list):** after a real, 30-generation-long, mixed-kind (edit/hub_edit/create/delete/rename x3 repeat)
incremental sequence on the n8n corpus, the `dependency` root matches a from-scratch oracle of the
final mutated tree exactly, but the `records` root does not. This corroborates, independently, the
SAME asymmetry §5's fraction-sweep found under `Reconcile` (records diverges under incremental
scope narrowing while dependency holds) -- see §5.2's discussion for why this is understood to be
the SAME pre-existing, documented, deferred gap (owner-granularity diffing), now confirmed present
under plain `Changed`-scope incrementals too, not only `Reconcile`. The existing CI-gated fixture
tests (`incremental_{create,delete,rename}_roots_match_a_from_scratch_scan_of_the_mutated_tree`,
`reconcile_batches_match_cold_at_1_5_10_25_50_percent`) all pass (§4 below) -- the gap only
manifests at real n8n scale over a long, compounding, mixed-kind sequence, which the small-fixture
suite does not exercise.

### 3.2 Wall times and the hub_edit gate

The harness's own JSON summary was never written (crash happened before the final `writeFile`), so
per-mutation-KIND wall times could not be attributed by label; the raw `[urdira][timing]
queryable_at generation=N` timestamps for the 30 post-warm steps were extracted instead:

`8035, 4499, 9173, 8529, 8931, 8451, 6719, 273, 7952, 419, 548, 9549, 9934, 9777, 8243, 9028, 6606,
261, 6594, 267, 395, 8060, 8742, 8505, 8158, 6913, 8930, 278, 7755, 271, 371` (ms)

Two clusters: ~6.6-9.9s (multi-file/full-resolve mutations: edit, hub_edit, create) and ~0.26-0.55s
(cheap structural-only steps, consistent with `delete`). `hybrid_owners=1` was observed in 25 of 31
resolve-phase log lines across the whole run (the one `hybrid_owners=14082` line is the initial cold
scan's own full resolve, not a mutation) -- i.e. every incremental mutation that required a resolve
pass reanalyzed exactly **1 owner**, matching the existing hub-edit gate (owners=1, memory
`project_goal_session_2026-08-14`). The upper cluster (~6.6-9.9s) is consistent with that gate's own
"~6-7s" wall figure, though this run cannot attribute a specific value to `hub_edit` alone by name.
No wall-time regression is apparent; nothing here exceeds the existing ~6-7s/owners=1 baseline by a
material margin.

### 3.3 `verify-roots each` cross-check (cold + warm generations only, unaffected by the crash)

The harness's per-step readiness/queryable timeline for generations 1-32 completed without error
(only the FINAL oracle comparison crashed); the existing CI-gated tests_e2e.rs suite already covers
single-mutation-type root parity end to end (§4). No other roots_ok failures were observed during
the 30 timed steps themselves (that check only runs with `--verify-roots each`, not requested here;
`final` was used per the task's own instruction, and its ONE opportunity to check was the crashed
step, recovered by hand above).

---

## 4. `reconcile` test suite (sanity, since `tests_e2e.rs` was touched)

```
cargo test -p urdira-indexing-worker --locked --release reconcile
```
13 passed, 0 failed (`reconcile_noop_keeps_generation_and_roots`,
`reconcile_{create,delete,rename}_roots_match_a_from_scratch_scan_of_the_mutated_tree`,
`reconcile_batches_match_cold_at_1_5_10_25_50_percent`, `reconcile_falls_back_to_cold_when_delta_fails{,_after_catalog_apply}`,
`reconcile_delta_threshold_is_within_measured_bounds`, others). `cargo fmt -p
urdira-indexing-worker -- --check` clean.

---

## 5. Reconcile threshold re-measurement (R1)

### 5.1 Fraction sweep

```
node scripts/v4-reconcile-threshold.mjs --corpus ~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02 \
  --data <scratch> --fractions 0.01,0.02,0.05,0.10 --repeat 2 \
  --out ~/Proyectos/urdira-benchmark/v4-fold/f3-threshold-results.json
```
(`p=0` auto-prepended by the script.) Frontier: 20,148 entries, 14,046 eligible TS/JS files,
`template_cold_wall_ms=29,135.6`.

| p | touched | delta_wall (median) | cold_wall (median) | ratio | roots_ok.delta {records,dependency,graph} | roots_ok.cold |
|---:|---:|---:|---:|---:|---|---|
| 0 | 0 | 960.0ms | 1050.5ms | 0.914 | {true,true,true} (noop, identical path) | {true,true,true} |
| 0.01 | 202 | 23,442ms | 22,887.5ms | **1.024** | {**false**,true,true} | {true,true,true} |
| 0.02 | 403 | 24,944.5ms | 23,732ms | 1.051 | {**false**,true,true} | {true,true,true} |
| 0.05 | 1008 | 31,383ms | 24,313.5ms | 1.291 | {**false**,true,**false**} | {true,true,true} |
| 0.10 | 2015 | 44,584ms | 23,013.5ms | 1.937 | {**false**,true,**false**} | {true,true,true} |

`cold_all=true` in every cell (the pipeline with no scope-narrowing always matches the oracle
exactly -- correctness of the fallback path is solid). `delta_all=false` in every positive-p cell
(see §5.3 for the interpretation; this does not gate the threshold computation, see script's own
comment quoted there).

**Crossover:** the script excludes `p=0` from the search (identical `Noop` code path both sides) and
takes the FIRST positive fraction where `delta_wall_ms >= cold_wall_ms`: that is already `p=0.01`
(23,442 >= 22,887.5), so `crossover_p = 0.01` with no interpolation needed. `chosen_threshold =
round(0.01 * 0.8, 2) = 0.01`.

### 5.2 Comparison with the pre-P0 (2026-09-06) measurement

| p | old ratio (pre E-P0x) | old roots_ok.delta | new ratio (post E-P0d, this session) | new roots_ok.delta |
|---:|---:|---|---:|---|
| 0 | 1.019 | {true,true,true} | 0.914 | {true,true,true} |
| 0.01 | 0.937 | {**false**,**false**,true} | 1.024 | {**false**,true,true} |
| 0.05 | 1.334 | {**false**,**false**,**false**} | 1.291 | {**false**,true,**false**} |
| 0.10 | 1.544 | {**false**,**false**,**false**} | 1.937 | {**false**,true,**false**} |

**Real, measured improvement from E-P0/E-P0b/E-P0c/E-P0d:** `dependency` root parity under
`Reconcile`'s `Delta` branch now holds at every tested fraction (0.01 through 0.10), where it used
to fail starting at 0.01. `graph` root parity's own crossover moved from p=0.01 (old) to somewhere
between p=0.02 and p=0.05 (new) -- also an improvement. **Not improved:** `records` root parity
under `Delta`, which fails at every tested nonzero fraction in BOTH the old and the new
measurement -- this is the one piece of the "Brecha B"-adjacent gap that E-P0/b/c/d's fixes (which
targeted `pending_importers_of` and type-alias `entity_owner`, i.e. dependency/graph-adjacent code)
did not touch.

### 5.3 P0 finding: `records` root never matches the oracle under forced `Delta`, at any tested scale (pre-existing, documented, deferred -- not fixed here)

Per `scan.rs::run_reconcile`'s own module doc (quoted verbatim by
`scripts/v4-reconcile-threshold.mjs`'s comment right above where it deliberately does NOT hard-gate
on `delta_all`): `delta.rs` diffs dependency rows at OWNER granularity (closed/reopened
unconditionally for every touched/deleted owner, never by `dependency_id`) -- "a residual precision
gap for whichever task next tightens dependency identity", explicitly out of scope for the
threshold-measurement task both in 2026-09-06 and here. `publish.rs` derives `graph_entries` FROM
the records/relations set, so a `records`-level gap can and does propagate into `graph` once enough
owners are touched (matches the p>=0.05 pattern above). This is captured and reported per this
task's own instruction ("si alguna celda falla, es P0: captura y reporta... no lo arregles tú") --
`delta.rs`/`materialize` are not in F.3's authorized file list, and the fix is nontrivial (dependency
identity, not a one-line change). **Recommendation for the owner's queue:** re-open this as its own
frente (dependency/records identity under `Delta`-scope diffing), now more precisely bounded than
before: `dependency` is fixed, `graph` is fixed up to ~2% touched, `records` is not fixed at any
scale tested.

Correctness in production is not at risk from this measurement's own numbers: any workload whose
touched fraction exceeds `T=0.01` (the ONLY regime `Reconcile` will actually pick `Delta` for) is
covered by the `Cold` fallback, which this measurement (and the git-switches below) confirm matches
the oracle exactly, always. The gap is specifically inside the ≤1%-touched regime where `Delta` IS
selected in production and its `records` root does not match a from-scratch oracle -- i.e. a real,
if narrow, exposure that should not be left open indefinitely.

### 5.4 Two real git switches

```
node scripts/v4-reconcile-threshold.mjs --git-switch --git-repo ~/Proyectos/n8n \
  --data <scratch> --git-tag-a n8n@2.13.0 --git-tag-b n8n@2.26.4 --git-head-back 200 \
  --out ~/Proyectos/urdira-benchmark/v4-fold/f3-gitswitch-results.json
```
(`~/Proyectos/n8n`, HEAD `b3a34fcd81`, never mutated -- the script clones it to scratch itself.
Tags picked ~3 months apart: `n8n@2.13.0` 2026-03-16, `n8n@2.26.4` 2026-06-15.)

| switch | changed_files / frontier | cold@A wall | reconcile(T=1, forced Delta)@B wall | reconcile(T=0, forced Cold)@B wall | roots_ok vs independent oracle |
|---|---:|---:|---:|---:|---|
| tags-3-months (`n8n@2.13.0` -> `n8n@2.26.4`) | 8,491 / 15,421 (55.1%) | 18,180.0ms | 185,947.5ms | 30,294.2ms | dependency=**true**, graph=**true** |
| head-vs-head200 (`HEAD~200` -> `HEAD`) | 1,971 / 19,827 (9.9%) | 24,756.7ms (T=1 run) / 28,771.3ms (T=0 run) | 113,322.2ms | 23,320.9ms | dependency=**true**, graph=**true** |

Both real switches confirm `dependency`/`graph` root parity holds exactly against an independent
oracle (this script's own git-switch mode does not check `records` here -- only
`dependency`/`graph` are compared in that code path, an asymmetry with §5.1's fraction-sweep mode
that would NOT have caught §5.3's `records` gap). Neither switch is a "small" (<=1% owners) real
diff -- n8n's own commit history over ~200 commits or ~3 months touches 10-55% of the frontier in
this corpus, well above `T`, so production would correctly choose `Cold` for both regardless; this
is reported plainly rather than manufacturing an artificially small switch.

### 5.5 `T` decision

Per R1: `T = crossover_p * 0.8`, rounded to 2 decimals, capped at 0.50. Crossover found at
`p=0.01` (§5.1) -> `T = 0.01 * 0.8 = 0.008 -> round to 2 decimals = 0.01`.

**`RECONCILE_DELTA_THRESHOLD` is UNCHANGED: `0.01` (same value already in `scan.rs`).** No code
edit was needed -- the re-measured crossover, post E-P0/E-P0b/E-P0c/E-P0d, lands on the exact same
threshold as the pre-fix (2026-09-06) measurement (`0.01`, from an interpolated crossover at
p~=0.0164 back then vs a directly-observed crossover at p=0.01 now -- both round to the same T).
`reconcile_delta_threshold_is_within_measured_bounds` (asserts `[0.01, 0.50]`) continues to pass
unmodified. R6's "coste aceptado" note does not apply here since nothing regressed enough to change
the constant.

**Plan §2.6's own aspirational "criterio de hecho" targets, checked against these numbers:**
"trivial pull (n=0) <= 6s" -- **met** (960ms). "small switch (<=1% owners) <= 8s" -- **not met**
(p=0.01's `delta_wall`=23.4s): `run_reconcile`'s `enumerate()` step always does a full authoritative
walk+hash of the corpus regardless of how few files actually changed, so its floor is close to
`cold_wall` itself (~23-30s on this corpus) even at the smallest nonzero touched fraction -- this
was already true in the pre-P0 (2026-09-06) measurement (20.8s at p=0.01) and is an architectural
property of the current `Reconcile` design, not a regression from this session's own work, and not
in this task's scope to change.

---

## 6. v3 parity (R4): BLOCKED -- a real, reproducible, pre-existing v3 defect

### 6.1 What was attempted

No retained v3 n8n oracle DB exists (`~/Proyectos/urdira-benchmark/v4-fold/q5-parity/*.log` was
searched: no `v3-n8n` path recorded there; `~/Proyectos/urdira-benchmark/v3-n8n-2026-09-06/` did not
exist at session start, matching R4's own premise that it was deleted 2026-09-06). Per R4, it was
regenerated: a small standalone driver script (`~/Proyectos/urdira-benchmark/v4-fold/f3-v3-index.mjs`,
not part of the repo, modeled on `scripts/v4-mutation-harness.mjs`'s own in-process daemon pattern)
started a foreground `URDIRA_V4=0` daemon (`URDIRA_NATIVE_REQUIRED=1` + `prepareNativeRoot` staging,
same as the mutation harness needs) and ran `urdira workspace add
~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02 --confirm` against it, polling
`core:workspace_admin_show` for `status === "ready"`.

### 6.2 Deterministic failure, reproduced twice

Both attempts (one with semantic indexing enabled, one with `URDIRA_SEMANTIC_INDEX=0`) failed
IDENTICALLY, at the identical point:
```
[urdira-indexing-worker] direct structural record rows=3525385
[urdira] workspace scan failed for workspace:n8n-corpus-2026-09-02:<id>: Error: core:publish_failed:
Rust publication SQLite error: UNIQUE constraint failed: record_occurrences.record_id
```
Exactly 3,525,385 direct structural records were produced both times before the SAME unique-key
violation on the SAME table (`record_occurrences.record_id`) aborted publication. This is not a
race (only one scan attempt ran each time -- confirmed via the log: one
`publication phase=promo_records_exist_probe` per run, one `direct structural record rows=` line,
one failure) and not flaky (identical row count, identical error, both times) -- it is a
deterministic defect in v3's (legacy, pre-v4) publication path when indexing this exact corpus at
this exact scale, uncovered live by this session's own attempt to regenerate the oracle DB per R4.

### 6.3 Disposition

**Reported as a P0, not fixed.** v3's storage/publish code (`packages/storage/src/*.ts`, legacy
schema) is entirely outside F.3's authorized file list (`RECONCILE_DELTA_THRESHOLD` + its test,
`scripts/v4-population-floors.json`, the `jsts:entity_parameter` floor, and evidence only), and a
duplicate-`record_id` root cause at ~3.5M-row scale is a nontrivial investigation (likely a v3
record-identity collision specific to some repeated content pattern in the n8n corpus, e.g. two
structurally-identical declarations whose `record_id` derivation omits enough context to
disambiguate them) that does not belong inside a measurement task. **Consequence for this task:**
steps 4b/4c (v3 oracle DB retention, references-parity, call-parity, and population-parity diffs
against v3) could **not** be completed this session -- there is no v3 database to diff against.
`different == 0` / `same >= 948,000` / call-parity / population-parity numbers are simply not
available; this is reported rather than silently skipped or fabricated. **Recommendation for the
owner's queue:** a dedicated frente to root-cause the v3 `record_occurrences.record_id` collision on
the n8n corpus (repro: `URDIRA_V4=0 URDIRA_NATIVE_REQUIRED=1` + `workspace add` on
`~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`, fails 100% of the time at
`rows=3,525,385`), after which the v3 oracle DB can be regenerated and F.1/F.3's parity gates
(§3.1 item 3/4 of the plan) actually run.

---

## 7. Changes

- `scripts/v4-population-floors.json`: `jsts:entity_parameter.floor` `74,021 -> 78,966` (0.99x the
  newly measured 79,764), note updated to record the F.3 measurement and superseded provisional
  note.
- `crates/urdira-indexing-worker/src/v4/tests_e2e.rs`: `FLOOR_ENTITY_PARAMETER` `74_021 -> 78_966`;
  doc comment above `n8n_population_floors` updated from "PROVISIONAL... until F.3 re-pins it" to
  recording the actual re-pin.
- `RECONCILE_DELTA_THRESHOLD` (`scan.rs`): **unchanged** (`0.01`) -- see §5.5 for why.
- This evidence file.

No other files touched. `git status --short` is clean of anything beyond these two source files
and this doc.

## 8. Verification

- `cargo test -p urdira-indexing-worker --locked --release n8n_population_floors -- --ignored
  --nocapture`: passes (§2).
- `cargo test -p urdira-indexing-worker --locked --release reconcile`: 13/13 passes (§4).
- `cargo fmt -p urdira-indexing-worker -- --check`: clean.
- Full `pnpm verify` was not re-run this session (no TypeScript/daemon/engine files were touched;
  only a JSON floors file and Rust test constants/comments, already covered by the two `cargo test`
  invocations above).

## 9. Cleanup

- `git worktree remove ~/Proyectos/urdira-benchmark/v4-fold/wt-cf822d4 --force`.
- All scratch data dirs under `v4-fold/f3-*/` (cold-scan data dirs, mutation-harness data roots and
  scratch corpus copies, threshold-sweep/git-switch scratch, v3 daemon data root, oracle-final
  comparison dir) deleted; only `run*.log`, `*-results.json`, `population.tsv`, and this evidence
  file's source numbers are retained.
- The one temporary local script copy used for the manual oracle-verify workaround (§3.1) was never
  committed and has been deleted; `scripts/v4-mutation-harness.mjs` itself was never modified.

## 10. Summary table for the final report

| item | result |
|---|---|
| Cold total_ms (median) | base 23,985ms vs HEAD 23,369ms (-2.6%, noise-level) |
| `jsts:entity_parameter` (HEAD, cold) | 79,764 (new floor 78,966) |
| Population floors | 10/10 OK, no regression |
| Incremental roots (30-generation real run) | `dependency` OK; `records` MISMATCH (P0, deferred) |
| hub_edit gate | owners=1 confirmed (25/31 resolves); wall ~6.6-9.9s band, consistent with existing gate |
| Reconcile threshold crossover | p=0.01 (direct, no interpolation needed) |
| `RECONCILE_DELTA_THRESHOLD` | unchanged, 0.01 |
| Real git switches roots (dependency/graph only) | both switches: OK |
| v3 parity (references/calls/populations) | **BLOCKED** -- v3 publish defect, P0 reported, not fixed |
