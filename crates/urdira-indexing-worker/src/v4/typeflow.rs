//! v4 typeflow integration (P2-2e; owner decision 2026-09-02): builds and
//! incrementally maintains the same `urdira_jsts_typeflow::ProgramIndex`
//! the v3 hybrid lane's P0-S2/P1 prototype builds in `main.rs`'s
//! `build_typeflow_program_index`, and feeds it into
//! `HybridResolutionContext::typeflow_index` so
//! `analyze_owner_semantics_with_context` (already typeflow-aware, see its
//! own `ctx.typeflow_index` reads in `semantic_sites.rs`) resolves as many
//! `pending_sites` as it lexically/declared-type can for every v4 scan --
//! unconditionally, unlike v3's `URDIRA_JSTS_TYPEFLOW` env gate: typeflow is
//! always on in v4 (task brief).
//!
//! This cache keeps one `DeclSummary` per file across scans and only
//! recomputes an entry when that file's OWN text changed (`replace_file`/
//! `add`/`remove`, mirroring `state::SourceCache`'s own add/change/delete
//! vocabulary) -- a `DeclSummary`'s shape depends only on its own file's
//! syntax, never on any other file's, so an unrelated importer's edit never
//! invalidates it.
//!
//! **P3-8a**: `build_index` no longer rebuilds `ProgramIndex::build`'s own
//! four-pass closure over the FULL summaries map on every call (P2-2e's own
//! documented gap: "the crate exposes no incremental mutation API for
//! `ProgramIndex` itself... not amortize the closure pass itself" -- now it
//! does). This cache keeps ONE persistent `ProgramIndex` (`index`) across
//! scans and a dirty set (`pending_upserted`/`pending_removed`) of paths
//! whose `DeclSummary` changed since the index was last brought up to date;
//! `build_index` applies exactly that dirty set via `ProgramIndex::
//! replace_file`/`add_file`/`remove_file` (which internally widen to the
//! touched files' own transitive importers, `ProgramIndex::importers_of`),
//! instead of rebuilding from scratch. The one-time `needed_imports`
//! collection this module's own `resolve_import_targets_for` performs is
//! ALSO now scoped to exactly the files being (re-)registered this call,
//! not the whole corpus, on the incremental path -- both O(corpus) costs
//! `docs/evidence/2026-09-04-v4-p2-2e-typeflow-in-v4.md` §3/§6 flagged
//! (`build_index`'s own closure pass, and this module's own needed-imports
//! sweep) are addressed together.
//!
//! **Known, accepted scope gap** (documented, not attempted here): a
//! `create` that satisfies a PREVIOUSLY-broken heritage/type-ref/pending-
//! return import (some existing file's `Imported` reference that never
//! resolved because the target file did not exist yet) is not
//! automatically re-visited by `add_from_owner` alone -- `ProgramIndex`'s
//! own `importers_of` reverse graph has no edge to discover for a file that
//! is only now becoming resolvable, since nothing could import a path that
//! did not exist before (see `urdira_jsts_typeflow`'s own crate-level
//! `incremental_matches_from_scratch_after_random_edit_sequences_over_
//! synthetic_project` test, which deliberately excludes this direction for
//! the identical reason). This is a real, narrower gap than "resolve every
//! import a create might unblock" would require fixing wholesale; the v4
//! hybrid semantic lane's own `analyze::run_incremental` already computes
//! a `CandidateIndex`-based reverse-affected closure that WOULD include
//! such newly-unblocked importers for E1-E3's own lexical resolution --
//! wiring `TypeflowCache` to reflow that same widened set (instead of only
//! literally-changed/added/deleted paths) is the natural follow-up, out of
//! this task's scope (it would require threading `analyze::run_incremental`'s
//! `AuthoritativeChangeSet` widening result back into `TypeflowCache`
//! BEFORE `build_index` runs, currently the reverse order).

use super::ScanError;
use super::analyze::read_owner_source_text;
use rayon::prelude::*;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use urdira_jsts_syntax_worker::{
    ExportResolution, SourceInput, SyntaxFileResult, WorkspaceResolver, resolve_named_export,
};
use urdira_jsts_typeflow::{
    DeclSummary, DeferredReturnShape, HeritageTarget, ProgramIndex, RawTypeRef, ReturnEntityRef,
};
use urdira_source_frontier::CasWrittenSignal;

/// Per-file `DeclSummary` cache, kept in `v4::state::WorkspaceState` across
/// `WorkspaceScan` commands for one workspace (same lifetime as
/// `state::SourceCache`), plus (P3-8a) a persistent `ProgramIndex` and the
/// dirty-path bookkeeping `build_index` needs to bring it up to date
/// incrementally. `summaries` stays a `BTreeMap` (not `HashMap`): the COLD
/// path (`index.is_none()`) still calls `ProgramIndex::build` directly,
/// which needs a deterministic iteration order for byte-for-byte
/// reproducibility across two cold runs of the same roots (task brief's
/// determinism requirement).
#[derive(Default)]
pub struct TypeflowCache {
    summaries: BTreeMap<String, DeclSummary>,
    /// `None` until the first `build_index` call (mirrors `state::
    /// SourceCache`/`StoreReader`'s own "first scan after restart" cost
    /// naming) -- built cold from `summaries` wholesale at that point, then
    /// updated incrementally on every later call.
    index: Option<ProgramIndex>,
    /// Paths whose `DeclSummary` changed (or was newly added) since `index`
    /// was last brought up to date -- drained by `build_index`, which
    /// applies each via `ProgramIndex::replace_file`/`add_file`.
    pending_upserted: BTreeSet<String>,
    /// Paths removed since `index` was last brought up to date -- drained
    /// by `build_index`, applied via `ProgramIndex::remove_file`.
    pending_removed: BTreeSet<String>,
}

impl TypeflowCache {
    /// Builds a fresh cache from every current owner (cold scan, or the
    /// first `Changed` scan for a workspace in a freshly-restarted process
    /// -- same "first scan after restart" cost `state::SourceCache::
    /// build_full`'s own doc comment names). A file whose blob cannot be
    /// read/verified, or whose syntax `extract_decl_summary` rejects,
    /// contributes nothing (same safety rule as v3's prototype: absent is
    /// exactly as safe as unresolvable, never a guess). `index` stays
    /// `None` here -- the first `build_index` call does the actual cold
    /// `ProgramIndex::build` (wholesale, matching every path being "new").
    /// P2-2l item 5: `read_owner_source_text` (blob read + hash-verify) and
    /// `extract_decl_summary` (a pure function of one owner's own path/
    /// text, no shared mutable state -- confirmed by reading both) are the
    /// only expensive work this cold, once-per-cache pass does; the loop's
    /// own `BTreeMap`/`BTreeSet` bookkeeping is cheap by comparison.
    /// Measured at 1.2-1.3s single-threaded for n8n's 14,082 files before
    /// this change -- the largest un-parallelized per-file loop this task
    /// found in the cold pipeline's remaining, previously-unattributed
    /// "resolve" window. Parallelized via `par_iter` over `files`,
    /// collecting each file's own outcome, then applying them to `cache`
    /// sequentially (cheap: one `BTreeMap` insert per successfully-
    /// extracted file). This is safe with NO ordering care needed, for two
    /// independent reasons, both confirmed by reading the rest of this
    /// type rather than assumed: (1) `self.summaries` is a `BTreeMap`, so
    /// its iteration order is always sorted-key order regardless of
    /// insertion order -- `ProgramIndex::build`'s own cold-determinism
    /// contract (this module's own doc comment above, and its test)
    /// depends on that iteration order, never on insertion order; (2)
    /// `build_index`'s COLD branch (`self.index.is_none()`, ALWAYS true
    /// the first time `build_index` is called on a cache `build_full` just
    /// produced -- confirmed at every call site) reads `self.summaries`
    /// ONLY and unconditionally clears `pending_upserted`/`pending_
    /// removed` before returning, so this rewrite does not need to
    /// populate those two sets at all (unlike the sequential `replace_
    /// file` this used to call, whose `pending_*` bookkeeping only ever
    /// mattered for `build_index`'s WARM branch, never exercised right
    /// after `build_full`).
    ///
    /// `cas_signal`: `Some` when THIS call may race a still-draining
    /// `CasWriteQueue` from the SAME scan (`analyze::run_cold`'s own call,
    /// the only racy one -- see `read_owner_source_text`'s doc comment for
    /// the full reasoning); `None` for `delta.rs`'s first-scan-after-restart
    /// fallback call, whose blobs were already written synchronously
    /// earlier in that same function, and for every test call site that
    /// writes its fixture blobs directly.
    pub fn build_full(
        files: &[SourceInput],
        cas_signal: Option<&CasWrittenSignal>,
    ) -> Result<Self, ScanError> {
        let mut cache = TypeflowCache::default();
        let extracted: Vec<(&str, Result<Option<DeclSummary>, ScanError>)> = files
            .par_iter()
            .map(|owner| {
                let outcome = read_owner_source_text(owner, cas_signal).map(|text| {
                    urdira_jsts_typeflow::extract_decl_summary(&owner.path, &text).ok()
                });
                (owner.path.as_str(), outcome)
            })
            .collect();
        for (path, outcome) in extracted {
            if let Some(summary) = outcome? {
                cache.summaries.insert(path.to_owned(), summary);
            }
        }
        Ok(cache)
    }

    /// Re-extracts (or, on read/parse failure, drops) `owner`'s
    /// `DeclSummary` from its current source text. Used for both an
    /// existing file's content edit and a brand-new file (`add`'s doc
    /// comment) -- both cases are "this path's summary, if any, is stale;
    /// recompute it from scratch", the same rule `state::SourceCache::
    /// apply_delta` already applies to its own two maps.
    pub fn replace_file_from_owner(&mut self, owner: &SourceInput) -> Result<(), ScanError> {
        // `None`: this method is only called from `delta.rs`'s incremental
        // path, whose CAS blobs are already written synchronously before
        // this call happens (see `read_owner_source_text`'s doc comment).
        let text = read_owner_source_text(owner, None)?;
        self.replace_file(&owner.path, &text);
        Ok(())
    }

    /// Same as [`Self::replace_file_from_owner`], for a caller that already
    /// has the file's text in hand (avoids a second blob read when the
    /// caller -- `delta::run` -- already read it for another purpose).
    /// `add`/`replace_file` are the SAME operation on this cache (a
    /// `DeclSummary` has no notion of "this path is new" vs "this path's
    /// content changed"; both simply (re)insert the current summary),
    /// named separately only so call sites can express intent the way
    /// `state::SourceCache`'s own doc comments do. Marks `path` dirty
    /// (`pending_upserted`/`pending_removed`) for the NEXT `build_index`
    /// call to actually apply to `index` -- this method itself never
    /// touches `index` (it may not even exist yet, and even when it does,
    /// updating it needs the resolver/available/files triple this method
    /// does not have).
    pub fn replace_file(&mut self, path: &str, source_text: &str) {
        match urdira_jsts_typeflow::extract_decl_summary(path, source_text) {
            Ok(summary) => {
                self.summaries.insert(path.to_string(), summary);
                self.pending_removed.remove(path);
                self.pending_upserted.insert(path.to_string());
            }
            Err(_) => {
                self.summaries.remove(path);
                self.pending_upserted.remove(path);
                self.pending_removed.insert(path.to_string());
            }
        }
    }

    /// `add`, reading `owner`'s text from its blob (mirrors
    /// [`Self::replace_file_from_owner`] for a brand-new path -- SAME
    /// operation as `replace_file`/`replace_file_from_owner`, see that
    /// method's doc comment for why -- used by `delta::run` for
    /// `source_delta.added` entries, kept as its own name so that call site
    /// reads the same add/change/delete vocabulary `state::SourceCache::
    /// apply_delta` already uses for its own two maps).
    pub fn add_from_owner(&mut self, owner: &SourceInput) -> Result<(), ScanError> {
        self.replace_file_from_owner(owner)
    }

    /// Drops `path`'s `DeclSummary`, if any, and marks it dirty for removal
    /// from `index` on the next `build_index` call.
    pub fn remove(&mut self, path: &str) {
        self.summaries.remove(path);
        self.pending_upserted.remove(path);
        self.pending_removed.insert(path.to_string());
    }

    /// Brings `index` up to date with every `replace_file`/`add_from_owner`/
    /// `remove` call since the last `build_index` call, using `resolver`/
    /// `available`/`files` (this generation's already-built resolver, path
    /// set, and post-`analyze()` `SyntaxFileResult`s -- the same three
    /// inputs `run_scoped` already has in hand for `HybridResolutionContext`
    /// itself), then returns a reference to it.
    ///
    /// Cold (`index.is_none()`): builds the whole corpus from scratch, the
    /// ORIGINAL P0-S2/P1 recipe (`main.rs`'s `build_typeflow_program_index`)
    /// -- unchanged behavior, still fully deterministic (`ProgramIndex::
    /// build` over a `BTreeMap`, `resolve_import_targets_for` over a
    /// sorted path list). Two calls against two INDEPENDENT `TypeflowCache`s
    /// built from identical `summaries`/`files`/`resolver`/`available`
    /// still produce indistinguishable `ProgramIndex`s (task brief's
    /// cold-determinism requirement) -- see this module's own
    /// `build_index_incremental_matches_a_fresh_cache_after_an_edit` test.
    ///
    /// Warm: applies exactly the dirty set accumulated since the last call
    /// -- `pending_removed` via `ProgramIndex::remove_file`, then
    /// `pending_upserted` via `ProgramIndex::replace_file` (an alias for
    /// `add_file`, see that method's own doc comment), each with a FRESH,
    /// narrowly-scoped `import_targets` snapshot covering only `path`
    /// itself and `index.importers_of(path)` (queried BEFORE the update,
    /// using the pre-edit graph) -- see `ProgramIndex::replace_file`'s own
    /// doc comment for why refreshing importers matters (an edit can shift
    /// an exported entity's `start`-keyed id) and why omitting one is safe
    /// regardless (never produces a WRONG answer, only a possibly-stale-
    /// until-that-importer's-own-next-edit "unresolved").
    pub fn build_index(
        &mut self,
        resolver: &WorkspaceResolver,
        available: &BTreeSet<String>,
        files: &BTreeMap<String, SyntaxFileResult>,
    ) -> &ProgramIndex {
        if self.index.is_none() {
            let all_paths: Vec<&str> = self.summaries.keys().map(String::as_str).collect();
            let import_targets = resolve_import_targets_for(
                &self.summaries,
                all_paths.into_iter(),
                resolver,
                available,
                files,
            );
            self.index = Some(ProgramIndex::build(&self.summaries, &import_targets));
            self.pending_upserted.clear();
            self.pending_removed.clear();
            return self.index.as_ref().expect("just assigned above");
        }

        let removed = std::mem::take(&mut self.pending_removed);
        let upserted = std::mem::take(&mut self.pending_upserted);
        {
            let index = self
                .index
                .as_mut()
                .expect("checked Some via the is_none() branch above");
            for path in &removed {
                index.remove_file(path);
            }
            // Frente E-P0c fix (Brecha B "second finding", 2026-09-07): a
            // BOUNDED FIXED-POINT settling loop over `upserted`, not a
            // single pass. This function's own doc comment already names
            // the exact gap a single pass leaves open: each `path`'s own
            // `refresh_paths` is `index.importers_of(path)` queried the
            // moment `path` itself is (re)inserted -- for a MULTI-FILE edit
            // batch where an owner `path` and one of its OWN importers are
            // BOTH in `upserted`, the two paths' relative order in this
            // `BTreeSet` iteration can decide whether the importer's own
            // `resolve_import_targets_for` call (scoped to ITS OWN
            // `refresh_paths`, computed during the IMPORTER's own turn)
            // ever gets a chance to resolve against the EXPORTER's fresh
            // (post-edit) shape -- confirmed live on two SEPARATE n8n
            // `tags-3-months` git-switch pairs (`types/bridge.ts`'s `debug`
            // method + its caller `bridge/isolated-vm-bridge.ts`; `@n8n/
            // config`'s `expression-engine.config.ts` properties +
            // `cli/expression-observability/expression-observability.
            // provider.ts`'s constructor/method reading them), both edited
            // together in the same real commit range. A single extra pass
            // closed the FIRST pair but not the second (a chain one hop
            // longer, or simply the wrong relative order for THAT pair) --
            // rather than guess a fixed pass count, this loop repeats the
            // exact per-path work (`importers_of(path)` + `resolve_import_
            // targets_for` + `replace_file`) until two consecutive rounds
            // produce BYTE-IDENTICAL `import_targets` resolutions for every
            // `upserted` path (a real fixed point, matching the "four-pass
            // closure... to converge" fixed-point language `urdira_jsts_
            // typeflow`'s own crate doc already uses for `ProgramIndex`'s
            // internal reflow), capped at `MAX_SETTLING_ROUNDS` as a
            // defensive backstop (logged, never silently truncated) against
            // a pathological non-converging edit graph. Bounded by
            // `upserted`'s own size per round (never the whole corpus), so
            // this preserves the per-edit cost class this module's own doc
            // comment establishes for the common single-file-edit case
            // (`upserted.len() <= 1` can never have a cross-file ordering
            // conflict with itself, so it always converges after exactly
            // one round, unchanged from this function's pre-existing,
            // already-tested behavor); idempotent once the fixed point is
            // reached, since `replace_file`'s own internal `reflow_files`
            // is itself idempotent over unchanged inputs.
            const MAX_SETTLING_ROUNDS: usize = 8;
            let mut previous_round: Option<HashMap<(String, String, String), String>> = None;
            for round in 0..MAX_SETTLING_ROUNDS {
                let mut round_updates: HashMap<(String, String, String), String> = HashMap::new();
                for path in &upserted {
                    let Some(summary) = self.summaries.get(path) else {
                        // Upserted then removed again before this
                        // `build_index` call ever ran (both edits landed
                        // in the SAME generation's dirty set) --
                        // `pending_removed` already handled it above;
                        // nothing left to insert.
                        continue;
                    };
                    let mut refresh_paths: Vec<String> = index.importers_of(path);
                    refresh_paths.push(path.clone());
                    let updates = resolve_import_targets_for(
                        &self.summaries,
                        refresh_paths.iter().map(String::as_str),
                        resolver,
                        available,
                        files,
                    );
                    round_updates.extend(updates.iter().map(|(k, v)| (k.clone(), v.clone())));
                    index.replace_file(path, summary.clone(), &updates);
                }
                let converged = previous_round.as_ref() == Some(&round_updates);
                previous_round = Some(round_updates);
                if converged {
                    break;
                }
                if round + 1 == MAX_SETTLING_ROUNDS {
                    eprintln!(
                        "[urdira-indexing-worker] v4 typeflow: settling loop did not converge \
                         within {MAX_SETTLING_ROUNDS} rounds for {} upserted path(s) -- \
                         proceeding with the last round's state (a from-scratch cold scan of \
                         this generation would still be correct if this ever fires in practice)",
                        upserted.len(),
                    );
                }
            }
        }
        self.index
            .as_ref()
            .expect("populated by the branches above")
    }

    #[cfg(test)]
    pub(crate) fn summary_count(&self) -> usize {
        self.summaries.len()
    }
}

/// Every distinct `(owning_path, specifier, imported_name)` triple that
/// typeflow's rules could ever need to close for exactly `paths` (heritage
/// clauses, member/return declared types, and `pending_return`
/// `CallEntity` shapes) -- resolved via `resolver`/`available`/`files`, the
/// same recipe `main.rs`'s `build_typeflow_program_index` uses corpus-wide
/// (duplicated here per this task's isolation rule: this crate's `v4`
/// module cannot import a private fn from the same binary crate's
/// `main.rs`, and `main.rs` is out of this task's edit scope). Scoped to
/// `paths` (the COLD path's full corpus, or the WARM path's touched-file-
/// plus-importers set) rather than always sweeping every cached summary --
/// see this module's own doc comment for why that scoping matters for the
/// per-edit cost target.
fn resolve_import_targets_for<'a>(
    summaries: &BTreeMap<String, DeclSummary>,
    paths: impl Iterator<Item = &'a str>,
    resolver: &WorkspaceResolver,
    available: &BTreeSet<String>,
    files: &BTreeMap<String, SyntaxFileResult>,
) -> HashMap<(String, String, String), String> {
    let mut needed_imports: HashSet<(&str, &str, &str)> = HashSet::new();
    for path in paths {
        let Some(summary) = summaries.get(path) else {
            continue;
        };
        collect_needed_imports_for_summary(summary, &mut needed_imports);
    }

    let mut import_targets: HashMap<(String, String, String), String> = HashMap::new();
    for (owning_path, specifier, imported_name) in needed_imports {
        let key = (
            owning_path.to_owned(),
            specifier.to_owned(),
            imported_name.to_owned(),
        );
        let Some(target_path) = resolver.resolve(owning_path, specifier, available) else {
            continue;
        };
        // 3a (urdira-jsts-syntax-worker, 2026-09-05): `resolve_named_export`
        // gained a policy parameter; `UniqueOrAmbiguous` reproduces this
        // call's exact prior behavior (typeflow's own import-target
        // resolution is unrelated to the overload/reference-vs-call split).
        if let ExportResolution::Resolved(target_id) = resolve_named_export(
            files,
            &target_path,
            imported_name,
            urdira_jsts_syntax_worker::ExportPolicy::UniqueOrAmbiguous,
        ) {
            import_targets.insert(key, target_id);
        }
    }
    import_targets
}

/// One file's own contribution to `resolve_import_targets_for`'s
/// `needed_imports` set -- byte-identical walk to the per-summary loop
/// body the pre-P3-8a `build_index` ran inline over EVERY cached summary
/// on every call.
fn collect_needed_imports_for_summary<'s>(
    summary: &'s DeclSummary,
    out: &mut HashSet<(&'s str, &'s str, &'s str)>,
) {
    for class in &summary.classes {
        if let Some(target) = &class.extends {
            collect_heritage_import(&summary.path, target, out);
        }
        for target in &class.implements {
            collect_heritage_import(&summary.path, target, out);
        }
        for member in &class.members {
            collect_type_ref_import(&summary.path, &member.type_ref, out);
            collect_pending_return_import(&summary.path, &member.pending_return, out);
        }
    }
    for interface in &summary.interfaces {
        for target in &interface.extends {
            collect_heritage_import(&summary.path, target, out);
        }
        for member in &interface.members {
            collect_type_ref_import(&summary.path, &member.type_ref, out);
        }
    }
    for function in &summary.functions {
        collect_type_ref_import(&summary.path, &function.return_type, out);
        collect_pending_return_import(&summary.path, &function.pending_return, out);
    }
    for shape in &summary.object_shapes {
        for member in &shape.members {
            collect_type_ref_import(&summary.path, &member.type_ref, out);
            collect_pending_return_import(&summary.path, &member.pending_return, out);
        }
    }
    for variable in &summary.variables {
        collect_type_ref_import(&summary.path, &variable.type_ref, out);
    }
    // D.2b (2026-09-05, references-parity task): `type X = ImportedFoo`
    // (or `type X = { a: ImportedFoo }`, `type X = ImportedFoo[]`, ...) --
    // `type_aliases` was added to `DeclSummary` by D.2 (typeflow's own
    // `build_alias_targets`/`resolve_type_ref_chasing_aliases`) but this
    // needed-imports scan never visited it, so an alias whose RHS names an
    // import had no `import_targets` entry to resolve against and stayed
    // pending forever regardless of D.2's own de-aliasing logic being
    // otherwise correct -- found live against the n8n corpus
    // (`ObservationLogReflectorMemory = BuiltObservationLogStore`,
    // `packages/@n8n/agents/src/runtime/observation-log-reflector.ts`).
    for alias in &summary.type_aliases {
        collect_type_ref_import(&summary.path, &alias.target, out);
    }
}

/// Byte-identical helper to `main.rs`'s own `collect_heritage_import` (see
/// its doc comment for the rule: only a NAMED import needs closing; a
/// `<base>.<member>(...)` heritage call recurses one level to `base`'s own
/// import need).
fn collect_heritage_import<'s>(
    owning_path: &'s str,
    target: &'s HeritageTarget,
    out: &mut HashSet<(&'s str, &'s str, &'s str)>,
) {
    match target {
        HeritageTarget::Imported {
            specifier,
            imported_name: Some(imported_name),
        } => {
            out.insert((owning_path, specifier.as_str(), imported_name.as_str()));
        }
        HeritageTarget::CallMember { base, .. } => {
            collect_heritage_import(owning_path, base, out);
        }
        _ => {}
    }
}

/// Byte-identical helper to `main.rs`'s own `collect_type_ref_import`.
fn collect_type_ref_import<'s>(
    owning_path: &'s str,
    type_ref: &'s RawTypeRef,
    out: &mut HashSet<(&'s str, &'s str, &'s str)>,
) {
    match type_ref {
        RawTypeRef::Imported {
            specifier,
            imported_name: Some(imported_name),
        } => {
            out.insert((owning_path, specifier.as_str(), imported_name.as_str()));
        }
        RawTypeRef::ArrayOf(inner) | RawTypeRef::PromiseOf(inner) => {
            collect_type_ref_import(owning_path, inner, out);
        }
        _ => {}
    }
}

/// Byte-identical helper to `main.rs`'s own `collect_pending_return_import`.
fn collect_pending_return_import<'s>(
    owning_path: &'s str,
    pending_return: &'s Option<Vec<DeferredReturnShape>>,
    out: &mut HashSet<(&'s str, &'s str, &'s str)>,
) {
    fn walk<'s>(
        owning_path: &'s str,
        shape: &'s DeferredReturnShape,
        out: &mut HashSet<(&'s str, &'s str, &'s str)>,
    ) {
        match shape {
            DeferredReturnShape::CallEntity(ReturnEntityRef::Imported {
                specifier,
                imported_name: Some(imported_name),
            }) => {
                out.insert((owning_path, specifier.as_str(), imported_name.as_str()));
            }
            DeferredReturnShape::AwaitOf(inner) => walk(owning_path, inner, out),
            _ => {}
        }
    }
    let Some(shapes) = pending_return else {
        return;
    };
    for shape in shapes {
        walk(owning_path, shape, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A scratch dir under this crate's own `target/`, never `/tmp` (same
    /// isolation rule `tests_e2e.rs`'s own `scratch_dir` documents) --
    /// duplicated here (not shared with that file) since unit tests inside
    /// `src/` cannot depend on an integration test file's private helper.
    fn scratch_dir(label: &str) -> std::path::PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("typeflow-unit-tests")
            .join(format!("{label}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("scratch dir creation succeeds");
        dir
    }

    fn owner(path: &str, blob: &std::path::Path, text: &str) -> SourceInput {
        std::fs::write(blob, text).unwrap();
        let digest_bytes = {
            use sha2::{Digest, Sha256};
            Sha256::digest(text.as_bytes())
        };
        let mut digest = String::from("sha256:");
        for byte in digest_bytes {
            digest.push_str(&format!("{byte:02x}"));
        }
        SourceInput {
            path: path.to_string(),
            artifact_id: format!("artifact:{path}"),
            artifact_version_id: format!("version:{path}:1"),
            content_digest: digest,
            source_blob_path: blob.to_string_lossy().into_owned(),
            byte_length: text.len(),
        }
    }

    #[test]
    fn replace_file_then_remove_drops_the_summary() {
        let mut cache = TypeflowCache::default();
        cache.replace_file("a.ts", "export class Foo { bar(): number { return 1; } }");
        assert_eq!(cache.summary_count(), 1);
        cache.remove("a.ts");
        assert_eq!(cache.summary_count(), 0);
    }

    #[test]
    fn build_full_reads_every_owner_and_build_index_is_deterministic_across_two_independent_caches()
    {
        let dir = scratch_dir("typeflow-cache");
        let a_blob = dir.join("a.blob");
        let b_blob = dir.join("b.blob");
        let text_a = "import { Base } from './b'; export class Foo extends Base {}";
        let text_b = "export class Base {}";

        let mut cache_a = TypeflowCache::build_full(
            &[
                owner("a.ts", &a_blob, text_a),
                owner("b.ts", &b_blob, text_b),
            ],
            None,
        )
        .expect("build_full succeeds");
        let mut cache_b = TypeflowCache::build_full(
            &[
                owner("a.ts", &a_blob, text_a),
                owner("b.ts", &b_blob, text_b),
            ],
            None,
        )
        .expect("build_full succeeds");
        assert_eq!(cache_a.summary_count(), 2);
        assert_eq!(cache_b.summary_count(), 2);

        let resolver = WorkspaceResolver::build(&[]);
        let available: BTreeSet<String> = ["a.ts".to_string(), "b.ts".to_string()]
            .into_iter()
            .collect();
        let files: BTreeMap<String, SyntaxFileResult> = BTreeMap::new();

        // Snapshot the entity ids to probe BEFORE calling `build_index` on
        // either cache -- the returned `&ProgramIndex` ties up its own
        // `TypeflowCache` for as long as it is alive, so `cache_a.summaries`
        // cannot be read again once `index_a` exists.
        let probe_entities: Vec<String> = cache_a
            .summaries
            .values()
            .flat_map(|summary| summary.classes.iter().map(|class| class.entity_id.clone()))
            .collect();

        let index_a = cache_a.build_index(&resolver, &available, &files);
        let results_a: Vec<bool> = probe_entities
            .iter()
            .map(|id| index_a.is_container(id))
            .collect();

        let index_b = cache_b.build_index(&resolver, &available, &files);
        let results_b: Vec<bool> = probe_entities
            .iter()
            .map(|id| index_b.is_container(id))
            .collect();

        // Determinism: two builds from two INDEPENDENT caches over
        // identical inputs must be indistinguishable in every observable
        // way this crate exposes.
        assert_eq!(results_a, results_b);
    }

    /// P3-8a: `TypeflowCache::build_index`'s WARM (incremental) path,
    /// exercised through the real wiring (not `ProgramIndex`'s own raw
    /// API, already covered exhaustively by `urdira_jsts_typeflow`'s own
    /// crate-level randomized test) -- edits `b.ts` in a way that shifts
    /// `Base`'s own `start`-keyed entity id, and confirms the incrementally
    /// updated index matches a from-scratch `TypeflowCache` built directly
    /// over the SAME final state, both for `a.ts`'s heritage edge (`Foo
    /// extends Base`) and its member lookup through that edge.
    #[test]
    fn build_index_incremental_matches_a_fresh_cache_after_an_edit() {
        let dir = scratch_dir("typeflow-cache-incremental");
        let a_blob = dir.join("a.blob");
        let b_blob = dir.join("b.blob");
        let text_a = "import { Base } from './b'; export class Foo extends Base { greet(): number { return 1; } }";
        let text_b_v1 = "export class Base {}";
        let text_b_v2 = "\n\nexport class Base {}";

        let mut cache = TypeflowCache::build_full(
            &[
                owner("a.ts", &a_blob, text_a),
                owner("b.ts", &b_blob, text_b_v1),
            ],
            None,
        )
        .expect("build_full succeeds");

        let resolver = WorkspaceResolver::build(&[]);
        let available: BTreeSet<String> = ["a.ts".to_string(), "b.ts".to_string()]
            .into_iter()
            .collect();
        let files: BTreeMap<String, SyntaxFileResult> = BTreeMap::new();

        // Cold build, then an incremental edit to `b.ts` -- exercises the
        // WARM path (`a.ts` is `b.ts`'s importer, discovered and reflowed
        // via `ProgramIndex::importers_of`/`replace_file` internally).
        let _ = cache.build_index(&resolver, &available, &files);
        cache.replace_file("b.ts", text_b_v2);
        let foo_id = cache.summaries["a.ts"].classes[0].entity_id.clone();
        let incremental_index = cache.build_index(&resolver, &available, &files);
        let incremental_greet = incremental_index.members(&foo_id, "greet", false);

        let mut fresh = TypeflowCache::build_full(
            &[
                owner("a.ts", &a_blob, text_a),
                owner("b.ts", &b_blob, text_b_v2),
            ],
            None,
        )
        .expect("build_full succeeds");
        let fresh_index = fresh.build_index(&resolver, &available, &files);
        let fresh_greet = fresh_index.members(&foo_id, "greet", false);

        assert_eq!(incremental_greet, fresh_greet);
        assert!(
            matches!(
                incremental_greet,
                urdira_jsts_typeflow::MemberLookup::One(_)
            ),
            "Foo.greet must resolve through the (re-pointed) extends chain, not silently drop it: {incremental_greet:?}"
        );
    }

    /// D.2b (2026-09-05, references-parity task) regression fixture:
    /// `export type Memory = Base` where `Base` is IMPORTED from another
    /// file. Before this fix, `collect_needed_imports_for_summary` never
    /// scanned `DeclSummary::type_aliases`, so `import_targets` never got
    /// the `(alias.ts, "./iface", "Base")` triple `urdira_jsts_typeflow`'s
    /// own `build_alias_targets` needs to de-alias `Memory` -- `Opts.
    /// memory`'s own member type (used via `const { memory } = opts` at
    /// the syntax-worker layer, out of this crate's own scope to exercise
    /// directly) stayed unresolved forever regardless of D.2's de-aliasing
    /// logic in `urdira-jsts-typeflow` being otherwise correct. Reduced to
    /// 3 files from the real n8n sample that found this live
    /// (`ObservationLogReflectorMemory = BuiltObservationLogStore`,
    /// `packages/@n8n/agents/src/runtime/observation-log-reflector.ts`).
    #[test]
    fn imported_type_alias_target_is_reachable_through_the_needed_imports_scan() {
        let dir = scratch_dir("typeflow-alias-import-closure");
        let iface_blob = dir.join("iface.blob");
        let alias_blob = dir.join("alias.blob");
        let user_blob = dir.join("user.blob");
        let text_iface = "export interface Base {\n  getActive(): number;\n}\n";
        let text_alias = "import { Base } from './iface';\nexport type Memory = Base;\nexport interface Opts {\n  memory: Memory;\n}\n";
        let text_user = "import { Opts } from './alias';\nexport function use(opts: Opts) {\n  const { memory } = opts;\n  return memory.getActive();\n}\n";

        let sources = vec![
            owner("iface.ts", &iface_blob, text_iface),
            owner("alias.ts", &alias_blob, text_alias),
            owner("user.ts", &user_blob, text_user),
        ];

        // `resolve_import_targets_for` needs REAL `export_bindings` (built
        // by the real `SyntaxWorkerState::analyze`, the same production
        // entry `v4/analyze.rs::run_scoped` calls) to close `Memory`'s own
        // `import { Base } from './iface'` chain -- `TypeflowCache` alone
        // (`DeclSummary`-only) never builds `export_bindings` itself, and
        // an EMPTY `files` map (every other test in this module uses one,
        // since none of them assert a cross-file import actually closing)
        // would make `resolve_named_export` fail regardless of this fix.
        let mut syntax_state = urdira_jsts_syntax_worker::SyntaxWorkerState::default();
        let project_key = "typeflow-alias-import-closure".to_owned();
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        syntax_state
            .analyze(
                "test:analyze".to_owned(),
                "test:analyze".to_owned(),
                project_key.clone(),
                "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                    .to_owned(),
                vec![
                    "iface.ts".to_owned(),
                    "alias.ts".to_owned(),
                    "user.ts".to_owned(),
                ],
                sources.clone(),
                Vec::new(),
                urdira_worker_protocol::AuthoritativeChangeSet::Full,
                urdira_jsts_syntax_worker::AnalysisBudgets {
                    max_output_bytes: 64 * 1024 * 1024,
                    max_files: 16,
                    max_source_bytes: u32::MAX,
                    enforce_output_bytes: false,
                },
                &cancelled,
            )
            .expect("syntax analyze succeeds");
        let files = syntax_state
            .project_files(&project_key)
            .expect("project files present")
            .clone();

        let mut cache = TypeflowCache::build_full(&sources, None).expect("build_full succeeds");
        assert_eq!(cache.summary_count(), 3);

        let base_id = cache.summaries["iface.ts"].interfaces[0].entity_id.clone();
        let opts_id = cache.summaries["alias.ts"].interfaces[0].entity_id.clone();

        let resolver = WorkspaceResolver::build(&[]);
        let available: BTreeSet<String> = files.keys().cloned().collect();
        let index = cache.build_index(&resolver, &available, &files);
        assert_eq!(
            index.member_type_ref(&opts_id, "memory", false),
            Some(urdira_jsts_typeflow::ResolvedTypeRef::Entity(base_id)),
            "Opts.memory (aliased to an IMPORTED Base) must resolve through the needed-imports scan"
        );
    }

    /// Frente E-P0c adversarial review (2026-09-07), item 6: `docs/evidence/
    /// 2026-09-06-v4-reconcile-threshold.md` §11.4's own permanent
    /// diagnostic (`v4::tests_e2e::graph_identity_set_matches_between_two_
    /// kept_stores`) needs two externally prepared `--keep-data` structural
    /// roots from a real n8n git-switch -- not a self-contained, CI-runnable
    /// repro. This is a SYNTHETIC, fixture-scale attempt to build one
    /// directly at the `TypeflowCache`/`ProgramIndex` level, matching the
    /// shape §11.4 names for its remaining, NOT-fixed-here root cause: a
    /// CONSTRUCTOR PARAMETER PROPERTY (`constructor(private readonly
    /// config: Config)`) reading a member declared on a class imported from
    /// a DIFFERENT, MUTUALLY-referencing file, where BOTH the declaring
    /// file (`config.ts`) and the using file (`provider.ts`) are edited in
    /// the SAME `upserted` batch, inserted in REVERSED-alphabetical order
    /// (`provider.ts` before `config.ts`) -- the exact "both declaring and
    /// using file edited together" precondition §11.4 documents for the 3
    /// relations it could not close, plus this file's own bidirectional
    /// import (§11.4's "mutually-referencing pair" phrasing for its own
    /// `link_importer` suspicion).
    ///
    /// **NOT `#[ignore]`, does NOT fail**: this is a documented NEGATIVE
    /// research result, not the requested failing repro. Two independent
    /// attempts at this reduced fixture scale (a plain one-directional
    /// import first, then this mutual-import variant) both resolve
    /// `Provider.config`'s type CORRECTLY and IDENTICALLY regardless of
    /// `upserted` insertion order -- §11.4's own gap does NOT reproduce at
    /// this scale/shape. This RULES OUT "a single mutually-referencing pair
    /// with a one-hop parameter-property read" as §11.4's minimal repro; it
    /// does not rule out the bug (already confirmed live at real n8n scale,
    /// §11.4's own `--keep-data` evidence) -- the gap needs either real
    /// corpus scale/depth (more than 2 files, a longer reflow chain) or a
    /// mechanism this reduced case does not exercise (candidates §11.4
    /// itself already lists: `WorkspaceResolver` tsconfig-paths-alias
    /// proximity, or a `ProgramIndex::reflow_files` bookkeeping edge case
    /// that only surfaces with more simultaneously-touched files). Kept
    /// here as (a) a genuine regression test for the SETTLING LOOP's own
    /// order-independence (item 5 of this review) and (b) a documented
    /// negative result so whoever picks up E-P0d does not re-spend time on
    /// this exact reduced hypothesis -- start from §11.4's own real
    /// `--keep-data` repro instead.
    #[test]
    fn typeflow_settling_loop_resolves_mutual_parameter_property_reference_regardless_of_upsert_order()
     {
        let dir = scratch_dir("typeflow-param-property-cross-file-gap");
        let config_blob_v1 = dir.join("config-v1.blob");
        let provider_blob_v1 = dir.join("provider-v1.blob");
        let config_blob_v2 = dir.join("config-v2.blob");
        let provider_blob_v2 = dir.join("provider-v2.blob");

        // `config.ts` and `provider.ts` MUTUALLY reference each other
        // (config.ts imports a marker interface FROM provider.ts too) --
        // a genuine two-way edge, not just a one-directional import --
        // matching §11.4's own "mutually-referencing pair" phrasing for
        // its suspected `ProgramIndex::replace_file`/`reflow_files`/
        // `link_importer` root cause, one step past this file's own
        // simpler (ruled-out-here) one-directional attempt.
        let text_config_v1 = "import type { ProviderHint } from './provider';\nexport class Config {\n  observabilityEnabled: boolean = false;\n  hint?: ProviderHint;\n}\n";
        let text_provider_v1 = "import { Config } from './config';\nexport interface ProviderHint {\n  label: string;\n}\nexport class Provider {\n  constructor(private readonly config: Config) {}\n}\n";
        // Both files are edited TOGETHER in the same batch: `config.ts`
        // (the DECLARING file) gains a new member; `provider.ts` (the
        // USING file, accessing the parameter property's type) gains a
        // method that reads it -- same shape as §11.4's own
        // `expression-engine.config.ts`/`expression-observability.
        // provider.ts` pair (there: `observabilityEnabled`/`tracesEnabled`
        // properties read through a constructor parameter property, both
        // files genuinely edited in the same real git-switch batch).
        let text_config_v2 = "import type { ProviderHint } from './provider';\nexport class Config {\n  observabilityEnabled: boolean = false;\n  tracesEnabled: boolean = false;\n  hint?: ProviderHint;\n}\n";
        let text_provider_v2 = "import { Config } from './config';\nexport interface ProviderHint {\n  label: string;\n}\nexport class Provider {\n  constructor(private readonly config: Config) {}\n  startSpan(): boolean {\n    return this.config.tracesEnabled;\n  }\n}\n";

        // Cold generation: build the real syntax-worker `files` map (needed
        // by `resolve_named_export`) plus a `TypeflowCache` over the v1
        // texts, exactly like `imported_type_alias_target_is_reachable_
        // through_the_needed_imports_scan` above.
        let mut syntax_state = urdira_jsts_syntax_worker::SyntaxWorkerState::default();
        let project_key = "typeflow-param-property-cross-file-gap".to_owned();
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        let sources_v1 = vec![
            owner("config.ts", &config_blob_v1, text_config_v1),
            owner("provider.ts", &provider_blob_v1, text_provider_v1),
        ];
        syntax_state
            .analyze(
                "test:analyze:cold".to_owned(),
                "test:analyze:cold".to_owned(),
                project_key.clone(),
                "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                    .to_owned(),
                vec!["config.ts".to_owned(), "provider.ts".to_owned()],
                sources_v1.clone(),
                Vec::new(),
                urdira_worker_protocol::AuthoritativeChangeSet::Full,
                urdira_jsts_syntax_worker::AnalysisBudgets {
                    max_output_bytes: 64 * 1024 * 1024,
                    max_files: 16,
                    max_source_bytes: u32::MAX,
                    enforce_output_bytes: false,
                },
                &cancelled,
            )
            .expect("cold syntax analyze succeeds");

        let mut cache = TypeflowCache::build_full(&sources_v1, None).expect("build_full succeeds");
        assert_eq!(cache.summary_count(), 2);

        // Second generation: BOTH files re-analyzed together (mirrors a
        // real `Changed` batch touching both paths), giving the fresh
        // `files` map `resolve_named_export` needs for generation 2.
        let sources_v2 = vec![
            owner("config.ts", &config_blob_v2, text_config_v2),
            owner("provider.ts", &provider_blob_v2, text_provider_v2),
        ];
        syntax_state
            .analyze(
                "test:analyze:gen2".to_owned(),
                "test:analyze:gen2".to_owned(),
                project_key.clone(),
                "sha256:1111111111111111111111111111111111111111111111111111111111111111"
                    .to_owned(),
                vec!["config.ts".to_owned(), "provider.ts".to_owned()],
                sources_v2.clone(),
                Vec::new(),
                urdira_worker_protocol::AuthoritativeChangeSet::Full,
                urdira_jsts_syntax_worker::AnalysisBudgets {
                    max_output_bytes: 64 * 1024 * 1024,
                    max_files: 16,
                    max_source_bytes: u32::MAX,
                    enforce_output_bytes: false,
                },
                &cancelled,
            )
            .expect("gen2 syntax analyze succeeds");
        let files_v2 = syntax_state
            .project_files(&project_key)
            .expect("project files present")
            .clone();

        // WARM path: both `config.ts` and `provider.ts` land in the SAME
        // `upserted` batch (insertion order deliberately reversed from
        // alphabetical -- `provider.ts` first, `config.ts` second -- to
        // probe order-sensitivity; `pending_upserted` is itself a
        // `BTreeSet`, so this should have no effect on the outcome BY
        // CONSTRUCTION if the settling loop is doing its job).
        cache.replace_file("provider.ts", text_provider_v2);
        cache.replace_file("config.ts", text_config_v2);

        let resolver = WorkspaceResolver::build(&[]);
        let available: BTreeSet<String> = files_v2.keys().cloned().collect();
        let provider_id = cache.summaries["provider.ts"].classes[0].entity_id.clone();
        let config_id = cache.summaries["config.ts"].classes[0].entity_id.clone();
        let incremental_index = cache.build_index(&resolver, &available, &files_v2);
        let incremental_config_type =
            incremental_index.member_type_ref(&provider_id, "config", false);

        // Independent oracle: a FRESH `TypeflowCache` built directly from
        // the FINAL (v2) texts -- never touched by the settling loop at
        // all (`build_full` runs `ProgramIndex::build`'s own from-scratch
        // four-pass closure, not the incremental `replace_file` path this
        // test is probing).
        let mut oracle_syntax_state = urdira_jsts_syntax_worker::SyntaxWorkerState::default();
        let oracle_project_key = "typeflow-param-property-cross-file-gap-oracle".to_owned();
        oracle_syntax_state
            .analyze(
                "test:analyze:oracle".to_owned(),
                "test:analyze:oracle".to_owned(),
                oracle_project_key.clone(),
                "sha256:2222222222222222222222222222222222222222222222222222222222222222"
                    .to_owned(),
                vec!["config.ts".to_owned(), "provider.ts".to_owned()],
                sources_v2.clone(),
                Vec::new(),
                urdira_worker_protocol::AuthoritativeChangeSet::Full,
                urdira_jsts_syntax_worker::AnalysisBudgets {
                    max_output_bytes: 64 * 1024 * 1024,
                    max_files: 16,
                    max_source_bytes: u32::MAX,
                    enforce_output_bytes: false,
                },
                &cancelled,
            )
            .expect("oracle syntax analyze succeeds");
        let oracle_files = oracle_syntax_state
            .project_files(&oracle_project_key)
            .expect("oracle project files present")
            .clone();
        let mut oracle_cache =
            TypeflowCache::build_full(&sources_v2, None).expect("oracle build_full succeeds");
        let oracle_available: BTreeSet<String> = oracle_files.keys().cloned().collect();
        let oracle_index = oracle_cache.build_index(&resolver, &oracle_available, &oracle_files);
        let oracle_config_type = oracle_index.member_type_ref(&provider_id, "config", false);

        assert_eq!(
            oracle_config_type,
            Some(urdira_jsts_typeflow::ResolvedTypeRef::Entity(config_id)),
            "sanity: the independent from-scratch oracle must resolve Provider's own \
             constructor-parameter-property `config` to the freshly-edited Config class"
        );
        assert_eq!(
            incremental_config_type, oracle_config_type,
            "the incrementally settled index (two mutually-referencing files edited in the SAME \
             batch, `provider.ts` inserted into `upserted` BEFORE `config.ts`) must resolve \
             Provider.config to the SAME entity an independent from-scratch oracle does over the \
             identical final texts -- if this ever fails, it is EITHER a settling-loop \
             regression (item 5) or a minimal repro for §11.4's still-open gap (item 6); it \
             passes today at this reduced fixture scale (see this test's own doc comment)"
        );
    }
}
