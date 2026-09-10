# Expanded agent comparison runbook

Status: operational procedure, checked against the runner on 2026-09-10.
No benchmark was executed during this documentation preparation.

## Authority and scope

[Decision 08](../decisions/08-performance-reliability-evaluation.md) governs
measurement and acceptance. This runbook describes the external-tool comparison,
not the separate 60-run source-first campaign or native indexing qualification.
The [corpus](../../release/benchmarks/expanded-typescript-agent-benchmark.json)
owns task prompts, repository commits, model, and sampling plan. Runtime behavior
comes from the [driver](../../release/benchmarks/run-expanded-agent-benchmark.mjs),
[cell runner](../../release/benchmarks/expanded-agent-benchmark-runner.mjs), and
[grader](../../release/benchmarks/expanded-agent-benchmark-grader.mjs).
This document introduces no public API or architecture changes.

## Frozen matrix

- Arms: `baseline`, `urdira-typescript`, `codebase-memory`, `codegraph`, `tgrep`.
- Repositories: TypeScript, Playwright, Prisma, VS Code, at the exact SHA in the corpus.
- Two tasks per repository: `quick-local` and `deep-cross-file`.
- Both tasks use `staged-incremental`: three instructions in one resumable session.
- Eight tasks times five arms = 40 cells. One sample = 40 executions;
  the corpus plan of three samples per cell = 120 executions, excluding smoke.
- Historical model: `gpt-5.6-luna`; Node must be at least `24.18.1`.
  Reconfirm availability and freeze exact executable versions before a run.

The driver always passes `--phase warm`: Urdira finishes initial structural
readiness before the agent starts. Each sample still has fresh indexing state;
setup is measured separately and included in total time. This is not a
cold/warm matrix or an OS page-cache eviction experiment.

## Prepare before spending benchmark time

1. Confirm the driver's automatic environment manifest: Urdira commit/status
   and diff hash; corpus, driver, runner, grader, reporter and built MCP hashes;
   exact Node, agent and comparator executable paths/hashes; host
   OS/architecture/CPU/RAM; start-time free memory, load average and output-disk
   space; effective benchmark runtime settings; and intended output directory.
   The environment manifest also fingerprints the indexing worker and, when
   present, the native addon, native syntax worker, Urdira app/daemon/MCP
   distributions, and JavaScript/TypeScript plugin distribution. It records
   declared native/plugin build identities when package metadata or source
   declarations expose them; unavailable artifacts remain explicit `null`.
   Add filesystem and package-manager details manually when the host cannot
   expose them directly. Preserve unrelated working-tree changes. Use a
   reproducible built checkout.
2. Follow [AGENTS.md](../../AGENTS.md) for dependencies, native builds, and the
   complete `pnpm verify` gate. Confirm `apps/urdira/dist/index.js` and native
   artifacts match the recorded checkout. The global Urdira install is not used.
3. Prepare four repository clones under one dedicated root, named `typescript`,
   `playwright`, `prisma`, and `vscode`; ensure each corpus SHA exists locally.
   Record test dependencies available in the actual fresh worktrees. The agent
   must not install dependencies. Missing dependencies remain explicit blockers.
4. Supply executable paths explicitly; the driver's historical default paths
   are not portable. Check agent authentication and comparator availability
   without launching a coding task. Do not print credentials into evidence.
5. Freeze the Urdira mode and environment. The driver disables semantic indexing
   and materialization, and the runtime does not create a semantic sidecar;
   the cell runner forces analysis workers, analysis pool max, and structural
   concurrency to one. It enables timing logs. Other environment variables are
   inherited. Record v4/residual/lexical settings and overrides explicitly.
   August v3 results do not measure the current v4 default.
   The expanded Urdira MCP entrypoint passes only the isolated `data_root`.
   It inherits the production five-tool set, descriptions, and
   `MCP_SERVER_INSTRUCTIONS`; it passes no `tool_names`, `compact`, or custom
   `instructions`. The runner may add only ephemeral paths and timeout
   settings needed for isolation and measurement.
6. Allocate unique, empty output and worktree roots outside the repository.
   The runner resets and cleans its assigned worktree; never point it at a
   working checkout. The driver also removes cell worktrees and data roots.
7. Resolve or explicitly record the limitations below before treating the
   campaign as ready. Preparation alone is not a passing smoke.

## Commands and gates

These are command templates, not commands executed by this document. Set all
paths to verified absolute locations. Keep the same variables, build, corpus,
and environment for smoke and measurement. Do not reuse an output directory.

```bash
BENCH_NODE=/absolute/path/to/node
BENCH_CODEX=/absolute/path/to/codex
BENCH_MEMORY=/absolute/path/to/codebase-memory-mcp
BENCH_GRAPH=/absolute/path/to/codegraph
BENCH_TGREP=/absolute/path/to/tgrep
BENCH_REPOS=/absolute/path/to/benchmark-repositories
BENCH_OUT=/absolute/path/to/new-campaign-directory
```

Run from the Urdira checkout. The driver has no safe `--help` or `--dry-run`
mode; unknown flags are not validated. In particular, it has no `--model`
override: it reads the corpus model. A model change requires a separately
recorded corpus revision and fresh runs for all arms.

First run the required sequential Urdira smoke for the selected repositories.
The full-corpus example below covers all eight tasks:

```bash
"$BENCH_NODE" release/benchmarks/run-expanded-agent-benchmark.mjs \
  --samples 1 --arms urdira-typescript \
  --repositories typescript,playwright,prisma,vscode \
  --repositories-root "$BENCH_REPOS" --output-dir "$BENCH_OUT/smoke-urdira" \
  --node "$BENCH_NODE" --codex "$BENCH_CODEX" \
  --codebase-memory "$BENCH_MEMORY" --codegraph "$BENCH_GRAPH" \
  --tgrep "$BENCH_TGREP"
```

For every arm that will run with more than one sample, create a separate smoke
audit for that arm using the same selected repositories. Require one successful,
distinct execution per selected repository/task, zero audit failures, and manual
transcript/cleanup review. Urdira smoke additionally proves structural
readiness under `URDIRA_SEMANTIC_INDEX=0`; its MCP entrypoint must inherit the
production presentation described above. A broader successful smoke is
accepted when it contains exactly one success for each selected task and the
entry's arm matches the arm being gated. Missing tasks, duplicate selected
successes, failed audits, and another repository's smoke cannot qualify the
requested scope. The driver accepts only the smoke audits named for selected
arms; if an arm's audit is missing or fails, that arm is blocked before cell
execution while other eligible arms may proceed.

Create the four comparator smoke audits with the same selected repository list,
changing only `--arms` and the output directory. This example records the
remaining arms in separate audits:

```bash
for BENCH_ARM in baseline codebase-memory codegraph tgrep; do
  "$BENCH_NODE" release/benchmarks/run-expanded-agent-benchmark.mjs \
    --samples 1 --arms "$BENCH_ARM" \
    --repositories typescript,playwright,prisma,vscode \
    --repositories-root "$BENCH_REPOS" --output-dir "$BENCH_OUT/smoke-$BENCH_ARM" \
    --node "$BENCH_NODE" --codex "$BENCH_CODEX" \
    --codebase-memory "$BENCH_MEMORY" --codegraph "$BENCH_GRAPH" \
    --tgrep "$BENCH_TGREP"
done
```

Use the same `--repositories` selection in both commands:

| Scope | Selection | Smoke runs per arm | Five-arm runs, 1 / 3 samples |
|---|---|---:|---:|
| Small | `--repositories playwright` | 2 | 10 / 30 |
| Medium | `--repositories prisma` | 2 | 10 / 30 |
| Large | `--repositories vscode` (or `typescript`) | 2 | 10 / 30 |
| Small + medium + large | `--repositories playwright,prisma,vscode` | 6 | 30 / 90 |
| Full corpus | `--repositories typescript,playwright,prisma,vscode` | 8 | 40 / 120 |

For example, to measure only Prisma, replace the repository list in every
smoke and measurement command with `--repositories prisma`; each selected arm
then needs its own two-task smoke, and no TypeScript, Playwright, or VS Code
smoke is required. The required tasks are derived from the selected corpus
entries, not hardcoded to two tasks or eight total.

After each selected arm's smoke and attribution review passes, the planned full
comparison is:

```bash
"$BENCH_NODE" release/benchmarks/run-expanded-agent-benchmark.mjs \
  --samples 3 \
  --smoke-audits "baseline=$BENCH_OUT/smoke-baseline/audit.json,urdira-typescript=$BENCH_OUT/smoke-urdira/audit.json,codebase-memory=$BENCH_OUT/smoke-codebase-memory/audit.json,codegraph=$BENCH_OUT/smoke-codegraph/audit.json,tgrep=$BENCH_OUT/smoke-tgrep/audit.json" \
  --arms baseline,urdira-typescript,codebase-memory,codegraph,tgrep \
  --repositories typescript,playwright,prisma,vscode \
  --repositories-root "$BENCH_REPOS" --output-dir "$BENCH_OUT/full" \
  --node "$BENCH_NODE" --codex "$BENCH_CODEX" \
  --codebase-memory "$BENCH_MEMORY" --codegraph "$BENCH_GRAPH" \
  --tgrep "$BENCH_TGREP"
```

A separately declared one-sample comparison uses `--samples 1` and contains
40 runs. Although the driver does not enforce its smoke prerequisite for one
sample, the
operator must still satisfy Decision 08. Smoke runs are not silently counted
as measurement samples. The driver rotates arm order by sample, repository,
and task, and executes cells sequentially.

## Cell protocol and audit

1. Work in the frozen checkout and choose the discovery and editing workflow a
   normal coding agent would choose from the tools configured for that arm.
2. Finish implementation, wiring, and focused tests, recording the tools and
   recovery paths the agent actually used. No commits.
3. Review the diff, attempt narrow checks if dependencies exist, and report
   exact checks and limitations. No runner prompt directs a tool choice or a
   post-edit rediscovery step.

Urdira readiness and inter-turn waits require the current complete structural
frontier. Semantic work is excluded entirely. Each arm configures its
integration in the coding agent environment; the agent may select that
integration, another available integration, or ordinary repository tools as
its normal workflow dictates. The runner supplies no discovery policy.

Urdira composition is measured as an agent choice. Pipelines, registered
recipes, direct operations, and `urdira_context` are all valid according to the
task and the public MCP contract. The grader records pipeline/recipe counts,
direct-operation calls, valid dependencies, and malformed composition attempts
as observational metrics; no composition choice is a correctness gate.

Audit the actual transcript, not just the final answer: natural tool selection,
MCP/non-MCP use, discovery before and after edits when present, source
freshness, fallback, unexpected tool failures, valid selector-ambiguity
recovery, and test command outcomes. Review all arms; the grader checks the
common task contract: changed paths, required patterns, test-file changes, diff
whitespace, and real integration failures. It does not require use of Urdira or
any other configured tool, establish semantic correctness, or execute a
repository test suite. Report “grader passed” and
“tests passed” separately.

The current driver writes `audit.json` after each cell but does not pause for
manual review or stop automatically on a failed cell. It has no resume or
single-task selection option. If strict review-before-next-cell is required,
add and verify that orchestration before launch; do not claim the existing
batch command provides it. Retain failed attempts and their causes. Do not
rerun until green and silently replace failures. A fix changes the measured
build and requires a new identified campaign/smoke, preserving prior evidence.

## Reports and retention

Generate derived reports while transcripts still exist:

```bash
"$BENCH_NODE" release/benchmarks/render-expanded-agent-report.mjs \
  --audit "$BENCH_OUT/full/audit.json" --output "$BENCH_OUT/report"
```

Retain each manifest, transcript, host log, audit, environment manifest, raw
hashes, manual review, and generated JSON/Markdown outside the public tree.
Publish sanitized derived evidence and a dated note under `docs/evidence/`.
Inspect generated reports for paths/secrets; do not assume sanitization is complete.

Report per task/arm/sample: grader result, declared target coverage and
omissions, discovery attribution, actual test attempts/passes/failures/unknown,
setup, agent time
(including inter-turn waits), setup + agent total, tokens, estimated cost/rate
card, repository-read calls, returned context characters, unattributed-context
proxy, MCP counts/errors, structural readiness, comparable cell process-tree
RSS/CPU, Urdira readiness RSS, composition metrics (pipeline/recipe/direct
operation counts, dependency validity, and malformed composition reasons), and
storage/copy telemetry where present.
Driver audit elapsed time also includes orchestration/cleanup and is not the
same metric as setup + agent time. Missing metrics are unavailable, not zero;
review v4 catalog, lexical, structural, Rust sidecar, CAS, and semantic sizes
separately. Semantic size must remain zero and semantic-sidecar creation false.
Compare matched tasks and show every failure.

The cell runner writes a separate `<run-id>.timing.json` sidecar while each of
the three Codex turns is running. It timestamps complete JSONL lines using a
monotonic clock and leaves the original transcript byte-for-byte unchanged.
For `mcp_tool_call` and `command_execution` items it pairs `item.started` and
`item.completed` by `item.id`, publishes end-to-end durations, and records
`paired`, `completed_without_start`, or `started_without_completion` explicitly.
The sidecar includes per-tool MCP aggregates and command timing where present;
the renderer carries these records into JSON and a timing table in Markdown.
Each Codex process has an independent clock origin, so these values compare
durations, not absolute event order between turns. Missing or malformed lines
remain visible in the sidecar and do not alter grading.

For a diagnostic pass, set `URDIRA_V4_DEBUG_SEMANTIC_PERF=1` in the daemon or
worker environment. The production indexing-core transport forwards this
variable only when its value is exactly `1`; otherwise the child receives no
semantic-perf flag. The worker then emits one stable JSON record to stderr,
prefixed with `v4 semantic_perf`, containing aggregate microsecond/count
buckets for import/re-export/heritage, call/reference, typeflow, union/member,
and sibling-conformance work, plus typeflow alias-build timing and the ten
owners with the greatest semantic wall time. Each owner includes its path,
observed site count, candidates, pending sites, and published rows. The timing
is the complete per-owner hybrid call, including source retrieval; it is a
diagnostic attribution and must not replace the campaign's end-to-end timing.
The normal path does not read this environment, create timers, or serialize
telemetry, and `OwnerSemantics` remains unchanged. Alias telemetry covers the
indexed alias-target build as one aggregate; it does not provide a recursive
per-hop profile. The diagnostic is opt-in, stderr-only, and should be enabled
for a separately identified profiling pass rather than mixed into comparison
samples.

When timing or semantic profiling is enabled, the worker emits a preceding
`v4 startup_attestation` JSON line with its PID, executable path, and the
effective `semantic_perf_enabled` boolean. The profiled cell runner waits for
that line after host readiness and fails closed if it is absent or says false;
therefore a profiling result cannot silently become an uninstrumented result.

The renderer defaults to a planning card of USD 2/M input, 8/M output and
8/M reasoning tokens; freeze and disclose the accounting convention, including
cached/reasoning token treatment. These estimates are not provider invoices.
Three samples in one campaign are not three independent campaigns. The driver's
`--independent-campaigns` flag only writes metadata and the renderer trusts it;
never set it to three without three genuinely independent, retained campaigns.
Decision 08 requires those before reporting P95.

Verify cleanup for each owned worktree, data root, comparator project and
process; investigate false cleanup flags. Preserve transcripts/reports before
removing temporary artifacts. The current driver deletes worktrees immediately,
so preserving diffs or additional untracked tests requires a verified capture
step before cleanup. No unrelated project or daemon should be removed.

## Historical provenance and next-campaign readiness

The [2026-08-27 report](../../release/benchmarks/expanded-typescript-agent-benchmark-results-2026-08-27.md)
and its JSON describe 32/32 grader passes, one sample per cell, and freshly run
comparators. The older README/release narrative describes a Urdira-only rerun
with reused comparator rows and 27/32 passes. These are conflicting historical
narratives; do not blend them or certify fresh provenance from prose alone.
Raw August transcripts were removed after extraction according to that report.
Resolve the discrepancy from retained audit digests/derived provenance where
possible, and label any remaining uncertainty. No historical row should enter
the next fresh comparison.

See the [preparation record](../evidence/2026-09-09-expanded-agent-campaign-preparation.md)
for current findings and outstanding preflight work. The executable protocol,
agent CLI compatibility, current v4 host readiness, and grader attribution must
be exercised before any new performance claim.
