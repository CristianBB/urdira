#!/usr/bin/env node
/* global URL */
/* Sequential, auditable Vite campaign: 3 arms x 2 cache states x N samples. */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const value = (name, fallback) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };
const samples = Number(value("--samples", has("--smoke") ? "1" : "10"));
const smokeAuditPath = value("--smoke-audit", undefined);
const outputDir = resolve(value("--output-dir", join(tmpdir(), `urdira-vite-agent-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`)));
const worktreeRoot = resolve(value("--worktree-root", join(outputDir, "worktrees")));
const repositoryRoot = resolve(value("--repository-root", process.env.VITE_BENCHMARK_REPOSITORY ?? join(root, "..", "urdira-benchmark", "vite")));
const commit = value("--commit", "c0f2fc607ee97ee4499337b04826420c00654065");
const model = value("--model", "gpt-5.6-luna");
const task = value("--task", "server-request");
const codex = value("--codex", process.env.CODEX_BIN ?? "codex");
const memoryBin = value("--codebase-memory", process.env.CODEBASE_MEMORY_BIN ?? "codebase-memory-mcp");
const nodeBin = value("--node", process.execPath);
const runner = join(root, "release/benchmarks/vite-agent-matched-runner.mjs");
const analyzer = join(root, "release/benchmarks/analyze-agent-matched.mjs");
const arms = ["baseline", "codebase-memory", "urdira"];
const phases = ["cold", "warm"];
if (!Number.isSafeInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");

const run = (command, args, options = {}) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("error", reject);
  child.on("close", (code, signal) => resolvePromise({ code: code ?? 1, signal, stdout, stderr }));
});
const git = async (...args) => {
  const result = await run("git", args, { cwd: repositoryRoot });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
};
const orderFor = (sample, phase) => { const rotation = (sample - 1 + (phase === "warm" ? 1 : 0)) % arms.length; return arms.slice(rotation).concat(arms.slice(0, rotation)); };
const cleanupRunArtifacts = async (worktree, dataRoot) => {
  const removed = await run("git", ["worktree", "remove", "--force", worktree], { cwd: repositoryRoot });
  if (removed.code !== 0) rmSync(worktree, { recursive: true, force: true });
  // The matched runner gives each Urdira sample an isolated durable root.
  // Its audit/transcript/host log live in outputDir and remain evidence; the
  // indexed database and CAS are disposable after the sample completes.
  rmSync(dataRoot, { recursive: true, force: true });
};
async function smokeGate() {
  if (samples <= 1 || has("--smoke")) return;
  if (!smokeAuditPath) throw new Error("The 60-run Vite campaign is gated: pass --smoke-audit pointing to a completed six-run smoke audit.");
  const smoke = JSON.parse(await readFile(resolve(smokeAuditPath), "utf8"));
  const groups = arms.flatMap((arm) => phases.map((phase) => `${arm}:${phase}`));
  const successful = (smoke.runs ?? []).filter((entry) => entry?.exit_code === 0 && entry?.metrics?.completed_successfully === true);
  const counts = new Map(groups.map((group) => [group, 0]));
  for (const entry of successful) { const group = `${entry.arm}:${entry.phase}`; if (counts.has(group)) counts.set(group, counts.get(group) + 1); }
  if (smoke.task !== task || smoke.failed_runs !== 0 || successful.length !== 6 || groups.some((group) => counts.get(group) !== 1)) throw new Error(`The six-run ${task} smoke gate has not passed: task=${smoke.task ?? "unknown"}, successful=${successful.length}, failed=${smoke.failed_runs ?? "unknown"}, groups=${JSON.stringify(Object.fromEntries(counts))}`);
}
async function preflight() {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && (minor < 18 || (minor === 18 && patch < 1)))) throw new Error(`Node >=24.18.1 is required; found ${process.version}`);
  if (!existsSync(join(repositoryRoot, ".git"))) throw new Error("The frozen Vite repository is unavailable.");
  if ((await run(codex, ["--version"], { cwd: root })).code !== 0) throw new Error(`Codex executable is unavailable: ${codex}`);
  if ((await run(memoryBin, ["--help"], { cwd: root })).code !== 0) throw new Error(`codebase-memory executable is unavailable: ${memoryBin}`);
  await git("rev-parse", "--verify", `${commit}^{commit}`);
  if (!existsSync(join(root, "apps/urdira/dist/index.js"))) throw new Error("Built Urdira artifacts are required before campaign execution.");
}

await preflight();
if (has("--preflight")) {
  console.log(JSON.stringify({ runtime: process.version, repository: "vitejs/vite", commit, codex_available: true, urdira_dist: existsSync(join(root, "apps/urdira/dist/index.js")), codebase_memory_available: true, dependencies_present: existsSync(join(repositoryRoot, "node_modules")) }));
  process.exit(0);
}
await smokeGate();
mkdirSync(outputDir, { recursive: true });
mkdirSync(worktreeRoot, { recursive: true });
const audit = { campaign_id: `vite-agent-${task}-${new Date().toISOString()}`, task, repository: "vitejs/vite", commit, model, samples_per_arm_phase: samples, arms, phases, output_dir: outputDir, runs: [] };
for (let sample = 1; sample <= samples; sample += 1) for (const phase of phases) for (const arm of orderFor(sample, phase)) {
  const runId = `vite-${arm}-${phase}-${sample}`;
  const worktree = join(worktreeRoot, runId);
  const runOutput = join(outputDir, "runs");
  const dataRoot = join(outputDir, "data", runId);
  mkdirSync(runOutput, { recursive: true });
  const worktreeResult = await run("git", ["worktree", "add", "--detach", worktree, commit], { cwd: repositoryRoot });
  if (worktreeResult.code !== 0) throw new Error(`Unable to create worktree ${worktree}: ${worktreeResult.stderr}`);
  const started = Date.now();
  const result = await run(nodeBin, [runner, "--task", task, "--arm", arm, "--phase", phase, "--sample", String(sample), "--worktree", worktree, "--output-dir", runOutput, "--data-root", dataRoot, "--commit", commit, "--model", model, "--codex", codex, "--codebase-memory", memoryBin, "--node", nodeBin], { cwd: root, env: { URDIRA_SEMANTIC_INDEX: "0" } });
  const transcriptPath = join(runOutput, `${runId}.jsonl`);
  const analysis = existsSync(transcriptPath) ? await run(nodeBin, [analyzer, transcriptPath], { cwd: root }) : undefined;
  let metrics;
  if (analysis?.code === 0) { try { metrics = JSON.parse(analysis.stdout); } catch { metrics = undefined; } }
  let manifest;
  try { manifest = JSON.parse(await readFile(join(runOutput, `${runId}.json`), "utf8")); } catch { manifest = undefined; }
  metrics = manifest ? { ...(metrics ?? {}), completed_successfully: manifest.grader?.completed_successfully === true, elapsed_ms_from_first_instruction: manifest.elapsed_ms_from_first_instruction, setup_elapsed_ms: manifest.setup_elapsed_ms, total_elapsed_ms: Number(manifest.elapsed_ms_from_first_instruction ?? 0) + Number(manifest.setup_elapsed_ms ?? 0) } : metrics;
  audit.runs.push({ run_id: runId, arm, phase, sample, order_index: orderFor(sample, phase).indexOf(arm), exit_code: result.code, elapsed_ms: Date.now() - started, metrics, stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-4000) });
  writeFileSync(join(outputDir, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  await cleanupRunArtifacts(worktree, dataRoot);
}
audit.successful_runs = audit.runs.filter((entry) => entry.exit_code === 0 && entry.metrics?.completed_successfully === true).length;
audit.failed_runs = audit.runs.length - audit.successful_runs;
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null; };
const aggregate = { campaign_id: audit.campaign_id, generated_at: new Date().toISOString(), samples_per_arm_phase: samples, successful_runs: audit.successful_runs, failed_runs: audit.failed_runs, groups: Object.fromEntries(arms.flatMap((arm) => phases.map((phase) => { const rows = audit.runs.filter((entry) => entry.arm === arm && entry.phase === phase && entry.metrics?.completed_successfully === true); return [`${arm}:${phase}`, { count: rows.length, elapsed_ms_median: percentile(rows.map((entry) => entry.metrics.elapsed_ms_from_first_instruction).filter(Number.isFinite), 0.5), total_tokens_median: percentile(rows.map((entry) => entry.metrics.total_tokens).filter(Number.isFinite), 0.5), outer_turns_median: percentile(rows.map((entry) => entry.metrics.outer_turns).filter(Number.isFinite), 0.5), estimated_cost_usd_median: percentile(rows.map((entry) => entry.metrics.estimated_cost_usd).filter(Number.isFinite), 0.5) }]; }))) };
aggregate.campaign_gate = { smoke_required: samples > 1, smoke_audit: smokeAuditPath ?? null, required_successes: samples * arms.length * phases.length, passed: audit.failed_runs === 0 && audit.successful_runs === samples * arms.length * phases.length };
writeFileSync(join(outputDir, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
writeFileSync(join(outputDir, "aggregate.json"), `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output_dir: outputDir, successful_runs: audit.successful_runs, failed_runs: audit.failed_runs, expected_successes: samples * arms.length * phases.length }));
if (!aggregate.campaign_gate.passed) process.exitCode = 1;
