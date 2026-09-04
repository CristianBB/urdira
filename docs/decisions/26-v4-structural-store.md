# Decision 26: v4 immutable segment structural store

Status: **Approved; implemented, and the default for newly added workspaces since 2026-09-04 (opt out with `URDIRA_V4=0`; see `versioning.md`). Cold base write is partitioned (P2-2j), delta generations are single-file containers (P3-6), facet names and subject text live in the store's dictionaries (P2-2e). RSS gate (≤ 3 GiB) NOT met: 6.56-8.16 GB at n8n. One open critical data-integrity bug (P2-2m, decision 29).**
Last updated: 2026-09-05
Depends on: [Storage and projection architecture](05-storage-projection-architecture.md), [Content-derived record identity](11-content-derived-record-identity.md), [Transactional projection digests](13-transactional-projection-digests.md), [Native pipeline and relational storage](21-native-pipeline-relational-storage.md), [v3 optimization](22-v3-optimization.md), [Index pack](23-index-pack.md), [Rust native acceleration](25-rust-native-acceleration.md)
Superseded by decisions [27](27-v4-merkle-bucket-digests.md), [28](28-v4-rust-semantics-and-residual-checker.md), [29](29-v4-rust-owned-scan-pipeline.md) for the parts of this system they own (digests, semantics, scan orchestration)

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
64-byte header, little-endian: magic `"URD4"` (4 B), `format` (`u16` = `4`),
`table_id` (`u16`: `Records=1`, `Dependencies=2`, `Dict=3`, `SubjectsKeys=4`),
`row_count` (`u64`), `generation` (`u64`), `xxh3` of the data region after
byte 64 (`u64`), 32 B reserved.

| File | Content | Stride |
|---|---|---:|
| `records.keys` | `record_id` (32 B), sorted ascending | 32 |
| `records.meta` | fixed row: `owner_artifact u32`, `owner_version u32`, `valid_from u32`, `valid_to u32` (0=open), `category u8`, `kind_id u16`, `universal_kind_id u16`, `facets u64` (bitmask), `span_artifact_version u32`, `span_start_byte u32`, `span_end_byte u32`, `span_start_line u32`, `span_end_line u32` (always 0, no producer emits line numbers), `identity_type u8`, `assignment_kind u8`, `name_id u32`, `source_subject u32`, `target_subject u32`, `relation_kind_id u16`, `body_off u64`, `body_len u32`, `ident_off u64`, `ident_len u32` (89 B used, 96 B stride) | 96 |
| `records.digests` | `record_digest`, `body_digest`, `identity_id`, `identity_key_digest`, `previous_record_id` (32 B each, zero when absent) | 160 |
| `records.body` / `records.ident` | heaps: byte-identical UCE bodies / UTF-8 identity-key text | variable |
| `records.by_owner` | `(owner_artifact u32, valid_from u32, valid_to u32, ordinal u32)`, sorted by `owner_artifact`, **inline validity** | 16 |
| `records.by_name` | `(name_id u32, ordinal u32)`, sorted, no inline validity | 8 |
| `records.by_kind` | `(universal_kind_id u16, category u8, kind_id u16, ordinal u32)`, sorted | 9 |
| `records.by_identity` | `(identity_key_digest 32 B, ordinal u32)`, sorted; includes closed rows (identity chaining) | 36 |
| `adj.out` / `adj.in` | `(subject_ordinal u32, valid_from u32, valid_to u32, ordinal u32)`, sorted, **inline validity** | 16 |
| `deps.keys` | `dependency_id` (32 B), sorted — a deliberate addition beyond the plan's own sketch (a delta's `closures.deps` needs a standalone key to name which dependency edge closed) | 32 |
| `deps.meta` | `record_ordinal u32` (`u32::MAX` = the bare `record:` sentinel v3-data quirk), `owner_artifact u32`, `owner_version u32`, `dep_artifact u32`, `dep_version u32`, `role u8`, `valid_from u32`, `valid_to u32` (29 B used, 32 B stride) | 32 |
| `deps.reverse` | `(dep_artifact u32, ordinal u32)`, sorted | 8 |
| `closures.records` / `closures.deps` (delta only) | `(key 32 B, valid_to u32)`, sorted by key | 36 |
| `dict.bin` | framed body: seven length-prefixed lists — `kinds`, `universal_kinds`, `relation_kinds`, `names`, `artifacts` as `(artifact_id, artifact_version_id)` text pairs, plus, since P2-2e, `facet_names` (indexed by the bit position of `records.meta.facets`, sourced from the plugin's `entityFacets`/`relationFacets` via the `FACET_ORDER` constant) and `subject_text` (aligned by ordinal to `subjects.keys`, `"record:<hex>"`); the base directory's copy is the full dictionary, a delta's copy holds only that generation's additions; a pre-P2-2e file short-reads the two new lists as empty | variable |
| `subjects.keys` | framed body: length-prefixed list of 32-byte subject keys, same append-only-per-generation split as `dict.bin` | variable |

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
inline value, or the value found in a per-store, in-memory `HashMap<key,
valid_to>` merged from every delta's `closures.*` file at open time (bounded
by the number of closures since the last compaction). Visible-range queries
(`by_owner`, `adj.*`, `by_name`, `by_kind`) are consulted across every
segment and merged, filtering closed rows through the same map.
`visible_count`/`deps_visible_count` are derived in `O(log n)` per segment
(two sorted `valid_from`/`valid_to` arrays built at open time, plus one
global sorted closure `valid_to` array), not by an `O(n)` scan — this is the
fix for the P0-S1 `visible_count` gap.

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
sections are skipped (P3-3 §4). The mandatory 14 hot files per base are
unchanged.

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

- **CRITICAL — P2-2m `identity_key` zeroing.** A rare, non-deterministic,
  silent corruption (2 of 9 in-process n8n cold scans, ~1 in 1.4M records)
  writes an all-zero `identity_key` of the right length into `records.ident`
  while `record_digest` stays intact, on `core:call` and `core:references`
  rows. Not a store-format defect — the bytes are produced upstream, most
  likely in `kernel_rows_batches`'s `rayon::join` bisection — but the store
  persists and serves them, and neither the header `xxh3` nor the Merkle
  roots can detect it (`docs/evidence/2026-09-05-v4-final-measurements.md`
  §2.4-§2.5; decision 29, open item 1).
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
