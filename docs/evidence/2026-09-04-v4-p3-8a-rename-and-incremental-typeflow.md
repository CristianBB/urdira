# P3-8a: rename-through-daemon 50-record mismatch + incremental typeflow `ProgramIndex`

Machine: macOS arm64 (Darwin, macOS 26.5.1), 10 cores, 32 GB RAM. `rustc`
1.98.0 (release build for n8n-scale runs), Node 24.18.1. Not committed, per
task instructions. Load average at measurement time was 14-15 (other
processes on this shared machine, not started by this task) — not a
perfectly idle box; relative comparisons (this session's own before/after,
and against the P2-2e evidence doc's own numbers taken under similar
conditions) are still meaningful, absolute numbers carry that caveat.
Corpus: `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02` (14,082 JS/TS
owners), read-only throughout (`.urdira-shared-corpus-readonly` marker
present, confirmed before touching it); `n8n_incremental_measurement`
copies nothing (it scans the corpus path directly but only ever WRITES to
`URDIRA_V4_N8N_DATA`, a separate fresh directory) and
`n8n_incremental_create_delete_roots_match_oracle` uses its own pre-existing
`scratch_copy_of_n8n_corpus` guard.

Owned this session: `crates/urdira-indexing-worker/src/v4/*`,
`crates/urdira-jsts-typeflow` (all of it — new incremental API), `crates/
urdira-jsts-syntax-worker` (untouched this session — API-compatible, no
edit needed), `crates/urdira-structural-store` (untouched this session).
Also touched, outside the crate list, because item 1's actual root cause
lived there: `scripts/v4-mutation-harness.mjs` (a plain `.mjs` test
harness script, not TypeScript, not owned by the concurrent P4-b-1 agent's
"tests/config/storage-engine TS" scope) — see §1.3 for why. No other
TypeScript file was touched.

## 1. Item 1 — the 50-record rename mismatch was a harness bug, not a Rust bug

### 1.1 Reproducing it

`tests/v4-mutation-harness.test.ts`'s `"reaches durable for a real
fs.rename() ... "` test failed deterministically (3/3 runs) with:

```
AssertionError: expected [ …(50) ] to have a length of 4 but got 50
```

on `rewriteMismatch.only_in_incremental` (`rename_rewrite`'s `records`
root mismatch against a from-scratch oracle). The task brief listed four
hypotheses, all plausible on paper: the daemon delivering the rename as
split bursts, the P3-2 mixed-burst split re-opening rows in the wrong
order, the rename fast path skipping closes, or `CandidateIndex`
re-resolution leaving importers pointed at the old path.

### 1.2 What the failure actually was

Reproduced the SAME scenario directly (bypassing the daemon, calling
`scripts/v4-mutation-harness.mjs`'s `run()` from a plain Node script) and
got the OPPOSITE result: `only_in_incremental`/`only_in_from_scratch` both
length 4, matching decision 11's own prediction exactly (rewriting 4
importers' import specifiers chains their own `jsts:entity_container`
rows, nothing else). Re-ran the plain-Node repro 5/5 times: always correct.
Re-ran the vitest test 3/3 times: always wrong (`50`, actually `>=50` —
`compareRootSets`' own `only_in_incremental`/`only_in_from_scratch` arrays
are capped at 50 for display, `truncated: true`). Same code, same
corpus, same mutation sequence, deterministically opposite results
depending ONLY on how the harness was invoked — this pointed at the
comparison/verification code itself, not at the incremental store.

Instrumented `oracleVerify` (temporarily) to decode both stores' visible
record sets through the REAL native addon (`NativeStructuralStoreHandle`,
which correctly understands every on-disk format) immediately after
`compareRootSets`' OWN (JS, raw-byte) comparison had already run and
returned its answer for the SAME two directories. The native-addon decode
always found exactly 4 mismatches (correct); `compareRootSets`, called a
moment earlier over the identical on-disk bytes, had already returned
`50+`. Reading a `MANIFEST` file directly settled it:

```json
{ "base": "base-1", "deltas": ["delta-2.seg", "delta-3.seg", "delta-4.seg", "delta-5.seg", "delta-6.seg"], ... }
```

`manifest.deltas` names **files** (P3-6 item 1's single-file delta
container format, `docs/evidence/2026-09-02-v4-p2-3-structural-store.md`
§1.1a) — but `scripts/v4-mutation-harness.mjs`'s own `readSegmentRows`/
`readClosureRows` (written before P3-6 shipped) still did
`join(dirPath, spec.keyFile)`, i.e. tried to read
`".../delta-6.seg/records.keys"` — a path INSIDE a plain file, which
`existsSync` correctly reports as absent. Both functions silently
returned `[]` for **every** delta generation, unconditionally, since the
day the container format landed: `computeVisibleKeySet` for any store
with deltas therefore only ever saw the BASE generation's rows, missing
every later open AND every later close.

This bug was invisible everywhere else because `compareRootSets`' own
fast path (`rootA === rootB`, comparing `MANIFEST.roots` — computed by
the Rust worker itself, never touched by this bug) short-circuits BEFORE
ever calling `computeVisibleKeySet`, for every case where the two stores'
roots already agree. It only fires the slow, broken path when roots
genuinely differ — which is exactly `rename_rewrite`'s own expected case
(decision 11 predicts a REAL, deliberate mismatch there) and nothing
else in the existing suite exercises. `rename_no_rewrite` (roots equal,
fast path) and the whole SECOND test in the same file (`edit`/`hub_edit`,
which only assert the equal/not-equal BOOLEAN, never an exact count) never
touched the broken code path at all.

**The incremental structural store itself was correct the entire time** —
none of the task brief's four Rust-side hypotheses were the actual bug.

### 1.3 The fix

`scripts/v4-mutation-harness.mjs`: added `SECTION_ID` (the exact
`SectionId` numbering from `crates/urdira-structural-store/src/
container.rs`, copied as on-disk format, not guessed), `readContainerSections`
(parses one `.seg` container's table of contents into `section_id ->
Buffer`), and `readNamedSection` (dispatches on whether a "segment
directory" argument is actually a directory — base, unchanged — or a
`.seg` file — delta, now parsed as a container). `readSegmentRows`/
`readClosureRows` now go through `readNamedSection` instead of
`existsSync`+`readFileSync` directly; `computeVisibleKeySet` is
otherwise unchanged. This file is a plain `.mjs` script (not TypeScript,
not one of the concurrent P4-b-1 agent's "tests/config/storage-engine TS"
files) and the fix is a narrow, mechanical bring-up-to-date-with-P3-6
change with no behavior change for anything that was already passing (the
fast path is untouched; only the previously-always-empty slow path now
reads real data) — verified by re-running the FULL existing vitest suite
below, all still green.

### 1.4 Rust-side regression tests added anyway (per the task's own request)

Even though the root cause was JS-side, the task explicitly asked for
three orderings tested directly against `scan::run` with the invariant
"the store's visible set equals a from-scratch scan of the final tree" —
implemented as three tests in `crates/urdira-indexing-worker/src/v4/
tests_e2e.rs`, using `src/domain/task.ts` (a file WITH real importers,
unlike the pre-existing `errors.ts`-based test, so a stale-owner-ordinal
or `CandidateIndex` bug touching importers would surface):

1. `incremental_rename_roots_match_a_from_scratch_scan_of_the_mutated_tree`
   (pre-existing, unchanged) — combined `Changed{[Deleted old, Created
   new]}` in ONE command.
2. `incremental_rename_via_create_then_delete_in_two_generations_matches_a_from_scratch_scan`
   (new) — `Changed{[Created new]}` then `Changed{[Deleted old]}` as TWO
   separate `scan::run` calls (the new path briefly coexists with the old
   one on disk).
3. `incremental_rename_via_delete_then_create_in_two_generations_matches_a_from_scratch_scan`
   (new) — the reverse: `Changed{[Deleted old]}` then `Changed{[Created
   new]}` (neither path exists on disk in between).

All three assert `records`/`dependency`/`graph` roots match a from-scratch
scan of the final tree exactly. All three pass:

```
test v4::tests_e2e::incremental_rename_roots_match_a_from_scratch_scan_of_the_mutated_tree ... ok
test v4::tests_e2e::incremental_rename_via_delete_then_create_in_two_generations_matches_a_from_scratch_scan ... ok
test v4::tests_e2e::incremental_rename_via_create_then_delete_in_two_generations_matches_a_from_scratch_scan ... ok
```

confirming the incremental store's own rename handling is correct under
every event-ordering a real watcher could plausibly deliver, independent
of the harness bug.

### 1.5 Result

`tests/v4-mutation-harness.test.ts` (all 7 cases, including the
previously-failing rename test) — re-run 4 times (3 alone, once as part
of the full required suite below), stable green every time:

```
Test Files  1 passed (1)
     Tests  6 passed | 1 skipped (7)
```

## 2. Item 2 — incremental `ProgramIndex` (typeflow per-edit cost)

### 2.1 The API: `crates/urdira-jsts-typeflow`

`ProgramIndex::build`'s original single method (a from-scratch four-pass
closure — pass 1 per-file registration, pass 2 `CallMember` heritage,
pass 3 return-inference fixed point, pass 4 `ReturnTypeOfFn`/
`IndexedAccess` fixed point) was refactored, WITHOUT changing its own
output, into reusable per-file/per-set building blocks
(`insert_file_pass1`, `run_pass2_for_summary`,
`collect_pending_for_summary`, `run_fixed_point_pass3`,
`run_fixed_point_pass4`) — verified byte-identical by re-running the
crate's full existing 38-test suite unchanged immediately after the
refactor, before adding anything new.

`ProgramIndex` gained incremental bookkeeping (`summaries`,
`import_targets`, `entity_owner`, `file_entities`, `file_import_keys`,
`importers_of`) and three new public methods:

- `replace_file(path, summary, import_targets_updates)` — installs
  `summary` as `path`'s current `DeclSummary` and reflows exactly the
  AFFECTED COMPONENT: `path` itself plus every file that currently
  imports one of `path`'s entities, TRANSITIVELY (`importers_of`, a
  reverse index built from `import_targets`, walked via
  `transitive_importers_closure`) — not the whole corpus.
- `add_file` — an alias (a `DeclSummary` has no notion of "new" vs
  "changed"; `transitive_importers_closure` for a genuinely new path is
  just `{path}`, since nothing could import a path that didn't exist).
- `remove_file(path)` — drops `path` and reflows its former importers'
  transitive closure so they correctly degrade to "unresolved" wherever
  they depended on something only `path` declared.

`import_targets_updates` is the caller's freshly-resolved needed-imports
snapshot for `path` (and, for full correctness against an edit that
shifts an exported entity's `start`-keyed id, for `importers_of(path)`
too, queried by the caller before the edit) — `ProgramIndex` cannot
resolve imports itself (unchanged architectural boundary, same reason the
original `build` took a caller-resolved map).

**Two real bugs found and fixed while proving this correct** (both via
the randomized test below, both would have been silent, low-frequency
correctness gaps in production):

1. `link_importer` called eagerly inside the old `merge_import_target_
   updates` silently dropped every importer edge pointing at a file being
   `replace_file`d — its OWN new entities aren't registered in
   `entity_owner` yet at that point (pass 1 for them hasn't run). Split
   into `apply_import_target_updates` (installs `import_targets`/
   `file_import_keys` only) + a deferred `link_importer` pass run AFTER
   `reflow_files` re-registers the affected files' current entities.
   Caught at test step 58→83: `f15.ts`'s `importers_of` set silently
   became `[]` immediately after its own first edit, permanently (every
   later edit to `f15.ts` then wrongly saw "no importers to refresh").
2. `remove_file` left a removed file's OLD entity id as the STORED VALUE
   in an importer's `import_targets` entry — `resolve_heritage_target`/
   `resolve_raw_type_ref` only ever consult `import_targets`, they never
   verify the resolved id still exists in `containers`, so the dangling
   id survived into `extends`/`type_ref` — an observable difference from
   a from-scratch rebuild (which never had that key at all), even though
   an actual member/type QUERY through either state degrades to the same
   answer. Fixed with `purge_import_targets_targeting_file`, which
   proactively drops every importer's entry pointing at the removed
   file's entities, called from both `remove_file` and (defensively,
   regardless of whether the caller remembers to refresh an importer)
   `replace_file`.

### 2.2 Correctness test: 70-file synthetic project, 400 random edits

`crates/urdira-jsts-typeflow/src/lib.rs`'s
`incremental_matches_from_scratch_after_random_edit_sequences_over_synthetic_project`:
generates 70 files (`f0.ts`..`f69.ts`), each declaring `ClassN`/`IfaceN`/
`funcN`, with a fixed-seed xorshift64 PRNG choosing per-file whether it
also `extends`/imports a RANDOM EARLIER file's class/interface/function
(exercising heritage, member declared types, and the pass-3 return-
inference fixed point across files) — real TypeScript source run through
the crate's own `extract_decl_summary` (oxc parse), not hand-built
`DeclSummary` structs. Then applies 400 random edits (remove / add / 
replace, `MIN_FILES: 10` floor so the corpus never empties), each one
driving BOTH an incrementally-maintained `ProgramIndex` (via `replace_
file`/`add_file`/`remove_file`, with `import_targets_updates` scoped to
exactly the edited file plus — for a replace — its DIRECT importers,
queried pre-edit) and a from-scratch `ProgramIndex::build` over the same
resulting corpus, comparing `containers`/`function_return_types`/
`variable_types` (the index's ENTIRE observable state, not roots) after
EVERY single step:

```
test tests::incremental_matches_from_scratch_after_random_edit_sequences_over_synthetic_project ... ok
```

Re-ran with 5 additional seeds (1-5, all different from the committed
fixed seed) — all pass. Full crate suite: 39/39.

**Known, accepted scope gap** (documented in `urdira-indexing-worker/src/
v4/typeflow.rs`'s own module doc, not attempted here): a `create` that
satisfies a PREVIOUSLY-broken import (some existing file's heritage/type-
ref/pending-return reference that never resolved because the target
didn't exist yet) is not automatically re-discovered by `add_file` alone
— nothing could have registered an importer relationship to a file that
didn't exist. The test's own random generator deliberately never produces
this ordering (imports only ever target an EARLIER, already-existing
index) for the identical reason. `analyze::run_incremental`'s own
`CandidateIndex`-based reverse-affected closure already discovers this
case for the hybrid E1-E3 lane; wiring `TypeflowCache` to also reflow
that widened set (not just literally changed/added/deleted paths) is the
natural follow-up, out of this task's scope.

### 2.3 Wiring: `crates/urdira-indexing-worker/src/v4/typeflow.rs`

`TypeflowCache` now keeps a persistent `index: Option<ProgramIndex>` plus
a dirty set (`pending_upserted`/`pending_removed`) instead of rebuilding
`ProgramIndex::build` from the FULL `summaries` map on every
`build_index` call. `replace_file`/`add_from_owner`/`remove` (called from
`delta.rs` at catalog-delta time, BEFORE a resolver/available/files triple
exists for this generation) only mark paths dirty; `build_index` (called
later from `analyze.rs::run_scoped`, which DOES have that triple) applies
exactly the dirty set: `remove_file` for `pending_removed`, `replace_file`
for `pending_upserted` — each with `import_targets_updates` computed by a
NEW `resolve_import_targets_for`, scoped to `{path} ∪ index.importers_of(path)`
(pre-edit) instead of a full-corpus sweep (the OTHER O(corpus) cost this
module's own needed-imports collection used to pay every call, alongside
`ProgramIndex::build`'s own closure — both addressed together).
`build_index`'s signature changed from `&self -> ProgramIndex` (owned, by
value) to `&mut self -> &ProgramIndex` (a reference into the persistent
index) — required `run_scoped`/`run_incremental`'s own `typeflow`
parameter to become `&mut TypeflowCache` (propagated through `run_cold`,
`delta.rs`'s `.as_mut()`, and two `tests_e2e.rs` call sites). Two new
tests in `typeflow.rs` itself: determinism across two INDEPENDENT cold
caches (replacing the old test, which called `build_index` twice on ONE
cache — no longer meaningful once the second call is a no-op warm path
over an empty dirty set), and `build_index_incremental_matches_a_fresh_
cache_after_an_edit` (edits `b.ts` in a way that shifts `Base`'s own
entity id, confirms the incrementally-updated index's `a.ts` heritage
resolution — `Foo extends Base`, `Foo.greet()`'s member lookup — matches
a from-scratch `TypeflowCache` built directly over the same final state).

### 2.4 Measured: n8n scale (14,082 owners), one persistent worker process

```
URDIRA_V4_N8N_CORPUS=<corpus> URDIRA_V4_N8N_DATA=<fresh-dir> URDIRA_DEBUG_TIMING=1 \
cargo test -p urdira-indexing-worker --release v4::tests_e2e::n8n_incremental_measurement -- --ignored --nocapture
```

| Step | Wall (`ScanCompleted`) | `parse_ms` | `resolve_ms` | typeflow `build_full` | typeflow `build_index` |
|---|---:|---:|---:|---:|---:|
| COLD (gen 1) | 21.622s | 1,793ms | 1,627ms | 1.564s (14,082 files) | 0.223s |
| EDIT#1 (gen 2, first edit) | 1.386s | 541ms | 7ms | — | **0.000s** |
| EDIT#2 (gen 3, steady-state) | 0.595s | 202ms | 7ms | — | **0.000s** |
| CREATE (gen 4) | 0.503s | 151ms | 7ms | — | **0.000s** |
| DELETE (gen 5) | 0.483s | 147ms | 8ms | — | **0.000s** |
| EDIT#3 (gen 6) | 0.515s | 155ms | 10ms | — | **0.000s** |
| RENAME (gen 7) | 0.632s | 154ms | 7ms | — | **0.000s** |
| HUB surface-unchanged (gen 8) | 0.545s | 175ms | 10ms | — | **0.000s** |
| HUB surface-changed (gen 9, ~841-owner widen) | 1.155s | 184ms | 116ms | — | **0.000s** |

`0.000s` is the sub-timer's own 3-decimal print resolution (`{:.3}` in
the existing `URDIRA_DEBUG_TIMING` line) — i.e. rounds to under 0.5ms,
for every incremental generation regardless of mutation kind OR affected-
closure size (the hub surface-changed case widens to ~841 reverse-
affected owners for the HYBRID lane, per `resolve_ms`'s own jump to
116ms there, yet typeflow's own `build_index` call for that same
generation still rounds to zero — because typeflow's incremental cost is
now proportional to `{hub file} ∪ its DIRECT importers` — however many
those are for this specific hub — not to the widened hybrid-lane closure
size).

**Gate**: target "typeflow ≤ 40ms per steady edit" — **met by roughly two
orders of magnitude** (0.165-0.35s baseline → <0.5ms measured) for EVERY
kind measured, including the worst-case hub-edit surface-changed
scenario, not just the steady worker-only case the target named. Cold
typeflow cost is unchanged (`build_full` 1.564s + `build_index` 0.223s ≈
1.79s), matching the task's own allowance ("cold typeflow may stay ~1.8s
(report)").

**Roots equality**: `n8n_incremental_create_delete_roots_match_oracle`
(create + delete against a from-scratch oracle at full n8n scale, WITH
typeflow's new incremental path live) —

```
n8n-scale root equality CONFIRMED for create+delete against a from-scratch oracle
test v4::tests_e2e::n8n_incremental_create_delete_roots_match_oracle ... ok
```

Rename root equality is verified at FIXTURE scale (§1.4's three
orderings, all exact) — same scoping precedent the pre-existing P2-2e/
P3-1 evidence docs already used (n8n scale for create/delete, fixture
scale for rename), not repeated at n8n scale this session.

## 3. Quality gates

- `cargo fmt --all -- --check`: clean.
- `cargo clippy -p urdira-indexing-worker -p urdira-jsts-typeflow -p urdira-jsts-syntax-worker -p urdira-structural-store --all-targets -- -D warnings`: clean.
- `cargo test -p urdira-jsts-typeflow --lib`: **39/39** (38 pre-existing + 1 new randomized incremental-vs-from-scratch test).
- `cargo test -p urdira-indexing-worker --bin urdira-indexing-worker`: **71/71** non-ignored (2 new rename-ordering tests, 2 new typeflow-wiring tests), 3 n8n-scale `#[ignore]`d run separately below.
- `cargo test -p urdira-jsts-syntax-worker --lib`: **154/154** (untouched this session, confirmed still green).
- `cargo test -p urdira-structural-store`: all 6 integration suites green (untouched this session, confirmed still green).
- n8n-scale, `--release`, `--ignored`:
  - `v4::tests_e2e::n8n_incremental_create_delete_roots_match_oracle`: **PASSED** (§2.4).
  - `v4::tests_e2e::n8n_incremental_measurement`: timings in §2.4.
- `npx vitest run tests/v4-mutation-harness.test.ts tests/v4-daemon-e2e.test.ts tests/v4-scan.test.ts tests/codebase-fixtures.test.ts` (native addon + worker binary rebuilt via `node scripts/build-native.mjs --release` first, so every test exercised the ACTUAL code in this diff): **15 passed, 2 skipped** (pre-existing, unrelated skips), 0 failed — includes the previously-failing rename test, now green.

## 4. Files touched

- `crates/urdira-jsts-typeflow/src/lib.rs` (incremental `ProgramIndex` API + 3 new tests; `build`'s own output byte-identical to before, verified by the pre-existing 38-test suite passing unchanged before any new code was added)
- `crates/urdira-indexing-worker/src/v4/typeflow.rs` (rewritten: persistent `ProgramIndex` + dirty-set wiring, scoped `resolve_import_targets_for`, 2 tests replaced/added)
- `crates/urdira-indexing-worker/src/v4/analyze.rs` (`typeflow: &TypeflowCache` → `&mut`, `run_scoped`/`run_cold`/`run_incremental`; one `needless_borrow` clippy fix at the `HybridResolutionContext` construction site, a direct consequence of `build_index` now returning `&ProgramIndex` instead of an owned value)
- `crates/urdira-indexing-worker/src/v4/delta.rs` (`typeflow_cache.as_ref()` → `.as_mut()`)
- `crates/urdira-indexing-worker/src/v4/tests_e2e.rs` (2 new rename-ordering regression tests; 2 pre-existing test call sites updated for `run_incremental`'s new `&mut` parameter)
- `scripts/v4-mutation-harness.mjs` (container-format-aware `readSegmentRows`/`readClosureRows`/`readNamedSection`/`readContainerSections`/`SECTION_ID` — the actual item-1 fix)
