# Definitive selected agent benchmark handoff

Status: operational handoff. This document is evidence procedure, not a
product or public protocol contract.

Use this handoff to start a new session with no dependence on conversation
history. The root Sol agent coordinates the work and reviews results. Every
benchmark execution and every benchmark-related repair is delegated to a Luna
worker; Sol does not execute a benchmark. This restriction applies to the
three measurement campaigns below and does not authorize changes to unrelated
work.

## Objective and boundaries

Measure the current Urdira agent integration on one frozen task in each
selected repository, then compare it with the four retained tool arms. The
agent must be able to begin from Urdira-delivered context and extend its
investigation through Urdira queries and continuations. Native shell reads are
allowed when they answer an identified gap, inspect generated state, validate
an edit, or perform a required build/test; shell use is not itself a failure.

The optimization objective is to preserve all required information while
removing avoidable duplication, premature discovery, and irrelevant context.
Do not add fixed character, token, result, facet, or call quotas. The agent
chooses `response_budget`. Never hide a result, silently summarize a requested
body, claim a paginated result is complete, or turn a missing measurement into
zero.

The selected frozen cells are:

| Tier | Repository and commit | Task | Current Urdira evidence |
|---|---|---|---|
| S | `microsoft/playwright` at `1b44f5a441f391538c42c7ce36dd8ce779a5d6a1` | `affected-tests-deterministic` | v72 |
| M | `prisma/prisma` at `0f37454eec96b193e8b20e8f569e453acd2af644` | `wire-name-validation` | v69 |
| L | `microsoft/vscode` at `038b9225c82c6b75172beda6081c64887692538c` | `language-provider-registration-idempotence` | v86 |

Freeze `gpt-5.6-luna`, Node `24.18.1` exactly, the three-turn
`staged-incremental` prompt protocol, structural readiness, and
`URDIRA_SEMANTIC_INDEX=0`. Semantic materialization and sidecars must remain
disabled. The five arms are `baseline`, `urdira-typescript`, `tgrep`,
`codegraph`, and `codebase-memory`.

The definitive selected measurement is three independent campaigns, each with
the three repositories and five arms: **45 sequential runs**. A campaign has
15 agent runs and no parallel cells. In addition, each campaign has six
readiness-only probes for Urdira (cold and warm for each selected repository),
for **18 readiness-only probes** across the three campaigns. Readiness probes
do not invoke a model and are never counted among the 45 agent runs. Existing
v69, v72, and v86 results remain historical observations and are not silently
replaced.

The top-level campaign driver cannot select one task: it expands every
selected repository to both corpus tasks. Therefore it cannot produce these
45 cells by itself. Build an immutable 15-entry cell manifest per campaign
with exactly these repository/task pairs:

| Repository | Task id |
|---|---|
| `playwright` | `affected-tests-deterministic` |
| `prisma` | `wire-name-validation` |
| `vscode` | `language-provider-registration-idempotence` |

For each entry invoke `release/benchmarks/expanded-agent-benchmark-runner.mjs`
once for each of the five arms, passing the frozen commit, `--sample` equal to
the campaign number, a fresh worktree/data/output root, the exact Node and
tool paths, and `--phase warm`. The resulting 15 manifests are the campaign
audit input. Do not invoke the full two-task-per-repository driver as a
substitute, and do not count smoke or readiness probes as agent cells.

## Phase 0: blocking implementation prerequisites

Phase 0 must pass before any model invocation or readiness campaign. The
current runner only records cleanup booleans and does not yet emit the required
per-cell byte/`df` manifest, enforce `BENCH_MIN_FREE_BYTES`, or block the next
cell on registered residue. Instrument the runner and its signal/finally paths
to implement the mandatory cleanup checkpoint below, then add a focused test
for success, failure, timeout/interruption, ownership checks, byte accounting,
`df`, and the free-space guard. A documentation statement is not evidence that
the current runner already satisfies this requirement.

The runner's binding to the extracted, hash-verified release archive is also a
pending Phase 0 prerequisite. Build and install one archive, verify that the
CLI, MCP, app, plugin, native addon, worker, hooks, and launcher used by the
cell resolve to those exact archive bytes, and make the runner fail closed when
the binding cannot be proven. Do not start the 45-run campaign against a source
checkout while calling it an installed-release measurement.

## Required order

1. Read `AGENTS.md`, `docs/README.md`, `docs/product-foundation.md`, Decision
   08, Decision 19, [the expanded campaign runbook](expanded-agent-campaign.md),
   and the dated v69, v72, and v86 evidence. Record the current working-tree
   status and keep unrelated changes intact.
2. Run the offline replay before starting a model. Replay every retained raw
   transcript, manifest, timing sidecar, hook audit, host log, and comparator
   report. Replay must not start a host, agent, competitor, or workspace and
   must preserve original bytes and hashes.
3. Write or update a focused regression before any implementation repair. A
   repair must be generic and contract-driven. Run focused tests, lint,
   typecheck/build gates, and `git diff --check`; then run `CI=true pnpm verify`.
4. Build one release archive from the verified source. Run
   `URDIRA_RELEASE_TARGET=darwin-arm64 pnpm package:release` and
   `URDIRA_RELEASE_TARGET=darwin-arm64 pnpm release:acceptance`. Install that
   exact archive into a disposable root, execute the installed CLI, worker,
   native addon, and one scoped structural query after readiness. Retain the
   archive digest and all component hashes. A launcher version check alone is
   insufficient. The release smoke is a separate gate from the agent cells:
   before measuring, attest that the runner's CLI/MCP/app/plugin/native and
   worker paths resolve to the same bytes as the extracted archive. If the
   current runner cannot be configured to use the extracted archive, stop and
   record the release-backed measurement as blocked; do not describe a source
   checkout run as an installed-release benchmark.
5. Prepare one empty worktree per run at the frozen repository commit. Remove
   `out/`, `out-build/`, `dist/`, generated test output, and other declared
   generated source-frontier artifacts before indexing. Build or install only
   the dependencies declared by the preparation protocol; do not install
   during the measured agent phase. Record preparation commands, outputs, and
   generated-file hashes.
6. Run the selected-arm smoke required by Decision 08, then run the 18
   readiness-only probes described above: one cold and one warm Urdira probe
   for each repository in each campaign. Verify that the exact installed
   archive, worker, Node executable, model, hooks, prompt, semantic switches,
   repository commit, snapshot identity, and output roots match each manifest.
   A failed smoke or readiness probe remains retained and blocks the
   corresponding measurement cell or readiness result; it is never retried.
7. Run the three campaigns sequentially. Rotate arm order by campaign, use a
   new output/worktree/data/cache root for every run, and retain every failure.
   Do not retry a failed cell or replace it with a successful attempt. A new
   hypothesis requires a new explicitly numbered campaign, not an overwrite.
8. After each run, verify the transcript, manifest, timing sidecar, hook audit,
   host log, patch, validation result, environment stamp, and hashes before
   cleanup. Check process ownership, remove the worktree, Urdira data root,
   prompt cache, generated build output, and release staging, and record bytes
   before and after. Never perform a broad disk search or delete unrelated
   project data.
9. Re-run offline metrics and render the report only after all retained raw
   artifacts are immutable. Compare efficiency only between rows with equal
   correction and coverage, and publish failures and unavailable fields.

The release archive binding is also a pending Phase 0 prerequisite: the runner
must bind each invocation to the extracted, hash-verified release archive and
fail closed when that binding cannot be proven. Until Phase 0 passes, the
session must not start a model.

For each of the 45 agent cells, the direct runner invocation has this shape;
the coordinator must materialize the placeholders from the cell manifest and
must not reuse any root between cells:

```bash
"$BENCH_NODE" release/benchmarks/expanded-agent-benchmark-runner.mjs \
  --repository-id "$BENCH_REPOSITORY" \
  --task-id "$BENCH_TASK" --arm "$BENCH_ARM" --sample "$BENCH_CAMPAIGN" \
  --phase warm --commit "$BENCH_COMMIT" --worktree "$BENCH_WORKTREE" \
  --data-root "$BENCH_DATA_ROOT" --output-dir "$BENCH_RUN_OUT" \
  --model gpt-5.6-luna --codex "$BENCH_CODEX" --node "$BENCH_NODE" \
  --indexing-worker "$BENCH_WORKER" \
  --codebase-memory "$BENCH_MEMORY" --codegraph "$BENCH_GRAPH" \
  --tgrep "$BENCH_TGREP"
```

The coordinator records one immutable campaign audit from those 15 manifests
and their retained stdout/stderr, rather than inferring the selected scope
from a full-corpus driver audit. If a temporary orchestrator is used to loop
over the manifest, it must fail closed on a nonzero cell, retain that cell,
and continue only according to the campaign's declared failure policy; it may
not retry or overwrite a run.

## Mandatory cleanup checkpoint

The cleanup checkpoint runs after each complete cell or before transfer to another worker.
During the three internal turns of a cell, its checkout,
index/data root, prompt-hook cache, and processes remain active and are not
cleaned between turns. There may be at most one active checkout/index/data root
and its associated prompt-hook cache for the current cell. Every path is unique,
recorded in the cell manifest, and owned by that cell.

Cleanup is unconditional: use `finally` or an equivalent signal-safe trap so it
runs on success, failure, timeout, and interrupt. First stop the cell's worker,
daemon, comparator server, child processes, file watchers, and open handles;
then remove the worktree, index/data root, prompt-hook cache, package/build
temporaries, and any cargo target generated inside the execution root. Retain
only explicitly named transcripts, manifests, hashes, reports, patches,
validation logs, and evidence. A failed run cannot skip this checkpoint.

Before and after cleanup, record byte totals for every registered path and run
`df` for the filesystem containing the output root. The operational free-space
guard is configurable per host (`BENCH_MIN_FREE_BYTES` or an equivalent
manifested parameter); it is a runner safety parameter, not an absolute Urdira
product threshold. This configurable space-free threshold is an operational
guard, not a product limit. If any registered disposable path remains, a process still
owns it, its cleanup manifest is missing, or free space is below that configured
parameter, **block the next execution** and retain the diagnostic. Do not
invent a default product limit and do not continue by deleting unregistered
paths.

Each handoff to another worker must include the cleanup manifest status for the
previous complete cell. Internal turns keep the active cell resources. The
manifest records paths, ownership checks, processes stopped, bytes before/after,
`df` output, retained artifacts, and errors. Auditing is limited to the paths
registered in the current campaign and its retained artifact directory; never
perform a destructive disk-wide sweep.

## Correctness and coverage gate

Correctness precedes every token, cost, context, or time comparison. A cell is
accepted only when the strict grader succeeds, the declared target set and
required patterns are complete, no unsafe omission is reported, the patch is
evidence-grounded, the focused test has a numeric result, and the independent
validator runs the same task-specific checks. The validator must include the
required build/typecheck/test and `git diff --check` for that repository.

All three campaigns retain failures in their audit. A row with 2/3 successes is
not a 3/3 comparison row. If an arm remains below the gate, report its failure
and set its efficiency comparison to unavailable rather than repairing the
historical transcript or imputing a value.

A served `UserPromptSubmit` or `PreToolUse` hook interception counts as Urdira
tool use. A correctly handled fallback also counts as an intercepted Urdira
operation, while only output actually shown to the model is counted as hook
context. Shell fallback is valid when the hook cannot faithfully express the
command or when the transcript identifies a missing fact. Record its reason;
do not count a denied command as executed shell work. `tgrep` output is a
subset of shell output and must never be added as a third transport.

## Metric normalization

The offline report must use one definition for every arm and campaign.

- **Comparable tokens:** read raw per-turn usage. If a provider reports
  cumulative counters, use successive deltas; otherwise use the per-turn
  values. Sum `input_tokens + output_tokens + reasoning_output_tokens` across
  the session. Reasoning is always included in this metric.
- **Cached tokens:** report cumulative or delta `cached_input_tokens` using the
  same counter rule, in a separate field. Never subtract cache from comparable
  tokens.
- **Cost:** freeze the planning card at input USD 2/M, cached input USD 2/M,
  output USD 8/M, and reasoning USD 8/M. Apply it to uncached input,
  `cached_input_tokens`, output, and reasoning respectively. This is an
  estimate, never a provider invoice; if an arm cannot expose the required
  counters under this policy, report cost as `null` for that arm rather than
  mixing invoice data with an estimate.
- **Discovery context:** report repository-discovery characters separately
  from completed output. Keep direct MCP, Urdira hook, shell, and tgrep-subset
  characters distinct. Use the prescribed UTF-16 character count for transport
  output and retain UTF-8 component bytes only when the protocol identifies
  them. `full_model_context_characters` remains `null` when the host does not
  expose it; never infer tokens from characters.
- **Usefulness and duplication:** retain unique-record ratio, repeated
  characters, source sharing, hydration used, continuation offered/attempted/
  consumed, artifact positions, relevant results per thousand characters,
  shell overlap, and contribution to the edit or response. Use `null` when the
  transcript cannot establish use; absence of a citation is not proof of
  non-use.
- **Setup:** elapsed time from the run's preparation/start boundary through
  the declared readiness boundary, including indexing and publication but
  excluding model execution and cleanup.
- **Cold structural readiness:** elapsed time from starting an empty data root
  and a clean generated-source frontier until a complete current structural
  snapshot accepts a scoped query. Record OS/filesystem cache conditions; a
  fresh data root with an uncleared OS cache is not called an OS-cold result.
- **Warm readiness:** elapsed time for a query against an already published
  current snapshot under the declared warm condition. Do not mix it with cold
  indexing or post-edit reconciliation.
- **Time to first query:** elapsed time from the validated query boundary to
  the first complete response. Include query execution and page materialization
  only; record page/continuation state separately.
- **Agent duration:** from the first model instruction to the final agent
  completion, including measured inter-turn freshness waits and excluding
  setup and cleanup.
- **End-to-end:** from setup start to final agent completion. Publish setup,
  agent duration, readiness, first-query time, and E2E as separate fields; do
  not attribute indexing or cleanup time to the agent.

For every Urdira readiness probe, retain monotonic timestamps for
`data_root_created`, `source_ready`, `structural_ready`,
`validated_first_query`, and `first_query_complete`. Define cold structural
readiness as `structural_ready - data_root_created`, setup as
`structural_ready - preparation_started`, and time to first query as
`first_query_complete - validated_first_query`. Define warm readiness as
`first_query_complete - warm_query_started` against the retained current
snapshot under the declared warm cache condition; it excludes cold indexing,
post-edit reconciliation, model time, and cleanup. A probe must also retain
the snapshot identity, page completeness, and whether the first response was
complete or continued. Comparator setup/readiness fields remain `null` unless
the comparator exposes the same boundaries and evidence.

Three observations are sufficient for a task median and a transparent range,
not a reliable P95. Do not label a three-sample maximum or percentile as P95.
Report P95 only when the applicable Decision 08 campaign has enough
independent observations for that claim; otherwise publish `null` and the
sample count.

## Readiness and contamination controls

The agent comparison uses structural readiness with semantics disabled. Run
cold and warm readiness as separately identified measurements if readiness is a
claim. The 18 readiness-only probes are the planned cold/warm measurements:
three campaigns times three repositories times two phases. Every cold probe
starts from an empty data root and removes generated
`out/`, `out-build/`, `dist/`, compiled test output, and index/cache artifacts
from the source frontier before indexing. Every warm run records the existing
snapshot identity and cache condition. A post-edit incremental reconciliation
is measured separately from both initial readiness values.

Record source-ready, structural-ready, first-query, post-edit freshness, and
publication events from the host. Record catalog, lexical, structural, CAS,
semantic, sidecar, temporary, and process-tree measurements separately. A
semantic byte count of zero is valid only when the manifest and host evidence
also prove semantic indexing, materialization, and sidecar creation were off.

## Reproducibility and retention

Each campaign manifest must retain the corpus digest, repository commits, task
prompts, model and Node versions, runner/grader/reporter hashes, installed
archive digest, CLI/MCP/app/plugin/native/worker hashes, hook configuration,
environment variables, semantic settings, CPU/OS/filesystem details, arm order,
sample id, phase, and output paths. Each run retains the original transcript,
timing sidecar, hook audit, host log, manifest, patch, independent validation,
and cleanup report. Hashes are calculated from retained bytes after the run;
historical summaries do not replace missing raw provenance.

The three current integration observations remain useful evidence: Playwright
v72, Prisma v69, and VS Code v86. V86's exact retained artifacts are under
`/Users/Cristian/BenchmarkResults/urdira-context-density-20260914-v86`;
the corresponding v69 and v72 directories remain immutable. Their results
must be described as single observations until the 45-run protocol is complete.

## Acceptance and handoff

The final report is acceptable only when every included row has a clear
correction/coverage result, all missing measurements are `null`, the metric
definitions above are applied consistently, the release archive and hashes are
verified, generated artifacts and temporary roots are cleaned, and every
failure is retained with its reason. Efficiency deltas are shown only for
task-matched rows with equal correctness and coverage. The report must state
that selected S/M/L tasks are integration evidence and do not establish
product-wide performance, semantic quality, or statistical superiority.

The Luna worker hands Sol the exact changed files, tests, commands and results,
retained artifact paths, hashes, cleanup bytes, failed rows, and unresolved
`null` fields. Sol reviews the result and proposes a commit set; no worker
creates a commit before that independent review.
