# Expanded TypeScript agent benchmark results

Generated from the sequential audit for four frozen TypeScript repositories. A cell is successful only when the repository grader passes; index/setup failures remain visible as failed or blocked runs.

This campaign executed only the following arm: urdira-typescript. No comparison-arm result was reused or implied.

The estimated cost uses the explicit planning card in the JSON report and is not a provider invoice. Raw transcripts and host logs are retained outside the repository and bound by the audit SHA-256.

## Per-run measurements

| Repository | Task | Arm | Correct | Total tokens | Cost USD | Turns | MCP calls | Setup ms | Agent elapsed ms | Peak RSS KiB | CPU % | SQLite bytes | CAS bytes | Bytes copied | Bytes transferred | Bytes decoded |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| typescript | transpile-diagnostic-callback | urdira-typescript | yes | 1,373,749 | 2.8361 | 3 | 5 | 42781 | 292638 | 2764384 | 53.5 | 556506592 | 37154866 | — | — | — |
| typescript | session-project-event-hook | urdira-typescript | yes | 2,183,140 | 4.5173 | 3 | 8 | 42689 | 435324 | 2818080 | 66.2 | 587988448 | 38366155 | — | — | — |
| playwright | affected-tests-deterministic | urdira-typescript | yes | 1,324,884 | 2.7348 | 3 | 6 | 61714 | 292058 | 1497344 | 43.9 | 673033720 | 29134777 | — | — | — |
| playwright | reporter-error-isolation | urdira-typescript | yes | 921,008 | 1.9425 | 3 | 4 | 63243 | 294409 | 1893760 | 74.8 | 698482720 | 29134061 | — | — | — |
| prisma | wire-name-validation | urdira-typescript | yes | 921,574 | 1.9179 | 3 | 3 | 112291 | 222910 | 1619376 | 78.7 | 1045631920 | 45425448 | — | — | — |
| prisma | mongo-value-set-transform | urdira-typescript | yes | 912,912 | 1.8911 | 3 | 5 | 119397 | 249105 | 1679680 | 75.2 | 1045800240 | 45397492 | — | — | — |
| vscode | language-registry-change-notification | urdira-typescript | yes | 1,179,829 | 2.4663 | 3 | 3 | 469406 | 338020 | 4260144 | 105.2 | 5355332280 | 222632044 | — | — | — |
| vscode | language-provider-registration-idempotence | urdira-typescript | yes | 1,106,914 | 2.3133 | 3 | 5 | 468481 | 292344 | 4365792 | 100.5 | 5360752464 | 222637358 | — | — | — |

## Gate

- Expected runs: 8
- Observed runs: 8
- Correct runs: 8
- Failed or blocked runs: 0
- Campaign gate passed: true

See the JSON file for grouped medians/means, setup evidence, correctness evidence, and failure messages.

## Indexing and readiness evidence

The Urdira host records every published frontier transition. `readiness_ms` is the time from host start to the benchmark readiness boundary (source-first structural stage); `source_ready_ms` and `structural_ready_ms` are the first observed corresponding frontier timestamps. Stage timings are emitted by the indexer and are not inferred from agent elapsed time.

| Repository | Task | Readiness ms | Source ready ms | Structural ready ms | Source catalog ms | Plugin analysis ms | Publish ms | Analysis acceptance ms | Peak RSS KiB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| typescript | transpile-diagnostic-callback | 42172 | 7664 | 42172 | 5979 | 7805 | 33847 | 7560 | 2764384 |
| typescript | session-project-event-hook | 41944 | 7467 | 41944 | 5937 | 7827 | 33682 | 7583 | 2818080 |
| playwright | affected-tests-deterministic | 60738 | 25021 | 60738 | 21990 | 11557 | 34886 | 11240 | 1497344 |
| playwright | reporter-error-isolation | 62268 | 26360 | 62268 | 23500 | 11414 | 34914 | 11096 | 1893760 |
| prisma | wire-name-validation | 111620 | 38055 | 111620 | 55516 | 16741 | 47533 | 16304 | 1619376 |
| prisma | mongo-value-set-transform | 118882 | 45127 | 118882 | 63028 | 16893 | 47268 | 16432 | 1679680 |
| vscode | language-registry-change-notification | 469065 | 48979 | 469065 | 166912 | 83187 | 280946 | 78644 | 4260144 |
| vscode | language-provider-registration-idempotence | 467016 | 49137 | 467016 | 166655 | 83117 | 278948 | 78564 | 4365792 |
