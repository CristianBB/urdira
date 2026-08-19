import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { ArtifactWorkItem, ReplacementScope, SnapshotCapabilityStateEntry } from "@urdira/contracts";
import { runCli, type CliCommand, type CliResult } from "@urdira/cli";
import { createPersistentWorkspaceRegistry, DaemonClient, DaemonRuntime, EndpointDescriptorStore, daemonPaths, type DaemonRuntimeOptions, type SemanticProviderDescriptor } from "@urdira/daemon";
import {
  candidateTargetRegistryFromSnapshot,
  createCanonicalPluginDigestAuthority,
  FactDeltaAcceptanceService,
  readPersistedControlState,
  type AcceptedFactDelta,
  type WorkspaceScanPluginProvider,
  type WorkspaceScanSourceArtifact,
} from "@urdira/engine";
import { serveUrdiraStdio, type ServeUrdiraStdioOptions, type UrdiraMcpClient } from "@urdira/mcp";
import {
  bundledPluginCatalogEntry,
  createJavascriptTypescriptInstalledBundle,
  createJavascriptTypescriptThreadTransport,
  createJavascriptTypescriptWorker,
  languageForPath,
  JAVASCRIPT_TYPESCRIPT_CAPABILITIES,
  JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES,
  JAVASCRIPT_TYPESCRIPT_DEPENDENCY_ROLES,
  JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
  JAVASCRIPT_TYPESCRIPT_RECORD_KINDS,
  JAVASCRIPT_TYPESCRIPT_VERSION,
  TYPESCRIPT_COMPILER_VERSION,
  type JavascriptTypescriptPackageAsset,
  type JavascriptTypescriptWorkerDescriptor,
} from "@urdira/plugin-javascript-typescript";
import {
  canonicalSha256,
  parseVersionRequirementText,
  pluginInputAccessManifestDigest,
  pluginInputAccessManifestId,
  PluginPackageDiscovery,
  PluginRegistryAssembler,
  PluginResolver,
  type AssembledPluginRegistry,
  type AutomaticPluginInputAccessManifest,
  type DiscoveredPluginPackage,
  type SdkPluginResolutionLock,
} from "@urdira/plugin-sdk";
import { AnalysisWorkerPool } from "./analysis-worker-pool.js";

export interface UrdiraRunOptions {
  readonly endpoint?: string;
  readonly daemon?: DaemonRuntimeOptions;
  readonly execute_admin?: (command: CliCommand, preview: unknown) => Promise<unknown>;
  readonly prompt?: (question: string) => Promise<string | boolean>;
}

export const URDIRA_VERSION = "0.1.0";

export function urdiraHelp(): string {
  return `Urdira ${URDIRA_VERSION}\n\nUsage:\n  urdira status [--json]\n  urdira index [--json] [--workspace <id>]\n  urdira query --payload <json> [--json]\n  urdira workspace add <path> --dry-run [--confirm]\n  urdira workspace configure <id> --dry-run [--confirm]\n  urdira workspace remove <id> --dry-run [--confirm]\n  urdira workspace purge <id> --dry-run [--confirm]\n  urdira agent status --client all\n  urdira mcp\n\nRun administrative commands with --dry-run first. Source-reading MCP calls always require explicit workspace scope.\n`;
}

export interface UrdiraMcpRunOptions {
  readonly endpoint?: string;
  readonly daemon?: DaemonRuntimeOptions;
  /** IPC deadline for MCP requests; pipeline queries may need a larger explicit budget than the 30s local default. */
  readonly request_timeout_ms?: number;
  readonly stdio?: ServeUrdiraStdioOptions;
  /** Optional narrowed MCP projection used by focused benchmark clients. */
  readonly tool_names?: readonly ("urdira_query" | "urdira_index_status")[];
  /** Optional compact instructions paired with a narrowed tool projection. */
  readonly instructions?: string;
  /** Optional compact input schemas for a focused benchmark projection. */
  readonly compact?: boolean;
  /** Optional benchmark-only single-call discovery adapter. */
  readonly benchmark_discover?: boolean;
}

// --- JavaScript/TypeScript plugin-provider composition -------------------
//
// `@urdira/daemon` intentionally has no dependency on any production
// language plugin (AGENTS.md: "Do not add a production language plugin in
// the Core MVP" to core packages). `apps/urdira` is the composed
// application entry point that *does* depend on
// `@urdira/plugin-javascript-typescript`, so it is the only place that can
// build the real `WorkspaceScanPluginProvider` the daemon needs to run a
// real workspace scan (`packages/engine/src/workspace-indexing-session.ts`).
//
// Real vs. placeholder, for the record:
//  - The installed bundle's executable "parser" asset is the *real*
//    compiled `@urdira/plugin-javascript-typescript` analyzer
//    (`dist/worker.js`, read directly off disk below).
//  - The bundle's "dependency" provenance asset (standing in for
//    `node_modules/typescript/package.json`) is a synthesized descriptor
//    built from the real pinned `TYPESCRIPT_COMPILER_VERSION` constant, not
//    the literal on-disk `typescript/package.json` bytes. Reading an
//    arbitrary transitive dependency file would need a deep import path
//    this package does not otherwise use; this is flagged as a known,
//    documented limitation rather than treated as fully real provenance.
//  - `analyze()` below calls the real `createJavascriptTypescriptWorker(...)`
//    and its real `.invoke("analyze_artifact", ...)` — this is genuine
//    TypeScript-checker analysis, not a stub.

async function javascriptTypescriptWorkerAssetBytes(): Promise<Uint8Array> {
  const indexUrl = import.meta.resolve("@urdira/plugin-javascript-typescript");
  // `dist/worker.js` ships alongside `dist/index.js` in the published
  // package (`package.json`'s `files: ["dist"]`), so a sibling URL
  // resolution here needs no separate `exports` subpath entry.
  const workerUrl = new URL("worker.js", indexUrl);
  return new Uint8Array(await readFile(fileURLToPath(workerUrl)));
}

async function javascriptTypescriptBundleAssets(): Promise<readonly JavascriptTypescriptPackageAsset[]> {
  const workerBytes = await javascriptTypescriptWorkerAssetBytes();
  const typescriptDependencyDescriptor = new TextEncoder().encode(JSON.stringify({ name: "typescript", version: TYPESCRIPT_COMPILER_VERSION }));
  return [
    { normalized_relative_path: "dist/worker.js", bytes: workerBytes, executable: true, role: "parser" },
    { normalized_relative_path: "node_modules/typescript/package.json", bytes: typescriptDependencyDescriptor, executable: false, role: "dependency" },
  ];
}

interface PreparedJavascriptTypescriptRegistry {
  readonly registry: AssembledPluginRegistry;
  readonly lock: SdkPluginResolutionLock;
  readonly plugin: DiscoveredPluginPackage;
}

/** The second parameter `resolve_plugin_provider` (`@urdira/daemon`'s `DaemonRuntimeOptions`) is called with -- extracted as a type alias so this file can read a workspace's own database without adding a new cross-layer package dependency (`@urdira/storage` stays reached only through `@urdira/engine`, matching `architecture/manifest.json`'s allowed dependency edges for this app). */
type PluginResolverDatabase = Parameters<NonNullable<DaemonRuntimeOptions["resolve_plugin_provider"]>>[1];

/**
 * `resolution_lock_id` is salted by a fingerprint of the resolution INPUT
 * (resolver version, supported contract versions, requirements, pins, and
 * every discovered package's identity/version/digests -- see
 * `resolutionInputFingerprint` below), not a pure function of `workspaceId`
 * alone. `registry_snapshot_id`/`configuration_revision_id` are in turn
 * derived from `resolved.lock.resolution_lock_id` (see below and
 * `createResolveJavascriptTypescriptPluginProvider`), so all three cascade
 * together whenever the fingerprint changes -- which happens exactly when a
 * plugin rebuild changes what resolution would produce (see
 * docs/decisions/14-plugin-upgrade-relock.md).
 *
 * Why this salt exists: `PluginResolutionLock.created_at` is stamped fresh
 * from `clock()` on every resolution that doesn't reuse an existing lock.
 * `createResolveJavascriptTypescriptPluginProvider`'s in-process `prepared`
 * cache (below) already prevents re-resolution across scans of the *same
 * daemon process lifetime*, but that cache is pure memory: a daemon restart
 * (or a plugin rebuild) between two scans of an already-published workspace
 * forces a fresh resolution. If the resulting lock's `resolution_lock_id`
 * were unchanged (the old pure-`workspaceId` scheme), it would still be
 * written under the *same* `plugin_resolution_lock:${resolution_lock_id}`
 * control-plane `state_key` a prior scan already durably wrote, and
 * `StorageMaintenance`'s `assertPublicationImmutableRows`
 * (`packages/storage/src/publication-authority.ts`) byte-compares that row
 * on every subsequent publish: a changed payload (different `created_at`,
 * or -- after a real plugin upgrade -- different `resolved_plugins`) under
 * the same id throws `storage:publication_conflict` on every retry,
 * permanently blocking that workspace's next publish. So a genuinely
 * changed resolution MUST mint a new lock id; a genuinely unchanged one
 * must not (to avoid needless republication), which is exactly what
 * content-salting gives for free.
 *
 * The existing-lock lookup below is two-step for the same reason a legacy
 * unsalted `lock:${workspaceId}` id (from before this salting existed) must
 * keep working: it reads back both (a) whatever lock id the workspace's
 * `workspace_current_state.current_resolution_lock_id` currently points at
 * (legacy or salted, whichever this workspace last published), and (b) any
 * lock already persisted under *this* resolution's own salted id (relevant
 * for an A-\>B-\>A plugin revert, where the salted id returns to a value
 * this workspace has seen before). `PluginResolver.resolve`'s own
 * `preserveExistingLock` (`@urdira/plugin-sdk`'s `resolution.ts`) is
 * already built to return a still-compatible existing lock verbatim
 * (original `created_at` included) instead of minting a new one; the
 * `replay` step below (see its own comment) additionally lets a revert
 * reuse the salted lock exactly rather than re-freezing a brand new one
 * with a fresh `created_at` that would again collide on republish.
 */
function resolutionInputFingerprint(discoveredPackages: readonly DiscoveredPluginPackage[]): string {
  const packages = [...discoveredPackages].sort((left, right) => (left.plugin_id < right.plugin_id ? -1 : left.plugin_id > right.plugin_id ? 1 : 0)).map((item) => ({
    plugin_id: item.plugin_id,
    plugin_version: item.plugin_version,
    package_digest: item.package_digest,
    declaration_digest: item.declaration_digest,
    contribution_digest: item.contribution_digest,
    analysis_digest: item.compatibility.analysis_digest,
    analysis_configuration_digest: item.analysis_configuration_digest,
  }));
  return canonicalSha256({
    resolver_version: JAVASCRIPT_TYPESCRIPT_VERSION,
    supported_runtime_contract_versions: [1],
    supported_registry_contract_versions: [1],
    requirements: [{ plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, version_requirement: "*" }],
    pins: [],
    packages,
  });
}

async function prepareJavascriptTypescriptRegistry(workspaceId: string, now: string, database: PluginResolverDatabase): Promise<PreparedJavascriptTypescriptRegistry> {
  const digests = createCanonicalPluginDigestAuthority();
  const assets = await javascriptTypescriptBundleAssets();
  const bundle = createJavascriptTypescriptInstalledBundle({ digests, package_locator: "bundled:jsts", target_triple: `${process.platform}-${process.arch}`, assets });
  const bytesByPath = new Map(assets.map((asset) => [asset.normalized_relative_path, asset.bytes]));
  const discovery = await new PluginPackageDiscovery({
    list: async () => [bundle],
    read_file: async (request) => {
      const bytes = bytesByPath.get(request.normalized_relative_path);
      if (bytes === undefined) throw new Error(`Missing bundled JavaScript/TypeScript asset ${request.normalized_relative_path}.`);
      return { bytes, byte_length: bytes.byteLength };
    },
  }, digests, { max_file_bytes: 8_000_000 }, { max_items: 100, max_depth: 20, max_nodes: 10_000, max_bytes: 8_000_000 }).discover(["bundled"]);
  const fingerprint = resolutionInputFingerprint(discovery.packages);
  const resolutionLockId = `lock:${workspaceId}:${fingerprint.slice("sha256:".length, "sha256:".length + 16)}`;
  // Two-step existing-lock lookup (see the doc comment above): the
  // workspace's currently-published lock (legacy unsalted id or a
  // previously salted one) AND any lock already durably persisted under
  // THIS resolution's own salted id (an A-\>B-\>A revert scenario).
  const currentState = await database.database.get<{ readonly current_resolution_lock_id: string }>("SELECT current_resolution_lock_id FROM workspace_current_state WHERE workspace_id = ?", [workspaceId]);
  const currentLock = currentState === undefined ? undefined : await readPersistedControlState<SdkPluginResolutionLock>(database, workspaceId, `plugin_resolution_lock:${currentState.current_resolution_lock_id}`);
  const saltedLock = await readPersistedControlState<SdkPluginResolutionLock>(database, workspaceId, `plugin_resolution_lock:${resolutionLockId}`);
  const existingLock = currentLock ?? saltedLock;
  const resolutionInput = {
    packages: discovery.packages,
    requirements: [{ plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, version_requirement: parseVersionRequirementText("*") }],
    pins: [],
    supported_runtime_contract_versions: [1],
    supported_registry_contract_versions: [1],
    workspace_id: workspaceId,
    resolver_version: JAVASCRIPT_TYPESCRIPT_VERSION,
    clock: () => now,
    id_source: () => resolutionLockId,
  };
  let resolved = new PluginResolver(digests).resolve({ ...resolutionInput, ...(existingLock === undefined ? {} : { existing_lock: existingLock }) });
  // `A -> B -> A` plugin revert: the fingerprint (and hence `resolutionLockId`)
  // returns to a value this workspace has published under before. The first
  // attempt above only tried `currentLock` (the *most recently* published
  // lock, under B's id) as `existing_lock`, so it freshly resolved instead of
  // preserving -- if it had preserved, `preserved_existing_lock` would
  // already be true and this replay is skipped. Retrying once against
  // `saltedLock` (A's own previously persisted row, `created_at` included)
  // lets that exact row be reused verbatim instead of publishing a brand new
  // lock payload under an id `assertPublicationImmutableRows`
  // (`packages/storage/src/publication-authority.ts`) already has a
  // (necessarily different, since it's freshly stamped) row for.
  if (resolved.ok && !resolved.preserved_existing_lock && saltedLock !== undefined && currentLock !== undefined) {
    const replay = new PluginResolver(digests).resolve({ ...resolutionInput, existing_lock: saltedLock });
    if (replay.ok && replay.preserved_existing_lock) resolved = replay;
  }
  if (!resolved.ok) throw new Error(`JavaScript/TypeScript plugin resolution failed for workspace ${workspaceId}: ${JSON.stringify(resolved.issues)}`);
  const assembled = new PluginRegistryAssembler(digests).assemble({
    packages: resolved.packages,
    lock: resolved.lock,
    registry_snapshot_id: `registry:${workspaceId}:${resolved.lock.resolution_lock_id}`,
    core_registry_digest: canonicalSha256("urdira-core-registry"),
    emission_valid_from_generation: "1",
    clock: () => now,
    id_source: () => `registry-issue:${workspaceId}`,
  });
  if (!assembled.ok) throw new Error(`JavaScript/TypeScript registry assembly failed for workspace ${workspaceId}: ${JSON.stringify(assembled.issues)}`);
  return { registry: assembled.registry as AssembledPluginRegistry, lock: resolved.lock, plugin: resolved.packages[0]! };
}

type AccessManifestEntry = { readonly artifact_id: string; readonly artifact_version_id: string; readonly content_hash: string; readonly access_modes: readonly ["artifact_read"] };

function javascriptTypescriptAccessManifestEntries(artifacts: readonly { readonly artifact_id: string; readonly artifact_version_id: string; readonly content_hash: string }[]): readonly AccessManifestEntry[] {
  return artifacts.map((artifact) => ({ artifact_id: artifact.artifact_id, artifact_version_id: artifact.artifact_version_id, content_hash: artifact.content_hash, access_modes: ["artifact_read"] as const }));
}

// A scan calls this once per owner artifact; the entry array is prebuilt once per
// scan by the caller so only the owner-specific fields are constructed here.
function javascriptTypescriptAccessManifest(workItemId: string, analysisContextDigest: string, entries: readonly AccessManifestEntry[]): AutomaticPluginInputAccessManifest {
  const core = {
    request_id: `request:${workItemId}`,
    analysis_view_digest: analysisContextDigest,
    artifact_version_entries: entries,
    record_entries: [], lookup_entries: [], transitive_artifact_version_ids: [],
  };
  return {
    plugin_input_access_manifest_id: pluginInputAccessManifestId(core.request_id, core.analysis_view_digest),
    ...core,
    manifest_digest: pluginInputAccessManifestDigest(core),
  };
}

function buildJavascriptTypescriptPluginProvider(prepared: PreparedJavascriptTypescriptRegistry, workspaceId: string, registrySnapshotId: string, configurationRevisionId: string, now: string, analysisCacheDir?: string, analysisWorkerPool?: AnalysisWorkerPool<JavascriptTypescriptWorkerDescriptor>, analysisWorkerShardCount = 2): WorkspaceScanPluginProvider {
  const configuration = {
    configuration_revision_id: configurationRevisionId,
    schema_version: 1,
    workspace_id: workspaceId,
    effective_configuration_schema_id: "core:bytes",
    effective_configuration_schema_version: 1,
    effective_configuration: new TextEncoder().encode(JAVASCRIPT_TYPESCRIPT_PLUGIN_ID),
    installation_policy_digest: canonicalSha256("installation"),
    user_policy_digest: canonicalSha256("user"),
    workspace_file_digest: canonicalSha256("workspace"),
    administrative_override_digest: canonicalSha256("admin"),
    analysis_configuration_digest: prepared.plugin.analysis_configuration_digest,
    query_configuration_digest: canonicalSha256("query"),
    resolved_embedding_binding_digests: [],
    // `prepared.lock.created_at`, not the fresh `now` this function is also
    // given for other (genuinely per-call) purposes below: `configurationRevisionId`
    // is derived from `prepared.lock.resolution_lock_id` (see
    // `createResolveJavascriptTypescriptPluginProvider`), which is itself
    // salted by a fingerprint of the resolution input, not `workspaceId`
    // alone -- so it stays fixed across every resolution that reuses (or
    // preserves) the same lock, and only rotates when the lock itself does.
    // This configuration's own stored payload must stay byte-stable
    // whenever its id is reused -- `prepared.lock.created_at` already
    // carries exactly that stability (see `prepareJavascriptTypescriptRegistry`'s
    // own doc comment for the full incident this fixes:
    // `storage:publication_conflict` on a workspace's second scan after a
    // daemon restart, since `now` used to differ across resolutions of the
    // identical, deterministically-keyed row).
    created_at: prepared.lock.created_at,
    reason_code: "core:plugin_activated",
    revision_digest: canonicalSha256({ registrySnapshotId, plugin: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID }),
  };

  // Constant for the lifetime of this provider (every field derives from
  // `prepared`/`analysisCacheDir`, both closed over above, never from a
  // per-scan value) -- computed once here rather than per `analyze()` call
  // both because it never changes, and because the worker pool needs a
  // stable digest to key on across scans (`AnalysisWorkerPool.acquire`'s
  // descriptor-digest-change eviction trigger).
  const workerDescriptor: JavascriptTypescriptWorkerDescriptor = {
    compatibility_declaration_digest: prepared.plugin.compatibility.declaration_digest,
    registry_contribution_digest: prepared.plugin.contribution.contribution_digest,
    analysis_digest: prepared.plugin.compatibility.analysis_digest,
    analysis_configuration_digest: prepared.plugin.analysis_configuration_digest,
    ...(analysisCacheDir === undefined ? {} : { analysis_cache_dir: analysisCacheDir }),
  };
  const workerDescriptorDigest = canonicalSha256(workerDescriptor);

  return {
    supports_progressive_publication: true,
    registry_snapshot_id: registrySnapshotId,
    configuration_revision_id: configurationRevisionId,
    registry: prepared.registry,
    resolution_lock: prepared.lock,
    configuration,
    dependency_roles: [...JAVASCRIPT_TYPESCRIPT_DEPENDENCY_ROLES],
    analyze: async ({ workspace_id, candidate, artifacts, changed_artifact_ids, publication_stage_id }) => {
      const stage = publication_stage_id === undefined
        ? undefined
        : JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES.find((entry) => entry.stage_id === publication_stage_id);
      if (publication_stage_id !== undefined && stage === undefined) throw new Error(`Unknown JavaScript/TypeScript structural stage: ${publication_stage_id}`);
      const stageCapabilities = stage?.capabilities ?? JAVASCRIPT_TYPESCRIPT_CAPABILITIES.map((entry) => entry.capability);
      const completedCapabilities = stage === undefined
        ? stageCapabilities
        : JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES.filter((entry) => entry.ordinal <= stage.ordinal).flatMap((entry) => entry.capabilities);
      // Stage 1 owns the replacement boundary for every record kind. This is
      // intentional: when source changes, stale stage-2/3 records must close
      // before the new declarations become visible. Later stages replace only
      // their own records and retain the preceding immutable stage.
      const stageRecordKinds = stage === undefined || stage.ordinal === 1
        ? [...JAVASCRIPT_TYPESCRIPT_RECORD_KINDS]
        : stage.ordinal === 2
          ? JAVASCRIPT_TYPESCRIPT_RECORD_KINDS.filter((kind) => ["jsts:relation_call", "jsts:relation_references", "jsts:relation_inherits", "jsts:relation_implements"].includes(kind))
          : JAVASCRIPT_TYPESCRIPT_RECORD_KINDS.filter((kind) => kind === "jsts:diagnostic" || kind === "jsts:relation_covers" || kind.startsWith("jsts:entity_"));
      const completeStageEntries = (status: SnapshotCapabilityStateEntry["status"] = "complete"): SnapshotCapabilityStateEntry[] => completedCapabilities.map((capability) => ({
        capability,
        capability_contract_version: "1.0.0",
        provider_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
        provider_version: JAVASCRIPT_TYPESCRIPT_VERSION,
        status,
        reason_codes: [],
        affected_artifact_ids: [],
        diagnostic_record_ids: [],
        ...(stage === undefined ? {} : { publication_stage_id: stage.stage_id, publication_stage_ordinal: stage.ordinal, publication_stage_count: stage.stage_count }),
      }));
      const artifactVersions = artifacts.map((artifact) => ({ artifact_id: artifact.artifact_id, artifact_version_id: artifact.artifact_version_id, content_hash: artifact.content_hash }));
      const targetRegistry = candidateTargetRegistryFromSnapshot({ registry: prepared.registry, artifact_versions: artifactVersions });
      const acceptance = new FactDeltaAcceptanceService();
      // Real analysis: the compiled `@urdira/plugin-javascript-typescript`
      // worker runs the pinned TypeScript checker over the scanned files.
      // Default (`URDIRA_ANALYSIS_THREAD` unset or truthy): a real
      // `node:worker_threads` worker, so the whole-project TypeScript
      // program build + checking never blocks this (the daemon's) event
      // loop. `URDIRA_ANALYSIS_THREAD=0` falls back to the in-process
      // transport (same one direct `createJavascriptTypescriptWorker`
      // callers/tests always use).
      //
      // `analysis_cache_dir` (when `analysisCacheEnabled()` below is on) is
      // what lets THIS worker -- a fresh one, created and hard-terminated
      // once per scan (see `thread-transport.ts`'s header comment) -- skip a
      // from-scratch whole-project rebuild when a prior scan already
      // analyzed the identical (files, root_names, compiler_options) under
      // the identical TypeScript/analyzer build: a daemon restart between
      // two scans of the same workspace, a workspace remove+re-add, a
      // post-fork rescan of a donor's tree, or a plugin-upgrade generation
      // over an otherwise-unchanged tree. See
      // `packages/plugin-javascript-typescript/src/worker.ts`'s
      // `loadOrBuildAnalysis`/`durableAnalysisCacheKey` doc comments and
      // docs/decisions/15-durable-analysis-cache.md for the full design.
      //
      // `analysisWorkerPool` (set unless `URDIRA_ANALYSIS_POOL=0`, see
      // `defaultDaemonOptions`) is what turns "fresh per scan" into "reused
      // across scans of this workspace": a pooled worker's `JsTsAnalysisSession`
      // (held inside the worker -- `packages/plugin-javascript-typescript/src/worker.ts`)
      // keeps a per-file memo across scans, so a content-only edit re-walks
      // only the files that edit could affect instead of the whole project.
      // The pool's own `acquire`/`release` replace this function's own
      // create/terminate; see `apps/urdira/src/analysis-worker-pool.ts`.
      // `URDIRA_ANALYSIS_POOL=0` restores today's exact per-scan behavior.
      const closureWorkerKey = `${workspace_id}:closure`;
      const worker = analysisWorkerPool !== undefined
        ? analysisWorkerPool.acquire(closureWorkerKey, workerDescriptor, workerDescriptorDigest)
        : (analysisThreadEnabled() ? createJavascriptTypescriptThreadTransport(workerDescriptor) : createJavascriptTypescriptWorker(workerDescriptor));
      const sourceArtifacts = artifacts.filter((artifact) => languageForPath(artifact.path) !== undefined);
      const accepted: AcceptedFactDelta[] = [];
      const changedArtifactIds = changed_artifact_ids === undefined ? undefined : new Set(changed_artifact_ids);
      // The JavaScript/TypeScript provider owns only language-plugin source
      // artifacts. A reconciliation that changes only JSON, Markdown, or
      // other non-plugin source still needs the core source snapshot to move
      // forward, but it cannot change a TypeScript fact or dependency
      // closure. Avoid asking the worker to rebuild its whole-project
      // dependency graph in that case; this is the common path for fixture,
      // metadata, and documentation edits observed by the source index.
      // First scans keep the existing full analysis path because there is no
      // prior artifact set from which to prove that the plugin has no work.
      if (changedArtifactIds !== undefined && !sourceArtifacts.some((artifact) => changedArtifactIds.has(artifact.artifact_id))) {
        if (analysisWorkerPool !== undefined) analysisWorkerPool.release(closureWorkerKey);
        else await worker.terminate();
        console.error(`[urdira] analyze timings ${workspace_id} owners=0 ms=${JSON.stringify({ closure: 0, worker_wait: 0, acceptance: 0, skipped: "no_plugin_artifact_changes" })}`);
        return {
          accepted_deltas: accepted,
          capability_state_entries: completeStageEntries(),
        };
      }
      // Hoisted out of the per-owner loop: these aggregate over every scanned
      // artifact, so recomputing them per owner is quadratic in workspace size.
      const inputsDigest = canonicalSha256(artifactVersions);
      const manifestEntries = javascriptTypescriptAccessManifestEntries(artifactVersions);
      const manifestEntriesDigest = canonicalSha256(manifestEntries);
      const rootNames = sourceArtifacts.map((artifact) => artifact.path);
      const artifactsByPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
      // 5.1: fetch every owner's import closure ONCE per scan, up front, via
      // a dedicated `analyze_closure` call over the FULL corpus -- this is
      // the same expensive whole-project analysis `analyze_artifact` would
      // otherwise build lazily on the first owner's call, just moved earlier
      // so every owner's access manifest (and `files` payload, below) can be
      // narrowed to that owner's own closure instead. The worker's
      // content-hash cache (`packages/plugin-javascript-typescript/src/worker.ts`)
      // is keyed on (path, content_hash), not object identity, so this call
      // warms the SAME cache every narrowed `analyze_artifact` call below
      // then hits via subset-reuse -- one whole-project build per scan, not
      // one per owner and not one per narrowed request either.
      const needsSemanticClosure = true;
      const closureRequestId = `request:closure:${workspace_id}:${candidate.candidate_generation_id}`;
      const closureStartedAt = performance.now();
      let closureResponse: {
        readonly payload: {
          readonly dependency_closures: Readonly<Record<string, { readonly files: readonly string[]; readonly complete: boolean }>>;
          readonly impactful_changed_paths?: readonly string[];
        };
      } | undefined;
      let closureWorkerRetained = false;
      try {
        closureResponse = !needsSemanticClosure || sourceArtifacts.length === 0 ? undefined : await worker.invoke({
        protocol_version: "1.0.0", request_id: closureRequestId, request_digest: canonicalSha256({ request_id: closureRequestId, inputs_digest: inputsDigest }), call: "analyze_closure", deadline: "2099-01-01T00:00:00.000Z", cancellation_id: `cancel:${closureRequestId}`,
        payload: { files: artifacts, root_names: rootNames, ...(publication_stage_id === undefined ? {} : { publication_stage_id }) },
      }) as {
        readonly payload: {
          readonly dependency_closures: Readonly<Record<string, { readonly files: readonly string[]; readonly complete: boolean }>>;
          /**
           * Changed paths (a subset of `changedPaths`, below) whose
           * dependent-visible surface actually differs from what the
           * plugin's session had memoized -- see
           * `JsTsSessionAnalyzeResult.impactful_changed_paths`'s doc comment
           * in `packages/plugin-javascript-typescript/src/analyzer.ts`.
           * Omitted (not just an empty array) when the plugin's build path
           * cannot report it (a durable-cache load or a full rebuild), in
           * which case `isAffectedOwner`, below, MUST fall back to its
           * pre-narrowing behavior rather than treat "no field" as "nothing
           * is impactful".
           */
          readonly impactful_changed_paths?: readonly string[];
        };
      } | undefined;
      } finally {
        if (closureResponse === undefined && !closureWorkerRetained) {
          if (analysisWorkerPool !== undefined) analysisWorkerPool.release(closureWorkerKey);
          else await worker.terminate();
        }
      }
      closureWorkerRetained = true;
      const closureMs = needsSemanticClosure ? Math.round(performance.now() - closureStartedAt) : 0;
      const dependencyClosures = closureResponse?.payload.dependency_closures ?? {};
      const impactfulChangedPaths = closureResponse?.payload.impactful_changed_paths === undefined ? undefined : new Set(closureResponse.payload.impactful_changed_paths);
      // 5.3: only owners actually affected by this scan get fresh
      // `analyze_artifact` work; every other owner's records survive
      // untouched via base-record reuse at seal
      // (`packages/engine/src/candidate-materialization.ts`'s `base_records`
      // handling, wired in `packages/engine/src/workspace-indexing-session.ts`)
      // -- they never get a replacement scope this generation, so
      // `matchingBaseRecords` never even considers closing them.
      // `changed_artifact_ids === undefined` means a genuine first scan (no
      // prior generation to reuse anything from): affected = every owner.
      // Otherwise: an owner is ALWAYS affected by its own content changing.
      // For everything else, when the plugin reported `impactful_changed_paths`
      // (an array -- see above), an owner with a complete closure is affected
      // only if that closure intersects the IMPACTFUL subset, not the whole
      // changed set -- a hub file's dependents skip republishing entirely
      // when the edit provably couldn't change any dependent's output (e.g.
      // a comment). When the plugin did NOT report it (durable-cache load or
      // full rebuild), fall back to today's exact behavior: any file inside
      // the closure changing is enough (`closure.files` already includes the
      // owner's own path, so a single "does this closure intersect the
      // changed set" check covers both cases). Either way, a missing or
      // incomplete closure means the true dependency set is unknown, so the
      // only safe choice is to treat that owner as affected rather than risk
      // silently skipping a real dependent.
      const changedPaths = changedArtifactIds === undefined ? undefined : new Set(artifacts.filter((artifact) => changedArtifactIds.has(artifact.artifact_id)).map((artifact) => artifact.path));
      const isAffectedOwner = (owner: WorkspaceScanSourceArtifact): boolean => {
        if (changedPaths === undefined) return true;
        if (changedPaths.has(owner.path)) return true;
        const closure = dependencyClosures[owner.path];
        if (closure === undefined || !closure.complete) return true;
        if (impactfulChangedPaths !== undefined) return closure.files.some((path) => impactfulChangedPaths.has(path));
        return closure.files.some((path) => changedPaths.has(path));
      };
      const affectedOwners = sourceArtifacts.filter(isAffectedOwner);
      // Per-owner plans (work item, replacement scope, access manifest, and
      // the worker request envelope) are pure, cheap, synchronous
      // computations over already-known data -- precomputing all of them
      // upfront lets the loop below pipeline `worker.invoke` for owner i+1
      // with `acceptance.accept` (CPU-bound, main-thread) for owner i,
      // instead of the two ever waiting on each other.
      const plans = affectedOwners.map((owner) => {
        const workItemId = `work:${owner.artifact_id}`;
        const contextDigest = canonicalSha256({ registry: prepared.registry.registry_digest, owner: owner.artifact_version_id, inputs_digest: inputsDigest });
        const scope: ReplacementScope = {
          replacement_scope_id: `scope:${owner.artifact_id}`, owner_artifact_id: owner.artifact_id, owner_artifact_version_id: owner.artifact_version_id,
          capability: stageCapabilities[0] ?? "core:call_relationships", record_categories: ["diagnostic", "entity", "relation"], record_kinds: stageRecordKinds,
          base_record_set_digest: canonicalSha256([]), output_completeness: "accept_reported",
        };
        const workItem = {
          work_item_id: workItemId, workspace_id, artifact_id: owner.artifact_id, target_artifact_version_id: owner.artifact_version_id,
          operation: "full", plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, plugin_version: JAVASCRIPT_TYPESCRIPT_VERSION,
          capabilities: stageCapabilities, expected_replacement_scopes: [scope], reason_codes: ["core:artifact_changed"], cause_references: [],
          analysis_context_digest: contextDigest, work_item_digest: canonicalSha256({ workItemId, contextDigest }), candidate_generation_id: candidate.candidate_generation_id,
          // `FactDeltaAcceptanceService`'s `validateIdentity`
          // (`packages/engine/src/fact-delta.ts`) rejects a delta whose
          // `base_snapshot_id` disagrees with the candidate's once the
          // candidate has one (every rescan of an already-published
          // workspace, since `runFullWorkspaceScan` sets it) -- the JS/TS
          // worker's `fact-delta.ts` reads this straight off the work item,
          // so it must be echoed here. Pre-existing gap: no test exercised a
          // real rescan through this real (non-test-only) provider before
          // Phase 5's `analyze_closure` round-trip made writing one
          // necessary, so every second-and-later scan of a real workspace
          // (through the real daemon, not a test's hand-rolled provider) was
          // silently broken.
          ...(candidate.base_snapshot_id === undefined ? {} : { base_snapshot_id: candidate.base_snapshot_id }),
        } satisfies ArtifactWorkItem & { readonly candidate_generation_id: string; readonly base_snapshot_id?: string };
        // Narrow to the owner's own import closure when the plugin reported
        // one AND marked it complete; fall back to every scanned artifact
        // otherwise (missing entry, or `complete: false` -- an unresolved
        // local import means the true closure is unknown, so the only safe
        // choice is "could be anything"). `crossArtifactDependencies`
        // (`packages/plugin-javascript-typescript/src/fact-delta.ts`) needs
        // every cross-file relation TARGET's artifact version to be inside
        // this manifest, and the closure is built (in `analyzer.ts`'s
        // `relate`) to be a superset of exactly that.
        const closure = dependencyClosures[owner.path];
        const narrowed = closure !== undefined && closure.complete;
        const ownerArtifacts = narrowed
          ? closure.files.map((path) => artifactsByPath.get(path)).filter((artifact): artifact is WorkspaceScanSourceArtifact => artifact !== undefined)
          : artifacts;
        const ownerManifestEntries = narrowed ? javascriptTypescriptAccessManifestEntries(ownerArtifacts.map((artifact) => ({ artifact_id: artifact.artifact_id, artifact_version_id: artifact.artifact_version_id, content_hash: artifact.content_hash }))) : manifestEntries;
        const manifest = javascriptTypescriptAccessManifest(workItemId, contextDigest, ownerManifestEntries);
        const analysisInputDigest = canonicalSha256({ owner: owner.path, inputs_digest: narrowed ? canonicalSha256(ownerManifestEntries) : manifestEntriesDigest });
        const request = {
          protocol_version: "1.0.0", request_id: manifest.request_id, request_digest: analysisInputDigest, call: "analyze_artifact" as const, deadline: "2099-01-01T00:00:00.000Z", cancellation_id: `cancel:${workItemId}`,
          payload: { files: ownerArtifacts, root_names: narrowed ? closure.files : rootNames, owner_path: owner.path, work_item: workItem, accepted_manifest: manifest, analysis_digest: prepared.plugin.compatibility.analysis_digest, analysis_configuration_digest: prepared.plugin.analysis_configuration_digest, analysis_input_digest: analysisInputDigest, created_at: now, ...(publication_stage_id === undefined ? {} : { publication_stage_id }) },
        };
        return { workItem, scope, manifest, contextDigest, request };
      });
      const shardCount = Math.max(1, Math.min(analysisWorkerShardCount, plans.length || 1));
      const shards = Array.from({ length: shardCount }, (_, shard) => plans.filter((_, index) => index % shardCount === shard));
      const invokeShard = async (shard: typeof plans, shardIndex: number): Promise<readonly { readonly plan: typeof plans[number]; readonly response: { readonly payload: { readonly validation_input: { readonly raw_delta: unknown } } } }[]> => {
        if (shard.length === 0) return [];
        const shardKey = `${workspace_id}:shard:${shardIndex}`;
        const ownsClosureWorker = shardIndex === 0;
        const shardWorker = ownsClosureWorker
          ? worker
          : analysisWorkerPool !== undefined
            ? analysisWorkerPool.acquire(shardKey, workerDescriptor, workerDescriptorDigest)
            : (analysisThreadEnabled() ? createJavascriptTypescriptThreadTransport(workerDescriptor) : createJavascriptTypescriptWorker(workerDescriptor));
        try {
          if (!ownsClosureWorker && sourceArtifacts.length > 0) {
            const shardClosureRequestId = `request:closure:${workspace_id}:${candidate.candidate_generation_id}:shard:${shardIndex}`;
            await shardWorker.invoke({
              protocol_version: "1.0.0",
              request_id: shardClosureRequestId,
              request_digest: canonicalSha256({ request_id: shardClosureRequestId, inputs_digest: inputsDigest }),
              call: "analyze_closure",
              deadline: "2099-01-01T00:00:00.000Z",
              cancellation_id: `cancel:${shardClosureRequestId}`,
              payload: { files: artifacts, root_names: rootNames, ...(publication_stage_id === undefined ? {} : { publication_stage_id }) },
            });
          }
          const results: { plan: typeof plans[number]; response: { readonly payload: { readonly validation_input: { readonly raw_delta: unknown } } } }[] = [];
          let pending = shardWorker.invoke(shard[0]!.request);
          pending.catch(() => undefined);
          for (let index = 0; index < shard.length; index += 1) {
            const response = await pending as { readonly payload: { readonly validation_input: { readonly raw_delta: unknown } } };
            results.push({ plan: shard[index]!, response });
            if ((index + 1) % 100 === 0 || index + 1 === shard.length) console.error(`[urdira] analyze shard progress workspace=${workspace_id} stage=${publication_stage_id ?? "full"} shard=${shardIndex} completed=${index + 1}/${shard.length}`);
            if (index + 1 < shard.length) {
              pending = shardWorker.invoke(shard[index + 1]!.request);
              pending.catch(() => undefined);
            }
          }
          return results;
        } finally {
          if (ownsClosureWorker) {
            if (analysisWorkerPool !== undefined) analysisWorkerPool.release(closureWorkerKey);
            else await shardWorker.terminate();
            closureWorkerRetained = false;
          } else if (analysisWorkerPool !== undefined) analysisWorkerPool.release(shardKey);
          else await shardWorker.terminate();
        }
      };
      const workerStartedAt = performance.now();
      const shardResults = (await Promise.all(shards.map((shard, shardIndex) => invokeShard(shard, shardIndex)))).flat();
      if (plans.length === 0 && closureWorkerRetained) {
        if (analysisWorkerPool !== undefined) analysisWorkerPool.release(closureWorkerKey);
        else await worker.terminate();
        closureWorkerRetained = false;
      }
      const responses = new Map(shardResults.map((entry) => [entry.plan.workItem.work_item_id, entry]));
      const acceptanceStartedAt = performance.now();
      for (const plan of plans) {
        const result = responses.get(plan.workItem.work_item_id);
        if (result === undefined) throw new Error(`Missing analysis response for ${plan.workItem.work_item_id}.`);
        accepted.push(await acceptance.accept({ candidate, work_item: plan.workItem, raw_delta: result.response.payload.validation_input.raw_delta, accepted_manifest: plan.manifest, expected_replacement_scopes: [plan.scope], target_registry: targetRegistry, base_records: [], base_record_dependencies: [], staged_records: [], analysis_context_digest: plan.contextDigest }));
      }
      console.error(`[urdira] analyze timings ${workspace_id} owners=${plans.length} ms=${JSON.stringify({ closure: closureMs, worker_wait: Math.round(performance.now() - workerStartedAt), acceptance: Math.round(performance.now() - acceptanceStartedAt), shards: shardCount })}`);
      const claims = accepted.flatMap((delta) => delta.delta.completeness_claims);
      const reasonCodes = [...new Set(claims.flatMap((claim) => JSON.parse(claim.reason_codes) as string[]))].sort();
      const affectedArtifactIds = [...new Set(claims.flatMap((claim) => JSON.parse(claim.affected_artifact_ids) as string[]))].sort();
      const capability_state_entries: SnapshotCapabilityStateEntry[] = completedCapabilities.map((capability) => ({
        capability,
        capability_contract_version: "1.0.0",
        provider_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
        provider_version: JAVASCRIPT_TYPESCRIPT_VERSION,
        status: stage === undefined || stage.ordinal < 3 || !stageCapabilities.includes(capability) ? "complete" : claims.filter((claim) => claim.capability === capability).every((claim) => claim.status === "complete") ? "complete" : "partial",
        reason_codes: reasonCodes,
        affected_artifact_ids: affectedArtifactIds,
        diagnostic_record_ids: [],
        ...(stage === undefined ? {} : { publication_stage_id: stage.stage_id, publication_stage_ordinal: stage.ordinal, publication_stage_count: stage.stage_count }),
      }));
      return { accepted_deltas: accepted, capability_state_entries };
    },
  };
}

/**
 * Resolves the real `WorkspaceScanPluginProvider` for a workspace that has
 * activated the bundled JavaScript/TypeScript plugin. Returns `undefined`
 * when the workspace has not selected it, in which case the workspace
 * cannot be indexed yet (see `packages/daemon/src/runtime.ts`'s
 * `scheduleWorkspaceScan` for the resulting failure semantics).
 *
 * Caches `prepareJavascriptTypescriptRegistry`'s result (and the `now` it
 * was built with) per workspace id, one factory instance per daemon
 * (`defaultDaemonOptions` calls this factory once per `DaemonRuntime.start`).
 * Without this, every call built a FRESH registry/resolution-lock stamped
 * with `new Date().toISOString()` -- content that storage's
 * `assertPublicationImmutableRows` (`packages/storage/src/publication-authority.ts`)
 * requires be byte-identical every time the SAME `resolution_lock_id`/
 * `registry_snapshot_id` is republished. `resolution_lock_id` is now salted
 * by a fingerprint of the resolution input (see
 * `prepareJavascriptTypescriptRegistry`'s doc comment), not a pure function
 * of `workspace_id` alone, so `registry_snapshot_id`/`configuration_revision_id`
 * (both lock-derived, below) rotate together whenever that fingerprint
 * changes -- e.g. a plugin rebuild -- and stay fixed when it doesn't. Before
 * this cache existed, a fresh, unstable `created_at` on every call meant
 * every rescan after the first deterministically hit
 * `storage:publication_conflict` even with the id scheme unchanged -- a
 * workspace could never actually be rescanned in production. No test
 * exercised a real second scan through this real (non-test-only) provider
 * before Phase 5 needed one for the closure-narrowing work, so this was
 * never caught.
 *
 * This in-process cache alone is NOT sufficient, though: it is pure memory,
 * scoped to one daemon process's lifetime. A daemon restart between two
 * scans of the same, already-published workspace loses it, forcing a fresh
 * resolution with a new `created_at` under the identical, deterministically-
 * keyed `plugin_resolution_lock`/`workspace_configuration_revision` rows a
 * prior process already durably wrote -- hitting the exact same
 * `storage:publication_conflict` this cache was built to prevent, just on a
 * longer timescale. `prepareJavascriptTypescriptRegistry`'s own two-step
 * `existing_lock` read-back (via `readPersistedControlState`) closes that
 * remaining gap by making the *persisted* row(s), not just the in-memory
 * cache, the source of truth for whether a fresh resolution is needed --
 * and, when the fingerprint genuinely did change (a real plugin upgrade,
 * not just a restart), mints a new, distinct lock id instead of colliding
 * with the immutable row the prior resolution already wrote. See
 * docs/decisions/14-plugin-upgrade-relock.md for the full design.
 */
function createResolveJavascriptTypescriptPluginProvider(analysisCacheDir?: string, analysisWorkerPool?: AnalysisWorkerPool<JavascriptTypescriptWorkerDescriptor>, analysisWorkerShardCount = 2): NonNullable<DaemonRuntimeOptions["resolve_plugin_provider"]> {
  const prepared = new Map<string, Promise<{ readonly registry: PreparedJavascriptTypescriptRegistry; readonly now: string }>>();
  return async (workspace, database) => {
    if (!(workspace.selected_plugin_ids ?? []).includes(JAVASCRIPT_TYPESCRIPT_PLUGIN_ID)) return undefined;
    let entry = prepared.get(workspace.workspace_id);
    if (entry === undefined) {
      const now = new Date().toISOString();
      entry = prepareJavascriptTypescriptRegistry(workspace.workspace_id, now, database).then((registry) => ({ registry, now }));
      prepared.set(workspace.workspace_id, entry);
    }
    const { registry, now } = await entry;
    const registrySnapshotId = registry.registry.registry_snapshot_id;
    const configurationRevisionId = `configuration:${workspace.workspace_id}:${registry.lock.resolution_lock_id}`;
    return buildJavascriptTypescriptPluginProvider(registry, workspace.workspace_id, registrySnapshotId, configurationRevisionId, now, analysisCacheDir, analysisWorkerPool, analysisWorkerShardCount);
  };
}

function positiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

// URDIRA_WARM_RECORDS_BUDGET_MB: LRU byte budget (megabytes) for warm
// per-workspace decoded record caches -- see `DaemonRuntimeOptions.warm_records_budget_mb`'s
// own doc comment (`packages/daemon/src/runtime.ts`). Unlike `positiveIntegerEnv`
// above, `0` is a valid, meaningful override (disables warm caching
// entirely) rather than a rejected value -- so this accepts any
// non-negative safe integer and only falls back to `undefined` (the
// runtime's own default, 3072) for a genuinely negative, non-numeric, or
// unset value.
function warmRecordsBudgetMbEnv(): number | undefined {
  const raw = process.env["URDIRA_WARM_RECORDS_BUDGET_MB"];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// Default ON: a kill switch, not an opt-in. Lexical projection generation
// (`lexical_documents`/`lexical_trigrams`) now runs as an async, post-ready
// maintenance job (`reconcileLexicalProjection`, `@urdira/engine`'s
// `lexical-reconciler.ts`, submitted by `packages/daemon/src/runtime.ts`'s
// `submitLexicalMaintenance` after every successful scan) rather than
// inline during the scan itself -- it reads source text from CAS, never the
// filesystem, and its own try/catch means a failure can never turn a
// successful scan into a failed one. `core:search_text` prefers this
// trigram-backed pushdown once it catches up (real file-text search), and
// transparently falls back to the existing in-memory corpus scan otherwise.
// `URDIRA_LEXICAL_INDEX=0` (or `false`/`off`/`no`) disables the maintenance
// job entirely, leaving `core:search_text` on the corpus-scan path forever.
function lexicalIndexEnabled(): boolean {
  const raw = process.env["URDIRA_LEXICAL_INDEX"];
  if (raw === undefined || raw === "") return true;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

// Default ON: a kill switch, not an opt-in. Mirrors `lexicalIndexEnabled()`
// above exactly, one layer over: vector projection generation
// (`vector_projection_rows`) now runs as an async, post-ready maintenance job
// (`reconcileSemanticProjection`, `@urdira/engine`'s `semantic-reconciler.ts`,
// submitted by `packages/daemon/src/runtime.ts`'s `submitSemanticMaintenance`
// after every successful scan/fork, and on startup for every already-ready
// workspace) rather than inline during the scan itself -- it reads source
// text from CAS, never the filesystem, and its own try/catch means a failure
// can never turn a successful scan into a failed one. `core:search_semantic`/
// `core:search_hybrid` are unavailable (or, for hybrid, degrade to a
// lexical-only lane) until this catches up. `URDIRA_SEMANTIC_INDEX=0` (or
// `false`/`off`/`no`) disables the maintenance job entirely, leaving both
// operations permanently unavailable (`core:semantic_index_unavailable` for
// `search_semantic`; a lexical-only lane for `search_hybrid`).
function semanticIndexEnabled(): boolean {
  const raw = process.env["URDIRA_SEMANTIC_INDEX"];
  if (raw === undefined || raw === "") return true;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

/**
 * Builds the `SemanticProviderDescriptor` (PINNED shape, `@urdira/daemon`)
 * `defaultDaemonOptions` threads into `DaemonRuntimeOptions.semantic_descriptor`.
 * Configure-time model provisioning (USER DECISION, 2026-08-13, superseding
 * this file's own prior async-provider-construction-at-startup design): this
 * function does PURE ENV PARSING ONLY -- no network access, no ONNX model
 * load, no `@urdira/embedding-local` import at all (this app no longer
 * imports that package directly; only `@urdira/daemon` does, lazily, inside
 * its own `semantic-provider-runtime.ts`). Building the actual provider
 * instance (and, for the neural default, downloading its on-disk model) is
 * entirely `@urdira/daemon`'s own responsibility now, run at the three
 * configure-time admin RPCs, never at this app's own startup and never on
 * first query/index use -- see `packages/daemon/src/runtime.ts`'s
 * `ensureAndActivateSemanticProvider`. A construction/download failure is
 * therefore no longer this function's concern either: `DaemonRuntime` warns
 * and runs with semantic effectively unavailable until a later configure
 * call succeeds, rather than this app ever needing to catch an async
 * construction error or pass `semantic_index: false` itself.
 *
 * 1. `URDIRA_EMBEDDINGS_ENDPOINT` set -> `{kind: "http", ...}`, an opt-in
 *    OpenAI-compatible HTTP provider (unchanged validation from before this
 *    decision). `URDIRA_EMBEDDINGS_MODEL`/`URDIRA_EMBEDDINGS_DIMENSIONS` are
 *    REQUIRED alongside the endpoint (an `EmbeddingProfile`'s identity, and
 *    therefore every vector row's comparability, is a function of both --
 *    see `createHttpEmbeddingProvider`'s doc comment, `@urdira/engine`'s
 *    `semantic-provider.ts`): a missing or non-numeric value throws a clear
 *    startup `Error` naming the offending variable rather than silently
 *    building a descriptor with a nonsensical dimensionality.
 *    `URDIRA_EMBEDDINGS_API_KEY` is optional (an HTTP provider with no API
 *    key is a legitimate configuration for a self-hosted, unauthenticated
 *    embeddings endpoint).
 * 2. `URDIRA_EMBEDDINGS_PROVIDER=hash` -> `{kind: "hash"}`, the pure-JS,
 *    offline, dependency-free hashing-trick embedder. An explicit dev/test
 *    escape hatch -- e.g. CI or a constrained environment that cannot run an
 *    ONNX model at all -- not the shipped default.
 * 3. Otherwise (the shipped default) -> `{kind: "neural", cache_dir: <data_root>/models, ...}`.
 *    `URDIRA_LOCAL_EMBEDDINGS_MODEL`/`URDIRA_LOCAL_EMBEDDINGS_DTYPE`
 *    optionally override its `model_id`/`dtype`.
 */
function resolveSemanticDescriptor(dataRoot: string): SemanticProviderDescriptor {
  const endpoint = process.env["URDIRA_EMBEDDINGS_ENDPOINT"];
  if (endpoint !== undefined && endpoint !== "") {
    const model = process.env["URDIRA_EMBEDDINGS_MODEL"];
    if (model === undefined || model === "") throw new Error("URDIRA_EMBEDDINGS_ENDPOINT is set but URDIRA_EMBEDDINGS_MODEL is missing -- both are required to configure an HTTP embedding provider.");
    const dimensionsRaw = process.env["URDIRA_EMBEDDINGS_DIMENSIONS"];
    if (dimensionsRaw === undefined || dimensionsRaw === "") throw new Error("URDIRA_EMBEDDINGS_ENDPOINT is set but URDIRA_EMBEDDINGS_DIMENSIONS is missing -- both are required to configure an HTTP embedding provider.");
    const dimensions = Number(dimensionsRaw);
    if (!Number.isSafeInteger(dimensions) || dimensions <= 0) throw new Error(`URDIRA_EMBEDDINGS_DIMENSIONS must be a positive integer; received "${dimensionsRaw}".`);
    const apiKey = process.env["URDIRA_EMBEDDINGS_API_KEY"];
    return { kind: "http", endpoint, model, dimensions, ...(apiKey === undefined || apiKey === "" ? {} : { api_key: apiKey }) };
  }
  if ((process.env["URDIRA_EMBEDDINGS_PROVIDER"] ?? "").toLowerCase() === "hash") {
    return { kind: "hash" };
  }
  const localModel = process.env["URDIRA_LOCAL_EMBEDDINGS_MODEL"];
  const localDtype = process.env["URDIRA_LOCAL_EMBEDDINGS_DTYPE"];
  return {
    kind: "neural",
    cache_dir: join(dataRoot, "models"),
    ...(localModel === undefined || localModel === "" ? {} : { model_id: localModel }),
    ...(localDtype === undefined || localDtype === "" ? {} : { dtype: localDtype }),
  };
}

// Default ON: a kill switch, not an opt-in. See `DaemonRuntimeOptions.lexical_thread`'s
// doc comment (`packages/daemon/src/runtime.ts`) -- mirrors `URDIRA_ANALYSIS_THREAD`
// below for the same reason: the lexical maintenance job (when
// `lexicalIndexEnabled()` above is also on) runs its per-document trigram
// computation in a dedicated `node:worker_threads` worker instead of on the
// daemon's own event loop. `URDIRA_LEXICAL_THREAD=0` (or `false`/`off`/`no`)
// forces the prior in-process path instead -- e.g. to rule out the worker
// thread when diagnosing an issue.
function lexicalThreadEnabled(): boolean {
  const raw = process.env["URDIRA_LEXICAL_THREAD"];
  if (raw === undefined || raw === "") return true;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

// Default ON: a kill switch, not an opt-in. See `DaemonRuntimeOptions.semantic_thread`'s
// doc comment (`packages/daemon/src/runtime.ts`) -- mirrors `lexicalThreadEnabled()`
// above exactly, one layer over: the semantic maintenance job (when
// `semanticIndexEnabled()` above is also on, and the active provider
// resolved from a plain `semantic_descriptor` rather than an instance
// override) runs its embedding work in a dedicated `node:worker_threads`
// worker instead of on the daemon's own event loop. `URDIRA_SEMANTIC_THREAD=0`
// (or `false`/`off`/`no`) forces the prior in-process path instead -- e.g.
// to rule out the worker thread when diagnosing an issue.
function semanticThreadEnabled(): boolean {
  const raw = process.env["URDIRA_SEMANTIC_THREAD"];
  if (raw === undefined || raw === "") return true;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

// Native neural embeddings are isolated in child processes by default. The
// legacy URDIRA_SEMANTIC_THREAD setting remains a compatibility alias when
// URDIRA_SEMANTIC_PROCESS is not set.
function semanticProcessEnabled(): boolean {
  const raw = process.env["URDIRA_SEMANTIC_PROCESS"];
  if (raw === undefined || raw === "") return semanticThreadEnabled();
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

// Default ON: a kill switch, not an opt-in. See `DaemonRuntimeOptions.workspace_fork`'s
// doc comment (`packages/daemon/src/runtime.ts`) and docs/decisions/12-workspace-fork.md
// for what this gates. `URDIRA_WORKSPACE_FORK=0` (or `false`/`off`/`no`) disables the
// fork attempt entirely, leaving every first-ever workspace scan on the full-scan path.
function workspaceForkEnabled(): boolean {
  const raw = process.env["URDIRA_WORKSPACE_FORK"];
  if (raw === undefined || raw === "") return true;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

// See `DaemonRuntimeOptions.workspace_fork_verify`'s doc comment
// (`packages/daemon/src/runtime.ts`) for what this gates: `URDIRA_FORK_VERIFY=full`
// opts a workspace fork's own publish into the slower, whole-database
// `StorageMaintenance.verify()` gate instead of the default fast check.
// Anything else (including unset) leaves `WorkspaceForkOptions.verify_mode`
// unset, which `attemptWorkspaceFork` itself defaults to `"fast"`.
function workspaceForkVerifyMode(): "fast" | "full" | undefined {
  const raw = process.env["URDIRA_FORK_VERIFY"];
  return raw?.toLowerCase() === "full" ? "full" : undefined;
}

// Default ON: analysis (TypeScript program build + checking) runs in a real
// `node:worker_threads` worker (see `createJavascriptTypescriptThreadTransport`,
// `@urdira/plugin-javascript-typescript`) so it no longer blocks the daemon's
// event loop for minutes on a large workspace. `URDIRA_ANALYSIS_THREAD=0`
// (or `false`/`off`) forces the in-process transport instead -- e.g. to rule
// out the worker thread when diagnosing an issue. Direct
// `createJavascriptTypescriptWorker(...)` callers (tests, and this file's
// own in-process fallback) are unaffected either way: only
// `buildJavascriptTypescriptPluginProvider`'s choice of transport reads this.
function analysisThreadEnabled(): boolean {
  const raw = process.env["URDIRA_ANALYSIS_THREAD"];
  if (raw === undefined || raw === "") return true;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

// Default ON: a kill switch, not an opt-in. Gates the durable (on-disk)
// whole-project analysis cache (`analysis_cache_dir` on the JS/TS worker
// descriptor, see `buildJavascriptTypescriptPluginProvider` above and
// `packages/plugin-javascript-typescript/src/worker.ts`'s
// `loadOrBuildAnalysis`) -- without it, every one-thread-per-scan worker
// (see `thread-transport.ts`'s header comment) pays a full ~42s
// whole-project TypeScript build on EVERY scan, even a daemon restart or a
// remove+re-add of a workspace whose tree hasn't changed at all.
// `URDIRA_ANALYSIS_CACHE=0` (or `false`/`off`/`no`) disables it, forcing
// every scan back onto the from-scratch build path -- e.g. to rule out a
// stale or corrupt on-disk entry when diagnosing an analysis discrepancy, or
// to avoid the cache directory's disk usage entirely.
function analysisCacheEnabled(): boolean {
  const raw = process.env["URDIRA_ANALYSIS_CACHE"];
  if (raw === undefined || raw === "") return true;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

// Default ON: a kill switch, not an opt-in. Gates the per-workspace analysis
// worker pool (`AnalysisWorkerPool`, `apps/urdira/src/analysis-worker-pool.ts`):
// without it, `buildJavascriptTypescriptPluginProvider`'s `analyze()` creates
// a fresh worker every scan and hard-terminates it in `finally` (today's
// long-standing behavior, and still exactly what `URDIRA_ANALYSIS_POOL=0`
// restores) -- which also means every worker's `JsTsAnalysisSession`
// (`packages/plugin-javascript-typescript/src/worker.ts`) starts from
// nothing every scan, since it never survives past that scan's `terminate()`.
// Pooling is what lets a rescan of an already-scanned, mostly-unchanged
// workspace reuse the SAME worker -- and therefore its session's per-file
// memo -- instead of paying the whole-project TypeScript walk again.
function analysisPoolEnabled(): boolean {
  const raw = process.env["URDIRA_ANALYSIS_POOL"];
  if (raw === undefined || raw === "") return true;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

/** Prune cap: at most this many pooled analysis workers stay alive across
 * every workspace at once (LRU eviction beyond it). Default 2. */
function analysisPoolMaxEntries(): number {
  return positiveIntegerEnv("URDIRA_ANALYSIS_POOL_MAX") ?? 2;
}

/** Number of independent analysis workers used for owner sharding. */
function analysisWorkerShardCount(): number {
  return positiveIntegerEnv("URDIRA_ANALYSIS_WORKERS") ?? 2;
}

/** Idle time after a scan releases a pooled worker before it is proactively
 * evicted. Default 300000ms (5 minutes). */
function analysisPoolIdleTtlMs(): number {
  return positiveIntegerEnv("URDIRA_ANALYSIS_POOL_TTL_MS") ?? 300_000;
}

export async function defaultDaemonOptions(dataRoot = process.env["URDIRA_DATA_ROOT"] ?? join(homedir(), ".urdira")): Promise<DaemonRuntimeOptions> {
  const scanBudgetMs = positiveIntegerEnv("URDIRA_SCAN_BUDGET_MS");
  const scanMaxResponseBytes = positiveIntegerEnv("URDIRA_SCAN_MAX_RESPONSE_BYTES");
  const scanBudget = scanBudgetMs === undefined && scanMaxResponseBytes === undefined ? undefined : {
    ...(scanBudgetMs === undefined ? {} : { max_duration_ms: scanBudgetMs }),
    ...(scanMaxResponseBytes === undefined ? {} : { max_response_bytes: scanMaxResponseBytes }),
  };
  const scanIoConcurrency = positiveIntegerEnv("URDIRA_SCAN_IO_CONCURRENCY");
  const lexicalIndex = lexicalIndexEnabled();
  const lexicalThread = lexicalThreadEnabled();
  const semanticThread = semanticThreadEnabled();
  const semanticProcess = semanticProcessEnabled();
  const workspaceFork = workspaceForkEnabled();
  const workspaceForkVerify = workspaceForkVerifyMode();
  // Skips descriptor resolution entirely when the kill switch already
  // fired -- there is no reason to even validate the embedding env vars for
  // a run that has already disabled semantic search outright. Otherwise
  // this is pure, synchronous env parsing (see `resolveSemanticDescriptor`'s
  // own doc comment for why: configure-time provisioning means neither this
  // function nor `resolveSemanticDescriptor` ever touches the network or
  // loads a model). Still throws (a clear startup `Error`, not a swallowed
  // fallback) when `URDIRA_EMBEDDINGS_ENDPOINT` is set but its required
  // companions are missing/invalid.
  const semanticIndex = semanticIndexEnabled();
  const semanticDescriptor = semanticIndex ? resolveSemanticDescriptor(dataRoot) : undefined;
  // How many pending documents a semantic maintenance pass batches into one
  // `generateVectors` provider call -- see `DaemonRuntimeOptions.semantic_embed_batch_size`'s
  // doc comment (`packages/daemon/src/runtime.ts`) and `ReconcileSemanticProjectionInput.embed_batch_size`'s
  // (`@urdira/engine`'s `semantic-reconciler.ts`) for the full default/`1`-disables-batching
  // story. `positiveIntegerEnv` rejects `0`/negative/non-numeric values the
  // same way every other env-sourced numeric override in this file does.
  const semanticEmbedBatchSize = positiveIntegerEnv("URDIRA_SEMANTIC_EMBED_BATCH");
  // Lives under the daemon's own data root, NOT per-workspace: durable
  // entries are content-addressed and workspace-agnostic by construction
  // (nothing workspace-scoped feeds `durableAnalysisCacheKey` or the stored
  // payload), which is exactly what lets a forked/re-added workspace over
  // the same tree hit a donor workspace's entry instead of rebuilding.
  const analysisCacheDir = analysisCacheEnabled() ? join(dataRoot, "analysis-cache", "jsts") : undefined;
  const workerShards = analysisWorkerShardCount();
  // One pool per daemon (mirrors `createResolveJavascriptTypescriptPluginProvider`'s
  // own single `prepared` cache below): keyed by workspace_id, so a workspace's
  // pooled worker survives across every scan of that workspace for this
  // daemon process's lifetime (subject to idle-TTL/LRU/descriptor-change
  // eviction -- see `AnalysisWorkerPool`'s doc comment). `undefined` when
  // `URDIRA_ANALYSIS_POOL=0` restores today's per-scan create/terminate.
  const analysisWorkerPool = analysisPoolEnabled()
    ? new AnalysisWorkerPool<JavascriptTypescriptWorkerDescriptor>({
      create: (descriptor) => analysisThreadEnabled() ? createJavascriptTypescriptThreadTransport(descriptor) : createJavascriptTypescriptWorker(descriptor),
      max_entries: analysisPoolMaxEntries(),
      max_active: workerShards,
      idle_ttl_ms: analysisPoolIdleTtlMs(),
    })
    : undefined;
  // Structural pool concurrency: how many "structural" jobs (workspace scans)
  // the daemon scheduler runs at once. Kept independently configurable from
  // `URDIRA_SCAN_IO_CONCURRENCY` (I/O within one scan) since raising this
  // above 1 admits concurrent scans of *different* workspaces; two scans of
  // the SAME workspace never run concurrently regardless of this value (see
  // `packages/daemon/src/runtime.ts`'s `scanInFlight` guard in
  // `scheduleWorkspaceScan`).
  const structuralConcurrency = positiveIntegerEnv("URDIRA_STRUCTURAL_CONCURRENCY") ?? 2;
  const warmRecordsBudgetMb = warmRecordsBudgetMbEnv();
  return {
    data_root: dataRoot,
    engine_build_id: "urdira-core-0.1.0",
    workspace_registry: createPersistentWorkspaceRegistry(dataRoot),
    plugin_catalog: [{ ...bundledPluginCatalogEntry, capability_declarations: JAVASCRIPT_TYPESCRIPT_CAPABILITIES }],
    resolve_plugin_provider: createResolveJavascriptTypescriptPluginProvider(analysisCacheDir, analysisWorkerPool, workerShards),
    // Wired straight through to `AnalysisWorkerPool.evict`/`closeAll` -- see
    // `analysis_worker_pool_evict`/`analysis_worker_pool_close_all`'s doc
    // comments (`packages/daemon/src/runtime.ts`) for why `@urdira/daemon`
    // itself only ever calls these plain closures, never touching a pool
    // instance directly. Both are `undefined` (byte-for-byte today's
    // behavior) when `URDIRA_ANALYSIS_POOL=0`.
    ...(analysisWorkerPool === undefined ? {} : {
      analysis_worker_pool_evict: (workspaceId: string) => analysisWorkerPool.evictWorkspace(workspaceId),
      analysis_worker_pool_close_all: () => analysisWorkerPool.closeAll(),
    }),
    ...(scanBudget === undefined ? {} : { scan_budget: scanBudget }),
    ...(scanIoConcurrency === undefined ? {} : { scan_io_concurrency: scanIoConcurrency }),
    // `lexicalIndexEnabled()` defaults to `true`, matching `DaemonRuntimeOptions.lexical_index`'s
    // own default -- only thread an explicit `false` through when the kill
    // switch fired, so an unset env var leaves this field omitted like every
    // other optional override here.
    ...(lexicalIndex ? {} : { lexical_index: false }),
    ...(lexicalThread ? {} : { lexical_thread: false }),
    ...(workspaceFork ? {} : { workspace_fork: false }),
    ...(workspaceForkVerify === undefined ? {} : { workspace_fork_verify: workspaceForkVerify }),
    // Same "only thread an explicit override through" convention as every
    // other kill switch above -- `semanticIndexEnabled()` also defaults to
    // `true`, matching `DaemonRuntimeOptions.semantic_index`'s own default.
    ...(semanticIndex ? {} : { semantic_index: false }),
    ...(semanticDescriptor === undefined ? {} : { semantic_descriptor: semanticDescriptor }),
    ...(semanticThread ? {} : { semantic_thread: false }),
    ...(semanticProcess ? {} : { semantic_process: false }),
    ...(semanticEmbedBatchSize === undefined ? {} : { semantic_embed_batch_size: semanticEmbedBatchSize }),
    ...(warmRecordsBudgetMb === undefined ? {} : { warm_records_budget_mb: warmRecordsBudgetMb }),
    scheduler: {
      pool_concurrency: { source: 1, structural: structuralConcurrency, semantic: 1, query: 1 },
      max_active: 16,
      client_quotas: {},
      default_client_quota: { max_in_flight: 64 },
    },
  };
}

async function resolveDaemon(options?: DaemonRuntimeOptions, endpoint?: string): Promise<{ readonly endpoint: string; readonly runtime?: DaemonRuntime }> {
  if (endpoint !== undefined) return { endpoint };
  const daemonOptions = options ?? (await defaultDaemonOptions());
  const paths = await daemonPaths(daemonOptions.data_root);
  const descriptor = await new EndpointDescriptorStore(paths).read();
  if (descriptor) {
    try {
      const response = await new DaemonClient(descriptor.endpoint).call("core:status", {});
      if (response.outcome === "success") return { endpoint: descriptor.endpoint };
    } catch { /* A stale descriptor is replaced by the coordinated starter below. */ }
  }
  const runtime = await DaemonRuntime.start(daemonOptions);
  return { endpoint: runtime.endpoint, runtime };
}

export async function runUrdira(argv: ReadonlyArray<string>, options: UrdiraRunOptions): Promise<CliResult> {
  const daemon = await resolveDaemon(options.daemon, options.endpoint);
  const prompt = options.prompt ?? (process.stdin.isTTY && process.stdout.isTTY ? async (question: string) => {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try { return await readline.question(`${question} [y/N] `); } finally { readline.close(); }
  } : undefined);
  const client = new DaemonClient(daemon.endpoint);
  try {
    return await runCli(argv, {
      client,
      preview_admin: async (command) => command.name === "workspace-add"
        ? (await client.call("core:workspace_preview", { args: command.args, values: command.options.values })).payload
        : { command: command.name, args: command.args, values: command.options.values },
      ...(options.execute_admin === undefined ? {} : { execute_admin: options.execute_admin }),
      ...(prompt === undefined ? {} : { prompt }),
      read_stdin: async () => { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks).toString("utf8"); },
    });
  }
  finally { if (daemon.runtime) await daemon.runtime.stop({ force: false }); }
}

export async function runUrdiraMcp(options: UrdiraMcpRunOptions): Promise<{ readonly close: () => Promise<void> }> {
  const daemon = await resolveDaemon(options.daemon, options.endpoint);
  try {
    const clientOptions = options.request_timeout_ms === undefined ? {} : { request_timeout_ms: options.request_timeout_ms };
    const handle = serveUrdiraStdio({ client: new DaemonClient(daemon.endpoint, clientOptions) satisfies UrdiraMcpClient }, {
      ...options.stdio,
      ...(options.tool_names === undefined ? {} : { tool_names: options.tool_names }),
      ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
      ...(options.compact === undefined ? {} : { compact: options.compact }),
      ...(options.benchmark_discover === undefined ? {} : { benchmark_discover: options.benchmark_discover }),
    });
    return {
      close: async () => {
        await handle.close();
        if (daemon.runtime) await daemon.runtime.stop({ force: false });
      },
    };
  } catch (error) {
    if (daemon.runtime) await daemon.runtime.stop({ force: true });
    throw error;
  }
}
