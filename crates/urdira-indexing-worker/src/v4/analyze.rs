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
use super::timings::ScanClock;
use rayon::prelude::*;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use urdira_jsts_syntax_worker::{
    AnalysisBudgets, ConfigAssetInput, HybridResolutionContext, ProposedRecord,
    ProposedRecordDependency, SourceInput, SyntaxFileResult, SyntaxWorkerState, WorkerMessage,
    WorkspaceResolver, analyze_owner_semantics_with_context, decode_config_assets,
};
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

/// Reads and hash-verifies an owner's source bytes (same check as
/// `main.rs`'s private `read_owner_source_text`, main.rs:817-833 -- this is
/// an independent copy for the same isolation reason as the predicates
/// above). `pub(crate)`: `v4::typeflow` also needs this to read a changed
/// owner's text when (re)building its `DeclSummary` (P2-2e).
pub(crate) fn read_owner_source_text(owner: &SourceInput) -> Result<String, ScanError> {
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
    file.export_bindings
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
        .collect()
}

pub fn run_scoped(
    files: Vec<SourceInput>,
    config_assets: Vec<ConfigAssetInput>,
    workspace_id: &str,
    syntax: &mut SyntaxWorkerState,
    change_set: AuthoritativeChangeSet,
    clock: &mut ScanClock,
    typeflow: &mut super::typeflow::TypeflowCache,
) -> Result<ColdAnalysis, ScanError> {
    if files.is_empty() {
        return Ok(ColdAnalysis { owners: Vec::new() });
    }

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
    let hybrid_call_started = std::time::Instant::now();
    let hybrid_results = run_hybrid_semantics(&hybrid_owners, &ctx)?;
    if debug_timing {
        eprintln!(
            "[urdira-indexing-worker] v4 resolve hybrid_semantics: {:.3}s affected_paths={} hybrid_owners={}",
            hybrid_call_started.elapsed().as_secs_f64(),
            affected_path_count,
            hybrid_owners.len(),
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
        // P2-2i: v3 parity fix -- every pending call/heritage site that
        // neither the E1-E3 lane nor typeflow resolved now publishes a
        // `classification: "possible"` `core:call`/`core:inherits`/
        // `core:implements` row (a call site's row is paired with a
        // `jsts:unresolved_call` diagnostic, interleaved in this same
        // field) instead of being silently dropped -- see
        // `OwnerSemantics::possible_call_rows`/`::possible_heritage_rows`'s
        // doc comments in `urdira-jsts-syntax-worker` for the exact
        // contract this closes.
        // P2-2j item 3: measurement-only escape hatch, gated behind an env
        // var an operator must deliberately set -- NEVER on by default, and
        // NOT a real feature (it silently drops possible/diagnostic rows a
        // real workspace scan must publish, per P2-2i's own "v3 parity"
        // fix this comment sits next to). Exists purely so this task's
        // evidence doc can report the possible+diagnostic rows' own
        // marginal materialize/publish cost on a real corpus by diffing a
        // normal run against a run with this set -- see that doc's
        // "diagnostics cost" section. `pending_sites` is still recorded
        // either way (the residual-pass input contract this field feeds is
        // independent of whether a possible ROW gets published).
        if std::env::var_os("URDIRA_V4_SUPPRESS_POSSIBLE_ROWS_FOR_MEASUREMENT_ONLY").is_none() {
            owner.records.extend(semantics.possible_call_rows);
            owner.records.extend(semantics.possible_heritage_rows);
        }
        owner.pending_sites = semantics.pending_sites;
    }

    let mut owners: Vec<OwnerFacts> = owners.into_values().collect();
    owners.sort_by(|a, b| a.owner_path.cmp(&b.owner_path));
    Ok(ColdAnalysis { owners })
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
    let mut typeflow_cache = super::typeflow::TypeflowCache::build_full(&files_vec)?;
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
pub fn run_incremental(
    files: Vec<SourceInput>,
    config_assets: Vec<ConfigAssetInput>,
    workspace_id: &str,
    syntax: &mut SyntaxWorkerState,
    changed_artifact_ids: Vec<String>,
    clock: &mut ScanClock,
    typeflow: &mut super::typeflow::TypeflowCache,
) -> Result<ColdAnalysis, ScanError> {
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
) -> Result<Vec<(String, urdira_jsts_syntax_worker::OwnerSemantics)>, ScanError> {
    owners
        .par_iter()
        .map(|owner| analyze_one(owner, ctx))
        .collect()
}

fn analyze_one(
    owner: &SourceInput,
    ctx: &HybridResolutionContext<'_>,
) -> Result<(String, urdira_jsts_syntax_worker::OwnerSemantics), ScanError> {
    let text = read_owner_source_text(owner)?;
    let semantics =
        analyze_owner_semantics_with_context(&owner.path, &text, ctx).map_err(|error| {
            ScanError(format!(
                "v4 hybrid semantics failed for {}: {}",
                owner.path, error.message
            ))
        })?;
    Ok((owner.path.clone(), semantics))
}
