import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip as gunzipCallback, gzip as gzipCallback } from "node:zlib";
import { canonicalSha256, type PluginWorkerRequestEnvelope, type WorkerTransport } from "@urdira/plugin-sdk";
import { analyzeSyntaxProject, discoverProjects, JAVASCRIPT_TYPESCRIPT_CAPABILITIES, JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, JAVASCRIPT_TYPESCRIPT_VERSION, JsTsAnalysisSession, TYPESCRIPT_COMPILER_VERSION, type AnalyzerFile, type JsTsAnalysisResult } from "./analyzer.js";
import { buildJavascriptTypescriptFactDelta } from "./fact-delta.js";

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

function filesFromPayload(payload: unknown): AnalyzerFile[] {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Worker payload must be an object.");
  const files = (payload as Record<string, unknown>)["files"];
  if (!Array.isArray(files)) throw new Error("Worker payload.files must be an array.");
  const result = files.map((entry): AnalyzerFile => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)
      || typeof (entry as Record<string, unknown>)["path"] !== "string"
      || typeof (entry as Record<string, unknown>)["text"] !== "string") {
      throw new Error("Worker payload.files contains an invalid source file.");
    }
    const path = (entry as Record<string, unknown>)["path"] as string;
    if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error("Worker source paths must be normalized relative paths.");
    }
    const artifactId = (entry as Record<string, unknown>)["artifact_id"];
    const artifactVersionId = (entry as Record<string, unknown>)["artifact_version_id"];
    const contentHash = (entry as Record<string, unknown>)["content_hash"];
    for (const [field, value] of [["artifact_id", artifactId], ["artifact_version_id", artifactVersionId], ["content_hash", contentHash]] as const) {
      if (value !== undefined && (typeof value !== "string" || value.length === 0)) throw new Error(`Worker payload.files ${field} must be a non-empty string when present.`);
    }
    return { path, text: (entry as Record<string, unknown>)["text"] as string, ...(typeof artifactId === "string" ? { artifact_id: artifactId } : {}), ...(typeof artifactVersionId === "string" ? { artifact_version_id: artifactVersionId } : {}), ...(typeof contentHash === "string" ? { content_hash: contentHash } : {}) };
  });
  return result.sort((left, right) => left.path.localeCompare(right.path));
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

export interface JavascriptTypescriptWorkerDescriptor {
  readonly compatibility_declaration_digest?: string;
  readonly registry_contribution_digest?: string;
  readonly analysis_digest?: string;
  readonly analysis_configuration_digest?: string;
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
function isSubsetOfCache(files: readonly AnalyzerFile[], compilerOptionsDigest: string, cache: AnalysisCacheEntry, memo: Map<string, { text: string; hash: string }>): boolean {
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
function analysisCacheKey(files: readonly AnalyzerFile[], rootNames: readonly string[], compilerOptions: Readonly<Record<string, unknown>> | undefined, fileHashMemo: Map<string, { text: string; hash: string }>): string {
  const sortedRootNames = [...rootNames].sort();
  const rootNameSet = new Set(sortedRootNames);
  const relevantFiles = files
    .filter((file) => rootNameSet.has(file.path))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => ({ path: file.path, content_hash: fileContentHash(file, fileHashMemo) }));
  return canonicalSha256({ root_names: sortedRootNames, file_hashes: relevantFiles, compiler_options: compilerOptions ?? null });
}

function fileContentHash(file: AnalyzerFile, memo: Map<string, { text: string; hash: string }>): string {
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
function durableAnalysisCacheKey(cacheKey: string, descriptor: JavascriptTypescriptWorkerDescriptor, stage = "monolithic"): string {
  const digest = canonicalSha256({
    format_version: stage === "monolithic" ? 1 : 2,
    stage,
    cache_key: cacheKey,
    typescript_compiler_version: TYPESCRIPT_COMPILER_VERSION,
    plugin_version: JAVASCRIPT_TYPESCRIPT_VERSION,
    analysis_digest: descriptor.analysis_digest ?? null,
    analysis_configuration_digest: descriptor.analysis_configuration_digest ?? null,
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
async function loadOrBuildAnalysis(descriptor: JavascriptTypescriptWorkerDescriptor, session: JsTsAnalysisSession, files: readonly AnalyzerFile[], rootNames: readonly string[], compilerOptions: Readonly<Record<string, unknown>> | undefined, cacheKey: string): Promise<{ readonly analysis: JsTsAnalysisResult; readonly impactful_changed_paths?: readonly string[] }> {
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
  const sessionResult = session.analyze({ files, root_names: rootNames, ...(compilerOptions === undefined ? {} : { compiler_options: compilerOptions }) });
  if (sessionResult.build === "incremental") descriptor.on_analysis_incremental?.(sessionResult.rewalked);
  const analysis = sessionResult.result;
  if (cacheDir !== undefined && durableKey !== undefined) await writeDurableAnalysisCache(cacheDir, durableKey, analysis, descriptor.analysis_cache_max_entries ?? 16);
  return { analysis, ...(sessionResult.impactful_changed_paths === undefined ? {} : { impactful_changed_paths: sessionResult.impactful_changed_paths }) };
}

export function createJavascriptTypescriptWorker(descriptor: JavascriptTypescriptWorkerDescriptor = {}): WorkerTransport {
  let terminated = false;
  let analysisCache: AnalysisCacheEntry | undefined;
  const syntaxAnalysisCache = new Map<string, JsTsAnalysisResult>();
  const fileHashMemo = new Map<string, { text: string; hash: string }>();
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
  return {
    async invoke(request: PluginWorkerRequestEnvelope): Promise<unknown> {
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
      const files = filesFromPayload(request.payload);
      if (request.call === "discover_partitions") return response(request, { partitions: discoverProjects(files), plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID });
      const rawPayload = request.payload as Record<string, unknown>;
      const rootNames = Array.isArray(rawPayload["root_names"]) && rawPayload["root_names"].every((value) => typeof value === "string")
        ? rawPayload["root_names"] as string[] : files.map((file) => file.path);
      const compilerOptions = rawPayload["compiler_options"] !== null && typeof rawPayload["compiler_options"] === "object" && !Array.isArray(rawPayload["compiler_options"])
        ? rawPayload["compiler_options"] as Record<string, unknown> : undefined;
      const compilerOptionsDigest = canonicalSha256(compilerOptions ?? null);
      const cacheKey = analysisCacheKey(files, rootNames, compilerOptions, fileHashMemo);
      let analysis: JsTsAnalysisResult;
      let impactfulChangedPaths: readonly string[] | undefined;
      const publicationStageId = typeof rawPayload["publication_stage_id"] === "string" ? rawPayload["publication_stage_id"] : undefined;
      if (publicationStageId === "jsts:structural_stage_1") {
        const syntaxCacheKey = `stage1:${cacheKey}`;
        const cachedSyntax = syntaxAnalysisCache.get(syntaxCacheKey);
        if (cachedSyntax !== undefined) {
          analysis = cachedSyntax;
        } else {
          const durableKey = descriptor.analysis_cache_dir === undefined ? undefined : durableAnalysisCacheKey(cacheKey, descriptor, "stage1");
          const durableSyntax = descriptor.analysis_cache_dir === undefined || durableKey === undefined ? undefined : await readDurableAnalysisCache(descriptor.analysis_cache_dir, durableKey, 2);
          if (durableSyntax !== undefined) {
            analysis = durableSyntax;
            descriptor.on_analysis_cache_load?.();
          } else {
            descriptor.on_analysis_build?.();
            analysis = analyzeSyntaxProject({ files, root_names: rootNames, ...(compilerOptions === undefined ? {} : { compiler_options: compilerOptions }) });
            if (descriptor.analysis_cache_dir !== undefined && durableKey !== undefined) await writeDurableAnalysisCache(descriptor.analysis_cache_dir, durableKey, analysis, descriptor.analysis_cache_max_entries ?? 16, 2);
          }
          syntaxAnalysisCache.set(syntaxCacheKey, analysis);
        }
      } else if (analysisCache !== undefined && analysisCache.key === cacheKey) {
        analysis = analysisCache.analysis;
        impactfulChangedPaths = analysisCache.impactful_changed_paths;
      } else if (analysisCache !== undefined && isSubsetOfCache(files, compilerOptionsDigest, analysisCache, fileHashMemo)) {
        analysis = analysisCache.analysis;
        impactfulChangedPaths = analysisCache.impactful_changed_paths;
      } else {
        const built = await loadOrBuildAnalysis(descriptor, session, files, rootNames, compilerOptions, cacheKey);
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
        const factDelta = buildJavascriptTypescriptFactDelta({
          analysis,
          work_item: workItem,
          accepted_manifest: acceptedManifest,
          analysis_digest: typeof rawPayload["analysis_digest"] === "string" ? rawPayload["analysis_digest"] : descriptor.analysis_digest ?? "sha256:jsts-analysis",
          analysis_configuration_digest: typeof rawPayload["analysis_configuration_digest"] === "string" ? rawPayload["analysis_configuration_digest"] : descriptor.analysis_configuration_digest ?? "sha256:jsts-configuration",
          analysis_input_digest: typeof rawPayload["analysis_input_digest"] === "string" ? rawPayload["analysis_input_digest"] : request.request_digest,
          created_at: typeof rawPayload["created_at"] === "string" ? rawPayload["created_at"] : "1970-01-01T00:00:00.000Z",
          ...(typeof rawPayload["publication_stage_id"] === "string" ? { publication_stage_id: rawPayload["publication_stage_id"] } : {}),
          ...(typeof rawPayload["owner_path"] === "string" ? { owner_path: rawPayload["owner_path"] } : {}),
          files,
        });
        return response(request, {
          outcome: "success",
          result_type: "fact_delta",
          work_item_id: factDelta.work_item_id,
          validation_input: { raw_delta: factDelta, accepted_manifest: acceptedManifest },
        });
      }
      const projections = analysis.entities.map((entity) => ({ projection_kind: "jsts:semantic_preparation", identity_key: entity.id, text: `${entity.kind} ${entity.qualified_name ?? entity.name}`, path: entity.path, start: entity.start, end: entity.end }));
      const projectionDigest = `sha256:${createHash("sha256").update(JSON.stringify(projections)).digest("hex")}`;
      return response(request, { projection_set: { projections, projection_set_digest: projectionDigest }, plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID });
    },
    async cancel(): Promise<void> { return; },
    async reset(): Promise<unknown> { return { state_reset: true }; },
    async terminate(): Promise<void> { terminated = true; analysisCache = undefined; syntaxAnalysisCache.clear(); fileHashMemo.clear(); session.close(); },
  };
}
