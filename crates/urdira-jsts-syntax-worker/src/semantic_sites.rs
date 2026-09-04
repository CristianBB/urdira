//! Intra-file semantic reference resolution (design stage E1a of the F5
//! hybrid lane; see `docs/evidence/2026-09-01-f5-hybrid-design.md`).
//!
//! This module runs `oxc_semantic`'s `SemanticBuilder` on an already-parsed
//! owner file and produces two things per the design's contract:
//!
//! 1. `reference_rows` — `core:references` proposed records for identifier
//!    references that Rust can resolve *lexically*, with zero doubt: a plain
//!    `IdentifierReference` whose oxc-resolved symbol has exactly one
//!    declaration, is not import-bound, and matches one of the identity
//!    kinds `analyzer.ts`'s `rustSemanticDeclarationShape` recognizes
//!    (function/class/interface/type/enum/namespace/variable/parameter --
//!    the only kinds that can ever be referenced by a bare identifier;
//!    method/constructor/getter/setter/property are always reached through
//!    member access and therefore never a resolvable *target* here, though
//!    they can be a reference's *owner*).
//! 2. `pending_sites` — every other semantic site the walk encountered
//!    (member access, `this`, calls, heritage, multi-declaration symbols,
//!    import-bound symbols, unresolved globals, ...), each carrying a
//!    `reason` so the checker-backed walk in a later sub-stage can descend
//!    straight to just those spans instead of re-walking the whole file.
//!
//! The golden rule (from the design doc): Rust only asserts what it can
//! prove lexically; every doubt goes to the checker.
//!
//! Identity: entity ids use the E0-unified convention
//! `jsts:{kind}:{path}:{nameIdentifierStart}:{name}`, UTF-16 offsets
//! (`Utf8ToUtf16` is applied before semantic analysis, so every span read
//! from the built `Semantic` -- symbol spans, reference spans, node spans
//! -- is already UTF-16). Reference row identity mirrors
//! `push_relation`/`relate` byte for byte:
//! `jsts:references:{path}:{start}:{end}:{sourceId}:{targetId}`.

use crate::resolver::{self, WorkspaceResolver};
use crate::{
    AnalysisError, ErrorCode, ProposedRecord, SyntaxFileResult, bounded_sha256_identity,
    canonical_evidence, canonical_json, canonical_span, facets_list_from_value,
    proposal_record_key,
};
use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast::Comment;
use oxc_ast::ast::{
    ArrowFunctionExpression, BindingPattern, CallExpression, CatchParameter, ChainElement, Class,
    ClassType, ComputedMemberExpression, ExportNamedDeclaration, ExportSpecifier, Expression,
    FormalParameter, FormalParameterRest, Function, FunctionType, IdentifierReference,
    ImportDeclaration, ImportDefaultSpecifier, ImportExpression, ImportNamespaceSpecifier,
    ImportOrExportKind, ImportSpecifier, MethodDefinition, MethodDefinitionKind, ModuleExportName,
    ObjectPattern, ObjectProperty, PropertyDefinition, PropertyKey, PropertyKind,
    StaticMemberExpression, TSEnumDeclaration, TSInterfaceDeclaration, TSMethodSignature,
    TSMethodSignatureKind, TSModuleDeclaration, TSQualifiedName, TSSignature, TSType,
    TSTypeAliasDeclaration, TSTypeAnnotation, TSTypeName, TSTypePredicate, TSTypePredicateName,
    TSTypeQueryExprName, ThisExpression, VariableDeclaration, VariableDeclarator,
};
use oxc_ast_visit::{
    Visit,
    utf8_to_utf16::Utf8ToUtf16,
    walk::{
        walk_arrow_function_expression, walk_call_expression, walk_catch_parameter, walk_class,
        walk_export_named_declaration, walk_export_specifier, walk_formal_parameter,
        walk_formal_parameter_rest, walk_function, walk_import_declaration,
        walk_import_default_specifier, walk_import_expression, walk_import_namespace_specifier,
        walk_import_specifier, walk_object_property, walk_property_definition,
        walk_static_member_expression, walk_ts_enum_declaration, walk_ts_interface_declaration,
        walk_ts_method_signature, walk_ts_module_declaration, walk_ts_qualified_name,
        walk_ts_type_alias_declaration, walk_ts_type_predicate, walk_variable_declarator,
    },
};
use oxc_parser::Parser;
use oxc_semantic::{AstNodes, Scoping, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, SourceType};
use oxc_syntax::scope::ScopeFlags;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// Output of [`analyze_owner_semantics`], handed off to the (future) E1b
/// orchestrator in `urdira-indexing-worker`'s `process_owner`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OwnerSemantics {
    /// `core:references` proposed records Rust resolved with certainty.
    pub reference_rows: Vec<ProposedRecord>,
    /// `core:covers` proposed records synthesized alongside `reference_rows`
    /// (test-coverage derivation parity with `analyzer.ts`'s
    /// `assembleAnalysis`, F5 hybrid gap fix, 2026-09-01): for every
    /// `reference_rows` entry that is BOTH cross-file (`ReferenceRow::
    /// cross_file`) AND owned by a test container (this owner's own module
    /// entity has `is_test: true`, read from the project's lane-1
    /// `SyntaxFileResult` -- see `analyze_owner_semantics_with_context`),
    /// one `testContainer -> target` covers row, built byte-for-byte to the
    /// same id/body shape `assembleAnalysis` produces for the checker-
    /// resolved equivalent (`covers_proposed_record`). Only the OWNER's own
    /// module entity can ever be a test container here: `is_test` is never
    /// set on any other entity kind, in either producer, so `analyzer.ts`'s
    /// walk-up-the-parent-chain `testContainerOf` always bottoms out at the
    /// file's module entity -- see that function's doc for the full
    /// argument. Empty whenever this owner is not itself a test container
    /// (the overwhelmingly common case).
    pub covers_rows: Vec<ProposedRecord>,
    /// `core:call` proposed records for a `CallExpression` whose callee is a
    /// plain identifier resolving, with lexical certainty, to a single
    /// function/class declaration with no overloads and no merging (E3, F5
    /// hybrid design, T1; replicates and widens `directCallDeclaration` in
    /// `packages/plugin-javascript-typescript/src/analyzer.ts` -- see
    /// `resolve_call_target`'s doc comment for the exact contract, including
    /// why a self-referential recursive call is NOT dropped here the way a
    /// self-referential `core:references` row is). Everything else (member/
    /// `this`/`super`/`new`/an expression callee, an overloaded or
    /// unresolved target, a target that is not itself a function/class
    /// declaration) stays `checker_pending` instead, exactly like before E3.
    pub call_rows: Vec<ProposedRecord>,
    /// `core:inherits`/`core:implements` proposed records for a class
    /// `extends`/`implements` clause or an interface `extends` clause whose
    /// type is a plain, non-generic identifier expression resolving, with
    /// lexical certainty, to a single class/interface declaration (E3, F5
    /// hybrid design, T2). Qualified names (`A.B`), generic heritage
    /// (`Base<T>`), and mixin expressions (anything but a bare identifier)
    /// are never even attempted here and stay `checker_pending`.
    pub heritage_rows: Vec<ProposedRecord>,
    /// P0-S2 prototype (typeflow): `core:call` rows resolved through
    /// declared-type member lookup (`ProgramIndex::members`) rather than
    /// E1-E3's plain-identifier resolution -- kept in a SEPARATE bucket from
    /// `call_rows` purely so the orchestrator's census can attribute rows to
    /// the rule that produced them; both merge into the same observation
    /// the same way. Empty whenever `URDIRA_JSTS_TYPEFLOW` is off.
    pub typeflow_call_rows: Vec<ProposedRecord>,
    /// P0-S2 prototype (typeflow): `core:inherits` rows resolved through a
    /// class's own `extends` clause when its type has generic arguments
    /// (erased) -- see `HeritageTarget`'s doc comment in
    /// `urdira-jsts-typeflow` for the exact scope. Empty whenever
    /// `URDIRA_JSTS_TYPEFLOW` is off.
    pub typeflow_heritage_rows: Vec<ProposedRecord>,
    /// P2-2i/A2 (pending.sites migration, 2026-09-04): every no-target
    /// call/heritage site the E1a-E3 hybrid lane and typeflow could not
    /// resolve -- v3's checker-backed `relate()` always publishes a
    /// `classification: "possible"` `core:call`/`core:inherits`/
    /// `core:implements` row with no `target_id` for such a site; v4 used
    /// to mirror that shape as a full `ProposedRecord` too (2026-09-04's
    /// P2-2i), but the store's own `pending.sites` side table (`urdira-
    /// structural-store`'s `PendingSiteRow`) now carries this population
    /// instead: a compact, non-record row the residual tsgo pass consumes
    /// directly (`crate::v4::residual::collect`, in the indexing-worker
    /// crate), so the RECORDS table (and every root/count derived from it)
    /// carries no relation row without a `target_id` any more. One
    /// [`PendingSiteProposal`] per pending call site (`reason` as-is, from
    /// `PendingCallSite`) or pending heritage site (`reason` from
    /// `PendingHeritageSite`, reinstated for this migration -- see that
    /// struct's own doc comment). Excludes an anonymous class's heritage
    /// clause (no `source_id` to attribute it to -- `finish_heritage_
    /// clause`'s doc comment), same gap v3's own `entityForDeclaration`
    /// would hit: that site simply stays in `pending_sites` (the checker-
    /// dispatch listing) with no proposal here either. Empty whenever this
    /// owner had no pending call/heritage site.
    pub pending_site_rows: Vec<PendingSiteProposal>,
    /// P2-2j: one per-candidate `possible` `core:call` row -- carrying a
    /// REAL `target_id`, unlike a plain no-target `pending_site_rows` entry
    /// -- for a call site whose typeflow receiver resolved to MULTIPLE
    /// plausible declarations (an overloaded member, `urdira_jsts_typeflow::
    /// MemberLookup::Many`, reason `overload_ambiguous`; or a union-typed
    /// receiver, `MemberLookup::UnionCandidates`, reason `union_ambiguous`).
    /// These are the ONLY `possible` rows the query engine can actually
    /// traverse (`core:find_references`/`core:find_paths`/`core:expand_
    /// relations` return a `possible` row classified only when it carries a
    /// `target_id` -- a no-target possible row is query-invisible, and since
    /// A2 there is no such RECORD any more at all: it is a `pending.sites`
    /// row instead). The SAME site ALSO still contributes its ordinary
    /// no-target entry to `pending_site_rows` (now with the candidate
    /// reason) AND stays a `pending_sites` entry, so a later residual tsgo
    /// pass can upgrade it
    /// to one CONFIRMED row -- see `CandidateCallRow`'s own doc comment for
    /// why both rows coexist. **Never** produces a `classification:
    /// "confirmed"` row: a union/overload receiver is a genuine ambiguity
    /// in this round, never promoted to a single target even when every
    /// candidate agrees (this crate's zero-wrong-target discipline). Empty
    /// in oracle mode (`URDIRA_JSTS_TYPEFLOW_ORACLE=1` folds a `Candidates`
    /// outcome into the same plain-pending path `Unresolved` already takes,
    /// deliberately -- see `visit_call_expression`'s own doc comment).
    pub candidate_call_rows: Vec<ProposedRecord>,
    /// Parameter entities, "referenced-only" variant (owner-approved,
    /// 2026-09-04): one `jsts:entity_parameter` `ProposedRecord` per
    /// identifier-pattern parameter declaration that received AT LEAST ONE
    /// resolved `reference_rows` entry whose target is that parameter
    /// (`DeclKind::Parameter`, `resolve_identifier_reference`) -- NOT every
    /// parameter, unlike every other entity producer. Destructured/rest
    /// parameters are never candidates (`classify_symbol_declaration`
    /// already never resolves a reference to one). `id` is byte-identical to
    /// the `target_id` `reference_rows` already carries for it (`jsts:
    /// parameter:{path}:{nameStart}:{name}`), so materializing this record
    /// makes that reference's `target_subject` intern where before it
    /// dangled. See `ParameterDeclarationFact`/`ParamOwner` (this module) for
    /// how the declaration facts (span, enclosing entity) are captured
    /// independently of whether the parameter turns out referenced, and
    /// `parameter_entity_record`'s own doc comment for the `parent_id`
    /// resolution rule (function declaration / class-or-interface member
    /// entity emitted today / variable-bound arrow-or-function-expression /
    /// module fallback).
    pub parameter_entity_rows: Vec<ProposedRecord>,
    /// One `core:contains` `ProposedRecord` per `parameter_entity_rows`
    /// entry, parent (per that entry's own `parent_id` resolution) ->
    /// parameter, in the same order. Kept as a separate bucket purely for
    /// orchestrator-census symmetry with `parameter_entity_rows`, same
    /// reasoning as `typeflow_call_rows`/`typeflow_heritage_rows` being
    /// split from `call_rows`/`heritage_rows`.
    pub parameter_contains_rows: Vec<ProposedRecord>,
    /// External package/symbol entities task (2026-09-04): one `jsts:
    /// external_module`/`jsts:external_symbol` `ProposedRecord` per DISTINCT
    /// external identity this owner's import/re-export/namespace-member
    /// bindings resolved to (deduped within this owner -- see `SemanticWalker
    /// ::finish`'s own conversion loop; the CROSS-owner case is handled by
    /// `urdira-indexing-worker::v4::analyze::run_scoped`). See `docs/
    /// evidence/2026-09-04-v4-external-entities.md`.
    pub external_entity_rows: Vec<ProposedRecord>,
    /// One `core:contains` `ProposedRecord` per external binding/member-read
    /// OCCURRENCE (module -> symbol), NOT deduped the way `external_entity_
    /// rows` is -- a relation's identity already varies per occurrence
    /// (`(path, start, end, source_id, target_id)`), same precedent as
    /// `core:import`/`core:call` rows.
    pub external_contains_rows: Vec<ProposedRecord>,
    /// P0-S2 prototype (typeflow), `URDIRA_JSTS_TYPEFLOW_ORACLE=1` only:
    /// every site typeflow resolved WITHOUT removing it from
    /// `pending_sites`, so the orchestrator can compare typeflow's guess
    /// against the checker's own independent resolution of the same site.
    /// Always empty when oracle mode is off (including when typeflow itself
    /// is off).
    pub typeflow_oracle_hits: Vec<TypeflowOracleHit>,
    /// P1-A, `URDIRA_JSTS_TYPEFLOW_ORACLE=1` only (diagnostic): the receiver-
    /// expression SHAPE of every call site that stayed pending with
    /// `call_deferred_to_e3` (a non-identifier callee), regardless of
    /// whether typeflow itself resolved it -- lets the census classifier
    /// (`urdira-indexing-worker`'s `census_typeflow_owner`) break the
    /// `checker_confirmed_rust_pending` bucket down by shape (`this_return`
    /// chains, `chained_member_of_call`, an untyped local, ...). Always
    /// empty when oracle mode is off.
    pub typeflow_pending_call_shapes: Vec<TypeflowPendingShape>,
    /// Every semantic site the checker still needs to look at, with a reason.
    pub pending_sites: Vec<SemanticSite>,
    /// Stable sha256 digest of the *full* candidate site listing (both
    /// dispositions), for determinism receipts across runs.
    pub sites_digest: String,
    /// Safe-partition rule (coordinator directive, 2026-09-01; see
    /// `is_jsdoc_typed_file`): true when this owner's whole-file identifier
    /// resolution must stay with the checker. `pending_sites` alone cannot
    /// carry this owner's JSDoc-embedded type references at all -- oxc never
    /// materializes JSDoc comment content as AST nodes, so there is no node
    /// to site in the first place -- so the orchestrator (E1b/E1c,
    /// `urdira-indexing-worker`) must read this flag and NOT hand
    /// `pending_sites` to the checker-backed walk for this owner: an absent
    /// `rust_hybrid_pending_sites` on the wire is exactly the signal
    /// `walkRustSemanticOwner`/`beginRustSemanticOwnerGroup` already treat as
    /// "do the full, un-cut-over walk for this one".
    pub jsdoc_typed_file: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum SiteKind {
    IdentifierRef,
    Call,
    Heritage,
    TypedDecl,
}

impl SiteKind {
    const fn identity_name(self) -> &'static str {
        match self {
            Self::IdentifierRef => "identifier_ref",
            Self::Call => "call",
            Self::Heritage => "heritage",
            Self::TypedDecl => "typed_decl",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum SiteDisposition {
    RustResolved,
    CheckerPending,
}

impl SiteDisposition {
    const fn identity_name(self) -> &'static str {
        match self {
            Self::RustResolved => "rust_resolved",
            Self::CheckerPending => "checker_pending",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct SemanticSite {
    pub start_utf16: u32,
    pub end_utf16: u32,
    pub site_kind: SiteKind,
    pub disposition: SiteDisposition,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Kind of an unresolved call/heritage site awaiting the residual pass --
/// this crate's own copy of `urdira_structural_store::row::PENDING_SITE_
/// KIND_*` (that crate is not a dependency of this one; `crate::v4::
/// materialize`, in `urdira-indexing-worker`, is the single place that maps
/// this to the store's numeric constant).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PendingSiteKind {
    Call,
    Inherits,
    Implements,
}

/// One no-target call/heritage site the E1a-E3 hybrid lane and typeflow
/// could not resolve -- the store-bound (`urdira_structural_store::row::
/// PendingSiteRow`) counterpart of what used to be a full `possible`
/// `ProposedRecord` with no `target_id` (see `OwnerSemantics::pending_site_
/// rows`'s own doc comment for the full migration rationale). `source_id`
/// is the declaration id text; `crate::v4::materialize` resolves it to a
/// `Dictionaries::subjects` ordinal the SAME way a relation record's own
/// `source_id` resolves (`resolve_subject_key` -> `subjects.intern`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PendingSiteProposal {
    pub start: u32,
    pub end: u32,
    pub site_kind: PendingSiteKind,
    pub reason: &'static str,
    pub source_id: String,
}

/// Stable, append-only numeric reason codes for a `PendingSiteRow.reason`
/// byte (`urdira_structural_store::row::PendingSiteRow`'s `reason` field --
/// an opaque `u8` the store itself never interprets, per that struct's own
/// doc comment). **ON-DISK CONTRACT**: once a code is assigned here it is
/// PERMANENT -- a future reason gets the next free number, never a reused
/// or renumbered one. `from_reason` maps an unknown string to `Unspecified`
/// (never panics); `to_reason` is the inverse, for anything that needs to
/// render a code back to text (diagnostics, dumps).
///
/// | code | reason string | producer |
/// |---:|---|---|
/// | 0 | *(unspecified)* | any string this table does not recognize |
/// | 1 | `call_deferred_to_e3` | this crate, `PendingCallSite` |
/// | 2 | `call_target_uncertain` | this crate, `PendingCallSite` |
/// | 3 | `overload_ambiguous` | this crate, `PendingCallSite`/`CandidateCallRow` |
/// | 4 | `union_ambiguous` | this crate, `PendingCallSite`/`CandidateCallRow` |
/// | 5 | `target_not_interned` | `urdira-indexing-worker`'s `v4::materialize` (a confirmed-shaped relation whose target never interned) |
/// | 6 | `heritage_unresolved` | reserved fallback for a heritage site with no more specific reason available (see `PendingSiteProposal`'s own construction site in `finish`) |
/// | 7 | `heritage_deferred_to_e3` | this crate, `PendingHeritageSite` |
/// | 8 | `heritage_target_uncertain` | this crate, `PendingHeritageSite` |
/// | 9 | `heritage_clause_partially_pending` | this crate, `PendingHeritageSite` |
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingReasonCode {
    Unspecified = 0,
    CallDeferredToE3 = 1,
    CallTargetUncertain = 2,
    OverloadAmbiguous = 3,
    UnionAmbiguous = 4,
    TargetNotInterned = 5,
    HeritageUnresolved = 6,
    HeritageDeferredToE3 = 7,
    HeritageTargetUncertain = 8,
    HeritageClausePartiallyPending = 9,
}

impl PendingReasonCode {
    pub fn from_reason(reason: &str) -> u8 {
        let code = match reason {
            REASON_CALL_DEFERRED => Self::CallDeferredToE3,
            REASON_CALL_TARGET_UNCERTAIN => Self::CallTargetUncertain,
            REASON_OVERLOAD_AMBIGUOUS => Self::OverloadAmbiguous,
            REASON_UNION_AMBIGUOUS => Self::UnionAmbiguous,
            REASON_TARGET_NOT_INTERNED => Self::TargetNotInterned,
            REASON_HERITAGE_UNRESOLVED => Self::HeritageUnresolved,
            REASON_HERITAGE_DEFERRED => Self::HeritageDeferredToE3,
            REASON_HERITAGE_TARGET_UNCERTAIN => Self::HeritageTargetUncertain,
            REASON_HERITAGE_CLAUSE_PARTIALLY_PENDING => Self::HeritageClausePartiallyPending,
            _ => Self::Unspecified,
        };
        code as u8
    }

    pub fn to_reason(code: u8) -> &'static str {
        match code {
            1 => REASON_CALL_DEFERRED,
            2 => REASON_CALL_TARGET_UNCERTAIN,
            3 => REASON_OVERLOAD_AMBIGUOUS,
            4 => REASON_UNION_AMBIGUOUS,
            5 => REASON_TARGET_NOT_INTERNED,
            6 => REASON_HERITAGE_UNRESOLVED,
            7 => REASON_HERITAGE_DEFERRED,
            8 => REASON_HERITAGE_TARGET_UNCERTAIN,
            9 => REASON_HERITAGE_CLAUSE_PARTIALLY_PENDING,
            _ => "unspecified",
        }
    }
}

/// One typeflow guess recorded under `URDIRA_JSTS_TYPEFLOW_ORACLE=1` (see
/// `OwnerSemantics::typeflow_oracle_hits`'s doc comment). `edge_kind` is
/// `"call"`, `"inherits"`, or `"implements"` -- matches the `universal_kind`
/// suffix the checker's own equivalent row would carry, so the orchestrator
/// can look up the checker's own row at the same `(start, end)` span for
/// comparison.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TypeflowOracleHit {
    pub start: u32,
    pub end: u32,
    pub edge_kind: &'static str,
    /// Diagnostic (P0-S2, 2026-09-02): which rule produced this guess --
    /// "this", "super", "member_class_static" (a plain identifier
    /// naming the class/interface itself), "member_declared_type" (a
    /// param/variable type annotation), "member_new_expression" (a
    /// `new T()` initializer), or "heritage_generic" (a class's own
    /// `extends` with generic arguments erased).
    pub rule: &'static str,
    pub source_id: String,
    pub target_id: String,
}

/// P1-A census classifier (diagnostic only, `URDIRA_JSTS_TYPEFLOW_ORACLE=1`):
/// one call site's receiver-expression SHAPE, tagged regardless of whether
/// typeflow resolved it -- see `OwnerSemantics::typeflow_pending_call_
/// shapes`'s doc comment and `SemanticWalker::classify_receiver_shape`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TypeflowPendingShape {
    pub start: u32,
    pub end: u32,
    pub shape: &'static str,
}

/// Ambient module resolution task (2026-09-04) follow-up, owner-flagged
/// review: a process-wide counter of every `AmbientResolution::Ambiguous`
/// outcome (`resolve_named_binding_via_specifier`/`resolve_external_
/// namespace_member`) whose specifier WOULD have resolved externally with
/// certainty had no ambient declaration existed for it at all (`resolver::
/// classify_external_specifier(specifier).is_some()`) -- i.e. a reference
/// this task's own fix correctly demotes from "confirmed external" to
/// "pending" (several script-level files declaring the identical specifier,
/// or a bodyless shorthand declaration -- see `resolver::AmbientResolution`'s
/// own doc comment for why neither case may guess). Distinguishes a real,
/// intentional reduction in v4's own confirmed-reference count from a mere
/// external-to-ambient TARGET SWAP (same site, still confirmed, just a
/// different `target_id` -- swaps never touch this counter). `Relaxed`
/// ordering is enough: this is a diagnostic aggregate, not a correctness
/// gate. Read via `ambiguous_ambient_would_be_external_count`, reset via
/// `reset_ambiguous_ambient_would_be_external_count` (both `pub` so the
/// orchestrator, `urdira-indexing-worker::v4::analyze`, can report the
/// total once per scan without this module needing its own "end of scan"
/// hook).
static AMBIGUOUS_AMBIENT_WOULD_BE_EXTERNAL: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// See [`AMBIGUOUS_AMBIENT_WOULD_BE_EXTERNAL`]'s own doc comment.
pub fn ambiguous_ambient_would_be_external_count() -> u64 {
    AMBIGUOUS_AMBIENT_WOULD_BE_EXTERNAL.load(std::sync::atomic::Ordering::Relaxed)
}

/// See [`AMBIGUOUS_AMBIENT_WOULD_BE_EXTERNAL`]'s own doc comment. Call
/// before a scan whose own count is wanted in isolation (this counter is
/// process-wide and otherwise accumulates across every scan in the same
/// process, same as any other process-global diagnostic counter would).
pub fn reset_ambiguous_ambient_would_be_external_count() {
    AMBIGUOUS_AMBIENT_WOULD_BE_EXTERNAL.store(0, std::sync::atomic::Ordering::Relaxed);
}

/// Pending reasons. These are the exhaustive set of reasons E1a can attach
/// to a `checker_pending` site.
const REASON_UNRESOLVED_GLOBAL: &str = "unresolved_global";
const REASON_IMPORT_BINDING: &str = "import_binding";
const REASON_MULTIPLE_DECLARATIONS: &str = "multiple_declarations";
const REASON_UNSUPPORTED_DECLARATION_KIND: &str = "unsupported_declaration_kind";
const REASON_MEMBER_ACCESS: &str = "member_access";

/// 2026-09-05 A5 references-parity task, Paso 0 (diagnosis only): every
/// `Pending` outcome an `IdentifierRef` site can carry stays entirely
/// in-memory -- `n8n_references_parity_debug_dump`'s own doc comment (and
/// `pending_sites`' module doc, point 2) is explicit that this population
/// is NEVER persisted, NEVER sent to tsgo, and dropped for good once
/// `materialize_cold`/`materialize_delta` consume `OwnerFacts` by value. So
/// widening `REASON_IMPORT_BINDING`/`REASON_RE_EXPORT_BINDING`/`REASON_
/// MEMBER_ACCESS`'s own string with a `/`-delimited sub-reason suffix (this
/// module's own diagnostic instrumentation, wired into `resolve_named_
/// binding_via_specifier` and `visit_static_member_expression`) changes
/// NOTHING observable outside this crate's own debug dump/tests: the
/// downstream `reason` string only ever reaches `scripts/v4-references-
/// parity-diff.mjs` (which groups by BOTH the full string and the `/`-
/// prefix, so the existing coarse histogram is unaffected) or this file's
/// own unit tests (updated to match on the `/`-prefix, never the exact
/// string, wherever a sub-reason now applies). `import_binding_sub_reason`
/// covers the six `resolve_named_binding_via_specifier` degrade points the
/// task brief names (`no_specifier`, `unresolved_specifier`, `export:
/// namespace`, `export:ambiguous`, `export:unresolved`, `ambient:
/// ambiguous`); `member_access_sub_reason` covers the receiver-shape
/// classification for a pending member read.
fn import_binding_sub_reason(base: &'static str, sub: &'static str) -> &'static str {
    match (base, sub) {
        (REASON_IMPORT_BINDING, "no_specifier") => "import_binding/no_specifier",
        (REASON_IMPORT_BINDING, "unresolved_specifier") => "import_binding/unresolved_specifier",
        (REASON_IMPORT_BINDING, "export:namespace") => "import_binding/export:namespace",
        (REASON_IMPORT_BINDING, "export:ambiguous") => "import_binding/export:ambiguous",
        (REASON_IMPORT_BINDING, "export:unresolved") => "import_binding/export:unresolved",
        (REASON_IMPORT_BINDING, "ambient:ambiguous") => "import_binding/ambient:ambiguous",
        (REASON_RE_EXPORT_BINDING, "no_specifier") => "re_export_binding/no_specifier",
        (REASON_RE_EXPORT_BINDING, "unresolved_specifier") => {
            "re_export_binding/unresolved_specifier"
        }
        (REASON_RE_EXPORT_BINDING, "export:namespace") => "re_export_binding/export:namespace",
        (REASON_RE_EXPORT_BINDING, "export:ambiguous") => "re_export_binding/export:ambiguous",
        (REASON_RE_EXPORT_BINDING, "export:unresolved") => "re_export_binding/export:unresolved",
        (REASON_RE_EXPORT_BINDING, "ambient:ambiguous") => "re_export_binding/ambient:ambiguous",
        // Any other `(base, sub)` pair is not one of the six named degrade
        // points (should not happen -- every call site below passes a
        // literal from the match arms above) -- fall back to the
        // unsuffixed base reason rather than panic on a diagnostic-only
        // path.
        _ => base,
    }
}
const REASON_THIS_EXPRESSION: &str = "this_expression";
const REASON_CALL_DEFERRED: &str = "call_deferred_to_e3";
const REASON_HERITAGE_DEFERRED: &str = "heritage_deferred_to_e3";
/// E3 (F5 hybrid design, T1): a call's callee IS a plain identifier, but its
/// binding does not lead to a single, non-overloaded function/class
/// declaration Rust can assert with certainty -- an overload set (local
/// `symbol_redeclarations`, or a target module exporting more than one
/// declaration under that name -- `resolve_named_export`'s own `Ambiguous`),
/// declaration merging, an unresolved global, an import Rust's resolver
/// could not close (default/namespace imports included -- see
/// `resolve_call_target`'s doc comment), or a resolved declaration that is
/// neither a function nor a class (e.g. a variable holding a function
/// expression -- deliberately left to the checker's own `getResolvedSignature`
/// fallback per the task's exact scope, "declaración de función/clase").
/// Distinct from `REASON_CALL_DEFERRED` (member/`this`/`super`/`new`/a
/// non-identifier callee expression -- never even attempted here) purely for
/// operator legibility; both dispositions are identical (`checker_pending`)
/// and drive no branching downstream (see `RustHybridPendingSite`'s doc
/// comment in `analyzer.ts`).
const REASON_CALL_TARGET_UNCERTAIN: &str = "call_target_uncertain";
/// E3 (F5 hybrid design, T2): a heritage clause's type IS a plain,
/// non-generic identifier expression, but its binding does not lead to a
/// single class/interface declaration Rust can assert -- the qualified
/// (`A.B`), generic (`Base<T>`), and mixin-expression (anything but a bare
/// identifier) cases never even reach this branch; see
/// `REASON_HERITAGE_DEFERRED`'s sibling reasoning. Same non-branching
/// wire contract as `REASON_CALL_TARGET_UNCERTAIN`.
const REASON_HERITAGE_TARGET_UNCERTAIN: &str = "heritage_target_uncertain";
/// P2-2j: `resolve_call_target_typeflow`'s `StaticMemberExpression` branch
/// resolved the receiver to a SINGLE known entity, but `ProgramIndex::
/// members` found the requested member declared MORE THAN ONCE on that one
/// container (`urdira_jsts_typeflow::MemberLookup::Many` -- TypeScript
/// overload signatures plus their implementation, or any other duplicate
/// declaration this crate does not disambiguate). Distinct from `REASON_
/// UNION_AMBIGUOUS` (a union of DIFFERENT container types, never a single
/// container's own overload set). The site stays `checker_pending` with
/// this reason AND gets one `CandidateCallRow` per overload -- see
/// `OwnerSemantics::candidate_call_rows`'s doc comment.
const REASON_OVERLOAD_AMBIGUOUS: &str = "overload_ambiguous";
/// P2-2j: `resolve_call_target_typeflow`'s `StaticMemberExpression` branch
/// resolved the receiver to a UNION of known entities (`a: A | B; a.run()`)
/// and `ProgramIndex::members_of_union` found at least one candidate on
/// every constituent (`urdira_jsts_typeflow::MemberLookup::UnionCandidates`)
/// -- see `REASON_OVERLOAD_AMBIGUOUS`'s doc comment for how this differs
/// from an overloaded SINGLE container. Never produced for a union where
/// even one constituent lacks the member entirely (that stays plain
/// pending with no candidates -- `MemberLookup::None`, never a guess).
const REASON_UNION_AMBIGUOUS: &str = "union_ambiguous";
/// A2 (pending.sites migration): fallback reason for a `PendingSiteProposal`
/// built from a [`PendingHeritageSite`] whose own `reason` field cannot be
/// recovered for some future reason -- not reached by any code path today
/// (`PendingHeritageSite.reason` is always populated at every one of its
/// three construction sites in `resolve_super_class`/`finish_heritage_
/// clause`, see those functions' own bodies), kept `pub` per [`PendingReasonCode`]'s
/// own reserved-code-6 table entry and as a defensive default for a future
/// heritage construction site that forgets to set `reason`.
pub const REASON_HERITAGE_UNRESOLVED: &str = "heritage_unresolved";
/// A2 (pending.sites migration): the reason `urdira-indexing-worker`'s
/// `v4::materialize` module attaches to a `PendingSiteRow` it synthesizes
/// for a relation record whose identity claimed a resolved target that
/// never interned into `target_subject` (a confirmed-shaped call/heritage
/// row the cold producer could not attach a live entity to -- see
/// `PendingReasonCode`'s own doc table, code 5). This crate never produces
/// this reason itself; the constant lives here so `materialize.rs` does not
/// have to hardcode the string a second time.
pub const REASON_TARGET_NOT_INTERNED: &str = "target_not_interned";
/// Found live against the n8n corpus (E3 gate 3, 2.000-owner determinism
/// run): a multi-type heritage clause (`implements A, B` / `interface I
/// extends A, B`) is ONE syntactic `ts.HeritageClause` node on the checker
/// side with a `types` array covering every listed entry -- see
/// `nearestHeritageClause`'s doc comment in `analyzer.ts`. When even ONE
/// entry in that array is still `checker_pending` (for whatever reason),
/// the checker's site-driven descent locates and re-visits the WHOLE clause
/// node once (by design, so several pending entries collapse onto one
/// `visit()` call) -- and `visit()`'s own `isHeritageClause` branch loops
/// over and re-`relate()`s EVERY entry in `node.types`, not just the one
/// that was pending. If a SIBLING entry in the same clause had already been
/// published as `rust_resolved`, that re-walk re-emits its exact row a
/// second time: an `identity_key` collision (`hybrid semantics double
/// emission detected`) that `merge_hybrid_reference_rows` catches in strict
/// mode. The fix is atomicity: resolution within one multi-type clause is
/// all-or-nothing -- `visit_class`/`visit_ts_interface_declaration` compute
/// every entry's own resolution first, then demote every entry to pending
/// (this reason) unless EVERY entry in the clause resolved. A class's own
/// `extends` (`super_class`) never has siblings (a class can only ever
/// extend one expression), so it is not subject to this rule.
const REASON_HERITAGE_CLAUSE_PARTIALLY_PENDING: &str = "heritage_clause_partially_pending";
const REASON_TYPE_INFERENCE_REQUIRED: &str = "type_inference_required";
/// Coordinator-mandated safe-partition rule (2026-09-01, post-hoc E1c fix):
/// a JS-family file (`.js`/`.jsx`/`.mjs`/`.cjs` -- never `.ts`/`.tsx`, see
/// `is_jsdoc_typed_file`'s doc comment) whose JSDoc comments carry type
/// payload stays ENTIRELY in the checker's domain for identifier references.
/// The checker's `checkJs` pass resolves symbols out of JSDoc tag type
/// expressions (`@param {Foo}`, `@returns {Bar}`, ...) -- text oxc's parser
/// only ever sees as comment trivia, never as AST nodes, so Rust has no way
/// to prove (or even attempt) any of those resolutions. Every identifier
/// site in such a file is forced pending with this reason (see
/// `SemanticWalker::jsdoc_typed_file`) instead of computed normally.
const REASON_JSDOC_TYPED_FILE: &str = "jsdoc_typed_file";
/// Found closing the safe-partition gap's own reconciliation gate: a TS type
/// predicate's parameter name (`value` in `function f(value: unknown): value
/// is Foo`, including its `asserts value is Foo` / bare `asserts value`
/// forms) repeats the parameter's own name in TYPE position specifically so
/// the checker can bind the narrowing back to that parameter -- the checker
/// resolves it exactly like an ordinary reference. oxc models it as
/// `TSTypePredicateName::Identifier(IdentifierName)`, never
/// `IdentifierReference` (see `visit_ts_type_predicate`), so it is invisible
/// to the ordinary `visit_identifier_reference` path and needs its own site.
const REASON_TYPE_PREDICATE_PARAMETER: &str = "type_predicate_parameter";
/// Found alongside `REASON_TYPE_PREDICATE_PARAMETER`, same reconciliation
/// gate: a RE-export specifier's local name (`correctness` in `export {
/// correctness } from "./correctness"`) names a binding that exists only in
/// the OTHER module -- there is nothing local to bind it to, so oxc's parser
/// gives it `ModuleExportName::IdentifierName`, never `IdentifierReference`
/// (unlike a sourceless `export { foo }`, which genuinely does reference a
/// local binding and IS an `IdentifierReference` -- see
/// `visit_export_named_declaration`). The checker still resolves it (through
/// its own module graph, E2's future job in Rust), so it must still be
/// pending, not silently dropped.
const REASON_RE_EXPORT_BINDING: &str = "re_export_binding";

/// JSDoc tag prefixes that carry a type payload the checker can turn into a
/// real symbol resolution. Deliberately over-inclusive ("ante la duda, el
/// archivo entero al checker" -- the coordinator's own conservatism
/// instruction): `@template` has no required `{...}` (a bare `@template T`
/// still introduces a type parameter the checker binds), and `@return` is
/// listed alongside `@returns` since both spellings are accepted JSDoc.
const JSDOC_TYPE_TAG_PATTERNS: &[&str] = &[
    "@typedef",
    "@param {",
    "@returns {",
    "@return {",
    "@type {",
    "@callback",
    "@template",
    "@property {",
    "@augments {",
    "@extends {",
    "@implements {",
    "@satisfies {",
    "@enum {",
    "@this {",
];

/// Whether `path`/`comments` (from the same parse, `comments` still spanned
/// in the ORIGINAL UTF-8 `source_text` -- call this before `Utf8ToUtf16`
/// touches anything) trip the safe-partition rule above.
///
/// Scope is deliberately `.js`/`.jsx`/`.mjs`/`.cjs` only, never
/// `.ts`/`.tsx`/`.mts`/`.cts`: verified empirically (not assumed) that
/// TypeScript's checker does NOT resolve symbols out of JSDoc type tags in a
/// `.ts` file at all -- the real syntax there is always authoritative, so a
/// `@param {Foo}` docblock next to a real `(x: Foo)` parameter is purely
/// decorative and produces zero extra `core:references` rows. Only a
/// `checkJs`-analyzed JS-family file (where JSDoc IS the only type syntax
/// available) exhibits the gap this rule closes.
fn is_jsdoc_typed_file(source_type: SourceType, comments: &[Comment], source_text: &str) -> bool {
    if !source_type.is_javascript() {
        return false;
    }
    comments.iter().any(|comment| {
        if !comment.is_block() {
            return false;
        }
        let text = &source_text[comment.span.start as usize..comment.span.end as usize];
        // TypeScript only treats a block comment as JSDoc when it opens with
        // exactly `/**` (a plain `/* @param {Foo} */` is never JSDoc to the
        // checker either, so it must not trip this rule -- that keeps the
        // rule aligned with what the checker itself actually resolves).
        text.starts_with("/**")
            && JSDOC_TYPE_TAG_PATTERNS
                .iter()
                .any(|pattern| text.contains(pattern))
    })
}

/// The identity kinds a bare identifier can ever resolve to. This mirrors
/// `rustSemanticDeclarationShape` in `analyzer.ts` (function/class/
/// interface/type/enum/namespace/variable/parameter/method/constructor/
/// getter/setter/property); the `method`/`constructor`/`getter`/`setter`/
/// `property` variants are only ever reachable here as an *owner* (they
/// have no oxc symbol table entry, since class members are only ever
/// accessed through a member expression -- Hallazgo B in the design doc).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeclKind {
    Function,
    Class,
    Interface,
    Type,
    Enum,
    Namespace,
    Variable,
    Parameter,
    Method,
    Constructor,
    Getter,
    Setter,
}

impl DeclKind {
    const fn identity_name(self) -> &'static str {
        match self {
            Self::Function => "function",
            Self::Class => "class",
            Self::Interface => "interface",
            Self::Type => "type",
            Self::Enum => "enum",
            Self::Namespace => "namespace",
            Self::Variable => "variable",
            Self::Parameter => "parameter",
            Self::Method => "method",
            Self::Constructor => "constructor",
            Self::Getter => "getter",
            Self::Setter => "setter",
        }
    }
}

fn declaration_id(kind: DeclKind, path: &str, start: u32, name: &str) -> String {
    format!("jsts:{}:{path}:{start}:{name}", kind.identity_name())
}

/// 2026-09-04 references-parity task, bucket 3: `parameters.items`'s own
/// identifier-pattern names, with the binding identifier's own span (`name`,
/// `start`, `end`) -- feeds `predicate_param_stack`. A destructured/rest
/// (`FormalParameters::rest` is a SEPARATE field, never in `items` at all)
/// parameter contributes nothing, matching `classify_symbol_declaration`'s
/// own conservative `None` for those shapes (a type predicate can only ever
/// repeat a SIMPLE parameter's name, per TypeScript's own grammar -- `x is
/// Foo` requires `x` to be an identifier, never a pattern).
fn identifier_pattern_params<'a>(items: &[FormalParameter<'a>]) -> Vec<(String, u32, u32)> {
    items
        .iter()
        .filter_map(|item| match &item.pattern {
            BindingPattern::BindingIdentifier(ident) => Some((
                ident.name.as_str().to_owned(),
                ident.span.start,
                ident.span.end,
            )),
            _ => None,
        })
        .collect()
}

/// The `(start, name)` an identity-bearing `PropertyKey` contributes, when it
/// has one at all -- shared by `visit_method_definition`,
/// `visit_object_property`, and `visit_ts_method_signature`, all of which
/// need to match the checker's own `nameOf` exactly (see each call site's
/// comment for why: `nameOf` reads `.text`/`.escapedText`, which succeeds
/// for a plain identifier, a private identifier -- WITH its "#" reinstated,
/// an ESTree-style bare `PrivateIdentifier.name` never has one -- or any
/// string/numeric literal key, using its exact SOURCE TEXT so a non-
/// canonical numeric spelling (`1.50`, `0x1`) still matches byte for byte).
/// A computed key (`[expr]`) has none of these variants and is intentionally
/// excluded: the checker wraps it as `ComputedPropertyName` even when the
/// inner expression is a static-looking literal, and `nameOf` cannot name
/// that node either.
fn property_key_name<'a>(key: &PropertyKey<'a>) -> Option<(u32, String)> {
    match key {
        PropertyKey::StaticIdentifier(name) => {
            Some((name.span.start, name.name.as_str().to_owned()))
        }
        PropertyKey::PrivateIdentifier(name) => {
            Some((name.span.start, format!("#{}", name.name.as_str())))
        }
        PropertyKey::StringLiteral(literal) => {
            Some((literal.span.start, literal.value.as_str().to_owned()))
        }
        PropertyKey::NumericLiteral(literal) => Some((
            literal.span.start,
            literal
                .raw
                .as_ref()
                .map(|raw| raw.as_str().to_owned())
                .unwrap_or_else(|| literal.value.to_string()),
        )),
        _ => None,
    }
}

/// P2-2j: whether `ty` is one of the constituent shapes a union receiver
/// drops silently rather than treating as a real member-lookup candidate --
/// mirrors `urdira_jsts_typeflow::is_dropped_union_constituent` exactly
/// (that crate's own private helper; duplicated here rather than shared,
/// since the two crates each parse with their own separate oxc allocator --
/// see this file's own `TypeflowValue`/`urdira_jsts_typeflow::RawTypeRef`
/// doc comments for why the two type-shape enums are parallel, not shared).
/// `null`/`undefined` (TypeScript's own nullability convention) and a
/// literal/primitive keyword type are dropped; every other constituent
/// (including `any`/`unknown`/`void`/`never`/`object`) is classified
/// normally and, if unclassifiable, contaminates the whole union via the
/// caller's own `TSUnionType` arm.
fn is_dropped_union_constituent(ty: &TSType) -> bool {
    matches!(
        ty,
        TSType::TSNullKeyword(_)
            | TSType::TSUndefinedKeyword(_)
            | TSType::TSLiteralType(_)
            | TSType::TSStringKeyword(_)
            | TSType::TSNumberKeyword(_)
            | TSType::TSBooleanKeyword(_)
            | TSType::TSBigIntKeyword(_)
            | TSType::TSSymbolKeyword(_)
    )
}

/// Classify a resolved symbol's declaration into one of the identity kinds
/// that `analyzer.ts` would also assign an entity to, or `None` when the
/// checker's own `entityForDeclaration` would likewise return `undefined`
/// for it (destructured bindings, named function/class expressions, type
/// parameters, catch parameters, ...). Any `None` is a deliberate,
/// conservative "this needs the checker" outcome, never a false resolution.
fn classify_symbol_declaration(
    nodes: &AstNodes,
    scoping: &Scoping,
    symbol_id: SymbolId,
) -> Option<DeclKind> {
    let declaration_node_id = scoping.symbol_declaration(symbol_id);
    match nodes.kind(declaration_node_id) {
        AstKind::Function(function) => matches!(
            function.r#type,
            FunctionType::FunctionDeclaration | FunctionType::TSDeclareFunction
        )
        .then_some(DeclKind::Function),
        AstKind::Class(class) => {
            (class.r#type == ClassType::ClassDeclaration).then_some(DeclKind::Class)
        }
        AstKind::TSInterfaceDeclaration(_) => Some(DeclKind::Interface),
        AstKind::TSTypeAliasDeclaration(_) => Some(DeclKind::Type),
        AstKind::TSEnumDeclaration(_) => Some(DeclKind::Enum),
        AstKind::TSModuleDeclaration(_) => Some(DeclKind::Namespace),
        AstKind::VariableDeclarator(decl) => {
            matches!(&decl.id, BindingPattern::BindingIdentifier(_)).then_some(DeclKind::Variable)
        }
        AstKind::FormalParameter(param) => {
            matches!(&param.pattern, BindingPattern::BindingIdentifier(_))
                .then_some(DeclKind::Parameter)
        }
        // 2026-09-04 references-parity task, bucket 1
        // (`unsupported_declaration_kind`, 92% of the bucket): a catch
        // clause's own simple identifier binding (`catch (error) {}`).
        // `CatchParameter::bind` (oxc_semantic) registers the symbol's
        // declaration node as `AstKind::CatchParameter` itself (verified
        // against `oxc_semantic`'s `visit_catch_parameter`: `enter_node`
        // sets `current_node_id` to the `CatchParameter` node before
        // `param.bind(self)` runs) -- never `AstKind::VariableDeclarator`,
        // even though v3's `analyzer.ts` (`addEntity`'s `isVariableDeclaration`
        // branch) treats it exactly like an ordinary `variable`. A
        // destructured catch binding (`catch ({ message }) {}`) stays
        // `None` here, same conservative rule as every other pattern kind.
        AstKind::CatchParameter(param) => {
            matches!(&param.pattern, BindingPattern::BindingIdentifier(_))
                .then_some(DeclKind::Variable)
        }
        // 2026-09-04 references-parity task, bucket 1 (~4.5% of the
        // bucket): a rest parameter (`...args`). oxc gives a rest
        // parameter its OWN node kind, `FormalParameterRest` (a SIBLING of
        // `FormalParameters::items`, not a `FormalParameter` wrapping a
        // `BindingPattern::BindingRestElement` the way a destructured rest
        // element inside an object/array pattern is) -- confirmed against
        // `oxc_semantic::binder`'s `impl Binder for FormalParameterRest`
        // and `visit_formal_parameter_rest`'s own `AstKind::
        // FormalParameterRest(...)` `enter_node`. v3 treats it as an
        // ordinary `isParameterDeclaration` -- kind `parameter`, matching
        // `visit_formal_parameter`'s own `FormalParameter` arm above byte
        // for byte, just reached through the sibling node. A destructured
        // rest element (`...{ a }`, `...[a]]` -- not valid JS syntax for a
        // FUNCTION rest parameter, but the pattern shape check stays for
        // defensive parity with the ordinary-parameter arm above) stays
        // `None`.
        AstKind::FormalParameterRest(rest) => {
            matches!(&rest.rest.argument, BindingPattern::BindingIdentifier(_))
                .then_some(DeclKind::Parameter)
        }
        _ => None,
    }
}

/// The identity-kind token a `declaration_id`/`resolve_named_export`
/// target id encodes (`"function"` in `jsts:function:a.ts:9:foo`, ...),
/// without allocating -- E3 (T1/T2) uses this to check a resolver-chain
/// target's kind (`DeclKind::identity_name`) without re-deriving it from
/// the target module's entity table a second time.
fn target_id_kind_name(target_id: &str) -> Option<&str> {
    target_id.strip_prefix("jsts:")?.split(':').next()
}

/// Whether `target_id`'s own encoded kind is one of `allowed` -- see
/// `target_id_kind_name`.
fn target_id_kind_is_one_of(target_id: &str, allowed: &[DeclKind]) -> bool {
    let Some(kind_name) = target_id_kind_name(target_id) else {
        return false;
    };
    allowed.iter().any(|kind| kind.identity_name() == kind_name)
}

struct ReferenceRow {
    start: u32,
    end: u32,
    source_id: String,
    target_id: String,
    /// True when this reference was resolved through the import -> export ->
    /// declaration chain (E2): the target necessarily lives in a different
    /// file from this owner (`self.path`), the same cross-file test
    /// `assembleAnalysis`'s `core:covers` derivation applies
    /// (`source.path !== target.path`). The plain local-symbol branch of
    /// `resolve_identifier_reference` always resolves within `self.path`
    /// (`declaration_id` is built from `&self.path` there), so it is never
    /// cross-file and never a covers candidate.
    cross_file: bool,
}

/// External package/symbol entities task (2026-09-04): one external
/// binding/member-read occurrence recorded by `SemanticWalker::emit_
/// external_use`. `specifier` is already canonicalized (`classify_external_
/// specifier`'s return value); `name` is the imported/exported/member name
/// (`"default"`/`"*"` included). `start`/`end` are this OCCURRENCE's own
/// site span (the binding's local-name span for an import/re-export, the
/// member name's span for a namespace member read) -- the `core:contains`
/// row's own span, not the entity's (entities have no real span, see
/// `crate::external_module_entity`'s doc comment).
struct ExternalSymbolUse {
    specifier: String,
    name: String,
    is_type: bool,
    start: u32,
    end: u32,
    /// Measurement-only (2026-09-04 n8n before/after count, gated behind
    /// `URDIRA_V4_DEBUG_EXTERNAL_ENTITIES` in `finish()` below): which
    /// PRE-this-task pending reason this occurrence would have carried.
    /// `true` for `resolve_named_binding_via_specifier`'s external branch
    /// (import/re-export bindings, `visit_import_namespace_specifier`'s own
    /// value-usage) -- unconditionally `Pending(REASON_IMPORT_BINDING)`
    /// before this task; `false` for `visit_static_member_expression`'s
    /// external namespace-member-read branch -- unconditionally
    /// `Pending(REASON_MEMBER_ACCESS)` before this task. Never read by
    /// production code paths (no query-layer/store consumer), purely so the
    /// n8n before/after report can state, from a SINGLE run of the current
    /// (fixed) code, exactly how many now-confirmed rows used to carry each
    /// reason -- see this task's evidence doc.
    was_import_binding: bool,
}

/// One `core:call` row (E3, T1): unlike `ReferenceRow`, there is no
/// self-reference guard here -- the checker's own `relate("call", ...)` in
/// `analyzer.ts` never excludes `source_id == target_id` (a recursive call's
/// callee resolves to its own enclosing function), so a rust-resolved
/// recursive call is published exactly like the checker would.
struct CallRow {
    start: u32,
    end: u32,
    source_id: String,
    target_id: String,
}

/// One `core:inherits`/`core:implements` row (E3, T2). `relation_kind` is
/// always `"inherits"` or `"implements"` (matches `relate`'s own `kind`
/// argument in `analyzer.ts`'s heritage branch, chosen by which clause the
/// type came from -- `extends` vs. `implements` -- never derived from the
/// target's own declaration kind, so a class or an interface can equally be
/// either row's target).
struct HeritageRow {
    start: u32,
    end: u32,
    source_id: String,
    target_id: String,
    relation_kind: &'static str,
}

/// P2-2i: one CALL site neither E1-E3 nor typeflow could resolve, still
/// carrying the enclosing entity (`source_id`, always present -- `current_
/// owner()` never returns `None`, see its own doc comment) and the reason
/// E1a/E3 already attached to it. Turned into a [`PendingSiteProposal`]
/// (`site_kind: Call`, carrying this site's own `reason`) in `finish`.
struct PendingCallSite {
    start: u32,
    end: u32,
    source_id: String,
    reason: &'static str,
}

/// P2-2i: one heritage clause entry that stayed `checker_pending` with a
/// real enclosing declaration to attribute it to. `relation_kind` is
/// `"inherits"` or `"implements"`, same convention as `HeritageRow`. `reason`
/// (A2, pending.sites migration: reinstated after P2-2i's own session
/// removed it as dead code, since a `possible` heritage row never carried
/// one -- a `PendingSiteRow` does, see `PendingSiteProposal`'s doc comment)
/// is whichever reason was already in scope at this site's own `push_site`
/// call (`REASON_HERITAGE_DEFERRED`, `REASON_HERITAGE_TARGET_UNCERTAIN`, or
/// `REASON_HERITAGE_CLAUSE_PARTIALLY_PENDING`).
struct PendingHeritageSite {
    start: u32,
    end: u32,
    source_id: String,
    relation_kind: &'static str,
    reason: &'static str,
}

/// P2-2j: one per-candidate `possible` `core:call` row for a call site whose
/// typeflow receiver resolved to MULTIPLE plausible declarations -- an
/// overloaded member (`MemberLookup::Many`, `REASON_OVERLOAD_AMBIGUOUS`) or
/// a union-typed receiver (`MemberLookup::UnionCandidates`, `REASON_UNION_
/// AMBIGUOUS`). Unlike `PendingCallSite` (no target at all), each row here
/// carries its OWN `target_id` -- one candidate, one row -- so the query
/// engine can actually traverse it: `core:find_references`/`core:find_
/// paths`/`core:expand_relations` only ever return `possible` rows that
/// carry a `target_id` (a no-target possible row is query-invisible by
/// construction). The SAME call site also stays a `PendingCallSite` with
/// the SAME `reason` (see `visit_call_expression`'s `Candidates` arm), so a
/// later residual tsgo pass can still upgrade it to one CONFIRMED row.
/// Turned into a `possible` (never `confirmed`) `core:call` row by
/// `candidate_call_record` in `finish`.
struct CandidateCallRow {
    start: u32,
    end: u32,
    source_id: String,
    target_id: String,
    reason: &'static str,
}

/// Outcome of `SemanticWalker::resolve_call_target_typeflow`. `Candidates`
/// is P2-2j: the receiver resolved, but the member lookup itself was
/// genuinely ambiguous (an overload set on one container, or a union of
/// several containers) -- one `CandidateCallRow` per target is still worth
/// publishing (each carries its OWN `target_id`), but this is deliberately
/// NEVER a `Resolved` -- see `REASON_OVERLOAD_AMBIGUOUS`/`REASON_UNION_
/// AMBIGUOUS`'s own doc comments and this crate's zero-wrong-target
/// discipline: a union/overload receiver never promotes to a confirmed
/// target in this round, even when every candidate agrees.
enum TypeflowCallResolution {
    Resolved(String, &'static str),
    Candidates {
        targets: Vec<String>,
        reason: &'static str,
    },
    Unresolved,
}

/// P1-A: the resolved static type of an expression this walker's typeflow
/// machinery reasons about, generalizing P0-S2's `(entity_id, is_static)`
/// pair with the two wrapper shapes chain propagation needs to see through
/// one hop at a time (`T[]`/`Array<T>` for `a[i]`, `Promise<T>` for
/// `await`). Mirrors `urdira_jsts_typeflow::ResolvedTypeRef` almost exactly,
/// except `Entity` carries `is_static` (needed at every USE site here,
/// cross-file lookup only cares about the entity id) and there is no
/// standalone `ThisType` variant: `this`/`super` resolve directly to an
/// `Entity` from `class_stack` (this walker always knows the concrete
/// enclosing class), while a MEMBER's declared `this` return type is
/// resolved relative to its own receiver by `resolve_type_ref_relative`
/// before a `TypeflowValue` is ever produced for it.
#[derive(Clone, Debug, PartialEq, Eq)]
enum TypeflowValue {
    Entity {
        entity_id: String,
        is_static: bool,
    },
    ArrayOf(Box<TypeflowValue>),
    PromiseOf(Box<TypeflowValue>),
    /// P1-C: `Record<K, V>`'s own value type `V` -- see `urdira_jsts_
    /// typeflow::RawTypeRef::RecordOf`'s doc comment. Unwrapped by a
    /// computed access (`a[i]`/`a["x"]`) exactly like `ArrayOf`.
    RecordOf(Box<TypeflowValue>),
    /// P1-A (rule (j), local half): a LOCAL parameter/variable annotated
    /// with an ANONYMOUS `{ ... }` object type (as opposed to a NAMED
    /// interface/class -- those resolve to `Entity` via `resolve_
    /// identifier_to_kind`) -- found live: `function f(options: { RunTree:
    /// LangSmithRunTree }) { options.RunTree.getSharedClient()... }`.
    /// Carries each member's own NAME and TYPE directly (never an entity
    /// id -- an inline type literal has no declaration of its own the
    /// checker could confirm as a member-access TARGET, only as a type to
    /// keep chaining through), so member access on it is resolved by a
    /// linear scan (`type_of_static_member`/`type_of_call_expression`)
    /// rather than `ProgramIndex::member_type_ref`. This is the LOCAL
    /// counterpart of the crate's own cross-file inline-type-literal
    /// support (`urdira_jsts_typeflow`'s synthetic containers) -- see that
    /// crate's `raw_type_ref_of_ts_type` doc comment for the shared
    /// reasoning; the two never interact directly (a hop into a NAMED
    /// interface/class always switches to `Entity`, backed by the real
    /// cross-file index, from then on).
    Inline(Vec<(String, TypeflowValue)>),
    /// P2-2j: a TypeScript union type used as a member-access receiver
    /// (`a: A | B; a.run()`) -- see `urdira_jsts_typeflow::RawTypeRef::
    /// Union`'s doc comment for the exact construction rules (`type_ref_of_
    /// ts_type`'s `TSUnionType` arm mirrors them locally: drop null/
    /// undefined/literal/primitive constituents, contaminate to `None` on
    /// any other unclassified remaining constituent, dedupe, collapse a
    /// single survivor). `resolve_type_ref_relative` produces this from a
    /// cross-file `ResolvedTypeRef::Union` the same way it produces every
    /// other wrapper. Consumed by `as_entities` (never `as_entity`, which
    /// stays `None` for a `Union` -- see its own doc comment) and routed to
    /// `ProgramIndex::members_of_union` by `resolve_call_target_typeflow`.
    Union(Vec<TypeflowValue>),
}

/// P0-S2 typeflow: see `SemanticWalker::class_stack`'s doc comment.
struct ClassFrame {
    entity_id: Option<String>,
    extends_entity_id: Option<String>,
}

/// One not-yet-published heritage clause entry's own span plus its
/// individually-computed resolution, as collected by `visit_class`/
/// `visit_ts_interface_declaration` before handing the whole group to
/// `finish_heritage_clause_group` for the atomic all-or-nothing decision.
type HeritageClauseEntry = (u32, u32, Result<(String, String), &'static str>);

#[derive(Clone)]
enum ReferenceResolution {
    Resolved { target_id: String, cross_file: bool },
    Pending(&'static str),
}

/// Ambient module resolution task (2026-09-04): `resolve_external_
/// namespace_member`'s outcome -- see that method's own doc comment.
enum NamespaceMemberResolution {
    /// A genuine external package/builtin member read: `emit_external_use`
    /// still needs to fire (canonical specifier, resolved `target_id`).
    External(String, String),
    /// Resolved through a workspace `declare module` block instead: the
    /// target already exists, published by the DECLARING file's own
    /// producers -- no `emit_external_use` side effect.
    Ambient(String),
}

/// Everything `analyze_owner_semantics_with_context` needs to close an
/// import -> export -> declaration chain (E2, F5 hybrid design; see
/// `resolver.rs`'s module doc). `resolver`/`available` mirror the same pair
/// `parse_source` (lib.rs, lane 1) already resolves `DirectImport::
/// target_path` with -- same project, same call -- so a bare specifier
/// resolves identically in both lanes. `files` is the project's full,
/// already lane-1-resolved `SyntaxFileResult` map (so every
/// `SyntaxExportBinding::source_target_path` is already filled in),
/// supplied by the orchestrator (`urdira-indexing-worker`'s
/// `compute_hybrid_semantics`) from the SAME generation's syntax pass.
///
/// The back-compat `analyze_owner_semantics` passes an all-empty context
/// (`WorkspaceResolver::default()`, empty `available`/`files`), under which
/// every lookup here degrades to `None`/`Unresolved` -- exactly today's
/// pre-E2 "import bindings are always `checker_pending`" behavior, not a
/// special case.
pub struct HybridResolutionContext<'a> {
    pub resolver: &'a WorkspaceResolver,
    pub available: &'a BTreeSet<String>,
    pub files: &'a BTreeMap<String, SyntaxFileResult>,
    /// P0-S2 prototype ("typeflow", `docs/evidence/2026-09-02-v4-p0-s2-
    /// typeflow-prototype.md`): the cross-file class/interface member index,
    /// built by the orchestrator ONLY when `URDIRA_JSTS_TYPEFLOW=1` from
    /// every project file's `urdira_jsts_typeflow::extract_decl_summary`.
    /// `None` is exactly the flag-off default; every typeflow branch below
    /// degrades to the pre-existing E1-E3 `checker_pending` behavior when
    /// this is absent.
    pub typeflow_index: Option<&'a urdira_jsts_typeflow::ProgramIndex>,
    /// `URDIRA_JSTS_TYPEFLOW_ORACLE=1`: a typeflow resolution is recorded as
    /// an oracle hit (`OwnerSemantics::typeflow_oracle_hits`) instead of
    /// replacing the site's disposition -- the site stays `checker_pending`
    /// exactly as E1-E3 alone would have left it, so the checker still
    /// independently resolves it and the orchestrator can compare the two
    /// answers. Ignored when `typeflow_index` is `None`.
    pub typeflow_oracle: bool,
    /// Ambient module resolution task (2026-09-04): the workspace-wide
    /// index of every `declare module "specifier" { ... }` block any file
    /// in `files` declares, built ONCE by the caller (`urdira-indexing-
    /// worker::v4::analyze::run_scoped`) from that SAME `files` snapshot,
    /// rather than re-scanned per lookup -- consulted by `resolve_named_
    /// binding_via_specifier`'s external branch, `visit_import_namespace_
    /// specifier`, and `resolve_external_namespace_member` BEFORE
    /// `resolver::classify_external_specifier` gets a turn (fix item 2: an
    /// ambiently-declared specifier's import/reference targets the
    /// declaration inside that block, never a synthetic external entity).
    pub ambient_index: &'a resolver::AmbientModuleIndex,
}

/// Parameter entities, "referenced-only" variant: the enclosing declaration
/// a `FormalParameter` should attribute `parent_id`/`qualified_name` to,
/// carried on `param_owner_stack`/`pending_function_owner`. `entity_id` is
/// the SAME id lib.rs's own entity producer for that declaration already
/// uses (`stable_entity_id`/`declaration_id`, byte-identical formula), so a
/// parameter's `parent_id` never dangles: it either names one of those
/// already-emitted entities, or (a bare `None` in the surrounding
/// `Option<ParamOwner>`) the code building the fact substitutes the module
/// entity itself, which is unconditionally emitted for every file.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ParamOwner {
    entity_id: String,
    qualified_name: String,
}

/// Parameter entities, "referenced-only" variant: the declaration facts one
/// identifier-pattern `FormalParameter` contributes, recorded by
/// `visit_formal_parameter` regardless of whether it turns out referenced.
/// `start`/`end` are the parameter's own BINDING IDENTIFIER span (`ident.
/// span`, matching every other entity's "name span" convention -- e.g.
/// `push_entity`'s `identifier.span` -- never the whole `FormalParameter`
/// span, which would also cover a type annotation/decorators/accessibility
/// modifier/default value).
#[derive(Debug, Clone, PartialEq, Eq)]
struct ParameterDeclarationFact {
    entity_id: String,
    name: String,
    start: u32,
    end: u32,
    parent_id: String,
    qualified_name: String,
}

struct SemanticWalker<'a, 'ctx, 'r> {
    path: String,
    module_id: String,
    scoping: &'ctx Scoping,
    nodes: &'ctx AstNodes<'a>,
    /// Ids of enclosing `core:callable` declarations, innermost last. Only
    /// callable declarations are pushed: non-callable ones (variable/class/
    /// interface/...) never become an owner, so tracking them would be
    /// pure overhead -- matches `ownerAt`'s walk-past-non-callable
    /// semantics in `analyzer.ts` exactly.
    callable_stack: Vec<String>,
    sites: Vec<SemanticSite>,
    reference_rows: Vec<ReferenceRow>,
    /// `core:call` rows resolved with certainty (E3, T1). See `OwnerSemantics
    /// ::call_rows`'s doc comment for the exact contract.
    call_rows: Vec<CallRow>,
    /// `core:inherits`/`core:implements` rows resolved with certainty (E3,
    /// T2). See `OwnerSemantics::heritage_rows`'s doc comment.
    heritage_rows: Vec<HeritageRow>,
    /// P0-S2 prototype (typeflow): `core:call`/`core:inherits` rows resolved
    /// through declared-type member lookup. See `OwnerSemantics::
    /// typeflow_call_rows`/`typeflow_heritage_rows`'s doc comments.
    typeflow_call_rows: Vec<CallRow>,
    typeflow_heritage_rows: Vec<HeritageRow>,
    /// P2-2i: every CALL site that stayed `checker_pending` after E1-E3 and
    /// typeflow both had their turn -- the residual the checker-off v4
    /// pipeline must now speak for itself, mirroring `analyzer.ts`'s own
    /// `relate("call", relationSource, undefined, node, "possible")` +
    /// paired `jsts:unresolved_call` diagnostic. See `OwnerSemantics::
    /// pending_site_rows`'s doc comment for the exact contract.
    pending_call_sites: Vec<PendingCallSite>,
    /// P2-2i: every heritage clause entry that stayed `checker_pending` with
    /// a real enclosing declaration to attribute it to (`self_id` present --
    /// see `finish_heritage_clause`'s doc comment for the one case this
    /// deliberately excludes). Mirrors `analyzer.ts`'s own
    /// `relate("inherits"|"implements", relationSource, undefined, type,
    /// "possible")`.
    pending_heritage_sites: Vec<PendingHeritageSite>,
    /// P2-2j: every per-candidate `possible` `core:call` row produced for a
    /// call site whose typeflow receiver was genuinely ambiguous (an
    /// overload set or a union). See `CandidateCallRow`'s and `OwnerSemantics
    /// ::candidate_call_rows`'s own doc comments. Never populated in oracle
    /// mode (`visit_call_expression`'s `Candidates` arm is only reached
    /// outside that mode).
    candidate_call_rows: Vec<CandidateCallRow>,
    /// `URDIRA_JSTS_TYPEFLOW_ORACLE=1` only. See `OwnerSemantics::
    /// typeflow_oracle_hits`'s doc comment.
    typeflow_oracle_hits: Vec<TypeflowOracleHit>,
    /// `URDIRA_JSTS_TYPEFLOW_ORACLE=1` only. See `OwnerSemantics::
    /// typeflow_pending_call_shapes`'s doc comment.
    typeflow_pending_call_shapes: Vec<TypeflowPendingShape>,
    /// Ids of enclosing class declarations, innermost last (P0-S2 typeflow:
    /// `this`/`super` call-target resolution). `entity_id` is `None` for an
    /// anonymous class expression (matches `visit_class`'s own `self_class_
    /// id`); `extends_entity_id` is the best KNOWN base-class entity id --
    /// set regardless of whether the heritage EDGE itself was published or
    /// stayed pending/oracle-only, since `super.x()` resolution only needs
    /// to know what the base class IS, not whether that fact was already
    /// published.
    class_stack: Vec<ClassFrame>,
    /// Whether the class member body currently being walked is `static`
    /// (innermost last) -- disambiguates `this`/`super` member lookup inside
    /// a static method/property initializer from an instance one. Empty
    /// (defaults to instance, `false`) outside any member body.
    static_context: Vec<bool>,
    /// Parameter entities, "referenced-only" variant: the nearest enclosing
    /// declaration a `FormalParameter` directly inside it should attribute
    /// `parent_id` to, innermost last -- `None` when that nearest enclosing
    /// callable has no entity of its own (an anonymous callback, an object-
    /// literal shorthand method, a nested class's member, a non-first
    /// declarator's arrow/function-expression init -- see
    /// `parameter_entity_record`'s doc comment for the full rule). Pushed
    /// exactly once per `Function`/`ArrowFunctionExpression` node reached
    /// through `self.visit_function`/`self.visit_arrow_function_expression`
    /// (never through `visit_method_definition`'s own deliberate `walk_
    /// function` bypass, which brackets this stack directly instead -- see
    /// that override's own comment). Read only by `visit_formal_parameter`.
    param_owner_stack: Vec<Option<ParamOwner>>,
    /// A one-shot hint for the VERY NEXT `Function`/`ArrowFunctionExpression`
    /// node `self.visit_function`/`self.visit_arrow_function_expression`
    /// reaches, set by `visit_variable_declarator` (a variable-bound arrow/
    /// function-expression owns its params under the VARIABLE's own entity,
    /// never a fresh anonymous frame) and by `visit_object_property` (an
    /// object-literal shorthand method has no entity of its own -- typeflow's
    /// `member_declarations` never enumerates object literals -- so this is
    /// set to `Some(None)` there to positively override rather than risk an
    /// unrelated OUTER hint leaking in). `Some(owner)` is drained by exactly
    /// one `.take()` at the top of both overrides, regardless of which
    /// branch they end up taking, so a hint can never survive past the one
    /// node it was set for. `None` (the default) means "decide normally"
    /// (a named function declaration owns itself; anything else falls back
    /// to the module).
    pending_function_owner: Option<Option<ParamOwner>>,
    /// Whether the `VariableDeclarator` `visit_variable_declarator` is
    /// currently walking is the FIRST declarator of its own
    /// `VariableDeclaration` -- lane 1's plain entity pass (`lib.rs`'s
    /// `SyntaxCollector::visit_variable_declaration`) only ever creates a
    /// `core:value` entity for `declaration.declarations.first()`, so `const
    /// a = 1, f = () => a;`'s `f` gets NO variable entity even though
    /// `classify_symbol_declaration` still resolves references to it as
    /// `DeclKind::Variable`. Set by the `visit_variable_declaration`
    /// override just below (one assignment per declarator, immediately
    /// before visiting it), consulted by `visit_variable_declarator` when
    /// deciding whether a directly-init'd arrow/function-expression's own
    /// params get the variable's id or fall back to the module.
    declarator_owns_entity: bool,
    /// Parameter entities, "referenced-only" variant: every identifier-
    /// pattern parameter declaration this walk has seen, keyed by its own
    /// entity id (`jsts:parameter:{path}:{nameStart}:{name}`, byte-identical
    /// to the `target_id` a resolved reference to it carries) -- recorded
    /// UNCONDITIONALLY in `visit_formal_parameter`, before it is known
    /// whether the parameter is ever referenced (`finish` filters this map
    /// down to `referenced_parameter_targets` at the end). A `BTreeMap` so a
    /// later "same id twice" bug (there should never be one -- each
    /// `nameStart` is a unique byte offset) would silently keep the LAST
    /// write rather than panic; never observed live.
    parameter_declarations: BTreeMap<String, ParameterDeclarationFact>,
    /// Parameter entities, "referenced-only" variant: `entity_id -> qualified
    /// name` for every class/interface member `push_member_entities`
    /// (lib.rs) actually emits an entity for -- see `analyze_owner_semantics
    /// _with_context`'s own construction comment for why this is sourced
    /// from `urdira_jsts_typeflow::member_declarations` directly rather than
    /// re-derived. Consulted by `visit_method_definition`/`visit_object_
    /// property`/`visit_ts_method_signature` to decide each member's own
    /// `param_owner_stack` frame.
    member_qualified_names: BTreeMap<String, String>,
    /// Parameter entities, "referenced-only" variant: the `target_id` of
    /// every resolved reference (`visit_identifier_reference`'s `Resolved`
    /// arm) whose target is a parameter (`target_id` starts with
    /// `"jsts:parameter:"`) -- a `BTreeSet` both to dedupe (a parameter
    /// referenced twice must still get exactly one entity) and to give
    /// `finish`'s emission order a deterministic, dependency-free sort (by
    /// id, which already sorts by path/nameStart/name).
    referenced_parameter_targets: BTreeSet<String>,
    /// 2026-09-04 references-parity task, bucket 1: same declaration-fact
    /// shape and "referenced-only" lifecycle as `parameter_declarations`
    /// (`ParameterDeclarationFact` is reused verbatim -- nothing about its
    /// fields is parameter-specific), for a catch clause's own simple
    /// identifier binding (`catch (error) {}`, `DeclKind::Variable`, v3's
    /// `isVariableDeclaration` treatment). Recorded unconditionally by
    /// `visit_catch_parameter`; `finish` filters this down to `referenced_
    /// catch_targets` and materializes each survivor through the SAME
    /// `OwnerSemantics::parameter_entity_rows`/`parameter_contains_rows`
    /// output buckets the parameter producer already uses (a shared,
    /// kind-agnostic sink -- see `catch_variable_entity_record`'s own doc
    /// comment).
    catch_declarations: BTreeMap<String, ParameterDeclarationFact>,
    /// 2026-09-04 references-parity task, bucket 1: the `target_id` of
    /// every resolved reference whose target is a catch binding (`target_id`
    /// starts with `"jsts:variable:"` -- see `visit_identifier_reference`'s
    /// `Resolved` arm). Broader than "catch bindings only" by construction
    /// (any `DeclKind::Variable` target matches the prefix, including an
    /// ordinary variable that already has its own unconditional entity from
    /// lib.rs's `SyntaxCollector`) -- harmless: `finish`'s `filter_map`
    /// against `catch_declarations` silently drops every id that is not
    /// actually a recorded catch binding, the same safe-miss pattern
    /// `parameter_declarations`' own filter_map already relies on for a
    /// parameter PROPERTY's id.
    referenced_catch_targets: BTreeSet<String>,
    /// 2026-09-04 references-parity task, bucket 3
    /// (`type_predicate_parameter`): the innermost enclosing callable
    /// signature's own identifier-pattern parameter names (`name`, binding
    /// identifier `start`, `end`), pushed by `visit_function`/`visit_arrow_
    /// function_expression`/`visit_method_definition`/`visit_ts_method_
    /// signature` immediately before walking that signature's own body/
    /// return-type (so it is still on top while a `TSTypePredicate` in that
    /// SAME signature's return type is visited), popped right after. Pushed
    /// unconditionally (an empty `Vec` counts as a real frame) so nested
    /// callables never leak an OUTER signature's parameters in --
    /// `.last()` always names the truly innermost one. See `visit_ts_type_
    /// predicate`'s own doc comment for the resolution rule.
    predicate_param_stack: Vec<Vec<(String, u32, u32)>>,
    /// P0-S2/P1-A typeflow: every local variable/parameter this walk has
    /// typed, through a declared type annotation OR (P1-A, rule (b))
    /// recursively through its own initializer expression when unannotated
    /// (`type_of_expression`), keyed by oxc `SymbolId`. Consulted (never
    /// guessed at) by `type_of_expression`'s `Identifier` arm for a plain
    /// identifier used as a call/member-access base (`a.b()`).
    local_types: HashMap<SymbolId, (TypeflowValue, &'static str)>,
    /// P1-C: every destructured-METHOD local binding this walk has typed
    /// (`record_destructured_object_types`'s leaf case), keyed by the
    /// binding's own `SymbolId`, valued by the member's OWN declaration
    /// entity id (`ProgramIndex::members`, never `member_type_ref` -- the
    /// declaration id itself, not its return type). Distinct from `local_
    /// types` on purpose: that map answers "what TYPE does calling this
    /// produce" (needed for further chain propagation, e.g. `createTable(
    /// name).withColumns()`); THIS map answers "what DECLARATION does
    /// calling this resolve to" (needed to emit the call edge for a BARE
    /// destructured-method call with no further chaining at all -- found
    /// live, the migration DSL's own dominant pattern: `await dropColumns(
    /// 'user', [...], {...})`, never chained further because `dropColumns`
    /// returns `void`, `RawTypeRef::Unknown` in this crate's own
    /// classification, which is exactly why `local_types` alone could never
    /// resolve this call). Consulted by `resolve_call_target_typeflow`'s
    /// new identifier-callee branch.
    destructured_member_entities: HashMap<SymbolId, String>,
    /// 2026-09-05 A5 references-parity task, Paso 0 (diagnosis only): every
    /// symbol bound by ONE property of an `ObjectPattern` this walk's own
    /// `record_destructured_object_types` visited, regardless of whether
    /// the member's type was itself resolved (a superset of `local_types`'
    /// destructured entries -- inserted BEFORE the `member_type_ref` lookup
    /// that can fail). Consulted ONLY by `member_access_sub_reason`'s
    /// `ident:param_destructured` bucket -- never read by any resolution
    /// path, so it changes no observable behavior.
    destructured_pattern_symbols: std::collections::HashSet<SymbolId>,
    /// Safe-partition rule (see `is_jsdoc_typed_file`): when set, every
    /// identifier-kind site in this owner is forced `checker_pending` with
    /// `REASON_JSDOC_TYPED_FILE`, and zero `reference_rows` are produced,
    /// regardless of what oxc's own symbol table could otherwise prove.
    jsdoc_typed_file: bool,
    /// E2: resolver/project context used to close import -> export ->
    /// declaration chains. See `HybridResolutionContext`'s doc comment.
    ctx: &'r HybridResolutionContext<'r>,
    /// The enclosing `ImportDeclaration`'s specifier text while walking its
    /// specifiers (`import { a } from "HERE"`), `None` everywhere else.
    /// Import declarations are always module-top-level with no nesting, so
    /// a single `Option` (not a stack) suffices.
    current_import_source: Option<String>,
    /// 2026-09-04 references-parity task, Phase B bucket 1: the enclosing
    /// `ExportNamedDeclaration`'s own `source` specifier text while walking
    /// its specifiers (`export { a } from "HERE"`), `None` when the
    /// current `ExportNamedDeclaration` has no `source` (the sourceless
    /// `export { a, b as c }` form) or none is being walked at all.
    /// `resolve_export_source_binding` consults this the same way
    /// `resolve_import_binding` consults `current_import_source` --
    /// deliberately a SEPARATE field rather than reusing `current_import_
    /// source`: an export specifier can be walked while an outer import
    /// declaration's source is unrelated (not true in practice, since
    /// neither form nests, but keeping the two fields distinct removes any
    /// doubt and mirrors `visit_import_declaration`'s own save/restore
    /// exactly). Export declarations never nest either, so a single
    /// `Option` (not a stack) suffices here too.
    current_export_source: Option<String>,
    /// External package/symbol entities task: whether the `ImportDeclaration`
    /// currently being walked is `import type { ... } from "m"` (whole-
    /// declaration type-only). Save/restore, same shape as `current_import_
    /// source`. A per-specifier `import { type Foo } from "m"` is detected
    /// separately, from `ImportSpecifier::import_kind` itself, at the
    /// specifier visit site.
    current_import_type_only: bool,
    /// Same as `current_import_type_only`, for `export type { ... } from
    /// "m"` (`ExportNamedDeclaration::export_kind`).
    current_export_type_only: bool,
    /// External package/symbol entities task: every external binding/
    /// member-read this walk resolved, in visitation order -- converted into
    /// `OwnerSemantics::external_entity_rows`/`external_contains_rows` once,
    /// in `finish()` (same "collect raw facts during the walk, build
    /// `ProposedRecord`s once at the end" shape `parameter_entity_rows`
    /// already uses). See `emit_external_use`'s own doc comment for what
    /// pushes into this.
    external_uses: Vec<ExternalSymbolUse>,
    /// Every import-bound symbol this walk has resolved (or given up on) so
    /// far, keyed by oxc's `SymbolId` for the specifier's local binding.
    /// Populated as `visit_import_specifier` is reached; consulted by
    /// `resolve_identifier_reference` for every later USE of that binding
    /// in the file. Import declarations are conventionally file-top, so a
    /// single top-down walk order already covers the overwhelming majority
    /// of real code; a genuinely out-of-order import (legal but unusual JS)
    /// simply leaves that one usage `checker_pending` -- safe, not wrong.
    import_bindings: HashMap<SymbolId, ReferenceResolution>,
    /// P1-A (rule (f), namespace member call): every `import * as ns from
    /// "specifier"` binding this walk has seen, keyed by `ns`'s own
    /// `SymbolId`, valued by the raw module specifier text -- consulted by
    /// `resolve_namespace_member` for a LATER `ns.member(...)` call/chain
    /// base, closed the same way a named import is (`WorkspaceResolver::
    /// resolve` + `resolver::resolve_named_export`), just keyed by the
    /// PROPERTY name at the use site instead of a name captured at the
    /// import site (a namespace import binds no single name up front).
    namespace_import_specifiers: HashMap<SymbolId, String>,
    /// P1-B: every NAMED import this walk has seen that resolved (through
    /// `resolver::resolve_named_export`) to a namespace re-export (`export
    /// * as X from "spec"` -- see `NAMESPACE_REEXPORT_LOCAL_NAME`'s doc
    /// comment) rather than a single declaration -- keyed by the LOCAL
    /// binding's own `SymbolId`, valued by the re-exported module's OWN
    /// already-resolved path (no further `WorkspaceResolver::resolve` hop
    /// needed, unlike `namespace_import_specifiers`, which only ever holds
    /// a raw specifier). Consulted by `resolve_namespace_member` for a
    /// LATER `evals.member(...)` use site, exactly the same way a direct
    /// `import * as evals from "..."` binding already is.
    namespace_reexport_targets: HashMap<SymbolId, String>,
    /// Whether THIS owner is itself a test container (`core:covers` fix,
    /// F5 hybrid gap, 2026-09-01): read from `ctx.files[self.path]`'s own
    /// module entity `is_test` flag -- the SAME flag lane 1's
    /// `SyntaxCollector::finish_import_relations` sets from a `node:test`
    /// import, and the SAME one `analyzer.ts`'s `is_test`-carrying module
    /// entity mirrors. Reusing it (rather than re-deriving a `node:test`
    /// import check here) guarantees this owner's test-container status can
    /// never disagree with either producer's own entity. `false` whenever
    /// `ctx.files` has no entry for `self.path` (the back-compat empty
    /// context `analyze_owner_semantics` passes, or a test harness that did
    /// not populate it) or that entry has no entities at all -- never a
    /// guess, matching every other degrade-to-`false`/`Pending` rule in this
    /// module.
    is_test_source: bool,
}

impl<'a, 'ctx, 'r> SemanticWalker<'a, 'ctx, 'r> {
    fn new(
        path: &str,
        scoping: &'ctx Scoping,
        nodes: &'ctx AstNodes<'a>,
        jsdoc_typed_file: bool,
        ctx: &'r HybridResolutionContext<'r>,
        member_qualified_names: BTreeMap<String, String>,
    ) -> Self {
        let module_id = format!("jsts:module:{path}:0:{path}");
        let is_test_source = ctx
            .files
            .get(path)
            .and_then(|file| {
                file.entities
                    .iter()
                    .find(|entity| entity.kind == crate::EntityKind::Module)
            })
            .and_then(|entity| entity.is_test)
            .unwrap_or(false);
        Self {
            path: path.to_owned(),
            module_id,
            scoping,
            nodes,
            callable_stack: Vec::new(),
            sites: Vec::new(),
            reference_rows: Vec::new(),
            call_rows: Vec::new(),
            heritage_rows: Vec::new(),
            typeflow_call_rows: Vec::new(),
            typeflow_heritage_rows: Vec::new(),
            pending_call_sites: Vec::new(),
            pending_heritage_sites: Vec::new(),
            candidate_call_rows: Vec::new(),
            typeflow_oracle_hits: Vec::new(),
            typeflow_pending_call_shapes: Vec::new(),
            class_stack: Vec::new(),
            static_context: Vec::new(),
            param_owner_stack: Vec::new(),
            pending_function_owner: None,
            declarator_owns_entity: false,
            parameter_declarations: BTreeMap::new(),
            referenced_parameter_targets: BTreeSet::new(),
            catch_declarations: BTreeMap::new(),
            referenced_catch_targets: BTreeSet::new(),
            predicate_param_stack: Vec::new(),
            member_qualified_names,
            local_types: HashMap::new(),
            destructured_member_entities: HashMap::new(),
            destructured_pattern_symbols: std::collections::HashSet::new(),
            jsdoc_typed_file,
            ctx,
            current_import_source: None,
            current_export_source: None,
            current_import_type_only: false,
            current_export_type_only: false,
            external_uses: Vec::new(),
            import_bindings: HashMap::new(),
            namespace_import_specifiers: HashMap::new(),
            namespace_reexport_targets: HashMap::new(),
            is_test_source,
        }
    }

    /// Resolve `imported_name`, bound by the import declaration currently
    /// being walked (`current_import_source`), through the workspace
    /// resolver and then through the target module's export table. Any gap
    /// in the chain (no enclosing import context, specifier does not
    /// resolve to a captured file, name not found or ambiguous once there)
    /// degrades to `Pending(REASON_IMPORT_BINDING)` -- never a guess.
    ///
    /// `is_type`/`start`/`end` (external package/symbol entities task): only
    /// consulted for the external-specifier branch (an internal, workspace-
    /// resolved binding's `target_id` already carries its own `EntityKind`/
    /// `core:type` via `classify_symbol_declaration`, so `is_type` is a
    /// no-op there) -- `is_type` is whether THIS binding is `import type`/
    /// `import { type X }`; `start`/`end` are this binding's own site span,
    /// used as the `core:contains` occurrence span `emit_external_use`
    /// records.
    fn resolve_import_binding(
        &mut self,
        imported_name: &str,
        is_type: bool,
        start: u32,
        end: u32,
    ) -> ReferenceResolution {
        let source_specifier = self.current_import_source.clone();
        self.resolve_named_binding_via_specifier(
            source_specifier.as_deref(),
            imported_name,
            REASON_IMPORT_BINDING,
            is_type,
            start,
            end,
        )
    }

    /// 2026-09-04 references-parity task, Phase B bucket 1: the `re_export_
    /// binding` sibling of `resolve_import_binding`, for `local`'s own
    /// position in a WITH-SOURCE export specifier (`export { a } from
    /// "./x"`, `export { a as b } from "./x"` -- `local`("a") is bound by
    /// the OTHER module's own export table, exactly the same shape an
    /// import specifier's `imported` name is, just reached through
    /// `current_export_source` instead of `current_import_source`; see
    /// `visit_export_named_declaration`'s doc comment for why that separate
    /// field exists at all). Before this fix, EVERY re-export specifier
    /// site was unconditionally `Pending(REASON_RE_EXPORT_BINDING)` --
    /// zero attempt, not merely a doubtful case -- found live against the
    /// n8n corpus: 3,528 v3-confirmed reference sites, entirely barrel
    /// files (`packages/@n8n/agents/src/{index,evals/index}.ts`) doing
    /// `export { helpfulness } from "./evals/helpfulness"`-style plain
    /// named re-exports.
    fn resolve_export_source_binding(
        &mut self,
        name: &str,
        is_type: bool,
        start: u32,
        end: u32,
    ) -> ReferenceResolution {
        let source_specifier = self.current_export_source.clone();
        self.resolve_named_binding_via_specifier(
            source_specifier.as_deref(),
            name,
            REASON_RE_EXPORT_BINDING,
            is_type,
            start,
            end,
        )
    }

    /// Shared chain both `resolve_import_binding` and `resolve_export_
    /// source_binding` close: `source_specifier` resolved through the
    /// workspace resolver, then `name` resolved through the target
    /// module's export table (chasing named re-exports transitively).
    /// `pending_reason` is the caller's own reason token, attached to
    /// every degrade-to-pending outcome so the two call sites stay
    /// distinguishable downstream exactly like they were before this
    /// shared helper existed.
    fn resolve_named_binding_via_specifier(
        &mut self,
        source_specifier: Option<&str>,
        name: &str,
        pending_reason: &'static str,
        is_type: bool,
        start: u32,
        end: u32,
    ) -> ReferenceResolution {
        if self.jsdoc_typed_file {
            return ReferenceResolution::Pending(REASON_JSDOC_TYPED_FILE);
        }
        let Some(source_specifier) = source_specifier else {
            return ReferenceResolution::Pending(import_binding_sub_reason(
                pending_reason,
                "no_specifier",
            ));
        };
        let Some(target_path) =
            self.ctx
                .resolver
                .resolve(&self.path, source_specifier, self.ctx.available)
        else {
            // Ambient module resolution task (2026-09-04), fix item 2: a
            // workspace `declare module "source_specifier" { ... }` block
            // gets first refusal, BEFORE the external-entity classification
            // below -- see `resolver::AmbientModuleIndex::resolve_export`'s
            // own doc comment for the exact contract (resolve with
            // certainty, stay pending, or fall through to external -- NEVER
            // fabricate an external entity for a specifier proven to be
            // ambiently declared somewhere in this workspace).
            match self
                .ctx
                .ambient_index
                .resolve_export(source_specifier, name)
            {
                resolver::AmbientResolution::Resolved(target_id) => {
                    return ReferenceResolution::Resolved {
                        target_id,
                        cross_file: true,
                    };
                }
                resolver::AmbientResolution::Ambiguous => {
                    if resolver::classify_external_specifier(source_specifier).is_some() {
                        AMBIGUOUS_AMBIENT_WOULD_BE_EXTERNAL
                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                    return ReferenceResolution::Pending(import_binding_sub_reason(
                        pending_reason,
                        "ambient:ambiguous",
                    ));
                }
                resolver::AmbientResolution::NoDeclaration => {}
            }
            // External package/symbol entities task (2026-09-04, item 2):
            // the SAME resolution the import lane (`finish_import_
            // relations`, lib.rs) uses for its own module-level target_id --
            // reused here verbatim (never re-attempted) so a workspace
            // specifier that simply failed to resolve NEVER gets promoted to
            // "external" (see `classify_external_specifier`'s own doc
            // comment for the exact rule). A genuine external specifier
            // resolves this binding WITH CERTAINTY -- the specifier text
            // itself proves it -- to `jsts:external_symbol:{specifier}#
            // {name}`, `cross_file: true` (it lives outside `self.path` by
            // construction), and records the occurrence for `finish()` to
            // materialize the entity/contains rows from.
            return match resolver::classify_external_specifier(source_specifier) {
                Some(canonical) => {
                    self.emit_external_use(&canonical, name, is_type, start, end, true);
                    ReferenceResolution::Resolved {
                        target_id: resolver::external_symbol_id(&canonical, name),
                        cross_file: true,
                    }
                }
                None => ReferenceResolution::Pending(import_binding_sub_reason(
                    pending_reason,
                    "unresolved_specifier",
                )),
            };
        };
        match resolver::resolve_named_export(self.ctx.files, &target_path, name) {
            resolver::ExportResolution::Resolved(target_id) => {
                // The declaration was reached through an import/re-export
                // specifier, possibly after chasing one or more named
                // re-exports (`resolve_named_export`): it lives outside
                // `self.path` in every non-pathological case (a file
                // re-exporting a name back to itself through another module
                // is not a pattern real code hits in practice, and is not
                // worth a full target-path plumb-through to rule out here
                // -- see `ReferenceRow::cross_file`'s doc comment).
                ReferenceResolution::Resolved {
                    target_id,
                    cross_file: true,
                }
            }
            // P1-B: a namespace re-export (`export * as X from "spec"`) has
            // no single declaration of its own to resolve THIS plain
            // identifier reference to -- stays pending here exactly like
            // `Ambiguous`/`Unresolved` (see `register_namespace_reexport`
            // for the SEPARATE mechanism that makes `evals.member(...)`
            // member access resolve).
            resolver::ExportResolution::Namespace(_) => ReferenceResolution::Pending(
                import_binding_sub_reason(pending_reason, "export:namespace"),
            ),
            resolver::ExportResolution::Ambiguous => ReferenceResolution::Pending(
                import_binding_sub_reason(pending_reason, "export:ambiguous"),
            ),
            resolver::ExportResolution::Unresolved => ReferenceResolution::Pending(
                import_binding_sub_reason(pending_reason, "export:unresolved"),
            ),
        }
    }

    /// External package/symbol entities task: records one external
    /// binding/member-read occurrence -- `finish()` converts the full list
    /// into `OwnerSemantics::external_entity_rows` (deduped by identity)
    /// and `external_contains_rows` (one row per occurrence, undeduped).
    /// Called from every site that resolves an identifier/member to an
    /// external symbol: `resolve_named_binding_via_specifier` (named/
    /// default import, named re-export), `visit_import_namespace_specifier`
    /// (a namespace import's own binding used as a value), and `visit_
    /// static_member_expression` (a namespace-bound identifier's member
    /// read, `ns.member`).
    fn emit_external_use(
        &mut self,
        specifier: &str,
        name: &str,
        is_type: bool,
        start: u32,
        end: u32,
        was_import_binding: bool,
    ) {
        self.external_uses.push(ExternalSymbolUse {
            specifier: specifier.to_owned(),
            name: name.to_owned(),
            is_type,
            start,
            end,
            was_import_binding,
        });
    }

    /// External package/symbol entities task (item 2, namespace member
    /// reads): `object.member_name` where `object` is a plain identifier
    /// bound by `import * as object from "specifier"` and `specifier` is
    /// EXTERNAL (never resolves inside the workspace) -- mirrors `resolve_
    /// namespace_member`'s own identifier/`namespace_import_specifiers`
    /// lookup shape exactly, but for the external case: `namespace_reexport_
    /// targets` (a NAMED import that itself resolved to a namespace
    /// re-export) is never consulted here, since its values are already-
    /// resolved WORKSPACE paths by construction -- an external specifier
    /// never reaches that map at all (`register_namespace_reexport` only
    /// populates it via `resolve_named_export`, a workspace-only chain).
    /// Returns `Ambient` (fix item 2, 2026-09-04: no `emit_external_use`
    /// side effect -- the target already exists, published by the
    /// DECLARING file's own producers) or `External` (canonical specifier
    /// and resolved `target_id`, caller emits the external use), or `None`
    /// for anything but a plain-identifier, workspace-unresolved namespace-
    /// bound member read.
    fn resolve_external_namespace_member(
        &self,
        object: &Expression<'a>,
        member_name: &str,
    ) -> Option<NamespaceMemberResolution> {
        let Expression::Identifier(ident) = object else {
            return None;
        };
        let reference_id = ident.reference_id.get()?;
        let reference = self.scoping.get_reference(reference_id);
        let symbol_id = reference.symbol_id()?;
        let specifier = self.namespace_import_specifiers.get(&symbol_id)?;
        if self
            .ctx
            .resolver
            .resolve(&self.path, specifier, self.ctx.available)
            .is_some()
        {
            // Resolves inside the workspace: `resolve_namespace_member` (the
            // internal-target sibling of this function) owns this case.
            return None;
        }
        // Ambient module resolution task (2026-09-04), fix item 2: same
        // first-refusal order as every other specifier-keyed resolution in
        // this file.
        match self
            .ctx
            .ambient_index
            .resolve_export(specifier, member_name)
        {
            resolver::AmbientResolution::Resolved(target_id) => {
                return Some(NamespaceMemberResolution::Ambient(target_id));
            }
            resolver::AmbientResolution::Ambiguous => {
                if resolver::classify_external_specifier(specifier).is_some() {
                    AMBIGUOUS_AMBIENT_WOULD_BE_EXTERNAL
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
                return None;
            }
            resolver::AmbientResolution::NoDeclaration => {}
        }
        let canonical = resolver::classify_external_specifier(specifier)?;
        let target_id = resolver::external_symbol_id(&canonical, member_name);
        Some(NamespaceMemberResolution::External(canonical, target_id))
    }

    /// P1-B: `evals` in `import { evals } from "../../index"` where
    /// `../../index` does `export * as evals from "./evals/index"` -- see
    /// `NAMESPACE_REEXPORT_LOCAL_NAME`'s doc comment. Chases the SAME
    /// import -> export chain `resolve_import_binding` does (a second,
    /// cheap in-memory pass -- simpler than threading this through that
    /// function's own `&self` return value) and, ONLY when it lands on
    /// `ExportResolution::Namespace`, records `symbol_id` into `namespace_
    /// reexport_targets` for `resolve_namespace_member` to consult later.
    /// A no-op for every other outcome (a plain resolved/ambiguous/
    /// unresolved named import never needs this).
    fn register_namespace_reexport(&mut self, symbol_id: SymbolId, imported_name: &str) {
        if self.jsdoc_typed_file {
            return;
        }
        let Some(source_specifier) = &self.current_import_source else {
            return;
        };
        let Some(target_path) =
            self.ctx
                .resolver
                .resolve(&self.path, source_specifier, self.ctx.available)
        else {
            return;
        };
        if let resolver::ExportResolution::Namespace(reexport_target) =
            resolver::resolve_named_export(self.ctx.files, &target_path, imported_name)
        {
            self.namespace_reexport_targets
                .insert(symbol_id, reexport_target);
        }
    }

    /// Site one position (`local`/`imported` on an `ImportSpecifier`) per an
    /// already-computed `resolution`: `rust_resolved` with a `core:
    /// references` row from the current owner when resolved, otherwise the
    /// ordinary `checker_pending` import-binding site.
    fn site_import_binding(&mut self, start: u32, end: u32, resolution: &ReferenceResolution) {
        match resolution {
            ReferenceResolution::Resolved {
                target_id,
                cross_file,
            } => {
                self.push_site(
                    SiteKind::IdentifierRef,
                    start,
                    end,
                    SiteDisposition::RustResolved,
                    None,
                );
                let source_id = self.current_owner();
                if source_id != *target_id {
                    self.reference_rows.push(ReferenceRow {
                        start,
                        end,
                        source_id,
                        target_id: target_id.clone(),
                        cross_file: *cross_file,
                    });
                }
            }
            ReferenceResolution::Pending(reason) => {
                let reason = self.identifier_pending_reason(reason);
                self.push_site(
                    SiteKind::IdentifierRef,
                    start,
                    end,
                    SiteDisposition::CheckerPending,
                    Some(reason),
                );
            }
        }
    }

    /// The reason to attach to an identifier-kind pending site: the
    /// safe-partition rule's reason once this owner is JSDoc-typed,
    /// otherwise `default` (each call site's own, already-specific reason).
    fn identifier_pending_reason(&self, default: &'static str) -> &'static str {
        if self.jsdoc_typed_file {
            REASON_JSDOC_TYPED_FILE
        } else {
            default
        }
    }

    fn current_owner(&self) -> String {
        self.callable_stack
            .last()
            .cloned()
            .unwrap_or_else(|| self.module_id.clone())
    }

    fn push_site(
        &mut self,
        site_kind: SiteKind,
        start: u32,
        end: u32,
        disposition: SiteDisposition,
        reason: Option<&'static str>,
    ) {
        self.sites.push(SemanticSite {
            start_utf16: start,
            end_utf16: end,
            site_kind,
            disposition,
            reason: reason.map(str::to_owned),
        });
    }

    fn resolve_identifier_reference(&self, ident: &IdentifierReference<'a>) -> ReferenceResolution {
        if self.jsdoc_typed_file {
            return ReferenceResolution::Pending(REASON_JSDOC_TYPED_FILE);
        }
        let Some(reference_id) = ident.reference_id.get() else {
            return ReferenceResolution::Pending(REASON_UNRESOLVED_GLOBAL);
        };
        let reference = self.scoping.get_reference(reference_id);
        let Some(symbol_id) = reference.symbol_id() else {
            return ReferenceResolution::Pending(REASON_UNRESOLVED_GLOBAL);
        };
        let flags = self.scoping.symbol_flags(symbol_id);
        if flags.is_import() {
            // E2: this symbol is bound by an `import`; `import_bindings`
            // carries whatever `visit_import_specifier` already resolved
            // for it (or `None` when the import site has not been visited
            // yet, or was a default/namespace import, both out of scope --
            // see `resolve_import_binding`'s doc comment).
            return self
                .import_bindings
                .get(&symbol_id)
                .cloned()
                .unwrap_or(ReferenceResolution::Pending(REASON_IMPORT_BINDING));
        }
        if !self.scoping.symbol_redeclarations(symbol_id).is_empty() {
            return ReferenceResolution::Pending(REASON_MULTIPLE_DECLARATIONS);
        }
        let Some(kind) = classify_symbol_declaration(self.nodes, self.scoping, symbol_id) else {
            return ReferenceResolution::Pending(REASON_UNSUPPORTED_DECLARATION_KIND);
        };
        let target_start = self.scoping.symbol_span(symbol_id).start;
        let target_name = self.scoping.symbol_name(symbol_id);
        ReferenceResolution::Resolved {
            // Always `&self.path`: a locally bound (non-import) symbol's
            // declaration necessarily lives in this same owner file, so this
            // branch is never a `core:covers` candidate.
            target_id: declaration_id(kind, &self.path, target_start, target_name),
            cross_file: false,
        }
    }

    /// Resolve `ident` (a call's callee identifier, or a heritage clause's
    /// bare-identifier type) to a single declaration whose kind is one of
    /// `allowed`, through the SAME local-symbol/import-chain machinery
    /// `resolve_identifier_reference` already uses for ordinary references
    /// (E3, T1/T2). `None` for every doubtful case: an unresolved global, an
    /// import Rust's resolver could not close to exactly one declaration
    /// (default/namespace imports included -- they never populate
    /// `import_bindings` in the first place, see `resolve_import_binding`'s
    /// doc comment), an overloaded or merged local symbol
    /// (`symbol_redeclarations` non-empty, mirroring
    /// `directCallDeclaration`'s own `symbol.declarations.length !== 1`
    /// guard for the local case), an ambiguous or unresolved cross-file
    /// export (`resolve_named_export`'s own `Ambiguous`/`Unresolved` --
    /// `resolve_direct_export` already treats more than one same-named
    /// top-level entity, e.g. a `TSDeclareFunction` overload sibling, as
    /// `Ambiguous`), or a resolved declaration whose kind is not in
    /// `allowed`. Never a guess -- matches the file's existing "doubt goes
    /// to the checker" contract exactly.
    fn resolve_identifier_to_kind(
        &self,
        ident: &IdentifierReference<'a>,
        allowed: &[DeclKind],
    ) -> Option<String> {
        if self.jsdoc_typed_file {
            return None;
        }
        let reference_id = ident.reference_id.get()?;
        let reference = self.scoping.get_reference(reference_id);
        let symbol_id = reference.symbol_id()?;
        let flags = self.scoping.symbol_flags(symbol_id);
        if flags.is_import() {
            let resolution = self.import_bindings.get(&symbol_id)?;
            let ReferenceResolution::Resolved { target_id, .. } = resolution else {
                return None;
            };
            return target_id_kind_is_one_of(target_id, allowed).then(|| target_id.clone());
        }
        if !self.scoping.symbol_redeclarations(symbol_id).is_empty() {
            return None;
        }
        let kind = classify_symbol_declaration(self.nodes, self.scoping, symbol_id)?;
        if !allowed.contains(&kind) {
            return None;
        }
        let target_start = self.scoping.symbol_span(symbol_id).start;
        let target_name = self.scoping.symbol_name(symbol_id);
        // Always `&self.path`: same reasoning as `resolve_identifier_
        // reference`'s local branch -- a non-import symbol's declaration
        // necessarily lives in this same owner file.
        Some(declaration_id(kind, &self.path, target_start, target_name))
    }

    /// Resolve a `CallExpression`'s target (E3, T1): only when the callee is
    /// a plain identifier (never a member expression, `this`, `super`, or
    /// any other expression -- `new` never even reaches here, see
    /// `visit_call_expression`'s doc comment) AND that identifier resolves,
    /// through `resolve_identifier_to_kind`, to a single function-or-class
    /// declaration. Restricting `allowed` to `Function`/`Class` (never
    /// `Variable`/`Parameter`, though either could legitimately hold a
    /// callable value the checker's own `directCallDeclaration` WOULD
    /// confirm-resolve) is a deliberate narrowing of this task's exact
    /// scope ("declaración de función/clase"): those cases stay with the
    /// checker, unaffected -- see `CallRow`'s doc comment on why this never
    /// creates a parity gap (the checker still resolves and emits that row
    /// itself, Rust just does not compete for it).
    fn resolve_call_target(&self, expr: &CallExpression<'a>) -> Option<String> {
        let Expression::Identifier(callee) = &expr.callee else {
            return None;
        };
        self.resolve_identifier_to_kind(callee, &[DeclKind::Function, DeclKind::Class])
    }

    /// Resolve one heritage clause entry (E3, T2): `self_id` is the
    /// enclosing class/interface's own declaration id (`None` for an
    /// anonymous class -- see `visit_class`'s doc comment), `ident` is
    /// `Some` only when the clause's type is a plain, non-generic identifier
    /// expression (the qualified/generic/mixin cases are ruled out by each
    /// call site BEFORE calling this, by passing `None`). Returns the
    /// `(source_id, target_id)` pair to publish, or the specific pending
    /// reason to attach: `REASON_HERITAGE_DEFERRED` when this clause was
    /// never even a candidate (anonymous enclosing declaration, or a
    /// qualified/generic/mixin type), `REASON_HERITAGE_TARGET_UNCERTAIN`
    /// when a plain identifier WAS attempted but `resolve_identifier_to_kind`
    /// came back empty.
    fn resolve_heritage_clause(
        &self,
        self_id: Option<&str>,
        ident: Option<&IdentifierReference<'a>>,
    ) -> Result<(String, String), &'static str> {
        let (Some(source_id), Some(ident)) = (self_id, ident) else {
            return Err(REASON_HERITAGE_DEFERRED);
        };
        self.resolve_identifier_to_kind(ident, &[DeclKind::Class, DeclKind::Interface])
            .map(|target_id| (source_id.to_owned(), target_id))
            .ok_or(REASON_HERITAGE_TARGET_UNCERTAIN)
    }

    fn current_is_static(&self) -> bool {
        self.static_context.last().copied().unwrap_or(false)
    }

    /// P1-A: classify a `TSType`'s declared shape into a `TypeflowValue`,
    /// the SAME wrapper shapes `urdira_jsts_typeflow::raw_type_ref_of_ts_type`
    /// classifies for a cross-file member/return type (`T[]`/`Array<T>`/
    /// `ReadonlyArray<T>`, `Promise<T>`, a parenthesized type), but resolved
    /// through THIS walker's own `resolve_identifier_to_kind` (local symbol
    /// table + E2 import/export chain) rather than a second file's own
    /// summary -- a local variable/parameter annotation is inherently
    /// owner-local, never something another file's `DeclSummary` could have
    /// captured. `this` as a local annotation type has no meaning (only a
    /// MEMBER's own return type can be `this`) and is not attempted here.
    fn type_ref_of_ts_type(&self, ty: &TSType<'a>) -> Option<TypeflowValue> {
        match ty {
            TSType::TSParenthesizedType(parenthesized) => {
                self.type_ref_of_ts_type(&parenthesized.type_annotation)
            }
            TSType::TSArrayType(array) => Some(TypeflowValue::ArrayOf(Box::new(
                self.type_ref_of_ts_type(&array.element_type)?,
            ))),
            TSType::TSTypeReference(reference) => {
                let TSTypeName::IdentifierReference(ident) = &reference.type_name else {
                    return None;
                };
                let name = ident.name.as_str();
                if let Some(type_arguments) = &reference.type_arguments {
                    if name == "Promise" && type_arguments.params.len() == 1 {
                        return Some(TypeflowValue::PromiseOf(Box::new(
                            self.type_ref_of_ts_type(&type_arguments.params[0])?,
                        )));
                    }
                    if (name == "Array" || name == "ReadonlyArray")
                        && type_arguments.params.len() == 1
                    {
                        return Some(TypeflowValue::ArrayOf(Box::new(
                            self.type_ref_of_ts_type(&type_arguments.params[0])?,
                        )));
                    }
                    // P1-C: see `urdira_jsts_typeflow::raw_type_ref_of_ts_
                    // type`'s own doc comment for the exact same set of
                    // utility types, mirrored here for a LOCAL parameter/
                    // variable annotation (resolved through THIS walker's
                    // own `resolve_identifier_to_kind` instead of a second
                    // file's `DeclSummary` -- see this function's own doc
                    // comment for why).
                    if name == "Record" && type_arguments.params.len() == 2 {
                        return Some(TypeflowValue::RecordOf(Box::new(
                            self.type_ref_of_ts_type(&type_arguments.params[1])?,
                        )));
                    }
                    if matches!(name, "Partial" | "Required" | "Readonly" | "NonNullable")
                        && type_arguments.params.len() == 1
                    {
                        return self.type_ref_of_ts_type(&type_arguments.params[0]);
                    }
                    if matches!(name, "Pick" | "Omit") && type_arguments.params.len() == 2 {
                        return self.type_ref_of_ts_type(&type_arguments.params[0]);
                    }
                    if name == "Awaited" && type_arguments.params.len() == 1 {
                        let mut inner = self.type_ref_of_ts_type(&type_arguments.params[0])?;
                        while let TypeflowValue::PromiseOf(unwrapped) = inner {
                            inner = *unwrapped;
                        }
                        return Some(inner);
                    }
                    if name == "ReturnType" && type_arguments.params.len() == 1 {
                        let TSType::TSTypeQuery(query) = &type_arguments.params[0] else {
                            return None;
                        };
                        let TSTypeQueryExprName::IdentifierReference(fn_ident) = &query.expr_name
                        else {
                            return None;
                        };
                        let index = self.ctx.typeflow_index?;
                        // P1-C: `DeclKind::Variable` too -- `typeof f` may
                        // name a callable VARIABLE (`const f = (...) =>
                        // ...`), not just a `function` declaration; see
                        // `urdira_jsts_typeflow`'s `DeclSummary::
                        // callable_variables` doc comment. `function_
                        // return_type` is populated for both kinds by
                        // `ProgramIndex::build`, keyed by whichever entity
                        // id the declaration site actually produced.
                        let entity_id = self.resolve_identifier_to_kind(
                            fn_ident,
                            &[DeclKind::Function, DeclKind::Variable],
                        )?;
                        let type_ref = index.function_return_type(&entity_id)?;
                        return Self::resolve_type_ref_relative(&type_ref, None);
                    }
                    if name == "InstanceType" && type_arguments.params.len() == 1 {
                        let TSType::TSTypeQuery(query) = &type_arguments.params[0] else {
                            return None;
                        };
                        let TSTypeQueryExprName::IdentifierReference(inst_ident) = &query.expr_name
                        else {
                            return None;
                        };
                        let entity_id = self.resolve_identifier_to_kind(
                            inst_ident,
                            &[DeclKind::Class, DeclKind::Interface],
                        )?;
                        return Some(TypeflowValue::Entity {
                            entity_id,
                            is_static: false,
                        });
                    }
                }
                let entity_id = self
                    .resolve_identifier_to_kind(ident, &[DeclKind::Class, DeclKind::Interface])?;
                Some(TypeflowValue::Entity {
                    entity_id,
                    is_static: false,
                })
            }
            // P1-A (rule (j), local half): see `TypeflowValue::Inline`'s
            // doc comment. A member with an unresolvable type (a plain
            // data property whose own type this crate does not classify,
            // a computed/private key, ...) is simply absent from the
            // list -- consulted the same "found or not" way `ProgramIndex::
            // member_type_ref` is, never a guess.
            TSType::TSTypeLiteral(literal) => {
                let members = literal
                    .members
                    .iter()
                    .filter_map(|signature| self.inline_member_of_signature(signature))
                    .collect();
                Some(TypeflowValue::Inline(members))
            }
            // P2-2j: `A | B` -- mirrors `urdira_jsts_typeflow::raw_type_ref_
            // of_ts_type`'s own `TSUnionType` arm exactly (drop null/
            // undefined/literal/primitive constituents, contaminate to
            // `None` on any other unclassified remaining constituent,
            // dedupe, collapse a single survivor) -- see that crate's
            // `RawTypeRef::Union` doc comment for the full rationale.
            TSType::TSUnionType(union) => {
                let mut constituents: Vec<TypeflowValue> = Vec::new();
                for member in &union.types {
                    if is_dropped_union_constituent(member) {
                        continue;
                    }
                    let value = self.type_ref_of_ts_type(member)?;
                    if !constituents.contains(&value) {
                        constituents.push(value);
                    }
                }
                match constituents.len() {
                    0 => None,
                    1 => constituents.into_iter().next(),
                    _ => Some(TypeflowValue::Union(constituents)),
                }
            }
            _ => None,
        }
    }

    /// One `(name, type)` pair contributed by a signature inside an inline
    /// `{ ... }` type literal -- see `TypeflowValue::Inline`'s doc comment.
    /// A method signature's own "type" (for member-access purposes) is its
    /// declared RETURN type, matching `MemberEntry`'s own convention in
    /// `urdira-jsts-typeflow` exactly.
    fn inline_member_of_signature(
        &self,
        signature: &TSSignature<'a>,
    ) -> Option<(String, TypeflowValue)> {
        match signature {
            TSSignature::TSPropertySignature(property) => {
                let (_, name) = property_key_name(&property.key)?;
                let value = self.type_ref_of_annotation(property.type_annotation.as_deref())?;
                Some((name, value))
            }
            TSSignature::TSMethodSignature(method) => {
                let (_, name) = property_key_name(&method.key)?;
                let value = self.type_ref_of_annotation(method.return_type.as_deref())?;
                Some((name, value))
            }
            _ => None,
        }
    }

    /// `type_ref_of_ts_type` over an optional `TSTypeAnnotation` (a
    /// variable/parameter's own `: T` annotation site).
    fn type_ref_of_annotation(
        &self,
        annotation: Option<&TSTypeAnnotation<'a>>,
    ) -> Option<TypeflowValue> {
        self.type_ref_of_ts_type(&annotation?.type_annotation)
    }

    /// P1-A: resolve a `ResolvedTypeRef` (a cross-file member/function
    /// return type, already closed against imports by `ProgramIndex`)
    /// relative to `this_context` -- TypeScript's own `this` return type
    /// resolves to WHATEVER RECEIVER the call was made on (a fluent
    /// builder's `description(): this` returns the SAME runtime type as its
    /// receiver, not a fixed class), everything else maps straight across.
    /// `this_context` is `None` for a free function's return type (a `this`
    /// return type is meaningless there and stays unresolved, never a
    /// guess).
    fn resolve_type_ref_relative(
        type_ref: &urdira_jsts_typeflow::ResolvedTypeRef,
        this_context: Option<&TypeflowValue>,
    ) -> Option<TypeflowValue> {
        match type_ref {
            urdira_jsts_typeflow::ResolvedTypeRef::Entity(entity_id) => {
                Some(TypeflowValue::Entity {
                    entity_id: entity_id.clone(),
                    is_static: false,
                })
            }
            urdira_jsts_typeflow::ResolvedTypeRef::ThisType => this_context.cloned(),
            urdira_jsts_typeflow::ResolvedTypeRef::ArrayOf(inner) => Some(TypeflowValue::ArrayOf(
                Box::new(Self::resolve_type_ref_relative(inner, this_context)?),
            )),
            urdira_jsts_typeflow::ResolvedTypeRef::PromiseOf(inner) => {
                Some(TypeflowValue::PromiseOf(Box::new(
                    Self::resolve_type_ref_relative(inner, this_context)?,
                )))
            }
            urdira_jsts_typeflow::ResolvedTypeRef::RecordOf(inner) => {
                Some(TypeflowValue::RecordOf(Box::new(
                    Self::resolve_type_ref_relative(inner, this_context)?,
                )))
            }
            // P2-2j: resolve every constituent relative to the SAME
            // receiver context, or none at all -- see `TypeflowValue::
            // Union`'s doc comment.
            urdira_jsts_typeflow::ResolvedTypeRef::Union(items) => {
                let mut resolved = Vec::with_capacity(items.len());
                for item in items {
                    resolved.push(Self::resolve_type_ref_relative(item, this_context)?);
                }
                Some(TypeflowValue::Union(resolved))
            }
        }
    }

    /// The `(entity_id, is_static)` pair a `TypeflowValue` carries, when it
    /// is itself directly a class/interface entity (never an `ArrayOf`/
    /// `PromiseOf` wrapper -- those need an explicit unwrap first, e.g.
    /// `a[i]`/`await`, before they can be used as a member-access/call
    /// base). Shared by every call site that needs a concrete container to
    /// look a member up on.
    fn as_entity(value: &TypeflowValue) -> Option<(String, bool)> {
        match value {
            TypeflowValue::Entity {
                entity_id,
                is_static,
            } => Some((entity_id.clone(), *is_static)),
            // P2-2j: a `Union` is never a SINGLE entity by construction --
            // conservative and intended, same as every other wrapper below;
            // `as_entities` is the sibling helper that handles a `Union`
            // receiver instead (used ONLY by the call-target resolver's own
            // union branch -- every other caller of `as_entity` stays
            // conservative for a union receiver used in a further chain
            // position, e.g. `(a as A | B).method().further()`, which is
            // out of this round's scope).
            TypeflowValue::ArrayOf(_)
            | TypeflowValue::PromiseOf(_)
            | TypeflowValue::RecordOf(_)
            | TypeflowValue::Inline(_)
            | TypeflowValue::Union(_) => None,
        }
    }

    /// P2-2j: the entity id(s) `value` denotes, generalizing `as_entity` to
    /// also accept a `TypeflowValue::Union` receiver (`a: A | B`) -- returns
    /// EVERY constituent's own entity id, all sharing the SAME `is_static`
    /// (a well-typed union's own constituents are never independently
    /// static/instance -- TypeScript itself would reject mixing a class
    /// used statically with an instance type in the same union). A plain
    /// `Entity` yields a one-element list, so a caller can go through this
    /// ONE path uniformly for both the ordinary and union cases. `None`
    /// (never a guess) when ANY constituent of a `Union` is not itself a
    /// plain entity (a nested `ArrayOf`/`Inline`/... constituent, out of
    /// scope this round), or for any other non-entity `TypeflowValue` shape
    /// (same as `as_entity`).
    fn as_entities(value: &TypeflowValue) -> Option<(Vec<String>, bool)> {
        match value {
            TypeflowValue::Entity { .. } => {
                let (entity_id, is_static) = Self::as_entity(value)?;
                Some((vec![entity_id], is_static))
            }
            TypeflowValue::Union(items) => {
                let mut ids = Vec::with_capacity(items.len());
                let mut union_is_static: Option<bool> = None;
                for item in items {
                    let (entity_id, is_static) = Self::as_entity(item)?;
                    match union_is_static {
                        Some(existing) if existing != is_static => return None,
                        Some(_) => {}
                        None => union_is_static = Some(is_static),
                    }
                    ids.push(entity_id);
                }
                Some((ids, union_is_static.unwrap_or(false)))
            }
            TypeflowValue::ArrayOf(_)
            | TypeflowValue::PromiseOf(_)
            | TypeflowValue::RecordOf(_)
            | TypeflowValue::Inline(_) => None,
        }
    }

    /// The type of member `name` on `value`, when `value` is itself an
    /// inline `{ ... }` type literal (`TypeflowValue::Inline`) -- a linear
    /// scan, never a guess for a missing member. `None` (not just "member
    /// missing") for any OTHER `TypeflowValue` shape, so a caller can
    /// `.or_else` into the entity-based `ProgramIndex::member_type_ref`
    /// path without double-attempting the same lookup two different ways.
    fn inline_member(value: &TypeflowValue, name: &str) -> Option<TypeflowValue> {
        let TypeflowValue::Inline(members) = value else {
            return None;
        };
        members
            .iter()
            .find(|(member_name, _)| member_name == name)
            .map(|(_, member_value)| member_value.clone())
    }

    /// P1-A (rule (b), `new T()` initializer shape folded in): `Some(entity_id)`
    /// only for a bare `new T(...)` whose callee is a plain identifier
    /// resolving to a class declaration -- a qualified/generic/computed
    /// callee, or a target that is not itself a class, is never attempted.
    fn new_expression_type_entity(&self, expr: &Expression<'a>) -> Option<String> {
        let Expression::NewExpression(new_expr) = expr else {
            return None;
        };
        let Expression::Identifier(ident) = &new_expr.callee else {
            return None;
        };
        self.resolve_identifier_to_kind(ident, &[DeclKind::Class])
    }

    /// P1-A: the static type of `expr`, recursively -- this is the single
    /// entry point every typeflow call/member/heritage rule in this walker
    /// now goes through (widened from P0-S2's `typeflow_object_base`, which
    /// only handled `this`/`super`/a plain identifier). Handles: `this`/
    /// `super` (current `class_stack` frame); a plain identifier (a class/
    /// interface name used statically, else a local variable/parameter this
    /// walk already typed via `local_types`); `new T(...)` (rule (b)); a
    /// call expression, resolved through `type_of_call_expression` (rule
    /// (a): a free function's declared return type, OR -- the fluent-chain
    /// case -- a member call's declared return type, `this` included);
    /// `a.b` member access, resolved by looking up `b`'s own declared type
    /// on `a`'s type (rule (a)'s property-chain half, plus rule (h)'s
    /// object-shape access once `a`'s own type is a container); `a[i]`
    /// array element access unwrapping one `ArrayOf` layer (rule (g));
    /// `await x` unwrapping one `PromiseOf` layer (rule (c)); and
    /// parenthesized/`as T`/`<T>x`/`x!`/optional-chain (`a?.b`) transparency
    /// (rule (d)). Anything else (a template/conditional/logical/object-
    /// literal/array-literal expression, a computed callee this walker
    /// cannot type, ...) is `None` -- never a guess, exactly like every
    /// other typeflow rule in this file.
    fn type_of_expression(&self, expr: &Expression<'a>) -> Option<(TypeflowValue, &'static str)> {
        match expr {
            Expression::ThisExpression(_) => {
                let frame = self.class_stack.last()?;
                Some((
                    TypeflowValue::Entity {
                        entity_id: frame.entity_id.clone()?,
                        is_static: self.current_is_static(),
                    },
                    "this",
                ))
            }
            Expression::Super(_) => {
                let frame = self.class_stack.last()?;
                Some((
                    TypeflowValue::Entity {
                        entity_id: frame.extends_entity_id.clone()?,
                        is_static: self.current_is_static(),
                    },
                    "super",
                ))
            }
            Expression::Identifier(ident) => {
                if let Some(entity_id) =
                    self.resolve_identifier_to_kind(ident, &[DeclKind::Class, DeclKind::Interface])
                {
                    return Some((
                        TypeflowValue::Entity {
                            entity_id,
                            is_static: true,
                        },
                        "member_class_static",
                    ));
                }
                let reference_id = ident.reference_id.get()?;
                let reference = self.scoping.get_reference(reference_id);
                let symbol_id = reference.symbol_id()?;
                if let Some(tagged) = self.local_types.get(&symbol_id).cloned() {
                    return Some(tagged);
                }
                // P1-A: widens `resolve_identifier_to_kind` to allow
                // `Variable` for a top-level `const X` this crate captured
                // EITHER an explicit declared type OR an inferred object-
                // literal shape for -- see `VariableSummary`'s doc comment
                // for why the two are tried in this exact order (an
                // explicit annotation always wins over the initializer's
                // own structural shape, matching TypeScript exactly; found
                // live as a wrong-target regression before this ordering
                // was enforced: `const allNodesConnected: BinaryCheck = {
                // ..., run() {...} }` resolves `.run` to `BinaryCheck`'s
                // OWN member, never the object literal's). An ordinary
                // variable holding, say, a number is neither a declared-
                // type nor object-shape entry and correctly falls through
                // to `None`.
                let index = self.ctx.typeflow_index?;
                let entity_id = self.resolve_identifier_to_kind(ident, &[DeclKind::Variable])?;
                if let Some(type_ref) = index.variable_declared_type(&entity_id) {
                    return Self::resolve_type_ref_relative(&type_ref, None)
                        .map(|value| (value, "variable_declared_type"));
                }
                index.is_container(&entity_id).then_some((
                    TypeflowValue::Entity {
                        entity_id,
                        is_static: false,
                    },
                    "object_shape_static",
                ))
            }
            Expression::NewExpression(_) => {
                let entity_id = self.new_expression_type_entity(expr)?;
                Some((
                    TypeflowValue::Entity {
                        entity_id,
                        is_static: false,
                    },
                    "member_new_expression",
                ))
            }
            Expression::ParenthesizedExpression(parenthesized) => {
                let (value, rule) = self.type_of_expression(&parenthesized.expression)?;
                Some((
                    value,
                    if rule == "this" || rule == "super" {
                        rule
                    } else {
                        "parenthesized"
                    },
                ))
            }
            Expression::TSNonNullExpression(inner) => {
                let (value, rule) = self.type_of_expression(&inner.expression)?;
                Some((
                    value,
                    if rule == "this" || rule == "super" {
                        rule
                    } else {
                        "non_null"
                    },
                ))
            }
            Expression::TSAsExpression(as_expr) => {
                let value = self.type_ref_of_ts_type(&as_expr.type_annotation)?;
                Some((value, "as_expression"))
            }
            Expression::TSTypeAssertion(assertion) => {
                let value = self.type_ref_of_ts_type(&assertion.type_annotation)?;
                Some((value, "type_assertion"))
            }
            Expression::AwaitExpression(await_expr) => {
                let (value, rule) = self.type_of_expression(&await_expr.argument)?;
                match value {
                    TypeflowValue::PromiseOf(inner) => Some((*inner, "await")),
                    other => Some((other, rule)),
                }
            }
            Expression::ChainExpression(chain) => self.type_of_chain_element(&chain.expression),
            Expression::CallExpression(call) => self.type_of_call_expression(call),
            Expression::StaticMemberExpression(member) => self.type_of_static_member(member),
            Expression::ComputedMemberExpression(member) => self.type_of_computed_member(member),
            _ => None,
        }
    }

    fn type_of_chain_element(
        &self,
        element: &ChainElement<'a>,
    ) -> Option<(TypeflowValue, &'static str)> {
        match element {
            ChainElement::CallExpression(call) => self.type_of_call_expression(call),
            ChainElement::StaticMemberExpression(member) => self.type_of_static_member(member),
            ChainElement::ComputedMemberExpression(member) => self.type_of_computed_member(member),
            ChainElement::PrivateFieldExpression(_) | ChainElement::TSNonNullExpression(_) => None,
        }
    }

    /// `a.b` (property access, no call): rule (a)'s property-chain half --
    /// resolve `a`'s own type, then look up `b`'s declared type on it
    /// through `ProgramIndex::member_type_ref`, resolved relative to `a`'s
    /// own entity (so a `this`-typed property behaves the same way a
    /// `this`-returning method does).
    fn type_of_static_member(
        &self,
        member: &StaticMemberExpression<'a>,
    ) -> Option<(TypeflowValue, &'static str)> {
        let (base_value, _rule) = self.type_of_expression(&member.object)?;
        if let Some(value) = Self::inline_member(&base_value, member.property.name.as_str()) {
            return Some((value, "inline_type_literal_member"));
        }
        let index = self.ctx.typeflow_index?;
        let (base_entity, is_static) = Self::as_entity(&base_value)?;
        let type_ref =
            index.member_type_ref(&base_entity, member.property.name.as_str(), is_static)?;
        let this_context = TypeflowValue::Entity {
            entity_id: base_entity,
            is_static: false,
        };
        let resolved = Self::resolve_type_ref_relative(&type_ref, Some(&this_context))?;
        Some((resolved, "member_declared_type_chain"))
    }

    /// `a[i]` (rule (g)): only when `a`'s own type is known to be an array
    /// (`TypeflowValue::ArrayOf`, from an explicit `T[]`/`Array<T>`
    /// annotation or return type) -- the index expression's own value is
    /// never inspected (any index unwraps the SAME element type).
    fn type_of_computed_member(
        &self,
        member: &ComputedMemberExpression<'a>,
    ) -> Option<(TypeflowValue, &'static str)> {
        let (base_value, _rule) = self.type_of_expression(&member.object)?;
        match base_value {
            TypeflowValue::ArrayOf(inner) => Some((*inner, "array_element")),
            // P1-C: `a[i]`/`a["x"]` on a `Record<K, V>`-typed base unwraps
            // to `V` the same way an array element access does -- the key
            // expression's own value is never inspected, matching `ArrayOf`.
            TypeflowValue::RecordOf(inner) => Some((*inner, "record_element")),
            // P2-2j: a computed access on a union receiver (`(a as A | B)
            // [i]`) is not attempted -- conservative and intended, same as
            // `Entity`/`PromiseOf`/`Inline` below (none of those are an
            // array/record shape to unwrap an element type from either).
            TypeflowValue::Entity { .. }
            | TypeflowValue::PromiseOf(_)
            | TypeflowValue::Inline(_)
            | TypeflowValue::Union(_) => None,
        }
    }

    /// The static type of a CALL expression's result (rule (a)): an
    /// identifier callee resolves to a top-level function declaration's own
    /// declared return type (`ProgramIndex::function_return_type`); a
    /// member callee (`a.b(...)`) resolves `b`'s declared return type on
    /// `a`'s own type the same way `type_of_static_member` does for a
    /// non-called property access, `this` return types included -- this is
    /// the fluent/builder-chain rule: `createTool({...}).description(...)
    /// .input(...)` propagates `Tool`'s own entity through every `.method()`
    /// hop as long as each one's declared return type is `this`.
    fn type_of_call_expression(
        &self,
        call: &CallExpression<'a>,
    ) -> Option<(TypeflowValue, &'static str)> {
        let index = self.ctx.typeflow_index?;
        match &call.callee {
            Expression::Identifier(ident) => {
                if let Some(entity_id) =
                    self.resolve_identifier_to_kind(ident, &[DeclKind::Function])
                    && let Some(type_ref) = index.function_return_type(&entity_id)
                    && let Some(resolved) = Self::resolve_type_ref_relative(&type_ref, None)
                {
                    return Some((resolved, "call_return_type"));
                }
                // P1-B: `createTable(...)` where `createTable` is a
                // DESTRUCTURED method-valued binding (`local_types`
                // already stores its OWN declared return type as the
                // binding's "value" -- see `record_destructured_object_
                // types`'s doc comment: a method member's `type_ref` IS
                // its return type by construction, never a separate
                // "callable" wrapper) or any other local/parameter this
                // walk has typed via a call-returning declared shape
                // (found live: the migration DSL's `up({ schemaBuilder: {
                // createTable, column } }: MigrationContext) { createTable(
                // name).withColumns(...) }` pattern, repeated across
                // `packages/@n8n/db/src/migrations/**`). Calling the SAME
                // binding a plain identifier reference would ALSO see this
                // exact value (`type_of_expression`'s own `Identifier`
                // arm), so this is not a new lookup, only a new USE of an
                // existing one -- sound because a well-typed corpus never
                // calls a binding whose recorded type came from anything
                // but a return type in the first place (a non-callable
                // local's own type is never consulted this way in
                // practice).
                let reference_id = ident.reference_id.get()?;
                let reference = self.scoping.get_reference(reference_id);
                let symbol_id = reference.symbol_id()?;
                let (value, _rule) = self.local_types.get(&symbol_id)?.clone();
                Some((value, "call_through_locally_typed_callable"))
            }
            Expression::StaticMemberExpression(member) => {
                if let Some((base_value, _rule)) = self.type_of_expression(&member.object) {
                    if let Some(value) =
                        Self::inline_member(&base_value, member.property.name.as_str())
                    {
                        return Some((value, "inline_type_literal_member"));
                    }
                    if let Some((base_entity, is_static)) = Self::as_entity(&base_value)
                        && let Some(type_ref) = index.member_type_ref(
                            &base_entity,
                            member.property.name.as_str(),
                            is_static,
                        )
                    {
                        let this_context = TypeflowValue::Entity {
                            entity_id: base_entity,
                            is_static: false,
                        };
                        let resolved =
                            Self::resolve_type_ref_relative(&type_ref, Some(&this_context))?;
                        return Some((resolved, "call_chain_this_return"));
                    }
                }
                // P1-A (rule (f)): `ns.fn(...)` used as a chain receiver
                // (`ns.fn().method()`) -- `ns` is not a class/interface, so
                // the branch above never even attempts it; resolve `fn`
                // directly to its target module's own declaration and use
                // ITS declared return type instead.
                let target_id =
                    self.resolve_namespace_member(&member.object, member.property.name.as_str())?;
                let type_ref = index.function_return_type(&target_id)?;
                let resolved = Self::resolve_type_ref_relative(&type_ref, None)?;
                Some((resolved, "namespace_member_call_return_type"))
            }
            _ => None,
        }
    }

    /// P1-A (rule (f)): resolve `object.member_name` when `object` is a
    /// plain identifier bound EITHER by `import * as object from
    /// "specifier"` (a raw specifier, resolved here) OR (P1-B) by a NAMED
    /// import that itself resolved to a namespace re-export (`namespace_
    /// reexport_targets`, already a resolved path -- see that field's own
    /// doc comment) -- the SAME import -> export -> declaration closure
    /// `resolve_import_binding` uses for an ordinary NAMED import
    /// (`WorkspaceResolver::resolve` + `resolver::resolve_named_export`),
    /// just keyed by the member name at the USE site rather than a name
    /// captured once at the import site. `None` for anything but a plain
    /// identifier object, an unresolved/ambiguous export, or an object that
    /// is neither kind of namespace binding at all -- never a guess.
    fn resolve_namespace_member(
        &self,
        object: &Expression<'a>,
        member_name: &str,
    ) -> Option<String> {
        let Expression::Identifier(ident) = object else {
            return None;
        };
        let reference_id = ident.reference_id.get()?;
        let reference = self.scoping.get_reference(reference_id);
        let symbol_id = reference.symbol_id()?;
        let target_path = match self.namespace_import_specifiers.get(&symbol_id) {
            Some(specifier) => {
                self.ctx
                    .resolver
                    .resolve(&self.path, specifier, self.ctx.available)?
            }
            None => self.namespace_reexport_targets.get(&symbol_id)?.clone(),
        };
        match resolver::resolve_named_export(self.ctx.files, &target_path, member_name) {
            resolver::ExportResolution::Resolved(target_id) => Some(target_id),
            resolver::ExportResolution::Namespace(_)
            | resolver::ExportResolution::Ambiguous
            | resolver::ExportResolution::Unresolved => None,
        }
    }

    /// P1-A: record `binding`'s declared type (see `local_types`'s doc
    /// comment) from whichever source resolved one -- an explicit type
    /// annotation (rule (a)/(g)/(c)'s local-annotation half), else (rule
    /// (b), unannotated `const`/`let`) recursively through the initializer
    /// expression itself via `type_of_expression`. Does nothing when
    /// `binding` is not a plain identifier or neither source resolves (the
    /// binding is simply absent from `local_types`, which `type_of_
    /// expression`'s `Identifier` arm already treats as "untyped", never a
    /// guess).
    fn record_local_type(
        &mut self,
        binding: &BindingPattern<'a>,
        annotation: Option<&TSTypeAnnotation<'a>>,
        initializer: Option<&Expression<'a>>,
    ) {
        if self.ctx.typeflow_index.is_none() {
            return;
        }
        let tagged = self
            .type_ref_of_annotation(annotation)
            .map(|value| (value, "member_declared_type"))
            .or_else(|| initializer.and_then(|init| self.type_of_expression(init)));
        match binding {
            BindingPattern::BindingIdentifier(ident) => {
                if let (Some(symbol_id), Some(tagged)) = (ident.symbol_id.get(), tagged) {
                    self.local_types.insert(symbol_id, tagged);
                }
            }
            // P1-A (rule (h)): `const { a, b: renamed } = expr` / a
            // destructured parameter -- type each simple-identifier
            // property from `expr`'s (or the annotation's) own resolved
            // type's member table. Nested patterns (`{ a: { b } }`),
            // computed keys, a rest element, and array destructuring
            // (`const [a] = arr]`) are all out of scope -- left pending,
            // never a guess.
            BindingPattern::ObjectPattern(pattern) => {
                if let Some((base_value, _rule)) = tagged {
                    self.record_destructured_object_types(pattern, &base_value);
                }
            }
            _ => {}
        }
    }

    /// P1-A (rule (h)): see `record_local_type`'s `ObjectPattern` arm.
    fn record_destructured_object_types(
        &mut self,
        pattern: &ObjectPattern<'a>,
        base_value: &TypeflowValue,
    ) {
        let Some(index) = self.ctx.typeflow_index else {
            return;
        };
        let Some((base_entity, is_static)) = Self::as_entity(base_value) else {
            return;
        };
        for property in &pattern.properties {
            if property.computed {
                continue;
            }
            let Some((_, key_name)) = property_key_name(&property.key) else {
                continue;
            };
            // 2026-09-05 A5 references-parity task, Paso 0 (diagnosis
            // only): see `destructured_pattern_symbols`'s own doc comment
            // -- recorded unconditionally, BEFORE either lookup below can
            // fail, so `member_access_sub_reason` can tell "this receiver
            // came from an object-destructuring binding" apart from an
            // ordinary untyped local even when the member's own type never
            // resolved.
            if let BindingPattern::BindingIdentifier(ident) = &property.value
                && let Some(symbol_id) = ident.symbol_id.get()
            {
                self.destructured_pattern_symbols.insert(symbol_id);
            }
            // P1-C: the member's own DECLARATION entity id (never its
            // return type) -- attempted independently of the `member_type_
            // ref` lookup below, since a member whose own declared return
            // type this crate cannot classify (`dropColumns(): void`,
            // `RawTypeRef::Unknown` -- `void` has no `raw_type_ref_of_ts_
            // type` arm) still has a perfectly good declaration id, needed
            // for a BARE call with no further chaining. See `destructured_
            // member_entities`'s own doc comment for why this is a
            // SEPARATE map from `local_types`.
            if let BindingPattern::BindingIdentifier(ident) = &property.value
                && let Some(symbol_id) = ident.symbol_id.get()
                && let urdira_jsts_typeflow::MemberLookup::One(member_entity_id) =
                    index.members(&base_entity, &key_name, is_static)
            {
                self.destructured_member_entities
                    .insert(symbol_id, member_entity_id);
            }
            let Some(type_ref) = index.member_type_ref(&base_entity, &key_name, is_static) else {
                continue;
            };
            let this_context = TypeflowValue::Entity {
                entity_id: base_entity.clone(),
                is_static: false,
            };
            let Some(resolved) = Self::resolve_type_ref_relative(&type_ref, Some(&this_context))
            else {
                continue;
            };
            match &property.value {
                BindingPattern::BindingIdentifier(ident) => {
                    if let Some(symbol_id) = ident.symbol_id.get() {
                        self.local_types
                            .insert(symbol_id, (resolved, "destructured_property"));
                    }
                }
                // P1-C: `{ schemaBuilder: { dropColumns } }` -- a NESTED
                // destructuring pattern, found live in this corpus's own
                // migration DSL (every `up`/`down` migration method
                // destructures `schemaBuilder` straight through to its own
                // members, never binding a `schemaBuilder` local at all).
                // One level of recursion, matching this whole function's
                // own "never widen past what's proven" discipline: `key_
                // name`'s OWN declared type (just resolved above) becomes
                // the base for `nested`'s own property lookups -- exactly
                // the same call this function's caller already makes for
                // the OUTER pattern, just against a DIFFERENT base entity.
                BindingPattern::ObjectPattern(nested) => {
                    self.record_destructured_object_types(nested, &resolved);
                }
                _ => {}
            }
        }
    }

    /// P0-S2/P1-A typeflow (widens E3's T1 to member-access/`this`/`super`/
    /// chained-call calls): `Resolved(target_id, rule)` only when the callee
    /// is `<base>.<member>` AND `type_of_expression` resolves `<base>` to a
    /// concrete entity (or, P2-2j, a UNION of entities) AND the member
    /// lookup finds EXACTLY ONE matching member -- an overloaded member
    /// (`MemberLookup::Many`) or a union receiver with at least one
    /// candidate on every constituent (`MemberLookup::UnionCandidates`)
    /// produces `Candidates` instead; a miss (either lookup's own `None`)
    /// or anything this function does not attempt produces `Unresolved` --
    /// never a guess.
    /// P0-S2/P1-A typeflow, member READS (2026-09-04 references-parity
    /// task; widens `resolve_call_target_typeflow`'s callee-only scope to
    /// EVERY `<base>.<member>` position): `Some(target_id)` only when the
    /// object's own type resolves to a SINGLE concrete entity
    /// (`type_of_expression` + `Self::as_entity` -- `this`/`super` included,
    /// resolved from `class_stack` same as everywhere else) AND
    /// `ProgramIndex::members` finds EXACTLY ONE matching member
    /// (`MemberLookup::One`). A union receiver (`as_entity` already returns
    /// `None` for `TypeflowValue::Union`), an overloaded member (`Many`), or
    /// a miss (`None`) all stay `None` here -- unlike the call lane, a
    /// member READ never gets a `possible`-with-candidates row: this crate's
    /// zero-wrong-target discipline means "ambiguous" and "unresolved"
    /// collapse to the exact same (silent, still-pending) outcome for a
    /// reference, since only a fully-`Resolved` lookup ever publishes a
    /// `core:references` row at all.
    ///
    /// No special-casing for a call callee (`obj.method()`) or an
    /// assignment target (`this.x = 1`) -- verified live against v3's own
    /// `analyzer.ts` `walk`: `isIdentifier(node)` fires through the
    /// UNCONDITIONAL `node.forEachChild(walk)` recursion for every
    /// property-access name, regardless of surrounding position. Neither a
    /// call's callee nor an assignment's LHS carries any exclusion of its
    /// own there -- `isDeclarationName` only ever excludes an actual
    /// DECLARATION's own name node (`declared !== undefined` requires the
    /// PARENT to itself be a registered entity, which a
    /// `PropertyAccessExpression` never is). v3 therefore emits a
    /// `core:references` row for `method` in `obj.method()` in ADDITION to
    /// the separate `core:call` row for the whole call expression -- mirrored
    /// here by simply never special-casing the callee position at all:
    /// `visit_call_expression`'s own call-target resolution and this
    /// member-read resolution independently visit the SAME
    /// `StaticMemberExpression` node (the callee) and each publish their
    /// own relation kind, exactly like the checker does.
    fn resolve_static_member_reference(&self, expr: &StaticMemberExpression<'a>) -> Option<String> {
        if let Some(index) = self.ctx.typeflow_index
            && let Some((base_value, _rule)) = self.type_of_expression(&expr.object)
            && let Some((base_entity, is_static)) = Self::as_entity(&base_value)
            && let urdira_jsts_typeflow::MemberLookup::One(target) =
                index.members(&base_entity, expr.property.name.as_str(), is_static)
        {
            return Some(target);
        }
        // 2026-09-05 A5 references-parity task, Paso 1 fix Form 1: a
        // namespace-import-bound identifier read as a plain VALUE (not a
        // call callee) -- `(transport.odooApiRequest as jest.Mock).
        // mockResolvedValue(...)` where `transport` is bound by `import *
        // as transport from "./transport"` (or a named import that itself
        // resolved to a namespace re-export -- see `resolve_namespace_
        // member`'s own doc comment for both cases). `type_of_expression`'s
        // `Identifier` arm never types a namespace-import binding at all
        // (it is not a class/interface, never enters `local_types`, and is
        // not a `Variable` declaration with an interned type), so the
        // typeflow attempt above always misses for this receiver shape --
        // exactly the SAME gap `type_of_call_expression`'s own member-
        // callee branch (rule (f)) already closes for a CALLED member
        // (`ns.fn(...)`); this reuses the identical mechanism for an
        // uncalled member read, never a new heuristic.
        self.resolve_namespace_member(&expr.object, expr.property.name.as_str())
    }

    /// 2026-09-05 A5 references-parity task, Paso 0 (diagnosis only): the
    /// receiver-shape classification the task brief names for a pending
    /// `member_access` site -- `ident:import_bound` (a plain identifier
    /// bound by a namespace import/re-export, OR a named import -- any
    /// `import_bindings` entry), `ident:param_destructured` (a binding
    /// introduced by destructuring an `ObjectPattern` -- see `destructured_
    /// pattern_symbols`'s own doc comment), `ident:local_untyped` (any
    /// other plain identifier), `call_chain` (the receiver is itself a
    /// call or a further member/chain expression), `this`, `other`
    /// (anything else -- a literal, a parenthesized/`as`/non-null
    /// expression, ...). See `import_binding_sub_reason`'s doc comment for
    /// why this changes nothing observable outside this crate's own debug
    /// dump/tests.
    fn member_access_sub_reason(&self, object: &Expression<'a>) -> &'static str {
        match object {
            Expression::ThisExpression(_) => "member_access/this",
            Expression::CallExpression(_)
            | Expression::StaticMemberExpression(_)
            | Expression::ComputedMemberExpression(_)
            | Expression::ChainExpression(_) => "member_access/call_chain",
            Expression::Identifier(ident) => {
                let Some(reference_id) = ident.reference_id.get() else {
                    return "member_access/other";
                };
                let reference = self.scoping.get_reference(reference_id);
                let Some(symbol_id) = reference.symbol_id() else {
                    return "member_access/other";
                };
                if self.namespace_import_specifiers.contains_key(&symbol_id)
                    || self.namespace_reexport_targets.contains_key(&symbol_id)
                    || self.import_bindings.contains_key(&symbol_id)
                {
                    return "member_access/ident:import_bound";
                }
                if self.destructured_pattern_symbols.contains(&symbol_id) {
                    return "member_access/ident:param_destructured";
                }
                "member_access/ident:local_untyped"
            }
            _ => "member_access/other",
        }
    }

    fn resolve_call_target_typeflow(&self, expr: &CallExpression<'a>) -> TypeflowCallResolution {
        let Some(index) = self.ctx.typeflow_index else {
            return TypeflowCallResolution::Unresolved;
        };
        // P1-C: a BARE call to a destructured-METHOD identifier (`await
        // dropColumns(...)`, no further chaining) -- see `destructured_
        // member_entities`'s own doc comment for why this needs a
        // SEPARATE map from the member-callee branch below (which resolves
        // `<base>.<member>(...)`, a structurally different callee shape:
        // this one's callee IS the plain identifier itself). Checked
        // first: a destructured binding is never ALSO a real function
        // declaration, so this cannot shadow `resolve_call_target`'s own
        // (already-tried, already-failed by the time this function runs)
        // identifier resolution.
        if let Expression::Identifier(ident) = &expr.callee {
            let target_id = ident.reference_id.get().and_then(|reference_id| {
                let reference = self.scoping.get_reference(reference_id);
                let symbol_id = reference.symbol_id()?;
                self.destructured_member_entities.get(&symbol_id).cloned()
            });
            return match target_id {
                Some(target_id) => {
                    TypeflowCallResolution::Resolved(target_id, "destructured_method_call")
                }
                None => TypeflowCallResolution::Unresolved,
            };
        }
        let Expression::StaticMemberExpression(member) = &expr.callee else {
            return TypeflowCallResolution::Unresolved;
        };
        if let Some((base_value, rule)) = self.type_of_expression(&member.object) {
            match &base_value {
                // P2-2j: a union receiver routes to `members_of_union` --
                // NEVER to `members`, and NEVER produces `Resolved` (see
                // `MemberLookup::UnionCandidates`'s own doc comment: a
                // union receiver is a genuine ambiguity, not a confirmed
                // target, even when every constituent agrees).
                TypeflowValue::Union(_) => {
                    if let Some((entity_ids, is_static)) = Self::as_entities(&base_value)
                        && let urdira_jsts_typeflow::MemberLookup::UnionCandidates(targets) = index
                            .members_of_union(&entity_ids, member.property.name.as_str(), is_static)
                    {
                        return TypeflowCallResolution::Candidates {
                            targets,
                            reason: REASON_UNION_AMBIGUOUS,
                        };
                    }
                }
                _ => {
                    if let Some((base_entity, is_static)) = Self::as_entity(&base_value) {
                        match index.members(&base_entity, member.property.name.as_str(), is_static)
                        {
                            urdira_jsts_typeflow::MemberLookup::One(target) => {
                                return TypeflowCallResolution::Resolved(target, rule);
                            }
                            urdira_jsts_typeflow::MemberLookup::Many(targets) => {
                                return TypeflowCallResolution::Candidates {
                                    targets,
                                    reason: REASON_OVERLOAD_AMBIGUOUS,
                                };
                            }
                            // `members()` (single-entity) never actually
                            // produces `UnionCandidates` -- only `members_
                            // of_union` (the branch above) does.
                            urdira_jsts_typeflow::MemberLookup::None
                            | urdira_jsts_typeflow::MemberLookup::UnionCandidates(_) => {}
                        }
                    }
                }
            }
        }
        // P1-A (rule (f)): `ns.fn(...)` as the call ITSELF (not merely a
        // chain receiver) -- see `resolve_namespace_member`'s doc comment.
        // Restricted to `Function` (never `Class`/`Method`/...) to match
        // `resolve_call_target`'s own T1 scope exactly.
        let Some(target_id) =
            self.resolve_namespace_member(&member.object, member.property.name.as_str())
        else {
            return TypeflowCallResolution::Unresolved;
        };
        if target_id_kind_is_one_of(&target_id, &[DeclKind::Function]) {
            TypeflowCallResolution::Resolved(target_id, "namespace_member_call")
        } else {
            TypeflowCallResolution::Unresolved
        }
    }

    /// P1-A census classifier (diagnostic only): the shape of a non-
    /// identifier call CALLEE, from the callee expression's own point of
    /// view -- unwraps the wrappers `type_of_expression` also sees through
    /// (parenthesized/non-null/optional-chain) before delegating to
    /// `classify_expr_shape` on the actual receiver (`member.object` for a
    /// `<base>.<name>(...)` callee, the only shape that matters for the
    /// method-chain classification this exists to drive -- see
    /// `docs/evidence/2026-09-02-v4-p1a-typeflow.md`'s classifier
    /// histogram). A computed callee (`obj[key](...)`) has no "receiver
    /// shape" in that sense and is tagged directly.
    fn classify_receiver_shape(&self, callee: &Expression<'a>) -> &'static str {
        match callee {
            Expression::StaticMemberExpression(member) => self.classify_expr_shape(&member.object),
            Expression::ComputedMemberExpression(_) => "computed_callee",
            Expression::TSNonNullExpression(inner) => self.classify_expr_shape(&inner.expression),
            Expression::ParenthesizedExpression(parenthesized) => {
                self.classify_expr_shape(&parenthesized.expression)
            }
            Expression::ChainExpression(chain) => match &chain.expression {
                ChainElement::StaticMemberExpression(member) => {
                    self.classify_expr_shape(&member.object)
                }
                ChainElement::ComputedMemberExpression(_) => "computed_callee",
                ChainElement::CallExpression(_) => "call_expression_receiver",
                ChainElement::PrivateFieldExpression(_) | ChainElement::TSNonNullExpression(_) => {
                    "other_callee_shape"
                }
            },
            _ => "other_callee_shape",
        }
    }

    /// The shape of one RECEIVER expression (`a` in `a.b(...)`) -- the
    /// classifier's own taxonomy, ranked by expected frequency from the
    /// P0-S2 census's miss samples (see `docs/evidence/2026-09-02-v4-p0-s2-
    /// typeflow-prototype.md`): a fluent/builder chain (`chained_member_of_
    /// call`), a bare call receiver (`createTool(...)`), an untyped local/
    /// parameter, `this`/`super` where the enclosing class itself is
    /// unknown (an anonymous class expression), and so on. Every arm here
    /// is diagnostic-only and never affects resolution.
    fn classify_expr_shape(&self, expr: &Expression<'a>) -> &'static str {
        match expr {
            Expression::ThisExpression(_) => "this_unresolved",
            Expression::Super(_) => "super_unresolved",
            Expression::Identifier(ident) => self.classify_identifier_shape(ident),
            Expression::CallExpression(_) => "call_expression_receiver",
            Expression::NewExpression(_) => "new_expr_inline",
            Expression::StaticMemberExpression(member) => match &member.object {
                Expression::CallExpression(_) => "chained_member_of_call",
                _ => "nested_member_chain",
            },
            Expression::ComputedMemberExpression(_) => "array_element",
            Expression::AwaitExpression(_) => "await_expr",
            Expression::ParenthesizedExpression(parenthesized) => {
                self.classify_expr_shape(&parenthesized.expression)
            }
            Expression::TSAsExpression(_) => "as_expression",
            Expression::TSNonNullExpression(inner) => self.classify_expr_shape(&inner.expression),
            Expression::TSTypeAssertion(_) => "type_assertion",
            Expression::ChainExpression(chain) => match &chain.expression {
                ChainElement::StaticMemberExpression(member) => match &member.object {
                    Expression::CallExpression(_) => "chained_member_of_call",
                    _ => "nested_member_chain",
                },
                ChainElement::ComputedMemberExpression(_) => "array_element",
                ChainElement::CallExpression(_) => "call_expression_receiver",
                ChainElement::PrivateFieldExpression(_) => "other",
                ChainElement::TSNonNullExpression(inner) => {
                    self.classify_expr_shape(&inner.expression)
                }
            },
            Expression::ConditionalExpression(_) => "conditional",
            Expression::LogicalExpression(_) => "logical",
            Expression::TemplateLiteral(_) | Expression::TaggedTemplateExpression(_) => "template",
            Expression::ArrayExpression(_) => "array_literal",
            Expression::ObjectExpression(_) => "object_literal_inline",
            Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => {
                "function_literal"
            }
            Expression::PrivateFieldExpression(_) => "private_field",
            _ => "other",
        }
    }

    /// The shape of an IDENTIFIER used as a receiver: a class/interface name
    /// used statically (already resolved by rule `member_class_static`, so
    /// landing here means the class-static lookup itself found no matching
    /// member -- rare, tagged distinctly so it doesn't inflate the
    /// "untyped" buckets), an import-bound name (namespace import member
    /// access, `ns.Foo`), an already-typed local whose member lookup came
    /// back empty/ambiguous, or an untyped parameter/local/other symbol
    /// kind.
    fn classify_identifier_shape(&self, ident: &IdentifierReference<'a>) -> &'static str {
        if self
            .resolve_identifier_to_kind(ident, &[DeclKind::Class, DeclKind::Interface])
            .is_some()
        {
            return "static_member_via_class_name_lookup_failed";
        }
        let Some(reference_id) = ident.reference_id.get() else {
            return "unresolved_identifier";
        };
        let reference = self.scoping.get_reference(reference_id);
        let Some(symbol_id) = reference.symbol_id() else {
            return "unresolved_global";
        };
        let flags = self.scoping.symbol_flags(symbol_id);
        if flags.is_import() {
            return "namespace_import_member";
        }
        if !self.scoping.symbol_redeclarations(symbol_id).is_empty() {
            return "multiple_declarations";
        }
        if self.local_types.contains_key(&symbol_id) {
            return "identifier_typed_lookup_failed";
        }
        match classify_symbol_declaration(self.nodes, self.scoping, symbol_id) {
            Some(DeclKind::Parameter) => "identifier_param_unannotated",
            Some(DeclKind::Variable) => "identifier_unannotated_local",
            Some(DeclKind::Enum) => "enum_member_receiver",
            Some(DeclKind::Namespace) => "namespace_member_receiver",
            _ => "identifier_other",
        }
    }

    /// P0-S2 typeflow: resolve a heritage identifier the SAME way E3 already
    /// does (`resolve_identifier_to_kind`) -- the only genuinely NEW case
    /// this ever succeeds for is a generic type whose args E3's own call
    /// site never even attempted (`Base<T>`, ident passed as `Some` here
    /// with args erased by the caller); a plain identifier E3 already tried
    /// and failed on (`REASON_HERITAGE_TARGET_UNCERTAIN`) fails here too,
    /// deterministically, since both call the identical resolver.
    fn resolve_heritage_ident_typeflow(&self, ident: &IdentifierReference<'a>) -> Option<String> {
        let index = self.ctx.typeflow_index?;
        let entity_id =
            self.resolve_identifier_to_kind(ident, &[DeclKind::Class, DeclKind::Interface])?;
        index.is_container(&entity_id).then_some(entity_id)
    }

    /// P1-A: resolve a CALL-EXPRESSION super class (`extends Z.class({...})`)
    /// to a known container entity id -- see `resolve_super_class`'s doc
    /// comment on its own call site for the exact scope and why this is
    /// safe (generic-erasure reasoning identical to the already-shipped
    /// `heritage_generic` rule: a resolved container's OWN member table
    /// never depends on which concrete type arguments the checker would
    /// have substituted).
    fn resolve_heritage_call_typeflow(&self, expr: &Expression<'a>) -> Option<String> {
        let index = self.ctx.typeflow_index?;
        let (value, _rule) = self.type_of_expression(expr)?;
        let (entity_id, _is_static) = Self::as_entity(&value)?;
        index.is_container(&entity_id).then_some(entity_id)
    }

    /// Resolve a class's own `super_class` clause (P0-S2 typeflow widening
    /// of E3's T2), publish it, and track the resulting base entity id on
    /// `class_stack` for `super.x()` call resolution -- regardless of
    /// whether the edge itself was published or only recorded as an oracle
    /// hit (see `class_stack`'s doc comment). Deliberately scoped to a
    /// class's own `extends` ONLY (never `implements`/an interface's own
    /// `extends`): those are multi-entry clauses subject to the
    /// `REASON_HERITAGE_CLAUSE_PARTIALLY_PENDING` atomicity rule (see that
    /// reason's doc comment), which this prototype does not widen -- a
    /// class's `super_class` is syntactically single-entry and therefore
    /// exempt from that rule already.
    fn resolve_super_class(
        &mut self,
        self_class_id: Option<&str>,
        super_class: &Expression<'a>,
        has_type_arguments: bool,
    ) -> Option<String> {
        let span = super_class.span();
        let e3_ident = if has_type_arguments {
            None
        } else {
            match super_class {
                Expression::Identifier(ident) => Some(ident.as_ref()),
                _ => None,
            }
        };
        let e3_result = self.resolve_heritage_clause(self_class_id, e3_ident);
        if let Ok((source_id, target_id)) = &e3_result {
            self.push_site(
                SiteKind::Heritage,
                span.start,
                span.end,
                SiteDisposition::RustResolved,
                None,
            );
            self.heritage_rows.push(HeritageRow {
                start: span.start,
                end: span.end,
                source_id: source_id.clone(),
                target_id: target_id.clone(),
                relation_kind: "inherits",
            });
            return Some(target_id.clone());
        }
        let reason = e3_result.expect_err("checked Ok above");
        let typeflow_target = match super_class {
            Expression::Identifier(ident) => self.resolve_heritage_ident_typeflow(ident),
            // P1-A (unlocks the `class LoginDto extends Z.class({...}) {}`
            // mixin factory pattern found live in this corpus's `zod-
            // class.ts`): the super class is a CALL, not a bare identifier
            // -- resolve its own static TYPE the same general way a call
            // RECEIVER would be (`type_of_expression`, object-shape
            // resolution included), and accept it as a heritage target only
            // when it names a KNOWN container (a class/interface/object-
            // shape this index actually indexed) -- never a guess.
            Expression::CallExpression(_) => self.resolve_heritage_call_typeflow(super_class),
            _ => None,
        };
        match (self_class_id, &typeflow_target) {
            (Some(source_id), Some(target_id)) if self.ctx.typeflow_oracle => {
                self.typeflow_oracle_hits.push(TypeflowOracleHit {
                    start: span.start,
                    end: span.end,
                    edge_kind: "inherits",
                    rule: "heritage_generic",
                    source_id: source_id.to_owned(),
                    target_id: target_id.clone(),
                });
                self.push_site(
                    SiteKind::Heritage,
                    span.start,
                    span.end,
                    SiteDisposition::CheckerPending,
                    Some(reason),
                );
                self.pending_heritage_sites.push(PendingHeritageSite {
                    start: span.start,
                    end: span.end,
                    source_id: source_id.to_owned(),
                    relation_kind: "inherits",
                    reason,
                });
            }
            (Some(source_id), Some(target_id)) => {
                self.push_site(
                    SiteKind::Heritage,
                    span.start,
                    span.end,
                    SiteDisposition::RustResolved,
                    None,
                );
                self.typeflow_heritage_rows.push(HeritageRow {
                    start: span.start,
                    end: span.end,
                    source_id: source_id.to_owned(),
                    target_id: target_id.clone(),
                    relation_kind: "inherits",
                });
            }
            _ => {
                self.push_site(
                    SiteKind::Heritage,
                    span.start,
                    span.end,
                    SiteDisposition::CheckerPending,
                    Some(reason),
                );
                if let Some(source_id) = self_class_id {
                    self.pending_heritage_sites.push(PendingHeritageSite {
                        start: span.start,
                        end: span.end,
                        source_id: source_id.to_owned(),
                        relation_kind: "inherits",
                        reason,
                    });
                }
            }
        }
        typeflow_target
    }

    /// Push either a `rust_resolved` `Heritage` site plus its `HeritageRow`,
    /// or a `checker_pending` one with `reason` -- the common tail shared by
    /// every heritage clause branch in `visit_class`/`visit_ts_interface_
    /// declaration`.
    fn finish_heritage_clause(
        &mut self,
        start: u32,
        end: u32,
        relation_kind: &'static str,
        resolution: Result<(String, String), &'static str>,
        self_id: Option<&str>,
    ) {
        match resolution {
            Ok((source_id, target_id)) => {
                self.push_site(
                    SiteKind::Heritage,
                    start,
                    end,
                    SiteDisposition::RustResolved,
                    None,
                );
                self.heritage_rows.push(HeritageRow {
                    start,
                    end,
                    source_id,
                    target_id,
                    relation_kind,
                });
            }
            Err(reason) => {
                self.push_site(
                    SiteKind::Heritage,
                    start,
                    end,
                    SiteDisposition::CheckerPending,
                    Some(reason),
                );
                // P2-2i: `self_id` is `None` exactly when `resolve_heritage_
                // clause` never had a real enclosing declaration to begin
                // with (`REASON_HERITAGE_DEFERRED`'s anonymous-declaration
                // case) -- `analyzer.ts`'s own `entityForDeclaration(node.
                // parent)` is `undefined` there too, so `relate` is never
                // even called (see its `if (relationSource !== undefined)`
                // guard). No possible row for that specific case, matching
                // v3 exactly; every other `self_id` present.
                if let Some(source_id) = self_id {
                    self.pending_heritage_sites.push(PendingHeritageSite {
                        start,
                        end,
                        source_id: source_id.to_owned(),
                        relation_kind,
                        reason,
                    });
                }
            }
        }
    }

    /// Finish every entry of ONE multi-type heritage clause (`implements A,
    /// B` / `interface I extends A, B`) atomically: see
    /// `REASON_HERITAGE_CLAUSE_PARTIALLY_PENDING`'s doc comment for why a
    /// per-entry resolution here would risk a real double-emission
    /// collision against the checker's own per-CLAUSE re-walk. Every entry
    /// resolves individually first; only when ALL of them succeeded does
    /// any of them actually publish -- otherwise every entry (including
    /// ones that individually resolved) is demoted to `checker_pending`
    /// with `REASON_HERITAGE_CLAUSE_PARTIALLY_PENDING`.
    fn finish_heritage_clause_group(
        &mut self,
        relation_kind: &'static str,
        entries: Vec<HeritageClauseEntry>,
        self_id: Option<&str>,
    ) {
        let all_resolved = entries.iter().all(|(_, _, resolution)| resolution.is_ok());
        for (start, end, resolution) in entries {
            // An entry that was already individually doubtful keeps its own,
            // more specific reason; only a would-have-resolved entry is
            // demoted with the clause-partial reason.
            let resolution = if all_resolved {
                resolution
            } else {
                resolution.and(Err(REASON_HERITAGE_CLAUSE_PARTIALLY_PENDING))
            };
            self.finish_heritage_clause(start, end, relation_kind, resolution, self_id);
        }
    }

    fn finish(mut self) -> OwnerSemantics {
        self.sites.sort_by(|left, right| {
            (
                left.start_utf16,
                left.end_utf16,
                left.site_kind,
                left.disposition,
                &left.reason,
            )
                .cmp(&(
                    right.start_utf16,
                    right.end_utf16,
                    right.site_kind,
                    right.disposition,
                    &right.reason,
                ))
        });
        self.reference_rows.sort_by(|left, right| {
            (left.start, left.end, &left.source_id, &left.target_id).cmp(&(
                right.start,
                right.end,
                &right.source_id,
                &right.target_id,
            ))
        });
        self.call_rows.sort_by(|left, right| {
            (left.start, left.end, &left.source_id, &left.target_id).cmp(&(
                right.start,
                right.end,
                &right.source_id,
                &right.target_id,
            ))
        });
        self.heritage_rows.sort_by(|left, right| {
            (
                left.start,
                left.end,
                left.relation_kind,
                &left.source_id,
                &left.target_id,
            )
                .cmp(&(
                    right.start,
                    right.end,
                    right.relation_kind,
                    &right.source_id,
                    &right.target_id,
                ))
        });
        // P2-2i: deterministic order for the possible/diagnostic rows below,
        // same (start, end, source_id) key `call_rows`/`heritage_rows` sort
        // by above -- `pending_call_sites`/`pending_heritage_sites` are
        // collected in AST visitation order, which is not guaranteed stable
        // across otherwise-equivalent parses the same way an explicit sort
        // is.
        self.pending_call_sites.sort_by(|left, right| {
            (left.start, left.end, &left.source_id).cmp(&(right.start, right.end, &right.source_id))
        });
        self.pending_heritage_sites.sort_by(|left, right| {
            (left.start, left.end, left.relation_kind, &left.source_id).cmp(&(
                right.start,
                right.end,
                right.relation_kind,
                &right.source_id,
            ))
        });
        // P2-2j: same deterministic-order rationale as `pending_call_sites`
        // above, keyed the same way `call_rows`/`heritage_rows` are
        // (start, end, source_id, target_id) since every candidate row
        // carries a real target.
        self.candidate_call_rows.sort_by(|left, right| {
            (left.start, left.end, &left.source_id, &left.target_id).cmp(&(
                right.start,
                right.end,
                &right.source_id,
                &right.target_id,
            ))
        });
        let sites_digest = compute_sites_digest(&self.sites);
        let pending_sites = self
            .sites
            .into_iter()
            .filter(|site| site.disposition == SiteDisposition::CheckerPending)
            .collect();
        // `core:covers` derivation parity with `analyzer.ts`'s
        // `assembleAnalysis` (F5 hybrid gap fix, 2026-09-01): only a
        // cross-file reference row qualifies (`source.path !== target.path`
        // there; `ReferenceRow::cross_file` here), and only when THIS
        // owner's own module entity is itself a test container --
        // `testContainerOf`'s walk-up-the-parent-chain always bottoms out at
        // the file's module entity, since no other entity kind ever carries
        // `is_test` in either producer (see `is_test_source`'s doc comment).
        // `reference_rows` is already sorted above, so the derived order is
        // deterministic without a further sort.
        let covers_rows = if self.is_test_source {
            self.reference_rows
                .iter()
                .filter(|row| row.cross_file)
                .map(|row| covers_proposed_record(&self.path, &self.module_id, row))
                .collect()
        } else {
            Vec::new()
        };
        let reference_rows = self
            .reference_rows
            .iter()
            .map(|row| reference_proposed_record(&self.path, row))
            .collect();
        let call_rows = self
            .call_rows
            .iter()
            .map(|row| call_proposed_record(&self.path, row))
            .collect();
        let heritage_rows = self
            .heritage_rows
            .iter()
            .map(|row| heritage_proposed_record(&self.path, row))
            .collect();
        let typeflow_call_rows = self
            .typeflow_call_rows
            .iter()
            .map(|row| call_proposed_record(&self.path, row))
            .collect();
        let typeflow_heritage_rows = self
            .typeflow_heritage_rows
            .iter()
            .map(|row| heritage_proposed_record(&self.path, row))
            .collect();
        // A2 (pending.sites migration): one `PendingSiteProposal` per
        // `PendingCallSite` (reason as-is) then per `PendingHeritageSite`
        // (reason as recorded at its own `push_site` call), in sorted
        // order -- see `OwnerSemantics::pending_site_rows`'s own doc
        // comment. Replaces the P2-2i `possible_call_rows`/
        // `possible_heritage_rows` full `ProposedRecord` builders.
        let pending_site_rows = self
            .pending_call_sites
            .iter()
            .map(|site| PendingSiteProposal {
                start: site.start,
                end: site.end,
                site_kind: PendingSiteKind::Call,
                reason: site.reason,
                source_id: site.source_id.clone(),
            })
            .chain(
                self.pending_heritage_sites
                    .iter()
                    .map(|site| PendingSiteProposal {
                        start: site.start,
                        end: site.end,
                        site_kind: match site.relation_kind {
                            "implements" => PendingSiteKind::Implements,
                            _ => PendingSiteKind::Inherits,
                        },
                        reason: site.reason,
                        source_id: site.source_id.clone(),
                    }),
            )
            .collect();
        // P2-2j: one `possible` `core:call` row PER CANDIDATE (own
        // `target_id` each), in sorted order -- see `CandidateCallRow`'s and
        // `OwnerSemantics::candidate_call_rows`'s own doc comments.
        let candidate_call_rows = self
            .candidate_call_rows
            .iter()
            .map(|row| candidate_call_record(&self.path, row))
            .collect();
        // Parameter entities, "referenced-only" variant: `referenced_
        // parameter_targets` is already sorted (a `BTreeSet`, keyed by the
        // SAME id `parameter_declarations` is keyed by), so iterating it
        // directly gives deterministic, dependency-free order for both
        // buckets below -- no separate sort needed, unlike `reference_rows`/
        // `call_rows`/etc. above (plain `Vec`s, populated in AST visitation
        // order). Every target here was inserted from a `target_id` this
        // SAME walk's `resolve_identifier_reference`/`resolve_static_member_
        // reference` built with `declaration_id(DeclKind::Parameter, ...)`,
        // which is exactly the id `visit_formal_parameter` records a fact
        // under for every ORDINARY (non-property) identifier-pattern
        // parameter this walk sees. A PARAMETER PROPERTY's target id is
        // never a key here (`visit_formal_parameter` deliberately skips
        // recording one, see its own doc comment: `urdira_jsts_typeflow::
        // member_declarations`/`push_member_entities` already materialize
        // it unconditionally) -- `filter_map` below silently skips those
        // rather than double-materializing the same declaration a second
        // time from this "referenced-only" bucket.
        let language = crate::language_for_path(&self.path)
            .map(|(language, _)| language)
            .unwrap_or(crate::Language::Javascript);
        // 2026-09-04 references-parity task, bucket 1: catch-clause bindings
        // materialize through the SAME two output buckets as parameters
        // (`OwnerSemantics::parameter_entity_rows`/`parameter_contains_rows`
        // -- see `catch_declarations`'s own doc comment for why sharing the
        // sink is safe), chained after the parameter rows so parameter
        // ordering is unaffected for anything that only cares about that
        // population.
        let parameter_entity_rows = self
            .referenced_parameter_targets
            .iter()
            .filter_map(|target_id| {
                let fact = self.parameter_declarations.get(target_id)?;
                Some(parameter_entity_record(&self.path, language, fact))
            })
            .chain(
                self.referenced_catch_targets
                    .iter()
                    .filter_map(|target_id| {
                        let fact = self.catch_declarations.get(target_id)?;
                        Some(catch_variable_entity_record(&self.path, language, fact))
                    }),
            )
            .collect();
        let parameter_contains_rows = self
            .referenced_parameter_targets
            .iter()
            .filter_map(|target_id| {
                let fact = self.parameter_declarations.get(target_id)?;
                Some(parameter_contains_record(&self.path, fact))
            })
            .chain(
                self.referenced_catch_targets
                    .iter()
                    .filter_map(|target_id| {
                        let fact = self.catch_declarations.get(target_id)?;
                        Some(catch_variable_contains_record(&self.path, fact))
                    }),
            )
            .collect();
        // External package/symbol entities task: `external_uses` (visitation
        // order, possibly repeating the same `(specifier, name)` many times
        // -- once per import/re-export/member-read occurrence) collapses
        // into ONE entity row per distinct identity here (deduped within
        // THIS owner; `urdira-indexing-worker::v4::analyze::run_scoped`'s
        // cross-owner pass is the authoritative backstop for the case where
        // ANOTHER owner also imports the same specifier), plus one `core:
        // contains` row per occurrence (never deduped -- see `OwnerSemantics
        // ::external_contains_rows`'s own doc comment).
        let mut external_ids_seen: BTreeSet<String> = BTreeSet::new();
        let mut external_entity_rows: Vec<ProposedRecord> = Vec::new();
        let mut external_contains_rows: Vec<ProposedRecord> = Vec::new();
        for use_ in &self.external_uses {
            let module_entity = crate::external_module_entity(&use_.specifier);
            if external_ids_seen.insert(module_entity.id.clone()) {
                external_entity_rows.push(crate::proposal_entity_record(&module_entity, language));
            }
            let symbol_entity =
                crate::external_symbol_entity(&use_.specifier, &use_.name, use_.is_type);
            if external_ids_seen.insert(symbol_entity.id.clone()) {
                external_entity_rows.push(crate::proposal_entity_record(&symbol_entity, language));
            }
            let contains = crate::external_contains_relation(
                &use_.specifier,
                &use_.name,
                &self.path,
                use_.start,
                use_.end,
            );
            external_contains_rows.push(crate::proposal_relation_record(&contains));
        }
        // Measurement-only (2026-09-04 n8n before/after report), gated
        // behind an env var an operator must deliberately set -- never on by
        // default. Prints this owner's occurrence count split by which
        // PRE-this-task pending reason it would have carried (see
        // `ExternalSymbolUse::was_import_binding`'s own doc comment): sum
        // the `import_binding=` figures across every owner (`grep
        // 'external-uses-by-reason' | awk` over stderr) for "how many
        // previously-`Pending(REASON_IMPORT_BINDING)` sites this run
        // confirmed externally" -- computed from a SINGLE run of the
        // current (fixed) code, no old binary needed, since every
        // occurrence recorded here is BY CONSTRUCTION one this task's own
        // new branch resolved that would otherwise have stayed pending
        // with the reason `was_import_binding` names.
        if !self.external_uses.is_empty()
            && std::env::var_os("URDIRA_V4_DEBUG_EXTERNAL_ENTITIES").is_some()
        {
            let import_binding_count = self
                .external_uses
                .iter()
                .filter(|use_| use_.was_import_binding)
                .count();
            let member_access_count = self.external_uses.len() - import_binding_count;
            eprintln!(
                "external-uses-by-reason path={} import_binding={import_binding_count} member_access={member_access_count}",
                self.path
            );
        }
        OwnerSemantics {
            reference_rows,
            covers_rows,
            call_rows,
            heritage_rows,
            typeflow_call_rows,
            typeflow_heritage_rows,
            pending_site_rows,
            candidate_call_rows,
            parameter_entity_rows,
            parameter_contains_rows,
            external_entity_rows,
            external_contains_rows,
            typeflow_oracle_hits: self.typeflow_oracle_hits,
            typeflow_pending_call_shapes: self.typeflow_pending_call_shapes,
            pending_sites,
            sites_digest,
            jsdoc_typed_file: self.jsdoc_typed_file,
        }
    }
}

fn compute_sites_digest(sites: &[SemanticSite]) -> String {
    let encoded: Vec<String> = sites
        .iter()
        .map(|site| {
            format!(
                "{}:{}:{}:{}:{}",
                site.start_utf16,
                site.end_utf16,
                site.site_kind.identity_name(),
                site.disposition.identity_name(),
                site.reason.as_deref().unwrap_or("")
            )
        })
        .collect();
    let refs: Vec<&str> = encoded.iter().map(String::as_str).collect();
    bounded_sha256_identity(
        "jsts:sites:sha256:",
        b"urdira:jsts-semantic-sites:v1\0",
        &refs,
    )
}

fn reference_proposed_record(path: &str, row: &ReferenceRow) -> ProposedRecord {
    let identity_key = format!(
        "jsts:references:{path}:{}:{}:{}:{}",
        row.start, row.end, row.source_id, row.target_id
    );
    let mut body = serde_json::Map::new();
    body.insert(
        "source_id".into(),
        serde_json::Value::String(row.source_id.clone()),
    );
    body.insert(
        "target_id".into(),
        serde_json::Value::String(row.target_id.clone()),
    );
    body.insert(
        "classification".into(),
        serde_json::Value::String("confirmed".into()),
    );
    body.insert("path".into(), serde_json::Value::String(path.to_owned()));
    body.insert("start".into(), serde_json::Value::from(row.start));
    body.insert("end".into(), serde_json::Value::from(row.end));
    let facets = serde_json::json!(["core:reference_relation"]);
    ProposedRecord {
        proposal_record_key: proposal_record_key(&identity_key),
        category: "relation",
        kind: "jsts:relation_references".to_owned(),
        universal_kind: "core:references".to_owned(),
        facets_list: facets_list_from_value(&facets),
        facets: canonical_json(&facets),
        schema_version: 1,
        source_span: canonical_span(path, row.start, row.end),
        identity_key,
        body: serde_json::Value::Object(body),
        evidence_references: canonical_evidence(path, row.start, row.end),
    }
}

/// `core:covers` proposed record for one cross-file reference `row` owned by
/// a test container (F5 hybrid gap fix, 2026-09-01) -- built to be
/// byte-for-byte identical, for the equivalent checker-resolved case, to the
/// record `packages/plugin-javascript-typescript/src/fact-delta.ts`'s
/// `proposalRelationRecord` produces from one of `analyzer.ts`'s
/// `assembleAnalysis`-synthesized `core:covers` relations:
/// `{ id: "jsts:covers:{path}:{start}:{end}:{testContainer.id}:{target.id}",
/// kind: "core:covers", source_id: testContainer.id, target_id: target.id,
/// classification: "confirmed", path, start, end }` with facets
/// `["core:reference_relation"]` (never `"core:indirect"`: `assembleAnalysis`
/// always emits `classification: "confirmed"` for a covers row). `path`/
/// `row.start`/`row.end` here are the underlying reference's own span --
/// `reference.path`/`.start`/`.end` in `assembleAnalysis`'s loop -- not the
/// test container's or the target's.
fn covers_proposed_record(
    path: &str,
    test_container_id: &str,
    row: &ReferenceRow,
) -> ProposedRecord {
    let identity_key = format!(
        "jsts:covers:{path}:{}:{}:{}:{}",
        row.start, row.end, test_container_id, row.target_id
    );
    let mut body = serde_json::Map::new();
    body.insert(
        "source_id".into(),
        serde_json::Value::String(test_container_id.to_owned()),
    );
    body.insert(
        "target_id".into(),
        serde_json::Value::String(row.target_id.clone()),
    );
    body.insert(
        "classification".into(),
        serde_json::Value::String("confirmed".into()),
    );
    body.insert("path".into(), serde_json::Value::String(path.to_owned()));
    body.insert("start".into(), serde_json::Value::from(row.start));
    body.insert("end".into(), serde_json::Value::from(row.end));
    let facets = serde_json::json!(["core:reference_relation"]);
    ProposedRecord {
        proposal_record_key: proposal_record_key(&identity_key),
        category: "relation",
        kind: "jsts:relation_covers".to_owned(),
        universal_kind: "core:covers".to_owned(),
        facets_list: facets_list_from_value(&facets),
        facets: canonical_json(&facets),
        schema_version: 1,
        source_span: canonical_span(path, row.start, row.end),
        identity_key,
        body: serde_json::Value::Object(body),
        evidence_references: canonical_evidence(path, row.start, row.end),
    }
}

/// `core:call` proposed record for one rust-resolved `CallRow` (E3, T1) --
/// built to be byte-for-byte identical, for the equivalent checker-resolved
/// case, to the record `fact-delta.ts`'s `proposalRelationRecord` produces
/// from `analyzer.ts`'s `relate("call", relationSource, target, node,
/// "confirmed")`: id/identity_key
/// `jsts:call:{path}:{start}:{end}:{source_id}:{target_id}`, `kind:
/// "core:call"`, facets `["core:reference_relation"]` (never
/// `"core:indirect"`: that facet is only ever added for a `"possible"`
/// classification, which Rust never asserts -- see `CallRow`'s doc comment),
/// `body: { source_id, target_id, classification: "confirmed", path, start,
/// end }`. `row.start`/`row.end` are the WHOLE `CallExpression`'s own span
/// (`expr.span` in `visit_call_expression`), matching `node.getStart()`/
/// `getEnd()` on the checker side (`node` there is the call expression
/// itself, not just its callee).
fn call_proposed_record(path: &str, row: &CallRow) -> ProposedRecord {
    let identity_key = format!(
        "jsts:call:{path}:{}:{}:{}:{}",
        row.start, row.end, row.source_id, row.target_id
    );
    let mut body = serde_json::Map::new();
    body.insert(
        "source_id".into(),
        serde_json::Value::String(row.source_id.clone()),
    );
    body.insert(
        "target_id".into(),
        serde_json::Value::String(row.target_id.clone()),
    );
    body.insert(
        "classification".into(),
        serde_json::Value::String("confirmed".into()),
    );
    body.insert("path".into(), serde_json::Value::String(path.to_owned()));
    body.insert("start".into(), serde_json::Value::from(row.start));
    body.insert("end".into(), serde_json::Value::from(row.end));
    let facets = serde_json::json!(["core:reference_relation"]);
    ProposedRecord {
        proposal_record_key: proposal_record_key(&identity_key),
        category: "relation",
        kind: "jsts:relation_call".to_owned(),
        universal_kind: "core:call".to_owned(),
        facets_list: facets_list_from_value(&facets),
        facets: canonical_json(&facets),
        schema_version: 1,
        source_span: canonical_span(path, row.start, row.end),
        identity_key,
        body: serde_json::Value::Object(body),
        evidence_references: canonical_evidence(path, row.start, row.end),
    }
}

/// `core:inherits`/`core:implements` proposed record for one rust-resolved
/// `HeritageRow` (E3, T2) -- byte-for-byte identical, for the equivalent
/// checker-resolved case, to the record `relate(clauseText.startsWith(
/// "implements") ? "implements" : "inherits", relationSource, target, type,
/// "confirmed")` in `analyzer.ts` produces via `fact-delta.ts`'s
/// `proposalRelationRecord`. `row.start`/`row.end` are the heritage type's
/// own expression span (no type arguments -- generic heritage never reaches
/// a `HeritageRow` in the first place, see `visit_class`/`visit_ts_
/// interface_declaration`), matching the checker's per-type-entry
/// `ExpressionWithTypeArguments` span when it carries no type arguments
/// either.
fn heritage_proposed_record(path: &str, row: &HeritageRow) -> ProposedRecord {
    let identity_key = format!(
        "jsts:{}:{path}:{}:{}:{}:{}",
        row.relation_kind, row.start, row.end, row.source_id, row.target_id
    );
    let mut body = serde_json::Map::new();
    body.insert(
        "source_id".into(),
        serde_json::Value::String(row.source_id.clone()),
    );
    body.insert(
        "target_id".into(),
        serde_json::Value::String(row.target_id.clone()),
    );
    body.insert(
        "classification".into(),
        serde_json::Value::String("confirmed".into()),
    );
    body.insert("path".into(), serde_json::Value::String(path.to_owned()));
    body.insert("start".into(), serde_json::Value::from(row.start));
    body.insert("end".into(), serde_json::Value::from(row.end));
    let facets = serde_json::json!(["core:reference_relation"]);
    ProposedRecord {
        proposal_record_key: proposal_record_key(&identity_key),
        category: "relation",
        kind: format!("jsts:relation_{}", row.relation_kind),
        universal_kind: format!("core:{}", row.relation_kind),
        facets_list: facets_list_from_value(&facets),
        facets: canonical_json(&facets),
        schema_version: 1,
        source_span: canonical_span(path, row.start, row.end),
        identity_key,
        body: serde_json::Value::Object(body),
        evidence_references: canonical_evidence(path, row.start, row.end),
    }
}

/// `core:call` proposed record, `classification: "possible"`, carrying a
/// REAL `target_id` -- P2-2j, see `CandidateCallRow`'s and `OwnerSemantics::
/// candidate_call_rows`'s own doc comments for the exact contract this
/// closes (a "possible" row the query engine can actually traverse). The
/// identity recipe matches `call_proposed_record`'s CONFIRMED recipe
/// exactly (`jsts:call:{path}:{start}:{end}:{source_id}:{target_id}`),
/// NEVER the `:unresolved` shape a no-target site's own `PendingSiteProposal`
/// carries (A2, pending.sites migration -- see `OwnerSemantics::pending_
/// site_rows`'s doc comment) -- two different candidates for the SAME site
/// must get two DIFFERENT identities, which only the target-bearing recipe
/// provides. `facets` gain `"core:indirect"` even though a `target_id` is
/// present -- this is v3's own possible-classification convention and the
/// exact bit a later residual pass keys on to find candidate rows
/// generically, by metadata, without decoding a body (see `crate::v4::
/// residual`'s `dump_call_bodies`/`collect` doc comments for how the
/// store-level `target_subject().is_some() && !core:indirect` confirmed
/// test stays correct with this row shape live).
fn candidate_call_record(path: &str, row: &CandidateCallRow) -> ProposedRecord {
    let identity_key = format!(
        "jsts:call:{path}:{}:{}:{}:{}",
        row.start, row.end, row.source_id, row.target_id
    );
    let mut body = serde_json::Map::new();
    body.insert(
        "source_id".into(),
        serde_json::Value::String(row.source_id.clone()),
    );
    body.insert(
        "target_id".into(),
        serde_json::Value::String(row.target_id.clone()),
    );
    body.insert(
        "classification".into(),
        serde_json::Value::String("possible".into()),
    );
    body.insert("path".into(), serde_json::Value::String(path.to_owned()));
    body.insert("start".into(), serde_json::Value::from(row.start));
    body.insert("end".into(), serde_json::Value::from(row.end));
    body.insert(
        "reason".into(),
        serde_json::Value::String(row.reason.to_owned()),
    );
    let facets = serde_json::json!(["core:reference_relation", "core:indirect"]);
    ProposedRecord {
        proposal_record_key: proposal_record_key(&identity_key),
        category: "relation",
        kind: "jsts:relation_call".to_owned(),
        universal_kind: "core:call".to_owned(),
        facets_list: facets_list_from_value(&facets),
        facets: canonical_json(&facets),
        schema_version: 1,
        source_span: canonical_span(path, row.start, row.end),
        identity_key,
        body: serde_json::Value::Object(body),
        evidence_references: canonical_evidence(path, row.start, row.end),
    }
}

/// Parameter entities, "referenced-only" variant: the `jsts:entity_
/// parameter` `ProposedRecord` for one [`ParameterDeclarationFact`] that
/// received at least one resolved reference. Reuses `crate::proposal_entity_
/// record` (lib.rs's own entity-record builder, private but visible to this
/// descendant module) rather than duplicating its facets/body-shape logic --
/// the SAME rules every other entity kind already gets (facets gain `"core:
/// member"` whenever `parent_id` is `Some`, which for a parameter is always:
/// `fact.parent_id` is either a real callable/member/variable entity id or
/// the module id, `visit_formal_parameter`'s own fallback, never absent).
///
/// `parent_id` resolution rule (the "enclosing callable's entity id when
/// that callable has one" contract, owner-approved 2026-09-04): a NAMED
/// function declaration (`visit_function`'s `pushed` branch) -- a class OR
/// interface method/constructor/getter/setter/property signature whose
/// container is module-level and named, i.e. one `push_member_entities`
/// (lib.rs) actually emits an entity for TODAY (`member_qualified_names`,
/// built from `urdira_jsts_typeflow::member_declarations` directly) -- or a
/// variable-bound arrow/function-expression that is the FIRST declarator of
/// its own `VariableDeclaration` with an identifier binding (the one case
/// `lib.rs`'s plain entity pass actually emits a `core:value` entity for).
/// Every other enclosing shape -- an anonymous callback, an object-literal
/// shorthand method (never in `member_declarations`), a NESTED or ANONYMOUS
/// class/interface's own member, a non-first declarator's arrow/function-
/// expression -- falls back to the OWNER's own module entity, exactly like
/// `push_entity`'s own module-parented entities.
fn parameter_entity_record(
    path: &str,
    language: crate::Language,
    fact: &ParameterDeclarationFact,
) -> ProposedRecord {
    let entity = crate::SyntaxEntity {
        id: fact.entity_id.clone(),
        name: fact.name.clone(),
        kind: crate::EntityKind::Parameter,
        universal_kind: crate::UniversalKind::Parameter,
        path: path.to_owned(),
        start: fact.start,
        end: fact.end,
        parent_id: Some(fact.parent_id.clone()),
        qualified_name: Some(fact.qualified_name.clone()),
        is_test: None,
    };
    crate::proposal_entity_record(&entity, language)
}

/// Parameter entities, "referenced-only" variant: the `core:contains`
/// `ProposedRecord` for `fact`'s parent -> parameter edge. Id format matches
/// `SyntaxCollector::push_relation`'s own recipe exactly (`jsts:{kind}:
/// {path}:{start}:{end}:{source_id}:{target_id}`), so a parameter's
/// `contains` row is indistinguishable, by shape, from one `push_member_
/// entities` (lib.rs) would have produced had it been the one materializing
/// this row.
fn parameter_contains_record(path: &str, fact: &ParameterDeclarationFact) -> ProposedRecord {
    let id = format!(
        "jsts:contains:{path}:{}:{}:{}:{}",
        fact.start, fact.end, fact.parent_id, fact.entity_id
    );
    let relation = crate::SyntaxRelation {
        id,
        kind: crate::RelationKind::Contains,
        source_id: fact.parent_id.clone(),
        target_id: Some(fact.entity_id.clone()),
        path: path.to_owned(),
        start: fact.start,
        end: fact.end,
        classification: crate::RelationClassification::Confirmed,
    };
    crate::proposal_relation_record(&relation)
}

/// 2026-09-04 references-parity task, bucket 1: the `core:value` (`jsts:
/// entity_variable`) `ProposedRecord` for one catch-clause binding fact that
/// received at least one resolved reference -- the `DeclKind::Variable`
/// sibling of `parameter_entity_record`, same `parent_id` resolution rule
/// (`fact.parent_id` is either a real enclosing callable/member/variable
/// entity id or the module id, `visit_catch_parameter`'s own fallback,
/// mirroring `visit_formal_parameter`'s), same reuse of `crate::proposal_
/// entity_record`. Only `kind`/`universal_kind` differ from the parameter
/// builder.
fn catch_variable_entity_record(
    path: &str,
    language: crate::Language,
    fact: &ParameterDeclarationFact,
) -> ProposedRecord {
    let entity = crate::SyntaxEntity {
        id: fact.entity_id.clone(),
        name: fact.name.clone(),
        kind: crate::EntityKind::Variable,
        universal_kind: crate::UniversalKind::Value,
        path: path.to_owned(),
        start: fact.start,
        end: fact.end,
        parent_id: Some(fact.parent_id.clone()),
        qualified_name: Some(fact.qualified_name.clone()),
        is_test: None,
    };
    crate::proposal_entity_record(&entity, language)
}

/// 2026-09-04 references-parity task, bucket 1: the `core:contains`
/// `ProposedRecord` for one catch-clause binding fact's parent -> variable
/// edge -- byte-identical shape to `parameter_contains_record`.
fn catch_variable_contains_record(path: &str, fact: &ParameterDeclarationFact) -> ProposedRecord {
    let id = format!(
        "jsts:contains:{path}:{}:{}:{}:{}",
        fact.start, fact.end, fact.parent_id, fact.entity_id
    );
    let relation = crate::SyntaxRelation {
        id,
        kind: crate::RelationKind::Contains,
        source_id: fact.parent_id.clone(),
        target_id: Some(fact.entity_id.clone()),
        path: path.to_owned(),
        start: fact.start,
        end: fact.end,
        classification: crate::RelationClassification::Confirmed,
    };
    crate::proposal_relation_record(&relation)
}

impl<'a, 'ctx, 'r> Visit<'a> for SemanticWalker<'a, 'ctx, 'r> {
    fn visit_identifier_reference(&mut self, ident: &IdentifierReference<'a>) {
        let start = ident.span.start;
        let end = ident.span.end;
        match self.resolve_identifier_reference(ident) {
            ReferenceResolution::Resolved {
                target_id,
                cross_file,
            } => {
                self.push_site(
                    SiteKind::IdentifierRef,
                    start,
                    end,
                    SiteDisposition::RustResolved,
                    None,
                );
                let source_id = self.current_owner();
                // A declaration referencing its own name from within its own
                // body (e.g. a recursive call) is not published as a
                // `core:references` row by the checker either -- see the
                // `relationSource.id !== target.id` guard in `relate` --
                // so mirror that here even though Rust proved the target.
                if source_id != target_id {
                    // Parameter entities, "referenced-only" variant: record
                    // the target BEFORE moving `target_id` into `ReferenceRow`
                    // below. `DeclKind::Parameter`'s own `identity_name`
                    // ("parameter") is the second `:`-delimited segment of
                    // its target id (`declaration_id`'s own recipe,
                    // `jsts:parameter:{path}:{nameStart}:{name}`) -- checking
                    // the prefix directly here (rather than re-parsing it
                    // through `target_id_kind_name`) keeps this hot path a
                    // single `starts_with`.
                    if target_id.starts_with("jsts:parameter:") {
                        self.referenced_parameter_targets.insert(target_id.clone());
                    }
                    // 2026-09-04 references-parity task, bucket 1: same
                    // "referenced-only" recording for a catch-clause
                    // binding target (`DeclKind::Variable`'s own
                    // `"jsts:variable:"` prefix) -- see `referenced_catch_
                    // targets`'s own doc comment for why matching an
                    // ordinary (non-catch) variable target here too is
                    // harmless.
                    if target_id.starts_with("jsts:variable:") {
                        self.referenced_catch_targets.insert(target_id.clone());
                    }
                    self.reference_rows.push(ReferenceRow {
                        start,
                        end,
                        source_id,
                        target_id,
                        cross_file,
                    });
                }
            }
            ReferenceResolution::Pending(reason) => {
                self.push_site(
                    SiteKind::IdentifierRef,
                    start,
                    end,
                    SiteDisposition::CheckerPending,
                    Some(reason),
                );
            }
        }
    }

    fn visit_this_expression(&mut self, expr: &ThisExpression) {
        self.push_site(
            SiteKind::IdentifierRef,
            expr.span.start,
            expr.span.end,
            SiteDisposition::CheckerPending,
            Some(self.identifier_pending_reason(REASON_THIS_EXPRESSION)),
        );
    }

    /// Found during E1c's cardinality reconciliation: an import specifier's
    /// LOCAL binding (`local` in `import { imported as local } from "m"`,
    /// or the plain name in `import { name } from "m"`) is, correctly, an
    /// oxc `BindingIdentifier` -- a declaration, not a reference -- so the
    /// default walk never routes it through `visit_identifier_reference`
    /// and it would otherwise carry no site at all. The checker's own
    /// `isIdentifier` walk, by contrast, has no `ImportSpecifier`/
    /// `ImportDefaultSpecifier`/`ImportNamespaceSpecifier` entry in
    /// `rustSemanticDeclarationShape`, so it has always (pre-E1c too)
    /// treated this same position as an ordinary reference and resolved it
    /// through the aliased symbol -- e.g. a same-project import specifier
    /// resolves straight to the exporting module's declaration. Mirror that
    /// by giving it a pending `identifier_ref` site: cross-module
    /// resolution is E2's job, not E1's, so this is never `rust_resolved`
    /// here (matches `REASON_IMPORT_BINDING`'s existing meaning for an
    /// ordinary reference to an aliased/imported symbol).
    /// E2: attempt full resolution before falling back to the
    /// `checker_pending` site both `local` and (when aliased) `imported`
    /// always got pre-E2. `imported` can only be `IdentifierName` or
    /// `StringLiteral` in oxc (never `IdentifierReference`); an arbitrary
    /// module namespace name (`import { "weird name" as x } from "m"`)
    /// stays pending -- `resolve_named_export` is never even attempted --
    /// since its exported-name text does not round-trip through
    /// `SyntaxExportBinding::exported_name` any differently, but keeping
    /// the scope narrow (identifier-shaped names only) avoids a subtle
    /// string-literal-vs-identifier export-name collision.
    fn visit_import_specifier(&mut self, specifier: &ImportSpecifier<'a>) {
        let imported_name = match &specifier.imported {
            ModuleExportName::IdentifierName(name) => Some(name.name.as_str().to_owned()),
            ModuleExportName::IdentifierReference(_) | ModuleExportName::StringLiteral(_) => None,
        };
        // External package/symbol entities task: `import { type Foo }` is
        // type-only per-specifier even inside a value-mode declaration;
        // `import type { Foo }` makes EVERY specifier type-only regardless
        // of its own `import_kind` (oxc always reports `Value` for a
        // specifier under a type-only declaration -- the declaration-level
        // flag is the authority there).
        let is_type =
            self.current_import_type_only || specifier.import_kind == ImportOrExportKind::Type;
        let resolution = imported_name
            .as_deref()
            .map(|name| {
                self.resolve_import_binding(
                    name,
                    is_type,
                    specifier.local.span.start,
                    specifier.local.span.end,
                )
            })
            .unwrap_or(ReferenceResolution::Pending(REASON_IMPORT_BINDING));
        self.site_import_binding(
            specifier.local.span.start,
            specifier.local.span.end,
            &resolution,
        );
        // Found alongside `REASON_RE_EXPORT_BINDING`, same reconciliation
        // gate: `imported` (`Tool` in `import { Tool as ToolBuilder } from
        // "m"` -- the name being pulled in, as opposed to `local`, the
        // binding it is pulled in AS) is its own separate position whenever
        // the specifier is aliased, and the checker's `isIdentifier` walk
        // visits and resolves it exactly like `local` (both are plain
        // `Identifier` children of `ImportSpecifier` to the checker, with no
        // `local`/`imported` distinction in `rustSemanticDeclarationShape`).
        // Unaliased, `imported` and `local` share the same span -- a
        // harmless duplicate PENDING site pre-E2 (deduped downstream by
        // whatever consumes `pending_sites`), but E2's `RustResolved` case
        // ALSO pushes a `core:references` proposed record keyed on
        // `start`/`end`/`source_id`/`target_id` -- pushing that identical
        // row twice collides on `record_id` at publish time (found live
        // against the n8n corpus: `UNIQUE constraint failed: record_
        // occurrences.record_id`). Guard on span inequality so the
        // unaliased case sites/resolves `local` exactly once.
        if let ModuleExportName::IdentifierName(imported) = &specifier.imported
            && imported.span != specifier.local.span
        {
            self.site_import_binding(imported.span.start, imported.span.end, &resolution);
        }
        if let Some(symbol_id) = specifier.local.symbol_id.get() {
            self.import_bindings.insert(symbol_id, resolution);
            if let Some(name) = imported_name.as_deref() {
                self.register_namespace_reexport(symbol_id, name);
            }
        }
        walk_import_specifier(self, specifier);
    }

    /// Captures the specifier text (`"m"` in `import { a } from "m"`) for
    /// the duration of walking this declaration's specifiers, so
    /// `visit_import_specifier` can resolve against it. Import declarations
    /// never nest, so a simple save/restore (not a stack) is exact.
    fn visit_import_declaration(&mut self, declaration: &ImportDeclaration<'a>) {
        let previous = self
            .current_import_source
            .replace(declaration.source.value.as_str().to_owned());
        let previous_type_only = self.current_import_type_only;
        self.current_import_type_only = declaration.import_kind == ImportOrExportKind::Type;
        walk_import_declaration(self, declaration);
        self.current_import_source = previous;
        self.current_import_type_only = previous_type_only;
    }

    /// See `visit_import_specifier`: `local` in `import local from "m"`.
    ///
    /// 2026-09-04 references-parity task, Phase B bucket 1: until this fix,
    /// a default import's binding site NEVER attempted resolution at all
    /// (unconditionally `checker_pending`, and -- unlike a named import's
    /// `import_bindings.insert` in `visit_import_specifier` -- never
    /// inserted into `import_bindings` either, so every LATER use of the
    /// bound identifier elsewhere in the file fell into `resolve_
    /// identifier_reference`'s `unwrap_or(Pending(REASON_IMPORT_BINDING))`
    /// fallback too). Now resolved through the exact same `resolve_import_
    /// binding` chain a named import's `imported` name goes through, with
    /// the exported name fixed to `"default"` -- `lib.rs`'s new `visit_
    /// export_default_declaration` is what makes that lookup succeed for a
    /// nameable default export (see that function's own doc comment for
    /// the live n8n sample this closes: `import buildTrivyBlocks from
    /// "./build-trivy-blocks.mjs"`). An anonymous/non-nameable default
    /// export (no matching `export_bindings` entry) still degrades to
    /// `Pending(REASON_IMPORT_BINDING)` exactly like before -- never a
    /// guess.
    fn visit_import_default_specifier(&mut self, specifier: &ImportDefaultSpecifier<'a>) {
        let resolution = self.resolve_import_binding(
            "default",
            self.current_import_type_only,
            specifier.local.span.start,
            specifier.local.span.end,
        );
        self.site_import_binding(
            specifier.local.span.start,
            specifier.local.span.end,
            &resolution,
        );
        if let Some(symbol_id) = specifier.local.symbol_id.get() {
            self.import_bindings.insert(symbol_id, resolution);
        }
        walk_import_default_specifier(self, specifier);
    }

    /// See `visit_import_specifier`: `local` in `import * as local from "m"`.
    ///
    /// External package/symbol entities task (item 2): unlike a named/
    /// default import, a namespace import's own binding used AS A VALUE
    /// (`import * as _ from "lodash"; foo(_)`, not a `_.member` access --
    /// see `visit_static_member_expression`/`resolve_external_namespace_
    /// member` for that case) now resolves, with certainty, to `jsts:
    /// external_symbol:{specifier}#*` when `specifier` is external -- the
    /// SAME `#*` sentinel name `external_symbol_id` uses for every
    /// namespace binding, matching how a default import always resolves to
    /// `#default`. A workspace-resolved namespace import is UNCHANGED
    /// (stays `checker_pending`: there is no single declaration a namespace
    /// binding used as a bare value resolves to, internal or external,
    /// except in the external case, where the "declaration" is simply the
    /// external module's own symbol table entry for `*`).
    fn visit_import_namespace_specifier(&mut self, specifier: &ImportNamespaceSpecifier<'a>) {
        let is_type = self.current_import_type_only;
        let unresolved_source = self.current_import_source.as_deref().filter(|source| {
            self.ctx
                .resolver
                .resolve(&self.path, source, self.ctx.available)
                .is_none()
        });
        // Ambient module resolution task (2026-09-04), fix item 2: same
        // first-refusal order as `resolve_named_binding_via_specifier` --
        // `import * as ns from "specifier"`'s own binding, used as a bare
        // VALUE (not a `ns.member` access, see `resolve_external_namespace_
        // member` for that), resolves to the ambient block's own namespace
        // entity when `specifier` is uniquely ambiently declared.
        let ambient = unresolved_source.and_then(|source| {
            match self.ctx.ambient_index.resolve_export(source, "*") {
                resolver::AmbientResolution::Resolved(target_id) => Some(target_id),
                _ => None,
            }
        });
        // `source` ambiently declared but NOT uniquely resolved (several
        // declaring files, or a shorthand block) stays pending here too --
        // `has_any_declaration` gates the external fallback exactly like
        // `resolve_named_binding_via_specifier`'s own `Ambiguous` arm does.
        let external = match ambient {
            Some(_) => None,
            None => unresolved_source.and_then(|source| {
                if self.ctx.ambient_index.has_any_declaration(source) {
                    if resolver::classify_external_specifier(source).is_some() {
                        AMBIGUOUS_AMBIENT_WOULD_BE_EXTERNAL
                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                    None
                } else {
                    resolver::classify_external_specifier(source)
                }
            }),
        };
        let resolution = if let Some(target_id) = ambient {
            ReferenceResolution::Resolved {
                target_id,
                cross_file: true,
            }
        } else if let Some(canonical) = external {
            self.emit_external_use(
                &canonical,
                "*",
                is_type,
                specifier.local.span.start,
                specifier.local.span.end,
                true,
            );
            ReferenceResolution::Resolved {
                target_id: resolver::external_symbol_id(&canonical, "*"),
                cross_file: true,
            }
        } else {
            ReferenceResolution::Pending(REASON_IMPORT_BINDING)
        };
        self.site_import_binding(
            specifier.local.span.start,
            specifier.local.span.end,
            &resolution,
        );
        if let Some(symbol_id) = specifier.local.symbol_id.get() {
            self.import_bindings.insert(symbol_id, resolution);
        }
        // P1-A (rule (f)): record `ns`'s own specifier for `resolve_
        // namespace_member`/`resolve_external_namespace_member`'s later
        // `ns.member(...)`/`ns.member` lookups -- see `namespace_import_
        // specifiers`'s doc comment. Recorded regardless of internal/
        // external (both consult this same map, each trying its own
        // resolution and leaving the site pending if neither succeeds).
        if let (Some(symbol_id), Some(source)) =
            (specifier.local.symbol_id.get(), &self.current_import_source)
        {
            self.namespace_import_specifiers
                .insert(symbol_id, source.clone());
        }
        walk_import_namespace_specifier(self, specifier);
    }

    /// 2026-09-04 references-parity task, Phase B bucket 1: captures the
    /// enclosing declaration's own `source` specifier text (`"./x"` in
    /// `export { a } from "./x"`, `None` for the sourceless `export { a, b
    /// as c }` form) for `visit_export_specifier`'s `local` position to
    /// resolve against, the same save/restore pattern `visit_import_
    /// declaration` already uses for `current_import_source`. Export
    /// declarations never nest, so a simple save/restore (not a stack) is
    /// exact here too.
    fn visit_export_named_declaration(&mut self, declaration: &ExportNamedDeclaration<'a>) {
        let previous = self.current_export_source.take();
        self.current_export_source = declaration
            .source
            .as_ref()
            .map(|source| source.value.as_str().to_owned());
        let previous_type_only = self.current_export_type_only;
        self.current_export_type_only = declaration.export_kind == ImportOrExportKind::Type;
        walk_export_named_declaration(self, declaration);
        self.current_export_source = previous;
        self.current_export_type_only = previous_type_only;
    }

    /// `export { correctness } from "./correctness"` -- see
    /// `REASON_RE_EXPORT_BINDING`'s doc comment for why oxc's parser gives a
    /// RE-export specifier's `local` name `ModuleExportName::IdentifierName`
    /// (not `IdentifierReference`), which the default walk routes through
    /// `visit_identifier_name` -- a no-op here, so it needs its own site. A
    /// sourceless `export { foo }` genuinely references the local binding
    /// `foo` through an ordinary, already-correctly-sited
    /// `IdentifierReference` instead (oxc's own `ModuleExportName` doc
    /// comment), so `local` here is deliberately unconditional on this
    /// pattern match alone rather than also checking for a `source` --
    /// exactly one of the two ever actually matches for a given specifier.
    ///
    /// `exported` (the alias visible to THIS module's own consumers -- `bar`
    /// in `export { foo as bar }`, with or without a `from` clause) is
    /// ALWAYS `IdentifierName`, since it can never itself be a local scope
    /// reference. Verified empirically against the real checker (not
    /// assumed) that it is nonetheless resolved by the checker in EVERY
    /// aliased case Rust can observe here -- re-exports and even some
    /// (inconsistent: TS resolves it for a `const`/`let`/`var` original
    /// declaration, not for a `function` one -- a real checker quirk, not
    /// worth replicating) sourceless aliased exports alike -- so err
    /// conservative and always site it too. The `span != local`-role guard
    /// below is what keeps a NON-aliased specifier safe: there `exported`
    /// shares the exact same span as `local`'s own (already `rust_resolved`)
    /// `IdentifierReference` site, and double-siting that position would
    /// make the checker re-resolve and re-emit a row Rust already published
    /// -- an identity_key collision under strict merge.
    ///
    /// 2026-09-04 references-parity task, Phase B bucket 1: BOTH positions
    /// now attempt resolution instead of unconditionally staying pending --
    /// `local` (with-source form only, per the AST-shape test above) via
    /// `resolve_export_source_binding` (`current_export_source` +
    /// `resolve_named_export`, the exact same chain a named import's
    /// `imported` name already used); `exported`, whichever form it
    /// belongs to, via WHATEVER `local` in that same specifier resolves to
    /// -- the with-source form's own just-computed resolution (`exported`
    /// is a plain ALIAS of the same target, not a second lookup), or, for
    /// the sourceless form, `local`'s own `IdentifierReference` re-resolved
    /// through the ordinary local-symbol chain (`resolve_identifier_
    /// reference`, the SAME resolution the default walk's own `visit_
    /// identifier_reference` call on that exact node already computes
    /// independently -- redundant but cheap, and avoids threading a
    /// separate "last local resolution" field through the walker for one
    /// caller). A `ModuleExportName::StringLiteral` position (either side)
    /// is never attempted, matching the pre-existing scope note below.
    fn visit_export_specifier(&mut self, specifier: &ExportSpecifier<'a>) {
        let local_span = specifier.local.span();
        let local_resolution = match &specifier.local {
            ModuleExportName::IdentifierName(name) => {
                let is_type = self.current_export_type_only
                    || specifier.export_kind == ImportOrExportKind::Type;
                let resolution = self.resolve_export_source_binding(
                    name.name.as_str(),
                    is_type,
                    name.span.start,
                    name.span.end,
                );
                self.site_import_binding(name.span.start, name.span.end, &resolution);
                Some(resolution)
            }
            // Sourceless `export { foo }`: `local` is an ordinary
            // `IdentifierReference`, already sited/resolved by the default
            // walk's own `visit_identifier_reference` call -- nothing to do
            // here, `exported`'s own arm below re-derives the same
            // resolution for its own (different) span.
            ModuleExportName::IdentifierReference(_) | ModuleExportName::StringLiteral(_) => None,
        };
        if let ModuleExportName::IdentifierName(name) = &specifier.exported
            && name.span != local_span
        {
            let exported_resolution = match (&local_resolution, &specifier.local) {
                (Some(resolution), _) => resolution.clone(),
                (None, ModuleExportName::IdentifierReference(local_ident)) => {
                    self.resolve_identifier_reference(local_ident)
                }
                (None, _) => ReferenceResolution::Pending(REASON_RE_EXPORT_BINDING),
            };
            self.site_import_binding(name.span.start, name.span.end, &exported_resolution);
        }
        walk_export_specifier(self, specifier);
    }

    fn visit_static_member_expression(&mut self, expr: &StaticMemberExpression<'a>) {
        let start = expr.property.span.start;
        let end = expr.property.span.end;
        // 2026-09-04 references-parity task: attempt typeflow resolution
        // BEFORE falling back to the pending site -- see `resolve_static_
        // member_reference`'s own doc comment for why every position
        // (read, call callee, assignment target) is attempted uniformly,
        // and why `jsdoc_typed_file` still wins over a would-be resolution
        // (the safe-partition rule applies here exactly like every other
        // identifier-kind site in this file: a JSDoc-typed file's own
        // typeflow index input is unreliable, so it stays pending too).
        let resolved = if self.jsdoc_typed_file {
            None
        } else {
            self.resolve_static_member_reference(expr)
        };
        // External package/symbol entities task (item 2): when typeflow
        // could not resolve this member read (`resolved` is `None`), try
        // ONE more thing before falling back to the pending site -- is the
        // receiver a plain identifier bound by an EXTERNAL `import * as ns`
        // (`_.get` in `import * as _ from "lodash"; _.get(...)`)? A static
        // property name only (`expr.property` is always a plain
        // `IdentifierName` for a `StaticMemberExpression` -- a computed
        // access `ns[expr]` is a different AST node, `ComputedMemberExpression`,
        // not reachable here at all). Emits the symbol entity when found
        // (see `emit_external_use`'s own doc comment).
        let external = if resolved.is_some() || self.jsdoc_typed_file {
            None
        } else {
            self.resolve_external_namespace_member(&expr.object, expr.property.name.as_str())
        };
        if let Some(NamespaceMemberResolution::External(canonical, _)) = &external {
            self.emit_external_use(
                canonical,
                expr.property.name.as_str(),
                false,
                start,
                end,
                false,
            );
        }
        let external_target_id = external.map(|resolution| match resolution {
            NamespaceMemberResolution::External(_, target_id)
            | NamespaceMemberResolution::Ambient(target_id) => target_id,
        });
        match resolved.or(external_target_id) {
            Some(target_id) => {
                self.push_site(
                    SiteKind::IdentifierRef,
                    start,
                    end,
                    SiteDisposition::RustResolved,
                    None,
                );
                let source_id = self.current_owner();
                // Same self-reference guard as `visit_identifier_reference`
                // (mirrors the checker's own `relationSource.id !==
                // target.id` in `analyzer.ts`'s `relate`): a member
                // referencing itself from within its own body (rare, but
                // possible for a recursive getter) is not published.
                if source_id != target_id {
                    self.reference_rows.push(ReferenceRow {
                        start,
                        end,
                        source_id,
                        target_id,
                        // Typeflow-resolved rows never track cross-file-ness
                        // -- same precedent as `typeflow_call_rows`/`CallRow`
                        // (no `cross_file` field at all): `ProgramIndex` is
                        // corpus-wide, so a member's declaring file can
                        // differ from this owner's, but this round does not
                        // extend `core:covers` derivation to typeflow-
                        // resolved member reads.
                        cross_file: false,
                    });
                }
            }
            None => {
                let reason = if self.jsdoc_typed_file {
                    REASON_JSDOC_TYPED_FILE
                } else {
                    self.member_access_sub_reason(&expr.object)
                };
                self.push_site(
                    SiteKind::IdentifierRef,
                    start,
                    end,
                    SiteDisposition::CheckerPending,
                    Some(reason),
                );
            }
        }
        walk_static_member_expression(self, expr);
    }

    fn visit_ts_qualified_name(&mut self, name: &TSQualifiedName<'a>) {
        self.push_site(
            SiteKind::IdentifierRef,
            name.right.span.start,
            name.right.span.end,
            SiteDisposition::CheckerPending,
            Some(self.identifier_pending_reason(REASON_MEMBER_ACCESS)),
        );
        walk_ts_qualified_name(self, name);
    }

    /// A type predicate's parameter name (`value` in `(value: unknown):
    /// value is Foo`, and its `asserts` forms) repeats a real parameter's
    /// own name purely so the checker can bind the narrowing back to it --
    /// see `REASON_TYPE_PREDICATE_PARAMETER`'s doc comment for why oxc gives
    /// it no `IdentifierReference` at all. `this is Foo` predicates
    /// (`TSTypePredicateName::This`) have no identifier and are left alone.
    ///
    /// 2026-09-04 references-parity task, bucket 3: manually bind `name`
    /// against `predicate_param_stack.last()` (the predicate's OWN
    /// enclosing signature's parameters -- never an outer one, by
    /// construction: the stack frame is pushed/popped bracketing exactly
    /// that signature's own walk). A match resolves and sites exactly like
    /// `visit_identifier_reference`'s `Resolved` arm (own `core:references`
    /// row, `referenced_parameter_targets` bookkeeping so the parameter
    /// entity materializes even when the predicate is its ONLY reference);
    /// no match (the name is not among this signature's own simple
    /// parameters -- should not happen for valid TS, but never assumed)
    /// keeps today's `checker_pending` fallback, same reason as before this
    /// fix. Gated on `jsdoc_typed_file` up front, matching every other
    /// hand-rolled resolution in this file (this one does not go through
    /// `resolve_identifier_reference`, which is where that gate normally
    /// lives).
    fn visit_ts_type_predicate(&mut self, predicate: &TSTypePredicate<'a>) {
        if let TSTypePredicateName::Identifier(name) = &predicate.parameter_name {
            let matched: Option<u32> = if self.jsdoc_typed_file {
                None
            } else {
                self.predicate_param_stack.last().and_then(|params| {
                    params
                        .iter()
                        .find(|(param_name, ..)| param_name == name.name.as_str())
                        .map(|(_, start, _)| *start)
                })
            };
            match matched {
                Some(param_start) => {
                    let target_id = declaration_id(
                        DeclKind::Parameter,
                        &self.path,
                        param_start,
                        name.name.as_str(),
                    );
                    self.push_site(
                        SiteKind::IdentifierRef,
                        name.span.start,
                        name.span.end,
                        SiteDisposition::RustResolved,
                        None,
                    );
                    let source_id = self.current_owner();
                    if source_id != target_id {
                        self.referenced_parameter_targets.insert(target_id.clone());
                        self.reference_rows.push(ReferenceRow {
                            start: name.span.start,
                            end: name.span.end,
                            source_id,
                            target_id,
                            cross_file: false,
                        });
                    }
                }
                None => {
                    self.push_site(
                        SiteKind::IdentifierRef,
                        name.span.start,
                        name.span.end,
                        SiteDisposition::CheckerPending,
                        Some(self.identifier_pending_reason(REASON_TYPE_PREDICATE_PARAMETER)),
                    );
                }
            }
        }
        walk_ts_type_predicate(self, predicate);
    }

    /// E3, T1: a plain-identifier callee resolving to a single function/class
    /// declaration with no overloads becomes `rust_resolved` with its own
    /// `core:call` row; everything else (member/`this`/`super` callees --
    /// `new` never reaches this visitor at all, see `visit_import_
    /// expression`'s sibling doc comment -- an expression callee, an
    /// overloaded/unresolved/non-callable target) stays `checker_pending`
    /// exactly as before E3. No self-reference guard: see `CallRow`'s doc
    /// comment for why a recursive call is still published.
    fn visit_call_expression(&mut self, expr: &CallExpression<'a>) {
        let start = expr.span.start;
        let end = expr.span.end;
        let callee_is_identifier = matches!(&expr.callee, Expression::Identifier(_));
        match self.resolve_call_target(expr) {
            Some(target_id) => {
                self.push_site(
                    SiteKind::Call,
                    start,
                    end,
                    SiteDisposition::RustResolved,
                    None,
                );
                let source_id = self.current_owner();
                self.call_rows.push(CallRow {
                    start,
                    end,
                    source_id,
                    target_id,
                });
            }
            None => {
                // A non-identifier callee (member/`this`/`super`/any other
                // expression) is never even attempted, unlike an identifier
                // callee that WAS attempted but stayed doubtful -- see the
                // two reasons' own doc comments.
                let reason = if callee_is_identifier {
                    REASON_CALL_TARGET_UNCERTAIN
                } else {
                    REASON_CALL_DEFERRED
                };
                // P0-S2 typeflow: widen to a member-access/`this`/`super`
                // callee E3 never even attempts (see `resolve_call_target_
                // typeflow`'s doc comment).
                // P1-A census classifier (diagnostic only): record the
                // receiver shape for every non-identifier-callee call BEFORE
                // deciding whether typeflow resolved it -- see
                // `OwnerSemantics::typeflow_pending_call_shapes`'s doc
                // comment. Gated on oracle mode (never touched in
                // production, where nothing reads this vector).
                if !callee_is_identifier && self.ctx.typeflow_oracle {
                    let shape = self.classify_receiver_shape(&expr.callee);
                    self.typeflow_pending_call_shapes
                        .push(TypeflowPendingShape { start, end, shape });
                }
                let resolution = self.resolve_call_target_typeflow(expr);
                if self.ctx.typeflow_oracle {
                    // P2-2j: oracle mode compares a SINGLE typeflow guess
                    // against the checker's own independent answer for the
                    // same site -- a `Candidates` outcome is not a single
                    // guess to compare, so it is deliberately folded into
                    // the SAME plain-pending path `Unresolved` already
                    // takes here (no oracle hit, no candidate rows) rather
                    // than inventing oracle semantics for a set. This whole
                    // feature stays orthogonal to the research-only oracle
                    // flag.
                    if let TypeflowCallResolution::Resolved(target_id, rule) = &resolution {
                        self.typeflow_oracle_hits.push(TypeflowOracleHit {
                            start,
                            end,
                            edge_kind: "call",
                            rule,
                            source_id: self.current_owner(),
                            target_id: target_id.clone(),
                        });
                    }
                    self.push_site(
                        SiteKind::Call,
                        start,
                        end,
                        SiteDisposition::CheckerPending,
                        Some(reason),
                    );
                    self.pending_call_sites.push(PendingCallSite {
                        start,
                        end,
                        source_id: self.current_owner(),
                        reason,
                    });
                } else {
                    match resolution {
                        TypeflowCallResolution::Resolved(target_id, _rule) => {
                            self.push_site(
                                SiteKind::Call,
                                start,
                                end,
                                SiteDisposition::RustResolved,
                                None,
                            );
                            let source_id = self.current_owner();
                            self.typeflow_call_rows.push(CallRow {
                                start,
                                end,
                                source_id,
                                target_id,
                            });
                        }
                        // P2-2j: the site stays PENDING (with the candidate
                        // reason -- exactly like an `Unresolved` site, just
                        // a different reason) AND gets one `CandidateCallRow`
                        // per candidate, so the residual pass can still
                        // upgrade it to a single confirmed row later while
                        // the query engine can already traverse each
                        // candidate today.
                        TypeflowCallResolution::Candidates {
                            targets,
                            reason: candidate_reason,
                        } => {
                            self.push_site(
                                SiteKind::Call,
                                start,
                                end,
                                SiteDisposition::CheckerPending,
                                Some(candidate_reason),
                            );
                            let source_id = self.current_owner();
                            self.pending_call_sites.push(PendingCallSite {
                                start,
                                end,
                                source_id: source_id.clone(),
                                reason: candidate_reason,
                            });
                            for target_id in targets {
                                self.candidate_call_rows.push(CandidateCallRow {
                                    start,
                                    end,
                                    source_id: source_id.clone(),
                                    target_id,
                                    reason: candidate_reason,
                                });
                            }
                        }
                        TypeflowCallResolution::Unresolved => {
                            self.push_site(
                                SiteKind::Call,
                                start,
                                end,
                                SiteDisposition::CheckerPending,
                                Some(reason),
                            );
                            self.pending_call_sites.push(PendingCallSite {
                                start,
                                end,
                                source_id: self.current_owner(),
                                reason,
                            });
                        }
                    }
                }
            }
        }
        walk_call_expression(self, expr);
    }

    /// Found during the call-cardinality reconciliation gate: a dynamic
    /// `import("./x")` expression is syntactically NOT a `CallExpression` to
    /// oxc -- `import` is a reserved word, never a valid callee
    /// `Expression`, so oxc gives it its own dedicated `ImportExpression`
    /// node kind -- but the checker's own TS AST still classifies it as an
    /// ordinary call (`isCallExpression` true, `directCallDeclaration`/
    /// `getResolvedSignature` predictably find nothing since there is no
    /// declared signature, `classification: "possible"`, target
    /// unresolved). Without this override the whole `core:call` edge (used
    /// by `trace_behavior`/`analyze_impact`/`find_paths`) AND its paired
    /// `jsts:unresolved_call` diagnostic both silently vanished.
    fn visit_import_expression(&mut self, expr: &ImportExpression<'a>) {
        self.push_site(
            SiteKind::Call,
            expr.span.start,
            expr.span.end,
            SiteDisposition::CheckerPending,
            Some(REASON_CALL_DEFERRED),
        );
        self.pending_call_sites.push(PendingCallSite {
            start: expr.span.start,
            end: expr.span.end,
            source_id: self.current_owner(),
            reason: REASON_CALL_DEFERRED,
        });
        walk_import_expression(self, expr);
    }

    /// E3, T2: `extends`/`implements` resolve to a `core:inherits`/
    /// `core:implements` row when the clause's type is a plain, non-generic
    /// identifier AND that identifier resolves to a single class/interface
    /// declaration; the clause's own source is THIS class's own declaration
    /// id (`self_class_id` -- an anonymous class, `class.id.is_none()`, has
    /// no entity of its own, so its heritage clauses stay pending: there is
    /// no valid `source_id` to build a row from). Qualified (`A.B`) and
    /// generic (`Base<T>`) heritage never even reach `resolve_identifier_
    /// to_kind` and stay pending exactly as before E3.
    fn visit_class(&mut self, class: &Class<'a>) {
        let self_class_id = (class.r#type == ClassType::ClassDeclaration)
            .then_some(class.id.as_ref())
            .flatten()
            .map(|ident| {
                declaration_id(
                    DeclKind::Class,
                    &self.path,
                    ident.span.start,
                    ident.name.as_str(),
                )
            });
        // P0-S2 typeflow: `resolve_super_class` both publishes this clause
        // (E3, or E3-widened via typeflow -- see its own doc comment) AND
        // returns the best-known base entity id for `super.x()` resolution
        // inside this class's own body, tracked on `class_stack` below.
        let extends_entity_id = class.super_class.as_ref().and_then(|super_class| {
            self.resolve_super_class(
                self_class_id.as_deref(),
                super_class,
                class.super_type_arguments.is_some(),
            )
        });
        // Atomic per clause (all entries or none) -- see
        // `REASON_HERITAGE_CLAUSE_PARTIALLY_PENDING`'s doc comment: TS
        // groups every `implements` entry under one syntactic
        // `ts.HeritageClause`, so a lone pending sibling would otherwise
        // make the checker's clause-level re-walk double-emit an
        // already-published sibling row.
        let implements_entries = class
            .implements
            .iter()
            .map(|implements| {
                let ident = if implements.type_arguments.is_some() {
                    None
                } else {
                    match &implements.expression {
                        TSTypeName::IdentifierReference(ident) => Some(ident.as_ref()),
                        _ => None,
                    }
                };
                (
                    implements.span.start,
                    implements.span.end,
                    self.resolve_heritage_clause(self_class_id.as_deref(), ident),
                )
            })
            .collect();
        self.finish_heritage_clause_group(
            "implements",
            implements_entries,
            self_class_id.as_deref(),
        );
        if class.r#type == ClassType::ClassDeclaration && class.id.is_some() {
            self.push_site(
                SiteKind::TypedDecl,
                class.span.start,
                class.span.end,
                SiteDisposition::CheckerPending,
                Some(REASON_TYPE_INFERENCE_REQUIRED),
            );
        }
        self.class_stack.push(ClassFrame {
            entity_id: self_class_id,
            extends_entity_id,
        });
        walk_class(self, class);
        self.class_stack.pop();
    }

    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        // Parameter entities, "referenced-only" variant: drain the one-shot
        // hint UNCONDITIONALLY, before deciding `pushed` below -- a hint can
        // only ever be set for a node reached through `declarator.init`/
        // `prop.value`, both syntactically `FunctionExpression`/
        // `ArrowFunctionExpression` NEVER a `FunctionDeclaration`, so it can
        // never actually collide with the `pushed` branch; draining it here
        // regardless is just the same "never let a hint survive past the
        // node it was set for" discipline `pending_function_owner`'s own doc
        // comment describes, applied uniformly instead of only in the branch
        // that happens to need it today.
        let pending_owner = self.pending_function_owner.take().flatten();
        let pushed = matches!(
            function.r#type,
            FunctionType::FunctionDeclaration | FunctionType::TSDeclareFunction
        ) && function.id.is_some();
        let owner = if pushed {
            let ident = function.id.as_ref().expect("checked above");
            let id = declaration_id(
                DeclKind::Function,
                &self.path,
                ident.span.start,
                ident.name.as_str(),
            );
            self.callable_stack.push(id.clone());
            self.push_site(
                SiteKind::TypedDecl,
                function.span.start,
                function.span.end,
                SiteDisposition::CheckerPending,
                Some(REASON_TYPE_INFERENCE_REQUIRED),
            );
            Some(ParamOwner {
                qualified_name: format!("{}.{}", self.path, ident.name.as_str()),
                entity_id: id,
            })
        } else {
            // Not a named function DECLARATION: either a variable-bound
            // arrow/function-expression (`pending_owner` carries the
            // variable's own `ParamOwner`, set by `visit_variable_
            // declarator` right before this call), or a genuinely anonymous
            // one (a callback argument, an IIFE, a named function EXPRESSION
            // not bound to anything, ...) -- `pending_owner` is `None` in
            // every one of those, which is exactly the "falls back to the
            // module" rule `parameter_entity_record` documents.
            pending_owner
        };
        self.param_owner_stack.push(owner);
        self.predicate_param_stack
            .push(identifier_pattern_params(&function.params.items));
        // P1-A (rule (e)): a `function`/`function expression` REBINDS
        // `this` -- unlike an arrow function (which oxc never routes
        // through `visit_function` at all: `ArrowFunctionExpression` is its
        // own, separate AST node, so arrows correctly never reach here and
        // never push this blocking frame), so `this`/`super` inside one
        // must NOT resolve to whatever class happens to be lexically
        // enclosing. Pushing a `None`/`None` frame here makes `type_of_
        // expression`'s `ThisExpression`/`Super` arms fail closed (`frame.
        // entity_id.clone()?` returns `None`) instead of leaking the outer
        // class in. `visit_method_definition` bypasses THIS override for
        // its own `.value` function (an ordinary class method's `this` DOES
        // mean the enclosing class) -- see that override's own doc comment
        // for why a class method cannot be told apart from a plain function
        // EXPRESSION by shape alone, and how it works around that.
        self.class_stack.push(ClassFrame {
            entity_id: None,
            extends_entity_id: None,
        });
        walk_function(self, function, flags);
        self.class_stack.pop();
        self.param_owner_stack.pop();
        self.predicate_param_stack.pop();
        if pushed {
            self.callable_stack.pop();
        }
    }

    /// Parameter entities, "referenced-only" variant: an arrow function
    /// never rebinds `this`/`super` (unlike `visit_function` above, this
    /// override deliberately does NOT touch `class_stack`) and is never a
    /// `callable_stack` owner either (`current_owner`'s doc comment: a
    /// reference inside an arrow body attributes to whatever lexically
    /// encloses it, exactly like the checker's own `ownerAt`) -- but its
    /// PARAMETERS still need an owner frame, drained from the same one-shot
    /// hint `visit_function` drains (`None` for a bare, unbound arrow, e.g.
    /// an inline `arr.map(x => x + 1)` callback -- the module fallback).
    fn visit_arrow_function_expression(&mut self, arrow: &ArrowFunctionExpression<'a>) {
        let owner = self.pending_function_owner.take().flatten();
        self.param_owner_stack.push(owner);
        self.predicate_param_stack
            .push(identifier_pattern_params(&arrow.params.items));
        walk_arrow_function_expression(self, arrow);
        self.predicate_param_stack.pop();
        self.param_owner_stack.pop();
    }

    fn visit_method_definition(&mut self, method: &MethodDefinition<'a>) {
        // `#privateMethod() {}` (`PropertyKey::PrivateIdentifier`) and a
        // string/numeric-literal key (`'my method'() {}`) are both just as
        // callable-owner-worthy as a `StaticIdentifier` one -- found via the
        // typed_decl/callable-owner cardinality reconciliation gates. Unlike
        // a property, THIS site's identity IS load-bearing (`callable_
        // stack`, used as the `source_id` of every reference inside the
        // method's own body), so the name must match the checker's own
        // `nameOf` exactly -- see `property_key_name`'s doc comment for the
        // private-identifier "#"-prefix pitfall it already accounts for.
        let pushed = if let Some((key_start, key_name)) = property_key_name(&method.key) {
            let kind = match method.kind {
                MethodDefinitionKind::Constructor => DeclKind::Constructor,
                MethodDefinitionKind::Method => DeclKind::Method,
                MethodDefinitionKind::Get => DeclKind::Getter,
                MethodDefinitionKind::Set => DeclKind::Setter,
            };
            let id = declaration_id(kind, &self.path, key_start, &key_name);
            self.callable_stack.push(id.clone());
            // Parameter entities, "referenced-only" variant: this call
            // bypasses `self.visit_function` below (see that call's own
            // comment), so unlike every OTHER `Function`/`ArrowFunction
            // Expression` node, `param_owner_stack` must be bracketed
            // directly here rather than through `pending_function_owner` --
            // same reasoning as the `callable_stack` push just above.
            // `member_qualified_names.get(&id)` is `None` for a method
            // whose class/interface is nested or anonymous (`member_
            // declarations` never enumerates one) -- correctly falls back
            // to the module for this method's own parameters, no dangling
            // `parent_id`.
            let owner = self
                .member_qualified_names
                .get(&id)
                .cloned()
                .map(|qualified_name| ParamOwner {
                    entity_id: id,
                    qualified_name,
                });
            self.param_owner_stack.push(owner);
            self.push_site(
                SiteKind::TypedDecl,
                method.span.start,
                method.span.end,
                SiteDisposition::CheckerPending,
                Some(REASON_TYPE_INFERENCE_REQUIRED),
            );
            true
        } else {
            false
        };
        // P0-S2 typeflow: `this`/`super` inside this method's body resolve
        // against the enclosing class's static/instance side per THIS
        // member's own `static` keyword, not the class's.
        self.static_context.push(method.r#static);
        // P1-A (rule (e)): deliberately NOT `walk_method_definition(self,
        // method)` -- that default walk dispatches to `self.visit_function`
        // for `method.value`, which (as of the P1-A fix above) pushes a
        // `this`-BLOCKING frame for every ordinary function/function
        // expression. A class method's OWN `.value` is ALWAYS a
        // `FunctionExpression` -- structurally IDENTICAL to a plain nested
        // function expression used as a value elsewhere (oxc's `Function`
        // node carries no "this is a method body" bit) -- so `visit_
        // function` cannot tell the two apart by shape alone. The fix is to
        // never let it try for THIS call: replicate `walk_method_
        // definition`'s own traversal (decorators, property key, matching
        // `visit_method_definition`'s flags computation exactly) but call
        // the free `walk_function` directly instead of `self.visit_
        // function`, so this one function body skips the override and
        // keeps seeing the enclosing class's `class_stack` frame, exactly
        // as before this fix.
        self.visit_decorators(&method.decorators);
        self.visit_property_key(&method.key);
        let flags = match method.kind {
            MethodDefinitionKind::Get => ScopeFlags::Function | ScopeFlags::GetAccessor,
            MethodDefinitionKind::Set => ScopeFlags::Function | ScopeFlags::SetAccessor,
            MethodDefinitionKind::Constructor => ScopeFlags::Function | ScopeFlags::Constructor,
            MethodDefinitionKind::Method => ScopeFlags::Function,
        };
        // Type-predicate parameter fix: `walk_function` above bypasses
        // `self.visit_function`, so its own `predicate_param_stack` push
        // never fires for a method's `.value` either -- bracket it directly
        // here, unconditionally (same "always push a frame, even empty"
        // discipline as everywhere else `predicate_param_stack` is
        // maintained), so `isFoo(x: unknown): x is Foo {}` resolves.
        self.predicate_param_stack
            .push(identifier_pattern_params(&method.value.params.items));
        walk_function(self, &method.value, flags);
        self.predicate_param_stack.pop();
        self.static_context.pop();
        if pushed {
            self.callable_stack.pop();
            self.param_owner_stack.pop();
        }
    }

    /// Object-literal methods/accessors (`{ foo() {}, get bar() {}, set bar(v) {} }`)
    /// are callable owners exactly like their class-member counterparts: the
    /// checker's `isMethodDeclaration`/`isGetAccessorDeclaration`/
    /// `isSetAccessorDeclaration` predicates match on AST node kind alone,
    /// with no parent-shape (class vs. object-literal) distinction, so a
    /// shorthand method's body must attribute its intra-file references to
    /// the method, not the enclosing scope. `{ a: 1 }`'s plain `Init`
    /// properties (`method == false`) are never callable and are left alone.
    fn visit_object_property(&mut self, prop: &ObjectProperty<'a>) {
        // String/numeric-literal-keyed shorthand methods (`{ 'Open Tag'()
        // {} }`, a real shape seen in a Lezer grammar props object) are just
        // as callable-owner-worthy as an identifier-keyed one -- found via
        // the callable-owner cardinality reconciliation gate, widening
        // beyond `StaticIdentifier` the same way `visit_method_definition`
        // already needed to for private methods (see `property_key_name`).
        let kind = if prop.kind == PropertyKind::Get {
            Some(DeclKind::Getter)
        } else if prop.kind == PropertyKind::Set {
            Some(DeclKind::Setter)
        } else if prop.method {
            Some(DeclKind::Method)
        } else {
            None
        };
        let pushed = kind
            .zip(property_key_name(&prop.key))
            .map(|(kind, (key_start, key_name))| {
                let id = declaration_id(kind, &self.path, key_start, &key_name);
                self.callable_stack.push(id);
                self.push_site(
                    SiteKind::TypedDecl,
                    prop.span.start,
                    prop.span.end,
                    SiteDisposition::CheckerPending,
                    Some(REASON_TYPE_INFERENCE_REQUIRED),
                );
            })
            .is_some();
        // Parameter entities, "referenced-only" variant: `prop.value`, when
        // it is a `Function`/`ArrowFunctionExpression` (a shorthand method's
        // OWN value, or a plain `{ onClick: () => {} }`-style property whose
        // value happens to be one), routes through `self.visit_function`/
        // `self.visit_arrow_function_expression` below via the default
        // `walk_object_property` (unlike `visit_method_definition`, this
        // override does not bypass it) -- so, UNLIKE the `callable_stack`
        // push above, the frame must go through the one-shot hint, not a
        // direct `param_owner_stack` push here (that would double-push
        // against the one `visit_function`/`visit_arrow_function_expression`
        // itself performs). `member_declarations` never enumerates object
        // literals, so an object-literal method (or property) never gets a
        // `parent_id` of its own -- `Some(None)` explicitly, in EVERY case
        // (not just when `pushed`), so a stale OUTER hint can never leak
        // into either shape.
        self.pending_function_owner = Some(None);
        walk_object_property(self, prop);
        if pushed {
            self.callable_stack.pop();
        }
    }

    /// `TSMethodSignature` covers method/getter/setter members of both
    /// interfaces (`interface I { foo(): void }`) and type-literal object
    /// types (`type T = { foo(): void }`); oxc represents all three
    /// dispositions (`method`/`get`/`set`) with the same node, distinguished
    /// only by `kind`, unlike the checker's TS AST which gives get/set their
    /// own `GetAccessorDeclaration`/`SetAccessorDeclaration` node kind even
    /// inside a signature body -- `classify_symbol_declaration` never sees
    /// these (Hallazgo B: never referenced by a bare identifier), so this
    /// override exists solely to keep `callable_stack` in sync as an owner.
    fn visit_ts_method_signature(&mut self, signature: &TSMethodSignature<'a>) {
        // A string-literal-keyed signature (`interface I { 'my method'():
        // void }`) is valid TS too, same widening as `visit_method_
        // definition`/`visit_object_property` (private keys are not valid
        // syntax here, `property_key_name` simply never matches one).
        let pushed = if let Some((key_start, key_name)) = property_key_name(&signature.key) {
            let kind = match signature.kind {
                TSMethodSignatureKind::Method => DeclKind::Method,
                TSMethodSignatureKind::Get => DeclKind::Getter,
                TSMethodSignatureKind::Set => DeclKind::Setter,
            };
            let id = declaration_id(kind, &self.path, key_start, &key_name);
            self.callable_stack.push(id);
            self.push_site(
                SiteKind::TypedDecl,
                signature.span.start,
                signature.span.end,
                SiteDisposition::CheckerPending,
                Some(REASON_TYPE_INFERENCE_REQUIRED),
            );
            true
        } else {
            false
        };
        // Type-predicate parameter fix: bracket this signature's own
        // parameter list so a predicate in its `return_type` (`isFoo(x:
        // unknown): x is Foo` on an interface/type-literal member) can
        // resolve `x` -- pushed unconditionally, matching `predicate_param_
        // stack`'s own "always a frame, even when unnamed/unpushed as a
        // callable owner" discipline.
        self.predicate_param_stack
            .push(identifier_pattern_params(&signature.params.items));
        walk_ts_method_signature(self, signature);
        self.predicate_param_stack.pop();
        if pushed {
            self.callable_stack.pop();
        }
    }

    /// Parameter entities, "referenced-only" variant: sets `declarator_owns_
    /// entity` per declarator (index `0` only) before visiting it, so
    /// `visit_variable_declarator` can tell whether ITS declarator is the
    /// one `lib.rs`'s plain entity pass actually emits a `core:value` entity
    /// for -- see that field's own doc comment. Otherwise identical to the
    /// default `walk_variable_declaration` (`visit_span` is a no-op this
    /// walker never overrides, same as every other custom-traversal override
    /// in this file, e.g. `visit_method_definition`).
    fn visit_variable_declaration(&mut self, declaration: &VariableDeclaration<'a>) {
        for (index, declarator) in declaration.declarations.iter().enumerate() {
            self.declarator_owns_entity = index == 0;
            self.visit_variable_declarator(declarator);
        }
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if matches!(&declarator.id, BindingPattern::BindingIdentifier(_)) {
            self.push_site(
                SiteKind::TypedDecl,
                declarator.span.start,
                declarator.span.end,
                SiteDisposition::CheckerPending,
                Some(REASON_TYPE_INFERENCE_REQUIRED),
            );
        }
        self.record_local_type(
            &declarator.id,
            declarator.type_annotation.as_deref(),
            declarator.init.as_ref(),
        );
        // Parameter entities, "referenced-only" variant: a variable-bound
        // arrow/function-expression owns its own params under the
        // VARIABLE's entity, not a fresh anonymous frame -- set the one-shot
        // hint `self.visit_function`/`self.visit_arrow_function_expression`
        // drains as soon as `declarator.init` (the very next node either of
        // them could possibly be) is reached below. Only when `declarator.
        // owns_entity` (this is the FIRST declarator of its own `Variable
        // Declaration` -- see that field's own doc comment) does the
        // variable actually have an entity to point at; otherwise `owner` is
        // `None`, same "falls back to the module" outcome as an anonymous
        // callback. `Some(owner)` either way (not left unset) so this
        // declarator's init can never inherit a stale OUTER hint.
        if let Some(init) = &declarator.init
            && matches!(
                init,
                Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_)
            )
        {
            let owner = if self.declarator_owns_entity {
                match &declarator.id {
                    BindingPattern::BindingIdentifier(ident) => Some(ParamOwner {
                        entity_id: declaration_id(
                            DeclKind::Variable,
                            &self.path,
                            ident.span.start,
                            ident.name.as_str(),
                        ),
                        qualified_name: format!("{}.{}", self.path, ident.name.as_str()),
                    }),
                    // Non-identifier binding (`const [f] = [...]`, `const {f}
                    // = {...}`): `lib.rs`'s own `push_entity` only ever fires
                    // for `BindingPattern::BindingIdentifier`, so there is no
                    // entity to point at either way.
                    _ => None,
                }
            } else {
                None
            };
            self.pending_function_owner = Some(owner);
        }
        walk_variable_declarator(self, declarator);
    }

    /// Found during E1c's cardinality reconciliation: a class field
    /// (`class C { x: number = 1; }`) is `core:value` (`DeclKind::Property`
    /// on the checker side, per `rustSemanticDeclarationShape`'s
    /// `isPropertyDeclaration` arm), never `core:callable` -- it is never
    /// pushed onto `callable_stack`, same as a top-level variable
    /// declarator above. Without this site, the checker's site-driven
    /// descent had no way to reach a class field at all once it stopped
    /// doing its own full walk, so exported field types silently stopped
    /// being computed and (if the field were ever a resolved reference's
    /// *target* through some other path) its entity risked never being
    /// published in the first place.
    fn visit_property_definition(&mut self, property: &PropertyDefinition<'a>) {
        // Found via the typed_decl cardinality reconciliation gate, in two
        // steps: `#parentRunIndex`-style private fields are `PropertyKey::
        // PrivateIdentifier`, not `StaticIdentifier`; and a STRING/NUMERIC-
        // literal key (`'password-reset-requested': string`) is neither --
        // rather than enumerate every non-computed `PropertyKey` shape the
        // checker's own `nameOf` happens to support (`.text`/`.escapedText`
        // on an Identifier, PrivateIdentifier, or any literal), gate on
        // `!computed` directly: it is the exact same condition the checker
        // itself is bound by (a COMPUTED key -- `["a"]: 1` -- is wrapped as
        // a `ComputedPropertyName` on the checker side even when the inner
        // expression is a static-looking literal, and `nameOf` cannot name
        // that node either, so excluding it here loses nothing baseline
        // ever had). No identity string is computed here (unlike
        // `visit_method_definition`, this site is a pure span marker, the
        // checker owns naming), so there is no "#"-prefix pitfall to get
        // wrong by widening this way.
        if !property.computed {
            self.push_site(
                SiteKind::TypedDecl,
                property.span.start,
                property.span.end,
                SiteDisposition::CheckerPending,
                Some(REASON_TYPE_INFERENCE_REQUIRED),
            );
        }
        // P0-S2 typeflow: a field initializer's own `this`/`super` (e.g.
        // `x = this.makeDefault()`) resolves against this field's own
        // static/instance side.
        self.static_context.push(property.r#static);
        walk_property_definition(self, property);
        self.static_context.pop();
    }

    /// E3, T2: an interface's own `extends` entries resolve the same way a
    /// class's heritage clauses do (see `visit_class`'s doc comment);
    /// interfaces are always named (`TSInterfaceDeclaration::id` is not
    /// `Option`), so there is no anonymous-declaration corner case here.
    fn visit_ts_interface_declaration(&mut self, declaration: &TSInterfaceDeclaration<'a>) {
        let self_id = declaration_id(
            DeclKind::Interface,
            &self.path,
            declaration.id.span.start,
            declaration.id.name.as_str(),
        );
        // Atomic per clause, same reasoning as `class.implements` above: an
        // interface's own `extends` can equally list several types under
        // one syntactic `ts.HeritageClause`.
        let extends_entries = declaration
            .extends
            .iter()
            .map(|heritage| {
                let ident = if heritage.type_arguments.is_some() {
                    None
                } else {
                    match &heritage.expression {
                        Expression::Identifier(ident) => Some(ident.as_ref()),
                        _ => None,
                    }
                };
                (
                    heritage.span.start,
                    heritage.span.end,
                    self.resolve_heritage_clause(Some(&self_id), ident),
                )
            })
            .collect();
        self.finish_heritage_clause_group("inherits", extends_entries, Some(&self_id));
        self.push_site(
            SiteKind::TypedDecl,
            declaration.span.start,
            declaration.span.end,
            SiteDisposition::CheckerPending,
            Some(REASON_TYPE_INFERENCE_REQUIRED),
        );
        walk_ts_interface_declaration(self, declaration);
    }

    fn visit_ts_type_alias_declaration(&mut self, declaration: &TSTypeAliasDeclaration<'a>) {
        self.push_site(
            SiteKind::TypedDecl,
            declaration.span.start,
            declaration.span.end,
            SiteDisposition::CheckerPending,
            Some(REASON_TYPE_INFERENCE_REQUIRED),
        );
        walk_ts_type_alias_declaration(self, declaration);
    }

    fn visit_ts_enum_declaration(&mut self, declaration: &TSEnumDeclaration<'a>) {
        self.push_site(
            SiteKind::TypedDecl,
            declaration.span.start,
            declaration.span.end,
            SiteDisposition::CheckerPending,
            Some(REASON_TYPE_INFERENCE_REQUIRED),
        );
        walk_ts_enum_declaration(self, declaration);
    }

    /// Found while implementing E1c's cutover (design doc E1, step 3 of the
    /// handoff): without this override, `namespace X {}`/`declare module "x"
    /// {}` declarations had NO pending site at all, so the localized,
    /// site-driven descent used once the checker stops doing its own
    /// `collectAll` (analyzer.ts's `walkRustSemanticOwner`) would never
    /// reach them and their `core:type` entity would silently vanish from
    /// the corpus -- `classify_symbol_declaration` already resolves
    /// `DeclKind::Namespace` reference *targets*, so leaving the
    /// declaration itself unreachable would make those references dangle.
    fn visit_ts_module_declaration(&mut self, declaration: &TSModuleDeclaration<'a>) {
        self.push_site(
            SiteKind::TypedDecl,
            declaration.span.start,
            declaration.span.end,
            SiteDisposition::CheckerPending,
            Some(REASON_TYPE_INFERENCE_REQUIRED),
        );
        walk_ts_module_declaration(self, declaration);
    }

    /// Same rationale as `visit_ts_module_declaration` above, for
    /// `core:parameter` entities: `classify_symbol_declaration` already
    /// resolves `DeclKind::Parameter` reference *targets* (a parameter
    /// referenced from its own function/method/constructor/getter/setter/
    /// arrow body), but nothing pushed a site for the parameter
    /// *declaration* node itself. Under full `collectAll` this was masked
    /// (every node was visited regardless of `kindOf`); under the cutover's
    /// site-driven descent, an unreached parameter entity would leave those
    /// resolved reference rows pointing at a target that was never
    /// published. Only identifier-pattern parameters have an
    /// `isParameterDeclaration` counterpart on the checker side (see
    /// `classify_symbol_declaration`'s identical `BindingPattern::
    /// BindingIdentifier` guard) -- destructured/rest parameters are
    /// deliberately left unsited, same as everywhere else in this file.
    fn visit_formal_parameter(&mut self, parameter: &FormalParameter<'a>) {
        if let BindingPattern::BindingIdentifier(ident) = &parameter.pattern {
            self.push_site(
                SiteKind::TypedDecl,
                parameter.span.start,
                parameter.span.end,
                SiteDisposition::CheckerPending,
                Some(REASON_TYPE_INFERENCE_REQUIRED),
            );
            // Parameter entities, "referenced-only" variant: record this
            // declaration's facts UNCONDITIONALLY (before it is known
            // whether any reference ever targets it -- `finish` filters this
            // map down to `referenced_parameter_targets` at the end). A
            // parameter PROPERTY (`constructor(private x: T) {}`,
            // `parameter.has_modifier()`) is EXCLUDED from this map --
            // 2026-09-04 references-parity task, member-entities-in-cold
            // follow-up: `urdira_jsts_typeflow::member_declarations` (via
            // `push_member_entities` in `lib.rs`) now owns EVERY parameter
            // property UNCONDITIONALLY, the same way it already owns every
            // other class member, byte-identical entity id
            // (`declaration_id(DeclKind::Parameter, ...)` here ==
            // `declaration_id("parameter", ...)` there, both keyed by the
            // BINDING IDENTIFIER's own span). Recording it here TOO would
            // materialize the exact same declaration twice, once from each
            // producer. `classify_symbol_declaration`'s own `FormalParameter`
            // arm still never inspects `accessibility`/`readonly`, so a bare
            // reference to `x` elsewhere in the constructor body, and a
            // `this.x` member read (`resolve_static_member_reference`),
            // still both resolve to this SAME entity id -- `finish`'s
            // `referenced_parameter_targets` bucket simply finds no fact for
            // it here (by construction, never inserted) and skips
            // materializing it a second time, since `push_member_entities`
            // already will.
            if !parameter.has_modifier() {
                let entity_id = declaration_id(
                    DeclKind::Parameter,
                    &self.path,
                    ident.span.start,
                    ident.name.as_str(),
                );
                let (parent_id, parent_qualified_name) =
                    match self.param_owner_stack.last().cloned().flatten() {
                        Some(owner) => (owner.entity_id, owner.qualified_name),
                        // No owner frame at all (an impossible-to-reference TS
                        // type-level function signature's own param, e.g. `type F
                        // = (x: number) => void` -- see `param_owner_stack`'s own
                        // doc comment) or an owner frame explicitly `None` (falls
                        // back to the module, `parameter_entity_record`'s rule):
                        // both degrade the same way `push_entity` treats every
                        // module-level entity -- `self.path` doubles as the
                        // module's own "qualified name" for concatenation
                        // purposes even though the module entity's own `qualified
                        // _name` field is `None`.
                        None => (self.module_id.clone(), self.path.clone()),
                    };
                self.parameter_declarations.insert(
                    entity_id.clone(),
                    ParameterDeclarationFact {
                        entity_id,
                        name: ident.name.as_str().to_owned(),
                        start: ident.span.start,
                        end: ident.span.end,
                        parent_id,
                        qualified_name: format!("{parent_qualified_name}.{}", ident.name.as_str()),
                    },
                );
            }
        }
        self.record_local_type(
            &parameter.pattern,
            parameter.type_annotation.as_deref(),
            None,
        );
        walk_formal_parameter(self, parameter);
    }

    /// 2026-09-04 references-parity task, bucket 1: the catch-clause
    /// counterpart of `visit_formal_parameter`'s declaration-fact recording
    /// -- see `classify_symbol_declaration`'s `AstKind::CatchParameter` arm
    /// for why this needs a fact at all (an `isVariableDeclaration`
    /// reference target the checker resolves, that nothing previously
    /// published an entity for). A destructured catch binding (`catch ({
    /// message }) {}`) records nothing, matching `classify_symbol_
    /// declaration`'s own conservative `None` for that shape. Owner
    /// attribution reuses `param_owner_stack.last()` exactly like an
    /// ordinary parameter -- a catch clause is always directly inside SOME
    /// callable's body (or, `None`/empty stack, module-level top-level
    /// code), never its own separate "owner".
    fn visit_catch_parameter(&mut self, param: &CatchParameter<'a>) {
        if let BindingPattern::BindingIdentifier(ident) = &param.pattern {
            let entity_id = declaration_id(
                DeclKind::Variable,
                &self.path,
                ident.span.start,
                ident.name.as_str(),
            );
            let (parent_id, parent_qualified_name) =
                match self.param_owner_stack.last().cloned().flatten() {
                    Some(owner) => (owner.entity_id, owner.qualified_name),
                    None => (self.module_id.clone(), self.path.clone()),
                };
            self.catch_declarations.insert(
                entity_id.clone(),
                ParameterDeclarationFact {
                    entity_id,
                    name: ident.name.as_str().to_owned(),
                    start: ident.span.start,
                    end: ident.span.end,
                    parent_id,
                    qualified_name: format!("{parent_qualified_name}.{}", ident.name.as_str()),
                },
            );
        }
        walk_catch_parameter(self, param);
    }

    /// 2026-09-04 references-parity task, bucket 1: the rest-parameter
    /// counterpart of `visit_formal_parameter`'s declaration-fact recording
    /// -- reuses the SAME `parameter_declarations`/`referenced_parameter_
    /// targets` bucket (a rest parameter's `target_id` already carries the
    /// `"jsts:parameter:"` prefix `visit_identifier_reference`'s `Resolved`
    /// arm already checks, see `classify_symbol_declaration`'s `AstKind::
    /// FormalParameterRest` arm). `oxc` never routes a rest parameter
    /// through `visit_formal_parameter` at all -- `FormalParameters::rest`
    /// is a SIBLING field to `items`, walked through this SEPARATE visitor
    /// method (`walk_formal_parameters`'s own body) -- so this needs its own
    /// override rather than "extending" the existing one. No parameter-
    /// property carve-out is needed here (TypeScript does not allow an
    /// accessibility modifier on a rest parameter at all, so `FormalParameterRest`
    /// has no `has_modifier`-equivalent to check).
    fn visit_formal_parameter_rest(&mut self, parameter: &FormalParameterRest<'a>) {
        if let BindingPattern::BindingIdentifier(ident) = &parameter.rest.argument {
            let entity_id = declaration_id(
                DeclKind::Parameter,
                &self.path,
                ident.span.start,
                ident.name.as_str(),
            );
            let (parent_id, parent_qualified_name) =
                match self.param_owner_stack.last().cloned().flatten() {
                    Some(owner) => (owner.entity_id, owner.qualified_name),
                    None => (self.module_id.clone(), self.path.clone()),
                };
            self.parameter_declarations.insert(
                entity_id.clone(),
                ParameterDeclarationFact {
                    entity_id,
                    name: ident.name.as_str().to_owned(),
                    start: ident.span.start,
                    end: ident.span.end,
                    parent_id,
                    qualified_name: format!("{parent_qualified_name}.{}", ident.name.as_str()),
                },
            );
        }
        walk_formal_parameter_rest(self, parameter);
    }
}

/// Parse `source_text` (owner path `path`, used only for source-type
/// sniffing and identity strings) and run the intra-file semantic reference
/// walk over it. Always does its own fresh parse + `SemanticBuilder` pass:
/// the ordinary syntax lane (`parse_source`) never pays this cost, only
/// callers that explicitly want semantics do.
///
/// This is deliberately source-text-in rather than project-state-in: the
/// worker's `ProjectState` only retains `SyntaxFileResult`s (no raw source)
/// once a file has been analyzed once, so a later orchestration stage
/// (E1b, in `urdira-indexing-worker`) is expected to supply the text it
/// already has on hand (from its own decode step) rather than have this
/// crate re-read blobs itself.
pub fn analyze_owner_semantics(
    path: &str,
    source_text: &str,
) -> Result<OwnerSemantics, AnalysisError> {
    let resolver = WorkspaceResolver::default();
    let available = BTreeSet::new();
    let files = BTreeMap::new();
    let ambient_index = resolver::AmbientModuleIndex::default();
    let ctx = HybridResolutionContext {
        resolver: &resolver,
        available: &available,
        files: &files,
        typeflow_index: None,
        typeflow_oracle: false,
        ambient_index: &ambient_index,
    };
    analyze_owner_semantics_with_context(path, source_text, &ctx)
}

/// E2 (F5 hybrid design): same as `analyze_owner_semantics`, but with a
/// `HybridResolutionContext` that lets import-bound identifier sites close
/// their import -> export -> declaration chain and become `rust_resolved`
/// instead of always `checker_pending`. See `HybridResolutionContext`'s doc
/// comment for what an empty context (`analyze_owner_semantics`'s own
/// default) degrades to.
pub fn analyze_owner_semantics_with_context(
    path: &str,
    source_text: &str,
    ctx: &HybridResolutionContext<'_>,
) -> Result<OwnerSemantics, AnalysisError> {
    let source_type =
        SourceType::from_path(std::path::Path::new(path)).map_err(|_| AnalysisError {
            code: ErrorCode::UnsupportedSource,
            message: format!("unsupported source type for {path}"),
        })?;
    let allocator = Allocator::default();
    let mut parsed = Parser::new(&allocator, source_text, source_type).parse();
    // Must run before `Utf8ToUtf16` touches anything: `comments` carry spans
    // into the ORIGINAL `source_text` (UTF-8 byte offsets), which is exactly
    // what `is_jsdoc_typed_file` slices.
    let jsdoc_typed_file = is_jsdoc_typed_file(source_type, &parsed.program.comments, source_text);
    Utf8ToUtf16::new(source_text).convert_program(&mut parsed.program);
    let semantic_return = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&parsed.program);
    let semantic = semantic_return.semantic;
    // Parameter entities, "referenced-only" variant: the SAME enumeration
    // `push_member_entities` (lib.rs, lane 1) uses to materialize a
    // class/interface member's own entity -- reusing it here (rather than
    // re-deriving "does this class/interface get a member entity" from
    // scratch) means a method/constructor/getter/setter's `entity_id` is
    // ALWAYS looked up against the exact set lib.rs actually emits: a
    // NESTED class (not module-top-level) or an ANONYMOUS class is
    // correctly absent (`member_declarations`'s own doc comment), so a
    // parameter inside one of ITS methods falls back to the module entity
    // instead of naming a `parent_id` that was never published. Keyed by
    // `entity_id` (byte-identical to what `visit_method_definition`/`visit_
    // object_property`/`visit_ts_method_signature` compute locally), valued
    // by the qualified name lib.rs assigns that same entity
    // (`push_member_entities`'s own `"{path}.{container}.{name}"` recipe) so
    // a referenced parameter's own `qualified_name` can extend it without a
    // second lookup. Must run AFTER `Utf8ToUtf16::convert_program` above,
    // same as lib.rs's own call, so every span agrees on units (UTF-16).
    let member_qualified_names: BTreeMap<String, String> =
        urdira_jsts_typeflow::member_declarations(&parsed.program, path)
            .into_iter()
            .map(|declaration| {
                let qualified_name =
                    format!("{path}.{}.{}", declaration.container_name, declaration.name);
                (declaration.entity_id, qualified_name)
            })
            .collect();
    let mut walker = SemanticWalker::new(
        path,
        semantic.scoping(),
        semantic.nodes(),
        jsdoc_typed_file,
        ctx,
        member_qualified_names,
    );
    walker.visit_program(&parsed.program);
    Ok(walker.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parameter entities, "referenced-only" variant: find the
    /// `parameter_entity_rows` entry with this exact `id`, if one exists.
    fn parameter_entity<'s>(semantics: &'s OwnerSemantics, id: &str) -> Option<&'s ProposedRecord> {
        semantics
            .parameter_entity_rows
            .iter()
            .find(|record| record.identity_key == id)
    }

    /// Parameter entities, "referenced-only" variant: find the
    /// `parameter_contains_rows` entry whose `target_id` is this parameter
    /// `id`, if one exists.
    fn parameter_contains<'s>(
        semantics: &'s OwnerSemantics,
        parameter_id: &str,
    ) -> Option<&'s ProposedRecord> {
        semantics
            .parameter_contains_rows
            .iter()
            .find(|record| record.body["target_id"].as_str() == Some(parameter_id))
    }

    fn resolved(semantics: &OwnerSemantics) -> Vec<(u32, u32, &str, &str)> {
        semantics
            .reference_rows
            .iter()
            .map(|record| {
                let body = record
                    .body
                    .as_object()
                    .expect("reference body is an object");
                (
                    body["start"].as_u64().unwrap() as u32,
                    body["end"].as_u64().unwrap() as u32,
                    body["source_id"].as_str().unwrap(),
                    body["target_id"].as_str().unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn resolves_local_variable_and_parameter_references() {
        let source =
            "function outer(value) {\n  const doubled = value + value;\n  return doubled;\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let function_id = "jsts:function:a.ts:9:outer";
        let param_id = "jsts:parameter:a.ts:15:value";
        let doubled_id = "jsts:variable:a.ts:32:doubled";
        let rows = resolved(&semantics);
        // Two references to `value` inside the addition, both owned by
        // `outer`, both resolved to the parameter.
        assert!(
            rows.iter()
                .any(|row| row.2 == function_id && row.3 == param_id)
        );
        assert_eq!(
            rows.iter()
                .filter(|row| row.2 == function_id && row.3 == param_id)
                .count(),
            2
        );
        // The `return doubled;` reference resolves to the local variable.
        assert!(
            rows.iter()
                .any(|row| row.2 == function_id && row.3 == doubled_id)
        );
    }

    #[test]
    fn skips_self_reference_row_but_still_resolves_it() {
        let source = "function factorial(n) {\n  return n <= 1 ? 1 : n * factorial(n - 1);\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let function_id = "jsts:function:a.ts:9:factorial";
        // The recursive call's callee identifier resolves to `factorial`
        // itself; since source == target, no row is published (matches
        // `relate`'s `relationSource.id !== target.id` guard) but the site
        // itself is still `rust_resolved` (checked separately below).
        assert!(!resolved(&semantics).iter().any(|row| row.3 == function_id));
        let site = semantics.pending_sites.iter().find(|site| {
            site.site_kind == SiteKind::IdentifierRef
                && site.start_utf16 == source.find("factorial(n - 1)").unwrap() as u32
        });
        assert!(
            site.is_none(),
            "the recursive-call identifier must not be pending"
        );
    }

    #[test]
    fn marks_import_bound_reference_pending() {
        let source =
            "import { helper } from \"./helper.js\";\nfunction use() {\n  return helper();\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert!(resolved(&semantics).is_empty());
        let reasons: Vec<&str> = semantics
            .pending_sites
            .iter()
            .filter_map(|site| site.reason.as_deref())
            .collect();
        assert!(
            reasons
                .iter()
                .any(|reason| reason.starts_with(REASON_IMPORT_BINDING)),
            "reasons: {reasons:?}"
        );
    }

    #[test]
    fn marks_every_import_specifier_shape_pending_at_its_local_binding() {
        let source = "import def, { named, aliased as renamed } from \"./a.js\";\nimport * as ns from \"./b.js\";\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let has_pending = |start: u32, end: u32| {
            semantics.pending_sites.iter().any(|site| {
                site.site_kind == SiteKind::IdentifierRef
                    && site.start_utf16 == start
                    && site.end_utf16 == end
                    && site
                        .reason
                        .as_deref()
                        .is_some_and(|reason| reason.starts_with(REASON_IMPORT_BINDING))
            })
        };
        let span_of = |needle: &str| {
            let start = source.find(needle).unwrap() as u32;
            (start, start + needle.len() as u32)
        };
        let (default_start, default_end) = span_of("def");
        assert!(
            has_pending(default_start, default_end),
            "default import local binding must be pending"
        );
        let (named_start, named_end) = span_of("named");
        assert!(
            has_pending(named_start, named_end),
            "non-aliased named import local binding must be pending"
        );
        let (renamed_start, renamed_end) = span_of("renamed");
        assert!(
            has_pending(renamed_start, renamed_end),
            "aliased named import's LOCAL binding must be pending"
        );
        let (ns_start, ns_end) = span_of("ns");
        assert!(
            has_pending(ns_start, ns_end),
            "namespace import local binding must be pending"
        );
        // The IMPORTED (exported-from) half of an aliased specifier is a
        // separate, real position of its own too -- see `visit_import_
        // specifier`'s own doc comment for why the checker resolves it
        // exactly like `local` (found via the same reconciliation gate as
        // `marks_re_export_specifier_local_name_pending`, its mirror image
        // on the export side).
        let (aliased_start, aliased_end) = span_of("aliased");
        assert!(
            has_pending(aliased_start, aliased_end),
            "the imported (exported-from) half of an aliased specifier must also get its own site"
        );
    }

    #[test]
    fn duplicate_import_of_the_same_export_under_two_local_names_resolves_both() {
        // The exact real-world shape this reconciliation gate caught:
        // `import { Tool, Tool as ToolBuilder } from "m"` -- both `Tool`
        // occurrences (the unaliased specifier's shared local/imported
        // position, and the aliased specifier's separate `imported` half)
        // must each get their own site.
        let source = "import { Tool, Tool as ToolBuilder } from \"./tool.js\";\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let plain_start = source.find("Tool,").unwrap() as u32;
        let aliased_imported_start = source.find("Tool as").unwrap() as u32;
        let local_alias_start = source.find("ToolBuilder").unwrap() as u32;
        for start in [plain_start, aliased_imported_start, local_alias_start] {
            assert!(
                semantics.pending_sites.iter().any(|site| {
                    site.site_kind == SiteKind::IdentifierRef
                        && site.start_utf16 == start
                        && site
                            .reason
                            .as_deref()
                            .is_some_and(|reason| reason.starts_with(REASON_IMPORT_BINDING))
                }),
                "expected a pending site at {start}: {:?}",
                semantics.pending_sites
            );
        }
    }

    // --- Safe-partition rule: JSDoc-typed JS-family files (coordinator
    // directive, 2026-09-01) -----------------------------------------------

    #[test]
    fn jsdoc_typed_js_file_produces_zero_reference_rows_and_forces_every_identifier_pending() {
        let source = "/**\n * @param {Record<string, string>} opts\n * @returns {string}\n */\nfunction run(opts) {\n  const local = opts;\n  return local;\n}\n";
        let semantics = analyze_owner_semantics("a.js", source).expect("analysis succeeds");
        assert!(
            semantics.reference_rows.is_empty(),
            "a JSDoc-typed JS file must publish zero Rust-resolved reference rows: {:?}",
            semantics.reference_rows
        );
        // `opts` used inside the function body would normally resolve
        // (local, single-declaration parameter) -- it must be pending here.
        let opts_use_start = source.rfind("opts;").unwrap() as u32;
        let opts_use_site = semantics.pending_sites.iter().find(|site| {
            site.site_kind == SiteKind::IdentifierRef && site.start_utf16 == opts_use_start
        });
        assert_eq!(
            opts_use_site.and_then(|site| site.reason.as_deref()),
            Some(REASON_JSDOC_TYPED_FILE),
            "sites: {:?}",
            semantics.pending_sites
        );
        // `local` similarly.
        let local_use_start = source.rfind("return local").unwrap() as u32 + "return ".len() as u32;
        let local_use_site = semantics.pending_sites.iter().find(|site| {
            site.site_kind == SiteKind::IdentifierRef && site.start_utf16 == local_use_start
        });
        assert_eq!(
            local_use_site.and_then(|site| site.reason.as_deref()),
            Some(REASON_JSDOC_TYPED_FILE)
        );
    }

    #[test]
    fn jsdoc_typed_rule_covers_the_whole_js_family_but_never_ts() {
        let source = "/**\n * @param {Record<string, string>} opts\n */\nfunction run(opts) {\n  return opts;\n}\n";
        for path in ["a.js", "a.mjs", "a.cjs", "a.jsx"] {
            let semantics = analyze_owner_semantics(path, source).expect("analysis succeeds");
            assert!(
                semantics.reference_rows.is_empty(),
                "{path}: JSDoc-typed rule must apply to every JS-family extension"
            );
        }
        // Verified empirically against the real checker (see the E1c
        // reconciliation harness): TypeScript never resolves symbols out of
        // JSDoc type tags in a `.ts` file -- real syntax is authoritative
        // there, so the rule must NOT apply and normal resolution proceeds.
        for path in ["a.ts", "a.tsx"] {
            let semantics = analyze_owner_semantics(path, source).expect("analysis succeeds");
            assert!(
                !semantics.reference_rows.is_empty(),
                "{path}: the JSDoc-typed rule must not apply to TypeScript files"
            );
        }
    }

    #[test]
    fn jsdoc_typed_rule_requires_a_type_tag_not_just_any_doc_comment() {
        let source = "/**\n * Just prose, no @param or @returns type tag here.\n */\nfunction run(opts) {\n  return opts;\n}\n";
        let semantics = analyze_owner_semantics("a.js", source).expect("analysis succeeds");
        assert!(
            !semantics.reference_rows.is_empty(),
            "an untyped doc comment must not trip the rule"
        );
    }

    #[test]
    fn jsdoc_typed_rule_requires_the_double_star_jsdoc_opener() {
        // A single-star block comment is never JSDoc to the checker either,
        // even if it happens to contain the same text.
        let source =
            "/* @param {Record<string, string>} opts */\nfunction run(opts) {\n  return opts;\n}\n";
        let semantics = analyze_owner_semantics("a.js", source).expect("analysis succeeds");
        assert!(
            !semantics.reference_rows.is_empty(),
            "a plain (non-JSDoc) block comment must not trip the rule"
        );
    }

    #[test]
    fn resolves_type_predicate_parameter_name_to_the_real_parameter() {
        // 2026-09-04 references-parity task, bucket 3: `visit_ts_type_
        // predicate` now manually binds the predicate's own repeated
        // parameter name against `predicate_param_stack` instead of always
        // staying pending.
        let source = "function isFoo(value: unknown): value is { kind: \"foo\" } {\n  return typeof value === \"object\";\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let predicate_name_start = source.find("value is").unwrap() as u32;
        let predicate_name_end = predicate_name_start + "value".len() as u32;
        let param_start = source.find("value:").unwrap() as u32;
        let param_id = declaration_id(DeclKind::Parameter, "a.ts", param_start, "value");
        let function_id = declaration_id(
            DeclKind::Function,
            "a.ts",
            source.find("isFoo").unwrap() as u32,
            "isFoo",
        );
        // No pending site at the predicate name's own span any more.
        assert!(
            !semantics
                .pending_sites
                .iter()
                .any(|site| site.site_kind == SiteKind::IdentifierRef
                    && site.start_utf16 == predicate_name_start),
            "sites: {:?}",
            semantics.pending_sites
        );
        let rows = resolved(&semantics);
        assert!(
            rows.contains(&(
                predicate_name_start,
                predicate_name_end,
                function_id.as_str(),
                param_id.as_str()
            )),
            "rows: {:?}",
            rows
        );
        // The parameter entity itself materializes even though its ONLY
        // other appearance is the declaration site (the predicate reference
        // is what makes it "referenced").
        assert!(parameter_entity(&semantics, &param_id).is_some());
    }

    #[test]
    fn resolves_asserts_predicate_parameter_name_to_the_real_parameter() {
        let source = "function assertFoo(value: unknown): asserts value is string {\n  if (typeof value !== \"string\") throw new Error();\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let predicate_name_start = source.find("value is string").unwrap() as u32;
        let predicate_name_end = predicate_name_start + "value".len() as u32;
        let param_start = source.find("value:").unwrap() as u32;
        let param_id = declaration_id(DeclKind::Parameter, "a.ts", param_start, "value");
        let function_id = declaration_id(
            DeclKind::Function,
            "a.ts",
            source.find("assertFoo").unwrap() as u32,
            "assertFoo",
        );
        let rows = resolved(&semantics);
        assert!(
            rows.contains(&(
                predicate_name_start,
                predicate_name_end,
                function_id.as_str(),
                param_id.as_str()
            )),
            "rows: {:?}",
            rows
        );
    }

    #[test]
    fn type_predicate_parameter_name_not_among_this_signatures_own_parameters_stays_pending() {
        // Defensive/negative case (should not occur for valid TypeScript,
        // but never assumed): the predicate repeats a name that is not one
        // of THIS signature's own simple parameters -- falls back to the
        // ordinary `checker_pending` disposition exactly like before this
        // fix, never a wrong guess.
        let source = "function isFoo(value: unknown): other is string {\n  return typeof value === \"string\";\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let predicate_name_start = source.find("other is").unwrap() as u32;
        let site = semantics.pending_sites.iter().find(|site| {
            site.site_kind == SiteKind::IdentifierRef && site.start_utf16 == predicate_name_start
        });
        assert_eq!(
            site.and_then(|site| site.reason.as_deref()),
            Some(REASON_TYPE_PREDICATE_PARAMETER),
            "sites: {:?}",
            semantics.pending_sites
        );
    }

    #[test]
    fn type_predicate_parameter_name_from_an_outer_function_does_not_leak_in() {
        // Scope-aware: an INNER function's own predicate must resolve
        // against ITS OWN parameters, never an outer enclosing function's
        // same-shaped one -- `predicate_param_stack`'s own "always push a
        // frame, even empty" discipline is what makes this fail closed
        // (falls to `checker_pending`) rather than accidentally matching the
        // outer `value`.
        let source = "function outer(value: unknown) {\n  function inner(other: unknown): value is string {\n    return typeof other === \"string\";\n  }\n  return inner;\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let predicate_name_start = source.rfind("value is").unwrap() as u32;
        let site = semantics.pending_sites.iter().find(|site| {
            site.site_kind == SiteKind::IdentifierRef && site.start_utf16 == predicate_name_start
        });
        assert_eq!(
            site.and_then(|site| site.reason.as_deref()),
            Some(REASON_TYPE_PREDICATE_PARAMETER),
            "sites: {:?}",
            semantics.pending_sites
        );
    }

    #[test]
    fn marks_re_export_specifier_local_name_pending() {
        let source = "export { correctness } from \"./correctness\";\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let local_start = source.find("correctness }").unwrap() as u32;
        let site = semantics.pending_sites.iter().find(|site| {
            site.site_kind == SiteKind::IdentifierRef && site.start_utf16 == local_start
        });
        assert!(
            site.and_then(|site| site.reason.as_deref())
                .is_some_and(|reason| reason.starts_with(REASON_RE_EXPORT_BINDING)),
            "sites: {:?}",
            semantics.pending_sites
        );
    }

    #[test]
    fn marks_both_halves_of_an_aliased_re_export_specifier_pending() {
        // `export { correctness as scored } from "./correctness"`: verified
        // empirically against the real checker (see `visit_export_named_
        // declaration`'s doc comment) that BOTH `local` (the re-exported
        // module's own name) AND `exported` (the alias visible to importers
        // of THIS module) resolve straight through to the original
        // declaration -- unlike a sourceless aliased export, where neither
        // half does.
        let source = "export { correctness as scored } from \"./correctness\";\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let has_pending = |start: u32| {
            semantics.pending_sites.iter().any(|site| {
                site.site_kind == SiteKind::IdentifierRef
                    && site.start_utf16 == start
                    && site
                        .reason
                        .as_deref()
                        .is_some_and(|reason| reason.starts_with(REASON_RE_EXPORT_BINDING))
            })
        };
        let local_start = source.find("correctness as").unwrap() as u32;
        assert!(
            has_pending(local_start),
            "the local (re-exported-from) half must be pending"
        );
        let exported_start = source.find("scored }").unwrap() as u32;
        assert!(
            has_pending(exported_start),
            "the exported (alias) half must also be pending"
        );
    }

    #[test]
    fn sourceless_export_specifier_is_still_an_ordinary_local_reference() {
        // No `from` clause: `foo` genuinely references the local binding
        // and must resolve through the normal `IdentifierReference` path,
        // not the re-export one.
        let source = "const foo = 1;\nexport { foo };\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert!(
            !semantics.pending_sites.iter().any(|site| site
                .reason
                .as_deref()
                .is_some_and(|reason| reason.starts_with(REASON_RE_EXPORT_BINDING))),
            "sites: {:?}",
            semantics.pending_sites
        );
    }

    #[test]
    fn sourceless_aliased_export_of_a_variable_resolves_the_alias_half() {
        // The real-world shape this reconciliation gate caught: no `from`
        // clause, but the checker still resolves the alias (`bar`) straight
        // through to the original `const` declaration. 2026-09-04
        // references-parity task, Phase B bucket 1: `visit_export_
        // specifier` now resolves this too, through `local`'s own
        // (already-computed, by the default walk's `visit_identifier_
        // reference`) local-symbol resolution -- re-derived here via
        // `resolve_identifier_reference` for `exported`'s own, different
        // span. `local`'s own site (`foo`, the FIRST occurrence) already
        // resolved before this fix (an ordinary `IdentifierReference`); only
        // `exported`'s (`bar`) is new.
        let source = "const foo = 1;\nexport { foo as bar };\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let alias_start = source.rfind("bar").unwrap() as u32;
        let alias_end = alias_start + "bar".len() as u32;
        assert!(
            semantics
                .pending_sites
                .iter()
                .all(|site| site.start_utf16 != alias_start),
            "the alias half must no longer stay pending: sites: {:?}",
            semantics.pending_sites
        );
        let foo_start = source.find("foo").unwrap() as u32;
        let target_id = format!("jsts:variable:a.ts:{foo_start}:foo");
        let rows = resolved(&semantics);
        assert!(
            rows.iter()
                .any(|&(start, end, _source_id, row_target)| start == alias_start
                    && end == alias_end
                    && row_target == target_id),
            "rows: {:?}",
            rows
        );
    }

    #[test]
    fn marks_static_member_access_pending() {
        let source = "function use(target) {\n  return target.value;\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let member_sites: Vec<&SemanticSite> = semantics
            .pending_sites
            .iter()
            .filter(|site| {
                site.reason
                    .as_deref()
                    .is_some_and(|reason| reason.starts_with(REASON_MEMBER_ACCESS))
            })
            .collect();
        assert_eq!(
            member_sites.len(),
            1,
            "expected exactly one member-access pending site"
        );
        let property_start = source.find("value;").unwrap() as u32;
        assert_eq!(member_sites[0].start_utf16, property_start);
        // `target` itself is a plain local parameter reference and IS resolved.
        assert!(
            resolved(&semantics)
                .iter()
                .any(|row| row.3.starts_with("jsts:parameter:a.ts:"))
        );
    }

    #[test]
    fn marks_shadowed_reference_resolved_to_the_correct_binding() {
        let source = "function outer(x) {\n  function inner(x) {\n    return x + 1;\n  }\n  return inner(x) + x;\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let inner_id = "jsts:function:a.ts:31:inner";
        let outer_param_id = "jsts:parameter:a.ts:15:x";
        let inner_param_id = "jsts:parameter:a.ts:37:x";
        let rows = resolved(&semantics);
        // `return x + 1;` inside `inner` must resolve to inner's own `x`,
        // never to outer's shadowed `x`.
        assert!(
            rows.iter()
                .any(|row| row.2 == inner_id && row.3 == inner_param_id)
        );
        assert!(
            !rows
                .iter()
                .any(|row| row.2 == inner_id && row.3 == outer_param_id)
        );
        // `inner(x) + x` inside `outer` resolves both occurrences to outer's `x`.
        let function_id = "jsts:function:a.ts:9:outer";
        assert_eq!(
            rows.iter()
                .filter(|row| row.2 == function_id && row.3 == outer_param_id)
                .count(),
            2
        );
    }

    #[test]
    fn marks_this_expression_pending() {
        let source = "class Widget {\n  render() {\n    return this;\n  }\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert!(
            semantics
                .pending_sites
                .iter()
                .any(|site| site.reason.as_deref() == Some(REASON_THIS_EXPRESSION))
        );
    }

    #[test]
    fn marks_double_var_declaration_pending() {
        let source =
            "var counter = 1;\nvar counter = 2;\nfunction read() {\n  return counter;\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert!(resolved(&semantics).is_empty());
        let reasons: Vec<&str> = semantics
            .pending_sites
            .iter()
            .filter_map(|site| site.reason.as_deref())
            .collect();
        assert!(
            reasons.contains(&REASON_MULTIPLE_DECLARATIONS),
            "reasons: {reasons:?}"
        );
    }

    #[test]
    fn resolves_call_to_a_single_locally_declared_function() {
        // E3, T1: a plain-identifier call to a non-overloaded, locally
        // declared function is `rust_resolved` with its own `core:call` row.
        let source =
            "function helper() {\n  return 1;\n}\nfunction use() {\n  return helper();\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let call_start = source.find("helper();").unwrap() as u32;
        let call_end = call_start + "helper()".len() as u32;
        assert!(
            semantics
                .pending_sites
                .iter()
                .all(|site| !(site.site_kind == SiteKind::Call && site.start_utf16 == call_start)),
            "a resolved call must not stay pending: {:?}",
            semantics.pending_sites
        );
        assert_eq!(
            semantics.call_rows.len(),
            1,
            "rows: {:?}",
            semantics.call_rows
        );
        let record = &semantics.call_rows[0];
        let use_start = source.find("use()").unwrap() as u32;
        let helper_start =
            source.find("function helper").unwrap() as u32 + "function ".len() as u32;
        let use_id = format!("jsts:function:a.ts:{use_start}:use");
        let helper_id = format!("jsts:function:a.ts:{helper_start}:helper");
        assert_eq!(record.body["source_id"], use_id);
        assert_eq!(record.body["target_id"], helper_id);
        assert_eq!(record.body["classification"], "confirmed");
        assert_eq!(record.body["start"], call_start);
        assert_eq!(record.body["end"], call_end);
        assert_eq!(record.kind, "jsts:relation_call");
        assert_eq!(record.universal_kind, "core:call");
        assert_eq!(
            record.identity_key,
            format!("jsts:call:a.ts:{call_start}:{call_end}:{use_id}:{helper_id}")
        );
        // The callee identifier itself is still a normal, resolved reference.
        assert!(
            resolved(&semantics)
                .iter()
                .any(|row| row.3.starts_with("jsts:function:a.ts:"))
        );
    }

    #[test]
    fn resolves_recursive_call_without_dropping_the_self_referential_row() {
        // Unlike `core:references`, the checker's own `relate("call", ...)`
        // never excludes `source_id == target_id`; a rust-resolved recursive
        // call must not be silently dropped either.
        let source = "function factorial(n) {\n  return n <= 1 ? 1 : n * factorial(n - 1);\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let function_id = "jsts:function:a.ts:9:factorial";
        assert_eq!(
            semantics.call_rows.len(),
            1,
            "rows: {:?}",
            semantics.call_rows
        );
        let record = &semantics.call_rows[0];
        assert_eq!(record.body["source_id"], function_id);
        assert_eq!(record.body["target_id"], function_id);
    }

    #[test]
    fn local_overloaded_function_call_stays_pending() {
        let source = "function f(a: string): void;\nfunction f(a: number): void;\nfunction f(a: unknown): void {}\nfunction use() {\n  f(1);\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert!(
            semantics.call_rows.is_empty(),
            "an overloaded local function call must never be rust_resolved: {:?}",
            semantics.call_rows
        );
        let call_start = source.find("f(1)").unwrap() as u32;
        let site = semantics
            .pending_sites
            .iter()
            .find(|site| site.site_kind == SiteKind::Call && site.start_utf16 == call_start);
        assert_eq!(
            site.and_then(|site| site.reason.as_deref()),
            Some(REASON_CALL_TARGET_UNCERTAIN),
            "sites: {:?}",
            semantics.pending_sites
        );
    }

    #[test]
    fn member_this_and_super_calls_stay_pending() {
        let source = "class Base {\n  constructor() {}\n  greet() {}\n}\nclass Derived extends Base {\n  constructor() {\n    super();\n  }\n  run(obj: { greet(): void }) {\n    obj.greet();\n    this.greet();\n  }\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert!(
            semantics.call_rows.is_empty(),
            "member/this/super calls must never be rust_resolved: {:?}",
            semantics.call_rows
        );
        let call_sites: Vec<_> = semantics
            .pending_sites
            .iter()
            .filter(|site| site.site_kind == SiteKind::Call)
            .collect();
        // `super()`, `obj.greet()`, `this.greet()` -- three call sites, all
        // pending with the "never even attempted" reason (a non-identifier
        // callee).
        assert_eq!(call_sites.len(), 3, "sites: {call_sites:?}");
        assert!(
            call_sites
                .iter()
                .all(|site| site.reason.as_deref() == Some(REASON_CALL_DEFERRED))
        );
    }

    /// A2 (pending.sites migration): every pending `Call` site (member/
    /// `this`/`super` callee here) produces exactly one `PendingSiteProposal`
    /// (`site_kind: Call`) carrying the site's own `reason` and `source_id`
    /// -- no `ProposedRecord`/`target_id`/diagnostic (folded, see
    /// `OwnerSemantics::pending_site_rows`'s doc comment). Replaces the
    /// P2-2i `possible_call_rows`-based test of the same scenario.
    #[test]
    fn pending_call_sites_produce_pending_site_rows_with_reason() {
        let source = "function run() {\n  this.greet();\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert_eq!(
            semantics.pending_site_rows.len(),
            1,
            "exactly one pending site row, no paired diagnostic: {:?}",
            semantics.pending_site_rows
        );
        let row = &semantics.pending_site_rows[0];
        assert_eq!(row.site_kind, PendingSiteKind::Call);
        assert_eq!(row.reason, REASON_CALL_DEFERRED);
        assert!(!row.source_id.is_empty(), "row: {row:?}");
    }

    /// P2-2i: `import("./x")` is not a `CallExpression` (see
    /// `marks_dynamic_import_expression_pending_as_a_call_site` above) but
    /// still gets the same pending-site-row treatment as any other pending
    /// call site.
    #[test]
    fn dynamic_import_produces_a_pending_call_site_row() {
        let source = "async function load() {\n  return import(\"./x.js\");\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert_eq!(semantics.pending_site_rows.len(), 1);
        assert_eq!(
            semantics.pending_site_rows[0].site_kind,
            PendingSiteKind::Call
        );
        assert_eq!(semantics.pending_site_rows[0].reason, REASON_CALL_DEFERRED);
    }

    /// P2-2i: an overloaded (ambiguous) local function call is a plain
    /// identifier callee (`REASON_CALL_TARGET_UNCERTAIN`), still gets a
    /// pending site row exactly like a non-identifier callee does.
    #[test]
    fn overloaded_local_call_produces_a_pending_site_row_with_the_uncertain_reason() {
        let source = "function f(a: string): void;\nfunction f(a: number): void;\nfunction f(a: unknown): void {}\nfunction use() {\n  f(1);\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert_eq!(semantics.pending_site_rows.len(), 1);
        assert_eq!(
            semantics.pending_site_rows[0].reason,
            REASON_CALL_TARGET_UNCERTAIN
        );
    }

    #[test]
    fn new_expression_produces_no_call_site_at_all() {
        // `new Foo()` is never tracked by this pipeline at all (the checker's
        // own walk only matches `isCallExpression`, never `isNewExpression`)
        // -- confirm Rust does not invent a site the checker never had.
        let source = "class Foo {}\nfunction use() {\n  return new Foo();\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert!(semantics.call_rows.is_empty());
        assert!(
            semantics
                .pending_sites
                .iter()
                .all(|site| site.site_kind != SiteKind::Call),
            "sites: {:?}",
            semantics.pending_sites
        );
    }

    #[test]
    fn marks_dynamic_import_expression_pending_as_a_call_site() {
        // `import("./x")` is NOT a `CallExpression` to oxc (`import` is a
        // reserved word, never a valid callee `Expression`) -- it is its
        // own `ImportExpression` node -- but the checker's own TS AST still
        // classifies it as an ordinary call site.
        let source = "async function load() {\n  const mod = await import(\"./thing.js\");\n  return mod;\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let call_start = source.find("import(\"./thing.js\")").unwrap() as u32;
        let call_end = call_start + "import(\"./thing.js\")".len() as u32;
        let site = semantics.pending_sites.iter().find(|site| {
            site.site_kind == SiteKind::Call
                && site.start_utf16 == call_start
                && site.end_utf16 == call_end
        });
        assert_eq!(
            site.and_then(|site| site.reason.as_deref()),
            Some(REASON_CALL_DEFERRED),
            "sites: {:?}",
            semantics.pending_sites
        );
    }

    #[test]
    fn resolves_simple_class_extends_heritage() {
        // E3, T2: a non-generic, plain-identifier `extends` clause resolving
        // to a single class declaration is `rust_resolved` with a
        // `core:inherits` row.
        let source = "class Base {}\nclass Derived extends Base {}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert!(
            semantics
                .pending_sites
                .iter()
                .all(|site| site.site_kind != SiteKind::Heritage),
            "sites: {:?}",
            semantics.pending_sites
        );
        assert_eq!(
            semantics.heritage_rows.len(),
            1,
            "rows: {:?}",
            semantics.heritage_rows
        );
        let record = &semantics.heritage_rows[0];
        let base_start = source.find("Base {}").unwrap() as u32;
        let base_id = format!("jsts:class:a.ts:{base_start}:Base");
        let derived_start = source.find("Derived").unwrap() as u32;
        let derived_id = format!("jsts:class:a.ts:{derived_start}:Derived");
        let extends_start = source.rfind("Base").unwrap() as u32;
        let extends_end = extends_start + "Base".len() as u32;
        assert_eq!(record.body["source_id"], derived_id);
        assert_eq!(record.body["target_id"], base_id);
        assert_eq!(record.body["classification"], "confirmed");
        assert_eq!(record.kind, "jsts:relation_inherits");
        assert_eq!(record.universal_kind, "core:inherits");
        assert_eq!(
            record.identity_key,
            format!("jsts:inherits:a.ts:{extends_start}:{extends_end}:{derived_id}:{base_id}")
        );
    }

    #[test]
    fn resolves_simple_class_implements_heritage() {
        let source = "interface Greeter {\n  greet(): void;\n}\nclass Person implements Greeter {\n  greet() {}\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert_eq!(
            semantics.heritage_rows.len(),
            1,
            "rows: {:?}",
            semantics.heritage_rows
        );
        let record = &semantics.heritage_rows[0];
        assert_eq!(record.kind, "jsts:relation_implements");
        assert_eq!(record.universal_kind, "core:implements");
        let greeter_start = source.find("Greeter {").unwrap() as u32;
        let greeter_id = format!("jsts:interface:a.ts:{greeter_start}:Greeter");
        assert_eq!(record.body["target_id"], greeter_id);
    }

    #[test]
    fn resolves_simple_interface_extends_heritage() {
        let source = "interface Base {\n  id: string;\n}\ninterface Derived extends Base {\n  name: string;\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert_eq!(
            semantics.heritage_rows.len(),
            1,
            "rows: {:?}",
            semantics.heritage_rows
        );
        let record = &semantics.heritage_rows[0];
        assert_eq!(record.kind, "jsts:relation_inherits");
        let base_start = source.find("Base {").unwrap() as u32;
        let base_id = format!("jsts:interface:a.ts:{base_start}:Base");
        assert_eq!(record.body["target_id"], base_id);
    }

    #[test]
    fn qualified_heritage_expression_stays_pending() {
        // `extends ns.Base` -- a qualified name -- must never be attempted.
        let source =
            "namespace ns {\n  export class Base {}\n}\nclass Derived extends ns.Base {}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert!(
            semantics.heritage_rows.is_empty(),
            "qualified heritage must never be rust_resolved: {:?}",
            semantics.heritage_rows
        );
        assert!(
            semantics
                .pending_sites
                .iter()
                .any(|site| site.site_kind == SiteKind::Heritage
                    && site.reason.as_deref() == Some(REASON_HERITAGE_DEFERRED))
        );
    }

    #[test]
    fn generic_heritage_expression_stays_pending() {
        let source = "class Base<T> {}\nclass Derived extends Base<string> {}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert!(
            semantics.heritage_rows.is_empty(),
            "generic heritage must never be rust_resolved: {:?}",
            semantics.heritage_rows
        );
        assert!(
            semantics
                .pending_sites
                .iter()
                .any(|site| site.site_kind == SiteKind::Heritage
                    && site.reason.as_deref() == Some(REASON_HERITAGE_DEFERRED))
        );
    }

    /// A2 (pending.sites migration): a pending heritage clause on a NAMED
    /// declaration (a real `source_id` to attribute it to) produces exactly
    /// one `PendingSiteProposal` (`site_kind: Inherits`) -- no
    /// `ProposedRecord`, no diagnostic (v3 never diagnoses a heritage clause
    /// either). Replaces the P2-2i `possible_heritage_rows`-based test of
    /// the same scenario.
    #[test]
    fn pending_named_heritage_clause_produces_a_pending_site_row() {
        let source = "class Base<T> {}\nclass Derived extends Base<string> {}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert_eq!(
            semantics.pending_site_rows.len(),
            1,
            "rows: {:?}",
            semantics.pending_site_rows
        );
        let row = &semantics.pending_site_rows[0];
        assert_eq!(row.site_kind, PendingSiteKind::Inherits);
        // Generic heritage (`Base<string>`) is ruled out before Rust even
        // attempts a plain-identifier resolution -- same reason the
        // "generic heritage must never be rust_resolved" test above asserts
        // on `pending_sites` directly.
        assert_eq!(row.reason, REASON_HERITAGE_DEFERRED);
        let derived_start = source.find("Derived").unwrap() as u32;
        let derived_id = format!("jsts:class:a.ts:{derived_start}:Derived");
        assert_eq!(row.source_id, derived_id);
    }

    #[test]
    fn multi_type_implements_clause_is_resolved_atomically() {
        // Regression: found live against the n8n corpus (E3 gate 3) --
        // `implements A, B` is ONE syntactic clause on the checker side; if
        // `A` resolves via Rust while `B` (qualified, here) stays pending,
        // the checker's clause-level re-walk (triggered by `B`'s pending
        // site) would otherwise re-emit `A`'s row too, colliding with the
        // one Rust already published. Both entries must stay pending.
        let source = "namespace ns {\n  export interface B {}\n}\ninterface A {}\nclass C implements A, ns.B {}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert!(
            semantics.heritage_rows.is_empty(),
            "a partially-pending clause must publish NO rows at all: {:?}",
            semantics.heritage_rows
        );
        let heritage_sites: Vec<_> = semantics
            .pending_sites
            .iter()
            .filter(|site| site.site_kind == SiteKind::Heritage)
            .collect();
        assert_eq!(heritage_sites.len(), 2, "sites: {heritage_sites:?}");
        let a_start = source.find("A, ns.B").unwrap() as u32;
        let a_site = heritage_sites
            .iter()
            .find(|site| site.start_utf16 == a_start)
            .expect("A's own site must still exist, demoted to pending");
        assert_eq!(
            a_site.reason.as_deref(),
            Some(REASON_HERITAGE_CLAUSE_PARTIALLY_PENDING),
            "A individually resolves but must be demoted because its sibling B does not"
        );
        let b_start = source.rfind("ns.B").unwrap() as u32;
        let b_site = heritage_sites
            .iter()
            .find(|site| site.start_utf16 == b_start)
            .expect("B's own site must exist");
        assert_eq!(
            b_site.reason.as_deref(),
            Some(REASON_HERITAGE_DEFERRED),
            "B keeps its own reason (qualified name, never attempted), not the clause-partial one"
        );
    }

    #[test]
    fn multi_type_interface_extends_clause_is_resolved_atomically() {
        let source = "interface A {}\ninterface B {}\ninterface C extends A, B, Unknown {}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert!(
            semantics.heritage_rows.is_empty(),
            "rows: {:?}",
            semantics.heritage_rows
        );
        let heritage_sites: Vec<_> = semantics
            .pending_sites
            .iter()
            .filter(|site| site.site_kind == SiteKind::Heritage)
            .collect();
        assert_eq!(heritage_sites.len(), 3, "sites: {heritage_sites:?}");
        // A and B individually resolve (single local interface declaration
        // each) but must be demoted since `Unknown` (an unresolved global)
        // never resolves.
        let demoted = heritage_sites
            .iter()
            .filter(|site| site.reason.as_deref() == Some(REASON_HERITAGE_CLAUSE_PARTIALLY_PENDING))
            .count();
        assert_eq!(demoted, 2, "sites: {heritage_sites:?}");
    }

    #[test]
    fn multi_type_clause_where_every_entry_resolves_publishes_every_row() {
        let source = "interface A {}\ninterface B {}\nclass C implements A, B {}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert_eq!(
            semantics.heritage_rows.len(),
            2,
            "every entry resolves, so both must publish: {:?}",
            semantics.heritage_rows
        );
        assert!(
            semantics
                .pending_sites
                .iter()
                .all(|site| site.site_kind != SiteKind::Heritage),
            "sites: {:?}",
            semantics.pending_sites
        );
    }

    #[test]
    fn anonymous_default_export_class_heritage_stays_pending() {
        // An anonymous class has no declaration id of its own, so its
        // heritage clause has no valid `source_id` to build a row from.
        let source = "class Base {}\nexport default class extends Base {}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert!(
            semantics.heritage_rows.is_empty(),
            "rows: {:?}",
            semantics.heritage_rows
        );
        assert!(
            semantics
                .pending_sites
                .iter()
                .any(|site| site.site_kind == SiteKind::Heritage
                    && site.reason.as_deref() == Some(REASON_HERITAGE_DEFERRED))
        );
        // P2-2i/A2: no `source_id` to build a pending site row from --
        // matches v3's own `entityForDeclaration(node.parent)` gap exactly
        // (see `finish_heritage_clause`'s doc comment). This fixture has no
        // pending CALL site either, so `pending_site_rows` is empty outright.
        assert!(
            semantics.pending_site_rows.is_empty(),
            "rows: {:?}",
            semantics.pending_site_rows
        );
    }

    #[test]
    fn handles_non_ascii_utf16_offsets() {
        // "café" is 4 UTF-16 code units but 5 UTF-8 bytes ('é' is 2 bytes).
        // The parameter name starts right after it; a byte-offset bug would
        // shift `value`'s reported span by one unit.
        let source = "function café(value) {\n  return value;\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let param_name_utf8_byte = source.find("value)").unwrap();
        let param_name_utf16 = source[..param_name_utf8_byte].encode_utf16().count() as u32;
        let rows = resolved(&semantics);
        assert!(rows.iter().any(|row| {
            row.3
                .starts_with(&format!("jsts:parameter:a.ts:{param_name_utf16}:"))
        }));
    }

    #[test]
    fn sites_digest_is_deterministic_across_runs() {
        let source = "import { helper } from \"./helper.js\";\nclass Base {}\nclass Derived extends Base {\n  method(x) {\n    return this.value + helper() + x;\n  }\n}\n";
        let first = analyze_owner_semantics("a.ts", source).expect("first analysis");
        let second = analyze_owner_semantics("a.ts", source).expect("second analysis");
        assert_eq!(first.sites_digest, second.sites_digest);
        assert!(first.sites_digest.starts_with("jsts:sites:sha256:"));
    }

    #[test]
    fn object_literal_shorthand_method_owns_its_body_references() {
        let source = "function make(value) {\n  return {\n    read() {\n      return value;\n    },\n  };\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let method_start = source.find("read()").unwrap() as u32;
        let method_id = format!("jsts:method:a.ts:{method_start}:read");
        let rows = resolved(&semantics);
        // The reference to `value` inside the shorthand method body is owned
        // by the method itself, not by `make` (the enclosing function).
        assert!(
            rows.iter().any(|row| row.2 == method_id),
            "expected a row owned by the shorthand method, got: {rows:?}"
        );
    }

    #[test]
    fn string_literal_keyed_object_literal_method_owns_its_body_references() {
        // The real-world shape this reconciliation gate caught: a Lezer
        // grammar props object keying a shorthand method with a
        // space-containing string literal.
        let source = "function make(value) {\n  return {\n    'Open Tag'(context) {\n      return context.column(value);\n    },\n  };\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let method_start = source.find("'Open Tag'").unwrap() as u32;
        let method_id = format!("jsts:method:a.ts:{method_start}:Open Tag");
        let rows = resolved(&semantics);
        assert!(
            rows.iter().any(|row| row.2 == method_id),
            "expected a row owned by the string-literal-keyed method, got: {rows:?}"
        );
    }

    #[test]
    fn object_literal_get_and_set_accessors_own_their_body_references() {
        let source = "function make(value) {\n  return {\n    get prop() {\n      return value;\n    },\n    set prop(next) {\n      return value + next;\n    },\n  };\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let get_start = source.find("prop()").unwrap() as u32;
        let set_start = source.rfind("prop(next)").unwrap() as u32;
        let getter_id = format!("jsts:getter:a.ts:{get_start}:prop");
        let setter_id = format!("jsts:setter:a.ts:{set_start}:prop");
        let rows = resolved(&semantics);
        assert!(
            rows.iter().any(|row| row.2 == getter_id),
            "expected a row owned by the getter, got: {rows:?}"
        );
        assert!(
            rows.iter().any(|row| row.2 == setter_id),
            "expected a row owned by the setter, got: {rows:?}"
        );
    }

    #[test]
    fn object_literal_plain_property_is_never_a_callable_owner() {
        let source = "function make(value) {\n  return {\n    plain: value,\n  };\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let function_id = "jsts:function:a.ts:9:make";
        let rows = resolved(&semantics);
        // `plain: value` is an ordinary Init property (not a method), so its
        // value reference stays owned by the enclosing function.
        assert!(
            rows.iter()
                .any(|row| row.2 == function_id && row.3.starts_with("jsts:parameter:a.ts:"))
        );
    }

    #[test]
    fn ts_method_signature_is_marked_pending_for_type_inference() {
        let source = "interface Reader {\n  read(): string;\n}\ntype Writer = {\n  write(value: string): void;\n};\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let read_start = source.find("read(): string").unwrap() as u32;
        let write_start = source.find("write(value: string): void").unwrap() as u32;
        let has_pending = |start: u32| {
            semantics.pending_sites.iter().any(|site| {
                site.site_kind == SiteKind::TypedDecl
                    && site.start_utf16 == start
                    && site.reason.as_deref() == Some(REASON_TYPE_INFERENCE_REQUIRED)
            })
        };
        assert!(
            has_pending(read_start),
            "interface method signature must be pending"
        );
        assert!(
            has_pending(write_start),
            "type-literal method signature must be pending"
        );
    }

    #[test]
    fn string_literal_keyed_method_signature_is_marked_pending() {
        let source = "interface Reader {\n  'read value'(): string;\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let signature_start = source.find("'read value'()").unwrap() as u32;
        assert!(
            semantics.pending_sites.iter().any(|site| {
                site.site_kind == SiteKind::TypedDecl
                    && site.start_utf16 == signature_start
                    && site.reason.as_deref() == Some(REASON_TYPE_INFERENCE_REQUIRED)
            }),
            "string-literal-keyed method signature must be pending: {:?}",
            semantics.pending_sites
        );
    }

    #[test]
    fn class_property_declaration_is_marked_pending_for_type_inference() {
        let source = "class Widget {\n  count: number = 1;\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let property_start = source.find("count: number = 1;").unwrap() as u32;
        assert!(
            semantics.pending_sites.iter().any(|site| {
                site.site_kind == SiteKind::TypedDecl
                    && site.start_utf16 == property_start
                    && site.reason.as_deref() == Some(REASON_TYPE_INFERENCE_REQUIRED)
            }),
            "class property declaration must be pending"
        );
    }

    #[test]
    fn private_class_property_declaration_is_marked_pending_for_type_inference() {
        let source = "class Widget {\n  #count: number = 1;\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let property_start = source.find("#count: number = 1;").unwrap() as u32;
        assert!(
            semantics.pending_sites.iter().any(|site| {
                site.site_kind == SiteKind::TypedDecl
                    && site.start_utf16 == property_start
                    && site.reason.as_deref() == Some(REASON_TYPE_INFERENCE_REQUIRED)
            }),
            "private class property declaration must be pending: {:?}",
            semantics.pending_sites
        );
    }

    #[test]
    fn string_literal_keyed_class_property_is_marked_pending_for_type_inference() {
        let source = "class Widget {\n  'password-reset-requested': string = '';\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let property_start = source.find("'password-reset-requested'").unwrap() as u32;
        assert!(
            semantics.pending_sites.iter().any(|site| {
                site.site_kind == SiteKind::TypedDecl
                    && site.start_utf16 == property_start
                    && site.reason.as_deref() == Some(REASON_TYPE_INFERENCE_REQUIRED)
            }),
            "string-literal-keyed class property must be pending: {:?}",
            semantics.pending_sites
        );
    }

    #[test]
    fn computed_keyed_class_property_is_never_pending() {
        // Matches the checker's own limitation: a computed key is wrapped
        // as `ComputedPropertyName` even when the inner expression is a
        // static-looking literal, and `nameOf` cannot name that node
        // either -- excluding it costs nothing baseline ever had.
        let source = "const KEY = 'dynamic';\nclass Widget {\n  [KEY]: string = '';\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let property_start = source.find("[KEY]: string").unwrap() as u32;
        assert!(
            !semantics.pending_sites.iter().any(|site| {
                site.site_kind == SiteKind::TypedDecl && site.start_utf16 == property_start
            }),
            "computed-key property must not be pending: {:?}",
            semantics.pending_sites
        );
    }

    #[test]
    fn private_method_owns_its_body_references_with_the_hash_prefixed_identity() {
        // The checker's own `PrivateIdentifier` node reports `escapedText`
        // WITH the "#" (unlike oxc's ESTree-style bare `name`), so the
        // identity this pushes onto `callable_stack` must reinstate it --
        // otherwise a reference inside the private method's own body would
        // be attributed to the wrong (enclosing) owner once the checker
        // resolves it, an identity mismatch between the two producers.
        let source = "class Widget {\n  #run(value) {\n    return value;\n  }\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let method_start = source.find("#run(value)").unwrap() as u32;
        let method_id = format!("jsts:method:a.ts:{method_start}:#run");
        let rows = resolved(&semantics);
        assert!(
            rows.iter().any(|row| row.2 == method_id),
            "expected a row owned by the private method with a \"#\"-prefixed id, got: {rows:?}"
        );
    }

    #[test]
    fn string_literal_keyed_class_method_owns_its_body_references() {
        let source = "class Widget {\n  'run it'(value) {\n    return value;\n  }\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let method_start = source.find("'run it'(value)").unwrap() as u32;
        let method_id = format!("jsts:method:a.ts:{method_start}:run it");
        let rows = resolved(&semantics);
        assert!(
            rows.iter().any(|row| row.2 == method_id),
            "expected a row owned by the string-literal-keyed method, got: {rows:?}"
        );
    }

    #[test]
    fn namespace_declaration_is_marked_pending_for_type_inference() {
        let source = "namespace Utils {\n  export const value = 1;\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let namespace_start = source.find("namespace Utils").unwrap() as u32;
        assert!(
            semantics.pending_sites.iter().any(|site| {
                site.site_kind == SiteKind::TypedDecl
                    && site.start_utf16 == namespace_start
                    && site.reason.as_deref() == Some(REASON_TYPE_INFERENCE_REQUIRED)
            }),
            "namespace declaration must be pending so the checker-side descent can reach it"
        );
    }

    #[test]
    fn every_identifier_parameter_is_marked_pending_for_type_inference() {
        let source =
            "function outer(value) {\n  const arrow = (x) => x + value;\n  return arrow;\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let value_start = source.find("value)").unwrap() as u32;
        let x_start = source.find("(x)").unwrap() as u32 + 1;
        let has_pending = |start: u32| {
            semantics.pending_sites.iter().any(|site| {
                site.site_kind == SiteKind::TypedDecl
                    && site.start_utf16 == start
                    && site.reason.as_deref() == Some(REASON_TYPE_INFERENCE_REQUIRED)
            })
        };
        assert!(
            has_pending(value_start),
            "named function parameter must be pending"
        );
        assert!(
            has_pending(x_start),
            "arrow function parameter must be pending"
        );
    }

    #[test]
    fn reference_row_identity_matches_the_checker_format() {
        let source = "function outer(value) {\n  return value;\n}\n";
        let semantics = analyze_owner_semantics("pkg/a.ts", source).expect("analysis succeeds");
        assert_eq!(semantics.reference_rows.len(), 1);
        let record = &semantics.reference_rows[0];
        let start = source.find("return value").unwrap() as u32 + "return ".len() as u32;
        let end = start + "value".len() as u32;
        let source_id = "jsts:function:pkg/a.ts:9:outer";
        let target_id = "jsts:parameter:pkg/a.ts:15:value";
        let expected_identity_key =
            format!("jsts:references:pkg/a.ts:{start}:{end}:{source_id}:{target_id}");
        assert_eq!(record.identity_key, expected_identity_key);
        assert_eq!(record.kind, "jsts:relation_references");
        assert_eq!(record.universal_kind, "core:references");
        assert_eq!(record.category, "relation");
        assert_eq!(record.body["source_id"], source_id);
        assert_eq!(record.body["target_id"], target_id);
        assert_eq!(record.body["classification"], "confirmed");
    }

    // -- E2: import -> export -> declaration hybrid resolution --------

    fn export_binding(exported_name: &str, local_name: &str) -> crate::SyntaxExportBinding {
        crate::SyntaxExportBinding {
            exported_name: exported_name.to_owned(),
            local_name: local_name.to_owned(),
            source_specifier: None,
            source_target_path: None,
        }
    }

    fn reexport_binding(
        exported_name: &str,
        local_name: &str,
        specifier: &str,
        target_path: &str,
    ) -> crate::SyntaxExportBinding {
        crate::SyntaxExportBinding {
            exported_name: exported_name.to_owned(),
            local_name: local_name.to_owned(),
            source_specifier: Some(specifier.to_owned()),
            source_target_path: Some(target_path.to_owned()),
        }
    }

    fn target_entity(
        kind: crate::EntityKind,
        path: &str,
        start: u32,
        name: &str,
    ) -> crate::SyntaxEntity {
        crate::SyntaxEntity {
            id: format!(
                "jsts:{}:{path}:{start}:{name}",
                match kind {
                    crate::EntityKind::Function => "function",
                    crate::EntityKind::Class => "class",
                    crate::EntityKind::Variable => "variable",
                    other => panic!("unhandled entity kind in test helper: {other:?}"),
                }
            ),
            name: name.to_owned(),
            kind,
            universal_kind: crate::UniversalKind::Value,
            path: path.to_owned(),
            start,
            end: start + name.len() as u32,
            parent_id: None,
            qualified_name: None,
            is_test: None,
        }
    }

    fn target_file(
        path: &str,
        entities: Vec<crate::SyntaxEntity>,
        export_bindings: Vec<crate::SyntaxExportBinding>,
    ) -> crate::SyntaxFileResult {
        crate::SyntaxFileResult {
            path: path.to_owned(),
            content_digest: "sha256:0".to_owned(),
            language: crate::Language::Typescript,
            script_kind: crate::ScriptKind::Ts,
            byte_length: 0,
            parsed: true,
            direct_imports: Vec::new(),
            entities,
            relations: Vec::new(),
            diagnostics: Vec::new(),
            export_bindings,
            export_star_specifiers: Vec::new(),
            ambient_modules: Vec::new(),
        }
    }

    /// Ambient module resolution task (2026-09-04): same as `target_file`
    /// above, with an explicit `ambient_modules` list.
    fn target_file_with_ambient(
        path: &str,
        ambient_modules: Vec<crate::AmbientModuleDeclaration>,
    ) -> crate::SyntaxFileResult {
        let mut result = target_file(path, Vec::new(), Vec::new());
        result.ambient_modules = ambient_modules;
        result
    }

    /// Build a `HybridResolutionContext` over a single available path
    /// `./helper.ts` -> `helper.ts` (matching every test source's
    /// `"./helper.ts"`/`"./helper"` import specifier below) plus whatever
    /// `files` the caller supplies.
    fn helper_ctx(
        files: BTreeMap<String, crate::SyntaxFileResult>,
    ) -> HybridResolutionContext<'static> {
        let resolver = WorkspaceResolver::default();
        let available: BTreeSet<String> = files.keys().cloned().collect();
        let ambient_index = resolver::AmbientModuleIndex::rebuild(&files);
        HybridResolutionContext {
            resolver: Box::leak(Box::new(resolver)),
            available: Box::leak(Box::new(available)),
            files: Box::leak(Box::new(files)),
            typeflow_index: None,
            typeflow_oracle: false,
            ambient_index: Box::leak(Box::new(ambient_index)),
        }
    }

    #[test]
    fn resolves_named_import_across_files_to_rust_resolved_with_reference_row() {
        let mut files = BTreeMap::new();
        files.insert(
            "helper.ts".to_owned(),
            target_file(
                "helper.ts",
                vec![target_entity(
                    crate::EntityKind::Function,
                    "helper.ts",
                    16,
                    "helper",
                )],
                vec![export_binding("helper", "helper")],
            ),
        );
        let ctx = helper_ctx(files);
        let source =
            "import { helper } from \"./helper\";\nfunction use() {\n  return helper();\n}\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        let target_id = "jsts:function:helper.ts:16:helper";
        // The import specifier's own local-binding site resolves...
        let local_start = source.find("{ helper }").unwrap() as u32 + 2;
        assert!(
            semantics
                .pending_sites
                .iter()
                .all(|site| site.start_utf16 != local_start),
            "the import specifier's local binding must not stay pending once resolved"
        );
        let rows = resolved(&semantics);
        // Found live against the n8n corpus (ON determinism run): an
        // UNALIASED specifier's `local` and `imported` share one span (see
        // `visit_import_specifier`'s doc comment), so a naive
        // resolve-both-positions implementation pushes the identical
        // `core:references` row twice -- a `record_id` collision at
        // publish time, not just a redundant read. Exactly one row from
        // the module to the target is correct here.
        assert_eq!(
            rows.iter()
                .filter(|row| row.2 == "jsts:module:a.ts:0:a.ts" && row.3 == target_id)
                .count(),
            1,
            "expected exactly one import-site reference row to {target_id}, got {rows:?}"
        );
        // ...and so does the later `helper()` call's callee identifier.
        let function_id = format!("jsts:function:a.ts:{}:use", source.find("use").unwrap());
        assert!(
            rows.iter()
                .any(|row| row.2 == function_id && row.3 == target_id),
            "expected a usage-site reference row from {function_id} to {target_id}, got {rows:?}"
        );
    }

    // -- Ambient module resolution task (2026-09-04) ----------------------

    fn ambient_decl(
        specifier: &str,
        path: &str,
        identity_start: u32,
        bodyful: bool,
        members: Vec<crate::AmbientModuleMember>,
        default_member: Option<crate::AmbientModuleMember>,
    ) -> crate::AmbientModuleDeclaration {
        crate::AmbientModuleDeclaration {
            specifier: specifier.to_owned(),
            bodyful,
            // Script-level by default -- augmentation tests flip this on
            // the returned value (`is_augmentation = true`).
            is_augmentation: false,
            namespace_entity_id: format!("jsts:namespace:{path}:{identity_start}:{specifier}"),
            members,
            default_member,
        }
    }

    fn ambient_member(
        kind_word: &str,
        path: &str,
        start: u32,
        name: &str,
    ) -> crate::AmbientModuleMember {
        crate::AmbientModuleMember {
            name: name.to_owned(),
            entity_id: format!("jsts:{kind_word}:{path}:{start}:{name}"),
        }
    }

    /// Fix item 1-2: a bare, otherwise-unresolvable specifier that a
    /// workspace `.d.ts` file declares via `declare module "specifier" {
    /// export function configure(): void; }` -- `import { configure } from
    /// "eslint-plugin-lodash"` must resolve to THAT declaration, never to a
    /// synthetic `jsts:external_symbol:...` entity. Regression fixture for
    /// the 677 n8n `v4_different_target` rows this task closes.
    #[test]
    fn ambient_named_import_resolves_to_the_inner_declaration() {
        let mut files = BTreeMap::new();
        files.insert(
            "plugins.d.ts".to_owned(),
            target_file_with_ambient(
                "plugins.d.ts",
                vec![ambient_decl(
                    "eslint-plugin-lodash",
                    "plugins.d.ts",
                    10,
                    true,
                    vec![ambient_member("function", "plugins.d.ts", 40, "configure")],
                    None,
                )],
            ),
        );
        let ctx = helper_ctx(files);
        let source = "import { configure } from \"eslint-plugin-lodash\";\nconfigure();\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        let target_id = "jsts:function:plugins.d.ts:40:configure";
        let rows = resolved(&semantics);
        assert!(
            rows.iter().any(|row| row.3 == target_id),
            "expected a reference row targeting {target_id}, got {rows:?}"
        );
        assert!(
            semantics.external_entity_rows.is_empty(),
            "an ambiently-resolved specifier must never fabricate an external entity: {:?}",
            semantics.external_entity_rows
        );
    }

    #[test]
    fn ambient_default_import_resolves_to_the_inner_declaration() {
        let mut files = BTreeMap::new();
        files.insert(
            "plugins.d.ts".to_owned(),
            target_file_with_ambient(
                "plugins.d.ts",
                vec![ambient_decl(
                    "my-widget",
                    "plugins.d.ts",
                    10,
                    true,
                    vec![],
                    Some(ambient_member("class", "plugins.d.ts", 50, "Widget")),
                )],
            ),
        );
        let ctx = helper_ctx(files);
        let source = "import Widget from \"my-widget\";\nnew Widget();\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        let target_id = "jsts:class:plugins.d.ts:50:Widget";
        let rows = resolved(&semantics);
        assert!(
            rows.iter().any(|row| row.3 == target_id),
            "expected a reference row targeting {target_id}, got {rows:?}"
        );
        assert!(semantics.external_entity_rows.is_empty());
    }

    /// n8n corpus regression: `declare module '~icons/*' { const component:
    /// T; export default component; }` -- a WILDCARD pattern specifier
    /// (`~icons/*`, matching any `~icons/...` import) whose default export
    /// names a BARE, never-itself-`export`ed local declaration. Both must
    /// resolve for a real `import IconFoo from "~icons/foo"` to stop
    /// falling through to an external entity.
    #[test]
    fn ambient_wildcard_default_export_of_a_bare_declaration_resolves() {
        let mut files = BTreeMap::new();
        files.insert(
            "env.d.ts".to_owned(),
            target_file_with_ambient(
                "env.d.ts",
                vec![ambient_decl(
                    "~icons/*",
                    "env.d.ts",
                    20,
                    true,
                    vec![],
                    Some(ambient_member("variable", "env.d.ts", 60, "component")),
                )],
            ),
        );
        let ctx = helper_ctx(files);
        let source =
            "import IconFoo from \"~icons/lucide/message-square\";\nconsole.log(IconFoo);\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        let target_id = "jsts:variable:env.d.ts:60:component";
        let rows = resolved(&semantics);
        assert!(
            rows.iter().any(|row| row.3 == target_id),
            "expected a reference row targeting {target_id}, got {rows:?}"
        );
        assert!(semantics.external_entity_rows.is_empty());
    }

    /// Fix item 3: a bodyless `declare module "specifier";` types the whole
    /// module `any` to the checker -- v3 never provides a declaration for a
    /// named import to resolve to. Mirrored as "stay pending", and -- just
    /// as importantly -- NEVER promoted to an external entity either (the
    /// specifier IS ambiently declared somewhere in this workspace).
    #[test]
    fn ambient_shorthand_declaration_stays_pending_never_external() {
        let mut files = BTreeMap::new();
        files.insert(
            "globals.d.ts".to_owned(),
            target_file_with_ambient(
                "globals.d.ts",
                vec![ambient_decl(
                    "*.css",
                    "globals.d.ts",
                    5,
                    false,
                    vec![],
                    None,
                )],
            ),
        );
        let ctx = helper_ctx(files);
        let source = "import styles from \"*.css\";\nconsole.log(styles);\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(
            resolved(&semantics).is_empty(),
            "a shorthand ambient declaration must never resolve a default import: {:?}",
            resolved(&semantics)
        );
        assert!(
            semantics.external_entity_rows.is_empty(),
            "a shorthand ambient declaration must never fall through to external either: {:?}",
            semantics.external_entity_rows
        );
    }

    /// Fix item 2: two workspace files declaring the SAME `declare module
    /// "specifier"` is workspace-ambiguous -- never guess which one a real
    /// import resolves to, and never external either.
    #[test]
    fn ambient_declared_by_two_files_stays_pending_never_external() {
        let mut files = BTreeMap::new();
        files.insert(
            "a.d.ts".to_owned(),
            target_file_with_ambient(
                "a.d.ts",
                vec![ambient_decl(
                    "shared-pkg",
                    "a.d.ts",
                    1,
                    true,
                    vec![ambient_member("function", "a.d.ts", 20, "thing")],
                    None,
                )],
            ),
        );
        files.insert(
            "b.d.ts".to_owned(),
            target_file_with_ambient(
                "b.d.ts",
                vec![ambient_decl(
                    "shared-pkg",
                    "b.d.ts",
                    1,
                    true,
                    vec![ambient_member("function", "b.d.ts", 20, "thing")],
                    None,
                )],
            ),
        );
        let ctx = helper_ctx(files);
        let source = "import { thing } from \"shared-pkg\";\nthing();\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(resolved(&semantics).is_empty());
        assert!(semantics.external_entity_rows.is_empty());
    }

    /// Regression guard (fix item 2's own scope boundary): a bare specifier
    /// with NO ambient declaration anywhere in the workspace must still
    /// resolve externally, exactly as before this task.
    #[test]
    fn specifier_with_no_ambient_declaration_still_resolves_externally() {
        let files: BTreeMap<String, crate::SyntaxFileResult> = BTreeMap::new();
        let ctx = helper_ctx(files);
        let source = "import { get } from \"lodash\";\nget();\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        let target_id = "jsts:external_symbol:lodash#get";
        let rows = resolved(&semantics);
        assert!(
            rows.iter().any(|row| row.3 == target_id),
            "expected a reference row targeting {target_id}, got {rows:?}"
        );
        assert!(
            semantics
                .external_entity_rows
                .iter()
                .any(|record| record.identity_key == target_id),
            "expected an external_symbol entity row for {target_id}"
        );
    }

    // -- 2026-09-04 references-parity task, Phase B bucket 1: default
    // imports and with-source re-export specifiers --------------------

    #[test]
    fn resolves_default_import_to_a_named_function_default_export() {
        // Found live against the n8n corpus: `import buildTrivyBlocks from
        // "./build-trivy-blocks.mjs"` where the target does `export default
        // function buildTrivyBlocks(...) {}` -- `lib.rs`'s `visit_export_
        // default_declaration` is what makes `export_bindings` carry this
        // at all (`exported_name: "default"`).
        let mut files = BTreeMap::new();
        files.insert(
            "helper.ts".to_owned(),
            target_file(
                "helper.ts",
                vec![target_entity(
                    crate::EntityKind::Function,
                    "helper.ts",
                    24,
                    "buildThing",
                )],
                vec![export_binding("default", "buildThing")],
            ),
        );
        let ctx = helper_ctx(files);
        let source =
            "import buildThing from \"./helper\";\nfunction use() {\n  return buildThing();\n}\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        let target_id = "jsts:function:helper.ts:24:buildThing";
        let local_start = source.find("buildThing").unwrap() as u32;
        assert!(
            semantics
                .pending_sites
                .iter()
                .all(|site| site.start_utf16 != local_start),
            "the default import specifier's local binding must not stay pending once resolved: sites: {:?}",
            semantics.pending_sites
        );
        let rows = resolved(&semantics);
        assert!(
            rows.iter()
                .any(|row| row.2 == "jsts:module:a.ts:0:a.ts" && row.3 == target_id),
            "expected an import-site reference row to {target_id}, got {rows:?}"
        );
        // ...and the later `buildThing()` call's callee identifier too.
        let function_id = format!("jsts:function:a.ts:{}:use", source.find("use").unwrap());
        assert!(
            rows.iter()
                .any(|row| row.2 == function_id && row.3 == target_id),
            "expected a usage-site reference row from {function_id} to {target_id}, got {rows:?}"
        );
    }

    #[test]
    fn default_import_of_a_target_with_no_default_export_stays_pending() {
        // Negative: `helper.ts` is a real, resolvable file, but exports
        // nothing as `"default"` (mirrors `export default { a: 1 };` or any
        // other non-nameable default-export shape `lib.rs`'s `visit_
        // export_default_declaration` deliberately never captures) --
        // `resolve_named_export` must report `Unresolved`, never a guess.
        let mut files = BTreeMap::new();
        files.insert(
            "helper.ts".to_owned(),
            target_file("helper.ts", vec![], vec![]),
        );
        let ctx = helper_ctx(files);
        let source = "import thing from \"./helper\";\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        let local_start = source.find("thing").unwrap() as u32;
        assert!(
            semantics
                .pending_sites
                .iter()
                .any(|site| site.start_utf16 == local_start
                    && site
                        .reason
                        .as_deref()
                        .is_some_and(|reason| reason.starts_with(REASON_IMPORT_BINDING))),
            "sites: {:?}",
            semantics.pending_sites
        );
    }

    #[test]
    fn resolves_with_source_reexport_specifier_local_position_to_the_source_declaration() {
        // Found live against the n8n corpus: barrel files like
        // `packages/@n8n/agents/src/evals/index.ts` doing `export {
        // helpfulness } from "./helpfulness"` for many sibling modules.
        let mut files = BTreeMap::new();
        files.insert(
            "helper.ts".to_owned(),
            target_file(
                "helper.ts",
                vec![target_entity(
                    crate::EntityKind::Function,
                    "helper.ts",
                    16,
                    "helper",
                )],
                vec![export_binding("helper", "helper")],
            ),
        );
        let ctx = helper_ctx(files);
        let source = "export { helper } from \"./helper\";\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        let target_id = "jsts:function:helper.ts:16:helper";
        let local_start = source.find("helper }").unwrap() as u32;
        assert!(
            semantics
                .pending_sites
                .iter()
                .all(|site| site.start_utf16 != local_start),
            "the re-export specifier's local position must not stay pending once resolved: sites: {:?}",
            semantics.pending_sites
        );
        let rows = resolved(&semantics);
        assert!(
            rows.iter()
                .any(|row| row.2 == "jsts:module:a.ts:0:a.ts" && row.3 == target_id),
            "expected a reference row to {target_id}, got {rows:?}"
        );
    }

    #[test]
    fn with_source_reexport_of_a_name_the_source_never_exports_stays_pending() {
        // Negative: `helper.ts` is real and resolvable, but never exports
        // `missing` under any name -- `resolve_named_export` reports
        // `Unresolved`, never a guess.
        let mut files = BTreeMap::new();
        files.insert(
            "helper.ts".to_owned(),
            target_file("helper.ts", vec![], vec![]),
        );
        let ctx = helper_ctx(files);
        let source = "export { missing } from \"./helper\";\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        let local_start = source.find("missing }").unwrap() as u32;
        assert!(
            semantics
                .pending_sites
                .iter()
                .any(|site| site.start_utf16 == local_start
                    && site
                        .reason
                        .as_deref()
                        .is_some_and(|reason| reason.starts_with(REASON_RE_EXPORT_BINDING))),
            "sites: {:?}",
            semantics.pending_sites
        );
    }

    #[test]
    fn resolves_aliased_named_import_by_the_imported_name_not_the_local_alias() {
        let mut files = BTreeMap::new();
        files.insert(
            "helper.ts".to_owned(),
            target_file(
                "helper.ts",
                vec![target_entity(
                    crate::EntityKind::Function,
                    "helper.ts",
                    16,
                    "helper",
                )],
                vec![export_binding("helper", "helper")],
            ),
        );
        let ctx = helper_ctx(files);
        let source =
            "import { helper as h } from \"./helper\";\nfunction use() {\n  return h();\n}\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        let target_id = "jsts:function:helper.ts:16:helper";
        let rows = resolved(&semantics);
        assert!(rows.iter().any(|row| row.3 == target_id), "rows: {rows:?}");
    }

    #[test]
    fn default_import_stays_pending_out_of_scope() {
        let mut files = BTreeMap::new();
        files.insert(
            "helper.ts".to_owned(),
            target_file(
                "helper.ts",
                vec![target_entity(
                    crate::EntityKind::Function,
                    "helper.ts",
                    24,
                    "helper",
                )],
                vec![export_binding("helper", "helper")],
            ),
        );
        let ctx = helper_ctx(files);
        let source = "import helper from \"./helper\";\nhelper();\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(resolved(&semantics).is_empty());
        assert!(semantics.pending_sites.iter().any(|site| {
            site.reason
                .as_deref()
                .is_some_and(|reason| reason.starts_with(REASON_IMPORT_BINDING))
        }));
    }

    #[test]
    fn ambiguous_multiple_declarations_in_target_stays_pending() {
        let mut files = BTreeMap::new();
        files.insert(
            "helper.ts".to_owned(),
            target_file(
                "helper.ts",
                vec![
                    target_entity(crate::EntityKind::Function, "helper.ts", 10, "f"),
                    target_entity(crate::EntityKind::Function, "helper.ts", 40, "f"),
                ],
                vec![export_binding("f", "f")],
            ),
        );
        let ctx = helper_ctx(files);
        let source = "import { f } from \"./helper\";\nf();\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(resolved(&semantics).is_empty());
    }

    #[test]
    fn resolves_through_a_named_reexport_one_hop() {
        let mut files = BTreeMap::new();
        files.insert(
            "impl.ts".to_owned(),
            target_file(
                "impl.ts",
                vec![target_entity(
                    crate::EntityKind::Class,
                    "impl.ts",
                    6,
                    "Widget",
                )],
                vec![export_binding("Widget", "Widget")],
            ),
        );
        files.insert(
            "helper.ts".to_owned(),
            target_file(
                "helper.ts",
                vec![],
                vec![reexport_binding("Widget", "Widget", "./impl", "impl.ts")],
            ),
        );
        let ctx = helper_ctx(files);
        let source = "import { Widget } from \"./helper\";\nnew Widget();\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        let target_id = "jsts:class:impl.ts:6:Widget";
        let rows = resolved(&semantics);
        assert!(rows.iter().any(|row| row.3 == target_id), "rows: {rows:?}");
    }

    #[test]
    fn unresolvable_specifier_stays_pending_with_import_binding_reason() {
        let files = BTreeMap::new();
        let ctx = helper_ctx(files);
        let source = "import { helper } from \"./missing\";\nhelper();\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(resolved(&semantics).is_empty());
        assert!(semantics.pending_sites.iter().any(|site| {
            site.reason
                .as_deref()
                .is_some_and(|reason| reason.starts_with(REASON_IMPORT_BINDING))
        }));
    }

    // -- E3: call/heritage partition (T1/T2) ---------------------------

    #[test]
    fn resolves_call_through_a_named_import_chain() {
        let mut files = BTreeMap::new();
        files.insert(
            "helper.ts".to_owned(),
            target_file(
                "helper.ts",
                vec![target_entity(
                    crate::EntityKind::Function,
                    "helper.ts",
                    16,
                    "helper",
                )],
                vec![export_binding("helper", "helper")],
            ),
        );
        let ctx = helper_ctx(files);
        let source =
            "import { helper } from \"./helper\";\nfunction use() {\n  return helper();\n}\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.call_rows.len(),
            1,
            "rows: {:?}",
            semantics.call_rows
        );
        let record = &semantics.call_rows[0];
        assert_eq!(
            record.body["target_id"],
            "jsts:function:helper.ts:16:helper"
        );
        assert_eq!(record.body["classification"], "confirmed");
        assert!(
            semantics
                .pending_sites
                .iter()
                .all(|site| site.site_kind != SiteKind::Call),
            "sites: {:?}",
            semantics.pending_sites
        );
    }

    #[test]
    fn cross_file_call_target_ambiguous_in_the_target_module_stays_pending() {
        let mut files = BTreeMap::new();
        files.insert(
            "helper.ts".to_owned(),
            target_file(
                "helper.ts",
                vec![
                    target_entity(crate::EntityKind::Function, "helper.ts", 16, "f"),
                    target_entity(crate::EntityKind::Function, "helper.ts", 40, "f"),
                ],
                vec![export_binding("f", "f")],
            ),
        );
        let ctx = helper_ctx(files);
        let source = "import { f } from \"./helper\";\nf();\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(
            semantics.call_rows.is_empty(),
            "rows: {:?}",
            semantics.call_rows
        );
        let call_start = source.rfind("f();").unwrap() as u32;
        let site = semantics
            .pending_sites
            .iter()
            .find(|site| site.site_kind == SiteKind::Call && site.start_utf16 == call_start);
        assert_eq!(
            site.and_then(|site| site.reason.as_deref()),
            Some(REASON_CALL_TARGET_UNCERTAIN),
            "sites: {:?}",
            semantics.pending_sites
        );
    }

    #[test]
    fn default_imported_call_stays_pending_out_of_scope() {
        let files = BTreeMap::new();
        let ctx = helper_ctx(files);
        let source = "import helper from \"./helper\";\nhelper();\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(semantics.call_rows.is_empty());
        assert!(
            semantics
                .pending_sites
                .iter()
                .any(|site| site.site_kind == SiteKind::Call)
        );
    }

    #[test]
    fn resolves_heritage_through_a_named_import_chain() {
        let mut files = BTreeMap::new();
        files.insert(
            "base.ts".to_owned(),
            target_file(
                "base.ts",
                vec![target_entity(
                    crate::EntityKind::Class,
                    "base.ts",
                    6,
                    "Base",
                )],
                vec![export_binding("Base", "Base")],
            ),
        );
        let ctx = helper_ctx(files);
        let source = "import { Base } from \"./base\";\nclass Derived extends Base {}\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.heritage_rows.len(),
            1,
            "rows: {:?}",
            semantics.heritage_rows
        );
        let record = &semantics.heritage_rows[0];
        assert_eq!(record.body["target_id"], "jsts:class:base.ts:6:Base");
        assert_eq!(record.kind, "jsts:relation_inherits");
    }

    // -- `core:covers` derivation (F5 hybrid gap fix, 2026-09-01) ------

    /// A minimal `SyntaxFileResult` for `path` carrying only its own module
    /// entity, flagged as a test container (`is_test: Some(true)`) exactly
    /// as lane 1's `SyntaxCollector::finish_import_relations` would leave it
    /// for a file that imports from `"node:test"`. Every E2 test above only
    /// ever populates `HybridResolutionContext::files` with the *target*
    /// files an import resolves to, never the owner's own entry -- this is
    /// that owner entry, for `is_test_source`'s lookup to find.
    fn test_container_owner_file(path: &str) -> crate::SyntaxFileResult {
        let module_id = format!("jsts:module:{path}:0:{path}");
        target_file(
            path,
            vec![crate::SyntaxEntity {
                id: module_id,
                name: path.to_owned(),
                kind: crate::EntityKind::Module,
                universal_kind: crate::UniversalKind::Container,
                path: path.to_owned(),
                start: 0,
                end: 0,
                parent_id: None,
                qualified_name: None,
                is_test: Some(true),
            }],
            vec![],
        )
    }

    fn covers(semantics: &OwnerSemantics) -> Vec<(u32, u32, &str, &str)> {
        semantics
            .covers_rows
            .iter()
            .map(|record| {
                let body = record.body.as_object().expect("covers body is an object");
                (
                    body["start"].as_u64().unwrap() as u32,
                    body["end"].as_u64().unwrap() as u32,
                    body["source_id"].as_str().unwrap(),
                    body["target_id"].as_str().unwrap(),
                )
            })
            .collect()
    }

    /// The gate's central case: a cross-file reference the hybrid Rust lane
    /// resolves (E2's import -> export -> declaration chain) from a file
    /// that is itself a test container must synthesize a `core:covers` row
    /// identical in shape to what `assembleAnalysis` (`analyzer.ts`) would
    /// produce for the checker-resolved equivalent -- both the import
    /// specifier's own site and the later call-site usage resolve, so this
    /// asserts BOTH become distinct covers rows (same `testContainer ->
    /// target` pair, different reference span/id -- `assembleAnalysis`
    /// never collapses by pair, only by identity; see the module doc on
    /// `OwnerSemantics::covers_rows`).
    #[test]
    fn cross_file_rust_resolved_reference_from_a_test_container_synthesizes_a_covers_row() {
        let mut files = BTreeMap::new();
        files.insert(
            "helper.ts".to_owned(),
            target_file(
                "helper.ts",
                vec![target_entity(
                    crate::EntityKind::Function,
                    "helper.ts",
                    16,
                    "helper",
                )],
                vec![export_binding("helper", "helper")],
            ),
        );
        files.insert("a.ts".to_owned(), test_container_owner_file("a.ts"));
        let ctx = helper_ctx(files);
        let source = "import { test } from \"node:test\";\nimport { helper } from \"./helper\";\n\nfunction testSomething() {\n  return helper();\n}\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        let target_id = "jsts:function:helper.ts:16:helper";
        let module_id = "jsts:module:a.ts:0:a.ts";
        let references = resolved(&semantics);
        let cross_file_count = references.iter().filter(|row| row.3 == target_id).count();
        assert_eq!(
            cross_file_count, 2,
            "expected both the import-site and usage-site reference rows: {references:?}"
        );
        // External package/symbol entities task (2026-09-04): the fixture's
        // own `import { test } from "node:test"` (needed to mark this owner
        // a test container at all -- `node_test_from`) now ALSO resolves,
        // like any other external named import, to `jsts:external_symbol:
        // node:test#test` -- a genuine cross-file reference from a test
        // container, so it gets its OWN `core:covers` row alongside the two
        // `helper.ts` ones this test already asserted, exactly the same
        // derivation rule applied uniformly (not a regression: a real
        // checker would resolve `node:test`'s `test` too and cover it the
        // same way). Scope the original per-`helper.ts`-target assertions
        // to just those two rows; assert the external row separately.
        let covers_rows = covers(&semantics);
        assert_eq!(
            covers_rows.len(),
            3,
            "expected one covers row per cross-file reference, including the external node:test import: {covers_rows:?}"
        );
        let external_target_id = "jsts:external_symbol:node:test#test";
        let external_covers: Vec<_> = covers_rows
            .iter()
            .filter(|row| row.3 == external_target_id)
            .collect();
        assert_eq!(
            external_covers.len(),
            1,
            "expected exactly one covers row for the node:test import itself: {covers_rows:?}"
        );
        let helper_covers_rows: Vec<_> = covers_rows
            .iter()
            .filter(|row| row.3 == target_id)
            .cloned()
            .collect();
        assert_eq!(
            helper_covers_rows.len(),
            2,
            "expected one covers row per cross-file reference to helper.ts: {covers_rows:?}"
        );
        let reference_spans: BTreeSet<(u32, u32)> =
            references.iter().map(|row| (row.0, row.1)).collect();
        for (start, end, source_id, target) in &helper_covers_rows {
            assert_eq!(
                *source_id, module_id,
                "covers source is always this owner's module, the test container"
            );
            assert_eq!(*target, target_id);
            assert!(
                reference_spans.contains(&(*start, *end)),
                "every covers row must reuse a span a reference row also carries"
            );
            let record = semantics
                .covers_rows
                .iter()
                .find(|record| {
                    record.body["start"].as_u64().unwrap() as u32 == *start
                        && record.body["end"].as_u64().unwrap() as u32 == *end
                })
                .expect("matching covers record");
            let expected_identity_key =
                format!("jsts:covers:a.ts:{start}:{end}:{module_id}:{target_id}");
            assert_eq!(record.identity_key, expected_identity_key);
            assert_eq!(record.kind, "jsts:relation_covers");
            assert_eq!(record.universal_kind, "core:covers");
            assert_eq!(record.category, "relation");
            assert_eq!(record.body["classification"], "confirmed");
            assert_eq!(record.body["path"], "a.ts");
        }
    }

    #[test]
    fn same_file_resolved_reference_from_a_test_container_does_not_synthesize_a_covers_row() {
        let files = BTreeMap::from([("a.ts".to_owned(), test_container_owner_file("a.ts"))]);
        let ctx = helper_ctx(files);
        let source = "function outer(value) {\n  return value;\n}\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.reference_rows.len(),
            1,
            "the intra-file reference itself must still resolve"
        );
        assert!(
            semantics.covers_rows.is_empty(),
            "a same-file reference is never a covers candidate, even from a test container"
        );
    }

    #[test]
    fn non_test_owner_never_synthesizes_covers_rows() {
        let mut files = BTreeMap::new();
        files.insert(
            "helper.ts".to_owned(),
            target_file(
                "helper.ts",
                vec![target_entity(
                    crate::EntityKind::Function,
                    "helper.ts",
                    16,
                    "helper",
                )],
                vec![export_binding("helper", "helper")],
            ),
        );
        let ctx = helper_ctx(files);
        let source =
            "import { helper } from \"./helper\";\nfunction use() {\n  return helper();\n}\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(
            !resolved(&semantics).is_empty(),
            "sanity: cross-file references were resolved"
        );
        assert!(
            semantics.covers_rows.is_empty(),
            "a non-test owner must never synthesize covers rows"
        );
    }

    // --- P0-S2 typeflow prototype -----------------------------------------

    /// Build a `HybridResolutionContext` carrying a real `ProgramIndex` over
    /// `sources` (path -> text), so typeflow's own widened resolution runs.
    /// `typeflow_oracle` controls `ctx.typeflow_oracle`.
    fn typeflow_ctx(
        sources: &[(&str, &str)],
        typeflow_oracle: bool,
    ) -> (
        HybridResolutionContext<'static>,
        &'static urdira_jsts_typeflow::ProgramIndex,
    ) {
        let mut summaries = BTreeMap::new();
        for (path, text) in sources {
            summaries.insert(
                (*path).to_owned(),
                urdira_jsts_typeflow::extract_decl_summary(path, text).expect("parses"),
            );
        }
        let index = urdira_jsts_typeflow::ProgramIndex::build(&summaries, &HashMap::new());
        let index: &'static urdira_jsts_typeflow::ProgramIndex = Box::leak(Box::new(index));
        let resolver = WorkspaceResolver::default();
        let available: BTreeSet<String> = BTreeSet::new();
        let files: BTreeMap<String, crate::SyntaxFileResult> = BTreeMap::new();
        let ctx = HybridResolutionContext {
            resolver: Box::leak(Box::new(resolver)),
            available: Box::leak(Box::new(available)),
            files: Box::leak(Box::new(files)),
            typeflow_index: Some(index),
            typeflow_oracle,
            ambient_index: Box::leak(Box::new(resolver::AmbientModuleIndex::default())),
        };
        (ctx, index)
    }

    #[test]
    fn typeflow_resolves_this_call_to_the_declaring_class_method() {
        let source = "class Base {\n  greet() {}\n}\nclass Derived extends Base {\n  run() {\n    this.greet();\n  }\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(
            semantics
                .pending_sites
                .iter()
                .all(|site| site.site_kind != SiteKind::Call),
            "sites: {:?}",
            semantics.pending_sites
        );
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
        let base_start = source.find("greet").unwrap() as u32;
        assert_eq!(
            semantics.typeflow_call_rows[0].body["target_id"],
            format!("jsts:method:a.ts:{base_start}:greet")
        );
    }

    // --- 2026-09-04 references-parity task: member-read references --------

    #[test]
    fn typeflow_resolves_a_this_property_read_reference() {
        let source = "class Point {\n  x: number = 0;\n  get() {\n    return this.x;\n  }\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(
            semantics.pending_sites.iter().all(|site| !site
                .reason
                .as_deref()
                .is_some_and(|reason| reason.starts_with(REASON_MEMBER_ACCESS))),
            "sites: {:?}",
            semantics.pending_sites
        );
        let x_id = urdira_jsts_typeflow::declaration_id(
            "property",
            "a.ts",
            source.find("x:").unwrap() as u32,
            "x",
        );
        assert!(
            semantics
                .reference_rows
                .iter()
                .any(|record| record.body["target_id"] == x_id.as_str()),
            "rows: {:?}",
            semantics.reference_rows
        );
    }

    /// The exact n8n shape the parameter-property fix (2026-09-04) targets:
    /// `this.defaultConfig` reading a constructor parameter property, on a
    /// class that ALSO `implements` an interface declaring a same-named
    /// member -- must resolve to the class's OWN parameter property, never
    /// the interface's `implements` fallback.
    #[test]
    fn typeflow_resolves_a_this_read_of_a_parameter_property_over_an_implemented_interface() {
        let source = "interface I {\n  defaultConfig: string;\n}\nclass A implements I {\n  constructor(public defaultConfig?: string) {}\n  m() {\n    return this.defaultConfig;\n  }\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(
            semantics.pending_sites.iter().all(|site| !site
                .reason
                .as_deref()
                .is_some_and(|reason| reason.starts_with(REASON_MEMBER_ACCESS))),
            "sites: {:?}",
            semantics.pending_sites
        );
        // The parameter property's own id (`constructor(public defaultConfig?...`),
        // NOT the interface's `defaultConfig` (which starts inside `interface I`,
        // strictly before the class) and NOT the `this.defaultConfig` READ
        // site itself (the third occurrence in `source`).
        let own_start =
            source.find("public defaultConfig").unwrap() as u32 + "public ".len() as u32;
        let interface_start = source.find("defaultConfig").unwrap() as u32;
        assert!(own_start > interface_start);
        let own_id =
            urdira_jsts_typeflow::declaration_id("parameter", "a.ts", own_start, "defaultConfig");
        assert!(
            semantics
                .reference_rows
                .iter()
                .any(|record| record.body["target_id"] == own_id.as_str()),
            "rows: {:?}",
            semantics.reference_rows
        );
        assert!(
            semantics
                .reference_rows
                .iter()
                .all(|record| record.body["target_id"]
                    != urdira_jsts_typeflow::declaration_id(
                        "property",
                        "a.ts",
                        interface_start,
                        "defaultConfig"
                    )
                    .as_str()),
            "must never resolve to the interface's own member"
        );
    }

    /// Negative: a member access whose object type is known but the member
    /// itself does not exist on it (`MemberLookup::None`) stays pending --
    /// never a guess.
    #[test]
    fn typeflow_member_read_of_a_nonexistent_member_stays_pending() {
        let source = "class Point {\n  x: number = 0;\n  get() {\n    return this.y;\n  }\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(
            semantics.pending_sites.iter().any(|site| site
                .reason
                .as_deref()
                .is_some_and(|reason| reason.starts_with(REASON_MEMBER_ACCESS))),
            "sites: {:?}",
            semantics.pending_sites
        );
        assert!(
            semantics.reference_rows.is_empty(),
            "rows: {:?}",
            semantics.reference_rows
        );
    }

    /// Negative: an overloaded member (`MemberLookup::Many` -- two same-
    /// named `ClassElement`s on the SAME container; oxc is a syntax-only
    /// parser and never flags the "duplicate declaration" a real checker
    /// would) is a genuine ambiguity for a READ too -- unlike the call lane
    /// (P2-2j `Candidates`), a member read never gets a `possible`-with-
    /// candidates row at all; it simply stays pending, exactly like a
    /// `None` miss.
    #[test]
    fn typeflow_member_read_of_an_overloaded_member_stays_pending() {
        let source = "class C {\n  run: string = \"\";\n  run: number = 0;\n  use() {\n    return this.run;\n  }\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(
            semantics.pending_sites.iter().any(|site| site
                .reason
                .as_deref()
                .is_some_and(|reason| reason.starts_with(REASON_MEMBER_ACCESS))),
            "sites: {:?}",
            semantics.pending_sites
        );
        assert!(semantics.reference_rows.iter().all(|record| {
            record.body["target_id"]
                .as_str()
                .is_some_and(|id| !id.contains(":run"))
        }));
    }

    #[test]
    fn typeflow_resolves_super_call_to_the_base_class_method() {
        let source = "class Base {\n  greet() {}\n}\nclass Derived extends Base {\n  greet() {\n    super.greet();\n  }\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
        let base_start = source.find("greet").unwrap() as u32;
        assert_eq!(
            semantics.typeflow_call_rows[0].body["target_id"],
            format!("jsts:method:a.ts:{base_start}:greet")
        );
    }

    #[test]
    fn typeflow_resolves_a_declared_type_parameter_member_call() {
        let source =
            "class Base {\n  greet() {}\n}\nfunction use(obj: Base) {\n  obj.greet();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_a_new_expression_initializer_member_call() {
        let source = "class Base {\n  greet() {}\n}\nfunction use() {\n  const obj = new Base();\n  obj.greet();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_generic_heritage_with_erased_type_arguments() {
        let source = "class Box<T> {}\nclass IntBox extends Box<number> {}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(
            semantics
                .pending_sites
                .iter()
                .all(|site| site.site_kind != SiteKind::Heritage),
            "sites: {:?}",
            semantics.pending_sites
        );
        assert_eq!(
            semantics.typeflow_heritage_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_heritage_rows
        );
    }

    #[test]
    fn typeflow_union_member_lookup_stays_pending() {
        // Two members named `run`, one on each side of an unrelated pair of
        // classes reachable only through separate bindings -- a genuinely
        // ambiguous member never has this test hit `MemberLookup::Many`
        // directly (that needs a diamond a class can't legally form), so
        // this instead exercises the "member not found anywhere" -> `None`
        // path staying pending, the far more common miss shape.
        let source =
            "class Base {\n  greet() {}\n}\nfunction use(obj: Base) {\n  obj.missing();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(semantics.typeflow_call_rows.is_empty());
        assert!(
            semantics
                .pending_sites
                .iter()
                .any(|site| site.site_kind == SiteKind::Call
                    && site.reason.as_deref() == Some(REASON_CALL_DEFERRED))
        );
    }

    // --- P2-2j: per-candidate possible rows for overload/union receivers --

    #[test]
    fn typeflow_overloaded_member_produces_candidate_rows_via_this_and_a_typed_local() {
        // Two `ClassElement::MethodDefinition`s share the name `run` -- oxc
        // is a syntax-only parser, so this parses fine even though a real
        // TypeScript checker would flag "duplicate function implementation"
        // (a semantic diagnostic, out of scope for a syntax-level index).
        // One call site through `this` (inside the SAME class), one through
        // a separately-typed local parameter -- both must produce 2
        // candidate rows each (distinct target ids), never a confirmed row.
        let source = "class Foo {\n  run(a: string) {}\n  run(a: number) {}\n  useThis() {\n    this.run(1);\n  }\n}\nfunction useLocal(x: Foo) {\n  x.run(1);\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(
            semantics.call_rows.is_empty(),
            "no E1-E3 confirmed calls expected"
        );
        assert!(
            semantics.typeflow_call_rows.is_empty(),
            "an overloaded member must never confirm -- rows: {:?}",
            semantics.typeflow_call_rows
        );
        assert_eq!(
            semantics.candidate_call_rows.len(),
            4,
            "2 call sites x 2 overloads each -- rows: {:?}",
            semantics.candidate_call_rows
        );
        let mut targets_by_site: BTreeMap<(u64, u64), BTreeSet<String>> = BTreeMap::new();
        for row in &semantics.candidate_call_rows {
            assert_eq!(row.body["reason"], REASON_OVERLOAD_AMBIGUOUS);
            assert_eq!(row.body["classification"], "possible");
            let start = row.body["start"].as_u64().expect("start is a number");
            let end = row.body["end"].as_u64().expect("end is a number");
            let target_id = row.body["target_id"]
                .as_str()
                .expect("target_id present")
                .to_owned();
            targets_by_site
                .entry((start, end))
                .or_default()
                .insert(target_id);
        }
        assert_eq!(
            targets_by_site.len(),
            2,
            "two distinct call sites -- {targets_by_site:?}"
        );
        for targets in targets_by_site.values() {
            assert_eq!(
                targets.len(),
                2,
                "each site must carry 2 DISTINCT overload targets -- {targets:?}"
            );
        }
        let pending_call_sites: Vec<_> = semantics
            .pending_sites
            .iter()
            .filter(|site| site.site_kind == SiteKind::Call)
            .collect();
        assert_eq!(pending_call_sites.len(), 2, "sites: {pending_call_sites:?}");
        assert!(
            pending_call_sites
                .iter()
                .all(|site| site.reason.as_deref() == Some(REASON_OVERLOAD_AMBIGUOUS)),
            "sites: {pending_call_sites:?}"
        );
    }

    #[test]
    fn typeflow_union_receiver_where_both_constituents_declare_the_member_produces_two_candidates()
    {
        let source = "class A {\n  run() {}\n}\nclass B {\n  run() {}\n}\nfunction use(x: A | B) {\n  x.run();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(semantics.typeflow_call_rows.is_empty());
        assert_eq!(
            semantics.candidate_call_rows.len(),
            2,
            "rows: {:?}",
            semantics.candidate_call_rows
        );
        let mut target_ids = BTreeSet::new();
        for row in &semantics.candidate_call_rows {
            assert_eq!(row.body["reason"], REASON_UNION_AMBIGUOUS);
            assert_eq!(row.body["classification"], "possible");
            target_ids.insert(
                row.body["target_id"]
                    .as_str()
                    .expect("target_id present")
                    .to_owned(),
            );
        }
        assert_eq!(
            target_ids.len(),
            2,
            "distinct A.run/B.run targets -- {target_ids:?}"
        );
        assert!(
            semantics
                .pending_sites
                .iter()
                .any(|site| site.site_kind == SiteKind::Call
                    && site.reason.as_deref() == Some(REASON_UNION_AMBIGUOUS))
        );
    }

    #[test]
    fn typeflow_union_receiver_missing_the_member_on_one_side_produces_no_candidates() {
        let source =
            "class A {\n  run() {}\n}\nclass B {}\nfunction use(x: A | B) {\n  x.run();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(semantics.typeflow_call_rows.is_empty());
        assert!(
            semantics.candidate_call_rows.is_empty(),
            "rows: {:?}",
            semantics.candidate_call_rows
        );
        assert!(
            semantics
                .pending_sites
                .iter()
                .any(|site| site.site_kind == SiteKind::Call
                    && site.reason.as_deref() == Some(REASON_CALL_DEFERRED))
        );
    }

    #[test]
    fn typeflow_union_of_the_same_entity_twice_behaves_as_a_non_union() {
        // `A | A` collapses to the single constituent `A` at the
        // `TypeflowValue`/`RawTypeRef` construction step -- the call site
        // must resolve exactly like `x: A` would (a normal, single-entity
        // `members()` lookup), never a `Candidates` outcome.
        let source = "class A {\n  run() {}\n}\nfunction use(x: A | A) {\n  x.run();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(
            semantics.candidate_call_rows.is_empty(),
            "rows: {:?}",
            semantics.candidate_call_rows
        );
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
        assert!(
            semantics
                .pending_sites
                .iter()
                .all(|site| site.site_kind != SiteKind::Call)
        );
    }

    #[test]
    fn typeflow_union_with_an_unresolvable_constituent_produces_no_candidates() {
        // A tuple constituent contaminates the WHOLE union to `Unknown` at
        // the annotation-classification step -- `x` never even becomes a
        // typed local, so the call site falls through to plain
        // `call_deferred_to_e3`, never a `Candidates` outcome.
        let source =
            "class A {\n  run() {}\n}\nfunction use(x: A | [number, string]) {\n  x.run();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(
            semantics.candidate_call_rows.is_empty(),
            "rows: {:?}",
            semantics.candidate_call_rows
        );
        assert!(semantics.typeflow_call_rows.is_empty());
        assert!(semantics.call_rows.is_empty());
    }

    #[test]
    fn typeflow_oracle_mode_records_a_hit_without_removing_the_pending_site() {
        let source = "class Base {\n  greet() {}\n}\nclass Derived extends Base {\n  run() {\n    this.greet();\n  }\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], true);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(
            semantics.typeflow_call_rows.is_empty(),
            "oracle mode must never publish a real row"
        );
        assert_eq!(
            semantics.typeflow_oracle_hits.len(),
            1,
            "hits: {:?}",
            semantics.typeflow_oracle_hits
        );
        assert_eq!(semantics.typeflow_oracle_hits[0].edge_kind, "call");
        assert!(
            semantics
                .pending_sites
                .iter()
                .any(|site| site.site_kind == SiteKind::Call
                    && site.reason.as_deref() == Some(REASON_CALL_DEFERRED)),
            "oracle mode must leave the site checker_pending: {:?}",
            semantics.pending_sites
        );
    }

    #[test]
    fn typeflow_is_a_no_op_when_the_flag_is_off() {
        // `analyze_owner_semantics` (no context override) must behave
        // byte-identically to before this prototype existed.
        let source = "class Base {\n  greet() {}\n}\nclass Derived extends Base {\n  run() {\n    this.greet();\n  }\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert!(semantics.typeflow_call_rows.is_empty());
        assert!(semantics.typeflow_heritage_rows.is_empty());
        assert!(semantics.typeflow_oracle_hits.is_empty());
    }

    // --- P1-A: fluent-chain / recursive type_of_expression rules ----------

    #[test]
    fn typeflow_resolves_a_fluent_builder_chain_through_new_and_this_return_types() {
        // The dominant miss pattern found in the P0-S2 census (`docs/
        // evidence/2026-09-02-v4-p0-s2-typeflow-prototype.md`): a builder
        // whose methods return `this`, chained straight off a `new T()`
        // expression with no intermediate variable.
        let source = "class Tool {\n  description(x: string): this { return this; }\n  input(x: string): this { return this; }\n}\nfunction use() {\n  new Tool().description(\"a\").input(\"b\");\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            2,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_a_call_expression_receiver_through_a_free_functions_return_type() {
        let source = "class Foo {\n  greet() {}\n}\nfunction make(): Foo {\n  return new Foo();\n}\nfunction use() {\n  make().greet();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_an_unannotated_variable_initialized_from_a_call_expression() {
        // Rule (b): `const x = make();` has no type ANNOTATION, but its
        // initializer recursively resolves through `type_of_expression`.
        let source = "class Foo {\n  greet() {}\n}\nfunction make(): Foo {\n  return new Foo();\n}\nfunction use() {\n  const x = make();\n  x.greet();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_await_unwrapping_a_promise_return_type() {
        let source = "class Foo {\n  greet() {}\n}\nasync function load(): Promise<Foo> {\n  return new Foo();\n}\nasync function use() {\n  (await load()).greet();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_array_element_access_through_a_declared_array_type() {
        let source =
            "class Foo {\n  greet() {}\n}\nfunction use(items: Foo[]) {\n  items[0].greet();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_through_an_as_expression_cast() {
        let source =
            "class Foo {\n  greet() {}\n}\nfunction use(x: unknown) {\n  (x as Foo).greet();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_through_a_non_null_assertion() {
        let source = "class Foo {\n  greet() {}\n}\nfunction use(x?: Foo) {\n  x!.greet();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_through_an_optional_chained_member_call() {
        let source = "class Foo {\n  greet() {}\n}\nfunction use(x: Foo) {\n  x?.greet();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_prefers_an_explicit_variable_annotation_over_its_object_literal_shape() {
        // Regression (2k-owner census, wrong-target found live): `const
        // allNodesConnected: BinaryCheck = { run() {...} }` -- `.run` on a
        // USE of `allNodesConnected` must resolve to `BinaryCheck`'s OWN
        // `run` member (TypeScript's declared-type rule), never the object
        // literal's own `run` method, even though both happen to share the
        // same name.
        let source = "interface BinaryCheck {\n  run(): void;\n}\nconst allNodesConnected: BinaryCheck = {\n  run() {\n    return undefined;\n  },\n};\nfunction use() {\n  allNodesConnected.run();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
        // The interface's own `run` (at offset 26) must win, never the
        // object literal's own `run` method (at offset 84).
        assert_eq!(
            semantics.typeflow_call_rows[0].body["target_id"], "jsts:method:a.ts:26:run",
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_this_inside_a_nested_plain_function_does_not_leak_the_enclosing_class() {
        // Regression (rule (e)): a plain `function` REBINDS `this` -- a
        // nested function expression inside a method must NOT resolve
        // `this` to the enclosing class, unlike an arrow function (which
        // does not rebind, see the next test).
        let source = "class Base {\n  greet() {}\n}\nclass Derived extends Base {\n  run() {\n    const inner = function () {\n      this.greet();\n    };\n    inner();\n  }\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(
            semantics.typeflow_call_rows.is_empty(),
            "a nested plain function's `this` must stay pending, never resolve to the enclosing \
             class: rows {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_this_inside_a_nested_arrow_function_still_resolves_to_the_enclosing_class() {
        // Rule (e)'s other half: an ARROW function does NOT rebind `this`,
        // so it must keep seeing the enclosing class/method's `this`.
        let source = "class Base {\n  greet() {}\n}\nclass Derived extends Base {\n  run() {\n    const inner = () => {\n      this.greet();\n    };\n    inner();\n  }\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_the_zod_class_mixin_heritage_pattern_across_files() {
        // Same pattern as `typeflow_resolves_the_zod_class_mixin_heritage_
        // pattern`, but with `Z` imported from a SEPARATE file (the real
        // shape in the corpus: `packages/@n8n/api-types/src/zod-class.ts`'s
        // `Z` used from `.../dto.ts`'s `class CreateAgentSkillDto extends
        // Z.class({...}) {}`) -- exercises the CROSS-FILE half of the
        // object-shape rule (`resolve_identifier_to_kind`'s import branch,
        // `import_bindings` populated from `resolve_named_export`).
        let zod_class_source = "export interface ZodClass {\n  safeParse(): void;\n}\nexport const Z = {\n  class: (): ZodClass => ({}) as ZodClass,\n};\n";
        let dto_source =
            "import { Z } from \"./zod-class\";\nexport class Dto extends Z.class() {}\n";
        let user_source =
            "import { Dto } from \"./dto\";\nfunction use(dto: Dto) {\n  dto.safeParse();\n}\n";
        let mut summaries = BTreeMap::new();
        summaries.insert(
            "zod-class.ts".to_owned(),
            urdira_jsts_typeflow::extract_decl_summary("zod-class.ts", zod_class_source)
                .expect("parses"),
        );
        summaries.insert(
            "dto.ts".to_owned(),
            urdira_jsts_typeflow::extract_decl_summary("dto.ts", dto_source).expect("parses"),
        );
        let z_id = "jsts:variable:zod-class.ts:64:Z".to_owned();
        assert_eq!(
            summaries["zod-class.ts"].object_shapes[0].entity_id, z_id,
            "test's assumed Z offset drifted"
        );
        let mut import_targets = HashMap::new();
        import_targets.insert(
            (
                "dto.ts".to_owned(),
                "./zod-class".to_owned(),
                "Z".to_owned(),
            ),
            z_id.clone(),
        );
        let index = urdira_jsts_typeflow::ProgramIndex::build(&summaries, &import_targets);
        let index: &'static urdira_jsts_typeflow::ProgramIndex = Box::leak(Box::new(index));

        let mut files = BTreeMap::new();
        files.insert(
            "zod-class.ts".to_owned(),
            target_file(
                "zod-class.ts",
                vec![target_entity(
                    crate::EntityKind::Variable,
                    "zod-class.ts",
                    64,
                    "Z",
                )],
                vec![export_binding("Z", "Z")],
            ),
        );
        files.insert(
            "dto.ts".to_owned(),
            target_file(
                "dto.ts",
                vec![target_entity(crate::EntityKind::Class, "dto.ts", 46, "Dto")],
                vec![export_binding("Dto", "Dto")],
            ),
        );
        let resolver = WorkspaceResolver::default();
        let available: BTreeSet<String> = files.keys().cloned().collect();
        let ctx = HybridResolutionContext {
            resolver: Box::leak(Box::new(resolver)),
            available: Box::leak(Box::new(available)),
            files: Box::leak(Box::new(files)),
            typeflow_index: Some(index),
            typeflow_oracle: false,
            ambient_index: Box::leak(Box::new(resolver::AmbientModuleIndex::default())),
        };
        let semantics = analyze_owner_semantics_with_context("dto.ts", dto_source, &ctx)
            .expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_heritage_rows.len(),
            1,
            "heritage rows: {:?}; pending: {:?}",
            semantics.typeflow_heritage_rows,
            semantics.pending_sites
        );
        let user_semantics = analyze_owner_semantics_with_context("user.ts", user_source, &ctx)
            .expect("analysis succeeds");
        assert_eq!(
            user_semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}; pending: {:?}",
            user_semantics.typeflow_call_rows,
            user_semantics.pending_sites
        );
    }

    #[test]
    fn typeflow_resolves_the_zod_class_mixin_heritage_pattern() {
        // The dominant miss pattern found in the 2k census (docs/evidence/
        // 2026-09-02-v4-p1a-typeflow.md): `class Dto extends Z.class({...})
        // {}` where `Z` is a top-level `const Z = { class: (...): ZodClass
        // => ... }` object literal -- a mixin FACTORY, not a plain class
        // identifier. Both same-file (this test) and cross-file (import)
        // must resolve to `ZodClass`'s own `safeParse` member.
        let source = "interface ZodClass {\n  safeParse(): void;\n}\nconst Z = {\n  class: (): ZodClass => ({}) as ZodClass,\n};\nclass Dto extends Z.class() {}\nfunction use(dto: Dto) {\n  dto.safeParse();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_heritage_rows.len(),
            1,
            "heritage rows: {:?}",
            semantics.typeflow_heritage_rows
        );
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "call rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_a_namespace_member_call_directly() {
        // Rule (f): `ns.fn()` where `ns` is `import * as ns`, and `fn` is a
        // top-level function declared in the target module -- both as the
        // direct call target itself (`ns.make()`) AND as a chain receiver
        // for the following `.greet()`.
        let base_source =
            "class Foo {\n  greet() {}\n}\nexport function make(): Foo {\n  return new Foo();\n}\n";
        let user_source =
            "import * as ns from \"./base\";\nfunction use() {\n  ns.make().greet();\n}\n";
        let mut summaries = BTreeMap::new();
        summaries.insert(
            "base.ts".to_owned(),
            urdira_jsts_typeflow::extract_decl_summary("base.ts", base_source).expect("parses"),
        );
        let index = urdira_jsts_typeflow::ProgramIndex::build(&summaries, &HashMap::new());
        let index: &'static urdira_jsts_typeflow::ProgramIndex = Box::leak(Box::new(index));
        let mut files = BTreeMap::new();
        files.insert(
            "base.ts".to_owned(),
            target_file(
                "base.ts",
                vec![
                    target_entity(crate::EntityKind::Class, "base.ts", 6, "Foo"),
                    target_entity(crate::EntityKind::Function, "base.ts", 43, "make"),
                ],
                vec![export_binding("make", "make")],
            ),
        );
        let resolver = WorkspaceResolver::default();
        let available: BTreeSet<String> = files.keys().cloned().collect();
        let ctx = HybridResolutionContext {
            resolver: Box::leak(Box::new(resolver)),
            available: Box::leak(Box::new(available)),
            files: Box::leak(Box::new(files)),
            typeflow_index: Some(index),
            typeflow_oracle: false,
            ambient_index: Box::leak(Box::new(resolver::AmbientModuleIndex::default())),
        };
        let semantics = analyze_owner_semantics_with_context("user.ts", user_source, &ctx)
            .expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            2,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
        assert!(
            semantics
                .typeflow_call_rows
                .iter()
                .any(|row| row.body["target_id"] == "jsts:function:base.ts:43:make"),
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn a5_form1_resolves_a_namespace_member_read_as_a_plain_value() {
        // 2026-09-05 A5 references-parity task, Paso 1 fix Form 1: found
        // live in n8n's own `packages/nodes-base/nodes/Odoo/test/v2/
        // methods/listSearch.test.ts` -- `(transport.odooApiRequest as
        // jest.Mock).mockResolvedValue(...)` where `transport` is bound by
        // `import * as transport from "./transport"`. Unlike `typeflow_
        // resolves_a_namespace_member_call_directly` (a CALL callee, rule
        // (f)), `make` here is read as a plain value, never called --
        // `resolve_static_member_reference`'s new fallback must still
        // resolve it.
        let base_source =
            "class Foo {\n  greet() {}\n}\nexport function make(): Foo {\n  return new Foo();\n}\n";
        let user_source = "import * as ns from \"./base\";\nfunction use() {\n  const ref = ns.make;\n  return ref;\n}\n";
        let mut summaries = BTreeMap::new();
        summaries.insert(
            "base.ts".to_owned(),
            urdira_jsts_typeflow::extract_decl_summary("base.ts", base_source).expect("parses"),
        );
        let index = urdira_jsts_typeflow::ProgramIndex::build(&summaries, &HashMap::new());
        let index: &'static urdira_jsts_typeflow::ProgramIndex = Box::leak(Box::new(index));
        let mut files = BTreeMap::new();
        files.insert(
            "base.ts".to_owned(),
            target_file(
                "base.ts",
                vec![
                    target_entity(crate::EntityKind::Class, "base.ts", 6, "Foo"),
                    target_entity(crate::EntityKind::Function, "base.ts", 43, "make"),
                ],
                vec![export_binding("make", "make")],
            ),
        );
        let resolver = WorkspaceResolver::default();
        let available: BTreeSet<String> = files.keys().cloned().collect();
        let ctx = HybridResolutionContext {
            resolver: Box::leak(Box::new(resolver)),
            available: Box::leak(Box::new(available)),
            files: Box::leak(Box::new(files)),
            typeflow_index: Some(index),
            typeflow_oracle: false,
            ambient_index: Box::leak(Box::new(resolver::AmbientModuleIndex::default())),
        };
        let semantics = analyze_owner_semantics_with_context("user.ts", user_source, &ctx)
            .expect("analysis succeeds");
        assert!(
            semantics
                .reference_rows
                .iter()
                .any(|record| record.body["target_id"] == "jsts:function:base.ts:43:make"),
            "rows: {:?}",
            semantics.reference_rows
        );
    }

    #[test]
    fn a5_form1_negative_ambiguous_namespace_member_read_stays_pending() {
        // Negative sibling of `a5_form1_resolves_a_namespace_member_read_
        // as_a_plain_value`: the namespace's target module does not
        // provide `missing` at all -- `resolve_namespace_member` returns
        // `None` (`ExportResolution::Unresolved`), so the read stays
        // pending, never a guess.
        let base_source = "export function make(): void {}\n";
        let user_source = "import * as ns from \"./base\";\nfunction use() {\n  const ref = ns.missing;\n  return ref;\n}\n";
        let mut summaries = BTreeMap::new();
        summaries.insert(
            "base.ts".to_owned(),
            urdira_jsts_typeflow::extract_decl_summary("base.ts", base_source).expect("parses"),
        );
        let index = urdira_jsts_typeflow::ProgramIndex::build(&summaries, &HashMap::new());
        let index: &'static urdira_jsts_typeflow::ProgramIndex = Box::leak(Box::new(index));
        let mut files = BTreeMap::new();
        files.insert(
            "base.ts".to_owned(),
            target_file(
                "base.ts",
                vec![target_entity(
                    crate::EntityKind::Function,
                    "base.ts",
                    17,
                    "make",
                )],
                vec![export_binding("make", "make")],
            ),
        );
        let resolver = WorkspaceResolver::default();
        let available: BTreeSet<String> = files.keys().cloned().collect();
        let ctx = HybridResolutionContext {
            resolver: Box::leak(Box::new(resolver)),
            available: Box::leak(Box::new(available)),
            files: Box::leak(Box::new(files)),
            typeflow_index: Some(index),
            typeflow_oracle: false,
            ambient_index: Box::leak(Box::new(resolver::AmbientModuleIndex::default())),
        };
        let semantics = analyze_owner_semantics_with_context("user.ts", user_source, &ctx)
            .expect("analysis succeeds");
        let missing_start = user_source.find("missing").unwrap() as u32;
        // `return ref;` (a plain, UNRELATED identifier reference to the
        // local `ref` binding) legitimately resolves -- only the `ns.
        // missing` member-read site itself must never guess.
        assert!(
            semantics
                .reference_rows
                .iter()
                .all(|record| record.body["start"] != missing_start),
            "must never guess: rows: {:?}",
            semantics.reference_rows
        );
        assert!(
            semantics.pending_sites.iter().any(|site| {
                site.start_utf16 == missing_start
                    && site.reason.as_deref() == Some("member_access/ident:import_bound")
            }),
            "sites: {:?}",
            semantics.pending_sites
        );
    }

    #[test]
    fn typeflow_resolves_a_member_call_through_a_named_import_of_a_namespace_reexport() {
        // P1-B: `import { evals } from "./index"` where `index.ts` does
        // `export * as evals from "./evals/index"` -- see
        // `crate::NAMESPACE_REEXPORT_LOCAL_NAME`'s doc comment. Found live:
        // `packages/@n8n/agents/src/__tests__/integration/evaluate.test.ts`
        // imports `evals` this way and calls `evals.stringSimilarity(...)`.
        let user_source = "import { evals } from \"./index\";\nfunction use() {\n  evals.stringSimilarity();\n}\n";
        let mut files = BTreeMap::new();
        files.insert(
            "index.ts".to_owned(),
            target_file(
                "index.ts",
                vec![],
                vec![reexport_binding(
                    "evals",
                    crate::NAMESPACE_REEXPORT_LOCAL_NAME,
                    "./evals/index",
                    "evals/index.ts",
                )],
            ),
        );
        files.insert(
            "evals/index.ts".to_owned(),
            target_file(
                "evals/index.ts",
                vec![target_entity(
                    crate::EntityKind::Function,
                    "evals/index.ts",
                    899,
                    "stringSimilarity",
                )],
                vec![export_binding("stringSimilarity", "stringSimilarity")],
            ),
        );
        let index = urdira_jsts_typeflow::ProgramIndex::build(&BTreeMap::new(), &HashMap::new());
        let index: &'static urdira_jsts_typeflow::ProgramIndex = Box::leak(Box::new(index));
        let mut ctx = helper_ctx(files);
        ctx.typeflow_index = Some(index);
        let semantics = analyze_owner_semantics_with_context("user.ts", user_source, &ctx)
            .expect("analysis succeeds");
        assert!(
            semantics
                .typeflow_call_rows
                .iter()
                .any(|row| row.body["target_id"]
                    == "jsts:function:evals/index.ts:899:stringSimilarity"),
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_a_destructured_binding_from_a_typed_object() {
        // Rule (h): `const { agent } = setup();` types `agent` from
        // `setup()`'s own return type's `agent` property.
        let source = "class Agent {\n  close() {}\n}\ninterface Setup {\n  agent: Agent;\n}\nfunction setup(): Setup {\n  return { agent: new Agent() };\n}\nfunction use() {\n  const { agent } = setup();\n  agent.close();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_a_call_through_a_destructured_method_valued_parameter() {
        // P1-B: the migration-DSL pattern found live (`packages/@n8n/db/
        // src/migrations/**`): `createTable` is a destructured METHOD
        // (not a plain data property), so calling `createTable(name)`
        // itself must resolve to `TableBuilder` for the following
        // `.withColumns()` chain hop to work.
        //
        // P1-C: `createTable("x")` ITSELF is now ALSO resolved (a bare
        // call to a destructured-method identifier -- see `destructured_
        // member_entities`'s own doc comment), in addition to the
        // `.withColumns()` chain hop this test originally covered alone --
        // 2 rows, not 1.
        let source = "class TableBuilder {\n  withColumns(): void {}\n}\ninterface SchemaBuilder {\n  createTable(name: string): TableBuilder;\n}\nfunction up({ createTable }: SchemaBuilder) {\n  createTable(\"x\").withColumns();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            2,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
        assert!(
            semantics
                .typeflow_call_rows
                .iter()
                .any(|row| row.body["target_id"] == "jsts:method:a.ts:76:createTable"),
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_a_destructured_parameter_from_an_annotated_type() {
        let source = "class Agent {\n  close() {}\n}\ninterface Setup {\n  agent: Agent;\n}\nfunction use({ agent }: Setup) {\n  agent.close();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn a5_diagnostic_probe_parameter_destructured_in_a_later_statement() {
        // 2026-09-05 A5 diagnostic probe (temporary, to be removed after
        // confirming the baseline): unlike `typeflow_resolves_a_
        // destructured_parameter_from_an_annotated_type` (destructuring
        // directly in the parameter list), this destructures a PLAIN
        // `BindingIdentifier` parameter's OWN typed binding in a LATER
        // statement -- `const { agent } = setup;` where `setup: Setup` is
        // the parameter.
        let source = "class Agent {\n  close() {}\n}\ninterface Setup {\n  agent: Agent;\n}\nfunction use(setup: Setup) {\n  const { agent } = setup;\n  agent.close();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_a_nested_destructured_parameter_two_levels_deep() {
        // Found live in this corpus's own migration DSL: EVERY migration's
        // `up`/`down` method destructures straight through `schemaBuilder`
        // to its own members, never binding a `schemaBuilder` local at
        // all: `async up({ schemaBuilder: { dropColumns } }: MigrationContext)`.
        let source = "class Builder {\n  dropColumns(): void {}\n}\ninterface Context {\n  schemaBuilder: Builder;\n}\nfunction up({ schemaBuilder: { dropColumns } }: Context) {\n  dropColumns();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_the_full_return_type_of_typeof_migration_dsl_pattern_end_to_end() {
        // The COMPLETE flagship pattern this session chased, combining
        // three separate fixes: `ReturnType<typeof f>` where `f` is a
        // callable VARIABLE (`const createSchemaBuilder = (...) => ({
        // ... })`, never a `function` declaration) whose returned object
        // shape is a member-bearing container, reached through a NESTED
        // destructured parameter that never binds the intermediate
        // `schemaBuilder` name at all.
        let source = "class Builder {\n  dropColumns(): void {}\n}\nconst createSchemaBuilder = (prefix) => ({\n  dropColumns(name) {},\n});\ninterface Context {\n  schemaBuilder: ReturnType<typeof createSchemaBuilder>;\n}\nfunction up({ schemaBuilder: { dropColumns } }: Context) {\n  dropColumns('x');\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn a5_form3_diagnostic_probe_fluent_getter_chain_migration_dsl() {
        // 2026-09-05 A5 diagnostic probe (temporary): the REAL migrations
        // DSL shape (`packages/@n8n/db/src/migrations/dsl/{column,index}.ts`
        // + a real migration file) -- `column('id').varchar(36).primary.
        // notNull`, where `.primary`/`.notNull` are GETTERS (`get primary()
        // { ...; return this; }`), not methods, and `column` itself comes
        // from a `ReturnType<typeof createSchemaBuilder>` object-shape
        // arrow property returning `new Column(name)`.
        let source = "class Column {\n  varchar(length) {\n    return this;\n  }\n  get primary() {\n    return this;\n  }\n  get notNull() {\n    return this;\n  }\n}\nconst createSchemaBuilder = (prefix) => ({\n  column: (name) => new Column(name),\n});\ninterface Context {\n  schemaBuilder: ReturnType<typeof createSchemaBuilder>;\n}\nfunction up({ schemaBuilder: { column } }: Context) {\n  column('id').varchar(36).primary.notNull;\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        let not_null_start = source.find("get notNull").unwrap() as u32 + "get ".len() as u32;
        let target_id = format!("jsts:getter:a.ts:{not_null_start}:notNull");
        assert!(
            semantics
                .reference_rows
                .iter()
                .any(|record| record.body["target_id"] == target_id.as_str()),
            "target_id={target_id} rows: {:?} pending: {:?}",
            semantics.reference_rows,
            semantics.pending_sites
        );
    }

    #[test]
    fn a5_form3_diagnostic_probe_fluent_getter_chain_cross_file() {
        // 2026-09-05 A5 diagnostic probe (temporary): the SAME shape as
        // `a5_form3_diagnostic_probe_fluent_getter_chain_migration_dsl`,
        // but with `Column` in a SEPARATE file (`column.ts`), imported by
        // name into `user.ts` -- exactly how the real corpus splits it
        // (`dsl/column.ts` vs `dsl/index.ts`). Isolates whether the gap (if
        // any) is cross-file import resolution rather than the single-file
        // body-inference mechanism itself (already proven sound by the
        // single-file sibling probe).
        let column_source = "export class Column {\n  varchar(length) {\n    return this;\n  }\n  get primary() {\n    return this;\n  }\n  get notNull() {\n    return this;\n  }\n}\n";
        let user_source = "import { Column } from \"./column\";\nconst createSchemaBuilder = (prefix) => ({\n  column: (name) => new Column(name),\n});\ninterface Context {\n  schemaBuilder: ReturnType<typeof createSchemaBuilder>;\n}\nfunction up({ schemaBuilder: { column } }: Context) {\n  column('id').varchar(36).primary.notNull;\n}\n";
        let mut summaries = BTreeMap::new();
        summaries.insert(
            "column.ts".to_owned(),
            urdira_jsts_typeflow::extract_decl_summary("column.ts", column_source).expect("parses"),
        );
        summaries.insert(
            "user.ts".to_owned(),
            urdira_jsts_typeflow::extract_decl_summary("user.ts", user_source).expect("parses"),
        );
        // `ProgramIndex::build`'s own cross-file import closure (SEPARATE
        // from `urdira-jsts-syntax-worker`'s E2 `resolve_named_export`
        // chain) needs `import_targets` populated -- in the real pipeline
        // this comes from the same resolved import graph every other
        // cross-file typeflow test builds by hand (see `members_walks_
        // extends_chain_across_files` in `urdira-jsts-typeflow`'s own test
        // module for the identical pattern).
        let mut import_targets = HashMap::new();
        import_targets.insert(
            (
                "user.ts".to_owned(),
                "./column".to_owned(),
                "Column".to_owned(),
            ),
            "jsts:class:column.ts:13:Column".to_owned(),
        );
        let index = urdira_jsts_typeflow::ProgramIndex::build(&summaries, &import_targets);
        let index: &'static urdira_jsts_typeflow::ProgramIndex = Box::leak(Box::new(index));
        let not_null_start =
            column_source.find("get notNull").unwrap() as u32 + "get ".len() as u32;
        let mut files = BTreeMap::new();
        files.insert(
            "column.ts".to_owned(),
            target_file(
                "column.ts",
                vec![target_entity(
                    crate::EntityKind::Class,
                    "column.ts",
                    13,
                    "Column",
                )],
                vec![export_binding("Column", "Column")],
            ),
        );
        let resolver = WorkspaceResolver::default();
        let available: BTreeSet<String> = files.keys().cloned().collect();
        let ctx = HybridResolutionContext {
            resolver: Box::leak(Box::new(resolver)),
            available: Box::leak(Box::new(available)),
            files: Box::leak(Box::new(files)),
            typeflow_index: Some(index),
            typeflow_oracle: false,
            ambient_index: Box::leak(Box::new(resolver::AmbientModuleIndex::default())),
        };
        let semantics = analyze_owner_semantics_with_context("user.ts", user_source, &ctx)
            .expect("analysis succeeds");
        let target_id = format!("jsts:getter:column.ts:{not_null_start}:notNull");
        assert!(
            semantics
                .reference_rows
                .iter()
                .any(|record| record.body["target_id"] == target_id.as_str()),
            "target_id={target_id} rows: {:?} pending: {:?}",
            semantics.reference_rows,
            semantics.pending_sites
        );
    }

    #[test]
    fn typeflow_resolves_a_chain_through_a_locally_annotated_inline_type_literal() {
        // Found live in this corpus's `langsmith.ts`: `function f(options:
        // { runner: Runner }) { options.runner.run(); }` -- `options`'s OWN
        // annotation is an anonymous `{ ... }` type, not a named interface
        // (rule (j), local half: `TypeflowValue::Inline`).
        let source = "class Runner {\n  run() {}\n}\nfunction use(options: { runner: Runner }) {\n  options.runner.run();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_a_property_chain_through_an_inline_type_literal() {
        // Found live in this corpus's own migration DSL: `interface
        // MigrationContext { escape: { columnName(name: string): string; };
        // }`, used as `context.escape.columnName(...)` -- rule (j),
        // partial: an ANONYMOUS `{ ... }` object type, not a named
        // interface.
        let source = "interface MigrationContext {\n  escape: {\n    columnName(name: string): string;\n  };\n}\nfunction use(context: MigrationContext) {\n  context.escape.columnName(\"x\");\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_a_property_chain_through_a_declared_object_member_type() {
        // `a.b.c()`: `b`'s own declared type on `a`'s class, then `c` on
        // `b`'s type -- two hops, neither of which is `this`/`super`/`new`.
        let source = "class Foo {\n  greet() {}\n}\nclass Holder {\n  foo: Foo;\n}\nfunction use(h: Holder) {\n  h.foo.greet();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    // P1-C: utility types, local-annotation half (`type_ref_of_ts_type`).

    #[test]
    fn typeflow_resolves_a_local_parameter_annotated_return_type_of_typeof_fn() {
        // The migration-DSL pattern found live: `schemaBuilder: ReturnType<
        // typeof createSchemaBuilder>` as a PARAMETER annotation.
        let source = "class Builder {\n  column() {}\n}\nfunction createBuilder(): Builder { return new Builder(); }\nfunction up(schemaBuilder: ReturnType<typeof createBuilder>) {\n  schemaBuilder.column();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_a_local_parameter_annotated_instance_type_of_typeof_class() {
        let source = "class Foo {\n  greet() {}\n}\nfunction use(foo: InstanceType<typeof Foo>) {\n  foo.greet();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_a_local_parameter_annotated_awaited_of_promise() {
        let source = "class Foo {\n  greet() {}\n}\nfunction use(foo: Awaited<Promise<Foo>>) {\n  foo.greet();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_a_local_parameter_annotated_record_element_via_computed_access() {
        let source = "class Foo {\n  greet() {}\n}\nfunction use(items: Record<string, Foo>) {\n  items[\"x\"].greet();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    #[test]
    fn typeflow_resolves_a_local_parameter_annotated_pick_of_an_interface() {
        // Per the task's own framing: `Pick<T, K>`/`Omit<T, K>` keep `T`'s
        // FULL member table rather than narrowing it -- never a wrong
        // target, only a theoretical over-acceptance out of this crate's
        // scope.
        let source = "interface Foo {\n  greet(): void;\n}\nfunction use(foo: Pick<Foo, \"greet\">) {\n  foo.greet();\n}\n";
        let (ctx, _index) = typeflow_ctx(&[("a.ts", source)], false);
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert_eq!(
            semantics.typeflow_call_rows.len(),
            1,
            "rows: {:?}",
            semantics.typeflow_call_rows
        );
    }

    // -- Parameter entities, "referenced-only" variant (owner-approved,
    // 2026-09-04) --------------------------------------------------------

    #[test]
    fn referenced_parameters_get_entities_matching_the_reference_target_across_owner_shapes() {
        let source = concat!(
            "function outer(value) {\n",
            "  return value;\n",
            "}\n",
            "class Box {\n",
            "  constructor(id) {\n",
            "    return id;\n",
            "  }\n",
            "  render(size) {\n",
            "    return size;\n",
            "  }\n",
            "}\n",
            "const make = (count) => count;\n",
        );
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");

        let function_id = declaration_id(
            DeclKind::Function,
            "a.ts",
            source.find("outer").unwrap() as u32,
            "outer",
        );
        let constructor_id = declaration_id(
            DeclKind::Constructor,
            "a.ts",
            source.find("constructor").unwrap() as u32,
            "constructor",
        );
        let render_id = declaration_id(
            DeclKind::Method,
            "a.ts",
            source.find("render").unwrap() as u32,
            "render",
        );
        let make_id = declaration_id(
            DeclKind::Variable,
            "a.ts",
            source.find("make").unwrap() as u32,
            "make",
        );

        // Four owner shapes (function declaration, constructor, class
        // method, variable-bound arrow), one referenced parameter each --
        // every one of the four gets an entity, its id byte-identical to
        // the `reference_rows` target already resolved for it.
        let cases = [
            ("value", function_id.as_str(), "a.ts.outer.value"),
            ("id", constructor_id.as_str(), "a.ts.Box.constructor.id"),
            ("size", render_id.as_str(), "a.ts.Box.render.size"),
            ("count", make_id.as_str(), "a.ts.make.count"),
        ];
        assert_eq!(
            semantics.parameter_entity_rows.len(),
            cases.len(),
            "rows: {:?}",
            semantics.parameter_entity_rows
        );
        assert_eq!(semantics.parameter_contains_rows.len(), cases.len());
        for (name, parent_id, qualified_name) in cases {
            let param_id = declaration_id(
                DeclKind::Parameter,
                "a.ts",
                source.find(name).unwrap() as u32,
                name,
            );
            // The entity id is byte-identical to the target every reference
            // to this parameter already resolved to.
            assert!(
                resolved(&semantics).iter().any(|row| row.3 == param_id),
                "expected a resolved reference targeting {param_id}"
            );
            let entity = parameter_entity(&semantics, &param_id)
                .unwrap_or_else(|| panic!("expected a parameter entity for {param_id}"));
            assert_eq!(entity.category, "entity");
            assert_eq!(entity.kind, "jsts:entity_parameter");
            assert_eq!(entity.universal_kind, "core:parameter");
            assert_eq!(entity.body["name"], name);
            assert_eq!(entity.body["kind"], "parameter");
            assert_eq!(entity.body["parent_id"], parent_id);
            assert_eq!(entity.body["qualified_name"], qualified_name);

            // `contains` parent -> parameter is present, source matching
            // this same parent_id.
            let contains = parameter_contains(&semantics, &param_id)
                .unwrap_or_else(|| panic!("expected a contains row for {param_id}"));
            assert_eq!(contains.kind, "jsts:relation_contains");
            assert_eq!(contains.body["source_id"], parent_id);
            assert_eq!(contains.body["target_id"], param_id);
            assert_eq!(contains.body["classification"], "confirmed");
        }
    }

    #[test]
    fn unreferenced_parameter_produces_no_entity() {
        let source = "function outer(value) {\n  return 1;\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert!(
            semantics.parameter_entity_rows.is_empty(),
            "rows: {:?}",
            semantics.parameter_entity_rows
        );
        assert!(semantics.parameter_contains_rows.is_empty());
    }

    #[test]
    fn destructured_parameters_produce_no_entity_but_a_referenced_rest_parameter_does() {
        // A destructured parameter (`{ a, b }`) stays conservatively
        // unsupported -- `classify_symbol_declaration`'s `FormalParameter`
        // arm only ever resolves a simple `BindingIdentifier` pattern, same
        // as before this task. A REST parameter (`...rest`), however, is
        // the 2026-09-04 references-parity task's bucket-1 fix
        // (`classify_symbol_declaration`'s new `AstKind::FormalParameterRest`
        // arm + `visit_formal_parameter_rest`'s own fact recording): once
        // referenced (`rest.length`), it now gets exactly the same
        // "referenced-only" entity/contains-row treatment an ordinary
        // parameter already did.
        let source = "function outer({ a, b }, ...rest) {\n  return a + b + rest.length;\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let rest_id = declaration_id(
            DeclKind::Parameter,
            "a.ts",
            source.find("rest)").unwrap() as u32,
            "rest",
        );
        let entity = parameter_entity(&semantics, &rest_id).expect("rest parameter entity");
        assert_eq!(entity.body["name"], "rest");
        assert_eq!(entity.body["kind"], "parameter");
        assert_eq!(
            entity.body["parent_id"],
            declaration_id(
                DeclKind::Function,
                "a.ts",
                source.find("outer").unwrap() as u32,
                "outer"
            )
        );
        assert!(parameter_contains(&semantics, &rest_id).is_some());
        // Only ONE parameter entity total: the destructured `{ a, b }`
        // pattern still contributes nothing.
        assert_eq!(semantics.parameter_entity_rows.len(), 1);
        assert_eq!(semantics.parameter_contains_rows.len(), 1);
        let function_id = declaration_id(
            DeclKind::Function,
            "a.ts",
            source.find("outer").unwrap() as u32,
            "outer",
        );
        let reference_start = source.rfind("rest.length").unwrap() as u32;
        let rows = resolved(&semantics);
        assert!(
            rows.contains(&(
                reference_start,
                reference_start + "rest".len() as u32,
                function_id.as_str(),
                rest_id.as_str()
            )),
            "rows: {:?}",
            rows
        );
    }

    #[test]
    fn unreferenced_rest_parameter_produces_no_entity() {
        // Same "referenced-only" discipline an ordinary parameter already
        // has (see `unreferenced_parameter_produces_no_entity`): a rest
        // parameter that is never referenced in the body gets no entity at
        // all, even though `classify_symbol_declaration` now knows how to
        // classify it.
        let source = "function outer(...rest) {\n  return 0;\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert!(semantics.parameter_entity_rows.is_empty());
        assert!(semantics.parameter_contains_rows.is_empty());
    }

    #[test]
    fn referenced_catch_binding_resolves_and_materializes_a_variable_entity() {
        // 2026-09-04 references-parity task, bucket 1
        // (`unsupported_declaration_kind`, 92% of the bucket): `catch
        // (error) { ... }`'s own simple identifier binding, referenced in
        // the catch block body, now resolves through `classify_symbol_
        // declaration`'s new `AstKind::CatchParameter` arm (`DeclKind::
        // Variable`, matching v3's `isVariableDeclaration` treatment) and
        // materializes a `core:value` entity via `visit_catch_parameter`'s
        // "referenced-only" fact recording.
        let source = "function outer() {\n  try {\n    risky();\n  } catch (error) {\n    log(error.message);\n  }\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let catch_start = source.find("error) {").unwrap() as u32;
        let catch_id = declaration_id(DeclKind::Variable, "a.ts", catch_start, "error");
        let function_id = declaration_id(
            DeclKind::Function,
            "a.ts",
            source.find("outer").unwrap() as u32,
            "outer",
        );
        let rows = resolved(&semantics);
        let reference_start = source.rfind("error.message").unwrap() as u32;
        assert!(
            rows.contains(&(
                reference_start,
                reference_start + "error".len() as u32,
                function_id.as_str(),
                catch_id.as_str()
            )),
            "rows: {:?}",
            rows
        );
        let entity = parameter_entity(&semantics, &catch_id).expect("catch binding entity");
        assert_eq!(entity.body["name"], "error");
        assert_eq!(entity.body["kind"], "variable");
        assert_eq!(entity.body["parent_id"], function_id.as_str());
        assert!(parameter_contains(&semantics, &catch_id).is_some());
    }

    #[test]
    fn unreferenced_catch_binding_produces_no_entity() {
        let source =
            "function outer() {\n  try {\n    risky();\n  } catch (error) {\n    log();\n  }\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert!(semantics.parameter_entity_rows.is_empty());
        assert!(semantics.parameter_contains_rows.is_empty());
    }

    #[test]
    fn destructured_catch_binding_produces_no_entity_and_stays_pending() {
        // Same conservative rule as a destructured parameter: `catch ({
        // message }) {}` never resolves through `classify_symbol_
        // declaration` (`AstKind::CatchParameter`'s own pattern-shape guard
        // requires a plain `BindingIdentifier`), so a reference to
        // `message` inside the block stays `checker_pending` with the
        // ordinary `unsupported_declaration_kind` reason, and no entity is
        // recorded at all.
        let source = "function outer() {\n  try {\n    risky();\n  } catch ({ message }) {\n    log(message);\n  }\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert!(semantics.parameter_entity_rows.is_empty());
        assert!(semantics.parameter_contains_rows.is_empty());
        let reference_start = source.rfind("message)").unwrap() as u32;
        let site = semantics.pending_sites.iter().find(|site| {
            site.site_kind == SiteKind::IdentifierRef && site.start_utf16 == reference_start
        });
        assert_eq!(
            site.and_then(|site| site.reason.as_deref()),
            Some(REASON_UNSUPPORTED_DECLARATION_KIND),
            "sites: {:?}",
            semantics.pending_sites
        );
    }

    #[test]
    fn constructor_parameter_property_is_treated_like_any_other_identifier_parameter() {
        // `classify_symbol_declaration`'s own `FormalParameter` arm never
        // inspects `accessibility` -- a parameter property resolves to the
        // SAME target id a plain constructor parameter would (`return x`
        // inside the constructor body still produces a `core:references`
        // row to it). But since the 2026-09-04 references-parity task's
        // member-entities follow-up, the ENTITY itself is no longer
        // materialized here: `urdira_jsts_typeflow::member_declarations`
        // (via `push_member_entities` in lib.rs) owns every parameter
        // property UNCONDITIONALLY now, the same way it owns every other
        // class member, so this "referenced-only" producer deliberately
        // skips it (`visit_formal_parameter`'s own doc comment) to avoid
        // materializing the same declaration twice.
        let source = "class Point {\n  constructor(private x: number) {\n    return x;\n  }\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let param_id = declaration_id(
            DeclKind::Parameter,
            "a.ts",
            source.find("x:").unwrap() as u32,
            "x",
        );
        assert!(
            parameter_entity(&semantics, &param_id).is_none(),
            "a parameter property's entity now comes from `push_member_entities`, \
             never from this referenced-only producer"
        );
        assert!(
            parameter_contains(&semantics, &param_id).is_none(),
            "same for its `core:contains` row"
        );
        assert!(
            semantics
                .reference_rows
                .iter()
                .any(|record| record.body["target_id"] == param_id.as_str()),
            "`return x` must still resolve to the parameter property's canonical id"
        );
    }

    #[test]
    fn object_literal_shorthand_method_parameter_falls_back_to_the_module_entity() {
        // `member_declarations` (typeflow) never enumerates object literals,
        // so an object-literal shorthand method has no entity of its own
        // today -- its parameter's `parent_id` must fall back to the
        // module, never a dangling `jsts:method:...` id.
        let source = "const obj = {\n  method(value) {\n    return value;\n  },\n};\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let module_id = "jsts:module:a.ts:0:a.ts";
        let param_id = declaration_id(
            DeclKind::Parameter,
            "a.ts",
            source.find("value").unwrap() as u32,
            "value",
        );
        let entity = parameter_entity(&semantics, &param_id)
            .unwrap_or_else(|| panic!("expected a parameter entity for {param_id}"));
        assert_eq!(entity.body["parent_id"], module_id);
        assert_eq!(entity.body["qualified_name"], "a.ts.value");
        let contains = parameter_contains(&semantics, &param_id).expect("contains row present");
        assert_eq!(contains.body["source_id"], module_id);
    }

    #[test]
    fn anonymous_callback_parameter_falls_back_to_the_module_entity() {
        let source = concat!(
            "function invoke(callback) {\n",
            "  return callback();\n",
            "}\n",
            "invoke(function (value) {\n",
            "  return value;\n",
            "});\n",
        );
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let module_id = "jsts:module:a.ts:0:a.ts";
        let param_id = declaration_id(
            DeclKind::Parameter,
            "a.ts",
            source.find("value").unwrap() as u32,
            "value",
        );
        let entity = parameter_entity(&semantics, &param_id)
            .unwrap_or_else(|| panic!("expected a parameter entity for {param_id}"));
        assert_eq!(entity.body["parent_id"], module_id);
        assert_eq!(entity.body["qualified_name"], "a.ts.value");

        // `invoke`'s own referenced parameter, by contrast, DOES have an
        // owner (the function declaration).
        let invoke_id = declaration_id(
            DeclKind::Function,
            "a.ts",
            source.find("invoke").unwrap() as u32,
            "invoke",
        );
        let callback_id = declaration_id(
            DeclKind::Parameter,
            "a.ts",
            source.find("callback").unwrap() as u32,
            "callback",
        );
        let callback_entity = parameter_entity(&semantics, &callback_id)
            .unwrap_or_else(|| panic!("expected a parameter entity for {callback_id}"));
        assert_eq!(callback_entity.body["parent_id"], invoke_id.as_str());
    }

    // -- 2026-09-04 external package/symbol entities task ---------------

    fn find_entity<'a>(
        semantics: &'a OwnerSemantics,
        identity_key: &str,
    ) -> Option<&'a ProposedRecord> {
        semantics
            .external_entity_rows
            .iter()
            .find(|record| record.identity_key == identity_key)
    }

    #[test]
    fn external_named_import_resolves_to_external_symbol_reference_and_entities() {
        let ctx = helper_ctx(BTreeMap::new());
        let source = "import { get } from \"lodash\";\nget(1);\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        let target_id = "jsts:external_symbol:lodash#get";
        let local_start = source.find("{ get }").unwrap() as u32 + 2;
        assert!(
            semantics
                .pending_sites
                .iter()
                .all(|site| site.start_utf16 != local_start),
            "the import specifier's local binding must not stay pending once resolved as external"
        );
        let rows = resolved(&semantics);
        assert!(
            rows.iter()
                .any(|row| row.2 == "jsts:module:a.ts:0:a.ts" && row.3 == target_id),
            "expected an import-site reference row to {target_id}, got {rows:?}"
        );
        assert!(
            rows.iter().any(|row| row.3 == target_id)
                && rows.iter().filter(|row| row.3 == target_id).count() >= 2,
            "expected both the import-site AND usage-site (`get(1)`) reference rows to {target_id}, got {rows:?}"
        );
        let module_entity =
            find_entity(&semantics, "jsts:external_module:lodash").expect("module entity present");
        assert_eq!(module_entity.kind, "jsts:entity_container");
        assert_eq!(module_entity.universal_kind, "core:container");
        assert_eq!(module_entity.body["name"], "lodash");
        let symbol_entity = find_entity(&semantics, target_id).expect("symbol entity present");
        assert_eq!(symbol_entity.kind, "jsts:entity_variable");
        assert_eq!(symbol_entity.universal_kind, "core:value");
        assert_eq!(symbol_entity.body["name"], "get");
        assert_eq!(
            symbol_entity.body["parent_id"],
            "jsts:external_module:lodash"
        );
        assert_eq!(symbol_entity.body["qualified_name"], "lodash.get");
        assert!(
            semantics
                .external_contains_rows
                .iter()
                .any(|row| row.body["source_id"] == "jsts:external_module:lodash"
                    && row.body["target_id"] == target_id),
            "expected a core:contains row from the module to the symbol"
        );
    }

    #[test]
    fn external_default_import_resolves_to_hash_default_symbol() {
        let ctx = helper_ctx(BTreeMap::new());
        let source = "import express from \"express\";\nexpress();\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        let target_id = "jsts:external_symbol:express#default";
        let rows = resolved(&semantics);
        assert!(
            rows.iter().any(|row| row.3 == target_id),
            "expected a reference row to {target_id}, got {rows:?}"
        );
        find_entity(&semantics, target_id).expect("default symbol entity present");
    }

    #[test]
    fn external_namespace_import_used_as_value_resolves_to_hash_star_symbol() {
        let ctx = helper_ctx(BTreeMap::new());
        let source =
            "import * as _ from \"lodash\";\nfunction use(fn) { return fn(_); }\nuse(_);\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        let target_id = "jsts:external_symbol:lodash#*";
        let rows = resolved(&semantics);
        assert!(
            rows.iter().any(|row| row.3 == target_id),
            "expected a reference row to {target_id}, got {rows:?}"
        );
        find_entity(&semantics, target_id).expect("namespace symbol entity present");
    }

    #[test]
    fn external_namespace_member_read_resolves_to_symbol_and_emits_entity() {
        // Item 2's explicit example: `import * as _ from "lodash"; _.get(...)`
        // -- a MEMBER read (not the namespace binding itself), resolved via
        // `resolve_external_namespace_member`/`visit_static_member_expression`,
        // not `import_bindings`.
        let ctx = helper_ctx(BTreeMap::new());
        let source = "import * as _ from \"lodash\";\n_.get(1, 2);\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        let target_id = "jsts:external_symbol:lodash#get";
        let rows = resolved(&semantics);
        assert!(
            rows.iter().any(|row| row.3 == target_id),
            "expected a member-read reference row to {target_id}, got {rows:?}"
        );
        let member_start = source.rfind("get").unwrap() as u32;
        assert!(
            semantics
                .pending_sites
                .iter()
                .all(|site| site.start_utf16 != member_start),
            "the member-read site must not stay pending once resolved externally"
        );
        find_entity(&semantics, target_id).expect("member symbol entity present");
        find_entity(&semantics, "jsts:external_module:lodash").expect("module entity present");
    }

    #[test]
    fn external_scoped_package_with_subpath_keeps_full_specifier_identity() {
        let ctx = helper_ctx(BTreeMap::new());
        let source =
            "import { HumanMessage } from \"@langchain/core/messages\";\nnew HumanMessage();\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        // The identity keeps the FULL specifier, subpath included -- never
        // collapsed to the package root `@langchain/core`.
        find_entity(&semantics, "jsts:external_module:@langchain/core/messages")
            .expect("module entity keyed by the full subpath");
        let rows = resolved(&semantics);
        assert!(
            rows.iter()
                .any(|row| row.3 == "jsts:external_symbol:@langchain/core/messages#HumanMessage"),
            "expected a reference row scoped to the full subpath specifier, got {rows:?}"
        );
    }

    #[test]
    fn external_node_builtin_bare_specifier_normalizes_to_node_prefix() {
        let ctx = helper_ctx(BTreeMap::new());
        let source = "import { readFile } from \"fs\";\nreadFile(\"x\");\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        find_entity(&semantics, "jsts:external_module:node:fs")
            .expect("bare `fs` normalizes to `node:fs`");
        let rows = resolved(&semantics);
        assert!(
            rows.iter()
                .any(|row| row.3 == "jsts:external_symbol:node:fs#readFile"),
            "expected a reference row under the normalized node:fs identity, got {rows:?}"
        );
    }

    #[test]
    fn external_type_only_import_gets_core_type_symbol() {
        let ctx = helper_ctx(BTreeMap::new());
        let source = "import type { Foo } from \"pkg\";\nlet x: Foo;\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        let symbol =
            find_entity(&semantics, "jsts:external_symbol:pkg#Foo").expect("type symbol entity");
        assert_eq!(
            symbol.universal_kind, "core:type",
            "an `import type` binding gets a core:type external symbol, not core:value"
        );
        assert_eq!(symbol.kind, "jsts:entity_type");
    }

    #[test]
    fn external_reexport_named_specifier_resolves_to_external_symbol() {
        let ctx = helper_ctx(BTreeMap::new());
        let source = "export { get } from \"lodash\";\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        let target_id = "jsts:external_symbol:lodash#get";
        let local_start = source.find("get }").unwrap() as u32;
        assert!(
            semantics
                .pending_sites
                .iter()
                .all(|site| site.start_utf16 != local_start),
            "the re-export specifier's local position must not stay pending once resolved externally"
        );
        let rows = resolved(&semantics);
        assert!(
            rows.iter().any(|row| row.3 == target_id),
            "expected a reference row from the re-export to {target_id}, got {rows:?}"
        );
        find_entity(&semantics, target_id).expect("symbol entity present for the re-export");
    }

    #[test]
    fn relative_import_that_fails_to_resolve_does_not_become_external() {
        let ctx = helper_ctx(BTreeMap::new());
        let source = "import { helper } from \"./missing\";\nhelper();\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(
            semantics.external_entity_rows.is_empty(),
            "a relative specifier that merely failed to resolve must never become an external entity: {:?}",
            semantics.external_entity_rows
        );
        assert!(
            semantics.external_contains_rows.is_empty(),
            "no external contains rows either: {:?}",
            semantics.external_contains_rows
        );
        assert!(
            semantics.pending_sites.iter().any(|site| site
                .reason
                .as_deref()
                .is_some_and(|reason| reason.starts_with(REASON_IMPORT_BINDING))),
            "must still degrade to the ordinary pending import-binding reason"
        );
    }

    #[test]
    fn absolute_specifier_that_fails_to_resolve_does_not_become_external() {
        let ctx = helper_ctx(BTreeMap::new());
        let source = "import { helper } from \"/abs/missing\";\nhelper();\n";
        let semantics =
            analyze_owner_semantics_with_context("a.ts", source, &ctx).expect("analysis succeeds");
        assert!(
            semantics.external_entity_rows.is_empty(),
            "an absolute specifier that merely failed to resolve must never become external: {:?}",
            semantics.external_entity_rows
        );
    }

    #[test]
    fn two_owners_importing_the_same_external_specifier_propose_byte_identical_entities() {
        // Prerequisite for `urdira-indexing-worker::v4::analyze::run_scoped`'s
        // cross-owner dedup pass: two DIFFERENT owner files importing the
        // SAME external specifier must produce byte-identical entity
        // `ProposedRecord`s (same identity_key, same body, same everything)
        // so the dedup pass can safely keep just one.
        let ctx = helper_ctx(BTreeMap::new());
        let semantics_a = analyze_owner_semantics_with_context(
            "a.ts",
            "import { get } from \"lodash\";\nget(1);\n",
            &ctx,
        )
        .expect("analysis succeeds");
        let semantics_b = analyze_owner_semantics_with_context(
            "b.ts",
            "import { get } from \"lodash\";\nget(2);\n",
            &ctx,
        )
        .expect("analysis succeeds");
        let module_a = find_entity(&semantics_a, "jsts:external_module:lodash")
            .expect("module entity in a.ts");
        let module_b = find_entity(&semantics_b, "jsts:external_module:lodash")
            .expect("module entity in b.ts");
        assert_eq!(
            module_a, module_b,
            "module entity must be byte-identical across owners"
        );
        let symbol_a = find_entity(&semantics_a, "jsts:external_symbol:lodash#get")
            .expect("symbol entity in a.ts");
        let symbol_b = find_entity(&semantics_b, "jsts:external_symbol:lodash#get")
            .expect("symbol entity in b.ts");
        assert_eq!(
            symbol_a, symbol_b,
            "symbol entity must be byte-identical across owners"
        );
    }
}
