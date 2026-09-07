//! v4 parse + facts extraction (plan §4.2-§4.5), driving the existing
//! `urdira-jsts-syntax-worker` crate IN-PROCESS (same crate `main.rs` uses
//! for its own v3 "lane 1"/hybrid passes -- `SyntaxWorkerState::analyze`/
//! `read_facts_group` and `semantic_sites::analyze_owner_semantics_with_
//! context` are already checker-free, oxc-only, and produce fully-formed
//! `ProposedRecord`s; this module is new orchestration around that
//! existing public API, not a reimplementation of it).
//!
//! What each source contributes to one owner's final `Vec<ProposedRecord>`:
//! - `read_facts_group` (lane 1): entity declarations (`jsts:entity_*`),
//!   `jsts:relation_contains`/`_import`/`_export`.
//! - `analyze_owner_semantics_with_context` (E1a-E3 hybrid lane):
//!   `core:references`/`core:covers`/`core:call`/`core:inherits`/
//!   `core:implements` rows Rust can resolve with lexical certainty.
//! - `resolve_pending_sites` (stub, see its doc comment): everything the
//!   hybrid lane could not resolve. Returns empty today -- this is the
//!   typeflow integration point (plan §5, out of this task's scope).
//!
//! No `jsts:diagnostic` records are produced anywhere in this module (task
//! brief: v4 does not emit them).

use super::ScanError;
use super::deps::AMBIENT_GLOBAL_DEPENDENCY_ROLE;
use super::timings::ScanClock;
use rayon::prelude::*;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use urdira_jsts_syntax_worker::{
    AmbientModuleIndex, AnalysisBudgets, ConfigAssetInput, HybridResolutionContext, ProposedRecord,
    ProposedRecordDependency, SourceInput, SyntaxFileResult, SyntaxWorkerState, WorkerMessage,
    WorkspaceResolver, ambiguous_ambient_would_be_external_count,
    analyze_owner_semantics_with_context, decode_config_assets,
    reset_ambiguous_ambient_would_be_external_count,
};
use urdira_source_frontier::CasWrittenSignal;
use urdira_source_frontier::cas::object_relative_path;
use urdira_source_frontier::frontier::Frontier;
pub use urdira_worker_protocol::AuthoritativeChangeSet;

/// Every fact row (entities, structural relations, and the hybrid-lane
/// reference/call/heritage/covers rows) collected for one owner, plus its
/// resolved direct imports. Pre-existing gap, unrelated to P2-2g: `deps.rs`'s
/// `materialize_dependencies` builds every `DependencyRow` straight from
/// `ProposedRecordDependency` and never reads `direct_imports` at all (see
/// `materialize.rs`'s P2-2f note on `canonicalize_owner`'s scope reduction),
/// so this field is carried through `run_cold`'s result but has no reader
/// today -- kept (not dropped) as the natural place a future
/// dependency-resolution pass would read it from, same shape v3's own
/// per-owner facts collection carries (`main.rs`'s `direct_imports`).
#[allow(dead_code)]
pub struct OwnerFacts {
    pub owner_artifact_id: String,
    pub owner_artifact_version_id: String,
    pub owner_path: String,
    pub records: Vec<ProposedRecord>,
    pub dependencies: Vec<ProposedRecordDependency>,
    pub direct_imports: Vec<urdira_jsts_syntax_worker::DirectImport>,
    /// P2-2e deliverable 2: every semantic site typeflow (and the E1a-E3
    /// hybrid lane before it) could not resolve for this owner -- the
    /// residual-pass input contract (plan P1-D-c). Empty for an owner whose
    /// lane-1 facts entry was NOT also processed by the hybrid/typeflow
    /// lane this scan (an owner outside `affected_paths`): its PRIOR
    /// generation's pending sites are unaffected and stay published as-is
    /// (`materialize`/`publish` never touch an unaffected owner's rows at
    /// all, so there is nothing to overwrite here either).
    pub pending_sites: Vec<urdira_jsts_syntax_worker::SemanticSite>,
    /// A2 (pending.sites migration): every no-target call/heritage site this
    /// owner's hybrid/typeflow lane could not resolve, in the store-bound
    /// `PendingSiteProposal` shape (`urdira-jsts-syntax-worker::
    /// OwnerSemantics::pending_site_rows`'s own doc comment has the full
    /// rationale) -- `materialize.rs` resolves each one's `source_id` into a
    /// `Dictionaries::subjects` ordinal and emits a `PendingSiteRow` into
    /// `MaterializedGeneration::pending_sites`/`MaterializedPartitionedGeneration
    /// ::pending_sites`. `owner.records` no longer receives a no-target
    /// possible relation row at all -- this field is the only place that
    /// population survives from this point on. Same "empty for an
    /// unaffected owner" caveat as `pending_sites` above.
    pub pending_site_rows: Vec<urdira_jsts_syntax_worker::PendingSiteProposal>,
}

pub struct ColdAnalysis {
    pub owners: Vec<OwnerFacts>,
}

const JSTS_EXTENSIONS: [&str; 11] = [
    ".ts", ".tsx", ".mts", ".cts", ".d.ts", ".d.mts", ".d.cts", ".js", ".jsx", ".mjs", ".cjs",
];

/// Byte-identical predicate to `main.rs`'s private `is_jsts_source_path`
/// (main.rs:2519) -- kept as an independent copy per this task's isolation
/// rule (this module cannot import a private fn from a binary crate it is
/// not allowed to edit). `pub(crate)`: P3-2's `state::SourceCache` also
/// needs this to classify a single changed path without rebuilding the
/// whole `files`/`config_assets` split from scratch (see this module's own
/// `run_scoped`, which now consumes a pre-built cache instead of building
/// one).
pub(crate) fn is_jsts_source_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    JSTS_EXTENSIONS
        .iter()
        .any(|extension| lower.ends_with(extension))
}

/// Byte-identical predicate to `main.rs`'s private `is_config_asset_path`
/// (main.rs:2535). Same isolation rationale as above; `pub(crate)` for the
/// same reason as `is_jsts_source_path`.
pub(crate) fn is_config_asset_path(path: &str) -> bool {
    let basename = path.rsplit('/').next().unwrap_or(path);
    matches!(basename, "package.json" | "tsconfig.json" | "jsconfig.json")
        || path == "pnpm-workspace.yaml"
}

pub(crate) fn blob_path(cas_root: &Path, content_hash: &str) -> Result<String, ScanError> {
    let relative = object_relative_path(content_hash)
        .map_err(|error| ScanError(format!("invalid content hash {content_hash}: {error}")))?;
    Ok(cas_root.join(relative).to_string_lossy().into_owned())
}

/// A cold scan's `CasWriteQueue` (`catalog::run_full_scan`) is deliberately
/// joined only after `publish::publish_cold`/`publish_cold_partitioned`
/// returns (see `scan::run_full`'s own doc comment: writes are meant to
/// overlap analyze/materialize/publish's CPU-bound work, not sit on the
/// walk's critical path). That means a background worker can still be
/// mid-write for a given owner's blob when [`read_owner_source_text`] below
/// tries to read it -- a genuine, reproduced (`URDIRA_DIAGNOSTIC_CAS_DELAY_MS`-
/// forced, then confirmed at natural timing) race, not a test-fixture
/// artifact: `cargo test -p urdira-indexing-worker` with default (parallel)
/// test threads intermittently failed
/// `incremental_{create,delete}_roots_match_a_from_scratch_scan_of_the_
/// mutated_tree` with exactly `std::io::ErrorKind::NotFound` here, once the
/// background write was artificially delayed. An earlier fix (954a942)
/// closed this by retrying `std::fs::read` on `NotFound` up to 200 times
/// (5ms apart, ~1s ceiling) -- correct, but blind: every cold scan paid
/// SOME chance of a multi-millisecond stall on a blob that was, in fact,
/// already being written by a known, waitable background worker, and a
/// slow/contended write still had to be rediscovered by polling rather
/// than being woken the instant it actually finished.
///
/// The fix now is targeted: `catalog::run_full_scan`'s `CasWriteQueue`
/// exposes a [`CasWrittenSignal`] (`Arc`-cheap, `urdira-source-frontier`'s
/// `cas.rs`) that a worker thread marks complete -- via a `Mutex`+`Condvar`
/// completion registry, not polling -- the instant its own `put_if_absent`
/// call returns (success OR error; see that type's own doc comment for the
/// full mechanism, including the "never submitted" and "write failed"
/// cases). [`read_owner_source_text`] calls `wait_written` on that signal
/// (60s timeout, a safety net never expected to trigger) before ever
/// touching the filesystem, so a reader either finds the blob already
/// durable (the common case, zero extra cost beyond one `Mutex::lock`) or
/// is woken the instant the specific write it is waiting on completes --
/// no fixed retry ceiling, no blind polling interval.
pub(crate) const CAS_WRITE_WAIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Reads and hash-verifies an owner's source bytes (same check as
/// `main.rs`'s private `read_owner_source_text`, main.rs:817-833 -- this is
/// an independent copy for the same isolation reason as the predicates
/// above). `pub(crate)`: `v4::typeflow` also needs this to read a changed
/// owner's text when (re)building its `DeclSummary` (P2-2e).
///
/// `cas_signal` is `Some` exactly when a `CasWriteQueue` for THIS scan may
/// still be draining in the background when this call happens -- today,
/// that is only `run_cold`'s own call chain (`TypeflowCache::build_full`
/// and `analyze_one`, both invoked while the cold scan's queue has been
/// taken out of `CatalogScanOutcome` but not yet `join`ed, see
/// `scan::run_full`'s own doc comment for why the join is deliberately
/// deferred). `None` for every caller whose blobs are already known
/// durable: `delta.rs`'s incremental path writes CAS blobs SYNCHRONOUSLY
/// (`Walker::observe_paths(..., Some(&cas_store))`, a bare `CasStore`, not
/// a `CasWriteQueue` -- confirmed by reading `delta.rs` directly) before
/// `analyze::run_incremental` is ever called, so there is no queue to wait
/// on; `residual.rs`'s background pass runs strictly after its owning
/// scan's `ScanCompleted` (which itself is strictly after that scan's own
/// `cas_write_queue.join()`, see `scan::run_full`), so every blob it reads
/// was written (by that scan, or an earlier one) long before the pass
/// starts.
pub(crate) fn read_owner_source_text(
    owner: &SourceInput,
    cas_signal: Option<&CasWrittenSignal>,
) -> Result<String, ScanError> {
    if let Some(signal) = cas_signal {
        signal
            .wait_written(&owner.content_digest, CAS_WRITE_WAIT_TIMEOUT)
            .map_err(|error| {
                ScanError(format!(
                    "cannot read source blob for {}: {error}",
                    owner.path
                ))
            })?;
    }
    let bytes = std::fs::read(&owner.source_blob_path).map_err(|error| {
        ScanError(format!(
            "cannot read source blob for {}: {error}",
            owner.path
        ))
    })?;
    if bytes.len() != owner.byte_length {
        return Err(ScanError(format!(
            "source byte length mismatch for {}",
            owner.path
        )));
    }
    String::from_utf8(bytes).map_err(|error| {
        ScanError(format!(
            "source is not valid UTF-8 for {}: {error}",
            owner.path
        ))
    })
}

/// P2-2e: typeflow (owner decision 2026-09-02) now resolves as many
/// `pending_sites` as it lexically/declared-type can INSIDE
/// `analyze_owner_semantics_with_context` itself (`ctx.typeflow_index`,
/// wired below in `run_scoped`) -- there is no separate "hand pending sites
/// to a resolver" step left for this function to do; `OwnerSemantics::
/// typeflow_call_rows`/`typeflow_heritage_rows` already carry the resolved
/// rows (with `classification: "confirmed"`/`"possible"` embedded in each
/// row's own body, same convention as every other hybrid-lane row) and
/// `OwnerSemantics::pending_sites` already reflects typeflow's own removals
/// (a site typeflow resolved is no longer in that list). What remains in
/// `pending_sites` after this call is exactly the residual-pass input
/// (plan P1-D-c, deliverable 2 of this task: exported into the structural
/// store's `pending.sites`/`entities.index` by `materialize.rs`/
/// `publish.rs`, not resolved here).
///
/// Runs the facts pipeline (plan §4.2-§4.5) for every JS/TS file in
/// `frontier.present`, scoped by `change_set` (plan §6.1's `ScanScope`
/// translated to `urdira-jsts-syntax-worker`'s own incrementality
/// vocabulary): `AuthoritativeChangeSet::Full` for a cold scan (every
/// current file is "changed"); `AuthoritativeChangeSet::Exact{
/// changed_artifact_ids }` for an incremental scan (P3-1), naming exactly
/// the paths whose CONTENT differs from what `syntax`'s cached project
/// state has -- a pure add/remove (create/delete/rename with unchanged
/// content) needs no entry here at all: `syntax.analyze`'s own
/// `path_membership_incremental` fast path (triggered by `root_names`
/// differing from its cached project state while every path present both
/// before and after kept byte-identical content) already reresolves exactly
/// the affected importers on its own, in every case this task's callers
/// exercise (see `delta.rs`'s module doc for the one documented exception:
/// a batch that mixes a content edit with a create/delete in the same
/// `Changed` command).
///
/// `syntax` is the caller's own long-lived `SyntaxWorkerState` (P3-1
/// deliverable 1: `main.rs` keeps ONE instance alive for the whole process,
/// shared by v3 and v4 under disjoint project-key namespaces -- see
/// `state.rs`'s module doc) -- passing it in by reference, rather than this
/// function creating `SyntaxWorkerState::default()` internally as the P2-2b
/// version did, is what makes a second and later scan of the same
/// workspace an incremental re-parse instead of a from-scratch one:
/// `analyze()` itself is what decides which of `files`'s entries actually
/// need reparsing, keyed on `syntax.projects[project_key]`'s own cached
/// `source_metadata`/AST state from the PRIOR call.
///
/// `files`/`config_assets` are the CALLER's already-built, already-sorted
/// (by `path`) full-corpus lists (P3-2 item 1: previously this function
/// built them itself from `frontier.present` on EVERY call, an O(corpus)
/// `HashMap` walk + struct-clone that dominated a steady-state edit's own
/// `parse_ms` -- see `state::SourceCache`'s doc comment for the
/// incremental cache that now maintains this list in O(delta) instead. Both
/// `run_cold` (builds a fresh `SourceCache` from the frontier every call --
/// a cold scan is O(corpus) by nature already) and `run_incremental`
/// (consumes `WorkspaceState.source_cache`, updated in place by `delta::run`
/// before this is called) still produce the SAME shape this function used
/// to build internally, so `analyze()`'s own semantics (a full `root_names`
/// list is required every call, incremental or not, to detect membership
/// changes) are unchanged -- only WHERE the list comes from moved.
/// P3-3 item 2: one exported binding's identity, as far as an IMPORTER can
/// observe it -- `(exported_name, resolved local entity id, source
/// specifier, resolved re-export target path)`. `resolved local entity id`
/// is `Some` for a direct local export (`export function foo() {}`,
/// `export { foo }`) and embeds the exported entity's own span-derived
/// `stable_entity_id` (`urdira-jsts-syntax-worker`'s own recipe: `jsts:
/// {kind}:{path}:{start}:{name}`) -- so an edit that shifts an EARLIER
/// export's `start` (inserting code before it, not merely appending after
/// it) changes this entry even though the export's NAME is unchanged,
/// correctly counting as a surface change (any importer's `core:call`/
/// `core:references` row targets that exact id and would otherwise go
/// stale). `None` for a named re-export (`source_specifier.is_some()`),
/// whose own identity is fully carried by the `(source_specifier,
/// source_target_path)` pair already.
type ExportedSurfaceEntry = (String, Option<String>, Option<String>, Option<String>);

/// Builds `file`'s exported surface (P3-3 item 2): every `export_bindings`
/// entry, with a direct (non-re-exported) binding's local name resolved
/// against `file.entities` (matching `SyntaxEntity::name` among top-level
/// entities, `parent_id.is_none()`, exactly how `resolver.rs`'s own
/// `resolve_named_export` closes an import -> local declaration chain) to
/// its current `id`. A `BTreeSet` (not a `Vec`) so two calls over the same
/// logical surface compare equal regardless of `export_bindings`' own
/// incidental order, AND so [`run_scoped`]'s own comparison can ask the
/// subset question a plain `Vec`/`HashSet` diff would not conveniently
/// answer (see its doc comment: additions alone must not count as a
/// surface change).
fn exported_surface(file: &SyntaxFileResult) -> BTreeSet<ExportedSurfaceEntry> {
    let mut surface: BTreeSet<ExportedSurfaceEntry> = file
        .export_bindings
        .iter()
        .map(|binding| {
            let local_entity_id = if binding.source_specifier.is_none() {
                file.entities
                    .iter()
                    .find(|entity| entity.parent_id.is_none() && entity.name == binding.local_name)
                    .map(|entity| entity.id.clone())
            } else {
                None
            };
            (
                binding.exported_name.clone(),
                local_entity_id,
                binding.source_specifier.clone(),
                binding.source_target_path.clone(),
            )
        })
        .collect();
    // 2026-09-04 references-parity task, bucket 2: a bare `export * from
    // "./x"` barrel (`export_star_specifiers`, tracked separately from
    // `export_bindings` -- see that field's own doc comment) is now part of
    // this module's resolvable surface too (`resolver::resolve_named_
    // export_inner` chases it), so a change to ITS specifier resolution
    // must count as a surface change here exactly like a named re-export's
    // `source_target_path` already does just above -- otherwise an edit
    // that re-points a star barrel would incorrectly narrow the affected
    // closure and leave stale resolutions unrevisited (see `run_scoped`'s
    // own `surface_changed` doc comment for the invalidation this feeds).
    // `"*"` as the `exported_name` slot is a safe sentinel (never a real
    // JS export name), distinguishing these entries from any ordinary
    // `export_bindings` one without needing a wider tuple shape.
    surface.extend(file.export_star_specifiers.iter().map(|star| {
        (
            "*".to_owned(),
            None,
            Some(star.specifier.clone()),
            star.target_path.clone(),
        )
    }));
    surface
}

#[allow(clippy::too_many_arguments)]
pub fn run_scoped(
    files: Vec<SourceInput>,
    config_assets: Vec<ConfigAssetInput>,
    workspace_id: &str,
    syntax: &mut SyntaxWorkerState,
    change_set: AuthoritativeChangeSet,
    clock: &mut ScanClock,
    typeflow: &mut super::typeflow::TypeflowCache,
    cas_signal: Option<&CasWrittenSignal>,
    // Frente E-P0f (2026-09-07, ambient-global-dependents integrity fix):
    // paths the CALLER (`delta::run_one`) already proved need reprocessing
    // via a store-level reverse-dependency lookup (`StoreReader::
    // deps_reverse` over `DEPENDENCY_ROLE_AMBIENT_GLOBAL_INPUT` rows) that
    // `syntax.analyze()` itself has no way to discover on its own -- see
    // that call site's own doc comment for the full root-cause writeup.
    // Deliberately NOT folded into `change_set`'s `changed_artifact_ids`:
    // `authoritative_changed_paths` (`urdira-jsts-syntax-worker::lib.rs`)
    // validates that set against the retained/current manifest's OWN
    // content-diff, byte for byte -- declaring a byte-IDENTICAL file's
    // artifact id there is rejected outright ("do not match the retained
    // manifest transition"), a real bug this fix's first draft hit live.
    // Unioned into `affected_paths` below, AFTER `syntax.analyze()` returns
    // (never before it runs, and never validated against it) -- `facts_
    // for_paths`/the hybrid lane both read straight from `syntax`'s already
    // -cached per-file state, so a path that is affected but never
    // reparsed this call works exactly the same way `ambient_affected`
    // (ambient MODULE reprocessing, `syntax.analyze()`'s own internal
    // mechanism) already does at the syntax-worker layer -- this is that
    // same shape, one level up, for ambient GLOBAL reprocessing instead.
    extra_affected_paths: &[String],
) -> Result<ColdAnalysis, ScanError> {
    if files.is_empty() {
        return Ok(ColdAnalysis { owners: Vec::new() });
    }

    // Captured before `change_set` moves into `syntax.analyze` below -- see
    // the Frente E fix further down (`if is_full_change_set { ... }`) for
    // why a `Full` caller cannot trust `analyze()`'s own `affected_files`
    // narrowing on a warm `syntax` project.
    let is_full_change_set = matches!(change_set, AuthoritativeChangeSet::Full);
    let root_names: Vec<String> = files.iter().map(|file| file.path.clone()).collect();
    let project_key = format!("v4:{workspace_id}");
    let cancelled = AtomicBool::new(false);

    // P3-3 item 2: candidate paths for surface-hash closure narrowing
    // (below) -- exactly the paths `AuthoritativeChangeSet::Exact` names as
    // content-changed, resolved against the STILL-CURRENT `files` list
    // (a deleted path's id never resolves here, since it is already absent
    // from `files` by the time a `Changed` scan reaches this function --
    // narrowing never applies to create/delete/rename, only to a genuine
    // content edit of a pre-existing file, see the doc comment below).
    // Captured BEFORE `syntax.analyze` mutates its cached project state, so
    // `exported_surface` below sees each candidate's PRE-edit shape.
    let surface_candidates: Vec<String> = match &change_set {
        AuthoritativeChangeSet::Exact {
            changed_artifact_ids,
        } => {
            let ids: std::collections::HashSet<&str> = changed_artifact_ids
                .iter()
                .map(std::string::String::as_str)
                .collect();
            files
                .iter()
                .filter(|file| ids.contains(file.artifact_id.as_str()))
                .map(|file| file.path.clone())
                .collect()
        }
        AuthoritativeChangeSet::Full => Vec::new(),
    };
    let prior_surfaces: HashMap<String, BTreeSet<ExportedSurfaceEntry>> = surface_candidates
        .iter()
        .filter_map(|path| {
            let file = syntax.project_files(&project_key)?.get(path)?;
            Some((path.clone(), exported_surface(file)))
        })
        .collect();

    let parse_started = std::time::Instant::now();
    let analysis = syntax
        .analyze(
            "v4:scan:analyze".to_string(),
            "v4:scan:analyze".to_string(),
            project_key.clone(),
            "sha256:0000000000000000000000000000000000000000000000000000000000000000".to_string(),
            root_names,
            files.clone(),
            config_assets.clone(),
            change_set,
            AnalysisBudgets {
                max_output_bytes: 64 * 1024 * 1024,
                max_files: u32::try_from(files.len())
                    .unwrap_or(u32::MAX)
                    .saturating_add(1),
                max_source_bytes: u32::MAX,
                // In-process caller (Rust -> Rust, no IPC frame): skip the
                // serialize-and-measure pass `analyze` would otherwise run
                // just to compare against `max_output_bytes` (plan 3.1).
                enforce_output_bytes: false,
            },
            &cancelled,
        )
        .map_err(|error| ScanError(format!("v4 syntax analysis failed: {}", error.message)))?;
    let (mut affected_paths, reset_reason, changed_files) = match analysis {
        WorkerMessage::AnalysisResult {
            affected_files,
            reset_reason,
            changed_files,
            ..
        } => (affected_files, reset_reason, changed_files),
        WorkerMessage::Cancelled { .. } => {
            return Err(ScanError("v4 syntax analysis cancelled".into()));
        }
        _ => {
            return Err(ScanError(
                "v4 syntax worker returned an invalid analysis result".into(),
            ));
        }
    };

    // P3-3 item 2: affected-closure narrowing. `reverse_affected_closure`
    // (inside `syntax.analyze`, shared v3/v4 code this task avoids editing
    // per its own brief) widens `affected_files` to every TRANSITIVE
    // importer of a changed file unconditionally -- correct but wasteful
    // when the edit never touched the file's EXPORTED surface (an
    // append-only edit, a body-only edit, a comment/whitespace change):
    // none of those importers' own resolution can possibly have changed,
    // so reprocessing them through `facts_for_paths`/the hybrid lane only
    // to have `diff_owner` discover "unchanged, keep" (item 1's fix) is
    // pure waste, proportional to fan-in rather than to the edit's real
    // size. Applies ONLY to a genuine content edit of pre-existing files
    // (`reset_reason.is_none()`, i.e. NOT `path_membership_incremental`'s
    // add/remove path and NOT a cold/full reset, both of which keep their
    // existing, unnarrowed behavior -- they legitimately need every
    // affected path re-resolved). When every changed path's surface is
    // unchanged, `affected_paths` narrows to exactly `changed_files` (the
    // literal edited paths) -- the importers this closure would otherwise
    // have widened to are dropped from `facts_for_paths`/hybrid-lane
    // processing entirely, not merely diffed to a no-op.
    if reset_reason.is_none() && !surface_candidates.is_empty() {
        let surface_changed = surface_candidates.iter().any(|path| {
            let prior = prior_surfaces.get(path);
            let next = syntax
                .project_files(&project_key)
                .and_then(|files| files.get(path))
                .map(exported_surface);
            // Conservative by construction: any candidate this cannot
            // certify as unchanged (no prior baseline, no post-edit file)
            // counts as "surface changed" and keeps the full widened
            // closure. A PURE ADDITION (every prior binding still present,
            // unchanged -- `prior.is_subset(&next)`) does NOT count as
            // changed: no EXISTING importer's already-resolved reference
            // could have been invalidated by a new export appearing.
            // Removing/renaming/re-shifting an existing binding always
            // counts (`prior` is then NOT a subset of `next`). Documented
            // residual, not a correctness gap this task closes: an
            // importer that already carries an UNRESOLVED import naming
            // exactly the newly-added export (`checker_pending` on its own
            // side) will not be reprocessed by this scan and stays
            // unresolved one generation longer than a from-scratch scan
            // would leave it -- an existing, pre-P3-3 limitation of the
            // hybrid lane's own incremental scoping (the same
            // `path_membership_incremental` fast path already accepts an
            // equivalent gap for pure add/remove batches, see its own doc
            // comment), not one this narrowing introduces new.
            match (prior, next.as_ref()) {
                (Some(prior), Some(next)) => !prior.is_subset(next),
                _ => true,
            }
        });
        if !surface_changed {
            affected_paths = changed_files.clone();
        }
    }

    // Frente E discovery (2026-09-06, plan `generic-waddling-hartmanis.md`
    // §2.4's `debug_repeated_full_scan_matches_oracle`): this function's own
    // doc comment states the `Full` contract plainly -- "every current file
    // is changed" -- but `syntax.analyze`'s own membership/incremental fast
    // path (the one `run_cold`'s doc comment praises: "a SECOND Full scan of
    // an unchanged workspace in the same process ... hits analyze()'s own
    // fast path instead of reparsing from scratch") can narrow `affected_
    // files` on a WARM `syntax` project regardless of `change_set`, since
    // its membership diff has no notion of "the caller asked for Full" --
    // it only ever compares against its own previously cached state. That
    // narrowing is harmless for `run_incremental` (an unaffected owner's
    // rows are simply left untouched in the store, correct for a diff
    // publish) but silently WRONG for `run_cold`: `materialize_cold_
    // partitioned`/`write_base_partitioned` do not diff against a prior
    // generation at all -- they publish a COMPLETE replacement base
    // snapshot from exactly `ColdAnalysis.owners`, so any owner missing
    // from `affected_paths` here is not "left alone", it is DROPPED from
    // the new generation outright. Reproduced live: a second `Full` scan
    // (e.g. `core:reindex` against an already-`ready` v4 workspace, or this
    // module's own `run_reconcile` cold branches, both reuse the same
    // long-lived `syntax`) after creating one new file published a
    // generation whose `records` root reflected ONLY that new file's own
    // facts -- every pre-existing, wholly-unchanged owner's records
    // vanished. Fixed here, not inside `syntax.analyze` itself (this
    // module's own brief keeps that shared v3/v4 crate untouched): a `Full`
    // caller always gets every present path back, regardless of what the
    // syntax worker's own fast path decided -- `facts_for_paths` (below)
    // reads already-cached per-file results for a path `analyze()` chose to
    // skip re-parsing, so this costs nothing when the parse itself really
    // was skippable, and only restores correctness when it silently wasn't
    // supposed to be skipped for THIS caller's purposes.
    if is_full_change_set {
        affected_paths = files.iter().map(|file| file.path.clone()).collect();
    }

    // Frente E-P0f: fold in the caller's own reverse-ambient-dependent
    // widening (see this parameter's own doc comment) -- a no-op Vec for
    // `run_cold`/every OTHER `run_incremental` caller (a `Full` scan's
    // `affected_paths` already names every present path; a genuinely
    // reverse-dependent path never resolvable through this scan's own
    // membership diff needs this only on the `Exact` incremental path).
    if !extra_affected_paths.is_empty() {
        let mut widened: BTreeSet<String> = affected_paths.into_iter().collect();
        widened.extend(extra_affected_paths.iter().cloned());
        affected_paths = widened.into_iter().collect();
    }

    let files_by_path: HashMap<&str, &SourceInput> = files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();

    // Lane-1 facts extraction: P2-2g item 1 replaced the `read_facts_group`
    // wire-protocol dance (cursor/continuation loop + a 2-4x full-page
    // `serde_json` round trip per call, purely to police a byte budget that
    // does not exist for an in-process caller -- see `SyntaxWorkerState::
    // facts_for_paths`'s doc comment) with a direct per-file call into the
    // already-`analyze()`d `SyntaxFileResult`s. `facts_for_paths` takes
    // `&self` and only ever reads `self.projects[project_key]`, which
    // `analyze()` (just above) already finished populating and nothing here
    // mutates again, so fanning this out per file across `rayon`'s
    // work-stealing pool (finer-grained than the old fixed 64-path chunks,
    // now that there is no per-call protocol overhead left to amortize by
    // batching) is safe and never stalls one worker behind a disproportionate
    // share of the slow files. Originally entirely single-threaded
    // regardless of the machine's core count: measured at 49.96s wall time
    // on n8n's 14,082 owners on a 10-core machine before the first
    // (block-based) fix; the wire-protocol overhead itself then measured
    // ~8-12s even fully parallel -- see this task's evidence doc for both.
    let facts_started = std::time::Instant::now();
    let debug_timing = std::env::var_os("URDIRA_DEBUG_TIMING").is_some();
    let affected_path_count = affected_paths.len();
    let facts_results: Vec<Result<urdira_jsts_syntax_worker::FactsForPath, ScanError>> =
        affected_paths
            .par_iter()
            .map(|path| {
                syntax
                    .facts_for_paths(&project_key, std::slice::from_ref(path))
                    .map_err(|error| {
                        ScanError(format!("v4 fact extraction failed: {}", error.message))
                    })
                    .map(|mut results| {
                        results
                            .pop()
                            .expect("facts_for_paths returns exactly one result per requested path")
                    })
            })
            .collect();
    let mut owners: HashMap<String, OwnerFacts> = HashMap::with_capacity(files.len());
    for result in facts_results {
        let facts = result?;
        let file = files_by_path.get(facts.path.as_str()).ok_or_else(|| {
            ScanError(format!(
                "v4 affected path is outside the source manifest: {}",
                facts.path
            ))
        })?;
        owners.insert(
            facts.path.clone(),
            OwnerFacts {
                owner_artifact_id: file.artifact_id.clone(),
                owner_artifact_version_id: file.artifact_version_id.clone(),
                owner_path: facts.path,
                records: facts.records,
                dependencies: facts.dependencies,
                direct_imports: facts.direct_imports,
                pending_sites: Vec::new(),
                pending_site_rows: Vec::new(),
            },
        );
    }
    let facts_elapsed = facts_started.elapsed();
    if debug_timing {
        let record_count: usize = owners.values().map(|owner| owner.records.len()).sum();
        eprintln!(
            "[urdira-indexing-worker] v4 facts extraction (facts_for_paths, {} rayon threads, {affected_path_count} files): {:.3}s lane1_records={record_count}",
            rayon::current_num_threads(),
            facts_elapsed.as_secs_f64(),
        );
    }
    // P2-2g item 4: `parse_ms` now covers `analyze()`'s own initial parse
    // PLUS lane-1 facts extraction (folded in here, after both have run),
    // not just the former -- see this task's evidence doc's phase table.
    // Before this fix, facts extraction (formerly `read_facts_group`'s
    // 8-12s, now `facts_for_paths`'s ~0.3-0.6s post-P2-2g item 1) fell
    // through every `ScanTimings` bucket entirely, one of two gaps this
    // task closed to make the reported phase table sum to `total_ms`
    // (the other is `publish.rs`'s sort/graph-merkle time, folded into
    // `write_ms`).
    clock.record_parse(parse_started.elapsed());

    // E1a-E3 hybrid lane: reference/covers/call/heritage rows, in parallel
    // across owners (plan §4.4 "resolución de pending_sites por fichero en
    // par_iter").
    let resolve_started = std::time::Instant::now();
    let resolver_build_started = std::time::Instant::now();
    let resolver_assets = decode_config_assets(config_assets)
        .map_err(|error| ScanError(format!("v4 resolver assets invalid: {}", error.message)))?;
    let resolver = WorkspaceResolver::build(&resolver_assets);
    let resolver_build_elapsed = resolver_build_started.elapsed();
    let available_clone_started = std::time::Instant::now();
    let available: BTreeSet<String> = files.iter().map(|file| file.path.clone()).collect();
    let available_clone_elapsed = available_clone_started.elapsed();
    // P2-2h item 6: was `syntax.project_files(&project_key).cloned().
    // unwrap_or_default()` -- a full deep clone of EVERY project file's
    // `SyntaxFileResult` (14,082 of them on n8n), paid unconditionally on
    // every single scoped resolve call regardless of how small
    // `affected_paths` is (measured 57-70ms fixed cost per incremental
    // scan, ~13-16% of a steady-state edit's total latency -- see this
    // task's evidence doc). `HybridResolutionContext::files` was already
    // typed as a borrow (`&'a BTreeMap<...>`, `semantic_sites.rs`), so
    // nothing downstream actually needed an owned copy: `syntax` (`&mut
    // SyntaxWorkerState`) is not touched again anywhere else in this
    // function after this point (confirmed by reading the rest of
    // `run_scoped`), so borrowing straight from `syntax.project_files`
    // instead of cloning it is sound. `empty_project_files` only backs
    // the defensive `None` case (a project key `syntax.analyze` did not
    // just populate, which every real call site above already rules out).
    let empty_project_files: BTreeMap<String, urdira_jsts_syntax_worker::SyntaxFileResult> =
        BTreeMap::new();
    let project_files_clone_started = std::time::Instant::now();
    let project_files: &BTreeMap<String, urdira_jsts_syntax_worker::SyntaxFileResult> = syntax
        .project_files(&project_key)
        .unwrap_or(&empty_project_files);
    let project_files_clone_elapsed = project_files_clone_started.elapsed();
    if debug_timing {
        eprintln!(
            "[urdira-indexing-worker] v4 resolve setup: resolver_build={:.3}s available_clone={:.3}s ({} paths) project_files_borrow={:.3}s ({} files)",
            resolver_build_elapsed.as_secs_f64(),
            available_clone_elapsed.as_secs_f64(),
            available.len(),
            project_files_clone_elapsed.as_secs_f64(),
            project_files.len(),
        );
    }
    // P2-2e: typeflow is ALWAYS on in v4 (owner decision 2026-09-02),
    // independent of v3's `URDIRA_JSTS_TYPEFLOW` env gate -- unlike v3's
    // prototype (`main.rs`'s `build_typeflow_program_index`, rebuilt from
    // EVERY current file's source text on every generation), `typeflow`
    // here is the caller's incrementally-maintained `TypeflowCache`
    // (`state::WorkspaceState::typeflow_cache`): only files whose own text
    // changed since the last scan had their `DeclSummary` recomputed (see
    // `TypeflowCache`'s own doc comment for exactly what "incremental"
    // means here). `build_index` itself still runs a full closure pass
    // over the cached summaries, using the SAME `resolver`/`available`/
    // `project_files` this generation's hybrid lane already built above.
    let typeflow_index_started = std::time::Instant::now();
    let typeflow_index = typeflow.build_index(&resolver, &available, project_files);
    let typeflow_index_elapsed = typeflow_index_started.elapsed();
    if debug_timing {
        eprintln!(
            "[urdira-indexing-worker] v4 typeflow build_index: {:.3}s",
            typeflow_index_elapsed.as_secs_f64(),
        );
    }
    // Ambient module resolution task (2026-09-04): built ONCE per scan from
    // this SAME `project_files` snapshot (never per-owner -- see
    // `HybridResolutionContext::ambient_index`'s own doc comment), so a
    // bare specifier's named/default/namespace-value import/reference can
    // resolve through a workspace `declare module "specifier" { ... }`
    // block BEFORE the external-entity classification fires.
    let ambient_index_started = std::time::Instant::now();
    let ambient_index = AmbientModuleIndex::rebuild(project_files);
    let ambient_index_elapsed = ambient_index_started.elapsed();
    if debug_timing {
        eprintln!(
            "[urdira-indexing-worker] v4 ambient index rebuild: {:.3}s",
            ambient_index_elapsed.as_secs_f64(),
        );
    }
    let ctx = HybridResolutionContext {
        resolver: &resolver,
        available: &available,
        files: project_files,
        // Always `Some` (never gated behind an env flag, unlike v3): every
        // site the hybrid lane cannot resolve lexically now also gets a
        // typeflow attempt before falling back to `checker_pending` (there
        // is no checker in v4, so a site typeflow cannot resolve either
        // simply stays in `pending_sites`, exported for the residual pass).
        typeflow_index: Some(typeflow_index),
        // v4 has no checker lane to compare typeflow's guesses against
        // (oracle mode's whole purpose, per `HybridResolutionContext::
        // typeflow_oracle`'s doc comment, is comparing typeflow's
        // resolution to the checker's own independent one) -- always
        // `false` here.
        typeflow_oracle: false,
        ambient_index: &ambient_index,
    };

    let hybrid_owners: Vec<&SourceInput> = affected_paths
        .iter()
        .map(|path| {
            files_by_path.get(path.as_str()).copied().ok_or_else(|| {
                ScanError(format!(
                    "v4 hybrid semantics: affected path is outside source manifest: {path}"
                ))
            })
        })
        .collect::<Result<Vec<_>, ScanError>>()?;
    // Ambient module resolution task (2026-09-04) follow-up, owner-flagged
    // review: reset THIS scan's own count of "would have resolved
    // externally, but a script-level ambient declaration for the same
    // specifier is workspace-ambiguous (or bodyless-shorthand-only), so it
    // correctly stays pending instead" -- see `semantic_sites::
    // AMBIGUOUS_AMBIENT_WOULD_BE_EXTERNAL`'s own doc comment. Distinguishes
    // a real (intentional, spec-required) reduction in v4's own confirmed-
    // reference count from a mere external-to-ambient TARGET SWAP (a swap
    // never touches this counter).
    let debug_ambient_modules = std::env::var_os("URDIRA_V4_DEBUG_AMBIENT_MODULES").is_some();
    if debug_ambient_modules {
        reset_ambiguous_ambient_would_be_external_count();
    }
    let hybrid_call_started = std::time::Instant::now();
    let hybrid_results = run_hybrid_semantics(&hybrid_owners, &ctx, cas_signal)?;
    if debug_timing {
        eprintln!(
            "[urdira-indexing-worker] v4 resolve hybrid_semantics: {:.3}s affected_paths={} hybrid_owners={}",
            hybrid_call_started.elapsed().as_secs_f64(),
            affected_path_count,
            hybrid_owners.len(),
        );
    }
    if debug_ambient_modules {
        eprintln!(
            "[urdira-indexing-worker] v4 ambient-ambiguous-would-be-external this scan: {}",
            ambiguous_ambient_would_be_external_count(),
        );
    }
    clock.record_resolve(resolve_started.elapsed());

    for (path, semantics) in hybrid_results {
        let Some(owner) = owners.get_mut(&path) else {
            // Every affected path has a lane-1 facts entry (the loop above
            // inserts one for each `FactsResult` page, and `affected_paths`
            // is exactly the set `analyze()` reported) -- this branch is
            // unreachable in practice, kept as a hard error instead of a
            // silent drop so a real desync between the two lanes surfaces
            // immediately rather than quietly losing rows.
            return Err(ScanError(format!(
                "v4: hybrid semantics produced rows for {path}, which has no lane-1 facts entry"
            )));
        };
        owner.records.extend(semantics.reference_rows);
        owner.records.extend(semantics.covers_rows);
        owner.records.extend(semantics.call_rows);
        owner.records.extend(semantics.heritage_rows);
        // P2-2e: typeflow's own two buckets (`core:call` rows resolved
        // through declared-type member lookup, `core:inherits`/
        // `core:implements` rows resolved through generic-erased heritage)
        // -- same merge `main.rs`'s `merge_hybrid_reference_rows` performs
        // for v3 (`.chain(semantics.typeflow_call_rows.iter()).chain(
        // semantics.typeflow_heritage_rows.iter())`). Each row's body
        // already embeds its own `classification` ("confirmed" or
        // "possible", see `semantic_sites.rs`'s row-builder doc comments),
        // so nothing here needs to inspect or set it.
        owner.records.extend(semantics.typeflow_call_rows);
        owner.records.extend(semantics.typeflow_heritage_rows);
        // A2 (pending.sites migration, 2026-09-04): every pending call/
        // heritage site that neither the E1-E3 lane nor typeflow resolved
        // used to publish a `classification: "possible"` `core:call`/
        // `core:inherits`/`core:implements` RECORD with no `target_id` (the
        // P2-2i "v3 parity fix"). That record is GONE -- `owner.records`
        // never receives a no-target relation row any more; the same
        // population now lives on `owner.pending_site_rows`, consumed by
        // `materialize.rs`/`crate::v4::residual` instead of the query
        // engine. See `OwnerSemantics::pending_site_rows`'s doc comment in
        // `urdira-jsts-syntax-worker` for the exact contract this closes.
        //
        // P2-2j item 3: measurement-only escape hatch, gated behind an env
        // var an operator must deliberately set -- NEVER on by default, and
        // NOT a real feature (it silently drops candidate rows a real
        // workspace scan must publish). Exists purely so this task's
        // evidence doc can report the candidate rows' own marginal
        // materialize/publish cost on a real corpus by diffing a normal run
        // against a run with this set. `pending_sites`/`pending_site_rows`
        // are still recorded either way (the residual-pass input contract
        // these fields feed is independent of whether a candidate ROW gets
        // published).
        if std::env::var_os("URDIRA_V4_SUPPRESS_POSSIBLE_ROWS_FOR_MEASUREMENT_ONLY").is_none() {
            // P2-2j: per-candidate `possible` `core:call` rows (own
            // `target_id` each) for a call site whose typeflow receiver was
            // an overload set or a union -- see `OwnerSemantics::
            // candidate_call_rows`'s own doc comment. The site itself still
            // contributes a `pending_site_rows`/`pending_sites` entry
            // regardless (see below), independent of whether any candidate
            // ROW gets published.
            owner.records.extend(semantics.candidate_call_rows);
        }
        // Parameter entities, "every declaration" variant (2026-09-06,
        // owner-approved fidelity fix superseding the 2026-09-04
        // "referenced-only" cut): one `jsts:entity_parameter` record + one
        // `core:contains` record per parameter/catch-binding declaration in
        // this owner, REGARDLESS of whether any reference in this owner (or
        // any other) ever targets it -- see `OwnerSemantics::
        // parameter_entity_rows`'s own doc comment in `urdira-jsts-syntax-
        // worker` for the exact `parent_id` resolution rule and why
        // fidelity (every declared parameter visible to `get_outline`) beats
        // the earlier "only if referenced" population trim. Unconditional
        // (unlike `candidate_call_rows` above): there is no measurement
        // escape hatch for these, they are load-bearing both for `core:
        // references`'s own `target_subject` on a parameter target AND for
        // `get_outline`'s completeness.
        owner.records.extend(semantics.parameter_entity_rows);
        owner.records.extend(semantics.parameter_contains_rows);
        // External package/symbol entities task (2026-09-04): one `jsts:
        // external_module`/`jsts:external_symbol` entity per DISTINCT
        // identity this owner's own imports/re-exports/namespace-member
        // reads resolved to (already deduped WITHIN this owner by
        // `SemanticWalker::finish`), plus one `core:contains` row per
        // occurrence. Cross-OWNER dedup (many files importing the SAME
        // external specifier) happens below, once every owner's records
        // exist -- see `dedupe_external_entities_across_owners`'s own doc
        // comment for the full mechanism and its documented edit/delete
        // limitation.
        owner.records.extend(semantics.external_entity_rows);
        owner.records.extend(semantics.external_contains_rows);
        owner.pending_sites = semantics.pending_sites;
        owner.pending_site_rows = semantics.pending_site_rows;
        // Frente E-P0f (2026-09-07, ambient-global-dependents integrity
        // fix): turn every cross-file ambient-global dependency this
        // owner's hybrid lane just proved (`OwnerSemantics::ambient_
        // global_dependencies`) into a `ProposedRecordDependency` on the
        // SAME channel `deps.rs::materialize_dependencies` already uses
        // for ordinary import/export dependencies -- see that field's own
        // doc comment for the full root-cause writeup: without a
        // persisted `DependencyRow` here, a LATER generation's delta
        // computation has no edge to walk when the declaring script
        // itself is edited/deleted/created, so this owner's own stale
        // `core:references` rows (materialized THIS generation, from THIS
        // exact resolution) would survive untouched forever.
        //
        // `dependency_target_path`/`dependency_artifact_id`/`_version_id`
        // are resolved the same way `owner.owner_artifact_id`/`_version_id`
        // are above (line ~579): straight from this SAME scan's own
        // `files_by_path`, never `project.source_metadata` (that map lives
        // inside `urdira-jsts-syntax-worker`'s private `ProjectState`, not
        // exposed to this crate) -- the declaring path came from `ambient_
        // index`, itself built from this SAME `project_files`/`files`
        // snapshot, so it is always a member of `files_by_path` too.
        // `proposed_dependency_id`/`proposal_record_key` are deliberately
        // NOT built the `resolved_dependencies` way (hashed from an
        // underlying `core:import`/`core:export` relation's own `id`) --
        // an ambient-global dependency has no single relation it
        // exclusively backs (one script -> declarer edge can underlie
        // several distinct `core:references` occurrences in this owner),
        // so `record_ordinal_by_proposal_key` is expected to (and always
        // does) miss for these, leaving `DependencyRow.record` `None` --
        // exactly the same "handled defensively" case `deps.rs::
        // materialize_dependencies`'s own doc comment already documents
        // for a dependency with no attached relation record.
        for declaring_path in &semantics.ambient_global_dependencies {
            let Some(declaring_file) = files_by_path.get(declaring_path.as_str()) else {
                // Defensive only: `declaring_path` was proven live by THIS
                // SAME scan's own `ambient_index` (built from `project_
                // files`, itself derived from `files`), so it is always
                // present here too.
                continue;
            };
            owner.dependencies.push(ProposedRecordDependency {
                proposed_dependency_id: format!(
                    "jsts:ambient-global-dependency:{}->{declaring_path}",
                    owner.owner_path,
                ),
                proposal_record_key: format!(
                    "jsts:ambient-global-dependency-record:{}->{declaring_path}",
                    owner.owner_path,
                ),
                dependency_artifact_id: declaring_file.artifact_id.clone(),
                dependency_artifact_version_id: declaring_file.artifact_version_id.clone(),
                dependency_target_path: declaring_path.clone(),
                dependency_role: AMBIENT_GLOBAL_DEPENDENCY_ROLE,
                dependency_basis: "ambient_global_resolution",
                source_reference: serde_json::json!({
                    "reference_type": "ambient_global",
                    "declaring_path": declaring_path,
                }),
            });
        }
    }

    let mut owners: Vec<OwnerFacts> = owners.into_values().collect();
    owners.sort_by(|a, b| a.owner_path.cmp(&b.owner_path));
    dedupe_external_entities_across_owners(&mut owners);
    Ok(ColdAnalysis { owners })
}

/// External package/symbol entities task (2026-09-04): `urdira-structural-
/// store`'s `records` table has no mechanism to dedup two DIFFERENT owners
/// proposing the SAME record identity within one materialize batch --
/// `materialize.rs`'s `identity_key_to_ordinal`/`identity_key_digest_to_
/// record_id` maps are last-write-wins for SUBJECT RESOLUTION, but every
/// owner's row still gets pushed into the `records`/partition output
/// unconditionally (confirmed by reading `materialize_generation`'s and
/// `materialize_cold_partitioned`'s owner loops directly: neither checks
/// for a pre-existing identity before pushing a `RecordRow`) -- two owners
/// proposing `jsts:external_module:lodash` would otherwise both become
/// live records with the identical identity, which nothing downstream
/// expects (`StoreReader::by_identity_last`, `core:contains`/relation
/// subject resolution, and every count/root derived from `records` all
/// assume at most one live row per identity).
///
/// This is the "cleanest" mechanism the task brief itself named: every
/// importing owner proposes the external module/symbol entity with the
/// SAME identity_key and a BYTE-IDENTICAL body (`external_module_entity`/
/// `external_symbol_entity` are pure functions of the specifier/name alone,
/// never the importing file -- see their own doc comments), and this pass
/// keeps exactly ONE of the (many, identical) proposals per identity,
/// applied AFTER `owners` is sorted by `owner_path` (line above), so the
/// keeper is always the alphabetically-FIRST importing owner in this batch
/// -- deterministic, reproducible across runs of the same corpus. `core:
/// contains` rows are NEVER touched here: their identity already varies per
/// occurrence (`(path, start, end, source_id, target_id)`), so every
/// importer keeps its own contains edge regardless of which owner "won" the
/// entity.
///
/// **Edit/delete behavior (verified live, not merely reasoned about -- see
/// `dedupe_external_entities_keeps_first_owner_deterministically`/the v4
/// daemon e2e external-entities test)**: the "winning" owner becomes that
/// identity's `owner_artifact` in the store. `diff_owner` (`diff.rs`)
/// diffs each SCANNED owner's prior rows against its fresh proposals; an
/// owner NOT in the current incremental batch is not reprocessed at all.
/// So: (a) editing the winning owner while it keeps the same import
/// re-proposes the identical identity+body -> `diff_owner`'s "unchanged"
/// case, no churn; (b) editing the winning owner to DROP the import (or
/// deleting it) while another, unscanned owner still imports the same
/// specifier closes the entity's current row (`diff_owner`'s "not matched
/// -> close" tail) even though the OTHER importer still needs it -- the
/// entity temporarily disappears from the live store; (c) the NEXT
/// incremental scan that touches ANY other importer of the same specifier
/// re-proposes the identical identity+body, and `diff_owner`'s store-wide
/// `by_identity_last` lookup finds it closed and REOPENS it (chained,
/// `"reopen"` case) -- so the entity recovers on the next scan that
/// happens to touch a surviving importer, and always recovers on the next
/// FULL cold rescan (every owner is in the same batch again, this
/// function's own dedup runs fresh). This is a documented, accepted
/// limitation (owner sign-off, task brief's own explicit escape hatch),
/// not a bug: no COLD scan and no scan that touches every remaining
/// importer can ever lose the entity, and the gap is self-healing rather
/// than permanent.
fn dedupe_external_entities_across_owners(owners: &mut [OwnerFacts]) {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for owner in owners.iter_mut() {
        owner.records.retain(|record| {
            if record.category != "entity" {
                return true;
            }
            if !(record.identity_key.starts_with("jsts:external_module:")
                || record.identity_key.starts_with("jsts:external_symbol:"))
            {
                return true;
            }
            seen.insert(record.identity_key.clone())
        });
    }
}

/// Cold (`Full`) convenience wrapper over [`run_scoped`], kept so
/// `scan::run`/`tests_e2e.rs`'s existing cold call sites do not need to name
/// `AuthoritativeChangeSet::Full` themselves. `syntax` is still the caller's
/// persistent `SyntaxWorkerState` (P3-1 deliverable 1) -- even a cold scan
/// now benefits from it: a SECOND `Full` scan of an unchanged workspace in
/// the same process (e.g. a forced full rescan) hits `analyze()`'s own
/// "changed.is_empty() && reset_reason.is_none()" fast path instead of
/// reparsing from scratch, since `syntax`'s cached `source_metadata` already
/// matches.
/// Also returns the [`super::state::SourceCache`] it built along the way
/// (P3-2 item 1) so a cold-scan caller (`scan::run_full`) can seed
/// `WorkspaceState.source_cache` with it on success -- the first `Changed`
/// scan for this workspace in the same process then starts warm instead of
/// paying its own from-scratch build.
pub fn run_cold(
    frontier: &Frontier,
    cas_root: &Path,
    workspace_id: &str,
    syntax: &mut SyntaxWorkerState,
    clock: &mut ScanClock,
    cas_signal: &CasWrittenSignal,
) -> Result<
    (
        ColdAnalysis,
        super::state::SourceCache,
        super::typeflow::TypeflowCache,
    ),
    ScanError,
> {
    let cache = super::state::SourceCache::build_full(frontier, cas_root)?;
    let files_vec = cache.files_vec();
    let typeflow_build_started = std::time::Instant::now();
    let mut typeflow_cache =
        super::typeflow::TypeflowCache::build_full(&files_vec, Some(cas_signal))?;
    if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
        eprintln!(
            "[urdira-indexing-worker] v4 typeflow build_full (DeclSummary extraction, {} files): {:.3}s",
            files_vec.len(),
            typeflow_build_started.elapsed().as_secs_f64(),
        );
    }
    let analysis = run_scoped(
        files_vec,
        cache.config_assets_vec(),
        workspace_id,
        syntax,
        AuthoritativeChangeSet::Full,
        clock,
        &mut typeflow_cache,
        Some(cas_signal),
        &[],
    )?;
    Ok((analysis, cache, typeflow_cache))
}

/// Incremental (`Changed`) entry point over [`run_scoped`] (P3-1 deliverable
/// 3c): `changed_artifact_ids` names exactly the paths whose CONTENT
/// differs from `syntax`'s cached state (source-frontier's `Delta::changed`
/// bucket, mapped to the new frontier's `artifact_id` -- never the `added`
/// bucket, see `run_scoped`'s doc comment for why pure additions/removals
/// take the cheaper path automatically). Returns the affected owners
/// (`ColdAnalysis.owners`, despite the name -- see `run_scoped`'s own doc
/// comment: the SAME owner-scoping logic already restricts a cold scan's
/// output to "every current file" and an incremental scan's output to
/// "exactly the closure `analyze()` computed", so one field name serves
/// both).
/// `files`/`config_assets` are the caller's already-updated
/// `state::SourceCache` snapshot (P3-2 item 1) -- `delta::run` applies the
/// current catalog delta to its cached `WorkspaceState.source_cache`
/// BEFORE calling this, so this function itself does zero frontier-walking
/// work.
#[allow(clippy::too_many_arguments)]
pub fn run_incremental(
    files: Vec<SourceInput>,
    config_assets: Vec<ConfigAssetInput>,
    workspace_id: &str,
    syntax: &mut SyntaxWorkerState,
    changed_artifact_ids: Vec<String>,
    clock: &mut ScanClock,
    typeflow: &mut super::typeflow::TypeflowCache,
    extra_affected_paths: &[String],
) -> Result<ColdAnalysis, ScanError> {
    // `None`: `delta::run` (this function's only production caller) writes
    // every changed path's CAS blob SYNCHRONOUSLY, via a bare `CasStore`
    // (`Walker::observe_paths(..., Some(&cas_store))`), before this is ever
    // called -- there is no background queue to wait on here. See
    // `read_owner_source_text`'s own doc comment for the full reasoning.
    run_scoped(
        files,
        config_assets,
        workspace_id,
        syntax,
        AuthoritativeChangeSet::Exact {
            changed_artifact_ids,
        },
        clock,
        typeflow,
        None,
        extra_affected_paths,
    )
}

/// P2-2d: was a fixed `available_parallelism()`-sized static block
/// partition over `std::thread::scope` OS threads, same load-imbalance
/// risk as the facts-extraction lane above (see its own comment) but with
/// no cursor-continuation constraint at all here -- `analyze_one` is a
/// pure, independent per-file call, so there is no reason not to let
/// `rayon`'s work-stealing pool balance individual files directly rather
/// than pre-assigning fixed contiguous ranges to threads up front.
fn run_hybrid_semantics(
    owners: &[&SourceInput],
    ctx: &HybridResolutionContext<'_>,
    cas_signal: Option<&CasWrittenSignal>,
) -> Result<Vec<(String, urdira_jsts_syntax_worker::OwnerSemantics)>, ScanError> {
    owners
        .par_iter()
        .map(|owner| analyze_one(owner, ctx, cas_signal))
        .collect()
}

fn analyze_one(
    owner: &SourceInput,
    ctx: &HybridResolutionContext<'_>,
    cas_signal: Option<&CasWrittenSignal>,
) -> Result<(String, urdira_jsts_syntax_worker::OwnerSemantics), ScanError> {
    let text = read_owner_source_text(owner, cas_signal)?;
    let semantics =
        analyze_owner_semantics_with_context(&owner.path, &text, ctx).map_err(|error| {
            ScanError(format!(
                "v4 hybrid semantics failed for {}: {}",
                owner.path, error.message
            ))
        })?;
    Ok((owner.path.clone(), semantics))
}
