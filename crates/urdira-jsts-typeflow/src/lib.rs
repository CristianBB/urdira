//! P0-S2 prototype of the "typeflow" resolver (urdira v4 plan): a
//! declared-types database over one file, and a cross-file program index
//! built from many such summaries, used by
//! `urdira-jsts-syntax-worker`'s hybrid semantic lane (E1-E3) to resolve
//! member-access call sites (`a.b()`, `this.x()`, `super.m()`) and heritage
//! clauses (`extends`/`implements`) that E1-E3's plain-identifier resolution
//! leaves `checker_pending`.
//!
//! Scope, deliberately narrow for a prototype (see
//! `docs/evidence/2026-09-02-v4-p0-s2-typeflow-prototype.md`):
//!
//! - This crate only extracts and indexes CLASS/INTERFACE declarations --
//!   their own member tables (`MemberEntry`) and their `extends`/
//!   `implements` heritage, restricted to a plain identifier target (generic
//!   type arguments erased: `Base<T>` indexes as `Base`; a qualified name,
//!   `ns.Base`, is `HeritageTarget::Unknown`, deferred to a later round).
//! - It deliberately does NOT resolve a call site's or a variable's own
//!   declared TYPE -- that identity-preserving lookup (a parameter/variable
//!   annotation naming a class/interface, a `new T()` initializer, an import
//!   binding) is already exactly what `semantic_sites.rs`'s
//!   `resolve_identifier_to_kind` computes for E3's heritage/call
//!   resolution, through oxc's own symbol table AND the E2 workspace/export
//!   resolver -- reinventing it here would fork that logic from its single
//!   source of truth. The syntax worker calls back into THIS crate only for
//!   the one capability it does not already have: given an already-resolved
//!   class/interface entity id, find its member's entity id, walking the
//!   `extends` (then, as a fallback, `implements`) chain across files.
//!
//! Identity: every entity id this crate produces or consumes is E0's
//! `jsts:{kind}:{path}:{start}:{name}` convention (UTF-16 `start`), matching
//! `urdira-jsts-syntax-worker::semantic_sites::declaration_id` and the
//! checker's own `stableId` (`packages/plugin-javascript-typescript/src/
//! analyzer.ts`) byte for byte -- see `declaration_id` below.

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, Class, ClassElement, ClassType, Expression, Function, FunctionBody, FunctionType,
    IdentifierReference, MethodDefinitionKind, Program, PropertyKey, Statement,
    TSInterfaceDeclaration, TSLiteral, TSSignature, TSType, TSTypeAliasDeclaration,
    TSTypeAnnotation, TSTypeName, TSTypePredicateName, TSTypeQueryExprName,
};
use oxc_ast_visit::utf8_to_utf16::Utf8ToUtf16;
use oxc_parser::Parser;
use oxc_semantic::{Scoping, SemanticBuilder};
use oxc_span::{GetSpan, SourceType};
use oxc_syntax::symbol::SymbolId;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

/// E-P0l (2026-09-08) coverage-recovery diagnostics: how many times
/// `collect_members` gave up as "uncertain" specifically because of an
/// unresolved `extends` ancestor (item A's own guard) versus a known-
/// subclass-override guess-block (item C's own guard) -- read (and reset)
/// via `take_demotion_reason_counts`, consulted ONLY by the parity-diff
/// diagnostic dump scripts (a `REASON_*`-style histogram measuring which
/// guard costs the most "same" coverage); never consulted by production
/// resolution logic itself, and never affects any resolution OUTCOME --
/// purely additive bookkeeping.
pub static DEMOTED_BY_UNRESOLVED_EXTENDS: AtomicU64 = AtomicU64::new(0);
pub static DEMOTED_BY_KNOWN_SUBCLASS_OVERRIDE: AtomicU64 = AtomicU64::new(0);
/// E-P0o (2026-09-08): how many times `semantic_sites.rs`'s own caller
/// demoted a `members()` `One` (an OWN declaration on the receiver's
/// entity) to a genuine ambiguity because `ProgramIndex::sibling_extends_
/// overrides` found at least one OTHER known `extends`-descendant
/// container that ALSO redeclares the same member name -- the `getModel`/
/// `_getViewModel`/`cellAt`/`getSelection` VS Code residual (`docs/
/// evidence/2026-09-07-v4-vscode-campaign.md` §14.7). Incremented from
/// `urdira-jsts-syntax-worker`, not this crate (only that crate sees the
/// receiver-typing `rule` needed to decide "reliable" vs not) -- exported
/// `pub` for that reason, unlike the two counters above which this crate
/// increments itself.
pub static DEMOTED_BY_SIBLING_DECLARATION: AtomicU64 = AtomicU64::new(0);

/// Snapshot-and-reset the three counters above: `(unresolved_extends,
/// known_subclass_override, sibling_declaration)`. Call once per scan/
/// diagnostic run before reading -- a fresh process already starts all
/// three at zero, so this is only needed to isolate ONE scan's own counts
/// inside a longer-lived process (a test harness driving several scans in
/// sequence, for instance).
pub fn take_demotion_reason_counts() -> (u64, u64, u64) {
    (
        DEMOTED_BY_UNRESOLVED_EXTENDS.swap(0, Ordering::Relaxed),
        DEMOTED_BY_KNOWN_SUBCLASS_OVERRIDE.swap(0, Ordering::Relaxed),
        DEMOTED_BY_SIBLING_DECLARATION.swap(0, Ordering::Relaxed),
    )
}

/// E0 identity: `jsts:{kind}:{path}:{start}:{name}`. Mirrors
/// `urdira-jsts-syntax-worker::semantic_sites::declaration_id` and the
/// checker's `stableId` exactly -- see this crate's module doc.
pub fn declaration_id(kind: &str, path: &str, start: u32, name: &str) -> String {
    format!("jsts:{kind}:{path}:{start}:{name}")
}

/// P1-A: a declared type shape captured at `extract_decl_summary` time for a
/// function/method return type or a class/interface member's own type
/// annotation -- generalizes `HeritageTarget` with the two additional shapes
/// P1-A's chain rules need (TypeScript's own `this` return type, and the
/// `T[]`/`Array<T>`/`Promise<T>` wrappers a fluent-chain or `await` needs to
/// see through one hop at a time). See `docs/evidence/2026-09-02-v4-p1a-
/// typeflow.md`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum RawTypeRef {
    Local(String),
    Imported {
        specifier: String,
        imported_name: Option<String>,
    },
    /// TypeScript's own `this` return type (`description(): this`) -- a
    /// builder/fluent method's declared return type is the SAME type as
    /// whatever `this` was bound to at the CALL site, never a fixed entity
    /// id. Resolved relative to the receiver by the caller (`semantic_
    /// sites.rs`'s `resolve_type_ref_relative`), never here.
    ThisType,
    ArrayOf(Box<RawTypeRef>),
    PromiseOf(Box<RawTypeRef>),
    /// P1-C: `Record<K, V>`'s own VALUE type `V` -- unwrapped one layer by
    /// an indexed/computed access (`a[i]`, `a["x"]`), the same way `ArrayOf`
    /// is. `K` is never inspected (this crate does not narrow by key type).
    RecordOf(Box<RawTypeRef>),
    /// P1-C: `ReturnType<typeof f>` -- `f`'s own (declared or fixed-point-
    /// inferred) return type, resolved once `ProgramIndex::build`'s third
    /// pass (P1-B's shallow return-inference fixed point) has settled every
    /// function's own return type -- see `ProgramIndex::build`'s fourth
    /// pass doc comment for why this needs a LATER resolution step than
    /// every other `RawTypeRef` leaf (`resolve_raw_type_ref` alone cannot
    /// see `function_return_types`). Found live, the dominant root cause
    /// P1-B flagged for its own remaining `call_expression_receiver`/
    /// `chained_member_of_call` mass: `schemaBuilder: ReturnType<typeof
    /// createSchemaBuilder>` in the migration DSL's `MigrationContext`
    /// interface.
    ReturnTypeOfFn(ReturnEntityRef),
    /// G (E-P0l, 2026-09-08): a member's own declared type IS a bare
    /// `typeof <expr>` type query (`x: typeof console.log`, `x: typeof f`)
    /// -- as opposed to `ReturnType<typeof f>` (`ReturnTypeOfFn` above),
    /// which resolves to `f`'s own RETURN type, this resolves to `<expr>`'s
    /// OWN declaration (the function/variable/import itself): calling a
    /// member typed this way calls through to whatever `<expr>` actually
    /// is, exactly the way TypeScript's own checker follows the signature
    /// through -- found live: `private readonly _fetchFn: typeof fetch`
    /// called as `this._fetchFn(...)` used to resolve (wrongly) to the
    /// `_fetchFn` PROPERTY's own declaration instead. `None` inside when
    /// `<expr>` is not a plain identifier this crate can resolve (a
    /// qualified name like `console.log`/`globalThis.fetch`, `typeof
    /// this`, `typeof import(...)`) -- the known-to-be-a-type-query fact
    /// itself is still preserved (this variant, never silently degrading
    /// to `Unknown`) so a caller can tell "genuinely a type query, target
    /// just not known" apart from "not a type query at all" and refuse to
    /// fall back to guessing the member's own declaration as the call
    /// target either way -- pending, never a guess.
    TypeQuery(Option<ReturnEntityRef>),
    /// P1-C: `T["k"]` (a TypeScript indexed-access type with a STRING
    /// LITERAL index only -- a union of keys, a numeric/computed index, or
    /// `keyof T` is `Unknown`, never a guess) -- member `key`'s own declared
    /// type on `base`, resolved the same LATER-pass way as `ReturnTypeOfFn`
    /// (needs `ProgramIndex`'s own `containers` map, not available at
    /// single-file extraction time).
    IndexedAccess {
        base: Box<RawTypeRef>,
        key: String,
    },
    /// P2-2j: a TypeScript union type (`A | B`) used as a member-access
    /// receiver -- see `raw_type_ref_of_ts_type`'s `TSUnionType` arm for the
    /// exact construction rules: `null`/`undefined`/literal/primitive
    /// constituents are dropped first (TypeScript's own nullability
    /// convention -- `A | null` means "possibly-null A", not a real second
    /// branch to look members up on -- never a guess about the OTHER
    /// constituents); ANY remaining constituent this crate cannot classify
    /// makes the WHOLE union `Unknown` (conservative, never a partial
    /// guess, same "never widen past what's proven" discipline as
    /// everywhere else in this crate); constituents are deduped; a union
    /// that collapses to one distinct constituent (including `A | A`) is
    /// that constituent, never a one-element `Union`. Resolved
    /// (`ProgramIndex::members_of_union`) to CANDIDATE member ids only -- a
    /// union receiver never promotes to a single confirmed target, even
    /// when every constituent resolves to the SAME member id (see
    /// `MemberLookup::UnionCandidates`'s own doc comment) -- this crate's
    /// zero-wrong-target record is never spent on a genuine receiver
    /// ambiguity.
    Union(Vec<RawTypeRef>),
    /// E-P0p (2026-09-09): a method/function's own declared return type IS
    /// a TypeScript user-defined type-predicate (`this is T` or `param is
    /// T`) -- `docs/evidence/2026-09-07-v4-vscode-campaign.md` §15.2's own
    /// live counter-example (`hasModel(): this is IActiveCodeEditor`).
    /// `subject` says WHICH thing the predicate narrows when the call
    /// proves true (`PredicateSubject::Receiver` for `this is T` -- the
    /// only shape this crate's own consumer, `semantic_sites.rs`'s
    /// `type_predicate_narrowing_of_call`, ever ACTS on; `Parameter(name)`
    /// for `param is T` is represented here so this variant is never a
    /// MISCLASSIFICATION of the syntax, but no consumer resolves it yet --
    /// doing so soundly needs a per-function parameter-name/position table
    /// this index does not otherwise keep, see that function's own doc
    /// comment for the scope decision). `target` is the predicate's own
    /// asserted type (`T`), a plain `RawTypeRef` exactly like any other
    /// declared type -- resolved through the SAME `resolve_raw_type_ref`/
    /// `resolve_raw_type_ref_deferred` pipeline as every other leaf.
    /// Deliberately NOT treated as this call's own VALUE type anywhere
    /// (`resolve_type_ref_relative`'s own `TypePredicate` arm, `semantic_
    /// sites.rs`) -- a predicate-returning call's real runtime value is
    /// `boolean`, never `T`; `target` is consulted ONLY by the dedicated
    /// narrowing path, never by ordinary fluent-chain/call-return-type
    /// propagation.
    TypePredicate {
        subject: PredicateSubject,
        target: Box<RawTypeRef>,
    },
    /// Anything this crate does not (yet) reason about: a conditional/
    /// mapped/keyof/tuple type, a qualified type name, a type-parameter
    /// reference, ... -- never a guess. (A union type is `Union` instead,
    /// see its own doc comment, unless it contaminates to `Unknown` per
    /// that variant's own rule.)
    Unknown,
}

/// E-P0p (2026-09-09): which side of a `this is T` / `param is T` return-
/// type predicate `RawTypeRef::TypePredicate`/`ResolvedTypeRef::
/// TypePredicate`'s own `target` narrows -- see `RawTypeRef::TypePredicate`'s
/// doc comment for which of the two this crate actually consults today.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum PredicateSubject {
    /// `this is T` -- narrows the method's own RECEIVER (the object a
    /// member call/read reaches it through).
    Receiver,
    /// `param is T` -- narrows a NAMED parameter of the declaring function
    /// itself. `name` is the predicate's own text, captured the instant this
    /// variant is built (`raw_type_ref_of_ts_type`'s `TSTypePredicate` arm,
    /// which has no parameter-LIST context of its own -- it classifies one
    /// `TSType` node in isolation). `position` is filled in ONLY by
    /// `summarize_function` (E-P0q, 2026-09-09), the one call site that DOES
    /// have the declaring function's own `FormalParameters` in scope at the
    /// moment its return type is classified -- `parameter_position_by_name`
    /// finds `name` among a PLAIN identifier parameter (never a
    /// destructured/rest one -- same certainty bar every other resolver in
    /// this crate applies) and records its zero-based index; `None`
    /// otherwise (an arrow/method/callable-variable predicate this crate
    /// does not thread position through for, or a name that does not match
    /// any plain-identifier parameter). `ProgramIndex::function_predicate_
    /// parameter_narrowing` refuses to narrow anything when `position` is
    /// `None` -- never a guess at which call argument the predicate's own
    /// parameter corresponds to.
    Parameter {
        name: String,
        position: Option<usize>,
    },
}

impl From<HeritageTarget> for RawTypeRef {
    fn from(target: HeritageTarget) -> Self {
        match target {
            HeritageTarget::Local(id) => RawTypeRef::Local(id),
            HeritageTarget::Imported {
                specifier,
                imported_name,
            } => RawTypeRef::Imported {
                specifier,
                imported_name,
            },
            HeritageTarget::Unknown => RawTypeRef::Unknown,
            // A heritage-only concept (see `HeritageTarget::CallMember`'s
            // doc comment) -- never meaningful as a property/return type.
            HeritageTarget::CallMember { .. } => RawTypeRef::Unknown,
        }
    }
}

/// `RawTypeRef` with every `Local`/`Imported` leaf resolved to a concrete
/// entity id (or dropped entirely if unresolved -- see `resolve_raw_type_
/// ref`'s doc comment). What `ProgramIndex::member_type_ref`/`function_
/// return_type` hand back to the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedTypeRef {
    Entity(String),
    ThisType,
    ArrayOf(Box<ResolvedTypeRef>),
    PromiseOf(Box<ResolvedTypeRef>),
    /// P1-C: see `RawTypeRef::RecordOf`'s doc comment.
    RecordOf(Box<ResolvedTypeRef>),
    /// P2-2j: see `RawTypeRef::Union`'s doc comment. `resolve_raw_type_ref`/
    /// `resolve_raw_type_ref_deferred` resolve EVERY constituent or none at
    /// all (`Option<Vec<_>>::collect`'s short-circuit) -- a union with one
    /// unresolvable constituent (an import that never closed, ...) is never
    /// partially represented, matching the "resolve fully or stay `None`"
    /// contract every other composite `RawTypeRef` wrapper already has.
    Union(Vec<ResolvedTypeRef>),
    /// G (E-P0l, 2026-09-08): see `RawTypeRef::TypeQuery`'s doc comment.
    /// `Some(entity_id)` when the type query's own expression resolved to
    /// a single known declaration; `None` when it is a known type query
    /// with no resolvable target (a qualified name, `typeof this`, ...) --
    /// either way, this is NOT the same as the whole member being
    /// unresolved (`ResolvedTypeRef` itself being absent) -- a caller must
    /// still refuse to fall back to the member's own declaration.
    TypeQuery(Option<String>),
    /// E-P0p (2026-09-09): see `RawTypeRef::TypePredicate`'s doc comment --
    /// `target` here is fully resolved (an `Entity(id)` when `T` names a
    /// known class/interface, `None`-shaped states elsewhere collapsing the
    /// same way any other unresolved leaf does).
    TypePredicate {
        subject: PredicateSubject,
        target: Box<ResolvedTypeRef>,
    },
}

/// One member of a class or interface: enough to answer "does this
/// container declare a member named X (static or instance)", AND (P1-A)
/// its own declared type -- a property's own annotation, or a method's own
/// declared return type -- for chain propagation (`ProgramIndex::member_
/// type_ref`). `type_ref` is `RawTypeRef::Unknown` for anything this crate
/// cannot classify (an inferred/untyped member, a computed signature, ...).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemberEntry {
    pub name: String,
    pub is_static: bool,
    pub entity_id: String,
    pub type_ref: RawTypeRef,
    /// P1-B: see `FunctionSummary::pending_return`'s doc comment -- the same
    /// mechanism, for an unannotated METHOD (never a plain property, never
    /// a getter/setter/constructor -- see `member_entry_of_class_element`'s
    /// own gate) or an unannotated object-shape function/arrow property.
    pub pending_return: Option<Vec<DeferredReturnShape>>,
    pub is_async: bool,
}

/// A top-level (or `export`ed) named function declaration's own declared
/// return type (P1-A, rule (a): `f(...)`'s call-expression type is `f`'s
/// declared return type). Never a class method -- those are `MemberEntry`'s
/// own `type_ref` instead, looked up through `ProgramIndex::member_type_ref`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FunctionSummary {
    pub entity_id: String,
    pub return_type: RawTypeRef,
    /// P1-B: body-inference input, present only when `return_type` is
    /// `RawTypeRef::Unknown` (unannotated) AND every `return` statement in
    /// the body classified to a resolvable shape -- see
    /// `DeferredReturnShape`'s doc comment. Resolved to a concrete
    /// `ResolvedTypeRef` by `ProgramIndex::build`'s fixed-point pass (or
    /// left unresolved -- the function stays `Unknown` -- if the fixed
    /// point cannot make every shape agree within the iteration bound).
    pub pending_return: Option<Vec<DeferredReturnShape>>,
    /// P1-B: whether this function is declared `async` -- an inferred
    /// return type is wrapped in one `PromiseOf` layer when true (mirrors
    /// what an explicit `: Promise<T>` annotation would already say).
    pub is_async: bool,
}

/// P1-B: one `return <expr>;` statement's classified shape, collected from
/// an UNANNOTATED function/method/arrow's own body at `extract_decl_summary`
/// time (never for an annotated one -- the annotation always wins, see
/// `FunctionSummary::pending_return`'s doc comment). Deliberately narrow
/// (the same "never widen past what's proven" discipline as the rest of
/// this crate): only `new T()`, `this` (the enclosing class, its
/// SUBCLASSES included -- see `Known`'s doc comment), a call to a known
/// top-level function (`CallEntity`), `this.member`/`this.member()`
/// (`MemberOf`), and one layer of `await` unwrapping around any of those
/// (`AwaitOf`) are ever classified; anything else (a template/conditional/
/// object-literal/array-literal expression, a call through anything but a
/// plain identifier or `this.member`, ...) is `Unknown` -- and a SINGLE
/// `Unknown` return statement anywhere in the body drops the WHOLE
/// function's inference (see `collect_pending_return_shapes`'s doc
/// comment), never a partial guess from the other, resolvable returns.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum DeferredReturnShape {
    /// Immediately resolvable at extraction time (modulo the SAME
    /// import-closure `ProgramIndex::build` already performs for every
    /// other `RawTypeRef` -- see `resolve_raw_type_ref`): `new T()`
    /// (`RawTypeRef::Local`/`Imported`) or `this` (`RawTypeRef::ThisType`,
    /// the SAME polymorphic-relative-to-receiver semantics an explicit
    /// `: this` annotation already gets -- sound here too: TypeScript's own
    /// control-flow return-type inference for `return this;` behaves the
    /// same way for a subclass calling the inherited method).
    Known(RawTypeRef),
    /// `return this.member` / `return this.member(...)` -- resolved once
    /// `container`'s own member table (declared OR itself inferred by this
    /// same fixed point, on a later iteration) has `member`'s type.
    /// `container` is always the SAME-FILE enclosing class's own entity id
    /// (never imported -- `this` cannot cross a file), known already at
    /// extraction time.
    MemberOf {
        container: String,
        name: String,
        is_static: bool,
    },
    /// `return f(...)` where `f` is a plain identifier resolving to a
    /// top-level named function declaration (`ReturnEntityRef::Local`) or a
    /// named import of one (`ReturnEntityRef::Imported`) -- resolved once
    /// `f`'s own return type is known (declared or itself inferred).
    CallEntity(ReturnEntityRef),
    /// `return await <inner>` -- unwraps one `PromiseOf` layer from
    /// `inner`'s eventually-resolved type once known (mirrors
    /// `SemanticWalker::type_of_expression`'s own `AwaitExpression` arm in
    /// `urdira-jsts-syntax-worker`); passes a non-`PromiseOf` resolution
    /// through unchanged (defensive, never a hard error).
    AwaitOf(Box<DeferredReturnShape>),
    /// Anything this crate does not classify (a template/conditional/
    /// object-literal/array-literal expression, a call through anything but
    /// a plain identifier or `this.member`, a `this`/`this.member` outside
    /// a class method body, ...) -- never produced INSIDE a stored shape
    /// list (see `collect_pending_return_shapes`'s doc comment: a single
    /// `Unknown` return anywhere drops the whole function's inference
    /// instead), only as `classify_return_shape`'s own transient return
    /// value while a body is still being walked.
    Unknown,
}

/// The callable target of a `DeferredReturnShape::CallEntity` -- a same-file
/// top-level function (already an entity id) or a named import of one
/// (closed against `import_targets` the same way `RawTypeRef::Imported` is,
/// once `ProgramIndex::build` has them). A default/namespace import
/// (`imported_name: None`) never resolves further, matching every other
/// `Imported` variant in this crate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ReturnEntityRef {
    Local(String),
    Imported {
        specifier: String,
        imported_name: Option<String>,
    },
}

/// A heritage clause's (`extends`/`implements`) resolved target, computed at
/// `extract_decl_summary` time using the SAME file's own oxc symbol table --
/// see the module doc for why this crate, not `semantic_sites.rs`, computes
/// it: it is corpus-wide (every file's classes/interfaces), not owner-local.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum HeritageTarget {
    /// The identifier resolved to a LOCAL (same-file) declaration: this IS
    /// the class/interface's entity id already (no further lookup needed).
    Local(String),
    /// The identifier is bound to an import specifier. `specifier` is the
    /// raw module specifier text (`"./base"`, `"@n8n/workflow"`, ...);
    /// `imported_name` is `None` for a default/namespace import (never
    /// resolvable further here -- matches E2's own `resolve_import_binding`
    /// scope) and `Some(name)` for a named import, resolved by the CALLER
    /// (`urdira-jsts-syntax-worker`, which alone has the `WorkspaceResolver`
    /// and `resolve_named_export`) before `ProgramIndex::build` runs.
    Imported {
        specifier: String,
        imported_name: Option<String>,
    },
    /// A qualified name (`ns.Base`), a generic-only-shape this crate could
    /// not classify, an ambiguous/redeclared local symbol, or an unresolved
    /// global -- never a guess. Deferred to a later round (see module doc).
    Unknown,
    /// P1-A (unlocks the `class LoginDto extends Z.class({...}) {}` mixin
    /// factory pattern found live in this corpus's `zod-class.ts`): the
    /// heritage expression is `<base>.<member>(...)` -- `base` classified
    /// the SAME way a plain-identifier heritage target is (only a plain
    /// identifier base is ever attempted here, never a further-nested
    /// chain), `member` the property name being called. Resolved in
    /// `ProgramIndex::build`'s SECOND pass (after every container's own
    /// member table -- including `base`'s own object-literal shape or
    /// class/interface members -- is already built), by looking up
    /// `member`'s own declared return type on `base` and using THAT as the
    /// class's real `extends` target -- see `ProgramIndex::build`'s own
    /// doc comment.
    CallMember {
        base: Box<HeritageTarget>,
        member: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClassSummary {
    pub entity_id: String,
    pub extends: Option<HeritageTarget>,
    pub implements: Vec<HeritageTarget>,
    pub members: Vec<MemberEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InterfaceSummary {
    pub entity_id: String,
    pub extends: Vec<HeritageTarget>,
    pub members: Vec<MemberEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct DeclSummary {
    pub path: String,
    pub classes: Vec<ClassSummary>,
    pub interfaces: Vec<InterfaceSummary>,
    /// P1-A: every top-level (or `export`ed) named function declaration's
    /// own declared return type. See `FunctionSummary`'s doc comment.
    pub functions: Vec<FunctionSummary>,
    /// P1-A (object-literal shape, unlocks the `Z.class({...})` mixin
    /// pattern found live in this corpus -- see `ObjectShapeSummary`'s doc
    /// comment): every top-level (or `export`ed) `const X = { ... }` whose
    /// initializer is a plain object literal, provided `X` has NO explicit
    /// type annotation of its own (see `VariableSummary`'s doc comment for
    /// why the two are mutually exclusive).
    pub object_shapes: Vec<ObjectShapeSummary>,
    /// P1-A: every top-level (or `export`ed) EXPLICITLY-annotated `const X:
    /// T = ...` declarator's own declared type -- see `VariableSummary`'s
    /// doc comment.
    pub variables: Vec<VariableSummary>,
    /// P1-C: every top-level (or `export`ed) `const f = (...) => ...` /
    /// `const f = function(...) {...}` callable VALUE's own call-return
    /// type -- see `collect_callable_variable`'s doc comment. Merged into
    /// the SAME `function_return_types` map a real `function` declaration's
    /// return type lives in (`ProgramIndex::build`), keyed by the
    /// VARIABLE's own entity id (never a `function`-kind id -- this is
    /// never a `function` declaration).
    pub callable_variables: Vec<FunctionSummary>,
    /// D.2 (2026-09-05, references-parity task): every top-level (or
    /// `export`ed) `type X = ...` declaration's own RHS, extracted the SAME
    /// way a class/interface member's inline annotation already is
    /// (`raw_type_ref_of_ts_type`, with `synthetic_interfaces` wired to
    /// `summary.interfaces` directly -- a `type X = { a: Foo }` object-
    /// literal RHS synthesizes an interface for `X` to point at, exactly
    /// like an inline `{ ... }` annotation elsewhere does). Consumed by
    /// `ProgramIndex::build`'s `alias_targets` map, NOT resolved here (the
    /// RHS may itself be an import, only closeable once cross-file import
    /// resolution has run -- see that field's own doc comment).
    pub type_aliases: Vec<TypeAliasDecl>,
}

/// D.2 (2026-09-05, references-parity task): one top-level `type X = ...`
/// declaration, as extracted at single-file `extract_decl_summary` time --
/// `target` is the RHS's raw (not yet cross-file-resolved) type reference,
/// generic type parameters erased the same way every other `RawTypeRef`
/// producer in this crate already erases them (`type Box<T> = Inner<T>`
/// extracts to `RawTypeRef::Local(Inner's id)`, `T` never inspected).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TypeAliasDecl {
    pub id: String,
    pub name: String,
    pub start: u32,
    pub target: RawTypeRef,
}

/// P1-A: a top-level `const X: T = ...` declarator's own EXPLICIT type
/// annotation, mirroring `FunctionSummary` for a plain variable instead of a
/// function. Found live (2k-owner census, wrong-target regression):
/// `export const allNodesConnected: BinaryCheck = { name: ..., run() {...}
/// } }` -- TypeScript's own static type for `allNodesConnected` is the
/// ANNOTATION (`BinaryCheck`), never the object literal's own structural
/// shape, even though the initializer happens to be an object literal too.
/// A declarator with an explicit annotation therefore NEVER also becomes an
/// `ObjectShapeSummary` (see `summarize_object_shape`'s own guard) -- the
/// two variants are mutually exclusive by construction, matching exactly
/// which one TypeScript's own checker would use for that declarator.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VariableSummary {
    pub entity_id: String,
    pub type_ref: RawTypeRef,
}

/// P1-A: a top-level `const X = { prop: (...): T => ..., ... }` object
/// literal, modeled as ANOTHER kind of member-bearing container -- reuses
/// `ProgramIndex`'s existing class/interface member-lookup machinery
/// wholesale (see `ProgramIndex::build`'s own doc comment) rather than
/// inventing a parallel lookup path. `entity_id` is the VARIABLE's own
/// declaration id (`declaration_id("variable", ...)`, matching `semantic_
/// sites::resolve_identifier_to_kind`'s own `DeclKind::Variable` identity
/// exactly), so a use site can resolve `X` once (through the ordinary
/// identifier/import machinery, widened to allow `Variable` -- see
/// `SemanticWalker::type_of_expression`'s `Identifier` arm) and then look
/// members up on it exactly like a class/interface. Only FUNCTION/ARROW-
/// FUNCTION-valued properties with their own return-type annotation
/// contribute a member (a plain data property's OWN type is out of scope
/// for this prototype -- seen live: `Z.class(...)` is always a CALLED
/// property, never accessed as a plain value); a spread property, a
/// computed key, or a non-function value are silently skipped -- never a
/// guess.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObjectShapeSummary {
    pub entity_id: String,
    pub members: Vec<MemberEntry>,
}

/// Parse + build a symbol table for `source_text` (own allocator, own
/// `SemanticBuilder` -- this crate never shares the caller's oxc `Program`,
/// see the module doc for why a corpus-wide index cannot reuse any single
/// owner's per-generation walk) and extract every class/interface
/// declaration's member table and heritage. Never fails on a source the
/// pinned oxc parser accepts; a source it does not accept (unsupported
/// syntax) yields `Err` and the caller should treat this file as
/// contributing nothing to the program index -- exactly as safe as it being
/// absent, never as a guess.
pub fn extract_decl_summary(path: &str, source_text: &str) -> Result<DeclSummary, String> {
    let source_type = SourceType::from_path(std::path::Path::new(path))
        .map_err(|_| format!("unsupported source type for {path}"))?;
    let allocator = Allocator::default();
    let mut parsed = Parser::new(&allocator, source_text, source_type).parse();
    if !parsed.diagnostics.is_empty() && parsed.program.body.is_empty() {
        return Err(format!("{path} failed to parse"));
    }
    // Must run before spans are read anywhere below, so `start` matches E0's
    // UTF-16 convention exactly (see `semantic_sites.rs`'s own call site).
    Utf8ToUtf16::new(source_text).convert_program(&mut parsed.program);
    let semantic_return = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&parsed.program);
    let scoping = semantic_return.semantic.scoping();
    let import_specifiers = collect_import_specifiers(&parsed.program);
    let mut summary = DeclSummary {
        path: path.to_owned(),
        classes: Vec::new(),
        interfaces: Vec::new(),
        functions: Vec::new(),
        object_shapes: Vec::new(),
        variables: Vec::new(),
        callable_variables: Vec::new(),
        type_aliases: Vec::new(),
    };
    for statement in &parsed.program.body {
        collect_from_statement(statement, path, scoping, &import_specifiers, &mut summary);
    }
    Ok(summary)
}

/// Top-level-only scan for `import ... from "specifier"` local bindings,
/// keyed by oxc `SymbolId` (the same id `scoping.get_reference(..).
/// symbol_id()` returns for a use of that binding). Imports are always
/// module-top-level with no nesting, so a flat scan of `program.body`
/// (never a recursive walk) is exact. `None` for the specifier-relative
/// imported name means a default or namespace import (see
/// `HeritageTarget::Imported`'s doc comment).
fn collect_import_specifiers(program: &Program) -> HashMap<SymbolId, (String, Option<String>)> {
    use oxc_ast::ast::ImportDeclarationSpecifier;
    let mut map = HashMap::new();
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        let Some(specifiers) = &import.specifiers else {
            continue;
        };
        let source = import.source.value.as_str().to_owned();
        for specifier in specifiers {
            let (symbol_id, imported_name) = match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(specifier) => {
                    let imported_name = match &specifier.imported {
                        oxc_ast::ast::ModuleExportName::IdentifierName(name) => {
                            Some(name.name.as_str().to_owned())
                        }
                        _ => None,
                    };
                    (specifier.local.symbol_id.get(), imported_name)
                }
                ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => {
                    (specifier.local.symbol_id.get(), None)
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) => {
                    (specifier.local.symbol_id.get(), None)
                }
            };
            if let Some(symbol_id) = symbol_id {
                map.insert(symbol_id, (source.clone(), imported_name));
            }
        }
    }
    map
}

fn collect_from_statement(
    statement: &Statement,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    summary: &mut DeclSummary,
) {
    match statement {
        Statement::ClassDeclaration(class) => {
            if let Some(class_summary) = summarize_class(
                class,
                path,
                scoping,
                import_specifiers,
                &mut summary.interfaces,
            ) {
                summary.classes.push(class_summary);
            }
        }
        Statement::TSInterfaceDeclaration(declaration) => {
            let interface_summary = summarize_interface(
                declaration,
                path,
                scoping,
                import_specifiers,
                &mut summary.interfaces,
            );
            summary.interfaces.push(interface_summary);
        }
        Statement::FunctionDeclaration(function) => {
            if let Some(function_summary) = summarize_function(
                function,
                path,
                scoping,
                import_specifiers,
                &mut summary.interfaces,
            ) {
                summary.functions.push(function_summary);
            }
        }
        Statement::VariableDeclaration(declaration) => {
            collect_object_shapes(declaration, path, scoping, import_specifiers, summary);
        }
        Statement::TSTypeAliasDeclaration(declaration) => {
            let alias = summarize_type_alias(
                declaration,
                path,
                scoping,
                import_specifiers,
                &mut summary.interfaces,
            );
            summary.type_aliases.push(alias);
        }
        Statement::ExportNamedDeclaration(export) => {
            if let Some(declaration) = &export.declaration {
                collect_from_declaration(declaration, path, scoping, import_specifiers, summary);
            }
        }
        Statement::ExportDefaultDeclaration(export) => {
            collect_from_default_declaration(
                &export.declaration,
                path,
                scoping,
                import_specifiers,
                summary,
            );
        }
        _ => {}
    }
}

fn collect_from_declaration(
    declaration: &oxc_ast::ast::Declaration,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    summary: &mut DeclSummary,
) {
    use oxc_ast::ast::Declaration;
    match declaration {
        Declaration::ClassDeclaration(class) => {
            if let Some(class_summary) = summarize_class(
                class,
                path,
                scoping,
                import_specifiers,
                &mut summary.interfaces,
            ) {
                summary.classes.push(class_summary);
            }
        }
        Declaration::TSInterfaceDeclaration(declaration) => {
            let interface_summary = summarize_interface(
                declaration,
                path,
                scoping,
                import_specifiers,
                &mut summary.interfaces,
            );
            summary.interfaces.push(interface_summary);
        }
        Declaration::FunctionDeclaration(function) => {
            if let Some(function_summary) = summarize_function(
                function,
                path,
                scoping,
                import_specifiers,
                &mut summary.interfaces,
            ) {
                summary.functions.push(function_summary);
            }
        }
        Declaration::VariableDeclaration(declaration) => {
            collect_object_shapes(declaration, path, scoping, import_specifiers, summary);
        }
        Declaration::TSTypeAliasDeclaration(declaration) => {
            let alias = summarize_type_alias(
                declaration,
                path,
                scoping,
                import_specifiers,
                &mut summary.interfaces,
            );
            summary.type_aliases.push(alias);
        }
        _ => {}
    }
}

/// D.2 (2026-09-05, references-parity task): extract one `type X = ...`
/// declaration's own `TypeAliasDecl` -- see that struct's own doc comment.
fn summarize_type_alias(
    declaration: &TSTypeAliasDeclaration,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    synthetic_interfaces: &mut Vec<InterfaceSummary>,
) -> TypeAliasDecl {
    let name = declaration.id.name.as_str().to_owned();
    let start = declaration.id.span.start;
    let id = declaration_id("type", path, start, &name);
    let target = raw_type_ref_of_ts_type(
        &declaration.type_annotation,
        path,
        scoping,
        import_specifiers,
        synthetic_interfaces,
    );
    TypeAliasDecl {
        id,
        name,
        start,
        target,
    }
}

/// P1-A: for every declarator in `declaration`, EITHER (a declarator with
/// an explicit type annotation) capture its declared type as a
/// `VariableSummary`, OR (no annotation, a plain object-literal
/// initializer) capture its structural shape as an `ObjectShapeSummary` --
/// see `VariableSummary`'s doc comment for why these are mutually
/// exclusive.
fn collect_object_shapes(
    declaration: &oxc_ast::ast::VariableDeclaration,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    summary: &mut DeclSummary,
) {
    use oxc_ast::ast::BindingPattern;
    for declarator in &declaration.declarations {
        let BindingPattern::BindingIdentifier(ident) = &declarator.id else {
            continue;
        };
        if let Some(annotation) = &declarator.type_annotation {
            let entity_id = declaration_id("variable", path, ident.span.start, ident.name.as_str());
            let type_ref = raw_type_ref_of_ts_type(
                &annotation.type_annotation,
                path,
                scoping,
                import_specifiers,
                &mut summary.interfaces,
            );
            summary.variables.push(VariableSummary {
                entity_id,
                type_ref,
            });
            continue;
        }
        if let Some(shape) = summarize_object_shape(
            declarator,
            path,
            scoping,
            import_specifiers,
            &mut summary.interfaces,
        ) {
            summary.object_shapes.push(shape);
            continue;
        }
        // P1-C: `const f = (...) => ...` / `const f = function(...) {...}`
        // -- see `collect_callable_variable`'s doc comment. Tried only
        // after the two existing shapes above both miss (mutually
        // exclusive by construction: an explicit annotation, a plain
        // object-literal initializer, and a function/arrow-valued
        // initializer are three different declarator shapes).
        if let Some(callable) = collect_callable_variable(
            declarator,
            path,
            scoping,
            import_specifiers,
            &mut summary.interfaces,
            &mut summary.object_shapes,
        ) {
            summary.callable_variables.push(callable);
        }
    }
}

fn collect_from_default_declaration(
    declaration: &oxc_ast::ast::ExportDefaultDeclarationKind,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    summary: &mut DeclSummary,
) {
    use oxc_ast::ast::ExportDefaultDeclarationKind;
    match declaration {
        ExportDefaultDeclarationKind::ClassDeclaration(class) => {
            if let Some(class_summary) = summarize_class(
                class,
                path,
                scoping,
                import_specifiers,
                &mut summary.interfaces,
            ) {
                summary.classes.push(class_summary);
            }
        }
        ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
            if let Some(function_summary) = summarize_function(
                function,
                path,
                scoping,
                import_specifiers,
                &mut summary.interfaces,
            ) {
                summary.functions.push(function_summary);
            }
        }
        _ => {}
    }
}

/// P1-A: a top-level named function declaration's own entity id + declared
/// return type (`RawTypeRef::Unknown` when unannotated or the annotation's
/// shape is not one `raw_type_ref_of_ts_type` classifies). `None` for a
/// function EXPRESSION statement (`function.id.is_none()`, e.g. `export
/// default function () {}`) or a non-declaration function kind -- mirrors
/// `semantic_sites::classify_symbol_declaration`'s own `FunctionDeclaration
/// | TSDeclareFunction` gate exactly, so this crate's `function_id` always
/// matches that walker's own `DeclKind::Function` entity id byte for byte.
fn summarize_function(
    function: &Function,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    synthetic_interfaces: &mut Vec<InterfaceSummary>,
) -> Option<FunctionSummary> {
    if !matches!(
        function.r#type,
        FunctionType::FunctionDeclaration | FunctionType::TSDeclareFunction
    ) {
        return None;
    }
    let ident = function.id.as_ref()?;
    let entity_id = declaration_id("function", path, ident.span.start, ident.name.as_str());
    let return_type = raw_type_ref_of_annotation(
        function.return_type.as_deref(),
        path,
        scoping,
        import_specifiers,
        synthetic_interfaces,
    );
    // E-P0q (2026-09-09): this is the ONE call site with the declaring
    // function's own `FormalParameters` in scope at the moment its return
    // type is classified -- patch a `param is T` predicate's own `position`
    // in now, never later (`PredicateSubject::Parameter`'s own doc comment
    // explains why `raw_type_ref_of_ts_type` itself cannot do this).
    let return_type = patch_predicate_parameter_position(return_type, &function.params);
    // E-P0q: annotation-present-but-unclassified must never fall through to
    // body inference -- see `member_entry_of_class_element`'s own comment.
    let pending_return = function
        .return_type
        .is_none()
        .then(|| {
            collect_pending_return_shapes(
                function.body.as_deref(),
                None,
                false,
                path,
                scoping,
                import_specifiers,
            )
        })
        .flatten();
    Some(FunctionSummary {
        entity_id,
        return_type,
        pending_return,
        is_async: function.r#async,
    })
}

/// E-P0q (2026-09-09): if `return_type` is `RawTypeRef::TypePredicate` whose
/// own `subject` is `PredicateSubject::Parameter { position: None, .. }` (the
/// state every predicate leaves `raw_type_ref_of_ts_type` in -- see that
/// variant's own doc comment), look `name` up among `params`' own PLAIN
/// identifier parameters (`parameter_position_by_name`) and fill `position`
/// in; every other shape (a non-predicate return type, a `this is T`
/// predicate, a predicate whose parameter name matches no plain-identifier
/// parameter -- a destructured/rest one, or a typo`) passes through
/// unchanged.
fn patch_predicate_parameter_position(
    return_type: RawTypeRef,
    params: &oxc_ast::ast::FormalParameters,
) -> RawTypeRef {
    let RawTypeRef::TypePredicate { subject, target } = return_type else {
        return return_type;
    };
    let subject = match subject {
        PredicateSubject::Parameter { name, position: _ } => {
            let position = parameter_position_by_name(params, &name);
            PredicateSubject::Parameter { name, position }
        }
        PredicateSubject::Receiver => PredicateSubject::Receiver,
    };
    RawTypeRef::TypePredicate { subject, target }
}

/// E-P0q (2026-09-09): the zero-based index of `name` among `params`' own
/// entries, considering ONLY a plain identifier binding (`BindingPattern::
/// BindingIdentifier`) -- a destructured (`{ a, b }`/`[a, b]`) or rest
/// parameter never qualifies (same certainty bar `push_constructor_
/// parameter_property_declarations` already applies to a parameter
/// property's own binding). `None` when no parameter matches -- never a
/// guess.
fn parameter_position_by_name(
    params: &oxc_ast::ast::FormalParameters,
    name: &str,
) -> Option<usize> {
    use oxc_ast::ast::BindingPattern;
    params.items.iter().position(|param| {
        matches!(&param.pattern, BindingPattern::BindingIdentifier(ident) if ident.name.as_str() == name)
    })
}

/// P1-A (object-literal shape): `Some(ObjectShapeSummary)` only for a
/// `const X = { ... }` declarator (a plain `BindingIdentifier`, an
/// `ObjectExpression` initializer) -- see `ObjectShapeSummary`'s doc
/// comment for the exact member-extraction rule (function/arrow-function-
/// valued properties only, keyed by their own declared return type).
fn summarize_object_shape(
    declarator: &oxc_ast::ast::VariableDeclarator,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    synthetic_interfaces: &mut Vec<InterfaceSummary>,
) -> Option<ObjectShapeSummary> {
    use oxc_ast::ast::BindingPattern;
    let BindingPattern::BindingIdentifier(ident) = &declarator.id else {
        return None;
    };
    let Some(Expression::ObjectExpression(object)) = &declarator.init else {
        return None;
    };
    let entity_id = declaration_id("variable", path, ident.span.start, ident.name.as_str());
    let members = object_shape_members_of(
        object,
        path,
        scoping,
        import_specifiers,
        synthetic_interfaces,
    );
    Some(ObjectShapeSummary { entity_id, members })
}

/// P1-C: factored out of `summarize_object_shape` so a top-level CALLABLE's
/// own body -- `const f = (...) => ({ ... })`, see `collect_callable_
/// variable`'s doc comment -- can synthesize the SAME kind of member-
/// bearing container for its RETURNED object literal that a direct `const X
/// = { ... }` shape already gets, reusing the exact same member-extraction
/// rule (function/arrow-valued properties only, keyed by their own declared
/// -- or P1-B shallow-inferred -- return type).
fn object_shape_members_of(
    object: &oxc_ast::ast::ObjectExpression,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    synthetic_interfaces: &mut Vec<InterfaceSummary>,
) -> Vec<MemberEntry> {
    use oxc_ast::ast::ObjectPropertyKind;
    let mut members = Vec::new();
    for property in &object.properties {
        let ObjectPropertyKind::ObjectProperty(property) = property else {
            continue;
        };
        if property.computed {
            continue;
        }
        let Some((key_start, key_name)) = property_key_name(&property.key) else {
            continue;
        };
        // P1-B: an unannotated arrow/function-valued property's own body is
        // now also eligible for return-type inference (see
        // `DeferredReturnShape`'s doc comment) -- widened from P1-A, which
        // skipped any such property outright (`return_type_annotation`
        // required). `this` inside such a property is never entity-backed
        // here (an object literal has no stable class identity of its own,
        // unlike a class method), so inference never attempts a `this`/
        // `MemberOf` shape for one -- only `new T()`, a plain-function
        // call, and one layer of `await` around either.
        let (type_ref, pending_return, is_async) = match &property.value {
            Expression::ArrowFunctionExpression(function) => {
                let type_ref = raw_type_ref_of_annotation(
                    function.return_type.as_deref(),
                    path,
                    scoping,
                    import_specifiers,
                    synthetic_interfaces,
                );
                let pending_return = function
                    .return_type
                    .is_none()
                    .then(|| {
                        if function.expression {
                            collect_pending_return_shapes_concise(
                                &function.body,
                                path,
                                scoping,
                                import_specifiers,
                            )
                        } else {
                            collect_pending_return_shapes(
                                Some(&function.body),
                                None,
                                false,
                                path,
                                scoping,
                                import_specifiers,
                            )
                        }
                    })
                    .flatten();
                (type_ref, pending_return, function.r#async)
            }
            Expression::FunctionExpression(function) => {
                let type_ref = raw_type_ref_of_annotation(
                    function.return_type.as_deref(),
                    path,
                    scoping,
                    import_specifiers,
                    synthetic_interfaces,
                );
                let pending_return = function
                    .return_type
                    .is_none()
                    .then(|| {
                        collect_pending_return_shapes(
                            function.body.as_deref(),
                            None,
                            false,
                            path,
                            scoping,
                            import_specifiers,
                        )
                    })
                    .flatten();
                (type_ref, pending_return, function.r#async)
            }
            _ => continue,
        };
        members.push(MemberEntry {
            name: key_name.clone(),
            is_static: false,
            entity_id: declaration_id("method", path, key_start, &key_name),
            type_ref,
            pending_return,
            is_async,
        });
    }
    members
}

/// P1-C: `const f = (...) => <expr>` / `const f = function(...) { ... }` --
/// a top-level (or `export`ed) callable value this crate did not previously
/// index AT ALL for its own call-return type (only a real `function`
/// keyword declaration's return type ever reached `function_return_types`,
/// via `summarize_function`). Found live, the dominant root cause behind
/// this corpus's own `ReturnType<typeof f>` pattern: `export const
/// createSchemaBuilder = (tablePrefix, queryRunner) => ({ createTable: ...,
/// column: ..., ... });` in the migration DSL's own `dsl/index.ts` -- `f`
/// is never a `function` declaration, so P1-A/P1-B's own `summarize_
/// function` never saw it, and `summarize_object_shape` never saw it either
/// (its OWN initializer is an arrow FUNCTION, not a plain object literal --
/// see that function's own doc comment for why the two are distinct
/// shapes). Deliberately narrow, matching this crate's own "never widen
/// past what's proven" rule: only an EXPLICIT return-type annotation, or a
/// concise arrow body (`() => (expr)`/`() => expr`) whose own expression is
/// DIRECTLY an object literal (synthesized into an `ObjectShapeSummary` the
/// exact same way `summarize_object_shape` does for a direct `const X = {
/// ... }`, via the shared `object_shape_members_of`), are ever classified;
/// a block-bodied arrow/function-expression with no annotation, or a
/// concise body that is not an object literal, is `RawTypeRef::Unknown` --
/// no shallow body-return inference (P1-B's own fixed point) is attempted
/// for a callable VARIABLE in this pass, only for a real function/method
/// (a real next lever, not attempted this session for time).
fn collect_callable_variable(
    declarator: &oxc_ast::ast::VariableDeclarator,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    synthetic_interfaces: &mut Vec<InterfaceSummary>,
    synthetic_object_shapes: &mut Vec<ObjectShapeSummary>,
) -> Option<FunctionSummary> {
    use oxc_ast::ast::{BindingPattern, Expression as Expr};
    let BindingPattern::BindingIdentifier(ident) = &declarator.id else {
        return None;
    };
    let entity_id = declaration_id("variable", path, ident.span.start, ident.name.as_str());
    match declarator.init.as_ref()? {
        Expr::ArrowFunctionExpression(function) => {
            let annotated = raw_type_ref_of_annotation(
                function.return_type.as_deref(),
                path,
                scoping,
                import_specifiers,
                synthetic_interfaces,
            );
            // E-P0q: an explicit annotation wins even when this crate cannot
            // classify it (never a concise-body guess past a written type).
            let return_type = if function.return_type.is_some() {
                annotated
            } else if function.expression {
                concise_arrow_object_literal_shape(
                    &function.body,
                    path,
                    scoping,
                    import_specifiers,
                    synthetic_interfaces,
                    synthetic_object_shapes,
                )
            } else {
                RawTypeRef::Unknown
            };
            Some(FunctionSummary {
                entity_id,
                return_type,
                pending_return: None,
                is_async: function.r#async,
            })
        }
        Expr::FunctionExpression(function) => {
            let return_type = raw_type_ref_of_annotation(
                function.return_type.as_deref(),
                path,
                scoping,
                import_specifiers,
                synthetic_interfaces,
            );
            Some(FunctionSummary {
                entity_id,
                return_type,
                pending_return: None,
                is_async: function.r#async,
            })
        }
        _ => None,
    }
}

/// P1-C: `() => ({ ... })` / `() => expr` (oxc's own single-`ExpressionStatement`
/// concise-arrow-body representation) -- `RawTypeRef::Local` of a synthetic
/// object-shape container ONLY when that single expression is (optionally
/// parenthesized) DIRECTLY an object literal; `Unknown` for anything else
/// (a call, a conditional, a template literal, ...) -- never a guess.
fn concise_arrow_object_literal_shape(
    body: &FunctionBody,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    synthetic_interfaces: &mut Vec<InterfaceSummary>,
    synthetic_object_shapes: &mut Vec<ObjectShapeSummary>,
) -> RawTypeRef {
    let Some(Statement::ExpressionStatement(expr_stmt)) = body.statements.first() else {
        return RawTypeRef::Unknown;
    };
    let mut expr = &expr_stmt.expression;
    while let Expression::ParenthesizedExpression(parenthesized) = expr {
        expr = &parenthesized.expression;
    }
    let Expression::ObjectExpression(object) = expr else {
        return RawTypeRef::Unknown;
    };
    let entity_id = format!(
        "typeflow:callable_object_shape:{path}:{}",
        object.span.start
    );
    let members = object_shape_members_of(
        object,
        path,
        scoping,
        import_specifiers,
        synthetic_interfaces,
    );
    // Pushed as an `ObjectShapeSummary` (a purely-internal, non-`jsts:`-
    // prefixed entity id, never itself published as a `target_id`, only an
    // intermediate lookup key in `ProgramIndex::containers` -- same
    // discipline as every other synthetic container in this crate), NOT a
    // plain `InterfaceSummary`: its own members carry a REAL, possibly-
    // unannotated function body (`createTable(name) { ... }`), so it must
    // be eligible for `ProgramIndex::build`'s third-pass shallow return-
    // inference fixed point the same way a direct `const X = { ... }`
    // object-literal shape already is (that pass only ever walks `summary.
    // classes`/`summary.object_shapes`, never `summary.interfaces` --
    // interface/type-literal members never have a body to infer from, so
    // this distinction matters here for the first time).
    synthetic_object_shapes.push(ObjectShapeSummary {
        entity_id: entity_id.clone(),
        members,
    });
    RawTypeRef::Local(entity_id)
}

/// P1-B: classify every `return <expr>;` statement reachable from
/// `statement` WITHOUT crossing into a nested function/arrow/class (those
/// have their own, separate `this`/return scope -- see the module doc's
/// "never widen past what's proven" rule and P1-A's own nested-function
/// `this`-rebinding fix) directly into `out`, short-circuiting the instant
/// ANY one classifies to `DeferredReturnShape::Unknown` (`found_unknown` set
/// -- checked by the caller after the whole body is walked; a single
/// unresolvable return statement anywhere drops the WHOLE function's
/// inference, matching `classify_return_shape`'s own contract) --
/// recurses through every control-flow statement shape that can directly
/// contain a `return` in the SAME function (block/if/try/switch/loops/
/// labeled), stopping at anything else. Classifies inline (rather than
/// collecting borrowed `&Expression` references first) purely to sidestep
/// threading the arena lifetime through an intermediate `Vec` -- no
/// behavioral difference.
#[allow(clippy::too_many_arguments)]
fn collect_return_shapes_from_statement(
    statement: &Statement,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    enclosing_class_id: Option<&str>,
    enclosing_is_static: bool,
    out: &mut Vec<DeferredReturnShape>,
    found_unknown: &mut bool,
) {
    if *found_unknown {
        return;
    }
    match statement {
        Statement::ReturnStatement(ret) => {
            if let Some(argument) = &ret.argument {
                let shape = classify_return_shape(
                    argument,
                    path,
                    scoping,
                    import_specifiers,
                    enclosing_class_id,
                    enclosing_is_static,
                );
                if matches!(shape, DeferredReturnShape::Unknown) {
                    *found_unknown = true;
                    return;
                }
                if !out.contains(&shape) {
                    out.push(shape);
                }
            }
        }
        Statement::BlockStatement(block) => {
            for inner in &block.body {
                collect_return_shapes_from_statement(
                    inner,
                    path,
                    scoping,
                    import_specifiers,
                    enclosing_class_id,
                    enclosing_is_static,
                    out,
                    found_unknown,
                );
            }
        }
        Statement::IfStatement(if_stmt) => {
            collect_return_shapes_from_statement(
                &if_stmt.consequent,
                path,
                scoping,
                import_specifiers,
                enclosing_class_id,
                enclosing_is_static,
                out,
                found_unknown,
            );
            if let Some(alternate) = &if_stmt.alternate {
                collect_return_shapes_from_statement(
                    alternate,
                    path,
                    scoping,
                    import_specifiers,
                    enclosing_class_id,
                    enclosing_is_static,
                    out,
                    found_unknown,
                );
            }
        }
        Statement::TryStatement(try_stmt) => {
            for inner in &try_stmt.block.body {
                collect_return_shapes_from_statement(
                    inner,
                    path,
                    scoping,
                    import_specifiers,
                    enclosing_class_id,
                    enclosing_is_static,
                    out,
                    found_unknown,
                );
            }
            if let Some(handler) = &try_stmt.handler {
                for inner in &handler.body.body {
                    collect_return_shapes_from_statement(
                        inner,
                        path,
                        scoping,
                        import_specifiers,
                        enclosing_class_id,
                        enclosing_is_static,
                        out,
                        found_unknown,
                    );
                }
            }
            if let Some(finalizer) = &try_stmt.finalizer {
                for inner in &finalizer.body {
                    collect_return_shapes_from_statement(
                        inner,
                        path,
                        scoping,
                        import_specifiers,
                        enclosing_class_id,
                        enclosing_is_static,
                        out,
                        found_unknown,
                    );
                }
            }
        }
        Statement::SwitchStatement(switch_stmt) => {
            for case in &switch_stmt.cases {
                for inner in &case.consequent {
                    collect_return_shapes_from_statement(
                        inner,
                        path,
                        scoping,
                        import_specifiers,
                        enclosing_class_id,
                        enclosing_is_static,
                        out,
                        found_unknown,
                    );
                }
            }
        }
        Statement::ForStatement(for_stmt) => collect_return_shapes_from_statement(
            &for_stmt.body,
            path,
            scoping,
            import_specifiers,
            enclosing_class_id,
            enclosing_is_static,
            out,
            found_unknown,
        ),
        Statement::ForInStatement(for_stmt) => collect_return_shapes_from_statement(
            &for_stmt.body,
            path,
            scoping,
            import_specifiers,
            enclosing_class_id,
            enclosing_is_static,
            out,
            found_unknown,
        ),
        Statement::ForOfStatement(for_stmt) => collect_return_shapes_from_statement(
            &for_stmt.body,
            path,
            scoping,
            import_specifiers,
            enclosing_class_id,
            enclosing_is_static,
            out,
            found_unknown,
        ),
        Statement::WhileStatement(while_stmt) => collect_return_shapes_from_statement(
            &while_stmt.body,
            path,
            scoping,
            import_specifiers,
            enclosing_class_id,
            enclosing_is_static,
            out,
            found_unknown,
        ),
        Statement::DoWhileStatement(do_while) => collect_return_shapes_from_statement(
            &do_while.body,
            path,
            scoping,
            import_specifiers,
            enclosing_class_id,
            enclosing_is_static,
            out,
            found_unknown,
        ),
        Statement::LabeledStatement(labeled) => collect_return_shapes_from_statement(
            &labeled.body,
            path,
            scoping,
            import_specifiers,
            enclosing_class_id,
            enclosing_is_static,
            out,
            found_unknown,
        ),
        // A nested class/function declaration and everything else
        // deliberately fall through untouched -- a `return` cannot appear
        // directly inside them without first crossing into a new function
        // scope, which this walker never does.
        _ => {}
    }
}

/// P1-B: classify every return statement in `body` (see
/// `collect_return_shapes_from_statement`), `None` when `body` is absent (an
/// overload signature with no implementation) OR there are no `return
/// <expr>;` statements at all (nothing to infer from -- a bare `return;`/
/// implicit fall-off-the-end always means `undefined`, out of scope) OR ANY
/// one of them classifies to a `DeferredReturnShape` that cannot be
/// interpreted -- the whole function's inference is dropped rather than
/// guessed from the resolvable remainder, matching this crate's "never
/// widen past what's proven" rule applied to a WHOLE declaration rather
/// than one expression.
fn collect_pending_return_shapes(
    body: Option<&FunctionBody>,
    enclosing_class_id: Option<&str>,
    enclosing_is_static: bool,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
) -> Option<Vec<DeferredReturnShape>> {
    let body = body?;
    let mut shapes: Vec<DeferredReturnShape> = Vec::new();
    let mut found_unknown = false;
    for statement in &body.statements {
        collect_return_shapes_from_statement(
            statement,
            path,
            scoping,
            import_specifiers,
            enclosing_class_id,
            enclosing_is_static,
            &mut shapes,
            &mut found_unknown,
        );
    }
    if found_unknown || shapes.is_empty() {
        return None;
    }
    Some(shapes)
}

/// P1-B: the concise-arrow-body counterpart of `collect_pending_return_
/// shapes` (`() => expr`, oxc's own single-`ExpressionStatement`
/// representation of it) -- exactly one implicit "return", never a
/// `this`/`MemberOf` shape (see `summarize_object_shape`'s own doc comment
/// for why an object-literal arrow property never gets one).
fn collect_pending_return_shapes_concise(
    body: &FunctionBody,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
) -> Option<Vec<DeferredReturnShape>> {
    let Statement::ExpressionStatement(expr_stmt) = body.statements.first()? else {
        return None;
    };
    let shape = classify_return_shape(
        &expr_stmt.expression,
        path,
        scoping,
        import_specifiers,
        None,
        false,
    );
    if matches!(shape, DeferredReturnShape::Unknown) {
        return None;
    }
    Some(vec![shape])
}

/// P1-B: classify one return-position EXPRESSION into a `DeferredReturnShape`
/// -- see that type's own doc comment for the exact taxonomy. `enclosing_
/// class_id`/`enclosing_is_static` are `Some`/meaningful only inside a class
/// method's own body (a `this`/`MemberOf` shape is `Unknown` everywhere
/// else, e.g. a top-level function or an object-literal property).
fn classify_return_shape(
    expr: &Expression,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    enclosing_class_id: Option<&str>,
    enclosing_is_static: bool,
) -> DeferredReturnShape {
    match expr {
        Expression::ParenthesizedExpression(parenthesized) => classify_return_shape(
            &parenthesized.expression,
            path,
            scoping,
            import_specifiers,
            enclosing_class_id,
            enclosing_is_static,
        ),
        Expression::ThisExpression(_) => match enclosing_class_id {
            Some(_) => DeferredReturnShape::Known(RawTypeRef::ThisType),
            None => DeferredReturnShape::Unknown,
        },
        Expression::NewExpression(new_expr) => match &new_expr.callee {
            Expression::Identifier(ident) => DeferredReturnShape::Known(
                classify_heritage_identifier(ident, path, scoping, import_specifiers).into(),
            ),
            _ => DeferredReturnShape::Unknown,
        },
        Expression::AwaitExpression(await_expr) => {
            DeferredReturnShape::AwaitOf(Box::new(classify_return_shape(
                &await_expr.argument,
                path,
                scoping,
                import_specifiers,
                enclosing_class_id,
                enclosing_is_static,
            )))
        }
        Expression::CallExpression(call) => match &call.callee {
            Expression::Identifier(ident) => {
                classify_call_identifier(ident, path, scoping, import_specifiers)
            }
            Expression::StaticMemberExpression(member) => {
                match (&member.object, enclosing_class_id) {
                    (Expression::ThisExpression(_), Some(container)) => {
                        DeferredReturnShape::MemberOf {
                            container: container.to_owned(),
                            name: member.property.name.as_str().to_owned(),
                            is_static: enclosing_is_static,
                        }
                    }
                    _ => DeferredReturnShape::Unknown,
                }
            }
            _ => DeferredReturnShape::Unknown,
        },
        Expression::StaticMemberExpression(member) => match (&member.object, enclosing_class_id) {
            (Expression::ThisExpression(_), Some(container)) => DeferredReturnShape::MemberOf {
                container: container.to_owned(),
                name: member.property.name.as_str().to_owned(),
                is_static: enclosing_is_static,
            },
            _ => DeferredReturnShape::Unknown,
        },
        _ => DeferredReturnShape::Unknown,
    }
}

/// P1-B: classify a plain-identifier CALL callee (`f(...)`) into a
/// `DeferredReturnShape::CallEntity`, mirroring `classify_heritage_
/// identifier`'s own import/local-symbol classification but gated on
/// `SymbolFlags::Function` (a class/interface/variable resolves here to
/// `Unknown` -- calling one of those directly is either invalid code this
/// crate will never see live, or a case out of scope, e.g. a locally-typed
/// callable value; never a guess).
fn classify_call_identifier(
    ident: &IdentifierReference,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
) -> DeferredReturnShape {
    let Some(reference_id) = ident.reference_id.get() else {
        return DeferredReturnShape::Unknown;
    };
    let reference = scoping.get_reference(reference_id);
    let Some(symbol_id) = reference.symbol_id() else {
        return DeferredReturnShape::Unknown;
    };
    if scoping.symbol_flags(symbol_id).is_import() {
        return match import_specifiers.get(&symbol_id) {
            Some((specifier, imported_name)) => {
                DeferredReturnShape::CallEntity(ReturnEntityRef::Imported {
                    specifier: specifier.clone(),
                    imported_name: imported_name.clone(),
                })
            }
            None => DeferredReturnShape::Unknown,
        };
    }
    if !scoping.symbol_redeclarations(symbol_id).is_empty() {
        return DeferredReturnShape::Unknown;
    }
    if scoping
        .symbol_flags(symbol_id)
        .contains(oxc_syntax::symbol::SymbolFlags::Function)
    {
        let target_start = scoping.symbol_span(symbol_id).start;
        let target_name = scoping.symbol_name(symbol_id);
        return DeferredReturnShape::CallEntity(ReturnEntityRef::Local(declaration_id(
            "function",
            path,
            target_start,
            target_name,
        )));
    }
    DeferredReturnShape::Unknown
}

/// P1-C: the `ReturnEntityRef` a `typeof f` type-query expression names --
/// used to classify `ReturnType<typeof f>` -- reusing `classify_call_
/// identifier`'s exact function-vs-import-vs-other-symbol classification
/// (the two need to agree byte for byte: `ReturnType<typeof f>` and a
/// `return f();` shape must resolve `f` identically). `None` for anything
/// but a plain `typeof <identifier>` naming a function (local declaration
/// or named import) -- a qualified name (`typeof ns.f`), `typeof this`, or
/// an identifier that does not classify to `DeferredReturnShape::CallEntity`
/// (a class, a variable, an unresolved global, ...) is never a guess here.
fn return_entity_ref_of_type_query(
    ty: &TSType,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
) -> Option<ReturnEntityRef> {
    let TSType::TSTypeQuery(query) = ty else {
        return None;
    };
    let TSTypeQueryExprName::IdentifierReference(ident) = &query.expr_name else {
        return None;
    };
    classify_typeof_target_identifier(ident, path, scoping, import_specifiers)
}

/// P1-C: the `ReturnEntityRef` a `typeof f` type-query names, WIDER than
/// `classify_call_identifier`'s own local branch (kept as-is, unwidened,
/// for the P1-B return-shape fixed point it also feeds -- see this
/// function's own callers): a local symbol resolves here regardless of
/// whether it is a `function` DECLARATION (`SymbolFlags::Function`) or a
/// callable VARIABLE (`const f = (...) => ...`/`const f = function(...)
/// {...}`, see `DeclSummary::callable_variables`'s doc comment) -- the
/// entity id's own KIND segment (`"function"` vs `"variable"`) is picked to
/// match whichever `declaration_id` the actual declaration site produces,
/// so `function_return_types.get(&entity_id)` (populated for BOTH kinds by
/// `ProgramIndex::build`) finds it either way. An imported reference
/// resolves identically to `classify_call_identifier`'s own import branch
/// (kind-agnostic -- the exported entity id is whatever `import_targets`,
/// closed by the caller, already says).
fn classify_typeof_target_identifier(
    ident: &IdentifierReference,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
) -> Option<ReturnEntityRef> {
    let reference_id = ident.reference_id.get()?;
    let reference = scoping.get_reference(reference_id);
    let symbol_id = reference.symbol_id()?;
    if scoping.symbol_flags(symbol_id).is_import() {
        let (specifier, imported_name) = import_specifiers.get(&symbol_id)?;
        return Some(ReturnEntityRef::Imported {
            specifier: specifier.clone(),
            imported_name: imported_name.clone(),
        });
    }
    if !scoping.symbol_redeclarations(symbol_id).is_empty() {
        return None;
    }
    let target_start = scoping.symbol_span(symbol_id).start;
    let target_name = scoping.symbol_name(symbol_id);
    let kind = if scoping
        .symbol_flags(symbol_id)
        .contains(oxc_syntax::symbol::SymbolFlags::Function)
    {
        "function"
    } else {
        "variable"
    };
    Some(ReturnEntityRef::Local(declaration_id(
        kind,
        path,
        target_start,
        target_name,
    )))
}

/// P1-C: classify one operand of a `TSType` (an intersection member, or any
/// other position that needs a HERITAGE-shaped target rather than a full
/// `RawTypeRef`) into a `HeritageTarget` -- widens `heritage_target_of_
/// type_name` to also accept an anonymous `{ ... }` type literal (found
/// live in intersection patterns like `Options & { extra: string }`),
/// synthesizing the SAME kind of purely-internal container `raw_type_ref_
/// of_ts_type`'s own `TSTypeLiteral` arm does, so `HeritageTarget::Local`
/// can name it. Anything else (a generic instantiation, a union, a mapped/
/// conditional type, ...) is `Unknown` -- an intersection operand this
/// crate cannot classify is simply DROPPED from the merged `extends` list
/// (see `raw_type_ref_of_ts_type`'s `TSIntersectionType` arm), never a
/// guess.
fn heritage_target_of_ts_type(
    ty: &TSType,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    synthetic_interfaces: &mut Vec<InterfaceSummary>,
) -> HeritageTarget {
    match ty {
        TSType::TSTypeReference(reference) => {
            heritage_target_of_type_name(&reference.type_name, path, scoping, import_specifiers)
        }
        TSType::TSTypeLiteral(literal) => {
            let entity_id = format!("typeflow:type_literal:{path}:{}", literal.span.start);
            let members = literal
                .members
                .iter()
                .filter_map(|signature| {
                    member_entry_of_signature(
                        signature,
                        path,
                        scoping,
                        import_specifiers,
                        synthetic_interfaces,
                    )
                })
                .collect();
            synthetic_interfaces.push(InterfaceSummary {
                entity_id: entity_id.clone(),
                extends: Vec::new(),
                members,
            });
            HeritageTarget::Local(entity_id)
        }
        TSType::TSParenthesizedType(parenthesized) => heritage_target_of_ts_type(
            &parenthesized.type_annotation,
            path,
            scoping,
            import_specifiers,
            synthetic_interfaces,
        ),
        _ => HeritageTarget::Unknown,
    }
}

/// P1-A: classify a `TSType`'s declared shape into a `RawTypeRef`, chasing
/// through `T[]`/`Promise<T>`/`Array<T>`/`ReadonlyArray<T>` wrappers one
/// level of type arguments deep (recursively, so `Promise<Foo[]>` erases to
/// `PromiseOf(ArrayOf(Local(Foo)))`) and TypeScript's own `this` type.
/// Anything else (union, intersection, conditional, mapped, keyof, tuple, a
/// qualified type name, a generic type-parameter reference, ...) is
/// `RawTypeRef::Unknown` -- never a guess.
/// `synthetic_interfaces` accumulates every ANONYMOUS `{ ... }` type-
/// literal shape reached while classifying `ty` (rule (j), partial: an
/// inline object type, as opposed to a NAMED interface/type-alias) -- found
/// live in this corpus's own migration DSL (`escape: { columnName(name):
/// string; ... }`). Each one gets a synthetic, purely-internal entity id
/// (never a checker-matching identity -- it is never itself published as a
/// `target_id`, only used as an intermediate lookup key in `ProgramIndex::
/// containers`, see `member_type_ref`'s doc comment) and is pushed as an
/// ordinary `InterfaceSummary` (no `extends`, since a type literal has
/// none) so every existing member-lookup code path picks it up for free.
/// Nesting is exactly one level deep: a member INSIDE a type literal whose
/// own type is ANOTHER type literal recurses fine (`member_entry_of_
/// signature` calls back into this same function), but a type literal
/// reached through a generic type ARGUMENT other than `Promise`/`Array`/
/// `ReadonlyArray` is out of scope, same as everywhere else in this crate.
fn raw_type_ref_of_ts_type(
    ty: &TSType,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    synthetic_interfaces: &mut Vec<InterfaceSummary>,
) -> RawTypeRef {
    match ty {
        TSType::TSThisType(_) => RawTypeRef::ThisType,
        TSType::TSParenthesizedType(parenthesized) => raw_type_ref_of_ts_type(
            &parenthesized.type_annotation,
            path,
            scoping,
            import_specifiers,
            synthetic_interfaces,
        ),
        TSType::TSArrayType(array) => RawTypeRef::ArrayOf(Box::new(raw_type_ref_of_ts_type(
            &array.element_type,
            path,
            scoping,
            import_specifiers,
            synthetic_interfaces,
        ))),
        TSType::TSTypeReference(reference) => {
            let TSTypeName::IdentifierReference(ident) = &reference.type_name else {
                return RawTypeRef::Unknown;
            };
            let name = ident.name.as_str();
            if let Some(type_arguments) = &reference.type_arguments {
                let params = &type_arguments.params;
                if name == "Promise" && params.len() == 1 {
                    return RawTypeRef::PromiseOf(Box::new(raw_type_ref_of_ts_type(
                        &params[0],
                        path,
                        scoping,
                        import_specifiers,
                        synthetic_interfaces,
                    )));
                }
                if (name == "Array" || name == "ReadonlyArray") && params.len() == 1 {
                    return RawTypeRef::ArrayOf(Box::new(raw_type_ref_of_ts_type(
                        &params[0],
                        path,
                        scoping,
                        import_specifiers,
                        synthetic_interfaces,
                    )));
                }
                // P1-C: `Record<K, V>` -- only `V` (the element type an
                // indexed/computed access unwraps) is ever kept; `K` is
                // never inspected, see `RawTypeRef::RecordOf`'s doc comment.
                if name == "Record" && params.len() == 2 {
                    return RawTypeRef::RecordOf(Box::new(raw_type_ref_of_ts_type(
                        &params[1],
                        path,
                        scoping,
                        import_specifiers,
                        synthetic_interfaces,
                    )));
                }
                // P1-C: `Partial`/`Required`/`Readonly`/`NonNullable<T>` --
                // erase the wrapper entirely and use `T`'s own member table
                // unmodified. Sound for every one of these: none of them
                // ever changes WHICH members `T` has, only whether they are
                // optional/mutable, or (for `NonNullable`) removes `null`/
                // `undefined` from a union `T` never had as a distinct
                // shape here in the first place (this crate has no union
                // representation yet -- see `RawTypeRef::Unknown`'s own doc
                // comment -- so `NonNullable<T>` and plain `T` already
                // classify identically for every `T` this crate reasons
                // about).
                if matches!(name, "Partial" | "Required" | "Readonly" | "NonNullable")
                    && params.len() == 1
                {
                    return raw_type_ref_of_ts_type(
                        &params[0],
                        path,
                        scoping,
                        import_specifiers,
                        synthetic_interfaces,
                    );
                }
                // P1-C: `Pick<T, K>`/`Omit<T, K>` -- per the task's own
                // framing, keep `T`'s FULL member table rather than
                // narrowing it to/excluding `K`: a member `Omit` removed
                // (or `Pick` didn't select) still resolves to the SAME
                // entity a call site naming it would have meant on `T`
                // directly -- never a WRONG target, only a theoretical
                // over-acceptance of a member TypeScript itself would flag
                // as a compile error at that call site (out of scope: this
                // crate never re-implements the checker's own excess-
                // property/narrowing diagnostics, only entity resolution).
                if matches!(name, "Pick" | "Omit") && params.len() == 2 {
                    return raw_type_ref_of_ts_type(
                        &params[0],
                        path,
                        scoping,
                        import_specifiers,
                        synthetic_interfaces,
                    );
                }
                // P1-C: `Awaited<T>` -- fully unwraps every `PromiseOf`
                // layer `T` classifies to (TypeScript's own `Awaited`
                // recursively unwraps nested thenables); `Awaited` of a
                // non-promise `T` is `T` itself, unchanged.
                if name == "Awaited" && params.len() == 1 {
                    let mut inner = raw_type_ref_of_ts_type(
                        &params[0],
                        path,
                        scoping,
                        import_specifiers,
                        synthetic_interfaces,
                    );
                    while let RawTypeRef::PromiseOf(unwrapped) = inner {
                        inner = *unwrapped;
                    }
                    return inner;
                }
                // P1-C: `ReturnType<typeof f>` -- see `RawTypeRef::
                // ReturnTypeOfFn`'s doc comment. `Unknown` (never a guess)
                // when the single type argument is not a plain `typeof
                // <function-identifier>` this crate can classify.
                if name == "ReturnType" && params.len() == 1 {
                    return match return_entity_ref_of_type_query(
                        &params[0],
                        path,
                        scoping,
                        import_specifiers,
                    ) {
                        Some(entity_ref) => RawTypeRef::ReturnTypeOfFn(entity_ref),
                        None => RawTypeRef::Unknown,
                    };
                }
                // P1-C: `InstanceType<typeof C>` -- the instance type of
                // constructor `C` is exactly `C` itself (generic type
                // arguments already erased everywhere else in this crate,
                // same discipline here); classified the SAME way a `new
                // C()` heritage/return target already is.
                if name == "InstanceType" && params.len() == 1 {
                    if let TSType::TSTypeQuery(query) = &params[0]
                        && let TSTypeQueryExprName::IdentifierReference(inst_ident) =
                            &query.expr_name
                    {
                        return classify_heritage_identifier(
                            inst_ident,
                            path,
                            scoping,
                            import_specifiers,
                        )
                        .into();
                    }
                    return RawTypeRef::Unknown;
                }
            }
            classify_heritage_identifier(ident, path, scoping, import_specifiers).into()
        }
        // P1-C: `A & B` -- see `heritage_target_of_ts_type`'s doc comment.
        // A synthetic, purely-internal container whose OWN member list is
        // empty and whose `extends` is every classifiable operand IN
        // ORDER -- `ProgramIndex::collect_members`'s existing own-body-
        // then-`extends`-in-order walk already gives exactly the "A first"
        // priority the task asks for, with zero new lookup logic. An
        // operand this crate cannot classify (a generic instantiation, a
        // union, ...) is simply dropped from the list, never a guess; if
        // EVERY operand drops, the whole intersection is `Unknown`.
        TSType::TSIntersectionType(intersection) => {
            let extends: Vec<HeritageTarget> = intersection
                .types
                .iter()
                .map(|operand| {
                    heritage_target_of_ts_type(
                        operand,
                        path,
                        scoping,
                        import_specifiers,
                        synthetic_interfaces,
                    )
                })
                .filter(|target| !matches!(target, HeritageTarget::Unknown))
                .collect();
            if extends.is_empty() {
                return RawTypeRef::Unknown;
            }
            let entity_id = format!("typeflow:intersection:{path}:{}", intersection.span.start);
            synthetic_interfaces.push(InterfaceSummary {
                entity_id: entity_id.clone(),
                extends,
                members: Vec::new(),
            });
            RawTypeRef::Local(entity_id)
        }
        // P1-C: `T["k"]` -- see `RawTypeRef::IndexedAccess`'s doc comment.
        // Only a single STRING-LITERAL key is ever attempted (`T["k"]`, not
        // `T[K]`/`T["a" | "b"]`/`T[keyof T]`) -- never a guess.
        TSType::TSIndexedAccessType(indexed) => {
            let TSType::TSLiteralType(literal) = &indexed.index_type else {
                return RawTypeRef::Unknown;
            };
            let TSLiteral::StringLiteral(key) = &literal.literal else {
                return RawTypeRef::Unknown;
            };
            let base = raw_type_ref_of_ts_type(
                &indexed.object_type,
                path,
                scoping,
                import_specifiers,
                synthetic_interfaces,
            );
            RawTypeRef::IndexedAccess {
                base: Box::new(base),
                key: key.value.as_str().to_owned(),
            }
        }
        TSType::TSTypeLiteral(literal) => {
            let entity_id = format!("typeflow:type_literal:{path}:{}", literal.span.start);
            let members = literal
                .members
                .iter()
                .filter_map(|signature| {
                    member_entry_of_signature(
                        signature,
                        path,
                        scoping,
                        import_specifiers,
                        synthetic_interfaces,
                    )
                })
                .collect();
            synthetic_interfaces.push(InterfaceSummary {
                entity_id: entity_id.clone(),
                extends: Vec::new(),
                members,
            });
            RawTypeRef::Local(entity_id)
        }
        // P2-2j: `A | B` -- see `RawTypeRef::Union`'s own doc comment for
        // the full contract (drop null/undefined/literal/primitive
        // constituents, contaminate to `Unknown` on any other unclassified
        // remaining constituent, dedupe, collapse a single survivor).
        TSType::TSUnionType(union) => {
            let mut constituents: Vec<RawTypeRef> = Vec::new();
            let mut has_real_primitive_constituent = false;
            for member in &union.types {
                if is_dropped_nullish_union_constituent(member) {
                    continue;
                }
                if is_real_primitive_union_constituent(member) {
                    // F (E-P0l, 2026-09-08): a REAL primitive/literal
                    // constituent (`string | TestId`) is NOT the same as
                    // `null`/`undefined` -- it has its own member table
                    // (`String.prototype.toString`, ...) that can
                    // genuinely collide with the class constituent's same-
                    // named member. Never drop it as if it were nullish;
                    // record its presence so the collapse rule below never
                    // silently promotes the sole remaining entity
                    // constituent to a confirmed receiver -- see the doc
                    // comment on `has_real_primitive_constituent`'s use
                    // below.
                    has_real_primitive_constituent = true;
                    continue;
                }
                let raw = raw_type_ref_of_ts_type(
                    member,
                    path,
                    scoping,
                    import_specifiers,
                    synthetic_interfaces,
                );
                if matches!(raw, RawTypeRef::Unknown) {
                    // Conservative contamination: one unclassifiable
                    // constituent (a generic, a nested union, `any`,
                    // `unknown`, ...) makes the WHOLE union `Unknown`,
                    // never a partial guess from the classifiable
                    // constituents alone.
                    return RawTypeRef::Unknown;
                }
                if !constituents.contains(&raw) {
                    constituents.push(raw);
                }
            }
            match constituents.len() {
                // Every constituent was null/undefined/literal/primitive
                // (`"a" | "b"`, `string | null`) -- nothing left to
                // represent as a member-lookup receiver.
                0 => RawTypeRef::Unknown,
                // A union that collapses to one distinct entity
                // constituent (`A | A`, `A | null`) is that constituent,
                // not a union -- UNLESS a real primitive/literal
                // constituent was also present (`string | TestId`): F
                // (E-P0l) -- that case must never collapse to the bare
                // entity (the primitive's own members are a genuine,
                // untracked collision risk), so it stays a one-element
                // `Union`, which never promotes past `Candidates`/`Many`
                // for a member/call site (see `RawTypeRef::Union`'s own
                // doc comment) -- pending/possible, never a guess. A pure
                // class union (`A | B`, no real primitive) is completely
                // unaffected by this flag.
                1 if !has_real_primitive_constituent => {
                    constituents.into_iter().next().expect("checked len == 1")
                }
                _ => RawTypeRef::Union(constituents),
            }
        }
        // G (E-P0l, 2026-09-08): a BARE `typeof <expr>` used directly as a
        // member's own declared type (as opposed to wrapped inside
        // `ReturnType<typeof f>`/`InstanceType<typeof C>`, both handled
        // above) -- see `RawTypeRef::TypeQuery`'s own doc comment. Reuses
        // `return_entity_ref_of_type_query` (the SAME classification
        // `ReturnType<typeof f>` uses above) exactly: `Some` only for a
        // plain identifier this crate can resolve, `None` for anything
        // else (a qualified name, `typeof this`, `typeof import(...)`) --
        // never a guess either way.
        TSType::TSTypeQuery(_) => RawTypeRef::TypeQuery(return_entity_ref_of_type_query(
            ty,
            path,
            scoping,
            import_specifiers,
        )),
        // E-P0p (2026-09-09): `this is T` / `param is T` -- see
        // `RawTypeRef::TypePredicate`'s own doc comment. `Unknown` (never a
        // guess) when the predicate has no `is T` clause at all (a bare
        // `asserts x` assertion function, TypeScript's OTHER predicate
        // shape -- out of scope, no live sample found; `TSTypePredicate::
        // type_annotation` is `None` for that syntax).
        TSType::TSTypePredicate(predicate) => {
            let Some(type_annotation) = &predicate.type_annotation else {
                return RawTypeRef::Unknown;
            };
            let subject = match &predicate.parameter_name {
                TSTypePredicateName::This(_) => PredicateSubject::Receiver,
                TSTypePredicateName::Identifier(ident) => PredicateSubject::Parameter {
                    name: ident.name.as_str().to_owned(),
                    // Patched in by `summarize_function` when it has the
                    // declaring function's own parameter LIST in scope --
                    // see `PredicateSubject::Parameter`'s own doc comment.
                    position: None,
                },
            };
            let target = raw_type_ref_of_ts_type(
                &type_annotation.type_annotation,
                path,
                scoping,
                import_specifiers,
                synthetic_interfaces,
            );
            RawTypeRef::TypePredicate {
                subject,
                target: Box::new(target),
            }
        }
        _ => RawTypeRef::Unknown,
    }
}

/// P2-2j: whether `ty` is one of the NULLISH constituent shapes a union
/// receiver drops silently and unconditionally -- `null`/`undefined`
/// (TypeScript's own nullability convention: `A | null` means "possibly-
/// null A", not a real second branch to look members up on) never have
/// class/interface members of their own to collide with anything, so
/// dropping them can never change which member a lookup finds. See
/// `is_real_primitive_union_constituent` for the DIFFERENT (never fully
/// silent) treatment a literal/primitive keyword type gets (F, E-P0l).
fn is_dropped_nullish_union_constituent(ty: &TSType) -> bool {
    matches!(ty, TSType::TSNullKeyword(_) | TSType::TSUndefinedKeyword(_))
}

/// F (E-P0l, 2026-09-08): whether `ty` is a literal/primitive keyword type
/// (`"a" | "b"`, `string`, `number`, `boolean`, `bigint`, `symbol`) inside a
/// union receiver. Unlike `null`/`undefined` (see `is_dropped_nullish_
/// union_constituent`), these DO have their own real member table
/// (`String.prototype.toString`, `Number.prototype.toFixed`, ...) that can
/// genuinely differ from a sibling class constituent's same-named member --
/// found live: `joinToString(base: string | TestId, b: string)` calling
/// `base.toString()`, which this crate used to silently resolve to
/// `TestId.toString` (wrong -- v3's real checker treats the receiver as
/// genuinely ambiguous). This function's own callers never resolve the
/// constituent to anything (this crate has no entity/member model for
/// built-in primitive prototypes) -- they only use its presence to block
/// the union-collapse shortcut, never to guess a target.
fn is_real_primitive_union_constituent(ty: &TSType) -> bool {
    matches!(
        ty,
        TSType::TSLiteralType(_)
            | TSType::TSStringKeyword(_)
            | TSType::TSNumberKeyword(_)
            | TSType::TSBooleanKeyword(_)
            | TSType::TSBigIntKeyword(_)
            | TSType::TSSymbolKeyword(_)
    )
}

/// `raw_type_ref_of_ts_type` over an optional `TSTypeAnnotation` (the shape
/// every property/method/function return-type annotation site actually
/// carries) -- `RawTypeRef::Unknown` when `annotation` is `None`
/// (unannotated).
fn raw_type_ref_of_annotation(
    annotation: Option<&TSTypeAnnotation>,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    synthetic_interfaces: &mut Vec<InterfaceSummary>,
) -> RawTypeRef {
    match annotation {
        Some(annotation) => raw_type_ref_of_ts_type(
            &annotation.type_annotation,
            path,
            scoping,
            import_specifiers,
            synthetic_interfaces,
        ),
        None => RawTypeRef::Unknown,
    }
}

/// Classify a plain-identifier heritage expression's binding: `Local` when
/// it resolves (through oxc's own symbol table, exactly like
/// `semantic_sites::resolve_identifier_to_kind`'s local branch) to a
/// same-file `ClassDeclaration`/`TSInterfaceDeclaration`, `Imported` when
/// the symbol is import-bound (see `HeritageTarget::Imported`'s doc
/// comment), `Unknown` for anything else (an unresolved global, an
/// ambiguous/redeclared local symbol, or a resolved local declaration that
/// is not itself a class/interface -- never a guess).
fn classify_heritage_identifier(
    ident: &IdentifierReference,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
) -> HeritageTarget {
    let Some(reference_id) = ident.reference_id.get() else {
        return HeritageTarget::Unknown;
    };
    let reference = scoping.get_reference(reference_id);
    let Some(symbol_id) = reference.symbol_id() else {
        return HeritageTarget::Unknown;
    };
    if scoping.symbol_flags(symbol_id).is_import() {
        return match import_specifiers.get(&symbol_id) {
            Some((specifier, imported_name)) => HeritageTarget::Imported {
                specifier: specifier.clone(),
                imported_name: imported_name.clone(),
            },
            None => HeritageTarget::Unknown,
        };
    }
    if !scoping.symbol_redeclarations(symbol_id).is_empty() {
        return HeritageTarget::Unknown;
    }
    let target_start = scoping.symbol_span(symbol_id).start;
    let target_name = scoping.symbol_name(symbol_id);
    // `AstNodes` (declaration node kinds) is only reachable off the
    // `Semantic` this scoping came from; re-deriving the kind from the
    // symbol's own flags avoids needing to also thread `AstNodes` through
    // here for a single classification.
    let flags = scoping.symbol_flags(symbol_id);
    if flags.contains(oxc_syntax::symbol::SymbolFlags::Class) {
        return HeritageTarget::Local(declaration_id("class", path, target_start, target_name));
    }
    if flags.contains(oxc_syntax::symbol::SymbolFlags::Interface) {
        return HeritageTarget::Local(declaration_id("interface", path, target_start, target_name));
    }
    // D.2 (2026-09-05, references-parity task): `class C extends Alias {}`
    // where `Alias` is a top-level `type Alias = Base` -- classified as a
    // `Local("type", ...)` id here, the SAME id `DeclSummary::type_aliases`
    // gives this declaration; `ProgramIndex::build`'s `resolve_heritage_
    // target` de-aliases it (via `alias_targets`) BEFORE `collect_members`
    // ever looks it up in `containers` (which is indexed by class/
    // interface/type-literal ids, never by a type-alias id) -- see that
    // function's own doc comment.
    if flags.contains(oxc_syntax::symbol::SymbolFlags::TypeAlias) {
        return HeritageTarget::Local(declaration_id("type", path, target_start, target_name));
    }
    HeritageTarget::Unknown
}

/// Erase a heritage expression's generic type arguments and classify its
/// root: `None` for anything but a plain identifier (a qualified name, a
/// `this`/computed expression, ...) -- matches `HeritageTarget::Unknown`'s
/// "never a guess" contract at the call site.
fn heritage_target_of_expression(
    expr: &Expression,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
) -> HeritageTarget {
    match expr {
        Expression::Identifier(ident) => {
            classify_heritage_identifier(ident, path, scoping, import_specifiers)
        }
        // P1-A: `<base>.<member>(...)` -- see `HeritageTarget::CallMember`'s
        // doc comment. Only a PLAIN-IDENTIFIER base and non-computed,
        // non-private member name are ever attempted (`Z.class(...)`); a
        // deeper chain (`a.b.c(...)`), a computed/private member, or any
        // other callee shape stays `Unknown`, never a guess.
        Expression::CallExpression(call) => {
            let Expression::StaticMemberExpression(member) = &call.callee else {
                return HeritageTarget::Unknown;
            };
            let Expression::Identifier(base_ident) = &member.object else {
                return HeritageTarget::Unknown;
            };
            let base = classify_heritage_identifier(base_ident, path, scoping, import_specifiers);
            HeritageTarget::CallMember {
                base: Box::new(base),
                member: member.property.name.as_str().to_owned(),
            }
        }
        _ => HeritageTarget::Unknown,
    }
}

fn heritage_target_of_type_name(
    type_name: &TSTypeName,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
) -> HeritageTarget {
    match type_name {
        TSTypeName::IdentifierReference(ident) => {
            classify_heritage_identifier(ident, path, scoping, import_specifiers)
        }
        _ => HeritageTarget::Unknown,
    }
}

fn summarize_class(
    class: &Class,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    synthetic_interfaces: &mut Vec<InterfaceSummary>,
) -> Option<ClassSummary> {
    if class.r#type != ClassType::ClassDeclaration {
        return None;
    }
    let ident = class.id.as_ref()?;
    let entity_id = declaration_id("class", path, ident.span.start, ident.name.as_str());
    let extends = class
        .super_class
        .as_ref()
        .map(|expr| heritage_target_of_expression(expr, path, scoping, import_specifiers));
    let implements = class
        .implements
        .iter()
        .map(|implements| {
            heritage_target_of_type_name(&implements.expression, path, scoping, import_specifiers)
        })
        .collect();
    let mut members = Vec::new();
    for element in &class.body.body {
        if let Some(entry) = member_entry_of_class_element(
            element,
            path,
            scoping,
            import_specifiers,
            synthetic_interfaces,
            &entity_id,
        ) {
            members.push(entry);
        }
        // Parameter properties: see `push_constructor_parameter_property_
        // declarations`'s doc comment -- the SAME discovery/identity rule,
        // just building a `MemberEntry` (for `ProgramIndex::members`/
        // `member_type_ref`) instead of a `MemberDeclaration` (for the cold
        // entity producer). A non-constructor element (or a constructor
        // with no parameter properties) contributes nothing here.
        members.extend(member_entries_of_constructor_parameter_properties(
            element,
            path,
            scoping,
            import_specifiers,
            synthetic_interfaces,
        ));
    }
    Some(ClassSummary {
        entity_id,
        extends,
        implements,
        members,
    })
}

fn summarize_interface(
    declaration: &TSInterfaceDeclaration,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    synthetic_interfaces: &mut Vec<InterfaceSummary>,
) -> InterfaceSummary {
    let entity_id = declaration_id(
        "interface",
        path,
        declaration.id.span.start,
        declaration.id.name.as_str(),
    );
    let extends = declaration
        .extends
        .iter()
        .map(|heritage| {
            heritage_target_of_expression(&heritage.expression, path, scoping, import_specifiers)
        })
        .collect();
    let members = declaration
        .body
        .body
        .iter()
        .filter_map(|signature| {
            member_entry_of_signature(
                signature,
                path,
                scoping,
                import_specifiers,
                synthetic_interfaces,
            )
        })
        .collect();
    InterfaceSummary {
        entity_id,
        extends,
        members,
    }
}

/// The `(start, end, name)` an identity-bearing `PropertyKey` contributes,
/// when it has one at all. Mirrors `semantic_sites::property_key_name`
/// exactly (same "#"-prefix and literal-key handling) -- see that
/// function's doc comment for why a computed key has none. The single
/// source both `property_key_name` (start/name only, this crate's own
/// pre-existing callers) and `class_element_member_shape`/`signature_
/// member_shape` (need the key's own END too, for `MemberDeclaration::
/// key_end`) build on.
fn property_key_span(key: &PropertyKey) -> Option<(u32, u32, String)> {
    match key {
        PropertyKey::StaticIdentifier(name) => Some((
            name.span.start,
            name.span.end,
            name.name.as_str().to_owned(),
        )),
        PropertyKey::PrivateIdentifier(name) => Some((
            name.span.start,
            name.span.end,
            format!("#{}", name.name.as_str()),
        )),
        PropertyKey::StringLiteral(literal) => Some((
            literal.span.start,
            literal.span.end,
            literal.value.as_str().to_owned(),
        )),
        PropertyKey::NumericLiteral(literal) => Some((
            literal.span.start,
            literal.span.end,
            literal
                .raw
                .as_ref()
                .map(|raw| raw.as_str().to_owned())
                .unwrap_or_else(|| literal.value.to_string()),
        )),
        _ => None,
    }
}

fn property_key_name(key: &PropertyKey) -> Option<(u32, String)> {
    property_key_span(key).map(|(start, _end, name)| (start, name))
}

/// The `(kind_word, key_start, key_end, name, is_static)` shape a class
/// element or interface signature contributes as a member, when it has one
/// at all -- the single source of truth `member_entry_of_class_element`/
/// `member_entry_of_signature` (own type/return-inference logic, unaffected
/// by this refactor) and `push_class_member_declarations`/`push_interface_
/// member_declarations` (own entity-materialization logic, see
/// `member_declarations`'s doc comment) both build on, so the identity/
/// kind-word classification the syntax worker's cold entity producer needs
/// cannot drift from what this crate's own `MemberEntry` index builds.
struct MemberShape {
    name: String,
    kind_word: &'static str,
    key_start: u32,
    key_end: u32,
    is_static: bool,
    /// Frente E-P0j (2026-09-07): the member's own FULL declaration span --
    /// from the start of its modifiers/decorators/accessibility keyword
    /// through its closing (the member node's own `GetSpan::span()`) --
    /// distinct from `key_start`/`key_end` (the name-identifier span alone,
    /// still used for identity, see `MemberDeclaration::entity_id`'s own
    /// doc comment). `None` for a signature member shape (interface
    /// members have no modifiers/decorators to speak of; `signature_member_
    /// shape` still fills this from the signature's own span for
    /// consistency, never actually `None` in practice today, kept `Option`
    /// only so a future member kind lacking a full-node span has somewhere
    /// safe to fall back to `(key_start, key_end)`).
    decl_start: u32,
    decl_end: u32,
}

fn class_element_member_shape(element: &ClassElement) -> Option<MemberShape> {
    let full_span = element.span();
    match element {
        ClassElement::MethodDefinition(method) => {
            let (key_start, key_end, name) = property_key_span(&method.key)?;
            let kind_word = match method.kind {
                MethodDefinitionKind::Constructor => "constructor",
                MethodDefinitionKind::Method => "method",
                MethodDefinitionKind::Get => "getter",
                MethodDefinitionKind::Set => "setter",
            };
            Some(MemberShape {
                name,
                kind_word,
                key_start,
                key_end,
                is_static: method.r#static,
                decl_start: full_span.start,
                decl_end: full_span.end,
            })
        }
        ClassElement::PropertyDefinition(property) => {
            if property.computed {
                return None;
            }
            let (key_start, key_end, name) = property_key_span(&property.key)?;
            Some(MemberShape {
                name,
                kind_word: "property",
                key_start,
                key_end,
                is_static: property.r#static,
                decl_start: full_span.start,
                decl_end: full_span.end,
            })
        }
        _ => None,
    }
}

fn signature_member_shape(signature: &TSSignature) -> Option<MemberShape> {
    let full_span = signature.span();
    match signature {
        TSSignature::TSMethodSignature(method) => {
            let (key_start, key_end, name) = property_key_span(&method.key)?;
            let kind_word = match method.kind {
                oxc_ast::ast::TSMethodSignatureKind::Method => "method",
                oxc_ast::ast::TSMethodSignatureKind::Get => "getter",
                oxc_ast::ast::TSMethodSignatureKind::Set => "setter",
            };
            Some(MemberShape {
                name,
                kind_word,
                key_start,
                key_end,
                is_static: false,
                decl_start: full_span.start,
                decl_end: full_span.end,
            })
        }
        TSSignature::TSPropertySignature(property) => {
            let (key_start, key_end, name) = property_key_span(&property.key)?;
            Some(MemberShape {
                name,
                kind_word: "property",
                key_start,
                key_end,
                is_static: false,
                decl_start: full_span.start,
                decl_end: full_span.end,
            })
        }
        _ => None,
    }
}

/// One class/interface member DECLARATION site -- the identity/kind/span/
/// container facts the v4 cold entity producer
/// (`urdira_jsts_syntax_worker::SyntaxCollector`) needs to materialize a
/// `SyntaxEntity` for every member this crate's own `ProgramIndex` would
/// build a `MemberEntry` for. `entity_id` is byte-identical to `declaration_
/// id(kind_word, path, key_start, name)`, the SAME recipe `MemberEntry::
/// entity_id` uses (see `member_declarations`'s own unit test asserting the
/// two agree over a fixture). `container_entity_id`/`container_name` are
/// the class/interface's own `push_entity`-recipe id (`jsts:{class|
/// interface}:{path}:{start}:{name}`) and name, matching what `push_entity`
/// already assigns that container in `urdira-jsts-syntax-worker` -- the
/// caller does not need to recompute either.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberDeclaration {
    pub entity_id: String,
    pub name: String,
    pub kind_word: &'static str,
    pub key_start: u32,
    pub key_end: u32,
    /// Frente E-P0j (2026-09-07): this member's own FULL declaration span
    /// (modifiers/decorators/accessibility keyword through the closing) --
    /// see `MemberShape::decl_start`'s own doc comment. `key_start`/
    /// `key_end` (the name span alone) remain the IDENTITY anchor
    /// (`entity_id`'s own recipe, unchanged) and are what a v4 residual-pass
    /// consumer keyed by "where does the checker say this identifier
    /// starts" must keep using -- only the PUBLISHED `SyntaxEntity::start`/
    /// `.end` a caller (`push_member_entities`, lib.rs) builds from these
    /// two fields move to the full declaration.
    pub decl_start: u32,
    pub decl_end: u32,
    pub container_entity_id: String,
    pub container_name: String,
    pub is_static: bool,
    /// Frente E-P0h (2026-09-07): the RAW (UTF-16, same convention as every
    /// other span this struct/crate hands back -- see `entity_id`'s own doc
    /// comment) source span of each declared PARAMETER's own type
    /// annotation, in declaration order -- `None` for an unannotated
    /// parameter, a distinct POSITIONED "absent" slot (never simply
    /// omitted), so `f(a: string, b)` and `f(a, b: string)` can never
    /// collide once `urdira_jsts_syntax_worker` slices/normalizes/joins
    /// these spans into `SyntaxEntity::type_surface_digest`. Empty for a
    /// `property`/`getter` member (see `type_surface_return` for those);
    /// one entry for a `setter`/`constructor`-parameter-property member
    /// (its own single parameter). Deliberately a RAW SPAN, never a
    /// resolved/classified `RawTypeRef`: this crate's heavier import-
    /// resolution machinery (`raw_type_ref_of_ts_type`, needs `Scoping`/
    /// `import_specifiers`, cross-file) is not needed to detect "this
    /// member's OWN written type changed" -- only `urdira_jsts_syntax_
    /// worker` holds this file's raw source text and UTF-16-to-byte offset
    /// table to turn a span into a comparable digest, so the span alone is
    /// the minimal fact to hand across this crate boundary (see `analyze::
    /// exported_surface`'s own doc comment for the full mechanism this
    /// feeds).
    pub type_surface_params: Vec<Option<(u32, u32)>>,
    /// Frente E-P0h: this member's own declared RETURN type (`method`/
    /// `getter`) or declared TYPE (`property`) -- `None` when unannotated,
    /// and always `None` for `setter`/`constructor`/a parameter-property
    /// member (TypeScript never allows annotating any of those with a
    /// "return" type of their own; a parameter-property's OWN type lives in
    /// `type_surface_params[0]` instead).
    pub type_surface_return: Option<(u32, u32)>,
}

/// Frente E-P0h: the `(params, returns)` shape every one of this module's
/// type-surface producers returns -- see `MemberDeclaration::type_surface_
/// params`/`type_surface_return`'s own doc comments for what each half
/// means. Factored into a named alias purely to keep every signature below
/// readable (clippy's own `type_complexity` lint).
type TypeSurfaceSpans = (Vec<Option<(u32, u32)>>, Option<(u32, u32)>);

/// Frente E-P0h: `annotation`'s own `TSType` span, in UTF-16 code units
/// (matching every other span this crate produces) -- `None` when
/// unannotated. A thin wrapper so every one of this module's member/
/// function/property producers shares the exact same "absent vs present"
/// convention `MemberDeclaration::type_surface_params`'s own doc comment
/// documents.
fn type_annotation_span(annotation: Option<&TSTypeAnnotation>) -> Option<(u32, u32)> {
    let annotation = annotation?;
    let span = annotation.type_annotation.span();
    Some((span.start, span.end))
}

/// Frente E-P0h: a `method`/`getter`/`setter`/`constructor` class element or
/// interface method signature's own type surface -- every declared
/// parameter's type span (declaration order) plus the return type span, if
/// any. Shared by `class_element_type_surface`/`push_interface_member_
/// declarations` so a method's and a method SIGNATURE's own extraction can
/// never drift apart.
fn formal_parameters_type_surface(
    params: &oxc_ast::ast::FormalParameters,
    return_type: Option<&TSTypeAnnotation>,
) -> TypeSurfaceSpans {
    let param_spans = params
        .items
        .iter()
        .map(|param| type_annotation_span(param.type_annotation.as_deref()))
        .collect();
    (param_spans, type_annotation_span(return_type))
}

/// Frente E-P0h: `element`'s own type surface -- see `MemberDeclaration::
/// type_surface_params`/`type_surface_return`'s own doc comments. A
/// non-method/property element (an accessor pair's static block, ...;
/// `class_element_member_shape` already filtered those out before this is
/// ever called, so this arm is defensive only) contributes nothing.
fn class_element_type_surface(element: &ClassElement) -> TypeSurfaceSpans {
    match element {
        ClassElement::MethodDefinition(method) => formal_parameters_type_surface(
            &method.value.params,
            method.value.return_type.as_deref(),
        ),
        ClassElement::PropertyDefinition(property) => (
            Vec::new(),
            type_annotation_span(property.type_annotation.as_deref()),
        ),
        _ => (Vec::new(), None),
    }
}

/// Frente E-P0h: `signature`'s own type surface -- the interface-member
/// counterpart of `class_element_type_surface`, see that function's doc
/// comment.
fn signature_type_surface(signature: &TSSignature) -> TypeSurfaceSpans {
    match signature {
        TSSignature::TSMethodSignature(method) => {
            formal_parameters_type_surface(&method.params, method.return_type.as_deref())
        }
        TSSignature::TSPropertySignature(property) => (
            Vec::new(),
            type_annotation_span(property.type_annotation.as_deref()),
        ),
        _ => (Vec::new(), None),
    }
}

/// Walks `program`'s top-level (module/`export`/`export default`)
/// statements for every class/interface declaration `extract_decl_summary`
/// itself would summarize (via `collect_from_statement`/`collect_from_
/// declaration`/`collect_from_default_declaration`), and every member of it
/// `member_entry_of_class_element`/`member_entry_of_signature` would build
/// a `MemberEntry` for -- the EXACT same discovery surface, never a superset
/// or subset: a class nested inside a function body is invisible to both
/// (typeflow's own `DeclSummary` never recurses into a function body
/// looking for a nested class), and an anonymous class (no `class.id`) is
/// skipped by both (`summarize_class`'s own `?` on `class.id`, mirrored
/// here) -- there is no stable container id to key its members under, and
/// `urdira_jsts_syntax_worker::SyntaxCollector::push_entity` itself never
/// materializes an entity for one either (`visit_class`'s own `class.id`
/// guard). Object-shape (`const x = { ... }`) and callable-variable member
/// tables are OUT of scope here (see `MemberEntry`'s own construction sites
/// in `object_shape_members_of`) -- those are not class/interface members,
/// have no comparable container entity id of their own, and `push_entity`
/// never materializes one for their "members" either; this function's own
/// equivalence unit test uses a fixture with no such declarations so the
/// two enumerations agree exactly.
pub fn member_declarations(program: &Program, path: &str) -> Vec<MemberDeclaration> {
    let mut out = Vec::new();
    for statement in &program.body {
        collect_member_declarations_from_statement(statement, path, &mut out);
    }
    out
}

fn collect_member_declarations_from_statement(
    statement: &Statement,
    path: &str,
    out: &mut Vec<MemberDeclaration>,
) {
    match statement {
        Statement::ClassDeclaration(class) => push_class_member_declarations(class, path, out),
        Statement::TSInterfaceDeclaration(declaration) => {
            push_interface_member_declarations(declaration, path, out);
        }
        Statement::ExportNamedDeclaration(export) => {
            if let Some(declaration) = &export.declaration {
                collect_member_declarations_from_declaration(declaration, path, out);
            }
        }
        Statement::ExportDefaultDeclaration(export) => {
            if let oxc_ast::ast::ExportDefaultDeclarationKind::ClassDeclaration(class) =
                &export.declaration
            {
                push_class_member_declarations(class, path, out);
            }
        }
        _ => {}
    }
}

fn collect_member_declarations_from_declaration(
    declaration: &oxc_ast::ast::Declaration,
    path: &str,
    out: &mut Vec<MemberDeclaration>,
) {
    use oxc_ast::ast::Declaration;
    match declaration {
        Declaration::ClassDeclaration(class) => push_class_member_declarations(class, path, out),
        Declaration::TSInterfaceDeclaration(declaration) => {
            push_interface_member_declarations(declaration, path, out);
        }
        _ => {}
    }
}

fn push_class_member_declarations(class: &Class, path: &str, out: &mut Vec<MemberDeclaration>) {
    if class.r#type != ClassType::ClassDeclaration {
        return;
    }
    let Some(ident) = class.id.as_ref() else {
        return;
    };
    let container_entity_id = declaration_id("class", path, ident.span.start, ident.name.as_str());
    let container_name = ident.name.as_str().to_owned();
    for element in &class.body.body {
        let Some(shape) = class_element_member_shape(element) else {
            continue;
        };
        let member_entity_id = declaration_id(shape.kind_word, path, shape.key_start, &shape.name);
        let is_constructor = shape.kind_word == "constructor";
        let (type_surface_params, type_surface_return) = class_element_type_surface(element);
        out.push(MemberDeclaration {
            entity_id: member_entity_id.clone(),
            name: shape.name,
            kind_word: shape.kind_word,
            key_start: shape.key_start,
            key_end: shape.key_end,
            decl_start: shape.decl_start,
            decl_end: shape.decl_end,
            container_entity_id: container_entity_id.clone(),
            container_name: container_name.clone(),
            is_static: shape.is_static,
            type_surface_params,
            type_surface_return,
        });
        // Parameter properties (see `constructor_parameter_property_
        // params`'s doc comment): only a constructor can declare one, and
        // its container is the CONSTRUCTOR's own just-computed entity id
        // (v3 parity -- `analyzer.ts`'s `addEntity`/`collect` parents a
        // parameter's entity on whatever recognized-entity ancestor node
        // directly contains it, which for a parameter is the constructor,
        // never the class itself), so `qualified_name` needs the SAME
        // ".constructor" segment v3's own `nameOf(ConstructorDeclaration)`
        // synthesizes -- reusing `container_name`'s existing "{path}.
        // {container_name}.{name}" concatenation in `push_member_entities`
        // by appending it here rather than adding a new field.
        if is_constructor {
            push_constructor_parameter_property_declarations(
                element,
                path,
                &member_entity_id,
                &format!("{container_name}.constructor"),
                out,
            );
        }
    }
}

/// TS parameter properties (`constructor(public x: T, private readonly y:
/// U)`) are, from the checker's own point of view, class members declared
/// via the SAME `FormalParameter` node that also serves as the parameter's
/// own declaration -- v3's `analyzer.ts` never gives one a separate
/// "property" entity kind (`addEntity`'s `isParameterDeclaration(node)`
/// check fires unconditionally, before its `isPropertyDeclaration` arm even
/// runs, and TypeScript's own checker resolves BOTH a bare `defaultConfig`
/// reference inside the constructor body AND a `this.defaultConfig` member
/// read to that exact same `ParameterDeclaration` node). This crate mirrors
/// that identity: a parameter property contributes a `MemberDeclaration`/
/// `MemberEntry` with kind word "parameter" (never "property"), keyed by its
/// BINDING IDENTIFIER's own span -- byte-identical to
/// `urdira_jsts_syntax_worker::semantic_sites::declaration_id(DeclKind::
/// Parameter, ...)` for the SAME node (see `visit_formal_parameter`'s own
/// "referenced-only" parameter-entity producer there, which this crate's
/// caller coordinates with so the same declaration is never materialized
/// twice -- `visit_formal_parameter` skips recording a parameter-property
/// fact into its own referenced-only bucket, deferring entirely to THIS
/// producer, which is unconditional like every other member entity). Only
/// an identifier-pattern parameter (never a destructured/rest one --
/// TypeScript itself rejects an accessibility/`readonly` modifier on those)
/// with an accessibility modifier OR `readonly` (`FormalParameter::
/// has_modifier`, the exact predicate oxc's own ESTree serializer uses to
/// decide whether a parameter is really a `TSParameterProperty`) qualifies;
/// a plain `constructor(x: T)` parameter is never a member.
fn push_constructor_parameter_property_declarations(
    element: &ClassElement,
    path: &str,
    constructor_entity_id: &str,
    constructor_qualified_name_segment: &str,
    out: &mut Vec<MemberDeclaration>,
) {
    use oxc_ast::ast::BindingPattern;
    let ClassElement::MethodDefinition(method) = element else {
        return;
    };
    if method.kind != MethodDefinitionKind::Constructor {
        return;
    }
    for param in &method.value.params.items {
        if !param.has_modifier() {
            continue;
        }
        let BindingPattern::BindingIdentifier(param_ident) = &param.pattern else {
            continue;
        };
        let name = param_ident.name.as_str().to_owned();
        let full_span = param.span;
        out.push(MemberDeclaration {
            entity_id: declaration_id("parameter", path, param_ident.span.start, &name),
            name,
            kind_word: "parameter",
            key_start: param_ident.span.start,
            key_end: param_ident.span.end,
            // Frente E-P0j: a parameter property's own full span -- "the
            // parameter with its own annotation and default" (task brief)
            // -- covers its accessibility/`readonly` modifiers through its
            // default value, exactly `param.span()` (oxc's `FormalParameter`
            // span already starts at the first modifier keyword, same
            // convention every other member's `decl_start` uses).
            decl_start: full_span.start,
            decl_end: full_span.end,
            container_entity_id: constructor_entity_id.to_owned(),
            container_name: constructor_qualified_name_segment.to_owned(),
            is_static: false,
            // A parameter property's own type surface is ITS OWN
            // annotation (see `MemberDeclaration::type_surface_return`'s
            // doc comment) -- a single-slot `type_surface_params`, never a
            // `type_surface_return` (TypeScript never allows a "return"
            // type on a parameter).
            type_surface_params: vec![type_annotation_span(param.type_annotation.as_deref())],
            type_surface_return: None,
        });
    }
}

fn push_interface_member_declarations(
    declaration: &TSInterfaceDeclaration,
    path: &str,
    out: &mut Vec<MemberDeclaration>,
) {
    let container_entity_id = declaration_id(
        "interface",
        path,
        declaration.id.span.start,
        declaration.id.name.as_str(),
    );
    let container_name = declaration.id.name.as_str().to_owned();
    for signature in &declaration.body.body {
        let Some(shape) = signature_member_shape(signature) else {
            continue;
        };
        let (type_surface_params, type_surface_return) = signature_type_surface(signature);
        out.push(MemberDeclaration {
            entity_id: declaration_id(shape.kind_word, path, shape.key_start, &shape.name),
            name: shape.name,
            kind_word: shape.kind_word,
            key_start: shape.key_start,
            key_end: shape.key_end,
            decl_start: shape.decl_start,
            decl_end: shape.decl_end,
            container_entity_id: container_entity_id.clone(),
            container_name: container_name.clone(),
            is_static: false,
            type_surface_params,
            type_surface_return,
        });
    }
}

fn member_entry_of_class_element(
    element: &ClassElement,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    synthetic_interfaces: &mut Vec<InterfaceSummary>,
    enclosing_class_id: &str,
) -> Option<MemberEntry> {
    let shape = class_element_member_shape(element)?;
    match element {
        ClassElement::MethodDefinition(method) => {
            let type_ref = raw_type_ref_of_annotation(
                method.value.return_type.as_deref(),
                path,
                scoping,
                import_specifiers,
                synthetic_interfaces,
            );
            // P1-B: body inference only for a plain method or getter (a
            // setter always returns `void`; a constructor is never called
            // for its "return value") that has no return-type annotation
            // of its own. E-P0q (2026-09-09): "no annotation" is checked
            // SYNTACTICALLY (`return_type.is_none()`), never as `type_ref
            // == Unknown` -- an annotation this crate cannot classify (a
            // qualified `ns.IFace`, a generic, ...) still WINS over the
            // body, exactly like TypeScript's own checker: found live,
            // `TextModel.createSnapshot(): model.ITextSnapshot { return new
            // TextModelSnapshot(...) }` was inferred to the concrete class
            // (`snapshot.read()` -> `TextModelSnapshot.read`, v3 correctly
            // says `ITextSnapshot.read`) -- `docs/evidence/2026-09-07-v4-
            // vscode-campaign.md` §17.
            let pending_return = (return_type_eligible(method.kind)
                && method.value.return_type.is_none())
            .then(|| {
                collect_pending_return_shapes(
                    method.value.body.as_deref(),
                    Some(enclosing_class_id),
                    method.r#static,
                    path,
                    scoping,
                    import_specifiers,
                )
            })
            .flatten();
            Some(MemberEntry {
                name: shape.name.clone(),
                is_static: shape.is_static,
                entity_id: declaration_id(shape.kind_word, path, shape.key_start, &shape.name),
                type_ref,
                pending_return,
                is_async: method.value.r#async,
            })
        }
        ClassElement::PropertyDefinition(property) => {
            let type_ref = raw_type_ref_of_annotation(
                property.type_annotation.as_deref(),
                path,
                scoping,
                import_specifiers,
                synthetic_interfaces,
            );
            // G extension (E-P0l, 2026-09-08): NO type annotation AT ALL
            // (`protected readonly _now = Date.now;`, `static matchQuery =
            // matchesFuzzy;`) -- a VALUE-COPY initializer -- see `raw_
            // type_ref_of_value_copy_expression`'s own doc comment. Gated
            // on `property.type_annotation.is_none()` itself, NOT on
            // `type_ref` merely being `Unknown` -- found live (adversarial
            // self-review, same session): `getCalendarDay: (timestamp:
            // number) => number = getLocalCalendarDay` DOES have an
            // explicit annotation (a plain function-type signature this
            // crate does not classify, ALSO `Unknown`), and v3's real
            // answer there is the PARAMETER'S OWN declaration, never
            // `getLocalCalendarDay`'s -- an explicit, INDEPENDENT type
            // shape (even one this crate cannot itself classify) governs
            // the property's own identity and must never be overridden by
            // its default value; only a property with NO annotation at
            // all is inferred AS EXACTLY its initializer's own type,
            // which is what makes the redirect sound for `_now`/
            // `matchQuery`.
            let type_ref = if property.type_annotation.is_none() {
                property
                    .value
                    .as_ref()
                    .and_then(|value| {
                        raw_type_ref_of_value_copy_expression(
                            value,
                            path,
                            scoping,
                            import_specifiers,
                        )
                    })
                    .unwrap_or(type_ref)
            } else {
                type_ref
            };
            Some(MemberEntry {
                name: shape.name.clone(),
                is_static: shape.is_static,
                entity_id: declaration_id(shape.kind_word, path, shape.key_start, &shape.name),
                type_ref,
                pending_return: None,
                is_async: false,
            })
        }
        _ => None,
    }
}

/// G extension (E-P0l, 2026-09-08): classify a property/parameter's own
/// VALUE-COPY initializer/default expression (as opposed to an explicit
/// type annotation, see `RawTypeRef::TypeQuery`'s own doc comment for the
/// annotation half of this same mechanism) into a `RawTypeRef::TypeQuery`
/// -- found live: `protected readonly _now = Date.now;` (no annotation at
/// all, initializer is a qualified member expression) and `static
/// matchQuery = matchesFuzzy;` (initializer is a plain identifier naming
/// an imported function). A plain `Identifier` initializer resolves
/// through the SAME `classify_typeof_target_identifier` closure `typeof f`
/// itself uses -- `Some` only when it confidently names a known function/
/// variable/import, `None` (this function's own `None`, meaning "not a
/// value-copy shape at all") for anything else, so an ordinary field
/// holding some UNRELATED local's value never gets misclassified. A
/// `StaticMemberExpression` initializer (`Date.now`, `console.log`,
/// `globalThis.fetch`) is ALWAYS treated as a value-copy (`TypeQuery(
/// None)`, never resolved further -- this crate has no member table for
/// built-in/ambient objects) regardless of whether the object side itself
/// resolves, since a qualified-member initializer is never plausibly "the
/// property's own declared behavior" the way a function/arrow-function/
/// object-literal initializer is. Every OTHER initializer shape (an arrow
/// function, a function expression, a call expression, a literal, ...) is
/// `None` here -- the property's own declaration is very likely the
/// CORRECT call target for those (an arrow function value IS a real
/// function of its own), so this function must never touch them.
fn raw_type_ref_of_value_copy_expression(
    expr: &Expression,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
) -> Option<RawTypeRef> {
    match expr {
        Expression::Identifier(ident) => {
            classify_typeof_target_identifier(ident, path, scoping, import_specifiers)
                .map(|entity_ref| RawTypeRef::TypeQuery(Some(entity_ref)))
        }
        Expression::StaticMemberExpression(_) => Some(RawTypeRef::TypeQuery(None)),
        _ => None,
    }
}

fn return_type_eligible(kind: MethodDefinitionKind) -> bool {
    matches!(
        kind,
        MethodDefinitionKind::Method | MethodDefinitionKind::Get
    )
}

/// The `MemberEntry` half of `push_constructor_parameter_property_
/// declarations` (see that function's doc comment for the full identity
/// rationale) -- one entry per identifier-pattern constructor parameter
/// with an accessibility modifier or `readonly`, `entity_id` byte-identical
/// to what that function assigns the SAME declaration. `is_static` is
/// always `false` (TypeScript has no such thing as a static parameter
/// property); `type_ref` comes from the parameter's own annotation, exactly
/// like a `PropertyDefinition`'s; `pending_return`/`is_async` are always
/// `None`/`false` (a property, never a callable). A non-constructor element
/// contributes nothing.
fn member_entries_of_constructor_parameter_properties(
    element: &ClassElement,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    synthetic_interfaces: &mut Vec<InterfaceSummary>,
) -> Vec<MemberEntry> {
    use oxc_ast::ast::BindingPattern;
    let ClassElement::MethodDefinition(method) = element else {
        return Vec::new();
    };
    if method.kind != MethodDefinitionKind::Constructor {
        return Vec::new();
    }
    method
        .value
        .params
        .items
        .iter()
        .filter_map(|param| {
            if !param.has_modifier() {
                return None;
            }
            let BindingPattern::BindingIdentifier(param_ident) = &param.pattern else {
                return None;
            };
            let name = param_ident.name.as_str().to_owned();
            let type_ref = raw_type_ref_of_annotation(
                param.type_annotation.as_deref(),
                path,
                scoping,
                import_specifiers,
                synthetic_interfaces,
            );
            // G extension (E-P0l, 2026-09-08): the SAME value-copy-default
            // fallback `PropertyDefinition` gets, for a parameter property
            // with NO type annotation AT ALL but a default value that is
            // itself a value-copy shape. Gated on `param.type_annotation.
            // is_none()` itself, NOT on `type_ref` merely being `Unknown`
            // -- see the byte-identical `PropertyDefinition` guard's own
            // doc comment for why: `getCalendarDay: (timestamp: number) =>
            // number = getLocalCalendarDay` DOES have an explicit
            // annotation (a plain function-type signature this crate does
            // not classify, ALSO `Unknown`) and must NOT redirect through
            // its default value -- only `spawnRipgrep`/`_fetchFn`-style
            // ALIASED type annotations (`SpawnRipgrepCmd`/`FetchFn`,
            // themselves resolving through `typeof <expr>` -- see the
            // alias-chasing fix in `resolve_type_ref_chasing_aliases`)
            // legitimately redirect, and those already resolve via the
            // ANNOTATION alone, never needing this initializer fallback at
            // all. `param.initializer` is oxc's own name for a parameter's
            // default value (kept fully separate from `pattern` even when
            // present, unlike a destructured default).
            let type_ref = if param.type_annotation.is_none() {
                param
                    .initializer
                    .as_ref()
                    .and_then(|value| {
                        raw_type_ref_of_value_copy_expression(
                            value,
                            path,
                            scoping,
                            import_specifiers,
                        )
                    })
                    .unwrap_or(type_ref)
            } else {
                type_ref
            };
            Some(MemberEntry {
                name: name.clone(),
                is_static: false,
                entity_id: declaration_id("parameter", path, param_ident.span.start, &name),
                type_ref,
                pending_return: None,
                is_async: false,
            })
        })
        .collect()
}

fn member_entry_of_signature(
    signature: &TSSignature,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    synthetic_interfaces: &mut Vec<InterfaceSummary>,
) -> Option<MemberEntry> {
    let shape = signature_member_shape(signature)?;
    match signature {
        TSSignature::TSMethodSignature(method) => {
            let type_ref = raw_type_ref_of_annotation(
                method.return_type.as_deref(),
                path,
                scoping,
                import_specifiers,
                synthetic_interfaces,
            );
            Some(MemberEntry {
                name: shape.name.clone(),
                // Interface members have no static/instance distinction --
                // an interface can never be `new`'d directly, so `a: IFoo`
                // member access is always the instance shape. `false` here
                // means `ProgramIndex::members` must be called with
                // `is_static = false` for an interface-typed base -- the
                // caller's responsibility (mirrors "own members" always
                // being instance-shaped for a `TSTypeLiteral`, out of
                // scope here).
                is_static: false,
                entity_id: declaration_id(shape.kind_word, path, shape.key_start, &shape.name),
                type_ref,
                // Interface signatures have no body -- nothing to infer.
                pending_return: None,
                is_async: false,
            })
        }
        TSSignature::TSPropertySignature(property) => {
            let type_ref = raw_type_ref_of_annotation(
                property.type_annotation.as_deref(),
                path,
                scoping,
                import_specifiers,
                synthetic_interfaces,
            );
            Some(MemberEntry {
                name: shape.name.clone(),
                is_static: false,
                entity_id: declaration_id(shape.kind_word, path, shape.key_start, &shape.name),
                type_ref,
                pending_return: None,
                is_async: false,
            })
        }
        _ => None,
    }
}

/// A member entry with its `RawTypeRef` already collapsed to a
/// `ResolvedTypeRef` (import specifiers closed against `import_targets` --
/// see `resolve_raw_type_ref`'s doc comment). `None` for `RawTypeRef::
/// Unknown` or an `Imported` reference the caller could not resolve --
/// never a guess.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedMember {
    name: String,
    is_static: bool,
    entity_id: String,
    type_ref: Option<ResolvedTypeRef>,
    /// E-P0m (2026-09-08): `true` when this member's OWN raw annotation
    /// (`MemberEntry::type_ref`, captured before any cross-file resolution)
    /// is anything OTHER than `RawTypeRef::Unknown` -- i.e. the member DOES
    /// have a real, named type reference, whether or not it ended up fully
    /// resolving into `type_ref` above. Lets a caller (`member_annotation_
    /// is_unresolved`) tell "no annotation at all" (safe to trust a naive
    /// name-based fallback) apart from "a real annotation that failed to
    /// resolve" (an unresolved import, a known type alias that never
    /// converged, ...) -- `type_ref: None` alone cannot express that
    /// distinction. Found live: `_fetch: FetchFunction` (`FetchFunction`
    /// itself an alias into ANOTHER file's `typeof globalThis.fetch`) and
    /// `_createMessageRequestHandler: IMcpServerRequestHandlerOptions
    /// ['createMessageRequestHandler']` (an indexed-access into a
    /// cross-file `extends` target) both stayed silently `None` whenever
    /// the underlying cross-file link did not resolve, letting `resolve_
    /// call_target_typeflow`'s naive name-based fallback confirm the
    /// member's OWN declaration as the call target instead of staying
    /// pending -- `docs/evidence/2026-09-07-v4-vscode-campaign.md` §13.
    had_named_type_reference: bool,
}

/// A resolved container (class or interface) ready for `ProgramIndex::
/// members` to walk: `extends`/`implements` already collapsed from
/// `HeritageTarget` to a plain `Option<entity_id>`/`Vec<entity_id>` --
/// `Unknown` and an `Imported` target the caller could not resolve both
/// collapse to absent, never a guess.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedContainer {
    extends: Vec<String>,
    /// Interface fallback only (see `ProgramIndex::members`'s doc comment);
    /// empty for an interface (interfaces have no `implements`).
    implements: Vec<String>,
    members: Vec<ResolvedMember>,
    is_interface: bool,
    /// E-P0k (2026-09-08, same-file member/parameter shadowing task): true
    /// when this container's OWN source syntactically declared an `extends`
    /// clause (class `extends <expr>`, or at least one interface `extends`
    /// entry) that `resolve_heritage_target` could NOT resolve to a known
    /// container -- a mixin factory call, a qualified/generic name this
    /// crate does not classify, or a plain identifier naming a class this
    /// crate never indexed (an external/vendored base, or one from a file
    /// outside the corpus). `extends` (the `Vec<String>` above) collapses
    /// "no extends clause at all" and "an unresolvable one" to the exact
    /// same empty state -- indistinguishable to `collect_members`'s own
    /// traversal without this flag. That collapse is exactly what let
    /// `collect_members`'s `implements` fallback fire on a class whose REAL
    /// member lives on an untracked ancestor further up an extends chain
    /// this crate gave up on partway (found live against the VS Code
    /// corpus, 2026-09-07: `MarkersTree extends WorkbenchObjectTree<...>`
    /// -- `WorkbenchObjectTree`'s own further heritage was never fully
    /// walkable -- `implements IProblemsWidget` was used as a stand-in for
    /// `getSelection`/`getHTMLElement`, when the real declaration is
    /// `AbstractTree.getSelection`, several `extends` hops up an untracked
    /// chain). See `collect_members`'s own doc comment for how this flag is
    /// consumed.
    has_unresolved_extends: bool,
}

/// Opt-in aggregate for the alias-chasing portion of `ProgramIndex` setup.
/// The indexing worker exposes this only in its semantic performance stream.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
pub struct TypeflowTelemetry {
    pub alias_chasing_count: u64,
    pub alias_chasing_us: u64,
}

/// Cross-file class/interface member index (P0-S2/P1-A). Built once per
/// generation from every file's `DeclSummary` plus the caller-resolved
/// import table (see `HeritageTarget::Imported`'s doc comment) -- see the
/// module doc for why this crate cannot resolve imports itself. P1-A adds
/// `function_return_types`, the same cross-file closure for top-level named
/// functions' own declared return type (rule (a): a call expression's own
/// type, for fluent-chain propagation -- see `member_type_ref`'s doc
/// comment for the class/interface-member half of the same rule).
///
/// **P3-8a**: also a genuinely INCREMENTAL data structure now --
/// `replace_file`/`add_file`/`remove_file` mutate an already-built index in
/// place, re-running the four-pass closure (see `build`'s own doc comment)
/// only over the affected component (the touched file plus every file that
/// currently imports something from it, transitively -- see
/// `transitive_importers_closure`), instead of the whole corpus. `build`
/// itself is now implemented in terms of the same per-file building blocks
/// (`insert_file_pass1`/`run_pass2_for_summary`/`collect_pending_for_summary`/
/// `run_fixed_point_pass3`/`run_fixed_point_pass4`) that back the
/// incremental methods, so a from-scratch build and an incrementally
/// converged index are computed by the identical code paths -- the
/// `incremental_matches_from_scratch_after_random_edits` test below
/// verifies they agree.
pub struct ProgramIndex {
    telemetry: TypeflowTelemetry,
    telemetry_enabled: bool,
    containers: HashMap<String, ResolvedContainer>,
    /// Direct reverse heritage edges for `extends` and `implements`.
    ///
    /// `sibling_conformance_overrides` needs descendants of one known
    /// container. Keeping only direct reverse edges avoids both the global
    /// container scan and the O(C²) memory/update cost of a transitive
    /// closure. The map is maintained together with `containers` by the
    /// incremental file-contribution helpers below.
    conformance_children: HashMap<String, HashSet<String>>,
    function_return_types: HashMap<String, ResolvedTypeRef>,
    /// P1-A: an explicitly-annotated top-level `const X: T = ...`'s own
    /// declared type -- see `VariableSummary`'s doc comment. Consulted
    /// BEFORE `is_container` (object-literal shape) for a `Variable`-kind
    /// identifier, so an annotated declarator always wins over its own
    /// initializer's structural shape, matching TypeScript exactly.
    variable_types: HashMap<String, ResolvedTypeRef>,
    /// P3-8a: every file's own `DeclSummary`, retained so an incremental
    /// call can reflow an IMPORTER of the touched file (its own text
    /// unchanged) without the caller re-supplying it, and so `remove_file`
    /// knows what a file used to contribute.
    summaries: BTreeMap<String, DeclSummary>,
    /// P3-8a: the accumulated import-resolution table (`build`'s own
    /// `import_targets` parameter), now OWNED and incrementally maintained
    /// via `apply_import_target_updates` instead of a one-shot argument.
    import_targets: HashMap<(String, String, String), String>,
    /// P3-8a: `owning_path -> its own current keys into `import_targets``,
    /// so `apply_import_target_updates` can atomically replace exactly one
    /// file's needed-imports set (the caller supplies a full fresh snapshot
    /// per owning file it re-resolved, never a partial patch).
    file_import_keys: HashMap<String, HashSet<(String, String, String)>>,
    /// P3-8a: `entity_id -> owning file path`, for every entity currently
    /// live in `containers`/`function_return_types`/`variable_types` --
    /// lets `remove_file_contributions` undo a file's pass-1 output
    /// precisely, and lets `link_importer`/`unlink_importer` find which
    /// file an `import_targets` value belongs to.
    entity_owner: HashMap<String, String>,
    /// P3-8a: the exact inverse of `entity_owner`, grouped by file --
    /// every entity id a file currently owns.
    file_entities: HashMap<String, Vec<String>>,
    /// P3-8a: `owned file -> set of OTHER files whose current
    /// `import_targets` names one of that file's entities as a target` --
    /// the reverse import graph `transitive_importers_closure` walks to
    /// find the affected component of an edit.
    importers_of: HashMap<String, HashSet<String>>,
    /// E-P0d (2026-09-07): `target file path -> set of OTHER files that
    /// currently have at least one named-import need whose specifier
    /// resolved to THIS file (`WorkspaceResolver::resolve` succeeded) but
    /// whose named export did NOT (`resolve_named_export` returned anything
    /// other than `Resolved` -- absent, ambiguous, or an unfollowed
    /// namespace re-export)`. Unlike `importers_of` (built only from
    /// SUCCESSFUL resolutions, via `link_importer`), this is the reverse
    /// graph for STILL-FAILING ones -- populated directly by the caller
    /// (`v4/typeflow.rs`'s `resolve_import_targets_for`, which alone knows
    /// the difference between "no target file at all" and "target file
    /// found, export not") via `apply_pending_target_updates`, since
    /// resolving a specifier to a file path needs `WorkspaceResolver`/
    /// `available`, neither of which this crate holds.
    ///
    /// **Why this exists**: `transitive_importers_closure`/`build_index`'s
    /// warm settling loop can only widen an edit's own affected/refresh set
    /// through `importers_of` -- an edge that has never yet resolved has no
    /// entry there, so a file whose ONLY link to a just-added declaring
    /// file happens to fail on its first attempt (e.g. because the target
    /// is reached through a THIRD file's re-export, and that third file's
    /// own content edit lands in a LATER, separate `build_index` call --
    /// `crates/urdira-indexing-worker/src/v4/delta.rs`'s own structural/
    /// content generation split for a mixed batch) is never revisited once
    /// `TypeflowCache`'s `pending_upserted` entry for it is drained --
    /// found live on real n8n (`docs/evidence/2026-09-06-v4-reconcile-
    /// threshold.md` §11.4/§12): `expression-observability.provider.ts`
    /// (added) needs `ExpressionEngineConfig` (declared in ANOTHER added
    /// file) through `@n8n/config`'s barrel `index.ts`, which is separately
    /// EDITED in the same batch to add both the re-export and the barrel's
    /// own new member typed with it; the barrel lands in the CONTENT
    /// generation, after the structural generation already tried and failed
    /// to resolve `provider.ts`'s need against the barrel's stale (pre-edit)
    /// exports, permanently. Widening `transitive_importers_closure` to
    /// ALSO walk this graph means the barrel's own later `replace_file`
    /// call correctly sweeps `provider.ts` back into `refresh_paths`/
    /// `affected`, re-resolving it against the barrel's now-current
    /// exports -- exactly like a from-scratch rebuild, which sees the final
    /// tree in one pass and never has this ordering problem at all.
    pending_importers_of: HashMap<String, HashSet<String>>,
    /// D.2 (2026-09-05, references-parity task): every top-level `type X =
    /// ...` declaration's own id, mapped to its FINAL (hop-chased through
    /// any number of other aliases, cycle-guarded) `ResolvedTypeRef` -- see
    /// `build_alias_targets`'s own doc comment. Recomputed WHOLESALE (never
    /// incrementally patched) at `build` and at the start of every
    /// `reflow_files` call: cheap (real corpora have relatively few `type`
    /// declarations, unlike the class/interface/function/variable
    /// populations the rest of this incremental machinery is built for),
    /// and correct by construction since it depends only on `summaries`
    /// (always current before either call runs) and `import_targets`.
    alias_targets: HashMap<String, Option<ResolvedTypeRef>>,
}

/// P3-8a: one file's pass-1 output that cannot resolve until later passes
/// run -- `(entity_id, owning_path, raw_type_ref)` for a function/variable,
/// `(container_id, member_entity_id, owning_path, raw_type_ref)` for a
/// member (same tuple shapes `build`'s own local
/// `pending_deferred_functions`/`pending_deferred_variables`/
/// `pending_deferred_members` used before this refactor).
#[derive(Default)]
struct FileDeferred {
    functions: Vec<(String, String, RawTypeRef)>,
    variables: Vec<(String, String, RawTypeRef)>,
    members: Vec<(String, String, String, RawTypeRef)>,
}

/// Standalone (not a `ProgramIndex` method) so it borrows only
/// `import_targets`, never all of `self` -- callers that also need to
/// mutate `self.containers` in the same statement (`insert_file_pass1`)
/// stay borrow-check-clean this way. Byte-identical logic to the closure
/// `build` used to define inline.
fn resolve_members_for(
    members: &[MemberEntry],
    owning_path: &str,
    import_targets: &HashMap<(String, String, String), String>,
    alias_targets: &HashMap<String, Option<ResolvedTypeRef>>,
) -> Vec<ResolvedMember> {
    members
        .iter()
        .map(|member| ResolvedMember {
            name: member.name.clone(),
            is_static: member.is_static,
            entity_id: member.entity_id.clone(),
            type_ref: resolve_raw_type_ref(
                &member.type_ref,
                owning_path,
                import_targets,
                alias_targets,
            ),
            had_named_type_reference: !matches!(member.type_ref, RawTypeRef::Unknown),
        })
        .collect()
}

/// Pass 1 (see `ProgramIndex::build`'s doc comment) for exactly ONE file:
/// registers every class/interface/object-shape/function/callable-
/// variable/variable `summary` declares into `containers`/
/// `function_return_types`/`variable_types`, records ownership into
/// `entity_owner`/`owned_entities` (so a future removal can undo exactly
/// this), and returns every entry whose own raw type ref needs the fourth
/// pass (`ReturnTypeOfFn`/`IndexedAccess`). Free function (not a
/// `ProgramIndex` method) so `build`, `replace_file`, and
/// `transitive_importers_closure`'s reflow loop can all call it against
/// whichever maps are in scope without fighting the borrow checker over
/// `&mut self` vs `&self.import_targets`.
#[allow(clippy::too_many_arguments)]
fn insert_file_pass1(
    containers: &mut HashMap<String, ResolvedContainer>,
    function_return_types: &mut HashMap<String, ResolvedTypeRef>,
    variable_types: &mut HashMap<String, ResolvedTypeRef>,
    entity_owner: &mut HashMap<String, String>,
    owned_entities: &mut Vec<String>,
    summary: &DeclSummary,
    import_targets: &HashMap<(String, String, String), String>,
    alias_targets: &HashMap<String, Option<ResolvedTypeRef>>,
) -> FileDeferred {
    let path = summary.path.as_str();
    let mut deferred = FileDeferred::default();

    for class in &summary.classes {
        let resolve = |target: &HeritageTarget| {
            resolve_heritage_target(target, path, import_targets, alias_targets)
        };
        let resolved_extends: Vec<String> = class
            .extends
            .as_ref()
            .and_then(resolve)
            .into_iter()
            .collect();
        let has_unresolved_extends = class.extends.is_some() && resolved_extends.is_empty();
        containers.insert(
            class.entity_id.clone(),
            ResolvedContainer {
                extends: resolved_extends,
                implements: class.implements.iter().filter_map(resolve).collect(),
                members: resolve_members_for(&class.members, path, import_targets, alias_targets),
                is_interface: false,
                has_unresolved_extends,
            },
        );
        owned_entities.push(class.entity_id.clone());
        entity_owner.insert(class.entity_id.clone(), path.to_owned());
        for member in &class.members {
            if contains_deferred(&member.type_ref) {
                deferred.members.push((
                    class.entity_id.clone(),
                    member.entity_id.clone(),
                    path.to_owned(),
                    member.type_ref.clone(),
                ));
            }
        }
    }
    for interface in &summary.interfaces {
        let resolve = |target: &HeritageTarget| {
            resolve_heritage_target(target, path, import_targets, alias_targets)
        };
        let resolved_extends: Vec<String> = interface.extends.iter().filter_map(resolve).collect();
        let has_unresolved_extends = resolved_extends.len() != interface.extends.len();
        containers.insert(
            interface.entity_id.clone(),
            ResolvedContainer {
                extends: resolved_extends,
                implements: Vec::new(),
                members: resolve_members_for(
                    &interface.members,
                    path,
                    import_targets,
                    alias_targets,
                ),
                is_interface: true,
                has_unresolved_extends,
            },
        );
        owned_entities.push(interface.entity_id.clone());
        entity_owner.insert(interface.entity_id.clone(), path.to_owned());
        for member in &interface.members {
            if contains_deferred(&member.type_ref) {
                deferred.members.push((
                    interface.entity_id.clone(),
                    member.entity_id.clone(),
                    path.to_owned(),
                    member.type_ref.clone(),
                ));
            }
        }
    }
    for function in &summary.functions {
        if let Some(return_type) =
            resolve_raw_type_ref(&function.return_type, path, import_targets, alias_targets)
        {
            function_return_types.insert(function.entity_id.clone(), return_type);
        } else if contains_deferred(&function.return_type) {
            deferred.functions.push((
                function.entity_id.clone(),
                path.to_owned(),
                function.return_type.clone(),
            ));
        }
        owned_entities.push(function.entity_id.clone());
        entity_owner.insert(function.entity_id.clone(), path.to_owned());
    }
    // P1-C: `const f = (...) => ...` callables -- merged into the SAME
    // `function_return_types` map, keyed by the VARIABLE's own entity id
    // (see `DeclSummary::callable_variables`'s doc comment).
    for callable in &summary.callable_variables {
        if let Some(return_type) =
            resolve_raw_type_ref(&callable.return_type, path, import_targets, alias_targets)
        {
            function_return_types.insert(callable.entity_id.clone(), return_type);
        } else if contains_deferred(&callable.return_type) {
            deferred.functions.push((
                callable.entity_id.clone(),
                path.to_owned(),
                callable.return_type.clone(),
            ));
        }
        owned_entities.push(callable.entity_id.clone());
        entity_owner.insert(callable.entity_id.clone(), path.to_owned());
    }
    // P1-A (object-literal shape): inserted into the SAME `containers` map
    // as classes/interfaces -- `is_interface: true` so `members`/`member_
    // type_ref` always treat every member as instance-shaped; no
    // `extends`/`implements` (an object literal has no heritage).
    for shape in &summary.object_shapes {
        containers.insert(
            shape.entity_id.clone(),
            ResolvedContainer {
                extends: Vec::new(),
                implements: Vec::new(),
                members: resolve_members_for(&shape.members, path, import_targets, alias_targets),
                is_interface: true,
                has_unresolved_extends: false,
            },
        );
        owned_entities.push(shape.entity_id.clone());
        entity_owner.insert(shape.entity_id.clone(), path.to_owned());
        for member in &shape.members {
            if contains_deferred(&member.type_ref) {
                deferred.members.push((
                    shape.entity_id.clone(),
                    member.entity_id.clone(),
                    path.to_owned(),
                    member.type_ref.clone(),
                ));
            }
        }
    }
    for variable in &summary.variables {
        if let Some(type_ref) =
            resolve_raw_type_ref(&variable.type_ref, path, import_targets, alias_targets)
        {
            variable_types.insert(variable.entity_id.clone(), type_ref);
        } else if contains_deferred(&variable.type_ref) {
            deferred.variables.push((
                variable.entity_id.clone(),
                path.to_owned(),
                variable.type_ref.clone(),
            ));
        }
        owned_entities.push(variable.entity_id.clone());
        entity_owner.insert(variable.entity_id.clone(), path.to_owned());
    }
    // E-P0d (2026-09-07): every top-level `type X = ...` declaration's OWN
    // id also needs an `entity_owner` entry -- found live on a real n8n
    // `head-vs-head200` git switch: `resolve_named_export` can resolve a
    // named import straight to a TYPE ALIAS's own id (`export type
    // IExecuteFunctions = ...`, `jsts:type:...`), and `link_importer`
    // (called right after this function, for every successfully-resolved
    // `import_targets` entry) requires `entity_owner.get(target_entity_id)`
    // to succeed to register the importer edge at all -- without this loop,
    // `entity_owner` never held a type alias's own id (only classes/
    // interfaces/functions/callable-variables/object-shapes/variables did),
    // so `link_importer` silently no-op'd for EVERY import resolving to a
    // type alias, meaning `importers_of`/`transitive_importers_closure`
    // could never widen an edit's own affected set to reach a file that
    // only imports something through a type alias -- an UNEDITED importer
    // permanently kept its FIRST-EVER (cold-scan) resolution, silently
    // stale after any later edit that shifted the alias's own `start`-
    // keyed id. This registration is purely additive for `link_importer`'s
    // own lookup: `containers`/`function_return_types`/`variable_types`
    // deliberately stay untouched here (a raw alias id is never queried
    // against them directly -- every consumer of `import_targets`
    // immediately runs the resolved id through `dealias_entity` first, see
    // `resolve_raw_type_ref`'s own `Imported` arm, so `containers.get`
    // never sees a bare alias id) and `alias_targets` (built wholesale by
    // `build_alias_targets`, independent of `entity_owner`) is unaffected
    // either way.
    for alias in &summary.type_aliases {
        owned_entities.push(alias.id.clone());
        entity_owner.insert(alias.id.clone(), path.to_owned());
    }
    deferred
}

/// Pass 2 (see `ProgramIndex::build`'s doc comment) for exactly ONE file:
/// patches a class's `extends` in place when it named a
/// `HeritageTarget::CallMember` target (`class X extends mixin(Base)`) --
/// needs every container's own member table already built (pass 1), so
/// this always runs strictly after it, whether at cold `build` or
/// incrementally.
fn run_pass2_for_summary(
    containers: &mut HashMap<String, ResolvedContainer>,
    summary: &DeclSummary,
    import_targets: &HashMap<(String, String, String), String>,
    alias_targets: &HashMap<String, Option<ResolvedTypeRef>>,
) {
    for class in &summary.classes {
        let Some(HeritageTarget::CallMember { base, member }) = &class.extends else {
            continue;
        };
        let Some(base_entity) =
            resolve_heritage_target(base, &summary.path, import_targets, alias_targets)
        else {
            continue;
        };
        let Some(ResolvedTypeRef::Entity(target_id)) =
            lookup_member_type_ref(containers, &base_entity, member, false)
        else {
            continue;
        };
        if let Some(container) = containers.get_mut(&class.entity_id) {
            container.extends = vec![target_id];
            // E-P0k: pass 1 conservatively marked this container's `extends`
            // unresolved (a `CallMember` mixin target is never resolvable
            // in pass 1 -- see `resolve_heritage_target`'s own doc comment)
            // -- now that pass 2 DID resolve it to a real container, the
            // `extends` chain is exactly as confidently known as an
            // ordinary resolved `extends` would have been from the start.
            container.has_unresolved_extends = false;
        }
    }
}

/// Pass 3's PER-FILE collection step (see `ProgramIndex::build`'s doc
/// comment): every unannotated function/method/object-shape-property
/// `summary` collected a `pending_return` for, with its `CallEntity`
/// import references already closed against `import_targets`
/// (`prepare_return_shapes`). Deliberately excludes `callable_variables`
/// -- matching `build`'s own pre-refactor collection loop, which never
/// fed them into this fixed point either (a callable variable's return
/// type is either declared or left `Unknown`, never body-inferred here).
fn collect_pending_for_summary(
    summary: &DeclSummary,
    import_targets: &HashMap<(String, String, String), String>,
    alias_targets: &HashMap<String, Option<ResolvedTypeRef>>,
    pending_functions: &mut Vec<(String, Vec<PreparedReturnShape>, bool)>,
    pending_members: &mut Vec<(String, String, Vec<PreparedReturnShape>, bool)>,
) {
    for function in &summary.functions {
        let Some(shapes) = &function.pending_return else {
            continue;
        };
        let Some(prepared) =
            prepare_return_shapes(shapes, &summary.path, import_targets, alias_targets)
        else {
            continue;
        };
        pending_functions.push((function.entity_id.clone(), prepared, function.is_async));
    }
    let mut collect_container_members = |container_id: &str, members: &[MemberEntry]| {
        for member in members {
            let Some(shapes) = &member.pending_return else {
                continue;
            };
            let Some(prepared) =
                prepare_return_shapes(shapes, &summary.path, import_targets, alias_targets)
            else {
                continue;
            };
            pending_members.push((
                container_id.to_owned(),
                member.entity_id.clone(),
                prepared,
                member.is_async,
            ));
        }
    };
    for class in &summary.classes {
        collect_container_members(&class.entity_id, &class.members);
    }
    for shape in &summary.object_shapes {
        collect_container_members(&shape.entity_id, &shape.members);
    }
}

/// Pass 3's fixed point (see `ProgramIndex::build`'s doc comment),
/// factored out so both `build` (seeded with the whole corpus's pending
/// entries) and an incremental reflow (seeded with just the affected
/// component's) run the identical convergence loop.
fn run_fixed_point_pass3(
    pending_functions: &mut Vec<(String, Vec<PreparedReturnShape>, bool)>,
    pending_members: &mut Vec<(String, String, Vec<PreparedReturnShape>, bool)>,
    containers: &mut HashMap<String, ResolvedContainer>,
    function_return_types: &mut HashMap<String, ResolvedTypeRef>,
) {
    const MAX_ITERATIONS: usize = 8;
    for _ in 0..MAX_ITERATIONS {
        if pending_functions.is_empty() && pending_members.is_empty() {
            break;
        }
        let mut progressed = false;
        pending_functions.retain(|(entity_id, shapes, is_async)| {
            match resolve_prepared_shapes(shapes, containers, function_return_types) {
                ShapeResolution::Resolved(resolved) => {
                    let final_ref = if *is_async {
                        ResolvedTypeRef::PromiseOf(Box::new(resolved))
                    } else {
                        resolved
                    };
                    function_return_types.insert(entity_id.clone(), final_ref);
                    progressed = true;
                    false
                }
                ShapeResolution::Conflict | ShapeResolution::Failed => {
                    progressed = true;
                    false
                }
                ShapeResolution::Pending => true,
            }
        });
        pending_members.retain(|(container_id, member_entity_id, shapes, is_async)| {
            match resolve_prepared_shapes(shapes, containers, function_return_types) {
                ShapeResolution::Resolved(resolved) => {
                    let final_ref = if *is_async {
                        ResolvedTypeRef::PromiseOf(Box::new(resolved))
                    } else {
                        resolved
                    };
                    if let Some(container) = containers.get_mut(container_id)
                        && let Some(member) = container
                            .members
                            .iter_mut()
                            .find(|member| &member.entity_id == member_entity_id)
                    {
                        member.type_ref = Some(final_ref);
                    }
                    progressed = true;
                    false
                }
                ShapeResolution::Conflict | ShapeResolution::Failed => {
                    progressed = true;
                    false
                }
                ShapeResolution::Pending => true,
            }
        });
        if !progressed {
            break;
        }
    }
}

/// Pass 4's fixed point (see `ProgramIndex::build`'s doc comment), factored
/// out the same way as `run_fixed_point_pass3`.
#[allow(clippy::too_many_arguments)]
fn run_fixed_point_pass4(
    pending_deferred_functions: &mut Vec<(String, String, RawTypeRef)>,
    pending_deferred_variables: &mut Vec<(String, String, RawTypeRef)>,
    pending_deferred_members: &mut Vec<(String, String, String, RawTypeRef)>,
    import_targets: &HashMap<(String, String, String), String>,
    containers: &mut HashMap<String, ResolvedContainer>,
    function_return_types: &mut HashMap<String, ResolvedTypeRef>,
    variable_types: &mut HashMap<String, ResolvedTypeRef>,
) {
    const MAX_DEFERRED_ITERATIONS: usize = 4;
    for _ in 0..MAX_DEFERRED_ITERATIONS {
        if pending_deferred_functions.is_empty()
            && pending_deferred_variables.is_empty()
            && pending_deferred_members.is_empty()
        {
            break;
        }
        let mut progressed = false;
        pending_deferred_functions.retain(|(entity_id, path, raw)| {
            match resolve_raw_type_ref_deferred(
                raw,
                path,
                import_targets,
                containers,
                function_return_types,
            ) {
                Some(resolved) => {
                    function_return_types.insert(entity_id.clone(), resolved);
                    progressed = true;
                    false
                }
                None => true,
            }
        });
        pending_deferred_variables.retain(|(entity_id, path, raw)| {
            match resolve_raw_type_ref_deferred(
                raw,
                path,
                import_targets,
                containers,
                function_return_types,
            ) {
                Some(resolved) => {
                    variable_types.insert(entity_id.clone(), resolved);
                    progressed = true;
                    false
                }
                None => true,
            }
        });
        pending_deferred_members.retain(|(container_id, member_id, path, raw)| {
            match resolve_raw_type_ref_deferred(
                raw,
                path,
                import_targets,
                containers,
                function_return_types,
            ) {
                Some(resolved) => {
                    if let Some(container) = containers.get_mut(container_id)
                        && let Some(member) = container
                            .members
                            .iter_mut()
                            .find(|member| &member.entity_id == member_id)
                    {
                        member.type_ref = Some(resolved);
                    }
                    progressed = true;
                    false
                }
                None => true,
            }
        });
        if !progressed {
            break;
        }
    }
}

/// Outcome of `ProgramIndex::members`: how many distinct member entities
/// `name` (at the requested static/instance disposition) resolves to across
/// the base entity's own declaration and its heritage chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemberLookup {
    None,
    One(String),
    Many(Vec<String>),
    /// P2-2j: the outcome of `ProgramIndex::members_of_union` -- two or more
    /// CANDIDATE member entity ids gathered across a union receiver's own
    /// constituent entities (`RawTypeRef::Union`/the syntax worker's
    /// `TypeflowValue::Union`). Distinct from `Many` (an overloaded member
    /// declared more than once on a SINGLE container): this variant pools
    /// the member lookups of DIFFERENT constituent containers. 2026-09-05
    /// A5 references-parity task, Paso 1 fix point 5: when every
    /// constituent's own lookup agrees on the exact SAME member id, `members_
    /// of_union` now promotes that outcome to `One` instead (proven safe --
    /// see that function's own doc comment for why this is not a guess);
    /// this variant therefore only ever holds two or more DISTINCT ids --
    /// a genuine ambiguity about which of several different declarations
    /// answers the read, not merely about which constituent type the
    /// runtime value actually is. `members()` (single-entity) never
    /// constructs this variant itself -- only `members_of_union` does.
    UnionCandidates(Vec<String>),
}

impl ProgramIndex {
    pub fn telemetry(&self) -> TypeflowTelemetry {
        self.telemetry
    }

    /// `import_targets` maps `(owning_path, specifier, imported_name)` (a
    /// `HeritageTarget::Imported`'s three fields, `imported_name` `""` for a
    /// default/namespace import -- never resolved, see that variant's doc
    /// comment) to the already-resolved entity id, computed by the caller
    /// with `WorkspaceResolver::resolve` + `resolver::resolve_named_export`
    /// (E2). A key absent from this map (unresolved, ambiguous, or a
    /// default/namespace import) makes that heritage edge `Unknown` here
    /// too -- never a guess.
    ///
    /// **P3-8a**: implemented in terms of the same per-file building blocks
    /// `replace_file`/`add_file`/`remove_file` use (`insert_file_pass1`,
    /// `run_pass2_for_summary`, `collect_pending_for_summary`,
    /// `run_fixed_point_pass3`/`4`) -- a from-scratch `build` and an index
    /// that reached the same state incrementally are computed by identical
    /// code, just over a different-sized file set each call.
    ///
    /// `pending_targets`: `owning_path -> set of target file paths` this
    /// call's own needed-imports scan resolved a specifier to but could not
    /// resolve the named export within (see `pending_importers_of`'s own
    /// doc comment) -- inverted here into that field exactly like
    /// `import_targets` is inverted into `importers_of` below.
    pub fn build(
        summaries: &BTreeMap<String, DeclSummary>,
        import_targets: &HashMap<(String, String, String), String>,
        pending_targets: &HashMap<String, HashSet<String>>,
    ) -> Self {
        Self::build_with_telemetry(summaries, import_targets, pending_targets, false)
    }

    /// Same as [`Self::build`], with opt-in diagnostics for the alias-target
    /// phase. The flag is threaded by the indexing worker only for its
    /// stderr profiling pass, so ordinary callers retain the zero-overhead
    /// path.
    pub fn build_with_telemetry(
        summaries: &BTreeMap<String, DeclSummary>,
        import_targets: &HashMap<(String, String, String), String>,
        pending_targets: &HashMap<String, HashSet<String>>,
        telemetry_enabled: bool,
    ) -> Self {
        let (alias_targets, telemetry) =
            build_alias_targets(summaries, import_targets, telemetry_enabled);
        let mut me = Self {
            telemetry,
            telemetry_enabled,
            containers: HashMap::new(),
            conformance_children: HashMap::new(),
            function_return_types: HashMap::new(),
            variable_types: HashMap::new(),
            summaries: summaries.clone(),
            import_targets: import_targets.clone(),
            alias_targets,
            file_import_keys: HashMap::new(),
            entity_owner: HashMap::new(),
            file_entities: HashMap::new(),
            importers_of: HashMap::new(),
            pending_importers_of: HashMap::new(),
        };
        for key in import_targets.keys() {
            me.file_import_keys
                .entry(key.0.clone())
                .or_default()
                .insert(key.clone());
        }
        for (owning_path, target_paths) in pending_targets {
            for target_path in target_paths {
                me.pending_importers_of
                    .entry(target_path.clone())
                    .or_default()
                    .insert(owning_path.clone());
            }
        }

        let mut deferred_functions = Vec::new();
        let mut deferred_variables = Vec::new();
        let mut deferred_members = Vec::new();
        for summary in summaries.values() {
            let mut owned = Vec::new();
            let file_deferred = insert_file_pass1(
                &mut me.containers,
                &mut me.function_return_types,
                &mut me.variable_types,
                &mut me.entity_owner,
                &mut owned,
                summary,
                &me.import_targets,
                &me.alias_targets,
            );
            me.file_entities.insert(summary.path.clone(), owned);
            deferred_functions.extend(file_deferred.functions);
            deferred_variables.extend(file_deferred.variables);
            deferred_members.extend(file_deferred.members);
        }
        // `entity_owner` is now fully populated -- link the reverse
        // importer graph from the (unchanged) `import_targets` table.
        for (key, target) in import_targets {
            me.link_importer(target, &key.0);
        }

        for summary in summaries.values() {
            run_pass2_for_summary(
                &mut me.containers,
                summary,
                &me.import_targets,
                &me.alias_targets,
            );
        }
        me.index_all_conformance_edges();

        let mut pending_functions = Vec::new();
        let mut pending_members = Vec::new();
        for summary in summaries.values() {
            collect_pending_for_summary(
                summary,
                &me.import_targets,
                &me.alias_targets,
                &mut pending_functions,
                &mut pending_members,
            );
        }
        run_fixed_point_pass3(
            &mut pending_functions,
            &mut pending_members,
            &mut me.containers,
            &mut me.function_return_types,
        );

        run_fixed_point_pass4(
            &mut deferred_functions,
            &mut deferred_variables,
            &mut deferred_members,
            &me.import_targets,
            &mut me.containers,
            &mut me.function_return_types,
            &mut me.variable_types,
        );

        me
    }

    /// P3-8a: the direct (non-transitive) set of files whose CURRENT
    /// `import_targets` names one of `path`'s entities as a target -- a
    /// caller (`v4/typeflow.rs`, or this crate's own randomized test) can
    /// use this BEFORE editing `path` to know which other files' own
    /// needed-imports it should re-resolve and hand to `replace_file`/
    /// `add_file`/`remove_file` alongside `path` itself, so a shift in one
    /// of `path`'s exported entity ids (any textual edit before an export
    /// changes that export's `start`-keyed entity id) doesn't leave an
    /// importer's `import_targets` entry pointing at a now-nonexistent id.
    pub fn importers_of(&self, path: &str) -> Vec<String> {
        self.importers_of
            .get(path)
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// E-P0d: the direct set of files that currently have at least one
    /// named-import need whose specifier resolves to `path` but whose named
    /// export does not (yet) -- see `pending_importers_of`'s (the field)
    /// own doc comment. A caller (`v4/typeflow.rs`'s `build_index` warm
    /// loop) widens its own `refresh_paths` with this, alongside
    /// `importers_of`, so a file whose only link to `path` has never
    /// resolved still gets re-attempted when `path` changes.
    pub fn pending_importers_of(&self, path: &str) -> Vec<String> {
        self.pending_importers_of
            .get(path)
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Test-only: the number of TARGET keys currently held in `pending_
    /// importers_of`, regardless of whether any of them are queried --
    /// `pending_importers_of(path)` alone cannot distinguish "key absent"
    /// from "key present with an empty set" from the outside, so a
    /// regression test asserting a stale target-key entry was actually
    /// dropped (not merely unreachable through the one path it queries)
    /// needs this.
    #[cfg(test)]
    fn pending_importers_of_entry_count(&self) -> usize {
        self.pending_importers_of.len()
    }

    /// P3-8a: `{path}` plus every file transitively reachable by following
    /// `importers_of` edges -- the affected component an edit to `path`
    /// must reflow for the fixed point (pass 3/4) to converge to the same
    /// state a from-scratch `build` would reach. Bounded by the number of
    /// distinct files actually in the importer graph (a plain graph BFS,
    /// no separate iteration cap -- capping this would be a correctness
    /// bug, not a performance one: an uncapped chain simply means an
    /// uncapped chain of real cross-file type dependencies exists).
    ///
    /// E-P0d: ALSO follows `pending_importers_of` edges, same BFS, same
    /// queue -- a file with only a still-failing link to `path` must be
    /// reflowed too, exactly like a successfully-linked importer, so its
    /// own needed-imports get a fresh chance against `path`'s current
    /// (post-edit) shape.
    fn transitive_importers_closure(&self, path: &str) -> Vec<String> {
        let mut visited: HashSet<String> = HashSet::new();
        let mut queue: Vec<String> = vec![path.to_owned()];
        visited.insert(path.to_owned());
        let mut order = Vec::new();
        while let Some(next) = queue.pop() {
            order.push(next.clone());
            if let Some(importers) = self.importers_of.get(&next) {
                for importer in importers {
                    if visited.insert(importer.clone()) {
                        queue.push(importer.clone());
                    }
                }
            }
            if let Some(importers) = self.pending_importers_of.get(&next) {
                for importer in importers {
                    if visited.insert(importer.clone()) {
                        queue.push(importer.clone());
                    }
                }
            }
        }
        // Deterministic order: `self.importers_of`'s values are `HashSet`s
        // (randomized iteration order per Rust's default hasher), which
        // would otherwise make `reflow_files`' processing order -- and
        // therefore which fixed-point ITERATION a given entry happens to
        // resolve in, though never the value it converges to -- vary
        // between two otherwise-identical incremental runs. Sorting here
        // keeps the crate's own cold-path guarantee ("two calls with
        // identical inputs produce a byte-identical `ProgramIndex`",
        // `build`'s own doc comment) equally true for the incremental
        // path.
        order.sort();
        order
    }

    /// Records that `importer_path` currently has an `import_targets` entry
    /// resolving to `target_entity_id` -- adds `importer_path` to the
    /// target's owning file's importer set (a no-op if the target entity
    /// isn't owned by any known file, e.g. an unresolved/default import).
    fn link_importer(&mut self, target_entity_id: &str, importer_path: &str) {
        if let Some(owner) = self.entity_owner.get(target_entity_id) {
            self.importers_of
                .entry(owner.clone())
                .or_default()
                .insert(importer_path.to_owned());
        }
    }

    /// Inverse of `link_importer`: `importer_path` no longer has (or is
    /// about to stop having) an entry resolving to `target_entity_id`.
    /// Only actually removes `importer_path` from the target's owner's
    /// importer set if NO OTHER remaining key of `importer_path`'s own
    /// `file_import_keys` still resolves to that same owner (an importer
    /// can import several distinct entities from the same file) --
    /// bounded by that one file's own import-key count, never the corpus.
    fn unlink_importer(&mut self, target_entity_id: &str, importer_path: &str) {
        let Some(owner) = self.entity_owner.get(target_entity_id).cloned() else {
            return;
        };
        let still_referenced = self
            .file_import_keys
            .get(importer_path)
            .is_some_and(|keys| {
                keys.iter().any(|key| {
                    self.import_targets
                        .get(key)
                        .and_then(|id| self.entity_owner.get(id))
                        == Some(&owner)
                })
            });
        if !still_referenced && let Some(importers) = self.importers_of.get_mut(&owner) {
            importers.remove(importer_path);
            if importers.is_empty() {
                self.importers_of.remove(&owner);
            }
        }
    }

    /// P3-8a: replaces every `import_targets` entry belonging to each
    /// owning path in `owning_paths_considered` with EXACTLY `updates`' own
    /// entries for that path (a full per-file snapshot, never a partial
    /// patch -- the caller re-resolves and hands over that file's WHOLE
    /// current needed-imports set, so a specifier that stopped resolving,
    /// or stopped being needed at all, is correctly dropped rather than
    /// left stale). An owning path absent from `owning_paths_considered`
    /// entirely keeps its previous entries untouched.
    ///
    /// Frente E-P0g fix: `owning_paths_considered` used to be derived
    /// SOLELY from `updates`' own keys (`updates.keys().map(|k| k.0)`) --
    /// correct as long as an owning path keeps AT LEAST ONE resolved
    /// import, but silently wrong the moment a path's ENTIRE needed-import
    /// set stops resolving (a specifier's target file disappears/renames):
    /// `updates` then has NO entry at all for that owning path (there is
    /// nothing to insert), so the old derivation's `owning_paths` came back
    /// empty for it and `clear_owning_path_import_targets` never ran --
    /// the STALE `import_targets`/`importers_of` edge (still pointing at
    /// the last entity it ever resolved to) survived forever, byte-
    /// identical to before the specifier broke. Confirmed live on n8n
    /// (`docs/evidence/2026-09-06-v4-reconcile-threshold.md` §15.4/§16):
    /// removing/renaming a re-exporting barrel left a real consumer's
    /// method-call resolution through it unchanged. The caller now passes
    /// `owning_paths_considered` explicitly -- exactly the owning-path
    /// universe it re-resolved this call (`v4/typeflow.rs`'s own
    /// `resolve_import_targets_for` already computes this reliably via
    /// `pending_targets`' guaranteed one-entry-per-queried-path contract,
    /// see that function's own doc comment), so a path that resolved NOTHING
    /// this round is still correctly cleared.
    ///
    /// Deliberately does NOT call `link_importer` itself -- a `replace_
    /// file`/`add_file` update's target entity (typically `path`'s OWN
    /// entity, when some OTHER file's entry now points at it) may not be
    /// registered in `entity_owner` yet at the point this runs (`path`'s
    /// pass 1 hasn't executed for its NEW summary). **Found live**: linking
    /// eagerly here silently dropped every importer edge pointing at the
    /// file just being replaced, since `entity_owner.get(new_target_id)`
    /// always missed at this point -- `importers_of(path)` for a file with
    /// real importers came back empty after its very next edit, caught by
    /// `incremental_matches_from_scratch_after_random_edit_sequences_over_
    /// synthetic_project`. Callers must apply the returned pairs via
    /// `link_importer` AFTER `reflow_files` has re-registered every
    /// affected file's CURRENT entities (`replace_file` does this).
    fn apply_import_target_updates(
        &mut self,
        updates: &HashMap<(String, String, String), String>,
        owning_paths_considered: &HashSet<String>,
    ) -> Vec<((String, String, String), String)> {
        let mut owning_paths: HashSet<String> = updates.keys().map(|key| key.0.clone()).collect();
        owning_paths.extend(owning_paths_considered.iter().cloned());
        for owning_path in &owning_paths {
            self.clear_owning_path_import_targets(owning_path);
        }
        for (key, target) in updates {
            self.import_targets.insert(key.clone(), target.clone());
            self.file_import_keys
                .entry(key.0.clone())
                .or_default()
                .insert(key.clone());
        }
        updates
            .iter()
            .map(|(key, target)| (key.clone(), target.clone()))
            .collect()
    }

    /// Drops every `import_targets` entry owned by `owning_path` (used both
    /// by `apply_import_target_updates`, before installing a fresh
    /// snapshot, and by `remove_file`, which needs zero entries left for a
    /// file that no longer exists).
    fn clear_owning_path_import_targets(&mut self, owning_path: &str) {
        let Some(old_keys) = self.file_import_keys.remove(owning_path) else {
            return;
        };
        for key in &old_keys {
            if let Some(old_target) = self.import_targets.remove(key) {
                self.unlink_importer(&old_target, owning_path);
            }
        }
    }

    /// E-P0d: `pending_importers_of`'s own counterpart to `apply_import_
    /// target_updates` -- replaces EVERY `pending_importers_of` edge whose
    /// importer is one of `updates`' own keys (owning paths) with EXACTLY
    /// `updates`' fresh set of still-unresolved target files for that path
    /// (a full per-owning-path snapshot, never a partial patch, same
    /// discipline `apply_import_target_updates` uses for the resolved-edge
    /// graph -- a path whose need just resolved, or stopped being needed at
    /// all, must stop being retried, or `transitive_importers_closure`
    /// would keep sweeping it in forever). An owning path absent from
    /// `updates` entirely keeps its previous pending edges untouched (the
    /// caller did not re-resolve it this call).
    ///
    /// Bounded by `self.pending_importers_of`'s own size (real corpora keep
    /// this small: it only ever holds a specifier that resolved to a KNOWN
    /// file but not yet to a specific export -- most unresolved imports
    /// never reach a target file at all, e.g. a third-party package or an
    /// unrelated resolver miss, and are never recorded here).
    fn apply_pending_target_updates(&mut self, updates: &HashMap<String, HashSet<String>>) {
        for owning_path in updates.keys() {
            for importers in self.pending_importers_of.values_mut() {
                importers.remove(owning_path);
            }
        }
        self.pending_importers_of
            .retain(|_, importers| !importers.is_empty());
        for (owning_path, target_paths) in updates {
            for target_path in target_paths {
                self.pending_importers_of
                    .entry(target_path.clone())
                    .or_default()
                    .insert(owning_path.clone());
            }
        }
    }

    /// Undoes exactly one file's pass-1 output: every entity id it
    /// registered into `containers`/`function_return_types`/
    /// `variable_types`, plus its `entity_owner` entries. Leaves
    /// `import_targets`/`importers_of` untouched -- those are the CALLER's
    /// (or `apply_import_target_updates`'s) responsibility, not tied to a
    /// single file's pass-1 registration.
    fn remove_file_contributions(&mut self, path: &str) {
        let Some(entities) = self.file_entities.remove(path) else {
            return;
        };
        for entity_id in entities {
            if let Some(container) = self.containers.remove(&entity_id) {
                self.remove_conformance_edges(&entity_id, &container);
            }
            self.function_return_types.remove(&entity_id);
            self.variable_types.remove(&entity_id);
            self.entity_owner.remove(&entity_id);
        }
    }

    /// Adds one direct reverse heritage edge. This is deliberately called
    /// after pass 2: that pass may replace a `CallMember`'s provisional/
    /// unresolved `extends` state.
    fn add_conformance_edge(&mut self, base_id: &str, container_id: &str) {
        self.conformance_children
            .entry(base_id.to_owned())
            .or_default()
            .insert(container_id.to_owned());
    }

    /// Removes the direct reverse heritage edges owned by one container.
    /// Empty buckets are dropped so repeated replace/remove operations do not
    /// retain an unbounded trail of dead ids.
    fn remove_conformance_edges(&mut self, container_id: &str, container: &ResolvedContainer) {
        for base_id in container.extends.iter().chain(container.implements.iter()) {
            let mut remove_bucket = false;
            if let Some(children) = self.conformance_children.get_mut(base_id) {
                children.remove(container_id);
                remove_bucket = children.is_empty();
            }
            if remove_bucket {
                self.conformance_children.remove(base_id);
            }
        }
    }

    /// Indexes every currently-live container. Used only by the cold build;
    /// incremental reflows call `index_conformance_edges_for_files` below.
    fn index_all_conformance_edges(&mut self) {
        let edges: Vec<(String, String)> = self
            .containers
            .iter()
            .flat_map(|(container_id, container)| {
                container
                    .extends
                    .iter()
                    .chain(container.implements.iter())
                    .map(move |base_id| (base_id.clone(), container_id.clone()))
            })
            .collect();
        for (base_id, container_id) in edges {
            self.add_conformance_edge(&base_id, &container_id);
        }
    }

    /// Indexes only the containers re-registered by one incremental reflow.
    /// The old contributions were removed before pass 1, so this cannot leave
    /// duplicate reverse edges in the direct index.
    fn index_conformance_edges_for_files(&mut self, files: &[String]) {
        let container_ids: Vec<String> = files
            .iter()
            .filter_map(|file| self.file_entities.get(file))
            .flat_map(|entities| entities.iter())
            .filter(|entity_id| self.containers.contains_key(*entity_id))
            .cloned()
            .collect();
        let edges: Vec<(String, String)> = container_ids
            .iter()
            .filter_map(|container_id| self.containers.get(container_id).map(|c| (container_id, c)))
            .flat_map(|(container_id, container)| {
                container
                    .extends
                    .iter()
                    .chain(container.implements.iter())
                    .map(move |base_id| (base_id.clone(), container_id.clone()))
            })
            .collect();
        for (base_id, container_id) in edges {
            self.add_conformance_edge(&base_id, &container_id);
        }
    }

    /// Re-runs the four-pass closure (pass 1 registration, pass 2
    /// `CallMember` heritage, pass 3/4 fixed points) restricted to exactly
    /// `files` -- every file's CURRENT `self.summaries` entry is used (the
    /// caller is responsible for having already inserted a fresh summary
    /// for the literally-edited file before calling this). Correct as long
    /// as `files` already contains the full affected component (`{path}`
    /// plus `transitive_importers_closure(path)`), which every public
    /// caller of this function below arranges.
    fn reflow_files(&mut self, files: &[String]) {
        for file in files {
            self.remove_file_contributions(file);
        }
        // D.2: recomputed wholesale from `self.summaries` (already current
        // -- the caller installs a fresh summary for the edited file
        // before calling this) -- see `alias_targets`'s own doc comment
        // for why a full recompute, not an incremental patch, is correct
        // and cheap here.
        let (alias_targets, telemetry) = build_alias_targets(
            &self.summaries,
            &self.import_targets,
            self.telemetry_enabled,
        );
        self.alias_targets = alias_targets;
        self.telemetry = telemetry;
        let mut deferred_functions = Vec::new();
        let mut deferred_variables = Vec::new();
        let mut deferred_members = Vec::new();
        for file in files {
            let Some(summary) = self.summaries.get(file).cloned() else {
                // Already removed (this is `remove_file`'s own target) --
                // nothing to reflow for it, though it still needed to run
                // through `remove_file_contributions` above and still
                // counts as part of the affected component for its own
                // (former) importers, already included in `files`.
                continue;
            };
            let mut owned = Vec::new();
            let file_deferred = insert_file_pass1(
                &mut self.containers,
                &mut self.function_return_types,
                &mut self.variable_types,
                &mut self.entity_owner,
                &mut owned,
                &summary,
                &self.import_targets,
                &self.alias_targets,
            );
            self.file_entities.insert(file.clone(), owned);
            deferred_functions.extend(file_deferred.functions);
            deferred_variables.extend(file_deferred.variables);
            deferred_members.extend(file_deferred.members);
        }
        for file in files {
            if let Some(summary) = self.summaries.get(file).cloned() {
                run_pass2_for_summary(
                    &mut self.containers,
                    &summary,
                    &self.import_targets,
                    &self.alias_targets,
                );
            }
        }
        self.index_conformance_edges_for_files(files);
        let mut pending_functions = Vec::new();
        let mut pending_members = Vec::new();
        for file in files {
            if let Some(summary) = self.summaries.get(file).cloned() {
                collect_pending_for_summary(
                    &summary,
                    &self.import_targets,
                    &self.alias_targets,
                    &mut pending_functions,
                    &mut pending_members,
                );
            }
        }
        run_fixed_point_pass3(
            &mut pending_functions,
            &mut pending_members,
            &mut self.containers,
            &mut self.function_return_types,
        );
        run_fixed_point_pass4(
            &mut deferred_functions,
            &mut deferred_variables,
            &mut deferred_members,
            &self.import_targets,
            &mut self.containers,
            &mut self.function_return_types,
            &mut self.variable_types,
        );
    }

    /// P3-8a: incrementally installs `summary` as `path`'s current
    /// `DeclSummary` (replacing whatever it held before, if anything --
    /// this is the SAME operation for a brand-new path and a content edit
    /// to an existing one, mirroring `TypeflowCache::replace_file`'s own
    /// doc comment for why `add_file` is just an alias below) and re-runs
    /// the four-pass closure over exactly the affected component: `path`
    /// itself plus every file that currently imports one of `path`'s
    /// entities, transitively (`importers_of`/`transitive_importers_
    /// closure`) -- computed BEFORE `import_targets_updates` is merged, so
    /// it reflects who imported from `path` under its PREVIOUS content.
    ///
    /// `import_targets_updates` must be a full, freshly-resolved
    /// needed-imports snapshot (see `apply_import_target_updates`'s doc
    /// comment) for `path` itself, and -- for correctness against an edit
    /// that shifts one of `path`'s exported entities' `start`-keyed id --
    /// SHOULD also include a fresh snapshot for each of `importers_of(path)`
    /// (queried by the caller before this call, using the pre-edit graph),
    /// so they re-point at `path`'s NEW id instead of losing the edge.
    /// Omitting an importer's refresh here is SAFE (never produces a wrong
    /// answer, only a possibly-stale-until-that-importer's-own-next-edit
    /// "unresolved" where a from-scratch rebuild would have resolved) --
    /// `purge_import_targets_targeting_file`, below, unconditionally drops
    /// every importer's entry pointing at `path`'s OLD entities regardless
    /// of whether the caller remembered to refresh it, so a stale
    /// (dangling) id can never survive into `containers`/`function_return_
    /// types` the way `remove_file`'s own doc comment found live.
    /// E-P0d: `pending_target_updates` is the same kind of full, fresh
    /// snapshot `import_targets_updates` is (see `apply_pending_target_
    /// updates`'s own doc comment) -- covering the SAME owning-path
    /// universe the caller re-resolved to produce `import_targets_updates`
    /// (`path` itself, plus `importers_of(path)`/`pending_importers_of
    /// (path)` under the pre-edit graph), never a partial patch.
    pub fn replace_file(
        &mut self,
        path: &str,
        summary: DeclSummary,
        import_targets_updates: &HashMap<(String, String, String), String>,
        pending_target_updates: &HashMap<String, HashSet<String>>,
    ) {
        let affected = self.transitive_importers_closure(path);
        self.purge_import_targets_targeting_file(path);
        // Frente E-P0g: `pending_target_updates`' own keys reliably name
        // EVERY owning path the caller re-resolved this call (see
        // `resolve_import_targets_for`'s "one entry per queried path,
        // even if empty" contract) -- `apply_import_target_updates` needs
        // that full universe, not just the subset that happened to resolve
        // something, to correctly clear a path whose entire needed-import
        // set just went stale. See that function's own doc comment.
        let owning_paths_considered: HashSet<String> =
            pending_target_updates.keys().cloned().collect();
        let pending_links =
            self.apply_import_target_updates(import_targets_updates, &owning_paths_considered);
        self.apply_pending_target_updates(pending_target_updates);
        self.remove_file_contributions(path);
        self.summaries.insert(path.to_owned(), summary);
        self.reflow_files(&affected);
        // Only now, after `reflow_files` has re-registered every affected
        // file's CURRENT entities into `entity_owner` (`path`'s own NEW
        // ones included), can `link_importer` correctly resolve which file
        // owns each update's target -- see `apply_import_target_updates`'s
        // doc comment for the bug this ordering fixes.
        for (key, target) in &pending_links {
            self.link_importer(target, &key.0);
        }
    }

    /// Alias for [`Self::replace_file`] -- a `DeclSummary` has no notion of
    /// "this path is new" vs "this path's content changed" (same rationale
    /// `TypeflowCache::add_from_owner`'s doc comment gives), so a brand-new
    /// path is handled by the identical code path (its `transitive_
    /// importers_closure` will simply be `{path}` alone, since nothing
    /// could have imported a path that did not exist yet).
    pub fn add_file(
        &mut self,
        path: &str,
        summary: DeclSummary,
        import_targets_updates: &HashMap<(String, String, String), String>,
        pending_target_updates: &HashMap<String, HashSet<String>>,
    ) {
        self.replace_file(
            path,
            summary,
            import_targets_updates,
            pending_target_updates,
        );
    }

    /// P3-8a: drops `path` entirely (no replacement `DeclSummary`) and
    /// reflows every file that used to import from it, transitively, so
    /// their heritage/type-ref/pending-return resolutions correctly
    /// degrade to "unresolved" wherever they depended on something only
    /// `path` declared -- exactly what a from-scratch rebuild of the
    /// corpus without `path` would also produce.
    ///
    /// Unlike `replace_file`, there is no fresh `DeclSummary` for `path` to
    /// derive updated `import_targets` from, so this method cannot rely on
    /// the caller to refresh importers' entries the way `replace_file`'s
    /// own doc comment asks -- it PROACTIVELY purges every `import_targets`
    /// entry (in any importer) whose value names one of `path`'s own
    /// (about-to-be-removed) entities, via `purge_import_targets_targeting_
    /// file`, run BEFORE `remove_file_contributions` erases the ownership
    /// bookkeeping that lookup needs. Found live: without this, an
    /// importer's `extends`/`type_ref` kept the STALE, now-dangling entity
    /// id (`resolve_heritage_target`/`resolve_raw_type_ref` only ever
    /// CONSULT `import_targets`, they never verify the resolved id still
    /// exists in `containers`) -- observably different `ResolvedContainer`
    /// state than a from-scratch rebuild (which never had that key at all),
    /// even though a `members`/`member_type_ref` QUERY against either
    /// state degrades to the same answer either way (a dangling id and an
    /// absent one both make `self.containers.get(id)` return `None`) --
    /// caught by `incremental_matches_from_scratch_after_random_edit_
    /// sequences_over_synthetic_project`'s full-state comparison, not by a
    /// query-level check.
    pub fn remove_file(&mut self, path: &str) {
        let affected = self.transitive_importers_closure(path);
        self.purge_import_targets_targeting_file(path);
        self.remove_file_contributions(path);
        self.summaries.remove(path);
        self.clear_owning_path_import_targets(path);
        // E-P0d: `path` no longer has any needs of its own (resolved or
        // still-pending) to retry later -- mirrors `clear_owning_path_
        // import_targets` just above, for the pending-edge graph.
        self.apply_pending_target_updates(&HashMap::from([(path.to_owned(), HashSet::new())]));
        // E-P0d review fix (2026-09-07): `path` may ALSO be a TARGET other
        // files are still waiting on (`self.pending_importers_of[path]`,
        // e.g. `path` was a barrel some importer's need resolved a
        // specifier to but whose export was never found) -- the line above
        // only clears edges where `path` is the IMPORTER (a value inside
        // some other target's set), never the entry keyed by `path` itself.
        // Without this, deleting a file that had pending importers leaves a
        // permanent, unbounded-over-time entry in `pending_importers_of`
        // (violates that field's own doc comment, "real corpora keep this
        // small") -- it only ever self-heals if the stranded importer
        // happens to be reprocessed for an unrelated reason later. The
        // importer itself is not orphaned by this: it was already captured
        // into `affected` above (`transitive_importers_closure` reads this
        // same map before we clear it) and gets reflowed below like any
        // other affected file, correctly degrading its own pending need
        // to "no target file at all" -- exactly what a from-scratch rebuild
        // without `path` would also produce.
        self.pending_importers_of.remove(path);
        let reflow_targets: Vec<String> = affected.into_iter().filter(|f| f != path).collect();
        self.reflow_files(&reflow_targets);
    }

    /// Removes every `import_targets` entry (in any CURRENT importer of
    /// `owner_path`) whose resolved value is one of `owner_path`'s own
    /// entities -- see `remove_file`'s doc comment for why this must run
    /// while `file_entities`/`entity_owner` still reflect `owner_path`'s
    /// (about-to-be-removed) contributions. Also drops `owner_path`'s own
    /// `importers_of` entry (it is being removed from the graph, not just
    /// having its incoming edges pruned).
    fn purge_import_targets_targeting_file(&mut self, owner_path: &str) {
        let owned_entities: HashSet<String> = self
            .file_entities
            .get(owner_path)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .collect();
        let Some(importers) = self.importers_of.remove(owner_path) else {
            return;
        };
        if owned_entities.is_empty() {
            return;
        }
        for importer in importers {
            let stale_keys: Vec<(String, String, String)> = self
                .file_import_keys
                .get(&importer)
                .into_iter()
                .flatten()
                .filter(|key| {
                    self.import_targets
                        .get(*key)
                        .is_some_and(|target| owned_entities.contains(target))
                })
                .cloned()
                .collect();
            for key in stale_keys {
                self.import_targets.remove(&key);
                if let Some(keys) = self.file_import_keys.get_mut(&importer) {
                    keys.remove(&key);
                }
            }
        }
    }

    /// Whether `entity_id` names a class or interface this index knows
    /// about (own file's `DeclSummary` contributed it) -- lets the caller
    /// distinguish "not a container at all" (e.g. a function/variable
    /// entity id, or an entity this prototype's extraction never reached)
    /// from a container with zero matching members.
    pub fn is_container(&self, entity_id: &str) -> bool {
        self.containers.contains_key(entity_id)
    }

    /// Find every entity `name` (at the given static/instance disposition)
    /// resolves to, starting at `entity_id`'s OWN member table, then its
    /// `extends` chain (recursively), then -- for a CLASS only, as a
    /// fallback when neither its own body nor its extends chain declared
    /// the member -- its `implements` interfaces' own chains (a class
    /// satisfying an interface without a textually distinct declaration is
    /// rare but not invalid TS; see the module doc for why interfaces have
    /// no `implements` fallback of their own). `is_static` is ignored for
    /// an interface-typed base (see `member_entry_of_signature`'s doc
    /// comment). Depth-capped and cycle-guarded (a malformed/mutually
    /// recursive heritage graph degrades to `None` instead of looping).
    ///
    /// E-P0k (2026-09-08): the `implements` fallback above is only ever
    /// SOUND when the `extends` chain it is standing in for was fully and
    /// confidently walked to its own end with NO matching member anywhere
    /// -- i.e. every container from `entity_id` up through its (possibly
    /// empty) `extends` chain is one this index actually indexed
    /// (`ResolvedContainer::has_unresolved_extends` doc comment). When ANY
    /// container along that walk has an `extends` clause this crate could
    /// not resolve (an external base, a mixin factory, ...), the member
    /// might genuinely live on that untracked ancestor, several hops above
    /// where this crate gave up -- using `implements` as a stand-in in that
    /// situation is a guess this crate's whole discipline exists to refuse
    /// (found live: `MarkersTree extends WorkbenchObjectTree<...> implements
    /// IProblemsWidget` resolving `getSelection`/`getHTMLElement` to
    /// `IProblemsWidget`'s own method SIGNATURE instead of the real
    /// implementation several `extends` hops up in `AbstractTree`, which
    /// this crate's heritage classification never fully threaded through).
    /// `collect_members` now threads an `uncertain` flag back up alongside
    /// `found`: `Many` (never `One`) as soon as the search comes back both
    /// EMPTY and uncertain, since "empty and uncertain" and "genuinely
    /// ambiguous" both mean the same thing here -- do not guess.
    pub fn members(&self, entity_id: &str, name: &str, is_static: bool) -> MemberLookup {
        // The overwhelmingly common hit is a member declared directly on the
        // receiver.  Resolve that case before allocating the walk's visited
        // set/results vector.  `collect_members` already treats an own match
        // as authoritative, so this is only a representation fast path.
        if let Some(container) = self.containers.get(entity_id) {
            let effective_static = is_static && !container.is_interface;
            let mut own_matches = container
                .members
                .iter()
                .filter(|member| member.name == name && member.is_static == effective_static);
            let Some(first) = own_matches.next() else {
                // The miss path below starts at the heritage edges and must
                // not scan this container's own member table a second time.
                let mut visited = std::collections::HashSet::new();
                let mut found = Vec::new();
                let uncertain = self.collect_members(
                    entity_id,
                    name,
                    is_static,
                    &mut visited,
                    &mut found,
                    true,
                    false,
                );
                found.sort();
                found.dedup();
                return match (found.len(), uncertain) {
                    (0, _) => MemberLookup::None,
                    (1, false) => MemberLookup::One(found.pop().expect("checked len == 1")),
                    _ => MemberLookup::Many(found),
                };
            };
            let Some(second) = own_matches.next() else {
                return MemberLookup::One(first.entity_id.clone());
            };
            let mut own = vec![first.entity_id.clone(), second.entity_id.clone()];
            own.extend(own_matches.map(|member| member.entity_id.clone()));
            own.sort();
            own.dedup();
            return match own.len() {
                1 => MemberLookup::One(own.pop().expect("checked len == 1")),
                _ => MemberLookup::Many(own),
            };
        }
        let mut visited = std::collections::HashSet::new();
        let mut found = Vec::new();
        let uncertain = self.collect_members(
            entity_id,
            name,
            is_static,
            &mut visited,
            &mut found,
            true,
            true,
        );
        found.sort();
        found.dedup();
        match (found.len(), uncertain) {
            // `found` empty and uncertain (an untracked ancestor might
            // genuinely declare `name`) collapses to the SAME `None` a
            // plain "not found anywhere reachable" already produces -- a
            // caller already treats `None` as "try another resolution path,
            // or stay pending", exactly the right response to "we don't
            // know", never a guess.
            (0, _) => MemberLookup::None,
            // `found` is only ever non-empty when SOME level of the walk
            // matched on ITS OWN `members` list directly, which returns
            // `uncertain: false` immediately (see `collect_members`'s own
            // doc comment) -- so `uncertain` is always `false` whenever
            // `found.len() == 1` in practice; `_` (rather than `false`)
            // here is defensive, not load-bearing: a future edit that ever
            // produced `(1, true)` would still land on the safe `Many` arm
            // below, never a guessed `One`.
            (1, false) => MemberLookup::One(found.into_iter().next().expect("checked len == 1")),
            _ => MemberLookup::Many(found),
        }
    }

    /// P2-2j: the union of every constituent entity's own `members` lookup,
    /// for a union-typed receiver (`a: A | B; a.run()`) -- `entity_ids` are
    /// the union's own distinct constituent entity ids (already deduped by
    /// the caller's `RawTypeRef::Union`/`TypeflowValue::Union`
    /// construction). `MemberLookup::None` (never a guess) as soon as ANY
    /// constituent's own `members` call itself returns `None` -- a union
    /// receiver where even ONE branch lacks the member entirely means the
    /// call could fail at runtime for that branch, so this is not a safe
    /// candidate set (mirrors this crate's own "found or not" discipline
    /// everywhere else). Otherwise every resolved id (from a constituent's
    /// `One` or `Many` outcome) is pooled, sorted, deduped.
    ///
    /// 2026-09-05 A5 references-parity task, Paso 1 fix point 5: a pooled,
    /// deduped set of size 1 IS promoted to `MemberLookup::One` -- proven
    /// safe by construction, not a new heuristic: a `Many` outcome from any
    /// SINGLE constituent always contributes at least two DISTINCT ids to
    /// the pool (`members()`'s own `Many` arm is only reached when its own
    /// `found.len() >= 2` after dedup), and dedup only ever REMOVES
    /// duplicate entries, never merges distinct ones -- so the pooled set
    /// can only ever shrink to exactly 1 when EVERY constituent's own
    /// lookup was independently `One`, AND all of those agree on the exact
    /// same entity id. That is no longer "two different container types
    /// coincidentally sharing a same-named member" (this crate's own
    /// identity scheme never gives two DIFFERENT declarations the same id):
    /// it is every branch of the union agreeing, with certainty, on the
    /// SAME declaration (the common case found live: `A | B` both
    /// inheriting `run` from the same `Base`) -- calling/reading that
    /// member is provably correct regardless of which constituent is the
    /// receiver's actual runtime type, exactly like TypeScript's own
    /// checker would resolve it. A pooled size of 2+ stays `UnionCandidates`
    /// unchanged -- still a genuine, unresolved ambiguity.
    pub fn members_of_union(
        &self,
        entity_ids: &[String],
        name: &str,
        is_static: bool,
    ) -> MemberLookup {
        let mut candidates: Vec<String> = Vec::new();
        for entity_id in entity_ids {
            match self.members(entity_id, name, is_static) {
                MemberLookup::None => return MemberLookup::None,
                MemberLookup::One(target) => candidates.push(target),
                MemberLookup::Many(targets) => candidates.extend(targets),
                // Defensive only -- `members()` (single-entity) never
                // actually produces this variant; only this function does.
                MemberLookup::UnionCandidates(targets) => candidates.extend(targets),
            }
        }
        candidates.sort();
        candidates.dedup();
        match candidates.len() {
            0 => MemberLookup::None,
            1 => MemberLookup::One(candidates.into_iter().next().expect("checked len == 1")),
            _ => MemberLookup::UnionCandidates(candidates),
        }
    }

    /// Walks `entity_id`'s own members, then its `extends` chain, then (only
    /// when both `allow_implements_fallback` and the whole `extends` walk
    /// came back CONFIDENTLY empty) its `implements` chain, collecting every
    /// match into `found`. Returns `true` ("uncertain") when the search
    /// came back with `found` still empty AND at least one container along
    /// the way (including `entity_id` itself) had an `extends` clause this
    /// crate could not resolve -- see `ResolvedContainer::has_unresolved_
    /// extends` and `members`'s own doc comment for why an uncertain-and-
    /// empty result must never fall through to the `implements` fallback,
    /// and why a caller must treat it exactly like "not found" rather than
    /// keep searching. A match found directly on some container's own
    /// members always returns `false` immediately, regardless of any
    /// unresolved ancestor further up -- an own declaration always wins,
    /// with total certainty, over anything it might also inherit.
    #[allow(clippy::too_many_arguments)]
    fn collect_members(
        &self,
        entity_id: &str,
        name: &str,
        is_static: bool,
        visited: &mut std::collections::HashSet<String>,
        found: &mut Vec<String>,
        allow_implements_fallback: bool,
        check_own_members: bool,
    ) -> bool {
        const MAX_DEPTH: usize = 32;
        if visited.len() >= MAX_DEPTH || !visited.insert(entity_id.to_owned()) {
            // A depth-capped or cyclic heritage graph degrades to "nothing
            // found here" exactly like before this task -- not "uncertain"
            // (that would block a SIBLING branch's own implements fallback
            // too, which this specific safety valve has nothing to do
            // with); vanishingly rare in real TS besides.
            return false;
        }
        let Some(container) = self.containers.get(entity_id) else {
            // `entity_id` itself is not a known container (e.g. an external
            // base class from a file this crate never indexed) -- the real
            // member might live here, several hops past what this crate can
            // see. Uncertain, never "not found".
            return true;
        };
        if check_own_members {
            let effective_static = is_static && !container.is_interface;
            for member in &container.members {
                if member.name == name && member.is_static == effective_static {
                    found.push(member.entity_id.clone());
                }
            }
            if !found.is_empty() {
                return false;
            }
        }
        // Item A coverage fix (E-P0l, 2026-09-08): walk every RESOLVED
        // `extends` ancestor BEFORE giving up on an unresolved one --
        // `has_unresolved_extends` is set the instant ANY ONE of this
        // container's own `extends` targets fails to resolve (an interface
        // can `extends` several bases at once; a class's single `extends`
        // is all-or-nothing), even when the member genuinely lives on a
        // DIFFERENT ancestor that DID resolve. `container.extends` (the
        // RESOLVED subset only) is consulted here regardless of that flag
        // -- for a class (never partially resolved: `container.extends` is
        // already empty whenever `has_unresolved_extends` is set) this
        // loop simply does nothing, byte-identical to before; only an
        // interface with a MIX of resolved and unresolved bases sees new
        // behavior, and only when the member is not found on any of the
        // ones that did resolve. `found` on `entity_id` ITSELF already won
        // above unconditionally -- unaffected by this reordering either
        // way (an own declaration must never be shadowed by an unrelated
        // unresolved ancestor's mere existence).
        let mut uncertain = false;
        for base in &container.extends {
            let base_uncertain =
                self.collect_members(base, name, is_static, visited, found, false, true);
            if !found.is_empty() {
                return false;
            }
            uncertain = uncertain || base_uncertain;
        }
        if container.has_unresolved_extends {
            // Some ancestor along this container's OWN extends clause could
            // not be resolved at all, and none of the ones that DID
            // resolve (just walked above) declared `name` either -- the
            // real member might still live on the untracked one. Stop here
            // (an unresolvable `extends` target has no `implements` of its
            // own we could ever reach anyway) and report uncertain rather
            // than fall through to THIS container's own `implements` list.
            DEMOTED_BY_UNRESOLVED_EXTENDS.fetch_add(1, Ordering::Relaxed);
            return true;
        }
        if uncertain {
            // The `extends` chain came back empty but NOT with full
            // confidence -- some ancestor along it was itself unresolved or
            // unindexed. Falling through to `implements` here would use an
            // interface's own method SIGNATURE as a guessed stand-in for
            // whatever the untracked ancestor might really declare -- never
            // sound. Propagate uncertain instead of trying `implements`.
            return true;
        }
        // E-P0k: `allow_implements_fallback` is only ever `true` on the
        // OUTERMOST call (from `members()` itself -- every recursive call
        // above passes `false`), so `entity_id` here is the receiver's OWN
        // container, not some ancestor several hops up. Before using
        // `implements` as a stand-in for "this class's own body never
        // declared `name`", check whether some OTHER known container in
        // this SAME index is a (transitive) `extends` DESCENDANT of
        // `entity_id` that DOES declare its own `name` -- i.e. a concrete
        // subclass overrides the very member the interface only describes
        // the SHAPE of. When one exists, the receiver's REAL runtime type
        // could legitimately be that narrower subclass (this crate does no
        // control-flow narrowing at all -- see `has_known_subclass_
        // override`'s own doc comment for the exact live pattern this
        // closes: `WorkbenchLayoutStateKey implements IWorkbenchLayoutState
        // Key`, with `IWorkbenchLayoutStateKey` declaring `zenModeIgnore`
        // and ONLY the concrete subclass `RuntimeStateKey` (never the
        // abstract base) declaring its own override) -- guessing the
        // interface's own signature in that situation is provably UNSOUND
        // (v3's real checker, honoring control-flow narrowing this crate
        // does not model, picks the subclass's own declaration instead).
        if allow_implements_fallback && self.has_known_subclass_override(entity_id, name, is_static)
        {
            DEMOTED_BY_KNOWN_SUBCLASS_OVERRIDE.fetch_add(1, Ordering::Relaxed);
            return true;
        }
        if allow_implements_fallback {
            for interface in &container.implements {
                let iface_uncertain =
                    self.collect_members(interface, name, false, visited, found, false, true);
                if !found.is_empty() {
                    return false;
                }
                uncertain = uncertain || iface_uncertain;
            }
        }
        uncertain
    }

    /// E-P0k (2026-09-08): is there some OTHER known container in this
    /// index that (a) is a transitive `extends` DESCENDANT of `ancestor_id`
    /// and (b) declares its OWN `name` member (at the given static/instance
    /// disposition)? Used ONLY to decide whether `collect_members`'s
    /// `implements` fallback is safe to use at all -- see that call site's
    /// own doc comment for the exact live pattern this closes
    /// (`WorkbenchLayoutStateKey implements IWorkbenchLayoutStateKey`,
    /// `src/vs/workbench/browser/layout.ts`: the interface declares
    /// `zenModeIgnore`, the abstract base class does not declare its own,
    /// and ONLY the concrete subclass `RuntimeStateKey` does, via a
    /// constructor parameter property). The reverse conformance index is
    /// filtered to `extends` edges here, preserving the strict subclassing
    /// semantics without scanning every container or building a candidate
    /// list that the caller only needs as a boolean.
    fn has_known_subclass_override(&self, ancestor_id: &str, name: &str, is_static: bool) -> bool {
        const MAX_DEPTH: usize = 32;
        let mut best_depth: HashMap<&str, usize> = HashMap::new();
        let mut stack: Vec<(&str, usize)> = self
            .conformance_children
            .get(ancestor_id)
            .into_iter()
            .flatten()
            .filter_map(|child_id| {
                let child = self.containers.get(child_id.as_str())?;
                child
                    .extends
                    .iter()
                    .any(|base_id| base_id == ancestor_id)
                    .then_some((child_id.as_str(), 1))
            })
            .collect();
        while let Some((current_id, depth)) = stack.pop() {
            if depth > MAX_DEPTH
                || best_depth
                    .get(current_id)
                    .is_some_and(|previous_depth| *previous_depth <= depth)
            {
                continue;
            }
            best_depth.insert(current_id, depth);
            let Some(container) = self.containers.get(current_id) else {
                continue;
            };
            let effective_static = is_static && !container.is_interface;
            if container
                .members
                .iter()
                .any(|member| member.name == name && member.is_static == effective_static)
            {
                return true;
            }
            if depth == MAX_DEPTH {
                continue;
            }
            if let Some(children) = self.conformance_children.get(current_id) {
                for child_id in children {
                    let Some(child) = self.containers.get(child_id.as_str()) else {
                        continue;
                    };
                    if child.extends.iter().any(|base_id| base_id == current_id) {
                        stack.push((child_id.as_str(), depth + 1));
                    }
                }
            }
        }
        false
    }

    /// E-P0o (2026-09-08, sibling-declaration ambiguity -- 76% of VS Code's
    /// remaining `different`-target residual, `docs/evidence/2026-09-07-v4-
    /// vscode-campaign.md` §14.7) / E-P0p (2026-09-09, generalized to an
    /// INHERITED match too, §16): every OTHER known container that is a
    /// transitive `extends` DESCENDANT of `entity_id` (never `implements` --
    /// same "real subclassing, not interface conformance" restriction as
    /// `extends_chain_reaches`'s own doc comment) and ALSO declares its OWN
    /// `name` member at the given static/instance disposition -- the exact
    /// relationship `has_known_subclass_override` already tested as a bare
    /// bool (now implemented in terms of this function), generalized to the
    /// full candidate id list.
    ///
    /// Live pattern this closes: `src/vs/editor/browser/editorBrowser.ts`
    /// declares `getModel()` on `IEditor` itself (`ITextModel | null`), AND
    /// on two SIBLING descendants in the SAME file, `ICodeEditor extends
    /// IEditor` (`ITextModel`) and `IDiffEditor extends IEditor`
    /// (`IDiffEditorModel | null`) -- each its own, DIFFERENT redeclaration,
    /// narrowing the base's own signature. `IEditor` DOES declare `getModel`
    /// itself, so `members(IEditor, "getModel", false)` returns a confident-
    /// looking `One(IEditor::getModel)` (`collect_members`'s own-members
    /// loop matches immediately, before ever walking `extends`) -- but v3's
    /// real per-call-site, receiver-type-based resolution answers with
    /// `ICodeEditor`'s own narrower declaration at every sampled importer,
    /// never `IEditor`'s. This crate has no receiver-type-narrowing of its
    /// own (see this crate's own module doc, "deliberately narrow"), so it
    /// cannot KNOW which of the three declarations is real at any given call
    /// site -- guessing `IEditor`'s own declaration merely because it is the
    /// entity `type_of_expression` happened to resolve is the exact class of
    /// unsound guess this crate's "never guess" discipline forbids elsewhere
    /// (`has_known_subclass_override`'s own doc comment, `members_of_union`'s
    /// own doc comment, ...). This function surfaces the full candidate set
    /// so the caller (which alone knows whether the receiver's OWN typing
    /// `rule` already pins it to `entity_id` specifically -- an explicit
    /// annotation, `this`, an active narrowing, ... -- see `semantic_sites.
    /// rs`'s `rule_pins_receiver_uniquely`) can decide confirmed vs.
    /// ambiguous.
    ///
    /// **E-P0o originally gated the caller on a SEPARATE `own_member_ids`
    /// check** (`entity_id` must declare `name` DIRECTLY, never merely
    /// inherit it) before ever consulting this function at all -- an
    /// INHERITED match (`ICodeEditor` inherits `getModel` from `IEditor`;
    /// `IActiveCodeEditor extends ICodeEditor` redeclares it) was left
    /// CONFIRMED to the ancestor's own declaration, unconditionally,
    /// because an early, cruder attempt at removing that gate broke the
    /// `instanceof_narrowing_never_applies_to_a_calls_own_target_
    /// resolution` regression guard (`docs/evidence/2026-09-07-v4-vscode-
    /// campaign.md` §15.2). **E-P0p (2026-09-09) removed that gate**: this
    /// function already only ever returns DESCENDANTS of `entity_id`
    /// regardless of whether `entity_id` declares `name` directly or
    /// inherits it, so the ONLY gate the caller needs is `rule_pins_
    /// receiver_uniquely(rule)` -- re-examining the regression guard
    /// directly showed its own receiver (`activePane: EditorPane`) is typed
    /// through `"member_declared_type"`, already reliable EITHER way (own
    /// or inherited), so dropping the separate gate never affects it. The
    /// live `ICodeEditor`/`IActiveCodeEditor` counter-example is now caught
    /// by this SAME call, unconditionally -- and, when reached through a
    /// `hasModel(): this is IActiveCodeEditor` user-defined type-predicate
    /// guard, correctly stays CONFIRMED instead (never even reaching this
    /// candidate path) via the new `"type_predicate_narrowed"` rule --
    /// `PredicateSubject`/`member_predicate_receiver_narrowing`'s own doc
    /// comments, `docs/evidence/2026-09-07-v4-vscode-campaign.md` §16.
    ///
    /// This list-producing compatibility helper retains its complete result
    /// contract; the hot boolean predicate above uses the reverse index and
    /// does not call this global scan. `None` (an empty vec, never a guess)
    /// when no such sibling exists is the ordinary case.
    pub fn sibling_extends_overrides(
        &self,
        entity_id: &str,
        name: &str,
        is_static: bool,
    ) -> Vec<String> {
        let mut ids = Vec::new();
        for (other_id, other_container) in &self.containers {
            if other_id == entity_id {
                continue;
            }
            if !self.extends_chain_reaches(other_id, entity_id) {
                continue;
            }
            let effective_static = is_static && !other_container.is_interface;
            for member in &other_container.members {
                if member.name == name && member.is_static == effective_static {
                    ids.push(member.entity_id.clone());
                }
            }
        }
        ids.sort();
        ids.dedup();
        ids
    }

    /// E-P0q (2026-09-09, `docs/evidence/2026-09-07-v4-vscode-campaign.md`
    /// §16.4 pattern 1, the DOMINANT VS Code residual E-P0o/E-P0p
    /// deliberately left unfixed): the SAME sibling-declaration-ambiguity
    /// relationship `sibling_extends_overrides` proves for real subclassing,
    /// generalized to `implements` conformance too -- every OTHER known
    /// container reachable from `entity_id` through ANY combination of
    /// `extends`/`implements` edges (never
    /// `sibling_extends_overrides`'s own `extends`-only
    /// `extends_chain_reaches`) that ALSO declares its OWN `name` member at
    /// the given static/instance disposition. Live pattern this closes:
    /// `IAction` (`src/vs/base/common/actions.ts`) declares `run`/`id`/...
    /// itself; `Action` (`implements IAction`, never `extends` it) declares
    /// its own overriding bodies for the same names -- a receiver typed
    /// `IAction` with no reliable pinning rule cannot tell which of the two
    /// v3's real per-call-site resolution would pick.
    ///
    /// **This is a STRICT SUPERSET of `sibling_extends_overrides`'s own
    /// result** (this traversal walks every edge
    /// `sibling_extends_overrides` can reach, plus `implements` ones) --
    /// callers use THIS function instead of, never in addition to, the
    /// `extends`-only one. `sibling_extends_overrides` itself stays UNCHANGED
    /// and is still used by `has_known_subclass_override` (a DIFFERENT check,
    /// about
    /// whether `collect_members`'s own `implements` FALLBACK is safe to use
    /// at all -- deliberately `extends`-only, see that function's own doc
    /// comment; broadening it here would be a scope change to a check this
    /// task does not touch).
    ///
    /// **Decision 28's own cost-bounded, never-guess discipline applies
    /// here differently than it does for `sibling_extends_overrides`**: an
    /// `extends` sibling set is bounded by real subclass depth in practice,
    /// but an `implements` conformance set is bounded only by how many
    /// classes happen to implement a common, widely-used interface --
    /// `IAction`-shaped interfaces in a codebase this size can have dozens
    /// of implementers, an effectively unbounded candidate list with no way
    /// to bound false ambiguity by enumerating all of them (`docs/
    /// evidence/2026-09-07-v4-vscode-campaign.md` §16.4's own disposition
    /// for pattern 1). This function itself does NOT cap its own result --
    /// it always returns the FULL candidate set (correctness over hiding the
    /// true count) -- callers (`resolve_static_member_reference`/`resolve_
    /// call_target_typeflow`) are the ones that compare the result's length
    /// against `MAX_CANDIDATE_TARGETS` and demote to a NO-LIST pending site
    /// (`REASON_SIBLING_CONFORMANCE_UNBOUNDED`) instead of a `possible` row
    /// per candidate whenever the set is too large to list -- see that
    /// constant's own doc comment.
    ///
    /// Walks the direct reverse conformance index from `entity_id` instead of
    /// scanning every known container and checking each one's ancestry. The
    /// traversal remains depth-capped and cycle-guarded. `MAX_DEPTH` is a
    /// per-path heritage-edge depth from the queried entity (so depth 32 is
    /// included, even when another path reached the same node more deeply),
    /// rather than a global visited-node budget. The full result is still
    /// sorted/deduplicated because callers use the complete set to preserve
    /// the candidate/dependency contract.
    pub fn sibling_conformance_overrides(
        &self,
        entity_id: &str,
        name: &str,
        is_static: bool,
    ) -> Vec<String> {
        let mut ids = Vec::new();
        const MAX_DEPTH: usize = 32;
        // Retain the shallowest visit seen for each node. A plain visited
        // set can miss valid descendants when a diamond reaches the same
        // node through a depth-32 path before a shorter path is processed.
        let mut best_depth: HashMap<&str, usize> = HashMap::new();
        let mut stack: Vec<(&str, usize)> = self
            .conformance_children
            .get(entity_id)
            .into_iter()
            .flatten()
            .map(|child_id| (child_id.as_str(), 1))
            .collect();
        while let Some((other_id, depth)) = stack.pop() {
            // The root's direct child is depth 1, so a descendant at exactly
            // `MAX_DEPTH` remains part of the bounded walk.
            if depth > MAX_DEPTH
                || best_depth
                    .get(other_id)
                    .is_some_and(|previous_depth| *previous_depth <= depth)
            {
                continue;
            }
            best_depth.insert(other_id, depth);
            if other_id == entity_id {
                continue;
            }
            let Some(other_container) = self.containers.get(other_id) else {
                continue;
            };
            let effective_static = is_static && !other_container.is_interface;
            for member in &other_container.members {
                if member.name == name && member.is_static == effective_static {
                    ids.push(member.entity_id.clone());
                }
            }
            if depth < MAX_DEPTH
                && let Some(children) = self.conformance_children.get(other_id)
            {
                stack.extend(
                    children
                        .iter()
                        .map(|child_id| (child_id.as_str(), depth + 1)),
                );
            }
        }
        ids.sort();
        ids.dedup();
        ids
    }

    /// Whether walking `start_id`'s own `extends` chain (never `implements`
    /// -- this is specifically about CLASS subclassing, the relationship
    /// `super`/an overriding declaration follows, not interface
    /// conformance) reaches `target_id`, at any depth. Depth-capped and
    /// cycle-guarded exactly like `collect_members`'s own ancestor walk (a
    /// malformed/cyclic heritage graph degrades to `false`, never a hang).
    fn extends_chain_reaches(&self, start_id: &str, target_id: &str) -> bool {
        const MAX_DEPTH: usize = 32;
        let mut visited = std::collections::HashSet::new();
        let mut stack = vec![start_id.to_owned()];
        while let Some(current) = stack.pop() {
            if visited.len() >= MAX_DEPTH || !visited.insert(current.clone()) {
                continue;
            }
            let Some(container) = self.containers.get(&current) else {
                continue;
            };
            for base in &container.extends {
                if base == target_id {
                    return true;
                }
                stack.push(base.clone());
            }
        }
        false
    }

    /// P1-A: the declared TYPE of member `name` on `entity_id` (at the given
    /// static/instance disposition) -- a property's own annotation, or a
    /// method's own declared return type -- for fluent-chain propagation
    /// (`a.b().c()`: resolve `b`'s return type here, then look up `c` on
    /// THAT type). Walks the same own-members-then-`extends`-then-
    /// `implements` order as `members` (see its doc comment), and returns
    /// `None` whenever `members` itself would have returned `None` or
    /// `Many` at that same span -- an ambiguous/union member is never
    /// guessed at here either.
    pub fn member_type_ref(
        &self,
        entity_id: &str,
        name: &str,
        is_static: bool,
    ) -> Option<ResolvedTypeRef> {
        lookup_member_type_ref(&self.containers, entity_id, name, is_static)
    }

    /// E-P0p (2026-09-09): when member `name` on `entity_id` (walking the
    /// SAME own-then-`extends`-then-`implements` order `member_type_ref`
    /// itself uses) is a method/function whose own declared return type is
    /// a `this is T` user-defined type-predicate AND `T` resolved to a
    /// single known entity, `Some(entity_id_of_T)` -- the receiver's
    /// narrowed type once a call through this member proves true (`if (x.
    /// <name>())`). `None` for every other shape: no member found, an
    /// ambiguous/union member, a plain (non-predicate) return type, a
    /// `param is T` predicate (`PredicateSubject::Parameter` -- represented
    /// in the index but not yet consulted by any resolver, see `RawTypeRef
    /// ::TypePredicate`'s own doc comment for the scope decision), or a
    /// predicate whose own asserted type did not resolve to a plain entity
    /// (an `ArrayOf`/`Union`/... -- never a guess at which constituent).
    pub fn member_predicate_receiver_narrowing(
        &self,
        entity_id: &str,
        name: &str,
        is_static: bool,
    ) -> Option<String> {
        let ResolvedTypeRef::TypePredicate { subject, target } =
            self.member_type_ref(entity_id, name, is_static)?
        else {
            return None;
        };
        if !matches!(subject, PredicateSubject::Receiver) {
            return None;
        }
        match *target {
            ResolvedTypeRef::Entity(id) => Some(id),
            _ => None,
        }
    }

    /// E-P0q (2026-09-09): the SAME narrowing `member_predicate_receiver_
    /// narrowing` proves for a member's own `this is T`, for a STANDALONE
    /// top-level function's own `param is T` predicate (`PredicateSubject::
    /// Parameter`) -- closes decision 28's residual pattern 3 (`docs/
    /// evidence/2026-09-07-v4-vscode-campaign.md` §16.4: a bare `isFoo(x)`
    /// call, not a member call). `Some((position, entity_id_of_T))` only
    /// when `entity_id` is a known top-level function whose own declared
    /// return type is a `param is T` predicate AND `summarize_function`
    /// confidently located the named parameter's own zero-based POSITION at
    /// declaration time (`PredicateSubject::Parameter`'s own doc comment --
    /// `None` there means a destructured/rest parameter, or a shape this
    /// index does not thread position through for, and this function
    /// refuses to narrow rather than guess). `position` lets the caller pick
    /// out the matching ARGUMENT expression at a specific call site
    /// (`call.arguments[position]`) -- this index itself has no notion of
    /// call sites.
    pub fn function_predicate_parameter_narrowing(
        &self,
        entity_id: &str,
    ) -> Option<(usize, String)> {
        let ResolvedTypeRef::TypePredicate { subject, target } =
            self.function_return_type(entity_id)?
        else {
            return None;
        };
        let PredicateSubject::Parameter {
            position: Some(position),
            ..
        } = subject
        else {
            return None;
        };
        match *target {
            ResolvedTypeRef::Entity(id) => Some((position, id)),
            _ => None,
        }
    }

    /// E-P0m (2026-09-08, rule (b) closure for pattern G's `_fetch`/
    /// `_createMessageRequestHandler`/`_elicitationRequestHandler`
    /// residual, `docs/evidence/2026-09-07-v4-vscode-campaign.md` §13):
    /// `true` when `member_type_ref` above would return `None` for THIS
    /// EXACT `(entity_id, name, is_static)` NOT because the member has no
    /// type annotation at all, but because it has a REAL one (a type alias,
    /// an indexed-access, an imported type reference, ...) that failed to
    /// resolve -- see `ResolvedMember::had_named_type_reference`'s own doc
    /// comment for the two live samples this closes. A caller (`resolve_
    /// call_target_typeflow`'s member branch) uses this to refuse a naive
    /// name-based call-target confirmation whenever the member's OWN
    /// declared type is a known unknown, never just an absent one -- the
    /// conservative, "stay pending" side of "never guess": widens the
    /// EXISTING `TypeQuery`-only redirect/downgrade check to also cover a
    /// same-shaped case that never made it as far as `TypeQuery` at all
    /// (an unresolved import upstream of it), without touching resolver.rs'
    /// own import-resolution machinery (see that file's own doc comment,
    /// right above `push_candidate_variants`, for why a broader fix there
    /// was attempted and reverted this same session).
    pub fn member_annotation_is_unresolved(
        &self,
        entity_id: &str,
        name: &str,
        is_static: bool,
    ) -> bool {
        let mut visited = std::collections::HashSet::new();
        collect_member_annotation_unresolved(
            &self.containers,
            entity_id,
            name,
            is_static,
            &mut visited,
            true,
        )
    }

    /// P1-A (rule (a)): a top-level named function's own declared return
    /// type, already resolved through the same import table as everything
    /// else in this index. `None` when `entity_id` is not a known function,
    /// or its return type is unannotated/unresolved.
    pub fn function_return_type(&self, entity_id: &str) -> Option<ResolvedTypeRef> {
        self.function_return_types.get(entity_id).cloned()
    }

    /// P1-A: an explicitly-annotated top-level variable's own declared
    /// type -- see `VariableSummary`'s doc comment. `None` for a variable
    /// this crate never captured a `VariableSummary` for (unannotated, not
    /// top-level, or the annotation's shape was not one `raw_type_ref_of_
    /// ts_type` classifies).
    pub fn variable_declared_type(&self, entity_id: &str) -> Option<ResolvedTypeRef> {
        self.variable_types.get(entity_id).cloned()
    }
}

/// D.2 (2026-09-05, references-parity task): the maximum number of alias
/// hops `build_alias_targets`/`resolve_type_ref_chasing_aliases` will
/// follow (`type A = B; type B = C; ...`) before giving up -- a genuine
/// cycle (`type A = B; type B = A`) never converges regardless of the cap
/// and is caught earlier anyway by the `visiting` guard; this cap only
/// bounds a pathologically long (but acyclic) real alias chain, never a
/// guess either way.
const MAX_ALIAS_DEPTH: u8 = 8;

/// D.2: close every top-level `type X = ...` declaration's own RHS against
/// `import_targets`, chasing through any number of hops where the RHS
/// itself names ANOTHER type alias (`type A = B` where `B` is itself a
/// `type` declaration) -- built ONCE, up front, before `insert_file_pass1`
/// ever runs (pass 1 needs the FINAL, fully-chased map to de-alias a
/// member/function/variable annotation's own `RawTypeRef::Local`/`Imported`
/// leaf that happens to name an alias rather than a real class/interface/
/// type-literal -- see `resolve_raw_type_ref`'s own doc comment for that
/// consuming side). A cycle, or a chain longer than `MAX_ALIAS_DEPTH`,
/// simply has no entry in the returned map -- its consumers see the
/// UNCHANGED `RawTypeRef::Local(alias_id)` fall through `resolve_raw_type_
/// ref`'s own fallback (treated as an ordinary, if unresolvable-further,
/// entity id) -- never a guess.
fn build_alias_targets(
    summaries: &BTreeMap<String, DeclSummary>,
    import_targets: &HashMap<(String, String, String), String>,
    telemetry_enabled: bool,
) -> (HashMap<String, Option<ResolvedTypeRef>>, TypeflowTelemetry) {
    let started = telemetry_enabled.then(Instant::now);
    let mut raw_by_id: HashMap<String, (String, RawTypeRef)> = HashMap::new();
    for summary in summaries.values() {
        for alias in &summary.type_aliases {
            raw_by_id.insert(
                alias.id.clone(),
                (summary.path.clone(), alias.target.clone()),
            );
        }
    }
    // Every KNOWN alias id gets an entry, `None` when it never converged (a
    // cycle, or a chain longer than `MAX_ALIAS_DEPTH`) -- see `dealias_
    // entity`/`dealias_heritage_id`'s own doc comments for why a key's
    // MERE PRESENCE (not just its value) is load-bearing: it is what tells
    // those two functions "this id IS a known alias" apart from "this id
    // is an ordinary class/interface/type-literal `alias_targets` never
    // heard of" -- a value-only map (inserting only on success) cannot
    // express that distinction, so a cyclic alias's own id would otherwise
    // silently fall through as if it were a real, final container id.
    let mut resolved = HashMap::new();
    for (id, (owning_path, raw)) in &raw_by_id {
        let mut visiting = HashSet::new();
        visiting.insert(id.clone());
        let value = resolve_type_ref_chasing_aliases(
            raw,
            owning_path,
            import_targets,
            &raw_by_id,
            &mut visiting,
            0,
        );
        resolved.insert(id.clone(), value);
    }
    let telemetry = TypeflowTelemetry {
        alias_chasing_count: u64::try_from(raw_by_id.len()).unwrap_or(u64::MAX),
        alias_chasing_us: started
            .map(|started| u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX))
            .unwrap_or_default(),
    };
    (resolved, telemetry)
}

/// D.2: structurally the SAME wrapper recursion `resolve_raw_type_ref`
/// itself does (`ArrayOf`/`PromiseOf`/`RecordOf`/`Union` recurse, `ThisType`
/// passes through, `ReturnTypeOfFn`/`IndexedAccess`/`Unknown` give up) --
/// the ONLY difference is the `Local`/`Imported` LEAF (`resolve_alias_
/// chase_leaf`): where `resolve_raw_type_ref` treats a resolved id as
/// final the instant it is found, this one recurses ONE MORE HOP whenever
/// that id is ITSELF a known alias (`raw_by_id` has it) -- exactly what
/// `build_alias_targets`'s own fixed, per-id `resolved` map cannot express
/// while it is still being built (a partially-built map cannot tell "not
/// an alias" from "an alias not resolved YET" apart, which is why this
/// function threads `raw_by_id` -- the full set of KNOWN alias ids -- and
/// a live `visiting`/`depth` pair instead of a flat lookup map).
#[allow(clippy::too_many_arguments)]
fn resolve_type_ref_chasing_aliases(
    raw: &RawTypeRef,
    owning_path: &str,
    import_targets: &HashMap<(String, String, String), String>,
    raw_by_id: &HashMap<String, (String, RawTypeRef)>,
    visiting: &mut HashSet<String>,
    depth: u8,
) -> Option<ResolvedTypeRef> {
    match raw {
        RawTypeRef::Local(entity_id) => {
            resolve_alias_chase_leaf(entity_id, import_targets, raw_by_id, visiting, depth)
        }
        RawTypeRef::Imported {
            specifier,
            imported_name,
        } => {
            let target_id = import_targets.get(&(
                owning_path.to_owned(),
                specifier.clone(),
                imported_name.clone().unwrap_or_default(),
            ))?;
            resolve_alias_chase_leaf(target_id, import_targets, raw_by_id, visiting, depth)
        }
        RawTypeRef::ThisType => Some(ResolvedTypeRef::ThisType),
        RawTypeRef::ArrayOf(inner) => resolve_type_ref_chasing_aliases(
            inner,
            owning_path,
            import_targets,
            raw_by_id,
            visiting,
            depth,
        )
        .map(|resolved| ResolvedTypeRef::ArrayOf(Box::new(resolved))),
        RawTypeRef::PromiseOf(inner) => resolve_type_ref_chasing_aliases(
            inner,
            owning_path,
            import_targets,
            raw_by_id,
            visiting,
            depth,
        )
        .map(|resolved| ResolvedTypeRef::PromiseOf(Box::new(resolved))),
        RawTypeRef::RecordOf(inner) => resolve_type_ref_chasing_aliases(
            inner,
            owning_path,
            import_targets,
            raw_by_id,
            visiting,
            depth,
        )
        .map(|resolved| ResolvedTypeRef::RecordOf(Box::new(resolved))),
        RawTypeRef::Union(items) => items
            .iter()
            .map(|item| {
                resolve_type_ref_chasing_aliases(
                    item,
                    owning_path,
                    import_targets,
                    raw_by_id,
                    visiting,
                    depth,
                )
            })
            .collect::<Option<Vec<_>>>()
            .map(ResolvedTypeRef::Union),
        // G (E-P0l): NOT the same precedent as `ReturnTypeOfFn`/
        // `IndexedAccess` right below -- those two genuinely need
        // `ProgramIndex::build`'s LATER fourth pass (a second index lookup
        // this alias-chasing pass does not have access to yet), but a
        // `TypeQuery` resolves FULLY in one step, exactly like `Local`/
        // `Imported` above -- see `resolve_raw_type_ref`'s own `TypeQuery`
        // arm doc comment. Found live: `type FetchFn = typeof globalThis.
        // fetch;` used as a constructor-parameter-property's own type
        // annotation (`_fetchFn: FetchFn = globalThis.fetch`) -- treating
        // this arm like `ReturnTypeOfFn` (silently `None`) made `FetchFn`
        // (a KNOWN alias) "never converge" as far as `dealias_entity`
        // could tell, discarding the type-query fact entirely and letting
        // the naive member-name resolution fall through to `_fetchFn`'s
        // own declaration instead of staying pending.
        RawTypeRef::TypeQuery(entity_ref) => {
            Some(ResolvedTypeRef::TypeQuery(entity_ref.as_ref().and_then(
                |entity_ref| resolve_type_query_entity_ref(entity_ref, owning_path, import_targets),
            )))
        }
        RawTypeRef::ReturnTypeOfFn(_) | RawTypeRef::IndexedAccess { .. } => None,
        // E-P0p (2026-09-09): mirrors `ArrayOf`/`PromiseOf`/`RecordOf`
        // above -- a predicate's own target chasing through a type alias
        // (`type T = SomeAlias; ...): this is T`) resolves the SAME way.
        RawTypeRef::TypePredicate { subject, target } => resolve_type_ref_chasing_aliases(
            target,
            owning_path,
            import_targets,
            raw_by_id,
            visiting,
            depth,
        )
        .map(|resolved| ResolvedTypeRef::TypePredicate {
            subject: subject.clone(),
            target: Box::new(resolved),
        }),
        RawTypeRef::Unknown => None,
    }
}

/// D.2: `id` is not a known alias -- a real class/interface/type-literal
/// (or a still-`Unknown` id `raw_by_id` never heard of, e.g. an unresolved
/// import) -- so it IS the final answer, `Some(Entity(id))`. `id` IS a
/// known alias: recurse into ITS OWN raw target one more hop, guarded by
/// `visiting` (a repeat id anywhere on the CURRENT chain is a cycle,
/// `None`, matching `resolve_named_export_inner`'s own `visiting`-set
/// idiom in `urdira-jsts-syntax-worker::resolver`) and `depth` (capped at
/// `MAX_ALIAS_DEPTH`).
///
/// D.5 (2026-09-05, adversarial review): `visiting.remove(id)` AFTER the
/// recursive call returns -- found live: without it, `visiting` tracked
/// "ever visited anywhere in this call tree" instead of "on the current
/// path", so an ACYCLIC diamond (`type A = X | Y; type X = B; type Y = B;
/// type B = Foo;`) broke: resolving `A`'s `Union([X, Y])` chases `X` first
/// (`X` -> `B` -> `Foo`, leaving `B` stuck in `visiting` on return since it
/// was never removed), then chases `Y` -> `B` using the SAME `visiting`
/// set -- `B` looks already-visited (a false cycle from the SIBLING `X`
/// branch, not an ancestor of `Y`) and `Y` wrongly resolves to `None`,
/// failing the whole union. Removing `id` on return restores the correct
/// "on this path only" DFS cycle-guard semantics: a GENUINE cycle (`type A
/// = B; type B = A;`) still returns `None` for both (`A` is still in
/// `visiting`, inserted by `build_alias_targets`'s own per-id call, when
/// the recursion loops back to it -- untouched by this fix), while two
/// INDEPENDENT branches sharing a common alias no longer collide.
fn resolve_alias_chase_leaf(
    id: &str,
    import_targets: &HashMap<(String, String, String), String>,
    raw_by_id: &HashMap<String, (String, RawTypeRef)>,
    visiting: &mut HashSet<String>,
    depth: u8,
) -> Option<ResolvedTypeRef> {
    let Some((alias_owning_path, alias_raw)) = raw_by_id.get(id) else {
        return Some(ResolvedTypeRef::Entity(id.to_owned()));
    };
    if depth + 1 >= MAX_ALIAS_DEPTH || !visiting.insert(id.to_owned()) {
        return None;
    }
    let resolved = resolve_type_ref_chasing_aliases(
        alias_raw,
        alias_owning_path,
        import_targets,
        raw_by_id,
        visiting,
        depth + 1,
    );
    visiting.remove(id);
    resolved
}

/// P1-A: close a `RawTypeRef`'s `Local`/`Imported` leaves against
/// `import_targets` the same way `resolve_heritage_target` does for a
/// heritage clause -- `ThisType` passes through untouched (resolved later,
/// relative to a receiver, by the caller), `ArrayOf`/`PromiseOf` recurse and
/// only produce a wrapped result when their inner type resolved, and
/// `Unknown`/an unresolved `Imported` reference both produce `None` --
/// never a guess.
///
/// D.2 (2026-09-05, references-parity task): a `Local`/`Imported` leaf that
/// resolves to a KNOWN type-alias id is substituted with `alias_targets`'
/// own (already fully hop-chased, cycle-guarded -- see `build_alias_
/// targets`'s doc comment) resolution for it, so a member/function/
/// variable annotated with an alias sees exactly what the alias ultimately
/// means, never the alias's own (uninformative to every caller here)
/// entity id. `alias_targets` is ALWAYS the complete, already-converged map
/// by the time this runs (built once, before `insert_file_pass1`) -- an id
/// missing from it is definitively "not an alias" here, unlike inside
/// `build_alias_targets`'s own still-converging computation (see
/// `resolve_alias_chase_leaf`'s doc comment for why that one cannot reuse
/// this same flat-lookup shortcut).
fn resolve_raw_type_ref(
    raw: &RawTypeRef,
    owning_path: &str,
    import_targets: &HashMap<(String, String, String), String>,
    alias_targets: &HashMap<String, Option<ResolvedTypeRef>>,
) -> Option<ResolvedTypeRef> {
    match raw {
        RawTypeRef::Local(entity_id) => dealias_entity(entity_id, alias_targets),
        RawTypeRef::Imported {
            specifier,
            imported_name,
        } => import_targets
            .get(&(
                owning_path.to_owned(),
                specifier.clone(),
                imported_name.clone().unwrap_or_default(),
            ))
            .and_then(|target_id| dealias_entity(target_id, alias_targets)),
        RawTypeRef::ThisType => Some(ResolvedTypeRef::ThisType),
        RawTypeRef::ArrayOf(inner) => {
            resolve_raw_type_ref(inner, owning_path, import_targets, alias_targets)
                .map(|resolved| ResolvedTypeRef::ArrayOf(Box::new(resolved)))
        }
        RawTypeRef::PromiseOf(inner) => {
            resolve_raw_type_ref(inner, owning_path, import_targets, alias_targets)
                .map(|resolved| ResolvedTypeRef::PromiseOf(Box::new(resolved)))
        }
        RawTypeRef::RecordOf(inner) => {
            resolve_raw_type_ref(inner, owning_path, import_targets, alias_targets)
                .map(|resolved| ResolvedTypeRef::RecordOf(Box::new(resolved)))
        }
        // P2-2j: resolve every constituent or none at all -- see
        // `ResolvedTypeRef::Union`'s doc comment.
        RawTypeRef::Union(items) => items
            .iter()
            .map(|item| resolve_raw_type_ref(item, owning_path, import_targets, alias_targets))
            .collect::<Option<Vec<_>>>()
            .map(ResolvedTypeRef::Union),
        // P1-C: needs `ProgramIndex::build`'s later, fourth pass instead --
        // see `resolve_raw_type_ref_deferred`'s doc comment.
        RawTypeRef::ReturnTypeOfFn(_) | RawTypeRef::IndexedAccess { .. } => None,
        // G (E-P0l): resolves fully in THIS pass -- unlike `ReturnTypeOfFn`,
        // it needs no later fixed point (it names `<expr>` itself, never
        // `<expr>`'s inferred return type, so `function_return_types`
        // being incomplete this early is irrelevant here).
        RawTypeRef::TypeQuery(entity_ref) => {
            Some(ResolvedTypeRef::TypeQuery(entity_ref.as_ref().and_then(
                |entity_ref| resolve_type_query_entity_ref(entity_ref, owning_path, import_targets),
            )))
        }
        // E-P0p (2026-09-09): resolves fully in THIS pass -- the predicate
        // target is a plain declared type, exactly like `ArrayOf`/
        // `PromiseOf`'s own inner leaf (never a `ReturnTypeOfFn`/
        // `IndexedAccess` special case of its own).
        RawTypeRef::TypePredicate { subject, target } => Some(ResolvedTypeRef::TypePredicate {
            subject: subject.clone(),
            target: Box::new(resolve_raw_type_ref(
                target,
                owning_path,
                import_targets,
                alias_targets,
            )?),
        }),
        RawTypeRef::Unknown => None,
    }
}

/// G (E-P0l, 2026-09-08): close a `RawTypeRef::TypeQuery`'s own inner
/// `ReturnEntityRef` against `import_targets` -- mirrors `RawTypeRef::
/// Imported`'s own leaf resolution exactly, EXCEPT there is no de-aliasing
/// step (`dealias_entity`): a type query's target is the referenced
/// declaration itself, never something `type Alias = ...` could stand in
/// for.
fn resolve_type_query_entity_ref(
    entity_ref: &ReturnEntityRef,
    owning_path: &str,
    import_targets: &HashMap<(String, String, String), String>,
) -> Option<String> {
    match entity_ref {
        ReturnEntityRef::Local(id) => Some(id.clone()),
        ReturnEntityRef::Imported {
            specifier,
            imported_name,
        } => import_targets
            .get(&(
                owning_path.to_owned(),
                specifier.clone(),
                imported_name.clone().unwrap_or_default(),
            ))
            .cloned(),
    }
}

/// D.2: `entity_id` as `alias_targets` itself would want any consumer to
/// see it -- its own de-aliased resolution when it names a KNOWN alias,
/// the plain `Entity(entity_id)` otherwise (a real class/interface/type-
/// literal, or an id `alias_targets` never heard of e.g. one that was part
/// of an unconverged cycle -- both indistinguishable here, and both
/// correctly fall back to treating `entity_id` as a real, final answer).
fn dealias_entity(
    entity_id: &str,
    alias_targets: &HashMap<String, Option<ResolvedTypeRef>>,
) -> Option<ResolvedTypeRef> {
    match alias_targets.get(entity_id) {
        Some(Some(value)) => Some(value.clone()),
        // A KNOWN alias id that never converged (cycle/too-deep chain) --
        // `None` here, never the (wrong) fallback of treating the alias's
        // OWN id as if it were a real, final container.
        Some(None) => None,
        // Not a known alias at all -- a real class/interface/type-literal
        // id, unchanged.
        None => Some(ResolvedTypeRef::Entity(entity_id.to_owned())),
    }
}

/// P1-C: whether `raw` contains a `ReturnTypeOfFn`/`IndexedAccess` leaf
/// anywhere (through any number of `ArrayOf`/`PromiseOf`/`RecordOf`
/// wrappers) -- these two need `ProgramIndex::build`'s LATER fourth pass
/// (see `resolve_raw_type_ref_deferred`'s doc comment) rather than the
/// single up-front `resolve_raw_type_ref` pass every other leaf uses;
/// this predicate is how `ProgramIndex::build` decides which members/
/// variables/functions to queue for that pass.
fn contains_deferred(raw: &RawTypeRef) -> bool {
    match raw {
        RawTypeRef::ReturnTypeOfFn(_) | RawTypeRef::IndexedAccess { .. } => true,
        RawTypeRef::ArrayOf(inner) | RawTypeRef::PromiseOf(inner) | RawTypeRef::RecordOf(inner) => {
            contains_deferred(inner)
        }
        // P2-2j: a union needs the later pass if ANY constituent does.
        RawTypeRef::Union(items) => items.iter().any(contains_deferred),
        // E-P0p (2026-09-09): needs the later pass exactly when its own
        // predicate target does -- mirrors `ArrayOf`/`PromiseOf`/`RecordOf`.
        RawTypeRef::TypePredicate { target, .. } => contains_deferred(target),
        // G (E-P0l): resolves fully in the first pass (`resolve_raw_type_
        // ref`) -- see that function's own `TypeQuery` arm doc comment.
        RawTypeRef::Local(_)
        | RawTypeRef::Imported { .. }
        | RawTypeRef::ThisType
        | RawTypeRef::TypeQuery(_) => false,
        RawTypeRef::Unknown => false,
    }
}

/// P1-C: `resolve_raw_type_ref`'s counterpart for `ProgramIndex::build`'s
/// fourth pass -- the SAME leaf resolution, plus `ReturnTypeOfFn` (closes
/// `entity_ref` against `import_targets` exactly like `RawTypeRef::
/// Imported` does, then looks the resulting function entity id up in
/// `function_return_types`, which by this pass is as complete as the P1-B
/// fixed point (pass three) ever makes it -- including every shallow-
/// inferred, unannotated function) and `IndexedAccess` (resolves `base`
/// recursively THROUGH THIS SAME FUNCTION -- so a chain like `ReturnType<
/// typeof f>["prop"]` closes in one call -- then looks `key` up on the
/// resulting entity via `lookup_member_type_ref`, the exact same walk
/// `member_type_ref` uses). Both leaves fall back to `None` (kept pending,
/// retried on a later fixed-point round -- see `ProgramIndex::build`'s own
/// doc comment for that pass) rather than a guess when the dependency
/// they need is not resolved YET, indistinguishable here from "never will
/// be" -- exactly the same tradeoff `PreparedReturnShape`'s own `Pending`
/// makes, bounded by the same kind of iteration cap.
fn resolve_raw_type_ref_deferred(
    raw: &RawTypeRef,
    owning_path: &str,
    import_targets: &HashMap<(String, String, String), String>,
    containers: &HashMap<String, ResolvedContainer>,
    function_return_types: &HashMap<String, ResolvedTypeRef>,
) -> Option<ResolvedTypeRef> {
    match raw {
        RawTypeRef::Local(entity_id) => Some(ResolvedTypeRef::Entity(entity_id.clone())),
        RawTypeRef::Imported {
            specifier,
            imported_name,
        } => import_targets
            .get(&(
                owning_path.to_owned(),
                specifier.clone(),
                imported_name.clone().unwrap_or_default(),
            ))
            .cloned()
            .map(ResolvedTypeRef::Entity),
        RawTypeRef::ThisType => Some(ResolvedTypeRef::ThisType),
        RawTypeRef::ArrayOf(inner) => resolve_raw_type_ref_deferred(
            inner,
            owning_path,
            import_targets,
            containers,
            function_return_types,
        )
        .map(|resolved| ResolvedTypeRef::ArrayOf(Box::new(resolved))),
        RawTypeRef::PromiseOf(inner) => resolve_raw_type_ref_deferred(
            inner,
            owning_path,
            import_targets,
            containers,
            function_return_types,
        )
        .map(|resolved| ResolvedTypeRef::PromiseOf(Box::new(resolved))),
        RawTypeRef::RecordOf(inner) => resolve_raw_type_ref_deferred(
            inner,
            owning_path,
            import_targets,
            containers,
            function_return_types,
        )
        .map(|resolved| ResolvedTypeRef::RecordOf(Box::new(resolved))),
        RawTypeRef::ReturnTypeOfFn(entity_ref) => {
            let entity_id = match entity_ref {
                ReturnEntityRef::Local(id) => id.clone(),
                ReturnEntityRef::Imported {
                    specifier,
                    imported_name,
                } => import_targets
                    .get(&(
                        owning_path.to_owned(),
                        specifier.clone(),
                        imported_name.clone().unwrap_or_default(),
                    ))?
                    .clone(),
            };
            function_return_types.get(&entity_id).cloned()
        }
        RawTypeRef::IndexedAccess { base, key } => {
            let resolved_base = resolve_raw_type_ref_deferred(
                base,
                owning_path,
                import_targets,
                containers,
                function_return_types,
            )?;
            let ResolvedTypeRef::Entity(base_entity) = resolved_base else {
                return None;
            };
            // G extension (E-P0l, 2026-09-08): `key` naming one of `base_
            // entity`'s own CALLABLE members (a method/getter/setter)
            // means `T['key']` here represents "the SAME callable
            // identity as that member", not merely "a value of that
            // member's own declared TYPE" -- see `lookup_member_entity_
            // if_callable`'s own doc comment. Checked FIRST: falls back to
            // the existing "type of that member" behavior for a plain
            // data property (`lookup_member_type_ref` below), unchanged.
            if let Some(callable_id) =
                lookup_member_entity_if_callable(containers, &base_entity, key)
            {
                return Some(ResolvedTypeRef::TypeQuery(Some(callable_id)));
            }
            lookup_member_type_ref(containers, &base_entity, key, false)
        }
        // P2-2j: resolve every constituent (through the SAME deferred pass,
        // so a union containing a `ReturnTypeOfFn`/`IndexedAccess`
        // constituent still closes) or none at all -- see `ResolvedTypeRef
        // ::Union`'s doc comment.
        RawTypeRef::Union(items) => items
            .iter()
            .map(|item| {
                resolve_raw_type_ref_deferred(
                    item,
                    owning_path,
                    import_targets,
                    containers,
                    function_return_types,
                )
            })
            .collect::<Option<Vec<_>>>()
            .map(ResolvedTypeRef::Union),
        // G (E-P0l): same first-pass resolution as `resolve_raw_type_ref`'s
        // own `TypeQuery` arm -- reachable here only when `TypeQuery` is
        // nested inside a `Union`/`ArrayOf`/... alongside a genuinely
        // deferred leaf (`ReturnTypeOfFn`/`IndexedAccess`), which routes
        // the WHOLE composite through this function instead.
        RawTypeRef::TypeQuery(entity_ref) => {
            Some(ResolvedTypeRef::TypeQuery(entity_ref.as_ref().and_then(
                |entity_ref| resolve_type_query_entity_ref(entity_ref, owning_path, import_targets),
            )))
        }
        // E-P0p (2026-09-09): mirrors `ArrayOf`/`PromiseOf`/`RecordOf`
        // above -- the predicate target may itself need this same deferred
        // pass (e.g. `this is ReturnType<typeof f>`, never seen live but
        // not excluded either).
        RawTypeRef::TypePredicate { subject, target } => resolve_raw_type_ref_deferred(
            target,
            owning_path,
            import_targets,
            containers,
            function_return_types,
        )
        .map(|resolved| ResolvedTypeRef::TypePredicate {
            subject: subject.clone(),
            target: Box::new(resolved),
        }),
        RawTypeRef::Unknown => None,
    }
}

/// Free-function core of `ProgramIndex::member_type_ref`, taking the
/// `containers` map directly rather than `&self` -- shared by the public
/// method AND `ProgramIndex::build`'s own second pass (resolving a
/// `HeritageTarget::CallMember` heritage target), which runs BEFORE `Self`
/// exists.
fn lookup_member_type_ref(
    containers: &HashMap<String, ResolvedContainer>,
    entity_id: &str,
    name: &str,
    is_static: bool,
) -> Option<ResolvedTypeRef> {
    let mut visited = std::collections::HashSet::new();
    collect_member_type_ref(containers, entity_id, name, is_static, &mut visited, true)
}

/// G extension (E-P0l, 2026-09-08): whether `target_id` (a `jsts:{kind}:
/// {path}:{start}:{name}` entity id) names a METHOD/getter/setter/
/// constructor, as opposed to a plain data property or parameter property
/// -- byte-identical rule to `urdira_jsts_syntax_worker::SemanticWalker::
/// narrowed_target_is_a_callable_kind` (duplicated here rather than
/// shared, same cross-crate-parallel-enum discipline as everywhere else in
/// this pair of crates).
fn member_kind_is_callable(target_id: &str) -> bool {
    target_id
        .strip_prefix("jsts:")
        .and_then(|rest| rest.split(':').next())
        .is_some_and(|kind| matches!(kind, "method" | "getter" | "setter" | "constructor"))
}

/// G extension (E-P0l, 2026-09-08): `entity_id`'s own entity id for member
/// `name`, but ONLY when the walk (own body, then `extends`, then --
/// exactly like `collect_member_type_ref` -- `implements`) finds it
/// UNIQUELY and that member is itself CALLABLE (`member_kind_is_callable`)
/// -- used by `IndexedAccess`'s own deferred resolution below: `T['key']`
/// used as a PROPERTY's declared type, when `key` names one of `T`'s own
/// methods, means "the SAME callable identity as that method" for
/// call-target purposes (found live: `_createMessageRequestHandler:
/// IMcpServerRequestHandlerOptions['createMessageRequestHandler']`,
/// `IMcpServerRequestHandlerOptions.createMessageRequestHandler` itself a
/// method signature) -- never a guess: an ambiguous or non-callable match
/// falls through to `None`, letting the caller fall back to `lookup_
/// member_type_ref`'s existing "type OF that member" behavior instead.
fn lookup_member_entity_if_callable(
    containers: &HashMap<String, ResolvedContainer>,
    entity_id: &str,
    name: &str,
) -> Option<String> {
    let mut visited = std::collections::HashSet::new();
    collect_member_entity_if_callable(containers, entity_id, name, false, &mut visited, true)
}

fn collect_member_entity_if_callable(
    containers: &HashMap<String, ResolvedContainer>,
    entity_id: &str,
    name: &str,
    is_static: bool,
    visited: &mut std::collections::HashSet<String>,
    allow_implements_fallback: bool,
) -> Option<String> {
    const MAX_DEPTH: usize = 32;
    if visited.len() >= MAX_DEPTH || !visited.insert(entity_id.to_owned()) {
        return None;
    }
    let container = containers.get(entity_id)?;
    let effective_static = is_static && !container.is_interface;
    let matches: Vec<&ResolvedMember> = container
        .members
        .iter()
        .filter(|member| member.name == name && member.is_static == effective_static)
        .collect();
    if matches.len() == 1 {
        return member_kind_is_callable(&matches[0].entity_id)
            .then(|| matches[0].entity_id.clone());
    }
    if !matches.is_empty() {
        return None;
    }
    for base in &container.extends {
        if let Some(found) =
            collect_member_entity_if_callable(containers, base, name, is_static, visited, false)
        {
            return Some(found);
        }
    }
    if allow_implements_fallback {
        for interface in &container.implements {
            if let Some(found) = collect_member_entity_if_callable(
                containers, interface, name, false, visited, false,
            ) {
                return Some(found);
            }
        }
    }
    None
}

fn collect_member_type_ref(
    containers: &HashMap<String, ResolvedContainer>,
    entity_id: &str,
    name: &str,
    is_static: bool,
    visited: &mut std::collections::HashSet<String>,
    allow_implements_fallback: bool,
) -> Option<ResolvedTypeRef> {
    const MAX_DEPTH: usize = 32;
    if visited.len() >= MAX_DEPTH || !visited.insert(entity_id.to_owned()) {
        return None;
    }
    let container = containers.get(entity_id)?;
    let effective_static = is_static && !container.is_interface;
    let matches: Vec<&ResolvedMember> = container
        .members
        .iter()
        .filter(|member| member.name == name && member.is_static == effective_static)
        .collect();
    if matches.len() == 1 {
        return matches[0].type_ref.clone();
    }
    if !matches.is_empty() {
        // Mirrors `collect_members`: an own-level match (even an ambiguous
        // one) never falls through to the heritage chain.
        return None;
    }
    for base in &container.extends {
        if let Some(type_ref) =
            collect_member_type_ref(containers, base, name, is_static, visited, false)
        {
            return Some(type_ref);
        }
    }
    if allow_implements_fallback {
        for interface in &container.implements {
            if let Some(type_ref) =
                collect_member_type_ref(containers, interface, name, false, visited, false)
            {
                return Some(type_ref);
            }
        }
    }
    None
}

/// E-P0m (2026-09-08): byte-identical own-body-then-`extends`-then-
/// `implements` walk to `collect_member_type_ref` right above (same
/// `matches.len() == 1` own-level short-circuit, same "an own-level
/// ambiguous match never falls through to heritage" rule, same `visited`/
/// depth guard) -- the ONLY difference is the leaf: instead of returning
/// the member's resolved type, it reports whether that SAME member has a
/// real, named annotation that failed to resolve (`had_named_type_
/// reference && type_ref.is_none()`, see that field's own doc comment).
/// `false` for "no member with this name found at all" (nothing to be
/// unresolved) exactly like `collect_member_type_ref` returns `None` there
/// -- never a guess either way.
fn collect_member_annotation_unresolved(
    containers: &HashMap<String, ResolvedContainer>,
    entity_id: &str,
    name: &str,
    is_static: bool,
    visited: &mut std::collections::HashSet<String>,
    allow_implements_fallback: bool,
) -> bool {
    const MAX_DEPTH: usize = 32;
    if visited.len() >= MAX_DEPTH || !visited.insert(entity_id.to_owned()) {
        return false;
    }
    let Some(container) = containers.get(entity_id) else {
        return false;
    };
    let effective_static = is_static && !container.is_interface;
    let matches: Vec<&ResolvedMember> = container
        .members
        .iter()
        .filter(|member| member.name == name && member.is_static == effective_static)
        .collect();
    if matches.len() == 1 {
        return matches[0].had_named_type_reference && matches[0].type_ref.is_none();
    }
    if !matches.is_empty() {
        return false;
    }
    for base in &container.extends {
        if collect_member_annotation_unresolved(containers, base, name, is_static, visited, false) {
            return true;
        }
    }
    if allow_implements_fallback {
        for interface in &container.implements {
            if collect_member_annotation_unresolved(
                containers, interface, name, false, visited, false,
            ) {
                return true;
            }
        }
    }
    false
}

/// D.2 (2026-09-05, references-parity task): `entity_id` as a HERITAGE
/// target specifically wants to see it -- unlike `dealias_entity` (which
/// always has an answer, wrapping a non-entity alias shape as-is), a
/// heritage clause (`extends`/`implements`) can ONLY ever name a
/// class/interface/type-literal CONTAINER, never an array/promise/union/
/// `this` shape, so an alias whose own target is one of those is not a
/// usable heritage target at all -- `None`, never a guess (`class C
/// extends Alias` where `type Alias = Foo[]` stays unresolved, exactly
/// like `class C extends Foo[]` itself always has). An id `alias_targets`
/// never heard of is not a known alias -- itself IS the (real) container,
/// unchanged.
fn dealias_heritage_id(
    entity_id: String,
    alias_targets: &HashMap<String, Option<ResolvedTypeRef>>,
) -> Option<String> {
    match alias_targets.get(&entity_id) {
        Some(Some(ResolvedTypeRef::Entity(real_id))) => Some(real_id.clone()),
        // A known alias, but its own target is not a usable heritage shape
        // (`Some(Some(_))` -- an array/promise/union/`this`) or never
        // converged at all (`Some(None)` -- a cycle/too-deep chain):
        // either way, never a guess.
        Some(Some(_)) | Some(None) => None,
        // Not a known alias -- `entity_id` itself IS the (real) container.
        None => Some(entity_id),
    }
}

fn resolve_heritage_target(
    target: &HeritageTarget,
    owning_path: &str,
    import_targets: &HashMap<(String, String, String), String>,
    alias_targets: &HashMap<String, Option<ResolvedTypeRef>>,
) -> Option<String> {
    match target {
        HeritageTarget::Local(entity_id) => dealias_heritage_id(entity_id.clone(), alias_targets),
        HeritageTarget::Imported {
            specifier,
            imported_name,
        } => import_targets
            .get(&(
                owning_path.to_owned(),
                specifier.clone(),
                imported_name.clone().unwrap_or_default(),
            ))
            .cloned()
            .and_then(|entity_id| dealias_heritage_id(entity_id, alias_targets)),
        HeritageTarget::Unknown => None,
        // Resolved in `ProgramIndex::build`'s SECOND pass instead (needs
        // every container's member table already built) -- see
        // `HeritageTarget::CallMember`'s doc comment.
        HeritageTarget::CallMember { .. } => None,
    }
}

/// P1-B: a `DeferredReturnShape` with every `CallEntity` import reference
/// already closed against `import_targets` (the only resolution step that
/// can never change across fixed-point iterations -- see `ProgramIndex::
/// build`'s third-pass doc comment). `None` from `prepare_return_shapes`
/// (never a variant here) the instant any ONE shape's import reference
/// fails to resolve -- see that function's own doc comment.
#[derive(Debug, Clone, PartialEq, Eq)]
enum PreparedReturnShape {
    /// Already a concrete, final answer (from `DeferredReturnShape::Known`,
    /// closed the SAME way any other `RawTypeRef` is).
    Resolved(ResolvedTypeRef),
    /// Look up `function_return_types[entity_id]` at resolution time --
    /// still `None` there is `Pending` (the target's OWN inference has not
    /// landed yet, or never will), never `Failed` outright (see `resolve_
    /// prepared_shape`'s own doc comment on why the two are
    /// indistinguishable here, and why that is safe).
    PendingFunction(String),
    /// Look up `name` (at `is_static`) on `container`'s own member table
    /// (own body, then `extends`, then -- for a class -- `implements`) at
    /// resolution time -- see `member_lookup_status`.
    PendingMember {
        container: String,
        name: String,
        is_static: bool,
    },
    /// One `await` layer around `inner`'s eventual resolution -- unwraps a
    /// `PromiseOf` when `inner` resolves to one, passes anything else
    /// through unchanged (mirrors `SemanticWalker::type_of_expression`'s own
    /// `AwaitExpression` arm).
    AwaitOf(Box<PreparedReturnShape>),
}

/// `DeferredReturnShape` -> `PreparedReturnShape`, closing every `CallEntity`
/// import reference against `import_targets` up front. `None` the instant
/// ANY shape's import fails to resolve (an unresolved/ambiguous/default-or-
/// namespace-import specifier) -- the calling function/method's inference
/// is dropped entirely, never guessed from the rest, matching `collect_
/// pending_return_shapes`'s own "one bad shape drops the whole thing" rule.
fn prepare_return_shapes(
    shapes: &[DeferredReturnShape],
    owning_path: &str,
    import_targets: &HashMap<(String, String, String), String>,
    alias_targets: &HashMap<String, Option<ResolvedTypeRef>>,
) -> Option<Vec<PreparedReturnShape>> {
    shapes
        .iter()
        .map(|shape| prepare_one_return_shape(shape, owning_path, import_targets, alias_targets))
        .collect()
}

fn prepare_one_return_shape(
    shape: &DeferredReturnShape,
    owning_path: &str,
    import_targets: &HashMap<(String, String, String), String>,
    alias_targets: &HashMap<String, Option<ResolvedTypeRef>>,
) -> Option<PreparedReturnShape> {
    match shape {
        DeferredReturnShape::Known(raw) => {
            resolve_raw_type_ref(raw, owning_path, import_targets, alias_targets)
                .map(PreparedReturnShape::Resolved)
        }
        DeferredReturnShape::MemberOf {
            container,
            name,
            is_static,
        } => Some(PreparedReturnShape::PendingMember {
            container: container.clone(),
            name: name.clone(),
            is_static: *is_static,
        }),
        DeferredReturnShape::CallEntity(entity_ref) => {
            let entity_id = match entity_ref {
                ReturnEntityRef::Local(id) => id.clone(),
                ReturnEntityRef::Imported {
                    specifier,
                    imported_name,
                } => import_targets
                    .get(&(
                        owning_path.to_owned(),
                        specifier.clone(),
                        imported_name.clone().unwrap_or_default(),
                    ))?
                    .clone(),
            };
            Some(PreparedReturnShape::PendingFunction(entity_id))
        }
        DeferredReturnShape::AwaitOf(inner) => {
            let inner =
                prepare_one_return_shape(inner, owning_path, import_targets, alias_targets)?;
            Some(PreparedReturnShape::AwaitOf(Box::new(inner)))
        }
        DeferredReturnShape::Unknown => None,
    }
}

/// Outcome of resolving ONE `PreparedReturnShape` against the fixed point's
/// current, possibly still-incomplete state.
enum ShapeStatus {
    Resolved(ResolvedTypeRef),
    /// The target exists but does not have a resolved type YET (it may
    /// still get one on a later iteration -- keep waiting) OR it never will
    /// (the iteration bound in `ProgramIndex::build` is what stops this
    /// from looping forever; a shape stuck `Pending` when the bound is hit
    /// simply never contributes an answer, matching every other "give up,
    /// never guess" degrade in this crate).
    Pending,
    /// The target definitively does not exist (an ambiguous/absent member
    /// lookup) -- never becomes `Resolved` no matter how many more
    /// iterations run.
    Failed,
}

/// `name` (at `is_static`) on `entity_id`'s own member table, walking the
/// SAME own-body -> `extends` -> (class only) `implements` order as
/// `collect_member_type_ref`, but distinguishing "the member exists but its
/// own type is not resolved yet" (`Pending` -- it may be another shallow-
/// inferred member/function still waiting its own turn in the SAME fixed
/// point) from "no such member" (`Failed`) -- a distinction `collect_
/// member_type_ref`'s own `Option` return cannot make, and exactly the one
/// this fixed point needs to know whether to keep waiting or give up.
fn member_lookup_status(
    containers: &HashMap<String, ResolvedContainer>,
    entity_id: &str,
    name: &str,
    is_static: bool,
) -> ShapeStatus {
    let mut visited = std::collections::HashSet::new();
    member_lookup_status_rec(containers, entity_id, name, is_static, &mut visited, true)
}

fn member_lookup_status_rec(
    containers: &HashMap<String, ResolvedContainer>,
    entity_id: &str,
    name: &str,
    is_static: bool,
    visited: &mut std::collections::HashSet<String>,
    allow_implements_fallback: bool,
) -> ShapeStatus {
    const MAX_DEPTH: usize = 32;
    if visited.len() >= MAX_DEPTH || !visited.insert(entity_id.to_owned()) {
        return ShapeStatus::Failed;
    }
    let Some(container) = containers.get(entity_id) else {
        return ShapeStatus::Failed;
    };
    let effective_static = is_static && !container.is_interface;
    let matches: Vec<&ResolvedMember> = container
        .members
        .iter()
        .filter(|member| member.name == name && member.is_static == effective_static)
        .collect();
    if matches.len() == 1 {
        return match &matches[0].type_ref {
            Some(type_ref) => ShapeStatus::Resolved(type_ref.clone()),
            None => ShapeStatus::Pending,
        };
    }
    if !matches.is_empty() {
        // Mirrors `collect_member_type_ref`: an own-level match (even an
        // ambiguous one) never falls through to the heritage chain, and
        // never resolves.
        return ShapeStatus::Failed;
    }
    for base in &container.extends {
        match member_lookup_status_rec(containers, base, name, is_static, visited, false) {
            ShapeStatus::Failed => continue,
            other => return other,
        }
    }
    if allow_implements_fallback {
        for interface in &container.implements {
            match member_lookup_status_rec(containers, interface, name, false, visited, false) {
                ShapeStatus::Failed => continue,
                other => return other,
            }
        }
    }
    ShapeStatus::Failed
}

fn resolve_prepared_shape(
    shape: &PreparedReturnShape,
    containers: &HashMap<String, ResolvedContainer>,
    function_return_types: &HashMap<String, ResolvedTypeRef>,
) -> ShapeStatus {
    match shape {
        PreparedReturnShape::Resolved(type_ref) => ShapeStatus::Resolved(type_ref.clone()),
        PreparedReturnShape::PendingFunction(entity_id) => {
            match function_return_types.get(entity_id) {
                Some(type_ref) => ShapeStatus::Resolved(type_ref.clone()),
                None => ShapeStatus::Pending,
            }
        }
        PreparedReturnShape::PendingMember {
            container,
            name,
            is_static,
        } => member_lookup_status(containers, container, name, *is_static),
        PreparedReturnShape::AwaitOf(inner) => {
            match resolve_prepared_shape(inner, containers, function_return_types) {
                ShapeStatus::Resolved(ResolvedTypeRef::PromiseOf(unwrapped)) => {
                    ShapeStatus::Resolved(*unwrapped)
                }
                other => other,
            }
        }
    }
}

/// Outcome of resolving a WHOLE return-shape list (one function/method's
/// worth) against the fixed point's current state.
enum ShapeResolution {
    /// Every shape resolved and all AGREE on the same `ResolvedTypeRef` --
    /// this becomes the function/method's own inferred return type.
    Resolved(ResolvedTypeRef),
    /// Every shape resolved but to two or more DIFFERENT types -- this
    /// session's inference has no `possible`/union output yet (see
    /// `docs/evidence/2026-09-02-v4-p1b-typeflow.md`), so this drops to
    /// `Unknown` rather than guess one -- never wrong-target, at the cost
    /// of not recovering this specific site.
    Conflict,
    /// At least one shape definitively cannot resolve (`ShapeStatus::
    /// Failed`) -- drops to `Unknown`, same as `Conflict`.
    Failed,
    /// At least one shape is still `Pending` and none has failed yet --
    /// retry on the next iteration.
    Pending,
}

fn resolve_prepared_shapes(
    shapes: &[PreparedReturnShape],
    containers: &HashMap<String, ResolvedContainer>,
    function_return_types: &HashMap<String, ResolvedTypeRef>,
) -> ShapeResolution {
    let mut resolved: Vec<ResolvedTypeRef> = Vec::new();
    for shape in shapes {
        match resolve_prepared_shape(shape, containers, function_return_types) {
            ShapeStatus::Resolved(type_ref) => resolved.push(type_ref),
            ShapeStatus::Pending => return ShapeResolution::Pending,
            ShapeStatus::Failed => return ShapeResolution::Failed,
        }
    }
    let Some(first) = resolved.first() else {
        return ShapeResolution::Failed;
    };
    if resolved.iter().all(|candidate| candidate == first) {
        ShapeResolution::Resolved(first.clone())
    } else {
        ShapeResolution::Conflict
    }
}

/// Erase a `TSType`'s generic type arguments (if any) and return the plain
/// identifier root, when the type is (ignoring its arguments) a bare
/// `TSTypeReference` naming an `IdentifierReference` -- `Foo<T>` erases to
/// `Foo`'s own `IdentifierReference`; a qualified name (`ns.Foo<T>`), a
/// union/array/other compound type, or a `this` type all return `None`.
/// Used by `urdira-jsts-syntax-worker` to widen E3's own generic-args-bail
/// heritage handling (see `resolve_heritage_clause`'s doc comment there).
pub fn erase_generic_heritage_identifier<'a>(
    ty: &'a TSType,
) -> Option<&'a IdentifierReference<'a>> {
    match ty {
        TSType::TSTypeReference(reference) => match &reference.type_name {
            TSTypeName::IdentifierReference(ident) => Some(ident),
            _ => None,
        },
        _ => None,
    }
}

/// The whole-expression callee root of a call, one member hop at a time:
/// `Some(base_expr, member_name)` for `base.member` (a `StaticMemberExpression`
/// with a plain, non-computed, non-private property), `None` for anything
/// else (a computed/private member, or a callee that is not a member
/// expression at all). Used by `urdira-jsts-syntax-worker` to decompose a
/// call's callee before attempting typeflow resolution -- kept here
/// (rather than duplicated) purely because `erase_generic_heritage_identifier`
/// already lives in this crate for the same reason (a shared, dependency-free
/// AST helper); it does not itself need `ProgramIndex`.
pub fn member_callee<'a, 'b>(expr: &'b Expression<'a>) -> Option<(&'b Expression<'a>, &'b str)> {
    match expr {
        Expression::StaticMemberExpression(member) => {
            Some((&member.object, member.property.name.as_str()))
        }
        _ => None,
    }
}

/// True when `expr` is a plain call with no spread/optional-chaining
/// surprise this prototype has not reasoned about (kept minimal: today it
/// only guards against a `Super`/`Import`-cannot-be-a-plain-callee
/// confusion at the call site; see the module doc for the "never widen past
/// what's proven" rule this whole crate follows).
pub fn is_plain_argument_list(arguments: &[Argument]) -> bool {
    arguments
        .iter()
        .all(|argument| !matches!(argument, Argument::SpreadElement(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(source: &str) -> DeclSummary {
        extract_decl_summary("a.ts", source).expect("parses")
    }

    #[test]
    fn extracts_class_members_and_local_extends() {
        let source = "class Base {\n  greet() {}\n  static make() {}\n}\nclass Derived extends Base {\n  shout() {}\n}\n";
        let summary = summary(source);
        assert_eq!(summary.classes.len(), 2);
        let base = &summary.classes[0];
        assert_eq!(base.entity_id, declaration_id("class", "a.ts", 6, "Base"));
        assert!(
            base.members
                .iter()
                .any(|m| m.name == "greet" && !m.is_static)
        );
        assert!(base.members.iter().any(|m| m.name == "make" && m.is_static));
        let derived = &summary.classes[1];
        assert_eq!(
            derived.extends,
            Some(HeritageTarget::Local(base.entity_id.clone()))
        );
    }

    #[test]
    fn extracts_interface_members_and_extends() {
        let source = "interface Base {\n  id: string;\n}\ninterface Child extends Base {\n  name(): string;\n}\n";
        let summary = summary(source);
        assert_eq!(summary.interfaces.len(), 2);
        let base = &summary.interfaces[0];
        let child = &summary.interfaces[1];
        assert_eq!(
            child.extends,
            vec![HeritageTarget::Local(base.entity_id.clone())]
        );
        assert!(child.members.iter().any(|m| m.name == "name"));
    }

    /// The equivalence the task brief requires: `member_declarations`'s own
    /// AST walk and `ProgramIndex`'s `MemberEntry` construction (via
    /// `extract_decl_summary`) must agree on the exact same set of entity
    /// ids for a fixture that exercises every member shape this crate
    /// indexes today (class method/`constructor`/`get`/`set`/static,
    /// class property incl. static, interface method signature, interface
    /// property signature, and -- since this crate's parameter-property
    /// support landed -- a constructor parameter property) -- see
    /// `member_declarations`'s own doc comment for why object-shape/
    /// callable-variable "members" are deliberately excluded from this
    /// fixture (they are out of `MemberDeclaration`'s scope, so including
    /// one here would make this test fail for the wrong reason). The
    /// constructor's plain (non-property) `x` parameter is included
    /// specifically to prove it is NOT enumerated as a member either side.
    #[test]
    fn member_declarations_matches_member_entry_index() {
        let source = "class Base {\n  constructor(x, public prop) {}\n  greet() {}\n  static make() {}\n  get id() { return 1; }\n  set id(v) {}\n  name = \"x\";\n  static count = 0;\n  #secret() {}\n}\ninterface Shape {\n  area(): number;\n  readonly kind: string;\n}\n";
        let path = "member_shapes.ts";

        let summary = extract_decl_summary(path, source).expect("parses");
        let mut from_index: Vec<String> = summary
            .classes
            .iter()
            .flat_map(|class| class.members.iter().map(|member| member.entity_id.clone()))
            .chain(summary.interfaces.iter().flat_map(|interface| {
                interface
                    .members
                    .iter()
                    .map(|member| member.entity_id.clone())
            }))
            .collect();
        from_index.sort();

        let allocator = Allocator::default();
        let source_type =
            SourceType::from_path(std::path::Path::new(path)).expect("valid source type");
        let mut parsed = Parser::new(&allocator, source, source_type).parse();
        Utf8ToUtf16::new(source).convert_program(&mut parsed.program);
        let declarations = member_declarations(&parsed.program, path);
        let mut from_helper: Vec<String> = declarations
            .iter()
            .map(|declaration| declaration.entity_id.clone())
            .collect();
        from_helper.sort();

        assert_eq!(from_index, from_helper);
        // Sanity: the fixture actually exercises every shape this crate
        // indexes -- an empty (or trivially-agreeing) intersection would
        // make the equality above meaningless.
        assert_eq!(from_helper.len(), 11);
        assert!(
            declarations
                .iter()
                .any(|declaration| declaration.kind_word == "constructor")
        );
        assert!(
            declarations
                .iter()
                .any(|declaration| declaration.kind_word == "getter")
        );
        assert!(
            declarations
                .iter()
                .any(|declaration| declaration.kind_word == "setter")
        );
        assert!(
            declarations
                .iter()
                .any(|declaration| declaration.kind_word == "method" && declaration.is_static)
        );
        assert!(
            declarations
                .iter()
                .any(|declaration| declaration.kind_word == "property" && declaration.is_static)
        );
        let base_id = declaration_id("class", path, 6, "Base");
        assert!(
            declarations
                .iter()
                .all(|declaration| declaration.container_entity_id != base_id
                    || declaration.container_name == "Base")
        );
        // The parameter property (`public prop`): kind word "parameter"
        // (never "property" -- see `push_constructor_parameter_property_
        // declarations`'s doc comment for the v3-parity reason), parented
        // on the CONSTRUCTOR's own entity id (not the class's), and its
        // plain sibling `x` is never enumerated at all.
        let constructor_id = declarations
            .iter()
            .find(|declaration| declaration.kind_word == "constructor")
            .expect("constructor is enumerated")
            .entity_id
            .clone();
        let prop_param = declarations
            .iter()
            .find(|declaration| declaration.name == "prop")
            .expect("the parameter property is enumerated as a member");
        assert_eq!(prop_param.kind_word, "parameter");
        assert!(!prop_param.is_static);
        assert_eq!(prop_param.container_entity_id, constructor_id);
        assert_eq!(prop_param.container_name, "Base.constructor");
        assert!(
            !declarations
                .iter()
                .any(|declaration| declaration.name == "x"),
            "a plain (non-property) constructor parameter is never a member"
        );
    }

    /// Every accessibility spelling (`public`/`private`/`protected`) and
    /// `readonly` alone, each with and without the parameter's own `?`
    /// optionality marker -- all six qualify as members; a bare parameter
    /// with no modifier at all never does.
    #[test]
    fn parameter_properties_enumerated_for_every_modifier_spelling() {
        let source = "class C {\n  constructor(\n    public a: string,\n    private b?: string,\n    protected c: string,\n    readonly d?: string,\n    readonly e: string,\n    plain: string,\n  ) {}\n}\n";
        let path = "params.ts";
        let allocator = Allocator::default();
        let source_type =
            SourceType::from_path(std::path::Path::new(path)).expect("valid source type");
        let mut parsed = Parser::new(&allocator, source, source_type).parse();
        Utf8ToUtf16::new(source).convert_program(&mut parsed.program);
        let declarations = member_declarations(&parsed.program, path);
        let mut parameter_names: Vec<&str> = declarations
            .iter()
            .filter(|declaration| declaration.kind_word == "parameter")
            .map(|declaration| declaration.name.as_str())
            .collect();
        parameter_names.sort_unstable();
        assert_eq!(parameter_names, vec!["a", "b", "c", "d", "e"]);
        // Exactly one non-parameter member: the constructor itself.
        assert_eq!(
            declarations
                .iter()
                .filter(|declaration| declaration.kind_word != "parameter")
                .count(),
            1
        );

        // `ProgramIndex`'s own `MemberEntry` construction must agree
        // exactly (the crate's own equivalence discipline, same as
        // `member_declarations_matches_member_entry_index` above).
        let file_summary = extract_decl_summary(path, source).expect("parses");
        let mut from_index: Vec<String> = file_summary.classes[0]
            .members
            .iter()
            .filter(|member| member.name != "constructor")
            .map(|member| member.name.clone())
            .collect();
        from_index.sort();
        assert_eq!(from_index, vec!["a", "b", "c", "d", "e"]);
    }

    #[test]
    fn erases_generic_type_arguments() {
        let source = "class Box<T> {}\nclass IntBox extends Box<number> {}\n";
        let summary = summary(source);
        let base = &summary.classes[0];
        let int_box = &summary.classes[1];
        assert_eq!(
            int_box.extends,
            Some(HeritageTarget::Local(base.entity_id.clone()))
        );
    }

    #[test]
    fn classifies_imported_base_class() {
        let source = "import { Base } from \"./base\";\nclass Derived extends Base {}\n";
        let summary = summary(source);
        let derived = &summary.classes[0];
        assert_eq!(
            derived.extends,
            Some(HeritageTarget::Imported {
                specifier: "./base".to_owned(),
                imported_name: Some("Base".to_owned()),
            })
        );
    }

    #[test]
    fn qualified_heritage_name_is_unknown() {
        let source = "import * as ns from \"./ns\";\nclass Derived extends ns.Base {}\n";
        let summary = summary(source);
        // `ns.Base` is a `StaticMemberExpression`, never `Expression::
        // Identifier`, so `heritage_target_of_expression` never even
        // attempts to classify it.
        assert_eq!(summary.classes[0].extends, Some(HeritageTarget::Unknown));
    }

    // -- D.2 (2026-09-05, references-parity task): type aliases ---------

    #[test]
    fn type_alias_extraction_captures_the_rhs_as_a_raw_type_ref() {
        let file_summary = summary("class Foo {}\ntype Alias = Foo;\n");
        let foo_id = file_summary.classes[0].entity_id.clone();
        assert_eq!(file_summary.type_aliases.len(), 1);
        assert_eq!(file_summary.type_aliases[0].name, "Alias");
        assert_eq!(
            file_summary.type_aliases[0].target,
            RawTypeRef::Local(foo_id)
        );
    }

    /// D.2 point 4, case 1: `type Alias = Foo; class C { m(): Alias }` --
    /// `member_type_ref` on `C`'s method `m` resolves to `Entity(Foo)`, the
    /// alias's own OWN target, not a dangling reference to `Alias`'s own
    /// (never-a-container) `type` entity id.
    #[test]
    fn member_return_type_annotated_with_a_local_type_alias_resolves_to_the_aliased_class() {
        let file_summary = summary_for(
            "a.ts",
            "class Foo {}\ntype Alias = Foo;\nclass C {\n  m(): Alias {\n    return new Foo();\n  }\n}\n",
        );
        let foo_id = file_summary.classes[0].entity_id.clone();
        let c_id = file_summary.classes[1].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.member_type_ref(&c_id, "m", false),
            Some(ResolvedTypeRef::Entity(foo_id))
        );
    }

    /// D.2 point 4, case 2: `type Alias = { a: Foo }` -- the object-literal
    /// RHS synthesizes an interface for `a` to live on (same mechanism an
    /// inline `{ ... }` member annotation already uses), and the alias
    /// points AT that synthesized interface.
    #[test]
    fn type_alias_to_an_object_literal_synthesizes_an_interface_with_the_member() {
        let file_summary = summary_for("a.ts", "class Foo {}\ntype Alias = { a: Foo };\n");
        let foo_id = file_summary.classes[0].entity_id.clone();
        assert_eq!(file_summary.type_aliases.len(), 1, "{file_summary:?}");
        assert_eq!(file_summary.interfaces.len(), 1, "{file_summary:?}");
        let synthetic_id = file_summary.interfaces[0].entity_id.clone();
        assert_eq!(
            file_summary.type_aliases[0].target,
            RawTypeRef::Local(synthetic_id.clone())
        );
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.member_type_ref(&synthetic_id, "a", false),
            Some(ResolvedTypeRef::Entity(foo_id))
        );
    }

    /// D.2 point 4, case 3: `interface I extends Alias {}` where `type
    /// Alias = Base` -- `I` inherits `Base`'s own members, exactly as if it
    /// had written `interface I extends Base {}` directly (a CLASS heritage
    /// clause, unlike an interface's, is VALUE-space -- `class C extends
    /// Alias` where `Alias` is a pure `type` is not even valid TypeScript,
    /// `Alias` "only refers to a type"; an interface's own `extends` is the
    /// shape D.2's own `SymbolFlags::TypeAlias` branch in `classify_
    /// heritage_identifier` is actually for). Exercises `resolve_heritage_
    /// target`'s own de-aliasing (`dealias_heritage_id`), not `resolve_raw_
    /// type_ref`'s (the previous two tests).
    #[test]
    fn interface_extends_a_local_type_alias_inherits_the_aliased_interfaces_members() {
        let file_summary = summary_for(
            "a.ts",
            "interface Base {\n  greet(): void;\n}\ntype Alias = Base;\ninterface I extends Alias {}\n",
        );
        let base_id = file_summary.interfaces[0].entity_id.clone();
        let base_greet_id = file_summary.interfaces[0].members[0].entity_id.clone();
        let i_id = file_summary.interfaces[1].entity_id.clone();
        assert_eq!(
            file_summary.interfaces[1].extends,
            vec![HeritageTarget::Local(
                file_summary.type_aliases[0].id.clone()
            )],
            "{file_summary:?}"
        );
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.members(&i_id, "greet", false),
            MemberLookup::One(base_greet_id.clone())
        );
        // Not the interface's OWN entity_id -- `greet`'s own declaration
        // lives on `Base`, `members` returns the member's owning entity id,
        // same contract `members_walks_extends_chain_across_files`
        // documents.
        assert_ne!(base_id, base_greet_id);
    }

    /// D.2 point 4, case 4: `type A = B; type B = A` -- a genuine cycle
    /// never converges, `alias_targets` has NO entry for either id, and a
    /// member annotated `A` stays unresolved (`None`), never a guess.
    #[test]
    fn cyclic_type_aliases_never_resolve() {
        let file_summary = summary_for(
            "a.ts",
            "type A = B;\ntype B = A;\nclass C {\n  m(): A { return undefined as any; }\n}\n",
        );
        let c_id = file_summary.classes[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(index.member_type_ref(&c_id, "m", false), None);
    }

    /// D.5 (2026-09-05, adversarial review) regression fixture: an ACYCLIC
    /// diamond of type aliases through a union (`type A = X | Y; type X =
    /// B; type Y = B; type B = Foo;`) must resolve `A` to `Foo | Foo`, not
    /// `None` -- before `resolve_alias_chase_leaf`'s own `visiting.remove`
    /// fix, chasing `X` (`X` -> `B` -> `Foo`) left `B` permanently marked
    /// "visiting" on return, so chasing the SIBLING branch `Y` (`Y` -> `B`)
    /// hit a FALSE cycle at `B` (a sibling's own leftover mark, never an
    /// ancestor of `Y`) and wrongly returned `None`, failing the whole
    /// union.
    #[test]
    fn diamond_shaped_type_alias_union_resolves_without_a_false_cycle() {
        let file_summary = summary_for(
            "a.ts",
            "class Foo {}\ntype B = Foo;\ntype X = B;\ntype Y = B;\ntype A = X | Y;\nclass C {\n  m(): A {\n    return new Foo();\n  }\n}\n",
        );
        let foo_id = file_summary.classes[0].entity_id.clone();
        let c_id = file_summary.classes[1].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.member_type_ref(&c_id, "m", false),
            Some(ResolvedTypeRef::Union(vec![
                ResolvedTypeRef::Entity(foo_id.clone()),
                ResolvedTypeRef::Entity(foo_id),
            ]))
        );
    }

    /// D.5 (2026-09-05, adversarial review): the diamond fix above must
    /// NOT weaken the genuine-cycle guard -- `type A = B; type B = A;`
    /// still returns `None` for both (`A` is still `visiting` when the
    /// chase loops back to it, since `build_alias_targets`'s OWN per-id
    /// call only removes `A` from `visiting` on ITS OWN return, after the
    /// whole chase already failed).
    #[test]
    fn cyclic_type_aliases_still_never_resolve_after_the_diamond_fix() {
        let file_summary = summary_for(
            "a.ts",
            "type A = B;\ntype B = A;\nclass C {\n  m(): A { return undefined as any; }\n}\n",
        );
        let c_id = file_summary.classes[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(index.member_type_ref(&c_id, "m", false), None);
    }

    /// D.2 point 4, case 5: a type alias imported from another file --
    /// `Alias`'s own workspace-wide id is closed against `import_targets`
    /// the SAME way any other imported type name is, THEN de-aliased to
    /// `base.ts`'s own `Base` class.
    #[test]
    fn member_return_type_annotated_with_an_imported_type_alias_resolves_to_the_aliased_class() {
        let base_summary = summary_for(
            "base.ts",
            "export class Base {}\nexport type Alias = Base;\n",
        );
        let user_summary = summary_for(
            "user.ts",
            "import { Alias } from \"./base\";\nclass C {\n  m(): Alias { return undefined as any; }\n}\n",
        );
        let base_id = base_summary.classes[0].entity_id.clone();
        let alias_id = base_summary.type_aliases[0].id.clone();
        let c_id = user_summary.classes[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("base.ts".to_owned(), base_summary);
        summaries.insert("user.ts".to_owned(), user_summary);
        let mut import_targets = HashMap::new();
        import_targets.insert(
            (
                "user.ts".to_owned(),
                "./base".to_owned(),
                "Alias".to_owned(),
            ),
            alias_id,
        );
        let index = ProgramIndex::build(&summaries, &import_targets, &HashMap::new());
        assert_eq!(
            index.member_type_ref(&c_id, "m", false),
            Some(ResolvedTypeRef::Entity(base_id))
        );
    }

    /// E-P0d regression: `entity_owner` never held a TYPE ALIAS's own id
    /// (only classes/interfaces/functions/callable-variables/object-shapes/
    /// variables did -- `insert_file_pass1`'s own loops, before this fix),
    /// so `link_importer` (which requires `entity_owner.get(target_entity_
    /// id)` to succeed) silently no-op'd for EVERY import resolving to a
    /// type alias -- `importers_of`/`transitive_importers_closure` could
    /// never widen an edit's own affected set to reach a file that only
    /// imports something through a type alias. Found live on a real n8n
    /// `head-vs-head200` git switch (`docs/evidence/2026-09-06-v4-
    /// reconcile-threshold.md` §12): `workflow/src/interfaces.ts` exports
    /// `IExecuteFunctions` as `export type IExecuteFunctions = ...`; an
    /// UNEDITED test file's own `function createMockContext():
    /// IExecuteFunctions` return type was correctly resolved at COLD scan
    /// time, but after `interfaces.ts` was later edited (shifting `
    /// IExecuteFunctions`'s own id, among others), the test file's stale
    /// reference was NEVER revisited (its edge was never in `importers_of`
    /// to begin with) -- 23 real `jsts:references` relations lost. This
    /// test reduces that to two files, asserts `importers_of` itself
    /// (the mechanism, not just the end symptom), and confirms the
    /// end-to-end member-type-ref result after an incremental edit matches
    /// a from-scratch rebuild of the same final tree.
    #[test]
    fn importers_of_tracks_a_file_that_only_imports_a_type_alias_and_survives_the_aliased_files_own_edit()
     {
        let base_v1 = "export class Base {}\nexport type Alias = Base;\n";
        // Two leading blank lines shift BOTH `Base`'s and `Alias`'s own
        // `start`-keyed entity ids -- the exact "an edit moves the target's
        // id" shape `replace_file`'s own doc comment addresses.
        let base_v2 = "\n\nexport class Base {}\nexport type Alias = Base;\n";
        let user_source = "import { Alias } from \"./base\";\nclass C {\n  m(): Alias { return undefined as any; }\n}\n";

        let base_summary_v1 = summary_for("base.ts", base_v1);
        let user_summary = summary_for("user.ts", user_source);
        let alias_id_v1 = base_summary_v1.type_aliases[0].id.clone();
        let c_id = user_summary.classes[0].entity_id.clone();

        let mut summaries = BTreeMap::new();
        summaries.insert("base.ts".to_owned(), base_summary_v1);
        summaries.insert("user.ts".to_owned(), user_summary.clone());
        let mut import_targets = HashMap::new();
        import_targets.insert(
            (
                "user.ts".to_owned(),
                "./base".to_owned(),
                "Alias".to_owned(),
            ),
            alias_id_v1,
        );
        let mut index = ProgramIndex::build(&summaries, &import_targets, &HashMap::new());

        // The mechanism itself: `user.ts` must be a KNOWN importer of
        // `base.ts` -- BEFORE this fix, `link_importer` never registered
        // this edge at all (an alias id was never in `entity_owner`), so
        // this would read back empty.
        assert_eq!(
            index.importers_of("base.ts"),
            vec!["user.ts".to_owned()],
            "user.ts's import of a TYPE ALIAS declared in base.ts must be \
             tracked as an importer edge"
        );

        // Incrementally edit ONLY base.ts (user.ts is never touched) --
        // mirrors `TypeflowCache::build_index`'s own warm-loop recipe:
        // refresh base.ts's own needs (none) AND every already-known
        // importer's needs (queried above, BEFORE this edit).
        let base_summary_v2 = extract_decl_summary("base.ts", base_v2).expect("parses");
        let base_id_v2 = base_summary_v2.classes[0].entity_id.clone();
        let alias_id_v2 = base_summary_v2.type_aliases[0].id.clone();
        let mut updates = HashMap::new();
        updates.insert(
            (
                "user.ts".to_owned(),
                "./base".to_owned(),
                "Alias".to_owned(),
            ),
            alias_id_v2.clone(),
        );
        index.replace_file(
            "base.ts",
            base_summary_v2.clone(),
            &updates,
            &HashMap::new(),
        );

        let incremental_result = index.member_type_ref(&c_id, "m", false);
        assert_eq!(
            incremental_result,
            Some(ResolvedTypeRef::Entity(base_id_v2.clone())),
            "user.ts's C.m must re-point at Base's NEW (post-edit) id, not \
             stay stale or unresolved"
        );

        // Oracle: an independent from-scratch build of the SAME final tree.
        let mut fresh_summaries = BTreeMap::new();
        fresh_summaries.insert("base.ts".to_owned(), base_summary_v2);
        fresh_summaries.insert("user.ts".to_owned(), user_summary);
        let mut fresh_import_targets = HashMap::new();
        fresh_import_targets.insert(
            (
                "user.ts".to_owned(),
                "./base".to_owned(),
                "Alias".to_owned(),
            ),
            alias_id_v2,
        );
        let fresh = ProgramIndex::build(&fresh_summaries, &fresh_import_targets, &HashMap::new());
        assert_eq!(incremental_result, fresh.member_type_ref(&c_id, "m", false));
    }

    /// E-P0d root-cause mechanism, at the raw `ProgramIndex` API level:
    /// `consumer.ts` needs `Repo` from `declarer.ts`, but at the point this
    /// index is first built `declarer.ts` does not export `Repo` yet (the
    /// specifier resolves to a KNOWN file, the named export does not) --
    /// exactly the real n8n shape (`docs/evidence/2026-09-06-v4-reconcile-
    /// threshold.md` §11.4/§12: a consuming file's first attempt to resolve
    /// through a barrel fails because the barrel's own re-export/content
    /// edit has not landed in `files`/`project_files` YET, in a SEPARATE,
    /// earlier `build_index` call than the one that fixes it -- reduced
    /// here to the raw mechanism, independent of the structural/content
    /// generation split that triggers it in production). `pending_targets`
    /// records this (mirroring what `v4/typeflow.rs`'s `resolve_import_
    /// targets_for` computes for a real `Unresolved`/`Ambiguous`/
    /// `Namespace` outcome after a successful file-level resolution), and
    /// `declarer.ts`'s own LATER `replace_file` call -- adding the export --
    /// must sweep `consumer.ts` back into its own `transitive_importers_
    /// closure` via `pending_importers_of`, exactly like a successfully-
    /// linked importer would via `importers_of`.
    #[test]
    fn pending_importers_of_lets_a_later_edit_satisfy_a_previously_unresolved_import() {
        let declarer_v1 = "export class Other {}\n";
        let declarer_v2 =
            "export class Other {}\nexport class Repo {\n  find(): number { return 1; }\n}\n";
        let consumer_source = "import { Repo } from \"./declarer\";\nclass C {\n  m(): Repo { return undefined as any; }\n}\n";

        let declarer_summary_v1 = summary_for("declarer.ts", declarer_v1);
        let consumer_summary = summary_for("consumer.ts", consumer_source);
        let c_id = consumer_summary.classes[0].entity_id.clone();

        let mut summaries = BTreeMap::new();
        summaries.insert("declarer.ts".to_owned(), declarer_summary_v1);
        summaries.insert("consumer.ts".to_owned(), consumer_summary.clone());
        // `consumer.ts` resolved the SPECIFIER to `declarer.ts` (a known
        // file) but not the named export `Repo` (it does not exist yet) --
        // the exact "pending" shape, never `Unresolved`-with-no-target-file
        // at all (which would never be tracked here).
        let mut pending_targets: HashMap<String, HashSet<String>> = HashMap::new();
        pending_targets.insert(
            "consumer.ts".to_owned(),
            HashSet::from(["declarer.ts".to_owned()]),
        );
        let mut index = ProgramIndex::build(&summaries, &HashMap::new(), &pending_targets);

        assert_eq!(
            index.member_type_ref(&c_id, "m", false),
            None,
            "Repo does not exist yet -- must stay unresolved, never a guess"
        );
        assert_eq!(
            index.pending_importers_of("declarer.ts"),
            vec!["consumer.ts".to_owned()],
            "consumer.ts's still-failing need must be tracked against declarer.ts"
        );

        // `declarer.ts` is later edited to add the export `consumer.ts` was
        // waiting on. Mirrors `TypeflowCache::build_index`'s own warm-loop
        // recipe: `refresh_paths` for `declarer.ts`'s own turn includes
        // `pending_importers_of("declarer.ts")` (queried above), so
        // `consumer.ts`'s own needed imports get recomputed fresh here too.
        let declarer_summary_v2 = extract_decl_summary("declarer.ts", declarer_v2).expect("parses");
        let repo_id = declarer_summary_v2.classes[1].entity_id.clone();
        let mut updates = HashMap::new();
        updates.insert(
            (
                "consumer.ts".to_owned(),
                "./declarer".to_owned(),
                "Repo".to_owned(),
            ),
            repo_id.clone(),
        );
        // consumer.ts no longer has any pending need -- a full (now empty)
        // snapshot for it, same "never a partial patch" discipline
        // `apply_pending_target_updates` documents.
        let mut pending_after: HashMap<String, HashSet<String>> = HashMap::new();
        pending_after.insert("consumer.ts".to_owned(), HashSet::new());
        index.replace_file(
            "declarer.ts",
            declarer_summary_v2.clone(),
            &updates,
            &pending_after,
        );

        assert_eq!(
            index.member_type_ref(&c_id, "m", false),
            Some(ResolvedTypeRef::Entity(repo_id.clone())),
            "consumer.ts's C.m must now resolve to Repo, exactly like a from-scratch rebuild"
        );
        assert!(
            index.pending_importers_of("declarer.ts").is_empty(),
            "consumer.ts's resolved need must stop being retried"
        );

        // Oracle: an independent from-scratch build of the SAME final tree.
        let mut fresh_summaries = BTreeMap::new();
        fresh_summaries.insert("declarer.ts".to_owned(), declarer_summary_v2);
        fresh_summaries.insert("consumer.ts".to_owned(), consumer_summary);
        let mut fresh_import_targets = HashMap::new();
        fresh_import_targets.insert(
            (
                "consumer.ts".to_owned(),
                "./declarer".to_owned(),
                "Repo".to_owned(),
            ),
            repo_id,
        );
        let fresh = ProgramIndex::build(&fresh_summaries, &fresh_import_targets, &HashMap::new());
        assert_eq!(
            index.member_type_ref(&c_id, "m", false),
            fresh.member_type_ref(&c_id, "m", false)
        );
    }

    /// E-P0d review fix: `remove_file` must clear `pending_importers_of`'s
    /// TARGET-keyed entry too, not just the removed path's own outgoing
    /// (importer-side) edges. `apply_pending_target_updates(&{path: {}})`
    /// (pre-fix, the ONLY cleanup `remove_file` did for this map) only ever
    /// removes `path` as a VALUE inside some other target's set -- it never
    /// touches `pending_importers_of[path]` itself, so deleting a file that
    /// OTHER files were still waiting to resolve an export from (a barrel
    /// with a still-unresolved re-export, say) left a permanent, dangling
    /// entry keyed by the now-nonexistent path, growing unboundedly across
    /// a long-running daemon's own file churn -- violating this field's own
    /// doc comment ("real corpora keep this small"). `consumer.ts`'s own
    /// need degrading to "no target file at all" (never retried again,
    /// matching a from-scratch rebuild without `declarer.ts`) is the
    /// correct end state either way; this test asserts the MAP ITSELF
    /// shrinks, which `pending_importers_of(path)`'s own public accessor
    /// cannot distinguish from "key present but empty" from the outside.
    #[test]
    fn remove_file_clears_the_pending_importers_of_entry_keyed_by_the_removed_target_itself() {
        let declarer_v1 = "export class Other {}\n";
        let consumer_source = "import { Repo } from \"./declarer\";\nclass C {\n  m(): Repo { return undefined as any; }\n}\n";

        let declarer_summary_v1 = summary_for("declarer.ts", declarer_v1);
        let consumer_summary = summary_for("consumer.ts", consumer_source);

        let mut summaries = BTreeMap::new();
        summaries.insert("declarer.ts".to_owned(), declarer_summary_v1);
        summaries.insert("consumer.ts".to_owned(), consumer_summary);
        let mut pending_targets: HashMap<String, HashSet<String>> = HashMap::new();
        pending_targets.insert(
            "consumer.ts".to_owned(),
            HashSet::from(["declarer.ts".to_owned()]),
        );
        let mut index = ProgramIndex::build(&summaries, &HashMap::new(), &pending_targets);

        assert_eq!(
            index.pending_importers_of("declarer.ts"),
            vec!["consumer.ts".to_owned()],
            "precondition: declarer.ts is a pending target"
        );
        assert_eq!(
            index.pending_importers_of_entry_count(),
            1,
            "precondition: exactly one target key in the map"
        );

        index.remove_file("declarer.ts");

        assert!(
            index.pending_importers_of("declarer.ts").is_empty(),
            "consumer.ts's need must degrade to unresolved, never resurface \
             for a deleted target"
        );
        assert_eq!(
            index.pending_importers_of_entry_count(),
            0,
            "the target-keyed entry itself must be dropped, not merely \
             left present-but-empty or unreachable through one accessor -- \
             otherwise it survives forever as a leak for any target file \
             that is deleted while still having a pending importer"
        );
    }

    #[test]
    fn members_walks_extends_chain_across_files() {
        let base_summary = summary_for("base.ts", "export class Base {\n  greet() {}\n}\n");
        let derived_summary = summary_for(
            "derived.ts",
            "import { Base } from \"./base\";\nexport class Derived extends Base {\n  shout() {}\n}\n",
        );
        let base_entity_id = base_summary.classes[0].entity_id.clone();
        let base_greet_id = base_summary.classes[0].members[0].entity_id.clone();
        let derived_id = derived_summary.classes[0].entity_id.clone();
        let derived_shout_id = derived_summary.classes[0].members[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("base.ts".to_owned(), base_summary);
        summaries.insert("derived.ts".to_owned(), derived_summary);
        let mut import_targets = HashMap::new();
        import_targets.insert(
            (
                "derived.ts".to_owned(),
                "./base".to_owned(),
                "Base".to_owned(),
            ),
            base_entity_id,
        );
        let index = ProgramIndex::build(&summaries, &import_targets, &HashMap::new());
        assert_eq!(
            index.members(&derived_id, "shout", false),
            MemberLookup::One(derived_shout_id)
        );
        assert_eq!(
            index.members(&derived_id, "greet", false),
            MemberLookup::One(base_greet_id)
        );
        assert_eq!(
            index.members(&derived_id, "missing", false),
            MemberLookup::None
        );
    }

    #[test]
    fn members_falls_back_to_implements_when_own_chain_misses() {
        let file_summary = summary_for(
            "a.ts",
            "interface Greeter {\n  greet(): void;\n}\nclass Impl implements Greeter {\n  other() {}\n}\n",
        );
        let greeter_greet_id = file_summary.interfaces[0].members[0].entity_id.clone();
        let impl_id = file_summary.classes[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.members(&impl_id, "greet", false),
            MemberLookup::One(greeter_greet_id)
        );
    }

    /// E-P0k (2026-09-08): found live against the VS Code corpus --
    /// `MarkersTree extends WorkbenchObjectTree<...> implements
    /// IProblemsWidget` resolved `getSelection`/`getHTMLElement` to
    /// `IProblemsWidget`'s own method SIGNATURE, not the real
    /// implementation several `extends` hops up an untracked chain
    /// (`WorkbenchObjectTree`'s own further heritage was never fully
    /// resolvable by this crate). This fixture reproduces the SAME shape
    /// minimally: `Sub`'s `extends UnknownBase` names an identifier this
    /// crate cannot resolve to any known container at all (never declared,
    /// never imported) -- `has_unresolved_extends` must be `true` for
    /// `Sub`, and `members` must refuse to guess via `implements` (`None`,
    /// never `IFace`'s own member signature).
    #[test]
    fn members_never_guesses_implements_when_the_extends_chain_is_unresolved() {
        let file_summary = summary_for(
            "a.ts",
            "interface IFace {\n  run(): void;\n}\nclass Sub extends UnknownBase implements IFace {\n  other() {}\n}\n",
        );
        let sub_id = file_summary.classes[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.members(&sub_id, "run", false),
            MemberLookup::None,
            "must never guess IFace's own signature when Sub's real extends \
             chain (UnknownBase) could not be resolved at all"
        );
    }

    /// E-P0k companion: the SAME shape, but `Sub`'s own extends chain IS
    /// fully resolvable and genuinely empty of the member -- `Base` (no
    /// heritage of its own) confidently declares no `run` anywhere in its
    /// chain, so falling through to `IFace`'s own signature is the
    /// legitimate, pre-existing behavior `members_falls_back_to_implements_
    /// when_own_chain_misses` already covers for a DIRECT `implements`
    /// (no `extends` at all); this variant proves the same soundness holds
    /// when there IS a resolvable `extends` in between.
    #[test]
    fn members_still_falls_back_to_implements_when_the_extends_chain_is_fully_resolved_and_empty() {
        let file_summary = summary_for(
            "a.ts",
            "class Base {\n  other2() {}\n}\ninterface IFace {\n  run(): void;\n}\nclass Sub extends Base implements IFace {\n  other() {}\n}\n",
        );
        let iface_run_id = file_summary.interfaces[0].members[0].entity_id.clone();
        let sub_id = file_summary.classes[1].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.members(&sub_id, "run", false),
            MemberLookup::One(iface_run_id)
        );
    }

    /// E-P0k (2026-09-08): found live against the VS Code corpus --
    /// `abstract class WorkbenchLayoutStateKey implements
    /// IWorkbenchLayoutStateKey` (the interface declares `zenModeIgnore`;
    /// the abstract base never declares its own) with a KNOWN subclass,
    /// `RuntimeStateKey`, that DOES declare its own `zenModeIgnore`
    /// (a constructor parameter property) -- resolving a `WorkbenchLayout
    /// StateKey`-typed receiver's `.zenModeIgnore` must never confidently
    /// pick the interface's own signature over the subclass's real
    /// override: this crate does no control-flow narrowing, so the
    /// receiver's actual runtime type could legitimately be the subclass.
    /// Companion to `members_still_falls_back_to_implements_when_the_
    /// extends_chain_is_fully_resolved_and_empty`, which proves the
    /// implements fallback STAYS legitimate when no such subclass exists.
    #[test]
    fn members_never_guesses_implements_when_a_known_subclass_overrides_the_same_member() {
        let file_summary = summary_for(
            "a.ts",
            "interface IFace {\n  run(): void;\n}\nabstract class Base implements IFace {\n  other() {}\n}\nclass Sub extends Base {\n  run(): void {}\n}\n",
        );
        let base_id = file_summary.classes[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.members(&base_id, "run", false),
            MemberLookup::None,
            "must never guess IFace's own signature when Sub's own \
             override of `run` exists -- the receiver's real runtime type \
             might be Sub, not Base"
        );
    }

    #[test]
    fn subclass_override_walk_is_extends_only_and_depth_bounded() {
        let mut source = String::from(
            "interface Root {\n  marker(): void;\n}\nclass ImplementsOnly implements Root {\n  marker(): void {}\n}\n",
        );
        for i in 0..34 {
            let base = if i == 0 {
                "Root".to_owned()
            } else {
                format!("Chain{}", i - 1)
            };
            let member = if i == 32 { "  marker(): void;\n" } else { "" };
            source.push_str(&format!(
                "interface Chain{i} extends {base} {{\n{member}}}\n"
            ));
        }
        let summary = summary_for("depth.ts", &source);
        let root_id = summary.interfaces[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("depth.ts".to_owned(), summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());

        assert!(!index.has_known_subclass_override(&root_id, "marker", false));

        let mut shallow_source = String::from("interface Root {\n  marker(): void;\n}\n");
        for i in 0..32 {
            let base = if i == 0 {
                "Root".to_owned()
            } else {
                format!("Chain{}", i - 1)
            };
            let member = if i == 31 { "  marker(): void;\n" } else { "" };
            shallow_source.push_str(&format!(
                "interface Chain{i} extends {base} {{\n{member}}}\n"
            ));
        }
        let shallow_summary = summary_for("shallow.ts", &shallow_source);
        let shallow_root = shallow_summary.interfaces[0].entity_id.clone();
        let mut shallow_summaries = BTreeMap::new();
        shallow_summaries.insert("shallow.ts".to_owned(), shallow_summary);
        let shallow_index =
            ProgramIndex::build(&shallow_summaries, &HashMap::new(), &HashMap::new());
        assert!(shallow_index.has_known_subclass_override(&shallow_root, "marker", false));
    }

    #[test]
    fn members_fast_path_preserves_own_ambiguity_and_inherited_misses() {
        let summary = summary_for(
            "members.ts",
            "class Base { inherited(): void {} }\nclass Own { value(): void {} value(x: string): void {} }\nclass Derived extends Base {}\n",
        );
        let own_id = summary.classes[1].entity_id.clone();
        let derived_id = summary.classes[2].entity_id.clone();
        let own_members = summary.classes[1].members.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("members.ts".to_owned(), summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.members(&own_id, "value", false),
            MemberLookup::Many(
                own_members
                    .iter()
                    .map(|member| member.entity_id.clone())
                    .collect(),
            )
        );
        assert_eq!(
            index.members(&derived_id, "missing", false),
            MemberLookup::None
        );
        assert_eq!(
            index.members(&derived_id, "inherited", false),
            MemberLookup::One(
                index
                    .containers
                    .values()
                    .find_map(|container| container
                        .members
                        .iter()
                        .find(|member| member.name == "inherited"))
                    .expect("inherited member")
                    .entity_id
                    .clone(),
            )
        );
    }

    /// E-P0q (2026-09-09, `docs/evidence/2026-09-07-v4-vscode-campaign.md`
    /// §16.4 pattern 1): `sibling_conformance_overrides` finds an
    /// `implements` conformer's own redeclaration -- `sibling_extends_
    /// overrides` itself (`extends`-only) would find NOTHING here, since
    /// `Action` reaches `IAction` through `implements`, never `extends`.
    #[test]
    fn sibling_conformance_overrides_finds_an_implements_conformer_that_redeclares_the_same_member()
    {
        let file_summary = summary_for(
            "a.ts",
            "interface IAction {\n  run(): void;\n}\nclass Action implements IAction {\n  run(): void {}\n}\n",
        );
        assert_eq!(file_summary.interfaces.len(), 1, "{file_summary:?}");
        assert_eq!(file_summary.classes.len(), 1, "{file_summary:?}");
        let iaction_id = file_summary.interfaces[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        let candidates = index.sibling_conformance_overrides(&iaction_id, "run", false);
        assert_eq!(
            candidates.len(),
            1,
            "Action's own `run` override must be the sole candidate: {candidates:?}"
        );
        assert!(
            index
                .sibling_extends_overrides(&iaction_id, "run", false)
                .is_empty(),
            "the OLD extends-only function must stay untouched -- Action \
             reaches IAction only through implements, never extends"
        );
    }

    /// E-P0q: `sibling_extends_overrides` (still `extends`-only, used by
    /// `has_known_subclass_override`'s own "real subclassing, not interface
    /// conformance" restriction) must remain UNCHANGED by this task's own
    /// `implements`-inclusive generalization -- a pure `implements` sibling
    /// must never appear in its result.
    #[test]
    fn sibling_extends_overrides_stays_implements_blind_after_the_conformance_generalization() {
        let file_summary = summary_for(
            "a.ts",
            "interface IAction {\n  run(): void;\n}\nclass Action implements IAction {\n  run(): void {}\n}\nclass RealSub extends Action {\n  run(): void {}\n}\n",
        );
        let action_id = file_summary.classes[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        // `Action` has a REAL `extends` descendant (`RealSub`) -- must still
        // be found by the old function.
        assert_eq!(
            index
                .sibling_extends_overrides(&action_id, "run", false)
                .len(),
            1
        );
        let iaction_id = file_summary_interfaces_len_one_id(&index, "a.ts");
        // `Action` itself is only reached from `IAction` through
        // `implements` -- the OLD function must see nothing there.
        assert!(
            index
                .sibling_extends_overrides(&iaction_id, "run", false)
                .is_empty()
        );
    }

    /// Independent oracle for the pre-index implementation. Keeping this in
    /// the test module makes the reverse-edge traversal testable without
    /// simply asserting that the new implementation agrees with itself.
    fn sibling_conformance_oracle(
        index: &ProgramIndex,
        entity_id: &str,
        name: &str,
        is_static: bool,
    ) -> Vec<String> {
        fn reaches(index: &ProgramIndex, start_id: &str, target_id: &str) -> bool {
            const MAX_DEPTH: usize = 32;
            let mut visited = HashSet::new();
            let mut stack = vec![start_id.to_owned()];
            while let Some(current) = stack.pop() {
                if visited.len() >= MAX_DEPTH || !visited.insert(current.clone()) {
                    continue;
                }
                let Some(container) = index.containers.get(&current) else {
                    continue;
                };
                for base in container.extends.iter().chain(container.implements.iter()) {
                    if base == target_id {
                        return true;
                    }
                    stack.push(base.clone());
                }
            }
            false
        }

        let mut ids = Vec::new();
        for (other_id, other_container) in &index.containers {
            if other_id == entity_id || !reaches(index, other_id, entity_id) {
                continue;
            }
            let effective_static = is_static && !other_container.is_interface;
            ids.extend(
                other_container
                    .members
                    .iter()
                    .filter(|member| member.name == name && member.is_static == effective_static)
                    .map(|member| member.entity_id.clone()),
            );
        }
        ids.sort();
        ids.dedup();
        ids
    }

    #[test]
    fn sibling_conformance_reverse_index_matches_the_old_oracle() {
        let file_summary = summary_for(
            "a.ts",
            "interface Root {\n  run(): void;\n}\ninterface Mid extends Root {\n  run(): void;\n}\nclass Impl implements Root {\n  run(): void {}\n}\nclass Deep extends Mid {\n  run(): void {}\n}\nclass StaticBase {\n  static make(): void {}\n}\nclass StaticChild extends StaticBase {\n  static make(): void {}\n}\n",
        );
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());

        let container_ids: Vec<String> = index.containers.keys().cloned().collect();
        for entity_id in container_ids {
            for name in ["run", "make", "missing"] {
                for is_static in [false, true] {
                    assert_eq!(
                        index.sibling_conformance_overrides(&entity_id, name, is_static),
                        sibling_conformance_oracle(&index, &entity_id, name, is_static),
                        "reverse index diverged for entity={entity_id}, name={name}, static={is_static}"
                    );
                }
            }
        }
    }

    #[test]
    fn sibling_conformance_reverse_index_handles_cycles_and_wide_conformance() {
        let mut source = String::from(
            "interface Root {\n  run(): void;\n}\ninterface CycleA extends CycleB {\n  run(): void;\n}\ninterface CycleB extends CycleA {\n  run(): void;\n}\n",
        );
        for i in 0..40 {
            source.push_str(&format!(
                "class Impl{i} implements Root {{\n  run(): void {{}}\n}}\n"
            ));
        }
        let file_summary = summary_for("wide.ts", &source);
        let root_id = file_summary.interfaces[0].entity_id.clone();
        let cycle_a_id = file_summary.interfaces[1].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("wide.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());

        let wide = index.sibling_conformance_overrides(&root_id, "run", false);
        assert_eq!(wide.len(), 40);
        assert_eq!(
            wide,
            sibling_conformance_oracle(&index, &root_id, "run", false)
        );
        assert_eq!(
            index.sibling_conformance_overrides(&cycle_a_id, "run", false),
            sibling_conformance_oracle(&index, &cycle_a_id, "run", false)
        );
    }

    #[test]
    fn sibling_conformance_reverse_index_preserves_depth_cutoff() {
        let mut source = String::from("interface Root {\n  run(): void;\n}\n");
        for i in 0..34 {
            let base = if i == 0 {
                "Root".to_owned()
            } else {
                format!("Chain{}", i - 1)
            };
            source.push_str(&format!(
                "interface Chain{i} extends {base} {{\n  run(): void;\n}}\n"
            ));
        }
        let file_summary = summary_for("depth.ts", &source);
        let root_id = file_summary.interfaces[0].entity_id.clone();
        let depth_32_member = file_summary.interfaces[32].members[0].entity_id.clone();
        let depth_33_member = file_summary.interfaces[33].members[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("depth.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        let indexed = index.sibling_conformance_overrides(&root_id, "run", false);
        assert_eq!(indexed.len(), 32);
        assert!(indexed.contains(&depth_32_member));
        assert!(!indexed.contains(&depth_33_member));
    }

    #[test]
    fn sibling_conformance_reverse_index_keeps_a_short_diamond_path() {
        let mut source =
            String::from("interface Root {\n  run(): void;\n}\ninterface Short extends Root {}\n");
        for i in 0..31 {
            let base = if i == 0 {
                "Short".to_owned()
            } else {
                format!("Long{}", i - 1)
            };
            source.push_str(&format!("interface Long{i} extends {base} {{}}\n"));
        }
        source.push_str("interface Join extends Long30, Short {\n  run(): void;\n}\n");
        let file_summary = summary_for("diamond.ts", &source);
        let root_id = file_summary.interfaces[0].entity_id.clone();
        let join_member = file_summary.interfaces.last().unwrap().members[0]
            .entity_id
            .clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("diamond.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());

        let indexed = index.sibling_conformance_overrides(&root_id, "run", false);
        assert!(
            indexed.contains(&join_member),
            "the short depth-2 path must preserve Join even if the depth-33 path is visited first"
        );
    }

    #[test]
    fn sibling_conformance_reverse_index_indexes_call_member_after_pass2_and_replace() {
        let source_v1 = "class Base {\n  run(): void {}\n}\nclass Other {\n  run(): void {}\n}\nclass Z {\n  class(): Base { return new Base(); }\n}\nclass Derived extends Z.class({}) {\n  run(): void {}\n}\n";
        let source_v2 = source_v1.replace("class(): Base", "class(): Other");
        let summary_v1 = summary_for("mixin.ts", source_v1);
        let summary_v2 = summary_for("mixin.ts", &source_v2);
        let base_id = summary_v1.classes[0].entity_id.clone();
        let other_id = summary_v2.classes[1].entity_id.clone();
        let derived_id_v1 = summary_v1.classes[3].entity_id.clone();
        let derived_id_v2 = summary_v2.classes[3].entity_id.clone();
        let derived_member_v1 = summary_v1.classes[3].members[0].entity_id.clone();
        let derived_member_v2 = summary_v2.classes[3].members[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("mixin.ts".to_owned(), summary_v1);
        let mut index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());

        assert_eq!(
            index.containers[&derived_id_v1].extends,
            vec![base_id.clone()],
            "cold pass 2 must resolve Z.class() to Base"
        );
        assert_eq!(
            index.sibling_conformance_overrides(&base_id, "run", false),
            vec![derived_member_v1]
        );

        let mut changed_summaries = BTreeMap::new();
        changed_summaries.insert("mixin.ts".to_owned(), summary_v2.clone());
        index.replace_file("mixin.ts", summary_v2, &HashMap::new(), &HashMap::new());
        let fresh = ProgramIndex::build(&changed_summaries, &HashMap::new(), &HashMap::new());
        assert_index_equal(&index, &fresh, "CallMember replace");
        assert_eq!(
            index.containers[&derived_id_v2].extends,
            vec![other_id.clone()],
            "incremental pass 2 must update the resolved CallMember target"
        );
        assert!(
            index
                .sibling_conformance_overrides(&other_id, "run", false)
                .contains(&derived_member_v2)
        );
        assert!(
            index
                .sibling_conformance_overrides(&base_id, "run", false)
                .is_empty()
        );
    }

    #[test]
    fn sibling_conformance_reverse_index_tracks_extends_to_implements_incrementally() {
        let source_v1 = "interface Root {\n  run(): void;\n}\nclass Base {\n  run(): void {}\n}\nclass Child extends Base {\n  run(): void {}\n}\n";
        let source_v2 = "interface Root {\n  run(): void;\n}\nclass Base {\n  run(): void {}\n}\nclass Child implements Root {\n  run(): void {}\n}\n";
        let summary_v1 = summary_for("heritage.ts", source_v1);
        let summary_v2 = summary_for("heritage.ts", source_v2);
        let root_id = summary_v1.interfaces[0].entity_id.clone();
        let base_id = summary_v1.classes[0].entity_id.clone();
        let child_id = summary_v1.classes[1].entity_id.clone();
        let child_member_v1 = summary_v1.classes[1].members[0].entity_id.clone();
        let child_member_v2 = summary_v2.classes[1].members[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("heritage.ts".to_owned(), summary_v1);
        let mut index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.sibling_conformance_overrides(&base_id, "run", false),
            vec![child_member_v1]
        );

        let mut changed_summaries = BTreeMap::new();
        changed_summaries.insert("heritage.ts".to_owned(), summary_v2.clone());
        index.replace_file("heritage.ts", summary_v2, &HashMap::new(), &HashMap::new());
        let fresh = ProgramIndex::build(&changed_summaries, &HashMap::new(), &HashMap::new());
        assert_index_equal(&index, &fresh, "extends-to-implements replace");
        assert!(
            index
                .sibling_conformance_overrides(&base_id, "run", false)
                .is_empty()
        );
        assert_eq!(
            index.sibling_conformance_overrides(&root_id, "run", false),
            vec![child_member_v2]
        );
        assert_eq!(index.containers[&child_id].extends, Vec::<String>::new());
        assert_eq!(index.containers[&child_id].implements, vec![root_id]);
    }

    #[test]
    fn sibling_conformance_reverse_index_stays_equal_after_incremental_replace_and_remove() {
        let base_source = "interface Root {\n  run(): void;\n}\n";
        let child_source = "class Child implements Root {\n  run(): void {}\n}\n";
        let changed_child_source = "class Child {\n  run(): void {}\n}\n";
        let mut summaries = BTreeMap::new();
        summaries.insert("base.ts".to_owned(), summary_for("base.ts", base_source));
        summaries.insert("child.ts".to_owned(), summary_for("child.ts", child_source));
        let mut index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        let root_id = summaries["base.ts"].interfaces[0].entity_id.clone();

        let mut changed_summaries = summaries.clone();
        changed_summaries.insert(
            "child.ts".to_owned(),
            summary_for("child.ts", changed_child_source),
        );
        index.replace_file(
            "child.ts",
            changed_summaries["child.ts"].clone(),
            &HashMap::new(),
            &HashMap::new(),
        );
        let fresh_after_replace =
            ProgramIndex::build(&changed_summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.sibling_conformance_overrides(&root_id, "run", false),
            fresh_after_replace.sibling_conformance_overrides(&root_id, "run", false)
        );

        index.remove_file("child.ts");
        changed_summaries.remove("child.ts");
        let fresh_after_remove =
            ProgramIndex::build(&changed_summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.sibling_conformance_overrides(&root_id, "run", false),
            fresh_after_remove.sibling_conformance_overrides(&root_id, "run", false)
        );
    }

    /// Test-only helper for `sibling_extends_overrides_stays_implements_
    /// blind_after_the_conformance_generalization` -- `ProgramIndex` does
    /// not expose its own interned interface ids by name, only by walking
    /// `containers` directly (test-only; production code never needs this).
    fn file_summary_interfaces_len_one_id(index: &ProgramIndex, path: &str) -> String {
        index
            .containers
            .keys()
            .find(|id| id.starts_with(&format!("jsts:interface:{path}:")))
            .cloned()
            .expect("exactly one interface container expected in this fixture")
    }

    /// E-P0q (2026-09-09): the position-patching half of decision 28's
    /// pattern-3 closure -- `summarize_function`'s own `patch_predicate_
    /// parameter_position` finds `x`'s zero-based index (0) and `Program
    /// Index::function_predicate_parameter_narrowing` surfaces it alongside
    /// the predicate's own resolved target.
    #[test]
    fn function_predicate_parameter_narrowing_resolves_a_standalone_functions_own_param_is_t_predicate()
     {
        let file_summary = summary_for(
            "a.ts",
            "class Base {}\nclass Sub extends Base {}\nfunction isSub(x: Base): x is Sub {\n  return x instanceof Sub;\n}\n",
        );
        assert_eq!(file_summary.functions.len(), 1, "{file_summary:?}");
        let is_sub_id = file_summary.functions[0].entity_id.clone();
        let sub_id = file_summary.classes[1].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.function_predicate_parameter_narrowing(&is_sub_id),
            Some((0, sub_id))
        );
    }

    /// E-P0q: the predicate's own named parameter need not be the FIRST
    /// one -- `patch_predicate_parameter_position` must find its REAL
    /// position, never assume 0.
    #[test]
    fn function_predicate_parameter_narrowing_finds_the_non_first_parameters_own_position() {
        let file_summary = summary_for(
            "a.ts",
            "class Base {}\nclass Sub extends Base {}\nfunction isSub(label: string, x: Base): x is Sub {\n  return x instanceof Sub;\n}\n",
        );
        let is_sub_id = file_summary.functions[0].entity_id.clone();
        let sub_id = file_summary.classes[1].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.function_predicate_parameter_narrowing(&is_sub_id),
            Some((1, sub_id)),
            "the predicate's own parameter is the SECOND one -- position \
             must be 1, never guessed as 0"
        );
    }

    /// E-P0q safety companion: a `this is T` predicate's own `subject` is
    /// `PredicateSubject::Receiver`, never `Parameter` -- `function_
    /// predicate_parameter_narrowing` must refuse it (that shape is
    /// `member_predicate_receiver_narrowing`'s own job, and only for a
    /// MEMBER, never a standalone function in the first place -- this
    /// guards against a future refactor accidentally conflating the two).
    #[test]
    fn function_predicate_parameter_narrowing_is_none_for_a_this_is_t_shaped_return_type() {
        let file_summary = summary_for(
            "a.ts",
            "class Base {}\nclass Sub extends Base {}\nfunction isSub(this: Base): this is Sub {\n  return this instanceof Sub;\n}\n",
        );
        let is_sub_id = file_summary.functions[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.function_predicate_parameter_narrowing(&is_sub_id),
            None
        );
    }

    #[test]
    fn members_is_none_for_unknown_container() {
        let index = ProgramIndex::build(&BTreeMap::new(), &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.members("jsts:class:missing.ts:0:X", "y", false),
            MemberLookup::None
        );
        assert!(!index.is_container("jsts:class:missing.ts:0:X"));
    }

    // P2-2j: union receiver support.

    #[test]
    fn union_type_annotation_parses_dedupes_and_collapses() {
        let source = "class A {}\nclass B {}\nconst two: A | B = null as any;\nconst dup: A | A = null as any;\nconst nullable: A | null = null as any;\n";
        let summary = summary(source);
        assert_eq!(summary.classes.len(), 2);
        let a_id = summary.classes[0].entity_id.clone();
        let b_id = summary.classes[1].entity_id.clone();
        assert_eq!(summary.variables.len(), 3, "{summary:?}");
        assert_eq!(
            summary.variables[0].type_ref,
            RawTypeRef::Union(vec![
                RawTypeRef::Local(a_id.clone()),
                RawTypeRef::Local(b_id.clone())
            ]),
            "`A | B` should classify as a genuine two-constituent union"
        );
        assert_eq!(
            summary.variables[1].type_ref,
            RawTypeRef::Local(a_id.clone()),
            "`A | A` must dedupe and collapse to the single constituent, never a \
             one-element Union"
        );
        assert_eq!(
            summary.variables[2].type_ref,
            RawTypeRef::Local(a_id),
            "`A | null` must drop the null constituent and collapse to `A`"
        );
    }

    #[test]
    fn union_with_unclassifiable_constituent_contaminates_to_unknown() {
        // A tuple type is one of this crate's own unclassified shapes
        // (falls straight to `raw_type_ref_of_ts_type`'s own `_ => Unknown`
        // arm, no wrapper) -- the union as a whole must NOT partially guess
        // from the classifiable `A` branch.
        let source = "class A {}\nconst mixed: A | [number, string] = null as any;\n";
        let summary = summary(source);
        assert_eq!(summary.variables.len(), 1, "{summary:?}");
        assert_eq!(summary.variables[0].type_ref, RawTypeRef::Unknown);
    }

    #[test]
    fn members_of_union_promotes_a_shared_inherited_member_to_one() {
        // 2026-09-05 A5 references-parity task, Paso 1 fix point 5: `A` and
        // `B` share `run` only through their common base `Base` -- both
        // branches resolve to the exact SAME member id, so this is now
        // promoted to `One` (proven safe -- see `members_of_union`'s own
        // doc comment): calling/reading `run` on an `A | B` receiver is
        // correct no matter which constituent the runtime value actually
        // is, since both paths lead to the identical `Base::run`
        // declaration.
        let file_summary = summary_for(
            "a.ts",
            "class Base {\n  run() {}\n}\nclass A extends Base {}\nclass B extends Base {}\n",
        );
        let base_run_id = file_summary.classes[0].members[0].entity_id.clone();
        let a_id = file_summary.classes[1].entity_id.clone();
        let b_id = file_summary.classes[2].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.members_of_union(&[a_id, b_id], "run", false),
            MemberLookup::One(base_run_id)
        );
    }

    #[test]
    fn members_of_union_stays_candidates_for_two_genuinely_different_declarations() {
        // Negative sibling of `members_of_union_promotes_a_shared_
        // inherited_member_to_one`: `A` and `B` are UNRELATED classes, each
        // with its OWN separately-declared `run` -- two distinct entity
        // ids, so the pooled/deduped set has size 2 and must stay
        // `UnionCandidates`, never a guess at which declaration answers it.
        let file_summary = summary_for(
            "a.ts",
            "class A {\n  run() {}\n}\nclass B {\n  run() {}\n}\n",
        );
        let a_run_id = file_summary.classes[0].members[0].entity_id.clone();
        let b_run_id = file_summary.classes[1].members[0].entity_id.clone();
        let a_id = file_summary.classes[0].entity_id.clone();
        let b_id = file_summary.classes[1].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        let MemberLookup::UnionCandidates(mut candidates) =
            index.members_of_union(&[a_id, b_id], "run", false)
        else {
            panic!("expected UnionCandidates");
        };
        candidates.sort();
        let mut expected = vec![a_run_id, b_run_id];
        expected.sort();
        assert_eq!(candidates, expected);
    }

    #[test]
    fn members_of_union_is_none_when_one_constituent_lacks_the_member() {
        let file_summary = summary_for("a.ts", "class A {\n  run() {}\n}\nclass B {}\n");
        let a_id = file_summary.classes[0].entity_id.clone();
        let b_id = file_summary.classes[1].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.members_of_union(&[a_id, b_id], "run", false),
            MemberLookup::None
        );
    }

    fn summary_for(path: &str, source: &str) -> DeclSummary {
        extract_decl_summary(path, source).expect("parses")
    }

    #[test]
    fn member_type_ref_resolves_through_an_inline_type_literal() {
        // Found live in this corpus's own migration DSL:
        // `interface MigrationContext { escape: { columnName(name: string):
        // string; }; }` -- `escape`'s own type is an ANONYMOUS `{ ... }`
        // object type, not a named interface.
        let file_summary = summary_for(
            "a.ts",
            "interface MigrationContext {\n  escape: {\n    columnName(name: string): string;\n  };\n}\n",
        );
        // The synthetic type-literal container is pushed FIRST (while
        // `MigrationContext`'s own members are still being computed),
        // `MigrationContext` itself second.
        assert_eq!(file_summary.interfaces.len(), 2, "{file_summary:?}");
        let literal_id = file_summary.interfaces[0].entity_id.clone();
        let context_id = file_summary.interfaces[1].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.member_type_ref(&context_id, "escape", false),
            Some(ResolvedTypeRef::Entity(literal_id.clone()))
        );
        assert!(index.is_container(&literal_id));
        assert!(matches!(
            index.members(&literal_id, "columnName", false),
            MemberLookup::One(_)
        ));
    }

    #[test]
    fn object_shape_member_resolves_a_functions_own_return_type() {
        // The `Z.class({...})` mixin pattern found live in this corpus's
        // `zod-class.ts`: an object literal whose property is an arrow
        // function returning an interface.
        let file_summary = summary_for(
            "a.ts",
            "interface ZodClass {\n  safeParse(): void;\n}\nconst Z = {\n  class: (): ZodClass => ({}) as ZodClass,\n};\n",
        );
        let zod_class_id = file_summary.interfaces[0].entity_id.clone();
        assert_eq!(file_summary.object_shapes.len(), 1);
        let z_id = file_summary.object_shapes[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert!(index.is_container(&z_id));
        assert_eq!(
            index.member_type_ref(&z_id, "class", false),
            Some(ResolvedTypeRef::Entity(zod_class_id))
        );
    }

    #[test]
    fn member_type_ref_resolves_this_return_type() {
        let file_summary = summary_for(
            "a.ts",
            "class Tool {\n  description(x: string): this { return this; }\n}\n",
        );
        let tool_id = file_summary.classes[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.member_type_ref(&tool_id, "description", false),
            Some(ResolvedTypeRef::ThisType)
        );
    }

    #[test]
    fn member_type_ref_resolves_array_of_local_class() {
        let file_summary =
            summary_for("a.ts", "class Box {}\nclass Holder {\n  items: Box[];\n}\n");
        let box_id = file_summary.classes[0].entity_id.clone();
        let holder_id = file_summary.classes[1].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.member_type_ref(&holder_id, "items", false),
            Some(ResolvedTypeRef::ArrayOf(Box::new(ResolvedTypeRef::Entity(
                box_id
            ))))
        );
    }

    #[test]
    fn member_type_ref_falls_back_through_extends_chain() {
        let file_summary = summary_for(
            "a.ts",
            "class Result {}\nclass Base {\n  build(): Result { return new Result(); }\n}\nclass Derived extends Base {}\n",
        );
        let result_id = file_summary.classes[0].entity_id.clone();
        let derived_id = file_summary.classes[2].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.member_type_ref(&derived_id, "build", false),
            Some(ResolvedTypeRef::Entity(result_id))
        );
    }

    /// The exact n8n shape that produced a wrong `core:references` target
    /// before parameter properties were enumerated as members (2026-09-04
    /// references-parity task): a class `implements` an interface that
    /// ALSO declares a same-named member. Before this fix, `A`'s own
    /// `container.members` never contained `defaultConfig` at all (the
    /// parameter property was invisible to `member_entry_of_class_element`),
    /// so `collect_members`'s own-body check found nothing and fell through
    /// to the `implements` fallback, wrongly resolving to `I`'s member.
    /// `collect_members` itself needed NO change for this fix -- it already
    /// returns as soon as the container's own `members` list has a hit; the
    /// bug was purely a missing enumeration.
    #[test]
    fn members_resolves_own_parameter_property_over_implemented_interface_same_named_member() {
        let file_summary = summary_for(
            "a.ts",
            "interface I<T> {\n  defaultConfig: T;\n}\nclass A implements I<string> {\n  constructor(public defaultConfig?: string) {}\n  m() { return this.defaultConfig; }\n}\n",
        );
        let interface_member_id = file_summary.interfaces[0].members[0].entity_id.clone();
        let class_id = file_summary.classes[0].entity_id.clone();
        let own_member_id = file_summary.classes[0]
            .members
            .iter()
            .find(|member| member.name == "defaultConfig")
            .expect("the parameter property is indexed as A's own member")
            .entity_id
            .clone();
        assert_ne!(
            own_member_id, interface_member_id,
            "fixture sanity: the class's own member and the interface's member \
             must be genuinely different declarations"
        );
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.members(&class_id, "defaultConfig", false),
            MemberLookup::One(own_member_id)
        );
    }

    #[test]
    fn function_return_type_resolves_local_class() {
        let file_summary = summary_for(
            "a.ts",
            "class Foo {}\nexport function make(): Foo {\n  return new Foo();\n}\n",
        );
        let foo_id = file_summary.classes[0].entity_id.clone();
        let make_id = file_summary.functions[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.function_return_type(&make_id),
            Some(ResolvedTypeRef::Entity(foo_id))
        );
    }

    #[test]
    fn function_return_type_resolves_promise_of_local_class() {
        let file_summary = summary_for(
            "a.ts",
            "class Foo {}\nexport async function load(): Promise<Foo> {\n  return new Foo();\n}\n",
        );
        let foo_id = file_summary.classes[0].entity_id.clone();
        let load_id = file_summary.functions[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.function_return_type(&load_id),
            Some(ResolvedTypeRef::PromiseOf(Box::new(
                ResolvedTypeRef::Entity(foo_id)
            )))
        );
    }

    #[test]
    fn function_return_type_resolves_imported_class() {
        let base_summary = summary_for("base.ts", "export class Foo {}\n");
        let user_summary = summary_for(
            "user.ts",
            "import { Foo } from \"./base\";\nexport function make(): Foo {\n  return new Foo();\n}\n",
        );
        let foo_id = base_summary.classes[0].entity_id.clone();
        let make_id = user_summary.functions[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("base.ts".to_owned(), base_summary);
        summaries.insert("user.ts".to_owned(), user_summary);
        let mut import_targets = HashMap::new();
        import_targets.insert(
            ("user.ts".to_owned(), "./base".to_owned(), "Foo".to_owned()),
            foo_id.clone(),
        );
        let index = ProgramIndex::build(&summaries, &import_targets, &HashMap::new());
        assert_eq!(
            index.function_return_type(&make_id),
            Some(ResolvedTypeRef::Entity(foo_id))
        );
    }

    // P1-B: shallow return-type inference fixed point.

    /// E-P0q (2026-09-09): an EXPLICIT return annotation this crate cannot
    /// classify (a qualified `ns.Type`) must still WIN over the body -- no
    /// P1-B inference may run behind a written type. Found live:
    /// `TextModel.createSnapshot(): model.ITextSnapshot { return new
    /// TextModelSnapshot(...) }` was inferred to the concrete class, so
    /// `snapshot.read()` confirmed `TextModelSnapshot.read` where v3 (and
    /// TypeScript) say `ITextSnapshot.read`.
    #[test]
    fn annotated_but_unclassifiable_return_type_never_falls_back_to_body_inference() {
        let file_summary = summary_for(
            "a.ts",
            "import * as model from './model';\nclass Foo {}\nexport function make(): model.IFoo {\n  return new Foo();\n}\nclass Host {\n  make(): model.IFoo {\n    return new Foo();\n  }\n}\n",
        );
        assert!(
            file_summary.functions[0].pending_return.is_none(),
            "a written (even unclassifiable) annotation disables body inference"
        );
        assert!(file_summary.classes[1].members[0].pending_return.is_none());
        let make_id = file_summary.functions[0].entity_id.clone();
        let host_id = file_summary.classes[1].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(index.function_return_type(&make_id), None);
        assert_eq!(index.member_type_ref(&host_id, "make", false), None);
    }

    #[test]
    fn infers_unannotated_function_return_from_new_expression() {
        let file_summary = summary_for(
            "a.ts",
            "class Foo {}\nexport function make() {\n  return new Foo();\n}\n",
        );
        let foo_id = file_summary.classes[0].entity_id.clone();
        let make_id = file_summary.functions[0].entity_id.clone();
        assert!(file_summary.functions[0].pending_return.is_some());
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.function_return_type(&make_id),
            Some(ResolvedTypeRef::Entity(foo_id))
        );
    }

    #[test]
    fn infers_async_unannotated_function_return_wraps_in_promise() {
        let file_summary = summary_for(
            "a.ts",
            "class Foo {}\nexport async function make() {\n  return new Foo();\n}\n",
        );
        let foo_id = file_summary.classes[0].entity_id.clone();
        let make_id = file_summary.functions[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.function_return_type(&make_id),
            Some(ResolvedTypeRef::PromiseOf(Box::new(
                ResolvedTypeRef::Entity(foo_id)
            )))
        );
    }

    #[test]
    fn infers_unannotated_method_return_from_this_delegation() {
        // `resume()` delegates to `generate()`, an UNANNOTATED sibling
        // method whose own return type is ALSO unannotated but resolvable
        // (`new Result()`) -- the fixed point must resolve `generate`
        // first, then `resume` on a later iteration.
        let file_summary = summary_for(
            "a.ts",
            "class Result {}\nclass Agent {\n  resume() {\n    return this.generate();\n  }\n  generate() {\n    return new Result();\n  }\n}\n",
        );
        let result_id = file_summary.classes[0].entity_id.clone();
        let agent_id = file_summary.classes[1].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.member_type_ref(&agent_id, "resume", false),
            Some(ResolvedTypeRef::Entity(result_id.clone()))
        );
        assert_eq!(
            index.member_type_ref(&agent_id, "generate", false),
            Some(ResolvedTypeRef::Entity(result_id))
        );
    }

    #[test]
    fn infers_unannotated_method_return_of_this_as_polymorphic_this() {
        let file_summary = summary_for(
            "a.ts",
            "class Tool {\n  describe(x) {\n    return this;\n  }\n}\n",
        );
        let tool_id = file_summary.classes[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.member_type_ref(&tool_id, "describe", false),
            Some(ResolvedTypeRef::ThisType)
        );
    }

    #[test]
    fn infers_unannotated_function_calling_another_unannotated_function() {
        // Cross-function fixed point: `wrap` depends on `make`'s OWN
        // inferred (not annotated) return type, declared AFTER `wrap` in
        // file order.
        let file_summary = summary_for(
            "a.ts",
            "class Foo {}\nexport function wrap() {\n  return make();\n}\nexport function make() {\n  return new Foo();\n}\n",
        );
        let foo_id = file_summary.classes[0].entity_id.clone();
        let wrap_id = file_summary.functions[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.function_return_type(&wrap_id),
            Some(ResolvedTypeRef::Entity(foo_id))
        );
    }

    #[test]
    fn infers_unannotated_function_return_through_await() {
        let file_summary = summary_for(
            "a.ts",
            "class Foo {}\nasync function load() {\n  return new Foo();\n}\nexport async function make() {\n  return await load();\n}\n",
        );
        let foo_id = file_summary.classes[0].entity_id.clone();
        let make_id = file_summary.functions[1].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.function_return_type(&make_id),
            Some(ResolvedTypeRef::PromiseOf(Box::new(
                ResolvedTypeRef::Entity(foo_id)
            )))
        );
    }

    #[test]
    fn conflicting_unannotated_returns_stay_unknown_never_a_guess() {
        let file_summary = summary_for(
            "a.ts",
            "class Foo {}\nclass Bar {}\nexport function make(flag) {\n  if (flag) {\n    return new Foo();\n  }\n  return new Bar();\n}\n",
        );
        let make_id = file_summary.functions[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(index.function_return_type(&make_id), None);
    }

    #[test]
    fn unannotated_return_of_unclassifiable_shape_drops_whole_inference() {
        let file_summary = summary_for(
            "a.ts",
            "export function make(flag) {\n  if (flag) {\n    return { ok: true };\n  }\n  return null;\n}\n",
        );
        assert!(file_summary.functions[0].pending_return.is_none());
    }

    #[test]
    fn infers_unannotated_object_shape_arrow_property_return() {
        // The `Z.class(...)`-style mixin pattern, but with the factory
        // arrow ITSELF unannotated (widened scope vs P1-A, which required
        // an explicit return-type annotation on every object-shape
        // property).
        let file_summary = summary_for(
            "a.ts",
            "class ZodClass {\n  safeParse() {}\n}\nconst Z = {\n  make: () => new ZodClass(),\n};\n",
        );
        let zod_class_id = file_summary.classes[0].entity_id.clone();
        let z_id = file_summary.object_shapes[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.member_type_ref(&z_id, "make", false),
            Some(ResolvedTypeRef::Entity(zod_class_id))
        );
    }

    // P1-C: utility types.

    #[test]
    fn member_type_ref_resolves_return_type_of_typeof_fn() {
        // The dominant root cause P1-B flagged for its own remaining
        // recovery gap, found live in this corpus's migration DSL:
        // `schemaBuilder: ReturnType<typeof createSchemaBuilder>`.
        let file_summary = summary_for(
            "a.ts",
            "class Builder {\n  column() {}\n}\nfunction createBuilder(): Builder { return new Builder(); }\ninterface Context {\n  schemaBuilder: ReturnType<typeof createBuilder>;\n}\n",
        );
        let builder_id = file_summary.classes[0].entity_id.clone();
        let context_id = file_summary.interfaces[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.member_type_ref(&context_id, "schemaBuilder", false),
            Some(ResolvedTypeRef::Entity(builder_id))
        );
    }

    #[test]
    fn return_type_of_typeof_fn_resolves_through_the_shallow_inference_fixed_point() {
        // `f` is UNANNOTATED -- its own return type only exists after
        // P1-B's own fixed point (pass three) infers it; `ReturnType<typeof
        // f>` must see that inferred type, not just a declared one.
        let file_summary = summary_for(
            "a.ts",
            "class Builder {}\nfunction createBuilder() { return new Builder(); }\ninterface Context {\n  schemaBuilder: ReturnType<typeof createBuilder>;\n}\n",
        );
        let builder_id = file_summary.classes[0].entity_id.clone();
        let context_id = file_summary.interfaces[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.member_type_ref(&context_id, "schemaBuilder", false),
            Some(ResolvedTypeRef::Entity(builder_id))
        );
    }

    #[test]
    fn return_type_of_typeof_fn_resolves_across_files_through_a_named_import() {
        let mut summaries = BTreeMap::new();
        summaries.insert(
            "builder.ts".to_owned(),
            summary_for(
                "builder.ts",
                "export class Builder {}\nexport function createBuilder(): Builder { return new Builder(); }\n",
            ),
        );
        let context_summary = summary_for(
            "context.ts",
            "import { createBuilder } from './builder';\ninterface Context {\n  schemaBuilder: ReturnType<typeof createBuilder>;\n}\n",
        );
        let context_id = context_summary.interfaces[0].entity_id.clone();
        summaries.insert("context.ts".to_owned(), context_summary);
        let builder_id = summaries["builder.ts"].classes[0].entity_id.clone();
        let mut import_targets = HashMap::new();
        import_targets.insert(
            (
                "context.ts".to_owned(),
                "./builder".to_owned(),
                "createBuilder".to_owned(),
            ),
            summaries["builder.ts"].functions[0].entity_id.clone(),
        );
        let index = ProgramIndex::build(&summaries, &import_targets, &HashMap::new());
        assert_eq!(
            index.member_type_ref(&context_id, "schemaBuilder", false),
            Some(ResolvedTypeRef::Entity(builder_id))
        );
    }

    /// G extension (E-P0l, 2026-09-08): a `typeof <expr>` type query
    /// reached through TWO alias hops, the SECOND one crossing a file
    /// boundary via a named import (`type FetchFunction = GitHubFetch;`
    /// locally, `export type GitHubFetch = typeof fetchFn;` in another
    /// file) -- `ProgramIndex::build` alone (given correct `import_
    /// targets`) resolves this chain correctly; found live against the
    /// VS Code corpus that the SAME shape (`githubTransport.ts`'s own
    /// `_fetch: FetchFunction`, chasing into `githubTypes.ts`'s
    /// `GitHubFetch`) still resolved to `_fetch`'s own declaration in a
    /// full daemon-driven scan -- isolates the gap to the PRODUCTION
    /// needed-imports scan (`main.rs`/`v4/typeflow.rs`'s own `collect_
    /// type_ref_import`) rather than this crate's own alias-chasing
    /// logic, which this test proves is already sound. Not fixed this
    /// session (out of safe risk budget to debug live-scan-only state
    /// further) -- see `docs/evidence/2026-09-07-v4-vscode-campaign.md`
    /// §12.
    #[test]
    fn member_type_query_resolves_through_a_two_hop_cross_file_alias_chain() {
        let mut summaries = BTreeMap::new();
        summaries.insert(
            "types.ts".to_owned(),
            summary_for(
                "types.ts",
                "export function fetchFn(url: string) {}\nexport type GitHubFetch = typeof fetchFn;\n",
            ),
        );
        let transport_summary = summary_for(
            "transport.ts",
            "import { GitHubFetch } from './types';\ntype FetchFunction = GitHubFetch;\nclass Transport {\n  private readonly _fetch: FetchFunction;\n}\n",
        );
        let transport_id = transport_summary.classes[0].entity_id.clone();
        summaries.insert("transport.ts".to_owned(), transport_summary);
        let fetchfn_id = summaries["types.ts"].functions[0].entity_id.clone();
        let github_fetch_alias_id = summaries["types.ts"].type_aliases[0].id.clone();
        let mut import_targets = HashMap::new();
        import_targets.insert(
            (
                "transport.ts".to_owned(),
                "./types".to_owned(),
                "GitHubFetch".to_owned(),
            ),
            github_fetch_alias_id,
        );
        let index = ProgramIndex::build(&summaries, &import_targets, &HashMap::new());
        assert_eq!(
            index.member_type_ref(&transport_id, "_fetch", false),
            Some(ResolvedTypeRef::TypeQuery(Some(fetchfn_id)))
        );
    }

    /// E-P0m (2026-09-08, `docs/evidence/2026-09-07-v4-vscode-campaign.md`
    /// §13): the SAME two-hop alias shape as the test right above, but with
    /// the `./types` import LEFT UNRESOLVED (empty `import_targets`,
    /// exactly what happens live when the underlying specifier fails to
    /// resolve) -- `member_type_ref` correctly stays `None` (it always did:
    /// `dealias_entity`'s `Some(None)` branch), but `member_annotation_is_
    /// unresolved` must now report `true` for `_fetch` (a REAL annotation
    /// that failed, not "no annotation") so `resolve_call_target_typeflow`
    /// never falls back to `_fetch`'s own declaration as the call target.
    #[test]
    fn member_annotation_is_unresolved_when_the_alias_chain_import_never_resolves() {
        let mut summaries = BTreeMap::new();
        summaries.insert(
            "types.ts".to_owned(),
            summary_for(
                "types.ts",
                "export function fetchFn(url: string) {}\nexport type GitHubFetch = typeof fetchFn;\n",
            ),
        );
        let transport_summary = summary_for(
            "transport.ts",
            "import { GitHubFetch } from './types';\ntype FetchFunction = GitHubFetch;\nclass Transport {\n  private readonly _fetch: FetchFunction;\n}\n",
        );
        let transport_id = transport_summary.classes[0].entity_id.clone();
        summaries.insert("transport.ts".to_owned(), transport_summary);
        // No `import_targets` entry at all -- `./types`'s own `GitHubFetch`
        // never resolves, exactly like a `.js`-suffixed specifier the
        // resolver cannot map to `types.ts` (the live root cause).
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(index.member_type_ref(&transport_id, "_fetch", false), None);
        assert!(index.member_annotation_is_unresolved(&transport_id, "_fetch", false));
    }

    /// E-P0m: the negative control -- a member with NO type annotation at
    /// all must never be reported as "unresolved" (there is nothing to be
    /// unresolved; a naive name-based call target is exactly as safe as
    /// before this task).
    #[test]
    fn member_annotation_is_unresolved_is_false_for_an_untyped_member() {
        let file_summary = summary_for(
            "a.ts",
            "class Widget {\n  private _label = 'x';\n  rename(next: string) { this._label = next; }\n}\n",
        );
        let widget_id = file_summary.classes[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert!(!index.member_annotation_is_unresolved(&widget_id, "_label", false));
    }

    /// E-P0m: the other negative control -- a member whose annotation DOES
    /// fully resolve must also never be reported as "unresolved".
    #[test]
    fn member_annotation_is_unresolved_is_false_for_a_fully_resolved_member() {
        let mut summaries = BTreeMap::new();
        summaries.insert(
            "a.ts".to_owned(),
            summary_for("a.ts", "export class Base {}\n"),
        );
        let base_id = summaries["a.ts"].classes[0].entity_id.clone();
        let holder_summary = summary_for(
            "b.ts",
            "import { Base } from './a';\nclass Holder {\n  owner: Base;\n}\n",
        );
        let holder_id = holder_summary.classes[0].entity_id.clone();
        summaries.insert("b.ts".to_owned(), holder_summary);
        let mut import_targets = HashMap::new();
        import_targets.insert(
            ("b.ts".to_owned(), "./a".to_owned(), "Base".to_owned()),
            base_id.clone(),
        );
        let index = ProgramIndex::build(&summaries, &import_targets, &HashMap::new());
        assert_eq!(
            index.member_type_ref(&holder_id, "owner", false),
            Some(ResolvedTypeRef::Entity(base_id))
        );
        assert!(!index.member_annotation_is_unresolved(&holder_id, "owner", false));
    }

    #[test]
    fn instance_type_of_typeof_class_resolves_to_the_class_itself() {
        let file_summary = summary_for(
            "a.ts",
            "class Foo {\n  greet() {}\n}\ninterface Holder {\n  foo: InstanceType<typeof Foo>;\n}\n",
        );
        let foo_id = file_summary.classes[0].entity_id.clone();
        let holder_id = file_summary.interfaces[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.member_type_ref(&holder_id, "foo", false),
            Some(ResolvedTypeRef::Entity(foo_id))
        );
    }

    #[test]
    fn awaited_unwraps_a_promise_of_local_class() {
        let file_summary = summary_for(
            "a.ts",
            "class Foo {}\ninterface Holder {\n  foo: Awaited<Promise<Foo>>;\n}\n",
        );
        let foo_id = file_summary.classes[0].entity_id.clone();
        let holder_id = file_summary.interfaces[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.member_type_ref(&holder_id, "foo", false),
            Some(ResolvedTypeRef::Entity(foo_id))
        );
    }

    #[test]
    fn partial_readonly_pick_omit_and_non_nullable_erase_to_the_full_underlying_member_table() {
        let file_summary = summary_for(
            "a.ts",
            "interface Foo {\n  greet(): void;\n}\ninterface Holder {\n  a: Partial<Foo>;\n  b: Required<Foo>;\n  c: Readonly<Foo>;\n  d: Pick<Foo, 'greet'>;\n  e: Omit<Foo, 'greet'>;\n  f: NonNullable<Foo>;\n}\n",
        );
        let foo_id = file_summary.interfaces[0].entity_id.clone();
        let holder_id = file_summary.interfaces[1].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        for member in ["a", "b", "c", "d", "e", "f"] {
            assert_eq!(
                index.member_type_ref(&holder_id, member, false),
                Some(ResolvedTypeRef::Entity(foo_id.clone())),
                "member {member}"
            );
        }
    }

    #[test]
    fn record_value_type_unwraps_on_indexed_access() {
        let file_summary = summary_for(
            "a.ts",
            "class Foo {}\ninterface Holder {\n  items: Record<string, Foo>;\n}\n",
        );
        let foo_id = file_summary.classes[0].entity_id.clone();
        let holder_id = file_summary.interfaces[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.member_type_ref(&holder_id, "items", false),
            Some(ResolvedTypeRef::RecordOf(Box::new(
                ResolvedTypeRef::Entity(foo_id)
            )))
        );
    }

    #[test]
    fn intersection_merges_member_tables_with_left_operand_priority() {
        // `A & B`: `greet` only exists on `A`, `wave` only on `B`, `shared`
        // exists on BOTH -- `A`'s own `shared` must win (left-operand
        // priority).
        let file_summary = summary_for(
            "a.ts",
            "interface A {\n  greet(): void;\n  shared(): void;\n}\ninterface B {\n  wave(): void;\n  shared(): void;\n}\ninterface Holder {\n  x: A & B;\n}\n",
        );
        // Interfaces are pushed in file order, EXCEPT that the synthetic
        // intersection container `Holder`'s own "x" member creates is
        // pushed WHILE `Holder`'s own member list is still being built --
        // i.e. before `Holder` itself is pushed (same ordering as the
        // inline-type-literal test above): `[A, B, <synthetic>, Holder]`.
        let a_id = file_summary.interfaces[0].entity_id.clone();
        let b_id = file_summary.interfaces[1].entity_id.clone();
        assert_eq!(file_summary.interfaces.len(), 4, "{file_summary:?}");
        let holder_id = file_summary.interfaces[3].entity_id.clone();
        let a_greet = file_summary.interfaces[0].members[0].entity_id.clone();
        let b_wave = file_summary.interfaces[1].members[0].entity_id.clone();
        let a_shared = file_summary.interfaces[0].members[1].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        let Some(ResolvedTypeRef::Entity(x_entity)) = index.member_type_ref(&holder_id, "x", false)
        else {
            panic!("expected an Entity resolution for the intersection");
        };
        assert!(index.is_container(&x_entity));
        assert_eq!(
            index.members(&x_entity, "greet", false),
            MemberLookup::One(a_greet)
        );
        assert_eq!(
            index.members(&x_entity, "wave", false),
            MemberLookup::One(b_wave)
        );
        assert_eq!(
            index.members(&x_entity, "shared", false),
            MemberLookup::One(a_shared),
            "A's own member must win over B's on a name collision"
        );
        let _ = a_id;
        let _ = b_id;
    }

    #[test]
    fn indexed_access_by_string_literal_resolves_a_named_members_declared_type() {
        let file_summary = summary_for(
            "a.ts",
            "class Foo {}\ninterface Named {\n  value: Foo;\n}\ninterface Holder {\n  x: Named[\"value\"];\n}\n",
        );
        let foo_id = file_summary.classes[0].entity_id.clone();
        let holder_id = file_summary.interfaces[1].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.member_type_ref(&holder_id, "x", false),
            Some(ResolvedTypeRef::Entity(foo_id))
        );
    }

    #[test]
    fn unrecognized_utility_type_stays_unknown_never_a_guess() {
        let file_summary = summary_for(
            "a.ts",
            "interface Foo {\n  greet(): void;\n}\ninterface Holder {\n  x: SomeMadeUpUtility<Foo>;\n}\n",
        );
        let holder_id = file_summary.interfaces[1].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(index.member_type_ref(&holder_id, "x", false), None);
    }

    #[test]
    fn return_type_of_typeof_fn_resolves_a_callable_variables_concise_object_literal_body() {
        // The EXACT flagship pattern found live in this corpus's own
        // migration DSL (`packages/@n8n/db/src/migrations/dsl/index.ts`):
        // `export const createSchemaBuilder = (tablePrefix, queryRunner) =>
        // ({ createTable(...) {...}, ... });` -- `createSchemaBuilder` is
        // NEVER a `function` declaration (so `summarize_function` never saw
        // it) and its OWN initializer is an ARROW FUNCTION, not a plain
        // object literal (so `summarize_object_shape` never saw it either)
        // -- see `collect_callable_variable`'s doc comment.
        let mut summaries = BTreeMap::new();
        summaries.insert(
            "dsl.ts".to_owned(),
            summary_for(
                "dsl.ts",
                "class TableBuilder {\n  withColumns(): void {}\n}\nexport const createSchemaBuilder = (prefix) => ({\n  createTable(name) { return new TableBuilder(); },\n});\n",
            ),
        );
        let context_summary = summary_for(
            "context.ts",
            "import { createSchemaBuilder } from './dsl';\ninterface Context {\n  schemaBuilder: ReturnType<typeof createSchemaBuilder>;\n}\n",
        );
        let context_id = context_summary.interfaces[0].entity_id.clone();
        summaries.insert("context.ts".to_owned(), context_summary);
        let table_builder_id = summaries["dsl.ts"].classes[0].entity_id.clone();
        let mut import_targets = HashMap::new();
        import_targets.insert(
            (
                "context.ts".to_owned(),
                "./dsl".to_owned(),
                "createSchemaBuilder".to_owned(),
            ),
            summaries["dsl.ts"].callable_variables[0].entity_id.clone(),
        );
        let index = ProgramIndex::build(&summaries, &import_targets, &HashMap::new());
        let Some(ResolvedTypeRef::Entity(schema_builder_shape_id)) =
            index.member_type_ref(&context_id, "schemaBuilder", false)
        else {
            panic!("expected an Entity resolution for ReturnType<typeof createSchemaBuilder>");
        };
        assert_eq!(
            index.member_type_ref(&schema_builder_shape_id, "createTable", false),
            Some(ResolvedTypeRef::Entity(table_builder_id))
        );
    }

    #[test]
    fn callable_variable_with_an_explicit_return_annotation_resolves_like_a_function() {
        let file_summary = summary_for(
            "a.ts",
            "class Foo {}\nconst make = (): Foo => new Foo();\ninterface Holder {\n  x: ReturnType<typeof make>;\n}\n",
        );
        let foo_id = file_summary.classes[0].entity_id.clone();
        let holder_id = file_summary.interfaces[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(
            index.member_type_ref(&holder_id, "x", false),
            Some(ResolvedTypeRef::Entity(foo_id))
        );
    }

    #[test]
    fn callable_variable_with_a_non_object_literal_body_stays_unknown() {
        let file_summary = summary_for(
            "a.ts",
            "const make = () => 42;\ninterface Holder {\n  x: ReturnType<typeof make>;\n}\n",
        );
        let holder_id = file_summary.interfaces[0].entity_id.clone();
        let mut summaries = BTreeMap::new();
        summaries.insert("a.ts".to_owned(), file_summary);
        let index = ProgramIndex::build(&summaries, &HashMap::new(), &HashMap::new());
        assert_eq!(index.member_type_ref(&holder_id, "x", false), None);
    }
    // -----------------------------------------------------------------
    // P3-8a: `replace_file`/`add_file`/`remove_file` == from-scratch `build`
    // over random edit sequences on a synthetic 50-100 file project.
    // -----------------------------------------------------------------

    /// Deterministic xorshift64 PRNG (same construction this codebase's
    /// other randomized structural tests already use, e.g. `urdira-jsts-
    /// syntax-worker`'s P3-6 item 2 narrowed-reresolution test) -- a fixed
    /// seed makes a failure reproducible without needing to print the seed.
    struct Xorshift64(u64);
    impl Xorshift64 {
        fn next_u64(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
        fn next_usize(&mut self, bound: usize) -> usize {
            (self.next_u64() % bound as u64) as usize
        }
    }

    /// Every synthetic file `fN.ts` always declares all three of
    /// `ClassN`/`IfaceN`/`funcN` (annotated) -- so any earlier index `j < i`
    /// is always a valid heritage/call target for a LATER file `i`,
    /// regardless of which template `j` itself used. This keeps the random
    /// generator simple (no need to track "does file j have a class") while
    /// still producing real cross-file heritage/member/pending-return
    /// chains for pass 2/3/4 to exercise.
    fn base_source(i: usize) -> String {
        format!(
            "export class Class{i} {{\n  own{i}(): number {{ return {i}; }}\n}}\nexport interface Iface{i} {{\n  id{i}: string;\n}}\nexport function func{i}(): number {{ return {i}; }}\n"
        )
    }

    fn extends_class_source(i: usize, j: usize) -> String {
        format!(
            "import {{ Class{j} }} from \"./f{j}\";\nexport class Class{i} extends Class{j} {{\n  own{i}(): number {{ return {i}; }}\n}}\nexport interface Iface{i} {{\n  id{i}: string;\n}}\nexport function func{i}(): number {{ return {i}; }}\n"
        )
    }

    fn extends_iface_source(i: usize, j: usize) -> String {
        format!(
            "import {{ Iface{j} }} from \"./f{j}\";\nexport class Class{i} {{\n  own{i}(): number {{ return {i}; }}\n}}\nexport interface Iface{i} extends Iface{j} {{\n  id{i}: string;\n}}\nexport function func{i}(): number {{ return {i}; }}\n"
        )
    }

    /// Unannotated `func{i}` calling an imported `func{j}` -- feeds pass 3's
    /// shallow return-inference fixed point across files.
    fn call_fn_source(i: usize, j: usize) -> String {
        format!(
            "import {{ func{j} }} from \"./f{j}\";\nexport class Class{i} {{\n  own{i}(): number {{ return {i}; }}\n}}\nexport interface Iface{i} {{\n  id{i}: string;\n}}\nexport function func{i}() {{\n  return func{j}();\n}}\n"
        )
    }

    /// Parses the numeric index out of a synthetic `"fN.ts"` path.
    fn index_of_path(path: &str) -> usize {
        path.strip_prefix('f')
            .and_then(|s| s.strip_suffix(".ts"))
            .and_then(|n| n.parse::<usize>().ok())
            .expect("synthetic path is always \"fN.ts\"")
    }

    /// Generates file `i`'s source: a `Base` template if no earlier file
    /// currently exists in `project` (or a further 1-in-4 chance even when
    /// one does, so a corpus that is mostly base classes is still
    /// represented), otherwise one of the three cross-file templates
    /// against a uniformly random EXISTING earlier index.
    fn random_source_for(
        i: usize,
        project: &BTreeMap<String, DeclSummary>,
        rng: &mut Xorshift64,
    ) -> String {
        let existing_smaller: Vec<usize> = project
            .keys()
            .map(|p| index_of_path(p))
            .filter(|&idx| idx < i)
            .collect();
        if existing_smaller.is_empty() {
            return base_source(i);
        }
        match rng.next_usize(4) {
            0 => base_source(i),
            1 => extends_class_source(i, existing_smaller[rng.next_usize(existing_smaller.len())]),
            2 => extends_iface_source(i, existing_smaller[rng.next_usize(existing_smaller.len())]),
            _ => call_fn_source(i, existing_smaller[rng.next_usize(existing_smaller.len())]),
        }
    }

    /// `(owning_path, specifier, imported_name)` for every `Imported`
    /// `HeritageTarget`/`RawTypeRef`/`DeferredReturnShape::CallEntity` leaf
    /// `summary` contains -- a minimal, test-local stand-in for `v4/
    /// typeflow.rs`'s own `collect_heritage_import`/`collect_type_ref_
    /// import`/`collect_pending_return_import` (that module lives in a
    /// different crate this test cannot depend on), walking the exact same
    /// public `RawTypeRef`/`HeritageTarget`/`DeferredReturnShape` shapes.
    fn needed_imports_for_summary(summary: &DeclSummary, out: &mut Vec<(String, String, String)>) {
        fn heritage(
            owning_path: &str,
            target: &HeritageTarget,
            out: &mut Vec<(String, String, String)>,
        ) {
            if let HeritageTarget::Imported {
                specifier,
                imported_name: Some(name),
            } = target
            {
                out.push((owning_path.to_owned(), specifier.clone(), name.clone()));
            }
        }
        fn type_ref(owning_path: &str, raw: &RawTypeRef, out: &mut Vec<(String, String, String)>) {
            match raw {
                RawTypeRef::Imported {
                    specifier,
                    imported_name: Some(name),
                } => out.push((owning_path.to_owned(), specifier.clone(), name.clone())),
                RawTypeRef::ArrayOf(inner)
                | RawTypeRef::PromiseOf(inner)
                | RawTypeRef::RecordOf(inner) => {
                    type_ref(owning_path, inner, out);
                }
                _ => {}
            }
        }
        fn pending(
            owning_path: &str,
            pending_return: &Option<Vec<DeferredReturnShape>>,
            out: &mut Vec<(String, String, String)>,
        ) {
            fn walk(
                owning_path: &str,
                shape: &DeferredReturnShape,
                out: &mut Vec<(String, String, String)>,
            ) {
                match shape {
                    DeferredReturnShape::CallEntity(ReturnEntityRef::Imported {
                        specifier,
                        imported_name: Some(name),
                    }) => out.push((owning_path.to_owned(), specifier.clone(), name.clone())),
                    DeferredReturnShape::AwaitOf(inner) => walk(owning_path, inner, out),
                    _ => {}
                }
            }
            if let Some(shapes) = pending_return {
                for shape in shapes {
                    walk(owning_path, shape, out);
                }
            }
        }
        for class in &summary.classes {
            if let Some(target) = &class.extends {
                heritage(&summary.path, target, out);
            }
            for target in &class.implements {
                heritage(&summary.path, target, out);
            }
            for member in &class.members {
                type_ref(&summary.path, &member.type_ref, out);
                pending(&summary.path, &member.pending_return, out);
            }
        }
        for interface in &summary.interfaces {
            for target in &interface.extends {
                heritage(&summary.path, target, out);
            }
            for member in &interface.members {
                type_ref(&summary.path, &member.type_ref, out);
                pending(&summary.path, &member.pending_return, out);
            }
        }
        for function in &summary.functions {
            type_ref(&summary.path, &function.return_type, out);
            pending(&summary.path, &function.pending_return, out);
        }
        for callable in &summary.callable_variables {
            type_ref(&summary.path, &callable.return_type, out);
            pending(&summary.path, &callable.pending_return, out);
        }
        for shape in &summary.object_shapes {
            for member in &shape.members {
                type_ref(&summary.path, &member.type_ref, out);
                pending(&summary.path, &member.pending_return, out);
            }
        }
        for variable in &summary.variables {
            type_ref(&summary.path, &variable.type_ref, out);
        }
    }

    /// Test-local specifier resolver: `"./fN"` resolves to `"fN.ts"` iff
    /// that path is currently present in `project` -- mirrors
    /// `WorkspaceResolver::resolve`'s own present-or-absent contract without
    /// depending on `urdira-jsts-syntax-worker`.
    fn resolve_specifier_to_path(
        specifier: &str,
        project: &BTreeMap<String, DeclSummary>,
    ) -> Option<String> {
        let name = specifier.strip_prefix("./")?;
        let candidate = format!("{name}.ts");
        project.contains_key(&candidate).then_some(candidate)
    }

    /// Test-local named-export resolver: every synthetic entity id ends
    /// with `:{declared_name}` (E0's `jsts:{kind}:{path}:{start}:{name}`
    /// convention, same as production code) -- mirrors `resolver::
    /// resolve_named_export`'s contract without depending on
    /// `urdira-jsts-syntax-worker`.
    fn resolve_named_export_in(
        project: &BTreeMap<String, DeclSummary>,
        target_path: &str,
        name: &str,
    ) -> Option<String> {
        let summary = project.get(target_path)?;
        let suffix = format!(":{name}");
        summary
            .classes
            .iter()
            .map(|c| &c.entity_id)
            .chain(summary.interfaces.iter().map(|c| &c.entity_id))
            .chain(summary.functions.iter().map(|f| &f.entity_id))
            .chain(summary.callable_variables.iter().map(|f| &f.entity_id))
            .chain(summary.object_shapes.iter().map(|s| &s.entity_id))
            .chain(summary.variables.iter().map(|v| &v.entity_id))
            .find(|id| id.ends_with(&suffix))
            .cloned()
    }

    /// Resolves every needed import for exactly `paths` (a full oracle pass
    /// when `paths` is `project.keys()`, a NARROW/scoped pass when `paths`
    /// is `{changed file} ∪ importers_of(changed file)` -- the same
    /// two-mode use `v4/typeflow.rs`'s real wiring makes of this same
    /// recipe).
    /// E-P0d: also returns the `pending_targets` map `ProgramIndex::build`/
    /// `replace_file`/`add_file` now take -- an owning path whose specifier
    /// resolves to a KNOWN file but whose named export does not (yet) is
    /// distinguished here from one whose specifier never resolves to any
    /// file at all (never recorded as pending -- see `pending_importers_of`
    /// (the field)'s own doc comment), exactly like the production caller
    /// (`v4/typeflow.rs`'s `resolve_import_targets_for`) does. Every path in
    /// `paths` gets an entry in the returned map (possibly empty), never
    /// only the ones with an actual pending edge -- so a caller applying
    /// this as a full snapshot (`apply_pending_target_updates`'s own "never
    /// a partial patch" contract) correctly clears a path's stale pending
    /// edges even when it has none anymore.
    #[allow(clippy::type_complexity)]
    fn compute_import_targets_for(
        paths: impl Iterator<Item = String>,
        project: &BTreeMap<String, DeclSummary>,
    ) -> (
        HashMap<(String, String, String), String>,
        HashMap<String, HashSet<String>>,
    ) {
        let mut resolved = HashMap::new();
        let mut pending: HashMap<String, HashSet<String>> = HashMap::new();
        for path in paths {
            pending.entry(path.clone()).or_default();
            let Some(summary) = project.get(&path) else {
                continue;
            };
            let mut needed = Vec::new();
            needed_imports_for_summary(summary, &mut needed);
            for (owning_path, specifier, name) in needed {
                let Some(target_path) = resolve_specifier_to_path(&specifier, project) else {
                    continue;
                };
                match resolve_named_export_in(project, &target_path, &name) {
                    Some(target_id) => {
                        resolved.insert((owning_path, specifier, name), target_id);
                    }
                    None => {
                        pending.entry(owning_path).or_default().insert(target_path);
                    }
                }
            }
        }
        (resolved, pending)
    }

    fn build_oracle(project: &BTreeMap<String, DeclSummary>) -> ProgramIndex {
        let (import_targets, pending_targets) =
            compute_import_targets_for(project.keys().cloned(), project);
        ProgramIndex::build(project, &import_targets, &pending_targets)
    }

    /// Compares every PUBLICLY-OBSERVABLE piece of state `ProgramIndex`
    /// carries -- not just Merkle-style roots, per the task's own
    /// instruction ("compare the full index state, not just roots").
    /// `containers`/`function_return_types`/`variable_types` together ARE
    /// the index's complete answer surface (`is_container`/`members`/
    /// `member_type_ref`/`function_return_type`/`variable_declared_type`
    /// all read only these three maps). The direct reverse heritage index is
    /// also compared because it is incremental bookkeeping whose divergence
    /// would make the query-visible conformance result stale. The remaining
    /// fields (`summaries`, `import_targets`, `entity_owner`, `file_entities`,
    /// `importers_of`) have no query-visible effect of their own.
    fn assert_index_equal(incremental: &ProgramIndex, oracle: &ProgramIndex, context: &str) {
        diff_maps(
            &incremental.containers,
            &oracle.containers,
            context,
            "containers",
        );
        diff_maps(
            &incremental.function_return_types,
            &oracle.function_return_types,
            context,
            "function_return_types",
        );
        diff_maps(
            &incremental.variable_types,
            &oracle.variable_types,
            context,
            "variable_types",
        );
        diff_maps(
            &incremental.conformance_children,
            &oracle.conformance_children,
            context,
            "conformance_children",
        );
    }

    fn diff_maps<V: std::fmt::Debug + PartialEq>(
        incremental: &HashMap<String, V>,
        oracle: &HashMap<String, V>,
        context: &str,
        label: &str,
    ) {
        let mut only_incremental: Vec<&String> = Vec::new();
        let mut only_oracle: Vec<&String> = Vec::new();
        let mut differing: Vec<&String> = Vec::new();
        for key in incremental.keys() {
            match oracle.get(key) {
                None => only_incremental.push(key),
                Some(oracle_value) if oracle_value != &incremental[key] => differing.push(key),
                _ => {}
            }
        }
        for key in oracle.keys() {
            if !incremental.contains_key(key) {
                only_oracle.push(key);
            }
        }
        if only_incremental.is_empty() && only_oracle.is_empty() && differing.is_empty() {
            return;
        }
        only_incremental.sort();
        only_oracle.sort();
        differing.sort();
        let mut message = format!(
            "{context}: {label} diverged -- only_in_incremental={} only_in_oracle={} differing_values={}\n",
            only_incremental.len(),
            only_oracle.len(),
            differing.len(),
        );
        for key in only_incremental.iter().take(5) {
            message.push_str(&format!(
                "  only_incremental: {key} = {:?}\n",
                incremental[*key]
            ));
        }
        for key in only_oracle.iter().take(5) {
            message.push_str(&format!("  only_oracle: {key} = {:?}\n", oracle[*key]));
        }
        for key in differing.iter().take(5) {
            message.push_str(&format!(
                "  differs: {key}\n    incremental = {:?}\n    oracle      = {:?}\n",
                incremental[*key], oracle[*key]
            ));
        }
        panic!("{message}");
    }

    #[test]
    fn incremental_matches_from_scratch_after_random_edit_sequences_over_synthetic_project() {
        let mut rng = Xorshift64(0x2545_F491_4F6C_DD1D ^ 0x9E37_79B9);
        const INITIAL_FILE_COUNT: usize = 70;
        const EDIT_COUNT: usize = 400;
        const MIN_FILES: usize = 10;

        let mut project: BTreeMap<String, DeclSummary> = BTreeMap::new();
        let mut next_index = 0usize;

        for _ in 0..INITIAL_FILE_COUNT {
            let i = next_index;
            next_index += 1;
            let path = format!("f{i}.ts");
            let source = random_source_for(i, &project, &mut rng);
            let summary = extract_decl_summary(&path, &source).expect("synthetic source parses");
            project.insert(path, summary);
        }

        let mut incremental = build_oracle(&project);
        assert_index_equal(
            &incremental,
            &build_oracle(&project),
            "initial build (self-check)",
        );

        for step in 0..EDIT_COUNT {
            let can_remove = project.len() > MIN_FILES;
            let action = if can_remove {
                rng.next_usize(3)
            } else {
                1 + rng.next_usize(2)
            };
            match action {
                0 => {
                    // Remove a random existing file. Its (former) importers
                    // simply degrade to "unresolved" for whatever they
                    // referenced there -- no `import_targets_updates` call
                    // needed (see `ProgramIndex::remove_file`'s doc comment).
                    let keys: Vec<String> = project.keys().cloned().collect();
                    let victim = keys[rng.next_usize(keys.len())].clone();
                    if std::env::var_os("URDIRA_DEBUG_TYPEFLOW_TEST").is_some() {
                        eprintln!(
                            "step {step}: REMOVE {victim} importers={:?}",
                            incremental.importers_of(&victim)
                        );
                    }
                    project.remove(&victim);
                    incremental.remove_file(&victim);
                }
                1 => {
                    // Add a brand-new file, always referencing (if at all)
                    // an EXISTING earlier file -- never one created later,
                    // so this never exercises the separate "create resolves
                    // a previously broken import" propagation direction
                    // (out of `ProgramIndex`'s own scope -- see the P3-8a
                    // evidence doc's discussion of `analysis.owners`).
                    let i = next_index;
                    next_index += 1;
                    let path = format!("f{i}.ts");
                    let source = random_source_for(i, &project, &mut rng);
                    let summary =
                        extract_decl_summary(&path, &source).expect("synthetic source parses");
                    project.insert(path.clone(), summary.clone());
                    let (updates, pending) =
                        compute_import_targets_for(std::iter::once(path.clone()), &project);
                    incremental.add_file(&path, summary, &updates, &pending);
                }
                _ => {
                    // Replace an existing file's content -- refresh
                    // `import_targets` for the file itself AND every file
                    // that (before this edit) imported from it (successfully
                    // OR, E-P0d, still-pending -- see `pending_importers_of`
                    // (the field)'s own doc comment for why a not-yet-
                    // resolved importer must be retried too), since the edit
                    // may shift an exported entity's `start`-keyed id, or
                    // simply be the fix a pending importer was waiting on.
                    let keys: Vec<String> = project.keys().cloned().collect();
                    let path = keys[rng.next_usize(keys.len())].clone();
                    let i = index_of_path(&path);
                    let mut importers_before = incremental.importers_of(&path);
                    importers_before.extend(incremental.pending_importers_of(&path));
                    let source = random_source_for(i, &project, &mut rng);
                    let summary =
                        extract_decl_summary(&path, &source).expect("synthetic source parses");
                    project.insert(path.clone(), summary.clone());
                    let mut refresh: Vec<String> = importers_before.clone();
                    refresh.push(path.clone());
                    let (updates, pending) =
                        compute_import_targets_for(refresh.into_iter(), &project);
                    if std::env::var_os("URDIRA_DEBUG_TYPEFLOW_TEST").is_some() {
                        eprintln!(
                            "step {step}: REPLACE {path} importers_before={importers_before:?} updates={updates:?} pending={pending:?}"
                        );
                    }
                    incremental.replace_file(&path, summary, &updates, &pending);
                }
            }

            let oracle = build_oracle(&project);
            assert_index_equal(
                &incremental,
                &oracle,
                &format!("after edit step {step} (action {action})"),
            );
        }
    }

    /// Frente E-P0g adversarial review, attack #3:
    /// `apply_import_target_updates`'s own `owning_paths_considered`
    /// parameter (the fix under review) must (a) keep an owning path's
    /// UNCHANGED keys when only ANOTHER key drops out of its own set, (b)
    /// drop EXACTLY the one key that stopped resolving (never the whole
    /// set), (c) refresh a key's target id in place, (d) register a
    /// brand-new owning path the same call introduces, and (e) fully
    /// clear an owning path whose ENTIRE needed-import set stopped
    /// resolving this round (present in `owning_paths_considered`, absent
    /// from `updates`' own keys entirely) -- the exact case this fix's own
    /// doc comment names as the bug an earlier draft (deriving `owning_
    /// paths` solely from `updates.keys()`) left broken.
    #[test]
    fn apply_import_target_updates_owning_paths_considered_clears_dropped_keeps_kept_and_adds_new()
    {
        let mut index = ProgramIndex::build(&BTreeMap::new(), &HashMap::new(), &HashMap::new());

        // Round 1: "a.ts" resolves 3 imports.
        let mut updates: HashMap<(String, String, String), String> = HashMap::new();
        updates.insert(
            ("a.ts".to_string(), "./x".to_string(), "X".to_string()),
            "entity:x".to_string(),
        );
        updates.insert(
            ("a.ts".to_string(), "./y".to_string(), "Y".to_string()),
            "entity:y".to_string(),
        );
        updates.insert(
            ("a.ts".to_string(), "./z".to_string(), "Z".to_string()),
            "entity:z".to_string(),
        );
        let considered: HashSet<String> = ["a.ts".to_string()].into_iter().collect();
        index.apply_import_target_updates(&updates, &considered);
        assert_eq!(
            index.file_import_keys.get("a.ts").map(|keys| keys.len()),
            Some(3),
            "round 1: a.ts must own exactly the 3 keys it resolved"
        );
        assert_eq!(index.import_targets.len(), 3);

        // Round 2: "a.ts" now resolves only 2 (./y/Y dropped, ./z/Z's
        // target id changes), and a BRAND-NEW owning path "b.ts" appears.
        let mut updates2: HashMap<(String, String, String), String> = HashMap::new();
        updates2.insert(
            ("a.ts".to_string(), "./x".to_string(), "X".to_string()),
            "entity:x".to_string(),
        );
        updates2.insert(
            ("a.ts".to_string(), "./z".to_string(), "Z".to_string()),
            "entity:z2".to_string(),
        );
        updates2.insert(
            ("b.ts".to_string(), "./x".to_string(), "X".to_string()),
            "entity:x".to_string(),
        );
        let considered2: HashSet<String> = ["a.ts".to_string(), "b.ts".to_string()]
            .into_iter()
            .collect();
        index.apply_import_target_updates(&updates2, &considered2);
        let a_keys = index
            .file_import_keys
            .get("a.ts")
            .cloned()
            .unwrap_or_default();
        assert_eq!(
            a_keys.len(),
            2,
            "round 2: a.ts must keep exactly its 2 still-resolving keys, dropping ONLY ./y/Y \
             (never the whole set); got {a_keys:?}"
        );
        assert!(
            !index.import_targets.contains_key(&(
                "a.ts".to_string(),
                "./y".to_string(),
                "Y".to_string()
            )),
            "the dropped key must be removed from import_targets"
        );
        assert_eq!(
            index
                .import_targets
                .get(&("a.ts".to_string(), "./x".to_string(), "X".to_string())),
            Some(&"entity:x".to_string()),
            "an unchanged key must survive untouched"
        );
        assert_eq!(
            index
                .import_targets
                .get(&("a.ts".to_string(), "./z".to_string(), "Z".to_string())),
            Some(&"entity:z2".to_string()),
            "a refreshed key's target id must be updated in place"
        );
        assert_eq!(
            index.file_import_keys.get("b.ts").map(|keys| keys.len()),
            Some(1),
            "a brand-new owning path in the same call must be registered"
        );

        // Round 3: "a.ts" resolves NOTHING at all (present in `owning_
        // paths_considered`, absent from `updates`' own keys entirely) --
        // must be cleared COMPLETELY, not left stale. "b.ts" is absent
        // from `owning_paths_considered` this round -- must be untouched.
        let updates3: HashMap<(String, String, String), String> = HashMap::new();
        let considered3: HashSet<String> = ["a.ts".to_string()].into_iter().collect();
        index.apply_import_target_updates(&updates3, &considered3);
        assert_eq!(
            index
                .file_import_keys
                .get("a.ts")
                .map(|keys| keys.len())
                .unwrap_or(0),
            0,
            "a.ts whose ENTIRE needed-import set stopped resolving must be fully cleared -- \
             owning_paths_considered's whole reason to exist; got {:?}",
            index.file_import_keys.get("a.ts")
        );
        assert!(
            !index.import_targets.keys().any(|key| key.0 == "a.ts"),
            "no import_targets entry may remain owned by a.ts after its entire set went stale"
        );
        assert_eq!(
            index.file_import_keys.get("b.ts").map(|keys| keys.len()),
            Some(1),
            "b.ts was not in owning_paths_considered this round -- it must stay untouched"
        );
    }
}
