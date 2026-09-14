# Definitive agent benchmark results — reporting status

Status: **pending definitive campaign** (2026-09-15).

This is the canonical versioned report location for the selected three
repository, five-arm, three-campaign measurement. The campaign is not complete
yet: no new 45-run campaign or 18 readiness-probe set is claimed by this
document. The final report must be generated from immutable original artifacts
with `analyze-agent-matched.mjs` and `render-expanded-agent-report.mjs`, then
shown to the user. See the [self-contained handoff](definitive-agent-benchmark-handoff.md#final-reporting-and-publication).

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
