//! Byte layout for replay-c's fixed-width segment-store files. Fields are
//! read/written at explicit byte offsets (not via `#[repr(C)]` casts), so
//! there are no alignment requirements on the mmap'd bytes.

pub const KEYS_STRIDE: usize = 32;
pub const DIGESTS_STRIDE: usize = 160; // record_digest, body_digest, identity_id, identity_key_digest, previous_record_id
pub const META_STRIDE: usize = 96;
pub const PAIR_STRIDE: usize = 8; // (u32, u32)
pub const BY_KIND_STRIDE: usize = 9; // (u16 universal_kind_id, u8 category, u16 kind_id, u32 row_ordinal)
pub const BY_IDENTITY_STRIDE: usize = 36; // (32B identity_key_digest, u32 row_ordinal)
pub const SUBJECT_STRIDE: usize = 32;

pub mod meta {
    pub const OWNER_ARTIFACT: usize = 0;
    pub const OWNER_VERSION: usize = 4;
    pub const VALID_FROM: usize = 8;
    pub const VALID_TO: usize = 12;
    pub const CATEGORY: usize = 16;
    pub const KIND_ID: usize = 17;
    pub const UNIVERSAL_KIND_ID: usize = 19;
    pub const FACETS: usize = 21;
    pub const SPAN_ARTIFACT_VERSION: usize = 25;
    pub const SPAN_START_BYTE: usize = 29;
    pub const SPAN_END_BYTE: usize = 33;
    pub const SPAN_START_LINE: usize = 37;
    pub const SPAN_END_LINE: usize = 41;
    pub const IDENTITY_TYPE: usize = 45;
    pub const ASSIGNMENT_KIND: usize = 46;
    pub const NAME_ID: usize = 47;
    pub const SOURCE_SUBJECT: usize = 51;
    pub const TARGET_SUBJECT: usize = 55;
    pub const RELATION_KIND_ID: usize = 59;
    pub const BODY_OFF: usize = 61;
    pub const BODY_LEN: usize = 69;
    pub const IDENT_OFF: usize = 73;
    pub const IDENT_LEN: usize = 77;
    #[allow(dead_code)] // documents the byte budget vs the 96B stride
    pub const USED: usize = 81;
}

pub mod digests {
    pub const RECORD_DIGEST: usize = 0;
    pub const BODY_DIGEST: usize = 32;
    pub const IDENTITY_ID: usize = 64;
    pub const IDENTITY_KEY_DIGEST: usize = 96;
    pub const PREVIOUS_RECORD_ID: usize = 128;
}

#[inline]
pub fn u32le(buf: &[u8], off: usize) -> u32 {
    u32::from_le_bytes(buf[off..off + 4].try_into().unwrap())
}
#[inline]
pub fn u16le(buf: &[u8], off: usize) -> u16 {
    u16::from_le_bytes(buf[off..off + 2].try_into().unwrap())
}
#[inline]
pub fn u64le(buf: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(buf[off..off + 8].try_into().unwrap())
}
#[inline]
pub fn put_u32le(buf: &mut [u8], off: usize, v: u32) {
    buf[off..off + 4].copy_from_slice(&v.to_le_bytes());
}
#[inline]
pub fn put_u16le(buf: &mut [u8], off: usize, v: u16) {
    buf[off..off + 2].copy_from_slice(&v.to_le_bytes());
}
#[inline]
pub fn put_u64le(buf: &mut [u8], off: usize, v: u64) {
    buf[off..off + 8].copy_from_slice(&v.to_le_bytes());
}
