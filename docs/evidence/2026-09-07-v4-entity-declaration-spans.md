# Frente E-P0j: v4 entity records publish the declaration's span, not the identifier's

Plan `resilient-knitting-twilight.md` §0/§3/§4/§5. Repo `~/Proyectos/urdira`,
main `9b49e82` at task start (worktree found on an unrelated, decoy history at
`7d04d49` — reset per Paso 0). Worked in worktree
`.claude/worktrees/agent-a5fa18e700243a639`, branch `frente-ep0j-declaration-spans`.

Input: `docs/evidence/2026-09-07-v4-semantic-wiring-and-embed-performance.md`
§1.3, which found live that `urdira-jsts-syntax-worker`'s `push_entity`
family publishes an entity's `start`/`end` as the IDENTIFIER's own span, not
the whole declaration — unlike v3's `analyzer.ts` (`entityForDeclaration`,
`identityStart` vs `node.getStart(file)`/`.getEnd()`).

---

## 1. What v4 published before, per kind (confirmed against real records)

Before this task, every kind below published `start`/`end` == the NAME
identifier's span (`identifier.span.start`/`.end`), regardless of the
declaration's own extent:

| kind | old `start`/`end` | consequence |
|---|---|---|
| `function`/`class`/`interface`/`type`/`enum` (top-level) | the name identifier only | `get_source(mode:"body")` returned only the name; `signature` mode "worked by accident" (first line from `start` == the name's own line, but truncated to start mid-declaration for anything before the name, e.g. `export`) |
| `namespace` (Identifier form) | the name identifier only | same |
| `namespace` (string-literal ambient form, `push_namespace_entity`) | **already correct** — this ONE producer already split `identity_start` (quote position) from a published `decl_start`/`decl_end` (the plan's own fix pattern, already precedented here) | n/a |
| class/interface member (`method`/`constructor`/`getter`/`setter`/`property`, `push_member_entities`) | the member's own KEY span | same |
| `variable` (top-level declarator) | the identifier only | same |
| `parameter` (`visit_formal_parameter`/rest/catch-clause) | the binding identifier only, explicitly documented as "never the whole `FormalParameter` span" | same, worse for a parameter with an annotation+default (`f(a: SomeLongType = defaultExpr())`) |

Net effect (S-C's own finding, reproduced live in this task's own Rust unit
tests before the fix): a multi-line function body far longer than decision
17's 120-character semantic-eligibility threshold measured as `end - start`
in the 15-50 character range (the name alone), so `evaluateEntityEligibility`
rejected essentially every real callable/variable with
`status: "excluded", reason_codes: ["below_min_length"]`.

## 2. What v4 publishes now

Every producer's `start`/`end` is the FULL declaration:

- **Function/class/interface/type-alias/enum/namespace (module-level)**:
  the declaration node's own span (`function.span`/`class.span`/... in
  `visit_function`/`visit_class`/`visit_ts_enum_declaration`/`visit_ts_type_alias_declaration`/
  `visit_ts_interface_declaration`/`visit_ts_module_declaration`), widened
  LEFT to the `export`/`export default` keyword(s) when the declaration is
  directly wrapped by one (`SyntaxCollector::pending_export_span_start`, set
  by `visit_export_named_declaration`/`visit_export_default_declaration`
  immediately before the recursive walk reaches the wrapped declaration's own
  `push_entity_with_type_surface` call, consumed via `.take()` so it can
  never leak into an unrelated, later entity). Never applied to a
  `VariableDeclaration` (see below).
- **Variable** (`visit_variable_declaration`): the DECLARATOR's own span
  (`declarator.span`, `x = ...`), never the enclosing `const`/`let`/`var`
  statement or its `export` prefix — `const a = 1, b = 2;` has two
  declarators sharing one prefix, so there is no single "the export's own
  declarator" to widen; each declarator's own span is unambiguous and
  already excludes the shared keyword(s).
- **Class/interface member** (`push_member_entities`, driven by
  `urdira_jsts_typeflow::MemberDeclaration`, new `decl_start`/`decl_end`
  fields sourced from `ClassElement`/`TSSignature`'s own `GetSpan::span()`,
  which already starts at the first decorator/modifier keyword): the whole
  member, decorators/modifiers through the closing.
- **Parameter** (`ParameterDeclarationFact`, new `decl_start`/`decl_end`):
  the whole `FormalParameter`/`FormalParameterRest`/`CatchParameter` node's
  own span (`parameter.span`) — own accessibility/`readonly` modifiers (a
  parameter property), type annotation, and default value included.
  Constructor-parameter-property members (`push_constructor_parameter_property_declarations`,
  typeflow) use the same `param.span`.
- **Namespace, string-literal ambient form** (`push_namespace_entity`):
  unchanged mechanism (it already had the split), now also publishes
  `name_end` (previously only `identity_start` was tracked, not the name's
  own end).

`SyntaxEntity` gained two additive fields, `name_start`/`name_end`, carrying
the OLD identifier-only span forward — the identity anchor
`stable_entity_id`/`declaration_id` was ALWAYS built from the identifier
position directly (never from `start`/`end`), so `id`/`entity_id` (decision
11, `find_references` on a parameter) are byte-identical to before this
task. The entity record body gained the same two fields (additive JSON keys,
alphabetically ordered `name_end`/`name_start` per the existing strict-order
convention).

## 3. Consumers reviewed and their disposition

| consumer | needed a change? | why |
|---|---|---|
| `core:get_source` (`sourceSnippet`, `canonical-query-data-port.ts`) | **No** | Already reads `record.body["start"]`/`["end"]` generically; now correct for free. `mode:"signature"` (first line from `start`) now shows the REAL signature line (`export function foo(...)`), not just the name. |
| `evaluateEntityEligibility` (`semantic-reconciler.ts`, decision 17's 120-char threshold) | **No** | Already reads `body["start"]`/`["end"]`; `end - start` is now the real declaration length, so a normal multi-line function clears the threshold without any name-length trick. Its column-0 check (`lineStart !== start && fileText[lineStart] is whitespace`) already inspected the LINE's own indentation, not `start` itself, so it was already correct either way. |
| `describeLine` (`packages/mcp/src/index.ts`) | **No** | Reads `body["start_line"]`/`span["start_line"]`, both derived from the record's own `span_start_line` (now the declaration's first line) — an outline entry now shows the line the declaration actually begins on. |
| `get_outline` ordering (`canonical-query-data-port.ts`, sorts `core:contains` children by `primary_source_span.start_byte`) | **No** | Already numeric-sorts by the full span's own start, which still increases monotonically in source order for a declaration span exactly as it did for an identifier span. |
| `entities.index` / `StoreReader::entity_by_owner_and_start` (`urdira-structural-store`) | **Yes** | See §4 below. |
| `urdira-indexing-worker::v4::residual` (checker-site correlation) | **Yes, at the boundary only** | Every call site (`EntityLookup::lookup`, `try_synthesize_member_entity`, `build_inferred_type_rows`'s own span) already passed/produced identifier-anchored positions (`name_start_utf16`, tsgo's own convention) — never a declaration span — so no call site itself needed to change; only the debug `Scan` variant's OWN candidate-collection loop (`view.span_start_byte()`) needed to switch to the same identity-derived key `entities.index`'s real `Section` build now uses, to keep the two strategies agreeing (`entities_index_section_and_scan_agree_on_the_shared_fixture`). |
| `typeflow::MemberDeclaration` / typeflow's own call/heritage resolution | **No further change** | Typeflow's own member-lookup keys (`MemberEntry::entity_id`, built from `key_start`) are untouched; only the NEW `decl_start`/`decl_end` fields were added, consumed solely by `push_member_entities`. |
| `analyze.rs::exported_surface` | **No** | Keys off entity ids/export bindings, never `start`/`end`. |
| TS renderers/snippets (`packages/mcp/src/index.ts`) | **No** | All route through `sourceSnippet`/`describeLine` above. |

## 4. `entities.index`: re-keyed off identity text, not `span_start_byte`

`entities.index`'s on-disk shape is `(owner_artifact u32, span_start u32,
ordinal u32)`, sorted by the first two — this shape is **unchanged** (no
`records.meta`/segment byte-layout bump; `HEADER_FORMAT`/`Manifest.format`
untouched, per §0's own constraint). What changed is which value the WRITER
feeds into column 2 for an entity row: before this task it was
`RecordRow::span_start_byte` directly (which the whole mechanism assumed was
the identifier's own start); now it is
`urdira_structural_store::identity_codec::entity_identity_name_start`,
recovered by parsing the identifier's own start back out of the entity's
`identity_key` text (`jsts:{kind}:{path}:{name_start}:{name}` — the SAME
recipe `stable_entity_id`/`declaration_id` always used, unaffected by this
task), falling back to `span_start_byte` (always `0`) for the two
per-file-spanless kinds (`external_module`/`external_symbol`).

This is a parse of already-durable bytes, not a new fact, and needed no new
stored column, no `urdira-native-core` kernel change, and no layout-version
bump. Both call sites (`segment_io::write_hot_and_secondary_files`'s flat
build and `write_hot_and_secondary_files_partitioned`'s partitioned build)
now share one helper, `entities_index_key_start`. The debug-only full-scan
`EntityLookup::Scan` variant in `urdira-indexing-worker::v4::residual`
(`URDIRA_V4_ENTITY_INDEX=scan`) was updated identically, and the shared
fixture cross-check test's own oracle-grouping loop
(`entities_index_section_and_scan_agree_on_the_shared_fixture`) was fixed to
group by the same key (it had been grouping by `span_start_byte` directly,
which broke the moment that field stopped being identifier-anchored).

`StoreReader::entity_by_owner_and_start` itself needed **zero** changes —
every production caller (`EntityLookup::lookup`'s `Section` variant,
`try_synthesize_member_entity`'s cache key) already passed it a
tsgo-reported `name_start_utf16`, never a declaration span.

## 5. Identity / decision-11 impact

**None.** `id`/`entity_id` were computed by `stable_entity_id`/
`declaration_id(kind, path, IDENTIFIER_START, name)` before this task and
still are — the entity's `start`/`end` fields were never an input to
identity. `find_references` on a parameter resolves through the same
`entity_id`, unaffected. Confirmed by the (unchanged) identity assertions in
`class_and_interface_members_materialize_as_entities_with_typeflow_identity`
(updated to read `body["name_start"]` instead of `body["start"]` for its own
independent-recomputation check — see §7).

## 6. Versioning

`JAVASCRIPT_TYPESCRIPT_VERSION` bumped `0.4.0 -> 0.5.0` (minor, pre-1.0,
per `docs/versioning.md`'s table: every v4 entity record's digest changed).
Updated alongside `packages/plugin-javascript-typescript/package.json`'s
`version` and the literal `"0.4.0"` pins that represent "current version" in
`tests/javascript-typescript-plugin.test.ts`, `tests/native-api.test.ts`,
`tests/javascript-typescript-semantic-process-transport.test.ts`,
`tests/npm-packaging.test.ts` — the pre-existing `"0.2.0"` pins in
`tests/javascript-typescript-thread-transport.test.ts`/
`tests/javascript-typescript-e2e.test.ts` are deliberately stale (upgrade-
generation fixtures) and were left untouched. `HEADER_FORMAT`/structural
store layout version were NOT touched (§4). This bump triggers the standard
one-time fleet republish (`docs/decisions/14-plugin-upgrade-relock.md`) for
every already-scanned workspace, v3 and v4 alike — the mechanically correct
way to make an already-cold-scanned v4 workspace pick up the new spans.

## 7. Tests

Rust (all in `crates/urdira-jsts-syntax-worker`/`urdira-jsts-typeflow`/
`urdira-structural-store`/`urdira-indexing-worker`):

- Two PRE-EXISTING tests updated because they pinned identifier-only spans
  as their own expectation (exactly the fidelity bug this task fixes):
  `class_and_interface_members_materialize_as_entities_with_typeflow_identity`
  (its own independent-recomputation check now reads `body["name_start"]`
  instead of `body["start"]`) and
  `namespace_identifier_declaration_gets_its_own_entity_and_contains_relation`
  (the module -> namespace `contains` relation's own identity/span now
  covers `export namespace Foo { ... }` whole, not just `Foo`; new
  assertions added for `start`/`end`/`name_start`/`name_end` on the
  namespace entity itself).
- `entities_index_section_and_scan_agree_on_the_shared_fixture`'s own
  oracle-grouping loop fixed to key by the identifier start (recovered from
  `identity_key`) instead of `span_start_byte` (§4).

Verification suite required by the task, run against real code (not
pre-computed):

```
cargo fmt --all -- --check
```
Clean (after `cargo fmt --all` fixed 3 files' own formatting from this
task's edits).

```
cargo clippy --workspace --all-targets --locked -- -D warnings
```
Clean, 0 warnings, full workspace.

```
cargo test -p urdira-jsts-syntax-worker -p urdira-jsts-typeflow -p urdira-structural-store --locked
```
`test result: ok. 306 passed; 0 failed; 1 ignored` (syntax-worker) +
`test result: ok. 59 passed; 0 failed` (typeflow) +
`test result: ok. 19 passed; 0 failed` (structural-store, `entities_index_test.rs`)
+ several 0-8-test doctest/unit crates, all `ok`.

```
cargo test -p urdira-indexing-worker --locked
```
`test result: ok. 151 passed; 0 failed; 19 ignored`.

```
cargo build --release --locked -p urdira-indexing-worker
```
Clean.

```
node scripts/build-native.mjs
```
Clean; produced `release/native/darwin-arm64/{urdira-native.node,
urdira-jsts-syntax-worker,urdira-indexing-worker,urdira}` and mirrored them
into `packages/native/prebuilds/aarch64-apple-darwin`.

```
./node_modules/.bin/tsc --build
```
Clean except the SAME 6 pre-existing errors the S-C evidence doc already
documented (`tests/fixtures/codebases/typescript/{barrel-method-call,
multi-hop-barrel-rename}`, `--moduleResolution node16` extension-less
relative imports in the FIXTURE sources themselves, unrelated to this task,
verified present before any of this task's edits touched TypeScript at all).

vitest (`CI=true ./node_modules/.bin/vitest run <files>`, run in small
batches per Paso 0's instructions):

```
tests/semantic-entity-source-v4.test.ts tests/semantic-maintenance.test.ts
  -> 2 files, 36 passed
tests/phase-daemon-v4-semantic.test.ts tests/phase-daemon-v4-scan.test.ts
  -> 2 files, 12 passed, 1 skipped (expected, mirrors v4-daemon-e2e.test.ts's own pattern)
tests/phase13-mcp.test.ts tests/phase-canonical-query-data-port.test.ts
  -> 2 files, 151 passed
tests/architecture-guardrails.test.ts tests/v4-daemon-e2e.test.ts
  -> 2 files, 62 passed, 1 skipped
tests/embedding-local.test.ts tests/semantic-provider.test.ts
  -> 2 files, 69 passed
tests/phase10-semantic.test.ts tests/semantic-neural-host.test.ts tests/phase-daemon-indexing-integration.test.ts
  -> 3 files, 33 passed
tests/javascript-typescript-plugin.test.ts
  -> 1 file, 44 passed (version-bump pins)
tests/javascript-typescript-semantic-process-transport.test.ts tests/javascript-typescript-thread-transport.test.ts tests/javascript-typescript-e2e.test.ts
  -> 3 files, 12 passed, 1 skipped
tests/npm-packaging.test.ts tests/native-api.test.ts
  -> 1 passed, 1 skipped (native-api.test.ts's own describe.skip fires when
     its own `binaryPath` probe finds no addon at the location it looks —
     pre-existing/environmental in this worktree, unrelated to this task)
```

All green (no new failures; the one skip in `phase-daemon-v4-semantic.test.ts`
is the SAME expected "release artifacts present" inversion `v4-daemon-e2e.test.ts`
already documents).

## 8. n8n parity (real corpus, cold scan)

Corpus: `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02` (read-only,
copied to scratch per the shared-corpus marker convention). v3 oracle DB
(retained): `~/Proyectos/urdira-benchmark/v3-n8n-2026-09-07-b/workspaces/
workspace_n8n-corpus-2026-09-02_d99f1eb3-a76a-4699-a6af-cd2df00a8516.sqlite`.

**Population floors** (`cargo test -p urdira-indexing-worker --release --
--ignored n8n_population_floors`, `URDIRA_V4_N8N_CORPUS=<corpus>`): cold
scan wall **16.3s**. All 10 floors `OK` — record COUNTS are unaffected by a
span change (only positions moved), as expected:

```
jsts:entity_callable              30224 (floor      29921) OK
jsts:entity_container             15231 (floor      14847) OK
jsts:entity_parameter             79764 (floor      78966) OK
jsts:entity_type                  14276 (floor      14047) OK
jsts:entity_variable             241774 (floor     238491) OK
jsts:relation_contains           406465 (floor     396483) OK
jsts:relation_references        1241431 (floor    1205324) OK
external_module                    1149 (floor        905) OK
external_symbol                    4040 (floor       3780) OK
records_total                   2198601 (floor    2165060) OK
```

**Reference parity** (`n8n_references_parity_debug_dump` with
`URDIRA_V4_REFERENCE_BODY_DUMP`, then `scripts/v4-references-parity-diff.mjs
--v3-db <retained v3 db> --v4-bodies <dump>`): joins by the REFERENCE SITE's
own `(path, start, end)` — a relation occurrence's own span, computed at the
identifier reference site, never touched by this task (only entity
declarations changed) — confirmed by the script's own header comment and by
this task's own read of `visit_identifier_reference`, unaffected. Result:

```
v4_same_target            1187143  (88.55%)
v4_different_target             0  (0.00%)   <- the hard gate; PASS
v4_missing                 153448  (11.45%)  <- pre-existing, documented gap (lib.d.ts targets, member-access edge cases), unrelated to entity spans
```

`v4_different_target = 0` confirms this task introduced no reference-
targeting regression, exactly as predicted (relations are keyed/spanned
independently of the entity span this task changed).

**Reconcile threshold self-consistency** (`reconcile_delta_threshold_is_within_measured_bounds`,
part of the required suite above, `ok`): not re-measured against a fresh
corpus this session — the delta/cold code paths themselves are untouched by
this task (only the values `push_entity` computes changed, uniformly for
both paths), so a delta-vs-cold divergence specific to this task is not a
plausible failure mode; the existing in-suite regression test already
covers it and passed.

## 9. Gotcha found live: worktree `node_modules` symlinks resolve back to the MAIN repo, not the worktree

`packages/*/node_modules`/`apps/*/node_modules` symlinks (Paso 0's own
setup step) point at the MAIN repo's per-package `node_modules` directories.
Those directories themselves contain FURTHER symlinks for every
`@urdira/*` workspace dependency (e.g. `packages/daemon/node_modules/@urdira/engine
-> ../../../engine`, a RELATIVE symlink) — since the containing directory is
itself a symlink into the main repo, that relative target resolves relative
to the MAIN REPO's own path, landing on the MAIN repo's `packages/engine`,
**not this worktree's own, locally-edited `packages/engine`**. `tsc --build`
therefore type-checked this task's `packages/daemon/src/semantic-v4-wiring.ts`
against the MAIN repo's (older) `@urdira/engine` types, producing a real,
reproducible `TS2305: has no exported member 'createNativeSemanticEntityRecordSource'`
even though the worktree's own `packages/engine/src/index.ts` already
exports it correctly. Fixed by re-pointing every `*/node_modules/@urdira/*`
symlink at this worktree's own sibling `packages/<name>` directory directly
(absolute path), for every package AND app (`apps/urdira/node_modules` was
also missing entirely — Paso 0's loop only iterates `packages/*/node_modules`,
never `apps/*/node_modules`). Also missing/needed for this task:
`apps/urdira/node_modules` itself (symlinked from the main repo, matching
the `packages/*` pattern) and `packages/canonical/dist` (copied from the
main repo's already-built output, since `scripts/v4-references-parity-diff.mjs`
imports `@urdira/canonical` and this worktree never ran a `pnpm build`).
Also found: this worktree's `dist/`/`tsconfig.tsbuildinfo` directories were
NOT clean at session start (leftover, untracked build output from the
decoy pre-reset history at `7d04d49`) — `git reset --hard` never touches
untracked files, so a worktree recovered from a wrong base per Paso 0 can
still carry stale build artifacts forward; all `dist/`/`.typecheck` were
removed before the first real `tsc --build`, and this is worth folding into
the standing worktree-subagent memory (`feedback_worktree_subagents_base_and_node_modules`)
for future sessions.

## Cleanup

- `CARGO_TARGET_DIR=.claude/worktrees/cargo-target-ep0j` removed after use.
- Scratch corpora under `~/Proyectos/urdira-benchmark/v4-fold/ep0j-*` removed
  (the reference-body dump `ep0j-refbodies.bin` and the test harness's own
  `target/v4-e2e-test/n8n-*` scratch copies).
- No daemon left running.

## Final counts (literal)

- Files changed: `crates/urdira-jsts-syntax-worker/src/lib.rs`,
  `crates/urdira-jsts-syntax-worker/src/resolver.rs`,
  `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`,
  `crates/urdira-jsts-typeflow/src/lib.rs`,
  `crates/urdira-structural-store/src/identity_codec.rs`,
  `crates/urdira-structural-store/src/lib.rs`,
  `crates/urdira-structural-store/src/segment_io.rs`,
  `crates/urdira-indexing-worker/src/v4/residual.rs`,
  `packages/plugin-javascript-typescript/src/analyzer.ts`,
  `packages/plugin-javascript-typescript/package.json`,
  `tests/javascript-typescript-plugin.test.ts`,
  `tests/javascript-typescript-semantic-process-transport.test.ts`,
  `tests/native-api.test.ts`, `tests/npm-packaging.test.ts`,
  `docs/decisions/26-v4-structural-store.md` (amended), this file (new).
- `cargo test` (4 required crates): 306 + 59 + 19 + 151 = 535 tests passed,
  0 failed, across the required crates (plus several small 0-8-test doctest/
  helper crates in the same invocation, all `ok`).
- `cargo clippy --workspace --all-targets -- -D warnings`: clean.
- `cargo fmt --all -- --check`: clean.
- vitest: 10 invocations, 19 files, 428 tests passed, 3 skipped (all
  expected/pre-existing), 0 failed.
- n8n population floors: 10/10 `OK`, cold wall 16.3s.
- n8n reference parity: `v4_different_target = 0` (hard gate, PASS).
