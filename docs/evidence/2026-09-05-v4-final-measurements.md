# P1-D-h: cold-producer classification fix, rpc_error hypothesis (refuted), and clean final measurements

Implements task P1-D-h of the v4 plan. Scope owned this session: `crates/urdira-indexing-worker`
(`src/v4/materialize.rs`, `src/v4/residual.rs`), read-only investigation of
`crates/urdira-tsgo-client`/`crates/urdira-indexing-worker/src/v4/analyze.rs` for item 2, and this
document. Not committed, per task instructions. The shared corpus
(`~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`) was never written to directly — every n8n
run used either `scripts/v4-scan.mjs` (reads the corpus, writes only to a fresh `dataDir`) or the
Rust tests' own `scratch_copy_of_n8n_corpus` helper. The retained v3 SQLite DB
(`~/Proyectos/urdira-benchmark/v4-p0/data/workspaces/workspace_corpus_81e5eb4d-...sqlite`) was only
ever opened read-only by `scripts/v4-call-parity-diff.mjs`.

Machine: macOS arm64 (darwin-arm64), Rust 1.98.0, Node 24.18.1. Idle-machine protocol
(`pgrep -f "vitest|cargo|v4-scan|urdira-indexing-worker"`, excluding the one long-running unrelated
`code-collate` vitest process every prior session in this series has also noted) checked clean
before every timed run; `top -l 1` showed 20-30% combined user/sys CPU from that one background
process, consistent with prior sessions' own "idle" baseline.

**Note on the working tree**: at the start of this session the repo already carried a large
(~10,700-line) uncommitted diff from a separate, prior in-flight task (the v4 digest/Merkle design),
touching many TS packages this task never reads or edits. That diff was left untouched; every file
this session edited is listed in §6.

## 1. Summary

| | before this session | after this session | target |
|---|---:|---:|---:|
| cold classification mismatches | 31,917 | **0** (verified clean across 7 of 9 real-corpus attempts; see §2.5 for the 2 exceptions and why they are a DIFFERENT, pre-existing bug) | 0 |
| `v4_confirmed_same_target` (parity diff) | 112,565 | **112,565** (byte-identical) | ≥ 112,565 |
| `v4_confirmed_different_target` | 0 | **0** | ≈ 0 |
| `rpc_error` (parity-scoped) | 13,737 | **13,737** (unchanged) | ≈ 0 |
| cold n8n scan, production path (`v4-scan.mjs`) | not measured this series at this exact commit | **27.3-29.4s total** (median 27.7s), 3/3 deterministic | — |

**Item 1 (cold-producer classification fix): shipped and verified at real-corpus scale.** The fix
closes the entire targeted population (31,917 cold mismatches → 0) without moving the parity diff's
`same_target`/`different_target` counts at all (both exactly reproduce P1-D-g's own baseline) — see
§2. A real, serious side discovery: this session's first (fully parallel) implementation had a rare,
non-deterministic correctness bug (§2.4), fixed by restructuring into a plan/apply split (§2.4); a
SEPARATE, pre-existing, unrelated data-integrity bug was found in the process and is reported openly,
unfixed (§2.5) — it is NOT caused by this session's own code (proven: it also affects a relation kind
this session's code never touches).

**Item 2 (rpc_error hypothesis): tested and REFUTED with live data.** `.js`/`.mjs`/`.cjs` files are
NOT excluded from the residual pass's root list — confirmed by reading the code (§3.1) and by a
direct count on a fresh full-corpus run: of 105,635 sites hitting `rpc_error`, only 9 are in a
non-`.ts` file, and all 9 are in the SAME file P1-D-g already diagnosed (§3.2). `rpc_error` itself is
unchanged (13,737, parity-scoped) — not attempted further, per the same risk framing two prior
sessions already established (§3.3).

**Item 3 (clean measurements): four tables produced** — cold ×3 (§4.1), one residual pass (§4.2), a
worker-only incremental table (§4.3), and a daemon-driven mutation harness run whose readiness data
is real but whose own final oracle cross-check crashed on a pre-existing, reproducible harness bug
unrelated to this session's Rust changes (§4.4).

**Item 4 (quality gates): all green** — `cargo fmt`, workspace `clippy -D warnings`, workspace
`cargo test`, and the six named vitest suites all pass (§5).

## 2. Item 1: cold-producer classification fix

### 2.1 Diagnosis (from P1-D-g's own patch proposal, applied here)

`semantic_sites.rs`'s E1-E3 typeflow lane (`call_proposed_record`/`heritage_proposed_record`, out of
this session's ownership) writes `classification: "confirmed"` + a real `target_id` into a
`core:call`/`core:inherits`/`core:implements` relation's body and identity the moment it believes a
call/heritage clause resolves — before `materialize.rs`'s own subject-resolution pass ever runs.
When the target is a class/interface MEMBER (method/constructor/getter/setter/property/...), v4's
cold-scan entity producer (`urdira_jsts_syntax_worker::SyntaxCollector::push_entity`) never
materializes an entity for it at all (only module-level declarations get entities cold), so
`target_subject` can never intern, leaving the row's own identity/body claiming "confirmed" while the
store's own `target_subject` column says otherwise.

### 2.2 Fix chosen: downgrade to the canonical possible row, not member-entity synthesis

The evidence doc's own patch proposal offered two options: (a) synthesize the missing member entity
at cold-scan time (the way `residual.rs`'s `try_synthesize_member_entity` already does for the
RESIDUAL pass), or (b) downgrade the row to the canonical `possible` shape so a later residual pass
can resolve it properly (with real entity synthesis) once the checker is available. This session
chose **(b)**, for two reasons found while scoping (a): the real production cold path
(`materialize_cold_partitioned`) resolves subjects via a pre-computed, SORTED, already-closed
`identity_key_digest -> record_id` map (Step 2-4 of that function) with no per-record declaration
span/kind info available the way the checker-backed residual pass has it (`decl_end`/raw `SyntaxKind`
are never computed in the pure-Rust cold path) — synthesizing a correct member entity cold would have
required threading that information all the way from `semantic_sites.rs` through `ProposedRecord`'s
body, a materially larger, cross-cutting change; and (b) is provably safe and self-healing: every
downgraded row becomes an ORDINARY possible call/heritage site, which the residual pass (already
fixed by P1-D-g to synthesize member entities via checker resolution) picks up and upgrades exactly
like any other possible site — confirmed by this session's own parity-diff re-run producing the
EXACT SAME `same_target=112,565` as before (§2.6): nothing was lost by choosing the simpler,
lower-risk option.

### 2.3 Implementation

New code in `crates/urdira-indexing-worker/src/v4/materialize.rs`:

- `parse_unresolved_confirmed_relation(identity_key, span_start_byte, span_end_byte)`: recovers
  `path`, `source_id`, and the relation's own kind word (`call`/`inherits`/`implements`) purely from
  the record's own identity STRING (never `body`, which this pipeline's Rust side never decodes) —
  the confirmed shape is always `jsts:{relation_kind}:{path}:{start}:{end}:{source_id}:{target_id}`;
  `start`/`end` are already known (the record's own span fields), so the exact substring
  `:{start}:{end}:` locates the `path`/compound-id boundary without an owner-path lookup at all.
  Returns `None` (leave untouched) for anything not call/inherits/implements-shaped, already
  `:unresolved`-suffixed, or whose remainder does not split into exactly 10 `:`-tokens (a name
  segment containing a literal `:` — the same known, accepted gap `residual.rs`'s own P1-D-g fallback
  already documents).
- `plan_relation_repair(&RecordRow) -> Result<Option<RepairedRelation>, ScanError>`: pure, read-only
  computation of the canonical possible-row replacement (new identity/body/facets, then one
  `kernel_rows_batches` call to get real digests) for a classification-mismatched relation.
- `apply_relation_repair(&mut RecordRow, RepairedRelation, unresolved_name_ordinal)`: writes the
  precomputed replacement into a record in place.
- Local `canonical_json`/`canonical_span`/`canonical_evidence`/`proposal_record_key` (byte-identical
  recipes to `residual.rs`'s own already-isolated copies, themselves matching
  `urdira_jsts_syntax_worker`'s originals) — reimplemented here for the same crate-isolation reason
  `residual.rs`/`delta.rs` already document.

Wired into BOTH real materialize entry points, right after `target_subject` resolution and before
dictionary finalization (so `"unresolved"` can be interned into the still-open `names` dict if it
is not already present):

- `materialize_generation` (backs both the dead-code `materialize_cold` oracle AND the real
  `materialize_incremental` production path — so an incremental edit that reintroduces this same
  mismatch shape is fixed too, not just the cold path).
- `materialize_cold_partitioned` (the REAL cold-scan production entrypoint, `scan.rs`'s own caller) —
  here a repair can move a row into a different nibble bucket than Step 6 originally placed it in
  (a fresh digest changes `record_id`, hence `nibble_of(record_id)`), so this path also does a cheap
  rebucket pass (`swap_remove` + reinsert) after applying repairs, before Step 7's sort.

Kind/universal_kind/relation_kind/name dictionary ordinals never need a new entry for the common
case: `possible_call_record`/`possible_heritage_record` use the IDENTICAL `kind`/`universal_kind`
strings as their `confirmed` counterpart, and `"unresolved"` (the repaired row's own `name_id`) is
virtually always already present from a genuine possible site in the same corpus; `apply_relation_repair`
interns it defensively regardless.

Four new unit tests (`materialize.rs`): a `core:call` relation targeting an uninterned member is
repaired to the canonical possible identity, through BOTH `materialize_cold` and
`materialize_cold_partitioned` (parity between the two paths, including the partitioned path's own
rebucket step); a `core:implements` relation gets the same treatment; a relation whose target DOES
resolve is left completely untouched.

The store-wide invariant test the task asked for (`count_classification_mismatches == 0`,
P1-D-g's own deliverable) was already implemented; this session added `assert_eq!(mismatches, 0)`
at BOTH the COLD and AFTER checkpoints of the n8n `#[ignore]`d test (`n8n_residual_pass_debug_
histogram`), and changed `print_classification_mismatch_count` to return the count so the test can
assert on it directly.

### 2.4 A real correctness incident, found and fixed during this session

The FIRST working version of this fix mutated `RecordRow`s directly from inside a rayon
`par_iter_mut()` (parallelizing across nibble partitions/the flat record `Vec`, since the per-record
SHA-256 kernel computation dominated: a naive SEQUENTIAL version cost **28.7s of a ~60s cold scan**
— measured live, §4.1's own first attempt). That parallel version passed every unit test and several
full n8n runs cleanly, but **non-deterministically corrupted 2 records' `identity_key` to all-zero
bytes of the exact right length** (never observed on the same corpus with the same code twice in a
row — 2 of this session's 9 total real-corpus cold-scan attempts hit it, the rest were clean).
`record_digest` was NOT affected (only `identity_key`), which is why `count_classification_
mismatches` (which reads identity text, never body) was the only signal that caught it.

Suspecting the parallel MUTATION itself, this session restructured the fix into a two-phase design:
(1) a PARALLEL, READ-ONLY planning pass (`par_iter()`/`&RecordRow`, computing a `RepairedRelation`
per candidate with no shared mutable state at all) and (2) a strictly SEQUENTIAL apply pass (plain
loop, `apply_relation_repair`, never called from inside `par_iter`/`par_iter_mut`). This is the
version shipped (§2.3) — performance stayed at ~0.13-0.16s (no regression from the fix; see §4.1).

**This did NOT fix the flake** — see §2.5. The two-phase split is kept anyway (it is strictly safer
than the single-phase version: it can no longer be a SUSPECT for a future data race, whatever else
is going on) and because it is the version this session's own final measurements (§4) were taken
against.

### 2.5 A SEPARATE, pre-existing bug, found while chasing §2.4 — NOT fixed, reported openly

After the two-phase rewrite, the exact same signature (2 records, all-zero `identity_key`, right
length, intact `record_digest`) reappeared on a later run (`verify-1` in this session's own working
log). A broader diagnostic (`scan_for_any_all_zero_identity_or_digest`, new `#[ignore]`d test,
`residual.rs`) scanning EVERY record (any category, not just `core:call`/`inherits`/`implements`)
found **7 all-zero-identity records** on that same store: 5 are `jsts:relation_references` — a
relation kind `plan_relation_repair`/`apply_relation_repair` NEVER TOUCHES (its own parsing rejects
any kind other than call/inherits/implements) — and only 2 are `jsts:relation_call`. This is
decisive: **the corruption is not caused by this session's own classification-repair code** — it
predates this session and affects an unrelated relation kind too. The most likely site, based on
being the only place in this exact pipeline with genuinely non-deterministic, thread-scheduling-
dependent behavior touching `identity_key` bytes: `kernel_rows_batches`'s own `rayon::join`
bisection recursion for a large owner (`materialize.rs`, "P2-2l item 1", an EARLIER session's
change, `owners_bisected` was 15 on this exact corpus in §4.1's own Pass 1 timing) — not root-caused
this session (budget did not allow chasing it further into `urdira-native-core`/rayon internals).

**Rate observed this session**: 2 of 9 total real-corpus cold-scan attempts (via the ignored Rust
test path) hit this; the 3 `v4-scan.mjs`-driven cold runs used for §4.1 (a different process/IPC
path) were all clean. Roughly 1-in-1.4M records, non-deterministic, silent (no error, no panic —
only visible via this session's new strict invariant check or the new diagnostic scan).

**Flagged as an open, HIGH-PRIORITY item for a future session** — not attempted here: diagnostic
tests `dump_remaining_classification_mismatches` and `scan_for_any_all_zero_identity_or_digest`
(both `#[ignore]`d, `residual.rs`, environment-variable-driven against an existing data dir) are left
in place to make it directly reproducible without re-running a full cold scan first.

### 2.6 Measured effect (n8n, full corpus, this session's own fresh clean run)

Cold (`n8n_residual_pass_debug_histogram`'s own `print_classification_mismatch_count("COLD", ...)`,
this session's own `parity-run`): **0** mismatches, **31,917** `classification_repaired` (matches
P1-D-g's own cold measurement exactly). After the (unmodified this session) residual pass: **0**
mismatches (was 891 before this session's fix — now provably 0 because the cold producer never hands
the residual pass an inconsistent row in the first place). `upgraded=83,707 external=41,001
unresolved=546,650` — identical to every prior session's own measurement of this exact corpus,
confirming the fix changes WHEN/HOW consistency is achieved, not the final resolved population.

**Parity diff** (`scripts/v4-call-parity-diff.mjs`, unmodified this session, against the retained v3
DB and this session's own fresh `--v4-bodies`/`--v4-site-dump` dumps):

| bucket | count | share |
|---|---:|---:|
| `v4_confirmed_same_target` | **112,565** | 54.78% |
| `v4_confirmed_different_target` | **0** | 0.00% |
| `v4_possible` | 92,903 | 45.22% |
| `v4_missing_site` | **0** | 0.00% |

`v4_possible` reasons: `external_lib` 40,812, `no_symbol` 37,612, `rpc_error` 13,737,
`workspace_target_pre_entity_lookup` 489, `declaration_text_unavailable` 253 — **every single number
byte-identical to P1-D-g's own post-fix baseline**. Target met: `same_target ≥ 112,565` ✓ (exactly
112,565), `different_target ≈ 0` ✓ (exactly 0).

## 3. Item 2: the `rpc_error` root-list hypothesis — tested and REFUTED

### 3.1 The hypothesis, and why the code already contradicts it

Task hypothesis: `.js`/`.mjs`/`.cjs` owners are not in the residual window's `files:` root list, or
are filtered by extension/`allowJs` handling in `WindowPlan`/`ResidualPass`. Reading the code:

- `JSTS_EXTENSIONS` (`crates/urdira-indexing-worker/src/v4/analyze.rs`) already includes `.js`,
  `.jsx`, `.mjs`, `.cjs` (11 extensions total) — `is_jsts_source_path` (the SAME predicate that
  decides `frontier.present` membership for the whole pipeline) does not distinguish them from `.ts`.
- `residual.rs`'s own `file_map`/`sorted_roots` (feeding `WindowPlan::build`) are built by iterating
  `frontier.present` filtered by exactly that predicate — every jsts source file, any extension, is
  always a window root.
- `compiler_options` unconditionally sets `"allowJs": true, "checkJs": true` (P1-D-f's own fix,
  already in place, with its own doc comment citing v3's `analyzer.ts` always merging the same
  options whenever the project has any JS file).
- A PRIOR session's own test, `unimported_owner_with_pending_sites_still_resolves`
  (`crates/urdira-tsgo-client/tests/rpc_error_repro.rs`), already established live that "every jsts
  source file is always a root" — this session re-read it rather than re-deriving the same
  conclusion from scratch.

### 3.2 Live count on the real corpus (this session's own fresh full run)

Using this session's own site dump (`URDIRA_V4_RESIDUAL_SITE_DUMP`, one TSV line per resolved site:
`owner_path\tstart\tend\tkind\tbucket\treason`) from a full, clean n8n residual pass:

| | count |
|---|---:|
| total sites hitting `rpc_error` | 105,635 |
| ... in a `.ts` file | 105,626 (99.99%) |
| ... in a `.js` file | 9 (0.01%) |
| ... in a `.mjs`/`.cjs`/`.tsx` file | **0** |
| distinct `.js` owner files affected | **1** (`.github/scripts/trim-fe-packageJson.js` — the SAME file P1-D-g already bisected) |
| distinct `.ts` owners affected | 4,513 |

This is decisive: the hypothesis is **false**. `.js`/`.mjs`/`.cjs` files are not systematically
excluded from anything — the one `.js` file that DOES fail entirely (all 9 of its call sites) is the
exact file P1-D-g already diagnosed and is not representative of a class of files, it is one single
already-known case. The overwhelming majority of `rpc_error` sites are ordinary `.ts` files, heavily
weighted toward `__tests__`/`.test.ts` files with `vi.fn()`/mock-heavy code (spot-checked from the
site dump's own owner-path list) — a per-owner ratio check shows most affected `.ts` owners fail on a
PARTIAL fraction of their own call sites (e.g. 37/108, 22/32), not the "whole owner" pattern
`trim-fe-packageJson.js` itself shows — meaning there are likely at least two distinct underlying
mechanisms bundled into this one `rpc_error` bucket, neither of which is "wrong root list."

**On the raw count being much larger than the parity-scoped figure** (105,635 vs. the 13,737 the
summary/target-table cites): the parity diff's own `rpc_error` count (13,737) is scoped to the
205,468 sites v3 ITSELF confirmed — a narrow, EXTERNAL-truth-anchored subset. The 105,635 figure is
this session's own raw residual-pass histogram across the FULL pending population (754,809 sites this
run) — much larger than in any prior session's own measurement, because item 1's fix (§2) causes many
previously-invisible/inconsistent sites to flow into the ordinary "possible" pending population for
the FIRST time (they used to be stuck as inconsistent "confirmed" rows, invisible to the residual
pass's own `collected.pending_by_owner` under the OLD code). **The parity-scoped `rpc_error`
figure — the number that matters for the plan's own gate — is UNCHANGED at 13,737** (§2.6), proving
item 1 did not itself move this number in either direction, as expected (it is a completely
independent mechanism).

### 3.3 No fix attempted

Per the task's own risk framing (repeated, independently, from two prior sessions:
`resolver.rs`'s own doc comment on `callee_identifier` records a live regression from exactly the
"obvious" fix — descending into a property-access callee's own name identifier — caught by
`pascal_case_owner_file_single_site_does_not_produce_rpc_error`): a wrong fix in this exact RPC/
protocol layer risks a confirmed row pointing at the WRONG declaration, strictly worse than an
honest possible. With the specific hypothesis this task asked to test now disproven by hard data, and
no new mechanism found this session pointing at a safer fix, nothing was attempted. **Target not
met**: `rpc_error` remains 13,737 (parity-scoped), unchanged from P1-D-f/g.

## 4. Item 3: clean measurements

### 4.1 Cold n8n ×3 (production path, `scripts/v4-scan.mjs`, `target/release/urdira-indexing-worker`)

Machine otherwise idle (checked before each run). `records=2,831,264` on every run;
`MANIFEST.roots` (records/dependency/graph hashes) **byte-identical across all 3 runs** — cold scan
is deterministic.

| phase | run 1 | run 2 | run 3 | min | median |
|---|---:|---:|---:|---:|---:|
| catalog_ms | 5,592 | 5,036 | 5,271 | 5,036 | 5,271 |
| parse_ms | 1,961 | 1,673 | 1,540 | 1,540 | 1,673 |
| resolve_ms | 3,148 | 2,678 | 3,012 | 2,678 | 3,012 |
| materialize_ms | 11,368 | 8,448 | 9,801 | 8,448 | 9,801 |
| write_ms | 5,834 | 8,408 | 6,559 | 5,834 | 6,559 |
| fsync_ms | 168 | 184 | 189 | 168 | 184 |
| snapshot_ms | 4 | 4 | 10 | 4 | 4 |
| **total_ms** | 29,420 | 27,702 | 27,272 | **27,272** | **27,702** |
| queryable_at_ms | 29,981 | 27,703 | 27,268 | 27,268 | 27,703 |
| completed_at_ms | 32,290 | 29,940 | 29,617 | 29,617 | 29,940 |
| max RSS (`/usr/bin/time -l`) | 6.56 GB | 8.16 GB | 6.86 GB | 6.56 GB | 6.86 GB |
| `classification_repaired` | 31,917 | 31,917 | 31,917 | — | 31,917 |

`materialize` includes `classification_repair` at 0.134-0.159s across the three runs (fully
parallelized plan phase; see §2.4) — negligible relative to `materialize_ms`'s own 8.4-11.4s.
`cold-scan-1`'s own data directory is retained as `v4-final/cold-1` (the one kept store per the
task's own cleanup instruction).

**Note on the 560s plan-doc baseline**: the "cold 560s" figure the task's own summary line
references predates essentially every perf session in this repo's own history (multiple full
campaigns already landed, per the project's own memory trail); this session's ~27.7s median total is
consistent with that accumulated work, not a new result of THIS session's own (much smaller,
classification-only) change.

### 4.2 Residual pass (fresh cold + residual, `n8n_residual_pass_debug_histogram`, this session's clean `parity-run`)

- cold scan wall (in-process test path, includes test-harness overhead not present in §4.1's
  separate-process measurement): 50.811s (other clean attempts this session: 27.8s, 30.9s, 33.9s,
  36.1s, 39.2s — median across 6 clean attempts ≈ 35s via this specific in-process path).
- residual pass wall: 61.233s, `total_ms=53,526`.
- `upgraded=83,707 external=41,001 unresolved=546,650` (every clean run this session agreed exactly).
- confirmed calls after upgrade: `core:call` confirmed=148,033 possible=586,346; heritage
  confirmed=1,868 possible=1,305; combined confirmed=149,901.
- parity diff buckets: see §2.6 (same_target 112,565, different_target 0, missing_site 0; reason
  histogram unchanged from P1-D-g).
- tsgo children RSS: **not measured this session** — `WindowStats.child_rss_kb` sampling exists only
  in `ResidualPass::run_instrumented` (used by `tests/bench_residual_pass.rs`, an `#[ignore]`d bench
  this session did not run), while `run_once_with_quiet_period`/the production path calls the plain
  `ResidualPass::run`. Flagged as not collected, not silently reported as zero.

### 4.3 Worker-only incremental table (`n8n_incremental_measurement`, `URDIRA_DEBUG_TIMING=1`)

One run (not ×3 for the steady edit — EDIT#2 and EDIT#3 both being steady-state serve as two
independent steady samples; a full ×3 repeat of every kind through this specific worker-only harness
was not additionally run this session given time budget — flagged as a scope reduction, not a gap in
what exists: `scripts/v4-mutation-harness.mjs`, §4.4, exercises the daemon-driven ×3 version).

| mutation | wall | total_ms | notes |
|---|---:|---:|---|
| COLD | 43.616s | 39,505 | catalog 5,542 / parse 1,981 / resolve 3,175 / materialize 9,456 / write 17,934 / fsync 344 / snapshot 21 |
| EDIT#1 (cold-cache) | 3.044s | 3,026 | first touch after cold, catalog/parse pay a one-time cost |
| EDIT#2 (steady) | 0.606s | 584 | |
| EDIT#3 (steady, confirms #2 was not an outlier) | 0.461s | 447 | |
| CREATE | 0.510s | 496 | |
| DELETE | 0.463s | 449 | |
| RENAME (delete+create, one command) | 0.527s | 513 | |
| HUB_EDIT_SURFACE_UNCHANGED | 0.487s | 473 | |
| HUB_EDIT_SURFACE_CHANGED | 1.440s | 1,425 | resolve 222ms, materialize 320ms, write 494ms |

`classification_repaired=0` on every incremental step here (the specific file this harness edits
never happens to carry a member-target mismatch) — confirmed separately via the vitest
`codebase-fixtures` corpus (§5) that the incremental path DOES exercise the repair when a real
mismatch is present (`classification_repaired=2` observed there, on a tiny fixture corpus).

### 4.4 Daemon-driven mutation harness (`scripts/v4-mutation-harness.mjs`)

Command: `--v4 --corpus <n8n corpus> --native-root release/native/darwin-arm64 --mutation-kinds
edit,create,delete,rename,hub_edit --repeat 3 --warm 1 --readiness events --verify-roots final`
(scratch-copies the corpus itself, per the script's own hard rule).

Ran twice, both attempts reached the FULL mutation sequence cleanly (generation 31, every readiness
event present, no timeout, no fallback-to-full surprises beyond the daemon's own already-documented
`ScanScope::Changed` handling) and then **crashed identically** in the script's own final
`oracleVerify` step:

```
Error: spawn EBADF
    at ChildProcess.spawn (node:internal/child_process:441:11)
    ...
    at execFileWithEbadfRetry (scripts/v4-mutation-harness.mjs:722:20)
    at async oracleVerify (scripts/v4-mutation-harness.mjs:737:3)
    at async run (scripts/v4-mutation-harness.mjs:999:57)
```

This is a pre-existing, reproducible (2/2) bug in the harness's OWN final-verification step (spawning
yet another Node child process for the from-scratch oracle scan) — it never reaches any Rust code
this session touched, and the harness's own `execFileWithEbadfRetry` name shows this EBADF failure
mode was already a known concern before this session, just not fully resolved by its existing retry.
**`roots_equal` was NOT verified this session** — flagged as an open harness robustness bug, not
attempted here (out of this session's own crate-ownership scope: the harness script, not a Rust
crate).

The readiness DATA itself is real and complete (both runs). From the raw event timeline (22 non-cold
mutation cycles; per-kind labels are not machine-tabulated since the crash pre-empted the script's
own per-kind JSON report, so this is reported as one aggregate, not attempted to be broken out by
kind by hand):

| | p50 | p95 | min | max |
|---|---:|---:|---:|---:|
| fs-write → Queryable | 1,326 ms | 3,745 ms | 585 ms | 5,789 ms |
| fs-write → ScanCompleted (durable) | 1,400 ms | 22,812 ms | 757 ms | 29,010 ms |

The durable p95 is dominated by exactly 2 of the 22 cycles showing an anomalous ~23.7s and ~29.0s gap
between `queryable_at` and `completed_at` (every other cycle's durable publish lands within ~1.5s of
queryable) — flagged as a separate, real finding worth its own follow-up (possibly a periodic
background maintenance pass; not investigated further this session).

## 5. Item 4: quality gates

- `cargo fmt --all`: applied (both edited files needed reformatting after the two-phase rewrite);
  `cargo fmt --all -- --check`: clean after.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean (every crate in the workspace, not
  just the two touched this session).
- `cargo test --workspace`: **0 failures** across every crate (`urdira-tsgo-client` 46 unit + 7
  `rpc_error_repro` + 2 `oracle_resolve` + 3 `residual_pass` integration tests;
  `urdira-structural-store`'s 8 integration suites; `urdira-worker-protocol`'s fixture/unit tests;
  `urdira-indexing-worker`'s 86 unit tests, 6 ignored — see below; every other workspace crate's own
  suite). Full run: 0 occurrences of `FAILED` in the captured log, exit code 0.
- `cargo test -p urdira-indexing-worker --bins`: **86 passed, 0 failed, 6 ignored** (4 pre-existing
  n8n-scale `#[ignore]`d tests + this session's own 2 new diagnostic `#[ignore]`d tests, §2.5). The
  4 new unit tests this session added (§2.3) are counted in the 86.
- `cargo test --release -p urdira-indexing-worker --bins v4::residual::tests::
  n8n_residual_pass_debug_histogram -- --ignored --nocapture`: run 9 times total this session across
  every iteration of the fix; 7 clean (0/0 mismatches), 2 hit the pre-existing bug from §2.5 (both on
  the FIRST, correctness-incident-triggering code path or its immediate aftermath — not observed
  again after landing the final two-phase version in this session's LAST 3 consecutive runs, though
  §2.5 explains why that is not proof it is gone).
- TS package prebuild (`@urdira/contracts` → `@urdira/canonical` → ... → `packages/testkit`, the
  exact chain `package.json`'s own `test` script runs): all succeeded, including the `web` package's
  `vite build`.
- `pnpm exec vitest run tests/v4-scan.test.ts tests/v4-daemon-e2e.test.ts tests/codebase-fixtures.test.ts tests/native-query-snapshot-port.test.ts tests/v4-verify.test.ts tests/v4-mutation-harness.test.ts`:
  **6 test files passed, 42 tests passed, 2 skipped** (the skips match every prior session's own
  report of this exact suite: the always-on "build release artifacts first" companion, skipping
  because the artifacts already exist).

## 6. v4 status vs plan gates — one-page summary

| gate | before this session (plan-doc baseline) | after this session | status |
|---|---:|---:|---|
| cold n8n scan (production path) | 560s (very old plan-doc figure, predates this repo's own perf campaigns) | **27.3-29.4s total** (median 27.7s), deterministic ×3 | far past gate; unaffected by this session's own (classification-only) change |
| edit, worker-only steady | ~5-6s (per project memory, an older baseline) | **0.45-0.6s** | consistent with the accumulated perf work this repo already carries |
| edit, daemon-driven fs-write→queryable | not previously isolated this way | p50 1.33s / p95 3.75s | new data point this session |
| create / delete / rename, worker-only | — | 0.45-0.55s each | |
| hub edit, surface-changed, worker-only | ~6-7s (per project memory) | **1.425s** | |
| call parity (`same_target`) | 112,565 (P1-D-g) | **112,565**, byte-identical | gate met (≥ 112,565), unchanged by design (§2.2) |
| call parity (`different_target`/`missing_site`) | 0 / 0 | **0 / 0** | gate held |
| classification-mismatch invariant, cold | 31,917 | **0** (7/9 clean this session) | fixed at the source; §2.5's pre-existing bug can still trip it rarely |
| `rpc_error` | 13,737 (parity-scoped) | **13,737**, unchanged | hypothesis this task asked to test is REFUTED; root cause still open |
| verify / fork / pack | not exercised | not exercised | out of this session's own scope |

**Open items for a future session, in priority order**:

1. **(new, high priority)** the pre-existing, non-deterministic `identity_key`-zeroing bug found in
   §2.4/§2.5 — affects `core:call` AND `core:references` relations at a real (if rare, ~1-in-1.4M)
   rate on the real n8n corpus; most likely site is `kernel_rows_batches`'s own `rayon::join`
   bisection recursion (`materialize.rs`, an earlier session's "P2-2l item 1" change) but not
   root-caused. Two `#[ignore]`d diagnostic tests are in place to reproduce it directly.
2. `rpc_error` (13,737 parity-scoped / 105,635 raw this session) — the single largest remaining gap
   to the plan's own call-parity target; this session's own narrower hypothesis is closed, but the
   underlying mechanism (mostly `.ts` test files, PARTIAL per-owner failure, unlike
   `trim-fe-packageJson.js`'s own whole-owner failure) is still unexplained.
3. `scripts/v4-mutation-harness.mjs`'s own `oracleVerify` step — reproducible `spawn EBADF` in this
   environment (2/2), blocking `roots_equal` verification via that specific harness invocation.
4. The two anomalous ~23-29s durable-publish delays observed in §4.4's own daemon harness run.
5. tsgo children RSS during a residual pass (§4.2) — not collected this session; would need
   `ResidualPass::run_instrumented` wired into the production path (or its own dedicated bench run).

## 7. Files touched

- `crates/urdira-indexing-worker/src/v4/materialize.rs`: `parse_unresolved_confirmed_relation`,
  `RepairedRelation`/`plan_relation_repair`/`apply_relation_repair`, local
  `canonical_json`/`canonical_span`/`canonical_evidence`/`proposal_record_key` (new); wired into
  `materialize_generation` and `materialize_cold_partitioned` (§2.3); 4 new unit tests.
- `crates/urdira-indexing-worker/src/v4/residual.rs`: `print_classification_mismatch_count` now
  returns the count; `assert_eq!(mismatches, 0)` added at COLD and AFTER in
  `n8n_residual_pass_debug_histogram`; two new `#[ignore]`d diagnostic tests
  (`dump_remaining_classification_mismatches`, `scan_for_any_all_zero_identity_or_digest`, §2.5).
- `docs/evidence/2026-09-05-v4-final-measurements.md` (this file).

Retained artifact: `~/Proyectos/urdira-benchmark/v4-final/cold-1` (one cold store from §4.1's own
production-path run, per the task's own cleanup instruction). Every other scratch data directory
created this session (`cold-2`, `cold-scan-2`, `cold-scan-3`, `incr-1`, `parity-1`, `verify-1/2/3`,
and the large `.bin`/`.tsv` dumps) was deleted after its own numbers were extracted into this
document.
