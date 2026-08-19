#!/usr/bin/env node
/* global URL */
/* Sequential, auditable driver for the matched three-arm campaign. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const value = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const samples = Number(value("--samples", has("--smoke") ? "1" : "10"));
const smokeAuditPath = value("--smoke-audit", undefined);
const outputDir = resolve(value("--output-dir", join(tmpdir(), `urdira-agent-matched-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`)));
const worktreeRoot = resolve(value("--worktree-root", join(outputDir, "worktrees")));
const repositoryRoot = resolve(value("--repository-root", process.env.URDIRA_BENCHMARK_REPOSITORY ?? join(root, "..", "urdira-benchmark", "excalidraw")));
const commit = value("--commit", "c5a50d2");
const model = value("--model", "gpt-5.6-luna");
const codex = value("--codex", "/Applications/ChatGPT.app/Contents/Resources/codex");
const nodeBin = value("--node", process.execPath);
const runner = join(root, "release/benchmarks/agent-matched-runner.mjs");
const analyzer = join(root, "release/benchmarks/analyze-agent-matched.mjs");
const arms = ["baseline", "source-only", "structural"];
const phases = ["cold", "warm"];
if (!Number.isSafeInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");

async function requirePassingSmokeGate() {
  if (samples <= 1 || has("--smoke")) return;
  if (smokeAuditPath === undefined) throw new Error("The 60-run campaign is gated: pass --smoke-audit pointing to a completed six-run smoke audit.");
  let smoke;
  try { smoke = JSON.parse(await readFile(resolve(smokeAuditPath), "utf8")); } catch (error) { throw new Error(`Unable to read smoke audit ${smokeAuditPath}: ${error instanceof Error ? error.message : String(error)}`); }
  const expectedGroups = arms.flatMap((arm) => phases.map((phase) => `${arm}:${phase}`));
  const successful = (smoke.runs ?? []).filter((entry) => entry?.exit_code === 0 && entry?.metrics !== undefined);
  const counts = new Map(expectedGroups.map((group) => [group, 0]));
  for (const entry of successful) {
    const group = `${entry.arm}:${entry.phase}`;
    if (counts.has(group)) counts.set(group, counts.get(group) + 1);
  }
  if (smoke.failed_runs !== 0 || successful.length !== 6 || expectedGroups.some((group) => counts.get(group) !== 1)) {
    throw new Error(`The six-run smoke gate has not passed: successful=${successful.length}, failed=${smoke.failed_runs ?? "unknown"}, groups=${JSON.stringify(Object.fromEntries(counts))}`);
  }
}

const run = (command, commandArgs, options = {}) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, commandArgs, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("error", reject);
  child.on("close", (code, signal) => resolvePromise({ code: code ?? 1, signal, stdout, stderr }));
});
const git = async (...gitArgs) => {
  const result = await run("git", gitArgs, { cwd: repositoryRoot });
  if (result.code !== 0) throw new Error(`git ${gitArgs.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
};

async function preflight() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeMinor = Number(process.versions.node.split(".")[1]);
  const nodePatch = Number(process.versions.node.split(".")[2]);
  if (nodeMajor < 24 || nodeMajor === 24 && (nodeMinor < 18 || nodeMinor === 18 && nodePatch < 1)) throw new Error(`Node >=24.18.1 is required; found ${process.version}`);
  if (!existsSync(codex)) throw new Error(`Codex executable not found: ${codex}`);
  if (!existsSync(join(repositoryRoot, ".git"))) throw new Error(`Benchmark repository is unavailable: ${repositoryRoot}`);
  if ((await git("rev-parse", "--verify", `${commit}^{commit}`)).length === 0) throw new Error(`Frozen commit is unavailable: ${commit}`);
  if (!existsSync(join(root, "apps/urdira/dist/index.js")) || !existsSync(join(root, "packages/plugin-javascript-typescript/dist/index.js"))) throw new Error("Built Urdira and JavaScript/TypeScript artifacts are required before campaign execution.");
  if ((process.env.URDIRA_SEMANTIC_INDEX ?? "0") !== "0") throw new Error("Semantic indexing must be disabled for this campaign (set URDIRA_SEMANTIC_INDEX=0).");
}

function orderFor(sample, phase) {
  const rotation = (sample - 1 + (phase === "warm" ? 1 : 0)) % arms.length;
  return arms.slice(rotation).concat(arms.slice(0, rotation));
}

await preflight();
await requirePassingSmokeGate();
mkdirSync(outputDir, { recursive: true });
mkdirSync(worktreeRoot, { recursive: true });
writeFileSync(join(dirname(outputDir), "latest"), `${outputDir}\n`, "utf8");
const audit = { campaign_id: `agent-matched-${new Date().toISOString()}`, commit, model, samples_per_arm_phase: samples, arms, phases, output_dir: outputDir, runs: [] };
for (let sample = 1; sample <= samples; sample += 1) {
  for (const phase of phases) {
    for (const arm of orderFor(sample, phase)) {
      const runId = `excalidraw-${arm}-${phase}-${sample}`;
      const worktree = join(worktreeRoot, runId);
      const dataRoot = join(outputDir, "data", runId);
      const runOutput = join(outputDir, "runs");
      mkdirSync(runOutput, { recursive: true });
    const existing = await run("git", ["worktree", "add", "--detach", worktree, commit], { cwd: repositoryRoot });
      if (existing.code !== 0) throw new Error(`Unable to create dedicated worktree ${worktree}: ${existing.stderr}`);
      const started = Date.now();
      const result = await run(nodeBin, [runner, "--arm", arm, "--phase", phase, "--sample", String(sample), "--worktree", worktree, "--data-root", dataRoot, "--output-dir", runOutput, "--commit", commit, "--model", model, "--codex", codex, "--node", nodeBin], { cwd: root, env: { URDIRA_SEMANTIC_INDEX: "0" } });
      const transcriptPath = join(runOutput, `${runId}.jsonl`);
      const analysis = result.code === 0 ? await run(nodeBin, [analyzer, transcriptPath], { cwd: root, env: process.env }) : undefined;
      let metrics;
      if (analysis?.code === 0) {
        metrics = JSON.parse(analysis.stdout);
        try {
          const manifest = JSON.parse(await readFile(join(runOutput, `${runId}.json`), "utf8"));
          metrics = { ...metrics, elapsed_ms_from_first_instruction: manifest.elapsed_ms_from_first_instruction, setup_elapsed_ms: manifest.setup_elapsed_ms, total_elapsed_ms: manifest.elapsed_ms_from_first_instruction + manifest.setup_elapsed_ms };
        } catch { /* retain parser output when a failed runner omitted its manifest */ }
      }
      const entry = { run_id: runId, arm, phase, sample, order_index: orderFor(sample, phase).indexOf(arm), exit_code: result.code, elapsed_ms: Date.now() - started, metrics, stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-4000) };
      audit.runs.push(entry);
      writeFileSync(join(outputDir, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
    }
  }
}
audit.successful_runs = audit.runs.filter((entry) => entry.exit_code === 0).length;
audit.failed_runs = audit.runs.length - audit.successful_runs;
const successful = audit.runs.filter((entry) => entry.exit_code === 0 && entry.metrics !== undefined);
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]; };
const aggregate = { campaign_id: audit.campaign_id, generated_at: new Date().toISOString(), samples_per_arm_phase: samples, successful_runs: successful.length, failed_runs: audit.failed_runs, groups: Object.fromEntries(arms.flatMap((arm) => phases.map((phase) => { const rows = successful.filter((entry) => entry.arm === arm && entry.phase === phase); const elapsed = rows.map((entry) => Number(entry.metrics?.elapsed_ms_from_first_instruction ?? NaN)).filter(Number.isFinite); return [`${arm}:${phase}`, { count: rows.length, elapsed_ms_median: percentile(elapsed, 0.5), elapsed_ms_p95: percentile(elapsed, 0.95), total_tokens_median: percentile(rows.map((entry) => Number(entry.metrics?.total_tokens ?? NaN)).filter(Number.isFinite), 0.5), estimated_cost_usd_median: percentile(rows.map((entry) => Number(entry.metrics?.estimated_cost_usd ?? NaN)).filter(Number.isFinite), 0.5) }]; }))) };
aggregate.campaign_gate = { smoke_required: samples > 1, smoke_audit: smokeAuditPath ?? null, required_successes: samples * arms.length * phases.length, passed: audit.failed_runs === 0 && successful.length === samples * arms.length * phases.length };
writeFileSync(join(outputDir, "aggregate.json"), `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
writeFileSync(join(outputDir, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output_dir: outputDir, successful_runs: audit.successful_runs, failed_runs: audit.failed_runs, expected_successes: samples * arms.length * phases.length }));
if (audit.failed_runs > 0) process.exitCode = 1;
