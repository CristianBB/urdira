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
    canonical_evidence, canonical_json, canonical_span, proposal_record_key,
};
use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast::Comment;
use oxc_ast::ast::{
    BindingPattern, CallExpression, Class, ClassType, ExportSpecifier, Expression, FormalParameter,
    Function, FunctionType, IdentifierReference, ImportDeclaration, ImportDefaultSpecifier,
    ImportExpression, ImportNamespaceSpecifier, ImportSpecifier, MethodDefinition,
    MethodDefinitionKind, ModuleExportName, ObjectProperty, PropertyDefinition, PropertyKey,
    PropertyKind, StaticMemberExpression, TSEnumDeclaration, TSInterfaceDeclaration,
    TSMethodSignature, TSMethodSignatureKind, TSModuleDeclaration, TSQualifiedName,
    TSTypeAliasDeclaration, TSTypeName, TSTypePredicate, TSTypePredicateName, ThisExpression,
    VariableDeclarator,
};
use oxc_ast_visit::{
    Visit,
    utf8_to_utf16::Utf8ToUtf16,
    walk::{
        walk_call_expression, walk_class, walk_export_specifier, walk_formal_parameter,
        walk_function, walk_import_declaration, walk_import_default_specifier,
        walk_import_expression, walk_import_namespace_specifier, walk_import_specifier,
        walk_method_definition, walk_object_property, walk_property_definition,
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
            jsdoc_typed_file,
            ctx,
            current_import_source: None,
            import_bindings: HashMap::new(),
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
            resolver::ExportResolution::Ambiguous | resolver::ExportResolution::Unresolved => {
                ReferenceResolution::Pending(REASON_IMPORT_BINDING)
            }
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
            self.finish_heritage_clause(start, end, relation_kind, resolution);
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
        OwnerSemantics {
            reference_rows,
            covers_rows,
            call_rows,
            heritage_rows,
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
    ProposedRecord {
        proposal_record_key: proposal_record_key(&identity_key),
        category: "relation",
        kind: "jsts:relation_references".to_owned(),
        universal_kind: "core:references".to_owned(),
        facets: canonical_json(&serde_json::json!(["core:reference_relation"])),
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
    ProposedRecord {
        proposal_record_key: proposal_record_key(&identity_key),
        category: "relation",
        kind: "jsts:relation_covers".to_owned(),
        universal_kind: "core:covers".to_owned(),
        facets: canonical_json(&serde_json::json!(["core:reference_relation"])),
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
    ProposedRecord {
        proposal_record_key: proposal_record_key(&identity_key),
        category: "relation",
        kind: "jsts:relation_call".to_owned(),
        universal_kind: "core:call".to_owned(),
        facets: canonical_json(&serde_json::json!(["core:reference_relation"])),
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
    ProposedRecord {
        proposal_record_key: proposal_record_key(&identity_key),
        category: "relation",
        kind: format!("jsts:relation_{}", row.relation_kind),
        universal_kind: format!("core:{}", row.relation_kind),
        facets: canonical_json(&serde_json::json!(["core:reference_relation"])),
        schema_version: 1,
        source_span: canonical_span(path, row.start, row.end),
        identity_key,
        body: serde_json::Value::Object(body),
        evidence_references: canonical_evidence(path, row.start, row.end),
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
                self.push_site(
                    SiteKind::Call,
                    start,
                    end,
                    SiteDisposition::CheckerPending,
                    Some(reason),
                );
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
        if let Some(super_class) = &class.super_class {
            let span = super_class.span();
            let ident = if class.super_type_arguments.is_some() {
                None
            } else {
                match super_class {
                    Expression::Identifier(ident) => Some(ident.as_ref()),
                    _ => None,
                }
            };
            let resolution = self.resolve_heritage_clause(self_class_id.as_deref(), ident);
            self.finish_heritage_clause(span.start, span.end, "inherits", resolution);
        }
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
        self.finish_heritage_clause_group("implements", implements_entries);
        if class.r#type == ClassType::ClassDeclaration && class.id.is_some() {
            self.push_site(
                SiteKind::TypedDecl,
                class.span.start,
                class.span.end,
                SiteDisposition::CheckerPending,
                Some(REASON_TYPE_INFERENCE_REQUIRED),
            );
        }
        walk_class(self, class);
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
        walk_function(self, function, flags);
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
        walk_method_definition(self, method);
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
        walk_property_definition(self, property);
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
        self.finish_heritage_clause_group("inherits", extends_entries);
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
}
