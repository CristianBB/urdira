import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { deserialize, serialize } from "node:v8";
import { gunzip as gunzipCallback, gzip as gzipCallback } from "node:zlib";
import { LogicalDigestWriter } from "@urdira/canonical";
import { FACT_DELTA_STREAM_MAX_BYTES, FACT_DELTA_STREAM_MAX_ROWS, canonicalSha256, factDeltaStreamCanonicalRow, factDeltaStreamSealedRows, prepareFactDeltaStreamStructuralGroup, projectStructuralObservationGroup, type FactDeltaStream, type PluginWorkerRequestEnvelope, type SealedStructuralProjectionOwner, type WorkerTransport } from "@urdira/plugin-sdk";
import { analyzeBoundedSyntaxProject, analyzeSyntaxDependencyGraph, analyzeSyntaxProject, discoverProjects, isLargeSyntaxCorpus, JAVASCRIPT_TYPESCRIPT_CAPABILITIES, JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, JAVASCRIPT_TYPESCRIPT_VERSION, JsTsAnalysisSession, LARGE_SYNTAX_CORPUS_BYTE_THRESHOLD, LARGE_SYNTAX_CORPUS_FILE_THRESHOLD, TYPESCRIPT_COMPILER_VERSION, type AnalyzerFile, type JsTsAnalysisResult, type JsTsDirectDependency, type JsTsRustSemanticScope, type RustHybridPendingSite } from "./analyzer.js";
import { buildJavascriptTypescriptFactDelta, buildJavascriptTypescriptFactDeltaStream, buildJavascriptTypescriptNativeFactDeltaHeader, JAVASCRIPT_TYPESCRIPT_NATIVE_PROJECTION_PROFILE, javascriptTypescriptNativeProjectionOwner, prepareJavascriptTypescriptFactDeltaStream, prepareJavascriptTypescriptProjectedFactDeltaStream, type JavascriptTypescriptFactDeltaInput, type JavascriptTypescriptNativeFactDeltaInput, type PreparedJavascriptTypescriptFactDeltaStream } from "./fact-delta.js";
import { iterateNativeFactDeltaBatches } from "./native-batches.js";

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

async function filesFromPayload(payload: unknown, casRoot?: string, options: { readonly load_concurrency?: number; readonly max_in_flight_bytes?: number } = {}): Promise<AnalyzerFile[]> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Worker payload must be an object.");
  const files = (payload as Record<string, unknown>)["files"];
  if (!Array.isArray(files)) throw new Error("Worker payload.files must be an array.");
  const concurrency = options.load_concurrency !== undefined && Number.isSafeInteger(options.load_concurrency) && options.load_concurrency > 0 ? options.load_concurrency : 16;
  const maxInFlightBytes = options.max_in_flight_bytes !== undefined && Number.isSafeInteger(options.max_in_flight_bytes) && options.max_in_flight_bytes > 0 ? options.max_in_flight_bytes : 64 * 1024 * 1024;
  const load = async (entry: unknown): Promise<AnalyzerFile> => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)
      || typeof (entry as Record<string, unknown>)["path"] !== "string") {
      throw new Error("Worker payload.files contains an invalid source file.");
    }
    const source = entry as Record<string, unknown>;
    const path = source["path"] as string;
    if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error("Worker source paths must be normalized relative paths.");
    }
    const textValue = source["text"];
    const byteValue = source["bytes"];
    const contentHash = source["content_hash"];
    const hasReference = typeof source["content_hash"] === "string" && typeof casRoot === "string";
    if ((typeof textValue !== "string" && !(byteValue instanceof Uint8Array) && !hasReference) || (typeof textValue === "string" && byteValue !== undefined)) {
      throw new Error("Worker payload.files must provide exactly one text, Uint8Array, or verified CAS source.");
    }
    let text: string;
    if (typeof textValue === "string") text = textValue;
    else if (byteValue instanceof Uint8Array) text = new TextDecoder("utf-8", { fatal: true }).decode(byteValue);
    else {
      const hash = contentHash as string;
      if (!/^sha256:[0-9a-f]{64}$/u.test(hash)) throw new Error("Worker CAS source hash is invalid.");
      const hex = hash.slice("sha256:".length);
      // `readFile` already returns a Buffer (a Uint8Array view). Keep that
      // native view; wrapping it in `new Uint8Array(...)` would copy every
      // source before the single UTF-8 decode below.
      // Single-level shard layout (`sha256/<2-hex>/<62-hex>`): must mirror
      // `casObjectRelativeParts` in `packages/storage/src/cas.ts` exactly.
      // This package cannot import that helper (layer 2 cannot depend on
      // `@urdira/storage`, `architecture/manifest.json`).
      const bytes = await readFile(join(casRoot!, "sha256", hex.slice(0, 2), hex.slice(2)));
      if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== hash) throw new Error(`Worker CAS source ${hash} failed digest verification.`);
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    const artifactId = source["artifact_id"];
    const artifactVersionId = source["artifact_version_id"];
    for (const [field, value] of [["artifact_id", artifactId], ["artifact_version_id", artifactVersionId], ["content_hash", contentHash]] as const) {
      if (value !== undefined && (typeof value !== "string" || value.length === 0)) throw new Error(`Worker payload.files ${field} must be a non-empty string when present.`);
    }
    return { path, text, ...(typeof artifactId === "string" ? { artifact_id: artifactId } : {}), ...(typeof artifactVersionId === "string" ? { artifact_version_id: artifactVersionId } : {}), ...(typeof contentHash === "string" ? { content_hash: contentHash } : {}) };
  };
  const result: AnalyzerFile[] = new Array(files.length);
  for (let start = 0; start < files.length; start += concurrency) {
    const end = Math.min(files.length, start + concurrency);
    const loaded = await Promise.all(files.slice(start, end).map(load));
    let batchBytes = 0;
    for (const file of loaded) batchBytes += Buffer.byteLength(file.text, "utf8");
    if (batchBytes > maxInFlightBytes) throw new Error(`Worker source batch exceeds the ${maxInFlightBytes}-byte in-flight limit.`);
    for (let index = 0; index < loaded.length; index += 1) result[start + index] = loaded[index]!;
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Reconstructs only immutable artifact metadata after a checker snapshot has
 * already verified and analyzed the exact content hashes. Owner publication
 * needs artifact/version bindings for dependencies, but it must not reread,
 * hash, and UTF-8 decode the same CAS bytes once per owner or later stage.
 * Any mismatch falls back to the full verified source-loading path.
 */
function filesFromPreparedPayload(payload: unknown, preparedFileHashes: ReadonlyMap<string, string>): AnalyzerFile[] | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const entries = (payload as Record<string, unknown>)["files"];
  if (!Array.isArray(entries)) return undefined;
  const files: AnalyzerFile[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const source = entry as Record<string, unknown>;
    const path = source["path"];
    const contentHash = source["content_hash"];
    if (typeof path !== "string" || path.length === 0 || path.startsWith("/") || path.includes("\\")
      || path.split("/").some((part) => part === "" || part === "." || part === "..")
      || source["text"] !== undefined || source["bytes"] !== undefined
      || typeof contentHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(contentHash)
      || preparedFileHashes.get(path) !== contentHash) return undefined;
    const artifactId = source["artifact_id"];
    const artifactVersionId = source["artifact_version_id"];
    if ((artifactId !== undefined && (typeof artifactId !== "string" || artifactId.length === 0))
      || (artifactVersionId !== undefined && (typeof artifactVersionId !== "string" || artifactVersionId.length === 0))) return undefined;
    files.push({
      path,
      text: "",
      content_hash: contentHash,
      ...(typeof artifactId === "string" ? { artifact_id: artifactId } : {}),
      ...(typeof artifactVersionId === "string" ? { artifact_version_id: artifactVersionId } : {}),
    });
  }
  // Rust emits closure metadata in canonical path order. Keep that hot path
  // allocation-free; retain the defensive sort for private callers/tests that
  // construct an equivalent payload in an arbitrary order.
  let ordered = true;
  for (let index = 1; index < files.length; index += 1) {
    if (files[index - 1]!.path.localeCompare(files[index]!.path) > 0) { ordered = false; break; }
  }
  return ordered ? files : files.sort((left, right) => left.path.localeCompare(right.path));
}

type SyntaxDependencyGraph = Readonly<Record<string, JsTsDirectDependency>>;

function rustSemanticScopeFromPayload(
  payload: Readonly<Record<string, unknown>>,
  rootNames: readonly string[],
  preparedScope?: JsTsRustSemanticScope,
): JsTsRustSemanticScope | undefined {
  const value = payload["rust_semantic_scope"];
  if (value === undefined) {
    const reference = payload["rust_semantic_scope_ref"];
    if (reference === undefined) return undefined;
    if (typeof reference !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(reference) || preparedScope === undefined || canonicalSha256(preparedScope) !== reference) {
      throw new Error("rust_semantic_scope_ref does not match the prepared Rust-authoritative scope.");
    }
    // Owner requests intentionally carry only their local root marker. The
    // immutable closure scope was validated against the complete root set
    // during preparation, so do not revalidate the full affected manifest
    // against that one-owner marker on every hot request.
    return preparedScope;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("rust_semantic_scope must be an object.");
  const scope = value as Record<string, unknown>;
  const keys = Object.keys(scope).sort();
  if (keys.length !== 3 || keys[0] !== "affected_paths" || keys[1] !== "authority" || keys[2] !== "changed_paths"
    || scope["authority"] !== "urdira:jsts-syntax-worker"
    || !Array.isArray(scope["changed_paths"]) || !scope["changed_paths"].every((path) => typeof path === "string")
    || !Array.isArray(scope["affected_paths"]) || !scope["affected_paths"].every((path) => typeof path === "string")) {
    throw new Error("rust_semantic_scope is not a closed Rust-authoritative scope.");
  }
  const changedPaths = scope["changed_paths"] as string[];
  const affectedPaths = scope["affected_paths"] as string[];
  const roots = new Set(rootNames);
  if (new Set(changedPaths).size !== changedPaths.length || new Set(affectedPaths).size !== affectedPaths.length
    || changedPaths.some((path) => !roots.has(path)) || affectedPaths.some((path) => !roots.has(path))) {
    throw new Error("rust_semantic_scope paths must be unique members of root_names.");
  }
  const affected = new Set(affectedPaths);
  if (changedPaths.some((path) => !affected.has(path))) throw new Error("rust_semantic_scope affected_paths must contain changed_paths.");
  const parsed = { authority: "urdira:jsts-syntax-worker", changed_paths: changedPaths, affected_paths: affectedPaths } as const;
  const scopeId = payload["rust_semantic_scope_id"];
  if (scopeId !== undefined && (typeof scopeId !== "string" || canonicalSha256(parsed) !== scopeId)) throw new Error("rust_semantic_scope_id does not match the closed Rust-authoritative scope.");
  return parsed;
}

/**
 * E1c cutover (design doc E1, step 3 of the handoff): reads one owner
 * request's `rust_hybrid_pending_sites` -- present only when
 * `URDIRA_JSTS_HYBRID=1` (`urdira-indexing-worker`'s `semantic_request`
 * embeds it exactly then, never otherwise), so `undefined` here is exactly
 * the flag-off signal that tells `analyzeRustSemanticOwner`/
 * `beginRustSemanticOwnerGroup` to keep doing their own full `collectAll`
 * walk unchanged. Malformed entries are dropped rather than thrown on: a
 * dropped site only costs the checker doing slightly more work than
 * strictly necessary (it is never wrong for the checker to look at a node
 * Rust didn't ask about), so failing softly here is strictly safer than
 * failing the whole owner over one bad wire entry.
 */
function pendingSitesFromPayload(payload: Readonly<Record<string, unknown>>): readonly RustHybridPendingSite[] | undefined {
  const raw = payload["rust_hybrid_pending_sites"];
  if (!Array.isArray(raw)) return undefined;
  const sites: RustHybridPendingSite[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const start = record["start_utf16"];
    const end = record["end_utf16"];
    const kind = record["site_kind"];
    if (typeof start === "number" && typeof end === "number"
      && (kind === "identifier_ref" || kind === "call" || kind === "heritage" || kind === "typed_decl")) {
      sites.push({ start_utf16: start, end_utf16: end, site_kind: kind });
    }
  }
  return sites;
}

/** Builds the per-owner pending-site map `beginRustSemanticOwnerGroup`
 * expects, straight from a bounded request group's own payloads -- there is
 * no separate "group" wire shape, each owner's `rust_hybrid_pending_sites`
 * simply rides its own `analyze_artifact` request (see `semantic_request`
 * in urdira-indexing-worker/src/main.rs). `undefined` for an owner (rather
 * than an omitted map entry) is impossible here: `pendingSitesFromPayload`
 * only ever returns `undefined` when the whole flag is off, in which case
 * every request in the group lacks the field and this returns an empty map
 * -- `beginRustSemanticOwnerGroup` then falls back to `collectAll` for
 * every owner, unchanged. */
function pendingSitesByOwnerFromRequests(requests: readonly PluginWorkerRequestEnvelope[]): ReadonlyMap<string, readonly RustHybridPendingSite[]> {
  const byOwner = new Map<string, readonly RustHybridPendingSite[]>();
  for (const request of requests) {
    const payload = request.payload as Record<string, unknown>;
    const ownerPath = payload["owner_path"];
    if (typeof ownerPath !== "string") continue;
    const sites = pendingSitesFromPayload(payload);
    if (sites !== undefined) byOwner.set(ownerPath, sites);
  }
  return byOwner;
}

export function largeSyntaxManifestKey(payload: unknown, rootNames: readonly string[], descriptor: JavascriptTypescriptWorkerDescriptor): string | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const entries = (payload as Record<string, unknown>)["files"];
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const manifest = [] as { readonly path: string; readonly content_hash: string; readonly byte_length?: number }[];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const value = entry as Record<string, unknown>;
    if (typeof value["path"] !== "string" || typeof value["content_hash"] !== "string") return undefined;
    manifest.push({ path: value["path"], content_hash: value["content_hash"], ...(typeof value["byte_length"] === "number" ? { byte_length: value["byte_length"] } : {}) });
  }
  return durableAnalysisCacheKey(canonicalSha256({
    stage: "syntax_dependency_graph",
    files: manifest.sort((left, right) => left.path.localeCompare(right.path)),
    root_names: [...rootNames].sort(),
  }), descriptor, "syntax-graph");
}

export function syntaxDependencyGraphCachePath(dir: string, durableKey: string): string {
  return join(dir, `${durableKey}.graph.json.gz`);
}

function isValidSyntaxDependencyGraph(value: unknown): value is SyntaxDependencyGraph {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((node) => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
    const candidate = node as Record<string, unknown>;
    return Array.isArray(candidate["direct_files"])
      && (candidate["direct_files"] as unknown[]).every((path) => typeof path === "string")
      && typeof candidate["complete"] === "boolean";
  });
}

async function readSyntaxDependencyGraphCache(dir: string, durableKey: string): Promise<SyntaxDependencyGraph | undefined> {
  const filePath = syntaxDependencyGraphCachePath(dir, durableKey);
  try {
    const parsed = JSON.parse((await gunzip(await readFile(filePath))).toString("utf8")) as { format_version?: unknown; durable_key?: unknown; dependency_graph?: unknown };
    if (parsed.format_version !== 1 || parsed.durable_key !== durableKey || !isValidSyntaxDependencyGraph(parsed.dependency_graph)) throw new Error("Invalid syntax dependency graph cache entry.");
    return parsed.dependency_graph as SyntaxDependencyGraph;
  } catch {
    await unlink(filePath).catch(() => undefined);
    return undefined;
  }
}

export async function writeSyntaxDependencyGraphCache(dir: string, durableKey: string, dependencyGraph: SyntaxDependencyGraph): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    const compressed = await gzip(Buffer.from(JSON.stringify({ format_version: 1, durable_key: durableKey, dependency_graph: dependencyGraph })), { level: 1 });
    const finalPath = syntaxDependencyGraphCachePath(dir, durableKey);
    const tempPath = `${finalPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    await writeFile(tempPath, compressed);
    await rename(tempPath, finalPath);
  } catch {
    /* The graph cache is a pure speedup; a failed write must not fail indexing. */
  }
}

function response(request: PluginWorkerRequestEnvelope, payload: unknown): unknown {
  return {
    protocol_version: request.protocol_version,
    request_id: request.request_id,
    request_digest: request.request_digest,
    call: request.call,
    outcome: "success",
    payload,
  };
}

/** Project the validated fixed fields into the native columnar hand-off. */
export interface JavascriptTypescriptWorkerDescriptor {
  readonly compatibility_declaration_digest?: string;
  readonly registry_contribution_digest?: string;
  readonly analysis_digest?: string;
  readonly analysis_configuration_digest?: string;
  /** Exact Decision 25 executable binding selected in the resolution lock. */
  readonly runtime_executable_binding_digest?: string;
  /** Immutable CAS root used for native source-reference hydration inside the worker. */
  readonly cas_root?: string;
  /** Maximum concurrent CAS reads for one analyzer request. */
  readonly source_load_concurrency?: number;
  /** Maximum UTF-8 bytes decoded by one bounded source-read batch. */
  readonly source_load_max_in_flight_bytes?: number;
  /**
   * Directory for the durable (on-disk, cross-process) whole-project analysis cache --
   * see the doc comment on `loadOrBuildAnalysis`, below, for the full design. Absent
   * (the default) means today's behavior, byte-for-byte: no filesystem is ever touched,
   * only the in-memory single-entry cache applies. Set by
   * `apps/urdira/src/index.ts`'s `defaultDaemonOptions` to a directory under the daemon's
   * own data root, so a fresh per-scan worker (see `worker-thread.ts`'s doc comment: one
   * thread per scan, hard-killed on `terminate()`) can still skip a from-scratch
   * whole-project rebuild when a prior scan -- of this workspace, a donor workspace a
   * fork copied from, or a pre-fork daemon restart -- already analyzed the identical
   * (files, root_names, compiler_options) under the identical analyzer/compiler build.
   */
  readonly analysis_cache_dir?: string;
  /**
   * Prune cap for `analysis_cache_dir`: the durable cache keeps at most this many entries,
   * evicting the oldest (by file mtime) beyond the cap after every successful write. Default
   * 16 -- generous enough to survive a handful of analyzer/compiler upgrades and a handful of
   * distinct workspace trees without unbounded growth, since every upgrade or genuinely
   * different tree mints a disjoint durable key rather than overwriting an existing entry.
   */
  readonly analysis_cache_max_entries?: number;
  /** Production hosts derive and persist native batches after raw-delta acceptance. */
  readonly native_batch_transport?: "response" | "host";
  /**
   * Test-only instrumentation hook invoked whenever the worker actually rebuilds the
   * whole-project TypeScript analysis (a cache miss). Not part of the wire protocol and
   * not read by any production caller; it exists so tests can assert the analysis cache
   * is effective without reaching into worker-private state.
   */
  readonly on_analysis_build?: () => void;
  /**
   * Test-only instrumentation hook invoked whenever the worker serves a build from the
   * durable on-disk cache instead of running `analyzeProject`. Same non-production,
   * non-wire-protocol status as `on_analysis_build`, above -- see `worker-thread.ts`'s doc
   * comment for why both are excluded from the fields that cross the thread boundary via
   * `workerData` (functions cannot survive structured clone).
   */
  readonly on_analysis_cache_load?: () => void;
  /**
   * Test-only instrumentation hook invoked whenever the worker's `JsTsAnalysisSession`
   * (one per worker, see `loadOrBuildAnalysis`) served a real build via its INCREMENTAL
   * path (a re-walk of a strict subset of root files, memo-merged with the rest) rather
   * than a full whole-project walk. Always fires together with `on_analysis_build` (an
   * incremental build IS a build), never instead of it. Same non-production, non-wire-
   * protocol status as `on_analysis_build`/`on_analysis_cache_load` -- see
   * `worker-thread.ts`'s doc comment for why all three are excluded from the fields that
   * cross the thread boundary via `workerData` (functions cannot survive structured
   * clone, so a thread-based transport never supports this hook either -- only the
   * in-process transport (`createJavascriptTypescriptWorker` called directly, or via
   * `URDIRA_ANALYSIS_THREAD=0`) can observe it).
   */
  readonly on_analysis_incremental?: (rewalked: readonly string[]) => void;
  /** Test-only count of checker owner walks; a stage-three spool hit does not fire it. */
  readonly on_rust_semantic_owner_analyze?: (ownerPath: string) => void;
  /** Test-only count of bounded checker lookup-group preparation passes. */
  readonly on_rust_semantic_group_prepare?: (ownerPaths: readonly string[]) => void;
}

interface AnalysisCacheEntry {
  readonly key: string;
  readonly analysis: JsTsAnalysisResult;
  /**
   * Content hash of every file this entry was actually built from (not just
   * `root_names`), keyed by path. Backs the subset-reuse contract in
   * {@link isSubsetOfCache}, below.
   */
  readonly file_hashes: ReadonlyMap<string, string>;
  readonly compiler_options_digest: string;
  /**
   * `JsTsSessionAnalyzeResult.impactful_changed_paths` captured from whatever
   * call actually produced `analysis` (`undefined` for a durable-cache load
   * or a full build -- see `loadOrBuildAnalysis`'s doc comment). A cache HIT
   * (exact key match or {@link isSubsetOfCache}) reuses this stored value
   * rather than recomputing anything: an identical-content request has no
   * new changes to report, so whatever this entry's own build call decided
   * is still correct for it.
   */
  readonly impactful_changed_paths?: readonly string[];
}

/**
 * Phase 5.1's worker subset-reuse contract: a request whose `files` is an
 * exact (path, content_hash) subset of the CURRENTLY cached analysis's own
 * file set (built under the same compiler options) can safely reuse that
 * cached analysis wholesale, instead of rebuilding from just the narrower
 * set of files this particular request happened to carry -- which would
 * silently lose cross-file resolution for everything outside the subset.
 * This is what lets a full-workspace scan send ONE full-corpus request (the
 * `analyze_closure` call, or any full `analyze_artifact`/`discover_partitions`
 * call) to build and cache the whole-project analysis once, then send
 * narrowed per-owner `files` payloads for every subsequent `analyze_artifact`
 * call without forcing a rebuild per owner.
 *
 * Deliberately conservative: an empty `files` array never matches (nothing
 * to check), a differing `compiler_options_digest` never matches, and ANY
 * missing path or changed content hash falls through to a full rebuild
 * using exactly the files the request provided -- never a partial reuse,
 * never a guess.
 */
const FILE_HASH_MEMO_MAX_ENTRIES = 512;
const FILE_HASH_MEMO_MAX_TEXT_BYTES = 16 * 1024 * 1024;

/** Bounded LRU-ish source hash memo; it must not retain an entire workspace. */
class FileHashMemo {
  private readonly entries = new Map<string, { text: string; hash: string }>();
  private textBytes = 0;

  get(path: string): { text: string; hash: string } | undefined {
    const entry = this.entries.get(path);
    if (entry !== undefined) {
      this.entries.delete(path);
      this.entries.set(path, entry);
    }
    return entry;
  }

  set(path: string, entry: { text: string; hash: string }): void {
    const previous = this.entries.get(path);
    if (previous !== undefined) this.textBytes -= Buffer.byteLength(previous.text, "utf8");
    this.entries.delete(path);
    this.entries.set(path, entry);
    this.textBytes += Buffer.byteLength(entry.text, "utf8");
    while (this.entries.size > FILE_HASH_MEMO_MAX_ENTRIES || this.textBytes > FILE_HASH_MEMO_MAX_TEXT_BYTES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (evicted !== undefined) this.textBytes -= Buffer.byteLength(evicted.text, "utf8");
    }
  }

  clear(): void {
    this.entries.clear();
    this.textBytes = 0;
  }
}

function isSubsetOfCache(files: readonly AnalyzerFile[], compilerOptionsDigest: string, cache: AnalysisCacheEntry, memo: FileHashMemo): boolean {
  if (files.length === 0 || cache.compiler_options_digest !== compilerOptionsDigest) return false;
  return files.every((file) => cache.file_hashes.get(file.path) === fileContentHash(file, memo));
}

/**
 * Derive a content-based cache key from analyzeProject's effective inputs: the source
 * files that actually feed the program (those named by root_names), root_names itself,
 * and compiler_options. Object/array identity is irrelevant here on purpose - callers
 * (e.g. a full-workspace scan invoking the worker once per owner artifact) commonly pass
 * a fresh array/object reference carrying the same logical content on every call.
 *
 * The key hashes per-file content hashes, never the concatenated file texts: a scan
 * invokes the worker once per owner artifact, so hashing the full corpus here would be
 * O(corpus x owners) per scan.
 */
function analysisCacheKey(files: readonly AnalyzerFile[], rootNames: readonly string[], compilerOptions: Readonly<Record<string, unknown>> | undefined, fileHashMemo: FileHashMemo): string {
  const sortedRootNames = [...rootNames].sort();
  const rootNameSet = new Set(sortedRootNames);
  const relevantFiles = files
    .filter((file) => rootNameSet.has(file.path))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => ({ path: file.path, content_hash: fileContentHash(file, fileHashMemo) }));
  return canonicalSha256({ root_names: sortedRootNames, file_hashes: relevantFiles, compiler_options: compilerOptions ?? null });
}

function fileContentHash(file: AnalyzerFile, memo: FileHashMemo): string {
  if (file.content_hash !== undefined) return file.content_hash;
  const cached = memo.get(file.path);
  if (cached !== undefined && cached.text === file.text) return cached.hash;
  const hash = `sha256:${createHash("sha256").update(file.text).digest("hex")}`;
  memo.set(file.path, { text: file.text, hash });
  return hash;
}

/**
 * Extends the in-memory `analysisCacheKey` with everything that must ALSO agree
 * across a process boundary before a durable, on-disk entry is safe to trust:
 * the pinned TypeScript compiler build (`typescript_compiler_version`) and this
 * package's own build (`plugin_version`), since analyzeProject's output is only
 * deterministic for a FIXED compiler + analyzer build, not across an upgrade of
 * either; and the caller-supplied `analysis_digest`/`analysis_configuration_digest`
 * (mirroring what the in-memory cache already leaves out of its own key, since
 * those two only ever affect `buildJavascriptTypescriptFactDelta`'s bookkeeping
 * fields, never `analyzeProject`'s output) -- included here anyway so that a
 * fact-delta-affecting configuration change still mints a disjoint durable entry
 * rather than silently sharing one keyed purely on file content. A TypeScript
 * upgrade or an analyzer rebuild therefore always misses every entry an OLDER
 * build wrote, rather than risking a stale or subtly-incompatible analysis being
 * loaded and trusted as fresh. `canonicalSha256` returns `sha256:<hex>`; only the
 * hex half is used, so the cache filename stem is a plain hex string.
 */
export function durableAnalysisCacheKey(cacheKey: string, descriptor: JavascriptTypescriptWorkerDescriptor, stage = "monolithic"): string {
  const digest = canonicalSha256({
    format_version: stage === "monolithic" ? 1 : 3,
    stage,
    cache_key: cacheKey,
    typescript_compiler_version: TYPESCRIPT_COMPILER_VERSION,
    plugin_version: JAVASCRIPT_TYPESCRIPT_VERSION,
    analysis_digest: descriptor.analysis_digest ?? null,
    analysis_configuration_digest: descriptor.analysis_configuration_digest ?? null,
    runtime_executable_binding_digest: descriptor.runtime_executable_binding_digest ?? null,
  });
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
}

function durableAnalysisCachePath(dir: string, durableKey: string): string {
  return join(dir, `${durableKey}.json.gz`);
}

/**
 * Minimal shape check for a durable entry's `analysis` field -- deliberately
 * loose (it does not validate every entity/relation/diagnostic field, just
 * that the top-level arrays/object/scalars a caller of `analysis` immediately
 * destructures are actually present with the right JS type). This is a
 * corruption/format-drift guard, not a schema validator: anything that fails
 * it is treated exactly like a missing or unreadable file, below -- silently
 * discarded in favor of a real rebuild, never surfaced as an error.
 */
function isValidDurableAnalysis(value: unknown): value is JsTsAnalysisResult {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate["entities"]) && Array.isArray(candidate["relations"]) && Array.isArray(candidate["diagnostics"])
    && candidate["dependency_closures"] !== null && typeof candidate["dependency_closures"] === "object" && !Array.isArray(candidate["dependency_closures"])
    && typeof candidate["language"] === "string" && typeof candidate["complete"] === "boolean";
}

/** Minimal checker projection consumed by structural stage 3. Stage 2 has
 * already published references/calls/inheritance, so retaining those rows in
 * the inter-stage spool would duplicate hundreds of megabytes of data that can
 * never pass stage 3's closed record-kind filter. */
function stageThreeSemanticProjection(analysis: JsTsAnalysisResult, ownerPath: string): JsTsAnalysisResult {
  const relations = analysis.relations.filter((relation) => relation.path === ownerPath && relation.kind === "core:covers");
  const targetIds = new Set(relations.flatMap((relation) => relation.target_id === undefined ? [] : [relation.target_id]));
  const entities = analysis.entities.filter((entity) => (entity.path === ownerPath && entity.type !== undefined) || targetIds.has(entity.id));
  const diagnostics = analysis.diagnostics.filter((diagnostic) => diagnostic.path === ownerPath);
  return {
    language: analysis.language,
    entities,
    relations,
    diagnostics,
    complete: diagnostics.length === 0,
    dependency_closures: {},
  };
}

/**
 * Rust-authoritative owner analyses retain only the owner declaration surface
 * plus entities referenced by that owner's checker relations. The projection
 * needs artifact bindings only for those retained target paths; carrying the
 * complete workspace file manifest through every owner request needlessly
 * serializes the same 500+ entries hundreds of times.
 */
function filesForRustSemanticOwner(
  files: readonly AnalyzerFile[],
  analysis: JsTsAnalysisResult,
  ownerPath: string,
  preparedFiles?: ReadonlyMap<string, AnalyzerFile>,
): readonly AnalyzerFile[] {
  const paths = new Set<string>([ownerPath]);
  for (const entity of analysis.entities) paths.add(entity.path);
  for (const relation of analysis.relations) paths.add(relation.path);
  for (const diagnostic of analysis.diagnostics) paths.add(diagnostic.path);
  // The Rust request already carries the closure's metadata in canonical
  // order. Selecting directly avoids constructing a new Map from every
  // closure for every owner. Prepared metadata is consulted only for target
  // declarations that the bounded owner request intentionally omitted.
  const selected: AnalyzerFile[] = [];
  const selectedPaths = new Set<string>();
  for (const file of files) {
    if (!paths.has(file.path)) continue;
    selected.push(file);
    selectedPaths.add(file.path);
  }
  if (preparedFiles !== undefined && selectedPaths.size !== paths.size) {
    for (const path of paths) {
      if (selectedPaths.has(path)) continue;
      const prepared = preparedFiles.get(path);
      if (prepared !== undefined) {
        selected.push(prepared);
        selectedPaths.add(path);
      }
    }
  }
  return selected;
}

/**
 * Reads and validates one durable cache entry. Every failure mode -- the file
 * doesn't exist, gunzip chokes on truncated/non-gzip bytes, JSON.parse throws,
 * the stored `format_version`/`durable_key` don't match what THIS worker just
 * computed, or `analysis` fails `isValidDurableAnalysis` -- is handled
 * identically: best-effort unlink the file (it's not trustworthy; do not let a
 * bad entry linger to fool a later reader) and return `undefined` so the
 * caller falls through to a real `analyzeProject` build. The durable cache
 * must never be able to fail a scan; every fs/zlib/parse error here is
 * swallowed, not rethrown.
 */
async function readDurableAnalysisCache(dir: string, durableKey: string, formatVersion = 1): Promise<JsTsAnalysisResult | undefined> {
  const filePath = durableAnalysisCachePath(dir, durableKey);
  try {
    const compressed = await readFile(filePath);
    const raw = await gunzip(compressed);
    const parsed = JSON.parse(raw.toString("utf8")) as { format_version?: unknown; durable_key?: unknown; analysis?: unknown };
    if (parsed.format_version !== formatVersion || parsed.durable_key !== durableKey || !isValidDurableAnalysis(parsed.analysis)) throw new Error("Durable analysis cache entry failed validation.");
    return parsed.analysis;
  } catch {
    await unlink(filePath).catch(() => undefined);
    return undefined;
  }
}

/**
 * Writes one durable cache entry and prunes the directory back under the cap.
 * Gzip level 1 (fastest, not the node default level 6): this write is awaited
 * INSIDE `invoke`, on the return path of every real analysis build, because
 * `thread-transport.ts`'s `terminate()` hard-kills the worker thread
 * (`worker.terminate()`, never the in-thread worker's own graceful
 * `terminate`) the moment a scan's `finally` block runs -- a fire-and-forget
 * write here would race that hard kill and could be truncated mid-write. A
 * ~40MB JSON payload gzips several times faster at level 1 than the default
 * while still landing around 5x smaller than raw, which keeps that awaited
 * cost small relative to the whole-project analysis it is caching.
 *
 * The write itself goes to a per-write-unique temp file in the SAME directory,
 * then an atomic rename over the final name -- never a direct write to the
 * final path. This is what makes `readDurableAnalysisCache` safe to run
 * concurrently with a writer: a reader either sees the old complete file, the
 * new complete file, or (between two racing writers of the identical durable
 * key, since the key is pure content) a complete file either writer produced
 * -- never a partially-written one. Concurrent writers of the SAME key always
 * produce byte-identical content (the key is a pure function of the analysis
 * inputs), so last-rename-wins between them is harmless.
 */
async function writeDurableAnalysisCache(dir: string, durableKey: string, analysis: JsTsAnalysisResult, maxEntries: number, formatVersion = 1): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    const compressed = await gzip(Buffer.from(JSON.stringify({ format_version: formatVersion, durable_key: durableKey, analysis })), { level: 1 });
    const finalPath = durableAnalysisCachePath(dir, durableKey);
    const tempPath = join(dir, `${durableKey}.json.gz.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
    await writeFile(tempPath, compressed);
    await rename(tempPath, finalPath);
    await pruneDurableAnalysisCache(dir, maxEntries);
  } catch {
    /* The durable cache is a pure speedup; a write failure must never fail the scan that triggered it. */
  }
}

/** Best-effort: evict oldest-mtime `*.json.gz` entries beyond `maxEntries`. Never throws. */
async function pruneDurableAnalysisCache(dir: string, maxEntries: number): Promise<void> {
  try {
    const names = (await readdir(dir)).filter((name) => name.endsWith(".json.gz"));
    if (names.length <= maxEntries) return;
    const withMtime = await Promise.all(names.map(async (name) => ({ name, mtimeMs: (await stat(join(dir, name))).mtimeMs })));
    withMtime.sort((left, right) => left.mtimeMs - right.mtimeMs);
    await Promise.all(withMtime.slice(0, withMtime.length - maxEntries).map((entry) => unlink(join(dir, entry.name)).catch(() => undefined)));
  } catch {
    /* Prune is a housekeeping nicety; a failure here must never fail the write that triggered it. */
  }
}

/**
 * Resolves the analysis for a cache miss on the in-memory cache: consults the
 * durable, on-disk cache first (when `analysis_cache_dir` is configured), and
 * only runs a real build -- via this worker's own long-lived `JsTsAnalysisSession`
 * -- when that also misses. A durable hit is installed into the in-memory cache
 * by the caller exactly like a fresh build would be (see `invoke`, below) --
 * from the rest of the worker's perspective a durable hit and a fresh build are
 * indistinguishable except for which instrumentation hook fires:
 * `on_analysis_cache_load` for a durable hit (which also seeds the session's
 * per-file memo from the loaded analysis, so a LATER content-only edit can
 * still take the incremental path against a durably-cached corpus), or
 * `on_analysis_build` (plus `on_analysis_incremental` when the session's own
 * `analyze` decided a re-walk of a strict subset of root files was sound --
 * see `JsTsAnalysisSession` in `analyzer.ts`) for a real build. Only a real
 * build is followed by a durable WRITE -- a durable hit never rewrites the
 * entry it just read.
 *
 * `impactful_changed_paths` on the returned shape mirrors
 * `JsTsSessionAnalyzeResult.impactful_changed_paths` (`undefined` for a
 * durable-cache hit or a full build; an array, possibly empty, for a real
 * incremental build) -- see that field's doc comment in `analyzer.ts`.
 */
async function loadOrBuildAnalysis(descriptor: JavascriptTypescriptWorkerDescriptor, session: JsTsAnalysisSession, files: readonly AnalyzerFile[], rootNames: readonly string[], compilerOptions: Readonly<Record<string, unknown>> | undefined, cacheKey: string, rustScope?: JsTsRustSemanticScope): Promise<{ readonly analysis: JsTsAnalysisResult; readonly impactful_changed_paths?: readonly string[] }> {
  const cacheDir = descriptor.analysis_cache_dir;
  const durableKey = cacheDir === undefined ? undefined : durableAnalysisCacheKey(cacheKey, descriptor);
  if (cacheDir !== undefined && durableKey !== undefined) {
    const durableHit = await readDurableAnalysisCache(cacheDir, durableKey);
    if (durableHit !== undefined) {
      descriptor.on_analysis_cache_load?.();
      session.seedFromAnalysis(durableHit, files, compilerOptions);
      return { analysis: durableHit };
    }
  }
  descriptor.on_analysis_build?.();
  const sessionResult = session.analyze({ files, root_names: rootNames, ...(compilerOptions === undefined ? {} : { compiler_options: compilerOptions }), ...(rustScope === undefined ? {} : { rust_semantic_scope: rustScope }) });
  if (sessionResult.build === "incremental") descriptor.on_analysis_incremental?.(sessionResult.rewalked);
  const analysis = sessionResult.result;
  if (cacheDir !== undefined && durableKey !== undefined) await writeDurableAnalysisCache(cacheDir, durableKey, analysis, descriptor.analysis_cache_max_entries ?? 16);
  return { analysis, ...(sessionResult.impactful_changed_paths === undefined ? {} : { impactful_changed_paths: sessionResult.impactful_changed_paths }) };
}

export interface JavascriptTypescriptWorkerTransport extends WorkerTransport {
  invokeFactDeltaStream(request: PluginWorkerRequestEnvelope): Promise<FactDeltaStream>;
  invokeFactDeltaStreamGroup(requests: readonly PluginWorkerRequestEnvelope[]): Promise<readonly FactDeltaStream[]>;
  invokeRustSemanticObservationGroup(requests: readonly PluginWorkerRequestEnvelope[]): Promise<readonly RustSemanticObservationOwner[]>;
}

// Each canonical owner batch retains the closed 4 MiB row envelope. The Rust
// core's 16 MiB physical bound applies to the aggregate group, not an
// individual canonical batch; keeping this limit also preserves the native
// batch contract while groups remain bounded independently.
const RUST_SEMANTIC_OBSERVATION_MAX_BYTES = FACT_DELTA_STREAM_MAX_BYTES;

/** Compact owner observations used only by the Rust composition worker. The
 * ordinary FactDeltaStream transport remains available as a test oracle and
 * compatibility boundary, but structural rows are never framed into streams
 * on this production path. */
export interface RustSemanticObservationOwner {
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly owner_path: string;
  /** Diagnostic proposal keys are carried from the projected headers so Rust
   * can reproduce the FactDelta commitment without reparsing canonical row
   * JSON in its ingest path. */
  readonly diagnostic_proposal_keys: readonly string[];
  readonly batches: readonly {
    readonly sequence: number;
    readonly final_batch: boolean;
    readonly canonical_records: readonly string[];
    readonly canonical_dependencies: readonly string[];
    readonly byte_length: 0;
    readonly owner_digest: string;
    readonly fact_delta_id: string;
    readonly delta_digest: string;
    readonly diagnostic_codes: readonly string[];
  }[];
  readonly next_cursor?: number;
}

/**
 * Converts a prepared giant-owner stream to the compact observation shape
 * without sealing it. Sealing would rebuild the legacy FactDelta header and
 * whole-owner digest in TypeScript before Rust owns those values.
 */
/* c8 ignore start -- giant-owner fallback is exercised by the Rust preflight corpus. */
function rustOwnedPreparedObservation(
  prepared: PreparedJavascriptTypescriptFactDeltaStream,
  input: JavascriptTypescriptFactDeltaInput,
): RustSemanticObservationOwner {
  const records = prepared.records.map(factDeltaStreamCanonicalRow);
  const dependencies = prepared.dependencies.map(factDeltaStreamCanonicalRow);
  const diagnosticCodes = input.analysis.diagnostics
    .filter((diagnostic) => diagnostic.path === input.owner_path)
    .map((diagnostic) => diagnostic.code);
  const diagnosticProposalKeys = prepared.records
    .filter((record) => record.category === "diagnostic")
    .map((record) => record.proposal_record_key);
  const batches: Array<RustSemanticObservationOwner["batches"][number]> = [];
  let recordStart = 0;
  let dependencyStart = 0;
  let sequence = 0;
  while (recordStart < records.length || dependencyStart < dependencies.length || sequence === 0) {
    const batchRecords: string[] = [];
    const batchDependencies: string[] = [];
    let bytes = 0;
    while (recordStart < records.length
      && batchRecords.length + batchDependencies.length < FACT_DELTA_STREAM_MAX_ROWS
      && bytes + records[recordStart]!.length <= RUST_SEMANTIC_OBSERVATION_MAX_BYTES) {
      const row = records[recordStart++]!;
      batchRecords.push(row);
      bytes += row.length;
    }
    while (dependencyStart < dependencies.length
      && batchRecords.length + batchDependencies.length < FACT_DELTA_STREAM_MAX_ROWS
      && bytes + dependencies[dependencyStart]!.length <= RUST_SEMANTIC_OBSERVATION_MAX_BYTES) {
      const row = dependencies[dependencyStart++]!;
      batchDependencies.push(row);
      bytes += row.length;
    }
    if (batchRecords.length === 0 && batchDependencies.length === 0 && sequence !== 0) {
      const pending = Math.max(records[recordStart]?.length ?? 0, dependencies[dependencyStart]?.length ?? 0);
      throw new Error(`Prepared Rust semantic observation row exceeds its physical batch budget (owner=${input.owner_path ?? "?"}, bytes=${pending}, limit=${RUST_SEMANTIC_OBSERVATION_MAX_BYTES}).`);
    }
    batches.push({
      sequence,
      final_batch: recordStart === records.length && dependencyStart === dependencies.length,
      canonical_records: batchRecords,
      canonical_dependencies: batchDependencies,
      byte_length: 0,
      owner_digest: "",
      fact_delta_id: "",
      delta_digest: "",
      diagnostic_codes: diagnosticCodes,
    });
    sequence += 1;
  }
  return {
    owner_artifact_id: String(input.work_item["artifact_id"]),
    owner_artifact_version_id: String(input.work_item["target_artifact_version_id"]),
    owner_path: input.owner_path!,
    diagnostic_proposal_keys: diagnosticProposalKeys,
    batches,
  };
}
/* c8 ignore stop */

export function createJavascriptTypescriptWorker(descriptor: JavascriptTypescriptWorkerDescriptor = {}): JavascriptTypescriptWorkerTransport {
  let terminated = false;
  let analysisCache: AnalysisCacheEntry | undefined;
  let stage1AnalysisCache: AnalysisCacheEntry | undefined;
  let rustSemanticPreparedFileHashes: ReadonlyMap<string, string> | undefined;
  // Compact metadata for the one prepared Rust-authoritative project. Owner
  // requests carry only the owner entry; reusing this map avoids serializing
  // the full corpus once per owner group while still giving fact projection
  // the artifact bindings for checker-discovered target entities.
  let rustSemanticPreparedFiles: ReadonlyMap<string, AnalyzerFile> | undefined;
  let rustSemanticPreparedScope: JsTsRustSemanticScope | undefined;
  let rustSemanticSpoolHandle: FileHandle | undefined;
  let rustSemanticSpoolPath: string | undefined;
  let rustSemanticSpoolGeneration: string | undefined;
  let rustSemanticSpoolBytes = 0;
  const rustSemanticSpoolIndex = new Map<string, { readonly offset: number; readonly length: number }>();
  const fileHashMemo = new FileHashMemo();
  const closeRustSemanticSpool = async (): Promise<void> => {
    const handle = rustSemanticSpoolHandle;
    const path = rustSemanticSpoolPath;
    rustSemanticSpoolHandle = undefined;
    rustSemanticSpoolPath = undefined;
    rustSemanticSpoolGeneration = undefined;
    rustSemanticSpoolBytes = 0;
    rustSemanticSpoolIndex.clear();
    await handle?.close().catch(() => undefined);
    if (path !== undefined) await unlink(path).catch(() => undefined);
  };
  const prepareRustSemanticSpool = async (generation: string, create: boolean): Promise<void> => {
    if (rustSemanticSpoolGeneration === generation && rustSemanticSpoolHandle !== undefined) return;
    await closeRustSemanticSpool();
    if (!create || descriptor.analysis_cache_dir === undefined) return;
    await mkdir(descriptor.analysis_cache_dir, { recursive: true });
    const path = join(descriptor.analysis_cache_dir, `rust-semantic-${process.pid}-${randomBytes(8).toString("hex")}.spool`);
    rustSemanticSpoolHandle = await open(path, "w+");
    rustSemanticSpoolPath = path;
    rustSemanticSpoolGeneration = generation;
  };
  const rustSemanticSpoolKey = (ownerPath: string): string | undefined => rustSemanticSpoolGeneration === undefined ? undefined : `${rustSemanticSpoolGeneration}\0${ownerPath}`;
  const hasRustSemanticSpoolEntry = (ownerPath: string): boolean => {
    const key = rustSemanticSpoolKey(ownerPath);
    return rustSemanticSpoolHandle !== undefined && key !== undefined && rustSemanticSpoolIndex.has(key);
  };
  const writeRustSemanticSpool = async (ownerPath: string, analysis: JsTsAnalysisResult): Promise<void> => {
    const handle = rustSemanticSpoolHandle;
    const key = rustSemanticSpoolKey(ownerPath);
    if (handle === undefined || key === undefined) return;
    const bytes = serialize({ format_version: 1, key, analysis });
    const offset = rustSemanticSpoolBytes;
    const result = await handle.write(bytes, 0, bytes.byteLength, offset);
    if (result.bytesWritten !== bytes.byteLength) throw new Error("Rust-authoritative semantic spool write was incomplete.");
    rustSemanticSpoolIndex.set(key, { offset, length: bytes.byteLength });
    rustSemanticSpoolBytes += bytes.byteLength;
  };
  const readRustSemanticSpool = async (ownerPath: string): Promise<JsTsAnalysisResult | undefined> => {
    const handle = rustSemanticSpoolHandle;
    const key = rustSemanticSpoolKey(ownerPath);
    const entry = key === undefined ? undefined : rustSemanticSpoolIndex.get(key);
    if (handle === undefined || key === undefined || entry === undefined) return undefined;
    const bytes = Buffer.allocUnsafe(entry.length);
    const result = await handle.read(bytes, 0, entry.length, entry.offset);
    if (result.bytesRead !== entry.length) throw new Error("Rust-authoritative semantic spool read was incomplete.");
    const decoded = deserialize(bytes) as { readonly format_version?: unknown; readonly key?: unknown; readonly analysis?: unknown };
    if (decoded.format_version !== 1 || decoded.key !== key || !isValidDurableAnalysis(decoded.analysis)) throw new Error("Rust-authoritative semantic spool entry failed validation.");
    return decoded.analysis;
  };
  // One incremental analysis session per worker instance: a per-scan worker
  // (today's default) only ever calls `session.analyze` at most once per
  // scan (see `loadOrBuildAnalysis`'s doc comment), so this session behaves
  // exactly like today's stateless `analyzeProject` call for a single scan.
  // A POOLED, multi-scan worker (`apps/urdira/src/index.ts`'s worker pool)
  // is what actually unlocks the incremental win: the session's per-file
  // memo survives across scans of the same workspace, so a content-only
  // edit between two scans re-walks only the affected files instead of the
  // whole project.
  const session = new JsTsAnalysisSession();
  const invoke = async (request: PluginWorkerRequestEnvelope, directStream: boolean | "prepared" | "projection_input"): Promise<unknown> => {
      if (terminated) throw new Error("JavaScript/TypeScript worker is terminated.");
      if (request.call === "describe") return response(request, {
        plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
        plugin_version: JAVASCRIPT_TYPESCRIPT_VERSION,
        compiler_version: TYPESCRIPT_COMPILER_VERSION,
        ...(descriptor.compatibility_declaration_digest === undefined ? {} : { compatibility_declaration_digest: descriptor.compatibility_declaration_digest }),
        ...(descriptor.registry_contribution_digest === undefined ? {} : { registry_contribution_digest: descriptor.registry_contribution_digest }),
        supported_calls: ["describe", "discover_partitions", "analyze_artifact", "analyze_closure", "generate_projection"],
        supported_contracts: JAVASCRIPT_TYPESCRIPT_CAPABILITIES,
      });
      const rawPayload = request.payload as Record<string, unknown>;
      const preliminaryRootNames = Array.isArray(rawPayload["root_names"]) && rawPayload["root_names"].every((value) => typeof value === "string")
        ? rawPayload["root_names"] as string[] : [];
      const preliminaryStage = typeof rawPayload["publication_stage_id"] === "string" ? rawPayload["publication_stage_id"] : undefined;
      const hasRustSemanticScope = rawPayload["rust_semantic_scope"] !== undefined || rawPayload["rust_semantic_scope_ref"] !== undefined;
      if (preliminaryStage === "jsts:structural_stage_1" && descriptor.runtime_executable_binding_digest !== undefined) {
        throw new Error("Exclusive-work violation: a native-bound JavaScript/TypeScript plugin cannot execute structural stage 1 in TypeScript.");
      }
      if (descriptor.runtime_executable_binding_digest !== undefined
        && (preliminaryStage === "jsts:structural_stage_2" || preliminaryStage === "jsts:structural_stage_3")
        && (request.call === "analyze_closure" || request.call === "analyze_artifact")
        && !hasRustSemanticScope) {
        throw new Error("Exclusive-work violation: native-bound TypeScript semantic work requires the Rust-authoritative affected scope.");
      }
      // The large-corpus closure path only needs the direct import graph.  Its
      // cache key can be derived from immutable artifact digests before any
      // CAS bytes are decoded, so a repeated full reindex can skip both the
      // multi-gigabyte source hydration and the graph scan.  Small requests,
      // inline text payloads, and non-stage-1 calls retain the existing path.
      if (request.call === "analyze_closure" && preliminaryStage === "jsts:structural_stage_1" && descriptor.analysis_cache_dir !== undefined) {
        const entries = Array.isArray(rawPayload["files"]) ? rawPayload["files"] : [];
        const sourceEntries = entries.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object" && !Array.isArray(entry));
        const rootSet = new Set(preliminaryRootNames);
        const sourceCount = sourceEntries.filter((entry) => typeof entry["path"] === "string" && (rootSet.size === 0 || rootSet.has(entry["path"] as string))).length;
        const totalBytes = sourceEntries.reduce((total, entry) => {
          if (rootSet.size !== 0 && typeof entry["path"] === "string" && !rootSet.has(entry["path"])) return total;
          return total + (typeof entry["byte_length"] === "number" ? entry["byte_length"] : 0);
        }, 0);
        const graphKey = largeSyntaxManifestKey(request.payload, preliminaryRootNames, descriptor);
        if ((sourceCount >= LARGE_SYNTAX_CORPUS_FILE_THRESHOLD || totalBytes >= LARGE_SYNTAX_CORPUS_BYTE_THRESHOLD) && graphKey !== undefined) {
          const cachedGraph = await readSyntaxDependencyGraphCache(descriptor.analysis_cache_dir, graphKey);
          if (cachedGraph !== undefined) {
            descriptor.on_analysis_cache_load?.();
            return response(request, { plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, dependency_graph: cachedGraph });
          }
        }
      }
      const preparedFiles = descriptor.runtime_executable_binding_digest !== undefined
        && (preliminaryStage === "jsts:structural_stage_2" || preliminaryStage === "jsts:structural_stage_3")
        && (request.call === "analyze_closure" || request.call === "analyze_artifact")
        && hasRustSemanticScope
        && rustSemanticPreparedFileHashes !== undefined
        ? filesFromPreparedPayload(request.payload, rustSemanticPreparedFileHashes)
        : undefined;
      const files = preparedFiles ?? await filesFromPayload(request.payload, descriptor.cas_root, {
        ...(descriptor.source_load_concurrency === undefined ? {} : { load_concurrency: descriptor.source_load_concurrency }),
        ...(descriptor.source_load_max_in_flight_bytes === undefined ? {} : { max_in_flight_bytes: descriptor.source_load_max_in_flight_bytes }),
      });
      if (request.call === "discover_partitions") return response(request, { partitions: discoverProjects(files), plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID });
      const rootNames = Array.isArray(rawPayload["root_names"]) && rawPayload["root_names"].every((value) => typeof value === "string")
        ? rawPayload["root_names"] as string[] : files.map((file) => file.path);
      const compilerOptions = rawPayload["compiler_options"] !== null && typeof rawPayload["compiler_options"] === "object" && !Array.isArray(rawPayload["compiler_options"])
        ? rawPayload["compiler_options"] as Record<string, unknown> : undefined;
      const rustSemanticScope = rustSemanticScopeFromPayload(rawPayload, rootNames, rustSemanticPreparedScope);
      const publicationStageId = typeof rawPayload["publication_stage_id"] === "string" ? rawPayload["publication_stage_id"] : undefined;
      if (request.call === "analyze_closure" && rustSemanticScope !== undefined) {
        rustSemanticPreparedScope = rustSemanticScope;
        const build = session.prepareRustSemanticState({
          files,
          root_names: rootNames,
          ...(compilerOptions === undefined ? {} : { compiler_options: compilerOptions }),
          rust_semantic_scope: rustSemanticScope,
        });
        rustSemanticPreparedFileHashes = new Map(files.map((file) => [file.path, file.content_hash ?? fileContentHash(file, fileHashMemo)]));
        rustSemanticPreparedFiles = new Map(files.map((file) => [file.path, {
          ...file,
          // Source text is already owned by the prepared TypeScript snapshot;
          // retain only bindings/hashes for later owner projections.
          text: "",
        }]));
        const semanticGeneration = canonicalSha256({
          files: [...rustSemanticPreparedFileHashes].sort(([left], [right]) => left.localeCompare(right)),
          compiler_options: compilerOptions ?? null,
          analyzer: JAVASCRIPT_TYPESCRIPT_VERSION,
        });
        if (publicationStageId === "jsts:structural_stage_2") await prepareRustSemanticSpool(semanticGeneration, true);
        else if (publicationStageId === "jsts:structural_stage_3" && rustSemanticSpoolGeneration !== semanticGeneration) await closeRustSemanticSpool();
        if (build === "full") descriptor.on_analysis_build?.();
        else descriptor.on_analysis_incremental?.(rustSemanticScope.affected_paths);
        // Rust already returned the exact dependency graph and affected set.
        // This call owns only TypeScript program preparation and intentionally
        // creates no JsTsAnalysisResult, structural facts, or closure arrays.
        return response(request, {
          plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
          semantic_state_prepared: true,
          dependency_authority: "urdira:jsts-syntax-worker",
        });
      }
      if (request.call === "analyze_closure" && publicationStageId === "jsts:structural_stage_1" && isLargeSyntaxCorpus({ files, root_names: rootNames })) {
        // A project-sized stage-1 analysis used to remain reachable through
        // `stage1AnalysisCache` for every owner request.  On VS Code that was
        // already near the RSS guard before the first hundred owners.  The
        // closure call only needs the direct graph; owner facts are built from
        // bounded views below and this response deliberately warms no cache.
        descriptor.on_analysis_build?.();
        const dependencyGraph = analyzeSyntaxDependencyGraph({ files, root_names: rootNames });
        const graphKey = largeSyntaxManifestKey(request.payload, rootNames, descriptor);
        if (descriptor.analysis_cache_dir !== undefined && graphKey !== undefined) await writeSyntaxDependencyGraphCache(descriptor.analysis_cache_dir, graphKey, dependencyGraph);
        return response(request, {
          plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
          dependency_graph: dependencyGraph,
        });
      }
      const compilerOptionsDigest = canonicalSha256(compilerOptions ?? null);
      const cacheKey = `${analysisCacheKey(files, rootNames, compilerOptions, fileHashMemo)}${rustSemanticScope === undefined ? "" : ":rust-semantic-v1"}`;
      let analysis: JsTsAnalysisResult;
      let impactfulChangedPaths: readonly string[] | undefined;
      // A pooled worker has already created the checker-backed TypeScript API
      // while publishing stages 2/3. On a later edit, stage 1 must not create
      // a second SyncRpcChannel in that same worker: TypeScript's sync API can
      // fail with `spawn EBADF` when two child channels overlap. Stage 1 only
      // needs declarations and direct imports, so use its bounded scanner for
      // every post-initial stage-1 request and leave the live checker API for
      // the checker-backed later stages.
      const boundedSyntax = rawPayload["bounded_syntax"] === true || (publicationStageId === "jsts:structural_stage_1" && stage1AnalysisCache !== undefined);
      if (publicationStageId !== "jsts:structural_stage_1") stage1AnalysisCache = undefined;
      if (rustSemanticScope !== undefined) {
        if (request.call !== "analyze_artifact") throw new Error("Rust-authoritative semantic state is limited to analyze_closure and analyze_artifact.");
        const ownerPath = typeof rawPayload["owner_path"] === "string" ? rawPayload["owner_path"] : undefined;
        if (ownerPath === undefined) throw new Error("Rust-authoritative semantic analysis requires owner_path.");
        const spooled = publicationStageId === "jsts:structural_stage_3" ? await readRustSemanticSpool(ownerPath) : undefined;
        if (spooled !== undefined) analysis = spooled;
        else {
          descriptor.on_rust_semantic_owner_analyze?.(ownerPath);
          const stageRecordKinds = rawPayload["stage_record_kinds"];
          const includeInferredTypes = preliminaryStage === "jsts:structural_stage_2"
            || (Array.isArray(stageRecordKinds) && stageRecordKinds.includes("jsts:entity_inferred_type"));
          const pendingSites = pendingSitesFromPayload(rawPayload);
          analysis = session.analyzeRustSemanticOwner({ files, owner_path: ownerPath, include_inferred_types: includeInferredTypes, ...(pendingSites === undefined ? {} : { pending_sites: pendingSites }) });
          if (publicationStageId === "jsts:structural_stage_2") await writeRustSemanticSpool(ownerPath, stageThreeSemanticProjection(analysis, ownerPath));
        }
      } else if (publicationStageId === "jsts:structural_stage_1") {
        const cachedSyntax = stage1AnalysisCache?.key === cacheKey
          ? stage1AnalysisCache
          : stage1AnalysisCache !== undefined && isSubsetOfCache(files, compilerOptionsDigest, stage1AnalysisCache, fileHashMemo)
            ? stage1AnalysisCache : undefined;
        if (cachedSyntax !== undefined) {
          analysis = cachedSyntax.analysis;
        } else {
          // Per-owner bounded views are intentionally not written to the
          // durable cache: a first scan can contain tens of thousands of
          // distinct owners, and serializing/pruning one entry per owner would
          // turn a memory fix into an O(owners) filesystem bottleneck.
          const durableKey = boundedSyntax || descriptor.analysis_cache_dir === undefined ? undefined : durableAnalysisCacheKey(cacheKey, descriptor, "stage1");
          const durableSyntax = descriptor.analysis_cache_dir === undefined || durableKey === undefined ? undefined : await readDurableAnalysisCache(descriptor.analysis_cache_dir, durableKey, 3);
          if (durableSyntax !== undefined) {
            analysis = durableSyntax;
            descriptor.on_analysis_cache_load?.();
          } else {
            descriptor.on_analysis_build?.();
            // Stage 1 is deliberately syntax-only.  In particular, large
            // corpora must never enter JsTsAnalysisSession here: its full
            // build constructs TypeScript's checker/program graph and can
            // exhaust the worker heap before the first structural frontier.
            // Later stages may opt into checker-backed analysis explicitly.
            analysis = boundedSyntax
              ? analyzeBoundedSyntaxProject({ files, root_names: rootNames })
              : analyzeSyntaxProject({ files, root_names: rootNames, ...(compilerOptions === undefined ? {} : { compiler_options: compilerOptions }) });
            if (descriptor.analysis_cache_dir !== undefined && durableKey !== undefined) await writeDurableAnalysisCache(descriptor.analysis_cache_dir, durableKey, analysis, descriptor.analysis_cache_max_entries ?? 16, 3);
          }
          stage1AnalysisCache = {
            key: cacheKey,
            analysis,
            file_hashes: new Map(files.map((file) => [file.path, fileContentHash(file, fileHashMemo)])),
            compiler_options_digest: compilerOptionsDigest,
          };
        }
      } else if (analysisCache !== undefined && analysisCache.key === cacheKey) {
        analysis = analysisCache.analysis;
        impactfulChangedPaths = analysisCache.impactful_changed_paths;
      } else if (analysisCache !== undefined && isSubsetOfCache(files, compilerOptionsDigest, analysisCache, fileHashMemo)) {
        analysis = analysisCache.analysis;
        impactfulChangedPaths = analysisCache.impactful_changed_paths;
      } else {
        const built = await loadOrBuildAnalysis(descriptor, session, files, rootNames, compilerOptions, cacheKey, rustSemanticScope);
        analysis = built.analysis;
        impactfulChangedPaths = built.impactful_changed_paths;
        analysisCache = {
          key: cacheKey, analysis, file_hashes: new Map(files.map((file) => [file.path, fileContentHash(file, fileHashMemo)])), compiler_options_digest: compilerOptionsDigest,
          ...(impactfulChangedPaths === undefined ? {} : { impactful_changed_paths: impactfulChangedPaths }),
        };
      }
      if (request.call === "analyze_closure") {
        // Runs/reuses the cached whole-project analysis (same cache as
        // `analyze_artifact`/`discover_partitions`, above) and returns just
        // its per-file dependency closures -- no `FactDelta` is produced.
        // Intended as ONE full-corpus call per scan (see `isSubsetOfCache`'s
        // doc comment): the caller fetches closures once, then narrows every
        // subsequent `analyze_artifact` request's `files`/manifest to the
        // owner's own closure. `impactful_changed_paths` (omitted when
        // undefined -- a durable-cache load or a full build never narrows)
        // lets the caller further narrow WHICH owners in an unchanged
        // closure actually need republishing -- see `isAffectedOwner` in
        // `apps/urdira/src/index.ts`.
        return response(request, {
          plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, dependency_closures: analysis.dependency_closures,
          ...(impactfulChangedPaths === undefined ? {} : { impactful_changed_paths: impactfulChangedPaths }),
        });
      }
      if (request.call === "analyze_artifact") {
        const workItem = rawPayload["work_item"] !== null && typeof rawPayload["work_item"] === "object" && !Array.isArray(rawPayload["work_item"])
          ? rawPayload["work_item"] as Record<string, unknown> : undefined;
        if (workItem === undefined) throw new Error("analyze_artifact requires a core artifact work item; scanner-only output is not a valid production response.");
        const acceptedManifest = rawPayload["accepted_manifest"] !== null && typeof rawPayload["accepted_manifest"] === "object" && !Array.isArray(rawPayload["accepted_manifest"])
          ? rawPayload["accepted_manifest"] as Record<string, unknown> : undefined;
        if (acceptedManifest === undefined) throw new Error("Production analyze_artifact requests require the accepted plugin-input manifest.");
        const ownerPath = typeof rawPayload["owner_path"] === "string" ? rawPayload["owner_path"] : undefined;
        const projectionFiles = rustSemanticScope === undefined || ownerPath === undefined
          ? files
          : filesForRustSemanticOwner(files, analysis, ownerPath, rustSemanticPreparedFiles);
        const factDeltaInput = {
          analysis,
          work_item: workItem,
          accepted_manifest: acceptedManifest,
          analysis_digest: typeof rawPayload["analysis_digest"] === "string" ? rawPayload["analysis_digest"] : descriptor.analysis_digest ?? "sha256:jsts-analysis",
          analysis_configuration_digest: typeof rawPayload["analysis_configuration_digest"] === "string" ? rawPayload["analysis_configuration_digest"] : descriptor.analysis_configuration_digest ?? "sha256:jsts-configuration",
          analysis_input_digest: typeof rawPayload["analysis_input_digest"] === "string" ? rawPayload["analysis_input_digest"] : request.request_digest,
          created_at: typeof rawPayload["created_at"] === "string" ? rawPayload["created_at"] : "1970-01-01T00:00:00.000Z",
          ...(typeof rawPayload["publication_stage_id"] === "string" ? { publication_stage_id: rawPayload["publication_stage_id"] } : {}),
          ...(Array.isArray(rawPayload["included_publication_stage_ids"]) && rawPayload["included_publication_stage_ids"].every((value) => typeof value === "string")
            ? { included_publication_stage_ids: rawPayload["included_publication_stage_ids"] as string[] }
            : {}),
          ...(typeof rawPayload["owner_path"] === "string" ? { owner_path: rawPayload["owner_path"] } : {}),
          files: projectionFiles,
        };
        if (directStream === "projection_input") return factDeltaInput;
        if (directStream === "prepared") return prepareJavascriptTypescriptFactDeltaStream(factDeltaInput, { cancellation_id: request.cancellation_id });
        if (directStream) return buildJavascriptTypescriptFactDeltaStream(factDeltaInput, { cancellation_id: request.cancellation_id });
        const factDelta = buildJavascriptTypescriptFactDelta(factDeltaInput);
        return response(request, {
          outcome: "success",
          result_type: "fact_delta",
          work_item_id: factDelta.work_item_id,
          ...(descriptor.native_batch_transport === "host" ? {} : { fact_delta_batches: [...iterateNativeFactDeltaBatches(factDelta)] }),
          validation_input: { raw_delta: factDelta, accepted_manifest: acceptedManifest },
        });
      }
      const projections = analysis.entities.map((entity) => ({ projection_kind: "jsts:semantic_preparation", identity_key: entity.id, text: `${entity.kind} ${entity.qualified_name ?? entity.name}`, path: entity.path, start: entity.start, end: entity.end }));
      // The public projection set is already an output array, but its digest
      // must not create a second aggregate JSON representation.  Hash the
      // logical fields directly with the v3 writer; validators accept the
      // legacy canonical digest during the rolling wire migration.
      const projectionDigest = new LogicalDigestWriter("urdira:projection-set:v3").value(projections).digest();
      return response(request, { projection_set: { projections, projection_set_digest: projectionDigest }, plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID });
  };
  return {
    invoke: async (request): Promise<unknown> => invoke(request, false),
    async invokeFactDeltaStream(request): Promise<FactDeltaStream> {
      if (request.call !== "analyze_artifact") throw new Error("Direct FactDeltaStream emission is limited to analyze_artifact.");
      return await invoke(request, true) as FactDeltaStream;
    },
    async invokeFactDeltaStreamGroup(requests): Promise<readonly FactDeltaStream[]> {
      if (requests.length === 0 || requests.length > 32) throw new Error("A semantic owner group must contain between 1 and 32 requests.");
      if (requests.some((request) => request.call !== "analyze_artifact"
        || ((request.payload as Record<string, unknown>)["rust_semantic_scope"] === undefined
          && (request.payload as Record<string, unknown>)["rust_semantic_scope_ref"] === undefined))) {
        throw new Error("Grouped FactDeltaStream emission is limited to Rust-authoritative semantic analyze_artifact requests.");
      }
      const ownerPaths = requests.map((request) => (request.payload as Record<string, unknown>)["owner_path"]);
      if (ownerPaths.some((path) => typeof path !== "string")) throw new Error("A semantic owner group request is missing owner_path.");
      // Stage 2 already walked the checker and sealed the exact stage-3
      // projection for every owner. Reopening a lookup group here used to
      // repeat batched symbol/type/diagnostic queries before immediately
      // reading those same results from the spool. Skip the checker only when
      // every requested owner is an exact stage-3 spool hit; any miss retains
      // the complete checker-backed fallback for the whole bounded group.
      const spoolOnly = requests.every((request, index) => {
        const payload = request.payload as Record<string, unknown>;
        return payload["publication_stage_id"] === "jsts:structural_stage_3"
          && hasRustSemanticSpoolEntry(ownerPaths[index] as string);
      });
      if (!spoolOnly) {
        const includeInferredTypes = requests.some((request) => {
          const kinds = (request.payload as Record<string, unknown>)["stage_record_kinds"];
          const stage = (request.payload as Record<string, unknown>)["publication_stage_id"];
          return stage === "jsts:structural_stage_2" || (Array.isArray(kinds) && kinds.includes("jsts:entity_inferred_type"));
        });
        session.beginRustSemanticOwnerGroup(ownerPaths as string[], includeInferredTypes, pendingSitesByOwnerFromRequests(requests));
        descriptor.on_rust_semantic_group_prepare?.(ownerPaths as string[]);
      }
      try {
        const debugTiming = process.env["URDIRA_DEBUG_TIMING"] === "1";
        const inputStarted = debugTiming ? performance.now() : 0;
        const inputs: JavascriptTypescriptFactDeltaInput[] = [];
        for (const request of requests) inputs.push(await invoke(request, "projection_input") as JavascriptTypescriptFactDeltaInput);
        const inputElapsed = debugTiming ? performance.now() - inputStarted : 0;
        const prepared: PreparedJavascriptTypescriptFactDeltaStream[] = [];
        // Bound before crossing N-API. The estimate deliberately counts every
        // relation twice (row plus possible dependency); therefore any admitted
        // group is within the core's exact 4,096-row bound. A giant owner keeps
        // the portable paged path without weakening continuation semantics.
        const estimatedRows = (input: JavascriptTypescriptFactDeltaInput): number => {
          const path = input.owner_path;
          if (path === undefined) return FACT_DELTA_STREAM_MAX_ROWS + 1;
          return input.analysis.entities.filter((entry) => entry.path === path).reduce((count, entry) => count + (entry.type === undefined ? 1 : 3), 0)
            + input.analysis.relations.filter((entry) => entry.path === path).length * 2
            + input.analysis.diagnostics.filter((entry) => entry.path === path).length;
        };
        const projectionStarted = debugTiming ? performance.now() : 0;
        let index = 0;
        while (index < inputs.length) {
          const firstRows = estimatedRows(inputs[index]!);
          if (firstRows > FACT_DELTA_STREAM_MAX_ROWS) {
            prepared.push(prepareJavascriptTypescriptFactDeltaStream(inputs[index]!, { cancellation_id: requests[index]!.cancellation_id }));
            index += 1;
            continue;
          }
          let end = index;
          let rows = 0;
          while (end < inputs.length) {
            const next = estimatedRows(inputs[end]!);
            if (next > FACT_DELTA_STREAM_MAX_ROWS || rows + next > FACT_DELTA_STREAM_MAX_ROWS) break;
            rows += next;
            end += 1;
          }
          const projected = projectStructuralObservationGroup(JAVASCRIPT_TYPESCRIPT_NATIVE_PROJECTION_PROFILE, {
            owners: inputs.slice(index, end).map(javascriptTypescriptNativeProjectionOwner),
          });
          if (projected === undefined) {
            for (let ownerIndex = index; ownerIndex < end; ownerIndex += 1) prepared.push(prepareJavascriptTypescriptFactDeltaStream(inputs[ownerIndex]!, { cancellation_id: requests[ownerIndex]!.cancellation_id }));
          } else {
            if (projected.length !== end - index) throw new Error("Native semantic observation projection returned the wrong owner count.");
            projected.forEach((owner, projectedIndex) => {
              const input = inputs[index + projectedIndex]!;
              const { analysis: _analysis, ...projectedInput } = input;
              prepared.push(prepareJavascriptTypescriptProjectedFactDeltaStream({
                ...projectedInput,
                owner_path: input.owner_path!,
                projection: owner,
              }, { cancellation_id: requests[index + projectedIndex]!.cancellation_id }));
            });
          }
          index = end;
        }
        // The language oracle constructs observations; the generic core-owned
        // kernel canonicalizes and derives publication scalars once for as
        // many complete owners as fit the 4,096-row physical boundary. An
        // oversized owner stays on its existing independently paged path.
        let physical: PreparedJavascriptTypescriptFactDeltaStream[] = [];
        let physicalRows = 0;
        const flush = (): void => {
          if (physical.length === 0) return;
          // Native-projected rows are already attached to the exact kernel
          // result. Portable fallback owners are prepared here as before.
          prepareFactDeltaStreamStructuralGroup(physical);
          physical = [];
          physicalRows = 0;
        };
        for (const owner of prepared) {
          const ownerRows = owner.records.length + owner.dependencies.length;
          if (ownerRows > FACT_DELTA_STREAM_MAX_ROWS) { flush(); continue; }
          if (physicalRows + ownerRows > FACT_DELTA_STREAM_MAX_ROWS) flush();
          physical.push(owner);
          physicalRows += ownerRows;
        }
        flush();
        const projectionElapsed = debugTiming ? performance.now() - projectionStarted : 0;
        if (debugTiming) console.error(`[urdira] semantic group internals owners=${requests.length} analyze_ms=${Math.round(inputElapsed)} project_prepare_ms=${Math.round(projectionElapsed)}`);
        return Object.freeze(prepared.map((owner) => owner.seal()));
      } finally {
        if (!spoolOnly) session.endRustSemanticOwnerGroup();
      }
    },
    async invokeRustSemanticObservationGroup(requests): Promise<readonly RustSemanticObservationOwner[]> {
      if (requests.length === 0 || requests.length > 32) throw new Error("A semantic owner group must contain between 1 and 32 requests.");
      if (requests.some((request) => request.call !== "analyze_artifact"
        || ((request.payload as Record<string, unknown>)["rust_semantic_scope"] === undefined
          && (request.payload as Record<string, unknown>)["rust_semantic_scope_ref"] === undefined))) {
        throw new Error("Grouped Rust semantic observations are limited to Rust-authoritative analyze_artifact requests.");
      }
      const ownerPaths = requests.map((request) => (request.payload as Record<string, unknown>)["owner_path"]);
      if (ownerPaths.some((path) => typeof path !== "string")) throw new Error("A semantic owner group request is missing owner_path.");
      const spoolOnly = requests.every((request, index) => {
        const payload = request.payload as Record<string, unknown>;
        return payload["publication_stage_id"] === "jsts:structural_stage_3"
          && hasRustSemanticSpoolEntry(ownerPaths[index] as string);
      });
      if (!spoolOnly) {
        const includeInferredTypes = requests.some((request) => {
          const payload = request.payload as Record<string, unknown>;
          const kinds = payload["stage_record_kinds"];
          return payload["publication_stage_id"] === "jsts:structural_stage_2"
            || (Array.isArray(kinds) && kinds.includes("jsts:entity_inferred_type"));
        });
        session.beginRustSemanticOwnerGroup(ownerPaths as string[], includeInferredTypes, pendingSitesByOwnerFromRequests(requests));
        descriptor.on_rust_semantic_group_prepare?.(ownerPaths as string[]);
      }
      try {
        const inputs: JavascriptTypescriptFactDeltaInput[] = [];
        for (const request of requests) inputs.push(await invoke(request, "projection_input") as JavascriptTypescriptFactDeltaInput);
        const estimatedRows = (input: JavascriptTypescriptFactDeltaInput): number => {
          const path = input.owner_path;
          if (path === undefined) return FACT_DELTA_STREAM_MAX_ROWS + 1;
          return input.analysis.entities.filter((entry) => entry.path === path).reduce((count, entry) => count + (entry.type === undefined ? 1 : 3), 0)
            + input.analysis.relations.filter((entry) => entry.path === path).length * 2
            + input.analysis.diagnostics.filter((entry) => entry.path === path).length;
        };
        const observations: RustSemanticObservationOwner[] = [];
        let index = 0;
        while (index < inputs.length) {
          const first = estimatedRows(inputs[index]!);
          /* c8 ignore start -- giant-owner fallback is exercised by the Rust preflight corpus. */
          if (first > FACT_DELTA_STREAM_MAX_ROWS) {
            const payload = requests[index]!.payload as Record<string, unknown>;
            const rustOwnedDigests = payload["rust_owned_digests"] === true;
            const stream = await invoke(requests[index]!, "prepared") as PreparedJavascriptTypescriptFactDeltaStream;
            if (rustOwnedDigests) {
              observations.push(rustOwnedPreparedObservation(stream, inputs[index]!));
              index += 1;
              continue;
            }
            const sealedStream = stream.seal();
            const header = sealedStream.header;
            const batches: Array<RustSemanticObservationOwner["batches"][number]> = [];
            for await (const batch of sealedStream.batches) {
              const sealed = factDeltaStreamSealedRows(batch);
              batches.push({ sequence: batch.sequence, final_batch: batch.final, canonical_records: sealed?.canonical_records ?? batch.records.map(factDeltaStreamCanonicalRow), canonical_dependencies: sealed?.canonical_dependencies ?? batch.dependencies.map(factDeltaStreamCanonicalRow), byte_length: 0, owner_digest: "", fact_delta_id: `${header.fact_delta_id}:${batch.sequence}`, delta_digest: header.delta_digest, diagnostic_codes: [] });
            }
              observations.push({ owner_artifact_id: header.owner_artifact_id, owner_artifact_version_id: header.owner_artifact_version_id, owner_path: inputs[index]!.owner_path!, diagnostic_proposal_keys: [], batches });
            index += 1;
            continue;
          }
          let end = index;
          let rows = 0;
          while (end < inputs.length) {
            const next = estimatedRows(inputs[end]!);
            if (next > FACT_DELTA_STREAM_MAX_ROWS || rows + next > FACT_DELTA_STREAM_MAX_ROWS) break;
            rows += next;
            end += 1;
          }
          const projected = projectStructuralObservationGroup(JAVASCRIPT_TYPESCRIPT_NATIVE_PROJECTION_PROFILE, { owners: inputs.slice(index, end).map(javascriptTypescriptNativeProjectionOwner) });
          if (projected === undefined) {
            for (let ownerIndex = index; ownerIndex < end; ownerIndex += 1) {
              const payload = requests[ownerIndex]!.payload as Record<string, unknown>;
              const rustOwnedDigests = payload["rust_owned_digests"] === true;
              const stream = await invoke(requests[ownerIndex]!, "prepared") as PreparedJavascriptTypescriptFactDeltaStream;
              if (rustOwnedDigests) {
                observations.push(rustOwnedPreparedObservation(stream, inputs[ownerIndex]!));
                continue;
              }
              const sealedStream = stream.seal();
              const batches: Array<RustSemanticObservationOwner["batches"][number]> = [];
              for await (const batch of sealedStream.batches) {
                const sealed = factDeltaStreamSealedRows(batch);
                batches.push({ sequence: batch.sequence, final_batch: batch.final, canonical_records: sealed?.canonical_records ?? batch.records.map(factDeltaStreamCanonicalRow), canonical_dependencies: sealed?.canonical_dependencies ?? batch.dependencies.map(factDeltaStreamCanonicalRow), byte_length: 0, owner_digest: "", fact_delta_id: `${sealedStream.header.fact_delta_id}:${batch.sequence}`, delta_digest: sealedStream.header.delta_digest, diagnostic_codes: [] });
              }
              observations.push({ owner_artifact_id: sealedStream.header.owner_artifact_id, owner_artifact_version_id: sealedStream.header.owner_artifact_version_id, owner_path: inputs[ownerIndex]!.owner_path!, diagnostic_proposal_keys: [], batches });
            }
          } else {
            if (projected.length !== end - index) throw new Error("Native semantic observation projection returned the wrong owner count.");
            projected.forEach((owner, projectedIndex) => {
              const input = inputs[index + projectedIndex]!;
              const rustOwnedDigests = (requests[index + projectedIndex]!.payload as Record<string, unknown>)["rust_owned_digests"] === true;
              const headerInput = {
                ...input,
                owner_path: input.owner_path!,
                records: owner.record_headers as unknown as JavascriptTypescriptNativeFactDeltaInput["records"],
                dependencies: owner.dependency_headers as unknown as JavascriptTypescriptNativeFactDeltaInput["dependencies"],
                canonical_records: owner.canonical_records,
                canonical_dependencies: owner.canonical_dependencies,
                diagnostic_codes: owner.diagnostic_codes,
              } satisfies JavascriptTypescriptNativeFactDeltaInput;
              const diagnosticProposalKeys = owner.record_headers
                .filter((record) => record.category === "diagnostic")
                .map((record) => record.proposal_record_key);
              const header = rustOwnedDigests ? undefined : buildJavascriptTypescriptNativeFactDeltaHeader(headerInput, { cancellation_id: requests[index + projectedIndex]!.cancellation_id });
              const batches: Array<RustSemanticObservationOwner["batches"][number]> = [];
              const records = owner.canonical_records;
              const dependencies = owner.canonical_dependencies;
              const maxRows = FACT_DELTA_STREAM_MAX_ROWS;
              const maxBytes = RUST_SEMANTIC_OBSERVATION_MAX_BYTES;
              let recordStart = 0;
              let dependencyStart = 0;
              let sequence = 0;
              while (recordStart < records.length || dependencyStart < dependencies.length || sequence === 0) {
                const batchRecords: string[] = [];
                const batchDependencies: string[] = [];
                let bytes = 0;
                while (recordStart < records.length && batchRecords.length + batchDependencies.length < maxRows && bytes + records[recordStart]!.length <= maxBytes) { const row = records[recordStart++]!; batchRecords.push(row); bytes += row.length; }
                while (dependencyStart < dependencies.length && batchRecords.length + batchDependencies.length < maxRows && bytes + dependencies[dependencyStart]!.length <= maxBytes) { const row = dependencies[dependencyStart++]!; batchDependencies.push(row); bytes += row.length; }
                if (batchRecords.length === 0 && batchDependencies.length === 0 && sequence !== 0) {
                  const pending = Math.max(records[recordStart]?.length ?? 0, dependencies[dependencyStart]?.length ?? 0);
                  throw new Error(`Native semantic observation row exceeds its physical batch budget (owner=${input.owner_path ?? "?"}, bytes=${pending}, limit=${RUST_SEMANTIC_OBSERVATION_MAX_BYTES}).`);
                }
                const finalBatch = recordStart === records.length && dependencyStart === dependencies.length;
                batches.push({ sequence, final_batch: finalBatch, canonical_records: batchRecords, canonical_dependencies: batchDependencies, byte_length: 0, owner_digest: "", fact_delta_id: header === undefined ? "" : `${header.fact_delta_id}:${sequence}`, delta_digest: header?.delta_digest ?? "", diagnostic_codes: owner.diagnostic_codes });
                sequence += 1;
              }
              observations.push({ owner_artifact_id: header?.owner_artifact_id ?? String(input.work_item["artifact_id"]), owner_artifact_version_id: header?.owner_artifact_version_id ?? String(input.work_item["target_artifact_version_id"]), owner_path: input.owner_path!, diagnostic_proposal_keys: rustOwnedDigests ? diagnosticProposalKeys : [], batches });
            });
          }
          /* c8 ignore stop */
          index = end;
        }
        return Object.freeze(observations);
      } finally {
        if (!spoolOnly) session.endRustSemanticOwnerGroup();
      }
    },
    async cancel(): Promise<void> { return; },
    async reset(): Promise<unknown> {
      analysisCache = undefined;
      stage1AnalysisCache = undefined;
      rustSemanticPreparedFileHashes = undefined;
      rustSemanticPreparedFiles = undefined;
      rustSemanticPreparedScope = undefined;
      await closeRustSemanticSpool();
      fileHashMemo.clear();
      session.close();
      return { state_reset: true };
    },
    async terminate(): Promise<void> { terminated = true; analysisCache = undefined; stage1AnalysisCache = undefined; rustSemanticPreparedFileHashes = undefined; rustSemanticPreparedFiles = undefined; rustSemanticPreparedScope = undefined; await closeRustSemanticSpool(); fileHashMemo.clear(); session.close(); },
  };
}
