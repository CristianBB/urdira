import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, opendir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { arch, cpus, hostname, platform, release, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { finished } from "node:stream/promises";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  computeNativeAccelerationCorpusDigest,
  nativeAccelerationControllerConfigDigest,
  validateNativeAccelerationControllerConfig,
  validateNativeAccelerationMutationTrace,
} from "./native-acceleration-controller.mjs";

const MANIFEST_SCHEMA_VERSION = 2;
const REPORT_SCHEMA_VERSION = 2;
const CONTROLLER_SCHEMA_VERSION = 2;
const SAMPLE_COUNT = 60;
const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024;
const MAX_INDEXING_CORES = 6;
const MAX_INDEXING_RSS_BYTES = 8 * 1024 ** 3;
const TARGETS = new Set(["darwin-arm64", "darwin-x64", "linux-arm64-gnu", "linux-x64-gnu", "win32-x64"]);
const RUST_TARGETS = Object.freeze({
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64-gnu": "aarch64-unknown-linux-gnu",
  "linux-x64-gnu": "x86_64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
});
const LANES = Object.freeze(["baseline", "candidate"]);
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const activeControllers = new Set();

function fail(message) {
  throw new Error(`Invalid native acceleration campaign manifest: ${message}`);
}

function evidenceFail(message) {
  throw new Error(`Invalid native acceleration campaign evidence: ${message}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireClosedObject(value, field, keys) {
  if (!isRecord(value)) fail(`${field} must be an object.`);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) fail(`${field} contains unknown fields: ${unknown.join(", ")}.`);
}

function requireExactEvidenceKeys(value, field, keys) {
  if (!isRecord(value)) evidenceFail(`${field} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) evidenceFail(`${field} has unknown or missing fields.`);
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) fail(`${field} must be a non-empty string.`);
  return value;
}

function requireDigest(value, field) {
  const digest = requireString(value, field);
  if (!SHA256_PATTERN.test(digest)) fail(`${field} must be a lowercase sha256 digest.`);
  return digest;
}

function requireNullableDigest(value, field) {
  return value === null ? null : requireDigest(value, field);
}

function requireAbsolute(value, field, kind) {
  const path = requireString(value, field);
  if (!isAbsolute(path)) fail(`${field} must be an absolute ${kind}.`);
  return resolve(path);
}

function requirePositiveInteger(value, field, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${field} must be an integer from ${minimum} through ${maximum}.`);
  return value;
}

function validateCommand(value, field) {
  requireClosedObject(value, field, ["executable", "args", "cwd", "environment"]);
  const executable = requireAbsolute(value.executable, `${field}.executable`, "executable");
  const cwd = requireAbsolute(value.cwd, `${field}.cwd`, "working directory");
  if (!Array.isArray(value.args) || value.args.some((argument) => typeof argument !== "string")) fail(`${field}.args must be an explicit string array.`);
  if (!isRecord(value.environment)) fail(`${field}.environment must be an explicit object; the parent environment is never inherited.`);
  const environment = {};
  for (const [name, setting] of Object.entries(value.environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || typeof setting !== "string") fail(`${field}.environment must contain only string environment entries with portable names.`);
    environment[name] = setting;
  }
  return { executable, args: [...value.args], cwd, environment };
}

function validateLane(value, field, lane) {
  requireClosedObject(value, field, ["command", "provenance"]);
  requireClosedObject(value.provenance, `${field}.provenance`, [
    "revision",
    "build_id",
    "configuration_digest",
    "controller_executable_digest",
    "runtime_module_digest",
    "cargo_lock_digest",
    "native_manifest_digest",
    "native_closure_digest",
  ]);
  const revision = requireString(value.provenance.revision, `${field}.provenance.revision`);
  if (!REVISION_PATTERN.test(revision)) fail(`${field}.provenance.revision must be an exact lowercase Git object id.`);
  const nativeManifestDigest = requireNullableDigest(value.provenance.native_manifest_digest, `${field}.provenance.native_manifest_digest`);
  const nativeClosureDigest = requireNullableDigest(value.provenance.native_closure_digest, `${field}.provenance.native_closure_digest`);
  if (lane === "baseline" && (nativeManifestDigest !== null || nativeClosureDigest !== null)) fail(`${field}.provenance native digests must be null for the TypeScript baseline.`);
  if (lane === "candidate" && (nativeManifestDigest === null || nativeClosureDigest === null)) fail(`${field}.provenance native digests are required for the Rust candidate.`);
  return {
    command: validateCommand(value.command, `${field}.command`),
    provenance: {
      revision,
      build_id: requireString(value.provenance.build_id, `${field}.provenance.build_id`),
      configuration_digest: requireDigest(value.provenance.configuration_digest, `${field}.provenance.configuration_digest`),
      controller_executable_digest: requireDigest(value.provenance.controller_executable_digest, `${field}.provenance.controller_executable_digest`),
      runtime_module_digest: requireDigest(value.provenance.runtime_module_digest, `${field}.provenance.runtime_module_digest`),
      cargo_lock_digest: requireDigest(value.provenance.cargo_lock_digest, `${field}.provenance.cargo_lock_digest`),
      native_manifest_digest: nativeManifestDigest,
      native_closure_digest: nativeClosureDigest,
    },
  };
}

export function currentNativeAccelerationTarget() {
  const key = `${platform()}:${arch()}`;
  const target = {
    "darwin:arm64": "darwin-arm64",
    "darwin:x64": "darwin-x64",
    "linux:arm64": "linux-arm64-gnu",
    "linux:x64": "linux-x64-gnu",
    "win32:x64": "win32-x64",
  }[key];
  if (target === undefined) throw new Error(`Unsupported native acceleration campaign host ${key}.`);
  return target;
}

export function validateNativeAccelerationCampaignManifest(value) {
  requireClosedObject(value, "the root", ["schema_version", "campaign_id", "target", "corpus", "sample_count", "execution_order", "rss_sample_interval_ms", "qualification", "timeouts", "lanes"]);
  if (value.schema_version !== MANIFEST_SCHEMA_VERSION) fail(`schema_version must be ${MANIFEST_SCHEMA_VERSION}.`);
  const campaignId = requireString(value.campaign_id, "campaign_id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(campaignId)) fail("campaign_id contains unsupported characters.");
  const target = requireString(value.target, "target");
  if (!TARGETS.has(target)) fail("target is not in the closed native target set.");
  if (target !== currentNativeAccelerationTarget()) fail(`target ${target} does not match this host (${currentNativeAccelerationTarget()}).`);
  requireClosedObject(value.corpus, "corpus", ["digest", "mutation_trace_digest", "baseline_path", "candidate_path"]);
  const baselinePath = requireAbsolute(value.corpus.baseline_path, "corpus.baseline_path", "corpus path");
  const candidatePath = requireAbsolute(value.corpus.candidate_path, "corpus.candidate_path", "corpus path");
  if (baselinePath === candidatePath) fail("baseline and candidate corpus paths must be separate mutable copies.");
  if (value.sample_count !== SAMPLE_COUNT) fail(`sample_count must be exactly ${SAMPLE_COUNT}.`);
  if (!Array.isArray(value.execution_order) || value.execution_order.length !== 2 || new Set(value.execution_order).size !== 2 || value.execution_order.some((lane) => !LANES.includes(lane))) {
    fail("execution_order must contain baseline and candidate exactly once.");
  }
  requireClosedObject(value.qualification, "qualification", ["cache_state", "cache_preparation", "background_load", "resource_limits"]);
  if (value.qualification.cache_state !== "cold") fail("qualification.cache_state must be cold for a cold-index qualification campaign.");
  requireClosedObject(value.qualification.resource_limits, "qualification.resource_limits", ["cpu_cores", "memory_bytes", "enforcement"]);
  requireClosedObject(value.timeouts, "timeouts", ["prepare_ms", "cold_index_ms", "mutation_ms", "shutdown_ms"]);
  requireClosedObject(value.lanes, "lanes", ["baseline", "candidate"]);
  const result = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    campaign_id: campaignId,
    target,
    corpus: {
      digest: requireDigest(value.corpus.digest, "corpus.digest"),
      mutation_trace_digest: requireDigest(value.corpus.mutation_trace_digest, "corpus.mutation_trace_digest"),
      baseline_path: baselinePath,
      candidate_path: candidatePath,
    },
    sample_count: SAMPLE_COUNT,
    execution_order: [...value.execution_order],
    rss_sample_interval_ms: requirePositiveInteger(value.rss_sample_interval_ms, "rss_sample_interval_ms", 10, 1_000),
    qualification: {
      cache_state: "cold",
      cache_preparation: requireString(value.qualification.cache_preparation, "qualification.cache_preparation"),
      background_load: requireString(value.qualification.background_load, "qualification.background_load"),
      resource_limits: {
        cpu_cores: requirePositiveInteger(value.qualification.resource_limits.cpu_cores, "qualification.resource_limits.cpu_cores", MAX_INDEXING_CORES, MAX_INDEXING_CORES),
        memory_bytes: requirePositiveInteger(value.qualification.resource_limits.memory_bytes, "qualification.resource_limits.memory_bytes", MAX_INDEXING_RSS_BYTES, MAX_INDEXING_RSS_BYTES),
        enforcement: requireString(value.qualification.resource_limits.enforcement, "qualification.resource_limits.enforcement"),
      },
    },
    timeouts: {
      prepare_ms: requirePositiveInteger(value.timeouts.prepare_ms, "timeouts.prepare_ms", 1, 24 * 60 * 60 * 1_000),
      cold_index_ms: requirePositiveInteger(value.timeouts.cold_index_ms, "timeouts.cold_index_ms", 1, 24 * 60 * 60 * 1_000),
      mutation_ms: requirePositiveInteger(value.timeouts.mutation_ms, "timeouts.mutation_ms", 1, 24 * 60 * 60 * 1_000),
      shutdown_ms: requirePositiveInteger(value.timeouts.shutdown_ms, "timeouts.shutdown_ms", 1, 60_000),
    },
    lanes: {
      baseline: validateLane(value.lanes.baseline, "lanes.baseline", "baseline"),
      candidate: validateLane(value.lanes.candidate, "lanes.candidate", "candidate"),
    },
  };
  if (result.lanes.baseline.command.environment.URDIRA_NATIVE_REQUIRED !== "0"
    || result.lanes.baseline.command.environment.URDIRA_NATIVE_ROOT !== undefined
    || result.lanes.baseline.command.environment.URDIRA_INDEXING_CORE_ORACLE !== "1") {
    fail("lanes.baseline.command.environment must explicitly set URDIRA_NATIVE_REQUIRED=0, URDIRA_INDEXING_CORE_ORACLE=1, and omit URDIRA_NATIVE_ROOT.");
  }
  if (result.lanes.candidate.command.environment.URDIRA_NATIVE_REQUIRED !== "1") fail("lanes.candidate.command.environment must explicitly set URDIRA_NATIVE_REQUIRED=1.");
  requireAbsolute(result.lanes.candidate.command.environment.URDIRA_NATIVE_ROOT, "lanes.candidate.command.environment.URDIRA_NATIVE_ROOT", "native closure root");
  return result;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function stableDigest(value) {
  return sha256(Buffer.from(JSON.stringify(stable(value)), "utf8"));
}

function percentile(values, quantile) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(quantile * ordered.length) - 1)];
}

function roundedMilliseconds(value) {
  return Math.max(0.001, Math.round(value * 1_000) / 1_000);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function requireDirectory(path, field) {
  const metadata = await stat(path).catch(() => undefined);
  if (metadata?.isDirectory() !== true) evidenceFail(`${field} is not an existing directory: ${path}`);
}

async function requireFile(path, field) {
  const metadata = await stat(path).catch(() => undefined);
  if (metadata?.isFile() !== true) evidenceFail(`${field} is not an existing file: ${path}`);
}

async function fileEvidence(path, field) {
  await requireFile(path, field);
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    byteLength += chunk.byteLength;
  }
  return { path, digest: `sha256:${hash.digest("hex")}`, byte_length: byteLength };
}

async function capture(executable, args, options = {}) {
  const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const code = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
  });
  if (code !== 0) throw new Error(`${basename(executable)} ${args.join(" ")} failed: ${Buffer.concat(stderr).toString("utf8").trim()}`);
  return Buffer.concat(stdout).toString("utf8").trim();
}

async function inspectGitRepository(cwd, declaredRevision) {
  let repositoryRoot;
  let revision;
  let statusOutput;
  try {
    repositoryRoot = resolve(await capture("git", ["-C", cwd, "rev-parse", "--show-toplevel"]));
    revision = await capture("git", ["-C", cwd, "rev-parse", "HEAD"]);
    statusOutput = await capture("git", ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all"]);
  } catch (error) {
    evidenceFail(`cannot verify Git provenance for ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const canonicalCwd = await realpath(cwd);
  if (repositoryRoot !== canonicalCwd) evidenceFail(`controller cwd must be the exact Git repository root: ${repositoryRoot}`);
  if (revision !== declaredRevision) evidenceFail(`declared revision ${declaredRevision} does not match Git HEAD ${revision}.`);
  if (statusOutput.length > 0) evidenceFail(`Git working tree is not clean for revision ${revision}.`);
  return { repository_root: repositoryRoot, revision };
}

function parseControllerConfig(bytes, path) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { evidenceFail(`controller config is not valid JSON: ${path}`); }
  try { return validateNativeAccelerationControllerConfig(value); }
  catch (error) { evidenceFail(`controller config validation failed for ${path}: ${error instanceof Error ? error.message : String(error)}`); }
}

function expectedNativePath(target, role) {
  const windows = target === "win32-x64";
  return {
    addon: "native/urdira-native.node",
    worker: `native/urdira-jsts-syntax-worker${windows ? ".exe" : ""}`,
    launcher: `bin/urdira${windows ? ".exe" : ""}`,
    node: `runtime/node${windows ? ".exe" : ""}`,
  }[role];
}

async function inspectNativeClosure(rootValue, target, declaredManifestDigest, declaredClosureDigest) {
  const root = resolve(rootValue);
  const manifestPath = join(root, "manifest.json");
  const manifestEvidence = await fileEvidence(manifestPath, "candidate native manifest");
  if (manifestEvidence.digest !== declaredManifestDigest) evidenceFail(`native_manifest_digest does not match ${manifestPath}.`);
  let manifest;
  try { manifest = JSON.parse((await readFile(manifestPath)).toString("utf8")); } catch { evidenceFail(`candidate native manifest is not valid JSON: ${manifestPath}`); }
  requireExactEvidenceKeys(manifest, "candidate native manifest", ["native_manifest_version", "target", "rust_target", "binding_api", "node_api", "worker_protocol", "build_id", "files"]);
  if (manifest.native_manifest_version !== 1 || manifest.target !== target || manifest.rust_target !== RUST_TARGETS[target]) evidenceFail("candidate native manifest target identity does not match the campaign target.");
  if (manifest.binding_api !== 16 || manifest.node_api !== 10 || manifest.worker_protocol !== "urdira.ipc.v2") evidenceFail("candidate native manifest runtime contract is incompatible.");
  if (!SHA256_PATTERN.test(manifest.build_id)) evidenceFail("candidate native manifest build_id is invalid.");
  if (!isRecord(manifest.files) || !Object.hasOwn(manifest.files, "addon") || !Object.hasOwn(manifest.files, "worker") || Object.keys(manifest.files).some((role) => !["addon", "worker", "launcher", "node"].includes(role))) {
    evidenceFail("candidate native manifest files are invalid.");
  }
  const archiveRoot = basename(root) === "native" ? dirname(root) : root;
  const files = {};
  for (const role of Object.keys(manifest.files).sort()) {
    const declaration = manifest.files[role];
    requireExactEvidenceKeys(declaration, `candidate native manifest files.${role}`, ["path", "digest"]);
    const expectedPath = expectedNativePath(target, role);
    if (declaration.path !== expectedPath || !SHA256_PATTERN.test(declaration.digest)) evidenceFail(`candidate native ${role} declaration is invalid.`);
    const artifact = await fileEvidence(join(archiveRoot, ...declaration.path.split("/")), `candidate native ${role}`);
    if (artifact.digest !== declaration.digest) evidenceFail(`native ${role} checksum mismatch; expected ${declaration.digest}, received ${artifact.digest}.`);
    files[role] = { path: declaration.path, digest: declaration.digest };
  }
  const buildIdentity = {
    schema_version: 1,
    target,
    rust_target: RUST_TARGETS[target],
    binding_api: 16,
    node_api: 10,
    worker_protocol: "urdira.ipc.v2",
    files: { addon: files.addon, worker: files.worker },
  };
  const expectedBuildId = stableDigest(buildIdentity);
  if (manifest.build_id !== expectedBuildId) evidenceFail(`candidate native build_id does not match its addon and worker closure.`);
  const closureDigest = stableDigest({
    schema_version: 1,
    manifest_digest: manifestEvidence.digest,
    target,
    rust_target: RUST_TARGETS[target],
    build_id: manifest.build_id,
    files,
  });
  if (closureDigest !== declaredClosureDigest) evidenceFail(`native_closure_digest does not match the verified candidate closure.`);
  return { root_path: root, manifest_path: manifestPath, manifest_digest: manifestEvidence.digest, closure_digest: closureDigest, build_id: manifest.build_id, files };
}

async function inspectLaneBindings(manifest, lane) {
  const laneManifest = manifest.lanes[lane];
  const command = laneManifest.command;
  if (command.args.length !== 3 || !isAbsolute(command.args[0] ?? "") || command.args[1] !== "--config" || !isAbsolute(command.args[2] ?? "")) {
    evidenceFail(`${lane} controller command must be <executable> <absolute controller script> --config <absolute config path>.`);
  }
  const controllerScriptPath = resolve(command.args[0]);
  const controllerConfigPath = resolve(command.args[2]);
  const [executable, controllerScript, controllerConfig] = await Promise.all([
    fileEvidence(command.executable, `${lane} controller executable`),
    fileEvidence(controllerScriptPath, `${lane} controller script`),
    fileEvidence(controllerConfigPath, `${lane} controller config`),
  ]);
  if (nativeAccelerationControllerConfigDigest(await readFile(controllerConfigPath)) !== controllerConfig.digest) evidenceFail(`${lane} controller config digest implementation disagrees with the streamed digest.`);
  if (controllerConfig.digest !== laneManifest.provenance.configuration_digest) evidenceFail(`${lane} configuration_digest does not match ${controllerConfigPath}.`);
  const controllerExecutableDigest = stableDigest({
    schema_version: 1,
    executable: { path: executable.path, digest: executable.digest },
    controller_script: { path: controllerScript.path, digest: controllerScript.digest },
    command,
  });
  if (controllerExecutableDigest !== laneManifest.provenance.controller_executable_digest) evidenceFail(`${lane} controller_executable_digest does not match the exact executable, script, and command.`);
  const config = parseControllerConfig(await readFile(controllerConfigPath), controllerConfigPath);
  if (config.lane !== lane) evidenceFail(`controller config lane ${String(config.lane)} does not match manifest lane ${lane}.`);
  if (config.corpus_path !== manifest.corpus[`${lane}_path`]) evidenceFail(`${lane} controller config corpus_path does not match the manifest.`);
  if (config.qualification.cache_state !== manifest.qualification.cache_state
    || config.qualification.applied_limits.max_indexing_cores !== manifest.qualification.resource_limits.cpu_cores
    || config.qualification.applied_limits.max_rss_bytes !== manifest.qualification.resource_limits.memory_bytes
    || config.qualification.capture_phase_timings !== true) {
    evidenceFail(`${lane} controller config qualification does not match the campaign cache, limits, and phase-timing contract.`);
  }
  const runtimeModule = await fileEvidence(config.runtime_module, `${lane} runtime module`);
  if (runtimeModule.digest !== laneManifest.provenance.runtime_module_digest) evidenceFail(`${lane} runtime_module_digest does not match ${config.runtime_module}.`);
  const mutationTrace = await fileEvidence(config.mutation_trace_path, `${lane} mutation trace`);
  if (mutationTrace.digest !== manifest.corpus.mutation_trace_digest) evidenceFail(`${lane} mutation_trace_digest does not match ${config.mutation_trace_path}.`);
  let nativeClosure = null;
  if (lane === "candidate") {
    const nativeRoot = resolve(command.environment.URDIRA_NATIVE_ROOT);
    nativeClosure = await inspectNativeClosure(nativeRoot, manifest.target, laneManifest.provenance.native_manifest_digest, laneManifest.provenance.native_closure_digest);
  }
  const git = await inspectGitRepository(command.cwd, laneManifest.provenance.revision);
  const cargoLock = await fileEvidence(join(git.repository_root, "Cargo.lock"), `${lane} Cargo.lock`);
  if (cargoLock.digest !== laneManifest.provenance.cargo_lock_digest) evidenceFail(`${lane} cargo_lock_digest does not match ${cargoLock.path}.`);
  const artifactBindings = {
    executable,
    controller_script: controllerScript,
    controller_config: controllerConfig,
    runtime_module: runtimeModule,
    mutation_trace: mutationTrace,
    cargo_lock: cargoLock,
    native_closure: nativeClosure,
  };
  return {
    lane,
    config,
    git,
    declared: laneManifest.provenance,
    artifact_bindings: artifactBindings,
    controller_executable_digest: controllerExecutableDigest,
    execution_identity_digest: stableDigest({ schema_version: 2, lane, command, revision: git.revision, build_id: laneManifest.provenance.build_id, artifact_bindings: artifactBindings }),
  };
}

function sameEvidence(left, right) {
  return stableDigest(left) === stableDigest(right);
}

function isExcluded(path, exclusions) {
  return exclusions.some((excluded) => path === excluded || path.startsWith(`${excluded}/`));
}

async function decodedFileCoordinates(path) {
  let bytes = 0;
  let lines = 0;
  let lastByte;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.byteLength;
    for (const byte of chunk) if (byte === 0x0a) lines += 1;
    if (chunk.byteLength > 0) lastByte = chunk[chunk.byteLength - 1];
  }
  if (bytes > 0 && lastByte !== 0x0a) lines += 1;
  return { bytes, lines };
}

async function computeCorpusCoordinates(root, exclusions) {
  let includedFiles = 0;
  let logicalSourceLines = 0;
  let includedSourceBytes = 0;
  const visit = async (directory, prefix) => {
    const handle = await opendir(directory);
    const entries = [];
    for await (const entry of handle) entries.push(entry);
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (isExcluded(path, exclusions)) continue;
      const absolute = join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isDirectory()) await visit(absolute, path);
      else if (metadata.isFile()) {
        const coordinates = await decodedFileCoordinates(absolute);
        includedFiles += 1;
        logicalSourceLines += coordinates.lines;
        includedSourceBytes += coordinates.bytes;
      } else evidenceFail(`cannot derive source coordinates from non-regular corpus entry ${path}.`);
      if (![includedFiles, logicalSourceLines, includedSourceBytes].every(Number.isSafeInteger)) evidenceFail("corpus coordinates exceed JavaScript safe integers.");
    }
  };
  await visit(root, "");
  return { included_files: includedFiles, logical_source_lines: logicalSourceLines, included_source_bytes: includedSourceBytes };
}

export function classifyNativeAccelerationCorpusTier(coordinates) {
  if (!isRecord(coordinates) || ![coordinates.included_files, coordinates.logical_source_lines, coordinates.included_source_bytes].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Invalid native acceleration corpus coordinates.");
  }
  if (coordinates.included_files <= 5_000 && coordinates.logical_source_lines <= 100_000 && coordinates.included_source_bytes <= 50 * 1024 ** 2) return "S";
  if (coordinates.included_files <= 50_000 && coordinates.logical_source_lines <= 1_000_000 && coordinates.included_source_bytes <= 500 * 1024 ** 2) return "M";
  if (coordinates.included_files <= 250_000 && coordinates.logical_source_lines <= 5_000_000 && coordinates.included_source_bytes <= 2.5 * 1024 ** 3) return "L";
  evidenceFail("recomputed corpus coordinates exceed the published tier-L bounds.");
}

async function inspectPristineCorpus(manifest, laneBindings) {
  if (laneBindings.baseline.config.mutation_trace_path !== laneBindings.candidate.config.mutation_trace_path) evidenceFail("baseline and candidate controller configs must reference the same mutation trace path.");
  if (laneBindings.baseline.config.runtime_module !== laneBindings.candidate.config.runtime_module) evidenceFail("baseline and candidate controller configs must reference the same runtime module path.");
  if (laneBindings.baseline.config.data_root === laneBindings.candidate.config.data_root) evidenceFail("baseline and candidate controller configs must use separate data roots.");
  if (laneBindings.baseline.declared.runtime_module_digest !== laneBindings.candidate.declared.runtime_module_digest) evidenceFail("baseline and candidate runtime_module_digest values must be identical.");
  if (laneBindings.baseline.declared.cargo_lock_digest !== laneBindings.candidate.declared.cargo_lock_digest) evidenceFail("baseline and candidate cargo_lock_digest values must be identical.");
  const traceBytes = await readFile(laneBindings.baseline.config.mutation_trace_path);
  if (sha256(traceBytes) !== manifest.corpus.mutation_trace_digest) evidenceFail("mutation_trace_digest does not match the exact trace bytes.");
  let trace;
  try { trace = validateNativeAccelerationMutationTrace(JSON.parse(traceBytes.toString("utf8"))); } catch (error) { evidenceFail(`mutation trace validation failed: ${error instanceof Error ? error.message : String(error)}`); }
  if (trace.base_corpus_digest !== manifest.corpus.digest) evidenceFail("mutation trace base_corpus_digest does not match the campaign corpus digest.");
  const beforeDigests = await Promise.all(LANES.map((lane) => computeNativeAccelerationCorpusDigest(manifest.corpus[`${lane}_path`], trace.excluded_paths)));
  if (beforeDigests.some((digest) => digest !== manifest.corpus.digest)) evidenceFail("recomputed pristine corpus digest does not match the declared corpus digest.");
  const coordinates = await Promise.all(LANES.map((lane) => computeCorpusCoordinates(manifest.corpus[`${lane}_path`], trace.excluded_paths)));
  if (!sameEvidence(coordinates[0], coordinates[1])) evidenceFail("baseline and candidate pristine corpus coordinates differ.");
  const afterDigests = await Promise.all(LANES.map((lane) => computeNativeAccelerationCorpusDigest(manifest.corpus[`${lane}_path`], trace.excluded_paths)));
  if (afterDigests.some((digest) => digest !== manifest.corpus.digest)) evidenceFail("corpus changed while deriving qualification coordinates.");
  const tier = classifyNativeAccelerationCorpusTier(coordinates[0]);
  if (tier !== "L") evidenceFail(`recomputed corpus tier is ${tier}; native acceleration qualification requires tier L.`);
  if (LANES.some((lane) => laneBindings[lane].config.qualification.corpus_tier !== tier)) evidenceFail("controller config corpus tier does not match the recomputed corpus tier.");
  return { tier, ...coordinates[0] };
}

function unescapeMountPath(value) {
  return value.replace(/\\([0-7]{3})/gu, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

async function inspectDarwinFilesystem(path) {
  const output = await capture("/bin/df", ["-P", path]);
  // `df -P` terminates its output with a newline on Darwin; selecting the
  // last raw split entry therefore produced an empty mount line and masked
  // the actual controller-protocol validation error.
  const line = output.split(/\r?\n/u).findLast((entry) => entry.trim().length > 0)?.trim();
  const match = /^(\S+)\s+\d+\s+\d+\s+\d+\s+\S+\s+(.+)$/u.exec(line ?? "");
  if (match === null) evidenceFail(`cannot determine filesystem mount for ${path}.`);
  const diskInfo = await capture("/usr/sbin/diskutil", ["info", match[2]]);
  const field = (name) => new RegExp(`^\\s*${name}:\\s*(.+)$`, "mu").exec(diskInfo)?.[1]?.trim();
  const filesystemType = field("Type \\(Bundle\\)") ?? field("File System Personality");
  const internal = field("Device Location") === "Internal";
  const solidState = field("Solid State") === "Yes";
  const protocol = field("Protocol");
  if (filesystemType === undefined || protocol === undefined) evidenceFail(`cannot determine filesystem or storage class for ${path}.`);
  const storageClass = internal && solidState && ["NVMe", "Apple Fabric"].includes(protocol)
    ? "local_nvme"
    : internal && solidState
      ? "local_ssd"
      : !internal && solidState
        ? "external_ssd"
        : internal
          ? "local_hdd"
          : "external_hdd";
  return { filesystem_type: filesystemType.toLowerCase(), storage_class: storageClass };
}

async function inspectLinuxBlockDevice(source, resolvedPath) {
  const lsblk = await capture("lsblk", ["-ndo", "TRAN,ROTA", source]);
  const fields = lsblk.split(/\s+/u).filter(Boolean);
  if (fields.some((field) => field.toLowerCase() === "nvme")) return "local_nvme";
  if (fields.at(-1) === "0") return "local_ssd";
  if (fields.at(-1) === "1") return "local_hdd";

  // Some hosted ARM runners expose the root volume as `/dev/root`, for
  // which `lsblk` returns no transport metadata. Resolve the mounted
  // device through its Linux device number instead of guessing from the
  // source name. The sysfs queue tells us whether it is rotational, while
  // the resolved device path identifies NVMe namespaces and partitions.
  const device = (await stat(resolvedPath)).dev;
  const major = (device >> 8) & 0xfff;
  const minor = (device & 0xff) | ((device >> 12) & 0xfff00);
  const sysfsDevice = `/sys/dev/block/${major}:${minor}`;
  try {
    const resolvedSysfsDevice = await realpath(sysfsDevice);
    const rotational = (await readFile(join(sysfsDevice, "queue", "rotational"), "utf8")).trim();
    if (resolvedSysfsDevice.includes("/nvme")) return "local_nvme";
    if (rotational === "0") return "local_ssd";
    if (rotational === "1") return "local_hdd";
  } catch {
    // Keep the evidence failure in the caller: unknown devices must not be
    // silently treated as a local disk class.
  }
  return undefined;
}

async function inspectLinuxFilesystem(path) {
  const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
  const resolvedPath = await realpath(path);
  const candidates = mountInfo.split("\n").flatMap((line) => {
    const parts = line.split(" ");
    const separator = parts.indexOf("-");
    if (separator < 0 || parts.length <= separator + 2) return [];
    const mountPath = unescapeMountPath(parts[4]);
    return resolvedPath === mountPath || resolvedPath.startsWith(`${mountPath.replace(/\/$/u, "")}/`)
      ? [{ mount_path: mountPath, filesystem_type: parts[separator + 1], source: unescapeMountPath(parts[separator + 2]) }]
      : [];
  }).sort((left, right) => right.mount_path.length - left.mount_path.length);
  const mount = candidates[0];
  if (mount === undefined || typeof mount.filesystem_type !== "string") evidenceFail(`cannot determine filesystem mount for ${path}.`);
  let storageClass;
  if (["tmpfs", "ramfs"].includes(mount.filesystem_type)) storageClass = "memory";
  else if (["nfs", "nfs4", "cifs", "smb3", "fuse.sshfs"].includes(mount.filesystem_type)) storageClass = "network";
  else if (mount.filesystem_type === "overlay") storageClass = "container_overlay";
  else if (mount.source.includes("nvme")) storageClass = "local_nvme";
  else if (mount.source.startsWith("/dev/")) {
    storageClass = await inspectLinuxBlockDevice(mount.source, resolvedPath);
  }
  if (storageClass === undefined) evidenceFail(`cannot determine storage class for ${path} on ${mount.source}.`);
  return { filesystem_type: mount.filesystem_type, storage_class: storageClass };
}

async function inspectWindowsFilesystem(path) {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined) evidenceFail("SystemRoot is required to inspect Windows storage.");
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const escaped = path.replace(/'/gu, "''");
  const script = `$root=[System.IO.Path]::GetPathRoot('${escaped}').TrimEnd('\\');$volume=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$root'";$physical=@(Get-PhysicalDisk);if($null -eq $volume -or $physical.Count -ne 1){exit 9};[pscustomobject]@{filesystem=$volume.FileSystem;media=$physical[0].MediaType.ToString();bus=$physical[0].BusType.ToString()}|ConvertTo-Json -Compress`;
  let value;
  try { value = JSON.parse(await capture(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script])); } catch (error) { evidenceFail(`cannot determine Windows filesystem or storage class: ${error instanceof Error ? error.message : String(error)}`); }
  if (typeof value.filesystem !== "string" || typeof value.media !== "string" || typeof value.bus !== "string") evidenceFail("Windows filesystem probe returned incomplete metadata.");
  const storageClass = value.bus === "NVMe" ? "local_nvme" : value.media === "SSD" ? "local_ssd" : value.media === "HDD" ? "local_hdd" : undefined;
  if (storageClass === undefined) evidenceFail("cannot determine Windows storage class reliably.");
  return { filesystem_type: value.filesystem.toLowerCase(), storage_class: storageClass };
}

async function inspectFilesystem(path) {
  if (platform() === "darwin") return await inspectDarwinFilesystem(path);
  if (platform() === "linux") return await inspectLinuxFilesystem(path);
  if (platform() === "win32") return await inspectWindowsFilesystem(path);
  evidenceFail(`filesystem inspection is unsupported on ${platform()}.`);
}

async function physicalCpuCount() {
  if (platform() === "darwin") {
    const value = Number(await capture("/usr/sbin/sysctl", ["-n", "hw.physicalcpu"]));
    if (Number.isSafeInteger(value) && value > 0) return value;
  } else if (platform() === "linux") {
    const cpuInfo = await readFile("/proc/cpuinfo", "utf8");
    const pairs = new Set(cpuInfo.split(/\n\n+/u).flatMap((block) => {
      const physical = /^physical id\s*:\s*(\d+)$/mu.exec(block)?.[1];
      const core = /^core id\s*:\s*(\d+)$/mu.exec(block)?.[1];
      return physical === undefined || core === undefined ? [] : [`${physical}:${core}`];
    }));
    if (pairs.size > 0) return pairs.size;
    const lines = (await capture("lscpu", ["-p=Core,Socket"])).split("\n").filter((line) => !line.startsWith("#") && /^\d+,\d+$/u.test(line));
    const unique = new Set(lines);
    if (unique.size > 0) return unique.size;
  } else if (platform() === "win32") {
    const systemRoot = process.env.SystemRoot;
    if (systemRoot !== undefined) {
      const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const value = Number(await capture(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum"]));
      if (Number.isSafeInteger(value) && value > 0) return value;
    }
  }
  evidenceFail("cannot determine physical CPU count reliably on this host.");
}

function sqliteVersion() {
  const database = new DatabaseSync(":memory:");
  try {
    const version = database.prepare("SELECT sqlite_version() AS version").get()?.version;
    if (typeof version !== "string" || version.length === 0) evidenceFail("cannot determine SQLite runtime version.");
    return version;
  } finally { database.close(); }
}

async function collectHost(manifest) {
  const cpuEntries = cpus();
  const cpuModel = cpuEntries[0]?.model?.trim();
  if (cpuModel === undefined || cpuModel.length === 0 || cpuEntries.length === 0) evidenceFail("cannot determine CPU model and logical core count.");
  const memory = totalmem();
  if (!Number.isSafeInteger(memory) || memory <= 0) evidenceFail("cannot determine total host memory.");
  const filesystems = await Promise.all([inspectFilesystem(manifest.corpus.baseline_path), inspectFilesystem(manifest.corpus.candidate_path)]);
  if (!sameEvidence(filesystems[0], filesystems[1])) evidenceFail("baseline and candidate corpus copies are not on the same filesystem and storage class.");
  return {
    run_id: randomUUID(),
    hostname: hostname(),
    platform: platform(),
    release: release(),
    architecture: arch(),
    cpu_model: cpuModel,
    physical_cpu_count: await physicalCpuCount(),
    logical_cpu_count: cpuEntries.length,
    total_memory_bytes: memory,
    filesystem_type: filesystems[0].filesystem_type,
    storage_class: filesystems[0].storage_class,
    node: process.version,
    sqlite: sqliteVersion(),
    cache_state: manifest.qualification.cache_state,
    max_indexing_cores: manifest.qualification.resource_limits.cpu_cores,
    max_indexing_rss_bytes: manifest.qualification.resource_limits.memory_bytes,
  };
}

async function processTablePosix() {
  const child = spawn("/bin/ps", ["-A", "-o", "pid=,ppid=,rss=,comm="], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const code = await new Promise((resolveExit, rejectExit) => { child.once("error", rejectExit); child.once("exit", resolveExit); });
  if (code !== 0) throw new Error(`ps failed while measuring process-tree RSS: ${Buffer.concat(stderr).toString("utf8").trim()}`);
  return Buffer.concat(stdout).toString("utf8").split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024, command: match[4] }];
  });
}

async function processTableWindows() {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined) throw new Error("SystemRoot is required to measure process-tree RSS on Windows.");
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name,ExecutablePath | ConvertTo-Json -Compress";
  const decoded = JSON.parse(await capture(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]));
  return (Array.isArray(decoded) ? decoded : [decoded]).map((entry) => ({
    pid: Number(entry.ProcessId),
    ppid: Number(entry.ParentProcessId),
    rssBytes: Number(entry.WorkingSetSize),
    command: typeof entry.ExecutablePath === "string" ? entry.ExecutablePath : String(entry.Name),
  }));
}

async function readProcessTable() {
  return platform() === "win32" ? await processTableWindows() : await processTablePosix();
}

function processTreeSample(table, rootPid) {
  const children = new Map();
  for (const entry of table) {
    const siblings = children.get(entry.ppid) ?? [];
    siblings.push(entry.pid);
    children.set(entry.ppid, siblings);
  }
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const pending = [rootPid];
  const visited = new Set();
  const processes = [];
  while (pending.length > 0) {
    const pid = pending.pop();
    if (visited.has(pid)) continue;
    visited.add(pid);
    const entry = byPid.get(pid);
    if (entry !== undefined && Number.isSafeInteger(entry.rssBytes) && entry.rssBytes > 0) {
      processes.push({ pid, ppid: entry.ppid, component: pid === rootPid ? "controller" : basename(entry.command || `pid-${pid}`), rss_bytes: entry.rssBytes });
    }
    pending.push(...(children.get(pid) ?? []));
  }
  processes.sort((left, right) => left.pid - right.pid);
  return { totalRssBytes: processes.reduce((sum, entry) => sum + entry.rss_bytes, 0), processes };
}

function startRssSampler(rootPid, intervalMs, path) {
  const stream = createWriteStream(path, { flags: "wx" });
  let active = true;
  let peakBytes = 0;
  let sampleCount = 0;
  let byteLength = 0;
  let failure;
  const hash = createHash("sha256");
  const writeLine = async (bytes) => {
    await new Promise((resolveWrite, rejectWrite) => stream.write(bytes, (error) => error ? rejectWrite(error) : resolveWrite()));
    hash.update(bytes);
    byteLength += bytes.byteLength;
  };
  const completed = (async () => {
    while (active) {
      try {
        const sample = processTreeSample(await readProcessTable(), rootPid);
        if (sample.totalRssBytes > 0 && sample.processes.length > 0) {
          const record = {
            sequence: sampleCount,
            captured_at: new Date().toISOString(),
            root_pid: rootPid,
            total_rss_bytes: sample.totalRssBytes,
            processes: sample.processes,
          };
          await writeLine(Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
          peakBytes = Math.max(peakBytes, sample.totalRssBytes);
          sampleCount += 1;
        }
      } catch (error) { failure ??= error; }
      if (active) await delay(intervalMs);
    }
  })();
  return {
    async stop() {
      active = false;
      await completed;
      stream.end();
      await finished(stream);
      if (failure !== undefined) throw failure;
      if (sampleCount === 0 || peakBytes === 0) throw new Error("Process-tree RSS measurement produced no valid samples.");
      return { peakBytes, sampleCount, evidence: { path, digest: `sha256:${hash.digest("hex")}`, byte_length: byteLength, sample_count: sampleCount } };
    },
  };
}

async function killController(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (platform() === "win32") {
    const systemRoot = process.env.SystemRoot;
    if (systemRoot !== undefined) {
      const killer = spawn(join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      await new Promise((resolveKill) => killer.once("exit", resolveKill));
      return;
    }
  } else {
    try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* The process group may already be gone. */ }
  }
  child.kill("SIGKILL");
}

function responseDigest(response, operation) {
  if (!SHA256_PATTERN.test(response.visible_set_digest)) throw new Error(`${operation} returned an invalid visible_set_digest.`);
  return response.visible_set_digest;
}

function validatePhaseTimings(value, operation) {
  const expectedPhases = operation === "cold_index"
    ? ["runtime_load", "daemon_start", "workspace_add", "readiness", "digest"]
    : ["mutation_apply", "readiness", "digest"];
  if (!isRecord(value) || value.unit !== "milliseconds" || !Array.isArray(value.phases) || value.phases.length !== expectedPhases.length) {
    throw new Error(`${operation} returned invalid phase_timings.`);
  }
  const phases = value.phases.map((phase, index) => {
    if (!isRecord(phase) || Object.keys(phase).sort().join(",") !== "duration_ms,phase" || phase.phase !== expectedPhases[index] || !(Number.isFinite(phase.duration_ms) && phase.duration_ms > 0)) {
      throw new Error(`${operation} returned invalid phase_timings entry ${index}.`);
    }
    return { phase: phase.phase, duration_ms: phase.duration_ms };
  });
  const expectedTotal = roundedMilliseconds(phases.reduce((sum, phase) => sum + phase.duration_ms, 0));
  if (!(Number.isFinite(value.total_duration_ms) && value.total_duration_ms > 0) || Math.abs(value.total_duration_ms - expectedTotal) > 0.001) {
    throw new Error(`${operation} returned an inconsistent phase_timings total.`);
  }
  return { unit: "milliseconds", phases, total_duration_ms: value.total_duration_ms };
}

async function runLane(manifest, lane, artifactsDirectory, expectedBindings) {
  const coldIndexStarted = performance.now();
  const laneManifest = manifest.lanes[lane];
  const corpusPath = manifest.corpus[`${lane}_path`];
  const stderrPath = join(artifactsDirectory, `${lane}.stderr.log`);
  const protocolPath = join(artifactsDirectory, `${lane}.protocol.ndjson`);
  const rssPath = join(artifactsDirectory, `${lane}.rss.ndjson`);
  const stderrLog = createWriteStream(stderrPath, { flags: "wx" });
  const protocolLog = createWriteStream(protocolPath, { flags: "wx" });
  const child = spawn(laneManifest.command.executable, laneManifest.command.args, {
    cwd: laneManifest.command.cwd,
    env: { ...laneManifest.command.environment },
    detached: platform() !== "win32",
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  activeControllers.add(child);
  child.stderr.pipe(stderrLog);
  let pending;
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("error", (error) => { pending?.reject(error); pending = undefined; rejectExit(error); });
    child.once("exit", (code, signal) => {
      if (pending !== undefined) { pending.reject(new Error(`${lane} controller exited before responding to ${pending.requestId}.`)); pending = undefined; }
      resolveExit({ code, signal });
    });
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let protocolFailure;
  reader.on("line", (line) => {
    protocolLog.write(`${line}\n`);
    if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
      protocolFailure = new Error(`${lane} controller emitted an oversized protocol line.`);
      pending?.reject(protocolFailure);
      pending = undefined;
      return;
    }
    let response;
    try { response = JSON.parse(line); } catch {
      protocolFailure = new Error(`${lane} controller stdout must contain only NDJSON protocol responses.`);
      pending?.reject(protocolFailure);
      pending = undefined;
      return;
    }
    if (pending === undefined) { protocolFailure = new Error(`${lane} controller emitted an unsolicited protocol response.`); return; }
    if (!isRecord(response) || response.schema_version !== CONTROLLER_SCHEMA_VERSION || response.request_id !== pending.requestId || response.status !== "ok") {
      const message = isRecord(response) && typeof response.error === "string" ? `: ${response.error}` : "";
      const error = new Error(`${lane} controller returned an invalid response for ${pending.requestId}${message}.`);
      pending.reject(error);
      pending = undefined;
      return;
    }
    const resolvePending = pending.resolve;
    pending = undefined;
    resolvePending(response);
  });
  if (child.pid === undefined) throw new Error(`${lane} controller has no process id for RSS measurement.`);
  const sampler = startRssSampler(child.pid, manifest.rss_sample_interval_ms, rssPath);

  const request = async (operation, timeoutMs, mutationIndex) => {
    if (protocolFailure !== undefined) throw protocolFailure;
    if (pending !== undefined) throw new Error("Campaign harness attempted concurrent controller requests.");
    const requestId = mutationIndex === undefined ? `${lane}:${operation}` : `${lane}:${operation}:${mutationIndex}`;
    const payload = {
      schema_version: CONTROLLER_SCHEMA_VERSION,
      request_id: requestId,
      operation,
      campaign_id: manifest.campaign_id,
      lane,
      target: manifest.target,
      corpus_path: corpusPath,
      corpus_digest: manifest.corpus.digest,
      mutation_trace_digest: manifest.corpus.mutation_trace_digest,
      ...(mutationIndex === undefined ? {} : { mutation_index: mutationIndex }),
    };
    const started = performance.now();
    const response = await new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => { pending = undefined; rejectResponse(new Error(`${requestId} exceeded its ${timeoutMs} ms timeout.`)); }, timeoutMs);
      pending = {
        requestId,
        resolve(responseValue) { clearTimeout(timer); resolveResponse(responseValue); },
        reject(error) { clearTimeout(timer); rejectResponse(error); },
      };
      child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error !== null && error !== undefined && pending?.requestId === requestId) { clearTimeout(timer); pending = undefined; rejectResponse(error); }
      });
    });
    const expectedKeys = operation === "prepare"
      ? ["schema_version", "request_id", "status", "corpus_digest", "mutation_trace_digest"]
      : operation === "shutdown"
        ? ["schema_version", "request_id", "status"]
        : operation === "cold_index"
          ? ["schema_version", "request_id", "status", "phase_timings", "visible_set_digest"]
          : ["schema_version", "request_id", "status", "phase_timings", "mutation_index", "visible_set_digest"];
    const unknown = Object.keys(response).filter((key) => !expectedKeys.includes(key));
    if (unknown.length > 0) throw new Error(`${lane} controller returned unknown fields for ${operation}: ${unknown.join(", ")}.`);
    if (Object.keys(response).some((key) => !expectedKeys.includes(key)) || expectedKeys.some((key) => !Object.hasOwn(response, key))) throw new Error(`${lane} controller returned missing fields for ${operation}.`);
    if (operation === "incremental_mutation" && response.mutation_index !== mutationIndex) throw new Error(`${lane} controller returned the wrong mutation_index for ${requestId}.`);
    return { response, elapsedMs: roundedMilliseconds(performance.now() - started) };
  };

  try {
    const prepared = await request("prepare", manifest.timeouts.prepare_ms);
    if (prepared.response.corpus_digest !== manifest.corpus.digest || prepared.response.mutation_trace_digest !== manifest.corpus.mutation_trace_digest) throw new Error(`${lane} controller did not confirm the declared corpus and mutation-trace digests.`);
    const cold = await request("cold_index", manifest.timeouts.cold_index_ms);
    const coldIndexMs = roundedMilliseconds(performance.now() - coldIndexStarted);
    const visibleSetDigests = [responseDigest(cold.response, `${lane} cold_index`)];
    validatePhaseTimings(cold.response.phase_timings, "cold_index");
    const incrementalTimes = [];
    for (let mutationIndex = 0; mutationIndex < SAMPLE_COUNT; mutationIndex += 1) {
      const mutation = await request("incremental_mutation", manifest.timeouts.mutation_ms, mutationIndex);
      incrementalTimes.push(mutation.elapsedMs);
      visibleSetDigests.push(responseDigest(mutation.response, `${lane} incremental_mutation ${mutationIndex}`));
      validatePhaseTimings(mutation.response.phase_timings, "incremental_mutation");
    }
    await request("shutdown", manifest.timeouts.shutdown_ms);
    child.stdin.end();
    const outcome = await Promise.race([exit, delay(manifest.timeouts.shutdown_ms).then(() => { throw new Error(`${lane} controller did not exit after shutdown.`); })]);
    if (outcome.code !== 0) throw new Error(`${lane} controller exited with code ${String(outcome.code)} and signal ${String(outcome.signal)}.`);
    activeControllers.delete(child);
    const rss = await sampler.stop();
    stderrLog.end();
    protocolLog.end();
    await Promise.all([finished(stderrLog), finished(protocolLog)]);
    const [stderrEvidence, protocolEvidence] = await Promise.all([fileEvidence(stderrPath, `${lane} stderr log`), fileEvidence(protocolPath, `${lane} protocol log`)]);
    const observedBindings = await inspectLaneBindings(manifest, lane);
    if (!sameEvidence(expectedBindings, observedBindings)) evidenceFail(`${lane} executable or declared provenance changed during the campaign.`);
    if (incrementalTimes.length !== SAMPLE_COUNT || visibleSetDigests.length !== SAMPLE_COUNT + 1) evidenceFail(`${lane} raw timing or visible-set series is incomplete.`);
    return {
      cold_index_ms: coldIndexMs,
      incremental_times_ms: incrementalTimes,
      visible_set_digests: visibleSetDigests,
      incremental_p95_ms: percentile(incrementalTimes, 0.95),
      peak_process_tree_rss_bytes: rss.peakBytes,
      raw_evidence: {
        stderr_log: stderrEvidence,
        protocol_log: protocolEvidence,
        rss_series: rss.evidence,
      },
    };
  } catch (error) {
    await killController(child);
    activeControllers.delete(child);
    await sampler.stop().catch(() => undefined);
    stderrLog.end();
    protocolLog.end();
    await Promise.allSettled([finished(stderrLog), finished(protocolLog)]);
    throw error;
  }
}

function reportDigest(reportWithoutDigest) {
  return stableDigest(reportWithoutDigest);
}

async function verifyRawEvidence(artifact, field) {
  if (!isRecord(artifact) || typeof artifact.path !== "string" || !isAbsolute(artifact.path) || !SHA256_PATTERN.test(artifact.digest) || !Number.isSafeInteger(artifact.byte_length) || artifact.byte_length < 0) evidenceFail(`${field} is invalid.`);
  const actual = await fileEvidence(artifact.path, field);
  if (actual.digest !== artifact.digest || actual.byte_length !== artifact.byte_length) evidenceFail(`${field} checksum or byte length mismatch.`);
}

async function readExistingReport(reportPath, expectedRunnerDigest) {
  const bytes = await readFile(reportPath);
  const sidecar = (await readFile(`${reportPath}.sha256`, "utf8")).trim();
  if (!SHA256_PATTERN.test(sidecar) || sidecar !== sha256(bytes)) evidenceFail("existing report sidecar checksum mismatch.");
  let report;
  try { report = JSON.parse(bytes.toString("utf8")); } catch { evidenceFail("existing report is not valid JSON."); }
  if (!isRecord(report) || report.schema_version !== REPORT_SCHEMA_VERSION || !Array.isArray(report.campaigns) || !SHA256_PATTERN.test(report.report_digest)) evidenceFail("existing native acceleration report is invalid.");
  requireExactEvidenceKeys(report.harness, "existing report harness", ["name", "version", "controller_protocol", "runner_digest"]);
  if (report.harness.name !== "run-native-acceleration-campaign"
    || report.harness.version !== 2
    || report.harness.controller_protocol !== "urdira.native-acceleration-controller.v2"
    || report.harness.runner_digest !== expectedRunnerDigest) {
    evidenceFail("existing report harness or runner_digest does not match the current qualifying runner.");
  }
  const { report_digest: declaredDigest, ...withoutDigest } = report;
  if (reportDigest(withoutDigest) !== declaredDigest) evidenceFail("existing report_digest does not match the report with report_digest omitted.");
  for (const campaign of report.campaigns) {
    for (const lane of LANES) {
      const raw = campaign?.[lane]?.raw_evidence;
      if (!isRecord(raw)) evidenceFail(`existing ${lane} raw_evidence is missing.`);
      await Promise.all([
        verifyRawEvidence(raw.stderr_log, `existing ${lane} stderr log`),
        verifyRawEvidence(raw.protocol_log, `existing ${lane} protocol log`),
        verifyRawEvidence(raw.rss_series, `existing ${lane} RSS series`),
      ]);
    }
  }
  return report;
}

async function writeReport(reportPath, report) {
  await mkdir(dirname(reportPath), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  const temporary = join(dirname(reportPath), `.${basename(reportPath)}.${process.pid}.tmp`);
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, reportPath);
  await writeFile(`${reportPath}.sha256`, `${sha256(bytes)}\n`, { flag: "w" });
}

export async function runNativeAccelerationCampaign(value, options) {
  const manifest = validateNativeAccelerationCampaignManifest(value);
  if (!isRecord(options)) throw new Error("Campaign output options are required.");
  const manifestPath = requireAbsolute(options.manifestPath, "options.manifestPath", "manifest path");
  const reportPath = requireAbsolute(options.reportPath, "options.reportPath", "report path");
  if (!(options.manifestBytes instanceof Uint8Array)) throw new Error("options.manifestBytes must contain the exact manifest bytes.");
  const manifestFileBytes = await readFile(manifestPath);
  if (!Buffer.from(options.manifestBytes).equals(manifestFileBytes)) evidenceFail("options.manifestBytes do not match the exact manifest bytes on disk.");
  let parsedManifest;
  try { parsedManifest = JSON.parse(manifestFileBytes.toString("utf8")); } catch { evidenceFail("campaign manifest bytes are not valid JSON."); }
  if (!sameEvidence(parsedManifest, value)) evidenceFail("validated manifest value does not match the exact manifest bytes.");
  const runnerEvidence = await fileEvidence(fileURLToPath(import.meta.url), "native acceleration campaign runner");

  await Promise.all([
    requireDirectory(manifest.corpus.baseline_path, "corpus.baseline_path"),
    requireDirectory(manifest.corpus.candidate_path, "corpus.candidate_path"),
    requireDirectory(manifest.lanes.baseline.command.cwd, "lanes.baseline.command.cwd"),
    requireDirectory(manifest.lanes.candidate.command.cwd, "lanes.candidate.command.cwd"),
  ]);
  const laneBindings = {
    baseline: await inspectLaneBindings(manifest, "baseline"),
    candidate: await inspectLaneBindings(manifest, "candidate"),
  };
  const [corpus, host] = await Promise.all([inspectPristineCorpus(manifest, laneBindings), collectHost(manifest)]);

  let existingCampaigns = [];
  if (options.append === true) {
    const existing = await readExistingReport(reportPath, runnerEvidence.digest);
    if (existing.campaigns.some((entry) => entry?.campaign_id === manifest.campaign_id)) evidenceFail(`campaign ${manifest.campaign_id} already exists in the report.`);
    if (existing.campaigns.some((entry) => entry?.provenance?.corpus_digest !== manifest.corpus.digest || entry?.provenance?.mutation_trace_digest !== manifest.corpus.mutation_trace_digest)) evidenceFail("cannot append campaigns with different corpus or mutation-trace provenance.");
    existingCampaigns = existing.campaigns;
  }

  const artifactsRoot = `${reportPath}.artifacts`;
  await mkdir(artifactsRoot, { recursive: true });
  const artifactsDirectory = join(artifactsRoot, manifest.campaign_id);
  await mkdir(artifactsDirectory, { recursive: false });
  const results = {};
  for (const lane of manifest.execution_order) results[lane] = await runLane(manifest, lane, artifactsDirectory, laneBindings[lane]);
  const driftIndex = results.baseline.visible_set_digests.findIndex((digest, index) => digest !== results.candidate.visible_set_digests[index]);
  if (driftIndex !== -1) {
    const phase = driftIndex === 0 ? "cold_index" : `incremental_mutation ${driftIndex - 1}`;
    throw new Error(`Native acceleration visible-set digest drift at ${phase}.`);
  }
  const campaign = {
    campaign_id: manifest.campaign_id,
    target: manifest.target,
    execution_order: manifest.execution_order,
    corpus,
    host,
    baseline: results.baseline,
    candidate: results.candidate,
    provenance: {
      corpus_digest: manifest.corpus.digest,
      mutation_trace_digest: manifest.corpus.mutation_trace_digest,
      manifest_digest: sha256(options.manifestBytes),
      runtime_module_digest: laneBindings.baseline.declared.runtime_module_digest,
      controller_config_digests: {
        baseline: laneBindings.baseline.declared.configuration_digest,
        candidate: laneBindings.candidate.declared.configuration_digest,
      },
      controller_executable_digests: {
        baseline: laneBindings.baseline.controller_executable_digest,
        candidate: laneBindings.candidate.controller_executable_digest,
      },
      cargo_lock_digest: laneBindings.baseline.declared.cargo_lock_digest,
      native_closure_digest: laneBindings.candidate.declared.native_closure_digest,
    },
  };
  const finalRunnerEvidence = await fileEvidence(fileURLToPath(import.meta.url), "native acceleration campaign runner");
  if (!sameEvidence(runnerEvidence, finalRunnerEvidence)) evidenceFail("native acceleration campaign runner changed while producing evidence.");
  const reportWithoutDigest = {
    schema_version: REPORT_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    harness: { name: "run-native-acceleration-campaign", version: 2, controller_protocol: "urdira.native-acceleration-controller.v2", runner_digest: runnerEvidence.digest },
    campaigns: [...existingCampaigns, campaign],
  };
  const report = { ...reportWithoutDigest, report_digest: reportDigest(reportWithoutDigest) };
  await writeReport(reportPath, report);
  return report;
}

function parseArguments(argv) {
  const values = { append: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--append") values.append = true;
    else if (argument === "--manifest" || argument === "--report") {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${argument} requires an absolute path.`);
      values[argument.slice(2)] = next;
      index += 1;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!isAbsolute(values.manifest ?? "") || !isAbsolute(values.report ?? "")) throw new Error("Usage: node scripts/run-native-acceleration-campaign.mjs --manifest /absolute/campaign.json --report /absolute/report.json [--append]");
  return values;
}

async function main() {
  const argumentsValue = parseArguments(process.argv.slice(2));
  const manifestBytes = await readFile(argumentsValue.manifest);
  const report = await runNativeAccelerationCampaign(JSON.parse(manifestBytes.toString("utf8")), {
    manifestPath: argumentsValue.manifest,
    reportPath: argumentsValue.report,
    manifestBytes,
    append: argumentsValue.append,
  });
  process.stdout.write(`${JSON.stringify({ status: "completed", report: argumentsValue.report, campaign_id: report.campaigns.at(-1)?.campaign_id })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let interruptedSignal;
  const interrupt = (signal) => { interruptedSignal ??= signal; void Promise.allSettled([...activeControllers].map(killController)); };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try { await main(); }
  catch (error) {
    if (interruptedSignal === undefined) process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = interruptedSignal === "SIGINT" ? 130 : interruptedSignal === "SIGTERM" ? 143 : 1;
  } finally {
    await Promise.allSettled([...activeControllers].map(killController));
    activeControllers.clear();
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}
