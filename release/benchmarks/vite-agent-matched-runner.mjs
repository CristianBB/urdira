#!/usr/bin/env node
/* global URL, setTimeout, clearTimeout, setInterval */
/* Matched three-arm, three-iteration campaign driver for frozen Vite runs. */
import { appendFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const argv = process.argv.slice(2);
const value = (name, fallback) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };
const has = (name) => argv.includes(name);
const arm = value("--arm");
const task = value("--task", "server-request");
const phase = value("--phase", "cold");
const sample = Number(value("--sample", "1"));
const repositoryRoot = resolve(value("--repository-root", process.env.VITE_BENCHMARK_REPOSITORY ?? join(root, "..", "urdira-benchmark", "vite")));
const dependenciesRoot = resolve(value("--dependencies-root", repositoryRoot));
const worktree = resolve(value("--worktree", join(tmpdir(), `vite-agent-${arm}-${phase}-${sample}`)));
const outputDir = resolve(value("--output-dir", join(root, "release/benchmarks/results")));
const dataRoot = resolve(value("--data-root", join(tmpdir(), `urdira-vite-${arm}-${phase}-${sample}`)));
const commit = value("--commit", "c0f2fc607ee97ee4499337b04826420c00654065");
const model = value("--model", "gpt-5.6-luna");
const codex = value("--codex", process.env.CODEX_BIN ?? "codex");
const nodeBin = value("--node", process.execPath);
const memoryBin = value("--codebase-memory", process.env.CODEBASE_MEMORY_BIN ?? "codebase-memory-mcp");
const mcpEntry = value("--mcp-entry", join(root, "release/benchmarks/vite-mcp-entry.mjs"));
const timeoutMs = Number(process.env.VITE_BENCHMARK_TIMEOUT_MS ?? "900000");
if (!["baseline", "codebase-memory", "urdira"].includes(arm)) throw new Error("--arm must be baseline|codebase-memory|urdira");
if (!["server-request", "lifecycle-map"].includes(task)) throw new Error("--task must be server-request|lifecycle-map");
if (!["cold", "warm"].includes(phase)) throw new Error("--phase must be cold|warm");
if (!Number.isSafeInteger(sample) || sample < 1) throw new Error("--sample must be a positive integer");
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000) throw new Error("VITE_BENCHMARK_TIMEOUT_MS must be at least 30000");

const run = (command, args, options = {}) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  let timedOut = false;
  let forceTimer;
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; child.kill("SIGTERM"); forceTimer = setTimeout(() => child.kill("SIGKILL"), 10_000); }, options.timeoutMs);
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  if (options.input !== undefined) child.stdin.end(options.input); else child.stdin.end();
  child.on("error", reject);
  child.on("close", (code, signal) => { if (timer !== undefined) clearTimeout(timer); if (forceTimer !== undefined) clearTimeout(forceTimer); resolvePromise({ code: timedOut ? 124 : code ?? 1, signal, stdout, stderr, timed_out: timedOut }); });
});
const git = async (...args) => {
  const result = await run("git", args, { cwd: worktree });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
};
const gitRepo = async (...args) => {
  const result = await run("git", args, { cwd: repositoryRoot });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
};

async function assertRuntime() {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && (minor < 18 || (minor === 18 && patch < 1)))) throw new Error(`Node >=24.18.1 is required; found ${process.version}`);
  const codexCheck = await run(codex, ["--version"], { timeoutMs: 10_000 });
  if (codexCheck.code !== 0) throw new Error(`Codex executable is unavailable: ${codex}`);
  if (!existsSync(join(repositoryRoot, ".git"))) throw new Error(`Benchmark repository is unavailable: ${repositoryRoot}`);
  if ((await gitRepo("rev-parse", "--verify", `${commit}^{commit}`)) === "") throw new Error(`Frozen commit is unavailable: ${commit}`);
  if (arm === "urdira" && (!existsSync(join(root, "apps/urdira/dist/index.js")) || !existsSync(join(root, "packages/plugin-javascript-typescript/dist/index.js")))) throw new Error("Built Urdira artifacts are required for the Urdira arm.");
  if (arm === "codebase-memory") {
    const memoryCheck = await run(memoryBin, ["--help"], { timeoutMs: 10_000 });
    if (memoryCheck.code !== 0) throw new Error(`codebase-memory executable is unavailable: ${memoryBin}`);
  }
}

const runId = `vite-${arm}-${phase}-${sample}`;
const transcript = join(outputDir, `${runId}.jsonl`);
const manifestPath = join(outputDir, `${runId}.json`);
const hostLog = join(outputDir, `${runId}.host.log`);
mkdirSync(outputDir, { recursive: true });

const resetFixture = async () => {
  await git("reset", "--hard", commit);
  await git("clean", "-fd");
};

const prepareDependencies = () => {
  const source = join(dependenciesRoot, "node_modules");
  const target = join(worktree, "node_modules");
  const packageSource = join(dependenciesRoot, "packages", "vite", "node_modules");
  const packageTarget = join(worktree, "packages", "vite", "node_modules");
  const distSource = join(dependenciesRoot, "packages", "vite", "dist");
  const distTarget = join(worktree, "packages", "vite", "dist");
  if (!existsSync(source)) throw new Error(`Shared Vite dependencies are unavailable: ${source}`);
  if (!existsSync(packageSource)) throw new Error(`Shared Vite package dependencies are unavailable: ${packageSource}`);
  if (!existsSync(distSource)) throw new Error(`Built Vite package output is unavailable: ${distSource}`);
  if (!existsSync(target)) symlinkSync(source, target, "dir");
  if (!existsSync(packageTarget)) symlinkSync(packageSource, packageTarget, "dir");
  if (!existsSync(distTarget)) symlinkSync(distSource, distTarget, "dir");
};

async function prepareCodebaseMemory() {
  if (arm !== "codebase-memory" || phase !== "warm") return;
  const result = await run(memoryBin, ["cli", "index_repository", JSON.stringify({ repo_path: worktree, name: runId, mode: "moderate", persistence: false })], { cwd: worktree, timeoutMs });
  if (result.code !== 0) throw new Error(`codebase-memory warm index failed: ${result.stderr}`);
}

let host;
async function prepareUrdira() {
  if (arm !== "urdira") return;
  host = spawn(nodeBin, [fileURLToPath(import.meta.url), "--host", "--arm", "urdira", "--phase", phase, "--worktree", worktree, "--data-root", dataRoot], { cwd: root, env: { ...process.env, URDIRA_DATA_ROOT: dataRoot, URDIRA_SEMANTIC_INDEX: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  host.stderr.pipe((await import("node:fs")).createWriteStream(hostLog));
  await new Promise((resolvePromise, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for Urdira host after ${timeoutMs}ms`)), timeoutMs);
    host.stdout.on("data", (chunk) => { buffer += chunk.toString(); if (buffer.includes("BENCH_HOST_READY")) { clearTimeout(timer); resolvePromise(); } });
    host.on("error", reject);
    host.on("close", (code) => { if (code !== 0) { clearTimeout(timer); reject(new Error(`Urdira host exited before readiness (${code})`)); } });
  });
}
const stopHost = async () => {
  if (!host) return;
  const current = host; host = undefined;
  const closed = new Promise((resolvePromise) => current.once("close", resolvePromise));
  current.kill("SIGTERM");
  await Promise.race([closed, new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000))]);
  if (current.exitCode === null && current.signalCode === null) current.kill("SIGKILL");
};

const policy = arm === "baseline"
  ? "Use only ordinary shell/editor tools. Do not use Urdira, codebase-memory, a symbol server, or any other code-intelligence MCP."
  : arm === "codebase-memory"
    ? `${phase === "cold" ? "In iteration 1, first call index_repository for this worktree (moderate mode), then" : "In each iteration, call detect_changes for this worktree, then"} use the local codebase-memory MCP for repository discovery with search_graph/get_code_snippet/trace_path as needed. Do not use Urdira.`
    : "Use the Urdira MCP for explicit workspace-scoped discovery. In each iteration call urdira_benchmark_discover exactly once with the worktree root and one relevant path, then use the returned evidence. Do not use grep/glob for code discovery.";
const taskText = task === "lifecycle-map"
  ? {
    initial: `Task: produce a cross-cutting plugin lifecycle map and migration plan for the Vite monorepo; do not change production code. The deliverable is docs/reports/2026-08-19-vite-plugin-lifecycle-map.md. It must inventory the public plugin contract, hook ordering/dispatch, direct callers and consumers across packages/vite/src, relevant tests and API documentation, and cite exact file paths with line numbers. The plan should identify the safest insertion points for a hypothetical new plugin lifecycle event, affected callers, compatibility risks, and staged validation steps.\n\nIteration 1: discover the plugin contract, lifecycle dispatch, and the central symbols that connect them. Start the report with a precise scope and an evidence table. Do not install dependencies, edit source code, or commit.`,
    second: `Iteration 2: broaden the inventory across the monorepo. Trace all important inbound/outbound paths and consumers of the selected plugin lifecycle symbols, including build/serve/preview or test paths where relevant. Add a caller/consumer matrix, ordering invariants, and identify omissions or false leads. Keep the report evidence-based with file:line references. Do not edit production code, install dependencies, or commit.`,
    third: `Iteration 3: validate the report against the final tree and complete the migration plan. Add affected test files, public docs, compatibility risks, an ordered implementation plan, and explicit verification commands. Ensure the report is self-contained, concise, and distinguishes verified evidence from recommendations. Do not edit production code, install dependencies, or commit.`,
  }
  : {
    initial: `Task: implement an opt-in serverRequest plugin hook for Vite's development server. It reports method, URL, final status, duration, and aborted state exactly once for finish/close, isolates callback errors, preserves middleware mode and restart behavior, and adds public types, tests, and concise docs across later iterations.\n\nIteration 1: trace plugin hook sorting and the dev-server middleware lifecycle, add the public type and the smallest opt-in dispatch path, and cover a successful response. Do not install dependencies, run the full suite, or commit.`,
    second: `Iteration 2: re-discover the changed symbols, complete finish/close/error finalization with exactly one callback per request, preserve method/URL/status, cover middleware mode and server restart/no-duplicate behavior, and add focused tests. Keep callback failures out of the response pipeline. Do not install dependencies or commit.`,
    third: `Iteration 3: review the final diff for public-contract and compatibility drift, add concise plugin API documentation, run the narrowest relevant Vite tests and typecheck available without installing dependencies, and report exact commands/results plus any blocker. Do not commit.`,
  };
const initial = `You are working in the frozen Vite monorepo at commit ${commit}. Complete iteration 1 of the benchmark task in ${worktree}.\n\n${taskText.initial}\n\n${policy}\n\nSummarize the work and stop for the next instruction.`;
const second = `Continue the same Vite task after iteration 1. ${policy}\n\n${taskText.second}\n\nSummarize changed files and stop.`;
const third = `Continue the same Vite task after iteration 2. ${policy}\n\n${taskText.third}`;

function codexArgs(resume = false, sessionId = undefined) {
  const args = ["-m", model, "-s", "danger-full-access", "-a", "never"];
  if (!resume) args.push("exec", "--json", "--ignore-user-config", "--skip-git-repo-check", "-C", worktree);
  else args.push("-C", worktree);
  if (arm === "urdira") args.push("-c", `mcp_servers.urdira.command=${JSON.stringify(nodeBin)}`, "-c", `mcp_servers.urdira.args=[${JSON.stringify(mcpEntry)}]`, "-c", `mcp_servers.urdira.env.URDIRA_DATA_ROOT=${JSON.stringify(dataRoot)}`, "-c", "mcp_servers.urdira.startup_timeout_sec=120", "-c", "mcp_servers.urdira.tool_timeout_sec=900");
  if (arm === "codebase-memory") args.push("-c", `mcp_servers.codebase_memory.command=${JSON.stringify(memoryBin)}`, "-c", "mcp_servers.codebase_memory.args=[]", "-c", "mcp_servers.codebase_memory.startup_timeout_sec=120", "-c", "mcp_servers.codebase_memory.tool_timeout_sec=900");
  if (resume) args.push("exec", "resume", sessionId, "--json", "--ignore-user-config", "--skip-git-repo-check");
  return args;
}

async function hostMain() {
  process.env.URDIRA_DATA_ROOT = dataRoot;
  const { defaultDaemonOptions } = await import("../../apps/urdira/dist/index.js");
  const { DaemonRuntime, DaemonClient } = await import("../../packages/daemon/dist/index.js");
  const runtime = await DaemonRuntime.start({ ...(await defaultDaemonOptions()), semantic_index: false, semantic_descriptor: undefined });
  const client = new DaemonClient(runtime.endpoint, { request_timeout_ms: timeoutMs });
  const registration = await client.call("core:workspace_add", { args: [worktree], confirmed: true, selected_technology_ids: ["javascript", "typescript"], selected_plugin_ids: ["urdira:javascript_typescript"] });
  if (registration.outcome !== "success") throw new Error(`workspace registration failed: ${JSON.stringify(registration)}`);
  if (phase === "warm") {
    const deadline = Date.now() + timeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      const status = await client.call("core:index_status", { api_version: 3, workspace_ids: [] });
      const workspace = status.payload?.workspaces?.find((entry) => entry.display_root === worktree.split("/").at(-1));
      if (workspace?.structural_ready === true && ["current", "equivalent"].includes(workspace.freshness_status)) { ready = true; break; }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    if (!ready) throw new Error(`Timed out waiting for current structural Vite index after ${timeoutMs}ms`);
  }
  process.stdout.write(`BENCH_HOST_READY ${JSON.stringify({ phase, worktree })}\n`);
  const stop = async () => { await runtime.stop({ force: false }); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}

if (has("--host")) { await hostMain(); }
await assertRuntime();
const setupStarted = Date.now();
await resetFixture();
prepareDependencies();
await prepareCodebaseMemory();
await prepareUrdira();
const firstInstructionSent = Date.now();
const first = await run(codex, codexArgs(), { cwd: worktree, input: initial, timeoutMs });
writeFileSync(transcript, first.stdout, "utf8");
if (first.code !== 0) { await stopHost(); throw new Error(`Iteration 1 failed (${first.code}): ${first.stderr}`); }
const sessionId = first.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((event) => event.type === "thread.started")?.thread_id;
if (!sessionId) { await stopHost(); throw new Error("Codex transcript did not expose a resumable session id."); }
let finished = firstInstructionSent;
try {
  for (const instruction of [second, third]) {
    const response = await run(codex, codexArgs(true, sessionId), { cwd: worktree, input: instruction, timeoutMs });
    appendFileSync(transcript, response.stdout);
    if (response.code !== 0) throw new Error(`Follow-up iteration failed (${response.code}): ${response.stderr}`);
    finished = Date.now();
  }
} finally { await stopHost(); }
const grade = await run(nodeBin, [join(root, "release/benchmarks/vite-agent-benchmark-grader.mjs"), "--task", task, "--worktree", worktree], { cwd: root });
let grader;
try { grader = JSON.parse(grade.stdout); } catch { grader = { completed_successfully: false, parse_error: grade.stdout.slice(-2000) }; }
const manifest = { run_id: runId, task, arm, phase, sample, model, repository: "vitejs/vite", commit, worktree, transcript, host_log: arm === "urdira" ? hostLog : undefined, setup_elapsed_ms: firstInstructionSent - setupStarted, elapsed_ms_from_first_instruction: finished - firstInstructionSent, grader, exit_code: grade.code === 0 ? 0 : 1 };
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify(manifest));
if (grade.code !== 0) process.exitCode = 1;
