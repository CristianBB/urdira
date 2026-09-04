//! P3-1 deliverable 1: worker state kept across `WorkspaceScan` commands for
//! one workspace, inside the persistent `urdira-indexing-worker` process.
//!
//! Two things this task's own module needs to persist are named here:
//! - [`Frontier`] (`urdira-source-frontier`): loaded once (`Frontier::load`,
//!   plan §4.1: "~20 ms" on n8n's 14k rows), then mutated in place by every
//!   subsequent `Catalog::apply` call (cold or incremental) -- never
//!   reloaded from SQLite again for the life of this process, which is what
//!   turns catalog delta work from O(corpus) into O(changed paths) after the
//!   first scan.
//! - [`StoreReader`] (`urdira-structural-store`): opened lazily (first
//!   `Changed` scan for this workspace, or the reader used right after a
//!   `Full`/cold scan in the SAME process) and refreshed with
//!   `reopen_if_changed` at the top of every `Changed` scan rather than
//!   reopened from scratch, so a steady-state edit pays only the cost of a
//!   `MANIFEST` mtime check, not a fresh mmap of the whole store.
//!
//! The third piece of persistent state this task's plan asks for --
//! `urdira-jsts-syntax-worker`'s `SyntaxWorkerState` project cache
//! (parsed-program cache by content hash, dependency graph, unresolved-
//! import reverse index) and `ProgramIndex` (typeflow) -- is NOT owned by
//! this module: `main.rs` already keeps one long-lived `SyntaxWorkerState`
//! alive across every `IndexingCommand` for the whole process lifetime (see
//! `main()`'s `syntax_state` local, used by the v3 pipeline today). `v4`
//! commands share that SAME instance under project keys of the form
//! `v4:{workspace_id}` (`analyze.rs`), which never collide with v3's own
//! project-key namespace -- so `main.rs` only needs to thread that one
//! existing `&mut SyntaxWorkerState` through to `v4::scan::run` (see
//! `main.rs`'s `WorkspaceScan` dispatch arm), not stand up a second
//! instance. `ProgramIndex`/typeflow is not wired into the v4 facts pipeline
//! at all yet (P2's cold pipeline never wires it in either -- `analyze.rs`'s
//! `resolve_pending_sites` is a permanent stub until a future task lands
//! P1's typeflow output here), so there is nothing typeflow-shaped to cache
//! or invalidate incrementally in THIS task: P3-1 inherits that scope
//! boundary from P2:2b unchanged, it is not a P3 regression.
//!
//! On a worker restart, `WorkerState` starts empty: the first `WorkspaceScan`
//! for a given `workspace_id` after a restart pays `Frontier::load` (~20 ms
//! on n8n) plus, for a `Changed` scan specifically, a fresh `StoreReader::
//! open` (mmaps the current base+deltas) and `SyntaxWorkerState`'s own
//! from-scratch parse of every root (since `main.rs`'s shared `syntax_state`
//! has no project entry for this workspace yet either) -- documented as the
//! "first scan after restart" cost the task brief asks for, not silently
//! hidden. Once warm, both stay in memory for the rest of the process's
//! life.

use super::ScanError;
use super::analyze::{blob_path, is_config_asset_path, is_jsts_source_path};
use super::typeflow::TypeflowCache;
use rusqlite::Connection;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use urdira_jsts_syntax_worker::{ConfigAssetInput, SourceInput};
use urdira_source_frontier::Frontier;
use urdira_structural_store::StoreReader;

/// P3-2 item 1: the caller-owned, incrementally-maintained equivalent of
/// what `analyze::run_scoped` used to build from scratch on EVERY call --
/// a `HashMap` walk over `frontier.present` (14k+ entries on n8n) plus one
/// `SourceInput`/`ConfigAssetInput` struct clone per entry, genuinely
/// O(corpus) despite never touching a byte of source content (confirmed
/// live: `docs/evidence/2026-09-03-v4-p3-1-incremental.md` §7.4 -- a
/// DELETE mutation, which affects zero owners' facts, paid nearly the same
/// `parse_ms` as an EDIT, because this rebuild dominated `parse_ms` either
/// way). Kept as two `BTreeMap<String, _>`s (not `Vec`s) specifically so
/// [`Self::files_vec`]/[`Self::config_assets_vec`] can hand `run_scoped`
/// an already-path-sorted `Vec` via a single `.values().cloned().collect()`
/// -- preserving the exact deterministic ordering guarantee the old
/// from-scratch build's explicit `.sort_by(...)` call used to provide,
/// with no separate sort step needed after an incremental update.
#[derive(Default)]
pub struct SourceCache {
    files: BTreeMap<String, SourceInput>,
    config_assets: BTreeMap<String, ConfigAssetInput>,
}

impl SourceCache {
    /// Builds the cache from every entry in `frontier.present` -- O(corpus),
    /// used only for a cold scan (already O(corpus) by nature) or the first
    /// `Changed` scan a freshly-restarted worker process sees for a
    /// workspace (the same documented "first scan after restart" cost this
    /// module's own doc comment already names for `Frontier`/`StoreReader`).
    pub fn build_full(frontier: &Frontier, cas_root: &Path) -> Result<Self, ScanError> {
        let mut cache = SourceCache::default();
        let touched: Vec<String> = frontier.present.keys().cloned().collect();
        cache.apply_delta(frontier, cas_root, &touched, &[])?;
        Ok(cache)
    }

    /// Applies exactly the paths a catalog delta named as added/changed
    /// (`touched`, looked up fresh against the POST-apply `frontier`) or
    /// removed (`deleted`) -- O(delta), never O(corpus). Every `touched`
    /// entry is removed from both maps first, then reinserted under
    /// whichever classification (`jsts` source / config asset / neither)
    /// its CURRENT path implies, so a path that changes classification
    /// between calls (not expected in practice, but not assumed away
    /// either) never leaves a stale entry behind under the wrong map.
    pub fn apply_delta(
        &mut self,
        frontier: &Frontier,
        cas_root: &Path,
        touched: &[String],
        deleted: &[String],
    ) -> Result<(), ScanError> {
        for uri in touched {
            self.files.remove(uri);
            self.config_assets.remove(uri);
            let Some(entry) = frontier.present.get(uri) else {
                // Named as touched but not present post-apply (e.g.
                // excluded by inclusion rules): nothing to cache, same as
                // the from-scratch build's original per-entry loop only
                // ever inserting entries it found in `frontier.present`.
                continue;
            };
            if is_jsts_source_path(uri) {
                self.files.insert(
                    uri.clone(),
                    SourceInput {
                        path: uri.clone(),
                        artifact_id: entry.artifact_id.clone(),
                        artifact_version_id: entry.artifact_version_id.clone(),
                        content_digest: entry.content_hash.clone(),
                        source_blob_path: blob_path(cas_root, &entry.content_hash)?,
                        byte_length: usize::try_from(entry.byte_length).unwrap_or(usize::MAX),
                    },
                );
            } else if is_config_asset_path(uri) {
                self.config_assets.insert(
                    uri.clone(),
                    ConfigAssetInput {
                        path: uri.clone(),
                        content_digest: entry.content_hash.clone(),
                        source_blob_path: blob_path(cas_root, &entry.content_hash)?,
                        byte_length: usize::try_from(entry.byte_length).unwrap_or(usize::MAX),
                    },
                );
            }
        }
        for uri in deleted {
            self.files.remove(uri);
            self.config_assets.remove(uri);
        }
        Ok(())
    }

    /// The current full, path-sorted `SourceInput` list -- what
    /// `analyze::run_scoped` needs as its `files` argument (a cold OR
    /// incremental call both need the FULL current corpus list: `analyze()`
    /// itself decides, from its own cached project state, which of these
    /// paths actually need reparsing).
    pub fn files_vec(&self) -> Vec<SourceInput> {
        self.files.values().cloned().collect()
    }

    /// Same as [`Self::files_vec`], for config assets (E2 resolver inputs).
    pub fn config_assets_vec(&self) -> Vec<ConfigAssetInput> {
        self.config_assets.values().cloned().collect()
    }

    /// O(log n) lookup of one path's cached `SourceInput` (P2-2e: lets
    /// `delta::run` fetch a touched path's blob coordinate to feed
    /// `TypeflowCache::replace_file_from_owner` without paying
    /// `files_vec()`'s O(corpus) clone for a single entry).
    pub fn get_file(&self, path: &str) -> Option<&SourceInput> {
        self.files.get(path)
    }
}

/// Everything this module caches for one workspace between `WorkspaceScan`
/// commands.
pub struct WorkspaceState {
    pub frontier: Frontier,
    /// `None` until the first `Changed` scan (or a `Full` scan followed by a
    /// same-process `Changed` scan) actually needs to read the structural
    /// store -- a cold scan never needs a reader, since `publish::
    /// publish_cold` writes the store directly and has nothing to diff
    /// against.
    pub store_reader: Option<StoreReader>,
    /// `None` until the first scan (cold or incremental) that has a
    /// `cas_root` available builds it -- P3-2 item 1's incremental
    /// `files`/`config_assets` cache (see [`SourceCache`]'s own doc
    /// comment).
    pub source_cache: Option<SourceCache>,
    /// P2-2e: the per-file `DeclSummary` cache backing this workspace's
    /// typeflow `ProgramIndex` (see [`TypeflowCache`]'s own doc comment).
    /// `None` until the first scan (cold or incremental) builds it -- same
    /// "first scan after restart" lifecycle as `source_cache`.
    pub typeflow_cache: Option<TypeflowCache>,
}

/// Per-workspace state for every `WorkspaceScan` this worker process has
/// handled. Owned by `main()`'s command loop, alongside its existing
/// `operations`/`syntax_state` locals (see this module's doc comment), and
/// threaded into `v4::scan::run` by reference on every call.
pub type WorkerState = HashMap<String, WorkspaceState>;

/// Returns the cached [`WorkspaceState`] for `workspace_id`, loading
/// [`Frontier::load`] from `conn` on first use for this workspace (plan
/// §4.1). Never re-loads the frontier for a workspace already in `states` --
/// callers that already applied a delta to the returned state's `frontier`
/// keep that in-memory mutation for the rest of the process's life.
pub fn ensure_workspace<'a>(
    states: &'a mut WorkerState,
    conn: &Connection,
    workspace_id: &str,
) -> Result<&'a mut WorkspaceState, ScanError> {
    if !states.contains_key(workspace_id) {
        let frontier = Frontier::load(conn, workspace_id)?;
        states.insert(
            workspace_id.to_string(),
            WorkspaceState {
                frontier,
                store_reader: None,
                source_cache: None,
                typeflow_cache: None,
            },
        );
    }
    Ok(states.get_mut(workspace_id).expect("just inserted above"))
}
