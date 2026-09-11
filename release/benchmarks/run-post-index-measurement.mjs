#!/usr/bin/env node
/* global URL */
/**
 * One directed post-index host/agent measurement.  Execution is opt-in;
 * planning is the default.  The actual checkout, Urdira host, MCP entrypoint,
 * readiness gate, timing sidecar, transcript, and cleanup are delegated to the
 * existing expanded campaign driver/runner.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzePostMeasurement, buildPostMeasurementPlan } from "./post-index-measurement.mjs";
import { analyzeExpandedTranscript } from "./expanded-agent-transcript-metrics.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const corpusPath = join(root, "release/benchmarks/expanded-typescript-agent-benchmark.json");
const driverPath = join(root, "release/benchmarks/run-expanded-agent-benchmark.mjs");
const args = process.argv.slice(2);
const value = (name, fallback = null) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const repositoryIds = (value("--repositories", "") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
const outputDir = value("--output-dir");
const repositoriesRoot = value("--repositories-root");
const comparisonReport = value("--comparison-report");
const nodeBin = value("--node", process.execPath);
const codex = value("--codex", "/Applications/ChatGPT.app/Contents/Resources/codex");
const indexingWorker = value("--indexing-worker", process.env.URDIRA_INDEXING_CORE_WORKER_PATH ?? join(root, "target/release/urdira-indexing-worker"));
const sample = Number(value("--sample", "1"));
const execute = args.includes("--execute");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

export function buildPostExecutionPlan({ corpus: selectedCorpus = corpus, repositoryIds: ids = repositoryIds, output = outputDir, node = nodeBin, codexPath = codex, indexingWorkerPath = indexingWorker, repositoriesRoot: reposRoot = repositoriesRoot, comparison = comparisonReport } = {}) {
  const measurementPlan = buildPostMeasurementPlan({ corpus: selectedCorpus, repositoryIds: ids.length ? ids : undefined, sample });
  const selectedIds = measurementPlan.repositories.map((repo) => repo.id);
  if (!output) throw new Error("--output-dir is required");
  if (!reposRoot) throw new Error("--repositories-root is required");
  return {
    schema_version: 1,
    execution: "existing-expanded-driver-composition",
    execute_flag: "--execute",
    no_retries: true,
    model: selectedCorpus.model,
    repositories: measurementPlan.repositories,
    sample,
    measurement_plan: measurementPlan,
    command: [node, driverPath, "--samples", "1", "--arms", "urdira-typescript", "--repositories", selectedIds.join(","), "--repositories-root", resolve(reposRoot), "--output-dir", resolve(output), "--node", node, "--codex", codexPath],
    environment: {
      URDIRA_SEMANTIC_INDEX: "0", URDIRA_SEMANTIC_MATERIALIZATION: "0", URDIRA_SEMANTIC_SIDECAR: "0",
      URDIRA_ANALYSIS_WORKERS: "1", URDIRA_ANALYSIS_POOL_MAX: "1", URDIRA_STRUCTURAL_CONCURRENCY: "1",
      URDIRA_RECONCILIATION_SWEEP_INTERVAL_MS: "0", URDIRA_DEBUG_TIMING: "1", URDIRA_STORAGE_DEBUG_TIMING: "1",
      URDIRA_V4_DEBUG_SEMANTIC_PERF: "1", URDIRA_INDEXING_CORE_WORKER_PATH: indexingWorkerPath, production_mcp_instructions: true, extra_prompt: false, pipeline_required: false,
    },
    raw_artifacts: ["audit.json", "environment.json", "runs/*.json", "runs/*.jsonl", "runs/*.host.log", "runs/*.timing.json", "driver.stdout", "driver.stderr", "post-measurements.json"],
    comparison: comparison ? { path: resolve(comparison), executed: false } : { path: null, executed: false },
  };
}

function extractDaemonTelemetry(hostLog) {
  const telemetry = { operation_metrics: [], operation_page_metrics: [], readiness: [], raw_lines: [] };
  for (const line of String(hostLog ?? "").split("\n")) {
    const match = line.match(/(?:^|\s)(operation_metrics|operation_page_metrics)=(\[.*\])\s*$/u);
    if (match) {
      try { telemetry[match[1]].push(JSON.parse(match[2])); } catch { telemetry.raw_lines.push(line); }
    }
    if (line.includes("BENCH_HOST_READY")) telemetry.readiness.push(line);
  }
  return telemetry;
}

export function collectPostMeasurements({ audit, output }) {
  const runs = [];
  for (const run of audit?.runs ?? []) {
    const runId = run.run_id;
    const base = join(output, "runs");
    const manifestPath = join(base, `${runId}.json`);
    const manifest = run.manifest ?? (existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null);
    const eventsPath = manifest?.transcript ?? join(base, `${runId}.jsonl`);
    const hostPath = manifest?.host_log ?? join(base, `${runId}.host.log`);
    let events = [];
    try { events = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { /* retained failure or missing transcript */ }
    let hostLog = "";
    try { hostLog = readFileSync(hostPath, "utf8"); } catch { /* retained failure or missing host */ }
    const plan = buildPostMeasurementPlan({ corpus, repositoryIds: [run.repository], sample: run.sample });
    const measurement = analyzePostMeasurement({ events, plan, hostMetrics: manifest?.host_metrics ?? null });
    const task = corpus.repositories?.find((repository) => repository.id === run.repository)?.tasks?.find((candidate) => candidate.id === run.task) ?? null;
    const transcriptMetrics = analyzeExpandedTranscript(events, run.arm, task);
    const completedSuccessfully = manifest?.completed_successfully ?? false;
    const failure = run.failure ?? manifest?.error ?? (!completedSuccessfully ? `run failed (exit_code=${manifest?.exit_code ?? run.exit_code ?? "unknown"}, grader_exit_code=${manifest?.grader_exit_code ?? "unknown"})` : null);
    runs.push({ run_id: runId, repository_id: run.repository, task_id: run.task, arm: run.arm, sample: run.sample, completed_successfully: completedSuccessfully, failure, measurement, transcript_metrics: transcriptMetrics, daemon_telemetry: extractDaemonTelemetry(hostLog), raw: { manifest: manifestPath, transcript: eventsPath, host_log: hostPath, timing_sidecar: manifest?.timing_sidecar ?? join(base, `${runId}.timing.json`) } });
  }
  return { schema_version: 1, generated_at: new Date().toISOString(), rerun_competitors: false, runs };
}

async function executePlan(plan) {
  const output = resolve(outputDir);
  if (existsSync(output)) throw new Error(`Refusing to reuse existing post-index output; choose a new directory: ${output}`);
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, ".post-index-owned"), `${new Date().toISOString()}\n`);
  writeFileSync(join(output, "execution-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  const child = spawn(plan.command[0], plan.command.slice(1), { cwd: root, env: { ...process.env, ...plan.environment }, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [], stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  const exitCode = await new Promise((resolveExit) => child.on("close", (code) => resolveExit(code ?? 1)));
  writeFileSync(join(output, "driver.stdout"), stdout.join(""));
  writeFileSync(join(output, "driver.stderr"), stderr.join(""));
  const audit = JSON.parse(readFileSync(join(output, "audit.json"), "utf8"));
  const post = collectPostMeasurements({ audit, output });
  writeFileSync(join(output, "post-measurements.json"), `${JSON.stringify(post, null, 2)}\n`);
  const comparison = plan.comparison.path && existsSync(plan.comparison.path) ? { path: plan.comparison.path, sha256: `sha256:${createHash("sha256").update(readFileSync(plan.comparison.path)).digest("hex")}`, executed: false } : plan.comparison;
  writeFileSync(join(output, "comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`);
  const markdownRows = post.runs.map((run) => {
    const readiness = run.measurement.readiness?.structural_readiness_ms ?? "—";
    const telemetry = run.daemon_telemetry.operation_metrics.length;
    const pageTelemetry = run.daemon_telemetry.operation_page_metrics.length;
    const components = run.transcript_metrics?.mcp_component_bytes ?? {};
    return `| ${run.repository_id} | ${run.task_id} | ${run.completed_successfully ? "yes" : "no"} | ${readiness} | ${components.tool_envelope ?? "—"} | ${components.model_visible_serialized ?? "—"} | ${components.source_text ?? "—"} | ${components.records ?? "—"} | ${components.hydration ?? "—"} | ${components.evidence ?? "—"} | ${components.registry ?? "—"} | ${telemetry} | ${pageTelemetry} | ${run.failure ?? "—"} |`;
  });
  writeFileSync(join(output, "post-measurements.md"), `# Post-index measurement\n\nThis report uses the existing expanded runner composition, one directed Urdira sample, production MCP instructions, structural readiness, and semantic-off settings. Competitors were not executed; failures remain visible.\n\n| Repository | Task | Success | Structural readiness ms | Tool envelope | Model-visible serialized | Source text | Records | Hydration | Evidence | Registry | Operation telemetry | Page telemetry | Failure |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|\n${markdownRows.join("\n")}\n`);
  return { output, exit_code: exitCode, successful_runs: audit.successful_runs ?? 0, failed_runs: audit.failed_runs ?? 0, post_measurements: join(output, "post-measurements.json"), comparison };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const plan = buildPostExecutionPlan();
  if (!execute) { const target = value("--plan-output"); if (target) writeFileSync(resolve(target), `${JSON.stringify(plan, null, 2)}\n`); else process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`); }
  else { if (!Number.isSafeInteger(sample) || sample !== 1) throw new Error("Exactly one sample is supported; retries are disabled."); const result = await executePlan(plan); process.stdout.write(`${JSON.stringify(result)}\n`); process.exitCode = result.exit_code === 0 ? 0 : 1; }
}
