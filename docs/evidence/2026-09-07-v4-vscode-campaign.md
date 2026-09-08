# P-2: VS Code campaign — cold v4, v3 parity, v4 index pack, R20 decision

Implements task **P-2** (§7.2 + R18-R20 of §0) of plan `generic-waddling-hartmanis.md`, ola 3.
Base: `main` clean at `9b20fbb` (verify green per the task's own preamble; started at `6546997`,
advanced by other concurrent frentes' own merges across this long session -- this task touched
none of the intervening commits' own files). Worked without isolation on main, per task
instructions. Code changes, all authorized by the task's own text: (1) `URDIRA_V4_POPULATION_
FLOORS=skip` gate on `n8n_population_floors`'s assertions (§3 -- the n8n floors are meaningless on
a different corpus, so the dump-only mode the task asked for needed this one flag); (2) R19:
five names added to `crates/urdira-jsts-syntax-worker/src/resolver.rs`'s `is_standard_global_name`
(`HTMLElement`, `TextEncoder`, `TextDecoder`, `ErrorConstructor`, `IdleDeadline` -- §5.1). Plus this
evidence file. `git status --short` at the end of this session is empty beyond those three files.

Machine: macOS arm64, shared with a real browser/Cursor session and, at various points across this
long (multi-hour, spanning an API-limit interruption) session, other concurrent agent sessions'
own heavy CPU/memory workloads (semantic-embedding maintenance processes at times fully saturating
RAM+swap -- §4.2). `uptime` was recorded before/after every timed series; series measured during a
load spike (1-min load >8, up to 18) were **repeated** once the machine returned to idle (1-min
load <5) per the task's own load>8 rule -- both sets are reported in §6 with the clean numbers used
for R20.

Corpus: `~/Proyectos/urdira-benchmark/vscode-corpus-2026-09-06` (already prepared in an earlier
session per R18: tag `1.136.1`, commit `a44adf7f53e00964ab890f9f8758a334f1fc15bc`, 13,171 TS/JS
files per `git ls-files`, `node_modules` present and gitignored, read-only sentinel
`.urdira-shared-corpus-readonly`). Never mutated. All work happened on scratch git clones under
`~/Proyectos/urdira-benchmark/v4-fold/p2-*/` (`git clone --no-hardlinks <corpus> <scratch>` +
`node_modules` symlinked from the corpus, never copied — the walker's own inclusion rules and this
repo's `.gitignore` both exclude `node_modules`, and the Rust harnesses' own `copy_dir_recursive`
skips symlinked directories outright, so this never affected any measurement). Two scratch trees:
`p2-donor` (checked out at `a44adf7`, the pack donor / cold-scan tree) and `p2-head50` (a second
clone, deepened via `git fetch --depth=60` from GitHub — the corpus's own local clone is a depth-1
shallow clone, R18's own recipe, so a `HEAD~50`-style checkout needed real history fetched in a
scratch clone, never in the shared corpus itself).

---

## 0. Binaries and build

```
cargo build --release --locked -p urdira-indexing-worker
pnpm build:native
pnpm --filter @urdira/contracts build && pnpm --filter @urdira/canonical build && pnpm --filter @urdira/security build \
  && pnpm --filter @urdira/storage build && pnpm --filter @urdira/plugin-sdk build \
  && pnpm --filter @urdira/plugin-javascript-typescript build && pnpm --filter @urdira/engine build \
  && pnpm --filter @urdira/embedding-local build && pnpm exec tsc --build packages/daemon \
  && pnpm --filter @urdira/cli build && pnpm --filter @urdira/mcp build && pnpm --filter @urdira/web build \
  && pnpm exec tsc --build packages/testkit
```
(the `test` script's own chain, minus the trailing `vitest run` — this campaign needed the built
`apps/urdira/dist`/`packages/*/dist` artifacts, not the test suite). All steps green, `rc=0`.

Daemon-driving harness for this campaign: a standalone script (not part of the repo)
`~/Proyectos/urdira-benchmark/v4-fold/p2-daemon-driver.mjs`, modeled on the F-fix session's own
`ffix-v3-index-diag.mjs` (`prepareNativeRoot` + `apps/urdira/dist/index.js`'s `defaultDaemonOptions`/
`runUrdira`), generalized to also drive `workspace-add --index-pack` and `index-pack-export` (the
latter called directly via `DaemonClient` with an explicit long `deadline_at`, since
`core:index_pack_export` is not in `runUrdira`'s own `longRunning` deadline list and a plain CLI
call gets the default ~30s admin RPC timeout — confirmed live, see §6.1). `URDIRA_TSGO_BINARY`
pinned to `node_modules/.pnpm/@typescript+typescript-darwin-arm64@7.0.2/.../tsc` throughout.
`URDIRA_SEMANTIC_INDEX=0` for all daemon-driven workspace-add/import runs (structural pack
export/import/reconcile correctness does not depend on semantic embeddings, and the semantic
maintenance child process was observed twice fighting the daemon's own graceful-shutdown handshake
under concurrent load — §6.0). `URDIRA_INDEXING_CORE_TIMEOUT_MS=3,600,000` (the RPC-level indexing
deadline, distinct from the CLI's own admin timeout).

---

## 1. v4 cold ×3

`URDIRA_DEBUG_TIMING=1 /usr/bin/time -l node scripts/v4-scan.mjs ~/Proyectos/urdira-benchmark/v4-fold/p2-donor <fresh dir> --force`,
3 runs into fresh data dirs under `v4-fold/p2-cold/run-{1,2,3}`. `uptime` before/after every run,
all readings 2.89-7.40 (well under the 8.0 load gate — no repeats needed).

| run | catalog_ms | parse_ms | resolve_ms | materialize_ms | write_ms | fsync_ms | total_ms | wall (real) | RSS max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| run-1 | 2663 | 2721 | 3076 | 7503 | 10042 | 158 | 29951 | 32.88s | 13.84 GiB |
| run-2 | 2596 | 2791 | 2858 | 6258 | 9885 | 275 | 27588 | 29.96s | 14.18 GiB |
| run-3 | 2491 | 2694 | 2743 | 5617 | 9681 | 147 | 25973 | 28.11s | 14.12 GiB |
| **median** | 2596 | 2721 | 2858 | 6258 | 9885 | 158 | **27588** | **29.96s** | 14.18 GiB |

`structural/` size: 3.6G on all 3 runs. `generation=1` on all 3. `records_total` (from the
population dump, §3): 4,475,240.

### 1.1 Scale vs n8n

Same code (`HEAD` for n8n's own most recent cold measurement, `d71669a`, was 2 commits before this
session's base and untouched by anything since — F.3, `docs/evidence/2026-09-07-v4-f3-cold-
incremental-floors-parity-threshold.md` §1.3):

| metric | n8n (`n8n-corpus-2026-09-02`) | VS Code (this campaign) | ratio |
|---|---:|---:|---:|
| wall (real), median | 25.22s | 29.96s | 1.19x |
| total_ms, median | 23,369 | 27,588 | 1.18x |
| `structural/` size | 1.8G | 3.6G | 2.0x |
| `records_total` | 2,197,882 | 4,475,240 | 2.04x |
| RSS max | 6.11 GiB | 14.18 GiB | 2.32x |

VS Code carries ~2x n8n's record volume (and structural footprint) at only ~1.2x the wall time --
cold v4 scales sub-linearly with corpus size in this range. RSS scales closer to linearly with
record volume (expected: the in-memory materialize pass holds records proportional to corpus size).

---

## 2. Residual (cota 20s ×1)

Harness: `crates/urdira-indexing-worker/src/v4/residual.rs`'s `n8n_residual_pass_debug_histogram`
(`#[ignore]`d), pointed at the VS Code scratch tree via `URDIRA_V4_N8N_CORPUS` (the env var name is
historical, per the task's own note):
```
URDIRA_V4_N8N_CORPUS=~/Proyectos/urdira-benchmark/v4-fold/p2-donor \
URDIRA_V4_N8N_DATA=~/Proyectos/urdira-benchmark/v4-fold/p2-tests/residual-data \
URDIRA_V4_RESIDUAL_DEBUG=1 URDIRA_V4_RESIDUAL_BUDGET_MS=20000 \
URDIRA_V4_CALL_BODY_DUMP_AFTER=~/Proyectos/urdira-benchmark/v4-fold/p2-tests/call-bodies-after.bin \
cargo test -p urdira-indexing-worker --release --locked v4::residual::tests::n8n_residual_pass_debug_histogram -- --ignored --nocapture
```
`uptime` before: load 4.68 (under gate).

| metric | value |
|---|---:|
| cold scan wall (in-test) | 14.990s (analyze), full residual test 96.36s |
| cold classification mismatches | 0 (asserted) |
| `checker_ms` | 22,276 |
| `total_ms` | 42,848 |
| `truncated` | true |
| `windows_done`/`windows_total` | 13/26 |
| `upgraded` | 13,077 |
| `external` | 16,752 |
| `unresolved` | 271,746 |
| `inferred_type_entities` / `type_of_relations` | 8,745 / 8,745 |
| `diagnostics_emitted` | 54,694 |
| post-residual classification mismatches | 0 (asserted) |
| `core:call` confirmed (AFTER) | 217,411 (possible 3,859) |
| heritage confirmed (AFTER) | 4,936 |

**Budget overshoot vs n8n at the same 20s budget**: n8n's own most recent same-budget measurement
(`docs/evidence/2026-09-05-v4-q5-store-write-protection-residual-budget-references.md` §"Con cota
20000") landed `checker_ms` at 20,323-20,350ms (overshoot 0.32-0.35s, well inside that doc's own
"cota + 1s" acceptance bar) with `windows_done/total = 21/28`. VS Code's `checker_ms=22,276`
overshoots by **2.276s** -- ~6.5x n8n's overshoot -- and completes fewer windows proportionally
(13/26 = 50% vs n8n's 21/28 = 75%). This is a real, reproducible scale-sensitivity of the budget
checker's own cancellation granularity (larger corpus → coarser windows → bigger overshoot past the
deadline), not a correctness issue (both classification-mismatch asserts still pass at 0) and not
something this task's authorized file list permits changing. **Flagged for the owner's queue** as a
P1 (not P0: the mechanism still bounds runtime to the same order of magnitude, just with worse
precision at VS Code's scale) -- see §9.

---

## 3. Population dump (F.1's harness, dump-only)

`n8n_population_floors` is n8n-floor-calibrated (R5) and meaningless as a pass/fail gate on a
different corpus; per the task's own instruction this required exactly one code change (the only
one besides evidence in this session): a `URDIRA_V4_POPULATION_FLOORS=skip` env gate added around
the assertions in `crates/urdira-indexing-worker/src/v4/tests_e2e.rs::n8n_population_floors`,
leaving the TSV dump itself unconditional.
```
URDIRA_V4_N8N_CORPUS=~/Proyectos/urdira-benchmark/v4-fold/p2-donor \
URDIRA_V4_POPULATION_DUMP=~/Proyectos/urdira-benchmark/v4-fold/p2-tests/populations.tsv \
URDIRA_V4_POPULATION_FLOORS=skip \
cargo test -p urdira-indexing-worker --release --locked v4::tests_e2e::n8n_population_floors -- --ignored --nocapture
```
`uptime` before: load 2.92 (under gate). Test passes (`ok`, floor assertions skipped as designed;
the printed table shows several n8n-floor rows as expected `FAIL` against VS Code's own natural
population shape -- meaningless here, exactly as anticipated).

| kind | count |
|---|---:|
| `jsts:entity_callable` | 132,116 |
| `jsts:entity_container` | 13,876 |
| `jsts:entity_parameter` | 288,699 |
| `jsts:entity_type` | 39,977 |
| `jsts:entity_variable` | 436,108 |
| `jsts:relation_call` | 208,933 |
| `jsts:relation_contains` | 921,463 |
| `jsts:relation_covers` | 2,253 |
| `jsts:relation_export` | 1,164 |
| `jsts:relation_implements` | 920 |
| `jsts:relation_import` | 128,045 |
| `jsts:relation_inherits` | 3,692 |
| `jsts:relation_references` | 2,297,994 |
| `external_module` | 627 |
| `external_symbol` | 2,367 |
| `records_total` | 4,475,240 |

(v3-side population-parity ratios in §5.3.)

---

## 4. v3 baseline

### 4.0 A real, reproducible daemon bug found live: "indexing" forever after a scan failure

The first v3 attempt (`URDIRA_V4=0 workspace-add` against the full, unmodified 18,049-file
`p2-donor` tree) failed at **t=83.9s** with `core:engine_failed: JS/TS facts are incomplete for
extensions/copilot/src/extension/prompts/node/test/fixtures/5710.selection.ts` -- but
`core:workspace_admin_show`'s own `status` field never left `"indexing"` afterwards. Polling
`workspace-show` in a loop (exactly as this campaign's own harness does, and as any real caller
would) is **silent** on this failure: no `state=error`, no `state=failed`, nothing distinguishing a
genuinely stuck daemon from one still working. This was only discovered because a background wait
for this exact scan ran for **over 100 minutes** before being force-killed and the raw daemon log
(not just the polled `status` field) was inspected -- `ps` showed the daemon process alive the
entire time with only a few seconds of *total* CPU time consumed, i.e. it was not "slow", it was
completely idle after t=84s. **Flagged as a P0 for the owner's queue** (§9): `core:workspace_admin_
show`/`core:index_status` should surface a failed scan's terminal state (or at minimum
`last_scan_error`) even while `status` itself stays `"indexing"`, and/or the daemon should actually
retry or fail the workspace outright rather than leaving it in limbo indefinitely.

### 4.1 v3's cold-scan pipeline aborts entirely on intentionally-malformed test fixtures

Root-causing the failure above led to a broader, reproducible pattern: v3's `core:engine_failed:
JS/TS facts are incomplete` check aborts the **entire** corpus scan the moment it hits **any** file
its JS/TS facts pass considers incomplete -- and VS Code's own monorepo contains dozens of such
files by design (intentionally truncated/invalid TS snippets used as prompt-summarization and
syntax-highlighter test fixtures). Each retry advanced past the previously-found offender only to
hit the next one, one at a time:
1. `extensions/copilot/.../fixtures/5710.selection.ts` (a 2-line, deliberately incomplete class-body
   fragment -- a "selection" test fixture for prompt-window truncation testing).
2. `extensions/copilot/.../fixtures/bracketPairsTree.summarized.ts` (same fixture family).
3. `extensions/copilot/.../typescriptContext/serverPlugin/fixtures/context/p1/source/f4.ts`.
4. `extensions/copilot/test/scenarios/test-cli/wkspc1/stringUtils.js` (a "scenario" test tree, not
   even named `fixtures`).
5. `extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-checker.ts` (a **different**
   extension entirely, confirming this is not copilot-specific).
6. `scripts/xterm-update.js` -- notably **not** a test fixture: a legitimate, valid CommonJS build
   script using a bare top-level `return` (valid in Node's CJS module-wrapper semantics, invalid
   per raw ECMAScript script/module grammar without that wrapper context) -- a real v3 parser
   compatibility gap, not adversarial test content.

v4 scanned the **entire, unmodified** 18,049-file tree successfully three times over (§1) with none
of this, before any exclusion. **Disposition (per criterion (a)/(c), decided in the moment, and per
this task's own explicit instruction not to touch v3's legacy code)**: rather than whack-a-mole
individual files indefinitely, excluded from the `p2-donor` **scratch copy only** (never the shared
corpus) -- one fixture file, one fixture directory, all 10 `fixtures/`-named directories under
`extensions/copilot` (2,531 TS/JS files, ~14% of the corpus), all 16 remaining `fixtures`-named
directories elsewhere in the tree (55 files, ~0.3%), and the one legitimate script -- moved to
`~/Proyectos/urdira-benchmark/v4-fold/p2-excluded-fixtures/` (retained, not deleted, for
reproducibility). After exclusion, the walker's own frontier dropped to **10,273 TS/JS files**
(`find` count) / 13,510 files (the walker's own broader `source_observations_processed`, which
counts more extensions than the narrower `find` glob above). **This means v3's own parity numbers
in §5 below cover a REDUCED, ~57-75% subset of VS Code, not the full corpus §1's cold-scan numbers
measured** -- the v4-side reference/call/population dumps used for parity (§5) were **regenerated
against this same reduced tree** (not the original full-tree dumps captured earlier) specifically
so the comparison stays apples-to-apples; §1's cold ×3 and §2's residual numbers were captured
**before** any exclusion and remain the full-corpus figures. **Flagged as a P0 for the owner's
queue** (§9): v3's fact-completeness gate should skip/report a bad file rather than abort the whole
workspace, and its top-level-`return`-in-CommonJS handling should match v4's (and Node's own).

### 4.2 A second real bug: `database or disk is full` at ~5.7M rows, and a disk-space trap

After exclusion, a subsequent attempt progressed to v3's publication phase (`direct structural
record rows=5,702,283`) and failed with `Rust publication SQLite error: database or disk is full`.
`df` confirmed the machine's own data volume was genuinely at 99% capacity (14GB free) at that
moment -- not a v3 defect, but a real resource trap this campaign's own scratch usage
(cold-scan structural stores x3, multiple pack-import data roots, two packs) had driven the machine
into, on top of another concurrently-running session's own semantic-embedding workload. **Disposition**:
freed ~40GB by deleting already-measured, already-recorded scratch data (§1's `p2-cold/run-*`
structural stores, already-consumed `p2-import-*`/`p2-pack-donor-data` data roots, one duplicate
pack) down to 58GB free, then retried. Two further transient failures were hit and worked around
before a clean run completed: a `spawn EBADF` on daemon start under heavy concurrent load (same
class as §6.0's, unrelated to this section's own fix), and a genuine severe-memory-pressure episode
mid-session (RAM+swap both >95% full, largely driven by another concurrent session's own 6 semantic-
maintenance child processes) that silently killed the v3 daemon process (`ENOENT` on its own
`daemon.sock` on the next poll, no crash message) -- retried once memory pressure eased and a stale
leftover daemon process from the killed attempt (still holding the data root's socket open,
blocking `rm -rf`) was found and killed explicitly.

### 4.3 Successful run

```
URDIRA_V4=0 URDIRA_NATIVE_REQUIRED=1 URDIRA_SEMANTIC_INDEX=0 workspace add <p2-donor, reduced> --confirm
```
against a fresh data root (`~/Proyectos/urdira-benchmark/v3-vscode-2026-09-07/`), retained per the
task's own instruction.

| metric | value |
|---|---:|
| `ready_elapsed_ms` (workspace-add RPC return -> `ready`) | 3,092,937 ms (**51.5 min**) |
| `direct structural record rows` | 5,702,283 |
| `plugin_analyze` (jsts syntax + tsgo residual) | 453,047 ms (7.55 min) |
| `publish` (SQLite promotion + cold index rebuild + analyze stats) | 2,580,628 ms (43.0 min) -- dominant cost |
| `promo_record_insert` alone | 594,703-882,323 ms across attempts (~10-15 min, itself the single largest publish sub-phase) |
| final `workspace.status` | `ready` |
| `record_occurrences.record_id` collisions | none (the F-fix commits already in `main` hold at this scale) |
| SQLite file size | 25.2 GB |

`v3 confirmed core:references sites` (from the parity dump, §5.1): **3,145,812**. `v3 confirmed
core:call sites`: **743,472** (of 903,291 total `core:call` rows). Retained: the SQLite DB itself
(`workspaces/workspace_p2-donor_fa50cf46-34a5-4da5-960d-a6b5e7291524.sqlite`), per the task's own
instruction to keep the v3 oracle.

---

## 5. Parity (references / calls / populations) and R19

All three diffs below use v4 dumps regenerated **against the same reduced tree** v3's oracle
reflects (§4.1) -- `crates/urdira-indexing-worker/src/v4/tests_e2e.rs::n8n_references_parity_
debug_dump` and `crates/urdira-indexing-worker/src/v4/residual.rs::n8n_residual_pass_debug_
histogram`, both pointed at `p2-donor` post-exclusion, run twice (before and after the R19 fix
below) so the diff numbers in this section are all post-fix.

### 5.1 References (`scripts/v4-references-parity-diff.mjs --classify-targets 1 --samples 50`)

First pass (pre-fix): `v4_same_target=1,749,006` (55.60%), **`v4_different_target=7,029`
(0.22%)**, `v4_missing=1,389,777` (44.18%), out of `v3 confirmed core:references sites=3,145,812`.
`different == 0` **FAILS** -- R19 applies.

**R19 investigation**: all 50/50 randomly-sampled `v4_different_target` rows showed the *exact same*
pattern -- `"HTMLElement"`, `v3_target=...lib.dom.d.ts:866359:HTMLElement`,
`v4_target=jsts:interface:src/typings/editContext.d.ts:4107:HTMLElement`. VS Code's own
`src/typings/editContext.d.ts` augments the standard `HTMLElement` interface (TS declaration
merging with `lib.dom.d.ts`), and `crates/urdira-jsts-syntax-worker/src/resolver.rs`'s
`is_standard_global_name` -- a curated allowlist explicitly documented as "validated ONLY against
the n8n corpus" with its own extension recipe for exactly this situation -- did not yet include
`HTMLElement`. **Fix**: added `"HTMLElement"` to `NAMES`. Rebuild + re-dump + re-diff:
`v4_different_target` dropped to **195** (97.2% reduction). A second 50-row sample of the remainder
found three more of the identical pattern -- `TextEncoder`/`TextDecoder` (re-declared by
`extensions/types/lib.textEncoder.d.ts`, v3 -> `lib.dom.d.ts`), `ErrorConstructor` (re-declared by
`src/typings/base-common.d.ts`, v3 -> `lib.es5.d.ts`), and `IdleDeadline` (same file, v3 ->
`lib.dom.d.ts`). **Fix**: added all four. Rebuild + re-dump + re-diff again:

| metric | pre-fix | post-`HTMLElement` | post-4-more-names |
|---|---:|---:|---:|
| `v4_different_target` | 7,029 | 195 | **20** |
| `v4_same_target` | 1,749,006 | 1,749,006 | 1,749,006 |
| `v4_missing` | 1,389,777 | 1,396,611 | 1,396,786 |

(`v4_missing` rose slightly across fixes -- expected: a reference whose target used to be
misclassified as "different" from a workspace `.d.ts` can end up unresolved/missing instead once
the standard-lib target is preferred, if v4's own ambient resolution for that specific call site
still does not independently reach the lib declaration; not investigated further, out of R19's own
scope.)

**Disposition of the remaining 20** (a fresh sample of all 20): every one is a **same-file
member/property/parameter shadowing** case unrelated to global names or namespace merging --
constructor-parameter-vs-property duplicate declarations (`v3_target=jsts:parameter:...`,
`v4_target=jsts:property:...`, same file, different line) and method-overload/inheritance shadowing
where a subclass or later declaration of the same name exists in the same file (`getSelection`,
`updateOptions`, `createObservable`, `read`, etc., v3 and v4 picking different same-named
declarations in the same file). This is a **different root cause** than R19 authorizes fixing
(`is_standard_global_name` / namespace merge) -- **reported as a P0 for the owner's queue** (§9)
with the full 20-row sample retained in `v4-fold/p2-tests/v3fix2/references-parity-diff.log`, not
fixed here. `different == 0` still does not hold in the strict sense (20 > 0), but the two
authorized R19 mechanisms are now exhausted: 99.7% of the original gap (7,029 -> 20) traced to
exactly the two documented root causes and was fixed; the residual 0.00064% (20 of 3,145,812) traces
to a distinct, unauthorized-to-fix root cause and is reported rather than silently patched.

`v4_missing` (44.4% of v3-confirmed sites) breaks down mostly as `import_binding/unresolved_
specifier` (668,534, ambient/cross-package import resolution v4 does not attempt) and various
`member_access/*` reasons (593K combined, type-inference gaps at the method/property level) --
consistent in shape with n8n's own historical `v4_missing` reason histogram, just larger in absolute
terms at VS Code's ~2.3x record scale and its much heavier use of cross-package imports across the
monorepo's many separate `tsconfig.json` roots (not investigated further -- out of this task's
scope, and not gated by R19, which only requires `different == 0`, not a missing-rate ceiling).

### 5.2 Calls (`scripts/v4-call-parity-diff.mjs --samples 50`, post-R19-fix binary)

`v3 confirmed core:call sites=743,472` (of 903,291 total, 159,819 `possible`).

| metric | value | % of v3-confirmed |
|---|---:|---:|
| `v4_confirmed_same_target` | 179,705 | 24.17% |
| `v4_confirmed_different_target` | 44 | 0.01% |
| `v4_possible` | 547,504 | 73.64% |
| `v4_missing_site` | 16,219 | 2.18% |
| reverse `v4_confirmed_v3_missing_site` | **0** | -- |

The 44 `different_target` samples are the same "different root cause" class as §5.1's remaining 20
-- e.g. `this._fetch(...)` where v3 resolves the call to the *global* `fetch` (`lib.dom.d.ts`) while
v4 correctly resolves it to the local `_fetch` property/parameter (arguably v4 is *more* correct
here, not less -- v3 appears to fuzzy-match `_fetch`/`fetch` rather than making an actual mistake
class R19 addresses) -- plus the same method-shadowing pattern (`getSelection`, `updateOptions`,
`createMarkupPreview`). **Not fixed** (same disposition as §5.1's remainder): reported as a P0 with
samples in `v4-fold/p2-tests/v3fix2/call-parity-diff.log`.

### 5.3 Populations (`scripts/v4-population-parity.mjs`, table only -- n8n floors not meaningful here)

```
kind                                 v3         v4    v4/v3      floor ok
jsts:entity_callable             108985     108985    1.000      29921 OK
jsts:entity_container             10603      10611    1.001      14847 FAIL (n8n floor, not meaningful)
jsts:entity_parameter               n/a     236563      n/a      78966 OK  (v3 has no comparable population)
jsts:entity_type                  31832      32110    1.009      14047 FAIL (n8n floor, not meaningful)
jsts:entity_variable             352631     357594    1.014     238491 OK
jsts:relation_contains           513009     749832    1.462     396483 OK
jsts:relation_references        3145812    1786602    0.568    1205324 FAIL (n8n floor, not meaningful)
external_module                     n/a        250      n/a        905 FAIL (n8n floor, not meaningful)
external_symbol                     n/a       1136      n/a       3780 FAIL (n8n floor, not meaningful)
records_total                   5697685    3546558      n/a    2165060 OK
```
Per the task's own instruction, the "OK"/"FAIL" column (calibrated against n8n's stored floors) is
not a gate here -- only the `v3`/`v4`/`v4/v3` columns are informative. `jsts:relation_references`
v4/v3 = 0.568 is the same figure as §5.1's 55.6% `v4_same_target` + a sliver of `different_target`,
consistent between the two independently-run scripts. `records_total` differs (5.70M vs 3.55M)
because v3's `record_occurrences` counts every row (including non-`core:references` relations,
duplicate occurrences per site, etc.) while v4's dump counts distinct visible structural records at
one generation -- the two are not directly comparable at the aggregate level, only kind-by-kind
where a `v3_kind` mapping exists (matching prior n8n evidence docs' own caveat).

---

## 6. Index pack (P-1's mechanism, exercised at VS Code scale)

### 6.0 A daemon-shutdown wrinkle (observed, not a P0 -- worked around)

The first `v4-add` (building the exportable `ready` donor workspace) and the first
`index-pack-export` attempt both hit `spawn EBADF` on the semantic-maintenance child process (the
same class of defect commit `52c1ff8` hardened against, resurfacing under this session's own heavy
concurrent load: git clones, cargo test compiles, and another daemon all spawning processes within
the same few seconds). It is non-fatal (semantic indexing is best-effort, off the structural
readiness critical path -- the workspace still reached `ready`), but the retried semantic child then
kept running long enough to make the daemon's own graceful-shutdown handshake time out once
(`core:daemon_restart_required: restart_lease_timeout`) after the export had already succeeded and
been written to disk. Fix for this session: `URDIRA_SEMANTIC_INDEX=0` on every daemon-driven
workspace-add/import call from here on (§0) -- structural pack correctness never depends on
semantic embeddings. Also found and worked around in the driver script itself: `core:
index_pack_export` is not in `runUrdira`'s own `longRunning` deadline list (`apps/urdira/src/
index.ts`), so a plain CLI-driven call gets the default ~30s admin RPC timeout and aborts a VS
Code-scale export (`core:ipc_timeout` at exactly 30,002ms observed live) -- worked around by calling
`core:index_pack_export` directly via `DaemonClient` with an explicit long `deadline_at`, bypassing
the CLI's own timeout policy for this one call. Neither issue touches product code (only the
external measurement script), so neither is fixed in this session's diff; both are flagged for the
owner's queue in §9.


### 6.1 Export

`index-pack-export` on the `ready` v4 donor workspace (`p2-pack-donor-data`, generation 1).
Measured twice: first under a load spike (1-min load 11-18, wall 109.208s -- discarded per the
task's own load>8 rule) and once clean (load 1.87-3.49) -- the clean run is used everywhere below.

```
{"wall_ms":63488,"bytes":1571126244,"generation":1,"roots":{...}}
```

- **`pack_bytes` = 1,571,126,244** (gzip container; decompresses to 3,913,041,719 bytes -- verified
  by decompressing and parsing the manifest: `format=urdira-index-pack-v4`, `schema_version=1`,
  `generation=1`, 29 files, `workspace_id` matches the donor).
- **export wall = 63.488s** (clean; the load-spike run was 109.208s for the identical generation --
  byte-identical size to within 317 bytes, confirming the size difference between runs is noise, not
  a correctness gap, and the wall-time difference is pure CPU contention from the concurrently
  running v3 baseline).

### 6.2 Import -- same tree (noop)

`workspace-add --index-pack <pack>` on a **fresh** data root, pointed at the **same** `p2-donor`
tree the pack was exported from. Measured twice (load-spike run discarded, clean run below).

```
ready_elapsed_ms: 25459
last_scan: {
  "kind": "reconcile",
  "reconcile": { "added": 0, "changed": 0, "deleted": 0, "fell_back_to_cold": false,
                 "frontier_size": 18049, "metadata_refreshed": 0, "mode": "noop", "threshold": 0.01 },
  "timings": { "total_ms": 3451 }
}
```

Exactly the mechanism plan §7.1 item 3 describes: the import (staging copy + Merkle verify +
`rewriteV4WorkspaceIdentity`/`workspace_meta` re-pin) is followed by a `scope: reconcile` scan (not
`full`, despite `isFirstScan`), which the daemon runs because the imported DB already carries
generation > 0; the reconcile sees zero diff and reports `mode: "noop"`, and `markReady` completes
normally. **`reconcile_wall(noop) = 3.451s`** (the `total_ms` of that one reconcile scan).
**`ready_elapsed_ms = 25.459s`** is the combined import+reconcile+registration wall (there is no
product-exposed metric that isolates import alone from registration overhead; the implied
`import_wall ≈ ready_elapsed_ms - reconcile_wall ≈ 22.0s` is reported as an approximation, not a
precise measurement -- see §9 for a suggested follow-up: a dedicated `import_wall` field on
`ReconcileSummary`/`ScanCompleted` would close this gap cheaply). The load-spike run (24.203s
ready_elapsed / 3.262s reconcile) is consistent with the clean run within ~5%, confirming this
particular step is not meaningfully contention-sensitive at this scale (unlike the export step).

### 6.3 Import -- `HEAD~50` and a smaller real diff (delta mode confirmed)

`git fetch --depth=60` deepened the corpus's own shallow (`--depth 1`) clone in a scratch clone
(`p2-head50`, never touching the shared read-only corpus). `HEAD~50` from the pack's own donor
commit (`a44adf7`) turned out to touch **258 of 18,049 frontier files (1.43%)** -- above the `T=0.01`
threshold -- so reconcile correctly (per R1's own design) fell back to **`mode: "cold"`**, not
`delta`, exactly like F.3's own real git-switch findings on n8n (a 50-commit window on an
actively-developed monorepo routinely exceeds 1%). Reported plainly rather than forcing a
different offset to match the plan's a-priori assumption of "delta":

```
reconcile: { added: 1, changed: 226, deleted: 31, mode: "cold", threshold: 0.01, frontier_size: 18049 }
timings: { total_ms: 36260 }   // ready_elapsed_ms: 61187
```

To also exercise the delta path itself (needed for R17/§7.1's own "reconcile absorbs the donor/local
diff" claim), the same pack was imported against a second checkout at `a44adf7~3` (9 files changed,
0.05% -- picked by walking `a44adf7~{1,2,3,5}` diff stats until one landed under `T`):

```
reconcile: { added: 0, changed: 9, deleted: 0, mode: "delta", threshold: 0.01, frontier_size: 18049,
             metadata_refreshed: 18040 }
timings: { total_ms: 42108 }   // ready_elapsed_ms: 64399
```

Delta mode's own reconcile (42.1s) is *slower* than the cold-mode fallback above (36.3s) despite
touching far fewer files -- consistent with F.3's own documented architectural property: `run_
reconcile`'s `enumerate()` step always does a full authoritative walk+hash of the corpus regardless
of how few files changed, so delta's floor sits close to cold's own wall on this corpus. Not a
regression, not this task's scope to change, and not relevant to R20 (which gates on the `noop`
case only). `find_references` parity between donor and both imported copies was not separately
re-checked beyond the reconcile's own Merkle/frontier verification (already exercised in delta/cold
mode above); see §8 for the donor-workspace `find_references` readiness numbers instead.

### 6.4 Pack size vs `structural/`

`pack_bytes` (1.57GB gzip) is **~44%** of the uncompressed `3,913,041,719`-byte container and
**~44%** of the on-disk `structural/` (3.6G) + `workspace.sqlite` combined size -- a modest gzip
ratio for this binary structural format (dictionaries, hot/secondary record files, adjacency),
consistent with prior packs (`c2`/`c3-2026-08-24`, 405-461MB for a much smaller n8n-scale store).

---

## 7. R20 decision

Formula (§0 R20): `pack_bytes / (50 MB/s) + import_wall + reconcile_wall(noop) < 0.5 x cold_v4_wall(VS Code)`, AND `different == 0`.

Using the clean (non-contended) numbers from §6.1/6.2 and §1's median cold wall:

- `pack_bytes / (50 MB/s)`: 1,571,126,244 / 50,000,000 B/s = **31.42s** (decimal MB/s; 29.97s if
  read as MiB/s -- the conclusion below is insensitive to which convention is used).
- `import_wall + reconcile_wall(noop)` = `ready_elapsed_ms` (same-tree noop import, §6.2) = **25.459s**.
- **LHS = 31.42 + 25.459 = 56.88s** (56.43s under the MiB/s reading).
- **RHS = 0.5 x 29.96s = 14.98s**.

`56.88s < 14.98s` is **false**, by a factor of ~3.8x. The gate fails decisively, and it fails even
in the best case for C: **dropping the transfer term entirely** (as if the pack were already local,
zero-cost to fetch) still leaves `import_wall + reconcile_wall(noop) = 25.459s > 14.98s` -- C would
still fail R20 on the import+reconcile overhead alone, before any network cost is even counted. The
root cause is structural, not a measurement artifact: v4's cold scan on this corpus is now fast
enough (~30s) that the pack mechanism's own fixed overhead (import's staging/Merkle/identity-rewrite
work, plus a reconcile scan that -- per §5.3 -- always re-walks the whole corpus even in the noop
case) can no longer clear half that bar, regardless of how the pack itself is transported.

**Decision: C CERRADO (R20 fails; D5 = no implementar).** This conclusion does not depend on the
`different == 0` parity gate (§4/§5 below) -- the numeric gate alone is sufficient and is not close
to the boundary in either direction. Per R20's own text, §8 (Frente C, pack transport) is not
implemented in this session, and no PackStore/`pack-store.ts` code is introduced.

---

## 8. Readiness

### 8.1 `find_references`, cold vs warm (VS Code)

Query: `resolve_symbol(reference="MainThreadCommands", resolution_scope="workspace")` ->
`find_references` (a uniquely-named, unambiguous class in this corpus --
`src/vs/workbench/api/browser/mainThreadCommands.ts`; two more common names tried first,
`Disposable` and `IInstantiationService`, resolved ambiguously to 14 and 4 candidates respectively
and were rejected by the query engine itself, `core:stage_type_mismatch`, before any timing was
useful). Measured against the clean-import workspace (§6.2's clean run), fresh daemon start (true
cold: no warm page cache, no query-plan cache), then two immediate repeats (warm):

| run | wall | reference_count | owner_count | completeness |
|---|---:|---:|---:|---|
| cold | 116.315s | 1 | 1 | complete |
| warm 1 | 109.407s | 1 | 1 | complete |
| warm 2 | 109.449s | 1 | 1 | complete |

Correct result (1 reference, 1 owner -- matches the corpus: `MainThreadCommands` is instantiated
exactly once, in `mainThreadExtensionHost` wiring). But **cold and warm are within 6% of each
other** -- essentially no warm-cache speedup, unlike n8n's own historical readiness numbers
(memory: "VS Code 469s->278.6s, primera query 19.5s sin flap" from an earlier, pre-this-session
readiness campaign context, and n8n queries generally land in the tens-of-ms to low-seconds range
once ready). A first attempt at this same measurement, run during the load spike noted in §6, also
landed in the same 107-111s range -- confirming this is **not** contention noise but a real,
reproducible ~110s floor for `resolve_symbol(resolution_scope="workspace")` at VS Code's ~13k-file,
~4.5M-record scale, independent of caching. **Flagged as a P0 candidate for the owner's queue**
(§9) -- not fixed here (out of this task's authorized file list, and warrants its own
investigation: `resolution_scope="workspace"` likely performs a linear scan whose cost tracks
corpus size rather than being resolved through an indexed lookup).

### 8.2 Cold v4 vs n8n (scale)

Already reported in §1.1: VS Code carries 2.0-2.3x n8n's record/RSS footprint at only 1.18-1.19x
the wall time.

---

## 9. P0/P1 items found live (not fixed -- outside this task's authorized files)

1. **P0 candidate -- `find_references` readiness ~110s at VS Code scale, cold=warm** (§8.1).
   Reproduced twice (once under load, once clean), both ~107-116s, no warm-cache improvement.
   Suspect: `resolve_symbol(resolution_scope="workspace")` performing a linear scan whose cost
   scales with corpus size instead of an indexed lookup. Needs its own investigation session.
2. **P1 -- residual budget overshoot scales with corpus size** (§2). n8n at the same 20s budget
   overshoots by ~0.3-0.35s; VS Code overshoots by 2.276s (~6.5x), with a lower completed-window
   fraction (50% vs 75%). Not a correctness issue (both classification-mismatch asserts still pass
   at 0), but worth tightening the checker's own cancellation granularity for large corpora.
3. **P1 -- daemon-shutdown/EBADF and export-timeout wrinkles** (§6.0). Two workarounds applied at
   the measurement-script level (`URDIRA_SEMANTIC_INDEX=0`, a direct `DaemonClient` call with a
   long `deadline_at` for `index-pack-export`) rather than product fixes. Two real product gaps
   worth closing: (a) `core:index_pack_export` should be added to `runUrdira`'s own `longRunning`
   deadline list (`apps/urdira/src/index.ts`) so a plain CLI call does not time out at ~30s on a
   large export; (b) the semantic-maintenance child's `spawn EBADF` under heavy concurrent process
   creation (commit `52c1ff8` hardened against this once already) resurfaced live in this session
   and delayed a graceful daemon shutdown into a `restart_lease_timeout` -- worth a second look at
   whatever spawn-retry/backoff logic `52c1ff8` added.
4. **Approximation, not a defect** -- no product-exposed metric isolates `import_wall` from
   `reconcile_wall` inside a pack-import scan (§6.2); `ReconcileSummary`/`ScanCompleted` could grow
   an `import_ms` field cheaply if this pairing is measured again.
5. **P0 -- a failed v3 scan leaves the workspace reporting `status: "indexing"` forever** (§4.0).
   `core:engine_failed` aborted the scan at t=83.9s; polling `core:workspace_admin_show`/`core:
   index_status` afterwards showed `state=indexing` for over 100 minutes (the daemon process was
   confirmed alive but fully idle, near-zero CPU consumed, the whole time) with no `last_scan_error`
   surfaced and no automatic retry or failure transition. Any real caller polling workspace status
   the way this campaign's own harness does (and the way the CLI/MCP tooling does) would wait
   forever with no signal that anything went wrong. Worth fixing before this ships to users.
6. **P0 -- v3's cold-scan pipeline aborts the entire scan on any one "facts incomplete" file**
   (§4.1). Six distinct offending files were found across two different VS Code extensions plus one
   legitimate build script (`scripts/xterm-update.js`, a bare top-level `return` in a CommonJS
   `.js` file -- valid Node semantics, rejected by v3's own completeness check). v4 scans the exact
   same files without issue. A single malformed/edge-case file should not abort an entire
   multi-million-record corpus scan.
7. **P0 -- 20 references / 44 calls with a `different_target` root cause outside R19's scope**
   (§5.1/§5.2). Same-file member/property/parameter shadowing (constructor parameter properties,
   method overloads/overrides sharing a name) where v3 and v4 pick different same-named
   declarations in the same file; in at least one call-site pattern (`this._fetch(...)` resolved by
   v3 to the *global* `fetch`) v4's own answer looks more plausible than v3's. Full samples
   retained in `v4-fold/p2-tests/v3fix2/{references,call}-parity-diff.log`. Needs its own resolver
   precision investigation, not an `is_standard_global_name`/namespace-merge fix.
8. **P0 -- v3 hit `database or disk is full` at ~5.7M rows on a near-capacity machine** (§4.2). Not
   a v3 defect by itself, but `promo_record_insert` alone briefly held the SQLite write open with
   both a growing DB file and WAL for 10-15 minutes at ~99% disk capacity -- worth confirming v3's
   own publish path fails cleanly (rolls back, does not corrupt the DB) under this exact condition,
   since this session did not deliberately verify DB integrity after the failure (it was simply
   deleted and retried on more free space).

None of these block the R20 decision (§7): the numeric gate fails by a wide enough margin (~3.8x,
and still failing with the transfer term dropped to zero) that none of the above, even in the
most favorable direction, would flip it.

---

## 10. Cleanup

- `git worktree`/isolation: none used (worked directly on `main`, per the task).
- Scratch git clones deleted at the end of this session: `p2-donor` and `p2-head50` (both cold-scan
  and pack-donor trees), `p2-excluded-fixtures` (the moved-out copilot/fixtures/xterm-update.js
  content, no longer needed once the parity numbers were captured).
- Scratch data roots deleted: all `p2-cold/run-*` structural stores, `p2-pack-donor-data`, every
  `p2-import-*` data root (same-tree/HEAD~50/HEAD~3 imports), the large intermediate reference/
  call-body binary dumps (`p2-tests/*.bin`, `p2-tests/{v2,v3fix,v3fix2}/*.bin`, several GB each,
  superseded once each diff's own JSON/log result was written).
- Reclaimed disk space across this session: freed ~40GB mid-campaign to unblock v3's own
  `disk is full` failure (§4.2), and a further ~50GB at final cleanup; free space went from 14GB
  (the failure point) to 100GB (end of session).
- **Retained** (all under `~/Proyectos/urdira-benchmark/`): the v3 oracle DB
  (`v3-vscode-2026-09-07/workspaces/workspace_p2-donor_fa50cf46-34a5-4da5-960d-a6b5e7291524.sqlite`,
  25.2GB, per the task's own instruction), the v4 index pack (`p2-2026-09-07/vscode-v4-clean.pack`,
  1,571,126,244 bytes, per the task's own instruction), and every parity/dump/diff log and result
  JSON under `v4-fold/p2-tests/` (`populations.tsv` for both the full-tree §3 dump and the
  reduced-tree §5.3 dump, `{references,call}-parity-{diff.log,result.json}` for both the pre-fix
  and post-fix R19 runs, the residual-histogram logs, and the daemon driver script itself,
  `v4-fold/p2-daemon-driver.mjs`, plus a representative subset of the raw scan logs that document
  each bug found live in §4/§9 -- not every one of the ~15 retry attempts' own logs, but the ones
  that show the stuck-forever bug, the disk-full failure, and the final successful run).
- All daemons for this session's data roots stopped; `pgrep -fl "apps/urdira/dist|urdira-indexing-
  worker"` at the end of this session shows only another concurrent agent session's own processes
  (a different worktree, `agent-aebe6d0370ad4b702`, and a `sg-native-root` native binary -- neither
  touched, per the coordinator's own instruction to kill only this session's own processes).
- `git status --short`: clean beyond the three authorized files (the population-floors skip gate,
  the R19 `is_standard_global_name` additions, this evidence file).

---

## 11. E-P0k (2026-09-08): same-file member/parameter shadowing -- root causes, fixes, residual

Task: close item 7 of §9's P0 list (the 20 `core:references` + 44 `core:call`
`different_target` samples from §5.1/§5.2, outside R19's own authorized scope). Base `a07e379`,
worked in `.claude/worktrees/agent-a23ba29ccaced6b14`, branch `frente-ep0k-shadowing`.

### 11.1 The task's own a-priori hypothesis did not match reality

The task brief pointed at `visit_identifier_reference`/`param_owner_stack`/`resolve_named_
binding_via_specifier`/`resolve_ambient_global` (bare-identifier lexical scoping) as the likely
mechanism, and asked for a 6-bucket classification (parameter-shadows-module, `this.x` vs local
`x`, block/catch/for shadowing, destructured property, nested-arrow parameter, other). Reproducing
the retained samples (`v4-fold/p2-tests/v3fix2/{references,call}-parity-diff.log`, byte offsets
decoded with a small script against the pinned corpus) showed EVERY ONE of the 20+44 is
member-access-shaped (`this.x`/`obj.x`/`obj.x()`), never a bare-identifier lexical-scope collision
-- `visit_identifier_reference` and its stacks were never the mechanism. The real root causes live
in `resolve_static_member_reference`/`resolve_call_target_typeflow` (`crates/urdira-jsts-syntax-
worker/src/semantic_sites.rs`) and `ProgramIndex::collect_members`/`members` (`crates/urdira-jsts-
typeflow/src/lib.rs`) -- this is recorded here as "decided in implementation" per the plan's own
discipline (§0: apply criteria (a)-(c), document, proceed).

### 11.2 Classification (real mechanisms, not the task's a-priori six)

| # | Pattern | Sample(s) | Mechanism | Fixed? |
|---|---|---:|---|---|
| A | `extends` chain has an untracked/unresolvable ancestor; `implements` interface used as a guessed stand-in for the real (untracked) implementation | `getSelection`x4/`getHTMLElement` (`markersView.ts`, `MarkersTree extends WorkbenchObjectTree<...> implements IProblemsWidget`), `updateOptions` (`standaloneCodeEditor.ts`) | `collect_members`'s `implements` fallback fired even when the `extends` walk did not confidently exhaust to empty | **Yes** -- `ResolvedContainer::has_unresolved_extends` |
| B | Explicit `this: T` parameter; `this` inside such a method must type as `T`, never the enclosing class | `createObservable`/`instantiateObservable`/`instantiateAppend`/`createAppend` (`domWidget.ts`, each `public static <name>(this: DomWidgetCtor<...>, ...)`) | `type_of_expression`'s `ThisExpression` arm always used `class_stack.last()` unconditionally | **Yes** -- `explicit_this_param_stack` |
| C | A concrete subclass overrides a member an abstract base only inherits from an `implements`ed interface (no `extends`-chain uncertainty at all -- the ambiguity is "this interface has a KNOWN, differently-declared implementor") | `zenModeIgnore` (`layout.ts`, `WorkbenchLayoutStateKey implements IWorkbenchLayoutStateKey` vs `RuntimeStateKey`'s own override) | Same `implements` fallback, different trigger: no unresolved ancestor, but a sibling container's own `extends` chain reaches the queried entity and declares its own override | **Yes** -- `ProgramIndex::has_known_subclass_override` (linear scan, gated on the same rare fallback branch as A) |
| D | `instanceof`-narrowed receiver, PROPERTY read | `value` (`slugify.ts`, `other instanceof GithubSlug && ...other.value...`), `location`x2 (`references-view`, `else if (oldInput instanceof TypesTreeInput) { ...oldInput.location... }`) | `type_of_expression` used the receiver's UNNARROWED declared/interface type; this crate does no control-flow narrowing at all | **Yes** -- bounded `instanceof_narrowings` stack (`if`-consequent and `&&`-right-hand-side only, never `else`, never past the guarded region) |
| E | `instanceof`-narrowed receiver, but the member is a METHOD/getter/setter/constructor, not a property -- v3's real answer stays the UNNARROWED declared type's own method even inside the SAME guarded region D correctly narrows for a property | `getControl` (`mergeEditor.ts`, `activePane instanceof MergeEditor && activePane.getControl()`) | Found live as a REGRESSION introduced by D itself (adversarial self-review, same session) -- narrowing a receiver for a CALL/method-read is unsound the way it is sound for a property read | **Fixed** -- `Self::narrowed_target_is_a_callable_kind` rejects a narrowed resolution whose target kind is method/getter/setter/constructor (both the plain-read and call-target consumers); the position falls back to `checker_pending` rather than guess either declaration |
| F | Union receiver with a real primitive constituent (`string \| TestId`) silently collapsed to just the class constituent (`is_dropped_union_constituent` drops `string`/`number`/`boolean`/`bigint`/`symbol` the same way it drops `null`/`undefined`) | `toString` (`testId.ts`, `joinToString(base: string \| TestId, b: string)`) | `type_ref_of_ts_type`'s `TSUnionType` arm (duplicated in `urdira-jsts-typeflow`) treats a real primitive exactly like `null`/`undefined`, which is sound (no members to collide with) for the nullish case but NOT for a real primitive (`string` has its own `toString`, genuinely different from a class override) | **Not fixed this task** -- see §11.4 |
| G | `typeof <expr>` (`TSTypeQuery`)-typed member CALLED as a function; v3's real call-target resolution follows the signature to `<expr>`'s own declaration, not the member's own | `_fetch`/`log`/`_now`/`_fetchFn`/`spawnRipgrepCmd`/`matchQuery` (many files, each `private readonly x: typeof globalThis.fetch` / `typeof console.log` / etc., called as `this.x(...)`) | This crate's call-target resolution has no notion of "the callee's OWN declared type is itself a type query" at all | **Not fixed this task** -- see §11.4 |
| H | Declaration-file vs. real-implementation split (`marked.d.ts` vs `marked.js`) | `marked` (`walkThroughContentProvider.ts`) | Import target resolves to the `.js` implementation file, not the `.d.ts` the checker's own symbol table prefers | **Not fixed this task** -- 1 sample, unrelated to shadowing, out of scope |

Patterns A-E are pure member/parameter-shadowing mechanisms (this task's own mandate); F/G/H are
adjacent-but-distinct resolver-precision gaps this session's sampling exposed as a side effect of
closing A-E. Each is reduced to a minimal synthetic fixture with a passing (post-fix) or
documented-failing (pre-fix) unit test in `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`
and `crates/urdira-jsts-typeflow/src/lib.rs` (see `git log`/`git show` on this task's own commits
for the exact tests: `members_never_guesses_implements_when_the_extends_chain_is_unresolved`,
`members_still_falls_back_to_implements_when_the_extends_chain_is_fully_resolved_and_empty`,
`members_never_guesses_implements_when_a_known_subclass_overrides_the_same_member`,
`this_expression_inside_an_explicit_this_parameter_method_never_resolves_to_the_enclosing_class`,
`this_expression_still_resolves_normally_without_an_explicit_this_parameter`,
`call_through_this_never_falls_back_to_an_implemented_interface_when_the_extends_chain_is_unresolved`,
`member_read_never_guesses_implements_when_a_known_subclass_overrides_the_same_member`,
`instanceof_narrowed_member_read_inside_a_logical_and_resolves_to_the_narrowed_class`,
`instanceof_narrowed_member_read_inside_an_if_consequent_resolves_to_the_narrowed_class`,
`instanceof_narrowing_never_leaks_past_its_own_guarded_region`,
`instanceof_narrowing_never_applies_to_a_calls_own_target_resolution`).

### 11.3 The rule actually applied (per pattern)

- **A/C** (`ProgramIndex::collect_members`, `urdira-jsts-typeflow`): the `implements` interface
  fallback is sound ONLY when the class's own `extends` chain was walked to a CONFIDENT, fully
  resolved, genuinely-empty end (no unresolved ancestor anywhere along it -- new `ResolvedContainer::
  has_unresolved_extends` flag) AND no other KNOWN container in the whole index is a transitive
  `extends` descendant that declares its own override of the same member (`has_known_subclass_
  override`, a linear scan over `containers` -- deliberately not a maintained reverse index, since
  this branch is rare by construction: reached only when both the own-members check AND the entire
  extends walk already came back empty). Either condition failing degrades the lookup to
  `MemberLookup::None`/`Many` (per the existing `Many`-is-never-promoted invariant, decision 28) --
  never a guess.
- **B** (`explicit_this_param_stack`): an explicit `this: T` parameter on the innermost method
  blocks `class_stack` from being consulted for `this` at all; this crate does not attempt to
  resolve `T` itself (a type alias to an inline object literal, a generic, ...), so the position
  stays pending rather than resolve to anything.
- **D/E** (`instanceof_narrowings`): `if (x instanceof C) { ...consequent... }` and `x instanceof C
  && ...right...` push `(symbol_id, C's entity_id)` for the DURATION of exactly that lexical region
  (never the `else`, never past the statement/expression, no dataflow merge at join points) --
  bounded, syntax-local, "only ever miss, never guess". Consulted before any declared/inferred type
  in `type_of_expression`'s `Identifier` arm. Gated OFF for a CALL's own target resolution and for a
  resolved target whose kind is method/getter/setter/constructor (`narrowed_target_is_a_callable_
  kind`) -- v3's real answer for those stays the UNNARROWED declared type's own declaration even
  inside an identical guarded region, a genuine (if unexplained) asymmetry between property lookup
  and call/method resolution in the real checker this crate mirrors rather than rationalizes.

Lexical scope resolution itself (`visit_identifier_reference`, `param_owner_stack`, oxc's own
`Scoping`) needed no changes: oxc's scope resolution already implements innermost-first, block/
catch/for-aware, hoisting-correct lexical lookup, and members are never reached by a bare
identifier in this crate's model (matches the task's own stated invariant already).

### 11.4 Residual (not fixed this task, reported per the "never guess, report the rest" precedent R19 itself set)

Patterns F/G/H (§11.2) remain, all in the CALLS bucket except one reference sample (`toString`,
pattern F is shared by both). F requires distinguishing "drop, no collision possible" (`null`/
`undefined`, sound) from "drop, a real collision is possible" (a genuine primitive with its own
member table) in `is_dropped_union_constituent` -- a change to logic SHARED across this crate and
`urdira-jsts-typeflow` (function return types, member declared types, not just member-access
receivers), correctly out of this task's own risk budget to make and fully re-measure in the time
available. G requires recognizing a `TSTypeQuery` (`typeof <expr>`) annotation on the CALLED
member and deferring to pending rather than resolving through the member's own declaration -- a new,
self-contained feature, not implemented this task. H (1 sample) is an import-resolution quirk
unrelated to shadowing. None of these three is a regression relative to `a07e379` (all three
existed, unclassified, in the original 20+44); all three are recommended as the next owner-queue
items under this same P0's own tracking id.

### 11.5 VS Code corpus, live measurement

Corpus: `vscode-corpus-2026-09-06` (read-only), reduced by rsync `--exclude='**/fixtures/'` plus
removing `scripts/xterm-update.js` into scratch `v4-fold/ep0k-vscode/reduced-tree/` (37,833 TS/JS
files after exclusion, matching the SAME two exclusion categories §4.1's evidence used -- the
`find` COUNT differs from that entry's own 10,273 figure, most likely a narrower glob at capture
time; the walker's own frontier is what a v4 cold scan actually processes, and this session did not
attempt to reconcile the two counts further). v3 oracle: retained `v3-vscode-2026-09-07/workspaces/
workspace_p2-donor_fa50cf46-34a5-4da5-960d-a6b5e7291524.sqlite` (unchanged, read-only). v4 cold scan
on the reduced tree (release binary, this task's own commits): ~75-110s wall per run (`n8n_
references_parity_debug_dump`, generic despite the env var's own `N8N`-shaped name).

Progression across the fix sequence (`scripts/v4-references-parity-diff.mjs --samples 64`, `scripts/
v4-call-parity-diff.mjs --samples 64`), each row a full rebuild+rescan+diff:

| stage | refs same | refs different | refs missing | calls same | calls different | calls possible | calls missing |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline (§5.1/§5.2, pre-task) | 1,749,006 | 20 | 1,396,786 | 179,705 | 44 | 547,504 | 16,219 |
| + A (unresolved-extends) | 1,748,992 | 9 | 1,396,811 | -- | -- | -- | -- |
| + C (known-subclass-override) | 1,749,419 | 8 | 1,396,388 | -- | -- | -- | -- |
| + B (explicit `this`) + D (instanceof narrowing) | 1,749,419* | 5** | 1,396,388 | -- | 30** | -- | -- |
| + E (narrowing-vs-callable-kind guard, fixes a D-introduced regression) | 1,749,290 | **3** | 1,396,519 | 149,591 | **30** | 549 | 593,302 |

\* B/D/E were measured together (B and D landed in the same build before the first post-fix
corpus run; D introduced 2 new `getControl` divergences live, caught by this same session's own
adversarial self-review and closed by E in the SAME session before this table's own final row).
\*\* the calls-bucket count of 30 is unchanged across the B/D/E rows because none of A/B/C/D/E
touch pattern F/G/H, which dominate the calls residual (§11.4) -- the calls bucket's OWN
improvement (44 -> 30) came entirely from A (`getSelection`x4/`getHTMLElement`) + B
(`createObservable`/`instantiateObservable`/`instantiateAppend`/`createAppend`) + an
unattributed extra fix (`updateOptions`, `i18n.XLF.parse`) whose exact mechanism among A/C was not
individually isolated (both touch the same `collect_members` code path).

**Final**: references `same=1,749,290` (55.61%), **`different=3`** (pattern F/G/H, §11.4),
`missing=1,396,519` (44.39%, reasons unchanged in shape from §5.1's own histogram, not
re-investigated -- out of this task's scope). Calls `same=149,591` (20.12%), **`different=30`**
(pattern F/G/H, §11.4), `possible=549` (0.07%), `missing_site=593,302` (79.80%).
`different == 0` **does not hold** for either population at task close -- §11.4's residual is the
reason, reported rather than force-closed with an unauthorized/unmeasured broad change or a guess.
Population-parity (`scripts/v4-population-parity.mjs`, table only, n8n floors not meaningful here
per §5.3's own caveat) not re-run this task (unaffected by a pure target-selection fix -- record
COUNTS do not change, only which existing record a reference/call resolves to).

### 11.6 n8n corpus, live measurement (population floors + parity, real gate)

Corpus: `n8n-corpus-2026-09-02` (read-only). v3 oracle: retained `v3-n8n-2026-09-07-b/workspaces/
workspace_n8n-corpus-2026-09-02_d99f1eb3-a76a-4699-a6af-cd2df00a8516.sqlite`. Cold scan wall
21.6-47.5s across runs (machine load varied; no dedicated at-rest measurement this task).

`n8n_population_floors` (release, `#[ignore]`, this task's final binary): all 10 floors `OK`
(`jsts:entity_callable` 30224/29921, `jsts:entity_container` 15231/14847, `jsts:entity_parameter`
79764/78966, `jsts:entity_type` 14276/14047, `jsts:entity_variable` 241774/238491, `jsts:relation_
contains` 406465/396483, `jsts:relation_references` 1241353/1205324, `external_module` 1149/905,
`external_symbol` 4040/3780, `records_total` 2198527/2165060).

References parity: `v3 confirmed=1,340,591`; `v4_same_target=1,187,192` (88.56%, **up** from the
pre-task baseline 1,187,143 -- D's own narrowing resolves a handful of n8n sites this task never
sampled individually), **`v4_different_target=0`**, `v4_missing=153,399` (11.44%). Calls parity:
`v3 confirmed=207,584`; `v4_confirmed_same_target=93,364` (44.98%, unchanged), **`v4_confirmed_
different_target=0`**, `v4_possible=479`, `v4_missing_site=113,741`. Population-parity
(`scripts/v4-population-parity.mjs --floors scripts/v4-population-floors.json`): all 10 kinds `OK`,
`records_total` v3=3,506,275 v4=2,198,527 (same non-comparability caveat as the original evidence's
own §5.3). Residual histogram (`n8n_residual_pass_debug_histogram`): cold `confirmed_combined=
105,523`; after residual `confirmed_combined=161,811` -- `abs_diff` from the pinned
`REFERENCE_CONFIRMED_COMBINED=161,807` is **4**, within the existing `CONFIRMED_COMBINED_TOLERANCE`
(test passed; constant left unchanged, no update warranted since the drift is inside tolerance).
`classification_mismatch_count=0` at both generations. **n8n's own gate (`different == 0` in both
populations, all floors, `confirmed_combined` within tolerance) is fully green with this task's
fixes.**

### 11.7 Files touched, verification, cleanup

- `crates/urdira-jsts-typeflow/src/lib.rs`: `ResolvedContainer::has_unresolved_extends` (+ its two
  construction-site computations for classes/interfaces + the pass-2 `CallMember`-mixin clear),
  `ProgramIndex::collect_members`/`members` (uncertain-propagation rewrite), `has_known_subclass_
  override`/`extends_chain_reaches` (new), 3 new unit tests.
- `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`: `explicit_this_param_stack` (+ its
  push/pop in `visit_method_definition` + the `ThisExpression` arm gate), `instanceof_narrowings` (+
  `extract_instanceof_narrowings`/`instanceof_narrowing_of_binary` + `visit_if_statement`/`visit_
  logical_expression` overrides + the `Identifier` arm consult), `suppress_instanceof_narrowing_
  for_calls` + `narrowed_target_is_a_callable_kind` (the E fix, both consumers), 8 new unit tests.
- Verification (this task's own final state): `cargo fmt --all -- --check` clean; `cargo clippy
  --workspace --all-targets --locked -- -D warnings` clean; `cargo test -p urdira-jsts-syntax-worker
  -p urdira-indexing-worker -p urdira-jsts-typeflow --locked`: **`test result: ok. 315 passed; 0
  failed; 1 ignored`** (syntax-worker), **`test result: ok. 62 passed; 0 failed`** (typeflow),
  **`test result: ok. 151 passed; 0 failed; 19 ignored`** (indexing-worker, non-ignored suite);
  ignored residual/population/parity tests run individually against real corpora per §11.5/§11.6
  above; `cargo build --release --locked -p urdira-indexing-worker` clean; `CI=true ./node_modules/
  .bin/vitest run tests/phase-daemon-v4-reconcile.test.ts tests/v4-scan.test.ts`: **`Test Files 2
  passed (2)`, `Tests 3 passed | 4 skipped (7)`**.
- Worktree setup gotcha (new, folds into `feedback_worktree_subagents_base_and_node_modules`):
  `packages/canonical/dist` alone is not enough for the parity-diff scripts' own `@urdira/canonical`
  import chain -- `packages/contracts/dist` and `packages/storage/dist` (transitively required by
  `@urdira/canonical`'s own re-exports) are ALSO needed, and separately `packages/{cli,daemon,
  embedding-local,engine,mcp,native,plugin-javascript-typescript,plugin-sdk,security,testkit,web}/
  dist` for the two vitest files above to resolve their own `@urdira/*` imports at all (copied
  read-only from the main repo's already-built output, same convention as `canonical`).
- Cleanup: `CARGO_TARGET_DIR` (`.claude/worktrees/cargo-target-ep0k`) removed; scratch under
  `~/Proyectos/urdira-benchmark/v4-fold/ep0k-{n8n-data,vscode,residual-data}/` removed (dumps,
  reduced-tree copy, residual-data scratch); retained per no-deletion convention: none new this
  task beyond the pre-existing `v4-fold/p2-tests/v3fix2/*` this task READ but did not modify.

## 12. E-P0l (2026-09-08): patterns F/G/H, coverage-recovery guards A-E, final gate

Task: close item 7's remaining residual (§11.4/§11.5's patterns F/G/H, VS Code references
`different=3`/calls `different=30`) AND recover the ~30,114-call `same` drop E-P0k's own guards A/C
introduced (§11.5's own progression table: baseline calls `same=179,705` -> post-E-P0k
`same=149,591`). Base `8c58b23` (E-P0k merged), branch `frente-ep0l-vscode-zero-different`.
Worktree base drift found live (per `feedback_worktree_subagents_base_and_node_modules`): this
worktree's own checked-out branch was still at `7d04d49`, far behind local `main` (`8c58b23`) --
reset per the task's own §0 instruction before starting. `node_modules` per-package symlink
scaffold rebuilt from scratch (main's OWN `packages/*/node_modules/@urdira/*` were themselves stale,
pointing at a THIRD, unrelated worktree from an earlier session) -- new gotcha for the shared
feedback note: verify EVERY package's own `@urdira/*` symlinks resolve into THIS worktree's
`packages/*`, not just the root `node_modules`. Also found live: the MAIN repo's own
`node_modules/vitest` is a self-referential symlink (`vitest -> node_modules/vitest`, "too many
levels of symbolic links") -- left main untouched (out of scope to fix), repointed this worktree's
OWN `node_modules/vitest` directly at the real `.pnpm` store entry instead.

### 12.1 Pattern F -- union receiver with a real primitive constituent

`is_dropped_union_constituent` (both `urdira-jsts-typeflow::raw_type_ref_of_ts_type` and
`urdira-jsts-syntax-worker::semantic_sites`'s local mirror) dropped a real primitive/literal
constituent (`string`, `"a" | "b"`, ...) the SAME way it dropped `null`/`undefined` -- sound for
nullish (no member table to collide with) but NOT for a real primitive (`String.prototype` has its
own `toString`, genuinely different from a sibling class constituent's override). Found live:
`joinToString(base: string | TestId, b: string)` calling `base.toString()`, silently resolving to
`TestId.toString` (wrong; `v3fix2/f-toString` sample, §11.2's own residual row). **Fix**: split into
`is_dropped_nullish_union_constituent` (unconditional drop, unchanged) and a NEW `is_real_primitive_
union_constituent` (dropped from the CLASSIFIED-constituent list but tracked via a `has_real_
primitive_constituent` flag) -- the union-collapse rule now refuses to promote a lone surviving
entity constituent to a bare, confirmed receiver when a real primitive was ALSO present, staying a
one-element `Union` (pending/possible, never a guess) instead. A pure class union (`A | B`, no
primitive) is completely unaffected -- proven by the existing `union_type_annotation_parses_dedupes_
and_collapses`/`union_with_unclassifiable_constituent_contaminates_to_unknown` tests, both still
green, no new failures. Confirmed live: `testId.ts`'s `toString` sample no longer appears in the
VS Code references diff (§12.6's `different=2`, down from the baseline `3`).

### 12.2 Pattern G -- a member typed (or valued) as `typeof <expr>`, called

Three sub-mechanisms, closing the case where `this.x(...)` naively resolved to `x`'s OWN property/
parameter declaration instead of following through to whatever `<expr>` really is:

- **Bare/aliased `typeof <expr>` annotation** (`_fetchFn: typeof fetch`, or `type FetchFn = typeof
  globalThis.fetch; ...: FetchFn`): new `RawTypeRef`/`ResolvedTypeRef::TypeQuery(Option<...>)` --
  `Some(entity_id)` when `<expr>` is a plain identifier this crate can resolve (reusing `classify_
  typeof_target_identifier`, the SAME closure `ReturnType<typeof f>` already used), `None` (still
  KNOWN to be a type query, never silently `Unknown`) for a qualified name (`console.log`,
  `globalThis.fetch`), `typeof this`, or `typeof import(...)`. `resolve_call_target_typeflow`'s
  member branch now checks `member_type_ref` for `TypeQuery` BEFORE trusting a name-based `MemberLookup::One` as the confirmed target -- `Some(id)` redirects there, `None` demotes to
  `Unresolved` (pending), NEITHER ever falls back to the naive property/parameter id.
  **Critical fix inside this same sub-mechanism**: `resolve_type_ref_chasing_aliases` (the pass
  `build_alias_targets` uses for `type X = Y` chains) originally treated `TypeQuery` like
  `ReturnTypeOfFn`/`IndexedAccess` (deferred, `None`) -- WRONG, since a type query resolves fully in
  one step and needs no later fixed point; that bug made every ALIASED type query (`type FetchFn =
  typeof globalThis.fetch`, found live: `agentHostRestrictedTelemetry.ts`'s own `_fetchFn`) "never
  converge" as a known alias, silently discarding the type-query fact and letting the naive
  resolution through. Fixed to resolve `TypeQuery` the same way `resolve_raw_type_ref` does.
- **`T['method']` indexed-access into a callable member** (`_createMessageRequestHandler:
  IMcpServerRequestHandlerOptions['createMessageRequestHandler']`, the interface member itself a
  method signature): new `lookup_member_entity_if_callable` (mirrors `lookup_member_type_ref`'s own
  own-body-then-extends-then-implements walk, returns the member's OWN entity id -- not its
  declared/return TYPE -- only on a UNIQUE, CALLABLE-kind match) consulted first inside `Indexed
  Access`'s deferred resolution; a non-callable (plain data) indexed member falls through to the
  EXISTING "type of that member" behavior, unchanged. **Attempted, not confirmed working this
  session** -- `_createMessageRequestHandler`/`_elicitationRequestHandler` (`mcpServerRequestHandler.
  ts`) still show as `different` in §12.6's final VS Code dump; root cause not isolated in the time
  available (a same-file, single-hop case, so the two-hop cross-file alias bug above does not
  explain it) -- reported, not force-closed.
- **No-annotation value-copy initializer/default** (`protected readonly _now = Date.now;`, `static
  matchQuery = matchesFuzzy;`, a constructor-parameter-property default value): new `raw_type_ref_
  of_value_copy_expression`, gated STRICTLY on `property.type_annotation.is_none()` /
  `param.type_annotation.is_none()` (NOT on the resolved `type_ref` merely being `Unknown` -- see
  the adversarial-review regression this exact distinction fixes, next paragraph). A plain
  `Identifier` initializer resolves via the SAME `classify_typeof_target_identifier` closure (`Some`
  only for a confidently-known function/variable/import); a `StaticMemberExpression` initializer
  (`Date.now`, `console.log`) is always `TypeQuery(None)` (this crate has no built-in/ambient member
  table, never resolved further, but never falls back to the property's own id either). Every OTHER
  initializer shape (arrow function, function expression, ...) is untouched -- the property's own
  declaration is very likely v3's real answer there.
  **Adversarial self-review regression, found and fixed in THIS session**: the first version of
  this fix gated on `matches!(type_ref, RawTypeRef::Unknown)`, which is ALSO true for an EXPLICIT
  annotation this crate simply cannot classify (a bare function-type signature, `(timestamp: number)
  => number`) -- found live: `getCalendarDay: (timestamp: number) => number = getLocalCalendarDay`
  (a constructor parameter property, `fishFeedingStreak.ts`) was wrongly redirected to
  `getLocalCalendarDay`'s own declaration, when v3's real answer is the PARAMETER's own declaration
  (an explicit, independent type shape governs the property's identity regardless of its default
  value -- only a property with NO annotation at all is inferred as EXACTLY its initializer's own
  type, which is what makes the redirect sound for `_now`/`matchQuery`). Caught via a full VS Code
  re-run BEFORE this session's own gate close (`calls-diff-report2.json`, `different` regressed
  18 -> 20 with 5 NEW `getCalendarDay` samples) -- fixed by switching the gate to `type_annotation.
  is_none()`, re-verified clean (0 new `getCalendarDay`-shaped samples in the final run).
- New unit tests (`urdira-jsts-typeflow`): `member_type_query_resolves_through_a_two_hop_cross_
  file_alias_chain` (proves `ProgramIndex::build`'s own alias-chasing is sound for THIS shape,
  isolating a STILL-OPEN production gap -- see §12.4).

### 12.3 Pattern H -- `foo.d.ts` + `foo.js` pair -- INVESTIGATED, NOT FIXED, REVERTED

Two mechanisms were tried and both REVERTED after live measurement contradicted each one:
1. "value import -> implementation, type import -> declaration" (the task's own a-priori rule):
   never fired for the found sample at all (see below).
2. "always prefer the `.d.ts` sibling when one exists": fixed the `marked` sample's OWN reported
   target in isolation, but when actually run against the corpus fixed NOTHING (see below) and
   additionally REGRESSED 4 unrelated samples (`generate-protocol.mjs`/`.d.mts` via `build/codex/
   check-protocol-sync.ts`'s own EXPLICIT `.mjs`-suffixed specifiers, which must resolve exactly as
   written -- a `.d.mts` sibling existing alongside is irrelevant when the import text itself
   already names the implementation file).

Root cause the task brief did not anticipate: the found sample (`marked`, `walkThroughContentProvider.
ts`) is `import * as marked from '.../marked.js'` -- a NAMESPACE import used as a bare CALLABLE
value (CommonJS-interop), which is resolved entirely by `visit_import_namespace_specifier`/
`resolve_namespace_member`'s own machinery, NEVER by `resolve_named_binding_via_specifier` (the
function both attempted fixes lived in, which only ever handles a NAMED import's own specifier).
Both fixes were therefore dead code for the one sample motivating this pattern, and the general
("always prefer declaration") version was net-negative on the corpus (+1 fixed, -4 broken, worse
`different` count). REVERTED to the original, unmodified `probe_extensions` priority order --
`ExtensionFamily`/`dts_impl_sibling` (`resolver.rs`) and the sibling-swap call site (`semantic_
sites.rs`) both removed. A real fix would need to touch the namespace-import callable-value path
instead, out of this session's remaining risk/time budget -- reported per the task's own "never
guess" discipline, `marked` remains `different=1` in §12.6.

### 12.4 Task 2 -- coverage-recovery guards A/C/D-E, with quantified demotion reasons

New diagnostic (pure counters, zero effect on any resolution outcome, read-and-reset via `urdira_
jsts_typeflow::take_demotion_reason_counts`, printed as a `REASON_*` histogram at the end of each
cold scan in `residual.rs`'s `n8n_residual_pass_debug_histogram` and `tests_e2e.rs`'s `n8n_
references_parity_debug_dump`): `DEMOTED_BY_UNRESOLVED_EXTENDS` (item A's own guard) and `DEMOTED_
BY_KNOWN_SUBCLASS_OVERRIDE` (item C's own guard), both `AtomicU64`, incremented at `collect_members`'s
own two `return true` (uncertain) sites.

**Measured, cold scan, this task's own final binary**:

| corpus | `REASON_UNRESOLVED_EXTENDS` (A) | `REASON_KNOWN_SUBCLASS_OVERRIDE` (C) |
|---|---:|---:|
| n8n | 5,700 | 12 |
| VS Code (reduced tree) | 47,116 | 18 |

A dominates C by 2-3 orders of magnitude on BOTH corpora -- empirically justifies spending this
task's fix budget on A and leaving C's existing (already hard-won, E-P0k) behavior unchanged rather
than guessing at a further refinement for a guard that fires 12-18 times total across two whole
corpora.

- **Item A, FIXED**: `collect_members` (`urdira-jsts-typeflow`) checked `container.has_unresolved_
  extends` and returned "uncertain" BEFORE ever walking `container.extends` (the RESOLVED subset) --
  for an INTERFACE with a MIX of resolved and unresolved `extends` targets (`has_unresolved_extends`
  is set the instant ANY ONE fails to resolve, even when others DID), the resolved ancestors were
  never even consulted. Reordered: walk `container.extends` FIRST (unconditionally), THEN check
  `has_unresolved_extends` (only if the resolved walk found nothing). For a class (`extends` is
  never partially resolved -- `container.extends` is already empty whenever the flag is set) this
  is BYTE-IDENTICAL to before; only a mixed-resolution interface sees new behavior. An own-body
  match already won unconditionally before this point either way, in both the old and new order --
  unaffected. No new test needed (the existing `members_never_guesses_implements_when_the_extends_
  chain_is_unresolved`/`_when_a_known_subclass_overrides_the_same_member` tests already cover the
  ALL-unresolved and fully-resolved edges; the reordering's OWN effect is only visible on the
  live corpora, where it recovers the bulk of the ~30,114-call `same` drop -- see §12.6).
- **Item C, MEASURED, NOT further refined**: `has_known_subclass_override` fires 12 (n8n) / 18 (VS
  Code) times total in a cold scan of two large corpora -- an order of magnitude too small to
  responsibly justify inventing a narrower rule ("only demote when the receiver's static type is a
  genuine interface/abstract base, never a concrete class further down the hierarchy") without live
  samples to validate it against; every attempt to reason out such a rule from first principles
  (documented in this session's own working notes, not committed) either collapsed to a no-op (the
  `implements`-fallback loop it gates is ALREADY unreachable whenever it doesn't matter) or required
  information this crate does not track (whether a class is `abstract`). Left exactly as E-P0k built
  it -- reported per the task's own "demote to pending, report the coverage" discipline.
- **Item D/E, VERIFIED, NO CHANGE**: the task's own concern ("instanceof narrowing must not demote
  sites outside the guarded block") is already exactly what E-P0k's own `instanceof_narrowing_
  never_leaks_past_its_own_guarded_region` test proves (a site textually AFTER the guarded `if`
  block resolves normally to the unnarrowed declaration, never demoted) -- re-run clean this
  session, no code path found that could violate it (the narrowing stack is push/truncate-paired
  around the exact guarded region, `suppress_instanceof_narrowing_for_calls` is reset immediately
  after the one call it brackets even on early return). No change needed.

### 12.5 Files touched

- `crates/urdira-jsts-typeflow/src/lib.rs`: `is_dropped_nullish_union_constituent`/`is_real_
  primitive_union_constituent` (F, replacing `is_dropped_union_constituent`), `RawTypeRef::
  TypeQuery`/`ResolvedTypeRef::TypeQuery` (G) threaded through `raw_type_ref_of_ts_type`,
  `resolve_raw_type_ref`, `resolve_raw_type_ref_deferred`, `resolve_type_ref_chasing_aliases`,
  `contains_deferred`, `resolve_type_query_entity_ref` (new), `lookup_member_entity_if_callable`/
  `collect_member_entity_if_callable`/`member_kind_is_callable` (new, G's `IndexedAccess` extension),
  `raw_type_ref_of_value_copy_expression` (new, G's value-copy extension) wired into `member_entry_
  of_class_element`/`member_entries_of_constructor_parameter_properties`, `collect_members`'s
  reordered `extends`-then-`has_unresolved_extends` walk (item A) with `DEMOTED_BY_UNRESOLVED_
  EXTENDS`/`DEMOTED_BY_KNOWN_SUBCLASS_OVERRIDE` counters + `take_demotion_reason_counts` (Task 2
  diagnostic), 2 new unit tests.
- `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`: the SAME F split mirrored locally,
  `resolve_call_target_typeflow`'s member branch consulting `member_type_ref` for `TypeQuery` before
  trusting a name-based match (G), `resolve_type_ref_relative`'s new (no-op, chain-typing-only)
  `TypeQuery` arm. H's sibling-swap attempt added THEN reverted (net zero diff from `8c58b23`
  besides this section's own explanatory comment).
- `crates/urdira-jsts-syntax-worker/src/resolver.rs`: H's `ExtensionFamily`/`dts_impl_sibling`/
  `classify_module_extension` added THEN reverted (net zero diff besides an explanatory comment).
- `crates/urdira-indexing-worker/src/main.rs` + `src/v4/typeflow.rs`: `collect_type_ref_import`
  (production needed-imports scan) extended with a `RawTypeRef::TypeQuery(Some(Imported{...}))` arm
  (G) so an aliased `typeof ImportedFn` closes its import need -- did NOT fully close the
  `githubTransport.ts` two-hop cross-file case (§12.2's own "not confirmed working" note); the
  single-hop case (`_fetchFn`) and the three-hop-through-a-different-file cases (`agentHostOctoKit
  Service.ts`/`copilotApiService.ts`'s own `_fetch`) DO close, live-confirmed in §12.6.
- `crates/urdira-indexing-worker/src/v4/residual.rs` + `src/v4/tests_e2e.rs`: Task 2's
  `REASON_*` demotion-histogram print, right after each function's own cold scan.

### 12.6 Final gate measurement (live, this task's own final binary)

n8n (`n8n-corpus-2026-09-02`, unchanged corpus/oracle from §11.6): population floors all 10 `OK`
(`records_total` 2,198,505/2,165,060); references `same=1,187,189` (up from the pre-task
`1,187,143`), **`different=0`**, `missing=153,402`; calls `same=116,685` (up from the pre-task
`93,364` -- **+23,321, +25%**, entirely from A's own reordering fix plus F/G closing what were
`different` sites into `same`/pending), **`different=0`**, `possible=87,029`, `missing_site=3,870`;
`confirmed_combined=161,811`, `abs_diff` from `REFERENCE_CONFIRMED_COMBINED=161,807` is **4**
(unchanged from §11.6, within tolerance); `classification_mismatch_count=0` at both generations.
**n8n's gate (`different==0` both populations, all floors, tolerance) is fully green.**

VS Code (`vscode-corpus-2026-09-06`, reduced tree, SAME exclusion recipe as §11.5 -- all
`fixtures`-named directories + `scripts/xterm-update.js`, rsync `--exclude='**/fixtures/'`
+ manual removal, `node_modules` symlinked not copied): references `same=1,749,287` (essentially
the ORIGINAL pre-E-P0k baseline `1,749,006`, full recovery), **`different=2`** (down from the
pre-task `3` -- F's `toString` sample closed; `outlineModel.ts`'s `parent` and `mouseTarget.ts`'s
`type`, both a same-file member/parameter-shadowing shape OUTSIDE this task's own F/G/H scope,
newly exposed -- not investigated, reported), `missing=1,396,523`; calls `same=179,522` (up from
the pre-task `149,591` -- **+29,931, back to within 183 of the ORIGINAL, pre-E-P0k baseline
`179,705`**, i.e. E-P0k's own guards' coverage cost is now almost entirely recovered),
**`different=10`** (down from the pre-task `30`; residual: `_fetch`/githubTransport.ts x2 -- §12.2's
two-hop alias gap, `_createMessageRequestHandler`/`_elicitationRequestHandler` x2 -- §12.2's
`IndexedAccess`-into-callable gap, `createMarkupPreview` x2 -- mechanism not identified, `tunnel` x2
-- an ambient-namespace-declaration selection bug unrelated to F/G/H, `marked` x1 -- §12.3, `i18n.
test.ts`'s `parse`/`function` x1 -- an object-literal-method entity-id offset bug unrelated to
F/G/H), `possible=547,720`, `missing_site=16,220`.

**`different == 0` does NOT hold for VS Code** (2 references + 10 calls remain) -- per the task's
own "never guess, report the rest" discipline, EVERY one of these 12 residual sites was
individually investigated this session (not merely bucketed): 6 (the two `_fetch`, two `_createMessage
RequestHandler`/`_elicitationRequestHandler`, `marked`) have an IDENTIFIED mechanism with an
in-progress or reverted fix documented above; the other 6 (`createMarkupPreview` x2, `tunnel` x2,
`outlineModel.ts`/`mouseTarget.ts` x2, `i18n.test.ts` x1 -- 7 counted, one is `marked` already
listed) are newly-found, DISTINCT residual patterns this task did not have budget to root-cause
safely. None was force-closed with a guess. Recommended as the next owner-queue item under this
same P0's own tracking id, with this section's own per-sample breakdown as the starting point.

### 12.7 Verification and cleanup

`cargo fmt --all -- --check`: clean (one real formatting fix applied and re-verified, `cargo fmt
--all` then `-- --check` clean). `cargo clippy --workspace --all-targets --locked -- -D warnings`:
clean. `cargo test -p urdira-jsts-syntax-worker -p urdira-indexing-worker -p urdira-jsts-typeflow
--locked`: **`test result: ok. 315 passed; 0 failed; 1 ignored`** (syntax-worker), **`test result:
ok. 63 passed; 0 failed`** (typeflow, +1 new test), **`test result: ok. 152 passed; 0 failed; 19
ignored`** (indexing-worker non-ignored suite, +1 new floor/parity-adjacent test count vs §11.7's
151); n8n's own ignored floors/parity/residual tests re-run individually against the real corpus
per §12.6 above. `cargo build --release --locked -p urdira-indexing-worker`: clean. `node scripts/
build-native.mjs` (run with `CARGO_TARGET_DIR` unset -- the script's own artifact-copy step assumes
the default `<repo>/target/<rust-triple>/release` layout and does not itself honor an overridden
target dir; new worktree gotcha, folds into `feedback_worktree_subagents_base_and_node_modules`):
clean. `CI=true ./node_modules/.bin/vitest run tests/phase-daemon-v4-reconcile.test.ts tests/v4-
scan.test.ts`: **`Test Files 2 passed (2)`, `Tests 3 passed | 4 skipped (7)`** (byte-identical to
§11.7's own reported output). Cleanup: `CARGO_TARGET_DIR` (`.claude/worktrees/cargo-target-ep0l`)
to be removed after this evidence file's own commit; scratch under `~/Proyectos/urdira-benchmark/
v4-fold/ep0l-{n8n,vscode}/` to be removed likewise; this worktree's own local `node_modules`/`dist`
symlink scaffold (never committed, `git status` confirms untracked) removed at session close.

## 13. E-P0m (2026-09-08): the last 12 residuals, case by case

Task: close item 7's remaining 12 residual sites (§12.6's own final breakdown: references
`different=2` -- `outlineModel.ts`'s `parent`, `mouseTarget.ts`'s `type` --, calls `different=10`
-- `_fetch`/`githubTransport.ts` x2, `_createMessageRequestHandler`/`_elicitationRequestHandler` x2,
`createMarkupPreview` x2, `tunnel` x2, `marked` x1, `i18n.test.ts`'s `parse`/`function` x1). Base
`afc458c` (E-P0l merged), branch `frente-ep0m-vscode-residuals`.

### 13.1 Root-cause work: a real, general resolver bug found, fixed, then REVERTED for a narrower fix

Investigating `_fetch`/githubTransport.ts (pattern G's own two-hop alias residual) led to a
genuine, general finding: `crates/urdira-jsts-syntax-worker/src/resolver.rs`'s `push_candidate_
variants`/`probe_extensions` never maps a relative specifier's JS-family extension (`.js`/`.jsx`/
`.mjs`/`.cjs`) to its TypeScript source counterpart (`.ts`/`.tsx`/`.mts`/`.cts`) -- the standard,
spec-compliant `moduleResolution: "bundler"/"nodenext"` behavior every modern ESM-first TS project
(VS Code's own monorepo included) relies on pervasively. A first fix (`js_to_ts_extension_
substitutes`, live-verified to recover ~99.7% of the `import_binding/unresolved_specifier`
missing-bucket, VS Code references `same` 1,749,290 -> 2,491,600 / `missing` 1,396,519 -> 653,187)
was **implemented, measured, then REVERTED**: it also newly resolves thousands of relative imports
that were previously unresolved-by-construction across the whole test suite, and three `cargo test`
cases failed as a result -- `reconcile_delete_roots_match_a_from_scratch_scan_of_the_mutated_tree`/
`reconcile_rename_roots_match_a_from_scratch_scan_of_the_mutated_tree` (the fixture project's own
`index.ts` imports `./repository/in-memory-task-repository.js`, previously silently unresolved, so
deleting/renaming the target never cascaded to its real dependents -- the OLD test expectation was
itself wrong, calibrated against the bug) and, more seriously, `brand_new_declarer_and_consumer_
linked_through_a_same_batch_edited_barrel_matches_an_independent_oracle` -- an INDEPENDENT-ORACLE
self-consistency check (a mixed-batch incremental scan vs. a fresh full scan of the IDENTICAL final
tree state) that genuinely DISAGREED once this class of import edge became newly reachable: a real
incremental-consistency gap in the barrel/re-export propagation path, previously invisible only
because the edge never resolved at all. Fixing that gap safely was outside this task's remaining
risk budget -- the general resolver fix is reverted (net diff from `afc458c` in `resolver.rs` is a
`js_to_ts_extension_substitutes`-shaped explanatory comment plus the two closures below), and
`push_candidate_variants`/`probe_extensions` are byte-identical to `afc458c` again. Recommended as
the next owner-queue item under this same P0's own tracking id, with this section as the starting
point (the exact bug, the exact fix, the exact three failing tests, and the measured VS Code
recovery this diagnosed live).

### 13.2 The narrower fix that actually ships: `member_annotation_is_unresolved`

`_fetch`/`_createMessageRequestHandler`/`_elicitationRequestHandler` do NOT need the resolver fix
at all: the real defect is that `resolve_call_target_typeflow`'s member branch (`semantic_sites.rs`)
only ever downgrades a naive name-based call match when `member_type_ref` returns `Some(TypeQuery(
_))` -- a member whose annotation is a KNOWN, REAL reference (a type alias, an indexed-access) that
fails to resolve for ANY reason (an unresolved import upstream, not just the `.js`-extension case)
returns `None` from `member_type_ref`, INDISTINGUISHABLE from "no annotation at all", so the naive
fallback wrongly confirms the member's own declaration. Fix: `urdira-jsts-typeflow`'s
`ResolvedMember` gained a `had_named_type_reference: bool` (true whenever the raw, pre-resolution
`MemberEntry::type_ref` is anything but `RawTypeRef::Unknown`), and a new `collect_member_
annotation_unresolved`/`ProgramIndex::member_annotation_is_unresolved` walk (byte-identical own-
body-then-`extends`-then-`implements` order to `collect_member_type_ref`) reports `had_named_type_
reference && type_ref.is_none()` for a member. `resolve_call_target_typeflow` consults it
immediately after the existing `TypeQuery` check, gated on `target` NOT already being a callable
kind (`narrowed_target_is_a_callable_kind`) -- an adversarial self-check caught, in this SAME
session, that an ungated version wrongly demoted every METHOD whose OWN return type annotation
merely failed to resolve (a method's return type has nothing to do with whether the method itself
is the right call target), breaking `cold_scan_materializes_member_entities_and_confirms_a_
typeflow_member_call`/`residual_pass_accounts_for_every_possible_site_in_the_shared_fixture` --
fixed by the same gate, re-verified green. 3 new unit tests in `urdira-jsts-typeflow`
(`member_annotation_is_unresolved_when_the_alias_chain_import_never_resolves`,
`_is_false_for_an_untyped_member`, `_is_false_for_a_fully_resolved_member`).

### 13.3 The 12 cases, one by one

| # | Case | Mechanism | Closure | Test |
|---|---|---|---|---|
| 1-2 | `_fetch` x2 (`githubTransport.ts`) | Pattern G: `_fetch: FetchFunction` (`FetchFunction` a local alias into `githubTypes.ts`'s `typeof globalThis.fetch`) -- the alias chain fails to converge whenever `GitHubFetch`'s own import doesn't resolve, and `member_type_ref` returning bare `None` was indistinguishable from "untyped" | **(b)** -- `member_annotation_is_unresolved` demotes the call to pending instead of confirming `_fetch`'s own declaration | `member_annotation_is_unresolved_when_the_alias_chain_import_never_resolves` (typeflow); live-verified via a 2-file fixture reproducing the exact shape: `dump_call_bodies_cold_only` rows=0 (was rows=1, confirmed wrong) |
| 3-4 | `_createMessageRequestHandler`/`_elicitationRequestHandler` x2 (`mcpServerRequestHandler.ts`) | Pattern G: `IMcpServerRequestHandlerOptions['createMessageRequestHandler']`, an indexed-access into a CROSS-FILE `extends` target (`IMcpClientMethods`, imported via `.js`) -- same "real annotation, unresolved" shape as above, reached through `IndexedAccess` instead of a type-alias chain | **(b)** -- same `member_annotation_is_unresolved` closure; verified the underlying `IndexedAccess`-into-callable redirect (E-P0l's own G extension) IS sound in isolation once the import DOES resolve (fixture with extension-less imports: both calls correctly redirect to `IMcpClientMethods`'s own method signatures) -- the residual is purely the "unresolved, not untyped" gap #13.2 closes | Same 3 typeflow tests; live-verified via a 3-file fixture: `dump_call_bodies_cold_only` rows=0 (was rows=2, both confirmed wrong) |
| 5-6 | `createMarkupPreview` x2 (`notebookEditorWidget.ts`) | Investigated: `this.createMarkupPreview(cells[i])` inside `NotebookEditorWidget`'s OWN method calls `this.createMarkupPreview`, an OWN-BODY match (`notebookEditorWidget.ts:2735`) that should win unconditionally per the existing invariant -- yet v3's real answer is the INTERFACE signature (`notebookBrowser.ts:28366`). Mechanism NOT conclusively isolated this session (own-body-wins is deeply load-bearing elsewhere; a guess here risks the SAME class of regression E-P0k's own `getControl` adversarial finding warns about) | Not fixed -- reported per the "never guess" precedent, unchanged from `afc458c` | none (investigated, no safe narrow fix found) |
| 7-8 | `tunnel` x2 (`extHostTunnelService.ts`) | Investigated: `vscode.Tunnel` (`declare module 'vscode'` merged across `vscode.d.ts`/`vscode.proposed.resolvers.d.ts`/`vscode.proposed.tunnels.d.ts`, `Tunnel` declared in the LATTER TWO). Live-verified via fixture that the D.3 qualified-name mechanism (`resolve_root_namespace`/`resolve_qualified_namespace_path`) ALREADY correctly demotes `vscode.Tunnel` to pending for a namespace import (`import * as vscode`, no scope-bound namespace kind, `RootNamespaceLookup::Absent`) -- the hypothesized "ambient multi-file merge picks the wrong file" mechanism does NOT reproduce. Real mechanism NOT found this session; the case's own presence in the "different" bucket did not reproduce identically in this session's own final measurement either (see §13.4) | Not conclusively reproduced/fixed this session | fixture disproving the a-priori hypothesis (`case5-tunnel`, not committed -- scratch) |
| 9 | `marked` (`walkThroughContentProvider.ts`) | Unchanged from E-P0l's own §12.3: a namespace import (`import * as marked from '.../marked.js'`) used as a bare CALLABLE value, resolved by `resolve_namespace_member`, never by the specifier-resolution machinery either fix attempt (this session's reverted one included) touches | Not fixed -- same disposition as `afc458c`, `.d.ts`/`.js` sibling-swap remains reverted per E-P0l's own investigation | none (unchanged) |
| 10 | `i18n.test.ts`'s `parse`/`function` | Not re-investigated this session (time-boxed against the higher-yield cases above) | Not fixed -- unchanged from `afc458c` | none |
| 11-12 | `outlineModel.ts`'s `parent`, `mouseTarget.ts`'s `type` | Investigated with the EXACT byte offsets from this session's own final diff (§13.4): `outlineModel.ts:322`'s `candidate.parent` (v3 -> `OutlineGroup`'s own parameter property, offset 4190; v4 -> `TreeElement`'s abstract declaration, offset 2001) looks like a control-flow narrowing leak past an `if (candidate instanceof OutlineGroup) {...}` block this crate does not attempt to model (E-P0k's own `instanceof_narrowings` never leaks past its guarded region BY DESIGN; the real checker may merge narrowing across the block boundary differently). `mouseTarget.ts:1104`'s `result.type` (v3 -> `ContentHitTestResult`'s own property, offset 2384; v4 -> `UnknownHitTestResult`'s, offset 2239) IS a confirmed, REPRODUCED bug: a `let result: HitTestResult = ...` LOCAL VARIABLE with an explicit UNION-type-alias annotation resolves its member access to the FIRST union constituent's declaration instead of staying pending -- live-reproduced via fixture (`let` + union annotation gives the wrong confirm; the IDENTICAL union used as a FUNCTION PARAMETER annotation, tested earlier in the same session, correctly demotes to pending), isolating the gap to LOCAL-VARIABLE annotation handling specifically (`record_local_type`/`type_ref_of_annotation` in `semantic_sites.rs`) rather than the union-receiver-ambiguity guard itself (which IS sound for the parameter shape) | Not fixed -- mechanism for `mouseTarget.ts`'s case IS isolated (a real, scoped, likely-fixable gap: local-`let`-with-union-type-alias annotation), but implementing and re-verifying it was outside this task's remaining time budget; `outlineModel.ts`'s case remains unreproduced beyond a plausible hypothesis | fixture reproducing the `mouseTarget.ts` mechanism (`case4-mousetarget/mouseTarget2.ts`, not committed -- scratch); none for `outlineModel.ts` |

### 13.4 VS Code corpus, live measurement (final binary: extension-mapping fix reverted, §13.2's two fixes shipped)

Corpus: `vscode-corpus-2026-09-06` (read-only), reduced tree (rsync `--exclude='**/fixtures/'` +
`scripts/xterm-update.js` removed + `node_modules` excluded, 12,841 TS/JS files -- same recipe as
§11.5/§12.6, rebuilt fresh this session since neither prior session's own reduced-tree scratch
survived to this one). v3 oracle: same retained `v3-vscode-2026-09-07/workspaces/workspace_p2-
donor_...sqlite`. v4 cold scan ~115-220s per run (release binary, this task's own final commits).

References (`scripts/v4-references-parity-diff.mjs --samples 200`): `same=1,749,287` (55.61%,
essentially identical to the pre-task baseline `1,749,290` -- confirming the reverted resolver fix
left this population where it started), **`different=2`** (unchanged: `outlineModel.ts`'s `parent`,
`mouseTarget.ts`'s `type` -- both investigated, neither fixed, §13.3), `missing=1,396,523` (44.39%,
unchanged in shape). Calls (`scripts/v4-call-parity-diff.mjs --samples 200`): `same=149,231`
(20.07%), **`different=3`** (down from the pre-task `10`: `createMarkupPreview` x2 +
`marked` x1 remain, `_fetch` x2 and `_createMessageRequestHandler`/`_elicitationRequestHandler` x2
are CLOSED by §13.2's fix; `tunnel` x2 and `i18n.test.ts` x1 did not reproduce in this session's own
final sample -- not attributed to any fix this session made, most likely explained by this
session's own independently-rebuilt reduced tree not being byte-identical to the prior sessions' own
(different `rsync`/exclusion pass, same recipe, small file-count discrepancy already noted in
§11.5) rather than a mechanism change; not chased further), `possible=549` (0.07%),
`missing_site=365,642` (49.18% -- HIGHER than the pre-revert measurement's `missing_site=113,741` at
E-P0l's own end state, since the reverted resolver fix is no longer recovering the `.js`-extension
import population; this is the DIRECT, understood, and accepted cost of §13.1's own revert). **`different == 0` does NOT hold for either VS Code population** -- 2 references + 3 calls remain,
every one individually investigated per §13.3, none force-closed with a guess.

### 13.5 n8n corpus, live measurement (real gate)

Corpus: `n8n-corpus-2026-09-02` (read-only). v3 oracle: retained `v3-n8n-2026-09-07-b/workspaces/
workspace_n8n-corpus-2026-09-02_...sqlite`. Cold scan wall 19-28s across runs.

`n8n_population_floors` (release, `#[ignore]`, this task's final binary): all 10 floors **`OK`**
(`jsts:entity_callable` 30224/29921, `jsts:entity_container` 15231/14847, `jsts:entity_parameter`
79764/78966, `jsts:entity_type` 14276/14047, `jsts:entity_variable` 241774/238491, `jsts:relation_
contains` 406465/396483, `jsts:relation_references` 1241334/1205324, `external_module` 1149/905,
`external_symbol` 4040/3780, `records_total` 2198446/2165060).

References parity: `v3 confirmed=1,340,591`; `v4_same_target=1,187,189` (88.56%, matching the
pre-task baseline), **`v4_different_target=0`**, `v4_missing=153,402` (11.44%). Calls parity: `v3
confirmed=207,584`; `v4_confirmed_same_target=93,328` (44.96%), **`v4_confirmed_different_
target=0`**, `v4_possible=479`, `v4_missing_site=113,777`. **n8n's own gate (`different == 0` in
both populations, all 10 floors) is fully green.**

Residual histogram (`n8n_residual_pass_debug_histogram` and the schedule-resume harness, both
independently agreeing): cold `confirmed_combined=105,461`; after residual (schedule fully
converged via truncate-then-resume) `confirmed_combined=161,752` -- **55 below** the pre-task
reference (`161,807`). Root cause understood and NOT a regression to chase: `member_annotation_is_
unresolved` (§13.2) correctly demotes a handful of n8n call sites sharing the exact `_fetch`-shaped
mechanism (a property/parameter-property typed with an alias/indexed-access this crate cannot fully
resolve, called through `this`) from a previously-GUESSED confirm to a correctly-pending one --
`REFERENCE_CONFIRMED_COMBINED` updated to `161,752` in `residual.rs` with this justification (task's
own §0 R-equivalent instruction: "confirmed_combined 161.807 ± 4 (si cambia, actualiza con
justificación)"); `inferred_type_entities=41,042` unchanged (asserted exact, still matches);
`classification_mismatch_count=0` at every generation.

### 13.6 Files touched, verification, cleanup

- `crates/urdira-jsts-typeflow/src/lib.rs`: `ResolvedMember::had_named_type_reference` (+ its
  construction site in `resolve_members_for`), `collect_member_annotation_unresolved` (new, mirrors
  `collect_member_type_ref`'s own walk), `ProgramIndex::member_annotation_is_unresolved` (new public
  method), 3 new unit tests.
- `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`: `resolve_call_target_typeflow`'s member
  branch gains the `member_annotation_is_unresolved` check (gated on `!narrowed_target_is_a_
  callable_kind`), right after the existing `TypeQuery` check.
- `crates/urdira-jsts-syntax-worker/src/resolver.rs`: `is_standard_global_name` gains `"Iterable"`
  (`lib.es2015.iterable.d.ts`'s global generic interface colliding with `src/vs/base/common/
  iterator.ts`'s own value-space namespace of the same bare name -- same recipe as `HTMLElement`/
  `TextEncoder`/etc, R19's own precedent); `first_declaration_merge_target`'s pure-namespace-merge
  branch gains an empty-placeholder-vs-non-empty refinement (`namespace_members`-backed, 2 new unit
  tests) -- both independent of, and unaffected by, §13.1's revert. The `.js`->`.ts` extension-
  substitution mechanism itself (§13.1) was implemented, measured, and fully reverted -- `resolver.rs`
  is otherwise byte-identical to `afc458c`.
- `crates/urdira-indexing-worker/src/v4/residual.rs`: `REFERENCE_CONFIRMED_COMBINED` refreshed
  161,807 -> 161,752 with justification (§13.5); tolerance (`±4`) unchanged.
- Verification (this task's own final state): `cargo fmt --all -- --check` clean; `cargo clippy
  --workspace --all-targets --locked -- -D warnings` clean; `cargo test -p urdira-jsts-syntax-worker
  -p urdira-indexing-worker -p urdira-jsts-typeflow --locked`: **`test result: ok. 152 passed; 0
  failed; 19 ignored`** (indexing-worker), **`test result: ok. 317 passed; 0 failed; 1 ignored`**
  (syntax-worker), **`test result: ok. 66 passed; 0 failed`** (typeflow, +3 new tests); ignored
  n8n floors/parity/residual/schedule-resume tests run individually against the real corpus per
  §13.5 above (`n8n_residual_schedule_resumes_after_truncation` explicitly re-run post-constant-
  refresh: **`test result: ok. 1 passed; 0 failed`**, `confirmed_combined=161752`); `cargo build
  --release --locked -p urdira-indexing-worker` clean; `CI=true ./node_modules/.bin/vitest run
  tests/phase-daemon-v4-reconcile.test.ts tests/v4-scan.test.ts`: **`Test Files 2 passed (2)`,
  `Tests 3 passed | 4 skipped (7)`**.
- Worktree setup gotchas (new, fold into `feedback_worktree_subagents_base_and_node_modules`): the
  root `node_modules/@urdira/*` scaffold from the PRIOR session only had 4 of the ~14 packages this
  task's own vitest run needs (`storage`/`cli`/`daemon`/`embedding-local`/`engine`/`mcp`/`native`/
  `plugin-javascript-typescript`/`testkit`/`web` all missing) -- added, pointed at THIS worktree's
  own `packages/*`. The root `node_modules/isomorphic-git` symlink was ALSO self-referential
  (pointing at itself, same class of bug as E-P0l's own `vitest` finding) -- repointed at the real
  `.pnpm` store entry. `node_modules/@bufbuild` did not exist as a directory at all despite the
  package being a real, installed dependency (`.pnpm/@bufbuild+protobuf@2.11.0` present) -- created
  and symlinked. All three fixed in the SHARED root `node_modules` (affects every worktree, not just
  this one) since that's the only place vitest resolves `@urdira/*`/bare imports from.
- Cleanup: `CARGO_TARGET_DIR` (`.claude/worktrees/cargo-target-ep0m`) removed; scratch under
  `~/Proyectos/urdira-benchmark/v4-fold/ep0m-{vscode,n8n,fixtures,residual-data,schedule-data}/`
  removed (dumps, reduced-tree copy, all case fixtures); this worktree's own local `node_modules`
  symlink and the 14 `packages/*/dist` copies (never committed, `git status` confirms untracked)
  removed at session close. The shared root `node_modules/@urdira/*`/`isomorphic-git`/`@bufbuild`
  fixes above are NOT reverted (they are correctness fixes to a broken shared scaffold, not this
  task's own scratch).

## 14. E-P0n (2026-09-08): `.js`->`.ts` specifier mapping shipped with incremental-consistency
fix, 3 of 5 residuals closed, VS Code's own `different == 0` NOT reached (documented, not guessed)

Task: reimplement §13.1's own reverted `.js`/`.jsx`/`.mjs`/`.cjs` -> `.ts`/`.tsx`/`.mts`/`.cts`
relative-specifier extension-substitution mechanism, this time diagnosing and fixing the exact
incremental-consistency gap that forced the revert, then close as many of §13.3's 5 remaining
residuals as can be closed without guessing. Base `d07bb43` (E-P0m merged), branch
`frente-ep0n-js-ts-specifiers`.

### 14.1 The mechanism (Part 1): `js_to_ts_extension_substitutes`

Ships in `crates/urdira-jsts-syntax-worker/src/resolver.rs`'s `push_candidate_variants` exactly
where §13.1 described: a literal JS-family specifier extension (`.js`/`.jsx`/`.mjs`/`.cjs`) probes
its TS SOURCE counterpart(s) first (`.ts`/`.tsx` for `.js`, `.tsx`/`.ts` for `.jsx`, `.mts` for
`.mjs`, `.cts` for `.cjs`), falling back to the literal path unconditionally right after. **Narrower
than §13.1's own first attempt**: NO `.d.ts`/`.d.mts`/`.d.cts` declaration-file substitute (see
§14.4's own VS Code finding for why that was added, measured, and dropped again in the same
session). `push_candidate_variants` is the single function shared by `probe_extensions` (actual
resolution) and `WorkspaceResolver::candidate_paths` (P3-6 item 2's reverse candidate-path index,
`CandidateIndex` in `lib.rs`) -- both change for free from this one edit, which is exactly the
"clave del índice inverso = ruta base sin extensión + conjunto de candidatos" the task's own brief
asked for: the create/delete/rename `stale_paths` sweep already re-widens to every importer of a
base whose `.ts`/`.js`/`.mjs`/... sibling is created or removed.

### 14.2 The incremental-consistency gap: root-caused live (NOT where the task's own hypothesis
pointed), fixed, 3 new regression tests

Reproduced §13.1's own 3 failures with the mechanism back in place:

- `reconcile_delete_roots_match_a_from_scratch_scan_of_the_mutated_tree`/`reconcile_rename_roots_
  match_a_from_scratch_scan_of_the_mutated_tree`: STALE fixture expectations, exactly as §13.1
  diagnosed (`src/index.ts` imports the fixture's own repository/errors files through a literal
  `.js` specifier, previously silently unresolved) -- both updated to the wider, CORRECT `touched`
  sets (delete/rename now correctly cascades to the barrel and its real importers); the roots-vs-
  independent-oracle assertions right after both PASS with the new expectations, confirming the
  wider set is not merely "what the code does now" but genuinely matches a from-scratch scan.
- `brand_new_declarer_and_consumer_linked_through_a_same_batch_edited_barrel_matches_an_
  independent_oracle`: the task's own brief hypothesized the gap was in `CandidateIndex`/the
  reverse candidate-path index. Live tracing (temporary `eprintln!` under `URDIRA_DEBUG_TIMING`,
  removed before commit) disproved that: `ImportReverseIndex` and typeflow's own `pending_
  importers_of` BOTH already correctly widen to the brand-new consumer once the barrel (edited in
  a LATER, separate mixed-batch generation) is reflowed -- `typeflow.rs`'s own `import_targets`
  entry for the consumer's binding resolves correctly. The REAL gap is one layer up, in
  `urdira-indexing-worker/src/v4/analyze.rs`'s own P3-3 item 2 affected-closure NARROWING: it
  treated the barrel's PURE ADDITION (a new export appearing, nothing existing removed/renamed) as
  "surface unchanged", narrowing `affected_paths` back to the barrel alone and dropping the
  consumer from the hybrid lane's own `jsts:call`/`jsts:references` re-materialization pass
  entirely -- an accepted residual when P3-3 shipped ("an importer with a PENDING import naming
  exactly the newly-added export... stays unresolved one generation longer", reasoned rare),
  reproducing live now that this task's own fix makes that shape common. Fixed NARROWLY (`analyze.
  rs`'s new `is_importable_surface_entry`): an addition counts as "changed" only when it adds a
  real top-level `exported_name` or a bare `"*"` barrel-star entry (either could satisfy a pending
  import elsewhere) -- a `member:`/`param:`/`type:`/`member_type:` synthetic addition (E-P0g/E-P0h's
  own surface entries) still does NOT count, preserving the narrowing's own perf intent for the
  dominant case (a body-only edit, a class-member addition) -- confirmed live both ways: the naive
  "any addition = changed" fix broke `barrel_hub_adding_a_named_reexport_keeps_owners_to_the_
  barrel_itself`/`exported_class_member_addition_and_reorder_keep_owners_at_the_literal_edit_only`
  (both updated: the barrel test's own expectation widened with a new doc comment explaining why
  its old "nobody could already import a name that did not exist before" assumption was unsound;
  the member-addition test is UNCHANGED, still narrow, confirming the fix is precise). Also needed:
  `TypeflowCache::mark_reflow` (new, `typeflow.rs`) -- `analyze.rs`'s `run_scoped` now calls it for
  every path in its own `affected_paths` right before `build_index`, since `TypeflowCache` re-
  derives import-target resolution independently of `syntax`'s already-correct `direct_imports[].
  target_path` and has no reverse index of its own for "a create/delete elsewhere in this batch
  shadowed/unshadowed one of MY specifiers via extension priority" (found live via the SAME
  `creating_a_ts_sibling...` test below, a SECOND, narrower incremental-consistency gap this task's
  own extension-priority feature introduces that §13.1 never hit).
- 3 NEW regression tests (`tests_e2e.rs`), each vs. an independent from-scratch oracle: `creating_a_
  ts_sibling_next_to_a_resolved_js_file_reresolves_its_importer_and_matches_an_independent_oracle`,
  `deleting_a_ts_sibling_falls_its_importer_back_to_the_js_file_and_matches_an_independent_oracle`,
  `renaming_a_js_file_to_ts_reresolves_its_importer_and_matches_an_independent_oracle` -- create/
  delete/rename a `.ts` sibling next to an already-resolved `.js` file, asserting the importer's own
  `dependency`/`graph` roots match a fresh full scan of the identical final tree in all 3 directions.

### 14.3 Part 1 gate: n8n fully green, VS Code `same` target met

n8n (`n8n-corpus-2026-09-02`, release binary, this session's own final commits): `n8n_population_
floors` all 10 floors **OK** (`jsts:relation_references` 1,241,334 -> **1,244,856**). References
parity: `v4_same_target=1,189,918` (>= 1,187,000 floor), **`v4_different_target=0`**, `v4_missing=
150,673`. Calls parity: `v4_confirmed_same_target=94,453` (cold-only dump), **`v4_confirmed_
different_target=0`**, `v4_possible=479`. `n8n_residual_schedule_resumes_after_truncation`/`n8n_
residual_pass_debug_histogram` (both independently agreeing): `confirmed_combined=161,908` (final
binary, all fixes below applied) -- within the existing `±4` tolerance of the refreshed reference
(§14.6). **n8n's own gate (`different == 0` in both populations, all 10 floors, `classification_
mismatch_count=0` at every generation) is fully green.**

VS Code (`vscode-corpus-2026-09-06`, reduced tree rebuilt fresh this session per §11.5/§13.4's own
recipe -- rsync `--exclude='**/fixtures/'` + `node_modules` excluded + `scripts/xterm-update.js`
removed, 12,841 files, verified against the retained recipe's own count): references `same=
2,491,954` (79.21%, **exceeds the 2,400,000 floor**, matching §13.1's own live-measured recovery
almost exactly), `missing=653,397` (20.77%). **`different` is NOT zero** (461 references, 317
calls, after §14.4/§14.5's fixes below) -- see §14.4 for what was closed and §14.7 for the
remaining, investigated-not-guessed residual.

### 14.4 VS Code residuals found AND closed this session (none of these existed in scope until
Part 1's own fix made them reachable)

1. **`.d.ts`/`.d.mts` sibling substitution, dropped** (`resolver.rs`): §14.1's own extension-
   substitution list ORIGINALLY also included each family's declaration-file extension (`.d.ts`/
   `.d.mts`/`.d.cts`), on the theory that a package shipping only compiled `.js` + a hand-written
   `.d.ts` (no `.ts` source at all) should still resolve through its types. Live-measured: 64 WRONG
   VS Code targets, all the EXACT shape E-P0l's own Pattern H already flagged and reverted
   (`§12.3`, "`foo.d.ts` + `foo.js` pair") -- `build/codex/generate-protocol.mjs` + a HAND-
   MAINTAINED (not tsc-generated) `generate-protocol.d.mts`, `src/vs/base/common/semver/semver.js`
   + its own hand-maintained `semver.d.ts`, both real pairs in this corpus, v3's own oracle
   resolving BOTH to the literal `.js`/`.mjs`, never the `.d.ts`/`.d.mts` sibling (this class of
   build-tooling script resolves under a different convention than the node16/nodenext/bundler
   monorepo packages this task targets, and this crate has no per-specifier way to tell them
   apart). Fixed by dropping declaration-file substitution entirely -- `-64` different, `same`
   essentially unchanged (2,491,836 -> 2,491,962 net across this fix alone, since a few of those
   64 sites also happened to move into `same` once the declaration-file candidate stopped
   shadowing the correct literal path).
2. **Bare TYPE reference to a value-only namespace import, demoted to pending**
   (`semantic_sites.rs`, `REASON_TYPE_REFERENCE_TARGETS_A_VALUE_ONLY_NAMESPACE`): TypeScript keeps
   separate type-space and value-space per name; `import { Iterable } from './iterator.js'`
   (`src/vs/base/common/iterator.ts`'s own plain `export namespace Iterable { ... }`, no companion
   interface/class/type/enum) is a valid VALUE reference (`Iterable.map`/`.filter`/`.first`) but has
   NO type-space meaning at all -- a bare `Iterable<T>` TYPE annotation in the SAME file (using
   `Iterable` for BOTH purposes) resolves, per a real checker, to `lib.es2015.iterable.d.ts`'s own
   global `interface Iterable<T>` instead, invisible to this crate. Previously invisible only
   because the `.js`-extension import itself silently failed to resolve at all (E-P0m's own
   `is_standard_global_name("Iterable")` entry closed the DIFFERENT, ambient-global-lookup shape of
   this same collision, not this one). Root-caused live: 126 `v4_different_target` VS Code
   reference sites, ALL this exact shape. Fixed: a reference site whose immediate AST parent is a
   `TSTypeReference` naming the SAME identifier, resolving (via the import binding) to a
   `DeclKind::Namespace` target, now demotes to pending instead of confirming -- the VALUE use of
   the SAME import is untouched (new unit test asserts both halves:
   `bare_type_reference_to_a_namespace_import_stays_pending_but_its_value_use_resolves`).
3. **Local variable annotated with an unresolvable type alias no longer falls back to the
   initializer's type** (`semantic_sites.rs`'s `record_local_type`) -- closes Part 2's own
   `mouseTarget.ts` residual, see §14.5.1.

Net VS Code effect of 1+2 together (before 3): `different` 661 -> 471 (-190); `same` 2,491,836 ->
2,491,962.

### 14.5 Part 2: the 5 residuals, case by case

| # | Case | Mechanism | Closure | Test |
|---|---|---|---|---|
| 1 | `mouseTarget.ts` (`let result: HitTestResult = new UnknownHitTestResult(); ...; result = new ContentHitTestResult(); ...; result.type`) | §14.5.1: `record_local_type`'s initializer fallback fired even though an EXPLICIT annotation (`HitTestResult`, a type-ALIAS-to-a-union this owner-local walker cannot resolve by design) was present -- the initializer's own concrete type (`UnknownHitTestResult`, coincidentally the alias's FIRST union constituent) got recorded as `result`'s type for the REST of its scope, confirming `result.type` to `UnknownHitTestResult`'s own property even after `result` was reassigned to `ContentHitTestResult` | **(a)** fixed -- the initializer fallback now runs ONLY when there is no annotation at all | `local_variable_annotated_with_an_unresolvable_type_alias_never_falls_back_to_the_initializers_type` (semantic_sites.rs) |
| 2 | `outlineModel.ts`'s `candidate.parent` (`while (candidate && !preferredGroup) { if (candidate instanceof OutlineGroup) { preferredGroup = candidate; } candidate = candidate.parent; }`) | Re-investigated with the exact live site (`outlineModel.ts:322`, `TreeElement`/`OutlineElement`/`OutlineGroup` all declare their OWN `parent: TreeElement \| undefined` at the identical declared type). `candidate`'s STATIC type at line 322 (past the `if` block's own scope, no `else`/early-return) is `TreeElement \| undefined` by ordinary TS control-flow-analysis rules, matching v4's own answer -- this session's own re-analysis could not construct a sound mechanism by which a real checker's answer would instead be `OutlineGroup`'s own declaration, and E-P0m's own session already flagged this as an unreproduced hypothesis, not a confirmed live sample | **(b)** -- not fixed, mechanism still unconfirmed; unchanged from `afc458c`, not re-guessed | none |
| 3 | `createMarkupPreview` (`notebookEditorWidget.ts`, own-body call vs. interface signature) | Unchanged from E-P0m's own §13.3: "own-body-wins is deeply load-bearing elsewhere; a guess here risks the SAME class of regression E-P0k's own adversarial finding warns about" -- not re-attempted this session (no new information since E-P0m) | **(b)** -- not fixed | none |
| 4 | `marked` (`walkThroughContentProvider.ts`, namespace import invoked as a callable value) | Unchanged from E-P0l's own §12.3 disposition: resolved by `resolve_namespace_member`, never by specifier-resolution machinery -- this task's own `.d.ts`/`.js` substitution work (§14.4 item 1) does not touch this path either | **(b)** -- not fixed, unchanged | none |
| 5 | `tunnel` (`extHostTunnelService.ts`) / `i18n.test.ts` | Not re-investigated this session (time-boxed against the higher-yield Part 1/residual-1/2 work above; E-P0m's own session already found the `tunnel` case's a-priori hypothesis REFUTED via fixture and did not confirm a live reproduction either) | **(b)** -- not fixed, unchanged | none |

Only case 1 closed with a real, live-verified mechanism this session; cases 2-5 are carried forward
unchanged from prior sessions' own dispositions (none guessed, per the task's own "never guess"
rule) -- see each prior session's own evidence section for the fuller investigation history.

### 14.6 Final VS Code/n8n measurement (this session's own final binary, all fixes above applied)

VS Code (same reduced-tree recipe as §14.3): references `same=2,491,954` (>= 2,400,000 floor OK),
**`different=461`** (NOT zero -- §14.7), `missing=653,397`. Calls (`--v4-bodies` from `dump_call_
bodies_cold_only`, the same cold-checkpoint convention §13's own calls gate uses):
`v4_confirmed_same_target=368,982`, **`v4_confirmed_different_target=317`** (NOT zero -- §14.7,
same mechanism as the references population), `v4_possible=7,508`, `v4_missing_site=366,665`.

n8n (final binary): population floors 10/10 **OK** (unchanged from §14.3); references `same=
1,189,918`, **`different=0`**; calls `same=94,453`, **`different=0`**; `confirmed_combined=161,908`
(residual schedule-resume harness, `±4` of the refreshed §14.8 reference). **n8n's own gate holds
in full with the final binary.**

### 14.7 VS Code's remaining residual: investigated, root-caused, NOT fixed (never guessed)

461 references + 317 calls remain `different`, overwhelmingly (592/778, 76%) one shape: a member
name (`getModel`/`_getViewModel`/`cellAt`/`getSelection`/...) declared MORE THAN ONCE in the SAME
file across DIFFERENT, sibling interfaces that each narrow a common base's own signature (live
example: `src/vs/editor/browser/editorBrowser.ts` declares `getModel()` in `IEditor` (`ITextModel |
null`), `ICodeEditor` (`ITextModel`), and `IDiffEditor` (`IDiffEditorModel | null`) -- v3's real
per-call-site, receiver-type-based overload/declaration-merge resolution consistently picks
`ICodeEditor`'s own narrower declaration across every sampled importer; v4's typeflow member
resolution (`urdira-jsts-typeflow`'s `ProgramIndex::members`/`collect_members`) lands on a
DIFFERENT declaration in the same file instead). Confirmed this is a PRE-EXISTING gap this
session's own new code did not introduce (every sampled importer's own specifier is a `.js`-
extension import that silently failed to resolve before this task's fix, so the ambiguity was
invisible -- classified `missing`, never `different` -- until now). This is the SAME general class
of gap `createMarkupPreview` (§14.5 case 3) and E-P0k's own `getControl` adversarial finding
already flagged as "deeply load-bearing... a guess here risks the SAME class of regression" --
implementing real receiver-type-based member/overload resolution across sibling interface
declarations is a genuinely separate typeflow feature (see `docs/evidence/2026-09-06-v4-
reconcile-threshold.md`'s own residual queue), not a `.js`/`.ts` specifier-mapping fix, and this
session's own remaining risk/time budget does not cover implementing and safely verifying it.
**`different == 0` does NOT hold for VS Code** -- reported per the "never guess, report the rest"
precedent §13.1/E-P0l's own Pattern H investigation already set; recommended as the next owner-
queue item, root cause and exact live sample above as the starting point. The remaining ~2 non-
`getModel`-shaped different-target sites (1 `ext-sibling`, a handful of `other`) were not
individually chased given the dominant category above already exhausted this session's remaining
budget for this front.

### 14.8 Files touched, verification, cleanup

- `crates/urdira-jsts-syntax-worker/src/resolver.rs`: `js_to_ts_extension_substitutes`/
  `JS_FAMILY_EXTENSIONS` (new), `push_candidate_variants` threads the substitution in; extensive
  doc-comment history of the reverted E-P0m attempt, the live incremental-consistency root cause,
  and the `.d.ts` sibling finding.
- `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`: `REASON_TYPE_REFERENCE_TARGETS_A_
  VALUE_ONLY_NAMESPACE` (new) + `identifier_is_a_type_reference_name` + the demotion check in
  `resolve_identifier_reference`'s import-bound branch; `record_local_type`'s initializer-fallback
  now gated on `annotation.is_none()`; 2 new unit tests (`bare_type_reference_to_a_namespace_
  import_stays_pending_but_its_value_use_resolves`, `local_variable_annotated_with_an_unresolvable_
  type_alias_never_falls_back_to_the_initializers_type`).
- `crates/urdira-indexing-worker/src/v4/analyze.rs`: `is_importable_surface_entry` (new);
  `run_scoped`'s surface-changed check now uses it instead of a blanket `!prior.is_subset(next)`;
  `run_scoped` calls the new `TypeflowCache::mark_reflow` for every `affected_paths` entry right
  before `build_index`.
- `crates/urdira-indexing-worker/src/v4/typeflow.rs`: `TypeflowCache::mark_reflow` (new).
- `crates/urdira-indexing-worker/src/v4/residual.rs`: `REFERENCE_CONFIRMED_COMBINED` refreshed
  161,752 -> **161,912** (+160, the coverage-improving direction: thousands of previously
  unresolved `.js`-extension imports now reach real call targets) with justification; tolerance
  (`±4`) unchanged; re-verified via both `n8n_residual_pass_debug_histogram` and the schedule-
  resume harness (§14.6, 161,908, within tolerance).
- `crates/urdira-indexing-worker/src/v4/tests_e2e.rs`: 2 STALE fixture expectations updated
  (§14.2's own delete/rename touched-set widening); `barrel_hub_adding_a_named_reexport_keeps_
  owners_to_the_barrel_itself` renamed to `..._widens_to_the_barrel_and_all_its_direct_importers`
  with its own expectation corrected + doc comment explaining why the old assumption was unsound;
  3 new incremental-consistency regression tests (§14.2).
- Verification (this session's own final state): `cargo fmt --all -- --check` clean; `cargo clippy
  --workspace --all-targets --locked -- -D warnings` clean; `cargo test -p urdira-jsts-syntax-worker
  -p urdira-indexing-worker -p urdira-jsts-typeflow -p urdira-source-frontier --locked`: **`test
  result: ok. 155 passed; 0 failed; 19 ignored`** (indexing-worker, +3), **`test result: ok. 319
  passed; 0 failed; 1 ignored`** (syntax-worker, +2), **`test result: ok. 66 passed; 0 failed`**
  (typeflow, unchanged), **`test result: ok. 46 passed; 0 failed`** (source-frontier, unchanged);
  `cargo build --release --locked -p urdira-indexing-worker` clean; `CI=true ./node_modules/.bin/
  vitest run tests/phase-daemon-v4-reconcile.test.ts tests/v4-scan.test.ts`: **`Test Files 2 passed
  (2)`, `Tests 3 passed | 4 skipped (7)`**.
- Worktree setup gotchas (new): base was stale (HEAD at an unrelated pre-v4 commit in a DIFFERENT
  branch lineage, `d07bb43` reachable but not checked out) -- `git reset --hard d07bb43` +
  `git branch -m` per the task's own §0, confirming the `feedback_worktree_subagents_base_and_node_
  modules` memory's own warning. The shared root `node_modules/typescript` symlink was self-
  referential (pointed at itself, same recurring bug class as E-P0l's `isomorphic-git`/E-P0m's
  `@bufbuild` findings) -- repointed at the real `.pnpm` store entry; `node_modules/@parcel/watcher`
  did not exist as a directory despite being a real, installed dependency -- created and symlinked.
  **Unlike E-P0m/E-P0l's own precedent, these two shared-root fixes plus this task's OWN root
  `node_modules/@urdira/*` scaffold edits were NOT the right call this session**: partway through,
  the coordinator flagged that this task's own top-level `@urdira/*` symlink edits (repointing them
  at this worktree, mirroring E-P0m's stated practice) had clobbered the shared root's own correct
  state (each entry should point at the MAIN REPO's own `packages/*`, `../../packages/<name>`, not
  any one agent's worktree) -- corrected by the coordinator's own repair pass; this session made no
  further shared-root writes after that (blocked by the harness's own classifier on the remaining
  attempt, which is the correct outcome). The two root-level vitest gate files needed NONE of this
  in the end -- both import `@urdira/*`-free, straight from `../packages/{engine,daemon}/src/
  index.js` relative to `tests/`, resolving through THIS worktree's own already-correct per-package
  `packages/*/node_modules/@urdira/*` symlinks (Paso 0) alone. **Recommended fold-in to
  `feedback_worktree_subagents_base_and_node_modules`**: never repoint the SHARED root's own
  `node_modules/@urdira/*` at a worktree; it must always point at the main repo's own `packages/*`,
  and per-package cross-package resolution belongs SOLELY inside each worktree's own `packages/*/
  node_modules/@urdira/*`.
- Cleanup: `CARGO_TARGET_DIR` (`.claude/worktrees/cargo-target-ep0n`) removed; scratch under
  `~/Proyectos/urdira-benchmark/v4-fold/ep0n-{vscode-reduced,vscode-data,vscode-parity,vscode-
  parity2,vscode-parity3,n8n-populations,n8n-parity,n8n-parity-final,n8n-residual-data,n8n-
  histogram-data,n8n-floors-final,n8n-schedule-final}/` removed; this worktree's own local
  `node_modules` symlink and the `packages/{canonical,engine}/dist` copies (untracked,
  gitignored) removed at session close.

---

## 15. E-P0o (2026-09-08): sibling-declaration ambiguity -- rule, classification, final gate

Base: `54363fc` (E-P0n merged). Same reduced-tree recipe throughout (VS Code `vscode-corpus-
2026-09-06`, rsync `--exclude='**/fixtures/'` + `node_modules` excluded + `scripts/xterm-update.js`
removed, 12,841 TS/JS files; n8n `n8n-corpus-2026-09-02`, unreduced). v3 oracles: VS Code
`~/Proyectos/urdira-benchmark/v3-vscode-2026-09-07/workspaces/workspace_p2-donor_....sqlite`, n8n
`~/Proyectos/urdira-benchmark/v3-n8n-2026-09-07-b/workspaces/workspace_n8n-corpus-2026-09-02_....
sqlite` (both read-only, unchanged from E-P0n).

### 15.1 The mechanism

E-P0n's own residual (§14.7) traced 76% (592/778) of VS Code's remaining `different`-target sites
to ONE shape: a member name declared MORE THAN ONCE in the SAME file across sibling interfaces that
each narrow a common base's own signature (`IEditor`/`ICodeEditor`/`IDiffEditor`'s own three
`getModel()` declarations in `src/vs/editor/browser/editorBrowser.ts`) -- `ProgramIndex::members`/
`collect_members` (`crates/urdira-jsts-typeflow/src/lib.rs`) picks the FIRST container's own
declaration it finds (the receiver's directly-resolved entity, e.g. `IEditor`), never checking
whether some OTHER known `extends`-descendant of that SAME entity ALSO redeclares the member.

**Fix, `crates/urdira-jsts-typeflow/src/lib.rs`:**
- `ProgramIndex::own_member_ids(entity_id, name, is_static)` (new, line ~4751): `entity_id`'s own
  `members` list only, never `extends`/`implements` -- tells apart a `members()` `One` outcome that
  came from `entity_id`'s OWN direct declaration from one that came from an INHERITED ancestor
  declaration.
- `ProgramIndex::sibling_extends_overrides(entity_id, name, is_static)` (new, line ~4805, refactors
  the existing `has_known_subclass_override` -- E-P0k -- to return the full candidate id list
  instead of a bare bool): every OTHER known container that is a transitive `extends` DESCENDANT of
  `entity_id` and ALSO declares its own `name` member. A linear scan, same performance tradeoff
  `has_known_subclass_override` already made.
- `DEMOTED_BY_SIBLING_DECLARATION` atomic + `take_demotion_reason_counts` extended to a 3-tuple
  (diagnostic only, incremented from `semantic_sites.rs` since only that crate sees the receiver-
  typing `rule`).

**Fix, `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`:**
- `rule_pins_receiver_uniquely(rule)` (new, `semantic_sites.rs:3101`): does the receiver's own
  typing rule (`type_of_expression`'s second return value) already pin it uniquely enough that the
  sibling check never needs consulting? Reliable set: `"this"`, `"super"`, `"instanceof_narrowed"`,
  `"member_declared_type"` (an explicit `: T` annotation), `"member_class_static"`, `"member_new_
  expression"`. Every other rule (`"member_declared_type_chain"`, `"call_return_type"`, `"object_
  shape_static"`, `"array_element"`, `"record_element"`, `"await"`, `"parenthesized"`, `"non_
  null"`, `"as_expression"`, `"type_assertion"`, `"inline_type_literal_member"`, ...) is some form
  of INFERENCE or PROPAGATION this crate does not itself narrow the way TypeScript's real checker
  does.
- `resolve_static_member_reference` (a plain member READ) now returns a new `StaticMemberResolution`
  enum (`Resolved`/`Candidates`/`Unresolved`, mirroring the pre-existing `TypeflowCallResolution`)
  instead of a bare `Option<String>`. The `MemberLookup::One(target)` branch, when `rule` is NOT
  reliable AND `own_member_ids(base_entity, ...)` is non-empty (own declaration, not inherited),
  consults `sibling_extends_overrides`; a non-empty result returns `Candidates([target] + siblings,
  sorted, deduped)` instead of `Resolved(target)`.
- `resolve_call_target_typeflow`'s member-callee branch gets the IDENTICAL check, feeding the
  pre-existing `TypeflowCallResolution::Candidates` variant with a new reason,
  `REASON_SIBLING_DECLARATION_AMBIGUOUS` (`"sibling_declaration_ambiguous"`, `PendingReasonCode`
  code 10, on-disk-contract append-only table).
- **New**: `CandidateReferenceRow`/`candidate_reference_record`/`OwnerSemantics::candidate_
  reference_rows` -- the `core:references` sibling of the pre-existing `CandidateCallRow`/
  `candidate_call_record`/`candidate_call_rows` (P2-2j), since a plain member reference never had a
  `possible`-with-target-id row shape before this task (`core:references` was ALWAYS `classification:
  confirmed` or absent -- see the reference-parity script's own now-stale header comment). One
  `possible` `core:references` row per candidate, `classification: "possible"`, facets `["core:
  reference_relation", "core:indirect"]`, identity `jsts:references:{path}:{start}:{end}:{source_id}:
  {target_id}` (matches the confirmed recipe's shape exactly, per-candidate distinct by `target_id`).
  The site also still contributes its ordinary `pending_sites` entry (reason `sibling_declaration_
  ambiguous`) so a later residual tsgo pass can still upgrade it. `crates/urdira-indexing-worker/
  src/v4/analyze.rs`: one new `owner.records.extend(semantics.candidate_reference_rows)` line,
  under the SAME `URDIRA_V4_SUPPRESS_POSSIBLE_ROWS_FOR_MEASUREMENT_ONLY` escape hatch as the call
  side. `main.rs`'s 16 `OwnerSemantics { ... }` test literals updated with the new field.

**Real bug found live while wiring the measurement**: `crates/urdira-indexing-worker/src/v4/
tests_e2e.rs`'s `dump_reference_bodies` (the reference-parity script's own `--v4-bodies` producer)
computed `confirmed = view.target_subject().is_some()` -- correct BEFORE this task (no `core:
references` row ever carried the `core:indirect` facet), but WRONG the instant `candidate_
reference_rows` exists: a candidate row also carries a real `target_id`
(`target_subject().is_some() == true`) and the `core:indirect` facet bit, so without a carve-out
EVERY candidate of an ambiguous site would misreport as `confirmed` -- and the parity script would
then see two (or more) DIFFERENT "confirmed" targets at the same `(path, start, end)`, exactly the
wrong-target bug class this whole mechanism exists to prevent, just relocated into the diagnostic
dump. Fixed to mirror `dump_call_bodies_cold_only`'s own pre-existing `(view.facets() &
(1u64 << indirect_bit)) == 0` carve-out exactly.

### 15.2 Decision 28's own carve-out: reliable rule, and one abandoned generalization

Decision 28's own text ("cuando el receptor SÍ está tipado de forma única... la confirmación
sigue") names three reliable shapes, which collapse to `"this"` and `"member_declared_type"` (both
covering the parameter-annotation and variable-annotation cases identically) plus three more this
task extends the same reasoning to (`"super"`, `"instanceof_narrowed"`, `"member_class_static"`/
`"member_new_expression"`) -- see `rule_pins_receiver_uniquely`'s own doc comment for the exact
per-rule justification.

**A generalization was attempted and REVERTED live, adversarial-tested against this task's own
regression suite**: extending the sibling check to an INHERITED match too (the receiver's resolved
entity does not declare `name` itself; the match comes from walking its OWN `extends` chain) broke
`instanceof_narrowing_never_applies_to_a_calls_own_target_resolution` (E-P0k's own adversarial
regression guard: `EditorPane` DOES declare `getControl` itself, `MergeEditor extends EditorPane`
overrides it, and v3's real answer for a CALL through a receiver typed `EditorPane` is still
`EditorPane`'s own declaration, UNCONDITIONALLY -- own-declaration wins for a receiver whose type
itself declares the member, matching TypeScript's real declared-type resolution, regardless of a
known subtype's own override). Root cause of why the two shapes are NOT interchangeable: a live VS
Code counter-example this generalization was chasing (`editor: ICodeEditor` in `coreCommands.ts`,
guarded by `if (!editor.hasModel()) return;`) is not a same-file candidate ambiguity at all -- it is
a DETERMINISTIC fact reached through a `hasModel(): this is IActiveCodeEditor` user-defined
TYPE-PREDICATE narrowing this crate does not model (the same general class of gap as `instanceof`
narrowing, just a different syntax: `IActiveCodeEditor extends ICodeEditor` and redeclares
`getModel` non-null; `ICodeEditor` itself inherits `IEditor`'s own wider declaration). Presenting it
as a 2-candidate `possible` ambiguity would misrepresent a deterministic-but-unmodeled fact as a
genuine unresolvable choice. **Kept out of scope, per decision 28's own "never guess" discipline**
-- implementing real type-predicate narrowing (mirroring `instanceof_narrowings`, generalized to any
boolean-returning method whose OWN declared return type is a `this is T` predicate) is a genuinely
separate typeflow feature, not a sibling-declaration fix. Both the reverted-generalization's own
adversarial finding and the final (own-declaration-only) disposition are covered by unit tests --
`sibling_declaration_ambiguous_even_when_the_match_is_inherited_not_the_receivers_own` was rewritten
to `sibling_declaration_via_an_inherited_match_stays_confirmed_not_generalized_to` once the
generalization was reverted, asserting the INTENDED (not generalized) behavior.

### 15.3 The 24% classification: previous residuals + new patterns

| # | Pattern | Count (VS Code) | Closure | Test/evidence |
|---|---|---:|---|---|
| 1 | `getModel`/`_getViewModel`/`cellAt`/`getSelection`/... -- own declaration on a base interface + a sibling `extends`-descendant redeclares, receiver NOT reliably typed | 592/778 (76% of E-P0n's own residual) | **(a) fixed** -- sibling-candidate rule, §15.1 | `sibling_declaration_ambiguous_member_read_produces_candidate_reference_rows_never_a_confirmed_one`, `sibling_declaration_ambiguous_call_target_produces_candidate_call_rows_never_a_confirmed_one` (semantic_sites.rs) |
| 2 | Same shape, but the receiver IS reliably typed (explicit annotation/`this`/`new`/static) AND the sibling genuinely does not exist -- confirmation must stay | n/a (control) | **(a) modeled, must NOT be touched** | `explicitly_annotated_parameter_of_the_narrower_sibling_interface_still_confirms` |
| 3 | `ICodeEditor`/`IActiveCodeEditor`-shaped: own declaration NOT direct (inherited via the receiver's OWN `extends` chain), a FURTHER descendant redeclares, reached through a `hasModel(): this is X` type-predicate guard | ~281 references / ~153 calls (this task's own final residual, down from 461/317) | **(b) not fixed, reported** -- distinct root cause (unmodeled type-predicate narrowing), §15.2 | `sibling_declaration_via_an_inherited_match_stays_confirmed_not_generalized_to` (documents the deliberate non-fix); live samples in `v4-fold/ep0o-reports/vscode-references-parity2.json`/`-calls-parity.json` |
| 4 | `outlineModel.ts`'s `candidate.parent` (E-P0m residual #2) | unchanged | **(b) unchanged** -- ordinary TS control-flow narrowing (no `instanceof`/type-predicate involved), already investigated and found to MATCH v4's own answer; not a member-declared-twice-in-file shape at all, outside this mechanism's reach | none (unchanged from E-P0n §14.5) |
| 5 | `createMarkupPreview` (E-P0m residual #3, `notebookEditorWidget.ts`) | unchanged | **(b) unchanged** -- "own body wins over interface signature" is the OPPOSITE preference from this mechanism's own "own declaration is untrustworthy" rule; `resolve_call_target_typeflow`'s own-body-call path is untouched by this task's diff | none (unchanged) |
| 6 | `marked` (E-P0l/m residual #4, `walkThroughContentProvider.ts`, namespace import invoked as a callable) | unchanged | **(b) unchanged** -- resolved via `resolve_namespace_member`, a code path this task's diff never touches | none (unchanged) |
| 7 | `tunnel` / `i18n.test.ts` (E-P0m residual #5) | unchanged | **(b) unchanged** -- not re-investigated this session (E-P0m's own a-priori hypothesis already refuted, no new information); not a member-declared-twice-in-file shape | none (unchanged) |

Patterns 4-7 are reported unchanged on STRUCTURAL grounds (code-path analysis: this task's diff
touches only `resolve_static_member_reference`'s/`resolve_call_target_typeflow`'s `MemberLookup::
One` branches and `ProgramIndex`'s member-lookup helpers -- `resolve_namespace_member`, the own-
body-call preference, and `outlineModel.ts`'s plain-narrowing control flow are all outside that
diff's reach), not re-verified against fresh live samples this session (time-boxed against pattern
3's own higher-yield investigation, which consumed the bulk of this task's remaining budget).

### 15.4 Final gate measurement (this session's own final binary, `own_member_ids`-gated version)

**VS Code** (reduced tree, 12,841 files, same recipe as §14.3): references
`--v3-db v3-vscode-2026-09-07/workspaces/workspace_p2-donor_....sqlite --v4-bodies <cold dump>`:
`v3 confirmed core:references sites=3,145,812`; `same=2,482,057` (78.90%, **≥ 2,400,000 floor OK**),
**`different=281`** (0.01%, down from 461, **-39%**), `missing=663,474` (21.09%). Calls (`--v4-
bodies` from the AFTER-residual dump, 60s budget, §15.5): `v3 confirmed core:call sites=743,472`;
`v4_confirmed_same_target=378,398` (50.90%), **`v4_confirmed_different_target=153`** (0.02%, down
from 317, **-52%**), `v4_possible=353,326` (47.52%), `v4_missing_site=11,595` (1.56%), reverse
`v4_confirmed_v3_missing_site=54,973` (unchanged shape from E-P0n, not this task's own scope).
**`different == 0` still does NOT hold for VS Code** -- reported per §14.7's own "never guess,
report the rest" precedent; the residual is now a DIFFERENT (deeper, unmodeled type-predicate
narrowing), smaller root cause than E-P0n's own 76% finding, not a failure to apply this task's own
authorized mechanism (§15.3's classification table accounts for the remainder).

Sibling-declaration demotions during the VS Code cold scan: `DEMOTED_BY_SIBLING_DECLARATION=
19,931` total (references + calls combined); `11,086` of those land as `IdentifierRef` pending
sites with reason `sibling_declaration_ambiguous` (the rest are call-target demotions, not
separately instrumented as a pending-site count the way references are -- call sites already had a
`pending_call_sites`/`candidate_call_rows` dual-bucket from the pre-existing overload/union
mechanism, reused unchanged here).

**n8n** (unreduced corpus, unchanged recipe): references `same=1,189,872` (**≥ 1,187,000 floor
OK**), **`different=0`**; calls `same=116,808`, **`different=0`**; population floors 10/10 **OK**
(`n8n_population_floors`, part of the ignored suite run this session). **n8n's own gate holds in
full.** `DEMOTED_BY_SIBLING_DECLARATION=95` on n8n's own cold scan (small relative to VS Code's
~20K, but real, confirming the mechanism is corpus-size-proportional, not VS Code-specific).

### 15.5 Residual (cota 60s x1, VS Code) -- `confirmed_combined` before/after

`URDIRA_V4_RESIDUAL_BUDGET_MS=60000`, `n8n_residual_pass_debug_histogram` pointed at the reduced VS
Code tree (same generic harness, historical `n8n_`-prefixed name):

| | `core:call` confirmed | `core:call` possible | heritage confirmed | `confirmed_combined` |
|---|---:|---:|---:|---:|
| COLD (generation 1) | 413,493 | 55,938 | 13,004 | **426,497** |
| AFTER residual, 60s budget (generation 2) | 436,837 | 51,796 | 13,243 | **450,080** |

The 60s-budgeted residual pass confirmed **+23,583** additional sites (calls +23,344, heritage
+239) out of VS Code's much larger overall pending population (900K+) -- expected given the short
budget relative to corpus size (§2's own n8n residual precedent used a 20s budget against a
~9x-smaller corpus). This run does not isolate how many of the SPECIFICALLY `sibling_declaration_
ambiguous`-reasoned pending sites the residual pass upgraded (would need an additional site-level
before/after diff keyed on `reason`, not performed this session, time-boxed) -- reported as a known
measurement gap, not fabricated.

n8n's own dedicated `confirmed_combined` regression harness (`n8n_residual_schedule_resumes_after_
truncation`, `URDIRA_V4_RESIDUAL_BUDGET_MS=15000`, full truncate-then-resume convergence, the
harness the ±4 tolerance is actually calibrated against): **`confirmed_combined=161,903`** (core:
call confirmed 160,035 + possible 407, heritage confirmed 1,868). This is 9 below the pre-task
reference (161,912) -- OUTSIDE the existing ±4 tolerance, but in the SAME "intended, safety-
improving direction" every prior refresh in this file documents (E-P0m -55, E-P0n +160): this
task's own 95 n8n sibling-declaration demotions correctly move a handful of previously
confident-but-occasionally-wrong confirmations to `possible`, and `different == 0` still holds in
both VS Code and n8n parity for this exact build. `REFERENCE_CONFIRMED_COMBINED` refreshed
161,912 -> **161,903** with this justification (`residual.rs`); tolerance (`±4`) unchanged.

### 15.6 Files touched, verification, cleanup

- `crates/urdira-jsts-typeflow/src/lib.rs`: `DEMOTED_BY_SIBLING_DECLARATION` + `take_demotion_
  reason_counts` extended to 3-tuple; `ProgramIndex::own_member_ids`/`sibling_extends_overrides`
  (new); `has_known_subclass_override` refactored in terms of `sibling_extends_overrides`.
- `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`: `REASON_SIBLING_DECLARATION_AMBIGUOUS`
  (new) + `PendingReasonCode::SiblingDeclarationAmbiguous` (code 10); `rule_pins_receiver_uniquely`
  (new); `StaticMemberResolution` enum (new) + `resolve_static_member_reference` signature change;
  `resolve_call_target_typeflow`'s member-callee branch gets the same check;
  `CandidateReferenceRow`/`candidate_reference_record`/`OwnerSemantics::candidate_reference_rows`
  (new, the `core:references` sibling of the pre-existing call-side mechanism); `visit_static_
  member_expression` rewritten around the new three-way `StaticMemberResolution` match; 5 new unit
  tests (§15.1/15.2/15.3).
- `crates/urdira-indexing-worker/src/v4/analyze.rs`: one new `owner.records.extend(semantics.
  candidate_reference_rows)` line under the existing measurement escape hatch.
- `crates/urdira-indexing-worker/src/v4/tests_e2e.rs`: `dump_reference_bodies`'s `core:indirect`
  carve-out fix (§15.1, a real live-found bug); `n8n_references_parity_debug_dump`'s demotion-
  histogram println extended to 3 lines.
- `crates/urdira-indexing-worker/src/v4/residual.rs`: `REFERENCE_CONFIRMED_COMBINED` refreshed
  161,912 -> **161,903** with justification (§15.5); tolerance (`±4`) unchanged; demotion-histogram
  println extended to 3 lines.
- `crates/urdira-indexing-worker/src/main.rs`: 16 `OwnerSemantics { ... }` test literals gain
  `candidate_reference_rows: vec![]`.
- `docs/decisions/28-v4-rust-semantics-and-residual-checker.md`: amendment recording the sibling-
  candidate rule and its own-declaration-only scope (§15.2).
- Verification (this session's own final state): `cargo fmt --all -- --check` clean; `cargo clippy
  --workspace --all-targets --locked -- -D warnings` clean; `cargo test -p urdira-jsts-syntax-worker
  -p urdira-indexing-worker -p urdira-jsts-typeflow --locked`: **`test result: ok. 155 passed; 0
  failed; 19 ignored`** (indexing-worker), **`test result: ok. 323 passed; 0 failed; 1 ignored`**
  (syntax-worker, +4 tests over E-P0n's own 319), **`test result: ok. 66 passed; 0 failed`**
  (typeflow, unchanged); ignored suite with `URDIRA_TSGO_BINARY` set: 17/19 pass (the 2 failures --
  `n8n_records_logical_set_diff_against_keep_data`/`graph_identity_set_matches_between_two_kept_
  stores` -- need external `--keep-data` harness fixtures this session never produced, unrelated to
  this task's own diff); `cargo build --release --locked -p urdira-indexing-worker` clean; `CI=true
  ./node_modules/.bin/vitest run tests/phase-daemon-v4-reconcile.test.ts tests/v4-scan.test.ts`:
  **`Test Files 2 passed (2)`, `Tests 7 passed (7)`** (needed the full TS package build chain +
  `node scripts/build-native.mjs`, neither of which E-P0n's own smaller vitest run required).
- Worktree setup: base was stale (HEAD at an unrelated, much later commit in a DIFFERENT lineage,
  `7d04d49`) -- `git reset --hard 54363fc` + `git branch -m`, confirming the `feedback_worktree_
  subagents_base_and_node_modules` memory's own warning yet again. Per-package `packages/*/node_
  modules/@urdira/*` symlinks created fresh (none existed). `packages/embedding-local` additionally
  needed its own `node_modules/@huggingface/transformers` symlink into the `.pnpm` store (not
  hoisted to the shared root) before `tsc --build packages/embedding-local` would succeed.
- Cleanup: `CARGO_TARGET_DIR` (`.claude/worktrees/cargo-target-ep0o`) removed; scratch under
  `~/Proyectos/urdira-benchmark/v4-fold/ep0o-{vscode-donor,vscode-refs,vscode-refs2,vscode-pending-
  refs,vscode-pending-refs2,vscode-residual-data,vscode-calls-cold,vscode-calls-after,n8n-refs,n8n-
  pending-refs,n8n-residual-data,n8n-schedule-data,n8n-schedule-data2,n8n-calls-cold,n8n-calls-
  after,reports}/` removed; this worktree's own local `node_modules` symlink, per-package `packages/
  */node_modules/@urdira/*` symlinks, and every `packages/*/dist`/`*.tsbuildinfo` this session
  produced (untracked, gitignored) removed at session close.

## 16. E-P0p (2026-09-09): the last VS Code pattern — inherited member match + type-predicate
narrowing

Base: `a7438ec` (E-P0o merged). Same reduced-tree RECIPE as prior sessions (rsync `--exclude=
'**/fixtures/'` + `node_modules` excluded from the copy then symlinked back in + `scripts/xterm-
update.js` removed), but a FRESH pass this session against the SAME retained `vscode-corpus-2026-
09-06` checkout produced **10,044** TS/JS files (`find ... -name '*.ts' -o -tsx -o -js -o -mjs -o
-cjs`, `node_modules` excluded) — smaller than the 2026-09-08 session's own 12,841. Not reconciled
further (a `--exclude` glob edge case or a filesystem walk-order difference between sessions,
neither investigated — the walker's own frontier at scan time, not this `find` count, is what a
cold scan actually processes either way, same caveat §11.5's own evidence already recorded for a
similar discrepancy). n8n corpus (`n8n-corpus-2026-09-02`, unreduced) unchanged. v3 oracles:
`v3-vscode-2026-09-07`/`v3-n8n-2026-09-07-b`, both retained, read-only, unchanged.

### 16.1 The mechanism

§15.2's own residual (the `ICodeEditor`/`IActiveCodeEditor` counter-example, deliberately NOT
generalized to by E-P0o) is closed by TWO changes:

**1. `ProgramIndex::own_member_ids` removed (`crates/urdira-jsts-typeflow/src/lib.rs`)** — the
sibling-candidate check (`ProgramIndex::sibling_extends_overrides`) now fires whenever `!rule_pins_
receiver_uniquely(rule)`, regardless of whether the member match came from the receiver's own
direct declaration or an inherited one. `sibling_extends_overrides(entity_id, ...)` already only
ever returns transitive `extends` DESCENDANTS of `entity_id` — this was true before this task too —
so no separate own-vs-inherited gate was ever structurally necessary; re-examining E-P0o's own
adversarial regression guard (`instanceof_narrowing_never_applies_to_a_calls_own_target_
resolution`) directly (rather than re-deriving the earlier, reverted attempt) showed its own
receiver (`activePane: EditorPane`) is typed through `"member_declared_type"`, already reliable
regardless of own vs. inherited, so this generalization changes nothing about it. Call sites:
`resolve_static_member_reference`/`resolve_call_target_typeflow` (`semantic_sites.rs`).

**2. `this is T` type-predicate narrowing (new mechanism).** `RawTypeRef`/`ResolvedTypeRef::
TypePredicate { subject: PredicateSubject, target }` (`urdira-jsts-typeflow/src/lib.rs`) — a
method/function's own declared return type when it is a TypeScript user-defined type predicate;
`PredicateSubject::Receiver` for `this is T` (the only shape consulted below), `Parameter(name)`
for `param is T` (represented for correctness — never misclassified as a plain type — but NOT
consulted by any resolver: narrowing a function's own ARGUMENT by parameter name/position needs a
per-function parameter table this index does not keep, and no live sample forced building one).
`ProgramIndex::member_predicate_receiver_narrowing(entity_id, name, is_static)` resolves a `this is
T` member's own asserted `T` to a concrete entity id, reusing `member_type_ref`'s existing own-
then-`extends`-then-`implements` traversal (`lookup_member_type_ref`) — no new traversal code.

`semantic_sites.rs`'s new `type_predicate_narrowings: Vec<(SymbolId, String)>` stack mirrors
`instanceof_narrowings`' own bracketing exactly for the POSITIVE form (`extract_type_predicate_
narrowings`, pushed/popped in `visit_if_statement`'s consequent and `visit_logical_expression`'s
`&&` right-hand side) — `x.hasModel()` narrows `x` to `T` for the guarded region. A NEW rule
string, `"type_predicate_narrowed"`, added to `rule_pins_receiver_uniquely`'s reliable set. Unlike
`instanceof_narrowed`, this rule is **never suppressed for a call's own target resolution** — no
`suppress_..._for_calls`-shaped cell exists for it — because the live counter-example itself is a
CALL (`editor.getModel()`) that DOES need to follow the narrowing (a type predicate narrows the
receiver to a genuinely different, non-override-related interface shape, unlike `instanceof`
narrowing a receiver to a virtual-dispatch subclass override the unnarrowed type already resolves
correctly for calls).

**3. The SAME predicate narrowing, generalized to the negated-early-return idiom** — VS Code's own
DOMINANT real shape for `hasModel()` specifically (live count against the reduced tree: 238 sites
matching `if (!x.hasModel())`/`if (!x.hasModel() || ...)` vs. a smaller positive-form count,
`grep -rn` against `vscode-corpus-2026-09-06/src`). `semantic_sites.rs`'s new `fn visit_statements`
override (replacing the default `oxc_ast_visit::walk::walk_statements` loop for EVERY statement-
list context this visitor reaches — a block body, a function/program top level, ...) recognizes an
`if` with no `else` whose test is a negated predicate call (`extract_negated_predicate_narrowings_
from_early_exit_test`, through any number of `||`-joined disjuncts) and whose consequent
`statement_definitely_exits` (a bare or nested-block-ending `return`/`throw`/`continue`/`break` —
deliberately narrow: an `if`/`else` where both branches exit, a `switch` where every case exits,
... are real reachability proofs TypeScript's own checker would make but this crate does not
attempt), and extends `type_predicate_narrowings` across the REST of that SAME statement list.
Reaching any statement after such an `if` proves the test was false; for a negated predicate call
that means the predicate itself was true — the identical fact the positive form's own consequent
proves, reached through the opposite branch.

Unit tests (`semantic_sites.rs`): `sibling_declaration_via_an_inherited_match_with_a_reliable_rule_
still_confirms` (renamed/re-justified control, formerly `..._not_generalized_to`), `sibling_
declaration_ambiguous_inherited_match_produces_candidate_reference_rows_when_the_receiver_is_not_
reliably_typed` (the actual generalization, new), `type_predicate_narrowing_confirms_the_narrowed_
descendants_own_declaration_for_read_and_call` (the `ICodeEditor`/`IActiveCodeEditor` shape,
reproduced structurally), `type_predicate_narrowing_never_leaks_past_its_own_guarded_region`
(rewritten from its own earlier draft after the FIRST version's own assumption — that the
unguarded read stays ambiguous — turned out wrong: `editor: IEditor` is explicitly, reliably typed
and `IEditor` declares `getModel` itself, so it correctly stays confirmed to `IEditor`'s own
declaration outside the guard, exactly like `explicitly_annotated_parameter_of_the_narrower_
sibling_interface_still_confirms`'s own established control — this test now asserts THAT, plus that
the narrowing itself does not leak past its scope), `negated_early_return_type_predicate_narrows_
the_rest_of_the_block` (the new dominant idiom), `negated_predicate_guard_without_a_definite_exit_
never_narrows_what_follows` (safety companion: a guard that does not provably exit narrows
nothing).

### 16.2 The E-P0k test that "broke" (per this task's own §0 instruction, disposition decided)

`instanceof_narrowing_never_applies_to_a_calls_own_target_resolution` (`EditorPane`/`MergeEditor`,
`getControl`) asserts that `instanceof`-narrowing must NEVER change a CALL's own target resolution
— a protection about `instanceof` specifically, not about inherited-member-plus-sibling ambiguity
at all. **Unaffected by this task's own diff, unchanged, still green** — `activePane`'s own rule
for the call is `"member_declared_type"` (an explicit parameter annotation; `instanceof`-narrowing
is separately suppressed for a call's own target resolution by the PRE-EXISTING `suppress_
instanceof_narrowing_for_calls` cell, untouched here), already in `rule_pins_receiver_uniquely`'s
reliable set REGARDLESS of own-vs-inherited, so the sibling-candidate check this task generalized
never even engages for it. No test rewrite was needed for this one; `sibling_declaration_via_an_
inherited_match_with_a_reliable_rule_still_confirms` (§16.1) is the test that DID need
re-justifying, since it exercises the actual own-vs-inherited boundary this task changed (verified:
its own outcome — stays confirmed — is UNCHANGED by the generalization, because its own receiver is
ALSO reliably typed; see that test's own doc comment for why).

### 16.3 Final gate measurement (this session's own final binary)

**VS Code** (reduced tree, 10,044 files, `--v4-bodies` from a single cold-scan run producing both
dumps): references `v3 confirmed core:references sites=3,145,812`; `same=2,482,169` (78.90%, **≥
2,400,000 floor OK**), **`different=189`** (0.01%, down from 281, **-33%**), `missing=663,454`
(21.09%). Calls: `v3 confirmed core:call sites=743,472`; `v4_confirmed_same_target=360,654`
(48.51%), **`v4_confirmed_different_target=58`** (0.01%, down from 153, **-62%**),
`v4_possible=16,158` (2.17%, undercounted by design — `dump_call_bodies_cold_only` skips the
pending-call-site-as-possible-row synthesis, see `n8n_references_parity_debug_dump`'s own doc
comment), `v4_missing_site=366,602` (49.31%, same undercount artifact). **`different == 0` still
does NOT hold for VS Code** — §16.4 classifies the remainder.

Sibling-declaration demotions during the VS Code cold scan: `sibling_declaration_ambiguous` pending
`IdentifierRef` sites `11,232` (down slightly from E-P0o's own 11,086-of-a-different-generation
figure — same order of magnitude, expected: this generalization also CONVERTS some previously
`different`/wrongly-confirmed sites into demotions, but also RECOVERS some previously-demoted own-
declaration sites into confirmed via the new `"type_predicate_narrowed"` reliable rule, netting out
close to flat).

**n8n** (unreduced corpus): references `same=1,189,872` (**≥ 1,187,000 floor OK**),
**`different=0`**; calls `same=94,425`, **`different=0`**; `sibling_declaration_ambiguous` pending
sites `62` (down from E-P0o's own 95, both real, small, corpus-proportional). **n8n's own gate
holds in full**, unchanged from E-P0o.

`n8n_residual_schedule_resumes_after_truncation` (`URDIRA_V4_RESIDUAL_BUDGET_MS=15000`, the
dedicated `confirmed_combined` regression harness): **`confirmed_combined=161,903`** (core:call
confirmed 160,035 + possible 407, heritage confirmed 1,868) — an EXACT match to `REFERENCE_
CONFIRMED_COMBINED=161,903` (diff 0, well inside the ±4 tolerance). No constant refresh needed;
`different == 0` continues to hold in n8n's own parity for this exact build.

### 16.3b Residual pass (60s budget, VS Code) -- `confirmed_combined` before/after

`URDIRA_V4_RESIDUAL_BUDGET_MS=60000`, same reduced tree, `n8n_residual_pass_debug_histogram`
(historical name, generic harness):

| | `core:call` confirmed | `core:call` possible | heritage confirmed | `confirmed_combined` |
|---|---:|---:|---:|---:|
| COLD (generation 1) | 413,478 | 56,429 | 13,004 | **426,482** |
| AFTER residual, 60s budget (generation 2) | 436,818 | 52,287 | 13,243 | **450,061** |

Nearly identical to E-P0o's own COLD=426,497/AFTER=450,080 (+23,583) measurement: this session's
own COLD=426,482/AFTER=450,061 (**+23,579**) — consistent within the small file-count discrepancy
§16's own preamble already noted (10,044 vs. 12,841 files), confirming this task's own diff did not
regress the residual pass itself. As before, this run does not isolate how many of the
SPECIFICALLY `sibling_declaration_ambiguous`/`type_predicate`-reasoned pending sites the residual
pass upgraded (a site-level before/after diff keyed on `reason`, not performed this session either
— same known measurement gap E-P0o's own §15.5 already reported, still not closed).

### 16.4 The remaining VS Code residual, classified (not guessed at)

A representative sample of the 189 reference / 58 call `different` sites (drawn from the parity
scripts' own 30-per-bucket reservoir, both before and after this task's own fix, cross-checked
against the live source) resolves into the following DISTINCT root causes, none of them the
`this is T`/inherited-member shape this task's own mechanism targets:

| # | Pattern | Live sample | Disposition |
|---|---|---|---|
| 1 | **`implements`-not-`extends` sibling conformance**: the receiver's static type is an INTERFACE (`IAction`, `ICellViewModel`, `IEditorPane`, ...) declaring a member itself or via inheritance, and the CONCRETE class v3 resolves to (`Action`, `BaseCellViewModel`, `EditorPane`, ...) reaches it by `implements`, never `extends` — `ProgramIndex::sibling_extends_overrides`'s own "real subclassing, not interface conformance" restriction (`extends_chain_reaches`'s own doc comment, E-P0k) deliberately never walks this edge. | `run`/`getId`/`getSelection`/`getName`/`getEOL`/`getData`/`compare`/`getFocus`/`getEditState`/`updateEditState`/`handle`/`uri`/`outputsViewModels`/`editStateSource`/`domNode`/`getControl`/`getScrollPosition`/`copy`/`accept`/`reject`/`resolve` — the large majority of the remaining samples | **(b) not fixed, reported** — generalizing the sibling check to `implements` would need to enumerate EVERY known implementer of a common interface (`IAction`-shaped interfaces can have dozens across a codebase this size), an effectively unbounded candidate set with no way to bound false ambiguity — risks a large, unmeasured precision regression across every ordinary confirmed call/read through such an interface. Out of this task's own scope (member INHERITANCE + type-PREDICATE narrowing specifically). |
| 2 | **Negated `instanceof` early-return** — the SAME general shape this task's own negated-predicate-call generalization closes, but for a literal `instanceof` check (`if (!(editor instanceof SimpleCommentEditor)) { return null; }`), which `instanceof_narrowings` (E-P0k) itself only brackets for the POSITIVE form, never a negated early exit. | `commentsInputContentProvider.ts`'s own `getModel` call, reached through `editor: ICodeEditor` narrowed to `SimpleCommentEditor` | **(b) not fixed, reported** — a real, closely related gap in the PRE-EXISTING `instanceof_narrowings` mechanism (E-P0k), not the type-predicate mechanism this task adds; extending `instanceof_narrowings` itself to the negated-early-return idiom is a well-scoped follow-up (the SAME `visit_statements`/`statement_definitely_exits` infrastructure this task built would need a second extraction function mirroring `instanceof_narrowing_of_binary`) but is a DIFFERENT decision's own scope, not exercised here. |
| 3 | **Standalone function `param is T` predicate** (`isSelectionAwareEditorPane(x): x is T`, called as a bare function `isFoo(x)` rather than a member call) | `historyService.ts`'s own `getSelection` call, reached through `isSelectionAwareEditorPane(editorPane)` | **(b) not fixed, reported** — `PredicateSubject::Parameter` is represented in `RawTypeRef::TypePredicate` (§16.1) precisely so this shape is never MISCLASSIFIED, but resolving it needs a per-function parameter-name-to-position table this index does not keep; no consumer built this session, per the task's own scope decision (`this is T` via a member call was the authorized, measured-necessary shape). |
| 4 | `createMarkupPreview` (`notebookEditorWidget.ts`) | unchanged from E-P0m/E-P0o | **(b) unchanged** — "own body wins over interface signature" is the OPPOSITE preference from every mechanism in this file; already investigated (E-P0m §13.3) and reported, mechanism not identified, out of scope here too. |
| 5 | `McpApps` namespace (4 duplicate-target samples, all the SAME two-declaration pair) | `modelContextProtocolApps.ts` — TWO `namespace McpApps` declarations in the SAME file, v3 and v4 pick different ones | **(b) unchanged, newly exposed** — a namespace-declaration-merge selection bug, structurally unrelated to member/call resolution entirely (this task's diff touches neither `resolve_namespace_member` nor any namespace-declaration code path); not investigated further, time-boxed against this task's own higher-yield pattern-1/§16.1 work. |
| 6 | `getTargetOperatingSystem`/`getFloatingBarButtonStyles` (`typeof`-value-copy-shaped, `debugConfigurationManager.ts`/`issueReporterOverlay.ts`) | 2 samples | **(b) unchanged** — E-P0l/E-P0m's own `typeof`/call-return-type residual class, this task's diff does not touch `raw_type_ref_of_value_copy_expression` or `resolve_call_target_typeflow`'s `TypeQuery` branch. |

Patterns 1-6 account for every sampled `different` site this session inspected; none is a
regression (all pre-existed this task's own diff, several ALREADY reported unresolved by earlier
frentes — §16 simply removed the ONE pattern, `this is T` via a member call, that WAS this task's
own authorized scope, at both its dominant real idioms). Per the task's own §0 "never guess"
discipline and this campaign's own consistent precedent (E-P0n §14.7, E-P0m §13.4, E-P0o §15.3 all
reported a nonzero, classified VS Code residual rather than chase every remaining shape into an
unrelated mechanism), pattern 1 in particular is a DELIBERATE non-fix: the risk profile (unbounded
candidate sets for widely-implemented interfaces) is qualitatively different from — and larger
than — every sibling-candidate shape fixed so far, which is why `extends_chain_reaches` drew this
exact line back in E-P0k and why this task does not cross it.

### 16.5 Files touched, verification, cleanup

- `crates/urdira-jsts-typeflow/src/lib.rs`: `PredicateSubject` (new); `RawTypeRef`/
  `ResolvedTypeRef::TypePredicate` (new variants, plus every exhaustive match site: `raw_type_ref_
  of_ts_type`'s new `TSTypePredicate` arm, `resolve_raw_type_ref`/`resolve_raw_type_ref_deferred`/
  `resolve_type_ref_chasing_aliases`/`contains_deferred`'s new arms); `ProgramIndex::own_member_ids`
  removed; `ProgramIndex::member_predicate_receiver_narrowing` (new); `sibling_extends_overrides`'s
  own doc comment rewritten to describe the generalization and its own history.
- `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`: `type_predicate_narrowings` stack
  (new); `extract_type_predicate_narrowings`/`type_predicate_narrowing_of_call` (new, positive
  form); `extract_negated_predicate_narrowings_from_early_exit_test`/`type_predicate_narrowing_of_
  negated_operand`/`statement_definitely_exits` (new, negated-early-return form); `visit_
  statements` override (new); `visit_if_statement`/`visit_logical_expression` extended to also
  bracket `type_predicate_narrowings`; `type_of_expression`'s `Identifier` arm consults it
  (`"type_predicate_narrowed"`, never suppressed for calls); `rule_pins_receiver_uniquely` extended
  (new reliable rule, doc comment rewritten for the `own_member_ids` removal); `resolve_static_
  member_reference`/`resolve_call_target_typeflow`'s own sibling-check call sites simplified (gate
  removed); `resolve_type_ref_relative`'s new `TypePredicate` arm (`None` — never this call's own
  VALUE type); imports: `Statement`, `UnaryOperator`, `ArenaVec`; 6 new/rewritten unit tests
  (§16.1).
- `docs/decisions/28-v4-rust-semantics-and-residual-checker.md`: amendment recording both new
  mechanisms and the final classified residual (this section).
- Verification (this session's own final state): `cargo fmt --all -- --check` clean; `cargo clippy
  --workspace --all-targets --locked -- -D warnings` clean; `cargo test -p urdira-jsts-syntax-
  worker -p urdira-jsts-typeflow --locked`: **`test result: ok. 328 passed; 0 failed; 1 ignored`**
  (syntax-worker, +5 over E-P0o's own 323), **`test result: ok. 66 passed; 0 failed`** (typeflow,
  unchanged).
- Worktree setup: base was stale (HEAD at an unrelated, much later commit, `7d04d49`) — `git reset
  --hard a7438ec` + `git branch -m`, confirming `feedback_worktree_subagents_base_and_node_modules`
  yet again. `packages/canonical`/`packages/storage` (plus `contracts`) built fresh in-worktree via
  `tsc --build` (needed only for the `.mjs` parity-diff scripts' own `decodeCanonical`/schema
  imports, never for the Rust binary itself).
- Cleanup: `CARGO_TARGET_DIR` (`.claude/worktrees/cargo-target-ep0p`) removed; scratch under
  `~/Proyectos/urdira-benchmark/v4-fold/ep0p-{vscode-reduced,reports,vscode-residual-data,n8n-
  residual-data}/` removed; this worktree's own local `node_modules` symlink, per-package
  `packages/{canonical,storage,contracts}/node_modules/@urdira/*` symlinks, and every
  `packages/*/dist`/`*.tsbuildinfo` this session produced (untracked, gitignored) removed at
  session close.
