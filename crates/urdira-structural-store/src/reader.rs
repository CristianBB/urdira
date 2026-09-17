//! Read side: `memmap2`-backed segments (base + deltas), merged closures,
//! merged append-only dictionaries, and the query surface listed in the
//! task brief. All state is held behind `Arc` snapshots so `StoreReader`
//! clones are cheap and every query runs against one immutable snapshot
//! -- concurrent readers never observe a torn state across a manifest
//! swap (`reopen_if_changed`).

use crate::container::{self, SectionId, SectionRanges};
use crate::dict::{read_dict_body, read_subjects_body};
use crate::error::{Result, store_err};
use crate::identity_codec;
use crate::layout::*;
use crate::manifest::Manifest;
use crate::row::{Dictionaries, NONE_U32, PendingSiteKey, PendingSiteRow};
use crate::segment_io::*;
use memmap2::Mmap;
use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// P3-6 item 1: one opened base or delta segment's raw material, before
/// [`Segment::open`] turns it into typed [`SectionSource`] fields. A base
/// segment is still a plain directory of per-file mmaps (`write_base`
/// unchanged); a delta generation is now one already-mmapped `delta-<g>
/// .seg` container (`container::open_container`, called once per segment
/// here and reused both for the optional dict/subjects/closures sections
/// below and for every mandatory field [`Segment::open`] builds) -- opening
/// it twice (once for the optional sections, once inside `Segment::open`)
/// would mmap the same file twice for no reason.
enum OpenedLocation {
    Dir(PathBuf),
    Container {
        path: PathBuf,
        mmap: Arc<Mmap>,
        ranges: SectionRanges,
    },
}

/// Returns the full blob (64-byte header + data) for an OPTIONAL section
/// (`dict.bin` / `subjects.keys` / `closures.records` / `closures.deps`),
/// or `None` if this segment doesn't carry it -- for a `Dir` location that
/// means the file doesn't exist (pre-existing convention, `write_base`
/// always writes these so this branch is effectively delta-only in
/// practice); for a `Container` location that means the section id isn't
/// in its table of contents (`build_delta_sections`, `writer.rs`, skips
/// writing genuinely empty optional sections -- P3-3 item 4's rule,
/// generalized in P3-6 item 1).
fn optional_section_bytes(
    loc: &OpenedLocation,
    dir_file_name: &str,
    section: SectionId,
) -> Result<Option<Vec<u8>>> {
    match loc {
        OpenedLocation::Dir(dir) => {
            let path = dir.join(dir_file_name);
            if !path.exists() {
                return Ok(None);
            }
            Ok(Some(
                std::fs::read(&path).map_err(|e| store_err!("read {}: {e}", path.display()))?,
            ))
        }
        OpenedLocation::Container { mmap, ranges, .. } => Ok(ranges
            .get(&section)
            .map(|(start, end)| mmap[*start..*end].to_vec())),
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Direction {
    Out,
    In,
}

/// One base directory or delta container, fully mapped. Each field is a
/// [`SectionSource`] -- either its own whole-file mmap (base) or a
/// byte-range view into one shared container mmap (delta, P3-6 item 1) --
/// so every accessor below (`key_at`, `meta_row`, ...) keeps indexing
/// plain byte slices exactly as it did when every field was an `Mmap`
/// directly (`SectionSource` derefs to `[u8]`).
/// F1 1.2: `Clone` (all fields are cheap to clone: `SectionSource`/`Arc<
/// HashMap>` are `Arc` bumps, the `valid_*_sorted` `Vec<u32>`s are plain
/// memcpys) so `StoreInner::extend` can rebuild a PREVIOUS generation's
/// `Segment` with freshly fused closures maps without re-scanning
/// `records.meta`/`deps.meta` (see `StoreInner::extend`'s own doc comment
/// for the correctness reason this rebuild -- not a bare `Arc::clone` of
/// the old `Segment` -- is required).
#[derive(Clone)]
pub(crate) struct Segment {
    pub generation: u64,
    pub keys: SectionSource,
    pub meta: SectionSource,
    pub digests: SectionSource,
    pub body: SectionSource,
    pub ident: SectionSource,
    pub by_owner: SectionSource,
    pub by_name: SectionSource,
    pub by_kind: SectionSource,
    pub by_identity: SectionSource,
    pub adj_out: SectionSource,
    pub adj_in: SectionSource,
    /// F4 4.3: `(owner_artifact, span_start, ordinal)` triples over this
    /// segment's own `CATEGORY_ENTITY` rows (excluding `jsts:entity_
    /// inferred_type`) -- MANDATORY, like `by_name`/`by_owner` (never
    /// `Option`), because every base/delta this crate writes now carries it
    /// unconditionally (`HEADER_FORMAT` 6). See `StoreReader::
    /// entity_by_owner_and_start`.
    pub entities_index: SectionSource,
    pub deps_keys: SectionSource,
    pub deps_meta: SectionSource,
    pub deps_reverse: SectionSource,
    pub n: usize,
    pub deps_n: usize,
    /// `pending.sites` -- OPTIONAL: `None` for a segment written before
    /// this table existed, or a base/delta with zero pending rows (the
    /// same empty-skip convention `dict.bin`/`subjects.keys` already use).
    /// `None` and `Some(empty)` never both occur -- an empty section is
    /// simply never written (see `writer::write_pending_sites_file`/
    /// `build_delta_sections`), so `pending_n == 0` always implies `pending
    /// .is_none()`.
    pub pending: Option<SectionSource>,
    pub pending_n: usize,
    /// `closures.pending` -- OPTIONAL, delta-only (a base carries none, by
    /// construction, same as `closures.records`/`closures.deps`). Kept as
    /// a raw section (unlike `record_closures`/`dep_closures`, which are
    /// pre-parsed into one store-wide `HashMap` and never re-read) purely
    /// so [`StoreReader::verify_all`] has real bytes with a real `xxh3` to
    /// check -- the merged `pending_closures` map below already services
    /// every query path.
    pub closures_pending: Option<SectionSource>,
    /// This segment's own inline `valid_from`/`valid_to` (nonzero only),
    /// sorted ascending, for the O(log n) `visible_count` term.
    pub valid_from_sorted: Vec<u32>,
    pub valid_to_sorted: Vec<u32>,
    pub deps_valid_from_sorted: Vec<u32>,
    pub deps_valid_to_sorted: Vec<u32>,
    pub record_closures: Arc<HashMap<[u8; 32], u32>>,
    /// Adversarial review fix (frente E-P0 review): unlike
    /// `record_closures` (a `record_id` closes at most once EVER --
    /// `record_id` is always freshly chained on replace/reopen, so the
    /// key itself never repeats), `dependency_id` IS reusable, so a key
    /// can legitimately be closed more than once across the store's
    /// history. `Vec<u32>` holds EVERY closure ever recorded against the
    /// key (append-only fold, see `StoreInner::load`/`extend`), not just
    /// the last one -- see [`Segment::deps_effective_valid_to`]'s doc
    /// comment for why collapsing to one entry per key is wrong and what
    /// replaced it.
    pub dep_closures: Arc<HashMap<[u8; 32], Vec<u32>>>,
    /// Merged across every delta's `closures.pending` (see
    /// `StoreInner::load`) -- every segment holds the SAME `Arc` to this
    /// one store-wide map, exactly the pattern `record_closures`/`dep_
    /// closures` already establish. Same `Vec<u32>`-per-key shape as
    /// `dep_closures`, same reason (`PendingSiteKey` is reusable too).
    pub pending_closures: Arc<HashMap<PendingSiteKey, Vec<u32>>>,
}

fn open_data(dir: &Path, name: &str) -> Result<Arc<Mmap>> {
    Ok(Arc::new(mmap_file(&dir.join(name))?))
}

/// Adversarial review fix (frente E-P0 review): the closure that applies
/// to a specific physical row is the SMALLEST recorded closure strictly
/// greater than that row's own `valid_from` -- the closure immediately
/// following this row's own open, since two rows sharing a key can never
/// overlap in time and a key can only be reopened after being closed.
/// Shared by `Segment::deps_effective_valid_to`/`pending_effective_valid_to`.
fn closure_for_row(closures: Option<&Vec<u32>>, valid_from: u32, inline_valid_to: u32) -> u32 {
    match closures {
        Some(values) => values
            .iter()
            .copied()
            .filter(|&closed_at| closed_at > valid_from)
            .min()
            .unwrap_or(inline_valid_to),
        None => inline_valid_to,
    }
}

impl Segment {
    fn open(
        loc: &OpenedLocation,
        record_closures: Arc<HashMap<[u8; 32], u32>>,
        dep_closures: Arc<HashMap<[u8; 32], Vec<u32>>>,
        pending_closures: Arc<HashMap<PendingSiteKey, Vec<u32>>>,
    ) -> Result<Self> {
        // Uniform accessor over both `OpenedLocation` variants: a base
        // directory opens one mmap per logical file (unchanged); a delta
        // container looks up the section's already-known byte range in
        // its own (already-mmapped) TOC and wraps it as a zero-copy view
        // into that SAME shared mmap.
        let section = |dir_file_name: &str, id: SectionId| -> Result<SectionSource> {
            match loc {
                OpenedLocation::Dir(dir) => Ok(SectionSource::File(open_data(dir, dir_file_name)?)),
                OpenedLocation::Container { mmap, ranges, path } => {
                    let (start, end) = ranges.get(&id).copied().ok_or_else(|| {
                        store_err!(
                            "delta container {} missing section {dir_file_name}",
                            path.display()
                        )
                    })?;
                    Ok(SectionSource::Container {
                        mmap: Arc::clone(mmap),
                        start,
                        end,
                    })
                }
            }
        };
        // Same as `section` above but OPTIONAL: `pending.sites`/`closures.
        // pending` may legitimately be absent (see `Segment::pending`'s own
        // doc comment) -- mirrors `optional_section_bytes` (used at the
        // `StoreInner::load` level for `dict.bin`/`subjects.keys`/`closures
        // .records`/`closures.deps`) but returns a zero-copy `SectionSource`
        // instead of an owned `Vec<u8>`, since this one is kept for the
        // lifetime of the segment rather than parsed once and discarded.
        let optional_section =
            |dir_file_name: &str, id: SectionId| -> Result<Option<SectionSource>> {
                match loc {
                    OpenedLocation::Dir(dir) => {
                        let path = dir.join(dir_file_name);
                        if !path.exists() {
                            return Ok(None);
                        }
                        Ok(Some(SectionSource::File(open_data(dir, dir_file_name)?)))
                    }
                    OpenedLocation::Container { mmap, ranges, .. } => {
                        Ok(ranges
                            .get(&id)
                            .map(|&(start, end)| SectionSource::Container {
                                mmap: Arc::clone(mmap),
                                start,
                                end,
                            }))
                    }
                }
            };

        let keys = section("records.keys", SectionId::RecordsKeys)?;
        let (keys_header, _) = header_and_data(&keys)?;
        let n = keys_header.row_count as usize;
        let meta = section("records.meta", SectionId::RecordsMeta)?;
        let digests = section("records.digests", SectionId::RecordsDigests)?;
        let body = section("records.body", SectionId::RecordsBody)?;
        let ident = section("records.ident", SectionId::RecordsIdent)?;
        let by_owner = section("records.by_owner", SectionId::RecordsByOwner)?;
        let by_name = section("records.by_name", SectionId::RecordsByName)?;
        let by_kind = section("records.by_kind", SectionId::RecordsByKind)?;
        let by_identity = section("records.by_identity", SectionId::RecordsByIdentity)?;
        let adj_out = section("adj.out", SectionId::AdjOut)?;
        let adj_in = section("adj.in", SectionId::AdjIn)?;
        let entities_index = section("entities.index", SectionId::EntitiesIndex)?;
        let deps_keys = section("deps.keys", SectionId::DepsKeys)?;
        let (deps_header, _) = header_and_data(&deps_keys)?;
        let deps_n = deps_header.row_count as usize;
        let deps_meta = section("deps.meta", SectionId::DepsMeta)?;
        let deps_reverse = section("deps.reverse", SectionId::DepsReverse)?;
        let pending = optional_section("pending.sites", SectionId::PendingSites)?;
        let pending_n = match &pending {
            Some(src) => header_and_data(src)?.0.row_count as usize,
            None => 0,
        };
        let closures_pending = optional_section("closures.pending", SectionId::ClosuresPending)?;

        let meta_data = &meta[HEADER_LEN..];
        let mut valid_from_sorted = Vec::with_capacity(n);
        let mut valid_to_sorted = Vec::new();
        for i in 0..n {
            let row = &meta_data[i * META_STRIDE..(i + 1) * META_STRIDE];
            valid_from_sorted.push(u32le(row, meta::VALID_FROM));
            let vt = u32le(row, meta::VALID_TO);
            if vt != 0 {
                valid_to_sorted.push(vt);
            }
        }
        valid_from_sorted.sort_unstable();
        valid_to_sorted.sort_unstable();

        let deps_meta_data = &deps_meta[HEADER_LEN..];
        let mut deps_valid_from_sorted = Vec::with_capacity(deps_n);
        let mut deps_valid_to_sorted = Vec::new();
        for i in 0..deps_n {
            let row = &deps_meta_data[i * DEPS_META_STRIDE..(i + 1) * DEPS_META_STRIDE];
            deps_valid_from_sorted.push(u32le(row, deps_meta::VALID_FROM));
            let vt = u32le(row, deps_meta::VALID_TO);
            if vt != 0 {
                deps_valid_to_sorted.push(vt);
            }
        }
        deps_valid_from_sorted.sort_unstable();
        deps_valid_to_sorted.sort_unstable();

        let generation = keys_header.generation;
        Ok(Segment {
            generation,
            keys,
            meta,
            digests,
            body,
            ident,
            by_owner,
            by_name,
            by_kind,
            by_identity,
            adj_out,
            adj_in,
            entities_index,
            deps_keys,
            deps_meta,
            deps_reverse,
            n,
            deps_n,
            pending,
            pending_n,
            closures_pending,
            valid_from_sorted,
            valid_to_sorted,
            deps_valid_from_sorted,
            deps_valid_to_sorted,
            record_closures,
            dep_closures,
            pending_closures,
        })
    }

    pub fn key_at(&self, ordinal: usize) -> [u8; 32] {
        let d = &self.keys[HEADER_LEN..];
        d[ordinal * KEYS_STRIDE..ordinal * KEYS_STRIDE + 32]
            .try_into()
            .unwrap()
    }

    pub fn meta_row(&self, ordinal: usize) -> &[u8] {
        let d = &self.meta[HEADER_LEN..];
        &d[ordinal * META_STRIDE..(ordinal + 1) * META_STRIDE]
    }

    pub fn digests_row(&self, ordinal: usize) -> &[u8] {
        let d = &self.digests[HEADER_LEN..];
        &d[ordinal * DIGESTS_STRIDE..(ordinal + 1) * DIGESTS_STRIDE]
    }

    pub fn effective_valid_to(&self, ordinal: usize, inline_valid_to: u32) -> u32 {
        if self.record_closures.is_empty() {
            return inline_valid_to;
        }
        let key = self.key_at(ordinal);
        self.record_closures
            .get(&key)
            .copied()
            .unwrap_or(inline_valid_to)
    }

    pub fn deps_key_at(&self, ordinal: usize) -> [u8; 32] {
        let d = &self.deps_keys[HEADER_LEN..];
        d[ordinal * DEPS_KEYS_STRIDE..ordinal * DEPS_KEYS_STRIDE + 32]
            .try_into()
            .unwrap()
    }

    pub fn deps_meta_row(&self, ordinal: usize) -> &[u8] {
        let d = &self.deps_meta[HEADER_LEN..];
        &d[ordinal * DEPS_META_STRIDE..(ordinal + 1) * DEPS_META_STRIDE]
    }

    /// Frente E-P0 (P0-1 root cause fix): `dependency_id` is a PURE,
    /// unsalted function of `(owner_path, dep_path, role)`
    /// (`urdira-indexing-worker::v4::deps::dependency_id`), NOT chained the
    /// way `record_id` is (`diff::chained_record_id` mints a FRESH id on
    /// every replace/reopen) -- so, unlike `record_closures`/[`Self::
    /// effective_valid_to`] (where a given key can only EVER have been
    /// opened by exactly one physical row across the store's entire
    /// history, making a single global "key -> valid_to" map always
    /// unambiguous), the SAME `dependency_id` can legitimately be reused
    /// by a LATER physical row after an earlier one under that key was
    /// closed (an edge closed then reopened, whether within one owner-diff
    /// churning an unrelated field or a genuine remove-then-re-add later).
    /// Applying `dep_closures[key]` unconditionally to EVERY row carrying
    /// that key -- including one opened AT OR AFTER the closure's own
    /// generation -- permanently hides the reopened row: confirmed live on
    /// n8n (`docs/evidence/2026-09-06-v4-reconcile-threshold.md`, "tras
    /// E-P0"), a `--files 100` bisection lost 14,935 of an independent
    /// oracle's 35,504 live dependency edges this way. A closure can only
    /// ever legitimately apply to a row that existed BEFORE it was
    /// recorded -- `ordinal`'s own `valid_from` gates the lookup here so a
    /// row opened at or after `dep_closures[key]`'s generation (a fresh
    /// reopen, this SAME key's next physical row) is never affected by a
    /// closure meant for its now-dead predecessor. Symmetric with
    /// `diff::diff_owner`'s companion fix (`urdira-indexing-worker::v4::
    /// delta`'s module doc): that fix stops WRITING a same-generation
    /// close+reopen pair for an edge that never actually changed (the
    /// dominant case measured live); this read-side guard is what makes a
    /// genuine cross-generation remove-then-re-add of the identical edge
    /// correct too, a case the write-side fix alone cannot cover (two
    /// independent `diff_one_owner` calls, no shared context).
    ///
    /// **Adversarial review fix (frente E-P0 review, same day):** the
    /// FIRST cut of this fix kept `dep_closures` a flat `HashMap<key,
    /// u32>` (last-write-wins on merge -- see `StoreInner::load`/
    /// `extend`), which is correct ONLY for a key closed at most ONCE in
    /// the store's entire history. A key closed **twice** (not three
    /// times -- the original version of this doc comment undercounted the
    /// threshold) already breaks it: `open@1, close@3, reopen@5, close@7`
    /// collapses to a single merged entry `{key: 7}`, so `ordinal`'s own
    /// row (say the `valid_from=1` occurrence) resolves `closed_at=7 > 1`
    /// and reports itself open through generation 7 -- when it was really
    /// dead from generation 3. This does not corrupt a "what is visible
    /// RIGHT NOW" read (only ever one physical row is live at the current
    /// generation, and its own `valid_from` is always `>=` every closure
    /// recorded before it, so the gate still resolves it correctly), but
    /// it silently corrupts (a) any point-in-time read at a generation
    /// strictly between two of the key's closures (`is_visible` takes an
    /// arbitrary `generation: u64`, not just "current" -- nothing in the
    /// public API restricts it, and this reader has no other invariant
    /// ruling such reads out), and (b) [`crate::StoreReader::deps_visible_count`]
    /// unconditionally, at ANY generation including the current one: that
    /// function's `O(log n)` derivation subtracts one unit per **map
    /// entry**, not one unit per **physically closed row** -- confirmed
    /// live in this review's own regression test
    /// (`deps_pending_closure_matrix_test.rs`,
    /// `deps_visible_count_does_not_overcount_a_twice_closed_key`): a
    /// dependency edge removed, re-added, and removed again (two closures,
    /// two dead physical rows under the one key) made `deps_visible_count`
    /// report one MORE live edge than actually exists, at the store's own
    /// current generation, no historical query needed.
    ///
    /// Fixed properly here (not just documented as a residual): `dep_
    /// closures` now maps a key to EVERY closure ever recorded against it
    /// (`Vec<u32>`, one entry appended per delta that closes the key --
    /// see `StoreInner::load`/`extend`), and the closure that applies to
    /// THIS row is the smallest recorded closure strictly greater than
    /// `valid_from` (the closure immediately following this row's own
    /// open -- by construction the very next close event chronologically
    /// after this row started, since two rows under the same key can never
    /// overlap and a key can only be reopened after being closed). No
    /// on-disk format change: `closures.deps`'s bytes are unchanged, this
    /// only changes how the in-memory merge folds them. Cost: one `Vec`
    /// per key, bounded by "closures against that ONE key since the last
    /// `compact()`" -- in the documented worst case (a key touched on
    /// EVERY delta since the last compaction, e.g. `pending.sites`'
    /// wholesale-replace-on-every-owner-touch pattern), that is the
    /// plan's own compaction trigger bound (`deltas > 32`), never
    /// corpus-sized; `deps_visible_count`'s `dep_closure_valid_to_sorted`
    /// is rebuilt by flattening every key's `Vec` (one unit per REAL
    /// closure event again, fixing the overcount too), not by picking one
    /// value per key. See `docs/decisions/26-v4-structural-store.md`
    /// ("Effective valid_to") for the semantics written up in full.
    pub fn deps_effective_valid_to(
        &self,
        ordinal: usize,
        valid_from: u32,
        inline_valid_to: u32,
    ) -> u32 {
        if self.dep_closures.is_empty() {
            return inline_valid_to;
        }
        let key = self.deps_key_at(ordinal);
        closure_for_row(self.dep_closures.get(&key), valid_from, inline_valid_to)
    }

    pub fn pending_row(&self, ordinal: usize) -> &[u8] {
        let d = &self
            .pending
            .as_ref()
            .expect("pending_row: no pending section")[HEADER_LEN..];
        &d[ordinal * PENDING_SITE_STRIDE..(ordinal + 1) * PENDING_SITE_STRIDE]
    }

    pub fn pending_key_at(&self, ordinal: usize) -> PendingSiteKey {
        pending_site_key_at(
            &self
                .pending
                .as_ref()
                .expect("pending_key_at: no pending section")[HEADER_LEN..],
            ordinal,
        )
    }

    /// Frente E-P0: same fix as [`Self::deps_effective_valid_to`], same
    /// reason -- `PendingSiteKey` (`owner_artifact`/`start`/`end`/
    /// `site_kind`) is a plain, reusable, unchained key, and `delta.rs`'s
    /// own `diff_one_owner` deliberately does an unconditional "wholesale
    /// replace" for pending sites on EVERY owner reprocessing (never a
    /// `diff::diff_owner`-style "unchanged, keep" -- see that module's own
    /// doc comment on `pending_opened`/`pending_closures`), so a pending
    /// site that is STILL pending after a reprocessing (the common case:
    /// an unresolved import that stays unresolved) writes a same-
    /// generation close+reopen pair for the IDENTICAL key on every single
    /// touch -- even more frequently than the dependency case this was
    /// found from. Gated by `valid_from` for the same reason.
    /// Adversarial review fix, same day: see [`Self::deps_effective_valid_to`]'s
    /// doc comment for the full derivation -- `pending_closures` now maps a
    /// key to every closure ever recorded against it, not just the last
    /// one, for the exact same reason (a reusable, unsalted key; this
    /// class of bug is reachable HERE more often than for dependencies,
    /// since `delta.rs`'s wholesale-replace touches every one of an
    /// owner's pending sites on every single reprocessing).
    pub fn pending_effective_valid_to(
        &self,
        ordinal: usize,
        valid_from: u32,
        inline_valid_to: u32,
    ) -> u32 {
        if self.pending_closures.is_empty() {
            return inline_valid_to;
        }
        let key = self.pending_key_at(ordinal);
        closure_for_row(self.pending_closures.get(&key), valid_from, inline_valid_to)
    }
}

/// A live handle onto one record row, borrowed from its owning segment's
/// mmap. Cheap to clone (two `Arc` bumps). A3a: also holds the owning
/// store snapshot (`store`) so [`Self::identity_key`] can reconstruct a
/// tagged row's identity string from typed fields elsewhere on `self`
/// (`store.dicts`) and, for a relation, resolve its endpoints' own
/// identity keys one level deep (`store.get`) -- see `crate::identity_
/// codec`'s module doc for the mechanism.
#[derive(Clone)]
pub struct RecordView {
    pub(crate) segment: Arc<Segment>,
    pub(crate) store: Arc<StoreInner>,
    pub(crate) ordinal: usize,
}

impl RecordView {
    pub fn record_id(&self) -> [u8; 32] {
        self.segment.key_at(self.ordinal)
    }
    fn meta(&self) -> &[u8] {
        self.segment.meta_row(self.ordinal)
    }
    pub fn owner_artifact(&self) -> u32 {
        u32le(self.meta(), meta::OWNER_ARTIFACT)
    }
    pub fn owner_version(&self) -> u32 {
        u32le(self.meta(), meta::OWNER_VERSION)
    }
    pub fn valid_from(&self) -> u32 {
        u32le(self.meta(), meta::VALID_FROM)
    }
    pub fn valid_to_raw(&self) -> u32 {
        u32le(self.meta(), meta::VALID_TO)
    }
    pub fn valid_to_effective(&self) -> u32 {
        self.segment
            .effective_valid_to(self.ordinal, self.valid_to_raw())
    }
    pub fn is_visible(&self, generation: u64) -> bool {
        let vf = self.valid_from() as u64;
        if vf > generation {
            return false;
        }
        let vt = self.valid_to_effective();
        vt == 0 || (vt as u64) > generation
    }
    pub fn category(&self) -> u8 {
        self.meta()[meta::CATEGORY]
    }
    pub fn kind_id(&self) -> u16 {
        u16le(self.meta(), meta::KIND_ID)
    }
    pub fn universal_kind_id(&self) -> u16 {
        u16le(self.meta(), meta::UNIVERSAL_KIND_ID)
    }
    pub fn facets(&self) -> u64 {
        u64le(self.meta(), meta::FACETS)
    }
    pub fn span_artifact_version(&self) -> u32 {
        u32le(self.meta(), meta::SPAN_ARTIFACT_VERSION)
    }
    pub fn span_start_byte(&self) -> u32 {
        u32le(self.meta(), meta::SPAN_START_BYTE)
    }
    pub fn span_end_byte(&self) -> u32 {
        u32le(self.meta(), meta::SPAN_END_BYTE)
    }
    pub fn span_start_line(&self) -> u32 {
        u32le(self.meta(), meta::SPAN_START_LINE)
    }
    pub fn span_end_line(&self) -> u32 {
        u32le(self.meta(), meta::SPAN_END_LINE)
    }
    pub fn identity_type(&self) -> u8 {
        self.meta()[meta::IDENTITY_TYPE]
    }
    pub fn assignment_kind(&self) -> u8 {
        self.meta()[meta::ASSIGNMENT_KIND]
    }
    pub fn name_id(&self) -> Option<u32> {
        let v = u32le(self.meta(), meta::NAME_ID);
        (v != NONE_U32).then_some(v)
    }
    pub fn source_subject(&self) -> Option<u32> {
        let v = u32le(self.meta(), meta::SOURCE_SUBJECT);
        (v != NONE_U32).then_some(v)
    }
    pub fn target_subject(&self) -> Option<u32> {
        let v = u32le(self.meta(), meta::TARGET_SUBJECT);
        (v != NONE_U32).then_some(v)
    }
    pub fn relation_kind_id(&self) -> Option<u16> {
        let v = u16le(self.meta(), meta::RELATION_KIND_ID);
        (v != crate::row::NONE_U16).then_some(v)
    }
    /// A3a-fix: ordinal into `dicts.entity_kinds` (the row's own FINE
    /// per-declaration entity-kind word), `None` unless `identity_layout()
    /// == IDENTITY_LAYOUT_ENTITY`.
    pub fn entity_kind_ordinal(&self) -> Option<u8> {
        let v = self.meta()[meta::ENTITY_KIND];
        (v != meta::ENTITY_KIND_NONE).then_some(v)
    }
    /// A3a-fix: this row's raw `IDENTITY_LAYOUT_*` tag (`crate::layout::
    /// meta`) -- exposed read-only for tests/tooling that want to inspect
    /// storage layout distribution without decoding a full identity key
    /// (e.g. counting rows by tag over a real corpus).
    pub fn identity_layout(&self) -> u8 {
        self.meta()[meta::IDENTITY_LAYOUT]
    }
    pub fn body(&self) -> &[u8] {
        let off = u64le(self.meta(), meta::BODY_OFF) as usize;
        let len = u32le(self.meta(), meta::BODY_LEN) as usize;
        &self.segment.body[HEADER_LEN + off..HEADER_LEN + off + len]
    }
    /// A3a: `Cow` because a `RAW`-layout row's bytes are a real borrow of
    /// the mmap'd `records.ident` (as before this task), while an `ENTITY`/
    /// `RELATION`-layout row's bytes are reconstructed fresh from `self`'s
    /// own typed fields (`crate::identity_codec::reconstruct_entity`/
    /// `reconstruct_relation`) -- nothing is stored for those rows at all.
    /// Never panics: a reconstruction that cannot complete (an inconsistent
    /// store -- a dangling dictionary ordinal, an unresolvable relation
    /// endpoint) returns an empty `Cow` instead, same as a genuinely empty
    /// identity key would read; `debug_assert!`s below catch that case in
    /// tests/debug builds without changing release behavior.
    pub fn identity_key(&self) -> Cow<'_, [u8]> {
        let layout = self.meta()[meta::IDENTITY_LAYOUT];
        let reconstructed = if layout == meta::IDENTITY_LAYOUT_ENTITY {
            self.reconstruct_entity_identity_key()
        } else if layout == meta::IDENTITY_LAYOUT_RELATION {
            self.reconstruct_relation_identity_key()
        } else if layout == meta::IDENTITY_LAYOUT_RELATION_NO_SPAN {
            self.reconstruct_relation_no_span_identity_key()
        } else {
            None
        };
        if let Some(bytes) = reconstructed {
            return Cow::Owned(bytes);
        }
        debug_assert!(
            layout == meta::IDENTITY_LAYOUT_RAW,
            "identity_key: tagged layout {layout} failed to reconstruct (store data \
             inconsistency) -- falling back to the (empty, for a tagged row) stored ident bytes"
        );
        let off = u64le(self.meta(), meta::IDENT_OFF) as usize;
        let len = u32le(self.meta(), meta::IDENT_LEN) as usize;
        Cow::Borrowed(&self.segment.ident[HEADER_LEN + off..HEADER_LEN + off + len])
    }

    /// `jsts:{kind}:{path}:{start}:{name}`, rebuilt from `ENTITY_KIND` ->
    /// `dicts.entity_kinds` (the FINE per-declaration word -- NOT `kind_id`
    /// -> `dicts.kinds`, which only ever carries the COARSE `UniversalKind`
    /// -bucketed word, see `identity_codec`'s module doc), `owner_artifact`
    /// -> `dicts.artifact_paths`, `span_start_byte`, and `name_id` ->
    /// `dicts.names`. `None` on any missing/out-of-range field -- this
    /// should never actually happen for a row this crate itself tagged
    /// `IDENTITY_LAYOUT_ENTITY` at write time (the writer only tags a row
    /// once the SAME reconstruction already matched its real identity key
    /// byte for byte), so a `None` here would mean the store itself is
    /// inconsistent; the caller's `debug_assert!` is what actually catches
    /// that in tests.
    fn reconstruct_entity_identity_key(&self) -> Option<Vec<u8>> {
        let dicts = &self.store.dicts;
        let entity_kind_ord = self.entity_kind_ordinal()?;
        let kind = dicts.entity_kinds.get(entity_kind_ord as usize)?;
        let path = dicts.artifact_paths.get(self.owner_artifact() as usize)?;
        let name_id = self.name_id()?;
        let name = dicts.names.get(name_id as usize)?;
        Some(identity_codec::reconstruct_entity(
            kind,
            path,
            self.span_start_byte(),
            name,
        ))
    }

    /// `jsts:{rel}:{path}:{start}:{end}:{source_identity_key}:
    /// {target_identity_key}` -- `{rel}` from `kind_id` -> `dicts.kinds`
    /// stripped of the fixed `"jsts:relation_"` prefix; `{path}` from
    /// `owner_artifact` -> `dicts.artifact_paths` (A3a-fix: NOT `dicts.
    /// artifacts`, which carries the artifact digest pair, not a real
    /// path); the two endpoint identity keys resolved one level deep:
    /// `source_subject`/`target_subject` -> `dicts.subjects[ord]` (that
    /// entity's own `record_id`) -> `store.get(record_id)?.identity_key()`
    /// (which may itself be `RAW` or `ENTITY`-tagged -- either way, this is
    /// exactly that entity's own identity key bytes). Same never-panic
    /// contract as [`Self::reconstruct_entity_identity_key`].
    fn reconstruct_relation_identity_key(&self) -> Option<Vec<u8>> {
        let dicts = &self.store.dicts;
        let kind_text = dicts.kinds.get(self.kind_id() as usize)?;
        let rel = kind_text.strip_prefix("jsts:relation_")?;
        let path = dicts.artifact_paths.get(self.owner_artifact() as usize)?;
        let source_ord = self.source_subject()?;
        let target_ord = self.target_subject()?;
        let source_record_id = dicts.subjects.get(source_ord as usize)?;
        let target_record_id = dicts.subjects.get(target_ord as usize)?;
        let source_view = self.store.get(source_record_id)?;
        let target_view = self.store.get(target_record_id)?;
        let source_key = source_view.identity_key();
        let target_key = target_view.identity_key();
        Some(identity_codec::reconstruct_relation(
            rel,
            path,
            self.span_start_byte(),
            self.span_end_byte(),
            &source_key,
            &target_key,
        ))
    }

    /// A3a-fix: `jsts:{rel}:{source_identity_key}:{target_identity_key}` --
    /// no path or span at all (`jsts:contains:*` in particular). Same
    /// endpoint-resolution discipline as [`Self::
    /// reconstruct_relation_identity_key`], minus the path/span segments.
    fn reconstruct_relation_no_span_identity_key(&self) -> Option<Vec<u8>> {
        let dicts = &self.store.dicts;
        let kind_text = dicts.kinds.get(self.kind_id() as usize)?;
        let rel = kind_text.strip_prefix("jsts:relation_")?;
        let source_ord = self.source_subject()?;
        let target_ord = self.target_subject()?;
        let source_record_id = dicts.subjects.get(source_ord as usize)?;
        let target_record_id = dicts.subjects.get(target_ord as usize)?;
        let source_view = self.store.get(source_record_id)?;
        let target_view = self.store.get(target_record_id)?;
        let source_key = source_view.identity_key();
        let target_key = target_view.identity_key();
        Some(identity_codec::reconstruct_relation_no_span(
            rel,
            &source_key,
            &target_key,
        ))
    }
    fn digests(&self) -> &[u8] {
        self.segment.digests_row(self.ordinal)
    }
    pub fn record_digest(&self) -> [u8; 32] {
        self.digests()[digests::RECORD_DIGEST..digests::RECORD_DIGEST + 32]
            .try_into()
            .unwrap()
    }
    pub fn body_digest(&self) -> [u8; 32] {
        self.digests()[digests::BODY_DIGEST..digests::BODY_DIGEST + 32]
            .try_into()
            .unwrap()
    }
    pub fn identity_id(&self) -> [u8; 32] {
        self.digests()[digests::IDENTITY_ID..digests::IDENTITY_ID + 32]
            .try_into()
            .unwrap()
    }
    pub fn identity_key_digest(&self) -> [u8; 32] {
        self.digests()[digests::IDENTITY_KEY_DIGEST..digests::IDENTITY_KEY_DIGEST + 32]
            .try_into()
            .unwrap()
    }
    pub fn previous_record_id(&self) -> [u8; 32] {
        self.digests()[digests::PREVIOUS_RECORD_ID..digests::PREVIOUS_RECORD_ID + 32]
            .try_into()
            .unwrap()
    }
}

#[derive(Clone)]
pub struct DependencyView {
    pub(crate) segment: Arc<Segment>,
    pub(crate) ordinal: usize,
}

impl DependencyView {
    pub fn dependency_id(&self) -> [u8; 32] {
        self.segment.deps_key_at(self.ordinal)
    }
    fn meta(&self) -> &[u8] {
        self.segment.deps_meta_row(self.ordinal)
    }
    pub fn record(&self) -> Option<u32> {
        let v = u32le(self.meta(), deps_meta::RECORD_ORD);
        (v != NONE_U32).then_some(v)
    }
    pub fn owner_artifact(&self) -> u32 {
        u32le(self.meta(), deps_meta::OWNER_ARTIFACT)
    }
    pub fn owner_version(&self) -> u32 {
        u32le(self.meta(), deps_meta::OWNER_VERSION)
    }
    pub fn dep_artifact(&self) -> u32 {
        u32le(self.meta(), deps_meta::DEP_ARTIFACT)
    }
    pub fn dep_version(&self) -> u32 {
        u32le(self.meta(), deps_meta::DEP_VERSION)
    }
    pub fn role(&self) -> u8 {
        self.meta()[deps_meta::ROLE]
    }
    pub fn valid_from(&self) -> u32 {
        u32le(self.meta(), deps_meta::VALID_FROM)
    }
    pub fn valid_to_raw(&self) -> u32 {
        u32le(self.meta(), deps_meta::VALID_TO)
    }
    pub fn valid_to_effective(&self) -> u32 {
        self.segment
            .deps_effective_valid_to(self.ordinal, self.valid_from(), self.valid_to_raw())
    }
    pub fn is_visible(&self, generation: u64) -> bool {
        let vf = self.valid_from() as u64;
        if vf > generation {
            return false;
        }
        let vt = self.valid_to_effective();
        vt == 0 || (vt as u64) > generation
    }
}

/// A live handle onto one `pending.sites` row. Mirrors [`DependencyView`]
/// field-for-field.
#[derive(Clone)]
pub struct PendingSiteView {
    pub(crate) segment: Arc<Segment>,
    pub(crate) ordinal: usize,
}

impl PendingSiteView {
    fn meta(&self) -> &[u8] {
        self.segment.pending_row(self.ordinal)
    }
    pub fn owner_artifact(&self) -> u32 {
        u32le(self.meta(), pending_sites::OWNER_ARTIFACT)
    }
    pub fn owner_version(&self) -> u32 {
        u32le(self.meta(), pending_sites::OWNER_VERSION)
    }
    pub fn valid_from(&self) -> u32 {
        u32le(self.meta(), pending_sites::VALID_FROM)
    }
    pub fn valid_to_raw(&self) -> u32 {
        u32le(self.meta(), pending_sites::VALID_TO)
    }
    pub fn valid_to_effective(&self) -> u32 {
        self.segment.pending_effective_valid_to(
            self.ordinal,
            self.valid_from(),
            self.valid_to_raw(),
        )
    }
    pub fn is_visible(&self, generation: u64) -> bool {
        let vf = self.valid_from() as u64;
        if vf > generation {
            return false;
        }
        let vt = self.valid_to_effective();
        vt == 0 || (vt as u64) > generation
    }
    pub fn start(&self) -> u32 {
        u32le(self.meta(), pending_sites::START)
    }
    pub fn end(&self) -> u32 {
        u32le(self.meta(), pending_sites::END)
    }
    pub fn start_line(&self) -> u32 {
        u32le(self.meta(), pending_sites::START_LINE)
    }
    pub fn end_line(&self) -> u32 {
        u32le(self.meta(), pending_sites::END_LINE)
    }
    pub fn site_kind(&self) -> u8 {
        self.meta()[pending_sites::SITE_KIND]
    }
    pub fn reason(&self) -> u8 {
        self.meta()[pending_sites::REASON]
    }
    pub fn source_subject(&self) -> Option<u32> {
        let v = u32le(self.meta(), pending_sites::SOURCE_SUBJECT);
        (v != NONE_U32).then_some(v)
    }
    pub fn key(&self) -> PendingSiteKey {
        self.segment.pending_key_at(self.ordinal)
    }
    pub fn to_row(&self) -> PendingSiteRow {
        PendingSiteRow {
            owner_artifact: self.owner_artifact(),
            owner_version: self.owner_version(),
            valid_from: self.valid_from(),
            valid_to: self.valid_to_effective(),
            start: self.start(),
            end: self.end(),
            start_line: self.start_line(),
            end_line: self.end_line(),
            site_kind: self.site_kind(),
            reason: self.reason(),
            source_subject: self.source_subject(),
        }
    }
}

/// One opened or closed row reported by [`StoreReader::changed_between`].
pub enum ChangeEntry {
    Opened(RecordView),
    Closed { record_id: [u8; 32], valid_to: u32 },
}

pub(crate) struct StoreInner {
    pub dir: PathBuf,
    pub manifest: Manifest,
    /// Newest delta first, base last.
    pub segments: Vec<Arc<Segment>>,
    pub dicts: Dictionaries,
    pub subject_index: HashMap<[u8; 32], u32>,
    /// P3-2 item 6/8 fix: `owner_artifact -> [(segment_index, ordinal)]`,
    /// built ONCE per load/reopen (same pattern as `subject_index` just
    /// above) so [`StoreReader::deps_by_owner`] is an O(1) amortized
    /// lookup instead of a full linear scan of every dependency row in
    /// every segment. Dependency rows have an existing on-disk reverse
    /// index (`Segment::deps_reverse`, keyed by `dep_artifact`) but no
    /// FORWARD one (keyed by `owner_artifact`) -- unlike records, which
    /// have BOTH (`Segment::by_owner` is a real sorted secondary index;
    /// compare `by_owner`'s `quad_key_range` lookup to the `deps_by_owner`
    /// this field replaces, which used to be `for seg { for ord in
    /// 0..seg.deps_n { if view.owner_artifact() == owner_artifact ... } }`
    /// -- an O(total corpus dependency count) scan on EVERY call). This is
    /// an IN-MEMORY-ONLY index (no new on-disk file, no format change,
    /// same additive pattern `subject_index` already establishes in this
    /// same struct): confirmed live as the dominant cost of a hub-edit
    /// mutation at n8n scale (`packages/nodes-base/utils/utilities.ts`,
    /// ~377 importers) -- `delta::run`'s per-owner diff loop calls
    /// `deps_by_owner` once per AFFECTED owner, so before this fix a
    /// hub-edit's own `write_ms` scaled as O(affected_owners x
    /// total_corpus_dependency_rows); measured at ~6.1-6.5s of a ~7-8s
    /// total hub-edit scan before this fix (`docs/evidence/
    /// 2026-09-03-v4-p3-2-incremental-residuals.md`).
    pub dep_owner_index: HashMap<u32, Vec<(usize, usize)>>,
    /// Frente Q-4 (2026-09-08): `identity_id -> [(segment_index, ordinal)]`,
    /// built ONCE per load/reopen (same additive, in-memory-only pattern as
    /// `subject_index`/`dep_owner_index` above -- no new on-disk file, no
    /// format change). `identity_id` (`digests::IDENTITY_ID`, TS-visible as
    /// `entity_id`/`relation_id`/`diagnostic_id` -- always exactly
    /// `record.identity_id` re-exposed under a subject-type-specific field
    /// name) is a DIFFERENT digest than `identity_key_digest` (compare
    /// `urdira-native-core`'s `uce_text_object_digest_bytes` vs.
    /// `uce_text_digest_bytes` -- one wraps the identity_key text in a
    /// labeled UCE object, the other digests it directly), so the existing
    /// on-disk `by_identity` range index (keyed by `identity_key_digest`)
    /// cannot answer an `identity_id` lookup; `identity_id` cannot be
    /// recomputed FROM `identity_key` either without redoing that exact
    /// hash, so a caller-supplied `identity_id` string can only ever be
    /// resolved by an index keyed on ITS OWN bytes. Fixes the gap decision
    /// 25's Q1/Q-3 amendments diagnosed live: `analyze_impact`/
    /// `find_related_tests`'s `entity_id`-shaped target/subject selector
    /// used to fall into `records_by_ids`'s `otherIds` linear `scanAll`
    /// fallback on EVERY call (`docs/evidence/2026-09-08-v4-full-pushdown-
    /// catalog.md` §5.3). See `StoreReader::by_identity_id` for the
    /// visibility-filtered read.
    pub identity_id_index: HashMap<[u8; 32], Vec<(usize, usize)>>,
    pub record_closures: Arc<HashMap<[u8; 32], u32>>,
    /// F1 1.2: mirrors `record_closures` -- the SAME merged `Arc` every
    /// segment's own `dep_closures` field holds (see `load`'s `Arc::
    /// clone` fan-out). Kept at this level (not just per-`Segment`) so
    /// `StoreInner::extend` can fuse it without fishing an arbitrary
    /// segment's copy back out.
    pub dep_closures: Arc<HashMap<[u8; 32], Vec<u32>>>,
    /// F1 1.2: mirrors `record_closures`/`dep_closures` for `closures.
    /// pending`.
    pub pending_closures: Arc<HashMap<PendingSiteKey, Vec<u32>>>,
    pub closure_valid_to_sorted: Vec<u32>,
    pub dep_closure_valid_to_sorted: Vec<u32>,
    pub manifest_mtime: std::time::SystemTime,
    /// Held only for its `Drop` side effect: removes this snapshot's
    /// `structural/.readers/<pid>-...` marker once the last `Arc` to it
    /// is gone, so `compact`'s refcount check stops seeing these
    /// directories as in-use. Never read otherwise.
    #[allow(dead_code)]
    reader_guard: crate::refcount::ReaderGuard,
}

/// P3-3 item 4 / P3-6 item 1: tolerates an ABSENT `dict.bin` section for
/// one segment -- same convention [`load_closures`] below already
/// established -- `build_delta_sections` (`writer.rs`) skips this section
/// entirely for a delta that adds nothing to any of the five dictionaries
/// it covers (kinds/universal_kinds/relation_kinds/names/artifacts), which
/// is common for a steady-state edit of a file whose imports/exports/kinds
/// were all already known. Absent is exactly equivalent to empty here:
/// `Dictionaries::append` (this function's only caller, `StoreInner::
/// load`) is a no-op over `Dictionaries::default()`. Takes the already-read
/// blob (`optional_section_bytes`) rather than a path, so it works
/// identically whether that blob came from a whole standalone file (base)
/// or a zero-copy slice of a shared delta-container mmap.
fn load_dict_file(bytes: Option<Vec<u8>>) -> Result<(Dictionaries, u64)> {
    let Some(bytes) = bytes else {
        return Ok((Dictionaries::default(), 0));
    };
    let header = FileHeader::decode(&bytes)?;
    let mut cursor = &bytes[HEADER_LEN..];
    let dict = read_dict_body(&mut cursor)?;
    Ok((dict, header.row_count))
}

/// P3-3 item 4: same absent-means-empty tolerance as [`load_dict_file`]
/// for `subjects.keys` -- skipped whenever a delta registers no NEW
/// relation subjects.
fn load_subjects_file(bytes: Option<Vec<u8>>) -> Result<Vec<[u8; 32]>> {
    let Some(bytes) = bytes else {
        return Ok(Vec::new());
    };
    FileHeader::decode(&bytes)?;
    let mut cursor = &bytes[HEADER_LEN..];
    Ok(read_subjects_body(&mut cursor)?)
}

fn load_closures(bytes: Option<Vec<u8>>) -> Result<Vec<([u8; 32], u32)>> {
    let Some(bytes) = bytes else {
        return Ok(Vec::new());
    };
    let (_, data) = header_and_data(&bytes)?;
    let n = data.len() / CLOSURE_STRIDE;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let row = &data[i * CLOSURE_STRIDE..(i + 1) * CLOSURE_STRIDE];
        let key: [u8; 32] = row[0..32].try_into().unwrap();
        let vt = u32le(row, 32);
        out.push((key, vt));
    }
    Ok(out)
}

/// Same shape as [`load_closures`] but over `closures.pending`'s 20-byte
/// entries (inline identity fields, not a 32-byte digest key -- see
/// [`crate::layout::PENDING_CLOSURE_STRIDE`]'s own doc comment).
fn load_pending_closures(bytes: Option<Vec<u8>>) -> Result<Vec<(PendingSiteKey, u32)>> {
    let Some(bytes) = bytes else {
        return Ok(Vec::new());
    };
    let (_, data) = header_and_data(&bytes)?;
    let n = data.len() / PENDING_CLOSURE_STRIDE;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let row = &data[i * PENDING_CLOSURE_STRIDE..(i + 1) * PENDING_CLOSURE_STRIDE];
        let key = PendingSiteKey {
            owner_artifact: u32le(row, pending_closure::OWNER_ARTIFACT),
            start: u32le(row, pending_closure::START),
            end: u32le(row, pending_closure::END),
            site_kind: row[pending_closure::SITE_KIND],
        };
        let vt = u32le(row, pending_closure::VALID_TO);
        out.push((key, vt));
    }
    Ok(out)
}

impl StoreInner {
    pub fn load(dir: &Path) -> Result<Self> {
        let manifest_path = dir.join("MANIFEST");
        let manifest = Manifest::read(&manifest_path)?;
        let manifest_mtime = std::fs::metadata(&manifest_path)?.modified()?;

        // P3-6 item 1: a base segment is still a plain directory
        // (`write_base` unchanged); every delta generation is now one
        // `delta-<g>.seg` container file (`container::open_container`,
        // mmapped exactly once here and reused for both this segment's
        // optional dict/subjects/closures sections below AND its
        // mandatory fields in `Segment::open`). No fallback to the
        // pre-P3-6 `delta-<g>/` directory layout -- v4 is unreleased, see
        // `container.rs`'s module doc.
        let mut locations: Vec<OpenedLocation> = Vec::with_capacity(1 + manifest.deltas.len());
        locations.push(OpenedLocation::Dir(dir.join(&manifest.base)));
        for d in &manifest.deltas {
            let path = dir.join(d);
            let (mmap, _generation, ranges) = container::open_container(&path)?;
            locations.push(OpenedLocation::Container { path, mmap, ranges });
        }

        // locations is now [base, delta-oldest, ..., delta-newest]; gather
        // closures across all deltas first. `record_id` closes at most
        // once ever (chained, never reused -- `record_closures` stays a
        // plain last-write-wins `HashMap`, order doesn't matter). Adversarial
        // review fix: `dependency_id`/`PendingSiteKey` are NOT chained and
        // CAN close more than once across a store's history (see `Segment::
        // deps_effective_valid_to`'s doc comment) -- `dep_closures`/
        // `pending_closures` therefore fold into a `Vec<u32>` per key (every
        // closure ever recorded against it, order still irrelevant --
        // `closure_for_row` picks the minimum greater than a row's own
        // `valid_from`), not a `HashMap` overwrite. The base carries no
        // closures by construction (write_base never emits them), so
        // skipping index 0 is just an optimization, not a correctness
        // requirement.
        let mut record_closures = HashMap::new();
        let mut dep_closures: HashMap<[u8; 32], Vec<u32>> = HashMap::new();
        let mut pending_closures: HashMap<PendingSiteKey, Vec<u32>> = HashMap::new();
        for loc in locations.iter().skip(1) {
            let records_bytes =
                optional_section_bytes(loc, "closures.records", SectionId::ClosuresRecords)?;
            for (k, v) in load_closures(records_bytes)? {
                record_closures.insert(k, v);
            }
            let deps_bytes = optional_section_bytes(loc, "closures.deps", SectionId::ClosuresDeps)?;
            for (k, v) in load_closures(deps_bytes)? {
                dep_closures.entry(k).or_default().push(v);
            }
            let pending_bytes =
                optional_section_bytes(loc, "closures.pending", SectionId::ClosuresPending)?;
            for (k, v) in load_pending_closures(pending_bytes)? {
                pending_closures.entry(k).or_default().push(v);
            }
        }
        let record_closures = Arc::new(record_closures);
        let dep_closures = Arc::new(dep_closures);
        let pending_closures = Arc::new(pending_closures);

        let mut dicts = Dictionaries::default();
        let mut subjects: Vec<[u8; 32]> = Vec::new();
        let mut segments = Vec::with_capacity(locations.len());
        for loc in &locations {
            let dict_bytes = optional_section_bytes(loc, "dict.bin", SectionId::DictBin)?;
            let (add, _) = load_dict_file(dict_bytes)?;
            dicts.append(&add);
            let subjects_bytes =
                optional_section_bytes(loc, "subjects.keys", SectionId::SubjectsKeys)?;
            let subj = load_subjects_file(subjects_bytes)?;
            subjects.extend(subj);
            segments.push(Arc::new(Segment::open(
                loc,
                Arc::clone(&record_closures),
                Arc::clone(&dep_closures),
                Arc::clone(&pending_closures),
            )?));
        }
        dicts.subjects = subjects;
        let subject_index: HashMap<[u8; 32], u32> = dicts
            .subjects
            .iter()
            .enumerate()
            .map(|(i, k)| (*k, i as u32))
            .collect();

        // Sample-verify a handful of sections per open (plan §2.6): the
        // base's keys/meta/digests plus the newest segment's keys, if
        // different. Full verification is `StoreReader::verify_all`.
        if let Some(base) = segments.first() {
            // A2: keys/meta/digests are now hashed per-nibble-partition
            // (`hash_of_partition_hashes`), same formula for a base
            // segment (`write_base`/`write_base_partitioned`) and a delta
            // container (`build_delta_sections`'s `encode_framed_
            // partitioned`) alike -- `nibble_row_boundaries` re-derives the
            // boundaries straight from `keys`' own (sorted-by-record_id)
            // bytes.
            let (_, base_keys_data) = header_and_data(&base.keys)?;
            let base_row_boundaries = nibble_row_boundaries(base_keys_data);
            verify_xxh3_partitioned_stride(
                &base.keys,
                &base_row_boundaries,
                KEYS_STRIDE,
                "base/records.keys",
            )?;
            verify_xxh3_partitioned_stride(
                &base.meta,
                &base_row_boundaries,
                META_STRIDE,
                "base/records.meta",
            )?;
            verify_xxh3_partitioned_stride(
                &base.digests,
                &base_row_boundaries,
                DIGESTS_STRIDE,
                "base/records.digests",
            )?;
        }
        if let Some(newest) = segments.last() {
            let (_, newest_keys_data) = header_and_data(&newest.keys)?;
            let newest_row_boundaries = nibble_row_boundaries(newest_keys_data);
            verify_xxh3_partitioned_stride(
                &newest.keys,
                &newest_row_boundaries,
                KEYS_STRIDE,
                "newest/records.keys",
            )?;
        }

        segments.reverse(); // newest delta first, base last

        // P3-2 item 6/8 fix: see `StoreInner::dep_owner_index`'s own doc
        // comment. Built directly off each segment's raw `deps.meta` bytes
        // (`deps_meta_row`/`u32le`) rather than constructing a
        // `DependencyView` per row, avoiding an `Arc` clone for every
        // dependency row in the corpus purely to read one `u32` field.
        let mut dep_owner_index: HashMap<u32, Vec<(usize, usize)>> = HashMap::new();
        for (segment_index, seg) in segments.iter().enumerate() {
            for ordinal in 0..seg.deps_n {
                let owner_artifact = u32le(seg.deps_meta_row(ordinal), deps_meta::OWNER_ARTIFACT);
                dep_owner_index
                    .entry(owner_artifact)
                    .or_default()
                    .push((segment_index, ordinal));
            }
        }

        // Frente Q-4 (2026-09-08): see `StoreInner::identity_id_index`'s own
        // doc comment. Built directly off each segment's raw `records.
        // digests` bytes (`digests_row`/slice), same no-`RecordView`-
        // construction discipline `dep_owner_index` above already
        // establishes for `records.deps_meta`. A zero digest means "this
        // row has no identity_id at all" (a RAW-layout row with no
        // identity, or an artifact-subject/fact/evidence record) -- never
        // indexed, matching `structural_store_napi.rs`'s own `(digest !=
        // [0u8; 32]).then(..)` convention for the SAME field.
        let mut identity_id_index: HashMap<[u8; 32], Vec<(usize, usize)>> = HashMap::new();
        for (segment_index, seg) in segments.iter().enumerate() {
            for ordinal in 0..seg.n {
                let row = seg.digests_row(ordinal);
                let identity_id: [u8; 32] = row[digests::IDENTITY_ID..digests::IDENTITY_ID + 32]
                    .try_into()
                    .unwrap();
                if identity_id != [0u8; 32] {
                    identity_id_index
                        .entry(identity_id)
                        .or_default()
                        .push((segment_index, ordinal));
                }
            }
        }

        let mut closure_valid_to_sorted: Vec<u32> = record_closures.values().copied().collect();
        closure_valid_to_sorted.sort_unstable();
        // Adversarial review fix: `dep_closures.values()` is now `Vec<u32>`
        // per key (one entry per REAL closure event, not one per key) --
        // `flatten()` so `deps_visible_count`'s `extra_closures` subtraction
        // counts every physically closed row once, not once per distinct
        // key (the bug: a twice-closed key used to contribute only one
        // unit to this list, undercounting closures by however many times
        // that key was reused, which made `deps_visible_count` overcount
        // live edges).
        let mut dep_closure_valid_to_sorted: Vec<u32> =
            dep_closures.values().flatten().copied().collect();
        dep_closure_valid_to_sorted.sort_unstable();

        // `manifest.base`/`manifest.deltas` are already bare segment names
        // (a directory name, or -- P3-6 item 1 -- a `delta-<g>.seg` file
        // name); no path manipulation needed to recover them.
        let mut segment_names: Vec<String> = vec![manifest.base.clone()];
        segment_names.extend(manifest.deltas.iter().cloned());
        let reader_guard = crate::refcount::register(dir, &segment_names)?;

        Ok(StoreInner {
            dir: dir.to_path_buf(),
            manifest,
            segments,
            dicts,
            subject_index,
            dep_owner_index,
            identity_id_index,
            record_closures,
            dep_closures,
            pending_closures,
            closure_valid_to_sorted,
            dep_closure_valid_to_sorted,
            manifest_mtime,
            reader_guard,
        })
    }

    /// F1 1.2: incremental reopen. `reopen_if_changed` calls this instead
    /// of [`Self::load`] whenever `fresh_manifest` is confirmed (by the
    /// caller) to be a byte-identical PREFIX extension of `prev`'s own
    /// manifest -- same `base`, same leading `deltas`, only `new_delta_
    /// names` appended (normally exactly one: this process's own just-
    /// published generation). Avoids `load`'s full re-open (base included):
    /// every previously-open segment's mmap/`SectionSource`s/`valid_*_
    /// sorted` are REUSED, not re-scanned; only the new delta(s) pay
    /// `Segment::open`'s per-row parse, and the sample xxh3 verification
    /// checks only the newest new segment's `keys` (the base's own bytes
    /// were already verified whenever THIS process first opened it).
    ///
    /// **Correctness trap (do not "simplify" this away):**
    /// [`Segment::effective_valid_to`]/[`Segment::deps_effective_valid_to`]
    /// read `self.record_closures`/`self.dep_closures` -- a field FIXED
    /// on the `Segment` at `Segment::open` time, not looked up on
    /// `StoreInner` at query time. Every segment produced by ONE `load`/
    /// `extend` call is handed the SAME `Arc<HashMap>` (see the `Arc::
    /// clone` fan-out both here and in `load`), so `is_visible`'s
    /// verdict for a record living in the BASE can depend on a closure
    /// entry written by a delta published many generations later (a new
    /// delta can close a record that lives in an older segment). A naive
    /// incremental reopen that only builds a `Segment` for the NEW
    /// delta(s) and reuses the OLD `Arc<Segment>`s for everything else
    /// would silently keep serving each old segment's STALE closures map
    /// forever -- any record closed by generation G+1 (or later) would
    /// stay visible past its real `valid_to` for every already-open
    /// segment. The fix: every previous segment is rebuilt (`Segment`'s
    /// `#[derive(Clone)]`, see its own doc comment) with the freshly
    /// fused closures `Arc`s substituted in -- cheap (every other field
    /// is a `SectionSource`/`Vec<u32>` clone, an `Arc` bump or a plain
    /// memcpy, never a re-scan of `records.meta`/`deps.meta`), but
    /// mandatory. `reopen_incremental_matches_fresh_open`,
    /// `reopen_falls_back_on_non_prefix_manifest`, and a dedicated test
    /// that closes a BASE record via a new delta and compares `is_
    /// visible`/`by_owner`/`iter_visible` between the incremental and a
    /// from-scratch `StoreReader::open` all guard this.
    fn extend(
        prev: &Arc<StoreInner>,
        dir: &Path,
        fresh_manifest: Manifest,
        manifest_mtime: std::time::SystemTime,
        new_delta_names: &[String],
    ) -> Result<Self> {
        // 1. Open the new delta container(s) only -- oldest of the new
        //    ones first, matching `load`'s "locations" ordering convention
        //    (base first, deltas oldest-to-newest) for the closures/dicts
        //    fold below.
        let mut new_locations: Vec<OpenedLocation> = Vec::with_capacity(new_delta_names.len());
        for name in new_delta_names {
            let path = dir.join(name);
            let (mmap, _generation, ranges) = container::open_container(&path)?;
            new_locations.push(OpenedLocation::Container { path, mmap, ranges });
        }

        // 2. Fuse closures: start from `prev`'s already-merged maps (an
        //    `Arc` bump-then-clone-the-map -- O(existing closures count),
        //    not O(corpus)) and fold each new delta's OWN closures.* on
        //    top. `record_closures` keeps last-write-wins `HashMap::insert`
        //    (a `record_id` closes at most once ever). Adversarial review
        //    fix: `dep_closures`/`pending_closures` APPEND to each key's
        //    `Vec<u32>` instead of overwriting -- see `Segment::deps_
        //    effective_valid_to`'s doc comment for why a key can
        //    legitimately close more than once across the store's history
        //    and why collapsing to one entry per key silently corrupts
        //    both point-in-time reads and `deps_visible_count`.
        let mut record_closures = (*prev.record_closures).clone();
        let mut dep_closures = (*prev.dep_closures).clone();
        let mut pending_closures = (*prev.pending_closures).clone();
        for loc in &new_locations {
            let records_bytes =
                optional_section_bytes(loc, "closures.records", SectionId::ClosuresRecords)?;
            for (k, v) in load_closures(records_bytes)? {
                record_closures.insert(k, v);
            }
            let deps_bytes = optional_section_bytes(loc, "closures.deps", SectionId::ClosuresDeps)?;
            for (k, v) in load_closures(deps_bytes)? {
                dep_closures.entry(k).or_default().push(v);
            }
            let pending_bytes =
                optional_section_bytes(loc, "closures.pending", SectionId::ClosuresPending)?;
            for (k, v) in load_pending_closures(pending_bytes)? {
                pending_closures.entry(k).or_default().push(v);
            }
        }
        let record_closures = Arc::new(record_closures);
        let dep_closures = Arc::new(dep_closures);
        let pending_closures = Arc::new(pending_closures);

        // 3. Dicts/subjects: append-only (`Dictionaries::append`'s own doc
        //    comment) -- start from a clone of `prev.dicts` instead of
        //    `Dictionaries::default()`, fold only the NEW deltas' own
        //    `dict.bin`/`subjects.keys` on top. Mirrors `load`'s own
        //    "`dicts.append` during the loop, `dicts.subjects = subjects`
        //    after" split for the same reason: `dict.bin` never itself
        //    carries `subjects` (that lives in the separate `subjects.
        //    keys` file), so `append`'s own `self.subjects.extend(..)` is
        //    always a no-op in practice; `subjects` is folded explicitly
        //    here instead of via `Dictionaries::append`.
        let mut dicts = prev.dicts.clone();
        let subjects_before = dicts.subjects.len();
        let mut new_subjects: Vec<[u8; 32]> = Vec::new();
        for loc in &new_locations {
            let dict_bytes = optional_section_bytes(loc, "dict.bin", SectionId::DictBin)?;
            let (add, _) = load_dict_file(dict_bytes)?;
            dicts.append(&add);
            let subjects_bytes =
                optional_section_bytes(loc, "subjects.keys", SectionId::SubjectsKeys)?;
            new_subjects.extend(load_subjects_file(subjects_bytes)?);
        }
        dicts.subjects.extend(new_subjects.iter().copied());
        let mut subject_index = prev.subject_index.clone();
        for (i, k) in new_subjects.iter().enumerate() {
            subject_index.insert(*k, (subjects_before + i) as u32);
        }

        // 4. New segments for the new delta(s) only -- `Segment::open`
        //    scans just that segment's own `records.meta`/`deps.meta`
        //    (O(new delta rows), not O(corpus)).
        let mut new_segments: Vec<Arc<Segment>> = Vec::with_capacity(new_locations.len());
        for loc in &new_locations {
            new_segments.push(Arc::new(Segment::open(
                loc,
                Arc::clone(&record_closures),
                Arc::clone(&dep_closures),
                Arc::clone(&pending_closures),
            )?));
        }
        new_segments.reverse(); // newest-first among themselves.

        // Sample-verify only the newest NEW segment's `keys` (plan §1.2
        // step 3): the base's own bytes were already verified the first
        // time this process opened it (`load`'s own sample-verify block),
        // and every carried-forward segment's `SectionSource`s below are
        // untouched bytes, not re-read from disk.
        if let Some(newest_new) = new_segments.first() {
            let (_, newest_keys_data) = header_and_data(&newest_new.keys)?;
            let newest_row_boundaries = nibble_row_boundaries(newest_keys_data);
            verify_xxh3_partitioned_stride(
                &newest_new.keys,
                &newest_row_boundaries,
                KEYS_STRIDE,
                "newest/records.keys",
            )?;
        }

        // 5. Rebuild EVERY previous segment with the fused closures (see
        //    this function's own doc comment for why this is mandatory,
        //    not an optimization to skip) -- `Segment: Clone` makes every
        //    other field an `Arc` bump or a `Vec<u32>` memcpy.
        let mut carried_segments: Vec<Arc<Segment>> = Vec::with_capacity(prev.segments.len());
        for seg in &prev.segments {
            let mut carried = (**seg).clone();
            carried.record_closures = Arc::clone(&record_closures);
            carried.dep_closures = Arc::clone(&dep_closures);
            carried.pending_closures = Arc::clone(&pending_closures);
            carried_segments.push(Arc::new(carried));
        }

        // `segments` convention: newest delta first, base last (same as
        // `load`). The new segments are newer than every carried one.
        let new_segment_count = new_segments.len();
        let mut segments = new_segments;
        segments.extend(carried_segments);

        // 6. `dep_owner_index`: every PREVIOUS `(segment_index, ordinal)`
        //    pair shifts by `+new_segment_count` (the new segments now
        //    occupy indices `[0, new_segment_count)`) -- a plain integer
        //    bump per entry, not a re-parse of any `deps.meta` byte, then
        //    the new segments' own rows are indexed exactly as `load`
        //    does (same `u32le(seg.deps_meta_row(..), OWNER_ARTIFACT)`
        //    read, just scoped to the new segments instead of every
        //    segment in the store).
        let mut dep_owner_index: HashMap<u32, Vec<(usize, usize)>> = prev
            .dep_owner_index
            .iter()
            .map(|(&owner, entries)| {
                (
                    owner,
                    entries
                        .iter()
                        .map(|&(idx, ord)| (idx + new_segment_count, ord))
                        .collect(),
                )
            })
            .collect();
        for (segment_index, seg) in segments[..new_segment_count].iter().enumerate() {
            for ordinal in 0..seg.deps_n {
                let owner_artifact = u32le(seg.deps_meta_row(ordinal), deps_meta::OWNER_ARTIFACT);
                dep_owner_index
                    .entry(owner_artifact)
                    .or_default()
                    .push((segment_index, ordinal));
            }
        }

        // 6b. `identity_id_index`: same shift-then-extend shape as
        //     `dep_owner_index` just above -- see `StoreInner::
        //     identity_id_index`'s own doc comment.
        let mut identity_id_index: HashMap<[u8; 32], Vec<(usize, usize)>> = prev
            .identity_id_index
            .iter()
            .map(|(&identity_id, entries)| {
                (
                    identity_id,
                    entries
                        .iter()
                        .map(|&(idx, ord)| (idx + new_segment_count, ord))
                        .collect(),
                )
            })
            .collect();
        for (segment_index, seg) in segments[..new_segment_count].iter().enumerate() {
            for ordinal in 0..seg.n {
                let row = seg.digests_row(ordinal);
                let identity_id: [u8; 32] = row[digests::IDENTITY_ID..digests::IDENTITY_ID + 32]
                    .try_into()
                    .unwrap();
                if identity_id != [0u8; 32] {
                    identity_id_index
                        .entry(identity_id)
                        .or_default()
                        .push((segment_index, ordinal));
                }
            }
        }

        // 7. `closure_valid_to_sorted`/`dep_closure_valid_to_sorted`:
        //    re-derived from the (small, closures-only) fused maps -- cheap
        //    relative to everything else here, plan §1.2 step 2. Adversarial
        //    review fix: `flatten()` `dep_closures.values()` (now `Vec<u32>`
        //    per key) -- see `load`'s matching comment on why one entry
        //    per REAL closure event is required, not one per distinct key.
        let mut closure_valid_to_sorted: Vec<u32> = record_closures.values().copied().collect();
        closure_valid_to_sorted.sort_unstable();
        let mut dep_closure_valid_to_sorted: Vec<u32> =
            dep_closures.values().flatten().copied().collect();
        dep_closure_valid_to_sorted.sort_unstable();

        // 8. Refcount: register a marker naming the FULL new segment list.
        //    `prev`'s own `ReaderGuard` unregisters itself via `Drop` once
        //    the caller drops its last `Arc<StoreInner>` reference to
        //    `prev` (the same "swap the `Arc`, let the old one's guard
        //    drop naturally" protocol `reopen_if_changed` already relies
        //    on for the full-`load` path -- no explicit "unregister" call
        //    exists or is needed).
        let mut segment_names: Vec<String> = vec![fresh_manifest.base.clone()];
        segment_names.extend(fresh_manifest.deltas.iter().cloned());
        let reader_guard = crate::refcount::register(dir, &segment_names)?;

        Ok(StoreInner {
            dir: dir.to_path_buf(),
            manifest: fresh_manifest,
            segments,
            dicts,
            subject_index,
            dep_owner_index,
            identity_id_index,
            record_closures,
            dep_closures,
            pending_closures,
            closure_valid_to_sorted,
            dep_closure_valid_to_sorted,
            manifest_mtime,
            reader_guard,
        })
    }

    fn generation(&self) -> u64 {
        self.manifest.generation
    }

    /// The row for `key` in ANY segment, regardless of visibility/
    /// `valid_to` -- factored out of [`StoreReader::get`] (which is now a
    /// thin wrapper over this) so [`RecordView::identity_key`]'s relation
    /// endpoint resolution, and `writer.rs`'s delta-side `resolve_identity`
    /// fallback, can look up an arbitrary `record_id` without going back
    /// through a `StoreReader`'s own snapshot lock. `self: &Arc<Self>`
    /// (not a plain `&self`) because the returned [`RecordView`] needs to
    /// hold its own `Arc<StoreInner>` clone.
    pub fn get(self: &Arc<Self>, key: &[u8; 32]) -> Option<RecordView> {
        for seg in &self.segments {
            if let Some(ord) =
                binary_search_exact32(seg.n, KEYS_STRIDE, &seg.keys[HEADER_LEN..], key)
            {
                return Some(RecordView {
                    segment: Arc::clone(seg),
                    store: Arc::clone(self),
                    ordinal: ord,
                });
            }
        }
        None
    }
}

/// F1 1.2: returns `Some(new_delta_names)` when `fresh` is a byte-
/// identical PREFIX extension of `current` -- same `base`, same `format`,
/// `current.deltas` is an exact leading slice of `fresh.deltas` -- so
/// [`StoreInner::extend`] is safe to use instead of a full [`StoreInner
/// ::load`]. `None` for anything else (a new `base` from compaction, a
/// format change, a shorter or diverging delta list, or literally no new
/// deltas at all despite the mtime bump) -- the caller falls back to
/// `load` in every one of those cases, exactly the pre-F1-1.2 behavior.
fn new_delta_suffix(current: &Manifest, fresh: &Manifest) -> Option<Vec<String>> {
    if current.format != fresh.format || current.base != fresh.base {
        return None;
    }
    if fresh.deltas.len() < current.deltas.len() {
        return None;
    }
    if fresh.deltas[..current.deltas.len()] != current.deltas[..] {
        return None;
    }
    Some(fresh.deltas[current.deltas.len()..].to_vec())
}

/// A handle onto an open structural store. Cheap to `clone` (an `Arc`
/// bump); every query snapshots the current generation under a short
/// lock, then runs lock-free against that snapshot.
#[derive(Clone)]
pub struct StoreReader {
    inner: Arc<Mutex<Arc<StoreInner>>>,
    prefault: Arc<Mutex<Vec<std::thread::JoinHandle<()>>>>,
}

struct SelectorRange {
    segment: Arc<Segment>,
    lo: usize,
    hi: usize,
}

type IdentityKeysetAfter<'a> = (&'a [u8], [u8; 32]);
type IdentityKeysetNext = (Vec<u8>, [u8; 32]);

impl StoreReader {
    pub fn open(dir: &Path) -> Result<Self> {
        let inner = load_during_publication(dir)?;
        let prefault = spawn_prefault(&inner);
        Ok(StoreReader {
            inner: Arc::new(Mutex::new(Arc::new(inner))),
            prefault: Arc::new(Mutex::new(prefault)),
        })
    }

    fn snapshot(&self) -> Arc<StoreInner> {
        self.inner.lock().expect("store mutex poisoned").clone()
    }

    /// Blocks until the background page-fault-in started by `open` (or
    /// the last `reopen_if_changed`) has finished. Query correctness
    /// never depends on this -- every mmap is valid to read immediately,
    /// just possibly not yet resident -- it exists so callers (the P2-3
    /// bench in particular) can measure "first query after prefault"
    /// rather than "first query while still racing the prefault thread".
    pub fn wait_prefault(&self) {
        let mut handles = self.prefault.lock().expect("prefault mutex poisoned");
        for h in handles.drain(..) {
            let _ = h.join();
        }
    }

    /// Re-reads `MANIFEST` if its mtime changed since the last load and,
    /// if so, atomically swaps in a freshly mapped snapshot. Returns
    /// whether a reload happened. Cheap when nothing changed (one
    /// `stat`).
    ///
    /// F1 1.2: when the fresh manifest is a byte-identical PREFIX
    /// extension of the currently-held one (see [`new_delta_suffix`]),
    /// goes through [`StoreInner::extend`] instead of a full [`StoreInner
    /// ::load`] -- the common case for `crates/urdira-indexing-worker`'s
    /// `v4::delta::run_one`, which calls this once per `Changed` scan and
    /// (being the SAME process that just published the prior generation)
    /// always sees exactly its own new delta appended. Any other shape of
    /// change (a new base -- compaction; a non-prefix delta list; a
    /// format/mtime change carrying zero new deltas) falls back to the
    /// full `load`, unchanged from before this task.
    pub fn reopen_if_changed(&self) -> Result<bool> {
        let current = self.snapshot();
        let manifest_path = current.dir.join("MANIFEST");
        let mtime = match std::fs::metadata(&manifest_path).and_then(|m| m.modified()) {
            Ok(m) => m,
            Err(_) => return Ok(false),
        };
        if mtime <= current.manifest_mtime {
            return Ok(false);
        }
        let fresh_manifest = Manifest::read(&manifest_path)?;
        let fresh = match new_delta_suffix(&current.manifest, &fresh_manifest) {
            Some(new_delta_names) if !new_delta_names.is_empty() => {
                // F1 review follow-up (cheap, non-load-bearing): every
                // writer in this crate sets `Manifest.dict_generation`
                // to exactly the `generation` it just published
                // (`writer.rs`'s three `dict_generation: generation`
                // sites), and each `write_delta*` call advances
                // `generation` by exactly 1 while appending exactly one
                // delta name -- so catching up `new_delta_names.len()`
                // deltas in one `extend` call must also advance `dict_
                // generation` by exactly that many. A real mismatch here
                // would mean `new_delta_suffix`'s prefix check let
                // through something it should not have.
                debug_assert_eq!(
                    fresh_manifest.dict_generation,
                    current.manifest.dict_generation + new_delta_names.len() as u64,
                    "dict_generation must advance by exactly the number of new deltas being folded in"
                );
                StoreInner::extend(
                    &current,
                    &current.dir,
                    fresh_manifest,
                    mtime,
                    &new_delta_names,
                )?
            }
            _ => StoreInner::load(&current.dir)?,
        };
        let new_prefault = spawn_prefault(&fresh);
        *self.inner.lock().expect("store mutex poisoned") = Arc::new(fresh);
        *self.prefault.lock().expect("prefault mutex poisoned") = new_prefault;
        Ok(true)
    }

    pub fn generation(&self) -> u64 {
        self.snapshot().generation()
    }

    pub fn dictionaries(&self) -> Dictionaries {
        self.snapshot().dicts.clone()
    }

    pub fn manifest(&self) -> Manifest {
        self.snapshot().manifest.clone()
    }

    pub fn dir(&self) -> PathBuf {
        self.snapshot().dir.clone()
    }

    pub fn get(&self, key: &[u8; 32]) -> Option<RecordView> {
        self.snapshot().get(key)
    }

    pub fn get_visible(&self, key: &[u8; 32], generation: u64) -> Option<RecordView> {
        self.get(key).filter(|v| v.is_visible(generation))
    }

    pub fn by_owner(&self, owner: u32, generation: u64) -> Vec<RecordView> {
        let inner = self.snapshot();
        let mut out = Vec::new();
        for seg in &inner.segments {
            let data = &seg.by_owner[HEADER_LEN..];
            let (lo, hi) = quad_key_range(data, owner);
            for i in lo..hi {
                let (_, vf, vt, ord) = quad_at(data, i);
                if vf as u64 > generation {
                    continue;
                }
                let veff = seg.effective_valid_to(ord as usize, vt);
                if veff != 0 && (veff as u64) <= generation {
                    continue;
                }
                out.push(RecordView {
                    segment: Arc::clone(seg),
                    store: Arc::clone(&inner),
                    ordinal: ord as usize,
                });
            }
        }
        out
    }

    pub fn by_name(&self, name_id: u32, generation: u64) -> Vec<RecordView> {
        let inner = self.snapshot();
        let mut out = Vec::new();
        for seg in &inner.segments {
            let data = &seg.by_name[HEADER_LEN..];
            let (lo, hi) = pair2_key_range(data, name_id);
            for i in lo..hi {
                let (_, ord) = pair2_at(data, i);
                let view = RecordView {
                    segment: Arc::clone(seg),
                    store: Arc::clone(&inner),
                    ordinal: ord as usize,
                };
                if view.is_visible(generation) {
                    out.push(view);
                }
            }
        }
        out
    }

    /// F4 4.3: `entities.index` lookup -- exactly the `(owner_path ->
    /// owner_artifact ordinal, span_start_byte) -> record_id` correlation
    /// `urdira-tsgo-client::entity_index::EntityIndex` used to build from a
    /// full `iter_visible` scan (`urdira-indexing-worker`'s `v4::residual::
    /// collect`), now O(sites) via a per-segment binary search instead of
    /// O(corpus). `(owner_artifact, span_start)` is expected unique among
    /// LIVE rows within one segment's own entity population (the `jsts:
    /// entity_inferred_type` exclusion at write time exists specifically to
    /// keep it that way, see `segment_io::is_entities_index_row`'s doc
    /// comment) -- but a genuine collision among several still-live
    /// entities at the exact same span DOES occur in practice (confirmed
    /// live: the shared `task-planner` fixture has exactly one, at
    /// `start=0`, a pre-existing imprecision this section does not
    /// introduce). This function scans EVERY segment (not "first segment
    /// hit wins") and, among every VISIBLE candidate sharing the key,
    /// deterministically picks the one with the greatest `valid_from`
    /// (the most recently OPENED row); ties broken by the NEWEST segment
    /// (`inner.segments`' own newest-first ordering); ties still remaining
    /// (two rows in the very same segment's own key range, both visible,
    /// both opened at the same `valid_from`) broken by the greater
    /// `ordinal`. This rule is arbitrary but STABLE across repeated calls
    /// against the same store snapshot (unlike an unordered "first hit in
    /// whatever order the binary search range happens to enumerate"),
    /// matching decision 26's amendment. See `docs/decisions/
    /// 26-v4-structural-store.md`'s `entities.index` section for the same
    /// rule spelled out at the format level.
    pub fn entity_by_owner_and_start(
        &self,
        owner: u32,
        start: u32,
        generation: u64,
    ) -> Option<RecordView> {
        let inner = self.snapshot();
        // `(valid_from, newest-segment-first rank, ordinal)` -- compared
        // with a plain tuple `>` so "greatest wins" reads directly off the
        // doc comment's own tie-break order. `seg_rank` is the REVERSE of
        // `inner.segments`' own index (segment 0 is newest) so a smaller
        // segment index -- newer -- compares as a LARGER `seg_rank`.
        let segment_count = inner.segments.len();
        let mut best: Option<(u32, usize, usize, RecordView)> = None;
        for (seg_index, seg) in inner.segments.iter().enumerate() {
            let seg_rank = segment_count - seg_index;
            let data = &seg.entities_index[HEADER_LEN..];
            let (lo, hi) = triple_key_range(data, owner, start);
            for i in lo..hi {
                let ord = triple_ordinal_at(data, i) as usize;
                let view = RecordView {
                    segment: Arc::clone(seg),
                    store: Arc::clone(&inner),
                    ordinal: ord,
                };
                if !view.is_visible(generation) {
                    continue;
                }
                let candidate_key = (view.valid_from(), seg_rank, ord);
                let is_better = match &best {
                    None => true,
                    Some((valid_from, rank, ordinal, _)) => {
                        candidate_key > (*valid_from, *rank, *ordinal)
                    }
                };
                if is_better {
                    best = Some((candidate_key.0, candidate_key.1, candidate_key.2, view));
                }
            }
        }
        best.map(|(_, _, _, view)| view)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn by_kind(
        &self,
        universal_kind_id: u16,
        category: u8,
        kind_id: u16,
        generation: u64,
        limit: usize,
        after_key: Option<[u8; 32]>,
    ) -> Vec<RecordView> {
        let inner = self.snapshot();
        // Gather candidates from every segment, then sort by record_id so
        // pagination via `after_key` is well-defined across segments.
        let mut candidates: Vec<RecordView> = Vec::new();
        for seg in &inner.segments {
            let data = &seg.by_kind[HEADER_LEN..];
            let (lo, hi) = by_kind_range(data, universal_kind_id, category, kind_id);
            for i in lo..hi {
                let ord = by_kind_ordinal_at(data, i) as usize;
                let view = RecordView {
                    segment: Arc::clone(seg),
                    store: Arc::clone(&inner),
                    ordinal: ord,
                };
                if view.is_visible(generation) {
                    candidates.push(view);
                }
            }
        }
        candidates.sort_by_key(|v| v.record_id());
        let start = match after_key {
            Some(k) => candidates.partition_point(|v| v.record_id() <= k),
            None => 0,
        };
        candidates.into_iter().skip(start).take(limit).collect()
    }

    /// Frente Q-3 (2026-09-08): sibling of `by_kind` for "every kind under
    /// this `(universal_kind, category)`" instead of one exact `kind` --
    /// see `by_kind_universal_range`'s own doc comment (`segment_io.rs`)
    /// for why the engine layer needs this rather than enumerating kinds
    /// itself. Same per-segment range-then-merge-then-sort shape as
    /// `by_kind`, minus `kind_id`/`after_key` (this store's only caller,
    /// `core:inspect_architecture`'s pushdown, has no pagination need --
    /// its own `INSPECT_ARCHITECTURE_PUSHDOWN_LIMIT` already bounds the
    /// result and declines pushdown outright above it).
    pub fn by_kind_universal(
        &self,
        universal_kind_id: u16,
        category: u8,
        generation: u64,
        limit: usize,
    ) -> Vec<RecordView> {
        let inner = self.snapshot();
        let mut candidates: Vec<RecordView> = Vec::new();
        for seg in &inner.segments {
            let data = &seg.by_kind[HEADER_LEN..];
            let (lo, hi) = by_kind_universal_range(data, universal_kind_id, category);
            for i in lo..hi {
                let ord = by_kind_ordinal_at(data, i) as usize;
                let view = RecordView {
                    segment: Arc::clone(seg),
                    store: Arc::clone(&inner),
                    ordinal: ord,
                };
                if view.is_visible(generation) {
                    candidates.push(view);
                }
            }
        }
        candidates.sort_by_key(|v| v.record_id());
        candidates.into_iter().take(limit).collect()
    }

    /// Exact paged union over the existing kind indexes. Empty `kinds` means
    /// every producer kind under each `(universal_kind, category)` prefix;
    /// empty `universal_kinds` or `categories` are expanded by the caller.
    /// Results are merged by the canonical record id, so a cursor is stable
    /// across segments and selector combinations without scanning records.
    pub fn by_kind_selector(
        &self,
        universal_kind_ids: &[u16],
        categories: &[u8],
        kind_ids: &[u16],
        generation: u64,
        limit: usize,
        after_key: Option<[u8; 32]>,
    ) -> (Vec<RecordView>, Option<[u8; 32]>) {
        if limit == 0 || universal_kind_ids.is_empty() || categories.is_empty() {
            return (Vec::new(), None);
        }
        let inner = self.snapshot();
        let mut ranges = Vec::new();
        for &universal_kind_id in universal_kind_ids {
            for &category in categories {
                for &kind_id in if kind_ids.is_empty() {
                    &[u16::MAX][..]
                } else {
                    kind_ids
                } {
                    for segment in &inner.segments {
                        let data = &segment.by_kind[HEADER_LEN..];
                        let (lo, hi) = if kind_id == u16::MAX {
                            by_kind_universal_range(data, universal_kind_id, category)
                        } else {
                            by_kind_range(data, universal_kind_id, category, kind_id)
                        };
                        if lo < hi {
                            ranges.push(SelectorRange {
                                segment: Arc::clone(segment),
                                lo,
                                hi,
                            });
                        }
                    }
                }
            }
        }
        // `by_kind` is sorted by selector tuple, not by record id. Keep only
        // the smallest `limit` visible keys in a bounded max-heap, then emit
        // them in key order. This is incremental in memory and remains exact
        // across segments and continuation cursors without collecting the
        // result set globally.
        let mut heap: std::collections::BinaryHeap<([u8; 32], usize, usize)> =
            std::collections::BinaryHeap::new();
        // Selector combinations can overlap (for example, duplicate values
        // in a caller's selector). Keep only keys currently represented in
        // the bounded page heap; this prevents duplicate rows without
        // retaining a corpus-sized seen-set.
        let mut heap_keys = std::collections::HashSet::<[u8; 32]>::with_capacity(limit);
        for (index, range) in ranges.iter().enumerate() {
            let data = &range.segment.by_kind[HEADER_LEN..];
            for position in range.lo..range.hi {
                let ordinal = by_kind_ordinal_at(data, position) as usize;
                let view = RecordView {
                    segment: Arc::clone(&range.segment),
                    store: Arc::clone(&inner),
                    ordinal,
                };
                if !view.is_visible(generation) {
                    continue;
                }
                let key = view.record_id();
                if after_key.is_some_and(|after| key <= after) {
                    continue;
                }
                if heap_keys.contains(&key) {
                    continue;
                }
                if heap.len() < limit {
                    heap.push((key, index, ordinal));
                    heap_keys.insert(key);
                } else if let Some(max) = heap.peek()
                    && key < max.0
                {
                    let removed = heap.pop().expect("heap is non-empty");
                    heap_keys.remove(&removed.0);
                    heap.push((key, index, ordinal));
                    heap_keys.insert(key);
                }
            }
        }
        let mut selected: Vec<_> = heap.into_iter().collect();
        selected.sort_by_key(|entry| entry.0);
        let out = selected
            .into_iter()
            .map(|(_key, range_index, ordinal)| RecordView {
                segment: Arc::clone(&ranges[range_index].segment),
                store: Arc::clone(&inner),
                ordinal,
            })
            .collect::<Vec<_>>();
        let next_cursor = (out.len() == limit)
            .then(|| out.last().map(|view| view.record_id()))
            .flatten();
        (out, next_cursor)
    }

    /// Counts visible rows in the existing `by_kind` selector ranges without
    /// constructing `RecordView`s or transferring record bodies. Callers
    /// must provide duplicate-free selector dimensions; the native binding
    /// normalizes those dimensions before reaching this method.
    pub fn count_by_kind_selector(
        &self,
        universal_kind_ids: &[u16],
        categories: &[u8],
        kind_ids: &[u16],
        generation: u64,
    ) -> u64 {
        if universal_kind_ids.is_empty() || categories.is_empty() {
            return 0;
        }
        let inner = self.snapshot();
        let mut count = 0u64;
        for &universal_kind_id in universal_kind_ids {
            for &category in categories {
                for &kind_id in if kind_ids.is_empty() {
                    &[u16::MAX][..]
                } else {
                    kind_ids
                } {
                    for segment in &inner.segments {
                        let data = &segment.by_kind[HEADER_LEN..];
                        let (lo, hi) = if kind_id == u16::MAX {
                            by_kind_universal_range(data, universal_kind_id, category)
                        } else {
                            by_kind_range(data, universal_kind_id, category, kind_id)
                        };
                        for position in lo..hi {
                            let ordinal = by_kind_ordinal_at(data, position) as usize;
                            let view = RecordView {
                                segment: Arc::clone(segment),
                                store: Arc::clone(&inner),
                                ordinal,
                            };
                            if view.is_visible(generation) {
                                count += 1;
                            }
                        }
                    }
                }
            }
        }
        count
    }

    /// Keyset page over the existing `records.by_identity` index. The index
    /// is keyed by identity digest, so the indexed candidates are inspected
    /// and compared by their reconstructed identity text; only the bounded
    /// output heap is retained. No corpus/result materialization or new
    /// index is performed.
    pub fn by_identity_keyset(
        &self,
        generation: u64,
        limit: usize,
        after: Option<IdentityKeysetAfter<'_>>,
    ) -> (Vec<RecordView>, Option<IdentityKeysetNext>) {
        if limit == 0 {
            return (Vec::new(), None);
        }
        let inner = self.snapshot();
        let mut heap: std::collections::BinaryHeap<(Vec<u8>, [u8; 32], usize, usize)> =
            std::collections::BinaryHeap::new();
        let mut heap_ids = std::collections::HashSet::<[u8; 32]>::with_capacity(limit);
        for (segment_index, segment) in inner.segments.iter().enumerate() {
            let data = &segment.by_identity[HEADER_LEN..];
            let entries = data.len() / BY_IDENTITY_STRIDE;
            for position in 0..entries {
                let ordinal = by_identity_ordinal_at(data, position) as usize;
                let view = RecordView {
                    segment: Arc::clone(segment),
                    store: Arc::clone(&inner),
                    ordinal,
                };
                if !view.is_visible(generation) {
                    continue;
                }
                let record_id = view.record_id();
                let identity_key = view.identity_key().into_owned();
                if after.is_some_and(|(key, id)| {
                    identity_key.as_slice() < key
                        || (identity_key.as_slice() == key && record_id <= id)
                }) {
                    continue;
                }
                if heap_ids.contains(&record_id) {
                    continue;
                }
                if heap.len() < limit {
                    heap.push((identity_key, record_id, segment_index, ordinal));
                    heap_ids.insert(record_id);
                } else if let Some(max) = heap.peek()
                    && (identity_key.as_slice(), record_id) < (max.0.as_slice(), max.1)
                {
                    let removed = heap.pop().expect("heap is non-empty");
                    heap_ids.remove(&removed.1);
                    heap.push((identity_key, record_id, segment_index, ordinal));
                    heap_ids.insert(record_id);
                }
            }
        }
        let mut selected: Vec<_> = heap.into_iter().collect();
        selected.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
        let next = selected.last().map(|entry| (entry.0.clone(), entry.1));
        let full = selected.len() == limit;
        let out = selected
            .into_iter()
            .map(|(_key, _id, segment_index, ordinal)| RecordView {
                segment: Arc::clone(&inner.segments[segment_index]),
                store: Arc::clone(&inner),
                ordinal,
            })
            .collect();
        (out, (next.is_some() && full).then_some(next).flatten())
    }

    pub fn by_identity_last(&self, identity_key_digest: &[u8; 32]) -> Option<RecordView> {
        let inner = self.snapshot();
        let mut best: Option<RecordView> = None;
        for seg in &inner.segments {
            let data = &seg.by_identity[HEADER_LEN..];
            let (lo, hi) = by_identity_range(data, identity_key_digest);
            for i in lo..hi {
                let ord = by_identity_ordinal_at(data, i) as usize;
                let view = RecordView {
                    segment: Arc::clone(seg),
                    store: Arc::clone(&inner),
                    ordinal: ord,
                };
                let better = match &best {
                    None => true,
                    Some(b) => view.valid_from() > b.valid_from(),
                };
                if better {
                    best = Some(view);
                }
            }
        }
        best
    }

    /// Frente Q-4 (2026-09-08): visibility-filtered counterpart of
    /// [`Self::by_identity_last`] -- that method is `writer.rs`'s own
    /// diffing primitive ("the most recent version of this identity_key,
    /// period", used to compute a delta against, `is_visible` deliberately
    /// NOT checked there) and is unsafe to reuse for a live query: it can
    /// return a row that has since been superseded or tombstoned. This
    /// reuses the SAME on-disk `by_identity` range (`identity_key_digest`
    /// -> candidates, `by_identity_range`/`by_identity_ordinal_at`, no new
    /// section) but only ever returns a candidate `is_visible(generation)`
    /// at the REQUESTED generation, picking the highest `valid_from` among
    /// those -- the same "visible candidates, newest wins" shape every
    /// other generation-aware lookup in this file already uses (`by_kind`,
    /// `deps_by_owner`, `by_identity_id` below).
    pub fn by_identity_key(
        &self,
        identity_key_digest: &[u8; 32],
        generation: u64,
    ) -> Option<RecordView> {
        let inner = self.snapshot();
        let mut best: Option<RecordView> = None;
        for seg in &inner.segments {
            let data = &seg.by_identity[HEADER_LEN..];
            let (lo, hi) = by_identity_range(data, identity_key_digest);
            for i in lo..hi {
                let ord = by_identity_ordinal_at(data, i) as usize;
                let view = RecordView {
                    segment: Arc::clone(seg),
                    store: Arc::clone(&inner),
                    ordinal: ord,
                };
                if !view.is_visible(generation) {
                    continue;
                }
                let better = match &best {
                    None => true,
                    Some(b) => view.valid_from() > b.valid_from(),
                };
                if better {
                    best = Some(view);
                }
            }
        }
        best
    }

    /// Frente Q-4 (2026-09-08): O(1) amortized via `StoreInner::
    /// identity_id_index` -- see that field's own doc comment for why
    /// `identity_id` (TS `entity_id`/`relation_id`/`diagnostic_id`) needs
    /// its OWN index rather than reusing `by_identity_key`/`by_identity_last`
    /// (a different digest of the same underlying `identity_key` text, not
    /// invertible from one to the other). Same "visible candidates, newest
    /// wins" shape as `by_identity_key` just above, sourced from the
    /// in-memory candidate list instead of a re-scanned on-disk range.
    pub fn by_identity_id(&self, identity_id: &[u8; 32], generation: u64) -> Option<RecordView> {
        let inner = self.snapshot();
        let candidates = inner.identity_id_index.get(identity_id)?;
        let mut best: Option<RecordView> = None;
        for &(segment_index, ordinal) in candidates {
            let seg = &inner.segments[segment_index];
            let view = RecordView {
                segment: Arc::clone(seg),
                store: Arc::clone(&inner),
                ordinal,
            };
            if !view.is_visible(generation) {
                continue;
            }
            let better = match &best {
                None => true,
                Some(b) => view.valid_from() > b.valid_from(),
            };
            if better {
                best = Some(view);
            }
        }
        best
    }

    pub fn subject_ordinal(&self, subject_key: &[u8; 32]) -> Option<u32> {
        self.snapshot().subject_index.get(subject_key).copied()
    }

    pub fn adjacency(
        &self,
        subject_key: &[u8; 32],
        direction: Direction,
        generation: u64,
    ) -> Vec<RecordView> {
        let inner = self.snapshot();
        let Some(subject_ord) = inner.subject_index.get(subject_key).copied() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for seg in &inner.segments {
            let arr = match direction {
                Direction::Out => &seg.adj_out,
                Direction::In => &seg.adj_in,
            };
            let data = &arr[HEADER_LEN..];
            let (lo, hi) = quad_key_range(data, subject_ord);
            for i in lo..hi {
                let (_, vf, vt, ord) = quad_at(data, i);
                if vf as u64 > generation {
                    continue;
                }
                let veff = seg.effective_valid_to(ord as usize, vt);
                if veff != 0 && (veff as u64) <= generation {
                    continue;
                }
                out.push(RecordView {
                    segment: Arc::clone(seg),
                    store: Arc::clone(&inner),
                    ordinal: ord as usize,
                });
            }
        }
        out
    }

    /// P3-2 item 6/8 fix: O(1) amortized via `StoreInner::dep_owner_index`
    /// instead of a full linear scan of every dependency row in every
    /// segment (see that field's own doc comment for the n8n-scale hub-edit
    /// cost this used to incur -- confirmed the dominant cost of that
    /// mutation's own `write_ms`).
    pub fn deps_by_owner(&self, owner_artifact: u32, generation: u64) -> Vec<DependencyView> {
        let inner = self.snapshot();
        let Some(candidates) = inner.dep_owner_index.get(&owner_artifact) else {
            return Vec::new();
        };
        let mut out = Vec::with_capacity(candidates.len());
        for &(segment_index, ordinal) in candidates {
            let seg = &inner.segments[segment_index];
            let view = DependencyView {
                segment: Arc::clone(seg),
                ordinal,
            };
            if view.is_visible(generation) {
                out.push(view);
            }
        }
        out
    }

    pub fn deps_reverse(&self, dep_artifact: u32, generation: u64) -> Vec<DependencyView> {
        let inner = self.snapshot();
        let mut out = Vec::new();
        for seg in &inner.segments {
            let data = &seg.deps_reverse[HEADER_LEN..];
            let (lo, hi) = deps_reverse_range(data, dep_artifact);
            for i in lo..hi {
                let ord = deps_reverse_ordinal_at(data, i) as usize;
                let view = DependencyView {
                    segment: Arc::clone(seg),
                    ordinal: ord,
                };
                if view.is_visible(generation) {
                    out.push(view);
                }
            }
        }
        out
    }

    /// K-way merged iterator over every segment's `records.keys` in
    /// ascending key order, visibility-filtered at `generation`. Each
    /// key appears in exactly one segment (record ids are never
    /// reused), so this is a plain merge, not a dedup.
    pub fn iter_visible(&self, generation: u64) -> VisibleIter {
        let inner = self.snapshot();
        let mut heap = std::collections::BinaryHeap::new();
        for (seg_idx, seg) in inner.segments.iter().enumerate() {
            if seg.n > 0 {
                let key = seg.key_at(0);
                heap.push(std::cmp::Reverse((key, seg_idx, 0usize)));
            }
        }
        VisibleIter {
            inner,
            heap,
            generation,
        }
    }

    pub fn iter_visible_batches(
        &self,
        generation: u64,
        batch_size: usize,
    ) -> impl Iterator<Item = Vec<RecordView>> {
        let mut it = self.iter_visible(generation).peekable();
        std::iter::from_fn(move || {
            it.peek()?;
            let mut batch = Vec::with_capacity(batch_size);
            for _ in 0..batch_size {
                match it.next() {
                    Some(v) => batch.push(v),
                    None => break,
                }
            }
            (!batch.is_empty()).then_some(batch)
        })
    }

    pub fn iter_visible_deps(&self, generation: u64) -> Vec<DependencyView> {
        let inner = self.snapshot();
        let mut out = Vec::new();
        for seg in &inner.segments {
            for ord in 0..seg.deps_n {
                let view = DependencyView {
                    segment: Arc::clone(seg),
                    ordinal: ord,
                };
                if view.is_visible(generation) {
                    out.push(view);
                }
            }
        }
        out
    }

    /// Visible pending sites for one owner, in `(owner, start, end, kind)`
    /// order. `owner_artifact` is `pending.sites`' PRIMARY sort key, so
    /// this is a direct binary-search range per segment -- no secondary
    /// index file is needed (unlike `records.by_owner`, a real secondary
    /// index over a table primarily sorted by `record_id`).
    pub fn pending_sites_by_owner(
        &self,
        owner_artifact: u32,
        generation: u64,
    ) -> Vec<PendingSiteView> {
        let inner = self.snapshot();
        let mut out = Vec::new();
        for seg in &inner.segments {
            let Some(pending) = &seg.pending else {
                continue;
            };
            let data = &pending[HEADER_LEN..];
            let (lo, hi) = pending_site_owner_range(data, owner_artifact);
            for ord in lo..hi {
                let view = PendingSiteView {
                    segment: Arc::clone(seg),
                    ordinal: ord,
                };
                if view.is_visible(generation) {
                    out.push(view);
                }
            }
        }
        out.sort_by_key(|v| v.key());
        out
    }

    /// Every visible pending site across every segment, in `(owner, start,
    /// end, kind)` order.
    pub fn iter_visible_pending_sites(&self, generation: u64) -> Vec<PendingSiteView> {
        let inner = self.snapshot();
        let mut out = Vec::new();
        for seg in &inner.segments {
            for ord in 0..seg.pending_n {
                let view = PendingSiteView {
                    segment: Arc::clone(seg),
                    ordinal: ord,
                };
                if view.is_visible(generation) {
                    out.push(view);
                }
            }
        }
        out.sort_by_key(|v| v.key());
        out
    }

    /// Count of pending sites visible at `generation`. A plain scan (the
    /// table is orders of magnitude smaller than `records`/`deps`, so this
    /// does not need `visible_count`'s O(log n) sorted-array machinery).
    pub fn pending_sites_visible_count(&self, generation: u64) -> u64 {
        self.iter_visible_pending_sites(generation).len() as u64
    }

    /// The visible row for `key` at `generation`, if any. A key may occur
    /// in several segments across generations (closed in one, reopened in
    /// a later one) -- this returns whichever occurrence is visible at
    /// `generation` (at most one, since a key closes at most once per
    /// segment and `is_visible` is generation-exact).
    pub fn pending_site(&self, key: &PendingSiteKey, generation: u64) -> Option<PendingSiteView> {
        let inner = self.snapshot();
        for seg in &inner.segments {
            let Some(pending) = &seg.pending else {
                continue;
            };
            let data = &pending[HEADER_LEN..];
            let (lo, hi) = pending_site_key_range(data, key);
            for ord in lo..hi {
                let view = PendingSiteView {
                    segment: Arc::clone(seg),
                    ordinal: ord,
                };
                if view.is_visible(generation) {
                    return Some(view);
                }
            }
        }
        None
    }

    /// Visible `(record_id, record_digest)` pairs whose `record_id` falls
    /// in the given merkle bucket -- used by the delta writer to answer
    /// `BucketedMerkleSet::update`'s `bucket_entries` callback. Records
    /// are keyed by `record_id` and each segment's `records.keys` is
    /// sorted by that same key, so the bucket's members are one
    /// contiguous binary-searchable range per segment (the bucket index
    /// is exactly the key's top 20 bits).
    pub fn visible_entries_in_bucket(
        &self,
        bucket_idx: u32,
        generation: u64,
    ) -> Vec<(crate::merkle::Digest32, crate::merkle::Digest32)> {
        let inner = self.snapshot();
        let (lo_key, hi_key) = crate::merkle::bucket_key_bounds(bucket_idx);
        let mut out = Vec::new();
        for seg in &inner.segments {
            let data = &seg.keys[HEADER_LEN..];
            let lo = lower_bound(seg.n, |i| data[i * 32..i * 32 + 32].cmp(lo_key.as_slice()));
            let hi = lower_bound(seg.n, |i| data[i * 32..i * 32 + 32].cmp(hi_key.as_slice()));
            for ord in lo..hi {
                let view = RecordView {
                    segment: Arc::clone(seg),
                    store: Arc::clone(&inner),
                    ordinal: ord,
                };
                if view.is_visible(generation) {
                    out.push((view.record_id(), view.record_digest()));
                }
            }
        }
        out
    }

    /// Same as [`Self::visible_entries_in_bucket`] but over
    /// `deps.keys`/`dependency_id`.
    pub fn visible_dep_entries_in_bucket(
        &self,
        bucket_idx: u32,
        generation: u64,
    ) -> Vec<(crate::merkle::Digest32, crate::merkle::Digest32)> {
        let inner = self.snapshot();
        let (lo_key, hi_key) = crate::merkle::bucket_key_bounds(bucket_idx);
        let mut out = Vec::new();
        for seg in &inner.segments {
            let data = &seg.deps_keys[HEADER_LEN..];
            let lo = lower_bound(seg.deps_n, |i| {
                data[i * 32..i * 32 + 32].cmp(lo_key.as_slice())
            });
            let hi = lower_bound(seg.deps_n, |i| {
                data[i * 32..i * 32 + 32].cmp(hi_key.as_slice())
            });
            for ord in lo..hi {
                let view = DependencyView {
                    segment: Arc::clone(seg),
                    ordinal: ord,
                };
                if view.is_visible(generation) {
                    out.push((
                        view.dependency_id(),
                        crate::merkle::dependency_logical_view(&view),
                    ));
                }
            }
        }
        out
    }

    /// Rows opened in a delta with `g1 < generation <= g2`, plus every
    /// closure recorded in that generation range.
    pub fn changed_between(&self, g1: u64, g2: u64) -> Vec<ChangeEntry> {
        let inner = self.snapshot();
        let mut out = Vec::new();
        for seg in &inner.segments {
            if seg.generation > g1 && seg.generation <= g2 {
                for ord in 0..seg.n {
                    out.push(ChangeEntry::Opened(RecordView {
                        segment: Arc::clone(seg),
                        store: Arc::clone(&inner),
                        ordinal: ord,
                    }));
                }
            }
        }
        // Closures are keyed by the closing generation, which is not
        // segment-addressable directly (closures.records stores
        // per-key valid_to, not which delta produced it) -- so scan the
        // merged closure map and match by value. Closure volume is
        // "tens of thousands at most between compactions" per plan
        // §2.3, so a linear scan here is intentional and bounded.
        for (key, valid_to_raw) in inner.record_closures.iter() {
            let valid_to = *valid_to_raw as u64;
            if valid_to > g1 && valid_to <= g2 {
                out.push(ChangeEntry::Closed {
                    record_id: *key,
                    valid_to: *valid_to_raw,
                });
            }
        }
        out
    }

    /// Exact count of rows visible at `generation`, computed in
    /// O(log n) per segment plus O(log closures) -- never a full scan.
    /// See the module doc for the derivation: per segment,
    /// `count(valid_from<=g) - count(own valid_to!=0 && own valid_to<=g)`,
    /// summed, minus `count(closure valid_to<=g)` (closures always
    /// target rows whose owning segment still shows `valid_to==0`, so
    /// this never double-subtracts).
    pub fn visible_count(&self, generation: u64) -> u64 {
        let inner = self.snapshot();
        // On-disk `valid_from`/`valid_to` fields are u32; generations in
        // practice never approach that range, so this cast is lossless.
        let g = generation as u32;
        let mut total: i64 = 0;
        for seg in &inner.segments {
            let open_by_from = lower_bound(seg.valid_from_sorted.len(), |i| {
                seg.valid_from_sorted[i].cmp(&(g.saturating_add(1)))
            }) as i64;
            let closed_by_to = lower_bound(seg.valid_to_sorted.len(), |i| {
                seg.valid_to_sorted[i].cmp(&(g.saturating_add(1)))
            }) as i64;
            total += open_by_from - closed_by_to;
        }
        let extra_closures = lower_bound(inner.closure_valid_to_sorted.len(), |i| {
            inner.closure_valid_to_sorted[i].cmp(&(g.saturating_add(1)))
        }) as i64;
        total -= extra_closures;
        total.max(0) as u64
    }

    /// Same derivation as [`Self::visible_count`], over dependency rows.
    pub fn deps_visible_count(&self, generation: u64) -> u64 {
        let inner = self.snapshot();
        let g = generation as u32;
        let mut total: i64 = 0;
        for seg in &inner.segments {
            let open_by_from = lower_bound(seg.deps_valid_from_sorted.len(), |i| {
                seg.deps_valid_from_sorted[i].cmp(&(g.saturating_add(1)))
            }) as i64;
            let closed_by_to = lower_bound(seg.deps_valid_to_sorted.len(), |i| {
                seg.deps_valid_to_sorted[i].cmp(&(g.saturating_add(1)))
            }) as i64;
            total += open_by_from - closed_by_to;
        }
        let extra_closures = lower_bound(inner.dep_closure_valid_to_sorted.len(), |i| {
            inner.dep_closure_valid_to_sorted[i].cmp(&(g.saturating_add(1)))
        }) as i64;
        total -= extra_closures;
        total.max(0) as u64
    }

    /// Verifies the xxh3 stored in every mapped file's header against a
    /// recomputed hash of its data region (plan §2.6: "verificado ... por
    /// muestreo [on open]; verificación completa disponible"). Returns
    /// the first mismatch found, if any.
    pub fn verify_all(&self) -> Result<()> {
        let inner = self.snapshot();
        for seg in &inner.segments {
            // A2: the 5 hot `records.*` sections are hashed per-nibble-
            // partition (`hash_of_partition_hashes`) by every writer
            // (`write_base`/`write_base_partitioned`/`build_delta_
            // sections`) -- verified together via `verify_records_hot_
            // partitioned`, which re-derives the nibble boundaries from
            // `keys`/`meta` themselves. The other 10 mandatory sections
            // (9 pre-F4-4.3, plus `entities.index`) are never partitioned,
            // so they keep the plain whole-data `verify_xxh3`.
            verify_records_hot_partitioned(
                &seg.keys,
                &seg.meta,
                &seg.digests,
                &seg.body,
                &seg.ident,
                "records",
            )?;
            for (name, section) in [
                ("records.by_owner", &seg.by_owner),
                ("records.by_name", &seg.by_name),
                ("records.by_kind", &seg.by_kind),
                ("records.by_identity", &seg.by_identity),
                ("adj.out", &seg.adj_out),
                ("adj.in", &seg.adj_in),
                ("entities.index", &seg.entities_index),
                ("deps.keys", &seg.deps_keys),
                ("deps.meta", &seg.deps_meta),
                ("deps.reverse", &seg.deps_reverse),
            ] {
                verify_xxh3(section, name)?;
            }
            // `pending.sites`/`closures.pending` are OPTIONAL (absent for
            // a pre-existing segment or one with nothing to report), so
            // they're checked separately from the fixed mandatory list
            // above rather than folded into it.
            if let Some(pending) = &seg.pending {
                verify_xxh3(pending, "pending.sites")?;
            }
            if let Some(closures_pending) = &seg.closures_pending {
                verify_xxh3(closures_pending, "closures.pending")?;
            }
        }
        Ok(())
    }
}

/// Opens a store while tolerating the short replacement window used by the
/// Windows publisher. Windows cannot rename over an existing file, so the
/// publisher removes the old manifest/tree before renaming the fully-written
/// replacement into place. A reader that lands in that gap should retry the
/// load, not report a torn store to its caller.
#[cfg(windows)]
fn load_during_publication(dir: &Path) -> Result<StoreInner> {
    let mut last_error = None;
    for _ in 0..100 {
        match StoreInner::load(dir) {
            Ok(inner) => return Ok(inner),
            Err(error) => {
                last_error = Some(error);
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        }
    }
    Err(last_error.expect("publication retry loop always records an error"))
}

#[cfg(not(windows))]
fn load_during_publication(dir: &Path) -> Result<StoreInner> {
    StoreInner::load(dir)
}

/// K-way merge cursor over every segment's `records.keys`, yielding
/// records in ascending key order. See [`StoreReader::iter_visible`].
pub struct VisibleIter {
    inner: Arc<StoreInner>,
    heap: std::collections::BinaryHeap<std::cmp::Reverse<([u8; 32], usize, usize)>>,
    generation: u64,
}

impl Iterator for VisibleIter {
    type Item = RecordView;

    fn next(&mut self) -> Option<RecordView> {
        loop {
            let std::cmp::Reverse((_, seg_idx, local_idx)) = self.heap.pop()?;
            let seg = &self.inner.segments[seg_idx];
            let next_idx = local_idx + 1;
            if next_idx < seg.n {
                let next_key = seg.key_at(next_idx);
                self.heap
                    .push(std::cmp::Reverse((next_key, seg_idx, next_idx)));
            }
            let view = RecordView {
                segment: Arc::clone(seg),
                store: Arc::clone(&self.inner),
                ordinal: local_idx,
            };
            if view.is_visible(self.generation) {
                return Some(view);
            }
        }
    }
}

/// Frente Q-2 (2026-09-08, `docs/evidence/2026-09-08-v4-query-gaps-vscode.md`
/// gap 3): added `entities_index` and `pending` (both previously omitted) to
/// the pre-touched section list. `entities_index` backs `entity_by_owner_
/// and_start` (the residual pass's owner+span correlation); `pending` backs
/// `pending_sites_by_owner`, which `core:get_outline`'s OWN pushdown
/// (`pendingSitesStreamForOutline`, `canonical-query-data-port.ts`) reads on
/// every call for a module-shaped container. Both are INDEX-shaped sections
/// (small, sorted-key tables), never the multi-gigabyte `body`/`ident`
/// record-content sections -- this list stays bounded to "sections a query
/// walks to find WHICH records/sites exist", never "the record content
/// itself", matching this task's own §0 scope (pre-touch the indices, not
/// the records).
fn spawn_prefault(inner: &StoreInner) -> Vec<std::thread::JoinHandle<()>> {
    let mut handles = Vec::new();
    for seg in inner.segments.iter().cloned() {
        handles.push(std::thread::spawn(move || {
            touch_pages(&seg.keys);
            touch_pages(&seg.meta);
            touch_pages(&seg.by_owner);
            touch_pages(&seg.by_name);
            touch_pages(&seg.by_kind);
            touch_pages(&seg.by_identity);
            touch_pages(&seg.adj_out);
            touch_pages(&seg.adj_in);
            touch_pages(&seg.entities_index);
            if let Some(pending) = &seg.pending {
                touch_pages(pending);
            }
        }));
    }
    handles
}

const PAGE_SIZE: usize = 4096;

fn touch_pages(section: &[u8]) {
    let mut acc: u64 = 0;
    let mut i = 0usize;
    while i < section.len() {
        acc = acc.wrapping_add(section[i] as u64);
        i += PAGE_SIZE;
    }
    std::hint::black_box(acc);
}
