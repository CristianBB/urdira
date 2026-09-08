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
    /// Frente E-P0g: the reverse half of `chain_watch_targets` (`resolve_
    /// import_targets_for`'s own doc comment) -- `target_path -> owning
    /// paths whose needed-import resolution used target_path as a
    /// successfully-resolved re-export HOP` (never the genuinely-failing
    /// case, which stays on `ProgramIndex`'s own `pending_importers_of`).
    /// Kept HERE, not on `ProgramIndex` (`urdira-jsts-typeflow`), so a
    /// resolved-through-a-barrel edge can never be confused with that
    /// crate's own "still failing" contract (see `apply_chain_watch_
    /// updates`'s doc comment for the test this separation protects).
    chain_watchers: HashMap<String, HashSet<String>>,
    /// The forward half of `chain_watchers`: `owning_path -> target paths
    /// it currently watches` -- needed to correctly CLEAR an owning path's
    /// old watch edges before installing its fresh set (mirrors `urdira-
    /// jsts-typeflow::ProgramIndex::file_import_keys`'s own role for
    /// `import_targets`/`importers_of`).
    owning_chain_targets: HashMap<String, HashSet<String>>,
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
            let (import_targets, pending_targets, chain_watch_targets) = resolve_import_targets_for(
                &self.summaries,
                all_paths.into_iter(),
                resolver,
                available,
                files,
            );
            self.index = Some(ProgramIndex::build(
                &self.summaries,
                &import_targets,
                &pending_targets,
            ));
            apply_chain_watch_updates(
                &mut self.chain_watchers,
                &mut self.owning_chain_targets,
                &chain_watch_targets,
            );
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
            // Frente E-P0g: capture each REMOVED path's own `importers_of`/
            // `pending_importers_of` watchers BEFORE `remove_file` purges
            // those reverse-index entries (`purge_import_targets_targeting_
            // file`/`self.pending_importers_of.remove(path)`, both inside
            // `remove_file` itself) -- these are exactly the files whose
            // OWN needed-import resolution used `path` either as a
            // successfully-resolved re-export HOP (see `resolve_import_
            // targets_for`'s `directly_declares` branch above) or as a
            // still-pending target. `remove_file`'s own internal `reflow_
            // files` only replays each affected file's EXISTING (now
            // possibly stale) `import_targets` entries through the local
            // 4-pass closure -- it never calls back into `resolver`/
            // `available`/`files` to re-derive whether a specifier still
            // resolves at all, since those three only exist at THIS
            // caller's layer. Without re-resolving these watchers here,
            // removing a barrel file left every real consumer's `import_
            // targets` entry pointing at its (still valid, untouched)
            // flattened target -- byte-identical to before the removal --
            // confirmed live on n8n (§15.4/§16, `dynamic-credentials.
            // controller.ts` kept a stale method-call resolution through a
            // renamed `services/index.ts` barrel). Folded into the SAME
            // settling loop `upserted` already runs through below (as
            // `refresh_seed`) so a chain of removed-barrel -> importer ->
            // that importer's OWN importers converges the identical way
            // `upserted`'s own multi-hop case already does.
            let mut removed_watchers: BTreeSet<String> = BTreeSet::new();
            for path in &removed {
                removed_watchers.extend(index.importers_of(path));
                removed_watchers.extend(index.pending_importers_of(path));
                // Frente E-P0g: `chain_watchers`/`owning_chain_targets` are
                // this module's OWN reverse index, entirely separate from
                // `index`'s (`ProgramIndex`'s) own two above -- see
                // `resolve_import_targets_for`'s doc comment for why a
                // resolved-through-a-barrel edge lives here instead.
                removed_watchers.extend(remove_chain_watch_path(
                    &mut self.chain_watchers,
                    &mut self.owning_chain_targets,
                    path,
                ));
            }
            for path in &removed {
                index.remove_file(path);
            }
            removed_watchers.retain(|path| !removed.contains(path));
            let refresh_seed: BTreeSet<String> =
                upserted.iter().cloned().chain(removed_watchers).collect();
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
            //
            // E-P0d (2026-09-07): `refresh_paths` ALSO widens through
            // `index.pending_importers_of(path)` (not just `importers_of`)
            // -- root-caused live on real n8n: a THIRD file's re-export edit
            // (a package barrel, `packages/@n8n/config/src/index.ts`)
            // lands in a LATER, SEPARATE `build_index` call than the two
            // brand-new files it mediates between (`crates/urdira-indexing-
            // worker/src/v4/delta.rs`'s own structural/content generation
            // split for a mixed batch -- see `delta.rs::run`'s own doc
            // comment). The consuming file's FIRST attempt to resolve
            // through the barrel fails (the barrel's stale, pre-edit
            // exports, still cached in `files`/`project_files` for THAT
            // call), and since `link_importer` only ever runs for a
            // SUCCESSFUL resolution, `importers_of(barrel)` never learns
            // about it -- `pending_importers_of` is `ProgramIndex`'s OWN
            // reverse index for exactly this "tried, target file found,
            // export not (yet)" case (see that field's own doc comment in
            // `urdira-jsts-typeflow`), and it persists on `self.index`
            // across SEPARATE `build_index` calls the same way `importers_
            // of` does, so the barrel's own LATER `replace_file` call (in
            // the content generation) correctly re-attempts the consumer
            // against the barrel's now-current exports.
            const MAX_SETTLING_ROUNDS: usize = 8;
            let mut previous_round: Option<HashMap<(String, String, String), String>> = None;
            let mut previous_round_pending: Option<HashMap<String, HashSet<String>>> = None;
            let mut previous_round_chain: Option<HashMap<String, HashSet<String>>> = None;
            for round in 0..MAX_SETTLING_ROUNDS {
                let mut round_updates: HashMap<(String, String, String), String> = HashMap::new();
                let mut round_pending: HashMap<String, HashSet<String>> = HashMap::new();
                let mut round_chain: HashMap<String, HashSet<String>> = HashMap::new();
                for path in &refresh_seed {
                    let Some(summary) = self.summaries.get(path) else {
                        // Upserted then removed again before this
                        // `build_index` call ever ran (both edits landed
                        // in the SAME generation's dirty set), OR a
                        // removed-path watcher that turns out to ALSO be
                        // one of `removed` itself (already filtered out
                        // above, kept here only as a defensive belt) --
                        // nothing left to insert either way.
                        continue;
                    };
                    let mut refresh_paths: BTreeSet<String> =
                        index.importers_of(path).into_iter().collect();
                    refresh_paths.extend(index.pending_importers_of(path));
                    // Frente E-P0g: also widen through THIS module's own
                    // `chain_watchers` -- a path reflowed this round (say,
                    // the barrel itself, edited in the SAME batch as one of
                    // its own re-exported declarations) may be a watched
                    // HOP for some owning path `ProgramIndex`'s two reverse
                    // indexes have no edge for (see `resolve_import_
                    // targets_for`'s doc comment).
                    refresh_paths
                        .extend(self.chain_watchers.get(path).into_iter().flatten().cloned());
                    refresh_paths.insert(path.clone());
                    let (updates, pending, chain) = resolve_import_targets_for(
                        &self.summaries,
                        refresh_paths.iter().map(String::as_str),
                        resolver,
                        available,
                        files,
                    );
                    round_updates.extend(updates.iter().map(|(k, v)| (k.clone(), v.clone())));
                    for (owning_path, target_paths) in &pending {
                        round_pending
                            .entry(owning_path.clone())
                            .or_default()
                            .extend(target_paths.iter().cloned());
                    }
                    for (owning_path, target_paths) in &chain {
                        round_chain
                            .entry(owning_path.clone())
                            .or_default()
                            .extend(target_paths.iter().cloned());
                    }
                    index.replace_file(path, summary.clone(), &updates, &pending);
                    apply_chain_watch_updates(
                        &mut self.chain_watchers,
                        &mut self.owning_chain_targets,
                        &chain,
                    );
                }
                let converged = previous_round.as_ref() == Some(&round_updates)
                    && previous_round_pending.as_ref() == Some(&round_pending)
                    && previous_round_chain.as_ref() == Some(&round_chain);
                previous_round = Some(round_updates);
                previous_round_pending = Some(round_pending);
                previous_round_chain = Some(round_chain);
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
///
/// E-P0d: also returns a `pending_targets` map (`owning_path -> target file
/// paths it still cannot fully resolve`), the exact input `ProgramIndex::
/// build`/`replace_file`/`add_file` now take for `pending_importers_of`
/// (see that field's own doc comment in `urdira-jsts-typeflow`) -- a triple
/// whose specifier resolves to a KNOWN file (`resolver.resolve` succeeds)
/// but whose named export does not (`resolve_named_export` returns
/// anything other than `Resolved`) is recorded there, distinct from a
/// specifier that never resolves to any file at all (never recorded --
/// there is no file whose future edit could ever fix that one). Every path
/// in `paths` gets an entry in the returned map (possibly an empty set),
/// never only the ones with an actual pending edge, so a caller applying
/// this as a full snapshot (`apply_pending_target_updates`'s own "never a
/// partial patch" contract) correctly clears a path's stale pending edges
/// once it stops needing them.
///
/// Frente E-P0g: ALSO returns `chain_watch_targets` (same `owning_path ->
/// target file paths` shape, same "one entry per queried path, even if
/// empty" contract as `pending_targets`) -- deliberately a THIRD, SEPARATE
/// map, not folded into `pending_targets`: a triple that resolves cleanly
/// THROUGH a re-exporting barrel is genuinely resolved (`import_targets`
/// gets its normal entry, `pending_importers_of`'s own "still failing"
/// contract must NOT gain an entry for it -- `urdira-jsts-typeflow`'s own
/// `member_access_through_a_reexporting_barrel_edited_in_a_later_separate_
/// build_index_call` test asserts exactly that "now-resolved need must stop
/// being retried" invariant, confirmed live when an earlier draft of this
/// fix folded this into `pending_targets` instead and broke it) -- but the
/// specifier's own DIRECT resolution target (the barrel `target_path`,
/// before `resolve_named_export`'s own further chasing) still needs to be
/// watched STRUCTURALLY: `import_targets`' VALUE only ever stores the
/// flattened final entity id, so `ProgramIndex::link_importer` (keyed by
/// `entity_owner[target_id]`) only ever registers `owning_path` as an
/// importer of the FINAL declaring file, never of the barrel hop it went
/// through -- removing/renaming/editing ONLY the barrel (the declaring file
/// itself untouched) left nothing pointing back at `owning_path` to reflow.
/// Confirmed live on n8n at N=2015 (`docs/evidence/2026-09-06-v4-reconcile-
/// threshold.md` §15.4/§16): `dynamic-credentials.controller.ts` kept a
/// stale `jsts:call`/`jsts:references` row targeting a service method
/// through the renamed `services/index.ts` barrel, which a from-scratch
/// oracle scan of the renamed tree never re-derived. `TypeflowCache` (this
/// module) keeps this as its OWN reverse index (`chain_watchers`/
/// `owning_chain_targets`, below), entirely separate from `ProgramIndex`'s
/// own `pending_importers_of` -- see `apply_chain_watch_updates`'s doc
/// comment.
#[allow(clippy::type_complexity)]
fn resolve_import_targets_for<'a>(
    summaries: &BTreeMap<String, DeclSummary>,
    paths: impl Iterator<Item = &'a str>,
    resolver: &WorkspaceResolver,
    available: &BTreeSet<String>,
    files: &BTreeMap<String, SyntaxFileResult>,
) -> (
    HashMap<(String, String, String), String>,
    HashMap<String, HashSet<String>>,
    HashMap<String, HashSet<String>>,
) {
    let mut needed_imports: HashSet<(&str, &str, &str)> = HashSet::new();
    let mut pending_targets: HashMap<String, HashSet<String>> = HashMap::new();
    let mut chain_watch_targets: HashMap<String, HashSet<String>> = HashMap::new();
    for path in paths {
        pending_targets.entry(path.to_owned()).or_default();
        chain_watch_targets.entry(path.to_owned()).or_default();
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
        match resolve_named_export(
            files,
            &target_path,
            imported_name,
            urdira_jsts_syntax_worker::ExportPolicy::UniqueOrAmbiguous,
        ) {
            ExportResolution::Resolved(target_id) => {
                // Frente E-P0g review fix: a NESTED re-export chain
                // (`impl.ts` -> `pkgroot.ts` [re-exports] -> `barrel.ts`
                // [re-exports] -> `iface.ts` [declares]) has MULTIPLE
                // intermediate hops, not just `target_path` (the
                // specifier's own DIRECT resolution target, `pkgroot.ts`
                // here) -- `pkgroot.ts` itself has no needed-import of its
                // OWN (`collect_needed_imports_for_summary` only scans
                // classes/interfaces/functions, and a bare re-export
                // declaration is none of those), so nothing else in this
                // function's own loop ever visits `barrel.ts` as an
                // `owning_path` to watch it FROM. Confirmed live on n8n at
                // N=5037 (`docs/evidence/2026-09-06-v4-reconcile-
                // threshold.md` §16): renaming the NESTED barrel `@n8n/
                // instance-ai/src/event-bus/index.ts` (two hops beyond the
                // package-root barrel `in-process-event-bus.ts` imports
                // through) left a transitive caller's property reference
                // stale, even after this function's own single-hop `target_
                // path` watch (below) was already in place -- reproduced at
                // fixture scale
                // (`nested_barrel_rename_in_a_mixed_batch_closes_a_
                // transitive_property_reference`, `tests_e2e.rs`).
                // `collect_reexport_chain_paths` walks the SAME re-export/
                // star-export rules `resolve_named_export` itself follows
                // (a safe OVER-approximation: it also returns the terminal
                // declaring file, redundant with -- never in conflict
                // with -- `entity_owner`'s own tracking of that file, and
                // bounded by the same cycle/depth guard that function
                // uses), watching EVERY hop, not just the first.
                for hop in collect_reexport_chain_paths(files, &target_path, imported_name) {
                    if !directly_declares(files, &hop, imported_name) {
                        chain_watch_targets
                            .entry(owning_path.to_owned())
                            .or_default()
                            .insert(hop);
                    }
                }
                import_targets.insert(key, target_id);
            }
            ExportResolution::Namespace(_)
            | ExportResolution::Ambiguous
            | ExportResolution::Unresolved => {
                pending_targets
                    .entry(owning_path.to_owned())
                    .or_default()
                    .insert(target_path);
            }
        }
    }
    (import_targets, pending_targets, chain_watch_targets)
}

/// Frente E-P0g: `true` when `path`'s OWN `export_bindings` directly (not
/// through a further re-export -- `source_specifier.is_none()`) exports
/// `name` -- i.e., `path` is where `name` is actually DECLARED, not merely
/// a re-exporting hop on the way there. See `resolve_import_targets_for`'s
/// `ExportResolution::Resolved` arm for why this distinction is what decides
/// whether an extra `pending_importers_of` watch edge is needed.
fn directly_declares(files: &BTreeMap<String, SyntaxFileResult>, path: &str, name: &str) -> bool {
    files.get(path).is_some_and(|file| {
        file.export_bindings
            .iter()
            .any(|binding| binding.exported_name == name && binding.source_specifier.is_none())
    })
}

/// Frente E-P0g review fix: every file `resolving `name` starting from
/// `start_path` would visit as a re-export HOP, following the SAME two
/// rules `urdira-jsts-syntax-worker::resolver::resolve_named_export_inner`
/// applies (named re-export first, bare `export * from` fallback only when
/// no named re-export for `name` exists in that file) -- a deliberately
/// SEPARATE, simpler walk from that function (it only needs to know WHICH
/// files were visited, never the resolved entity id, which `resolve_named_
/// export` already computed for the caller), used ONLY to decide which
/// files `resolve_import_targets_for` must register a `chain_watch_
/// targets` watch against. Includes `start_path` itself when it is NOT a
/// direct declarer (the caller's own `directly_declares` filter, applied
/// per returned path, drops anything that turns out to declare `name`
/// directly -- including the terminal file this walk's own base case
/// naturally reaches, a harmless redundant candidate with `entity_owner`'s
/// unrelated tracking of that same file, never a conflict). Cycle-guarded
/// and depth-capped exactly like `resolve_named_export_inner` (`visiting`/
/// `MAX_CHAIN_DEPTH`, the SAME bound `resolver::MAX_EXPORT_RESOLUTION_
/// DEPTH` uses) -- a safe OVER-approximation matters more here than an
/// exact match: missing a hop silently reintroduces this task's own root
/// cause, watching one hop too many only ever costs one extra, bounded
/// reflow attempt.
fn collect_reexport_chain_paths(
    files: &BTreeMap<String, SyntaxFileResult>,
    start_path: &str,
    name: &str,
) -> BTreeSet<String> {
    const MAX_CHAIN_DEPTH: u8 = 8;
    fn walk(
        files: &BTreeMap<String, SyntaxFileResult>,
        path: &str,
        name: &str,
        depth: u8,
        visiting: &mut BTreeSet<(String, String)>,
        out: &mut BTreeSet<String>,
    ) {
        if depth >= MAX_CHAIN_DEPTH || !visiting.insert((path.to_owned(), name.to_owned())) {
            return;
        }
        let Some(file) = files.get(path) else {
            return;
        };
        let matching: Vec<&urdira_jsts_syntax_worker::SyntaxExportBinding> = file
            .export_bindings
            .iter()
            .filter(|binding| binding.exported_name == name)
            .collect();
        if matching
            .iter()
            .any(|binding| binding.source_specifier.is_none())
        {
            // A direct declaration for `name` right here -- the chain ends
            // at `path` itself (already inserted by the caller before
            // recursing in), nothing further to walk.
            return;
        }
        let named_reexports: Vec<&urdira_jsts_syntax_worker::SyntaxExportBinding> = matching
            .into_iter()
            .filter(|binding| binding.source_specifier.is_some())
            .collect();
        if !named_reexports.is_empty() {
            for binding in named_reexports {
                if let Some(target) = &binding.source_target_path {
                    out.insert(target.clone());
                    walk(files, target, name, depth + 1, visiting, out);
                }
            }
            return;
        }
        for star in &file.export_star_specifiers {
            if let Some(target) = &star.target_path {
                out.insert(target.clone());
                walk(files, target, name, depth + 1, visiting, out);
            }
        }
    }
    let mut out = BTreeSet::new();
    out.insert(start_path.to_owned());
    let mut visiting = BTreeSet::new();
    walk(files, start_path, name, 0, &mut visiting, &mut out);
    out
}

/// Frente E-P0g: installs `updates` (`resolve_import_targets_for`'s own
/// `chain_watch_targets` return value -- `owning_path -> target file paths
/// it resolved THROUGH as a re-export hop`) into `TypeflowCache`'s own
/// `chain_watchers`/`owning_chain_targets` pair, replacing each `owning_
/// path` present in `updates`' keys entirely (never a partial patch --
/// mirrors `urdira-jsts-typeflow::ProgramIndex::apply_pending_target_
/// updates`'s own discipline for its sibling reverse index, and for the
/// identical reason: an owning path whose need stopped resolving through
/// ANY hop at all must have its old watch edges dropped, or `remove_chain_
/// watch_path`'s BFS below would keep sweeping in a target that no longer
/// matters). Deliberately a SEPARATE pair of maps from `ProgramIndex`'s own
/// `importers_of`/`pending_importers_of` -- see `resolve_import_targets_
/// for`'s doc comment for the test (`urdira-jsts-typeflow`'s `member_
/// access_through_a_reexporting_barrel_edited_in_a_later_separate_build_
/// index_call`) an earlier draft broke by folding this into `pending_
/// importers_of` instead.
fn apply_chain_watch_updates(
    chain_watchers: &mut HashMap<String, HashSet<String>>,
    owning_chain_targets: &mut HashMap<String, HashSet<String>>,
    updates: &HashMap<String, HashSet<String>>,
) {
    for owning_path in updates.keys() {
        if let Some(old_targets) = owning_chain_targets.remove(owning_path) {
            for target in old_targets {
                if let Some(set) = chain_watchers.get_mut(&target) {
                    set.remove(owning_path);
                    if set.is_empty() {
                        chain_watchers.remove(&target);
                    }
                }
            }
        }
    }
    for (owning_path, targets) in updates {
        if !targets.is_empty() {
            owning_chain_targets.insert(owning_path.clone(), targets.clone());
        }
        for target in targets {
            chain_watchers
                .entry(target.clone())
                .or_default()
                .insert(owning_path.clone());
        }
    }
}

/// Frente E-P0g: `path` is being removed (`TypeflowCache::build_index`'s
/// `removed` loop) -- drops it from BOTH halves of the chain-watch pair
/// (it can no longer be watched, since it no longer exists; nor can it
/// watch anything else) and returns every owning path that used to watch
/// IT as a target, so the caller can fold them into its own reflow set
/// exactly like `ProgramIndex::importers_of(path)`/`pending_importers_of
/// (path)` already are (mirrors `ProgramIndex::remove_file`'s own two-
/// sided cleanup, kept here since this reverse index lives on
/// `TypeflowCache`, not `ProgramIndex` -- see `resolve_import_targets_
/// for`'s doc comment).
fn remove_chain_watch_path(
    chain_watchers: &mut HashMap<String, HashSet<String>>,
    owning_chain_targets: &mut HashMap<String, HashSet<String>>,
    path: &str,
) -> Vec<String> {
    let watchers: Vec<String> = chain_watchers.remove(path).into_iter().flatten().collect();
    if let Some(old_targets) = owning_chain_targets.remove(path) {
        for target in old_targets {
            if let Some(set) = chain_watchers.get_mut(&target) {
                set.remove(path);
                if set.is_empty() {
                    chain_watchers.remove(&target);
                }
            }
        }
    }
    watchers
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
        // G (E-P0l, 2026-09-08): byte-identical addition to `main.rs`'s own
        // `collect_type_ref_import` -- see that copy's doc comment.
        RawTypeRef::TypeQuery(Some(ReturnEntityRef::Imported {
            specifier,
            imported_name: Some(imported_name),
        })) => {
            out.insert((owning_path, specifier.as_str(), imported_name.as_str()));
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

    /// Runs one `SyntaxWorkerState::analyze` generation over `sources` and
    /// returns its `project_files` map (cloned) for the given `project_key`
    /// -- shared by `member_access_through_a_constructor_parameter_property_
    /// survives_a_same_batch_multi_file_edit`'s cold and post-edit
    /// generations below, and by its independent from-scratch oracle.
    fn analyze_project_files(
        project_key: &str,
        paths: &[&str],
        sources: &[SourceInput],
    ) -> BTreeMap<String, SyntaxFileResult> {
        let mut syntax_state = urdira_jsts_syntax_worker::SyntaxWorkerState::default();
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        syntax_state
            .analyze(
                "test:analyze".to_owned(),
                "test:analyze".to_owned(),
                project_key.to_owned(),
                "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                    .to_owned(),
                paths.iter().map(|p| p.to_string()).collect(),
                sources.to_vec(),
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
        syntax_state
            .project_files(project_key)
            .expect("project files present")
            .clone()
    }

    /// E-P0d repro/regression: a constructor PARAMETER PROPERTY
    /// (`constructor(private readonly repo: Repo) {}`) whose declared type
    /// is IMPORTED from another file, read via `this.<prop>.<member>()`
    /// inside a method -- with BOTH the declaring file (`repo_path`, whose
    /// edit both shifts its class's own `start`-keyed entity id AND adds the
    /// new member being accessed) and the using file (`svc_path`, whose edit
    /// adds the new access) upserted in the very SAME `build_index` batch,
    /// exactly the shape `docs/evidence/2026-09-06-v4-reconcile-threshold.md`
    /// §11.4 root-caused live on real n8n (`expression-observability.
    /// provider.ts` / `expression-engine.config.ts`, both genuinely edited
    /// together in the same git-switch commit range). Parameterized over
    /// which of the two paths sorts first in `BTreeSet<String>` (path-
    /// alphabetical) order -- `TypeflowCache::build_index`'s warm settling
    /// loop iterates `pending_upserted` in THAT order, and §11.4 found the
    /// defect specifically in `ProgramIndex::replace_file`/`reflow_files`'s
    /// own handling of two back-to-back calls for a mutually-referencing
    /// pair, not in the settling loop's own round count -- so both
    /// processing orders are exercised as two separate `#[test]`s below,
    /// both against the identical oracle: an INDEPENDENT `TypeflowCache`
    /// built cold, directly from the two files' FINAL (post-edit) text.
    fn assert_member_access_through_parameter_property_survives_batch_edit(
        repo_path: &str,
        svc_path: &str,
    ) {
        let dir = scratch_dir("typeflow-param-property-batch-edit");
        let repo_blob = dir.join("repo.blob");
        let svc_blob = dir.join("svc.blob");

        let repo_v1 = "export class Repo {\n  find(): number {\n    return 1;\n  }\n}\n";
        // Shifts `Repo`'s own `start`-keyed entity id (two leading blank
        // lines) AND adds the NEW member (`count`) the batch edit's other
        // file starts reading -- exactly the "declaring file's edit moves
        // the target id AND grows its member set" shape §11.4 describes.
        let repo_v2 = "\n\nexport class Repo {\n  find(): number {\n    return 1;\n  }\n  count(): number {\n    return 2;\n  }\n}\n";
        let svc_v1 = format!(
            "import {{ Repo }} from './{repo_stem}';\nexport class Svc {{\n  constructor(private readonly repo: Repo) {{}}\n  run(): number {{\n    return this.repo.find();\n  }}\n}}\n",
            repo_stem = repo_path.trim_end_matches(".ts"),
        );
        // Same class declaration (Svc's own entity id stays put) -- only a
        // NEW method is added, reading the declaring file's NEW member
        // through the SAME pre-existing parameter property.
        let svc_v2 = format!(
            "import {{ Repo }} from './{repo_stem}';\nexport class Svc {{\n  constructor(private readonly repo: Repo) {{}}\n  run(): number {{\n    return this.repo.find();\n  }}\n  run2(): number {{\n    return this.repo.count();\n  }}\n}}\n",
            repo_stem = repo_path.trim_end_matches(".ts"),
        );

        let sources_v1 = vec![
            owner(repo_path, &repo_blob, repo_v1),
            owner(svc_path, &svc_blob, &svc_v1),
        ];
        let project_key = format!("typeflow-param-property-batch-edit-{repo_path}-{svc_path}");
        let files_v1 = analyze_project_files(&project_key, &[repo_path, svc_path], &sources_v1);

        let mut cache =
            TypeflowCache::build_full(&sources_v1, None).expect("build_full succeeds (v1)");
        let resolver = WorkspaceResolver::build(&[]);
        let available_v1: BTreeSet<String> = files_v1.keys().cloned().collect();
        let _ = cache.build_index(&resolver, &available_v1, &files_v1);

        // The batch edit: BOTH files upserted before the NEXT `build_index`
        // call -- `pending_upserted` (a `BTreeSet`) will iterate them in
        // path-alphabetical order regardless of the order these two
        // `replace_file` calls happen in, so this order is not what the
        // two `#[test]`s below vary (see their own doc comment: it's
        // `repo_path`/`svc_path`'s own alphabetical relationship that
        // matters).
        cache.replace_file(repo_path, repo_v2);
        cache.replace_file(svc_path, &svc_v2);

        let repo_id_v2 = cache.summaries[repo_path].classes[0].entity_id.clone();
        let svc_id = cache.summaries[svc_path].classes[0].entity_id.clone();

        let sources_v2 = vec![
            owner(repo_path, &repo_blob, repo_v2),
            owner(svc_path, &svc_blob, &svc_v2),
        ];
        let files_v2 = analyze_project_files(&project_key, &[repo_path, svc_path], &sources_v2);
        let available_v2: BTreeSet<String> = files_v2.keys().cloned().collect();

        let incremental_index = cache.build_index(&resolver, &available_v2, &files_v2);
        let incremental_repo_type = incremental_index.member_type_ref(&svc_id, "repo", false);
        let incremental_count = incremental_index.members(&repo_id_v2, "count", false);
        let incremental_find = incremental_index.members(&repo_id_v2, "find", false);

        // Oracle: an INDEPENDENT `TypeflowCache`, built cold directly from
        // the SAME final (v2) text -- never touched by the warm settling
        // loop at all.
        let mut fresh =
            TypeflowCache::build_full(&sources_v2, None).expect("build_full succeeds (fresh)");
        let fresh_index = fresh.build_index(&resolver, &available_v2, &files_v2);
        let fresh_repo_type = fresh_index.member_type_ref(&svc_id, "repo", false);
        let fresh_count = fresh_index.members(&repo_id_v2, "count", false);
        let fresh_find = fresh_index.members(&repo_id_v2, "find", false);

        assert_eq!(
            incremental_repo_type, fresh_repo_type,
            "Svc.repo's declared type (a constructor parameter property, imported \
             from the file edited in the SAME batch) must match a from-scratch \
             rebuild of the final tree"
        );
        assert_eq!(
            incremental_repo_type,
            Some(urdira_jsts_typeflow::ResolvedTypeRef::Entity(
                repo_id_v2.clone()
            )),
            "Svc.repo must resolve to Repo's NEW (post-edit, id-shifted) entity id, \
             not stay unresolved or point at the stale pre-edit id"
        );
        assert_eq!(
            incremental_count, fresh_count,
            "Repo.count (the NEW member the same-batch edit both adds and starts \
             reading through the parameter property) must match a from-scratch \
             rebuild"
        );
        assert!(
            matches!(
                incremental_count,
                urdira_jsts_typeflow::MemberLookup::One(_)
            ),
            "this.repo.count() must resolve through the parameter property's \
             declared type, exactly like a from-scratch rebuild would: {incremental_count:?}"
        );
        assert_eq!(
            incremental_find, fresh_find,
            "Repo.find (the PRE-EXISTING member, still read by the pre-existing \
             `run()` method) must also match a from-scratch rebuild"
        );
    }

    #[test]
    fn member_access_through_a_constructor_parameter_property_survives_a_same_batch_multi_file_edit_declarer_first()
     {
        // "repo.ts" < "svc.ts": the declaring file sorts FIRST in
        // `pending_upserted`'s `BTreeSet` iteration order.
        assert_member_access_through_parameter_property_survives_batch_edit("repo.ts", "svc.ts");
    }

    #[test]
    fn member_access_through_a_constructor_parameter_property_survives_a_same_batch_multi_file_edit_user_first()
     {
        // "a_svc.ts" < "z_repo.ts": the USING file sorts FIRST -- the
        // reverse order from the test above, matching real n8n's own
        // `packages/@n8n/config/...` (sorts before) / `packages/cli/...`
        // pairing being the OTHER way around from this crate's synthetic
        // "repo"/"svc" naming, so both relative orders get exercised across
        // the two tests.
        assert_member_access_through_parameter_property_survives_batch_edit(
            "z_repo.ts",
            "a_svc.ts",
        );
    }

    /// E-P0d ACTUAL root cause (found by reducing the real `tags-3-months`
    /// n8n git-switch repro, `docs/evidence/2026-09-06-v4-reconcile-
    /// threshold.md` §11.4/§12): both `expression-engine.config.ts` (the
    /// declaring file) AND `expression-observability.provider.ts` (the
    /// using file, reading `this.config.<member>` through a constructor
    /// parameter property) are `git diff`-confirmed BRAND NEW files (`new
    /// file mode 100644` on BOTH sides of the real diff) -- NOT pre-existing
    /// files merely edited together, the scenario the two tests above (and
    /// §11.4's own "84%-fixed" settling-loop round) actually cover. This is
    /// the ADD/ADD case, added to an ALREADY-WARM cache (`index.is_some()`
    /// -- exactly `TypeflowCache`'s real production lifetime: the workspace
    /// was cold-scanned long before this specific reconcile batch), which
    /// this crate's own doc comment (`TypeflowCache`'s "Known, accepted
    /// scope gap" paragraph) already names but describes as one-sided (an
    /// EXISTING file's previously-broken import getting satisfied by a
    /// later create) -- an entirely NEW file whose OWN needed-imports are
    /// resolved for the FIRST time, importing ANOTHER brand-new file added
    /// in the very same batch, is a different case that gap's own text does
    /// not cover, and turns out to share its exact mechanism: `svc_path`'s
    /// (the importer's) `refresh_paths` is seeded from `index.importers_of
    /// (svc_path)` -- who imports svc_path, never what svc_path itself
    /// imports -- so a brand-new svc_path's own first-time resolution is
    /// entirely correct via `resolve_import_targets_for` regardless of
    /// order... UNLESS a run BEFORE this one already tried and failed to
    /// resolve `Repo` for some THIRD, pre-existing file that also names it
    /// (see the module-level test below for the confirmed three-file
    /// interaction) -- kept here as the fixture that isolates the ADD/ADD
    /// shape alone, which this test demonstrates does NOT by itself
    /// reproduce the defect (both settle correctly) -- see `three_file_add_add_add_...`
    /// below for the shape that DOES.
    fn assert_member_access_through_parameter_property_survives_add_add_batch(
        repo_path: &str,
        svc_path: &str,
    ) {
        let dir = scratch_dir("typeflow-param-property-add-add-batch");
        let seed_blob = dir.join("seed.blob");
        let repo_blob = dir.join("repo.blob");
        let svc_blob = dir.join("svc.blob");

        // An unrelated file, cold-built alone first, purely to put `cache`
        // into the WARM (`index.is_some()`) state before `repo_path`/
        // `svc_path` are ever added -- `TypeflowCache`'s real production
        // lifetime (`state::WorkspaceState::typeflow_cache`) is NEVER
        // freshly cold for a real reconcile/delta batch (the workspace was
        // cold-scanned long before), so exercising the truly-cold `build`
        // path (as every OTHER test in this module does, including the two
        // above) would not be representative here.
        let seed_text = "export class Seed {}\n";
        let repo_text = "export class Repo {\n  find(): number {\n    return 1;\n  }\n}\n";
        let svc_text = format!(
            "import {{ Repo }} from './{repo_stem}';\nexport class Svc {{\n  constructor(private readonly repo: Repo) {{}}\n  run(): number {{\n    return this.repo.find();\n  }}\n}}\n",
            repo_stem = repo_path.trim_end_matches(".ts"),
        );

        let seed_sources = vec![owner("seed.ts", &seed_blob, seed_text)];
        let project_key = format!("typeflow-add-add-batch-{repo_path}-{svc_path}");
        let seed_files = analyze_project_files(&project_key, &["seed.ts"], &seed_sources);
        let mut cache =
            TypeflowCache::build_full(&seed_sources, None).expect("build_full succeeds (seed)");
        let resolver = WorkspaceResolver::build(&[]);
        let seed_available: BTreeSet<String> = seed_files.keys().cloned().collect();
        let _ = cache.build_index(&resolver, &seed_available, &seed_files);

        // The ADD/ADD batch: BOTH `repo_path` and `svc_path` are BRAND NEW
        // (never seen by `cache` before), upserted together before the
        // NEXT `build_index` call.
        cache.replace_file(repo_path, repo_text);
        cache.replace_file(svc_path, &svc_text);
        let repo_id = cache.summaries[repo_path].classes[0].entity_id.clone();
        let svc_id = cache.summaries[svc_path].classes[0].entity_id.clone();

        let all_sources = vec![
            owner("seed.ts", &seed_blob, seed_text),
            owner(repo_path, &repo_blob, repo_text),
            owner(svc_path, &svc_blob, &svc_text),
        ];
        let all_files = analyze_project_files(
            &project_key,
            &["seed.ts", repo_path, svc_path],
            &all_sources,
        );
        let available: BTreeSet<String> = all_files.keys().cloned().collect();

        let incremental_index = cache.build_index(&resolver, &available, &all_files);
        let incremental_repo_type = incremental_index.member_type_ref(&svc_id, "repo", false);
        let incremental_find = incremental_index.members(&repo_id, "find", false);

        let mut fresh =
            TypeflowCache::build_full(&all_sources, None).expect("build_full succeeds (fresh)");
        let fresh_index = fresh.build_index(&resolver, &available, &all_files);
        let fresh_repo_type = fresh_index.member_type_ref(&svc_id, "repo", false);
        let fresh_find = fresh_index.members(&repo_id, "find", false);

        assert_eq!(
            incremental_repo_type, fresh_repo_type,
            "Svc.repo (a constructor parameter property on a BRAND-NEW file, \
             importing ANOTHER brand-new file added in the SAME batch) must \
             match a from-scratch rebuild"
        );
        assert_eq!(
            incremental_repo_type,
            Some(urdira_jsts_typeflow::ResolvedTypeRef::Entity(repo_id)),
            "Svc.repo must resolve to Repo's entity id, not stay unresolved"
        );
        assert_eq!(incremental_find, fresh_find);
        assert!(matches!(
            incremental_find,
            urdira_jsts_typeflow::MemberLookup::One(_)
        ));
    }

    #[test]
    fn member_access_through_a_constructor_parameter_property_survives_an_add_add_batch_declarer_first()
     {
        assert_member_access_through_parameter_property_survives_add_add_batch("repo.ts", "svc.ts");
    }

    #[test]
    fn member_access_through_a_constructor_parameter_property_survives_an_add_add_batch_user_first()
    {
        assert_member_access_through_parameter_property_survives_add_add_batch(
            "z_repo.ts",
            "a_svc.ts",
        );
    }

    /// E-P0d CONFIRMED root cause: the real n8n `tags-3-months` diff
    /// (`git diff n8n@1.123.25 n8n@1.123.56`) shows THREE files, not two --
    /// `expression-engine.config.ts` is a brand-new file (declares the
    /// class), `expression-observability.provider.ts` is ALSO brand new
    /// (the constructor-parameter-property consumer), and
    /// `packages/@n8n/config/src/index.ts` (the package's own BARREL/
    /// re-export file, a THIRD, PRE-EXISTING file with MANY existing
    /// importers) is separately EDITED in the exact same commit range to
    /// add BOTH `export { ExpressionEngineConfig } from './configs/
    /// expression-engine.config'` AND a NEW member of its own (`GlobalConfig
    /// .expressionEngine: ExpressionEngineConfig`) -- confirmed via `git
    /// diff`, NOT present in either of the two-file reductions above (both
    /// of which pass). Reduced here to three files with the exact same
    /// three roles: `repo_path` (new, declares), `barrel_path` (PRE-
    /// EXISTING, edited in the batch, re-exports `repo_path`'s class AND
    /// gains its own new member typed with it), `svc_path` (new, imports
    /// THROUGH the barrel via a constructor parameter property).
    fn assert_member_access_through_a_reexporting_barrel_edited_in_the_same_batch(
        repo_path: &str,
        barrel_path: &str,
        svc_path: &str,
    ) {
        let dir = scratch_dir("typeflow-param-property-barrel-batch");
        let seed_blob = dir.join("seed.blob");
        let barrel_blob = dir.join("barrel.blob");
        let repo_blob = dir.join("repo.blob");
        let svc_blob = dir.join("svc.blob");

        let seed_text = "export class Seed {}\n";
        let barrel_v1 = "export class Other {}\n";
        let repo_text = "export class Repo {\n  find(): number {\n    return 1;\n  }\n}\n";
        let repo_stem = repo_path.trim_end_matches(".ts");
        let barrel_stem = barrel_path.trim_end_matches(".ts");
        // The barrel: pre-existing, edited in the SAME batch to (a)
        // re-export the brand-new declaring file's class and (b) gain its
        // OWN new member typed with it -- byte-identical shape to real
        // n8n's `@n8n/config/src/index.ts` gaining both `export {
        // ExpressionEngineConfig } from './configs/expression-engine.
        // config'` and `GlobalConfig.expressionEngine: ExpressionEngineConfig`
        // in the same diff.
        let barrel_v2 = format!(
            "import {{ Repo }} from './{repo_stem}';\nexport {{ Repo }} from './{repo_stem}';\nexport class Other {{\n  repo: Repo;\n}}\n",
        );
        let svc_text = format!(
            "import {{ Repo }} from './{barrel_stem}';\nexport class Svc {{\n  constructor(private readonly repo: Repo) {{}}\n  run(): number {{\n    return this.repo.find();\n  }}\n}}\n",
        );

        let seed_sources = vec![
            owner("seed.ts", &seed_blob, seed_text),
            owner(barrel_path, &barrel_blob, barrel_v1),
        ];
        let project_key = format!("typeflow-barrel-batch-{repo_path}-{barrel_path}-{svc_path}");
        let seed_files =
            analyze_project_files(&project_key, &["seed.ts", barrel_path], &seed_sources);
        let mut cache =
            TypeflowCache::build_full(&seed_sources, None).expect("build_full succeeds (seed)");
        let resolver = WorkspaceResolver::build(&[]);
        let seed_available: BTreeSet<String> = seed_files.keys().cloned().collect();
        let _ = cache.build_index(&resolver, &seed_available, &seed_files);

        // The batch: `barrel_path` EDITED (pre-existing), `repo_path` and
        // `svc_path` ADDED (brand new) -- all three upserted together
        // before the next `build_index` call, exactly like one real v4
        // reconcile generation over a real git diff.
        cache.replace_file(barrel_path, &barrel_v2);
        cache.replace_file(repo_path, repo_text);
        cache.replace_file(svc_path, &svc_text);
        let repo_id = cache.summaries[repo_path].classes[0].entity_id.clone();
        let svc_id = cache.summaries[svc_path].classes[0].entity_id.clone();

        let all_sources = vec![
            owner("seed.ts", &seed_blob, seed_text),
            owner(barrel_path, &barrel_blob, &barrel_v2),
            owner(repo_path, &repo_blob, repo_text),
            owner(svc_path, &svc_blob, &svc_text),
        ];
        let all_files = analyze_project_files(
            &project_key,
            &["seed.ts", barrel_path, repo_path, svc_path],
            &all_sources,
        );
        let available: BTreeSet<String> = all_files.keys().cloned().collect();

        let incremental_index = cache.build_index(&resolver, &available, &all_files);
        let incremental_repo_type = incremental_index.member_type_ref(&svc_id, "repo", false);
        let incremental_find = incremental_index.members(&repo_id, "find", false);

        let mut fresh =
            TypeflowCache::build_full(&all_sources, None).expect("build_full succeeds (fresh)");
        let fresh_index = fresh.build_index(&resolver, &available, &all_files);
        let fresh_repo_type = fresh_index.member_type_ref(&svc_id, "repo", false);
        let fresh_find = fresh_index.members(&repo_id, "find", false);

        assert_eq!(
            incremental_repo_type, fresh_repo_type,
            "Svc.repo (imported THROUGH a re-exporting barrel that is itself \
             edited in the SAME batch) must match a from-scratch rebuild -- \
             this is the exact shape E-P0d root-caused on real n8n"
        );
        assert_eq!(
            incremental_repo_type,
            Some(urdira_jsts_typeflow::ResolvedTypeRef::Entity(repo_id)),
            "Svc.repo must resolve to Repo's entity id through the barrel re-export, \
             not stay unresolved"
        );
        assert_eq!(incremental_find, fresh_find);
        assert!(
            matches!(incremental_find, urdira_jsts_typeflow::MemberLookup::One(_)),
            "this.repo.find() must resolve through the barrel-mediated parameter \
             property type, exactly like a from-scratch rebuild: {incremental_find:?}"
        );
    }

    #[test]
    fn member_access_through_a_reexporting_barrel_edited_in_the_same_batch_matches_real_n8n_path_order()
     {
        // Path order mirrors the REAL n8n diff exactly: declaring file
        // sorts first ("a_" < "b_" < "c_", matching "configs/expression-
        // engine.config.ts" < "index.ts" < "packages/cli/...").
        assert_member_access_through_a_reexporting_barrel_edited_in_the_same_batch(
            "a_repo.ts",
            "b_barrel.ts",
            "c_svc.ts",
        );
    }

    #[test]
    fn member_access_through_a_reexporting_barrel_edited_in_the_same_batch_reverse_path_order() {
        assert_member_access_through_a_reexporting_barrel_edited_in_the_same_batch(
            "z_repo.ts",
            "y_barrel.ts",
            "x_svc.ts",
        );
    }

    /// E-P0d review addition: the ACTUAL production shape this whole task
    /// exists to fix is NOT "three files upserted in one `build_index`
    /// batch" (every test above this one) -- it is `delta.rs::run`'s own
    /// structural/content generation split, which upserts the two brand-new
    /// files (`repo.ts`, `svc.ts`) in ONE `build_index` call and the
    /// pre-existing barrel's own content edit in a LATER, SEPARATE
    /// `build_index` call, with `TypeflowCache`/`ProgramIndex` PERSISTING on
    /// `self` across the two (see `pending_importers_of`'s own field doc
    /// comment: "it persists on `self.index` across SEPARATE `build_index`
    /// calls the same way `importers_of` does"). None of the six tests
    /// above this one actually exercises that persistence -- every one
    /// upserts all three files before a SINGLE `build_index` call, which
    /// only ever needs the WARM SETTLING LOOP's within-one-call fixed point
    /// (bounded by `MAX_SETTLING_ROUNDS`), never the cross-call
    /// `pending_importers_of` persistence this task's own first root cause
    /// (§12.2) specifically targets. This test calls `build_index` TWICE,
    /// with the barrel's own edit landing in the second, separate call --
    /// the literal repro shape.
    #[test]
    fn member_access_through_a_reexporting_barrel_edited_in_a_later_separate_build_index_call() {
        let dir = scratch_dir("typeflow-barrel-two-generations");
        let seed_blob = dir.join("seed.blob");
        let barrel_blob = dir.join("barrel.blob");
        let repo_blob = dir.join("repo.blob");
        let svc_blob = dir.join("svc.blob");

        let seed_text = "export class Seed {}\n";
        let barrel_v1 = "export class Other {}\n";
        let repo_text = "export class Repo {\n  find(): number {\n    return 1;\n  }\n}\n";
        let barrel_v2 = "import { Repo } from './repo';\nexport { Repo } from './repo';\nexport class Other {\n  repo: Repo;\n}\n";
        let svc_text = "import { Repo } from './barrel';\nexport class Svc {\n  constructor(private readonly repo: Repo) {}\n  run(): number {\n    return this.repo.find();\n  }\n}\n";

        // Cold seed: just `seed.ts` + the barrel at v1 (no re-export yet) --
        // mirrors a workspace already `ready` before the git switch lands.
        let seed_sources = vec![
            owner("seed.ts", &seed_blob, seed_text),
            owner("barrel.ts", &barrel_blob, barrel_v1),
        ];
        let project_key = "typeflow-barrel-two-generations";
        let seed_files =
            analyze_project_files(project_key, &["seed.ts", "barrel.ts"], &seed_sources);
        let mut cache =
            TypeflowCache::build_full(&seed_sources, None).expect("build_full succeeds (seed)");
        let resolver = WorkspaceResolver::build(&[]);
        let seed_available: BTreeSet<String> = seed_files.keys().cloned().collect();
        let _ = cache.build_index(&resolver, &seed_available, &seed_files);

        // GENERATION 1 (structural, `delta.rs`'s own vocabulary): the two
        // BRAND-NEW files land. `barrel.ts` is untouched, still v1 --
        // `svc.ts`'s own need resolves the specifier to `barrel.ts` (a known
        // file) but not the named export `Repo` (barrel does not re-export
        // it yet): the exact "pending", not "no target file at all", shape.
        cache.replace_file("repo.ts", repo_text);
        cache.replace_file("svc.ts", svc_text);
        let repo_id = cache.summaries["repo.ts"].classes[0].entity_id.clone();
        let svc_id = cache.summaries["svc.ts"].classes[0].entity_id.clone();
        let gen1_sources = vec![
            owner("seed.ts", &seed_blob, seed_text),
            owner("barrel.ts", &barrel_blob, barrel_v1),
            owner("repo.ts", &repo_blob, repo_text),
            owner("svc.ts", &svc_blob, svc_text),
        ];
        let gen1_files = analyze_project_files(
            project_key,
            &["seed.ts", "barrel.ts", "repo.ts", "svc.ts"],
            &gen1_sources,
        );
        let gen1_available: BTreeSet<String> = gen1_files.keys().cloned().collect();
        let gen1_index = cache.build_index(&resolver, &gen1_available, &gen1_files);
        assert_eq!(
            gen1_index.member_type_ref(&svc_id, "repo", false),
            None,
            "GEN 1: barrel.ts has not re-exported Repo yet -- must stay \
             unresolved, never a guess"
        );
        assert_eq!(
            gen1_index.pending_importers_of("barrel.ts"),
            vec!["svc.ts".to_owned()],
            "GEN 1: svc.ts's still-failing need must be tracked against \
             barrel.ts, so it survives into the NEXT, separate build_index \
             call"
        );

        // GENERATION 2 (content): ONLY the pre-existing barrel is upserted
        // this time -- a SEPARATE, LATER `build_index` call, exactly like
        // `delta.rs::run`'s own second sub-batch for a mixed
        // Created+Modified generation split. `repo.ts`/`svc.ts` are NOT
        // touched again here.
        cache.replace_file("barrel.ts", barrel_v2);
        let gen2_sources = vec![
            owner("seed.ts", &seed_blob, seed_text),
            owner("barrel.ts", &barrel_blob, barrel_v2),
            owner("repo.ts", &repo_blob, repo_text),
            owner("svc.ts", &svc_blob, svc_text),
        ];
        let gen2_files = analyze_project_files(
            project_key,
            &["seed.ts", "barrel.ts", "repo.ts", "svc.ts"],
            &gen2_sources,
        );
        let gen2_available: BTreeSet<String> = gen2_files.keys().cloned().collect();
        let incremental_index = cache.build_index(&resolver, &gen2_available, &gen2_files);
        let incremental_repo_type = incremental_index.member_type_ref(&svc_id, "repo", false);
        let incremental_find = incremental_index.members(&repo_id, "find", false);

        let mut fresh =
            TypeflowCache::build_full(&gen2_sources, None).expect("build_full succeeds (fresh)");
        let fresh_index = fresh.build_index(&resolver, &gen2_available, &gen2_files);
        let fresh_repo_type = fresh_index.member_type_ref(&svc_id, "repo", false);
        let fresh_find = fresh_index.members(&repo_id, "find", false);

        assert_eq!(
            incremental_repo_type, fresh_repo_type,
            "Svc.repo must match a from-scratch rebuild even when the \
             barrel's own re-export edit lands in a SEPARATE, LATER \
             build_index call than the two brand-new files it mediates \
             between -- the literal production repro shape"
        );
        assert_eq!(
            incremental_repo_type,
            Some(urdira_jsts_typeflow::ResolvedTypeRef::Entity(repo_id)),
            "Svc.repo must resolve to Repo's entity id through the barrel \
             re-export once it lands, not stay permanently unresolved"
        );
        assert_eq!(incremental_find, fresh_find);
        assert!(
            matches!(incremental_find, urdira_jsts_typeflow::MemberLookup::One(_)),
            "this.repo.find() must resolve through the barrel-mediated \
             parameter property type across the generation boundary: \
             {incremental_find:?}"
        );
        assert!(
            incremental_index
                .pending_importers_of("barrel.ts")
                .is_empty(),
            "svc.ts's now-resolved need must stop being retried"
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

    /// Frente E-P0g adversarial review, attack #4: a re-export CYCLE
    /// (`a.ts` bare-`export *`s `b.ts`, `b.ts` bare-`export *`s `a.ts`,
    /// neither ever directly declaring the queried name) must not spin
    /// `collect_reexport_chain_paths` forever -- its own `visiting` cycle
    /// guard (mirroring `resolver::resolve_named_export_inner`'s) must
    /// terminate it after visiting each `(path, name)` pair at most once,
    /// returning exactly the two files it actually walked through, never
    /// looping forever nor silently returning an empty/partial set.
    #[test]
    fn collect_reexport_chain_paths_terminates_on_a_cycle() {
        fn minimal_star_reexporter(path: &str, star_targets: &[&str]) -> SyntaxFileResult {
            SyntaxFileResult {
                path: path.to_owned(),
                content_digest: "sha256:0".to_owned(),
                language: urdira_jsts_syntax_worker::Language::Typescript,
                script_kind: urdira_jsts_syntax_worker::ScriptKind::Ts,
                byte_length: 0,
                parsed: true,
                direct_imports: Vec::new(),
                entities: Vec::new(),
                relations: Vec::new(),
                diagnostics: Vec::new(),
                export_bindings: Vec::new(),
                export_star_specifiers: star_targets
                    .iter()
                    .map(|target| urdira_jsts_syntax_worker::ExportStarSpecifier {
                        specifier: format!("./{target}"),
                        target_path: Some((*target).to_owned()),
                    })
                    .collect(),
                ambient_modules: Vec::new(),
                ambient_globals: Vec::new(),
                namespace_members: Vec::new(),
                line_index: urdira_jsts_syntax_worker::LineIndex::from_text(""),
            }
        }
        let mut files: BTreeMap<String, SyntaxFileResult> = BTreeMap::new();
        files.insert(
            "a.ts".to_owned(),
            minimal_star_reexporter("a.ts", &["b.ts"]),
        );
        files.insert(
            "b.ts".to_owned(),
            minimal_star_reexporter("b.ts", &["a.ts"]),
        );

        let visited = collect_reexport_chain_paths(&files, "a.ts", "NeverDeclaredAnywhere");

        assert_eq!(
            visited,
            ["a.ts".to_owned(), "b.ts".to_owned()]
                .into_iter()
                .collect::<BTreeSet<String>>(),
            "a re-export cycle must terminate at exactly the two files it actually visits"
        );
    }

    /// Frente E-P0g adversarial review, attack #4 (nested/nonlinear chain,
    /// no cycle): `a.ts` -> `b.ts` -> `c.ts` (bare `export *` all the way
    /// down), `c.ts` directly declares the name -- confirms the walk
    /// includes every intermediate hop (`a.ts`, `b.ts`, `c.ts`) and stops
    /// AT the direct declarer rather than recursing past it (there is
    /// nothing beyond `c.ts` to visit here, but a bug that ignored the
    /// direct-declaration base case would still show up as a panic/loop
    /// on a deliberately malformed `files` map elsewhere -- this pins the
    /// straight-line case's exact expected set).
    #[test]
    fn collect_reexport_chain_paths_includes_every_hop_in_a_three_file_chain() {
        fn direct_declarer(path: &str, name: &str) -> SyntaxFileResult {
            SyntaxFileResult {
                path: path.to_owned(),
                content_digest: "sha256:0".to_owned(),
                language: urdira_jsts_syntax_worker::Language::Typescript,
                script_kind: urdira_jsts_syntax_worker::ScriptKind::Ts,
                byte_length: 0,
                parsed: true,
                direct_imports: Vec::new(),
                entities: Vec::new(),
                relations: Vec::new(),
                diagnostics: Vec::new(),
                export_bindings: vec![urdira_jsts_syntax_worker::SyntaxExportBinding {
                    exported_name: name.to_owned(),
                    local_name: name.to_owned(),
                    source_specifier: None,
                    source_target_path: None,
                }],
                export_star_specifiers: Vec::new(),
                ambient_modules: Vec::new(),
                ambient_globals: Vec::new(),
                namespace_members: Vec::new(),
                line_index: urdira_jsts_syntax_worker::LineIndex::from_text(""),
            }
        }
        fn star_reexporter(path: &str, target: &str) -> SyntaxFileResult {
            SyntaxFileResult {
                path: path.to_owned(),
                content_digest: "sha256:0".to_owned(),
                language: urdira_jsts_syntax_worker::Language::Typescript,
                script_kind: urdira_jsts_syntax_worker::ScriptKind::Ts,
                byte_length: 0,
                parsed: true,
                direct_imports: Vec::new(),
                entities: Vec::new(),
                relations: Vec::new(),
                diagnostics: Vec::new(),
                export_bindings: Vec::new(),
                export_star_specifiers: vec![urdira_jsts_syntax_worker::ExportStarSpecifier {
                    specifier: format!("./{target}"),
                    target_path: Some(target.to_owned()),
                }],
                ambient_modules: Vec::new(),
                ambient_globals: Vec::new(),
                namespace_members: Vec::new(),
                line_index: urdira_jsts_syntax_worker::LineIndex::from_text(""),
            }
        }
        let mut files: BTreeMap<String, SyntaxFileResult> = BTreeMap::new();
        files.insert("a.ts".to_owned(), star_reexporter("a.ts", "b.ts"));
        files.insert("b.ts".to_owned(), star_reexporter("b.ts", "c.ts"));
        files.insert("c.ts".to_owned(), direct_declarer("c.ts", "Thing"));

        let visited = collect_reexport_chain_paths(&files, "a.ts", "Thing");

        assert_eq!(
            visited,
            ["a.ts".to_owned(), "b.ts".to_owned(), "c.ts".to_owned()]
                .into_iter()
                .collect::<BTreeSet<String>>(),
            "every intermediate hop plus the terminal declaring file must be visited; got \
             {visited:?}"
        );
    }
}
