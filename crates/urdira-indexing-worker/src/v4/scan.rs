//! v4 scan orchestrator (plan §4): catalog -> parse/semantics -> facts ->
//! materialise -> write -> Merkle -> snapshot -> events, for one
//! `IndexingCommand::WorkspaceScan`. `main.rs`'s dispatch arm calls
//! [`run_with_residual`] and forwards the closure it returns errors through
//! as `IndexingEvent::Error`.

use super::residual::{self, ResidualContext, ResidualEventTarget};
use super::{ScanError, catalog, delta, publish, state::WorkerState, timings::ScanClock};
use std::path::{Path, PathBuf};
use urdira_jsts_syntax_worker::SyntaxWorkerState;
use urdira_source_frontier::{Delta as SourceDelta, Frontier};
use urdira_structural_store::to_prefixed_hex;
use urdira_worker_protocol::{
    ChangeKind, ChangedPath, IndexingEvent, ReconcileMode, ReconcileSummary, ScanPriority,
    ScanRoots, ScanScope,
};

/// Frente E (plan `generic-waddling-hartmanis.md` §0 R1, §2.2): fraction of
/// the frontier a reconcile's authoritative delta may touch before
/// `run_reconcile` gives up on the incremental (`delta::run`) path and
/// republishes through the full pipeline instead (`run_full_from`) -- T
/// moves WHICH pipeline does the work, never the resulting Merkle roots
/// (both branches are diffed against the exact same authoritative
/// enumeration). Override for the threshold-calibration harness (plan
/// §2.6) and for tests that want to force one branch deterministically.
pub const RECONCILE_DELTA_THRESHOLD: f64 = 0.25;

fn reconcile_threshold() -> f64 {
    std::env::var("URDIRA_V4_RECONCILE_THRESHOLD")
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(RECONCILE_DELTA_THRESHOLD)
}

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
        ScanScope::Reconcile => run_reconcile(
            &request,
            // R1/R2 test hooks read here, ONCE, at this crate's one
            // production call site -- `run_reconcile` itself takes them as
            // plain parameters (not env reads) specifically so
            // `tests_e2e.rs` can call it directly with different values
            // side by side in one process: this crate is `#![forbid(unsafe_
            // code)]` (`main.rs:1`), and `std::env::set_var`/`remove_var`
            // are `unsafe fn` -- a test cannot toggle these env vars itself
            // (same reasoning as `residual.rs::collect`'s `force_scan`
            // parameter for `URDIRA_V4_ENTITY_INDEX`).
            reconcile_threshold(),
            std::env::var_os("URDIRA_V4_RECONCILE_FAIL_DELTA").is_some(),
            // No production env var for this one -- it is a test-only hook
            // (see `run_with_failure_injection`'s doc comment); production
            // always passes `false`.
            false,
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
            touched_owner_paths = touched;
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
                visible_owners: None,
                reschedule_count: 0,
            },
            residual_events,
        );
    }

    result
}

/// `ScanScope::Full` entry point: computes the next generation, then
/// performs ONE authoritative walk (`catalog::enumerate` + `catalog::diff`)
/// before handing off to [`run_full_from`] -- which also serves the
/// reconcile cold path (`run_reconcile`, below) with an enumeration it
/// already has in hand, so this crate never walks the same tree twice for
/// one `WorkspaceScan` request.
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
    //
    // Adversarial-review hardening (Frente E, 2026-09-06):
    // `read_current_generation` alone reads only the PUBLISHED pointer
    // (`workspace_current_state`); `read_highest_applied_generation`'s own
    // doc comment explains why that can be stale after a crash mid-scan
    // (`Catalog::apply` commits before `publish_delta`/`publish_cold` ever
    // runs) -- the daemon's own crash-recovery sweep
    // (`packages/daemon/src/runtime.ts`'s "a workspace left `indexing` by a
    // prior process life") retries exactly such a workspace with a fresh
    // `Full` scan, which is this function. Byte-identical to the old
    // behavior whenever the two counters agree (the overwhelmingly common
    // case: `publish` always follows `apply` within the same successful
    // request), and closes the SAME `source_observation_batches`
    // primary-key collision `run_reconcile`'s cold fallback fix
    // (`catalog.rs`) closes for the reconcile-specific path.
    let generation = catalog::read_highest_applied_generation(conn, &request.workspace_id)? + 1;
    let enumeration = catalog::enumerate(workspace_root, cas_root)?;
    let (frontier, delta) = catalog::diff(conn, &request.workspace_id, &enumeration.observations)?;
    run_full_from(
        request,
        conn,
        structural_root,
        cas_root,
        syntax,
        worker_state,
        clock,
        on_queryable,
        generation,
        enumeration,
        frontier,
        delta,
    )
}

/// Shared tail of a `Full` scan and a reconcile's cold fallback (plan §2.2):
/// takes an authoritative `(enumeration, frontier, delta)` triple -- already
/// walked and diffed by the caller (`run_full`, or `run_reconcile` below) --
/// and runs `apply_full -> analyze -> materialize -> publish` exactly like
/// the pre-Frente-E `run_full` always did (this function's body is that
/// function's tail, unchanged, just parameterized over its catalog inputs
/// instead of computing them itself).
#[allow(clippy::too_many_arguments)]
fn run_full_from(
    request: &ScanRequest,
    conn: &mut rusqlite::Connection,
    structural_root: &Path,
    cas_root: &Path,
    syntax: &mut SyntaxWorkerState,
    worker_state: &mut WorkerState,
    clock: &mut ScanClock,
    on_queryable: &mut dyn FnMut(IndexingEvent) -> Result<(), String>,
    generation: i64,
    enumeration: catalog::Enumeration,
    frontier: Frontier,
    delta: SourceDelta,
) -> Result<IndexingEvent, ScanError> {
    let debug_timing = std::env::var_os("URDIRA_DEBUG_TIMING").is_some();
    if debug_timing {
        eprintln!(
            "[urdira-indexing-worker] v4 rss@start: {:.1} MiB",
            super::timings::peak_rss_mib()
        );
    }

    let catalog_started = std::time::Instant::now();
    let mut outcome = catalog::run_full_scan_with_enumeration(
        conn,
        &request.workspace_id,
        enumeration,
        frontier,
        &delta,
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
    // Targeted-wait fix: a cheap `Arc`-backed handle onto the queue's own
    // completion registry (see `CasWrittenSignal`'s doc comment,
    // `urdira-source-frontier`'s `cas.rs`), threaded into `analyze::
    // run_cold` below so `read_owner_source_text` can wait for the EXACT
    // blob it needs instead of polling `std::fs::read` on `NotFound`
    // (the old `read_blob_with_retry`, removed). Cloning this out now (the
    // queue is still actively draining) does not affect `cas_write_queue`
    // itself -- `submit`/`join` still work normally on it below.
    let cas_signal = cas_write_queue.signal();
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
        &cas_signal,
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
                reconcile,
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
                    reconcile,
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

/// `ScanScope::Reconcile` (Frente E, plan §2.2): an event-driven "unknown
/// extent of change" signal (a git branch switch, a lost watcher batch, a
/// provider reset) that -- unlike `Changed`, which trusts the caller's own
/// path list -- ALWAYS re-derives the delta from an authoritative walk
/// (plan §0's invariant: "el reconcile usa SIEMPRE la enumeración
/// autoritativa completa, nunca la pista del watcher"). What that delta's
/// SIZE decides is only which pipeline republishes it:
/// - empty (`n == 0`): a no-op, `ReconcileMode::Noop` -- nothing new to
///   publish, the caller gets back the CURRENT generation's own roots.
/// - small (`n <= T * frontier_size`): `delta::run` republishes exactly the
///   touched owners, `ReconcileMode::Delta`.
/// - large, or the delta attempt fails outright: the full pipeline
///   (`run_full_from`) republishes the WHOLE authoritative enumeration,
///   `ReconcileMode::Cold` (`fell_back_to_cold: true` only in the failure
///   case, plan §0 R2).
///
/// Every branch is diffed against the SAME authoritative enumeration this
/// function performs up front, so `T` can only move which pipeline runs,
/// never the resulting Merkle roots -- the exact property
/// `tests_e2e.rs`'s `reconcile_*_roots_match_a_from_scratch_scan_of_the_
/// mutated_tree`/`reconcile_batches_match_cold_at_*` tests hold both
/// branches to.
///
/// Returns `touched_owner_paths` the same way `run_with_residual`'s other
/// two scopes do (see that function's own doc comment): `Some(touched)` for
/// `Delta` (the residual pass can scope itself to exactly what changed),
/// `None` for `Cold` (the residual pass's own full file map already covers
/// the whole frontier), `Some(vec![])` for `Noop` (nothing to re-schedule).
///
/// `threshold`/`inject_delta_failure` are plain parameters, not env reads
/// inside this function -- this crate is `#![forbid(unsafe_code)]`
/// (`main.rs:1`) and `std::env::set_var`/`remove_var` are `unsafe fn`, so a
/// test cannot toggle `URDIRA_V4_RECONCILE_THRESHOLD`/`URDIRA_V4_RECONCILE_
/// FAIL_DELTA` itself (same reasoning as `residual.rs::collect`'s
/// `force_scan` parameter for `URDIRA_V4_ENTITY_INDEX`). Production has
/// exactly one call site (`run_with_residual`'s `ScanScope::Reconcile` arm),
/// which reads both env vars once and passes the results in here;
/// `tests_e2e.rs`'s `reconcile_batches_match_cold_at_1_5_10_25_50_percent`/
/// `reconcile_falls_back_to_cold_when_delta_fails` call this function
/// directly with explicit values instead -- `pub`, not `pub(super)`, for the
/// same reason `catalog::run_full_scan` etc. are: this binary crate has no
/// library target, so `pub` only ever means "visible elsewhere in this same
/// binary" (`tests_e2e.rs` included), never a published API surface.
#[allow(clippy::too_many_arguments)]
pub fn run_reconcile(
    request: &ScanRequest,
    threshold: f64,
    inject_delta_failure: bool,
    inject_delta_failure_after_apply: bool,
    conn: &mut rusqlite::Connection,
    workspace_root: &Path,
    structural_root: &Path,
    cas_root: &Path,
    syntax: &mut SyntaxWorkerState,
    worker_state: &mut WorkerState,
    clock: &mut ScanClock,
    on_queryable: &mut dyn FnMut(IndexingEvent) -> Result<(), String>,
) -> Result<(IndexingEvent, Option<Vec<String>>), ScanError> {
    let debug_timing = std::env::var_os("URDIRA_DEBUG_TIMING").is_some();
    let current_generation = catalog::read_current_generation(conn, &request.workspace_id)?;
    if current_generation == 0 {
        return Err(ScanError(
            "v4 WorkspaceScan{scope: Reconcile} requires a prior generation; send scope: Full for a new workspace"
                .into(),
        ));
    }

    let enumeration = catalog::enumerate(workspace_root, cas_root)?;
    let walk_elapsed = enumeration.walk_elapsed;
    let (mut frontier, delta) =
        catalog::diff(conn, &request.workspace_id, &enumeration.observations)?;

    let added = delta.added.len() as u64;
    let changed = delta.changed.len() as u64;
    let deleted = delta.deleted.len() as u64;
    let touched_count = added + changed + deleted;
    let frontier_size = frontier.present.len() as u64;
    // Frente E-fix: uris this reconcile's authoritative delta found
    // content-equivalent but with a stale `metadata_digest` -- never
    // counted in `touched_count`/the threshold decision (a metadata-only
    // difference is not "extent of change"), always refreshed regardless
    // of which branch below actually runs (`Noop` refreshes it directly,
    // below; `Delta`/`Cold` refresh it as part of `Catalog::apply`'s own
    // transaction, same as any other batch).
    let metadata_refreshed = delta.metadata_refreshed.len() as u64;

    if debug_timing {
        eprintln!(
            "[urdira-indexing-worker] v4 reconcile: added={added} changed={changed} deleted={deleted} frontier={frontier_size} metadata_refreshed={metadata_refreshed} threshold={threshold} walk={:.3}s",
            walk_elapsed.as_secs_f64(),
        );
    }

    // R3: an empty authoritative delta is a no-op -- nothing new to
    // publish, the current generation's own roots stand. Still closes the
    // CAS write queue this call's own walk started (nothing to write for
    // an unchanged tree, but every queue this module spawns must be joined
    // exactly once).
    if touched_count == 0 {
        enumeration.cas_write_queue.join().map_err(|error| {
            ScanError(format!(
                "v4 reconcile: background CAS write queue failed: {error}"
            ))
        })?;
        // Frente E-fix: a true `Noop` never calls `Catalog::apply` (there
        // is nothing added/changed/deleted to publish, and this branch
        // must not mint a new generation) -- but the delta can still carry
        // `metadata_refreshed` entries (a byte-identical tree whose stat
        // metadata moved: a `touch`, a checkout, an index-pack import).
        // `Catalog::refresh_metadata` applies exactly those in one short,
        // dedicated transaction that never touches `source_index_state`/
        // `workspace_current_state`, so the next reconcile of the SAME
        // untouched tree does not rediscover and re-refresh the identical
        // set again. No-ops immediately when the vector is empty.
        urdira_source_frontier::Catalog::refresh_metadata(
            conn,
            &request.workspace_id,
            &mut frontier,
            &delta.metadata_refreshed,
        )?;
        // This process may already have a cached `WorkspaceState` for this
        // workspace from an earlier `Changed` scan (`state::ensure_
        // workspace`) -- its own `Frontier` is a SEPARATE in-memory copy
        // from the one `catalog::diff` just loaded above (this function
        // never reads or writes `worker_state`'s cache otherwise), so keep
        // it current too: harmless to skip (content_hash is the only field
        // `classify` ever compares), but keeps `metadata_digest` from
        // drifting between the two copies for as long as this process runs.
        if let Some(state) = worker_state.get_mut(&request.workspace_id) {
            for (uri, new_metadata_digest) in &delta.metadata_refreshed {
                if let Some(entry) = state.frontier.present.get_mut(uri) {
                    entry.metadata_digest = new_metadata_digest.clone();
                }
            }
        }
        let generation_u64 = u64::try_from(current_generation)
            .map_err(|_| ScanError("generation must be non-negative".into()))?;
        let roots = read_generation_roots(conn, current_generation)?;
        let summary = ReconcileSummary {
            mode: ReconcileMode::Noop,
            added,
            changed,
            deleted,
            frontier_size,
            threshold,
            fell_back_to_cold: false,
            metadata_refreshed,
        };
        let event = IndexingEvent::ScanCompleted {
            request_id: request.request_id.clone(),
            operation_id: request.request_id.clone(),
            generation: generation_u64,
            snapshot_id: format!("snapshot:{}:{current_generation}", request.workspace_id),
            roots,
            timings: clock.completed_timings(),
            reconcile: Some(summary),
        };
        return Ok((event, Some(Vec::new())));
    }

    // Adversarial-review hardening: same reasoning as `run_full`'s own
    // generation computation, above -- `read_highest_applied_generation`
    // rather than the bare published pointer, so a reconcile reached via the
    // daemon's crash-recovery sweep (retrying a workspace a prior process
    // left `indexing`) cannot collide with a generation a crashed scan's own
    // `Catalog::apply` already committed but never published. Byte-identical
    // to `current_generation + 1` whenever the two counters agree.
    let next_generation =
        catalog::read_highest_applied_generation(conn, &request.workspace_id)? + 1;

    if (touched_count as f64) <= threshold * (frontier_size as f64) {
        // Small delta: republish exactly the touched owners through the
        // existing `Changed` pipeline (`delta::run` never inspects
        // `request.scope` -- see that module's own `run`/`run_one`, which
        // only read `request.workspace_id`/`request.request_id` -- so the
        // ORIGINAL request, still carrying `scope: Reconcile`, is passed
        // through unchanged).
        let paths: Vec<ChangedPath> = delta
            .added
            .iter()
            .map(|observation| ChangedPath {
                path: observation.normalized_uri.clone(),
                kind: ChangeKind::Created,
            })
            .chain(delta.changed.iter().map(|observation| ChangedPath {
                path: observation.normalized_uri.clone(),
                kind: ChangeKind::Modified,
            }))
            .chain(delta.deleted.iter().map(|uri| ChangedPath {
                path: uri.clone(),
                kind: ChangeKind::Deleted,
            }))
            .collect();
        // The blobs this call's own authoritative walk just queued are
        // already durably in CAS by the time `delta::run` below performs
        // its OWN (synchronous, path-scoped) `Walker::observe_paths` --
        // that call re-reads/re-hashes the same handful of touched paths
        // regardless, so this queue is drained and closed here rather than
        // threaded any further.
        enumeration.cas_write_queue.join().map_err(|error| {
            ScanError(format!(
                "v4 reconcile: background CAS write queue failed: {error}"
            ))
        })?;

        // R2 test hook: forces the delta attempt below to fail, exercising
        // the cold-fallback branch without needing a real corruption.
        let delta_result = if inject_delta_failure {
            Err(ScanError(
                "v4 reconcile: injected delta failure (URDIRA_V4_RECONCILE_FAIL_DELTA)".into(),
            ))
        } else {
            // Adversarial-review addition: `inject_delta_failure_after_apply`
            // (always `false` in production -- `run_with_residual`'s own
            // `ScanScope::Reconcile` arm never sets it) lets a test make
            // THIS call fail AFTER its own `Catalog::apply` already
            // committed `current_generation + 1`'s SQLite rows, unlike
            // `inject_delta_failure` above which never reaches `delta::run`
            // at all. See `run_with_failure_injection`'s doc comment and the
            // cold-fallback's generation computation below, which this hook
            // exists to regression-test.
            delta::run_with_failure_injection(
                request,
                &paths,
                conn,
                workspace_root,
                structural_root,
                cas_root,
                syntax,
                worker_state,
                clock,
                on_queryable,
                inject_delta_failure_after_apply,
            )
        };

        match delta_result {
            Ok((event, touched)) => {
                let summary = ReconcileSummary {
                    mode: ReconcileMode::Delta,
                    added,
                    changed,
                    deleted,
                    frontier_size,
                    threshold,
                    fell_back_to_cold: false,
                    metadata_refreshed,
                };
                return Ok((with_reconcile_summary(event, summary), Some(touched)));
            }
            Err(error) => {
                // R2: never a partial generation -- fall back to cold in
                // THIS SAME request. `delta::run`'s own `Catalog::apply`
                // may already have advanced the SQLite frontier before
                // whatever failed downstream, so the fallback re-walks and
                // re-diffs from scratch rather than reusing this
                // function's now-possibly-stale `frontier`/`delta`.
                eprintln!(
                    "[urdira-indexing-worker] v4 reconcile: delta failed: {error}; falling back to cold"
                );
                // Adversarial-review fix: NOT `read_current_generation(..) +
                // 1` -- that reads only the PUBLISHED pointer, which the
                // failed `delta::run` attempt may already have outrun (its
                // own `Catalog::apply` commits before `publish_delta` ever
                // runs). See `read_highest_applied_generation`'s doc comment
                // for why reusing a generation number `delta::run` already
                // wrote catalog rows for would fail this very fallback on a
                // `source_observation_batches` primary-key collision.
                let cold_generation =
                    catalog::read_highest_applied_generation(conn, &request.workspace_id)? + 1;
                let enumeration2 = catalog::enumerate(workspace_root, cas_root)?;
                let (frontier2, delta2) =
                    catalog::diff(conn, &request.workspace_id, &enumeration2.observations)?;
                let event = run_full_from(
                    request,
                    conn,
                    structural_root,
                    cas_root,
                    syntax,
                    worker_state,
                    clock,
                    on_queryable,
                    cold_generation,
                    enumeration2,
                    frontier2,
                    delta2,
                )?;
                let summary = ReconcileSummary {
                    mode: ReconcileMode::Cold,
                    added,
                    changed,
                    deleted,
                    frontier_size,
                    threshold,
                    fell_back_to_cold: true,
                    metadata_refreshed,
                };
                return Ok((with_reconcile_summary(event, summary), None));
            }
        }
    }

    // Large delta: finish the SAME authoritative enumeration through the
    // full pipeline -- no second walk.
    let event = run_full_from(
        request,
        conn,
        structural_root,
        cas_root,
        syntax,
        worker_state,
        clock,
        on_queryable,
        next_generation,
        enumeration,
        frontier,
        delta,
    )?;
    let summary = ReconcileSummary {
        mode: ReconcileMode::Cold,
        added,
        changed,
        deleted,
        frontier_size,
        threshold,
        fell_back_to_cold: false,
        metadata_refreshed,
    };
    Ok((with_reconcile_summary(event, summary), None))
}

/// Attaches `summary` to `event`'s `reconcile` field when it is a
/// `ScanCompleted` (the only terminal event `run_reconcile`'s callees --
/// `delta::run`/`run_full_from` -- ever return on success). Both of those
/// are shared pipelines with no reconcile-specific knowledge (`Changed`/
/// `Full` scans construct the identical event shape with `reconcile: None`),
/// so this patches the field on after the fact rather than threading a
/// reconcile-only parameter through either one.
fn with_reconcile_summary(event: IndexingEvent, summary: ReconcileSummary) -> IndexingEvent {
    match event {
        IndexingEvent::ScanCompleted {
            request_id,
            operation_id,
            generation,
            snapshot_id,
            roots,
            timings,
            ..
        } => IndexingEvent::ScanCompleted {
            request_id,
            operation_id,
            generation,
            snapshot_id,
            roots,
            timings,
            reconcile: Some(summary),
        },
        other => other,
    }
}

/// Reads back the Merkle roots `merkle_roots` holds for `generation` (plan
/// §0 R3: a reconcile no-op reports the CURRENT generation's own roots, not
/// a freshly computed set) -- the same four `set_kind`s
/// `publish.rs::write_snapshot_transaction` always writes
/// (`records`/`dependency`/`graph`/`metric`).
fn read_generation_roots(
    conn: &rusqlite::Connection,
    generation: i64,
) -> Result<ScanRoots, ScanError> {
    let root_for = |set_kind: &str| -> Result<String, ScanError> {
        let bytes: Vec<u8> = conn
            .query_row(
                "SELECT root FROM merkle_roots WHERE set_kind = ?1 AND generation = ?2",
                rusqlite::params![set_kind, generation],
                |row| row.get(0),
            )
            .map_err(|error| {
                ScanError(format!(
                    "v4 reconcile: reading {set_kind} root for generation {generation} failed: {error}"
                ))
            })?;
        let array: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
            ScanError(format!(
                "v4 reconcile: {set_kind} root for generation {generation} is not 32 bytes"
            ))
        })?;
        Ok(to_prefixed_hex(&array))
    };
    Ok(ScanRoots {
        records: root_for("records")?,
        dependency: root_for("dependency")?,
        graph: root_for("graph")?,
        metric: root_for("metric")?,
    })
}
