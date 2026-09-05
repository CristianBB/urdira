//! v4 scan orchestrator (plan §4): catalog -> parse/semantics -> facts ->
//! materialise -> write -> Merkle -> snapshot -> events, for one
//! `IndexingCommand::WorkspaceScan`. `main.rs`'s dispatch arm calls
//! [`run_with_residual`] and forwards the closure it returns errors through
//! as `IndexingEvent::Error`.

use super::residual::{self, ResidualContext, ResidualEventTarget};
use super::{ScanError, catalog, delta, publish, state::WorkerState, timings::ScanClock};
use std::path::{Path, PathBuf};
use urdira_jsts_syntax_worker::SyntaxWorkerState;
use urdira_worker_protocol::{IndexingEvent, ScanPriority, ScanScope};

pub struct ScanRequest {
    pub request_id: String,
    pub workspace_id: String,
    pub workspace_root: String,
    pub database_path: String,
    pub structural_root: String,
    pub cas_root: String,
    /// Not read yet: the lexical/semantic sidecars (plan §4.7/P2-6) are out
    /// of this task's scope. Carried through the protocol now so P2-6 does
    /// not need another protocol revision.
    #[allow(dead_code)]
    pub sidecar_root: String,
    pub scope: ScanScope,
    pub registry_snapshot_id: String,
    pub configuration_revision_id: String,
    pub resolution_lock_id: String,
    pub deadline_ms: Option<u64>,
    pub priority: ScanPriority,
}

/// Runs one `WorkspaceScan` to completion, invoking `on_queryable` exactly
/// once (right after segments hit page cache and `MANIFEST.next` is
/// written, plan §2.6) before continuing to the durable/snapshot phase.
/// Returns the terminal event (`ScanCompleted`) on success; the caller
/// (`main.rs`) turns an `Err` into `IndexingEvent::Error`.
///
/// `syntax` and `worker_state` are P3-1 deliverable 1's persistent state:
/// `main.rs` keeps ONE `SyntaxWorkerState` and ONE `v4::state::WorkerState`
/// alive for the whole process lifetime and passes them into every
/// `WorkspaceScan` call (cold or incremental) -- see `state.rs`'s module
/// doc for why a single `SyntaxWorkerState` instance safely serves both v3
/// and v4 traffic, and why `Frontier`/`StoreReader` are cached per
/// workspace here rather than reloaded from disk on every call.
/// Also schedules the P1-D-c background residual pass (`residual::
/// schedule`) after a successful `ScanCompleted` -- non-blocking, see
/// `residual.rs`'s own module doc. `residual_events` is `None` for every
/// caller with no live stdout stream to eventually address (tests, tools).
pub fn run_with_residual(
    request: ScanRequest,
    syntax: &mut SyntaxWorkerState,
    worker_state: &mut WorkerState,
    on_queryable: &mut dyn FnMut(IndexingEvent) -> Result<(), String>,
    residual_events: Option<ResidualEventTarget>,
) -> Result<IndexingEvent, ScanError> {
    let _ = request.deadline_ms; // budget checkpoints are a follow-up, not part of this task's scope.
    let _ = request.priority; // no scheduling distinction yet: one worker, one scan at a time.

    let mut clock = ScanClock::start();
    let workspace_root = PathBuf::from(&request.workspace_root);
    let database_path = PathBuf::from(&request.database_path);
    let structural_root = PathBuf::from(&request.structural_root);
    let cas_root = PathBuf::from(&request.cas_root);

    let mut conn = catalog::open_and_ensure_schema(&database_path)?;

    // F4 4.1: `None` for a `Full` scan (cold: the residual pass's own file
    // map covers the whole frontier, same as before this task) and
    // `Some(touched_owner_paths)` for a `Changed` scan -- `delta::run`
    // already computes this exact list (edited/created + deleted owner
    // paths) for the external-entity close-protection pass, so this just
    // carries it one level up rather than re-deriving it.
    let mut touched_owner_paths: Option<Vec<String>> = None;
    let result = match request.scope.clone() {
        ScanScope::Full => run_full(
            &request,
            &mut conn,
            &workspace_root,
            &structural_root,
            &cas_root,
            syntax,
            worker_state,
            &mut clock,
            on_queryable,
        ),
        ScanScope::Changed { paths } => delta::run(
            &request,
            &paths,
            &mut conn,
            &workspace_root,
            &structural_root,
            &cas_root,
            syntax,
            worker_state,
            &mut clock,
            on_queryable,
        )
        .map(|(event, touched)| {
            touched_owner_paths = Some(touched);
            event
        }),
    };

    // P1-D-c: opt-in for now (default off). Every existing test/tool
    // calling `run`/`run_with_residual` (1400+ tests, none of which expect
    // a background tsgo child process to spawn) must keep working
    // unchanged; a real deployment turns this on explicitly. Flip the
    // default once `main.rs`'s owner wires the `ResidualEventTarget` seam
    // this module's doc comment describes and a daemon-level opt-in
    // policy exists.
    let residual_enabled = std::env::var_os("URDIRA_V4_RESIDUAL").is_some_and(|v| v != "0");
    if residual_enabled && matches!(&result, Ok(IndexingEvent::ScanCompleted { .. })) {
        residual::schedule(
            ResidualContext {
                request_id: request.request_id.clone(),
                workspace_id: request.workspace_id.clone(),
                workspace_root: request.workspace_root.clone(),
                database_path: request.database_path.clone(),
                structural_root: request.structural_root.clone(),
                cas_root: request.cas_root.clone(),
                registry_snapshot_id: request.registry_snapshot_id.clone(),
                configuration_revision_id: request.configuration_revision_id.clone(),
                resolution_lock_id: request.resolution_lock_id.clone(),
                touched_owners: touched_owner_paths,
                reschedule_count: 0,
            },
            residual_events,
        );
    }

    result
}

#[allow(clippy::too_many_arguments)]
fn run_full(
    request: &ScanRequest,
    conn: &mut rusqlite::Connection,
    workspace_root: &Path,
    structural_root: &Path,
    cas_root: &Path,
    syntax: &mut SyntaxWorkerState,
    worker_state: &mut WorkerState,
    clock: &mut ScanClock,
    on_queryable: &mut dyn FnMut(IndexingEvent) -> Result<(), String>,
) -> Result<IndexingEvent, ScanError> {
    // P3-1 deliverable 2: `generation = current + 1`, `current = 0` for a
    // brand-new workspace -- fixes the P2-2b hardcode this task's brief
    // names explicitly ("scan.rs HARDCODES generation = 1"). A `Full` scan
    // of an ALREADY-published workspace (a forced full rescan, or the
    // daemon's own "reindex from scratch" path) now correctly continues
    // from that workspace's real current generation instead of colliding
    // on `source_observation_batches`' primary key.
    let generation = catalog::read_current_generation(conn, &request.workspace_id)? + 1;
    let debug_timing = std::env::var_os("URDIRA_DEBUG_TIMING").is_some();
    if debug_timing {
        eprintln!(
            "[urdira-indexing-worker] v4 rss@start: {:.1} MiB",
            super::timings::peak_rss_mib()
        );
    }

    let catalog_started = std::time::Instant::now();
    let mut outcome = catalog::run_full_scan(
        conn,
        &request.workspace_id,
        workspace_root,
        cas_root,
        generation,
    )?;
    // P2-2h item 2: pull the background CAS write queue out of `outcome`
    // now (it started draining the instant the walk began) but do NOT
    // join it yet -- it keeps draining, unattended, concurrently with
    // every phase below (analyze/materialize/publish, tens of seconds on
    // a real corpus), and is only actually waited on after
    // `publish::publish_cold` returns, i.e. AFTER this scan's `Queryable`
    // event has already fired -- see the `cas_write_queue.join()` call
    // below.
    let cas_write_queue = outcome
        .cas_write_queue
        .take()
        .expect("run_full_scan always populates cas_write_queue");
    // See `catalog::open_and_ensure_schema`'s doc comment: the cold
    // catalog transaction just above ran with `synchronous=OFF` for
    // speed (journal_mode stays `WAL` throughout, so concurrent readers
    // are never blocked); restore `synchronous=NORMAL` now, before
    // `publish::publish_cold`'s own snapshot transaction (the write that
    // actually makes this workspace `ScanCompleted`) runs on the same
    // connection.
    catalog::restore_steady_state_pragmas(conn)?;
    clock.record_catalog(catalog_started.elapsed());
    if debug_timing {
        eprintln!(
            "[urdira-indexing-worker] v4 rss@post-catalog: {:.1} MiB",
            super::timings::peak_rss_mib()
        );
    }

    // P2-2g item 4 diagnostic (temporary, `URDIRA_DEBUG_TIMING`-gated):
    // `run_cold`'s own `parse_ms`/`resolve_ms` only cover the `analyze()` +
    // facts + hybrid-semantics calls themselves; this wraps the WHOLE call
    // (file/config-asset partitioning + sort before the first timer starts,
    // and everything between `clock.record_parse`/`record_resolve`) so a
    // residual gap can be localized to inside vs. outside `run_cold`
    // without guessing -- see this task's evidence doc §14 for the number.
    let run_cold_started = std::time::Instant::now();
    // P3-2 item 1: `run_cold` also returns the `SourceCache` it built,
    // seeded into this workspace's `WorkspaceState` below on success -- the
    // very first `Changed` scan in this process then starts from an
    // already-built cache instead of paying its own from-scratch build
    // (the "first scan after restart" cost only actually applies when a
    // `Full` scan has never run in this process at all).
    let (analysis, source_cache, typeflow_cache) = super::analyze::run_cold(
        &outcome.frontier,
        cas_root,
        &request.workspace_id,
        syntax,
        clock,
    )?;
    let run_cold_elapsed = run_cold_started.elapsed();
    if debug_timing {
        eprintln!(
            "[urdira-indexing-worker] v4 rss@post-resolve: {:.1} MiB",
            super::timings::peak_rss_mib()
        );
    }

    let materialize_started = std::time::Instant::now();
    // P2-2j item 2: the partitioned cold fast path -- verified byte-for-
    // byte identical `write_base` output for the same rows
    // (`urdira-structural-store/tests/write_base_partitioned_test.rs`) and
    // root-identical against the real n8n corpus (this task's evidence
    // doc). `materialize_cold`/`publish_cold` (the flat, globally-sorted
    // path) are kept, unused by this call site, for every existing test
    // and as the oracle this task's own root-equality checks compare
    // against.
    let materialized = super::materialize::materialize_cold_partitioned(analysis.owners)?;
    let materialize_elapsed = materialize_started.elapsed();
    clock.record_materialize(materialize_elapsed);
    // A2 (pending.sites migration): captured before `materialized` moves
    // into `publish_cold_partitioned` below -- the only count from this
    // struct the debug timing report needs.
    let pending_sites_count = materialized.pending_sites.len();
    if debug_timing {
        eprintln!(
            "[urdira-indexing-worker] v4 rss@post-materialize: {:.1} MiB",
            super::timings::peak_rss_mib()
        );
        eprintln!("[urdira-indexing-worker] v4 materialize: pending_sites={pending_sites_count}");
    }

    let publish_started = std::time::Instant::now();
    let result = publish::publish_cold_partitioned(
        conn,
        request,
        structural_root,
        generation,
        &outcome,
        materialized,
        clock,
        on_queryable,
    );
    let publish_elapsed = publish_started.elapsed();
    // P2-2h item 2: join the background CAS write queue now -- AFTER
    // `Queryable` has already fired (inside `publish_cold`, above) and
    // AFTER the structural store itself is durable, but BEFORE this scan
    // reports `ScanCompleted`: `get_source`/FTS need every blob durably on
    // disk, and `ScanCompleted` is this pipeline's only "everything this
    // scan promised is now true" signal. In the common case this queue
    // already drained entirely while catalog's own `apply` + `analyze` +
    // `materialize` + `publish` ran (tens of seconds of CPU-bound work
    // overlapping a few seconds of background disk writes), so this join
    // is a fast no-op wait; it is measured either way (see
    // `URDIRA_DEBUG_TIMING`'s report below) so a regression that makes it
    // NOT overlap is visible instead of silently absorbed into
    // `catalog_ms`.
    let cas_join_started = std::time::Instant::now();
    let cas_join_result = cas_write_queue.join();
    let cas_join_elapsed = cas_join_started.elapsed();
    let cas_join_ms = u64::try_from(cas_join_elapsed.as_millis()).unwrap_or(u64::MAX);
    let result = result.and_then(|event| match cas_join_result {
        // Fold the join wait into `fsync_ms` (the same "durable, post-
        // Queryable tail" bucket `publish_cold` already uses for its own
        // fsync + SQLite snapshot work, per item 1's "Queryable vs
        // ScanCompleted split") and `total_ms`, so a caller reading
        // `ScanCompleted.timings` sees this wait accounted for instead of
        // it silently inflating the gap between `total_ms` and the sum of
        // the other phases. Done here (not via `ScanClock`, which already
        // returned its `completed_timings()` snapshot inside
        // `publish_cold` before this join ran) by patching the already-
        // built event directly.
        Ok(()) => Ok(match event {
            IndexingEvent::ScanCompleted {
                request_id,
                operation_id,
                generation,
                snapshot_id,
                roots,
                mut timings,
            } => {
                timings.fsync_ms = Some(timings.fsync_ms.unwrap_or(0) + cas_join_ms);
                timings.total_ms += cas_join_ms;
                IndexingEvent::ScanCompleted {
                    request_id,
                    operation_id,
                    generation,
                    snapshot_id,
                    roots,
                    timings,
                }
            }
            other => other,
        }),
        Err(error) => Err(ScanError(format!(
            "v4 cold scan: background CAS write queue failed: {error}"
        ))),
    });
    if debug_timing {
        eprintln!(
            "[urdira-indexing-worker] v4 scan orchestrator: run_cold_total={:.3}s materialize_call={:.3}s publish_call={:.3}s cas_join={:.3}s",
            run_cold_elapsed.as_secs_f64(),
            materialize_elapsed.as_secs_f64(),
            publish_elapsed.as_secs_f64(),
            cas_join_elapsed.as_secs_f64(),
        );
        eprintln!(
            "[urdira-indexing-worker] v4 rss@scan-completed: {:.1} MiB",
            super::timings::peak_rss_mib()
        );
    }
    // P3-1 deliverable 1: seed/replace this workspace's cached `Frontier`
    // with the one this scan just built and applied, and drop any stale
    // `StoreReader` (a fresh `base-<generation>` now exists; the next
    // `Changed` scan opens/reopens it lazily). Done regardless of
    // `publish_cold`'s own outcome is wrong -- only cache the frontier on
    // success, since a failed publish must not poison the next scan's
    // catalog state with a frontier whose matching store never landed.
    if result.is_ok() {
        worker_state.insert(
            request.workspace_id.clone(),
            super::state::WorkspaceState {
                frontier: outcome.frontier,
                store_reader: None,
                source_cache: Some(source_cache),
                typeflow_cache: Some(typeflow_cache),
            },
        );
    }
    result
}
