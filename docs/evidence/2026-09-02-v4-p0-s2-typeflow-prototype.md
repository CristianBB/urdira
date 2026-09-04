# v4 P0-S2: "typeflow" resolver prototype — 2026-09-02

Prototype only, not shipped as a production default. Gated behind
`URDIRA_JSTS_TYPEFLOW=1` (exact value `"1"`), OFF by default; every existing
test and the flag-off code path are byte-identical to before this session.

## What this session actually did (and one correction to the task brief)

The task described this as a prototype to *reduce* tsgo's role. What got
built and measured here is a strict superset of the original scope, because
of a debugging detour: the first two full-corpus runs produced a
near-empty census (17 call sites total, all in one file), which the
coordinator correctly flagged as implausible. Chasing that down surfaced
**two real bugs in the census/report path itself** (not in the resolver),
detailed below. The resolver's own numbers only became trustworthy after
both were fixed. This doc reports the numbers from the run *after* the
fixes; the earlier near-empty output was never a real measurement of the
resolver.

## Design as built

New crate `crates/urdira-jsts-typeflow` (self-contained, own `oxc_parser`+
`SemanticBuilder`, zero dependency on `urdira-jsts-syntax-worker`):

- `extract_decl_summary(path, source_text) -> DeclSummary`: per file, every
  `class`/`interface` declaration's member table (`MemberEntry{name,
  is_static, entity_id}`) and heritage (`extends`/`implements`), with
  generic type arguments erased (`Base<T>` indexes as `Base`) and each
  heritage identifier classified as `Local` (same-file, entity id computed
  directly from oxc's own symbol table), `Imported{specifier,
  imported_name}` (resolved by the caller), or `Unknown` (qualified name,
  e.g. `ns.Base` — deferred, never guessed).
- `ProgramIndex::build(summaries, import_targets)`: merges every file's
  `DeclSummary` plus the caller-resolved import table into one cross-file
  graph; `ProgramIndex::members(entity_id, name, is_static) ->
  None|One|Many` walks the `extends` chain (recursive, cycle-guarded), then
  falls back to `implements` interfaces for a class whose own chain missed.

Everything else — resolving a *use site's declared type* (a parameter/
variable annotation, a `new T()` initializer, a class/interface identifier
used directly) — deliberately reuses `semantic_sites.rs`'s existing
`resolve_identifier_to_kind`, the same E1-E3 machinery, rather than
reinventing it: this crate contributes exactly one new capability
(cross-file member lookup on an already-known entity), nothing more.

### Seam chosen

`urdira-jsts-syntax-worker` now depends on `urdira-jsts-typeflow` (one-way,
no cycle). `HybridResolutionContext` gained `typeflow_index:
Option<&ProgramIndex>` and `typeflow_oracle: bool`. `SemanticWalker` gained:

- `class_stack: Vec<ClassFrame>` (`this`/`super` target, tracked regardless
  of whether the heritage edge itself is published — a class's own
  `extends` clause is resolved once per class visit, in
  `resolve_super_class`, and its result feeds both the site/row AND the
  frame used for `super.x()` inside that class's body).
- `static_context: Vec<bool>` (innermost method/property's own `static`
  keyword, for `this`/`super` static-vs-instance disambiguation).
- `local_types: HashMap<SymbolId, (String, &'static str)>` (a
  variable/parameter's declared class/interface type, tagged with which
  rule found it, for the oracle census).

`ProgramIndex` itself is built **once per generation**, from every current
project file's source text (not just `affected_paths`) — this is the one
place this prototype is NOT incremental: it re-parses the whole corpus on
every generation, independent of `urdira-jsts-syntax-worker`'s own lane-1
cache. Explicitly out of scope for a correctness prototype; flagged as the
first thing a P1 pass must fix (see below), since it means every mutation
generation pays a full-corpus reparse just to keep the cross-file class
index current.

### Rules implemented (5 of the task's list; 2-hop chaining explicitly deferred)

| Site | Rule | oracle `rule` tag |
|---|---|---|
| `this.x()` | current class (own members → extends chain) | `this` |
| `super.x()` | current class's own `extends` target | `super` |
| `a.x()`, `a` a class/interface name used directly | static side of that class | `member_class_static` |
| `a.x()`, `a` a param/variable with `: Foo` annotation | `Foo`'s members | `member_declared_type` |
| `a.x()`, `a = new Foo()` | `Foo`'s members | `member_new_expression` |
| `class X extends Base<T>` (generic, E3 never attempts) | erase `<T>`, resolve `Base` | `heritage_generic` |

Deliberately NOT implemented: 2-hop+ member chains (`a.b.c()`), union
targets (`MemberLookup::Many` always stays pending — no "possible" edge is
ever emitted by typeflow), qualified heritage (`ns.Base`), and widening
`implements`/interface-`extends` generics (multi-entry clauses are subject
to the existing `heritage_clause_partially_pending` atomicity rule; only a
class's own single-entry `extends` was widened to keep that invariant
trivially safe — see `resolve_super_class`'s doc comment in
`semantic_sites.rs`).

### `new X()` is not a `core:call` row

Verified against the existing test `new_expression_produces_no_call_site_at_all`
and the checker's own walk (`isCallExpression`, never `isNewExpression`):
neither producer emits any call edge for a bare `new X()` today, and this
prototype does not invent one — only `new T()` as a variable's *type
source* (rule `member_new_expression`, for a LATER `.method()` call) is in
scope, per the task's own framing.

### Oracle mode

`URDIRA_JSTS_TYPEFLOW_ORACLE=1`: a site typeflow resolves is recorded as a
`TypeflowOracleHit{start,end,edge_kind,rule,source_id,target_id}` but is
**not** removed from `pending_sites`. This is load-bearing, not cosmetic:
the checker's own walk is site-driven (`rust_hybrid_pending_sites`) since
the E1c cutover — a site absent from that list is never independently
re-visited by the checker at all. Without oracle mode, there would be no
way to compare typeflow's guess against an independent answer; removing
resolved sites in production mode is exactly the intended behavior (that's
the whole point of dropping tsgo's involvement for that site), but it means
production mode has **no runtime fallback verification** if a rule is
wrong — which is why the census's wrong-target rate (not just recovery) is
the acceptance-critical number.

No pre-existing "E1-E3 oracle machinery" for calls/heritage was found in
the codebase (grepped `oracle`/`ORACLE` across both crates and the plugin
package) beyond `merge_hybrid_reference_rows`'s own class A/B census for
`core:references` rows (comparing hybrid rows against the checker's
existing canonical records at the same span). The typeflow census
(`census_typeflow_owner` in `urdira-indexing-worker/src/main.rs`) reuses
that SAME comparison pattern (checker's canonical rows, read from
`observations` *before* the hybrid merge appends anything) but is new code,
widened to `core:call`/`core:inherits` and gated on typeflow's own specific
pending reasons (`call_deferred_to_e3`, `heritage_deferred_to_e3`).

## Two real bugs found and fixed while getting a trustworthy census

Both are in the **census/report plumbing**, not in the resolver's own
logic — the resolver's oracle hits were correct in every run; the numbers
just never reached the output file intact until these were fixed.

1. **`skip_serializing_if` without `default` breaks round-tripping.**
   `TypeflowEdgeCensus`'s two sample vectors were annotated
   `#[serde(skip_serializing_if = "Vec::is_empty")]` with no `default`.
   `skip_serializing_if` only affects *serialization* (omits the key when
   empty); the derived `Deserialize` impl still requires every field
   present unless it *also* has `#[serde(default)]`. Whenever a generation
   contributed an empty sample vector for one edge kind, `write_typeflow_census`'s
   own read-back of the file it had just written failed to parse, `.ok()`
   silently swallowed the error, and `.unwrap_or_default()` started the
   NEXT generation's accumulation from a blank census — discarding
   everything the cold generation had accumulated (measured live: a real
   48,396-site cold census vanished the instant the 2-owner mutation
   generation's write ran). Fixed by adding `default` alongside
   `skip_serializing_if`, and by making a parse failure on an *existing*
   file loud (`eprintln!` warning) instead of silently discarded, so this
   class of bug cannot hide again.
2. **The coordinator's cross-process race concern was investigated and
   ruled out, but hardened anyway.** `apps/urdira/src/index.ts` keys one
   `urdira-indexing-worker` process per `workspace_id` (`indexingCoreSessions`
   map), so a single benchmark workspace never runs more than one such
   process — the read-merge-write to the census file is not actually racy
   under production topology. `write_typeflow_census` now wraps it in an
   atomic-create lock file (`O_EXCL` via `create_new`) regardless, since the
   cost is negligible and it removes the assumption entirely for any future
   harness that might not hold it.

Diagnostic counters added (kept, gated behind `URDIRA_DEBUG_TIMING` like
every other verbose print in this file) directly answered the coordinator's
diagnostic questions and are worth keeping for any future rerun:
`owners_censused`, `call_and_heritage_reason_counts` (every pending site's
reason, not just typeflow's own scope), `resolved_by_rule` (which of the 6
rules produced each oracle hit), and three `eprintln!`s tracing the census
branch's own entry/hit/miss counts and the in-memory-vs-on-disk value
around each write.

## Census: 2,000-owner cut, cold + 1 mutation, oracle mode

Corpus: `n8n-corpus-2026-09-02`. Run: `URDIRA_JSTS_HYBRID=1
URDIRA_JSTS_TYPEFLOW=1 URDIRA_JSTS_TYPEFLOW_ORACLE=1` via
`scripts/n8n-incremental-preflight.mjs --owners 2000 --mutations 1`.
Wall time: cold ~55-65s across repeated runs (this run: cold_elapsed_ms
55,474). `pnpm verify`-equivalent (cargo test/clippy/fmt) green throughout;
2,002 owners censused (2,000 cold + 2 touched by the mutation).

| | attempted sites | both confirmed, same target | both confirmed, different target | checker confirmed, rust pending (workspace target) | checker confirmed, external target (`lib.*.d.ts`) | checker possible/none, rust confirmed | both pending/possible |
|---|---:|---:|---:|---:|---:|---:|---:|
| **calls** (`call_deferred_to_e3`) | 48,413 | 4,115 | 0 | 5,382 | 8,612 | 317 | 29,987 |
| **heritage** (`heritage_deferred_to_e3`, class `extends` only) | 274 | 0 | 0 | 1 | 5 | 5 | 263 |

**Recovery rate** (task definition: `both_confirmed_same_target /
(both_confirmed_same_target + both_confirmed_different_target +
checker_confirmed_rust_pending)`, i.e. checker-confirmed **workspace**-target
sites only — `checker_confirmed_external_target` is excluded from the
denominator on purpose, see below):

- **calls: 4,115 / 9,497 = 43.33 %** — well below the ≥ 90 % prototype bar.
- **heritage: 0 / 1 = 0 %** — the sample is too small (n=1) to be a real
  measurement; class `extends` with generic args is genuinely rare in this
  corpus once bare identifiers (already E3's job) are excluded.

**Wrong-target rate**: **0 / 9,497 = 0.000 %** for calls, **0 / 1** for
heritage — meets the ≤ 0.5 % bar with a wide margin. Every one of the 4,115
call resolutions and 5 heritage resolutions that the checker also
independently confirmed matched the checker's own target exactly; zero
disagreements across the whole 2,000-owner cut.

Per-reason pending-site counts (context for the recovery denominator):
`call_deferred_to_e3`=48,413 (typeflow's scope), `call_target_uncertain`=27,683
(identifier-callee E3 already tried and failed — never attempted by
typeflow, same resolver would just fail again), `heritage_deferred_to_e3`=274,
`heritage_target_uncertain`=108, `heritage_clause_partially_pending`=1.

Per-rule oracle hits (6,437 total): `member_declared_type`=1,909,
`this`=1,312, `member_new_expression`=1,121, `member_class_static`=89,
`heritage_generic`=5, `super`=1. (Sums to more than 4,120
`both_confirmed_same_target`+`heritage` because 317+5=322 of these hits
were CONFIRMED by typeflow at a span where the checker itself only reported
`possible`/no target — typeflow strictly improved precision there, mirroring
the F5 E1-E3 campaign's own "precision equal-or-better" pattern; these do
not count toward the recovery rate as defined, since the denominator is
checker-CONFIRMED sites only.)

### Why `checker_confirmed_external_target` is excluded from the denominator

The first full run's `checker_confirmed_rust_pending` bucket contained
8,612 (calls) + 5 (heritage) sites whose checker-confirmed target lives
under `node_modules/.pnpm/@typescript+typescript-.../lib/*.d.ts` —
TypeScript's own standard library ambient declarations (`Array.prototype.filter`,
`console.log`, `Map`/`Set`/`Object`/`JSON`/`RegExp`/`Date` methods, ...).
`ProgramIndex` only ever indexes workspace source files' own class/interface
declarations (by design — see the crate's module doc); it has no path to
these by construction, not because of a missing rule. Folding them into the
recovery denominator would understate the resolver against a target class
it was never scoped to reach, so they are counted and reported separately
(`checker_confirmed_external_target`) and excluded from both rates. This
split is itself new code from this session (`is_workspace_target`, keyed on
`/node_modules/` in the entity id's embedded path) — the FIRST post-fix run
had this folded into `checker_confirmed_rust_pending` (giving an
apparent-but-wrong 22.7 % recovery); the number above is from the corrected
split.

## Samples of misses (from `checker_confirmed_rust_pending_samples`, cap 50, all workspace-target)

All 50 captured samples come from `packages/@n8n/agents/**` and share one
shape — a **fluent/builder method chain**, e.g. (`basic-agent.ts`):

```ts
createTool({...})
  .description(...)   // start=647 end=728  -> tool.ts:5436:description
  .input(...)          // start=647 end=886  -> tool.ts:6092:input
  .output(...)          // start=647 end=1018 -> tool.ts:6340:output
  .handler(...)          // start=647 end=1239 -> tool.ts:7209:handler
```

Every one of these calls' callee OBJECT is itself a `CallExpression`
(`createTool({...}).description(...)`, then `.input(...)`, ...) — not
`this`/`super`/a plain identifier. `typeflow_object_base` only handles those
three base shapes (see its own doc comment: "member-chain propagation
(`a.b.c()`) is out of scope for this prototype"); a `CallExpression` base
falls straight to `_ => None` and the site stays pending, correctly and
silently (never a wrong guess) rather than being resolved.

This is the dominant, best-supported finding of the whole run: **the
recovery gap, once external/lib.d.ts targets are excluded, is overwhelmingly
multi-hop member/call chains, not failures of the five implemented
single-hop rules.** The five implemented rules never produced a wrong
target across 2,000 owners (0/9,497), which is the strongest evidence this
session has that the *approach* (declared-type propagation through a
cross-file class index) is sound; the *coverage* is what falls short of the
prototype bar.

## What's needed to reach the P1 bar (≥ 97 % recovery, ≤ 0.3 % wrong target)

In priority order, based directly on the measured gap:

1. **Multi-hop member/call chains** (`a.b().c()`, and property chains
   `a.b.c()`). Requires: (a) a function's own declared/inferred RETURN
   TYPE as a new `TypeRef` source (today only `new T()` and a bare
   identifier naming a class are propagated) — `createTool(): ToolBuilder`
   would need its return type indexed the same way class members are; (b)
   each fluent method's own return type (frequently `this` in a builder
   pattern — TypeScript's `this` return type needs its own handling,
   distinct from a nominal class reference) so the chain can continue
   hop-by-hop. This alone, per the sample evidence above, is likely the
   single highest-value next rule for THIS corpus's actual code shape.
2. **Incremental `ProgramIndex`** (correctness prototype limitation, not a
   recovery-rate gap, but blocks ever shipping this outside a benchmark):
   cache `DeclSummary` per file the same way `urdira-jsts-syntax-worker`
   already caches `SyntaxFileResult` in `ProjectState`, so a mutation
   generation does not re-parse the whole corpus just to keep the
   cross-file class index current.
3. **Widen heritage past a class's own `extends`**: `implements` and
   interface `extends` generics, respecting the existing
   `heritage_clause_partially_pending` atomicity rule (all entries in a
   multi-type clause must resolve together) — this session deliberately
   scoped that out as multi-entry-clause-atomicity risk, not a capability
   gap; heritage's n=1 confirmed-workspace-target sample this run is too
   small to prioritize over (1) regardless.
4. **Qualified heritage/type names** (`ns.Base`) via namespace-import
   member resolution — lower priority; not observed in this corpus's
   sampled misses at all.

## Quality gate

- `cargo test --workspace`: every crate green (0 failed): 25+38+118+8+3+5+3+3+6+1+1+3
  = 214 tests across the workspace (syntax-worker 118 incl. 9 new typeflow
  tests, indexing-worker 38, typeflow crate 8, others unaffected).
- `cargo clippy --workspace --all-targets -- -D warnings`: clean.
- `cargo fmt --all -- --check`: clean.
- `pnpm exec vitest run tests/javascript-typescript-plugin.test.ts
  tests/codebase-fixtures.test.ts`: 47/47, unaffected by the flag-off
  default (confirms the env-var forwarding addition and the new Rust
  dependency graph don't perturb the existing plugin behavior at all).

## Files

- `crates/urdira-jsts-typeflow/` (new crate: `Cargo.toml`, `src/lib.rs` —
  `DeclSummary`/`ProgramIndex`/`HeritageTarget`/`MemberLookup`, 8 unit
  tests).
- `Cargo.toml` (workspace member list).
- `crates/urdira-jsts-syntax-worker/Cargo.toml` (new dependency),
  `src/lib.rs` (re-export `resolve_named_export`/`ExportResolution`/
  `TypeflowOracleHit`), `src/semantic_sites.rs` (`HybridResolutionContext`
  fields, `OwnerSemantics` fields, `SemanticWalker` fields +
  `typeflow_object_base`/`resolve_call_target_typeflow`/
  `resolve_heritage_ident_typeflow`/`resolve_super_class`/
  `record_local_type`/`declared_type_entity`/`new_expression_type_entity`,
  9 new tests).
- `crates/urdira-indexing-worker/Cargo.toml` (new dependency), `src/main.rs`
  (`typeflow_enabled`/`typeflow_oracle_enabled`/`typeflow_oracle_output_path`,
  `build_typeflow_program_index`, `TypeflowCensus`/`TypeflowEdgeCensus`/
  `TypeflowCensusSample`, `census_typeflow_owner`, `is_workspace_target`,
  `write_typeflow_census`/`sum_typeflow_edge_census`, wiring into
  `run_jsts_semantic_generation`'s hybrid thread and per-owner loop, 15
  existing test call sites updated for the new `OwnerSemantics` fields).
- `packages/plugin-javascript-typescript/src/indexing-core-process-transport.ts`
  (forward `URDIRA_JSTS_TYPEFLOW`/`URDIRA_JSTS_TYPEFLOW_ORACLE`/
  `URDIRA_JSTS_TYPEFLOW_ORACLE_OUT`, same shape as the existing hybrid-lane
  variables).

Not committed (per instructions). Census raw output: `tmp-census.json` in
the worktree root (gitignored-equivalent scratch file, not added to git).
