//! P1-D-c: the background residual TypeScript-checker pass (decision 28,
//! `docs/decisions/28-v4-rust-semantics-and-residual-checker.md`) -- the
//! piece that upgrades `possible` `core:call`/`core:inherits`/
//! `core:implements` rows (P2-2i, `docs/evidence/2026-09-04-v4-p2-2i-
//! possible-rows-and-pending-sites.md`) to `confirmed` using the real
//! TypeScript checker via `urdira-tsgo-client`'s `ResidualPass`
//! (`docs/evidence/2026-09-03-v4-p1d-b-residual-pass.md`), OUTSIDE the
//! critical path of any `WorkspaceScan`.
//!
//! # Why this module never touches `main.rs`'s command loop
//!
//! This task's brief does not list `main.rs` among the files this task
//! owns (a concurrent effort owns its dispatch-arm shape; see `mod.rs`'s
//! own module doc). A background job that must eventually emit an
//! `IndexingEvent::UpgradeCompleted` frame on the SAME stdout pipe the main
//! command loop writes to would ordinarily need a shared, mutex-guarded
//! writer -- but retrofitting that safely across every existing
//! `write_event`/`output.flush()` call site in `main.rs` (several thousand
//! lines, some on the v3 lane) is exactly the kind of broad, high-
//! collision-risk edit this task's ownership boundary exists to avoid.
//! **[`ResidualEventTarget`] documents the one minimal seam `main.rs`'s
//! owner needs to add** (a channel drained opportunistically at the top of
//! the read loop, or after each processed message) -- see that struct's
//! doc comment for the exact shape. Until that seam is wired, [`schedule`]
//! still does every bit of real work (collects pending sites, runs the
//! checker, diffs, and PUBLISHES the `semantic_upgrade` generation through
//! the normal SQLite/structural-store path -- the durable, authoritative
//! side effect any reader can already observe via
//! `generation_manifests.publication_kind = 'semantic_upgrade'` or a fresh
//! `core:find_references` query); it just also calls
//! `event_target.sender.send(...)`, which either reaches a real channel (if
//! the seam exists) or is silently dropped (`Err` on a disconnected
//! receiver, discarded) -- documented as a harmless no-op, never a panic.
//!
//! # Never two at once, never blocks an edit
//!
//! [`schedule`] bumps a per-workspace, process-lifetime epoch counter
//! (mirroring `main.rs`'s own `SECONDARY_MAINTENANCE_EPOCH`, but scoped per
//! workspace) every time it is called -- which is every `ScanCompleted`
//! (cold or incremental), from `scan::run`'s own tail. The spawned thread
//! checks its OWN epoch against the current one at three checkpoints
//! (after a short quiet period, again after the checker pass finishes, and
//! a final live-row re-verification per site immediately before
//! publishing); a mismatch at either of the first two means a newer
//! generation has already landed for this workspace and the run abandons
//! ALL of its work -- no partial publish. This is a deliberate
//! simplification of the task brief's fuller "finish the current window,
//! publish what it has for untouched owners, re-queue the rest" design:
//! re-deriving the untouched subset safely (a concurrent edit can change
//! which owners are "untouched" out from under an in-flight pass) is real,
//! separate scope; discarding and letting the NEXT `ScanCompleted`'s own
//! `schedule` call re-derive pending sites fresh from the now-current store
//! is always correct, if less efficient under a hot edit stream. Documented
//! here rather than silently narrowed.
//!
//! # Store access without a body decoder
//!
//! `urdira-structural-store` has no `pending.sites`/`entities.index` tables
//! (P2-2i deliverable 2 was explicitly NOT built) and this codebase has no
//! Rust-side decoder for `RecordRow.body`'s UCE-encoded bytes (only
//! `@urdira/canonical`'s JS decoder exists, per that evidence doc's own
//! §6). This module avoids needing one entirely: every field it needs is
//! already a plain metadata column on `RecordView` --
//! - a relation row's own span/owner/kind (`span_start_byte`/
//!   `span_end_byte`/`owner_artifact`/`universal_kind_id`),
//! - whether it is a `possible` row THIS module still needs to attempt
//!   (`target_subject().is_none()` -- see `collect()`'s own doc comment: a
//!   confirmed row always has one, and so, since P2-2j, does a per-candidate
//!   possible row for an overload/union receiver -- `target_subject().
//!   is_none()` alone is "no target AND not yet upgradable any further",
//!   which is exactly the population this module's own residual pass
//!   exists to work on; see `materialize.rs`'s subject-resolution pass),
//! - its calling entity's own id, via `source_subject()` -> `Dictionaries::
//!   subjects[ordinal]` (the SOURCE record's `record_id` bytes, per that
//!   field's own doc comment) -> `StoreReader::get` -> that record's
//!   `identity_key()`.
//!
//! An owner's PATH is recovered from its `owner_artifact` ordinal via
//! `Dictionaries::artifacts` + a `(artifact_id, artifact_version_id) ->
//! path` reverse index built once from the workspace's `Frontier`
//! (mirrors `delta.rs`'s own `old_owner_ordinal` reverse-lookup pattern).
//! An entity's own id is recovered the same way: this module's own
//! `(path, name_start) -> record_id` index, built from every visible
//! entity record's `span_start_byte` (which -- for THIS pipeline's entity
//! producer, `urdira-jsts-syntax-worker`'s `push_entity` -- is already the
//! NAME identifier's own UTF-16 start, not the whole declaration's span;
//! see `crate::v4::materialize`'s module doc and `lib.rs`'s
//! `SyntaxCollector::push_entity`).

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use sha2::{Digest, Sha256};

use urdira_native_core::StructuralKernelRecordRef;
use urdira_source_frontier::Frontier;
use urdira_structural_store::row::{
    CATEGORY_DIAGNOSTIC, CATEGORY_ENTITY, CATEGORY_RELATION, Dictionaries, NONE_U32, RecordRow,
};
use urdira_structural_store::{PendingSiteKey, SetKind, StoreReader, merkle};
use urdira_tsgo_client::binary;
use urdira_tsgo_client::entity_index::EntityIndex;
use urdira_tsgo_client::residual_pass::{
    DiagnosticResult, InferredTypeResult, ResidualPass, ResidualPassConfig, ResolvedSite,
    SiteOutcome, WindowPlan,
};
use urdira_tsgo_client::resolver::{PendingSite, SiteKind};
use urdira_tsgo_client::virtual_fs::{MapFs, VirtualFs};
use urdira_worker_protocol::{IndexingEvent, ScanPriority, ScanScope, ScanTimings};

use super::analyze::{blob_path, is_jsts_source_path, read_owner_source_text};
use super::delta::identity_key_digest_bytes;
use super::diff;
use super::materialize::{self, OrdinalDict};
use super::publish;
use super::scan::ScanRequest;
use super::timings::ScanClock;
use super::{ScanError, catalog};

/// The Node analyzer's own default window size -- unchanged here, this
/// pass has no reason to diverge from the value already tuned for tsgo
/// project size.
const WINDOW_SIZE: usize = WindowPlan::DEFAULT_WINDOW_SIZE;

/// Fixed, all-lowercase synthetic root every virtual path this pass builds
/// is rooted under -- see `run_once_with_quiet_period`'s own comment on
/// why this is never the real (possibly mixed-case) workspace root.
const VIRTUAL_ROOT: &str = "/urdira-residual-pass";

fn residual_lanes() -> usize {
    let available = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    (available / 2).clamp(1, 6)
}

/// Per-workspace generation epoch, bumped on every [`schedule`] call (i.e.
/// every `ScanCompleted`). See this module's doc comment, "Never two at
/// once, never blocks an edit".
fn epoch_map() -> &'static Mutex<HashMap<String, u64>> {
    static MAP: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn bump_epoch(workspace_id: &str) -> u64 {
    let mut map = epoch_map().lock().expect("residual epoch mutex poisoned");
    let entry = map.entry(workspace_id.to_string()).or_insert(0);
    *entry += 1;
    *entry
}

fn current_epoch(workspace_id: &str) -> u64 {
    epoch_map()
        .lock()
        .expect("residual epoch mutex poisoned")
        .get(workspace_id)
        .copied()
        .unwrap_or(0)
}

/// The seam `main.rs`'s owner needs to add for `UpgradeCompleted` to reach
/// the wire (see this module's doc comment): a channel this background
/// thread sends `(stream_id, cancellation_id, event)` into, drained
/// opportunistically (e.g. `while let Ok(item) = rx.try_recv() { ... }`) at
/// a point in the `'read:` loop that already holds `&mut output` -- the
/// same `stream_id`/`cancellation_id` the triggering `WorkspaceScan`
/// request carried, so the event lands on that request's own logical
/// stream, the same way `Queryable` and `ScanCompleted` already do for one
/// synchronous call.
#[derive(Clone)]
pub struct ResidualEventTarget {
    pub stream_id: u32,
    pub cancellation_id: String,
    pub sender: std::sync::mpsc::Sender<(u32, String, IndexingEvent)>,
}

/// Everything [`schedule`] needs that is not already in a live, in-memory
/// `WorkerState` -- deliberately plain, owned data, because the spawned
/// thread opens its OWN `StoreReader` and SQL connection rather than
/// sharing the caller's (no cross-thread sharing of `v4::state::
/// WorkerState`, which is neither `Send` nor safe to mutate from two
/// threads at once).
#[derive(Clone)]
pub struct ResidualContext {
    pub request_id: String,
    pub workspace_id: String,
    pub workspace_root: String,
    pub database_path: String,
    pub structural_root: String,
    pub cas_root: String,
    pub registry_snapshot_id: String,
    pub configuration_revision_id: String,
    pub resolution_lock_id: String,
    /// F4 4.1: which owner paths this run should build its `VirtualFs`/
    /// window plan around, ON TOP OF every owner that currently has an
    /// open `pending.sites` row (`collect()` always includes those,
    /// unconditionally -- see `run_once_with_quiet_period`'s own doc
    /// comment on `candidate_owners`). `None` for a `Full`/cold scan: the
    /// whole `Frontier` is in scope, exactly as before this task (a fresh
    /// store has no prior generation's owners to narrow against, and a
    /// forced full rescan should re-check everything). `Some(paths)` for a
    /// `Changed` scan: `delta::run`'s own `touched_owner_paths` (edited/
    /// created + deleted owners, already computed for that scan's
    /// external-entity close-protection pass) -- bounds the pass to a
    /// small window instead of paying for every jsts file in the workspace
    /// on every single edit, the dominant cost this task's own plan
    /// diagnosed (`residual_pass.rs::run_lane`'s `fetch_semantics` fetch
    /// runs for every window root regardless of pending sites).
    pub touched_owners: Option<Vec<String>>,
    /// F4 4.2: how many times [`schedule`] has already re-triggered itself
    /// for a truncated (deadline-cut) attempt at the SAME base generation
    /// -- `0` for the run any `ScanCompleted`/test caller starts fresh;
    /// incremented by [`schedule`] each time it re-schedules a follow-up
    /// restricted to `ResidualOutcome::remaining_roots`. Capped at
    /// [`MAX_CONSECUTIVE_RESCHEDULES`] so a workspace whose residual work
    /// never drains within its own budget cannot spawn an unbounded chain
    /// of background tsgo passes -- past the cap, `schedule` stops
    /// re-triggering and leaves the remaining roots' pending sites open for
    /// the NEXT real `ScanCompleted` to pick up fresh (same fallback this
    /// module already relies on for a superseded attempt).
    pub reschedule_count: u32,
}

/// F4 4.2: see [`ResidualContext::reschedule_count`].
const MAX_CONSECUTIVE_RESCHEDULES: u32 = 20;

/// Schedules (or re-schedules, superseding any still-running prior attempt
/// for this workspace) a residual pass after `ScanCompleted` for
/// `context.workspace_id`. Never blocks the caller -- returns immediately
/// after spawning the background thread. `event_target` is `None` in every
/// test/tool caller that has no live stdout stream to address (the pass
/// still runs and still publishes; only the final wire event is skipped).
pub fn schedule(context: ResidualContext, event_target: Option<ResidualEventTarget>) {
    let my_epoch = bump_epoch(&context.workspace_id);
    std::thread::spawn(move || {
        let workspace_id = context.workspace_id.clone();
        match run_once(&context, my_epoch) {
            Ok(Some(outcome)) => {
                eprintln!(
                    "[urdira-indexing-worker] v4 residual pass complete workspace={workspace_id} generation={} upgraded={} external={} unresolved={} inferred_type_entities={} type_of_relations={} diagnostics_emitted={} total_ms={} truncated={} windows={}/{}",
                    outcome.generation,
                    outcome.upgraded_sites,
                    outcome.external_sites,
                    outcome.unresolved_sites,
                    outcome.inferred_type_entities,
                    outcome.type_of_relations,
                    outcome.diagnostics_emitted,
                    outcome.timings.total_ms,
                    outcome.truncated,
                    outcome.windows_done,
                    outcome.windows_total,
                );
                // F4 4.2: send the wire event BEFORE deciding whether to
                // re-schedule -- `event_target` (not `Clone`-free -- see
                // its own struct) is only borrowed here so the SAME sender
                // can still be moved into a follow-up `schedule` call below
                // without this attempt's own caller ever seeing two
                // `UpgradeCompleted` events collapsed into one `Option`.
                if let Some(target) = event_target.as_ref() {
                    let event = IndexingEvent::UpgradeCompleted {
                        request_id: context.request_id.clone(),
                        operation_id: context.request_id.clone(),
                        generation: outcome.generation,
                        upgraded_sites: outcome.upgraded_sites,
                        external_sites: outcome.external_sites,
                        unresolved_sites: outcome.unresolved_sites,
                        timings: outcome.timings,
                    };
                    let _ = target.sender.send((
                        target.stream_id,
                        target.cancellation_id.clone(),
                        event,
                    ));
                }
                // F4 4.2: the deadline cut this run off before it opened
                // every window in its own plan -- re-trigger a follow-up
                // pass restricted to exactly the roots it never got to,
                // same epoch-supersede/quiet-period machinery as any other
                // `schedule` call, up to `MAX_CONSECUTIVE_RESCHEDULES`
                // consecutive attempts. Past the cap, the remaining roots'
                // pending sites simply stay open -- correct, if less
                // timely, the same fallback this module already relies on
                // for a superseded attempt (a future `ScanCompleted` will
                // re-derive and re-schedule fresh).
                if outcome.truncated {
                    if context.reschedule_count < MAX_CONSECUTIVE_RESCHEDULES {
                        if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
                            eprintln!(
                                "[urdira-indexing-worker] v4 residual pass: re-scheduling truncated attempt {} of {} workspace={workspace_id} remaining_owners={}",
                                context.reschedule_count + 1,
                                MAX_CONSECUTIVE_RESCHEDULES,
                                outcome.remaining_roots.len(),
                            );
                        }
                        let mut next_context = context.clone();
                        next_context.touched_owners = Some(outcome.remaining_roots);
                        next_context.reschedule_count += 1;
                        schedule(next_context, event_target);
                    } else {
                        eprintln!(
                            "[urdira-indexing-worker] v4 residual pass: reschedule cap ({MAX_CONSECUTIVE_RESCHEDULES}) reached workspace={workspace_id}; {} owner(s) remain pending for the next scan",
                            outcome.remaining_roots.len(),
                        );
                    }
                }
            }
            Ok(None) => {
                if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
                    eprintln!(
                        "[urdira-indexing-worker] v4 residual pass superseded/no-op workspace={workspace_id}"
                    );
                }
            }
            Err(error) => {
                eprintln!(
                    "[urdira-indexing-worker] v4 residual pass failed workspace={workspace_id}: {error}"
                );
            }
        }
    });
}

/// Outcome of one completed (published or genuinely-empty) residual pass.
pub struct ResidualOutcome {
    pub generation: u64,
    pub upgraded_sites: u64,
    pub external_sites: u64,
    pub unresolved_sites: u64,
    /// Decision 28's "inferred types + compiler diagnostics" task: newly
    /// OPENED (not merely still-live) `jsts:entity_inferred_type` rows this
    /// run.
    pub inferred_type_entities: u64,
    /// Newly opened `jsts:relation_type_of` rows this run.
    pub type_of_relations: u64,
    /// Newly opened `jsts:diagnostic` rows this run.
    pub diagnostics_emitted: u64,
    pub timings: ScanTimings,
    /// F4 4.2: `true` if `URDIRA_V4_RESIDUAL_BUDGET_MS`'s deadline cut this
    /// run off before every window in its own plan was opened. `schedule`
    /// re-triggers a follow-up pass restricted to `remaining_roots` when
    /// this is `true` (capped at `MAX_CONSECUTIVE_RESCHEDULES` consecutive
    /// re-schedules -- see `ResidualContext::reschedule_count`).
    pub truncated: bool,
    /// F4 4.2: store-relative owner paths (the `workspace_root` virtual
    /// prefix already stripped) this run never got to open a window for --
    /// empty unless `truncated` is `true`.
    pub remaining_roots: Vec<String>,
    /// F4 4.2: how many windows this run actually opened, out of the plan's
    /// own total (`windows_total`) -- equal when `truncated` is `false`.
    pub windows_done: usize,
    pub windows_total: usize,
}

/// Runs one residual pass to completion and, if anything upgraded,
/// publishes a `semantic_upgrade` generation. `Ok(None)` means this attempt
/// was superseded (a newer generation landed) before it could safely
/// publish, or there were zero possible sites to begin with -- both are
/// success, not error. Exposed (not module-private) so tests can call it
/// synchronously without going through [`schedule`]'s background thread
/// (`quiet_period` lets a test skip the real 1.5s sleep).
pub fn run_once(
    context: &ResidualContext,
    my_epoch: u64,
) -> Result<Option<ResidualOutcome>, ScanError> {
    run_once_with_quiet_period(context, my_epoch, std::time::Duration::from_millis(1500))
}

fn run_once_with_quiet_period(
    context: &ResidualContext,
    my_epoch: u64,
    quiet_period: std::time::Duration,
) -> Result<Option<ResidualOutcome>, ScanError> {
    // Small, fixed quiet period: let an immediately-following foreground
    // edit (the common "cold scan, then the editor's own first save"
    // sequence -- see `main.rs`'s `schedule_lexical_reconcile` for the
    // identical rationale) land and supersede this attempt cheaply, before
    // this pass pays for opening a `StoreReader`/spawning tsgo children at
    // all.
    std::thread::sleep(quiet_period);
    if current_epoch(&context.workspace_id) != my_epoch {
        return Ok(None);
    }

    let structural_root = Path::new(&context.structural_root);
    let cas_root = Path::new(&context.cas_root);
    let store = StoreReader::open(structural_root)?;
    let base_generation = store.generation();
    let dicts = store.dictionaries();

    let conn = catalog::open_and_ensure_schema(Path::new(&context.database_path))?;
    let frontier = Frontier::load(&conn, &context.workspace_id)?;
    drop(conn);

    let mut path_by_pair: HashMap<(String, String), String> = HashMap::new();
    for (path, entry) in &frontier.present {
        path_by_pair.insert(
            (entry.artifact_id.clone(), entry.artifact_version_id.clone()),
            path.clone(),
        );
    }
    let owner_path = |ordinal: u32| -> Option<String> {
        dicts
            .artifacts
            .get(ordinal as usize)
            .and_then(|pair| path_by_pair.get(pair))
            .cloned()
    };

    // F4 4.3: `URDIRA_V4_ENTITY_INDEX=scan` opts back into the pre-4.3 full
    // `iter_visible` scan, purely to compare against the default `entities.
    // index` section path (see `EntityLookup`'s own doc comment) -- read
    // ONCE here, not inside `collect` itself, so a test can exercise both
    // strategies directly without needing `std::env::set_var` (forbidden:
    // this crate is `#![forbid(unsafe_code)]`).
    let force_entity_scan = std::env::var_os("URDIRA_V4_ENTITY_INDEX")
        .is_some_and(|v| v == std::ffi::OsStr::new("scan"));
    let collected = collect(
        &store,
        &dicts,
        &owner_path,
        &frontier,
        base_generation,
        force_entity_scan,
    );
    // F4 4.1: no more global early-return on "zero pending sites" -- decision
    // 28's inferred-types/diagnostics half of this pass (below) has always
    // been able to produce work (a newly-exported declaration needing a
    // type, a fresh compiler diagnostic) independent of whether ANY
    // call/heritage site is still pending, so gating the entire pass on
    // `pending_by_owner` silently starved that half whenever a corpus (or a
    // fixture) happened to have zero outstanding possible sites. `has_sites`
    // is kept only for the debug log below -- every downstream step already
    // tolerates an empty `pending_by_owner` (`run_lane`'s `pending_by_owner.
    // get(root)` is a plain `Option`, and the inferred-types/diagnostics
    // loop near the end of this function does not consult it at all).
    let has_sites = !collected.pending_by_owner.is_empty();
    if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
        eprintln!(
            "[urdira-indexing-worker] v4 residual: has_sites={has_sites} touched_owners={:?}",
            context.touched_owners,
        );
    }

    let binary = discover_binary(&context.workspace_root).map_err(|error| {
        ScanError(format!(
            "v4 residual: tsgo binary discovery failed: {error}"
        ))
    })?;
    let lib_root = binary
        .path
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .ok_or_else(|| ScanError("v4 residual: tsgo binary has no parent directory".into()))?;

    // Build the virtual FS: every current jsts source file's hash-verified
    // text, keyed under a FIXED, all-lowercase synthetic root (never the
    // real, possibly mixed-case workspace path). tsgo reports
    // `useCaseSensitiveFileNames: false` on this repo's case-insensitive
    // host (confirmed live, `docs/evidence/2026-09-03-v4-p1d-a-tsgo-
    // client.md` §8) and canonicalizes absolute paths in its OWN responses
    // (a resolved declaration's path, a project's own `configFileName`) to
    // lowercase -- a mixed-case real workspace root (e.g. `/Users/...`)
    // made `residual_pass.rs::run_lane`'s exact-string `configFileName`
    // match fail outright (confirmed live while writing this pass's own
    // test: "tsgo did not open a project for window 0"). A fixed lowercase
    // root sidesteps that entirely for the root itself. **Known residual
    // gap, not fixed here**: an individual FILE path with mixed-case
    // characters (real corpora have some, e.g. `McpClient.node.test.ts`
    // per the P2-2i evidence doc) could suffer the same silent-lowercase
    // mismatch when correlating a resolved `WorkspaceTarget.path` back to
    // this pass's own maps -- see this task's evidence doc for the exact
    // scope of this gap and why it was not fixed this session.
    // F4 4.1: the exact set of owner paths this run's `VirtualFs`/window
    // plan is scoped to -- `None` (cold, or an explicit forced full rescan)
    // means "every jsts owner in the frontier", the same as before this
    // task. `Some(...)` unions `context.touched_owners` (the owners THIS
    // scan's own batch touched) with every owner that currently has an
    // open pending site (`collected.pending_by_owner`'s keys) -- a pending
    // call/heritage site must stay reachable across passes until it
    // resolves even if its owner was not part of the batch that triggered
    // this particular run.
    let candidate_owners: Option<std::collections::BTreeSet<String>> =
        context.touched_owners.as_ref().map(|touched| {
            let mut set: std::collections::BTreeSet<String> = touched.iter().cloned().collect();
            set.extend(collected.pending_by_owner.keys().cloned());
            set
        });

    let workspace_root = VIRTUAL_ROOT.to_string();
    let mut file_map: BTreeMap<String, String> = BTreeMap::new();
    for (path, entry) in &frontier.present {
        if !is_jsts_source_path(path) {
            continue;
        }
        if let Some(owners) = &candidate_owners
            && !owners.contains(path)
        {
            continue;
        }
        let source_input = urdira_jsts_syntax_worker::SourceInput {
            path: path.clone(),
            artifact_id: entry.artifact_id.clone(),
            artifact_version_id: entry.artifact_version_id.clone(),
            content_digest: entry.content_hash.clone(),
            source_blob_path: blob_path(cas_root, &entry.content_hash)?,
            byte_length: usize::try_from(entry.byte_length).unwrap_or(usize::MAX),
        };
        if let Ok(text) = read_owner_source_text(&source_input) {
            file_map.insert(format!("{workspace_root}/{path}"), text);
        }
    }
    if file_map.is_empty() {
        return Ok(None);
    }

    let mut clock = ScanClock::start();
    let resolve_started = std::time::Instant::now();

    let fs: Arc<dyn VirtualFs> = Arc::new(MapFs::from_entries(
        file_map.iter().map(|(k, v)| (k.clone(), v.clone())),
    ));
    let mut sorted_roots: Vec<String> = file_map.keys().cloned().collect();
    sorted_roots.sort();
    let plan = WindowPlan::build(&sorted_roots, WINDOW_SIZE);

    // Re-key `pending_by_owner` under the same absolute virtual paths the
    // window plan/VirtualFs use.
    let mut pending_by_owner: BTreeMap<String, Vec<PendingSite>> = BTreeMap::new();
    for (path, sites) in &collected.pending_by_owner {
        let virtual_path = format!("{workspace_root}/{path}");
        let sites = sites
            .iter()
            .cloned()
            .map(|mut site| {
                site.owner_path = virtual_path.clone();
                site
            })
            .collect();
        pending_by_owner.insert(virtual_path, sites);
    }

    // F4 4.2: `URDIRA_V4_RESIDUAL_BUDGET_MS` bounds how long this ONE
    // `ResidualPass::run_instrumented` call may keep opening new windows --
    // default 20s for an incremental run (`context.touched_owners` is
    // `Some(...)`, a small window already), 120s for a cold run (`None`,
    // the whole frontier); `0` means unbounded (`deadline: None`), matching
    // the pre-4.2 behavior exactly. An explicit env value applies to BOTH
    // shapes of run -- there is deliberately no separate incremental/cold
    // override, since a caller setting this at all almost certainly wants
    // one number for both (a bench, or a deployment capping worst-case
    // latency regardless of trigger).
    const DEFAULT_INCREMENTAL_BUDGET_MS: u64 = 20_000;
    const DEFAULT_COLD_BUDGET_MS: u64 = 120_000;
    let default_budget_ms = if context.touched_owners.is_none() {
        DEFAULT_COLD_BUDGET_MS
    } else {
        DEFAULT_INCREMENTAL_BUDGET_MS
    };
    let budget_ms = std::env::var("URDIRA_V4_RESIDUAL_BUDGET_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default_budget_ms);
    let deadline = (budget_ms > 0)
        .then(|| std::time::Instant::now() + std::time::Duration::from_millis(budget_ms));

    let config = ResidualPassConfig {
        binary,
        root: workspace_root.clone(),
        project_config_path: format!("{workspace_root}/__urdira_residual_pass__.json"),
        compiler_options: serde_json::json!({
            "module": "ESNext",
            "moduleResolution": "Bundler",
            "target": "ES2022",
            "skipLibCheck": true,
            // P1-D-f: `analyzer.ts`'s own v3 checker always merges in
            // `{allowJs: true, checkJs: true}` whenever the project has ANY
            // JavaScript file (`hasJavaScript`, `analyzer.ts:413`/`717`/
            // `2161`/`2204`) -- unconditionally, not behind a per-project
            // discovery step. This pass had no such default at all: without
            // `allowJs`, tsgo's checker may refuse to fully type-check a
            // `.js`/`.mjs` owner file's own symbols (a real config gap vs.
            // v3, not merely a style choice), and `checkJs` is required for
            // the checker to resolve identifiers *inside* a plain JS file's
            // own body the same way v3 does. Always-on rather than
            // conditional on "does this corpus have JS files": harmless for
            // an all-TypeScript corpus (these two options are no-ops for
            // `.ts`/`.tsx` sources) and this pass has no cheap way to probe
            // "does any owner in this run's `pending_by_owner` end in .js"
            // before building the one shared `ResidualPassConfig`.
            "allowJs": true,
            "checkJs": true,
        }),
        lib_roots: vec![lib_root],
        // Decision 28's "inferred types + compiler diagnostics" task: fetch
        // `crate::semantic_extras` output for every window root, on the
        // SAME snapshot/window this call already opens for call/heritage
        // resolution -- see `ResidualPassConfig::fetch_semantics`'s own doc
        // comment.
        fetch_semantics: true,
        deadline,
    };

    let (resolved, pass_stats) =
        ResidualPass::run_instrumented(&plan, residual_lanes(), &pending_by_owner, fs, &config)
            .map_err(|error| ScanError(format!("v4 residual: checker pass failed: {error}")))?;
    clock.record_resolve(resolve_started.elapsed());
    let debug_enabled = std::env::var_os("URDIRA_V4_RESIDUAL_DEBUG").is_some();
    let site_dump_path = std::env::var("URDIRA_V4_RESIDUAL_SITE_DUMP").ok();
    let mut debug = (debug_enabled || site_dump_path.is_some())
        .then(|| ResidualDebug::new(site_dump_path.as_deref()));
    if let Some(debug) = debug.as_mut() {
        debug.record_pass(&resolved, &file_map);
    }
    if debug_enabled {
        print_diagnostic_code_histogram(&pass_stats.diagnostics);
    }

    // F4 4.2: `pass_stats.remaining_roots` is in `run_lane`'s own virtual-
    // path form (`{workspace_root}/{store_path}`) -- convert back to
    // store-relative paths here, the same shape `ResidualContext::
    // touched_owners` expects, so `schedule` can hand them straight to a
    // follow-up `ResidualContext` without this module's caller needing to
    // know about the virtual root at all.
    let windows_done = pass_stats.windows.len();
    let windows_total = pass_stats.windows_total;
    let truncated = pass_stats.truncated;
    let remaining_owner_paths: Vec<String> = pass_stats
        .remaining_roots
        .iter()
        .filter_map(|virtual_path| {
            virtual_path
                .strip_prefix(&workspace_root)
                .map(|p| p.trim_start_matches('/').to_string())
        })
        .collect();
    if truncated && std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
        eprintln!(
            "[urdira-indexing-worker] v4 residual: deadline hit, windows_done={windows_done}/{windows_total} remaining_owners={}",
            remaining_owner_paths.len(),
        );
    }

    if current_epoch(&context.workspace_id) != my_epoch {
        return Ok(None);
    }

    // Re-open a fresh `StoreReader` right before building the upgrade
    // batch: a concurrent edit's own delta could have landed while the
    // checker pass (potentially minutes on a large corpus) ran.
    let store = StoreReader::open(structural_root)?;
    let publish_generation = store.generation();
    if publish_generation != base_generation {
        // Something else already published; this pass's own site
        // collection may now be stale (a possible row it targeted could
        // already be closed, migrated, or gone). Discard rather than risk
        // acting on a record that is no longer the live occurrence.
        return Ok(None);
    }

    let materialize_started = std::time::Instant::now();
    let mut upgraded = 0u64;
    let mut external = 0u64;
    let mut unresolved = 0u64;
    let mut opened_records: Vec<RecordRow> = Vec::new();
    let mut record_closures: Vec<([u8; 32], u32)> = Vec::new();
    let mut closed_relation_keys: Vec<[u8; 32]> = Vec::new();

    let new_generation = publish_generation + 1;
    let new_generation_u32 = u32::try_from(new_generation)
        .map_err(|_| ScanError("v4 residual: generation exceeds u32".into()))?;

    let mut names_dict = OrdinalDict::from_existing(&dicts.names);
    let mut subjects_dict = OrdinalDict::from_existing(&dicts.subjects);
    let mut kinds_dict = OrdinalDict::from_existing(&dicts.kinds);
    let mut universal_kinds_dict = OrdinalDict::from_existing(&dicts.universal_kinds);
    let mut relation_kinds_dict = OrdinalDict::from_existing(&dicts.relation_kinds);

    // P1-D-d root-cause fix (see the evidence doc + `ResidualDebug`'s own
    // doc comment on `entity_index_miss`): tsgo's `useCaseSensitiveFileNames:
    // false` behavior lowercases every absolute path in a declaration
    // handle, including a virtual workspace file -- `real_path_by_lower`
    // recovers the correctly-cased frontier path for `frontier.present`/
    // `file_map` lookups keyed on it (`EntityIndex::lookup`'s own
    // case-insensitive fallback already handles the miss for an EXISTING
    // entity; this map is additionally needed wherever this loop itself
    // needs the real path, not just a successful lookup).
    let mut real_path_by_lower: HashMap<String, String> = HashMap::new();
    for path in frontier.present.keys() {
        real_path_by_lower.insert(path.to_ascii_lowercase(), path.clone());
    }
    let mut artifact_ordinal_by_pair: HashMap<(String, String), u32> = HashMap::new();
    for (ordinal, pair) in dicts.artifacts.iter().enumerate() {
        artifact_ordinal_by_pair.insert(pair.clone(), ordinal as u32);
    }
    // Dominant root cause (see evidence doc): v4's lane-1 entity producer
    // (`urdira-jsts-syntax-worker::SyntaxCollector::push_entity`) only ever
    // materializes MODULE-LEVEL entities -- a class/interface's own
    // members (methods, constructors, ...) are never independently
    // queryable entities, so `collected.entities` (built the same way)
    // has no entry for one even when tsgo correctly resolves a call to
    // one. Rather than widen the whole v4 entity schema (real, separate
    // scope -- see the evidence doc), this pass synthesizes the missing
    // member entity itself, once per distinct `(path, name_start)`, as
    // part of the SAME `semantic_upgrade` generation that needs it.
    // Cached here so 1,000 call sites targeting the same popular method
    // (e.g. `this.repository.save(...)`) produce exactly one new entity
    // record, not 1,000 duplicates.
    let mut synthesized_member_entities: HashMap<(String, i32), [u8; 32]> = HashMap::new();
    // A4 (line numbers task, 2026-09-05): one `LineIndex` per owner path,
    // built lazily on first use and shared by every row this run
    // synthesizes -- see `owner_line_index`'s own doc comment.
    let mut line_index_cache: HashMap<String, urdira_jsts_syntax_worker::LineIndex> =
        HashMap::new();
    // A2 (pending.sites migration): closures for the `pending.sites` side
    // table -- one entry per site this pass actually upgrades (see the
    // `SiteOutcome::WorkspaceTarget` arm below). `External`/`Unresolved`
    // outcomes never close a pending site: the site's own status has not
    // changed (still genuinely pending), so it stays open for a future
    // pass/edit to reconsider.
    let mut pending_closures: Vec<(urdira_structural_store::PendingSiteKey, u32)> = Vec::new();
    // The bit `FACET_ORDER` (`materialize.rs`) assigns `"core:indirect"` --
    // computed once, the SAME way `dump_call_bodies` locates it (see that
    // function's own doc comment). `dicts` (loaded before the checker pass
    // ran) is safe to reuse here: `facet_names` reports the SAME full list
    // every generation once written, so it cannot have drifted across the
    // fresh `StoreReader::open` just above.
    let indirect_bit = dicts
        .facet_names
        .iter()
        .position(|name| name == "core:indirect")
        .expect("FACET_ORDER (materialize.rs) always registers core:indirect");

    for site in &resolved {
        let Some(store_path) = site.owner_path.strip_prefix(&workspace_root) else {
            continue;
        };
        let store_path = store_path.trim_start_matches('/').to_string();
        let key = correlation_key(
            &store_path,
            site.start_utf16,
            site.end_utf16,
            site.site_kind,
        );
        let Some(meta) = collected.by_site.get(&key) else {
            continue;
        };
        // Re-verify this exact pending site is still open before touching
        // it (see the fresh-`StoreReader` re-open above): `None` means it
        // was already closed by some other means since collection (a
        // concurrent edit, or a previous iteration of this very loop for
        // the SAME key -- `resolved` can in principle repeat a key if the
        // checker pass itself ever did, though it should not).
        if store
            .pending_site(&meta.pending_key, publish_generation)
            .is_none()
        {
            continue;
        }

        match &site.outcome {
            SiteOutcome::WorkspaceTarget {
                path: target_path,
                name_start_utf16,
                kind_hint,
                decl_start,
                decl_end,
            } => {
                let target_store_path = target_path
                    .strip_prefix(&workspace_root)
                    .map(|p| p.trim_start_matches('/').to_string());
                let existing_target_record_id =
                    target_store_path.as_deref().and_then(|target_store_path| {
                        collected
                            .entities
                            .lookup(target_store_path, *name_start_utf16)
                    });
                // `(record_id, identity_key text)` for the target, from
                // whichever of the two sources actually has it -- an
                // EXISTING store entity (the common case: a top-level
                // function/class/variable/enum/type/interface, or an
                // entity a PRIOR residual pass already synthesized) or a
                // freshly-synthesized member entity (see
                // `try_synthesize_member_entity`'s own doc comment). The
                // synthesized case never calls `store.get_visible` for its
                // OWN record: it is not live at `publish_generation` yet
                // (it is only `valid_from` THIS pass's own new
                // generation) -- its identity is already known directly
                // from the record it just built.
                let target_info: Option<([u8; 32], String)> = match existing_target_record_id {
                    Some(id) => store.get_visible(&id, publish_generation).map(|view| {
                        (
                            id,
                            String::from_utf8_lossy(&view.identity_key()).into_owned(),
                        )
                    }),
                    None => try_synthesize_member_entity(
                        target_store_path.as_deref(),
                        *name_start_utf16,
                        *decl_start,
                        *decl_end,
                        *kind_hint,
                        &real_path_by_lower,
                        &frontier,
                        &artifact_ordinal_by_pair,
                        &file_map,
                        &workspace_root,
                        &store,
                        publish_generation,
                        new_generation_u32,
                        &mut synthesized_member_entities,
                        &mut line_index_cache,
                        &mut opened_records,
                        &mut kinds_dict,
                        &mut universal_kinds_dict,
                        &mut names_dict,
                    ),
                };
                let dangling = existing_target_record_id.is_some() && target_info.is_none();
                let Some((target_record_id, target_id)) = target_info else {
                    unresolved += 1;
                    if let Some(debug) = debug.as_mut() {
                        if dangling {
                            debug.record_bucket("entity_index_dangling");
                        } else {
                            debug.record_entity_index_miss(
                                &store_path,
                                site.start_utf16,
                                site.end_utf16,
                                target_store_path.as_deref().unwrap_or("<no-prefix>"),
                                *name_start_utf16,
                                *kind_hint,
                            );
                        }
                    }
                    continue;
                };

                let confirmed = build_confirmed_row(
                    &store_path,
                    site.start_utf16,
                    site.end_utf16,
                    &meta.source_id,
                    &target_id,
                    meta.relation_kind,
                    &target_record_id,
                    meta.owner_artifact,
                    meta.owner_version,
                    Some(meta.source_subject),
                    &store,
                    publish_generation,
                    new_generation_u32,
                    &file_map,
                    &workspace_root,
                    &mut line_index_cache,
                    &mut kinds_dict,
                    &mut universal_kinds_dict,
                    &mut relation_kinds_dict,
                    &mut names_dict,
                    &mut subjects_dict,
                )?;
                match confirmed {
                    Some(confirmed) => {
                        pending_closures.push((meta.pending_key, new_generation_u32));
                        // A2: ALSO close every live candidate row (P2-2j,
                        // `candidate_call_record` -- `classification:
                        // "possible"` but a REAL `target_id`, carrying the
                        // `core:indirect` facet) at this exact span: this
                        // pass just independently confirmed a single real
                        // workspace target for the site, which supersedes
                        // whatever candidates existed for it (an overload/
                        // union receiver's per-candidate guesses are no
                        // longer the best evidence once the checker itself
                        // has spoken). `by_owner` -> filter by span is a
                        // small per-owner scan (this owner's own record
                        // count, not the whole corpus).
                        for candidate in store.by_owner(meta.owner_artifact, publish_generation) {
                            if candidate.category() == CATEGORY_RELATION
                                && candidate.span_start_byte() == site.start_utf16 as u32
                                && candidate.span_end_byte() == site.end_utf16 as u32
                                && (candidate.facets() & (1u64 << indirect_bit)) != 0
                            {
                                record_closures.push((candidate.record_id(), new_generation_u32));
                                closed_relation_keys.push(candidate.record_id());
                            }
                        }
                        opened_records.push(confirmed);
                        upgraded += 1;
                        if let Some(debug) = debug.as_mut() {
                            debug.record_bucket("upgraded");
                        }
                    }
                    None => {
                        unresolved += 1;
                        if let Some(debug) = debug.as_mut() {
                            debug.record_bucket("confirmed_row_build_failed");
                        }
                    }
                }
            }
            SiteOutcome::External { .. } => {
                // A2: nothing to repair any more -- the site's own no-
                // target relation record was already dropped at
                // materialize time (`plan_relation_repair`), so there is no
                // classification-mismatched row left to rewrite. The
                // pending site stays open (see this loop's own doc comment
                // on `pending_closures`).
                external += 1;
            }
            SiteOutcome::Unresolved { .. } => {
                unresolved += 1;
            }
        }
    }

    // Decision 28's "inferred types + compiler diagnostics" task: within
    // the SAME residual pass run, for every owner `pass_stats.types`/
    // `pass_stats.diagnostics` produced data for, (a) emit `jsts:
    // entity_inferred_type` + `jsts:relation_type_of` for every typed
    // declaration and (b) `jsts:diagnostic` for every compiler diagnostic,
    // then (c) close every PREVIOUSLY live row of these three kinds for
    // that owner whose identity is not among what was just (re)computed --
    // these three kinds only ever exist inside an upgrade generation (never
    // touched by `diff_owner`'s ordinary identity diff, which only runs for
    // stage-1/2 kinds an edit-scan regenerates), so this pass is the only
    // place that can ever close a stale one.
    let mut inferred_type_entities = 0u64;
    let mut type_of_relations = 0u64;
    let mut diagnostics_emitted = 0u64;
    {
        let mut types_by_owner: BTreeMap<&str, Vec<&InferredTypeResult>> = BTreeMap::new();
        for typed in &pass_stats.types {
            types_by_owner
                .entry(typed.owner_path.as_str())
                .or_default()
                .push(typed);
        }
        let mut diagnostics_by_owner: BTreeMap<&str, Vec<&DiagnosticResult>> = BTreeMap::new();
        for diagnostic in &pass_stats.diagnostics {
            diagnostics_by_owner
                .entry(diagnostic.owner_path.as_str())
                .or_default()
                .push(diagnostic);
        }
        let mut touched_owners: std::collections::BTreeSet<&str> =
            types_by_owner.keys().copied().collect();
        touched_owners.extend(diagnostics_by_owner.keys().copied());

        for virtual_owner in touched_owners {
            let Some(stripped) = virtual_owner.strip_prefix(&workspace_root) else {
                continue;
            };
            let store_path = stripped.trim_start_matches('/');
            let real_path = if frontier.present.contains_key(store_path) {
                store_path.to_string()
            } else if let Some(real) = real_path_by_lower.get(&store_path.to_ascii_lowercase()) {
                real.clone()
            } else {
                continue;
            };
            let Some(entry) = frontier.present.get(&real_path) else {
                continue;
            };
            let Some(&owner_artifact) = artifact_ordinal_by_pair
                .get(&(entry.artifact_id.clone(), entry.artifact_version_id.clone()))
            else {
                continue;
            };
            let owner_version = owner_artifact; // matches try_synthesize_member_entity's own convention.

            let mut new_identities: std::collections::HashSet<String> =
                std::collections::HashSet::new();

            for typed in types_by_owner.get(virtual_owner).into_iter().flatten() {
                let site = &typed.site;
                let existing_record_id =
                    collected.entities.lookup(&real_path, site.name_start_utf16);
                let entity_info: Option<([u8; 32], String)> = match existing_record_id {
                    Some(id) => store.get_visible(&id, publish_generation).map(|view| {
                        (
                            id,
                            String::from_utf8_lossy(&view.identity_key()).into_owned(),
                        )
                    }),
                    None => try_synthesize_member_entity(
                        Some(&real_path),
                        site.name_start_utf16,
                        site.decl_start,
                        site.decl_end,
                        site.decl_kind,
                        &real_path_by_lower,
                        &frontier,
                        &artifact_ordinal_by_pair,
                        &file_map,
                        &workspace_root,
                        &store,
                        publish_generation,
                        new_generation_u32,
                        &mut synthesized_member_entities,
                        &mut line_index_cache,
                        &mut opened_records,
                        &mut kinds_dict,
                        &mut universal_kinds_dict,
                        &mut names_dict,
                    ),
                };
                let Some((entity_record_id, entity_id)) = entity_info else {
                    continue;
                };

                let Some(result) = build_inferred_type_rows(
                    &entity_id,
                    &entity_record_id,
                    &site.display_name,
                    &site.type_text,
                    &real_path,
                    site.decl_start,
                    site.decl_end,
                    owner_artifact,
                    owner_version,
                    &store,
                    publish_generation,
                    new_generation_u32,
                    &file_map,
                    &workspace_root,
                    &mut line_index_cache,
                    &mut kinds_dict,
                    &mut universal_kinds_dict,
                    &mut relation_kinds_dict,
                    &mut names_dict,
                    &mut subjects_dict,
                )?
                else {
                    continue;
                };
                new_identities.insert(result.entity_identity.clone());
                new_identities.insert(result.relation_identity.clone());
                if let Some(row) = result.entity_row {
                    opened_records.push(row);
                    inferred_type_entities += 1;
                }
                if let Some(row) = result.relation_row {
                    opened_records.push(row);
                    type_of_relations += 1;
                }
            }

            for (index, diagnostic) in diagnostics_by_owner
                .get(virtual_owner)
                .into_iter()
                .flatten()
                .enumerate()
            {
                let site = &diagnostic.site;
                let Some((identity_key, row)) = build_diagnostic_row(
                    &real_path,
                    site.start,
                    site.end,
                    site.compiler_code,
                    &site.message,
                    index,
                    owner_artifact,
                    owner_version,
                    &store,
                    publish_generation,
                    new_generation_u32,
                    &file_map,
                    &workspace_root,
                    &mut line_index_cache,
                    &mut kinds_dict,
                    &mut universal_kinds_dict,
                    &mut names_dict,
                )?
                else {
                    continue;
                };
                new_identities.insert(identity_key);
                if let Some(row) = row {
                    opened_records.push(row);
                    diagnostics_emitted += 1;
                }
            }

            // Close every previously-live row of these three kinds for this
            // owner whose identity is not among what this run just
            // (re)computed -- an edit that removes an export, changes its
            // type, or fixes a type error must not leave the old row
            // visible forever (the task's own "never accumulate"
            // requirement; see `n8n_residual_pass_repeat_run_has_no_duplicate_
            // type_of` / the edit-then-reupgrade test in this file's own
            // test module).
            for candidate in store.by_owner(owner_artifact, publish_generation) {
                if candidate.category() != CATEGORY_ENTITY
                    && candidate.category() != CATEGORY_RELATION
                    && candidate.category() != CATEGORY_DIAGNOSTIC
                {
                    continue;
                }
                let Some(kind) = dicts.kinds.get(candidate.kind_id() as usize) else {
                    continue;
                };
                if kind != "jsts:entity_inferred_type"
                    && kind != "jsts:relation_type_of"
                    && kind != "jsts:diagnostic"
                {
                    continue;
                }
                let identity = String::from_utf8_lossy(&candidate.identity_key()).into_owned();
                if new_identities.contains(&identity) {
                    continue;
                }
                record_closures.push((candidate.record_id(), new_generation_u32));
                if candidate.category() == CATEGORY_RELATION {
                    closed_relation_keys.push(candidate.record_id());
                }
            }
        }
    }

    clock.record_materialize(materialize_started.elapsed());
    if debug_enabled && let Some(debug) = debug.as_ref() {
        debug.print();
    }
    if debug_enabled {
        // P1-D-g deliverable 1: the store-wide invariant, printed for every
        // production run that opts into `URDIRA_V4_RESIDUAL_DEBUG` (not
        // test-only tooling) -- how many rows THIS generation still leaves
        // classification-inconsistent after this pass's own repair step
        // (`repair_mismatched_row_if_needed`) had its chance to close them.
        let mismatches = count_classification_mismatches(&store, &dicts, publish_generation);
        eprintln!(
            "[urdira-indexing-worker] v4 residual debug: classification_mismatches_remaining={mismatches}"
        );
    }

    // Decision 28's "inferred types + compiler diagnostics" task can close
    // stale rows for an owner (an export/type/diagnostic that disappeared)
    // WITHOUT opening any new row for that same owner this run -- unlike
    // the pre-existing call/heritage path, where `record_closures` was
    // always pushed in the same branch as an `opened_records` push. Guard
    // on all three vectors, not just `opened_records`, so a run that only
    // closes stale rows still publishes.
    if opened_records.is_empty() && record_closures.is_empty() && pending_closures.is_empty() {
        return Ok(Some(ResidualOutcome {
            generation: publish_generation,
            upgraded_sites: 0,
            external_sites: external,
            unresolved_sites: unresolved,
            inferred_type_entities: 0,
            type_of_relations: 0,
            diagnostics_emitted: 0,
            timings: clock.completed_timings(),
            truncated,
            remaining_roots: remaining_owner_paths,
            windows_done,
            windows_total,
        }));
    }

    if current_epoch(&context.workspace_id) != my_epoch {
        return Ok(None);
    }

    let write_started = std::time::Instant::now();
    let mut new_dicts = dicts.clone();
    new_dicts.names = names_dict.into_values();
    new_dicts.subjects = subjects_dict.into_values();
    // A2 (pending.sites migration) bug fix: `kinds_dict`/`universal_kinds_
    // dict`/`relation_kinds_dict` are seeded from `dicts` (`OrdinalDict::
    // from_existing`, above) and `build_confirmed_row` interns into them on
    // every upgrade, exactly like `names_dict`/`subjects_dict` -- but their
    // interned values were never written back into `new_dicts` before this
    // fix, so a kind/universal_kind/relation_kind string that this pass
    // interns FOR THE FIRST TIME (a fresh ordinal, not already present in
    // the base store) never made it into `dict_additions` at all: the
    // delta segment's `dict.bin` never carried that ordinal's text, so a
    // reader's `dicts.kinds[ordinal]`/`dicts.universal_kinds[ordinal]`
    // lookup silently returned nothing (an out-of-bounds/empty string) for
    // every record using it -- confirmed live: `tests/v4-daemon-e2e.test.ts`'s
    // residual-pass test found a freshly-confirmed `core:implements` row
    // with `kind: ""` and `universal_kind: ""` in its query-engine
    // projection (right `classification`/`source_id`/`target_id`, empty
    // kind text), making it invisible to any `kind === "jsts:relation_
    // implements"` filter. This bug was DORMANT before A2: `possible_call_
    // record`/`possible_heritage_record` used to materialize a REAL record
    // for every no-target site at COLD-SCAN time, which always interned
    // `"jsts:relation_call"`/`"jsts:relation_inherits"`/`"jsts:relation_
    // implements"` into the base `dicts.kinds` regardless of whether
    // anything ever confirmed -- so `kinds_dict.intern(...)` here always
    // hit an EXISTING ordinal and this gap never mattered. Once no-target
    // sites stopped being records at all, a fixture/corpus with zero
    // COLD-confirmed calls/heritage of a given kind (this task-planner
    // fixture has none) hits this for the first time on residual's first
    // ever upgrade of that kind.
    new_dicts.kinds = kinds_dict.into_values();
    new_dicts.universal_kinds = universal_kinds_dict.into_values();
    new_dicts.relation_kinds = relation_kinds_dict.into_values();
    new_dicts.subject_text = new_dicts
        .subjects
        .iter()
        .map(|key| format!("record:{}", materialize::hex_encode(key)))
        .collect();
    let dict_additions = new_dicts.suffix_from(&dicts);

    let mut conn = catalog::open_and_ensure_schema(Path::new(&context.database_path))?;
    conn.execute_batch("PRAGMA busy_timeout=30000;")?;

    let writer = urdira_structural_store::writer::SegmentWriter::new();
    let summary = writer
        .write_delta_with_reader_and_pending(
            structural_root,
            &store,
            &opened_records,
            &record_closures,
            &[],
            &[],
            &dict_additions,
            new_generation,
            // A2 (pending.sites migration): this pass never OPENS a new
            // pending site (it only ever closes one, on a successful
            // upgrade -- see `pending_closures`, built in the materialize
            // loop above); `&[]` is exactly right here, not a placeholder.
            &[],
            &pending_closures,
        )
        .map_err(|error| ScanError(format!("v4 residual: write_delta failed: {error}")))?;
    clock.record_write(write_started.elapsed());

    let graph_changes = diff::graph_changes(&opened_records, &closed_relation_keys);
    let merkle_dir = structural_root.join("merkle");
    let graph_root = if graph_changes.is_empty() {
        merkle::read_root(&merkle_dir, SetKind::Graph)
            .map_err(|error| ScanError(format!("v4 residual: graph root read failed: {error}")))?
    } else {
        let graph_changes_by_bucket = diff::group_changes_by_bucket(&graph_changes);
        let empty: &[urdira_indexing_core::merkle_bucket::Change] = &[];
        let bucket_entries = |idx: u32| {
            diff::graph_bucket_entries(
                &store,
                idx,
                publish_generation,
                graph_changes_by_bucket
                    .get(&idx)
                    .map(Vec::as_slice)
                    .unwrap_or(empty),
            )
        };
        let (graph_set, touched) =
            merkle::load_and_update(&merkle_dir, SetKind::Graph, &graph_changes, bucket_entries)
                .map_err(|error| ScanError(format!("v4 residual: graph update failed: {error}")))?;
        let root = graph_set.root();
        merkle::persist_slots(
            &graph_set,
            &touched,
            &merkle_dir,
            SetKind::Graph,
            new_generation,
        )
        .map_err(|error| ScanError(format!("v4 residual: graph persist failed: {error}")))?;
        root
    };
    let metric_root = merkle::read_root(&merkle_dir, SetKind::Metric).unwrap_or([0u8; 32]);

    let graph_opened_count = opened_records
        .iter()
        .filter(|row| row.category == CATEGORY_RELATION)
        .count();
    let graph_closed_count = closed_relation_keys.len();
    let opened_records_count = opened_records.len();

    let request = ScanRequest {
        request_id: context.request_id.clone(),
        workspace_id: context.workspace_id.clone(),
        workspace_root: context.workspace_root.clone(),
        database_path: context.database_path.clone(),
        structural_root: context.structural_root.clone(),
        cas_root: context.cas_root.clone(),
        sidecar_root: String::new(),
        scope: ScanScope::Full,
        registry_snapshot_id: context.registry_snapshot_id.clone(),
        configuration_revision_id: context.configuration_revision_id.clone(),
        resolution_lock_id: context.resolution_lock_id.clone(),
        deadline_ms: None,
        priority: ScanPriority::Background,
    };

    let snapshot_started = std::time::Instant::now();
    let source_state_digest =
        read_source_state_digest(&conn, &context.workspace_id, publish_generation)?;
    let _result = publish::publish_delta_with_kind(
        &mut conn,
        &request,
        i64::try_from(new_generation).map_err(|_| ScanError("generation overflow".into()))?,
        &source_state_digest,
        &summary,
        graph_root,
        metric_root,
        opened_records_count,
        0,
        graph_opened_count,
        graph_closed_count,
        &mut clock,
        "semantic_upgrade",
    )?;
    clock.record_snapshot(snapshot_started.elapsed());

    Ok(Some(ResidualOutcome {
        generation: new_generation,
        upgraded_sites: upgraded,
        external_sites: external,
        unresolved_sites: unresolved,
        inferred_type_entities,
        type_of_relations,
        diagnostics_emitted,
        timings: clock.completed_timings(),
        truncated,
        remaining_roots: remaining_owner_paths,
        windows_done,
        windows_total,
    }))
}

fn discover_binary(workspace_root: &str) -> Result<urdira_tsgo_client::binary::TsgoBinary, String> {
    if let Ok(binary) = binary::discover(Path::new(workspace_root)) {
        return Ok(binary);
    }
    // A workspace root outside this repo's own `node_modules` tree (the
    // common real-world case) never resolves a tsgo binary relative to
    // itself -- fall back to searching upward from this WORKER PROCESS's
    // own executable for a directory `binary::discover` accepts (its own
    // `node_modules/typescript`). Bounded walk, not a fixed ancestor
    // index: a debug test binary lives under `target/debug/deps/`, one
    // level deeper than a release binary under `target/release/`, so no
    // single fixed `.ancestors().nth(N)` is right for both.
    let mut last_error = "no candidate directory found".to_string();
    if let Ok(exe) = std::env::current_exe() {
        for candidate in exe.ancestors().skip(1).take(8) {
            match binary::discover(candidate) {
                Ok(binary) => return Ok(binary),
                Err(error) => last_error = format!("{error:?}"),
            }
        }
    }
    Err(last_error)
}

/// The prior generation's own `source_state_digest` -- an upgrade
/// generation touches no source bytes at all, so it carries the SAME
/// digest forward unchanged (the source frontier did not move).
fn read_source_state_digest(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    generation: u64,
) -> Result<String, ScanError> {
    conn.query_row(
        "SELECT source_state_digest FROM snapshots WHERE workspace_id = ?1 AND generation = ?2",
        rusqlite::params![workspace_id, generation as i64],
        |row| row.get::<_, String>(0),
    )
    .map_err(|error| {
        ScanError(format!(
            "v4 residual: reading source_state_digest failed: {error}"
        ))
    })
}

fn correlation_key(path: &str, start: i32, end: i32, kind: SiteKind) -> String {
    format!("{path}\u{0}{start}\u{0}{end}\u{0}{kind:?}")
}

/// One `pending.sites` row this pass may upgrade -- A2 (pending.sites
/// migration): replaces the pre-migration `possible_record_id`/
/// `was_mismatched` shape (there is no possible RECORD any more to hold an
/// id or a mismatch flag; `pending_key` addresses the store's own side
/// table row instead, and there is nothing left to "repair": a confirmed-
/// shaped relation whose target never interned is DROPPED at materialize
/// time and synthesizes its OWN `target_not_interned` pending site --
/// `materialize.rs`'s `plan_relation_repair` -- so every `PendingMeta` this
/// module ever builds already represents a genuinely open site).
struct PendingMeta {
    pending_key: PendingSiteKey,
    owner_artifact: u32,
    owner_version: u32,
    source_id: String,
    source_subject: u32,
    relation_kind: &'static str,
}

struct Collected<'a> {
    pending_by_owner: BTreeMap<String, Vec<PendingSite>>,
    by_site: HashMap<String, PendingMeta>,
    entities: EntityLookup<'a>,
}

/// F4 4.3: replaces the pre-4.3 full-`iter_visible` scan (`EntityIndex::
/// build(entity_entries)`, O(corpus)) with a lazy adapter over the store's
/// own persisted `entities.index` section (`StoreReader::entity_by_owner_
/// and_start`, O(sites)) by default. `URDIRA_V4_ENTITY_INDEX=scan` keeps
/// the old full-scan `EntityIndex` path available for comparison/debugging
/// (see `entities_index_section_and_scan_agree_on_the_shared_fixture`).
enum EntityLookup<'a> {
    /// `URDIRA_V4_ENTITY_INDEX=scan`: `urdira_tsgo_client::entity_index::
    /// EntityIndex`, eagerly built from a full `iter_visible` scan of every
    /// `CATEGORY_ENTITY` record (excluding `jsts:entity_inferred_type` --
    /// see this module's own doc comment on that exclusion, still true
    /// here), exactly what this module did before F4 4.3.
    Scan(EntityIndex),
    /// Default: resolves `path` to an `owner_artifact` ordinal (the same
    /// `Frontier`-derived reverse map `owner_path`'s own callers already
    /// build, kept local to this enum instead) then a single
    /// `entity_by_owner_and_start` binary search per site --
    /// `real_path_by_lower` is this variant's OWN copy of the exact
    /// fallback `EntityIndex::lookup` always had (tsgo's `useCaseSensitive
    /// FileNames: false` behavior lowercases a resolved declaration's
    /// path -- see `run_once_with_quiet_period`'s `real_path_by_lower` for
    /// the fuller writeup), built once here from the same `Frontier`
    /// rather than reusing that outer map, so `collect()` stays a
    /// self-contained function callable with nothing but a store+dicts+
    /// frontier snapshot (as every existing test call site already has).
    Section {
        store: &'a StoreReader,
        owner_ordinal_by_path: HashMap<String, u32>,
        real_path_by_lower: HashMap<String, String>,
        generation: u64,
    },
}

impl EntityLookup<'_> {
    /// Same contract `EntityIndex::lookup` always had (exact match, then a
    /// lowercased-path fallback), except it returns the raw `record_id`
    /// bytes directly instead of a hex string a caller must then `decode_
    /// hex32` itself -- `EntityLookup` never had a reason to round-trip
    /// through hex at all in the `Section` case (`entity_by_owner_and_
    /// start` already returns a `RecordView`); `Scan` decodes once here so
    /// both variants share one return type.
    fn lookup(&self, path: &str, name_start_utf16: i32) -> Option<[u8; 32]> {
        match self {
            EntityLookup::Scan(index) => {
                index.lookup(path, name_start_utf16).and_then(decode_hex32)
            }
            EntityLookup::Section {
                store,
                owner_ordinal_by_path,
                real_path_by_lower,
                generation,
            } => {
                let start = u32::try_from(name_start_utf16).ok()?;
                let owner = owner_ordinal_by_path.get(path).copied().or_else(|| {
                    real_path_by_lower
                        .get(&path.to_ascii_lowercase())
                        .and_then(|real| owner_ordinal_by_path.get(real).copied())
                })?;
                store
                    .entity_by_owner_and_start(owner, start, *generation)
                    .map(|view| view.record_id())
            }
        }
    }
}

/// A2 (pending.sites migration): pending sites now come straight from the
/// store's own `pending.sites` table (`StoreReader::iter_visible_pending_
/// sites`) instead of a full `iter_visible` scan filtered to `target_
/// subject().is_none()` relations -- there is no such relation any more to
/// filter for (see this module's own doc comment, "Store access without a
/// body decoder", for why every field this function needs is still a plain
/// metadata column, never a body decode). F4 4.3: the entity index no
/// longer needs a full `iter_visible` scan either (see `EntityLookup`'s own
/// doc comment) -- `collect()`'s own cost is now O(pending sites + owners
/// in the frontier), not O(corpus).
///
/// **Known regression versus the pre-migration `collect()`** (reported, not
/// silently fixed): the old implementation recovered a call site's
/// `source_id` from the relation record's own IDENTITY TEXT whenever
/// `source_subject()` was `None` (P1-D-f's fix for the "call's enclosing
/// scope is a class/interface member" gap -- v4's entity schema does not
/// materialize members, so `source_subject` never interned for such a
/// site). A `PendingSiteRow` carries no such text fallback -- only
/// `source_subject: Option<u32>`, resolved by `materialize.rs` the exact
/// same way a relation row's own endpoint resolves (this task's own brief).
/// A pending site whose `source_subject` does not resolve is therefore
/// SKIPPED here (never sent to the checker at all), same as it always was
/// for a heritage site missing the (never-implemented) text fallback, but
/// now ALSO true for a member-owner call site P1-D-f specifically fixed.
/// `force_scan` is a plain parameter (not an env-var read inside this
/// function) specifically so a test can call both entity-index strategies
/// directly, side by side, in-process -- this crate is `#![forbid(unsafe_
/// code)]`, so a test cannot itself call `std::env::set_var` to toggle
/// `URDIRA_V4_ENTITY_INDEX` between two calls. Production has exactly one
/// call site (`run_once_with_quiet_period`), which reads the env var once
/// and passes the result in here.
fn collect<'a>(
    store: &'a StoreReader,
    dicts: &Dictionaries,
    owner_path: &dyn Fn(u32) -> Option<String>,
    frontier: &Frontier,
    generation: u64,
    force_scan: bool,
) -> Collected<'a> {
    let mut pending_by_owner: BTreeMap<String, Vec<PendingSite>> = BTreeMap::new();
    let mut by_site: HashMap<String, PendingMeta> = HashMap::new();

    let entities = if force_scan {
        let mut entity_entries: Vec<(String, i32, String)> = Vec::new();
        for view in store.iter_visible(generation) {
            if view.category() == CATEGORY_ENTITY {
                // Decision 28's "inferred types" task: a `jsts:entity_
                // inferred_type` record deliberately carries the SAME
                // `path`/`start`/`end` as the declaration it types
                // (matching v3's own `semanticTypeRecords` recipe, verified
                // byte-for-byte against the oracle -- see `build_inferred_
                // type_rows`'s doc comment). For a class/interface member
                // with no leading modifier keyword, that span's OWN start
                // coincides EXACTLY with the member declaration's own
                // name-identifier start (the key this index uses) -- e.g.
                // `count = 0;`/`describe() {}`. If such an inferred-type
                // entity were included here, it would collide with the
                // very declaration it types in this index's `(path,
                // start)` key space, and (depending on iteration order)
                // could WIN that slot -- corrupting every future lookup of
                // the real declaration into pointing at its own
                // inferred-type entity instead (confirmed live:
                // `inferred_types_and_diagnostics_across_two_runs_and_an_
                // edit`'s run 2 produced a `type_of` relation whose
                // `source_id` was itself a `jsts:inferred-type:...`
                // identity, not the declaration's, before this exclusion).
                // An inferred-type entity is never a valid call/heritage
                // TARGET or `type_of` SOURCE lookup result, so excluding it
                // here is always correct, not merely a workaround. The
                // `Section` variant below enforces the SAME rule at write
                // time instead (`segment_io::is_entities_index_row`).
                let Some(kind) = dicts.kinds.get(view.kind_id() as usize) else {
                    continue;
                };
                if kind == "jsts:entity_inferred_type" {
                    continue;
                }
                let Some(path) = owner_path(view.owner_artifact()) else {
                    continue;
                };
                entity_entries.push((
                    path,
                    view.span_start_byte() as i32,
                    materialize::hex_encode(&view.record_id()),
                ));
            }
        }
        EntityLookup::Scan(EntityIndex::build(entity_entries))
    } else {
        let pair_to_ordinal: HashMap<(String, String), u32> = dicts
            .artifacts
            .iter()
            .enumerate()
            .map(|(ordinal, pair)| (pair.clone(), ordinal as u32))
            .collect();
        let mut owner_ordinal_by_path: HashMap<String, u32> = HashMap::new();
        let mut real_path_by_lower: HashMap<String, String> = HashMap::new();
        for (path, entry) in &frontier.present {
            real_path_by_lower.insert(path.to_ascii_lowercase(), path.clone());
            if let Some(&ordinal) =
                pair_to_ordinal.get(&(entry.artifact_id.clone(), entry.artifact_version_id.clone()))
            {
                owner_ordinal_by_path.insert(path.clone(), ordinal);
            }
        }
        EntityLookup::Section {
            store,
            owner_ordinal_by_path,
            real_path_by_lower,
            generation,
        }
    };

    for view in store.iter_visible_pending_sites(generation) {
        let (site_kind, relation_kind): (SiteKind, &'static str) = match view.site_kind() {
            urdira_structural_store::PENDING_SITE_KIND_CALL => (SiteKind::Call, "call"),
            urdira_structural_store::PENDING_SITE_KIND_INHERITS => (SiteKind::Heritage, "inherits"),
            urdira_structural_store::PENDING_SITE_KIND_IMPLEMENTS => {
                (SiteKind::Heritage, "implements")
            }
            _ => continue,
        };
        let Some(path) = owner_path(view.owner_artifact()) else {
            continue;
        };
        let start = view.start() as i32;
        let end = view.end() as i32;
        // `target_not_interned` sites are included deliberately (task
        // brief): they are real call/heritage sites tsgo may still resolve
        // -- the only reason their OWN relation record was dropped at
        // materialize time is that v4's cold entity producer does not
        // materialize class/interface MEMBERS yet, an orthogonal, already-
        // documented gap (`try_synthesize_member_entity`'s own doc comment
        // handles exactly this on the TARGET side).
        let Some(source_subject) = view.source_subject() else {
            continue;
        };
        let Some(source_id) = dicts
            .subjects
            .get(source_subject as usize)
            .and_then(|record_id| store.get_visible(record_id, generation))
            .map(|source_view| String::from_utf8_lossy(&source_view.identity_key()).into_owned())
        else {
            continue;
        };
        let key = correlation_key(&path, start, end, site_kind);
        by_site.insert(
            key,
            PendingMeta {
                pending_key: view.key(),
                owner_artifact: view.owner_artifact(),
                owner_version: view.owner_version(),
                source_id,
                source_subject,
                relation_kind,
            },
        );
        pending_by_owner
            .entry(path.clone())
            .or_default()
            .push(PendingSite {
                owner_path: path,
                start,
                end,
                kind: site_kind,
                reason: relation_kind.to_string(),
            });
    }

    Collected {
        pending_by_owner,
        by_site,
        entities,
    }
}

fn decode_hex32(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        let hi = (hex.as_bytes()[index * 2] as char).to_digit(16)?;
        let lo = (hex.as_bytes()[index * 2 + 1] as char).to_digit(16)?;
        *byte = ((hi << 4) | lo) as u8;
    }
    Some(out)
}

fn canonical_json(value: &serde_json::Value) -> String {
    serde_json::to_string(value).expect("residual pass builds only plain JSON values")
}

fn canonical_span(path: &str, start: i32, end: i32) -> String {
    canonical_json(&serde_json::json!({ "path": path, "start": start, "end": end }))
}

fn canonical_evidence(path: &str, start: i32, end: i32) -> String {
    canonical_json(&serde_json::json!([{ "path": path, "start": start, "end": end }]))
}

/// `urdira-jsts-syntax-worker::lib.rs`'s `proposal_record_key` recipe,
/// reimplemented here for the same isolation reason `delta.rs`/`publish.rs`
/// already document for their own independent copies of shared recipes:
/// this module cannot depend on that crate's `pub(crate)` helpers.
fn proposal_record_key(identity_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"urdira:jsts-proposal-record:v1\0");
    hasher.update((identity_key.len() as u64).to_be_bytes());
    hasher.update(identity_key.as_bytes());
    let mut out = String::with_capacity(80);
    out.push_str("jsts:record:sha256:");
    for byte in hasher.finalize() {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Maps a raw checker `SyntaxKind` number (`crate::node::syntax_kind`'s own
/// numeric constants -- see that module's doc comment for why these are
/// hand-verified against a live tsgo session rather than guessed) to the
/// `jsts:{kind}:...` identity scheme's kind word, for a declaration this
/// pass is about to synthesize an entity for. Only the two member kinds
/// this task directly confirmed at real-corpus scale
/// (`docs/evidence/2026-09-04-v4-p1d-d-residual-diagnosis.md`'s reason
/// histogram: `MethodDeclaration` dominates `entity_index_miss` samples by
/// a wide margin, `Constructor` a smaller but real share) get their own
/// precise label; anything else falls back to the generic `"member"` --
/// still produces a real, resolvable entity, just less precisely labeled.
///
/// P1-D-f: extended with `GetAccessor`/`SetAccessor`/`PropertyDeclaration`/
/// `Parameter`, and `MethodSignature` is folded into the SAME `"method"`
/// label as `MethodDeclaration` -- not given its own distinct word. Both
/// choices are dictated by v3's own entity producer
/// (`packages/plugin-javascript-typescript/src/analyzer.ts::addEntity`,
/// lines ~455-467), the ground truth this whole `jsts:{kind}:...` identity
/// scheme has to match byte-for-byte for the v3/v4 parity diff
/// (`scripts/v4-call-parity-diff.mjs`) to compare targets by simple string
/// equality: `analyzer.ts` collapses `isMethodDeclaration(node) ||
/// isMethodSignatureDeclaration(node)` into one `kind = "method"` branch
/// (never `"method_signature"` -- confirmed live: giving `MethodSignature`
/// its own label during this task's FIRST parity-diff run produced
/// spurious `v4_confirmed_different_target` rows for interface method
/// signatures that v3 and v4 both resolve to the exact same declaration,
/// just under two different id strings), and gives a `Parameter` node
/// (`isParameterDeclaration`) its own `"parameter"` kind, never folding it
/// into a generic member label -- also confirmed live to matter: a callback
/// parameter used as a call target (e.g. `resolve` in
/// `new Promise((resolve) => ...)`) is common enough in this corpus to be
/// the LARGEST single contributor to that same spurious-mismatch bucket
/// before this fix. `PropertySignature` (an interface's own property, e.g.
/// `interface Baz { sigProp: number }`) has NO v3 equivalent at all --
/// `addEntity`'s own kind cascade falls through to `return undefined` for
/// it (v3 never materializes an entity for a bare property signature, so a
/// v3-confirmed call can never target one) -- kept as a distinct label here
/// anyway since there is no possible v3 identity string to collide with or
/// match either way, and a distinct label is more diagnosable than folding
/// it into the generic `"member"` catch-all.
fn member_kind_name(decl_kind: u32) -> &'static str {
    use urdira_tsgo_client::node::syntax_kind;
    match decl_kind {
        syntax_kind::METHOD_DECLARATION | syntax_kind::METHOD_SIGNATURE => "method",
        syntax_kind::CONSTRUCTOR => "constructor",
        syntax_kind::GET_ACCESSOR => "getter",
        syntax_kind::SET_ACCESSOR => "setter",
        syntax_kind::PROPERTY_DECLARATION => "property",
        syntax_kind::PARAMETER => "parameter",
        syntax_kind::PROPERTY_SIGNATURE => "property_signature",
        // Not a class/interface member at all -- reached via `resolver.rs`'s
        // `resolve_handle` re-anchoring an anonymous function value (`const
        // foo = async () => {...}`) onto its enclosing `VariableDeclaration`
        // (see that function's own doc comment). `analyzer.ts`'s `addEntity`
        // gives a `VariableDeclaration` the kind word `"variable"` -- same
        // reasoning as `PARAMETER` above: matching v3's own word, not
        // inventing a new one, is what makes the identity strings comparable
        // at all.
        syntax_kind::VARIABLE_DECLARATION => "variable",
        _ => "member",
    }
}

/// P1-D-d root-cause fix: synthesizes a NEW `CATEGORY_ENTITY` record for a
/// class/interface member declaration (method, constructor, or a generic
/// member fallback) that a resolved `SiteOutcome::WorkspaceTarget` points
/// at but `collected.entities` has no entry for -- see this module's own
/// doc comment on `ResidualDebug`'s `entity_index_miss` bucket and the
/// evidence doc's root-cause analysis for why this is the DOMINANT reason
/// the residual pass upgraded so few sites before this fix: v4's lane-1
/// entity producer (`urdira-jsts-syntax-worker::SyntaxCollector::
/// push_entity`) only ever materializes MODULE-LEVEL entities (function,
/// class, variable, enum, type, interface) -- a class or interface's own
/// MEMBERS are never independently queryable entities today, even though
/// tsgo's checker resolves ordinary method-dispatch calls
/// (`this.repository.save(...)`) to exactly such a member declaration
/// constantly, and member-dispatch calls are the dominant shape of a real
/// codebase's call sites.
///
/// Rather than widen the whole v4 entity schema for every cold scan (a
/// much larger, cross-cutting change: it touches the lane-1 producer, the
/// entity/relation graph shape, and every existing test asserting entity
/// counts -- real, separate scope, not attempted here), this function
/// creates the missing entity itself, JIT, as part of the SAME
/// `semantic_upgrade` generation that needs it, using the IDENTICAL
/// `jsts:{kind}:{path}:{start}:{name}` identity recipe
/// `urdira_jsts_syntax_worker`'s `stable_entity_id` uses for every other
/// entity kind (verified against that crate's own `proposal_entity_record`
/// source, not guessed) -- so a FUTURE proper member-entity producer,
/// should one ever ship, would compute the exact same identity for the
/// exact same declaration and transparently CONTINUE this record's own
/// chain via `by_identity_last` (`build_confirmed_row`'s own precedent)
/// rather than collide or duplicate it.
///
/// Returns `None` (silently, callers count it as `unresolved`) for any
/// reason this cannot proceed: no `target_store_path` (the `strip_prefix`
/// already failed upstream), the target path cannot be recovered in
/// either its real or lowercased form (`real_path_by_lower`), the target
/// file's text is not in `file_map` (outside the jsts source set --
/// should not happen for a workspace target, but never assumed), no
/// identifier text at `name_start_utf16` (`identifier_text_at` itself is
/// conservative and returns `None` for anything that doesn't look like a
/// real identifier), or the target file's own `(artifact_id,
/// artifact_version_id)` pair has no ordinal yet (would require it to be
/// a file the frontier has never assigned an artifact for at all -- not
/// expected for a file the checker itself just resolved a declaration
/// inside).
#[allow(clippy::too_many_arguments)]
fn try_synthesize_member_entity(
    target_store_path: Option<&str>,
    name_start_utf16: i32,
    decl_start: i32,
    decl_end: i32,
    decl_kind: u32,
    real_path_by_lower: &HashMap<String, String>,
    frontier: &Frontier,
    artifact_ordinal_by_pair: &HashMap<(String, String), u32>,
    file_map: &BTreeMap<String, String>,
    workspace_root: &str,
    store: &StoreReader,
    generation: u64,
    new_generation: u32,
    cache: &mut HashMap<(String, i32), [u8; 32]>,
    line_index_cache: &mut HashMap<String, urdira_jsts_syntax_worker::LineIndex>,
    opened_records: &mut Vec<RecordRow>,
    kinds_dict: &mut OrdinalDict<String>,
    universal_kinds_dict: &mut OrdinalDict<String>,
    names_dict: &mut OrdinalDict<String>,
) -> Option<([u8; 32], String)> {
    let raw_path = target_store_path?;
    let real_path = if frontier.present.contains_key(raw_path) {
        raw_path.to_string()
    } else {
        real_path_by_lower
            .get(&raw_path.to_ascii_lowercase())?
            .clone()
    };

    let cache_key = (real_path.clone(), name_start_utf16);
    if let Some(record_id) = cache.get(&cache_key) {
        // Already synthesized (by an earlier site in this same pass) --
        // its identity is stable, so re-derive the identity_key string
        // deterministically rather than re-scanning `opened_records`.
        let entry = frontier.present.get(&real_path)?;
        let name = identifier_text_at_path(file_map, workspace_root, &real_path, name_start_utf16)?;
        let kind_name = member_kind_name(decl_kind);
        let _ = entry;
        return Some((
            *record_id,
            format!("jsts:{kind_name}:{real_path}:{name_start_utf16}:{name}"),
        ));
    }

    let entry = frontier.present.get(&real_path)?;
    let owner_artifact = *artifact_ordinal_by_pair
        .get(&(entry.artifact_id.clone(), entry.artifact_version_id.clone()))?;
    let name = identifier_text_at_path(file_map, workspace_root, &real_path, name_start_utf16)?;
    let kind_name = member_kind_name(decl_kind);
    let identity_key = format!("jsts:{kind_name}:{real_path}:{name_start_utf16}:{name}");

    // P1-D-f: the entity record's own `kind`/`universal_kind` dictionary
    // strings used to be hardcoded to `"jsts:entity_callable"`/
    // `"core:callable"` regardless of `kind_name` -- correct for
    // method/constructor/getter/setter (v3's own `analyzer.ts` gives all
    // four `universalKind: "core:callable"` too), but wrong for `property`/
    // `parameter`/the generic `member`/`property_signature` fallbacks,
    // which v3 categorizes as `core:value`/`core:parameter` instead (never
    // callable). v4's own `UniversalKind` enum
    // (`urdira_jsts_syntax_worker::UniversalKind`) has no `Parameter`
    // variant at all -- not something this module can add without a schema
    // change to a crate it does not own this session -- so `parameter` maps
    // to the closest EXISTING category, `Value`/`"jsts:entity_variable"`
    // (the same one `proposal_entity_record` already uses for its own
    // `UniversalKind::Value` entities, e.g. a top-level `variable`), rather
    // than the clearly-wrong `Callable`. Strictly better than the prior
    // always-`Callable` default; not claimed to be a full fix of the
    // missing `core:parameter` category.
    let member_is_callable = matches!(kind_name, "method" | "constructor" | "getter" | "setter");
    let (kind, universal_kind) = if member_is_callable {
        ("jsts:entity_callable", "core:callable")
    } else {
        ("jsts:entity_variable", "core:value")
    };
    let kind = kind.to_string();
    let universal_kind = universal_kind.to_string();
    // A3b: strict lexicographic key order (`end`, `kind`, `language`,
    // `name`, `path`, `start`, `synthesized_by`).
    let mut encoder = urdira_native_core::BodyEncoder::new();
    encoder
        .begin_object(7)
        .expect("member entity body field count is fixed");
    encoder.key("end").expect("member entity body key order");
    encoder.int(i64::from(decl_end)).expect("int never fails");
    encoder.key("kind").expect("member entity body key order");
    encoder.string(kind_name).expect("string never fails");
    encoder
        .key("language")
        .expect("member entity body key order");
    encoder.string("typescript").expect("string never fails");
    encoder.key("name").expect("member entity body key order");
    encoder.string(&name).expect("string never fails");
    encoder.key("path").expect("member entity body key order");
    encoder.string(&real_path).expect("string never fails");
    encoder.key("start").expect("member entity body key order");
    encoder.int(i64::from(decl_start)).expect("int never fails");
    encoder
        .key("synthesized_by")
        .expect("member entity body key order");
    encoder
        .string("v4_residual_pass")
        .expect("string never fails");
    let body = encoder.finish();
    let facets = canonical_json(&serde_json::json!([
        "core:declaration",
        "core:definition",
        "core:member"
    ]));
    let source_span = canonical_span(&real_path, decl_start, decl_end);
    let evidence_references = canonical_evidence(&real_path, decl_start, decl_end);
    let record_key = StructuralKernelRecordRef {
        proposal_record_key: &proposal_record_key(&identity_key),
        category: "entity",
        kind: &kind,
        universal_kind: &universal_kind,
        facets: &facets,
        schema_version: 1,
        source_span: &source_span,
        identity_key: &identity_key,
        body: urdira_native_core::BodyRef::Encoded(&body),
        evidence_references: &evidence_references,
    };
    let mut batches = materialize::kernel_rows_batches(std::slice::from_ref(&record_key)).ok()?;
    let kernel_rows = batches.pop()?;
    let kernel_row = kernel_rows.rows.into_iter().next()?;

    let identity_key_digest = identity_key_digest_bytes(&identity_key);
    let (record_id, record_digest, previous_record_id) =
        match store.by_identity_last(&identity_key_digest) {
            Some(last) if last.is_visible(generation) => {
                // Already live (a prior residual pass, still generation<=
                // publish_generation, already synthesized this exact
                // member) -- reuse it directly rather than duplicate.
                let record_id = last.record_id();
                cache.insert(cache_key, record_id);
                return Some((record_id, identity_key));
            }
            Some(last) => {
                let predecessor_id = last.record_id();
                (
                    diff::chained_record_id(&kernel_row.record_digest, &predecessor_id),
                    kernel_row.record_digest,
                    predecessor_id,
                )
            }
            None => (kernel_row.record_id, kernel_row.record_digest, [0u8; 32]),
        };

    let kind_id = u16::try_from(kinds_dict.intern(&kind)).unwrap_or(u16::MAX);
    let universal_kind_id =
        u16::try_from(universal_kinds_dict.intern(&universal_kind)).unwrap_or(u16::MAX);
    let name_id = names_dict.intern(&name);

    // A4 (line numbers task): `decl_start`/`decl_end` are UTF-16 offsets on
    // `real_path` (same convention `identifier_text_at_path` above already
    // relies on for this exact file/offset pair).
    let (raw_start_line, raw_end_line) = span_lines_for(
        line_index_cache,
        file_map,
        workspace_root,
        &real_path,
        decl_start,
        decl_end,
    );
    let span_start_line = if raw_start_line == 0 {
        NONE_U32
    } else {
        raw_start_line
    };
    let span_end_line = if raw_end_line == 0 {
        NONE_U32
    } else {
        raw_end_line
    };

    opened_records.push(RecordRow {
        record_id,
        owner_artifact,
        owner_version: owner_artifact,
        valid_from: new_generation,
        valid_to: 0,
        category: CATEGORY_ENTITY,
        kind_id,
        universal_kind_id,
        facets: materialize::facets_bitmask(&kernel_row.facets),
        span_artifact_version: owner_artifact,
        span_start_byte: kernel_row.span_start,
        span_end_byte: kernel_row.span_end,
        span_start_line,
        span_end_line,
        identity_type: 1,
        assignment_kind: 0,
        name_id,
        identity_key: kernel_row.identity_key.into_bytes(),
        record_digest,
        body_digest: kernel_row.body_digest,
        identity_id: kernel_row.identity_id,
        identity_key_digest: kernel_row.identity_key_digest,
        previous_record_id,
        source_subject: None,
        target_subject: None,
        relation_kind_id: 0,
        body: kernel_row.body,
    });
    cache.insert(cache_key, record_id);
    Some((record_id, identity_key))
}

/// Slices `real_path`'s own text (from `file_map`, keyed by virtual path)
/// at `name_start_utf16` and reads the identifier there
/// (`crate::node::identifier_text_at`, the same primitive
/// `SiteOutcome::External`'s own `symbol_name` classification already
/// uses for a lib file -- this is the identical operation against a
/// workspace file's text instead).
fn identifier_text_at_path(
    file_map: &BTreeMap<String, String>,
    workspace_root: &str,
    real_path: &str,
    name_start_utf16: i32,
) -> Option<String> {
    let virtual_path = format!("{workspace_root}/{real_path}");
    let text = file_map.get(&virtual_path)?;
    let units: Vec<u16> = text.encode_utf16().collect();
    urdira_tsgo_client::node::identifier_text_at(&units, name_start_utf16)
}

/// A4 (line numbers task, 2026-09-05): `real_path`'s own UTF-16 line index
/// (`urdira_jsts_syntax_worker::LineIndex`), built once per owner path and
/// cached in `cache` for the rest of this residual run -- every row this
/// module synthesizes for the SAME owner (a synthesized member entity, a
/// newly-confirmed relation, an inferred-type entity/relation pair, a
/// diagnostic row) reuses it rather than re-scanning the owner's text per
/// record. Same `file_map`/`workspace_root` virtual-path convention
/// `identifier_text_at_path` above already uses. `None` when `real_path`'s
/// text is not in `file_map` (should not happen for a live frontier entry
/// this pass is actually touching, but never guessed at -- the caller falls
/// back to "no line known", `0`, the same sentinel a synthetic `ProposedRecord`
/// with no real span uses).
fn owner_line_index<'a>(
    cache: &'a mut HashMap<String, urdira_jsts_syntax_worker::LineIndex>,
    file_map: &BTreeMap<String, String>,
    workspace_root: &str,
    real_path: &str,
) -> Option<&'a urdira_jsts_syntax_worker::LineIndex> {
    if !cache.contains_key(real_path) {
        let virtual_path = format!("{workspace_root}/{real_path}");
        let text = file_map.get(&virtual_path)?;
        cache.insert(
            real_path.to_owned(),
            urdira_jsts_syntax_worker::LineIndex::from_text(text),
        );
    }
    cache.get(real_path)
}

/// 1-based `(start_line, end_line)` for a `(start, end)` UTF-16 offset pair
/// on `real_path`, via [`owner_line_index`]'s cache -- `(0, 0)` ("no line
/// known") when the owner's text is unavailable or an offset is negative
/// (defensive; every real `tsgo` offset this module reads is non-negative,
/// but `i32` is the wire type -- see `ResidualPass`'s own doc comment).
fn span_lines_for(
    cache: &mut HashMap<String, urdira_jsts_syntax_worker::LineIndex>,
    file_map: &BTreeMap<String, String>,
    workspace_root: &str,
    real_path: &str,
    start: i32,
    end: i32,
) -> (u32, u32) {
    let (Ok(start), Ok(end)) = (u32::try_from(start), u32::try_from(end)) else {
        return (0, 0);
    };
    match owner_line_index(cache, file_map, workspace_root, real_path) {
        Some(index) => (index.line_of(start), index.line_of(end)),
        None => (0, 0),
    }
}

/// Builds one confirmed `core:call`/`core:inherits`/`core:implements`
/// `RecordRow`, byte-for-byte matching `semantic_sites.rs`'s
/// `call_proposed_record`/`heritage_proposed_record` identity/body recipe.
/// Runs it through the real structural kernel (`structural_kernel_rows_ref`)
/// for its content-derived digests -- never hand-computed. Decision 11:
/// since this row's `identity_key` differs from the possible row it
/// replaces, this is either a genuine first occurrence or a reopen
/// (`StoreReader::by_identity_last`) of a prior residual-pass generation's
/// own row -- NEVER a continuation of the possible row's own identity (see
/// `diff.rs`'s doc comment on why a fresh v4-only chaining recipe exists).
/// Returns `Ok(None)` if the confirmed identity is somehow already LIVE
/// elsewhere (a defensive case not expected in practice, since a relation
/// identity embeds its own exact source span) -- caller counts that as
/// `unresolved` rather than silently double-publishing.
#[allow(clippy::too_many_arguments)]
fn build_confirmed_row(
    path: &str,
    start: i32,
    end: i32,
    source_id: &str,
    target_id: &str,
    relation_kind: &'static str,
    target_record_id: &[u8; 32],
    owner_artifact: u32,
    owner_version: u32,
    source_subject: Option<u32>,
    store: &StoreReader,
    generation: u64,
    new_generation: u32,
    file_map: &BTreeMap<String, String>,
    workspace_root: &str,
    line_index_cache: &mut HashMap<String, urdira_jsts_syntax_worker::LineIndex>,
    kinds_dict: &mut OrdinalDict<String>,
    universal_kinds_dict: &mut OrdinalDict<String>,
    relation_kinds_dict: &mut OrdinalDict<String>,
    names_dict: &mut OrdinalDict<String>,
    subjects_dict: &mut OrdinalDict<[u8; 32]>,
) -> Result<Option<RecordRow>, ScanError> {
    let (kind, universal_kind, identity_key) = if relation_kind == "call" {
        (
            "jsts:relation_call".to_string(),
            "core:call".to_string(),
            format!("jsts:call:{path}:{start}:{end}:{source_id}:{target_id}"),
        )
    } else {
        (
            format!("jsts:relation_{relation_kind}"),
            format!("core:{relation_kind}"),
            format!("jsts:{relation_kind}:{path}:{start}:{end}:{source_id}:{target_id}"),
        )
    };

    // A3b: strict lexicographic key order (`classification`, `end`, `path`,
    // `source_id`, `start`, `target_id`).
    let mut encoder = urdira_native_core::BodyEncoder::new();
    encoder
        .begin_object(6)
        .expect("confirmed relation body field count is fixed");
    encoder
        .key("classification")
        .expect("relation body key order");
    encoder.string("confirmed").expect("string never fails");
    encoder.key("end").expect("relation body key order");
    encoder.int(i64::from(end)).expect("int never fails");
    encoder.key("path").expect("relation body key order");
    encoder.string(path).expect("string never fails");
    encoder.key("source_id").expect("relation body key order");
    encoder.string(source_id).expect("string never fails");
    encoder.key("start").expect("relation body key order");
    encoder.int(i64::from(start)).expect("int never fails");
    encoder.key("target_id").expect("relation body key order");
    encoder.string(target_id).expect("string never fails");
    let body = encoder.finish();

    let facets = canonical_json(&serde_json::json!(["core:reference_relation"]));
    let source_span = canonical_span(path, start, end);
    let evidence_references = canonical_evidence(path, start, end);
    let record_key = StructuralKernelRecordRef {
        proposal_record_key: &proposal_record_key(&identity_key),
        category: "relation",
        kind: &kind,
        universal_kind: &universal_kind,
        facets: &facets,
        schema_version: 1,
        source_span: &source_span,
        identity_key: &identity_key,
        body: urdira_native_core::BodyRef::Encoded(&body),
        evidence_references: &evidence_references,
    };

    let mut batches = materialize::kernel_rows_batches(std::slice::from_ref(&record_key))?;
    let Some(kernel_rows) = batches.pop() else {
        return Ok(None);
    };
    let Some(kernel_row) = kernel_rows.rows.into_iter().next() else {
        return Ok(None);
    };

    let identity_key_digest = identity_key_digest_bytes(&identity_key);
    // A2 (pending.sites migration): the OLD "fail closed unless the live
    // occupant is `predecessor` itself" guard existed only because a
    // classification-mismatched POSSIBLE row (a relation record with a
    // confirmed-shaped identity but no interned `target_subject`) used to
    // be the exact same record as `predecessor` -- that population no
    // longer exists as a RECORD at all (`materialize.rs`'s `plan_relation_
    // repair` drops it and emits a `pending.sites` row instead), so there is
    // no `predecessor` to compare against any more. What CAN legitimately
    // occupy this identity today: (a) nothing (first confirmation, `None`
    // below); (b) a PRIOR generation's own confirmed row for the exact same
    // site+target (a second residual pass re-deriving the same answer --
    // correctly chained off, decision 11's supersede-and-chain case); (c) a
    // live P2-2j CANDIDATE row for this exact `(source, target)` pair (an
    // overload/union receiver's own per-candidate guess that happens to
    // agree with what the checker just confirmed) -- the caller closes
    // every candidate row at this SAME SPAN right after this call succeeds
    // (see the materialize loop's own comment), so chaining off it here is
    // exactly the correct "confirmed supersedes candidate" behavior, not a
    // collision. Always chain when found; there is no case left where a
    // DIFFERENT, unrelated row could legitimately occupy a content-derived
    // identity that embeds its own exact source span.
    let (record_id, record_digest, previous_record_id) =
        match store.by_identity_last(&identity_key_digest) {
            Some(last) if last.is_visible(generation) => {
                let predecessor_id = last.record_id();
                (
                    diff::chained_record_id(&kernel_row.record_digest, &predecessor_id),
                    kernel_row.record_digest,
                    predecessor_id,
                )
            }
            _ => (kernel_row.record_id, kernel_row.record_digest, [0u8; 32]),
        };

    let kind_id = u16::try_from(kinds_dict.intern(&kind)).unwrap_or(u16::MAX);
    let universal_kind_id =
        u16::try_from(universal_kinds_dict.intern(&universal_kind)).unwrap_or(u16::MAX);
    let relation_kind_id =
        u16::try_from(relation_kinds_dict.intern(&universal_kind)).unwrap_or(u16::MAX);
    let name_id = names_dict.intern(&materialize::identity_key_name(&identity_key).to_owned());
    let target_subject = Some(subjects_dict.intern(target_record_id));

    // A4 (line numbers task): `path`/`start`/`end` are this relation's own
    // owner file and UTF-16 span (the pending site's own coordinates,
    // unchanged by confirmation).
    let (raw_start_line, raw_end_line) =
        span_lines_for(line_index_cache, file_map, workspace_root, path, start, end);
    let span_start_line = if raw_start_line == 0 {
        NONE_U32
    } else {
        raw_start_line
    };
    let span_end_line = if raw_end_line == 0 {
        NONE_U32
    } else {
        raw_end_line
    };

    Ok(Some(RecordRow {
        record_id,
        owner_artifact,
        owner_version,
        valid_from: new_generation,
        valid_to: 0,
        category: CATEGORY_RELATION,
        kind_id,
        universal_kind_id,
        facets: materialize::facets_bitmask(&kernel_row.facets),
        span_artifact_version: owner_artifact,
        span_start_byte: kernel_row.span_start,
        span_end_byte: kernel_row.span_end,
        span_start_line,
        span_end_line,
        identity_type: 1,
        assignment_kind: 0,
        name_id,
        identity_key: kernel_row.identity_key.into_bytes(),
        record_digest,
        body_digest: kernel_row.body_digest,
        identity_id: kernel_row.identity_id,
        identity_key_digest: kernel_row.identity_key_digest,
        previous_record_id,
        source_subject,
        target_subject,
        relation_kind_id,
        body: kernel_row.body,
    }))
}

/// Decision 28's "inferred types + compiler diagnostics" task:
/// `${JAVASCRIPT_TYPESCRIPT_NAMESPACE}:inferred-type:${entity.id}:${canonicalSha256(entity.type)
/// .slice("sha256:".length)}` (`fact-delta.ts`'s `semanticTypeRecords`) --
/// `canonicalSha256(value)` is `sha256:` + hex(sha256(canonicalJson(value))),
/// and `canonicalJson` of a plain JS string is exactly `JSON.stringify`
/// (`packages/plugin-sdk/src/canonical.ts`'s `encode`, the `string` arm).
/// `serde_json::to_string` of a `&str` produces the identical escaping
/// (`"`, `\`, and control characters below `0x20`; every other byte,
/// ASCII or not, passed through verbatim) for every type string this task
/// verified against the retained v3 oracle (see this task's own report for
/// the byte-for-byte sample) -- the one theoretical divergence (a lone
/// UTF-16 surrogate in a type name, which V8's `JSON.stringify` escapes
/// specially and `serde_json` cannot even represent in a Rust `String`) is
/// not expected in any real TypeScript type text and is not observed on
/// the oracle sample.
fn type_identity_hash_hex(type_text: &str) -> String {
    use std::fmt::Write as _;
    let canonical =
        serde_json::to_string(type_text).expect("a &str always serializes to a JSON string");
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in hasher.finalize() {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// Shared "open a fresh row, or reuse the already-live one" decision every
/// kernel-canonicalized row this module builds needs (`build_confirmed_row`/
/// `try_synthesize_member_entity` each inlined their own copy before this
/// task; this is the SAME logic, factored out because the inferred-type/
/// diagnostic producers below need it applied independently to several rows
/// per declaration/diagnostic within one owner). Returns the row's final
/// `record_id` always, and `Some(RecordRow)` only when a NEW row must be
/// opened this generation (already-live-and-unchanged returns `None` for
/// the row half, so the caller's `opened_records` never grows for a
/// declaration whose type text did not change between two residual runs --
/// the task's own "never accumulate" requirement).
#[allow(clippy::too_many_arguments)]
fn finalize_kernel_row(
    kernel_row: urdira_native_core::StructuralKernelRow,
    identity_key: &str,
    category: u8,
    owner_artifact: u32,
    owner_version: u32,
    new_generation: u32,
    store: &StoreReader,
    generation: u64,
    kind_id: u16,
    universal_kind_id: u16,
    relation_kind_id: u16,
    name_id: u32,
    source_subject: Option<u32>,
    target_subject: Option<u32>,
    // A4 (line numbers task): precomputed by the caller (`build_inferred_
    // type_rows`/`build_diagnostic_row`, which each already know their own
    // `path`/`start`/`end`) rather than re-resolved here -- this function
    // has no `file_map`/`workspace_root` of its own, and both callers reuse
    // the SAME span for more than one `finalize_kernel_row` call (entity +
    // relation), so resolving once per caller invocation is strictly
    // better than once per row. Already `NONE_U32`-mapped by the caller.
    span_start_line: u32,
    span_end_line: u32,
) -> ([u8; 32], Option<RecordRow>) {
    let identity_key_digest = identity_key_digest_bytes(identity_key);
    if let Some(last) = store.by_identity_last(&identity_key_digest)
        && last.is_visible(generation)
    {
        return (last.record_id(), None);
    }
    let (record_id, record_digest, previous_record_id) =
        match store.by_identity_last(&identity_key_digest) {
            Some(last) => {
                let predecessor_id = last.record_id();
                (
                    diff::chained_record_id(&kernel_row.record_digest, &predecessor_id),
                    kernel_row.record_digest,
                    predecessor_id,
                )
            }
            None => (kernel_row.record_id, kernel_row.record_digest, [0u8; 32]),
        };
    let row = RecordRow {
        record_id,
        owner_artifact,
        owner_version,
        valid_from: new_generation,
        valid_to: 0,
        category,
        kind_id,
        universal_kind_id,
        facets: materialize::facets_bitmask(&kernel_row.facets),
        span_artifact_version: owner_artifact,
        span_start_byte: kernel_row.span_start,
        span_end_byte: kernel_row.span_end,
        span_start_line,
        span_end_line,
        identity_type: 1,
        assignment_kind: 0,
        name_id,
        identity_key: kernel_row.identity_key.into_bytes(),
        record_digest,
        body_digest: kernel_row.body_digest,
        identity_id: kernel_row.identity_id,
        identity_key_digest: kernel_row.identity_key_digest,
        previous_record_id,
        source_subject,
        target_subject,
        relation_kind_id,
        body: kernel_row.body,
    };
    (record_id, Some(row))
}

/// Result of [`build_inferred_type_rows`]: the entity/relation identities
/// (always computed, needed by the caller's own close-stale-rows diff even
/// when both rows below are `None` because they are already live) plus
/// whichever of the two rows must actually be opened this generation.
struct InferredTypeRowsResult {
    entity_identity: String,
    relation_identity: String,
    entity_row: Option<RecordRow>,
    relation_row: Option<RecordRow>,
}

/// Builds the `jsts:entity_inferred_type` + `jsts:relation_type_of` pair for
/// one typed declaration, byte-for-byte matching `fact-delta.ts`'s
/// `semanticTypeRecords` recipe (verified against a live v3 oracle row --
/// see this task's own report). `entity_id`/`entity_record_id` are the
/// ALREADY-TYPED declaration's own entity identity/record id (an existing
/// store entity, or one this same pass just synthesized via
/// `try_synthesize_member_entity`); `display_name` is `crate::
/// semantic_extras::TypedDeclarationSite::display_name` (`analyzer.ts`'s
/// `entity.qualified_name ?? entity.name`).
#[allow(clippy::too_many_arguments)]
fn build_inferred_type_rows(
    entity_id: &str,
    entity_record_id: &[u8; 32],
    display_name: &str,
    type_text: &str,
    path: &str,
    start: i32,
    end: i32,
    owner_artifact: u32,
    owner_version: u32,
    store: &StoreReader,
    generation: u64,
    new_generation: u32,
    file_map: &BTreeMap<String, String>,
    workspace_root: &str,
    line_index_cache: &mut HashMap<String, urdira_jsts_syntax_worker::LineIndex>,
    kinds_dict: &mut OrdinalDict<String>,
    universal_kinds_dict: &mut OrdinalDict<String>,
    relation_kinds_dict: &mut OrdinalDict<String>,
    names_dict: &mut OrdinalDict<String>,
    subjects_dict: &mut OrdinalDict<[u8; 32]>,
) -> Result<Option<InferredTypeRowsResult>, ScanError> {
    let type_hash = type_identity_hash_hex(type_text);
    let entity_identity = format!("jsts:inferred-type:{entity_id}:{type_hash}");
    let relation_identity = format!("jsts:type-of:{entity_id}:{entity_identity}");

    // v3's own `analysis.language` field is workspace/project-wide, not
    // per-file (confirmed live against the oracle: a `.mjs` file's own
    // `jsts:entity_inferred_type` row still carries `language:
    // "typescript"`) -- hardcoded here to match, not derived from the
    // owner's own extension.
    // A3b: strict lexicographic key order (`end`, `kind`, `language`,
    // `name`, `path`, `start`, `type`).
    let mut entity_encoder = urdira_native_core::BodyEncoder::new();
    entity_encoder
        .begin_object(7)
        .expect("inferred type entity body field count is fixed");
    entity_encoder
        .key("end")
        .expect("inferred type entity body key order");
    entity_encoder.int(i64::from(end)).expect("int never fails");
    entity_encoder
        .key("kind")
        .expect("inferred type entity body key order");
    entity_encoder
        .string("inferred_type")
        .expect("string never fails");
    entity_encoder
        .key("language")
        .expect("inferred type entity body key order");
    entity_encoder
        .string("typescript")
        .expect("string never fails");
    entity_encoder
        .key("name")
        .expect("inferred type entity body key order");
    entity_encoder
        .string(&format!("inferred type of {display_name}"))
        .expect("string never fails");
    entity_encoder
        .key("path")
        .expect("inferred type entity body key order");
    entity_encoder.string(path).expect("string never fails");
    entity_encoder
        .key("start")
        .expect("inferred type entity body key order");
    entity_encoder
        .int(i64::from(start))
        .expect("int never fails");
    entity_encoder
        .key("type")
        .expect("inferred type entity body key order");
    entity_encoder
        .string(type_text)
        .expect("string never fails");
    let entity_body = entity_encoder.finish();
    let entity_facets = canonical_json(&serde_json::json!([]));
    let span = canonical_span(path, start, end);
    let evidence = canonical_evidence(path, start, end);
    let entity_key = StructuralKernelRecordRef {
        proposal_record_key: &proposal_record_key(&entity_identity),
        category: "entity",
        kind: "jsts:entity_inferred_type",
        universal_kind: "core:type",
        facets: &entity_facets,
        schema_version: 1,
        source_span: &span,
        identity_key: &entity_identity,
        body: urdira_native_core::BodyRef::Encoded(&entity_body),
        evidence_references: &evidence,
    };

    // A3b: strict lexicographic key order (`classification`, `end`, `path`,
    // `source_id`, `start`, `target_id`).
    let mut relation_encoder = urdira_native_core::BodyEncoder::new();
    relation_encoder
        .begin_object(6)
        .expect("inferred type relation body field count is fixed");
    relation_encoder
        .key("classification")
        .expect("relation body key order");
    relation_encoder
        .string("confirmed")
        .expect("string never fails");
    relation_encoder
        .key("end")
        .expect("relation body key order");
    relation_encoder
        .int(i64::from(end))
        .expect("int never fails");
    relation_encoder
        .key("path")
        .expect("relation body key order");
    relation_encoder.string(path).expect("string never fails");
    relation_encoder
        .key("source_id")
        .expect("relation body key order");
    relation_encoder
        .string(entity_id)
        .expect("string never fails");
    relation_encoder
        .key("start")
        .expect("relation body key order");
    relation_encoder
        .int(i64::from(start))
        .expect("int never fails");
    relation_encoder
        .key("target_id")
        .expect("relation body key order");
    relation_encoder
        .string(&entity_identity)
        .expect("string never fails");
    let relation_body = relation_encoder.finish();
    let relation_facets = canonical_json(&serde_json::json!(["core:reference_relation"]));
    let relation_key = StructuralKernelRecordRef {
        proposal_record_key: &proposal_record_key(&relation_identity),
        category: "relation",
        kind: "jsts:relation_type_of",
        universal_kind: "core:type_of",
        facets: &relation_facets,
        schema_version: 1,
        source_span: &span,
        identity_key: &relation_identity,
        body: urdira_native_core::BodyRef::Encoded(&relation_body),
        evidence_references: &evidence,
    };

    let mut batches = materialize::kernel_rows_batches(&[entity_key, relation_key])?;
    let Some(kernel_rows) = batches.pop() else {
        return Ok(None);
    };
    let mut rows = kernel_rows.rows.into_iter();
    let (Some(entity_kernel), Some(relation_kernel)) = (rows.next(), rows.next()) else {
        return Ok(None);
    };

    // A4 (line numbers task): the entity/relation pair this function builds
    // always shares `span` (both `StructuralKernelRecordRef::source_span`
    // above are the SAME `canonical_span(path, start, end)`), so this is
    // resolved once and reused for both `finalize_kernel_row` calls below.
    let (raw_start_line, raw_end_line) =
        span_lines_for(line_index_cache, file_map, workspace_root, path, start, end);
    let span_start_line = if raw_start_line == 0 {
        NONE_U32
    } else {
        raw_start_line
    };
    let span_end_line = if raw_end_line == 0 {
        NONE_U32
    } else {
        raw_end_line
    };

    let entity_kind = "jsts:entity_inferred_type".to_string();
    let entity_universal_kind = "core:type".to_string();
    let entity_kind_id = u16::try_from(kinds_dict.intern(&entity_kind)).unwrap_or(u16::MAX);
    let entity_universal_kind_id =
        u16::try_from(universal_kinds_dict.intern(&entity_universal_kind)).unwrap_or(u16::MAX);
    let entity_name_id =
        names_dict.intern(&materialize::identity_key_name(&entity_identity).to_owned());
    let (entity_record_id_final, entity_row) = finalize_kernel_row(
        entity_kernel,
        &entity_identity,
        CATEGORY_ENTITY,
        owner_artifact,
        owner_version,
        new_generation,
        store,
        generation,
        entity_kind_id,
        entity_universal_kind_id,
        0,
        entity_name_id,
        None,
        None,
        span_start_line,
        span_end_line,
    );

    let target_subject = Some(subjects_dict.intern(&entity_record_id_final));
    let source_subject = Some(subjects_dict.intern(entity_record_id));

    let relation_kind = "jsts:relation_type_of".to_string();
    let relation_universal_kind = "core:type_of".to_string();
    let relation_kind_id = u16::try_from(kinds_dict.intern(&relation_kind)).unwrap_or(u16::MAX);
    let relation_universal_kind_id =
        u16::try_from(universal_kinds_dict.intern(&relation_universal_kind)).unwrap_or(u16::MAX);
    let relation_relation_kind_id =
        u16::try_from(relation_kinds_dict.intern(&relation_universal_kind)).unwrap_or(u16::MAX);
    let relation_name_id =
        names_dict.intern(&materialize::identity_key_name(&relation_identity).to_owned());
    let (_relation_record_id, relation_row) = finalize_kernel_row(
        relation_kernel,
        &relation_identity,
        CATEGORY_RELATION,
        owner_artifact,
        owner_version,
        new_generation,
        store,
        generation,
        relation_kind_id,
        relation_universal_kind_id,
        relation_relation_kind_id,
        relation_name_id,
        source_subject,
        target_subject,
        span_start_line,
        span_end_line,
    );

    Ok(Some(InferredTypeRowsResult {
        entity_identity,
        relation_identity,
        entity_row,
        relation_row,
    }))
}

/// Builds one `jsts:diagnostic` row (`code: "jsts:compiler_diagnostic"`),
/// byte-for-byte matching `fact-delta.ts`'s `proposalDiagnosticRecord`
/// recipe: identity `jsts:diagnostic:{path}:{start}:jsts:compiler_diagnostic:
/// {index}`, body `{code, compiler_code, message, path, start, end}`. Since
/// v4 has no OTHER diagnostic producer any more (P2-2i folded `jsts:
/// unresolved_call` into the `possible` relation body itself -- see this
/// module's own doc comment / decision 28's evidence page), `index` is
/// simply this owner's own compiler-diagnostic sequence number (0, 1, 2,
/// ...) -- exactly what v3's own per-file `diagnosticIndex` counter would
/// produce for a file whose ONLY diagnostic kind is `jsts:compiler_diagnostic`
/// (true for every v4 owner, since v4 never produces `jsts:unresolved_call`/
/// `jsts:dynamic_runtime_code` diagnostics), so this is not merely
/// "close enough" but the identical sequence v3 would assign.
#[allow(clippy::too_many_arguments)]
fn build_diagnostic_row(
    path: &str,
    start: i32,
    end: i32,
    compiler_code: u32,
    message: &str,
    index: usize,
    owner_artifact: u32,
    owner_version: u32,
    store: &StoreReader,
    generation: u64,
    new_generation: u32,
    file_map: &BTreeMap<String, String>,
    workspace_root: &str,
    line_index_cache: &mut HashMap<String, urdira_jsts_syntax_worker::LineIndex>,
    kinds_dict: &mut OrdinalDict<String>,
    universal_kinds_dict: &mut OrdinalDict<String>,
    names_dict: &mut OrdinalDict<String>,
) -> Result<Option<(String, Option<RecordRow>)>, ScanError> {
    let identity_key = format!("jsts:diagnostic:{path}:{start}:jsts:compiler_diagnostic:{index}");
    // A3b: strict lexicographic key order (`code`, `compiler_code`, `end`,
    // `message`, `path`, `start`).
    let mut encoder = urdira_native_core::BodyEncoder::new();
    encoder
        .begin_object(6)
        .expect("diagnostic body field count is fixed");
    encoder.key("code").expect("diagnostic body key order");
    encoder
        .string("jsts:compiler_diagnostic")
        .expect("string never fails");
    encoder
        .key("compiler_code")
        .expect("diagnostic body key order");
    encoder
        .uint(u64::from(compiler_code))
        .expect("compiler_code is a finite u32");
    encoder.key("end").expect("diagnostic body key order");
    encoder.int(i64::from(end)).expect("int never fails");
    encoder.key("message").expect("diagnostic body key order");
    encoder.string(message).expect("string never fails");
    encoder.key("path").expect("diagnostic body key order");
    encoder.string(path).expect("string never fails");
    encoder.key("start").expect("diagnostic body key order");
    encoder.int(i64::from(start)).expect("int never fails");
    let body = encoder.finish();
    let facets = canonical_json(&serde_json::json!([]));
    let span = canonical_span(path, start, end);
    let evidence = canonical_evidence(path, start, end);
    let record_key = StructuralKernelRecordRef {
        proposal_record_key: &proposal_record_key(&identity_key),
        category: "diagnostic",
        kind: "jsts:diagnostic",
        universal_kind: "core:construct",
        facets: &facets,
        schema_version: 1,
        source_span: &span,
        identity_key: &identity_key,
        body: urdira_native_core::BodyRef::Encoded(&body),
        evidence_references: &evidence,
    };
    let mut batches = materialize::kernel_rows_batches(std::slice::from_ref(&record_key))?;
    let Some(kernel_rows) = batches.pop() else {
        return Ok(None);
    };
    let Some(kernel_row) = kernel_rows.rows.into_iter().next() else {
        return Ok(None);
    };

    let kind = "jsts:diagnostic".to_string();
    let universal_kind = "core:construct".to_string();
    let kind_id = u16::try_from(kinds_dict.intern(&kind)).unwrap_or(u16::MAX);
    let universal_kind_id =
        u16::try_from(universal_kinds_dict.intern(&universal_kind)).unwrap_or(u16::MAX);
    let name_id = names_dict.intern(&materialize::identity_key_name(&identity_key).to_owned());

    // A4 (line numbers task): `path`/`start`/`end` are this diagnostic's own
    // owner file and UTF-16 span.
    let (raw_start_line, raw_end_line) =
        span_lines_for(line_index_cache, file_map, workspace_root, path, start, end);
    let span_start_line = if raw_start_line == 0 {
        NONE_U32
    } else {
        raw_start_line
    };
    let span_end_line = if raw_end_line == 0 {
        NONE_U32
    } else {
        raw_end_line
    };

    let (_record_id, row) = finalize_kernel_row(
        kernel_row,
        &identity_key,
        CATEGORY_DIAGNOSTIC,
        owner_artifact,
        owner_version,
        new_generation,
        store,
        generation,
        kind_id,
        universal_kind_id,
        0,
        name_id,
        None,
        None,
        span_start_line,
        span_end_line,
    );
    Ok(Some((identity_key, row)))
}

/// A2 (pending.sites migration): the invariant this module's diagnostic
/// tooling checks, REDEFINED from P1-D-g's original identity-text-vs-
/// `target_subject` rule (`is_classification_consistent`'s pre-A2 form,
/// preserved in this doc comment's own git history) to the simpler
/// invariant this migration establishes: after A2, NO visible `core:call`/
/// `core:inherits`/`core:implements` relation record may exist without a
/// resolved `target_subject` at all -- a no-target relation record cannot
/// be PRODUCED any more (`analyze.rs` never adds one to `owner.records`),
/// and a confirmed-shaped-but-uninterned one is DROPPED at materialize time
/// (`materialize.rs`'s `plan_relation_repair`) rather than published
/// inconsistently. `is_classification_consistent` therefore now IS simply
/// `target_subject_is_some` -- kept as its own named predicate (rather than
/// inlined at each call site) purely so `count_classification_mismatches`'s
/// intent stays self-documenting, and so a future regression shows up as a
/// one-line diff here instead of a scattered inline check. The choice made
/// for this task's own "delete vs. keep as invariant" question: KEPT, as an
/// invariant (not deleted) -- both this predicate and `count_classification_
/// mismatches` still have real callers (the n8n debug histogram test, the
/// `dump_remaining_classification_mismatches` diagnostic, and this module's
/// own unit tests), and a permanent "prove it never regresses" check is
/// strictly more valuable now that the underlying bug class this task fixes
/// is exactly "a relation record without a target somehow existing".
fn is_classification_consistent(target_subject_is_some: bool) -> bool {
    target_subject_is_some
}

/// Store-wide scan: counts every visible `core:call`/`core:inherits`/
/// `core:implements` relation row where [`is_classification_consistent`]
/// returns `false` -- after A2, this should always be exactly zero (see
/// that function's own doc comment for why). Metadata-only (no body
/// decode), so this runs cheaply even at n8n scale.
fn count_classification_mismatches(
    store: &StoreReader,
    dicts: &Dictionaries,
    generation: u64,
) -> u64 {
    let mut mismatches = 0u64;
    for view in store.iter_visible(generation) {
        if view.category() != CATEGORY_RELATION {
            continue;
        }
        let universal_kind = dicts
            .universal_kinds
            .get(view.universal_kind_id() as usize)
            .map(String::as_str)
            .unwrap_or("");
        if !matches!(
            universal_kind,
            "core:call" | "core:inherits" | "core:implements"
        ) {
            continue;
        }
        if !is_classification_consistent(view.target_subject().is_some()) {
            mismatches += 1;
        }
    }
    mismatches
}

/// The two families [`classify_confirmed_possible`] distinguishes: v4's
/// checker-free structural lane can only ever produce a call site or a
/// heritage (`extends`/`implements`) site as pending/possible -- every
/// other relation kind is out of scope for this classification.
/// `#[cfg(test)]`: both this task's call sites (`print_confirmed_possible_
/// histogram` here, `tests_e2e.rs`'s `inspect_store_record_histogram`) are
/// `#[ignore]`d manual diagnostics, not production code -- see `collect`'s
/// own doc comment for the actual production ground truth
/// (`pending.sites`), which this classification does not feed.
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SiteFamily {
    Call,
    Heritage,
}

/// Plan 3.4 (this task): the ONE classification `print_confirmed_possible_
/// histogram` below and `tests_e2e.rs`'s `inspect_store_record_histogram`
/// both trust to split a visible `core:call`/`core:inherits`/`core:
/// implements` relation record into "confirmed" or "possible" -- extracted
/// here (rather than reimplemented a second time in `tests_e2e.rs`, which
/// used to duplicate it purely because `residual` was otherwise opaque to
/// it) so both call sites can never drift apart again.
///
/// `target_subject().is_some()` alone does NOT distinguish confirmed from
/// possible: P2-2i (2026-09-04) started emitting a relation record with
/// `classification: "possible"` for every pending call/heritage site TOO,
/// each carrying its own tentative `target_subject` -- tagged separately
/// via the `core:indirect` facet bit (`materialize.rs`'s `FACET_ORDER`
/// assigns the bit; a P2-2j candidate row always carries it).
/// A row with no `target_subject` at all should not exist any more for
/// these three kinds post-A2 ([`is_classification_consistent`]'s own
/// invariant), so this only needs to separate "has a target and is not
/// tagged possible" (confirmed) from "has a target and IS tagged possible"
/// (possible); a target-less row is treated as possible too, defensively,
/// rather than panicking on an invariant this function does not itself
/// enforce.
///
/// Returns `None` for anything outside `CATEGORY_RELATION` or these three
/// universal kinds.
#[cfg(test)]
pub(crate) fn classify_confirmed_possible(
    view: &urdira_structural_store::RecordView,
    dicts: &Dictionaries,
) -> Option<(SiteFamily, bool)> {
    if view.category() != CATEGORY_RELATION {
        return None;
    }
    let universal_kind = dicts
        .universal_kinds
        .get(view.universal_kind_id() as usize)
        .map(String::as_str)
        .unwrap_or("");
    let family = match universal_kind {
        "core:call" => SiteFamily::Call,
        "core:inherits" | "core:implements" => SiteFamily::Heritage,
        _ => return None,
    };
    let indirect_bit = dicts
        .facet_names
        .iter()
        .position(|name| name == "core:indirect");
    let is_candidate = indirect_bit
        .map(|bit| (view.facets() & (1u64 << bit)) != 0)
        .unwrap_or(false);
    let confirmed = view.target_subject().is_some() && !is_candidate;
    Some((family, confirmed))
}

/// P1-D-d deliverable 1: an opt-in (`URDIRA_V4_RESIDUAL_DEBUG=1`) reason
/// histogram + a bounded sample dump for one residual pass, printed to
/// stderr right before the upgrade batch is published. Never allocated
/// (the whole struct stays `None`) unless the env var is set -- zero cost
/// on every other run, including every existing test and the n8n
/// measurement runs that do not opt in.
///
/// Bucket names (the ones this module can actually distinguish, given
/// `ResidualResolver`'s own reason strings -- see `resolver.rs`'s
/// `resolve_via_symbol`/`resolve_symbol_to_declaration`/`resolve_handle`/
/// `resolve_call`):
/// - `no_symbol` -- `getSymbolAtLocation`/`getSymbolsAtLocations` found
///   nothing at the site (or, for a call, neither the direct-declaration
///   shortcut nor `getResolvedSignature` nor the callee's own symbol
///   produced a target).
/// - `symbol_no_declaration` -- a symbol was found but it (or its aliased
///   target) carries no `valueDeclaration`/`declarations[0]` at all.
/// - `declaration_outside_workspace` -- the resolved declaration's own
///   file is not one `get_source_file` can serve for this project (a
///   real declaration exists, but not in a file this pass's `VirtualFs`
///   covers).
/// - `declaration_text_unavailable` / `declaration_node_out_of_range` /
///   `malformed_handle` / `owner_file_not_in_project` /
///   `owner_file_text_unavailable` / `rpc_error` -- rarer failure modes,
///   each mirroring one specific early-return in `resolver.rs`.
/// - `entity_index_miss` -- `ResidualResolver` DID resolve a real
///   workspace declaration (`SiteOutcome::WorkspaceTarget`), but this
///   module's own `(path, name_start_utf16)` -> entity id index
///   (`collect`'s `entity_entries`) has no entry at that exact key --
///   never a resolver failure, always a correlation failure on this
///   module's own side (see this module's doc comment on why a
///   case-insensitive-filesystem host is the leading suspect).
/// - `entity_index_dangling` -- an entity id WAS found, but the record it
///   names is no longer visible at `publish_generation` (a concurrent
///   edit raced the pass; expected to be rare, not a bug in itself).
/// - `external_lib` -- resolved to a `lib.*.d.ts` global.
///
/// Follow-up to the "inferred types + compiler diagnostics" task: prints,
/// gated behind `URDIRA_V4_RESIDUAL_DEBUG`, (1) the top 15 `compiler_code`
/// values across every `DiagnosticSite` this pass just collected (count +
/// one sample message each), and (2) how many `(owner_path, start, end,
/// compiler_code)` groups appear MORE THAN ONCE across the three
/// concatenated sources (`getSyntacticDiagnostics`/`getBindDiagnostics`/
/// `getSemanticDiagnostics`) -- a direct measurement of whether the three
/// sources genuinely overlap for the same reported error, which was the
/// leading hypothesis for v4's diagnostic count coming out several times
/// v3's own ~60k. Deliberately does NOT deduplicate the actual output
/// (`build_diagnostic_row`'s own per-owner sequential `index` is
/// unaffected by this function) -- v3's own `analyzer.ts` recipe
/// (`[...syntactic, ...bind, ...semantic]`, `~1401`) concatenates the three
/// sources WITHOUT deduplicating either, so removing overlap here would
/// make v4 diverge FROM v3, not match it more closely; this is a
/// measurement tool, not a filter.
fn print_diagnostic_code_histogram(
    diagnostics: &[urdira_tsgo_client::residual_pass::DiagnosticResult],
) {
    use std::collections::HashMap;
    let mut by_code: HashMap<u32, (u64, String)> = HashMap::new();
    let mut by_site: HashMap<(String, i32, i32, u32), u64> = HashMap::new();
    for entry in diagnostics {
        let code = entry.site.compiler_code;
        let bucket = by_code
            .entry(code)
            .or_insert((0, entry.site.message.clone()));
        bucket.0 += 1;
        *by_site
            .entry((
                entry.owner_path.clone(),
                entry.site.start,
                entry.site.end,
                code,
            ))
            .or_insert(0) += 1;
    }
    let mut ranked: Vec<(u32, u64, String)> = by_code
        .into_iter()
        .map(|(code, (count, sample))| (code, count, sample))
        .collect();
    ranked.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    eprintln!(
        "[urdira-indexing-worker] v4 residual debug: diagnostic total={} distinct_codes={}",
        diagnostics.len(),
        ranked.len(),
    );
    for (code, count, sample) in ranked.iter().take(15) {
        let truncated: String = sample.chars().take(160).collect();
        eprintln!(
            "[urdira-indexing-worker] v4 residual debug: diagnostic_code TS{code} count={count} sample={truncated:?}"
        );
    }
    let duplicate_groups = by_site.values().filter(|&&count| count > 1).count();
    let duplicate_extra_rows: u64 = by_site
        .values()
        .filter(|&&count| count > 1)
        .map(|&count| count - 1)
        .sum();
    eprintln!(
        "[urdira-indexing-worker] v4 residual debug: diagnostic (owner,start,end,code) groups with >1 occurrence across the 3 sources: {duplicate_groups} groups, {duplicate_extra_rows} extra rows beyond the first"
    );
}

struct ResidualDebug {
    counts: BTreeMap<&'static str, u64>,
    /// Per-bucket, not one global FIFO -- a corpus-scale run's alphabetical
    /// owner-path traversal can fill a single global cap entirely with
    /// samples from just the first few (alphabetically early) buckets that
    /// happen to occur before any other bucket ever fires (confirmed live
    /// at n8n scale: a global 50-sample cap saw zero `rpc_error` samples
    /// even though that bucket alone had 219,348 hits), which would hide
    /// exactly the outcome a human needs to see least.
    samples: BTreeMap<&'static str, Vec<String>>,
    /// P1-D-f deliverable 1: an OPTIONAL, uncapped, one-line-per-site NDJSON
    /// (well, TSV -- cheaper to write/parse than JSON at n8n scale, and
    /// `scripts/v4-call-parity-diff.mjs` is the only consumer) dump of EVERY
    /// `ResolvedSite` this pass produced, not just the 10-per-bucket sample
    /// above. Opened only when `URDIRA_V4_RESIDUAL_SITE_DUMP=<path>` is set
    /// (independent of `URDIRA_V4_RESIDUAL_DEBUG` -- a caller doing the
    /// v3/v4 parity diff wants this file but does not need the histogram
    /// printed to stderr too, and vice versa). Columns: `owner_path\t
    /// start_utf16\tend_utf16\tsite_kind\tbucket\treason` (`reason` is the
    /// raw, unbucketed string for `Unresolved`, the resolved symbol/lib name
    /// for `External`, empty for `WorkspaceTarget` since that site's own
    /// final disposition -- `upgraded`/`entity_index_miss`/
    /// `confirmed_row_build_failed` -- is decided later, in the materialize
    /// loop, and is instead recoverable from the v4 CONFIRMED/POSSIBLE body
    /// dump the diff script also reads: a `WorkspaceTarget` site that never
    /// became a confirmed row stayed possible for one of those three
    /// reasons, distinguishable there by whether an entity or a relation
    /// build step is the one that failed).
    full_dump: Option<std::io::BufWriter<std::fs::File>>,
}

const RESIDUAL_DEBUG_SAMPLE_CAP_PER_BUCKET: usize = 10;

/// Buckets one `Resolution`/`SiteOutcome::Unresolved` reason string into a
/// small, fixed set of categories -- see `ResidualDebug`'s own doc comment
/// for what each one means and which `resolver.rs` call site produces it.
fn bucket_reason(reason: &str) -> &'static str {
    if reason.contains("no symbol at location") || reason.contains("no unique call target") {
        "no_symbol"
    } else if reason.contains("symbol has no declaration") {
        "symbol_no_declaration"
    } else if reason.contains("declaration file not in project") {
        "declaration_outside_workspace"
    } else if reason.contains("declaration file text unavailable") {
        "declaration_text_unavailable"
    } else if reason.contains("declaration node index out of range") {
        "declaration_node_out_of_range"
    } else if reason.contains("malformed declaration handle") {
        "malformed_handle"
    } else if reason.contains("owner file not in project") {
        "owner_file_not_in_project"
    } else if reason.contains("owner file text unavailable") {
        "owner_file_text_unavailable"
    } else if reason.contains("getSymbolsAtLocations failed") {
        "rpc_error"
    } else {
        "other_unresolved"
    }
}

/// Decodes the UTF-16 code units `[start, end)` of `text` (a plain UTF-8
/// `String`, as stored in `run_once_with_quiet_period`'s own `file_map`)
/// back to a `String`, for the debug dump's "what does the stored span
/// actually point at" column -- lets a human eyeball whether a span looks
/// like a real call/heritage expression or garbage (the tell for an
/// offset-unit bug, if one existed). Best-effort: an out-of-range or
/// non-boundary span returns a diagnostic placeholder rather than
/// panicking, since this is debug-only tooling running over untrusted
/// (to this function) offsets.
fn utf16_slice(text: &str, start: i32, end: i32) -> String {
    if start < 0 || end < start {
        return format!("<invalid span {start}..{end}>");
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let (start, end) = (start as usize, end as usize);
    if end > units.len() {
        return format!("<out of range {start}..{end} of {} units>", units.len());
    }
    let slice = &units[start..end];
    let text = String::from_utf16_lossy(slice);
    let mut text: String = text.chars().filter(|c| *c != '\n' && *c != '\r').collect();
    const CHAR_CAP: usize = 96;
    if text.chars().count() > CHAR_CAP {
        text = text.chars().take(CHAR_CAP).collect();
        text.push('…');
    }
    text
}

impl ResidualDebug {
    /// `site_dump_path` is `URDIRA_V4_RESIDUAL_SITE_DUMP`'s value, if set --
    /// see `full_dump`'s own doc comment. Panics on an unwritable path: this
    /// is opt-in diagnostic tooling, not a production code path, and a
    /// silent no-op here would be far more confusing than a loud failure.
    fn new(site_dump_path: Option<&str>) -> Self {
        let full_dump = site_dump_path.map(|path| {
            let file = std::fs::File::create(path).unwrap_or_else(|error| {
                panic!("create URDIRA_V4_RESIDUAL_SITE_DUMP file {path}: {error}")
            });
            std::io::BufWriter::new(file)
        });
        Self {
            counts: BTreeMap::new(),
            samples: BTreeMap::new(),
            full_dump,
        }
    }

    fn record_bucket(&mut self, bucket: &'static str) {
        *self.counts.entry(bucket).or_insert(0) += 1;
    }

    fn push_sample(&mut self, bucket: &'static str, line: String) {
        let bucket_samples = self.samples.entry(bucket).or_default();
        if bucket_samples.len() < RESIDUAL_DEBUG_SAMPLE_CAP_PER_BUCKET {
            bucket_samples.push(line);
        }
    }

    /// Writes one TSV line to `full_dump`, if open -- a no-op otherwise
    /// (every call site here still runs the histogram/sample bookkeeping
    /// unconditionally, so this stays cheap and optional). `owner_path` here
    /// is `run_once_with_quiet_period`'s virtual (absolute) path, the SAME
    /// value `build_confirmed_row`/`try_synthesize_member_entity` strip the
    /// `{workspace_root}/` prefix from -- `scripts/v4-call-parity-diff.mjs`
    /// does the identical strip before joining against the v3/v4 workspace-
    /// relative path.
    fn write_full(
        &mut self,
        owner_path: &str,
        start_utf16: i32,
        end_utf16: i32,
        site_kind: SiteKind,
        bucket: &str,
        reason: &str,
    ) {
        let Some(writer) = self.full_dump.as_mut() else {
            return;
        };
        use std::io::Write;
        let kind = match site_kind {
            SiteKind::Call => "call",
            SiteKind::Heritage => "heritage",
            SiteKind::IdentifierRef => "identifier_ref",
        };
        // Best-effort: a full corpus-scale dump (~600K lines) failing on one
        // line's `write!` (e.g. a transient disk-full) should not panic a
        // pass that has already done the expensive checker work -- the
        // histogram/sample data printed via `print()` remains correct
        // either way, and a truncated dump file is still diagnosable.
        let _ = writeln!(
            writer,
            "{owner_path}\t{start_utf16}\t{end_utf16}\t{kind}\t{bucket}\t{reason}"
        );
    }

    /// First pass, over every `ResolvedSite` `ResidualPass::run` produced
    /// (before this module's own entity-index correlation): buckets
    /// `External`/`Unresolved` directly, and counts `WorkspaceTarget`
    /// under a provisional bucket (refined into `upgraded`/
    /// `entity_index_miss`/`entity_index_dangling` later, in the
    /// materialize loop, since only that loop knows the outcome of the
    /// entity-index lookup).
    fn record_pass(&mut self, resolved: &[ResolvedSite], file_map: &BTreeMap<String, String>) {
        for site in resolved {
            match &site.outcome {
                SiteOutcome::WorkspaceTarget { path, .. } => {
                    self.record_bucket("workspace_target_pre_entity_lookup");
                    let _ = path; // refined per-site in the materialize loop
                    self.write_full(
                        &site.owner_path,
                        site.start_utf16,
                        site.end_utf16,
                        site.site_kind,
                        "workspace_target_pre_entity_lookup",
                        "",
                    );
                }
                SiteOutcome::External {
                    symbol_name,
                    lib_file,
                } => {
                    self.record_bucket("external_lib");
                    let stored = file_map
                        .get(&site.owner_path)
                        .map(|text| utf16_slice(text, site.start_utf16, site.end_utf16))
                        .unwrap_or_default();
                    self.push_sample("external_lib", format!(
                        "external_lib\towner={}\tspan_utf16={}..{}\ttext={stored:?}\tsymbol={symbol_name}\tlib={lib_file}",
                        site.owner_path, site.start_utf16, site.end_utf16,
                    ));
                    self.write_full(
                        &site.owner_path,
                        site.start_utf16,
                        site.end_utf16,
                        site.site_kind,
                        "external_lib",
                        &format!("symbol={symbol_name} lib={lib_file}"),
                    );
                }
                SiteOutcome::Unresolved { reason } => {
                    let bucket = bucket_reason(reason);
                    self.record_bucket(bucket);
                    let stored = file_map
                        .get(&site.owner_path)
                        .map(|text| utf16_slice(text, site.start_utf16, site.end_utf16))
                        .unwrap_or_default();
                    self.push_sample(bucket, format!(
                        "{bucket}\towner={}\tspan_utf16={}..{}\ttext={stored:?}\treason={reason}",
                        site.owner_path, site.start_utf16, site.end_utf16,
                    ));
                    self.write_full(
                        &site.owner_path,
                        site.start_utf16,
                        site.end_utf16,
                        site.site_kind,
                        bucket,
                        reason,
                    );
                }
            }
        }
        if let Some(writer) = self.full_dump.as_mut() {
            use std::io::Write;
            let _ = writer.flush();
        }
    }

    /// Second pass, called from the materialize loop for every
    /// `WorkspaceTarget` site whose entity-index lookup returned `None` --
    /// records the exact `(target_path, name_start_utf16)` key that
    /// missed, so a human can grep the entity index's own keys for a
    /// near-match (case, prefix, trailing-slash, ...).
    #[allow(clippy::too_many_arguments)]
    fn record_entity_index_miss(
        &mut self,
        owner_store_path: &str,
        start_utf16: i32,
        end_utf16: i32,
        target_store_path: &str,
        name_start_utf16: i32,
        kind_hint: u32,
    ) {
        self.record_bucket("entity_index_miss");
        self.push_sample("entity_index_miss", format!(
            "entity_index_miss\towner={owner_store_path}\tspan_utf16={start_utf16}..{end_utf16}\ttarget_path={target_store_path}\tname_start_utf16={name_start_utf16}\tdecl_kind={kind_hint}",
        ));
    }

    fn print(&self) {
        eprintln!("[urdira-indexing-worker] v4 residual debug: reason histogram");
        for (bucket, count) in &self.counts {
            eprintln!("  {bucket:36} {count}");
        }
        let total_samples: usize = self.samples.values().map(Vec::len).sum();
        eprintln!(
            "[urdira-indexing-worker] v4 residual debug: {total_samples} samples (cap {RESIDUAL_DEBUG_SAMPLE_CAP_PER_BUCKET} per bucket, {} buckets sampled)",
            self.samples.len()
        );
        for (bucket, lines) in &self.samples {
            eprintln!("  -- {bucket} ({} of this bucket shown) --", lines.len());
            for sample in lines {
                eprintln!("  {sample}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v4::{catalog, scan, state::WorkerState};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use urdira_jsts_syntax_worker::SyntaxWorkerState;
    use urdira_worker_protocol::ScanPriority;

    #[test]
    fn decode_hex32_round_trips_hex_encode() {
        let bytes: [u8; 32] = std::array::from_fn(|i| i as u8);
        let hex = materialize::hex_encode(&bytes);
        assert_eq!(decode_hex32(&hex), Some(bytes));
    }

    #[test]
    fn decode_hex32_rejects_wrong_length() {
        assert_eq!(decode_hex32("abcd"), None);
    }

    #[test]
    fn correlation_key_distinguishes_call_and_heritage_at_the_same_span() {
        let call = correlation_key("a.ts", 10, 20, SiteKind::Call);
        let heritage = correlation_key("a.ts", 10, 20, SiteKind::Heritage);
        assert_ne!(call, heritage);
    }

    #[test]
    fn canonical_span_and_evidence_match_the_v3_shape() {
        assert_eq!(
            canonical_span("a.ts", 1, 2),
            r#"{"end":2,"path":"a.ts","start":1}"#
        );
        assert_eq!(
            canonical_evidence("a.ts", 1, 2),
            r#"[{"end":2,"path":"a.ts","start":1}]"#
        );
    }

    #[test]
    fn proposal_record_key_is_deterministic_and_domain_prefixed() {
        let key = proposal_record_key("jsts:call:a.ts:1:2:src:dst");
        assert!(key.starts_with("jsts:record:sha256:"));
        assert_eq!(key, proposal_record_key("jsts:call:a.ts:1:2:src:dst"));
    }

    // A2 (pending.sites migration): `is_classification_consistent` is now
    // simply `target_subject_is_some` -- exercised directly here with a
    // plain bool input, no store or fixture needed. Kept as its own test
    // (not folded into a single trivial assertion) so a future regression
    // of the predicate's OWN definition still shows up as a named test
    // failure.
    #[test]
    fn classification_consistent_when_target_subject_is_some() {
        assert!(is_classification_consistent(true));
    }

    #[test]
    fn classification_inconsistent_when_target_subject_is_none() {
        // A2's own invariant: after this migration, no visible relation
        // record may exist without a resolved `target_subject` at all.
        assert!(!is_classification_consistent(false));
    }

    /// Plan 3.4: `classify_confirmed_possible` is now the ONE definition
    /// both `print_confirmed_possible_histogram` (this module) and
    /// `tests_e2e.rs`'s `inspect_store_record_histogram` call -- which
    /// trivially makes their two call sites agree with EACH OTHER by
    /// construction, but says nothing about whether the shared function
    /// itself still computes what both of them independently reasoned it
    /// should. This test is that independent check: it re-derives the
    /// confirmed/possible split for every visible relation record in a
    /// real cold-scanned store via a SEPARATE, deliberately-duplicated-
    /// only-here reimplementation of the pre-extraction logic (the exact
    /// two ad hoc versions this task's own evidence found had already
    /// started to drift -- see `classify_confirmed_possible`'s own doc
    /// comment), and asserts the shared function agrees on every single
    /// record. A future edit to `classify_confirmed_possible` that
    /// silently changes its semantics fails this test, not just a manual
    /// eyeball of two `eprintln!`s.
    #[test]
    fn classify_confirmed_possible_matches_an_independently_reasoned_reimplementation() {
        let scratch = scratch_dir("classify-parity");
        let workspace_root = fixture_root();
        assert!(
            workspace_root.is_dir(),
            "shared fixture missing at {workspace_root:?}"
        );
        let database_path = scratch.join("workspace.sqlite");
        let structural_root = scratch.join("structural");
        let cas_root = scratch.join("cas");
        let request = scan::ScanRequest {
            request_id: "request:classify-confirmed-possible-parity".to_string(),
            workspace_id: "workspace:classify-confirmed-possible-parity".to_string(),
            workspace_root: workspace_root.to_string_lossy().into_owned(),
            database_path: database_path.to_string_lossy().into_owned(),
            structural_root: structural_root.to_string_lossy().into_owned(),
            cas_root: cas_root.to_string_lossy().into_owned(),
            sidecar_root: scratch.join("sidecar").to_string_lossy().into_owned(),
            scope: urdira_worker_protocol::ScanScope::Full,
            registry_snapshot_id: "registry:classify-confirmed-possible-parity".to_string(),
            configuration_revision_id: "configuration:classify-confirmed-possible-parity"
                .to_string(),
            resolution_lock_id: "resolution:classify-confirmed-possible-parity".to_string(),
            deadline_ms: None,
            priority: ScanPriority::Interactive,
        };
        let mut syntax = SyntaxWorkerState::default();
        let mut worker_state: WorkerState = WorkerState::default();
        let mut on_queryable = |_event: IndexingEvent| -> Result<(), String> { Ok(()) };
        // Residual is opt-in (`URDIRA_V4_RESIDUAL`, default off) -- this
        // deliberately exercises the cold-only classification (both
        // confirmed rows the cold producer emits directly and possible/
        // candidate rows it emits for pending sites), not the post-
        // residual-upgrade population; the classification rule under test
        // does not depend on which generation produced a row.
        let cold_event = scan::run_with_residual(
            request,
            &mut syntax,
            &mut worker_state,
            &mut on_queryable,
            None,
        )
        .expect("cold scan succeeds");
        let generation = match cold_event {
            IndexingEvent::ScanCompleted { generation, .. } => generation,
            other => panic!("expected ScanCompleted, got {other:?}"),
        };

        let store = StoreReader::open(&structural_root).expect("store reopens");
        let dicts = store.dictionaries();
        let indirect_bit = dicts
            .facet_names
            .iter()
            .position(|name| name == "core:indirect")
            .expect("FACET_ORDER (materialize.rs) always registers core:indirect");
        let mut checked = 0u64;
        for view in store.iter_visible(generation) {
            // Independent reimplementation (route B): the exact rule
            // `print_confirmed_possible_histogram` used before this task
            // extracted `classify_confirmed_possible` out of it, written
            // fresh here rather than copy-pasted, on purpose.
            let expected = if view.category() != CATEGORY_RELATION {
                None
            } else {
                let universal_kind = dicts
                    .universal_kinds
                    .get(view.universal_kind_id() as usize)
                    .map(String::as_str)
                    .unwrap_or("");
                let family = match universal_kind {
                    "core:call" => Some(SiteFamily::Call),
                    "core:inherits" | "core:implements" => Some(SiteFamily::Heritage),
                    _ => None,
                };
                family.map(|family| {
                    let is_candidate = (view.facets() & (1u64 << indirect_bit)) != 0;
                    (family, view.target_subject().is_some() && !is_candidate)
                })
            };
            // Route A: the shared function both production call sites use.
            let actual = classify_confirmed_possible(&view, &dicts);
            assert_eq!(
                expected,
                actual,
                "classify_confirmed_possible disagreed with the independent reimplementation for record {:?}",
                view.identity_key(),
            );
            checked += 1;
        }
        // The shared task-planner fixture is known (see the sibling e2e
        // test above) to produce both call and heritage sites, confirmed
        // and possible -- a `checked == 0` run would mean this test
        // silently exercised nothing.
        assert!(checked > 0, "expected at least one visible record");
    }

    /// F4 4.3: `collect()`'s two entity-index strategies must agree on
    /// every lookup a residual pass could ever make, driven from the SAME
    /// cold-scanned store -- `force_scan=false` (default, the persisted
    /// `entities.index` section) against `force_scan=true` (the pre-4.3
    /// full `iter_visible` scan, kept only for this comparison). Also
    /// confirms the OTHER half of `Collected` (`pending_by_owner`) is
    /// completely unaffected by which entity strategy ran alongside it.
    #[test]
    fn entities_index_section_and_scan_agree_on_the_shared_fixture() {
        let scratch = scratch_dir("entities-index-parity");
        let workspace_root = fixture_root();
        assert!(
            workspace_root.is_dir(),
            "shared fixture missing at {workspace_root:?}"
        );
        let database_path = scratch.join("workspace.sqlite");
        let structural_root = scratch.join("structural");
        let cas_root = scratch.join("cas");
        let workspace_id = "workspace:entities-index-parity".to_string();
        let request = scan::ScanRequest {
            request_id: "request:entities-index-parity".to_string(),
            workspace_id: workspace_id.clone(),
            workspace_root: workspace_root.to_string_lossy().into_owned(),
            database_path: database_path.to_string_lossy().into_owned(),
            structural_root: structural_root.to_string_lossy().into_owned(),
            cas_root: cas_root.to_string_lossy().into_owned(),
            sidecar_root: scratch.join("sidecar").to_string_lossy().into_owned(),
            scope: urdira_worker_protocol::ScanScope::Full,
            registry_snapshot_id: "registry:entities-index-parity".to_string(),
            configuration_revision_id: "configuration:entities-index-parity".to_string(),
            resolution_lock_id: "resolution:entities-index-parity".to_string(),
            deadline_ms: None,
            priority: ScanPriority::Interactive,
        };
        let mut syntax = SyntaxWorkerState::default();
        let mut worker_state: WorkerState = WorkerState::default();
        let mut on_queryable = |_event: IndexingEvent| -> Result<(), String> { Ok(()) };
        let cold_event = scan::run_with_residual(
            request,
            &mut syntax,
            &mut worker_state,
            &mut on_queryable,
            None,
        )
        .expect("cold scan succeeds");
        let generation = match cold_event {
            IndexingEvent::ScanCompleted { generation, .. } => generation,
            other => panic!("expected ScanCompleted, got {other:?}"),
        };

        let store = StoreReader::open(&structural_root).expect("store opens");
        let dicts = store.dictionaries();
        let conn = catalog::open_and_ensure_schema(&database_path).expect("catalog opens");
        let frontier = Frontier::load(&conn, &workspace_id).expect("frontier loads");
        drop(conn);
        let mut path_by_pair: HashMap<(String, String), String> = HashMap::new();
        for (path, entry) in &frontier.present {
            path_by_pair.insert(
                (entry.artifact_id.clone(), entry.artifact_version_id.clone()),
                path.clone(),
            );
        }
        let owner_path = |ordinal: u32| -> Option<String> {
            dicts
                .artifacts
                .get(ordinal as usize)
                .and_then(|pair| path_by_pair.get(pair))
                .cloned()
        };

        let via_section = collect(&store, &dicts, &owner_path, &frontier, generation, false);
        let via_scan = collect(&store, &dicts, &owner_path, &frontier, generation, true);

        // The pending-site half of `Collected` does not depend on the
        // entity-index strategy at all -- same owners, same counts.
        let section_pending: usize = via_section.pending_by_owner.values().map(Vec::len).sum();
        let scan_pending: usize = via_scan.pending_by_owner.values().map(Vec::len).sum();
        assert_eq!(section_pending, scan_pending);
        assert_eq!(
            via_section.pending_by_owner.keys().collect::<Vec<_>>(),
            via_scan.pending_by_owner.keys().collect::<Vec<_>>()
        );

        // Every live, non-inferred-type entity in the store must resolve
        // to the SAME record_id through both strategies -- grouped by
        // `(path, start)` first (rather than asserted per-view directly)
        // because this fixture, like any real corpus, has a handful of
        // GENUINE key collisions (more than one visible entity reporting
        // the same `(owner, span_start)`, e.g. every top-level declaration
        // in a file whose `push_entity` recipe reports `start == 0` for
        // some kind this fixture happens to exercise) -- an existing,
        // orthogonal imprecision this task does not fix (see `StoreReader::
        // entity_by_owner_and_start`'s own doc comment on "first visible
        // wins, silently"). For an AMBIGUOUS key, `EntityIndex::build`'s
        // hash-map insertion order and `entities.index`'s own `sort_
        // unstable` tie-order need not agree on WHICH candidate wins --
        // this test only requires each strategy's pick to be SOME live
        // candidate for that key, not a specific one; only an
        // UNAMBIGUOUS key (exactly one live entity) is checked for exact
        // agreement with the known-correct record_id.
        let inferred_type_kind_id = dicts
            .kinds
            .iter()
            .position(|k| k == "jsts:entity_inferred_type");
        let mut candidates_by_key: HashMap<(String, i32), Vec<[u8; 32]>> = HashMap::new();
        for view in store.iter_visible(generation) {
            if view.category() != CATEGORY_ENTITY {
                continue;
            }
            if Some(view.kind_id() as usize) == inferred_type_kind_id {
                continue;
            }
            let Some(path) = owner_path(view.owner_artifact()) else {
                continue;
            };
            let start = view.span_start_byte() as i32;
            candidates_by_key
                .entry((path, start))
                .or_default()
                .push(view.record_id());
        }
        assert!(
            !candidates_by_key.is_empty(),
            "expected at least one visible entity in the shared fixture"
        );
        let mut checked_unambiguous = 0u64;
        let mut ambiguous_keys = 0u64;
        for ((path, start), candidates) in &candidates_by_key {
            let section_hit = via_section.entities.lookup(path, *start);
            let scan_hit = via_scan.entities.lookup(path, *start);
            assert!(
                section_hit.is_some_and(|id| candidates.contains(&id)),
                "entities.index section path resolved {path}:{start} to a non-candidate: {section_hit:?}"
            );
            assert!(
                scan_hit.is_some_and(|id| candidates.contains(&id)),
                "full-scan path resolved {path}:{start} to a non-candidate: {scan_hit:?}"
            );
            if candidates.len() == 1 {
                assert_eq!(section_hit, Some(candidates[0]));
                assert_eq!(scan_hit, Some(candidates[0]));
                checked_unambiguous += 1;
            } else {
                ambiguous_keys += 1;
            }
        }
        eprintln!(
            "[test] entities_index_section_and_scan_agree: unambiguous_keys={checked_unambiguous} ambiguous_keys={ambiguous_keys}"
        );
        assert!(
            checked_unambiguous > 0,
            "expected at least one unambiguous (path, start) key in the shared fixture"
        );
    }

    static SCRATCH_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn scratch_dir(label: &str) -> PathBuf {
        let counter = SCRATCH_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("v4-residual-test")
            .join(format!("{label}-{}-{counter}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("scratch dir creation succeeds");
        dir
    }

    fn fixture_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("tests/fixtures/codebases/typescript/task-planner")
    }

    /// End-to-end: cold-scan the shared `task-planner` fixture (the SAME
    /// fixture `urdira-tsgo-client`'s own oracle test uses -- see
    /// `docs/evidence/2026-09-03-v4-p1d-a-tsgo-client.md` §6, which
    /// documents sites 2-4 there as interface-typed method dispatch calls
    /// resolved only by a real checker), then run one residual pass
    /// synchronously (no background thread, no quiet period) against the
    /// resulting store and assert every possible call/heritage site this
    /// fixture produced is accounted for (upgraded, external, or
    /// genuinely unresolved -- never silently dropped), and that any
    /// upgrade actually publishes a `semantic_upgrade` generation with a
    /// confirmed row replacing the possible one.
    #[test]
    fn residual_pass_accounts_for_every_possible_site_in_the_shared_fixture() {
        let scratch = scratch_dir("e2e");
        let workspace_root = fixture_root();
        assert!(
            workspace_root.is_dir(),
            "shared fixture missing at {workspace_root:?}"
        );
        let database_path = scratch.join("workspace.sqlite");
        let structural_root = scratch.join("structural");
        let cas_root = scratch.join("cas");
        let workspace_id = "workspace:v4-residual-test".to_string();

        let request = scan::ScanRequest {
            request_id: "request:v4-residual-test".to_string(),
            workspace_id: workspace_id.clone(),
            workspace_root: workspace_root.to_string_lossy().into_owned(),
            database_path: database_path.to_string_lossy().into_owned(),
            structural_root: structural_root.to_string_lossy().into_owned(),
            cas_root: cas_root.to_string_lossy().into_owned(),
            sidecar_root: scratch.join("sidecar").to_string_lossy().into_owned(),
            scope: urdira_worker_protocol::ScanScope::Full,
            registry_snapshot_id: "registry:v4-residual-test".to_string(),
            configuration_revision_id: "configuration:v4-residual-test".to_string(),
            resolution_lock_id: "resolution:v4-residual-test".to_string(),
            deadline_ms: None,
            priority: ScanPriority::Interactive,
        };
        let mut syntax = SyntaxWorkerState::default();
        let mut worker_state: WorkerState = WorkerState::default();
        let mut on_queryable = |_event: IndexingEvent| -> Result<(), String> { Ok(()) };
        let cold_event = scan::run_with_residual(
            request,
            &mut syntax,
            &mut worker_state,
            &mut on_queryable,
            None,
        )
        .expect("cold scan succeeds");
        let base_generation = match cold_event {
            IndexingEvent::ScanCompleted { generation, .. } => generation,
            other => panic!("expected ScanCompleted, got {other:?}"),
        };

        let context = ResidualContext {
            request_id: "request:v4-residual-test-upgrade".to_string(),
            workspace_id: workspace_id.clone(),
            workspace_root: workspace_root.to_string_lossy().into_owned(),
            database_path: database_path.to_string_lossy().into_owned(),
            structural_root: structural_root.to_string_lossy().into_owned(),
            cas_root: cas_root.to_string_lossy().into_owned(),
            registry_snapshot_id: "registry:v4-residual-test".to_string(),
            configuration_revision_id: "configuration:v4-residual-test".to_string(),
            resolution_lock_id: "resolution:v4-residual-test".to_string(),
            // Simulates the trigger a cold `Full` scan would build (see
            // `scan::run_with_residual`): the whole frontier is in scope.
            touched_owners: None,
            reschedule_count: 0,
        };

        // Count possible call/heritage rows before the residual pass runs,
        // via this module's own `collect` (metadata-only, no body decode).
        let store = StoreReader::open(Path::new(&context.structural_root)).expect("store opens");
        let dicts = store.dictionaries();
        let conn = catalog::open_and_ensure_schema(Path::new(&context.database_path))
            .expect("catalog opens");
        let frontier = Frontier::load(&conn, &workspace_id).expect("frontier loads");
        drop(conn);
        let mut path_by_pair: HashMap<(String, String), String> = HashMap::new();
        for (path, entry) in &frontier.present {
            path_by_pair.insert(
                (entry.artifact_id.clone(), entry.artifact_version_id.clone()),
                path.clone(),
            );
        }
        let owner_path = |ordinal: u32| -> Option<String> {
            dicts
                .artifacts
                .get(ordinal as usize)
                .and_then(|pair| path_by_pair.get(pair))
                .cloned()
        };
        let collected = collect(
            &store,
            &dicts,
            &owner_path,
            &frontier,
            base_generation,
            false,
        );
        let pending_before: usize = collected.pending_by_owner.values().map(Vec::len).sum();

        let result = run_once_with_quiet_period(&context, 0, std::time::Duration::ZERO)
            .expect("residual pass does not error");

        if pending_before == 0 {
            // This fixture's own v4 pipeline (E1-E3 + typeflow) resolved
            // every call/heritage site with Rust-only certainty -- nothing
            // for a residual pass to do. Document, do not fail: a future
            // change to E1-E3/typeflow's own coverage can legitimately
            // shrink this fixture's possible set to zero.
            assert!(
                result.is_none(),
                "no possible sites but the pass still published"
            );
            return;
        }

        let outcome = result.expect("pending sites existed; the pass must report an outcome");
        eprintln!(
            "[test] pending_before={pending_before} upgraded={} external={} unresolved={} generation={} total_ms={}",
            outcome.upgraded_sites,
            outcome.external_sites,
            outcome.unresolved_sites,
            outcome.generation,
            outcome.timings.total_ms,
        );
        assert_eq!(
            outcome.upgraded_sites + outcome.external_sites + outcome.unresolved_sites,
            pending_before as u64,
            "every possible site must be accounted for exactly once"
        );

        if outcome.upgraded_sites == 0 {
            // Every possible site resolved to a lib global (`external`) or
            // stayed genuinely unresolved -- valid for a tiny fixture with
            // few cross-file targets, but nothing further to verify.
            return;
        }

        assert!(outcome.generation > base_generation);
        let store_after =
            StoreReader::open(Path::new(&context.structural_root)).expect("store reopens");
        assert_eq!(store_after.generation(), outcome.generation);

        let conn = catalog::open_and_ensure_schema(Path::new(&context.database_path))
            .expect("catalog reopens");
        let publication_kind: String = conn
            .query_row(
                "SELECT publication_kind FROM generation_manifests WHERE workspace_id = ?1 AND generation = ?2",
                rusqlite::params![&workspace_id, outcome.generation as i64],
                |row| row.get(0),
            )
            .expect("generation_manifests row exists for the upgrade generation");
        assert_eq!(publication_kind, "semantic_upgrade");

        // At least one confirmed relation row now exists that did not
        // exist before (the fixture's own confirmed count grew by exactly
        // `upgraded_sites`).
        let confirmed_rows: Vec<[u8; 32]> = store_after
            .iter_visible(outcome.generation)
            .filter(|view| {
                view.category() == CATEGORY_RELATION
                    && view.target_subject().is_some()
                    && matches!(
                        dicts
                            .universal_kinds
                            .get(view.universal_kind_id() as usize)
                            .map(String::as_str),
                        Some("core:call") | Some("core:inherits") | Some("core:implements")
                    )
            })
            .map(|view| view.record_id())
            .collect();
        assert!(
            !confirmed_rows.is_empty(),
            "expected at least one confirmed relation row after upgrade"
        );

        // Deliverable 4: the outcome->row mapping must be byte-for-byte the
        // same IDENTITY-KEY recipe `semantic_sites.rs`'s `call_proposed_
        // record`/`heritage_proposed_record` use for the checker-resolved
        // case (`jsts:{call|inherits|implements}:{path}:{start}:{end}:
        // {source_id}:{target_id}`, both endpoints present, no trailing
        // `:unresolved` sentinel a possible row would carry instead) --
        // verified here against a REAL row this pass published, not a
        // hand-built oracle value, since `build_confirmed_row` has no
        // pure/isolated form to unit-test without a live `StoreReader`.
        let confirmed_view = store_after
            .get_visible(&confirmed_rows[0], outcome.generation)
            .expect("confirmed row is visible at its own publish generation");
        let identity_key = String::from_utf8(confirmed_view.identity_key().into_owned())
            .expect("identity_key is valid UTF-8");
        let mut parts = identity_key.split(':');
        assert_eq!(parts.next(), Some("jsts"));
        assert!(matches!(
            parts.next(),
            Some("call" | "inherits" | "implements")
        ));
        assert!(
            !identity_key.ends_with(":unresolved"),
            "a confirmed row's identity_key must not carry the possible-row sentinel: {identity_key}"
        );
        assert!(
            identity_key.contains(":jsts:"),
            "a confirmed row's identity_key must embed a real target entity id, not a bare span: {identity_key}"
        );

        // A2 (pending.sites migration): exactly the sites this pass
        // actually upgraded must have their pending key CLOSED (`store.
        // pending_site(&key, gen)` is `None`) -- an `External`/`Unresolved`
        // site's key must stay OPEN (this loop's own count, over EVERY
        // collected site, must land exactly on `upgraded_sites`, not more
        // and not less).
        let indirect_bit = dicts
            .facet_names
            .iter()
            .position(|name| name == "core:indirect");
        let mut closed_pending_count = 0u64;
        for meta in collected.by_site.values() {
            let still_pending = store_after
                .pending_site(&meta.pending_key, outcome.generation)
                .is_some();
            if !still_pending {
                closed_pending_count += 1;
            }
        }
        assert_eq!(
            closed_pending_count, outcome.upgraded_sites,
            "exactly the upgraded sites' pending keys must be closed, no more and no fewer"
        );
        // Any P2-2j candidate row (`core:indirect` facet) at the SAME span
        // as a freshly-confirmed row must now be closed too (see the
        // materialize loop's own comment on why superseding a candidate is
        // correct once the checker independently confirms a single real
        // target for that site). This fixture may have zero candidate rows
        // at all (P2-2j is scoped to overload/union receivers, not
        // exercised by every fixture) -- the loop below is a real check
        // when one exists, a no-op otherwise.
        if let Some(indirect_bit) = indirect_bit {
            for &confirmed_id in &confirmed_rows {
                let Some(confirmed) = store_after.get_visible(&confirmed_id, outcome.generation)
                else {
                    continue;
                };
                for row in store_after.by_owner(confirmed.owner_artifact(), outcome.generation) {
                    if row.category() == CATEGORY_RELATION
                        && row.record_id() != confirmed.record_id()
                        && row.span_start_byte() == confirmed.span_start_byte()
                        && row.span_end_byte() == confirmed.span_end_byte()
                        && (row.facets() & (1u64 << indirect_bit)) != 0
                    {
                        panic!(
                            "a live P2-2j candidate row still exists at a span this pass just confirmed: {:?}",
                            row.record_id()
                        );
                    }
                }
            }
        }

        // C task (member entities at cold): `try_synthesize_member_entity`
        // must find a class/interface member the cold entity producer
        // already materialized through `collected.entities` (this test's
        // own `collect()` call, above) and REUSE it, never synthesize a
        // second copy -- verified two ways over the WHOLE store at the
        // upgrade generation (not just the sites this test happened to
        // walk): (1) no entity identity is visible twice (`entity_records_
        // by_identity` below groups every visible entity by its own
        // `identity_key` and asserts every group has exactly one member --
        // a synthesized duplicate of an already-cold entity would show up
        // as a SECOND live record under the same identity), and (2) at
        // least one confirmed call/heritage row's TARGET is a member entity
        // whose own `valid_from` is the COLD generation, not this upgrade's
        // -- proof the target this pass wired up is the entity `push_
        // member_entities` created at generation 1, not a fresh synthesis.
        let mut entity_records_by_identity: HashMap<Vec<u8>, u32> = HashMap::new();
        for view in store_after.iter_visible(outcome.generation) {
            if view.category() == CATEGORY_ENTITY {
                *entity_records_by_identity
                    .entry(view.identity_key().into_owned())
                    .or_insert(0) += 1;
            }
        }
        for (identity, count) in &entity_records_by_identity {
            assert_eq!(
                *count,
                1,
                "entity identity {:?} is visible {count} times after the upgrade -- a duplicate member entity was synthesized alongside the cold one",
                String::from_utf8_lossy(identity),
            );
        }

        let member_kind_words = ["method", "constructor", "getter", "setter", "property"];
        let mut found_cold_member_target = false;
        for &confirmed_id in &confirmed_rows {
            let Some(confirmed) = store_after.get_visible(&confirmed_id, outcome.generation) else {
                continue;
            };
            let Some(target_subject) = confirmed.target_subject() else {
                continue;
            };
            let Some(target_record_id) = dicts.subjects.get(target_subject as usize) else {
                continue;
            };
            let Some(target_view) = store_after.get_visible(target_record_id, outcome.generation)
            else {
                continue;
            };
            let target_identity = String::from_utf8_lossy(&target_view.identity_key()).into_owned();
            let is_member = member_kind_words
                .iter()
                .any(|word| target_identity.starts_with(&format!("jsts:{word}:")));
            if is_member && target_view.valid_from() == base_generation as u32 {
                found_cold_member_target = true;
                eprintln!(
                    "[test] residual upgrade reused a cold-emitted member entity: {target_identity}"
                );
                break;
            }
        }
        assert!(
            found_cold_member_target,
            "expected at least one confirmed row after the upgrade whose target is a member entity materialized at the COLD generation (reused, not synthesized) -- the fixture's `this.repository.create(...)`-style interface method dispatch call is expected to exercise exactly this path"
        );
    }

    /// Decision 28's "inferred types + compiler diagnostics" task, point 3
    /// ("Incrementality"): a tiny, self-contained fixture (not the shared
    /// task-planner one) with an exported function, an exported class with
    /// a method, and a deliberate type error. Verifies, across THREE
    /// residual runs against the SAME cold scan (no edit between run 1 and
    /// run 2, one edit before run 3):
    /// - Run 1 produces `jsts:entity_inferred_type` + `jsts:relation_type_of`
    ///   rows for the exported declarations (never for the unexported one),
    ///   and a `jsts:diagnostic` row carrying the real TS2322 compiler code,
    ///   with the exact identity recipe this task's report documents.
    /// - Run 2 (no source change) opens NO new rows for the SAME entity --
    ///   "never accumulate": exactly one visible `jsts:relation_type_of` per
    ///   entity after two consecutive runs.
    /// - An edit that changes `add`'s own parameter types (changing its
    ///   inferred type text) followed by an incremental scan: the OLD
    ///   `type_of` identity is ALREADY closed right after the edit-scan
    ///   itself (`diff_owner`'s owner-wide diff sees it, confirmed live --
    ///   see the assertion's own comment), then run 3 re-adds a fresh one,
    ///   and there is still exactly one live `type_of` for `add`.
    #[test]
    fn inferred_types_and_diagnostics_across_two_runs_and_an_edit() {
        let Some(tsgo) = binary::discover(&fixture_root_repo()).ok() else {
            eprintln!("skipping: tsgo binary not discoverable");
            return;
        };
        drop(tsgo);

        let scratch = scratch_dir("inferred-types");
        let workspace_root = scratch.join("workspace");
        std::fs::create_dir_all(&workspace_root).expect("create workspace root");
        let owner_relative = "a.ts";
        let owner_absolute = workspace_root.join(owner_relative);
        // The `[1, 2].map((n) => n)` call is deliberate: it is the SAME
        // "guaranteed pending call site" shape `tests/residual_pass.rs`
        // uses (a lib.d.ts `Array.prototype` method E1-E3/typeflow cannot
        // resolve without a real checker). F4 4.1 removed the early return
        // that used to make a call/heritage site load-bearing for the
        // inferred-types/diagnostics half of this test too (that half now
        // runs regardless of `pending_by_owner`) -- kept anyway so this
        // test still exercises the `SiteOutcome::Unresolved`/`upgraded`
        // counters alongside the inferred-type/diagnostic assertions below,
        // matching what a real corpus with both kinds of work looks like.
        let before_text = "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nfunction helper(): string {\n  return \"not exported\";\n}\n\nexport class Widget {\n  count = 0;\n  describe(): string {\n    return `widget ${this.count}`;\n  }\n}\n\nconst bad: number = \"nope\";\n\n[1, 2].map((n) => n);\n";
        std::fs::write(&owner_absolute, before_text).expect("write fixture file");
        std::fs::write(workspace_root.join("package.json"), r#"{"type":"module"}"#)
            .expect("write package.json");
        std::fs::write(
            workspace_root.join("tsconfig.json"),
            r#"{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler","target":"ES2022","strict":false,"skipLibCheck":true,"allowJs":true,"checkJs":true}}"#,
        )
        .expect("write tsconfig.json");

        let database_path = scratch.join("workspace.sqlite");
        let structural_root = scratch.join("structural");
        let cas_root = scratch.join("cas");
        let workspace_id = "workspace:v4-inferred-types-test".to_string();

        let mut syntax = SyntaxWorkerState::default();
        let mut worker_state: WorkerState = WorkerState::default();
        let mut on_queryable = |_event: IndexingEvent| -> Result<(), String> { Ok(()) };

        let cold_request = scan::ScanRequest {
            request_id: "request:v4-inferred-types-cold".to_string(),
            workspace_id: workspace_id.clone(),
            workspace_root: workspace_root.to_string_lossy().into_owned(),
            database_path: database_path.to_string_lossy().into_owned(),
            structural_root: structural_root.to_string_lossy().into_owned(),
            cas_root: cas_root.to_string_lossy().into_owned(),
            sidecar_root: scratch.join("sidecar").to_string_lossy().into_owned(),
            scope: ScanScope::Full,
            registry_snapshot_id: "registry:v4-inferred-types-test".to_string(),
            configuration_revision_id: "configuration:v4-inferred-types-test".to_string(),
            resolution_lock_id: "resolution:v4-inferred-types-test".to_string(),
            deadline_ms: None,
            priority: ScanPriority::Interactive,
        };
        let cold_event = scan::run_with_residual(
            cold_request,
            &mut syntax,
            &mut worker_state,
            &mut on_queryable,
            None,
        )
        .expect("cold scan succeeds");
        let base_generation = match cold_event {
            IndexingEvent::ScanCompleted { generation, .. } => generation,
            other => panic!("expected ScanCompleted, got {other:?}"),
        };

        let context = ResidualContext {
            request_id: "request:v4-inferred-types-upgrade".to_string(),
            workspace_id: workspace_id.clone(),
            workspace_root: workspace_root.to_string_lossy().into_owned(),
            database_path: database_path.to_string_lossy().into_owned(),
            structural_root: structural_root.to_string_lossy().into_owned(),
            cas_root: cas_root.to_string_lossy().into_owned(),
            registry_snapshot_id: "registry:v4-inferred-types-test".to_string(),
            configuration_revision_id: "configuration:v4-inferred-types-test".to_string(),
            resolution_lock_id: "resolution:v4-inferred-types-test".to_string(),
            // Run 3 (below) is preceded by a real `Changed` incremental
            // scan, but this SAME `context` is also reused for runs 1/2
            // (right after the cold scan) -- `None` keeps every run's file
            // map scoped to the whole (tiny) fixture frontier, matching
            // this test's own pre-4.1 behavior exactly.
            touched_owners: None,
            reschedule_count: 0,
        };

        // --- Run 1 ---
        let outcome1 = run_once_with_quiet_period(&context, 0, std::time::Duration::ZERO)
            .expect("residual pass does not error")
            .expect("fixture has pending work (a deliberate type error, if nothing else)");
        eprintln!(
            "[test] run1 inferred_type_entities={} type_of_relations={} diagnostics_emitted={} generation={}",
            outcome1.inferred_type_entities,
            outcome1.type_of_relations,
            outcome1.diagnostics_emitted,
            outcome1.generation,
        );
        assert!(
            outcome1.generation > base_generation,
            "the residual pass must publish a new generation above the cold one"
        );
        assert!(
            outcome1.inferred_type_entities > 0,
            "expected at least one inferred-type entity after run 1"
        );
        assert_eq!(
            outcome1.inferred_type_entities, outcome1.type_of_relations,
            "every inferred-type entity has exactly one paired type_of relation"
        );
        assert!(
            outcome1.diagnostics_emitted > 0,
            "expected the deliberate `const bad: number = \"nope\"` to produce a compiler diagnostic"
        );

        let store1 = StoreReader::open(&structural_root).expect("store opens after run 1");
        let dicts1 = store1.dictionaries();
        let kind_of = |view: &urdira_structural_store::RecordView| -> Option<&str> {
            dicts1
                .kinds
                .get(view.kind_id() as usize)
                .map(String::as_str)
        };
        let mut inferred_type_identities: Vec<String> = Vec::new();
        let mut type_of_identities: Vec<String> = Vec::new();
        let mut add_type_of_identity: Option<String> = None;
        let mut diagnostic_ts2322_found = false;
        for view in store1.iter_visible(outcome1.generation) {
            let Some(kind) = kind_of(&view) else { continue };
            let identity = String::from_utf8_lossy(&view.identity_key()).into_owned();
            match kind {
                "jsts:entity_inferred_type" => {
                    // Byte-for-byte identity recipe check.
                    assert!(identity.starts_with("jsts:inferred-type:jsts:"));
                    // Never for the unexported `helper` function.
                    assert!(
                        !identity.contains(":helper:"),
                        "unexported `helper` must never get an inferred-type entity: {identity}"
                    );
                    inferred_type_identities.push(identity);
                }
                "jsts:relation_type_of" => {
                    assert!(identity.starts_with("jsts:type-of:jsts:"));
                    if identity.contains(":add:") {
                        add_type_of_identity = Some(identity.clone());
                    }
                    type_of_identities.push(identity);
                }
                "jsts:diagnostic" => {
                    // This loop does not decode the body (this module's own
                    // "no body decoder" constraint -- see the module doc),
                    // so it cannot itself read the diagnostic's own
                    // `compiler_code` field back out; it only confirms a
                    // `jsts:diagnostic` row is visible at all. The TS2322
                    // code itself is confirmed separately, via `outcome1.
                    // diagnostics_emitted > 0` above (a real compiler
                    // diagnostic was newly opened this run) plus the tsgo-
                    // client-level `deliberate_type_error_produces_a_
                    // compiler_diagnostic` test, which DOES assert
                    // `compiler_code == 2322` directly against the live RPC
                    // response before any store encoding happens.
                    diagnostic_ts2322_found = true;
                }
                _ => {}
            }
        }
        assert!(
            !inferred_type_identities.is_empty(),
            "expected visible jsts:entity_inferred_type rows"
        );
        assert!(
            diagnostic_ts2322_found,
            "expected at least one visible jsts:diagnostic row"
        );
        let add_type_of_identity =
            add_type_of_identity.expect("expected a type_of relation for the exported `add`");

        // --- Run 2 (no source change): idempotent, never accumulates. ---
        let outcome2 = run_once_with_quiet_period(&context, 0, std::time::Duration::ZERO)
            .expect("residual pass does not error")
            .expect("fixture still has the deliberate type error to re-diagnose, or nothing new -- either way an outcome");
        eprintln!(
            "[test] run2 inferred_type_entities={} type_of_relations={} diagnostics_emitted={} generation={}",
            outcome2.inferred_type_entities,
            outcome2.type_of_relations,
            outcome2.diagnostics_emitted,
            outcome2.generation,
        );
        let store2 = StoreReader::open(&structural_root).expect("store opens after run 2");
        let live_type_of_after_run2: Vec<String> = store2
            .iter_visible(outcome2.generation)
            .filter(|view| kind_of_at(&dicts1, view) == Some("jsts:relation_type_of"))
            .map(|view| String::from_utf8_lossy(&view.identity_key()).into_owned())
            .collect();
        for identity in &type_of_identities {
            if !live_type_of_after_run2.contains(identity) {
                eprintln!("[test] run1-only (closed by run2): {identity}");
            }
        }
        for identity in &live_type_of_after_run2 {
            if !type_of_identities.contains(identity) {
                eprintln!("[test] run2-only (newly opened): {identity}");
            }
        }
        assert_eq!(
            live_type_of_after_run2.len(),
            type_of_identities.len(),
            "run 2 (no source change) must not accumulate duplicate type_of rows: {live_type_of_after_run2:?} vs {type_of_identities:?}"
        );
        assert!(
            live_type_of_after_run2.contains(&add_type_of_identity),
            "the SAME `add` type_of identity must still be the live one after an unchanged run 2"
        );

        // --- Edit `add`'s signature (changes its inferred type), then an
        // incremental scan, then run 3. ---
        let after_text = before_text.replacen(
            "export function add(a: number, b: number): number {\n  return a + b;\n}",
            "export function add(a: string, b: string): string {\n  return a + b;\n}",
            1,
        );
        assert_ne!(
            before_text, after_text,
            "the edit must actually change the text"
        );
        std::fs::write(&owner_absolute, &after_text).expect("write edited fixture file");

        let edit_request = scan::ScanRequest {
            request_id: "request:v4-inferred-types-edit".to_string(),
            workspace_id: workspace_id.clone(),
            workspace_root: workspace_root.to_string_lossy().into_owned(),
            database_path: database_path.to_string_lossy().into_owned(),
            structural_root: structural_root.to_string_lossy().into_owned(),
            cas_root: cas_root.to_string_lossy().into_owned(),
            sidecar_root: scratch.join("sidecar").to_string_lossy().into_owned(),
            scope: ScanScope::Changed {
                paths: vec![urdira_worker_protocol::ChangedPath {
                    path: owner_relative.to_string(),
                    kind: urdira_worker_protocol::ChangeKind::Modified,
                }],
            },
            registry_snapshot_id: "registry:v4-inferred-types-test".to_string(),
            configuration_revision_id: "configuration:v4-inferred-types-test".to_string(),
            resolution_lock_id: "resolution:v4-inferred-types-test".to_string(),
            deadline_ms: None,
            priority: ScanPriority::Interactive,
        };
        let edit_event = scan::run_with_residual(
            edit_request,
            &mut syntax,
            &mut worker_state,
            &mut on_queryable,
            None,
        )
        .expect("incremental edit scan succeeds");
        let edit_generation = match edit_event {
            IndexingEvent::ScanCompleted { generation, .. } => generation,
            other => panic!("expected ScanCompleted, got {other:?}"),
        };
        assert!(edit_generation > outcome2.generation);

        // `diff_owner`'s ordinary identity diff (`delta.rs`, out of this
        // task's file ownership) actually diffs an edited owner's FULL
        // previous record set (`store_reader.by_owner(ordinal, prev_
        // generation)`, every category/kind, not just the stage-1/2 kinds
        // the edit-scan's own fresh analysis regenerates) against the
        // fresh set -- so a stage-3-only row like this pass's own `jsts:
        // relation_type_of` is ALREADY unmatched-and-closed by the
        // edit-scan itself, confirmed live here (verified BEFORE trusting
        // it: an earlier version of this test asserted the opposite and
        // failed against the real pipeline). This is case (a) of the task
        // brief's own "if the identity diff cannot see them" conditional --
        // the residual pass's OWN by_owner+kind-filter closing (this
        // module's `record_closures` loop) is still real and necessary
        // for the OTHER case (a later residual run re-typing an owner with
        // no accompanying edit-scan in between, exercised by run 2 above),
        // just not the one this particular edit exercises.
        let store_after_edit =
            StoreReader::open(&structural_root).expect("store opens after edit scan");
        let stale_still_visible = store_after_edit.iter_visible(edit_generation).any(|view| {
            kind_of_at(&dicts1, &view) == Some("jsts:relation_type_of")
                && String::from_utf8_lossy(&view.identity_key()) == add_type_of_identity
        });
        assert!(
            !stale_still_visible,
            "the edit-scan's own owner-wide diff_owner should already close the stale type_of row for the edited owner"
        );

        let outcome3 = run_once_with_quiet_period(&context, 0, std::time::Duration::ZERO)
            .expect("residual pass does not error")
            .expect("edited fixture still has pending/typed work");
        eprintln!(
            "[test] run3 inferred_type_entities={} type_of_relations={} diagnostics_emitted={} generation={}",
            outcome3.inferred_type_entities,
            outcome3.type_of_relations,
            outcome3.diagnostics_emitted,
            outcome3.generation,
        );

        let store3 = StoreReader::open(&structural_root).expect("store opens after run 3");
        let live_type_of_after_run3: Vec<String> = store3
            .iter_visible(outcome3.generation)
            .filter(|view| kind_of_at(&dicts1, view) == Some("jsts:relation_type_of"))
            .map(|view| String::from_utf8_lossy(&view.identity_key()).into_owned())
            .collect();
        assert!(
            !live_type_of_after_run3.contains(&add_type_of_identity),
            "the OLD (pre-edit) type_of identity for `add` must be closed after run 3: {live_type_of_after_run3:?}"
        );
        let new_add_type_of: Vec<&String> = live_type_of_after_run3
            .iter()
            .filter(|identity| identity.contains(":add:"))
            .collect();
        assert_eq!(
            new_add_type_of.len(),
            1,
            "exactly one live type_of for `add` after the edit + run 3 -- never accumulate: {live_type_of_after_run3:?}"
        );
    }

    /// F4 4.1: a fixture with an exported, typed function and a deliberate
    /// type error, but NO call/heritage site at all (unlike the sibling
    /// `inferred_types_and_diagnostics_across_two_runs_and_an_edit`
    /// fixture, this one has no `[1, 2].map(...)`-shaped lib dispatch) --
    /// `collect()`'s own `pending_by_owner` is verified empty below before
    /// the pass runs. Before this task, `run_once_with_quiet_period`
    /// returned early the instant `pending_by_owner` was empty, WITHOUT
    /// ever reaching decision 28's inferred-types/diagnostics half -- this
    /// test is the regression guard for that early return's removal: an
    /// exported declaration still gets a `jsts:entity_inferred_type`/
    /// `jsts:relation_type_of` pair and the type error still gets a
    /// `jsts:diagnostic`, purely from the "always build file_map, always
    /// run the checker pass" path, with zero possible sites to upgrade.
    #[test]
    fn residual_emits_types_and_diagnostics_with_zero_pending_sites() {
        let Some(tsgo) = binary::discover(&fixture_root_repo()).ok() else {
            eprintln!("skipping: tsgo binary not discoverable");
            return;
        };
        drop(tsgo);

        let scratch = scratch_dir("zero-pending");
        let workspace_root = scratch.join("workspace");
        std::fs::create_dir_all(&workspace_root).expect("create workspace root");
        let owner_relative = "a.ts";
        let owner_absolute = workspace_root.join(owner_relative);
        let text = "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nconst bad: number = \"nope\";\n";
        std::fs::write(&owner_absolute, text).expect("write fixture file");
        std::fs::write(workspace_root.join("package.json"), r#"{"type":"module"}"#)
            .expect("write package.json");
        std::fs::write(
            workspace_root.join("tsconfig.json"),
            r#"{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler","target":"ES2022","strict":false,"skipLibCheck":true,"allowJs":true,"checkJs":true}}"#,
        )
        .expect("write tsconfig.json");

        let database_path = scratch.join("workspace.sqlite");
        let structural_root = scratch.join("structural");
        let cas_root = scratch.join("cas");
        let workspace_id = "workspace:v4-zero-pending-test".to_string();

        let mut syntax = SyntaxWorkerState::default();
        let mut worker_state: WorkerState = WorkerState::default();
        let mut on_queryable = |_event: IndexingEvent| -> Result<(), String> { Ok(()) };

        let cold_request = scan::ScanRequest {
            request_id: "request:v4-zero-pending-cold".to_string(),
            workspace_id: workspace_id.clone(),
            workspace_root: workspace_root.to_string_lossy().into_owned(),
            database_path: database_path.to_string_lossy().into_owned(),
            structural_root: structural_root.to_string_lossy().into_owned(),
            cas_root: cas_root.to_string_lossy().into_owned(),
            sidecar_root: scratch.join("sidecar").to_string_lossy().into_owned(),
            scope: ScanScope::Full,
            registry_snapshot_id: "registry:v4-zero-pending-test".to_string(),
            configuration_revision_id: "configuration:v4-zero-pending-test".to_string(),
            resolution_lock_id: "resolution:v4-zero-pending-test".to_string(),
            deadline_ms: None,
            priority: ScanPriority::Interactive,
        };
        let cold_event = scan::run_with_residual(
            cold_request,
            &mut syntax,
            &mut worker_state,
            &mut on_queryable,
            None,
        )
        .expect("cold scan succeeds");
        let base_generation = match cold_event {
            IndexingEvent::ScanCompleted { generation, .. } => generation,
            other => panic!("expected ScanCompleted, got {other:?}"),
        };

        // Verified, not merely assumed: this fixture has zero pending
        // call/heritage sites -- the exact precondition this test exists
        // to exercise.
        let store = StoreReader::open(&structural_root).expect("store opens");
        let dicts = store.dictionaries();
        let conn = catalog::open_and_ensure_schema(&database_path).expect("catalog opens");
        let frontier = Frontier::load(&conn, &workspace_id).expect("frontier loads");
        drop(conn);
        let mut path_by_pair: HashMap<(String, String), String> = HashMap::new();
        for (path, entry) in &frontier.present {
            path_by_pair.insert(
                (entry.artifact_id.clone(), entry.artifact_version_id.clone()),
                path.clone(),
            );
        }
        let owner_path = |ordinal: u32| -> Option<String> {
            dicts
                .artifacts
                .get(ordinal as usize)
                .and_then(|pair| path_by_pair.get(pair))
                .cloned()
        };
        let collected = collect(
            &store,
            &dicts,
            &owner_path,
            &frontier,
            base_generation,
            false,
        );
        assert!(
            collected.pending_by_owner.is_empty(),
            "fixture must have zero pending call/heritage sites for this test to exercise the right code path: {:?}",
            collected.pending_by_owner
        );

        let context = ResidualContext {
            request_id: "request:v4-zero-pending-upgrade".to_string(),
            workspace_id: workspace_id.clone(),
            workspace_root: workspace_root.to_string_lossy().into_owned(),
            database_path: database_path.to_string_lossy().into_owned(),
            structural_root: structural_root.to_string_lossy().into_owned(),
            cas_root: cas_root.to_string_lossy().into_owned(),
            registry_snapshot_id: "registry:v4-zero-pending-test".to_string(),
            configuration_revision_id: "configuration:v4-zero-pending-test".to_string(),
            resolution_lock_id: "resolution:v4-zero-pending-test".to_string(),
            touched_owners: None,
            reschedule_count: 0,
        };

        let outcome = run_once_with_quiet_period(&context, 0, std::time::Duration::ZERO)
            .expect("residual pass does not error")
            .expect(
                "a fixture with an exported function and a type error always produces an \
                 outcome, even with zero pending call/heritage sites",
            );
        eprintln!(
            "[test] inferred_type_entities={} diagnostics_emitted={} generation={}",
            outcome.inferred_type_entities, outcome.diagnostics_emitted, outcome.generation,
        );
        assert!(
            outcome.inferred_type_entities > 0,
            "expected at least one inferred-type entity even with zero pending sites"
        );
        assert!(
            outcome.diagnostics_emitted > 0,
            "expected the deliberate type error to still produce a compiler diagnostic"
        );
        assert_eq!(outcome.upgraded_sites, 0);
        assert_eq!(outcome.external_sites, 0);
        assert_eq!(outcome.unresolved_sites, 0);
        assert!(outcome.generation > base_generation);
    }

    fn kind_of_at<'a>(
        dicts: &'a Dictionaries,
        view: &urdira_structural_store::RecordView,
    ) -> Option<&'a str> {
        dicts.kinds.get(view.kind_id() as usize).map(String::as_str)
    }

    fn fixture_root_repo() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
    }

    /// P1-D-d deliverable 1: cold-scans a real n8n corpus copy, then runs
    /// one residual pass with `URDIRA_V4_RESIDUAL_DEBUG=1` so `ResidualDebug`
    /// prints its reason histogram + sample dump to stderr (`--nocapture`).
    /// `#[ignore]`d (needs a real n8n corpus + idle machine, run explicitly
    /// with `URDIRA_V4_RESIDUAL_DEBUG=1` ALSO set in the invoking shell --
    /// this test does not set it itself, since `std::env::set_var` requires
    /// `unsafe` and this crate is `#![forbid(unsafe_code)]`):
    /// `URDIRA_V4_N8N_CORPUS=<path> URDIRA_V4_N8N_DATA=<fresh-dir>
    /// URDIRA_V4_RESIDUAL_DEBUG=1 cargo test --release -p urdira-indexing-worker
    /// v4::residual::tests::n8n_residual_pass_debug_histogram -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn n8n_residual_pass_debug_histogram() {
        let (Ok(corpus), Ok(data_root)) = (
            std::env::var("URDIRA_V4_N8N_CORPUS"),
            std::env::var("URDIRA_V4_N8N_DATA"),
        ) else {
            eprintln!(
                "set URDIRA_V4_N8N_CORPUS=<path> URDIRA_V4_N8N_DATA=<fresh-dir> to run this diagnostic"
            );
            return;
        };
        if std::env::var_os("URDIRA_V4_RESIDUAL_DEBUG").is_none() {
            eprintln!(
                "URDIRA_V4_RESIDUAL_DEBUG is not set -- the pass will still run, but ResidualDebug will not print anything"
            );
        }
        let workspace_root =
            crate::v4::tests_e2e::scratch_copy_of_n8n_corpus("n8n-residual-debug", &corpus);
        let data_root = PathBuf::from(&data_root);
        std::fs::create_dir_all(&data_root).expect("create data root");
        let database_path = data_root.join("workspace.sqlite");
        let structural_root = data_root.join("structural");
        let cas_root = data_root.join("cas");
        let workspace_id = "workspace:n8n-residual-debug".to_string();

        let request = scan::ScanRequest {
            request_id: "request:n8n-residual-debug".to_string(),
            workspace_id: workspace_id.clone(),
            workspace_root: workspace_root.to_string_lossy().into_owned(),
            database_path: database_path.to_string_lossy().into_owned(),
            structural_root: structural_root.to_string_lossy().into_owned(),
            cas_root: cas_root.to_string_lossy().into_owned(),
            sidecar_root: data_root.join("sidecar").to_string_lossy().into_owned(),
            scope: urdira_worker_protocol::ScanScope::Full,
            registry_snapshot_id: "registry:n8n-residual-debug".to_string(),
            configuration_revision_id: "configuration:n8n-residual-debug".to_string(),
            resolution_lock_id: "resolution:n8n-residual-debug".to_string(),
            deadline_ms: None,
            priority: ScanPriority::Interactive,
        };
        let mut syntax = SyntaxWorkerState::default();
        let mut worker_state: WorkerState = WorkerState::default();
        let mut on_queryable = |_event: IndexingEvent| -> Result<(), String> { Ok(()) };
        let cold_started = std::time::Instant::now();
        let cold_event = scan::run_with_residual(
            request,
            &mut syntax,
            &mut worker_state,
            &mut on_queryable,
            None,
        )
        .expect("cold scan succeeds");
        let base_generation = match cold_event {
            IndexingEvent::ScanCompleted { generation, .. } => generation,
            other => panic!("expected ScanCompleted, got {other:?}"),
        };
        eprintln!(
            "[n8n_residual_pass_debug_histogram] cold scan wall={:.3}s generation={base_generation}",
            cold_started.elapsed().as_secs_f64()
        );
        print_confirmed_possible_histogram("COLD", &structural_root, base_generation);
        let cold_mismatches =
            print_classification_mismatch_count("COLD", &structural_root, base_generation);
        // P1-D-h item 1 target: the cold-producer classification fix
        // (`materialize.rs`'s `repair_unresolved_confirmed_relation`) closes
        // this population at materialization time, before it is ever
        // published -- 31,917 (P1-D-g's own cold measurement) -> 0.
        assert_eq!(
            cold_mismatches, 0,
            "cold-scan classification mismatches should be exactly zero after the P1-D-h fix"
        );

        let context = ResidualContext {
            request_id: "request:n8n-residual-debug-upgrade".to_string(),
            workspace_id,
            workspace_root: workspace_root.to_string_lossy().into_owned(),
            database_path: database_path.to_string_lossy().into_owned(),
            structural_root: structural_root.to_string_lossy().into_owned(),
            cas_root: cas_root.to_string_lossy().into_owned(),
            registry_snapshot_id: "registry:n8n-residual-debug".to_string(),
            configuration_revision_id: "configuration:n8n-residual-debug".to_string(),
            resolution_lock_id: "resolution:n8n-residual-debug".to_string(),
            touched_owners: None,
            reschedule_count: 0,
        };
        let residual_started = std::time::Instant::now();
        let outcome = run_once_with_quiet_period(&context, 0, std::time::Duration::ZERO)
            .expect("residual pass does not error")
            // F4 4.1: no longer conditioned on pending call/heritage sites
            // existing -- the pass always produces an outcome once it has
            // at least one jsts file to run against (a cold scan's
            // `touched_owners` is `None`, so `file_map` covers the whole
            // n8n frontier regardless of `pending.sites`).
            .expect("residual pass always reports an outcome once file_map is non-empty");
        eprintln!(
            "[n8n_residual_pass_debug_histogram] residual pass wall={:.3}s total_ms={} upgraded={} external={} unresolved={} inferred_type_entities={} type_of_relations={} diagnostics_emitted={}",
            residual_started.elapsed().as_secs_f64(),
            outcome.timings.total_ms,
            outcome.upgraded_sites,
            outcome.external_sites,
            outcome.unresolved_sites,
            outcome.inferred_type_entities,
            outcome.type_of_relations,
            outcome.diagnostics_emitted,
        );

        // Decision 28's "inferred types" task, gate section: "sample of 200
        // type strings identical to v3" -- without a Rust body decoder (this
        // module's own constraint), this is checked by IDENTITY, not text:
        // a v3 `jsts:entity_inferred_type` row's own identity_key already
        // IS `jsts:inferred-type:{entity_id}:{sha256hex(canonical(type))}`
        // (verified byte-for-byte against a live oracle row this task's own
        // report documents) -- so if v4 independently computed the exact
        // same type text for the exact same entity, its OWN identity_key
        // string is byte-identical to v3's. Sampling v3's identities and
        // checking membership in v4's own live set is therefore an exact
        // (not approximate) "same type text" check, with no decode needed.
        // Opt-in via `URDIRA_V4_N8N_ORACLE_SQLITE=<path to the retained v3
        // oracle sqlite>` -- skipped (not failed) when unset, since this
        // retained oracle is a large (multi-GB), machine-local artifact not
        // every environment running this test will have.
        if let Ok(oracle_path) = std::env::var("URDIRA_V4_N8N_ORACLE_SQLITE") {
            let sample_size: usize = std::env::var("URDIRA_V4_N8N_ORACLE_SAMPLE")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(200);
            match sample_v3_inferred_type_identities(Path::new(&oracle_path), sample_size) {
                Ok(v3_sample) if !v3_sample.is_empty() => {
                    let store_after =
                        StoreReader::open(&structural_root).expect("store reopens for sampling");
                    let dicts_after = store_after.dictionaries();
                    let mut v4_live_identities: std::collections::HashSet<String> =
                        std::collections::HashSet::new();
                    for view in store_after.iter_visible(outcome.generation) {
                        if view.category() != CATEGORY_ENTITY {
                            continue;
                        }
                        let Some(kind) = dicts_after.kinds.get(view.kind_id() as usize) else {
                            continue;
                        };
                        if kind == "jsts:entity_inferred_type" {
                            v4_live_identities
                                .insert(String::from_utf8_lossy(&view.identity_key()).into_owned());
                        }
                    }
                    let matched = v3_sample
                        .iter()
                        .filter(|identity| v4_live_identities.contains(*identity))
                        .count();
                    eprintln!(
                        "[n8n_residual_pass_debug_histogram] type-text sample: {matched}/{} v3 jsts:entity_inferred_type identities also live in v4 (byte-identical type text, by identity match)",
                        v3_sample.len(),
                    );
                }
                Ok(_) => eprintln!(
                    "[n8n_residual_pass_debug_histogram] oracle sample: v3 oracle has zero jsts:entity_inferred_type rows -- nothing to sample"
                ),
                Err(error) => {
                    eprintln!("[n8n_residual_pass_debug_histogram] oracle sample skipped: {error}")
                }
            }
        } else {
            eprintln!(
                "[n8n_residual_pass_debug_histogram] set URDIRA_V4_N8N_ORACLE_SQLITE=<path> to also sample 200 v3 jsts:entity_inferred_type rows and check type-text identity against v4"
            );
        }

        print_confirmed_possible_histogram("AFTER", &structural_root, outcome.generation);
        let after_mismatches =
            print_classification_mismatch_count("AFTER", &structural_root, outcome.generation);
        // With the cold store already fully consistent (assert above), the
        // residual pass's own `repair_mismatched_row_if_needed` should never
        // find anything left to repair on a fresh corpus -- the 891 P1-D-g
        // reported here came entirely from the cold producer's own
        // inconsistent rows, now fixed at the source.
        assert_eq!(
            after_mismatches, 0,
            "post-residual classification mismatches should be exactly zero after the P1-D-h fix"
        );

        // P1-D-f deliverable 1: optional NDJSON-ish binary body dumps for
        // `scripts/v4-call-parity-diff.mjs` -- one at the cold generation,
        // one after the residual pass, so the diff script can join v3's
        // confirmed calls against BOTH v4 states in one script run (mostly
        // useful for confirming the residual pass's own delta matches the
        // Rust-side `upgraded` count independently, from the JS side).
        // Never enabled unless the caller opts in (this test's existing
        // `URDIRA_V4_N8N_*` env vars are unaffected either way).
        if let Ok(path) = std::env::var("URDIRA_V4_CALL_BODY_DUMP_COLD") {
            dump_call_bodies(
                &structural_root,
                &database_path,
                &context.workspace_id,
                base_generation,
                Path::new(&path),
            );
        }
        if let Ok(path) = std::env::var("URDIRA_V4_CALL_BODY_DUMP_AFTER") {
            dump_call_bodies(
                &structural_root,
                &database_path,
                &context.workspace_id,
                outcome.generation,
                Path::new(&path),
            );
        }
    }

    /// Decision 28's "inferred types" task, gate section: dumps `core:call`
    /// bodies for `scripts/v4-call-parity-diff.mjs` from an ALREADY-scanned
    /// n8n store (produced by a prior `n8n_residual_pass_debug_histogram`
    /// run against the same `URDIRA_V4_N8N_DATA`), without repeating the
    /// expensive cold-scan + residual pass -- this is purely a cheap
    /// read-and-dump over an existing store, so the "must still show 0
    /// `v4_confirmed_different_target` after the residual" gate can be
    /// checked without a second full n8n run. `URDIRA_V4_N8N_DATA=<same
    /// data root the histogram test used>` and `URDIRA_V4_CALL_BODY_DUMP_
    /// AFTER=<out path>` (cold dump via `URDIRA_V4_CALL_BODY_DUMP_COLD` is
    /// optional). Cold generation is assumed to be 1 (always true for the
    /// histogram test's own `ScanScope::Full` cold scan of an empty
    /// workspace); the "after" generation is read directly from the store's
    /// own current generation.
    #[test]
    #[ignore]
    fn n8n_dump_call_bodies_from_existing_store() {
        let Ok(data_root) = std::env::var("URDIRA_V4_N8N_DATA") else {
            eprintln!("set URDIRA_V4_N8N_DATA=<existing data root> to run this diagnostic");
            return;
        };
        let data_root = PathBuf::from(&data_root);
        let database_path = data_root.join("workspace.sqlite");
        let structural_root = data_root.join("structural");
        let workspace_id = "workspace:n8n-residual-debug";

        let store = StoreReader::open(&structural_root).expect("existing store opens");
        let after_generation = store.generation();
        drop(store);
        eprintln!(
            "[n8n_dump_call_bodies_from_existing_store] structural_root={} after_generation={after_generation}",
            structural_root.display(),
        );

        if let Ok(path) = std::env::var("URDIRA_V4_CALL_BODY_DUMP_COLD") {
            dump_call_bodies(
                &structural_root,
                &database_path,
                workspace_id,
                1,
                Path::new(&path),
            );
        }
        if let Ok(path) = std::env::var("URDIRA_V4_CALL_BODY_DUMP_AFTER") {
            dump_call_bodies(
                &structural_root,
                &database_path,
                workspace_id,
                after_generation,
                Path::new(&path),
            );
        }
    }

    /// P1-D-f deliverable 1: streams every visible `core:call` relation
    /// record's raw body bytes (both confirmed and possible -- the body
    /// payload itself carries `classification`, exactly like v3's own
    /// `record_occurrences.body_payload`; `canonical_span_and_evidence_
    /// match_the_v3_shape` above already established the two crates encode
    /// spans/evidence with the identical v3 JSON shape) to a length-prefixed
    /// binary file, mirroring `scripts/v4-spike-extract-relations.mjs`'s own
    /// wire format so `scripts/v4-call-parity-diff.mjs` can decode both v3's
    /// SQL rows and this dump with the SAME `@urdira/canonical`
    /// `decodeCanonical` call, rather than this crate re-deriving
    /// path/start/end from the store's own ordinal-keyed owner/subject
    /// dictionaries (a second, parallel, harder-to-trust implementation of
    /// logic `materialize.rs`/`urdira_jsts_syntax_worker` already own).
    ///
    /// Format (little-endian, matches `v4-spike-extract-relations.mjs`'s own
    /// doc comment except this dump carries whole raw bodies, not
    /// pre-extracted fields):
    ///   u32 row_count
    ///   repeated row_count times: u8 confirmed_flag, u32 body_len, then
    ///   that many raw bytes.
    ///
    /// `confirmed_flag` is `view.target_subject().is_some() && !"core:
    /// indirect"` (see this function's own body for the exact bit-test) --
    /// NOT the body's own `classification` field, and (P2-2j) NOT plain
    /// `target_subject().is_some()` alone any more either: a per-candidate
    /// row for an overload/union receiver (`urdira_jsts_syntax_worker::
    /// semantic_sites::candidate_call_record`) carries a resolved
    /// `target_subject` (it has a real `target_id`) but is `classification:
    /// "possible"` and always carries the `"core:indirect"` facet, same as
    /// every other possible row -- without the facet test, such a row would
    /// be miscounted as confirmed here even though it is never promoted to
    /// `classification: "confirmed"` anywhere in the pipeline. This
    /// distinction is load-bearing, confirmed live this session: decoding
    /// this exact dump's bodies in Node and splitting by `classification ===
    /// "confirmed"` instead gives 146,774 -- 29,033 MORE than this method's
    /// 117,741 -- for a generation where `print_confirmed_possible_
    /// histogram` independently reports 117,741 confirmed `core:call` rows
    /// via the SAME store-level signal. The two numbers are NOT
    /// interchangeable: some rows carry a `classification: "confirmed"` + a
    /// `target_id` string in their body (written once, at the row's OWN
    /// creation time) whose `target_subject` ordinal never actually resolved
    /// in this store (`materialize.rs`'s own subject-interning step,
    /// entirely outside this dump's or the residual pass's control) -- a
    /// real, pre-existing v4-internal inconsistency between the body's
    /// self-reported classification and the store's own resolved-subject
    /// bookkeeping, out of scope to fix here (v4/materialize.rs is the other
    /// agent's owned file this session), but dangerous to paper over
    /// silently in a parity-diff tool whose whole point is counting
    /// "confirmed" correctly -- hence carrying the authoritative flag
    /// explicitly rather than asking the diff script to re-derive it from a
    /// decode. `print_confirmed_possible_histogram` itself was NOT updated
    /// with the same facet test this session (out of this task's explicit
    /// file-scope) -- it is a `#[cfg(test)]`-only diagnostic print, not an
    /// assertion, but a future reader should know its confirmed count will
    /// overcount by the live candidate-row population once one exists.
    /// A2 (pending.sites migration) addendum: a no-target `core:call` site
    /// is no longer a RECORD at all (see this module's own module doc), so
    /// this dump ALSO synthesizes one `(confirmed=false, body)` entry per
    /// visible pending site of kind `Call` -- a canonical-encoded body in
    /// EXACTLY the shape `possible_call_record` used to emit (`{source_id,
    /// classification: "possible", path, start, end}`, no `target_id`),
    /// built through the SAME `materialize::kernel_rows_batches` kernel
    /// every other body in this dump goes through, so `scripts/v4-call-
    /// parity-diff.mjs`'s `decodeCanonical` call sees byte-for-byte the same
    /// population it always did -- this dump's own wire FORMAT (`u32 row_
    /// count` + repeated `u8 confirmed_flag, u32 body_len, bytes`) is
    /// unchanged, only the SOURCE of a "possible, no target" row moved from
    /// a relation record to a `pending.sites` row. `database_path`/
    /// `workspace_id` are needed (new parameters) purely to resolve each
    /// pending site's own `owner_artifact` ordinal back to a path, the same
    /// way `run_once_with_quiet_period` above already does.
    /// Reads up to `sample_size` `jsts:entity_inferred_type` identity_key
    /// strings from a retained v3 oracle SQLite DB (opened read-only,
    /// `?mode=ro`), via `identity_assignments` joined to `record_occurrences`
    /// filtered to that kind and `valid_to_generation IS NULL` (still live).
    /// Not ordered randomly (`LIMIT` alone, deterministic) -- a real,
    /// reproducible sample is more useful for this diagnostic than a fresh
    /// random one on every run, and avoids `ORDER BY random()`'s full-table
    /// sort cost on a table with tens of thousands of rows.
    fn sample_v3_inferred_type_identities(
        oracle_path: &Path,
        sample_size: usize,
    ) -> Result<Vec<String>, String> {
        let uri = format!("file:{}?mode=ro", oracle_path.display());
        let conn = rusqlite::Connection::open_with_flags(
            &uri,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|e| format!("opening oracle sqlite failed: {e}"))?;
        conn.busy_timeout(std::time::Duration::from_secs(30))
            .map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT ia.identity_key FROM identity_assignments ia \
                 JOIN record_occurrences ro ON ro.record_id = ia.record_id \
                 WHERE ro.kind = 'jsts:entity_inferred_type' AND ro.valid_to_generation IS NULL \
                 LIMIT ?1",
            )
            .map_err(|e| format!("preparing oracle query failed: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![sample_size as i64], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| format!("querying oracle rows failed: {e}"))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| format!("reading oracle row failed: {e}"))?);
        }
        Ok(out)
    }

    fn dump_call_bodies(
        structural_root: &Path,
        database_path: &Path,
        workspace_id: &str,
        generation: u64,
        out_path: &Path,
    ) {
        let store = StoreReader::open(structural_root).expect("store reopens for call body dump");
        let dicts = store.dictionaries();
        // P2-2j: `target_subject().is_some()` ALONE is no longer a correct
        // confirmed test -- a candidate row (`urdira_jsts_syntax_worker::
        // semantic_sites::candidate_call_record`, an overload/union
        // receiver's per-candidate `possible` row) also carries a resolved
        // `target_subject`, but is `classification: "possible"` and carries
        // the `"core:indirect"` facet, same as every other possible row
        // (`materialize.rs`'s `FACET_ORDER`/`facets_bitmask` assign it a
        // fixed bit position, mirrored in `Dictionaries::facet_names` at the
        // same ordinal -- see that struct's own doc comment in `row.rs`).
        // A row is genuinely CONFIRMED only when it has a resolved target
        // AND does NOT carry that facet.
        let indirect_bit = dicts
            .facet_names
            .iter()
            .position(|name| name == "core:indirect")
            .expect("FACET_ORDER (materialize.rs) always registers core:indirect");
        let mut rows: Vec<(bool, Vec<u8>)> = Vec::new();
        for view in store.iter_visible(generation) {
            if view.category() != CATEGORY_RELATION {
                continue;
            }
            let universal_kind = dicts
                .universal_kinds
                .get(view.universal_kind_id() as usize)
                .map(String::as_str)
                .unwrap_or("");
            if universal_kind != "core:call" {
                continue;
            }
            let confirmed =
                view.target_subject().is_some() && (view.facets() & (1u64 << indirect_bit)) == 0;
            rows.push((confirmed, view.body().to_vec()));
        }

        // A2: pending call sites, synthesized as "possible without target".
        let conn = catalog::open_and_ensure_schema(database_path)
            .expect("catalog opens for call body dump");
        let frontier =
            Frontier::load(&conn, workspace_id).expect("frontier loads for call body dump");
        drop(conn);
        let mut path_by_pair: HashMap<(String, String), String> = HashMap::new();
        for (path, entry) in &frontier.present {
            path_by_pair.insert(
                (entry.artifact_id.clone(), entry.artifact_version_id.clone()),
                path.clone(),
            );
        }
        let owner_path = |ordinal: u32| -> Option<String> {
            dicts
                .artifacts
                .get(ordinal as usize)
                .and_then(|pair| path_by_pair.get(pair))
                .cloned()
        };
        let mut pending_dumped = 0u64;
        for view in store.iter_visible_pending_sites(generation) {
            if view.site_kind() != urdira_structural_store::PENDING_SITE_KIND_CALL {
                continue;
            }
            let Some(path) = owner_path(view.owner_artifact()) else {
                continue;
            };
            let Some(source_id) = view
                .source_subject()
                .and_then(|ordinal| dicts.subjects.get(ordinal as usize))
                .and_then(|record_id| store.get_visible(record_id, generation))
                .map(|source_view| {
                    String::from_utf8_lossy(&source_view.identity_key()).into_owned()
                })
            else {
                continue;
            };
            let start = view.start();
            let end = view.end();
            let identity_key = format!("jsts:call:{path}:{start}:{end}:{source_id}:unresolved");
            let body_value = serde_json::json!({
                "source_id": source_id,
                "classification": "possible",
                "path": path,
                "start": start,
                "end": end,
            });
            let facets_str = serde_json::to_string(&serde_json::json!([
                "core:reference_relation",
                "core:indirect"
            ]))
            .expect("json serializes");
            let source_span_str = serde_json::to_string(
                &serde_json::json!({"path": path, "start": start, "end": end}),
            )
            .expect("json serializes");
            let evidence_str = serde_json::to_string(&serde_json::json!([
                {"path": path, "start": start, "end": end}
            ]))
            .expect("json serializes");
            let dump_proposal_key = format!("dump-only:{identity_key}");
            let record_key = StructuralKernelRecordRef {
                proposal_record_key: &dump_proposal_key,
                category: "relation",
                kind: "jsts:relation_call",
                universal_kind: "core:call",
                facets: &facets_str,
                schema_version: 1,
                source_span: &source_span_str,
                identity_key: &identity_key,
                body: urdira_native_core::BodyRef::Value(&body_value),
                evidence_references: &evidence_str,
            };
            let Ok(mut batches) =
                materialize::kernel_rows_batches(std::slice::from_ref(&record_key))
            else {
                continue;
            };
            let Some(kernel_rows) = batches.pop() else {
                continue;
            };
            let Some(kernel_row) = kernel_rows.rows.into_iter().next() else {
                continue;
            };
            rows.push((false, kernel_row.body));
            pending_dumped += 1;
        }
        eprintln!("[dump_call_bodies] pending call sites dumped as possible: {pending_dumped}");

        use std::io::Write;
        let file = std::fs::File::create(out_path)
            .unwrap_or_else(|error| panic!("create call body dump {out_path:?}: {error}"));
        let mut writer = std::io::BufWriter::new(file);
        writer
            .write_all(&(rows.len() as u32).to_le_bytes())
            .expect("write row count");
        let mut confirmed_flag_count = 0u64;
        for (confirmed, body) in &rows {
            writer
                .write_all(&[u8::from(*confirmed)])
                .expect("write confirmed flag");
            if *confirmed {
                confirmed_flag_count += 1;
            }
            writer
                .write_all(&(body.len() as u32).to_le_bytes())
                .expect("write body length");
            writer.write_all(body).expect("write body bytes");
        }
        writer.flush().expect("flush call body dump");
        eprintln!(
            "[dump_call_bodies] generation={generation} rows={} confirmed(target_subject)={confirmed_flag_count} -> {out_path:?}",
            rows.len()
        );
    }

    /// P1-D-d deliverable 4: the ONE authoritative confirmed/possible count
    /// this evidence doc uses for cold/after/v3 alike -- a Rust-side,
    /// metadata-only `StoreReader::iter_visible` scan (no
    /// `@urdira/canonical` body decode at all), splitting `core:call` and
    /// `core:inherits`/`core:implements` via [`classify_confirmed_possible`]
    /// (plan 3.4: this task extracted that classification out of this
    /// function's own former `target_subject().is_some()`-only body so
    /// `tests_e2e.rs`'s `inspect_store_record_histogram` -- which used to
    /// reimplement a similar but NOT identical, facet-bit-aware version of
    /// this same split because `residual` was otherwise opaque to it --
    /// shares the exact same code instead of drifting from it). See that
    /// function's own doc comment for why `target_subject().is_some()`
    /// alone stopped being sufficient after P2-2i (2026-09-04): this
    /// function's numbers for `*_possible` were effectively always ~0
    /// before that fix, since a possible/candidate row carries a target
    /// too and this function had no way to tell it apart from a genuinely
    /// confirmed one. Printing this at both the cold generation and the
    /// post-upgrade generation of the SAME corpus checkout/worker binary in
    /// the SAME test run eliminates the cross-session drift the P1-D-c
    /// evidence doc could not rule out for its own 96,847-vs-64,931
    /// discrepancy.
    fn print_confirmed_possible_histogram(label: &str, structural_root: &Path, generation: u64) {
        let store = StoreReader::open(structural_root).expect("store reopens for histogram");
        let dicts = store.dictionaries();
        let (mut call_confirmed, mut call_possible) = (0u64, 0u64);
        let (mut heritage_confirmed, mut heritage_possible) = (0u64, 0u64);
        for view in store.iter_visible(generation) {
            match classify_confirmed_possible(&view, &dicts) {
                Some((SiteFamily::Call, true)) => call_confirmed += 1,
                Some((SiteFamily::Call, false)) => call_possible += 1,
                Some((SiteFamily::Heritage, true)) => heritage_confirmed += 1,
                Some((SiteFamily::Heritage, false)) => heritage_possible += 1,
                None => {}
            }
        }
        eprintln!(
            "[confirmed_possible_histogram] {label} generation={generation} core:call confirmed={call_confirmed} possible={call_possible} | heritage confirmed={heritage_confirmed} possible={heritage_possible} | confirmed_combined={}",
            call_confirmed + heritage_confirmed,
        );
    }

    /// P1-D-g deliverable 1's own invariant, printed at both the cold and
    /// post-upgrade generation so a reader can see how much of the
    /// population this session's `repair_mismatched_row_if_needed` actually
    /// closes on one real corpus run. P1-D-h: returns the count too, so
    /// callers can assert on it directly (the cold-producer fix,
    /// `materialize.rs`'s own `repair_unresolved_confirmed_relation`, is
    /// meant to drive BOTH the cold and the post-residual count to exactly
    /// zero -- the residual pass's own `repair_mismatched_row_if_needed`
    /// only ever had anything left to repair because the cold producer
    /// handed it inconsistent rows in the first place).
    /// P1-D-h temporary diagnostic: dumps every remaining classification-
    /// mismatched identity string in an already-scanned store, so a rare
    /// leftover (e.g. cold mismatches=2 on one real n8n run, vs the
    /// expected 0) can be inspected without re-running the whole cold scan.
    /// Point `URDIRA_V4_MISMATCH_DUMP_DATA` at an existing `URDIRA_V4_N8N_
    /// DATA` directory from a prior (even failed) run of `n8n_residual_
    /// pass_debug_histogram`.
    #[test]
    #[ignore]
    fn dump_remaining_classification_mismatches() {
        let Ok(data_root) = std::env::var("URDIRA_V4_MISMATCH_DUMP_DATA") else {
            eprintln!("set URDIRA_V4_MISMATCH_DUMP_DATA=<existing-data-dir>");
            return;
        };
        let structural_root = PathBuf::from(&data_root).join("structural");
        let store = StoreReader::open(&structural_root).expect("store reopens");
        let dicts = store.dictionaries();
        let generation: u64 = std::env::var("URDIRA_V4_MISMATCH_DUMP_GENERATION")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(1);
        eprintln!("generation={generation}");
        for view in store.iter_visible(generation) {
            if view.category() != CATEGORY_RELATION {
                continue;
            }
            let universal_kind = dicts
                .universal_kinds
                .get(view.universal_kind_id() as usize)
                .map(String::as_str)
                .unwrap_or("");
            if !matches!(
                universal_kind,
                "core:call" | "core:inherits" | "core:implements"
            ) {
                continue;
            }
            let identity = String::from_utf8_lossy(&view.identity_key()).into_owned();
            if !is_classification_consistent(view.target_subject().is_some()) {
                let owner_pair = dicts.artifacts.get(view.owner_artifact() as usize);
                eprintln!(
                    "MISMATCH universal_kind={universal_kind} target_subject={:?} \
                     record_id={} owner_artifact_ordinal={} owner_pair={:?} \
                     span={}..{} identity_len={} body_len={} identity={identity:?}",
                    view.target_subject(),
                    materialize::hex_encode(&view.record_id()),
                    view.owner_artifact(),
                    owner_pair,
                    view.span_start_byte(),
                    view.span_end_byte(),
                    view.identity_key().len(),
                    view.body().len(),
                );
            }
        }
    }

    /// P1-D-h temporary diagnostic: scans EVERY record (any category), not
    /// just `core:call`/`core:inherits`/`core:implements`, for an all-zero
    /// `identity_key` or `record_digest` -- to tell whether the rare (2-in-
    /// 2.83M, non-deterministic) corruption this session found is scoped to
    /// records `repair_unresolved_confirmed_relation`/`plan_relation_
    /// repair` ever touches, or is a broader, pre-existing issue.
    #[test]
    #[ignore]
    fn scan_for_any_all_zero_identity_or_digest() {
        let Ok(data_root) = std::env::var("URDIRA_V4_MISMATCH_DUMP_DATA") else {
            eprintln!("set URDIRA_V4_MISMATCH_DUMP_DATA=<existing-data-dir>");
            return;
        };
        let structural_root = PathBuf::from(&data_root).join("structural");
        let store = StoreReader::open(&structural_root).expect("store reopens");
        let dicts = store.dictionaries();
        let generation: u64 = std::env::var("URDIRA_V4_MISMATCH_DUMP_GENERATION")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(1);
        let mut total = 0u64;
        let mut zero_identity = 0u64;
        let mut zero_digest = 0u64;
        for view in store.iter_visible(generation) {
            total += 1;
            if view.identity_key().iter().all(|byte| *byte == 0) {
                zero_identity += 1;
                let kind = dicts
                    .kinds
                    .get(view.kind_id() as usize)
                    .map(String::as_str)
                    .unwrap_or("");
                eprintln!(
                    "ZERO_IDENTITY category={} kind={kind} len={} record_id={} \
                     identity_key_digest={} body_len={} body_all_zero={} \
                     record_digest={} name_id={:?} owner_artifact={}",
                    view.category(),
                    view.identity_key().len(),
                    materialize::hex_encode(&view.record_id()),
                    materialize::hex_encode(&view.identity_key_digest()),
                    view.body().len(),
                    view.body().iter().all(|b| *b == 0),
                    materialize::hex_encode(&view.record_digest()),
                    view.name_id(),
                    view.owner_artifact(),
                );
            }
            if view.record_digest().iter().all(|byte| *byte == 0) {
                zero_digest += 1;
            }
        }
        eprintln!(
            "scan_for_any_all_zero_identity_or_digest: total={total} zero_identity={zero_identity} zero_digest={zero_digest}"
        );
    }

    fn print_classification_mismatch_count(
        label: &str,
        structural_root: &Path,
        generation: u64,
    ) -> u64 {
        let store = StoreReader::open(structural_root).expect("store reopens for mismatch count");
        let dicts = store.dictionaries();
        let mismatches = count_classification_mismatches(&store, &dicts, generation);
        eprintln!(
            "[classification_mismatch_count] {label} generation={generation} mismatches={mismatches}"
        );
        mismatches
    }
}
