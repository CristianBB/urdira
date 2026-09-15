#!/usr/bin/env node
/* Execute the no-model cold/warm readiness probes for one definitive campaign. */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { assertCleanupGateOpen, DEFINITIVE_MINIMUM_FREE_BYTES, measurePath, parseMinimumFreeBytes, runCleanupCheckpoint } from "./benchmark-cleanup.mjs";
import { assertReleaseBinding } from "./release-binding.mjs";
import { inspectAgentValidationEnvironment, materializeAgentDependencyClosure } from "./agent-validation-environment.mjs";
import { DEFINITIVE_FROZEN_TASKS, buildReadinessManifest } from "./run-definitive-agent-campaign.mjs";
import { inspectProcessInventory, processTable, verifiedOwnedProcesses } from "./benchmark-process-inventory.mjs";

const root = fileURLToPath(new globalThis.URL("../..", import.meta.url));
const corpus = JSON.parse(readFileSync(join(root, "release/benchmarks/expanded-typescript-agent-benchmark.json"), "utf8"));
const sleep = (ms) => new Promise((resolvePromise) => globalThis.setTimeout(resolvePromise, ms));
const arg = (argv, name, fallback) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };
let activeRuntime;
let cancellationRequested = false;

function requestCancellation() {
  cancellationRequested = true;
  activeRuntime?.stop().catch(() => undefined);
}

export function buildReadinessQuery(workspaceId) {
  return {
    request_type: "query",
    query: {
      api_version: 3,
      scope: { scope_type: "single_workspace", workspace_id: workspaceId },
      expression: { expression_type: "operation", operation: "core:search_text", arguments: { pattern: "readinessProbeValue", syntax: "literal", case_sensitive: true } },
      options: {
        freshness: "current", wait_timeout_ms: 0, coverage_requirement: "accept_reported",
        evidence: { evidence: "summary", evidence_chain_depth: 1 },
        diagnostics: { diagnostics: "none", diagnostic_detail: false },
        snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 },
        registry: { registry: "none", include_payload_schemas: false },
        response_budget: { max_items: 100, max_characters: 20_000 },
      },
    },
  };
}

function statusPayload(response) {
  if (response?.outcome !== "success") throw new Error(`index status failed: ${JSON.stringify(response)}`);
  const payload = response.payload;
  const workspace = payload && typeof payload === "object" && Array.isArray(payload.workspaces) ? payload.workspaces[0] : undefined;
  if (workspace === undefined) throw new Error(`index status returned no workspace: ${JSON.stringify(response)}`);
  return workspace;
}

async function waitForReadiness(client, workspaceId, timestamps, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = statusPayload(await client.call("core:index_status", { api_version: 3, workspace_ids: [workspaceId] }));
    if (last.source_ready === true && timestamps.source_ready === null) timestamps.source_ready = performance.now();
    if (last.structural_ready === true) {
      if (timestamps.structural_ready === null) timestamps.structural_ready = performance.now();
      return last;
    }
    await sleep(50);
  }
  throw new Error(`structural readiness timeout for ${workspaceId}: ${JSON.stringify(last)}`);
}

function processMeasurement() {
  const memory = process.memoryUsage();
  return { rss_bytes: memory.rss, heap_used_bytes: memory.heapUsed, external_bytes: memory.external };
}

function storageMeasurement(dataRoot) {
  const errors = [];
  const bytes = measurePath(dataRoot, errors);
  return { path: resolve(dataRoot), bytes, errors };
}

function semanticSidecarCreated(dataRoot) {
  const names = [];
  const visit = (path, depth = 0) => {
    if (depth > 5 || !existsSync(path)) return;
    let entries;
    try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (/semantic/i.test(entry.name)) names.push(child);
      if (entry.isDirectory()) visit(child, depth + 1);
    }
  };
  visit(dataRoot);
  return names;
}

function queryPublication(response, status) {
  const payload = response?.payload;
  const pages = payload && typeof payload === "object" && Array.isArray(payload.pages) ? payload.pages : null;
  const completeness = payload && typeof payload === "object" ? payload.completeness ?? null : null;
  return {
    outcome: response?.outcome ?? null,
    snapshot_identity: status.current_snapshot_id ?? null,
    index_freshness: payload && typeof payload === "object" ? payload.index_freshness ?? null : null,
    page_count: pages?.length ?? null,
    completeness,
  };
}

export function blockedWarmProbe(cold) {
  return {
    workspace_id: cold.workspace_id ?? null,
    timestamps: { data_root_created: null, source_ready: null, structural_ready: null, validated_first_query: null, first_query_complete: null },
    setup_elapsed_ms: null, structural_readiness_ms: null, time_to_first_query_ms: null,
    snapshot_identity: null, page_completeness: null, semantic_index: false, semantic_materialization: false,
    semantic_sidecar_created: null, storage: null, process: null, freshness: null, publication: null,
    passed: false, failure: `warm probe blocked by cold failure: ${cold.failure ?? "unknown"}`,
  };
}

async function startDaemon(releaseRoot, dataRoot, verifiedWorker) {
  const inheritedWorker = process.env.URDIRA_INDEXING_CORE_WORKER_PATH;
  if (typeof inheritedWorker === "string" && inheritedWorker.length > 0 && (!existsSync(inheritedWorker) || realpathSync(inheritedWorker) !== realpathSync(verifiedWorker))) throw new Error(`readiness worker override is not archive-bound: ${inheritedWorker}`);
  process.env.URDIRA_INDEXING_CORE_WORKER_PATH = verifiedWorker;
  const app = await import(pathToFileURL(join(releaseRoot, "app/dist/index.js")).href);
  const daemon = await import(pathToFileURL(join(releaseRoot, "node_modules/@urdira/daemon/dist/index.js")).href);
  const options = await app.defaultDaemonOptions(dataRoot);
  const runtime = await daemon.DaemonRuntime.start({ ...options, data_root: dataRoot, semantic_index: false, semantic_descriptor: undefined, reconciliation_sweep_interval_ms: 0 });
  activeRuntime = runtime;
  return { runtime, client: new daemon.DaemonClient(runtime.endpoint, { request_timeout_ms: 120_000 }) };
}

export async function runReadinessPhase({ phase, releaseRoot, dataRoot, worktree, previousWorkspaceId, expectedSnapshotId, verifiedWorker, adapters = {} }) {
  const start = adapters.startDaemon ?? startDaemon;
  const wait = adapters.waitForReadiness ?? waitForReadiness;
  const measureStorage = adapters.storageMeasurement ?? storageMeasurement;
  const measureProcess = adapters.processMeasurement ?? processMeasurement;
  const findSemanticSidecars = adapters.semanticSidecarCreated ?? semanticSidecarCreated;
  const timestamps = { data_root_created: performance.now(), source_ready: null, structural_ready: null, validated_first_query: null, first_query_complete: null };
  let daemon;
  let workspaceId = previousWorkspaceId;
  let status = null;
  let queryResponse = null;
  try {
    daemon = await start(releaseRoot, dataRoot, verifiedWorker);
    if (phase === "cold") {
      const registration = await daemon.client.call("core:workspace_add", { args: [worktree], confirmed: true, selected_technology_ids: ["typescript"], selected_plugin_ids: ["urdira:javascript_typescript"] });
      if (registration.outcome !== "success") throw new Error(`workspace registration failed: ${JSON.stringify(registration)}`);
      workspaceId = registration.payload?.workspace_id;
      if (typeof workspaceId !== "string" || workspaceId.length === 0) throw new Error("workspace registration returned no workspace_id");
    }
    status = await wait(daemon.client, workspaceId, timestamps);
    if (phase === "warm" && expectedSnapshotId !== null && expectedSnapshotId !== undefined && status.current_snapshot_id !== expectedSnapshotId) {
      throw new Error(`warm probe snapshot changed: expected ${expectedSnapshotId}, observed ${status.current_snapshot_id ?? "null"}`);
    }
    timestamps.validated_first_query = performance.now();
    queryResponse = await daemon.client.call("core:query", buildReadinessQuery(workspaceId));
    timestamps.first_query_complete = performance.now();
    if (queryResponse.outcome !== "success") throw new Error(`readiness query failed: ${JSON.stringify(queryResponse)}`);
    const semanticSidecars = findSemanticSidecars(dataRoot);
    const snapshotIdentity = status.current_snapshot_id ?? null;
    const failure = semanticSidecars.length > 0
      ? "semantic sidecar was created while semantic indexing was disabled"
      : snapshotIdentity === null ? "structural readiness returned no snapshot identity" : null;
    return {
      workspace_id: workspaceId,
      timestamps,
      setup_elapsed_ms: timestamps.source_ready === null ? null : timestamps.source_ready - timestamps.data_root_created,
      structural_readiness_ms: timestamps.structural_ready === null ? null : timestamps.structural_ready - timestamps.data_root_created,
      time_to_first_query_ms: timestamps.first_query_complete === null ? null : timestamps.first_query_complete - timestamps.data_root_created,
      snapshot_identity: snapshotIdentity,
      page_completeness: queryPublication(queryResponse, status).completeness,
      semantic_index: false,
      semantic_materialization: false,
      semantic_sidecar_created: semanticSidecars.length > 0,
      semantic_sidecar_paths: semanticSidecars,
      storage: measureStorage(dataRoot),
      process: measureProcess(),
      freshness: { source: status.source_freshness ?? null, structural: status.structural_freshness ?? null, status: status.freshness_status ?? null },
      publication: queryPublication(queryResponse, status),
      passed: failure === null,
      failure,
    };
  } catch (error) {
    return {
      workspace_id: workspaceId ?? null,
      timestamps,
      setup_elapsed_ms: timestamps.source_ready === null ? null : timestamps.source_ready - timestamps.data_root_created,
      structural_readiness_ms: timestamps.structural_ready === null ? null : timestamps.structural_ready - timestamps.data_root_created,
      time_to_first_query_ms: timestamps.first_query_complete === null ? null : timestamps.first_query_complete - timestamps.data_root_created,
      snapshot_identity: status?.current_snapshot_id ?? null,
      page_completeness: queryResponse ? queryPublication(queryResponse, status).completeness : null,
      semantic_index: false, semantic_materialization: false, semantic_sidecar_created: null,
      storage: measureStorage(dataRoot), process: measureProcess(), freshness: null, publication: null,
      passed: false, failure: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await daemon?.runtime.stop().catch(() => undefined);
    if (activeRuntime === daemon?.runtime) activeRuntime = undefined;
  }
}

function processInventory(roots) {
  const table = processTable();
  if (table.length === 0) throw new Error("process inventory unavailable");
  return inspectProcessInventory(roots, table);
}

async function terminateOwnedProcesses(roots) {
  const entries = processInventory(roots);
  const owned = verifiedOwnedProcesses(entries);
  for (const entry of owned) {
    try { process.kill(entry.pid, "SIGTERM"); } catch { /* exited */ }
    if (entry.pgid > 1) { try { process.kill(-entry.pgid, "SIGTERM"); } catch { /* group exited */ } }
    globalThis.setTimeout(() => {
      try { process.kill(entry.pid, "SIGKILL"); } catch { /* exited */ }
      if (entry.pgid > 1) { try { process.kill(-entry.pgid, "SIGKILL"); } catch { /* group exited */ } }
    }, 500).unref?.();
  }
  if (owned.length > 0) await new Promise((resolvePromise) => globalThis.setTimeout(resolvePromise, 600));
  return { stopped_processes: owned, unverified_processes: entries.filter((entry) => !owned.includes(entry)) };
}

export async function executeReadinessPair({ probeRows, releaseRoot, repositoryRoot, repositoryId, campaign, outputRoot, dataRoot, minimumFreeBytes, verifiedWorker, nodeVersion, nodeExecutable = process.execPath, prepareDependencies, adapters = {} }) {
  const pairId = `${repositoryId}-${campaign}`;
  const pairRoot = join(outputRoot, pairId);
  const worktree = join(pairRoot, "checkout");
  const pairDataRoot = join(dataRoot, pairId);
  mkdirSync(pairRoot, { recursive: true });
  mkdirSync(dirname(pairDataRoot), { recursive: true });
  const repository = corpus.repositories.find((entry) => entry.id === repositoryId);
  if (!repository) throw new Error(`unknown frozen repository ${repositoryId}`);
  const frozen = DEFINITIVE_FROZEN_TASKS[repositoryId];
  if (repository.commit !== frozen.commit) throw new Error(`frozen commit drifted for ${repositoryId}`);
  let workspaceId;
  let cleanup;
  let dependencySetup = null;
  const probeIdentity = { task_id: frozen.task, prompt_sha256: frozen.prompt_sha256, commit: repository.commit, node_version: nodeVersion, model_invoked: false, semantic_index: false, semantic_materialization: false };
  try {
    const addWorktree = adapters.addWorktree ?? ((path, commit, cwd) => spawnSync("git", ["worktree", "add", "--detach", path, commit], { cwd, encoding: "utf8" }));
    const added = await addWorktree(worktree, repository.commit, repositoryRoot);
    if (added.status !== 0) throw new Error(`unable to create readiness worktree: ${added.stderr || added.stdout}`);
    const prepare = prepareDependencies ?? ((options) => materializeAgentDependencyClosure(options));
    try {
      dependencySetup = await prepare({ repositoryId, repositoryRoot, worktree, nodeExecutable });
      const task = repository.tasks.find((entry) => entry.id === frozen.task);
      const validate = adapters.validateDependencies ?? ((options) => inspectAgentValidationEnvironment(options.worktree, options.targetPaths, "/bin/zsh", options.nodeExecutable));
      const validation = await validate({ worktree, targetPaths: (task?.required_patterns ?? []).map((entry) => entry.path), nodeExecutable });
      dependencySetup = { ...dependencySetup, validation_environment: validation };
      if (validation.ready !== true) throw new Error(`Readiness dependency validation failed: ${JSON.stringify(validation)}`);
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      const coldFailure = blockedWarmProbe({ workspace_id: null, failure });
      probeRows.push({ probe_id: `${repositoryId}-cold-${campaign}`, campaign, repository: repository.repository, repository_id: repositoryId, ...probeIdentity, phase: "cold", dependency_setup: dependencySetup, ...coldFailure });
      probeRows.push({ probe_id: `${repositoryId}-warm-${campaign}`, campaign, repository: repository.repository, repository_id: repositoryId, ...probeIdentity, phase: "warm", dependency_setup: dependencySetup, ...blockedWarmProbe({ workspace_id: null, failure: `warm probe blocked by cold failure: ${failure}` }) });
      throw error;
    }
    const phaseRunner = adapters.runPhase ?? runReadinessPhase;
    const cold = await phaseRunner({ phase: "cold", releaseRoot, dataRoot: pairDataRoot, worktree, verifiedWorker, adapters: adapters.phaseAdapters });
    workspaceId = cold.workspace_id;
    probeRows.push({ probe_id: `${repositoryId}-cold-${campaign}`, campaign, repository: repository.repository, repository_id: repositoryId, ...probeIdentity, phase: "cold", dependency_setup: dependencySetup, ...cold });
    const warm = cold.passed !== true
      ? blockedWarmProbe(cold)
      : await phaseRunner({ phase: "warm", releaseRoot, dataRoot: pairDataRoot, worktree, previousWorkspaceId: workspaceId, expectedSnapshotId: cold.snapshot_identity, verifiedWorker, adapters: adapters.phaseAdapters });
    probeRows.push({ probe_id: `${repositoryId}-warm-${campaign}`, campaign, repository: repository.repository, repository_id: repositoryId, ...probeIdentity, phase: "warm", dependency_setup: dependencySetup, ...warm });
  } finally {
    const checkpoint = adapters.runCleanupCheckpoint ?? runCleanupCheckpoint;
    cleanup = await checkpoint({
      manifestPath: join(pairRoot, "cleanup.json"), registeredPaths: [worktree, pairDataRoot], filesystemPath: pairRoot,
      minimumFreeBytes, cleanup: async () => {
        const stop = adapters.terminateOwnedProcesses ?? terminateOwnedProcesses;
        const stopped = await stop([worktree, pairDataRoot]);
        const remove = adapters.removeWorktree ?? (() => spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: repositoryRoot, encoding: "utf8" }));
        const removed = await remove(worktree, repositoryRoot);
        const errors = [];
        if (removed.status !== 0 && existsSync(worktree)) errors.push(`worktree: ${removed.stderr || removed.stdout}`);
        try { rmSync(pairDataRoot, { recursive: true, force: true }); } catch (error) { errors.push(`data: ${error instanceof Error ? error.message : String(error)}`); }
        return { stopped_processes: stopped, errors };
      },
      listOwnedProcesses: adapters.listOwnedProcesses ?? (() => processInventory([worktree, pairDataRoot])), metadata: { pair_id: pairId, campaign, repository_id: repositoryId },
    });
    if (cleanup.status === "blocked") writeFileSync(join(outputRoot, "cleanup-block.json"), `${JSON.stringify(cleanup, null, 2)}\n`, { flag: "wx" });
  }
  if (cancellationRequested) throw new Error(`Readiness campaign cancelled during ${pairId}`);
  return cleanup;
}

export async function runReadinessCampaign({ campaign, releaseRoot, releaseArchive, repositoriesRoot, outputRoot, dataRoot, nodeBin = process.execPath, minimumFreeBytes = (parseMinimumFreeBytes(process.env.BENCH_MIN_FREE_BYTES) ?? DEFINITIVE_MINIMUM_FREE_BYTES) }) {
  if (!Number.isSafeInteger(campaign) || campaign < 1 || campaign > 3) throw new Error("campaign must be 1, 2, or 3");
  const version = spawnSync(nodeBin, ["--version"], { encoding: "utf8" });
  if (version.status !== 0 || version.stdout.trim() !== "v24.18.1") throw new Error(`Frozen definitive Node mismatch: expected v24.18.1, received ${version.stdout.trim() || version.stderr}`);
  const binding = assertReleaseBinding({ archiveRoot: releaseRoot, archivePath: releaseArchive });
  if (minimumFreeBytes !== DEFINITIVE_MINIMUM_FREE_BYTES) throw new Error(`definitive protocol requires BENCH_MIN_FREE_BYTES=${DEFINITIVE_MINIMUM_FREE_BYTES}`);
  const manifest = buildReadinessManifest({ campaign, outputRoot, dataRoot, runRoot: outputRoot, repositoriesRoot, nodeBin, indexingWorker: binding.components.indexing_worker.path, minimumFreeBytes });
  mkdirSync(outputRoot, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  const readinessRows = [];
  const writePartialManifest = () => {
    const partial = { ...manifest, release_binding: binding, readiness_probes: readinessRows, readiness_expected_probes: 6, probes: readinessRows, completed: readinessRows.length === 6, cancellation_requested: cancellationRequested };
    const manifestPath = join(outputRoot, "readiness-manifest.json");
    if (!existsSync(manifestPath)) writeFileSync(manifestPath, `${JSON.stringify(partial, null, 2)}\n`, { flag: "wx" });
    return manifestPath;
  };
  try {
    for (const [repositoryId] of Object.entries(DEFINITIVE_FROZEN_TASKS)) {
      assertCleanupGateOpen(join(outputRoot, "cleanup-block.json"));
      if (cancellationRequested) throw new Error("Readiness campaign cancelled before next pair");
      const repositoryRoot = join(repositoriesRoot, repositoryId);
      if (!existsSync(join(repositoryRoot, ".git"))) throw new Error(`Repository checkout is unavailable: ${repositoryRoot}`);
      await executeReadinessPair({ probeRows: readinessRows, releaseRoot, repositoryRoot, repositoryId, campaign, outputRoot, dataRoot, minimumFreeBytes, verifiedWorker: binding.components.indexing_worker.realpath, nodeVersion: version.stdout.trim(), nodeExecutable: nodeBin });
    }
  } catch (error) {
    writePartialManifest();
    throw error;
  }
  const output = { ...manifest, release_binding: binding, readiness_probes: readinessRows, readiness_expected_probes: 6, probes: readinessRows };
  const manifestPath = join(outputRoot, "readiness-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
  return { manifestPath, ...output };
}

async function main() {
  const argv = process.argv.slice(2);
  const campaign = Number(arg(argv, "--campaign", "1"));
  const outputRoot = resolve(arg(argv, "--output-root", join("/tmp", `urdira-readiness-${campaign}`)));
  const dataRoot = resolve(arg(argv, "--data-root", join(outputRoot, "data")));
  const repositoriesRoot = resolve(arg(argv, "--repositories-root", join("/tmp", "urdira-definitive", "repos")));
  const releaseRoot = resolve(arg(argv, "--release-root", process.env.URDIRA_RELEASE_ROOT ?? ""));
  const releaseArchive = resolve(arg(argv, "--release-archive", process.env.URDIRA_RELEASE_ARCHIVE ?? ""));
  if (argv.includes("--plan-only")) {
    const plan = buildReadinessManifest({ campaign, outputRoot, dataRoot, runRoot: outputRoot, repositoriesRoot, nodeBin: arg(argv, "--node", process.execPath) });
    mkdirSync(outputRoot, { recursive: true });
    writeFileSync(join(outputRoot, "readiness-manifest.json"), `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify({ probes: plan.probes.length, model_invoked: false })}\n`);
    return;
  }
  process.once("SIGINT", requestCancellation);
  process.once("SIGTERM", requestCancellation);
  process.env.URDIRA_SEMANTIC_INDEX = "0";
  process.env.URDIRA_NATIVE_REQUIRED = "1";
  process.env.URDIRA_NATIVE_ROOT = join(releaseRoot, "native");
  const result = await runReadinessCampaign({ campaign, releaseRoot, releaseArchive, repositoriesRoot, outputRoot, dataRoot, nodeBin: arg(argv, "--node", process.execPath) });
  process.stdout.write(`${JSON.stringify({ manifest: result.manifestPath, probes: result.readiness_probes.length, model_invoked: false })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();
