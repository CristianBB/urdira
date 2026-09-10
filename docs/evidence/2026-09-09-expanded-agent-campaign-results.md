# Expanded agent benchmark campaign — 2026-09-09

## Scope and execution policy

This campaign was directed and executed by the `gpt-5.6-luna` benchmark subagent. The planned campaign is the four-arm comparison (`baseline`, `urdira-typescript`, `codebase-memory`, and `codegraph`) over the TypeScript, Playwright, Prisma, and VS Code repositories, with two tasks per repository and three sequential samples per cell (96 executions). Urdira readiness is bounded at the complete current structural frontier. Semantic indexing, semantic materialization, and semantic-sidecar creation are disabled.

The campaign did not reach the full-campaign gate. The driver requires a fresh 8/8 Urdira smoke before starting any samples. The next campaign adds the pinned Microsoft `tgrep` CLI as a fifth arm, for 120 cells (five arms × four repositories × two tasks × three samples); no five-arm comparison is reported until that gate passes.

## Fresh smoke evidence

The campaign output is retained in the benchmark archive under the run
directory `luna-campaign-20260909T1935`; the artifact names below identify the
preserved files without depending on a host-local path.

The first smoke (`smoke`) closed six cells before two contract failures and a controlled stop. The second (`smoke-corrected`) closed four cells before a corrected facet validation failure. Both are retained as invalidated evidence. The final smoke (`smoke-final`) closed six cells successfully, including the corrected TypeScript, Playwright, and Prisma tasks. Its VS Code large-repository cell did not reach readiness within the original 600,000 ms indexing-core timeout and recorded `Indexing-core worker request timed out`, `structural_ready=false`, `freshness_status=stale`, and `workspace_status=degraded`; the sequence was then stopped before the second VS Code task.

The contract corrections were applied to the historical Luna prompt guardrail: `urdira_context` had to use its closed facets (`definitions`, `implementations`, `callers`, `callees`, `dependencies`, `contracts`, `effects`, `tests`, `configuration`, `analogues`, `extension_points`), and `public_surfaces` was rejected. Shell source readers were prohibited for Urdira discovery. These instructions were tool-assigned and biased strategy selection; the corrected final smoke results were:

| Fresh output | Closed cells | Grader-successful cells | Gate result |
| --- | ---: | ---: | --- |
| `smoke` | 6 | 4 | invalidated |
| `smoke-corrected` | 4 | 3 | invalidated |
| `smoke-final` | 6 | 6 | incomplete; 2 VS Code cells outstanding |

The final smoke audit is `smoke-final/audit.json` in that retained run
directory. It contains six valid rows: both TypeScript tasks, both Playwright
tasks, and both Prisma tasks. The two VS Code tasks were not counted as
successful smoke rows.

## Size-tier timeout gate

The arming hypothesis was tested with one isolated VS Code `language-registry-change-notification` cell using a size-tier timeout of 1,800,000 ms for the L repository. The initial full structural readiness completed at approximately 15 minutes, proving that the old 600,000 ms transport ceiling was the immediate readiness failure. After the Luna agent edited two files, the watcher started a full delta typeflow pass over 12,945 files; the worker reported `typeflow build_index: 198.385s` for the delta stage but did not return a current frontier during the observed gate window. The process reached approximately 10 GiB RSS. This gate was stopped after the evidence was captured; its partial transcript, host log, and diff are retained under:

the retained run directory `smoke-large-gate/runs/`

The size-tier policy is now encoded in `run-expanded-agent-benchmark.mjs`: L repositories receive 1,800,000 ms for the cell and, for Urdira, the same `URDIRA_INDEXING_CORE_TIMEOUT_MS`; S/M repositories receive 900,000 ms. This changes only the finite structural deadline and does not enable semantic indexing.

## Reproducibility and verification

The relevant command shape for the final smoke was:

```text
node release/benchmarks/run-expanded-agent-benchmark.mjs --samples 1 --arms urdira-typescript --repositories typescript,playwright,prisma,vscode --repositories-root <benchmark-repositories-root> --output-dir <campaign-output>/smoke-final --node node --codex codex --codebase-memory codebase-memory-mcp --codegraph codegraph
```

## Comparator-only S/M execution after the Urdira stop

On 2026-09-10 the user explicitly stopped all further Urdira execution. The
resumed smoke that contained Urdira was invalidated and none of its Urdira
rows were reused. The four comparator arms were then run independently with
the same prompts, grader, size-tier timeouts, fresh worktrees, and three
samples per cell for Playwright (S) and Prisma (M).

The comparator smoke is stored in the retained run directory
`smoke-comparators-sm-v2`:
16/16 rows passed (4 arms x 2 repositories x 2 tasks, one sample). Its
rendered report is `report/smoke-comparators-sm-v2.{json,md}`.

The full comparator S/M campaign is stored in the retained run directory
`full-comparators-sm-v3`:
48/48 rows were materialized, with 46 successful and 2 failed or blocked
rows. By arm, baseline was 12/12 successful, codebase-memory 11/12,
CodeGraph 12/12, and tgrep 11/12. The two failed rows were preserved in the
audit and have no imputed measurements; both were comparator process/closure
failures. The rendered report is
`report/full-comparators-sm-v3.{json,md}`.

The report records setup and agent elapsed time, total tokens and estimated
cost, outer turns, MCP/discovery calls, repository reads and context
characters, grader/test outcomes, request failures, and process-tree RSS/CPU.
Its campaign gate is intentionally false because two of the 48 comparator
cells failed. The Urdira evidence remains frozen in the earlier
`smoke-tgrep-final-v3` output documented above; no Urdira cell was executed
after the explicit stop and missing Urdira values are not inferred from the
comparator campaign.

The full S/M audit SHA-256 is
`fd7a0e98ac0c062e8f56492592338ef490d389966f3916a36a5fdb3796565ae7` and the
rendered JSON SHA-256 is
`a58864ba502292046f77639d9d2d7e24f7cb1897c1c27f64330495424fc9f949`.
The pinned tgrep 1.0.5 binary was built from the official release; its
SHA-256 is
`231b4d1c835df8d257f36af400a466617c3b6bd6b42e34fa0a244e779aa235d9`.

The isolated L gate additionally set `URDIRA_BENCHMARK_TIMEOUT_MS=1800000` and `URDIRA_INDEXING_CORE_TIMEOUT_MS=1800000`. No full campaign or report renderer was run because the mandatory smoke gate was incomplete.

## Comparator-only L execution and combined evidence

After the explicit user stop on Urdira execution, the comparator arms ran their
remaining L matrix independently. The L comparator smoke was 16/16 successful
for TypeScript and VS Code. The full L comparator campaign is stored at
`full-comparators-l-v1` in the retained run directory:
48/48 rows were observed, 47 passed and one failed. Baseline was 12/12,
codebase-memory 12/12, CodeGraph 11/12, and tgrep 12/12. The failed row is
`vscode/language-provider-registration-idempotence/codegraph/sample-2` and is
retained without imputation. Its rendered report is
`report/full-comparators-l-v1.{json,md}`.

The combined per-task table, including success `n/N`, setup/agent/total
milliseconds, tokens, estimated cost, repository reads, context characters,
peak process-tree RSS, and the frozen Urdira column with `semantic=0`, is in
[2026-09-10-expanded-agent-combined-comparators.md](2026-09-10-expanded-agent-combined-comparators.md).
It joins 96 fresh comparator cells (48 S/M plus 48 L) with seven frozen Urdira
rows. Urdira is `n=1` per observed task; comparators are `n=3` per task. The
Urdira aggregate is explicitly partial: five of seven observed rows passed,
one failed the grader, one reached no manifest after the large incremental
pass, and the provider task has no frozen row.

The frozen Urdira smoke contains structural readiness and inter-turn reconcile
measurements, but no per-query latency. Its audit records 113 MCP calls, 66
`urdira_query` calls, 12 pipeline-shaped attempts, 54 direct operations, and
no recipes. These rows are therefore reported as a partially valid frozen
smoke, not as a pipeline/recipe campaign or a Urdira query-latency result.

The full L comparator audit SHA-256 is
`684c973e59e4f4adf8d99b62ddf92d078c6c77cf6ae37ae330c72a2b40d89945`; the
rendered JSON and Markdown hashes are
`f1890b9286fa13201979ac188f4851cc9053e61e1cac8177e6aa83be7ecb50af` and
`2cde0090d3c03b71326481f7c3451da00c06fc060c79c7989213f63f85534a88`.

Verification after the harness changes passed:

```text
node --check release/benchmarks/run-expanded-agent-benchmark.mjs
node --check release/benchmarks/expanded-agent-benchmark-runner.mjs
CI=true pnpm exec vitest run tests/expanded-benchmark-smoke.test.ts tests/expanded-agent-report.test.ts tests/expanded-agent-transcript-metrics.test.ts --maxWorkers=2
```

Result after the final harness corrections: 4 test files and 65 tests passed. The benchmark process tree and all isolated worktrees were stopped/cleaned after each completed cell; aborted data roots were moved to external temporary retention directories named `aborted-luna-*` for forensic retention.

Runtime fingerprints at execution time included Node `v24.18.1`, CodeGraph 1.6.0, codebase-memory-mcp 0.9.0, and the release Urdira indexing worker. The current harness hashes were recorded as:

| Artifact | SHA-256 |
| --- | --- |
| `release/benchmarks/run-expanded-agent-benchmark.mjs` | `d25e24af324a111a1bace2e481091efc297244a2ca8b9aa581102f563a26c952` |
| `release/benchmarks/expanded-agent-benchmark-runner.mjs` | `f26375bef3af06f7352b6599f416cef90c7e0e145b543b3756a7aa8123fdc835` |
| `release/benchmarks/expanded-typescript-agent-benchmark.json` | `06e8bffa38a843e38fb4589eabe5bbb1bd57ac298d4169875c1f721e32b19d37` |
| `packages/mcp/src/index.ts` | `7eef19b8f15be68af859e0405818e23e5e8ccfc9ec976fc3d3d38c5080e40369` |
| `release/benchmarks/expanded-agent-transcript-metrics.mjs` | `4e8140b7591527e3de380c3518fbeff5c1bf0dcac9bd77d9c684f429510b08cd` |
| `release/benchmarks/expanded-agent-benchmark-grader.mjs` | `12faae899a765ceb2cd79e8e5dcc74415f68a7852229a7600f79d1c68cf75dd0` |

The remaining blocker for a comparable Urdira result is the VS Code L
repository's post-edit structural reconciliation under the single-worker,
no-semantic-index contract. A comparator-only S/M campaign was subsequently
run after the explicit Urdira stop; its results are recorded below. Repeating
exhausted Urdira cells without a new indexing hypothesis would not be valid.

## Follow-up gate corrections

The first L gate showed a second fixed limit: the benchmark MCP instructions told the agent to wait only 240,000 ms after an edit, while the Urdira cell timeout had been extended. The harness now derives the L freshness wait from the same finite cell budget (`1,740,000 ms`, leaving 60 seconds for transport overhead) and configures Urdira's MCP tool timeout to 1,800 seconds. Codebase-memory and CodeGraph receive the same size-tier MCP tool timeout so comparator cells remain fair. S/M cells retain a 240,000 ms freshness wait and a 300-second MCP tool timeout.

The transcript metric `repository_read_calls` now excludes `urdira_index_status`, which bootstraps explicit scope and readiness but does not read repository context. The historical grader used the assigned discovery method for every arm when checking discovery before edits and rediscovery after edits; those results must therefore be read as tool-assigned measurements, not natural-choice evidence. Typed `core:execution_resource_limit` remains a recoverable, reportable Urdira outcome and is excluded from the unexpected-failure flag.

After those corrections, `smoke-large-gate-v2` was started before the corrected runner process was reloaded and was stopped as invalid. `smoke-large-gate-v3` was started after the corrections and reached initial structural readiness at `915210 ms`, with Codex launched using `URDIRA_BENCHMARK_FRESHNESS_TIMEOUT_MS=1800000` and `tool_timeout_sec=1800`. During the initial agent interaction, macOS FSEvents dropped events five times under host memory pressure; Urdira recorded that it gave up re-arming the watcher and would rely on the periodic sweep. The gate was stopped with this environmental failure preserved in:

`smoke-large-gate-v3/runs/vscode-language-registry-change-notification-urdira-typescript-1.host.log` in the retained run directory

Because the post-edit gate did not return a current structural frontier, the mandatory 8/8 smoke gate remains closed and the four-arm 96-execution campaign remains unrun. The v3 output also showed why this cannot be treated as a successful comparison: host memory was nearly exhausted and watcher events were lost before the directed rediscovery step could be completed.

## Microsoft tgrep arm

The comparator set now includes Microsoft `tgrep` as a CLI discovery arm. It is pinned to the official `microsoft/tgrep` v1.0.5 release at commit `d55b022023518646c90742f4761488dc95633b73` and built with `cargo build --release --locked`; the resulting binary reports `tgrep 1.0.5`. Each cell builds an isolated on-disk `.tgrep` index in its fresh worktree, records setup/index elapsed time and index output, and removes the worktree during cleanup. The historical comparator prompt directed the agent to use `tgrep <pattern> <worktree> --stats` for discovery and prohibited other shell source readers. No `serve` process or shared index is used, so watcher state cannot cross cells.

The interrupted pre-tgrep smoke `smoke-reconcile-8of8` is retained as partial evidence: its first six rows were closed, the seventh completed, and the eighth was interrupted during a large VS Code incremental frontier wait. Its second TypeScript row also predates the corrected discovery classifier. It is not a gate and cannot authorize the five-arm campaign.

The subsequent `smoke-tgrep-final` and `smoke-tgrep-final-v2` outputs are also retained as diagnostic evidence. The first exposed malformed Urdira payloads despite recovery, and v2 passed six cells before VS Code surfaced dropped FSEvents while the agent still had a post-edit discovery call open. The historical benchmark prompt required the agent to stop discovery after its last edit in a turn; the runner then performed the explicit measured reconcile before resuming. These partial outputs do not authorize the campaign or establish natural tool selection.

## Deterministic incremental frontier recovery

The large-repository gate exposed a real transport failure mode: macOS
FSEvents can report dropped events under memory pressure. The benchmark host
therefore keeps `reconciliation_sweep_interval_ms: 0`; a continuous sweep
would schedule repeated background rescans and contaminate the idle portion of
the staged-incremental measurement. Between agent turns, the runner now sends
the existing `core:reindex` administrative operation with the explicit,
validated `values.scope: "reconcile"`. The daemon preserves the historical
default (`scope` omitted means `full`) and routes the explicit form through the
existing v4 `ScanScope::Reconcile` path. The request duration and the complete
current-frontier wait are emitted as `inter_turn_reconcile_requests`,
`inter_turn_freshness_waits_ms`, and `BENCH_INTER_TURN_RECONCILE`/
`BENCH_INTER_TURN_READY` host-log records, so recovery cost remains in the
sample.

This change has focused coverage in
`tests/phase-daemon-v4-reconcile.test.ts` (default full plus explicit
reconcile) and `tests/expanded-benchmark-smoke.test.ts` (sweep disabled and
runner trigger/telemetry contract). The corresponding daemon and application
TypeScript artefacts were rebuilt with `pnpm exec tsc --build packages/daemon`
and `pnpm exec tsc --build apps/urdira`.

The first gate run reached the structural frontier and then exposed an
ordering bug in the newly symmetric grader (`transcriptMetrics` was read
before initialization); it is retained as a runner failure. After fixing that
clear grader defect, the same immutable transcript was regraded successfully
and stored as
`smoke-reconcile-gate-v2/runs/vscode-language-registry-change-notification-urdira-typescript-1-regraded.json`.
The gate measured 818,392 ms to current structural readiness, two successful
explicit reconcile requests (1 ms each), freshness waits of 1,546 ms and
1,533 ms, peak host RSS 4,467,600 KiB, and zero semantic-sidecar bytes. The
agent diff passed the rubric with no unexpected tool or validation errors;
its attempted lint was unavailable in the frozen checkout and is recorded as
an unsuccessful verification attempt.

## Fifth-arm smoke v3 and current stopping point

The fresh five-arm preparation smoke was launched with the explicit pinned
tgrep binary, but only the Urdira arm is eligible to open the gate. Its output
is retained at
`smoke-tgrep-final-v3` in the retained run directory.
Seven rows were materialized before a controlled stop: five passed the grader,
Playwright `reporter-error-isolation` failed because one agent query changed
the opaque workspace id and received `core:workspace_not_found`, and the VS
Code large row ended without a manifest under host memory pressure. The VS
Code row reached the post-edit delta and measured `typeflow build_index:
201.764s` over 12,945 files, then remained in publication without a new
current frontier. At the stopping point it had elapsed `2,019,909 ms` and
reported peak process-tree RSS `17,734,208 KiB`; the 32 GiB host had roughly
96 MiB free. The benchmark and worker were terminated to protect the host,
and the partial log/transcript/diff remain in the output directory.

The smoke was not accepted as 8/8, so the 120-cell campaign was not started.
The runner guardrail now states that every Urdira request must copy
`query_scope.workspace_id` byte-for-byte from the latest status response; it
must never synthesize, shorten, normalize, infer, or retype the id, and
`workspace_not_found` is a benchmark failure even after recovery. The focused
smoke test covers this contract. This correction requires a fresh smoke before
any future full campaign; no exhausted large-repository retry was launched in
this output.

The v3 command used the explicit tgrep path:

```text
URDIRA_SEMANTIC_INDEX=0 node release/benchmarks/run-expanded-agent-benchmark.mjs --samples 1 --arms urdira-typescript --repositories typescript,playwright,prisma,vscode --repositories-root <benchmark-repositories-root> --output-dir <campaign-output>/smoke-tgrep-final-v3 --node node --codex codex --codebase-memory codebase-memory-mcp --codegraph codegraph --tgrep tgrep
```
