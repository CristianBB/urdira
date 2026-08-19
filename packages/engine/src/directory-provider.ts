import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type {
  JsonValue,
  ObservationCoverageScope,
  SourceObservation,
  SourceObservationBatch,
  SourceProviderDescribeResult,
  SourceProviderEnumerateRequest,
  SourceProviderReadRequest,
  SourceProviderReadResult,
  SourceProviderRequestEnvelope,
  SourceProviderResourceBudget,
  SourceProviderResponseEnvelope,
  SourceProviderWatchRequest,
  SourceProviderWatchResult,
} from "@urdira/contracts";
import { canonicalBytes, digestBytes } from "@urdira/canonical";
import { canonicalizePath, evaluateInclusion, isWithinRoot, normalizeWorkspacePath, type GitIgnoreRules, type InclusionRules } from "@urdira/security";
import { mapWithConcurrency } from "./concurrency.js";
import { sourceObservationBatchDigest } from "./source-batch-digest.js";
import {
  executeProviderCall,
  parseProviderPayload,
  providerRuntime,
  sourceProviderArtifactId,
  SourceProviderOutcomeError,
  type SourceProvider,
  type SourceProviderRequestExpectations,
  type SourceProviderRuntime,
} from "./source-provider.js";

export interface DirectoryEntry {
  readonly name: string;
  readonly is_directory: boolean;
  readonly is_symbolic_link: boolean;
}

export interface DirectoryFileStat {
  readonly size: number;
  readonly mtime_ms: number;
  readonly ctime_ms: number;
  readonly mode: number;
  readonly inode: number;
  readonly device: number;
  readonly is_directory: boolean;
  readonly is_symbolic_link: boolean;
  readonly is_special: boolean;
}

export interface DirectoryFileSystem {
  read_directory(path: string): Promise<readonly DirectoryEntry[]>;
  read_file(path: string): Promise<Uint8Array>;
  lstat(path: string): Promise<DirectoryFileStat>;
  stat(path: string): Promise<DirectoryFileStat>;
  real_path(path: string): Promise<string>;
}

function portableStat(value: Awaited<ReturnType<typeof lstat>>): DirectoryFileStat {
  return {
    size: Number(value.size),
    mtime_ms: Number(value.mtimeMs),
    ctime_ms: Number(value.ctimeMs),
    mode: Number(value.mode),
    inode: Number(value.ino),
    device: Number(value.dev),
    is_directory: value.isDirectory(),
    is_symbolic_link: value.isSymbolicLink(),
    is_special: value.isBlockDevice() || value.isCharacterDevice() || value.isFIFO() || value.isSocket(),
  };
}

export const NODE_DIRECTORY_FILE_SYSTEM: DirectoryFileSystem = Object.freeze({
  async read_directory(path: string): Promise<readonly DirectoryEntry[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, is_directory: entry.isDirectory(), is_symbolic_link: entry.isSymbolicLink() }));
  },
  async read_file(path: string): Promise<Uint8Array> { return readFile(path); },
  async lstat(path: string): Promise<DirectoryFileStat> { return portableStat(await lstat(path)); },
  async stat(path: string): Promise<DirectoryFileStat> { return portableStat(await stat(path)); },
  async real_path(path: string): Promise<string> { return realpath(path); },
});

export interface DirectorySourceProviderOptions {
  readonly root: string;
  readonly workspace_id: string;
  readonly source_provider_binding_id: string;
  readonly provider_kind?: string;
  readonly provider_version?: string;
  readonly inclusion_rules?: InclusionRules;
  readonly gitignore_rules?: GitIgnoreRules;
  readonly file_system?: DirectoryFileSystem;
  readonly now?: () => string;
  readonly monotonic_now?: () => number;
  readonly is_cancelled?: (cancellationId: string) => boolean;
  /**
   * Maximum number of directory-entry stat/capture operations in flight at
   * once *per directory listing* (default 16; see `#walk`). This bound is
   * applied independently at each directory level rather than shared across
   * the whole recursive walk, to avoid a recursive-semaphore deadlock (a
   * directory's own pool slot would otherwise be held open while its
   * subdirectory recursion waits on the very same shared pool for its own
   * slots). In the pathological case of a very deep, very bushy tree walked
   * fully in parallel, the number of concurrently open file handles can
   * multiply across levels; real repository trees do not come close to this
   * bound in practice.
   */
  readonly io_concurrency?: number;
}

export interface ProviderObservation extends SourceObservation {
  readonly normalized_uri: string;
  readonly provider_version_token: string;
}

export interface EncodedObservationBatch {
  readonly batch: SourceObservationBatch;
  readonly observations: readonly ProviderObservation[];
}

interface CapturedFile {
  readonly uri: string;
  // Only populated when the pass that produced this entry retained bytes
  // (see `#inventory`'s `digestOnly` mode); every consumer needs only
  // `content_hash`, computed once from the bytes at read time regardless of
  // whether they were retained.
  readonly bytes?: Uint8Array | undefined;
  readonly content_hash: string;
  readonly metadata_digest: string;
  readonly token_before: string;
  readonly token_after: string;
}

interface FileBoundary {
  readonly included: boolean;
  readonly link_stat: DirectoryFileStat;
  readonly target_path: string;
  readonly target_stat: DirectoryFileStat;
  readonly token: string;
  readonly metadata_digest: string;
}

interface Inventory {
  readonly files: readonly CapturedFile[];
  readonly before_fingerprint: string;
  readonly after_fingerprint: string;
  readonly internally_stable: boolean;
}

interface Capture {
  readonly files: readonly CapturedFile[];
  readonly start_fingerprint: string;
  readonly end_fingerprint: string;
  readonly stable: boolean;
}

const DEFAULT_INCLUSION: InclusionRules = { include: [], exclude: [], allow_external_root: false };
const DEFAULT_GITIGNORE: GitIgnoreRules = { enabled: false, patterns: [] };
const DEFAULT_WALK_CONCURRENCY = 16;
const BINARY_EXTENSIONS = new Set([".7z", ".avi", ".bin", ".bmp", ".class", ".dll", ".dylib", ".eot", ".exe", ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".mov", ".mp3", ".mp4", ".o", ".pdf", ".png", ".so", ".tar", ".wasm", ".webp", ".woff", ".woff2", ".zip"]);

function jsonDigest(value: unknown): string {
  return digestBytes(canonicalBytes(value));
}

function rawDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function metadata(statValue: DirectoryFileStat): Record<string, number> {
  return {
    byte_length: statValue.size,
    ctime_ms: statValue.ctime_ms,
    device: statValue.device,
    inode: statValue.inode,
    mode: statValue.mode,
    mtime_ms: statValue.mtime_ms,
  };
}

function errorCode(error: unknown): string {
  return error !== null && typeof error === "object" && "code" in error ? String((error as { readonly code?: unknown }).code) : "";
}

function unavailable(error: unknown): never {
  if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(errorCode(error))) {
    throw new SourceProviderOutcomeError("unavailable", "core:source_provider_unavailable", "retryable", "The provider root is unavailable.");
  }
  throw error;
}

export function sameCanonicalArtifactPath(left: string, right: string): boolean {
  return canonicalizePath(left) === canonicalizePath(right);
}

// One capture inspects the same bytes twice (inclusion check + post-read boundary
// check); memoizing on the byte buffer halves the full-content decode work.
const mediaTypeMemo = new WeakMap<Uint8Array, { path: string; result: string }>();

function mediaType(path: string, bytes: Uint8Array): string {
  const cached = mediaTypeMemo.get(bytes);
  if (cached !== undefined && cached.path === path) return cached.result;
  const result = computeMediaType(path, bytes);
  mediaTypeMemo.set(bytes, { path, result });
  return result;
}

function computeMediaType(path: string, bytes: Uint8Array): string {
  if (BINARY_EXTENSIONS.has(extname(path).toLowerCase()) || bytes.some((byte) => byte === 0)) return "application/octet-stream";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "text/plain";
  } catch {
    return "application/octet-stream";
  }
}

function parseScopes(payload: SourceProviderEnumerateRequest, bindingId: string, providerKind: string): readonly ObservationCoverageScope[] {
  if (!Array.isArray(payload.coverage_scopes) || payload.coverage_scopes.length === 0) {
    throw new SourceProviderOutcomeError("failed", "core:source_provider_scope_invalid", "never", "At least one coverage scope is required.");
  }
  for (const scope of payload.coverage_scopes) {
    if (scope === null || typeof scope !== "object" || scope.source_provider_binding_id !== bindingId || scope.source_provider !== providerKind
      || typeof scope.normalized_scope_key !== "string") {
      throw new SourceProviderOutcomeError("failed", "core:source_provider_scope_invalid", "never", "The coverage scope does not match this provider binding.");
    }
  }
  return payload.coverage_scopes;
}

export class DirectorySourceProvider implements SourceProvider {
  readonly component_id: string;
  readonly component_version: string;
  readonly #root: string;
  readonly #providerKind: string;
  readonly #providerVersion: string;
  readonly #inclusion: InclusionRules;
  readonly #gitignore: GitIgnoreRules;
  readonly #fileSystem: DirectoryFileSystem;
  readonly #runtime: SourceProviderRuntime;
  readonly #requestExpectations: SourceProviderRequestExpectations;
  readonly #ioConcurrency: number;

  constructor(options: DirectorySourceProviderOptions) {
    this.#root = canonicalizePath(options.root);
    this.#ioConcurrency = options.io_concurrency !== undefined && Number.isSafeInteger(options.io_concurrency) && options.io_concurrency > 0
      ? options.io_concurrency : DEFAULT_WALK_CONCURRENCY;
    this.#providerKind = options.provider_kind ?? "core:directory_source_provider";
    this.#providerVersion = options.provider_version ?? "1";
    this.component_id = this.#providerKind;
    this.component_version = this.#providerVersion;
    this.#requestExpectations = {
      protocol_version: "1",
      workspace_id: options.workspace_id,
      source_provider_binding_id: options.source_provider_binding_id,
      component_id: this.component_id,
      component_version: this.component_version,
    };
    this.#inclusion = options.inclusion_rules ?? DEFAULT_INCLUSION;
    this.#gitignore = options.gitignore_rules ?? DEFAULT_GITIGNORE;
    this.#fileSystem = options.file_system ?? NODE_DIRECTORY_FILE_SYSTEM;
    this.#runtime = providerRuntime(options);
  }

  describe(request: SourceProviderRequestEnvelope): Promise<SourceProviderResponseEnvelope> {
    return executeProviderCall(request, "describe", this.#requestExpectations, this.#runtime, async () => {
      parseProviderPayload<{ readonly binding_configuration_digest: string }>(request);
      const capture = await this.#capture([""]);
      const features = {
        supports_watch: false,
        supports_authoritative_delete_events: false,
        supports_complete_enumeration: true,
        supports_stable_reconciliation: true,
        supports_virtual_artifacts: false,
        case_behavior: process.platform === "win32" ? "insensitive_preserving" : "sensitive",
        read_only: false,
      };
      return {
        provider_kind: this.#providerKind,
        immutable_binding_identity: jsonDigest({ provider_kind: this.#providerKind, root: this.#root }),
        features: JSON.stringify(features),
        source_state_fingerprint: capture.end_fingerprint,
      } satisfies SourceProviderDescribeResult;
    });
  }

  enumerate(request: SourceProviderRequestEnvelope): Promise<SourceProviderResponseEnvelope> {
    return executeProviderCall(request, "enumerate", this.#requestExpectations, this.#runtime, async (budget) => {
      const payload = parseProviderPayload<SourceProviderEnumerateRequest>(request);
      const scopes = parseScopes(payload, request.source_provider_binding_id, this.#providerKind);
      const capture = await this.#capture(scopes.map((scope) => scope.normalized_scope_key));
      if (!capture.stable) throw new SourceProviderOutcomeError("source_changed", "core:source_changed", "retryable", "The source changed during enumeration.");
      return this.#enumerationPayload(request, payload.previous_watermark, scopes, capture, budget, "scan", true, true);
    });
  }

  read(request: SourceProviderRequestEnvelope): Promise<SourceProviderResponseEnvelope> {
    return executeProviderCall(request, "read", this.#requestExpectations, this.#runtime, async () => {
      const payload = parseProviderPayload<SourceProviderReadRequest>(request);
      const uri = normalizeWorkspacePath(this.#root, payload.normalized_uri);
      if (uri !== payload.normalized_uri || uri.length === 0) throw new SourceProviderOutcomeError("failed", "core:source_provider_uri_invalid", "never", "The normalized URI is invalid.");
      const path = resolve(this.#root, uri);
      if (!isWithinRoot(this.#root, path)) throw new SourceProviderOutcomeError("failed", "core:source_provider_uri_invalid", "never", "The normalized URI escapes the root.");
      try {
        const before = await this.#inspectBoundary(uri, path);
        if (!before.included) throw new SourceProviderOutcomeError("failed", "core:source_provider_artifact_ineligible", "never", "The requested URI is not an eligible source artifact.");
        if (before.token !== payload.provider_version_token || before.metadata_digest !== payload.observed_metadata_digest) {
          throw new SourceProviderOutcomeError("source_changed", "core:source_changed", "retryable", "The observed occurrence changed before reading.");
        }
        const bytes = await this.#fileSystem.read_file(before.target_path);
        if (!this.#included(uri, before, bytes)) throw new SourceProviderOutcomeError("failed", "core:source_provider_artifact_ineligible", "never", "The requested URI is not an eligible source artifact.");
        const after = await this.#inspectBoundary(uri, path, bytes);
        const contentHash = rawDigest(bytes);
        if (!after.included || before.token !== after.token || after.token !== payload.provider_version_token || contentHash !== payload.observed_content_hash) {
          throw new SourceProviderOutcomeError("source_changed", "core:source_changed", "retryable", "The observed occurrence changed while reading.");
        }
        return {
          artifact_id: payload.artifact_id,
          provider_version_token: after.token,
          content_bytes: Buffer.from(bytes).toString("base64"),
          content_hash: contentHash,
          byte_length: bytes.byteLength,
          metadata_digest: after.metadata_digest,
        } satisfies SourceProviderReadResult;
      } catch (error) {
        if (error instanceof SourceProviderOutcomeError) throw error;
        if (errorCode(error) === "ENOENT") throw new SourceProviderOutcomeError("source_changed", "core:source_changed", "retryable", "The observed occurrence is no longer present.");
        return unavailable(error);
      }
    });
  }

  watch(request: SourceProviderRequestEnvelope): Promise<SourceProviderResponseEnvelope> {
    return executeProviderCall(request, "watch", this.#requestExpectations, this.#runtime, async (budget) => {
      const payload = parseProviderPayload<SourceProviderWatchRequest>(request);
      parseScopes(payload, request.source_provider_binding_id, this.#providerKind);
      if (budget.max_watch_events < 0) throw new SourceProviderOutcomeError("resource_exhausted", "core:source_provider_watch_exhausted", "retryable", "The watch budget was exhausted.");
      return { events: [], watermark: payload.after_watermark ?? "" } satisfies SourceProviderWatchResult;
    });
  }

  reconcile(request: SourceProviderRequestEnvelope): Promise<SourceProviderResponseEnvelope> {
    return executeProviderCall(request, "reconcile", this.#requestExpectations, this.#runtime, async (budget) => {
      const payload = parseProviderPayload<SourceProviderEnumerateRequest>(request);
      const scopes = parseScopes(payload, request.source_provider_binding_id, this.#providerKind);
      const capture = await this.#capture(scopes.map((scope) => scope.normalized_scope_key));
      const result = this.#enumerationPayload(request, payload.previous_watermark, scopes, capture, budget, "reconciliation", capture.stable, capture.stable) as Record<string, JsonValue>;
      return { ...result, stable: capture.stable };
    });
  }

  async #capture(scopeKeys: readonly string[]): Promise<Capture> {
    // The stability proof reads every eligible file's bytes twice (this pass,
    // then again below) to prove nothing changed between the two passes. The
    // first pass retains full bytes (needed if the capture is stable); the
    // second is digest-only (content hash + tokens, no byte buffers kept), so
    // the two passes never hold two complete copies of the tree in memory at
    // once. When stable, the two passes' content hashes agree by definition,
    // so the returned files carry the first pass's already-resident bytes.
    const first = await this.#inventory(scopeKeys, false);
    const second = await this.#inventory(scopeKeys, true);
    const firstByUri = new Map(first.files.map((file) => [file.uri, file] as const));
    const files = second.files.map((file) => {
      const prior = firstByUri.get(file.uri);
      return prior !== undefined && prior.content_hash === file.content_hash ? { ...file, bytes: prior.bytes } : file;
    });
    return {
      files,
      start_fingerprint: first.before_fingerprint,
      end_fingerprint: second.after_fingerprint,
      stable: first.internally_stable && second.internally_stable && first.after_fingerprint === second.before_fingerprint,
    };
  }

  async #inventory(scopeKeys: readonly string[], digestOnly: boolean): Promise<Inventory> {
    const files: CapturedFile[] = [];
    try {
      for (const scopeKey of [...new Set(scopeKeys)].sort()) {
        const normalizedScope = normalizeWorkspacePath(this.#root, scopeKey);
        await this.#walk(normalizedScope, files, digestOnly);
      }
    } catch (error) {
      return unavailable(error);
    }
    const unique = [...new Map(files.map((file) => [file.uri, file])).values()].sort((left, right) => left.uri.localeCompare(right.uri));
    return {
      files: unique,
      before_fingerprint: jsonDigest(unique.map((file) => [file.uri, file.token_before])),
      after_fingerprint: jsonDigest(unique.map((file) => [file.uri, file.token_after])),
      internally_stable: unique.every((file) => file.token_before === file.token_after),
    };
  }

  async #walk(relativePath: string, files: CapturedFile[], digestOnly: boolean): Promise<void> {
    const absolute = resolve(this.#root, relativePath);
    if (!isWithinRoot(this.#root, absolute)) throw new SourceProviderOutcomeError("failed", "core:source_provider_uri_invalid", "never", "The coverage scope escapes the provider root.");
    const rootStat = await this.#fileSystem.lstat(absolute);
    if (!rootStat.is_directory) {
      await this.#captureFile(relativePath, absolute, rootStat, files, digestOnly);
      return;
    }
    const entries = [...await this.#fileSystem.read_directory(absolute)].sort((left, right) => left.name.localeCompare(right.name));
    // Bounded-concurrency fan-out over this directory's own entries (see
    // `io_concurrency` above). `files` is a single array shared across the
    // whole walk and appended to from concurrent tasks; since every entry in
    // one directory listing names a distinct child path (and recursion only
    // ever explores disjoint subtrees), no two concurrent pushes can ever
    // target the same logical file, so push order does not matter -- the
    // caller (`#inventory`) dedups by URI and sorts afterward regardless.
    await mapWithConcurrency(entries, this.#ioConcurrency, async (entry) => {
      const child = normalizeWorkspacePath(this.#root, relativePath.length === 0 ? entry.name : `${relativePath}/${entry.name}`);
      if (child === ".git" || child.startsWith(".git/") || child === ".urdira" || child.startsWith(".urdira/")) return;
      const childPath = resolve(this.#root, child);
      const childStat = await this.#fileSystem.lstat(childPath);
      if (childStat.is_directory && !childStat.is_symbolic_link) await this.#walk(child, files, digestOnly);
      else await this.#captureFile(child, childPath, childStat, files, digestOnly);
    });
  }

  async #captureFile(uri: string, path: string, initial: DirectoryFileStat, files: CapturedFile[], digestOnly: boolean): Promise<void> {
    if (initial.is_directory || initial.is_special) return;
    const before = await this.#inspectBoundary(uri, path);
    if (!before.included) return;
    const bytes = await this.#fileSystem.read_file(before.target_path);
    if (!this.#included(uri, before, bytes)) return;
    const after = await this.#inspectBoundary(uri, path, bytes);
    files.push({
      uri,
      ...(digestOnly ? {} : { bytes }),
      content_hash: rawDigest(bytes),
      metadata_digest: before.metadata_digest,
      token_before: before.token,
      token_after: after.included ? after.token : `ineligible:${after.token}`,
    });
  }

  async #inspectBoundary(uri: string, path: string, bytes?: Uint8Array): Promise<FileBoundary> {
    const linkStat = await this.#fileSystem.lstat(path);
    if (linkStat.is_symbolic_link && this.#inclusion.follow_symlinks !== true) {
      const identity = { link: metadata(linkStat), target: null, target_path: path };
      return {
        included: false,
        link_stat: linkStat,
        target_path: path,
        target_stat: linkStat,
        token: jsonDigest(identity),
        metadata_digest: jsonDigest(identity),
      };
    }
    const targetPath = canonicalizePath(await this.#fileSystem.real_path(path));
    const targetStat = await this.#fileSystem.stat(path);
    const identity = {
      link: metadata(linkStat),
      target: metadata(targetStat),
      target_path: targetPath,
    };
    const boundary: FileBoundary = {
      included: false,
      link_stat: linkStat,
      target_path: targetPath,
      target_stat: targetStat,
      token: jsonDigest(identity),
      metadata_digest: jsonDigest(identity),
    };
    return { ...boundary, included: this.#included(uri, boundary, bytes ?? new Uint8Array()) };
  }

  #included(uri: string, boundary: FileBoundary, bytes: Uint8Array): boolean {
    const outsideWorkspace = !isWithinRoot(this.#root, boundary.target_path);
    const approvedExternal = (this.#inclusion.allowed_external_roots ?? [])
      .map(canonicalizePath)
      .some((root) => isWithinRoot(root, boundary.target_path));
    const traversedSymlink = boundary.link_stat.is_symbolic_link
      || !sameCanonicalArtifactPath(resolve(this.#root, uri), boundary.target_path);
    return evaluateInclusion({
      normalized_path: uri,
      is_symlink: traversedSymlink,
      is_directory: boundary.target_stat.is_directory,
      byte_length: boundary.target_stat.size,
      media_type: mediaType(uri, bytes),
      outside_allowed_root: outsideWorkspace && !(this.#inclusion.allow_external_root === true && approvedExternal),
      is_special: boundary.link_stat.is_special || boundary.target_stat.is_special,
    }, this.#inclusion, this.#gitignore).included;
  }

  #enumerationPayload(
    request: SourceProviderRequestEnvelope,
    previousWatermark: string | undefined,
    scopes: readonly ObservationCoverageScope[],
    capture: Capture,
    budget: SourceProviderResourceBudget,
    observationMode: "scan" | "reconciliation",
    stable: boolean,
    mayAuthorizeDeletion: boolean,
  ): JsonValue {
    if (capture.files.length > budget.max_observations) throw new SourceProviderOutcomeError("resource_exhausted", "core:source_provider_observations_exhausted", "retryable", "The observation budget was exhausted.");
    const fullCoverage = scopes.length === 1 && scopes[0]?.normalized_scope_key === "";
    const watermark = `watermark:${capture.end_fingerprint}`;
    const observationsWithoutBatchId: Omit<ProviderObservation, "observation_batch_id">[] = capture.files.map((file) => ({
      source_observation_id: jsonDigest({ binding: request.source_provider_binding_id, uri: file.uri, watermark }),
      workspace_id: request.workspace_id,
      artifact_id: sourceProviderArtifactId(request.workspace_id, file.uri),
      source_provider_binding_id: request.source_provider_binding_id,
      source_provider: this.#providerKind,
      source_provider_version: this.#providerVersion,
      ordering_domain: request.source_provider_binding_id,
      observation_mode: observationMode,
      observed_state: "present",
      observed_content_hash: file.content_hash,
      observed_metadata_digest: file.metadata_digest,
      provider_event_token: file.token_after,
      provider_sequence: watermark,
      observed_at: this.#runtime.now(),
      received_at: this.#runtime.now(),
      normalized_uri: file.uri,
      provider_version_token: file.token_after,
    }));
    const batchCore = {
      workspace_id: request.workspace_id,
      source_provider_binding_id: request.source_provider_binding_id,
      source_provider: this.#providerKind,
      source_provider_version: this.#providerVersion,
      ordering_domain: request.source_provider_binding_id,
      observation_mode: observationMode,
      coverage_scopes: JSON.stringify(scopes),
      coverage_completeness: stable && fullCoverage ? "complete" : "partial",
      deletion_authority: stable && fullCoverage && mayAuthorizeDeletion ? "authoritative" : "none",
      provider_cursor_before: previousWatermark ?? "",
      provider_cursor_after: watermark,
      started_at: this.#runtime.now(),
      completed_at: this.#runtime.now(),
      observation_count: observationsWithoutBatchId.length,
      unavailable_count: 0,
    };
    const batchDigest = sourceObservationBatchDigest(batchCore, observationsWithoutBatchId);
    const observationBatchId = jsonDigest({ batch_digest: batchDigest, binding: request.source_provider_binding_id });
    const batch: SourceObservationBatch = { observation_batch_id: observationBatchId, ...batchCore, batch_digest: batchDigest };
    const observations: ProviderObservation[] = observationsWithoutBatchId.map((observation) => ({ ...observation, observation_batch_id: observationBatchId }));
    const encoded: EncodedObservationBatch = { batch, observations };
    return {
      observation_batch: JSON.stringify(encoded),
      watermark,
      capture_start_fingerprint: capture.start_fingerprint,
      capture_end_fingerprint: capture.end_fingerprint,
    };
  }
}
