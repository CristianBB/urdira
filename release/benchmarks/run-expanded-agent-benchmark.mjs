#!/usr/bin/env node
/* global URL */
/* Sequential campaign driver for the four-arm TypeScript benchmark. */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const corpusPath = join(root, "release/benchmarks/expanded-typescript-agent-benchmark.json");
const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
const argv = process.argv.slice(2);
const value = (name, fallback) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };
const samples = Number(value("--samples", "1"));
const outputDir = resolve(value("--output-dir", join("/tmp", `urdira-expanded-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`)));
const repositoriesRoot = resolve(value("--repositories-root", join("/tmp", "urdira-expanded-benchmark", "repos")));
const worktreeRoot = resolve(value("--worktree-root", join(outputDir, "worktrees")));
const codex = value("--codex", "/Applications/ChatGPT.app/Contents/Resources/codex");
const nodeBin = value("--node", process.execPath);
const codegraphBin = value("--codegraph", join("/tmp", "urdira-expanded-benchmark", "codegraph-cli", "node_modules", ".bin", "codegraph"));
const codebaseMemoryBin = value("--codebase-memory", "/Users/Cristian/.local/bin/codebase-memory-mcp");
const runner = join(root, "release/benchmarks/expanded-agent-benchmark-runner.mjs");
const requestedArms = value("--arms", corpus.arms.join(",")).split(",").map((arm) => arm.trim()).filter(Boolean);
const arms = [...new Set(requestedArms)];
const requestedRepositoryIds = value("--repositories", corpus.repositories.map((repository) => repository.id).join(",")).split(",").map((repository) => repository.trim()).filter(Boolean);
const repositories = corpus.repositories.filter((repository) => requestedRepositoryIds.includes(repository.id));
const smokeAuditPath = value("--smoke-audit", undefined);
const independentCampaigns = Number(value("--independent-campaigns", "1"));
const [nodeMajor, nodeMinor, nodePatch] = process.versions.node.split(".").map(Number);
if (nodeMajor < 24 || nodeMajor === 24 && (nodeMinor < 18 || nodeMinor === 18 && nodePatch < 1)) throw new Error(`Node >=24.18.1 is required for the expanded campaign; found ${process.version}`);
if (arms.length === 0 || arms.some((arm) => !corpus.arms.includes(arm))) throw new Error(`--arms must contain only: ${corpus.arms.join(", ")}`);
if (repositories.length === 0 || repositories.length !== requestedRepositoryIds.length) throw new Error(`--repositories must contain only known repository ids: ${corpus.repositories.map((repository) => repository.id).join(", ")}`);
if (!Number.isSafeInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");
if (!Number.isSafeInteger(independentCampaigns) || independentCampaigns < 1) throw new Error("--independent-campaigns must be a positive integer");
if (!existsSync(codex)) throw new Error(`Codex executable not found: ${codex}`);
if (arms.includes("codegraph") && !existsSync(codegraphBin)) throw new Error(`CodeGraph executable not found: ${codegraphBin}`);
if (arms.includes("codebase-memory") && !existsSync(codebaseMemoryBin)) throw new Error(`codebase-memory executable not found: ${codebaseMemoryBin}`);

if (samples > 1) {
  if (smokeAuditPath === undefined) throw new Error("The expanded campaign is gated: pass --smoke-audit pointing to a completed six-run smoke audit.");
  let smoke;
  try { smoke = JSON.parse(await readFile(resolve(smokeAuditPath), "utf8")); } catch (error) { throw new Error(`Unable to read smoke audit ${smokeAuditPath}: ${error instanceof Error ? error.message : String(error)}`); }
  const successful = (smoke.runs ?? []).filter((entry) => entry?.exit_code === 0 && entry?.manifest?.completed_successfully === true && (entry.arm ?? entry.manifest?.arm) === "urdira-typescript");
  const groups = new Set(successful.map((entry) => `${entry.repository ?? entry.repository_id}:${entry.task ?? entry.task_id}`));
  const expectedTasks = new Set(corpus.repositories.flatMap((repository) => repository.tasks.map((task) => `${repository.id}:${task.id}`)));
  if (smoke.failed_runs !== 0 || successful.length !== expectedTasks.size || groups.size !== expectedTasks.size || [...expectedTasks].some((task) => !groups.has(task))) throw new Error(`The eight-task expanded smoke gate has not passed: successful=${successful.length}, failed=${smoke.failed_runs ?? "unknown"}, groups=${groups.size}, expected=${expectedTasks.size}`);
}

const run = (command, args, options = {}) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("error", reject);
  child.on("close", (code, signal) => resolvePromise({ code: code ?? 1, signal, stdout, stderr }));
});

const cleanupCell = async ({ repositoryRoot, worktree, dataRoot, codebaseMemoryBin, codebaseMemoryProject }) => {
  const evidence = { codegraph_servers_terminated: true, worktree_removed: false, data_root_removed: false, worktree_pruned: false, codebase_project_removed: codebaseMemoryProject === undefined, errors: [] };
  const processList = await run("ps", ["-ax", "-o", "pid=,command="]);
  const worktreeVariants = [worktree, worktree.startsWith("/tmp/") ? `/private${worktree}` : null].filter(Boolean);
  const codegraphPids = processList.stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("codegraph.js serve --mcp") && (worktreeVariants.some((candidate) => line.includes(`--path ${candidate}`)) || line.includes(`--path ${basename(worktree)}`)))
    .map((line) => Number(line.split(/\s+/u, 1)[0]))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
  for (const pid of codegraphPids) {
    try {
      process.kill(pid, "SIGTERM");
      try { process.kill(pid, "SIGKILL"); } catch { /* the server exited after SIGTERM */ }
    } catch (error) { evidence.errors.push(`codegraph pid ${pid}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  evidence.codegraph_servers_terminated = codegraphPids.every((pid) => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  });
  if (existsSync(worktree)) {
    const removed = await run("git", ["worktree", "remove", "--force", worktree], { cwd: repositoryRoot });
    evidence.worktree_removed = removed.code === 0 && !existsSync(worktree);
    if (!evidence.worktree_removed) {
      try { rmSync(worktree, { recursive: true, force: true }); } catch (error) { evidence.errors.push(`worktree: ${error instanceof Error ? error.message : String(error)}`); }
      evidence.worktree_removed = !existsSync(worktree);
    }
  } else {
    evidence.worktree_removed = true;
  }
  const pruned = await run("git", ["worktree", "prune"], { cwd: repositoryRoot });
  evidence.worktree_pruned = pruned.code === 0;
  if (dataRoot !== undefined && existsSync(dataRoot)) {
    try { rmSync(dataRoot, { recursive: true, force: true }); } catch (error) { evidence.errors.push(`data_root: ${error instanceof Error ? error.message : String(error)}`); }
  }
  evidence.data_root_removed = dataRoot === undefined || !existsSync(dataRoot);
  if (codebaseMemoryProject !== undefined) {
    const deleted = await run(codebaseMemoryBin, ["cli", "delete_project", `--project=${codebaseMemoryProject}`], { cwd: root });
    evidence.codebase_project_removed = deleted.code === 0;
    if (!evidence.codebase_project_removed) evidence.errors.push(`codebase-memory: ${deleted.stderr || deleted.stdout}`.slice(0, 1000));
  }
  return evidence;
};

const orderFor = (sample, repoIndex, taskIndex) => {
  const rotation = (sample - 1 + repoIndex + taskIndex) % arms.length;
  return arms.slice(rotation).concat(arms.slice(0, rotation));
};

mkdirSync(outputDir, { recursive: true });
mkdirSync(worktreeRoot, { recursive: true });
writeFileSync(join(dirname(outputDir), "expanded-latest"), `${outputDir}\n`, "utf8");
const audit = {
  campaign_id: `expanded-typescript-agent-${new Date().toISOString()}`,
  generated_at: new Date().toISOString(),
  corpus: corpusPath,
  model: corpus.model,
  node: process.version,
  samples_per_cell: samples,
  independent_campaigns: independentCampaigns,
  arms,
  repositories: repositories.map(({ id, repository, source_ref, commit, size_tier, tasks }) => ({ id, repository, source_ref: source_ref ?? commit, commit, size_tier, tasks: tasks.map(({ id, complexity, scenario }) => ({ id, complexity, scenario })) })),
  output_dir: outputDir,
  runs: [],
};

for (let sample = 1; sample <= samples; sample += 1) {
  for (let repoIndex = 0; repoIndex < repositories.length; repoIndex += 1) {
    const repo = repositories[repoIndex];
    const repositoryRoot = join(repositoriesRoot, repo.id);
    if (!existsSync(join(repositoryRoot, ".git"))) throw new Error(`Repository checkout is unavailable: ${repositoryRoot}`);
    for (let taskIndex = 0; taskIndex < repo.tasks.length; taskIndex += 1) {
      const task = repo.tasks[taskIndex];
      for (const arm of orderFor(sample, repoIndex, taskIndex)) {
        const runId = `${repo.id}-${task.id}-${arm}-${sample}`;
        const worktree = join(worktreeRoot, runId);
        const runOutput = join(outputDir, "runs");
        // Unix-domain sockets have a platform-defined path limit. Keep the
        // durable benchmark report under outputDir, but put each isolated
        // Urdira data root under a short temporary prefix so the daemon
        // endpoint remains valid on macOS and Linux.
        const dataRootKey = createHash("sha256").update(`${basename(outputDir)}:${runId}`).digest("hex").slice(0, 16);
        const dataRoot = join("/tmp", "u2d", dataRootKey);
        mkdirSync(runOutput, { recursive: true });
        const worktreeResult = await run("git", ["worktree", "add", "--detach", worktree, repo.commit], { cwd: repositoryRoot });
        if (worktreeResult.code !== 0) throw new Error(`Unable to create ${worktree}: ${worktreeResult.stderr}`);
        const started = Date.now();
        let result;
        let manifest;
        try {
          result = await run(nodeBin, [runner, "--repository-id", repo.id, "--task-id", task.id, "--arm", arm, "--sample", String(sample), "--phase", "warm", "--worktree", worktree, "--data-root", dataRoot, "--output-dir", runOutput, "--commit", repo.commit, "--model", corpus.model, "--codex", codex, "--node", nodeBin, "--codegraph", codegraphBin, "--codebase-memory", codebaseMemoryBin], { cwd: root, env: { URDIRA_SEMANTIC_INDEX: "0" } });
          const manifestPath = join(runOutput, `${runId}.json`);
          try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch { manifest = undefined; }
        } finally {
          const cleanup = await cleanupCell({ repositoryRoot, worktree, dataRoot, codebaseMemoryBin, codebaseMemoryProject: arm === "codebase-memory" ? `${repo.id}-${task.id}-${arm}-${sample}` : undefined });
          audit.runs.push({ run_id: runId, repository: repo.id, task: task.id, scenario: task.scenario ?? null, size_tier: repo.size_tier ?? null, arm, sample, order_index: orderFor(sample, repoIndex, taskIndex).indexOf(arm), exit_code: result?.code ?? 1, elapsed_ms: Date.now() - started, manifest, cleanup, stdout_tail: result?.stdout?.slice(-6000) ?? "", stderr_tail: result?.stderr?.slice(-6000) ?? "" });
          writeFileSync(join(outputDir, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
        }
      }
    }
  }
}

const successful = audit.runs.filter((entry) => entry.manifest?.completed_successfully === true);
audit.successful_runs = successful.length;
audit.failed_runs = audit.runs.length - successful.length;
audit.expected_runs = repositories.length * 2 * arms.length * samples;
audit.campaign_gate = { passed: audit.failed_runs === 0 && audit.runs.length === audit.expected_runs };
writeFileSync(join(outputDir, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output_dir: outputDir, successful_runs: audit.successful_runs, failed_runs: audit.failed_runs, expected_runs: audit.expected_runs }));
if (!audit.campaign_gate.passed) process.exitCode = 1;
