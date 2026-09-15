#!/usr/bin/env node
/* global URL, setInterval, clearInterval */
/* Sequential campaign driver for the five-arm TypeScript benchmark. */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { arch, cpus, freemem, loadavg, platform, release, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleProcessTree } from "./benchmark-process-tree.mjs";
import { assertCleanupGateOpen, parseMinimumFreeBytes, runCleanupCheckpoint } from "./benchmark-cleanup.mjs";
import { assertReleaseBinding } from "./release-binding.mjs";

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
const tgrepBin = value("--tgrep", join("/tmp", "urdira-expanded-benchmark", "tgrep", "tgrep"));
const releaseRoot = value("--release-root", process.env.URDIRA_RELEASE_ROOT);
const releaseArchive = value("--release-archive", process.env.URDIRA_RELEASE_ARCHIVE);
const minimumFreeBytes = parseMinimumFreeBytes(process.env.BENCH_MIN_FREE_BYTES);
const cleanupGuardPath = join(outputDir, "cleanup-block.json");
const runner = join(root, "release/benchmarks/expanded-agent-benchmark-runner.mjs");
// Large repositories need a longer structural publication budget. Keep the
// policy deterministic and size-tier driven so every arm receives the same
// cell timeout, while Urdira also passes it through to the indexing-core
// worker's own deadline. Semantic indexing remains disabled for every cell.
const cellTimeoutMs = (repository) => repository.size_tier === "L" ? 1_800_000 : 900_000;
const requestedArms = value("--arms", corpus.arms.join(",")).split(",").map((arm) => arm.trim()).filter(Boolean);
let arms = [...new Set(requestedArms)];
const requestedRepositoryIds = value("--repositories", corpus.repositories.map((repository) => repository.id).join(",")).split(",").map((repository) => repository.trim()).filter(Boolean);
const repositories = corpus.repositories.filter((repository) => requestedRepositoryIds.includes(repository.id));
const smokeAuditPath = value("--smoke-audit", undefined);
const smokeAuditsArgument = value("--smoke-audits", undefined);
const independentCampaigns = Number(value("--independent-campaigns", "1"));
const smokeGateResults = [];
const smokeBlockedArms = [];
const [nodeMajor, nodeMinor, nodePatch] = process.versions.node.split(".").map(Number);
if (nodeMajor < 24 || nodeMajor === 24 && (nodeMinor < 18 || nodeMinor === 18 && nodePatch < 1)) throw new Error(`Node >=24.18.1 is required for the expanded campaign; found ${process.version}`);
if (arms.length === 0 || arms.some((arm) => !corpus.arms.includes(arm))) throw new Error(`--arms must contain only: ${corpus.arms.join(", ")}`);
if (repositories.length === 0 || repositories.length !== requestedRepositoryIds.length) throw new Error(`--repositories must contain only known repository ids: ${corpus.repositories.map((repository) => repository.id).join(", ")}`);
if (!Number.isSafeInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");
if (!Number.isSafeInteger(independentCampaigns) || independentCampaigns < 1) throw new Error("--independent-campaigns must be a positive integer");
if (!existsSync(codex)) throw new Error(`Codex executable not found: ${codex}`);
if (arms.includes("codegraph") && !existsSync(codegraphBin)) throw new Error(`CodeGraph executable not found: ${codegraphBin}`);
if (arms.includes("codebase-memory") && !existsSync(codebaseMemoryBin)) throw new Error(`codebase-memory executable not found: ${codebaseMemoryBin}`);
if (arms.includes("tgrep") && !existsSync(tgrepBin)) throw new Error(`tgrep executable not found: ${tgrepBin}`);
let releaseBinding = null;

if (samples > 1) {
  const expectedTasks = new Set(repositories.flatMap((repository) => repository.tasks.map((task) => `${repository.id}:${task.id}`)));
  const taskKey = (entry) => `${entry.repository ?? entry.repository_id}:${entry.task ?? entry.task_id}`;
  const smokeAudits = new Map();
  if (smokeAuditPath !== undefined) smokeAudits.set("urdira-typescript", smokeAuditPath);
  if (smokeAuditsArgument !== undefined) {
    for (const assignment of smokeAuditsArgument.split(",")) {
      const separator = assignment.indexOf("=");
      if (separator <= 0 || separator === assignment.length - 1) throw new Error("--smoke-audits must contain comma-separated arm=path assignments");
      smokeAudits.set(assignment.slice(0, separator).trim(), assignment.slice(separator + 1).trim());
    }
  }
  for (const arm of arms) {
    const path = smokeAudits.get(arm);
    if (path === undefined) {
      smokeBlockedArms.push({ arm, reason: "missing_smoke_audit" });
      continue;
    }
    let smoke;
    try { smoke = JSON.parse(await readFile(resolve(path), "utf8")); } catch (error) {
      smokeBlockedArms.push({ arm, reason: "unreadable_smoke_audit", audit: path, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const successful = (smoke.runs ?? []).filter((entry) => entry != null && expectedTasks.has(taskKey(entry)) && entry?.exit_code === 0 && entry?.manifest?.completed_successfully === true && (entry.arm ?? entry.manifest?.arm) === arm);
    const groups = new Set(successful.map(taskKey));
    const passed = !(smoke.failed_runs !== undefined && smoke.failed_runs !== 0 || successful.length !== expectedTasks.size || groups.size !== expectedTasks.size || [...expectedTasks].some((task) => !groups.has(task)));
    if (!passed) {
      smokeBlockedArms.push({ arm, reason: "smoke_gate_failed", audit: path, successful: successful.length, failed: smoke.failed_runs ?? "unknown", groups: groups.size, expected: expectedTasks.size });
      continue;
    }
    smokeGateResults.push({ arm, audit: path, successful: successful.length, expected: expectedTasks.size });
  }
  if (smokeGateResults.length === 0) throw new Error(`No selected arm has passed its smoke gate: blocked=${JSON.stringify(smokeBlockedArms)}`);
  arms = smokeGateResults.map(({ arm }) => arm);
}

const run = (command, args, options = {}) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  const processMetrics = options.measureProcessTree ? { scope: "cell_runner_process_tree", peak_rss_kib: 0, peak_process_count: 0, cpu_percent_samples: [], sample_count: 0, started_at: Date.now() } : null;
  const sample = () => {
    if (processMetrics === null || child.pid === undefined) return;
    const snapshot = sampleProcessTree(child.pid);
    if (snapshot === null) return;
    processMetrics.peak_rss_kib = Math.max(processMetrics.peak_rss_kib, snapshot.rss_kib);
    processMetrics.peak_process_count = Math.max(processMetrics.peak_process_count, snapshot.process_count);
    processMetrics.cpu_percent_samples.push(snapshot.cpu_percent);
    processMetrics.sample_count += 1;
  };
  sample();
  const metricsTimer = processMetrics === null ? null : setInterval(sample, 500);
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("error", reject);
  child.on("close", (code, signal) => {
    sample();
    if (metricsTimer !== null) clearInterval(metricsTimer);
    const finalizedMetrics = processMetrics === null ? undefined : {
      scope: processMetrics.scope,
      peak_rss_kib: processMetrics.peak_rss_kib,
      peak_process_count: processMetrics.peak_process_count,
      mean_cpu_percent: processMetrics.cpu_percent_samples.length === 0 ? null : processMetrics.cpu_percent_samples.reduce((sum, value) => sum + value, 0) / processMetrics.cpu_percent_samples.length,
      sample_count: processMetrics.sample_count,
      duration_ms: Date.now() - processMetrics.started_at,
    };
    resolvePromise({ code: code ?? 1, signal, stdout, stderr, process_metrics: finalizedMetrics });
  });
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

const ownedProcessInventory = ({ roots: ownedRoots }) => {
  const result = spawnSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ps failed: ${result.stderr || result.stdout || result.status}`);
  const roots = ownedRoots.filter((path) => typeof path === "string" && path.length > 0);
  return (result.stdout ?? "").split("\n").map((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/u);
    return match === null ? null : { pid: Number(match[1]), command: match[2] };
  }).filter((entry) => entry !== null && entry.pid !== process.pid && roots.some((path) => entry.command.includes(path)));
};

const orderFor = (sample, repoIndex, taskIndex) => {
  const rotation = (sample - 1 + repoIndex + taskIndex) % arms.length;
  return arms.slice(rotation).concat(arms.slice(0, rotation));
};

const sha256File = (path) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
const fingerprint = (path) => {
  if (!path || !existsSync(path)) return null;
  const realpath = realpathSync(path);
  const stat = statSync(realpath);
  return { path: resolve(path), realpath, bytes: stat.size, sha256: sha256File(realpath) };
};
const firstExistingPath = (paths) => paths.filter((path) => typeof path === "string" && path.length > 0).find((path) => existsSync(path)) ?? null;
const readJsonField = (path, field) => {
  if (!path || !existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"))?.[field];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch { return null; }
};
const readNestedJsonField = (path, outer, field) => {
  if (!path || !existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"))?.[outer]?.[field];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch { return null; }
};
const extractDeclaredIdentity = (path, constant) => {
  if (!path || !existsSync(path)) return null;
  try {
    const match = readFileSync(path, "utf8").match(new RegExp(`(?:export\\s+)?const\\s+${constant}\\s*=\\s*["']([^"']+)["']`, "u"));
    return match?.[1] ?? null;
  } catch { return null; }
};
const gitText = (args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "").trim() : null;
};
mkdirSync(outputDir, { recursive: true });
mkdirSync(worktreeRoot, { recursive: true });
const disk = statfsSync(outputDir);
const cpuModels = [...new Set(cpus().map((cpu) => cpu.model))];
const relevantEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => /^(?:URDIRA_V4|URDIRA_V4_RESIDUAL|URDIRA_LEXICAL_INDEX|URDIRA_LEXICAL_OWNED_BY_RUST|URDIRA_NATIVE_REQUIRED|URDIRA_BENCHMARK_TIMEOUT_MS|URDIRA_INDEXING_CORE_TIMEOUT_MS|CARGO_TARGET_DIR|CI)$/u.test(name))
  .sort(([left], [right]) => left.localeCompare(right)));
const nativeTargetPackage = process.platform === "darwin" && process.arch === "arm64"
  ? "@urdira/native-darwin-arm64"
  : process.platform === "darwin" && process.arch === "x64"
    ? "@urdira/native-darwin-x64"
    : process.platform === "linux" && process.arch === "arm64"
      ? "@urdira/native-linux-arm64-gnu"
      : process.platform === "linux" && process.arch === "x64"
        ? "@urdira/native-linux-x64-gnu"
        : process.platform === "win32" && process.arch === "x64" ? "@urdira/native-win32-x64" : null;
const nativePackageRoot = nativeTargetPackage === null ? null : join(root, "node_modules", nativeTargetPackage);
const nativeAddonPath = firstExistingPath([
  nativePackageRoot === null ? null : join(nativePackageRoot, "native", "urdira-native.node"),
  join(root, "packages/native/native/urdira-native.node"),
]);
const nativeWorkerPath = firstExistingPath([
  nativePackageRoot === null ? null : join(nativePackageRoot, "native", process.platform === "win32" ? "urdira-jsts-syntax-worker.exe" : "urdira-jsts-syntax-worker"),
  join(root, "target/release", process.platform === "win32" ? "urdira-jsts-syntax-worker.exe" : "urdira-jsts-syntax-worker"),
]);
const indexingWorkerPath = firstExistingPath([
  process.env.URDIRA_INDEXING_CORE_WORKER_PATH,
  join(root, "target/release", process.platform === "win32" ? "urdira-indexing-worker.exe" : "urdira-indexing-worker"),
]);
const pluginPackageJson = join(root, "packages/plugin-javascript-typescript/package.json");
const nativePackageJson = nativePackageRoot === null ? null : join(nativePackageRoot, "package.json");
const urdiraArtifacts = {
  indexing_worker: fingerprint(indexingWorkerPath),
  native_addon: fingerprint(nativeAddonPath),
  native_syntax_worker: fingerprint(nativeWorkerPath),
  native_package_manifest: fingerprint(nativePackageJson),
  apps_urdira_dist: fingerprint(join(root, "apps/urdira/dist/index.js")),
  daemon_dist: fingerprint(join(root, "packages/daemon/dist/index.js")),
  mcp_dist: fingerprint(join(root, "packages/mcp/dist/index.js")),
  plugin_dist: fingerprint(join(root, "packages/plugin-javascript-typescript/dist/index.js")),
  plugin_package_manifest: fingerprint(pluginPackageJson),
};
const urdiraBuildIdentities = {
  native_component_build_id: readNestedJsonField(nativePackageJson, "urdiraNative", "build_id"),
  plugin_version: readJsonField(pluginPackageJson, "version"),
  plugin_rust_syntax_build_identity: extractDeclaredIdentity(join(root, "packages/plugin-javascript-typescript/src/syntax-protocol.ts"), "JSTS_RUST_SYNTAX_BUILD_IDENTITY"),
  plugin_semantic_process_build_identity: extractDeclaredIdentity(join(root, "packages/plugin-javascript-typescript/src/semantic-process-transport.ts"), "JSTS_SEMANTIC_PROCESS_BUILD_IDENTITY"),
};
const dirtyDiff = spawnSync("git", ["diff", "--binary", "HEAD"], { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
const environmentManifest = {
  captured_at: new Date().toISOString(),
  host: {
    platform: platform(),
    release: release(),
    architecture: arch(),
    logical_cpus: cpus().length,
    cpu_models: cpuModels,
    total_memory_bytes: totalmem(),
    free_memory_bytes_at_start: freemem(),
    load_average_at_start: loadavg(),
    output_filesystem_free_bytes_at_start: disk.bavail * disk.bsize,
  },
  source: {
    git_head: gitText(["rev-parse", "HEAD"]),
    git_status: gitText(["status", "--short"]),
    dirty_diff_sha256: dirtyDiff.status === 0 ? `sha256:${createHash("sha256").update(dirtyDiff.stdout ?? "").digest("hex")}` : null,
    corpus: fingerprint(corpusPath),
    driver: fingerprint(fileURLToPath(import.meta.url)),
    runner: fingerprint(runner),
    grader: fingerprint(join(root, "release/benchmarks/expanded-agent-benchmark-grader.mjs")),
    reporter: fingerprint(join(root, "release/benchmarks/render-expanded-agent-report.mjs")),
    transcript_metrics: fingerprint(join(root, "release/benchmarks/expanded-agent-transcript-metrics.mjs")),
    process_tree_sampler: fingerprint(join(root, "release/benchmarks/benchmark-process-tree.mjs")),
    urdira_mcp_entry: fingerprint(join(root, "release/benchmarks/expanded-urdira-mcp-entry.mjs")),
    urdira_mcp: fingerprint(join(root, "packages/mcp/dist/index.js")),
    expanded_agent_timing: fingerprint(join(root, "release/benchmarks/expanded-agent-timing.mjs")),
    urdira_worker_attestation: fingerprint(join(root, "release/benchmarks/urdira-worker-attestation.mjs")),
    urdira_artifacts: urdiraArtifacts,
    urdira_build_identities: urdiraBuildIdentities,
  },
  executables: {
    node: fingerprint(nodeBin),
    codex: fingerprint(codex),
    codebase_memory: arms.includes("codebase-memory") ? fingerprint(codebaseMemoryBin) : null,
    codegraph: arms.includes("codegraph") ? fingerprint(codegraphBin) : null,
    tgrep: arms.includes("tgrep") ? fingerprint(tgrepBin) : null,
  },
  runtime: {
    node_version: process.version,
    model: corpus.model,
    urdira_semantic_index: false,
    urdira_semantic_materialization: false,
    urdira_semantic_sidecar_creation: false,
    urdira_readiness_boundary: "structural",
    urdira_analysis_workers: 1,
    urdira_analysis_pool_max: 1,
    urdira_structural_concurrency: 1,
    inherited_relevant_environment: relevantEnvironment,
  },
};

writeFileSync(join(dirname(outputDir), "expanded-latest"), `${outputDir}\n`, "utf8");
const audit = {
  campaign_id: `expanded-typescript-agent-${new Date().toISOString()}`,
  generated_at: new Date().toISOString(),
  corpus: corpusPath,
  model: corpus.model,
  node: process.version,
  environment: environmentManifest,
  samples_per_cell: samples,
  independent_campaigns: independentCampaigns,
  requested_arms: requestedArms,
  arms,
  smoke_gate: { required: samples > 1, passed: samples === 1 || smokeGateResults.length > 0, eligible: smokeGateResults, blocked: smokeBlockedArms },
  repositories: repositories.map(({ id, repository, source_ref, commit, size_tier, tasks }) => ({ id, repository, source_ref: source_ref ?? commit, commit, size_tier, tasks: tasks.map(({ id, complexity, scenario }) => ({ id, complexity, scenario })) })),
  output_dir: outputDir,
  release_binding: releaseBinding,
  runs: [],
};

for (let sample = 1; sample <= samples; sample += 1) {
  for (let repoIndex = 0; repoIndex < repositories.length; repoIndex += 1) {
    const repo = repositories[repoIndex];
    const repositoryRoot = join(repositoriesRoot, repo.id);
    if (!existsSync(join(repositoryRoot, ".git"))) throw new Error(`Repository checkout is unavailable: ${repositoryRoot}`);
    if (releaseBinding === null && arms.includes("urdira-typescript")) {
      releaseBinding = assertReleaseBinding({ archiveRoot: releaseRoot, archivePath: releaseArchive });
      audit.release_binding = releaseBinding;
    }
    for (let taskIndex = 0; taskIndex < repo.tasks.length; taskIndex += 1) {
      const task = repo.tasks[taskIndex];
      for (const arm of orderFor(sample, repoIndex, taskIndex)) {
        assertCleanupGateOpen(cleanupGuardPath);
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
          const timeoutMs = cellTimeoutMs(repo);
          result = await run(nodeBin, [runner, "--repository-id", repo.id, "--task-id", task.id, "--arm", arm, "--sample", String(sample), "--phase", "warm", "--worktree", worktree, "--data-root", dataRoot, "--output-dir", runOutput, "--commit", repo.commit, "--model", corpus.model, "--codex", codex, "--node", nodeBin, "--codegraph", codegraphBin, "--codebase-memory", codebaseMemoryBin, "--tgrep", tgrepBin, ...(releaseRoot ? ["--release-root", releaseRoot] : []), ...(releaseArchive ? ["--release-archive", releaseArchive] : [])], { cwd: root, env: { URDIRA_SEMANTIC_INDEX: "0", URDIRA_BENCHMARK_TIMEOUT_MS: String(timeoutMs), ...(arm === "urdira-typescript" ? { URDIRA_INDEXING_CORE_TIMEOUT_MS: String(timeoutMs) } : {}) }, measureProcessTree: true });
          const manifestPath = join(runOutput, `${runId}.json`);
          try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch { manifest = undefined; }
        } finally {
          const cleanup = await runCleanupCheckpoint({
            manifestPath: join(outputDir, "cleanup", `${runId}.json`),
            registeredPaths: [worktree, dataRoot, manifest?.agent_integration?.home].filter((path) => typeof path === "string"),
            filesystemPath: outputDir,
            minimumFreeBytes,
            cleanup: () => cleanupCell({ repositoryRoot, worktree, dataRoot, codebaseMemoryBin, codebaseMemoryProject: arm === "codebase-memory" ? `${repo.id}-${task.id}-${arm}-${sample}` : undefined }),
            listOwnedProcesses: () => ownedProcessInventory({ roots: [worktree, dataRoot, manifest?.agent_integration?.home].filter((path) => typeof path === "string") }),
            metadata: { run_id: runId, repository: repo.id, task: task.id, arm, sample },
          });
          audit.runs.push({ run_id: runId, repository: repo.id, task: task.id, scenario: task.scenario ?? null, size_tier: repo.size_tier ?? null, arm, sample, order_index: orderFor(sample, repoIndex, taskIndex).indexOf(arm), timeout_ms: cellTimeoutMs(repo), exit_code: result?.code ?? 1, elapsed_ms: Date.now() - started, process_metrics: result?.process_metrics ?? null, manifest, cleanup, stdout_tail: result?.stdout?.slice(-6000) ?? "", stderr_tail: result?.stderr?.slice(-6000) ?? "" });
          if (cleanup.status === "blocked") writeFileSync(cleanupGuardPath, `${JSON.stringify(cleanup, null, 2)}\n`, "utf8");
          writeFileSync(join(outputDir, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
        }
      }
    }
  }
}

const successful = audit.runs.filter((entry) => entry.manifest?.completed_successfully === true);
audit.successful_runs = successful.length;
audit.failed_runs = audit.runs.length - successful.length;
audit.expected_runs = repositories.reduce((count, repository) => count + repository.tasks.length, 0) * arms.length * samples;
audit.campaign_gate = { passed: audit.failed_runs === 0 && audit.runs.length === audit.expected_runs };
writeFileSync(join(outputDir, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output_dir: outputDir, successful_runs: audit.successful_runs, failed_runs: audit.failed_runs, expected_runs: audit.expected_runs }));
if (!audit.campaign_gate.passed) process.exitCode = 1;
