# P3-4: v4 incremental-gate mutation harness

Implements plan `resilient-knitting-twilight.md` §6/§10 task P3-4: a
measurement harness that drives a v4 (`URDIRA_V4=1`) workspace through
edit/create/delete/rename/hub-edit mutations one at a time, measures how
long the daemon takes to report each mutation queryable and durable, and
runs a root-equality oracle (a from-scratch cold scan of the mutated
corpus) after each mutation. Not committed, per task instructions.

New: `scripts/v4-mutation-harness.mjs`, `scripts/v4-mutation-harness.d.mts`
(hand-written declaration file, matching the repo's existing convention of
one `.d.mts` per TS-imported `.mjs` script -- `scripts/native-acceleration-controller.d.mts`,
`scripts/n8n-incremental-preflight.d.mts`, etc. -- root `tsconfig.json` has
no `allowJs`, so a `.ts` test file importing a bare `.mjs` needs a co-located
`.d.mts` or it fails `tsc --build` with TS7016; verified by a `--force`
full rebuild before and after adding it), `tests/v4-mutation-harness.test.ts`.
Neither `scripts/n8n-incremental-preflight.mjs` nor
`scripts/native-acceleration-controller.mjs` was modified (see §1 for why).
No Rust file was touched.

Machine: macOS arm64, 10 cores, 32 GB RAM. `rustc`/`cargo` 1.98.0, Node
24.18.1. Built/measured against the `urdira-indexing-worker` binary and
native structural-store addon current at the time of this task (rebuilt
mid-session by the concurrent Rust-owning agent this task shares the host
with; re-verified against the newer binary too, see §6).

## 1. Why a new, self-contained script instead of extending the v3 trace tooling

`scripts/native-acceleration-controller.mjs` / `prepare-native-acceleration-trace.mjs`
implement a **closed, validated 60-mutation trace format**: a fixed
`MUTATION_COUNT = 60`, a closed `CATEGORIES` set
(`content|import|create|delete|rename|tsconfig|manifest`), strict
before/after-digest validation of every declared change, and a two-phase
generate-then-replay contract (the trace is fully declared up front, then
applied verbatim later, possibly on a different machine/run). Retrofitting
`edit`/`hub_edit` mutation kinds and delete/rename *variants* into that
schema would mean either widening `CATEGORIES` and `MUTATION_COUNT` (a
breaking change to a format the v3 n8n benchmark/gate already depends on
and that this task was told to touch only "carefully, additively") or
building a second, parallel generator that produces trace JSON in the same
shape without sharing the validation. Neither is simpler than a
self-contained harness, and P3-4's own workflow does not need
generate-then-replay-on-a-different-run at all: mutation N's *content*
depends on mutation N-1's effect on the corpus (an import graph is rescanned
fresh before each pick, §3), so generation and application are naturally
one step, not two.

`scripts/v4-mutation-harness.mjs` therefore:
- Reuses `native-acceleration-controller.mjs`'s generic, already-tested
  corpus-digest primitive (`computeNativeAccelerationCorpusDigest`, imported
  unmodified) for the cumulative `resulting_corpus_digest` field.
- Reuses `indexing-structural-preflight.mjs`'s `createSlice`/
  `prepareNativeRoot` (imported unmodified) for corpus slicing and native
  artifact staging.
- Reuses `scripts/v4-scan.mjs` unmodified, as a **child process**, for the
  from-scratch oracle side of the comparison (§4) -- no changes needed there
  either.
- Owns its own mutation-kind generator, MANIFEST/segment reader, and daemon
  driver, all new.

## 2. CLI

```
node scripts/v4-mutation-harness.mjs --v4 \
  --corpus /abs/path/to/corpus \
  --native-root /abs/path/to/native/artifacts \
  --output /abs/path/to/report.json \
  [--data-root /abs/empty/dir] \
  [--owners N] \
  [--verify-roots each|final]        # default: each
  [--mutation-kinds edit,create,delete,rename,hub_edit]  # default: all five
  [--repeat N]                        # default: 1
  [--readiness-timeout-ms MS]         # default: 120000
  [--poll-interval-ms MS]             # default: 200
  [--hub-min-importers N]             # default: 50
```

`--v4` is required and self-documenting (it also sets `URDIRA_V4=1`,
`URDIRA_NATIVE_REQUIRED=1`, `URDIRA_NATIVE_ROOT`,
`URDIRA_INDEXING_CORE_WORKER_PATH`, `URDIRA_SEMANTIC_INDEX=0` before the
daemon runtime module is imported -- the same env-then-import order
`native-acceleration-controller.mjs`'s `loadRuntime()` already uses, since
`apps/urdira/src/index.ts` reads these lazily inside
`defaultDaemonOptions`/its plugin-provider factories, not at module load
time). `--owners N` slices the corpus via `createSlice` (for a large corpus
like n8n); omit it to copy the corpus verbatim (used for the fixture test).
`--data-root` retains the workspace's SQLite catalog + native structural
store past the run (matching `n8n-incremental-preflight.mjs`'s convention),
useful for a follow-up manual inspection of `MANIFEST`.

The script is also a module: `run(options)`, `expandKindSequence(kinds,
repeat)`, `applyMutation(root, excludedPaths, usedPaths, variant, marker,
hubMinImporters)`, `compareRootSets(structuralRootA, structuralRootB)`, and
the `KIND_VARIANTS` map are all exported for direct use by tests (§6) or a
future orchestrator.

## 3. Mutation kinds and variants

Each of the five requested kinds expands to one or two concrete *variants*;
`expandKindSequence(["edit","create","delete","rename","hub_edit"], 1)`
produces exactly 7 mutations. Every mutation re-scans the corpus's current
source-file listing (`.ts`/`.tsx`/`.js`/`.jsx`/`.mts`/`.cts`, excluding
`.d.ts` and anything under `dist/build/out/node_modules/.git`) and rebuilds
a lightweight import graph (regex-based, resolving `./relative` specifiers
against the importer's directory with the usual `x`, `x.ts`, `x.tsx`,
`x.js`, `x/index.*` extension/index variants, **and** an ESM-style `.js`
specifier resolved against a same-named `.ts`/`.tsx` file -- the common
`"./x.js"` import pointing at `x.ts` convention) fresh before picking a
target, so a later mutation always sees the effect of an earlier one (a
renamed importer is found under its new name, a deleted file disappears
from the importer counts, etc. -- verified live, see §7).

| Kind | Variant(s) | What it does |
|---|---|---|
| `edit` | `edit` | Appends `export function urdiraHarnessEdit_<marker>() { return "<marker>"; }` + a call to it, to an unused existing source file. |
| `create` | `create` | Creates a new file next to an existing module, `import * as urdiraHarnessImported_<marker> from "<specifier>";` + one exported function referencing it. The specifier style (`./x` vs `./x.js`) is auto-detected from the corpus's own dominant convention. |
| `delete` | `delete_leaf` | Deletes a source file with **zero** importers in the current graph. |
| `delete` | `delete_with_importers` | Deletes a source file with **one or more** importers (their imports are left dangling, deliberately -- exercises the "importer sees an unresolved specifier" path, plan §6.4). |
| `rename` | `rename_no_rewrite` | Renames `x.ts` to `x.urdira-renamed-<marker>.ts`; importer specifiers are **left untouched** (plan §6.4's "unresolved" branch). |
| `rename` | `rename_rewrite` | Same rename, but every importer's specifier for that file is rewritten in place (`./x.js` -> `./x.urdira-renamed-<marker>.js`, preserving whichever extension convention the original specifier used) so the import keeps resolving. |
| `hub_edit` | `hub_edit` | Same content edit as `edit`, but the target is the **not-yet-used** source file with the most importers in the current graph. `--hub-min-importers` (default 50) is only a reporting threshold: `detail.hub_threshold_met` records whether it was actually met, since a small fixture corpus (7 source files) cannot produce a 50-importer hub -- documented, not silently pretended. |

A file already touched (edited/deleted/renamed from-or-to/created) this run
is never picked as a target again (`usedPaths`), so a `--repeat N > 1` run
against a corpus with too few distinct source files fails loudly
(`pickBy`'s error messages name exactly which predicate had no match)
rather than silently reusing a file in a confusing way.

Verified live against `tests/fixtures/codebases/typescript/task-planner`
(7 real source files): all 7 concrete mutations applied cleanly in one run,
including a `rename_rewrite` whose target was *also* an importer that a
prior `rename_no_rewrite` had already renamed -- the rewrite correctly
found and edited the importer under its NEW path, confirming the
fresh-rescan-per-mutation design works as intended.

## 4. Root-equality oracle

After a mutation (or once, at the end, with `--verify-roots final`), the
harness:

1. Reads the incrementally-updated workspace's own structural root:
   `catalog.sqlite`'s `installation_workspaces.database_path` for the
   workspace id, then `structuralStoreDirFor(databasePath)`
   (`packages/engine/dist/index.js`, P2-5/P2-7, imported unmodified) --
   the real `<db>.structural/` sibling directory the daemon publishes to.
2. Runs `node scripts/v4-scan.mjs <same corpus root> <fresh empty dir>
   --force` as a **separate child process** (its own worker process, its
   own data dir -- no interference with the daemon's own persistent worker
   session) -- a genuine from-scratch cold scan of the CURRENT, mutated
   corpus. Its structural root is `<fresh dir>/structural` (that script's
   own, simpler, non-per-workspace layout convention).
3. Compares `MANIFEST.roots` between the two stores, per set. The real
   MANIFEST today only ever carries two sets, `records` and `dependency`
   (per `docs/evidence/2026-09-02-v4-p2-3-structural-store.md` §1.4's
   documented deviation from the plan's four-set sketch -- there is no
   separate graph-edge or metric-projection root to compare yet); the
   comparator iterates whatever keys `roots` actually contains on either
   side, so it needs no update if/when more sets are added.
4. On a mismatch (or a set present on only one side), falls back to a full
   key-set diff for that set: reads `records.keys`/`records.meta` (or
   `deps.keys`/`deps.meta`) from the base directory plus every listed delta
   (re-asserting each delta's own newly-opened rows, then overwriting
   `valid_to` for any key its `closures.*` file names), so it computes the
   effective *visible* key set at the store's own published generation
   exactly as `crates/urdira-structural-store`'s own reader does (§2.1 of
   `docs/evidence/2026-09-02-v4-p2-3-structural-store.md`) -- just in plain
   Node `Buffer` reads against the documented 64-byte header + fixed-stride
   layout, no native addon needed. Reports up to 50 example record ids only
   on the incremental side, only on the from-scratch side, plus both sides'
   total visible counts.
5. `fallback_full` is derived from the **incremental** workspace's own
   published `MANIFEST.deltas` array being empty after the mutation --
   *not* from the daemon's one-time, deduplicated
   "`ScanScope::Changed is not supported`" warning log line (which only
   ever fires once per workspace no matter how many mutations follow, so it
   cannot serve as a per-mutation signal). A `Full` rescan always publishes
   a brand-new `base-<generation>` with `deltas: []`; a genuine incremental
   publish (once P3-1 lands) would keep the SAME `base` and grow `deltas`
   instead -- so this field will flip to `false` automatically, with no
   code change needed here, the day a real delta path exists.

## 5. Readiness: queryable vs. durable

`waitForV4Readiness` polls `urdira index --workspace <id> --json` (same CLI
surface `native-acceleration-controller.mjs`'s v3 `status()` polls, adapted
to v4's two-generation fields from P2-7: top-level
`structural_queryable_generation`/`structural_durable_generation`, also
mirrored at `readiness.structural.queryable_generation`/`durable_generation`
-- the harness checks both spellings defensively). It records a wall-clock
timestamp (`performance.now()`) the first poll iteration where each
generation number differs from what was observed before this mutation, then
requires the SAME `(queryable, durable)` pair to be seen for a short stable
window (>= 300 ms, like the v3 controller's own `READINESS_STABLE_WINDOW_MS`
convention) before returning, so a mid-burst intermediate observation is
never mistaken for the final one. `queryable_ms`/`durable_ms` are that
timestamp minus the wall-clock instant captured immediately before
`applyMutation` performs the actual filesystem write(s) for that mutation.

**Honest limitation**: this is a polling-based measurement (default
`--poll-interval-ms 200`), so both numbers carry up to one poll interval of
quantization error on top of whatever real watcher-burst-aggregation
latency the plan's 100/500 ms window (§6.1) adds -- inherent to any
external-process measurement, not specific to this harness, and the same
limitation the pre-existing v3 controller already has. Per
`docs/evidence/2026-09-02-v4-p2-7-daemon-wiring.md` §4, the CURRENT engine
layer (`runRustWorkspaceScan`) only exposes both generations to the daemon
TOGETHER, after the whole scan finishes -- so `queryable_ms` and
`durable_ms` are expected to be numerically identical (or a fraction of a
poll interval apart) until a future engine change exposes a live
mid-scan `Queryable` callback to the daemon; both are still tracked and
reported as distinct fields so no report-shape change will be needed then.

**Per-phase timings**: `runRustWorkspaceScan`'s resolved outcome DOES carry
a full `ScanTimings` breakdown (`outcome.timings`,
`outcome.queryable?.timings`) at the engine layer
(`packages/engine/src/rust-workspace-scan.ts`), but the daemon
(`packages/daemon/src/runtime.ts`'s `runV4WorkspaceScan`) does not store or
log it anywhere the CLI/`core:index_status` surface exposes (confirmed by
reading that function and grepping for `timings`/`console.*` -- verified
absent). Per this task's own instruction ("otherwise report wall only and
note it"), the harness reports **wall-clock only**; adding phase timings
would require a daemon-layer change outside `packages/daemon`'s explicit
"careful, additive" carve-out this task was given for `native-acceleration-controller.mjs`
only (`runtime.ts` was not granted), so it was intentionally left alone.

## 6. A real, currently-open blocking finding: any second v4 scan fails

Running the full 7-mutation sequence against the real daemon+worker
reproduces, **100% of the time, on the very first mutation**:

```
[urdira] v4 workspace scan: ScanScope::Changed is not supported by the composition worker yet (plan P3); falling back to Full for workspace ...
[urdira] workspace scan failed for workspace:...: Error: core:workspace_scan_failed: v4 scan core error: source catalog SQL error: UNIQUE constraint failed: source_observation_batches.observation_batch_id, source_observation_batches.workspace_id
```

Root cause (read-only investigation, no Rust file touched):
`crates/urdira-indexing-worker/src/v4/scan.rs::run` has, verbatim:

```rust
if !matches!(request.scope, ScanScope::Full) {
    return Err(ScanError("v4 WorkspaceScan{scope: Changed} is not supported yet (plan P3); send scope: Full".to_string()));
}
...
let generation: i64 = 1;
let outcome = catalog::run_full_scan(&mut conn, &request.workspace_id, &workspace_root, &cas_root, generation)?;
```

`generation` is **hardcoded to `1`** -- this build's v4 scan orchestrator
only ever implements a single cold scan at generation 1; it has no
generation-tracking logic for a second scan of any kind yet (that is
squarely P3-1/P3-2's job, in a crate this task does not own). The `Changed`
rejection itself is a cheap early return with zero side effects (confirmed:
it happens before the catalog connection is even opened), so it is NOT the
cause of the corruption -- the daemon's documented retry-with-`Full`
(`packages/daemon/src/runtime.ts`'s `runV4WorkspaceScan`, P2-7) then calls
the SAME `run()` a second time, which recomputes the SAME hardcoded
`generation = 1` and tries to `INSERT` a `source_observation_batches` row
whose id is `stable_id("observation-batch", {workspace_id, generation})`
(`crates/urdira-source-frontier/src/ids.rs`) -- deterministically identical
to the row the COLD scan already committed, so the `UNIQUE(observation_batch_id,
workspace_id)` constraint fails every time, for every mutation, until real
generation tracking lands.

This means the plan brief's own assumption for this task ("today the
worker answers `Changed` scopes with a fallback to `Full` ... roots will
trivially match and latencies will be cold-like") was **not quite what this
build does today**: the `Full` fallback itself cannot complete yet, for ANY
second scan of ANY v4 workspace, regardless of what changed. This was
verified live twice, including after the concurrent Rust-owning agent
sharing this host rebuilt `urdira-indexing-worker` mid-session (rebuild
observed directly via `pgrep`/mtime; harness re-run against the fresh
binary reproduces identically) -- so it is not a stale-binary artifact of
this task's own environment.

**This is not a defect in this task's own file set.** `scripts/v4-mutation-harness.mjs`
correctly detects the terminal `core:workspace_scan_failed` code (added
`isTerminalScanErrorCode`/a "same terminal code twice" check, mirroring
`native-acceleration-controller.mjs`'s existing v3 convention) and fails
FAST (a few seconds, not the full `--readiness-timeout-ms`) with a clear,
actionable message rather than hanging or silently misreporting success --
verified live: `tests/v4-mutation-harness.test.ts`'s second real-daemon test
asserts exactly this behavior in ~3 s. Reported here, not hidden, for
whoever owns `crates/urdira-indexing-worker/src/v4/scan.rs` /
`crates/urdira-source-frontier` next (P3-1/P3-2): once real generation
tracking replaces the hardcoded `1`, this exact failure mode disappears and
the harness's mutation loop (already fully implemented and unit-verified,
§3/§7) will exercise real per-mutation readiness/root-equality end to end
with no further changes needed on this task's side.

## 7. Tests

`tests/v4-mutation-harness.test.ts`:
- Pure unit tests (no daemon): `expandKindSequence` (expansion order,
  repeat, unknown-kind rejection) and `KIND_VARIANTS`'s shape.
- Two real-daemon, real-`urdira-indexing-worker`, real-native-addon tests
  (gated on the release artifacts existing, `describe.skip` with a clear
  build hint otherwise, matching `tests/v4-daemon-e2e.test.ts`'s
  precedent):
  1. **Cold-scan + oracle** (`mutation_kinds: []`): asserts the report
     shape, that cold reaches both `queryable_generation` and
     `durable_generation`, and `roots_equal` is `true` for every set the
     real MANIFEST reports (`records`, `dependency`) against a real,
     separate `scripts/v4-scan.mjs` cold scan of the identical corpus. This
     is the part of the P3-4 contract that works end-to-end TODAY.
  2. **A mutation after cold**: asserts `run(...)` rejects with exactly the
     §6 terminal-error message, fast (well inside a 60 s budget, observed
     ~3 s). The commented-out block right below it is the assertion set the
     task brief originally asked for (`mutations` has 7 entries, every
     mutation reaches `queryable_ms`/`durable_ms`, every `roots_equal` is
     `true`) -- ready to uncomment verbatim once §6 is fixed, so re-enabling
     full coverage is a one-line diff, not a rewrite.

All 5 tests pass (plus the 1 `it.skipIf` companion, correctly not-skipped
here since the release artifacts exist). Pre-existing harness suites
unaffected (neither `native-acceleration-controller.mjs` nor
`n8n-incremental-preflight.mjs` was modified): `tests/native-acceleration-controller.test.ts`
(confirms via inspection this file wasn't touched), plus
`tests/native-acceleration-campaign.test.ts` and
`tests/rust-acceleration-gate.test.ts` were re-run directly -- 32/32 pass.

Sample report from a cold-only fixture run (`mutation_kinds: []`, matching
test 1 above):

```json
{
  "schema_version": 1,
  "mode": "v4",
  "corpus": "~/Proyectos/urdira/tests/fixtures/codebases/typescript/task-planner",
  "verify_roots": "each",
  "changed_scope_unsupported_warning_seen": false,
  "cold": {
    "queryable_ms": 987.897,
    "durable_ms": 987.897,
    "queryable_generation": 1,
    "durable_generation": 1,
    "roots_equal": { "dependency": true, "records": true },
    "fallback_full": true
  },
  "mutations": []
}
```

(`cold.fallback_full` is `true` for the COLD scan too, correctly: a cold
scan always publishes `base-1`/`deltas: []`, and the field's definition --
"this generation's manifest has no open deltas" -- happens to also describe
the cold case; it is only meaningful as a *regression signal* starting at
mutation 1, where a real incremental path would instead show a non-empty
`deltas` array.)

Per-mutation report shape (once §6 is fixed, from the harness's own field
list -- not yet observable end-to-end, see §6):
`{mutation_index, mutation_id, kind, variant, detail, queryable_ms,
durable_ms, queryable_generation, durable_generation, fallback_full,
roots_equal, mismatches, resulting_corpus_digest}`. `printSummaryTable`-backed
stdout output (from the CLI entrypoint) is a p50/p95-per-kind tab-separated
table: `kind, count, queryable_p50_ms, queryable_p95_ms, durable_p50_ms,
durable_p95_ms, any_fallback_full, roots_equal`.

## 8. Exact command for the n8n gate run

Once §6 is fixed upstream, the gate run (per plan §11's measurement rules:
never `/tmp`, always the durable n8n corpus copy, idle-checked first) is:

```
pgrep -f "v4-scan|urdira-indexing-worker" || \
node scripts/v4-mutation-harness.mjs --v4 \
  --corpus ~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02 \
  --native-root release/native/darwin-arm64 \
  --output ~/Proyectos/urdira-benchmark/v4-p3-4/n8n-mutation-report.json \
  --owners 14083 \
  --verify-roots each \
  --mutation-kinds edit,create,delete,rename,hub_edit \
  --repeat 4 \
  --readiness-timeout-ms 60000
```

`--repeat 4` gives 28 mutations (4 x 7 concrete variants), comfortably over
the plan's P3 gate's "20 mutations with root equality" requirement (§10).
`--hub-min-importers 50` (the default) is realistic for n8n's real module
graph, unlike the 7-file fixture in §7 (where `hub_threshold_met` is always
`false`, honestly reported, not silently faked). This was **not run**
during this task (machine-load discipline: no full n8n runs; validated on
the fixture per this task's own instructions, and gated in any case by §6
until a real incremental scan can complete more than once).

## 9. Quality gates run

- `pnpm exec eslint scripts/v4-mutation-harness.mjs tests/v4-mutation-harness.test.ts`
  -- clean (the `.d.mts` file itself is not covered by any eslint config,
  matching the other 13 pre-existing `.d.mts` files in `scripts/`).
- `npx tsc --build tsconfig.tests.json --force` -- 4 errors, all
  pre-existing (`tests/javascript-typescript-indexing-core-transport.test.ts`,
  `tests/native-query-snapshot-port.test.ts`, `tests/rust-protocol-v4.test.ts`,
  `tests/v4-scan.test.ts`; the first three are the same three
  `docs/evidence/2026-09-02-v4-p2-7-daemon-wiring.md` §10 already reported
  as pre-existing and out of scope), zero introduced by this task's files.
- `pnpm exec vitest run tests/v4-mutation-harness.test.ts` -- 5 passed, 1
  skipped (as designed).
- `pnpm exec vitest run tests/native-acceleration-controller.test.ts
  tests/native-acceleration-campaign.test.ts tests/rust-acceleration-gate.test.ts`
  -- 32/32 pass (regression check on the pre-existing harness scripts this
  task read but did not modify).
- Idle-checked (`pgrep -f "v4-scan|urdira-indexing-worker|cargo|rustc"`)
  before every real-worker run in this task; one run was launched a beat
  before a concurrent `cargo build -p urdira-indexing-worker` from the
  other agent sharing this host actually started (a race between the check
  and the invocation, not a violation of the idle gate itself) -- it still
  completed correctly and reproduced identically, so no measurement here is
  suspect, but subsequent checks and the actual `run()`-based invocation
  used to capture the §7 sample were split into separate, sequential Bash
  calls to close that race.
