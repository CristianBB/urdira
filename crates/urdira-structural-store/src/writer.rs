//! The segment writer: [`SegmentWriter::write_base`] (cold, N-threaded,
//! plan §2.4) and [`SegmentWriter::write_delta`] (incremental, plan
//! §2.5), both publishing a new `MANIFEST` atomically and maintaining
//! the two merkle trees (records, dependency) this crate tracks.

use crate::container::{self, EncodedSection, SectionId};
use crate::dict;
use crate::error::Result;
use crate::layout::*;
use crate::manifest::{Manifest, ManifestFileEntry, fsync_segment_dir};
use crate::merkle;
use crate::reader::StoreReader;
use crate::row::{DependencyRow, Dictionaries, NONE_U32, RecordRow};
use crate::segment_io::*;
use rayon::prelude::*;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::time::{Duration, Instant};
use urdira_indexing_core::merkle_bucket::{Change, SetKind, to_prefixed_hex};

pub struct SegmentSummary {
    /// `bytes[file_name] = (total_bytes_incl_header, xxh3_of_data)`.
    pub files: BTreeMap<String, (u64, u64)>,
    pub to_page_cache: Duration,
    pub durable: Duration,
    pub records_root: [u8; 32],
    pub dependency_root: [u8; 32],
    pub generation: u64,
}

pub struct SegmentWriter {
    n_threads: usize,
}

impl Default for SegmentWriter {
    fn default() -> Self {
        Self::new()
    }
}

impl SegmentWriter {
    pub fn new() -> Self {
        let n_threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        Self { n_threads }
    }

    pub fn with_threads(n_threads: usize) -> Self {
        Self {
            n_threads: n_threads.max(1),
        }
    }

    pub fn write_base(
        &self,
        dir: &Path,
        rows: &[RecordRow],
        deps: &[DependencyRow],
        dicts: &Dictionaries,
        generation: u64,
    ) -> Result<SegmentSummary> {
        let t0 = Instant::now();
        std::fs::create_dir_all(dir)?;
        let base_name = format!("base-{generation}");
        let base_dir = dir.join(&base_name);
        let _ = std::fs::remove_dir_all(&base_dir);
        std::fs::create_dir_all(&base_dir)?;

        let mut files: BTreeMap<String, (u64, u64)> = BTreeMap::new();

        let order = compute_order(rows);

        // Hot files (records.keys/meta/digests/body/ident, partitioned by
        // top nibble across `self.n_threads` threads) and the six
        // secondary sorted-index arrays (by_owner/by_name/by_kind/
        // by_identity/adj.out/adj.in, each a full-set sort) are built by
        // threads spawned into one `std::thread::scope` (matching
        // `urdira-v4-spike replay_c`'s concurrency shape) rather than two
        // sequential phases -- the secondary arrays' sort/write work has
        // no data dependency on the hot files' partitioned writes, so
        // serializing them wasted wall-clock time. See the evidence doc's
        // "P2-3b writer performance" section for the measured effect.
        let hs = write_hot_and_secondary_files(
            &base_dir,
            rows,
            &order,
            generation,
            self.n_threads,
            &base_dir.join("records.by_owner"),
            &base_dir.join("records.by_name"),
            &base_dir.join("records.by_kind"),
            &base_dir.join("records.by_identity"),
            &base_dir.join("adj.out"),
            &base_dir.join("adj.in"),
        )?;
        for (name, bytes) in &hs.hot.bytes {
            files.insert(name.to_string(), (*bytes, hs.hot.xxh3[name]));
        }
        files.extend(hs.secondary);

        let deps_result = write_deps_files(&base_dir, deps, generation)?;
        files.extend(deps_result);

        write_dict_files(&base_dir, dicts, generation, &mut files)?;

        let record_entries = merkle::record_entries(rows, generation);
        let dep_entries = merkle::dependency_entries(deps, generation);
        let records_set = merkle::build(&record_entries)?;
        let dep_set = merkle::build(&dep_entries)?;
        let records_root = records_set.root();
        let dependency_root = dep_set.root();

        let to_page_cache = t0.elapsed();

        let merkle_dir = dir.join("merkle");
        merkle::persist(&records_set, &merkle_dir, SetKind::Records, generation)?;
        merkle::persist(&dep_set, &merkle_dir, SetKind::Dependency, generation)?;
        fsync_segment_dir(&base_dir)?;
        let durable = t0.elapsed();

        let manifest = Manifest {
            format: 4,
            generation,
            snapshot_id: None,
            base: base_name.clone(),
            deltas: Vec::new(),
            roots: [
                ("records".to_string(), to_prefixed_hex(&records_root)),
                ("dependency".to_string(), to_prefixed_hex(&dependency_root)),
            ]
            .into_iter()
            .collect(),
            dict_generation: generation,
            files: qualify_files(&base_name, &files),
        };
        manifest.write_atomic(&dir.join("MANIFEST.next"))?;
        Manifest::publish_next(dir)?;

        Ok(SegmentSummary {
            files,
            to_page_cache,
            durable,
            records_root,
            dependency_root,
            generation,
        })
    }

    /// P2-2j item 2: partition-native counterpart of [`Self::write_base`].
    /// `partitions[nib]` must hold exactly the rows for which
    /// `crate::nibble_of(&row.record_id) == nib`, already sorted ascending
    /// by `record_id` WITHIN each partition -- `urdira-indexing-worker`'s
    /// v4 `materialize::materialize_cold_partitioned` builds these directly
    /// (a rayon `fold`/`reduce` over owners assembling straight into the 16
    /// buckets, each then `par_sort_unstable`-ed) instead of one flat
    /// `Vec<RecordRow>` this method would otherwise have to globally sort
    /// itself (`write_base`'s own `compute_order`). `deps`/`dicts` are
    /// unaffected by this split (dependency and dictionary row counts are
    /// small relative to records -- see the evidence doc) and go through
    /// the exact same `write_deps_files`/`write_dict_files` calls `write_
    /// base` uses. `write_base` itself is UNCHANGED (kept for every
    /// existing caller/test, including this crate's own oracle-equivalence
    /// tests) -- this is a purely additive sibling.
    pub fn write_base_partitioned(
        &self,
        dir: &Path,
        partitions: &[Vec<RecordRow>],
        deps: &[DependencyRow],
        dicts: &Dictionaries,
        generation: u64,
    ) -> Result<SegmentSummary> {
        // P2-2l item 4: per-phase timing, gated behind the same `URDIRA_
        // DEBUG_TIMING` env var `write_delta_with_reader` already uses --
        // this task's own brief asks to profile this function's per-file
        // share (keys/meta/digests/body heap/secondary arrays/xxh3/
        // `write_at`) before optimizing it; this is that instrumentation.
        let debug_timing = std::env::var_os("URDIRA_DEBUG_TIMING").is_some();
        let t0 = Instant::now();
        std::fs::create_dir_all(dir)?;
        let base_name = format!("base-{generation}");
        let base_dir = dir.join(&base_name);
        let _ = std::fs::remove_dir_all(&base_dir);
        std::fs::create_dir_all(&base_dir)?;

        let mut files: BTreeMap<String, (u64, u64)> = BTreeMap::new();

        let hot_and_entries_started = Instant::now();
        let (hs, (record_entries, dep_entries)) = rayon::join(
            || {
                write_hot_and_secondary_files_partitioned(
                    &base_dir,
                    partitions,
                    generation,
                    &base_dir.join("records.by_owner"),
                    &base_dir.join("records.by_name"),
                    &base_dir.join("records.by_kind"),
                    &base_dir.join("records.by_identity"),
                    &base_dir.join("adj.out"),
                    &base_dir.join("adj.in"),
                )
            },
            || {
                // Flat `(record_id, record_digest)`/`(dependency_id,
                // dependency_logical)` pairs only -- never a concatenated
                // `Vec<RecordRow>` (which would carry every row's owned
                // `body`/`identity_key` bytes too, undoing the whole point
                // of not concatenating partitions). `merkle::record_entries`
                // already ignores row order (it filters by visibility only),
                // so calling it once per partition and flattening the small
                // per-row pairs is exactly equivalent to calling it once on
                // a hypothetical concatenated `Vec<RecordRow>`.
                let record_entries: Vec<([u8; 32], [u8; 32])> = partitions
                    .par_iter()
                    .flat_map(|part| merkle::record_entries(part, generation))
                    .collect();
                let dep_entries = merkle::dependency_entries(deps, generation);
                (record_entries, dep_entries)
            },
        );
        let hs = hs?;
        let hot_and_entries_elapsed = hot_and_entries_started.elapsed();
        for (name, bytes) in &hs.hot.bytes {
            files.insert(name.to_string(), (*bytes, hs.hot.xxh3[name]));
        }
        files.extend(hs.secondary);

        let deps_started = Instant::now();
        let deps_result = write_deps_files(&base_dir, deps, generation)?;
        files.extend(deps_result);
        let deps_elapsed = deps_started.elapsed();

        let dicts_started = Instant::now();
        write_dict_files(&base_dir, dicts, generation, &mut files)?;
        let dicts_elapsed = dicts_started.elapsed();

        let merkle_build_started = Instant::now();
        let records_set = merkle::build(&record_entries)?;
        let dep_set = merkle::build(&dep_entries)?;
        let records_root = records_set.root();
        let dependency_root = dep_set.root();
        let merkle_build_elapsed = merkle_build_started.elapsed();

        let to_page_cache = t0.elapsed();

        let persist_started = Instant::now();
        let merkle_dir = dir.join("merkle");
        merkle::persist(&records_set, &merkle_dir, SetKind::Records, generation)?;
        merkle::persist(&dep_set, &merkle_dir, SetKind::Dependency, generation)?;
        let persist_elapsed = persist_started.elapsed();
        let fsync_started = Instant::now();
        fsync_segment_dir(&base_dir)?;
        let fsync_elapsed = fsync_started.elapsed();
        let durable = t0.elapsed();

        if debug_timing {
            eprintln!(
                "[urdira-structural-store] write_base_partitioned: {:.3}s total hot_and_entries={:.3}s (of which hot_files+secondary see write_hot_and_secondary_files_partitioned's own line) deps_files={:.3}s dict_files={:.3}s merkle_build={:.3}s to_page_cache={:.3}s merkle_persist={:.3}s fsync={:.3}s durable={:.3}s",
                durable.as_secs_f64(),
                hot_and_entries_elapsed.as_secs_f64(),
                deps_elapsed.as_secs_f64(),
                dicts_elapsed.as_secs_f64(),
                merkle_build_elapsed.as_secs_f64(),
                to_page_cache.as_secs_f64(),
                persist_elapsed.as_secs_f64(),
                fsync_elapsed.as_secs_f64(),
                durable.as_secs_f64(),
            );
        }

        let manifest = Manifest {
            format: 4,
            generation,
            snapshot_id: None,
            base: base_name.clone(),
            deltas: Vec::new(),
            roots: [
                ("records".to_string(), to_prefixed_hex(&records_root)),
                ("dependency".to_string(), to_prefixed_hex(&dependency_root)),
            ]
            .into_iter()
            .collect(),
            dict_generation: generation,
            files: qualify_files(&base_name, &files),
        };
        manifest.write_atomic(&dir.join("MANIFEST.next"))?;
        Manifest::publish_next(dir)?;

        Ok(SegmentSummary {
            files,
            to_page_cache,
            durable,
            records_root,
            dependency_root,
            generation,
        })
    }

    /// Backward-compatible convenience wrapper: opens its own `StoreReader`
    /// internally, same as this crate's original single-signature
    /// `write_delta` always did. Every test/call site outside `urdira-
    /// indexing-worker`'s v4 delta path (which now holds a long-lived
    /// `StoreReader` across `WorkspaceScan` calls, see `urdira-indexing-
    /// worker::v4::state::WorkspaceState`) keeps working unchanged through
    /// this wrapper -- see [`Self::write_delta_with_reader`] for the P3-2
    /// item 2 fix (a caller that already has a fresh, open `StoreReader`
    /// passes it straight through, skipping a second `StoreInner::load`,
    /// which is O(corpus): every closure across every delta, every
    /// dictionary segment, a full `subject_index` rebuild -- confirmed live
    /// as ~300-480ms of a steady-state edit's own `write_ms` on n8n's
    /// 14k-owner corpus, `docs/evidence/2026-09-03-v4-p3-1-incremental.md`
    /// §7.3-§7.4).
    #[allow(clippy::too_many_arguments)]
    pub fn write_delta(
        &self,
        dir: &Path,
        opened_rows: &[RecordRow],
        closures: &[([u8; 32], u32)],
        deps_opened: &[DependencyRow],
        deps_closures: &[([u8; 32], u32)],
        dict_additions: &Dictionaries,
        generation: u64,
    ) -> Result<SegmentSummary> {
        let current_reader = StoreReader::open(dir)?;
        self.write_delta_with_reader(
            dir,
            &current_reader,
            opened_rows,
            closures,
            deps_opened,
            deps_closures,
            dict_additions,
            generation,
        )
    }

    /// P3-2 item 2: identical to [`Self::write_delta`] except it takes an
    /// ALREADY-OPEN `current_reader` instead of opening a fresh one -- the
    /// caller must guarantee `current_reader` reflects the CURRENT on-disk
    /// `MANIFEST` (i.e. `reopen_if_changed()` was called, or it was just
    /// opened, with no other writer touching this store dir in between).
    /// `urdira-indexing-worker`'s v4 `delta::run` already maintains exactly
    /// such a reader (`WorkspaceState.store_reader`, refreshed at the top
    /// of every `Changed` scan before any read or write happens) and uses
    /// it for its own diffing reads (`by_owner`, `by_identity_last`)
    /// earlier in the SAME call -- reusing it here for the merkle-bucket
    /// reads (`visible_entries_in_bucket`/`visible_dep_entries_in_bucket`)
    /// and the manifest read (`current_reader.manifest()`, an in-memory
    /// clone off the open mmap snapshot, not a disk read) is always safe
    /// and always correct for that caller, since nothing writes to this
    /// store directory between the reader's last refresh and this call.
    #[allow(clippy::too_many_arguments)]
    pub fn write_delta_with_reader(
        &self,
        dir: &Path,
        current_reader: &StoreReader,
        opened_rows: &[RecordRow],
        closures: &[([u8; 32], u32)],
        deps_opened: &[DependencyRow],
        deps_closures: &[([u8; 32], u32)],
        dict_additions: &Dictionaries,
        generation: u64,
    ) -> Result<SegmentSummary> {
        let t0 = Instant::now();
        // P3-3 item 4 / P3-6 item 1: sub-timers for `write_delta_with_
        // reader`, gated behind the SAME `URDIRA_DEBUG_TIMING` env var
        // `urdira-indexing-worker`'s own delta.rs already uses for its
        // "DEBUG BISECT" lines (kept consistent so one env var turns on
        // every sub-timer in the incremental write path). Found live: at
        // n8n scale, a tiny (3-5 row) steady-state edit's `write_ms` was
        // dominated almost entirely by FIXED per-call cost here -- one
        // `F_FULLFSYNC` per file in the old `delta-<g>/` directory layout
        // (up to 18 files) -- not by row count. P3-6 item 1 replaced that
        // directory with one `delta-<g>.seg` container file (`container.
        // rs`) so this whole function now pays exactly ONE fsync total.
        let debug_timing = std::env::var_os("URDIRA_DEBUG_TIMING").is_some();
        let current = current_reader.manifest();
        let prev_generation = current_reader.generation();

        let delta_name = format!("delta-{generation}.seg");
        let delta_path = dir.join(&delta_name);

        // Builds every logical section's blob (header + data, byte-
        // identical to what the pre-P3-6 standalone file would have held)
        // entirely in memory -- see `build_delta_sections`'s own doc for
        // why this can stay single-threaded (delta row counts are tiny;
        // `write_base`'s N-threaded nibble-partitioned writer exists for
        // whole-corpus cold writes, not this path).
        let sections = build_delta_sections(
            opened_rows,
            closures,
            deps_opened,
            deps_closures,
            dict_additions,
            generation,
        );
        let t_segment_files = t0.elapsed();
        // Kept as a separate checkpoint (was "closures" pre-P3-6, now
        // measures nothing extra -- closures are built as part of the one
        // `build_delta_sections` call above) so every prior evidence doc's
        // sub-timer table stays comparable column-for-column.
        let t_closures = t0.elapsed();

        // Merkle updates: newly-visible rows are `Set`s, newly-closed
        // rows are `Delete`s (they drop out of the visible-rows set the
        // merkle root tracks).
        let mut record_changes: Vec<Change> = opened_rows
            .iter()
            .filter(|r| {
                r.valid_from as u64 <= generation
                    && (r.valid_to == 0 || r.valid_to as u64 > generation)
            })
            .map(|r| Change::Set {
                key: r.record_id,
                logical: r.record_digest,
            })
            .collect();
        record_changes.extend(closures.iter().map(|(k, _)| Change::Delete { key: *k }));

        let mut dep_changes: Vec<Change> = deps_opened
            .iter()
            .filter(|r| {
                r.valid_from as u64 <= generation
                    && (r.valid_to == 0 || r.valid_to as u64 > generation)
            })
            .map(|r| Change::Set {
                key: r.dependency_id,
                logical: merkle::dependency_logical(r),
            })
            .collect();
        dep_changes.extend(
            deps_closures
                .iter()
                .map(|(k, _)| Change::Delete { key: *k }),
        );

        // Load + apply both trees' updates in memory (no I/O beyond the
        // initial read) so neither's `write_slots` fsync lands inside the
        // page-cache-timed window; persisted just below, after
        // `to_page_cache` is captured.
        let merkle_dir = dir.join("merkle");
        // P3-1 perf fix (found live against n8n's `migration-types.ts` hub
        // edit, a 2,196-owner/356,905-record affected closure): grouping
        // `*_changes` by bucket ONCE, up front, turns `apply_changes_in_
        // bucket`'s per-bucket cost from "scan the ENTIRE changes list" (a
        // `bucket_entries` callback invoked once per TOUCHED bucket, up to
        // one per changed key since keys are effectively random 32-byte
        // hashes) into "look up this bucket's own small pre-filtered
        // slice" -- O(N) total instead of O(N x distinct_buckets), which
        // is O(N^2) when nearly every changed key lands in its own bucket.
        // A `sample`-confirmed multi-minute (not finishing within the
        // observation window) stall for N=356,905 became sub-second after
        // this fix (`crates/urdira-indexing-worker`'s P3-1 evidence doc has
        // the full repro). `apply_changes_in_bucket` itself is untouched --
        // only what it's called with changes (a bucket-local slice instead
        // of the full list), so its own per-bucket filter is now a cheap,
        // redundant safety net over an already-tiny slice, not the hot
        // path.
        let record_changes_by_bucket = group_changes_by_bucket(&record_changes);
        let dep_changes_by_bucket = group_changes_by_bucket(&dep_changes);
        let empty_changes: &[Change] = &[];
        let records_update = if record_changes.is_empty() {
            None
        } else {
            let bucket_entries = |idx: u32| -> Vec<([u8; 32], [u8; 32])> {
                apply_changes_in_bucket(
                    current_reader.visible_entries_in_bucket(idx, prev_generation),
                    record_changes_by_bucket
                        .get(&idx)
                        .map(Vec::as_slice)
                        .unwrap_or(empty_changes),
                    idx,
                )
            };
            Some(merkle::load_and_update(
                &merkle_dir,
                SetKind::Records,
                &record_changes,
                bucket_entries,
            )?)
        };
        let records_root = match &records_update {
            Some((set, _)) => set.root(),
            None => merkle::read_root(&merkle_dir, SetKind::Records)?,
        };

        let deps_update = if dep_changes.is_empty() {
            None
        } else {
            let bucket_entries = |idx: u32| -> Vec<([u8; 32], [u8; 32])> {
                apply_changes_in_bucket(
                    current_reader.visible_dep_entries_in_bucket(idx, prev_generation),
                    dep_changes_by_bucket
                        .get(&idx)
                        .map(Vec::as_slice)
                        .unwrap_or(empty_changes),
                    idx,
                )
            };
            Some(merkle::load_and_update(
                &merkle_dir,
                SetKind::Dependency,
                &dep_changes,
                bucket_entries,
            )?)
        };
        let dependency_root = match &deps_update {
            Some((set, _)) => set.root(),
            None => merkle::read_root(&merkle_dir, SetKind::Dependency)?,
        };
        let t_merkle_memory = t0.elapsed();

        // P3-6 item 1: the segment data reaches the page cache as ONE
        // container file, buffered/sequential, not yet fsynced.
        let uncommitted =
            container::write_container_to_page_cache(&delta_path, generation, &sections)?;
        let container_total_bytes = uncommitted.total_bytes;
        let container_body_xxh3 = uncommitted.body_xxh3;
        let to_page_cache = t0.elapsed();

        // The ONE durability call for this generation's segment data
        // (replaces the old `fsync_segment_dir`'s one-`F_FULLFSYNC`-per-
        // file loop over up to 18 files).
        container::commit_container(uncommitted)?;
        let t_container_fsync = t0.elapsed();

        // Merkle `.tree` slot + header writes happen AFTER the container's
        // own fsync (each `write_slots` call fsyncs its own tree file
        // internally) -- ordering the segment data's durability ahead of
        // the merkle root's is deliberate, not accidental: the segment
        // container this generation's rows/deps actually live in is the
        // thing `MANIFEST` (published next) points readers at.
        if let Some((set, touched)) = &records_update {
            merkle::persist_slots(set, touched, &merkle_dir, SetKind::Records, generation)?;
        }
        if let Some((set, touched)) = &deps_update {
            merkle::persist_slots(set, touched, &merkle_dir, SetKind::Dependency, generation)?;
        }
        let durable = t0.elapsed();

        let mut deltas = current.deltas.clone();
        deltas.push(delta_name.clone());
        let mut all_files = current.files.clone();
        all_files.insert(
            delta_name.clone(),
            ManifestFileEntry {
                bytes: container_total_bytes,
                xxh3: container_body_xxh3,
            },
        );

        let manifest = Manifest {
            format: 4,
            generation,
            snapshot_id: None,
            base: current.base.clone(),
            deltas,
            roots: [
                ("records".to_string(), to_prefixed_hex(&records_root)),
                ("dependency".to_string(), to_prefixed_hex(&dependency_root)),
            ]
            .into_iter()
            .collect(),
            dict_generation: generation,
            files: all_files,
        };
        manifest.write_atomic(&dir.join("MANIFEST.next"))?;
        Manifest::publish_next(dir)?;
        let t_manifest = t0.elapsed();

        if debug_timing {
            eprintln!(
                "[urdira-structural-store] write_delta_with_reader sub-timers: segment_files={:.3}s merkle_memory={:.3}s container_page_cache={:.3}s container_fsync={:.3}s persist_slots={:.3}s manifest={:.3}s total={:.3}s (opened_records={} closures={} opened_deps={} deps_closures={} container_bytes={})",
                t_segment_files.as_secs_f64(),
                (t_merkle_memory - t_closures).as_secs_f64(),
                (to_page_cache - t_merkle_memory).as_secs_f64(),
                (t_container_fsync - to_page_cache).as_secs_f64(),
                (durable - t_container_fsync).as_secs_f64(),
                (t_manifest - durable).as_secs_f64(),
                t_manifest.as_secs_f64(),
                opened_rows.len(),
                closures.len(),
                deps_opened.len(),
                deps_closures.len(),
                container_total_bytes,
            );
        }

        let mut files: BTreeMap<String, (u64, u64)> = BTreeMap::new();
        files.insert(delta_name, (container_total_bytes, container_body_xxh3));

        Ok(SegmentSummary {
            files,
            to_page_cache,
            durable,
            records_root,
            dependency_root,
            generation,
        })
    }
}

/// Groups `changes` by `merkle::bucket_index_of(key)` in one O(N) pass --
/// see `write_delta`'s own comment on the call site this feeds for why
/// this exists (turns O(N x distinct_buckets) into O(N) overall).
fn group_changes_by_bucket(changes: &[Change]) -> HashMap<u32, Vec<Change>> {
    let mut grouped: HashMap<u32, Vec<Change>> = HashMap::new();
    for change in changes {
        let key = match change {
            Change::Set { key, .. } => key,
            Change::Delete { key } => key,
        };
        grouped
            .entry(merkle::bucket_index_of(key))
            .or_default()
            .push(*change);
    }
    grouped
}

fn apply_changes_in_bucket(
    mut entries: Vec<([u8; 32], [u8; 32])>,
    changes: &[Change],
    bucket_idx: u32,
) -> Vec<([u8; 32], [u8; 32])> {
    for change in changes {
        match change {
            Change::Set { key, logical } if merkle::bucket_index_of(key) == bucket_idx => {
                entries.retain(|(k, _)| k != key);
                entries.push((*key, *logical));
            }
            Change::Delete { key } if merkle::bucket_index_of(key) == bucket_idx => {
                entries.retain(|(k, _)| k != key);
            }
            _ => {}
        }
    }
    entries
}

fn qualify_files(
    segment_name: &str,
    files: &BTreeMap<String, (u64, u64)>,
) -> BTreeMap<String, ManifestFileEntry> {
    files
        .iter()
        .map(|(name, (bytes, xxh3))| {
            (
                format!("{segment_name}/{name}"),
                ManifestFileEntry {
                    bytes: *bytes,
                    xxh3: *xxh3,
                },
            )
        })
        .collect()
}

/// Sorts `rows` by `record_id` unless already sorted (a redundant
/// `is_sorted` pass is cheap relative to the sort it may save, and the
/// task brief's `write_base(..., rows_sorted_by_key, ...)` signature
/// implies callers normally pre-sort).
fn compute_order(rows: &[RecordRow]) -> Vec<u32> {
    let n = rows.len();
    let already_sorted = rows.windows(2).all(|w| w[0].record_id <= w[1].record_id);
    let mut order: Vec<u32> = (0..n as u32).collect();
    if !already_sorted {
        order.sort_unstable_by_key(|&i| rows[i as usize].record_id);
    }
    order
}

/// P3-6 item 1: builds every logical section a delta generation carries as
/// an in-memory blob (`container::EncodedSection`), skipping the ones that
/// would be empty (mirrors P3-3 item 4's existing skip rule for closures/
/// dict/subjects, now generalized to every optional section). Intentionally
/// single-threaded and mostly a straight-line re-implementation of `write_
/// hot_records_files`/`build_secondary_arrays`/`write_deps_files`/`write_
/// dict_files`'s own per-row encoding, rather than a refactor to share code
/// with them: those functions are tuned for `write_base`'s whole-corpus
/// row counts (N-threaded, nibble-partitioned, `write_at` into a
/// preallocated file) -- overhead that buys nothing at delta scale (a
/// steady-state edit opens single-digit rows) and would only complicate
/// producing a plain `Vec<u8>` blob instead of writing to a file. Every
/// byte layout used here is IDENTICAL to those functions' (same
/// `layout::meta`/`digests`/`deps_meta` offsets, same stride constants),
/// so a section's blob is byte-for-byte what the pre-P3-6 standalone file
/// of the same name would have contained.
#[allow(clippy::too_many_arguments)]
fn build_delta_sections(
    opened_rows: &[RecordRow],
    closures: &[([u8; 32], u32)],
    deps_opened: &[DependencyRow],
    deps_closures: &[([u8; 32], u32)],
    dict_additions: &Dictionaries,
    generation: u64,
) -> Vec<EncodedSection> {
    let mut sections: Vec<EncodedSection> = Vec::with_capacity(18);

    // -- records.keys/meta/digests/body/ident --
    let order = compute_order(opened_rows);
    let n = order.len();
    let mut keys_body = Vec::with_capacity(n * KEYS_STRIDE);
    let mut meta_body = vec![0u8; n * META_STRIDE];
    let mut digests_body = vec![0u8; n * DIGESTS_STRIDE];
    let mut body_body: Vec<u8> = Vec::new();
    let mut ident_body: Vec<u8> = Vec::new();
    for (k, &i) in order.iter().enumerate() {
        let row = &opened_rows[i as usize];
        keys_body.extend_from_slice(&row.record_id);

        let body_off = body_body.len() as u64;
        let ident_off = ident_body.len() as u64;
        let m = &mut meta_body[k * META_STRIDE..(k + 1) * META_STRIDE];
        put_u32le(m, meta::OWNER_ARTIFACT, row.owner_artifact);
        put_u32le(m, meta::OWNER_VERSION, row.owner_version);
        put_u32le(m, meta::VALID_FROM, row.valid_from);
        put_u32le(m, meta::VALID_TO, row.valid_to);
        m[meta::CATEGORY] = row.category;
        put_u16le(m, meta::KIND_ID, row.kind_id);
        put_u16le(m, meta::UNIVERSAL_KIND_ID, row.universal_kind_id);
        put_u64le(m, meta::FACETS, row.facets);
        put_u32le(m, meta::SPAN_ARTIFACT_VERSION, row.span_artifact_version);
        put_u32le(m, meta::SPAN_START_BYTE, row.span_start_byte);
        put_u32le(m, meta::SPAN_END_BYTE, row.span_end_byte);
        put_u32le(m, meta::SPAN_START_LINE, row.span_start_line);
        put_u32le(m, meta::SPAN_END_LINE, row.span_end_line);
        m[meta::IDENTITY_TYPE] = row.identity_type;
        m[meta::ASSIGNMENT_KIND] = row.assignment_kind;
        put_u32le(m, meta::NAME_ID, row.name_id);
        put_u32le(
            m,
            meta::SOURCE_SUBJECT,
            row.source_subject.unwrap_or(NONE_U32),
        );
        put_u32le(
            m,
            meta::TARGET_SUBJECT,
            row.target_subject.unwrap_or(NONE_U32),
        );
        put_u16le(m, meta::RELATION_KIND_ID, row.relation_kind_id);
        put_u64le(m, meta::BODY_OFF, body_off);
        put_u32le(m, meta::BODY_LEN, row.body.len() as u32);
        put_u64le(m, meta::IDENT_OFF, ident_off);
        put_u32le(m, meta::IDENT_LEN, row.identity_key.len() as u32);

        let d = &mut digests_body[k * DIGESTS_STRIDE..(k + 1) * DIGESTS_STRIDE];
        d[digests::RECORD_DIGEST..digests::RECORD_DIGEST + 32].copy_from_slice(&row.record_digest);
        d[digests::BODY_DIGEST..digests::BODY_DIGEST + 32].copy_from_slice(&row.body_digest);
        d[digests::IDENTITY_ID..digests::IDENTITY_ID + 32].copy_from_slice(&row.identity_id);
        d[digests::IDENTITY_KEY_DIGEST..digests::IDENTITY_KEY_DIGEST + 32]
            .copy_from_slice(&row.identity_key_digest);
        d[digests::PREVIOUS_RECORD_ID..digests::PREVIOUS_RECORD_ID + 32]
            .copy_from_slice(&row.previous_record_id);

        body_body.extend_from_slice(&row.body);
        ident_body.extend_from_slice(&row.identity_key);
    }
    sections.push((
        SectionId::RecordsKeys,
        encode_framed(TableId::Records, generation, n as u64, &keys_body).0,
    ));
    sections.push((
        SectionId::RecordsMeta,
        encode_framed(TableId::Records, generation, n as u64, &meta_body).0,
    ));
    sections.push((
        SectionId::RecordsDigests,
        encode_framed(TableId::Records, generation, n as u64, &digests_body).0,
    ));
    sections.push((
        SectionId::RecordsBody,
        encode_framed(TableId::Records, generation, n as u64, &body_body).0,
    ));
    sections.push((
        SectionId::RecordsIdent,
        encode_framed(TableId::Records, generation, n as u64, &ident_body).0,
    ));

    // -- secondary sorted-index arrays --
    let mut by_owner: Vec<(u32, u32, u32, u32)> = order
        .iter()
        .enumerate()
        .map(|(k, &i)| {
            let r = &opened_rows[i as usize];
            (r.owner_artifact, r.valid_from, r.valid_to, k as u32)
        })
        .collect();
    by_owner.sort_unstable();
    let mut buf = Vec::with_capacity(by_owner.len() * VALIDITY_QUAD_STRIDE);
    for (a, b, c, d) in &by_owner {
        buf.extend_from_slice(&a.to_le_bytes());
        buf.extend_from_slice(&b.to_le_bytes());
        buf.extend_from_slice(&c.to_le_bytes());
        buf.extend_from_slice(&d.to_le_bytes());
    }
    sections.push((
        SectionId::RecordsByOwner,
        encode_framed(TableId::Records, generation, by_owner.len() as u64, &buf).0,
    ));

    let mut by_name: Vec<(u32, u32)> = order
        .iter()
        .enumerate()
        .filter_map(|(k, &i)| {
            opened_rows[i as usize]
                .name_id_opt()
                .map(|nm| (nm, k as u32))
        })
        .collect();
    by_name.sort_unstable();
    let mut buf = Vec::with_capacity(by_name.len() * PAIR2_STRIDE);
    for (a, b) in &by_name {
        buf.extend_from_slice(&a.to_le_bytes());
        buf.extend_from_slice(&b.to_le_bytes());
    }
    sections.push((
        SectionId::RecordsByName,
        encode_framed(TableId::Records, generation, by_name.len() as u64, &buf).0,
    ));

    let mut by_kind: Vec<(u16, u8, u16, u32)> = order
        .iter()
        .enumerate()
        .map(|(k, &i)| {
            let r = &opened_rows[i as usize];
            (r.universal_kind_id, r.category, r.kind_id, k as u32)
        })
        .collect();
    by_kind.sort_unstable();
    let mut buf = Vec::with_capacity(by_kind.len() * BY_KIND_STRIDE);
    for (u, c, kd, k) in &by_kind {
        buf.extend_from_slice(&u.to_le_bytes());
        buf.push(*c);
        buf.extend_from_slice(&kd.to_le_bytes());
        buf.extend_from_slice(&k.to_le_bytes());
    }
    sections.push((
        SectionId::RecordsByKind,
        encode_framed(TableId::Records, generation, by_kind.len() as u64, &buf).0,
    ));

    let mut by_identity: Vec<([u8; 32], u32)> = order
        .iter()
        .enumerate()
        .map(|(k, &i)| (opened_rows[i as usize].identity_key_digest, k as u32))
        .collect();
    by_identity.sort_unstable();
    let mut buf = Vec::with_capacity(by_identity.len() * BY_IDENTITY_STRIDE);
    for (digest, k) in &by_identity {
        buf.extend_from_slice(digest);
        buf.extend_from_slice(&k.to_le_bytes());
    }
    sections.push((
        SectionId::RecordsByIdentity,
        encode_framed(TableId::Records, generation, by_identity.len() as u64, &buf).0,
    ));

    let mut adj_out: Vec<(u32, u32, u32, u32)> = order
        .iter()
        .enumerate()
        .filter_map(|(k, &i)| {
            let r = &opened_rows[i as usize];
            r.source_subject
                .map(|s| (s, r.valid_from, r.valid_to, k as u32))
        })
        .collect();
    adj_out.sort_unstable();
    let mut buf = Vec::with_capacity(adj_out.len() * VALIDITY_QUAD_STRIDE);
    for (a, b, c, d) in &adj_out {
        buf.extend_from_slice(&a.to_le_bytes());
        buf.extend_from_slice(&b.to_le_bytes());
        buf.extend_from_slice(&c.to_le_bytes());
        buf.extend_from_slice(&d.to_le_bytes());
    }
    sections.push((
        SectionId::AdjOut,
        encode_framed(TableId::Records, generation, adj_out.len() as u64, &buf).0,
    ));

    let mut adj_in: Vec<(u32, u32, u32, u32)> = order
        .iter()
        .enumerate()
        .filter_map(|(k, &i)| {
            let r = &opened_rows[i as usize];
            r.target_subject
                .map(|s| (s, r.valid_from, r.valid_to, k as u32))
        })
        .collect();
    adj_in.sort_unstable();
    let mut buf = Vec::with_capacity(adj_in.len() * VALIDITY_QUAD_STRIDE);
    for (a, b, c, d) in &adj_in {
        buf.extend_from_slice(&a.to_le_bytes());
        buf.extend_from_slice(&b.to_le_bytes());
        buf.extend_from_slice(&c.to_le_bytes());
        buf.extend_from_slice(&d.to_le_bytes());
    }
    sections.push((
        SectionId::AdjIn,
        encode_framed(TableId::Records, generation, adj_in.len() as u64, &buf).0,
    ));

    // -- deps.keys/meta/reverse --
    let mut dep_order: Vec<u32> = (0..deps_opened.len() as u32).collect();
    dep_order.sort_unstable_by_key(|&i| deps_opened[i as usize].dependency_id);
    let dn = dep_order.len();
    let mut deps_keys_body = vec![0u8; dn * DEPS_KEYS_STRIDE];
    let mut deps_meta_body = vec![0u8; dn * DEPS_META_STRIDE];
    for (k, &i) in dep_order.iter().enumerate() {
        let row = &deps_opened[i as usize];
        deps_keys_body[k * DEPS_KEYS_STRIDE..k * DEPS_KEYS_STRIDE + 32]
            .copy_from_slice(&row.dependency_id);
        let m = &mut deps_meta_body[k * DEPS_META_STRIDE..(k + 1) * DEPS_META_STRIDE];
        put_u32le(m, deps_meta::RECORD_ORD, row.record.unwrap_or(NONE_U32));
        put_u32le(m, deps_meta::OWNER_ARTIFACT, row.owner_artifact);
        put_u32le(m, deps_meta::OWNER_VERSION, row.owner_version);
        put_u32le(m, deps_meta::DEP_ARTIFACT, row.dep_artifact);
        put_u32le(m, deps_meta::DEP_VERSION, row.dep_version);
        m[deps_meta::ROLE] = row.role;
        put_u32le(m, deps_meta::VALID_FROM, row.valid_from);
        put_u32le(m, deps_meta::VALID_TO, row.valid_to);
    }
    sections.push((
        SectionId::DepsKeys,
        encode_framed(
            TableId::Dependencies,
            generation,
            dn as u64,
            &deps_keys_body,
        )
        .0,
    ));
    sections.push((
        SectionId::DepsMeta,
        encode_framed(
            TableId::Dependencies,
            generation,
            dn as u64,
            &deps_meta_body,
        )
        .0,
    ));

    let mut deps_reverse: Vec<(u32, u32)> = dep_order
        .iter()
        .enumerate()
        .map(|(k, &i)| (deps_opened[i as usize].dep_artifact, k as u32))
        .collect();
    deps_reverse.sort_unstable();
    let mut buf = Vec::with_capacity(deps_reverse.len() * DEPS_REVERSE_STRIDE);
    for (a, b) in &deps_reverse {
        buf.extend_from_slice(&a.to_le_bytes());
        buf.extend_from_slice(&b.to_le_bytes());
    }
    sections.push((
        SectionId::DepsReverse,
        encode_framed(
            TableId::Dependencies,
            generation,
            deps_reverse.len() as u64,
            &buf,
        )
        .0,
    ));

    // -- dict.bin / subjects.keys -- P3-3 item 4's empty-skip rule,
    // generalized: an absent section is exactly equivalent to an empty one
    // (`reader::load_dict_file`/`load_subjects_file`, unchanged).
    let total_dict_entries = dict_additions.kinds.len()
        + dict_additions.universal_kinds.len()
        + dict_additions.relation_kinds.len()
        + dict_additions.names.len()
        + dict_additions.artifacts.len()
        + dict_additions.facet_names.len()
        + dict_additions.subject_text.len();
    if total_dict_entries > 0 {
        let mut dict_body = Vec::new();
        // `write_dict_body` cannot fail against a `Vec<u8>` sink.
        dict::write_dict_body(&mut dict_body, dict_additions).expect("in-memory write");
        sections.push((
            SectionId::DictBin,
            encode_framed(
                TableId::Dict,
                generation,
                total_dict_entries as u64,
                &dict_body,
            )
            .0,
        ));
    }
    if !dict_additions.subjects.is_empty() {
        let mut subjects_body = Vec::new();
        dict::write_subjects_body(&mut subjects_body, &dict_additions.subjects)
            .expect("in-memory write");
        sections.push((
            SectionId::SubjectsKeys,
            encode_framed(
                TableId::SubjectsKeys,
                generation,
                dict_additions.subjects.len() as u64,
                &subjects_body,
            )
            .0,
        ));
    }

    // -- closures.records / closures.deps -- P3-3 item 4's existing rule.
    if !closures.is_empty() {
        let mut sorted = closures.to_vec();
        sorted.sort_unstable_by_key(|(k, _)| *k);
        let mut body = Vec::with_capacity(sorted.len() * CLOSURE_STRIDE);
        for (k, vt) in &sorted {
            body.extend_from_slice(k);
            body.extend_from_slice(&vt.to_le_bytes());
        }
        sections.push((
            SectionId::ClosuresRecords,
            encode_framed(TableId::Records, generation, sorted.len() as u64, &body).0,
        ));
    }
    if !deps_closures.is_empty() {
        let mut sorted = deps_closures.to_vec();
        sorted.sort_unstable_by_key(|(k, _)| *k);
        let mut body = Vec::with_capacity(sorted.len() * CLOSURE_STRIDE);
        for (k, vt) in &sorted {
            body.extend_from_slice(k);
            body.extend_from_slice(&vt.to_le_bytes());
        }
        sections.push((
            SectionId::ClosuresDeps,
            encode_framed(
                TableId::Dependencies,
                generation,
                sorted.len() as u64,
                &body,
            )
            .0,
        ));
    }

    sections
}

fn write_deps_files(
    dir: &Path,
    deps: &[DependencyRow],
    generation: u64,
) -> Result<BTreeMap<String, (u64, u64)>> {
    let mut order: Vec<u32> = (0..deps.len() as u32).collect();
    order.sort_unstable_by_key(|&i| deps[i as usize].dependency_id);

    let n = order.len();
    let mut keys_body = vec![0u8; n * DEPS_KEYS_STRIDE];
    let mut meta_body = vec![0u8; n * DEPS_META_STRIDE];
    for (k, &i) in order.iter().enumerate() {
        let row = &deps[i as usize];
        keys_body[k * DEPS_KEYS_STRIDE..k * DEPS_KEYS_STRIDE + 32]
            .copy_from_slice(&row.dependency_id);
        let m = &mut meta_body[k * DEPS_META_STRIDE..(k + 1) * DEPS_META_STRIDE];
        put_u32le(m, deps_meta::RECORD_ORD, row.record.unwrap_or(NONE_U32));
        put_u32le(m, deps_meta::OWNER_ARTIFACT, row.owner_artifact);
        put_u32le(m, deps_meta::OWNER_VERSION, row.owner_version);
        put_u32le(m, deps_meta::DEP_ARTIFACT, row.dep_artifact);
        put_u32le(m, deps_meta::DEP_VERSION, row.dep_version);
        m[deps_meta::ROLE] = row.role;
        put_u32le(m, deps_meta::VALID_FROM, row.valid_from);
        put_u32le(m, deps_meta::VALID_TO, row.valid_to);
    }

    let mut reverse: Vec<(u32, u32)> = order
        .iter()
        .enumerate()
        .map(|(k, &i)| (deps[i as usize].dep_artifact, k as u32))
        .collect();
    reverse.sort_unstable();
    let mut reverse_body = Vec::with_capacity(reverse.len() * DEPS_REVERSE_STRIDE);
    for (a, b) in &reverse {
        reverse_body.extend_from_slice(&a.to_le_bytes());
        reverse_body.extend_from_slice(&b.to_le_bytes());
    }

    let mut out = BTreeMap::new();
    let (b, x) = write_framed_file(
        &dir.join("deps.keys"),
        TableId::Dependencies,
        generation,
        n as u64,
        &keys_body,
    )?;
    out.insert("deps.keys".to_string(), (b, x));
    let (b, x) = write_framed_file(
        &dir.join("deps.meta"),
        TableId::Dependencies,
        generation,
        n as u64,
        &meta_body,
    )?;
    out.insert("deps.meta".to_string(), (b, x));
    let (b, x) = write_framed_file(
        &dir.join("deps.reverse"),
        TableId::Dependencies,
        generation,
        reverse.len() as u64,
        &reverse_body,
    )?;
    out.insert("deps.reverse".to_string(), (b, x));
    Ok(out)
}

fn write_dict_files(
    dir: &Path,
    dicts: &Dictionaries,
    generation: u64,
    files: &mut BTreeMap<String, (u64, u64)>,
) -> Result<()> {
    // P3-3 item 4: skip writing (and therefore later fsyncing --
    // `fsync_segment_dir` only ever fsyncs files that ARE present in the
    // directory) a file that would carry zero rows. `load_dict_file`/
    // `load_subjects_file` (`reader.rs`) tolerate an absent file as
    // exactly equivalent to an empty one (same convention `load_closures`
    // already established) -- this is what makes the skip safe, not merely
    // convenient. A cold `write_base` call (this function's OTHER caller)
    // is realistically never empty (every corpus has at least one kind/
    // artifact), so this only changes behavior for the incremental delta
    // path this item targets.
    let total_entries = dicts.kinds.len()
        + dicts.universal_kinds.len()
        + dicts.relation_kinds.len()
        + dicts.names.len()
        + dicts.artifacts.len()
        + dicts.facet_names.len()
        + dicts.subject_text.len();
    if total_entries > 0 {
        let mut dict_body = Vec::new();
        dict::write_dict_body(&mut dict_body, dicts)?;
        let (b, x) = write_framed_file(
            &dir.join("dict.bin"),
            TableId::Dict,
            generation,
            total_entries as u64,
            &dict_body,
        )?;
        files.insert("dict.bin".to_string(), (b, x));
    }

    if !dicts.subjects.is_empty() {
        let mut subjects_body = Vec::new();
        dict::write_subjects_body(&mut subjects_body, &dicts.subjects)?;
        let (b, x) = write_framed_file(
            &dir.join("subjects.keys"),
            TableId::SubjectsKeys,
            generation,
            dicts.subjects.len() as u64,
            &subjects_body,
        )?;
        files.insert("subjects.keys".to_string(), (b, x));
    }
    Ok(())
}
