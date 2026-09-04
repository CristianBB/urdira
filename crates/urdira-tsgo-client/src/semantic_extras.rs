//! Task P1-D "inferred types + compiler diagnostics" half of decision 28's
//! residual tsgo pass (`docs/decisions/28-v4-rust-semantics-and-residual-
//! checker.md`, "Task: produce inferred types, type_of relations and
//! compiler diagnostics from the residual tsgo pass"). Reproduces
//! `packages/plugin-javascript-typescript/src/analyzer.ts`'s exported-
//! declaration typing (`typeOf`/`isExported`, ~1151-1213/1690-1734) and its
//! three-source diagnostic concatenation (`getSyntacticDiagnostics`/
//! `getBindDiagnostics`/`getSemanticDiagnostics`, ~1399-1411) against the
//! async tsgo API, for one owner file at a time within an already-open
//! window/snapshot -- called from `crate::residual_pass::run_lane` right
//! after that window's call/heritage resolution, on the SAME snapshot (see
//! that module's own doc comment for why: "same tsgo snapshot, same upgrade
//! generation, same publish" is the task brief's own requirement).
//!
//! # Scope narrowed from `analyzer.ts`
//!
//! v3 determines "exported" from a `Set<Node>` built once per file
//! (`checker.getExportsOfModule(moduleSymbol).flatMap(s => s.declarations)`,
//! resolved back to AST nodes) and then, while walking the FULL file tree,
//! treats a node as exported if the node itself or its immediate PARENT is
//! in that set -- which in practice means "top-level exported declarations"
//! plus "every direct child of an exported class/interface" (a member's
//! `.parent` IS the class/interface declaration node in the TS AST, no
//! intervening "class body" node). This module reproduces exactly those two
//! cases directly from the declaration handles `getExportsOfModule` returns,
//! WITHOUT a full-file tree walk:
//! - a handle whose own path is NOT this owner is skipped (a pure
//!   re-export -- `export {x} from './other'` -- has no LOCAL declaration
//!   node in THIS file; `other.ts` types `x` itself when IT is processed,
//!   provided `x` is ALSO directly exported from `other.ts`'s own module
//!   symbol -- exactly mirroring `analyzer.ts`'s own per-file walk scoping,
//!   since a cross-file declaration node is never part of the CURRENT
//!   file's AST walk there either).
//! - a `ClassDeclaration`/`InterfaceDeclaration` handle additionally yields
//!   every direct child matching a member `SyntaxKind` (method/constructor/
//!   getter/setter/property/method signature/property signature).
//!
//! **Known, documented gaps** (not silently diverged from v3, simply not
//! reproduced this session): a namespace's own exported members (v3's
//! `exportedDeclarations` is built from the FILE's module symbol only, same
//! restriction here); a destructured export binding (`export const {a, b} =
//! obj`, whose declaration handle is the `BindingElement`, not something
//! this module's member-kind set recognizes at the top level -- `analyzer.
//! ts`'s own `nameOf`/`addEntity` handle this via the general AST walk this
//! module does not perform). Both are narrow relative to a typical corpus's
//! dominant shapes (top-level function/class/interface/type/enum/variable
//! plus ordinary class/interface members).

use std::collections::HashSet;

use crate::client::TsgoClient;
use crate::node::{NodeHandle, RemoteSourceFile, syntax_kind};
use crate::proto::TypeResponse;

/// Maximum locations per `getTypeAtLocations` call, mirroring `crate::
/// resolver::MAX_LOCATIONS_PER_CALL`'s own rationale (P1-D-e: a single bad
/// `NodeHandle` in a batched request poisons the whole batch; chunking
/// bounds the blast radius and `fetch_types_chunked`'s per-location retry on
/// a failed chunk recovers every OTHER location in it).
const MAX_LOCATIONS_PER_CALL: usize = 2000;

/// One exported (or exported-class/interface-member) declaration this
/// module found a checker type for -- `analyzer.ts`'s `typeOf(node)` result
/// for that declaration node, plus enough position/kind information for the
/// caller to build the matching entity identity (`(path, name_start)`, the
/// same anchor `crate::resolver::ResolvedDeclaration` uses).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypedDeclarationSite {
    pub name_start_utf16: i32,
    pub decl_start: i32,
    pub decl_end: i32,
    /// The declaration node's own `SyntaxKind` (`crate::node::syntax_kind`)
    /// -- lets the caller reuse the identical member-kind-name mapping
    /// `crate::residual_pass::SiteOutcome::WorkspaceTarget::kind_hint`
    /// already uses for a call/heritage target, for a member entity this
    /// pass may need to synthesize.
    pub decl_kind: u32,
    /// `checker.typeToString(checker.getTypeAtLocation(node), node)`'s own
    /// result -- raw, unbounded, exactly as the checker returned it (no
    /// truncation applied here; a caller building a record body decides its
    /// own bounding policy, matching v3's own `typeOf` which applies none).
    pub type_text: String,
    /// `analyzer.ts`'s own `entity.qualified_name ?? entity.name` for this
    /// declaration -- a bare identifier (`"add"`) for a top-level
    /// declaration, or `"{ContainerName}.{memberName}"` (no path prefix,
    /// matching `addEntity`'s `${parent.qualified_name ?? parent.name}.
    /// ${name}` — the class/interface is itself top-level, so its OWN
    /// `qualified_name` is always absent, leaving just its bare name) for a
    /// class/interface member. Used verbatim as the `${...}` in
    /// `semanticTypeRecords`'s `name: "inferred type of ${...}"` body field
    /// — computed here (not reconstructed later from an identity string)
    /// because this module already has the owner file's decoded AST and
    /// text on hand.
    pub display_name: String,
}

/// One compiler diagnostic reported for an owner file -- the `Diagnostic`
/// shape `getSyntacticDiagnostics`/`getBindDiagnostics`/
/// `getSemanticDiagnostics` return, already filtered to the queried file
/// (see `fetch_owner_diagnostics`'s own doc comment on why that filter is
/// defensive, matching `analyzer.ts`'s identical comment at its own
/// per-file diagnostic loop).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiagnosticSite {
    pub compiler_code: u32,
    pub message: String,
    pub start: i32,
    pub end: i32,
}

fn is_member_kind(kind: u32) -> bool {
    matches!(
        kind,
        syntax_kind::METHOD_DECLARATION
            | syntax_kind::CONSTRUCTOR
            | syntax_kind::GET_ACCESSOR
            | syntax_kind::SET_ACCESSOR
            | syntax_kind::PROPERTY_DECLARATION
            | syntax_kind::METHOD_SIGNATURE
            | syntax_kind::PROPERTY_SIGNATURE
    )
}

/// Every node index in `owner_file` this module considers a typing
/// candidate: `owner_path`'s own top-level exported declarations (via
/// `getSymbolAtLocation` on the source file's own node, then
/// `getExportsOfModule` on the resulting module symbol -- `analyzer.ts`'s
/// own `checker.getSymbolAtLocation(source)` +
/// `checker.getExportsOfModule(moduleSymbol)`), plus every direct
/// class/interface member child of an exported class/interface declaration
/// (see this module's own doc comment). Best-effort: a script file with no
/// module symbol, or an `getExportsOfModule` RPC failure, yields an empty
/// list -- mirroring `analyzer.ts`'s own `try {...} catch { /* a script
/// without a module symbol has no exported type facts */ }`.
/// `(node_index, container_index)` — `container_index` is `Some` for a
/// class/interface member (the enclosing class/interface declaration's own
/// node index, needed to build `TypedDeclarationSite::display_name`'s
/// `"{ContainerName}.{memberName}"` form) and `None` for a top-level
/// declaration.
fn exported_declaration_indices(
    client: &TsgoClient,
    snapshot: u64,
    project: &str,
    owner_path: &str,
    owner_file: &RemoteSourceFile,
) -> Vec<(usize, Option<usize>)> {
    let module_symbol = match client.get_symbol_at_location(
        snapshot,
        project,
        &NodeHandle::new(1, syntax_kind::SOURCE_FILE, owner_path),
    ) {
        Ok(Some(symbol)) => symbol,
        _ => return Vec::new(),
    };
    let exports = match client.get_exports_of_module(snapshot, project, module_symbol.id) {
        Ok(exports) => exports,
        Err(_) => return Vec::new(),
    };

    let mut seen: HashSet<usize> = HashSet::new();
    let mut indices = Vec::new();
    for symbol in exports {
        let Some(handle_str) = symbol
            .value_declaration
            .clone()
            .or_else(|| symbol.declarations.first().cloned())
        else {
            continue;
        };
        let Some(handle) = NodeHandle::parse(&handle_str) else {
            continue;
        };
        // A pure re-export's declaration lives in ANOTHER file -- see this
        // module's doc comment for why that is correctly typed when the
        // OTHER file is itself processed, not here.
        if handle.path != owner_path {
            continue;
        }
        let index = handle.index as usize;
        if index >= owner_file.node_count() || !seen.insert(index) {
            continue;
        }
        indices.push((index, None));
        if matches!(
            owner_file.kind(index),
            syntax_kind::CLASS_DECLARATION | syntax_kind::INTERFACE_DECLARATION
        ) {
            for child in owner_file.children(index) {
                if is_member_kind(owner_file.kind(child)) && seen.insert(child) {
                    indices.push((child, Some(index)));
                }
            }
        }
    }
    indices
}

/// Reads the identifier text of the node at `index` — `"constructor"` for a
/// `Constructor` declaration (matching `analyzer.ts`'s own `nameOf`
/// special-case: a `ConstructorDeclaration` has no `.name` node at all), the
/// first identifier child's text otherwise, or `""` if neither is available
/// (not observed in practice for any of the declaration shapes this module
/// walks — a top-level exported declaration or class/interface member
/// always has a name).
fn declaration_name(owner_file: &RemoteSourceFile, index: usize, owner_text: &[u16]) -> String {
    if owner_file.kind(index) == syntax_kind::CONSTRUCTOR {
        return "constructor".to_string();
    }
    owner_file
        .name_start(index, owner_text)
        .and_then(|start| crate::node::identifier_text_at(owner_text, start))
        .unwrap_or_default()
}

/// Fetches `getTypeAtLocations` for `handles` in chunks of at most
/// [`MAX_LOCATIONS_PER_CALL`], with the identical whole-chunk-fails ->
/// per-location retry fallback `crate::resolver::ResidualResolver::
/// fetch_symbols_chunked` uses for the same "one bad handle poisons the
/// batch" failure mode (P1-D-e).
fn fetch_types_chunked(
    client: &TsgoClient,
    snapshot: u64,
    project: &str,
    handles: &[NodeHandle],
) -> Vec<Option<TypeResponse>> {
    let mut out: Vec<Option<TypeResponse>> = vec![None; handles.len()];
    for (chunk_index, chunk) in handles.chunks(MAX_LOCATIONS_PER_CALL).enumerate() {
        let offset = chunk_index * MAX_LOCATIONS_PER_CALL;
        match client.get_type_at_locations(snapshot, project, chunk) {
            Ok(results) => {
                for (position, result) in results.into_iter().enumerate() {
                    out[offset + position] = result;
                }
            }
            Err(_) => {
                for (position, handle) in chunk.iter().enumerate() {
                    if let Ok(mut results) = client.get_type_at_locations(
                        snapshot,
                        project,
                        std::slice::from_ref(handle),
                    ) {
                        out[offset + position] = results.pop().flatten();
                    }
                }
            }
        }
    }
    out
}

/// Every typed declaration site for `owner_path`, on the given snapshot.
/// `owner_text` is `owner_path`'s own UTF-16 text (the same buffer the
/// resolver's `descend_to_span` uses -- see `crate::trivia::to_utf16`).
pub fn fetch_exported_types(
    client: &TsgoClient,
    snapshot: u64,
    project: &str,
    owner_path: &str,
    owner_file: &RemoteSourceFile,
    owner_text: &[u16],
) -> Vec<TypedDeclarationSite> {
    let indices = exported_declaration_indices(client, snapshot, project, owner_path, owner_file);
    if indices.is_empty() {
        return Vec::new();
    }
    let handles: Vec<NodeHandle> = indices
        .iter()
        .map(|&(index, _)| NodeHandle::new(index as u32, owner_file.kind(index), owner_path))
        .collect();
    let type_responses = fetch_types_chunked(client, snapshot, project, &handles);

    let mut out = Vec::with_capacity(indices.len());
    for (position, &(index, container_index)) in indices.iter().enumerate() {
        let Some(type_response) = &type_responses[position] else {
            continue;
        };
        let Ok(type_text) = client.type_to_string(
            snapshot,
            project,
            type_response.id,
            Some(&handles[position]),
            None,
        ) else {
            continue;
        };
        let decl_kind = owner_file.kind(index);
        let name_start = if decl_kind == syntax_kind::CONSTRUCTOR {
            owner_file.constructor_keyword_start(index, owner_text)
        } else {
            owner_file
                .name_start(index, owner_text)
                .unwrap_or_else(|| owner_file.node_start(index, owner_text))
        };
        let own_name = declaration_name(owner_file, index, owner_text);
        let display_name = match container_index {
            Some(container) => {
                format!(
                    "{}.{own_name}",
                    declaration_name(owner_file, container, owner_text)
                )
            }
            None => own_name,
        };
        out.push(TypedDeclarationSite {
            name_start_utf16: name_start,
            decl_start: owner_file.node_start(index, owner_text),
            decl_end: owner_file.end(index),
            decl_kind,
            type_text,
            display_name,
        });
    }
    out
}

/// Every compiler diagnostic reported for `owner_path`: the concatenation
/// of `getSyntacticDiagnostics`/`getBindDiagnostics`/`getSemanticDiagnostics`
/// scoped to that one file, matching `analyzer.ts`'s own
/// `[...program.getSyntacticDiagnostics(target),
/// ...program.getBindDiagnostics(target),
/// ...program.getSemanticDiagnostics(target)]` (~1401). The `fileName`
/// equality filter below is the SAME defensive no-op `analyzer.ts`'s own
/// comment describes ("Per-file diagnostic calls should only ever report on
/// the queried file itself... also guards against any diagnostic
/// misattribution ever silently corrupting ANOTHER file's memo entry").
/// A single RPC failure for one of the three sources is skipped rather than
/// aborting the other two (best-effort, matching this pass's general "never
/// let one bad site take down the rest" posture).
pub fn fetch_owner_diagnostics(
    client: &TsgoClient,
    snapshot: u64,
    project: &str,
    owner_path: &str,
) -> Vec<DiagnosticSite> {
    let mut out = Vec::new();
    let batches = [
        client.get_syntactic_diagnostics(snapshot, project, Some(owner_path)),
        client.get_bind_diagnostics(snapshot, project, Some(owner_path)),
        client.get_semantic_diagnostics(snapshot, project, Some(owner_path)),
    ];
    for batch in batches {
        let Ok(diagnostics) = batch else { continue };
        for diagnostic in diagnostics {
            if diagnostic.file_name.as_deref() != Some(owner_path) {
                continue;
            }
            out.push(DiagnosticSite {
                compiler_code: diagnostic.code,
                message: diagnostic.text,
                start: diagnostic.pos,
                end: diagnostic.end,
            });
        }
    }
    out
}
