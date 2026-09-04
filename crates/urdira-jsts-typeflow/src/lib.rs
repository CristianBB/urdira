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
    TSInterfaceDeclaration, TSLiteral, TSSignature, TSType, TSTypeAnnotation, TSTypeName,
    TSTypeQueryExprName,
};
use oxc_ast_visit::utf8_to_utf16::Utf8ToUtf16;
use oxc_parser::Parser;
use oxc_semantic::{Scoping, SemanticBuilder};
use oxc_span::SourceType;
use oxc_syntax::symbol::SymbolId;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

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
    /// Anything this crate does not (yet) reason about: a union type, a
    /// conditional/mapped/keyof/tuple type, a qualified type name, a type-
    /// parameter reference, ... -- never a guess.
    Unknown,
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
        _ => {}
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
    let pending_return = matches!(return_type, RawTypeRef::Unknown)
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
                let pending_return = matches!(type_ref, RawTypeRef::Unknown)
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
                let pending_return = matches!(type_ref, RawTypeRef::Unknown)
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
            let return_type = if !matches!(annotated, RawTypeRef::Unknown) {
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
        _ => RawTypeRef::Unknown,
    }
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
    let members = class
        .body
        .body
        .iter()
        .filter_map(|element| {
            member_entry_of_class_element(
                element,
                path,
                scoping,
                import_specifiers,
                synthetic_interfaces,
                &entity_id,
            )
        })
        .collect();
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

/// The `(start, name)` an identity-bearing `PropertyKey` contributes, when
/// it has one at all. Mirrors `semantic_sites::property_key_name` exactly
/// (same "#"-prefix and literal-key handling) -- see that function's doc
/// comment for why a computed key has none.
fn property_key_name(key: &PropertyKey) -> Option<(u32, String)> {
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

fn member_entry_of_class_element(
    element: &ClassElement,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    synthetic_interfaces: &mut Vec<InterfaceSummary>,
    enclosing_class_id: &str,
) -> Option<MemberEntry> {
    match element {
        ClassElement::MethodDefinition(method) => {
            let (key_start, key_name) = property_key_name(&method.key)?;
            let kind = match method.kind {
                MethodDefinitionKind::Constructor => "constructor",
                MethodDefinitionKind::Method => "method",
                MethodDefinitionKind::Get => "getter",
                MethodDefinitionKind::Set => "setter",
            };
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
            // of its own.
            let pending_return = (return_type_eligible(method.kind)
                && matches!(type_ref, RawTypeRef::Unknown))
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
                name: key_name.clone(),
                is_static: method.r#static,
                entity_id: declaration_id(kind, path, key_start, &key_name),
                type_ref,
                pending_return,
                is_async: method.value.r#async,
            })
        }
        ClassElement::PropertyDefinition(property) => {
            if property.computed {
                return None;
            }
            let (key_start, key_name) = property_key_name(&property.key)?;
            let type_ref = raw_type_ref_of_annotation(
                property.type_annotation.as_deref(),
                path,
                scoping,
                import_specifiers,
                synthetic_interfaces,
            );
            Some(MemberEntry {
                name: key_name.clone(),
                is_static: property.r#static,
                entity_id: declaration_id("property", path, key_start, &key_name),
                type_ref,
                pending_return: None,
                is_async: false,
            })
        }
        _ => None,
    }
}

fn return_type_eligible(kind: MethodDefinitionKind) -> bool {
    matches!(
        kind,
        MethodDefinitionKind::Method | MethodDefinitionKind::Get
    )
}

fn member_entry_of_signature(
    signature: &TSSignature,
    path: &str,
    scoping: &Scoping,
    import_specifiers: &HashMap<SymbolId, (String, Option<String>)>,
    synthetic_interfaces: &mut Vec<InterfaceSummary>,
) -> Option<MemberEntry> {
    match signature {
        TSSignature::TSMethodSignature(method) => {
            let (key_start, key_name) = property_key_name(&method.key)?;
            let kind = match method.kind {
                oxc_ast::ast::TSMethodSignatureKind::Method => "method",
                oxc_ast::ast::TSMethodSignatureKind::Get => "getter",
                oxc_ast::ast::TSMethodSignatureKind::Set => "setter",
            };
            let type_ref = raw_type_ref_of_annotation(
                method.return_type.as_deref(),
                path,
                scoping,
                import_specifiers,
                synthetic_interfaces,
            );
            Some(MemberEntry {
                name: key_name.clone(),
                // Interface members have no static/instance distinction --
                // an interface can never be `new`'d directly, so `a: IFoo`
                // member access is always the instance shape. `false` here
                // means `ProgramIndex::members` must be called with
                // `is_static = false` for an interface-typed base -- the
                // caller's responsibility (mirrors "own members" always
                // being instance-shaped for a `TSTypeLiteral`, out of
                // scope here).
                is_static: false,
                entity_id: declaration_id(kind, path, key_start, &key_name),
                type_ref,
                // Interface signatures have no body -- nothing to infer.
                pending_return: None,
                is_async: false,
            })
        }
        TSSignature::TSPropertySignature(property) => {
            let (key_start, key_name) = property_key_name(&property.key)?;
            let type_ref = raw_type_ref_of_annotation(
                property.type_annotation.as_deref(),
                path,
                scoping,
                import_specifiers,
                synthetic_interfaces,
            );
            Some(MemberEntry {
                name: key_name.clone(),
                is_static: false,
                entity_id: declaration_id("property", path, key_start, &key_name),
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
    containers: HashMap<String, ResolvedContainer>,
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
) -> Vec<ResolvedMember> {
    members
        .iter()
        .map(|member| ResolvedMember {
            name: member.name.clone(),
            is_static: member.is_static,
            entity_id: member.entity_id.clone(),
            type_ref: resolve_raw_type_ref(&member.type_ref, owning_path, import_targets),
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
) -> FileDeferred {
    let path = summary.path.as_str();
    let mut deferred = FileDeferred::default();

    for class in &summary.classes {
        let resolve =
            |target: &HeritageTarget| resolve_heritage_target(target, path, import_targets);
        containers.insert(
            class.entity_id.clone(),
            ResolvedContainer {
                extends: class
                    .extends
                    .as_ref()
                    .and_then(resolve)
                    .into_iter()
                    .collect(),
                implements: class.implements.iter().filter_map(resolve).collect(),
                members: resolve_members_for(&class.members, path, import_targets),
                is_interface: false,
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
        let resolve =
            |target: &HeritageTarget| resolve_heritage_target(target, path, import_targets);
        containers.insert(
            interface.entity_id.clone(),
            ResolvedContainer {
                extends: interface.extends.iter().filter_map(resolve).collect(),
                implements: Vec::new(),
                members: resolve_members_for(&interface.members, path, import_targets),
                is_interface: true,
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
        if let Some(return_type) = resolve_raw_type_ref(&function.return_type, path, import_targets)
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
        if let Some(return_type) = resolve_raw_type_ref(&callable.return_type, path, import_targets)
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
                members: resolve_members_for(&shape.members, path, import_targets),
                is_interface: true,
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
        if let Some(type_ref) = resolve_raw_type_ref(&variable.type_ref, path, import_targets) {
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
) {
    for class in &summary.classes {
        let Some(HeritageTarget::CallMember { base, member }) = &class.extends else {
            continue;
        };
        let Some(base_entity) = resolve_heritage_target(base, &summary.path, import_targets) else {
            continue;
        };
        let Some(ResolvedTypeRef::Entity(target_id)) =
            lookup_member_type_ref(containers, &base_entity, member, false)
        else {
            continue;
        };
        if let Some(container) = containers.get_mut(&class.entity_id) {
            container.extends = vec![target_id];
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
    pending_functions: &mut Vec<(String, Vec<PreparedReturnShape>, bool)>,
    pending_members: &mut Vec<(String, String, Vec<PreparedReturnShape>, bool)>,
) {
    for function in &summary.functions {
        let Some(shapes) = &function.pending_return else {
            continue;
        };
        let Some(prepared) = prepare_return_shapes(shapes, &summary.path, import_targets) else {
            continue;
        };
        pending_functions.push((function.entity_id.clone(), prepared, function.is_async));
    }
    let mut collect_container_members = |container_id: &str, members: &[MemberEntry]| {
        for member in members {
            let Some(shapes) = &member.pending_return else {
                continue;
            };
            let Some(prepared) = prepare_return_shapes(shapes, &summary.path, import_targets)
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
}

impl ProgramIndex {
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
    pub fn build(
        summaries: &BTreeMap<String, DeclSummary>,
        import_targets: &HashMap<(String, String, String), String>,
    ) -> Self {
        let mut me = Self {
            containers: HashMap::new(),
            function_return_types: HashMap::new(),
            variable_types: HashMap::new(),
            summaries: summaries.clone(),
            import_targets: import_targets.clone(),
            file_import_keys: HashMap::new(),
            entity_owner: HashMap::new(),
            file_entities: HashMap::new(),
            importers_of: HashMap::new(),
        };
        for key in import_targets.keys() {
            me.file_import_keys
                .entry(key.0.clone())
                .or_default()
                .insert(key.clone());
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
            run_pass2_for_summary(&mut me.containers, summary, &me.import_targets);
        }

        let mut pending_functions = Vec::new();
        let mut pending_members = Vec::new();
        for summary in summaries.values() {
            collect_pending_for_summary(
                summary,
                &me.import_targets,
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

    /// P3-8a: `{path}` plus every file transitively reachable by following
    /// `importers_of` edges -- the affected component an edit to `path`
    /// must reflow for the fixed point (pass 3/4) to converge to the same
    /// state a from-scratch `build` would reach. Bounded by the number of
    /// distinct files actually in the importer graph (a plain graph BFS,
    /// no separate iteration cap -- capping this would be a correctness
    /// bug, not a performance one: an uncapped chain simply means an
    /// uncapped chain of real cross-file type dependencies exists).
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
    /// owning path present in `updates`' keys with EXACTLY `updates`' own
    /// entries for that path (a full per-file snapshot, never a partial
    /// patch -- the caller re-resolves and hands over that file's WHOLE
    /// current needed-imports set, so a specifier that stopped resolving,
    /// or stopped being needed at all, is correctly dropped rather than
    /// left stale). An owning path absent from `updates` entirely keeps
    /// its previous entries untouched.
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
    ) -> Vec<((String, String, String), String)> {
        let owning_paths: HashSet<String> = updates.keys().map(|key| key.0.clone()).collect();
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
            self.containers.remove(&entity_id);
            self.function_return_types.remove(&entity_id);
            self.variable_types.remove(&entity_id);
            self.entity_owner.remove(&entity_id);
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
            );
            self.file_entities.insert(file.clone(), owned);
            deferred_functions.extend(file_deferred.functions);
            deferred_variables.extend(file_deferred.variables);
            deferred_members.extend(file_deferred.members);
        }
        for file in files {
            if let Some(summary) = self.summaries.get(file).cloned() {
                run_pass2_for_summary(&mut self.containers, &summary, &self.import_targets);
            }
        }
        let mut pending_functions = Vec::new();
        let mut pending_members = Vec::new();
        for file in files {
            if let Some(summary) = self.summaries.get(file).cloned() {
                collect_pending_for_summary(
                    &summary,
                    &self.import_targets,
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
    pub fn replace_file(
        &mut self,
        path: &str,
        summary: DeclSummary,
        import_targets_updates: &HashMap<(String, String, String), String>,
    ) {
        let affected = self.transitive_importers_closure(path);
        self.purge_import_targets_targeting_file(path);
        let pending_links = self.apply_import_target_updates(import_targets_updates);
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
    ) {
        self.replace_file(path, summary, import_targets_updates);
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
    pub fn members(&self, entity_id: &str, name: &str, is_static: bool) -> MemberLookup {
        let mut visited = std::collections::HashSet::new();
        let mut found = Vec::new();
        self.collect_members(entity_id, name, is_static, &mut visited, &mut found, true);
        found.sort();
        found.dedup();
        match found.len() {
            0 => MemberLookup::None,
            1 => MemberLookup::One(found.into_iter().next().expect("checked len == 1")),
            _ => MemberLookup::Many(found),
        }
    }

    fn collect_members(
        &self,
        entity_id: &str,
        name: &str,
        is_static: bool,
        visited: &mut std::collections::HashSet<String>,
        found: &mut Vec<String>,
        allow_implements_fallback: bool,
    ) {
        const MAX_DEPTH: usize = 32;
        if visited.len() >= MAX_DEPTH || !visited.insert(entity_id.to_owned()) {
            return;
        }
        let Some(container) = self.containers.get(entity_id) else {
            return;
        };
        let effective_static = is_static && !container.is_interface;
        for member in &container.members {
            if member.name == name && member.is_static == effective_static {
                found.push(member.entity_id.clone());
            }
        }
        if !found.is_empty() {
            return;
        }
        for base in &container.extends {
            self.collect_members(base, name, is_static, visited, found, false);
            if !found.is_empty() {
                return;
            }
        }
        if allow_implements_fallback {
            for interface in &container.implements {
                self.collect_members(interface, name, false, visited, found, false);
                if !found.is_empty() {
                    return;
                }
            }
        }
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

/// P1-A: close a `RawTypeRef`'s `Local`/`Imported` leaves against
/// `import_targets` the same way `resolve_heritage_target` does for a
/// heritage clause -- `ThisType` passes through untouched (resolved later,
/// relative to a receiver, by the caller), `ArrayOf`/`PromiseOf` recurse and
/// only produce a wrapped result when their inner type resolved, and
/// `Unknown`/an unresolved `Imported` reference both produce `None` --
/// never a guess.
fn resolve_raw_type_ref(
    raw: &RawTypeRef,
    owning_path: &str,
    import_targets: &HashMap<(String, String, String), String>,
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
        RawTypeRef::ArrayOf(inner) => resolve_raw_type_ref(inner, owning_path, import_targets)
            .map(|resolved| ResolvedTypeRef::ArrayOf(Box::new(resolved))),
        RawTypeRef::PromiseOf(inner) => resolve_raw_type_ref(inner, owning_path, import_targets)
            .map(|resolved| ResolvedTypeRef::PromiseOf(Box::new(resolved))),
        RawTypeRef::RecordOf(inner) => resolve_raw_type_ref(inner, owning_path, import_targets)
            .map(|resolved| ResolvedTypeRef::RecordOf(Box::new(resolved))),
        // P1-C: needs `ProgramIndex::build`'s later, fourth pass instead --
        // see `resolve_raw_type_ref_deferred`'s doc comment.
        RawTypeRef::ReturnTypeOfFn(_) | RawTypeRef::IndexedAccess { .. } => None,
        RawTypeRef::Unknown => None,
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
        RawTypeRef::Local(_) | RawTypeRef::Imported { .. } | RawTypeRef::ThisType => false,
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
            lookup_member_type_ref(containers, &base_entity, key, false)
        }
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

fn resolve_heritage_target(
    target: &HeritageTarget,
    owning_path: &str,
    import_targets: &HashMap<(String, String, String), String>,
) -> Option<String> {
    match target {
        HeritageTarget::Local(entity_id) => Some(entity_id.clone()),
        HeritageTarget::Imported {
            specifier,
            imported_name,
        } => import_targets
            .get(&(
                owning_path.to_owned(),
                specifier.clone(),
                imported_name.clone().unwrap_or_default(),
            ))
            .cloned(),
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
) -> Option<Vec<PreparedReturnShape>> {
    shapes
        .iter()
        .map(|shape| prepare_one_return_shape(shape, owning_path, import_targets))
        .collect()
}

fn prepare_one_return_shape(
    shape: &DeferredReturnShape,
    owning_path: &str,
    import_targets: &HashMap<(String, String, String), String>,
) -> Option<PreparedReturnShape> {
    match shape {
        DeferredReturnShape::Known(raw) => resolve_raw_type_ref(raw, owning_path, import_targets)
            .map(PreparedReturnShape::Resolved),
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
            let inner = prepare_one_return_shape(inner, owning_path, import_targets)?;
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
        let index = ProgramIndex::build(&summaries, &import_targets);
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
        assert_eq!(
            index.members(&impl_id, "greet", false),
            MemberLookup::One(greeter_greet_id)
        );
    }

    #[test]
    fn members_is_none_for_unknown_container() {
        let index = ProgramIndex::build(&BTreeMap::new(), &HashMap::new());
        assert_eq!(
            index.members("jsts:class:missing.ts:0:X", "y", false),
            MemberLookup::None
        );
        assert!(!index.is_container("jsts:class:missing.ts:0:X"));
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
        assert_eq!(
            index.member_type_ref(&derived_id, "build", false),
            Some(ResolvedTypeRef::Entity(result_id))
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &import_targets);
        assert_eq!(
            index.function_return_type(&make_id),
            Some(ResolvedTypeRef::Entity(foo_id))
        );
    }

    // P1-B: shallow return-type inference fixed point.

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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &import_targets);
        assert_eq!(
            index.member_type_ref(&context_id, "schemaBuilder", false),
            Some(ResolvedTypeRef::Entity(builder_id))
        );
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &import_targets);
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
        let index = ProgramIndex::build(&summaries, &HashMap::new());
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
    fn compute_import_targets_for(
        paths: impl Iterator<Item = String>,
        project: &BTreeMap<String, DeclSummary>,
    ) -> HashMap<(String, String, String), String> {
        let mut resolved = HashMap::new();
        for path in paths {
            let Some(summary) = project.get(&path) else {
                continue;
            };
            let mut needed = Vec::new();
            needed_imports_for_summary(summary, &mut needed);
            for (owning_path, specifier, name) in needed {
                let Some(target_path) = resolve_specifier_to_path(&specifier, project) else {
                    continue;
                };
                let Some(target_id) = resolve_named_export_in(project, &target_path, &name) else {
                    continue;
                };
                resolved.insert((owning_path, specifier, name), target_id);
            }
        }
        resolved
    }

    fn build_oracle(project: &BTreeMap<String, DeclSummary>) -> ProgramIndex {
        let import_targets = compute_import_targets_for(project.keys().cloned(), project);
        ProgramIndex::build(project, &import_targets)
    }

    /// Compares every PUBLICLY-OBSERVABLE piece of state `ProgramIndex`
    /// carries -- not just Merkle-style roots, per the task's own
    /// instruction ("compare the full index state, not just roots").
    /// `containers`/`function_return_types`/`variable_types` together ARE
    /// the index's complete answer surface (`is_container`/`members`/
    /// `member_type_ref`/`function_return_type`/`variable_declared_type`
    /// all read only these three maps) -- the remaining fields
    /// (`summaries`, `import_targets`, `entity_owner`, `file_entities`,
    /// `importers_of`) are this task's own INCREMENTAL bookkeeping, private
    /// implementation detail with no query-visible effect of their own.
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
                    let updates =
                        compute_import_targets_for(std::iter::once(path.clone()), &project);
                    incremental.add_file(&path, summary, &updates);
                }
                _ => {
                    // Replace an existing file's content -- refresh
                    // `import_targets` for the file itself AND every file
                    // that (before this edit) imported from it, since the
                    // edit may shift an exported entity's `start`-keyed id.
                    let keys: Vec<String> = project.keys().cloned().collect();
                    let path = keys[rng.next_usize(keys.len())].clone();
                    let i = index_of_path(&path);
                    let importers_before = incremental.importers_of(&path);
                    let source = random_source_for(i, &project, &mut rng);
                    let summary =
                        extract_decl_summary(&path, &source).expect("synthetic source parses");
                    project.insert(path.clone(), summary.clone());
                    let mut refresh: Vec<String> = importers_before.clone();
                    refresh.push(path.clone());
                    let updates = compute_import_targets_for(refresh.into_iter(), &project);
                    if std::env::var_os("URDIRA_DEBUG_TYPEFLOW_TEST").is_some() {
                        eprintln!(
                            "step {step}: REPLACE {path} importers_before={importers_before:?} updates={updates:?}"
                        );
                    }
                    incremental.replace_file(&path, summary, &updates);
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
}
