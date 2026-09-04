# P0-S1: v4 structural store floor — measured spike (2026-09-02)

Decides the v4 structural store shape (single SQLite file, sharded SQLite, or a
flat-file segment store) against the real n8n v3 index, generation 1, full
corpus. No commit made (per task instructions). New code: throwaway crate
`crates/urdira-v4-spike/` plus `scripts/v4-spike-extract-relations.mjs`; one
new root `Cargo.toml` member line. All scratch output lives under
`~/Proyectos/urdira-benchmark/v4-p0/spike/` (25 GB on disk at
the end of the run; never touched `/tmp`).

Machine: macOS arm64, 10 cores, 32 GB RAM, NVMe, 190 GB free at start.
`rustc 1.98.0` / `cargo 1.98.0`. Node `v24.18.1`.

## Decode path taken

No canonical/UCE decoder exists in Rust (`crates/urdira-native-core` only has
`structural_kernel_canonical_batch*`, unrelated digest-batch helpers — grepped
for `decode`/`canonical`, nothing usable). Took the documented fallback:
`scripts/v4-spike-extract-relations.mjs` opens the v3 file with
`node:sqlite`'s `DatabaseSync(path, {readOnly:true})`, decodes every
`category='relation'` row's `body_payload` with `@urdira/canonical`'s
`decodeCanonical`, and streams `(record_id, source_id, target_id)` to a
binary file (`u32` length-prefixed; `classification` is decoded but **not**
written — nothing in the v4 DDL under test stores it, and Rust only needs the
two subject-id strings to compute `source_subject`/`target_subject` via
`sha256(subject_id_text)`). 2,195,114 rows decoded in 23–24 s, 579,266,228
bytes out.

```
node scripts/v4-spike-extract-relations.mjs <v3-db> spike/relations.bin
```

## Input volumes (as loaded, generation 1)

Source: `workspace_corpus_81e5eb4d-e69d-4931-b182-eea7005d20bb.sqlite`
(13,866,848,256 bytes). No `-wal`/`-shm` files were present at run time (the
workspace had already checkpointed), so a plain
`OpenFlags::SQLITE_OPEN_READ_ONLY` open already reflects every row — verified
against the brief's expected `record_occurrences` count (3,192,089) before
running the loader.

`crates/urdira-v4-spike load <db> <relations.bin> <out-dir>` reads
`record_occurrences`, `identity_assignments`, `record_facets`,
`artifact_dependencies` in four streaming passes plus the relations file, in
29.8 s total:

| pass | rows | time | unmatched |
|---|---:|---:|---:|
| record_occurrences | 3,192,089 | 8.45 s | — |
| identity_assignments | 3,192,089 | 9.34 s | 0 |
| record_facets | 3,505,282 | 5.17 s | 0 |
| relations.bin (subjects) | 2,195,114 | 1.08 s | 0 |
| artifact_dependencies | 30,838 | 92 ms | — |

Dictionaries built: 14,235 artifacts, 14,235 versions, 15 kinds, 14 universal
kinds (diagnostics map to `core:construct`, a real v3 data quirk, not a
loader bug), 3 identity types, 1 assignment kind (`created`), 6 facets,
**403,111 distinct relation subjects**. `record_facets` confirmed 6 distinct
facet strings — the bitmask needs no more than 6 of 32 bits.

One data-quality note found live: 81 of 30,838 `artifact_dependencies` rows
carry a bare `record:` sentinel (no hex suffix) instead of a real record id —
a workspace/artifact-level dependency not tied to one record. Handled as a
zero `record_id` rather than a hard error (every other column in every other
table decoded cleanly, 0 unmatched joins).

Two row sets written (FULL includes diagnostics; NODIAG drops
`kind=jsts:diagnostic`, which v4 drops):

| set | rows | cache bytes |
|---|---:|---:|
| FULL | 3,192,089 | 2,802,953,502 (full.bin) |
| NODIAG | 2,494,896 | 2,373,172,636 (nodiag.bin) |

`artifact_dependencies` carried through as `deps_full.bin` (30,838 rows) and
`deps_nodiag.bin` (30,757 rows — the 81 sentinel rows plus any diagnostic-only
rows don't match any NODIAG record id and are dropped by construction).

Simplifications made in the v4-shaped row (documented, not hidden):
`dependency_role`/`producer_id`/`producer_version` and the full
`dependency_entry_id` text are dropped from the carried-through
`artifact_dependencies` (30.8K rows vs 3.19M `record_occurrences` rows — not
what this decision hinges on); `relation_kind_id` reuses `kind_id` rather
than a separate dictionary (every relation kind's `kind_id` already
disambiguates it 1:1); NODIAG keeps the FULL dictionaries rather than
recompacting them, so ordinal spaces stay comparable across the two sets at
the cost of some now-unused dictionary entries in the small dictionary
tables (irrelevant to on-disk size: those tables are tiny).

## Store implementations built

- **replay-a**: one SQLite file, the exact DDL from the brief (`record_occurrences`
  `WITHOUT ROWID`, 6 indexes built after load), cold pragmas
  (`journal_mode=OFF; synchronous=OFF; locking_mode=EXCLUSIVE; cache_size=-1048576;
  page_size=16384; temp_store=MEMORY`), PK-ordered single-row-at-a-time inserts
  in one transaction, then `PRAGMA journal_mode=WAL; synchronous=NORMAL` and an
  explicit `fsync` of the file (+ containing directory).
- **replay-b**: the same shape sharded across three files written by three
  threads — `records.sqlite` (full row, PK + `ro_owner` only), `lookup.sqlite`
  (`record_id, name_id, kind_id, universal_kind_id, category,
  identity_key_digest, valid_from/to` + `ro_name`/`ro_kind`/`ro_ident`),
  `adjacency.sqlite` (`record_id, source_subject, target_subject,
  relation_kind_id, valid_from/to` + `ro_out`/`ro_in`). Reported time is the
  max of the three threads' page-cache time plus one sequential fsync pass
  over all three files.
- **replay-c**: the v4 segment store — a directory of fixed-width files
  (`records.keys` 32 B sorted, `records.meta` 96 B, `records.digests` 160 B,
  `records.body`/`records.ident` heaps, sorted pair arrays `records.by_owner`/
  `records.by_name`/`adj.out`/`adj.in` (`u32,u32`), `records.by_kind`
  (`u16,u8,u16,u32`), `records.by_identity` (32 B + `u32`), `subjects.keys`
  (32 B sorted), `dictionaries.bin`), written by 10 threads partitioned by the
  top nibble of `record_id` (contiguous by construction once the whole set is
  sorted by `record_id`) for the `records.*` files, plus 6 more threads
  building the secondary sorted index arrays concurrently (those need a
  full-set sort, so they don't partition by nibble the way the primary files
  do). Read back with `memmap2` + manual binary search (no `#[repr(C)]`/struct
  casts — fields are decoded at explicit byte offsets, so there are no
  alignment requirements on the mapped bytes). `fjall` was **not** tried: not
  in the local cargo cache, and time-boxing an unfamiliar LSM engine into this
  spike wasn't worth it given the plain segment-store numbers below already
  settle the decision.

**One real bug found and fixed live**: the first replay-c implementation
issued one `write_at` syscall per row for the body/identity heaps (on top of
the batched per-partition writes already used for keys/meta/digests) — up to
~4.4M extra syscalls for the FULL set. Since `body_off`/`ident_off` are a
global prefix sum over the sorted row order, each nibble-partition's rows
occupy one *contiguous* byte range in `records.body`/`records.ident`; batching
each partition's heap bytes into one buffer and issuing a single `write_at`
per file per partition cut FULL-set page-cache time from ~11.6 s (median) to
~2.3 s (median) — a ~5x change to the reported number, which is why it's
called out here rather than folded in silently. All replay-c numbers below
are post-fix.

## Idle-check protocol followed

Two other agents' benchmarks (`n8n-incremental-preflight.mjs`, 14,083-owner
and 2,000-owner runs, plus their `urdira-indexing-worker` children) were
active when this task started (load average ~7.3/10 cores). `load` and the
Node extraction are not timed measurements, so they ran regardless. Before
each of the three timed replay batches (`replay-a`, `replay-b`, `replay-c`)
`pgrep -f "urdira-indexing-worker|n8n-incremental-preflight"` was checked and
returned 0 matching processes each time — both other jobs had finished
naturally by the time timed measurements started. No waiting loop was needed;
none of the numbers below are flagged as contended. `query` and `delta` ran
immediately afterward in the same idle window.

One self-inflicted process error, corrected before any numbers were taken:
a first `load` attempt was launched as a detached background job and the
agent stopped to "wait" for it — background jobs cannot wake a stopped agent.
The retry additionally deleted its own `relations.bin` input via an
overly-broad `rm -f *.bin` immediately before restarting, which the retry
then failed to open. Fixed by re-running the extraction script and re-running
`load` in the foreground; the log above (`load ... total wall time 29.8s`) is
from that successful foreground run.

## Replay timings (3 runs each; min / median; `cargo build --release`)

| target | set | page-cache min/median | durable min/median | bytes written |
|---|---|---:|---:|---:|
| A (single file) | FULL | 28.84 s / 28.99 s | 29.11 s / 29.56 s | 3,786,129,408 |
| A (single file) | NODIAG | 22.71 s / 23.39 s | 23.33 s / 23.64 s | 3,205,611,520 |
| B (sharded x3) | FULL | 18.45 s / 19.72 s | 18.50 s / 19.75 s | 4,220,289,024 |
| B (sharded x3) | NODIAG | 15.59 s / 17.67 s | 15.65 s / 17.70 s | 3,540,860,928 |
| C (segment store) | FULL | 1.53 s / 2.28 s | 1.63 s / 2.44 s | 3,118,979,142 |
| C (segment store) | NODIAG | 0.83 s / 0.89 s | 0.97 s / 1.04 s | 2,627,845,292 |

(NODIAG C's third run was an outlier — 2.94 s / 3.15 s against 0.83–0.89 s /
0.97–1.04 s for the other two — kept in the min/median as-is rather than
discarded; noted here so the spread is visible.)

Against the brief's thresholds (NODIAG set): **C clears both** (≤2 s
page-cache: 0.89 s median; ≤5 s durable: 1.04 s median) by a wide margin. A
and B both miss their own fallback thresholds by 2–4x (A: ≤12 s durable vs.
23.6 s measured; B: ≤8 s vs. 17.7 s measured) — sharding into three files
buys real time (B beats A by ~35–40%) but a per-row SQLite insert loop is the
dominant cost either way, and no amount of file-splitting removes that.

## Query latencies (100 samples per category, same sample set across A/B/C; µs)

Sample keys (which record/owner/name/subject to look up) are drawn once from
the NODIAG or FULL row cache with a fixed seed, so all three targets answer
the *same* 100 queries per category — not three independent random draws.

NODIAG set:

| category | A p50/p95 | B p50/p95 | C p50/p95 |
|---|---:|---:|---:|
| by_record_id | 370 / 669 | 361 / 543 | 567 / 7,267 |
| by_owner | 336 / 661 | 315 / 647 | 2,175 / 76,695 |
| by_name | 502 / 14,602 | 445 / 11,042 | 303 / 894 |
| adjacency_out | 109 / 440 | 117 / 335 | 355 / 891 |
| adjacency_in | 113 / 366 | 118 / 229 | 331 / 1,251 |
| selector (entity+jsts:entity_variable, LIMIT 1000) | 55 / 57 | 55 / 58 | 204 / 226 |
| visible_count | 81,658 / 146,960 | 70,745 / 73,487 | 4,501 / 4,948 |
| two_hop | 111 / 2,562 | 102 / 2,147 | 1 / 4,614 |
| open (fresh process) | 0.73 ms | 1.29 ms | 0.96 ms |
| first query | 1,552 µs | 1,362 µs | 55,528 µs |

FULL set: same shape (A/B open ~4–5 ms; C open ~2.9 ms); C: by_record_id 547/1,007,
by_owner 3,485/105,080, by_name 252/1,020, adjacency_out 365/732, adjacency_in
313/758, selector 207/244, visible_count 5,761/6,346, two_hop 1/1,980. A/B
land in the same range as NODIAG (visible_count is the one category that
scales with row count for all three targets: ~97–100 ms for A/B FULL vs.
~70–82 ms NODIAG; ~5.8 ms for C FULL vs. ~4.5 ms NODIAG).

Against the brief's "≤2 ms p50" bar (NODIAG): **6 of 8 C categories clear it
comfortably** (many under 600 µs), but **by_owner (2.18 ms) and visible_count
(4.50 ms) exceed it**. Both trace to a specific, narrow cause rather than a
structural problem with segment stores:

- `by_owner`/`by_name`/`adj.out`/`adj.in` are `(key, row_ordinal)` pairs with
  no `valid_to` inlined (matching the brief's literal `(u32,u32)` shape), so
  every matching row needs a second random read into `records.meta` just to
  check visibility. A's `ro_owner` index is `(owner_artifact,
  valid_from_generation, valid_to_generation)` — an index-only range scan,
  no second read. Inlining `valid_to` (and `valid_from`) into the pair arrays
  would remove this extra hop; not implemented here due to time-boxing, but
  it's a layout change, not a re-architecture.
- `visible_count` in C is an O(n) linear scan of `records.meta` checking
  `valid_to==0` at every row — cheap per-row (a mmap'd byte read, no B-tree
  traversal) but still O(n). It is already 15–21x faster than A/B's
  `COUNT(*)` (which also full-scans, just through a B-tree), but a maintained
  running visible-count (updated incrementally by `delta`, not recomputed by
  `query`) would remove the scan entirely. Also not implemented here.

A's and B's own worst category (`visible_count`, 70–100 ms) is 15–100x C's
worst category — the query picture, even with the two gaps above, favors C by
a wide margin everywhere it matters.

## Delta (one simulated edit: close one random owner's rows at generation 2, insert the same count fresh)

| target | set | owner rows | elapsed |
|---|---|---:|---:|
| A | FULL | 594 | 1,472.6 ms |
| A | NODIAG | 127 | 349.2 ms |
| B | FULL | 594 | 1,502.6 ms |
| B | NODIAG | 127 | 425.4 ms |
| C | FULL | 594 | 11.2 ms |
| C | NODIAG | 127 | 7.1 ms |

(~127–594 rows for one owner is in line with the brief's "~228 rows"
estimate — average rows/owner in this corpus is 3,192,089 / 14,235 ≈ 224; a
uniformly-random owner naturally varies around that.) Against the ≤50 ms bar:
**C clears it by 4–7x** (7.1–11.2 ms); A and B miss it by 7–30x. C's
`delta-2/` directory holds only the new rows in the same file layout as the
base store, plus a `closures.records` (`key32,u32`) file naming the closed
record ids, fsynced independently of the (untouched) base segment files. A/B
pay for an `fsync` against their multi-GB base file even though only a few
hundred rows changed.

## Decision

**Path N (v4 segment store).** Build-time and delta both clear their
thresholds by wide margins on the NODIAG set (the v4 target row shape); query
latency clears 6 of 8 categories comfortably and the remaining two
(`by_owner`, `visible_count`) exceed the 2 ms p50 bar by a bounded,
understood amount with a named, narrow fix for each (inline `valid_to` in
the pair arrays; a maintained running visible-count) — neither implemented in
this spike due to time-boxing, both straightforward layout changes rather
than new architecture. Both SQLite-backed alternatives (A single-file, B
sharded) miss every one of their own fallback thresholds by 2–30x: a
per-row `INSERT` loop dominates build time regardless of file layout, and an
`fsync` against a multi-GB file dominates delta time regardless of how little
data actually changed. Sharding (B vs. A) helps build time by ~35–40% but
does not get either SQLite path within reach of its threshold, so there is no
version of "Path S" that this data supports over Path N.

## Caveats

- macOS gives no way to force a cold page cache without `sudo`; "durable"
  timings include an explicit `fsync`, but "query" timings are necessarily
  warm-OS-cache numbers (a fresh *process* each time, not a fresh *cache*).
  The brief's own protocol anticipates this ("cold page cache is not
  achievable on macOS without sudo").
- Query and delta ran against stores built by the *last* of the three replay
  runs for each target/set (replay output is deterministic given the same
  cache input, so this is equivalent to using any of the three).
- `relation_kind_id` reuses `kind_id` (see simplifications above) rather than
  a separate dictionary; this has no bearing on the store-shape decision
  since it's the same design in all three targets.
- The two query gaps for C (`by_owner`, `visible_count`) are real
  measurements, not hand-waved — they are reported against the literal
  threshold and not rounded away, precisely because the fix for each is
  identified but not built in this spike.
- One data-quality finding (the 81 bare `record:` sentinel rows in
  `artifact_dependencies`) is real v3 production data, not a spike artifact;
  worth a note for whoever designs the v4 `artifact_dependencies` migration.

## Commands (for reproduction)

```
cargo build --release -p urdira-v4-spike
cargo clippy -p urdira-v4-spike -- -D warnings   # clean
cargo fmt -p urdira-v4-spike --check             # clean

node scripts/v4-spike-extract-relations.mjs <v3.sqlite> spike/relations.bin
./target/release/urdira-v4-spike load <v3.sqlite> spike/relations.bin spike/

./target/release/urdira-v4-spike replay-a spike/full.bin   spike/deps_full.bin   spike/replay-a-full.sqlite
./target/release/urdira-v4-spike replay-a spike/nodiag.bin spike/deps_nodiag.bin spike/replay-a-nodiag.sqlite
./target/release/urdira-v4-spike replay-b spike/full.bin   spike/replay-b-full
./target/release/urdira-v4-spike replay-b spike/nodiag.bin spike/replay-b-nodiag
./target/release/urdira-v4-spike replay-c spike/full.bin   spike/replay-c-full
./target/release/urdira-v4-spike replay-c spike/nodiag.bin spike/replay-c-nodiag

./target/release/urdira-v4-spike query a spike/nodiag.bin spike/replay-a-nodiag.sqlite
./target/release/urdira-v4-spike query b spike/nodiag.bin spike/replay-b-nodiag
./target/release/urdira-v4-spike query c spike/nodiag.bin spike/replay-c-nodiag

./target/release/urdira-v4-spike delta a spike/nodiag.bin spike/replay-a-nodiag.sqlite
./target/release/urdira-v4-spike delta b spike/nodiag.bin spike/replay-b-nodiag
./target/release/urdira-v4-spike delta c spike/nodiag.bin spike/replay-c-nodiag
```
