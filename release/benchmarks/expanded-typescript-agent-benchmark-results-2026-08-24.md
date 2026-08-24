# Expanded TypeScript agent benchmark results

Generated from the sequential audit for four frozen TypeScript repositories. A cell is successful only when the repository grader passes; index/setup failures remain visible as failed or blocked runs.

The Urdira arm was rerun in this campaign (complete: 8/8 cells). Existing comparison-arm rows were reused from the prior audited campaign: baseline, codebase-memory, codegraph. They were not re-executed in this run.

The estimated cost uses the explicit planning card in the JSON report and is not a provider invoice. Raw transcripts and host logs are retained outside the repository and bound by the audit SHA-256.

## Arm summary

| Arm | Correct | Median setup ms | Median agent ms | Median total ms | Median tokens | Median cost USD | Median MCP calls | Median failed MCP calls | Discovery MCP passed |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline | 6/8 | 561 | 172117 | 172224 | 2,057,856 | 4.2704 | 0 | — | — |
| urdira-typescript | 8/8 | 37210 | 337041 | 369430 | 1,997,645 | 4.0814 | 24 | 0 | 206/211 |
| codebase-memory | 6/8 | 8528 | 204453 | 212620 | 4,006,620 | 8.2033 | 26 | — | — |
| codegraph | 7/8 | 12826 | 204772 | 259504 | 2,666,029 | 5.6089 | 7 | — | — |

## Viability assessment

Urdira passed 8/8 graders, but only 206/211 discovery calls succeeded (0 IPC timeouts, 0 incomplete-coverage responses, and 2 request-validation failures). Agents completed the graded diffs through narrow source inspection after MCP failures. Under this protocol the result does not yet support claiming Urdira as a viable code-intelligence replacement, and its token/cost measurements cannot be attributed to successful Urdira retrieval.


## Per-run measurements

| Repository | Task | Arm | Correct | Total tokens | Cost USD | Turns | MCP calls | Failed MCP | Discovery completed | Selector narrowing | Unexpected MCP failures | Useful discovery | Native source fallback | IPC timeouts | Setup ms | Agent elapsed ms | Peak RSS KiB | CPU % | SQLite bytes | CAS bytes | Bytes copied | Bytes transferred | Bytes decoded |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| typescript | transpile-diagnostic-callback | baseline | no | 207,961 | 0.4337 | 3 | 0 | — | — | — | — | — | — | — | 647 | 52940 | — | — | — | — | — | — | — |
| typescript | transpile-diagnostic-callback | urdira-typescript | yes | 2,445,798 | 4.9862 | 3 | 30 | 1 | 25/26 | 0 | 1 | 24 | yes | 0 | 32389 | 337041 | 1797888 | — | 493177536 | 37227184 | — | — | — |
| typescript | transpile-diagnostic-callback | codebase-memory | no | 345,075 | 0.7118 | 3 | 11 | — | — | — | — | — | — | — | 48644 | 67957 | — | — | — | — | — | — | — |
| typescript | transpile-diagnostic-callback | codegraph | yes | 2,585,203 | 5.3329 | 3 | 7 | — | — | — | — | — | — | — | 86618 | 204772 | — | — | — | — | — | — | — |
| typescript | session-project-event-hook | baseline | no | 3,503,306 | 7.2137 | 3 | 0 | — | — | — | — | — | — | — | 561 | 239102 | — | — | — | — | — | — | — |
| typescript | session-project-event-hook | urdira-typescript | yes | 4,377,568 | 8.9305 | 3 | 67 | 3 | 61/64 | 3 | 0 | 57 | no | 0 | 31811 | 682670 | 1761232 | — | 674352880 | 38941597 | — | — | — |
| typescript | session-project-event-hook | codebase-memory | no | 7,042,049 | 14.2749 | 3 | 30 | — | — | — | — | — | — | — | 44459 | 233295 | — | — | — | — | — | — | — |
| typescript | session-project-event-hook | codegraph | no | 6,711,991 | 13.6686 | 3 | 10 | — | — | — | — | — | — | — | 85135 | 317544 | — | — | — | — | — | — | — |
| playwright | affected-tests-deterministic | baseline | yes | 2,057,856 | 4.2704 | 3 | 0 | — | — | — | — | — | — | — | 50 | 172297 | — | — | — | — | — | — | — |
| playwright | affected-tests-deterministic | urdira-typescript | yes | 1,580,542 | 3.2449 | 3 | 26 | 1 | 21/22 | 0 | 1 | 20 | no | 0 | 36359 | 274834 | 2083200 | — | 604284264 | 29190907 | — | — | — |
| playwright | affected-tests-deterministic | codebase-memory | yes | 4,006,620 | 8.2033 | 3 | 26 | — | — | — | — | — | — | — | 5981 | 215310 | — | — | — | — | — | — | — |
| playwright | affected-tests-deterministic | codegraph | yes | 2,917,732 | 5.9951 | 3 | 10 | — | — | — | — | — | — | — | 11444 | 185059 | — | — | — | — | — | — | — |
| playwright | reporter-error-isolation | baseline | yes | 1,705,956 | 3.5833 | 3 | 0 | — | — | — | — | — | — | — | 869 | 169460 | — | — | — | — | — | — | — |
| playwright | reporter-error-isolation | urdira-typescript | yes | 2,437,140 | 4.9900 | 3 | 35 | 0 | 32/32 | 0 | 0 | 24 | no | 0 | 37210 | 345055 | 1881200 | — | 599900736 | 29310206 | — | — | — |
| playwright | reporter-error-isolation | codebase-memory | yes | 4,232,360 | 8.6607 | 3 | 31 | — | — | — | — | — | — | — | 5631 | 199508 | — | — | — | — | — | — | — |
| playwright | reporter-error-isolation | codegraph | yes | 2,666,029 | 5.6089 | 3 | 5 | — | — | — | — | — | — | — | 11288 | 248216 | — | — | — | — | — | — | — |
| prisma | wire-name-validation | baseline | yes | 2,108,846 | 4.3976 | 3 | 0 | — | — | — | — | — | — | — | 107 | 172117 | — | — | — | — | — | — | — |
| prisma | wire-name-validation | urdira-typescript | yes | 1,570,430 | 3.2214 | 3 | 21 | 0 | 18/18 | 0 | 0 | 17 | no | 0 | 59178 | 252021 | 2288944 | — | 943864688 | 45458916 | — | — | — |
| prisma | wire-name-validation | codebase-memory | yes | 3,287,321 | 6.7769 | 3 | 24 | — | — | — | — | — | — | — | 8167 | 204453 | — | — | — | — | — | — | — |
| prisma | wire-name-validation | codegraph | yes | 2,371,730 | 4.8876 | 3 | 6 | — | — | — | — | — | — | — | 12135 | 157160 | — | — | — | — | — | — | — |
| prisma | mongo-value-set-transform | baseline | yes | 1,468,030 | 3.0677 | 3 | 0 | — | — | — | — | — | — | — | 305 | 151714 | — | — | — | — | — | — | — |
| prisma | mongo-value-set-transform | urdira-typescript | yes | 1,059,619 | 2.1778 | 3 | 12 | 0 | 9/9 | 0 | 0 | 9 | no | 0 | 59686 | 200391 | 2350800 | — | 992890008 | 45400441 | — | — | — |
| prisma | mongo-value-set-transform | codebase-memory | yes | 3,168,886 | 6.4521 | 3 | 26 | — | — | — | — | — | — | — | 8528 | 143002 | — | — | — | — | — | — | — |
| prisma | mongo-value-set-transform | codegraph | yes | 2,550,210 | 5.2348 | 3 | 7 | — | — | — | — | — | — | — | 12826 | 173493 | — | — | — | — | — | — | — |
| vscode | language-registry-change-notification | baseline | yes | 3,765,815 | 7.8445 | 3 | 0 | — | — | — | — | — | — | — | 991 | 296348 | — | — | — | — | — | — | — |
| vscode | language-registry-change-notification | urdira-typescript | yes | 2,536,450 | 5.1722 | 3 | 24 | 0 | 21/21 | 0 | 0 | 19 | no | 0 | 293450 | 477192 | 4921168 | — | 5253536192 | 222642943 | — | — | — |
| vscode | language-registry-change-notification | codebase-memory | yes | 6,153,542 | 12.5841 | 3 | 26 | — | — | — | — | — | — | — | 77429 | 380214 | — | — | — | — | — | — | — |
| vscode | language-registry-change-notification | codegraph | yes | 4,248,636 | 8.7159 | 3 | 13 | — | — | — | — | — | — | — | 82945 | 297003 | — | — | — | — | — | — | — |
| vscode | language-provider-registration-idempotence | baseline | yes | 2,158,052 | 4.5073 | 3 | 0 | — | — | — | — | — | — | — | 1242 | 188859 | — | — | — | — | — | — | — |
| vscode | language-provider-registration-idempotence | urdira-typescript | yes | 1,997,645 | 4.0814 | 3 | 22 | 0 | 19/19 | 0 | 0 | 18 | yes | 0 | 318742 | 475098 | 4804240 | — | 6343119360 | 222651480 | — | — | — |
| vscode | language-provider-registration-idempotence | codebase-memory | yes | 5,509,441 | 11.2253 | 3 | 33 | — | — | — | — | — | — | — | 78036 | 314356 | — | — | — | — | — | — | — |
| vscode | language-provider-registration-idempotence | codegraph | yes | 3,940,417 | 8.1186 | 3 | 11 | — | — | — | — | — | — | — | 82488 | 293939 | — | — | — | — | — | — | — |

## Gate

- Expected runs: 32
- Observed runs: 32
- Correct runs: 27
- Failed or blocked runs: 5
- Campaign gate passed: false

See the JSON file for grouped medians/means, setup evidence, correctness evidence, and failure messages.

## Indexing and readiness evidence

The Urdira host records every published frontier transition. `readiness_ms` is the time from host start to the benchmark readiness boundary (source-first structural stage); `source_ready_ms` and `structural_ready_ms` are the first observed corresponding frontier timestamps. Stage timings are emitted by the indexer and are not inferred from agent elapsed time.

| Repository | Task | Readiness ms | Source ready ms | Structural ready ms | Source catalog ms | Plugin analysis ms | Publish ms | Analysis acceptance ms | Peak RSS KiB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| typescript | transpile-diagnostic-callback | 31317 | 3307 | 22856 | 1864 | 6044 | 18763 | 5880 | 1797888 |
| typescript | session-project-event-hook | 30682 | 3146 | 21933 | 1778 | 5688 | 18027 | 5543 | 1761232 |
| playwright | affected-tests-deterministic | 35506 | 9548 | 34307 | 6691 | 9110 | 23685 | 8917 | 2083200 |
| playwright | reporter-error-isolation | 36051 | 9634 | 34873 | 6711 | 9327 | 24275 | 9131 | 1881200 |
| prisma | wire-name-validation | 58654 | 17239 | 57332 | 19248 | 11476 | 29693 | 11302 | 2288944 |
| prisma | mongo-value-set-transform | 58689 | 17313 | 57370 | 19434 | 11181 | 29602 | 11005 | 2350800 |
| vscode | language-registry-change-notification | 291812 | 21058 | 278625 | 79613 | 62193 | 188271 | 61310 | 4921168 |
| vscode | language-provider-registration-idempotence | 316167 | 24425 | 301227 | 80338 | 57925 | 209457 | 57050 | 4804240 |
