//! P3-1: `ScanScope::Changed` -- the incremental publish path (plan §6).
//! Orchestrates, for a `Changed{paths}` command: catalog delta only for the
//! named paths (§4.1/§6.2 step 1), scoped parse/facts for exactly the
//! affected closure (§4.2-§4.5/§6.2 steps 2-4, delegated to `analyze::
//! run_incremental`), the per-owner diff (§6.3, delegated to `diff::
//! diff_owner`), a `delta-<g>` segment write (`urdira_structural_store::
//! writer::SegmentWriter::write_delta`) plus an incremental `graph` merkle
//! update (`urdira-structural-store` itself only tracks `records`/
//! `dependency`, same gap `publish.rs` documents for the cold path), and
//! the SQLite snapshot transaction (`publish::publish_delta`).
//!
//! **Documented scope narrowing versus the plan's exact wording (§6.3),
//! reported here rather than silently left implicit:**
//! - Dependency rows are diffed at OWNER granularity, not by `dependency_id`
//!   (plan §6.3's "deps/edges: regenerar y diff por edge_id/dependency_id
//!   [abrir nuevas, cerrar ausentes]"): every affected/deleted owner's
//!   PREVIOUS dependency rows are closed unconditionally and its freshly
//!   materialized ones opened unconditionally, rather than keeping an
//!   unchanged dependency edge open across the edit. `DependencyRow.record`
//!   is left `None` on this path (the already-documented "bare `record:`
//!   sentinel" fallback `deps.rs` supports): the record ordinal `deps.rs`
//!   would otherwise attach a dependency to is only stable within ONE
//!   `materialize_generation` call's own `records` vector, which this
//!   diff's "unchanged, keep" case can drop entries from AFTER
//!   materialization already ran -- reusing that ordinal here would
//!   sometimes point a dependency at the wrong opened row. Both
//!   simplifications keep dependency volume bounded by the affected
//!   closure (never O(corpus)), at the cost of a dependency edge's own
//!   valid_from churning every time its OWNING file (not necessarily the
//!   edge itself) is edited, and of `DependencyRow.record` being
//!   unpopulated on this path. Neither affects `record_id`/Merkle root
//!   correctness for records (the gate this task measures against);
//!   flagged here as a residual precision gap for whichever task next
//!   tightens dependency identity.
//! - A `Changed` batch that mixes a genuine content edit with a
//!   create/delete of a DIFFERENT path in the SAME command USED TO fall
//!   back, inside `urdira-jsts-syntax-worker::SyntaxWorkerState::analyze`
//!   itself (existing, tested v3/v4-shared logic, not something this
//!   module changes), to reparsing every currently-known root -- its own
//!   `path_membership_incremental` fast path requires that EVERY path
//!   present both before and after the batch kept byte-identical content,
//!   which a mixed batch violates. **P3-2 item 5 fixes this** at the
//!   `run`/`run_one` split above: `run` detects a mixed batch and splits
//!   it into two sequential internal generations (structural changes
//!   first, then the edit), each of which is a PURE batch that hits
//!   `analyze()`'s cheap path on its own -- see `run`'s own doc comment.
//!   A pure create, a pure delete, a pure edit, and a rename (delete+create
//!   of the SAME content under a new path, with no Modified entries) were
//!   never affected by this in the first place.
//! - A file's owner ordinal is NOT stable across a content edit: this
//!   pipeline's dictionary scheme (`materialize.rs`'s module doc) keys
//!   `dicts.artifacts` on the full `(artifact_id, artifact_version_id)`
//!   pair, and an edit always opens a new `artifact_version_id` -- so
//!   every edit mints a fresh owner ordinal rather than reusing the file's
//!   previous one. This is deliberate (append-only dictionaries cannot
//!   cheaply support in-place mutation of an existing entry's value half
//!   without breaking `Dictionaries::suffix_from`'s length-based delta
//!   slicing), not an oversight -- every consumer of `owner_artifact`/
//!   `owner_version` resolves the CURRENT ordinal for a path fresh from
//!   the CURRENT catalog+dictionaries on every query, never caching a
//!   stale one, so this has no query-visible effect. This module resolves
//!   both the OLD and NEW ordinal explicitly wherever it matters (see
//!   `resolve_owner_ordinal`/`MaterializedGeneration::owner_ordinals`).

use super::diff::{self, OwnerDiff};
use super::materialize;
use super::publish;
use super::state::WorkerState;
use super::timings::ScanClock;
use super::{ScanError, catalog};
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use urdira_jsts_syntax_worker::SyntaxWorkerState;
use urdira_source_frontier::frontier::FrontierEntry;
use urdira_source_frontier::inclusion::{GitIgnoreRules, default_workspace_inclusion};
use urdira_source_frontier::{BatchMeta, CasStore, Catalog, Delta as SourceDelta, Walker};
use urdira_structural_store::row::{DependencyRow, Dictionaries, RecordRow};
use urdira_structural_store::{SetKind, StoreReader};
use urdira_worker_protocol::{ChangeKind, ChangedPath, IndexingEvent};

/// Reverse `(artifact_id, artifact_version_id) -> ordinal` lookup over a
/// `Dictionaries.artifacts` snapshot -- built once per `Changed` scan.
fn owner_ordinal_lookup(dicts: &Dictionaries) -> HashMap<(String, String), u32> {
    dicts
        .artifacts
        .iter()
        .enumerate()
        .map(|(ordinal, pair)| (pair.clone(), ordinal as u32))
        .collect()
}

/// The OLD owner ordinal for `path`, if it had one before this scan's
/// catalog delta applied (`None` for a genuinely new path -- nothing to
/// diff against).
///
/// **P3-3 item 1, the root cause of the digest-churn bug** (`docs/evidence/
/// 2026-09-03-v4-p3-2-incremental-residuals.md` §6, `docs/evidence/
/// 2026-09-03-v4-p3-3-digest-churn.md`): `old_entries` is captured ONLY for
/// the request's literally-named `changed_paths` (`run_one`'s own
/// `old_entries` local, built before `Catalog::apply`) -- but this
/// function is called for every path in `affected_owner_paths`, which
/// `analyze::run_incremental`'s own `reverse_affected_closure` widens to
/// every TRANSITIVE importer of a changed file, most of which are never in
/// `changed_paths` at all. For those (an owner whose OWN bytes never
/// changed, only a transitive dependency's did), `old_entries.get(path)`
/// used to return `None` -- indistinguishable from "genuinely new path" --
/// so `diff_owner` was handed an empty `prev` for an owner whose records
/// were, in fact, live and completely unchanged, forcing every one of its
/// fresh (byte-identical) records through the "no live row under this
/// identity in THIS owner" fallback (`by_identity_last` -> owner
/// migration/reopen, both of which CLOSE the existing row and OPEN a new
/// chained id) instead of the "same identity + same digest, live -> keep"
/// branch. Confirmed live: a 3-file `a.ts` imports `b.ts` imports `c.ts`
/// fixture, editing only `c.ts`, produced a COMPLETELY disjoint
/// `record_id` set for `a.ts` between generation 1 and generation 2 even
/// though `a.ts`'s freshly-extracted `ProposedRecord`s were proven
/// byte-for-byte identical at the facts-extraction layer (see this
/// module's sibling test file, `tests_e2e.rs`'s
/// `unaffected_transitive_importer_produces_identical_records_across_an_incremental_edit`
/// and `_zero_record_churn_in_the_store`).
///
/// Fix: for any path `old_entries` has no entry for, it was NOT named in
/// this scan's own `changed_paths` batch, which means `Catalog::apply`
/// never touched its frontier entry at all -- so `current_present` (the
/// frontier taken AFTER `Catalog::apply`, i.e. `workspace_state.frontier.
/// present`) still holds that path's one and only, unchanged
/// `(artifact_id, artifact_version_id)` pair, identical to what it was
/// before this scan. Using it here is exactly correct, not an
/// approximation: "old" and "current" are the same value for a path this
/// delta never wrote to.
fn old_owner_ordinal(
    path: &str,
    old_entries: &HashMap<String, Option<FrontierEntry>>,
    current_present: &HashMap<String, FrontierEntry>,
    ordinal_of: &HashMap<(String, String), u32>,
) -> Option<u32> {
    let entry = match old_entries.get(path) {
        Some(pre_apply_entry) => pre_apply_entry.as_ref(),
        None => current_present.get(path),
    }?;
    ordinal_of
        .get(&(entry.artifact_id.clone(), entry.artifact_version_id.clone()))
        .copied()
}

/// P3-2 item 5: dispatches a `Changed{paths}` command to [`run_one`] --
/// SPLIT into two sequential internal generations first when `changed_paths`
/// mixes a genuine content edit (`ChangeKind::Modified`) with an UNRELATED
/// structural change (`ChangeKind::Created`/`Deleted`) in the SAME batch.
///
/// Why split at all: `urdira_jsts_syntax_worker::SyntaxWorkerState::analyze`'s
/// `path_membership_incremental` fast path (the mechanism that makes a pure
/// create/delete/rename cheap -- see `run_one`'s own module doc) requires
/// EVERY path present both before and after the batch to have kept
/// byte-identical content; a batch that ALSO edits an unrelated file
/// violates that precondition and falls back to reparsing every current
/// root from scratch (documented, not a bug in that function -- it has no
/// way to certify a mixed batch's safety on its own). A pure structural
/// batch (only Created/Deleted -- including a rename, which is exactly a
/// same-generation Created+Deleted pair with NO Modified entries) or a pure
/// content batch (only Modified) each already hit that fast path on their
/// own and are NOT split here.
///
/// The split itself: structural changes publish FIRST as their own
/// generation (a pure create/delete, cheap), then content changes publish
/// SECOND, against the now-updated frontier/store (a pure edit, also
/// cheap) -- both happen inside this ONE `WorkspaceScan` command, so
/// `on_queryable` fires twice (once per internal generation, both valid,
/// strictly-increasing states) and the CALLER (daemon/tests) never needs
/// to know a mixed batch was split at all: the terminal event returned is
/// the second (content) pass's `ScanCompleted`, at the batch's final
/// generation. Each pass gets its OWN `ScanClock` (not the caller's) so
/// `queryable_timings()`/the final `ScanTimings` report reflect that one
/// pass's own phases, not a blend of both -- `run_one`'s existing
/// correctness (every fixture/n8n-scale root-equality test already
/// exercises it as a single-batch call) is unchanged; this function adds
/// no new pipeline logic, only sequencing.
#[allow(clippy::too_many_arguments)]
pub fn run(
    request: &super::scan::ScanRequest,
    changed_paths: &[ChangedPath],
    conn: &mut Connection,
    workspace_root: &Path,
    structural_root: &Path,
    cas_root: &Path,
    syntax: &mut SyntaxWorkerState,
    worker_state: &mut WorkerState,
    clock: &mut ScanClock,
    on_queryable: &mut dyn FnMut(IndexingEvent) -> Result<(), String>,
) -> Result<IndexingEvent, ScanError> {
    if changed_paths.is_empty() {
        return Err(ScanError(
            "v4 WorkspaceScan{scope: Changed} requires at least one path".into(),
        ));
    }
    let has_structural = changed_paths
        .iter()
        .any(|p| matches!(p.kind, ChangeKind::Created | ChangeKind::Deleted));
    let has_content = changed_paths
        .iter()
        .any(|p| matches!(p.kind, ChangeKind::Modified));
    if has_structural && has_content {
        let (structural, content): (Vec<ChangedPath>, Vec<ChangedPath>) = changed_paths
            .iter()
            .cloned()
            .partition(|p| matches!(p.kind, ChangeKind::Created | ChangeKind::Deleted));
        if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
            eprintln!(
                "[urdira-indexing-worker] v4 delta: mixed burst split into two generations: structural={structural:?} content={content:?}"
            );
        }
        let mut structural_clock = ScanClock::start();
        run_one(
            request,
            &structural,
            conn,
            workspace_root,
            structural_root,
            cas_root,
            syntax,
            worker_state,
            &mut structural_clock,
            on_queryable,
        )?;
        let mut content_clock = ScanClock::start();
        return run_one(
            request,
            &content,
            conn,
            workspace_root,
            structural_root,
            cas_root,
            syntax,
            worker_state,
            &mut content_clock,
            on_queryable,
        );
    }
    run_one(
        request,
        changed_paths,
        conn,
        workspace_root,
        structural_root,
        cas_root,
        syntax,
        worker_state,
        clock,
        on_queryable,
    )
}

#[allow(clippy::too_many_arguments)]
fn run_one(
    request: &super::scan::ScanRequest,
    changed_paths: &[ChangedPath],
    conn: &mut Connection,
    workspace_root: &Path,
    structural_root: &Path,
    cas_root: &Path,
    syntax: &mut SyntaxWorkerState,
    worker_state: &mut WorkerState,
    clock: &mut ScanClock,
    on_queryable: &mut dyn FnMut(IndexingEvent) -> Result<(), String>,
) -> Result<IndexingEvent, ScanError> {
    // P3-1 deliverable 2: generation counter. `Changed` on a workspace that
    // has never published a generation makes no sense (there is nothing to
    // diff against) -- the daemon should send `Full` for a brand-new
    // workspace; fail closed rather than silently treating it as a cold
    // scan under a different code path.
    let current_generation = catalog::read_current_generation(conn, &request.workspace_id)?;
    if current_generation == 0 {
        return Err(ScanError(
            "v4 WorkspaceScan{scope: Changed} requires a prior generation; send scope: Full for a new workspace"
                .into(),
        ));
    }
    let generation_i64 = current_generation + 1;
    let generation = u64::try_from(generation_i64)
        .map_err(|_| ScanError("generation must be non-negative".into()))?;
    let generation_u32 = u32::try_from(generation)
        .map_err(|_| ScanError("generation exceeds u32 (structural store limit)".into()))?;
    let prev_generation = generation - 1;

    let workspace_state =
        super::state::ensure_workspace(worker_state, conn, &request.workspace_id)?;

    // Ensure the cached `StoreReader` exists and reflects the CURRENT
    // MANIFEST (cheap: an mtime/content check on a warm reader, a full
    // mmap open only the first time this workspace's store is touched in
    // this process -- see `state.rs`'s module doc on the "first scan after
    // restart" cost).
    match &mut workspace_state.store_reader {
        Some(reader) => {
            reader.reopen_if_changed()?;
        }
        None => {
            workspace_state.store_reader = Some(StoreReader::open(structural_root)?);
        }
    }

    // Capture every named path's PRE-apply frontier entry: `Catalog::apply`
    // (below) mutates `workspace_state.frontier` in place, closing/
    // tombstoning entries this call needs the OLD `(artifact_id,
    // artifact_version_id)` pair for (a modified file's prior owner
    // ordinal; a deleted file's owner entirely).
    let old_entries: HashMap<String, Option<FrontierEntry>> = changed_paths
        .iter()
        .map(|p| {
            (
                p.path.clone(),
                workspace_state.frontier.present.get(&p.path).cloned(),
            )
        })
        .collect();

    // --- Catalog delta (plan §4.1/§6.2 step 1) ---
    let catalog_started = std::time::Instant::now();
    let cas = CasStore::open(cas_root)
        .map_err(|error| ScanError(format!("failed to open CAS root {cas_root:?}: {error}")))?;
    let rules = default_workspace_inclusion();
    let gitignore = GitIgnoreRules {
        enabled: false,
        patterns: Vec::new(),
    };
    let path_strings: Vec<String> = changed_paths.iter().map(|p| p.path.clone()).collect();
    let observations = Walker::observe_paths(
        workspace_root,
        &path_strings,
        &rules,
        &gitignore,
        Some(&cas),
    );
    let source_delta = SourceDelta::compute_partial(&workspace_state.frontier, &observations);
    let now = super::now_iso8601();
    let batch_meta = BatchMeta {
        source_provider_binding_id: format!("urdira:v4-directory-walker:{}", request.workspace_id),
        source_provider: "urdira:v4-directory-walker".to_string(),
        source_provider_version: "1".to_string(),
        started_at: now.clone(),
        completed_at: now,
        full_scan: false,
    };
    let applied = Catalog::apply(
        conn,
        &request.workspace_id,
        &mut workspace_state.frontier,
        &source_delta,
        generation_i64,
        &batch_meta,
    )?;
    catalog::restore_steady_state_pragmas(conn)?;
    clock.record_catalog(catalog_started.elapsed());

    // `urdira_jsts_syntax_worker::SyntaxWorkerState::analyze`'s own
    // `authoritative_changed_paths` validates `changed_artifact_ids`
    // against the EXACT set of artifact ids whose presence/metadata
    // differs between its retained manifest and the current one --
    // discovered live (a real bug in this task's first draft, which only
    // included content-MODIFIED artifact ids and omitted created/deleted
    // ones): every added, changed, AND deleted path's artifact id belongs
    // here, not just content edits. `path_membership_incremental` (inside
    // `analyze()`) still takes the cheap path for pure add/remove -- this
    // set is a correctness precondition for that function to accept the
    // call at all, not a scope-narrowing choice this module makes.
    let mut changed_artifact_ids: Vec<String> = source_delta
        .changed
        .iter()
        .chain(source_delta.added.iter())
        .filter_map(|observation| {
            workspace_state
                .frontier
                .present
                .get(&observation.normalized_uri)
                .map(|entry| entry.artifact_id.clone())
        })
        .collect();
    for uri in &source_delta.deleted {
        if let Some(Some(old_entry)) = old_entries.get(uri) {
            changed_artifact_ids.push(old_entry.artifact_id.clone());
        }
    }
    changed_artifact_ids.sort();
    changed_artifact_ids.dedup();

    // P3-2 item 1: maintain `workspace_state.source_cache` in O(delta)
    // instead of letting `analyze::run_scoped` rebuild `files`/
    // `config_assets` from the ENTIRE frontier on every call (confirmed
    // live as the dominant cost of a steady-state edit's `parse_ms`,
    // §7.4 of the P3-1 evidence doc: a DELETE, which touches zero owners'
    // facts, paid nearly the same `parse_ms` as an edit). First `Changed`
    // scan for this workspace in this process (no prior `Full` scan seeded
    // it): build once from the frontier -- the same documented "first scan
    // after restart" cost already paid for `Frontier`/`StoreReader`.
    match &mut workspace_state.source_cache {
        Some(cache) => {
            let touched: Vec<String> = source_delta
                .added
                .iter()
                .chain(source_delta.changed.iter())
                .map(|observation| observation.normalized_uri.clone())
                .collect();
            cache.apply_delta(
                &workspace_state.frontier,
                cas_root,
                &touched,
                &source_delta.deleted,
            )?;
        }
        None => {
            workspace_state.source_cache = Some(super::state::SourceCache::build_full(
                &workspace_state.frontier,
                cas_root,
            )?);
        }
    }

    // P2-2e: maintain `workspace_state.typeflow_cache` the same way, off
    // the SAME touched/deleted lists `source_cache` above just applied (a
    // `DeclSummary` depends only on its own file's text -- see
    // `TypeflowCache`'s own doc comment -- so this is exactly as safe to
    // scope to `touched`/`deleted` as `source_cache`'s own update is).
    // First `Changed` scan for this workspace in this process (no prior
    // `Full` scan seeded it): build once from the NOW-current `source_cache`
    // -- the same documented "first scan after restart" cost already paid
    // for `Frontier`/`StoreReader`/`source_cache` itself.
    let source_cache_ref = workspace_state
        .source_cache
        .as_ref()
        .expect("populated just above (either updated in place or built fresh)");
    match &mut workspace_state.typeflow_cache {
        Some(typeflow_cache) => {
            for observation in &source_delta.added {
                // Not a jsts source path (excluded, or a config asset) --
                // nothing to summarize.
                if let Some(owner) = source_cache_ref.get_file(&observation.normalized_uri) {
                    typeflow_cache.add_from_owner(owner)?;
                }
            }
            for observation in &source_delta.changed {
                match source_cache_ref.get_file(&observation.normalized_uri) {
                    Some(owner) => typeflow_cache.replace_file_from_owner(owner)?,
                    // No longer a jsts source path -- drop any stale entry
                    // the same way `source_cache`'s own dual-map removal
                    // does.
                    None => typeflow_cache.remove(&observation.normalized_uri),
                }
            }
            for path in &source_delta.deleted {
                typeflow_cache.remove(path);
            }
        }
        None => {
            workspace_state.typeflow_cache = Some(super::typeflow::TypeflowCache::build_full(
                &source_cache_ref.files_vec(),
            )?);
        }
    }

    if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
        eprintln!(
            "[urdira-indexing-worker] v4 delta DEBUG: changed_paths={:?} source_delta.added={:?} source_delta.changed={:?} source_delta.deleted={:?} changed_artifact_ids={:?}",
            changed_paths
                .iter()
                .map(|p| (p.path.clone(), format!("{:?}", p.kind)))
                .collect::<Vec<_>>(),
            source_delta
                .added
                .iter()
                .map(|o| o.normalized_uri.clone())
                .collect::<Vec<_>>(),
            source_delta
                .changed
                .iter()
                .map(|o| o.normalized_uri.clone())
                .collect::<Vec<_>>(),
            source_delta.deleted,
            changed_artifact_ids,
        );
    }

    // --- Scoped parse + facts (plan §4.2-§4.5/§6.2 steps 2-4) ---
    let source_cache = workspace_state
        .source_cache
        .as_ref()
        .expect("populated just above (either updated in place or built fresh)");
    let typeflow_cache = workspace_state
        .typeflow_cache
        .as_mut()
        .expect("populated just above (either updated in place or built fresh)");
    let analysis = super::analyze::run_incremental(
        source_cache.files_vec(),
        source_cache.config_assets_vec(),
        &request.workspace_id,
        syntax,
        changed_artifact_ids,
        clock,
        typeflow_cache,
    )?;
    let affected_owner_paths: Vec<String> = analysis
        .owners
        .iter()
        .map(|o| o.owner_path.clone())
        .collect();
    if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
        eprintln!(
            "[urdira-indexing-worker] v4 delta DEBUG: affected_owner_paths={affected_owner_paths:?}"
        );
    }

    let store_reader = workspace_state
        .store_reader
        .as_ref()
        .expect("opened/refreshed above");
    let base_dicts = store_reader.dictionaries();
    let ordinal_of = owner_ordinal_lookup(&base_dicts);
    // P3-3 item 1: `old_owner_ordinal`'s fallback for a path this delta's
    // own `changed_paths` never named (see its own doc comment) --
    // `workspace_state.frontier.present` here is the POST-`Catalog::apply`
    // frontier, which is byte-identical to the pre-apply one for any path
    // outside `changed_paths`.
    let current_present = &workspace_state.frontier.present;

    // --- Materialize the affected owners (plan §4.5/§6.2 step 4) ---
    let materialize_started = std::time::Instant::now();
    let external_lookup = |identity_key: &str| -> Option<[u8; 32]> {
        let digest = identity_key_digest_bytes(identity_key);
        store_reader
            .by_identity_last(&digest)
            .map(|view| view.record_id())
    };
    let materialized = materialize::materialize_incremental(
        analysis.owners,
        generation_u32,
        &base_dicts,
        &external_lookup,
    )?;
    clock.record_materialize(materialize_started.elapsed());

    let mut records_by_owner: HashMap<u32, Vec<RecordRow>> = HashMap::new();
    for record in materialized.records {
        records_by_owner
            .entry(record.owner_artifact)
            .or_default()
            .push(record);
    }
    let mut deps_by_owner: HashMap<u32, Vec<DependencyRow>> = HashMap::new();
    for dep in materialized.dependencies {
        deps_by_owner
            .entry(dep.owner_artifact)
            .or_default()
            .push(dep);
    }

    // --- Per-owner diff (plan §6.3) ---
    let write_started = std::time::Instant::now();
    let mut opened_records: Vec<RecordRow> = Vec::new();
    let mut record_closures: Vec<([u8; 32], u32)> = Vec::new();
    let mut closed_relation_keys: Vec<[u8; 32]> = Vec::new();
    let mut kernel_to_final: HashMap<[u8; 32], [u8; 32]> = HashMap::new();
    let mut opened_deps: Vec<DependencyRow> = Vec::new();
    let mut deps_closures: Vec<([u8; 32], u32)> = Vec::new();

    let mut diff_one_owner =
        |prev_ordinal: Option<u32>, next_records: Vec<RecordRow>, next_deps: Vec<DependencyRow>| {
            let prev_records = match prev_ordinal {
                Some(ordinal) => store_reader.by_owner(ordinal, prev_generation),
                None => Vec::new(),
            };
            let owner_diff: OwnerDiff =
                diff::diff_owner(prev_records, next_records, store_reader, generation_u32);
            opened_records.extend(owner_diff.opened);
            record_closures.extend(owner_diff.record_closures);
            closed_relation_keys.extend(owner_diff.closed_relation_keys);
            kernel_to_final.extend(owner_diff.kernel_to_final);

            if let Some(ordinal) = prev_ordinal {
                for dep in store_reader.deps_by_owner(ordinal, prev_generation) {
                    deps_closures.push((dep.dependency_id(), generation_u32));
                }
            }
            opened_deps.extend(next_deps);
        };

    // Affected (modified/created) owners: diff each by path, resolving its
    // OLD ordinal (if any -- `None` for a brand-new file) and NEW ordinal
    // (`materialized.owner_ordinals`, guaranteed present for every path in
    // `affected_owner_paths`).
    for path in &affected_owner_paths {
        let old_ordinal = old_owner_ordinal(path, &old_entries, current_present, &ordinal_of);
        let new_ordinal = materialized
            .owner_ordinals
            .get(path)
            .copied()
            .expect("materialize_incremental assigns an ordinal to every owner it processes");
        let next_records = records_by_owner.remove(&new_ordinal).unwrap_or_default();
        let next_deps = deps_by_owner.remove(&new_ordinal).unwrap_or_default();
        diff_one_owner(old_ordinal, next_records, next_deps);
    }

    // Deleted owners: no fresh rows at all, close everything under their
    // OLD ordinal.
    let mut deleted_owner_ordinals: HashSet<u32> = HashSet::new();
    for uri in &source_delta.deleted {
        if let Some(ordinal) = old_owner_ordinal(uri, &old_entries, current_present, &ordinal_of) {
            deleted_owner_ordinals.insert(ordinal);
        }
        // Not found: this owner never had any materialized rows (e.g. a
        // non-JS/TS file, or a file deleted before it was ever indexed) --
        // nothing to close.
    }
    for ordinal in deleted_owner_ordinals {
        diff_one_owner(Some(ordinal), Vec::new(), Vec::new());
    }
    // P3-2 item 6/8 diagnostic (kept permanently, `URDIRA_DEBUG_TIMING`-gated,
    // same convention as this crate's other debug-timing prints): bisects
    // `write_ms` into diff-loop / `write_delta` / graph-merkle thirds.
    // Found live at n8n hub-edit scale (`packages/nodes-base/utils/
    // utilities.ts`, ~377 direct importers): `reverse_affected_closure`
    // (`urdira-jsts-syntax-worker`) widens to 841 TRANSITIVELY affected
    // owners, and -- this is the real, still-open finding, NOT explained by
    // this task's own original "surface_hash" hypothesis for item 6 --
    // `opened_records`/`record_closures` come back around 107k EACH (near
    // 1:1, i.e. `diff_owner` classifies nearly EVERY record of all 841
    // owners as a "replacement", not "unchanged, keep") even though NONE
    // of those 841 files' own source bytes changed. `record_digest` is
    // supposed to be a pure function of `identity_key`/`body`/`kind`/etc.
    // (`urdira-native-core::structural_record_digest_hash`), never a
    // dictionary ordinal or anything path-external -- so a byte-identical
    // file re-emitting a DIFFERENT digest through `facts_for_paths` points
    // at some order/context-dependent field in that extraction path
    // (candidates: `evidence_references`, a relative index baked into an
    // id, or JSON key-order nondeterminism), not yet isolated. See the
    // evidence doc's own writeup for the measured impact (~5.8s of a
    // ~6.9-7.9s hub-edit total) and why item 6's originally-scoped
    // "surface-hash-narrow-the-closure" fix would ALSO have sidestepped
    // this (never touching these 841 owners at all), but was not
    // implemented this session either.
    if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
        eprintln!(
            "[urdira-indexing-worker] v4 delta DEBUG BISECT: diff loop done at {:.3}s (affected_owners={} opened_records={} record_closures={} opened_deps={} deps_closures={})",
            write_started.elapsed().as_secs_f64(),
            affected_owner_paths.len(),
            opened_records.len(),
            record_closures.len(),
            opened_deps.len(),
            deps_closures.len(),
        );
    }

    // Patch `dicts.subjects`' NEW suffix: any entry appended THIS
    // generation that still names a kernel-cold id (materialize resolved
    // it before this diff ran) must point at the row's real final id
    // instead (see `diff.rs`'s doc comment on `OwnerDiff::kernel_to_final`).
    let mut dicts = materialized.dicts;
    let suffix_start = base_dicts.subjects.len();
    for subject in dicts.subjects.iter_mut().skip(suffix_start) {
        if let Some(&final_id) = kernel_to_final.get(subject) {
            *subject = final_id;
        }
    }
    let dict_additions = dicts.suffix_from(&base_dicts);

    let graph_changes = diff::graph_changes(&opened_records, &closed_relation_keys);

    // P3-2 item 2: reuse the ALREADY-OPEN, already-refreshed `store_reader`
    // (refreshed via `reopen_if_changed()` at the top of this function,
    // before any read or write touched this store dir) instead of letting
    // `write_delta` open a second one internally -- skips a full
    // `StoreInner::load` (every closure across every delta, every
    // dictionary segment, a full `subject_index` rebuild), which measured
    // ~300-480ms of a steady-state edit's own `write_ms` at n8n scale
    // (§7.3-§7.4 of the P3-1 evidence doc).
    let writer = urdira_structural_store::writer::SegmentWriter::new();
    let summary = writer
        .write_delta_with_reader(
            structural_root,
            store_reader,
            &opened_records,
            &record_closures,
            &opened_deps,
            &deps_closures,
            &dict_additions,
            generation,
        )
        .map_err(|error| ScanError(format!("v4 delta publish: write_delta failed: {error}")))?;
    if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
        eprintln!(
            "[urdira-indexing-worker] v4 delta DEBUG BISECT: write_delta_with_reader done at {:.3}s",
            write_started.elapsed().as_secs_f64(),
        );
    }

    // Incremental `graph` merkle update (this crate's own responsibility:
    // `urdira-structural-store` only tracks `records`/`dependency`, same
    // gap `publish.rs` documents for the cold path).
    let merkle_dir = structural_root.join("merkle");
    let graph_root = if graph_changes.is_empty() {
        urdira_structural_store::merkle::read_root(&merkle_dir, SetKind::Graph).map_err(
            |error| ScanError(format!("v4 delta publish: graph root read failed: {error}")),
        )?
    } else {
        // O(N) grouping up front -- see `diff::group_changes_by_bucket`'s
        // doc comment for the O(N^2) bug this replaces (found live at n8n
        // hub-edit scale: `graph_bucket_entries` used to rescan the FULL
        // `graph_changes` list on every one of up to N distinct-bucket
        // calls).
        let graph_changes_by_bucket = diff::group_changes_by_bucket(&graph_changes);
        let empty_graph_changes: &[urdira_indexing_core::merkle_bucket::Change] = &[];
        let bucket_entries = |idx: u32| {
            diff::graph_bucket_entries(
                store_reader,
                idx,
                prev_generation,
                graph_changes_by_bucket
                    .get(&idx)
                    .map(Vec::as_slice)
                    .unwrap_or(empty_graph_changes),
            )
        };
        let (graph_set, touched) = urdira_structural_store::merkle::load_and_update(
            &merkle_dir,
            SetKind::Graph,
            &graph_changes,
            bucket_entries,
        )
        .map_err(|error| ScanError(format!("v4 delta publish: graph update failed: {error}")))?;
        let root = graph_set.root();
        urdira_structural_store::merkle::persist_slots(
            &graph_set,
            &touched,
            &merkle_dir,
            SetKind::Graph,
            generation,
        )
        .map_err(|error| ScanError(format!("v4 delta publish: graph persist failed: {error}")))?;
        root
    };
    if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
        eprintln!(
            "[urdira-indexing-worker] v4 delta DEBUG BISECT: graph merkle done at {:.3}s (graph_changes={})",
            write_started.elapsed().as_secs_f64(),
            graph_changes.len(),
        );
    }
    // Metric root: no metric generator exists anywhere in this pipeline
    // (cold or incremental) -- always the canonical empty set, same as
    // `publish.rs`'s cold path.
    let metric_root = urdira_structural_store::merkle::read_root(&merkle_dir, SetKind::Metric)
        .unwrap_or([0u8; 32]);

    let opened_records_count = opened_records.len();
    let opened_deps_count = opened_deps.len();
    let graph_opened_count = opened_records
        .iter()
        .filter(|row| row.category == urdira_structural_store::row::CATEGORY_RELATION)
        .count();
    let graph_closed_count = closed_relation_keys.len();
    drop(opened_records);
    drop(opened_deps);

    clock.record_write(write_started.elapsed());

    let manifest_path = structural_root.join("MANIFEST");
    on_queryable(IndexingEvent::Queryable {
        request_id: request.request_id.clone(),
        operation_id: request.request_id.clone(),
        generation,
        manifest_path: manifest_path.to_string_lossy().into_owned(),
        timings: clock.queryable_timings(),
    })
    .map_err(ScanError)?;

    let snapshot_started = std::time::Instant::now();
    let result = publish::publish_delta(
        conn,
        request,
        generation_i64,
        &applied.source_state_digest,
        &summary,
        graph_root,
        metric_root,
        opened_records_count,
        opened_deps_count,
        graph_opened_count,
        graph_closed_count,
        clock,
    );
    clock.record_snapshot(snapshot_started.elapsed());
    result
}

/// UCE text digest (`sha256(tag(3) ++ varint(len) ++ bytes)`), the exact
/// recipe `urdira-native-core`'s private `uce_text_digest_bytes` uses for
/// `RecordRow.identity_key_digest` (confirmed by reading that function
/// directly) -- an independent byte-identical copy, same isolation
/// rationale `publish.rs`'s own `uce`/`json_digest` port already
/// documents (this crate cannot depend on `urdira-native-core`'s private
/// functions). `pub(super)` (not private): this module's own EXTERNAL-
/// lookup closure hashes an identity_key string into the SAME digest
/// space `StoreReader::by_identity_last` indexes by, independent of the
/// kernel's own per-row computation; `materialize.rs`'s `resolve_
/// subject_key` (P2-2h item 4) hashes the SAME kind of string (a
/// relation's `source_id`/`target_id`) against its in-batch
/// `identity_key_to_ordinal` map for the identical reason, so it reuses
/// this same function rather than growing a third copy.
pub(super) fn identity_key_digest_bytes(value: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update([3u8]);
    uce_varint(value.len(), &mut hasher);
    hasher.update(value.as_bytes());
    hasher.finalize().into()
}

fn uce_varint(mut value: usize, hasher: &mut sha2::Sha256) {
    use sha2::Digest;
    loop {
        let mut byte = (value % 128) as u8;
        value /= 128;
        if value > 0 {
            byte |= 0x80;
        }
        hasher.update([byte]);
        if value == 0 {
            break;
        }
    }
}
