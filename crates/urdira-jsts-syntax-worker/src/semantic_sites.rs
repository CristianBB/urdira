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
    BindingPattern, CallExpression, ChainElement, Class, ClassType, ComputedMemberExpression,
    ExportSpecifier, Expression, FormalParameter, Function, FunctionType, IdentifierReference,
    ImportDeclaration, ImportDefaultSpecifier, ImportExpression, ImportNamespaceSpecifier,
    ImportSpecifier, MethodDefinition, MethodDefinitionKind, ModuleExportName, ObjectPattern,
    ObjectProperty, PropertyDefinition, PropertyKey, PropertyKind, StaticMemberExpression,
    TSEnumDeclaration, TSInterfaceDeclaration, TSMethodSignature, TSMethodSignatureKind,
    TSModuleDeclaration, TSQualifiedName, TSSignature, TSType, TSTypeAliasDeclaration,
    TSTypeAnnotation, TSTypeName, TSTypePredicate, TSTypePredicateName, TSTypeQueryExprName,
    ThisExpression, VariableDeclarator,
};
use oxc_ast_visit::{
    Visit,
    utf8_to_utf16::Utf8ToUtf16,
    walk::{
        walk_call_expression, walk_class, walk_export_specifier, walk_formal_parameter,
        walk_function, walk_import_declaration, walk_import_default_specifier,
        walk_import_expression, walk_import_namespace_specifier, walk_import_specifier,
        walk_object_property, walk_property_definition, walk_static_member_expression,
        walk_ts_enum_declaration, walk_ts_interface_declaration, walk_ts_method_signature,
        walk_ts_module_declaration, walk_ts_qualified_name, walk_ts_type_alias_declaration,
        walk_ts_type_predicate, walk_variable_declarator,
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
    /// P2-2i: v4 parity fix for the gap decision 28 documents -- v3's
    /// checker-backed `relate()` always publishes a `classification:
    /// "possible"` `core:call` row (plus a paired `jsts:unresolved_call`
    /// diagnostic) for a call site with no resolved declaration; v4's
    /// checker-free pipeline published nothing at all for such a site
    /// before this field existed. One `possible` relation record
    /// immediately followed by its paired diagnostic record, per pending
    /// call site (see `possible_call_record`/`unresolved_call_diagnostic_
    /// record`'s doc comments for the exact body shapes -- built
    /// byte-for-byte to the shape `fact-delta.ts`'s `proposalRelationRecord`/
    /// `proposalDiagnosticRecord` produce for the checker-resolved
    /// equivalent, plus a new `reason` field on the diagnostic that v3
    /// never carried). Empty whenever this owner had no pending call site
    /// (or none with a resolvable `source_id` -- `current_owner()` always
    /// succeeds, so in practice this is simply "no pending call sites").
    pub possible_call_rows: Vec<ProposedRecord>,
    /// P2-2i: same parity fix as `possible_call_rows`, for heritage clauses
    /// (`core:inherits`/`core:implements`, `classification: "possible"`).
    /// No paired diagnostic (v3 never emits one for a heritage clause
    /// either). Excludes a clause whose enclosing declaration has no entity
    /// of its own (an anonymous class -- see `finish_heritage_clause`'s doc
    /// comment), the one case where no `source_id` exists to build a row
    /// from; that clause's site stays in `pending_sites` with no possible
    /// row, same gap v3's own `entityForDeclaration` would hit.
    pub possible_heritage_rows: Vec<ProposedRecord>,
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

/// Pending reasons. These are the exhaustive set of reasons E1a can attach
/// to a `checker_pending` site.
const REASON_UNRESOLVED_GLOBAL: &str = "unresolved_global";
const REASON_IMPORT_BINDING: &str = "import_binding";
const REASON_MULTIPLE_DECLARATIONS: &str = "multiple_declarations";
const REASON_UNSUPPORTED_DECLARATION_KIND: &str = "unsupported_declaration_kind";
const REASON_MEMBER_ACCESS: &str = "member_access";
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
/// E1a/E3 already attached to it. Turned into a `possible` `core:call` row
/// plus a `jsts:unresolved_call` diagnostic by `unresolved_call_diagnostic`/
/// `possible_call_record` in `finish`.
struct PendingCallSite {
    start: u32,
    end: u32,
    source_id: String,
    reason: &'static str,
}

/// P2-2i: one heritage clause entry that stayed `checker_pending` with a
/// real enclosing declaration to attribute it to. `relation_kind` is
/// `"inherits"` or `"implements"`, same convention as `HeritageRow`.
struct PendingHeritageSite {
    start: u32,
    end: u32,
    source_id: String,
    relation_kind: &'static str,
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
    /// possible_call_rows`'s doc comment for the exact contract.
    pending_call_sites: Vec<PendingCallSite>,
    /// P2-2i: every heritage clause entry that stayed `checker_pending` with
    /// a real enclosing declaration to attribute it to (`self_id` present --
    /// see `finish_heritage_clause`'s doc comment for the one case this
    /// deliberately excludes). Mirrors `analyzer.ts`'s own
    /// `relate("inherits"|"implements", relationSource, undefined, type,
    /// "possible")`.
    pending_heritage_sites: Vec<PendingHeritageSite>,
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
            typeflow_oracle_hits: Vec::new(),
            typeflow_pending_call_shapes: Vec::new(),
            class_stack: Vec::new(),
            static_context: Vec::new(),
            local_types: HashMap::new(),
            destructured_member_entities: HashMap::new(),
            jsdoc_typed_file,
            ctx,
            current_import_source: None,
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
    fn resolve_import_binding(&self, imported_name: &str) -> ReferenceResolution {
        if self.jsdoc_typed_file {
            return ReferenceResolution::Pending(REASON_JSDOC_TYPED_FILE);
        }
        let Some(source_specifier) = &self.current_import_source else {
            return ReferenceResolution::Pending(REASON_IMPORT_BINDING);
        };
        let Some(target_path) =
            self.ctx
                .resolver
                .resolve(&self.path, source_specifier, self.ctx.available)
        else {
            return ReferenceResolution::Pending(REASON_IMPORT_BINDING);
        };
        match resolver::resolve_named_export(self.ctx.files, &target_path, imported_name) {
            resolver::ExportResolution::Resolved(target_id) => {
                // The declaration was reached through an import specifier,
                // possibly after chasing one or more named re-exports
                // (`resolve_named_export`): it lives outside `self.path` in
                // every non-pathological case (a file re-exporting a name
                // back to itself through another module is not a pattern
                // real code hits in practice, and is not worth a full
                // target-path plumb-through to rule out here -- see
                // `ReferenceRow::cross_file`'s doc comment).
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
            resolver::ExportResolution::Namespace(_)
            | resolver::ExportResolution::Ambiguous
            | resolver::ExportResolution::Unresolved => {
                ReferenceResolution::Pending(REASON_IMPORT_BINDING)
            }
        }
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
            TypeflowValue::Entity { .. }
            | TypeflowValue::PromiseOf(_)
            | TypeflowValue::Inline(_) => None,
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
    /// chained-call calls): `Some(target_id)` only when the callee is
    /// `<base>.<member>` AND `type_of_expression` resolves `<base>` to a
    /// concrete entity AND `ProgramIndex::members` finds EXACTLY ONE
    /// matching member -- a union (`MemberLookup::Many`) or a miss stays
    /// pending, never a guess.
    fn resolve_call_target_typeflow(
        &self,
        expr: &CallExpression<'a>,
    ) -> Option<(String, &'static str)> {
        let index = self.ctx.typeflow_index?;
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
            let reference_id = ident.reference_id.get()?;
            let reference = self.scoping.get_reference(reference_id);
            let symbol_id = reference.symbol_id()?;
            let target_id = self.destructured_member_entities.get(&symbol_id)?.clone();
            return Some((target_id, "destructured_method_call"));
        }
        let Expression::StaticMemberExpression(member) = &expr.callee else {
            return None;
        };
        if let Some((base_value, rule)) = self.type_of_expression(&member.object)
            && let Some((base_entity, is_static)) = Self::as_entity(&base_value)
            && let urdira_jsts_typeflow::MemberLookup::One(target) =
                index.members(&base_entity, member.property.name.as_str(), is_static)
        {
            return Some((target, rule));
        }
        // P1-A (rule (f)): `ns.fn(...)` as the call ITSELF (not merely a
        // chain receiver) -- see `resolve_namespace_member`'s doc comment.
        // Restricted to `Function` (never `Class`/`Method`/...) to match
        // `resolve_call_target`'s own T1 scope exactly.
        let target_id =
            self.resolve_namespace_member(&member.object, member.property.name.as_str())?;
        target_id_kind_is_one_of(&target_id, &[DeclKind::Function])
            .then_some((target_id, "namespace_member_call"))
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
        // P2-2i: one `possible` `core:call` row immediately followed by its
        // paired `jsts:unresolved_call` diagnostic, per `PendingCallSite`, in
        // sorted order -- see `possible_call_rows`'s own doc comment for why
        // the two live in one field.
        let possible_call_rows = self
            .pending_call_sites
            .iter()
            .enumerate()
            .flat_map(|(index, site)| {
                [
                    possible_call_record(&self.path, site),
                    unresolved_call_diagnostic_record(&self.path, site, index),
                ]
            })
            .collect();
        let possible_heritage_rows = self
            .pending_heritage_sites
            .iter()
            .map(|site| possible_heritage_record(&self.path, site))
            .collect();
        OwnerSemantics {
            reference_rows,
            covers_rows,
            call_rows,
            heritage_rows,
            typeflow_call_rows,
            typeflow_heritage_rows,
            possible_call_rows,
            possible_heritage_rows,
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

/// `core:call` proposed record, `classification: "possible"`, for one
/// `PendingCallSite` -- byte-for-byte identical, for the equivalent
/// checker-resolved case, to the record `fact-delta.ts`'s
/// `proposalRelationRecord` produces from `analyzer.ts`'s `relate("call",
/// relationSource, undefined, node, "possible")`: identity_key
/// `jsts:call:{path}:{start}:{end}:{source_id}:unresolved` (mirrors
/// `target?.id ?? "unresolved"` with `target` always `undefined` here), NO
/// `target_id` key in `body` at all (`...(target === undefined ? {} :
/// { target_id: target.id })`), facets gain `"core:indirect"`
/// (`fact-delta.ts`'s `relation.classification === "possible" ?
/// ["core:indirect"] : []`).
fn possible_call_record(path: &str, site: &PendingCallSite) -> ProposedRecord {
    let identity_key = format!(
        "jsts:call:{path}:{}:{}:{}:unresolved",
        site.start, site.end, site.source_id
    );
    let mut body = serde_json::Map::new();
    body.insert(
        "source_id".into(),
        serde_json::Value::String(site.source_id.clone()),
    );
    body.insert(
        "classification".into(),
        serde_json::Value::String("possible".into()),
    );
    body.insert("path".into(), serde_json::Value::String(path.to_owned()));
    body.insert("start".into(), serde_json::Value::from(site.start));
    body.insert("end".into(), serde_json::Value::from(site.end));
    let facets = serde_json::json!(["core:reference_relation", "core:indirect"]);
    ProposedRecord {
        proposal_record_key: proposal_record_key(&identity_key),
        category: "relation",
        kind: "jsts:relation_call".to_owned(),
        universal_kind: "core:call".to_owned(),
        facets_list: facets_list_from_value(&facets),
        facets: canonical_json(&facets),
        schema_version: 1,
        source_span: canonical_span(path, site.start, site.end),
        identity_key,
        body: serde_json::Value::Object(body),
        evidence_references: canonical_evidence(path, site.start, site.end),
    }
}

/// `jsts:unresolved_call` diagnostic proposed record, paired 1:1 with
/// `possible_call_record` for the same `PendingCallSite` -- v3's own
/// `diagnostics.push({ code: "jsts:unresolved_call", message: "...", path,
/// start, end })` in `analyzer.ts`, plus a NEW `reason` field (this task's
/// own extension: v3 never carried one, since a human/agent reading the
/// diagnostic could cross-reference the checker's own richer context; v4
/// has no checker, so the pending site's own reason is the only signal
/// available and is surfaced here instead of silently lost -- registered
/// in `registry-contribution.ts`'s `diagnosticPayload`).
///
/// v3 only emits this diagnostic when the checker found NO declaration at
/// all (`target === undefined && !declarationWasResolved`); v4 has no
/// checker to draw that finer distinction -- a `PendingCallSite` is BY
/// CONSTRUCTION a call Rust never resolved to any declaration (E1-E3 and
/// typeflow both gave up), so v4 emits this diagnostic for every pending
/// call site unconditionally. This is a documented simplification (see
/// this task's evidence doc), not a behavioral claim that every such site
/// would ALSO fail a real checker's own resolution.
///
/// `index` disambiguates identity keys the same way `fact-delta.ts`'s
/// `proposalDiagnosticRecord`'s own `index` parameter does for v3 (both are
/// simply "this diagnostic's position in a same-shaped list for this
/// owner", not required to match v3's own numbering, which spans every
/// diagnostic kind, not just this one).
fn unresolved_call_diagnostic_record(
    path: &str,
    site: &PendingCallSite,
    index: usize,
) -> ProposedRecord {
    let key = format!(
        "jsts:diagnostic:{path}:{}:jsts:unresolved_call:{index}",
        site.start
    );
    let mut body = serde_json::Map::new();
    body.insert(
        "code".into(),
        serde_json::Value::String("jsts:unresolved_call".into()),
    );
    body.insert(
        "message".into(),
        serde_json::Value::String(
            "The TypeScript checker could not establish a unique call target.".into(),
        ),
    );
    body.insert("path".into(), serde_json::Value::String(path.to_owned()));
    body.insert("start".into(), serde_json::Value::from(site.start));
    body.insert("end".into(), serde_json::Value::from(site.end));
    body.insert(
        "reason".into(),
        serde_json::Value::String(site.reason.to_owned()),
    );
    let facets = serde_json::json!([]);
    ProposedRecord {
        proposal_record_key: proposal_record_key(&key),
        category: "diagnostic",
        kind: "jsts:diagnostic".to_owned(),
        universal_kind: "core:construct".to_owned(),
        facets_list: facets_list_from_value(&facets),
        facets: canonical_json(&facets),
        schema_version: 1,
        source_span: canonical_span(path, site.start, site.end),
        identity_key: key,
        body: serde_json::Value::Object(body),
        evidence_references: canonical_evidence(path, site.start, site.end),
    }
}

/// `core:inherits`/`core:implements` proposed record, `classification:
/// "possible"`, for one `PendingHeritageSite` -- mirrors `possible_call_
/// record` above for the heritage case (`analyzer.ts`'s own
/// `relate("inherits"|"implements", relationSource, undefined, type,
/// "possible")`). No paired diagnostic: v3 never emits one for a heritage
/// clause either (only the call branch of `visit` in `analyzer.ts` ever
/// pushes to `diagnostics`).
fn possible_heritage_record(path: &str, site: &PendingHeritageSite) -> ProposedRecord {
    let identity_key = format!(
        "jsts:{}:{path}:{}:{}:{}:unresolved",
        site.relation_kind, site.start, site.end, site.source_id
    );
    let mut body = serde_json::Map::new();
    body.insert(
        "source_id".into(),
        serde_json::Value::String(site.source_id.clone()),
    );
    body.insert(
        "classification".into(),
        serde_json::Value::String("possible".into()),
    );
    body.insert("path".into(), serde_json::Value::String(path.to_owned()));
    body.insert("start".into(), serde_json::Value::from(site.start));
    body.insert("end".into(), serde_json::Value::from(site.end));
    let facets = serde_json::json!(["core:reference_relation", "core:indirect"]);
    ProposedRecord {
        proposal_record_key: proposal_record_key(&identity_key),
        category: "relation",
        kind: format!("jsts:relation_{}", site.relation_kind),
        universal_kind: format!("core:{}", site.relation_kind),
        facets_list: facets_list_from_value(&facets),
        facets: canonical_json(&facets),
        schema_version: 1,
        source_span: canonical_span(path, site.start, site.end),
        identity_key,
        body: serde_json::Value::Object(body),
        evidence_references: canonical_evidence(path, site.start, site.end),
    }
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
        let resolution = imported_name
            .as_deref()
            .map(|name| self.resolve_import_binding(name))
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
        walk_import_declaration(self, declaration);
        self.current_import_source = previous;
    }

    /// See `visit_import_specifier`: `local` in `import local from "m"`.
    fn visit_import_default_specifier(&mut self, specifier: &ImportDefaultSpecifier<'a>) {
        self.push_site(
            SiteKind::IdentifierRef,
            specifier.local.span.start,
            specifier.local.span.end,
            SiteDisposition::CheckerPending,
            Some(self.identifier_pending_reason(REASON_IMPORT_BINDING)),
        );
        walk_import_default_specifier(self, specifier);
    }

    /// See `visit_import_specifier`: `local` in `import * as local from "m"`.
    fn visit_import_namespace_specifier(&mut self, specifier: &ImportNamespaceSpecifier<'a>) {
        self.push_site(
            SiteKind::IdentifierRef,
            specifier.local.span.start,
            specifier.local.span.end,
            SiteDisposition::CheckerPending,
            Some(self.identifier_pending_reason(REASON_IMPORT_BINDING)),
        );
        // P1-A (rule (f)): record `ns`'s own specifier for `resolve_
        // namespace_member`'s later `ns.member(...)` lookups -- see
        // `namespace_import_specifiers`'s doc comment.
        if let (Some(symbol_id), Some(source)) =
            (specifier.local.symbol_id.get(), &self.current_import_source)
        {
            self.namespace_import_specifiers
                .insert(symbol_id, source.clone());
        }
        walk_import_namespace_specifier(self, specifier);
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
    fn visit_export_specifier(&mut self, specifier: &ExportSpecifier<'a>) {
        let local_span = specifier.local.span();
        if let ModuleExportName::IdentifierName(name) = &specifier.local {
            self.push_site(
                SiteKind::IdentifierRef,
                name.span.start,
                name.span.end,
                SiteDisposition::CheckerPending,
                Some(self.identifier_pending_reason(REASON_RE_EXPORT_BINDING)),
            );
        }
        if let ModuleExportName::IdentifierName(name) = &specifier.exported
            && name.span != local_span
        {
            self.push_site(
                SiteKind::IdentifierRef,
                name.span.start,
                name.span.end,
                SiteDisposition::CheckerPending,
                Some(self.identifier_pending_reason(REASON_RE_EXPORT_BINDING)),
            );
        }
        walk_export_specifier(self, specifier);
    }

    fn visit_static_member_expression(&mut self, expr: &StaticMemberExpression<'a>) {
        self.push_site(
            SiteKind::IdentifierRef,
            expr.property.span.start,
            expr.property.span.end,
            SiteDisposition::CheckerPending,
            Some(self.identifier_pending_reason(REASON_MEMBER_ACCESS)),
        );
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
    fn visit_ts_type_predicate(&mut self, predicate: &TSTypePredicate<'a>) {
        if let TSTypePredicateName::Identifier(name) = &predicate.parameter_name {
            self.push_site(
                SiteKind::IdentifierRef,
                name.span.start,
                name.span.end,
                SiteDisposition::CheckerPending,
                Some(self.identifier_pending_reason(REASON_TYPE_PREDICATE_PARAMETER)),
            );
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
                match self.resolve_call_target_typeflow(expr) {
                    Some((target_id, rule)) if self.ctx.typeflow_oracle => {
                        let source_id = self.current_owner();
                        self.typeflow_oracle_hits.push(TypeflowOracleHit {
                            start,
                            end,
                            edge_kind: "call",
                            rule,
                            source_id: source_id.clone(),
                            target_id,
                        });
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
                            source_id,
                            reason,
                        });
                    }
                    Some((target_id, _rule)) => {
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
                    None => {
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
        let pushed = matches!(
            function.r#type,
            FunctionType::FunctionDeclaration | FunctionType::TSDeclareFunction
        ) && function.id.is_some();
        if pushed {
            let ident = function.id.as_ref().expect("checked above");
            let id = declaration_id(
                DeclKind::Function,
                &self.path,
                ident.span.start,
                ident.name.as_str(),
            );
            self.callable_stack.push(id);
            self.push_site(
                SiteKind::TypedDecl,
                function.span.start,
                function.span.end,
                SiteDisposition::CheckerPending,
                Some(REASON_TYPE_INFERENCE_REQUIRED),
            );
        }
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
        if pushed {
            self.callable_stack.pop();
        }
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
            self.callable_stack.push(id);
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
        walk_function(self, &method.value, flags);
        self.static_context.pop();
        if pushed {
            self.callable_stack.pop();
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
        walk_ts_method_signature(self, signature);
        if pushed {
            self.callable_stack.pop();
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
        if matches!(&parameter.pattern, BindingPattern::BindingIdentifier(_)) {
            self.push_site(
                SiteKind::TypedDecl,
                parameter.span.start,
                parameter.span.end,
                SiteDisposition::CheckerPending,
                Some(REASON_TYPE_INFERENCE_REQUIRED),
            );
        }
        self.record_local_type(
            &parameter.pattern,
            parameter.type_annotation.as_deref(),
            None,
        );
        walk_formal_parameter(self, parameter);
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
    let ctx = HybridResolutionContext {
        resolver: &resolver,
        available: &available,
        files: &files,
        typeflow_index: None,
        typeflow_oracle: false,
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
    let mut walker = SemanticWalker::new(
        path,
        semantic.scoping(),
        semantic.nodes(),
        jsdoc_typed_file,
        ctx,
    );
    walker.visit_program(&parsed.program);
    Ok(walker.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

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
            reasons.contains(&REASON_IMPORT_BINDING),
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
                    && site.reason.as_deref() == Some(REASON_IMPORT_BINDING)
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
                        && site.reason.as_deref() == Some(REASON_IMPORT_BINDING)
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
    fn marks_type_predicate_parameter_name_pending() {
        let source = "function isFoo(value: unknown): value is { kind: \"foo\" } {\n  return typeof value === \"object\";\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let predicate_name_start = source.find("value is").unwrap() as u32;
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
    fn marks_asserts_predicate_parameter_name_pending() {
        let source = "function assertFoo(value: unknown): asserts value is string {\n  if (typeof value !== \"string\") throw new Error();\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let predicate_name_start = source.find("value is string").unwrap() as u32;
        let site = semantics.pending_sites.iter().find(|site| {
            site.site_kind == SiteKind::IdentifierRef && site.start_utf16 == predicate_name_start
        });
        assert_eq!(
            site.and_then(|site| site.reason.as_deref()),
            Some(REASON_TYPE_PREDICATE_PARAMETER)
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
        assert_eq!(
            site.and_then(|site| site.reason.as_deref()),
            Some(REASON_RE_EXPORT_BINDING),
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
                    && site.reason.as_deref() == Some(REASON_RE_EXPORT_BINDING)
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
            !semantics
                .pending_sites
                .iter()
                .any(|site| site.reason.as_deref() == Some(REASON_RE_EXPORT_BINDING)),
            "sites: {:?}",
            semantics.pending_sites
        );
    }

    #[test]
    fn sourceless_aliased_export_of_a_variable_marks_the_alias_half_pending() {
        // The real-world shape this reconciliation gate caught: no `from`
        // clause, but the checker still resolves the alias (`bar`) straight
        // through to the original `const` declaration -- the same shape
        // over a `function` declaration instead resolves neither half (a
        // real checker inconsistency, deliberately not replicated: siting
        // `exported` unconditionally, per `visit_export_specifier`'s doc
        // comment, is correct either way -- pending just means "the checker
        // may resolve this," never "it definitely will").
        let source = "const foo = 1;\nexport { foo as bar };\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let alias_start = source.rfind("bar").unwrap() as u32;
        assert!(
            semantics
                .pending_sites
                .iter()
                .any(|site| site.site_kind == SiteKind::IdentifierRef
                    && site.start_utf16 == alias_start
                    && site.reason.as_deref() == Some(REASON_RE_EXPORT_BINDING)),
            "sites: {:?}",
            semantics.pending_sites
        );
    }

    #[test]
    fn marks_static_member_access_pending() {
        let source = "function use(target) {\n  return target.value;\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        let member_sites: Vec<&SemanticSite> = semantics
            .pending_sites
            .iter()
            .filter(|site| site.reason.as_deref() == Some(REASON_MEMBER_ACCESS))
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

    /// P2-2i: every pending `Call` site (member/`this`/`super` callee here)
    /// gets a `classification: "possible"` `core:call` row -- no `target_id`
    /// key at all, `"core:indirect"` in its facets -- immediately followed
    /// by a paired `jsts:unresolved_call` diagnostic carrying the site's own
    /// `reason`. Mirrors `analyzer.ts`'s `relate("call", relationSource,
    /// undefined, node, "possible")` + `jsts:unresolved_call` push.
    #[test]
    fn pending_call_sites_produce_possible_rows_and_paired_diagnostics() {
        let source = "function run() {\n  this.greet();\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert_eq!(
            semantics.possible_call_rows.len(),
            2,
            "one possible relation + one paired diagnostic: {:?}",
            semantics.possible_call_rows
        );
        let relation = &semantics.possible_call_rows[0];
        assert_eq!(relation.category, "relation");
        assert_eq!(relation.kind, "jsts:relation_call");
        assert_eq!(relation.universal_kind, "core:call");
        assert_eq!(relation.body["classification"], "possible");
        assert!(
            relation.body.get("target_id").is_none(),
            "a possible call row must carry no target_id key at all: {:?}",
            relation.body
        );
        assert!(relation.identity_key.ends_with(":unresolved"));
        assert!(
            relation.facets.contains("core:indirect"),
            "facets: {}",
            relation.facets
        );
        assert!(
            relation.facets.contains("core:reference_relation"),
            "facets: {}",
            relation.facets
        );

        let diagnostic = &semantics.possible_call_rows[1];
        assert_eq!(diagnostic.category, "diagnostic");
        assert_eq!(diagnostic.kind, "jsts:diagnostic");
        assert_eq!(diagnostic.universal_kind, "core:construct");
        assert_eq!(diagnostic.body["code"], "jsts:unresolved_call");
        assert_eq!(diagnostic.body["reason"], REASON_CALL_DEFERRED);
        assert_eq!(diagnostic.body["path"], "a.ts");
    }

    /// P2-2i: `import("./x")` is not a `CallExpression` (see
    /// `marks_dynamic_import_expression_pending_as_a_call_site` above) but
    /// still gets the same possible-row + diagnostic treatment as any other
    /// pending call site.
    #[test]
    fn dynamic_import_produces_a_possible_call_row_and_diagnostic() {
        let source = "async function load() {\n  return import(\"./x.js\");\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert_eq!(semantics.possible_call_rows.len(), 2);
        assert_eq!(
            semantics.possible_call_rows[0].body["classification"],
            "possible"
        );
        assert_eq!(
            semantics.possible_call_rows[1].body["reason"],
            REASON_CALL_DEFERRED
        );
    }

    /// P2-2i: an overloaded (ambiguous) local function call is a plain
    /// identifier callee (`REASON_CALL_TARGET_UNCERTAIN`), still gets a
    /// possible row + diagnostic exactly like a non-identifier callee does.
    #[test]
    fn overloaded_local_call_produces_a_possible_row_with_the_uncertain_reason() {
        let source = "function f(a: string): void;\nfunction f(a: number): void;\nfunction f(a: unknown): void {}\nfunction use() {\n  f(1);\n}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert_eq!(semantics.possible_call_rows.len(), 2);
        assert_eq!(
            semantics.possible_call_rows[1].body["reason"],
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

    /// P2-2i: a pending heritage clause on a NAMED declaration (a real
    /// `source_id` to attribute it to) gets a `classification: "possible"`
    /// `core:inherits`/`core:implements` row -- no diagnostic (v3 never
    /// diagnoses a heritage clause either).
    #[test]
    fn pending_named_heritage_clause_produces_a_possible_row() {
        let source = "class Base<T> {}\nclass Derived extends Base<string> {}\n";
        let semantics = analyze_owner_semantics("a.ts", source).expect("analysis succeeds");
        assert_eq!(
            semantics.possible_heritage_rows.len(),
            1,
            "rows: {:?}",
            semantics.possible_heritage_rows
        );
        let record = &semantics.possible_heritage_rows[0];
        assert_eq!(record.category, "relation");
        assert_eq!(record.kind, "jsts:relation_inherits");
        assert_eq!(record.universal_kind, "core:inherits");
        assert_eq!(record.body["classification"], "possible");
        assert!(record.body.get("target_id").is_none());
        assert!(record.identity_key.ends_with(":unresolved"));
        let derived_start = source.find("Derived").unwrap() as u32;
        let derived_id = format!("jsts:class:a.ts:{derived_start}:Derived");
        assert_eq!(record.body["source_id"], derived_id);
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
        // P2-2i: no `source_id` to build a possible row from -- matches v3's
        // own `entityForDeclaration(node.parent)` gap exactly (see
        // `finish_heritage_clause`'s doc comment).
        assert!(
            semantics.possible_heritage_rows.is_empty(),
            "rows: {:?}",
            semantics.possible_heritage_rows
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
        }
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
        HybridResolutionContext {
            resolver: Box::leak(Box::new(resolver)),
            available: Box::leak(Box::new(available)),
            files: Box::leak(Box::new(files)),
            typeflow_index: None,
            typeflow_oracle: false,
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
        assert!(
            semantics
                .pending_sites
                .iter()
                .any(|site| site.reason.as_deref() == Some(REASON_IMPORT_BINDING))
        );
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
        assert!(
            semantics
                .pending_sites
                .iter()
                .any(|site| site.reason.as_deref() == Some(REASON_IMPORT_BINDING))
        );
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
        let covers_rows = covers(&semantics);
        assert_eq!(
            covers_rows.len(),
            2,
            "expected one covers row per cross-file reference: {covers_rows:?}"
        );
        let reference_spans: BTreeSet<(u32, u32)> =
            references.iter().map(|row| (row.0, row.1)).collect();
        for (start, end, source_id, target) in &covers_rows {
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
}
