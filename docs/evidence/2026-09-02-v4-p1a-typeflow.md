# v4 P1-A: raising the typeflow resolver's recovery rate — 2026-09-02

Continuation of the P0-S2 prototype (`docs/evidence/2026-09-02-v4-p0-s2-typeflow-prototype.md`).
Same flags, same corpus, same scope (still gated behind `URDIRA_JSTS_TYPEFLOW=1`,
off by default; nothing here changes the flag-off code path). **Not committed**,
per the task's instructions.

## Result up front

**Recovery went from 43.33% to 77.35% on the 2,000-owner cut, with wrong-target
held at 0.00% throughout every iteration.** This is short of the 90% exit bar.
The gap is real and is analyzed honestly below (classifier histogram, root
causes, samples) rather than closed by guessing. Wrong-target is the
acceptance-critical number and it never moved off zero across seven
iterations and roughly 4,900 hits from the new rules — the strongest evidence
this session has that every rule added is sound, even though coverage still
falls short.

| | calls attempted | same target | different target | checker-confirmed, rust-pending | recovery | wrong-target |
|---|---:|---:|---:|---:|---:|---:|
| P0-S2 baseline | 48,413 | 4,115 | 0 | 5,382 | 43.33% | 0.00% |
| **P1-A final** | 48,413 | 7,346 | 0 | 2,151 | **77.35%** | **0.00%** |

## Method followed

Per the brief: classifier first, then rules by measured frequency, remeasuring
after each change; `cargo fmt`/`clippy -D warnings`/`cargo test --workspace`
green after every iteration; native rebuilt before every census; `pnpm
preflight:n8n-incremental` invoked directly via `node
scripts/n8n-incremental-preflight.mjs` (the `pnpm ... -- ...` form the brief
suggested fails in this repo's pnpm version with `Unknown argument: --`; calling
the script directly sidesteps that, otherwise identical). Two runs mid-session
hit an unrelated harness flake (`workspace_scan_enumeration_failed` /
`ENOENT` on a file inside the copied corpus's temp dir, once even losing a
whole file mid-scan) — a retry succeeded cleanly both times; this looks like
filesystem contention from other concurrent activity on the machine (the
brief warned other agents might be running builds), not a regression from any
change in this session.

## Classifier (step 1)

Added `SemanticWalker::classify_receiver_shape`/`classify_expr_shape`/
`classify_identifier_shape` (`semantic_sites.rs`), gated behind
`URDIRA_JSTS_TYPEFLOW_ORACLE=1` only (zero cost in production/typeflow-off
mode): for every non-identifier-callee call site, tags the *receiver
expression's* shape from a fixed taxonomy (`chained_member_of_call`,
`call_expression_receiver`, `identifier_unannotated_local`,
`identifier_param_unannotated`, `nested_member_chain`, `array_element`,
`await_expr`, `as_expression`, `non_null` (folded via `type_of_expression`'s
own transparency, never a distinct census bucket), `namespace_import_member`,
`static_member_via_class_name_lookup_failed`, `identifier_typed_lookup_failed`,
`this_unresolved`, `computed_callee`, `other_callee_shape`, ...), threaded
through `OwnerSemantics::typeflow_pending_call_shapes` into a new
`census_typeflow_owner` cross-reference (`main.rs`) that tallies shape counts
+ up to 5 samples per shape, scoped to exactly the `checker_confirmed_rust_
pending` bucket the task asked for. Miss-sample cap raised from 50 to 1,000
(`TYPEFLOW_CENSUS_SAMPLE_CAP`); a separate, smaller cap (`TYPEFLOW_SHAPE_
SAMPLE_CAP = 5`) keeps the per-shape sample listing from ballooning to the
same size.

**Baseline histogram** (before any P1-A rule, all misses = "the five P0-S2
rules didn't reach this site at all"):

| shape | count | interpretation |
|---|---:|---|
| `call_expression_receiver` | 1,018 | `f(...).method()` — receiver is itself a call |
| `identifier_other` | 788 | identifier whose declaration kind `classify_symbol_declaration` doesn't recognize (mostly: a DESTRUCTURED binding, whose declarator's own `id` is a pattern, not a `BindingIdentifier`) |
| `identifier_unannotated_local` | 571 | `const x = ...` / untyped local, no annotation |
| `nested_member_chain` | 356 | `a.b.c()` — two hops, neither `this`/`super`/`new` |
| `static_member_via_class_name_lookup_failed` | 294 | `SomeClass.staticMethod()` where lookup on the class's own extends chain came back empty |
| `namespace_import_member` | 225 | `ns.member(...)` where `ns` is any import-bound identifier |
| `identifier_param_unannotated` | 84 | untyped function parameter |
| `identifier_typed_lookup_failed` | 28 | already typed via `local_types`, but `ProgramIndex::members` still missed |
| `other_callee_shape` / `computed_callee` / `this_unresolved` / `new_expr_inline` / `as_expression` | 4–31 each | long tail |

This directly confirmed the P0-S2 evidence doc's own top finding (fluent
chains dominate) and additionally surfaced `identifier_other` (destructuring)
and `static_member_via_class_name_lookup_failed` (a specific mixin pattern,
below) as comparably large, previously-unquantified buckets.

## Rules implemented, in the order built (each iteration measured before the next)

The prototype's five rules (`this`, `super`, `member_class_static`,
`member_declared_type`, `member_new_expression`) were widened from a single
flat function (`typeflow_object_base`) into one recursive entry point,
**`SemanticWalker::type_of_expression`**, that every call/member/heritage
site now goes through. This is the single architectural change everything
else builds on.

1. **(a) Call-expression receivers, return-type propagation, `this`-returning
   chains.** `type_of_call_expression`: an identifier callee resolves through
   a new cross-file `ProgramIndex::function_return_type` (backed by
   `urdira-jsts-typeflow`'s new `FunctionSummary`); a member callee
   (`a.b(...)`) resolves `b`'s own declared return type on `a`'s type via
   `ProgramIndex::member_type_ref` (new: `MemberEntry` now carries a
   `type_ref: RawTypeRef`, resolved once per file at extraction time,
   `this`-return included). This is what makes `new Tool('x').description(a)
   .input(b)` (found live in `packages/@n8n/agents/examples/basic-agent.ts`)
   resolve hop-by-hop: `new Tool(...)` → `Tool` entity, `.description()`
   declared `: this` → same `Tool` entity, `.input()` same again.
2. **Bug found and fixed while wiring rule (a): missing cross-file import
   collection.** `build_typeflow_program_index` (`main.rs`) only ever
   collected import needs from HERITAGE clauses (`class.extends`/
   `implements`), never from a member's or function's own `type_ref` — so
   almost every cross-file member/return type (an imported interface named
   as a return type, the overwhelmingly common case) silently failed to
   resolve for want of an `import_targets` entry nothing else happened to
   also need. Fixed by widening the collection to also walk every class/
   interface member's and every function's `type_ref` (`collect_type_ref_
   import`, recursing through `ArrayOf`/`PromiseOf`). This alone moved
   recovery from 43.33% → 62.36% in one iteration — the single largest jump
   of the whole session, and a pure bugfix, not a new rule.
3. **(b) Unannotated variable/const initializers, resolved recursively.**
   `record_local_type` now falls back to `type_of_expression(initializer)`
   when there is no type annotation, instead of only handling a bare `new
   T()` shape.
4. **(c) `await` unwrapping `Promise<T>`.** `RawTypeRef`/`ResolvedTypeRef`
   gained a `PromiseOf` wrapper (alongside `ArrayOf`, already planned);
   `type_of_expression`'s `AwaitExpression` arm unwraps one layer.
5. **(d) Parenthesized / `as T` / `<T>x` / `x!` / optional chaining.** All
   handled as transparent (or type-substituting, for `as`/`<T>`) hops in
   `type_of_expression` (`ParenthesizedExpression`, `TSAsExpression`,
   `TSTypeAssertion`, `TSNonNullExpression`, `ChainExpression`).
6. **(g) Array element access (`a[i]`).** `TypeflowValue::ArrayOf`
   (paralleling `RawTypeRef`/`ResolvedTypeRef::ArrayOf`) plus a
   `ComputedMemberExpression` arm that unwraps it.
7. **(f) Namespace member calls (`ns.fn(...)`, `import * as ns`).** New
   `namespace_import_specifiers: HashMap<SymbolId, String>` (populated in
   `visit_import_namespace_specifier`) + `resolve_namespace_member`, closing
   the same import → export chain a named import already uses
   (`WorkspaceResolver::resolve` + `resolver::resolve_named_export`), just
   keyed by the property name at the USE site. Wired into both the direct
   call-target path (`resolve_call_target_typeflow`) and the chain-
   propagation path (`type_of_call_expression`). Recovery 62.36% → 66.14%.
8. **(h) Destructuring from typed objects.** `record_local_type` gained an
   `ObjectPattern` arm (`record_destructured_object_types`): resolves the
   initializer's (or annotation's) own type, then looks each destructured
   property up via `ProgramIndex::member_type_ref`. Covers both `const {
   agent } = setup()` and a destructured function parameter. Modest first
   measurement (66.14% → 66.33%) because most of the underlying return
   types weren't resolvable YET (see item 11).
9. **(i) Object-literal shapes (`const Z = { class: (): T => ... }`).**
   `urdira-jsts-typeflow` gained `ObjectShapeSummary`: a top-level `const X =
   { ... }` with NO explicit type annotation is modeled as another kind of
   member-bearing `ResolvedContainer` (function/arrow-valued properties only,
   keyed by their own declared return type), inserted into the SAME
   `containers` map classes/interfaces use — every existing lookup path
   (`member_type_ref`, `members`) picks it up for free. `type_of_expression`'s
   `Identifier` arm widened to try `DeclKind::Variable` + `is_container`.
10. **Wrong-target regression found and fixed.** Object-shape extraction
    (item 9) didn't check for an explicit type annotation on the declarator,
    so `export const allNodesConnected: BinaryCheck = { run() {...} }`
    (found live, `packages/@n8n/ai-workflow-builder.ee/.../checks/*.ts`) got
    modeled by its OWN structural shape instead of its DECLARED type —
    `.run()` resolved to the object literal's own `run`, not `BinaryCheck`'s,
    a genuine wrong-target (166/9,497 = 1.75%, well over the 0.3% bar) that
    showed up in the very next census run. Root cause: TypeScript's static
    type for an explicitly-annotated declarator is ALWAYS the annotation,
    never the initializer's inferred shape, even when the initializer
    happens to be an object literal too. Fixed with a new `VariableSummary`
    (mirrors `FunctionSummary`, for a plain variable) capturing the
    EXPLICIT annotation when present; `summarize_object_shape`'s structural
    extraction now only ever runs for a declarator with NO annotation — the
    two are mutually exclusive by construction. `type_of_expression`'s
    `Identifier` arm tries `variable_declared_type` before falling to
    `is_container`. Wrong-target back to 0/9,497; recovery actually rose
    (68.7% → 71.75%) because the 166 previously-wrong sites became correct.
    A regression test (`typeflow_prefers_an_explicit_variable_annotation_
    over_its_object_literal_shape`) locks this in.
11. **(l), widened: heritage through a CALL EXPRESSION (mixin factories).**
    Found live and initially the SINGLE largest remaining cluster (288/1,000
    sampled misses, ~29%): `class LoginDto extends Z.class({...}) {}` across
    every DTO file in `packages/@n8n/api-types/src/dto/**`, where `Z` is an
    object-literal mixin factory (`packages/@n8n/api-types/src/zod-class.ts`).
    `HeritageTarget` gained a `CallMember { base, member }` variant
    (`<base>.<member>(...)`, single-hop only, matching the existing
    "never widen past what's proven" discipline); `ProgramIndex::build`
    gained a SECOND PASS (after every container's own member table —
    including an object-literal shape's — is built) that resolves `base`,
    looks up `member`'s own return type on it, and patches the class's
    `extends` in place only when that resolves to a concrete entity.
    Symmetric widening in `semantic_sites.rs`'s own `resolve_super_class`
    (`resolve_heritage_call_typeflow`) for the SAME-FILE, oracle-census half
    of this. This is the single largest recovery jump after the import-
    collection bugfix: 71.75% → 77.17% (`static_member_via_class_name_
    lookup_failed` 294 → 4; `heritage_generic` hits 5 → 194).
12. **(j) Inline object types (`{ ... }` type literals), both cross-file and
    local.** Found live in `packages/@n8n/db/src/migrations/migration-
    types.ts` (`escape: { columnName(name): string; ... }`) and
    `packages/@n8n/agents/src/integrations/langsmith.ts` (`getSharedClient():
    { awaitPendingTraceBatches(): Promise<void> }`, and a PARAMETER typed
    `options: { RunTree: LangSmithRunTree }`). Two symmetric halves:
    - **Cross-file** (`urdira-jsts-typeflow`): `raw_type_ref_of_ts_type`
      gained a `TSTypeLiteral` arm that synthesizes a purely-internal
      `InterfaceSummary` (a synthetic, non-`jsts:`-prefixed entity id, never
      itself published as a `target_id` — only ever an intermediate lookup
      key) from the literal's own signature list, threaded via a new
      `synthetic_interfaces: &mut Vec<InterfaceSummary>` accumulator through
      every extraction function down to `raw_type_ref_of_ts_type` itself,
      merged into `DeclSummary.interfaces`.
    - **Local** (`semantic_sites.rs`): a NEW `TypeflowValue::Inline(Vec<
      (String, TypeflowValue)>)` variant for a LOCALLY-annotated parameter/
      variable whose type is an anonymous `{ ... }` (never itself entity-
      backed, so member access on it is a direct linear scan in `type_of_
      static_member`/`type_of_call_expression`, tried BEFORE the entity-
      based `ProgramIndex::member_type_ref` path).
    Recovery 77.17% → 77.35% counted alone, but this rule's real effect was
    mostly already captured inside item 11's own run (`destructured_
    property` hits jumped 56 → 581 and `identifier_other` dropped 770 → 245
    in the SAME run this landed, since many destructured bindings' own
    initializer types were inline object literals this unlocked).
13. **(e) Correctness fix (found while implementing the rule): `this` inside
    a nested plain function must NOT leak the enclosing class.** A plain
    `function`/function EXPRESSION rebinds `this` (unlike an arrow function,
    which oxc represents as an entirely separate AST node type that never
    reaches `visit_function` at all — arrows correctly always saw the
    enclosing class already). `visit_function` previously never touched
    `class_stack` at all, so `class Derived extends Base { run() { function
    inner() { this.greet() } } }`'s `this` inside `inner` incorrectly
    resolved to `Derived`. Fixed by pushing a blocking `None`/`None`
    `ClassFrame` in `visit_function`. The one place this needed a
    deliberate BYPASS: a class method's own body is ALSO, structurally, a
    plain `FunctionExpression` (oxc's `Function` node carries no "this is a
    method body" bit distinguishing it from an ordinary function
    expression) — `visit_method_definition` now manually replicates `walk_
    method_definition`'s own traversal but calls the free `walk_function`
    directly instead of `self.visit_function`, so a method's own body
    continues to see the enclosing class exactly as before. Two regression
    tests added (`typeflow_this_inside_a_nested_plain_function_does_not_
    leak_the_enclosing_class`, `..._nested_arrow_function_still_resolves...`).
    Zero measured effect on this corpus's own recovery/wrong-target numbers
    (the pattern is rare enough not to appear in the 2,000-owner sample),
    but it closes a latent wrong-target risk this session's OWN new
    `Inline`/chain machinery would otherwise have made easier to hit (more
    call sites now resolve `this` at all, so a nested-function `this` bug
    has more surface to go wrong on).

## Rules from the task's list NOT implemented, with reasons

- **(k) Constructor parameter properties** (`constructor(private x: T)`).
  Deprioritized after checking the actual miss data: the classifier's
  `this_unresolved` bucket (the shape this rule would fix) stayed at 20
  throughout the whole session — far too small to justify the identity risk
  of guessing at the checker's own naming convention for a parameter-
  property field (untested against a real checker run; getting it wrong
  would cost wrong-target budget for a ~20-site gain).
- **(m) Unannotated function return inference (shallow).** Requires a
  cross-file, cross-FUNCTION fixed-point pass (function A's inferred return
  type may depend on function B's, in either file order) that this
  session's single-linear-pass extraction pipeline does not support without
  a real architectural change (an accumulator/worklist across
  `ProgramIndex::build`, not just within one file's own extraction as items
  9–12 needed). Flagged as the most likely next lever for a P1-B-style
  follow-up given the `identifier_other`/`identifier_unannotated_local`
  buckets both still contain real (if reduced) mass.
- **Full namespace re-export support (`export * as X from "spec"`).**
  Root-caused precisely (see below) but requires a LANE-1 change
  (`urdira-jsts-syntax-worker::lib.rs`'s `SyntaxCollector`, not the
  typeflow crate), out of this task's stated scope and carrying real risk
  to the existing E2 import/export machinery broader than this prototype.

## Final classifier histogram (`checker_confirmed_rust_pending` = 2,151)

| shape | before P1-A | after P1-A | Δ |
|---|---:|---:|---:|
| `call_expression_receiver` | 1,018 | 1,017 | ~0 |
| `identifier_other` | 788 | 245 | −543 |
| `identifier_unannotated_local` | 571 | 282 | −289 |
| `nested_member_chain` | 356 | 226 | −130 |
| `static_member_via_class_name_lookup_failed` | 294 | 4 | −290 |
| `namespace_import_member` | 225 | 22 | −203 |
| `identifier_param_unannotated` | 84 | 84 | 0 |
| `identifier_typed_lookup_failed` | 28 | 60 | +32 (see below) |
| `chained_member_of_call` | (not tracked pre-classifier-widening) | 140 | — |
| `computed_callee` / `other_callee_shape` / `this_unresolved` / `new_expr_inline` / `as_expression` | ~90 combined | ~71 combined | small |

`identifier_typed_lookup_failed` going UP is not a regression: it means MORE
identifiers now successfully get a type via `local_types` (good — more rules
firing), and a strict SUBSET of those then fail `ProgramIndex::members`'s own
lookup — sampled and root-caused below (method overloads).

### Root causes behind what's left, with samples

1. **`export * as evals from "./evals/index"` (namespace re-export)** — the
   REMAINING `namespace_import_member` (22) and part of `call_expression_
   receiver`. Root-caused precisely: `urdira-jsts-syntax-worker::lib.rs`'s
   `visit_export_all_declaration` (covers both `export *` and `export * as
   X`) only ever records an IMPORT dependency edge — it never synthesizes a
   `SyntaxExportBinding` for the `X` name at all, so `resolve_named_export`
   can never see it. A NAMED import of such a re-exported namespace (`import
   { evals } from '../../index'`, itself `export * as evals from
   './evals/index'`) therefore never even resolves as an ordinary reference,
   let alone a typeflow target. Genuinely out of the typeflow crate's scope
   (a lane-1 fix); example: `packages/@n8n/agents/src/__tests__/integration/
   evaluate.test.ts:3935` → `evals/string-similarity.ts:899:stringSimilarity`.
2. **Method overloads producing `MemberLookup::Many`** — the dominant
   remaining root cause behind `identifier_typed_lookup_failed` (60) and a
   meaningful share of `identifier_unannotated_local`/`this_unresolved`.
   `packages/@n8n/agents/src/sdk/agent.ts`'s `resume` (two overload
   signatures at 19952/20080) and `generate`/`getState` show up repeatedly
   across THREE different shape buckets in the samples — every one of them
   is `Agent`'s already-correctly-typed member table finding 2+ same-named
   entries (one per overload signature) and correctly refusing to guess
   (`collect_members`'s "own-level ambiguous match never falls through"
   rule). Sound behavior, real coverage gap: overload-aware member merging
   (treat sibling overload signatures with the SAME name as one logical
   member, picking e.g. the last/implementation signature) is a real next
   rule, not attempted this session for time.
3. **`call_expression_receiver`'s remaining mass (1,017, essentially
   unchanged)** is a genuinely diverse long tail once the zod-class mixin
   pattern (item 11) and the langsmith inline-literal pattern (item 12) were
   fixed — sampled targets span
   `packages/@n8n/agents/src/runtime/agent-runtime.ts`,
   `packages/@n8n/ai-workflow-builder.ee/evaluations/harness/harness-
   types.ts`, `packages/@n8n/backend-network/.../ssrf-protection.service.ts`,
   `packages/@n8n/db/src/migrations/dsl/{column,table}.ts`, and more — no
   single remaining pattern accounts for more than a few dozen sites in the
   1,000-sample listing; closing this further needs case-by-case
   investigation rather than one more rule.
4. **`nested_member_chain` (226)** — a mix of the overload issue above (item
   2) and cases where an intermediate property's own type is a union or a
   generic-parameter type this crate deliberately never guesses at (both
   `RawTypeRef::Unknown` by design, per the module's own "never widen past
   what's proven" rule).

## External-target breakdown (task step 5)

`checker_confirmed_external_target` = 8,612 (calls, same as P0-S2 — this
crate never touches anything outside workspace source by construction, see
that doc's own explanation). Basename of the checker's target's own `.d.ts`
file, tallied via a new `external_target_basename` (`main.rs`), with
`@types/<pkg>` scoped packages folded into one bucket per package (found:
none in this corpus's sample — `@types/node` never appeared):

| category | count | share |
|---|---:|---:|
| Array/String/Object/Number/Date/RegExp/Function/... (`lib.es5.d.ts` + incremental ES-version `.d.ts` files) | 6,467 | 75.1% |
| Map/Set/WeakMap/WeakSet + their iterable forms (`lib.es2015.collection.d.ts` + `lib.es2015.iterable.d.ts`) | 894 | 10.4% |
| DOM (`lib.dom.d.ts`) | 711 | 8.3% |
| Promise (`lib.es2015.promise.d.ts` + `lib.es2018/2020.promise.d.ts`) | 395 | 4.6% |
| Symbol/Reflect | 150 | 1.7% |
| **Node (`@types/node`)** | **0** | **0%** |

Full per-file table (24 distinct `.d.ts` files) is in `tmp-census.json`'s
`external_target_basename_counts`. **For P1-B**: `lib.es5.d.ts` alone is
5,092 of the 8,612 (59%) — Array/String/Object prototype methods
(`.map`/`.filter`/`.slice`/`.trim`/`.includes`/...). A tiny built-in member
table (just the method NAMES for `Array.prototype`/`String.prototype`/
`Object`, mapped to a `possible` edge with reason `external_module` per the
task's own framing) would likely be the highest-leverage single addition for
that phase, given how concentrated this bucket is; Node's complete absence
here means it is NOT worth prioritizing for THIS corpus specifically.

## Quality gate

- `cargo test --workspace`: every crate green throughout every iteration
  (final: 137 syntax-worker incl. 25 new typeflow-specific tests, 38
  indexing-worker, 16 typeflow crate incl. 7 new, others unaffected —
  21/21 `test result: ok` lines, 0 failed anywhere).
- `cargo clippy --workspace --all-targets -- -D warnings`: clean after every
  iteration.
- `cargo fmt --all -- --check`: clean.
- New unit tests (one per rule, per the task's own instruction), all in
  `crates/urdira-jsts-typeflow/src/lib.rs` (7: `member_type_ref_resolves_
  this_return_type`, `..._array_of_local_class`, `..._falls_back_through_
  extends_chain`, `function_return_type_resolves_{local_class,promise_of_
  local_class,imported_class}`, `object_shape_member_resolves_a_functions_
  own_return_type`, `member_type_ref_resolves_through_an_inline_type_
  literal`) and `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`
  (18: fluent chain, call-expression receiver, unannotated-variable-from-
  call, await/Promise, array element, `as`, non-null, optional chain,
  property chain via declared member, namespace member call (direct +
  cross-file), destructured binding + parameter, zod-class mixin heritage
  (same-file + cross-file), inline type literal (cross-file + local),
  the explicit-annotation-wins-over-object-shape regression test, and the
  two nested-function `this` regression tests).

## Files

- `crates/urdira-jsts-typeflow/src/lib.rs` (RawTypeRef/ResolvedTypeRef,
  `FunctionSummary`, `ObjectShapeSummary`, `VariableSummary`,
  `HeritageTarget::CallMember`, synthetic type-literal containers, two-pass
  `ProgramIndex::build`, `member_type_ref`/`function_return_type`/
  `variable_declared_type`; 15 tests total).
- `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs` (`TypeflowValue`,
  `type_of_expression` + its helpers, `resolve_namespace_member`,
  `record_destructured_object_types`, `resolve_heritage_call_typeflow`,
  the census classifier (`classify_receiver_shape`/`classify_expr_shape`/
  `classify_identifier_shape`, `TypeflowPendingShape`), the `this`-rebinding
  fix in `visit_function`/`visit_method_definition`; 137 tests total).
- `crates/urdira-indexing-worker/src/main.rs` (`build_typeflow_program_index`
  import-collection widening + bugfix, `collect_heritage_import`/
  `collect_type_ref_import`, census classifier wiring, `TYPEFLOW_CENSUS_
  SAMPLE_CAP` 50→1000, `receiver_shape_counts`/`receiver_shape_samples`,
  `external_target_basename`/`external_target_basename_counts`).
- Census raw output: `tmp-census.json` in the worktree root (matches the
  prior doc's convention; not added to git). `tmp-preflight-2k.json` is the
  preflight harness's own summary for the same run.

Not committed (per instructions).
