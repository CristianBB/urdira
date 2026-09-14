#!/usr/bin/env node
/* global URL */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeExpandedTranscript, analyzeUrdiraPipelineContract } from "./expanded-agent-transcript-metrics.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const argv = process.argv.slice(2);
const value = (name, fallback) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };
const auditPath = value("--audit");
const comparisonReportPath = value("--comparison-report");
if (!auditPath) throw new Error("Usage: render-expanded-agent-report.mjs --audit <audit.json> [--comparison-report <report.json>] [--output <path without extension>]");
const auditText = readFileSync(auditPath, "utf8");
const audit = JSON.parse(auditText);
const corpus = JSON.parse(readFileSync(join(root, "release/benchmarks/expanded-typescript-agent-benchmark.json"), "utf8"));
const generatedDate = String(audit.generated_at ?? "").slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/u.test(generatedDate) && !value("--output")) throw new Error("The audit requires a YYYY-MM-DD generated_at when --output is omitted.");
const outputBase = value("--output", join(root, `release/benchmarks/expanded-typescript-agent-benchmark-results-${generatedDate}`));
const comparisonReport = comparisonReportPath ? JSON.parse(readFileSync(comparisonReportPath, "utf8")) : null;
const rateCard = {
  input: Number(process.env.BENCH_INPUT_USD_PER_MILLION ?? 2),
  cached_input: Number(process.env.BENCH_CACHED_INPUT_USD_PER_MILLION ?? process.env.BENCH_INPUT_USD_PER_MILLION ?? 2),
  output: Number(process.env.BENCH_OUTPUT_USD_PER_MILLION ?? 8),
  reasoning: Number(process.env.BENCH_REASONING_USD_PER_MILLION ?? 8),
};
const percentile = (values, p) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null; };
const independentCampaigns = Number(audit.independent_campaigns ?? 1);
const p95Eligible = independentCampaigns >= 3;
const mean = (values) => { const usable = values.filter(Number.isFinite); return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null; };
const sanitizeText = (value) => String(value).replaceAll(/\/private\/tmp\/[^\s"']+/g, "<temp>").replaceAll(/\/tmp\/[^\s"']+/g, "<temp>");
const timingFor = (manifest) => {
  if (manifest?.timing_metrics && typeof manifest.timing_metrics === "object") return manifest.timing_metrics;
  if (!manifest?.timing_sidecar || !existsSync(manifest.timing_sidecar)) return null;
  try {
    const timing = JSON.parse(readFileSync(manifest.timing_sidecar, "utf8"));
    return timing && typeof timing === "object" ? timing : null;
  } catch { return null; }
};
const normalizedDiffClean = (worktree) => {
  if (!worktree) return false;
  const diff = spawnSync("git", ["diff", "--unified=0"], { cwd: worktree, encoding: "utf8" });
  if (diff.status !== 0) return false;
  return (diff.stdout ?? "").split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .every((line) => !/[ \t]+$/.test(line.replace(/\r$/, "")));
};
const metricsFor = (manifest, arm, task) => {
  if (!manifest?.transcript) return undefined;
  let events;
  try { events = readFileSync(manifest.transcript, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return undefined; }
  let hookAudit;
  try {
    hookAudit = typeof manifest.hook_audit_path === "string" && existsSync(manifest.hook_audit_path)
      ? readFileSync(manifest.hook_audit_path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
  } catch { hookAudit = []; }
  const completed = events.filter((event) => event.type === "item.completed");
  const mcpCalls = completed.filter((event) => event.item?.type === "mcp_tool_call");
  const mcpFailureDetails = mcpCalls.filter((event) => event.item?.status === "failed").map((event) => {
    const text = (event.item?.result?.content ?? [])
      .filter((item) => item?.type === "text")
      .map((item) => String(item.text ?? ""))
      .join(" ")
      .replaceAll(/\s+/gu, " ")
      .trim();
    return sanitizeText(`${event.item?.tool ?? "mcp_tool"}: ${text || "MCP call failed without a response body."}`).slice(0, 1000);
  });
  const discoveryMcpCalls = mcpCalls.filter((event) => event.item?.tool !== "urdira_index_status");
  const discoveryRequest = (event) => event.item?.arguments?.query ?? event.item?.arguments ?? {};
  const discoveryResultText = (event) => (event.item?.result?.content ?? [])
    .filter((item) => item?.type === "text")
    .map((item) => String(item.text ?? ""))
    .join("\n");
  const selectorAmbiguities = discoveryMcpCalls.filter((event) =>
    event.item?.status === "failed" && JSON.stringify(event).includes("core:selector_ambiguous"));
  const resourceLimits = discoveryMcpCalls.filter((event) =>
    event.item?.status === "failed" && JSON.stringify(event).includes("core:execution_resource_limit"));
  const unexpectedFailedDiscoveryCalls = discoveryMcpCalls.filter((event) =>
    event.item?.status === "failed"
      && !JSON.stringify(event).includes("core:selector_ambiguous")
      && !JSON.stringify(event).includes("core:execution_resource_limit"));
  const completedDiscoveryCalls = discoveryMcpCalls.filter((event) => event.item?.status === "completed");
  const emptyDiscoveryCalls = completedDiscoveryCalls.filter((event) => /^(?:no results|# 0 results)/u.test(discoveryResultText(event)));
  const discoveryPattern = (event) => /urdira_(?:query|context|benchmark_discover)/u.test(JSON.stringify(event));
  const editPattern = (event) => /apply_patch|file_change|write_file|git\s+apply|editor_action/iu.test(JSON.stringify(event));
  const discoveryIndices = completed.map((event, index) => discoveryPattern(event) ? index : -1).filter((index) => index >= 0);
  const editIndices = completed.map((event, index) => editPattern(event) ? index : -1).filter((index) => index >= 0);
  const firstDiscoveryIndex = discoveryIndices.at(0);
  const firstEditIndex = editIndices.at(0);
  const firstTimestamp = events.find((event) => typeof event.timestamp === "string")?.timestamp;
  const firstDiscoveryTimestamp = firstDiscoveryIndex === undefined ? undefined : completed[firstDiscoveryIndex]?.timestamp;
  const timestampDelta = firstTimestamp !== undefined && firstDiscoveryTimestamp !== undefined
    ? Math.max(0, Date.parse(firstDiscoveryTimestamp) - Date.parse(firstTimestamp))
    : null;
  const usage = events.filter((event) => event.type === "turn.completed").map((event) => event.usage ?? {});
  const threadIds = events.filter((event) => event.type === "thread.started" && typeof event.thread_id === "string").map((event) => event.thread_id);
  const counters = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"];
  const oneResumedThread = usage.length > 1 && threadIds.length === usage.length && new Set(threadIds).size === 1;
  const monotonicCounters = counters.every((field) => usage.every((item, index) => index === 0 || Number(item[field] ?? 0) >= Number(usage[index - 1]?.[field] ?? 0)));
  const cumulativeUsage = oneResumedThread && monotonicCounters;
  const total = (field) => cumulativeUsage ? Number(usage.at(-1)?.[field] ?? 0) : usage.reduce((sum, item) => sum + Number(item[field] ?? 0), 0);
  const input = total("input_tokens");
  const cached = total("cached_input_tokens");
  const output = total("output_tokens");
  const reasoning = total("reasoning_output_tokens");
  const transcriptMetrics = analyzeExpandedTranscript(events, arm, task, { hook_audit: hookAudit });
  const compositionMetrics = arm === "urdira-typescript" ? analyzeUrdiraPipelineContract(events) : null;
  const uncached = Math.max(0, input - cached);
  return {
    ...transcriptMetrics,
    composition_metrics: compositionMetrics,
    token_usage_semantics: cumulativeUsage ? "cumulative_thread" : "per_turn",
    outer_turns: usage.length,
    observable_agent_iterations: completed.filter((event) => event.item?.type === "agent_message").length,
    command_actions: completed.filter((event) => event.item?.type === "command_execution").length,
    mcp_calls: mcpCalls.length,
    mcp_failed_calls: mcpCalls.filter((event) => event.item?.status === "failed").length,
    mcp_discovery_calls: discoveryMcpCalls.length,
    mcp_discovery_successful_calls: completedDiscoveryCalls.length,
    mcp_selector_ambiguous_calls: selectorAmbiguities.length,
    mcp_resource_limit_calls: resourceLimits.length,
    mcp_unexpected_failed_calls: unexpectedFailedDiscoveryCalls.length,
    mcp_empty_discovery_calls: emptyDiscoveryCalls.length,
    mcp_useful_discovery_calls: completedDiscoveryCalls.length - emptyDiscoveryCalls.length,
    api_v3_discovery_calls: discoveryMcpCalls.filter((event) => discoveryRequest(event)?.api_version === 3).length,
    explicit_workspace_discovery_calls: discoveryMcpCalls.filter((event) => {
      const scope = discoveryRequest(event)?.scope;
      return scope?.scope_type === "single_workspace" && typeof scope.workspace_id === "string" && scope.workspace_id.length > 0;
    }).length,
    first_discovery_before_edit: transcriptMetrics.observed_discovery_before_edit ?? (firstDiscoveryIndex !== undefined && (firstEditIndex === undefined || firstDiscoveryIndex < firstEditIndex)),
    first_discovery_elapsed_ms: timestampDelta,
    post_edit_discovery_calls: transcriptMetrics.observed_post_edit_discovery_calls ?? (firstEditIndex === undefined ? 0 : discoveryIndices.filter((index) => index > firstEditIndex).length),
    rediscovery_after_each_edit: transcriptMetrics.observed_rediscovery_after_each_edit ?? editIndices.every((edit) => discoveryIndices.some((discovery) => discovery > edit)),
    core_ipc_timeouts: mcpCalls.filter((event) => JSON.stringify(event).includes("core:ipc_timeout")).length,
    core_coverage_incomplete: mcpCalls.filter((event) => JSON.stringify(event).includes("core:coverage_incomplete")).length,
    request_validation_failures: mcpCalls.filter((event) => {
      const encoded = JSON.stringify(event);
      return encoded.includes("Input validation error")
        || encoded.includes("requires expression")
        || encoded.includes("core:request_invalid")
        || encoded.includes("core:request_validation_failed");
    }).length,
    file_change_batches: completed.filter((event) => event.item?.type === "file_change").length,
    input_tokens: input,
    cached_input_tokens: cached,
    uncached_input_tokens: uncached,
    output_tokens: output,
    reasoning_tokens: reasoning,
    total_tokens: input + output + reasoning,
    estimated_cost_usd: (uncached * rateCard.input + cached * rateCard.cached_input + output * rateCard.output + reasoning * rateCard.reasoning) / 1_000_000,
    mcp_failure_details: mcpFailureDetails,
  };
};
const hostEvidenceFor = (manifest) => {
  if (!manifest?.host_metrics && !(manifest?.host_log && existsSync(manifest.host_log))) return null;
  let stage_timings = null;
  let analysis_timings = null;
  let byte_telemetry = null;
  if (manifest.host_log && existsSync(manifest.host_log)) {
    const lines = readFileSync(manifest.host_log, "utf8").split("\n");
    const timingLines = lines.filter((line) => line.includes("[urdira] scan timings "));
    const initialPublication = timingLines.find((line) => line.includes("status=published"));
    const match = initialPublication?.match(/ms=(\{.*\})\s*$/u);
    if (match) {
      try { stage_timings = JSON.parse(match[1]); } catch { stage_timings = null; }
    }
    const analysisLines = lines.filter((line) => line.includes("[urdira] analyze timings "));
    const analysisMatch = analysisLines.at(0)?.match(/ms=(\{.*\})\s*$/u);
    if (analysisMatch) {
      try { analysis_timings = JSON.parse(analysisMatch[1]); } catch { analysis_timings = null; }
    }
    const telemetryLine = lines.filter((line) => line.includes("[urdira] byte telemetry ")).at(-1);
    const telemetryMatch = telemetryLine?.match(/\[urdira\] byte telemetry (\{.*\})\s*$/u);
    if (telemetryMatch) {
      try { byte_telemetry = JSON.parse(telemetryMatch[1]); } catch { byte_telemetry = null; }
    }
  }
  const totals = Object.values(byte_telemetry ?? {}).reduce((sum, item) => ({
    read: sum.read + Number(item?.read ?? 0),
    transferred: sum.transferred + Number(item?.transferred ?? 0),
    copied: sum.copied + Number(item?.copied ?? 0),
    decoded: sum.decoded + Number(item?.decoded ?? 0),
    retained: sum.retained + Number(item?.retained ?? 0),
  }), { read: 0, transferred: 0, copied: 0, decoded: 0, retained: 0 });
  const readiness_events = manifest.host_metrics?.readiness_events ?? (manifest.host_log && existsSync(manifest.host_log)
    ? readFileSync(manifest.host_log, "utf8").split("\n").flatMap((line) => {
      const match = line.match(/BENCH_FRONTIER (\{.*\})\s*$/u);
      if (!match) return [];
      try { return [JSON.parse(match[1])]; } catch { return []; }
    }) : []);
  const readyLine = manifest.host_log && existsSync(manifest.host_log)
    ? readFileSync(manifest.host_log, "utf8").split("\n").find((line) => line.includes("BENCH_HOST_READY"))
    : undefined;
  let structural_readiness_ms = manifest.host_metrics?.structural_readiness_ms ?? manifest.host_metrics?.ready_elapsed_ms ?? null;
  if (structural_readiness_ms === null && readyLine) {
    const match = readyLine.match(/BENCH_HOST_READY (\{.*\})\s*$/u);
    try { structural_readiness_ms = match ? Number(JSON.parse(match[1]).elapsed_ms ?? NaN) : null; } catch { structural_readiness_ms = null; }
  }
  return { ...(manifest.host_metrics ?? {}), stage_timings, analysis_timings, byte_telemetry, readiness_events, structural_readiness_ms, ready_elapsed_ms: structural_readiness_ms, bytes_read: totals.read || null, bytes_transferred: totals.transferred || null, bytes_copied: totals.copied || null, bytes_decoded: totals.decoded || null, bytes_retained: totals.retained || null };
};
const graderFailureDetails = (manifest) => {
  const evidence = manifest?.correctness?.evidence;
  if (manifest?.completed_successfully !== false || !evidence) return null;
  const details = [];
  if (evidence.changed_paths === false) details.push("grader rejected changed_paths=false");
  if (evidence.focused_test_changed === false) details.push("grader rejected focused_test_changed=false");
  const missingPatterns = Object.entries(evidence.required_patterns ?? {})
    .filter(([, present]) => !present)
    .map(([pattern]) => pattern);
  if (missingPatterns.length > 0) details.push(`missing required implementation evidence: ${missingPatterns.join(", ")}`);
  return details.length > 0 ? details.join("; ") : "grader rejected the correctness evidence";
};
const freshRuns = audit.runs.map((entry) => {
  const manifest = entry.manifest;
  const taskContract = corpus.repositories.find((repository) => repository.id === entry.repository)?.tasks.find((task) => task.id === entry.task);
  const transcriptMetrics = metricsFor(manifest, entry.arm, taskContract);
  const rawEvidence = manifest?.correctness?.evidence;
  const evidence = rawEvidence ? { ...rawEvidence, diff_clean: rawEvidence.diff_clean === true || normalizedDiffClean(manifest.worktree) } : rawEvidence;
  const evidencePass = evidence?.changed_paths === true
    && evidence.focused_test_changed === true
    && evidence.diff_clean === true
    && Object.values(evidence.required_patterns ?? {}).every(Boolean);
  return {
    run_id: entry.run_id,
    repository: entry.repository,
    task: entry.task,
    scenario: entry.scenario ?? manifest?.scenario ?? null,
    size_tier: entry.size_tier ?? manifest?.size_tier ?? null,
    arm: entry.arm,
    sample: entry.sample,
    order_index: entry.order_index,
    process_exit_code: entry.exit_code,
    process_completed_successfully: manifest?.completed_successfully === true,
    // New manifests carry the runner's authoritative outcome, which includes
    // the repository grader result. Do not turn an agent process exit of zero
    // into a successful benchmark when the grader rejected the cell (for
    // example after an MCP request-validation failure). Keep the evidence
    // fallback only for older manifests that predate this field.
    completed_successfully: typeof manifest?.completed_successfully === "boolean"
      ? manifest.completed_successfully
      : (manifest?.exit_code === 0 && evidencePass),
    setup_elapsed_ms: manifest?.setup_elapsed_ms ?? null,
    elapsed_ms_from_first_instruction: manifest?.elapsed_ms_from_first_instruction ?? null,
    incremental_protocol: manifest?.incremental_protocol ?? null,
    cleanup: entry.cleanup ?? null,
    timing_sidecar: manifest?.timing_sidecar ?? null,
    metrics: transcriptMetrics,
    timing_metrics: timingFor(manifest),
    process_metrics: entry.process_metrics ?? null,
    host_metrics: hostEvidenceFor(manifest),
    correctness: manifest?.correctness?.evidence ?? null,
    setup: manifest?.setup ? {
      kind: manifest.setup.kind ?? null,
      indexed: manifest.setup.indexed ?? null,
      project: manifest.setup.project ?? null,
      elapsed_ms: manifest.setup.elapsed_ms ?? null,
      semantic_index: manifest.setup.semantic_index ?? null,
      readiness: manifest.setup.readiness ?? null,
    } : null,
    failure: manifest?.error || entry.stderr_tail
      ? sanitizeText(manifest?.error ?? entry.stderr_tail)
      : (transcriptMetrics?.mcp_failure_details?.join("; ") ?? graderFailureDetails(manifest)),
  };
});
const reusedRuns = comparisonReport?.runs?.filter((run) => run.arm !== "urdira-typescript") ?? [];
const reusedArms = [...new Set(reusedRuns.map((run) => run.arm))];
const armOrder = ["baseline", "urdira-typescript", "codebase-memory", "codegraph", "tgrep"];
const repositoryOrder = new Map((audit.repositories ?? []).map((repository, index) => [repository.id, index]));
const taskOrder = new Map((audit.repositories ?? []).flatMap((repository) => repository.tasks.map((task, index) => [`${repository.id}:${task.id}`, index])));
const runs = [...reusedRuns, ...freshRuns].sort((left, right) =>
  (repositoryOrder.get(left.repository) ?? Number.MAX_SAFE_INTEGER) - (repositoryOrder.get(right.repository) ?? Number.MAX_SAFE_INTEGER)
  || (taskOrder.get(`${left.repository}:${left.task}`) ?? Number.MAX_SAFE_INTEGER) - (taskOrder.get(`${right.repository}:${right.task}`) ?? Number.MAX_SAFE_INTEGER)
  || armOrder.indexOf(left.arm) - armOrder.indexOf(right.arm));
const corpusExpectedRuns = Array.isArray(audit.repositories)
  ? audit.repositories.reduce((total, repository) => total + (repository.tasks?.length ?? 0), 0) * (audit.arms?.length ?? 0) * Number(audit.samples_per_cell ?? 1)
  : freshRuns.length;
const expectedRuns = Number(audit.expected_runs ?? corpusExpectedRuns) + reusedRuns.length;
const successfulRuns = runs.filter((run) => run.completed_successfully).length;
const benchmarkAudit = comparisonReport ? {
  ...audit,
  arms: armOrder.filter((arm) => runs.some((run) => run.arm === arm)),
  reused_arms: reusedArms,
  expected_runs: expectedRuns,
  successful_runs: successfulRuns,
  failed_runs: runs.length - successfulRuns,
  campaign_gate: { passed: runs.length === expectedRuns && successfulRuns === expectedRuns },
  rerun_status: freshRuns.length === Number(audit.expected_runs ?? freshRuns.length) ? "complete" : "partial",
  rerun_observed_runs: freshRuns.length,
  rerun_expected_runs: Number(audit.expected_runs ?? freshRuns.length),
} : audit;
const groups = {};
for (const run of runs) {
  const key = `${run.repository}:${run.task}:${run.arm}`;
  (groups[key] ??= []).push(run);
}
const summaries = Object.fromEntries(Object.entries(groups).map(([key, rows]) => {
  const numeric = (field) => rows.map((row) => Number(row.metrics?.[field] ?? NaN));
  return [key, {
    count: rows.length,
    successful: rows.filter((row) => row.completed_successfully).length,
    setup_elapsed_ms: { median: percentile(rows.map((row) => Number(row.setup_elapsed_ms ?? NaN)), 0.5), mean: mean(rows.map((row) => Number(row.setup_elapsed_ms ?? NaN))) },
    elapsed_ms_from_first_instruction: { median: percentile(rows.map((row) => Number(row.elapsed_ms_from_first_instruction ?? NaN)), 0.5), mean: mean(rows.map((row) => Number(row.elapsed_ms_from_first_instruction ?? NaN))), p95: p95Eligible ? percentile(rows.map((row) => Number(row.elapsed_ms_from_first_instruction ?? NaN)), 0.95) : null },
    total_tokens: { median: percentile(numeric("total_tokens"), 0.5), mean: mean(numeric("total_tokens")), p95: p95Eligible ? percentile(numeric("total_tokens"), 0.95) : null },
    estimated_cost_usd: { median: percentile(numeric("estimated_cost_usd"), 0.5), mean: mean(numeric("estimated_cost_usd")), p95: p95Eligible ? percentile(numeric("estimated_cost_usd"), 0.95) : null },
    outer_turns: { median: percentile(numeric("outer_turns"), 0.5), mean: mean(numeric("outer_turns")) },
    mcp_calls: { median: percentile(numeric("mcp_calls"), 0.5), mean: mean(numeric("mcp_calls")) },
    mcp_failed_calls: { median: percentile(numeric("mcp_failed_calls"), 0.5), mean: mean(numeric("mcp_failed_calls")) },
    mcp_discovery_calls: { median: percentile(numeric("mcp_discovery_calls"), 0.5), mean: mean(numeric("mcp_discovery_calls")) },
    mcp_discovery_successful_calls: { median: percentile(numeric("mcp_discovery_successful_calls"), 0.5), mean: mean(numeric("mcp_discovery_successful_calls")) },
    mcp_selector_ambiguous_calls: { median: percentile(numeric("mcp_selector_ambiguous_calls"), 0.5), mean: mean(numeric("mcp_selector_ambiguous_calls")) },
    mcp_unexpected_failed_calls: { median: percentile(numeric("mcp_unexpected_failed_calls"), 0.5), mean: mean(numeric("mcp_unexpected_failed_calls")) },
    mcp_empty_discovery_calls: { median: percentile(numeric("mcp_empty_discovery_calls"), 0.5), mean: mean(numeric("mcp_empty_discovery_calls")) },
    mcp_useful_discovery_calls: { median: percentile(numeric("mcp_useful_discovery_calls"), 0.5), mean: mean(numeric("mcp_useful_discovery_calls")) },
    web_search_calls: { median: percentile(numeric("web_search_calls"), 0.5), mean: mean(numeric("web_search_calls")) },
    file_change_actions: { median: percentile(numeric("file_change_actions"), 0.5), mean: mean(numeric("file_change_actions")) },
    integration_warning_count: { median: percentile(numeric("integration_warning_count"), 0.5), mean: mean(numeric("integration_warning_count")) },
    hook_error_count: { median: percentile(numeric("hook_error_count"), 0.5), mean: mean(numeric("hook_error_count")) },
    unclassified_action_count: { median: percentile(numeric("unclassified_action_count"), 0.5), mean: mean(numeric("unclassified_action_count")) },
    repository_read_calls: { median: percentile(numeric("repository_read_calls"), 0.5), mean: mean(numeric("repository_read_calls")) },
    repository_context_characters: { median: percentile(numeric("repository_context_characters"), 0.5), mean: mean(numeric("repository_context_characters")) },
    tool_output_characters: { median: percentile(numeric("tool_output_characters"), 0.5), mean: mean(numeric("tool_output_characters")) },
    hook_output_characters: { median: percentile(numeric("hook_output_characters"), 0.5), mean: mean(numeric("hook_output_characters")) },
    shell_output_characters: { median: percentile(numeric("shell_output_characters"), 0.5), mean: mean(numeric("shell_output_characters")) },
    tgrep_output_characters: { median: percentile(numeric("tgrep_output_characters"), 0.5), mean: mean(numeric("tgrep_output_characters")) },
    target_attributed_characters: { median: percentile(numeric("target_attributed_characters"), 0.5), mean: mean(numeric("target_attributed_characters")) },
    target_unattributed_characters: { median: percentile(numeric("target_unattributed_characters"), 0.5), mean: mean(numeric("target_unattributed_characters")) },
    context_component_characters: Object.fromEntries(["snippets", "hydration", "evidence", "registry"].map((component) => [component, { median: percentile(rows.map((row) => Number(row.metrics?.context_component_characters?.[component] ?? NaN)), 0.5), mean: mean(rows.map((row) => Number(row.metrics?.context_component_characters?.[component] ?? NaN))) }])),
    discovery_adoption: {
      zero_mcp_runs: rows.filter((row) => row.metrics?.discovery_adoption?.zero_mcp === true).length,
      zero_urdira_effective_use_runs: rows.filter((row) => row.metrics?.discovery_adoption?.zero_urdira_effective_use === true).length,
      mcp_before_shell_runs: rows.filter((row) => row.metrics?.discovery_adoption?.mcp_before_shell === true).length,
      shell_after_mcp_runs: rows.filter((row) => row.metrics?.discovery_adoption?.shell_after_mcp === true).length,
      mcp_led_runs: rows.filter((row) => row.metrics?.context_lead?.first_repository_discovery_transport === "mcp").length,
      hook_led_runs: rows.filter((row) => row.metrics?.context_lead?.first_repository_discovery_transport === "hook").length,
      configured_majority_before_edit_runs: rows.filter((row) => Number(row.metrics?.context_lead?.configured_character_share_before_first_edit) >= 0.5).length,
    },
    context_calls_unattributed_to_declared_targets: { median: percentile(numeric("context_calls_unattributed_to_declared_targets"), 0.5), mean: mean(numeric("context_calls_unattributed_to_declared_targets")) },
    test_attempts: { median: percentile(numeric("test_attempts"), 0.5), mean: mean(numeric("test_attempts")) },
    test_passes: { median: percentile(numeric("test_passes"), 0.5), mean: mean(numeric("test_passes")) },
    test_failures: { median: percentile(numeric("test_failures"), 0.5), mean: mean(numeric("test_failures")) },
    test_results_unknown: { median: percentile(numeric("test_results_unknown"), 0.5), mean: mean(numeric("test_results_unknown")) },
    core_ipc_timeouts: { median: percentile(numeric("core_ipc_timeouts"), 0.5), mean: mean(numeric("core_ipc_timeouts")) },
    core_coverage_incomplete: { median: percentile(numeric("core_coverage_incomplete"), 0.5), mean: mean(numeric("core_coverage_incomplete")) },
    request_validation_failures: { median: percentile(numeric("request_validation_failures"), 0.5), mean: mean(numeric("request_validation_failures")) },
    pipeline_calls: { median: percentile(rows.map((row) => Number(row.metrics?.composition_metrics?.pipeline_calls ?? NaN)), 0.5), mean: mean(rows.map((row) => Number(row.metrics?.composition_metrics?.pipeline_calls ?? NaN))) },
    recipe_calls: { median: percentile(rows.map((row) => Number(row.metrics?.composition_metrics?.recipe_calls ?? NaN)), 0.5), mean: mean(rows.map((row) => Number(row.metrics?.composition_metrics?.recipe_calls ?? NaN))) },
    direct_operation_calls: { median: percentile(rows.map((row) => Number(row.metrics?.composition_metrics?.direct_operation_calls ?? NaN)), 0.5), mean: mean(rows.map((row) => Number(row.metrics?.composition_metrics?.direct_operation_calls ?? NaN))) },
    valid_composition_calls: { median: percentile(rows.map((row) => Number(row.metrics?.composition_metrics?.valid_composition_calls ?? NaN)), 0.5), mean: mean(rows.map((row) => Number(row.metrics?.composition_metrics?.valid_composition_calls ?? NaN))) },
    valid_dependency_calls: { median: percentile(rows.map((row) => Number(row.metrics?.composition_metrics?.valid_dependency_calls ?? NaN)), 0.5), mean: mean(rows.map((row) => Number(row.metrics?.composition_metrics?.valid_dependency_calls ?? NaN))) },
    malformed_composition_calls: { median: percentile(rows.map((row) => Number(row.metrics?.composition_metrics?.malformed_composition_calls ?? NaN)), 0.5), mean: mean(rows.map((row) => Number(row.metrics?.composition_metrics?.malformed_composition_calls ?? NaN))) },
  }];
}));
const taskMetadata = new Map(runs.filter((run) => run.scenario || run.size_tier).map((run) => [run.task, { scenario: run.scenario ?? null, size_tier: run.size_tier ?? null }]));
const report = {
  report_version: 2,
  generated_at: new Date().toISOString(),
  benchmark: { ...benchmarkAudit, runs: undefined, output_dir: undefined, corpus: "release/benchmarks/expanded-typescript-agent-benchmark.json" },
  price_card_usd_per_million_tokens: rateCard,
  source_audit: { sha256: `sha256:${createHash("sha256").update(auditText).digest("hex")}`, raw_evidence: "Raw transcripts, host logs, manifests, and the environment record are retained outside the public repository under the campaign retention policy; this report retains derived metrics and grader evidence." },
  measurement_contract: {
    readiness: "Urdira setup ends at current complete structural readiness. Semantic indexing, semantic materialization, and semantic-sidecar creation are disabled and excluded.",
    correctness: "The repository grader checks declared changed paths, required implementation patterns, a focused test-file change, diff whitespace, and real integration failures. It does not require use of a configured tool or MCP. It is reported separately from executed test outcomes.",
    unsafe_omissions: "Declared omissions are corpus paths or required patterns missing from the final diff. This is a bounded corpus rubric, not proof that every possible semantic omission was detected.",
    evidence_grounded_plan: "An observational flag indicating whether configured discovery evidence appeared before the first edit and again after edit batches; it is not a correctness gate.",
    composition_metrics: "For Urdira, the report records pipeline, recipe, direct-operation, dependency, and malformed-composition usage observationally. Each is valid when appropriate, and no choice is required.",
    repository_context_characters: "Characters returned by observed repository-discovery calls. This is tool-response context, not source-only bytes.",
    action_telemetry: "Completed Codex action counts include MCP calls, shell commands, web searches, file changes, agent messages, and errors. Web searches and file changes are reported separately and never contribute to repository reads or repository context characters; unknown completed item types are counted as unclassified actions.",
    transcript_output_breakdown: "tool_output_characters, hook_output_characters, shell_output_characters, and tgrep_output_characters split observed discovery response characters by method. A hook-served search counts as effective Urdira use while remaining distinct from direct MCP and executed shell transport. Missing methods remain null. context_component_* counts only protocol-identifiable snippets, hydration, evidence, or registry payloads; unidentifiable components remain null.",
    completed_tool_output: "All completed MCP, Urdira hook-served, and shell text, including status, tests, builds and host instruction reads. Missing output makes totals unknown; tgrep is a shell subset. These UTF-16 character counts are not full model context or token usage.",
    mcp_component_bytes: "For real Urdira MCP text-content responses, tool_envelope is the UTF-8 JSON request/status envelope, model_visible_serialized is the UTF-8 response content visible to the model, source_text is identifiable indented source text, records is identifiable result/header metadata, and hydration/evidence/registry remain null unless the response carries an explicit typed byte field. These are lower-bound protocol classifications and never use structuredContent.bytes as a required shape.",
    target_attributed_characters: "Characters from observed discovery responses whose request or response contains a declared task path/file/required-pattern marker. This is a lexical attribution proxy, not a semantic relevance judgment; it is null when the task declares no patterns.",
    discovery_adoption: "mcp_before_shell records ordering only when both methods occur; shell_after_mcp records a shell discovery after an MCP discovery. zero_mcp describes direct MCP transport only; zero_urdira_effective_use is false when either direct Urdira MCP or an attested Urdira hook interception supplied repository context. Non-applicable ordering values are null.",
    context_lead: "Records the first repository-discovery transport and source, whether the configured tool preceded shell discovery, and configured-tool versus shell calls and characters before the first edit. Hook-served Urdira output is configured-tool context, with its calls and characters retained separately from direct MCP. configured_character_share_before_first_edit is a relative character-volume observation, not a semantic usefulness score or an absolute success threshold.",
    shell_source_reads: "Classifies source-reading shell calls before or after the first MCP result and, when MCP source is identifiable, by exact nonblank line overlap. Shell use is not a failure by itself; overlap and non-overlap require transcript evidence to interpret.",
    unattributed_context: "A proxy: observed discovery calls or returned characters containing none of the task's declared path/file/required-pattern markers. It is not a semantic irrelevance judgment.",
    tests: "Test attempts are parsed from command events. A pass or failure requires a numeric process exit code; missing exit codes remain unknown.",
    resources: "process_tree_peak_rss_kib covers the benchmark cell runner and all descendants, including the agent and any configured MCP. Urdira host-only RSS is retained separately for readiness diagnostics.",
    codex_timing: "The timing sidecar observes monotonic receipt times for complete Codex JSONL lines without modifying the original transcript. MCP and command item.started/item.completed events are paired by item id; unpaired items retain a null duration and an explicit pairing_status. Each Codex turn has its own clock origin.",
    missing_values: "Unavailable measurements are null and are never imputed as zero.",
  },
  ...(comparisonReport ? { reused_comparison: { report: `external-temporary:${basename(resolve(comparisonReportPath))}`, source_audit: comparisonReport.source_audit ?? null } } : {}),
  groups: summaries,
  runs,
  task_comparisons: runs.map((run) => ({
    repository: run.repository,
    size_tier: run.size_tier ?? taskMetadata.get(run.task)?.size_tier ?? null,
    scenario: run.scenario ?? taskMetadata.get(run.task)?.scenario ?? null,
    task: run.task,
    arm: run.arm,
    completed_successfully: run.completed_successfully,
    setup_elapsed_ms: run.setup_elapsed_ms ?? null,
    agent_elapsed_ms: run.elapsed_ms_from_first_instruction ?? null,
    total_elapsed_ms: Number.isFinite(run.setup_elapsed_ms) && Number.isFinite(run.elapsed_ms_from_first_instruction)
      ? run.setup_elapsed_ms + run.elapsed_ms_from_first_instruction
      : null,
    input_tokens: run.metrics?.input_tokens ?? null,
    output_tokens: run.metrics?.output_tokens ?? null,
    reasoning_tokens: run.metrics?.reasoning_tokens ?? null,
    total_tokens: run.metrics?.total_tokens ?? null,
    estimated_cost_usd: run.metrics?.estimated_cost_usd ?? null,
    outer_turns: run.metrics?.outer_turns ?? null,
    mcp_calls: run.metrics?.mcp_calls ?? null,
    action_counts: run.metrics?.action_counts ?? null,
    web_search_calls: run.metrics?.web_search_calls ?? null,
    file_change_actions: run.metrics?.file_change_actions ?? null,
    first_action_type: run.metrics?.first_action_type ?? null,
    integration_warning_count: run.metrics?.integration_warning_count ?? null,
    hook_error_count: run.metrics?.hook_error_count ?? null,
    unclassified_action_count: run.metrics?.unclassified_action_count ?? null,
    timing_metrics: run.timing_metrics ?? null,
    mcp_timing: run.timing_metrics?.aggregates?.mcp_by_tool ?? null,
    command_timing: run.timing_metrics?.aggregates?.commands_by_command ?? null,
    repository_read_calls: run.metrics?.repository_read_calls ?? null,
    repository_context_characters: run.metrics?.repository_context_characters ?? null,
    completed_tool_output: run.metrics?.completed_tool_output ?? null,
    tool_output_characters: run.metrics?.tool_output_characters ?? null,
    shell_output_characters: run.metrics?.shell_output_characters ?? null,
    tgrep_output_characters: run.metrics?.tgrep_output_characters ?? null,
    output_characters_by_method: run.metrics?.output_characters_by_method ?? null,
    mcp_component_bytes: run.metrics?.mcp_component_bytes ?? null,
    mcp_component_classification: run.metrics?.mcp_component_classification ?? null,
    target_attributed_characters: run.metrics?.target_attributed_characters ?? null,
    target_unattributed_characters: run.metrics?.target_unattributed_characters ?? null,
    context_component_characters: run.metrics?.context_component_characters ?? null,
    context_component_calls: run.metrics?.context_component_calls ?? null,
    discovery_adoption: run.metrics?.discovery_adoption ?? null,
    context_lead: run.metrics?.context_lead ?? null,
    context_efficiency: run.metrics?.context_efficiency ?? null,
    context_calls_unattributed_to_declared_targets: run.metrics?.context_calls_unattributed_to_declared_targets ?? null,
    context_characters_unattributed_to_declared_targets: run.metrics?.context_characters_unattributed_to_declared_targets ?? null,
    declared_unsafe_omissions: run.correctness?.declared_unsafe_omissions ?? null,
    evidence_grounded_plan: run.correctness?.evidence_grounded_plan ?? null,
    composition_shape_valid: run.metrics?.composition_metrics?.composition_shape_valid ?? null,
    pipeline_calls: run.metrics?.composition_metrics?.pipeline_calls ?? null,
    recipe_calls: run.metrics?.composition_metrics?.recipe_calls ?? null,
    direct_operation_calls: run.metrics?.composition_metrics?.direct_operation_calls ?? null,
    valid_composition_calls: run.metrics?.composition_metrics?.valid_composition_calls ?? null,
    malformed_composition_calls: run.metrics?.composition_metrics?.malformed_composition_calls ?? null,
    test_attempts: run.metrics?.test_attempts ?? null,
    test_passes: run.metrics?.test_passes ?? null,
    test_failures: run.metrics?.test_failures ?? null,
    test_results_unknown: run.metrics?.test_results_unknown ?? null,
    structural_readiness_ms: run.host_metrics?.structural_readiness_ms ?? run.host_metrics?.ready_elapsed_ms ?? null,
    semantic_index_enabled: run.host_metrics?.semantic_index ?? run.setup?.semantic_index ?? null,
    semantic_sidecar_created: run.host_metrics?.semantic_sidecar_created ?? null,
    process_tree_peak_rss_kib: run.process_metrics?.peak_rss_kib ?? null,
  })),
  campaign_gate: { expected_runs: expectedRuns, observed_runs: runs.length, successful_runs: successfulRuns, failed_or_blocked_runs: runs.length - successfulRuns, passed: runs.length === expectedRuns && runs.every((run) => run.completed_successfully), independent_campaigns: independentCampaigns, p95_eligible: p95Eligible },
};
const number = (value, digits = 0) => value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toLocaleString("en-US", digits ? { minimumFractionDigits: digits, maximumFractionDigits: digits } : undefined);
const taskComparisonRows = runs.map((run) => {
  const metadata = taskMetadata.get(run.task) ?? {};
  const totalElapsed = Number.isFinite(run.setup_elapsed_ms) && Number.isFinite(run.elapsed_ms_from_first_instruction)
    ? run.setup_elapsed_ms + run.elapsed_ms_from_first_instruction
    : null;
  return `| ${run.repository} | ${run.task} | ${run.scenario ?? metadata.scenario ?? "—"} | ${run.arm} | ${run.completed_successfully ? "yes" : "no"} | ${number(run.setup_elapsed_ms)} | ${number(run.elapsed_ms_from_first_instruction)} | ${number(totalElapsed)} | ${number(run.metrics?.total_tokens)} | ${number(run.metrics?.estimated_cost_usd, 4)} | ${number(run.metrics?.outer_turns)} | ${number(run.metrics?.repository_read_calls)} | ${number(run.metrics?.repository_context_characters)} | ${number(run.metrics?.context_calls_unattributed_to_declared_targets)} | ${number(run.metrics?.test_attempts)}/${number(run.metrics?.test_passes)}/${number(run.metrics?.test_failures)}/${number(run.metrics?.test_results_unknown)} | ${number(run.process_metrics?.peak_rss_kib)} |`;
});
const timingRows = runs.map((run) => {
  const timing = run.timing_metrics;
  const mcpCalls = timing?.mcp_calls ?? [];
  const commandCalls = timing?.command_calls ?? [];
  const durations = (calls) => calls.map((call) => Number(call.duration_ms)).filter(Number.isFinite);
  const mcpDurations = durations(mcpCalls);
  const commandDurations = durations(commandCalls);
  return `| ${run.repository} | ${run.task} | ${run.arm} | ${number(mcpCalls.length)} | ${number(mcpDurations.length)} | ${number(mcpDurations.reduce((sum, value) => sum + value, 0) || null, 1)} | ${number(percentile(mcpDurations, 0.95), 1)} | ${number(commandCalls.length)} | ${number(commandDurations.length)} | ${number(commandDurations.reduce((sum, value) => sum + value, 0) || null, 1)} |`;
});
const resourceRows = runs.map((run) => `| ${run.repository} | ${run.task} | ${run.arm} | ${number(run.process_metrics?.peak_rss_kib)} | ${number(run.process_metrics?.peak_process_count)} | ${number(run.process_metrics?.mean_cpu_percent, 1)} | ${number(run.host_metrics?.catalog_sqlite_bytes)} | ${number(run.host_metrics?.lexical_sqlite_bytes)} | ${number(run.host_metrics?.structural_store_bytes)} | ${number(run.host_metrics?.rust_sidecar_bytes)} | ${number(run.host_metrics?.cas_bytes)} | ${number(run.host_metrics?.semantic_sqlite_bytes)} | ${run.cleanup?.errors?.length === 0 ? "yes" : run.cleanup ? "no" : "—"} |`);
const evidenceRows = runs.map((run) => {
  const omissions = run.correctness?.declared_unsafe_omissions;
  const omissionText = Array.isArray(omissions) ? (omissions.length === 0 ? "none" : omissions.join(", ")) : "—";
  const adoption = run.metrics?.discovery_adoption;
  const lead = run.metrics?.context_lead;
  const adoptionText = adoption ? (adoption.zero_urdira_effective_use ? "zero-urdira" : lead?.configured_before_shell === true ? "configured-led" : lead?.first_repository_discovery_transport === "hook" ? "urdira-hook-led" : lead?.first_repository_discovery_transport === "mcp" ? "other-mcp-led" : "shell-led") : "—";
  const shellReads = run.metrics?.context_efficiency?.shell_source_reads;
  return `| ${run.repository} | ${run.task} | ${run.arm} | ${run.correctness?.evidence_grounded_plan === true ? "yes" : run.correctness?.evidence_grounded_plan === false ? "no" : "—"} | ${omissionText.replaceAll("|", "/")} | ${number(run.metrics?.repository_read_calls)} | ${number(run.metrics?.repository_context_characters)} | ${number(run.metrics?.tool_output_characters)} | ${number(run.metrics?.hook_output_characters)} | ${number(run.metrics?.shell_output_characters)} | ${number(run.metrics?.tgrep_output_characters)} | ${number(run.metrics?.target_attributed_characters)} | ${number(run.metrics?.target_unattributed_characters)} | ${adoptionText} | ${number(lead?.configured_character_share_before_first_edit, 3)} | ${number(shellReads?.overlapping_calls)}/${number(shellReads?.nonoverlapping_calls)} | ${number(run.metrics?.observed_tool_usage?.urdira_effective_calls)} | ${number(run.metrics?.mcp_calls)} | ${number(run.metrics?.mcp_failed_calls)} | ${number(run.metrics?.test_attempts)}/${number(run.metrics?.test_passes)}/${number(run.metrics?.test_failures)}/${number(run.metrics?.test_results_unknown)} |`;
});
const actionRows = runs.map((run) => `| ${run.repository} | ${run.task} | ${run.arm} | ${number(run.metrics?.web_search_calls)} | ${number(run.metrics?.file_change_actions)} | ${run.metrics?.first_action_type ?? "—"} | ${number(run.metrics?.integration_warning_count)} | ${number(run.metrics?.hook_error_count)} | ${number(run.metrics?.unclassified_action_count)} |`);
const transportTextRows = runs.map((run) => {
  const text = run.metrics?.completed_tool_output;
  return `| ${run.repository} | ${run.task} | ${run.arm} | ${number(text?.mcp?.characters)} | ${number(text?.hook?.characters)} | ${number(text?.shell?.characters)} | ${number(text?.total_characters)} |`;
});
const urdiraRuns = runs.filter((run) => run.arm === "urdira-typescript");
const urdiraDiscoveryCalls = urdiraRuns.reduce((sum, run) => sum + Number(run.metrics?.mcp_discovery_calls ?? 0), 0);
const urdiraDiscoverySuccesses = urdiraRuns.reduce((sum, run) => sum + Number(run.metrics?.mcp_discovery_successful_calls ?? 0), 0);
const urdiraSelectorAmbiguities = urdiraRuns.reduce((sum, run) => sum + Number(run.metrics?.mcp_selector_ambiguous_calls ?? 0), 0);
const urdiraUnexpectedFailures = urdiraRuns.reduce((sum, run) => sum + Number(run.metrics?.mcp_unexpected_failed_calls ?? 0), 0);
const urdiraEmptyDiscoveries = urdiraRuns.reduce((sum, run) => sum + Number(run.metrics?.mcp_empty_discovery_calls ?? 0), 0);
const urdiraUsefulDiscoveries = urdiraRuns.reduce((sum, run) => sum + Number(run.metrics?.mcp_useful_discovery_calls ?? 0), 0);
const urdiraApiV3Calls = urdiraRuns.reduce((sum, run) => sum + Number(run.metrics?.api_v3_discovery_calls ?? 0), 0);
const urdiraExplicitWorkspaceCalls = urdiraRuns.reduce((sum, run) => sum + Number(run.metrics?.explicit_workspace_discovery_calls ?? 0), 0);
const urdiraTimeouts = urdiraRuns.reduce((sum, run) => sum + Number(run.metrics?.core_ipc_timeouts ?? 0), 0);
const urdiraCoverageFailures = urdiraRuns.reduce((sum, run) => sum + Number(run.metrics?.core_coverage_incomplete ?? 0), 0);
const urdiraValidationFailures = urdiraRuns.reduce((sum, run) => sum + Number(run.metrics?.request_validation_failures ?? 0), 0);
const urdiraUsedCorrectly = urdiraDiscoveryCalls === 0
  || (urdiraUnexpectedFailures === 0
    && urdiraApiV3Calls === urdiraDiscoveryCalls
    && urdiraExplicitWorkspaceCalls === urdiraDiscoveryCalls);
const urdiraPrimaryContextRuns = urdiraRuns.filter((run) =>
  run.metrics?.context_lead?.configured_before_shell === true
  && run.metrics?.context_lead?.first_repository_discovery_source === "urdira"
  && Number(run.metrics?.context_lead?.configured_character_share_before_first_edit) >= 0.5).length;
const viabilityAssessment = comparisonReport
  ? urdiraDiscoveryCalls === 0
    ? `Urdira was not selected by the agent in these cells. That natural tool choice is recorded as an observation and does not fail the task grader; timing, token, and cost fields therefore describe the configured arm without claiming successful Urdira retrieval.`
    : urdiraUsedCorrectly
    ? `Urdira passed ${urdiraRuns.filter((run) => run.completed_successfully).length}/${urdiraRuns.length} graders. Of ${urdiraDiscoveryCalls} discovery operations, ${urdiraDiscoverySuccesses} completed directly and ${urdiraSelectorAmbiguities} returned the typed core:selector_ambiguous recovery signal; there were ${urdiraUnexpectedFailures} unexpected MCP failures. The completed calls included ${urdiraUsefulDiscoveries} useful results and ${urdiraEmptyDiscoveries} legitimate empty searches. Every discovery used API v3 and an explicit single-workspace scope. In ${urdiraPrimaryContextRuns}/${urdiraRuns.length} runs, Urdira was the first repository discovery transport and supplied at least half of observed pre-edit repository-context characters. Shell reads remain classified by timing and source overlap rather than treated as failures. This campaign supports evaluating Urdira as the primary repository-context source together with its timing, token, cost, density and fallback trade-offs.`
    : `Urdira passed ${urdiraRuns.filter((run) => run.completed_successfully).length}/${urdiraRuns.length} graders, but only ${urdiraDiscoverySuccesses}/${urdiraDiscoveryCalls} discovery calls succeeded (${urdiraTimeouts} IPC timeouts, ${urdiraCoverageFailures} incomplete-coverage responses, and ${urdiraValidationFailures} request-validation failures). Agents completed the graded diffs through narrow source inspection after MCP failures. Under this protocol the result does not yet support claiming Urdira as a viable code-intelligence replacement, and its token/cost measurements cannot be attributed to successful Urdira retrieval.`
  : null;
const firstFrontierMs = (metrics, predicate) => metrics?.readiness_events?.find(predicate)?.elapsed_ms ?? null;
const readinessRuns = runs.filter((run) => run.host_metrics).map((run) => {
  const metrics = run.host_metrics;
  const timings = metrics.stage_timings ?? {};
  return `| ${run.repository} | ${run.task} | ${number(metrics.structural_readiness_ms)} | ${number(firstFrontierMs(metrics, (event) => event.source_ready === true))} | ${number(firstFrontierMs(metrics, (event) => event.structural_ready === true))} | ${number(timings.source_catalog_ms ?? timings.source_catalogue_ms ?? timings.source_catalog)} | ${number(timings.plugin_analysis_ms ?? timings.plugin_analyze)} | ${number(timings.publish_ms ?? timings.publish)} | ${number(metrics.structural_readiness_peak_rss_kib)} | ${metrics.semantic_index === false ? "disabled" : "—"} | ${metrics.semantic_sidecar_created === false ? "no" : metrics.semantic_sidecar_created === true ? "yes (invalid)" : "—"} |`;
});
const failureRuns = runs.filter((run) => run.failure).map((run) =>
  `| ${run.repository} | ${run.task} | ${run.arm} | ${String(run.failure).replaceAll("|", "/")} |`);
const executedArms = audit.arms ?? [...new Set(runs.map((run) => run.arm))];
const campaignProvenance = benchmarkAudit.rerun_status !== undefined || benchmarkAudit.rerun_observed_runs !== undefined || reusedArms.length > 0
  ? `The Urdira arm was rerun in this campaign (${benchmarkAudit.rerun_status ?? "status unavailable"}: ${benchmarkAudit.rerun_observed_runs ?? "?"}/${benchmarkAudit.rerun_expected_runs ?? "?"} cells). Existing comparison-arm rows were reused from the prior audited campaign: ${reusedArms.length ? reusedArms.join(", ") : "none"}. They were not re-executed in this run.${benchmarkAudit.rerun_stop_reason ? ` The rerun stopped after a controlled resource guard: ${benchmarkAudit.rerun_stop_reason}` : ""}`
  : `This campaign executed only the following arm${executedArms.length === 1 ? "" : "s"}: ${executedArms.join(", ")}. No comparison-arm result was reused or implied.`;
const markdown = `# Expanded TypeScript agent benchmark results

Generated from the sequential audit for four frozen TypeScript repositories. A cell is successful only when the repository grader passes; index/setup failures remain visible as failed or blocked runs.

${campaignProvenance}

The estimated cost uses the explicit planning card in the JSON report and is not a provider invoice. Raw evidence is retained outside the public repository under the campaign retention policy; the derived evidence is bound by the audit SHA-256.

## Comparison by task and option

Each row is one benchmark task under one tool option. No values in this table
are averaged across different tasks. \`Total elapsed ms\` is setup plus measured
agent elapsed; \`Agent elapsed ms\` starts at the first instruction.

The test column is attempts/passes/failures/unknown. Repository reads and
context characters cover observed discovery calls and the tools selected by
the agent. Tool, shell, and tgrep output columns split those response
characters by method. Target-attributed characters are a lexical declared-
target proxy; component fields remain null when the protocol does not identify
snippets, hydration, evidence, or registry payloads.

| Repository | Task | Scenario | Option | Grader | Setup ms | Agent ms | Total ms | Total tokens | Cost USD | Turns | Repository reads | Context chars | Unattributed calls | Tests A/P/F/? | Process-tree peak RSS KiB |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${taskComparisonRows.join("\n")}

## External Codex call timing

Timing is captured by the cell runner when JSONL output arrives. It is kept in
a separate sidecar so the grader's transcript remains byte compatible. Durations
are end-to-end from \`item.started\` to \`item.completed\`; incomplete pairs are
reported with a null duration. MCP aggregates by tool and command timings are
also available in the JSON report.

| Repository | Task | Arm | MCP calls | Paired MCP | MCP total ms | MCP p95 ms | Commands | Paired commands | Command total ms |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
${timingRows.join("\n")}

${viabilityAssessment ? `## Viability assessment\n\n${viabilityAssessment}\n` : ""}

## Discovery, omissions, and verification

| Repository | Task | Arm | Evidence grounded | Declared omissions | Repository reads | Context chars | Direct MCP chars | Hook chars | Shell chars | tgrep chars | Target chars | Unattributed chars | Adoption | Configured share before edit | Shell overlap/non-overlap calls | Effective Urdira calls | MCP calls | Failed MCP | Tests A/P/F/? |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|
${evidenceRows.join("\n")}

## Completed transport text

All completed MCP, attested Urdira hook-served, and shell text is included here,
including tests, builds, status and host instruction reads. Tgrep stays within shell. Missing output
remains unknown. These character counts are not the model's full context.

| Repository | Task | Arm | MCP text chars | Hook text chars | Shell text chars | Combined tool text chars |
|---|---|---|---:|---:|---:|---:|
${transportTextRows.join("\n")}

## Codex action telemetry

These completed-action counters are separate from repository-read metrics. Web
searches and file changes are actions, but their counts do not become MCP,
shell, repository-read, or context-character measurements.

| Repository | Task | Arm | Web searches | File changes | First action | Integration warnings | Hook errors | Unclassified actions |
|---|---|---|---:|---:|---|---:|---:|---:|
${actionRows.join("\n")}

## Resource and storage measurements

Process-tree values use the same cell-runner-and-descendants scope for every
arm. Urdira storage separates the catalog, lexical sidecar, native structural
store, Rust staging sidecar, CAS, and semantic sidecar. A semantic value above
zero invalidates the Urdira cell.

| Repository | Task | Arm | Process-tree peak RSS KiB | Peak processes | Mean CPU % | Catalog bytes | Lexical bytes | Structural bytes | Rust sidecar bytes | CAS bytes | Semantic bytes | Cleanup |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${resourceRows.join("\n")}

## Gate

- Expected runs: ${report.campaign_gate.expected_runs}
- Observed runs: ${report.campaign_gate.observed_runs}
- Correct runs: ${report.campaign_gate.successful_runs}
- Failed or blocked runs: ${report.campaign_gate.failed_or_blocked_runs}
- Campaign gate passed: ${report.campaign_gate.passed}

See the JSON file for the same per-task/per-option records, grouped task-level
statistics, setup evidence, correctness evidence, and failure messages.

## Failures and recovery details

${failureRuns.length ? "| Repository | Task | Arm | Recorded failure |\n|---|---|---|---|\n" + failureRuns.join("\n") : "No failure details were recorded."}

## Indexing and readiness evidence

The Urdira host records every published frontier transition. \`structural readiness ms\` is the time from host start until the full current structural snapshot is queryable. Semantic indexing and materialization are disabled, the semantic sidecar is not created, and none of that work is part of readiness. Stage timings are emitted by the indexer and are not inferred from agent elapsed time.

| Repository | Task | Structural readiness ms | Source ready ms | Structural frontier ms | Source catalog ms | Plugin analysis ms | Publish ms | Readiness peak RSS KiB | Semantic | Semantic sidecar created |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
${readinessRuns.length ? readinessRuns.join("\n") : "| — | — | — | — | — | — | — | — | — | — | — |"}
`;
writeFileSync(`${outputBase}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(`${outputBase}.md`, markdown, "utf8");
console.log(JSON.stringify({ json: `${outputBase}.json`, markdown: `${outputBase}.md`, observed_runs: runs.length, successful_runs: report.campaign_gate.successful_runs, failed_or_blocked_runs: report.campaign_gate.failed_or_blocked_runs }));
