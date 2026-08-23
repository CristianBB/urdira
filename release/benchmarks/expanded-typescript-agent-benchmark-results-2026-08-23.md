# Expanded TypeScript agent benchmark results

Generated from the sequential audit for four frozen TypeScript repositories. A cell is successful only when the repository grader passes; index/setup failures remain visible as failed or blocked runs.

The Urdira arm was rerun in this campaign (complete: 8/8 cells). Existing comparison-arm rows were reused from the prior audited campaign: baseline, codebase-memory, codegraph. They were not re-executed in this run.

The estimated cost uses the explicit planning card in the JSON report and is not a provider invoice. Raw transcripts and host logs are retained outside the repository and bound by the audit SHA-256.

## Arm summary

| Arm | Correct | Median setup ms | Median agent ms | Median total ms | Median tokens | Median cost USD | Median MCP calls | Median failed MCP calls | Discovery MCP passed |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline | 6/8 | 561 | 172117 | 172224 | 2,057,856 | 4.2704 | 0 | — | — |
| urdira-typescript | 8/8 | 62469 | 428402 | 504822 | 2,406,340 | 4.9379 | 41 | 0 | 380/388 |
| codebase-memory | 6/8 | 8528 | 204453 | 212620 | 4,006,620 | 8.2033 | 26 | — | — |
| codegraph | 7/8 | 12826 | 204772 | 259504 | 2,666,029 | 5.6089 | 7 | — | — |

## Viability assessment

Urdira passed 8/8 graders. Of 388 discovery operations, 380 completed directly and 8 returned the typed core:selector_ambiguous recovery signal; there were 0 unexpected MCP failures. The completed calls included 318 useful results and 62 legitimate empty searches. Every discovery used API v3, an explicit single-workspace scope, Urdira before editing, and Urdira rediscovery after editing, with no native source-reading fallback. This campaign supports evaluating its timing, token, and cost trade-offs as a working code-intelligence alternative.


## Per-run measurements

| Repository | Task | Arm | Correct | Total tokens | Cost USD | Turns | MCP calls | Failed MCP | Discovery completed | Selector narrowing | Unexpected MCP failures | Useful discovery | Native source fallback | IPC timeouts | Setup ms | Agent elapsed ms | Peak RSS KiB | CPU % | SQLite bytes | CAS bytes | Bytes copied | Bytes transferred | Bytes decoded |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| typescript | transpile-diagnostic-callback | baseline | no | 207,961 | 0.4337 | 3 | 0 | — | — | — | — | — | — | — | 647 | 52940 | — | — | — | — | — | — | — |
| typescript | transpile-diagnostic-callback | urdira-typescript | yes | 2,831,086 | 5.8065 | 3 | 52 | 0 | 49/49 | 0 | 0 | 38 | no | 0 | 43927 | 426787 | 1871424 | 26.3 | 531409744 | 37332371 | — | — | — |
| typescript | transpile-diagnostic-callback | codebase-memory | no | 345,075 | 0.7118 | 3 | 11 | — | — | — | — | — | — | — | 48644 | 67957 | — | — | — | — | — | — | — |
| typescript | transpile-diagnostic-callback | codegraph | yes | 2,585,203 | 5.3329 | 3 | 7 | — | — | — | — | — | — | — | 86618 | 204772 | — | — | — | — | — | — | — |
| typescript | session-project-event-hook | baseline | no | 3,503,306 | 7.2137 | 3 | 0 | — | — | — | — | — | — | — | 561 | 239102 | — | — | — | — | — | — | — |
| typescript | session-project-event-hook | urdira-typescript | yes | 5,447,946 | 11.1401 | 3 | 100 | 7 | 90/97 | 7 | 0 | 72 | no | 0 | 39649 | 744079 | 1753040 | 36.8 | 798734680 | 41730155 | — | — | — |
| typescript | session-project-event-hook | codebase-memory | no | 7,042,049 | 14.2749 | 3 | 30 | — | — | — | — | — | — | — | 44459 | 233295 | — | — | — | — | — | — | — |
| typescript | session-project-event-hook | codegraph | no | 6,711,991 | 13.6686 | 3 | 10 | — | — | — | — | — | — | — | 85135 | 317544 | — | — | — | — | — | — | — |
| playwright | affected-tests-deterministic | baseline | yes | 2,057,856 | 4.2704 | 3 | 0 | — | — | — | — | — | — | — | 50 | 172297 | — | — | — | — | — | — | — |
| playwright | affected-tests-deterministic | urdira-typescript | yes | 2,406,340 | 4.9379 | 3 | 54 | 0 | 51/51 | 0 | 0 | 44 | no | 0 | 62469 | 438499 | 1809392 | 31.2 | 685790296 | 29125319 | — | — | — |
| playwright | affected-tests-deterministic | codebase-memory | yes | 4,006,620 | 8.2033 | 3 | 26 | — | — | — | — | — | — | — | 5981 | 215310 | — | — | — | — | — | — | — |
| playwright | affected-tests-deterministic | codegraph | yes | 2,917,732 | 5.9951 | 3 | 10 | — | — | — | — | — | — | — | 11444 | 185059 | — | — | — | — | — | — | — |
| playwright | reporter-error-isolation | baseline | yes | 1,705,956 | 3.5833 | 3 | 0 | — | — | — | — | — | — | — | 869 | 169460 | — | — | — | — | — | — | — |
| playwright | reporter-error-isolation | urdira-typescript | yes | 2,358,295 | 4.8498 | 3 | 69 | 0 | 65/65 | 0 | 0 | 53 | no | 0 | 61010 | 428402 | 2113584 | 41.8 | 702640880 | 29128976 | — | — | — |
| playwright | reporter-error-isolation | codebase-memory | yes | 4,232,360 | 8.6607 | 3 | 31 | — | — | — | — | — | — | — | 5631 | 199508 | — | — | — | — | — | — | — |
| playwright | reporter-error-isolation | codegraph | yes | 2,666,029 | 5.6089 | 3 | 5 | — | — | — | — | — | — | — | 11288 | 248216 | — | — | — | — | — | — | — |
| prisma | wire-name-validation | baseline | yes | 2,108,846 | 4.3976 | 3 | 0 | — | — | — | — | — | — | — | 107 | 172117 | — | — | — | — | — | — | — |
| prisma | wire-name-validation | urdira-typescript | yes | 1,603,943 | 3.2908 | 3 | 41 | 1 | 37/38 | 1 | 0 | 30 | no | 0 | 114134 | 426861 | 2530112 | 71.6 | 1118282544 | 45466609 | — | — | — |
| prisma | wire-name-validation | codebase-memory | yes | 3,287,321 | 6.7769 | 3 | 24 | — | — | — | — | — | — | — | 8167 | 204453 | — | — | — | — | — | — | — |
| prisma | wire-name-validation | codegraph | yes | 2,371,730 | 4.8876 | 3 | 6 | — | — | — | — | — | — | — | 12135 | 157160 | — | — | — | — | — | — | — |
| prisma | mongo-value-set-transform | baseline | yes | 1,468,030 | 3.0677 | 3 | 0 | — | — | — | — | — | — | — | 305 | 151714 | — | — | — | — | — | — | — |
| prisma | mongo-value-set-transform | urdira-typescript | yes | 1,718,194 | 3.5111 | 3 | 32 | 0 | 29/29 | 0 | 0 | 27 | no | 0 | 113524 | 391298 | 2529232 | 73.3 | 1155757536 | 45396695 | — | — | — |
| prisma | mongo-value-set-transform | codebase-memory | yes | 3,168,886 | 6.4521 | 3 | 26 | — | — | — | — | — | — | — | 8528 | 143002 | — | — | — | — | — | — | — |
| prisma | mongo-value-set-transform | codegraph | yes | 2,550,210 | 5.2348 | 3 | 7 | — | — | — | — | — | — | — | 12826 | 173493 | — | — | — | — | — | — | — |
| vscode | language-registry-change-notification | baseline | yes | 3,765,815 | 7.8445 | 3 | 0 | — | — | — | — | — | — | — | 991 | 296348 | — | — | — | — | — | — | — |
| vscode | language-registry-change-notification | urdira-typescript | yes | 3,770,167 | 7.6684 | 3 | 27 | 0 | 24/24 | 0 | 0 | 22 | no | 0 | 471124 | 1001076 | 4483904 | 102.4 | 5918208176 | 222643957 | — | — | — |
| vscode | language-registry-change-notification | codebase-memory | yes | 6,153,542 | 12.5841 | 3 | 26 | — | — | — | — | — | — | — | 77429 | 380214 | — | — | — | — | — | — | — |
| vscode | language-registry-change-notification | codegraph | yes | 4,248,636 | 8.7159 | 3 | 13 | — | — | — | — | — | — | — | 82945 | 297003 | — | — | — | — | — | — | — |
| vscode | language-provider-registration-idempotence | baseline | yes | 2,158,052 | 4.5073 | 3 | 0 | — | — | — | — | — | — | — | 1242 | 188859 | — | — | — | — | — | — | — |
| vscode | language-provider-registration-idempotence | urdira-typescript | yes | 2,691,565 | 5.4789 | 3 | 39 | 0 | 35/35 | 0 | 0 | 32 | no | 0 | 473841 | 808210 | 4550176 | 95.1 | 8621297360 | 222638559 | — | — | — |
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
| typescript | transpile-diagnostic-callback | 43179 | 12024 | 41732 | 5997 | 7765 | 28484 | 7521 | 1871424 |
| typescript | session-project-event-hook | 38790 | 7241 | 37148 | 5915 | 7880 | 28673 | 7640 | 1753040 |
| playwright | affected-tests-deterministic | 61335 | 22218 | 59327 | 19403 | 11164 | 35761 | 10852 | 1809392 |
| playwright | reporter-error-isolation | 59882 | 21557 | 57988 | 18776 | 11403 | 35058 | 11073 | 2113584 |
| prisma | wire-name-validation | 113662 | 37050 | 111155 | 54479 | 16566 | 47788 | 16121 | 2530112 |
| prisma | mongo-value-set-transform | 113133 | 36621 | 110521 | 54064 | 16369 | 47611 | 15929 | 2529232 |
| vscode | language-registry-change-notification | 469194 | 40647 | 455390 | 157019 | 83763 | 276244 | 79129 | 4483904 |
| vscode | language-provider-registration-idempotence | 472613 | 40844 | 460429 | 158595 | 83394 | 268516 | 78837 | 4550176 |

## Readiness optimization experiments (2026-08-23)

The internal timings are now opt-in from the executable CLI: append
`--debug-timing` to `urdira daemon start`, `index`, `query`, `status`, or
`mcp`. The flag propagates to the daemon child and SQLite worker threads;
without it, the storage timing buckets remain disabled. The raw controlled
experiment output is in
[`readiness-optimization-results-2026-08-23.json`](readiness-optimization-results-2026-08-23.json)
and the harness is
[`readiness-optimization-benchmark.mjs`](readiness-optimization-benchmark.mjs).

The harness used 5,000 rows and 160 TypeScript files on Node `v24.18.1`.
These are microbenchmarks, not replacement end-to-end readiness claims:

| Hypothesis | Observed result | Decision |
|---|---:|---|
| Pack small CAS files / grouped fsync | 819 ms sequential vs 572 ms batched (1.43x); one directory flush per batch | Keep the existing batched path; a new archive format is not justified by this sample. |
| Avoid duplicate staging/publication | 623 ms for 128 duplicate entries vs 150 ms after input digest de-duplication (4.15x); CAS fsync count stayed at 32 | Add de-duplication before CAS/staging command construction; this is the clearest low-risk write-path win. |
| Larger SQLite/prepared inserts | chunk 500: 9 ms; 2,000: 9 ms; 8,000: 11 ms; one materialized transaction: 15 ms | Keep prepared statements and bounded chunks; do not increase the chunk cap blindly. The current 30k-parameter bound is already near the useful knee. |
| Defer secondary indexes | 9 ms eager vs 8 ms deferred (1 ms index build) | Defer non-critical indexes, but expect only a small benefit at this scale; validate on VS Code-sized tables before making it default. |
| Parallel independent packages/tsconfig | 1,575 ms serial vs 546 ms with eight worker jobs (2.88x) | Prioritize bounded parallelism across independent projects; cap workers by CPU/RSS and never parallelize same-workspace publication writers. |
| Reuse exact analysis by digest | 74 ms first build vs 2 ms second worker (37x) | Keep the durable digest cache and make its shared installation scope explicit; this directly attacks repeated workspace readiness. |
| Append-only staging vs SQLite / Redis control | append-only 7/0 ms write/read; SQLite 7/0 ms; Redis 9/5 ms for 5,000 rows | Append-only is a useful transient queue only if followed by a durable, transactional promotion. Redis adds a network/process hop and is not an improvement for this local write path. |

The end-to-end measurements above still identify readiness—not query
execution—as the dominant bottleneck on large repositories: VS Code spends
157–159 s in source cataloging, 83–84 s in plugin analysis, 77–80 s sealing,
and roughly 108–113 s in publication/storage before structural readiness at
469–473 s. The experiments therefore support three concrete next changes:
digest de-duplication before CAS and publication, bounded project-level
parallelism, and broader cross-workspace digest-cache reuse. Redis should not
be introduced as the indexing buffer unless a separate multi-process or
remote-ingester requirement appears; it would add operational and durability
cost without addressing the measured TypeScript/publication stages.

## Post-change VS Code control (2026-08-23)

A clean host-only control was run after this iteration against the same frozen
VS Code commit (`038b9225c82c6b75172beda6081c64887692538c`). It is not mixed
into the agent-arm medians above: it validates the readiness path and internal
buckets, not transcript correctness.

| Boundary / bucket | Clean control |
|---|---:|
| Source ready | 40,148 ms |
| Structural stage 1 ready | 454,789 ms |
| Final structural ready | 473,991 ms |
| Source catalog | 202,828 ms |
| Plugin analysis | 57,320 ms |
| Analysis acceptance (batched native FactDelta) | 52,735 ms |
| Seal | 77,353 ms |
| Publish | 242,407 ms |
| Publication plan build / SQLite transaction | 33,061 / 74,650 ms |

The batched native-acceptance path reduced that bucket versus the prior
78–79 s VS Code controls, but the end-to-end boundary remained about 474 s
because source cataloging and publication still dominate. CAS digest
de-duplication and the large stage-1 dependency-graph cache are therefore
useful for duplicate or repeated full scans, not a first-index cure. The next
high-value work is reducing per-file CAS durability overhead and the
publication plan/transaction, or making independent project partitions
publishable in bounded parallel lanes; Redis remains unsupported by the data.

## Optimized CAS/reindex control (commit `df637469`, 2026-08-23)

The clean first-index control with `URDIRA_CAS_PUT_CONCURRENCY=16` completed at
452.411 s. It remained correct (`source_ready`, all three structural stages,
and `ready` were observed; no degraded or fallback path). Compared with the
previous clean control, source cataloging fell from 202.828 s to 160.635 s
(about 21%), while publication was 259.018 s versus 242.407 s, so the first
index is still publication-bound.

The decisive result is the forced complete reindex on the same data root:
`core:reindex` returned `equivalent` in 102.636 s. Its source catalog took
92.320 s, CAS writes were 0 ms, and the SQLite commit was 38 ms. The provider
still enumerates and hashes the tree (8.537 s), but unchanged files are
validated by token/metadata and reuse their existing CAS references instead
of rereading and rewriting bytes. This is the path that makes periodic/full
reindexes materially cheaper; a one-file watcher edit remains on the existing
authoritative targeted path.

The updated microbenchmark also measured CAS concurrency (8/16/32/64 ms:
655/668/623/616) and an isolated append-only pack candidate (13 ms versus
617 ms for the current per-file batched CAS on 128 small blobs). The pack
number is a prototype only: before enabling it in production we still need a
durable pack index, random-access reads, crash recovery, reachability/GC and
verification integration. Redis remains outperformed and is not part of the
runtime path.
