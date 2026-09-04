# P3-3: digest-churn root cause, closure narrowing, and residual-perf items

Machine: macOS arm64 (Darwin 25.5.0), 10 cores, 32 GB RAM, NVMe. `rustc`
1.98.0 (release build), Node 24.18.1. Not committed, per task instructions.
Corpus: `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`
(20,148/20,281 files, 14,082 JS/TS owners), READ-ONLY throughout this
session — verified byte-identical to `~/Proyectos/n8n` both
mid-session and at the end (§7).

## 1. Digest-churn root cause (item 1) — NOT extraction nondeterminism

`docs/evidence/2026-09-03-v4-p3-2-incremental-residuals.md` §6 left this as
an open hypothesis: at n8n hub-edit scale (`packages/nodes-base/utils/
utilities.ts`, 841 transitively-affected owners), `diff_owner` classified
~100% of those 841 owners' own records as "replacement", not "unchanged,
keep", even though none of their bytes changed. The candidates it listed
(`evidence_references`/`proposal_record_key` batch-sensitivity, typeflow
resolution differences, `facets` order) were all extraction-layer
hypotheses.

### 1.1 Minimal reproduction

Built a 3-file fixture (`a.ts` imports `b.ts` imports `c.ts`) and a Rust
test, `unaffected_transitive_importer_produces_identical_records_across_
an_incremental_edit` (`crates/urdira-indexing-worker/src/v4/tests_e2e.rs`):
cold-scan the fixture, capture `a.ts`'s `Vec<ProposedRecord>` straight from
`analyze::run_cold`'s own output (the facts-extraction layer, one level
below materialize/diff/write), then edit `c.ts` only (renaming its export
— a genuine surface change, see §2) and capture `a.ts`'s `Vec<ProposedRecord>`
again from `analyze::run_incremental`'s output in the SAME process (same
`SyntaxWorkerState`). **Result: byte-for-byte, field-for-field identical**
(`assert_eq!(cold_a_records, incremental_a_records)` passes) — `a.ts` is
never reparsed for a content edit of `c.ts` (only `changed_sources` gets
reparsed; every other file in `next_files` is a clone of `prior.files`),
so its `ProposedRecord`s are trivially identical. **This disproves every
extraction-layer hypothesis P3-2 listed**: the facts pipeline itself is
already a pure, deterministic function of file content for an unaffected
owner.

### 1.2 The real bug: `diff_owner` never sees `a.ts`'s OWN previous records

Extended the repro with a second test that runs the SAME edit through the
real `scan::run` pipeline (`unaffected_transitive_importer_produces_zero_
record_churn_in_the_store`) and compares `a.ts`'s exact `record_id` SET at
generation 1 vs. generation 2 via the store reader. **Before the fix: the
two sets were COMPLETELY DISJOINT** (6 record ids on each side, zero
overlap) — not a byte-diff of ProposedRecord fields (there is none, per
§1.1), but every one of `a.ts`'s records getting a brand-new chained id.

Root cause, found by reading `crates/urdira-indexing-worker/src/v4/
delta.rs`'s `run_one`: `old_entries` (the pre-`Catalog::apply` snapshot of
each named path's `FrontierEntry`, needed to resolve an owner's OLD
dictionary ordinal) is built ONLY from the request's literal
`changed_paths` (e.g. `["c.ts"]`) —

```rust
let old_entries: HashMap<String, Option<FrontierEntry>> = changed_paths
    .iter()
    .map(|p| (p.path.clone(), workspace_state.frontier.present.get(&p.path).cloned()))
    .collect();
```

— but `old_owner_ordinal` is then called for EVERY path in
`affected_owner_paths`, which `analyze::run_incremental`'s own
`reverse_affected_closure` widens to every TRANSITIVE importer of the
edited file (`b.ts`, `a.ts`, and (at n8n scale) 839 more). For any of
those widened-but-not-literally-named paths, `old_entries.get(path)`
returned `None` — **indistinguishable from "this is a genuinely new
path"** — so `old_owner_ordinal` returned `None`, and `diff_owner` was
handed an EMPTY `prev` for an owner whose records were, in fact, live and
completely unchanged. Every one of that owner's freshly-materialized
(byte-identical) records then fell through the "no live row under this
identity in THIS owner" branch to `by_identity_last`'s global fallback
(owner migration / reopen), both of which CLOSE the existing row and OPEN
a new chained id — the exact "opened ≈ closed ≈ record count" symptom
P3-2 measured (≈107,000 each, out of 356,905 records, at the real n8n hub
edit).

### 1.3 Fix

`old_owner_ordinal` (`delta.rs`) now falls back to the POST-`Catalog::
apply` `workspace_state.frontier.present` for any path `old_entries` has
no entry for:

```rust
fn old_owner_ordinal(
    path: &str,
    old_entries: &HashMap<String, Option<FrontierEntry>>,
    current_present: &HashMap<String, FrontierEntry>,
    ordinal_of: &HashMap<(String, String), u32>,
) -> Option<u32> {
    let entry = match old_entries.get(path) {
        Some(pre_apply_entry) => pre_apply_entry.as_ref(),
        None => current_present.get(path),
    }?;
    ordinal_of.get(&(entry.artifact_id.clone(), entry.artifact_version_id.clone())).copied()
}
```

This is exactly correct, not an approximation: `Catalog::apply`'s delta is
scoped to the literal `changed_paths` batch, so any path OUTSIDE that
batch has an UNCHANGED frontier entry — "old" and "current" are the same
value for it. Two call sites updated (`affected_owner_paths` loop and the
deleted-owner loop), plus a `current_present` binding threaded from
`workspace_state.frontier.present`.

### 1.4 Regression tests (both required by this task, both pass post-fix)

- `unaffected_transitive_importer_produces_identical_records_across_an_
  incremental_edit` — extraction-layer proof (§1.1), independent of the
  fix (it was already true before).
- `unaffected_transitive_importer_produces_zero_record_churn_in_the_store`
  — diff-layer proof: `a_records_gen1 == a_records_gen2` (exact
  `record_id` sets) after an edit that legitimately widens the closure to
  `a.ts`/`b.ts` (renaming `c.ts`'s export — see §2 for why a pure
  ADDITION no longer widens at all). **Before the fix this failed with
  completely disjoint sets** (confirmed live, not asserted from theory);
  after the fix it passes.

### 1.5 Re-measured: n8n hub edit `write_ms`

| | opened_records | record_closures | opened_deps | deps_closures | write_ms |
|---|---:|---:|---:|---:|---:|
| P3-2 baseline (841 owners, surface-unchanged) | ~107,000 | ~107,000 | n/a | n/a | 6,228–6,630 |
| This session, item 1 only (841 owners still widened, no narrowing yet) | 3 | 1 | 2,657 | 2,657 | 396 |

`write_ms` collapsed **~94–95%** (6.2–6.6s → 0.4s) purely from item 1 —
before item 2's closure narrowing was even implemented. `opened_deps`/
`deps_closures` still churn fully at owner granularity (2,657 each) — a
PRE-EXISTING, already-documented scope narrowing (`delta.rs`'s own module
doc: "Dependency rows are diffed at OWNER granularity, not by
`dependency_id`"), not part of this bug and not touched by this fix.

## 2. Affected-closure narrowing (item 2)

Implemented entirely in `urdira-indexing-worker::v4::analyze::run_scoped`
(the v4 delta orchestrator), NOT in the shared `urdira-jsts-syntax-worker`
closure code, per the task's own guidance.

**Rule**: for a genuine content edit (`reset_reason.is_none()` from
`syntax.analyze()` — i.e. NOT `path_membership_incremental`'s add/remove
path and NOT a cold/full reset, both of which keep their existing,
unnarrowed behavior), compute each edited path's **exported surface**
before and after the edit — every `export_bindings` entry, with a direct
(non-re-exported) binding's local name resolved to its current entity id
(`(exported_name, local_entity_id, source_specifier, source_target_path)`,
a `BTreeSet<ExportedSurfaceEntry>`). If every edited path's PRE-edit
surface is a SUBSET of its POST-edit surface (i.e. nothing existing was
removed or changed — pure additions are fine), the affected-owner set
narrows from `analyze()`'s full widened closure down to EXACTLY the
literal edited paths; otherwise the full widened closure is kept
unchanged.

Subset (not exact-equality) is deliberate: a PURE ADDITION (a brand-new
export appearing) cannot invalidate any EXISTING importer's
already-resolved reference, so it must not force reprocessing 841 owners
just to re-discover "unchanged, keep" for all of them (item 1's fix would
make that safe, but still wasteful). Removing/renaming/shifting an
existing binding always counts as changed (not a subset) and widens, since
an importer's `target_id` embeds the export's own `stable_entity_id`
(`jsts:{kind}:{path}:{start}:{name}`), which changes under a rename or a
span shift from code inserted earlier in the file.

**Documented residual**: an importer that already carries an UNRESOLVED
import naming exactly a newly-added export (`checker_pending` on its own
side) is not reprocessed by this narrowed scan and stays unresolved one
generation longer than a from-scratch scan would leave it. Same category
of gap as the pre-existing `path_membership_incremental` fast path (its
own doc comment already accepts an equivalent narrowing for pure
add/remove batches) — not new, not blocking, flagged for whoever revisits
closure narrowing next.

**Regression test**: `surface_unchanged_edit_narrows_the_affected_closure_
to_the_literal_edit` — edits `c.ts`'s value only (keeps its export's
name/position), asserts `analyze::run_incremental`'s returned owners are
EXACTLY `["c.ts"]` — `b.ts`/`a.ts` are absent from the result entirely,
not merely diffed to a no-op.

**Measured** (worker-only, hub edit of `packages/nodes-base/utils/
utilities.ts`):

| Variant | affected_owners | write_ms | total_ms |
|---|---:|---:|---:|
| surface-unchanged (adds a new export, touches none existing — item 2 correctly narrows) | 1 | 178 | 571 |
| surface-changed (renames an existing export — item 2 correctly widens) | 841 | 458 | 1,236 |

Surface-unchanged: `total_ms` 571ms, comfortably under the ≤1.0s target
(P3-2 baseline for the equivalent case: 6,901–7,564ms — a **>90%**
reduction). Surface-changed: 841 owners correctly widened (this is a REAL
semantic change — many owners' cached relation records reference the
renamed export's old id and legitimately need re-diffing), `total_ms`
scales with the true dependent count rather than being artificially
capped — proportional, as required.

## 3. `parse_ms` reduction (item 3) — partial

### 3.1 Root cause found and fixed: the double full-corpus clone

`SyntaxWorkerState::analyze` (`urdira-jsts-syntax-worker/src/lib.rs`)
opened with:

```rust
let prior = self.projects.get(&project_key).cloned();
```

— an UNCONDITIONAL full clone of the ENTIRE prior `ProjectState` on EVERY
call (cold, edit, add/remove alike), including `files: BTreeMap<String,
SyntaxFileResult>` (one entry per corpus file — 14,082 at n8n scale — each
carrying its own `entities`/`relations`/`direct_imports`/`export_bindings`
vectors). The two non-`path_membership_incremental` branches then cloned
`state.files` AGAIN to seed `next_files` — the SAME data cloned twice per
call.

**Fix**: `prior` is now a borrow (`self.projects.get(&project_key)`, no
`.cloned()`), used for every read (root_names/configuration_digest/
source_metadata/pending_analysis comparisons, `reverse_affected_closure`'s
own `&state.files` read) without ever needing to own it; the ONE real
clone this function needs (`next_files`'s own starting point) is still
paid, exactly once, where it always was. Confirmed by the borrow checker
(no explicit lifetime gymnastics needed — `prior`'s last use is always
before this function's own `self.projects.insert(...)`/`get_mut(...)`
calls) and by the full 151-test `urdira-jsts-syntax-worker` suite,
including `incremental_root_add_reresolves_a_higher_priority_extension_
shadow` (the exact shadowing case this refactor had to not break).

**Measured** (worker-only, steady-state edit, `parse_ms`):

| | Before (this session's own P3-2-equivalent baseline) | After |
|---|---:|---:|
| EDIT#2/#3 | 292–332 | 177–183 |

~40–46% reduction, isolated to this ONE fix.

### 3.2 What was NOT fixed (deliberately, correctness risk)

`path_membership_incremental`'s own `reresolve_file` sweep (pure
create/delete/rename) remains O(corpus): `stale_paths` is still every
currently-known path not itself in the `changed`/`removed` set, and
`reresolve_file` is called for each one. This is the exact "shadowing"
case P3-1/P3-2 flagged (`docs/evidence/2026-09-02-file-creation-diagnosis.md`):
adding `./foo.ts` can change which candidate a DIFFERENT, byte-identical
file's `./foo` import specifier resolves to, purely because
`probe_extensions`' fixed priority order now finds a different match —
`incremental_root_add_reresolves_a_higher_priority_extension_shadow`
(existing test) proves this is a REAL, exercised case, not a theoretical
one. Narrowing this sweep safely would require a genuine reverse index of
"specifiers that could plausibly resolve differently given this added/
removed path" (by base name / extension family), which does not exist
today and was judged too large a change, with real correctness risk, for
this session's remaining time. Flagged as the clearest next item for
whoever continues `parse_ms` work on create/delete/rename.

### 3.3 Gate results

| Kind | Target | Before (P3-2) | After (this session) |
|---|---|---:|---:|
| Edit steady-state | ≤500ms (stretch 400) parse_ms ≤100ms | 703–918ms total / 268–396ms parse | 614–686ms total / 177–183ms parse — **target not fully met**, real ~25–35% total / ~40% parse improvement |
| Create/delete/rename | ≤800ms | 976–1,178ms | 848–986ms — **target not fully met** (still O(corpus) `reresolve_file`), ~9–23% improvement |

## 4. `write_ms` reduction (item 4)

### 4.1 Sub-timers added

`urdira_structural_store::writer::SegmentWriter::write_delta_with_reader`
now prints (behind the SAME `URDIRA_DEBUG_TIMING` env var
`urdira-indexing-worker`'s own "DEBUG BISECT" lines already use):
`segment_files` / `closures` / `merkle_load_update` / `persist_slots` /
`fsync` / `manifest` / `total`.

**Before any item-4 fix** (steady edit, 3 opened records, 0 closures):

```
segment_files=0.057s closures=0.010s merkle_load_update=0.026s persist_slots=0.005s fsync=0.061s manifest=0.011s total=0.171s
```

`segment_files` (57ms) and `fsync` (61ms) dominate — together ~70% of a
tiny 3-record delta's write time, essentially FIXED cost independent of
row count (341-record and 5-record deltas both measured 190–200ms before
this item's fix).

### 4.2 Root cause: `fsync_segment_dir` pays one `F_FULLFSYNC` per file, and every delta writes 15-18 files regardless of how much of it is genuinely empty

`fsync_segment_dir` (`manifest.rs`) opens and `.sync_all()`s every regular
file in the delta directory individually — on macOS, `File::sync_all()`
issues `fcntl(F_FULLFSYNC)`, which forces an actual device-level cache
flush (materially more expensive than a plain `fsync()`, by design, for
durability). A minimal delta unconditionally wrote: 5 hot-record files +
6 secondary-array files (both proportional to `opened_records`, genuinely
non-empty here) + 3 `deps.*` files (ALWAYS written, even for 0 opened
deps) + `dict.bin`/`subjects.keys` (ALWAYS written, even when the delta's
dictionary additions are empty) + `closures.records`/`closures.deps`
(ALWAYS written, even when the respective closure list is empty) — up to
18 files, several of them carrying ZERO rows for a typical steady-state
edit, each still paying its own `F_FULLFSYNC`.

### 4.3 Fix: skip writing (and therefore fsyncing) genuinely empty files, made safe by an existing precedent

`load_closures` (`reader.rs`) ALREADY tolerates an absent
`closures.records`/`closures.deps` file as an empty closure set (`if
!path.exists() { return Ok(Vec::new()) }`) — this is a PRE-EXISTING
reader guarantee, not something this task adds. `write_delta_with_reader`
now skips writing either closures file when its own list is empty.
`load_dict_file`/`load_subjects_file` did NOT have the same tolerance
(they `std::fs::read` unconditionally) — added it, mirroring
`load_closures`'s exact pattern (absent = `Dictionaries::default()` /
empty `Vec`), and `write_dict_files` (shared by both cold `write_base` and
incremental `write_delta_with_reader`) now skips `dict.bin` when the five
dictionaries it covers are all empty, and `subjects.keys` when
`dicts.subjects` is empty. **`deps.keys`/`deps.meta`/`deps.reverse` and
every `records.*`/`adj.*` file were deliberately left untouched**:
`Segment::open` mmaps all of them unconditionally for EVERY segment (base
and every delta) with no existence tolerance, and `StoreReader::
verify_all` checksums them by that same fixed name list — making these
skippable would require restructuring the hot READ path (used on every
query, not just this write path), a materially larger and riskier change
than this task's remaining time allowed. This is the on-disk format
staying unchanged in the way that matters: a segment's mandatory file set
is untouched; only the OPTIONAL, already-reader-tolerant files
(`closures.*`, `dict.bin`, `subjects.keys`) are now omitted when
genuinely empty.

**Verified safe**: full `urdira-structural-store` suite (`compact_matches_
pre_compaction_state_and_respects_refcount`, `incremental_roots_match_
from_scratch_across_deltas_and_compaction`, `five_deltas_match_reference`,
`readers_never_observe_a_torn_state_across_a_delta_publish`, recovery
tests, roundtrip, write-base determinism) — all pass with the skip logic
active across many-delta sequences (exercising both empty and non-empty
cases repeatedly).

**Measured** (worker-only, steady edit, 3 opened records, 0 closures,
after the skip):

```
segment_files=0.053s closures=0.000s merkle_load_update=0.017s persist_slots=0.005s fsync=0.057s manifest=0.011s total=0.143s
```

`closures` sub-timer collapses to 0 (both files skipped); `write_delta`
total drops 171ms → 143ms for this case (~16%). `fsync` itself only drops
modestly (61ms → 57ms) since `segment_files`/`by_*`/`adj.*`/`deps.*` (the
untouched mandatory set) still dominate the file count — the full
`F_FULLFSYNC`-per-file cost floor remains, now paid over 2-3 fewer files
per delta on average (closures.deps is empty far more often than not in
this workload; dict.bin is rarely empty since every edit mints a fresh
`artifact_version_id`).

## 5. Final worker-only n8n table (release, in-process, no daemon/watcher, all items applied)

`v4::tests_e2e::n8n_incremental_measurement`, `URDIRA_DEBUG_TIMING=1`,
idle machine confirmed before the run (`pgrep -f "v4-scan|urdira-indexing-
worker|n8n-incremental-preflight"` empty).

| Phase | COLD | EDIT#1 (cold-cache) | EDIT#2 (steady) | CREATE | DELETE | EDIT#3 (steady) | RENAME | HUB surface-unchanged (841 owners widened, then narrowed to 1) | HUB surface-changed (841 owners, correctly widened) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| catalog_ms | 5,325 | 10 | 3 | 5 | 1 | 4 | 5 | 5 | 4 |
| parse_ms | 916 | 1,429 | 183 | 579 | 457 | 177 | 462 | 168 | 180 |
| resolve_ms | 1,333 | 133 | 72 | 68 | 71 | 69 | 68 | 67 | 166 |
| materialize_ms | 7,968 | 30 | 26 | 23 | 24 | 26 | 23 | 28 | 222 |
| write_ms | 3,394 | 202 | 252 | 160 | 150 | 188 | 201 | 153 | 458 |
| **total_ms** | **19,906** | **3,135** | **686** | **986** | **848** | **614** | **904** | **571** | **1,236** |

`write_delta_with_reader` sub-timers for the same runs (segment_files /
closures / merkle_load_update / persist_slots / fsync / manifest):

| Phase | segment_files | closures | merkle_load_update | persist_slots | fsync | manifest | total |
|---|---:|---:|---:|---:|---:|---:|---:|
| EDIT#2 | 53ms | 0ms | 17ms | 5ms | 57ms | 11ms | 143ms |
| CREATE | 45ms | 5ms | 15ms | 5ms | 51ms | 10ms | 132ms |
| DELETE | 49ms | 5ms | 16ms | 13ms | 72ms | 10ms | 166ms |
| RENAME | 49ms | 5ms | 15ms | 5ms | 55ms | 8ms | 136ms |
| HUB surface-unchanged | 57ms | 10ms | 26ms | 116ms | 60ms | 10ms | 279ms |
| HUB surface-changed | — | — | — | — | — | — | (see §2's table; 458ms `write_ms` total, dominated by 1,628 real closures + 2,657 dep churn) |

### Gate comparison (worker-only)

| Kind | Target (this task) | P3-2 baseline | This session | Verdict |
|---|---|---:|---:|---|
| Edit steady-state | ≤500ms (stretch 400) | 703–918ms | 614–686ms | Missed target; ~25–35% faster than P3-2 |
| Create/delete/rename | ≤800ms | 976–1,178ms | 848–986ms | Missed target; ~9–23% faster |
| Hub surface-unchanged | ≤1.0s | 6,901–7,564ms | **571ms** | **Met**, by a wide margin (>90% faster) |
| Hub surface-changed | proportional to true dependents | 7,904–8,068ms (same cost regardless of variant — no narrowing existed) | 1,236ms, 841 owners genuinely re-diffed | **Met** — cost now tracks real semantic scope, not a constant |

## 6. Roots / correctness re-verification (all items applied)

- `n8n_incremental_create_delete_roots_match_oracle`: re-run after every
  fix in this document — **still passes**
  (`n8n-scale root equality CONFIRMED for create+delete against a
  from-scratch oracle`, `records`/`dependency`/`graph` all match exactly).
- `incremental_edit_produces_a_self_consistent_incremental_merkle_update`,
  `mixed_burst_edit_plus_create_delete_splits_into_two_generations_and_
  stays_self_consistent`, and every fixture-scale create/delete/rename
  root-equality test — all still pass ("incremental == from-scratch over
  the same final key set", decision 11's own gate language).
- The two new digest-churn regression tests (§1.4) and the new
  closure-narrowing test (§2) all pass.

## 7. Hard rule: the shared n8n corpus was never mutated

`.urdira-shared-corpus-readonly` marker confirmed present at the corpus
root before this session's first mutation. Every n8n-scale test in this
session routes through the pre-existing `scratch_copy_of_n8n_corpus`
helper (P3-2's own fix), never touching the corpus directly.
Verification, run at the end of this session (after every measurement/
oracle run above):

```
diff -rq --exclude=.git --exclude=node_modules \
  ~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02 \
  ~/Proyectos/n8n \
  | grep -v docs/architecture | grep -v readonly
```

→ empty output.

## 8. Quality gates

- `cargo fmt --all` — applied; `cargo fmt --all -- --check` clean
  afterward. Confirmed (via file mtimes) that formatting touched ONLY this
  session's own files (`tests_e2e.rs`, `analyze.rs`, `delta.rs`,
  `urdira-jsts-syntax-worker/src/lib.rs`, `urdira-structural-store/src/
  {writer,reader}.rs`) — every other file already modified by concurrent,
  uncommitted work elsewhere in the repo was already fmt-clean and
  untouched.
- `cargo clippy -p urdira-jsts-syntax-worker -p urdira-indexing-worker -p urdira-structural-store -p urdira-jsts-typeflow -p urdira-native-core -p urdira-source-frontier --all-targets -- -D warnings` — clean.
- `cargo test` — `urdira-jsts-syntax-worker` 151/151, `urdira-structural-store` all integration suites (compaction/merkle/delta/concurrency/recovery/roundtrip/write-base-determinism) pass, `urdira-native-core` 38/38, `urdira-source-frontier` 33/33, `urdira-jsts-typeflow` 5/5, `urdira-indexing-worker` 65/65 (non-n8n) + both n8n-scale tests (`n8n_incremental_measurement`, `n8n_incremental_create_delete_roots_match_oracle`) pass `--ignored`.
- `npx vitest run tests/v4-scan.test.ts tests/v4-daemon-e2e.test.ts tests/native-query-snapshot-port.test.ts tests/codebase-fixtures.test.ts` — 4 files, 20 passed, 1 skipped, 0 failed.
- Full-repository `pnpm verify` NOT run: same rationale as P3-1/P3-2's own evidence docs (extensive concurrent uncommitted work from other in-flight sessions across unrelated packages/crates, including a sibling agent actively running daemon/n8n tests during this session — waited out via idle polling, never raced). Every gate above is scoped to exactly the crates this task touched.

## 9. Files touched

- `crates/urdira-indexing-worker/src/v4/delta.rs` — `old_owner_ordinal` fix (item 1).
- `crates/urdira-indexing-worker/src/v4/analyze.rs` — `exported_surface`/`ExportedSurfaceEntry`, closure-narrowing logic in `run_scoped` (item 2).
- `crates/urdira-indexing-worker/src/v4/tests_e2e.rs` — 3 new tests (§1.4, §2).
- `crates/urdira-jsts-syntax-worker/src/lib.rs` — `analyze()`'s `prior` clone → borrow (item 3).
- `crates/urdira-structural-store/src/writer.rs` — sub-timers + empty-file skip for `closures.records`/`closures.deps`/`dict.bin`/`subjects.keys` (item 4).
- `crates/urdira-structural-store/src/reader.rs` — `load_dict_file`/`load_subjects_file` absent-file tolerance (item 4, additive, mirrors existing `load_closures`).

## 10. Residuals / honest summary

1. **Item 3 (parse_ms) only partially closed**: the double full-corpus
   clone in `SyntaxWorkerState::analyze` is fixed (§3.1, ~40% parse_ms
   reduction for edits); `reresolve_file`'s O(corpus) sweep for pure
   create/delete/rename is NOT fixed (§3.2) — judged too risky to narrow
   safely (a real, tested "extension-priority shadowing" case exists)
   within this session's remaining time. Create/delete/rename land at
   848–986ms, above the ≤800ms target.
2. **Item 4 (write_ms) only partially closed**: the empty-file skip for
   `closures.*`/`dict.bin`/`subjects.keys` is real and measured (§4.3);
   the MANDATORY per-segment file set (`records.*`, `adj.*`, `deps.*` —
   14 files, unconditionally mmapped by every query) still pays one
   `F_FULLFSYNC` each on macOS, which this session did not attempt to
   restructure (would touch the hot read path, out of proportion to this
   task's remaining time).
3. **Dependency owner-granularity diffing** (pre-existing, `delta.rs`'s
   own documented scope narrowing) still makes `opened_deps`/
   `deps_closures` churn at full owner-count scale even when item 1+2's
   fixes eliminate the equivalent record churn — a hub edit still shows
   2,657 opened/closed deps for 841 owners. Not this task's scope (item 1
   was specifically about `record_id`/records, not dependency edges), but
   flagged since it is now the single largest remaining "churn" number in
   the tables above.
4. Edit steady-state (614–686ms) misses the ≤500ms target (stretch 400ms)
   despite real, measured improvement — the residual cost is spread across
   `parse_ms` (§3.2's untouched O(corpus) paths, though these specifically
   affect create/delete/rename more than steady edits) and `write_ms`'s
   remaining fixed `fsync`/`segment_files` floor (§4's residual #2).
