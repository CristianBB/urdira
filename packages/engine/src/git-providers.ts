import fs from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import git from "isomorphic-git";
import type {
  JsonValue,
  ObservationCoverageScope,
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
  VcsState,
} from "@urdira/contracts";
import { canonicalBytes, digestBytes } from "@urdira/canonical";
import { canonicalizePath, evaluateInclusion, normalizeWorkspacePath, type GitIgnoreRules, type InclusionRules } from "@urdira/security";
import {
  DirectorySourceProvider,
  type DirectoryFileSystem,
  type EncodedObservationBatch,
  type ProviderObservation,
} from "./directory-provider.js";
import { sourceObservationBatchDigest } from "./source-batch-digest.js";
import {
  executeProviderCall,
  parseProviderPayload,
  providerRuntime,
  sourceProviderArtifactId,
  SourceProviderOutcomeError,
  type SourceProvider,
  type SourceProviderOutcome,
  type SourceProviderRequestExpectations,
  type SourceProviderRuntime,
} from "./source-provider.js";

interface GitTreeEntry {
  readonly mode: string;
  readonly path: string;
  readonly oid: string;
  readonly type: "commit" | "blob" | "tree";
}

export interface GitObjectPort {
  resolve_ref(gitDirectory: string, ref: string): Promise<string>;
  peel_commit(gitDirectory: string, oid: string): Promise<string>;
  read_tree(gitDirectory: string, oid: string): Promise<readonly GitTreeEntry[]>;
  read_blob(gitDirectory: string, oid: string): Promise<Uint8Array>;
  status_matrix(worktreeRoot: string, gitDirectory: string, ref: string): Promise<readonly (readonly [string, number, number, number])[]>;
}

export const ISOMORPHIC_GIT_OBJECT_PORT: GitObjectPort = Object.freeze({
  async resolve_ref(gitDirectory: string, ref: string): Promise<string> {
    // Left un-redirected to the common directory: `HEAD` (and any other ref a
    // caller might resolve) is genuinely per-worktree for a linked worktree,
    // so resolving it must read the worktree's own private git directory, not
    // the shared one.
    return git.resolveRef({ fs, gitdir: gitDirectory, ref });
  },
  async peel_commit(gitDirectory: string, oid: string): Promise<string> {
    return (await git.readCommit({ fs, gitdir: await commonDirectoryFor(gitDirectory), oid })).oid;
  },
  async read_tree(gitDirectory: string, oid: string): Promise<readonly GitTreeEntry[]> {
    return (await git.readTree({ fs, gitdir: await commonDirectoryFor(gitDirectory), oid })).tree;
  },
  async read_blob(gitDirectory: string, oid: string): Promise<Uint8Array> {
    return (await git.readBlob({ fs, gitdir: await commonDirectoryFor(gitDirectory), oid })).blob;
  },
  async status_matrix(worktreeRoot: string, gitDirectory: string, ref: string): Promise<readonly (readonly [string, number, number, number])[]> {
    return git.statusMatrix({ fs, dir: worktreeRoot, gitdir: await commonDirectoryFor(gitDirectory), ref, refresh: false });
  },
});

interface ProviderBaseOptions {
  readonly workspace_id: string;
  readonly source_provider_binding_id: string;
  readonly now?: () => string;
  readonly monotonic_now?: () => number;
  readonly is_cancelled?: (cancellationId: string) => boolean;
  readonly git_objects?: GitObjectPort;
}

export interface GitWorktreeSourceProviderOptions extends ProviderBaseOptions {
  readonly root: string;
  readonly provider_version?: string;
  readonly inclusion_rules?: InclusionRules;
  readonly gitignore_rules?: GitIgnoreRules;
  readonly file_system?: DirectoryFileSystem;
}

export interface GitReferenceSourceProviderOptions extends ProviderBaseOptions {
  readonly git_dir: string;
  readonly ref: string;
  readonly provider_version?: string;
  readonly inclusion_rules?: InclusionRules;
  readonly gitignore_rules?: GitIgnoreRules;
}

export interface GitAdministration {
  readonly git_directory: string;
  readonly common_directory: string;
  readonly fingerprint: string;
  readonly vcs_state: VcsState;
}

interface GitCapturedBlob {
  readonly uri: string;
  readonly mode: string;
  readonly oid: string;
  readonly bytes: Uint8Array;
}

const WORKTREE_KIND = "core:git_worktree_source_provider";
const REFERENCE_KIND = "core:git_reference_source_provider";
const DEFAULT_INCLUSION: InclusionRules = { include: [], exclude: [], allow_external_root: false };
const DEFAULT_GITIGNORE: GitIgnoreRules = { enabled: false, patterns: [] };

function jsonDigest(value: unknown): string {
  return digestBytes(canonicalBytes(value));
}

function rawDigest(bytes: Uint8Array): string {
  return digestBytes(bytes);
}

function providerError(error: unknown): SourceProviderOutcomeError {
  if (error instanceof SourceProviderOutcomeError) return error;
  const code = error !== null && typeof error === "object" && "code" in error ? String((error as { readonly code?: unknown }).code) : "";
  const gitCode = error !== null && typeof error === "object" && "caller" in error ? String((error as { readonly caller?: unknown }).caller) : "";
  if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(code) || gitCode.length > 0 || error instanceof Error) {
    return new SourceProviderOutcomeError("unavailable", "core:git_source_unavailable", "retryable", "The Git source is unavailable.");
  }
  return new SourceProviderOutcomeError("failed", "core:git_source_failed", "conditional", "The Git source failed.");
}

function throwResponse(response: SourceProviderResponseEnvelope): never {
  let parsed: { readonly error_code?: string; readonly retryability?: string; readonly detail_code?: string } = {};
  try { parsed = JSON.parse(response.error ?? "{}") as typeof parsed; } catch { /* Preserve a closed provider failure below. */ }
  const outcome = response.outcome as Exclude<SourceProviderOutcome, "success">;
  throw new SourceProviderOutcomeError(outcome, parsed.error_code ?? "core:source_provider_failed", parsed.retryability ?? "conditional", "A delegated provider call failed.", parsed.detail_code);
}

function payloadRecord(response: SourceProviderResponseEnvelope): Record<string, JsonValue> {
  if (response.outcome !== "success" || response.payload === undefined) throwResponse(response);
  if (response.payload === null || typeof response.payload !== "object" || Array.isArray(response.payload)) {
    throw new SourceProviderOutcomeError("failed", "core:source_provider_response_invalid", "never", "The delegated provider payload is invalid.");
  }
  return response.payload as Record<string, JsonValue>;
}

async function optionalText(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? String((error as { readonly code?: unknown }).code) : "";
    if (code === "ENOENT") return "";
    throw error;
  }
}

async function gitDirectoryFor(root: string): Promise<string> {
  const marker = join(root, ".git");
  const markerStat = await stat(marker);
  if (markerStat.isDirectory()) return canonicalizePath(marker);
  const content = await readFile(marker, "utf8");
  const match = /^gitdir:\s*(.+?)\s*$/u.exec(content);
  if (!match?.[1]) throw new SourceProviderOutcomeError("unavailable", "core:git_source_unavailable", "retryable", "The worktree Git administration pointer is invalid.");
  return canonicalizePath(isAbsolute(match[1]) ? match[1] : resolve(root, match[1]));
}

async function commonDirectoryFor(gitDirectory: string): Promise<string> {
  const common = (await optionalText(join(gitDirectory, "commondir"))).trim();
  if (!common) return canonicalizePath(await realpath(gitDirectory));
  return canonicalizePath(await realpath(isAbsolute(common) ? common : resolve(gitDirectory, common)));
}

function referenceFromHead(head: string): { readonly detached: boolean; readonly ref_kind: string; readonly ref_name?: string } {
  const symbolic = /^ref:\s*(.+?)\s*$/u.exec(head);
  if (!symbolic?.[1]) return { detached: true, ref_kind: "detached" };
  return { detached: false, ref_kind: symbolic[1].startsWith("refs/heads/") ? "branch" : "symbolic", ref_name: symbolic[1] };
}

export interface GitPeeledHead {
  readonly common_directory: string;
  readonly head_revision: string;
}

/**
 * A byte-free, O(1) alternative to `administrativeState` for callers that
 * only need "which repo, which commit" and never trust the result as a
 * correctness predicate on its own -- e.g. `workspace-fork.ts`'s git
 * preference hint, which only orders candidate donors (the unconditional
 * content-hash multiset check is the actual predicate; see
 * docs/decisions/12-workspace-fork.md's "git fast path" section).
 * `administrativeState`'s dirty check reads and SHA-1-compares every
 * tracked file against its blob (`gitTreeMatchesWorktree`) plus a full
 * `status_matrix` call -- the right cost for a genuine dirty/clean
 * determination, but wildly disproportionate for a large repository when
 * the caller is only going to use the result to pick which donor to try
 * first. Measured on a real 981-file repository, replacing this call in the
 * donor-matching hint cut the fork's `donor_match` stage from ~113s to
 * effectively the cost of a handful of tiny file reads.
 */
export async function peeledHeadFor(root: string, gitObjects: GitObjectPort): Promise<GitPeeledHead> {
  try {
    const gitDirectory = await gitDirectoryFor(root);
    const commonDirectory = await commonDirectoryFor(gitDirectory);
    const headRevision = await gitObjects.peel_commit(gitDirectory, await gitObjects.resolve_ref(gitDirectory, "HEAD"));
    return { common_directory: commonDirectory, head_revision: headRevision };
  } catch (error) {
    throw providerError(error);
  }
}

/**
 * Exported (beyond this module's original internal use inside
 * `GitWorktreeSourceProvider`) so the workspace-fork feature
 * (`packages/engine/src/workspace-fork.ts`) can compare two worktrees'
 * administrative state (common directory, peeled HEAD, clean/dirty) without
 * constructing a full `GitWorktreeSourceProvider` for either one. Behavior is
 * completely unchanged: same computation, same callers as before.
 */
export async function administrativeState(root: string, gitObjects: GitObjectPort, now: () => string): Promise<GitAdministration> {
  try {
    const gitDirectory = await gitDirectoryFor(root);
    const commonDirectory = await commonDirectoryFor(gitDirectory);
    const headText = await readFile(join(gitDirectory, "HEAD"), "utf8");
    const headShape = referenceFromHead(headText);
    const headRevision = await gitObjects.peel_commit(gitDirectory, await gitObjects.resolve_ref(gitDirectory, "HEAD"));
    const statusRows = await gitObjects.status_matrix(root, gitDirectory, "HEAD");
    const trackedContentMatches = await gitTreeMatchesWorktree(root, gitDirectory, headRevision, gitObjects);
    const dirty = !trackedContentMatches || statusRows.some(([, head, worktree, stage]) => head !== 1 || worktree !== 1 || stage !== 1) ? "dirty" : "clean";
    const normalizedStatus = [...statusRows].map((row) => [...row] as const).sort((left, right) => left[0].localeCompare(right[0]));
    const refText = headShape.ref_name ? await optionalText(join(commonDirectory, headShape.ref_name)) : "";
    const fingerprint = jsonDigest({
      common_directory: commonDirectory,
      dirty,
      head: headText.trim(),
      head_revision: headRevision,
      index_digest: rawDigest(await readFile(join(gitDirectory, "index")).catch(() => new Uint8Array())),
      packed_refs_digest: rawDigest(Buffer.from(await optionalText(join(commonDirectory, "packed-refs")))),
      ref: refText.trim(),
      status: normalizedStatus,
    });
    return {
      git_directory: gitDirectory,
      common_directory: commonDirectory,
      fingerprint,
      vcs_state: {
        provider: "git",
        common_repository_id: jsonDigest({ common_directory: commonDirectory }),
        head_revision: headRevision,
        ref_kind: headShape.ref_kind,
        ...(headShape.ref_name === undefined ? {} : { ref_name: headShape.ref_name }),
        detached: headShape.detached,
        dirty,
        captured_at: now(),
      },
    };
  } catch (error) {
    throw providerError(error);
  }
}

async function gitTreeMatchesWorktree(root: string, gitDirectory: string, commit: string, gitObjects: GitObjectPort): Promise<boolean> {
  const visit = async (treeOid: string, prefix: string): Promise<boolean> => {
    const entries = await gitObjects.read_tree(gitDirectory, treeOid);
    for (const entry of entries) {
      const uri = prefix.length === 0 ? entry.path : `${prefix}/${entry.path}`;
      if (entry.type === "tree") {
        if (!await visit(entry.oid, uri)) return false;
      } else if (entry.type === "blob") {
        const normalized = normalizeWorkspacePath(root, uri);
        try {
          const [worktreeBytes, objectBytes] = await Promise.all([
            readFile(resolve(root, normalized)),
            gitObjects.read_blob(gitDirectory, entry.oid),
          ]);
          if (!Buffer.from(worktreeBytes).equals(Buffer.from(objectBytes))) return false;
        } catch {
          return false;
        }
      }
    }
    return true;
  };
  return visit(commit, "");
}

function combinePhysicalPayload(payload: Record<string, JsonValue>, before: GitAdministration, after: GitAdministration, unstable: boolean): Record<string, JsonValue> {
  const start = String(payload["capture_start_fingerprint"] ?? payload["source_state_fingerprint"] ?? "");
  const end = String(payload["capture_end_fingerprint"] ?? payload["source_state_fingerprint"] ?? "");
  const combinedStart = jsonDigest({ administrative_state_fingerprint: before.fingerprint, physical_state_fingerprint: start });
  const combinedEnd = jsonDigest({ administrative_state_fingerprint: after.fingerprint, physical_state_fingerprint: end });
  if (typeof payload["features"] === "string") {
    const featureSet = JSON.parse(payload["features"]) as Record<string, JsonValue>;
    return {
      ...payload,
      features: JSON.stringify({ ...featureSet, administrative_state_fingerprint: after.fingerprint, vcs_state: after.vcs_state }),
      source_state_fingerprint: combinedEnd,
    };
  }
  const watermark = `watermark:${combinedEnd}`;
  let observationBatch = payload["observation_batch"];
  if (typeof observationBatch === "string") {
    const encoded = JSON.parse(observationBatch) as EncodedObservationBatch;
    const observations = encoded.observations.map((observation) => ({ ...observation, provider_sequence: watermark }));
    const batchCore = {
      ...encoded.batch,
      provider_cursor_after: watermark,
      ...(unstable ? { coverage_completeness: "partial", deletion_authority: "none" } : {}),
    };
    const { batch_digest: _previousDigest, ...digestibleBatch } = batchCore;
    void _previousDigest;
    const batchDigest = sourceObservationBatchDigest(digestibleBatch, observations);
    observationBatch = JSON.stringify({ batch: { ...batchCore, batch_digest: batchDigest }, observations });
  }
  return {
    ...payload,
    ...(observationBatch === undefined ? {} : { observation_batch: observationBatch }),
    capture_start_fingerprint: combinedStart,
    capture_end_fingerprint: combinedEnd,
    watermark,
    ...(typeof payload["stable"] === "boolean" ? { stable: !unstable && payload["stable"] } : {}),
  };
}

export class GitWorktreeSourceProvider implements SourceProvider {
  readonly component_id = WORKTREE_KIND;
  readonly component_version: string;
  readonly #root: string;
  readonly #directory: DirectorySourceProvider;
  readonly #gitObjects: GitObjectPort;
  readonly #runtime: SourceProviderRuntime;
  readonly #requestExpectations: SourceProviderRequestExpectations;

  constructor(options: GitWorktreeSourceProviderOptions) {
    this.#root = canonicalizePath(options.root);
    this.component_version = options.provider_version ?? "1";
    this.#gitObjects = options.git_objects ?? ISOMORPHIC_GIT_OBJECT_PORT;
    this.#runtime = providerRuntime(options);
    this.#requestExpectations = {
      protocol_version: "1",
      workspace_id: options.workspace_id,
      source_provider_binding_id: options.source_provider_binding_id,
      component_id: this.component_id,
      component_version: this.component_version,
    };
    this.#directory = new DirectorySourceProvider({
      root: options.root,
      workspace_id: options.workspace_id,
      source_provider_binding_id: options.source_provider_binding_id,
      provider_kind: WORKTREE_KIND,
      ...(options.provider_version === undefined ? {} : { provider_version: options.provider_version }),
      ...(options.inclusion_rules === undefined ? {} : { inclusion_rules: options.inclusion_rules }),
      ...(options.gitignore_rules === undefined ? {} : { gitignore_rules: options.gitignore_rules }),
      ...(options.file_system === undefined ? {} : { file_system: options.file_system }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.monotonic_now === undefined ? {} : { monotonic_now: options.monotonic_now }),
      ...(options.is_cancelled === undefined ? {} : { is_cancelled: options.is_cancelled }),
    });
  }

  describe(request: SourceProviderRequestEnvelope): Promise<SourceProviderResponseEnvelope> { return this.#augment(request, "describe"); }
  enumerate(request: SourceProviderRequestEnvelope): Promise<SourceProviderResponseEnvelope> { return this.#augment(request, "enumerate"); }
  read(request: SourceProviderRequestEnvelope): Promise<SourceProviderResponseEnvelope> { return this.#augment(request, "read"); }
  watch(request: SourceProviderRequestEnvelope): Promise<SourceProviderResponseEnvelope> { return this.#augment(request, "watch"); }
  reconcile(request: SourceProviderRequestEnvelope): Promise<SourceProviderResponseEnvelope> { return this.#augment(request, "reconcile"); }

  #augment(request: SourceProviderRequestEnvelope, call: "describe" | "enumerate" | "read" | "watch" | "reconcile"): Promise<SourceProviderResponseEnvelope> {
    return executeProviderCall(request, call, this.#requestExpectations, this.#runtime, async () => {
      const before = await administrativeState(this.#root, this.#gitObjects, this.#runtime.now);
      const response = await this.#directory[call](request);
      const after = await administrativeState(this.#root, this.#gitObjects, this.#runtime.now);
      const payload = payloadRecord(response);
      const unstable = before.fingerprint !== after.fingerprint;
      if (unstable && call !== "reconcile") throw new SourceProviderOutcomeError("source_changed", "core:source_changed", "retryable", "Git administrative state changed during capture.");
      return combinePhysicalPayload(payload, before, after, unstable);
    });
  }
}

function scopesFor(payload: SourceProviderEnumerateRequest, request: SourceProviderRequestEnvelope): readonly ObservationCoverageScope[] {
  if (!Array.isArray(payload.coverage_scopes) || payload.coverage_scopes.length === 0) {
    throw new SourceProviderOutcomeError("failed", "core:source_provider_scope_invalid", "never", "At least one coverage scope is required.");
  }
  for (const scope of payload.coverage_scopes) {
    if (scope.source_provider_binding_id !== request.source_provider_binding_id || scope.source_provider !== REFERENCE_KIND
      || typeof scope.normalized_scope_key !== "string") {
      throw new SourceProviderOutcomeError("failed", "core:source_provider_scope_invalid", "never", "The coverage scope does not match this provider binding.");
    }
  }
  return payload.coverage_scopes;
}

function gitMediaType(bytes: Uint8Array): string {
  if (bytes.some((byte) => byte === 0)) return "application/octet-stream";
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return "text/plain"; }
  catch { return "application/octet-stream"; }
}

export class GitReferenceSourceProvider implements SourceProvider {
  readonly component_id = REFERENCE_KIND;
  readonly component_version: string;
  readonly #gitDirectory: string;
  readonly #ref: string;
  readonly #providerVersion: string;
  readonly #gitObjects: GitObjectPort;
  readonly #runtime: SourceProviderRuntime;
  readonly #requestExpectations: SourceProviderRequestExpectations;
  readonly #inclusion: InclusionRules;
  readonly #gitignore: GitIgnoreRules;
  #pinnedCommit: string | undefined;

  constructor(options: GitReferenceSourceProviderOptions) {
    this.#gitDirectory = canonicalizePath(options.git_dir);
    this.#ref = options.ref;
    this.#providerVersion = options.provider_version ?? "1";
    this.component_version = this.#providerVersion;
    this.#gitObjects = options.git_objects ?? ISOMORPHIC_GIT_OBJECT_PORT;
    this.#runtime = providerRuntime(options);
    this.#requestExpectations = {
      protocol_version: "1",
      workspace_id: options.workspace_id,
      source_provider_binding_id: options.source_provider_binding_id,
      component_id: this.component_id,
      component_version: this.component_version,
    };
    this.#inclusion = options.inclusion_rules ?? DEFAULT_INCLUSION;
    this.#gitignore = options.gitignore_rules ?? DEFAULT_GITIGNORE;
  }

  describe(request: SourceProviderRequestEnvelope): Promise<SourceProviderResponseEnvelope> {
    return executeProviderCall(request, "describe", this.#requestExpectations, this.#runtime, async () => {
      parseProviderPayload<{ readonly binding_configuration_digest: string }>(request);
      const commit = await this.#ensurePinned(false);
      const features = {
        supports_watch: false,
        supports_authoritative_delete_events: false,
        supports_complete_enumeration: true,
        supports_stable_reconciliation: true,
        supports_virtual_artifacts: true,
        case_behavior: "sensitive",
        read_only: true,
        ref_resolution: { requested_ref: this.#ref, exact_commit: commit },
      };
      return {
        provider_kind: REFERENCE_KIND,
        immutable_binding_identity: jsonDigest({ git_directory: this.#gitDirectory, ref: this.#ref }),
        features: JSON.stringify(features),
        source_state_fingerprint: `git-commit:${commit}`,
      } satisfies SourceProviderDescribeResult;
    });
  }

  enumerate(request: SourceProviderRequestEnvelope): Promise<SourceProviderResponseEnvelope> {
    return executeProviderCall(request, "enumerate", this.#requestExpectations, this.#runtime, async (budget) => {
      const payload = parseProviderPayload<SourceProviderEnumerateRequest>(request);
      const scopes = scopesFor(payload, request);
      const commit = await this.#ensurePinned(false);
      return this.#capturePayload(request, payload.previous_watermark, scopes, commit, budget, false);
    });
  }

  read(request: SourceProviderRequestEnvelope): Promise<SourceProviderResponseEnvelope> {
    return executeProviderCall(request, "read", this.#requestExpectations, this.#runtime, async () => {
      const payload = parseProviderPayload<SourceProviderReadRequest>(request);
      const commit = await this.#ensurePinned(false);
      const uri = normalizeWorkspacePath("/", payload.normalized_uri);
      if (uri !== payload.normalized_uri || uri.length === 0) throw new SourceProviderOutcomeError("failed", "core:source_provider_uri_invalid", "never", "The normalized URI is invalid.");
      const before = await this.#findBlob(commit, uri);
      if (!before) throw new SourceProviderOutcomeError("source_changed", "core:source_changed", "never", "The pinned tree does not contain the observed blob.");
      const beforeToken = `${commit}:${before.oid}:${before.mode}`;
      const metadataDigest = jsonDigest({ commit, mode: before.mode, oid: before.oid, uri });
      if (beforeToken !== payload.provider_version_token || metadataDigest !== payload.observed_metadata_digest) {
        throw new SourceProviderOutcomeError("source_changed", "core:source_changed", "never", "The observed Git occurrence token does not match.");
      }
      const bytes = await this.#gitObjects.read_blob(this.#gitDirectory, before.oid);
      if (!this.#blobIncluded(uri, before, bytes)) {
        throw new SourceProviderOutcomeError("failed", "core:source_provider_artifact_ineligible", "never", "The requested Git blob is not an eligible source artifact.");
      }
      const after = await this.#findBlob(commit, uri);
      const afterToken = after === undefined ? "" : `${commit}:${after.oid}:${after.mode}`;
      const contentHash = rawDigest(bytes);
      if (afterToken !== beforeToken || contentHash !== payload.observed_content_hash) {
        throw new SourceProviderOutcomeError("source_changed", "core:source_changed", "never", "The Git object changed while reading.");
      }
      return {
        artifact_id: payload.artifact_id,
        provider_version_token: afterToken,
        content_bytes: Buffer.from(bytes).toString("base64"),
        content_hash: contentHash,
        byte_length: bytes.byteLength,
        metadata_digest: metadataDigest,
      } satisfies SourceProviderReadResult;
    });
  }

  watch(request: SourceProviderRequestEnvelope): Promise<SourceProviderResponseEnvelope> {
    return executeProviderCall(request, "watch", this.#requestExpectations, this.#runtime, async (budget) => {
      const payload = parseProviderPayload<SourceProviderWatchRequest>(request);
      scopesFor(payload, request);
      if (budget.max_watch_events === 0) return { events: [], watermark: payload.after_watermark ?? `watermark:git-commit:${await this.#ensurePinned(false)}` } satisfies SourceProviderWatchResult;
      return { events: [], watermark: payload.after_watermark ?? `watermark:git-commit:${await this.#ensurePinned(false)}` } satisfies SourceProviderWatchResult;
    });
  }

  reconcile(request: SourceProviderRequestEnvelope): Promise<SourceProviderResponseEnvelope> {
    return executeProviderCall(request, "reconcile", this.#requestExpectations, this.#runtime, async (budget) => {
      const payload = parseProviderPayload<SourceProviderEnumerateRequest>(request);
      const scopes = scopesFor(payload, request);
      const commit = await this.#ensurePinned(true);
      return { ...await this.#capturePayload(request, payload.previous_watermark, scopes, commit, budget, true), stable: true };
    });
  }

  async #ensurePinned(refresh: boolean): Promise<string> {
    if (!refresh && this.#pinnedCommit) return this.#pinnedCommit;
    try {
      const resolved = await this.#gitObjects.resolve_ref(this.#gitDirectory, this.#ref);
      const commit = await this.#gitObjects.peel_commit(this.#gitDirectory, resolved);
      this.#pinnedCommit = commit;
      return commit;
    } catch (error) {
      throw providerError(error);
    }
  }

  async #treeBlobs(commit: string): Promise<readonly GitCapturedBlob[]> {
    const blobs: GitCapturedBlob[] = [];
    const visit = async (treeOid: string, prefix: string): Promise<void> => {
      const entries = [...await this.#gitObjects.read_tree(this.#gitDirectory, treeOid)].sort((left, right) => left.path.localeCompare(right.path));
      for (const entry of entries) {
        const uri = prefix.length === 0 ? entry.path : `${prefix}/${entry.path}`;
        if (entry.type === "tree") await visit(entry.oid, uri);
        else if (entry.type === "blob") {
          const bytes = await this.#gitObjects.read_blob(this.#gitDirectory, entry.oid);
          if (this.#blobIncluded(uri, entry, bytes)) blobs.push({ uri, mode: entry.mode, oid: entry.oid, bytes });
        }
      }
    };
    await visit(commit, "");
    return blobs;
  }

  async #findBlob(commit: string, uri: string): Promise<GitTreeEntry | undefined> {
    const segments = uri.split("/");
    let treeOid = commit;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const entry = (await this.#gitObjects.read_tree(this.#gitDirectory, treeOid)).find((candidate) => candidate.path === segment);
      if (!entry) return undefined;
      if (index === segments.length - 1) return entry.type === "blob" ? entry : undefined;
      if (entry.type !== "tree") return undefined;
      treeOid = entry.oid;
    }
    return undefined;
  }

  #blobIncluded(uri: string, entry: GitTreeEntry, bytes: Uint8Array): boolean {
    return evaluateInclusion({
      normalized_path: uri,
      is_symlink: entry.mode === "120000",
      is_directory: false,
      byte_length: bytes.byteLength,
      media_type: gitMediaType(bytes),
    }, this.#inclusion, this.#gitignore).included;
  }

  async #capturePayload(
    request: SourceProviderRequestEnvelope,
    previousWatermark: string | undefined,
    scopes: readonly ObservationCoverageScope[],
    commit: string,
    budget: SourceProviderResourceBudget,
    reconciliation: boolean,
  ): Promise<Record<string, JsonValue>> {
    const all = await this.#treeBlobs(commit);
    const blobs = all.filter((blob) => scopes.some((scope) => scope.normalized_scope_key === "" || blob.uri === scope.normalized_scope_key || blob.uri.startsWith(`${scope.normalized_scope_key}/`)));
    if (blobs.length > budget.max_observations) throw new SourceProviderOutcomeError("resource_exhausted", "core:source_provider_observations_exhausted", "retryable", "The observation budget was exhausted.");
    const fingerprint = `git-commit:${commit}`;
    const watermark = `watermark:${jsonDigest({ commit, scopes })}`;
    const batchId = jsonDigest({ binding: request.source_provider_binding_id, commit, scopes });
    const observations: ProviderObservation[] = blobs.map((blob) => {
      const metadataDigest = jsonDigest({ commit, mode: blob.mode, oid: blob.oid, uri: blob.uri });
      const versionToken = `${commit}:${blob.oid}:${blob.mode}`;
      return {
        source_observation_id: jsonDigest({ batch_id: batchId, uri: blob.uri }),
        observation_batch_id: batchId,
        workspace_id: request.workspace_id,
        artifact_id: sourceProviderArtifactId(request.workspace_id, blob.uri),
        source_provider_binding_id: request.source_provider_binding_id,
        source_provider: REFERENCE_KIND,
        source_provider_version: this.#providerVersion,
        ordering_domain: request.source_provider_binding_id,
        observation_mode: reconciliation ? "reconciliation" : "scan",
        observed_state: "present",
        observed_content_hash: rawDigest(blob.bytes),
        observed_metadata_digest: metadataDigest,
        provider_event_token: versionToken,
        provider_sequence: watermark,
        observed_at: this.#runtime.now(),
        received_at: this.#runtime.now(),
        normalized_uri: blob.uri,
        provider_version_token: versionToken,
      };
    });
    const complete = scopes.length === 1 && scopes[0]?.normalized_scope_key === "";
    const batchCore = {
      workspace_id: request.workspace_id,
      source_provider_binding_id: request.source_provider_binding_id,
      source_provider: REFERENCE_KIND,
      source_provider_version: this.#providerVersion,
      ordering_domain: request.source_provider_binding_id,
      observation_mode: reconciliation ? "reconciliation" : "scan",
      coverage_scopes: JSON.stringify(scopes),
      coverage_completeness: complete ? "complete" : "partial",
      deletion_authority: complete ? "authoritative" : "none",
      provider_cursor_before: previousWatermark ?? "",
      provider_cursor_after: watermark,
      started_at: this.#runtime.now(),
      completed_at: this.#runtime.now(),
      observation_count: observations.length,
      unavailable_count: 0,
    };
    const batchDigest = sourceObservationBatchDigest(batchCore, observations);
    const batch: SourceObservationBatch = { observation_batch_id: batchId, ...batchCore, batch_digest: batchDigest };
    const encoded: EncodedObservationBatch = { batch, observations };
    return {
      observation_batch: JSON.stringify(encoded),
      watermark,
      capture_start_fingerprint: fingerprint,
      capture_end_fingerprint: fingerprint,
    };
  }
}
