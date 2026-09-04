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
//! - whether it is `possible` (`target_subject().is_none()` -- a possible
//!   row never has one, a confirmed row always does; see
//!   `materialize.rs`'s subject-resolution pass),
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
use urdira_structural_store::reader::RecordView;
use urdira_structural_store::row::{CATEGORY_ENTITY, CATEGORY_RELATION, Dictionaries, RecordRow};
use urdira_structural_store::{SetKind, StoreReader, merkle};
use urdira_tsgo_client::binary;
use urdira_tsgo_client::entity_index::EntityIndex;
use urdira_tsgo_client::residual_pass::{
    ResidualPass, ResidualPassConfig, ResolvedSite, SiteOutcome, WindowPlan,
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
}

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
                    "[urdira-indexing-worker] v4 residual pass complete workspace={workspace_id} generation={} upgraded={} external={} unresolved={} total_ms={}",
                    outcome.generation,
                    outcome.upgraded_sites,
                    outcome.external_sites,
                    outcome.unresolved_sites,
                    outcome.timings.total_ms,
                );
                if let Some(target) = event_target {
                    let event = IndexingEvent::UpgradeCompleted {
                        request_id: context.request_id.clone(),
                        operation_id: context.request_id.clone(),
                        generation: outcome.generation,
                        upgraded_sites: outcome.upgraded_sites,
                        external_sites: outcome.external_sites,
                        unresolved_sites: outcome.unresolved_sites,
                        timings: outcome.timings,
                    };
                    let _ = target
                        .sender
                        .send((target.stream_id, target.cancellation_id, event));
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
    pub timings: ScanTimings,
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

    let collected = collect(&store, &dicts, &owner_path, base_generation);
    if collected.pending_by_owner.is_empty() {
        // Genuine completion, not a supersede: nothing was pending, so
        // there is nothing further to run for this generation. Report it
        // (rather than `Ok(None)`, this module's "superseded, stay
        // silent" signal) so a caller like `schedule` can still emit
        // `UpgradeCompleted` -- the daemon's own status lane needs SOME
        // terminal signal per generation to know a residual attempt
        // finished, even an attempt that found nothing to do (see
        // `packages/daemon/src/runtime.ts`'s `v4SemanticUpgradeState`).
        return Ok(Some(ResidualOutcome {
            generation: base_generation,
            upgraded_sites: 0,
            external_sites: 0,
            unresolved_sites: 0,
            timings: ScanClock::start().completed_timings(),
        }));
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
    let workspace_root = VIRTUAL_ROOT.to_string();
    let mut file_map: BTreeMap<String, String> = BTreeMap::new();
    for (path, entry) in &frontier.present {
        if !is_jsts_source_path(path) {
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
    };

    let resolved = ResidualPass::run(&plan, residual_lanes(), &pending_by_owner, fs, &config)
        .map_err(|error| ScanError(format!("v4 residual: checker pass failed: {error}")))?;
    clock.record_resolve(resolve_started.elapsed());
    let debug_enabled = std::env::var_os("URDIRA_V4_RESIDUAL_DEBUG").is_some();
    let site_dump_path = std::env::var("URDIRA_V4_RESIDUAL_SITE_DUMP").ok();
    let mut debug = (debug_enabled || site_dump_path.is_some())
        .then(|| ResidualDebug::new(site_dump_path.as_deref()));
    if let Some(debug) = debug.as_mut() {
        debug.record_pass(&resolved, &file_map);
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
        // Re-verify this exact possible row is still the live occurrence
        // before touching it (see the fresh-`StoreReader` re-open above).
        let Some(current) = store.get_visible(&meta.possible_record_id, publish_generation) else {
            continue;
        };
        if current.target_subject().is_some() {
            continue; // already upgraded by some other means since collection
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
                            .and_then(decode_hex32)
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
                            String::from_utf8_lossy(view.identity_key()).into_owned(),
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
                    &current,
                    &store,
                    publish_generation,
                    new_generation_u32,
                    &mut kinds_dict,
                    &mut universal_kinds_dict,
                    &mut relation_kinds_dict,
                    &mut names_dict,
                    &mut subjects_dict,
                )?;
                match confirmed {
                    Some(confirmed) => {
                        record_closures.push((meta.possible_record_id, new_generation_u32));
                        closed_relation_keys.push(meta.possible_record_id);
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
                external += 1;
                repair_mismatched_row_if_needed(
                    meta,
                    &store_path,
                    site.start_utf16,
                    site.end_utf16,
                    &current,
                    &store,
                    publish_generation,
                    new_generation_u32,
                    &mut kinds_dict,
                    &mut universal_kinds_dict,
                    &mut relation_kinds_dict,
                    &mut names_dict,
                    &mut opened_records,
                    &mut record_closures,
                    &mut closed_relation_keys,
                    debug.as_mut(),
                );
            }
            SiteOutcome::Unresolved { .. } => {
                unresolved += 1;
                repair_mismatched_row_if_needed(
                    meta,
                    &store_path,
                    site.start_utf16,
                    site.end_utf16,
                    &current,
                    &store,
                    publish_generation,
                    new_generation_u32,
                    &mut kinds_dict,
                    &mut universal_kinds_dict,
                    &mut relation_kinds_dict,
                    &mut names_dict,
                    &mut opened_records,
                    &mut record_closures,
                    &mut closed_relation_keys,
                    debug.as_mut(),
                );
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

    if opened_records.is_empty() {
        return Ok(Some(ResidualOutcome {
            generation: publish_generation,
            upgraded_sites: 0,
            external_sites: external,
            unresolved_sites: unresolved,
            timings: clock.completed_timings(),
        }));
    }

    if current_epoch(&context.workspace_id) != my_epoch {
        return Ok(None);
    }

    let write_started = std::time::Instant::now();
    let mut new_dicts = dicts.clone();
    new_dicts.names = names_dict.into_values();
    new_dicts.subjects = subjects_dict.into_values();
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
        .write_delta_with_reader(
            structural_root,
            &store,
            &opened_records,
            &record_closures,
            &[],
            &[],
            &dict_additions,
            new_generation,
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
        timings: clock.completed_timings(),
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

/// One possible relation row this pass may upgrade.
struct PendingMeta {
    possible_record_id: [u8; 32],
    source_id: String,
    relation_kind: &'static str,
    /// See `collect()`'s own comment at `was_mismatched`'s computation:
    /// `true` when this row's identity already claimed a resolved target
    /// (`classification: "confirmed"` in its body, per
    /// `is_classification_consistent`'s rule) despite `target_subject()`
    /// being `None` at the store level. Drives the materialize loop's own
    /// repair step for a site this pass's checker attempt could NOT
    /// confirm.
    was_mismatched: bool,
}

struct Collected {
    pending_by_owner: BTreeMap<String, Vec<PendingSite>>,
    by_site: HashMap<String, PendingMeta>,
    entities: EntityIndex,
}

/// One full pass over every visible record (see this module's doc comment,
/// "Store access without a body decoder"): branches into either an entity-
/// index entry or a possible-relation pending site, using only metadata
/// columns, never `RecordView::body()`.
fn collect(
    store: &StoreReader,
    dicts: &Dictionaries,
    owner_path: &dyn Fn(u32) -> Option<String>,
    generation: u64,
) -> Collected {
    let mut pending_by_owner: BTreeMap<String, Vec<PendingSite>> = BTreeMap::new();
    let mut by_site: HashMap<String, PendingMeta> = HashMap::new();
    let mut entity_entries: Vec<(String, i32, String)> = Vec::new();

    for view in store.iter_visible(generation) {
        match view.category() {
            CATEGORY_ENTITY => {
                let Some(path) = owner_path(view.owner_artifact()) else {
                    continue;
                };
                entity_entries.push((
                    path,
                    view.span_start_byte() as i32,
                    materialize::hex_encode(&view.record_id()),
                ));
            }
            CATEGORY_RELATION => {
                if view.target_subject().is_some() {
                    continue; // already confirmed
                }
                let universal_kind = dicts
                    .universal_kinds
                    .get(view.universal_kind_id() as usize)
                    .map(String::as_str)
                    .unwrap_or("");
                let (site_kind, relation_kind): (SiteKind, &'static str) = match universal_kind {
                    "core:call" => (SiteKind::Call, "call"),
                    "core:inherits" => (SiteKind::Heritage, "inherits"),
                    "core:implements" => (SiteKind::Heritage, "implements"),
                    _ => continue,
                };
                let Some(path) = owner_path(view.owner_artifact()) else {
                    continue;
                };
                let start = view.span_start_byte() as i32;
                let end = view.span_end_byte() as i32;
                let identity_str = String::from_utf8_lossy(view.identity_key()).into_owned();
                // P1-D-g item 1: whether THIS row's own identity already
                // claims a resolved target (`is_classification_consistent`'s
                // own doc comment has the full rule) -- independent of
                // whether `source_id` below can be recovered at all. A
                // `call` relation whose identity does NOT end in the fixed
                // `:unresolved` sentinel (`possible_call_record`'s own
                // literal, `urdira_jsts_syntax_worker::semantic_sites`) but
                // whose `target_subject()` is still `None` here (this match
                // arm's own precondition) is exactly the "classification
                // mismatch" population the evidence doc's item 1
                // characterizes: `semantic_sites.rs` (out of this module's
                // ownership) wrote `classification: "confirmed"` + a real
                // `target_id` into `body` at creation time, but
                // `materialize.rs`'s own subject-resolution pass (also out
                // of ownership) never interned that target. Recorded here,
                // metadata-only, so the materialize loop below can decide
                // whether a failed re-resolution attempt must REPAIR this
                // row (rewrite it to the canonical, self-consistent
                // `possible` shape) rather than leave a permanently
                // inconsistent ghost.
                let was_mismatched =
                    relation_kind == "call" && !identity_str.ends_with(":unresolved");
                let source_id = view
                    .source_subject()
                    .and_then(|ordinal| dicts.subjects.get(ordinal as usize))
                    .and_then(|record_id| store.get_visible(record_id, generation))
                    .map(|source_view| {
                        String::from_utf8_lossy(source_view.identity_key()).into_owned()
                    })
                    // P1-D-f: `source_subject()` is `None` whenever the
                    // call's OWN enclosing scope is a class/interface member
                    // (method/constructor/getter/setter) -- v4's entity
                    // schema has no such entities at all (P1-D-d's dominant
                    // root cause, §1 of that evidence doc), so the ordinary
                    // subject-resolution pass this relation went through at
                    // COLD-SCAN TIME could never have interned a source
                    // subject for it either, symmetric to (but distinct
                    // from) the already-fixed TARGET-side gap
                    // `try_synthesize_member_entity` closes below. Before
                    // this fallback, EVERY such call site was silently
                    // dropped right here, before ever becoming a
                    // `PendingSite` -- never reaching the checker at all, no
                    // matter how resolvable its target was (confirmed live,
                    // P1-D-f's own parity diff: sites like `docker-
                    // config.mjs`'s `determine` method calling its own
                    // `sanitizeBranch` method, an entirely ordinary in-file
                    // call, were invisible to `ResidualDebug`'s own per-site
                    // dump even though the possible relation row plainly
                    // existed). Recovered here from the relation's OWN
                    // `identity_key()` metadata column (never `body()` --
                    // this module's own "no body decode" invariant, this
                    // doc comment's own header, stays intact): a possible
                    // `core:call` relation's identity is always exactly
                    // `jsts:call:{path}:{start}:{end}:{source_id}:unresolved`
                    // (`urdira_jsts_syntax_worker::semantic_sites`'s own
                    // `proposal_relation_identity`-shaped literal, confirmed
                    // against that crate's source), so the embedded
                    // `source_id` -- itself a compound `jsts:{kind}:...`
                    // string that may contain its own colons -- is
                    // recoverable by stripping the ALREADY-KNOWN
                    // `path`/`start`/`end` prefix and the fixed
                    // `:unresolved` suffix, no canonical/body decode
                    // required. Heritage relations (`inherits`/`implements`)
                    // are NOT covered (a much smaller population, ~1,900
                    // sites total on this corpus, and their own identity
                    // literal was not independently confirmed this
                    // session) -- unchanged, still skipped on a
                    // `source_subject` miss.
                    // P1-D-g: generalized beyond the `:unresolved`-only
                    // shape to ALSO cover the classification-mismatch case
                    // above (`was_mismatched`): there, `rest` is
                    // `{source_id}:{target_id}`, both 5-colon-field
                    // `jsts:{kind}:{path}:{start}:{name}` compound ids
                    // (`declaration_id`/`stable_entity_id`'s own shared
                    // recipe, verified against both crates' source) rather
                    // than a single `{source_id}:unresolved`. Splitting
                    // unambiguously requires a known FIELD COUNT, not a
                    // delimiter (both halves may themselves contain `:` in
                    // their own `path` segment in principle, though not in
                    // practice for a real filesystem path -- the same
                    // assumption the exact-string prefix strip just above
                    // already relies on): a genuinely 10-field remainder
                    // splits 5-and-5; anything else is left unrecovered
                    // (best-effort, matches this fallback's own existing
                    // "silently drop, do not fabricate" precedent) rather
                    // than guessed.
                    .or_else(|| {
                        if relation_kind != "call" {
                            return None;
                        }
                        let prefix = format!("jsts:call:{path}:{start}:{end}:");
                        let rest = identity_str.strip_prefix(prefix.as_str())?;
                        if let Some(source) = rest.strip_suffix(":unresolved") {
                            return Some(source.to_string());
                        }
                        let tokens: Vec<&str> = rest.split(':').collect();
                        (tokens.len() == 10).then(|| tokens[..5].join(":"))
                    });
                let Some(source_id) = source_id else {
                    continue;
                };
                let key = correlation_key(&path, start, end, site_kind);
                by_site.insert(
                    key,
                    PendingMeta {
                        possible_record_id: view.record_id(),
                        source_id,
                        relation_kind,
                        was_mismatched,
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
            _ => {}
        }
    }

    Collected {
        pending_by_owner,
        by_site,
        entities: EntityIndex::build(entity_entries),
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
    let mut body = serde_json::Map::new();
    body.insert("name".into(), serde_json::Value::String(name.clone()));
    body.insert(
        "kind".into(),
        serde_json::Value::String(kind_name.to_string()),
    );
    body.insert(
        "language".into(),
        serde_json::Value::String("typescript".into()),
    );
    body.insert("path".into(), serde_json::Value::String(real_path.clone()));
    body.insert("start".into(), serde_json::Value::from(decl_start));
    body.insert("end".into(), serde_json::Value::from(decl_end));
    body.insert(
        "synthesized_by".into(),
        serde_json::Value::String("v4_residual_pass".into()),
    );
    let body = serde_json::Value::Object(body);
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
        body: &body,
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
        span_start_line: 0,
        span_end_line: 0,
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
    predecessor: &RecordView,
    store: &StoreReader,
    generation: u64,
    new_generation: u32,
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

    let mut body = serde_json::Map::new();
    body.insert(
        "source_id".into(),
        serde_json::Value::String(source_id.to_string()),
    );
    body.insert(
        "target_id".into(),
        serde_json::Value::String(target_id.to_string()),
    );
    body.insert(
        "classification".into(),
        serde_json::Value::String("confirmed".into()),
    );
    body.insert("path".into(), serde_json::Value::String(path.to_string()));
    body.insert("start".into(), serde_json::Value::from(start));
    body.insert("end".into(), serde_json::Value::from(end));
    let body = serde_json::Value::Object(body);

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
        body: &body,
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
    // P1-D-g: the dominant cause of `confirmed_row_build_failed` (see the
    // evidence doc's own §2 -- 15,590 rows, flat across every prior session)
    // is NOT a genuine identity collision between two different sites: it is
    // this exact confirmed identity ALREADY being live as `predecessor`
    // itself. This happens for a "classification mismatch" possible row
    // (`is_classification_consistent`'s own doc comment): `semantic_sites.rs`
    // (E1-E3 typeflow, out of this module's ownership) already wrote a
    // relation row whose identity embeds the SAME resolved target this
    // checker pass just independently re-derived, with `classification:
    // "confirmed"` in its body -- but `materialize.rs`'s own subject-
    // resolution pass (also out of this module's ownership) never interned
    // that target into `target_subject`, so the row is still `possible` at
    // the store level and was collected as a pending site. When the checker
    // resolves it to the SAME target typeflow already believed (the common
    // case -- typeflow is usually right), the freshly-computed confirmed
    // identity is byte-for-byte identical to `predecessor`'s own identity,
    // so `by_identity_last` finds `predecessor` itself and the OLD "already
    // live somewhere" guard bailed out here, incorrectly treating "the exact
    // row I am about to supersede" as if it were a different, colliding row.
    // The fix: only fail closed when a DIFFERENT record occupies this
    // identity (`last.record_id() != predecessor.record_id()`) -- when it is
    // `predecessor` itself, this is not a collision at all, just the normal
    // supersede-and-chain case one arm below.
    let (record_id, record_digest, previous_record_id) =
        match store.by_identity_last(&identity_key_digest) {
            Some(last)
                if last.is_visible(generation) && last.record_id() != predecessor.record_id() =>
            {
                // A genuinely DIFFERENT row already occupies this exact
                // identity -- not expected for a content-derived identity
                // that embeds its own exact source span, but fail closed
                // rather than risk a duplicate.
                return Ok(None);
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
    let relation_kind_id =
        u16::try_from(relation_kinds_dict.intern(&universal_kind)).unwrap_or(u16::MAX);
    let name_id = names_dict.intern(&materialize::identity_key_name(&identity_key).to_owned());
    let source_subject = predecessor.source_subject();
    let target_subject = Some(subjects_dict.intern(target_record_id));

    Ok(Some(RecordRow {
        record_id,
        owner_artifact: predecessor.owner_artifact(),
        owner_version: predecessor.owner_version(),
        valid_from: new_generation,
        valid_to: 0,
        category: CATEGORY_RELATION,
        kind_id,
        universal_kind_id,
        facets: materialize::facets_bitmask(&kernel_row.facets),
        span_artifact_version: predecessor.owner_artifact(),
        span_start_byte: kernel_row.span_start,
        span_end_byte: kernel_row.span_end,
        span_start_line: 0,
        span_end_line: 0,
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

/// P1-D-g item 1's own correctness rule, in its most reducible form: a
/// `core:call`/`core:inherits`/`core:implements` relation row's identity
/// already embeds whether ITS OWN producer believed the target resolved
/// (any real `target_id` suffix) or not (the fixed `:unresolved` sentinel
/// `possible_call_record`/`heritage_proposed_record` always use for a
/// genuinely possible row, `urdira_jsts_syntax_worker::semantic_sites`,
/// confirmed against that crate's source) -- and that MUST agree with the
/// store's own, independently-derived `target_subject().is_some()`. `false`
/// here is the exact "classification mismatch" signature this task exists
/// to close: a row whose body says `classification: "confirmed"` (implied
/// by a non-`:unresolved` identity) but whose target never actually got
/// interned by `materialize.rs`'s own subject-resolution pass (out of this
/// module's ownership -- see the evidence doc for why this cannot be fixed
/// at the producer/materialize layer this session), or -- the inverse,
/// unexpected in practice but checked anyway rather than assumed away -- a
/// row whose identity claims NO target but the store somehow resolved one.
/// Pure and metadata-only: no `@urdira/canonical` body decode needed, since
/// every producer this codebase has (`semantic_sites.rs`'s two builders,
/// `build_confirmed_row` above) always writes `body.classification`
/// consistently with its OWN identity's `{target|unresolved}` suffix at
/// creation time -- the bug this rule catches is exclusively a later,
/// store-level divergence from what the identity already promised.
fn is_classification_consistent(identity_key: &str, target_subject_is_some: bool) -> bool {
    identity_key.ends_with(":unresolved") != target_subject_is_some
}

/// Store-wide scan (P1-D-g's own invariant, deliverable 1): counts every
/// visible `core:call`/`core:inherits`/`core:implements` relation row where
/// [`is_classification_consistent`] returns `false`. Metadata-only (no body
/// decode), so this runs cheaply even at n8n scale and can be called both
/// before and after a residual pass to measure how much of the population
/// this pass's own repair step ( see `repair_mismatched_row_if_needed`)
/// actually closes.
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
        let identity = String::from_utf8_lossy(view.identity_key());
        if !is_classification_consistent(&identity, view.target_subject().is_some()) {
            mismatches += 1;
        }
    }
    mismatches
}

/// P1-D-g item 1's repair step: called from the materialize loop for every
/// `External`/`Unresolved` outcome. A no-op unless `meta.was_mismatched`
/// (the site's OWN pre-existing possible row already claimed a resolved
/// target this pass's checker attempt could NOT confirm) -- in that case,
/// republishes the site under the CANONICAL, self-consistent "possible"
/// identity (closing the old, inconsistent one) rather than leaving a
/// permanently mislabeled ghost that both the query layer
/// (`packages/engine/src/canonical-query-data-port.ts`'s own
/// `relationClassification`, which trusts `body.classification` with no way
/// to cross-check it against the store) and `completeness_report` would
/// otherwise keep reporting as "confirmed" forever. Only `core:call` rows
/// are corrected (`meta.was_mismatched` is only ever `true` for those, per
/// `collect()`'s own scoping) -- heritage relations are left as they were
/// before this session, unchanged. Never destructive: the corrected row is
/// itself an ordinary genuinely-possible row, fully eligible for a FUTURE
/// residual pass to upgrade normally if a later attempt succeeds.
#[allow(clippy::too_many_arguments)]
fn repair_mismatched_row_if_needed(
    meta: &PendingMeta,
    store_path: &str,
    start: i32,
    end: i32,
    predecessor: &RecordView,
    store: &StoreReader,
    generation: u64,
    new_generation: u32,
    kinds_dict: &mut OrdinalDict<String>,
    universal_kinds_dict: &mut OrdinalDict<String>,
    relation_kinds_dict: &mut OrdinalDict<String>,
    names_dict: &mut OrdinalDict<String>,
    opened_records: &mut Vec<RecordRow>,
    record_closures: &mut Vec<([u8; 32], u32)>,
    closed_relation_keys: &mut Vec<[u8; 32]>,
    debug: Option<&mut ResidualDebug>,
) {
    if !meta.was_mismatched {
        return;
    }
    let corrected = build_corrected_possible_row(
        store_path,
        start,
        end,
        &meta.source_id,
        predecessor,
        store,
        generation,
        new_generation,
        kinds_dict,
        universal_kinds_dict,
        relation_kinds_dict,
        names_dict,
    );
    if let Ok(Some(corrected)) = corrected {
        record_closures.push((meta.possible_record_id, new_generation));
        closed_relation_keys.push(meta.possible_record_id);
        opened_records.push(corrected);
        if let Some(debug) = debug {
            debug.record_bucket("classification_mismatch_repaired");
        }
    }
}

/// Republishes a classification-mismatched `core:call` possible row (see
/// [`is_classification_consistent`]) as a NEW row under the CANONICAL
/// "possible" identity -- `possible_call_record`'s own
/// `jsts:call:{path}:{start}:{end}:{source_id}:unresolved` recipe
/// (`urdira_jsts_syntax_worker::semantic_sites`, reimplemented here for the
/// same crate-isolation reason `delta.rs`/`publish.rs` already document for
/// their own copies of shared recipes), closing the old, inconsistent row.
/// Only ever called from [`repair_mismatched_row_if_needed`], itself only
/// reached when this pass's OWN checker attempt could not confirm a
/// workspace target for a site whose identity already (wrongly) claimed
/// one. `Ok(None)` if this exact "possible" identity is somehow already
/// live elsewhere (defensive, mirrors `build_confirmed_row`'s own fail-
/// closed precedent) -- the caller simply leaves the old row untouched in
/// that case rather than risk a duplicate.
#[allow(clippy::too_many_arguments)]
fn build_corrected_possible_row(
    path: &str,
    start: i32,
    end: i32,
    source_id: &str,
    predecessor: &RecordView,
    store: &StoreReader,
    generation: u64,
    new_generation: u32,
    kinds_dict: &mut OrdinalDict<String>,
    universal_kinds_dict: &mut OrdinalDict<String>,
    relation_kinds_dict: &mut OrdinalDict<String>,
    names_dict: &mut OrdinalDict<String>,
) -> Result<Option<RecordRow>, ScanError> {
    let identity_key = format!("jsts:call:{path}:{start}:{end}:{source_id}:unresolved");
    let mut body = serde_json::Map::new();
    body.insert(
        "source_id".into(),
        serde_json::Value::String(source_id.to_string()),
    );
    body.insert(
        "classification".into(),
        serde_json::Value::String("possible".into()),
    );
    body.insert("path".into(), serde_json::Value::String(path.to_string()));
    body.insert("start".into(), serde_json::Value::from(start));
    body.insert("end".into(), serde_json::Value::from(end));
    let body = serde_json::Value::Object(body);

    let facets = canonical_json(&serde_json::json!([
        "core:reference_relation",
        "core:indirect"
    ]));
    let source_span = canonical_span(path, start, end);
    let evidence_references = canonical_evidence(path, start, end);
    let kind = "jsts:relation_call".to_string();
    let universal_kind = "core:call".to_string();
    let record_key = StructuralKernelRecordRef {
        proposal_record_key: &proposal_record_key(&identity_key),
        category: "relation",
        kind: &kind,
        universal_kind: &universal_kind,
        facets: &facets,
        schema_version: 1,
        source_span: &source_span,
        identity_key: &identity_key,
        body: &body,
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
    let (record_id, record_digest, previous_record_id) =
        match store.by_identity_last(&identity_key_digest) {
            Some(last)
                if last.is_visible(generation) && last.record_id() != predecessor.record_id() =>
            {
                return Ok(None);
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
    let relation_kind_id =
        u16::try_from(relation_kinds_dict.intern(&universal_kind)).unwrap_or(u16::MAX);
    let name_id = names_dict.intern(&materialize::identity_key_name(&identity_key).to_owned());

    Ok(Some(RecordRow {
        record_id,
        owner_artifact: predecessor.owner_artifact(),
        owner_version: predecessor.owner_version(),
        valid_from: new_generation,
        valid_to: 0,
        category: CATEGORY_RELATION,
        kind_id,
        universal_kind_id,
        facets: materialize::facets_bitmask(&kernel_row.facets),
        span_artifact_version: predecessor.owner_artifact(),
        span_start_byte: kernel_row.span_start,
        span_end_byte: kernel_row.span_end,
        span_start_line: 0,
        span_end_line: 0,
        identity_type: 1,
        assignment_kind: 0,
        name_id,
        identity_key: kernel_row.identity_key.into_bytes(),
        record_digest,
        body_digest: kernel_row.body_digest,
        identity_id: kernel_row.identity_id,
        identity_key_digest: kernel_row.identity_key_digest,
        previous_record_id,
        source_subject: predecessor.source_subject(),
        target_subject: None,
        relation_kind_id,
        body: kernel_row.body,
    }))
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

    // P1-D-g item 1: `is_classification_consistent` is the pure predicate
    // the store-wide invariant (`count_classification_mismatches`) and the
    // repair step (`repair_mismatched_row_if_needed`) both build on --
    // exercised directly here with plain string/bool inputs, no store or
    // fixture needed.
    #[test]
    fn classification_consistent_for_a_genuinely_possible_identity() {
        assert!(is_classification_consistent(
            "jsts:call:a.ts:1:2:src:unresolved",
            false,
        ));
    }

    #[test]
    fn classification_consistent_for_a_genuinely_confirmed_identity() {
        assert!(is_classification_consistent(
            "jsts:call:a.ts:1:2:src:jsts:function:a.ts:10:foo",
            true,
        ));
    }

    #[test]
    fn classification_inconsistent_when_identity_claims_a_target_but_store_has_none() {
        // The exact P1-D-g bug signature: `semantic_sites.rs` wrote a
        // resolved-looking identity (`classification: "confirmed"` implied),
        // but `target_subject()` never got interned.
        assert!(!is_classification_consistent(
            "jsts:call:a.ts:1:2:src:jsts:function:a.ts:10:foo",
            false,
        ));
    }

    #[test]
    fn classification_inconsistent_when_identity_is_unresolved_but_store_has_a_target() {
        // The inverse, unexpected in practice but not assumed away.
        assert!(!is_classification_consistent(
            "jsts:call:a.ts:1:2:src:unresolved",
            true,
        ));
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
        let collected = collect(&store, &dicts, &owner_path, base_generation);
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
        let identity_key = String::from_utf8(confirmed_view.identity_key().to_vec())
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
        };
        let residual_started = std::time::Instant::now();
        let outcome = run_once_with_quiet_period(&context, 0, std::time::Duration::ZERO)
            .expect("residual pass does not error")
            .expect("n8n corpus has pending sites");
        eprintln!(
            "[n8n_residual_pass_debug_histogram] residual pass wall={:.3}s total_ms={} upgraded={} external={} unresolved={}",
            residual_started.elapsed().as_secs_f64(),
            outcome.timings.total_ms,
            outcome.upgraded_sites,
            outcome.external_sites,
            outcome.unresolved_sites,
        );
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
            dump_call_bodies(&structural_root, base_generation, Path::new(&path));
        }
        if let Ok(path) = std::env::var("URDIRA_V4_CALL_BODY_DUMP_AFTER") {
            dump_call_bodies(&structural_root, outcome.generation, Path::new(&path));
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
    /// `confirmed_flag` is `view.target_subject().is_some()` -- the SAME
    /// store-level, metadata-only signal `print_confirmed_possible_
    /// histogram` above already treats as the one authoritative confirmed/
    /// possible split (P1-D-d's own doc comment: "a possible row never
    /// resolves a target, a confirmed row always does"), NOT the body's own
    /// `classification` field. This distinction is load-bearing, confirmed
    /// live this session: decoding this exact dump's bodies in Node and
    /// splitting by `classification === "confirmed"` instead gives
    /// 146,774 -- 29,033 MORE than this method's 117,741 -- for a
    /// generation where `print_confirmed_possible_histogram` independently
    /// reports 117,741 confirmed `core:call` rows via `target_subject()`.
    /// The two numbers are NOT interchangeable: some rows carry a
    /// `classification: "confirmed"` + a `target_id` string in their body
    /// (written once, at the row's OWN creation time) whose `target_subject`
    /// ordinal never actually resolved in this store (`materialize.rs`'s own
    /// subject-interning step, entirely outside this dump's or the residual
    /// pass's control) -- a real, pre-existing v4-internal inconsistency
    /// between the body's self-reported classification and the store's own
    /// resolved-subject bookkeeping, out of scope to fix here (v4/
    /// materialize.rs is the other agent's owned file this session), but
    /// dangerous to paper over silently in a parity-diff tool whose whole
    /// point is counting "confirmed" correctly -- hence carrying the
    /// authoritative flag explicitly rather than asking the diff script to
    /// re-derive it from a decode.
    fn dump_call_bodies(structural_root: &Path, generation: u64, out_path: &Path) {
        let store = StoreReader::open(structural_root).expect("store reopens for call body dump");
        let dicts = store.dictionaries();
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
            rows.push((view.target_subject().is_some(), view.body().to_vec()));
        }
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
    /// `core:inherits`/`core:implements` by `target_subject().is_some()`
    /// (a possible row never has one, a confirmed row always does -- the
    /// exact same structural test `residual.rs`'s own `collect` already
    /// trusts for correctness, not merely for this diagnostic). Printing
    /// this at both the cold generation and the post-upgrade generation of
    /// the SAME corpus checkout/worker binary in the SAME test run
    /// eliminates the cross-session drift the P1-D-c evidence doc could
    /// not rule out for its own 96,847-vs-64,931 discrepancy.
    fn print_confirmed_possible_histogram(label: &str, structural_root: &Path, generation: u64) {
        let store = StoreReader::open(structural_root).expect("store reopens for histogram");
        let dicts = store.dictionaries();
        let (mut call_confirmed, mut call_possible) = (0u64, 0u64);
        let (mut heritage_confirmed, mut heritage_possible) = (0u64, 0u64);
        for view in store.iter_visible(generation) {
            if view.category() != CATEGORY_RELATION {
                continue;
            }
            let universal_kind = dicts
                .universal_kinds
                .get(view.universal_kind_id() as usize)
                .map(String::as_str)
                .unwrap_or("");
            let confirmed = view.target_subject().is_some();
            match universal_kind {
                "core:call" => {
                    if confirmed {
                        call_confirmed += 1;
                    } else {
                        call_possible += 1;
                    }
                }
                "core:inherits" | "core:implements" => {
                    if confirmed {
                        heritage_confirmed += 1;
                    } else {
                        heritage_possible += 1;
                    }
                }
                _ => {}
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
            let identity = String::from_utf8_lossy(view.identity_key()).into_owned();
            if !is_classification_consistent(&identity, view.target_subject().is_some()) {
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
