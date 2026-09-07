//! `urdira-structural-store`: the v4 production structural segment store
//! (plan `docs/.../resilient-knitting-twilight.md` §2, task P2-3),
//! derived from the measured spike `crates/urdira-v4-spike`. An
//! immutable-per-segment, mmap-served, fixed-width-array store for
//! structural records and artifact dependencies, with append-only
//! dictionaries, generation-based visibility, atomic manifest publish,
//! bucketed-merkle set roots, crash recovery, and a reader refcount
//! protocol for safe background compaction.
//!
//! See `docs/evidence/2026-09-02-v4-p2-3-structural-store.md` for the
//! on-disk byte layout, API summary, and bench numbers.

mod bin_io;
pub mod container;
mod dict;
pub mod error;
mod identity_codec;
mod layout;
pub mod manifest;
// P3-1 (`crates/urdira-indexing-worker/src/v4/*`): made `pub` (was crate-
// private) so the incremental delta path can maintain the `graph` merkle
// tree the same way `writer::write_delta` maintains `records`/`dependency`
// -- this crate does not track a `graph` set itself (no separate edge
// table on this route, per this module's own doc comments), so a caller
// that needs an incremental `graph` root needs `load_and_update`/
// `persist_slots`/`bucket_index_of` directly. Additive-only: every item
// exposed here was already `pub fn`/`pub struct` inside the module, just
// not reachable from outside the crate before this change. Format
// unchanged.
pub mod merkle;
pub mod refcount;
mod segment_io;
mod xxh;

pub mod compact;
pub mod reader;
pub mod recover;
pub mod row;
pub mod writer;

pub use compact::compact;
pub use error::{Result, StoreError};
pub use manifest::{Manifest, ManifestFileEntry};
pub use merkle::recompute_roots_from_scratch;
pub use reader::{
    ChangeEntry, DependencyView, Direction, PendingSiteView, RecordView, StoreReader, VisibleIter,
};
pub use recover::recover;
pub use row::{
    CATEGORY_DIAGNOSTIC, CATEGORY_ENTITY, CATEGORY_RELATION, DependencyRow, Dictionaries, NONE_U16,
    NONE_U32, PENDING_SITE_KIND_CALL, PENDING_SITE_KIND_IMPLEMENTS, PENDING_SITE_KIND_INHERITS,
    PendingSiteKey, PendingSiteRow, RecordRow,
};
pub use writer::{SegmentSummary, SegmentWriter};

/// P2-2j item 2: re-exported so `urdira-indexing-worker`'s v4 materialize
/// module can bucket `RecordRow`s into the SAME 16 top-nibble partitions
/// `write_base_partitioned`'s writer expects, without duplicating (and
/// risking drift from) this crate's own bucketing recipe. Additive: both
/// items already existed as `pub(crate)`/private items inside `segment_io`.
pub use segment_io::{N_NIBBLES, nibble_of};

/// Frente E-P0j (2026-09-07): re-exported so `urdira-indexing-worker::v4::
/// residual`'s own debug-only full-scan `EntityLookup` variant (`URDIRA_
/// V4_ENTITY_INDEX=scan`) can key its in-memory index the SAME way
/// `entities.index`'s real on-disk build now does (`segment_io::
/// entities_index_key_start`, not exported -- this crate's own writer
/// already applies it internally) -- see `identity_codec::entity_identity_
/// name_start`'s own doc comment for why. Additive: already `pub fn` inside
/// the (crate-private) `identity_codec` module.
pub use identity_codec::entity_identity_name_start;

/// Re-exported so callers can interpret roots without a direct
/// dependency on `urdira-indexing-core`.
pub use urdira_indexing_core::merkle_bucket::{
    BucketedMerkleSet, Change, Digest32, SetKind, to_prefixed_hex,
};
