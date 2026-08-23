# Expanded TypeScript agent benchmark results

Generated from the sequential audit for four frozen TypeScript repositories. The four arms are baseline, Urdira with the JavaScript/TypeScript engine, codebase-memory MCP, and CodeGraph. A cell is successful only when the repository grader passes; index/setup failures remain visible as failed or blocked runs.

The Urdira arm was rerun in this campaign (complete: 8/8 cells). Existing comparison-arm rows were reused from the prior audited campaign: baseline, codebase-memory, codegraph. They were not re-executed in this run.

The estimated cost uses the explicit planning card in the JSON report and is not a provider invoice. Raw transcripts and host logs are retained outside the repository and bound by the audit SHA-256.

## Per-run measurements

| Repository | Task | Arm | Correct | Total tokens | Cost USD | Turns | MCP calls | Setup ms | Agent elapsed ms | Peak RSS KiB | CPU % | SQLite bytes | CAS bytes | Bytes copied | Bytes transferred | Bytes decoded |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| typescript | transpile-diagnostic-callback | baseline | no | 207,961 | 0.4337 | 3 | 0 | 647 | 52940 | — | — | — | — | — | — | — |
| typescript | transpile-diagnostic-callback | codebase-memory | no | 345,075 | 0.7118 | 3 | 11 | 48644 | 67957 | — | — | — | — | — | — | — |
| typescript | transpile-diagnostic-callback | codegraph | yes | 2,585,203 | 5.3329 | 3 | 7 | 86618 | 204772 | — | — | — | — | — | — | — |
| typescript | session-project-event-hook | codebase-memory | no | 7,042,049 | 14.2749 | 3 | 30 | 44459 | 233295 | — | — | — | — | — | — | — |
| typescript | session-project-event-hook | codegraph | no | 6,711,991 | 13.6686 | 3 | 10 | 85135 | 317544 | — | — | — | — | — | — | — |
| typescript | session-project-event-hook | baseline | no | 3,503,306 | 7.2137 | 3 | 0 | 561 | 239102 | — | — | — | — | — | — | — |
| playwright | affected-tests-deterministic | codebase-memory | yes | 4,006,620 | 8.2033 | 3 | 26 | 5981 | 215310 | — | — | — | — | — | — | — |
| playwright | affected-tests-deterministic | codegraph | yes | 2,917,732 | 5.9951 | 3 | 10 | 11444 | 185059 | — | — | — | — | — | — | — |
| playwright | affected-tests-deterministic | baseline | yes | 2,057,856 | 4.2704 | 3 | 0 | 50 | 172297 | — | — | — | — | — | — | — |
| playwright | reporter-error-isolation | codebase-memory | yes | 4,232,360 | 8.6607 | 3 | 31 | 5631 | 199508 | — | — | — | — | — | — | — |
| playwright | reporter-error-isolation | codegraph | yes | 2,666,029 | 5.6089 | 3 | 5 | 11288 | 248216 | — | — | — | — | — | — | — |
| playwright | reporter-error-isolation | baseline | yes | 1,705,956 | 3.5833 | 3 | 0 | 869 | 169460 | — | — | — | — | — | — | — |
| prisma | wire-name-validation | codebase-memory | yes | 3,287,321 | 6.7769 | 3 | 24 | 8167 | 204453 | — | — | — | — | — | — | — |
| prisma | wire-name-validation | codegraph | yes | 2,371,730 | 4.8876 | 3 | 6 | 12135 | 157160 | — | — | — | — | — | — | — |
| prisma | wire-name-validation | baseline | yes | 2,108,846 | 4.3976 | 3 | 0 | 107 | 172117 | — | — | — | — | — | — | — |
| prisma | mongo-value-set-transform | codegraph | yes | 2,550,210 | 5.2348 | 3 | 7 | 12826 | 173493 | — | — | — | — | — | — | — |
| prisma | mongo-value-set-transform | baseline | yes | 1,468,030 | 3.0677 | 3 | 0 | 305 | 151714 | — | — | — | — | — | — | — |
| prisma | mongo-value-set-transform | codebase-memory | yes | 3,168,886 | 6.4521 | 3 | 26 | 8528 | 143002 | — | — | — | — | — | — | — |
| vscode | language-registry-change-notification | codegraph | yes | 4,248,636 | 8.7159 | 3 | 13 | 82945 | 297003 | — | — | — | — | — | — | — |
| vscode | language-registry-change-notification | baseline | yes | 3,765,815 | 7.8445 | 3 | 0 | 991 | 296348 | — | — | — | — | — | — | — |
| vscode | language-registry-change-notification | codebase-memory | yes | 6,153,542 | 12.5841 | 3 | 26 | 77429 | 380214 | — | — | — | — | — | — | — |
| vscode | language-provider-registration-idempotence | baseline | yes | 2,158,052 | 4.5073 | 3 | 0 | 1242 | 188859 | — | — | — | — | — | — | — |
| vscode | language-provider-registration-idempotence | codebase-memory | yes | 5,509,441 | 11.2253 | 3 | 33 | 78036 | 314356 | — | — | — | — | — | — | — |
| vscode | language-provider-registration-idempotence | codegraph | yes | 3,940,417 | 8.1186 | 3 | 11 | 82488 | 293939 | — | — | — | — | — | — | — |
| typescript | transpile-diagnostic-callback | urdira-typescript | yes | 1,055,504 | 2.1972 | 3 | 4 | 215912 | 266547 | 4690496 | 103.2 | 1058250608 | 37144161 | — | — | — |
| typescript | session-project-event-hook | urdira-typescript | no | 2,742,514 | 5.6343 | 3 | 8 | 200312 | 417498 | 3635088 | 86.6 | 1279738376 | 37574312 | — | — | — |
| playwright | affected-tests-deterministic | urdira-typescript | yes | 1,236,362 | 2.5688 | 3 | 5 | 236537 | 321304 | 4311168 | 86.0 | 1246338672 | 29126522 | — | — | — |
| playwright | reporter-error-isolation | urdira-typescript | yes | 957,551 | 2.0032 | 3 | 4 | 234574 | 266069 | 4324448 | 86.9 | 1253356528 | 29123851 | — | — | — |
| prisma | wire-name-validation | urdira-typescript | yes | 763,150 | 1.6068 | 3 | 6 | 334340 | 251533 | 4907936 | 92.4 | 2089903424 | 45425247 | — | — | — |
| prisma | mongo-value-set-transform | urdira-typescript | yes | 708,945 | 1.4760 | 3 | 4 | 335154 | 219106 | 4782896 | 96.5 | 2089620968 | 45394889 | — | — | — |
| vscode | language-registry-change-notification | urdira-typescript | no | — | — | — | — | — | — | 5000384 | 137.2 | 2473230872 | 222625263 | — | — | — |
| vscode | language-provider-registration-idempotence | urdira-typescript | no | — | — | — | — | — | — | 5000256 | 150.7 | 2493088368 | 222625263 | — | — | — |

## Gate

- Expected runs: 32
- Observed runs: 32
- Correct runs: 24
- Failed or blocked runs: 8
- Campaign gate passed: false

See the JSON file for grouped medians/means, setup evidence, correctness evidence, and failure messages.

## Indexing and readiness evidence

The Urdira host records every published frontier transition. `readiness_ms` is the time from host start to the benchmark readiness boundary (source-first structural stage); `source_ready_ms` and `structural_ready_ms` are the first observed corresponding frontier timestamps. Stage timings are emitted by the indexer and are not inferred from agent elapsed time.

| Repository | Task | Readiness ms | Source ready ms | Structural ready ms | Source catalog ms | Plugin analysis ms | Publish ms | Analysis acceptance ms | Peak RSS KiB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| typescript | transpile-diagnostic-callback | 215459 | 10373 | 215459 | — | — | — | 28753 | 4690496 |
| typescript | session-project-event-hook | 199696 | 10275 | 199696 | — | — | — | 27754 | 3635088 |
| playwright | affected-tests-deterministic | 235944 | 30896 | 235943 | — | — | — | 11744 | 4311168 |
| playwright | reporter-error-isolation | 234472 | 31235 | 234472 | — | — | — | 11513 | 4324448 |
| prisma | wire-name-validation | 333535 | 50758 | 333535 | — | — | — | 6111 | 4907936 |
| prisma | mongo-value-set-transform | 334689 | 51268 | 334689 | — | — | — | 6133 | 4782896 |
| vscode | language-registry-change-notification | — | 56098 | — | — | — | — | — | 5000384 |
| vscode | language-provider-registration-idempotence | — | 55627 | — | — | — | — | — | 5000256 |
