# v4 P1-B: closing the typeflow resolver's recovery gap + checker-off pipeline — 2026-09-02

Continuation of P1-A (`docs/evidence/2026-09-02-v4-p1a-typeflow.md`, 43.33% →
77.35%). Same flags, same corpus, same scope (`URDIRA_JSTS_TYPEFLOW=1`, off by
default; nothing here changes the flag-off code path). **Not committed**, per
the task's instructions. Worked entirely inside
`~/Proyectos/urdira/.claude/worktrees/agent-adf2ed2e11c2fffb4`.

## Result up front

**Recovery moved from 77.35% to 77.60% on the same 2,000-owner cut, with
wrong-target held at 0.00% throughout every iteration.** This is far short of
the 90%/97% exit bars. The gap is real, is analyzed honestly below (a fresh
classifier histogram, root causes, samples, including one genuinely new
architectural gap found live — TypeScript's `ReturnType<typeof f>` utility
type — that the shallow return-inference pass this session built cannot
close), and is not closed by guessing. The checker-OFF pipeline mode (the
task's other headline goal) **is implemented and verified working
end-to-end**: two independent checker-off runs of the same 500-owner slice
produce byte-identical `visible_set_digest`s, and the run log confirms the
`tsgo` subprocess is never invoked.

| | calls attempted | same target | different target | checker-confirmed, rust-pending | recovery | wrong-target |
|---|---:|---:|---:|---:|---:|---:|
| P1-A final | 48,413 | 7,346 | 0 | 2,151 | 77.35% | 0.00% |
| **P1-B final** | 48,413 | 7,370 | 0 | 2,127 | **77.60%** | **0.00%** |

Net: +24 confirmed, −24 pending, 0 wrong-target moved. Small in absolute
terms; every rule that landed is real, tested, and sound — the corpus's
remaining long tail needs different, larger levers than this session had time
to build (see "Root causes behind what's left").

## Method followed

Per the brief: build the native addon before every census; classifier-driven
prioritization; `cargo fmt`/`clippy -D warnings`/`cargo test --workspace`
green after every iteration; `node scripts/n8n-incremental-preflight.mjs
--corpus ~/Proyectos/n8n --native-root <worktree>/release/native/darwin-arm64
--owners 2000 --mutations 1` for every recovery measurement (identical
invocation to P1-A). One real trap hit and fixed mid-session: the first
combined-item census (item 2 + item 3 together) accidentally measured item 3
**alone** — the native addon was rebuilt after item 3 but the item-2 source
edits were made afterward, before the *next* rebuild, so that run's
`namespace_import_member` count was unchanged (22) even though the item-2
code was already committed to source. Caught by cross-checking the
`checker_target` of the still-pending samples against the source file; fixed
by rebuilding native again before the next measurement. Recorded here as a
concrete trap for the next session: **a source edit only takes effect in the
census after `pnpm build:native` reruns**, and it is easy to lose track of
which native build a given `tmp-census-*.json` actually reflects.

## Work items, in the order implemented

### 1. Shallow return-type inference for unannotated functions/methods (fixed point) — SHIPPED

`urdira-jsts-typeflow` gained a third `ProgramIndex::build` pass. At
extraction time (`collect_pending_return_shapes` / `classify_return_shape` /
`collect_return_shapes_from_statement`, all new in `crates/urdira-jsts-typeflow/src/lib.rs`),
every unannotated function/method/object-shape-arrow-property's body is
walked (recursing through block/if/try/switch/loop/labeled statements, never
into a nested function/arrow/class — matches the existing nested-`this`
discipline) collecting each `return <expr>;`'s shape into a new
`DeferredReturnShape` enum: `Known(RawTypeRef)` (`new T()`, `this` as the
polymorphic `ThisType`), `MemberOf` (`this.member`/`this.member()`,
resolved against the SAME class's own member table, itself possibly also
still-inferring), `CallEntity` (a call to another top-level named function,
local or imported), and `AwaitOf` (one layer of `await` unwrapping around any
of those). **A single `Unknown`-shaped return anywhere in the body drops the
whole function's inference** — never a partial guess from the resolvable
remainder.

`ProgramIndex::build`'s new pass 3 closes every `CallEntity` import reference
against `import_targets` once (`prepare_return_shapes`), then iterates a
bounded fixed point (`MAX_ITERATIONS = 8`) re-polling `containers`/
`function_return_types` each round via `member_lookup_status`/
`resolve_prepared_shape` (a NEW status enum, `ShapeStatus::{Resolved,
Pending, Failed}`, distinguishing "this member exists but isn't resolved
yet — keep waiting" from "no such member — give up", a distinction the
existing `collect_member_type_ref`'s plain `Option` return could not make).
A function/method's shapes must all resolve to the exact same
`ResolvedTypeRef` to become CONFIRMED; if they resolve but disagree
(`ShapeResolution::Conflict`) the result stays `Unknown` — this session
does not have `possible`/union output wired (see item 4 below), so a
conflicting-return function is a known, deliberate non-recovery, not a
wrong-target risk.

`main.rs`'s `build_typeflow_program_index` gained `collect_pending_return_import`
(mirrors `collect_type_ref_import`) so a `CallEntity` naming an IMPORTED
function is captured into `needed_imports` the same way every other
cross-file reference already is.

9 new unit tests in `urdira-jsts-typeflow` (16 → 25): `new`-expression
inference, async wrapping in `Promise`, `this`-delegation between two
unannotated sibling methods needing 2 fixed-point iterations, `this` as
polymorphic `ThisType`, cross-function fixed point (function A calls
still-unannotated function B declared LATER in the file), `await`
unwrapping, a genuine conflicting-returns case staying `Unknown`, an
unclassifiable-shape return dropping the whole inference, and the widened
object-shape arrow-property case (P1-A required an explicit annotation on
every object-shape property; P1-B extracts it from the body when absent).

**Measured effect**: `call_expression_receiver` 1,017 → 1,010 (−7 in the
item-3-only run), `chained_member_of_call` 140 → 132 (−8),
`identifier_unannotated_local` 282 → 278 (−4). Modest. Root cause for why
it is not larger: see "Root causes" below — the corpus's dominant
`call_expression_receiver` mass turns out to depend on a TypeScript utility
type (`ReturnType<typeof f>`) this session did not add support for, not on
plain unannotated-function bodies.

### 2. `export * as X from "spec"` (lane 1) — SHIPPED

`urdira-jsts-syntax-worker::lib.rs`'s `visit_export_all_declaration` now
synthesizes a `SyntaxExportBinding` for `X` when the declaration carries an
`exported` name (`export * as X from "spec"`) — `local_name` is a new
sentinel constant, `NAMESPACE_REEXPORT_LOCAL_NAME = "*"` (never a valid JS
identifier, so it can never collide with a real re-exported name).
`export * from "spec"` (no name) is completely untouched — verified by a
dedicated regression test (`plain_export_star_still_synthesizes_no_binding`).

`resolver.rs`'s `ExportResolution` gained a new variant, `Namespace(String)`
(the re-exported module's own resolved path) — `resolve_named_export_inner`
recognizes the sentinel and short-circuits to it instead of chasing it as an
ordinary re-exported name; a DEEPER chain (`export * as X` of a module that
itself does the same) still resolves transitively for free, since the
CALLER re-invokes `resolve_named_export` against the returned path (a
regression test, `resolve_named_export_namespace_reexport_chains_transitively`,
locks this in).

`semantic_sites.rs` gained `namespace_reexport_targets: HashMap<SymbolId,
String>` (a NAMED import's own resolved re-export target, populated by a new
`register_namespace_reexport` called from `visit_import_specifier`) and
`resolve_namespace_member` was widened to consult it alongside the existing
`namespace_import_specifiers` (a direct `import * as ns`) — so `evals.member(...)`
resolves identically whether `evals` came from a direct namespace import OR
a named import of a re-exported namespace.

7 new unit tests (3 in `lib.rs` for the lane-1 synthesis + string-literal
export-name variant, 2 in `resolver.rs` for the resolution + transitive
chaining, 2 in `semantic_sites.rs` for the direct-namespace-call baseline
staying intact plus the new named-import-of-a-namespace-reexport case, found
live at `packages/@n8n/agents/src/__tests__/integration/evaluate.test.ts:3935`
→ `evals/string-similarity.ts:899:stringSimilarity`).

**Measured effect**: `namespace_import_member` 22 → 19 (−3; confirmed via the
census's own miss samples that the SPECIFIC `evals.stringSimilarity`/
`evals.correctness` sites from the P1-A doc are gone from the pending list).
The remaining 19 are a DIFFERENT namespace-shaped pattern (samples point at
`packages/@n8n/ai-workflow-builder.ee/evaluations/evaluators/binary-checks/types.ts:767:run`)
this session did not have time to root-cause to its exact source shape —
flagged as a residual for the next pass.

### 3. Call through a locally-typed callable — SHIPPED, measured zero on this corpus

A small, cheap, low-risk addition found while investigating the DB-migration
DSL pattern the P1-A doc flagged (`packages/@n8n/db/src/migrations/dsl/
{column,table}.ts`): `type_of_call_expression`'s `Identifier`-callee branch
now falls back to `local_types` when `resolve_identifier_to_kind(Function)`
fails — covering `createTable(name).withColumns(...)` where `createTable` is
a DESTRUCTURED method-valued binding (`record_destructured_object_types`
already stores a destructured method's own RETURN type as the binding's
recorded "value", by construction, so this is a new USE of an existing fact,
not a new lookup). One new regression test
(`typeflow_resolves_a_call_through_a_destructured_method_valued_parameter`).

**Measured effect: zero** on this corpus slice. Root-caused precisely (see
below): the actual live pattern is `schemaBuilder: ReturnType<typeof
createSchemaBuilder>` — a `ReturnType<typeof f>` UTILITY TYPE, which this
crate's type classifier (`raw_type_ref_of_ts_type`) does not understand at
all (falls to `RawTypeRef::Unknown` via the generic identifier-resolution
fallback, since `ReturnType` is a TS built-in global, never a local/imported
class/interface). `schemaBuilder`'s own type is Unknown, so `createTable`/
`column` never get typed via `record_destructured_object_types` in the
first place — this new rule never even gets a chance to fire. Utility-type
support (`ReturnType<>`, `Parameters<>`, ...) is a genuinely separate,
sizable feature, out of this session's remaining scope; flagged as the
single highest-value next lever given how repeated the migration-DSL
pattern is across `packages/@n8n/db/src/migrations/**`.

## Work items NOT implemented, with reasons (evidence-based, not just time)

- **Overload-aware member lookup (item 1).** Investigated with real evidence
  before writing any code: the census's own oracle samples show the checker
  resolving `Agent.resume(...)` calls to DIFFERENT overload SIGNATURES
  depending on the call site's own arguments (`method: 'generate'` →
  `agent.ts:19952`, `method: 'stream'` → `agent.ts:20080`) — never the
  implementation, never "the first signature". The task's suggested policy
  ("target = the implementation when present, else the first signature")
  would therefore produce a WRONG entity-id match for roughly half of these
  call sites — a real wrong-target risk this session chose not to ship
  against the project's own zero-wrong-target discipline. The SAFE version
  (match the call's own literal first argument against each overload
  signature's own literal-typed parameter, à la TypeScript's real
  discriminated-overload resolution) is a real, sound rule but needs new
  data (per-overload parameter shapes, not currently captured in
  `MemberEntry`) and new call-site plumbing (the actual argument AST at the
  point of resolution) this session did not have time to build and test
  rigorously enough to trust against the wrong-target bar. Left as a
  concretely-scoped follow-up, not a vague TODO.
- **Unions/bounded generics → `possible` (item 4).** Requires a NEW
  uncertainty-emission channel this session verified does not currently
  exist anywhere in the pipeline: `jsts:relation_call`'s `classification`
  field supports `"possible"` in the schema (`registry-contribution.ts`),
  but nothing in `urdira-jsts-syntax-worker`/`urdira-indexing-worker`
  currently EMITS a possible (as opposed to confirmed-or-pending) typeflow
  edge — `typeflow_call_rows`/`typeflow_heritage_rows` are exclusively
  confirmed, and a miss is exclusively left `checker_pending`. Building this
  channel (a `TypeflowValue::Union` value type, `MemberLookup`-style
  multi-target resolution over a union receiver, a new
  `typeflow_possible_call_rows` collection, main.rs wiring to turn those
  into `jsts:unresolved_call` records with `reason: union_ambiguous`, and
  the two new census buckets the task specifies) is a real, multi-file
  feature on its own — attempting it in the time remaining risked shipping
  something undertested against the wrong-target bar. Not attempted.
- **Built-in member table (item 5).** Same root blocker as item 4: the
  task's own framing ("emit a `jsts:unresolved_call` with `reason:
  external_module` ... and REMOVE the site from checker-pending") needs the
  SAME possible/reason-code emission channel item 4 needs, which does not
  exist yet. Additionally, detecting a "proven built-in receiver" (an array
  literal, `new Map()`, a `string`-annotated parameter, ...) needs a new
  `TypeflowValue` shape this session's `Entity`/`ArrayOf`/`PromiseOf`/
  `Inline` taxonomy does not have. The generator script and static table
  themselves would be quick to build in isolation, but wiring them to do
  anything observable needs items 4/5's shared infrastructure first — so
  building the table alone, unwired, was judged not worth the risk of
  looking like more progress than it is. Not attempted.

## Item 6: checker-OFF pipeline — SHIPPED and verified end-to-end

**Rust** (`crates/urdira-indexing-worker/src/main.rs`): the combined-generation
command handler now treats `request.semantic_engine` as absent whenever
`URDIRA_JSTS_TYPEFLOW=1`, regardless of what the caller supplied —
`semantic_checker` is `None` for the WHOLE generation, so `SemanticChecker::spawn`
is never called and the `tsgo` subprocess never starts. `hybrid_owner_can_skip_checker`
gained an explicit `checker_lane_disabled: bool` parameter (not a direct env
read, so its own unit tests can exercise both branches deterministically) and
now returns `true` unconditionally when it is set — its doc comment is
updated to say plainly that the REAL enforcement is the `semantic_engine`
gate above, not this still-unwired-into-any-live-loop predicate (a per-owner
SELECTIVE skip remains blocked on the checker's fixed 32-owner-per-group
response-reassembly stride, exactly as the pre-existing doc comment already
explained; a GLOBAL, uniform skip — every owner or no owner — has no such
hazard, which is what actually shipped). One new unit test
(`hybrid_owner_can_skip_checker_when_the_checker_lane_is_globally_disabled`).

**TypeScript**: `apps/urdira/src/index.ts` (the real production caller that
builds `semantic_engine` — NOT `packages/engine/src/rust-indexing-core-port.ts`
or `packages/plugin-javascript-typescript/src/indexing-core-process-transport.ts`,
both of which already declared the field optional and never themselves
construct it; that construction lives in `apps/urdira`, one layer up from
where the task's brief pointed) now skips building the `semantic_engine`
descriptor entirely when `URDIRA_JSTS_TYPEFLOW=1` — a pure efficiency mirror
of the Rust-side gate (Rust would ignore the field anyway; this avoids
spawning the worker-descriptor construction for nothing). `tsc --noEmit`
clean for both `apps/urdira` and `packages/plugin-javascript-typescript`.

`packages/plugin-javascript-typescript/src/registry-contribution.ts` gained
the `jsts:compiler_diagnostics_unavailable` completeness reason code the
task asked for, describing exactly the checker-off gap (no compiler
diagnostics observed because the checker never ran, as distinct from
`jsts:compiler_diagnostic`, an actual reported diagnostic, and
`jsts:unresolved_call`, one specific unresolved call site).

`jsts:diagnostic`/`jsts:compiler_diagnostic` records: confirmed never emitted
when the checker doesn't run, structurally (they are only ever produced from
the checker's own diagnostic stream in `analyzer.ts`; with `semantic_checker
= None`, that stream never exists for the generation at all — nothing needed
to change to guarantee this, it falls out of the checker never running).

### Verification (not just code review)

- **End-to-end run, checker genuinely never invoked**: `URDIRA_JSTS_HYBRID=1
  URDIRA_JSTS_TYPEFLOW=1` (no oracle) against a 500-owner slice completes
  successfully (cold + 1 mutation). The run log contains **zero**
  `[urdira] tsgo timing` lines — contrast with every ORACLE run this session
  (which deliberately keeps the checker alive for comparison), whose logs
  always show one (`requestCount: 33757, ...`). This is direct evidence the
  checker subprocess is not spawned, not just that its results are
  discarded.
- **Determinism (gate d)**: two independent checker-off runs of the same
  500-owner corpus slice produced byte-identical digests:
  `cold_visible_set_digest = sha256:d7098b68...` (both runs) and the same
  single mutation's `visible_set_digest` (both runs) — exact match, not
  approximate.
- **Gold manifests (gate b)**: `pnpm exec vitest run tests/codebase-fixtures.test.ts
  tests/javascript-typescript-plugin.test.ts tests/javascript-typescript-e2e.test.ts
  tests/javascript-typescript-production-e2e.test.ts` — **54 passed, 1
  skipped, 0 failed**, both WITH and WITHOUT `URDIRA_JSTS_TYPEFLOW=1` set
  (byte-identical pass/skip counts in both configurations). Honest caveat:
  the identical outcome across both configurations is itself evidence these
  four specific suites do not exercise the Rust worker/checker IPC path at
  all (they appear to run the JS/TS plugin's in-process analysis directly
  against small fixtures) — so this gate is GREEN, and confirms the new
  registry reason code and every other change in this session broke nothing
  these suites cover, but it is not independent proof of the checker-off
  behavior beyond what the preflight-harness runs above already show more
  directly.
- **Timing (gate e)**: same 500-owner slice, checker ON (`URDIRA_JSTS_HYBRID=1`
  alone) vs. checker OFF (`+URDIRA_JSTS_TYPEFLOW=1`): cold 20,779.7ms vs.
  21,231.7ms; the one mutation 1,377.6ms vs. 1,347.8ms. **No material
  difference at this scale** — at 500 owners the checker's own tsgo cost is
  evidently not the bottleneck (readiness/indexing phases dominate either
  way), so this session's own measurement does not show the speedup the
  task's framing anticipated. The task's own ≤ 6s full-corpus gate is
  explicitly the coordinator's to measure separately at full scale; this
  session's 500-owner slice is not that measurement and should not be read
  as it.

## Final classifier histogram (`checker_confirmed_rust_pending` = 2,127)

| shape | P1-A final | P1-B final | Δ |
|---|---:|---:|---:|
| `call_expression_receiver` | 1,017 | 1,008 | −9 |
| `identifier_other` | 245 | 245 | 0 |
| `identifier_unannotated_local` | 282 | 278 | −4 |
| `nested_member_chain` | 226 | 226 | 0 |
| `identifier_typed_lookup_failed` | 60 | 60 | 0 |
| `identifier_param_unannotated` | 84 | 84 | 0 |
| `chained_member_of_call` | 140 | 132 | −8 |
| `namespace_import_member` | 22 | 19 | −3 |
| `other_callee_shape` | 31 | 31 | 0 |
| `this_unresolved` | 20 | 20 | 0 |
| `computed_callee` | 14 | 14 | 0 |
| `static_member_via_class_name_lookup_failed` | 4 | 4 | 0 |
| `as_expression` | 4 | 4 | 0 |
| `new_expr_inline` | 2 | 2 | 0 |

### Root causes behind what's left, with samples

1. **`ReturnType<typeof f>` and other TS utility types (NEW finding this
   session)** — the dominant, previously-unquantified root cause behind the
   `chained_member_of_call`/`call_expression_receiver` mass in
   `packages/@n8n/db/src/migrations/**` (5 files sampled, all still pending
   after item 3): `schemaBuilder: ReturnType<typeof createSchemaBuilder>` in
   `migration-types.ts`'s `MigrationContext` interface. `raw_type_ref_of_ts_type`
   has no `ReturnType`/`Parameters`/... utility-type arm at all — it only
   special-cases `Promise`/`Array`/`ReadonlyArray` before falling through to
   plain-identifier classification, which correctly (not a bug) reports
   `ReturnType` itself as unresolvable (a TS built-in global, never a
   local/imported declaration). Every member destructured from
   `schemaBuilder` (`createTable`, `column`, ...) is therefore untyped from
   the start, and the FIX-A "call through a locally-typed callable" rule
   built this session never gets a chance to fire. Closing this needs a real
   utility-type resolver (`ReturnType<typeof f>` → `f`'s own return type,
   itself possibly through the SAME fixed point item 3 built) — flagged as
   the highest-value concrete next lever, given how repeated the migration
   DSL pattern is.
2. **Method overloads producing `MemberLookup::Many`** — unchanged from
   P1-A (`identifier_typed_lookup_failed` = 60, plus a share of
   `identifier_unannotated_local`/`this_unresolved`/`nested_member_chain`):
   `Agent.resume`/`generate`/`getState`'s overload signatures. See item 1's
   own "not implemented" entry above for the concrete evidence this session
   found about why the naive merge policy is unsafe.
3. **`call_expression_receiver`'s remaining mass (1,008)** — still a
   genuinely diverse long tail beyond the migration-DSL cluster: sampled
   targets span `packages/@n8n/agents/src/runtime/agent-runtime.ts`,
   `packages/@n8n/ai-workflow-builder.ee/evaluations/harness/harness-types.ts`,
   `packages/@n8n/backend-network/.../ssrf-protection.service.ts`, and more
   — no single remaining pattern accounts for more than a few dozen sites.
4. **A second, distinct `namespace_import_member` pattern (19 remaining)** —
   samples point at `packages/@n8n/ai-workflow-builder.ee/evaluations/
   evaluators/binary-checks/types.ts:767:run`, a DIFFERENT shape from the
   `export * as evals` pattern item 2 closed. Not root-caused to its exact
   source syntax this session for time; flagged for the next pass.

## External-target breakdown (unchanged from P1-A, item 5 not implemented)

`checker_confirmed_external_target` = 8,612, same as both prior sessions
(this crate never touches anything outside workspace source by construction).
`lib.es5.d.ts` alone is still ~59% of that bucket (Array/String/Object
prototype methods) — the built-in member table (item 5) remains the
highest-leverage NEXT addition for this specific bucket once the
possible/reason-code channel item 4 needs exists, per that item's own
"not implemented" entry above.

## Quality gates

- `cargo test --workspace`: every crate green, every iteration. Final counts:
  `urdira-jsts-typeflow` 25 (was 16, +9 new), `urdira-jsts-syntax-worker` 144
  (was 137, +7 new: 3 lane-1 export-binding tests + 2 resolver-namespace
  tests + 2 semantic_sites integration tests), `urdira-indexing-worker` 39
  (was 38, +1 new), others unaffected. 0 failed anywhere, throughout every
  iteration of this session.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean after every
  iteration.
- `cargo fmt --all -- --check`: clean.
- `tsc --noEmit` clean for `apps/urdira` and `packages/plugin-javascript-typescript`
  (the two TypeScript packages this session's item-6 changes touched).
- Gold manifests (`tests/codebase-fixtures.test.ts`,
  `tests/javascript-typescript-plugin.test.ts`,
  `tests/javascript-typescript-e2e.test.ts`,
  `tests/javascript-typescript-production-e2e.test.ts`): 54 passed, 1
  skipped, 0 failed, identically with and without `URDIRA_JSTS_TYPEFLOW=1`.
- Determinism: two checker-off runs of the same 500-owner slice, byte-
  identical `visible_set_digest` (cold and the one mutation).
- New unit tests, one per rule as instructed: 9 in `urdira-jsts-typeflow`
  (return-inference fixed point), 7 in `urdira-jsts-syntax-worker` (lane-1
  namespace re-export + the two integration cases), 1 in
  `urdira-indexing-worker` (checker-lane-disabled predicate) — 17 new tests
  total this session, all listed by name in their own sections above.

## Accepted precision regressions

**None.** Wrong-target stayed at 0/9,497 through every iteration of this
session (P1-A's own final number, unchanged) — every rule shipped this
session was measured before and after, and none moved it. The overload rule
(item 1) was explicitly NOT shipped specifically because prototyping it
honestly would have introduced a real wrong-target risk this session was not
willing to accept without a literal-discriminant-based safe version, which
there was not time to build and verify.

## Files

- `crates/urdira-jsts-typeflow/src/lib.rs`: `DeferredReturnShape`,
  `ReturnEntityRef`, `PreparedReturnShape`, `ShapeStatus`/`ShapeResolution`,
  `member_lookup_status`, `collect_pending_return_shapes`/
  `collect_return_shapes_from_statement`/`classify_return_shape`/
  `classify_call_identifier`/`collect_pending_return_shapes_concise`,
  `ProgramIndex::build`'s new third pass; `FunctionSummary`/`MemberEntry`
  gained `pending_return`/`is_async`; `summarize_object_shape` widened to
  infer unannotated arrow/function properties. 25 tests total.
- `crates/urdira-jsts-syntax-worker/src/lib.rs`: `NAMESPACE_REEXPORT_LOCAL_NAME`,
  `visit_export_all_declaration` widening, 3 new tests.
- `crates/urdira-jsts-syntax-worker/src/resolver.rs`: `ExportResolution::Namespace`,
  `resolve_named_export_inner`'s sentinel-checking branch, 2 new tests.
- `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`:
  `namespace_reexport_targets`, `register_namespace_reexport`,
  `resolve_namespace_member` widening, `type_of_call_expression`'s
  locally-typed-callable fallback, 3 new tests (2 for namespace re-export,
  1 for the destructured-callable call).
- `crates/urdira-indexing-worker/src/main.rs`: `collect_pending_return_import`,
  the `semantic_descriptor`/`typeflow_enabled()` checker-off gate,
  `hybrid_owner_can_skip_checker`'s new `checker_lane_disabled` parameter,
  1 new test.
- `apps/urdira/src/index.ts`: `typeflowCheckerLaneDisabled`, gating
  `semantic_engine` construction.
- `packages/plugin-javascript-typescript/src/registry-contribution.ts`:
  `jsts:compiler_diagnostics_unavailable` completeness reason code.
- Census raw output: `tmp-census-final.json` (worktree root, item 2+3+FIX-A
  combined, correctly rebuilt native), `tmp-preflight-2k-final.json`.
  Intermediate runs (`tmp-census-item3.json` — item 3 alone, stale native
  trap; `tmp-census-item23.json` — item 2+3 correct) kept alongside for the
  session's own audit trail. Checker-off determinism runs:
  `tmp-preflight-checkeroff-1.json`/`tmp-preflight-checkeroff-2.json`
  (500 owners each). None added to git.

Not committed (per instructions).
