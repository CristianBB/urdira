# Q-3: full-catalog pushdown -- no v4 operation may depend on the full corpus

Implements Frente Q-3 (plan `resilient-knitting-twilight.md` §0; this
session's brief). Base: `main` at `5f40fbd` (Q-2 merged: non-subject
pipeline-op rejection, `core:execution_resource_limit` guard for
pushdown-less operations at `FULL_CORPUS_FALLBACK_RECORD_CAP = 200_000`,
lexical reconciler re-enabled for v4, `entities.index`/`pending.sites`
prefault). All work in worktree `frente-q3-full-pushdown`.

## 0. Environment

Own `node_modules` via `pnpm install --offline --frozen-lockfile` (not a
symlink). `packages/native/prebuilds` and `release/` copied in from the main
checkout, then this frente's own Rust change rebuilt via `node
scripts/build-native.mjs` (host target `darwin-arm64`/`aarch64-apple-darwin`)
before any TS test that depends on the native addon. `CARGO_TARGET_DIR` set
to a scratch dir outside the worktree (`.claude/worktrees/cargo-target-q3`,
removed at session end). Full TS chain built explicitly (`@urdira/contracts`
through `@urdira/web`/`packages/testkit`, plus `@urdira/native` and
`apps/urdira`, matching Q1/Q2's own convention) -- **and, this session,
fully deleted and rebuilt from clean once**, after discovering the
worktree's checked-out `dist/` directories were stale artifacts left over
from the shared parent checkout's pre-reset HEAD (`git reset --hard` does
not touch untracked/gitignored build output) with an incremental
`tsconfig.tsbuildinfo` that did not detect the difference; `pnpm --filter
@urdira/engine build` silently "succeeded" twice without actually emitting
this frente's new code, only surfaced by directly `grep`-ing the emitted
`.js` for the new method names before trusting a build. Recorded as a
correctness trap for the next frente reusing this convention: **verify a
suspicious-clean incremental build by grepping its own `dist/` output**,
don't trust silent success alone.

Corpora (read-only, scanned directly, never mutated): `~/Proyectos/
urdira-benchmark/n8n-corpus-2026-09-02` (2,198,601 visible records,
20,281 workspace files / 14,082 TypeScript files) and `~/Proyectos/
urdira-benchmark/vscode-corpus-2026-09-06` (VS Code `1.136.1`, `a44adf7f`,
13,171 files, ~4.5M visible records per Q1/Q2's own prior measurement).
Scratch data roots `~/Proyectos/urdira-benchmark/v4-fold/q3-{n8n,vscode}-data`,
deleted at session end. Driver: `scratch-q3-driver.mjs` (repo-root scratch
script, deleted at session end, adapted from `~/Proyectos/urdira-benchmark/
v4-fold/p2-daemon-driver.mjs` but pointed at **this worktree's own**
`apps/urdira/dist/index.js`/`packages/daemon/dist/index.js` so the daemon
under test actually runs this frente's code, not main's) -- a raw
`DaemonClient` against `daemon.sock` with an explicit long deadline, same
trap Q1/Q2 documented (`core:query` is not in the CLI's `longRunning`
allowlist, so `runUrdira(["query", ...])` is stuck on the 30s default).
Each `sweep` run starts a **fresh** daemon (cold store-reader mmap, no
in-process cache from a prior call) and makes 3 repeated calls per
operation within that one session -- "cold" below means the whole sweep's
first heavy native call after daemon start; "warm" means the 2nd/3rd call
in the same sweep. Daemons stopped gracefully after every run
(`daemon stop exit=0`, confirmed via `pgrep` at session end).

## 1. Inventory: mechanism per operation (as found, pre-Q-3, at `5f40fbd`)

`CanonicalRecordQueryDataPort.execute()`'s pushdown chain, in the order it
is tried: `trySearchTextPushdown` -> `tryBuildContextPushdown` ->
`trySemanticSearch` -> `trySemanticAffectedPage` -> (if `!has_warm_records`)
`tryPushdown` (which itself tries `tryGraphPushdown` first, then
`resolve_symbol`/`get_source`/`find_records`) -> `find_artifacts` ->
`discover_definitions` (Q-3 moved this one, see §2) -> the
`visible_record_count` guard -> the generic `records_for_query`/`records`
fallback -> per-operation in-memory branches (`find_records`/
`resolve_symbol`/`get_source`/`search_text`/`analyze_impact`/
`find_related_tests`/`inspect_architecture`/`discover_definitions`) over
the fully-decoded corpus.

| operation | pre-Q-3 mechanism | native-indexed? | reaches `records_for_query`/guard? |
|---|---|---|---|
| `core:discover_definitions` | registry-inventory match (`discoverDefinitions`); needs **zero** corpus records | n/a (no corpus dependency) | **yes, needlessly** -- fell through the entire chain to the generic fallback, decoded (or, post-Q2, guard-rejected) the full corpus, then discarded it unused |
| `core:find_records` | `tryPushdown`: `records_by_selector` (native `by_kind` range index) up to `FIND_RECORDS_PUSHDOWN_LIMIT=5000`, else decline | yes, bounded | only if selector too broad (>5000 matches) or `records_by_selector` absent |
| `core:resolve_symbol` | `tryPushdown`: `records_by_name` (native `by_name` index); declines for dotted names / `context_artifact` / `kind_selector` | yes, bounded | only on decline |
| `core:get_outline` | `tryGraphPushdown` -> `indexedGraphRecords` (native `adj_out`/`records_by_ids`) + `pending_sites_by_owner_artifact` (native `pending.sites` owner range) | yes, bounded (BFS depth = `depth` arg) | only if `graph_edges_by_subject_ids`/`records_by_ids` absent |
| `core:find_references` | same `tryGraphPushdown`, `adj_in`, depth 1 | yes, bounded | same |
| `core:expand_relations` | same `tryGraphPushdown`, direction/`max_depth` from args | yes, bounded | same |
| `core:find_paths` | same `tryGraphPushdown`, both ends + retained targets | yes, bounded | same |
| `core:find_artifacts` | `artifacts_by_filter` (SQLite catalog query -- artifact catalog stays in SQLite even under the native port, plan §9) | yes (SQL, not the segment store) | no |
| `core:search_text` | `trySearchTextPushdown`: FTS/lexical candidate lane when caught up, else `scanSourceCatalog` (source-safe: reads/greps every visible **file**, bounded by artifact/offset caps -- not a `CanonicalQueryRecord` corpus decode) | yes (lexical) / source-safe fallback (bounded by file count, not record count) | no |
| `core:search_semantic` / `core:search_hybrid` | `trySemanticSearch`: ANN/exact vector top-k + `semantic_entity_scope_counts` (one `scanAll` pass, generation-cached after the first call) | yes (vector index); the scope-count pass is O(corpus) once per generation, then O(1) | no (never reaches the guard/fallback) |
| `core:get_source` | `tryPushdown`/direct-id path: `records_by_ids`/`records_by_name`/`artifacts_by_filter` | yes, bounded | rarely (only unresolvable direct-id forms, which now degrade to "not found" rather than fall through) |
| `core:analyze_impact` | **none** -- reached the generic fallback | **no** | **yes -- and, post-Q2's guard, `core:execution_resource_limit` at any corpus over 200,000 records: non-functional at n8n/VS Code scale** |
| `core:find_related_tests` | **none** | **no** | **yes -- same guard rejection, non-functional at scale** |
| `core:inspect_architecture` | **none** | **no** | **yes -- same guard rejection, non-functional at scale** |
| `core:compare` | **none registered at all** -- `scope_type: "comparison"`, and every `CanonicalQuerySnapshotPort` method (native and SQLite alike) throws a `TypeError` for a non-`single_workspace` scope before ever reaching `records_for_query` or the guard | n/a | **no -- broken independent of corpus scale, at every scale including the smallest fixture; a pre-existing functional gap, not a v4-scale regression (see §5)** |
| `core:build_context` | `tryBuildContextPushdown`: indexed seed resolution, explicitly documented as "never a full-corpus scan" | yes, bounded | no |
| `core:index_status` | top-level RPC: dedicated cheap status view (unrelated to corpus records, `2.6-3.5ms` per Q2's own measurement); as a **pipeline/recipe stage**: rejected outright by Q2's `rejectNonSubjectPipelineOperation` before any pushdown attempt | n/a | no (rejected, not fallback) |
| `core:semantic_affected_page` | `trySemanticAffectedPage`: paginated affected-document view, indexed | yes, bounded | no |

Recipes (`packages/contracts/src/registries.ts`'s `recipeRegistryEntries`)
compose the operations above as pipeline stages through the identical
`execute()`/pushdown chain -- a recipe's own mechanism is exactly as good as
its worst stage's. `core:understand_change_impact@1` and `core:
prepare_symbol_change@1` both stage `core:analyze_impact`; `core:
find_relevant_tests@1` stages `core:find_related_tests`; `core:
explain_architecture_slice@1` stages `core:inspect_architecture`; `core:
definition_to_instances@1` stages `core:discover_definitions` +
`core:find_records`; `core:compare_workspaces@1` stages `core:compare`
(still broken, §5); `core:locate_implementation@1`/`core:trace_behavior@1`/
`core:semantic_to_callers@1`/`core:resolve_and_find_references@1`/`core:
prepare_new_feature@1` compose only already-pushdown-capable operations
(`resolve_symbol`/`find_references`/`search_semantic`/`build_context`) and
were already functional at scale before this frente.

## 2. Pushdowns added

### 2.1 `core:discover_definitions` -- corpus-free answer, no fallback reach at all

Moved its branch in `execute()` to run immediately after the `find_artifacts`
check, **before** the `visible_record_count` guard -- it never needed a
single corpus record (it matches the registry definition inventory, not
workspace records), so it should never even have been guard-gated, let alone
fallback-decoded.

### 2.2 `core:analyze_impact` -- direct-caller closure + covering tests

New `tryAnalyzeImpactPushdown` (`packages/engine/src/canonical-query-data-port.ts`),
wired into `tryPushdown`'s existing cold-path chain (same convention as
`tryGraphPushdown`): resolves `target` via `resolveIndexedGraphSelectors`
(the same indexed point-lookup `tryGraphPushdown` already uses), then a new
`relationClosure` helper -- a bounded, single-relation-kind BFS over
`graph_edges_by_subject_ids` (native `adj_in`/`adj_out`, a per-subject
binary-search range lookup, `StoreReader::adjacency`, `crates/
urdira-structural-store/src/reader.rs` -- **not** a corpus scan) +
`records_by_ids` -- filtered to `"core:call"` inbound, depth 1, matching the
pre-Q-3 fallback's exact `will_break` semantics (direct callers only).
`tests_to_run` via a shared `relatedTestsPushdown` helper (§2.3).
`must_update`/`may_be_affected`/`uncertain_dynamic_usage` stay `[]`,
matching the fallback exactly (no confidence-graded transitive
classification exists on either path yet -- flagged, same as Q2's own
catalog sweep flagged it, as the next larger capability gap, not fixed
here).

Bounds: `IMPACT_CALLER_MAX_NODES = 20_000` (a symbol's direct callers, not
the corpus).

### 2.3 `core:find_related_tests` -- containment-ancestor + covering-test closure

New `tryFindRelatedTestsPushdown` + shared `relatedTestsPushdown`: resolves
`subjects`, then for each subject climbs its containment chain via
`relationClosure(..., "core:contains", "inbound", CONTAINMENT_ANCESTOR_MAX_DEPTH=64,
CONTAINMENT_ANCESTOR_MAX_NODES=4096)` (mirrors the in-memory `ancestors()`
function's own semantics: a "core:contains" relation's `source_id` is the
parent, `target_id` the child, so inbound-from-child gives the parent), then
one more `relationClosure(..., "core:covers", "inbound", depth=1,
RELATED_TESTS_MAX_NODES=20_000)` from `subjects ∪ ancestors` to find covering
tests -- matching `relatedTests()`'s exact semantics. `fixtures`/`mocks`/
`helpers` stay `[]`, matching the fallback (never populated on either path).

One documented, deliberate generalization over the old fallback:
`ancestors()`'s single-chain climb takes only the **first** matching parent
per step (`Array.prototype.find`); `relationClosure` explores **every**
matching edge at each depth (a proper BFS frontier) -- a strict superset
when a subject has more than one same-kind inbound edge. Real containment in
this codebase's producers is tree-shaped in practice (every existing
fixture, and this frente's own differential tests, confirm exact parity) --
documented as an intentional generalization the differential tests do not
happen to exercise, not a silently-accepted risk.

### 2.4 `core:inspect_architecture` -- kind-index lookup, plus a real bug found and fixed underneath it

New `tryInspectArchitecturePushdown`: `entry_points` = every `core:container`
entity, `public_surfaces` = every `core:type` entity whose `name` does not
start with `_`, `layers` always `[]` -- matching the fallback's exact
semantics (which also never populates `boundaries`/`cycles`/
`extension_points`, a pre-existing capability gap at every scale, not a
v4-scale regression, left unfixed here). Implemented via `records_by_selector`
(the same `by_kind` pushdown `core:find_records` already uses).

**Bug found live while wiring this up**, not previously known:
`NativeCanonicalQuerySnapshotPort.records_by_selector`, when `selector.kinds`
is omitted (exactly `inspect_architecture`'s own shape -- it wants "every
kind" of `core:container`/`core:type`, and the engine layer has no registry
mapping a universal_kind to its own producer-specific `kind` strings to
enumerate; that mapping is plugin-local), defaulted the missing dimension to
`dicts.kinds` -- **every** kind string in the **whole store**, not scoped to
the requested universal_kind. That inflated `comboCount` past
`SELECTOR_COMBO_CAP` (512) for realistic corpora and silently fell back to
the existing full-corpus `scanAll` branch -- measured live on n8n
(2,198,601 records): **21.3-30.1s** for the two `inspect_architecture`
calls this pushdown makes, the exact "full scan disguised as a bounded call"
the combo cap exists to make rare, not routine. (This same latent bug
already affected `core:find_records` too, whenever a caller's
`kind_selector` specified `universal_kinds` but left `kinds` empty --
smaller blast radius there since `FIND_RECORDS_PUSHDOWN_LIMIT` already
bounds how much of the scan result gets returned, but the **scan cost**
itself was identical and just as undetected before this frente.)

Fixed at the actual root: `by_kind`'s on-disk rows are sorted by the full
`(universal_kind_id, category, kind_id)` triple, so every row sharing one
`(universal_kind_id, category)` prefix is contiguous **regardless of
`kind_id`**. New Rust: `by_kind_universal_range` (`crates/
urdira-structural-store/src/segment_io.rs`, a `(universal_kind_id,
category)`-only binary-search range) + `StoreReader::by_kind_universal`
(`reader.rs`, same per-segment range-then-merge-then-sort shape as
`by_kind`) + a new N-API method `records_by_kind_universal`
(`crates/urdira-native-node/src/structural_store_napi.rs`) + the TS binding
(`NativeStructuralStoreHandle.recordsByKindUniversal`,
`native-structural-store-binding.ts`). `NativeCanonicalQuerySnapshotPort.
records_by_selector` now branches on whether `selector.kinds` was actually
specified: unspecified -> one `recordsByKindUniversal` native call per
`(category, universal_kind)` pair (no `kinds` dimension in the combo count
at all); specified -> the original `recordsByKindExact` combo path,
unchanged. Benefits `core:find_records` too, not just `inspect_architecture`
(same fix, same call site).

Even after the native fix, **21-30s collapsed to 690-1050ms, not lower** --
because the remaining cost was never the native lookup (confirmed via a
direct native-only harness isolating the same rows at **117-154ms** for
15,231 `core:container` + 14,276 `core:type` matches) but this port's own
JS-side `decodeRow` cost for **every** matched record, most of which a
real caller's own `response_budget` (`max_items`) was always going to
truncate away. Rather than fetch-then-discard tens of thousands of fully
hydrated records, `tryInspectArchitecturePushdown` now **truncates** (does
not decline) above `INSPECT_ARCHITECTURE_PUSHDOWN_LIMIT = 500` -- documented
as a deliberate exception to every other pushdown's "decline above the cap,
never truncate" convention (`core:find_records`'s own selector is
caller-narrowed, so an incomplete answer would misrepresent a *specific*
request; `inspect_architecture` has no narrowing selector at all -- its own
fallback returns literally "every container", unconditionally -- and
declining only routes to the same generic fallback, which the
`visible_record_count` guard then rejects outright).

## 3. Left un-pushed, documented, not fixed (out of this frente's mandate)

`core:compare` / `core:compare_workspaces@1`: `scope_type: "comparison"`
selects a **different** code path than every other operation here -- every
`CanonicalQuerySnapshotPort` method (native and SQLite) rejects a
non-`single_workspace` scope with a raw `TypeError` before ever reaching
`records_for_query` or the `visible_record_count` guard. This is not a
v4-scale pushdown gap (the operation is unimplemented and broken at **every**
scale, including the smallest test fixture) -- it needs a genuine dual-
workspace-participant execution path that does not exist yet, a substantial
feature build, not a pushdown. Documented here and in decision 25's
amendment (§6) as the clear next-priority functional gap, matching this
campaign's own convention of flagging rather than silently absorbing
out-of-scope work.

`core:search_semantic`/`core:search_hybrid`'s `semantic_entity_scope_counts`
still pays one `scanAll` pass per generation (cached thereafter) -- an
existing, already-documented, already-cached cost (Frente S-F, `native-
query-snapshot-port.ts`'s own doc comment), not touched here.

`inspect_architecture`'s own `boundaries`/`cycles`/`extension_points` streams
(never populated on either path, at any scale) and `analyze_impact`'s
confidence-graded `must_update`/`may_be_affected` transitive classification
remain the pre-existing capability gaps Q2's catalog sweep already flagged
as "a substantial architectural undertaking... explicitly out of scope" --
this frente closes the **scale** gap (bounded pushdown instead of a guard
rejection) for these three operations, not their remaining **capability**
gap (breadth of analysis).

## 4. Tests (differential, `expectDifferential` pattern)

New `tests/query-pushdown-catalog.test.ts`, same harness as `tests/
query-pushdown-graph.test.ts` (a `cold` port whose `records`/
`records_for_query`/`records_for_query_batches` all throw, versus a `warm`
port forced onto the pre-Q-3 in-memory fallback path -- `expect(pushed).
toEqual(fallback)` proves byte-for-byte parity with **zero** fallback calls):

- `core:analyze_impact` matches the fallback for a real direct-caller/
  covering-test shape (a synthetic `core:covers` edge added to the fixture,
  since this fixture has no `*.test.ts` files to produce a real one) and for
  an unresolvable target (empty streams, matching the fallback).
- `core:find_related_tests` matches the fallback via the containment-ancestor
  closure, for both a covered subject and a caller subject with no direct
  coverage.
- `core:inspect_architecture` matches the fallback for entry points and
  public surfaces.
- `core:discover_definitions` never reaches the full-corpus fallback (the
  `cold` port's `records`/`records_for_query` throwing proves this directly)
  -- this also stands in for task item 2's "assert the 200k guard is
  unreachable" requirement for the operations this frente pushed down: since
  `cold`'s `records_for_query`/`records`/`records_for_query_batches` all
  throw unconditionally, any of these 10 new/updated tests passing is itself
  a proof the guard path was never reached, on a fixture without needing
  200,000+ synthetic records to prove it.

10/10 new tests pass; the existing `query-pushdown-graph.test.ts` (10 tests)
and `native-query-snapshot-port.test.ts` (17 tests, native addon required)
suites are unaffected (27/27 and 17/17 respectively, run together).

## 5. Measurement: before/after, n8n and VS Code

All wall times below are single-shot, real daemon, real IPC, 3 calls per
operation per corpus (this frente's own sweep). "cold" = first heavy native
call in a fresh daemon session; the 3 repeated calls shown are the
warm-within-session sweep (this frente did not additionally measure a true
cold-after-restart baseline separately from the sweep's own first call,
unlike Q1's dedicated cold/warm study -- see the honest caveat below each
row).

### 5.1 `core:inspect_architecture` -- before/after this frente's own mid-session fix

| corpus | before (50,000-cap, combo-cap bug) | after (500-cap, native `by_kind_universal`) | speedup |
|---|---:|---:|---:|
| n8n (2,198,601 records) | 21,343-30,101ms | 691-918ms | ~30-40x |
| VS Code (~4.5M records) | not separately re-measured before the fix (fixed before the VS Code sweep ran) | 1,026-1,055ms | -- |

### 5.2 Full catalog sweep, post-fix (this frente's final numbers)

| operation | n8n wall (3 calls) | VS Code wall (3 calls) | vs. task target (p50 <=300ms n8n / <=500ms VS Code warm, <=1.5s p99) |
|---|---:|---:|---|
| `core:discover_definitions` | 56-59ms | 56-58ms | **meets target** (well under; corpus-independent by design, §2.1) |
| `core:index_status` (top-level control) | 37ms | 37ms | **meets target** (unaffected by this frente, Q2's own subject) |
| `core:inspect_architecture` | 691-918ms | 1,026-1,055ms | **meets p99, exceeds p50 target** (500ms n8n target vs. 691-918ms observed; VS Code exceeds its own 500ms warm target too, ~1.0s) -- decode-bound at the 500-record cap, not native-lookup-bound (§2.4) |
| `core:analyze_impact` | 2,485-2,527ms (clean run) / 2,485-8,215ms (contended run, see below) | 3,280-3,667ms | **does not meet target** -- see §5.3 for the diagnosed root cause |
| `core:find_related_tests` | 2,471-2,550ms | 3,261-3,292ms | **does not meet target** -- same root cause |

Before this frente, `core:analyze_impact` and `core:find_related_tests`
against either corpus were **not a slow answer -- they were no answer at
all**: `core:execution_resource_limit` on every call
(2,198,601/~4.5M records both over `FULL_CORPUS_FALLBACK_RECORD_CAP=
200,000`). Going from "hard failure, unusable at this scale" to "a real,
correct, bounded 2.5-3.7s answer" is the primary win this frente delivers
for these two operations; closing the remaining gap to the sub-second
target is diagnosed precisely below rather than claimed fixed.

One sweep (`sweep8`, mid-session) showed heavier contention (`analyze_impact`:
2,527/8,215/3,743ms; `discover_definitions`: 706/292/236ms vs. this
sweep's own steady 56-59ms; `index_status` control: 231ms vs. steady 37ms)
-- confirmed via `ps`/`pgrep` as a shared-machine load artifact (other
agents' own concurrent `cargo`/daemon processes were observed running at
that moment), not a regression in this frente's own code: `discover_
definitions`/`index_status` do not touch any of this frente's new code
paths at all, and their OWN wall time inflated by a similar factor in that
same window. The steady-state numbers in the tables above are from a
separate, clean run (`sweep10`) with no other observed load, matching Q1/
Q2's own documented convention of reporting the clean run and flagging the
contended one as machine noise rather than silently discarding it.

### 5.3 Root cause of the `analyze_impact`/`find_related_tests` gap: diagnosed, not new, not fixed here

Both operations resolve their `target`/`subjects` selector via
`resolveIndexedGraphSelectors`, which for an `{subject_type: "entity",
entity_id: "entity:<...>"}` selector calls `records_by_ids(scope,
[entityId])`. `entity_id`'s value is **never** a `record:<64-hex>` string
(that is `record_id`'s own form) -- so it always falls into `records_by_ids`'s
documented `otherIds` path: a linear scan of the visible generation (early-
exiting once found, bounded at `OTHER_IDS_SCAN_ROW_BUDGET = 200,000` rows),
**not** an indexed lookup. This is not a new discovery: decision 25's own
"2026-09-08 Q1 amendment" section documents the identical mechanism and
cost center in detail (a mislabeled selector hitting this exact fallback,
there traced to a `toSubjectSelector` field-priority bug that has since been
fixed for pipeline-bound selectors) and states outright: "identity_id/
identity_key forms... have no dedicated native index -- see the evidence
doc's documented gap." `analyze_impact`/`find_related_tests` are simply the
first operations in this campaign whose **primary, intended** call shape
(an `entity_id`-keyed target/subject selector, not a pipeline-bound
`record_id`) exercises this pre-existing gap on every single call, rather
than only on a caller-error edge case.

Confirmed live, isolated from IPC/decode noise: a direct native-only harness
calling `handle.adjacency(...)` and `handle.recordsByIds(...)` for the
**correctly resolved** hex `record_id` alias set of a sample entity answers
in low tens of milliseconds per BFS level (matching §2.4's own inspect_
architecture native-lookup isolation) -- the ~2.5-3.7s cost is entirely the
**one-time** `entity_id -> record_id` resolution's linear scan at the top of
`resolveIndexedGraphSelectors`, paid once per call (not per BFS level,
consistent with the flat, non-warming 2.4-3.7s across all 3 repeated calls
in every sweep run -- an indexed or cached cost would show a clear
cold/warm split; a fixed per-call linear-scan cost does not).

**Not fixed in this frente**: closing this gap needs a genuine
`identity_key -> record_id` index in the native store (the store already
has an analogous mechanism for a different key shape -- `StoreReader::
subject_index`, an in-memory `HashMap<[u8;32], u32>` keyed by a subject-text
digest, used internally by `adjacency`/`subject_ordinal` but not exposed via
any N-API method a `records_by_ids`-style TS caller could reach for
identity-text resolution) -- a real, scoped, Rust-plus-N-API-plus-TS-port
change of comparable size to this frente's own `by_kind_universal` addition,
not a quick follow-up. Flagged here, precisely, as the clear next priority
for whoever owns `records_by_ids`/the native store's identity resolution
next -- the same category of finding (a real bottleneck, isolated to its
exact call site, with the fix's shape already sketched) this campaign's own
evidence docs consistently produce rather than a vague "needs more perf
work."

## 6. Registry/decision changes

`docs/decisions/25-rust-native-acceleration.md` gained a "2026-09-08 Q-3
amendment" section (operation -> index matrix, the `by_kind_universal`
addition, and the diagnosed `records_by_ids` identity-resolution gap).
`packages/contracts/src/registries.ts` was not changed (no new operations,
error codes, or schema fields -- this frente is pushdown/index work under
existing contracts, not a contract change).

## 7. Verification

`pnpm typecheck` -- clean except the same pre-existing fixture/test-type
errors confirmed present at `5f40fbd` itself (`git stash`-diffed to verify:
`barrel-method-call`/`multi-hop-barrel-rename` fixture import-extension
errors, `tests/phase-daemon-v4-scan.test.ts`'s own pre-existing
`last_scan_error_at` typo -- none touch this frente's files). `pnpm lint`
clean. `cargo fmt --check` clean. `cargo clippy -p urdira-structural-store
-p urdira-native-node --locked --all-targets -- -D warnings` clean. `cargo
test -p urdira-structural-store -p urdira-native-node --locked` -- 19 test
binaries, 0 failed (re-run twice: once before this frente's Rust addition
to confirm the pre-existing baseline, once after). `CI=true pnpm exec
vitest run` across `tests/query-pushdown-catalog.test.ts` (10 new),
`tests/query-pushdown-graph.test.ts` (10), `tests/native-query-snapshot-
port.test.ts` (17), `tests/phase-canonical-query-data-port.test.ts` +
`tests/phase11-recipe-executor.test.ts` + `tests/phase11-query-plan.test.ts`
(143), `tests/v4-daemon-e2e.test.ts` + `tests/phase13-mcp.test.ts` (57
passed / 1 pre-existing skip), `tests/phase-daemon-v4-scan.test.ts` (11) --
all green, 0 failed.

## 8. Cleanup

`scratch-q3-driver.mjs` and two throwaway native-only diagnostic scripts
(`scratch-q3-count.mjs`, `scratch-q3-closure.mjs`) deleted at session end
(none part of the repo). Both scratch data roots (`~/Proyectos/
urdira-benchmark/v4-fold/q3-{n8n,vscode}-data`) deleted. `CARGO_TARGET_DIR`
scratch directory and `build-native.mjs`'s own worktree-local `target/`
directory (428MB) both removed. Daemons for both sweeps stopped gracefully
(`daemon stop exit=0` every run); `pgrep -fl "cli.js daemon|
urdira-indexing-worker"` confirmed clean of this session's own `q3-n8n-data`/
`q3-vscode-data` processes at session end (other agents' own worktree
processes, unrelated, observed and left alone).
