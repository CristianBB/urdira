# v4 P1-C: utility types and the declared-type ceiling — 2026-09-02

Continuation of P1-B (`docs/evidence/2026-09-02-v4-p1b-typeflow.md`, 77.35% →
77.60%). Same flags, same corpus, same scope (`URDIRA_JSTS_TYPEFLOW=1`, off by
default). **Not committed**, per the task's instructions. Worked entirely
inside `~/Proyectos/urdira/.claude/worktrees/agent-adf2ed2e11c2fffb4`.

## Result up front

**Recovery moved from 77.60% to 77.84% on the same 2,000-owner cut, with
wrong-target held at 0.00% throughout every iteration** (`both_confirmed_
different_target` stayed 0/9,497 across every one of this session's five
measurement rounds). Small in absolute terms (+22 confirmed, −22 pending) —
the declared-type ceiling for this specific census's own scope
(`checker_pending` member/`this`/`super`/heritage calls) is close to
reached; the remaining ~2,100 sites need either overload/generic-instance
disambiguation this session did not build (see "Not attempted" below) or a
genuinely diverse long tail no single rule closes.

**The real news this session found is a second, much larger, PREVIOUSLY
UNMEASURED population**: 27,683 "identifier callee, uncertain target" call
sites (`call_target_uncertain`, more than half again the size of the
48,413-site population every prior P1 session measured) that typeflow's own
census never even looked at, because its scope was always "member/`this`/
`super`/heritage calls E1-E3 never attempted", never "a plain identifier
call E1-E3 tried and gave up on". A new rule (`destructured_method_call`)
closes 234 of these live — the migration DSL's own dominant, previously-
unclosed pattern (`await dropColumns(...)`, a bare call to a destructured
METHOD with no further chaining) — but the checker's own row at those same
234 spans is classified `"possible"`, not `"confirmed"` (TypeScript's own
structural-typing ambiguity for a destructured callable, independent of
this crate), so these 234 cannot be counted as verified "recovery" under
this task's own same-target cross-check; they are real, tested, and never
contradict a checker-confirmed target (0/234 `both_confirmed_different_
target`), but they are reported SEPARATELY (`identifier_calls`, a new
census bucket) rather than folded into the primary number, to keep it
comparable to every prior P1 session's own definition.

Two real, pre-existing infrastructure bugs were found and fixed live (see
their own sections below) — without them, this whole session's oracle
measurement loop was silently broken (P1-B's own checker-off feature
accidentally disabled the checker during oracle census runs too).

| | calls attempted | same target | different target | checker-confirmed, rust-pending | recovery | wrong-target |
|---|---:|---:|---:|---:|---:|---:|
| P1-B final | 48,413 | 7,370 | 0 | 2,127 | 77.60% | 0.00% |
| **P1-C final** | 48,413 | 7,392 | 0 | 2,105 | **77.84%** | **0.00%** |

New, separate population (never measured before this session):

| | attempted | checker "confirmed" + rust same | checker "confirmed" + different | rust-resolved but checker-side not "confirmed" | checker-confirmed workspace target, rust pending | checker-confirmed external target | both pending/possible |
|---|---:|---:|---:|---:|---:|---:|---:|
| `identifier_calls` | 27,683 | 0 | 0 | 234 | 3,618 | 426 | 23,405 |

## Method followed

Per the brief: read `docs/evidence/2026-09-02-v4-p1b-typeflow.md` and
`v4-p1a-typeflow.md` first; classifier-driven prioritization starting from
the highest-value root cause P1-B already identified (`ReturnType<typeof
f>` utility type in the migration DSL); native rebuilt (and re-signed —
see "Trap: code signing after rebuild" below) before every census;
`cargo fmt`/`clippy -D warnings`/`cargo test --workspace` green after every
iteration; `node scripts/n8n-incremental-preflight.mjs --corpus
~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02
--native-root <worktree>/release/native/darwin-arm64 --owners 2000
--mutations 1 --readiness-timeout-ms 3600000` for every recovery
measurement.

### Trap 1: code signing after a native rebuild

After the FIRST native rebuild this session, every subsequent preflight run
failed immediately with `NativeBindingError: ... library load denied by
system policy` — the freshly linked, ad-hoc-signed `urdira-native.node`
copied into a fresh temp directory by `prepareNativeRoot` failed macOS
Gatekeeper's signature check. Fixed by running `codesign --force --deep -s
- release/native/darwin-arm64/urdira-native.node` after every `pnpm
build:native` and before every measurement run — recorded here as a
concrete step the next session's own runbook needs, since P1-A/P1-B's own
docs never mention it (their rebuilds apparently didn't trip this,
possibly a difference in how the addon was linked that day).

### Trap 2: the oracle census was silently measuring almost nothing (real bug, fixed)

The FIRST measurement attempt this session produced a suspiciously fast
cold run (~19s for 2,000 owners, versus P1-B's own ~minutes-scale timings)
and an oracle census with `owners_censused: 2` — i.e., almost the entire
corpus was never even reaching typeflow's own resolution code at all.
Root-caused via `URDIRA_DEBUG_TIMING=1`: P1-B's own item 6 (checker-off
pipeline) added a gate in `crates/urdira-indexing-worker/src/main.rs`
(`semantic_descriptor = if typeflow_enabled() { None } else {
request.semantic_engine.clone() }`) and a mirrored TS-side gate in
`apps/urdira/src/index.ts` (`typeflowCheckerLaneDisabled`) that both treat
`URDIRA_JSTS_TYPEFLOW=1` as "never spawn the checker", **unconditionally**
— including when `URDIRA_JSTS_TYPEFLOW_ORACLE=1` is ALSO set, even though
the oracle census's entire purpose is comparing typeflow's own guess
against the checker's INDEPENDENT answer at the same span
(`census_typeflow_owner`), which structurally needs the checker to keep
running. With the checker never spawned, `observations` never carried a
single `core:call`/`core:inherits` row to compare against, so the census
came back essentially empty — not a crash, not an error, just silently
useless output. **Fixed** in both places: the gate is now `typeflow_
enabled() && !typeflow_oracle_enabled()` (Rust) / `... &&
process.env["URDIRA_JSTS_TYPEFLOW_ORACLE"] !== "1"` (TS) — the production
checker-off path (oracle NOT requested) is completely unaffected. Verified:
after the fix, the SAME 2,000-owner cut reproduced `attempted_sites:
48,413`, byte-identical to every prior P1 session's own denominator.

### Trap 3: a second silent-measurement bug, this time in MY OWN new code (found and fixed the same session)

After adding the `identifier_calls` census bucket (below), its own numbers
came back as an exact, suspicious `0` across the board despite `resolved_
by_rule` showing 234 live `destructured_method_call` hits and `call_and_
heritage_reason_counts` showing 27,683 matching sites. Root cause: `write_
typeflow_census`'s read-merge-write (needed because a cold generation and
each mutation generation each call `census_typeflow_owner` separately and
must accumulate into the SAME on-disk file) explicitly lists which fields
to sum — `combined.calls`/`combined.heritage`/`owners_censused`/... — and
the NEW `identifier_calls` field was never added to that list, so every
generation's own in-memory count for it was silently discarded on write.
**Fixed** by adding the missing merge line; a new regression test
(`write_typeflow_census_accumulates_identifier_calls_across_writes`) locks
this in — writes to the same path twice, asserts the SECOND read-back is
the SUM, not either individual write. Documented here explicitly because
it is the exact same CLASS of bug P1-B's own doc flagged once already
(`different_target_samples`/`checker_confirmed_rust_pending_samples`
needing `#[serde(default)]`) — a census field is easy to add and easy to
forget to wire into the merge, and the failure mode is silent (a plausible-
looking `0`, not a crash) both times.

### Trap 4: `engine:workspace_scan_enumeration_failed` flake, worse this session

The exact transient flake P1-A's own doc first described ("a file inside
the copied corpus's temp dir" going missing mid-scan, "a retry succeeded
cleanly both times") recurred throughout this session, but MORE
persistently — one measurement needed 6 consecutive attempts before
succeeding, and the checker-off determinism run needed one retry too. No
code in this session touches the copy/scan path this flake lives in
(`packages/engine/dist/directory-provider.js`), and machine load (`load
average 4.68` on 10 cores, mid-session) was visibly higher than idle —
this reads as environmental (shared-machine contention, per the brief's
own warning that other agents might be running builds concurrently: a
`node scripts/v4-scan.mjs` job against the SAME corpus WAS running
concurrently during part of this session, confirmed via `ps aux`), not a
regression. Recorded as a stronger version of the same trap for the next
session: budget for several retries, not one.

## Work items, in the order implemented

### Item 1: utility types (`raw_type_ref_of_ts_type`) — SHIPPED

All of the following land in `crates/urdira-jsts-typeflow/src/lib.rs`
(cross-file member/return-type extraction) with a mirrored, independently
resolvable half in `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`
(`type_ref_of_ts_type`, for a LOCAL parameter/variable annotation, which
does not need the deferred-resolution machinery below since `ProgramIndex`
is already fully built by the time a per-owner walk consults it):

- **`ReturnType<typeof f>`** (`RawTypeRef::ReturnTypeOfFn`) — `f`'s own
  declared OR fixed-point-INFERRED (P1-B's own shallow return-inference
  pass) return type. Needs a genuinely new mechanism: `ProgramIndex::
  build` gained a **fourth pass** (`resolve_raw_type_ref_deferred`,
  `contains_deferred`, `pending_deferred_functions`/`_members`/
  `_variables`), run AFTER the third pass (P1-B's fixed point) with its own
  small (4-iteration) fixed point, since `function_return_types` is not
  fully populated until then and a `ReturnType<typeof g>` can itself
  reference another still-queued entry.
- **`InstanceType<typeof C>`** — direct substitution to `C` itself (a
  constructor's instance type IS the class, generics already erased
  everywhere else in this crate).
- **`Awaited<T>`** — fully unwraps every `PromiseOf` layer `T` classifies
  to.
- **`Partial<T>`/`Required<T>`/`Readonly<T>`/`Pick<T, K>`/`Omit<T, K>`/
  `NonNullable<T>`** — erase to `T`'s own FULL member table unmodified, per
  the task's own explicit framing: a member `Omit` would have excluded (or
  `Pick` didn't select) still resolves to the SAME entity a direct
  reference to `T` would have meant — never a wrong target, only a
  theoretical over-acceptance this crate was never scoped to flag as a
  compile error anyway.
- **`Record<K, V>`** (`RawTypeRef::RecordOf`) — `V` unwrapped by a computed
  access (`a[i]`/`a["x"]`) the same way `ArrayOf` already is (mirrored into
  `ResolvedTypeRef::RecordOf`/`TypeflowValue::RecordOf` and `type_of_
  computed_member`'s unwrap arm).
- **Indexed access `T["k"]`** (`RawTypeRef::IndexedAccess`, string-literal
  key only) — member `k`'s own declared type on `T`, resolved through the
  SAME fourth pass as `ReturnTypeOfFn` (needs the final `containers` map).
- **Intersections `A & B`** — a synthetic, purely-internal container whose
  own member list is empty and whose `extends` is every classifiable
  operand IN ORDER (`heritage_target_of_ts_type`, widened to also
  synthesize a container for an inline `{ ... }` operand). `ProgramIndex::
  collect_members`'s EXISTING own-body-then-`extends`-in-order walk
  already gives exactly the "A first, on a name collision" priority the
  task asked for — zero new lookup logic needed, only a new way to
  populate `extends`.
- **Type aliases, Parameters<typeof f>, tuple element access** — NOT
  attempted (see "Not attempted" below).

9 new unit tests in `urdira-jsts-typeflow` (25 → 38, some of the 13 net-new
belonging to item 1's follow-on work below): `member_type_ref_resolves_
return_type_of_typeof_fn`, `return_type_of_typeof_fn_resolves_through_the_
shallow_inference_fixed_point`, `return_type_of_typeof_fn_resolves_across_
files_through_a_named_import`, `instance_type_of_typeof_class_resolves_to_
the_class_itself`, `awaited_unwraps_a_promise_of_local_class`, `partial_
readonly_pick_omit_and_non_nullable_erase_to_the_full_underlying_member_
table`, `record_value_type_unwraps_on_indexed_access`, `intersection_
merges_member_tables_with_left_operand_priority`, `indexed_access_by_
string_literal_resolves_a_named_members_declared_type`, `unrecognized_
utility_type_stays_unknown_never_a_guess`. 5 new unit tests in `urdira-
jsts-syntax-worker` mirroring the local-annotation half.

### Item 1, follow-on A: callable VARIABLES (`const f = (...) => {...}`) — SHIPPED

Investigating WHY the flagship pattern (`schemaBuilder: ReturnType<typeof
createSchemaBuilder>`, `packages/@n8n/db/src/migrations/migration-
types.ts:17`) still didn't resolve after item 1 landed found a second,
adjacent gap: `createSchemaBuilder` is `export const createSchemaBuilder =
(tablePrefix, queryRunner) => ({ createTable: ..., column: ..., ... })` —
NEVER a `function` declaration (`summarize_function` never saw it) and its
OWN initializer is an arrow FUNCTION, not a plain object literal
(`summarize_object_shape` never saw it either, since that function
requires the declarator's initializer to BE an `ObjectExpression`
directly). New `DeclSummary::callable_variables: Vec<FunctionSummary>`
(`collect_callable_variable`): a top-level `const f = (...) => ...`/`const
f = function(...) {...}` with an explicit return annotation, OR (no
annotation) a CONCISE arrow body whose single expression is directly an
object literal — synthesized into an `ObjectShapeSummary`
(`concise_arrow_object_literal_shape`, reusing the exact member-extraction
`object_shape_members_of` factored out of `summarize_object_shape`, so a
method inside it is STILL eligible for P1-B's own shallow return-inference
fixed point — this needed its own fix, since a callable-variable's
synthesized shape was initially pushed as a plain `InterfaceSummary`,
which the fixed point never scans). Merged into the SAME `function_return_
types` map a real `function`'s return type lives in, keyed by the
VARIABLE's own entity id — `ReturnType<typeof f>`'s own resolution does
not care which kind of declaration produced the entry. `classify_call_
identifier`'s existing (P1-B, unwidened) local-symbol gate was deliberately
NOT touched (it still requires `SymbolFlags::Function`, feeding the return-
shape fixed point this session did not want to risk perturbing); a NEW,
separate helper (`classify_typeof_target_identifier`) is used only by
`ReturnType<typeof f>`'s own resolution, accepting a plain variable symbol
too. 3 new unit tests: `return_type_of_typeof_fn_resolves_a_callable_
variables_concise_object_literal_body` (the exact flagship shape, full
end-to-end resolution verified: `ReturnType<typeof createSchemaBuilder>`
→ the synthesized shape → `createTable`'s own declared entity),
`callable_variable_with_an_explicit_return_annotation_resolves_like_a_
function`, `callable_variable_with_a_non_object_literal_body_stays_
unknown`.

### Item 1, follow-on B: nested destructured parameters — SHIPPED

Even with follow-on A, the flagship pattern's OWN call sites still didn't
resolve. Every migration in this corpus destructures straight THROUGH
`schemaBuilder` without ever binding a `schemaBuilder` local at all:
`async up({ schemaBuilder: { dropColumns } }: MigrationContext)`.
`record_destructured_object_types` (`semantic_sites.rs`) previously
required `property.value` to be a plain `BindingIdentifier`, `continue`-ing
past anything else — including a NESTED `ObjectPattern`. Widened: a
nested pattern recurses one level (`self.record_destructured_object_types
(nested, &resolved)`, `resolved` being the OUTER property's own just-
resolved type) — the exact same call the function's own caller already
makes for the outer pattern, just against a different base entity. 2 new
unit tests: `typeflow_resolves_a_nested_destructured_parameter_two_levels_
deep`, `typeflow_resolves_the_full_return_type_of_typeof_migration_dsl_
pattern_end_to_end` (all three fixes — `ReturnType<typeof f>` on a
callable variable, reached through a nested destructure — combined in one
test).

### Item 1, follow-on C: bare calls to a destructured METHOD — SHIPPED (new capability, unverified population)

Even with A and B, the migration DSL's OWN calls (`await dropColumns
('user', [...], {...})`) still didn't resolve — because `dropColumns`
returns `void` (`RawTypeRef::Unknown` in this crate's classification, `void`
has no `raw_type_ref_of_ts_type` arm), so P1-B's own "destructured-method
value IS its return type" hack (`local_types`, used for chain propagation:
`createTable(name).withColumns()`) had nothing to record — and even where
it does, that hack was ONLY ever useful for propagating a TYPE through a
FURTHER chain hop, never for resolving the bare call itself as a target.
New `destructured_member_entities: HashMap<SymbolId, String>` (the
member's own DECLARATION id, via `ProgramIndex::members`, attempted
INDEPENDENTLY of whether `member_type_ref` also succeeds) plus a new
identifier-callee branch in `resolve_call_target_typeflow` (checked before
the existing member-callee branch; a destructured binding can never also
be a real function declaration, so this cannot shadow anything E1-E3
already resolved). One EXISTING P1-B test's own expectation moved from 1
row to 2 (`typeflow_resolves_a_call_through_a_destructured_method_valued_
parameter` — `createTable("x")` itself is now ALSO resolved, a genuine new
correct edge, not a regression) plus 1 new unit test for the bare-call
case.

**This surfaced the large, previously-unmeasured `identifier_calls`
population documented up top** (see "Result up front"): 234 corpus-wide
hits, all structurally sound (0/234 contradicts a checker-confirmed
target) but unverifiable against this task's own same-target metric
because the checker's own row at those spans is `"possible"`, not
`"confirmed"` — plausibly because TypeScript's own structural typing sees
a destructured callable value as satisfying more than one interface
signature. Reported separately, not folded into the headline recovery
number.

## Work items NOT implemented, with reasons

- **Type aliases resolved transitively (item 1's own list).** Requires
  threading a THIRD accumulator (`alias_asts`/a resolved-alias memo map)
  through essentially every extraction function in the crate
  (`raw_type_ref_of_ts_type` and every caller up to `extract_decl_
  summary`) plus its own small fixed point for same-file alias chains —
  a real, mechanical, but substantial refactor this session judged not
  worth the risk relative to its unmeasured corpus frequency (no sampled
  miss this session pointed at a plain type-alias reference; `classify_
  heritage_identifier`'s existing import-branch already resolves a
  CROSS-file type alias's `Imported` shape safely to a miss, never a wrong
  target, so the status quo already degrades safely). Flagged as the
  highest-value NEXT utility-type lever given the time it would take.
- **`Parameters<typeof f>[i]`.** Needs a NEW per-parameter-position raw-
  type map on `FunctionSummary` (parallel to `return_type`) plus a tuple
  representation and its own indexed-access arm — real, scoped, but this
  session prioritized `ReturnType<typeof f>` (the corpus's own dominant
  pattern per P1-B's own root-cause analysis) and its two follow-on gaps
  first; not reached for time.
- **Array/tuple LITERAL element access (`[A, B]`'s own element types for
  `a[0]`).** `Array<T>`/`T[]`/`ReadonlyArray<T>` (already supported) cover
  the corpus's own actual usage; a literal tuple type's own oxc AST shape
  (`TSTupleElement`, an `#[ast]`-macro-generated inherited-variant enum)
  was not verified against a live corpus sample this session had time to
  find, so it was left out rather than guessed at.
- **Item 2 (generics instantiation with bounds).** Not attempted for time.
- **Item 3 (unions → `possible`) and its emission channel.** Not
  attempted for time — this is the single largest remaining lever
  (`checker_confirmed_external_target` = 8,612 is untouched, and the
  `possible`-edge channel item 6/built-in table also needs) but is its own
  multi-file feature (a new `TypeflowValue::Union`, `MemberLookup`-style
  multi-target resolution, a new `typeflow_possible_call_rows` collection,
  `main.rs` wiring into `jsts:unresolved_call` records) that this session's
  remaining time did not allow building AND testing to the wrong-target
  bar this task requires.
- **Item 4 (overload-aware member lookup by arity).** Not attempted —
  P1-B's own investigation (found in its own doc, unchanged this session:
  `Agent.resume`/`generate`/`getState`, `identifier_typed_lookup_failed` =
  60, unchanged) already showed the checker choosing DIFFERENT overload
  signatures depending on the call site's own literal arguments, never
  "the implementation" or "the first signature" — the SAFE version (match
  literal-typed parameters) needs new data this crate does not capture per
  member (`MemberEntry` has no per-overload parameter-shape list) and new
  call-site plumbing (the actual argument AST at resolution time). Still a
  real, scoped follow-up, not attempted this session for time.
- **Item 5 (second namespace-import pattern,
  `binary-checks/types.ts:767:run`).** Not root-caused this session;
  `namespace_import_member` stayed at 19, unchanged. Flagged again as a
  concrete, bounded next investigation.
- **Item 6 (built-in member table).** Not attempted — per P1-B's own
  finding, this needs the SAME `possible`/reason-code channel item 3
  needs (the task's own framing: emit `jsts:unresolved_call{reason:
  external_module}` and remove the site from pending), which does not
  exist yet.
- **Item 7's remaining census additions** (`rust_possible_includes_
  checker_target`/`rust_possible_excludes_checker_target`, `external_
  resolved_as_builtin`) are tied to items 3/6 respectively and were not
  built for the same reason. The NEW `identifier_calls` bucket (this
  session's own addition, not on the original list) is the one census
  extension this session did ship.

## Final classifier histogram (`calls.checker_confirmed_rust_pending` = 2,105)

| shape | P1-B final | P1-C final | Δ |
|---|---:|---:|---:|
| `call_expression_receiver` | 1,008 | 1,008 | 0 |
| `identifier_unannotated_local` | 278 | 278 | 0 |
| `identifier_other` | 245 | 237 | −8 |
| `nested_member_chain` | 226 | 214 | −12 |
| `chained_member_of_call` | 132 | 132 | 0 |
| `identifier_param_unannotated` | 84 | 82 | −2 |
| `identifier_typed_lookup_failed` | 60 | 60 | 0 |
| `other_callee_shape` | 31 | 31 | 0 |
| `this_unresolved` | 20 | 20 | 0 |
| `namespace_import_member` | 19 | 19 | 0 |
| `computed_callee` | 14 | 14 | 0 |
| `static_member_via_class_name_lookup_failed` | 4 | 4 | 0 |
| `as_expression` | 4 | 4 | 0 |
| `new_expr_inline` | 2 | 2 | 0 |

### Root causes behind what's left (this session's own additions to P1-B's list)

1. **`call_expression_receiver` (1,008, unchanged) is NOT the migration-DSL
   pattern any more** — that pattern's OWN call sites moved to the new
   `identifier_calls` population (see above), outside this histogram's own
   scope entirely (they were never `call_deferred_to_e3` sites: a bare
   identifier callee is always classified `call_target_uncertain`, a
   DIFFERENT reason, by `visit_call_expression`). The remaining 1,008 is
   confirmed, by elimination, to be the genuinely diverse long tail P1-B's
   own doc already described (no single pattern dominant), now that the
   migration DSL's own contribution has been fully investigated and
   resolved (in the OTHER population).
2. **Method overloads (`identifier_typed_lookup_failed` = 60, unchanged)**
   — see item 4's own "not attempted" entry; unchanged from P1-A/P1-B.
3. **The `identifier_calls` population's own `checker_confirmed_rust_
   pending` (3,618 of 27,683)** is the input for whatever session picks up
   items 3/4 next: this population was NEVER measured before this
   session, so it is a genuinely fresh 3,618-site opportunity, distinct
   from (and likely overlapping in ROOT CAUSE with) the overload/generic
   gaps items 2/4 would close — a plain identifier call E1-E3 could not
   confirm is very often a call through a value whose OWN type needed
   exactly the generic-instantiation or overload-arity reasoning this
   session did not build.

## External-target breakdown (unchanged in shape from P1-A/P1-B, item 6 not attempted)

`checker_confirmed_external_target` = 8,612 for `calls` (same as every
prior session), plus a NEW 426 for `identifier_calls` (a bare call to a
built-in, e.g. `Array.from(...)`, `Object.keys(...)`, resolved by the
checker to a `lib.*.d.ts` declaration typeflow never indexes by
construction). Basename breakdown for `calls`' own 8,612 (`lib.es5.d.ts`
5,382 — 62.5%, `lib.es2015.core.d.ts` 980, `lib.dom.d.ts` 842, `lib.
es2015.collection.d.ts` 778, `lib.es2015.promise.d.ts` 374, the remainder
under 150 each) — unchanged in shape from P1-A/P1-B; the built-in member
table (item 6) remains the highest-leverage NEXT addition for this
specific bucket once the `possible`/reason-code channel (item 3) exists.

## Quality gates

- `cargo test --workspace`: every crate green, every iteration. Final
  counts: `urdira-jsts-typeflow` 38 (was 25, +13 new: utility types +
  callable variables + intersections/indexed-access, listed by name
  above), `urdira-jsts-syntax-worker` 151 (was 144, +7 new: 5 local-
  utility-type tests + 2 nested-destructuring/end-to-end tests, plus 1
  EXISTING test's own expectation updated from 1 row to 2 for a genuine
  new correct resolution — see follow-on C), `urdira-indexing-worker` 40
  (was 39, +1 new: the census-merge regression test). 0 failed anywhere,
  throughout every iteration of this session.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean after
  every iteration.
- `cargo fmt --all -- --check`: clean.
- `tsc --noEmit` clean for `apps/urdira` (the one TypeScript file this
  session's checker-off-gate fix touched).
- Gold manifests (`tests/codebase-fixtures.test.ts`, `tests/javascript-
  typescript-plugin.test.ts`, `tests/javascript-typescript-e2e.test.ts`,
  `tests/javascript-typescript-production-e2e.test.ts`): **53 passed, 1
  skipped, 0 failed**, both WITH and WITHOUT `URDIRA_JSTS_TYPEFLOW=1` set
  (byte-identical pass/skip counts in both configurations, same honest
  caveat as P1-B's own doc: these four suites do not appear to exercise
  the Rust worker/checker IPC path directly, so this gate confirms nothing
  broke that they cover, but is not independent proof of the census
  numbers above).
- Determinism (checker OFF, 2×): two independent runs of the SAME 500-
  owner corpus slice (`URDIRA_JSTS_HYBRID=1 URDIRA_JSTS_TYPEFLOW=1`, no
  oracle) produced byte-identical digests — `cold_visible_set_digest =
  sha256:6018c966...` (both runs) and the same single mutation's
  `visible_set_digest = sha256:5f0518f0...` (both runs); zero `tsgo
  timing` lines in either run's log, confirming the checker subprocess is
  never spawned (not merely that its results are discarded) — this
  session's own fix to the checker-off/oracle gate (Trap 2 above) does not
  regress the production checker-off path itself.

## Accepted precision regressions

**None.** Wrong-target stayed at 0/9,497 for the primary `calls` census
through every iteration of this session, and 0/27,683 for the new
`identifier_calls` census (`both_confirmed_different_target` in both). The
234 `destructured_method_call` hits that cannot be verified against the
checker's own `"confirmed"` classification are reported as unverified
coverage of a new population, explicitly NOT counted toward the primary
recovery number — a deliberate choice to keep that number's own
definition comparable across sessions, not a discovered risk.

## Files

- `crates/urdira-jsts-typeflow/src/lib.rs`: `RawTypeRef::{RecordOf,
  ReturnTypeOfFn, IndexedAccess}`, `ResolvedTypeRef::RecordOf`,
  `return_entity_ref_of_type_query`, `classify_typeof_target_identifier`,
  `heritage_target_of_ts_type`, the utility-type dispatch block in
  `raw_type_ref_of_ts_type` (`ReturnType`/`InstanceType`/`Awaited`/
  `Partial`/`Required`/`Readonly`/`Pick`/`Omit`/`NonNullable`/`Record`),
  the new `TSIntersectionType`/`TSIndexedAccessType` match arms,
  `resolve_raw_type_ref_deferred`/`contains_deferred`/`ProgramIndex::
  build`'s new FOURTH pass, `DeclSummary::callable_variables`,
  `collect_callable_variable`/`concise_arrow_object_literal_shape`/
  `object_shape_members_of` (factored out of `summarize_object_shape`).
  38 tests total.
- `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`:
  `TypeflowValue::RecordOf`, the mirrored local-annotation utility-type
  dispatch in `type_ref_of_ts_type`, `record_destructured_object_types`'s
  nested-`ObjectPattern` recursion AND its new independent `destructured_
  member_entities` bookkeeping, `resolve_call_target_typeflow`'s new
  identifier-callee branch. 151 tests total.
- `crates/urdira-indexing-worker/src/main.rs`: the `semantic_descriptor`
  checker-off/oracle gate fix (Trap 2), `TypeflowCensus::identifier_calls`
  + `TYPEFLOW_REASON_CALL_TARGET_UNCERTAIN` + the widened `census_
  typeflow_owner` loop, `write_typeflow_census`'s merge-list fix (Trap 3).
  40 tests total.
- `apps/urdira/src/index.ts`: `typeflowCheckerLaneDisabled`'s matching
  oracle-mode exception (Trap 2, TS half).
- Census raw output (worktree root, none added to git): `tmp-census-p1c-
  item1e.json` / `tmp-preflight-2k-p1c-item1e.json` (final, post-every-fix
  2k measurement). Intermediate runs (`item1`, `item1b` through `item1d`)
  kept alongside as this session's own audit trail for the three traps
  above. Determinism runs: `tmp-preflight-p1c-detoff-1.json`/`-2.json`
  (500 owners each).

Not committed (per instructions).
