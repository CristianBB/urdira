#!/usr/bin/env node
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  lstat,
  mkdir,
  opendir,
  readFile,
  readlink,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const CONTROLLER_SCHEMA_VERSION = 2;
const MUTATION_TRACE_SCHEMA_VERSION = 1;
const MUTATION_COUNT = 60;
const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const LANES = new Set(["baseline", "candidate"]);
const CATEGORIES = new Set(["content", "import", "create", "delete", "rename", "tsconfig", "manifest"]);
const TIER_L_MAX_INDEXING_CORES = 6;
const TIER_L_MAX_RSS_BYTES = 8 * 1024 * 1024 * 1024;
// Keep the quiescence window time-based. The controller historically polled
// every 10 ms, so fifty identical observations represented about 500 ms. A
// slower diagnostic fallback (for example the structural preflight's 1 s
// interval) must not silently turn that window into fifty seconds.
const READINESS_STABLE_WINDOW_MS = 500;
const TERMINAL_SCAN_ERROR_MARKERS = Object.freeze(["resource_exhausted", "protocol", "build", "analysis"]);

function fail(subject, message) {
  throw new Error(`Invalid native acceleration ${subject}: ${message}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminalScanErrorCode(value) {
  const normalized = value.toLowerCase();
  // Unexpected worker and integration failures currently cross the daemon
  // boundary as this generic code. A qualifying benchmark cannot recover the
  // failed sample by continuing to poll the same frozen corpus.
  return normalized === "core:workspace_scan_failed"
    || TERMINAL_SCAN_ERROR_MARKERS.some((marker) => normalized.includes(marker));
}

function closed(value, subject, keys) {
  if (!isRecord(value)) fail(subject, "must be an object.");
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) fail(subject, `contains unknown fields: ${unknown.join(", ")}.`);
}

function string(value, subject) {
  if (typeof value !== "string" || value.length === 0) fail(subject, "must be a non-empty string.");
  return value;
}

function digest(value, subject) {
  const result = string(value, subject);
  if (!DIGEST_PATTERN.test(result)) fail(subject, "must be a lowercase sha256 digest.");
  return result;
}

function absolutePath(value, subject) {
  const path = string(value, subject);
  if (!isAbsolute(path)) fail(subject, `must be an absolute ${subject.includes("module") ? "runtime module" : "path"}.`);
  return resolve(path);
}

function positiveInteger(value, subject, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(subject, `must be an integer from ${minimum} through ${maximum}.`);
  return value;
}

function relativePath(value, subject) {
  const path = string(value, subject);
  if (path.includes("\\") || path.includes("\0") || path.startsWith("/") || path.endsWith("/")) fail(subject, "must be a normalized POSIX relative path.");
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) fail(subject, "must be a normalized POSIX relative path without empty, dot, or parent segments.");
  return path;
}

function uniqueStrings(value, subject) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) fail(subject, "must be an array of non-empty strings.");
  if (new Set(value).size !== value.length) fail(subject, "must not contain duplicates.");
  return [...value];
}

function decodeBase64(value, subject) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) fail(subject, "must be canonical base64.");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail(subject, "must be canonical base64.");
  return bytes;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function nativeAccelerationMutationTraceDigest(bytes) {
  if (!(bytes instanceof Uint8Array)) fail("mutation trace bytes", "must be a Uint8Array.");
  return sha256(bytes);
}

export function nativeAccelerationControllerConfigDigest(bytes) {
  if (!(bytes instanceof Uint8Array)) fail("controller config bytes", "must be a Uint8Array.");
  return sha256(bytes);
}

function validateChange(value, subject) {
  if (!isRecord(value)) fail(subject, "must be an object.");
  if (value.kind === "write") {
    closed(value, subject, ["kind", "path", "before_digest", "after_digest", "content_base64"]);
    const content = decodeBase64(value.content_base64, `${subject}.content_base64`);
    const afterDigest = digest(value.after_digest, `${subject}.after_digest`);
    if (sha256(content) !== afterDigest) fail(subject, "after_digest does not match content_base64.");
    return {
      kind: "write",
      path: relativePath(value.path, `${subject}.path`),
      before_digest: value.before_digest === null ? null : digest(value.before_digest, `${subject}.before_digest`),
      after_digest: afterDigest,
      content_base64: value.content_base64,
    };
  }
  if (value.kind === "delete") {
    closed(value, subject, ["kind", "path", "before_digest"]);
    return { kind: "delete", path: relativePath(value.path, `${subject}.path`), before_digest: digest(value.before_digest, `${subject}.before_digest`) };
  }
  if (value.kind === "rename") {
    closed(value, subject, ["kind", "from_path", "to_path", "content_digest"]);
    const fromPath = relativePath(value.from_path, `${subject}.from_path`);
    const toPath = relativePath(value.to_path, `${subject}.to_path`);
    if (fromPath === toPath) fail(subject, "rename source and destination must differ.");
    return { kind: "rename", from_path: fromPath, to_path: toPath, content_digest: digest(value.content_digest, `${subject}.content_digest`) };
  }
  fail(subject, "kind must be write, delete, or rename.");
}

export function validateNativeAccelerationMutationTrace(value) {
  closed(value, "mutation trace", ["schema_version", "trace_id", "base_corpus_digest", "excluded_paths", "mutations"]);
  if (value.schema_version !== MUTATION_TRACE_SCHEMA_VERSION) fail("mutation trace", `schema_version must be ${MUTATION_TRACE_SCHEMA_VERSION}.`);
  const traceId = string(value.trace_id, "mutation trace.trace_id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(traceId)) fail("mutation trace.trace_id", "contains unsupported characters.");
  if (!Array.isArray(value.excluded_paths)) fail("mutation trace.excluded_paths", "must be an array.");
  const excludedPaths = value.excluded_paths.map((path, index) => relativePath(path, `mutation trace.excluded_paths[${index}]`));
  if (new Set(excludedPaths).size !== excludedPaths.length) fail("mutation trace.excluded_paths", "must not contain duplicates.");
  if (!Array.isArray(value.mutations) || value.mutations.length !== MUTATION_COUNT) fail("mutation trace.mutations", `must contain exactly ${MUTATION_COUNT} mutations.`);
  const mutationIds = new Set();
  const mutations = value.mutations.map((mutation, index) => {
    const subject = `mutation trace.mutations[${index}]`;
    closed(mutation, subject, ["mutation_index", "mutation_id", "category", "changes", "resulting_corpus_digest"]);
    if (mutation.mutation_index !== index) fail(`${subject}.mutation_index`, `must be ${index}.`);
    const mutationId = string(mutation.mutation_id, `${subject}.mutation_id`);
    if (mutationIds.has(mutationId)) fail(`${subject}.mutation_id`, "must be unique.");
    mutationIds.add(mutationId);
    if (!CATEGORIES.has(mutation.category)) fail(`${subject}.category`, "is not in the closed mutation-category set.");
    if (!Array.isArray(mutation.changes) || mutation.changes.length === 0) fail(`${subject}.changes`, "must be a non-empty array.");
    const changes = mutation.changes.map((change, changeIndex) => validateChange(change, `${subject}.changes[${changeIndex}]`));
    const touched = [];
    for (const change of changes) touched.push(...(change.kind === "rename" ? [change.from_path, change.to_path] : [change.path]));
    if (new Set(touched).size !== touched.length) fail(`${subject}.changes`, "must not touch a path more than once.");
    const categorySupported = mutation.category === "create"
      ? changes.some((change) => change.kind === "write" && change.before_digest === null)
      : mutation.category === "delete"
        ? changes.some((change) => change.kind === "delete")
        : mutation.category === "rename"
          ? changes.some((change) => change.kind === "rename")
          : changes.some((change) => change.kind === "write" && change.before_digest !== null);
    if (!categorySupported) fail(subject, `category ${mutation.category} has no matching declared change.`);
    return {
      mutation_index: index,
      mutation_id: mutationId,
      category: mutation.category,
      changes,
      resulting_corpus_digest: digest(mutation.resulting_corpus_digest, `${subject}.resulting_corpus_digest`),
    };
  });
  const mutatedPaths = new Set(mutations.flatMap((mutation) => mutation.changes.flatMap((change) => change.kind === "rename" ? [change.from_path, change.to_path] : [change.path])));
  for (const excluded of excludedPaths) {
    if ([...mutatedPaths].some((path) => path === excluded || path.startsWith(`${excluded}/`))) fail("mutation trace.excluded_paths", `cannot exclude mutated path ${excluded}.`);
  }
  return {
    schema_version: MUTATION_TRACE_SCHEMA_VERSION,
    trace_id: traceId,
    base_corpus_digest: digest(value.base_corpus_digest, "mutation trace.base_corpus_digest"),
    excluded_paths: excludedPaths,
    mutations,
  };
}

export function validateNativeAccelerationControllerConfig(value) {
  closed(value, "controller config", ["schema_version", "lane", "corpus_path", "mutation_trace_path", "data_root", "runtime_module", "workspace_selection", "qualification", "polling"]);
  if (value.schema_version !== CONTROLLER_SCHEMA_VERSION) fail("controller config", `schema_version must be ${CONTROLLER_SCHEMA_VERSION}.`);
  if (!LANES.has(value.lane)) fail("controller config.lane", "must be baseline or candidate.");
  closed(value.workspace_selection, "controller config.workspace_selection", ["selected_technology_ids", "selected_plugin_ids"]);
  closed(value.qualification, "controller config.qualification", ["mode", "corpus_tier", "cache_state", "applied_limits", "capture_phase_timings"]);
  closed(value.qualification.applied_limits, "controller config.qualification.applied_limits", ["max_indexing_cores", "max_rss_bytes"]);
  if (value.qualification.mode !== "qualifying") fail("controller config.qualification.mode", "must be qualifying.");
  if (value.qualification.corpus_tier !== "L") fail("controller config.qualification.corpus_tier", "must be L.");
  if (value.qualification.cache_state !== "cold") fail("controller config.qualification.cache_state", "must be cold.");
  if (value.qualification.applied_limits.max_indexing_cores !== TIER_L_MAX_INDEXING_CORES) {
    fail("controller config.qualification.applied_limits.max_indexing_cores", `must be ${TIER_L_MAX_INDEXING_CORES}.`);
  }
  if (value.qualification.applied_limits.max_rss_bytes !== TIER_L_MAX_RSS_BYTES) {
    fail("controller config.qualification.applied_limits.max_rss_bytes", `must be ${TIER_L_MAX_RSS_BYTES}.`);
  }
  if (value.qualification.capture_phase_timings !== true) fail("controller config.qualification.capture_phase_timings", "must be true.");
  closed(value.polling, "controller config.polling", ["interval_ms", "readiness_timeout_ms"]);
  return {
    schema_version: CONTROLLER_SCHEMA_VERSION,
    lane: value.lane,
    corpus_path: absolutePath(value.corpus_path, "controller config.corpus_path"),
    mutation_trace_path: absolutePath(value.mutation_trace_path, "controller config.mutation_trace_path"),
    data_root: absolutePath(value.data_root, "controller config.data_root"),
    runtime_module: absolutePath(value.runtime_module, "controller config.runtime_module"),
    workspace_selection: {
      selected_technology_ids: uniqueStrings(value.workspace_selection.selected_technology_ids, "controller config.workspace_selection.selected_technology_ids"),
      selected_plugin_ids: uniqueStrings(value.workspace_selection.selected_plugin_ids, "controller config.workspace_selection.selected_plugin_ids"),
    },
    qualification: {
      mode: "qualifying",
      corpus_tier: "L",
      cache_state: "cold",
      applied_limits: {
        max_indexing_cores: TIER_L_MAX_INDEXING_CORES,
        max_rss_bytes: TIER_L_MAX_RSS_BYTES,
      },
      capture_phase_timings: true,
    },
    polling: {
      interval_ms: positiveInteger(value.polling.interval_ms, "controller config.polling.interval_ms", 10, 10_000),
      readiness_timeout_ms: positiveInteger(value.polling.readiness_timeout_ms, "controller config.polling.readiness_timeout_ms", 1_000, 24 * 60 * 60 * 1_000),
    },
  };
}

function isExcluded(path, excludedPaths) {
  return excludedPaths.some((excluded) => path === excluded || path.startsWith(`${excluded}/`));
}

async function digestFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

async function collectCorpusEntries(root, excludedPaths) {
  const entries = [];
  const visit = async (directory, prefix) => {
    const handle = await opendir(directory);
    const names = [];
    for await (const entry of handle) names.push(entry.name);
    names.sort();
    for (const name of names) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      if (isExcluded(path, excludedPaths)) continue;
      const absolute = join(root, ...path.split("/"));
      const metadata = await lstat(absolute);
      if (metadata.isDirectory()) await visit(absolute, path);
      else if (metadata.isFile()) entries.push({ path, kind: "file", digest: await digestFile(absolute) });
      else if (metadata.isSymbolicLink()) entries.push({ path, kind: "symlink", digest: sha256(await readlink(absolute)) });
      else fail("corpus", `contains unsupported filesystem entry ${path}.`);
    }
  };
  await visit(root, "");
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return entries;
}

function corpusStateDigest(entries) {
  return sha256(JSON.stringify([...entries.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)));
}

export async function loadNativeAccelerationCorpusState(rootValue, excludedPathsValue) {
  const root = absolutePath(rootValue, "corpus root");
  const excludedPaths = excludedPathsValue.map((path, index) => relativePath(path, `excluded_paths[${index}]`));
  const metadata = await stat(root).catch(() => undefined);
  if (metadata?.isDirectory() !== true) fail("corpus", `root is not an existing directory: ${root}`);
  const entries = await collectCorpusEntries(root, excludedPaths);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  return { entries: byPath, digest: corpusStateDigest(byPath), nextMutationIndex: 0 };
}

export async function computeNativeAccelerationCorpusDigest(root, excludedPaths) {
  return (await loadNativeAccelerationCorpusState(root, excludedPaths)).digest;
}

async function pathEntry(root, path) {
  const absolute = join(root, ...path.split("/"));
  const metadata = await lstat(absolute).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
  if (metadata === undefined) return undefined;
  if (metadata.isFile()) return { path, kind: "file", digest: await digestFile(absolute) };
  if (metadata.isSymbolicLink()) return { path, kind: "symlink", digest: sha256(await readlink(absolute)) };
  fail("mutation", `${path} is not a regular file or symbolic link.`);
}

async function ensureSafeParent(root, path) {
  const segments = path.split("/").slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const metadata = await lstat(current).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
    if (metadata === undefined) await mkdir(current);
    else if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("mutation", `parent path ${relative(root, current).split(sep).join("/")} is not a real directory.`);
  }
}

function expectedEntryForChange(state, change) {
  if (change.kind === "write") return state.entries.get(change.path);
  if (change.kind === "delete") return state.entries.get(change.path);
  return state.entries.get(change.from_path);
}

export async function applyNativeAccelerationMutation(rootValue, state, mutation) {
  const root = absolutePath(rootValue, "corpus root");
  if (!isRecord(state) || !(state.entries instanceof Map) || !Number.isSafeInteger(state.nextMutationIndex)) fail("corpus state", "is invalid.");
  if (mutation.mutation_index !== state.nextMutationIndex) fail("mutation", `mutation_index ${mutation.mutation_index} cannot run; next expected index is ${state.nextMutationIndex}.`);

  for (const change of mutation.changes) {
    const expected = expectedEntryForChange(state, change);
    const path = change.kind === "rename" ? change.from_path : change.path;
    const actual = await pathEntry(root, path);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("mutation", `${path} differs from the prepared corpus state.`);
    if (change.kind === "write") {
      if (change.before_digest === null ? expected !== undefined : expected?.kind !== "file" || expected.digest !== change.before_digest) fail("mutation", `${change.path} before_digest does not match the prepared corpus state.`);
    } else if (change.kind === "delete") {
      if (expected?.kind !== "file" || expected.digest !== change.before_digest) fail("mutation", `${change.path} before_digest does not match the prepared corpus state.`);
    } else {
      const destination = await pathEntry(root, change.to_path);
      if (expected?.kind !== "file" || expected.digest !== change.content_digest || destination !== undefined || state.entries.has(change.to_path)) fail("mutation", `${change.from_path} -> ${change.to_path} does not match the declared rename state.`);
    }
  }

  for (const change of mutation.changes) {
    if (change.kind === "write") {
      await ensureSafeParent(root, change.path);
      const destination = join(root, ...change.path.split("/"));
      const bytes = decodeBase64(change.content_base64, `${mutation.mutation_id}.${change.path}.content_base64`);
      if (change.before_digest === null) {
        // A campaign corpus is an isolated disposable copy. Create the
        // declared path directly so the watcher observes one presence event;
        // a visible temporary sibling plus rename would add undeclared work
        // and can force a conservative root-set reset before the real create.
        await writeFile(destination, bytes, { flag: "wx" });
      } else {
        // Preserve the existing directory entry for content/import/config
        // mutations. Replacing it via temp + rename is observed by kqueue as
        // an authoritative delete followed by a create, which measures a
        // conservative lifecycle reset instead of an incremental edit.
        await writeFile(destination, bytes);
      }
      const actual = await pathEntry(root, change.path);
      if (actual?.kind !== "file" || actual.digest !== change.after_digest) fail("mutation", `${change.path} did not reach after_digest.`);
      state.entries.set(change.path, actual);
    } else if (change.kind === "delete") {
      await unlink(join(root, ...change.path.split("/")));
      if (await pathEntry(root, change.path) !== undefined) fail("mutation", `${change.path} still exists after deletion.`);
      state.entries.delete(change.path);
    } else {
      await ensureSafeParent(root, change.to_path);
      await rename(join(root, ...change.from_path.split("/")), join(root, ...change.to_path.split("/")));
      const actual = await pathEntry(root, change.to_path);
      if (actual?.kind !== "file" || actual.digest !== change.content_digest || await pathEntry(root, change.from_path) !== undefined) fail("mutation", `${change.from_path} -> ${change.to_path} did not complete exactly.`);
      state.entries.delete(change.from_path);
      state.entries.set(change.to_path, actual);
    }
  }
  state.digest = corpusStateDigest(state.entries);
  if (state.digest !== mutation.resulting_corpus_digest) fail("mutation", `${mutation.mutation_id} resulting_corpus_digest does not match the applied state.`);
  state.nextMutationIndex += 1;
  return state.digest;
}

function inside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function requireFile(path, subject) {
  const metadata = await stat(path).catch(() => undefined);
  if (metadata?.isFile() !== true) fail(subject, `is not an existing file: ${path}`);
}

async function requireCleanDataRoot(path) {
  const metadata = await stat(path).catch(() => undefined);
  if (metadata === undefined) return;
  if (!metadata.isDirectory()) fail("controller config.data_root", "must be absent or an empty directory.");
  if ((await readdir(path)).length > 0) fail("controller config.data_root", "must be absent or an empty directory for a cold campaign.");
}

async function loadControllerInputs(configValue) {
  const config = validateNativeAccelerationControllerConfig(configValue);
  await requireFile(config.runtime_module, "controller config.runtime_module");
  await requireFile(config.mutation_trace_path, "controller config.mutation_trace_path");
  if (inside(config.corpus_path, config.data_root) || inside(config.data_root, config.corpus_path)) fail("controller config", "data_root and corpus_path must be disjoint.");
  if (inside(config.corpus_path, config.runtime_module)) fail("controller config.runtime_module", "must be outside the mutable corpus.");
  const traceBytes = await readFile(config.mutation_trace_path);
  let parsed;
  try { parsed = JSON.parse(traceBytes.toString("utf8")); } catch { fail("mutation trace", "must contain valid JSON."); }
  const trace = validateNativeAccelerationMutationTrace(parsed);
  if (inside(config.corpus_path, config.mutation_trace_path)) {
    const path = relative(config.corpus_path, config.mutation_trace_path).split(sep).join("/");
    if (!isExcluded(path, trace.excluded_paths)) fail("mutation trace", "must exclude its own path when stored inside the corpus.");
  }
  return { config, trace, traceBytes, mutationTraceDigest: nativeAccelerationMutationTraceDigest(traceBytes) };
}

function validateRequest(value) {
  if (!isRecord(value)) fail("controller request", "must be an object.");
  const operation = value.operation;
  const keys = ["schema_version", "request_id", "operation", "campaign_id", "lane", "target", "corpus_path", "corpus_digest", "mutation_trace_digest"];
  if (operation === "incremental_mutation") keys.push("mutation_index");
  closed(value, "controller request", keys);
  if (value.schema_version !== CONTROLLER_SCHEMA_VERSION) fail("controller request", `schema_version must be ${CONTROLLER_SCHEMA_VERSION}.`);
  if (!["prepare", "cold_index", "incremental_mutation", "shutdown"].includes(operation)) fail("controller request.operation", "is unknown.");
  return {
    schema_version: CONTROLLER_SCHEMA_VERSION,
    request_id: string(value.request_id, "controller request.request_id"),
    operation,
    campaign_id: string(value.campaign_id, "controller request.campaign_id"),
    lane: string(value.lane, "controller request.lane"),
    target: string(value.target, "controller request.target"),
    corpus_path: absolutePath(value.corpus_path, "controller request.corpus_path"),
    corpus_digest: digest(value.corpus_digest, "controller request.corpus_digest"),
    mutation_trace_digest: digest(value.mutation_trace_digest, "controller request.mutation_trace_digest"),
    ...(operation === "incremental_mutation" ? { mutation_index: positiveInteger(value.mutation_index, "controller request.mutation_index", 0, MUTATION_COUNT - 1) } : {}),
  };
}

function response(request, fields = {}) {
  return { schema_version: CONTROLLER_SCHEMA_VERSION, request_id: request.request_id, status: "ok", ...fields };
}

function roundedMilliseconds(value) {
  return Math.max(0.001, Math.round(value * 1_000) / 1_000);
}

async function measurePhase(phases, phase, action) {
  const startedAt = performance.now();
  try {
    return await action();
  } finally {
    phases.push({ phase, duration_ms: roundedMilliseconds(performance.now() - startedAt) });
  }
}

function structuredPhaseTimings(phases) {
  return {
    unit: "milliseconds",
    phases,
    total_duration_ms: roundedMilliseconds(phases.reduce((total, phase) => total + phase.duration_ms, 0)),
  };
}

function timingArguments(...arguments_) {
  return [...arguments_, "--debug-timing"];
}

function runOptions(controller, reportProgress = true) {
  return {
    daemon: controller.daemonOptions,
    admin_request_timeout_ms: controller.config.polling.readiness_timeout_ms,
    ...(reportProgress ? { on_progress: (progress) => process.stderr.write(`[native-acceleration-controller] ${progress.message ?? progress.phase}\n`) } : {}),
  };
}

function extractWorkspaceStatus(result, workspaceId) {
  if (result?.exit_code !== 0 || !isRecord(result.data) || !Array.isArray(result.data.workspaces)) throw new Error(`Urdira index status failed: ${JSON.stringify(result?.data ?? result)}`);
  const matches = result.data.workspaces.filter((workspace) => isRecord(workspace) && workspace.workspace_id === workspaceId);
  if (matches.length !== 1) throw new Error(`Urdira index status did not return exactly one workspace ${workspaceId}.`);
  return matches[0];
}

export async function readNativeAccelerationVisibleSetDigest(dataRootValue, workspaceIdValue, snapshotIdValue) {
  const dataRoot = absolutePath(dataRootValue, "data root");
  const workspaceId = string(workspaceIdValue, "workspace id");
  const snapshotId = string(snapshotIdValue, "snapshot id");
  const catalog = new DatabaseSync(join(dataRoot, "catalog.sqlite"), { readOnly: true, timeout: 5_000 });
  let registration;
  try {
    registration = catalog.prepare("SELECT database_path FROM installation_workspaces WHERE workspace_id = ? AND removed_at IS NULL").get(workspaceId);
  } finally { catalog.close(); }
  if (!isRecord(registration) || typeof registration.database_path !== "string" || !isAbsolute(registration.database_path)) throw new Error(`Urdira catalog has no active database for workspace ${workspaceId}.`);
  const database = new DatabaseSync(registration.database_path, { readOnly: true, timeout: 5_000 });
  let snapshot;
  try {
    snapshot = database.prepare(`SELECT s.snapshot_id, s.canonical_record_set_digest
      FROM workspace_current_state AS c
      JOIN snapshots AS s ON s.workspace_id = c.workspace_id AND s.snapshot_id = c.current_snapshot_id
      WHERE c.workspace_id = ?`).get(workspaceId);
  } finally { database.close(); }
  if (!isRecord(snapshot) || snapshot.snapshot_id !== snapshotId) throw new Error(`Urdira current snapshot does not match ready snapshot ${snapshotId}.`);
  return digest(snapshot.canonical_record_set_digest, "Urdira snapshot canonical_record_set_digest");
}

export async function createNativeAccelerationController(configValue) {
  const inputs = await loadControllerInputs(configValue);
  return new NativeAccelerationController(inputs);
}

class NativeAccelerationController {
  constructor(inputs) {
    this.config = inputs.config;
    this.trace = inputs.trace;
    this.traceBytes = inputs.traceBytes;
    this.mutationTraceDigest = inputs.mutationTraceDigest;
  }

  config;
  trace;
  traceBytes;
  mutationTraceDigest;
  corpusState;
  runtime;
  daemonOptions;
  preparedRequest;
  workspaceId;
  snapshotId;
  sourceSnapshotId;
  stage = "created";

  assertRequestIdentity(request) {
    if (request.lane !== this.config.lane) throw new Error(`Controller is configured for ${this.config.lane}, not ${request.lane}.`);
    if (request.corpus_path !== this.config.corpus_path) throw new Error("Controller request corpus_path does not match its explicit lane configuration.");
    if (this.preparedRequest !== undefined) {
      for (const field of ["campaign_id", "lane", "target", "corpus_path", "corpus_digest", "mutation_trace_digest"]) {
        if (request[field] !== this.preparedRequest[field]) throw new Error(`Controller request ${field} changed after prepare.`);
      }
    }
  }

  async handle(value) {
    const request = validateRequest(value);
    this.assertRequestIdentity(request);
    if (request.operation === "prepare") return await this.prepare(request);
    if (request.operation === "cold_index") return await this.coldIndex(request);
    if (request.operation === "incremental_mutation") return await this.incrementalMutation(request);
    return await this.shutdown(request);
  }

  async prepare(request) {
    if (this.stage !== "created") throw new Error(`prepare is invalid while controller stage is ${this.stage}.`);
    if (request.corpus_digest !== this.trace.base_corpus_digest) throw new Error("Declared corpus digest does not match the mutation trace base_corpus_digest.");
    if (request.mutation_trace_digest !== this.mutationTraceDigest) throw new Error("Declared mutation_trace_digest does not match the exact trace file bytes.");
    await requireCleanDataRoot(this.config.data_root);
    this.corpusState = await loadNativeAccelerationCorpusState(this.config.corpus_path, this.trace.excluded_paths);
    if (this.corpusState.digest !== request.corpus_digest) throw new Error("Prepared corpus copy does not match the declared tier-L corpus digest.");
    this.preparedRequest = request;
    this.stage = "prepared";
    return response(request, { corpus_digest: request.corpus_digest, mutation_trace_digest: request.mutation_trace_digest });
  }

  async loadRuntime() {
    process.env["URDIRA_DEBUG_TIMING"] = "1";
    process.env["URDIRA_STORAGE_DEBUG_TIMING"] = "1";
    const imported = await import(pathToFileURL(this.config.runtime_module).href);
    if (typeof imported.runUrdira !== "function" || typeof imported.defaultDaemonOptions !== "function") throw new Error("Configured runtime_module must export runUrdira and defaultDaemonOptions.");
    this.runtime = imported;
    this.daemonOptions = await imported.defaultDaemonOptions(this.config.data_root);
  }

  async status(previousSnapshotId, previousSourceSnapshotId) {
    const deadline = Date.now() + this.config.polling.readiness_timeout_ms;
    const readinessStablePolls = Math.max(2, Math.ceil(READINESS_STABLE_WINDOW_MS / this.config.polling.interval_ms));
    let lastScanErrorCode;
    let pendingTerminalScanErrorCode;
    let stableSnapshotId;
    let stableReadyPolls = 0;
    await delay(this.config.polling.interval_ms);
    while (Date.now() < deadline) {
      const result = await this.runtime.runUrdira(timingArguments("index", "--workspace", this.workspaceId, "--json"), runOptions(this, false));
      const workspace = extractWorkspaceStatus(result, this.workspaceId);
      if (typeof workspace.last_scan_error_code === "string") {
        lastScanErrorCode = workspace.last_scan_error_code;
        stableSnapshotId = undefined;
        stableReadyPolls = 0;
        if (isTerminalScanErrorCode(lastScanErrorCode)) {
          if (pendingTerminalScanErrorCode === lastScanErrorCode) {
            const publishedSnapshotId = typeof workspace.current_snapshot_id === "string"
              ? workspace.current_snapshot_id
              : previousSnapshotId;
            throw new Error(`Urdira scan failed with stable terminal error ${lastScanErrorCode}; last published snapshot remains ${publishedSnapshotId ?? "none"}.`);
          }
          pendingTerminalScanErrorCode = lastScanErrorCode;
        } else {
          pendingTerminalScanErrorCode = undefined;
        }
        await delay(this.config.polling.interval_ms);
        continue;
      }
      pendingTerminalScanErrorCode = undefined;
      const snapshotAdvanced = typeof workspace.current_snapshot_id === "string" && workspace.current_snapshot_id !== previousSnapshotId;
      // A source-only change can be structurally equivalent (for example a
      // comment or metadata edit) and therefore legitimately retain the same
      // structural snapshot. Treat the completed source frontier as progress
      // for incremental readiness, while still requiring the normal stable
      // ready window so we never accept a pre-scan observation.
      const sourceAdvanced = typeof workspace.source_snapshot_id === "string" && workspace.source_snapshot_id !== previousSourceSnapshotId;
      const ready = workspace.workspace_status === "ready"
        && workspace.structural_ready === true
        && workspace.structural_freshness === "equivalent"
        && typeof workspace.current_snapshot_id === "string"
        && (snapshotAdvanced || sourceAdvanced);
      if (ready) {
        const stabilityToken = `${workspace.current_snapshot_id}:${workspace.source_snapshot_id ?? ""}`;
        if (stabilityToken === stableSnapshotId) stableReadyPolls += 1;
        else {
          stableSnapshotId = stabilityToken;
          stableReadyPolls = 1;
        }
        // A filesystem write can surface as several watcher observations
        // (present, transient absence, present again). Advancing after the
        // first structurally-ready publication lets the next declared
        // mutation overlap those follow-up scans and invalidates both timing
        // and visible-set evidence. Require the same ready snapshot across a
        // bounded quiescence window before measuring it.
        if (stableReadyPolls >= readinessStablePolls) return workspace;
      } else {
        stableSnapshotId = undefined;
        stableReadyPolls = 0;
      }
      await delay(this.config.polling.interval_ms);
    }
    if (lastScanErrorCode !== undefined) throw new Error(`Urdira scan did not recover from ${lastScanErrorCode} within ${this.config.polling.readiness_timeout_ms} ms.`);
    throw new Error(`Urdira did not publish a complete structurally ready snapshot within ${this.config.polling.readiness_timeout_ms} ms.`);
  }

  async coldIndex(request) {
    if (this.stage !== "prepared") throw new Error(`cold_index is invalid while controller stage is ${this.stage}.`);
    const phases = [];
    await measurePhase(phases, "runtime_load", () => this.loadRuntime());
    const started = await measurePhase(phases, "daemon_start", () => this.runtime.runUrdira(timingArguments("daemon", "start", "--json"), runOptions(this)));
    if (started.exit_code !== 0) throw new Error(`Urdira foreground daemon start failed: ${JSON.stringify(started.data)}`);
    const selection = JSON.stringify(this.config.workspace_selection);
    const added = await measurePhase(phases, "workspace_add", () => this.runtime.runUrdira(timingArguments("workspace", "add", this.config.corpus_path, "--payload", selection, "--confirm", "--json"), runOptions(this)));
    const workspaceId = isRecord(added.data) && isRecord(added.data.result) ? added.data.result.workspace_id : undefined;
    if (added.exit_code !== 0 || typeof workspaceId !== "string" || workspaceId.length === 0) throw new Error(`Urdira workspace add failed: ${JSON.stringify(added.data)}`);
    this.workspaceId = workspaceId;
    const workspace = await measurePhase(phases, "readiness", () => this.status(undefined, undefined));
    this.snapshotId = workspace.current_snapshot_id;
    this.sourceSnapshotId = workspace.source_snapshot_id;
    const visibleSetDigest = await measurePhase(phases, "digest", () => readNativeAccelerationVisibleSetDigest(this.config.data_root, this.workspaceId, this.snapshotId));
    this.stage = "mutating";
    return response(request, { phase_timings: structuredPhaseTimings(phases), visible_set_digest: visibleSetDigest });
  }

  async incrementalMutation(request) {
    if (this.stage !== "mutating") throw new Error(`incremental_mutation is invalid while controller stage is ${this.stage}.`);
    if (request.mutation_index !== this.corpusState.nextMutationIndex) throw new Error(`Expected mutation_index ${this.corpusState.nextMutationIndex}, received ${request.mutation_index}.`);
    const mutation = this.trace.mutations[request.mutation_index];
    const phases = [];
    await measurePhase(phases, "mutation_apply", () => applyNativeAccelerationMutation(this.config.corpus_path, this.corpusState, mutation));
    let workspace;
    try { workspace = await measurePhase(phases, "readiness", () => this.status(this.snapshotId, this.sourceSnapshotId)); }
    catch (error) { throw new Error(`Mutation ${request.mutation_index} (${mutation.mutation_id}) did not reach a complete structurally ready snapshot: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    this.snapshotId = workspace.current_snapshot_id;
    this.sourceSnapshotId = workspace.source_snapshot_id;
    const visibleSetDigest = await measurePhase(phases, "digest", () => readNativeAccelerationVisibleSetDigest(this.config.data_root, this.workspaceId, this.snapshotId));
    return response(request, { phase_timings: structuredPhaseTimings(phases), mutation_index: request.mutation_index, visible_set_digest: visibleSetDigest });
  }

  async shutdown(request) {
    if (this.stage !== "mutating" || this.corpusState.nextMutationIndex !== MUTATION_COUNT) throw new Error(`shutdown requires all ${MUTATION_COUNT} mutations to complete.`);
    const actual = await computeNativeAccelerationCorpusDigest(this.config.corpus_path, this.trace.excluded_paths);
    if (actual !== this.corpusState.digest) throw new Error("Final corpus verification found an undeclared filesystem change.");
    await this.stopRuntime();
    this.stage = "disposed";
    return response(request);
  }

  async stopRuntime() {
    if (this.runtime === undefined || this.daemonOptions === undefined) return;
    const runtime = this.runtime;
    this.runtime = undefined;
    try {
      const stopped = await runtime.runUrdira(timingArguments("daemon", "stop", "--json"), { daemon: this.daemonOptions });
      if (stopped.exit_code !== 0) throw new Error(`Urdira foreground daemon stop failed: ${JSON.stringify(stopped.data)}`);
    } finally {
      this.daemonOptions = undefined;
    }
  }

  async dispose() {
    await this.stopRuntime();
    this.stage = "disposed";
  }
}

function parseArguments(argv) {
  const result = { validate: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--validate") result.validate = true;
    else if (argument === "--config") {
      const path = argv[index + 1];
      if (path === undefined || !isAbsolute(path)) throw new Error("--config requires an absolute path.");
      result.config = resolve(path);
      index += 1;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (result.config === undefined) throw new Error("Usage: node scripts/native-acceleration-controller.mjs --config /absolute/controller.json [--validate]");
  return result;
}

export async function runNativeAccelerationControllerCli(argv, io = {}) {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const args = parseArguments(argv);
  const configBytes = await readFile(args.config);
  let config;
  try { config = JSON.parse(configBytes.toString("utf8")); } catch { throw new Error("Controller config must contain valid JSON."); }
  const controller = await createNativeAccelerationController(config);
  if (args.validate) {
    try {
      await requireCleanDataRoot(controller.config.data_root);
      const state = await loadNativeAccelerationCorpusState(controller.config.corpus_path, controller.trace.excluded_paths);
      if (state.digest !== controller.trace.base_corpus_digest) throw new Error("Corpus copy does not match mutation trace base_corpus_digest.");
      stdout.write(`${JSON.stringify({ schema_version: CONTROLLER_SCHEMA_VERSION, status: "valid", lane: controller.config.lane, corpus_digest: state.digest, mutation_trace_digest: controller.mutationTraceDigest, configuration_digest: nativeAccelerationControllerConfigDigest(configBytes), mutation_count: controller.trace.mutations.length })}\n`);
    } finally { await controller.dispose(); }
    return;
  }
  const reader = createInterface({ input: stdin, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      let request;
      try {
        if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) throw new Error("Controller request line exceeds 1 MiB.");
        request = JSON.parse(line);
        const result = await controller.handle(request);
        stdout.write(`${JSON.stringify(result)}\n`);
        if (request.operation === "shutdown") return;
      } catch (error) {
        const requestId = isRecord(request) && typeof request.request_id === "string" ? request.request_id : "invalid-request";
        stdout.write(`${JSON.stringify({ schema_version: CONTROLLER_SCHEMA_VERSION, request_id: requestId, status: "error", error: error instanceof Error ? error.message : String(error) })}\n`);
        process.exitCode = 1;
        return;
      }
    }
    throw new Error("Controller stdin ended before a valid shutdown request.");
  } finally { await controller.dispose(); }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runNativeAccelerationControllerCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
