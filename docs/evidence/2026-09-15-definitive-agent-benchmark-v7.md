# Definitive selected agent benchmark v7: blocked retained execution evidence

Status: blocked after two campaign-1 attempts on 2026-09-15. This note records the retained v7 raw execution and its offline partial analysis. It does not claim completion of the 45 agent cells or 18 readiness probes, and it keeps v6 historical evidence separate.

## Outcome

| Scope | Expected | Attempted / observed | Successful | Failed or blocked | Not started |
|---|---:|---:|---:|---:|---:|
| Agent cells | 45 | 2 | 1 | 1 | 43 |
| Readiness probes | 18 | 0 | 0 | 0 | 18 |

The user-authorized order is 45 agent cells followed by 18 readiness probes. The retained stop policy is no retry. The baseline Playwright cell completed successfully. The Urdira Playwright cell exited before model invocation with `Urdira host exited before readiness (7/none)` and its cleanup passed. This is an infrastructure/coverage failure; it supplies no model result. The 43 remaining agent cells and 18 readiness probes are not started.

Raw campaign audit: `/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v7/execution-v7/campaign-1/campaign-audit.json`, SHA-256 `51f88c6e83cafd3016d897c0f959ba60a2db35afce8512359ba8899917140678`. Stop ledger: `/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v7/execution-v7/campaign-1/campaign-1-stop-ledger-v1.json`, SHA-256 `10cdabce6ab2aa0b4bec1f39cc525ee83ee91da80ba49f6d0b8dcf6ef9d2997d`; stop checkpoint SHA-256 `9506ad6782b40cfb1b5fe8fca98cab67e0921f6f88e0402c5eb6456a2daa713a`.

## Baseline measured values

The baseline retained manifest, transcript, timing sidecar, cleanup, and matched host session are recorded in the raw run directory. Manifest SHA is `9f9361a61c98de18fea21c20440d967f5c3ba2088b95b43be8c6deed1f26ca14`; transcript SHA `5bbd968dc00655a6f41939c4e1c06765fbfdba5557c7ec688a06fbd4f4418d43`; timing SHA `ef140b462e3beb24ac4b37074fefbcb0522c67705a0ce52528f03ec7fcbee561`; host session SHA `55b5d6cfd479ad317c7fed9df47f812b88571f97ba3377f4cefec245252702e2`.

The source evidence proves three successful Codex invocations, three matched host root turns, three `turn.completed` records, cumulative counter mode, and zero duplicate token records. Tokens are input `816,937`, cached input `753,920`, uncached input `63,017`, output `8,575`, reasoning `3,000`, normative additive total `828,512`. Provider-reported `total_tokens=825,512` is retained separately because it excludes reasoning. Frozen rate card: input/cached input `$2/M`, output `$8/M`, reasoning `$8/M`; estimated cost is `$1.726474` and is not an invoice.

Execution timing is setup `501 ms`, elapsed from first instruction `239,518 ms`, exit `0`, grader exit `0`, and 3 outer turns. Context records 24 shell command calls and 19 shell source reads, 0 MCP, 0 hook, and 0 tgrep calls; shell output is `108,734` characters, repository context is `107,043`, target-attributed is `70,765`, and unattributed is `36,278`. Shell overlap is `null` with 19 unclassified source reads because no MCP source was present. Correctness evidence matched 2/2 target paths, required patterns, focused test change, and clean diff; numeric test coverage is unavailable (`null`). P95 is `null`.

## Derived offline artifacts

The offline analyzer, replay, and renderer read retained v7 raw paths only and wrote to `/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v7-derived-20260915-v1`. Raw inputs, v6 outputs, and the v7 early-metrics directory were not overwritten.

| Artifact | SHA-256 |
|---|---|
| `partial-audit-v7.json` | `338740ef3d71ba0bff539f220019e0d0636e44ccbcff7c99ffb80b637567e453` |
| `analyzer/playwright-baseline.tokens.json` | `a9bfb18e7782e361a0d103b610b78417ede4cc3978aac77583a669a015e20def` |
| `replay/replay.json` | `383b1395b08b900b7305875c20f1dc88a280fd43bef2d158bae185c0bbdea067` |
| `report/definitive-agent-benchmark-results-v7-blocked.json` | `2e7386c590337cee8528a55b7fb3825c8c522bf5a0f98533182a6898876a9de0` |
| `report/definitive-agent-benchmark-results-v7-blocked.md` | `af776329beb5e6153d3d1519df7277c5b3e20b843337e8dfbf9cc1e27949ffe7` |
| `artifact-manifest-v1.json` | `0f067f161376ff657f96eb9a044c66e0c43fbc239c391f7868c3f1678c6316bf` |
| `assembler-rejection.log` | `c55f020b7877bf1fb8b453c309dcbb45faf0f8436cf9ea5f3f95a1dd916a52b1` |

The partial report contains all 45 cell identities and all 18 readiness identities, with 2 observed/attempted cells, 1 successful, 1 failed/blocked, 43 not started, 0 observed readiness probes, and 18 not started. The production assembler was invoked with one campaign audit and one readiness manifest and exited `1` with `exactly three campaign audits and three readiness manifests are required`. The partial render is diagnostic and does not bypass that completeness gate.

The early baseline extraction is retained separately at `/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v7/early-metrics-baseline-v1/early-metrics-v1.json`, SHA-256 `7e4d5f7f368e59c42ec1fd78843d42a9bddc6773ac753f6e0e15ead956694e22`. Its values are the baseline values above. v6 is historical and is not combined with v7.

## Readiness and future preparation

No readiness probe executed. All 18 readiness rows are `not_started` with measurements `null`. Infrastructure-correction preparation for v8 is authorized; it is preparation state and does not represent a retry, replacement measurement, or completed series.
