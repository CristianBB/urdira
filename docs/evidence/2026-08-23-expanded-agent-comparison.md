# Expanded agent comparison after the accepted v3 rerun

Date: 2026-08-23

## Scope and provenance

This comparison reruns only the `urdira-typescript` arm with the latest Urdira
v3 implementation. Baseline, codebase-memory MCP, and CodeGraph were not
re-executed. Their 24 derived rows are reused unchanged from
`expanded-typescript-agent-benchmark-results-2026-08-20.json`.

All arms use the frozen corpus in
`release/benchmarks/expanded-typescript-agent-benchmark.json`: model
`gpt-5.6-luna`, the same two tasks per repository, and the same commits for
TypeScript, Playwright, Prisma, and VS Code. The fresh Urdira arm used Node
`v24.18.1`, semantic indexing disabled, fresh detached worktrees, fresh data
roots, the 5,000,000 KiB RSS guard, and one sequential sample per cell.

Provenance:

- fresh accepted Urdira audit SHA-256:
  `75f502b1163a4123c37ee153e7fec5c0a7a913adbff5d8d2ec5e03c7c6a4f61f`;
- reused historical audit SHA-256:
  `bce2e1c9869113e9ec6f068b0badda958ae375a137295ecab17034f24a38ffa1`.

The fresh raw transcripts, host logs, manifests, and audit remain outside the
repository. The committed report contains sanitized derived measurements and
grader evidence. Every Urdira transcript was reviewed before the next cell was
started. Invalid attempts were rejected and are not part of the eight accepted
rows.

## Comparative result

| Arm | Correct | Median setup | Median agent | Median total | Median tokens | Median cost |
|---|---:|---:|---:|---:|---:|---:|
| Baseline | 6/8 | 0.561 s | 172.117 s | 172.224 s | 2,057,856 | $4.2704 |
| Urdira TypeScript v3 | 8/8 | 62.469 s | 428.402 s | 504.822 s | 2,406,340 | $4.9379 |
| Codebase-memory MCP | 6/8 | 8.528 s | 204.453 s | 212.620 s | 4,006,620 | $8.2033 |
| CodeGraph | 7/8 | 12.826 s | 204.772 s | 259.504 s | 2,666,029 | $5.6089 |

The combined report contains all 32 expected rows and 27 correct results. Its
overall gate remains false because five historical comparison rows failed
their graders. The fresh Urdira sub-gate is independently complete and passed
8/8.

Urdira is the only arm that passed all eight tasks. Its median token and cost
figures are about 40% lower than codebase-memory and about 10% and 12% lower
than CodeGraph, respectively. Against baseline, however, Urdira used about 17%
more tokens, cost about 16% more, and took about 193% longer. The current
evidence therefore establishes functional viability, not performance parity.

## Urdira readiness and resources

| Repository / task | Readiness | Peak RSS KiB | Grader |
|---|---:|---:|---:|
| TypeScript / transpile diagnostic | 43.179 s | 1,871,424 | passed |
| TypeScript / project event hook | 38.790 s | 1,753,040 | passed |
| Playwright / affected tests | 61.335 s | 1,809,392 | passed |
| Playwright / reporter isolation | 59.882 s | 2,113,584 | passed |
| Prisma / wire-name validation | 113.662 s | 2,530,112 | passed |
| Prisma / Mongo value-set transform | 113.133 s | 2,529,232 | passed |
| VS Code / registry notification | 469.194 s | 4,483,904 | passed |
| VS Code / provider idempotence | 472.613 s | 4,550,176 | passed |

Every accepted cell reached the complete structural frontier and stayed below
the memory guard. VS Code remains the limiting case: initial readiness takes
about 7.8 minutes and its two agent phases took 1,001 and 808 seconds. This is
usable for correctness-sensitive work, but it is not yet an interactive-speed
replacement for the comparison tools on repositories of that size.

## Transcript and operation audit

The audit separates `urdira_index_status` health checks from discovery calls
and distinguishes a typed selector-narrowing response from an unexpected MCP
failure:

| Urdira outcome | Count |
|---|---:|
| All Urdira calls | 414 |
| Status calls | 26 |
| Discovery calls (`urdira_context` or `urdira_query`) | 388 |
| Discovery calls completed directly | 380 |
| Typed `core:selector_ambiguous` narrowing responses | 8 |
| Unexpected MCP failures | 0 |
| Useful completed discovery results | 318 |
| Legitimate empty searches | 62 |
| API v3 discovery requests | 388/388 |
| Explicit single-workspace discovery requests | 388/388 |
| Cells using Urdira before editing | 8/8 |
| Cells rediscovering through Urdira after editing | 8/8 |
| Cells degrading to native source-reading tools | 0/8 |

The eight selector responses occurred in two cells. The agent received the
closed `core:selector_ambiguous` error and continued with narrower selectors or
artifact-based Urdira queries; it did not switch to shell source discovery.
Shell activity was restricted to editing, `git diff`/`git status`, formatting
checks, and focused test attempts. Repository dependency or toolchain failures
remain visible in the transcripts and are not represented as passing tests.

This satisfies the acceptance rule that the graded changes must be attributable
to Urdira discovery rather than fallback inspection. Urdira is therefore a
viable code-intelligence alternative under this functional protocol. The
qualification is important: the result is one sequential sample per cell, and
large-repository setup and post-edit freshness latency still need substantial
improvement before claiming general performance competitiveness.

## Rejected attempts and corrective work

The sequential transcript gate exposed defects that ordinary grader-only
acceptance would have missed. Rejected attempts included query widening and
source-projection defects, stale or malformed freshness requests, watcher
rearm exhaustion, memory-budget breaches, an over-truncated MCP source
renderer, and agents constructing invalid v3 request shapes. The campaign was
paused after each such cell; the underlying implementation, runner, or MCP
instructions were corrected before repeating that cell.

The accepted campaign includes the resulting fixes:

- exact source-catalog/CAS `search_text` behavior while lexical maintenance is
  incomplete, including normalized path/generated/external filters;
- bounded direct `get_source` and context retrieval instead of broad decoded
  corpus materialization;
- full MCP source rendering and explicit v3 option/freshness examples;
- coalesced FSEvents recovery with delayed, generation-safe watcher rearming;
- post-edit structural freshness waits and durable wait-duration evidence in
  the benchmark runner.

## Report artifacts

- `release/benchmarks/expanded-typescript-agent-benchmark-results-2026-08-23.json`;
- `release/benchmarks/expanded-typescript-agent-benchmark-results-2026-08-23.md`;
- `release/benchmarks/expanded-typescript-agent-benchmark.json`.

This campaign is a functional and comparative observation, not a P95
measurement. P95 remains ineligible until at least three independent campaigns
are available.
