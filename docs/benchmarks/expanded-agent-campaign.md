# Expanded agent comparison runbook

## Current v8 execution snapshot

The v8 agent phase is complete as an observed three-campaign matrix: 45
repository/task/arm rows, one sample per row. Forty-three rows are task-solved
(target coverage 2/2 with final changes present), 42 have a strict grader pass,
two have strict grader nonpasses, and one infrastructure row has unavailable
outcome evidence. The C3 Urdira VS Code row is task-solved but has a
tool-validation incident; its strict grader remains a nonpass. Target coverage
is 2/2 for 43 rows. The complete
per-row index is embedded in the versioned [definitive results table](definitive-agent-benchmark-results-2026-09-15.md#complete-45-cell-measured-table),
backed by its external JSON source at
`/Users/Cristian/BenchmarkResults/urdira-v8-derived-luna-campaigns-1-3-v1/summary/benchmark-campaigns-1-3-v3.json`
(SHA-256 `622be916d37ab86bcfe79f915b2e40652e5d7c3211e819e094946bdaddb4ce93`),
which retains all measured fields including timings, token fields, costs, hook
totals, served/fallback counts, shell/MCP usage, exits, cleanup, and P95.
The external JSON SHA-256 is
`622be916d37ab86bcfe79f915b2e40652e5d7c3211e819e094946bdaddb4ce93`; the
Markdown SHA-256 is
`030dcf4d92c954df9692655bee34676d0587aee3491d5e093ecb263660cb57a9`.

The append-only reporting-axis correction is
`/Users/Cristian/BenchmarkResults/urdira-v8-derived-luna-campaigns-1-3-v1/summary/benchmark-campaigns-1-3-v4-axis-correction.json`
(SHA-256 `e62bdc06fbf8c5cbb19ba6f1c28ded008e7d1df1f20e540d2bbede0ff94025e3`);
it defines `task_solved`, `grader_pass`, and `tool_validation_incident`
separately while leaving the v3 raw-derived consolidation unchanged.

The v8 source summaries are C1 SHA-256
`ae6fb0eaf943dd9fd9f93587a632c78a09718deaa8ab12513a32fffcc0f4795e`, C2
SHA-256 `54c61dbaaaa6a8c19dbcc3a3da8240edc4e355825fd3756e43a61cadb3ded2fd`,
and C3 SHA-256
`2dfe70e2734a18ad3ddda42082e64f5aafc09e41b2cf3854f79ac0e350dcb11b`.
These are additive offline analyses of retained raw campaign inputs; v7 and
v6 evidence remain separate historical records.

Token accounting keeps input, cached input, output, reasoning, and additive
total separate, using matched cumulative host evidence. The frozen planning
card is input/cached input `$2/M` and output/reasoning `$8/M`. Hook totals use
`observed_tool_usage.urdira_hook_calls`; served and fallback are separate, and
output-bearing hook calls are not used as total invocation counts. Configured
arm and observed tool use remain separate. Missing values are `null`, and
shell overlap is `null` without payload evidence. P95 remains `null`: three
campaign samples do not establish the required per-cell distribution.

Readiness execution is complete with failures: 18 probes are planned, 18 are
persisted as failed/blocked/interrupted, zero succeeded, and zero remain
pending. No readiness probe achieved model invocation. The retained evidence
records the prior cold `EINVAL` socket and dependency failures, the original
Playwright and cancelled VS Code C2 interruptions, the Playwright C3 cold
SIGTERM 143 with its warm probe blocked, and the C3 Prisma and VS Code
cold/warm pairs blocked before model invocation by their recorded package
manager failures. The latest audit is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-v8-resume-after-c1-playwright-v6/readiness-resume-audit.json`
(SHA-256 `fb239152b49a9296cd5980b0aec89802211a295afc668bbd450b9fee3a0110d5`);
the Prisma pair status is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-v8-resume-after-c1-playwright-v5/pair-prisma-3-status.json`
(SHA-256 `e6ae15cafa9b518e8125ec3267c9402c1882ed5911ccdbb3b9fde335e6850855`).

The retained C3 VS Code pair status is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-v8-resume-after-c1-playwright-v6/pair-vscode-3-status.json`
(SHA-256 `cc11527d4faeb9bf6ce0cb10a92b6567b1bd53f63706ca95f32df7a67a2dbb9a`),
with cleanup evidence SHA-256
`90f8f17ffaacbd60f361b0c109e4893df05f459e0953cad63b6fb6a7fd916370`. The
complete readiness composition is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-final-composition-v1.json`
(SHA-256 `5a3be1432ac047084abdd24fbb4491c9219769c19683f4a51af06f5a616898a7`).
The append-only normalized status view is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-final-composition-v2.json`
(SHA-256 `2090d55be0745fe5f056b7058ecb1305ce22a7d34502595f087bf2bd0bb6328b`);
it preserves the v1 outcome counters and reports row-level status as 3
interrupted cold, 6 preflight failures, and 9 warm-blocked rows.
No retry has been counted. The run is not readiness-qualified because no probe
succeeded; readiness measurements remain separate from agent performance.
The readiness measurement objective was not achieved. The post-campaign PATH
fix is not retroactive validation and produced no new readiness evidence.
The final per-campaign renderer outputs and the aggregate-guard rejection are
recorded in the dated [post-campaign rendering evidence](../evidence/2026-09-16-definitive-agent-benchmark-v8-postcampaign.md).

The exact C3 VS Code/Urdira tool-validation incident has strict grader
nonpass `core:unknown_field` at `/request/query`, retained in diagnostic artifact
`/Users/Cristian/BenchmarkResults/urdira-v8-derived-luna-c3-final-15-v3/summary/c3-15-grader-diagnostic-v1.json`
(SHA-256 `ce4db120b97bd4f038abebcd1930d8a0f530c7c9ff49642b76d6600da646e500`).
The row had agent exit 0, outer runner exit 1, grader exit 1, and target
coverage 2/2. Its task outcome is solved; the strict grader nonpass is the
recorded tool-validation incident, not a task-correctness failure. No rm-f or
test-blocked cause is inferred.

### Historical v7 execution snapshot

The retained v7 series is **blocked after two campaign-1 attempts**: one successful baseline measurement and one Urdira infrastructure failure before model invocation. It preserves all 45 frozen cell identities as 2 attempted/observed and 43 not started, and all 18 readiness identities as 0 observed and 18 not started. The user-authorized execution order is 45 agent cells followed by 18 readiness probes; no retry or replacement is counted.

The raw campaign audit is `/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v7/execution-v7/campaign-1/campaign-audit.json` (SHA-256 `51f88c6e83cafd3016d897c0f959ba60a2db35afce8512359ba8899917140678`). The stop ledger SHA is `10cdabce6ab2aa0b4bec1f39cc525ee83ee91da80ba49f6d0b8dcf6ef9d2997d`. The external partial analysis directory is `/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v7-derived-20260915-v1`; its partial audit, analyzer, replay, report JSON/Markdown, assembler-rejection log, and artifact-manifest SHAs are respectively `338740ef3d71ba0bff539f220019e0d0636e44ccbcff7c99ffb80b637567e453`, `a9bfb18e7782e361a0d103b610b78417ede4cc3978aac77583a669a015e20def`, `383b1395b08b900b7305875c20f1dc88a280fd43bef2d158bae185c0bbdea067`, `2e7386c590337cee8528a55b7fb3825c8c522bf5a0f98533182a6898876a9de0`, `af776329beb5e6153d3d1519df7277c5b3e20b843337e8dfbf9cc1e27949ffe7`, `c55f020b7877bf1fb8b453c309dcbb45faf0f8436cf9ea5f3f95a1dd916a52b1`, and `0f067f161376ff657f96eb9a044c66e0c43fbc239c391f7868c3f1678c6316bf`.

The retained baseline has matched host token evidence and measured input 816,937, cached input 753,920, output 8,575, reasoning 3,000, normative total 828,512, and estimated cost 1.726474 USD under the frozen card. Provider total 825,512 is retained as a separate provider field. All absent measurements are `null`; P95 is `null`. The partial renderer is diagnostic only. The production assembler was checked against incomplete input and correctly rejected it; no partial output is presented as a completed selected-45 result. See the dated [v7 evidence](../evidence/2026-09-15-definitive-agent-benchmark-v7.md). The v6 procedure and artifacts below are historical and remain separate. v8 infrastructure-correction preparation is authorized but is not a retry or measurement.


Status: operational procedure, checked against the runner on 2026-09-10. The v6 procedure and artifacts below are historical and separate.

The historical v6 reporting status is recorded in the [dated derived
report](definitive-agent-benchmark-results-2026-09-15.md). The v6 campaign is
blocked after a failed retained baseline and a blocked Urdira cell without a
manifest; 43 cells were not attempted and all 18 readiness probes remained
not started because readiness follows all 45 agent cells. The complete planned
45/18 matrix and retained v6 derived artifacts are recorded in the dated
results report and [v6 evidence](../evidence/2026-09-15-definitive-agent-benchmark-v6.md).

### Historical v6 execution snapshot

The current series uses freeze v6 at commit
`5de04b14305bf1399b200b57db70efb888b99436`, Node `v24.18.1`, Luna, and
semantic indexing off. It attempted exactly two campaign-1 cells and stopped
on the runner's infrastructure/preflight failure policy. The baseline's
`model_invoked=true` is a harness field only: its transcript is empty and its
host-session evidence is absent. The Urdira cell failed before an execution
manifest because the extracted CLI rejected `urdira --version`; its
`model_invoked` value remains `null`.

The derived v6 audit retains all 45 cell identities (2 attempted, 43 not
started) and all 18 readiness identities (0 observed, 18 not started). The
corrected report was rendered from new external outputs under
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v6/derived-v6-blocked-20260915-v3`.
The v1 and v2 outputs remain preserved as superseded renderer results. The v3
JSON SHA is `0820b6c6a75f9692d6947f3f8efec137662bbd32604ea242283b017e07bfe8e8`;
the Markdown SHA is
`10bfaec018ec878a299ee47f648a32044c6cdf6d94149356bf51779a1f8f2cdf`.
All missing values remain `null`, P95 is `null`, and the series does not claim
completion or support efficiency comparison. The v5 snapshot below remains
historical and separate.

### Earlier preflight attempts (separate from authorized v5)

The immutable preflight ledger is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/preflight-attempt-ledger.json`
with SHA-256
`210a98e91cd89d0a57936cc6f11eb5302d2a9576668efc7085928ea7f7c6ae36`.
Two earlier campaign-1 Playwright baseline startup attempts stopped before
Codex/model spawn: both reported `ready=false`, reason
`declared_dependencies_missing`, and 110 missing dependencies. Their timing
sidecars contain empty `turns`, `mcp_calls`, and `command_calls`. The first is retained under
`campaign-1-preflight-failure`; the second is under `campaign-1`.

The first audit has a path/hash collision after the attempt directory move:
`campaign-1-preflight-failure/campaign-audit.json` declares
`cell_manifest_sha256=d1d98ebb54361d95a876eefb55bc2f8f1650134c770951059f39807502870e13`
but its `cell_manifest` path points to the current `campaign-1/cell-manifest.json`,
whose hash is `181ae2436700ea753588215d3be708c58ea903034d1c918c26f6810eeefa881c`.
The first and second audit hashes are
`a53a6fd89314ceb3a05eb3e71e45e35392ae6858d8d6527648b25b490f01d91d` and
`46dcff6c2c874e0b1c2e16e0a53c1d8eb27ccd8e56017ce99f3a7a71459d38b2`.
These earlier preflight attempts are separate from the authorized v5 execution
snapshot below; they do not describe its two cell attempts.

### Authorized v5 execution snapshot

The authoritative stop ledger is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/proposed-series-v5/campaign-1/campaign-stop-ledger.json`
(`sha256=4226c3b53ece6137c8c32b3ba18b687d799aa39b1e955b48b019ea37e3db0e24`).
It records two started cells out of 15 and `no_retry=true`: the baseline has a
failed retained manifest with `model_invoked=true` (Codex process launched,
not proof of successful model interaction), while Urdira returned exit 1
without a manifest, so `model_invoked=null`. Forty-three cells were not
attempted. No readiness probe executed; all 18 readiness rows are blocked
before execution with `null` measurements.

The complete partial state table is
`/Users/Cristian/BenchmarkResults/urdira-renderer-analysis-revision-20260915/partial-plan-table-v2.json`
(`sha256=a9cd99468a8c078f4358a30182a1ab8eeeb584406faea4cd39ecfba77094f4a4`).
The report-only renderer analysis revision is
`/Users/Cristian/BenchmarkResults/urdira-renderer-analysis-revision-20260915/analysis-revision-v3.json`
(`sha256=369f5bdd9c42bc7f9997c5d089f93d13778a48ee49463e5a27ba22dbc42441f7`);
it is separate from the frozen v5 proposal and raw artifacts. The revision
normalizes nested `result.code`/`signal`/`timed_out` and preserves available
stream references while leaving unknown model and metric values `null`.

The offline analyzer and partial renderer were run on retained raw paths only.
The partial render observed 2/15 cells and 0/6 readiness probes, with a false
gate; it is diagnostic output and cannot satisfy the selected-45 requirement
of 45 cells and 18 probes.
The analyzer output is
`/Users/Cristian/BenchmarkResults/urdira-renderer-analysis-revision-20260915/baseline-token-analysis-v2.json`
(`sha256=32fb4fbc45e969c3969a6da1164972259a835e9f169990d65cf17ecfb2e5f361`);
the partial renderer outputs are JSON
(`sha256=8bc8421d949d94084f08d4e6053ae0ebb7d566528a3e1039d980191d90cb5467`)
and Markdown
(`sha256=92f93c6a48e653b0d3e8165338261813c57548621efe86a57e001664f6997873`).

### Dependency preparation records

The retained v3 preparation record is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/dependency-worktree-validation-v3.json`
(`sha256=f134f45df6e912541535d869fa560bff946f8ac2eb23f625acc2edfc5ed5ceeb`).
It is a blocked offline dependency-install attempt with
`model_invoked=false` and `runner_invoked=false`; pnpm reported
`ERR_PNPM_NO_OFFLINE_TARBALL` for `@biomejs/biome/-/biome-2.5.8.tgz`. It is
not a model run, runner run, or one of the two campaign-1 preflight failures.

The subsequent per-worktree validation passed in
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/dependency-worktree-validation-v4.json`
(`sha256=7e1ec668265773ca0142fe0b9965326150e448148deb6fc7bcba5628e6882148`).
It covers exactly `playwright`, `prisma`, and `vscode`: each worktree was
ready with no missing dependency or runtime artifact, and each cleanup removed
the worktree (`3/3`); `global_cache_used=false`, `model_invoked=false`, and
`runner_invoked=false`. Independent review reported no blockers. This is a
preparation gate only. The immutable no-retry stop still blocks a new
45-cell/18-probe series until the user explicitly authorizes it.

The current proposed v5 freeze is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/proposed-series-v5/series-freeze-proposal.json`
(`sha256=9328d888cc30f11799faa305ed33db965e44d882780eb049626f6df9ba47a89e`),
verified by
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/proposed-series-v5/proposal-reference-verification.json`
(`sha256=30458467475c0ba85f4b9a75b307acb0ded0824fe366d4ccb204d8ff98b470bf`).
The proposal carries 68 exact references; the sidecar checks 71 references
including additional gate and retention references, plus six manifests; the proposal is
explicitly `proposal-not-executed`, with `model_invoked=false`, 45 planned
cells, 18 planned readiness probes, model `gpt-5.6-luna`, Node `v24.18.1`, and
`minimum_free_bytes=53687091200`. The six manifest hashes are, by campaign
(cell/readiness order): `1=db8279aa8c190c617aaf1345ddbf9edc4c6912b914a2ba1ac328f50a06f73de9 /
9fa4155df5a992e30ac286462db780cdeea0a5fc0eb17f591e47a5a9e9458280`,
`2=ef00ee3dbfac49b2a80305005618c9bf74349bbe588303b845806e738c90e4cb /
9c86e9649e5157a0093f36ae3200af02c31e1a91163609e3a192de5ad2390c40`, and
`3=29aefe62fe7f3b1502fe6bd064b0de3f00bcd7aafe2272223235c9ad48000b71 /
e2cd3451285e22a4f3030ec7cfb1142962c258110c42285d1547a0938d9fd7ad`.
It binds release binding v6
(`/Users/Cristian/BenchmarkResults/urdira-final-release-binding-20260915-v6.json`,
`sha256=352e9d7d49760178864ce64c015918e5d80861d167ab0c7b0e92bc30b691b6fc`)
and cleanup checkpoint v7
(`/Users/Cristian/BenchmarkResults/urdira-phase0-cleanup-checkpoint-20260915-luna-post-release-v7.json`,
`sha256=93525acf8a1a46e3b84a7bf069cd0484d9163105bd270764f2c2574e4589224d`).
The retained v8 verify, package, acceptance, and diff-check records all exit
`0`. These records predate the post-campaign PATH fix and remain historical;
their retained files are under
`/Users/Cristian/BenchmarkResults/urdira-gates-20260915-v8/`:

| Gate | Exit SHA-256 | stdout log SHA-256 | stderr log SHA-256 |
|---|---|---|---|
| `pnpm verify` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` | `adcb5d4078644907dac388606828ad9c7af119a140fcd1c1569866c3cf38d96e` | `2293a8217f4f0912132672b3148c0b66a9c14efe7d15e9776a5235490a2ce430` |
| `pnpm package:release` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` | `07efd646a402b386c8b4b54d60a525bd665998e9f26074cb631009b52abaf5bc` | `ea66be16e7e8d99813ccbe29de831ed1a434fa5ed0fe84885d5972795dd56d36` |
| `pnpm release:acceptance` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` | `75e7679588e35d6848a279372662a6f1e0cb78e2aa4a4ea797a1b5eb928b1879` | `62ebcde7919e6bb90c422dad33e37186b824101f687188029ab75bc90f42580e` |
| `git diff --check` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

The earlier v7 `pnpm verify` record remains historical: it exited `1` because
`tests/expanded-benchmark-smoke.test.ts:181` expected an outdated runner
snippet; its exit SHA is
`4355a46b19d348dc2f57c046f8ef63d4538ebb936000f3c9ee954a27460dd865`.
These historical v8 gate records predate the post-campaign PATH fix. They
validate repository and release artifacts only and add no benchmark
measurements. The v8 matrix is closed with retained failures; readiness remains
unqualified, and no current gate result is claimed here.
The current post-campaign PATH-fix gate record is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/runner-path-fix-v2/gates-final-manifest-v2.json`
(SHA-256 `b9d170bed887bf06b2522a8b956a9434fb65d9d1909734052cab31af17cbd9ed`).
The gate run recorded repository HEAD
`b05bf226a78d5290807c92c21874d5d858b69c7b` with the PATH-fix working-tree
changes present before commit; a later commit must retain this evidence
separately.
Its `verify-v2.log` passed with 90.06% total coverage and 100% critical branch
coverage (SHA-256 `67143321d7e22fe2a9987272066d7cc7185699cb65d6df89950236a62b6a00cf`);
`package-release-v1.log` passed (SHA-256
`9a7b52db801bd734b6c4f4bf0d1e5fefdfe945d99d8f21800821fe0a53098665`),
`release-acceptance-v1.log` passed (SHA-256
`51e6b3d4489cdf093fdcea4ea60f92563204a73aa9ec8e1b34bb0918a5e2217a`), and
`diff-check-v1.log` passed (SHA-256
`53da44f38c61ac33d12c2f6799955f61db476c8aa34f89e02014d056e19db329`).
These are repository and release checks only; they add no benchmark or
readiness measurements and do not retroactively validate readiness.
The post-gate cleanup chain is recorded by `global-cleanup-v1.json` (SHA-256
`b324a69d173d557d42e644acb8d323303e94a99cd864fcfa1c8689d5cd7aa74c`),
`global-cleanup-v2.json` (SHA-256
`7761773e8cd776fc3fa95b9a87f73163f925f62747ad2cb1e552f2172ce86bae`), and
`global-cleanup-v3.json` (SHA-256
`e6d0cccd6df033e358277ac1492a7acbf0e1472400a2bc94d4d221771917bf97`), with
zero active processes after v3 and 56,735 bytes of declared temporary files
removed. The retained pre-gate, post-package, and post-acceptance archives
are respectively 183,787,326 bytes (SHA-256
`1b4fc4f064962206f1556242e946b53390aba08edf86232e646f3a296e4a4dd6`),
183,788,002 bytes (SHA-256
`d6e0e92f827ed6973516fa338b255c9d30b9269f43b2791e2a3fdc14a8bdb5ef`), and
183,788,113 bytes (SHA-256
`4f30c892880154a903a1c4685803f588b781bcabfe2faf49953e37cf319fef60`).
The final cleanup checkpoint is
`/Users/Cristian/BenchmarkResults/urdira-phase0-cleanup-checkpoint-20260915-luna-post-gates-v10.json`
(`sha256=6be8cb16b6a5aa6459f99f5fbf81faecd25bbf9be2a74575c24542dad2883eec`):
free bytes were `367785205760` against the `53687091200` threshold, with zero
owned processes and zero residue; three source clones, their dependency roots,
and two extraction roots were deleted. Raw data, the archive, release-binding
metadata, and frozen harness metadata were retained. The v5 proposal and
preflight artifacts are historical evidence, not current readiness; a new
execution would require reprovisioning and a new freeze.

## Authority and scope

[Decision 08](../decisions/08-performance-reliability-evaluation.md) governs
measurement and acceptance. This runbook describes the external-tool comparison,
not the separate 60-run source-first campaign or native indexing qualification.
The [corpus](../../release/benchmarks/expanded-typescript-agent-benchmark.json)
owns task prompts, repository commits, model, and sampling plan. Runtime behavior
comes from the [driver](../../release/benchmarks/run-expanded-agent-benchmark.mjs),
[cell runner](../../release/benchmarks/expanded-agent-benchmark-runner.mjs), and
[grader](../../release/benchmarks/expanded-agent-benchmark-grader.mjs).
This document introduces no public API or architecture changes.

For a new session executing the current selected three-repository definitive
measurement, use the [self-contained benchmark handoff](definitive-agent-benchmark-handoff.md).
It adds the exact 45-run independent-campaign protocol and does not replace
the general contracts or historical evidence below.
Its mandatory cleanup checkpoint applies after each complete cell or before
transfer to another worker; during the three internal turns of a cell its
checkout, index, and data root remain active. A failed cell cannot bypass
cleanup or unblock the next execution while registered residues remain.

## Current optimization and verification decision

The current objective is for Urdira to provide the main repository context and
reduce duplicated or premature reading while preserving every legitimate piece
of information requested by the task. Shell reading is not a failure by
itself: it may verify changed/generated state or supply a concrete missing
detail. The failure signal is avoidable repetition, unjustified broad native
discovery, or an Urdira response that does not let the agent begin the task.
The agent chooses `response_budget` from the task's needs. A budget is a
response-shaping control, not a campaign success criterion: this procedure
does not impose an absolute character, token, or quota threshold. A smaller
response is useful only when it remains correct, complete for its page, and
adequately hydrated for the stated request.

Correctness is evaluated first. Results must have deterministic membership,
ordering, provenance, hydration declarations, deduplicated unique records,
and explicit completeness and pagination state. A page may be incomplete only
when it exposes a continuation that can be followed exactly. The result
ordering should maximize first-page usefulness and diversity across the
requested facets (for example definitions, callers, and tests), while keeping
the canonical ordering and cursor contract intact. Hydration is explicit:
source snippets, evidence, and registry data count only when the response
declares them and their budgets permit them.

After equal correctness and coverage are established, compare relative
time-to-first-useful-result, total time, input/output tokens, estimated cost,
context characters, and fallback behavior. Record, per task and arm, the
usefulness and duplication observations, fallback reason, number of turns,
MCP calls by operation, direct-operation/recipe/pipeline counts, page and
cursor outcomes, hydration/evidence/registry components, and host readiness
and process measurements. These metrics explain behavior; none is an
absolute pass threshold by itself.

For each run, record which transport supplied the first repository context,
configured-tool and shell calls/characters before the first edit, and the
configured tool's relative share of that observed pre-edit context. Classify
later shell source reads as before/after the first MCP result and as having or
not having exact nonblank line overlap with source already returned through
MCP. These are observational proxies: character share is not semantic
usefulness, overlap is not proof of waste, and a non-overlapping read is not
automatically justified. Manual transcript evidence remains authoritative for
why a read contributed to the task.

Tool attribution must keep direct MCP output, Urdira hook-served output, hook
fallback, shell output, and total context delivered to the agent separate. A
native command recorded by the Urdira hook audit counts once as effective
Urdira use whether the bridge serves it or correctly falls back. The stable
`[urdira hook served]` marker identifies model-visible hook output; the
content-free audit sidecar identifies all interceptions and their typed
decisions. Hook failures and trust notices do not count, and a denied native
command does not become an executed shell read. For `tgrep`, report
the direct tgrep call/output separately from shell commands that invoke or
inspect tgrep, and report their sum only as a derived total. The same rule
applies to Urdira and other MCP tools. A command classified as shell must not
be counted as a direct tool call merely because it ran a tool binary. This
prevents tgrep-vs-Urdira comparisons from confusing tool output with command
or transcript context. Historical transcripts without an audit sidecar or
unambiguous served marker remain unknown rather than being inferred from a
generic hook message.
The grader remains a task-contract and integration
check; it does not measure semantic quality, prove tool causality, or replace
manual attribution review.

The post-v14 source state is intentionally unbenchmarked. The retained v13
and v14 artifacts are evidence for the continuation and discovery decisions,
not new baseline samples. V13 passed with structural semantic-off settings;
v14 remains a retained failure. The indexed bounded caller-to-covers
expansion is retained because it improves the tests facet through existing
graph indexes with explicit limits and exact deduplication. The temporary
`pending_continuations` label/action is removed because it added response
pressure without changing the canonical page/completeness contract. The
canonical signal is `page_coverage` plus `more` and a literal continuation
request. No result from these retained attempts should be rewritten or
replaced by a rerun.

### Offline replay and fresh validation protocol

When tuning measurement or attribution, replay the retained raw transcripts,
timing sidecars, manifests, host logs, and hashes offline. Replay must not
start an agent, mutate a workspace, alter a transcript, or launch a competitor
run. Use it to validate parsing, direct-tool versus shell attribution,
continuation extraction, usefulness/duplication annotations, and report
rendering. Keep the original raw files and retain failures in the derived
report.

Only after focused tests and the complete `CI=true pnpm verify` gate pass may
the root coordinator run a fresh validation. That validation is Urdira-only,
one sample per size tier: one small repository, one medium repository, and one
large repository, using the current production install path and the frozen
structural semantic-off environment. Luna agents drive the runs; the root
agent coordinates worktrees, output retention, and review. Do not rerun
competitors during this validation. Preserve each raw transcript, timing
sidecar, manifest, host log, process sample, and hash, and record the exact
commit and built worker used. A fresh sample is accepted by equal task
correctness/coverage first, then compared with the retained observations on
relative time, tokens, cost, context, usefulness, duplication, and fallback
reason. There is no absolute time, token, character, or tool-count success
threshold.

## Frozen matrix

- Arms: `baseline`, `urdira-typescript`, `codebase-memory`, `codegraph`, `tgrep`.
- Repositories: TypeScript, Playwright, Prisma, VS Code, at the exact SHA in the corpus.
- Two tasks per repository: `quick-local` and `deep-cross-file`.
- Both tasks use `staged-incremental`: three instructions in one resumable session.
- Eight tasks times five arms = 40 cells. One sample = 40 executions;
  the corpus plan of three samples per cell = 120 executions, excluding smoke.
- Historical model: `gpt-5.6-luna`; Node must be at least `24.18.1`.
  Reconfirm availability and freeze exact executable versions before a run.

The driver always passes `--phase warm`: Urdira finishes initial structural
readiness before the agent starts. Each sample still has fresh indexing state;
setup is measured separately and included in total time. This is not a
cold/warm matrix or an OS page-cache eviction experiment.

## Prepare before spending benchmark time

1. Confirm the driver's automatic environment manifest: Urdira commit/status
   and diff hash; corpus, driver, runner, grader, reporter and built MCP hashes;
   exact Node, agent and comparator executable paths/hashes; host
   OS/architecture/CPU/RAM; start-time free memory, load average and output-disk
   space; effective benchmark runtime settings; and intended output directory.
   The environment manifest also fingerprints the indexing worker and, when
   present, the native addon, native syntax worker, Urdira app/daemon/MCP
   distributions, and JavaScript/TypeScript plugin distribution. It records
   declared native/plugin build identities when package metadata or source
   declarations expose them; unavailable artifacts remain explicit `null`.
   Add filesystem and package-manager details manually when the host cannot
   expose them directly. Preserve unrelated working-tree changes. Use a
   reproducible built checkout.
2. Follow [AGENTS.md](../../AGENTS.md) for dependencies, native builds, and the
   complete `pnpm verify` gate. Confirm `apps/urdira/dist/index.js`,
   `packages/cli/dist/agent-integration.js`, and native artifacts match the
   recorded checkout. The global Urdira install is not used. The Urdira arm
   invokes the production `installAgent("codex", { dry_run: false, confirm: true,
   home: <isolated-root> })` path, so its Codex hooks and optional explorer are
   the same artifacts as `urdira agent install --client codex`. The runner sets
   `HOME` and `CODEX_HOME` to that disposable root, removes
   `--ignore-user-config` for this arm so those installed artifacts are loaded,
   and passes `--dangerously-bypass-hook-trust` because the runner has just
   generated the managed hook in that disposable root. Authentication remains
   available through a temporary `auth.json` symlink when the user's Codex
   auth file exists; no credential bytes are copied or recorded. The runner
   deletes the root after the cell (including failure cleanup). The MCP
   server remains an explicit per-process Codex configuration because the
   production Codex installer currently owns hooks and the explorer file;
   this is recorded as `installed-integration` with
   `mcp: runner-configured-per-process`, rather than being reported as MCP-only.
   The runner also places a disposable `bin/urdira` shim first on the Codex
   `PATH`. It delegates to the frozen `apps/urdira/dist/cli.js` through the
   frozen Node executable, exports the cell's `URDIRA_DATA_ROOT` and indexing
   worker path, and is checked with `urdira --version` before the agent starts.
   The manifest records the CLI version, executable path, and SHA-256 of the
   measured CLI artifact. The hook command remains the literal installed
   `urdira agent hook`; if the measured CLI is unavailable the shim exits
   safely instead of falling through to an unrelated host executable.
   The installed Codex `UserPromptSubmit` hook performs one scoped
   `core:build_context` request before each model turn when the structural
   snapshot is current. Count each interception as Urdira use, retain served
   and fallback outcomes in the hook audit, and include the injected
   characters in model context. A served prompt hook should let the agent
   begin from the injected source without repeating workspace bootstrap or
   broad context discovery; later Urdira calls remain valid for an identified
   gap, a continuation, or post-edit freshness.
3. Prepare four repository clones under one dedicated root, named `typescript`,
   `playwright`, `prisma`, and `vscode`; ensure each corpus SHA exists locally.
   Record test dependencies available in the actual fresh worktrees. The agent
   must not install dependencies. Missing dependencies remain explicit blockers.
4. Supply executable paths explicitly; the driver's historical default paths
   are not portable. Check agent authentication and comparator availability
   without launching a coding task. Do not print credentials into evidence.
5. Freeze the Urdira mode and environment. The driver disables semantic indexing
   and materialization, and the runtime does not create a semantic sidecar;
   the cell runner forces analysis workers, analysis pool max, and structural
   concurrency to one. It enables timing logs. Other environment variables are
   inherited. Record v4/residual/lexical settings and overrides explicitly.
   August v3 results do not measure the current v4 default.
   The expanded Urdira MCP entrypoint passes only the isolated `data_root`.
   It inherits the production three-tool set, descriptions, and
   `MCP_SERVER_INSTRUCTIONS`; it passes no `tool_names`, `compact`, or custom
   `instructions`. The runner may add only ephemeral paths and timeout
   settings needed for isolation and measurement.
6. Allocate unique, empty output and worktree roots outside the repository.
   The runner resets and cleans its assigned worktree; never point it at a
   working checkout. The driver also removes cell worktrees and data roots.
7. Resolve or explicitly record the limitations below before treating the
   campaign as ready. Preparation alone is not a passing smoke.

## Commands and gates

These are command templates, not commands executed by this document. Set all
paths to verified absolute locations. Keep the same variables, build, corpus,
and environment for smoke and measurement. Do not reuse an output directory.

```bash
BENCH_NODE=/absolute/path/to/node
BENCH_CODEX=/absolute/path/to/codex
BENCH_MEMORY=/absolute/path/to/codebase-memory-mcp
BENCH_GRAPH=/absolute/path/to/codegraph
BENCH_TGREP=/absolute/path/to/tgrep
BENCH_REPOS=/absolute/path/to/benchmark-repositories
BENCH_OUT=/absolute/path/to/new-campaign-directory
```

Run from the Urdira checkout. The driver has no safe `--help` or `--dry-run`
mode; unknown flags are not validated. In particular, it has no `--model`
override: it reads the corpus model. A model change requires a separately
recorded corpus revision and fresh runs for all arms.

First run the required sequential Urdira smoke for the selected repositories.
The full-corpus example below covers all eight tasks:

```bash
"$BENCH_NODE" release/benchmarks/run-expanded-agent-benchmark.mjs \
  --samples 1 --arms urdira-typescript \
  --repositories typescript,playwright,prisma,vscode \
  --repositories-root "$BENCH_REPOS" --output-dir "$BENCH_OUT/smoke-urdira" \
  --node "$BENCH_NODE" --codex "$BENCH_CODEX" \
  --codebase-memory "$BENCH_MEMORY" --codegraph "$BENCH_GRAPH" \
  --tgrep "$BENCH_TGREP"
```

For every arm that will run with more than one sample, create a separate smoke
audit for that arm using the same selected repositories. Require one successful,
distinct execution per selected repository/task, zero audit failures, and manual
transcript/cleanup review. Urdira smoke additionally proves structural
readiness under `URDIRA_SEMANTIC_INDEX=0`; its MCP entrypoint must inherit the
production presentation described above. A broader successful smoke is
accepted when it contains exactly one success for each selected task and the
entry's arm matches the arm being gated. Missing tasks, duplicate selected
successes, failed audits, and another repository's smoke cannot qualify the
requested scope. The driver accepts only the smoke audits named for selected
arms; if an arm's audit is missing or fails, that arm is blocked before cell
execution while other eligible arms may proceed.

Create the four comparator smoke audits with the same selected repository list,
changing only `--arms` and the output directory. This example records the
remaining arms in separate audits:

```bash
for BENCH_ARM in baseline codebase-memory codegraph tgrep; do
  "$BENCH_NODE" release/benchmarks/run-expanded-agent-benchmark.mjs \
    --samples 1 --arms "$BENCH_ARM" \
    --repositories typescript,playwright,prisma,vscode \
    --repositories-root "$BENCH_REPOS" --output-dir "$BENCH_OUT/smoke-$BENCH_ARM" \
    --node "$BENCH_NODE" --codex "$BENCH_CODEX" \
    --codebase-memory "$BENCH_MEMORY" --codegraph "$BENCH_GRAPH" \
    --tgrep "$BENCH_TGREP"
done
```

Use the same `--repositories` selection in both commands:

| Scope | Selection | Smoke runs per arm | Five-arm runs, 1 / 3 samples |
|---|---|---:|---:|
| Small | `--repositories playwright` | 2 | 10 / 30 |
| Medium | `--repositories prisma` | 2 | 10 / 30 |
| Large | `--repositories vscode` (or `typescript`) | 2 | 10 / 30 |
| Small + medium + large | `--repositories playwright,prisma,vscode` | 6 | 30 / 90 |
| Full corpus | `--repositories typescript,playwright,prisma,vscode` | 8 | 40 / 120 |

For example, to measure only Prisma, replace the repository list in every
smoke and measurement command with `--repositories prisma`; each selected arm
then needs its own two-task smoke, and no TypeScript, Playwright, or VS Code
smoke is required. The required tasks are derived from the selected corpus
entries, not hardcoded to two tasks or eight total.

After each selected arm's smoke and attribution review passes, the planned full
comparison is:

```bash
"$BENCH_NODE" release/benchmarks/run-expanded-agent-benchmark.mjs \
  --samples 3 \
  --smoke-audits "baseline=$BENCH_OUT/smoke-baseline/audit.json,urdira-typescript=$BENCH_OUT/smoke-urdira/audit.json,codebase-memory=$BENCH_OUT/smoke-codebase-memory/audit.json,codegraph=$BENCH_OUT/smoke-codegraph/audit.json,tgrep=$BENCH_OUT/smoke-tgrep/audit.json" \
  --arms baseline,urdira-typescript,codebase-memory,codegraph,tgrep \
  --repositories typescript,playwright,prisma,vscode \
  --repositories-root "$BENCH_REPOS" --output-dir "$BENCH_OUT/full" \
  --node "$BENCH_NODE" --codex "$BENCH_CODEX" \
  --codebase-memory "$BENCH_MEMORY" --codegraph "$BENCH_GRAPH" \
  --tgrep "$BENCH_TGREP"
```

A separately declared one-sample comparison uses `--samples 1` and contains
40 runs. Although the driver does not enforce its smoke prerequisite for one
sample, the
operator must still satisfy Decision 08. Smoke runs are not silently counted
as measurement samples. The driver rotates arm order by sample, repository,
and task, and executes cells sequentially.

## Cell protocol and audit

1. Work in the frozen checkout and choose the discovery and editing workflow a
   normal coding agent would choose from the tools configured for that arm.
2. Finish implementation, wiring, and focused tests, recording the tools and
   recovery paths the agent actually used. No commits.
3. Review the diff, attempt narrow checks if dependencies exist, and report
   exact checks and limitations. No runner prompt directs a tool choice or a
   post-edit rediscovery step.

Urdira readiness and inter-turn waits require the current complete structural
frontier. Semantic work is excluded entirely. Each arm configures its
integration in the coding agent environment; the agent may select that
integration, another available integration, or ordinary repository tools as
its normal workflow dictates. The runner supplies no discovery policy.

Urdira composition is measured as an agent choice. Pipelines, registered
recipes, direct operations, and `urdira_context` are all valid according to the
task and the public MCP contract. The grader records pipeline/recipe counts,
direct-operation calls, valid dependencies, and malformed composition attempts
as observational metrics; no composition choice is a correctness gate.

Audit the actual transcript, not just the final answer: natural tool selection,
MCP/non-MCP use, discovery before and after edits when present, source
freshness, fallback, unexpected tool failures, valid selector-ambiguity
recovery, and test command outcomes. Review all arms; the grader checks the
common task contract: changed paths, required patterns, test-file changes, diff
whitespace, and real integration failures. It does not require use of Urdira or
any other configured tool, establish semantic correctness, or execute a
repository test suite. Report “grader passed” and
“tests passed” separately.

The current driver writes `audit.json` after each cell but does not pause for
manual review or stop automatically on a failed cell. It has no resume or
single-task selection option. If strict review-before-next-cell is required,
add and verify that orchestration before launch; do not claim the existing
batch command provides it. Retain failed attempts and their causes. Do not
rerun until green and silently replace failures. A fix changes the measured
build and requires a new identified campaign/smoke, preserving prior evidence.

## Reports and retention

The final reporting phase is mandatory: analyze the original retained
artifacts, render the derived report, update the dated evidence and current
state, and show the table to the user before declaring the campaign complete.
Use `analyze-agent-matched.mjs` and `render-expanded-agent-report.mjs` as
described in the [definitive handoff](definitive-agent-benchmark-handoff.md).
The report covers each `repo/task/arm`, uses `null, never 0` for unavailable
metrics, separates medians/distributions/intervals and failures, and compares
efficiency only for equal correction and coverage.

Generate derived reports while transcripts still exist:

```bash
"$BENCH_NODE" release/benchmarks/render-expanded-agent-report.mjs \
  --audit "$BENCH_OUT/full/audit.json" --output "$BENCH_OUT/report"
```

For the current definitive 45-cell audit, all five arms are fresh and the
comparison report must contain no rows. The renderer rejects comparator rows
unless the audit explicitly opts into historical reuse and rejects any
repo/task/arm overlap with fresh rows. A historical comparison cannot silently
fill missing cells or mix unlike campaigns.

Retain each manifest, transcript, host log, audit, environment manifest, raw
hashes, manual review, and generated JSON/Markdown outside the public tree.
Publish sanitized derived evidence and a dated note under `docs/evidence/`.
Inspect generated reports for paths/secrets; do not assume sanitization is complete.

Report per task/arm/sample: grader result, declared target coverage and
omissions, discovery attribution, actual test attempts/passes/failures/unknown,
setup, agent time
(including inter-turn waits), setup + agent total, tokens, estimated cost/rate
card, repository-read calls, returned context characters, unattributed-context
proxy, MCP counts/errors, structural readiness, comparable cell process-tree
RSS/CPU, Urdira readiness RSS, composition metrics (pipeline/recipe/direct
operation counts, dependency validity, and malformed composition reasons), and
storage/copy telemetry where present.
Driver audit elapsed time also includes orchestration/cleanup and is not the
same metric as setup + agent time. Missing metrics are unavailable, not zero;
review v4 catalog, lexical, structural, Rust sidecar, CAS, and semantic sizes
separately. Semantic size must remain zero and semantic-sidecar creation false.
Compare matched tasks and show every failure.

Legacy discovery output is split into `tool_output_characters`,
`shell_output_characters`, and `tgrep_output_characters` per run. These fields
and `repository_context_characters` exclude status, tests, builds, Git review,
and host instruction reads unless classified as discovery; they are not the
total context observed by the model. The report
also retains lexical `target_attributed_characters` and
`target_unattributed_characters` proxies, plus protocol-identifiable snippets,
hydration, evidence, and registry component counts/characters. Component
values are `null` when the protocol does not identify that payload; unavailable
method values are never reported as zero. `discovery_adoption` records whether
MCP preceded shell discovery, whether shell followed MCP, and whether the run
had zero observed MCP discovery calls. These are observational metrics and do
not classify arbitrary shell text as a typed protocol component.

`completed_tool_output` separately counts text from all completed MCP and shell
items, including status, tests, builds, Git review and host instruction reads.
Each transport reports calls, missing-output calls, characters and the known
subtotal. Tgrep remains a shell subset and is never added to the combined total.
Count string UTF-16 code units, without JSON envelopes or synthetic separators
between MCP text blocks. Prefer aggregated shell output over aliases; otherwise
use the recorded output or stdout/stderr. Explicit empty output counts as zero;
missing or malformed output makes that transport's total and the combined total
`null`. A transport with no calls is unavailable (`null`), while known subtotals
are lower bounds. No completed tool items means no observed total. Structured-only
MCP output does not establish model-visible text. System instructions, schemas,
prompts, images and host context management are outside this accounting:
`full_model_context_characters` remains `null`. Retain any separately reported
host token usage in its own unit; never infer tokens from these character counts.

The cell runner writes a separate `<run-id>.timing.json` sidecar while each of
the three Codex turns is running. It timestamps complete JSONL lines using a
monotonic clock and leaves the original transcript byte-for-byte unchanged.
For `mcp_tool_call` and `command_execution` items it pairs `item.started` and
`item.completed` by `item.id`, publishes end-to-end durations, and records
`paired`, `completed_without_start`, or `started_without_completion` explicitly.
The sidecar includes per-tool MCP aggregates and command timing where present;
the renderer carries these records into JSON and a timing table in Markdown.
Each Codex process has an independent clock origin, so these values compare
durations, not absolute event order between turns. Missing or malformed lines
remain visible in the sidecar and do not alter grading.

For a diagnostic pass, set `URDIRA_V4_DEBUG_SEMANTIC_PERF=1` in the daemon or
worker environment. The production indexing-core transport forwards this
variable only when its value is exactly `1`; otherwise the child receives no
semantic-perf flag. The worker then emits one stable JSON record to stderr,
prefixed with `v4 semantic_perf`, containing aggregate microsecond/count
buckets for import/re-export/heritage, call/reference, typeflow, union/member,
and sibling-conformance work, plus typeflow alias-build timing and the ten
owners with the greatest semantic wall time. Each owner includes its path,
observed site count, candidates, pending sites, and published rows. The timing
is the complete per-owner hybrid call, including source retrieval; it is a
diagnostic attribution and must not replace the campaign's end-to-end timing.
The normal path does not read this environment, create timers, or serialize
telemetry, and `OwnerSemantics` remains unchanged. Alias telemetry covers the
indexed alias-target build as one aggregate; it does not provide a recursive
per-hop profile. The diagnostic is opt-in, stderr-only, and should be enabled
for a separately identified profiling pass rather than mixed into comparison
samples.

When timing or semantic profiling is enabled, the worker emits a preceding
`v4 startup_attestation` JSON line with its PID, executable path, and the
effective `semantic_perf_enabled` boolean. The profiled cell runner waits for
that line after host readiness and fails closed if it is absent or says false;
therefore a profiling result cannot silently become an uninstrumented result.

The renderer defaults to a planning card of USD 2/M input, 8/M output and
8/M reasoning tokens; freeze and disclose the accounting convention, including
cached/reasoning token treatment. These estimates are not provider invoices.
Every definitive manifest must carry `counter_mode: "cumulative"` or
`counter_mode: "per_turn"`, backed by the harness/provider event contract.
Repeated monotonic counters alone do not prove cumulative semantics. When the
mode is absent, multi-turn token totals and cost are `null`; available
single-turn counters remain separate observations. The normative comparable
total is `input_tokens + output_tokens + reasoning_output_tokens`, with
`cached_input_tokens` reported separately and never subtracted from the
reported input total. Cost is `null` unless input, cached input, output and
reasoning counters are all available; use the explicit cached-input rate card.

The Codex host-session binding is the accepted evidence shape for this field.
The runner retains the session JSONL for every arm and calls
`deriveHostTokenEvidence` from `release/benchmarks/benchmark-token-evidence.mjs`
before cleanup. The helper reads only structural records and emits hashes and
line references, never message contents. It groups unique
`token_usage_record` events by ordered `root_turn_id`, keeps the final
`turn_token_usage` and `thread_token_usage` for each root turn, and checks the
transcript `turn.completed` records against exactly one labeled sequence. A
`turn_token_usage` match proves `counter_mode: "per_turn"`; a
`thread_token_usage` match proves `counter_mode: "cumulative"`. The returned
evidence records `session_path`, `session_sha256`, `cli_version`, ordered root
turn IDs, transcript and host line references, and token-count event counts.
`event_msg` `token_count` records are corroborating observations and must not
be added to `token_usage_record` values. Duplicate response IDs are counted
once. CLI version alone, monotonicity, or a partial host session cannot set the
mode. Missing host evidence, a transcript/host mismatch, conflicting duplicate
records, or an unverified association leaves `counter_mode`, multi-turn totals,
and cost `null`.

The current retained historical set demonstrates why this binding is required:
Codex CLI `0.153.4` transcripts match `turn_token_usage`, while
`0.154.0-alpha.6.2` transcripts match `thread_token_usage`. This observation
does not authorize using a version as a proxy in a future campaign; every cell
must retain and match its own host evidence.
Three samples in one campaign are not three independent campaigns. The driver's
`--independent-campaigns` flag only writes metadata; never set it to three
without three genuinely independent, retained campaigns. Three observations
provide median/range only. P95 additionally requires explicit audit evidence
for each sufficient group; an exact three-observation group always retains
`p95: null`. Missing fields remain `null`, never zero.

The definitive readiness sidecar is separate from agent cells. The audit may
carry `readiness_probes`, one row per campaign/repository/phase, with
`phase: "cold" | "warm"`, `probe_id`, `setup_elapsed_ms`,
`structural_readiness_ms`, `time_to_first_query_ms`, `snapshot_identity`,
`page_completeness`, semantic-off booleans, `passed`, and `failure`. Preserve
the host's monotonic timestamps (`data_root_created`, `source_ready`,
`structural_ready`, `validated_first_query`, `first_query_complete`) and any
storage/process/publication/freshness measurements. The current selected
protocol expects 3 campaigns x 3 repositories x 2 phases = 18 probes; the
renderer reports missing probes as an incomplete readiness gate and does not
fold them into task summaries.

Verify cleanup for each owned worktree, data root, comparator project and
process; investigate false cleanup flags. Preserve transcripts/reports before
removing temporary artifacts. The current driver deletes worktrees immediately,
so preserving diffs or additional untracked tests requires a verified capture
step before cleanup. No unrelated project or daemon should be removed.

Before a fresh sample using native test dependencies, prepare the declared
dependency build and execute an unchanged focused baseline test. Merely finding
the package directory does not prove its native addon can load. Select the test
file at the harness level, not only a test-name filter that loads every module.
Retain preparation commands, outputs and generated-file hashes; no dependency
installation belongs to the measured agent phase.

## Historical provenance and next-campaign readiness

The [2026-08-27 report](../../release/benchmarks/expanded-typescript-agent-benchmark-results-2026-08-27.md)
and its JSON describe 32/32 grader passes, one sample per cell, and freshly run
comparators. The older README/release narrative describes a Urdira-only rerun
with reused comparator rows and 27/32 passes. These are conflicting historical
narratives; do not blend them or certify fresh provenance from prose alone.
Raw August transcripts were removed after extraction according to that report.
Resolve the discrepancy from retained audit digests/derived provenance where
possible, and label any remaining uncertainty. No historical row should enter
the next fresh comparison.

See the [preparation record](../evidence/2026-09-09-expanded-agent-campaign-preparation.md)
for current findings and outstanding preflight work. The executable protocol,
agent CLI compatibility, current v4 host readiness, and grader attribution must
be exercised before any new performance claim.

## Post-index measurement harness (prepared, not executed)

`release/benchmarks/post-index-measurement.mjs` defines the read-only
post-index protocol. It accepts a directed repository sample and emits a plan;
its CLI does not start an indexer, an agent, an MCP server, or a competitor.
The plan fixes structural readiness as the boundary and asserts
`URDIRA_SEMANTIC_INDEX=0`, semantic materialization/sidecar off, reconciliation
sweep `0`, and production `MCP_SERVER_INSTRUCTIONS`. It adds no prompt,
mandatory pipeline, or tool choice.

The operation matrix measures `core:resolve_symbol` with context, qualified,
and kind variants; paginated `core:find_records` and `core:search_text`;
`core:compare_workspaces`; latency; caps and completeness; and separately
identified snippets, hydration, evidence, and registry bytes. Failures and
continuation pages remain visible. Missing values are `null`, never an
imputed zero. MCP/shell ordering is recorded when present. Existing competitor
reports can be referenced as comparison evidence; they are never rerun by
this harness.

Create a plan without executing a campaign:

```bash
node release/benchmarks/post-index-measurement.mjs \
  --repositories vscode,typescript \
  --sample 1 \
  --output /tmp/urdira-post-index-plan.json
```

After an independently authorized run supplies JSONL events and host metrics,
render comparable JSON/Markdown without rerunning any arm:

```bash
node release/benchmarks/render-post-index-measurement.mjs \
  --plan /tmp/urdira-post-index-plan.json \
  --events /path/to/events.jsonl \
  --host-metrics /path/to/host-metrics.json \
  --output /tmp/urdira-post-index-report
```

### Real host-only executor (prepared, not executed)

`release/benchmarks/run-post-index-measurement.mjs` composes the existing
expanded campaign driver and cell runner. It does not duplicate checkout,
worker, daemon, MCP, readiness, timing, process cleanup, or transcript logic.
Planning is the default; `--execute` is required to start anything. Execution
supports one directed repository sample, one Urdira/Luna arm, and no retries.
The composed runner retains the fresh worktree/data root, structural
`BENCH_HOST_READY`, semantic-off environment, daemon stderr/timing logs,
operation/page telemetry, MCP responses, and Luna transcript under the new
output directory. A failed cell is retained and does not trigger another run.

The executor passes no custom MCP instructions or pipeline requirement. The
existing MCP entrypoint therefore uses the production `MCP_SERVER_INSTRUCTIONS`
and the runner's normal MCP response protocol. An optional
`--comparison-report` is copied only as a hashed, read-only reference; no
competitor is started.

Plan only:

```bash
node release/benchmarks/run-post-index-measurement.mjs \
  --repositories vscode \
  --repositories-root /absolute/path/to/repos \
  --output-dir /absolute/path/to/new-output \
  --plan-output /absolute/path/to/new-output.plan.json
```

The execution form is deliberately explicit and must use a fresh output
path:

```bash
node release/benchmarks/run-post-index-measurement.mjs \
  --execute \
  --repositories vscode \
  --repositories-root /absolute/path/to/repos \
  --output-dir /absolute/path/to/new-output \
  --indexing-worker /absolute/path/to/urdira-indexing-worker
```

The transcript analyzer now parses the retained production Urdira MCP shape:
`result.content[].text` with `structured_content: null`. It records UTF-8
`tool_envelope` bytes, model-visible serialized response bytes, identifiable
source-text bytes, and identifiable result/record metadata bytes. Hydration,
evidence, and registry bytes remain `null` unless the response carries an
explicit typed field; the analyzer does not infer them from labels or depend on
a hypothetical `structuredContent.bytes` object. The same fields are propagated
through the post-index executor's `post-measurements.json` and the expanded
report's task-comparison rows.

Completed Codex action telemetry is reported separately from repository
discovery. The analyzer inventories action item types and exposes web-search,
file-change, integration-warning, hook-error, first-action, and unclassified
counts. These actions do not contribute to MCP, shell, repository-read, or
context-character measurements; those historical fields continue to count only
their existing protocol-defined sources. Started and completed events are
deduplicated by counting completed items only.

## Offline context replay and focused validation

`node release/benchmarks/replay-agent-context.mjs --output NEW.json RAW_DIRECTORY...`
replays raw JSONL files without starting a host, agent, or competitor. The
output is created exclusively and records transcript and manifest hashes,
retained outcomes, transport attribution and efficiency observations. Missing
manifest outcomes and subjective use/relevance metrics remain null. Tgrep
invocations are a subset of shell transport, not a third additive transport.
Exact repeated-output metrics are literal observations, not proof of wasted
source or proof that an agent did not use a result.

Validate focused context separately from broad, paginated context. Accept
correctness, distinct information, stable ordering, exact provenance and
complete pagination before comparing relative efficiency. No absolute token,
character or call-count threshold is an acceptance criterion. For the next
fresh validation use exactly one frozen task in each of Playwright, Prisma
and VS Code, run sequentially with Luna and structural semantic-off settings.
Do not invoke the full two-task-per-repository campaign as a substitute; retain
each attempt without retries or competitor execution.

The 2026-09-12 implementation follow-through and the three retained failed
integration samples are recorded in
[`../evidence/2026-09-12-agent-context-information-preservation.md`](../evidence/2026-09-12-agent-context-information-preservation.md).
Functional/release gates passed; the agent-integration acceptance did not.

## Repair verification after the retained September 12 samples

The three single-sample failures remain immutable evidence; repair verification
uses deterministic regressions and offline replay, with no model retries. See
[context recovery](../evidence/2026-09-12-agent-context-recovery.md).

Before a real cell starts, the runner now inspects the exact Node executable
that it will prepend to the isolated agent shell and the availability of
declared dependencies in the root and target package
ancestors. A failure writes an exclusive `.preflight-failure.json` artifact with
`model_invoked: false` and stops before model execution. This is separate from
structural index readiness. It installs nothing and does not claim that available
dependencies prove the repository's tests will pass. Runtime-only preflight with
no worktree remains a runtime check, not a validation-environment acceptance.

Offline metrics use the manifest's explicit worktree to reconcile absolute edited
paths with indexed relative paths. Continuation attempt and consumption counts are counts of unique references,
not raw call counts. A failed-only reference counts as attempted but not consumed;
a subsequently successful request marks it consumed. Per-call failures remain
in the transcript and ordinary MCP failure metrics. Exact nonblank source-line overlap in later shell source
reads counts characters excluding line separators; it is observational overlap,
not proof of wasted reading or unused hydration. Per-call counts distinguish
overlapping and non-overlapping reads after MCP context, while reads made before
the first MCP result remain separate. It is `null` without observed source.
Diff-only review is excluded. Original output-equality metrics remain separately
named. Relevance, unused hydration and contribution remain `null` without
transcript evidence supporting an annotation.

## Explicitly authorized fresh live verification

After the repair gates, the user authorized one new Luna sample each in
Playwright, Prisma and VS Code, sequentially, without retries or competitors.
See [live verification](../evidence/2026-09-12-agent-live-verification.md).
All three fail integration acceptance. Prepared repository prerequisites and a
direct shim-version probe did not prevent the actual agent hook from resolving
an older unprepared runtime. Independently executed tests pass for Playwright,
fail in Prisma, and fail to load in VS Code. Preserve these outcomes separately
from the original samples and the successful deterministic release gates.
Completed-shell telemetry omits commands rejected before launch: do not treat
missing shell output as evidence of successful fallback elimination.
Hook-trust notices are integration warnings, not hook execution errors. The
runner retains raw host-session evidence before cleaning its isolated home so
pre-launch rejections remain auditable separately from completed shell output.
The user subsequently authorized iterative repair; new attempts after concrete
repairs are retained separately and do not replace these failed samples.

The next repaired current-arm samples and their retained comparator comparison
are recorded in
[`../evidence/2026-09-13-current-urdira-context-density-benchmark.md`](../evidence/2026-09-13-current-urdira-context-density-benchmark.md).
All three current samples pass the strict grader and independent focused
validation. They do not establish an efficiency improvement: every current
token total remains above every retained comparator median. Hook sidecars prove
that all 61 Codex PreToolUse interceptions fell back as unsupported input, and
the VS Code sample exposes the practical failure of line-only shell bounds when
a matching generated record occupies a megabyte-long line.

The subsequent hook repair uses Codex `PreToolUse` `updatedInput` to replace a
faithfully translatable simple `rg` command with output from Urdira. Quoted regex
operators are parsed as pattern content and multiple explicit paths remain one
indexed filter. Compound shell commands and unsupported options continue to fail
open. This repair postdates those samples and is not attributed to them.

The fresh v3 samples after that repair are recorded in
[`../evidence/2026-09-13-current-urdira-arm-v3.md`](../evidence/2026-09-13-current-urdira-arm-v3.md).
The repair served none of 57 live interceptions because every observed search
was composed with another shell operation. Prisma alone passed both the strict
grader and independent validation. Playwright failed its independent ordering
test, and VS Code failed both the strict grader and its disposable-leak test.
The retained comparison therefore treats two efficiency rows as diagnostic and
does not claim equal correctness.

Custom package-script test names are recognized when their recorded
package-manager output identifies a known test command. That evidence can be
reused by later identical commands, including the same command followed by an
`&&` chain, even when npm does not echo the inner command again. Different
arguments or script names do not inherit that evidence. A nonzero compound
exit does not identify which command failed and remains unknown. Original transcripts
and manifests remain unchanged; corrected counts belong in derived replay
reports. Compound command exits remain unknown when the inner test result
cannot be attributed safely.

Executable test paths are recognized without treating a source-file read of the
executable as a test invocation. Newline-separated commands, like semicolon or
pipe compositions, retain unknown inner-test exits unless independently attested.

For production-native verification, pin `URDIRA_NATIVE_REQUIRED=1` and
`URDIRA_NATIVE_ROOT` to the exact accepted extracted closure, retain its archive
and worker digests, and attest that the composed app/engine/MCP/CLI modules used
by the driver match the installed archive. Keep the semantic switches disabled.
A launcher-version probe alone cannot establish installed query readiness:
also verify worker execution and an actual structural MCP query after readiness.

Retries intended as clean integration evidence use new detached worktrees at the
frozen revision and fresh preparation. `git reset --hard` plus `git clean -fd`
does not remove ignored test reports and can expose previous attempted solutions
to discovery. Retain reused-tree results, but exclude a contaminated attempt from
comparison and record why. Do not copy prior worktree output directories into a
new sample; only reproduce declared dependency and baseline build preparation.

## Earlier paginated-hook samples

The earlier post-repair Playwright, Prisma and VS Code samples are recorded in
[`../evidence/2026-09-13-current-urdira-arm-v10.md`](../evidence/2026-09-13-current-urdira-arm-v10.md).
All three passed the strict grader and independent focused validation at that
time. This section is historical: the later VS Code v70 sample failed its
integration grader, and the accepted post-repair measurement is VS Code v75,
recorded in [`../evidence/2026-09-14-agent-context-density.md`](../evidence/2026-09-14-agent-context-density.md).
A runner
preflight attempt that checked the host login shell instead of the explicitly
injected Node executable stopped before model invocation; its artifact is
retained, and a focused regression guards the repair. In the accepted samples,
Urdira is the first discovery source and supplies all observed pre-edit source
characters in Playwright and Prisma, and 65.6 percent in VS Code. The repaired
hook prevents the previous megabyte-long generated line from entering VS Code's
context: repository context falls from 1,156,423 characters in v9 to 208,525 in
the current sample. Retained competitor medians still use fewer total tokens on
all three tasks, so the result supports correctness and better context control,
not a general efficiency or statistical winner claim.

## Current prompt-hook samples

The next single samples after dynamic Codex `UserPromptSubmit` context are
recorded in
[`../evidence/2026-09-13-prompt-hook-agent-arm-v20.md`](../evidence/2026-09-13-prompt-hook-agent-arm-v20.md).
All three strict graders pass. Playwright and Prisma receive model-visible
prompt context before their first action; VS Code falls back because the index
is stale at both prompt boundaries. Audited prompt context is Urdira use and its
characters belong to hook transport even though Codex emits no transcript tool
item for it. `PreToolUse` output is still counted from the transcript to avoid
double attribution. The current samples remain above every retained comparator
median in total tokens, so they reject an efficiency-win claim and identify
turn-boundary freshness plus redundant follow-up actions as the next blockers.

Three subsequent Playwright-only gates are recorded in
[`../evidence/2026-09-13-playwright-context-gates-v21-v23.md`](../evidence/2026-09-13-playwright-context-gates-v21-v23.md).
V23 removes repeated follow-up bootstrap and reduces direct MCP use to one
call. Correct cumulative-thread accounting gives it 1,470,687 total tokens,
6.7 percent above the closest retained comparator, codebase-memory. The former
3,411,724 value summed cumulative resumed-thread counters and is retired.
The Prisma and VS Code samples therefore were not repeated: the focused gate
did not satisfy the runbook's efficiency condition for expanding the campaign.

Five later Playwright gates are recorded in
[`../evidence/2026-09-13-playwright-context-gates-v24-v28.md`](../evidence/2026-09-13-playwright-context-gates-v24-v28.md).
V27 is the latest accepted strict-correctness sample at 1,527,823 tokens. V28
demonstrates that authored-TypeScript ordering alone does not remove redundant
agent discovery: Urdira supplied 97.3 percent of observed pre-edit repository
context after hook-audit replay, but one invalid direct query and higher token
use failed the gate. Prisma and VS Code were again not repeated.

## Final context-density checks and cleanup

The final sequential checks are recorded in
[`../evidence/2026-09-13-current-urdira-context-density-benchmark.md`](../evidence/2026-09-13-current-urdira-context-density-benchmark.md).
Playwright v48 and Prisma v49 pass the strict grader and every focused test run
by the agent. Prisma uses fewer total tokens than every retained comparator
median; Playwright ranks between tgrep and codebase-memory. VS Code v50 is
rejected despite its path-level grader result because its focused test consumed
an uncompiled `out/` artifact and failed. V51 reached durable structural
readiness in 49 seconds and served its first three searches through the hook,
but the Luna worker then stopped producing events before any edit; the retained
attempt was terminated and not retried.

An explicitly paginated hook response is now served with its continuation even
when the response declares page truncation. It falls back only when truncation
has no valid continuation or the rendered page cannot fit the host limit. The
installed guidance also tells agents to run a repository's required compile
step after editing when the exact-file test runner consumes generated output.
The corrected VS Code patch was verified locally with the core-only
`gulp compile-client` task and the exact test selector, which passed 3/3.

Delete each sample's dependencies, generated build output and Urdira data root
immediately after retaining its report, transcript, hook audit, timing and host
log. Native residual tests use an owned scratch guard that removes their store
on scope exit. The cleanup manifest for this campaign is
`/Users/Cristian/BenchmarkResults/urdira-context-cleanup-20260913.json`; the
final frozen worktrees are clean and dependency-free.

## Hook-first follow-up protocol

For Codex and other hosts with prompt or pre-tool interception, a successfully
served hook is an Urdira discovery action. Attribute the bytes to hook
transport and subtract the replacement-file bytes and marker from native shell
output. A compound command may contain both transports; retain the native
segments as shell without double-counting the replaced segment. Missing or
ambiguous attribution remains `null`.

The current Urdira arm uses the production prompt and pre-tool hooks as its
primary integration and does not also advertise the Urdira MCP catalog to the
same model session. The packet contains explicit workspace scope, treats its
supplied test sources as the default test location, and tells the agent to
start the task before consuming a continuation or searching for alternatives.
If a concrete missing fact blocks the task, execute the literal `MORE` envelope
with `urdira query --payload <json> --json`; the CLI routes both initial-query
and continuation envelopes while preserving direct core payload compatibility.

Run one fresh Playwright sample after this change. Accept correctness and exact
focused validation before comparing tokens. If the sample does not improve on
the retained equal-correctness boundary, inspect its transcript and formulate
a new product or integration hypothesis before another run. Clean its checkout,
data root, package-manager cache, and generated output immediately after
retaining the transcript, report, hook audit, patch, hashes, validation, and
cleanup manifest.

The first hook-first sample showed that login-shell PATH order is part of this
gate. The generated `.zprofile` must place the isolated Urdira shim before the
directory containing the host-native Node closure, since that directory also
contains a launcher that is valid only inside an extracted release root. Verify
`command -v urdira` and `urdira --version` through the isolated login shell
before accepting CLI continuation coverage.

Prompt packets should include a compact source guide separating production and
test snippets. Treat listed production snippets as candidate definitions,
callers, and public wiring during the first implementation pass. This guide is
an ordering aid; it does not remove results, change certainty, or replace the
result index and exact continuation.

When a populated packet has complete index coverage and editable source, mark
it action-ready. The agent should make its first edit from those snippets and
consider listed caller wiring before repository inventory. This is guidance,
not a restriction: a named missing fact, incomplete coverage, generated output,
or focused validation may still require Urdira continuation or native shell.

The v66 transcript exposed a line-only projection gap: `rg ... 2>/dev/null |
head -40` remained native and one generated declaration line contributed
22,874 characters. The bridge accepts that exact projection composition and
uses the hook's character budget as well as its requested line count. An
oversized match retains its identity and an explicit Urdira source-recovery
instruction instead of silently dropping the result.

V67 did not repeat that exact search, so the parser repair is accepted from its
deterministic regression rather than attributed to the sample. It did expose
two new general integration costs: a zsh wrapper used the reserved `status`
parameter and successful build/test evidence was repeated in later handoff
turns without an intervening edit. Installed guidance now uses task-specific
exit variables and reuses still-current successful validation. A further sample
requires this distinct hypothesis; do not treat model action variance as proof
of the parser behavior.

V68 confirms both guidance effects in the live integration: its validation
wrappers use task-specific exit variables, and later handoff turns do not repeat
the successful build or test without a new edit. Its strict grader passes and
its cumulative comparable usage falls to 659,789, but the independent watcher
check retains a timeout after 2/3 selected cases pass. The sample is therefore
excluded from equal-correctness comparison and is not retried.

The subsequent directed Prisma v69 sample passes strict grading and independent
validation at 666,427 comparable tokens, with Urdira supplying all context
observed before the first edit. VS Code v70 independently produces a correct
and validated patch but fails the integration grader: its initial prompt
context expands both `LanguageFeatureRegistry` and the common `onDidChange`
member as roots, exceeds the hook window and leaves native discovery dominant.
The sample is retained without retry. Prompt hooks now provide their first
code-shaped identifier as an explicit symbol seed, and `core:build_context`
treats explicit seeds as authoritative roots while using the full task only
for ordering. Validate this exact repair with deterministic regressions; do not
attribute it retroactively to v70 or retry the retained sample.

Do not leave generated validation output in the source frontier during sample
preparation. V70 compiled VS Code before indexing and included its generated
`out/` tree: the initial catalog held 27,589 rows, while a later `clean-out`
cycle reconciled 11,864 rows. Its 86,416 ms readiness value is therefore not a
like-for-like regression against v50. Future readiness samples must prepare
dependencies, remove generated validation output, and only then start the
structural scan; compilation remains part of post-edit validation.

V71 exposed another adapter fidelity error. A native `rg` command with a
negative `--glob` was converted into the public inclusion-only `filter.paths`
field, so Urdira served an empty result and the agent consumed a large
continuation to recover the missing test wiring. The bridge now leaves negative
globs on the native path. V72 applies that regression fix and indexes the
checkout only after generated `lib/` output from preparation has been removed.
It passes the strict grader and independent focused validation at 569,904
comparable tokens. This is 9.3 percent below the retained equal-task baseline
median of 628,159. Structural readiness was 4,917 ms. The complete evidence and
single-sample limitation are recorded in
[`../evidence/2026-09-14-agent-context-density.md`](../evidence/2026-09-14-agent-context-density.md).

V73 is retained as a dependency-preparation failure before model invocation.
V74 is the two-task VS Code smoke gate and passes 2/2 with strict grader 0.
V75 is the accepted one-sample VS Code measurement: both frozen Luna tasks pass
the strict grader and independent validation with semantic indexing disabled.
Its task-specific readiness values are 29,537 ms for
`language-registry-change-notification` and 43,880 ms for
`language-provider-registration-idempotence`. Their comparable usages are
1,248,648 and 1,462,541 tokens respectively. These are separate task values;
the campaign has no task-matched baseline medians for this pair, so it does not
claim an efficiency improvement from their sum. Native shell reads remain valid
when the hook does not contain the needed fact; a served hook is counted as
Urdira use. The v73 failure, v74 smoke, v75 raw hashes, replay and independent
checks are retained with the dated evidence.

The later v76 and v77 dependency-preparation failures remain retained and do
not replace v75. V78 passed the strict grader only for the registry task; its
provider task stopped at preflight. V79 reached provider readiness in 29,525
ms but failed the strict grader because the model runtime could not resolve
`@typescript/native/lib/tsc.js`. V79 is not an accepted sample or an
efficiency comparison. Its independent post-run validation passed the
resulting patch's TypeScript typecheck, targeted ESLint, diff check and the
focused once-only registration test. See
[`2026-09-14-prompt-hook-context-reuse.md`](../evidence/2026-09-14-prompt-hook-context-reuse.md)
for the exact retained outcomes, hook fallback counts and cleanup record.

V82 is the accepted provider follow-up after rebuilding the production CLI,
application, native addon and indexing worker. It preserves the exact
`core:coverage_incomplete` diagnostic when `core:build_context` needs stage 3
but the sample is ready at structural stage 1, then serves an explicitly
scoped `core:search_text` source-safe fallback with separate coverage and
continuation fields. Readiness was 27,555 ms. The strict grader and independent
validation passed; the audit recorded 3 served prompt packets and 5 served
pre-tool packets, with all other fallbacks retained by reason. V82 is a single
task-matched integration observation and does not establish a general token
efficiency result. Its final cumulative-thread usage was 1,655,594 tokens,
13.2 percent above the prior V75 provider observation at 1,462,541 tokens. The
first prompt packet contained only the 441-character
`core:selector_unresolvable` diagnostic; the useful context packet arrived
after native shell discovery. Its preflight hash stamp and raw artifacts are
retained in the benchmark results directory.

V83 is retained as a failed single-sample hypothesis check. Selector recovery
reduced pre-edit shell source output to 59,812 characters while preserving
14 effective hook interceptions, but the agent changed an opaque continuation
cursor before replaying it and the strict validation gate rejected the sample.
This does not invalidate the generic source-safe fallback; it records that the
agent must copy continuation references literally. No competitor or retry is
added.

V84 was interrupted after model execution and before manifest/grader emission,
so its raw artifacts are retained as an infrastructure failure. The transcript
showed that the benchmark task's `TypeScript` language name was selected as the
structural seed before `LanguageProvider`, yielding unrelated low-confidence
matches. The prompt adapter now removes path metadata and ranks repeated,
specific code-shaped candidates generically; the regression includes a
`BenchmarkResults` path and the exact task prompt.

V85 is the one fresh provider sample for that seed-ranking hypothesis. It used
the frozen VS Code commit, Luna, structural-only readiness and semantic off. It
passed the strict grader and independent validation with two target paths,
required patterns, focused TypeScript compilation and clean diff. Readiness was
29,520 ms. Raw turn usage summed to 2,804,588 tokens; under the campaign's
task-matched convention, the comparable last cumulative-thread value was
1,296,289 (1,286,069 input plus 10,220 output). It was above provider medians
for baseline (1,193,155) and tgrep (1,011,210), and below CodeGraph (1,430,741)
and memory (1,938,561); the sample is a correctness/integration pass and not
an efficiency improvement. The first
edit followed 43,656 hook characters and no shell source output; total hook
and shell output was 57,188 and 73,410 characters. The audit retained 29
effective hook interceptions (9 served and 20 fallbacks by their typed reasons)
and no cursor mutation. V84/V85 raw reports, transcripts, independent replay,
cleanup measurements and exact artifact hashes remain under their external
benchmark result directories. V85 cleanup removed 2,650,438,997 checkout bytes,
5,564,632,313 data-root bytes and 223 prompt-cache bytes after process checks.
No competitor or retry was added.

After V85, the prompt cache was refined for same-session continuations. A
follow-up that contains an incidental resolvable identifier but no explicit
missing-detail request reuses the packet for the same workspace snapshot; an
explicit request for a missing caller or detail triggers a fresh Urdira query.
The session identity remains bound to the existing hook key and workspace id.
Regressions cover both branches. The exact focused command
`CI=true pnpm exec vitest run tests/agent-integration.test.ts` passed 44/44
tests in the audited checkout. No retained artifact supports a 53-test count.
This change has not received a new benchmark sample, so its efficiency effect
is not claimed.

V86 is the single fresh provider sample for same-session prompt-context reuse.
It passed the strict grader and independent checks using frozen VS Code, Luna,
structural-only readiness and semantic off. Readiness was 29,536 ms and the
comparable last cumulative-thread value was 970,632 tokens (961,131 input plus
9,501 output), a 25.1 percent reduction from V85's 1,296,289. It is below the
provider task-matched medians for baseline (1,193,155), tgrep (1,011,210),
CodeGraph (1,430,741) and memory (1,938,561). The first edit followed 54,019
hook characters and no shell source output; totals were 56,124 hook and 60,946
shell characters. The audit recorded 22 effective hook interceptions (6 served,
16 fallbacks: stale 5, overflow 2, unsupported 9). The explicit missing-detail
regression forces a new query, so reuse does not suppress named recovery. The
V86 result, replay, stamp, hashes and cleanup measurements are retained under
its external result directory; no competitor or retry was added.
