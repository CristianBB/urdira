# Decision 26: v4 immutable segment structural store

Status: **Accepted**
Last updated: 2026-09-09
Depends on: [Storage and projection architecture](05-storage-projection-architecture.md), [Content-derived record identity](11-content-derived-record-identity.md), [Transactional projection digests](13-transactional-projection-digests.md), [Native pipeline and relational storage](21-native-pipeline-relational-storage.md), [v3 optimization](22-v3-optimization.md), [Index pack](23-index-pack.md), [Rust native acceleration](25-rust-native-acceleration.md)
Related: decisions [27](27-v4-merkle-bucket-digests.md), [28](28-v4-rust-semantics-and-residual-checker.md), [29](29-v4-rust-owned-scan-pipeline.md) own the parts of this system they specify (digests, semantics, scan orchestration)

## Current state (2026-09-09)

Implemented and the default for newly added workspaces since 2026-09-04
(opt out with `URDIRA_V4=0`; see `versioning.md`). Cold base write is
partitioned (P2-2j), delta generations are single-file containers (P3-6),
facet names and subject text live in the store's dictionaries (P2-2e),
`entities.index` is a persisted, mandatory section since format 6 (F4 4.3).
RSS gate (≤ 3 GiB) is **not met**: median 6.11 GiB at n8n, 14.18 GiB at VS
Code (`docs/evidence/2026-09-07-v4-vscode-campaign.md` §1.1 — RSS scales
close to linearly with corpus size in this range). The writer's own ≤ 2.5 s
target is also not met (final `write_ms` 5.83-8.41 s at n8n). The P2-2m
`identity_key`-zeroing corruption reported as an open critical bug through
2026-09-05 is **fixed** — see "Open items" below.

## Context

Urdira v3 stores the structural corpus (records, facets, identities,
dependencies, graph edges) as SQLite tables and publishes candidates through
a TypeScript/Rust-composed writer (decisions 21, 22, 25). At n8n scale
(14,083 owners, 3,192,089 `record_occurrences`, ~82 MB source), the owner
decided (2026-09-02) that cold indexing must be "indexed and queryable in a
few seconds" and that incremental publish must be durable in under a second
for edit, create, delete, and rename — destructively, without migration. A
Merkle-digest optimization already in memory could only remove ~2.8 s of a
9.9 s edit; the owner authorized moving the entire pipeline to Rust and
replacing the SQLite structural tables with a purpose-built, immutable,
mmap-served segment store, keeping SQLite only for the catalog, snapshots,
control-plane, lexical FTS, and vectors.

Before writing production code, a measured spike (`docs/evidence/2026-09-02-v4-p0-s1-store-floor.md`,
crate `crates/urdira-v4-spike`) compared three physical stores against the
real n8n v3 index (2,494,896 records after dropping checker-only
diagnostics, "NODIAG" set): a single SQLite file (A), SQLite sharded across
three files (B), and a directory of fixed-width segment files read back by
`memmap2` + manual binary search (C, "Path N"). Median measured results:

| Target | build (page-cache / durable) | delta (one owner's ~127-594 rows) | query p50 clearing 2 ms bar |
|---|---:|---:|---|
| A (1 SQLite file) | 22.71 s / 23.33-23.64 s | 349.2 ms | 6/8 categories, `visible_count` 70.7-146.9 ms |
| B (3 SQLite files, 3 threads) | 15.59-17.67 s / 15.65-17.70 s | 425.4 ms | 6/8 categories, `visible_count` 70.7-100 ms |
| C (segment store, 10 threads) | 0.83-0.89 s / 0.97-1.04 s | 7.1 ms | 6/8 categories at once; `by_owner` (2.18 ms) and `visible_count` (4.50 ms) exceeded the 2 ms p50 bar by a bounded, understood amount |

C cleared its build/delta thresholds by a wide margin; A and B missed their
own fallback thresholds by 2-30x (a per-row `INSERT` loop dominates build
time regardless of file layout, and an `fsync` against a multi-GB file
dominates delta time regardless of how little data changed). The two C
query gaps had a named, narrow cause each — no inline `valid_to` in the
`by_owner`/`adjacency` pair arrays (forcing a second random read to check
visibility), and an O(n) linear scan for `visible_count` — neither
implemented in the spike, both fixed in the production crate (§4 below).
No version of "Path S" (SQLite) was supported by this data at any file
layout; the owner's numeric target is reachable only with the segment store.

## Decision

Urdira v4 (`index_contract` `0x34`) replaces the v3 structural SQLite tables
with an immutable, per-generation segment store: `crates/urdira-structural-store`
(design, evidence: `docs/evidence/2026-09-02-v4-p2-3-structural-store.md`),
written and read exclusively from Rust, exposed to the daemon through a napi
read path and a query port. SQLite remains the catalog, snapshot,
control-plane, and lifecycle authority, plus two sidecar files for lexical
FTS and semantic vectors.

### Directory layout

Per workspace (today, siblings of the existing flat `<safeId>.sqlite` file,
not yet the plan's own `<data_root>/workspaces/<ws>/` subdirectory — see
"Open items"):

```
<safeId>.sqlite               catalog: workspace_meta, source_artifacts, artifact_versions,
                               content_blobs, source_observation*, artifact_tombstones,
                               source_index_state, snapshots, workspace_current_state,
                               control_plane_state, registry_*, candidate_state,
                               candidate_issues, candidate_publication_journal,
                               generation_manifests, merkle_roots, plus the generic
                               lifecycle/GC/retention tables StorageMaintenance still reads
<safeId>.structural/           the segment store (this decision)
  MANIFEST                     published JSON manifest
  MANIFEST.next                same shape, written before the durable fsync pass
  base-<g>/                    full segment set from the last cold write or compaction
  delta-<g>.seg                one generation's opened rows + closures, as ONE container
                               file since P3-6 (was a delta-<g>/ directory of up to 18 files;
                               no reader for the old layout — v4 is unreleased)
  merkle/records.tree          BucketedMerkleSet persistence (decision 27)
  merkle/dependency.tree
  merkle/graph.tree             persisted directly by the v4 scan pipeline (not tracked
  merkle/metric.tree             by this crate's own MANIFEST — see "Deviations")
  .readers/<pid>-<nonce>-<time>  reader refcount markers (compaction safety)
<safeId>.lexical.sqlite        lexical_documents, lexical_fts, lexical_index_state
<safeId>.semantic.sqlite       vector_projection_rows, vector_shards, semantic_index_state
```

### Per-table files and the 64-byte header

Every segment file except `MANIFEST`/`MANIFEST.next` starts with a common
64-byte header, little-endian: magic `"URD4"` (4 B), `format` (`u16` = `6`
as of the 2026-09-05 "frente 4" residual-tsgo session (`entities.index`,
below), `5` from the "group A" campaign earlier the same day, `4` before it
— see the format-bump note below), `table_id` (`u16`: `Records=1`, `Dependencies=2`, `Dict=3`,
`SubjectsKeys=4`, `PendingSites=5`), `row_count` (`u64`), `generation`
(`u64`), `xxh3` of the data region after byte 64 (`u64`), 32 B reserved. For
the five hot `records.*` sections (`records.keys`/`records.meta`/
`records.digests`/`records.body`/`records.ident`), that `xxh3` is not a
single hash over the whole re-mmap'd region: it combines the 16
per-nibble-partition xxh3 hashes the partitioned writer already computed
while writing (`write_base_partitioned`), concatenating their
little-endian bytes in nibble order and hashing that concatenation — a
nibble with no rows is skipped (needed for a store with fewer than 16
populated nibbles). This avoids a second full re-mmap-and-hash pass after
the partitioned write (`crates/urdira-structural-store/src/segment_io.rs`).

| File | Content | Stride |
|---|---|---:|
| `records.keys` | `record_id` (32 B), sorted ascending | 32 |
| `records.meta` | fixed row: `owner_artifact u32`, `owner_version u32`, `valid_from u32`, `valid_to u32` (0=open), `category u8`, `kind_id u16`, `universal_kind_id u16`, `facets u64` (bitmask), `span_artifact_version u32`, `span_start_byte u32`, `span_end_byte u32`, `span_start_line u32`, `span_end_line u32` (1-based, UTF-16 code units, since the 2026-09-05 line-numbers task — every producer now populates these via a shared per-file `LineIndex`; both fields stay OUT of the record digest, same treatment as every other derived-not-canonical field, so a line value can never change a record's digest), `identity_type u8`, `assignment_kind u8`, `name_id u32`, `source_subject u32`, `target_subject u32`, `relation_kind_id u16`, `body_off u64`, `body_len u32`, `ident_off u64`, `ident_len u32`, `identity_layout u8` (byte 89, since the 2026-09-05 campaign: `RAW=0`/`ENTITY=1`/`RELATION=2`/`RELATION_NO_SPAN=3` — see below), `entity_kind u8` (byte 90, ordinal into `dict.bin`'s `entity_kinds` list, `255`="not applicable") (91 B used, 96 B stride) | 96 |
| `records.digests` | `record_digest`, `body_digest`, `identity_id`, `identity_key_digest`, `previous_record_id` (32 B each, zero when absent) | 160 |
| `records.body` | heap: byte-identical UCE bodies | variable |
| `records.ident` | heap: UTF-8 identity-key text — since the 2026-09-05 campaign, populated ONLY for rows whose `identity_layout` is `RAW` (byte 89 == 0, `ident_len` == 0 otherwise); at n8n scale this is 1.66% of all rows (36,113 of 2,174,446), 9 MB instead of the pre-campaign 611 MB, because an `ENTITY`/`RELATION`/`RELATION_NO_SPAN` row's identity key is reconstructed on read from its own typed fields instead (see below) | variable |
| `records.by_owner` | `(owner_artifact u32, valid_from u32, valid_to u32, ordinal u32)`, sorted by `owner_artifact`, **inline validity** | 16 |
| `records.by_name` | `(name_id u32, ordinal u32)`, sorted, no inline validity | 8 |
| `records.by_kind` | `(universal_kind_id u16, category u8, kind_id u16, ordinal u32)`, sorted | 9 |
| `records.by_identity` | `(identity_key_digest 32 B, ordinal u32)`, sorted; includes closed rows (identity chaining) | 36 |
| `adj.out` / `adj.in` | `(subject_ordinal u32, valid_from u32, valid_to u32, ordinal u32)`, sorted, **inline validity** | 16 |
| `entities.index` | `(owner_artifact u32, span_start u32, ordinal u32)`, sorted by `(owner_artifact, span_start)`, no inline validity — since the 2026-09-05 "frente 4" session (F4 4.3); mandatory in every base/delta this crate writes (format 6), unlike `pending.sites`/`dict.bin`/etc.'s "absent if empty" convention. Exactly the `CATEGORY_ENTITY` rows, excluding `jsts:entity_inferred_type` (an inferred-type row deliberately shares its declaration's own `(owner, start)` key — see `segment_io::is_entities_index_row`) | 12 |
| `deps.keys` | `dependency_id` (32 B), sorted — a deliberate addition beyond the plan's own sketch (a delta's `closures.deps` needs a standalone key to name which dependency edge closed) | 32 |
| `deps.meta` | `record_ordinal u32` (`u32::MAX` = the bare `record:` sentinel v3-data quirk), `owner_artifact u32`, `owner_version u32`, `dep_artifact u32`, `dep_version u32`, `role u8`, `valid_from u32`, `valid_to u32` (29 B used, 32 B stride) | 32 |
| `deps.reverse` | `(dep_artifact u32, ordinal u32)`, sorted | 8 |
| `closures.records` / `closures.deps` (delta only) | `(key 32 B, valid_to u32)`, sorted by key | 36 |
| `pending.sites` | fixed row (40 bytes, 38 used, 2 reserved), since decision 29's fold campaign: `owner_artifact u32`, `owner_version u32`, `valid_from u32`, `valid_to u32`, `start u32`, `end u32`, `start_line u32`, `end_line u32`, `site_kind u8`, `reason u8`, `source_subject u32` (`NONE_U32`=None) — see decision 29 for the full contract | 40 |
| `dict.bin` | framed body: NINE length-prefixed lists (up from seven pre-campaign) — `kinds`, `universal_kinds`, `relation_kinds`, `names`, `artifacts` as `(artifact_id, artifact_version_id)` text pairs, `facet_names` (indexed by the bit position of `records.meta.facets`, sourced from the plugin's `entityFacets`/`relationFacets` via the `FACET_ORDER` constant, since P2-2e), `subject_text` (aligned by ordinal to `subjects.keys`, `"record:<hex>"`, since P2-2e), and, since the 2026-09-05 campaign (A3a-fix), `artifact_paths` (indexed by `owner_artifact`, the artifact's own path text — needed to reconstruct an `ENTITY`/`RELATION` row's identity key without touching `records.ident`) and `entity_kinds` (the vocabulary of FINE per-declaration kind words, e.g. `"method"`, distinct from the five coarse `UniversalKind` buckets `kind_id` uses — a `records.meta.entity_kind` byte indexes into this list); every new list is appended at the END of the framed body so an older reader simply stops decoding one list earlier and leaves the rest unread; the base directory's copy is the full dictionary, a delta's copy holds only that generation's additions | variable |
| `subjects.keys` | framed body: length-prefixed list of 32-byte subject keys, same append-only-per-generation split as `dict.bin` | variable |

**Identity-key reconstruction (A3a/A3a-fix, `identity_codec.rs`, since the
2026-09-05 campaign, format bump 4→5, no migration — a format-4 store fails
to open with a clear error and the daemon reindexes from scratch)**:
`records.meta`'s `identity_layout` byte (89) records whether
`records.ident`'s `ident_off..ident_off+ident_len` bytes hold this row's
real identity key verbatim (`RAW`=0, the only layout a pre-campaign store
ever wrote, `ident_len` > 0) or whether the key is instead reconstructed
losslessly from this row's own typed fields, with nothing stored in
`records.ident` (`ident_len`==0): `ENTITY`=1
(`jsts:{kind}:{path}:{start}:{name}`, `{kind}` from `entity_kind`'s
`dict.bin` lookup, `{path}` from `artifact_paths[owner_artifact]`), `RELATION`=2
(`jsts:{rel}:{path}:{start}:{end}:{source_identity_key}:{target_identity_key}`,
the two endpoints resolved one level deep via `dicts.subjects` -> `record_id`
-> that record's own `identity_key()`), `RELATION_NO_SPAN`=3
(`jsts:{rel}:{source_identity_key}:{target_identity_key}`, no
`{path}:{start}:{end}` segment, e.g. `jsts:contains:...`). At n8n scale:
98.34% of all rows classify as `ENTITY`/`RELATION`/`RELATION_NO_SPAN`
(370,285 / 1,768,048 / 0 of 2,174,446), only 1.66% (36,113 — external/type-of/
diagnostic/v3-converted identities, or a relation whose endpoint is not
resolvable) still need `RAW`. See `docs/evidence/
2026-09-05-v4-group-a-cold-lines-references.md` §4 for the measured
byte-size effect (`records.ident` 611 MB → 9 MB).

**`entities.index` as a persisted section (F4 4.3, format bump 5→6, no
migration).** Before this, mapping a residual pass's resolved call/heritage
TARGET (an `(owner_path, name_identifier_start)` pair) back to a store
entity required `urdira-indexing-worker`'s `v4::residual::collect` to run a
full `iter_visible(generation)` scan of the WHOLE corpus on every residual
attempt, filtering to `CATEGORY_ENTITY` and excluding `jsts:entity_
inferred_type` (an inferred-type row deliberately carries the SAME `path`/
`start` as the declaration it types, so it must never win that key's slot —
see the exclusion's own rationale, unchanged by this section). This section
makes that lookup O(sites) instead of O(corpus): a sorted array of
`(owner_artifact u32, span_start u32, ordinal u32)` triples, written
alongside `by_name` in both the base writers
(`segment_io::write_hot_and_secondary_files[_partitioned]`) and the delta
writer (`writer::build_delta_sections`), filtered by the same rule
(`segment_io::is_entities_index_row`/`inferred_type_kind_id`) so all three
writers apply the exclusion identically. Read side: `StoreReader::entity_
by_owner_and_start(owner, start, generation)` binary-searches each
segment's own array for the key — `(owner_artifact, span_start)` is
expected unique among LIVE rows (enforced at write time by the inferred-
type exclusion, not by any uniqueness check across every historical row a
segment's array may still list), so a genuine collision among several
still-live entities at the exact same span (observed once in the shared
`task-planner` fixture, at `(owner, start=0)` — a pre-existing imprecision,
not introduced by this section) is resolved DETERMINISTICALLY rather than
by "whichever candidate the binary search range happens to enumerate
first" (the original P4-review draft of this rule, replaced before this
decision's text settled — revision fix, 2026-09-05): every segment is
scanned (not just the newest), and among every VISIBLE candidate sharing
the key the winner is picked by, in order, (1) the greatest `valid_from`
(the most recently OPENED row), (2) on a tie, the NEWEST segment
(`StoreInner::segments`' own newest-first ordering), (3) on a further tie
(two rows in the very same segment's own key range), the greatest
`ordinal`. This is arbitrary but STABLE across repeated calls against the
same snapshot, unlike an order that depends on binary-search/sort
internals — see `crates/urdira-structural-store/tests/entities_index_test
.rs::entity_by_owner_and_start_breaks_ties_deterministically` for both
tie-break levels exercised directly, and `urdira-indexing-worker`'s
`entities_index_section_and_scan_agree_on_the_shared_fixture` for the
real fixture's own collision resolving identically through both the
`entities.index` section and the pre-4.3 full-scan path. The section is
**mandatory** in every base/delta this crate
writes from format 6 onward (unlike `pending.sites`/`dict.bin`/etc.'s
"absent when empty" convention) — `container::open_container` already
treats an unknown `SectionId` in a container's TOC as a hard error, so a
format-6 reader opening a format-5 store (missing the section entirely)
would otherwise silently degrade rather than fail cleanly; the format bump
(`layout::HEADER_FORMAT` 5→6, `Manifest::format` 5→6) makes that a same
clear-error-then-reindex contract the 4→5 bump already established, not a
new kind of failure mode. `urdira-tsgo-client::entity_index::EntityIndex`
itself (the generic, reusable `(path, name_start) -> id` in-memory index)
is UNCHANGED — still exactly what `urdira-tsgo-client`'s own tests build
directly from caller-supplied triples, with no dependency on this crate at
all (adding one would have inverted that crate's documented "does no I/O,
holds no store reference" boundary). The adapter lives instead in
`urdira-indexing-worker::v4::residual` as a private `EntityLookup` enum:
`Section` (default) resolves `path` to an `owner_artifact` ordinal via the
same `Frontier`-derived reverse map every other lookup in that module
builds, then calls `entity_by_owner_and_start` directly; `Scan` (`URDIRA_
V4_ENTITY_INDEX=scan`) keeps building the old `EntityIndex` from a full
scan, for comparison/debugging only. `collect()`'s own cost is therefore
now O(pending sites + owners in the frontier), not O(corpus).

**Two documented deviations from the plan's literal byte layout**: `facets`
is `u64` (the plan's table specified `u32`; the shipped crate widened it per
its own task brief), and `ident_len` is `u32` (the plan left this
unspecified; widened defensively since `identity_key` text is unbounded in
principle). `records.by_owner` and `adj.out`/`adj.in` inline `valid_from`/
`valid_to` — a deliberate widening beyond the plan's plain `(key, ordinal)`
pair sketch, done specifically to close the P0-S1 `by_owner` query gap
(measured, §"Context").

Dictionaries are ordinal-stable across generations: a delta only appends, it
never renumbers. `subjects.keys` stores raw 32-byte subject **keys**
(`record_id`s, for the v4-produced pipeline — see decision 29), never text.
Facet names and subject text are recoverable from `dict.bin` alone since
P2-2e: before that, `to_output`'s `facet_rows` came exclusively from the
converter-only `text_sidecar.json`, so every record of a real v4 scan
reported empty `facets` (found and fixed in
`docs/evidence/2026-09-04-v4-p2-2e-typeflow-in-v4.md`, verified by a daemon
e2e test asserting non-empty facets on a class record). Cold dictionary
ordinals are assigned by **sorted key** since P2-2j, not first-seen owner
order — proven not to affect any record digest or Merkle root, since
`structural_record_digest_hash` never hashes an ordinal
(`docs/evidence/2026-09-02-v4-p2-2b-cold-pipeline.md` §16, correcting §15's
contrary assumption). `identity_id` text is still reconstructed from
`identity_type` + digest, not stored.

### Manifest, readiness, and recovery

`MANIFEST` is atomic JSON (write-tmp-then-rename): `{format:4, generation,
snapshot_id, base:"base-<g>", deltas:["delta-<g>", ...], roots:{records,
dependency}, dict_generation, files:{"<segment_dir>/<file>": {bytes, xxh3}}}`.
`MANIFEST.next` is written, published (`fsync` + directory `fsync` +
rename), and only then does `snapshots`/`workspace_current_state` gain a
SQLite row — the "queryable" (page-cache-visible) and "durable" (fsynced +
recorded) states are distinct concepts in the design, surfaced to the daemon
as `IndexingEvent::Queryable{generation, manifest_path, timings}` and
`IndexingEvent::ScanCompleted{generation, snapshot_id, roots, timings}` (see
decision 29). **As currently implemented**, `SegmentWriter::write_base`
performs the page-cache write, the `fsync` pass, and the manifest publish
synchronously inside one call, so the two events fire back to back once
the whole write finishes (`docs/evidence/2026-09-02-v4-p2-2b-cold-pipeline.md`
§4.1); at n8n the cold gap is the snapshot transaction and event delivery
(`queryable_at` 27.3-30.0 s vs `completed_at` 29.6-32.3 s,
`docs/evidence/2026-09-05-v4-final-measurements.md` §4.1). The daemon does
now act on the live `Queryable` event (readiness update 5-7 ms after it,
P3-5 §2.3, decision 29), and the two fields are reported separately in
`core:index_status` (`structural.queryable_generation`/`durable_generation`,
`structural.queryable`, P4-d). Two of 22 daemon-observed incremental cycles
showed a 23.7 s and 29.0 s gap between the two events (final §4.4) — not
explained.

A reader resolves a key by binary search in the newest delta, then the next,
then the base; the first hit wins. Effective `valid_to` is the row's own
inline value, or a value derived from a per-store, in-memory map merged from
every delta's `closures.*` file at open time (bounded by the number of
closures since the last compaction). Visible-range queries (`by_owner`,
`adj.*`, `by_name`, `by_kind`) are consulted across every segment and merged,
filtering closed rows through the same maps. `visible_count`/
`deps_visible_count` are derived in `O(log n)` per segment (two sorted
`valid_from`/`valid_to` arrays built at open time, plus one global sorted
closure `valid_to` array), not by an `O(n)` scan — this is the fix for the
P0-S1 `visible_count` gap.

**`records.keys` vs. `deps.keys`/`pending.sites`: one closure map shape does
not fit both key spaces (frente E-P0, `docs/evidence/2026-09-06-v4-reconcile-threshold.md`,
plus this frente's own adversarial review, same day).** `record_id` is
*chained*: `diff::chained_record_id` mints a brand-new 32-byte id on every
replace/reopen/migration (`urdira-indexing-worker::v4::diff`), so a given
`record_id` can be opened by at most ONE physical row across the store's
entire history and closes at most once, ever. `record_closures` is
therefore a plain `HashMap<[u8; 32], u32>` (last-write-wins on merge is
unambiguous, since there is only ever one write per key). `dependency_id`
(`sha256("urdira:v4-dependency-id:v4\0" || owner_path || dep_path || role)`,
`urdira-indexing-worker::v4::deps`) and `PendingSiteKey`
(`owner_artifact`/`start`/`end`/`site_kind`) are the OPPOSITE: pure,
unsalted, content-addressed keys with no chaining at all — the identical
key is legitimately reused by a later physical row after an earlier one
under it was closed (an edge removed and later re-added; an unresolved
import that stays pending across many edits, or gets resolved and later
regresses). `dep_closures`/`pending_closures` are therefore `HashMap<key,
Vec<u32>>` — every closure EVER recorded against a key, not just the most
recent one — and the closure that applies to a specific physical row is the
smallest recorded value strictly greater than that row's own `valid_from`
(the closure immediately following this row's own open; two rows under one
key never overlap in time and a key can only be reopened after being
closed). Effective `valid_to` for a `deps.meta`/`pending.sites` row is thus:
`min({closed_at in dep_closures[key] | closed_at > row.valid_from})`, or the
row's own inline `valid_to` (0 = still open) if that set is empty.

A first cut of this fix (`ae61841`) kept `dep_closures`/`pending_closures` as
flat `HashMap<key, u32>` (one entry per key, last-write-wins), gated by
`valid_from` (`closed_at > valid_from` ⇒ apply it) — correct for a key
closed at most ONCE across the store's history, silently wrong for a key
closed TWICE or more: `open@1, close@3, reopen@5, close@7` collapses to one
merged entry `{key: 7}`, so a point-in-time read strictly between two of
the key's closures (e.g. generation 4) resolves the WRONG, too-late
`valid_to` — and, independently, `deps_visible_count`'s `O(log n)`
derivation subtracts one unit per **map entry**, not one unit per
**physically closed row**, so it overcounts live dependency edges at ANY
generation, including the CURRENT one (no historical query needed) whenever
a `dependency_id` was closed more than once. This is fixed by the
`Vec<u32>`-per-key scheme above (same-day adversarial review of `ae61841`,
`crates/urdira-structural-store/tests/deps_pending_closure_matrix_test.rs`);
no on-disk format change — `closures.deps`/`closures.pending`'s bytes are
unchanged (still `(key, valid_to)` pairs per delta), only the in-memory
merge and the effective-`valid_to` lookup changed. Cost: bounded by
"closures against that ONE key since the last `compact()`" — in the
documented worst case (a key touched on every delta since the last
compaction, e.g. `pending.sites`'s wholesale-replace-on-every-owner-touch
pattern), that is the plan's own compaction trigger bound (`deltas > 32`),
never corpus-sized.

A SAME-generation close+reopen of the identical key (the pre-frente-E-P0
`delta.rs` owner-granularity diff's own behavior for every "unchanged"
dependency edge, and `pending.sites`'s still-current wholesale-replace
behavior for every reprocessed owner) is a degenerate case of the same
formula, not a separate one: the strict `>` in `closed_at > valid_from`
means a row whose OWN `valid_from` equals the recorded closure is treated
as NOT closed by it (that closure belongs to its predecessor, whose
`valid_from` is strictly less), so the reopened row is visible starting
exactly at that generation. A store written by the pre-fix code (or by any
future producer that still emits this pattern) needs no reindex and no
`HEADER_FORMAT` bump (prohibited by the plan's R22) to be read correctly
under this scheme.

Recovery (`recover(dir)`) deletes `base-*`/`delta-*` directories not named
by `MANIFEST`, and if `MANIFEST.next` names a different generation than the
published `MANIFEST`, deletes that generation's directories and the `.next`
file. This diverges from the plan's own rule (which checks a SQLite
`snapshots` row for durability): the store crate has no SQLite dependency,
so the substitute rule is generation-equality with the published `MANIFEST`
— documented as a deliberate, narrower approximation
(`docs/evidence/2026-09-02-v4-p2-3-structural-store.md` §2.4). Integrity is
checked via the 64-byte header's `xxh3` at `verify_all()` and by sampling on
open; the persisted Merkle roots in `structural/merkle/*.tree` must agree
with `merkle_roots`/`snapshots` (decision 27).

### Compaction and reader refcount

`compact(dir, new_generation)` k-way-merges every visible row at
`new_generation` into a fresh `write_base` call and republishes with an
empty delta list. Every `StoreReader::open` drops a JSON marker at
`.readers/<pid>-<nonce>-<time>` naming the segment directories it mapped,
removed via `Drop` once the last in-process reference goes away;
`compact`/a future background compactor checks `refcount::segments_in_use`
(liveness via `kill -0`, shelled out, to keep `unsafe` scoped to
`memmap2::Mmap::map` only) before deleting a superseded generation's
directories. Verified live: a reader opened before `compact()` keeps its
directories un-deleted for as long as it is alive; the compaction test
covers 40 accumulated delta containers with identical roots and query
results (`docs/evidence/2026-09-03-v4-p3-6-delta-container.md` §1).

**Deviation from the plan**: rows closed before the retained generation are
dropped entirely during compaction rather than kept as a 36-byte
`by_identity` stub for identity-chain continuity across the compaction
boundary — a real structural addition judged out of scope for the P2-3
deliverable. `by_identity_last` therefore only sees identity history back to
the last compaction. The plan's own compaction trigger policy (`deltas > 32`
or `Σ rows delta > 5% of base`) is not evidenced as implemented — `compact`
provides the mechanism, not the scheduling.

### Writer: partitioned cold base, delta container, and the write-path floor

**Partitioned cold base (P2-2j, `docs/evidence/2026-09-02-v4-p2-2b-cold-pipeline.md`
§16).** `SegmentWriter::write_base_partitioned` takes exactly 16
nibble-partitioned, individually-sorted `Vec<RecordRow>` buckets instead of
one globally-sorted slice: per-partition byte offsets come from a local
prefix sum inside each partition's own rayon task; the six secondary sorted
indexes (`by_owner`, `by_name`, `by_kind`, `by_identity`, `adj.out`,
`adj.in`) are built by parallel `flat_map_iter` + `par_sort_unstable`; hot
files and secondary arrays are written under one `rayon::join`. The producer
side (`materialize_cold_partitioned`, decision 29) pushes rows straight into
the 16 buckets with no intermediate flat `Vec` and no global sort. Verified
byte-identical to the flat writer on 50,000 synthetic rows and root-identical
on 11 independent n8n cold scans; the flat path is kept only as the oracle.
Measured: materialize median 15,235 → 9,012 ms, `write_ms` median
5,230 → 4,075 ms. The writer's own ≤ 2.5 s target is not met (final
`write_ms` 5.83-8.41 s, final §4.1).

**Delta container (P3-6).** A delta generation is one `delta-<g>.seg` file:
a 64-byte container header, every logical section's blob (byte-identical to
the old standalone file: same `layout::FileHeader` + body), then a table of
contents `(section_id, offset, length, xxh3)`. Readers use
`segment_io::SectionSource` (`File(Mmap)` or `Container{mmap, start, end}`),
so every accessor is unchanged. `fsync_segment_dir` used to `sync_all()`
(macOS `F_FULLFSYNC`) once per file, up to 18 device flushes per generation;
now one. Merkle `.tree` slot writes run after the container fsync so data is
durable before the root pointing at it, and `BucketedMerkleSet::write_slots`
coalesces touched slots into contiguous ranges (decision 27). Measured
steady-edit `write_ms` 39-71 ms (hub edit 126 ms), `container_fsync` flat at
6-9 ms regardless of row count; empty `closures.*`/`dict.bin`/`subjects.keys`
sections are skipped (P3-3 §4). The mandatory hot-file count per base grew
from 14 to 15 with `entities.index` (F4 4.3, below); otherwise unchanged.

**Write-path bandwidth finding (P2-2l, §18.4).** With per-phase timers on a
representative cold run (`n = 2,831,264`, `records.body` 978 MB,
`records.ident` 700 MB): `header_hash` 2.80 s (body 2.80 s, digests 1.42 s,
ident 1.42 s, meta 1.01 s), `write_base_partitioned` 8.74 s total,
`to_page_cache` 8.56 s. The per-file mmap `xxh3_64` header hash runs at only
~300-455 MB/s here, while an isolated microbenchmark of the identical
`mmap_file`/`xxhash-rust` code path on the same machine reaches 4.85-9.2 GB/s —
a 14-20x gap, attributed (plausibly, not proven; no idle-machine re-run of
just this phase) to five header-hash jobs contending for memory bandwidth on
a loaded host. The lever considered — writing through an `MmapMut` to save
one memmove per byte — was **not shipped**: disjoint-range mutation across 16
rayon tasks needs `unsafe`, xxh3 has no combine-chunks operation, and the
estimated saving is ~1-2 s of a ~30 s cold scan.

**RSS status.** Target ≤ 3 GiB; measured 6.56 / 6.86 / 8.16 GB on the three
final production-path cold runs (final §4.1), 5.97-6.02 GiB post-materialize
peak in §18.6, 4.76-5.49 GiB in §16.7. Localized: post-catalog ~140-153 MiB
→ post-resolve 2.0-2.5 GiB is `syntax.analyze()` retaining every file's
`SyntaxFileResult` (deliberate — the incremental path resolves against
it); materialize adds 0.7-1.2 GiB (§15.5). A genuine fix (header hash over
mmap instead of double-buffering the whole `records.*` volume) did not move
the peak (§16.4); sorted-key dictionaries need the full owner set before
any ordinal can be assigned, which is in direct tension with streaming
`OwnerFacts`/ASTs out early (§16.4, next step recorded there); the typed
`facets_list` (P2-2l) adds a second representation of every record's facets
for the lifetime of `OwnerFacts.records`, a memory-for-CPU trade whose cost
was not bounded before shipping (§18.6). Removing possible/diagnostic rows
would save 0.2-1.7 GB (§16.3; decision 29, open item 4).

### Napi read path and query port

`crates/urdira-native-node/src/structural_store_napi.rs` exposes
`NativeStructuralStoreHandle` (`open`, `reopenIfChanged`, `currentGeneration`,
`dictionaries`, `recordsByIds`, `recordsByName`, `recordsByKindExact`,
`recordsByOwnerOrdinal`, `adjacency`, `changedBetween`, `visibleCount`,
`iterVisibleBatch`, `depsByOwner`, `depsReverse`, and, added by a P2-4
follow-up to close a verification gap, batched raw-digest iterators
`iterVisibleDigests`/`iterVisibleGraphDigests`/`iterVisibleDependencyDigests`)
and `NativeStoreBuilder` (write side, cold-only, used only by the v3→v4
test/oracle converter — see "Open items").
`packages/engine/src/native-query-snapshot-port.ts`'s
`NativeCanonicalQuerySnapshotPort implements CanonicalQuerySnapshotPort`
maps each of the 18 operations' underlying port methods onto this handle
(`records_by_ids`/`records_by_name`/`records_by_selector` → bsearch/range
scans on the ordinal indexes; `graph_edges_by_subject_ids`/
`relation_pairs_by_subject_ids` → `adjacency`; `records_for_query[_batches]`
→ `iterVisibleBatch`; everything catalog/FTS/vector-shaped — `artifacts_by_filter`,
`artifact_text`, `capability_states`, `search_literal`, `semantic_*` —
delegated to a wrapped `SqliteCanonicalQuerySnapshotPort`).
`records_by_ids` for the `identity_id`/`identity_key` forms, and
`records_by_selector` above a 512-combo cap, fall back to a full
visible-corpus scan (`O(corpus)`, correct but not indexed) —
documented gaps, not silent approximations
(`docs/evidence/2026-09-02-v4-p2-5-native-port.md` §3.2).
Port selection is per-workspace: the daemon reads `workspace_meta.structural_store`
(`"native"` vs. `"sqlite"`) AND checks that the sibling `.structural/`
directory actually exists on disk before routing to the native port,
falling back to SQLite otherwise (so a workspace mid-fork, whose catalog
already says "native", never hits a nonexistent-directory error).

### Sidecar SQLite files

Lexical FTS (`lexical_documents`, `lexical_fts`, `lexical_index_state`) and
semantic vectors (`vector_projection_rows`, `vector_shards`,
`semantic_index_state`) each live in their own SQLite file
(`<safeId>.lexical.sqlite`, `<safeId>.semantic.sqlite`), opened via
`WorkspaceDatabase.openSidecar(kind)`, with the FK to `artifact_versions`
necessarily dropped (cross-file FKs are not enforceable without `ATTACH`).
The daemon's query path `ATTACH`es both sidecars onto the same read-only
connection `SqliteCanonicalQuerySnapshotPort` uses for its fallback methods
(`core:search_text` otherwise fails outright with "no such table" on a v4
catalog, since those tables never existed there — fixed in
`docs/evidence/2026-09-02-v4-p2-7-daemon-wiring.md` §3). Lexical maintenance
runs in-process against the `ATTACH`ed sidecar (not through the threaded
worker — that is a documented follow-up); semantic maintenance is
deliberately **not wired for v4 at all**, because decision 17's entity-grain
lane reads `record_occurrences`/`record_value_nodes` directly, and those
tables do not exist in the v4 schema — `submitSemanticMaintenance` no-ops
for any v4 workspace rather than failing repeatedly.

### Catalog schema v4

`packages/storage/sql/workspace-v4.sql`: `workspace_meta.index_contract =
0x34`, `identity_format = 3` (`V4_IDENTITY_FORMAT`; the runtime's
`CURRENT_IDENTITY_FORMAT` stays at `2` until the P4 cutover — this constant
exists but is not yet load-bearing), `structural_store` meta value
(`"native"` | `"sqlite"`, read via `readStructuralStore`/written via
`writeStructuralStore`). Kept byte-identical to v3: the catalog tables
(`source_artifacts`, `content_blobs`, `source_observation_batches`,
`source_observations`, `artifact_versions` — plus one new nullable
`artifact_ordinal INTEGER` column — `artifact_tombstones`,
`source_index_state`, `registry_*`, `snapshots` (same 20 columns),
`workspace_current_state`, `control_plane_state`, `candidate_state`,
`candidate_issues`, `candidate_publication_journal`, `generation_manifests`)
and the generic lifecycle/GC/retention machinery `StorageMaintenance.verify`/
`.collect` still reads (`retention_leases`, `retention_pins`,
`snapshot_expiration_markers`, `lifecycle_cas_pins`, `lifecycle_roots`,
`query_executions`, `query_manifest_segments`, `backup_barriers`,
`garbage_collection_epochs`, `garbage_collection_candidates`). Added:
`merkle_roots(set_kind, generation, root, member_count)` (see decision 27).

Dropped entirely, and **why** (measured — the "Context" section's numbers):
`record_occurrences`, `record_facets`, `record_value_nodes`,
`identity_assignments`, `graph_edges`, `artifact_dependencies`,
`metric_projections`, `projection_occurrences`, `set_merkle_nodes`, every
`candidate_publication_*` (10 tables), `candidate_staged_*` (4 tables),
`candidate_fact_delta*` (3 tables), plus the work-manifest/materialization/
lookup-dependency/retention-lease/value-node tables that only ever staged
rows destined for those tables (`candidate_work_manifests`,
`candidate_fact_deltas`, `candidate_fact_delta_namespaces`,
`candidate_fact_delta_batches`, `candidate_materializations`,
`candidate_lookup_dependencies`, `candidate_retention_leases`,
`candidate_roots`, `candidate_cleanup_markers`, `candidate_value_nodes`,
`projection_occurrence_dependencies`, `projection_value_nodes`), and
`storage_migrations` (v4 has no in-place migration path — see the v4
versioning note in `docs/versioning.md`). None of these are read by
`verify`/`repair`/`collect`; all of their logical content now lives in the
segment store described above.

### Fork and pack by file copy

Because `record_id`/`record_digest`/`identity_id`/`dependency_id` in v4 are
derived only from record content (`crates/urdira-native-core`'s
`structural_kernel_row` family — `workspace_id` never enters any of those
hashes), the entire `structural/` corpus is valid, byte-for-byte, under any
`workspace_id`. A v4 fork (`forkV4Workspace`, additive section in
`workspace-fork.ts`) is therefore a plain recursive file copy plus a
Merkle-root re-verification and a generic, schema-driven `workspace_id`
substring rewrite across the catalog — **not** the record-by-record remap
decision 12 requires for v3. An index pack for v4 (`exportV4IndexPack`/
`importV4IndexPack`) uses a new, separate binary container
(`urdira-index-pack-v4`, schema version 1) rather than reusing decision 23's
gzip/NDJSON row carrier, because v4 has no per-row representation of its
structural corpus at all — it is a binary mmap segment store. Both
additions are self-contained, tested end to end against real
Rust-produced v4 workspaces (their v4 sections reached 100% line coverage
in P4-b-1, `docs/evidence/2026-09-04-v4-p4-b-prep-health.md`), and **not yet
wired into any daemon RPC or into the v3 fork/pack orchestration** — that
integration (fork-eligibility policy, workspace registration, path
selection) is left for whoever wires v4 daemon routing further
(`docs/evidence/2026-09-03-v4-p2-4-digest-contract.md` §3.1). Verify, fork,
and pack were not exercised in the final measurement session (final §6).
A `merkle/<set>.tree` file is a fixed ~35.8 MB regardless of corpus size,
so even the smallest fixture's pack is ~140 MB before compression.

## Consequences

- Cold build and single-owner delta both clear their P0-S1 thresholds by a
  wide margin on real n8n data; the two identified query gaps (`by_owner`,
  `visible_count`) are fixed in the production crate and independently
  re-measured clearing their targets by 130-180x and ≥1000x respectively
  (`docs/evidence/2026-09-02-v4-p2-3-structural-store.md` §4.3). In the
  full production pipeline at 2,831,264 records the store's own share of a
  cold scan is `write_ms` 5.8-8.4 s + `fsync_ms` 0.17-0.19 s + `snapshot_ms`
  4-10 ms, and a steady incremental delta is 39-126 ms end to end
  (final §4.1, P3-6 §1).
- SQLite (single-file or sharded) is conclusively **not** viable as the v4
  structural authority at this scale; the "Path S" fallback DDL in the plan
  was never built as production code because P0-S1 already settled the
  decision.
- A workspace's structural corpus is portable and fork/pack-friendly by
  construction, without any record remap — a stronger property than v3's
  content-derived-identity-plus-remap model (decision 11, decision 12).
- v3 and v4 never share a writable data root or a reader; the boundary is
  the same destructive, non-migrated one decision 22 already establishes for
  v3, extended by `index_contract 0x34` (see `docs/versioning.md`).

## Open items (reported, not resolved)

- **RSS ≤ 3 GiB not met** — see "RSS status" above; the remaining levers
  are architectural (streaming vs sorted-key dictionaries) or an owner
  decision on record volume.
- **Writer ≤ 2.5 s not met** (5.83-8.41 s at 2.83M rows); the bandwidth
  floor is attributed but not proven, and no idle-host certification of
  `write_base_partitioned` exists (§18.4; earlier P2-3b caveat unchanged).
- **Text sidecar** is now a fallback only: facet names and subject text come
  from `dict.bin` (P2-2e); `identity_id` from `identity_type` + digest;
  `NativeStoreBuilder` still writes `text_sidecar.json` for the converter
  path. Folding the builder away is P4 deletion work.
- **Dictionary ordinal churn on edits.** An owner's `dicts.artifacts`
  ordinal is not stable across a content edit — every edit opens a new
  `artifact_version_id` and mints a fresh ordinal rather than reusing the
  file's previous one (no query-visible effect today, but a real ordinal-space
  growth pattern; `docs/evidence/2026-09-03-v4-p3-1-incremental.md` §4/§11).
- **Compaction thresholds and identity-chain stubs** are not implemented —
  only the merge/republish/refcount mechanism is (see "Compaction" above).
- **`MANIFEST.roots` tracks only `records`/`dependency`.** `graph` and
  `metric` roots are computed and persisted to their own `.tree` files and
  to the `merkle_roots` SQL table directly by the v4 scan pipeline
  (decision 29), not by this crate's own manifest — an asymmetry inherited
  from `urdira-structural-store` treating adjacency purely as an index over
  relation records (`docs/evidence/2026-09-02-v4-p2-3-structural-store.md`
  §1.4). The mutation harness's oracle compares only those two sets for
  the same reason (P3-4).
- **Record volume (owner decision).** Possible relation rows and their
  paired `jsts:unresolved_call` diagnostics are 1,276,972 of the 2,831,264
  records (45%); the store scales sub-linearly with them (+1.7-2.4 s
  materialize, +1.1-1.8 s write, §16.3) but they are the largest single
  lever left on every cold gate (decision 29, open item 4).
- **3 undecodable record bodies** (zero-filled payloads, 2 `core:call` +
  1 `jsts:diagnostic`) on n8n, pre-existing, record ids in P2-2i.
- **Semantic maintenance is not wired for v4** (`semantic.current` is
  reported `false` for every v4 workspace, P4-d); lexical maintenance runs
  in-process, not on the threaded worker.
- **Fork/pack daemon wiring** and the fork envelope-digest gap (decision 27)
  are unchanged.
- **The `dependency` incremental-diff gap is CLOSED** (P3-2 §3 — a
  `dependency_id` recipe leak, not a store defect; decision 29).

## Historial de cambios

- **2026-09-05** (P2-2m, `docs/evidence/2026-09-05-v4-p2-2m-identity-key-corruption.md`): root-caused and fixed the `identity_key`-zeroing corruption reported as an open critical bug above. Two real bugs in `crates/urdira-structural-store/src/segment_io.rs`'s hot-file writer: (1) every `records.*` write used a single-shot `write_at`, which POSIX permits to short-write silently — replaced with `write_all_at` (12 call sites, both the flat and partitioned writer); (2) fixing (1) alone did not close the corruption — a concurrent sparse-file allocation race on macOS/APFS could still silently revert one writer's already-`write_all_at`-confirmed bytes to the pre-allocation zero value when up to 16 partition writers extended the SAME sparse file's allocated-extent metadata concurrently. Fixed by `create_sized_hot_files`, which forces real block allocation across a hot file's entire length (`materialize_real`, single-threaded per file, in parallel across the five files) strictly before any concurrent writer touches it, so every later write only overwrites already-allocated blocks. Verified clean across 5 production-path cold runs + 2 in-process diagnostic runs + 1 incremental-oracle run, plus a new `#[ignore]`d stress test (`materialize_write_read_roundtrip_never_loses_an_identity_key`, 200k synthetic records × 200 iterations). This corruption was invisible to the header `xxh3` and to the Merkle roots (both computed from in-memory data before the writer ran) — only the classification invariant (decision 28) and a full-store diagnostic scan could detect it; that gap in the store's own integrity story is unchanged by this fix (a future verify extension would need to re-read persisted bytes, not trust in-memory roots).
- **2026-09-07** (Frente E-P0j, `docs/evidence/2026-09-07-v4-semantic-wiring-and-embed-performance.md` §1.3): entity span fidelity fix — see below (folded from the former standalone amendment).

### Detail: entity span fidelity, `entities.index` re-keyed off identity text

Confirmed live (`docs/evidence/2026-09-07-v4-semantic-wiring-and-embed-performance.md`
§1.3): every entity producer in `urdira-jsts-syntax-worker` (`push_entity`/
`push_entity_with_type_surface`/`push_namespace_entity`/`push_member_entities`,
and `semantic_sites.rs`'s `parameter_entity_record`/`catch_variable_entity_record`)
published `SyntaxEntity::start`/`.end` (and therefore `RecordRow::span_start_byte`/
`.span_end_byte`, `records.meta`'s own fixed row above) as the declaration's
NAME-IDENTIFIER span only — never the whole declaration, unlike v3's
`analyzer.ts` (`entityForDeclaration`'s `identityStart` vs `node.getStart(file)`/
`.getEnd()` split). This made `core:get_source`'s `body`/`signature` modes on a
v4 entity return only the name, and made decision 17's 120-character semantic-
eligibility threshold reject nearly every real function/variable.

Fixed: every producer above now publishes `start`/`end` as the FULL
declaration span (modifiers/decorators/`export`/`export default` through the
closing, for functions/classes/interfaces/type aliases/enums/namespaces/class-
and-interface members; the declarator `x = ...` for a variable; the whole
`FormalParameter`/`CatchParameter`/parameter-property node, own annotation and
default included, for a parameter). `SyntaxEntity` gained two new fields,
`name_start`/`name_end`, carrying the OLD identifier-only span forward
unchanged — `id`/`entity_id` (decision 11's identity contract, `find_references`
on a parameter) were never derived from `start`/`end` in the first place, only
from this same identifier position via `stable_entity_id`/`declaration_id`, so
identity is completely unaffected by this task.

**`entities.index`'s own key changes with it.** This section's own table above
("`(owner_artifact u32, span_start u32, ordinal u32)`... `span_start`") and
`urdira-indexing-worker::v4::residual`'s checker-site correlation both relied
on `span_start_byte` being the identifier's own start (the ONLY thing tsgo
ever reports a position for). Rather than adding a new stored column (a
`records.meta` layout bump cascading through `urdira-native-core`'s kernel
row shape, this crate's segment/layout modules, and the materialize pass, for
information already durable elsewhere), `entities.index`'s build
(`segment_io::entities_index_key_start`, both the flat and partitioned
writers) now recovers the identifier start by PARSING it back out of the
entity's own `identity_key` text (`jsts:{kind}:{path}:{name_start}:{name}`,
new `identity_codec::entity_identity_name_start`, re-exported at the crate
root) instead of reading `RecordRow::span_start_byte` directly. Falls back to
`span_start_byte` (always `0`) for `jsts:external_module`/`external_symbol`,
which have no per-file span at all. `StoreReader::entity_by_owner_and_start`
itself is unchanged — every caller already passed it a tsgo-reported
`name_start_utf16`, never a declaration span. **No `records.meta`/segment
byte layout changed; `entities.index`'s own on-disk shape (three `u32`s,
sorted by the first two) is byte-identical** — only WHICH value gets fed into
column 2 at write time changed, so this table's own row above is unaffected.

Records changed digest for every real v4 entity (a one-time fleet republish;
`JAVASCRIPT_TYPESCRIPT_VERSION` bumped 0.4.0 -> 0.5.0, `docs/versioning.md`).
n8n population floors and reference-parity (`v4_different_target = 0`)
verified unaffected — see `docs/evidence/2026-09-07-v4-entity-declaration-spans.md`.
