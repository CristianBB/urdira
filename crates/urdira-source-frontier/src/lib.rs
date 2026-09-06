//! `urdira-source-frontier`: owns the SOURCE CATALOG of a v4 workspace on
//! the Rust route (walk, hash, CAS, catalog delta into SQLite, source-state
//! digest) in O(delta) — see plan §4.1/§6.2/§6.4 in
//! `resilient-knitting-twilight.md` (task P2-2a) and
//! `docs/evidence/2026-09-02-v4-p2-2a-source-frontier.md` for the full
//! design writeup, id-recipe provenance, and measured numbers.
//!
//! Deliberately confined to the catalog boundary: this crate never touches
//! `record_occurrences`/`graph_edges`/analysis rows, and never reads or
//! writes `crates/urdira-indexing-core`/`crates/urdira-indexing-worker`
//! (only depends on `urdira-indexing-core` as a library, for
//! [`urdira_indexing_core::merkle_bucket::BucketedMerkleSet`] and
//! [`urdira_indexing_core::CoreError`]).

pub mod cas;
pub mod catalog;
pub mod delta;
pub mod digest;
pub mod frontier;
pub mod ids;
pub mod inclusion;
pub mod walker;

pub use cas::{CasPut, CasStore, CasWaitError, CasWriteQueue, CasWrittenSignal};
pub use catalog::{AppliedCatalog, BatchMeta, Catalog};
pub use delta::Delta;
pub use frontier::{Frontier, FrontierEntry};
pub use walker::{Observation, PathObservation, Walker};

pub use urdira_indexing_core::CoreError;
