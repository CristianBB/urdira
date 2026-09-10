#!/usr/bin/env node
/* global URL */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeExpandedTranscript, analyzeUrdiraPipelineContract, isShellSourceReadCommand } from "./expanded-agent-transcript-metrics.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const corpus = JSON.parse(readFileSync(join(root, "release/benchmarks/expanded-typescript-agent-benchmark.json"), "utf8"));
const argv = process.argv.slice(2);
const value = (name, fallback) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };
const worktree = resolve(value("--worktree", "."));
const repositoryId = value("--repository-id");
const taskId = value("--task-id");
const arm = value("--arm", "baseline");
const transcriptPath = value("--transcript");
const repo = corpus.repositories.find((entry) => entry.id === repositoryId);
const task = repo?.tasks.find((entry) => entry.id === taskId);
if (!repo || !task) throw new Error(`Unknown repository/task: ${repositoryId}/${taskId}`);

const changedOutput = (() => {
  const changed = spawnSync("git", ["diff", "--name-only", "--diff-filter=ACMRT"], { cwd: worktree, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd: worktree, encoding: "utf8" });
  return [...new Set([
    ...(changed.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean),
    ...(status.stdout ?? "").split("\n").map((line) => line.slice(3).trim()).filter(Boolean),
  ])].filter((file) => !file.startsWith(".codegraph/") && !file.startsWith(".codebase-memory/") && file !== "node_modules" && !file.startsWith("node_modules/"));
})();
const allSource = (pathFilter) => {
  const files = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && pathFilter.test(path.slice(worktree.length + 1))) files.push(path);
    }
  };
  walk(worktree);
  return files.map((path) => readFileSync(path, "utf8")).join("\n");
};
const readRelative = (relativePath) => {
  if (relativePath.endsWith("/")) return allSource(new RegExp(`^${relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const path = join(worktree, relativePath);
  return existsSync(path) ? readFileSync(path, "utf8") : allSource(new RegExp(`^${relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
};
const required = Object.fromEntries(task.required_patterns.map(({ path, regex }) => [path, new RegExp(regex, "i").test(readRelative(path))]));
const changedMatches = task.changed_path_regex.every((pattern) => changedOutput.some((file) => new RegExp(pattern).test(file)));
const testChanged = changedOutput.some((file) => new RegExp(task.test_pattern).test(file));
const diffText = spawnSync("git", ["diff", "--unified=0"], { cwd: worktree, encoding: "utf8" }).stdout ?? "";
const diffClean = diffText.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .every((line) => !/[ \t]+$/.test(line.replace(/\r$/, "")));
const transcript = transcriptPath && existsSync(transcriptPath)
  ? readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
  : [];
const eventText = transcript.map((event) => JSON.stringify(event)).join("\n");
const shellCommandText = transcript
  .flatMap((event) => event?.type === "item.completed" && event.item?.type === "command_execution" ? [String(event.item.command ?? "")] : [])
  .join("\n");
const editPattern = /apply_patch|file_change|write_file|git\s+apply|editor_action/iu;
const discoveryPattern = /urdira_(?:query|context|benchmark_discover)/u;
// `git diff/status` are explicitly allowed after an edit. A pager such as
// `git diff ... | head` is still diff review, not repository discovery, so
// only treat head/tail/awk as fallback readers when they are not a pipeline
// consumer. Commands that obtain source first (cat/rg/etc.) remain blocked,
// including less-common readers (bat/less/more/nl/strings/xxd/od) and
// one-liner script readers (python -c/node -e that call open()/readFile*).
const editIndices = transcript.map((event, index) => editPattern.test(JSON.stringify(event)) ? index : -1).filter((index) => index >= 0);
const discoveryIndices = transcript.map((event, index) => discoveryPattern.test(JSON.stringify(event)) ? index : -1).filter((index) => index >= 0);
const completedTranscriptItems = transcript.filter((event) => event?.type === "item.completed");
const failedUrdiraDiscoveryCall = completedTranscriptItems.some((event) => {
  if (event.item?.type !== "mcp_tool_call" || event.item?.server !== "urdira" || event.item?.tool === "urdira_index_status" || event.item?.status !== "failed") return false;
  const encoded = JSON.stringify(event);
  // Ambiguity is a legitimate closed-query outcome, not malformed tool use.
  // The transcript audit records its frequency and whether the agent narrows
  // with candidates or switches to another Urdira query; either remains a
  // Urdira-only discovery path and must not be confused with native fallback.
  if (encoded.includes("core:selector_ambiguous") || encoded.includes("core:execution_resource_limit")) return false;
  return true;
});
const transcriptMetrics = analyzeExpandedTranscript(transcript, arm, task);
const compositionMetrics = arm === "urdira-typescript" ? analyzeUrdiraPipelineContract(transcript) : undefined;
// Discovery method and timing are observational. The arm configures one
// integration, but the agent remains free to use it, another available tool,
// or ordinary repository tools as its normal workflow dictates.
const discoveryBeforeEdit = transcriptMetrics.observed_discovery_before_edit;
const rediscoveryAfterEdit = transcriptMetrics.observed_rediscovery_after_each_edit;
// Only actual shell executions can prove that the agent used a native-source
// fallback. Searching the full transcript made ordinary agent prose such as
// "find the caller" indistinguishable from a shell command.
const fallbackShell = arm === "urdira-typescript" && shellCommandText.split("\n").some(isShellSourceReadCommand);
const discoveryStatus = arm !== "urdira-typescript"
  ? "not-applicable"
  : fallbackShell
    ? "fallback-completed"
    : discoveryBeforeEdit && rediscoveryAfterEdit
      ? "urdira-completed"
      : "discovery-incomplete";
const unexpectedErrors = arm === "urdira-typescript" ? {
  tool_call: failedUrdiraDiscoveryCall,
  validation: /core:(?:request_invalid|unknown_field)|Input validation error|requires expression/iu.test(eventText),
  coverage: /core:coverage_incomplete/iu.test(eventText),
  ipc: /core:ipc_timeout/iu.test(eventText),
} : { validation: false, coverage: false, ipc: false };
const missingChangedPathPatterns = task.changed_path_regex.filter((pattern) => !changedOutput.some((file) => new RegExp(pattern).test(file)));
const missingRequiredPatterns = Object.entries(required).filter(([, present]) => !present).map(([path]) => path);
const declaredUnsafeOmissions = [
  ...missingChangedPathPatterns.map((pattern) => `changed_path:${pattern}`),
  ...missingRequiredPatterns.map((path) => `required_pattern:${path}`),
  ...(testChanged ? [] : ["focused_test"]),
];
const discoveryEvidence = {
  discovery_status: discoveryStatus,
  first_discovery_before_edit: discoveryBeforeEdit,
  rediscovery_after_edit: rediscoveryAfterEdit,
  observed_discovery_before_edit: discoveryBeforeEdit,
  observed_rediscovery_after_each_edit: rediscoveryAfterEdit,
  edit_count: editIndices.length,
  discovery_count: discoveryIndices.length,
  fallback_shell: fallbackShell,
  unexpected_errors: unexpectedErrors,
};
const evidence = {
  changed_files: changedOutput,
  changed_paths: changedMatches,
  target_set_coverage: {
    matched: task.changed_path_regex.length - missingChangedPathPatterns.length,
    expected: task.changed_path_regex.length,
    complete: missingChangedPathPatterns.length === 0,
    missing_patterns: missingChangedPathPatterns,
  },
  required_patterns: required,
  missing_required_patterns: missingRequiredPatterns,
  focused_test_changed: testChanged,
  declared_unsafe_omissions: declaredUnsafeOmissions,
  evidence_grounded_plan: discoveryBeforeEdit && rediscoveryAfterEdit,
  transcript_metrics: transcriptMetrics,
  ...(compositionMetrics === undefined ? {} : { composition_metrics: compositionMetrics }),
  diff_clean: diffClean,
  ...discoveryEvidence,
};
const correctnessPass = changedMatches && Object.values(required).every(Boolean) && testChanged && diffClean;
// A cell is graded on the task contract and real integration failures. It is
// valid for an agent to make no Urdira/MCP calls at all; that natural choice
// must never become a failed cell merely because the configured tool was not
// selected.
const discoveryPass = !Object.values(unexpectedErrors).some(Boolean);
const completedSuccessfully = correctnessPass && discoveryPass;
console.log(JSON.stringify({ completed_successfully: completedSuccessfully, repository: repositoryId, task: taskId, evidence }, null, 2));
if (!completedSuccessfully) process.exitCode = 1;
