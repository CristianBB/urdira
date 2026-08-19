#!/usr/bin/env node
/* Render a durable, machine-readable report from a completed Vite campaign. */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const value = (name, fallback) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; };
const auditValue = value("--audit", undefined);
if (auditValue === undefined) throw new Error("--audit is required; raw campaign evidence remains outside the repository.");
const auditPath = resolve(auditValue);
const smokeAuditPathValue = value("--smoke-audit", undefined);
const smokeAuditPath = smokeAuditPathValue === undefined ? undefined : resolve(smokeAuditPathValue);
const outputJson = resolve(value("--output-json", "release/benchmarks/vite-agent-benchmark-results.json"));
const outputMarkdown = resolve(value("--output-md", "release/benchmarks/vite-agent-benchmark-results.md"));
const auditBytes = readFileSync(auditPath);
const audit = JSON.parse(auditBytes.toString("utf8"));
const smokeAuditBytes = smokeAuditPath === undefined ? undefined : readFileSync(smokeAuditPath);
const smokeAudit = smokeAuditBytes === undefined ? undefined : JSON.parse(smokeAuditBytes.toString("utf8"));
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const task = value("--task", audit.task ?? "server-request");
const arms = audit.arms ?? ["baseline", "codebase-memory", "urdira"];
const phases = audit.phases ?? ["cold", "warm"];
const successful = (row) => row.exit_code === 0 && row.metrics?.completed_successfully === true;
const rowsFor = (arm, phase) => audit.runs.filter((row) => row.arm === arm && row.phase === phase && successful(row));
const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null;
};
const stats = (rows, field) => {
  const values = rows.map((row) => Number(row.metrics?.[field])).filter(Number.isFinite);
  return { median: percentile(values, 0.5), p95: percentile(values, 0.95), mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null };
};
const metricNames = [
  ["elapsed_ms_from_first_instruction", "elapsed_ms"], ["total_tokens", "total_tokens"],
  ["estimated_cost_usd", "estimated_cost_usd"], ["outer_turns", "outer_turns"],
  ["observable_agent_iterations", "observable_agent_iterations"], ["mcp_calls", "mcp_calls"],
  ["command_actions", "command_actions"], ["file_change_batches", "file_change_batches"],
  ["cached_input_tokens", "cached_input_tokens"], ["uncached_input_tokens", "uncached_input_tokens"],
];
const groups = {};
for (const arm of arms) for (const phase of phases) {
  const rows = rowsFor(arm, phase);
  groups[`${arm}:${phase}`] = { count: rows.length, expected: audit.samples_per_arm_phase, metrics: Object.fromEntries(metricNames.map(([field, key]) => [key, stats(rows, field)])) };
}
const overall = {};
for (const arm of arms) {
  const rows = audit.runs.filter((row) => row.arm === arm && successful(row));
  overall[arm] = { count: rows.length, expected: Number(audit.samples_per_arm_phase ?? 0) * phases.length, success_rate: rows.length / (Number(audit.samples_per_arm_phase ?? 0) * phases.length), metrics: Object.fromEntries(metricNames.map(([field, key]) => [key, stats(rows, field)])) };
}
const failedRuns = audit.runs.filter((row) => !successful(row)).map((row) => ({ run_id: row.run_id, arm: row.arm, phase: row.phase, sample: row.sample, exit_code: row.exit_code }));
const outputDir = audit.output_dir ?? resolve(join(auditPath, ".."));
const hostWarnings = [];
for (const row of audit.runs) {
  const hostPath = join(outputDir, "runs", `${row.run_id}.host.log`);
  if (!existsSync(hostPath)) continue;
  const text = readFileSync(hostPath, "utf8");
  const matches = [...text.matchAll(/(?:projection_source_mismatch|source_changed|publication_conflict|indexing_failed|enumeration_failed)/g)].map((match) => match[0]);
  if (matches.length) hostWarnings.push({ run_id: row.run_id, codes: [...new Set(matches)] });
}
const dataRoot = join(outputDir, "data");
const remainingDataRoots = existsSync(dataRoot) ? readdirSync(dataRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
const worktreeRoot = join(outputDir, "worktrees");
const remainingWorktrees = existsSync(worktreeRoot) ? readdirSync(worktreeRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
const benchmarkScope = task === "lifecycle-map"
  ? {
    repository_shape: "large TypeScript monorepo (Vite)",
    change_shape: "cross-cutting documentation and migration-map task with no production-code edit",
    discovery_shape: "broad caller/consumer tracing across plugin lifecycle, build/serve paths, tests, and docs",
    iteration_shape: "three agent instructions/resumes per run",
    evidence_shape: "many file:line references, a caller matrix, lifecycle invariants, and staged risks/validation",
    interpretation: "This workload is designed to reward broad code-intelligence graph traversal; it is not a universal ranking for implementation tasks.",
  }
  : {
    repository_shape: "large TypeScript monorepo (Vite)",
    change_shape: "highly localized development-server hook with nearby tests and API docs",
    discovery_shape: "precise symbols and lifecycle paths rather than broad architecture exploration",
    iteration_shape: "three agent instructions/resumes per run",
    evidence_shape: "bounded source files, focused tests, and concise documentation",
    interpretation: "This measures code-intelligence overhead for a large-repository, localized-change workload; it is not a universal ranking for every coding task.",
  };
const report = {
  report_version: 1,
  generated_at: new Date().toISOString(),
  task,
  benchmark_scope: benchmarkScope,
  source_audit: { sha256: sha256(auditBytes), retention: "External raw campaign evidence; not committed because it contains host-local paths and transcripts." },
  campaign: { campaign_id: audit.campaign_id, repository: audit.repository, commit: audit.commit, model: audit.model, samples_per_arm_phase: audit.samples_per_arm_phase, arms, phases, total_expected_runs: Number(audit.samples_per_arm_phase ?? 0) * arms.length * phases.length, successful_runs: audit.runs.filter(successful).length, failed_runs: failedRuns.length },
  smoke_gate: smokeAudit === undefined ? null : { source_audit_sha256: sha256(smokeAuditBytes), expected_runs: 6, successful_runs: (smokeAudit.runs ?? []).filter(successful).length, failed_runs: smokeAudit.failed_runs ?? null, passed: (smokeAudit.runs ?? []).filter(successful).length === 6 && (smokeAudit.failed_runs ?? 0) === 0 },
  groups,
  overall,
  failed_runs: failedRuns,
  host_warnings: hostWarnings,
  cleanup: { remaining_data_roots: remainingDataRoots, remaining_worktrees: remainingWorktrees, clean: remainingDataRoots.length === 0 && remainingWorktrees.length === 0 },
  cost_note: "Estimated cost uses the campaign rates: input USD 2/M tokens; output and reasoning USD 8/M tokens. It is not a provider invoice.",
};
writeFileSync(outputJson, `${JSON.stringify(report, null, 2)}\n`);
const fmt = (n, digits = 0) => n === null || n === undefined ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const table = (scope) => arms.flatMap((arm) => (scope === "groups" ? phases : [null]).map((phase) => {
  const entry = scope === "groups" ? groups[`${arm}:${phase}`] : overall[arm];
  const m = entry.metrics;
  return `| ${arm} | ${scope === "groups" ? phase : "cold+warm"} | ${entry.count}/${entry.expected} | ${fmt(m.elapsed_ms.median / 1000, 0)} s | ${fmt(m.total_tokens.median / 1e6, 2)} M | $${fmt(m.estimated_cost_usd.median, 2)} | ${fmt(m.outer_turns.median)} | ${fmt(m.mcp_calls.median)} |`;
})).join("\n");
const markdown = `# Vite agent-matched benchmark results\n\nGenerated from [audit.json](${auditPath}) at ${report.generated_at}. All arms ran the same three-iteration task against ${audit.repository} at commit ${audit.commit}, using model ${audit.model}.\n\n## Outcome\n\n- **Runs:** ${report.campaign.successful_runs}/${report.campaign.total_expected_runs} successful; ${report.campaign.failed_runs} failed.\n- **Smoke gate:** ${report.smoke_gate === null ? "not supplied" : `${report.smoke_gate.successful_runs}/${report.smoke_gate.expected_runs} successful; passed=${report.smoke_gate.passed}`}.\n- **Arms:** baseline (ordinary tools), codebase-memory (codebase-memory MCP), Urdira (Urdira MCP).\n- **Phases:** cold and warm; ${audit.samples_per_arm_phase} samples per arm/phase.\n- **Cost basis:** ${report.cost_note}\n\n## Per arm and phase (median; p95 is in JSON)\n\n| Arm | Phase | Success | Time | Tokens | Est. cost | Outer turns | MCP calls |\n|---|---|---:|---:|---:|---:|---:|---:|\n${table("groups")}\n\n## Overall by arm (cold + warm)\n\n| Arm | Scope | Success | Time | Tokens | Est. cost | Outer turns | MCP calls |\n|---|---|---:|---:|---:|---:|---:|---:|\n${table("overall")}\n\n## Reliability and storage hygiene\n\n- Failed runs: ${report.failed_runs.length === 0 ? "none" : report.failed_runs.map((run) => run.run_id).join(", ")}.\n- Host warnings were recorded separately from task success: ${report.host_warnings.length} run log(s) contain indexing/projection diagnostics.\n- Disposable Urdira data roots remaining after the campaign: ${remainingDataRoots.length}; benchmark worktrees remaining: ${remainingWorktrees.length}; cleanup status: **${report.cleanup.clean ? "clean" : "requires review"}**.\n\nThe JSON file contains p95, means, cached/uncached input tokens, command actions, file-change batches, warnings, failures, and exact cleanup evidence.\n`;
const workloadScope = task === "lifecycle-map"
  ? "\n\n## Workload scope and interpretation\n\nThis is a broad cross-cutting discovery workload in a **large TypeScript monorepo**: the agent must trace plugin lifecycle callers and consumers across build/serve paths, tests, and docs, then produce a **file:line evidence map**, caller matrix, invariants, risks, and staged migration plan over **three iterations**. It is designed to give graph-based code intelligence a plausible advantage over targeted shell search. It should not be generalized to localized implementation work.\n"
  : "\n\n## Workload scope and interpretation\n\nThis is a specific workload: a **large TypeScript monorepo**, a **highly localized change**, **precise discovery** of a few lifecycle/type paths, **three agent iterations**, and **bounded expected evidence** (nearby files, focused tests, and concise docs). It is useful for measuring code-intelligence overhead when targeted native tools may already solve the task. It should not be generalized to broad architectural exploration or distributed cross-repository changes.\n";
const portableMarkdown = markdown.replace(
  `Generated from [audit.json](${auditPath}) at ${report.generated_at}.`,
  `Generated at ${report.generated_at} from raw audit \`${report.source_audit.sha256}\`. Raw transcripts and host-local paths are retained outside the public repository.`,
);
writeFileSync(outputMarkdown, portableMarkdown.replace("\n\n## Per arm and phase (median; p95 is in JSON)", `${workloadScope}\n## Per arm and phase (median; p95 is in JSON)`));
console.log(JSON.stringify({ output_json: outputJson, output_markdown: outputMarkdown, successful_runs: report.campaign.successful_runs, failed_runs: report.campaign.failed_runs, cleanup_clean: report.cleanup.clean }));
