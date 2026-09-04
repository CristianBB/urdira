//! P3-6 item 1: the single-file delta container.
//!
//! Before this module, one delta generation wrote a *directory*
//! (`delta-<g>/`) holding 5-18 separate small files (the hot `records.*`
//! files, the six secondary sorted-index arrays, `deps.*`, the optional
//! `dict.bin`/`subjects.keys`/`closures.*`), and `manifest::
//! fsync_segment_dir` paid one `File::sync_all()` (macOS: `F_FULLFSYNC`,
//! a genuine device-level cache flush, not a cheap syscall) **per file**
//! — up to 18 per delta, dominating a steady-state edit's `write_ms`
//! (`docs/evidence/2026-09-03-v4-p3-3-digest-churn.md` §4). This module
//! packs every one of those sections into ONE file, `delta-<g>.seg`, with
//! a small table-of-contents header, so a delta generation pays exactly
//! one `File::sync_all()` total instead of one per section.
//!
//! **Section byte layouts are unchanged** — a section's bytes inside the
//! container are byte-for-byte identical to what the pre-P3-6 standalone
//! file of the same name would have contained (the same 64-byte
//! `layout::FileHeader` followed by the same body). This is what lets the
//! reader's existing decoding code (every `records.meta`/`records.by_owner`/
//! ... accessor in `reader.rs`, all written against a plain `&[u8]`) work
//! completely unchanged over a [`crate::segment_io::SectionSource::
//! Container`] view — only *where* those bytes live changes (a byte range
//! inside one shared mmap instead of their own file's mmap).
//!
//! **Base segments are NOT affected**: `write_base` still writes one file
//! per logical name, each individually fsynced at cold, exactly as before
//! (`docs/evidence/2026-09-02-v4-p2-3-structural-store.md`) — cold writes
//! are already amortized over a whole-corpus scan, and `compact` always
//! produces a base, never a container, so this module has no cold-path
//! caller.
//!
//! **No backward compatibility with the pre-P3-6 delta *directory*
//! layout**: v4 is unreleased (no on-disk store from before this change
//! needs to keep opening), so `reader::Segment::open` only understands a
//! delta generation as `delta-<g>.seg`. Every crate-owned writer
//! (`write_delta_with_reader`, the tests in this crate) was updated in the
//! same change; nothing outside this crate names a delta's internal file
//! layout directly (grepped: only this crate's own `tests/recovery_test.rs`
//! did, and that test was updated alongside this module).

use crate::error::{Result, store_err};
use crate::segment_io::mmap_file;
use memmap2::Mmap;
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;

pub const CONTAINER_MAGIC: &[u8; 4] = b"URDC";
pub const CONTAINER_FORMAT: u16 = 1;
pub const CONTAINER_HEADER_LEN: usize = 64;
pub const TOC_ENTRY_STRIDE: usize = 32;

/// Every logical section a delta generation may carry. Numeric values are
/// part of the on-disk format (stored in each TOC entry) and must never be
/// reused for a different meaning.
#[repr(u16)]
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash, PartialOrd, Ord)]
pub enum SectionId {
    RecordsKeys = 1,
    RecordsMeta = 2,
    RecordsDigests = 3,
    RecordsBody = 4,
    RecordsIdent = 5,
    RecordsByOwner = 6,
    RecordsByName = 7,
    RecordsByKind = 8,
    RecordsByIdentity = 9,
    AdjOut = 10,
    AdjIn = 11,
    DepsKeys = 12,
    DepsMeta = 13,
    DepsReverse = 14,
    DictBin = 15,
    SubjectsKeys = 16,
    ClosuresRecords = 17,
    ClosuresDeps = 18,
    PendingSites = 19,
    ClosuresPending = 20,
}

impl SectionId {
    pub fn from_u16(v: u16) -> Option<Self> {
        Some(match v {
            1 => Self::RecordsKeys,
            2 => Self::RecordsMeta,
            3 => Self::RecordsDigests,
            4 => Self::RecordsBody,
            5 => Self::RecordsIdent,
            6 => Self::RecordsByOwner,
            7 => Self::RecordsByName,
            8 => Self::RecordsByKind,
            9 => Self::RecordsByIdentity,
            10 => Self::AdjOut,
            11 => Self::AdjIn,
            12 => Self::DepsKeys,
            13 => Self::DepsMeta,
            14 => Self::DepsReverse,
            15 => Self::DictBin,
            16 => Self::SubjectsKeys,
            17 => Self::ClosuresRecords,
            18 => Self::ClosuresDeps,
            19 => Self::PendingSites,
            20 => Self::ClosuresPending,
            _ => return None,
        })
    }

    /// Matches the pre-P3-6 standalone file name for this section --
    /// used only in error messages / debug labels.
    pub fn label(self) -> &'static str {
        match self {
            Self::RecordsKeys => "records.keys",
            Self::RecordsMeta => "records.meta",
            Self::RecordsDigests => "records.digests",
            Self::RecordsBody => "records.body",
            Self::RecordsIdent => "records.ident",
            Self::RecordsByOwner => "records.by_owner",
            Self::RecordsByName => "records.by_name",
            Self::RecordsByKind => "records.by_kind",
            Self::RecordsByIdentity => "records.by_identity",
            Self::AdjOut => "adj.out",
            Self::AdjIn => "adj.in",
            Self::DepsKeys => "deps.keys",
            Self::DepsMeta => "deps.meta",
            Self::DepsReverse => "deps.reverse",
            Self::DictBin => "dict.bin",
            Self::SubjectsKeys => "subjects.keys",
            Self::ClosuresRecords => "closures.records",
            Self::ClosuresDeps => "closures.deps",
            Self::PendingSites => "pending.sites",
            Self::ClosuresPending => "closures.pending",
        }
    }
}

/// One section as seen by the writer: its id and its full blob (a
/// [`crate::segment_io::encode_framed`] output -- 64-byte header + body).
pub type EncodedSection = (SectionId, Vec<u8>);

/// A parsed container's table of contents: `section_id -> [start, end)`
/// absolute byte range within the container file, covering that section's
/// whole blob (header + data), i.e. exactly what a standalone file's own
/// mmap would have looked like.
pub type SectionRanges = HashMap<SectionId, (usize, usize)>;

/// Result of [`write_container_to_page_cache`]: the still-open file (not
/// yet fsynced) plus bookkeeping the caller needs afterward.
pub struct UncommittedContainer {
    file: std::fs::File,
    pub total_bytes: u64,
    pub body_xxh3: u64,
}

/// Encodes `sections` (in the given order) into one new file at `path`: a
/// 64-byte container header, every section blob back-to-back, then a
/// table-of-contents array (section_id, offset, length, xxh3 -- of that
/// section's own blob bytes). Buffered sequential I/O only (one in-memory
/// `Vec<u8>` build, one `write_all`) -- **no fsync here**, so a caller
/// timing its own page-cache-vs-durable split (`writer::
/// write_delta_with_reader`'s sub-timers) can capture "page cache reached"
/// before paying for [`commit_container`]'s single durability call. No
/// tmp+rename dance for the container file itself: `generation` is always
/// a fresh, never-before-used number for an unpublished delta, so a
/// half-written `delta-<g>.seg` left behind by a crash before `commit_
/// container` (or before `MANIFEST` publish) runs is simply an
/// unreferenced file `recover()` deletes, exactly like a half-written
/// `delta-<g>/` directory was before this change.
pub fn write_container_to_page_cache(
    path: &Path,
    generation: u64,
    sections: &[EncodedSection],
) -> Result<UncommittedContainer> {
    let blob_bytes: usize = sections.iter().map(|(_, b)| b.len()).sum();
    let mut buf =
        Vec::with_capacity(CONTAINER_HEADER_LEN + blob_bytes + sections.len() * TOC_ENTRY_STRIDE);
    buf.resize(CONTAINER_HEADER_LEN, 0);

    struct TocRow {
        id: SectionId,
        offset: u64,
        length: u64,
        xxh3: u64,
    }
    let mut toc = Vec::with_capacity(sections.len());
    for (id, blob) in sections {
        let offset = buf.len() as u64;
        let xxh3 = crate::xxh::hash(blob);
        buf.extend_from_slice(blob);
        toc.push(TocRow {
            id: *id,
            offset,
            length: blob.len() as u64,
            xxh3,
        });
    }

    let toc_offset = buf.len() as u64;
    for row in &toc {
        buf.extend_from_slice(&(row.id as u16).to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes()); // reserved
        buf.extend_from_slice(&0u32.to_le_bytes()); // reserved (pad to 8)
        buf.extend_from_slice(&row.offset.to_le_bytes());
        buf.extend_from_slice(&row.length.to_le_bytes());
        buf.extend_from_slice(&row.xxh3.to_le_bytes());
    }

    buf[0..4].copy_from_slice(CONTAINER_MAGIC);
    buf[4..6].copy_from_slice(&CONTAINER_FORMAT.to_le_bytes());
    // buf[6..8] reserved, left zero
    buf[8..16].copy_from_slice(&generation.to_le_bytes());
    buf[16..24].copy_from_slice(&(sections.len() as u64).to_le_bytes());
    buf[24..32].copy_from_slice(&toc_offset.to_le_bytes());
    // buf[32..64] reserved, left zero

    let body_xxh3 = crate::xxh::hash(&buf[CONTAINER_HEADER_LEN..]);
    let total_bytes = buf.len() as u64;
    let f = std::fs::File::create(path)
        .map_err(|e| store_err!("create delta container {}: {e}", path.display()))?;
    {
        let mut w = std::io::BufWriter::new(&f);
        w.write_all(&buf)
            .map_err(|e| store_err!("write delta container {}: {e}", path.display()))?;
        w.flush()
            .map_err(|e| store_err!("flush delta container {}: {e}", path.display()))?;
    }
    Ok(UncommittedContainer {
        file: f,
        total_bytes,
        body_xxh3,
    })
}

/// The ONE durability call for the whole delta generation (P3-6 item 1's
/// whole point): `File::sync_all` (macOS: `F_FULLFSYNC`) once on the
/// already-written container, instead of once per section as the old
/// per-file `delta-<g>/` directory layout paid via `fsync_segment_dir`.
pub fn commit_container(container: UncommittedContainer) -> Result<()> {
    container
        .file
        .sync_all()
        .map_err(|e| store_err!("fsync delta container: {e}"))
}

/// Opens `path` (mmaps once) and returns the shared mmap plus the parsed
/// section byte ranges. Does not verify per-section xxh3 eagerly (that
/// would be an O(container) pass on every open); `StoreReader::verify_all`
/// still checks every section's OWN embedded `layout::FileHeader` xxh3 --
/// the same guarantee base segments already only get on-demand, not on
/// every open.
pub fn open_container(path: &Path) -> Result<(Arc<Mmap>, u64, SectionRanges)> {
    let mmap = Arc::new(mmap_file(path)?);
    if mmap.len() < CONTAINER_HEADER_LEN {
        return Err(store_err!(
            "delta container {} shorter than its header",
            path.display()
        ));
    }
    if &mmap[0..4] != CONTAINER_MAGIC {
        return Err(store_err!("delta container {} bad magic", path.display()));
    }
    let format = u16::from_le_bytes(mmap[4..6].try_into().unwrap());
    if format != CONTAINER_FORMAT {
        return Err(store_err!(
            "delta container {} unsupported format {format}",
            path.display()
        ));
    }
    let generation = u64::from_le_bytes(mmap[8..16].try_into().unwrap());
    let section_count = u64::from_le_bytes(mmap[16..24].try_into().unwrap()) as usize;
    let toc_offset = u64::from_le_bytes(mmap[24..32].try_into().unwrap()) as usize;

    let toc_end = toc_offset + section_count * TOC_ENTRY_STRIDE;
    if toc_end > mmap.len() {
        return Err(store_err!(
            "delta container {} truncated table of contents",
            path.display()
        ));
    }

    let mut ranges = HashMap::with_capacity(section_count);
    for i in 0..section_count {
        let row = &mmap[toc_offset + i * TOC_ENTRY_STRIDE..toc_offset + (i + 1) * TOC_ENTRY_STRIDE];
        let id_raw = u16::from_le_bytes(row[0..2].try_into().unwrap());
        let id = SectionId::from_u16(id_raw).ok_or_else(|| {
            store_err!(
                "delta container {} unknown section id {id_raw}",
                path.display()
            )
        })?;
        let offset = u64::from_le_bytes(row[8..16].try_into().unwrap()) as usize;
        let length = u64::from_le_bytes(row[16..24].try_into().unwrap()) as usize;
        let end = offset.checked_add(length).ok_or_else(|| {
            store_err!(
                "delta container {} section {id_raw} overflows",
                path.display()
            )
        })?;
        if end > mmap.len() {
            return Err(store_err!(
                "delta container {} section {:?} out of bounds",
                path.display(),
                id
            ));
        }
        ranges.insert(id, (offset, end));
    }

    Ok((mmap, generation, ranges))
}
