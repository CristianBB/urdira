#!/usr/bin/env node
/* global URL, setTimeout, clearTimeout, setInterval, clearInterval */
/* One isolated repository/task/arm run for the expanded benchmark. */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { inspectAgentValidationEnvironment, isCurrentStructuralFrontier } from "./agent-validation-environment.mjs";
import { createTimingCapture, summarizeTimingCaptures } from "./expanded-agent-timing.mjs";
import { findWorkerStartupAttestation } from "./urdira-worker-attestation.mjs";
import { writeUrdiraIsolatedShim } from "./urdira-isolated-shim.mjs";
import { retainCodexHostSessions } from "./codex-host-evidence.mjs";

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
const tgrepBin = value("--tgrep");
const indexingWorkerBin = value("--indexing-worker", process.env.URDIRA_INDEXING_CORE_WORKER_PATH ?? join(root, "target", "release", process.platform === "win32" ? "urdira-indexing-worker.exe" : "urdira-indexing-worker"));
const benchmarkTimeoutMs = Number(process.env.URDIRA_BENCHMARK_TIMEOUT_MS ?? "900000");
// The benchmark disables the daemon's periodic sweep so it cannot add
// background rescans to an otherwise idle incremental sample. After each
// agent turn, waitForCurrentStructuralFrontier issues one explicit
// `core:reindex` request with `scope: reconcile`; that deterministic frontier
// trigger is timed and retained in the manifest/host log.
const RECONCILIATION_SWEEP_INTERVAL_MS = 0;
const repo = corpus.repositories.find((entry) => entry.id === repositoryId);
const task = repo?.tasks.find((entry) => entry.id === taskId);
if (!repo || !task || !["baseline", "urdira-typescript", "codebase-memory", "codegraph", "tgrep"].includes(arm)) throw new Error("Invalid repository, task, or arm");
const preflightOnly = argv.includes("--preflight-only");
if ((!preflightOnly && (!worktree || !commit)) || !Number.isSafeInteger(sample) || sample < 1) throw new Error("--worktree, --commit, and a positive --sample are required");
if (!Number.isSafeInteger(benchmarkTimeoutMs) || benchmarkTimeoutMs < 1_000) throw new Error("URDIRA_BENCHMARK_TIMEOUT_MS must be an integer of at least 1000ms");

function validateRuntimePreflight() {
  const version = spawnSync(nodeBin, ["--version"], { encoding: "utf8" });
  if (version.status !== 0) throw new Error(`Urdira benchmark preflight: unable to execute ${nodeBin}: ${version.stderr}`);
  const match = /^v(\d+)\.(\d+)\.(\d+)/u.exec((version.stdout ?? "").trim());
  const major = Number(match?.[1]); const minor = Number(match?.[2]); const patch = Number(match?.[3]);
  if (!match || major < 24 || (major === 24 && (minor < 18 || minor === 18 && patch < 1))) throw new Error(`Urdira benchmark preflight: Node >=24.18.1 is required, found ${(version.stdout ?? "").trim()}.`);
  if (!model || model.trim().length === 0) throw new Error("Urdira benchmark preflight: --model must be non-empty.");
  for (const requiredPath of ["pnpm-lock.yaml", "packages/plugin-javascript-typescript/package.json", "packages/mcp/dist/index.js", "packages/cli/dist/agent-integration.js", "apps/urdira/dist/cli.js", "apps/urdira/package.json"]) {
    if (!existsSync(join(root, requiredPath))) throw new Error(`Urdira benchmark preflight: required project artifact is missing: ${requiredPath}`);
  }
  if (arm === "urdira-typescript" && !existsSync(indexingWorkerBin)) throw new Error(`Urdira benchmark preflight: indexing worker is missing: ${indexingWorkerBin}`);
  return { node: (version.stdout ?? "").trim(), model, ...(arm === "urdira-typescript" ? { indexing_worker: indexingWorkerBin } : {}), lockfile: join(root, "pnpm-lock.yaml"), plugin: "urdira:javascript_typescript", dist: join(root, "packages/mcp/dist/index.js") };
}

const preflight = validateRuntimePreflight();

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
const hookAuditPath = join(outputDir, `${runId}.hook-audit.jsonl`);
const timingSidecar = join(outputDir, `${runId}.timing.json`);
const manifestPath = join(outputDir, `${runId}.json`);
const hostLog = join(outputDir, `${runId}.host.log`);
const semanticPerfRequested = arm === "urdira-typescript" && process.env.URDIRA_V4_DEBUG_SEMANTIC_PERF === "1";
let semanticPerfAttestation = null;
const codexTimingCaptures = [];
const timingSummary = () => summarizeTimingCaptures(codexTimingCaptures);
const writeTimingSidecar = () => writeFileSync(timingSidecar, `${JSON.stringify(timingSummary(), null, 2)}\n`, "utf8");
writeTimingSidecar();
const setupStartedAt = Date.now();
let codexIntegrationHome;
let codexIntegration;
let hostSessionEvidence;
const cleanupCodexIntegration = () => {
  if (codexIntegrationHome !== undefined && existsSync(codexIntegrationHome)) {
    hostSessionEvidence = retainCodexHostSessions(codexIntegrationHome, join(outputDir, `${runId}.host-sessions`));
    rmSync(codexIntegrationHome, { recursive: true, force: true });
  }
};
const recordFailure = (reason) => {
  const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  try {
    cleanupCodexIntegration();
    writeFileSync(manifestPath, `${JSON.stringify({ run_id: runId, repository: repo.repository, repository_id: repositoryId, task_id: taskId, arm, phase, sample, model, commit, worktree, timing_sidecar: timingSidecar, timing_metrics: timingSummary(), host_session_evidence: hostSessionEvidence, ...(codexIntegration === undefined ? {} : { agent_integration: { ...codexIntegration, cleaned_up: true } }), ...(arm === "urdira-typescript" ? { data_root: effectiveDataRoot, host_log: hostLog, hook_audit_path: hookAuditPath, host_metrics: finalizeHostMetrics() } : {}), setup_started_at: new Date().toISOString(), completed_successfully: false, failure_stage: argv.includes("--host") ? "urdira_host" : "runner", error: message }, null, 2)}\n`, "utf8");
  } catch { /* retain the original failure when the output directory is unavailable */ }
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
process.on("uncaughtException", recordFailure);
process.on("unhandledRejection", recordFailure);

async function waitForSemanticPerfAttestation() {
  const deadline = Date.now() + benchmarkTimeoutMs;
  let stderrTail = "";
  while (Date.now() < deadline) {
    try {
      const stderr = readFileSync(hostLog, "utf8");
      stderrTail = stderr.slice(-2000);
      const attestation = findWorkerStartupAttestation(stderr);
      if (attestation !== null) {
        if (attestation.semantic_perf_enabled !== true) {
          throw new Error(`Urdira worker semantic perf attestation disabled: ${JSON.stringify(attestation)}`);
        }
        return attestation;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("attestation disabled")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Urdira worker startup attestation missing before profiled metrics acceptance; semantic_perf_enabled=true was requested. stderr_tail=${stderrTail}`);
}

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  const timingCapture = options.timing_label === undefined ? null : createTimingCapture({ label: options.timing_label });
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); timingCapture?.ingest(chunk); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  if (options.input !== undefined) child.stdin.end(options.input); else child.stdin.end();
  child.on("error", reject);
  child.on("close", (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr, timing: timingCapture?.finish() }));
});
const git = async (...args) => {
  const result = await run("git", args, { cwd: worktree });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
};

if (argv.includes("--host")) await hostMain();

await git("reset", "--hard", commit);
// Preserve caller-provided dependency trees while removing generated source
// output. The validation preflight below runs after this reset so it checks
// the exact worktree that will be handed to the model.
await git("clean", "-fd", "-e", "node_modules", "-e", "**/node_modules");
// The internal host process only owns indexing and never executes repository
// tests. Dependency readiness belongs to the outer agent cell; applying it to
// `--host` prevents isolated prompt-hook probes after dependency cleanup.
if (worktree && !argv.includes("--host")) {
  const validation = inspectAgentValidationEnvironment(worktree, (task.required_patterns ?? []).map((entry) => entry.path), process.env.SHELL ?? "/bin/sh", nodeBin);
  preflight.validation_environment = validation;
  if (!validation.ready) {
    mkdirSync(outputDir, { recursive: true });
    const failurePath = join(outputDir, `${repositoryId}-${taskId}-${arm}-${sample}.preflight-failure.json`);
    writeFileSync(failurePath, `${JSON.stringify({ ok: false, repository_id: repositoryId, task_id: taskId, arm, commit, worktree, model_invoked: false, validation_environment: validation }, null, 2)}\n`, { flag: "wx" });
    throw new Error(`Agent validation prerequisites failed; model was not invoked. Evidence: ${failurePath}`);
  }
}
const setup = await prepareArm();
if (arm === "urdira-typescript") {
  codexIntegrationHome = mkdtempSync(join("/tmp", "urdira-expanded-codex-home-"));
  const urdiraBinDir = join(codexIntegrationHome, "bin");
  const shellRuntimeProfile = join(codexIntegrationHome, ".zprofile");
  // Login shells read this after inheriting the benchmark environment. Keep
  // the isolated shim ahead of the native closure: that directory also owns a
  // release launcher named `urdira`, but it is not itself an extracted release
  // root and cannot locate runtime/node when executed directly.
  writeFileSync(shellRuntimeProfile, `export PATH=${JSON.stringify(urdiraBinDir)}:${JSON.stringify(dirname(nodeBin))}:$PATH\n`, { encoding: "utf8", mode: 0o600 });
  const isolatedShellRuntime = spawnSync("/bin/zsh", ["-lc", "node --version"], {
    cwd: worktree,
    encoding: "utf8",
    env: { ...process.env, HOME: codexIntegrationHome, ZDOTDIR: codexIntegrationHome, PATH: `${dirname(nodeBin)}:${process.env.PATH ?? ""}` },
  });
  const isolatedShellVersion = String(isolatedShellRuntime.stdout ?? "").trim();
  if (isolatedShellRuntime.status !== 0 || isolatedShellVersion !== preflight.node) {
    throw new Error(`Urdira benchmark preflight: isolated shell resolved ${isolatedShellVersion || "no Node runtime"}; expected ${preflight.node}. ${String(isolatedShellRuntime.stderr ?? "").trim()}`);
  }
  const urdiraCliPath = join(root, "apps/urdira/dist/cli.js");
  const urdiraCliVersion = JSON.parse(readFileSync(join(root, "apps/urdira/package.json"), "utf8")).version;
  const urdiraShimPath = join(urdiraBinDir, "urdira");
  const urdiraEndpoint = join(effectiveDataRoot, "daemon.sock");
  mkdirSync(urdiraBinDir, { recursive: true });
  writeUrdiraIsolatedShim(urdiraShimPath, { node: nodeBin, cli: urdiraCliPath, dataRoot: effectiveDataRoot, worker: indexingWorkerBin, endpoint: urdiraEndpoint });
  const shimVersion = spawnSync(urdiraShimPath, ["--version"], { encoding: "utf8", env: { ...process.env, URDIRA_DATA_ROOT: effectiveDataRoot, URDIRA_ENDPOINT: urdiraEndpoint, URDIRA_INDEXING_CORE_WORKER_PATH: indexingWorkerBin } });
  if (shimVersion.status !== 0) throw new Error(`isolated urdira --version failed: ${shimVersion.stderr}`);
  const cliFingerprint = createHash("sha256").update(readFileSync(urdiraCliPath)).digest("hex");
  const { installAgent } = await import("../../packages/cli/dist/agent-integration.js");
  const installed = await installAgent("codex", { dry_run: false, confirm: true, home: codexIntegrationHome, launcher: [urdiraShimPath] });
  const userAuthPath = join(homedir(), ".codex", "auth.json");
  const isolatedAuthPath = join(codexIntegrationHome, ".codex", "auth.json");
  let authMode = "external-or-missing";
  if (existsSync(userAuthPath)) {
    // Keep authentication available without copying credentials into the
    // disposable configuration root or changing the user's Codex directory.
    symlinkSync(userAuthPath, isolatedAuthPath);
    authMode = "user-auth-symlink";
  }
  codexIntegration = {
    mode: "installed-integration",
    client: "codex",
    home: codexIntegrationHome,
    files: installed.files,
    changed: installed.changed,
    mcp: "hook-first-cli-continuations",
    ignore_user_config: false,
    hook_trust: "dangerously-bypass-hook-trust",
    auth: authMode,
    executable: urdiraShimPath,
    executable_version: String(shimVersion.stdout ?? "").trim(),
    cli_version: urdiraCliVersion,
    cli_sha256: cliFingerprint,
    path_prepend: urdiraBinDir,
    endpoint: urdiraEndpoint,
    shell_runtime_profile: shellRuntimeProfile,
    shell_runtime_version: isolatedShellVersion,
  };
}

const initialInstruction = `You are working in the frozen ${repo.repository} checkout at commit ${commit}, in ${worktree}. This is an authorized internal benchmark change; treat it as an accepted maintenance/API task and do not pause to request repository-maintainer confirmation. Complete the first implementation phase of this coding task:

${task.prompt}

Benchmark protocol: work only in the checkout. Use the repository tools and any configured integrations that are available to you according to your normal coding workflow. Do not install dependencies. In this first instruction, inspect the relevant architecture, implement the core behavior and focused test scaffolding, but do not run the full repository suite. Do not commit. Summarize what remains for the follow-up.`;
const followUpInstruction = `Continue the same ${repo.repository} task after your first edits. Inspect the current state and finish the implementation, public wiring, and focused tests required by this task. Use the configured integrations or ordinary repository tools as appropriate to your normal coding workflow. Do not install dependencies or commit. If dependencies are unavailable, record the exact deterministic blocker.`;
const finalInstruction = `Perform the final handoff review for the same task. Check the diff for the requested behavior, cross-file callers, public types/exports, and focused tests. Run only a narrow relevant check if dependencies already exist; otherwise do not install them. Use any available repository tools according to your normal coding workflow and report what you actually used. Report every changed file, exact verification command/result, and any limitation. Do not commit.`;

let host;
let hostMetrics;
if (arm === "urdira-typescript") {
  host = spawn(nodeBin, [fileURLToPath(import.meta.url), "--host", "--repository-id", repositoryId, "--task-id", taskId, "--arm", arm, "--phase", phase, "--sample", String(sample), "--commit", commit, "--worktree", worktree, "--data-root", effectiveDataRoot, "--indexing-worker", indexingWorkerBin], { cwd: root, env: { ...process.env, URDIRA_DATA_ROOT: effectiveDataRoot, URDIRA_INDEXING_CORE_WORKER_PATH: indexingWorkerBin, URDIRA_SEMANTIC_INDEX: "0", URDIRA_ANALYSIS_WORKERS: "1", URDIRA_ANALYSIS_POOL_MAX: "1", URDIRA_STRUCTURAL_CONCURRENCY: "1", ...(arm === "urdira-typescript" ? { URDIRA_DEBUG_TIMING: "1", URDIRA_STORAGE_DEBUG_TIMING: "1" } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
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
  if (semanticPerfRequested) semanticPerfAttestation = await waitForSemanticPerfAttestation();
}
const setupElapsedMs = Date.now() - setupStartedAt;

const codexArgs = ["-m", model, "-s", "danger-full-access", "-a", "never", ...(codexIntegration === undefined ? ["--ignore-user-config"] : ["--dangerously-bypass-hook-trust"]), "exec", "--json", "--skip-git-repo-check", "-C", worktree];
const addMcp = (args) => {
  // The production Codex integration injects Urdira through UserPromptSubmit
  // and PreToolUse hooks. Loading the complete MCP catalog as well would send
  // the same discovery surface on every model interaction. A needed MORE
  // envelope remains executable through the installed `urdira query` CLI.
  if (arm === "codebase-memory") {
    const mcpToolTimeoutSec = Math.max(300, Math.ceil(benchmarkTimeoutMs / 1_000));
    args.push("-c", `mcp_servers.codebase-memory.command=${JSON.stringify(codebaseMemoryBin)}`, "-c", "mcp_servers.codebase-memory.startup_timeout_sec=120", "-c", `mcp_servers.codebase-memory.tool_timeout_sec=${mcpToolTimeoutSec}`);
  } else if (arm === "codegraph") {
    const mcpToolTimeoutSec = Math.max(300, Math.ceil(benchmarkTimeoutMs / 1_000));
    args.push("-c", `mcp_servers.codegraph.command=${JSON.stringify(codegraphBin)}`, "-c", `mcp_servers.codegraph.args=["serve","--mcp"]`, "-c", "mcp_servers.codegraph.startup_timeout_sec=120", "-c", `mcp_servers.codegraph.tool_timeout_sec=${mcpToolTimeoutSec}`);
  }
};
addMcp(codexArgs);
const firstInstructionMs = Date.now();
const codexEnvironment = codexIntegration === undefined ? undefined : { HOME: codexIntegrationHome, CODEX_HOME: join(codexIntegrationHome, ".codex"), ZDOTDIR: codexIntegrationHome, PATH: `${codexIntegration.path_prepend}:${process.env.PATH ?? ""}`, URDIRA_DATA_ROOT: effectiveDataRoot, URDIRA_ENDPOINT: codexIntegration.endpoint, URDIRA_INDEXING_CORE_WORKER_PATH: indexingWorkerBin, URDIRA_AGENT_HOOK_AUDIT_LOG: hookAuditPath };
let first = await run(codex, [...codexArgs, "-"], { cwd: worktree, env: codexEnvironment, input: initialInstruction, timing_label: "turn-1" });
if (first.timing) { codexTimingCaptures.push(first.timing); writeTimingSidecar(); }
writeFileSync(transcript, first.stdout, "utf8");
let exitCode = first.code;
let sessionId;
let agentFinishedMs = Date.now();
const interTurnFreshnessWaitsMs = [];
const interTurnReconcileRequests = [];

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
  let gateWorkspaceId;
  try {
    const readyLine = readFileSync(hostLog, "utf8").split("\n").reverse().find((line) => line.startsWith("BENCH_HOST_READY "));
    if (readyLine !== undefined) gateWorkspaceId = JSON.parse(readyLine.slice("BENCH_HOST_READY ".length)).workspace_id;
  } catch { /* fall back to the legacy all-workspaces query below */ }
  if (typeof gateWorkspaceId !== "string") {
    // The host readiness marker is a diagnostic aid, not the source of
    // workspace identity. Resolve the registered workspace from the daemon's
    // explicit status scope when a pipe/log race leaves that marker absent.
    // This read is outside repository context metrics and does not alter the
    // structural frontier.
    const status = await client.call("core:index_status", { api_version: 3 });
    if (status.outcome === "success") {
      gateWorkspaceId = status.payload?.workspaces?.find((candidate) => candidate.display_root === basename(worktree))?.workspace_id;
    }
  }
  if (typeof gateWorkspaceId !== "string") throw new Error(`Urdira inter-turn freshness gate has no workspace id after turn ${afterTurn}`);
  const reconcileStarted = Date.now();
  const reconcile = await client.call("core:reindex", { args: [gateWorkspaceId], values: { scope: "reconcile" } });
  const reconcileElapsed = Date.now() - reconcileStarted;
  interTurnReconcileRequests.push({ after_turn: afterTurn, scope: "reconcile", request_elapsed_ms: reconcileElapsed, outcome: reconcile.outcome });
  appendFileSync(hostLog, `BENCH_INTER_TURN_RECONCILE ${JSON.stringify({ after_turn: afterTurn, scope: "reconcile", request_elapsed_ms: reconcileElapsed, outcome: reconcile.outcome, workspace_id: gateWorkspaceId })}\n`);
  if (reconcile.outcome !== "success") throw new Error(`Urdira inter-turn reconcile trigger failed after turn ${afterTurn}: ${JSON.stringify(reconcile)}`);
  let pollDelayMs = 500;
  let previousFrontier;
  while (Date.now() < deadline) {
    const status = await client.call("core:index_status", { api_version: 3, workspace_ids: typeof gateWorkspaceId === "string" ? [gateWorkspaceId] : [] });
    if (status.outcome !== "success") throw new Error(`Urdira inter-turn freshness gate failed after turn ${afterTurn}: ${JSON.stringify(status)}`);
    const entry = status.payload?.workspaces?.find((candidate) => candidate.display_root === basename(worktree));
    if ([entry?.workspace_status, entry?.freshness_status, entry?.startup_phase].includes("failed")) {
      throw new Error(`Urdira inter-turn indexing failed after turn ${afterTurn}: ${JSON.stringify(entry)}`);
    }
    if (isCurrentStructuralFrontier(entry)) {
      const elapsed = Date.now() - started;
      appendFileSync(hostLog, `BENCH_INTER_TURN_READY ${JSON.stringify({ after_turn: afterTurn, elapsed_ms: elapsed, workspace_id: entry.workspace_id })}\n`);
      return elapsed;
    }
    const frontier = JSON.stringify({ status: entry?.workspace_status, freshness: entry?.freshness_status, startup_phase: entry?.startup_phase, structural_ready: entry?.structural_ready, stage: entry?.structural_stage_ordinal });
    pollDelayMs = frontier === previousFrontier ? Math.min(2_000, pollDelayMs * 2) : 500;
    previousFrontier = frontier;
    await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
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
  resume.push(...(codexIntegration === undefined ? [] : ["--dangerously-bypass-hook-trust"]), "exec", "resume", sessionId, "--json", ...(codexIntegration === undefined ? ["--ignore-user-config"] : []), "--skip-git-repo-check");
  const second = await run(codex, [...resume, "-"], { cwd: worktree, env: codexEnvironment, input: followUpInstruction, timing_label: "turn-2" });
  if (second.timing) { codexTimingCaptures.push(second.timing); writeTimingSidecar(); }
  appendFileSync(transcript, second.stdout, "utf8");
  exitCode = second.code;
  if (second.code === 0) {
    interTurnFreshnessWaitsMs.push(await waitForCurrentStructuralFrontier(2));
    const third = await run(codex, [...resume, "-"], { cwd: worktree, env: codexEnvironment, input: finalInstruction, timing_label: "turn-3" });
    if (third.timing) { codexTimingCaptures.push(third.timing); writeTimingSidecar(); }
    appendFileSync(transcript, third.stdout, "utf8");
    exitCode = third.code;
  }
  agentFinishedMs = Date.now();
}
if (host) await stopHost(host);
if (hostMetrics?.semantic_sidecar_created === true) {
  throw new Error("Semantic index exclusion failed: the Urdira benchmark created a semantic sidecar.");
}

const grade = await run(nodeBin, [join(root, "release/benchmarks/expanded-agent-benchmark-grader.mjs"), "--worktree", worktree, "--repository-id", repositoryId, "--task-id", taskId, "--arm", arm, "--transcript", transcript, "--hook-audit", hookAuditPath], { cwd: root });
let grader;
try { grader = JSON.parse(grade.stdout); } catch { grader = { completed_successfully: false, parse_error: grade.stdout.slice(-2000) }; }
cleanupCodexIntegration();
const manifest = { run_id: runId, repository: repo.repository, repository_id: repositoryId, source_ref: repo.source_ref ?? commit, commit, size_tier: repo.size_tier, task_id: taskId, scenario: task.scenario, incremental_protocol: "staged-incremental", complexity: task.complexity, arm, phase, sample, model, worktree, data_root: arm === "urdira-typescript" ? effectiveDataRoot : undefined, transcript, timing_sidecar: timingSidecar, timing_metrics: timingSummary(), host_session_evidence: hostSessionEvidence, agent_integration: codexIntegration === undefined ? undefined : { ...codexIntegration, cleaned_up: true }, host_log: arm === "urdira-typescript" ? hostLog : undefined, hook_audit_path: arm === "urdira-typescript" ? hookAuditPath : undefined, host_metrics: arm === "urdira-typescript" ? hostMetrics : undefined, semantic_perf_requested: arm === "urdira-typescript" ? semanticPerfRequested : undefined, semantic_perf_attestation: arm === "urdira-typescript" ? semanticPerfAttestation : undefined, inter_turn_freshness_waits_ms: arm === "urdira-typescript" ? interTurnFreshnessWaitsMs : undefined, inter_turn_reconcile_requests: arm === "urdira-typescript" ? interTurnReconcileRequests : undefined, setup_started_at: new Date(setupStartedAt).toISOString(), first_instruction_sent_at: new Date(firstInstructionMs).toISOString(), finished_at: new Date(agentFinishedMs).toISOString(), setup_elapsed_ms: setupElapsedMs, elapsed_ms_from_first_instruction: agentFinishedMs - firstInstructionMs, outer_turns_requested: 3, exit_code: exitCode, grader_exit_code: grade.code, completed_successfully: exitCode === 0 && grade.code === 0 && grader.completed_successfully === true, setup, correctness: grader };
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
  if (arm === "tgrep") {
    if (!tgrepBin || !existsSync(tgrepBin)) throw new Error(`tgrep executable not found: ${tgrepBin}`);
    const started = Date.now();
    const result = await run(tgrepBin, ["index", worktree], { cwd: root });
    if (result.code !== 0) throw new Error(`tgrep index failed: ${result.stderr}`);
    return { kind: "tgrep", indexed: true, index_path: join(worktree, ".tgrep"), elapsed_ms: Date.now() - started, output_tail: `${result.stdout.slice(-2000)}${result.stderr.slice(-2000)}` };
  }
  return { kind: "urdira-typescript", indexed: true, semantic_index: false, semantic_materialization: false, reconciliation_sweep_interval_ms: RECONCILIATION_SWEEP_INTERVAL_MS, readiness: "structural" };
}

function startHostMetrics(child, dataRoot) {
  const state = { peak_rss_kib: 0, structural_readiness_peak_rss_kib: null, cpu_percent_samples: [], sample_count: 0, started_at: Date.now(), catalog_sqlite_bytes: 0, lexical_sqlite_bytes: 0, semantic_sqlite_bytes: 0, structural_store_bytes: 0, rust_sidecar_bytes: 0, cas_bytes: 0, bytes_copied: null, bytes_transferred: null, bytes_decoded: null, readiness_events: [], structural_readiness_ms: null, memory_budget_kib: null, memory_budget_exceeded: false, memory_budget_exceeded_at: null };
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
        if (line.includes("BENCH_HOST_READY")) {
          state.structural_readiness_ms = Number(payload.elapsed_ms ?? (Date.now() - state.started_at));
          state.structural_readiness_peak_rss_kib = state.peak_rss_kib;
        }
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
  hostMetrics.state.catalog_sqlite_bytes = directoryBytes(hostMetrics.dataRoot, (path) => /\.sqlite(?:-|$)/u.test(path) && !/\.(?:lexical|semantic)\.sqlite(?:-|$)/u.test(path));
  hostMetrics.state.lexical_sqlite_bytes = directoryBytes(hostMetrics.dataRoot, (path) => /\.lexical\.sqlite(?:-|$)/u.test(path));
  hostMetrics.state.semantic_sqlite_bytes = directoryBytes(hostMetrics.dataRoot, (path) => /\.semantic\.sqlite(?:-|$)/u.test(path));
  hostMetrics.state.structural_store_bytes = directoryBytes(hostMetrics.dataRoot, (path) => path.includes(".structural/"));
  hostMetrics.state.rust_sidecar_bytes = directoryBytes(hostMetrics.dataRoot, (path) => path.includes(".sidecar/"));
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
    readiness_boundary: "structural",
    reconciliation_sweep_interval_ms: RECONCILIATION_SWEEP_INTERVAL_MS,
    semantic_index: false,
    semantic_materialization: false,
    semantic_sidecar_created: hostMetrics.state.semantic_sqlite_bytes > 0,
    catalog_sqlite_bytes: hostMetrics.state.catalog_sqlite_bytes,
    lexical_sqlite_bytes: hostMetrics.state.lexical_sqlite_bytes,
    semantic_sqlite_bytes: hostMetrics.state.semantic_sqlite_bytes,
    structural_store_bytes: hostMetrics.state.structural_store_bytes,
    rust_sidecar_bytes: hostMetrics.state.rust_sidecar_bytes,
    cas_bytes: hostMetrics.state.cas_bytes,
    bytes_copied: hostMetrics.state.bytes_copied,
    bytes_transferred: hostMetrics.state.bytes_transferred,
    bytes_decoded: hostMetrics.state.bytes_decoded,
    structural_readiness_ms: hostMetrics.state.structural_readiness_ms,
    structural_readiness_peak_rss_kib: hostMetrics.state.structural_readiness_peak_rss_kib,
    ready_elapsed_ms: hostMetrics.state.structural_readiness_ms,
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
  // through the live watcher. Keep the periodic sweep disabled so no
  // background scan can contaminate the idle interval. The runner's explicit
  // post-turn `scope: reconcile` request is the deterministic recovery path
  // and its request plus frontier wait are measured in the manifest/host log.
  const runtime = await DaemonRuntime.start({ ...(await defaultDaemonOptions(dataRoot)), data_root: dataRoot, semantic_index: false, semantic_descriptor: undefined, reconciliation_sweep_interval_ms: RECONCILIATION_SWEEP_INTERVAL_MS });
  const client = new DaemonClient(runtime.endpoint, { request_timeout_ms: benchmarkTimeoutMs });
  const registration = await client.call("core:workspace_add", { args: [worktree], confirmed: true, selected_technology_ids: ["javascript", "typescript"], selected_plugin_ids: ["urdira:javascript_typescript"] });
  if (registration.outcome !== "success") throw new Error(`workspace registration failed: ${JSON.stringify(registration)}`);
  const registeredWorkspaceId = registration.payload?.workspace_id;
  const deadline = Date.now() + benchmarkTimeoutMs;
  let ready = false;
  let previousFrontier;
  let sourceReadySinceTs;
  while (Date.now() < deadline) {
    const status = await client.call("core:index_status", { api_version: 3, workspace_ids: typeof registeredWorkspaceId === "string" ? [registeredWorkspaceId] : [] });
    const entry = status.payload?.workspaces?.find((candidate) => candidate.display_root === worktree.split("/").at(-1));
    if ([entry?.workspace_status, entry?.freshness_status, entry?.startup_phase].includes("failed")) {
      throw new Error(`Urdira structural indexing failed: ${JSON.stringify(entry)}`);
    }
    const frontier = {
      elapsed_ms: Date.now() - hostStartedAt,
      source_ready: entry?.source_ready === true,
      syntax_ready: entry?.syntax_ready === true,
      structural_ready: entry?.structural_ready === true,
      structural_stage_ordinal: Number(entry?.structural_stage_ordinal ?? 0),
      structural_completeness: entry?.structural_completeness ?? null,
      structural_availability: entry?.structural_availability ?? null,
      source_completeness: entry?.source_completeness ?? null,
      freshness_status: entry?.freshness_status ?? null,
      workspace_status: entry?.workspace_status ?? null,
      startup_phase: entry?.startup_phase ?? null,
    };
    const frontierKey = JSON.stringify({ ...frontier, elapsed_ms: undefined });
    const frontierChanged = frontierKey !== previousFrontier;
    if (frontierChanged) {
      previousFrontier = frontierKey;
      process.stdout.write(`BENCH_FRONTIER ${JSON.stringify(frontier)}\n`);
    }
    // Preserve the campaign's phase contract. A `warm` sample starts only
    // after the complete structural snapshot is current/equivalent; releasing
    // at the first transient source frontier moves indexing work into the
    // measured agent turn. Use source/structural freshness rather than the
    // aggregate state, which can include an unavailable semantic lane.
    const warmReady = isCurrentStructuralFrontier(entry);
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
    // Readiness is a gate, not a heartbeat. Polling the full status payload
    // every 500ms while a large incremental generation is committing makes
    // the benchmark compete with the SQLite writer and can turn one edit
    // into thousands of redundant synchronization reads. A bounded backoff
    // keeps the same readiness predicate while giving publication windows to
    // finish.
    const pollDelayMs = frontierChanged ? 500 : 2_000;
    await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
  }
  if (!ready) throw new Error(`Timed out waiting for the Urdira ${phase === "warm" ? "current structural" : "source_ready"} frontier`);
  process.stdout.write(`BENCH_HOST_READY ${JSON.stringify({ workspace: worktree, workspace_id: registeredWorkspaceId, repository: repositoryId, readiness_boundary: "structural", semantic_index: false, semantic_materialization: false, reconciliation_sweep_interval_ms: RECONCILIATION_SWEEP_INTERVAL_MS, elapsed_ms: Date.now() - hostStartedAt })}\n`);
  const stop = async () => {
    process.stdout.write(`[urdira] byte telemetry ${JSON.stringify(runtime.byteTelemetrySnapshot())}\n`);
    await runtime.stop({ force: false });
    process.exit(0);
  };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}
