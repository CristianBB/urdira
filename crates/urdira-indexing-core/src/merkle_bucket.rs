//! Bucketed Merkle set digest (v4 P0-S3).
//!
//! Members are grouped into 16^5 = 1,048,576 buckets by the first 5 hex
//! nibbles (top 20 bits) of their 32-byte key. A bucket digest hashes its
//! sorted `(key, logical)` pairs in one shot; internal nodes at depth 0..4
//! fan out 16-wide over the next level. Unlike a per-leaf radix chain (see
//! `packages/canonical/src/merkle-radix.ts`, which walks all 64 nibbles of a
//! random 256-bit key, i.e. ~58 useful chain nodes per leaf), a single-key
//! update here touches exactly one bucket digest plus 5 ancestor node
//! digests, independent of the total set size.
//!
//! Byte-identical companion to `packages/canonical/src/merkle-bucket.ts` —
//! keep both in sync. Shared test vectors live in
//! `tests/fixtures/digests/merkle-bucket-v4.json` and are asserted by both
//! implementations.
//!
//! Internal nodes (depth 0..4) are hashed unconditionally, even when every
//! one of their 16 children is itself empty — only two shortcuts exist:
//! an empty bucket's leafset digest is 32 zero bytes (never the hash of an
//! empty list), and the overall `root()` reports 32 zero bytes when the set
//! has no members at all (never the hash of an all-empty tree).

use crate::CoreError;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write as IoWrite};
use std::path::Path;

/// Number of hex nibbles of the key used to select a bucket.
pub const BUCKET_PREFIX_NIBBLES: u32 = 5;
/// Number of leaf buckets: 16^5.
pub const BUCKET_COUNT: usize = 1 << (4 * BUCKET_PREFIX_NIBBLES);

/// Number of slots at internal node depths 0..4 (a depth-`d` node has 16^d
/// slots); index 4 here is the depth-4 level, whose children are buckets.
const NODE_LEVEL_LEN: [usize; 5] = [1, 16, 256, 4096, 65536];
/// Cumulative slot offset (in 32-byte slots) of the start of each level in
/// the persisted file, levels 0..=5 where level 5 is the bucket level.
const LEVEL_SLOT_OFFSET: [u64; 6] = [0, 1, 17, 273, 4369, 69905];
/// Total node+bucket slots persisted: 1+16+256+4096+65536+1,048,576.
const TOTAL_SLOTS: usize = 1 + 16 + 256 + 4096 + 65536 + BUCKET_COUNT;

const DOMAIN_LEAFSET: &[u8] = b"urdira:merkle-bucket:leafset\0";
const DOMAIN_NODE: &[u8] = b"urdira:merkle-bucket:node\0";
const DOMAIN_RECORD_SET: &[u8] = b"urdira:record-set:v4\0";
const DOMAIN_PROJECTION_SET: &[u8] = b"urdira:projection-set:v4\0";

const HEADER_MAGIC: &[u8; 4] = b"URDM";
const HEADER_FORMAT: u16 = 1;
const HEADER_LEN: u64 = 64;

/// A 32-byte SHA-256 digest.
pub type Digest32 = [u8; 32];
const ZERO: Digest32 = [0u8; 32];

/// Formats a digest as the `sha256:<hex>` form used across the TypeScript
/// side of urdira.
pub fn to_prefixed_hex(value: &Digest32) -> String {
    let mut out = String::with_capacity(7 + 64);
    out.push_str("sha256:");
    for byte in value {
        write!(&mut out, "{byte:02x}").expect("writing to String cannot fail");
    }
    out
}

/// Which durable set this persisted tree belongs to (see `structural/merkle/<set>.tree`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum SetKind {
    Records = 1,
    Graph = 2,
    Dependency = 3,
    Metric = 4,
    SourceState = 5,
}

impl SetKind {
    fn from_u16(value: u16) -> Option<Self> {
        match value {
            1 => Some(SetKind::Records),
            2 => Some(SetKind::Graph),
            3 => Some(SetKind::Dependency),
            4 => Some(SetKind::Metric),
            5 => Some(SetKind::SourceState),
            _ => None,
        }
    }
}

/// A single mutation applied by [`BucketedMerkleSet::update`]. The `key`
/// (and, for `Set`, `logical`) select which bucket is touched; the
/// authoritative post-change contents of that bucket are supplied by the
/// caller through the `bucket_entries` callback, since a loaded tree keeps
/// only digests, not leaves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    Set { key: Digest32, logical: Digest32 },
    Delete { key: Digest32 },
}

impl Change {
    fn key(&self) -> &Digest32 {
        match self {
            Change::Set { key, .. } => key,
            Change::Delete { key } => key,
        }
    }
}

fn array16<T, F: FnMut(usize) -> T>(f: F) -> [T; 16] {
    std::array::from_fn(f)
}

fn conflict_error() -> CoreError {
    CoreError("merkle bucket: duplicate member has conflicting logical digests".to_string())
}

fn node_digest(depth: u8, children: &[Digest32; 16]) -> Digest32 {
    let mut hasher = Sha256::new();
    hasher.update(DOMAIN_NODE);
    hasher.update([depth]);
    for child in children {
        hasher.update(child);
    }
    hasher.finalize().into()
}

/// `sha256("urdira:merkle-bucket:leafset\0" || u32le(count) || concat(key||logical, sorted by key))`,
/// or 32 zero bytes for an empty bucket.
fn bucket_digest(entries: &[(Digest32, Digest32)]) -> Digest32 {
    if entries.is_empty() {
        return ZERO;
    }
    let mut hasher = Sha256::new();
    hasher.update(DOMAIN_LEAFSET);
    hasher.update((entries.len() as u32).to_le_bytes());
    for (key, logical) in entries {
        hasher.update(key);
        hasher.update(logical);
    }
    hasher.finalize().into()
}

/// Top 20 bits of the key (its first 5 hex nibbles) as an integer 0..1,048,576.
fn bucket_index(key: &Digest32) -> u32 {
    (u32::from(key[0]) << 12) | (u32::from(key[1]) << 4) | (u32::from(key[2]) >> 4)
}

/// Bucket index restricted to the low 16 bits (nibbles 1..4 within a fixed
/// top nibble), used to address a per-thread chunk in `from_sorted`.
fn local_bucket_index(key: &Digest32) -> u32 {
    bucket_index(key) & 0xFFFF
}

/// The canonical digest of a depth-`d` node whose entire subtree is empty.
/// Depth 4's children are empty buckets (zero bytes); every level above
/// chains from there. Used both as the initial fill value for a fresh set
/// and, on the TypeScript side, as the fallback for an unmaterialized
/// sibling — kept here for parity and for tests, even though this Rust
/// implementation always keeps node levels fully dense.
fn empty_node_digests() -> [Digest32; 5] {
    let mut table = [ZERO; 5];
    let mut child = ZERO;
    for depth in (0..=4u8).rev() {
        let children = array16(|_| child);
        let value = node_digest(depth, &children);
        table[depth as usize] = value;
        child = value;
    }
    table
}

/// In-memory bucketed Merkle set. Node levels 0..4 and the bucket level are
/// kept as dense arrays (1+16+256+4096+65536+1,048,576 = 1,118,481 digests,
/// ~35.8 MB), matching the persisted file layout exactly.
pub struct BucketedMerkleSet {
    node_levels: [Vec<Digest32>; 5],
    bucket_level: Vec<Digest32>,
    /// Per-bucket member count. Maintained exactly by `from_sorted` and by
    /// `update` calls that only ever touch buckets whose count this
    /// instance has already observed. A tree obtained from `read_from`
    /// (digests only, no leaves) starts with all-zero per-bucket counts;
    /// `update`ing a bucket that already had members *before* that load,
    /// without ever having rebuilt via `from_sorted`, undercounts `len()`
    /// deltas for that bucket. `root()` is unaffected either way. See the
    /// P0-S3 evidence doc for the full caveat.
    bucket_count: Vec<u32>,
    count: u64,
}

impl BucketedMerkleSet {
    /// An empty set. Every node slot already holds the canonical
    /// empty-subtree digest for its depth, so a subsequent `update` never
    /// needs to special-case an untouched sibling.
    pub fn empty() -> Self {
        let empty = empty_node_digests();
        Self {
            node_levels: [
                vec![empty[0]; NODE_LEVEL_LEN[0]],
                vec![empty[1]; NODE_LEVEL_LEN[1]],
                vec![empty[2]; NODE_LEVEL_LEN[2]],
                vec![empty[3]; NODE_LEVEL_LEN[3]],
                vec![empty[4]; NODE_LEVEL_LEN[4]],
            ],
            bucket_level: vec![ZERO; BUCKET_COUNT],
            bucket_count: vec![0; BUCKET_COUNT],
            count: 0,
        }
    }

    /// Builds a set in one bottom-up pass, parallelized across the 16
    /// top-level nibbles. `entries` need not be pre-sorted. A duplicate key
    /// with differing logical values is an error; an identical duplicate is
    /// a no-op.
    pub fn from_sorted(entries: &[(Digest32, Digest32)]) -> Result<Self, CoreError> {
        let mut sorted = entries.to_vec();
        sorted.sort_unstable_by_key(|entry| entry.0);
        for window in sorted.windows(2) {
            if window[0].0 == window[1].0 && window[0].1 != window[1].1 {
                return Err(conflict_error());
            }
        }
        sorted.dedup_by(|a, b| a.0 == b.0);
        let count = sorted.len() as u64;

        let mut set = Self::empty();

        // `sorted` is key-ascending, so entries sharing a top nibble are
        // already contiguous; find each nibble's [start, end) range.
        let mut starts = [0usize; 17];
        {
            let mut idx = 0usize;
            for nibble in 0u8..16 {
                while idx < sorted.len() && (sorted[idx].0[0] >> 4) < nibble {
                    idx += 1;
                }
                starts[nibble as usize] = idx;
            }
            starts[16] = sorted.len();
        }

        {
            let [_level0, level1, level2, level3, level4] = &mut set.node_levels;
            let bucket_chunks: Vec<&mut [Digest32]> =
                set.bucket_level.chunks_mut(BUCKET_COUNT / 16).collect();
            let count_chunks: Vec<&mut [u32]> =
                set.bucket_count.chunks_mut(BUCKET_COUNT / 16).collect();
            let node4_chunks: Vec<&mut [Digest32]> =
                level4.chunks_mut(NODE_LEVEL_LEN[4] / 16).collect();
            let node3_chunks: Vec<&mut [Digest32]> =
                level3.chunks_mut(NODE_LEVEL_LEN[3] / 16).collect();
            let node2_chunks: Vec<&mut [Digest32]> =
                level2.chunks_mut(NODE_LEVEL_LEN[2] / 16).collect();
            let node1_slots: Vec<&mut Digest32> = level1.iter_mut().collect();

            std::thread::scope(|scope| {
                let mut handles = Vec::with_capacity(16);
                let iter = bucket_chunks
                    .into_iter()
                    .zip(count_chunks)
                    .zip(node4_chunks)
                    .zip(node3_chunks)
                    .zip(node2_chunks)
                    .zip(node1_slots)
                    .enumerate();
                for (nibble, (((((bucket_chunk, count_chunk), node4), node3), node2), node1)) in
                    iter
                {
                    let slice = &sorted[starts[nibble]..starts[nibble + 1]];
                    handles.push(scope.spawn(move || {
                        build_top_nibble_subtree(
                            slice,
                            bucket_chunk,
                            count_chunk,
                            node4,
                            node3,
                            node2,
                            node1,
                        );
                    }));
                }
                for handle in handles {
                    handle.join().expect("merkle bucket build thread panicked");
                }
            });
        }

        let root_children = array16(|digit| set.node_levels[1][digit]);
        set.node_levels[0][0] = node_digest(0, &root_children);
        set.count = count;
        Ok(set)
    }

    /// Recomputes only the buckets touched by `changes` (deduplicated) plus
    /// their 5 ancestor node digests. `bucket_entries(bucket_idx)` must
    /// return `(pre_change_count, post_change_entries)` for that bucket
    /// (this tree does not retain leaves itself): `post_change_entries` is
    /// the *current*, post-change content, exactly as before; `pre_change_
    /// count` is this bucket's TRUE member count immediately before this
    /// call's own changes were applied to it -- NEVER derived from this
    /// struct's own `bucket_count` field, which [`Self::read_from`] cannot
    /// restore (only digests are persisted, not per-bucket leaf counts) and
    /// therefore starts at zero for every bucket on a struct loaded that
    /// way, regardless of what it actually held.
    ///
    /// Frente E-P0c fix (2026-09-07, `docs/evidence/2026-09-02-v4-p0-s3-
    /// merkle-bucket.md`'s own "known caveat", left as an explicit follow-up
    /// then and finally closed here): this function used to read `self.
    /// bucket_count[bucket_idx]` as `pre_change_count` itself. For a set
    /// freshly built via [`Self::from_sorted`] that field is exact, but
    /// EVERY real caller in this codebase (`urdira-structural-store::writer`
    /// /`urdira-indexing-worker::v4::diff`) instead calls this on a set
    /// loaded via [`Self::read_from`] (one `update` per incremental scan
    /// generation, on a tree persisted -- and reloaded -- by the PRIOR
    /// generation) -- so `bucket_count` silently undercounts (reads zero)
    /// for any touched bucket that already had members, permanently
    /// inflating `self.count` by that bucket's true prior size on every
    /// single incremental generation from the second one onward. Harmless
    /// for every other read (`bucket_level`/the node digests are always
    /// recomputed correctly from `post_change_entries`, independent of
    /// `self.count`) EXCEPT [`Self::root`]'s own deliberate `count == 0`
    /// special case (the ONE place `self.count`'s exact value is load-
    /// bearing): once corpus-wide `self.count` never again reaches its true
    /// value of zero after the corpus's last live member of a given
    /// category (e.g. `dependency`, whenever every file's imports resolve
    /// externally or are all deleted) is removed, `root()` permanently
    /// returns a real (non-empty-sentinel) node digest instead of the
    /// canonical all-zero empty root a from-scratch oracle of the identical
    /// (now-empty) final state computes -- a `dependency`/`graph` root
    /// mismatch invisible in any corpus that never goes back to truly zero
    /// members (real corpora essentially never do for `records`/`graph`,
    /// but easily do for `dependency` -- confirmed live via `urdira-
    /// indexing-worker`'s own `deleting_an_imported_files_export_drops_the_
    /// untouched_importers_stale_references_and_matches_an_independent_
    /// oracle` fixture). Fixed by requiring every caller to supply the true
    /// pre-change count itself (every one of them already computes or reads
    /// the pre-change bucket contents anyway, to apply `changes` against),
    /// rather than trusting this struct's own possibly-stale bookkeeping. A
    /// duplicate key with conflicting logical values inside one bucket's
    /// returned entries, or inside `changes` itself, is still an error.
    pub fn update<F>(&mut self, changes: &[Change], bucket_entries: F) -> Result<(), CoreError>
    where
        F: Fn(u32) -> (u32, Vec<(Digest32, Digest32)>),
    {
        // P3-1 perf fix: this loop only ever exists to reject a `changes`
        // slice that sets the SAME key to two different logical values --
        // `intended`'s entries are never read after this loop. The
        // original `Vec` + linear `.find()` made this loop O(N^2) in the
        // number of `Set` changes (a `sample`-confirmed multi-minute stall
        // for N=356,905 `Change::Set`s in a real n8n hub-edit closure,
        // `crates/urdira-structural-store`'s `write_delta` is this
        // function's only caller at that scale) -- a `HashMap` gives the
        // identical conflict-detection semantics in O(N) amortized.
        let mut intended: std::collections::HashMap<Digest32, Digest32> =
            std::collections::HashMap::new();
        for change in changes {
            if let Change::Set { key, logical } = change {
                match intended.get(key) {
                    Some(previous) if previous != logical => return Err(conflict_error()),
                    Some(_) => {}
                    None => {
                        intended.insert(*key, *logical);
                    }
                }
            }
        }

        let mut touched: Vec<u32> = changes
            .iter()
            .map(|change| bucket_index(change.key()))
            .collect();
        touched.sort_unstable();
        touched.dedup();

        for bucket_idx in touched {
            let (old_count, mut bucket) = bucket_entries(bucket_idx);
            bucket.sort_unstable_by_key(|entry| entry.0);
            for window in bucket.windows(2) {
                if window[0].0 == window[1].0 && window[0].1 != window[1].1 {
                    return Err(conflict_error());
                }
            }
            bucket.dedup_by(|a, b| a.0 == b.0);

            let new_count = bucket.len() as u32;
            self.count = self.count - u64::from(old_count) + u64::from(new_count);
            self.bucket_count[bucket_idx as usize] = new_count;
            self.bucket_level[bucket_idx as usize] = bucket_digest(&bucket);
            self.recompute_ancestors(bucket_idx);
        }
        Ok(())
    }

    fn recompute_ancestors(&mut self, bucket_idx: u32) {
        for depth in (0..=4u8).rev() {
            let shift = 4 * (5 - u32::from(depth));
            let parent_index = bucket_idx >> shift;
            let children = array16(|digit| {
                let child_index = parent_index * 16 + digit as u32;
                if depth == 4 {
                    self.bucket_level[child_index as usize]
                } else {
                    self.node_levels[depth as usize + 1][child_index as usize]
                }
            });
            self.node_levels[depth as usize][parent_index as usize] = node_digest(depth, &children);
        }
    }

    /// The set digest: 32 zero bytes if the set has no members, else the
    /// depth-0 node digest.
    pub fn root(&self) -> Digest32 {
        if self.count == 0 {
            ZERO
        } else {
            self.node_levels[0][0]
        }
    }

    pub fn len(&self) -> u64 {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// `sha256("urdira:record-set:v4\0" || u64le(len()) || root())`.
    pub fn record_set_digest(&self) -> Digest32 {
        let mut hasher = Sha256::new();
        hasher.update(DOMAIN_RECORD_SET);
        hasher.update(self.count.to_le_bytes());
        hasher.update(self.root());
        hasher.finalize().into()
    }

    /// `sha256("urdira:projection-set:v4\0" || kind || 0x00 || u64le(len()) || root())`.
    pub fn projection_set_digest(&self, kind: &str) -> Digest32 {
        let mut hasher = Sha256::new();
        hasher.update(DOMAIN_PROJECTION_SET);
        hasher.update(kind.as_bytes());
        hasher.update([0u8]);
        hasher.update(self.count.to_le_bytes());
        hasher.update(self.root());
        hasher.finalize().into()
    }

    fn encode_header(&self, kind: SetKind, generation: u64) -> [u8; HEADER_LEN as usize] {
        let mut header = [0u8; HEADER_LEN as usize];
        header[0..4].copy_from_slice(HEADER_MAGIC);
        header[4..6].copy_from_slice(&HEADER_FORMAT.to_le_bytes());
        header[6..8].copy_from_slice(&(kind as u16).to_le_bytes());
        header[8..16].copy_from_slice(&generation.to_le_bytes());
        header[16..24].copy_from_slice(&self.count.to_le_bytes());
        header[24..56].copy_from_slice(&self.root());
        header
    }

    /// Writes the full `structural/merkle/<set>.tree` file: the 64-byte
    /// header followed by every node/bucket slot in BFS order (levels
    /// 0..=5). Writes to a temp file and renames into place.
    pub fn write_to(&self, path: &Path, kind: SetKind, generation: u64) -> std::io::Result<()> {
        let tmp_path = path.with_extension("tree.tmp");
        {
            let file = File::create(&tmp_path)?;
            // `BufWriter` batches the ~1,118,481 32-byte slot writes below
            // into a handful of large syscalls instead of one `write`
            // syscall per slot -- unbuffered, this loop measured as the
            // dominant cost (multiple seconds) of the P2-3 structural
            // store's `write_base`/`write_delta` durable phase on its
            // NODIAG bench (2026-09-02); same bytes on disk either way.
            let mut writer = BufWriter::with_capacity(1 << 20, file);
            writer.write_all(&self.encode_header(kind, generation))?;
            for level in &self.node_levels {
                for slot in level {
                    writer.write_all(slot)?;
                }
            }
            for slot in &self.bucket_level {
                writer.write_all(slot)?;
            }
            let file = writer.into_inner().map_err(|e| e.into_error())?;
            file.sync_all()?;
        }
        // Windows cannot replace an existing file with `rename`.  Merkle
        // trees are rewritten at every cold generation, so remove the old
        // published tree before the atomic rename on that platform. Unix
        // keeps the single replace operation.
        #[cfg(windows)]
        let _ = std::fs::remove_file(path);
        std::fs::rename(&tmp_path, path)?;
        Ok(())
    }

    /// Reads a `structural/merkle/<set>.tree` file. The returned set has
    /// exact node/bucket digests and an exact `len()`/`root()`, but no
    /// per-bucket member counts (see `bucket_count`'s docs).
    pub fn read_from(path: &Path) -> Result<(Self, SetKind, u64), CoreError> {
        let mut file = File::open(path).map_err(|error| {
            CoreError(format!(
                "merkle bucket: failed to open {}: {error}",
                path.display()
            ))
        })?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(|error| {
            CoreError(format!(
                "merkle bucket: failed to read {}: {error}",
                path.display()
            ))
        })?;

        let expected_len = HEADER_LEN as usize + TOTAL_SLOTS * 32;
        if bytes.len() != expected_len {
            return Err(CoreError(format!(
                "merkle bucket: unexpected file length {} (want {expected_len})",
                bytes.len()
            )));
        }
        if &bytes[0..4] != HEADER_MAGIC {
            return Err(CoreError("merkle bucket: bad magic".to_string()));
        }
        let format = u16::from_le_bytes([bytes[4], bytes[5]]);
        if format != HEADER_FORMAT {
            return Err(CoreError(format!(
                "merkle bucket: unsupported format {format}"
            )));
        }
        let kind = SetKind::from_u16(u16::from_le_bytes([bytes[6], bytes[7]]))
            .ok_or_else(|| CoreError("merkle bucket: unknown set_kind".to_string()))?;
        let generation = u64::from_le_bytes(bytes[8..16].try_into().unwrap());
        let count = u64::from_le_bytes(bytes[16..24].try_into().unwrap());

        let mut offset = HEADER_LEN as usize;
        let read_slot = |bytes: &[u8], offset: &mut usize| -> Digest32 {
            let slot: Digest32 = bytes[*offset..*offset + 32].try_into().unwrap();
            *offset += 32;
            slot
        };

        let mut node_levels: [Vec<Digest32>; 5] =
            [Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new()];
        for (depth, len) in NODE_LEVEL_LEN.iter().enumerate() {
            let mut level = Vec::with_capacity(*len);
            for _ in 0..*len {
                level.push(read_slot(&bytes, &mut offset));
            }
            node_levels[depth] = level;
        }
        let mut bucket_level = Vec::with_capacity(BUCKET_COUNT);
        for _ in 0..BUCKET_COUNT {
            bucket_level.push(read_slot(&bytes, &mut offset));
        }
        debug_assert_eq!(offset, bytes.len());

        let set = Self {
            node_levels,
            bucket_level,
            bucket_count: vec![0; BUCKET_COUNT],
            count,
        };
        Ok((set, kind, generation))
    }

    /// Writes only the slots touched while producing `touched_buckets`
    /// (each bucket's own digest plus its 5 ancestor node digests) to an
    /// already-existing file, then rewrites the 64-byte header last so a
    /// crash mid-write never leaves a header pointing at a root that
    /// doesn't match what's on disk.
    ///
    /// P3-6 item 1: every touched slot's `(byte_offset, value)` is
    /// collected into a `BTreeMap` first -- deduping repeated ancestor
    /// writes (buckets under the same node-1..node-4 subtree share
    /// ancestor slots; the old per-bucket loop below wrote those same
    /// bytes once per sibling bucket touched in the same call) and
    /// sorting by offset -- then adjacent 32-byte slots are coalesced into
    /// contiguous byte ranges and written with ONE `seek`+`write_all` per
    /// range instead of one pair per individual slot. Additive: the file's
    /// own byte layout (which offset holds which slot) is unchanged, only
    /// how many syscalls it takes to write a given set of touched slots.
    pub fn write_slots(
        &self,
        path: &Path,
        touched_buckets: &[u32],
        kind: SetKind,
        generation: u64,
    ) -> std::io::Result<()> {
        let mut file = OpenOptions::new().write(true).open(path)?;

        let mut slots: std::collections::BTreeMap<u64, Digest32> =
            std::collections::BTreeMap::new();
        for &bucket_idx in touched_buckets {
            slots.insert(
                HEADER_LEN + slot_byte_offset(5, bucket_idx),
                self.bucket_level[bucket_idx as usize],
            );
            for depth in (0..=4u8).rev() {
                let shift = 4 * (5 - u32::from(depth));
                let parent_index = bucket_idx >> shift;
                let value = self.node_levels[depth as usize][parent_index as usize];
                slots.insert(HEADER_LEN + slot_byte_offset(depth, parent_index), value);
            }
        }

        let offsets: Vec<u64> = slots.keys().copied().collect();
        let mut i = 0usize;
        while i < offsets.len() {
            let range_start = offsets[i];
            let mut buf = slots[&offsets[i]].to_vec();
            let mut j = i + 1;
            while j < offsets.len() && offsets[j] == offsets[j - 1] + 32 {
                buf.extend_from_slice(&slots[&offsets[j]]);
                j += 1;
            }
            file.seek(SeekFrom::Start(range_start))?;
            file.write_all(&buf)?;
            i = j;
        }

        file.seek(SeekFrom::Start(0))?;
        file.write_all(&self.encode_header(kind, generation))?;
        file.sync_all()?;
        Ok(())
    }
}

impl Default for BucketedMerkleSet {
    fn default() -> Self {
        Self::empty()
    }
}

fn slot_byte_offset(depth: u8, index: u32) -> u64 {
    (LEVEL_SLOT_OFFSET[depth as usize] + u64::from(index)) * 32
}

/// Builds the portion of the tree rooted at one top-level nibble: groups
/// this nibble's (already key-sorted) entries into local buckets, then
/// folds them up through node levels 4..1 within this thread's private
/// chunk of each level's array. `node1` is this thread's single depth-1
/// slot; the caller combines all 16 afterward into the depth-0 root.
#[allow(clippy::too_many_arguments)]
fn build_top_nibble_subtree(
    entries: &[(Digest32, Digest32)],
    bucket_chunk: &mut [Digest32],
    count_chunk: &mut [u32],
    node4: &mut [Digest32],
    node3: &mut [Digest32],
    node2: &mut [Digest32],
    node1: &mut Digest32,
) {
    let mut i = 0usize;
    while i < entries.len() {
        let local = local_bucket_index(&entries[i].0);
        let mut j = i + 1;
        while j < entries.len() && local_bucket_index(&entries[j].0) == local {
            j += 1;
        }
        let group = &entries[i..j];
        bucket_chunk[local as usize] = bucket_digest(group);
        count_chunk[local as usize] = group.len() as u32;
        i = j;
    }
    for (idx, slot) in node4.iter_mut().enumerate() {
        let children = array16(|digit| bucket_chunk[idx * 16 + digit]);
        *slot = node_digest(4, &children);
    }
    for (idx, slot) in node3.iter_mut().enumerate() {
        let children = array16(|digit| node4[idx * 16 + digit]);
        *slot = node_digest(3, &children);
    }
    for (idx, slot) in node2.iter_mut().enumerate() {
        let children = array16(|digit| node3[idx * 16 + digit]);
        *slot = node_digest(2, &children);
    }
    let children = array16(|digit| node2[digit]);
    *node1 = node_digest(1, &children);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::collections::HashMap;

    #[derive(Deserialize)]
    struct FixtureEntry {
        member_digest: String,
        logical_digest: String,
    }

    #[derive(Deserialize)]
    struct FixtureCase {
        name: String,
        entries: Vec<FixtureEntry>,
        count: u64,
        root: String,
        record_set_digest: String,
        projection_set_digest_graph: String,
        reinsert_member_digest: Option<String>,
    }

    #[derive(Deserialize)]
    struct Fixture {
        bucket_prefix_nibbles: u32,
        cases: Vec<FixtureCase>,
    }

    const FIXTURE_JSON: &str =
        include_str!("../../../tests/fixtures/digests/merkle-bucket-v4.json");

    fn load_fixture() -> Fixture {
        serde_json::from_str(FIXTURE_JSON).expect("fixture JSON must parse")
    }

    /// `BucketedMerkleSet` deliberately does not derive `Debug` (it would
    /// stringify ~35MB of digests), so `Result::unwrap_err` is unusable
    /// here; this does the same job without that bound.
    fn expect_err<T>(result: Result<T, CoreError>) -> CoreError {
        match result {
            Ok(_) => panic!("expected an error, got Ok"),
            Err(error) => error,
        }
    }

    fn parse_digest(value: &str) -> Digest32 {
        let hex = value
            .strip_prefix("sha256:")
            .expect("digest must be sha256:-prefixed");
        assert_eq!(hex.len(), 64, "digest hex must be 64 chars");
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] =
                u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).expect("digest must be valid hex");
        }
        out
    }

    fn parse_entries(entries: &[FixtureEntry]) -> Vec<(Digest32, Digest32)> {
        entries
            .iter()
            .map(|entry| {
                (
                    parse_digest(&entry.member_digest),
                    parse_digest(&entry.logical_digest),
                )
            })
            .collect()
    }

    #[test]
    fn matches_every_shared_vector() {
        let fixture = load_fixture();
        assert_eq!(fixture.bucket_prefix_nibbles, 5);
        assert!(!fixture.cases.is_empty());
        for case in &fixture.cases {
            let entries = parse_entries(&case.entries);
            let set = BucketedMerkleSet::from_sorted(&entries)
                .unwrap_or_else(|error| panic!("{}: from_sorted failed: {error}", case.name));
            assert_eq!(set.len(), case.count, "{}: count", case.name);
            assert_eq!(
                to_prefixed_hex(&set.root()),
                case.root,
                "{}: root",
                case.name
            );
            assert_eq!(
                to_prefixed_hex(&set.record_set_digest()),
                case.record_set_digest,
                "{}: record_set_digest",
                case.name
            );
            assert_eq!(
                to_prefixed_hex(&set.projection_set_digest("graph")),
                case.projection_set_digest_graph,
                "{}: projection_set_digest",
                case.name
            );

            // Order independence.
            let mut reversed = entries.clone();
            reversed.reverse();
            let reversed_set = BucketedMerkleSet::from_sorted(&reversed).unwrap();
            assert_eq!(
                reversed_set.root(),
                set.root(),
                "{}: order independence",
                case.name
            );
        }
    }

    #[test]
    fn delete_then_reinsert_matches_from_scratch() {
        let fixture = load_fixture();
        let case = fixture
            .cases
            .iter()
            .find(|case| case.name == "delete_then_reinsert")
            .expect("fixture must include delete_then_reinsert");
        let reinsert_hex = case
            .reinsert_member_digest
            .as_ref()
            .expect("case must name a reinsert member");
        let entries = parse_entries(&case.entries);
        let reinsert_key = parse_digest(reinsert_hex);
        let reinsert_logical = entries
            .iter()
            .find(|(key, _)| key == &reinsert_key)
            .map(|(_, logical)| *logical)
            .expect("reinsert member must be present in entries");

        let mut store: HashMap<u32, Vec<(Digest32, Digest32)>> = HashMap::new();
        for &(key, logical) in &entries {
            store
                .entry(bucket_index(&key))
                .or_default()
                .push((key, logical));
        }
        let mut set = BucketedMerkleSet::from_sorted(&entries).unwrap();

        let bucket = bucket_index(&reinsert_key);
        let before_delete_len = store.get(&bucket).map_or(0, Vec::len) as u32;
        store
            .get_mut(&bucket)
            .unwrap()
            .retain(|(key, _)| key != &reinsert_key);
        let after_delete = store.get(&bucket).cloned().unwrap_or_default();
        set.update(&[Change::Delete { key: reinsert_key }], |idx| {
            if idx == bucket {
                (before_delete_len, after_delete.clone())
            } else {
                let entries = store.get(&idx).cloned().unwrap_or_default();
                (entries.len() as u32, entries)
            }
        })
        .unwrap();
        assert_eq!(set.len(), case.count - 1);

        let before_reinsert_len = store.get(&bucket).map_or(0, Vec::len) as u32;
        store
            .entry(bucket)
            .or_default()
            .push((reinsert_key, reinsert_logical));
        let after_reinsert = store.get(&bucket).cloned().unwrap_or_default();
        set.update(
            &[Change::Set {
                key: reinsert_key,
                logical: reinsert_logical,
            }],
            |idx| {
                if idx == bucket {
                    (before_reinsert_len, after_reinsert.clone())
                } else {
                    let entries = store.get(&idx).cloned().unwrap_or_default();
                    (entries.len() as u32, entries)
                }
            },
        )
        .unwrap();

        assert_eq!(set.len(), case.count);
        assert_eq!(to_prefixed_hex(&set.root()), case.root);
    }

    /// Frente E-P0c (2026-09-07) regression: deleting a set's LAST member
    /// through `update`, on an instance loaded via `read_from` (never
    /// `from_sorted`), must converge back to the canonical empty-set root
    /// (`ZERO`) -- not a real, non-empty node digest. `read_from` never
    /// restores `bucket_count` (only digests + the aggregate `count` are
    /// persisted), so before this task's fix, `update`'s own `old_count =
    /// self.bucket_count[bucket_idx]` read a false `0` for this bucket
    /// (which really held 1 member before the delete), leaving `self.count`
    /// unchanged (1) instead of dropping to its true value (0) --
    /// `root()`'s `count == 0` special case then never fired, returning a
    /// real node digest instead of `ZERO`, diverging from a from-scratch
    /// oracle of the identical (now genuinely empty) member set. See
    /// `docs/evidence/2026-09-06-v4-reconcile-threshold.md` §10.4/Brecha A
    /// for the real-world `dependency`-root repro this was found from.
    #[test]
    fn deleting_the_last_member_after_a_disk_round_trip_converges_to_the_empty_root() {
        let dir = std::env::temp_dir().join(format!(
            "urdira-merkle-bucket-test-empty-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("dependency.tree");

        let key = [3u8; 32];
        let logical = [4u8; 32];
        let bucket = bucket_index(&key);

        let built = BucketedMerkleSet::from_sorted(&[(key, logical)]).unwrap();
        assert_eq!(built.len(), 1);
        assert_ne!(built.root(), ZERO);
        built.write_to(&path, SetKind::Dependency, 1).unwrap();

        // Simulate exactly what `urdira-structural-store::writer::write_
        // delta`/`urdira-indexing-worker::v4::diff::graph_bucket_entries`
        // do: load the PERSISTED tree (never `from_sorted` again), then
        // `update` it with the caller's own true pre-change bucket count
        // (here: 1, the bucket's only member, about to be deleted).
        let (mut loaded, _kind, _generation) = BucketedMerkleSet::read_from(&path).unwrap();
        loaded
            .update(&[Change::Delete { key }], |idx| {
                if idx == bucket {
                    (1, Vec::new())
                } else {
                    (0, Vec::new())
                }
            })
            .unwrap();

        assert_eq!(
            loaded.len(),
            0,
            "the set's true member count must reach zero"
        );
        assert_eq!(
            loaded.root(),
            ZERO,
            "an actually-empty set must report the canonical empty root, matching a from-scratch \
             oracle that never had any member at all -- not a real (non-empty) node digest"
        );
        assert_eq!(
            loaded.root(),
            BucketedMerkleSet::empty().root(),
            "must be byte-identical to a set that was NEVER populated in the first place"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_set_root_is_literal_zero() {
        let set = BucketedMerkleSet::empty();
        assert_eq!(set.root(), ZERO);
        assert_eq!(set.len(), 0);
        assert!(set.is_empty());
    }

    #[test]
    fn duplicate_conflicting_member_is_rejected_and_identical_is_a_no_op() {
        let key = [7u8; 32];
        let logical_a = [1u8; 32];
        let logical_b = [2u8; 32];
        let error = expect_err(BucketedMerkleSet::from_sorted(&[
            (key, logical_a),
            (key, logical_b),
        ]));
        assert!(error.0.contains("conflicting"));

        let set = BucketedMerkleSet::from_sorted(&[(key, logical_a), (key, logical_a)]).unwrap();
        assert_eq!(set.len(), 1);
    }

    #[test]
    fn update_conflict_within_one_batch_is_rejected() {
        let mut set = BucketedMerkleSet::empty();
        let key = [9u8; 32];
        let error = expect_err(set.update(
            &[
                Change::Set {
                    key,
                    logical: [1u8; 32],
                },
                Change::Set {
                    key,
                    logical: [2u8; 32],
                },
            ],
            |_| (0, Vec::new()),
        ));
        assert!(error.0.contains("conflicting"));
    }

    fn mulberry32(seed: u32) -> impl FnMut() -> u32 {
        let mut a = seed;
        move || {
            a = a.wrapping_add(0x6D2B79F5);
            let mut t = a;
            t = (t ^ (t >> 15)).wrapping_mul(t | 1);
            t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
            t ^ (t >> 14)
        }
    }

    fn synthetic_digest(rand: &mut impl FnMut() -> u32, tag: u8) -> Digest32 {
        let mut out = [0u8; 32];
        for chunk in out.chunks_mut(4) {
            chunk.copy_from_slice(&rand().to_le_bytes());
        }
        out[0] = tag; // keep some entropy in the low byte while spreading top nibbles across the seed
        out
    }

    #[test]
    fn incremental_update_matches_from_scratch_over_randomized_rounds() {
        let mut rand = mulberry32(20260902);
        let universe: Vec<(Digest32, Digest32, Digest32)> = (0..64)
            .map(|i| {
                (
                    synthetic_digest(&mut rand, i as u8),
                    synthetic_digest(&mut rand, i as u8),
                    synthetic_digest(&mut rand, i as u8),
                )
            })
            .collect();

        let mut present: HashMap<Digest32, Digest32> = HashMap::new();
        let mut store: HashMap<u32, Vec<(Digest32, Digest32)>> = HashMap::new();
        let mut set = BucketedMerkleSet::empty();

        for round in 0..200 {
            let (key, logical_a, logical_b) = universe[(rand() as usize) % universe.len()];
            let action = rand() % 100;
            let bucket = bucket_index(&key);

            if let Some(&current) = present.get(&key) {
                if action < 50 {
                    present.remove(&key);
                    let before_len = store.get(&bucket).map_or(0, Vec::len) as u32;
                    store.get_mut(&bucket).unwrap().retain(|(k, _)| k != &key);
                    let after = store.get(&bucket).cloned().unwrap_or_default();
                    set.update(&[Change::Delete { key }], |idx| {
                        if idx == bucket {
                            (before_len, after.clone())
                        } else {
                            let entries = store.get(&idx).cloned().unwrap_or_default();
                            (entries.len() as u32, entries)
                        }
                    })
                    .unwrap();
                } else if action < 80 {
                    // no-op re-set: bucket membership count never changes.
                    let before_len = store.get(&bucket).map_or(0, Vec::len) as u32;
                    let after = store.get(&bucket).cloned().unwrap_or_default();
                    set.update(
                        &[Change::Set {
                            key,
                            logical: current,
                        }],
                        |idx| {
                            if idx == bucket {
                                (before_len, after.clone())
                            } else {
                                let entries = store.get(&idx).cloned().unwrap_or_default();
                                (entries.len() as u32, entries)
                            }
                        },
                    )
                    .unwrap();
                } else {
                    let next = if current == logical_a {
                        logical_b
                    } else {
                        logical_a
                    };
                    let before_len = store.get(&bucket).map_or(0, Vec::len) as u32;
                    let entry = store
                        .get_mut(&bucket)
                        .unwrap()
                        .iter_mut()
                        .find(|(k, _)| k == &key)
                        .unwrap();
                    entry.1 = next;
                    present.insert(key, next);
                    let after = store.get(&bucket).cloned().unwrap_or_default();
                    set.update(&[Change::Set { key, logical: next }], |idx| {
                        if idx == bucket {
                            (before_len, after.clone())
                        } else {
                            let entries = store.get(&idx).cloned().unwrap_or_default();
                            (entries.len() as u32, entries)
                        }
                    })
                    .unwrap();
                }
            } else {
                let before_len = store.get(&bucket).map_or(0, Vec::len) as u32;
                present.insert(key, logical_a);
                store.entry(bucket).or_default().push((key, logical_a));
                let after = store.get(&bucket).cloned().unwrap_or_default();
                set.update(
                    &[Change::Set {
                        key,
                        logical: logical_a,
                    }],
                    |idx| {
                        if idx == bucket {
                            (before_len, after.clone())
                        } else {
                            let entries = store.get(&idx).cloned().unwrap_or_default();
                            (entries.len() as u32, entries)
                        }
                    },
                )
                .unwrap();
            }

            let entries: Vec<(Digest32, Digest32)> =
                present.iter().map(|(k, v)| (*k, *v)).collect();
            let from_scratch = BucketedMerkleSet::from_sorted(&entries).unwrap();
            assert_eq!(set.root(), from_scratch.root(), "round {round}");
            assert_eq!(set.len(), from_scratch.len(), "round {round}");
        }
    }

    #[test]
    fn persistence_round_trip_write_read_update_read() {
        let dir =
            std::env::temp_dir().join(format!("urdira-merkle-bucket-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("records.tree");

        let entries: Vec<(Digest32, Digest32)> = (0..500u32)
            .map(|i| {
                let mut key = [0u8; 32];
                key[0..4].copy_from_slice(&i.to_le_bytes());
                let mut logical = [0u8; 32];
                logical[0..4].copy_from_slice(&(i.wrapping_mul(7)).to_le_bytes());
                (key, logical)
            })
            .collect();
        let mut store: HashMap<u32, Vec<(Digest32, Digest32)>> = HashMap::new();
        for &(key, logical) in &entries {
            store
                .entry(bucket_index(&key))
                .or_default()
                .push((key, logical));
        }

        let set = BucketedMerkleSet::from_sorted(&entries).unwrap();
        set.write_to(&path, SetKind::Records, 1).unwrap();

        let (loaded, kind, generation) = BucketedMerkleSet::read_from(&path).unwrap();
        assert_eq!(kind, SetKind::Records);
        assert_eq!(generation, 1);
        assert_eq!(loaded.root(), set.root());
        assert_eq!(loaded.len(), set.len());

        // Update one key's logical value, persist only the touched slots,
        // and confirm a fresh read reflects the change.
        let (changed_key, _old_logical) = entries[42];
        let new_logical = [0xAAu8; 32];
        let bucket = bucket_index(&changed_key);
        {
            let bucket_entries = store.get_mut(&bucket).unwrap();
            let slot = bucket_entries
                .iter_mut()
                .find(|(k, _)| k == &changed_key)
                .unwrap();
            slot.1 = new_logical;
        }
        let mut mutable = loaded;
        // Changing an EXISTING member's logical value never changes this
        // bucket's membership count -- `before_len == after.len()` -- but
        // `mutable` was just loaded via `read_from`, so its own `bucket_
        // count` bookkeeping is unusable here regardless (Frente E-P0c:
        // `update`'s own doc comment on why this is now a required, not
        // optional, caller-supplied value).
        let before_len = store.get(&bucket).map_or(0, Vec::len) as u32;
        let after = store.get(&bucket).cloned().unwrap();
        mutable
            .update(
                &[Change::Set {
                    key: changed_key,
                    logical: new_logical,
                }],
                |idx| {
                    if idx == bucket {
                        (before_len, after.clone())
                    } else {
                        let entries = store.get(&idx).cloned().unwrap_or_default();
                        (entries.len() as u32, entries)
                    }
                },
            )
            .unwrap();
        mutable
            .write_slots(&path, &[bucket], SetKind::Records, 2)
            .unwrap();

        let (reloaded, kind2, generation2) = BucketedMerkleSet::read_from(&path).unwrap();
        assert_eq!(kind2, SetKind::Records);
        assert_eq!(generation2, 2);
        assert_eq!(reloaded.root(), mutable.root());
        assert_ne!(
            reloaded.root(),
            set.root(),
            "root must change after updating a member's logical value"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Microbenchmark for the v4 P0-S3 targets: `from_sorted` over 3.2M
    /// members in <= 300ms (parallel), and `update` of 500 random keys in
    /// <= 10ms excluding the bucket_entries callback cost (an in-memory map
    /// is used here for that reason). Run with:
    ///   cargo test -p urdira-indexing-core merkle_bucket -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_from_sorted_3_2m() {
        use std::time::Instant;

        const N: u32 = 3_200_000;
        let mut rand = mulberry32(20260902);
        let entries: Vec<(Digest32, Digest32)> = (0..N)
            .map(|i| {
                (
                    synthetic_digest(&mut rand, (i % 256) as u8),
                    synthetic_digest(&mut rand, ((i / 256) % 256) as u8),
                )
            })
            .collect();

        let started = Instant::now();
        let set = BucketedMerkleSet::from_sorted(&entries).expect("from_sorted must succeed");
        let parallel_elapsed = started.elapsed();
        assert_eq!(set.len(), N as u64);
        println!(
            "from_sorted (16-way thread::scope), {N} members: {:.1} ms",
            parallel_elapsed.as_secs_f64() * 1000.0
        );

        // Single-threaded reference: build via one big call to the same
        // per-nibble routine's building blocks, i.e. bucket_digest for
        // every populated bucket plus a dense sweep of the 69,905 node
        // slots, but without splitting work across threads.
        let started_single = Instant::now();
        let mut sorted = entries.clone();
        sorted.sort_unstable_by_key(|entry| entry.0);
        let mut bucket_level = vec![ZERO; BUCKET_COUNT];
        let mut i = 0usize;
        while i < sorted.len() {
            let idx = bucket_index(&sorted[i].0);
            let mut j = i + 1;
            while j < sorted.len() && bucket_index(&sorted[j].0) == idx {
                j += 1;
            }
            bucket_level[idx as usize] = bucket_digest(&sorted[i..j]);
            i = j;
        }
        let mut node4 = vec![ZERO; NODE_LEVEL_LEN[4]];
        for (idx, slot) in node4.iter_mut().enumerate() {
            let children = array16(|digit| bucket_level[idx * 16 + digit]);
            *slot = node_digest(4, &children);
        }
        let mut node3 = vec![ZERO; NODE_LEVEL_LEN[3]];
        for (idx, slot) in node3.iter_mut().enumerate() {
            let children = array16(|digit| node4[idx * 16 + digit]);
            *slot = node_digest(3, &children);
        }
        let mut node2 = vec![ZERO; NODE_LEVEL_LEN[2]];
        for (idx, slot) in node2.iter_mut().enumerate() {
            let children = array16(|digit| node3[idx * 16 + digit]);
            *slot = node_digest(2, &children);
        }
        let mut node1 = vec![ZERO; NODE_LEVEL_LEN[1]];
        for (idx, slot) in node1.iter_mut().enumerate() {
            let children = array16(|digit| node2[idx * 16 + digit]);
            *slot = node_digest(1, &children);
        }
        let root_children = array16(|digit| node1[digit]);
        let single_root = node_digest(0, &root_children);
        let single_elapsed = started_single.elapsed();
        assert_eq!(
            single_root,
            set.root(),
            "single-threaded reference must agree with the parallel build"
        );
        println!(
            "from_sorted (single-threaded reference), {N} members: {:.1} ms",
            single_elapsed.as_secs_f64() * 1000.0
        );

        // update() of 500 random keys, using an in-memory HashMap so the
        // callback cost does not pollute the measurement.
        let mut store: HashMap<u32, Vec<(Digest32, Digest32)>> = HashMap::new();
        for &(key, logical) in &entries {
            store
                .entry(bucket_index(&key))
                .or_default()
                .push((key, logical));
        }
        let mut mutable = set;
        let mut update_rand = mulberry32(99);
        let sample: Vec<(Digest32, Digest32)> = (0..500)
            .map(|_| entries[(update_rand() as usize) % entries.len()])
            .collect();
        let changes: Vec<Change> = sample
            .iter()
            .map(|&(key, _)| Change::Set {
                key,
                logical: [0xFFu8; 32],
            })
            .collect();
        for &(key, _) in &sample {
            let bucket = bucket_index(&key);
            let bucket_entries = store.get_mut(&bucket).unwrap();
            let slot = bucket_entries.iter_mut().find(|(k, _)| k == &key).unwrap();
            slot.1 = [0xFFu8; 32];
        }
        let started_update = Instant::now();
        mutable
            .update(&changes, |idx| {
                // Every change here re-sets an EXISTING key's logical value
                // -- bucket membership count never changes, so before/after
                // length are the same.
                let entries = store.get(&idx).cloned().unwrap_or_default();
                (entries.len() as u32, entries)
            })
            .unwrap();
        let update_elapsed = started_update.elapsed();
        println!(
            "update() of 500 keys (in-memory callback): {:.3} ms",
            update_elapsed.as_secs_f64() * 1000.0
        );
    }
}
