# Agent-facing MCP integration evidence

Status: measured evidence, one directed sample per task
Date: 2026-09-11

## Scope and source artifacts

This note records the agent-integration audit, the later structural schema gate,
and the related `measurement-v1` comparison. The raw artifacts are retained
outside the repository:

- `/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-11-post-improvements/agent-integration-v1/`
- `/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-11-post-improvements/agent-integration-schema-gate-v2/`
- `/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-11-post-improvements/measurement-v1/`

The runs used the production MCP adapter, structural readiness, one Luna sample,
and semantic work disabled (`urdira_semantic_index=false`,
`urdira_semantic_materialization=false`, and no semantic sidecar). The recorded
Node runtime was v24.18.1, with analysis and structural concurrency set to one.
No competitor runs were included.

The integration sample started from HEAD
`94893b1a0119fa6bb35566a75d29c1b627165fd5`. The MCP integration changes were
compiled in the working tree and were not committed during measurement. The
`measurement-v1/audit.json` later records source head
`cc31b33b513213e268b01158d713a79d112ffa3c`; that generated audit identity is
retained as evidence and must not be treated as a clean release baseline.
The integration audit records dirty-diff SHA-256
`sha256:c3f185b458122fb362a762255e1be2a3c38cf8a5efa75dd4624a66e699f95fb4`.
Its driver and runner hashes were respectively
`sha256:3a1241ac27c911486d3880ab3266fcd6c8ce8299e17e2057cc857f73464d0ca5`
and `sha256:bc846c9aaeb4bbd4ce42d1e3480363d167e43a8c7727b129e9fd85756ff76739`.
The worker attestation recorded
`sha256:b4c4fbc271b34cd8db2f50e26206e71f9397b2a5a07561e6f3dd67a99e6baf6e`.

## What changed

The MCP presentation now gives a compact, generic choice rule: call
`urdira_index_status` once when `query_scope` is absent and reuse the returned
scope; use a direct operation for one known subject, path, symbol, or exact
intention; use `urdira_context` for multifaceted discovery; use a registered
recipe for a named workflow; and use a pipeline when a real dependency exists.
It explains continuation by copying the complete `ContinuationRequest` envelope.
The adapter keeps operation `arguments` generic while its authoritative registry
validates the selected operation. The examples are copyable agent-facing
contract guidance. Repository discovery and source reading are directed to
Urdira first; shell remains appropriate for editing, tests, builds, and Git.

The measured change was presentation and instruction ergonomics. It did not
make Urdira an editing or test-running interface. Source and test discovery
duplication therefore remains possible, and the agent still needs shell for
edits and verification.

## Directed agent-integration sample

The four-task `agent-integration-v1` sample produced two successful and two
failed graded runs:

| Repository / task | Result | Readiness ms | MCP calls | Shell calls | Repository reads | Context characters | Failure |
|---|---:|---:|---:|---:|---:|---:|---|
| Playwright / affected-tests-deterministic | pass | 4,942 | 0 | 12 | 12 | 83,591 | — |
| Playwright / reporter-error-isolation | fail | 4,942 | 7 | 13 | 20 | 115,521 | `run failed (exit_code=0, grader_exit_code=1)` |
| VS Code / language-registry-change-notification | fail | 39,750 | 4 | 13 | 17 | 133,123 | `run failed (exit_code=0, grader_exit_code=1)` |
| VS Code / language-provider-registration-idempotence | pass | 37,821 | 4 | 9 | 13 | 121,793 | — |

The Playwright affected-tests task chose zero MCP in this sample. That is agent
variance, not evidence that the MCP path is unavailable. The two failed rows
retain their raw transcripts and grader diagnostics; they are not silently
converted into successes.

For the VS Code language-registry task, the successful MCP context was about
5.7k plus 7.25k characters, with status contributing about 1.1k. Two shell
`rg` reads each produced 1,048,606 characters. Consequently the recorded
2,578,397 context-character total was shell-dominated. Urdira source/context
helped with discovery, but it did not find or read the complete test harness.

## Focused schema gate

`agent-integration-schema-gate-v2` was a separate, targeted two-task gate. Both
runs passed, with zero invalid payloads and no repeated status call:

| Repository / task | Result | Readiness ms | MCP | Shell | Status calls | Invalid payloads | Reads | Context chars | RSS KiB | CPU % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Playwright / reporter-error-isolation | pass | 5,186 | 5 | 13 | 1 | 0 | 18 | 129,645 | 725,008 | 3.79 |
| VS Code / language-registry-change-notification | pass | 37,643 | 2 | 18 | 1 | 0 | 20 | 2,578,397 | 3,671,808 | 11.65 |

This gate validates the corrected request presentation and schema handling for
those two tasks. It is not a full campaign and does not establish causality.

## Per-task comparison with `measurement-v1`

The following preserves the per-task observations rather than treating the
single sample as a causal estimate. `measurement-v1` used the same semantic-off
structural contract; its raw rows are under its `runs/` directory.

| Repository / task | Measurement-v1 | Integration-v1 | Measurement-v1 MCP / shell | Integration-v1 MCP / shell |
|---|---:|---:|---:|---:|
| TypeScript / transpile-diagnostic-callback | pass | not sampled | 3 / 11 | — |
| TypeScript / session-project-event-hook | pass | not sampled | 2 / 13 | — |
| Playwright / affected-tests-deterministic | pass | pass | 3 / 10 | 0 / 12 |
| Playwright / reporter-error-isolation | pass | fail | 0 / 11 | 7 / 13 |
| Prisma / wire-name-validation | pass | not sampled | 2 / 8 | — |
| Prisma / mongo-value-set-transform | fail | not sampled | 3 / 6 | — |
| VS Code / language-registry-change-notification | pass | fail | 1 / 17 | 4 / 13 |
| VS Code / language-provider-registration-idempotence | pass | pass | 0 / 25 | 4 / 9 |

The rows differ in prompts, run composition, and agent decisions, so these are
observational comparisons. The focused gate's two successes show valid MCP
payloads under the corrected presentation; they do not turn the four-task
sample into a campaign result.

## Limits and interpretation

This is one sample per task and includes substantial agent variance. In
particular, Playwright affected-tests moved from MCP use in `measurement-v1` to
zero MCP in `agent-integration-v1`, while the reporter and VS Code provider
workflows moved from zero-MCP or limited use to MCP use in some rows. The data
supports a plausible ergonomics effect, but not a causal claim. MCP discovery
and source responses can help, while source/test discovery duplication remains
because the agent may reread with shell. Shell is a legitimate and necessary
boundary for editing, tests, builds, and Git inspection. The schema gate is a
targeted contract check, not the complete benchmark campaign.

## Final verification

The first `CI=true pnpm verify` run detected that
`tests/mcp-response-deduplication.test.ts` expected a loose cursor. The test
was aligned with the complete `ContinuationRequest` contract, after which the
full verification passed with exit 0:

- Coverage: 156 files; 2,344 tests passed; 15 skipped.
- Lines: 90.34%; critical branches: 100%; semantic regions: 100%.
- Publication check: 1,112 files.
