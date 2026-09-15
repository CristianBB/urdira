# Definitive agent benchmark v8 evidence

## Scope and status

The v8 agent phase covers three campaigns, three repositories, five arms, and
three outer turns per cell: 45 observed repository/task/arm rows. This note is
an evidence index; raw campaign data remains outside the repository. The
complete 45-row index is the external consolidation Markdown at
`/Users/Cristian/BenchmarkResults/urdira-v8-derived-luna-campaigns-1-3-v1/summary/benchmark-campaigns-1-3-v3.md`
(SHA-256 `030dcf4d92c954df9692655bee34676d0587aee3491d5e093ecb263660cb57a9`)
and consolidation JSON at
`/Users/Cristian/BenchmarkResults/urdira-v8-derived-luna-campaigns-1-3-v1/summary/benchmark-campaigns-1-3-v3.json`
(SHA-256 `622be916d37ab86bcfe79f915b2e40652e5d7c3211e819e094946bdaddb4ce93`);
both retain all measured fields.

| Measure | Observed state |
|---|---|
| Agent rows | 45 observed; 43 task-solved, 42 strict grader passes, 2 strict grader nonpasses, 1 infrastructure outcome unavailable |
| Target coverage | 43 rows at 2/2; one infrastructure row `null`; one execution-failure row at 0/2 |
| Campaign samples | 1 per identity in each of C1, C2, and C3 |
| Outer turns | 3 where the agent execution produced turns; `null` where unavailable |
| Readiness | 18 planned; 18 failed/blocked/interrupted; 0 complete; 0 pending; no probe invoked a model |
| Retry policy | No retry or replacement counted |
| P95 | `null`; three campaign samples do not establish the frozen eligibility threshold |

The consolidation JSON SHA-256 is
`622be916d37ab86bcfe79f915b2e40652e5d7c3211e819e094946bdaddb4ce93`; its
Markdown SHA-256 is
`030dcf4d92c954df9692655bee34676d0587aee3491d5e093ecb263660cb57a9`.
The source summary references are:

* C1: `/Users/Cristian/BenchmarkResults/urdira-v8-derived-luna-c1-resume-v6d-v1/c1-summary-v4.json`, SHA-256 `ae6fb0eaf943dd9fd9f93587a632c78a09718deaa8ab12513a32fffcc0f4795e`.
* C2: `/Users/Cristian/BenchmarkResults/urdira-v8-derived-luna-c2-final-15-v1/c2-summary-final-v1.json`, SHA-256 `54c61dbaaaa6a8c19dbcc3a3da8240edc4e355825fd3756e43a61cadb3ded2fd`.
* C3: `/Users/Cristian/BenchmarkResults/urdira-v8-derived-luna-c3-final-15-v3/summary/c3-summary-final-v2.json`, SHA-256 `2dfe70e2734a18ad3ddda42082e64f5aafc09e41b2cf3854f79ac0e350dcb11b`.
* C3 composed audit: `/Users/Cristian/BenchmarkCells/v8/campaign-3-resume-v6-after-c3-12-v1/campaign-audit-composed.json`, SHA-256 `114e4a3a8d1f8f76176c779c90471dbe79c610dac84fcd6d449ed6f04db5b235`.
* C3 composed manifest: SHA-256 `4418db0a234dfeb9cd46dd986f27f84c23b57d43fa0408d53e6f5e537d305931`.

## Metric contract

Input, cached input, output, reasoning, and additive total tokens are retained
as separate measured fields from matched cumulative host evidence. The frozen
planning card is input/cached input `$2/M` and output/reasoning `$8/M`; cost is
derived from that card and is `null` when required evidence is unavailable.
The normative additive total is not replaced by a provider-reported total.

Hook usage is recorded as total invocation count, with served and fallback
counts separate. Output-bearing hook calls are a separate field. The arm
configuration and observed tool use are separate. Shell, MCP, tgrep, context,
and hook measurements are not merged; shell overlap is `null` when the source
payload is unavailable. Agent, runner, and grader exits remain separate.
Unavailable values are `null`, never zero. Correctness, target coverage,
efficiency, failures, and distributions are separate result dimensions.

## Readiness provisional block

Readiness follows the agent phase and is now closed as a failed/blocked
attempt set. The retained evidence records the prior cold `EINVAL` socket and
dependency failures, the original Playwright and cancelled VS Code C2
interruptions, the Playwright C3 cold SIGTERM 143 with its warm probe blocked,
and the C3 Prisma and VS Code cold/warm pairs blocked before model invocation
by their recorded package-manager failures. Thus all 18 planned probes are
persisted as failed/blocked/interrupted, zero succeeded, zero remain pending,
and no retry was counted. The latest audit is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-v8-resume-after-c1-playwright-v6/readiness-resume-audit.json`
(SHA-256 `fb239152b49a9296cd5980b0aec89802211a295afc668bbd450b9fee3a0110d5`).
The retained Prisma pair status is
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
The readiness measurement objective was not achieved: all 18 persisted
attempts failed, were blocked, or were interrupted, with zero successful
readiness measurements. The post-campaign PATH fix is not retroactive
validation and produced no new readiness evidence.
Readiness timestamps and storage/process/publication/freshness fields remain
`null` unless present in retained readiness artifacts. This record does not
qualify readiness as successful.

## Explicit nonpass evidence

The C3 VS Code/Urdira row is task-solved with target coverage 2/2, but its
strict grader is false because of a tool-validation incident. The retained diagnostic
`/Users/Cristian/BenchmarkResults/urdira-v8-derived-luna-c3-final-15-v3/summary/c3-15-grader-diagnostic-v1.json`
has SHA-256
`ce4db120b97bd4f038abebcd1930d8a0f530c7c9ff49642b76d6600da646e500`.
Its raw transcript line 10 contains `core:unknown_field` for `/request/query`.
The row's agent exit is `0`, outer runner exit is `1`, and grader exit is `1`;
its task outcome is solved because target coverage and final changes are
present. The strict grader nonpass is the tool-validation incident, not a
task-correctness failure. No rm-f or test-blocked cause is inferred.

The corrected reporting axes are retained in the append-only sidecar
`/Users/Cristian/BenchmarkResults/urdira-v8-derived-luna-campaigns-1-3-v1/summary/benchmark-campaigns-1-3-v4-axis-correction.json`
(SHA-256 `e62bdc06fbf8c5cbb19ba6f1c28ded008e7d1df1f20e540d2bbede0ff94025e3`):
`task_solved`, `grader_pass`, and `tool_validation_incident` are separate and
the v3 raw-derived consolidation is unchanged.

The other explicit nonpass is the C1 VS Code/codebase-memory execution
failure. The C1 Prisma/Urdira infrastructure row has unavailable task outcome and grader
fields; its missing measurements remain `null`. The C1 VS Code/codebase-memory
row is an execution-capacity failure at 0/2. These are separate from the 43
rows whose task outcome is solved and the 42 strict grader passes.

The v7 and v6 campaign snapshots and their partial renderings are historical
and remain separate from v8. This evidence note does not certify readiness or
claim that all 45 observed rows are correct. The subsequent per-campaign
rendering and final readiness composition are documented in the
[2026-09-16 post-campaign evidence note](2026-09-16-definitive-agent-benchmark-v8-postcampaign.md).
