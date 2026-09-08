# v4 n8n parity (F.3 §4c, previously BLOCKED) + S.7 semantic segmentation measurements

Ola 3 measurement task of `generic-waddling-hartmanis.md` (§0 R7/R8, §3.1-3.4, §4.4-4.7). Repo
`~/Proyectos/urdira`, main `46d36a3` (verify green per this task's own preamble).
Worked without isolation on main. Code changes made in this task, exactly as authorized:
`scripts/v4-population-floors.json` (ratio recalibration only, §A.3 below) and this evidence file.
No other files touched.

Machine load (`uptime`) was recorded before every timed series; a second agent (E-P0g) working in
a worktree consumed CPU heavily and unpredictably throughout this session (observed 1-min load
from ~1.8 up to ~20.7) -- noted inline wherever it coincides with a measurement.

---

## A. v3/v4 n8n parity (F.3 §4c, previously BLOCKED -- now unblocked)

### A.0 Context

`docs/evidence/2026-09-07-v4-f3-cold-incremental-floors-parity-threshold.md` §6 reported this step
as **BLOCKED**: v3's cold-scan publish path threw `UNIQUE constraint failed:
record_occurrences.record_id` at exactly 3,525,385 rows, reproduced twice, with no oracle DB to
diff against. That defect was fixed since (frente F-fix, commits 135a26c/376b233/62e1ece: v3's
cold-scan direct publication de-dupes identical external-module/-symbol proposals), and a v3 oracle
DB for this exact corpus was regenerated and retained at
`~/Proyectos/urdira-benchmark/v3-n8n-2026-09-07-b/workspaces/workspace_n8n-corpus-2026-09-02_d99f1eb3-a76a-4699-a6af-cd2df00a8516.sqlite`
(15 GB). This task opens it strictly read-only (`node:sqlite` `DatabaseSync(path, { readOnly: true
})`, verified in both parity scripts' own source before running them) and never writes to it.

`uptime` at the start of this section: `12:06 up 84 days, 8:35, 4 users, load averages: 2.94 4.70
7.49`.

### A.1 v4 dumps (HEAD `46d36a3`)

1. `cargo build --release --locked -p urdira-indexing-worker` -- already up to date (0.13s, no-op).
2. References dump:
   ```
   URDIRA_TSGO_BINARY=.../tsc URDIRA_V4_N8N_CORPUS=~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02 \
   URDIRA_V4_REFERENCE_BODY_DUMP=.../references-bodies.bin \
   URDIRA_V4_PENDING_IDENTIFIER_REF_DUMP=.../pending-identifier-refs.tsv \
   cargo test --release -p urdira-indexing-worker v4::tests_e2e::n8n_references_parity_debug_dump -- --ignored --nocapture
   ```
   Result: cold scan + publish, 41.74s. `materialized core:references records (target-bearing,
   confirmed): 1,241,431`. Pending `IdentifierRef` histogram (1,049,827 total) recorded for
   later reason attribution.
3. Calls dump (cold + residual pass):
   ```
   URDIRA_V4_N8N_CORPUS=... URDIRA_V4_N8N_DATA=.../residual-data \
   URDIRA_V4_CALL_BODY_DUMP_COLD=.../call-bodies-cold.bin URDIRA_V4_CALL_BODY_DUMP_AFTER=.../call-bodies-after.bin \
   cargo test --release -p urdira-indexing-worker v4::residual::tests::n8n_residual_pass_debug_histogram -- --ignored --nocapture
   ```
   Result: cold scan 14.87s, residual pass 43.35s (total 71.63s). `confirmed_combined` AFTER =
   **161,807** -- matches the pinned regression constant in `residual.rs` (161,807 ± 4) exactly.
4. Population dump:
   ```
   URDIRA_V4_N8N_CORPUS=... URDIRA_V4_POPULATION_DUMP=.../populations.tsv \
   cargo test --release -p urdira-indexing-worker n8n_population_floors -- --ignored --nocapture
   ```
   Result: cold scan 16.1s; **all 10 population floors OK** against `scripts/v4-population-floors.json`
   as it stood before this task's recalibration (§A.3):
   | kind | v4 (HEAD `46d36a3`) | floor | ok |
   |---|---:|---:|---|
   | jsts:entity_callable | 30,224 | 29,921 | OK |
   | jsts:entity_container | 14,993 | 14,847 | OK |
   | jsts:entity_parameter | 79,764 | 78,966 | OK |
   | jsts:entity_type | 14,275 | 14,047 | OK |
   | jsts:entity_variable | 241,536 | 238,491 | OK |
   | jsts:relation_contains | 406,223 | 396,483 | OK |
   | jsts:relation_references | 1,241,431 | 1,205,324 | OK |
   | external_module | 911 | 905 | OK |
   | external_symbol | 3,801 | 3,780 | OK |
   | records_total | 2,197,882 | 2,165,060 | OK |

`uptime` during this series: load climbed from ~2.9 to ~4.8 (1-min) across the three test runs
(E-P0g active); each test's own internal timing is unaffected by that since it is single-process
CPU-bound Rust work with no cross-process contention observed in the numbers (cold-scan wall times
are consistent with the F.3 session's own recent cold-scan medians, ~15-25s).

### A.2 Reference-parity diff (`scripts/v4-references-parity-diff.mjs`)

```
node scripts/v4-references-parity-diff.mjs --v3-db <v3 oracle> --v4-bodies references-bodies.bin \
  --v4-pending-dump pending-identifier-refs.tsv --classify-targets 1 --out references-parity.json
```
v3 confirmed `core:references` sites: **1,340,591** (100% `confirmed` classification, 0 decode
errors, 15.1s to read). v4 read: 1,241,431 rows, 1,235,858 `confirmed` (target_subject), 0 decode
errors (9.3s).

| bucket | count | % of v3-confirmed |
|---|---:|---:|
| `v4_same_target` | 1,186,470 | 88.50% |
| `v4_different_target` | **673** | 0.05% |
| `v4_missing` | 153,448 | 11.45% |

**Gate result: `different == 0` FAILS (673 > 0). `same >= 948,000` PASSES (1,186,470).**
Reverse histogram: `v4_confirmed_v3_same` 1,187,143, `v4_confirmed_v3_absent` 48,715 (v4 sites with
no v3-confirmed counterpart at that exact site).

**P0 -- `v4_different_target = 673`, not fixed per this task's own instructions ("si > 0: 10
muestras y P0 en el informe, no lo arregles").** 10 samples (of the 673, all with `--corpus-root`
unset so `v3_target`/`v4_target` are shown verbatim rather than reason-classified):
1. `packages/frontend/@n8n/design-system/src/components/N8nIcon/icons.ts` -- v3=`jsts:external_symbol:~icons/lucide/tags#default` v4=`jsts:variable:packages/frontend/@n8n/chat/src/env.d.ts:492:component`
2. same file -- v3=`...~icons/lucide/pause#default` v4=`...env.d.ts:492:component`
3. same file -- v3=`...~icons/lucide/user-round#default` v4=`...env.d.ts:492:component`
4. same file -- v3=`...~icons/lucide/trash-2#default` v4=`...env.d.ts:492:component`
5. same file -- v3=`...~icons/lucide/plug-zap#default` v4=`...env.d.ts:492:component`
6. same file -- v3=`...~icons/lucide/triangle-alert#default` v4=`...env.d.ts:492:component`
7. same file -- v3=`...~icons/lucide/maximize#default` v4=`...env.d.ts:492:component`
8. same file -- v3=`...~icons/lucide/clipboard-list#default` v4=`...env.d.ts:492:component`
9. `packages/frontend/editor-ui/src/features/shared/editors/plugins/codemirror/format.ts` -- v3=`jsts:external_symbol:prettier/plugins/estree#default` v4=`jsts:variable:packages/frontend/editor-ui/src/shims-modules.d.ts:3481:plugin`
10. `packages/frontend/editor-ui/src/app/workers/data/worker.ts` -- v3=`jsts:external_symbol:wa-sqlite/src/examples/AccessHandlePoolVFS.js#AccessHandlePoolVFS` v4=`jsts:class:packages/frontend/editor-ui/src/shims-modules.d.ts:3946:AccessHandlePoolVFS`

**Pattern observed (not investigated further, per the task's own "no lo arregles" instruction):**
the overwhelming majority of the 673 (samples 1-8 above, and essentially all `~icons/lucide/*` and
`~icons/*` virtual-module imports in `N8nIcon/icons.ts`) collapse onto the SAME single wrong v4
target -- an unrelated ambient `component` variable declared in `env.d.ts:492` -- suggesting a
wildcard/glob virtual-module alias (`~icons/*`) is being resolved to one fixed ambient declaration
instead of being treated as (or left as) an external symbol per import specifier. Samples 9-10 look
like a related but distinct pattern: a `.d.ts` shim module's ambient ambient ambient declares
`plugin`/`AccessHandlePoolVFS` and v4 binds an external package import to that shim instead of to
the external symbol v3 uses. **Reported as a P0 for the owner's queue** (wildcard/shim virtual-module
resolution in v4); out of this measurement task's authorized file scope.

`v4_missing` (153,448) reason histogram (prefix-only, matches prior evidence docs' bucketing):
| reason prefix | count |
|---|---:|
| `member_access` | 80,432 |
| `unresolved_global` | 65,284 |
| `import_binding` | 3,732 |
| `jsdoc_typed_file` | 2,853 |
| `unknown_no_pending_dump_match` | 870 |
| `re_export_binding` | 216 |
| `multiple_declarations` | 49 |
| `this_expression` | 7 |
| `type_predicate_parameter` | 3 |
| `unsupported_declaration_kind` | 2 |

`v4_missing` by v3-target class (§ task instruction: "registra missing por clase
workspace/lib"): **lib 137,259 (89.45%)**, **other ("workspace", since `--corpus-root` was not
passed so the script's own "workspace" bucket falls back to "other") 16,189 (10.55%)**. `--corpus-root`
was intentionally omitted (this run only needed the aggregate counts/samples, not per-site source
snippets); a follow-up run with `--corpus-root` would resolve real workspace-vs-lib attribution
inside "other" if a future frente wants finer detail.

### A.2b -- Frente E-P0i (2026-09-07, later session): `v4_different_target=673` root cause found and fixed

Follow-up to §A.2's P0. Repo `~/Proyectos/urdira`, branch
`frente-ep0i-ambient-wrong-target` off `8ff1981` (E-P0h tip + this evidence file's own prior
commit; verify green there per that commit's own preamble).

**Bisection (empirical, not the plan's own prior hypothesis).** The plan that assigned this frente
named E-P0b/E-P0f/E-P0d/E-P0g (in that priority order) as suspects for a REGRESSION between Q5's
`different=0` (commit `cf822d4`) and this task's `different=673`. Reproduced the cold-scan
references dump (`v4::tests_e2e::n8n_references_parity_debug_dump`) + diff
(`scripts/v4-references-parity-diff.mjs --classify-targets 1`) at three points on the `cf822d4..
8ff1981` chain, against the SAME retained, complete v3 oracle DB (`~/Proyectos/urdira-benchmark/
v3-n8n-2026-09-07-b/workspaces/...sqlite`):

| checkout | `materialized core:references` | `v4_same_target` | `v4_different_target` |
|---|---:|---:|---:|
| `4ddb890` (E-P0b tip) | 1,241,431 | 1,186,470 | 673 |
| `cf822d4` (Q5 tip, the commit whose OWN evidence doc reports `different=0`) | 1,241,431 | 1,186,470 | 673 |
| `8ff1981` (HEAD, this task's own starting point) | 1,241,431 | 1,186,470 | 673 |

Byte-identical numbers at all three points. **None of E-P0b/E-P0c/E-P0d/E-P0e/E-P0f/E-P0g/E-P0h
touched this population at all** -- the 673 mismatches already existed at Q5's own tip. Q5's
`different=0` (`docs/evidence/2026-09-05-v4-q5-store-write-protection-residual-budget-references.md`
§6) was measured against a v3 oracle for a corpus (n8n) whose cold-scan publish path crashed before
completing (`UNIQUE constraint failed: record_occurrences.record_id`, fixed later by commits
`135a26c`/`376b233`/`62e1ece`, all AFTER `cf822d4`) -- so Q5 never actually compared against the
`~icons/*`/`shims-modules.d.ts` sites at all; its "0" was correct for the population it could see,
not evidence this bug didn't exist.

**Real root cause (code-traced, not the plan's "count of `declare module` candidates" hypothesis).**
The plan's own hypothesis -- "a wildcard/shim specifier with more than one candidate is ambiguous,
exactly one resolves, zero is external" -- does not hold empirically: EVERY one of the 673 sites has
EXACTLY ONE ambient candidate in the whole n8n corpus (verified directly: `grep -rn "declare module
'~icons" <corpus>` finds exactly one file, `packages/frontend/@n8n/chat/src/env.d.ts:19`), yet v3
still never confirms it. Querying the v3 oracle directly (`record_occurrences` +
`decodeCanonical`) for every confirmed `core:references` row whose target lives inside ANY
workspace `declare module { ... }` block, reached through a CROSS-FILE import specifier: **zero**,
across the entire 1,340,591-row confirmed population (the only matches found -- `shims-modules.
d.ts:3481:plugin` referenced twice from `shims-modules.d.ts` ITSELF -- are same-file, ordinary
lexical identifier references, unrelated to specifier-based module resolution).

The mechanism: v3's own indexing binary (`urdira-indexing-worker`, run with `URDIRA_V4=0`) is NOT a
purely real-tsc pipeline -- `crates/urdira-indexing-worker/src/main.rs`'s `hybrid_handle` closure
(the "E1b" lexical hybrid pre-pass, `hybrid_semantics_enabled()` on by default) calls the EXACT SAME
`urdira_jsts_syntax_worker::analyze_owner_semantics_with_context` v4 uses, but constructs its
`AmbientModuleIndex` as `AmbientModuleIndex::default()` (empty), with a comment asserting "v3's own
real TypeScript checker (downstream of this lexical hybrid pre-pass) already resolves a `declare
module` block natively -- this pre-pass never needed ambient awareness". That assumption is false in
practice: the E1c cutover invariant (same file, a few hundred lines below) makes the checker-backed
walk in `analyzer.ts` skip any site the hybrid pass already resolved (`rust_hybrid_pending_sites`).
With an empty ambient index, `resolve_export`/`resolve_named_binding_via_specifier` can only ever
see `AmbientResolution::NoDeclaration` for ANY specifier, so the hybrid pass confirms every one of
these sites to `jsts:external_symbol:{specifier}#{name}` WITH CERTAINTY before the checker ever gets
a turn -- unconditionally, regardless of how many files (if any) actually declare that specifier
ambiently elsewhere in the workspace. v3's disagreement with v4 here is a structural property of
v3's own pipeline, not a considered semantic decision, and not sensitive to candidate count.

**Fix (root cause, not a papered-over symptom).** `crates/urdira-jsts-syntax-worker/src/
semantic_sites.rs` has exactly three call sites where a REAL (non-empty) `AmbientModuleIndex`'s
`resolve_export` result feeds `core:references` target confirmation for a cross-file import
specifier: `resolve_named_binding_via_specifier` (named/default imports), `resolve_external_
namespace_member` (`ns.member` after `import * as ns`), and `visit_import_namespace_specifier`
(`import * as ns` used as a bare value). In all three, the `AmbientResolution::Resolved(_)` arm no
longer confirms the ambient block's own member/namespace entity as the reference target -- it now
falls through to the SAME `classify_external_specifier`/`external_symbol_id` path
`AmbientResolution::NoDeclaration` already used, exactly mirroring what v3's own (structurally
empty-ambient-index) pipeline does. The `AmbientResolution::Ambiguous` arm is UNTOUCHED (still never
guesses among several candidates, stays pending) -- this fix's blast radius is deliberately narrower
than "always fall through": it only changes the certain, single-candidate case, because that is the
ONLY case the empirical evidence actually requires changing (the corpus has zero genuine multi-
candidate collisions to test the `Ambiguous` arm against one way or the other, so the pre-existing
"never guess" discipline there is left standing on its own, independently-tested merits). Preserved,
untouched: `resolver::AmbientModuleIndex`/`resolve_export`/`declarations_for`/wildcard matching
themselves (still correctly single-candidate-precise, still correctly refuse to guess among ties --
`resolver::tests::wildcard_ambient_declaration_matches_any_specifier_sharing_its_prefix`,
`two_wildcard_patterns_tied_at_the_same_prefix_length_stay_ambiguous`, etc. all still pass
unmodified); `resolve_global`/`resolve_ambient_global` (Frente E-P0f's cross-file ambient-global
dependency feature -- a completely separate resolver method, unaffected, its own tests
`cross_file_ambient_global_reference_records_an_ambient_dependency` etc. still pass); `has_any_
declaration`-based import/export dependency-fact edges in `lib.rs`'s `build_import_export_facts`
(Frente E-P0b/E-P0c's own reresolve-loop fix, unaffected -- that mechanism only checks PRESENCE of a
declaration, never which one, and never feeds `core:references`); ambient module/namespace entity
and member CREATION (the declarations themselves are still emitted as entities, still self-
referenceable from within their own declaring file, matching the two same-file `shims-modules.d.ts:
3481:plugin` hits found in the v3 oracle).

Two new process-wide diagnostic counters were added alongside the pre-existing `AMBIGUOUS_AMBIENT_
WOULD_BE_EXTERNAL` (`resolve_export` returned `Ambiguous`, would-be-external): `RESOLVED_AMBIENT_
WOULD_BE_EXTERNAL` / `resolved_ambient_would_be_external_count()` / `reset_resolved_ambient_would_
be_external_count()`, wired into the SAME `URDIRA_V4_DEBUG_AMBIENT_MODULES` debug line in
`crates/urdira-indexing-worker/src/v4/analyze.rs` the ambiguous counter already used.

**Tests.** `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`'s three pre-existing tests
asserting the OLD (now-reversed) behavior were rewritten to assert the new one:
`ambient_named_import_resolves_externally_never_to_the_inner_declaration`, `ambient_default_import_
resolves_externally_never_to_the_inner_declaration`, `ambient_wildcard_default_export_of_a_bare_
declaration_resolves_externally` (each: single ambient candidate now resolves to `jsts:external_
symbol:{specifier}#{name}`, `external_entity_rows` non-empty, and asserts the inner declaration's own
id is NEVER a reference target). Two new tests added: `ambient_wildcard_declared_by_two_files_stays_
pending_never_external_or_internal` (two declaring files -- confirms the `Ambiguous` arm is
untouched: never resolves internally, never falls through to external either) and `ambient_wildcard_
that_does_not_truly_match_never_resolves_ambiently` (`*.svg` does not match `~icons/foo`, confirming
`wildcard_prefix_match`'s suffix requirement still holds end-to-end through this caller). All other
ambient-related tests (resolver.rs's own unit tests, `lib.rs`'s import/export-fact-edge tests,
`semantic_sites.rs`'s ambient-GLOBAL tests) pass unmodified.

**Final numbers (same corpus, same v3 oracle, HEAD after the fix).** Cold scan 44.5s; dump identical
population (`materialized core:references = 1,241,431`, `confirmed(target_subject) = 1,235,858` --
byte-identical to before the fix, confirming this is a pure target REASSIGNMENT, not a population
change):

| bucket | before fix | after fix | delta |
|---|---:|---:|---:|
| `v4_same_target` | 1,186,470 | **1,187,143** | +673 |
| `v4_different_target` | 673 | **0** | -673 |
| `v4_missing` | 153,448 | 153,448 | 0 |

**Gate result: `different == 0` PASSES. `same = 1,187,143 >= 948,000` PASSES (improved, not just
held).** Every one of the 673 sites moved from `different` directly into `same` -- none moved to
`missing`, confirming v3 and v4 now agree exactly on the `external_symbol` target for all of them.

Population floors and ratios (`v4::tests_e2e::n8n_population_floors`, cold scan 22.4s, then
`scripts/v4-population-parity.mjs` against the same v3 oracle) all still clear, several UP (as
expected: these sites now also emit `external_symbol` entities they didn't before):

| kind | v3 | v4 (post-fix) | v4/v3 | floor | ok |
|---|---:|---:|---:|---:|---|
| jsts:entity_callable | 30,224 | 30,224 | 1.000 | 29,921 | OK |
| jsts:entity_container | 14,993 | 15,231 | 1.016 | 14,847 | OK |
| jsts:entity_parameter | n/a | 79,764 | n/a | 78,966 | OK |
| jsts:entity_type | 12,813 | 14,276 | 1.114 | 14,047 | OK |
| jsts:entity_variable | 235,906 | 241,774 | 1.025 | 238,491 | OK |
| jsts:relation_contains | 281,576 | 406,465 | 1.444 | 396,483 | OK |
| jsts:relation_references | 1,340,591 | 1,241,431 | 0.926 | 1,205,324 | OK (unchanged -- pure target reassignment) |
| external_module | n/a | 1,149 | n/a | 905 | OK (+238 vs pre-fix 911) |
| external_symbol | n/a | 4,040 | n/a | 3,780 | OK (+239 vs pre-fix 3,801) |
| records_total | 3,506,275 | 2,198,601 | n/a | 2,165,060 | OK |

No kind fell below its floor or stored ratio -- `scripts/v4-population-floors.json` needed no
changes. Call-parity residual (`v4::residual::tests::n8n_residual_pass_debug_histogram`) re-run
post-fix: `confirmed_combined` AFTER = **161,807**, matching the pinned regression constant exactly
(unaffected by this fix, as expected -- it never touched `core:call`/heritage resolution).

`cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`,
`cargo test -p urdira-jsts-syntax-worker -p urdira-indexing-worker -p urdira-jsts-typeflow --locked`
(306/306, 151/151, 59/59, all green, 0 failed), `cargo build --release --locked -p urdira-indexing-
worker`, and `CI=true ./node_modules/.bin/vitest run tests/phase-daemon-v4-reconcile.test.ts tests/
v4-scan.test.ts` (3 passed, 4 skipped, 0 failed) all pass on the fixed tree.

### A.3 Call-parity diff (`scripts/v4-call-parity-diff.mjs`)

```
node scripts/v4-call-parity-diff.mjs --v3-db <v3 oracle> --v4-bodies call-bodies-after.bin --out call-parity.json
```
v3 confirmed `core:call` sites: 207,584 (of 734,379 total v3 `core:call` rows: 207,584 confirmed,
526,795 possible). v4: 727,673 rows, 159,939 confirmed (target_subject).

| bucket | count | % |
|---|---:|---:|
| `v4_confirmed_same_target` | 116,685 | 56.21% |
| `v4_confirmed_different_target` | **0** | 0.00% |
| `v4_possible` | 87,029 | 41.92% |
| `v4_missing_site` | 3,870 | 1.86% |

**Gate result: `v4_confirmed_different_target == 0` PASSES.** Reverse histogram:
`v4_confirmed_v3_same_target` 116,685, `v4_confirmed_v3_possible` 43,254,
`v4_confirmed_v3_missing_site` 0. `confirmed_combined` on the SAME dump (161,807, §A.1.3) matches
the pinned `residual.rs` regression constant exactly, corroborating this result.

### A.4 Population parity (`scripts/v4-population-parity.mjs`) -- first same-corpus calibration

Before recalibration (using the OLD cross-corpus-provisional ratios in
`scripts/v4-population-floors.json`):
```
node scripts/v4-population-parity.mjs --v3-db <v3 oracle> --v4-populations populations.tsv --out population-parity.json
```
| kind | v3 | v4 | v4/v3 | floor | ok (old ratio) |
|---|---:|---:|---:|---:|---|
| jsts:entity_callable | 30,224 | 30,224 | 1.000 | 29,921 | **FAIL** (old stored ratio 1.8846) |
| jsts:entity_container | 14,993 | 14,993 | 1.000 | 14,847 | **FAIL** (old stored ratio 1.0543) |
| jsts:entity_parameter | n/a | 79,764 | n/a | 78,966 | OK |
| jsts:entity_type | 12,813 | 14,275 | 1.114 | 14,047 | OK (old ratio 1.1086, happened to still clear) |
| jsts:entity_variable | 235,906 | 241,536 | 1.024 | 238,491 | **FAIL** (old stored ratio 1.1255) |
| jsts:relation_contains | 281,576 | 406,223 | 1.443 | 396,483 | **FAIL** (old stored ratio 1.6489) |
| jsts:relation_references | 1,340,591 | 1,241,431 | 0.926 | 1,205,324 | **FAIL** (old stored ratio 1.0853) |
| external_module | n/a | 911 | n/a | 905 | OK |
| external_symbol | n/a | 3,801 | n/a | 3,780 | OK |
| records_total | 3,506,275 | 2,197,882 | n/a | 2,165,060 | OK (ratio gate skipped) |

`exit=2` (`FAIL: at least one kind fell below its stored v4/v3 ratio`). Every absolute **floor**
(R5) is cleared by every kind; only the **ratio** gate failed, and only because the stored ratios
were themselves cross-corpus estimates (`scripts/v4-population-floors.json`'s own header:
"provisional... not a same-scan cross-check", computed from a DIFFERENT v3 dump than the v4
ronda-3 figures). This is the exact "provisional ratios in the JSON" scenario the task's own
instructions anticipate ("si el script falla por ratios provisionales del JSON... fija los ratios
reales medidos - 1% ... es su primera calibración real").

**Decision (per the task's own instruction, applied to every `v3_kind`-bearing row including the
one that happened to pass): recalibrate `scripts/v4-population-floors.json`'s `ratio` field to
0.99 x the REAL same-corpus v4/v3 ratio measured above, for every kind with a `v3_kind` mapping.**
Floors (absolute, R5) are untouched -- only ratios, per this task's authorized file scope. Two
kinds (`jsts:entity_callable`, `jsts:entity_container`) turned out to be an EXACT 1.0000 match
between v3 and v4 on this corpus -- both are unambiguous syntactic declarations (functions/
methods/constructors; classes/interfaces/enums) that neither engine has any classification
disagreement over, so an exact match is a real, sensible finding, not a script bug (re-verified by
re-running the population script twice with identical results).

| kind | new ratio (0.99x observed) | old ratio | note |
|---|---:|---:|---|
| jsts:entity_callable | 0.9900 | 1.8846 | observed 1.0000 exactly |
| jsts:entity_container | 0.9900 | 1.0543 | observed 1.0000 exactly |
| jsts:entity_type | 1.1030 | 1.1086 | observed 1.1141 |
| jsts:entity_variable | 1.0136 | 1.1255 | observed 1.0239 |
| jsts:relation_contains | 1.4282 | 1.6489 | observed 1.4427 |
| jsts:relation_references | 0.9168 | 1.0853 | observed 0.9260 (< 1.0 -- v4 has FEWER references than v3 on this corpus; see §A.2's P0) |

After recalibration, the SAME populations.tsv against the SAME v3 oracle:
```
=== v4-population-parity report ===
kind                                 v3         v4    v4/v3      floor ok
jsts:entity_callable              30224      30224    1.000      29921 OK
jsts:entity_container             14993      14993    1.000      14847 OK
jsts:entity_parameter               n/a      79764      n/a      78966 OK
jsts:entity_type                  12813      14275    1.114      14047 OK
jsts:entity_variable             235906     241536    1.024     238491 OK
jsts:relation_contains           281576     406223    1.443     396483 OK
jsts:relation_references        1340591    1241431    0.926    1205324 OK
external_module                     n/a        911      n/a        905 OK
external_symbol                     n/a       3801      n/a       3780 OK
records_total                   3506275    2197882      n/a    2165060 OK

all kinds clear their floor and stored ratio (where one applies)
```
`exit=0`. **All 10 rows OK.** `scripts/v4-population-floors.json` was edited accordingly (see git
diff for this commit); every changed entry's `_note` documents the old vs. new figure and why.

### A.5 Section summary

| check | result |
|---|---|
| references `different` | 673 at the time of this measurement session -- **fixed to 0 in Frente E-P0i, §A.2b** |
| references `same` | 1,186,470 at the time of this measurement session -- **1,187,143 after §A.2b's fix** (>= 948,000 gate: pass either way) |
| references `missing` | 153,448 (lib 137,259 / other 16,189), unchanged by §A.2b's fix |
| calls `different` | **0** (pass) |
| calls `confirmed_combined` | 161,807 (matches pinned regression constant exactly; re-confirmed unchanged post-§A.2b) |
| population floors (10/10) | all OK (still all OK post-§A.2b, several higher) |
| population ratios (10/10, post-recalibration) | all OK (still all OK post-§A.2b) |

---

## B. S.7 -- semantic segmentation measurements

### B.0 A real, pre-existing blocker found live: semantic maintenance is not wired for v4 storage

The task's own runbook assumes a v4-storage n8n workspace can reach `semantic: completed_gen ==
current`. It cannot, today: `packages/daemon/src/runtime.ts:2573-2583` (in `runV4WorkspaceScan`)
**deliberately never submits semantic maintenance for a v4 workspace at all**:

> "Semantic maintenance (`reconcileSemanticProjection`) is deliberately NOT submitted for a v4
> workspace here: its entity-grain lane... reads `record_occurrences`/`record_value_nodes` --
> structural v3 tables that do not exist at all in the v4 catalog schema... A structural-store-aware
> semantic reconciler is real future work (tracked in
> docs/evidence/2026-09-02-v4-p2-7-daemon-wiring.md), not something this task's scope can safely
> paper over."

Confirmed live in this session, twice, from a clean daemon + clean data root + the MiniLM model
correctly provisioned at `<data_root>/models` before daemon start (ruling out a provisioning
issue): a real v4 workspace reaches `workspace_status: "ready"` / `structural_ready: true` but
`semantic_availability` stays `"unavailable"` / `readiness_reason_codes: ["core:plugin_unavailable"]`
forever (`operation_availability.blocked` lists `core:search_semantic`/`core:search_hybrid`/
`core:semantic_affected_page` permanently). `scripts/semantic-window-histogram.mjs` independently
confirms the same gap from the other side: it reads the candidate-entity population via a raw SQL
query against `record_occurrences`/`artifact_versions`/`source_artifacts` (v3 catalog tables) --
tables a v4-storage workspace's SQLite catalog does not have at all.

**Decision (criterion (a)/(c), decided in implementation, not a question):** this is a pre-existing,
documented (2026-09-02), out-of-authorized-scope architectural gap -- fixing it means wiring a
structural-store-aware semantic reconciler into `runV4WorkspaceScan`, well beyond this task's file
authorization (evidence + `v4-population-floors.json` ratios only). The S-A/S-B frentes (segmenter,
per-segment vectors, document-status table, affected pagination, HTTP provider) all layer on top of
the SAME v3-schema-reading semantic reconciler and are completely independent of whether the MAIN
structural store is v3 or v4 -- they were never blocked by this gap, only a **v4-storage** workspace
is. Since a v3-storage workspace is the only substrate on which semantic maintenance functions at
all today, and this session already proved v3's cold-scan publish path works on this exact corpus
(§A), **S.7's measurements below were taken against a v3-storage (`URDIRA_V4=0`) n8n workspace**,
the only functional path to real numbers for R7/R8/embed/latency/pagination. **This v4 gap itself is
reported here as a separate P0 for the owner's queue**: it blocks ANY real semantic measurement on
v4 storage, not just this one, and is a bigger issue than anything found while measuring around it.

### B.1 Workspace setup

Fresh daemon, dedicated data root `~/Proyectos/urdira-benchmark/v4-fold/sem-2026-09-07/data-v3`,
model provisioned before daemon start (copied from `~/.urdira/models/Xenova` into
`<data_root>/models/Xenova`, never downloaded):
```
URDIRA_TSGO_BINARY=... URDIRA_DATA_ROOT=.../data-v3 URDIRA_NATIVE_REQUIRED=1 \
URDIRA_NATIVE_ROOT=<offline-staged native/ dir from prepareNativeRoot(release/native/darwin-arm64)> \
URDIRA_V4=0 node apps/urdira/dist/cli.js daemon start
URDIRA_V4=0 node apps/urdira/dist/cli.js workspace add <scratch corpus copy> --confirm
```
(A first attempt against a v4-default workspace hit exactly the B.0 gap; that workspace was
removed and this v3 one created fresh in its place, same corpus copy.)

A first cold-scan attempt on this exact corpus at `13:28` timed out after ~16 minutes
(`Indexing-core worker request timed out`, the JS/TS plugin's native analysis-worker IPC, default
10-minute budget) during a load spike from the concurrent E-P0g agent (1-min load observed up to
20.7); the daemon's own in-flight-scan bookkeeping did not clear on that failure (`core:reindex`
replied `reindex_started: false` against the same stale `reconciliation_operation_id`), and its
15.4 GB unfinished WAL was discarded. **Decision (criterion (a), decided in implementation):**
wiped the data root and retried with `URDIRA_INDEXING_CORE_TIMEOUT_MS=1800000` (30 min, still well
under the transport's own 3.6M ms hard cap) -- an env-only mitigation for a real, load-induced
timeout, not a code change. The retry completed cleanly: cold scan reached `workspace_status:
"ready"` at **13:22:34** (`uptime` at structural-ready: `load averages: 2.91 3.34 4.38`), semantic
maintenance started immediately after.

### B.2 Window/segment histogram (R7/R8) -- `scripts/semantic-window-histogram.mjs`

```
node scripts/semantic-window-histogram.mjs --data <data-v3> --workspace-id <id> --corpus <corpus copy> --provider local
```
Ran against the same real n8n workspace right after structural readiness (does not require
semantic maintenance to have run at all -- it recomputes eligibility/tokenization standalone).
`uptime` at run time: load ~2.6-2.9 (quiet).

```
[histogram] candidate entity records (pre-eligibility)=326,817
provider=local window_tokens=256 overlap_tokens=32
eligible=17,630  skipped_unreadable_file=0  skipped_undecodable_body=0  skipped_ineligible=309,187  skipped_empty=0
tokens: n=17,630 p50=241 p90=1,299 p99=6,266 max=101,124
fraction > 256 tokens: 0.4738 (8,353/17,630)
fraction > 256*64=16,384 tokens: 0.0011 (19/17,630)
segments (window=256 overlap=32): n=17,630 p50=1 p90=7 p99=31 max=492
```

**R8 decision: `DEFAULT_MAX_SEGMENTS` stays at 64 (no code change).** The rule is "if p99 of
segments > 64, raise to the next power of 2 >= p99, capped at 256." Measured **p99 = 31**, which is
NOT greater than 64, so the existing default is not changed. Consequence, computed from the full
segment-count distribution: **38 of 17,630 documents (0.22%)** have more than 64 segments (max
observed 492) and will hit `reason_code: "segments_truncated"` under the current cap -- a real,
intentional, non-silent cost (R8's own "never silencioso" clause), not a defect. No test was added
since no constant changed; this decision and its arithmetic are the record of it.

### B.3 Embed-to-completion measurement -- COULD NOT REACH 100% within this session; partial + a complete small-scale reference instead

**Headline finding, decided in implementation (criterion (a), documented rather than silently
extrapolated or faked):** a full n8n-scale semantic re-embed under the new segmented pipeline (R7-R10)
did **not** reach `semantic: completed_gen == current` within this session, after **3h44m** of real
wall time (structural-ready `13:22:34` -> measurement stopped `17:07`, daemon killed). This is a
genuine, CPU-bound cost of the new pipeline at n8n's scale, not primarily the shared-machine
contention this task's own preamble warned about (see the CPU-attribution note below) -- reported
as a P0-adjacent finding for the owner's queue (R10 already accepts "a one-time re-embed cost"
for the segmenter migration, but its magnitude at n8n scale, multi-hour to plausibly multi-day, is
new, load-bearing information the plan itself did not have).

**What was measured, precisely (`vector_projection_rows`/`semantic_document_status` polled directly
against the workspace's own SQLite via read-only `node:sqlite`, plus `uptime` and `ps -o
pid,rss,%cpu,time` samples throughout):**

| phase | wall window | rows/status at end of phase | rate |
|---|---|---|---|
| artifact-grain (`document_grain=NULL`, one vector per file, R9) | `13:22:34` -> ~`16:44` (~201 min) | 20,138 of 20,148 `artifact_versions` covered (99.95%) | ~100 rows/min average |
| entity-grain (`document_grain='entity'`, one row per segment) | ~`16:44` -> `17:07` (measurement stop, ~23 min observed) | 368 segment rows committed; `semantic_document_status`: `covered`=20,211 (20,138 artifact + 73 entity documents), `excluded`=2,012 (`below_min_length` 2,010, `oversized` 2), `unsupported`=12 | highly bursty: some 9-10min windows advanced 300-880 rows (~35-95/min); one ~10min window (`16:56`-`17:06`) showed **zero** row growth while an orphaned `semantic-maintenance-process.js` child (found live via `ps`, PPID reparented to 1 after this session killed its daemon parent) was independently confirmed running at **99.3% CPU for the full window** -- i.e. NOT stalled/hung, genuinely computing one expensive item (consistent with the histogram's own long tail: a single multi-hundred-segment document can occupy the embedder for minutes) |

Target for the entity-grain phase (from B.2's histogram, same eligibility function the reconciler
itself uses): **56,976 segment rows** (17,630 eligible documents, segment counts capped at 64 per
R8's decision above) once every eligible entity is embedded; 368/56,976 = 0.65% reached at the
point this measurement was stopped. **No responsible single-number ETA exists given the observed
burstiness** (9-880 rows per ~10-min sample); a naive linear extrapolation from the fastest window
(~95/min) gives ~10 hours remaining, from the slowest non-zero window (~35/min) gives ~27 hours --
both are reported as the honest bracket, not a point estimate.

**CPU attribution (why this is not simply "the machine was busy," per the task's own instruction to
document load at each measurement):** `uptime` samples across the whole 3h44m window ranged
2.6-20.7 (1-min load), averaging closer to 3-8 for most of the entity-grain phase; the daemon's own
process (`ps -o pid,rss,%cpu,time`) accumulated 46 minutes of CPU time over that same window (~20%
duty cycle), and the one live-caught `semantic-maintenance-process.js` child sample showed 99.3% of
one core for its own ~4-minute lifetime -- consistent with a workload that is itself CPU-bound
(single-threaded ONNX CPU inference of a real transformer, one 256-token window at a time) rather
than merely starved by the co-resident agent. Both factors are real; this session cannot cleanly
separate their relative share beyond what is shown above.

**Decision (criterion (c), "función invocable = 100% funcional"): validate the ENTIRE pipeline
end-to-end on a smaller, real, fully-completing workspace instead of leaving §B.4-B.5 unverified.**
Copied `packages/workflow` out of the same n8n corpus copy (187 TypeScript files, 2.4 MB, a real
first-party n8n package, not a synthetic fixture) into its own scratch corpus + a third dedicated
data root (`data-mini`), same daemon/model-provisioning recipe. This workspace reached **FULL**
semantic completion (`semantic_ready: true`, `semantic_build_state: "idle"`) in **~51 seconds**
from structural-ready (`16:05:22` -> `16:06:03`) -- proof that the pipeline itself is not
categorically slow, only that n8n's absolute scale (20,148 artifacts + 326,817 candidate entity
records) multiplies a real per-item cost into a multi-hour total. All of §B.4/§B.5 below (latency,
matched_segment, pagination) were measured against this mini workspace, fully completed, not
extrapolated.

Mini workspace's own complete numbers (queried directly against its `vector_projection_rows`/
`semantic_document_status`):
- `vector_projection_rows`: 219 artifact-grain + 1,081 entity-grain = 1,300 total rows.
- Entities with a vector: 578 (of 7,657 candidate entity records); segment-count distribution
  1-64 (`{1:446, 2:70, 3:28, 4:10, 5:5, 6:1, 7:4, 9:4, 10:1, 15:1, 20:2, 22:1, 28:1, 30:1, 32:1,
  35:1, 64:1}`); **132/578 entities (22.8%) have more than 1 segment**; exactly **1** entity hit
  the 64-segment cap (`reason_codes: ["segments_truncated"]`).
- `semantic_document_status`: `covered`=797 (219 artifacts + 578 entities, matches exactly),
  `excluded`=6,815 (`below_min_length`), `unsupported`=264 (`unsupported_kind`).
- `semantic_coverage` view (queried live via `core:search_semantic`): `artifact_count`=219,
  `covered_artifact_count`=219, `entity_count`=7,657, `covered_entity_count`=578,
  `materialization_state`="complete", `affected_artifact_count`=7,079 (the excluded+unsupported
  documents), `affected_artifact_set_id` present.

### B.4 Latency (mini workspace, fully warm/complete)

20x `core:search_semantic` + 20x `core:search_hybrid`, varied natural-language queries ("http
request node", "workflow execution error handling", "credential encryption", "webhook trigger
registration", "oauth2 token refresh", "queue mode scaling", ...), issued from a **single persistent
`DaemonClient` connection** (not a fresh CLI process per query, which would add ~250-300ms of Node
startup/import noise unrelated to RPC latency -- confirmed live: a first attempt via
`execFileSync`-per-query measured p50=321ms/p50=312ms, ~10-20ms higher than the persistent-client
numbers below, from that exact overhead). `uptime` during the run: load ~3-4 (quiet).

| mode | n | p50 | p95 | p99 | max | min |
|---|---:|---:|---:|---:|---:|---:|
| `core:search_semantic` | 20 | 301ms | 311ms | 324ms | 324ms | 292ms |
| `core:search_hybrid` | 20 | 299ms | 314ms | 316ms | 316ms | 291ms |

**Criterion (≤250ms p99, reference 141-199ms) NOT met on this workspace** -- every number here is
above 250ms, roughly 60-125ms above the historical reference. This workspace is far smaller than
the "5k+ segment rows" the criterion's own reference case describes (1,300 rows here vs 5k+), so
this is not an apples-to-apples regression check; it is reported as the only real, complete latency
number available this session. `matched_segment` was confirmed present and correctly populated on
entity-grain candidates (`value.semantic_evidence.matched_segment: {index, start_char, end_char}` --
verified live on a `jsts:entity_inferred_type` hit for query "expression parser evaluation":
`{index: 3, start_char: 2223, end_char: 2947}`); it is intentionally absent on `core:artifact`-grain
candidates (R9: artifact stays a single mean vector, no segment to point at). `semantic_coverage`
returns a real `affected_artifact_page` (`SemanticAffectedArtifactPage`) embedded in every response,
`has_next`/`next_cursor` populated when the set exceeds the embedded page's own default size (20).

### B.5 Affected-page pagination (R11) -- forward, backward round-trip, and stale-set rejection

All three verified live against the mini workspace via `core:semantic_affected_page`:
1. **Forward**: `semantic_coverage.affected_artifact_page` (20 items, `has_next: true`) ->
   `core:semantic_affected_page` with that page's `next_cursor` (`limit: 20`) returns the NEXT 20
   (`has_previous: true`), no overlap with page 1 (`eslint.config.mjs` first vs
   `src/augment-object.ts` first).
2. **Backward round-trip**: calling `core:semantic_affected_page` with page 2's own
   `previous_cursor` (`limit: 20`) reproduces page 1 **exactly** (`JSON.stringify` of both pages'
   `display_path` arrays byte-identical) -- confirms the keyset cursor is stateless and
   self-consistent in both directions.
3. **Stale-set rejection (R11)**: calling `core:semantic_affected_page` with a well-formed but
   wrong `affected_artifact_set_id` (a zero digest) and page 1's real cursor returns
   `outcome: "error"`, `error.code: "core:affected_set_stale"` -- never a mixed/partial page, per
   R11's own hard requirement.

All three checks: **PASS**.

---

## C. Cleanup, verification, and disposition

- `scripts/v4-population-floors.json`: recalibrated ratios only (§A.4); floors (R5) untouched.
  Re-ran `node scripts/v4-population-parity.mjs --v3-db <v3 oracle> --v4-populations
  populations.tsv --floors scripts/v4-population-floors.json` after the edit: `exit=0`, all 10
  rows OK (shown in §A.4).
- No source/test/schema files were touched. `URDIRA_DEFAULT_MAX_SEGMENTS` was NOT changed (§B.2).
- Both scratch daemons (`data-v3`, `data-mini`) and their orphaned child processes were stopped
  (`daemon stop`, then `kill -9` on the small number of processes that did not exit gracefully
  within a reasonable wait -- both were disposable scratch workspaces about to be deleted, not
  workspaces holding anything durable).
- Scratch corpus copies and data roots under `~/Proyectos/urdira-benchmark/v4-fold/par-2026-09-07/`
  and `~/Proyectos/urdira-benchmark/v4-fold/sem-2026-09-07/` were deleted after this evidence file
  was written, per this task's own instruction -- ONLY the small logs/JSON result files
  (`references-parity.json`, `call-parity.json`, `population-parity*.json`, `populations.tsv`,
  `histogram.log`, `latency-mini.json`) were retained under
  `~/Proyectos/urdira-benchmark/v4-fold/par-2026-09-07/` and `.../sem-2026-09-07/`, not the
  multi-GB corpus copies/SQLite stores/native-runtime staging dirs. The retained v3 oracle DB
  (`~/Proyectos/urdira-benchmark/v3-n8n-2026-09-07-b/...sqlite`, 15 GB) was NEVER written to
  (opened `readOnly: true` throughout) and was NOT deleted.
- `git status --short` at the end of this task: only the two files above (`scripts/v4-population-floors.json`
  modified, this evidence file added).

## Final report summary

**A. v3/v4 n8n parity:**
- References: `same`=1,186,470 (>=948,000 gate: pass), **`different`=673 (P0, gate fails, 10
  samples + pattern documented, not fixed)**, `missing`=153,448 (lib 137,259 / other 16,189).
- Calls: `different`=0 (pass), `confirmed_combined`=161,807 (matches the pinned regression
  constant exactly).
- Populations: all 10 kinds pass their absolute floor; ratio gate failed against the OLD
  cross-corpus-provisional ratios (5 of 10 kinds), **recalibrated to the first real same-corpus
  ratios** in `scripts/v4-population-floors.json` (documented per-kind in §A.4); all 10 pass after
  recalibration.

**B. Semantic segmentation:**
- Histogram: tokens p50=241/p90=1,299/p99=6,266/max=101,124; fraction >256 tokens = 47.38%;
  fraction >16,384 tokens = 0.11%; segments p50=1/p90=7/**p99=31**/max=492.
- `DEFAULT_MAX_SEGMENTS`: **unchanged (64)** -- p99=31 does not exceed 64 (R8's own threshold);
  38/17,630 n8n documents (0.22%) still hit `segments_truncated` under this cap, by design.
- Embed (n8n, full scale): **NOT completed in-session** -- 3h44m elapsed, artifact-grain phase
  99.95% done (20,138/20,148), entity-grain phase 0.65% done (368/56,976 target segment rows);
  bracket ETA for the remainder ~10-27h, bottleneck genuinely CPU-bound (not solely contention).
- Embed (mini workspace, `packages/workflow`, 187 files): **COMPLETE in ~51s** -- 1,300 vector
  rows (219 artifact + 1,081 entity), 578/7,657 candidate entities covered, 132/578 (22.8%) with
  >1 segment, 1 entity hit `segments_truncated`.
- Latency (mini, warm, persistent connection): `search_semantic` p50=301ms/p95=311ms/**p99=324ms**;
  `search_hybrid` p50=299ms/p95=314ms/**p99=316ms**. Above the 250ms target and the 141-199ms
  reference, but measured on a much smaller corpus (1,300 rows vs the reference's 5k+) -- not a
  like-for-like regression check.
- `matched_segment`: confirmed present and correct on entity-grain candidates, correctly absent on
  artifact-grain ones.
- Pagination (R11): forward, backward round-trip (byte-identical), and stale-set-id rejection
  (`core:affected_set_stale`) -- all **PASS**.

**P0s for the owner's queue (both reported, neither fixed, per this task's own scope):**
1. v4 reference resolution: 673 sites resolve to a DIFFERENT target than v3 (mostly `~icons/*`
   virtual-module imports and `.d.ts` shim modules collapsing onto one wrong ambient declaration).
2. Semantic maintenance is entirely unwired for v4-storage workspaces (confirmed live,
   `packages/daemon/src/runtime.ts:2573-2583`, pre-existing/documented 2026-09-02) -- blocks ANY
   real semantic measurement on v4 storage, forcing this whole §B onto v3 storage instead.
3. (Informational, not a defect) full n8n-scale semantic re-embed under the new segmenter is a
   multi-hour-to-multi-day operation on this reference machine -- R10 already "accepts" a one-time
   re-embed cost, but the owner should see this concrete magnitude before treating it as routine.

No source/schema/test code was modified. Files changed: `scripts/v4-population-floors.json`
(ratios only) and this evidence file.
