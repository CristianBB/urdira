# Expanded agent benchmark setup fairness audit

Date: 2026-09-10  
Scope: read-only audit of the current runner, runbook, frozen Urdira smoke evidence, and completed comparator campaigns. No benchmark cell or Urdira process was run for this audit.

## Executive finding

The current runner is suitable for a future matched-task, end-to-end comparison of `setup + agent wall time`, correctness, context, tool calls, tokens, cost, and process-tree resources, provided that the arm, repository size, task, sample count, and failure status stay visible. The existing measurements were collected under tool-assigned historical orchestration, however, so they do not support a ranking of natural integration quality or intrinsic tool/model latency. They are not a clean comparison of index throughput or of agent-only reasoning time.

The main asymmetries are explicit and measurable:

* Urdira setup waits for a structural frontier to be `current` or `equivalent`; comparator setup trusts successful completion of the arm's index command.
* Urdira agent wall time includes an explicit post-turn reconciliation request and freshness polling between turns. Comparator agent wall time has no equivalent wait.
* The task prompts require tracing and call-graph investigation. That is common to every arm, but it naturally benefits graph-capable tools and therefore raw token, context, and elapsed-time differences must not be presented as intrinsic index or model cost.
* tgrep is indexed during setup, but the runner does not start `tgrep serve`; watch-mode freshness is therefore not part of the measured tgrep setup contract.

The historical 96 comparator rows and the frozen Urdira smoke were tool-assigned: the orchestration selected and exposed an assigned integration for each arm, and the resulting tool calls are evidence of that directed protocol. The current runner has removed those arm-specific prompt directives and is neutral about tool choice, but no new campaign has been run under that neutral runner. The historical results therefore cannot establish which integration an agent would naturally choose or rank integrations by intrinsic latency.

These differences do not invalidate the existing results when the published metric is named accurately. They do require decomposition and labels before making claims about indexing speed, coding speed, or tool-intrinsic cost.

## Evidence inspected

The audit used the current versions of:

* `release/benchmarks/expanded-agent-benchmark-runner.mjs`
* `release/benchmarks/run-expanded-agent-benchmark.mjs`
* `release/benchmarks/render-expanded-agent-report.mjs`
* `release/benchmarks/expanded-typescript-agent-benchmark.json`
* `docs/benchmarks/expanded-agent-campaign.md`
* the frozen Urdira smoke transcript and manifests under `luna-campaign-20260909T1935/smoke-tgrep-final-v3`
* completed comparator smoke and full campaigns under `luna-campaign-20260910T0807`
* the pinned tgrep README at `/Users/Cristian/BenchmarkTools/tgrep-2026-09-10/README.md`

No historical value was reused as a fresh run, and no result was imputed for a missing or failed cell.

## What setup currently contains

The common setup timer starts before the runner resets the worktree to the repository commit and runs `git clean -fd`. It ends when arm preparation returns and immediately precedes the first agent instruction. Thus every arm includes common checkout reset/cleanup, while the following arm-specific work is included in the same setup interval:

| Arm | Setup operation | What is indexed or prepared | Readiness endpoint currently used |
| --- | --- | --- | --- |
| baseline | Worktree reset and clean | No external index; the agent uses ordinary repository tools | Setup ends after common preparation |
| Urdira | Start the host, register the workspace, poll structural status | Complete structural Urdira index only; `URDIRA_SEMANTIC_INDEX=0`; semantic descriptor/materialization is disabled | `core:index_status` reports a structurally ready `current` or `equivalent` frontier |
| codebase-memory | Run `codebase-memory-mcp cli index_repository` with `mode=full` and `persistence=true` | The codebase-memory project/knowledge graph and its persisted index | Successful index command completion; no shared current-frontier predicate is polled |
| codegraph | Run `codegraph init` for the worktree | CodeGraph graph/index database | Successful `init` command completion; no shared current-frontier predicate is polled |
| tgrep | Run `tgrep index` for the worktree | Trigram search index, including the index files produced by tgrep's indexing strategy | Successful index command completion; no `serve` process or watch-mode freshness gate is started by the runner |

Urdira's `setup_elapsed_ms` therefore means time to structural readiness. Comparator setup is time to successful index-command return. This is a valid end-to-end “time until the configured arm is available” measure only when reported with those endpoint definitions. It must not be called a directly comparable “index speed” metric without a common completeness/readiness contract.

Urdira's structural readiness is intentionally separate from semantic indexing. Semantic indexing and semantic sidecar materialization remain excluded, and the frozen Urdira evidence records semantic disabled with zero semantic sidecar bytes. This property must remain a gate condition, not a performance number.

## What agent elapsed currently contains

`elapsed_ms_from_first_instruction` starts after setup and ends after the third Codex process closes. It includes the three agent turns and their tool/model work. It excludes the final grader, report rendering, and cleanup.

For Urdira only, the runner also executes `core:reindex` with `scope: reconcile` after each turn and polls until the structural frontier is fresh before sending the next turn. The recorded `inter_turn_freshness_waits_ms` includes the request and polling interval, and `inter_turn_reconcile_requests` records the request outcome. Consequently, Urdira agent wall time includes synchronization/reconciliation waits. Comparator agent wall time has no corresponding wait.

The top-level `audit.runs[].elapsed_ms` is broader: it includes driver orchestration and cleanup and must not be used as setup-plus-agent performance. The renderer's `setup_elapsed_ms + elapsed_ms_from_first_instruction` is the correct current total for the reported cell.

The existing Urdira reconciliation path is an explicit administrative `scope=reconcile` request. It should be reported as reconciliation synchronization time; it must not be described as proof of incremental indexing throughput. The current evidence does not provide a separate pure coding-time measurement, so Urdira agent wall time should not be presented as model or reasoning latency.

### Frozen Rust indexing bottleneck evidence

The frozen Urdira smoke contains structural Rust timing diagnostics that are useful for identifying the observed size bottleneck, but they are not query-latency measurements. The ranges below are the recorded operation and total durations by repository family:

| Repository family | Rust operation duration | Rust total duration |
| --- | ---: | ---: |
| Playwright | 2.48–3.00 s | 2.92–3.44 s |
| TypeScript | 15.64–16.50 s | 16.05–16.90 s |
| Prisma | 42.50–46.33 s | 43.40–47.22 s |
| VS Code | 778–780 s | 784–786 s |

These figures describe the frozen structural indexing path and its surrounding Rust timing fields. No per-query latency was recorded. The Rust worker binary and plugin were also not fingerprinted in that evidence, so the table must be published with that provenance limitation and cannot be used as a reproducible binary-level performance claim.

## Prompt, tool, token, and cost fairness

The current runner's initial, follow-up, and final instructions are shared across arms, and every cell uses the same three-turn resumable-session protocol. In the current runner, prompts do not mandate a particular tool, a fixed response length, or a post-edit rediscovery procedure. They do require a final review, changed-file accounting, verification results, and limitations for every arm.

That neutrality does not retroactively apply to the evidence already collected. The 96 comparator rows and the frozen Urdira smoke were run with tool-assigned integrations. Their identical task text and three-turn shape make the cells useful for comparing outcomes under that directed protocol, but they are not evidence of natural tool selection, natural integration ranking, or intrinsic tool latency.

The task prompts themselves require tracing shared workers, call graphs, public entry points, or construction boundaries. This is an intentional task requirement and is identical across arms, but it gives graph-oriented tools a natural opportunity to reduce discovery effort. Raw context, token, or elapsed-time differences therefore measure the complete agent trajectory under the common task, not the intrinsic cost of an index.

The configured tool surfaces are arm-specific by design. Codebase-memory and CodeGraph use their MCP integrations. Baseline has no external index. tgrep is indexed by the runner and successful existing transcripts contain assigned tgrep search calls, but the runner does not explicitly install or launch a tgrep server in the agent shell. A future run should record the exact agent-visible binary path and SHA, and whether `serve`/watch mode is active, before comparing tgrep freshness or search latency.

There is no arm-specific forced answer format in the current runner, and its tool-selection policy is neutral. Historical tool assignment remains a confounder for the existing measurements. Token and cost values are whole-session values: task instructions, repository context, tool outputs, recovery after tool failures, and the three shared turns all contribute. The renderer must keep the following fields visible:

* input tokens, cached input tokens, uncached input tokens, output tokens, and reasoning tokens;
* total tokens using the declared renderer formula;
* estimated cost under the declared input, cached-input, output, and reasoning rate card.

These values are not the cost of indexing. Failed cells retain their observed partial metrics and must not be silently converted into successful-cell performance.

## Metrics to publish as comparable

Publish each metric by arm, repository size, repository, task, sample, and status. Use medians for the three samples; do not publish a p95 when the campaign has only one independent campaign.

1. **Correctness and completion:** grader pass `n/N`, real focused-test result separately, changed-target coverage, discovery status, failure stage, fallback use, and unexpected errors. Preserve failed rows.
2. **End-to-end timing:** common reset/clean time, arm preparation/index time, readiness time and criterion, agent wall time, and `setup + agent` total. Label Urdira's structural readiness explicitly.
3. **Synchronization:** Urdira reconciliation request time and freshness-wait subtotal between turns. If a future arm adds a freshness protocol, publish the same field for it.
4. **Agent activity:** turn count, tool-call counts by assigned tool, MCP discovery/failure counts, repository-read calls (excluding Urdira status polling), context characters, and unattributed context. Keep `repository_context_characters` labelled as response/context characters, not source bytes.
5. **Tokens and cost:** the five token components, total tokens, rate-card cost, and the sample/status used for each aggregate.
6. **Resources:** cell process-tree peak RSS, CPU, and process count; Urdira host-only readiness RSS as a separate scope; index artifact bytes and storage categories. Do not merge tgrep's own printed peak memory with process-tree RSS.
7. **Provenance:** model, Node/runtime, tool versions, executable hashes, corpus commit, runner revision, output directory, audit hash, and semantic flags. For Urdira retain semantic sidecar bytes and the zero-sidecar gate.

For a fair tool-search comparison, also publish an assigned-call effectiveness view: assigned tool calls, successful calls, discovery/status calls, repository reads, returned context, and grader outcome. This allows a reviewer to distinguish a fast, sparse discovery path from a failed cell with low apparent activity.

## Metrics to remove or reclassify

* Reclassify the current universal `setup` number as **time to configured arm readiness**. Do not call it index throughput until all arms use an equivalent completeness/current predicate.
* Reclassify Urdira `agent_elapsed_ms` as **agent wall including freshness synchronization**. Keep the wait subtotal beside it; do not subtract it retrospectively from existing cells.
* Remove top-level driver `audit.elapsed_ms` from performance comparisons because it includes orchestration and cleanup.
* Do not describe tgrep setup as served/watch-ready or compare freshness until the server/watch contract is explicitly started and measured.
* Do not report a generic `semantic=0` comparator value. Semantic exclusion is a Urdira contract gate; comparator tools should expose only the features they actually provide.
* Do not publish p95 from the current single independent campaign. Three samples are repeated cells, not three independent campaigns.
* Do not use failed-row medians as successful performance. Publish all-observed and successful-only aggregates with their denominators.
* Keep Urdira host-only RSS, cell process-tree RSS, and tool-reported peak memory as separate metrics and scopes.
* Do not infer Urdira recipe/pipeline efficiency or per-query latency from the frozen smoke. It contains direct operations and no measured per-query latency; those counts are diagnostic composition evidence only.

## Recommended next-campaign contract

Keep the common reset/clean interval visible, then add arm-specific `index_elapsed_ms` and a normalized readiness predicate for every arm. For Urdira, retain structural-only readiness and semantic sidecar zero as hard gates. For tgrep, choose and record either one-shot indexed search or a served/watch configuration before the campaign; do not mix the two.

Record synchronization waits for every arm that performs inter-turn refresh. If no comparator requires one, report zero with the reason “no inter-turn freshness protocol,” rather than implying equal work. Add an optional agent-active timer in a future runner revision if pure model/tool execution time is needed; the existing data cannot reconstruct it reliably.

With these labels, the existing comparator and frozen Urdira evidence can support matched-task outcome and end-to-end comparisons under the historical directed protocol. They cannot support a ranking of natural integration quality, a claim that one arm has intrinsically faster indexing, lower model reasoning cost, or lower per-query latency. Those claims require a new campaign using the current neutral runner, a common readiness contract, explicit binary/plugin fingerprints, and per-query timing instrumentation.
