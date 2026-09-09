# Decision 28: v4 Rust semantic model — typeflow and the residual tsgo pass

Status: **Accepted**
Last updated: 2026-09-09
Depends on: [JavaScript/TypeScript MVP](07-javascript-typescript-mvp.md), [Rust native acceleration](25-rust-native-acceleration.md), [v4 structural store](26-v4-structural-store.md), [v4 Rust-owned scan pipeline](29-v4-rust-owned-scan-pipeline.md)
Reopens: E4 of `docs/evidence/2026-09-01-f5-hybrid-design.md` (see "Relation to E4")

## Current state (2026-09-09)

Typeflow runs unconditionally in v4 (P2-2e) with an incremental
`ProgramIndex` (P3-8a). A site neither the hybrid resolver nor typeflow can
resolve is no longer dropped and no longer bare-`possible`-with-no-target:
it lives in the store's `pending.sites` table with a reason code, and a
`possible` `core:call`/`core:inherits`/`core:implements`/`core:references`
row always carries a real `target_id` (see "The uncertainty contract, as
it stands" below — this superseded the original P2-2i "no `target_id`"
contract on 2026-09-05). The residual tsgo pass is wired into the worker
as a background `semantic_upgrade` generation (P1-D-c…h, opt-in via
`URDIRA_V4_RESIDUAL`). Candidate ambiguity (union/overload receivers,
sibling `extends`/`implements` overrides, unreliable receiver-typing rules)
is bounded by `MAX_CANDIDATE_TARGETS = 8`
(`crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`) — a candidate
set above that cap demotes to `checker_pending` with no candidate list at
all, never a guessed-down subset, never `confirmed` (see "Candidate
discipline, as it stands" below). Final measured parity vs. v3 (last
refreshed 2026-09-09, Frente E-P0r,
`docs/evidence/2026-09-07-v4-vscode-campaign.md` §18): n8n (unreduced)
`different == 0` in both the call and reference populations,
`confirmed_combined = 161,802`; VS Code (reduced corpus)
`different` = 80 references / 23 calls over roughly 2.46M / 0.36M
confirmed sites (0.003% / 0.006%) — every remaining VS Code `different`
sample is classified to an already-documented, out-of-scope root cause
(flow-sensitive narrowing the checker performs and typeflow's local
inference does not model, plus four small pre-existing unrelated
residuals); accepted with this figure by the owner on 2026-09-09 rather
than pursued further, since closing it needs real flow-sensitive type
narrowing, out of this decision's scope. Open: `rpc_error` 13,737 raw
sites; unions/overloads-as-per-candidate-possible-rows are built (2026-09-06
amendment below, superseding the original "not built" status).

## Context

The v4 plan (`resilient-knitting-twilight.md`) originally proposed replacing
the TypeScript-checker-backed ("tsgo") semantic lane entirely with a
Rust-native "typeflow" resolver: a declared-type-flow analysis over oxc's
AST that never spawns a compiler process. A prototype (P0-S2) and three
widening passes (P1-A, P1-B, P1-C) measured typeflow's actual recovery rate
against tsgo's own confirmed answers, on the real n8n corpus, before the
owner made a final call; the owner then authorized typeflow up to its
measured ceiling plus a residual checker pass outside the critical path.
Both halves are now built and measured end to end.

## Decision

### Semantic model that ships unconditionally: oxc + E1-E3 + typeflow

The existing hybrid semantic pipeline (`urdira-jsts-syntax-worker`, decision
25: `oxc_parser` + `oxc_semantic::SemanticBuilder`, lane-1 entity/`contains`/
`import`/`export` extraction, the E1a-E3 hybrid resolver for
identifier-local/single-declaration calls and simple heritage) is the
foundation. **Typeflow** (`crates/urdira-jsts-typeflow`) extends it with
cross-file declared-type resolution for the calls and heritage clauses E1-E3
leave pending. In the v3 pipeline it stays gated behind
`URDIRA_JSTS_TYPEFLOW=1` (off by default); **in v4 it runs unconditionally**
per the owner's 2026-09-02 decision
(`docs/evidence/2026-09-04-v4-p2-2e-typeflow-in-v4.md`).

- **`DeclSummary`** (per file, after `SemanticBuilder`): every class/
  interface/function/variable/object-shape declaration's member table,
  heritage, declared or fixed-point-inferred return type, and a
  `surface_hash`.
- **`ProgramIndex`** (global): merges every file's `DeclSummary` into one
  cross-file entity/export/heritage/subtypes graph; `members(entity, name,
  static)` walks `extends` then `implements`; a fourth pass resolves
  TypeScript utility types (`ReturnType<typeof f>`, `InstanceType`,
  `Awaited`, `Partial`/`Required`/`Readonly`/`Pick`/`Omit`/`NonNullable`,
  `Record<K,V>`, indexed access, intersections); a third pass resolves
  unannotated return types via a bounded (8-iteration) fixed point. Since
  P3-8a the index is **incremental**: `replace_file`/`add_file`/`remove_file`
  reflow only the edited file's transitive-importer component, and
  `v4/typeflow.rs`'s `TypeflowCache` keeps a persistent index plus a dirty
  set. Verified equal to a from-scratch index after every one of 400 random
  edits on a 70-file project, over 6 seeds; two bugs found on the way
  (importer edges dropped during `replace_file`; dangling entity ids after
  `remove_file`). Cost per steady edit went from 0.165-0.35 s (full rebuild,
  20-35% of a small edit) to under 0.5 ms for every mutation kind, including
  an 841-owner hub edit
  (`docs/evidence/2026-09-04-v4-p3-8a-rename-and-incremental-typeflow.md` §2).
  Cold: `build_full` 1.31 s sequential → 0.27-0.37 s after parallelizing
  (`docs/evidence/2026-09-02-v4-p2-2b-cold-pipeline.md` §18.5); `build_index`
  0.22-0.24 s; typeflow is ~1.8 s (~8%) of a cold n8n scan (P2-2e §3).
- **Resolution rules** (P0-S2/P1-A/P1-B/P1-C): `this`/`super`, a class/
  interface name used statically, a declared-type-annotated identifier,
  `new T()`, fluent/chained receivers via return-type propagation (including
  polymorphic `this`), `await` unwrapping one `Promise` layer, parenthesized/
  `as`/non-null/optional-chain transparency, array element access, namespace
  member calls (direct imports and `export * as X`), destructuring
  (including nested), object-literal and callable-variable shapes, heritage
  through a call expression (mixin factories), and inline object type
  literals.
- **Effect on the v4 corpus** (n8n, cold): `jsts:relation_call` 63,989 →
  96,373 (+50.6%), `jsts:relation_inherits` 549 → 786, total records
  1,521,196 → 1,553,019 (P2-2e §3). A later session measured 96,847
  confirmed calls on the same corpus; the 474-row drift is noted in P2-2i §6
  and not explained.

**Measured ceiling** (2,000-owner n8n cut, 48,413 attempted call sites,
identical corpus/flags across sessions; `URDIRA_JSTS_TYPEFLOW_ORACLE=1`
census — recovery = `same_target / (same_target + different_target +
checker_confirmed_rust_pending)`, external `lib.*.d.ts` targets excluded
from the denominator):

| Session | recovery | wrong-target |
|---|---:|---:|
| P0-S2 (5 rules) | 43.33% | 0.00% |
| P1-A | 77.35% | 0.00% |
| P1-B | 77.60% | 0.00% |
| **P1-C** | **77.84%** | **0.00%** |

Wrong-target held at 0/9,497 across every iteration. Root causes of the
residual ~22% (P1-A/B/C evidence): a diverse `call_expression_receiver`
long tail; method overloads (`MemberLookup::Many`, deliberately not
resolved); unions/bounded generics; a built-in member table for
`lib.es5.d.ts` methods; transitive type aliases; `Parameters<typeof f>[i]`.

### The uncertainty contract, as it stands

A site neither E1-E3 nor typeflow resolves is never dropped. As first built
(P2-2i), it was published as a `possible` relation with no `target_id` at
all, paired with a `jsts:unresolved_call` diagnostic — that original
contract is superseded (2026-09-05 amendment, folded in here): the cold
producer now materializes class/interface members, referenced parameters,
catch/rest bindings, ambient `declare module` namespaces, and external
package/symbol entities directly, so an unresolved site's candidate
target(s) usually already exist as real entities. The current contract:

- An unresolved call/heritage/reference site lives in the store's
  `pending.sites` table (reason codes 0-11, see "Candidate discipline,
  as it stands" below for the two newest codes), not as a bare diagnostic.
- A `possible` `core:call`/`core:inherits`/`core:implements`/`core:references`
  relation record **always carries a real `target_id`** — one row per
  candidate when there is more than one (facet `core:indirect`); the
  `jsts:unresolved_call` diagnostic kind is gone, its `reason` moved onto
  the pending site.
- The residual pass reads `pending.sites` directly (not derived from
  possible-row enumeration, superseding the P2-2i-era plan of deriving
  pending sites from possible rows) and, when it confirms a target, closes
  the site and every candidate row at the same span in the same
  `semantic_upgrade` generation; it additionally publishes inferred types,
  `type_of` relations, and compiler diagnostics in that generation.
- The originally-reserved taxonomy (`union_ambiguous`, `overload_ambiguous`)
  is now populated: an overloaded member (`MemberLookup::Many`) or a
  union-typed receiver (`MemberLookup::UnionCandidates`) always stays
  `possible` per candidate, never collapsed to one `confirmed` row
  regardless of how unanimous the candidates are (2026-09-06 amendment).
  Sibling-candidate ambiguity from `extends`/`implements` overrides is a
  further, later-added mechanism — see "Candidate discipline, as it
  stands".

On the original P2-2i n8n measurement, only two reasons were produced
(`call_deferred_to_e3` 376,133, `call_target_uncertain` 261,397), and
`core:call` totaled 734,379 = 96,847 confirmed + 637,530 possible —
exactly v3's historical `jsts:relation_call` total for the corpus, i.e. no
site-coverage gap between v3's checker walk and v4's enumeration
(`docs/evidence/2026-09-04-v4-p2-2i-possible-rows-and-pending-sites.md`).
Later amendments (below) added further reasons and changed the confirmed/
possible split; see "Current state" above for the final n8n/VS Code parity
figures.

**What the contract loses relative to the checker**: `EntityObservation.type`
is populated only from explicit annotations, `new` expressions, literals, or
resolved signatures; `jsts:compiler_diagnostic` records are never produced
on the critical path (no compiler runs there), reported via the
completeness reason `jsts:compiler_diagnostics_unavailable` — the residual
pass, when enabled, does publish them in its own generation (see above).

### Candidate discipline, as it stands

A member lookup that cannot be pinned to exactly one target never guesses:
it either stays `possible` with an explicit, bounded candidate list, or
demotes further to `checker_pending` with no list at all once that list
would be too large to be useful. The mechanism (all in
`crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`), assembled across
five amendments between 2026-09-06 and 2026-09-09 below:

- **Reliable-receiver rules** (`rule_pins_receiver_uniquely`): `this`,
  `super`, `ClassName.member` (`member_class_static`), `new ClassName()`
  (`member_new_expression`), a proven `instanceof` narrowing
  (`instanceof_narrowed`, suppressed for a call's own target resolution),
  and a proven `this is T`/`param is T` type-predicate narrowing
  (`type_predicate_narrowed`, both an `if`/`&&` positive form and VS
  Code's dominant `if (!x.hasModel()) return;` negated-early-return form).
  An explicit type annotation (`member_declared_type`) is **not** in this
  list as of the final (E-P0r) amendment — an annotation pins a receiver's
  *declared* type, not necessarily its narrower *actual* type at every read
  site, so it now goes through the same candidate check as any other
  unreliable rule.
- **Candidate collection**: when the receiver is pinned by a reliable rule
  and that type declares the member directly, the site is `confirmed`
  outright — no candidate check needed. Otherwise (an unreliable rule, or a
  member reached only through inheritance/conformance),
  `ProgramIndex::sibling_conformance_overrides` (the `extends`-only
  `sibling_extends_overrides` widened to `extends` **and** `implements`
  edges) finds every other known type that transitively conforms to the
  resolved receiver type and redeclares the same member.
- **The bound**: `MAX_CANDIDATE_TARGETS = 8`. A candidate set (including the
  originally-resolved target) of 8 or fewer demotes the site to `possible`
  with one row per candidate (reason `sibling_declaration_ambiguous` for an
  `extends`-only set, code 10); a set larger than 8 demotes instead to
  `checker_pending` with **no** candidate list at all (reason
  `sibling_conformance_unbounded`, code 11) — cost is bounded, correctness
  never is: an unbounded candidate set is never guessed down to a subset.
- **Explicitly not covered**: an INHERITED match reached only through
  control-flow narrowing this crate does not model (e.g. a `this is T`-typed
  guard method whose narrowing shape isn't one of the reliable rules above)
  is a distinct, unmodeled gap — reported, not silently misclassified as an
  ambiguity.

### The residual tsgo pass as built (P1-D-a…h)

The owner's 2026-09-02 amendment authorized a checker pass outside the
critical path, driven from Rust, publishing an improvement generation.
As built:

- **Client** (`crates/urdira-tsgo-client`, P1-D-a): a from-scratch JSON-RPC
  client for TypeScript 7's `tsgo --api --async` (LSP-style framing, a
  separate string id space for tsgo's own FS-callback requests, a binary
  AST decoder transcribed from `typescript@7.0.2`'s reference client — 44-byte
  header with the one `PROTOCOL_VERSION` byte this crate checks).
  `ResidualResolver::resolve` mirrors `analyzer.ts`'s algorithm. The wire
  protocol is unversioned beyond that byte; `tests/oracle_resolve.rs` must
  be re-run on any `typescript` upgrade.
- **Window/lane model** (P1-D-b): `WindowPlan::build` splits the sorted root
  list (every jsts source file in `frontier.present`, all 11 extensions —
  `.js`/`.mjs`/`.cjs` included, verified in final §3.1) into windows of 512;
  `ResidualPass::run` assigns contiguous window blocks to lanes, one thread
  and one long-lived `TsgoClient` per lane; per window: write the project
  config into an `OverlayFs`, `updateSnapshot`, resolve the window's pending
  sites in one call, classify, `release` the previous snapshot. Cross-window
  targets resolve through ordinary module resolution over the full virtual
  workspace map (verified with `window_size = 1`). Lib resolution
  (`LayeredFs`) serves exactly one real on-disk root, the
  `@typescript/typescript-<platform>` package's `lib/`; a workspace's own
  `node_modules` is never served from disk. `compiler_options` always sets
  `allowJs`/`checkJs` (P1-D-f §4; the missing pair produced 5,479
  `owner_file_not_in_project` misses). Lane count: `(available_parallelism/2).clamp(1, 6)`
  = 5 on the measurement machine; no production-scale sweep exists.
- **Worker integration** (P1-D-c): `scan::run_with_residual` calls
  `residual::schedule` after a successful `ScanCompleted` (cold or
  incremental) when `URDIRA_V4_RESIDUAL` is set. The pass runs on a
  background thread after a quiet period; a per-workspace epoch counter is
  bumped on every `schedule`, checked after the quiet period, after the
  checker pass, and per site before publish — a mismatch abandons the whole
  run (no partial publish). Results publish through the normal delta path as
  a `semantic_upgrade` generation (`publish_delta_with_kind`), emitting
  `IndexingEvent::UpgradeCompleted` via a dedicated pump thread in `main.rs`
  (a first version delivered the event late — fixed there).
- **Entity synthesis for members** (P1-D-d §3): v4's cold entity producer
  materializes only module-level declarations, but the checker resolves
  ordinary method-dispatch calls to class/interface members. The pass
  therefore synthesizes the missing member entity (`try_synthesize_member_entity`)
  inside the same `semantic_upgrade` generation, using the identical
  `jsts:{kind}:{path}:{start}:{name}` identity recipe as every other entity
  kind — so a future real member producer would continue the chain via
  `by_identity_last`, not collide. Kind words match v3's vocabulary byte for
  byte (`method` including `MethodSignature`, `constructor`, `property`,
  `getter`/`setter`, `parameter`, `variable`; an arrow-function target
  climbs to its `VariableDeclaration` name — each of these was a measured
  wrong-target source before P1-D-f §5). The same member problem on the
  **source** side silently dropped 147,442 pending sites until `collect()`
  learned to parse `source_id` from the identity key (P1-D-f §6).
- **Classification invariant**: for every relation row, the identity's
  `:unresolved` suffix (or absence) must agree with `target_subject.is_some()`,
  computed without decoding the body (`count_classification_mismatches`).
  The E1-E3/typeflow lane wrote `confirmed` + `target_id` for member targets
  the cold producer could never intern: 31,917 mismatched rows on n8n
  (~29K in P1-D-f's earlier build), which also explained the flat 15,590
  `confirmed_row_build_failed` bucket across three sessions (the dedup guard
  failed closed on the mismatched row itself, P1-D-g §2.2). P1-D-g's
  residual-side repair left 891; P1-D-h fixed the cold producer (decision
  29, stage 4): **0 mismatches** at both the cold and post-upgrade
  checkpoints, with the final resolved population unchanged
  (`docs/evidence/2026-09-05-v4-final-measurements.md` §2.6). The invariant
  is asserted in the n8n residual test and was the only signal that
  detected the (now-fixed, see decision 26's changelog) P2-2m corruption.
- **Batched symbol fetch** (P1-D-e): one bad `NodeHandle` in a batched
  `getSymbolsAtLocations` poisoned the whole batch; `fetch_symbols_chunked`
  (≤ 2,000 locations, per-location isolation on failure) cut raw
  `rpc_error` 219,348 → 101,861 without changing `upgraded` (recovered sites
  went to `no_symbol`).

**Residual pass result on n8n** (final §4.2, fresh cold + one pass;
identical across every clean run of the last three sessions):
`upgraded = 83,707`, `external = 41,001`, `unresolved = 546,650`; after
upgrade `core:call` confirmed 148,033 / possible 586,346, heritage
confirmed 1,868 / possible 1,305. Pass wall 61.2 s (`total_ms` 53,526) on
the in-process test path; tsgo child RSS was not collected.

**Parity method and numbers** (`scripts/v4-call-parity-diff.mjs`, P1-D-f
§2): every `core:call` v3 confirmed (retained v3 SQLite index of the same
corpus, 205,468 sites, opened read-only) is joined by `(path, start, end)`
to a v4 body dump carrying the store's own `target_subject` presence bit
plus the pass's per-site reason TSV, and classified.

| bucket | P1-D-f start | P1-D-f end | **P1-D-g / P1-D-h final** |
|---|---:|---:|---:|
| `v4_confirmed_same_target` | 79,363 (38.6%) | 89,707 (43.7%) | **112,565 (54.8%)** |
| `v4_confirmed_different_target` | 5,923 | 0 | **0** |
| `v4_missing_site` | 0 | 0 | **0** |
| `v4_possible` | — | — | 92,903 |

`v4_possible` reasons (final §2.6): `external_lib` 40,812, `no_symbol`
37,612, `rpc_error` 13,737, `workspace_target_pre_entity_lookup` 489,
`declaration_text_unavailable` 253 — the five sum with `same_target` to
exactly 205,468. Reverse direction: v4 confirms 35,468 sites v3 left
possible (typeflow's own contribution). Plan targets of ≥ 90% (P1-D-f) and
≥ 120,000 (P1-D-g) were **not met**; the ≥ 112,565 hold target was met
byte-identically by P1-D-h. The `external` (41,001, all sites the pass
classified external) and `external_lib` (40,812, only sites v3 confirmed)
figures are different populations; no evidence doc states that arithmetic.

**The deliberate `external_lib` policy**: a site resolving to a
`lib.*.d.ts` declaration (`JSON.stringify` → `lib.es5.d.ts`) is classified
`External` and **never promoted to confirmed** — synthesis is target-only
for workspace entities; there is no lib-global entity. v3 confirms such
sites. This is the largest single parity lever (40,812) and is a design
question — does "confirmed" mean a workspace declaration or any
declaration — deferred to the owner (P1-D-f §7.1); P1-D-g §4 confirmed the
query/diagnostic layer already treats external targets as an expected
analysis boundary, so no diagnostic is emitted for them and nothing is
broken. `no_symbol` (37,612) is a corpus property: the benchmark checkout
has no `node_modules`, unresolvable for v3 and v4 alike (P1-D-f §7.2).

### Relation to E4 (`docs/evidence/2026-09-01-f5-hybrid-design.md`)

E4, in the pre-v4 F5 hybrid-semantics design, proposed deferring the
checker-backed "stage 3" to a post-`structural_ready` generation, requiring
the owner's GO/NO-GO because it touches the readiness contract. The v4
amendment reopened exactly this question on a different foundation: typeflow
resolves the large majority of what E1-E3 could not, in Rust, on the
critical path; what remains for the deferred pass is a smaller residual run
from Rust via `crates/urdira-tsgo-client`. The owner's 2026-09-02
authorization is the explicit GO E4 required, and the pass as built never
gates readiness (it is opt-in and publishes after `ScanCompleted`).

## Consequences

- A v4 workspace's structural generation never blocks on a compiler
  process; the checker only improves precision after the fact.
- Typeflow's zero measured wrong-target rate across ~9,500 census sites,
  and the residual pass's 0 `different_target` across 205,468 v3-confirmed
  sites, are the evidence that both mechanisms are sound; their coverage is
  what falls short (77.8% recovery; 54.8% same-target parity, of which
  19.9 points are the `external_lib` policy and 18.3 points a corpus
  without `node_modules`).
- Every unresolved site is now query-visible as a `possible` relation with
  a reason, at the cost of +82% records (decision 29, open item 4).
- Any consumer relying on inferred type text for an unannotated local, on
  `jsts:compiler_diagnostic` rows, or on lib-target confirmed calls must
  account for the smaller surface.

## Open items (reported, not resolved)

- **`rpc_error` 13,737 parity-scoped (105,635 raw sites, 4,513 `.ts`
  owners).** The "`.js`/`.mjs`/`.cjs` excluded from roots" hypothesis is
  refuted (only 9 of 105,635 sites are in a non-`.ts` file, all in the one
  already-diagnosed `trim-fe-packageJson.js`; final §3). Most affected
  owners fail on a partial fraction of their sites (e.g. 37/108), heavily
  `__tests__`/`vi.mock` code — at least two mechanisms bundled, neither
  explained; three synthetic reproductions failed (P1-D-e §3, P1-D-g §3).
  The obvious fix (descending into a property-access callee's name) was
  tried and reverted after a live wrong-target regression (P1-D-g §3.2).
- **`external_lib` policy** awaits the owner's definition of "confirmed".
- **VS Code `different` does not reach 0** (80 references / 23 calls at the
  final 2026-09-09 measurement) — accepted with this figure by the owner;
  closing it needs real flow-sensitive type narrowing (tracking the actual
  initializer/assignment-site type through control flow), out of this
  decision's scope. See "Current state" above.
- **Lane-count tuning** has no empirical production-scale default (5 on the
  measurement machine); tsgo child RSS during a pass was never measured.
- **Overload-aware member resolution, transitive type aliases, a built-in
  `lib.es5.d.ts` member table** remain unimplemented typeflow levers.
- **`create` satisfying a previously-broken import** is not rediscovered by
  the incremental `ProgramIndex`'s `add_file` alone (P3-8a §2.2).
- **v4's alias fallback** confirms an alias's own import-specifier
  declaration when the real target is unresolvable (`import {expect} from
  'vitest'`), where v3 stays possible — a behavioral difference flagged for
  the resolver owner, not normalized (P1-D-f §7).
- **3 undecodable record bodies** (2 `core:call`, 1 `jsts:diagnostic`,
  zero-filled payloads) out of 2,831,264, pre-existing (P2-2i).
- Whether the hybrid lane's actual diagnostic emission call sites exclude
  externally-resolved sites was verified only against the schema's stated
  intent, not line by line (P1-D-g §4).

## Historial de cambios

- **2026-09-05** (`docs/evidence/2026-09-04-v4-pending-sites-fold-and-member-entities.md`): the cold producer began materializing class/interface members, referenced parameters, catch/rest bindings, ambient-namespace and external entities directly, and the classification invariant changed so every relation record carries a real `target_id` while an unresolved site lives in `pending.sites` instead of a bare `jsts:unresolved_call` diagnostic — see "The uncertainty contract, as it stands" above.
- **2026-09-06** (Frente F, `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`): documented explicitly (no code change) that a union/overload receiver never promotes to `confirmed`, only to `possible` per candidate — see "The uncertainty contract" above; separately, `parameter_entity_rows` began materializing a `jsts:entity_parameter` entity for every declared parameter/catch-binding rather than only referenced ones (n8n count 74,769 → 79,764, floor re-pinned in `docs/evidence/2026-09-07-v4-f3-cold-incremental-floors-parity-threshold.md`), and `get_outline`'s child ordering was hardened to sort by span start rather than by `core:contains` relation-record order.
- **2026-09-08** (Frente E-P0o, `docs/evidence/2026-09-07-v4-vscode-campaign.md` §15): added the sibling-candidate rule for an own-declaration member reached through an unreliable receiver rule with a known `extends`-descendant override (`sibling_declaration_ambiguous`), deliberately not generalized to an inherited match (a distinct, unmodeled control-flow-narrowing gap); VS Code residual 461/317 → 281/153 (references/calls).
- **2026-09-09, Frente E-P0p** (same evidence §16): generalized the sibling-candidate rule to inherited matches; added `this is T`/`param is T` type-predicate narrowing (both the positive and the negated-early-return idiom) as a new reliable rule; VS Code residual 281/153 → 189/58; n8n `confirmed_combined` 161,903, `different == 0` in both populations (unchanged).
- **2026-09-09, Frente E-P0q** (§17): generalized the sibling-candidate rule to `implements` conformance, introducing the `MAX_CANDIDATE_TARGETS = 8` cost bound (a larger set demotes to `checker_pending`/`sibling_conformance_unbounded` with no candidate list); added negated-`instanceof` early-return narrowing and standalone-function `param is T` narrowing; recorded a new `sibling_conformance_dependencies` incremental-consistency edge for a conformer reached with no backing import statement; VS Code residual 189/58 → 110/61; n8n `confirmed_combined` 161,903 → 161,843.
- **2026-09-09, Frente E-P0r** (§18, final refresh cited in "Current state" above): removed `member_declared_type` (an explicit type annotation) from the reliable-rule allow-list, so an annotated receiver now falls through to the same sibling-conformance candidate check as any other unreliable rule; VS Code residual 110/61 → 80/23, the largest single-session drop of the campaign; n8n `confirmed_combined` 161,843 → 161,802.


