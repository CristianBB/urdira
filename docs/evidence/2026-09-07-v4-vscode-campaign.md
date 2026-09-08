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
