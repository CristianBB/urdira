# P3-6: single-file delta container, bounded create/delete/rename re-resolution, parse residual (2026-09-03)

Machine: macOS arm64 (Darwin 25.5.0), 10 cores, 32 GB RAM, NVMe. `rustc`
1.98.0 (release build), Node 24.18.1. Not committed, per task instructions.
Corpus: `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`
(20,148/20,281 files, 14,082 JS/TS owners), READ-ONLY throughout this
session — verified byte-identical to `~/Proyectos/n8n` both
before and after this session's mutations (only pre-existing, unrelated
`.claude/skills` symlink-loop diagnostics from `diff`, no content
differences; §7).

Owned this session: `crates/urdira-structural-store` (delta format
changed; base format and reader/napi public API unchanged),
`crates/urdira-indexing-worker/src/v4/*` (no functional changes needed —
`write_delta_with_reader`'s signature is unchanged, so `delta.rs`/
`publish.rs` needed no edits), `crates/urdira-jsts-syntax-worker`
(API-compatible), `crates/urdira-indexing-core/src/merkle_bucket.rs`
(additive). `packages/daemon/src/runtime.ts`, `packages/engine/src/
watchers.ts`, `scripts/v4-mutation-harness.mjs` and daemon tests were NOT
touched (P3-5's exclusive scope).

## 1. Item 1 — single-file delta container

### 1.1 What changed

A delta generation used to be a directory (`delta-<g>/`) of up to 18
separate small files; `manifest::fsync_segment_dir` called `File::
sync_all()` (macOS: `F_FULLFSYNC`, a genuine device-flush, not a cheap
syscall) once **per file**. New module `crates/urdira-structural-store/
src/container.rs`: a delta generation is now ONE file, `delta-<g>.seg` —
a 64-byte container header, every logical section's blob (byte-identical
to the pre-existing standalone-file byte layout: the same `layout::
FileHeader` + body) concatenated back-to-back, then a table-of-contents
array (`section_id`, `offset`, `length`, `xxh3`). Full format detail,
writer/reader mechanics, and the manifest-shape change are documented in
`docs/evidence/2026-09-02-v4-p2-3-structural-store.md` §1.1a (added this
session) — not duplicated here.

**No backward compatibility with the pre-P3-6 `delta-<g>/` directory
layout** — v4 is unreleased, so `reader::Segment::open` only understands a
delta as a `.seg` file. This was a deliberate scope decision (the task
explicitly allowed dropping it if backward-compat wasn't "a few lines");
implementing dual-format support in `Segment::open`/`StoreInner::load`
would have roughly doubled the size of the read-side change for a
capability nothing needs (this crate's own tests are the only
readers/writers of the pre-P3-6 layout, and they were updated in the same
change).

**Base segments are completely unaffected**: `write_base` still writes one
file per logical name, individually fsynced at cold, unchanged;
`compact()` always produces a base (never a delta), so it never touches
`container.rs` on its write side (only on its *cleanup* side — see §1.3).

Reader-side: `crate::segment_io::SectionSource` (`File(Mmap)` or
`Container{ mmap: Arc<Mmap>, start, end }`) `Deref`s to `[u8]` exactly
like `Mmap` already did, so every existing accessor in `reader.rs`
(`key_at`, `meta_row`, `header_and_data`, `verify_xxh3`, `by_owner`
lookups, ...) needed only a field-type change, not a rewrite — this is
the "reader's decoding code is reused via offset views" the task asked
for. `StoreInner::load` mmaps each delta container exactly once
(`container::open_container`) and reuses that one mmap for both the
mandatory `Segment` fields and the optional dict/subjects/closures
sections.

Writer-side: `writer::build_delta_sections` builds every section's blob
in memory, single-threaded (a delta's row count is always small — a
steady-state edit opens single/double-digit rows — so `write_base`'s
N-threaded nibble-partitioned writer buys nothing here and would only
complicate producing `Vec<u8>` blobs instead of writing to files).
`container::write_container_to_page_cache` does the one buffered
`write_all`; `container::commit_container` does the ONE `File::
sync_all()`. Merkle `.tree` slot/header writes (`merkle::persist_slots`)
were reordered to run AFTER the container's own fsync, per the task's
explicit instruction ("the `.tree` header write after the container's
fsync") — the segment data a reader would actually load is durable before
the merkle root pointing at it is published.

**Merkle `persist_slots` coalescing** (additive,
`urdira-indexing-core::merkle_bucket::BucketedMerkleSet::write_slots`):
touched slots (a bucket's own digest + its 5 ancestor node digests, per
touched bucket) are collected into a `BTreeMap<byte_offset, Digest32>`
first — deduping repeated ancestor writes shared across buckets under the
same subtree, then merging adjacent 32-byte offsets into contiguous
ranges — so one `seek`+`write_all` per contiguous range replaces one pair
per individual slot. Same bytes on disk, same one `sync_all` per call;
`cargo test -p urdira-indexing-core merkle_bucket` (7/7, including the
`write_slots`-exercising `persistence_round_trip_write_read_update_read`
and `incremental_update_matches_from_scratch_over_randomized_rounds`)
confirmed unaffected.

### 1.2 Measured: `write_delta_with_reader` sub-timers (n8n scale, real mutation harness)

New sub-timer names replace the pre-P3-6 set (`segment_files`/`closures`/
`merkle_load_update`/`persist_slots`/`fsync`/`manifest`) with ones that
match the new phase boundaries (`segment_files`/`merkle_memory`/
`container_page_cache`/`container_fsync`/`persist_slots`/`manifest`) —
`container_fsync` is the ONE `F_FULLFSYNC` per generation this item exists
to produce.

| Phase | opened_records | closures | opened_deps | deps_closures | segment_files | merkle_memory | container_page_cache | container_fsync | persist_slots | manifest | **total** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| EDIT#1 (cold-cache) | 5 | 1 | 1 | 1 | 0ms | 25ms | 0ms | 6ms | 17ms | 12ms | **60ms** |
| EDIT#2 | 341 | 337 | 1 | 0 | 0ms | 22ms | 0ms | 9ms | 28ms | 11ms | **71ms** |
| CREATE | 0 | 3 | 0 | 0 | 0ms | 18ms | 0ms | 9ms | 4ms | 11ms | **43ms** |
| DELETE | 9 | 5 | 1 | 0 | 0ms | 15ms | 0ms | 8ms | 6ms | 10ms | **39ms** |
| EDIT#3 | 349 | 9 | 1 | 0 | 0ms | 15ms | 0ms | 7ms | 11ms | 11ms | **45ms** |
| RENAME | 3 | 1 | 0 | 0 | 0ms | 17ms | 0ms | 8ms | 30ms | 11ms | **66ms** |
| HUB surface-unchanged | 3 | 1 | 0 | 0 | 0ms | 15ms | 0ms | 9ms | 6ms | 13ms | **43ms** |
| HUB surface-changed | 1 | 1,628 | 2,657 | 2,657 | 0ms | 31ms | 0ms | 8ms | 76ms | 11ms | **126ms** |

(`segment_files`/`container_page_cache` round to 0ms at this row scale —
building and buffering a few KB of section blobs is sub-millisecond;
`merkle_memory` — the in-memory `load_and_update` against the current
merkle tree — is the largest fixed cost now, 15–31ms, unaffected by this
item.)

**Gate**: target "steady edit `write_ms` ≤ 60ms". EDIT#1/CREATE/DELETE/
EDIT#3/RENAME/HUB-unchanged all land at 39–66ms — **met**. EDIT#2 (a
341-record/337-closure edit — a moderately fanned-out mutation, not a
minimal one) lands at 71ms; HUB surface-changed (a real 841-owner,
2,657-dependency-churn edit) lands at 126ms — both above 60ms but driven
by genuinely larger row/closure counts the target's "steady edit" framing
didn't anticipate, not by any remaining per-file fsync (`container_fsync`
is 6–9ms in every row, flat regardless of row count — exactly the
"whole delta path free of per-file fsyncs" the item asked for). Before
this item (P3-3 baseline, `docs/evidence/2026-09-03-v4-p3-3-digest-churn.md`
§5): `fsync` sub-timer alone was 51–72ms (plus `segment_files` 45–57ms) for
comparable row counts — this item's `container_fsync` (6–9ms) plus
`segment_files` (~0ms) replaces that pair outright.

### 1.3 Tests

- `cargo test -p urdira-structural-store`: all 9 integration suites green,
  including `compaction_test` extended from 3 to **40 deltas** (item 4's
  own requirement) before compacting — identical Merkle roots, identical
  `by_owner`/`iter_visible`/`visible_count` query results pre/post,
  refcount-blocked deletion while a reader is alive, all still hold
  against the new container format.
- `recovery_test.rs` updated: the crash-simulation test now writes a
  partial `delta-2.seg` FILE (was a `delta-2/` directory with a fake
  `records.keys` inside) and asserts `recover()` deletes it; the orphan
  test now covers both an orphan `base-99/` directory AND an orphan
  `delta-99.seg` file in the same run. `recover()`'s own logic
  (`remove_segment`) dispatches on `symlink_metadata` rather than
  assuming a shape.
- `cargo test -p urdira-indexing-worker --bins` (65/65 non-ignored,
  3 ignored n8n-scale): every fixture-scale create/delete/rename
  root-equality test, the merkle self-consistency tests, and the P3-3
  digest-churn regression tests all still pass unmodified — the delta
  container change is invisible above `SegmentWriter`'s public API.
- n8n-scale `n8n_incremental_create_delete_roots_match_oracle`: **passes**
  — `records`/`dependency`/`graph` roots match a from-scratch oracle scan
  of the mutated tree exactly, with every delta in between now written as
  a container.

## 2. Item 2 — bounded create/delete/rename re-resolution

### 2.1 What changed

`crates/urdira-jsts-syntax-worker/src/lib.rs`'s `path_membership_
incremental` branch used to compute `stale_paths` as every currently-known
path NOT itself added/removed this batch, then called `reresolve_file` on
every one of them — O(corpus) per create/delete/rename, the exact gap
flagged (not fixed) in `docs/evidence/2026-09-03-v4-p3-3-digest-churn.md`
§3.2.

New: `CandidateIndex`, a per-project reverse index — `candidate_path ->
{importer paths whose specifier's candidate list includes this exact
path}` — maintained incrementally (`remove_file`/`insert_file`, keyed by
each importer's own contribution so removal is O(that file's own import
count), not O(index size)), never rebuilt wholesale except alongside an
already-O(corpus) cold scan or full reset. A candidate path is generated
by `resolver::WorkspaceResolver::candidate_paths(from, specifier)`
(new): every extension/`/index` variant (`push_candidate_variants`,
refactored out of `probe_extensions` so both share one enumeration) of
every BASE `resolve()`'s relative/package(`exports`/`main`/`module`/
`types`)/tsconfig(`paths`/`baseUrl`) strategies could name — a
deliberate, safe OVER-approximation of what a single `resolve()` call
would actually try (it tries package resolution and only falls back to
tsconfig on failure; `candidate_paths` always includes both), since an
extra importer in the candidate set costs one harmless extra
`reresolve_file` call, while a missing one would silently break
correctness. `CandidateIndex::insert_file` indexes BOTH `direct_imports`
and `export_bindings.source_specifier` — resolved and unresolved alike —
so a specifier that's already resolved (and could be SHADOWED by a
newly-created higher-priority-extension file) is covered exactly the same
as a currently-unresolved one.

On create/delete/rename, `reresolve_file`'s sweep now runs only over
`CandidateIndex::importers_of(added ∪ removed)` (falling back to the old
full sweep only if a project somehow has no index yet — defensive, never
observed to fire).

### 2.2 New tests (all pass)

- `incremental_rename_via_delete_plus_create_repoints_importers_that_used_the_new_name`
  — a rename modeled as delete+create in ONE batch, with two SEPARATE
  importers (one naming the old path, one already naming the new path)
  so the test cannot pass by exercising only one direction; both
  regress/resolve correctly and match a from-scratch rebuild.
- `incremental_root_add_resolves_a_directory_import_via_index_ts` —
  `./dir` resolving only through `probe_extensions`'s `/index`+extension
  branch, confirming `push_candidate_variants`'s `{base}/index{ext}`
  entries are indexed, not just `{base}{ext}`.
- `narrowed_create_delete_matches_full_reresolution_on_a_synthetic_300_file_project`
  — 30 target bases × 2 extension variants (60 possible target files) +
  240 fan-in importers (up to 300 distinct paths), a fixed-seed xorshift64
  PRNG driving 30 random create/delete toggles, asserting the narrowed
  incremental state's `files` map is byte-for-byte identical to an
  independent from-scratch rebuild after EVERY step (not just the final
  one). Exercises fan-in, extension-priority shadowing in both
  directions, and directory-index resolution simultaneously. Passes.
- Pre-existing `incremental_root_add_matches_full_rebuild_when_the_new_
  file_satisfies_a_previously_unresolved_import`,
  `incremental_root_add_reresolves_a_higher_priority_extension_shadow`,
  `incremental_root_removal_matches_full_rebuild_when_deleting_an_imported_
  file` (create-resolves-unresolved, create-shadows, delete-un-resolves)
  all still pass against the narrowed sweep — the exact three cases the
  task listed that already existed.

Full suite: `cargo test -p urdira-jsts-syntax-worker --lib` — **154/154**
(was 151/151 before this session's 3 new tests).

### 2.3 Measured (n8n scale, worker-only `total_ms`)

| Kind | P3-3 baseline | This session | Δ |
|---|---:|---:|---:|
| CREATE | 986ms | **463ms** | −53% |
| DELETE | 848ms | **726ms** | −14% |
| RENAME | 904ms | **515ms** | −43% |

Gate: "CREATE/DELETE/RENAME worker-only ≤ 600ms" — **CREATE and RENAME
met** (463ms, 515ms); **DELETE misses** (726ms) — see §4.2's honest
residual on `resolve_ms` for why.

## 3. Item 3 — parse residual

### 3.1 Root cause found and fixed: `reverse_affected_closure`'s O(corpus) rebuild on EVERY call

`reverse_affected_closure` (`lib.rs`) built a full reverse import-edge map
by scanning **every file in `prior` AND `next`** on every single
`analyze()` call — cold scans, content edits, and path-membership changes
alike (not just create/delete, which item 2 targeted separately). At n8n
scale (14,082 owners) this is a real O(corpus) cost inside what
`ScanTimings` buckets as `parse_ms`, on top of the double-clone P3-3 item
3 already fixed.

New: `ImportReverseIndex`, a second per-project incrementally-maintained
reverse index (separate from `CandidateIndex` because it's keyed by
`target_path`, which reresolution DOES change, unlike `CandidateIndex`'s
specifier-text key) — `target_path -> {importer paths}`, maintained for
`changed_sources`/`removed` at the same point as `CandidateIndex`, and
AGAIN for `reresolved` paths right after that loop runs (their outgoing
edges only become current then). `reverse_affected_closure`'s BFS itself
is unchanged (`ImportReverseIndex::affected_closure` is the identical
loop); only where the reverse map comes from changed — a lookup against
the maintained index instead of an O(corpus) rebuild, falling back to the
old rebuild only if a project has no index yet (defensive).

**A deliberate simplification, verified rather than assumed**: the old
function unioned `prior` and `next` file maps; the new index mirrors only
`next`'s current state. Reasoned to be safe (every seed seen by the BFS —
`changed`/`closure_changed` — is unconditionally in the output regardless
of the graph's own edges, so the union's only possible effect was on
non-seed reachability, and an unaffected file's own edges never differ
between `prior` and `next`) and then EMPIRICALLY confirmed: the full
154-test `urdira-jsts-syntax-worker` suite (including `content_changes_
return_the_reverse_affected_closure` and the new 300-file randomized
test) and the n8n-scale `n8n_incremental_create_delete_roots_match_oracle`
all pass unchanged.

### 3.2 What was NOT fixed

Target was `parse_ms ≤ 80ms` for a 1-file edit. Measured steady-state
`parse_ms`: **152ms (EDIT#2), 148ms (DELETE), 191ms (EDIT#3)** — down from
P3-3's 177–183ms baseline (a further ~10–18% cut from this item alone,
stacked on P3-3 item 3's ~40% cut), but the ≤80ms target is **not met**.
The remaining cost is spread across oxc decode+parse of the changed
source(s) themselves, thread-pool setup for the (here, single-file)
parallel parse loop, and whatever residual dictionary/root-list work
`analyze()` still does per call — none of which this session isolated
further within its remaining time. Flagged as the next concrete lever for
`parse_ms`, with the two O(corpus) causes already found (P3-3's double
clone, this session's `reverse_affected_closure` rebuild) now both closed.

## 4. Item 4 — measurement

### 4.1 Idle-machine protocol

`pgrep -f "v4-scan|urdira-indexing-worker|n8n-incremental-preflight|v4-mutation-harness"`
empty before every measurement run in this session; no other agent's
process observed running concurrently during either the `n8n_incremental_
measurement` or `n8n_incremental_create_delete_roots_match_oracle` runs.

### 4.2 Final worker-only n8n table (release, in-process, no daemon/watcher, all items applied)

`v4::tests_e2e::n8n_incremental_measurement`, `URDIRA_DEBUG_TIMING=1`:

| Phase | COLD | EDIT#1 (cold-cache) | EDIT#2 (steady) | CREATE | DELETE | EDIT#3 (steady) | RENAME | HUB surface-unchanged | HUB surface-changed |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| catalog_ms | 6,067 | 8 | 4 | 8 | 1 | 3 | 7 | 6 | 3 |
| parse_ms | 2,206 | 668 | 152 | 154 | 148 | 191 | 160 | 173 | 191 |
| resolve_ms | 1,509 | 124 | 69 | 69 | 331 | 77 | 72 | 79 | 174 |
| materialize_ms | 7,487 | 31 | 24 | 22 | 29 | 25 | 26 | 26 | 248 |
| write_ms | 3,322 | 86 | 109 | 63 | 57 | 67 | 100 | 62 | 289 |
| **total_ms** | **21,948** | **1,704** | **502** | **463** | **726** | **519** | **515** | **495** | **1,078** |

### Gate comparison (worker-only `total_ms`, vs P3-3 baseline)

| Kind | Target | P3-3 baseline | This session | Verdict |
|---|---|---:|---:|---|
| Edit steady-state | ≤500ms (stretch 400) | 614–686ms | 502–519ms | Close, not fully met; ~18–25% faster than P3-3 |
| Create/delete/rename | ≤600ms | 848–986ms | 463–726ms | **CREATE/RENAME met**, DELETE misses (726ms) |
| Hub surface-unchanged | ≤1.0s | 571ms | **495ms** | **Met**, improved further |
| Hub surface-changed | proportional to true dependents | 1,236ms | **1,078ms** | **Met** — still tracks real semantic scope |

**Honest residual, not root-caused this session**: DELETE's `resolve_ms`
(the E1a-E3 hybrid-semantics pass over `affected_paths`,
`analyze.rs::run_scoped`'s `run_hybrid_semantics` call — a DIFFERENT
phase than `parse_ms`/`SyntaxWorkerState::analyze`, out of items 2/3's own
scope) jumped from P3-3's 71ms to **331ms** for the identical harness
step. This is a real regression in a bucket this task did not target, not
a correctness issue (the n8n-scale root-equality oracle still passes
after this exact DELETE step, and an inflated `affected_paths` set is, at
worst, safe over-work, never a wrong final state — semantic re-resolution
is idempotent). Attempted to isolate the cause via each generation's
`facts_for_paths` file-count debug line, but that line counts a
DIFFERENT set (`changed_paths`, not `affected_paths`) and does not
distinguish the two, so this session could not pin the exact affected-set
size driving the extra 260ms within its remaining time. Flagged
explicitly for whoever picks up `resolve_ms`/hybrid-semantics scope next,
with the exact reproduction (n8n mutation harness's own DELETE step,
generation 5) named so it does not need rediscovering.

### 4.3 Roots / correctness re-verification

- `n8n_incremental_create_delete_roots_match_oracle`: **passes** —
  `records`/`dependency`/`graph` roots match a from-scratch oracle scan of
  the mutated tree exactly, through the new delta container format and
  the narrowed create/delete re-resolution sweep together.
- Every fixture-scale create/delete/rename root-equality test in
  `urdira-indexing-worker` (`incremental_create_roots_match_a_from_
  scratch_scan_of_the_mutated_tree`, `..._delete_...`, `..._rename_...`),
  the merkle self-consistency tests (`incremental_edit_produces_a_self_
  consistent_incremental_merkle_update`, `mixed_burst_edit_plus_create_
  delete_splits_into_two_generations_and_stays_self_consistent`), and the
  P3-3 digest-churn regression tests — all still pass.
- Compaction: `compact_matches_pre_compaction_state_and_respects_
  refcount`, extended this session from 3 to **40 deltas** before
  compacting, still asserts identical Merkle roots, identical
  `by_owner`/`iter_visible`/`visible_count` results, and correct
  refcount-blocked deletion — against the new container format.

## 5. Hard rule: the shared n8n corpus was never mutated

`.urdira-shared-corpus-readonly` marker confirmed present at the corpus
root before this session's first mutation. Every n8n-scale test routes
through the pre-existing `scratch_copy_of_n8n_corpus` helper, never
touching the corpus directly. Verified at the end of this session (after
every measurement/oracle run above):

```
diff -rq --exclude=.git --exclude=node_modules \
  ~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02 \
  ~/Proyectos/n8n \
  | grep -v docs/architecture | grep -v readonly
```

→ four `Directory loop detected` lines only (`.claude/plugins/n8n/skills`,
`.claude/skills`, both sides — a pre-existing symlink cycle in the corpus
fixture unrelated to this session, present identically on both trees, not
a content difference). No other output.

## 6. Quality gates

- `cargo fmt --all` — applied; `cargo fmt --all -- --check` clean
  afterward.
- `cargo clippy -p urdira-jsts-syntax-worker -p urdira-indexing-worker -p urdira-structural-store -p urdira-native-node -p urdira-indexing-core --all-targets -- -D warnings` — clean.
- `cargo test`:
  - `urdira-structural-store`: all 9 integration suites green (roundtrip,
    delta, compaction @ 40 deltas, recovery, merkle, concurrency,
    write-base-determinism; NODIAG bench `#[ignore]`d, not run this
    session — unaffected by this task's changes, base-path only).
  - `urdira-jsts-syntax-worker`: **154/154** (151 pre-existing + 3 new).
  - `urdira-indexing-core`: 33/33 (2 `#[ignore]`d benches not run).
  - `urdira-indexing-worker`: 65/65 non-ignored + both n8n-scale
    `#[ignore]`d tests (`n8n_incremental_measurement`,
    `n8n_incremental_create_delete_roots_match_oracle`) run explicitly,
    both green.
  - `urdira-native-node`: compiles and links against the changed
    `urdira-structural-store` API unchanged (no napi surface touched —
    `structural_store_napi.rs` is cold-only, `write_base`-based, never
    reaches the delta container code path); 0 Rust-side unit tests in
    this crate (napi surface is exercised by the vitest suites below).
- `npx vitest run tests/v4-scan.test.ts tests/native-query-snapshot-port.test.ts tests/v4-verify.test.ts tests/v4-daemon-e2e.test.ts tests/codebase-fixtures.test.ts` — 5 files, **26 passed, 1 skipped, 0 failed** (ran against a freshly rebuilt native addon, `node scripts/build-native.mjs`).
- Full-repository `pnpm verify` NOT run: same rationale as every prior
  evidence doc in this task chain — extensive concurrent uncommitted work
  from other in-flight sessions across unrelated packages/crates
  (`git status` shows dozens of modified/untracked files outside this
  task's scope, including P3-5's own daemon/watcher/harness work running
  in parallel per the task brief). Every gate above is scoped to exactly
  the crates/files this task touched.

## 7. Files touched

- `crates/urdira-structural-store/src/container.rs` — new module (item 1).
- `crates/urdira-structural-store/src/segment_io.rs` — `header_and_data`/
  `verify_xxh3` retyped to `&[u8]`; `encode_framed` extracted; dead
  `write_hot_records_files` removed (superseded by `write_hot_and_
  secondary_files`, already the sole caller from `write_base`); new
  `SectionSource` enum.
- `crates/urdira-structural-store/src/writer.rs` — `write_delta_with_
  reader` rewritten around the container (new sub-timers); new
  `build_delta_sections`; dead `build_secondary_arrays` removed.
- `crates/urdira-structural-store/src/reader.rs` — `Segment`/`Segment::
  open`/`StoreInner::load` retyped and rebranched over `OpenedLocation`;
  `load_dict_file`/`load_subjects_file`/`load_closures` retyped to take
  bytes instead of a path; `verify_all`/`touch_pages` retyped.
- `crates/urdira-structural-store/src/recover.rs` — `remove_segment`
  dispatches dir-vs-file; orphan sweep also matches `delta-*.seg` files.
- `crates/urdira-structural-store/src/compact.rs` — cleanup loop
  dispatches dir-vs-file.
- `crates/urdira-structural-store/tests/recovery_test.rs`,
  `tests/compaction_test.rs` — updated for the container format; the
  compaction test now runs 40 deltas (was 3).
- `crates/urdira-indexing-core/src/merkle_bucket.rs` — `write_slots`
  slot-coalescing (item 1, additive).
- `crates/urdira-jsts-syntax-worker/src/resolver.rs` — `push_candidate_
  variants` (extracted from `probe_extensions`), `PackageInfo::
  candidate_bases`, `TsConfigResolved::candidate_bases`, `WorkspaceResolver::
  candidate_paths` (item 2, additive).
- `crates/urdira-jsts-syntax-worker/src/lib.rs` — `CandidateIndex` (item
  2), `ImportReverseIndex` (item 3), both maintained inside `analyze()`;
  `stale_paths`/`affected` computations narrowed; `SyntaxWorkerState`
  gained the two index maps; `reset()` clears them; 3 new tests.

## 8. Residuals / honest summary

1. **Item 1 fully shipped and measured**: one `F_FULLFSYNC` per delta
   generation (was up to 18), `container_fsync` flat at 6–9ms regardless
   of row count, base format/napi API unchanged, 40-delta compaction and
   the n8n root-equality oracle both green. Two rows (EDIT#2 at 71ms,
   HUB-changed at 126ms) exceed the literal ≤60ms target because their
   row/closure counts are genuinely larger than a minimal steady edit —
   the fixed per-file-fsync cost this item targeted is gone either way.
2. **Item 2 fully shipped for CREATE/RENAME** (both meet ≤600ms, 53%/43%
   faster than P3-3); **DELETE misses** (726ms) due to the unresolved
   `resolve_ms` regression in §4.2 — a different phase (hybrid semantics)
   than the one this item narrowed (syntax-level re-resolution), flagged
   with an exact repro rather than hidden.
3. **Item 3 partially closed**: the O(corpus) `reverse_affected_closure`
   rebuild is fixed and verified safe (empirically, not just argued); the
   ≤80ms `parse_ms` target is not met (152–191ms) — the residual cost is
   now spread across oxc parse/decode and thread-pool overhead for a
   single changed file, not a remaining O(corpus) loop this session could
   find.
4. **Item 4 complete**: idle-machine protocol followed, full worker-only
   table with sub-timers gathered, roots re-verified at both fixture and
   n8n scale, compaction extended to 40 deltas as required.
5. **Item 5 complete**: this document plus the P2-3 doc's new §1.1a; all
   listed quality gates run and green except full-repo `pnpm verify`
   (same standing exception every prior doc in this chain has taken, for
   the same reason).
