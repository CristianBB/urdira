//! Fixed on-disk byte layout for structural-store segment files. Fields are
//! read/written at explicit byte offsets rather than via `#[repr(C)]`
//! struct casts, so nothing here imposes an alignment requirement on
//! mmap'd bytes (following `urdira-v4-spike`'s `layout.rs`).
//!
//! Every segment file (per plan §2.2) starts with a common 64-byte header:
//! magic `URD4`, `table_id` (u16), `row_count` (u64), `generation` (u64),
//! `xxh3` of the body (u64), reserved.

use crate::error::{Result, store_err};

pub const HEADER_LEN: usize = 64;
pub const HEADER_MAGIC: &[u8; 4] = b"URD4";
/// A3a (2026-09-05): bumped 4->5 for the `records.meta` `IDENTITY_LAYOUT`
/// byte (`meta::IDENTITY_LAYOUT`, offset 89) -- no migration, a store
/// written at format 4 fails to open with a clear error (`FileHeader::
/// decode` below); the daemon reindexes from scratch. See `identity_codec`'s
/// module doc for the mechanism this format bump enables.
pub const HEADER_FORMAT: u16 = 5;

pub const KEYS_STRIDE: usize = 32;
pub const DIGESTS_STRIDE: usize = 160; // record_digest, body_digest, identity_id, identity_key_digest, previous_record_id
pub const META_STRIDE: usize = 96;
pub const PAIR2_STRIDE: usize = 8; // (u32, u32) -- by_name
pub const VALIDITY_QUAD_STRIDE: usize = 16; // (u32, u32, u32, u32) -- by_owner / adj.out / adj.in (inline validity)
pub const BY_KIND_STRIDE: usize = 9; // (u16, u8, u16, u32)
pub const BY_IDENTITY_STRIDE: usize = 36; // (32B digest, u32)
pub const CLOSURE_STRIDE: usize = 36; // (32B key, u32 valid_to)

pub const DEPS_KEYS_STRIDE: usize = 32;
pub const DEPS_META_STRIDE: usize = 32;
pub const DEPS_REVERSE_STRIDE: usize = 8; // (u32 dep_artifact, u32 ordinal)

/// One `pending.sites` row (38 bytes used, 2 reserved).
pub const PENDING_SITE_STRIDE: usize = 40;
/// One `closures.pending` entry: `(owner_artifact u32, start u32, end u32,
/// site_kind u8, 3 reserved bytes, valid_to u32)` -- unlike `CLOSURE_
/// STRIDE` (32-byte digest key + valid_to), a pending site has no
/// standalone key file to reference, so its identity fields are inlined
/// here directly.
pub const PENDING_CLOSURE_STRIDE: usize = 20;

#[repr(u16)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TableId {
    Records = 1,
    Dependencies = 2,
    Dict = 3,
    SubjectsKeys = 4,
    PendingSites = 5,
}

/// Byte offsets within one `records.meta` row (96-byte stride; 89 bytes
/// used, 7 reserved). `facets` is a u64 bitmask here (the plan's §2.2 table
/// specifies u32; the task brief for this crate explicitly widens it to u64
/// -- see the deviation note in the evidence doc).
pub mod meta {
    pub const OWNER_ARTIFACT: usize = 0;
    pub const OWNER_VERSION: usize = 4;
    pub const VALID_FROM: usize = 8;
    pub const VALID_TO: usize = 12;
    pub const CATEGORY: usize = 16;
    pub const KIND_ID: usize = 17;
    pub const UNIVERSAL_KIND_ID: usize = 19;
    pub const FACETS: usize = 21;
    pub const SPAN_ARTIFACT_VERSION: usize = 29;
    pub const SPAN_START_BYTE: usize = 33;
    pub const SPAN_END_BYTE: usize = 37;
    pub const SPAN_START_LINE: usize = 41;
    pub const SPAN_END_LINE: usize = 45;
    pub const IDENTITY_TYPE: usize = 49;
    pub const ASSIGNMENT_KIND: usize = 50;
    pub const NAME_ID: usize = 51;
    pub const SOURCE_SUBJECT: usize = 55;
    pub const TARGET_SUBJECT: usize = 59;
    pub const RELATION_KIND_ID: usize = 63;
    pub const BODY_OFF: usize = 65;
    pub const BODY_LEN: usize = 73;
    pub const IDENT_OFF: usize = 77;
    pub const IDENT_LEN: usize = 85;
    /// A3a: one byte, `IDENTITY_LAYOUT_{RAW,ENTITY,RELATION}` below --
    /// whether `records.ident`'s `IDENT_OFF..IDENT_OFF+IDENT_LEN` bytes are
    /// this row's real identity key (`RAW`, `IDENT_LEN` > 0, the pre-A3a
    /// behavior and the default for a zero-initialized row) or the
    /// candidate string reconstructed from this row's OWN typed fields was
    /// found to be byte-for-byte identical to the producer's original
    /// identity key, so the store elides storing it at all (`ENTITY`/
    /// `RELATION`, `IDENT_LEN` == 0). See `crate::identity_codec`.
    pub const IDENTITY_LAYOUT: usize = 89;
    #[allow(dead_code)] // documents the byte budget vs the 96B stride
    pub const USED: usize = 90;

    /// This row's `identity_key()` bytes are stored verbatim in
    /// `records.ident` at `IDENT_OFF..IDENT_OFF+IDENT_LEN` -- either
    /// because the producer's string could not be reconstructed from this
    /// row's typed fields (external/type-of/diagnostic/v3-converted/test
    /// identities, or a relation whose endpoint isn't resolvable), or
    /// because a store written before A3a never classified anything (a
    /// zero-initialized `records.meta` byte reads as this value, matching
    /// the pre-A3a "always store the real bytes" behavior exactly).
    pub const IDENTITY_LAYOUT_RAW: u8 = 0;
    /// This row is a `CATEGORY_ENTITY` row whose identity key is exactly
    /// `jsts:{kind}:{path}:{start}:{name}` reconstructed from `kind_id`/
    /// `owner_artifact`/`span_start_byte`/`name_id` -- `IDENT_LEN` is 0,
    /// nothing is stored in `records.ident` for this row.
    pub const IDENTITY_LAYOUT_ENTITY: u8 = 1;
    /// This row is a `CATEGORY_RELATION` row whose identity key is exactly
    /// `jsts:{rel}:{path}:{start}:{end}:{source_identity_key}:
    /// {target_identity_key}` reconstructed from `kind_id`/`owner_artifact`/
    /// `span_start_byte`/`span_end_byte`/`source_subject`/`target_subject`
    /// (the two endpoints' own identity keys, resolved one level deep via
    /// `dicts.subjects` -> `record_id` -> that record's own `identity_key
    /// ()`) -- `IDENT_LEN` is 0, nothing is stored in `records.ident` for
    /// this row.
    pub const IDENTITY_LAYOUT_RELATION: u8 = 2;
}

pub mod digests {
    pub const RECORD_DIGEST: usize = 0;
    pub const BODY_DIGEST: usize = 32;
    pub const IDENTITY_ID: usize = 64;
    pub const IDENTITY_KEY_DIGEST: usize = 96;
    pub const PREVIOUS_RECORD_ID: usize = 128;
}

/// Byte offsets within one `deps.meta` row (32-byte stride; 29 used, 3
/// reserved).
pub mod deps_meta {
    pub const RECORD_ORD: usize = 0;
    pub const OWNER_ARTIFACT: usize = 4;
    pub const OWNER_VERSION: usize = 8;
    pub const DEP_ARTIFACT: usize = 12;
    pub const DEP_VERSION: usize = 16;
    pub const ROLE: usize = 20;
    pub const VALID_FROM: usize = 21;
    pub const VALID_TO: usize = 25;
    #[allow(dead_code)]
    pub const USED: usize = 29;
}

/// Byte offsets within one `pending.sites` row (40-byte stride; 38 used,
/// 2 reserved).
pub mod pending_sites {
    pub const OWNER_ARTIFACT: usize = 0;
    pub const OWNER_VERSION: usize = 4;
    pub const VALID_FROM: usize = 8;
    pub const VALID_TO: usize = 12;
    pub const START: usize = 16;
    pub const END: usize = 20;
    pub const START_LINE: usize = 24;
    pub const END_LINE: usize = 28;
    pub const SITE_KIND: usize = 32;
    pub const REASON: usize = 33;
    pub const SOURCE_SUBJECT: usize = 34;
    #[allow(dead_code)]
    pub const USED: usize = 38;
}

/// Byte offsets within one `closures.pending` entry (20-byte stride; 17
/// used -- `SITE_KIND` is 1 byte, `RESERVED` 3 bytes -- 3 reserved).
pub mod pending_closure {
    pub const OWNER_ARTIFACT: usize = 0;
    pub const START: usize = 4;
    pub const END: usize = 8;
    pub const SITE_KIND: usize = 12;
    pub const VALID_TO: usize = 16;
}

#[inline]
pub fn u16le(buf: &[u8], off: usize) -> u16 {
    u16::from_le_bytes(buf[off..off + 2].try_into().unwrap())
}
#[inline]
pub fn u32le(buf: &[u8], off: usize) -> u32 {
    u32::from_le_bytes(buf[off..off + 4].try_into().unwrap())
}
#[inline]
pub fn u64le(buf: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(buf[off..off + 8].try_into().unwrap())
}
#[inline]
pub fn put_u16le(buf: &mut [u8], off: usize, v: u16) {
    buf[off..off + 2].copy_from_slice(&v.to_le_bytes());
}
#[inline]
pub fn put_u32le(buf: &mut [u8], off: usize, v: u32) {
    buf[off..off + 4].copy_from_slice(&v.to_le_bytes());
}
#[inline]
pub fn put_u64le(buf: &mut [u8], off: usize, v: u64) {
    buf[off..off + 8].copy_from_slice(&v.to_le_bytes());
}

/// The common 64-byte file header.
#[derive(Clone, Copy, Debug)]
pub struct FileHeader {
    pub table_id: u16,
    pub row_count: u64,
    pub generation: u64,
    pub body_xxh3: u64,
}

impl FileHeader {
    pub fn encode(&self) -> [u8; HEADER_LEN] {
        let mut h = [0u8; HEADER_LEN];
        h[0..4].copy_from_slice(HEADER_MAGIC);
        h[4..6].copy_from_slice(&HEADER_FORMAT.to_le_bytes());
        h[6..8].copy_from_slice(&self.table_id.to_le_bytes());
        h[8..16].copy_from_slice(&self.row_count.to_le_bytes());
        h[16..24].copy_from_slice(&self.generation.to_le_bytes());
        h[24..32].copy_from_slice(&self.body_xxh3.to_le_bytes());
        h
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < HEADER_LEN {
            return Err(store_err!("segment file header truncated"));
        }
        if &bytes[0..4] != HEADER_MAGIC {
            return Err(store_err!("segment file bad magic"));
        }
        let format = u16le(bytes, 4);
        if format != HEADER_FORMAT {
            return Err(store_err!("segment file unsupported format {format}"));
        }
        Ok(FileHeader {
            table_id: u16le(bytes, 6),
            row_count: u64le(bytes, 8),
            generation: u64le(bytes, 16),
            body_xxh3: u64le(bytes, 24),
        })
    }
}

pub fn lower_bound(n: usize, cmp: impl Fn(usize) -> std::cmp::Ordering) -> usize {
    let mut lo = 0usize;
    let mut hi = n;
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if cmp(mid) == std::cmp::Ordering::Less {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

pub fn upper_bound(n: usize, cmp: impl Fn(usize) -> std::cmp::Ordering) -> usize {
    let mut lo = 0usize;
    let mut hi = n;
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if cmp(mid) != std::cmp::Ordering::Greater {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}
