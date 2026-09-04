//! Read side: `memmap2`-backed segments (base + deltas), merged closures,
//! merged append-only dictionaries, and the query surface listed in the
//! task brief. All state is held behind `Arc` snapshots so `StoreReader`
//! clones are cheap and every query runs against one immutable snapshot
//! -- concurrent readers never observe a torn state across a manifest
//! swap (`reopen_if_changed`).

use crate::container::{self, SectionId, SectionRanges};
use crate::dict::{read_dict_body, read_subjects_body};
use crate::error::{Result, store_err};
use crate::layout::*;
use crate::manifest::Manifest;
use crate::row::{Dictionaries, NONE_U32};
use crate::segment_io::*;
use memmap2::Mmap;
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
    pub deps_keys: SectionSource,
    pub deps_meta: SectionSource,
    pub deps_reverse: SectionSource,
    pub n: usize,
    pub deps_n: usize,
    /// This segment's own inline `valid_from`/`valid_to` (nonzero only),
    /// sorted ascending, for the O(log n) `visible_count` term.
    pub valid_from_sorted: Vec<u32>,
    pub valid_to_sorted: Vec<u32>,
    pub deps_valid_from_sorted: Vec<u32>,
    pub deps_valid_to_sorted: Vec<u32>,
    pub record_closures: Arc<HashMap<[u8; 32], u32>>,
    pub dep_closures: Arc<HashMap<[u8; 32], u32>>,
}

fn open_data(dir: &Path, name: &str) -> Result<Mmap> {
    mmap_file(&dir.join(name))
}

impl Segment {
    fn open(
        loc: &OpenedLocation,
        record_closures: Arc<HashMap<[u8; 32], u32>>,
        dep_closures: Arc<HashMap<[u8; 32], u32>>,
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
        let deps_keys = section("deps.keys", SectionId::DepsKeys)?;
        let (deps_header, _) = header_and_data(&deps_keys)?;
        let deps_n = deps_header.row_count as usize;
        let deps_meta = section("deps.meta", SectionId::DepsMeta)?;
        let deps_reverse = section("deps.reverse", SectionId::DepsReverse)?;

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
            deps_keys,
            deps_meta,
            deps_reverse,
            n,
            deps_n,
            valid_from_sorted,
            valid_to_sorted,
            deps_valid_from_sorted,
            deps_valid_to_sorted,
            record_closures,
            dep_closures,
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

    pub fn deps_effective_valid_to(&self, ordinal: usize, inline_valid_to: u32) -> u32 {
        if self.dep_closures.is_empty() {
            return inline_valid_to;
        }
        let key = self.deps_key_at(ordinal);
        self.dep_closures
            .get(&key)
            .copied()
            .unwrap_or(inline_valid_to)
    }
}

/// A live handle onto one record row, borrowed from its owning segment's
/// mmap. Cheap to clone (an `Arc` bump).
#[derive(Clone)]
pub struct RecordView {
    pub(crate) segment: Arc<Segment>,
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
    pub fn body(&self) -> &[u8] {
        let off = u64le(self.meta(), meta::BODY_OFF) as usize;
        let len = u32le(self.meta(), meta::BODY_LEN) as usize;
        &self.segment.body[HEADER_LEN + off..HEADER_LEN + off + len]
    }
    pub fn identity_key(&self) -> &[u8] {
        let off = u64le(self.meta(), meta::IDENT_OFF) as usize;
        let len = u32le(self.meta(), meta::IDENT_LEN) as usize;
        &self.segment.ident[HEADER_LEN + off..HEADER_LEN + off + len]
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
            .deps_effective_valid_to(self.ordinal, self.valid_to_raw())
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
    pub record_closures: Arc<HashMap<[u8; 32], u32>>,
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
        // closures across all deltas first (order doesn't matter, each key
        // closes at most once). The base carries no closures by
        // construction (write_base never emits them), so skipping index 0
        // is just an optimization, not a correctness requirement.
        let mut record_closures = HashMap::new();
        let mut dep_closures = HashMap::new();
        for loc in locations.iter().skip(1) {
            let records_bytes =
                optional_section_bytes(loc, "closures.records", SectionId::ClosuresRecords)?;
            for (k, v) in load_closures(records_bytes)? {
                record_closures.insert(k, v);
            }
            let deps_bytes = optional_section_bytes(loc, "closures.deps", SectionId::ClosuresDeps)?;
            for (k, v) in load_closures(deps_bytes)? {
                dep_closures.insert(k, v);
            }
        }
        let record_closures = Arc::new(record_closures);
        let dep_closures = Arc::new(dep_closures);

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
            verify_xxh3(&base.keys, "base/records.keys")?;
            verify_xxh3(&base.meta, "base/records.meta")?;
            verify_xxh3(&base.digests, "base/records.digests")?;
        }
        if let Some(newest) = segments.last() {
            verify_xxh3(&newest.keys, "newest/records.keys")?;
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

        let mut closure_valid_to_sorted: Vec<u32> = record_closures.values().copied().collect();
        closure_valid_to_sorted.sort_unstable();
        let mut dep_closure_valid_to_sorted: Vec<u32> = dep_closures.values().copied().collect();
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
            record_closures,
            closure_valid_to_sorted,
            dep_closure_valid_to_sorted,
            manifest_mtime,
            reader_guard,
        })
    }

    fn generation(&self) -> u64 {
        self.manifest.generation
    }
}

/// A handle onto an open structural store. Cheap to `clone` (an `Arc`
/// bump); every query snapshots the current generation under a short
/// lock, then runs lock-free against that snapshot.
#[derive(Clone)]
pub struct StoreReader {
    inner: Arc<Mutex<Arc<StoreInner>>>,
    prefault: Arc<Mutex<Vec<std::thread::JoinHandle<()>>>>,
}

impl StoreReader {
    pub fn open(dir: &Path) -> Result<Self> {
        let inner = StoreInner::load(dir)?;
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
        let fresh = StoreInner::load(&current.dir)?;
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
        let inner = self.snapshot();
        for seg in &inner.segments {
            if let Some(ord) =
                binary_search_exact32(seg.n, KEYS_STRIDE, &seg.keys[HEADER_LEN..], key)
            {
                return Some(RecordView {
                    segment: Arc::clone(seg),
                    ordinal: ord,
                });
            }
        }
        None
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
                    ordinal: ord as usize,
                };
                if view.is_visible(generation) {
                    out.push(view);
                }
            }
        }
        out
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
            for (name, section) in [
                ("records.keys", &seg.keys),
                ("records.meta", &seg.meta),
                ("records.digests", &seg.digests),
                ("records.body", &seg.body),
                ("records.ident", &seg.ident),
                ("records.by_owner", &seg.by_owner),
                ("records.by_name", &seg.by_name),
                ("records.by_kind", &seg.by_kind),
                ("records.by_identity", &seg.by_identity),
                ("adj.out", &seg.adj_out),
                ("adj.in", &seg.adj_in),
                ("deps.keys", &seg.deps_keys),
                ("deps.meta", &seg.deps_meta),
                ("deps.reverse", &seg.deps_reverse),
            ] {
                verify_xxh3(section, name)?;
            }
        }
        Ok(())
    }
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
                ordinal: local_idx,
            };
            if view.is_visible(self.generation) {
                return Some(view);
            }
        }
    }
}

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
