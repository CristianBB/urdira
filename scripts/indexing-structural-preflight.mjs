#!/usr/bin/env node
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { clearInterval, setInterval } from "node:timers";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  computeNativeAccelerationCorpusDigest,
  createNativeAccelerationController,
  nativeAccelerationMutationTraceDigest,
} from "./native-acceleration-controller.mjs";
import { directoryBytes } from "./directory-bytes.mjs";
import { hostNativeTarget, stageNativeArtifacts } from "./native-release.mjs";

const execFileAsync = promisify(execFile);
const EXPECTED_N8N_DIGEST = "sha256:1dd28be497b20c5f1b3585dd7438e69060ef5a2fbe5660a5e7f5d728a492d2ed";
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/u;
const SKIPPED_SEGMENTS = new Set([".git", ".urdira", "coverage", "dist", "node_modules"]);
const SKIPPED_PREFIXES = ["tests/baselines/", "tests/cases/"];

function sha256(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function fail(message) { throw new Error(`Structural preflight: ${message}`); }

function argumentsOf(argv) {
  const result = { owners: [512, 1000], readiness_timeout_ms: 120_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--") continue;
    const value = argv[index + 1];
    if (!["--corpus", "--mutation-trace", "--native-root", "--output", "--runtime-module", "--owners", "--readiness-timeout-ms"].includes(key) || value === undefined) fail(`unknown or incomplete argument ${key}.`);
    if (key === "--owners") {
      result.owners = value.split(",").map(Number);
      if (result.owners.some((entry) => !Number.isSafeInteger(entry) || entry <= 0)) fail("--owners must be positive comma-separated integers.");
    } else if (key === "--readiness-timeout-ms") {
      const timeout = Number(value);
      if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 24 * 60 * 60 * 1_000) fail("--readiness-timeout-ms must be an integer from 1000 through 86400000.");
      result.readiness_timeout_ms = timeout;
    } else result[key.slice(2).replaceAll("-", "_")] = resolve(value);
    index += 1;
  }
  for (const field of ["corpus", "mutation_trace", "native_root", "output"]) {
    if (!isAbsolute(result[field] ?? "")) fail(`--${field.replaceAll("_", "-")} requires an absolute path.`);
  }
  result.runtime_module ??= resolve("apps/urdira/dist/index.js");
  return result;
}

async function walk(root, directory = root, paths = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (SKIPPED_SEGMENTS.has(entry.name) || entry.isSymbolicLink()) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) await walk(root, absolute, paths);
    else if (entry.isFile()) paths.push(relative(root, absolute).split(sep).join("/"));
  }
  return paths;
}

async function copyPath(sourceRoot, targetRoot, path) {
  const source = join(sourceRoot, ...path.split("/"));
  if ((await lstat(source).catch(() => undefined))?.isFile() !== true) return false;
  const target = join(targetRoot, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  return true;
}

export async function createSlice(corpus, root, owners) {
  const allPaths = await walk(corpus);
  const ownerPaths = allPaths.filter((path) => SOURCE_EXTENSION.test(path) && !SKIPPED_PREFIXES.some((prefix) => path.startsWith(prefix))).slice(0, owners);
  if (ownerPaths.length !== owners) fail(`corpus exposes only ${ownerPaths.length} source owners for requested slice ${owners}.`);
  const selected = new Set(ownerPaths);
  for (const path of ownerPaths) {
    let directory = dirname(path);
    for (;;) {
      for (const config of ["package.json", "tsconfig.json", "jsconfig.json"]) {
        const candidate = directory === "." ? config : `${directory}/${config}`;
        if (allPaths.includes(candidate)) selected.add(candidate);
      }
      if (directory === ".") break;
      directory = dirname(directory);
    }
  }
  await Promise.all([...selected].map((path) => copyPath(corpus, root, path)));
  const manifestHash = createHash("sha256");
  for (const path of ownerPaths) {
    const bytes = await readFile(join(root, ...path.split("/")));
    manifestHash.update(`${Buffer.byteLength(path)}:${path}${sha256(bytes)}\n`);
  }
  return { owner_paths: ownerPaths, owner_manifest_digest: `sha256:${manifestHash.digest("hex")}` };
}

export async function prepareNativeRoot(artifactRoot) {
  const directManifest = join(artifactRoot, "manifest.json");
  if ((await lstat(directManifest).catch(() => undefined))?.isFile() === true) {
    return { native_root: artifactRoot, cleanup: async () => undefined };
  }
  const target = hostNativeTarget();
  if (target === undefined) fail(`unsupported native host ${process.platform}/${process.arch}.`);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "urdira-native-preflight-"));
  try {
    await stageNativeArtifacts({ artifactRoot, stageRoot: temporaryRoot, target });
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    native_root: join(temporaryRoot, "native"),
    cleanup: async () => rm(temporaryRoot, { recursive: true, force: true }),
  };
}

function traceFor(baseDigest) {
  const content = Buffer.from("export const preflight = 1;\n");
  const contentDigest = sha256(content);
  return {
    schema_version: 1,
    trace_id: "n8n-structural-preflight-placeholder",
    base_corpus_digest: baseDigest,
    excluded_paths: [],
    mutations: Array.from({ length: 60 }, (_, mutation_index) => ({
      mutation_index,
      mutation_id: `unused-${mutation_index}`,
      category: "content",
      changes: [{ kind: "write", path: "__unused_preflight__.ts", before_digest: contentDigest, after_digest: contentDigest, content_base64: content.toString("base64") }],
      resulting_corpus_digest: baseDigest,
    })),
  };
}

async function processTreeRssBytes(rootPid) {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss="]);
  const rows = stdout.trim().split("\n").flatMap((line) => {
    const [pid, ppid, rss] = line.trim().split(/\s+/u).map(Number);
    return Number.isSafeInteger(pid) && Number.isSafeInteger(ppid) && Number.isFinite(rss) ? [{ pid, ppid, rss }] : [];
  });
  const included = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (!included.has(row.pid) && included.has(row.ppid)) { included.add(row.pid); changed = true; }
  }
  return rows.filter((row) => included.has(row.pid)).reduce((sum, row) => sum + row.rss * 1024, 0);
}

async function runSlice(options, ownerCount) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), `urdira-n8n-preflight-${ownerCount}-`));
  const corpus = join(temporaryRoot, "corpus");
  const dataRoot = join(temporaryRoot, "data");
  const tracePath = join(temporaryRoot, "trace.json");
  await mkdir(corpus);
  let controller;
  try {
    const slice = await createSlice(options.corpus, corpus, ownerCount);
    const corpusDigest = await computeNativeAccelerationCorpusDigest(corpus, []);
    const traceBytes = Buffer.from(`${JSON.stringify(traceFor(corpusDigest))}\n`);
    await writeFile(tracePath, traceBytes);
    const controllerConfig = {
      schema_version: 2, lane: "candidate", corpus_path: corpus, mutation_trace_path: tracePath, data_root: dataRoot,
      runtime_module: options.runtime_module,
      workspace_selection: { selected_technology_ids: ["typescript"], selected_plugin_ids: ["urdira:javascript_typescript"] },
      qualification: { mode: "qualifying", corpus_tier: "L", cache_state: "cold", applied_limits: { max_indexing_cores: 6, max_rss_bytes: 8 * 1024 ** 3 }, capture_phase_timings: true },
      // Keep readiness observation below the 500 ms stability window.  A
      // one-second poll interval adds up to two seconds of measurement-only
      // latency after Rust has already committed the visible snapshot.
      polling: { interval_ms: 100, readiness_timeout_ms: options.readiness_timeout_ms },
    };
    controller = await createNativeAccelerationController(controllerConfig);
    const mutationTraceDigest = nativeAccelerationMutationTraceDigest(traceBytes);
    const common = { schema_version: 2, campaign_id: `n8n-preflight-${ownerCount}`, lane: "candidate", target: `${process.platform}-${process.arch}`, corpus_path: corpus, corpus_digest: corpusDigest, mutation_trace_digest: mutationTraceDigest };
    await controller.handle({ ...common, request_id: `prepare-${ownerCount}`, operation: "prepare" });
    let peakRssBytes = 0;
    // Sampling is telemetry only. Under a very large corpus the host can
    // briefly exhaust its process-spawn descriptors while the daemon is
    // starting; that must not turn a valid indexing run into a false engine
    // failure. The final sample below remains authoritative when a poll is
    // skipped.
    const sampler = setInterval(() => { void processTreeRssBytes(process.pid).then((value) => { peakRssBytes = Math.max(peakRssBytes, value); }).catch(() => undefined); }, 50);
    const startedAt = performance.now();
    const cold = await controller.handle({ ...common, request_id: `cold-${ownerCount}`, operation: "cold_index" }).finally(() => clearInterval(sampler));
    peakRssBytes = Math.max(peakRssBytes, await processTreeRssBytes(process.pid));
    const wallMs = performance.now() - startedAt;
    const phaseMs = cold.phase_timings.phases.reduce((sum, phase) => sum + phase.duration_ms, 0);
    const reconciliationError = wallMs === 0 ? 0 : Math.abs(wallMs - phaseMs) / wallMs;
    return {
      owner_count: ownerCount,
      owner_manifest_digest: slice.owner_manifest_digest,
      corpus_digest: corpusDigest,
      wall_ms: Math.round(wallMs * 1000) / 1000,
      phase_timings: cold.phase_timings,
      reconciliation_error_ratio: Math.round(reconciliationError * 1e6) / 1e6,
      reconciliation_within_five_percent: reconciliationError <= 0.05,
      peak_process_tree_rss_bytes: peakRssBytes,
      final_data_root_bytes: await directoryBytes(dataRoot, await walk(dataRoot)),
      visible_set_digest: cold.visible_set_digest,
    };
  } finally {
    await controller?.dispose().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function runStructuralPreflight(argv = process.argv.slice(2)) {
  const options = argumentsOf(argv);
  const trace = JSON.parse(await readFile(options.mutation_trace, "utf8"));
  const fullDigest = await computeNativeAccelerationCorpusDigest(options.corpus, trace.excluded_paths ?? []);
  if (fullDigest !== EXPECTED_N8N_DIGEST || trace.base_corpus_digest !== EXPECTED_N8N_DIGEST) fail(`retained corpus identity mismatch: ${fullDigest}.`);
  const nativeClosure = await prepareNativeRoot(options.native_root);
  const envNames = ["URDIRA_NATIVE_REQUIRED", "URDIRA_NATIVE_ROOT", "URDIRA_ANALYSIS_POOL", "URDIRA_SEMANTIC_INDEX"];
  const previousEnvironment = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  try {
    process.env["URDIRA_NATIVE_REQUIRED"] = "1";
    process.env["URDIRA_NATIVE_ROOT"] = nativeClosure.native_root;
    // Leave the semantic-checker pool at its configured default. The Rust
    // composition worker remains the sole publication owner; pooling only
    // reuses the checker session's immutable AST/program state and avoids a
    // second whole-project TypeScript rebuild during stage 3. Callers can
    // still set URDIRA_ANALYSIS_POOL=0 for an explicit stateless oracle run.
    process.env["URDIRA_SEMANTIC_INDEX"] = "0";
    const samples = [];
    for (const owners of options.owners) samples.push(await runSlice(options, owners));
    const report = { schema_version: 1, corpus_digest: fullDigest, generated_at: new Date().toISOString(), samples };
    const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, bytes);
    await writeFile(`${options.output}.sha256`, `${sha256(bytes)}  ${options.output.split(sep).at(-1)}\n`);
    return report;
  } finally {
    for (const name of envNames) {
      const previous = previousEnvironment[name];
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
    await nativeClosure.cleanup();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runStructuralPreflight().then((report) => process.stdout.write(`${JSON.stringify(report)}\n`)).catch((error) => { console.error(error); process.exitCode = 1; });
}
