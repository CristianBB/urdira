# Definitive agent benchmark results — reporting status

## Current v7 retained result

Status: **v7 blocked after two campaign-1 cell attempts** (2026-09-15). The retained v7 execution is the current measurement state: one completed baseline cell, one Urdira infrastructure failure before model invocation, 43 agent cells not started, and all 18 readiness probes not started. The user-authorized order is 45 agent cells followed by 18 readiness probes; the stop policy records no retry. This is a blocked partial result, not a completed 45-cell or 18-probe benchmark.

| Result set | Expected | Attempted / observed | Successful | Failed or blocked | Not started | Status |
|---|---:|---:|---:|---:|---:|---|
| Agent cells | 45 | 2 | 1 | 1 | 43 | blocked |
| Readiness probes | 18 | 0 | 0 | 0 | 18 | not started |

The retained raw campaign audit is `/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v7/execution-v7/campaign-1/campaign-audit.json` (SHA-256 `51f88c6e83cafd3016d897c0f959ba60a2db35afce8512359ba8899917140678`). The stop ledger is `.../series-v7/execution-v7/campaign-1/campaign-1-stop-ledger-v1.json` (SHA-256 `10cdabce6ab2aa0b4bec1f39cc525ee83ee91da80ba49f6d0b8dcf6ef9d2997d`) and the stop checkpoint is `.../campaign-1-stop-checkpoint-v1.json` (SHA-256 `9506ad6782b40cfb1b5fe8fca98cab67e0921f6f88e0402c5eb6456a2daa713a`). The three v7 cell manifest SHAs are `1500da83f9785090191cf1239fe5dfcc59e8b6ce0be6742d5ea644adc4e83d5d`, `376f0b6197de6335bcd0f6d6302d5ec8f37e6adca7ca7981ff869a1f9d9b2f0f`, and `7124780e7a9389e3cddffe550bee7b5781db983a006793e19d15dd6f46f84481`; the readiness manifest SHAs are `e007df8f43219a2965f27043763b39129c22b5e687268f4d218adc6cada685fd`, `172679656bbec427624c1de26a1936dc33d7b3a97e135f8d817d80ce10142e1d`, and `ea8a19187d95d3a82679290819e99647596a13a32eadca36d7e8c014c7aa7cf2`.

The baseline has retained evidence of a real model interaction: `model_invoked=true`, three successful Codex invocations, three matched host root turns, three `turn.completed` records, and matched cumulative host token evidence. Its measured values are input `816,937`, cached input `753,920`, output `8,575`, reasoning `3,000`, normative additive total `828,512`, provider-reported total `825,512` retained separately, and estimated cost `$1.726474` under the frozen rate card (input/cached $2/M, output/reasoning $8/M). The baseline completed in `239,518 ms` after the first instruction, with `501 ms` setup, exit `0`, grader exit `0`, and P95 `null`. Context measurements include 3 outer turns, 24 shell command calls, 19 source-read shell calls, 0 MCP/hook/tgrep calls, 107,043 repository-context characters, 70,765 target-attributed characters, and 36,278 unattributed characters; shell overlap is `null` with 19 unclassified source reads because no MCP source was present. Correctness evidence matched 2/2 target paths and had no unsafe omissions; numeric test coverage was unavailable (`null`).

The Urdira cell exited `1` during host readiness before model invocation; its retained error is `Urdira host exited before readiness (7/none)`, with `model_invoked=false` in the retained manifest. It is an infrastructure/coverage failure, not a model result. Its cleanup passed. Missing fields remain `null`; no zero is inferred. P95 is `null` because the definitive campaign has only one observed cell per identity and is incomplete.

The offline analyzer, replay, and renderer used retained v7 raw paths only and wrote to the new external directory `/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v7-derived-20260915-v1`. The partial audit SHA is `338740ef3d71ba0bff539f220019e0d0636e44ccbcff7c99ffb80b637567e453`; analyzer SHA `a9bfb18e7782e361a0d103b610b78417ede4cc3978aac77583a669a015e20def`; replay SHA `383b1395b08b900b7305875c20f1dc88a280fd43bef2d158bae185c0bbdea067`; rendered JSON SHA `2e7386c590337cee8528a55b7fb3825c8c522bf5a0f98533182a6898876a9de0`; rendered Markdown SHA `af776329beb5e6153d3d1519df7277c5b3e20b843337e8dfbf9cc1e27949ffe7`; artifact manifest SHA `0f067f161376ff657f96eb9a044c66e0c43fbc239c391f7868c3f1678c6316bf`. The full assembler was deliberately given only one campaign audit and one readiness manifest and rejected it with exit `1`, “exactly three campaign audits and three readiness manifests are required” (log SHA `c55f020b7877bf1fb8b453c309dcbb45faf0f8436cf9ea5f3f95a1dd916a52b1`). The partial renderer output is diagnostic and does not bypass the completeness gate.

The early baseline metric extraction is retained separately at `/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v7/early-metrics-baseline-v1/early-metrics-v1.json` (SHA-256 `7e4d5f7f368e59c42ec1fd78843d42a9bddc6773ac753f6e0e15ead956694e22`). v6 remains a historical blocked snapshot below and is not mixed with v7. Infrastructure-correction preparation for v8 is authorized, but it is preparation state rather than a new measurement or retry.


## Historical v6 result

The authoritative historical v6 series is frozen at Urdira commit
`5de04b14305bf1399b200b57db70efb888b99436`, Node `v24.18.1`, Luna, and
semantic indexing off. It stopped after two campaign-1 cells because the
Urdira cell failed preflight when the extracted CLI rejected `urdira --version`.
The baseline cell has a failed retained manifest; its `model_invoked=true`
field is not evidence of a real model request because its transcript is empty,
its timing sidecar has one zero-line turn, and host session evidence is absent.

The v6 matrix preserves all 45 expected cell identities: 2 attempted and 43
not started. All 18 readiness identities are present as not started because
readiness was scheduled after the 45 agent cells. The series is not complete,
and no retry or replacement run was added.

| Result set | Expected | Observed | Not started | Status |
|---|---:|---:|---:|---|
| Agent cells | 45 | 2 | 43 | blocked |
| Readiness probes | 18 | 0 | 18 | not started |

The v6 freeze, raw paths, cleanup evidence, hashes, analyzer output, replay,
and rendered partial matrix are recorded in
[`2026-09-15-definitive-agent-benchmark-v6.md`](../evidence/2026-09-15-definitive-agent-benchmark-v6.md).
The external derived output is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v6/derived-v6-blocked-20260915-v3`.
The v1 and v2 derived outputs remain preserved as superseded renderer results.
The v3 report corrects planned-row accounting and its stdout summary: 2
observed/attempted cells, 43 not started, 0 observed readiness probes, and 18
not started. Its JSON SHA is
`0820b6c6a75f9692d6947f3f8efec137662bbd32604ea242283b017e07bfe8e8` and its
Markdown SHA is
`10bfaec018ec878a299ee47f648a32044c6cdf6d94149356bf51779a1f8f2cdf`.
Unavailable metrics remain `null`; P95 is `null`; correctness, coverage,
efficiency, and distributions are not comparable for this incomplete series.

The remainder of this document preserves the earlier v5 blocked snapshot as
historical evidence. It is not merged into the v6 result.

This is the canonical versioned report location for the selected three
repository, five-arm, three-campaign measurement. The authorized v5 series is
blocked after two campaign-1 cells: the baseline cell has a failed retained
manifest, and the Urdira cell returned exit 1 without a retained manifest.
Forty-three cells were not attempted and no readiness probe executed. This
document therefore claims neither a completed 45-run campaign nor completed
18-probe readiness set. See the [self-contained handoff](definitive-agent-benchmark-handoff.md#final-reporting-and-publication).

## Current retained directed observations

These rows are existing observations retained from the cited evidence. They
are useful context for the pending campaign and are not a substitute for its
three independent campaigns. Missing values are `null`, never an inferred
zero.

| Repository / task | Arm | Sample | Runs / passes | Correctness / coverage | Comparable tokens | Readiness | Raw / evidence |
|---|---|---:|---:|---|---:|---:|---|
| Playwright / `affected-tests-deterministic` | Urdira | v72 | 1 / 1 | strict grader; focused validation 2/2 | 569,904 | 4.917 s | `docs/evidence/2026-09-14-agent-context-density.md` |
| Prisma / `wire-name-validation` | Urdira | v69 | 1 / 1 | strict grader; focused validation 260 tests + typecheck | 666,427 | 7.424 s | `docs/evidence/2026-09-13-current-urdira-context-density-benchmark.md` |
| VS Code / `language-provider-registration-idempotence` | Urdira | v86 | 1 / 1 | strict grader; independent validation | 970,632 | 29.536 s | `docs/evidence/2026-09-14-prompt-hook-context-reuse.md` |

The remaining definitive rows are `null` until the corresponding frozen
campaign artifacts exist. Competitor medians must be copied only from
task-matched reports with the same correctness and coverage; they are not
silently substituted from another repository or task.

## Required final table

The published final table has one row per repository, task, arm, and campaign,
with separate summary rows for medians, distributions, intervals, and failures.
It includes:

- runs, passes, grader/correctness, declared coverage and omissions;
- total, input, output, reasoning, and cached tokens; cost, rate card, and
  pricing policy;
- setup, agent, cold structural readiness, warm readiness, TTFQ, and E2E time;
- hook/MCP/shell/tgrep/tool-output/full-context characters and calls;
- continuations consumed/ignored, duplication/density, hydration, and typed
  fallback observations;
- repository/task/arm/sample, model, harness, source/release/worker/launcher
  commits and hashes, and raw artifact manifest paths.

Unavailable fields are `null`, never `0`. Raw transcripts remain outside the
repository; only sanitized derived reports and dated evidence are published.
Efficiency comparisons are emitted only for equal correction and coverage.

## Earlier preflight attempts (separate from authorized v5)

The immutable attempt ledger is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/preflight-attempt-ledger.json`
(`sha256=210a98e91cd89d0a57936cc6f11eb5302d2a9576668efc7085928ea7f7c6ae36`).
Both attempts used Node `v24.18.1`, reported `ready=false` with
`declared_dependencies_missing`, and listed 110 missing dependencies. Their
runner manifests record `model_invoked=false`; their timing sidecars have
empty `turns`, `mcp_calls`, and `command_calls`. The first attempt is retained
under `campaign-1-preflight-failure`; the second is under `campaign-1`.

The first audit has a provenance collision that also blocks acceptance: its
`cell_manifest` path points to the current second-attempt
`campaign-1/cell-manifest.json`, while its declared hash is
`d1d98ebb54361d95a876eefb55bc2f8f1650134c770951059f39807502870e13`, the
hash of the moved first manifest. The current path hashes to
`181ae2436700ea753588215d3be708c58ea903034d1c918c26f6810eeefa881c`.
The first and second campaign-audit hashes are respectively
`a53a6fd89314ceb3a05eb3e71e45e35392ae6858d8d6527648b25b490f01d91d` and
`46dcff6c2c874e0b1c2e16e0a53c1d8eb27ccd8e56017ce99f3a7a71459d38b2`.

### Dependency preparation evidence (separate from campaign attempts)

A retained v3 preparation attempt is a dependency-install failure, not a
runner or model attempt. Its record is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/dependency-worktree-validation-v3.json`
(`sha256=f134f45df6e912541535d869fa560bff946f8ac2eb23f625acc2edfc5ed5ceeb`).
It records `status=blocked`, `model_invoked=false`, and `runner_invoked=false`;
the offline store lacked `@biomejs/biome/-/biome-2.5.8.tgz` and pnpm returned
`ERR_PNPM_NO_OFFLINE_TARBALL`. This is retained as preparation diagnostics and
is not counted among the two campaign-1 preflight failures above.

The later per-worktree validation passed for the three selected repositories.
Its record is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/dependency-worktree-validation-v4.json`
(`sha256=7e1ec668265773ca0142fe0b9965326150e448148deb6fc7bcba5628e6882148`).
It records `status=passed`, `model_invoked=false`, `runner_invoked=false`, no
global cache use, all three worktrees ready with empty missing-dependency and
missing-runtime-artifact lists, and cleanup success with no worktree left
(`3/3`). Independent review found no blockers. This validates dependency
preparation only; it does not undo the immutable no-retry stop on the two
campaign attempts or authorize a new 45-cell/18-probe series.

### Proposed v5 freeze (prepared, not executed)

The current frozen proposal is retained at
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/proposed-series-v5/series-freeze-proposal.json`
(`sha256=9328d888cc30f11799faa305ed33db965e44d882780eb049626f6df9ba47a89e`).
Its reference-verification sidecar is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/proposed-series-v5/proposal-reference-verification.json`
(`sha256=30458467475c0ba85f4b9a75b307acb0ded0824fe366d4ccb204d8ff98b470bf`),
with 68 proposal hash references; the sidecar checks 71 references including
additional gate and retention references, plus six plan manifests. It declares
`proposal-not-executed`, `model_invoked=false`, 45 expected runs, 18 expected
readiness probes, model `gpt-5.6-luna`, Node `v24.18.1`, and
`minimum_free_bytes=53687091200`.

The six v5 manifest references are:

| Campaign | Cell manifest (SHA-256) | Readiness manifest (SHA-256) |
|---:|---|---|
| 1 | `campaign-1/cell-manifest.json` — `db8279aa8c190c617aaf1345ddbf9edc4c6912b914a2ba1ac328f50a06f73de9` | `campaign-1/readiness-manifest.json` — `9fa4155df5a992e30ac286462db780cdeea0a5fc0eb17f591e47a5a9e9458280` |
| 2 | `campaign-2/cell-manifest.json` — `ef00ee3dbfac49b2a80305005618c9bf74349bbe588303b845806e738c90e4cb` | `campaign-2/readiness-manifest.json` — `9c86e9649e5157a0093f36ae3200af02c31e1a91163609e3a192de5ad2390c40` |
| 3 | `campaign-3/cell-manifest.json` — `29aefe62fe7f3b1502fe6bd064b0de3f00bcd7aafe2272223235c9ad48000b71` | `campaign-3/readiness-manifest.json` — `e2cd3451285e22a4f3030ec7cfb1142962c258110c42285d1547a0938d9fd7ad` |

The proposal binds release binding v6
`/Users/Cristian/BenchmarkResults/urdira-final-release-binding-20260915-v6.json`
(`bytes=6042`, `sha256=352e9d7d49760178864ce64c015918e5d80861d167ab0c7b0e92bc30b691b6fc`)
and cleanup checkpoint v7
`/Users/Cristian/BenchmarkResults/urdira-phase0-cleanup-checkpoint-20260915-luna-post-release-v7.json`
(`bytes=2032`, `sha256=93525acf8a1a46e3b84a7bf069cd0484d9163105bd270764f2c2574e4589224d`).
The proposal's retained v5 verify, package, acceptance, and diff-check gate
records each exit `0`. Those are preparation and artifact-integrity results;
the current v8 records are listed in [Gate state](#gate-state). Neither set
adds measured rows to the blocked 45/18 campaign.

### Authorized v5 execution snapshot (blocked, not a completed campaign)

The immutable v5 stop ledger is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/proposed-series-v5/campaign-1/campaign-stop-ledger.json`
(`sha256=4226c3b53ece6137c8c32b3ba18b687d799aa39b1e955b48b019ea37e3db0e24`).
It records `status=blocked`, `no_retry=true`, two started cells out of 15,
and no next cell. The baseline manifest records `model_invoked=true`, which
means the Codex process was launched; its retained transcript is empty, its
timing sidecar exposes one observed turn and zero MCP/command calls, and its
token, cost, correctness, coverage, efficiency, and distribution measurements
are `null`. This does not establish a successful model interaction. The
Urdira cell returned exit 1 without a manifest or preflight-failure artifact;
its `model_invoked` value is therefore `null` and its status is `blocked`.
The remaining 43 cells are `not_attempted`. All 18 readiness probes are
`blocked` before execution, with all readiness measurements `null`.

The complete 45-cell/18-probe state table is preserved externally at
`/Users/Cristian/BenchmarkResults/urdira-renderer-analysis-revision-20260915/partial-plan-table-v2.json`
(`sha256=a9cd99468a8c078f4358a30182a1ab8eeeb584406faea4cd39ecfba77094f4a4`).
The renderer analysis revision and preservation record are
`/Users/Cristian/BenchmarkResults/urdira-renderer-analysis-revision-20260915/analysis-revision-v3.json`
(`sha256=369f5bdd9c42bc7f9997c5d089f93d13778a48ee49463e5a27ba22dbc42441f7`);
this revision is separate from the v5 measurement freeze and raw artifacts.

Offline analysis was run only on the retained empty baseline transcript:

```bash
RAW_TRANSCRIPT="/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/proposed-series-v5/campaign-1/runs/playwright-affected-tests-deterministic-baseline-1/playwright-affected-tests-deterministic-baseline-1.jsonl"
CAMPAIGN_1_AUDIT="/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/proposed-series-v5/campaign-1/campaign-audit.json"
DERIVED="/Users/Cristian/BenchmarkResults/urdira-renderer-analysis-revision-20260915"
node release/benchmarks/analyze-agent-matched.mjs "$RAW_TRANSCRIPT" \
  > "$DERIVED/baseline-token-analysis-v2.json"
node release/benchmarks/render-expanded-agent-report.mjs \
  --audit "$CAMPAIGN_1_AUDIT" \
  --output "$DERIVED/campaign-1-partial-render-v2"
```

The analyzer output SHA is
`32fb4fbc45e969c3969a6da1164972259a835e9f169990d65cf17ecfb2e5f361`.
The partial renderer outputs have SHAs
`8bc8421d949d94084f08d4e6053ae0ebb7d566528a3e1039d980191d90cb5467`
(JSON) and
`92f93c6a48e653b0d3e8165338261813c57548621efe86a57e001664f6997873`
(Markdown). That render observed 2 of 15 cells, 0 successful, 2 failed or
blocked, and 0 of 6 readiness probes; its gate is false. It is explicitly a
partial diagnostic and cannot satisfy the selected-45 renderer requirement of
45 cells and 18 probes.

### Planned 45 agent cells

The table is complete for the frozen 3 campaigns × 3 repository/task pairs ×
5 arms. It is a plan and blocked-result ledger, not evidence that all cells
ran. Two campaign-1 cells were attempted: one failed with a retained
manifest, and one was blocked without a manifest; 43 cells were not attempted.
Unavailable measurements are `null`.

| Campaign | Repository / task | Arm | Model execution | Measurements |
|---:|---|---|---:|---|
| 1 | Playwright / `affected-tests-deterministic` | `baseline` | process launched; failed (`model_invoked=true`) | retained manifest; one timing turn, zero MCP/command calls; token and other unavailable measurements `null` |
| 1 | Playwright / `affected-tests-deterministic` | `urdira-typescript` | blocked; `model_invoked=null` | exit 1 without manifest; all measurements `null` |
| 1 | Playwright / `affected-tests-deterministic` | `tgrep` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | Playwright / `affected-tests-deterministic` | `codegraph` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | Playwright / `affected-tests-deterministic` | `codebase-memory` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | Prisma / `wire-name-validation` | `baseline` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | Prisma / `wire-name-validation` | `urdira-typescript` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | Prisma / `wire-name-validation` | `tgrep` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | Prisma / `wire-name-validation` | `codegraph` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | Prisma / `wire-name-validation` | `codebase-memory` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | VS Code / `language-provider-registration-idempotence` | `baseline` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | VS Code / `language-provider-registration-idempotence` | `urdira-typescript` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | VS Code / `language-provider-registration-idempotence` | `tgrep` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | VS Code / `language-provider-registration-idempotence` | `codegraph` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | VS Code / `language-provider-registration-idempotence` | `codebase-memory` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | Playwright / `affected-tests-deterministic` | `baseline` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | Playwright / `affected-tests-deterministic` | `urdira-typescript` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | Playwright / `affected-tests-deterministic` | `tgrep` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | Playwright / `affected-tests-deterministic` | `codegraph` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | Playwright / `affected-tests-deterministic` | `codebase-memory` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | Prisma / `wire-name-validation` | `baseline` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | Prisma / `wire-name-validation` | `urdira-typescript` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | Prisma / `wire-name-validation` | `tgrep` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | Prisma / `wire-name-validation` | `codegraph` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | Prisma / `wire-name-validation` | `codebase-memory` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | VS Code / `language-provider-registration-idempotence` | `baseline` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | VS Code / `language-provider-registration-idempotence` | `urdira-typescript` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | VS Code / `language-provider-registration-idempotence` | `tgrep` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | VS Code / `language-provider-registration-idempotence` | `codegraph` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | VS Code / `language-provider-registration-idempotence` | `codebase-memory` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | Playwright / `affected-tests-deterministic` | `baseline` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | Playwright / `affected-tests-deterministic` | `urdira-typescript` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | Playwright / `affected-tests-deterministic` | `tgrep` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | Playwright / `affected-tests-deterministic` | `codegraph` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | Playwright / `affected-tests-deterministic` | `codebase-memory` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | Prisma / `wire-name-validation` | `baseline` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | Prisma / `wire-name-validation` | `urdira-typescript` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | Prisma / `wire-name-validation` | `tgrep` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | Prisma / `wire-name-validation` | `codegraph` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | Prisma / `wire-name-validation` | `codebase-memory` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | VS Code / `language-provider-registration-idempotence` | `baseline` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | VS Code / `language-provider-registration-idempotence` | `urdira-typescript` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | VS Code / `language-provider-registration-idempotence` | `tgrep` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | VS Code / `language-provider-registration-idempotence` | `codegraph` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | VS Code / `language-provider-registration-idempotence` | `codebase-memory` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |

### Planned 18 readiness probes

Readiness is a separate 3 campaigns × 3 repositories × cold/warm matrix. No
probe ran and every readiness measurement is absent (`null`).

| Campaign | Repository | Phase | Model execution | Measurement |
|---:|---|---|---:|---|
| 1 | Playwright | `cold` | blocked before probe | all readiness fields `null` |
| 1 | Playwright | `warm` | blocked before probe | all readiness fields `null` |
| 1 | Prisma | `cold` | blocked before probe | all readiness fields `null` |
| 1 | Prisma | `warm` | blocked before probe | all readiness fields `null` |
| 1 | VS Code | `cold` | blocked before probe | all readiness fields `null` |
| 1 | VS Code | `warm` | blocked before probe | all readiness fields `null` |
| 2 | Playwright | `cold` | not attempted | not run; all readiness fields `null` |
| 2 | Playwright | `warm` | not attempted | not run; all readiness fields `null` |
| 2 | Prisma | `cold` | not attempted | not run; all readiness fields `null` |
| 2 | Prisma | `warm` | not attempted | not run; all readiness fields `null` |
| 2 | VS Code | `cold` | not attempted | not run; all readiness fields `null` |
| 2 | VS Code | `warm` | not attempted | not run; all readiness fields `null` |
| 3 | Playwright | `cold` | not attempted | not run; all readiness fields `null` |
| 3 | Playwright | `warm` | not attempted | not run; all readiness fields `null` |
| 3 | Prisma | `cold` | not attempted | not run; all readiness fields `null` |
| 3 | Prisma | `warm` | not attempted | not run; all readiness fields `null` |
| 3 | VS Code | `cold` | not attempted | not run; all readiness fields `null` |
| 3 | VS Code | `warm` | not attempted | not run; all readiness fields `null` |

### Historical offline appendix (separate from the blocked campaign)

The retained 47-run offline replay is not campaign evidence and is not mixed
with the planned table above. It covers the raw association inventory only:
47 rows, 40 runs with matched host token evidence, 7 without host evidence,
34 successful historical outcomes, and 13 failed/blocked outcomes. Its
readiness count is 0 and it cannot establish the definitive 45/18 protocol.
The v6 artifacts are retained at
`/Users/Cristian/BenchmarkResults/urdira-definitive-offline-20260915-metrics-final-v6`:

| Artifact | SHA-256 |
|---|---|
| `replay.json` | `687f7ce902a6d02a09514463d1755c48c6358757db3bb2bd6f9ea6561de13c5c` |
| `analyzer-manifest.json` | `af55eec4d31e49c72cddddf8c61fd31634965ab2aef5e97d053a039785de0131` |
| `audit.json` | `11a33fdf2cda7fcc46a4f859705ad5e6ea2a30b2a04e5bfe4fc20894429e0cf8` |
| `report.json` | `6aeb89b0f9738259ce28e7f224649b07de2579aff7db987524a6092a45836248` |
| `report.md` | `b4dbca9b055e94658ac72d10f37dcc7cf1bb0a06517fee39f0a6e31662b7d577` |
| `artifact-hashes.json` | `7e10a33b056d2868572085c9a75db622767bb24622dfac2f3fa4c5aabca625ab` |

The raw association inventory is
`/Users/Cristian/BenchmarkResults/urdira-context-raw-association-20260915.json`
(`sha256=f71e27fb7c7665efc780f5a11b2a70faadc2d7e26706570ac13a9e5d33661e13`).
The offline replay input and normalized manifest hashes are
`1b1e5abc254d88582cd9e2df852d8158a309e94aec74c74ddb57f382572383bb` and
`2053a46edd1fa0992a36d426088221ffe5a4d5f140fb470c751fb6c3049187c1`.

### Gate state

The current v8 repository, package, acceptance, and diff-check gates all exit
`0`. Their retained records are:

| Gate | Exit SHA-256 | stdout log SHA-256 | stderr log SHA-256 |
|---|---|---|---|
| `pnpm verify` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` | `adcb5d4078644907dac388606828ad9c7af119a140fcd1c1569866c3cf38d96e` | `2293a8217f4f0912132672b3148c0b66a9c14efe7d15e9776a5235490a2ce430` |
| `pnpm package:release` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` | `07efd646a402b386c8b4b54d60a525bd665998e9f26074cb631009b52abaf5bc` | `ea66be16e7e8d99813ccbe29de831ed1a434fa5ed0fe84885d5972795dd56d36` |
| `pnpm release:acceptance` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` | `75e7679588e35d6848a279372662a6f1e0cb78e2aa4a4ea797a1b5eb928b1879` | `62ebcde7919e6bb90c422dad33e37186b824101f687188029ab75bc90f42580e` |
| `git diff --check` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

The files are retained under
`/Users/Cristian/BenchmarkResults/urdira-gates-20260915-v8/` with the names
`{verify,package,acceptance,diff-check}.{exit,stdout.log,stderr.log}`. The
earlier v7 `pnpm verify` record remains historical: it exited `1` because
`tests/expanded-benchmark-smoke.test.ts:181` expected an outdated runner
snippet; its exit SHA is
`4355a46b19d348dc2f57c046f8ef63d4538ebb936000f3c9ee954a27460dd865`.
These v8 gates validate the repository and release artifacts only; they do not
add campaign measurements or change the blocked 45-cell/18-probe status.
The final cleanup checkpoint is
`/Users/Cristian/BenchmarkResults/urdira-phase0-cleanup-checkpoint-20260915-luna-post-gates-v10.json`
(`sha256=6be8cb16b6a5aa6459f99f5fbf81faecd25bbf9be2a74575c24542dad2883eec`):
free bytes were `367785205760` against the `53687091200` threshold, with zero
owned processes and zero residue; three source clones, their dependency roots,
and two extraction roots were deleted. Raw data, the archive, release-binding
metadata, and frozen harness metadata were retained. The v5 proposal and
preflight artifacts are historical evidence, not current readiness; a new
execution would require reprovisioning and a new freeze.
