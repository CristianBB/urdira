#!/usr/bin/env node
/* global URL, setTimeout, clearTimeout, setInterval, clearInterval */
/* One isolated repository/task/arm run for the expanded benchmark. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const corpus = JSON.parse(readFileSync(join(root, "release/benchmarks/expanded-typescript-agent-benchmark.json"), "utf8"));
const argv = process.argv.slice(2);
const value = (name, fallback) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };
const repositoryId = value("--repository-id");
const taskId = value("--task-id");
const arm = value("--arm");
const phase = value("--phase", "warm");
const sample = Number(value("--sample", "1"));
const worktree = value("--worktree");
const dataRoot = value("--data-root");
const outputDir = value("--output-dir", join(root, "release/benchmarks/results"));
const commit = value("--commit");
const model = value("--model", corpus.model);
const codex = value("--codex", "/Applications/ChatGPT.app/Contents/Resources/codex");
const nodeBin = value("--node", process.execPath);
const codegraphBin = value("--codegraph");
const codebaseMemoryBin = value("--codebase-memory");
const benchmarkTimeoutMs = Number(process.env.URDIRA_BENCHMARK_TIMEOUT_MS ?? "900000");
const benchmarkMaxRssKib = Number(process.env.URDIRA_BENCHMARK_MAX_RSS_KIB ?? "5000000");
const repo = corpus.repositories.find((entry) => entry.id === repositoryId);
const task = repo?.tasks.find((entry) => entry.id === taskId);
if (!repo || !task || !["baseline", "urdira-typescript", "codebase-memory", "codegraph"].includes(arm)) throw new Error("Invalid repository, task, or arm");
const preflightOnly = argv.includes("--preflight-only");
if ((!preflightOnly && (!worktree || !commit)) || !Number.isSafeInteger(sample) || sample < 1) throw new Error("--worktree, --commit, and a positive --sample are required");
if (!Number.isSafeInteger(benchmarkTimeoutMs) || benchmarkTimeoutMs < 1_000) throw new Error("URDIRA_BENCHMARK_TIMEOUT_MS must be an integer of at least 1000ms");
if (!Number.isSafeInteger(benchmarkMaxRssKib) || benchmarkMaxRssKib < 1_000_000) throw new Error("URDIRA_BENCHMARK_MAX_RSS_KIB must be an integer of at least 1000000 KiB");

function validateAgentRoleConfig() {
  const rolePath = join(homedir(), ".codex", "agents", "urdira_explorer.toml");
  if (!existsSync(rolePath)) throw new Error(`Urdira benchmark preflight: agent role file is missing: ${rolePath}`);
  const text = readFileSync(rolePath, "utf8");
  const required = ["name", "description", "developer_instructions"];
  for (const field of required) {
    const assignment = new RegExp(`^\\s*${field}\\s*=\\s*`, "m");
    if (!assignment.test(text)) throw new Error(`Urdira benchmark preflight: ${rolePath} is missing TOML field ${field}.`);
  }
  if (!/developer_instructions\s*=\s*(['"]{3}[\s\S]+?['"]{3}|['"][^'"]+['"])/m.test(text)) throw new Error(`Urdira benchmark preflight: ${rolePath}.developer_instructions is empty.`);
  if (!/name\s*=\s*['"]urdira_explorer['"]/m.test(text)) throw new Error(`Urdira benchmark preflight: agent role name must be urdira_explorer.`);
  return rolePath;
}

function validateRuntimePreflight() {
  const version = spawnSync(nodeBin, ["--version"], { encoding: "utf8" });
  if (version.status !== 0) throw new Error(`Urdira benchmark preflight: unable to execute ${nodeBin}: ${version.stderr}`);
  const match = /^v(\d+)\.(\d+)\.(\d+)/u.exec((version.stdout ?? "").trim());
  const major = Number(match?.[1]); const minor = Number(match?.[2]); const patch = Number(match?.[3]);
  if (!match || major < 24 || (major === 24 && (minor < 18 || minor === 18 && patch < 1))) throw new Error(`Urdira benchmark preflight: Node >=24.18.1 is required, found ${(version.stdout ?? "").trim()}.`);
  if (!model || model.trim().length === 0) throw new Error("Urdira benchmark preflight: --model must be non-empty.");
  for (const requiredPath of ["pnpm-lock.yaml", "packages/plugin-javascript-typescript/package.json", "packages/mcp/dist/index.js"]) {
    if (!existsSync(join(root, requiredPath))) throw new Error(`Urdira benchmark preflight: required project artifact is missing: ${requiredPath}`);
  }
  const rolePath = arm === "urdira-typescript" ? validateAgentRoleConfig() : undefined;
  return { node: (version.stdout ?? "").trim(), model, ...(rolePath === undefined ? {} : { agent_role: rolePath }), lockfile: join(root, "pnpm-lock.yaml"), plugin: "urdira:javascript_typescript", dist: join(root, "packages/mcp/dist/index.js") };
}

const preflight = validateRuntimePreflight();
const generatedUrdiraInstructions = arm === "urdira-typescript"
  ? (await import(pathToFileURL(join(root, "apps/urdira/dist/index.js")).href)).MCP_BENCHMARK_INSTRUCTIONS
  : undefined;
if (preflightOnly) {
  process.stdout.write(`${JSON.stringify({ ok: true, repository_id: repositoryId, task_id: taskId, arm, ...preflight })}\n`);
  process.exit(0);
}

mkdirSync(outputDir, { recursive: true });
const runId = `${repositoryId}-${taskId}-${arm}-${sample}`;
// Every Urdira cell receives a fresh data root from the campaign driver. Do
// not collapse it into a shared temporary directory: v1 rejection and
// worktree isolation are part of the benchmark contract.
const effectiveDataRoot = arm === "urdira-typescript" ? (dataRoot ?? join("/tmp", "urdira-expanded-isolated", `${repositoryId}-${taskId}-${sample}`)) : dataRoot;
const transcript = join(outputDir, `${runId}.jsonl`);
const manifestPath = join(outputDir, `${runId}.json`);
const hostLog = join(outputDir, `${runId}.host.log`);
const recordFailure = (reason) => {
  const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  try {
    writeFileSync(manifestPath, `${JSON.stringify({ run_id: runId, repository: repo.repository, repository_id: repositoryId, task_id: taskId, arm, phase, sample, model, commit, worktree, ...(arm === "urdira-typescript" ? { data_root: effectiveDataRoot, host_log: hostLog, host_metrics: finalizeHostMetrics() } : {}), setup_started_at: new Date().toISOString(), completed_successfully: false, failure_stage: argv.includes("--host") ? "urdira_host" : "runner", error: message }, null, 2)}\n`, "utf8");
  } catch { /* retain the original failure when the output directory is unavailable */ }
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
process.on("uncaughtException", recordFailure);
process.on("unhandledRejection", recordFailure);
const setupStartedAt = Date.now();
const assignedPolicy = arm === "baseline"
  ? "Use only ordinary shell/editor tools for discovery. Do not use any MCP, CodeGraph, codebase-memory, or symbol service."
  : arm === "urdira-typescript"
    ? generatedUrdiraInstructions
    : arm === "codebase-memory"
      ? "Use codebase-memory MCP for discovery: search_graph, trace_path, get_code_snippet, get_architecture, or search_code. Do not use grep, rg, find, or broad file listing to rediscover code."
      : "Use CodeGraph MCP directly, especially codegraph_explore, codegraph_node, callers, callees, or impact. Treat returned source and call paths as discovery evidence; do not use grep, rg, find, or broad file listing to rediscover code.";

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  if (options.input !== undefined) child.stdin.end(options.input); else child.stdin.end();
  child.on("error", reject);
  child.on("close", (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));
});
const git = async (...args) => {
  const result = await run("git", args, { cwd: worktree });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
};

if (argv.includes("--host")) await hostMain();

await git("reset", "--hard", commit);
await git("clean", "-fd");
const setup = await prepareArm();
const setupHint = setup.project === undefined ? "" : ` Use codebase-memory project ${setup.project} for graph calls.`;

const initialInstruction = `You are working in the frozen ${repo.repository} checkout at commit ${commit}, in ${worktree}. This is an authorized internal benchmark change; treat it as an accepted maintenance/API task and do not pause to request repository-maintainer confirmation. Complete the first implementation phase of this coding task:

${task.prompt}

Benchmark protocol: ${assignedPolicy}${setupHint} Work only in the checkout. Do not install dependencies. In this first instruction, inspect the relevant architecture, implement the core behavior and focused test scaffolding, but do not run the full repository suite. Do not commit. Summarize what remains for the follow-up.`;
const followUpInstruction = `Continue the same ${repo.repository} task after your first edits. Re-discover the changed symbols using this arm's assigned method (${assignedPolicy})${setupHint} and verify that your discovery sees the modified files. Finish the implementation, public wiring, and focused tests required by this task. Do not install dependencies or commit. If dependencies are unavailable, record the exact deterministic blocker.`;
const finalInstruction = `Perform the final handoff review for the same task. Check the diff for the requested behavior, cross-file callers, public types/exports, and focused tests. Run only a narrow relevant check if dependencies already exist; otherwise do not install them. After your LAST edit, you MUST re-discover every changed symbol using this arm's assigned method (${assignedPolicy}) and verify that the discovery sees the final modified files; do not edit again after that final re-discovery. Report every changed file, exact verification command/result, and any limitation. Do not commit.`;

let host;
let hostMetrics;
if (arm === "urdira-typescript") {
  host = spawn(nodeBin, [fileURLToPath(import.meta.url), "--host", "--repository-id", repositoryId, "--task-id", taskId, "--arm", arm, "--phase", phase, "--sample", String(sample), "--commit", commit, "--worktree", worktree, "--data-root", effectiveDataRoot], { cwd: root, env: { ...process.env, URDIRA_DATA_ROOT: effectiveDataRoot, URDIRA_SEMANTIC_INDEX: "0", URDIRA_ANALYSIS_WORKERS: "1", URDIRA_ANALYSIS_POOL_MAX: "1", URDIRA_STRUCTURAL_CONCURRENCY: "1", ...(arm === "urdira-typescript" ? { URDIRA_DEBUG_TIMING: "1", URDIRA_STORAGE_DEBUG_TIMING: "1" } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
  hostMetrics = startHostMetrics(host, effectiveDataRoot);
  host.stdout.on("data", (chunk) => appendFileSync(hostLog, chunk));
  host.stderr.pipe((await import("node:fs")).createWriteStream(hostLog));
  await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for Urdira host after ${benchmarkTimeoutMs}ms`)), benchmarkTimeoutMs);
    host.stdout.on("data", (chunk) => { buffer += chunk.toString(); if (buffer.includes("BENCH_HOST_READY")) { clearTimeout(timer); resolve(); } });
    host.on("error", reject);
    host.on("close", (code, signal) => { if (code !== 0 || signal !== null) { clearTimeout(timer); reject(new Error(`Urdira host exited before readiness (${code ?? "null"}/${signal ?? "none"})`)); } });
  });
}
const setupElapsedMs = Date.now() - setupStartedAt;

const codexArgs = ["-m", model, "-s", "danger-full-access", "-a", "never", "exec", "--json", "--ignore-user-config", "--skip-git-repo-check", "-C", worktree];
const addMcp = (args) => {
  if (arm === "urdira-typescript") {
    args.push("-c", `mcp_servers.urdira.command=${JSON.stringify(nodeBin)}`, "-c", `mcp_servers.urdira.args=[${JSON.stringify(join(root, "release/benchmarks/expanded-urdira-mcp-entry.mjs"))}]`, "-c", `mcp_servers.urdira.env.URDIRA_DATA_ROOT=${JSON.stringify(effectiveDataRoot)}`, "-c", "mcp_servers.urdira.startup_timeout_sec=120", "-c", "mcp_servers.urdira.tool_timeout_sec=300");
  } else if (arm === "codebase-memory") {
    args.push("-c", `mcp_servers.codebase-memory.command=${JSON.stringify(codebaseMemoryBin)}`, "-c", "mcp_servers.codebase-memory.startup_timeout_sec=120", "-c", "mcp_servers.codebase-memory.tool_timeout_sec=300");
  } else if (arm === "codegraph") {
    args.push("-c", `mcp_servers.codegraph.command=${JSON.stringify(codegraphBin)}`, "-c", `mcp_servers.codegraph.args=["serve","--mcp"]`, "-c", "mcp_servers.codegraph.startup_timeout_sec=120", "-c", "mcp_servers.codegraph.tool_timeout_sec=300");
  }
};
addMcp(codexArgs);
const firstInstructionMs = Date.now();
let first = await run(codex, [...codexArgs, "-"], { cwd: worktree, input: initialInstruction });
writeFileSync(transcript, first.stdout, "utf8");
let exitCode = first.code;
let sessionId;
let agentFinishedMs = Date.now();
const interTurnFreshnessWaitsMs = [];

// Edits are watcher-indexed asynchronously. A warm benchmark must not send
// the next instruction while Urdira is knowingly serving the previous
// structural snapshot: doing that forces the agent either to consume
// explicitly stale symbol evidence or to spend its measured turn waiting for
// the host to settle. Gate each resume on the same current structural frontier
// used before the first instruction, while retaining the wait duration in the
// manifest so the cost remains visible rather than disappearing from results.
const waitForCurrentStructuralFrontier = async (afterTurn) => {
  if (arm !== "urdira-typescript") return 0;
  const started = Date.now();
  const deadline = started + benchmarkTimeoutMs;
  const { DaemonClient, daemonPaths } = await import("../../packages/daemon/dist/index.js");
  const paths = await daemonPaths(effectiveDataRoot);
  const client = new DaemonClient(paths.endpoint, { request_timeout_ms: 60_000 });
  while (Date.now() < deadline) {
    const status = await client.call("core:index_status", { api_version: 3, workspace_ids: [] });
    if (status.outcome !== "success") throw new Error(`Urdira inter-turn freshness gate failed after turn ${afterTurn}: ${JSON.stringify(status)}`);
    const entry = status.payload?.workspaces?.find((candidate) => candidate.display_root === basename(worktree));
    if ([entry?.workspace_status, entry?.freshness_status, entry?.startup_phase].includes("failed")) {
      throw new Error(`Urdira inter-turn indexing failed after turn ${afterTurn}: ${JSON.stringify(entry)}`);
    }
    if (entry?.structural_ready === true && ["current", "equivalent"].includes(entry?.freshness_status)) {
      const elapsed = Date.now() - started;
      appendFileSync(hostLog, `BENCH_INTER_TURN_READY ${JSON.stringify({ after_turn: afterTurn, elapsed_ms: elapsed, workspace_id: entry.workspace_id })}\n`);
      return elapsed;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for Urdira current structural frontier after turn ${afterTurn}`);
};
if (first.code === 0) {
  interTurnFreshnessWaitsMs.push(await waitForCurrentStructuralFrontier(1));
  const firstEvents = first.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  sessionId = firstEvents.find((event) => event.type === "thread.started")?.thread_id;
  if (!sessionId) throw new Error("Codex transcript did not expose a resumable session id");
  const resume = ["-m", model, "-s", "danger-full-access", "-a", "never", "-C", worktree];
  addMcp(resume);
  resume.push("exec", "resume", sessionId, "--json", "--ignore-user-config", "--skip-git-repo-check");
  const second = await run(codex, [...resume, "-"], { cwd: worktree, input: followUpInstruction });
  appendFileSync(transcript, second.stdout, "utf8");
  exitCode = second.code;
  if (second.code === 0) {
    interTurnFreshnessWaitsMs.push(await waitForCurrentStructuralFrontier(2));
    const third = await run(codex, [...resume, "-"], { cwd: worktree, input: finalInstruction });
    appendFileSync(transcript, third.stdout, "utf8");
    exitCode = third.code;
  }
  agentFinishedMs = Date.now();
}
if (host) await stopHost(host);

const grade = await run(nodeBin, [join(root, "release/benchmarks/expanded-agent-benchmark-grader.mjs"), "--worktree", worktree, "--repository-id", repositoryId, "--task-id", taskId, "--arm", arm, "--transcript", transcript], { cwd: root });
let grader;
try { grader = JSON.parse(grade.stdout); } catch { grader = { completed_successfully: false, parse_error: grade.stdout.slice(-2000) }; }
const manifest = { run_id: runId, repository: repo.repository, repository_id: repositoryId, task_id: taskId, complexity: task.complexity, arm, phase, sample, model, commit, worktree, data_root: arm === "urdira-typescript" ? effectiveDataRoot : undefined, transcript, host_log: arm === "urdira-typescript" ? hostLog : undefined, host_metrics: arm === "urdira-typescript" ? hostMetrics : undefined, inter_turn_freshness_waits_ms: arm === "urdira-typescript" ? interTurnFreshnessWaitsMs : undefined, setup_started_at: new Date(setupStartedAt).toISOString(), first_instruction_sent_at: new Date(firstInstructionMs).toISOString(), finished_at: new Date(agentFinishedMs).toISOString(), setup_elapsed_ms: setupElapsedMs, elapsed_ms_from_first_instruction: agentFinishedMs - firstInstructionMs, outer_turns_requested: 3, exit_code: exitCode, grader_exit_code: grade.code, completed_successfully: exitCode === 0 && grade.code === 0 && grader.completed_successfully === true, setup, correctness: grader };
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify(manifest));
if (!manifest.completed_successfully) process.exitCode = 1;

async function prepareArm() {
  if (arm === "baseline") return { kind: "none", indexed: false };
  if (arm === "codegraph") {
    const started = Date.now();
    const result = await run(codegraphBin, ["init", worktree], { cwd: root, env: { ...process.env, CODEGRAPH_TELEMETRY: "0" } });
    if (result.code !== 0) throw new Error(`CodeGraph init failed: ${result.stderr}`);
    return { kind: "codegraph", indexed: true, elapsed_ms: Date.now() - started, output_tail: result.stdout.slice(-2000) };
  }
  if (arm === "codebase-memory") {
    const started = Date.now();
    const project = `${repositoryId}-${taskId}-${arm}-${sample}`;
    const result = await run(codebaseMemoryBin, ["cli", "index_repository", JSON.stringify({ repo_path: worktree, name: project, mode: "full", persistence: true })], { cwd: root });
    if (result.code !== 0) throw new Error(`codebase-memory index failed: ${result.stderr}`);
    return { kind: "codebase-memory", project, indexed: true, elapsed_ms: Date.now() - started, output_tail: result.stdout.slice(-3000) };
  }
  return { kind: "urdira-typescript", indexed: true, semantic_index: false, reconciliation_sweep_interval_ms: 0, readiness: phase };
}

function startHostMetrics(child, dataRoot) {
  const state = { peak_rss_kib: 0, cpu_percent_samples: [], sample_count: 0, started_at: Date.now(), sqlite_bytes: 0, cas_bytes: 0, bytes_copied: null, bytes_transferred: null, bytes_decoded: null, readiness_events: [], ready_elapsed_ms: null, memory_budget_kib: benchmarkMaxRssKib, memory_budget_exceeded: false, memory_budget_exceeded_at: null };
  let pending = "";
  child.stdout.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const marker = line.match(/BENCH_(?:FRONTIER|HOST_READY) (\{.*\})\s*$/u);
      if (!marker) continue;
      try {
        const payload = JSON.parse(marker[1]);
        if (line.includes("BENCH_HOST_READY")) state.ready_elapsed_ms = Number(payload.elapsed_ms ?? (Date.now() - state.started_at));
        if (line.includes("BENCH_FRONTIER")) state.readiness_events.push(payload);
      } catch { /* retain process metrics even if a diagnostic line is malformed */ }
    }
  });
  const sample = () => {
    if (child.pid === undefined) return;
    const ps = spawnSync("ps", ["-o", "rss=,pcpu=", "-p", String(child.pid)], { encoding: "utf8" });
    const fields = (ps.stdout ?? "").trim().split(/\s+/u);
    const rss = Number(fields[0]);
    const cpu = Number(fields[1]);
    if (Number.isFinite(rss)) {
      state.peak_rss_kib = Math.max(state.peak_rss_kib, rss);
      if (rss >= benchmarkMaxRssKib && !state.memory_budget_exceeded) {
        state.memory_budget_exceeded = true;
        state.memory_budget_exceeded_at = Date.now();
        child.kill("SIGTERM");
      }
    }
    if (Number.isFinite(cpu)) state.cpu_percent_samples.push(cpu);
    state.sample_count += 1;
  };
  const timer = setInterval(sample, 500);
  return { state, timer, dataRoot };
}

function finalizeHostMetrics() {
  if (hostMetrics === undefined) return undefined;
  if (!hostMetrics.state) return hostMetrics;
  clearInterval(hostMetrics.timer);
  hostMetrics.state.sqlite_bytes = directoryBytes(hostMetrics.dataRoot, (path) => /\.sqlite(?:-|$)/u.test(path));
  hostMetrics.state.cas_bytes = directoryBytes(join(hostMetrics.dataRoot, "cas"));
  const cpu = hostMetrics.state.cpu_percent_samples;
  const result = {
    peak_rss_kib: hostMetrics.state.peak_rss_kib,
    memory_budget_kib: hostMetrics.state.memory_budget_kib,
    memory_budget_exceeded: hostMetrics.state.memory_budget_exceeded,
    memory_budget_exceeded_at: hostMetrics.state.memory_budget_exceeded_at,
    mean_cpu_percent: cpu.length === 0 ? null : cpu.reduce((sum, value) => sum + value, 0) / cpu.length,
    sample_count: hostMetrics.state.sample_count,
    duration_ms: Date.now() - hostMetrics.state.started_at,
    sqlite_bytes: hostMetrics.state.sqlite_bytes,
    cas_bytes: hostMetrics.state.cas_bytes,
    bytes_copied: hostMetrics.state.bytes_copied,
    bytes_transferred: hostMetrics.state.bytes_transferred,
    bytes_decoded: hostMetrics.state.bytes_decoded,
    ready_elapsed_ms: hostMetrics.state.ready_elapsed_ms,
    readiness_events: hostMetrics.state.readiness_events,
  };
  hostMetrics = result;
  return result;
}

async function stopHost(currentHost) {
  finalizeHostMetrics();
  const closed = new Promise((resolve) => currentHost.once("close", resolve));
  currentHost.kill("SIGTERM");
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (currentHost.exitCode === null && currentHost.signalCode === null) currentHost.kill("SIGKILL");
}

function directoryBytes(rootPath, predicate = () => true) {
  try {
    const visit = (path) => {
      const stat = statSync(path);
      if (stat.isFile()) return predicate(path) ? stat.size : 0;
      if (!stat.isDirectory()) return 0;
      return readdirSync(path, { withFileTypes: true }).reduce((total, entry) => total + visit(join(path, entry.name)), 0);
    };
    return visit(rootPath);
  } catch { return 0; }
}

async function hostMain() {
  process.env.URDIRA_DATA_ROOT = dataRoot;
  const hostStartedAt = Date.now();
  const { defaultDaemonOptions } = await import("../../apps/urdira/dist/index.js");
  const { DaemonRuntime, DaemonClient } = await import("../../packages/daemon/dist/index.js");
  // A benchmark cell owns one frozen worktree and records every agent edit
  // through the live watcher. The production five-minute reconciliation
  // backstop is therefore redundant here, and on repositories whose initial
  // structural publication itself takes >5 minutes its next tick can start a
  // full no-change scan in the middle of the measured agent turn. Disable the
  // sweep for this isolated host so only actual watcher events enter the
  // sample; production defaults remain unchanged.
  const runtime = await DaemonRuntime.start({ ...(await defaultDaemonOptions(dataRoot)), data_root: dataRoot, semantic_index: false, semantic_descriptor: undefined, reconciliation_sweep_interval_ms: 0 });
  const client = new DaemonClient(runtime.endpoint, { request_timeout_ms: benchmarkTimeoutMs });
  const registration = await client.call("core:workspace_add", { args: [worktree], confirmed: true, selected_technology_ids: ["javascript", "typescript"], selected_plugin_ids: ["urdira:javascript_typescript"] });
  if (registration.outcome !== "success") throw new Error(`workspace registration failed: ${JSON.stringify(registration)}`);
  const deadline = Date.now() + benchmarkTimeoutMs;
  let ready = false;
  let previousFrontier;
  let sourceReadySinceTs;
  while (Date.now() < deadline) {
    const status = await client.call("core:index_status", { api_version: 3, workspace_ids: [] });
    const entry = status.payload?.workspaces?.find((candidate) => candidate.display_root === worktree.split("/").at(-1));
    if ([entry?.workspace_status, entry?.freshness_status, entry?.startup_phase].includes("failed")) {
      throw new Error(`Urdira structural indexing failed: ${JSON.stringify(entry)}`);
    }
    const frontier = {
      elapsed_ms: Date.now() - hostStartedAt,
      source_ready: entry?.source_ready === true,
      syntax_ready: entry?.syntax_ready === true,
      structural_ready: entry?.structural_ready === true,
      semantic_ready: entry?.semantic_ready === true,
      structural_stage_ordinal: Number(entry?.structural_stage_ordinal ?? 0),
      structural_completeness: entry?.structural_completeness ?? null,
      structural_availability: entry?.structural_availability ?? null,
      source_completeness: entry?.source_completeness ?? null,
      freshness_status: entry?.freshness_status ?? null,
      workspace_status: entry?.workspace_status ?? null,
      startup_phase: entry?.startup_phase ?? null,
    };
    const frontierKey = JSON.stringify({ ...frontier, elapsed_ms: undefined });
    if (frontierKey !== previousFrontier) {
      previousFrontier = frontierKey;
      process.stdout.write(`BENCH_FRONTIER ${JSON.stringify(frontier)}\n`);
    }
    // Preserve the campaign's phase contract. A `warm` sample starts only
    // after the complete structural snapshot is current/equivalent; releasing
    // at the first transient source frontier moves indexing work into the
    // measured agent turn. Do not change this gate -- it is what keeps warm
    // runs comparable across campaigns.
    const warmReady = entry?.structural_ready === true && ["current", "equivalent"].includes(entry?.freshness_status);
    // Non-warm ("cold") phases used to release at the very first
    // `source_ready` poll and then re-derive their own defensive
    // "durable source frontier" language here, because `source_ready` could
    // flap true/false while the daemon's readiness reads raced its own
    // in-flight publish writes. That race is now fixed at the root (readiness
    // reads are read-only against the WAL snapshot instead of racing the
    // writer), and `core:index_status`/query results are honestly labeled
    // `source_completeness: "partial"` while the source catalog is still
    // settling rather than silently claiming completeness. Cold release
    // still waits for `source_ready` to hold across two consecutive polls
    // (>=1000ms apart, given the 500ms poll cadence below) purely as cheap
    // insurance against ordinary poll-timing jitter, not because the
    // frontier itself is distrusted.
    const sourceReadyNow = entry?.source_ready === true && entry?.freshness_status !== "failed";
    sourceReadySinceTs = sourceReadyNow ? (sourceReadySinceTs ?? Date.now()) : undefined;
    const sourceReadyStable = sourceReadySinceTs !== undefined && Date.now() - sourceReadySinceTs >= 1000;
    if (phase === "warm" ? warmReady : sourceReadyStable) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error(`Timed out waiting for the Urdira ${phase === "warm" ? "current structural" : "source_ready"} frontier`);
  process.stdout.write(`BENCH_HOST_READY ${JSON.stringify({ workspace: worktree, repository: repositoryId, elapsed_ms: Date.now() - hostStartedAt })}\n`);
  const stop = async () => {
    process.stdout.write(`[urdira] byte telemetry ${JSON.stringify(runtime.byteTelemetrySnapshot())}\n`);
    await runtime.stop({ force: false });
    process.exit(0);
  };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}
