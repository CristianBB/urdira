import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
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
import { digestLogicalValue } from "@urdira/canonical";
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
  /** Optional native chunk source; test filesystems may omit it. */
  read_file_stream?(path: string): AsyncIterable<Uint8Array>;
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
  read_file_stream(path: string): AsyncIterable<Uint8Array> {
    return (async function* (): AsyncGenerator<Uint8Array> {
      for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
        yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      }
    })();
  },
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
  /**
   * Optional observer (P3-3b) invoked with a file's complete decoded text
   * exactly once, ONLY for a file whose bytes arrived via the P3-3a prefetch
   * hand-off (`#startPrefetch`/`#prefetchPromises`) AND whose content is
   * proven unchanged since enumerate (called from inside `readStream`'s
   * `after_read`, i.e. strictly AFTER CAS's own hash has already matched
   * `observed_content_hash` -- never called with content that might not
   * match what enumerate actually observed, which would poison a caller's
   * derived cache). Never called for a NUL-containing or invalid-UTF-8 file,
   * or for a file the hand-off did not admit (over budget, budget disabled,
   * or a prefetch read that itself failed) -- those silently fall back to
   * whatever the caller does when it never sees this uri. Must not throw;
   * any failure here is swallowed and never affects the read itself -- this
   * is purely an optimization hook, never a contract.
   */
  readonly on_prefetched_text?: (uri: string, text: string) => void;
}

export interface ProviderObservation extends SourceObservation {
  readonly normalized_uri: string;
  readonly provider_version_token: string;
}

export interface EncodedObservationBatch {
  readonly batch: SourceObservationBatch;
  readonly observations: readonly ProviderObservation[];
}

export interface NativeDirectoryEnumeration {
  readonly response: SourceProviderResponseEnvelope;
  readonly batches: AsyncIterable<EncodedObservationBatch>;
  /** True when the enumeration is a safe changed-file-only capture. */
  readonly incremental: boolean;
}

/** Native internal source boundary. The stream is consumed exactly once. */
export interface DirectorySourceByteStream {
  readonly artifact_id: string;
  readonly provider_version_token: string;
  readonly content_hash: string;
  readonly byte_length: number;
  readonly metadata_digest: string;
  readonly media_type: string;
  readonly chunks: AsyncIterable<Uint8Array>;
  /** Called by CAS after its single authoritative hash pass completes. */
  readonly after_read?: (contentHash: string, byteLength: number) => Promise<void>;
  /** True when the provider validated the stable token and reused the existing CAS blob. */
  readonly reused_existing?: boolean;
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

// Generated comparison baselines are not source artifacts. Excluding them by
// default keeps source-first indexing focused on executable/declarative code;
// callers can still opt in explicitly with an include rule. This is the
// single workspace policy reused by scans, forks, and filesystem watchers.
export const DEFAULT_WORKSPACE_INCLUSION: InclusionRules = { include: [], exclude: ["node_modules/**", ".git/**", "dist/**", "coverage/**", "test-results/**", "tests/baselines/**", "tests/cases/**", ".urdira/**"], allow_external_root: false };
const DEFAULT_INCLUSION: InclusionRules = DEFAULT_WORKSPACE_INCLUSION;
const DEFAULT_GITIGNORE: GitIgnoreRules = { enabled: false, patterns: [] };
// The walk is metadata/hash I/O bound. Sixteen lanes keep directory
// enumeration overlapped with the Rust hand-off without creating a second
// source pipeline or retaining more than the bounded prefetch window.
const DEFAULT_WALK_CONCURRENCY = 16;
const BINARY_EXTENSIONS = new Set([".7z", ".avi", ".bin", ".bmp", ".class", ".dll", ".dylib", ".eot", ".exe", ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".mov", ".mp3", ".mp4", ".o", ".pdf", ".png", ".so", ".tar", ".wasm", ".webp", ".woff", ".woff2", ".zip"]);

// Bounded enumerate->catalog byte hand-off (docs: P3-3a). A from-zero catalog
// pass used to pay two full-file passes back to back: enumerate's `#digestFile`
// streams every file once (hash/has_nul/valid_utf8/byte_length) and discards
// the bytes, then `readStream` (below) lazily re-opens and re-streams the SAME
// bytes only when CAS actually consumes its `chunks` generator, strictly AFTER
// `readStream`'s own await returns -- so nothing ever reads file N+1 while CAS
// is still writing file N. `#startPrefetch` closes that gap: once enumerate's
// full file list is known, it reads ahead of CAS consumption with bounded
// concurrency and a bounded LIVE-byte budget (not a total-bytes-ever budget --
// see `BudgetGate`), so up to `PREFETCH_CONCURRENCY` files' disk reads overlap
// with whatever the rest of the pipeline (CAS hash/write/fsync, SQL) is doing
// for earlier files, instead of happening strictly after it. A single file
// larger than the whole budget is never admitted and falls back to today's
// lazy per-chunk streaming unchanged -- the hand-off is an optimization, never
// a contract. `URDIRA_CATALOG_HANDOFF_BYTES=0` disables it entirely.
//
// BUDGET OWNERSHIP CONTRACT (read this before touching `#startPrefetch`,
// `#prefetchPromises`, `BudgetGate`, or `readStream`'s prefetch-hit branch):
// `BudgetGate` bounds only the "parked, unclaimed" window -- bytes a prefetch
// worker has already read into memory but that no `readStream` call has yet
// taken ownership of -- NEVER the window from claim through CAS's own
// hash/write/fsync/commit. A worker's `gate.acquire(n)` (inside the IIFE
// stored in `#prefetchPromises`) is released the INSTANT `readStream` claims
// that entry (`gate.release` is called synchronously in the prefetch-hit
// branch, right after `await prefetched` resolves, BEFORE returning the
// stream object to the caller) -- unconditionally, regardless of what the
// caller does with the returned stream afterward (pushes it into a commit,
// discards it because the observation turned out `equivalent`, the
// observation's own validation fails, the fragment's commit itself later
// fails, `chunks` never gets iterated, etc). This is deliberate and load
// bearing: an EARLIER design released budget from `after_read` (fired only
// once CAS's `putStreamsMany` actually consumes `chunks`, i.e. only once the
// content is durably committed) -- but `source-indexer.ts#readAll` reads an
// ENTIRE fragment's observations (bounded concurrency, but ALL of them)
// before that fragment's commit (and therefore before any `after_read`) ever
// runs. So a still-registered-but-not-yet-acquired prefetch entry for a uri
// IN THAT SAME FRAGMENT could never be unblocked: the only thing that could
// free its budget (the fragment's own commit) was itself waiting on
// `readAll` to finish, which was waiting on that same blocked `gate.acquire`
// -- a structural circular wait, not a probabilistic race, that reliably
// wedges any real scan once the budget fills before a fragment's `readAll`
// drains (small fixtures never accumulate enough parked bytes to hit this;
// a real multi-thousand-file tree does). Releasing at CLAIM time instead
// makes every pending `gate.acquire()` depend only on OTHER `readStream`
// calls landing -- which always happens, since nothing downstream of
// `readStream` can itself block on this gate -- so a pending acquire is now
// STRUCTURALLY guaranteed to eventually unblock. The bytes stay alive in
// memory from claim through CAS's write (referenced by the
// `content_streams`/`contents` arrays `source-indexer.ts#applyBatch`
// builds), but that footprint is bounded by a fragment's own row cap
// (`maxRows`/`SOURCE_INDEX_BATCH_MAX_ROWS`) times `io_concurrency`, entirely
// independent of this gate. `after_read` keeps its OWN, unrelated job:
// proving (via CAS's authoritative post-write hash) that the bytes handed
// off are still exactly what enumerate observed, and firing
// `on_prefetched_text` only once that proof holds -- neither of which ever
// depended on when budget was released.
//
// A SECOND, independent bug compounds the above at real scale and is fixed
// alongside it (see `BudgetGate`'s own doc comment): the gate's original
// `acquire` admitted a fresh request whenever `#used` alone allowed it,
// without checking whether anyone was already queued. Under the sustained
// high-concurrency churn a multi-thousand-file scan produces (many lanes
// each finishing one tiny acquire and immediately issuing the next), a
// fresh request can repeatedly "cut in line" ahead of an already-queued
// one, starving it forever even though the gate's overall throughput looks
// fine -- a livelock, not a hang, and just as fatal to a real scan (proven
// live: fixing only the claim-time release above still wedged a multi-file
// repro on 4 permanently-starved entries). `BudgetGate` is now strictly
// FIFO so a queued waiter's position is a guarantee.
const PREFETCH_CONCURRENCY = 8;
const DEFAULT_CATALOG_HANDOFF_BYTES = 64 * 1024 * 1024;

function catalogHandoffBudgetBytes(): number {
  const raw = process.env["URDIRA_CATALOG_HANDOFF_BYTES"];
  if (raw === undefined || raw === "") return DEFAULT_CATALOG_HANDOFF_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CATALOG_HANDOFF_BYTES;
  return Math.trunc(parsed);
}

/**
 * Tracks LIVE (not cumulative) hand-off bytes: `acquire` only blocks when
 * something is already using budget AND admitting the new request would
 * exceed capacity, so a single file bigger than the whole budget still gets
 * admitted when nothing else is in flight (never deadlocks) -- callers that
 * want such files to fall back instead must check size against capacity
 * themselves before calling `acquire` (see `#startPrefetch`).
 *
 * STRICTLY FIFO-FAIR: a fresh `acquire` call that arrives while ANYONE is
 * already queued always joins the back of the queue, even if the current
 * `#used` would otherwise admit it immediately. An earlier version checked
 * only `#used` (never the queue), so a fresh request could "cut in line"
 * ahead of an already-queued one whenever it happened to arrive at a moment
 * with enough momentary headroom -- under sustained high-concurrency churn
 * (many callers repeatedly finishing one small acquire and immediately
 * issuing the next), this reliably STARVED whichever request was already
 * queued: it would be woken, re-check, find a later-arriving fresh request
 * had already claimed the just-freed room first, and re-queue -- forever,
 * for specific requests, while overall throughput looked fine. `release`
 * now hands freed budget directly to the front of the queue (see `#pump`)
 * instead of merely "waking" it to re-race everyone else, so a queued
 * waiter's position is a real guarantee, not a hint.
 */
class BudgetGate {
  readonly #capacity: number;
  #used = 0;
  #waiters: { readonly bytes: number; readonly resolve: () => void }[] = [];
  constructor(capacity: number) { this.#capacity = capacity; }
  tryAcquire(bytes: number): boolean {
    if (this.#waiters.length > 0 || (this.#used > 0 && this.#used + bytes > this.#capacity)) return false;
    this.#used += bytes;
    return true;
  }
  async acquire(bytes: number): Promise<void> {
    // Fair-queue check: admit immediately ONLY when nobody is already ahead
    // in line AND (nothing else is in flight OR this request fits) --
    // otherwise queue behind whoever is already waiting, even if `#used`
    // alone would seem to allow it.
    if (this.#waiters.length === 0 && (this.#used === 0 || this.#used + bytes <= this.#capacity)) {
      this.#used += bytes;
      return;
    }
    await new Promise<void>((resolve) => { this.#waiters.push({ bytes, resolve }); });
  }
  release(bytes: number): void {
    this.#used = Math.max(0, this.#used - bytes);
    this.#pump();
  }
  /** Grants freed budget to queued waiters strictly in arrival order, stopping at the first one that still doesn't fit. */
  #pump(): void {
    while (this.#waiters.length > 0) {
      const front = this.#waiters[0]!;
      if (this.#used > 0 && this.#used + front.bytes > this.#capacity) return;
      this.#waiters.shift();
      this.#used += front.bytes;
      front.resolve();
    }
  }
}

interface CapturedFileMetadata {
  readonly target_path: string;
  readonly byte_length: number;
  readonly has_nul: boolean;
  readonly valid_utf8: boolean;
  /**
   * The exact `FileBoundary` `#captureFile`'s own post-digest re-inspection
   * (its "after" `#inspectBoundary` call, proving nothing changed on disk
   * while `#digestFile` was reading the file) already computed for this uri.
   * `readStream` (below) reuses this AS-IS as its own "before" boundary
   * instead of paying a fresh lstat/realpath/stat for a uri it already has
   * an enumerate-time proof point for -- see `readStream`'s doc comment for
   * why this does not shrink what gets proven.
   */
  readonly boundary: FileBoundary;
}

interface PrefetchedContent {
  readonly bytes: Uint8Array;
  readonly byte_length: number;
  // The exact amount `gate.acquire`d for this entry (the digest pass's
  // declared `meta.byte_length`, NOT necessarily `byte_length` above, which
  // is however many bytes the prefetch worker's own read actually produced
  // -- they can differ if the file's size changed between the digest pass
  // and the prefetch read). `readStream` releases exactly this amount so
  // acquired and released bytes always balance even under that race; a
  // mismatch here would either double-count freed capacity (release too
  // much) or permanently strand budget (release too little).
  readonly reserved_bytes: number;
}

function concatChunks(chunks: readonly Uint8Array[], totalLength: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return merged;
}

function jsonDigest(value: unknown): string {
  return digestLogicalValue(value);
}

function rawDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Provider version tokens bind both the filesystem boundary and exact bytes. */
function contentVersionToken(boundaryToken: string, contentHash: string): string {
  return jsonDigest({ boundary_token: boundaryToken, content_hash: contentHash });
}

/** Incremental logical digest for large ordered metadata collections. */
function digestFields(fields: readonly string[]): string {
  const hash = createHash("sha256");
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    hash.update(Buffer.from(`${bytes.byteLength}:`, "ascii"));
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
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
  // Cheap per-uri metadata retained for EVERY file enumerate observes (see the
  // hand-off doc comment above `PREFETCH_CONCURRENCY`) -- never bytes, so this
  // is bounded by file COUNT, not corpus size, and safe to keep for a whole
  // scan's lifetime. `readStream` reuses `has_nul`/`valid_utf8` for a
  // prefetch-hit file instead of re-deriving them from re-read bytes, and
  // reuses `boundary` as its own "before" boundary instead of a fresh
  // lstat/realpath/stat: safe because whatever content actually reaches CAS
  // is independently re-hashed there against `observed_content_hash`
  // regardless (see `readStream`), so reused metadata for a file that
  // changed between passes can only ever accompany an already-rejected
  // (`source_changed`) read.
  readonly #metadataCache = new Map<string, CapturedFileMetadata>();
  #prefetchGate: BudgetGate | undefined;
  #prefetchAborted = false;
  readonly #prefetchPromises = new Map<string, Promise<PrefetchedContent | undefined>>();
  readonly #onPrefetchedText: ((uri: string, text: string) => void) | undefined;

  constructor(options: DirectorySourceProviderOptions) {
    this.#root = canonicalizePath(options.root);
    this.#onPrefetchedText = options.on_prefetched_text;
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

  /**
   * Internal in-process enumeration. It keeps the validated batch as
   * structured metadata and deliberately omits the giant JSON observation
   * string used only by the public provider contract.
   */
  enumerateNative(request: SourceProviderRequestEnvelope): Promise<SourceProviderResponseEnvelope> {
    return executeProviderCall(request, "enumerate", this.#requestExpectations, this.#runtime, async (budget) => {
      const payload = parseProviderPayload<SourceProviderEnumerateRequest>(request);
      const scopes = parseScopes(payload, request.source_provider_binding_id, this.#providerKind);
      const capture = await this.#capture(scopes.map((scope) => scope.normalized_scope_key));
      if (!capture.stable) throw new SourceProviderOutcomeError("source_changed", "core:source_changed", "retryable", "The source changed during enumeration.");
      const result = this.#enumerationRecord(request, payload.previous_watermark, scopes, capture, budget, "scan", true, true);
      return { native_observation_batch: result.encoded as unknown as JsonValue, watermark: result.watermark, capture_start_fingerprint: result.capture_start_fingerprint, capture_end_fingerprint: result.capture_end_fingerprint } as unknown as JsonValue;
    });
  }

  /**
   * Native in-process source boundary with bounded observation delivery. The
   * response envelope contains only control metadata; observations are yielded
   * as partial fragments and a final empty complete fragment so the core can
   * apply deletion authority without constructing a giant response payload.
   */
  async enumerateNativeBatches(request: SourceProviderRequestEnvelope, options?: { readonly changed_uris?: readonly string[]; readonly allow_empty_incremental?: boolean }): Promise<NativeDirectoryEnumeration> {
    let capture: Capture | undefined;
    let budgetMaxObservations = 0;
    let incremental = false;
    const response = await executeProviderCall(request, "enumerate", this.#requestExpectations, this.#runtime, async (budget) => {
      const payload = parseProviderPayload<SourceProviderEnumerateRequest>(request);
      const scopes = parseScopes(payload, request.source_provider_binding_id, this.#providerKind);
      const changedUris = options?.changed_uris?.filter((uri) => typeof uri === "string" && uri.length > 0) ?? [];
      if (changedUris.length > 0) {
        const changedCapture = await this.#captureChangedUris(changedUris);
        if (changedCapture !== undefined) {
          capture = changedCapture;
          incremental = true;
        } else {
          // A missing path, directory event, excluded file, or unstable
          // boundary cannot authorize an incremental publication. Fall back
          // to the existing complete capture so deletion/rename handling
          // remains authoritative and safe.
          capture = await this.#capture(scopes.map((scope) => scope.normalized_scope_key), true);
        }
      } else if (options?.allow_empty_incremental === true) {
        const emptyFingerprint = digestFields([]);
        capture = { files: [], start_fingerprint: emptyFingerprint, end_fingerprint: emptyFingerprint, stable: true };
        incremental = true;
      } else {
        capture = await this.#capture(scopes.map((scope) => scope.normalized_scope_key), true);
      }
      if (!capture.stable) throw new SourceProviderOutcomeError("source_changed", "core:source_changed", "retryable", "The source changed during enumeration.");
      if (capture.files.length > budget.max_observations) throw new SourceProviderOutcomeError("resource_exhausted", "core:source_provider_observations_exhausted", "retryable", "The observation budget was exhausted.");
      budgetMaxObservations = budget.max_observations;
      return { native_stream: true, watermark: `watermark:${capture.end_fingerprint}`, capture_start_fingerprint: capture.start_fingerprint, capture_end_fingerprint: capture.end_fingerprint };
    });
    const captured = capture;
    // Started here, before any batch is even encoded, so prefetch always has
    // the maximum possible head start on the `readStream` calls the caller
    // will make once it starts consuming `batches`. Restricted to a complete
    // (non-incremental) capture: an incremental rescan's changed-file set is
    // typically tiny, so the fixed prefetch machinery buys little there and
    // this keeps the hand-off scoped to the from-zero/full-scan case it was
    // built for.
    if (!incremental && response.outcome === "success" && captured !== undefined) this.#startPrefetch(captured.files);
    const batches = (async function* (provider: DirectorySourceProvider): AsyncGenerator<EncodedObservationBatch> {
      if (response.outcome !== "success" || captured === undefined) return;
      const payload = request.payload as unknown as SourceProviderEnumerateRequest;
      const scopes = parseScopes(payload, request.source_provider_binding_id, provider.#providerKind);
      const maxRows = 4096;
      if (incremental) {
        const part = provider.#enumerationRecord(request, payload.previous_watermark, scopes, captured, { max_observations: budgetMaxObservations } as SourceProviderResourceBudget, "scan", true, false);
        yield part.encoded;
        return;
      }
      for (let offset = 0, fragment = 0; offset < captured.files.length; fragment += 1) {
        const files = captured.files.slice(offset, offset + maxRows);
        offset += files.length;
        const part = provider.#enumerationRecord(request, payload.previous_watermark, scopes, { ...captured, files }, { max_observations: budgetMaxObservations } as SourceProviderResourceBudget, "scan", true, false);
        yield part.encoded;
      }
      const completion = provider.#enumerationRecord(request, payload.previous_watermark, scopes, { ...captured, files: [] }, { max_observations: budgetMaxObservations } as SourceProviderResourceBudget, "scan", true, true);
      yield completion.encoded;
    })(this);
    return { response, batches, incremental };
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
        if (contentVersionToken(before.token, payload.observed_content_hash) !== payload.provider_version_token || before.metadata_digest !== payload.observed_metadata_digest) {
          throw new SourceProviderOutcomeError("source_changed", "core:source_changed", "retryable", "The observed occurrence changed before reading.");
        }
        const bytes = await this.#fileSystem.read_file(before.target_path);
        if (!this.#included(uri, before, bytes)) throw new SourceProviderOutcomeError("failed", "core:source_provider_artifact_ineligible", "never", "The requested URI is not an eligible source artifact.");
        const after = await this.#inspectBoundary(uri, path, bytes);
        const contentHash = rawDigest(bytes);
        if (!after.included || before.token !== after.token || contentVersionToken(after.token, contentHash) !== payload.provider_version_token || contentHash !== payload.observed_content_hash) {
          throw new SourceProviderOutcomeError("source_changed", "core:source_changed", "retryable", "The observed occurrence changed while reading.");
        }
        return {
          artifact_id: payload.artifact_id,
          provider_version_token: payload.provider_version_token,
          content: bytes,
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

  /**
   * Internal native path used by the source indexer. Unlike the JSON/provider
   * response, it never assembles the file or converts it to text: a consumer
   * streams the chunks directly into CAS, which performs the final hash and
   * length check while consuming them -- EXCEPT when `#startPrefetch` already
   * read this uri's bytes ahead of time (see `#prefetchPromises`, below),
   * in which case `chunks` yields the already-in-memory buffer as a single
   * chunk instead of lazily re-opening the file. Either way CAS still
   * independently hashes whatever bytes it receives against
   * `observed_content_hash` (unchanged verification chain); a prefetch hit
   * only changes WHEN those bytes were read, never what proves they are
   * still correct. `after_read` (below) still re-stats after CAS's read
   * completes, exactly as before the hand-off -- what changes is the window
   * that re-stat proves stable: it used to bound only "this call's own lazy
   * read", and now bounds "enumerate's original observation through commit",
   * a LONGER window than before, not a weaker proof (the enumerate-time
   * digest and this same post-read re-stat are the two ends of the proof
   * either way).
   *
   * The "before" boundary itself (below) is, for the same reason, ALSO
   * reused from enumerate rather than freshly lstat/realpath/stat'd here when
   * `#metadataCache` has an entry for this uri: `#captureFile`'s own
   * post-digest re-inspection already produced exactly this proof point
   * ("disk matched this token as of enumerate"), so a THIRD stat call here,
   * strictly between that proof and `after_read`'s fresh one, would only ever
   * re-confirm what enumerate already confirmed on a stable file -- and on an
   * UNSTABLE one (disk changed between enumerate and this call), skipping it
   * costs nothing either: `after_read`'s fresh re-inspection below still
   * independently re-derives the boundary from the live filesystem and still
   * requires it to match this reused `before.token` exactly, so any such
   * change is still caught, just at the end of the read instead of before it
   * starts -- the window actually PROVEN correct (enumerate's own post-digest
   * observation through commit) is unchanged either way. Excluded from this
   * reuse: `options.reuse_existing === true` calls, which return without any
   * `after_read` follow-up at all (see below) -- for those the entry check
   * right below IS the only verification, so it always uses a fresh
   * boundary. A uri `#metadataCache` never saw (incremental rescans,
   * watcher-driven reads, `metadataOnly` capture passes) falls back to the
   * original fresh inspect unchanged.
   */
  async readStream(input: SourceProviderReadRequest, options: { readonly reuse_existing?: boolean } = {}): Promise<DirectorySourceByteStream> {
    const uri = normalizeWorkspacePath(this.#root, input.normalized_uri);
    if (uri !== input.normalized_uri || uri.length === 0) throw new SourceProviderOutcomeError("failed", "core:source_provider_uri_invalid", "never", "The normalized URI is invalid.");
    const path = resolve(this.#root, uri);
    if (!isWithinRoot(this.#root, path)) throw new SourceProviderOutcomeError("failed", "core:source_provider_uri_invalid", "never", "The normalized URI escapes the root.");
    const before = options.reuse_existing === true
      ? await this.#inspectBoundary(uri, path)
      : this.#metadataCache.get(uri)?.boundary ?? await this.#inspectBoundary(uri, path);
    if (!before.included) throw new SourceProviderOutcomeError("failed", "core:source_provider_artifact_ineligible", "never", "The requested URI is not an eligible source artifact.");
    if (contentVersionToken(before.token, input.observed_content_hash) !== input.provider_version_token || before.metadata_digest !== input.observed_metadata_digest) {
      throw new SourceProviderOutcomeError("source_changed", "core:source_changed", "retryable", "The observed occurrence changed before reading.");
    }
    if (options.reuse_existing === true) {
      // The enumeration already proved the content digest. The provider token
      // is the stable version boundary; rechecking it and the exact stat-derived
      // metadata here avoids opening/reading unchanged bytes on a full reindex.
      return {
        artifact_id: input.artifact_id,
        provider_version_token: input.provider_version_token,
        content_hash: input.observed_content_hash,
        byte_length: before.target_stat.size,
        metadata_digest: before.metadata_digest,
        media_type: BINARY_EXTENSIONS.has(extname(uri).toLowerCase()) ? "application/octet-stream" : "text/plain; charset=utf-8",
        reused_existing: true,
        chunks: (async function* (): AsyncGenerator<Uint8Array> { })(),
      };
    }
    const prefetched = this.#prefetchPromises.get(uri);
    if (prefetched !== undefined) {
      this.#prefetchPromises.delete(uri);
      const content = await prefetched;
      if (content !== undefined) {
        // `meta` is always present here: `#startPrefetch` only ever creates a
        // `#prefetchPromises` entry for a uri already in `#metadataCache`.
        const meta = this.#metadataCache.get(uri)!;
        const gate = this.#prefetchGate!;
        // Budget ownership contract (see the doc block above
        // `PREFETCH_CONCURRENCY`): release HERE, synchronously, the instant
        // this call claims the bytes -- unconditionally, before the caller
        // can do anything (including nothing) with the returned stream.
        // Guaranteed exactly-once because this whole branch runs only once
        // per uri: the map entry was already deleted above before this
        // `await`, so no other call can reach this line for the same uri.
        gate.release(content.reserved_bytes);
        return {
          artifact_id: input.artifact_id,
          provider_version_token: input.provider_version_token,
          content_hash: input.observed_content_hash,
          byte_length: content.byte_length,
          metadata_digest: before.metadata_digest,
          media_type: BINARY_EXTENSIONS.has(extname(uri).toLowerCase()) ? "application/octet-stream" : "text/plain; charset=utf-8",
          chunks: (async function* (): AsyncGenerator<Uint8Array> { yield content.bytes; })(),
          after_read: async (contentHash, byteLength) => {
            const after = await this.#inspectBoundary(uri, path);
            const mediaBytes = meta.has_nul || !meta.valid_utf8 ? new Uint8Array([0]) : new Uint8Array();
            if (!this.#included(uri, before, mediaBytes) || !after.included || before.token !== after.token || contentVersionToken(after.token, contentHash) !== input.provider_version_token || contentHash !== input.observed_content_hash || byteLength !== after.target_stat.size) {
              throw new SourceProviderOutcomeError("source_changed", "core:source_changed", "retryable", "The observed occurrence changed while reading.");
            }
            // Only now -- content proven byte-identical to what enumerate
            // observed -- is it safe to hand text to the observer (see its
            // doc comment on `DirectorySourceProviderOptions`). Unrelated to
            // budget: that was already released above at claim time.
            if (this.#onPrefetchedText !== undefined && !meta.has_nul && meta.valid_utf8) {
              try { this.#onPrefetchedText(uri, new TextDecoder("utf-8", { fatal: true }).decode(content.bytes)); } catch { /* observer hook is an optimization, never a contract */ }
            }
          },
        };
      }
      // Prefetch lost the race, was never admitted (budget/size), or the
      // prefetch read itself failed -- any budget it held was already
      // released by `#startPrefetch`. Fall through to the unchanged lazy
      // per-chunk path below; the hand-off is an optimization, not a
      // contract.
    }
    const fileSystem = this.#fileSystem;
    const sourceFactory = (): AsyncIterable<Uint8Array> => fileSystem.read_file_stream?.(before.target_path)
      ?? (async function* (): AsyncGenerator<Uint8Array> { yield await fileSystem.read_file(before.target_path); })();
    let streamHasNul = false;
    let streamValidUtf8 = true;
    const chunks = (async function* (): AsyncGenerator<Uint8Array> {
      let byteLength = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      try {
        for await (const chunk of sourceFactory()) {
          if (!(chunk instanceof Uint8Array)) throw new SourceProviderOutcomeError("failed", "core:source_provider_read_invalid", "never", "The source stream yielded a non-byte chunk.");
          byteLength += chunk.byteLength;
          if (byteLength > before.target_stat.size) throw new SourceProviderOutcomeError("source_changed", "core:source_changed", "retryable", "The observed occurrence grew while reading.");
          streamHasNul ||= chunk.some((byte) => byte === 0);
          if (streamValidUtf8) {
            try { decoder.decode(chunk, { stream: true }); } catch { streamValidUtf8 = false; }
          }
          yield chunk;
        }
        if (streamValidUtf8) { try { decoder.decode(); } catch { streamValidUtf8 = false; } }
        if (byteLength !== before.target_stat.size) throw new SourceProviderOutcomeError("source_changed", "core:source_changed", "retryable", "The observed occurrence changed length while reading.");
        // CAS invokes `after_read` with its actual digest. Keeping this
        // provider-side boundary callback separate preserves the post-read
        // race check without hashing the same stream twice.
      } catch (error) {
        if (error instanceof SourceProviderOutcomeError) throw error;
        if (errorCode(error) === "ENOENT") throw new SourceProviderOutcomeError("source_changed", "core:source_changed", "retryable", "The observed occurrence is no longer present.");
        throw unavailable(error);
      }
    })();
    return {
      artifact_id: input.artifact_id,
      provider_version_token: input.provider_version_token,
      content_hash: input.observed_content_hash,
      byte_length: before.target_stat.size,
      metadata_digest: before.metadata_digest,
      media_type: BINARY_EXTENSIONS.has(extname(uri).toLowerCase()) ? "application/octet-stream" : "text/plain; charset=utf-8",
      after_read: async (contentHash, byteLength) => {
        const after = await this.#inspectBoundary(uri, path);
        const mediaBytes = streamHasNul || !streamValidUtf8 ? new Uint8Array([0]) : new Uint8Array();
        if (!this.#included(uri, before, mediaBytes) || !after.included || before.token !== after.token || contentVersionToken(after.token, contentHash) !== input.provider_version_token || contentHash !== input.observed_content_hash || byteLength !== after.target_stat.size) {
          throw new SourceProviderOutcomeError("source_changed", "core:source_changed", "retryable", "The observed occurrence changed while reading.");
        }
      },
      chunks,
    };
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

  async #capture(scopeKeys: readonly string[], retainHandoffBytes = false): Promise<Capture> {
    // The native catalog path retains at most the configured hand-off budget
    // while computing each digest. Its per-file stat-before/stat-after proof,
    // followed by readStream's post-CAS boundary check, is sufficient without
    // reopening every source in a second complete inventory. Public provider
    // calls keep the stronger legacy double-inventory proof because they do
    // not have the later CAS boundary.
    if (retainHandoffBytes) {
      await this.abortPrefetch();
      this.#prefetchAborted = false;
      this.#prefetchGate = new BudgetGate(catalogHandoffBudgetBytes());
    }
    let first: Inventory;
    try {
      first = await this.#inventory(scopeKeys, true, false, undefined, retainHandoffBytes);
    } catch (error) {
      if (retainHandoffBytes) await this.abortPrefetch();
      throw error;
    }
    const firstBefore = first.before_fingerprint;
    const firstAfter = first.after_fingerprint;
    const firstStable = first.internally_stable;
    if (retainHandoffBytes) {
      if (!firstStable) await this.abortPrefetch();
      else await this.#retainCanonicalPrefetchPrefix(first.files);
      return { files: first.files, start_fingerprint: firstBefore, end_fingerprint: firstAfter, stable: firstStable };
    }
    // For ordinary workspaces retain the original strong proof: a second
    // complete inventory also supplies the current observation set when a
    // file appears/disappears during reconciliation. Large workspaces take
    // the bounded one-pass path above and revalidate bytes at CAS read time.
    const second = await this.#inventory(scopeKeys, true, false);
    return {
      files: firstStable && second.internally_stable && firstAfter === second.before_fingerprint ? first.files : second.files,
      start_fingerprint: firstBefore,
      end_fingerprint: second.after_fingerprint,
      stable: firstStable && second.internally_stable && firstAfter === second.before_fingerprint,
    };
  }

  /**
   * Captures only concrete changed files. This intentionally refuses missing
   * paths, directories, and ineligible files: those events can represent a
   * deletion, rename, exclusion, or subtree change and therefore require the
   * complete reconciliation path above to preserve deletion authority.
   */
  async #captureChangedUris(changedUris: readonly string[]): Promise<Capture | undefined> {
    const files: CapturedFile[] = [];
    const normalizedUris = [...new Set(changedUris)].sort();
    if (normalizedUris.length === 0) return undefined;
    try {
      for (const uri of normalizedUris) {
        const normalized = normalizeWorkspacePath(this.#root, uri);
        if (normalized !== uri || normalized.length === 0) return undefined;
        const path = resolve(this.#root, normalized);
        if (!isWithinRoot(this.#root, path)) return undefined;
        const fileStat = await this.#fileSystem.lstat(path);
        if (fileStat.is_directory || fileStat.is_special) return undefined;
        const included = await this.#captureFile(normalized, path, fileStat, files, true);
        if (!included) return undefined;
      }
    } catch (error) {
      // ENOENT is the normal delete/rename race; all other filesystem
      // failures are also delegated to a full reconciliation for safety.
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return undefined;
      return undefined;
    }
    const unique = [...new Map(files.map((file) => [file.uri, file])).values()].sort((left, right) => left.uri.localeCompare(right.uri));
    const beforeFingerprint = digestFields(unique.flatMap((file) => [file.uri, file.token_before]));
    const afterFingerprint = digestFields(unique.flatMap((file) => [file.uri, file.token_after]));
    return {
      files: unique,
      start_fingerprint: beforeFingerprint,
      end_fingerprint: afterFingerprint,
      stable: unique.length > 0 && unique.every((file) => file.token_before === file.token_after),
    };
  }

  async #inventory(scopeKeys: readonly string[], digestOnly: boolean, metadataOnly = false, knownUris?: ReadonlySet<string>, retainHandoffBytes = false): Promise<Inventory> {
    const files: CapturedFile[] = [];
    try {
      for (const scopeKey of [...new Set(scopeKeys)].sort()) {
        const normalizedScope = normalizeWorkspacePath(this.#root, scopeKey);
        await this.#walk(normalizedScope, files, digestOnly, metadataOnly, knownUris, retainHandoffBytes);
      }
    } catch (error) {
      return unavailable(error);
    }
    const unique = [...new Map(files.map((file) => [file.uri, file])).values()].sort((left, right) => left.uri.localeCompare(right.uri));
    return {
      files: unique,
      before_fingerprint: digestFields(unique.flatMap((file) => [file.uri, file.token_before])),
      after_fingerprint: digestFields(unique.flatMap((file) => [file.uri, file.token_after])),
      internally_stable: unique.every((file) => file.token_before === file.token_after),
    };
  }

  async #walk(relativePath: string, files: CapturedFile[], digestOnly: boolean, metadataOnly = false, knownUris?: ReadonlySet<string>, retainHandoffBytes = false): Promise<void> {
    const absolute = resolve(this.#root, relativePath);
    if (!isWithinRoot(this.#root, absolute)) throw new SourceProviderOutcomeError("failed", "core:source_provider_uri_invalid", "never", "The coverage scope escapes the provider root.");
    const rootStat = await this.#fileSystem.lstat(absolute);
    if (!rootStat.is_directory) {
      await this.#captureFile(relativePath, absolute, rootStat, files, digestOnly, metadataOnly, knownUris, retainHandoffBytes);
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
      if (childStat.is_directory && !childStat.is_symbolic_link) {
        // The inclusion policy already rejects generated trees such as
        // node_modules, dist, and coverage. Do not enumerate their entire
        // contents just to discard every file afterward. A probe preserves
        // explicit include rules (for example `dist/**`) and explicit
        // exclusions without duplicating the security policy here.
        const probe = `${child}/__urdira_directory_probe__.ts`;
        const decision = evaluateInclusion({
          normalized_path: probe,
          is_symlink: false,
          is_directory: false,
          byte_length: 0,
          media_type: "text/plain",
        }, this.#inclusion, this.#gitignore);
        if (decision.included) await this.#walk(child, files, digestOnly, metadataOnly, knownUris, retainHandoffBytes);
      }
      else await this.#captureFile(child, childPath, childStat, files, digestOnly, metadataOnly, knownUris, retainHandoffBytes);
    });
  }

  async #captureFile(uri: string, path: string, initial: DirectoryFileStat, files: CapturedFile[], digestOnly: boolean, metadataOnly = false, knownUris?: ReadonlySet<string>, retainHandoffBytes = false): Promise<boolean> {
    if (initial.is_directory || initial.is_special) return false;
    const before = await this.#inspectBoundary(uri, path);
    if (metadataOnly) {
      // Existing eligible files are checked with the same boundary token. A
      // newly appearing file is deliberately represented as a marker so the
      // first/second fingerprints disagree and the caller retries rather than
      // silently publishing an incomplete capture.
      const after = await this.#inspectBoundary(uri, path);
      files.push({ uri, content_hash: knownUris?.has(uri) ? "metadata-only" : "new-file", metadata_digest: before.metadata_digest, token_before: before.token, token_after: after.included ? after.token : `ineligible:${after.token}` });
      return after.included;
    }
    if (!before.included) return false;
    const gate = this.#prefetchGate;
    const retainBytes = retainHandoffBytes && before.target_stat.size <= catalogHandoffBudgetBytes() && gate?.tryAcquire(before.target_stat.size) === true;
    let digest: { readonly content_hash: string; readonly byte_length: number; readonly has_nul: boolean; readonly valid_utf8: boolean; readonly retained_bytes?: Uint8Array };
    try {
      digest = await this.#digestFile(before.target_path, retainBytes);
    } catch (error) {
      if (retainBytes) gate?.release(before.target_stat.size);
      throw error;
    }
    const mediaBytes = digest.has_nul || !digest.valid_utf8 ? Uint8Array.of(0) : new Uint8Array();
    if (!this.#included(uri, before, mediaBytes)) {
      if (digest.retained_bytes !== undefined) gate?.release(before.target_stat.size);
      return false;
    }
    const after = await this.#inspectBoundary(uri, path, mediaBytes);
    const stable = after.included && before.token === after.token;
    if (digest.retained_bytes !== undefined) {
      if (stable) {
        this.#prefetchPromises.set(uri, Promise.resolve({ bytes: digest.retained_bytes, byte_length: digest.byte_length, reserved_bytes: before.target_stat.size }));
      } else {
        gate?.release(before.target_stat.size);
      }
    }
    // Retained for the whole scan (see `#metadataCache`'s doc comment): a
    // later `readStream` prefetch hit reuses `has_nul`/`valid_utf8`/
    // `byte_length` instead of re-deriving them from a second read, and
    // reuses `boundary` (this exact post-digest `after`) as its own "before"
    // boundary instead of a fresh lstat/realpath/stat.
    this.#metadataCache.set(uri, { target_path: before.target_path, byte_length: digest.byte_length, has_nul: digest.has_nul, valid_utf8: digest.valid_utf8, boundary: after });
    const versionToken = contentVersionToken(before.token, digest.content_hash);
    files.push({
      uri,
      // Native enumeration is digest-only. The optional byte retention is
      // intentionally kept for the small in-memory provider fixtures; the
      // production filesystem always takes the streaming path above.
      ...(digestOnly ? {} : {}),
      content_hash: digest.content_hash,
      metadata_digest: before.metadata_digest,
      token_before: versionToken,
      token_after: after.included ? contentVersionToken(after.token, digest.content_hash) : `ineligible:${after.token}`,
    });
    return stable;
  }

  /**
   * Fire-and-forget prefetch driver, started right after enumerate's file
   * list is known (before any `readStream` call can possibly happen -- see
   * the call site) so it always has a head start. Reads full file bytes
   * ahead of CAS consumption under `PREFETCH_CONCURRENCY`-bounded fan-out and
   * a live-byte `BudgetGate`; `readStream` claims a ready entry from
   * `#prefetchPromises` when present and falls back to today's lazy
   * per-chunk streaming otherwise (budget disabled, file over budget, race
   * lost, or a prefetch read itself failed). Never throws: any per-file or
   * driver-level failure just leaves that file unprefetched. See the budget
   * ownership contract above `PREFETCH_CONCURRENCY` for exactly when each
   * file's acquired budget is released -- it is NOT tied to how long the
   * bytes this method reads actually stay alive downstream.
   */
  #startPrefetch(files: readonly CapturedFile[]): void {
    const budget = catalogHandoffBudgetBytes();
    if (budget <= 0 || files.length === 0) return;
    this.#prefetchAborted = false;
    const gate = this.#prefetchGate ?? new BudgetGate(budget);
    this.#prefetchGate = gate;
    const lanes = new BudgetGate(PREFETCH_CONCURRENCY);
    const fileSystem = this.#fileSystem;
    const eligible = files.filter((file) => {
      const meta = this.#metadataCache.get(file.uri);
      // A lone file bigger than the entire budget can never be admitted
      // (`BudgetGate.acquire` would otherwise wait forever once something
      // else is in flight); leave it to the unchanged fallback path.
      return meta !== undefined && meta.byte_length <= budget && !this.#prefetchPromises.has(file.uri);
    });
    // Register every promise before returning. Registration must not be lazy:
    // readStream can otherwise miss an entry, take the fallback path, and
    // leave a later prefetch for that same uri holding byte budget forever.
    // The lane gate still limits actual reads to PREFETCH_CONCURRENCY.
    for (const file of eligible) {
      const meta = this.#metadataCache.get(file.uri)!;
      const promise = (async (): Promise<PrefetchedContent | undefined> => {
        // Checked both before AND after `acquire`: a worker that was already
        // queued on the gate when `abortPrefetch` ran wakes up (the drain's
        // releases pump the queue), sees the flag, and returns its budget
        // instead of reading -- so the drain never waits on a read that
        // no longer has a consumer.
        if (this.#prefetchAborted) return undefined;
        await lanes.acquire(1);
        if (this.#prefetchAborted) { lanes.release(1); return undefined; }
        await gate.acquire(meta.byte_length);
        if (this.#prefetchAborted) { gate.release(meta.byte_length); lanes.release(1); return undefined; }
        // On any failure below, this worker owns the acquired budget and
        // must release it itself here. A successful result instead hands
        // budget ownership to whichever `readStream` call claims this entry
        // from `#prefetchPromises` -- released synchronously the instant
        // that claim happens (see the ownership contract above
        // `PREFETCH_CONCURRENCY`), independent of what happens to the bytes
        // afterward.
        try {
          const stream = fileSystem.read_file_stream?.(meta.target_path);
          if (stream === undefined) { gate.release(meta.byte_length); return undefined; }
          const chunks: Uint8Array[] = [];
          let total = 0;
          for await (const chunk of stream) {
            if (!(chunk instanceof Uint8Array)) { gate.release(meta.byte_length); return undefined; }
            chunks.push(chunk); total += chunk.byteLength;
          }
          // Do not hand a file that grew after enumeration to CAS with the
          // stale declared length. The source boundary will take the retryable
          // path instead of surfacing a storage-layer mismatch.
          if (total !== meta.byte_length) { gate.release(meta.byte_length); return undefined; }
          return { bytes: total === 0 ? new Uint8Array() : concatChunks(chunks, total), byte_length: total, reserved_bytes: meta.byte_length };
        } catch {
          gate.release(meta.byte_length);
          return undefined;
        } finally {
          lanes.release(1);
        }
      })();
      this.#prefetchPromises.set(file.uri, promise);
    }
  }

  /**
   * Concurrent digest completion can retain a later uri before an earlier
   * one. Keeping such holes would let later, unclaimed bytes fill the gate
   * while an earlier read waits for budget. Retain only the contiguous
   * canonical prefix; released entries are safely eligible for the eager
   * promise registration in #startPrefetch.
   */
  async #retainCanonicalPrefetchPrefix(files: readonly CapturedFile[]): Promise<void> {
    const gate = this.#prefetchGate;
    if (gate === undefined) return;
    let prefix = true;
    for (const file of files) {
      const promise = this.#prefetchPromises.get(file.uri);
      if (prefix && promise !== undefined) continue;
      prefix = false;
      if (promise === undefined) continue;
      this.#prefetchPromises.delete(file.uri);
      const content = await promise;
      if (content !== undefined) gate.release(content.reserved_bytes);
    }
  }

  /**
   * Stops the enumerate->catalog byte hand-off and returns every byte of
   * budget it still holds. Any caller that enumerates (which starts the
   * prefetch) but then does not `readStream`-claim every entry -- a fork or
   * index-pack import that skips before its read pass, a scan whose reads
   * all take the `reuse_existing` branch, or simply the end of a completed
   * read pass with unclaimed leftovers -- must call this, or up to the whole
   * hand-off budget (64MiB default) stays referenced from `#prefetchPromises`
   * for the provider's remaining lifetime and any still-queued workers stay
   * parked on the gate forever.
   *
   * Ownership stays within the existing release-on-claim contract (see
   * `PREFETCH_CONCURRENCY`): the drain below IS a claim -- it removes each
   * entry from `#prefetchPromises` first, then awaits it, then releases the
   * budget that a successful prefetch handed to whoever claimed it. Workers
   * that have not acquired yet exit via the `#prefetchAborted` checks in
   * `#startPrefetch` instead. Never blocks on anything but in-flight file
   * reads, and is safe to call at any time, repeatedly.
   */
  async abortPrefetch(): Promise<void> {
    this.#prefetchAborted = true;
    const gate = this.#prefetchGate;
    if (gate === undefined) return;
    // Loop until empty: a worker that started between our snapshot and its
    // own flag check can still add a (resolved-undefined) entry.
    while (this.#prefetchPromises.size > 0) {
      for (const [uri, promise] of [...this.#prefetchPromises]) {
        this.#prefetchPromises.delete(uri);
        const content = await promise;
        if (content !== undefined) gate.release(content.reserved_bytes);
      }
    }
  }

  async #digestFile(path: string, retainBytes = false): Promise<{ readonly content_hash: string; readonly byte_length: number; readonly has_nul: boolean; readonly valid_utf8: boolean; readonly retained_bytes?: Uint8Array }> {
    const stream = this.#fileSystem.read_file_stream?.(path);
    if (stream !== undefined) {
      const hash = createHash("sha256");
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let byteLength = 0;
      let hasNul = false;
      let validUtf8 = true;
      const retainedChunks: Uint8Array[] | undefined = retainBytes ? [] : undefined;
      for await (const chunk of stream) {
        if (!(chunk instanceof Uint8Array)) throw new SourceProviderOutcomeError("failed", "core:source_provider_read_invalid", "never", "The source stream yielded a non-byte chunk.");
        hash.update(chunk);
        retainedChunks?.push(new Uint8Array(chunk));
        byteLength += chunk.byteLength;
        hasNul ||= chunk.some((byte) => byte === 0);
        if (validUtf8) {
          try { decoder.decode(chunk, { stream: true }); } catch { validUtf8 = false; }
        }
      }
      if (validUtf8) { try { decoder.decode(); } catch { validUtf8 = false; } }
      return { content_hash: `sha256:${hash.digest("hex")}`, byte_length: byteLength, has_nul: hasNul, valid_utf8: validUtf8, ...(retainedChunks === undefined ? {} : { retained_bytes: byteLength === 0 ? new Uint8Array() : concatChunks(retainedChunks, byteLength) }) };
    }
    // Test-only file systems may implement only read_file. Keep their
    // contract working without making the native Node provider pay this
    // aggregate allocation.
    const bytes = await this.#fileSystem.read_file(path);
    return { content_hash: rawDigest(bytes), byte_length: bytes.byteLength, has_nul: bytes.some((byte) => byte === 0), valid_utf8: (() => { try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; } catch { return false; } })(), ...(retainBytes ? { retained_bytes: bytes } : {}) };
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
    const result = this.#enumerationRecord(request, previousWatermark, scopes, capture, budget, observationMode, stable, mayAuthorizeDeletion);
    return { observation_batch: JSON.stringify(result.encoded), watermark: result.watermark, capture_start_fingerprint: result.capture_start_fingerprint, capture_end_fingerprint: result.capture_end_fingerprint };
  }

  #enumerationRecord(
    request: SourceProviderRequestEnvelope,
    previousWatermark: string | undefined,
    scopes: readonly ObservationCoverageScope[],
    capture: Capture,
    budget: SourceProviderResourceBudget,
    observationMode: "scan" | "reconciliation",
    stable: boolean,
    mayAuthorizeDeletion: boolean,
  ): { readonly encoded: EncodedObservationBatch; readonly watermark: string; readonly capture_start_fingerprint: string; readonly capture_end_fingerprint: string } {
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
      coverage_completeness: stable && fullCoverage && mayAuthorizeDeletion ? "complete" : "partial",
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
    return { encoded, watermark, capture_start_fingerprint: capture.start_fingerprint, capture_end_fingerprint: capture.end_fingerprint };
  }
}
