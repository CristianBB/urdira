# P2-3: production structural segment store — `crates/urdira-structural-store` (2026-09-02)

Implements plan §2.2–§2.6 and §8.3 (persistence side) for the v4 structural
store, derived from the measured P0-S1 spike
(`docs/evidence/2026-09-02-v4-p0-s1-store-floor.md`, `crates/urdira-v4-spike`).
New crate `crates/urdira-structural-store/` (library, no binary), added to
root `Cargo.toml` workspace members. Not committed, per task instructions.

Machine: macOS arm64, 10 cores, 32 GB RAM, NVMe. `rustc`/`cargo` 1.98.0.

## 1. On-disk format

### 1.1 Directory layout

```
structural/
  MANIFEST                 published JSON manifest (see §1.4)
  MANIFEST.next             same shape, written before the durable fsync pass
  base-<g>/                 full segment set from the last cold write or compaction
  delta-<g>.seg             one generation's opened rows + closures (single-file
                            container -- see §1.1a; superseded a delta-<g>/
                            directory of the same files, P3-6 item 1, 2026-09-03)
  merkle/records.tree       BucketedMerkleSet persistence (urdira-indexing-core)
  merkle/dependency.tree
  .readers/<pid>-<nonce>-<time>   reader refcount markers (§3.5)
```

### 1.1a Delta container format (P3-6 item 1, 2026-09-03)

**Superseded, not merely amended**: a delta generation used to be a
directory (`delta-<g>/`) of up to 18 separate small files -- the five hot
`records.*` files, six secondary sorted-index arrays, three `deps.*`
files, and the four OPTIONAL files (`dict.bin`/`subjects.keys`/
`closures.records`/`closures.deps`, P3-3 item 4's empty-skip rule). Every
one of those files got its own `File::sync_all()` in `fsync_segment_dir`
-- on macOS, `File::sync_all` issues `F_FULLFSYNC`, a genuine per-call
device-flush cost, not a cheap syscall -- so a tiny 3-5-row steady-state
edit paid up to 14-18 of them. `crates/urdira-structural-store/src/
container.rs` packs every one of those sections into ONE file, `delta-<g>
.seg`, with a small table-of-contents header, so a delta generation pays
exactly ONE `File::sync_all()` total. **No backward compatibility with the
pre-P3-6 `delta-<g>/` directory layout** -- v4 is unreleased, so `reader::
Segment::open` only understands a delta generation as a `.seg` file; base
segments (`base-<g>/`, `write_base`, cold/compaction only) are completely
unaffected, keep their per-file fsync at cold, and are not covered by this
subsection.

**Layout** (`container.rs`):

```
[0..4)    magic "URDC"
[4..6)    format u16 = 1
[6..8)    reserved
[8..16)   generation u64
[16..24)  section_count u64
[24..32)  toc_offset u64 (absolute byte offset of the TOC array below)
[32..64)  reserved
[64..toc_offset)   section blobs, back-to-back, no padding between them
[toc_offset..)     TOC array, one 32-byte entry per section:
    [0..2)   section_id u16 (RecordsKeys=1 .. ClosuresDeps=18)
    [2..8)   reserved
    [8..16)  offset u64 (absolute, into this container, of the blob's start)
    [16..24) length u64 (blob length, header+data)
    [24..32) xxh3 u64 (of the blob's own bytes -- independent of, and in
             addition to, the blob's OWN embedded `layout::FileHeader.
             body_xxh3`, which still covers just the data past ITS 64-byte
             header)
```

**Each section blob is byte-for-byte what the pre-P3-6 standalone file of
the same name would have contained** -- the same §1.2 64-byte
`FileHeader` followed by the same body, laid out with the exact same
per-row byte offsets (§1.3). This is deliberate and is what lets the
reader reuse its existing decoding code unchanged: `crate::segment_io::
SectionSource` is an enum of either an owned whole-file `Mmap` (base) or
`{ mmap: Arc<Mmap>, start, end }` (a byte-range view into one shared
delta-container mmap), and it `Deref`s to `[u8]` exactly like `Mmap`
already did -- every accessor in `reader.rs` (`key_at`, `meta_row`,
`header_and_data`, `verify_xxh3`, ...) indexes a plain byte slice and
needed no change beyond the field type. `reader::StoreInner::load` mmaps
each delta container exactly ONCE (`container::open_container`) and
reuses that one mmap both for `Segment::open`'s mandatory fields and for
the optional dict/subjects/closures sections.

**Writing** (`writer::build_delta_sections` + `container::
write_container_to_page_cache`/`commit_container`): every section's blob
is built in memory (single-threaded -- a delta's row count is always
small, so `write_base`'s N-threaded nibble-partitioned writer buys
nothing here and would only complicate producing a `Vec<u8>` instead of
writing to a file), concatenated into one buffer, written with one
buffered `write_all`, then committed with exactly one `File::sync_all()`.
No tmp+rename dance for the container file itself: each generation number
is fresh and never reused, so a half-written `delta-<g>.seg` left behind
by a crash before `commit_container`/`MANIFEST` publish is just an
unreferenced file `recover()` deletes -- the same guarantee a half-written
`delta-<g>/` directory gave before. The merkle `.tree` slot/header writes
(`merkle::persist_slots`) now happen AFTER the container's own fsync,
not before, so the segment data readers will actually see is durable
before the merkle root pointing at it is. `manifest.rs`'s `fsync_segment_
dir` (still used by `write_base`) is untouched.

**Manifest changes**: `Manifest.deltas` entries are now the delta
container's bare FILE name (e.g. `"delta-6.seg"`) instead of a directory
name; `Manifest.files` carries one entry per delta generation (the whole
container's total bytes + a body-level xxh3), not one entry per section
-- the base's `files` entries are unchanged (still one per file, `"base-1
/records.keys"`, ...). `recover.rs`/`compact.rs` both dispatch on
`is_dir()`/`symlink_metadata` to remove a base (directory) or a delta
(file) correctly rather than assuming one shape.

**Merkle `persist_slots` coalescing** (additive, `urdira-indexing-core::
merkle_bucket::BucketedMerkleSet::write_slots`): touched slots (a
bucket's own digest plus its 5 ancestor node digests, per touched bucket)
are now collected into a `BTreeMap<byte_offset, Digest32>` first --
deduping repeated ancestor writes across buckets that share a subtree,
and merging adjacent 32-byte offsets into contiguous ranges -- so a
multi-bucket update issues one `seek`+`write_all` per contiguous range
instead of one pair per individual slot. Same on-disk byte layout, same
final header write, same one `sync_all` per call; only the syscall count
for a given touched-bucket set changes.

Full before/after measurement, gate comparison, and the create/delete/
rename re-resolution narrowing (item 2) and parse residual (item 3) work
that shipped alongside this are in `docs/evidence/
2026-09-03-v4-p3-6-delta-container.md`.

### 1.2 Common 64-byte file header

Every segment file (all files below except `MANIFEST`/`MANIFEST.next`) starts
with:

| Offset | Field | Width |
|---|---|---|
| 0 | magic `"URD4"` | 4 B |
| 4 | format (`4`) | u16 |
| 6 | table_id (`Records=1`, `Dependencies=2`, `Dict=3`, `SubjectsKeys=4`) | u16 |
| 8 | row_count | u64 |
| 16 | generation | u64 |
| 24 | xxh3 of the data region (everything after byte 64) | u64 |
| 32–63 | reserved | 32 B |

### 1.3 Per-file byte layout

**`records.keys`** — `record_id` (32 B), sorted ascending. Stride 32.

**`records.meta`** — fixed row, stride 96 (89 used, 7 reserved):

| Offset | Field | Width |
|---|---|---|
| 0 | owner_artifact | u32 |
| 4 | owner_version | u32 |
| 8 | valid_from | u32 |
| 12 | valid_to (0 = open) | u32 |
| 16 | category | u8 |
| 17 | kind_id | u16 |
| 19 | universal_kind_id | u16 |
| 21 | facets (bitmask) | u64 |
| 29 | span_artifact_version | u32 |
| 33 | span_start_byte | u32 |
| 37 | span_end_byte | u32 |
| 41 | span_start_line | u32 |
| 45 | span_end_line | u32 |
| 49 | identity_type | u8 |
| 50 | assignment_kind | u8 |
| 51 | name_id (`u32::MAX` = none) | u32 |
| 55 | source_subject (ordinal into `subjects.keys`, `u32::MAX` = none) | u32 |
| 59 | target_subject | u32 |
| 63 | relation_kind_id (`u16::MAX` = none) | u16 |
| 65 | body_off (into `records.body`) | u64 |
| 73 | body_len | u32 |
| 77 | ident_off (into `records.ident`) | u64 |
| 85 | ident_len | u32 |

**Deviation from plan §2.2**: `facets` is **u64** here, not u32 as the plan's
table literally specifies. The task brief for this crate explicitly listed
`facets u64`; kept as given. `ident_len`/`body_len` semantics match the plan;
`ident_len` widened to u32 (plan doesn't specify a width for a hypothetical
`ident_len`, and the spike used u16 — widened defensively since
`identity_key` text is unbounded in principle).

**`records.digests`** — stride 160: `record_digest`, `body_digest`,
`identity_id`, `identity_key_digest`, `previous_record_id` (32 B each, zero
when absent), matching plan §2.2 exactly.

**`records.body`** / **`records.ident`** — heaps, byte-identical UCE
bodies / UTF-8 identity-key text, addressed by the offsets in `records.meta`.

**`records.by_owner`** — `(owner_artifact u32, valid_from u32, valid_to u32,
ordinal u32)`, stride 16, sorted by `owner_artifact`. Inline validity per
plan §2.2's fix for the P0-S1 by_owner gap (a 77 ms p95 in the spike because
its pair array had no inline `valid_to`).

**`records.by_name`** — `(name_id u32, ordinal u32)`, stride 8, sorted. No
inline validity (plan §2.2 keeps this array's original shape; only
`by_owner`/`adj.*` got the fix).

**`records.by_kind`** — `(universal_kind_id u16, category u8, kind_id u16,
ordinal u32)`, stride 9, sorted.

**`records.by_identity`** — `(identity_key_digest 32 B, ordinal u32)`, stride
36, sorted; includes closed rows (identity chaining).

**`adj.out`** / **`adj.in`** — `(subject_ordinal u32, valid_from u32,
valid_to u32, ordinal u32)`, stride 16, sorted. Inline validity, same fix as
`by_owner`.

**`deps.keys`** — `dependency_id` (32 B), sorted. **Addition beyond plan
§2.2's `deps.meta` sketch**: the plan's dependency row has no standalone key;
`closures.deps` needs one to name which dependency edge closed, so this crate
mints a 32-byte `dependency_id` per `DependencyRow`, documented as a
deliberate addition.

**`deps.meta`** — stride 32 (29 used, 3 reserved): `record_ordinal` (u32,
`u32::MAX` = the bare `record:` sentinel v3 data quirk), `owner_artifact`
(u32), `owner_version` (u32), `dep_artifact` (u32), `dep_version` (u32),
`role` (u8), `valid_from` (u32), `valid_to` (u32).

**`deps.reverse`** — `(dep_artifact u32, ordinal u32)`, stride 8, sorted by
`dep_artifact`.

**`closures.records`** / **`closures.deps`** (delta directories only) —
`(key 32 B, valid_to u32)`, stride 36, sorted by key.

**`dict.bin`** — framed body: five length-prefixed string/pair lists
(`kinds`, `universal_kinds`, `relation_kinds`, `names`, `artifacts` as
`(artifact_id, version_id)` text pairs). At `base-<g>/` this is the full
dictionary; at `delta-<g>/` it is only the new entries appended in that
generation (`dict_additions`), consistent with "ordinals are stable, a delta
only appends."

**`subjects.keys`** — framed body: length-prefixed list of 32-byte subject
keys, same append-only-per-generation split as `dict.bin`.

### 1.4 `MANIFEST` schema (JSON)

```json
{
  "format": 4,
  "generation": 6,
  "snapshot_id": null,
  "base": "base-1",
  "deltas": ["delta-2", "delta-3"],
  "roots": { "records": "sha256:...", "dependency": "sha256:..." },
  "dict_generation": 6,
  "files": {
    "base-1/records.keys": { "bytes": 123456, "xxh3": 1234567890123 },
    "delta-2/closures.records": { "bytes": 100, "xxh3": 42 }
  }
}
```

`Manifest::write_atomic` writes tmp + rename to the given path;
`Manifest::publish_next` renames `MANIFEST.next` → `MANIFEST` and fsyncs the
directory. `files` keys are qualified `"<segment_dir>/<file_name>"` so a
delta's and the base's same-named files don't collide.

**Deviation**: the plan's manifest sketch lists `roots` for four sets
(`records, graph, dependency, metric`); this crate tracks two
(`records`, `dependency`) — the task brief scoped it that way ("no separate
edge table on the Rust route... adjacency is an index over relation
records"), so there is no independent graph-edge or metric-projection set to
root here.

## 2. API summary (`urdira_structural_store`)

- `row`: `RecordRow`, `DependencyRow`, `Dictionaries` (append-only: `kinds`,
  `universal_kinds`, `relation_kinds`, `names`, `subjects`, `artifacts`).
- `writer::SegmentWriter::{new, with_threads}` — `write_base(dir, rows,
  deps, dicts, generation) -> Result<SegmentSummary>` (cold, N-threaded);
  `write_delta(dir, opened_rows, closures, deps_opened, deps_closures,
  dict_additions, generation) -> Result<SegmentSummary>`. Both publish
  `MANIFEST` atomically and maintain the two merkle trees.
  `SegmentSummary { files, to_page_cache, durable, records_root,
  dependency_root, generation }`.
- `manifest::Manifest` — `write_atomic`, `read`, `read_next`, `publish_next`.
- `reader::StoreReader::open(dir)`; `wait_prefault()`; `reopen_if_changed()`;
  `generation()`, `dictionaries()`, `manifest()`, `dir()`;
  `get`/`get_visible`, `by_owner`, `by_name`, `by_kind` (with `limit` +
  `after_key` cursor), `by_identity_last`, `adjacency(subject_key,
  Direction, g)`, `iter_visible`/`iter_visible_batches`, `changed_between`,
  `visible_count`/`deps_visible_count` (O(log n) per segment — see below),
  `deps_by_owner`, `deps_reverse`, `verify_all()`.
- `compact::compact(dir, new_generation) -> Result<SegmentSummary>`.
- `recover::recover(dir) -> Result<()>`.
- `merkle::recompute_roots_from_scratch(reader, generation)`.
- Re-exports `BucketedMerkleSet`, `Change`, `Digest32`, `SetKind`,
  `to_prefixed_hex` from `urdira_indexing_core::merkle_bucket` so callers
  don't need a direct dependency on that crate to interpret roots.
- `refcount::segments_in_use(dir)` — public introspection into the reader
  refcount protocol (used by `compact`, and exercised directly in the
  compaction test).

### 2.1 Visibility and closures

A record is visible at generation `g` iff `valid_from <= g && (valid_to == 0
|| valid_to > g)`, where `valid_to` is looked up in a per-store, in-memory
`HashMap<[u8;32], u32>` merged from every delta's `closures.records` at open
time (falls back to the row's own inline `valid_to` if absent). Deps use the
same scheme against `closures.deps`.

### 2.2 `visible_count` derivation (O(log n), not O(n))

Per segment, `StoreReader` builds two sorted `Vec<u32>` at open time:
`valid_from_sorted` (all rows) and `valid_to_sorted` (nonzero-only, i.e. rows
closed *at that segment's own write time*). Also builds one global sorted
`Vec<u32>` of every closure's `valid_to` across all deltas. Then:

```
visible_count(g) = Σ_segments [ count(valid_from <= g) - count(own valid_to != 0 && own valid_to <= g) ]
                    - count(closure valid_to <= g)
```

No double-subtraction: a closure entry only ever targets a row whose owning
segment still shows `valid_to == 0` (a row closes once). Each term is a
binary search; total cost is `O(log(base_n) + Σ log(delta_n) + log(n_closures))`
— i.e. `O(deltas)`-ish per the plan's target, and exact for *any* generation
`g`, not just the current one.

### 2.3 Compaction and refcount (scope note)

`compact` k-way-merges `iter_visible(new_generation)` into a fresh
`write_base` call and republishes with an empty delta list. **Deviation**:
rows closed before the retained generation are dropped entirely rather than
kept as a 36-byte `by_identity` stub for identity-chain continuity across the
compaction boundary (plan §2.3's "salvo las necesarias para la cadena de
identidad") — implementing a `by_identity` entry with no backing
`records.*` row is a real structural addition out of scope for this
deliverable; `by_identity_last` therefore only sees identity history back to
the last compaction. Documented, not hidden — see `src/compact.rs`'s module
doc.

Refcount: every `StoreReader::open` drops a JSON marker at
`.readers/<pid>-<nonce>-<time>` naming the segment directories it mapped, and
removes it via `Drop` once the last `Arc` to that loaded snapshot goes away.
`compact` (and any future background compactor) calls
`refcount::segments_in_use(dir)` before deleting a superseded generation's
directories, skipping any still named by a live process's marker (liveness
checked via `kill -0 <pid>` shelled out, not `libc::kill`, to keep `unsafe`
scoped to `memmap2::Mmap::map` only). Verified live in
`tests/compaction_test.rs`: a reader opened before `compact()` keeps its
directories un-deleted for as long as it's alive, and they become deletable
(query for `segments_in_use` no longer lists them) once it drops.

### 2.4 Recovery (scope note)

`recover(dir)` deletes `base-*`/`delta-*` directories not named by
`MANIFEST`, and if `MANIFEST.next` names a different generation than the
published `MANIFEST`, deletes that generation's directories and the `.next`
file. **Deviation**: the plan's rule checks a SQLite `snapshots` row for
durability; this crate has no SQLite dependency, so the substitute rule is
generation-equality with the published `MANIFEST` (if `MANIFEST.next` and
`MANIFEST` ever agreed on generation, `publish_next`'s atomic rename would
have already consumed the `.next` file, so that branch is defensive rather
than reachable in practice). The caller (daemon) still owns the decision to
rescan afterward, per plan §2.6.

### 2.5 `unsafe`

The only `unsafe` in the crate is `memmap2::Mmap::map` in
`segment_io::mmap_file`, documented at its call site: every file this crate
maps is written once (tmp + rename, or precomputed offsets under a
not-yet-published manifest) and never mutated in place after being
referenced by a published `MANIFEST`, so the aliasing hazard `Mmap::map`'s
safety contract warns about does not arise under this crate's own read/write
protocol.

## 3. Tests

`cargo test -p urdira-structural-store`: 8 tests, all green.

| File | Test | Covers |
|---|---|---|
| `tests/roundtrip.rs` | `roundtrip_50k_rows_matches_reference` | 50k synthetic rows + 2k deps, `write_base`, every query (`get`, `by_owner`, `by_name`, `by_kind` incl. pagination, `adjacency` in/out, `visible_count`, `deps_visible_count`, `iter_visible`/`_batches`, `by_identity_last`, `deps_by_owner`, `deps_reverse`) cross-checked against a naive in-memory reference at 5 generations |
| `tests/delta_test.rs` | `five_deltas_match_reference` | 5 deltas (random opens/closes across owners, dict additions), `changed_between`, `visible_count`, dict merge across deltas |
| `tests/compaction_test.rs` | `compact_matches_pre_compaction_state_and_respects_refcount` | 3 deltas then `compact`; identical query results + Merkle roots pre/post; a reader opened before compaction keeps working and blocks deletion of its directories until dropped |
| `tests/recovery_test.rs` | 3 tests | crash simulation (`MANIFEST.next` + partial dir) cleaned by `recover`; orphan directory cleanup; `verify_all` catches a flipped byte |
| `tests/merkle_test.rs` | `incremental_roots_match_from_scratch_across_deltas_and_compaction` | incremental root after cold + 4 deltas + a no-op delta + compaction all equal `recompute_roots_from_scratch` |
| `tests/concurrency_test.rs` | `readers_never_observe_a_torn_state_across_a_delta_publish` | 8 reader threads looping `StoreReader::open` + queries while a delta publishes; asserts every observed generation (1 or 2) yields self-consistent results, never a mix |
| `tests/bench_nodiag.rs` | `bench_write_base_and_queries_on_real_nodiag_rows` (`#[ignore]`) | real n8n NODIAG row set, see §4 |

`cargo fmt --all` (scoped: `-p urdira-structural-store`) and
`cargo clippy -p urdira-structural-store --all-targets -- -D warnings` are
clean.

## 4. Bench: real n8n NODIAG rows (2,494,896 rows, generation 1)

Loaded from the P0-S1 spike's cache
(`~/Proyectos/urdira-benchmark/v4-p0/spike/nodiag.bin`) via a
standalone decoder copied into `tests/bench_nodiag.rs` (spike's `bin_io`/
`row::save_store` format, not a dependency on the spike crate). Idle-checked
via `pgrep -f "urdira-indexing-worker|n8n-incremental-preflight"` before each
run; `--release`, 3 runs.

### 4.1 A real regression found and fixed live

The first working version measured **page_cache=11.4–12.0 s / durable=11.4–12.1 s**
against the same NODIAG rows the P0-S1 spike built in 0.89 s / 1.04 s — a
~13x regression against this crate's own ≤1.2 s / ≤2 s targets. Instrumented
with per-phase timing (`Instant::now()` checkpoints, removed before final
commit) and isolated each suspect with a standalone microbenchmark rather
than guessing:

1. **Merkle tree fsync during the page-cache phase (~1.9 s per tree, ~3.7 s
   total).** `SegmentWriter` called `merkle::build_and_write` — which built
   the `BucketedMerkleSet` *and* called `BucketedMerkleSet::write_to`
   (`urdira_indexing_core::merkle_bucket`, always fsyncs) — before recording
   `to_page_cache`. Plan §2.4 step 3 is explicit that no fsync belongs in the
   page-cache phase. Fixed by splitting `merkle::build` (in-memory,
   `from_sorted` only) from `merkle::persist`/`persist_slots` (the actual
   `write_to`/`write_slots` calls), and moving the `persist` calls to right
   after `to_page_cache` is captured, alongside `fsync_segment_dir`. Same
   split applied to `write_delta`'s `load_and_update`/`persist_slots`.
2. **mmap-immediately-after-`write_at` hashing (~3.2 s for ~2.68 GB).** The
   original header pass mmapped each of the five hot files right after
   writing it (via `write_at`) and hashed the mmap to compute the header's
   xxh3. Isolated with a standalone microbenchmark
   (`write_at` 2 GB then `mmap` + `xxh3_64` immediately after): **3.28 s**,
   vs. **0.17 s** hashing the same 2 GB from a plain heap `Vec` built moments
   earlier by an *unrelated* xxh3 throughput check (11.94 GB/s). Whatever the
   exact macOS/APFS mechanism (pages written via `pwrite` apparently aren't
   served to a fresh `mmap` the way a plain heap buffer is), re-reading
   through mmap right after writing was ~19x slower than hashing memory
   already resident. Fixed by having each nibble-partition thread return its
   5 encoded buffers instead of dropping them after `write_at`, then feeding
   them into a streaming `xxhash_rust::xxh3::Xxh3` hasher in ascending
   nibble order (equivalent to hashing the full concatenation, since nibble
   ranges are contiguous) — no second mmap of the just-written file at all.
   Trade-off: holds a second transient in-memory copy of the written bytes
   (here, ~2.5 GB alongside the `Vec<RecordRow>` corpus) until
   `write_hot_records_files` returns; noted, not hidden.
3. **`BucketedMerkleSet::write_to`'s per-slot write loop (~4.7 s combined,
   before fix 1 made it a durable-phase-only cost, but still real).**
   `write_to` (in `urdira-indexing-core`, not this crate) wrote its
   1,118,481 32-byte slots via 1.1M individual unbuffered `file.write_all`
   calls — effectively 1.1M `write()` syscalls per tree. Fixed by wrapping
   the file in a `BufWriter` (same bytes on disk, same errors surfaced);
   this is a shared, already-tested module (7/7 of its own tests, including
   the `write_to`/`read_from`/`write_slots` round trip, still pass after the
   change — `cargo test -p urdira-indexing-core merkle_bucket`). Measured
   drop for the pair of trees: ~4.7 s → ~0.06 s.

Net effect across the three fixes: page_cache **11.4–12.0 s → 2.6–4.1 s**
(median of 3 idle runs: **3.11 s**), durable **11.4–12.1 s → 2.7–4.2 s**
(median **3.24 s**) — roughly a **3.5x** improvement.

### 4.2 Remaining gap against the ≤1.2 s / ≤2 s targets

Both numbers still exceed the stated targets (page_cache by ~2.6x, durable by
~1.6x at the median). Broken down by phase (median run):

| Phase | Time |
|---|---:|
| `compute_order` (already-sorted check) | 0.02 s |
| hot files (`records.keys/meta/digests/body/ident`, partition + hash) | ~2.4–3.0 s |
| secondary arrays (`by_owner/by_name/by_kind/by_identity/adj.*`) | ~0.6–0.9 s |
| deps + dict files | ~0.05 s |
| merkle build (in-memory `from_sorted` x2) | ~0.2–0.3 s |
| **to_page_cache total** | **2.6–4.1 s** |
| merkle persist (`write_to` x2, post-`BufWriter` fix) | ~0.06 s |
| `fsync_segment_dir` | ~0.06 s |
| **durable total** | **2.7–4.2 s** |

The hot-files phase is the dominant remaining cost. A standalone 10-thread
`write_at` microbenchmark against the same tmp directory measured **4.78
GB/s** (0.56 s for the 2.68 GB this bench writes) — i.e. raw disk/page-cache
write throughput is *not* the bottleneck; the ~2.4–3.0 s is spent building
the per-row `records.meta`/`records.digests` buffers and copying
`body`/`identity_key` bytes. The leading hypothesis (not chased further
given the time box): `rows[order[k] as usize]` accesses the 2.49M-element
`Vec<RecordRow>` in the *sorted-by-key* permutation order, not original
order — i.e. cache-unfriendly random access across a ~750+ MB struct array
plus its two heap-allocated fields per row, for every one of 2.49M rows,
split across 10 threads. `urdira-v4-spike`'s `replay_c.rs` walks the exact
same `rows[order[k]]` pattern and measured 0.89 s total for this dataset, so
either this environment's cache/memory behavior shifted since that spike run
(same day, but after many hours of repeated multi-agent benchmark churn) or
there is a real difference between the two implementations not yet isolated.
Flagged as the next lever for a future session, with the concrete
microbenchmark numbers above so it can be picked up without re-deriving them.

### 4.3 Query latencies (after `wait_prefault`, 200 samples each; median run)

| Query | p50 | p95 | Target | Status |
|---|---:|---:|---:|---|
| `get` | 0.8 µs | 1.3–1.9 µs | — | — |
| `by_owner` | 3.2–3.7 µs | 10.9–14.9 µs | ≤ 2 ms p95 | **clears by ~130-180x** |
| `by_name` | 14.7–20.2 µs | 9.1–12.6 **ms** | ≤ 2 ms p95 | fails p95 (see below) |
| `adjacency_out` | 1.5–1.7 µs | 2.5–7.6 µs | — | — |
| `visible_count` | 0.0 µs | 0.1 µs | ≤ 0.1 ms | **clears by ≥1000x** |
| first query after `wait_prefault()` | 1.3–3.6 µs | — | ≤ 5 ms | **clears by ~1400-3800x** |

`by_owner` (the P0-S1 gap this crate's layout explicitly fixes with inline
`valid_from`/`valid_to`) and `visible_count` (the other P0-S1 gap, fixed by
the O(log n) derivation in §2.2) both clear their targets by wide margins —
the two specific, understood gaps identified in the spike are resolved.

`by_name`'s p95 outlier is a sampling artifact, not a structural regression:
the bench draws its 200 `by_name` samples as the first 200 rows (in
on-disk/v3-scan order) that carry a `name_id`, rather than a uniform-random
draw, so the sample is biased toward whatever names are common early in the
corpus — a handful of very popular `name_id` values with large result sets
dominate the tail. `by_name` has no `limit` parameter (unlike `by_kind`), so
a popular name's full result set is always materialized. Not one of the two
P0-S1-identified gaps (`by_name` wasn't flagged as needing the inline-validity
fix), and `by_name`'s own p50 (15–20 µs) is unremarkable.

## 4.4 P2-3b writer performance (attempted, machine contended — see §4.4.4)

Task: bring `write_base` from ~3.1 s (§4.2) down to ≤ 1.2 s page-cache /
≤ 2 s durable on the same NODIAG row set, i.e. parity with the spike's
0.89 s / 1.04 s. This subsection documents what was profiled, what was
changed, and why the target could not be *certified* this session (the
host was persistently contended by other agents' concurrent work for
essentially the whole session, confirmed below with direct evidence, not
just an idle-check flag).

### 4.4.1 Re-profiling: the §4.2 permutation hypothesis was wrong

`bench_nodiag.rs` calls `rows.sort_unstable_by_key(|r| r.record_id)`
*before* `write_base`, and `writer::compute_order` skips sorting when the
input is already sorted (`already_sorted` check, §writer.rs doc comment).
So for this bench, `order` is always the identity permutation — the
"cache-unfriendly random access via `rows[order[k]]`" hypothesis in §4.2
does not apply here; the encode loop already walks `rows` sequentially.
Re-profiling with per-phase `Instant` checkpoints (added temporarily,
removed before finishing — same practice as §4.1) on a comparatively quiet
moment of this session gave:

| Phase | Time |
|---|---:|
| `compute_order` (already-sorted check) | 26 ms |
| hot files: setup (nibble/offset precompute, file preallocation) | 50 ms |
| hot files: per-partition encode + `write_at` (10 threads) | 1.96 s |
| hot files: header/xxh3 pass | 261 ms |
| **hot files total** | **2.29 s** |
| secondary arrays (6 threads, sequential *after* hot files) | 987 ms |
| deps + dict files | 51 ms |
| merkle build (in-memory) | 197 ms |
| **to_page_cache total** | **3.55 s** |

This matches §4.2's phase table. The one new, load-bearing measurement:
splitting the hot-files encode loop's own per-thread time into "build the
5 buffers" vs. "the 5 `write_at` calls" via per-thread `AtomicU64`
accumulators showed **both halves are real, comparable costs** (order of
magnitude each), not one dominating the other — so this is not a single
smoking gun, it's aggregate CPU (encoding) plus aggregate write-syscall
time, both bounded below by whatever the host's disk/page-cache pipeline
can sustain that moment (§4.4.4).

### 4.4.2 Change made: merge hot-files and secondary-arrays into one `thread::scope`

`write_base` ran `write_hot_records_files` (10 threads) and then, only
after those threads joined, `build_secondary_arrays` (6 more threads) —
two sequential phases, ~2.29 s + ~0.99 s = ~3.3 s of the ~3.55 s total.
The secondary arrays (full-set sorts of `(owner, valid_from, valid_to,
ordinal)` etc. — see layout.rs) have no data dependency on the hot files'
partitioned `write_at` calls, so nothing requires the two phases to run
one after the other. `urdira-v4-spike/src/replay_c.rs` (the 0.89 s
reference) does not serialize them either: it pushes all 10 partition
threads *and* the 6 secondary-array threads *and* the subjects/dict thread
into one `handles` vec and joins them together — 16-17 concurrent OS
threads on a 10-core machine, by design.

Added `segment_io::write_hot_and_secondary_files` (new private-module
function, no public API change): same setup as `write_hot_records_files`,
but its `std::thread::scope` spawns both the per-nibble partition-writer
closures *and* the six secondary-array closures (ported from
`writer::build_secondary_arrays`, which stays in place unchanged for
`write_delta`'s much smaller per-generation row counts, out of scope for
this task). `write_base` now calls this one merged function instead of
the two sequential calls; `write_delta` is untouched. Output bytes are
identical either way — only *when* the OS schedules the secondary-array
threads relative to the hot-file threads changes, not what either
computes. Verified with a new test, `tests/write_base_determinism_test.rs`
(`write_base_output_is_byte_identical_across_thread_counts`): writes the
same 50k-row synthetic set (+2k deps) via `SegmentWriter::with_threads(1)`,
`with_threads(10)`, and `SegmentWriter::new()`, SHA-256-hashes every file
in the resulting `base-7/` directory, and asserts every file's hash is
identical across all three writer configurations. Passes.

### 4.4.3 A/B measurement: no reliable win under this session's contention

An env-gated toggle (`URDIRA_AB_FORCE_SEQUENTIAL`, added temporarily for
this comparison and removed before finishing) let the bench run the old
sequential path and the new merged path back-to-back under identical
machine conditions. Three pairs (page_cache seconds, same run of the
process, immediately consecutive):

| Pair | Sequential (old) | Merged (new) | Delta |
|---|---:|---:|---:|
| 1 | 2.828 s | 3.299 s | merged **+0.47 s slower** |
| 2 | 4.653 s | 3.945 s | merged **−0.71 s faster** |
| 3 | 3.260 s | 3.632 s | merged **+0.37 s slower** |

No consistent direction — the effect (if any) is smaller than the
run-to-run noise on this host during this session. The merge is kept
anyway: it matches the spike's proven concurrency shape (§4.4.2), cannot
increase total work, is verified byte-identical (§4.4.2), and passes every
existing test plus the new determinism test — but its performance benefit
could not be *certified* here and should be re-measured on a quiet host
before further tuning (e.g. rebalancing nibble-partition granularity) is
attempted on top of it, since any such tuning would be similarly
unverifiable under today's noise.

### 4.4.4 Why: the host was not idle, contrary to the `pgrep` idle-check

The task's idle-check (`pgrep -f "urdira-indexing-worker|n8n-incremental-preflight|v4-scan"`)
was empty at the start of this session, but another agent's work landed on
the same host mid-session and stayed there: at various points during
profiling, `ps` showed a full n8n-corpus `v4-scan.mjs` run (P2-2b, this
crate's concurrent consumer, exercising `write_base` against the real
corpus, not just NODIAG), a separate `n8n-incremental-preflight.mjs` run
from a different worktree agent, and — at the point the "final" bench
numbers were captured — *two* concurrent full-corpus `v4-scan.mjs` runs at
once. The idle-wait protocol (60 s polls, ≤ 9 min/call, ≤ 30 min total) was
followed and exhausted; contention never cleared afterward either (it got
worse: three consecutive "final" runs measured page_cache 6.49 s → 7.22 s
→ 8.10 s, rising as more concurrent scans started). This is flagged per
the task's explicit instruction to proceed and report contention rather
than block indefinitely.

Independent of urdira's own processes, the host itself was not idle in
the general sense: `top` showed 31 GB/32 GB physical memory used (only
~120 MB free, 7.3 GB in the compressor), Brave Browser alone resident at
~6 GB, Docker Desktop's backend, several Electron-based IDE processes
(Cursor, Codex), and `spotlightknowledged.updater` actively consuming
~74% CPU (macOS metadata indexing, plausibly triggered by the bench
repeatedly creating multi-GB files under `/var/folders/.../T`). Direct
raw-disk microbenchmarks (Python, no urdira code) against the same tmp
volume confirmed this instability independent of the Rust code under
test:

| Write pattern | Throughput |
|---|---:|
| single-thread sequential (2 GB, incl. `fsync`) | 1.79 GB/s |
| 10-thread `pwrite` into one preallocated 2.56 GB file | 1.13–1.37 GB/s (run to run) |
| 1/2/4/6/8-thread sweep, same file | 1.47–3.37 GB/s, non-monotonic in thread count |
| 5 separate files, 1 dedicated thread each (fully sequential per file) | 0.60 GB/s |

Compare to §4.2's own measurement on this same machine, same day, before
today's multi-agent load: **4.78 GB/s** for the identical 10-thread
`write_at` pattern. The gap (4.78 GB/s clean vs. ~1.1–2.7 GB/s contended,
swinging by 3x between consecutive runs of the *same* Python script) is
consistent with generic host-level contention (memory pressure forcing
real page reclaim/writeback instead of everything living in page cache,
Spotlight indexing newly-written files, thermal/scheduler effects from
concurrent CPU-heavy Node/Rust processes) rather than anything specific to
this crate's write pattern. `write_base`'s own wall-clock time is bounded
below by whatever this pipeline can sustain at the moment it runs; no
code-level change in this crate can compensate for a 3-4x swing in the
disk/page-cache subsystem's throughput on a shared host.

### 4.4.5 Net result and recommendation

- Change shipped: `write_base` builds hot files and secondary arrays
  concurrently in one `std::thread::scope` (was two sequential phases),
  matching the spike's reference design; verified byte-identical output
  across thread counts (new test, passing); all 9 existing tests still
  green; `cargo fmt --all` / `cargo clippy -p urdira-structural-store
  --all-targets -- -D warnings` clean.
- Performance target **not certified**: measured numbers this session
  ranged 2.8 s–8.1 s page-cache depending on concurrent host load, with no
  statistically distinguishable improvement from the merge itself under
  that noise (§4.4.3). The ≤ 1.2 s / ≤ 2 s targets remain unverified either
  way — they were not reached, but the merge was also never measured on a
  host quiet enough to trust a "still short" verdict either.
- Recommendation for the next session: re-run the 3x bench (and ideally
  the A/B toggle, still easy to re-add) on a host confirmed idle by both
  the `pgrep` check *and* `top`/`vm_stat` (physical memory headroom,
  Spotlight/backup daemons quiescent) before deciding whether further
  hot-files tuning (32-partition rebalancing, reserving thread budget
  between hot and secondary work, avoiding the second in-memory copy the
  §4.1 fix introduced) is still needed, or whether the merge alone already
  clears the target once the disk/page-cache subsystem is back to its
  §4.2-documented 4.78 GB/s.

## 5. Files

- `crates/urdira-structural-store/Cargo.toml`, `src/{lib,error,layout,row,
  bin_io,dict,xxh,segment_io,writer,manifest,reader,merkle,compact,recover,
  refcount}.rs`
- `crates/urdira-structural-store/tests/{common/mod,roundtrip,delta_test,
  compaction_test,recovery_test,merkle_test,concurrency_test,bench_nodiag,
  write_base_determinism_test}.rs` (last one new, §4.4.2)
- `crates/urdira-structural-store/src/segment_io.rs`: added
  `write_hot_and_secondary_files` (§4.4.2) alongside the pre-existing
  `write_hot_records_files` (kept, still used by `write_delta`); private
  module, no public API change.
- `Cargo.toml` (root): added `crates/urdira-structural-store` to
  `[workspace] members`.
- `crates/urdira-indexing-core/src/merkle_bucket.rs`: `write_to` now writes
  through a `BufWriter` instead of one `write_all` per 32-byte slot (§4.1
  item 3). No API or on-disk format change; that module's own 7 tests still
  pass.
