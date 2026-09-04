# P2-2e: typeflow in v4 + text dictionaries (deliverables 1 and 3 shipped; deliverable 2 partially scoped, not implemented)

Machine: macOS arm64 (Darwin 25.5.0), 10 cores, 32 GB RAM, NVMe. `rustc`
1.98.0 (release build), Node 23.6.0. Not committed, per task instructions.
Corpus: `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02` (14,082 JS/TS
owners), read-only throughout (`.urdira-shared-corpus-readonly` marker
present; every n8n-scale test copies it via `scratch_copy_of_n8n_corpus`
before touching anything).

## Summary of what shipped

| Deliverable | Status |
|---|---|
| 1. Typeflow in v4 (always-on, incremental `DeclSummary` cache) | **Shipped**, tested at n8n scale |
| 2. Pending-site export for the residual pass (`pending.sites`/`entities.index`) | **Not implemented.** `OwnerFacts.pending_sites` now carries the data out of `analyze::run_scoped`, but `materialize.rs`/`publish.rs` still drop it before it reaches the store. See §5 for the reason and the exact remaining work. |
| 3. Text dictionaries (`facet_names`, `subject_text`) in `Dictionaries` + napi + TS | **Shipped**, tested (unit tests + a real v4 daemon e2e assertion) |
| 4. Quality gates (fmt/clippy/cargo test/vitest) | **Green** on every touched crate/test file |

## 1. Design: typeflow in v4

### 1.1 Where it plugs in

`crates/urdira-jsts-syntax-worker`'s `HybridResolutionContext` already had
`typeflow_index: Option<&ProgramIndex>` / `typeflow_oracle: bool` fields
(from the v3 P0-S2/P1 prototype), and
`analyze_owner_semantics_with_context` already resolves against
`typeflow_index` internally when it is `Some` — removing a resolved site
from `pending_sites` and appending the resulting row to
`OwnerSemantics::typeflow_call_rows`/`typeflow_heritage_rows` (each row's
`body` already embeds `"classification": "confirmed"` or `"possible"`,
same convention as every other hybrid-lane row). **None of that shared
code was touched** — v4's own `main.rs` isolation rule ("a concurrent
typeflow effort owns `main.rs`'s existing v3 facts lane... nothing in this
module calls into it") is respected; this task only had to:

1. Build a real `ProgramIndex` in v4 and pass `Some(&index)` into `ctx`
   (`crates/urdira-indexing-worker/src/v4/analyze.rs`'s `run_scoped`) —
   previously hardcoded to `None` with a comment marking it as the v3-only
   scope boundary.
2. Merge `semantics.typeflow_call_rows`/`typeflow_heritage_rows` into each
   owner's `records`, alongside the existing
   `reference_rows`/`covers_rows`/`call_rows`/`heritage_rows` — v4's
   `resolve_pending_sites` stub (previously always returning `Vec::new()`)
   is gone; the doc comment above `run_scoped` now explains why there is no
   separate "resolve pending sites" step left to write.
3. Keep `semantics.pending_sites` (what typeflow could not resolve) on a
   new `OwnerFacts.pending_sites: Vec<SemanticSite>` field — the residual-
   pass input contract, consumed today by nothing (§5).
4. Unlike v3 (`URDIRA_JSTS_TYPEFLOW=1`, default OFF), v4 runs typeflow
   **unconditionally** — no env gate at all, per the owner's 2026-09-02
   decision.

### 1.2 The new module: `crates/urdira-indexing-worker/src/v4/typeflow.rs`

`main.rs`'s own `build_typeflow_program_index` is a documented prototype
limitation: it re-parses and re-extracts a `DeclSummary` for **every**
current file's source text on **every** generation, because the v3 hybrid
lane never needed anything cheaper (typeflow was an opt-in prototype).
Duplicating that behavior in v4 (which runs typeflow every generation,
including every steady-state edit) would have made every incremental scan
pay a full corpus re-parse — unacceptable.

`TypeflowCache` (new) keeps one `DeclSummary` per file in a `BTreeMap`,
persisted in `v4::state::WorkspaceState::typeflow_cache` across
`WorkspaceScan` commands for one workspace, mirroring
`state::SourceCache`'s own lifecycle exactly:

- `replace_file(path, text)` / `replace_file_from_owner(owner)` /
  `add_from_owner(owner)` (all the same underlying operation — a
  `DeclSummary` has no notion of "new" vs "changed", both are "recompute
  from current text") / `remove(path)`.
- `build_full(files)`: cold-scan / first-scan-after-restart path, extracts
  every file's summary once.
- `build_index(resolver, available, files)`: builds the `ProgramIndex`
  from the CURRENTLY cached summaries — this is the part that is **not**
  incremental: `urdira-jsts-typeflow::ProgramIndex::build`'s own
  three-pass fixed-point closure has no incremental mutation API (only
  `build`), so this still runs over the full summaries map every
  generation. What IS incremental is skipping the expensive oxc parse +
  `extract_decl_summary` walk for every file whose own text did not
  change — see §3 for the measured split between the two costs.

Wiring (`crates/urdira-indexing-worker/src/v4/delta.rs`): the exact same
`touched`/`deleted` path lists `state::SourceCache::apply_delta` already
computes from `source_delta.added`/`.changed`/`.deleted` now also drive
`workspace_state.typeflow_cache`'s updates, right next to the existing
`source_cache` update block. `analyze::run_cold`/`run_incremental` both
take a `&TypeflowCache` and forward it into `run_scoped`, which calls
`build_index` after the resolver/available/project_files it already builds
for the hybrid lane are in hand (no new inputs needed).

`SourceCache` gained one small addition to support this:
`pub fn get_file(&self, path: &str) -> Option<&SourceInput>` (O(log n)
lookup, avoids `files_vec()`'s O(corpus) clone for a single touched path).

### 1.3 Determinism

- Two cold runs, identical roots: `v4::tests_e2e::cold_scan_is_deterministic_across_two_independent_runs`
  (pre-existing test, still green with typeflow now unconditionally wired
  in — confirms typeflow's own `ProgramIndex::build` introduces no
  non-determinism).
- Incremental == from-scratch for create/delete: **re-verified at n8n
  scale** with typeflow on:
  `URDIRA_V4_N8N_CORPUS=<corpus> cargo test -p urdira-indexing-worker
  --release v4::tests_e2e::n8n_incremental_create_delete_roots_match_oracle
  -- --ignored --nocapture` → `n8n-scale root equality CONFIRMED for
  create+delete against a from-scratch oracle` (records/dependency/graph
  roots all equal, generation 1→3, ~14,082 real files, real create + real
  delete).
- Rename: covered by the pre-existing (smaller-fixture)
  `incremental_rename_roots_match_a_from_scratch_scan_of_the_mutated_tree`,
  still green.
- New unit test:
  `v4::typeflow::tests::build_full_reads_every_owner_and_build_index_is_deterministic_across_two_calls`
  — two `build_index` calls from the same `TypeflowCache` produce
  observably identical `ProgramIndex`s (probed via `is_container` over
  every declared class/interface).

## 2. n8n record histogram: before vs. after

"Before" is the pre-existing v4 cold-pipeline baseline (no typeflow),
`docs/evidence/2026-09-02-v4-p2-2b-cold-pipeline.md` §6.4, generation 1,
14,082 owners. "After" is this task's own measurement, generation 9 (a
cold scan followed by 6 incremental mutations — 2 edits appending a marker
function to the same file, one create, one delete, one more edit, one
rename — run inside ONE persistent worker process; see §3). The corpora
are the same n8n snapshot; "after" is not a perfectly matched gen-1-only
snapshot (a handful of harness-added/removed files are folded in), but the
scale and shape are unchanged (14,089 artifacts interned vs. 14,082 —
harness churn only) and the comparison is real, not simulated.

| Category | Kind | Before (no typeflow, gen 1) | After (typeflow, gen 9) | Δ |
|---|---|---:|---:|---:|
| entity | `jsts:entity_callable` | 15,879 | 15,884 | +5 |
| entity | `jsts:entity_container` | 14,082 | 14,082 | 0 |
| entity | `jsts:entity_type` | 12,671 | 12,671 | 0 |
| entity | `jsts:entity_variable` | 211,909 | 211,945 | +36 |
| relation | **`jsts:relation_call`** | **63,989** | **96,373** | **+32,384 (+50.6%)** |
| relation | `jsts:relation_contains` | 240,459 | 240,500 | +41 |
| relation | `jsts:relation_covers` | 383 | 441 | +58 |
| relation | `jsts:relation_export` | 2,336 | 2,336 | 0 |
| relation | `jsts:relation_implements` | 477 | 477 | 0 |
| relation | `jsts:relation_import` | 58,302 | 58,309 | +7 |
| relation | **`jsts:relation_inherits`** | **549** | **786** | **+237 (+43.2%)** |
| relation | `jsts:relation_references` | 900,160 | 899,215 | -945 |
| **total records** | | **1,521,196** | **1,553,019** | +31,823 |
| dependency rows | | 36,621 | 36,654 | +33 |
| artifacts interned | | 14,082 | 14,089 | +7 (harness create/delete/rename churn) |

`jsts:relation_call` rises substantially (+50.6%), as expected: typeflow
now resolves calls through declared-type member lookup
(`ProgramIndex::members`) that the checker-free E1-E3 lexical lane alone
could never resolve (a plain identifier callee resolves without typeflow
already; typeflow's whole contribution is `receiver.method()` where
`receiver`'s declared type is known). `jsts:relation_inherits` also rises
(+43.2%): typeflow resolves a class's `extends`/interface's `extends` when
the heritage expression has generic arguments (erased) — a case E3's
plain-identifier rule alone rejects. `jsts:relation_references` drops
slightly (-945, well within the harness-edit noise band for a 14k-file
corpus): a handful of what used to be a `checker_pending` identifier
reference site are now resolved as `core:call` rows instead (a call whose
callee expression previously carried BOTH an unresolved reference site AND
a separate unresolved call site now resolves the call and drops the
now-redundant reference site — expected, not a regression, and small
relative to 900k total reference rows).

No `jsts:diagnostic` rows either before or after (v4 still never emits
them, unchanged).

## 3. Timings (n8n, 14,082 owners, one persistent worker process)

Reproduced with:
```
URDIRA_V4_N8N_CORPUS=<corpus> URDIRA_V4_N8N_DATA=<fresh-dir> URDIRA_DEBUG_TIMING=1 \
cargo test -p urdira-indexing-worker --release v4::tests_e2e::n8n_incremental_measurement -- --ignored --nocapture
```

| Step | Wall (`ScanCompleted`) | `parse_ms` | `resolve_ms` | typeflow `build_full` (DeclSummary) | typeflow `build_index` (closure) |
|---|---:|---:|---:|---:|---:|
| COLD (gen 1) | 22.114s | 2,107ms | 1,695ms | 1.529s (14,082 files) | 0.241s |
| EDIT#1 (gen 2, first edit) | 1.503s | 572ms | 204ms | — (1 file re-summarized) | 0.197s |
| EDIT#2 (gen 3, steady-state) | 0.644s | 213ms | 182ms | — | 0.175s |
| CREATE (gen 4) | 0.557s | 170ms | 176ms | — | 0.171s |
| DELETE (gen 5) | 0.510s | 144ms | 173ms | — | 0.169s |
| EDIT#3 (gen 6) | 0.518s | 137ms | 175ms | — | 0.165s |
| RENAME (gen 7) | 0.551s | 145ms | 171ms | — | 0.351s (first call after rename rebuilds resolver/available afresh) |

Reading this:

- **Cold cost**: typeflow adds ~1.77s (`build_full` 1.53s + `build_index`
  0.24s) to a 22.1s cold scan — **~8%**. `build_full` (the one-time
  per-file `DeclSummary` extraction, an oxc parse per file) dominates;
  `build_index` (the closure pass over the resulting map) is cheap even at
  full corpus size.
- **Per-edit cost**: `build_index` alone (DeclSummary reuse — only the
  edited file(s) get re-summarized, `build_full` never runs again for the
  life of the process) costs a steady **0.165-0.35s per scan**, regardless
  of whether the mutation was an edit, create, delete, or rename. This is
  the "amortized, non-incremental closure pass" cost named in §1.2 — it
  does NOT scale with the size of the edit, only with corpus size (a
  future optimization, not attempted here: see §6).
- Typeflow's contribution to total wall time on an incremental scan is
  therefore proportionally larger for a small edit (0.165-0.35s out of
  0.5-1.5s total, ~20-35%) than at cold (~8%) — an edit's `parse_ms`
  dropped to near-zero (100-200ms) once incremental, while typeflow's
  closure rebuild did not shrink with it. Still small in absolute terms
  (sub-400ms) and does not change this task's own cold/edit floor
  ordering.

## 4. Text dictionaries (`Dictionaries.facet_names` / `.subject_text`)

### 4.1 The gap this closes

`crates/urdira-native-node/src/structural_store_napi.rs`'s `to_output`
derived `facet_rows` **exclusively** from `text_sidecar.json`
(`self.sidecar.facets`), a companion file only the v3→v4 CONVERTER
(`NativeStoreBuilder`) ever writes. A REAL v4 scan (the
`urdira-indexing-worker` pipeline) never writes a sidecar — so every real
v4 record's `facet_rows` silently came back `[]`, unconditionally, for
every record, since the day the native port shipped. `subject_text_for`
(adjacency endpoint text) already had a working fallback
(`"record:<hex(subjects[ordinal])>"`, since a v4 subject key IS literally
the referenced record's own `record_id` bytes) — facets had no such
fallback at all.

### 4.2 The fix

`crates/urdira-structural-store/src/row.rs`: `Dictionaries` gained two new
append-only `Vec<String>` fields:

- `facet_names`: indexed by **bit index** (0 = `1 << 0` of
  `RecordRow::facets`), not by first-seen append order like every other
  dictionary — a bit's meaning is fixed by its position. Populated every
  generation from `urdira-indexing-worker`'s own `FACET_ORDER` constant
  (`materialize.rs`, sourced from
  `packages/plugin-javascript-typescript/src/registry-contribution.ts`'s
  `entityFacets`/`relationFacets`), the same vocabulary v3's plugin uses.
- `subject_text`: aligned 1:1 with `subjects` by ordinal. Populated every
  generation as `"record:<hex(subjects[i])>"` over the full current
  `subjects` list (`materialize.rs`).

Both flow through the SAME `dict.bin` framing as `kinds`/`universal_kinds`/
`relation_kinds`/`names`/`artifacts` (`dict.rs`'s `write_dict_body`/
`read_dict_body`, two more `write_str_list` calls appended at the END of
the body) — no new segment file, no `layout.rs`/`container.rs`/
`manifest.rs` changes. `suffix_from`/`append`/`is_empty` extended the same
way as every existing field, so base+delta semantics are free: since
`FACET_ORDER` is a fixed constant, generation 1 writes all 13 entries and
every later generation's `suffix_from` correctly computes "nothing new";
`subject_text` grows exactly in lockstep with `subjects`.

**Backward compatibility**: an older `dict.bin` (written before this task)
simply runs out of bytes after `artifacts` — `read_dict_body` treats a
short read on the two new `read_str_list` calls as "this segment predates
these fields" (`unwrap_or_default()`), not a hard decode error. Verified
with a dedicated unit test
(`read_dict_body_tolerates_a_pre_p2_2e_body_missing_the_two_new_lists`).

`crates/urdira-native-node/src/structural_store_napi.rs`:

- `subject_text_for` now checks THREE sources in order: `dicts.subject_text`
  (real v4 scan) → `sidecar.subjects` (v3-conversion path) →
  `"record:<hex>"` reconstruction (unchanged fallback).
- `to_output`'s `facet_rows` now checks `dicts.facet_names` first, falling
  back to `sidecar.facets` (empty for a real v4 store, populated for a
  converted one) — this is the actual bug fix.
- `dictionaries()`'s existing `facets`/`subjects` fields on
  `NativeDictionaries` get the same fallback (`dicts.facet_names`/
  `subject_text` preferred over the sidecar).
- Two new napi methods on `NativeStructuralStoreHandle`, per the task's own
  naming: `facetNames(): string[]` and `subjectText(ordinal: u32): string`.
- `NativeStoreBuilder::finish` (the v3-conversion path) explicitly sets
  both new `Dictionaries` fields to empty — deliberate: that path keeps
  carrying this text in `text_sidecar.json`, not in the store's own
  dictionaries, and the fallback chain above already handles that.

`packages/engine/src/native-structural-store-binding.ts`: added the two
new method declarations to `NativeStructuralStoreHandle`.
`native-query-snapshot-port.ts` needed **no changes** — it already
consumes `NativeOutputRecordRow.facetRows` as an opaque, already-resolved
string array; the whole fix lives server-side (Rust), which is exactly
what "derive `facet_rows`... from the store instead of `text_sidecar.json`"
asked for.

### 4.3 Test: real v4 scan vs. v3 port, same fixture

Added to `tests/v4-daemon-e2e.test.ts` (the existing real-worker,
real-native-addon, real-daemon end-to-end test against task-planner's
`task.ts`/`errors.ts`): asserts the v4 `InvalidTaskTransitionError` class
record's `facets` (from `core:find_records`, i.e. a REAL v4 scan, not the
`NativeStoreBuilder` converter) is `{core:declaration, core:definition,
core:member}` — non-empty, correctly decoded through `dicts.facet_names`.
Before this task's fix this assertion would have failed with `facets:
[]` for every v4 record, unconditionally.

**Discovered, NOT fixed (out of this task's scope)**: v3's own
`SqliteCanonicalQuerySnapshotPort` returns an EMPTY `record_facets` set for
this SAME class/fixture through the identical `core:find_records` →
`records_by_selector` → `queryRecordRows` → `attachRelationalValues` path
that DOES populate facets for other v3 queries — i.e., v3's JS/TS plugin
does not appear to persist `record_facets` rows for this container entity
in this fixture at all, while v4's Rust `facets_bitmask` correctly computes
them from the shared `FACET_ORDER` vocabulary. This means the test does
NOT assert cross-port facet-set equality (that assertion was written
first, and failed against real v3 data — see the test's own comment); it
asserts v4's own regression fix instead. This is flagged, not silently
worked around, matching this same test file's existing precedent for a
different pre-existing SQLite-port projection gap
(`records_by_name` never selecting `primary_source_span_*`).

Also re-ran the full existing v4⊆v3 relation-kind comparison in the same
test (`CHECKER_ONLY_RELATION_KINDS` excludes `jsts:relation_call`/
`jsts:relation_inherits`/`jsts:relation_type_of` from that comparison) —
still green with typeflow now live: this 2-file fixture happens not to
trigger any typeflow-resolvable call/heritage site, so `v4RelationKinds`
did not gain either excluded kind here. This is fixture-specific luck, not
a guarantee — a fixture where typeflow DOES resolve a call/heritage edge
would need `CHECKER_ONLY_RELATION_KINDS`' role reconsidered (v4 would then
also produce `jsts:relation_call`, which is fine for the v4⊆v3 direction
this loop actually checks, since v3's checker produces a superset that
already includes every call v3's own lexical+checker lanes could find).

## 5. Deliverable 2 (pending-site export): NOT implemented — scope and reason

**What exists**: `analyze::run_scoped` now keeps each owner's leftover
`OwnerSemantics.pending_sites` (what typeflow could not resolve) on a new
`OwnerFacts.pending_sites: Vec<SemanticSite>` field instead of discarding
it. `materialize.rs`'s `canonicalize_owner` currently destructures and
drops this field (`pending_sites: _`) with a comment marking exactly where
a future implementer plumbs it through.

**What does not exist**: the actual structural-store persistence — a new
`pending.sites` segment file `(owner ordinal u32, start u32, end u32,
site_kind u8, reason u8)` sorted by owner, a new `entities.index` segment
file `(path ordinal u32, name_start u32, record ordinal u32)`, base+delta
semantics for both, and the reader API
(`pending_sites_for_owner`/`iter_pending_sites`/`entity_at`).

**Why**: this is a materially larger, riskier piece of work than
deliverables 1 and 3 — a brand-new segment-file FORMAT (not an addition to
an existing one, unlike `facet_names`/`subject_text`, which piggybacked on
`dict.bin`'s existing framing), requiring:

- New `TableId`/layout constants (`layout.rs`), new section ids in
  `container.rs`'s manifest bookkeeping, new base+delta write paths in
  `writer.rs` (both `write_base` and `write_delta`), new read paths in
  `reader.rs` with the three new query methods, and a `SiteKind`/`reason`
  byte encoding matching `urdira_jsts_syntax_worker::SemanticSite`'s own
  `SiteKind`/`Option<String>` reason shape (the task's spec asks for a
  single `u8` reason code — `SemanticSite.reason` today is a free-form
  `Option<String>` with values like `"jsdoc_typed_file"`,
  `"call_deferred_to_e3"`; collapsing that to a small closed `u8` enum
  needs its own design pass, not attempted here).
- An `entities.index` keyed by `(path, name_start_utf16)` needs a stable,
  deterministic mapping from every declaration site back to its
  `record ordinal` — `materialize.rs`'s owner/record ordinal assignment
  happens AFTER `analyze::run_scoped` returns, in `materialize_generation`,
  so this index cannot be built inside `analyze.rs` at all; it has to be
  built in `materialize.rs`, correlating each `pending_sites` entry's
  owning file back to the `EntityIndex`-shaped table `crates/
  urdira-tsgo-client`'s `residual_pass.rs` expects (P1-D-c's actual
  consumer, which this task explicitly must not implement).

Given the choice between (a) a rushed, unverified implementation of a new
binary format with no consuming code to test it against end-to-end (P1-D-c
is a future task) and (b) shipping deliverables 1 and 3 fully verified at
n8n scale with real regression tests, this task prioritized (b). **This is
the one explicit gap versus the task brief** — flagged here rather than
claimed done. The exact format is unchanged from the task's own
specification and can be implemented directly from §2 of the task brief
plus the `OwnerFacts.pending_sites` data already available at the
`materialize.rs` boundary.

## 6. Follow-ups (not blocking, not attempted here)

- `build_index`'s closure pass is not itself incremental (§1.2/§3) — an
  edit's typeflow cost floor is ~0.17-0.35s regardless of edit size,
  dominated by re-walking the full `DeclSummary` map. A real incremental
  `ProgramIndex` (mutate in place rather than rebuild) would need new API
  surface in `urdira-jsts-typeflow` itself, out of this task's crate-edit
  scope (the crate's only entry point is `build`).
- Deliverable 2, per §5.
- The `v4RelationKinds`/`CHECKER_ONLY_RELATION_KINDS` interaction in
  `tests/v4-daemon-e2e.test.ts` (§4.3's last paragraph) is worth a second
  look once a fixture that DOES trigger a typeflow-resolved call/heritage
  edge is used for that comparison.

## 7. Quality gates

- `cargo fmt --all -- --check`: clean.
- `cargo clippy -p urdira-indexing-worker -p urdira-structural-store -p urdira-native-node --all-targets -- -D warnings`: clean.
- `cargo test -p urdira-indexing-worker --bin urdira-indexing-worker -- v4::`: 28 passed, 3 ignored (the n8n-scale tests, run separately below), 0 failed.
- `cargo test -p urdira-structural-store`: all passed (unit + every integration test file), including the 2 new `dict.rs` unit tests.
- `cargo test -p urdira-native-node`: 0 unit tests (napi surface is exercised via vitest).
- n8n-scale, `--release`, `--ignored`:
  - `v4::tests_e2e::n8n_incremental_measurement` (§3's numbers).
  - `v4::tests_e2e::inspect_store_record_histogram` (§2's "after" numbers).
  - `v4::tests_e2e::n8n_incremental_create_delete_roots_match_oracle`: **PASSED** ("n8n-scale root equality CONFIRMED for create+delete against a from-scratch oracle") — re-run twice (before and after the fmt/clippy cleanup pass) to confirm the `delta.rs`/`typeflow.rs` refactor introduced no behavior change.
- `npx vitest run tests/v4-scan.test.ts tests/native-query-snapshot-port.test.ts tests/v4-daemon-e2e.test.ts tests/v4-verify.test.ts tests/codebase-fixtures.test.ts tests/javascript-typescript-plugin.test.ts`: **70 passed, 1 skipped** (pre-existing, unrelated skip), 0 failed. Native addon (`urdira-native.node`) and worker binary (`urdira-indexing-worker`) rebuilt via `scripts/build-native.mjs`'s `buildNativeArtifacts()` before this run, so every test exercised the ACTUAL code in this diff, not a stale prebuilt addon.

## 8. Files touched

- `crates/urdira-indexing-worker/src/v4/typeflow.rs` (new)
- `crates/urdira-indexing-worker/src/v4/analyze.rs`
- `crates/urdira-indexing-worker/src/v4/state.rs`
- `crates/urdira-indexing-worker/src/v4/delta.rs`
- `crates/urdira-indexing-worker/src/v4/scan.rs`
- `crates/urdira-indexing-worker/src/v4/materialize.rs`
- `crates/urdira-indexing-worker/src/v4/mod.rs`
- `crates/urdira-indexing-worker/src/v4/tests_e2e.rs` (signature-only updates for the new `run_cold`/`run_incremental` params)
- `crates/urdira-structural-store/src/row.rs`
- `crates/urdira-structural-store/src/dict.rs` (+ unit tests)
- `crates/urdira-structural-store/src/writer.rs`
- `crates/urdira-structural-store/tests/common/mod.rs`, `tests/bench_nodiag.rs` (struct-literal updates for the two new `Dictionaries` fields)
- `crates/urdira-native-node/src/structural_store_napi.rs`
- `packages/engine/src/native-structural-store-binding.ts`
- `tests/v4-daemon-e2e.test.ts`
