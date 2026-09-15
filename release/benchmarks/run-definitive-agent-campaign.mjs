#!/usr/bin/env node
/* Direct 15-cell campaign orchestrator for the definitive benchmark handoff. */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCleanupGateOpen, DEFINITIVE_MINIMUM_FREE_BYTES, parseMinimumFreeBytes, runCleanupCheckpoint } from "./benchmark-cleanup.mjs";
import { assertReleaseBinding } from "./release-binding.mjs";
import { inspectProcessInventory, processTable, verifiedOwnedProcesses } from "./benchmark-process-inventory.mjs";
import { materializeAgentDependencyClosure } from "./agent-validation-environment.mjs";

const root = fileURLToPath(new globalThis.URL("../..", import.meta.url));
const corpus = JSON.parse(readFileSync(join(root, "release/benchmarks/expanded-typescript-agent-benchmark.json"), "utf8"));
export const DEFINITIVE_FROZEN_TASKS = Object.freeze({
  playwright: Object.freeze({ task: "affected-tests-deterministic", commit: "1b44f5a441f391538c42c7ce36dd8ce779a5d6a1", prompt_sha256: "912978b747ff743deb242a734f41a4c6bf56cec6d93d66b1b8462e80bd58f6cb" }),
  prisma: Object.freeze({ task: "wire-name-validation", commit: "0f37454eec96b193e8b20e8f569e453acd2af644", prompt_sha256: "44eba189be041952228e22621560827a3176e03d5bfa155f421e726d60136284" }),
  vscode: Object.freeze({ task: "language-provider-registration-idempotence", commit: "038b9225c82c6b75172beda6081c64887692538c", prompt_sha256: "49d92a82476991aec8b6a86b878609059f21f58cabf4e271f6931e2f57704f11" }),
});
export const DEFINITIVE_CELLS = Object.freeze(Object.entries(DEFINITIVE_FROZEN_TASKS).map(([repository, entry]) => [repository, entry.task]));
export const DEFINITIVE_ARMS = Object.freeze(["baseline", "urdira-typescript", "tgrep", "codegraph", "codebase-memory"]);
export const DEFINITIVE_READINESS_PHASES = Object.freeze(["cold", "warm"]);

export function retainableCellFailure(result, manifest) {
  if (typeof result?.capture_error === "string" && result.capture_error.length > 0) return false;
  if (result?.code === 0) return true;
  if (result === null || typeof result !== "object" || manifest === null || typeof manifest !== "object") return false;
  const bindingPassed = manifest.arm !== "urdira-typescript" || manifest.release_binding?.status === "passed";
  const executionRecorded = typeof manifest.transcript === "string"
    && existsSync(manifest.transcript)
    && Number.isSafeInteger(manifest.exit_code)
    && Number.isSafeInteger(manifest.grader_exit_code)
    && typeof manifest.completed_successfully === "boolean";
  return bindingPassed && executionRecorded;
}

export { effectiveProcessOwner, isProcessInventoryProbe } from "./benchmark-process-inventory.mjs";

const value = (argv, name, fallback) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };

function inventoryForRoots(roots) {
  return inspectProcessInventory(roots);
}

function terminateProcessTree(pid) {
  const table = processTable();
  const descendants = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of table) if (descendants.has(entry.ppid) && !descendants.has(entry.pid)) { descendants.add(entry.pid); changed = true; }
  }
  for (const entry of [...table].filter((candidate) => descendants.has(candidate.pid)).reverse()) {
    try { process.kill(entry.pid, "SIGTERM"); } catch { /* exited */ }
  }
  const target = table.find((entry) => entry.pid === pid);
  if (target?.pgid !== undefined && target.pgid > 1) {
    try { process.kill(-target.pgid, "SIGTERM"); } catch { /* process group exited */ }
  }
  const escalation = globalThis.setTimeout(() => {
    for (const descendant of descendants) { try { process.kill(descendant, "SIGKILL"); } catch { /* exited */ } }
    if (target?.pgid !== undefined && target.pgid > 1) { try { process.kill(-target.pgid, "SIGKILL"); } catch { /* process group exited */ } }
  }, 500);
  escalation.unref?.();
  try { process.kill(pid, "SIGTERM"); } catch { /* exited */ }
  return [...descendants];
}

let activeChild;
let cancellationRequested = false;

function commandOutputMetadata(stdoutPath, stderrPath) {
  const describe = (path) => {
    if (typeof path !== "string" || !existsSync(path)) return { path: path ?? null, bytes: null, sha256: null };
    const content = readFileSync(path);
    return { path, bytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex") };
  };
  const stdout = describe(stdoutPath);
  const stderr = describe(stderrPath);
  return { stdout_path: stdout.path, stdout_bytes: stdout.bytes, stdout_sha256: stdout.sha256, stderr_path: stderr.path, stderr_bytes: stderr.bytes, stderr_sha256: stderr.sha256 };
}

function persistCommandOutput(cell, result) {
  const stdoutPath = result?.stdout_path ?? join(cell.output_root, `${cell.run_id}.stdout.log`);
  const stderrPath = result?.stderr_path ?? join(cell.output_root, `${cell.run_id}.stderr.log`);
  mkdirSync(cell.output_root, { recursive: true });
  if (!existsSync(stdoutPath)) writeFileSync(stdoutPath, typeof result?.stdout === "string" ? result.stdout : "", "utf8");
  if (!existsSync(stderrPath)) writeFileSync(stderrPath, typeof result?.stderr === "string" ? result.stderr : "", "utf8");
  return { ...result, ...commandOutputMetadata(stdoutPath, stderrPath), stdout: undefined, stderr: undefined };
}

export const runCommand = (command, args, options = {}) => new Promise((resolvePromise, reject) => {
  const timeoutText = process.env.BENCH_CELL_TIMEOUT_MS;
  if (timeoutText !== undefined && !/^\d+$/u.test(timeoutText)) { reject(new Error("BENCH_CELL_TIMEOUT_MS must be a non-negative integer")); return; }
  const timeoutMs = options.timeoutMs ?? (timeoutText === undefined ? 900_000 : Number(timeoutText));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) { reject(new Error("cell timeout must be a positive integer")); return; }
  const stdoutPath = typeof options.stdoutPath === "string" ? options.stdoutPath : undefined;
  const stderrPath = typeof options.stderrPath === "string" ? options.stderrPath : undefined;
  let stdoutHandle;
  let stderrHandle;
  try {
    if (stdoutPath !== undefined) { mkdirSync(dirname(stdoutPath), { recursive: true }); stdoutHandle = openSync(stdoutPath, "w"); }
    if (stderrPath !== undefined) { mkdirSync(dirname(stderrPath), { recursive: true }); stderrHandle = openSync(stderrPath, "w"); }
  } catch (error) {
    if (stdoutHandle !== undefined) closeSync(stdoutHandle);
    if (stderrHandle !== undefined) closeSync(stderrHandle);
    reject(error);
    return;
  }
  const closeCapture = () => {
    for (const [name, handle] of [["stdout", stdoutHandle], ["stderr", stderrHandle]]) {
      if (handle === undefined) continue;
      try { closeSync(handle); } catch (error) { captureError ??= `${name} spool close failed: ${error instanceof Error ? error.message : String(error)}`; }
    }
    stdoutHandle = undefined;
    stderrHandle = undefined;
  };
  const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  activeChild = child;
  let stdout = ""; let stderr = "";
  let timer;
  let timedOut = false;
  let captureError;
  const writeChunk = typeof options.writeChunk === "function" ? options.writeChunk : (handle, chunk) => writeSync(handle, chunk);
  const captureChunk = (handle, chunk, stream) => {
    if (handle === undefined || captureError !== undefined) return;
    try { writeChunk(handle, chunk, stream); } catch (error) {
      captureError = `${stream} spool failed: ${error instanceof Error ? error.message : String(error)}`;
      try { terminateProcessTree(child.pid); } catch (terminationError) { captureError += `; termination failed: ${terminationError instanceof Error ? terminationError.message : String(terminationError)}`; }
    }
  };
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); captureChunk(stdoutHandle, chunk, "stdout"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); captureChunk(stderrHandle, chunk, "stderr"); });
  if (Number.isSafeInteger(timeoutMs) && timeoutMs > 0) timer = globalThis.setTimeout(() => {
    timedOut = true;
    const descendants = terminateProcessTree(child.pid);
    const escalation = globalThis.setTimeout(() => {
      for (const pid of descendants) { try { process.kill(pid, "SIGKILL"); } catch { /* exited */ } }
    }, 500);
    escalation.unref?.();
  }, timeoutMs);
  child.on("error", (error) => { if (timer) globalThis.clearTimeout(timer); closeCapture(); if (activeChild === child) activeChild = undefined; error.command_output = commandOutputMetadata(stdoutPath, stderrPath); if (captureError !== undefined) error.capture_error = captureError; reject(error); });
  child.on("close", (code, signal) => { if (timer) globalThis.clearTimeout(timer); closeCapture(); if (activeChild === child) activeChild = undefined; resolvePromise({ code: code ?? 1, signal, stdout, stderr, timed_out: timedOut, capture_error: captureError ?? null, ...commandOutputMetadata(stdoutPath, stderrPath) }); });
});

const run = runCommand;

/** Execute the frozen cells with injected runner/cleanup ports for offline regression tests. */
export async function runDefinitiveCells({ plan, outputRoot, worktreeRoot, releaseRoot, releaseArchive, outputManifest, releaseBinding, minimumFreeBytes, runner = run, prepareDependencies, cleanup = cleanupCell, isCancelled = () => cancellationRequested }) {
  const auditPath = join(outputRoot, "campaign-audit.json");
  const audit = { schema_version: 1, definitive_protocol: "selected-15", campaign: plan.campaign, expected_runs: plan.expected_runs, readiness_expected_probes: 6, minimum_free_bytes: minimumFreeBytes, failure_policy: plan.failure_policy, cell_manifest: outputManifest, cell_manifest_sha256: createHash("sha256").update(readFileSync(outputManifest)).digest("hex"), release_binding: releaseBinding, runs: [] };
  for (const cell of plan.cells) {
    if (isCancelled()) throw new Error("Campaign cancelled before next cell");
    assertCleanupGateOpen(join(outputRoot, "cleanup-block.json"));
    if (!existsSync(join(cell.repository_root, ".git"))) throw new Error(`Repository checkout is unavailable: ${cell.repository_root}`);
    mkdirSync(cell.output_root, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
    let result; let manifest; let dependencySetup; let postCellError; let runnerInvoked = false; let preflightFailure;
    try {
      const worktreeResult = await runner("git", ["worktree", "add", "--detach", cell.worktree, cell.commit], { cwd: cell.repository_root, phase: "worktree", stdoutPath: join(cell.output_root, `${cell.run_id}.worktree.stdout.log`), stderrPath: join(cell.output_root, `${cell.run_id}.worktree.stderr.log`) });
      if (worktreeResult.code !== 0) postCellError = new Error(`Unable to create worktree ${cell.worktree}: ${worktreeResult.stderr}`);
      if (postCellError === undefined) {
        const prepare = prepareDependencies ?? ((options) => materializeAgentDependencyClosure({ ...options, run: runner }));
        dependencySetup = await prepare({ repositoryId: cell.repository_id, repositoryRoot: cell.repository_root, worktree: cell.worktree, nodeExecutable: cell.node, taskId: cell.task_id });
        const args = [join(root, "release/benchmarks/expanded-agent-benchmark-runner.mjs"), "--definitive", "--repository-id", cell.repository_id, "--task-id", cell.task_id, "--arm", cell.arm, "--sample", String(cell.campaign), "--phase", cell.phase, "--commit", cell.commit, "--worktree", cell.worktree, "--data-root", cell.data_root, "--output-dir", cell.output_root, "--model", cell.model, "--codex", cell.codex, "--node", cell.node, "--indexing-worker", cell.indexing_worker ?? "", "--codebase-memory", cell.codebase_memory ?? "", "--codegraph", cell.codegraph ?? "", "--tgrep", cell.tgrep ?? "", "--release-root", releaseRoot, "--release-archive", releaseArchive];
        runnerInvoked = true;
        result = await runner(cell.node, args, { cwd: root, env: { URDIRA_SEMANTIC_INDEX: "0" }, phase: "cell", stdoutPath: join(cell.output_root, `${cell.run_id}.stdout.log`), stderrPath: join(cell.output_root, `${cell.run_id}.stderr.log`) });
        result = persistCommandOutput(cell, result);
        try { manifest = JSON.parse(readFileSync(join(cell.output_root, `${cell.run_id}.json`), "utf8")); } catch { manifest = null; }
        if (manifest !== null) { manifest.dependency_setup = dependencySetup; writeFileSync(join(cell.output_root, `${cell.run_id}.json`), `${JSON.stringify(manifest, null, 2)}\n`); }
        if (!retainableCellFailure(result, manifest)) postCellError = new Error(`Cell execution was not recorded as a model/grader result: ${cell.run_id}`);
      }
    } catch (error) {
      if (error?.command_output !== undefined) result = { code: 1, signal: null, timed_out: false, capture_error: error.capture_error ?? null, ...error.command_output };
      postCellError ??= error instanceof Error ? error : new Error(String(error));
    } finally {
      const cellCleanup = await cleanup(cell, manifest, minimumFreeBytes);
      if (!runnerInvoked && postCellError) {
        mkdirSync(cell.output_root, { recursive: true });
        const failurePath = join(cell.output_root, `${cell.run_id}.preflight-failure.json`);
        if (!existsSync(failurePath)) writeFileSync(failurePath, `${JSON.stringify({ ok: false, stage: "worktree-or-dependency-setup", run_id: cell.run_id, repository_id: cell.repository_id, task_id: cell.task_id, arm: cell.arm, commit: cell.commit, worktree: cell.worktree, model_invoked: false, dependency_setup: dependencySetup, error: postCellError.message }, null, 2)}\n`, { flag: "wx" });
        preflightFailure = { path: failurePath, sha256: createHash("sha256").update(readFileSync(failurePath)).digest("hex") };
      }
      audit.runs.push({ ...cell, result: result === undefined ? null : { code: result.code, signal: result.signal, timed_out: result.timed_out ?? false, capture_error: result.capture_error ?? null, stdout_path: result.stdout_path ?? null, stdout_bytes: result.stdout_bytes ?? null, stdout_sha256: result.stdout_sha256 ?? null, stderr_path: result.stderr_path ?? null, stderr_bytes: result.stderr_bytes ?? null, stderr_sha256: result.stderr_sha256 ?? null }, model_invoked: manifest?.model_invoked ?? (runnerInvoked ? null : false), dependency_setup: dependencySetup ?? null, preflight_failure: preflightFailure ?? null, error: postCellError?.message ?? null, manifest, cleanup: cellCleanup });
      writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
      if (cellCleanup.status === "blocked") {
        writeFileSync(join(outputRoot, "cleanup-block.json"), `${JSON.stringify(cellCleanup, null, 2)}\n`, { flag: "wx" });
        postCellError = new Error(`Cleanup checkpoint blocked campaign after ${cell.run_id}`);
      }
      if (isCancelled()) postCellError ??= new Error(`Campaign cancelled during ${cell.run_id}`);
    }
    if (postCellError) throw postCellError;
  }
  return audit;
}

export function buildCellManifest({ campaign, worktreeRoot, dataRoot, runRoot, repositoriesRoot, model = corpus.model, nodeBin = process.execPath, codex = "/Applications/ChatGPT.app/Contents/Resources/codex", indexingWorker, codebaseMemory, codegraph, tgrep, supervisorTimeoutMs = 900_000, minimumFreeBytes = DEFINITIVE_MINIMUM_FREE_BYTES }) {
  if (!Number.isSafeInteger(campaign) || campaign < 1 || campaign > 3) throw new Error("campaign must be 1, 2, or 3");
  const rows = [];
  for (const [repositoryId, taskId] of DEFINITIVE_CELLS) {
    const frozen = DEFINITIVE_FROZEN_TASKS[repositoryId];
    const repository = corpus.repositories.find((entry) => entry.id === repositoryId);
    const task = repository?.tasks.find((entry) => entry.id === taskId);
    if (!repository || !task) throw new Error(`Frozen definitive cell is missing from corpus: ${repositoryId}/${taskId}`);
    const promptSha256 = createHash("sha256").update(task.prompt).digest("hex");
    if (repository.commit !== frozen.commit || promptSha256 !== frozen.prompt_sha256) throw new Error(`Frozen definitive cell drifted in corpus: ${repositoryId}/${taskId}`);
    for (const arm of DEFINITIVE_ARMS) {
      const runId = `${repositoryId}-${taskId}-${arm}-${campaign}`;
      rows.push({
        schema_version: 1,
        cell_index: rows.length,
        run_id: runId,
        campaign,
        repository_id: repositoryId,
        repository: repository.repository,
        task_id: taskId,
        arm,
        commit: repository.commit,
        prompt_sha256: promptSha256,
        source_ref: repository.source_ref ?? repository.commit,
        phase: "warm",
        model,
        node: nodeBin,
        codex,
        indexing_worker: indexingWorker ?? null,
        codebase_memory: codebaseMemory ?? null,
        codegraph: codegraph ?? null,
        tgrep: tgrep ?? null,
        repository_root: join(repositoriesRoot, repositoryId),
        worktree: join(worktreeRoot, runId),
        data_root: join(dataRoot, runId),
        output_root: join(runRoot, runId),
        supervisor_timeout_ms: supervisorTimeoutMs,
      });
    }
  }
  return { schema_version: 1, kind: "definitive-agent-cell-manifest", protocol: "definitive-selected-v1", definitive_protocol: "selected-15", campaign, model, node: nodeBin, supervisor_timeout_ms: supervisorTimeoutMs, minimum_free_bytes: minimumFreeBytes, failure_policy: "record-and-continue-after-clean-checkpoint-no-retry", generated_at: new Date().toISOString(), expected_runs: rows.length, cells: rows };
}

export function buildReadinessManifest({ campaign, dataRoot, runRoot, repositoriesRoot, nodeBin = process.execPath, indexingWorker, minimumFreeBytes = DEFINITIVE_MINIMUM_FREE_BYTES }) {
  if (!Number.isSafeInteger(campaign) || campaign < 1 || campaign > 3) throw new Error("campaign must be 1, 2, or 3");
  const probes = [];
  for (const [repositoryId, taskId] of DEFINITIVE_CELLS) {
    const frozen = DEFINITIVE_FROZEN_TASKS[repositoryId];
    const repository = corpus.repositories.find((entry) => entry.id === repositoryId);
    const task = repository?.tasks.find((entry) => entry.id === taskId);
    if (!repository || !task) throw new Error(`Frozen definitive repository is missing from corpus: ${repositoryId}`);
    if (repository.commit !== frozen.commit || createHash("sha256").update(task.prompt).digest("hex") !== frozen.prompt_sha256) throw new Error(`Frozen definitive cell drifted in corpus: ${repositoryId}/${taskId}`);
    for (const phase of DEFINITIVE_READINESS_PHASES) {
      const probeId = `${repositoryId}-${phase}-${campaign}`;
      probes.push({ schema_version: 1, probe_index: probes.length, probe_id: probeId, campaign, repository: repository.repository, repository_id: repositoryId, task_id: taskId, commit: repository.commit, prompt_sha256: frozen.prompt_sha256, phase, model_invoked: false, node: nodeBin, node_version: process.version, indexing_worker: indexingWorker ?? null, repository_root: join(repositoriesRoot, repositoryId), data_root: join(dataRoot, probeId), output_root: join(runRoot, probeId), timestamps: { data_root_created: null, source_ready: null, structural_ready: null, validated_first_query: null, first_query_complete: null }, setup_elapsed_ms: null, structural_readiness_ms: null, time_to_first_query_ms: null, snapshot_identity: null, page_completeness: null, semantic_index: false, semantic_materialization: false, semantic_sidecar_created: null, storage: null, process: null, freshness: null, publication: null, passed: null, failure: null });
    }
  }
  return { schema_version: 1, kind: "definitive-readiness-probe-manifest", definitive_protocol: "selected-6", campaign, node: nodeBin, node_version: process.version, minimum_free_bytes: minimumFreeBytes, generated_at: new Date().toISOString(), expected_probes: probes.length, readiness_expected_probes: probes.length, probes };
}

export async function stopOwnedProcesses(roots, adapters = {}) {
  const processes = (adapters.inventory ?? inventoryForRoots)(roots);
  const owned = verifiedOwnedProcesses(processes);
  for (const entry of owned) (adapters.terminate ?? terminateProcessTree)(entry.pid);
  if (owned.length > 0) await (adapters.wait ?? (() => new Promise((resolvePromise) => globalThis.setTimeout(resolvePromise, 600))))();
  return { stopped_processes: owned, unverified_processes: processes.filter((entry) => !entry.owned_by_cell) };
}

function ownedProcessInventory(roots) {
  return inventoryForRoots(roots);
}

async function cleanupCell(cell, manifest, minimumFreeBytes) {
  const integrationHome = manifest?.agent_integration?.home;
  const registeredPaths = [cell.worktree, cell.data_root, integrationHome].filter((path) => typeof path === "string");
  return runCleanupCheckpoint({
    manifestPath: join(cell.output_root, "cleanup.json"),
    registeredPaths,
    filesystemPath: cell.output_root,
    minimumFreeBytes,
    cleanup: async () => {
      const stopped = await stopOwnedProcesses(registeredPaths);
      const errors = [];
      if (existsSync(cell.worktree)) {
        const removed = await run("git", ["worktree", "remove", "--force", cell.worktree], { cwd: cell.repository_root });
        if (removed.code !== 0 && existsSync(cell.worktree)) errors.push(`worktree: ${removed.stderr || removed.stdout}`);
      }
      for (const path of [cell.data_root, integrationHome]) if (typeof path === "string" && existsSync(path)) {
        try { rmSync(path, { recursive: true, force: true }); } catch (error) { errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      return { stopped_processes: stopped, errors };
    },
    listOwnedProcesses: () => ownedProcessInventory(registeredPaths),
    metadata: { run_id: cell.run_id, campaign: cell.campaign, cell_index: cell.cell_index },
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const campaign = Number(value(argv, "--campaign", "1"));
  const outputRoot = resolve(value(argv, "--output-root", join("/tmp", `urdira-definitive-campaign-${campaign}`)));
  const worktreeRoot = resolve(value(argv, "--worktree-root", join(outputRoot, "worktrees")));
  const dataRoot = resolve(value(argv, "--data-root", join(outputRoot, "data")));
  const runRoot = resolve(value(argv, "--run-root", join(outputRoot, "runs")));
  const repositoriesRoot = resolve(value(argv, "--repositories-root", join("/tmp", "urdira-definitive", "repos")));
  const nodeBin = value(argv, "--node", process.execPath);
  const model = value(argv, "--model", corpus.model);
  if (model !== corpus.model) throw new Error(`Frozen definitive model mismatch: expected ${corpus.model}, received ${model}`);
  const nodeVersion = await run(nodeBin, ["--version"]);
  if (nodeVersion.code !== 0 || nodeVersion.stdout.trim() !== "v24.18.1") throw new Error(`Frozen definitive Node mismatch: expected v24.18.1, received ${nodeVersion.stdout.trim() || nodeVersion.stderr}`);
  const minimumFreeBytes = parseMinimumFreeBytes(process.env.BENCH_MIN_FREE_BYTES) ?? DEFINITIVE_MINIMUM_FREE_BYTES;
  if (minimumFreeBytes !== DEFINITIVE_MINIMUM_FREE_BYTES) throw new Error(`definitive protocol requires BENCH_MIN_FREE_BYTES=${DEFINITIVE_MINIMUM_FREE_BYTES}`);
  const timeoutText = process.env.BENCH_CELL_TIMEOUT_MS;
  if (timeoutText !== undefined && !/^\d+$/u.test(timeoutText)) throw new Error("BENCH_CELL_TIMEOUT_MS must be a non-negative integer");
  const supervisorTimeoutMs = timeoutText === undefined ? 900_000 : Number(timeoutText);
  if (!Number.isSafeInteger(supervisorTimeoutMs) || supervisorTimeoutMs < 1) throw new Error("BENCH_CELL_TIMEOUT_MS must be a positive integer");
  const releaseRoot = value(argv, "--release-root", process.env.URDIRA_RELEASE_ROOT);
  const releaseArchive = value(argv, "--release-archive", process.env.URDIRA_RELEASE_ARCHIVE);
  const onSignal = (signal) => { cancellationRequested = true; if (activeChild?.pid !== undefined) terminateProcessTree(activeChild.pid); process.exitCode = signal === "SIGINT" ? 130 : 143; };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const outputManifest = join(outputRoot, "cell-manifest.json");
  mkdirSync(outputRoot, { recursive: true });
  const plan = buildCellManifest({ campaign, outputRoot, worktreeRoot, dataRoot, runRoot, repositoriesRoot, model, nodeBin, codex: value(argv, "--codex", "/Applications/ChatGPT.app/Contents/Resources/codex"), indexingWorker: value(argv, "--indexing-worker", process.env.URDIRA_INDEXING_CORE_WORKER_PATH), codebaseMemory: value(argv, "--codebase-memory"), codegraph: value(argv, "--codegraph"), tgrep: value(argv, "--tgrep"), supervisorTimeoutMs, minimumFreeBytes });
  writeFileSync(outputManifest, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  if (argv.includes("--plan-only")) {
    process.stdout.write(`${JSON.stringify({ output_manifest: outputManifest, cells: plan.cells.length, model_invoked: false })}\n`);
    return;
  }
  if (argv.includes("--readiness-plan-only")) {
    const readiness = buildReadinessManifest({ campaign, outputRoot, dataRoot, runRoot, repositoriesRoot, nodeBin: value(argv, "--node", process.execPath), indexingWorker: value(argv, "--indexing-worker", process.env.URDIRA_INDEXING_CORE_WORKER_PATH), minimumFreeBytes });
    const readinessPath = join(outputRoot, "readiness-manifest.json");
    writeFileSync(readinessPath, `${JSON.stringify(readiness, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`${JSON.stringify({ output_manifest: readinessPath, probes: readiness.probes.length, model_invoked: false })}\n`);
    return;
  }
  const releaseBinding = assertReleaseBinding({ archiveRoot: releaseRoot, archivePath: releaseArchive });
  const audit = await runDefinitiveCells({ plan, outputRoot, worktreeRoot, releaseRoot, releaseArchive, outputManifest, releaseBinding, minimumFreeBytes });
  process.stdout.write(`${JSON.stringify({ audit: join(outputRoot, "campaign-audit.json"), cells: audit.runs.length, model_invoked: true })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();
