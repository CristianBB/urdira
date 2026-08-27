#!/usr/bin/env node
/* global URL */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const argv = process.argv.slice(2);
const value = (name, fallback) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };
const auditPath = value("--audit");
const comparisonReportPath = value("--comparison-report");
if (!auditPath) throw new Error("Usage: render-expanded-agent-report.mjs --audit <audit.json> [--comparison-report <report.json>] [--output <path without extension>]");
const auditText = readFileSync(auditPath, "utf8");
const audit = JSON.parse(auditText);
const generatedDate = String(audit.generated_at ?? "").slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/u.test(generatedDate) && !value("--output")) throw new Error("The audit requires a YYYY-MM-DD generated_at when --output is omitted.");
const outputBase = value("--output", join(root, `release/benchmarks/expanded-typescript-agent-benchmark-results-${generatedDate}`));
const comparisonReport = comparisonReportPath ? JSON.parse(readFileSync(comparisonReportPath, "utf8")) : null;
const rateCard = { input: Number(process.env.BENCH_INPUT_USD_PER_MILLION ?? 2), output: Number(process.env.BENCH_OUTPUT_USD_PER_MILLION ?? 8), reasoning: Number(process.env.BENCH_REASONING_USD_PER_MILLION ?? 8) };
const percentile = (values, p) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null; };
const independentCampaigns = Number(audit.independent_campaigns ?? 1);
const p95Eligible = independentCampaigns >= 3;
const mean = (values) => { const usable = values.filter(Number.isFinite); return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null; };
const sanitizeText = (value) => String(value).replaceAll(/\/private\/tmp\/[^\s"']+/g, "<temp>").replaceAll(/\/tmp\/[^\s"']+/g, "<temp>");
const normalizedDiffClean = (worktree) => {
  if (!worktree) return false;
  const diff = spawnSync("git", ["diff", "--unified=0"], { cwd: worktree, encoding: "utf8" });
  if (diff.status !== 0) return false;
  return (diff.stdout ?? "").split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .every((line) => !/[ \t]+$/.test(line.replace(/\r$/, "")));
};
const metricsFor = (manifest) => {
  if (!manifest?.transcript) return undefined;
  let events;
  try { events = readFileSync(manifest.transcript, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return undefined; }
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
  const unexpectedFailedDiscoveryCalls = discoveryMcpCalls.filter((event) =>
    event.item?.status === "failed" && !JSON.stringify(event).includes("core:selector_ambiguous"));
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
  const input = usage.reduce((sum, item) => sum + Number(item.input_tokens ?? 0), 0);
  const cached = usage.reduce((sum, item) => sum + Number(item.cached_input_tokens ?? 0), 0);
  const output = usage.reduce((sum, item) => sum + Number(item.output_tokens ?? 0), 0);
  const reasoning = usage.reduce((sum, item) => sum + Number(item.reasoning_output_tokens ?? 0), 0);
  return {
    outer_turns: usage.length,
    observable_agent_iterations: completed.filter((event) => event.item?.type === "agent_message").length,
    command_actions: completed.filter((event) => event.item?.type === "command_execution").length,
    mcp_calls: mcpCalls.length,
    mcp_failed_calls: mcpCalls.filter((event) => event.item?.status === "failed").length,
    mcp_discovery_calls: discoveryMcpCalls.length,
    mcp_discovery_successful_calls: completedDiscoveryCalls.length,
    mcp_selector_ambiguous_calls: selectorAmbiguities.length,
    mcp_unexpected_failed_calls: unexpectedFailedDiscoveryCalls.length,
    mcp_empty_discovery_calls: emptyDiscoveryCalls.length,
    mcp_useful_discovery_calls: completedDiscoveryCalls.length - emptyDiscoveryCalls.length,
    api_v3_discovery_calls: discoveryMcpCalls.filter((event) => discoveryRequest(event)?.api_version === 3).length,
    explicit_workspace_discovery_calls: discoveryMcpCalls.filter((event) => {
      const scope = discoveryRequest(event)?.scope;
      return scope?.scope_type === "single_workspace" && typeof scope.workspace_id === "string" && scope.workspace_id.length > 0;
    }).length,
    first_discovery_before_edit: firstDiscoveryIndex !== undefined && (firstEditIndex === undefined || firstDiscoveryIndex < firstEditIndex),
    first_discovery_elapsed_ms: timestampDelta,
    post_edit_discovery_calls: firstEditIndex === undefined ? 0 : discoveryIndices.filter((index) => index > firstEditIndex).length,
    rediscovery_after_each_edit: editIndices.every((edit) => discoveryIndices.some((discovery) => discovery > edit)),
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
    uncached_input_tokens: Math.max(0, input - cached),
    output_tokens: output,
    reasoning_tokens: reasoning,
    total_tokens: input + output + reasoning,
    estimated_cost_usd: (input * rateCard.input + output * rateCard.output + reasoning * rateCard.reasoning) / 1_000_000,
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
    ? readFileSync(manifest.host_log, "utf8").split("\\n").flatMap((line) => {
      const match = line.match(/BENCH_FRONTIER (\{.*\})\s*$/u);
      if (!match) return [];
      try { return [JSON.parse(match[1])]; } catch { return []; }
    }) : []);
  const readyLine = manifest.host_log && existsSync(manifest.host_log)
    ? readFileSync(manifest.host_log, "utf8").split("\\n").find((line) => line.includes("BENCH_HOST_READY"))
    : undefined;
  let ready_elapsed_ms = manifest.host_metrics?.ready_elapsed_ms ?? null;
  if (ready_elapsed_ms === null && readyLine) {
    const match = readyLine.match(/BENCH_HOST_READY (\{.*\})\s*$/u);
    try { ready_elapsed_ms = match ? Number(JSON.parse(match[1]).elapsed_ms ?? NaN) : null; } catch { ready_elapsed_ms = null; }
  }
  return { ...(manifest.host_metrics ?? {}), stage_timings, analysis_timings, byte_telemetry, readiness_events, ready_elapsed_ms, bytes_read: totals.read || null, bytes_transferred: totals.transferred || null, bytes_copied: totals.copied || null, bytes_decoded: totals.decoded || null, bytes_retained: totals.retained || null };
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
  if (evidence.fallback_shell === true) details.push("native source fallback was used (fallback_shell=true)");
  if (evidence.discovery_status && evidence.discovery_status !== "urdira-completed") {
    details.push(`discovery_status=${evidence.discovery_status}`);
  }
  return details.length > 0 ? details.join("; ") : "grader rejected the correctness evidence";
};
const freshRuns = audit.runs.map((entry) => {
  const manifest = entry.manifest;
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
    metrics: metricsFor(manifest),
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
      : (metricsFor(manifest)?.mcp_failure_details?.join("; ") ?? graderFailureDetails(manifest)),
  };
});
const reusedRuns = comparisonReport?.runs?.filter((run) => run.arm !== "urdira-typescript") ?? [];
const reusedArms = [...new Set(reusedRuns.map((run) => run.arm))];
const armOrder = ["baseline", "urdira-typescript", "codebase-memory", "codegraph"];
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
    core_ipc_timeouts: { median: percentile(numeric("core_ipc_timeouts"), 0.5), mean: mean(numeric("core_ipc_timeouts")) },
    core_coverage_incomplete: { median: percentile(numeric("core_coverage_incomplete"), 0.5), mean: mean(numeric("core_coverage_incomplete")) },
    request_validation_failures: { median: percentile(numeric("request_validation_failures"), 0.5), mean: mean(numeric("request_validation_failures")) },
  }];
}));
const taskMetadata = new Map(runs.filter((run) => run.scenario || run.size_tier).map((run) => [run.task, { scenario: run.scenario ?? null, size_tier: run.size_tier ?? null }]));
const report = {
  report_version: 1,
  generated_at: new Date().toISOString(),
  benchmark: { ...benchmarkAudit, runs: undefined, output_dir: undefined, corpus: "release/benchmarks/expanded-typescript-agent-benchmark.json" },
  price_card_usd_per_million_tokens: rateCard,
  source_audit: { sha256: `sha256:${createHash("sha256").update(auditText).digest("hex")}`, raw_evidence: "Raw transcripts and host logs were generated outside the repository, used to derive this report, and removed after extraction; the report retains derived metrics and grader evidence." },
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
    readiness_ms: run.host_metrics?.ready_elapsed_ms ?? null,
    peak_rss_kib: run.host_metrics?.peak_rss_kib ?? null,
  })),
  campaign_gate: { expected_runs: expectedRuns, observed_runs: runs.length, successful_runs: successfulRuns, failed_or_blocked_runs: runs.length - successfulRuns, passed: runs.length === expectedRuns && runs.every((run) => run.completed_successfully), independent_campaigns: independentCampaigns, p95_eligible: p95Eligible },
};
const compactRuns = runs.map((run) => `| ${run.repository} | ${run.size_tier ?? "—"} | ${run.scenario ?? "—"} | ${run.task} | ${run.arm} | ${run.completed_successfully ? "yes" : "no"} | ${run.metrics?.input_tokens?.toLocaleString("en-US") ?? "—"} | ${run.metrics?.output_tokens?.toLocaleString("en-US") ?? "—"} | ${run.metrics?.reasoning_tokens?.toLocaleString("en-US") ?? "—"} | ${run.metrics?.total_tokens?.toLocaleString("en-US") ?? "—"} | ${run.metrics?.estimated_cost_usd?.toFixed(4) ?? "—"} | ${run.metrics?.outer_turns ?? "—"} | ${run.metrics?.mcp_calls ?? "—"} | ${run.metrics?.mcp_failed_calls ?? "—"} | ${run.metrics?.mcp_discovery_calls === undefined ? "—" : `${run.metrics.mcp_discovery_successful_calls}/${run.metrics.mcp_discovery_calls}`} | ${run.metrics?.mcp_selector_ambiguous_calls ?? "—"} | ${run.metrics?.mcp_unexpected_failed_calls ?? "—"} | ${run.metrics?.mcp_useful_discovery_calls ?? "—"} | ${run.correctness?.fallback_shell === false ? "no" : run.correctness?.fallback_shell === true ? "yes" : "—"} | ${run.metrics?.core_ipc_timeouts ?? "—"} | ${run.setup_elapsed_ms ?? "—"} | ${run.elapsed_ms_from_first_instruction ?? "—"} | ${run.host_metrics?.peak_rss_kib ?? "—"} | ${run.host_metrics?.mean_cpu_percent?.toFixed?.(1) ?? "—"} | ${run.host_metrics?.sqlite_bytes ?? "—"} | ${run.host_metrics?.cas_bytes ?? "—"} | ${run.host_metrics?.bytes_copied ?? "—"} | ${run.host_metrics?.bytes_transferred ?? "—"} | ${run.host_metrics?.bytes_decoded ?? "—"} | ${run.cleanup?.errors?.length === 0 ? "yes" : run.cleanup ? "no" : "—"} |`);
const taskComparisonRows = runs.map((run) => {
  const number = (value, digits = 0) => value == null ? "—" : Number(value).toLocaleString("en-US", digits ? { minimumFractionDigits: digits, maximumFractionDigits: digits } : undefined);
  const metadata = taskMetadata.get(run.task) ?? {};
  const totalElapsed = Number.isFinite(run.setup_elapsed_ms) && Number.isFinite(run.elapsed_ms_from_first_instruction)
    ? run.setup_elapsed_ms + run.elapsed_ms_from_first_instruction
    : null;
  return `| ${run.repository} | ${run.task} | ${run.scenario ?? metadata.scenario ?? "—"} | ${run.arm} | ${run.completed_successfully ? "yes" : "no"} | ${number(run.setup_elapsed_ms)} | ${number(run.elapsed_ms_from_first_instruction)} | ${number(totalElapsed)} | ${number(run.metrics?.input_tokens)} | ${number(run.metrics?.output_tokens)} | ${number(run.metrics?.reasoning_tokens)} | ${number(run.metrics?.estimated_cost_usd, 4)} | ${number(run.metrics?.outer_turns)} | ${number(run.metrics?.mcp_calls)} | ${number(run.host_metrics?.ready_elapsed_ms)} | ${number(run.host_metrics?.peak_rss_kib)} |`;
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
const urdiraUsedCorrectly = urdiraDiscoveryCalls > 0
  && urdiraUnexpectedFailures === 0
  && urdiraApiV3Calls === urdiraDiscoveryCalls
  && urdiraExplicitWorkspaceCalls === urdiraDiscoveryCalls
  && urdiraRuns.every((run) => run.correctness?.fallback_shell === false
    && run.correctness?.first_discovery_before_edit === true
    && run.correctness?.rediscovery_after_edit === true);
const viabilityAssessment = comparisonReport
  ? urdiraUsedCorrectly
    ? `Urdira passed ${urdiraRuns.filter((run) => run.completed_successfully).length}/${urdiraRuns.length} graders. Of ${urdiraDiscoveryCalls} discovery operations, ${urdiraDiscoverySuccesses} completed directly and ${urdiraSelectorAmbiguities} returned the typed core:selector_ambiguous recovery signal; there were ${urdiraUnexpectedFailures} unexpected MCP failures. The completed calls included ${urdiraUsefulDiscoveries} useful results and ${urdiraEmptyDiscoveries} legitimate empty searches. Every discovery used API v3, an explicit single-workspace scope, Urdira before editing, and Urdira rediscovery after editing, with no native source-reading fallback. This campaign supports evaluating its timing, token, and cost trade-offs as a working code-intelligence alternative.`
    : `Urdira passed ${urdiraRuns.filter((run) => run.completed_successfully).length}/${urdiraRuns.length} graders, but only ${urdiraDiscoverySuccesses}/${urdiraDiscoveryCalls} discovery calls succeeded (${urdiraTimeouts} IPC timeouts, ${urdiraCoverageFailures} incomplete-coverage responses, and ${urdiraValidationFailures} request-validation failures). Agents completed the graded diffs through narrow source inspection after MCP failures. Under this protocol the result does not yet support claiming Urdira as a viable code-intelligence replacement, and its token/cost measurements cannot be attributed to successful Urdira retrieval.`
  : null;
const firstFrontierMs = (metrics, predicate) => metrics?.readiness_events?.find(predicate)?.elapsed_ms ?? null;
const readinessRuns = runs.filter((run) => run.host_metrics).map((run) => {
  const metrics = run.host_metrics;
  const timings = metrics.stage_timings ?? {};
  return `| ${run.repository} | ${run.task} | ${metrics.ready_elapsed_ms ?? "—"} | ${firstFrontierMs(metrics, (event) => event.source_ready === true) ?? "—"} | ${firstFrontierMs(metrics, (event) => event.structural_stage_ordinal >= 1 && event.structural_availability === "available") ?? "—"} | ${timings.source_catalog_ms ?? timings.source_catalogue_ms ?? timings.source_catalog ?? "—"} | ${timings.plugin_analysis_ms ?? timings.plugin_analyze ?? "—"} | ${timings.publish_ms ?? timings.publish ?? "—"} | ${metrics.analysis_timings?.acceptance ?? "—"} | ${metrics.peak_rss_kib ?? "—"} |`;
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

The estimated cost uses the explicit planning card in the JSON report and is not a provider invoice. Raw transcripts and host logs were generated outside the repository, used for extraction, and removed after cleanup; the derived evidence is bound by the audit SHA-256.

## Comparison by task and option

Each row is one benchmark task under one tool option. No values in this table
are averaged across different tasks. \`Total elapsed ms\` is setup plus measured
agent elapsed; \`Agent elapsed ms\` starts at the first instruction.

| Repository | Task | Scenario | Option | Correct | Setup ms | Agent elapsed ms | Total elapsed ms | Input tokens | Output tokens | Reasoning tokens | Cost USD | Turns | MCP calls | Readiness ms | Peak RSS KiB |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${taskComparisonRows.join("\n")}

${viabilityAssessment ? `## Viability assessment\n\n${viabilityAssessment}\n` : ""}

## Per-run measurements

| Repository | Tier | Scenario | Task | Arm | Correct | Input tokens | Output tokens | Reasoning tokens | Total tokens | Cost USD | Turns | MCP calls | Failed MCP | Discovery completed | Selector narrowing | Unexpected MCP failures | Useful discovery | Native source fallback | IPC timeouts | Setup ms | Agent elapsed ms | Peak RSS KiB | CPU % | SQLite bytes | CAS bytes | Bytes copied | Bytes transferred | Bytes decoded | Cleanup |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${compactRuns.join("\n")}

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

The Urdira host records every published frontier transition. \`readiness_ms\` is the time from host start to the benchmark readiness boundary (source-first structural stage); \`source_ready_ms\` and \`structural_ready_ms\` are the first observed corresponding frontier timestamps. Stage timings are emitted by the indexer and are not inferred from agent elapsed time.

| Repository | Task | Readiness ms | Source ready ms | Structural ready ms | Source catalog ms | Plugin analysis ms | Publish ms | Analysis acceptance ms | Peak RSS KiB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
${readinessRuns.length ? readinessRuns.join("\n") : "| — | — | — | — | — | — | — | — | — | — |"}
`;
writeFileSync(`${outputBase}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(`${outputBase}.md`, markdown, "utf8");
console.log(JSON.stringify({ json: `${outputBase}.json`, markdown: `${outputBase}.md`, observed_runs: runs.length, successful_runs: report.campaign_gate.successful_runs, failed_or_blocked_runs: report.campaign_gate.failed_or_blocked_runs }));
