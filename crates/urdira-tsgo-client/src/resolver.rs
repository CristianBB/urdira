//! `ResidualResolver`: resolves a batch of "pending sites" (unresolved
//! identifier references, calls, and heritage clauses left over from a
//! syntax-only pass) to their declarations, using a live `TsgoClient`
//! checker session — the piece P1-D-a exists to build so a future
//! background residual pass can run this without the Node semantic worker.
//!
//! This is a from-scratch reimplementation of the *resolution sequence*
//! `packages/plugin-javascript-typescript/src/analyzer.ts` already performs
//! against the in-process (Node) checker, adapted to work per-site (batched
//! per owner file) against the wire API instead of against live `ts.Node`
//! objects. Behavior is intentionally scoped down to target resolution only
//! — no diagnostics, no entity/relation graph — see each method's doc
//! comment for the exact `analyzer.ts` line range it mirrors and any
//! deliberate deviation.

use std::collections::HashMap;
use std::sync::Arc;

use crate::client::{ClientError, TsgoClient};
use crate::node::{NodeHandle, RemoteSourceFile, syntax_kind};
use crate::proto::symbol_flags;
use crate::trivia::to_utf16;
use crate::virtual_fs::VirtualFs;

/// Maximum number of `NodeHandle`s sent in one `getSymbolsAtLocations`
/// request. P1-D-e's own diagnosis (`docs/evidence/
/// 2026-09-04-v4-p1d-e-residual-rpc.md`) found that 37% of n8n's residual-
/// pass sites failed with a tsgo RPC error ("node handle ... could not be
/// resolved (file may not be loaded or handle may be stale)") for large
/// owner groups, and that this error poisons the ENTIRE batched request —
/// every site in the SAME owner group was marked unresolved, not just the
/// one bad handle. Chunking bounds how much work one bad handle can take
/// down at once; the real recovery is `ResidualResolver::
/// fetch_symbols_chunked`'s per-location retry on a failed chunk, this
/// constant only bounds chunk SIZE (2,000 per the task brief — large enough
/// that a normal owner's whole batch fits in one chunk in the common case,
/// small enough that a chunk-level retry-storm on a genuinely pathological
/// owner stays bounded).
const MAX_LOCATIONS_PER_CALL: usize = 2000;

/// The three site shapes `analyzer.ts`'s `visit()` resolves declarations
/// for (`isIdentifier`, `isCallExpression`, `isHeritageClause` branches,
/// `packages/plugin-javascript-typescript/src/analyzer.ts:~1880-1935`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SiteKind {
    IdentifierRef,
    Call,
    Heritage,
}

/// One unresolved site from a prior syntax-only pass. `start`/`end` are
/// UTF-16 code unit offsets (the same units `analyzer.ts`'s own
/// `descendToPendingSiteSpan` callers use — see `crate::node`'s "Position
/// units" doc), bounding the exact sub-span the syntax pass could not
/// resolve: the whole call expression for `Call`, the identifier itself for
/// `IdentifierRef`, and one listed type's own expression span (not the
/// whole `implements A, B` clause) for `Heritage`.
#[derive(Debug, Clone)]
pub struct PendingSite {
    pub owner_path: String,
    pub start: i32,
    pub end: i32,
    pub kind: SiteKind,
    /// Free-form context carried through to `Unresolved::reason` on
    /// failure and otherwise unused — lets a caller correlate a resolution
    /// back to whatever record it came from without this crate needing to
    /// know that record's shape.
    pub reason: String,
}

/// A resolved declaration: the file it lives in, the UTF-16 start offset of
/// its name identifier (identity anchor — see `analyzer.ts`'s own comment
/// on why identity uses the name, not the declaration span, at
/// `packages/plugin-javascript-typescript/src/analyzer.ts:1787-1793`), and
/// the full declaration span.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedDeclaration {
    pub path: String,
    pub name_identifier_start: i32,
    pub decl_start: i32,
    pub decl_end: i32,
    /// The declaration node's own `SyntaxKind` (`crate::node::syntax_kind`),
    /// e.g. `CLASS_DECLARATION`/`METHOD_DECLARATION`/`CONSTRUCTOR`. Not used
    /// by anything in this module; carried through for a caller building a
    /// richer result on top (`crate::residual_pass::SiteOutcome::
    /// WorkspaceTarget::kind_hint`) that wants a cheap hint about what kind
    /// of thing was resolved without re-fetching the source file.
    pub decl_kind: u32,
}

#[derive(Debug, Clone)]
pub enum Resolution {
    Resolved(ResolvedDeclaration),
    Unresolved { reason: String },
}

/// Resolves pending sites against a live tsgo snapshot, caching every
/// source file it fetches (owner files and declaration target files alike)
/// for the resolver's lifetime — `analyzer.ts`'s `resolvedByDeclaration`/
/// `resolvedBySymbol` caches serve the same purpose there.
pub struct ResidualResolver<'a> {
    client: &'a TsgoClient,
    fs: Arc<dyn VirtualFs>,
    snapshot: u64,
    project: String,
    source_files: HashMap<String, Arc<RemoteSourceFile>>,
    texts: HashMap<String, Arc<Vec<u16>>>,
}

impl<'a> ResidualResolver<'a> {
    pub fn new(
        client: &'a TsgoClient,
        fs: Arc<dyn VirtualFs>,
        snapshot: u64,
        project: impl Into<String>,
    ) -> Self {
        Self {
            client,
            fs,
            snapshot,
            project: project.into(),
            source_files: HashMap::new(),
            texts: HashMap::new(),
        }
    }

    fn source_file(&mut self, path: &str) -> Result<Option<Arc<RemoteSourceFile>>, ClientError> {
        if let Some(cached) = self.source_files.get(path) {
            return Ok(Some(Arc::clone(cached)));
        }
        let Some(source_file) = self
            .client
            .get_source_file(self.snapshot, &self.project, path)?
        else {
            return Ok(None);
        };
        let arc = Arc::new(source_file);
        self.source_files.insert(path.to_string(), Arc::clone(&arc));
        Ok(Some(arc))
    }

    fn text(&mut self, path: &str) -> Option<Arc<Vec<u16>>> {
        if let Some(cached) = self.texts.get(path) {
            return Some(Arc::clone(cached));
        }
        let content = self.fs.read_file(path)?;
        let arc = Arc::new(to_utf16(&content));
        self.texts.insert(path.to_string(), Arc::clone(&arc));
        Some(arc)
    }

    /// Resolves every site in `sites`, returning one `Resolution` per input
    /// site in the same order. Sites are grouped by `owner_path` and, per
    /// group, span-sorted for `descend_to_span`'s cursor reuse (see
    /// `crate::node::RemoteSourceFile::descend_to_span`'s doc comment) —
    /// output order is unaffected, this is purely an internal traversal
    /// optimization, mirroring why `analyzer.ts`'s own Rust caller sorts
    /// `pending_sites` by `start` before the walk.
    ///
    /// Thin wrapper over [`Self::resolve_with_deadline`] with `deadline:
    /// None` (never skips an owner group) — kept as the STABLE, always-
    /// complete API every existing caller/test uses.
    pub fn resolve(&mut self, sites: &[PendingSite]) -> Vec<Resolution> {
        let (attempted, skipped) = self.resolve_with_deadline(sites, None);
        debug_assert!(
            skipped.is_empty(),
            "resolve_with_deadline(.., None) must never skip an owner group"
        );
        let mut results: Vec<Option<Resolution>> = vec![None; sites.len()];
        for (index, resolution) in attempted {
            results[index] = Some(resolution);
        }
        results
            .into_iter()
            .map(|r| r.expect("every site index is assigned exactly once"))
            .collect()
    }

    /// C.1 budget-overshoot fix (2026-09-05, live n8n finding): like
    /// [`Self::resolve`], but checks `deadline` (if any) BETWEEN owner
    /// groups — never mid-group (a group's own `resolve_owner_group` call,
    /// including its batched `getSymbolsAtLocations` RPCs, always finishes
    /// once started, exactly like `residual_pass.rs::run_lane`'s own check
    /// points `(a)`/`(b)`). Diagnosed live: a single owner group's
    /// `resolve_owner_group` call routinely took multiple seconds on the
    /// n8n corpus (up to ~10.9s observed, `v4-fold/q5-residual/
    /// schedule5.log`'s own per-window `resolve_ms`), the actual cause of
    /// `checker_ms` overshooting `URDIRA_V4_RESIDUAL_BUDGET_MS` by several
    /// seconds — NOT `updateSnapshot` (its own `snapshot_ms` stayed under
    /// ~0.8s per window in the same run).
    ///
    /// Returns `(attempted, skipped_owners)`: `attempted` is `(site index
    /// in `sites`, Resolution)` pairs for every site whose OWNER GROUP was
    /// reached before the deadline (owners are visited in the same sorted
    /// order `resolve` always used, so this is deterministic); `skipped_
    /// owners` lists every owner path (sorted) whose group was never
    /// started at all. The caller (`residual_pass.rs::run_lane`) treats a
    /// non-empty `skipped_owners` exactly like check points `(a)`/`(b)`:
    /// every root of the current window goes to `remaining_roots` (the
    /// already-resolved ones too — cheap to re-attempt next round, see
    /// that call site's own comment for why re-resolving an already-closed
    /// `pending.sites` row is idempotent) and no further windows open.
    pub fn resolve_with_deadline(
        &mut self,
        sites: &[PendingSite],
        deadline: Option<std::time::Instant>,
    ) -> (Vec<(usize, Resolution)>, Vec<String>) {
        let mut by_owner: HashMap<&str, Vec<usize>> = HashMap::new();
        for (index, site) in sites.iter().enumerate() {
            by_owner
                .entry(site.owner_path.as_str())
                .or_default()
                .push(index);
        }
        let mut owners: Vec<&str> = by_owner.keys().copied().collect();
        owners.sort_unstable();

        let mut attempted: Vec<(usize, Resolution)> = Vec::with_capacity(sites.len());
        let mut skipped_owners: Vec<String> = Vec::new();
        let mut past_deadline = false;
        for owner_path in owners {
            if !past_deadline
                && let Some(d) = deadline
                && std::time::Instant::now() >= d
            {
                past_deadline = true;
            }
            if past_deadline {
                skipped_owners.push(owner_path.to_string());
                continue;
            }
            let mut indices = by_owner.remove(owner_path).unwrap();
            indices.sort_by_key(|&i| sites[i].start);
            let resolved = self.resolve_owner_group(owner_path, &indices, sites);
            for (position, &index) in indices.iter().enumerate() {
                attempted.push((index, resolved[position].clone()));
            }
        }
        (attempted, skipped_owners)
    }

    fn resolve_owner_group(
        &mut self,
        owner_path: &str,
        indices: &[usize],
        sites: &[PendingSite],
    ) -> Vec<Resolution> {
        let Some(owner_file) = self.source_file_or_err(owner_path) else {
            return indices
                .iter()
                .map(|_| Resolution::Unresolved {
                    reason: format!("owner file not in project: {owner_path}"),
                })
                .collect();
        };
        let Some(owner_text) = self.text(owner_path) else {
            return indices
                .iter()
                .map(|_| Resolution::Unresolved {
                    reason: format!("owner file text unavailable: {owner_path}"),
                })
                .collect();
        };

        // Step 1: descend every site's span to its innermost containing
        // node, and collect the "lookup node" whose symbol we need — the
        // node itself for IdentifierRef, the callee identifier for Call
        // (when direct), the type expression for Heritage.
        let mut cursor = vec![1usize]; // SourceFile is always node index 1.
        struct SiteWork {
            descended: usize,
            lookup: Option<usize>,
        }
        let mut work = Vec::with_capacity(indices.len());
        for &index in indices {
            let site = &sites[index];
            let descended =
                owner_file.descend_to_span(&mut cursor, &owner_text, site.start, site.end);
            let lookup = match site.kind {
                SiteKind::IdentifierRef => Some(descended),
                SiteKind::Call => callee_identifier(&owner_file, descended),
                SiteKind::Heritage => heritage_expression(&owner_file, descended),
            };
            work.push(SiteWork { descended, lookup });
        }

        // Step 2: batched getSymbolsAtLocations for the whole owner group
        // (`analyzer.ts:1721` — `checker.getSymbolAtLocation(identifierNodes)`),
        // chunked (see `MAX_LOCATIONS_PER_CALL`'s doc comment) so that a
        // server-side "stale node handle" RPC error for ONE location in a
        // large owner group (P1-D-e's own diagnosed failure — see
        // `docs/evidence/2026-09-04-v4-p1d-e-residual-rpc.md`) costs at most
        // that one site, never the rest of the owner's sites.
        let handles: Vec<Option<NodeHandle>> = work
            .iter()
            .map(|w| {
                w.lookup
                    .map(|idx| NodeHandle::new(idx as u32, owner_file.kind(idx), owner_path))
            })
            .collect();
        let (symbol_by_work, rpc_error_by_work) = self.fetch_symbols_chunked(&handles);

        // Step 3: per-site resolution using the batched symbols.
        let mut out = Vec::with_capacity(indices.len());
        for (position, &index) in indices.iter().enumerate() {
            let site = &sites[index];
            let w = &work[position];
            let lookup_error = rpc_error_by_work[position].as_deref();
            let resolution = match site.kind {
                SiteKind::IdentifierRef => self.resolve_via_symbol_with_error(
                    symbol_by_work[position].as_ref(),
                    lookup_error,
                    &site.reason,
                ),
                SiteKind::Heritage => self.resolve_via_symbol_with_error(
                    symbol_by_work[position].as_ref(),
                    lookup_error,
                    &site.reason,
                ),
                SiteKind::Call => self.resolve_call(
                    owner_file.as_ref(),
                    owner_path,
                    w.descended,
                    symbol_by_work[position].as_ref(),
                    lookup_error,
                    &site.reason,
                ),
            };
            out.push(resolution);
        }
        out
    }

    /// Fetches symbols for every `Some` handle in `handles` (preserving
    /// position — a `None` handle in the input yields `(None, None)` at
    /// that same position in the output), in chunks of at most
    /// [`MAX_LOCATIONS_PER_CALL`] locations per `getSymbolsAtLocations`
    /// call. If a WHOLE CHUNK's request fails (the "stale node handle" RPC
    /// error this method exists to contain — see
    /// `docs/evidence/2026-09-04-v4-p1d-e-residual-rpc.md`), that chunk is
    /// retried ONE LOCATION AT A TIME so a single bad handle costs only its
    /// own site's resolution, not every other location in the same chunk —
    /// each location's own error (if it individually still fails) is
    /// carried back as `Some(reason)` in the second return value, for the
    /// caller to report as a real (non-generic) unresolved reason rather
    /// than silently falling through to "no symbol at location", which
    /// would misreport an RPC failure as a genuine checker miss.
    fn fetch_symbols_chunked(
        &self,
        handles: &[Option<NodeHandle>],
    ) -> (
        Vec<Option<crate::proto::SymbolResponse>>,
        Vec<Option<String>>,
    ) {
        let mut symbol_by_work: Vec<Option<crate::proto::SymbolResponse>> =
            vec![None; handles.len()];
        let mut rpc_error_by_work: Vec<Option<String>> = vec![None; handles.len()];
        let present: Vec<(usize, NodeHandle)> = handles
            .iter()
            .enumerate()
            .filter_map(|(position, handle)| handle.clone().map(|handle| (position, handle)))
            .collect();
        for chunk in present.chunks(MAX_LOCATIONS_PER_CALL) {
            let chunk_handles: Vec<NodeHandle> =
                chunk.iter().map(|(_, handle)| handle.clone()).collect();
            match self
                .client
                .get_symbols_at_locations(self.snapshot, &self.project, &chunk_handles)
            {
                Ok(results) => {
                    for ((position, _), result) in chunk.iter().zip(results) {
                        symbol_by_work[*position] = result;
                    }
                }
                Err(_chunk_error) => {
                    // The whole-chunk request failed; a single-location
                    // retry pinpoints exactly which handle(s) are actually
                    // bad (the chunk error itself names no specific
                    // location, so it is not reported directly — each
                    // location's own retry result is more precise).
                    for (position, handle) in chunk {
                        match self.client.get_symbols_at_locations(
                            self.snapshot,
                            &self.project,
                            std::slice::from_ref(handle),
                        ) {
                            Ok(mut results) => {
                                symbol_by_work[*position] = results.pop().flatten();
                            }
                            Err(single_error) => {
                                rpc_error_by_work[*position] =
                                    Some(format!("getSymbolsAtLocations failed: {single_error}"));
                            }
                        }
                    }
                }
            }
        }
        (symbol_by_work, rpc_error_by_work)
    }

    fn source_file_or_err(&mut self, path: &str) -> Option<Arc<RemoteSourceFile>> {
        self.source_file(path).ok().flatten()
    }

    /// `analyzer.ts`'s `resolvedDeclaration`
    /// (`packages/plugin-javascript-typescript/src/analyzer.ts:~1801-1823`):
    /// alias-hop, then `valueDeclaration ?? declarations[0]`, then resolve
    /// that handle to a `(path, name start, decl span)` triple.
    ///
    /// `lookup_error` — when `Some`, set by
    /// `fetch_symbols_chunked` when this SPECIFIC location's own
    /// `getSymbolsAtLocations` call failed (as opposed to the checker
    /// genuinely returning no symbol) — is reported as the unresolved
    /// reason instead of the generic "no symbol at location", so a caller's
    /// reason histogram distinguishes an RPC failure from a real miss.
    fn resolve_via_symbol_with_error(
        &mut self,
        symbol: Option<&crate::proto::SymbolResponse>,
        lookup_error: Option<&str>,
        reason: &str,
    ) -> Resolution {
        let Some(symbol) = symbol else {
            let detail = lookup_error.unwrap_or("no symbol at location");
            return Resolution::Unresolved {
                reason: format!("{detail} ({reason})"),
            };
        };
        self.resolve_symbol_to_declaration(symbol.clone(), reason)
    }

    fn resolve_symbol_to_declaration(
        &mut self,
        mut symbol: crate::proto::SymbolResponse,
        reason: &str,
    ) -> Resolution {
        if symbol.flags & symbol_flags::ALIAS != 0 {
            match self
                .client
                .get_aliased_symbol(self.snapshot, &self.project, symbol.id)
            {
                Ok(aliased) => {
                    // Mirrors `checker.isUnknownSymbol(aliased)`: the
                    // checker's synthetic "unknown" symbol for an
                    // unresolved alias carries no declarations. This crate
                    // has no `getWellKnownSymbols` call (out of scope —
                    // see the crate docs), so it approximates identity by
                    // shape instead of by id.
                    if aliased.value_declaration.is_some() || !aliased.declarations.is_empty() {
                        symbol = aliased;
                    }
                }
                Err(_) => {
                    // The direct symbol remains authoritative, matching
                    // `analyzer.ts`'s `catch { /* ... */ }`.
                }
            }
        }
        let handle_str = symbol
            .value_declaration
            .clone()
            .or_else(|| symbol.declarations.first().cloned());
        let Some(handle_str) = handle_str else {
            return Resolution::Unresolved {
                reason: format!("symbol has no declaration ({reason})"),
            };
        };
        let Some(handle) = NodeHandle::parse(&handle_str) else {
            return Resolution::Unresolved {
                reason: format!("malformed declaration handle {handle_str:?} ({reason})"),
            };
        };
        self.resolve_handle(&handle, reason)
    }

    fn resolve_handle(&mut self, handle: &NodeHandle, reason: &str) -> Resolution {
        let Some(target_file) = self.source_file_or_err(&handle.path) else {
            return Resolution::Unresolved {
                reason: format!(
                    "declaration file not in project: {} ({reason})",
                    handle.path
                ),
            };
        };
        let Some(target_text) = self.text(&handle.path) else {
            return Resolution::Unresolved {
                reason: format!(
                    "declaration file text unavailable: {} ({reason})",
                    handle.path
                ),
            };
        };
        let index = handle.index as usize;
        if index >= target_file.node_count() {
            return Resolution::Unresolved {
                reason: format!("declaration node index out of range ({reason})"),
            };
        }
        // P1-D-f (found live via `scripts/v4-call-parity-diff.mjs`'s own
        // `v4_confirmed_different_target` bucket): `getResolvedSignature`'s
        // own `.declaration` for a call through a variable holding an
        // anonymous function value (`const foo = async () => {...}`, or
        // `const g = function() {...}`) is the ARROW FUNCTION/FUNCTION
        // EXPRESSION node itself — correct for "which signature is being
        // called", but that node has no name of its own, so the naive
        // `name_start(index).unwrap_or(decl_start)` fallback below used to
        // silently fall back to the declaration's OWN span start — which,
        // for `async (...) => {...}`, IS the `async` keyword's own
        // position, producing a bogus "name" of literal text `"async"` once
        // a caller slices identifier text there (confirmed live: a v3
        // target of `jsts:variable:.../fix-tool-call.ts:911:fixToolCall`
        // came back from this pass as `jsts:member:.../fix-tool-call.ts:
        // 925:async` — same call, same real target, wrong identity because
        // this fallback anchored on the wrong node). `analyzer.ts`'s own
        // `nameOf`/`addEntity` never have this problem because they walk
        // the REAL symbol's `valueDeclaration` -- for `const foo = () => {}`
        // that IS the `VariableDeclaration` node (`foo`'s own binding), not
        // the function expression -- so v3's confirmed target is always the
        // `VariableDeclaration`, never the anonymous function value. This
        // climbs to the immediate parent in that one specific shape
        // (anonymous function value with no name of its own, parented
        // directly under a `VariableDeclaration`) and re-anchors identity
        // there instead, matching v3's own target exactly rather than
        // fabricating a name from arbitrary text.
        let mut effective_index = index;
        if matches!(
            target_file.kind(index),
            syntax_kind::ARROW_FUNCTION | syntax_kind::FUNCTION_EXPRESSION
        ) && target_file.name_start(index, &target_text).is_none()
        {
            let parent = target_file.parent_index(index) as usize;
            if parent < target_file.node_count()
                && target_file.kind(parent) == syntax_kind::VARIABLE_DECLARATION
                && target_file.name_start(parent, &target_text).is_some()
            {
                effective_index = parent;
            }
        }
        let decl_start = target_file.node_start(effective_index, &target_text);
        let decl_end = target_file.end(effective_index);
        let name_start = if target_file.kind(effective_index) == syntax_kind::CONSTRUCTOR {
            target_file.constructor_keyword_start(effective_index, &target_text)
        } else {
            target_file
                .name_start(effective_index, &target_text)
                .unwrap_or(decl_start)
        };
        Resolution::Resolved(ResolvedDeclaration {
            path: handle.path.clone(),
            name_identifier_start: name_start,
            decl_start,
            decl_end,
            decl_kind: target_file.kind(effective_index),
        })
    }

    /// `analyzer.ts`'s call-resolution sequence
    /// (`packages/plugin-javascript-typescript/src/analyzer.ts:~1900-1930`):
    /// try the direct-single-non-alias-declaration shortcut first, then
    /// `getResolvedSignature`, then fall back to the callee's own resolved
    /// declaration. Unlike `analyzer.ts` (which reuses a symbol already
    /// fetched incidentally by the full-file identifier walk), this crate
    /// fetches the callee's symbol itself via the same batched
    /// `getSymbolsAtLocations` call as every other site in the owner group
    /// (see `resolve_owner_group`'s `callee_identifier` lookup) — the
    /// analyzer's reuse was a walk-order optimization this per-site API has
    /// no equivalent opportunity for, not a semantic requirement.
    fn resolve_call(
        &mut self,
        owner_file: &RemoteSourceFile,
        owner_path: &str,
        call_index: usize,
        callee_symbol: Option<&crate::proto::SymbolResponse>,
        lookup_error: Option<&str>,
        reason: &str,
    ) -> Resolution {
        // Direct shortcut: callee is a plain (non-alias) identifier with
        // exactly one declaration.
        if let Some(symbol) = callee_symbol
            && symbol.flags & symbol_flags::ALIAS == 0
            && symbol.declarations.len() == 1
        {
            let handle_str = symbol
                .value_declaration
                .clone()
                .unwrap_or_else(|| symbol.declarations[0].clone());
            if let Some(handle) = NodeHandle::parse(&handle_str) {
                return self.resolve_handle(&handle, reason);
            }
        }

        // getResolvedSignature(call).declaration.
        let call_handle =
            NodeHandle::new(call_index as u32, owner_file.kind(call_index), owner_path);
        match self
            .client
            .get_resolved_signature(self.snapshot, &self.project, &call_handle)
        {
            Ok(Some(signature)) => {
                if let Some(handle_str) = signature.declaration
                    && let Some(handle) = NodeHandle::parse(&handle_str)
                {
                    return self.resolve_handle(&handle, reason);
                }
            }
            Ok(None) => {}
            Err(_) => {}
        }

        // Fall back to the callee's own resolved declaration (alias hop
        // included), matching `analyzer.ts`'s `resolvedDeclaration(expression)`
        // fallback.
        match callee_symbol {
            Some(symbol) => self.resolve_symbol_to_declaration(symbol.clone(), reason),
            None => {
                // `lookup_error` (set only when this call's own callee
                // handle failed its `getSymbolsAtLocations` lookup — see
                // `fetch_symbols_chunked`) is a more accurate reason than
                // the generic "no unique call target" when it is present:
                // the callee identifier lookup itself failed at the RPC
                // layer, `getResolvedSignature` also came back empty/erred
                // above, so there is genuinely nothing else to try, but the
                // TRUE cause was the RPC failure, not an ordinary checker
                // miss.
                let detail = lookup_error.unwrap_or("no unique call target");
                Resolution::Unresolved {
                    reason: format!("{detail} ({reason})"),
                }
            }
        }
    }
}

/// If `call_index`'s callee (first child of the `CallExpression`) is a
/// plain `Identifier`, returns its node index — the lookup this crate needs
/// a symbol for to attempt `analyzer.ts`'s `directCallDeclaration`
/// shortcut. `None` for a property-access/element-access/computed callee,
/// which always goes through `getResolvedSignature` instead.
///
/// P1-D-g item 3 (`docs/evidence/
/// 2026-09-05-v4-p1d-g-classification-and-build-failures.md` §3):
/// **deliberately tried and REVERTED** descending into a
/// `PropertyAccessExpression` callee's own `.name` identifier here (the
/// task brief's own suggested "descend to the callee's name identifier for
/// member calls" fix), to give member-dispatch calls the same batched
/// direct-symbol-lookup shortcut plain-identifier calls already get. A live
/// regression against the REAL tsgo binary caught this immediately:
/// `pascal_case_owner_file_single_site_does_not_produce_rpc_error`
/// (`tests/rpc_error_repro.rs`) started failing with the EXACT diagnosed
/// "node handle ... could not be resolved (file may not be loaded or handle
/// may be stale)" error on `[1, 2].map((n) => n)` — a completely ordinary
/// member call this pass already resolves correctly today via
/// `getResolvedSignature` alone. This is not a chunking/batching artifact
/// (the batch here has exactly one location): tsgo's own
/// `getSymbolsAtLocations` genuinely cannot resolve a handle for a
/// property-access NAME node at all, while `getResolvedSignature` (which
/// performs real type inference — the only path this crate already sends a
/// member call through) handles the identical call correctly. Sending
/// property-name handles into `fetch_symbols_chunked` would therefore
/// convert this pass's single LARGEST call-site shape (member dispatch,
/// P1-D-d's own finding) into a new, systematic `rpc_error` source, not a
/// fix — the opposite of this task's own target. Left unchanged: member/
/// element-access callees still resolve via `getResolvedSignature` only.
fn callee_identifier(file: &RemoteSourceFile, call_index: usize) -> Option<usize> {
    let callee = *file.children(call_index).first()?;
    (file.kind(callee) == syntax_kind::IDENTIFIER).then_some(callee)
}

/// A heritage pending site's span already bounds one listed type's own
/// expression (an `ExpressionWithTypeArguments`'s `expression`, not the
/// type arguments) — see `PendingSite`'s doc comment. `descend_to_span`
/// therefore lands on either the `ExpressionWithTypeArguments` node itself
/// (site span == the whole `Foo<T>`) or already on its `expression` child
/// (site span == just `Foo`); this normalizes both to the expression node,
/// which is what `analyzer.ts`'s `resolvedDeclaration((type).expression)`
/// (`packages/plugin-javascript-typescript/src/analyzer.ts:~1930`) resolves
/// a symbol for.
fn heritage_expression(file: &RemoteSourceFile, descended: usize) -> Option<usize> {
    if file.kind(descended) == syntax_kind::EXPRESSION_WITH_TYPE_ARGUMENTS {
        file.children(descended).first().copied()
    } else {
        Some(descended)
    }
}

// `callee_identifier`/`heritage_expression` compose primitives `node.rs`
// already unit-tests directly (`children`, `kind`, `descend_to_span`); this
// module's own behavioral coverage is the end-to-end oracle test in
// `tests/oracle_resolve.rs`, which needs a real tsgo binary and a real
// checker session to exercise meaningfully.

#[cfg(test)]
mod tests {
    //! Direct, white-box coverage of `fetch_symbols_chunked`'s per-location
    //! retry (P1-D-e's fix for the "stale node handle" RPC error diagnosed
    //! in `docs/evidence/2026-09-04-v4-p1d-e-residual-rpc.md`), against the
    //! REAL tsgo binary (skipped, printing why, when not discoverable —
    //! matching every other real-binary test in this crate). Unlike
    //! `tests/rpc_error_repro.rs` (which drives the public
    //! `ResidualPass`/`ResidualResolver::resolve` surface), these tests
    //! call the private `fetch_symbols_chunked` method directly, so they
    //! can mix ONE deliberately out-of-range `NodeHandle` — confirmed live
    //! (`tests/rpc_error_repro.rs::out_of_range_handle_mixed_into_a_batch`)
    //! to reproduce the EXACT diagnosed error text — into an otherwise
    //! entirely valid batch and assert the fallback isolates it correctly.

    use super::*;
    use crate::binary;
    use crate::client::TsgoClient;
    use crate::proto::UpdateSnapshotParams;
    use crate::virtual_fs::MapFs;
    use std::path::{Path, PathBuf};

    fn repo_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .canonicalize()
            .expect("repo root should exist")
    }

    const ROOT: &str = "/workspace";
    const CONFIG_PATH: &str = "/workspace/__resolver_unit_test__.json";
    const FIXTURE_TEXT: &str =
        "export const alpha = 1;\nexport const beta = 2;\nexport const gamma = 3;\n";

    fn find_utf16_span(text: &str, needle: &str) -> (i32, i32) {
        let byte_start = text.find(needle).expect("needle should be in text");
        let utf16_start = text[..byte_start].encode_utf16().count() as i32;
        let utf16_len = needle.encode_utf16().count() as i32;
        (utf16_start, utf16_start + utf16_len)
    }

    /// Everything a test needs to build `NodeHandle`s against real, decoded
    /// node indices: a spawned client with one owner file (three top-level
    /// `const`s) and an already-open project/snapshot.
    struct Fixture {
        client: TsgoClient,
        snapshot: u64,
        project: String,
        owner: String,
        owner_text: Arc<Vec<u16>>,
    }

    fn spawn_fixture() -> Fixture {
        let tsgo = binary::discover_for_tests(&repo_root());
        let owner = format!("{ROOT}/a.ts");
        let text = FIXTURE_TEXT;
        let config_json = serde_json::json!({
            "compilerOptions": {
                "module": "ESNext",
                "moduleResolution": "Bundler",
                "target": "ES2022",
                "strict": false,
                "skipLibCheck": true,
            },
            "files": [owner.clone()],
        })
        .to_string();
        let mut fs = MapFs::new();
        fs.insert(owner.clone(), text);
        fs.insert(format!("{ROOT}/package.json"), r#"{"type":"module"}"#);
        fs.insert(CONFIG_PATH, config_json);
        let fs: Arc<dyn VirtualFs> = Arc::new(fs);

        let mut client = TsgoClient::spawn(&tsgo, ROOT, fs).expect("tsgo should spawn");
        client.initialize().expect("tsgo should initialize");
        let params = UpdateSnapshotParams {
            open_projects: vec![CONFIG_PATH.to_string()],
            ..Default::default()
        };
        let snapshot = client
            .update_snapshot(&params)
            .expect("updateSnapshot should succeed");
        let project = snapshot
            .projects
            .iter()
            .find(|p| p.config_file_name == CONFIG_PATH)
            .expect("the fixture's own project should be present")
            .id
            .clone();
        let owner_text = Arc::new(to_utf16(text));
        Fixture {
            client,
            snapshot: snapshot.snapshot,
            project,
            owner,
            owner_text,
        }
    }

    #[test]
    #[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]
    fn fetch_symbols_chunked_isolates_one_bad_handle_from_many_good_ones() {
        let Fixture {
            client,
            snapshot,
            project,
            owner,
            owner_text,
        } = spawn_fixture();
        let source = client
            .get_source_file(snapshot, &project, &owner)
            .expect("getSourceFile should succeed")
            .expect("owner should be part of the project");

        let mut cursor = vec![1usize];
        let good_handles: Vec<Option<NodeHandle>> = ["alpha", "beta", "gamma"]
            .iter()
            .map(|name| {
                let (start, end) = find_utf16_span(FIXTURE_TEXT, name);
                let index = source.descend_to_span(&mut cursor, &owner_text, start, end);
                Some(NodeHandle::new(
                    index as u32,
                    source.kind(index),
                    owner.clone(),
                ))
            })
            .collect();
        // One fabricated, out-of-range handle inserted in the MIDDLE of an
        // otherwise all-good batch — confirmed live to reproduce the exact
        // diagnosed "node handle ... could not be resolved (file may not be
        // loaded or handle may be stale)" tsgo RPC error.
        let mut handles = good_handles.clone();
        handles.insert(
            1,
            Some(NodeHandle::new(
                999_999,
                syntax_kind::IDENTIFIER,
                owner.clone(),
            )),
        );

        let resolver = ResidualResolver::new(&client, Arc::new(MapFs::new()), snapshot, project);
        let (symbols, errors) = resolver.fetch_symbols_chunked(&handles);

        assert_eq!(symbols.len(), 4);
        assert_eq!(errors.len(), 4);

        // Every GOOD handle still resolved to a real symbol, despite being
        // batched alongside the bad one.
        assert!(symbols[0].is_some(), "handle for `a` should still resolve");
        assert!(symbols[2].is_some(), "handle for `b` should still resolve");
        assert!(symbols[3].is_some(), "handle for `c` should still resolve");
        assert!(errors[0].is_none());
        assert!(errors[2].is_none());
        assert!(errors[3].is_none());

        // The bad handle alone is reported with a real, specific reason —
        // not silently dropped, and not misreported as a generic miss.
        assert!(
            symbols[1].is_none(),
            "the fabricated handle must not resolve to a symbol"
        );
        let error = errors[1]
            .as_ref()
            .expect("the fabricated handle should carry its own rpc-error reason");
        assert!(
            error.contains("getSymbolsAtLocations failed"),
            "expected an rpc-error reason, got: {error}"
        );
        assert!(
            error.contains("could not be resolved") || error.contains("stale"),
            "expected the real tsgo stale-handle error text, got: {error}"
        );

        let _ = client.shutdown();
    }

    #[test]
    #[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]
    fn fetch_symbols_chunked_all_good_handles_need_no_fallback() {
        let Fixture {
            client,
            snapshot,
            project,
            owner,
            owner_text,
        } = spawn_fixture();
        let source = client
            .get_source_file(snapshot, &project, &owner)
            .expect("getSourceFile should succeed")
            .expect("owner should be part of the project");
        let mut cursor = vec![1usize];
        let (start, end) = find_utf16_span(FIXTURE_TEXT, "alpha");
        let index = source.descend_to_span(&mut cursor, &owner_text, start, end);
        let handles = vec![Some(NodeHandle::new(
            index as u32,
            source.kind(index),
            owner.clone(),
        ))];

        let resolver = ResidualResolver::new(&client, Arc::new(MapFs::new()), snapshot, project);
        let (symbols, errors) = resolver.fetch_symbols_chunked(&handles);
        assert_eq!(symbols.len(), 1);
        assert!(symbols[0].is_some());
        assert!(errors[0].is_none());

        let _ = client.shutdown();
    }
}
