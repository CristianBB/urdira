//! Integration with `urdira_indexing_core::merkle_bucket`: the record-set
//! root (key = `record_id`, logical = `record_digest`, visible rows only)
//! and the dependency-set root (key = `dependency_id`, logical = a
//! content digest of the dependency's fields), persisted under
//! `structural/merkle/<set>.tree` per plan §8.3.

use crate::error::Result;
use crate::row::{DependencyRow, RecordRow};
use sha2::{Digest, Sha256};
use std::path::Path;
pub use urdira_indexing_core::merkle_bucket::Digest32;
use urdira_indexing_core::merkle_bucket::{BucketedMerkleSet, Change, SetKind};

pub fn tree_filename(kind: SetKind) -> &'static str {
    match kind {
        SetKind::Records => "records.tree",
        SetKind::Dependency => "dependency.tree",
        SetKind::Graph => "graph.tree",
        SetKind::Metric => "metric.tree",
        SetKind::SourceState => "source_state.tree",
    }
}

/// Top 5 hex nibbles (top 20 bits) of a key -- the bucket a member falls
/// into. Mirrors the private `bucket_index` in `merkle_bucket.rs`; kept
/// in sync by the shared fixture-driven tests in that module (this
/// crate never needs a differing bucketing scheme).
pub fn bucket_index_of(key: &Digest32) -> u32 {
    (u32::from(key[0]) << 12) | (u32::from(key[1]) << 4) | (u32::from(key[2]) >> 4)
}

fn row_visible(valid_from: u32, valid_to: u32, generation: u64) -> bool {
    (valid_from as u64) <= generation && (valid_to == 0 || (valid_to as u64) > generation)
}

pub fn record_entries(rows: &[RecordRow], generation: u64) -> Vec<(Digest32, Digest32)> {
    rows.iter()
        .filter(|r| row_visible(r.valid_from, r.valid_to, generation))
        .map(|r| (r.record_id, r.record_digest))
        .collect()
}

/// Content digest for a dependency row (there is no separate
/// `dependency_digest` field in [`DependencyRow`]; the merkle set's
/// "logical" value is derived from the fields that define the edge).
///
/// **`record` is deliberately NOT part of this digest** (P3-1 fix, found
/// live via a real n8n-scale oracle mismatch, then a cold-scan merkle
/// conflict once the companion `dependency_id` fix -- `crates/urdira-
/// indexing-worker/src/v4/deps.rs`'s v2 recipe -- was applied on its own):
/// `record` (which specific relation record this dependency happens to be
/// attached to) is `None` on the incremental path by design (see that
/// module's own doc comment) but a real ordinal on the cold path, so
/// including it here made the SAME logical edge hash differently depending
/// on which pipeline produced it -- exactly the kind of drift a merkle
/// root comparison against a from-scratch oracle is supposed to catch. A
/// dependency edge's logical identity is "this owner depends on this
/// artifact via this role" -- which specific import statement/relation
/// record happens to carry it is not part of that identity. A side effect,
/// confirmed correct rather than accidental: two distinct import
/// statements in the same file resolving to the same target module with
/// the same role now collapse to one dependency edge (same key, same
/// logical value) instead of racing to a "duplicate member has
/// conflicting logical digests" merkle error -- which is what a real n8n
/// file with two separate imports from the same module surfaced during
/// this fix's own verification.
///
/// **P3-2 item 3: no longer derived from `owner_artifact`/`dep_artifact`
/// ordinals at all** -- those are raw `OrdinalDict` positions, append-only
/// and insertion-order-dependent (`urdira-indexing-worker::v4::deps`'s own
/// doc comment has the full mechanism), so they are NOT comparable between
/// an incremental store's dictionary and an independently-built
/// from-scratch oracle's whenever the file set differs (any create/
/// delete) -- confirmed live as the actual root cause of `dependency`
/// mismatching a from-scratch n8n-scale oracle for create+delete even
/// after the v2 `dependency_id` fix above. `row.dependency_id` itself is
/// now minted (v3, `deps.rs`) from the STRING `(artifact_id,
/// artifact_version_id)` pairs the edge connects, making it already
/// canonical/ordinal-independent -- deriving `dependency_logical` from
/// THAT (a different hash domain, not a byte-for-byte copy) keeps the
/// merkle set's (key, logical) pair consistent while inheriting the same
/// canonicalization for free, with no ordinal (or dictionary) involved at
/// this layer at all. A dependency row has no independent "content"
/// beyond its own identity (unlike a record, which can be replaced under
/// the same identity_key with a different digest) -- `role` is already
/// baked into `dependency_id` itself, so there is nothing else to fold in.
pub fn dependency_logical(row: &DependencyRow) -> Digest32 {
    let mut h = Sha256::new();
    h.update(b"urdira:dependency-logical:v4\0");
    h.update(row.dependency_id);
    h.finalize().into()
}

pub fn dependency_entries(rows: &[DependencyRow], generation: u64) -> Vec<(Digest32, Digest32)> {
    rows.iter()
        .filter(|r| row_visible(r.valid_from, r.valid_to, generation))
        .map(|r| (r.dependency_id, dependency_logical(r)))
        .collect()
}

/// Builds a fresh tree from `entries` in memory (cold path) -- no I/O, so
/// the writer can compute the root for the "queryable" milestone before
/// touching disk at all. Persist it separately with [`persist`] once the
/// caller is ready to pay for the fsync (plan §2.4 step 3: "sin fsync
/// durante la escritura [page cache]"; `BucketedMerkleSet::write_to`
/// always fsyncs, so calling it here -- during what should be the
/// page-cache-only phase -- was the single biggest contributor to a
/// ~10x page-cache-time regression measured against the P0-S1 spike's
/// NODIAG bench on 2026-09-02, fixed by this split).
pub fn build(entries: &[(Digest32, Digest32)]) -> Result<BucketedMerkleSet> {
    Ok(BucketedMerkleSet::from_sorted(entries)?)
}

/// Writes `set` to `dir/<set>.tree` (fsyncs). Call once the caller's own
/// "durable" timing window has started.
pub fn persist(set: &BucketedMerkleSet, dir: &Path, kind: SetKind, generation: u64) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    set.write_to(&dir.join(tree_filename(kind)), kind, generation)?;
    Ok(())
}

/// Loads the existing `dir/<set>.tree` and applies `changes` in memory
/// (no I/O beyond the initial read). Returns the mutated set and the
/// touched bucket indices for a later [`persist_slots`] call.
/// `bucket_entries` must return `(pre_change_count, post_change_entries)`
/// for a given bucket -- see `BucketedMerkleSet::update`'s own doc comment
/// for why `pre_change_count` can never be derived from the loaded set
/// itself (`read_from` never restores per-bucket counts).
pub fn load_and_update(
    dir: &Path,
    kind: SetKind,
    changes: &[Change],
    bucket_entries: impl Fn(u32) -> (u32, Vec<(Digest32, Digest32)>),
) -> Result<(BucketedMerkleSet, Vec<u32>)> {
    let path = dir.join(tree_filename(kind));
    let (mut set, _read_kind, _read_generation) = BucketedMerkleSet::read_from(&path)?;
    set.update(changes, bucket_entries)?;
    let mut touched: Vec<u32> = changes
        .iter()
        .map(|c| match c {
            Change::Set { key, .. } => bucket_index_of(key),
            Change::Delete { key } => bucket_index_of(key),
        })
        .collect();
    touched.sort_unstable();
    touched.dedup();
    Ok((set, touched))
}

/// Persists only the slots touched by a prior [`load_and_update`] (fsyncs).
pub fn persist_slots(
    set: &BucketedMerkleSet,
    touched: &[u32],
    dir: &Path,
    kind: SetKind,
    generation: u64,
) -> Result<()> {
    set.write_slots(&dir.join(tree_filename(kind)), touched, kind, generation)?;
    Ok(())
}

pub fn read_root(dir: &Path, kind: SetKind) -> Result<Digest32> {
    let (set, _k, _g) = BucketedMerkleSet::read_from(&dir.join(tree_filename(kind)))?;
    Ok(set.root())
}

/// `[lo_inclusive, hi_exclusive)` 32-byte key bounds for `bucket_idx`
/// (top 20 bits fixed, remaining 236 bits ranging over their full span).
/// `hi_exclusive` is all-`0xFF` for the last bucket (never compared
/// against, since `lower_bound` against an all-0xFF key only excludes a
/// key that is itself all-0xFF, astronomically unlikely for a digest).
pub fn bucket_key_bounds(bucket_idx: u32) -> (Digest32, Digest32) {
    let mut lo = [0u8; 32];
    lo[0] = (bucket_idx >> 12) as u8;
    lo[1] = (bucket_idx >> 4) as u8;
    lo[2] = ((bucket_idx & 0xF) << 4) as u8;
    let mut hi = [0xFFu8; 32];
    let next = bucket_idx + 1;
    if next < (1 << 20) {
        hi = [0u8; 32];
        hi[0] = (next >> 12) as u8;
        hi[1] = (next >> 4) as u8;
        hi[2] = ((next & 0xF) << 4) as u8;
    }
    (lo, hi)
}

/// Reader-side counterpart of [`dependency_logical`] -- see that function's
/// doc comment for why `record` is deliberately excluded.
/// `DependencyView` twin of [`dependency_logical`] -- MUST stay byte-
/// identical to it (same hash domain, same input: `dependency_id` alone,
/// P3-2 item 3). This is exactly the kind of drift a from-scratch oracle
/// comparison exists to catch: this view-based copy was missed when
/// `dependency_logical` itself was fixed to stop hashing raw dictionary
/// ordinals, and `recompute_roots_from_scratch`'s own dependency root
/// (used by `compact`'s pre/post-compaction equality check and by every
/// live root-verification call site) silently used the STALE ordinal-based
/// formula until `cargo test -p urdira-structural-store` caught the
/// resulting root mismatch directly.
pub fn dependency_logical_view(view: &crate::reader::DependencyView) -> Digest32 {
    let mut h = Sha256::new();
    h.update(b"urdira:dependency-logical:v4\0");
    h.update(view.dependency_id());
    h.finalize().into()
}

/// Recomputes both roots by scanning the store directly (no reliance on
/// persisted `.tree` files) -- the verification path for
/// `lifecycle.verify` / this crate's tests.
pub fn recompute_roots_from_scratch(
    reader: &crate::reader::StoreReader,
    generation: u64,
) -> Result<(Digest32, Digest32)> {
    let record_entries: Vec<(Digest32, Digest32)> = reader
        .iter_visible(generation)
        .map(|v| (v.record_id(), v.record_digest()))
        .collect();
    let dep_entries: Vec<(Digest32, Digest32)> = reader
        .iter_visible_deps(generation)
        .into_iter()
        .map(|v| (v.dependency_id(), dependency_logical_view(&v)))
        .collect();
    let records_root = BucketedMerkleSet::from_sorted(&record_entries)?.root();
    let dep_root = BucketedMerkleSet::from_sorted(&dep_entries)?.root();
    Ok((records_root, dep_root))
}
