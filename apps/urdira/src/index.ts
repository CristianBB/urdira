import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { type ArtifactWorkItem, type ProposedRecord, type ProposedRecordDependency, type ReplacementScope, type SnapshotCapabilityStateEntry } from "@urdira/contracts";
import { parseCliArgs, runCli, type CliCommand, type CliResult } from "@urdira/cli";
import { createPersistentWorkspaceRegistry, DAEMON_PRIVATE_INTERFACE_VERSION, DaemonClient, DaemonError, DaemonRuntime, EndpointDescriptorStore, ProcessLock, daemonPaths, type DaemonErrorCode, type DaemonRuntimeOptions, type DaemonStartupPhase, type IpcProgress, type SemanticProviderDescriptor } from "@urdira/daemon";
import {
  candidateTargetRegistryFromSnapshot,
  configureNativeExactVectorTopKPort,
  configureNativeLogicalDigestPort,
  createCanonicalPluginDigestAuthority,
  EngineError,
  engineTimingEnabled,
  FactDeltaStreamAcceptanceService,
  readPersistedControlState,
  recordEngineTiming,
  type MaterializationAcceptedFactDelta,
  type WorkspaceScanAnalysisOutcome,
  type WorkspaceScanPluginProvider,
  type WorkspaceScanSourceArtifact,
} from "@urdira/engine";
import { MCP_BENCHMARK_INSTRUCTIONS, buildBenchmarkInstructions, serveUrdiraStdio, type ServeUrdiraStdioOptions, type UrdiraMcpClient } from "@urdira/mcp";
import { startUrdiraWeb, type UrdiraWebHandle } from "@urdira/web";
import { createNativeExactVectorTopKPort, createNativeLogicalDigestPort, createNativeStructuralKernelPort, loadNativeBinding, resolveNativeClosure, type ResolvedNativeClosure } from "@urdira/native";
import { WORKSPACE_V3_SCHEMA_DIGEST } from "@urdira/storage";
export { MCP_BENCHMARK_INSTRUCTIONS, buildBenchmarkInstructions } from "@urdira/mcp";
import { canonicalJson, configureStructuralKernelPort, type FactDeltaStream, type PluginWorkerRequestEnvelope, type WorkerTransport } from "@urdira/plugin-sdk";
import {
  bundledPluginCatalogEntry,
  buildJavascriptTypescriptNativeFactDeltaStream,
  createJavascriptTypescriptInstalledBundle,
  createJavascriptTypescriptProcessTransport,
  createIndexingCoreProcessTransport,
  createJavascriptTypescriptSemanticProcessTransport,
  createRustSyntaxAnalyzeRequest,
  extractImportSpecifiers,
  largeSyntaxManifestKey,
  languageForPath,
  resolveSyntaxDependencyGraph,
  writeSyntaxDependencyGraphCache,
  JAVASCRIPT_TYPESCRIPT_CAPABILITIES,
  JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES,
  JAVASCRIPT_TYPESCRIPT_DEPENDENCY_ROLES,
  JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
  JAVASCRIPT_TYPESCRIPT_RECORD_KINDS,
  JAVASCRIPT_TYPESCRIPT_VERSION,
  LARGE_SYNTAX_CORPUS_BYTE_THRESHOLD,
  LARGE_SYNTAX_CORPUS_FILE_THRESHOLD,
  TYPESCRIPT_COMPILER_VERSION,
  JSTS_RUST_SYNTAX_BUILD_IDENTITY,
  JSTS_SEMANTIC_PROCESS_BUILD_IDENTITY,
  type JavascriptTypescriptProcessTransport,
  type IndexingCoreProcessTransport,
  type JavascriptTypescriptSemanticProcessTransport,
  type RustSyntaxAnalysisResult,
  type RustSyntaxDirectImport,
  type RustSyntaxFactCursor,
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
  sha256Bytes,
  type AssembledPluginRegistry,
  type AutomaticPluginInputAccessManifest,
  type DiscoveredPluginPackage,
  type SdkPluginResolutionLock,
} from "@urdira/plugin-sdk";
import { AnalysisWorkerPool } from "./analysis-worker-pool.js";
import { WholeProcessTreeRssController, createHostProcessTableRssSampler } from "./process-tree-rss.js";

export interface UrdiraRunOptions {
  readonly endpoint?: string;
  readonly daemon?: DaemonRuntimeOptions;
  readonly execute_admin?: (command: CliCommand, preview: unknown) => Promise<unknown>;
  readonly prompt?: (question: string) => Promise<string | boolean>;
  readonly on_startup_progress?: (phase: DaemonStartupPhase) => void;
  /** Human-facing daemon attachment and long-running CLI operation progress. */
  readonly on_progress?: (progress: IpcProgress["progress"]) => void;
  /** Internal foreground-controller override for administrative operations.
   * Ordinary CLI calls retain the five-minute default. */
  readonly admin_request_timeout_ms?: number;
}

export const URDIRA_VERSION = "0.3.3";
/** Exact runtime release identity. Bump automatically with every Urdira release. */
export const URDIRA_ENGINE_BUILD_ID = `urdira-core-${URDIRA_VERSION}`;
const DAEMON_HEALTH_PROBE_TIMEOUT_MS = 2_000;
const CLI_ADMIN_REQUEST_TIMEOUT_MS = 300_000;
const DAEMON_SHUTDOWN_TIMEOUT_MS = 300_000;
const debugTimingEnabled = (): boolean => process.env["URDIRA_DEBUG_TIMING"] === "1";

function urdiraHelpLegacy(): string {
  return `Urdira ${URDIRA_VERSION}\n\nUsage:\n  urdira status [--json]\n  urdira index [--json] [--workspace <id>]\n  urdira query --payload <json> [--json]\n  urdira workspace list|show|add|configure|remove|purge\n  urdira codebase list|create|rename|assign|unassign|remove\n  urdira daemon start\n  urdira daemon stop [--dry-run]\n  urdira agent status --client all\n  urdira mcp\n  urdira web\n\nWorkspace add/configure and daemon start/stop run directly; use --dry-run only to preview. Destructive commands accept --confirm to execute.\nSource-reading MCP calls always require explicit workspace scope.\n`;
}

export function urdiraHelp(): string {
  return `${urdiraHelpLegacy()}\nDiagnostic option:\n  append --debug-timing to enable internal scan, analysis, CAS, SQLite and publication timings.\n\n  urdira migrate --to-data-format 3 --reindex [--confirm]\n`;
}

export interface UrdiraMcpRunOptions {
  readonly endpoint?: string;
  readonly daemon?: DaemonRuntimeOptions;
  /** IPC deadline for MCP requests; pipeline queries may need a larger explicit budget than the 30s local default. */
  readonly request_timeout_ms?: number;
  readonly stdio?: ServeUrdiraStdioOptions;
  /** Optional narrowed MCP projection used by focused benchmark clients. */
  readonly tool_names?: readonly ("urdira_query" | "urdira_context" | "urdira_analyze_change" | "urdira_build_context" | "urdira_index_status")[];
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
//  - The bundle's TypeScript dependency asset is a deterministic inventory
//    of every regular file in the installed compiler package. The analyzer
//    identity therefore commits the bytes actually loaded by the checker,
//    not only the package's declared version string.
//  - `analyze()` below calls the real semantic process transport and its real
//    `.invoke("analyze_artifact", ...)` — this is genuine TypeScript-checker
//    analysis in a supervised child process, not a stub.

async function javascriptTypescriptExecutableAssets(): Promise<readonly JavascriptTypescriptPackageAsset[]> {
  const indexUrl = import.meta.resolve("@urdira/plugin-javascript-typescript");
  const distDirectory = fileURLToPath(new URL(".", indexUrl));
  // Bind every shipped JavaScript module in the plugin package. The semantic
  // process entrypoint imports worker.js and several sibling modules; binding
  // only worker.js would leave executable production code outside the package
  // and analyzer identities even though the process actually loads it.
  const moduleNames = (await readdir(distDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => entry.name)
    .sort();
  for (const required of ["semantic-process-worker.js", "worker.js"]) {
    if (!moduleNames.includes(required)) throw new Error(`The JavaScript/TypeScript runtime package is missing ${required}.`);
  }
  return await Promise.all(moduleNames.map(async (name) => ({
    normalized_relative_path: `dist/${name}`,
    bytes: new Uint8Array(await readFile(join(distDirectory, name))),
    executable: true,
    role: name === "semantic-process-worker.js" || name === "worker.js" ? "parser" as const : "dependency" as const,
  })));
}

let typescriptPackageClosureDescriptorPromise: Promise<Uint8Array> | undefined;

async function typescriptPackageClosureDescriptor(): Promise<Uint8Array> {
  typescriptPackageClosureDescriptorPromise ??= (async () => {
    const packageJsonPath = fileURLToPath(import.meta.resolve("typescript/package.json"));
    const packageRoot = dirname(packageJsonPath);
    const files: { readonly normalized_relative_path: string; readonly content_digest: string; readonly byte_length: number }[] = [];
    const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
      const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path, relativePath);
        else if (entry.isFile()) {
          const bytes = new Uint8Array(await readFile(path));
          files.push({ normalized_relative_path: relativePath, content_digest: sha256Bytes(bytes), byte_length: bytes.byteLength });
        } else throw new Error(`The installed TypeScript package contains an unsupported filesystem entry: ${relativePath}.`);
      }
    };
    await walk(packageRoot, "");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { readonly name?: unknown; readonly version?: unknown };
    if (packageJson.name !== "typescript" || packageJson.version !== TYPESCRIPT_COMPILER_VERSION) throw new Error("The installed TypeScript package identity does not match the analyzer compiler version.");
    return new TextEncoder().encode(JSON.stringify({ name: packageJson.name, version: packageJson.version, files }));
  })();
  return await typescriptPackageClosureDescriptorPromise;
}

function createProductionJavascriptTypescriptSemanticTransport(
  descriptor: JavascriptTypescriptWorkerDescriptor,
  processTreeRss?: WholeProcessTreeRssController,
  structuralKernelAddonPath?: string,
): JavascriptTypescriptSemanticProcessTransport {
  if (descriptor.on_analysis_build !== undefined || descriptor.on_analysis_cache_load !== undefined || descriptor.on_analysis_incremental !== undefined) {
    throw new Error("Test-only JavaScript/TypeScript analysis hooks cannot enter the production semantic process.");
  }
  const transport = createJavascriptTypescriptSemanticProcessTransport({
    // Autonomous archives launch this application with their pinned private
    // Node binary; prepared npm runtimes likewise retain the exact executable
    // that passed runtime preparation. Never resolve `node` through PATH.
    node_executable: process.execPath,
    worker: descriptor,
    ...(structuralKernelAddonPath === undefined ? {} : { structural_kernel_addon_path: structuralKernelAddonPath }),
  });
  if (processTreeRss === undefined) return transport;
  const unregister = processTreeRss.registerComponent({
    component_id: `typescript-checker:${transport.process_id}`,
    kind: "typescript_checker",
    pid: transport.process_id,
  });
  return {
    ...transport,
    async terminate(): Promise<void> {
      try { await transport.terminate(); }
      finally { unregister(); }
    },
  };
}

async function javascriptTypescriptBundleAssets(): Promise<readonly JavascriptTypescriptPackageAsset[]> {
  const [executableAssets, typescriptDependencyDescriptor] = await Promise.all([javascriptTypescriptExecutableAssets(), typescriptPackageClosureDescriptor()]);
  return [
    ...executableAssets,
    { normalized_relative_path: "node_modules/typescript/package-closure.json", bytes: typescriptDependencyDescriptor, executable: false, role: "dependency" },
  ];
}

interface PreparedJavascriptTypescriptRegistry {
  readonly registry: AssembledPluginRegistry;
  readonly lock: SdkPluginResolutionLock;
  readonly plugin: DiscoveredPluginPackage;
}

interface PreparedNativeRuntime {
  readonly closure: ResolvedNativeClosure;
  readonly addon_bytes: Uint8Array;
  readonly worker_bytes: Uint8Array;
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
function resolutionInputFingerprint(discoveredPackages: readonly DiscoveredPluginPackage[], supportedRuntimeContractVersions: readonly number[]): string {
  const packages = [...discoveredPackages].sort((left, right) => (left.plugin_id < right.plugin_id ? -1 : left.plugin_id > right.plugin_id ? 1 : 0)).map((item) => ({
    plugin_id: item.plugin_id,
    plugin_version: item.plugin_version,
    package_digest: item.package_digest,
    declaration_digest: item.declaration_digest,
    contribution_digest: item.contribution_digest,
    analysis_digest: item.compatibility.analysis_digest,
    analysis_configuration_digest: item.analysis_configuration_digest,
    runtime_executable_binding: item.runtime_executable_binding ?? null,
  }));
  return canonicalSha256({
    resolver_version: JAVASCRIPT_TYPESCRIPT_VERSION,
    supported_runtime_contract_versions: supportedRuntimeContractVersions,
    supported_registry_contract_versions: [1],
    requirements: [{ plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, version_requirement: "*" }],
    pins: [],
    packages,
  });
}

async function prepareJavascriptTypescriptRegistry(workspaceId: string, now: string, database: PluginResolverDatabase, nativeRuntime?: PreparedNativeRuntime): Promise<PreparedJavascriptTypescriptRegistry> {
  const digests = createCanonicalPluginDigestAuthority();
  const assets = await javascriptTypescriptBundleAssets();
  const nativeAddonPath = "native/urdira-native.node";
  const nativeWorkerPath = nativeRuntime === undefined ? undefined : `native/${basename(nativeRuntime.closure.worker_path)}`;
  const bundle = createJavascriptTypescriptInstalledBundle({
    digests,
    package_locator: "bundled:jsts",
    assets,
    ...(nativeRuntime === undefined
      ? { target_triple: `${process.platform}-${process.arch}` }
      : {
          native_runtime: {
            runtime_target_id: nativeRuntime.closure.runtime_target_id,
            runtime_component_build_id: nativeRuntime.closure.runtime_component_build_id,
            addon: { normalized_relative_path: nativeAddonPath, bytes: nativeRuntime.addon_bytes },
            worker: { normalized_relative_path: nativeWorkerPath!, bytes: nativeRuntime.worker_bytes },
          },
        }),
  });
  const bytesByPath = new Map(assets.map((asset) => [asset.normalized_relative_path, asset.bytes]));
  if (nativeRuntime !== undefined) {
    bytesByPath.set(nativeAddonPath, nativeRuntime.addon_bytes);
    bytesByPath.set(nativeWorkerPath!, nativeRuntime.worker_bytes);
  }
  const packageByteLength = [...bytesByPath.values()].reduce((total, bytes) => total + bytes.byteLength, 0);
  const maximumAssetByteLength = Math.max(8_000_000, ...[...bytesByPath.values()].map((bytes) => bytes.byteLength));
  if (maximumAssetByteLength > 64 * 1024 * 1024 || packageByteLength > 128 * 1024 * 1024) throw new Error("The bundled JavaScript/TypeScript runtime closure exceeds its closed discovery budget.");
  const discovery = await new PluginPackageDiscovery({
    list: async () => [bundle],
    read_file: async (request) => {
      const bytes = bytesByPath.get(request.normalized_relative_path);
      if (bytes === undefined) throw new Error(`Missing bundled JavaScript/TypeScript asset ${request.normalized_relative_path}.`);
      return { bytes, byte_length: bytes.byteLength };
    },
  }, digests, { max_file_bytes: maximumAssetByteLength }, { max_items: 100, max_depth: 20, max_nodes: 10_000, max_bytes: Math.max(8_000_000, packageByteLength) }).discover(["bundled"]);
  const supportedRuntimeContractVersions = nativeRuntime === undefined ? [1] : [2];
  if (discovery.packages.length !== 1) throw new Error("The bundled JavaScript/TypeScript plugin must resolve to exactly one package.");
  const discoveredPlugin = discovery.packages[0]!;
  if (nativeRuntime !== undefined) {
    const binding = discoveredPlugin?.runtime_executable_binding;
    const implementation = discoveredPlugin?.runtime_implementation_manifests_v2?.[0];
    const semanticEntrypoint = discoveredPlugin.manifest.package_files.find((entry) => entry.normalized_relative_path === "dist/semantic-process-worker.js");
    if (binding === undefined || implementation === undefined || discoveredPlugin.runtime_implementation_manifests_v2?.length !== 1 ||
        semanticEntrypoint === undefined || !semanticEntrypoint.executable || !implementation.executable_asset_digests.includes(semanticEntrypoint.content_digest) ||
        binding.runtime_target_id !== nativeRuntime.closure.runtime_target_id ||
        binding.runtime_component_build_id !== nativeRuntime.closure.runtime_component_build_id ||
        binding.entrypoint_asset_digest !== nativeRuntime.closure.worker_digest ||
        implementation.entrypoint_asset_digest !== nativeRuntime.closure.worker_digest || !implementation.executable_asset_digests.includes(nativeRuntime.closure.worker_digest) ||
        JSON.stringify(implementation.native_asset_digests) !== JSON.stringify([nativeRuntime.closure.addon_digest])) {
      throw new Error("The bundled JavaScript/TypeScript plugin binding does not match the verified native closure.");
    }
  }
  const fingerprint = resolutionInputFingerprint(discovery.packages, supportedRuntimeContractVersions);
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
    supported_runtime_contract_versions: supportedRuntimeContractVersions,
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

interface RustSyntaxSession {
  readonly transport: JavascriptTypescriptProcessTransport;
  readonly runtime_executable_binding_digest: string;
}

function buildJavascriptTypescriptPluginProvider(prepared: PreparedJavascriptTypescriptRegistry, workspaceId: string, registrySnapshotId: string, configurationRevisionId: string, now: string, casRoot: string, analysisCacheDir?: string, analysisWorkerPool?: AnalysisWorkerPool<JavascriptTypescriptWorkerDescriptor>, analysisWorkerShardCount = 2, streamAcceptance?: FactDeltaStreamAcceptanceService, rustSyntax?: RustSyntaxSession, processTreeRss?: WholeProcessTreeRssController, structuralKernelAddonPath?: string, indexingCore?: IndexingCoreProcessTransport, databasePath?: string): WorkspaceScanPluginProvider {
  if (indexingCore !== undefined && (streamAcceptance !== undefined || rustSyntax !== undefined)) {
    throw new Error("Exclusive-work violation: the Rust indexing composition worker cannot be combined with a TypeScript structural writer or syntax session.");
  }
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
    ...(prepared.plugin.runtime_executable_binding === undefined ? {} : { runtime_executable_binding_digest: prepared.plugin.runtime_executable_binding.binding_digest }),
    cas_root: casRoot,
    ...(analysisCacheDir === undefined ? {} : { analysis_cache_dir: analysisCacheDir }),
    native_batch_transport: "host",
  };
  const workerDescriptorDigest = canonicalSha256(workerDescriptor);
  const rustSemanticWorkerEntrypoint = fileURLToPath(new URL("rust-semantic-worker.js", import.meta.resolve("@urdira/plugin-javascript-typescript")));
  let activeRustOperationId: string | undefined;
  const rustGenerationControl = indexingCore === undefined ? undefined : {
    owns_candidate_lifecycle: true as const,
    cancel: async (): Promise<void> => {
      const operationId = activeRustOperationId;
      if (operationId !== undefined) await indexingCore.cancel(operationId).catch(() => undefined);
    },
    commit_source_index: async (input: { readonly operation_id: string; readonly workspace_id: string; readonly database_path: string; readonly commits: readonly unknown[]; readonly finalize_state?: boolean }): Promise<void> => {
      const result = await indexingCore.commitSourceIndex(input.operation_id, input.workspace_id, input.database_path, input.commits, input.finalize_state);
      if (result.kind !== "source_index_committed") throw new Error("Rust indexing-core did not commit the generic source index.");
    },
    rollback_source_index: async (input: { readonly operation_id: string; readonly workspace_id: string; readonly database_path: string }): Promise<void> => {
      const result = await indexingCore.rollbackSourceIndex(input.operation_id, input.workspace_id, input.database_path);
      if (result.kind !== "source_index_rolled_back") throw new Error("Rust indexing-core did not roll back the generic source index.");
    },
  };

  // P3-3b: per-file raw import specifiers, collected via `on_source_text`
  // (below) as source cataloging hands off each file's full text -- NOT the
  // text itself, which is dropped immediately after extraction (see
  // `extractImportSpecifiers`'s doc comment, `analyzer.ts`). Freshly empty
  // for every scan: `buildJavascriptTypescriptPluginProvider` itself runs
  // once per `resolve_plugin_provider` call, i.e. once per scan (only the
  // underlying registry resolution is memoized across scans, in `prepared`'s
  // caller -- `createResolveJavascriptTypescriptPluginProvider`, below), so
  // this map can never leak a stale entry from a PRIOR scan into the current
  // one's pre-seed.
  const importSpecifiersByPath = new Map<string, readonly string[]>();
  let nativeSemanticScope: {
    readonly inputs_digest: string;
    readonly configuration_digest: string;
    readonly changed_paths: ReadonlySet<string>;
    readonly affected_paths: ReadonlySet<string>;
    readonly dependency_graph: ReadonlyMap<string, { readonly direct_files: readonly string[]; readonly complete: boolean }>;
  } | undefined;
  const onSourceText = (uri: string, text: string): void => {
    if (languageForPath(uri) === undefined) return;
    importSpecifiersByPath.set(uri, extractImportSpecifiers(text));
  };
  // A/B measured on VS Code (17,675 files, same machine window): catalog wall
  // with the hook 75.0s vs without 74.6s -- the UTF-8 decode + specifier regex
  // is inside run-to-run noise, and the pre-seeded graph saves the worker's
  // ~3.7s closure cache miss. Default ON; URDIRA_GRAPH_PRESEED=0 is the kill
  // switch if a corpus ever surfaces a pathological decode cost.
  const graphPreseedEnabled = process.env["URDIRA_GRAPH_PRESEED"] !== "0";

  return {
    ...(rustGenerationControl === undefined ? {} : { indexing_core: rustGenerationControl }),
    // A Rust generation is atomic across syntax and semantic stages. Keep
    // progressive publications only for the portable compatibility route;
    // splitting the Rust owner set would analyze and promote it twice.
    supports_progressive_publication: indexingCore === undefined,
    supports_native_content_refs: true,
    requires_complete_artifact_manifest: rustSyntax !== undefined || indexingCore !== undefined,
    initial_publication_stage_groups: Object.freeze([{ stage_ids: Object.freeze(["jsts:structural_stage_2", "jsts:structural_stage_3"]) }]),
    registry_snapshot_id: registrySnapshotId,
    configuration_revision_id: configurationRevisionId,
    registry: prepared.registry,
    resolution_lock: prepared.lock,
    configuration,
    dependency_roles: [...JAVASCRIPT_TYPESCRIPT_DEPENDENCY_ROLES],
    ...(graphPreseedEnabled && rustSyntax === undefined && indexingCore === undefined ? { on_source_text: onSourceText } : {}),
    analyze: async ({ workspace_id, candidate, frozen_base, source_state_digest, source_snapshot_id, candidate_work_manifest, artifacts, changed_artifact_ids, publication_stage_id, included_publication_stage_ids, on_accepted_delta, signal }) => {
      const stage = publication_stage_id === undefined
        ? undefined
        : JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES.find((entry) => entry.stage_id === publication_stage_id);
      if (publication_stage_id !== undefined && stage === undefined) throw new Error(`Unknown JavaScript/TypeScript structural stage: ${publication_stage_id}`);
      const includedStages = included_publication_stage_ids === undefined
        ? (stage === undefined ? [] : [stage])
        : included_publication_stage_ids.map((stageId) => JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES.find((entry) => entry.stage_id === stageId));
      if (includedStages.some((entry) => entry === undefined)
        || (included_publication_stage_ids !== undefined && (includedStages.length < 2 || includedStages.at(-1)?.stage_id !== publication_stage_id))) {
        throw new Error("The JavaScript/TypeScript accumulated publication stage group is invalid.");
      }
      // The Rust composition worker may execute syntax and semantic analysis
      // in one generation; no progressive-stage requirement applies there.
      const nativeStageOne = publication_stage_id === "jsts:structural_stage_1" && (rustSyntax !== undefined || indexingCore !== undefined);
      // Once the composition worker is present it owns the complete structural
      // generation for every progressive stage. Stage one and the semantic
      // checker are both executed behind the Rust worker boundary; the app
      // only supplies opaque generation/request envelopes and publication
      // control metadata. Keeping this separate from `nativeStageOne` avoids
      // selecting a second TypeScript staging/publication route for stages two
      // and three.
      const coreGenerationEnabled = indexingCore !== undefined;
      // The engine always supplies this compact digest on the production
      // route. Direct provider tests/oracle callers may invoke `analyze`
      // without the coordinator, so retain a compatibility-only fallback
      // there; it is unreachable for Rust-owned workspace scans.
      const capturedSourceStateDigest = source_state_digest
        ?? frozen_base?.source_state_digest
        ?? canonicalSha256(artifacts.map((artifact) => ({ artifact_id: artifact.artifact_id, artifact_version_id: artifact.artifact_version_id, content_hash: artifact.content_hash })));
      const exclusiveWork = new Map<string, string>();
      const claimExclusiveWork = (owner: "rust" | "typescript", operations: readonly string[]): void => {
        for (const operation of operations) {
          const existing = exclusiveWork.get(operation);
          if (existing !== undefined) throw new Error(`Exclusive-work violation: ${operation} is already owned by ${existing}, not ${owner}.`);
          exclusiveWork.set(operation, owner);
        }
      };
      const stageCapabilities = stage === undefined
        ? JAVASCRIPT_TYPESCRIPT_CAPABILITIES.map((entry) => entry.capability)
        : [...new Set((includedStages as (typeof JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES)[number][]).flatMap((entry) => entry.capabilities))];
      const completedCapabilities = stage === undefined
        ? stageCapabilities
        : JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES.filter((entry) => entry.ordinal <= stage.ordinal).flatMap((entry) => entry.capabilities);
      // Stage 1 owns the replacement boundary for every record kind. This is
      // intentional: when source changes, stale stage-2/3 records must close
      // before the new declarations become visible. Later stages replace only
      // their own records and retain the preceding immutable stage.
      const recordKindsForStage = (stageId: string): readonly string[] => stageId === "jsts:structural_stage_1"
        ? JAVASCRIPT_TYPESCRIPT_RECORD_KINDS
        : stageId === "jsts:structural_stage_2"
          ? JAVASCRIPT_TYPESCRIPT_RECORD_KINDS.filter((kind) => ["jsts:relation_call", "jsts:relation_references", "jsts:relation_inherits", "jsts:relation_implements"].includes(kind))
          : JAVASCRIPT_TYPESCRIPT_RECORD_KINDS.filter((kind) => ["jsts:entity_inferred_type", "jsts:relation_type_of", "jsts:diagnostic", "jsts:relation_covers"].includes(kind));
      const stageRecordKinds = stage === undefined
        ? [...JAVASCRIPT_TYPESCRIPT_RECORD_KINDS]
        : [...new Set((includedStages as (typeof JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES)[number][]).flatMap((entry) => recordKindsForStage(entry.stage_id)))];
      // In the Rust cutover a cold generation combines the syntax stage with
      // the accumulated semantic stages in one transaction. Keep the
      // semantic checker on the exact stage-2/3 vocabulary used by the former
      // progressive final stage so the visible record set remains byte
      // identical while avoiding a second generation.
      const combinedRustGeneration = coreGenerationEnabled && publication_stage_id === undefined;
      const semanticPublicationStageId = combinedRustGeneration ? "jsts:structural_stage_3" : publication_stage_id;
      const semanticIncludedStageIds = combinedRustGeneration
        ? ["jsts:structural_stage_2", "jsts:structural_stage_3"]
        : included_publication_stage_ids;
      const semanticStageCapabilities = combinedRustGeneration
        ? JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES.filter((entry) => entry.ordinal >= 2).flatMap((entry) => entry.capabilities)
        : stageCapabilities;
      const semanticStageRecordKinds = combinedRustGeneration
        ? [...new Set(JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES.filter((entry) => entry.ordinal >= 2).flatMap((entry) => recordKindsForStage(entry.stage_id)))]
        : stageRecordKinds;
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
      // The Rust composition worker seals and publishes the structural rows
      // itself. Keep the application-side callback limited to the bounded
      // publication envelope; returning it here lets the Rust route leave the
      // owner planner, closure maps, FactDelta acceptance and TypeScript
      // materializer completely untouched for this generation.
      const rustExternalPublication = async (context: Parameters<NonNullable<WorkspaceScanAnalysisOutcome["external_publication"]>>[0]): Promise<import("@urdira/engine").CandidatePublicationResult> => {
        if (indexingCore === undefined) throw new EngineError("engine:workspace_scan_external_publication_missing", "Rust indexing-core publication callback is missing.");
        const result = await indexingCore.finalizeGeneration(`indexing-core:${workspace_id}:${candidate.candidate_generation_id}`, {
          candidate: context.candidate,
          frozen_base: context.frozen_base,
          target_registry: prepared.registry,
          target_resolution_lock: prepared.lock,
          target_configuration: configuration,
          freshness_checkpoint: context.freshness_checkpoint,
          capability_state_entries: context.capability_state_entries,
          publication_kind: context.publication_kind,
          // Source commits already contain the complete version/tombstone
          // authority. The Rust publisher derives the canonical transition
          // templates inside its SQLite transaction, so do not serialize a
          // second O(owners) transition graph through the application.
          source_transitions: (context.source_index_commits?.length ?? 0) === 0 ? context.source_transitions : [],
          // Source commits are sent to the Rust writer immediately after the
          // capture frontier is sealed (`commitSourceIndex`). Re-sending the
          // owner-sized commit payload here would both duplicate work and
          // exceed the private 16 MiB transport budget on a full n8n cold
          // scan. Rust derives the source transition set from its durable
          // source tables during this final publication transaction.
          source_index_commits: [],
          lookup_bindings: [],
          lookup_revalidations: [],
          projection_closures: [],
          lexical: { cas_root: casRoot, max_document_bytes: 2_000_000 },
          source_snapshot_id: context.source_snapshot_id,
          publication_stage_id: context.publication_stage_id,
          publication_stage_ordinal: context.publication_stage_ordinal,
          publication_stage_count: context.publication_stage_count,
          published_at: new Date().toISOString(),
        });
        if (result.kind !== "completed") throw new Error("Rust indexing-core did not complete before publication.");
        return {
          candidate_generation_id: context.candidate.candidate_generation_id,
          snapshot_id: `snapshot:${context.candidate.candidate_generation_id}`,
          generation_manifest_id: `generation-manifest:${context.candidate.candidate_generation_id}`,
          generation: result.generation,
          published_at: new Date().toISOString(),
          status: "published",
        };
      };
      if (streamAcceptance === undefined && !coreGenerationEnabled) throw new Error("The built-in JavaScript/TypeScript plugin requires direct FactDeltaStream@2 acceptance.");
      // Real analysis: the compiled `@urdira/plugin-javascript-typescript`
      // worker runs the pinned TypeScript checker in a persistent, supervised
      // child process launched by the exact Node executable running this
      // prepared runtime. Production has no in-process or worker-thread
      // fallback: a missing entrypoint, failed handshake, deadline, or crash
      // rejects the scan and leaves the previously published snapshot intact.
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
      const sourceArtifacts = artifacts.filter((artifact) => languageForPath(artifact.path) !== undefined);
      const estimatedWorkerRssBytes = analysisWorkerBaseReservationKib() * 1024
        + sourceArtifacts.reduce((total, artifact) => total + artifact.byte_length, 0) * 2;
      const acquirePooledWorker = async (key: string): Promise<JavascriptTypescriptSemanticProcessTransport | import("@urdira/plugin-sdk").WorkerTransport> => {
        if (nativeStageOne) throw new Error("Exclusive-work violation: a TypeScript semantic process cannot be created during native structural stage 1.");
        if (analysisWorkerPool === undefined) {
          if (processTreeRss === undefined) return createProductionJavascriptTypescriptSemanticTransport(workerDescriptor, undefined, structuralKernelAddonPath);
          const decision = await processTreeRss.admit({ reservation_id: `jsts-analysis:${key}`, estimated_additional_rss_bytes: estimatedWorkerRssBytes, fresh_sample: true });
          if (!decision.admitted || decision.reservation === undefined) throw new Error(`Analysis worker RSS admission exhausted (${decision.reason}).`);
          try {
            const transport = createProductionJavascriptTypescriptSemanticTransport(workerDescriptor, processTreeRss, structuralKernelAddonPath);
            return {
              ...transport,
              async terminate(): Promise<void> {
                try { await transport.terminate(); }
                finally { decision.reservation!.release(); }
              },
            };
          } catch (error) {
            decision.reservation.release();
            throw error;
          }
        }
        if (processTreeRss === undefined) return analysisWorkerPool.acquire(key, workerDescriptor, workerDescriptorDigest);
        return analysisWorkerPool.acquireWithResourceAdmission(key, workerDescriptor, workerDescriptorDigest, {
          reservation_id: `jsts-analysis:${key}`,
          estimated_additional_rss_bytes: estimatedWorkerRssBytes,
        });
      };
      const accepted: MaterializationAcceptedFactDelta[] = [];
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
      if (!coreGenerationEnabled && changedArtifactIds !== undefined && !sourceArtifacts.some((artifact) => changedArtifactIds.has(artifact.artifact_id))) {
        if (debugTimingEnabled()) console.error(`[urdira] analyze timings ${workspace_id} owners=0 ms=${JSON.stringify({ closure: 0, worker_wait: 0, acceptance: 0, skipped: "no_plugin_artifact_changes" })}`);
        return {
          accepted_deltas: accepted,
          capability_state_entries: completeStageEntries(),
        };
      }
      // Decision 25 native stage-one execution. The host supplies only explicit immutable
      // CAS paths plus their authoritative digest/length; Rust reads and
      // verifies those blobs without ambient checkout access. The retained
      // content references. Rust is the sole parser, extractor, graph owner,
      // affected-set authority, and structural-fact producer for this stage.
      let nativeSyntaxResult: RustSyntaxAnalysisResult | undefined;
      let nativeProjectKey: string | undefined;
      let nativeAffectedPaths: ReadonlySet<string> | undefined;
      const nativeDependencyGraph = new Map<string, { readonly direct_files: readonly string[]; readonly complete: boolean }>();
      if (coreGenerationEnabled) {
        claimExclusiveWork("rust", ["sqlite_structural_ingest"]);
        if (nativeStageOne) claimExclusiveWork("rust", ["source_decode", "syntax_parse", "declaration_extract", "import_extract", "direct_graph", "affected_set", "stage_one_fact_build"]);
        if (databasePath === undefined) throw new Error("Rust indexing-core requires the workspace database path.");
        const sourceStateDigest = capturedSourceStateDigest;
      const sourceByteLength = sourceArtifacts.reduce((total, artifact) => total + artifact.byte_length, 0);
      if (sourceByteLength > 0xffff_ffff || sourceArtifacts.length > 0xffff_ffff) throw new Error("JavaScript/TypeScript syntax input exceeds the closed Rust worker budget.");
      const projectKey = canonicalSha256({ workspace_id, runtime_executable_binding_digest: prepared.plugin.runtime_executable_binding?.binding_digest ?? prepared.plugin.compatibility.analysis_digest });
        const operationId = `indexing-core:${workspace_id}:${candidate.candidate_generation_id}`;
        activeRustOperationId = operationId;
        if (signal?.aborted) throw Object.assign(new Error("Rust indexing-core generation was cancelled."), { name: "AbortError" });
        const cancelRustGeneration = (): void => {
          // Keep cancellation on the private Rust control protocol. The
          // worker checks the shared token at every syntax/group/checkpoint;
          // a late abort is harmless because the operation is idempotent and
          // the listener is removed immediately after the request returns.
          void indexingCore!.cancel(operationId).catch(() => undefined);
        };
        signal?.addEventListener("abort", cancelRustGeneration, { once: true });
        const generationEvent = await indexingCore!.indexGeneration({
          operation_id: operationId,
          workspace_id,
          candidate_generation_id: candidate.candidate_generation_id,
          database_path: databasePath,
          cas_root: casRoot,
          source_snapshot_id: source_snapshot_id ?? candidate.base_snapshot_id ?? `source-snapshot:${sourceStateDigest}`,
          source_state_digest: sourceStateDigest,
          base_generation: candidate.base_generation ?? 0,
          candidate: candidate as unknown as Record<string, unknown>,
          frozen_base: frozen_base as unknown as Record<string, unknown>,
          ...(candidate_work_manifest === undefined ? {} : { work_manifest: candidate_work_manifest as unknown as Record<string, unknown> }),
          registry_snapshot_id: registrySnapshotId,
          configuration_revision_id: configurationRevisionId,
          resolution_lock_id: prepared.lock.resolution_lock_id,
          workspace_schema_digest: WORKSPACE_V3_SCHEMA_DIGEST,
          // Every generation owned by the Rust composition worker uses the
          // direct TEMP-to-v3 publication path.  Restricting this to the
          // combined cold generation would reintroduce candidate body copies
          // for progressive and incremental stages, defeating the single
          // transaction cutover and making latency depend on stage shape.
          ...(coreGenerationEnabled ? { direct_publication: true } : {}),
          change_set: changedArtifactIds === undefined ? { kind: "full" } : { kind: "exact", changed_artifact_ids: [...changedArtifactIds] },
          engine: { engine_id: "urdira:jsts", engine_version: JAVASCRIPT_TYPESCRIPT_VERSION, implementation_digest: prepared.plugin.compatibility.analysis_digest },
          ...(!nativeStageOne && coreGenerationEnabled ? { semantic_engine: {
            node_executable: process.execPath,
            worker_entrypoint: rustSemanticWorkerEntrypoint,
            build_identity: JSTS_SEMANTIC_PROCESS_BUILD_IDENTITY,
            worker_descriptor: workerDescriptor,
            ...(structuralKernelAddonPath === undefined ? {} : { structural_kernel_addon_path: structuralKernelAddonPath }),
          } } : {}),
          engine_input: {
            project_key: projectKey,
            configuration_digest: configuration.analysis_configuration_digest,
            // Rust-owned generations intentionally omit the owner-sized source
            // manifest from this envelope. The core resolves the current
            // frontier from SQLite and applies these closed protocol limits
            // after filtering it to the language engine's source extensions.
            // Keep the exact capture-derived limits for the compatibility
            // oracle, but never collapse an omitted manifest to a budget of 1.
            budgets: {
              max_output_bytes: 16 * 1024 * 1024,
              max_files: Math.max(1, sourceArtifacts.length || 1_000_000),
              max_source_bytes: Math.max(1, sourceByteLength || 0xffff_ffff),
            },
            ...(!nativeStageOne ? { semantic: {
              inputs_digest: sourceStateDigest,
              registry_digest: prepared.registry.registry_digest,
              plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
              plugin_version: JAVASCRIPT_TYPESCRIPT_VERSION,
              analysis_digest: prepared.plugin.compatibility.analysis_digest,
              analysis_configuration_digest: prepared.plugin.analysis_configuration_digest,
              stage_capabilities: semanticStageCapabilities,
              stage_record_kinds: semanticStageRecordKinds,
              ...(semanticPublicationStageId === undefined ? {} : { publication_stage_id: semanticPublicationStageId }),
              ...(semanticIncludedStageIds === undefined ? {} : { included_publication_stage_ids: semanticIncludedStageIds }),
              ...(candidate.base_snapshot_id === undefined ? {} : { base_snapshot_id: candidate.base_snapshot_id }),
              created_at: now,
            } } : {}),
          },
          deadline_ms: indexingCoreDeadlineMs(),
        }).finally(() => signal?.removeEventListener("abort", cancelRustGeneration));
        const expectedPhase = nativeStageOne || coreGenerationEnabled ? "group_accepted" : "prepared";
        if (generationEvent.kind !== "progress" || generationEvent.phase !== expectedPhase) throw new Error(`Rust indexing-core did not enter the ${nativeStageOne ? "engine-owned structural ingest" : "semantic staging"} state.`);
        if (nativeStageOne) nativeAffectedPaths = new Set(generationEvent.affected_paths ?? sourceArtifacts.map((artifact) => artifact.path));
        if (nativeStageOne && generationEvent.dependency_graph !== undefined) {
          for (const [path, graph] of Object.entries(generationEvent.dependency_graph)) nativeDependencyGraph.set(path, graph);
        }
      } else if (nativeStageOne && sourceArtifacts.length > 0) {
        if (rustSyntax === undefined) throw new Error("Native syntax worker is unavailable without the Rust indexing core.");
        const syntax = rustSyntax;
        claimExclusiveWork("rust", ["source_decode", "syntax_parse", "declaration_extract", "import_extract", "direct_graph", "affected_set", "stage_one_fact_build"]);
        const sourceByteLength = sourceArtifacts.reduce((total, artifact) => total + artifact.byte_length, 0);
        if (sourceByteLength > 0xffff_ffff || sourceArtifacts.length > 0xffff_ffff) throw new Error("JavaScript/TypeScript syntax input exceeds the closed Rust worker budget.");
        const requestId = `rust-syntax:${workspace_id}:${candidate.candidate_generation_id}`;
        const projectKey = canonicalSha256({ workspace_id, runtime_executable_binding_digest: syntax.runtime_executable_binding_digest });
        nativeProjectKey = projectKey;
        const analysisResult = await syntax.transport.analyze(createRustSyntaxAnalyzeRequest({
          request_id: requestId,
          cancellation_id: `cancel:${requestId}`,
          project_key: projectKey,
          configuration_digest: configuration.analysis_configuration_digest,
          root_names: sourceArtifacts.map((artifact) => artifact.path),
          ...(changedArtifactIds === undefined ? {} : { changed_artifact_ids: sourceArtifacts
            .filter((artifact) => changedArtifactIds.has(artifact.artifact_id))
            .map((artifact) => artifact.artifact_id) }),
          files: sourceArtifacts.map((artifact) => {
            const hex = artifact.content_hash.slice("sha256:".length);
            return {
              path: artifact.path,
              artifact_id: artifact.artifact_id,
              artifact_version_id: artifact.artifact_version_id,
              content_digest: artifact.content_hash,
              source_blob_path: join(casRoot, "sha256", hex.slice(0, 2), hex.slice(2)),
              byte_length: artifact.byte_length,
            };
          }),
          max_output_bytes: 16 * 1024 * 1024,
          max_files: Math.max(1, sourceArtifacts.length),
          max_source_bytes: Math.max(1, sourceByteLength),
        }), { signal });
        const coordinatedSemanticReset = analysisResult.build === "full"
          && analysisResult.reset_reason !== undefined
          && analysisResult.reset_reason !== "initial";
        if (coordinatedSemanticReset) await analysisWorkerPool?.evictWorkspace(workspace_id);
        const sourceByPath = new Map(sourceArtifacts.map((artifact) => [artifact.path, artifact]));
        if (analysisResult.affected_files.some((path) => sourceByPath.get(path) === undefined)) throw new Error("The Rust syntax worker returned an affected path outside the current source manifest.");
        nativeSyntaxResult = analysisResult;
        nativeAffectedPaths = new Set(analysisResult.affected_files);
      }
      if (coreGenerationEnabled) {
        return {
          accepted_deltas: [],
          capability_state_entries: completeStageEntries(),
          native_batches: [],
          rust_promoted_structural_rows: true,
          external_publication: rustExternalPublication,
        };
      }
      // The compatibility/oracle route still needs the complete artifact
      // version manifest for its TypeScript semantic inputs. Keep this
      // allocation behind the Rust early return so production composition
      // never builds a second owner-sized digest input.
      const artifactVersions = artifacts.map((artifact) => ({ artifact_id: artifact.artifact_id, artifact_version_id: artifact.artifact_version_id, content_hash: artifact.content_hash }));
      const targetRegistry = candidateTargetRegistryFromSnapshot({ registry: prepared.registry, artifact_versions: artifactVersions });
      // Hoisted out of the per-owner loop: these aggregate over every scanned
      // artifact, so recomputing them per owner is quadratic in workspace size.
      const inputsDigest = canonicalSha256(artifactVersions);
      if (nativeStageOne && nativeAffectedPaths !== undefined) {
        const nativeChangedPaths = changedArtifactIds === undefined
          ? new Set(sourceArtifacts.map((artifact) => artifact.path))
          : new Set(sourceArtifacts.filter((artifact) => changedArtifactIds.has(artifact.artifact_id)).map((artifact) => artifact.path));
        if ([...nativeChangedPaths].some((path) => !nativeAffectedPaths!.has(path))) throw new Error("The Rust affected set omitted a changed JavaScript/TypeScript source.");
        nativeSemanticScope = {
          inputs_digest: inputsDigest,
          configuration_digest: configuration.analysis_configuration_digest,
          changed_paths: nativeChangedPaths,
          affected_paths: nativeAffectedPaths,
          dependency_graph: nativeDependencyGraph,
        };
      }
      const inheritedNativeScope = !nativeStageOne
        && nativeSemanticScope?.inputs_digest === inputsDigest
        && nativeSemanticScope.configuration_digest === configuration.analysis_configuration_digest
        ? nativeSemanticScope
        : undefined;
      const rustSemanticScopeForPaths = (paths: readonly string[]): {
        readonly authority: "urdira:jsts-syntax-worker";
        readonly changed_paths: readonly string[];
        readonly affected_paths: readonly string[];
      } | undefined => {
        if (inheritedNativeScope === undefined) return undefined;
        const included = new Set(paths);
        return {
          authority: "urdira:jsts-syntax-worker",
          changed_paths: [...inheritedNativeScope.changed_paths].filter((path) => included.has(path)).sort(),
          affected_paths: [...inheritedNativeScope.affected_paths].filter((path) => included.has(path)).sort(),
        };
      };
      const fullRustSemanticScope = rustSemanticScopeForPaths(sourceArtifacts.map((artifact) => artifact.path));
      const manifestEntries = javascriptTypescriptAccessManifestEntries(artifactVersions);
      const manifestEntriesDigest = canonicalSha256(manifestEntries);
      const rootNames = sourceArtifacts.map((artifact) => artifact.path);
      const artifactsByPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
      // Semantic stages fetch every owner's import closure once per scan. The
      // native structural stage uses the Rust result directly and never enters
      // this TypeScript path.
      // 5.1: prepare dependency/semantic state ONCE per scan. The legacy route
      // may still return TypeScript closures. With Rust authority this call
      // only creates or updates the compiler project: it does not walk the
      // corpus or materialize a whole-project JsTsAnalysisResult. Owner calls
      // below use the Rust closure and walk exactly one owner through that
      // prepared checker.
      // A graph returned by the TypeScript closure call can safely narrow
      // manifests, but it does not authorize the syntax-only fact builder.
      // Only a faithful, non-reset Rust result does. Keeping these decisions
      // separate is essential for JS/JSDoc files whose direct imports are
      // representable by Oxc while their declarations still require the
      // TypeScript checker.
      // Rust already owns import extraction and the inverse affected closure.
      // `analyze_closure` remains the closed fifth plugin call, but with a
      // Rust-authoritative scope it only prepares/reuses the TypeScript
      // program and checker-backed facts. It must not reconstruct stage-one
      // facts, a dependency graph, or an affected closure.
      const needsSemanticClosure = !nativeStageOne;
      const worker = nativeStageOne || coreGenerationEnabled ? undefined : await acquirePooledWorker(closureWorkerKey);
      if (worker !== undefined) claimExclusiveWork("typescript", ["semantic_program_build"]);
      const semanticWorker = (): JavascriptTypescriptSemanticProcessTransport | import("@urdira/plugin-sdk").WorkerTransport => {
        if (worker === undefined) throw new Error("Exclusive-work violation: native structural stage attempted to use the TypeScript semantic process.");
        return worker;
      };
      const closureRequestId = `request:closure:${workspace_id}:${candidate.candidate_generation_id}`;
      const closureStartedAt = performance.now();
      let closureResponse: {
        readonly payload: {
          readonly dependency_closures?: Readonly<Record<string, { readonly files: readonly string[]; readonly complete: boolean }>>;
          readonly dependency_graph?: Readonly<Record<string, { readonly direct_files: readonly string[]; readonly complete: boolean }>>;
          readonly impactful_changed_paths?: readonly string[];
          readonly semantic_state_prepared?: boolean;
          readonly dependency_authority?: "urdira:jsts-syntax-worker";
        };
      } | undefined;
      // P3-3b: pre-seed the worker's durable stage-1 dependency-graph cache
      // (`writeSyntaxDependencyGraphCache`) from the specifiers `on_source_text`
      // already collected during THIS scan's own source cataloging (above,
      // in `runFullWorkspaceScan`), so the `analyze_closure` call below can
      // cache-hit (`worker.ts`'s own early-return, keyed by the identical
      // `largeSyntaxManifestKey`) instead of re-scanning every file's text a
      // second time. Gated exactly like the worker gates its OWN cache
      // lookup (`publication_stage_id === "jsts:structural_stage_1"` and the
      // shared large-corpus thresholds) so a small scan never pays for a
      // cache entry the worker will never look for. Requires 100% specifier
      // coverage of `rootNames`: on an INCREMENTAL rescan, most files are
      // typically reused via `readStream`'s `reuse_existing` short-circuit
      // (directory-provider.ts) and never flow through `on_source_text` at
      // all, so this naturally no-ops there and only actually fires on a
      // from-zero/full scan -- exactly the case the durable cache is for.
      // Never allowed to fail the scan: any error here is swallowed, and a
      // cache miss is always safe (the worker just builds the graph itself).
      if (!nativeStageOne && publication_stage_id === "jsts:structural_stage_1" && analysisCacheDir !== undefined && sourceArtifacts.length > 0) {
        try {
          let totalBytes = 0;
          for (const artifact of sourceArtifacts) totalBytes += artifact.byte_length;
          const meetsLargeCorpusThreshold = sourceArtifacts.length >= LARGE_SYNTAX_CORPUS_FILE_THRESHOLD || totalBytes >= LARGE_SYNTAX_CORPUS_BYTE_THRESHOLD;
          const fullCoverage = rootNames.every((path) => importSpecifiersByPath.has(path));
          if (meetsLargeCorpusThreshold && fullCoverage) {
            const graph = resolveSyntaxDependencyGraph(rootNames, importSpecifiersByPath);
            const graphKey = largeSyntaxManifestKey({ files: sourceArtifacts, root_names: rootNames }, rootNames, workerDescriptor);
            if (graphKey !== undefined) await writeSyntaxDependencyGraphCache(analysisCacheDir, graphKey, graph);
          }
        } catch { /* pre-seed is a pure speedup; a failure here must not fail indexing */ }
      }
      let closureWorkerRetained = false;
      const buildSemanticClosureRequest = (): PluginWorkerRequestEnvelope => ({
        protocol_version: "1.0.0", request_id: closureRequestId, request_digest: canonicalSha256({ request_id: closureRequestId, inputs_digest: inputsDigest, configuration_digest: configuration.analysis_configuration_digest, rust_semantic_scope: fullRustSemanticScope ?? null }), call: "analyze_closure", deadline: "2099-01-01T00:00:00.000Z", cancellation_id: `cancel:${closureRequestId}`,
        payload: {
          files: sourceArtifacts,
          root_names: rootNames,
          ...(publication_stage_id === undefined ? {} : { publication_stage_id }),
          ...(fullRustSemanticScope === undefined ? {} : { rust_semantic_scope: fullRustSemanticScope }),
        },
      });
      try {
        if (!needsSemanticClosure || sourceArtifacts.length === 0) {
          // Native stage one already supplied the authoritative affected set.
        }
        else if (coreGenerationEnabled) {
          // The Rust composition worker now owns semantic preparation and
          // owner request construction inside the generation transaction. The
          // application does not invoke a second checker or materialise a
          // closure response on this production route.
        } else {
          closureResponse = await semanticWorker().invoke(buildSemanticClosureRequest()) as {
        readonly payload: {
          readonly dependency_closures?: Readonly<Record<string, { readonly files: readonly string[]; readonly complete: boolean }>>;
          readonly dependency_graph?: Readonly<Record<string, { readonly direct_files: readonly string[]; readonly complete: boolean }>>;
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
          readonly semantic_state_prepared?: boolean;
          readonly dependency_authority?: "urdira:jsts-syntax-worker";
        };
          } | undefined;
        }
      if (!coreGenerationEnabled && inheritedNativeScope !== undefined && (closureResponse?.payload.semantic_state_prepared !== true || closureResponse.payload.dependency_authority !== "urdira:jsts-syntax-worker"
        || closureResponse.payload.dependency_graph !== undefined || closureResponse.payload.dependency_closures !== undefined)) {
        throw new Error("The TypeScript semantic worker did not preserve exclusive Rust dependency authority.");
      }
      } finally {
        if (worker !== undefined && closureResponse === undefined && !closureWorkerRetained) {
          if (analysisWorkerPool !== undefined) analysisWorkerPool.release(closureWorkerKey);
          else await semanticWorker().terminate();
        }
      }
      closureWorkerRetained = worker !== undefined;
      const closureMs = needsSemanticClosure ? Math.round(performance.now() - closureStartedAt) : 0;
      const dependencyClosures = closureResponse?.payload.dependency_closures ?? {};
      const dependencyGraph = closureResponse?.payload.dependency_graph;
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
      const reverseReachable = (seeds: ReadonlySet<string>): ReadonlySet<string> => {
        if (dependencyGraph === undefined) return seeds;
        const reverse = new Map<string, string[]>();
        for (const [source, node] of Object.entries(dependencyGraph)) for (const dependency of node.direct_files) {
          const dependents = reverse.get(dependency);
          if (dependents === undefined) reverse.set(dependency, [source]);
          else dependents.push(source);
        }
        const reachable = new Set(seeds);
        const queue = [...seeds];
        for (let index = 0; index < queue.length; index += 1) for (const dependent of reverse.get(queue[index]!) ?? []) {
          if (reachable.has(dependent)) continue;
          reachable.add(dependent);
          queue.push(dependent);
        }
        return reachable;
      };
      // An unresolved local dependency anywhere in an owner's reachable graph
      // keeps the conservative "affected" behavior used by transitive
      // closures, without materializing one closure array per owner.
      const graphIncompleteOwners = dependencyGraph === undefined
        ? new Set<string>()
        : reverseReachable(new Set(Object.entries(dependencyGraph).filter(([, node]) => !node.complete).map(([path]) => path)));
      const graphAffectedOwners = changedPaths === undefined
        ? undefined
        : reverseReachable(impactfulChangedPaths ?? changedPaths);
      const isAffectedOwner = (owner: WorkspaceScanSourceArtifact): boolean => {
        if (nativeStageOne) return nativeAffectedPaths?.has(owner.path) ?? false;
        if (inheritedNativeScope !== undefined) return inheritedNativeScope.affected_paths.has(owner.path);
        if (changedPaths === undefined) return true;
        if (changedPaths.has(owner.path)) return true;
        if (dependencyGraph !== undefined) {
          if (dependencyGraph[owner.path] === undefined || graphIncompleteOwners.has(owner.path)) return true;
          return graphAffectedOwners?.has(owner.path) ?? true;
        }
        const closure = dependencyClosures[owner.path];
        if (closure === undefined || !closure.complete) return true;
        if (impactfulChangedPaths !== undefined) return closure.files.some((path) => impactfulChangedPaths.has(path));
        return closure.files.some((path) => changedPaths.has(path));
      };
      const affectedOwners = sourceArtifacts.filter(isAffectedOwner);
      // A TypeScript checker keeps a complete program graph in each worker.
      // Duplicating that graph across two workers is faster for ordinary
      // workspaces, but becomes the dominant memory cost on large repositories
      // (VS Code crossed 10 GiB before this cap). Keep one checker for a large
      // corpus; the requests remain bounded and correctness is unchanged.
      const sourceByteLength = sourceArtifacts.reduce((total, artifact) => total + artifact.byte_length, 0);
      const largeWorkspace = sourceArtifacts.length >= largeWorkspaceArtifactThreshold() || sourceByteLength >= 128 * 1024 * 1024;
      const nativeClosureMemo = new Map<string, readonly string[] | undefined>();
      const completeNativeClosure = (ownerPath: string): readonly string[] | undefined => {
        if (inheritedNativeScope === undefined || inheritedNativeScope.dependency_graph.size !== sourceArtifacts.length) return undefined;
        if (nativeClosureMemo.has(ownerPath)) return nativeClosureMemo.get(ownerPath);
        const closure = new Set<string>();
        const queue = [ownerPath];
        for (let index = 0; index < queue.length; index += 1) {
          const path = queue[index]!;
          if (closure.has(path)) continue;
          closure.add(path);
          const node = inheritedNativeScope.dependency_graph.get(path);
          if (node === undefined || !node.complete) {
            nativeClosureMemo.set(ownerPath, undefined);
            return undefined;
          }
          for (const dependency of node.direct_files) if (!closure.has(dependency)) queue.push(dependency);
        }
        const result = Object.freeze([...closure].sort());
        nativeClosureMemo.set(ownerPath, result);
        return result;
      };
      type AnalysisPlan = {
        readonly planIndex: number;
        readonly ownerPath: string;
        readonly ownerArtifacts: readonly WorkspaceScanSourceArtifact[];
        readonly workItem: ArtifactWorkItem & { readonly candidate_generation_id: string; readonly base_snapshot_id?: string };
        readonly scope: ReplacementScope;
        readonly manifest: AutomaticPluginInputAccessManifest;
        readonly contextDigest: string;
        readonly analysisInputDigest: string;
        readonly cancellationId: string;
        readonly request?: PluginWorkerRequestEnvelope;
      };
      const buildPlan = (owner: WorkspaceScanSourceArtifact, planIndex: number): AnalysisPlan => {
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
        const graphNode = nativeStageOne ? nativeDependencyGraph.get(owner.path) : dependencyGraph?.[owner.path];
        const closure = dependencyClosures[owner.path];
        const nativeSemanticClosure = completeNativeClosure(owner.path);
        const narrowedPaths = nativeSemanticClosure !== undefined
          ? nativeSemanticClosure
          : graphNode !== undefined && graphNode.complete
          ? [...new Set([owner.path, ...graphNode.direct_files])].sort()
          : closure !== undefined && closure.complete ? closure.files : undefined;
        const narrowed = narrowedPaths !== undefined;
        const ownerArtifacts = narrowedPaths !== undefined
          ? narrowedPaths.map((path) => artifactsByPath.get(path)).filter((artifact): artifact is WorkspaceScanSourceArtifact => artifact !== undefined)
          : sourceArtifacts;
        const ownerManifestEntries = narrowed ? javascriptTypescriptAccessManifestEntries(ownerArtifacts.map((artifact) => ({ artifact_id: artifact.artifact_id, artifact_version_id: artifact.artifact_version_id, content_hash: artifact.content_hash }))) : manifestEntries;
        const manifest = javascriptTypescriptAccessManifest(workItemId, contextDigest, ownerManifestEntries);
        const analysisInputDigest = canonicalSha256({ owner: owner.path, inputs_digest: narrowed ? canonicalSha256(ownerManifestEntries) : manifestEntriesDigest });
        const cancellationId = `cancel:${workItemId}`;
        const ownerRustSemanticScope = rustSemanticScopeForPaths(narrowedPaths ?? rootNames);
        const request = nativeStageOne ? undefined : {
          protocol_version: "1.0.0", request_id: manifest.request_id, request_digest: analysisInputDigest, call: "analyze_artifact" as const, deadline: "2099-01-01T00:00:00.000Z", cancellation_id: `cancel:${workItemId}`,
          payload: {
            files: ownerArtifacts,
            root_names: narrowedPaths ?? rootNames,
            owner_path: owner.path,
            work_item: workItem,
            accepted_manifest: manifest,
            analysis_digest: prepared.plugin.compatibility.analysis_digest,
            analysis_configuration_digest: prepared.plugin.analysis_configuration_digest,
            analysis_input_digest: analysisInputDigest,
            created_at: now,
            ...(publication_stage_id === undefined ? {} : { publication_stage_id }),
            ...(included_publication_stage_ids === undefined ? {} : { included_publication_stage_ids }),
            ...(ownerRustSemanticScope === undefined ? {} : { rust_semantic_scope: ownerRustSemanticScope }),
          },
        };
        return { workItem, scope, manifest, contextDigest, analysisInputDigest, cancellationId, ownerPath: owner.path, ownerArtifacts, ...(request === undefined ? {} : { request }), planIndex };
      };
      // Ordinary workspaces keep the existing two-stage pipeline. Large
      // workspaces deliberately do not materialise 10k+ request envelopes and
      // closure-sized file arrays: one plan is built, consumed, and released
      // before the next owner is planned. This preserves order and bounded
      // worker backpressure without retaining a corpus-sized plan graph.
      // Rust-owned generations never materialise TypeScript owner plans. The
      // composition worker constructs the semantic envelopes after capture;
      // this map is reserved for the explicit oracle/fallback routes.
      const plans: readonly AnalysisPlan[] | undefined = coreGenerationEnabled || nativeStageOne || largeWorkspace ? undefined : affectedOwners.map(buildPlan);
      const planCount = plans?.length ?? affectedOwners.length;
      // `URDIRA_ANALYSIS_LARGE_SHARDS` (default 1 -- today's exact behavior)
      // only widens the large-workspace stream when this scan is actually
      // running the test/development TypeScript bounded-syntax path. A native
      // stage never reaches these semantic shards at all. Bounded syntax keeps
      // no per-worker TypeScript checker/program
      // graph, only per-owner syntax state, so a few extra workers are
      // memory-safe the way duplicating a full checker never was (see the
      // `largeWorkspace` comment above). If a large workspace somehow still
      // falls back to full-checker analysis (`dependencyGraph === undefined`),
      // the multi-checker OOM risk that comment describes is back, so this
      // forces 1 regardless of the env var.
      const effectiveLargeShardCount = largeWorkspace && !nativeStageOne && publication_stage_id === "jsts:structural_stage_1" ? analysisLargeWorkspaceShardCount() : 1;
      // A Rust-authoritative production route keeps exactly one persistent
      // checker project. Multiple semantic shards would duplicate the compiler
      // project even though Rust has already narrowed the affected set. The
      // worker releases each owner snapshot and source cache between requests.
      // Test/development routes without native authority retain their
      // configurable sharding behavior.
      const shardCount = coreGenerationEnabled || nativeStageOne || inheritedNativeScope !== undefined
        ? 1
        : Math.max(1, Math.min(largeWorkspace ? effectiveLargeShardCount : analysisWorkerShardCount, planCount || 1));
      const shards = plans === undefined ? [] : Array.from({ length: shardCount }, (_, shard) => plans.filter((_, index) => index % shardCount === shard));
      let acceptanceMs = 0;
      const invokeDirectStream = (transport: WorkerTransport, plan: AnalysisPlan): Promise<FactDeltaStream> => {
        if (plan.request === undefined) throw new Error("Exclusive-work violation: native stage-one plan was routed to the TypeScript process.");
        const direct = (transport as WorkerTransport & { readonly invokeFactDeltaStream?: (request: PluginWorkerRequestEnvelope) => Promise<FactDeltaStream> }).invokeFactDeltaStream;
        if (direct === undefined) throw new Error("The production JavaScript/TypeScript semantic process does not support direct FactDeltaStream@2 emission.");
        return direct.call(transport, plan.request);
      };
      const invokeDirectGroup = async (transport: WorkerTransport, group: readonly AnalysisPlan[]): Promise<readonly FactDeltaStream[]> => {
        if (signal?.aborted) throw Object.assign(new Error("Grouped semantic analysis was cancelled."), { name: "AbortError" });
        const requests = group.map((plan) => {
          if (plan.request === undefined) throw new Error("Exclusive-work violation: native stage-one plan was routed to the TypeScript semantic group.");
          return plan.request;
        });
        const direct = (transport as WorkerTransport & { readonly invokeFactDeltaStreamGroup?: (requests: readonly PluginWorkerRequestEnvelope[]) => Promise<readonly FactDeltaStream[]> }).invokeFactDeltaStreamGroup;
        if (direct === undefined) throw new Error("The production JavaScript/TypeScript semantic process does not support grouped FactDeltaStream@2 emission.");
        const streams = await direct.call(transport, requests);
        if (signal?.aborted) throw Object.assign(new Error("Grouped semantic analysis was cancelled."), { name: "AbortError" });
        return streams;
      };
      const invokeDirectGroupBounded = async (transport: WorkerTransport, group: readonly AnalysisPlan[]): Promise<readonly FactDeltaStream[]> => {
        try {
          return await invokeDirectGroup(transport, group);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (group.length <= 1 || !/semantic (?:process )?group exceeds|semantic owner group exceeds/iu.test(message)) throw error;
          const split = Math.ceil(group.length / 2);
          const left = await invokeDirectGroupBounded(transport, group.slice(0, split));
          const right = await invokeDirectGroupBounded(transport, group.slice(split));
          return Object.freeze([...left, ...right]);
        }
      };
      type NativeOwnerRows = {
        readonly records: readonly ProposedRecord[];
        readonly dependencies: readonly ProposedRecordDependency[];
        readonly imports: readonly RustSyntaxDirectImport[];
      };
      const readNativeOwnerGroup = async (owners: readonly WorkspaceScanSourceArtifact[]): Promise<ReadonlyMap<string, NativeOwnerRows>> => {
        if (!nativeStageOne || nativeProjectKey === undefined) throw new Error("Native fact pages require an active Rust stage-one analysis.");
        const ownerByPath = new Map(owners.map((owner) => [owner.path, owner]));
        const rowsByPath = new Map<string, { records: ProposedRecord[]; dependencies: ProposedRecordDependency[]; imports: RustSyntaxDirectImport[]; seen_cursors: Set<string> }>();
        for (const owner of owners) rowsByPath.set(owner.path, { records: [], dependencies: [], imports: [], seen_cursors: new Set() });
        let pending: { readonly path: string; readonly cursor?: RustSyntaxFactCursor }[] = owners.map((owner) => ({ path: owner.path }));
        let requestSequence = 0;
        while (pending.length > 0) {
          const requestEntries = pending;
          const transport = rustSyntax!.transport;
          // Production handshakes require the grouped protocol. The scalar
          // branch keeps injected/test transports and older in-process ports
          // source-compatible without weakening the worker handshake.
          const result = typeof transport.readFactsGroup === "function"
            ? await transport.readFactsGroup({
              project_key: nativeProjectKey,
              entries: requestEntries,
              max_output_bytes: 16 * 1024 * 1024,
              max_rows: 4096,
              cancellation_id: `cancel:facts-group:${candidate.candidate_generation_id}:${requestSequence}`,
            }, { signal })
            : {
              pages: [await transport.readFacts({
                project_key: nativeProjectKey,
                path: requestEntries[0]!.path,
                ...(requestEntries[0]!.cursor === undefined ? {} : { cursor: requestEntries[0]!.cursor }),
                max_output_bytes: 16 * 1024 * 1024,
                max_rows: 4096,
                cancellation_id: `cancel:facts:${candidate.candidate_generation_id}:${requestSequence}`,
              }, { signal })],
              ...(requestEntries.length > 1 ? { next_request_index: 1 } : {}),
            };
          requestSequence += 1;
          const next: { readonly path: string; readonly cursor?: RustSyntaxFactCursor }[] = [];
          for (const page of result.pages) {
            const owner = ownerByPath.get(page.path);
            const rows = rowsByPath.get(page.path);
            if (owner === undefined || rows === undefined || page.content_digest !== owner.content_hash || page.byte_length !== owner.byte_length || !page.parsed || page.diagnostics.length !== 0) {
              throw new Error(`The Rust syntax worker could not produce a complete native stage-one page for ${page.path}; TypeScript fallback is forbidden.`);
            }
            rows.imports.push(...page.direct_imports);
            rows.records.push(...page.records);
            rows.dependencies.push(...page.dependencies);
            if (page.next_cursor !== undefined) {
              const key = `${page.next_cursor.imports_offset}:${page.next_cursor.records_offset}:${page.next_cursor.dependencies_offset}`;
              if (rows.seen_cursors.has(key)) throw new Error(`Rust syntax fact pagination did not advance for ${page.path}.`);
              rows.seen_cursors.add(key);
              next.push({ path: page.path, cursor: page.next_cursor });
            }
          }
          const nextRequestIndex = result.next_request_index ?? requestEntries.length;
          if (nextRequestIndex < result.pages.length || nextRequestIndex > requestEntries.length) throw new Error("Rust syntax fact-group continuation did not advance.");
          next.push(...requestEntries.slice(nextRequestIndex));
          if (next.length === 0 && (result.next_request_index !== undefined || result.pages.some((page) => page.next_cursor !== undefined))) throw new Error("Rust syntax fact-group continuation was lost.");
          pending = next;
        }
        const completed = new Map<string, NativeOwnerRows>();
        for (const owner of owners) {
          const rows = rowsByPath.get(owner.path)!;
          if (new Set(rows.records.map((record) => record.proposal_record_key)).size !== rows.records.length) throw new Error(`Rust syntax fact pages repeated a record for ${owner.path}.`);
          if (new Set(rows.dependencies.map((dependency) => dependency.proposed_dependency_id)).size !== rows.dependencies.length) throw new Error(`Rust syntax fact pages repeated a dependency for ${owner.path}.`);
          const directFiles = [...new Set(rows.imports.flatMap((edge) => edge.target_path === undefined ? [] : [edge.target_path]))].sort();
          nativeDependencyGraph.set(owner.path, {
            direct_files: Object.freeze(directFiles),
            complete: !rows.imports.some((edge) => edge.target_path === undefined && edge.specifier.startsWith(".")),
          });
          completed.set(owner.path, { records: Object.freeze(rows.records), dependencies: Object.freeze(rows.dependencies), imports: Object.freeze(rows.imports) });
        }
        return completed;
      };
      const invokeNativeStageOne = (plan: AnalysisPlan, rows: NativeOwnerRows): FactDeltaStream => buildJavascriptTypescriptNativeFactDeltaStream({
        work_item: plan.workItem as unknown as Readonly<Record<string, unknown>>,
        accepted_manifest: plan.manifest as unknown as Readonly<Record<string, unknown>>,
        analysis_digest: prepared.plugin.compatibility.analysis_digest,
        analysis_configuration_digest: prepared.plugin.analysis_configuration_digest,
        analysis_input_digest: plan.analysisInputDigest,
        created_at: now,
        ...(publication_stage_id === undefined ? {} : { publication_stage_id }),
        owner_path: plan.ownerPath,
        files: plan.ownerArtifacts,
        records: rows.records,
        dependencies: rows.dependencies,
        diagnostic_codes: [],
      }, { cancellation_id: plan.cancellationId });
      const validationInputForPlan = (plan: AnalysisPlan) => ({ candidate, work_item: plan.workItem, accepted_manifest: plan.manifest, expected_replacement_scopes: [plan.scope], target_registry: targetRegistry, base_records: [], base_record_dependencies: [], staged_records: [], analysis_context_digest: plan.contextDigest });
      const consumePlanResponse = async (stream: FactDeltaStream, plan: AnalysisPlan): Promise<MaterializationAcceptedFactDelta> => {
        // `fact_delta_accept` (P3-3c): `acceptance.accept`'s own service
        // cost (validation + staging), also inside `plugin_analyze`'s span --
        // see `accept_native_stage`'s comment above for why this is recorded
        // here rather than relying on `execute_non_analyze`.
        const acceptStartedAt = engineTimingEnabled() ? performance.now() : 0;
        const acceptWallStartedAt = debugTimingEnabled() ? performance.now() : 0;
        const delta = await streamAcceptance!.acceptValidated(stream, validationInputForPlan(plan));
        if (engineTimingEnabled()) recordEngineTiming("fact_delta_accept", performance.now() - acceptStartedAt);
        if (debugTimingEnabled()) acceptanceMs += performance.now() - acceptWallStartedAt;
        // (3a pipelined) Hand the compacted delta to the engine's streaming
        // consumer the moment it exists, so per-record digest work overlaps
        // the rest of this analyze instead of running after it. This callback
        // is part of the first-publication materialization path: propagating a
        // spool failure is required to prevent a partially accumulated
        // candidate from being sealed as complete.
        if (on_accepted_delta !== undefined) await on_accepted_delta(delta);
        return delta;
      };
      const consumePlanGroup = async (entries: readonly { readonly plan: AnalysisPlan; readonly stream: () => Promise<FactDeltaStream> }[], maxStreams: number): Promise<readonly { readonly plan_index: number; readonly delta: MaterializationAcceptedFactDelta }[]> => {
        if (entries.length === 0) return [];
        const acceptStartedAt = engineTimingEnabled() ? performance.now() : 0;
        const acceptWallStartedAt = debugTimingEnabled() ? performance.now() : 0;
        const deltas = await streamAcceptance!.acceptValidatedGroup((async function* () {
          for (const entry of entries) {
            if (signal?.aborted) throw Object.assign(new Error("Grouped FactDelta analysis was cancelled."), { name: "AbortError" });
            yield { stream: await entry.stream(), input: validationInputForPlan(entry.plan) };
          }
        })(), { ...(signal === undefined ? {} : { signal }), max_streams: maxStreams, max_rows: 4096, max_bytes: 16 * 1024 * 1024 });
        if (engineTimingEnabled()) recordEngineTiming("fact_delta_accept", performance.now() - acceptStartedAt);
        if (debugTimingEnabled()) acceptanceMs += performance.now() - acceptWallStartedAt;
        const results: { readonly plan_index: number; readonly delta: MaterializationAcceptedFactDelta }[] = [];
        for (let index = 0; index < deltas.length; index += 1) {
          const delta = deltas[index]!;
          const plan = entries[index]!.plan;
          if (on_accepted_delta !== undefined) await on_accepted_delta(delta);
          else results.push({ plan_index: plan.planIndex, delta });
        }
        return results;
      };
      const invokeShard = async (shard: readonly AnalysisPlan[], shardIndex: number): Promise<readonly { readonly plan_index: number; readonly delta: MaterializationAcceptedFactDelta }[]> => {
        if (shard.length === 0) return [];
        const shardKey = `${workspace_id}:shard:${shardIndex}`;
        const ownsClosureWorker = shardIndex === 0;
        const shardWorker = ownsClosureWorker
          ? semanticWorker()
          : await acquirePooledWorker(shardKey);
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
              payload: {
                files: sourceArtifacts,
                root_names: rootNames,
                ...(publication_stage_id === undefined ? {} : { publication_stage_id }),
                ...(fullRustSemanticScope === undefined ? {} : { rust_semantic_scope: fullRustSemanticScope }),
              },
            });
          }
          const results: { readonly plan_index: number; readonly delta: MaterializationAcceptedFactDelta }[] = [];
          let pending = invokeDirectStream(shardWorker, shard[0]!);
          pending.catch(() => undefined);
          for (let index = 0; index < shard.length; index += 1) {
            const response = await pending;
            const plan = shard[index]!;
            // Accept each response before releasing it. Retaining every raw
            // FactDelta until all owners finish doubles the peak heap for a
            // large workspace and was the direct cause of the VS Code OOM.
            const delta = await consumePlanResponse(response, plan);
            if (on_accepted_delta === undefined) results.push({ plan_index: plan.planIndex, delta });
            if ((index + 1) % 100 === 0 || index + 1 === shard.length) console.error(`[urdira] analyze shard progress workspace=${workspace_id} stage=${publication_stage_id ?? "full"} shard=${shardIndex} completed=${index + 1}/${shard.length}`);
            if (index + 1 < shard.length) {
              pending = invokeDirectStream(shardWorker, shard[index + 1]!);
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
      let shardResults: readonly { readonly plan_index: number; readonly delta: MaterializationAcceptedFactDelta }[] = [];
      // Populated only by the large-workspace stream branches below, for the
      // `shards_used`/`demotions`/`per_shard_completed` timing fields -- the
      // materialized (ordinary-workspace) branch already reports its own
      // shard count via the pre-existing `shards` field.
      let largeStreamTelemetry: { readonly shards_used: number; readonly demotions: number; readonly per_shard_completed: readonly number[] } | undefined;
      if (coreGenerationEnabled && nativeStageOne) {
        // The composition worker already analyzed, validated, grouped and
        // ingested every affected owner into SQLite. Do not construct owner
        // plans or invoke either the Rust fact-page API or a TypeScript
        // semantic process here: that would duplicate the dominant work and
        // would violate the single Rust publication owner.
        largeStreamTelemetry = { shards_used: 0, demotions: 0, per_shard_completed: [affectedOwners.length] };
      } else if (nativeStageOne) {
        const groupSize = 64;
        for (let groupStart = 0; groupStart < affectedOwners.length; groupStart += groupSize) {
          if (signal?.aborted) throw Object.assign(new Error("Native stage-one analysis was cancelled."), { name: "AbortError" });
          const groupEnd = Math.min(affectedOwners.length, groupStart + groupSize);
          const groupOwners = affectedOwners.slice(groupStart, groupEnd);
          const rowsByPath = await readNativeOwnerGroup(groupOwners);
          const group = Array.from({ length: groupEnd - groupStart }, (_, offset) => {
            const planIndex = groupStart + offset;
            const owner = affectedOwners[planIndex]!;
            const plan = buildPlan(owner, planIndex);
            return { plan, stream: async () => invokeNativeStageOne(plan, rowsByPath.get(owner.path)!) };
          });
          // This branch is the explicit Rust-syntax fallback only. The
          // self-contained composition-worker path never enters it, so there
          // is no second TypeScript->Rust acceptance loop for production
          // structural generations.
          const groupResults = await consumePlanGroup(group, groupSize);
          for (const result of groupResults) accepted.push(result.delta);
          if (groupEnd % 100 < groupSize || groupEnd === affectedOwners.length) console.error(`[urdira] native stage-one progress workspace=${workspace_id} completed=${groupEnd}/${affectedOwners.length}`);
        }
        if (nativeSyntaxResult !== undefined && nativeProjectKey !== undefined) {
          await rustSyntax!.transport.commitAnalysis({ project_key: nativeProjectKey, analysis_token: nativeSyntaxResult.analysis_token }, { signal });
        }
        largeStreamTelemetry = { shards_used: 0, demotions: 0, per_shard_completed: [affectedOwners.length] };
      } else if (coreGenerationEnabled && !nativeStageOne) {
        // Rust has already run the checker, built semantic envelopes, and
        // accepted canonical rows before returning from `indexGeneration`.
        // Keep this branch as telemetry only; no owner plans or V8 callbacks
        // are created on the production cutover route.
        largeStreamTelemetry = { shards_used: 1, demotions: 0, per_shard_completed: [affectedOwners.length] };
      } else if (plans !== undefined && shards.length > 1) {
        shardResults = (await Promise.all(shards.map((shard, shardIndex) => invokeShard(shard, shardIndex)))).flat().sort((left, right) => left.plan_index - right.plan_index);
      } else if (affectedOwners.length > 0 && shardCount <= 1) {
        // Large workspaces default to a single bounded owner stream. At most
        // one request envelope, one worker response, and one accepted delta
        // are live at each step; no corpus-sized `plans` or `shards` array
        // exists. (`shardCount > 1` -- `URDIRA_ANALYSIS_LARGE_SHARDS` -- takes
        // the K-shard stream branch below instead.)
        try {
          // Keep checker envelopes at the measured eight-owner RSS-safe bound,
          // while letting the independent physical staging boundary collect
          // up to 64 owners (and still stop at 4,096 rows or 16 MiB). Each
          // lazy semantic chunk releases its returned stream array as soon as
          // all eight owner-delimited streams have been consumed, so widening
          // the SQLite amortisation window does not widen checker residency.
          const semanticGroupSize = 8;
          const physicalGroupSize = 64;
          for (let groupStart = 0; groupStart < affectedOwners.length; groupStart += physicalGroupSize) {
            if (signal?.aborted) throw Object.assign(new Error("Grouped semantic analysis was cancelled."), { name: "AbortError" });
            const groupEnd = Math.min(affectedOwners.length, groupStart + physicalGroupSize);
            const groupPlans = Array.from({ length: groupEnd - groupStart }, (_, offset) => {
              const planIndex = groupStart + offset;
              return buildPlan(affectedOwners[planIndex]!, planIndex);
            });
            const group: { readonly plan: AnalysisPlan; readonly stream: () => Promise<FactDeltaStream> }[] = [];
            for (let semanticStart = 0; semanticStart < groupPlans.length; semanticStart += semanticGroupSize) {
              const semanticPlans = groupPlans.slice(semanticStart, semanticStart + semanticGroupSize);
              let streams: readonly FactDeltaStream[] | undefined;
              let streamsPromise: Promise<readonly FactDeltaStream[]> | undefined;
              let remaining = semanticPlans.length;
              const load = async (): Promise<readonly FactDeltaStream[]> => {
                if (streams !== undefined) return streams;
                streamsPromise ??= invokeDirectGroupBounded(semanticWorker(), semanticPlans);
                streams = await streamsPromise;
                if (streams.length !== semanticPlans.length) throw new Error("The semantic owner group returned the wrong number of streams.");
                return streams;
              };
              for (const [semanticIndex, plan] of semanticPlans.entries()) {
                group.push({
                  plan,
                  stream: inheritedNativeScope === undefined ? () => invokeDirectStream(semanticWorker(), plan) : async () => {
                    const result = (await load())[semanticIndex]!;
                    remaining -= 1;
                    if (remaining === 0) { streams = undefined; streamsPromise = undefined; }
                    return result;
                  },
                });
              }
            }
            const groupResults = await consumePlanGroup(group, physicalGroupSize);
            for (const result of groupResults) accepted.push(result.delta);
            if (groupEnd % 100 < physicalGroupSize || groupEnd === affectedOwners.length) console.error(`[urdira] analyze shard progress workspace=${workspace_id} stage=${publication_stage_id ?? "full"} shard=0 completed=${groupEnd}/${affectedOwners.length}`);
          }
        } finally {
          if (analysisWorkerPool !== undefined) analysisWorkerPool.release(closureWorkerKey);
          else await semanticWorker().terminate();
          closureWorkerRetained = false;
        }
        largeStreamTelemetry = { shards_used: 1, demotions: 0, per_shard_completed: [affectedOwners.length] };
      } else if (affectedOwners.length > 0) {
        // K-shard bounded-syntax stream (`URDIRA_ANALYSIS_LARGE_SHARDS`, K =
        // `shardCount` here, already clamped to [1, 4] and to `bounded_syntax`
        // applicability -- see `effectiveLargeShardCount` above). Each shard
        // is its own worker running the SAME one-plan-at-a-time discipline as
        // the single-shard stream above. Unlike that path, extra shards here
        // never re-issue `analyze_closure`: bounded-syntax `analyze_artifact`
        // does not consult a per-worker `JsTsAnalysisSession` (see
        // `packages/plugin-javascript-typescript/src/worker.ts`'s
        // `analyze_artifact` handling -- large corpora never enter that
        // session), so the ONE `dependencyGraph` already fetched above is a
        // plain returned object every shard's `buildPlan` call can narrow
        // against directly, with nothing to warm per worker.
        //
        // Owners are claimed via a single shared, strictly-increasing cursor
        // over `affectedOwners` (already in plan_index order) rather than a
        // static `planIndex % shardCount` partition. A static partition
        // cannot survive demotion without deadlocking: handing a demoted
        // shard's leftover HIGH-plan_index owners to a survivor's own queue
        // can force that survivor to submit a high plan_index before a lower
        // one (still unclaimed, from the demoted shard) has been claimed by
        // anyone -- and the reorder buffer's "block until my submission
        // drains" rule then waits forever on a submission nobody will ever
        // make. (An earlier version of this code did exactly that and hung.)
        // Claiming strictly in ascending order sidesteps this: the item at
        // `nextAcceptIndex` is always already claimed -- in flight or done --
        // by construction, so the buffer can never block on unclaimed work.
        // Demoting a shard is then just "stop claiming"; nothing to hand off.
        let claimCursor = 0;
        const claimNext = (): { readonly planIndex: number; readonly owner: WorkspaceScanSourceArtifact } | undefined => {
          if (claimCursor >= affectedOwners.length) return undefined;
          const planIndex = claimCursor;
          claimCursor += 1;
          return { planIndex, owner: affectedOwners[planIndex]! };
        };
        const demotedShards = new Set<number>();
        const rssBudgetKib = analysisLargeShardRssBudgetKib();
        let activeShardCount = shardCount;
        let demotions = 0;
        const completedByShard = new Array<number>(shardCount).fill(0);
        let globalCompleted = 0;
        // Demotes `victim`: it stops claiming new owners (checked at the top
        // of its own loop, below) but any already-claimed/in-flight item is
        // left to finish and be consumed normally -- never killed. Shard 0 is
        // never a demotion victim (`activeShardCount - 1 >= 1` whenever this
        // is called), so claiming always continues to completion.
        const demote = (victim: number, rssKib: number): void => {
          if (demotedShards.has(victim)) return;
          activeShardCount -= 1;
          demotedShards.add(victim);
          demotions += 1;
          console.error(`[urdira] analysis shard demotion workspace=${workspace_id} shards=${activeShardCount} rss_kib=${rssKib} budget_kib=${rssBudgetKib}`);
        };
        // Pre-spawn budget gate: check RSS before admitting each extra shard
        // beyond the mandatory first one. A shard rejected here never claims
        // anything and its `runLane` below returns before acquiring a worker.
        for (let candidateShard = 1; candidateShard < shardCount; candidateShard += 1) {
          const resourceTelemetry = analysisWorkerPool === undefined
            ? await processTreeRss?.sampleTelemetry({ fresh: true })
            : await analysisWorkerPool.sampleResourceTelemetry({ fresh: true });
          const rssKib = Math.round((resourceTelemetry?.process_tree_rss_bytes ?? process.memoryUsage().rss) / 1024);
          if (rssKib > rssBudgetKib) demote(candidateShard, rssKib);
        }
        // Reorder buffer: shards complete out of plan_index order, but
        // `acceptance.accept`/the accumulator/stream staging (fed
        // inside `consumePlanResponse`) must see deltas in the same
        // plan_index order a single-shard scan would produce. Each shard
        // blocks on `acceptInOrder` until ITS OWN submitted index has
        // actually drained before claiming its next plan -- so only shards
        // strictly ahead of `nextAcceptIndex` can be holding a
        // completed-but-unaccepted response at any moment, bounding this
        // buffer to at most `activeShardCount - 1` entries (see the claim-
        // cursor comment above for why this can never deadlock).
        const pendingResponses = new Map<number, { readonly response: FactDeltaStream; readonly plan: AnalysisPlan }>();
        const acceptWaiters = new Map<number, () => void>();
        let nextAcceptIndex = 0;
        let draining = false;
        let drainError: unknown;
        const tryDrain = (): void => {
          if (draining || drainError !== undefined) return;
          draining = true;
          void (async () => {
            try {
              while (pendingResponses.has(nextAcceptIndex)) {
                const { response, plan } = pendingResponses.get(nextAcceptIndex)!;
                pendingResponses.delete(nextAcceptIndex);
                const delta = await consumePlanResponse(response, plan);
                if (on_accepted_delta === undefined) accepted.push(delta);
                const resolve = acceptWaiters.get(nextAcceptIndex);
                acceptWaiters.delete(nextAcceptIndex);
                nextAcceptIndex += 1;
                resolve?.();
              }
            } catch (error) {
              drainError = error;
              for (const resolve of acceptWaiters.values()) resolve();
              acceptWaiters.clear();
            } finally {
              draining = false;
            }
          })();
        };
        const acceptInOrder = (planIndex: number, response: FactDeltaStream, plan: AnalysisPlan): Promise<void> => {
          if (drainError !== undefined) return Promise.reject(drainError as Error);
          pendingResponses.set(planIndex, { response, plan });
          const wait = new Promise<void>((resolve) => { acceptWaiters.set(planIndex, resolve); });
          tryDrain();
          return wait.then(() => { if (drainError !== undefined) throw drainError as Error; });
        };
        const runLane = async (shardIndex: number): Promise<void> => {
          if (demotedShards.has(shardIndex)) return; // demoted before a worker was ever spawned
          const shardKey = `${workspace_id}:shard:${shardIndex}`;
          const ownsClosureWorker = shardIndex === 0;
          let shardWorker: import("@urdira/plugin-sdk").WorkerTransport;
          if (ownsClosureWorker) shardWorker = semanticWorker();
          else {
            try { shardWorker = await acquirePooledWorker(shardKey); }
            catch (error) {
              if (processTreeRss === undefined || !(error instanceof Error) || !error.message.includes("RSS admission")) throw error;
              const telemetry = await processTreeRss.sampleTelemetry({ fresh: true });
              demote(shardIndex, Math.round((telemetry?.process_tree_rss_bytes ?? process.memoryUsage().rss) / 1024));
              return;
            }
          }
          try {
            for (;;) {
              if (demotedShards.has(shardIndex)) break; // demoted mid-scan: finish nothing new
              const entry = claimNext();
              if (entry === undefined) break;
              const plan = buildPlan(entry.owner, entry.planIndex);
              const response = await invokeDirectStream(shardWorker, plan);
              await acceptInOrder(entry.planIndex, response, plan);
              completedByShard[shardIndex] = (completedByShard[shardIndex] ?? 0) + 1;
              globalCompleted += 1;
              if (globalCompleted % 100 === 0 || globalCompleted === affectedOwners.length) console.error(`[urdira] analyze shard progress workspace=${workspace_id} stage=${publication_stage_id ?? "full"} shard=${shardIndex} completed=${globalCompleted}/${affectedOwners.length}`);
              if (globalCompleted % 64 === 0 && activeShardCount > 1) {
                const resourceTelemetry = analysisWorkerPool === undefined
                  ? await processTreeRss?.sampleTelemetry({ fresh: true })
                  : await analysisWorkerPool.enforceResourceCeiling();
                const rssKib = Math.round((resourceTelemetry?.process_tree_rss_bytes ?? process.memoryUsage().rss) / 1024);
                if (rssKib > rssBudgetKib) demote(activeShardCount - 1, rssKib);
              }
            }
          } finally {
            if (ownsClosureWorker) {
              if (analysisWorkerPool !== undefined) analysisWorkerPool.release(closureWorkerKey);
              else await shardWorker.terminate();
              closureWorkerRetained = false;
            } else if (analysisWorkerPool !== undefined) analysisWorkerPool.release(shardKey);
            else await shardWorker.terminate();
          }
        };
        await Promise.all(Array.from({ length: shardCount }, (_, shardIndex) => runLane(shardIndex)));
        largeStreamTelemetry = { shards_used: shardCount - demotedShards.size, demotions, per_shard_completed: completedByShard };
      }
      if ((plans === undefined ? affectedOwners.length : plans.length) === 0 && closureWorkerRetained) {
        if (analysisWorkerPool !== undefined) analysisWorkerPool.release(closureWorkerKey);
        else await semanticWorker().terminate();
        closureWorkerRetained = false;
      }
      // Keep the accepted deltas as the durable candidate input, but avoid a
      // second array allocation for the large-workspace summary path. The
      // deltas already retain the analyzer's structured facts and may occupy
      // gigabytes on a repository-sized first scan.
      for (const entry of shardResults) accepted.push(entry.delta);
      if (debugTimingEnabled()) {
        const groupedWallMs = performance.now() - workerStartedAt;
        console.error(`[urdira] analyze timings ${workspace_id} owners=${planCount} ms=${JSON.stringify({ closure: closureMs, worker_wait: Math.round(Math.max(0, groupedWallMs - acceptanceMs)), acceptance: Math.round(acceptanceMs), grouped_wall: Math.round(groupedWallMs), shards: shardCount, plan_mode: largeWorkspace ? "stream" : "materialized", ...(largeStreamTelemetry === undefined ? {} : largeStreamTelemetry) })}`);
      }
      // Summarize claims in place. `flatMap` here used to briefly duplicate
      // every completeness claim while the accepted deltas were still live,
      // which was enough to push large TypeScript workspaces over V8's heap
      // limit. The sets preserve the previous deterministic result without a
      // project-sized intermediate array.
      const reasonCodeSet = new Set<string>();
      const affectedArtifactIdSet = new Set<string>();
      const incompleteCapabilities = new Set<string>();
      for (const delta of accepted) {
        for (const claim of delta.delta.completeness_claims) {
          for (const reasonCode of JSON.parse(claim.reason_codes) as string[]) reasonCodeSet.add(reasonCode);
          for (const artifactId of JSON.parse(claim.affected_artifact_ids) as string[]) affectedArtifactIdSet.add(artifactId);
          if (claim.status !== "complete") incompleteCapabilities.add(claim.capability);
        }
      }
      const reasonCodes = [...reasonCodeSet].sort();
      const affectedArtifactIds = [...affectedArtifactIdSet].sort();
      const capability_state_entries: SnapshotCapabilityStateEntry[] = completedCapabilities.map((capability) => ({
        capability,
        capability_contract_version: "1.0.0",
        provider_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
        provider_version: JAVASCRIPT_TYPESCRIPT_VERSION,
        status: stage === undefined || stage.ordinal < 3 || !stageCapabilities.includes(capability) || !incompleteCapabilities.has(capability) ? "complete" : "partial",
        reason_codes: reasonCodes,
        affected_artifact_ids: affectedArtifactIds,
        diagnostic_record_ids: [],
        ...(stage === undefined ? {} : { publication_stage_id: stage.stage_id, publication_stage_ordinal: stage.ordinal, publication_stage_count: stage.stage_count }),
      }));
      return {
        accepted_deltas: accepted,
        capability_state_entries,
        native_batches: [],
      };
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
function createResolveJavascriptTypescriptPluginProvider(analysisCacheDir?: string, analysisWorkerPool?: AnalysisWorkerPool<JavascriptTypescriptWorkerDescriptor>, analysisWorkerShardCount = 2, rustSyntaxSessions?: Map<string, RustSyntaxSession>, nativeRuntime?: PreparedNativeRuntime, processTreeRss?: WholeProcessTreeRssController, indexingCoreSessions?: Map<string, IndexingCoreProcessTransport>, indexingCoreWorkerPath?: string): NonNullable<DaemonRuntimeOptions["resolve_plugin_provider"]> {
  // The TypeScript acceptance/materialization path is retained only as a
  // differential oracle for tests.  A missing composition worker must never
  // silently turn a normal daemon (including development/packaged launches
  // where NODE_ENV is unset) back into the duplicate owner loop that the Rust
  // cutover removes.  The explicit switch is intentionally private and is
  // never threaded by the shipped CLI/runtime bootstrap.
  const oracleRoute = process.env["URDIRA_INDEXING_CORE_ORACLE"] === "1"
    || process.env["NODE_ENV"] === "test";
  const prepared = new Map<string, Promise<{ readonly registry: PreparedJavascriptTypescriptRegistry; readonly now: string }>>();
  return async (workspace, database) => {
    if (!(workspace.selected_plugin_ids ?? []).includes(JAVASCRIPT_TYPESCRIPT_PLUGIN_ID)) return undefined;
    let entry = prepared.get(workspace.workspace_id);
    if (entry === undefined) {
      const now = new Date().toISOString();
      entry = prepareJavascriptTypescriptRegistry(workspace.workspace_id, now, database, nativeRuntime).then((registry) => ({ registry, now }));
      prepared.set(workspace.workspace_id, entry);
    }
    const { registry, now } = await entry;
    const registrySnapshotId = registry.registry.registry_snapshot_id;
    const configurationRevisionId = `configuration:${workspace.workspace_id}:${registry.lock.resolution_lock_id}`;
    let indexingCore = indexingCoreSessions?.get(workspace.workspace_id);
    const indexingCorePath = indexingCoreWorkerPath;
    if (indexingCore === undefined && indexingCoreSessions !== undefined && indexingCorePath !== undefined) {
      indexingCore = createIndexingCoreProcessTransport({ command: indexingCorePath, request_timeout_ms: indexingCoreRequestTimeoutMs() });
      indexingCoreSessions.set(workspace.workspace_id, indexingCore);
    }
    // The composition worker is the sole production boundary for structural
    // indexing. Keep this invariant at provider resolution as well as daemon
    // startup: a long-lived daemon can retain a Rust-syntax session from an
    // older configuration, and that session must never silently revive the
    // TypeScript acceptance/writer route when the composition worker is
    // absent. Development and test callers may still opt into the oracle by
    // running outside production.
    if (!oracleRoute && indexingCore === undefined) {
      throw new Error("Production structural indexing requires urdira-indexing-worker; the TypeScript structural writer is not a production fallback.");
    }
    // The Rust composition worker owns validation/receipts/staging whenever
    // it is available. Instantiate the TypeScript acceptance service only
    // for the explicit development/oracle route, so production cannot
    // accidentally perform the same SQLite ingestion twice.
    const streamAcceptance = indexingCore === undefined ? new FactDeltaStreamAcceptanceService(database.candidates) : undefined;
    let rustSyntax = indexingCore === undefined ? rustSyntaxSessions?.get(workspace.workspace_id) : undefined;
    if (indexingCore !== undefined) {
      const redundantSyntax = rustSyntaxSessions?.get(workspace.workspace_id);
      if (redundantSyntax !== undefined) {
        rustSyntaxSessions?.delete(workspace.workspace_id);
        await redundantSyntax.transport.terminate();
      }
    }
    const runtimeBindingDigest = registry.plugin.runtime_executable_binding?.binding_digest;
    if (nativeRuntime !== undefined && runtimeBindingDigest === undefined) throw new Error("The required JavaScript/TypeScript native runtime has no executable binding.");
    if (rustSyntax !== undefined && rustSyntax.runtime_executable_binding_digest !== runtimeBindingDigest) {
      rustSyntaxSessions?.delete(workspace.workspace_id);
      await rustSyntax.transport.terminate();
      rustSyntax = undefined;
    }
    // Once the composition worker is part of a production daemon, the old
    // Rust-syntax/TypeScript-writer route is test-only. Keeping it available
    // in production would reintroduce the exact duplicate coordination that
    // the cutover removes and would make performance depend on an accidental
    // worker-path omission. Development and test harnesses may still exercise
    // the compatibility oracle, but production startup fails closed instead.
    if (rustSyntax === undefined && indexingCore === undefined && rustSyntaxSessions !== undefined && nativeRuntime !== undefined && runtimeBindingDigest !== undefined) {
      const workerBytes = new Uint8Array(await readFile(nativeRuntime.closure.worker_path));
      if (sha256Bytes(workerBytes) !== nativeRuntime.closure.worker_digest) throw new Error("The verified Urdira Rust syntax worker changed before launch.");
      const transport = createJavascriptTypescriptProcessTransport({ command: nativeRuntime.closure.worker_path, expected_build_identity: JSTS_RUST_SYNTAX_BUILD_IDENTITY });
      const unregister = processTreeRss?.registerComponent({ component_id: `rust-syntax:${transport.process_id}`, kind: "rust_syntax_worker", pid: transport.process_id });
      rustSyntax = {
        transport: unregister === undefined ? transport : {
          ...transport,
          async terminate(): Promise<void> {
            try { await transport.terminate(); }
            finally { unregister(); }
          },
        },
        runtime_executable_binding_digest: runtimeBindingDigest,
      };
      rustSyntaxSessions.set(workspace.workspace_id, rustSyntax);
    }
    return buildJavascriptTypescriptPluginProvider(registry, workspace.workspace_id, registrySnapshotId, configurationRevisionId, now, database.casRoot, analysisCacheDir, analysisWorkerPool, analysisWorkerShardCount, streamAcceptance, rustSyntax, processTreeRss, nativeRuntime?.closure.addon_path, indexingCore, database.database.filename);
  };
}

function positiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

// The composition worker owns the complete cold/incremental generation. Its
// transport deadline must be at least as long as the generation deadline
// carried in the Rust request; otherwise a large real workspace is killed by
// the Node pipe while Rust is still making progress. The operation itself
// remains bounded by `deadline_ms` (see `indexingCoreDeadlineMs` below), so
// this is not an unbounded retry or a readiness relaxation.
//
// T3 (docs/evidence/2026-09-02-file-creation-diagnosis.md, "el timeout"): the
// wire protocol between this process and the Rust indexing-core worker is
// strictly request/response -- a `progress`-kind event IS the terminal
// response to `index_generation`/`accept_group` (see
// `IndexingCommand::AcceptGroup`'s handling in
// `crates/urdira-indexing-worker/src/main.rs`), never a mid-flight "still
// working" notification a still-pending call's own timer could reset
// against. Building a real intra-request heartbeat channel would need wire
// protocol surgery (a non-terminal frame kind Rust interleaves into a
// long-running command, plus a Node-side decoder change to reset rather than
// resolve on it) that is out of scope here. T1 already removes the actual
// O(corpus) syntax-analysis cost that made a single file create/delete's
// `index_generation` request exceed the OLD fixed 600_000ms ceiling; this
// higher, configurable ceiling is the safety net for whatever legitimately
// large full build still takes the conservative fallback path (a
// `compiler_options`/config change, or any case the incremental root
// add/remove path could not certify).
const INDEXING_CORE_DEFAULT_TIMEOUT_MS = 600_000;
/** Generous explicit upper bound on `URDIRA_INDEXING_CORE_TIMEOUT_MS` --
 * still finite (an operator who needs longer should raise this constant
 * deliberately, not discover an unbounded hang), but six times the previous
 * hardcoded ceiling. */
const INDEXING_CORE_MAX_TIMEOUT_MS = 3_600_000;
/** Kept strictly below the transport's own request timer so a graceful
 * Rust-side `"indexing operation deadline exceeded"` error always wins over
 * Node abruptly killing the child process pipe. */
const INDEXING_CORE_DEADLINE_GRACE_MS = 30_000;

function indexingCoreRequestTimeoutMs(): number {
  return Math.min(INDEXING_CORE_MAX_TIMEOUT_MS, positiveIntegerEnv("URDIRA_INDEXING_CORE_TIMEOUT_MS") ?? INDEXING_CORE_DEFAULT_TIMEOUT_MS);
}

/** Absolute epoch-ms deadline for one Rust generation request --
 * `urdira-indexing-core`'s own `check_cancelled`/`wait_out_scan_priority`
 * checkpoints enforce this and fail with a graceful "deadline exceeded"
 * error instead of running forever. Always `indexingCoreRequestTimeoutMs()`
 * minus `INDEXING_CORE_DEADLINE_GRACE_MS`, so raising
 * `URDIRA_INDEXING_CORE_TIMEOUT_MS` actually extends how long Rust itself is
 * willing to keep working, not just how long Node is willing to wait for a
 * response Rust would have abandoned long before. */
function indexingCoreDeadlineMs(): number {
  return Date.now() + Math.max(1_000, indexingCoreRequestTimeoutMs() - INDEXING_CORE_DEADLINE_GRACE_MS);
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
// (`lexical_documents`/`lexical_fts`) now runs as an async, post-ready
// maintenance job (`reconcileLexicalProjection`, `@urdira/engine`'s
// `lexical-reconciler.ts`, submitted by `packages/daemon/src/runtime.ts`'s
// `submitLexicalMaintenance` after every successful scan) rather than
// inline during the scan itself -- it reads source text from CAS, never the
// filesystem, and its own try/catch means a failure can never turn a
// successful scan into a failed one. `core:search_text` prefers this
// FTS5-backed pushdown once it catches up (real file-text search), and
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
// doc comment (`packages/daemon/src/runtime.ts`) -- paired with
// `semanticThreadEnabled()` below for the same reason: the lexical maintenance job (when
// `lexicalIndexEnabled()` above is also on) runs its per-document FTS5
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

// Index pack import (docs/decisions/23-index-pack.md): default ON, same kill-switch
// convention as `workspaceForkEnabled` above. Even ON, nothing happens unless
// `core:workspace_add` actually registered a pack path for a workspace (see
// `DaemonRuntimeOptions.index_pack`'s doc comment, `packages/daemon/src/runtime.ts`).
function indexPackEnabled(): boolean {
  const raw = process.env["URDIRA_INDEX_PACK"];
  if (raw === undefined || raw === "") return true;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

// Mirrors `workspaceForkVerifyMode` for `DaemonRuntimeOptions.index_pack_verify`.
function indexPackVerifyMode(): "fast" | "full" | undefined {
  const raw = process.env["URDIRA_INDEX_PACK_VERIFY"];
  return raw?.toLowerCase() === "full" ? "full" : undefined;
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

/** Extra analysis worker shards for the LARGE-workspace bounded-syntax
 * stream (`URDIRA_ANALYSIS_LARGE_SHARDS`), clamped to [1, 4]. Default 1 --
 * today's single-worker large-workspace behavior, unchanged unless a caller
 * opts in. See the `effectiveLargeShardCount` comment in `analyze` for why
 * more than one shard is memory-safe here despite the checker-duplication
 * cap `largeWorkspace` otherwise enforces. */
function analysisLargeWorkspaceShardCount(): number {
  return Math.max(1, Math.min(4, positiveIntegerEnv("URDIRA_ANALYSIS_LARGE_SHARDS") ?? 1));
}

/** RSS budget (KiB) for admitting/keeping extra large-workspace analysis
 * shards (`URDIRA_ANALYSIS_RSS_BUDGET_KIB`). Default 4,300,000 KiB (~700MiB
 * margin under the whole-campaign 5,000,000 KiB RSS guard -- past large-repo
 * runs finished with only ~634-740MiB margin to spare, see
 * `project_urdira_agent_benchmark_2026-08-14` in the session memory).
 * Crossing it demotes shards toward 1 rather than throwing. */
function analysisLargeShardRssBudgetKib(): number {
  return positiveIntegerEnv("URDIRA_ANALYSIS_RSS_BUDGET_KIB") ?? 4_300_000;
}

/** Conservative fixed cost reserved before each TypeScript checker process
 * is admitted. Source bytes are charged separately at two times their
 * encoded size by the caller. */
function analysisWorkerBaseReservationKib(): number {
  return positiveIntegerEnv("URDIRA_ANALYSIS_WORKER_RESERVATION_KIB") ?? 262_144;
}

/** Test-only seam: lets a small fixture workspace exercise the large-
 * workspace (bounded-syntax, streamed) analysis path without a 4096-file
 * fixture. `URDIRA_LARGE_WORKSPACE_ARTIFACT_THRESHOLD`, default 4096 --
 * today's hardcoded threshold. */
function largeWorkspaceArtifactThreshold(): number {
  return positiveIntegerEnv("URDIRA_LARGE_WORKSPACE_ARTIFACT_THRESHOLD") ?? 4_096;
}

/** Idle time after a scan releases a pooled worker before it is proactively
 * evicted. Default 300000ms (5 minutes). */
function analysisPoolIdleTtlMs(): number {
  return positiveIntegerEnv("URDIRA_ANALYSIS_POOL_TTL_MS") ?? 300_000;
}

export async function defaultDaemonOptions(dataRoot = process.env["URDIRA_DATA_ROOT"] ?? join(homedir(), ".urdira")): Promise<DaemonRuntimeOptions> {
  const nativeRequired = process.env["URDIRA_NATIVE_REQUIRED"] === "1";
  // Resolve and checksum the addon plus syntax worker as one immutable target
  // closure. The exact bytes feed the plugin package/analysis/binding digests,
  // while the same verified paths are the only artifacts executed below.
  // Production never silently downgrades when this closure is required.
  let nativeRuntime: PreparedNativeRuntime | undefined;
  if (nativeRequired) {
    const closure = resolveNativeClosure();
    const [addonBytes, workerBytes] = await Promise.all([readFile(closure.addon_path), readFile(closure.worker_path)]);
    if (sha256Bytes(addonBytes) !== closure.addon_digest || sha256Bytes(workerBytes) !== closure.worker_digest) throw new Error("The Urdira native closure changed after verification.");
    nativeRuntime = { closure, addon_bytes: new Uint8Array(addonBytes), worker_bytes: new Uint8Array(workerBytes) };
  }
  // Engine receives only a pure synchronous port after target/API validation
  // succeeds; a selected binding is never downgraded to TypeScript on failure.
  const nativeBinding = nativeRuntime === undefined ? undefined : loadNativeBinding({ artifact_path: nativeRuntime.closure.addon_path });
  configureNativeLogicalDigestPort(nativeBinding === undefined ? undefined : createNativeLogicalDigestPort(nativeBinding));
  configureNativeExactVectorTopKPort(nativeBinding === undefined ? undefined : createNativeExactVectorTopKPort(nativeBinding));
  configureStructuralKernelPort(nativeBinding === undefined ? undefined : createNativeStructuralKernelPort(nativeBinding));
  const scanBudgetMs = positiveIntegerEnv("URDIRA_SCAN_BUDGET_MS");
  const scanMaxResponseBytes = positiveIntegerEnv("URDIRA_SCAN_MAX_RESPONSE_BYTES");
  const scanBudget = scanBudgetMs === undefined && scanMaxResponseBytes === undefined ? undefined : {
    ...(scanBudgetMs === undefined ? {} : { max_duration_ms: scanBudgetMs }),
    ...(scanMaxResponseBytes === undefined ? {} : { max_response_bytes: scanMaxResponseBytes }),
  };
  const scanIoConcurrency = positiveIntegerEnv("URDIRA_SCAN_IO_CONCURRENCY");
  const casPutConcurrency = positiveIntegerEnv("URDIRA_CAS_PUT_CONCURRENCY");
  const lexicalIndex = lexicalIndexEnabled();
  const lexicalThread = lexicalThreadEnabled();
  const semanticThread = semanticThreadEnabled();
  const semanticProcess = semanticProcessEnabled();
  const workspaceFork = workspaceForkEnabled();
  const workspaceForkVerify = workspaceForkVerifyMode();
  const indexPack = indexPackEnabled();
  const indexPackVerify = indexPackVerifyMode();
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
  const processTreeRss = nativeRequired ? new WholeProcessTreeRssController({
    root_pid: process.pid,
    ceiling_rss_bytes: analysisLargeShardRssBudgetKib() * 1024,
    sampler: createHostProcessTableRssSampler(),
  }) : undefined;
  // One pool per daemon (mirrors `createResolveJavascriptTypescriptPluginProvider`'s
  // own single `prepared` cache below): keyed by workspace_id, so a workspace's
  // pooled worker survives across every scan of that workspace for this
  // daemon process's lifetime (subject to idle-TTL/LRU/descriptor-change
  // eviction -- see `AnalysisWorkerPool`'s doc comment). `undefined` when
  // `URDIRA_ANALYSIS_POOL=0` restores today's per-scan create/terminate.
  //
  // `max_active` must admit whichever scan needs the most concurrent
  // leases: the ordinary sharded path (`workerShards`) or a large-workspace
  // K-shard stream (`URDIRA_ANALYSIS_LARGE_SHARDS`, clamped to [1, 4] --
  // see `analysisLargeWorkspaceShardCount`). `acquire` throws once leases
  // hit this cap, so undersizing it here would turn a memory-safe extra
  // shard into a hard scan failure instead of the intended graceful
  // demotion path.
  const analysisWorkerPool = analysisPoolEnabled()
    ? new AnalysisWorkerPool<JavascriptTypescriptWorkerDescriptor>({
      create: (descriptor) => createProductionJavascriptTypescriptSemanticTransport(descriptor, processTreeRss, nativeRuntime?.closure.addon_path),
      max_entries: analysisPoolMaxEntries(),
      max_active: Math.max(workerShards, analysisLargeWorkspaceShardCount()),
      idle_ttl_ms: analysisPoolIdleTtlMs(),
      ...(processTreeRss === undefined ? {} : { resource_accounting: processTreeRss }),
    })
    : undefined;
  const rustSyntaxSessions = nativeRuntime === undefined ? undefined : new Map<string, RustSyntaxSession>();
  const packagedIndexingCorePath = nativeRuntime === undefined ? undefined : join(dirname(nativeRuntime.closure.worker_path), process.platform === "win32" ? "urdira-indexing-worker.exe" : "urdira-indexing-worker");
  const indexingCoreWorkerPath = process.env["URDIRA_INDEXING_CORE_WORKER_PATH"] ?? (packagedIndexingCorePath !== undefined && existsSync(packagedIndexingCorePath) ? packagedIndexingCorePath : undefined);
  // A verified production-native runtime must ship the composition worker. Do
  // not silently demote it to the legacy TypeScript writer: that would put the
  // dominant structural owner loop back on the application process and make a
  // release appear healthy while missing the Rust cutover. Development/test
  // runtimes may still exercise the compatibility oracle explicitly.
  const oracleRoute = process.env["URDIRA_INDEXING_CORE_ORACLE"] === "1"
    || process.env["NODE_ENV"] === "test";
  if (!oracleRoute && indexingCoreWorkerPath === undefined) {
    throw new Error("Production structural indexing requires urdira-indexing-worker; the TypeScript structural writer is not a production fallback.");
  }
  const indexingCoreSessions = indexingCoreWorkerPath === undefined ? undefined : new Map<string, IndexingCoreProcessTransport>();
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
    engine_build_id: URDIRA_ENGINE_BUILD_ID,
    workspace_registry: createPersistentWorkspaceRegistry(dataRoot),
    plugin_catalog: [{ ...bundledPluginCatalogEntry, capability_declarations: JAVASCRIPT_TYPESCRIPT_CAPABILITIES }],
    resolve_plugin_provider: createResolveJavascriptTypescriptPluginProvider(analysisCacheDir, analysisWorkerPool, workerShards, rustSyntaxSessions, nativeRuntime, processTreeRss, indexingCoreSessions, indexingCoreWorkerPath),
    // Generic source-only scans use the same persistent composition worker as
    // language-backed scans. This keeps the no-plugin path from reopening a
    // TypeScript SQLite writer and lets future language engines share the
    // source-catalog commit protocol unchanged.
    /* c8 ignore start -- exercised through daemon startup/runtime integration rather than the app unit harness. */
    resolve_source_indexing_core: async (workspace: { readonly workspace_id: string }) => {
      if (indexingCoreSessions === undefined || indexingCoreWorkerPath === undefined) return undefined;
      let core = indexingCoreSessions.get(workspace.workspace_id);
      if (core === undefined) {
        core = createIndexingCoreProcessTransport({ command: indexingCoreWorkerPath, request_timeout_ms: indexingCoreRequestTimeoutMs() });
        indexingCoreSessions.set(workspace.workspace_id, core);
      }
      return {
        // Source-only scans have no active structural operation to cancel;
        // cancellation is still observed by the outer scan before commit.
        cancel: async (): Promise<void> => undefined,
          commit_source_index: async (input: { readonly operation_id: string; readonly workspace_id: string; readonly database_path: string; readonly commits: readonly unknown[]; readonly finalize_state?: boolean }): Promise<void> => {
            const result = await core!.commitSourceIndex(input.operation_id, input.workspace_id, input.database_path, input.commits, input.finalize_state);
            if (result.kind !== "source_index_committed") throw new Error("Rust indexing-core did not commit the generic source index.");
          },
          rollback_source_index: async (input: { readonly operation_id: string; readonly workspace_id: string; readonly database_path: string }): Promise<void> => {
            const result = await core!.rollbackSourceIndex(input.operation_id, input.workspace_id, input.database_path);
            if (result.kind !== "source_index_rolled_back") throw new Error("Rust indexing-core did not roll back the generic source index.");
          },
      };
    },
    /* c8 ignore stop */
    // Wired straight through to `AnalysisWorkerPool.evict`/`closeAll` -- see
    // `analysis_worker_pool_evict`/`analysis_worker_pool_close_all`'s doc
    // comments (`packages/daemon/src/runtime.ts`) for why `@urdira/daemon`
    // itself only ever calls these plain closures, never touching a pool
    // instance directly. Both are `undefined` (byte-for-byte today's
    // behavior) when `URDIRA_ANALYSIS_POOL=0`.
    ...(analysisWorkerPool === undefined && rustSyntaxSessions === undefined && indexingCoreSessions === undefined ? {} : {
      analysis_worker_pool_evict: async (workspaceId: string) => {
        await analysisWorkerPool?.evictWorkspace(workspaceId);
        const rust = rustSyntaxSessions?.get(workspaceId);
        if (rust !== undefined) { rustSyntaxSessions!.delete(workspaceId); await rust.transport.terminate(); }
        const core = indexingCoreSessions?.get(workspaceId);
        if (core !== undefined) { indexingCoreSessions!.delete(workspaceId); await core.terminate(); }
      },
      analysis_worker_pool_close_all: async () => {
        await analysisWorkerPool?.closeAll();
        const sessions = [...(rustSyntaxSessions?.values() ?? [])];
        rustSyntaxSessions?.clear();
        await Promise.all(sessions.map((session) => session.transport.terminate()));
        const indexingCores = [...(indexingCoreSessions?.values() ?? [])];
        indexingCoreSessions?.clear();
        await Promise.all(indexingCores.map((session) => session.terminate()));
      },
    }),
    ...(scanBudget === undefined ? {} : { scan_budget: scanBudget }),
    ...(scanIoConcurrency === undefined ? {} : { scan_io_concurrency: scanIoConcurrency }),
    ...(casPutConcurrency === undefined ? {} : { cas_put_concurrency: casPutConcurrency }),
    // `lexicalIndexEnabled()` defaults to `true`, matching `DaemonRuntimeOptions.lexical_index`'s
    // own default -- only thread an explicit `false` through when the kill
    // switch fired, so an unset env var leaves this field omitted like every
    // other optional override here.
    ...(lexicalIndex ? {} : { lexical_index: false }),
    ...(indexingCoreWorkerPath === undefined ? {} : { lexical_owned_by_rust: true }),
    ...(lexicalThread ? {} : { lexical_thread: false }),
    ...(workspaceFork ? {} : { workspace_fork: false }),
    ...(workspaceForkVerify === undefined ? {} : { workspace_fork_verify: workspaceForkVerify }),
    ...(indexPack ? {} : { index_pack: false }),
    ...(indexPackVerify === undefined ? {} : { index_pack_verify: indexPackVerify }),
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

function compatibilityDetails(payload: unknown, requiredCapabilities: readonly string[]): { readonly interface_version?: number; readonly capabilities: readonly string[]; readonly missing: readonly string[] } {
  if (payload === null || typeof payload !== "object") return { capabilities: [], missing: requiredCapabilities };
  const record = payload as Record<string, unknown>;
  const capabilities = Array.isArray(record["rpc_capabilities"])
    ? record["rpc_capabilities"].filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    ...(typeof record["private_interface_version"] === "number" ? { interface_version: record["private_interface_version"] } : {}),
    capabilities,
    missing: requiredCapabilities.filter((capability) => !capabilities.includes(capability)),
  };
}

function daemonCompatibilityError(dataRoot: string, detectedBuild: string, requiredBuild: string, detectedInterface: number | undefined, missingCapabilities: readonly string[]): DaemonError {
  return new DaemonError(
    "core:daemon_restart_required",
    `The running daemon exposes private interface ${detectedInterface ?? "legacy"}; interface ${DAEMON_PRIVATE_INTERFACE_VERSION} is required. Restart Urdira before retrying.`,
    {
      data_root_id: dataRoot,
      detected_engine_build_id: detectedBuild,
      required_engine_build_id: requiredBuild,
      detected_private_interface_version: detectedInterface ?? "legacy",
      required_private_interface_version: DAEMON_PRIVATE_INTERFACE_VERSION,
      missing_rpc_capabilities: missingCapabilities,
      blocking_reason: "restart_lease_denied",
      safe_automatic_restart: false,
    },
  );
}

function requiredRpcCapabilities(command: CliCommand): readonly string[] {
  if (command.name === "workspace-add" && command.options.dry_run) return ["core:status", "core:workspace_preview"];
  const capabilityByCommand: Partial<Record<CliCommand["name"], string>> = {
    status: "core:status",
    query: "core:query",
    index: "core:index_status",
    start: "core:daemon_start",
    stop: "core:daemon_stop",
    restart: "core:daemon_restart",
    "workspace-list": "core:workspace_admin_list",
    "workspace-show": "core:workspace_admin_show",
    "workspace-add": "core:workspace_add",
    "workspace-remove": "core:workspace_remove",
    "workspace-purge": "core:workspace_purge",
    "workspace-configure": "core:workspace_configure",
    "codebase-list": "core:codebase_list",
    "codebase-create": "core:codebase_create",
    "codebase-rename": "core:codebase_rename",
    "codebase-assign": "core:codebase_assign",
    "codebase-unassign": "core:codebase_unassign",
    "codebase-remove": "core:codebase_remove",
    "config-set": "core:configuration_set",
    repair: "core:repair",
    gc: "core:garbage_collect",
    reindex: "core:reindex",
    "index-pack-export": "core:index_pack_export",
  };
  const capability = capabilityByCommand[command.name];
  return capability === undefined ? ["core:status"] : ["core:status", capability];
}

async function resolveDaemon(options?: DaemonRuntimeOptions, endpoint?: string, startIfMissing = true, onStartupProgress?: (phase: DaemonStartupPhase) => void, onProgress?: (progress: IpcProgress["progress"]) => void, allowIncompatibleLifecycleCall = false, requiredCapabilities: readonly string[] = ["core:status"]): Promise<{ readonly endpoint: string; readonly runtime?: DaemonRuntime } | undefined> {
  if (endpoint !== undefined) {
    if (!allowIncompatibleLifecycleCall) {
      const status = await new DaemonClient(endpoint, { request_timeout_ms: DAEMON_HEALTH_PROBE_TIMEOUT_MS }).call("core:status", {});
      const compatibility = compatibilityDetails(status.payload, requiredCapabilities);
      if (status.outcome !== "success" || compatibility.interface_version !== DAEMON_PRIVATE_INTERFACE_VERSION || compatibility.missing.length > 0) {
        throw daemonCompatibilityError("explicit-endpoint", "unknown", "explicit-endpoint", compatibility.interface_version, compatibility.missing);
      }
    }
    return { endpoint };
  }
  const dataRoot = options?.data_root ?? process.env["URDIRA_DATA_ROOT"] ?? join(homedir(), ".urdira");
  const requiredEngineBuildId = options?.engine_build_id ?? URDIRA_ENGINE_BUILD_ID;
  const paths = await daemonPaths(dataRoot);
  onProgress?.({ phase: "daemon_discovery", completed: 0, message: "checking for an existing per-user daemon" });
  const descriptor = await new EndpointDescriptorStore(paths).read();
  if (descriptor) {
    const owner = await ProcessLock.inspect(paths.process_lock);
    const matchingLiveOwner = owner?.alive === true && owner.pid === descriptor.pid;
    const descriptorCapabilities = descriptor.rpc_capabilities ?? [];
    const missingDescriptorCapabilities = requiredCapabilities.filter((capability) => !descriptorCapabilities.includes(capability));
    if (matchingLiveOwner && !allowIncompatibleLifecycleCall
      && (descriptor.private_interface_version !== DAEMON_PRIVATE_INTERFACE_VERSION || missingDescriptorCapabilities.length > 0)) {
      throw daemonCompatibilityError(dataRoot, descriptor.engine_build_id, requiredEngineBuildId, descriptor.private_interface_version, missingDescriptorCapabilities);
    }
    if (matchingLiveOwner && descriptor.engine_build_id !== requiredEngineBuildId) {
      if (allowIncompatibleLifecycleCall) {
        onProgress?.({ phase: "daemon_reuse", completed: 1, total: 1, message: `connecting to incompatible daemon process ${descriptor.pid} for explicit lifecycle control` });
        return { endpoint: descriptor.endpoint };
      }
      throw new DaemonError(
        "core:daemon_restart_required",
        `Daemon process ${descriptor.pid} uses engine build ${descriptor.engine_build_id}; ${requiredEngineBuildId} is required. Stop or restart Urdira before retrying.`,
        {
          data_root_id: dataRoot,
          detected_engine_build_id: descriptor.engine_build_id,
          required_engine_build_id: requiredEngineBuildId,
          blocking_reason: "restart_lease_denied",
          safe_automatic_restart: false,
        },
      );
    }
    onProgress?.({ phase: "daemon_probe", completed: 0, message: `checking daemon process ${descriptor.pid}` });
    let response: Awaited<ReturnType<DaemonClient["call"]>> | undefined;
    try {
      response = await new DaemonClient(descriptor.endpoint, { request_timeout_ms: DAEMON_HEALTH_PROBE_TIMEOUT_MS }).call("core:status", {});
    } catch {
      // A failed health probe does not prove that the descriptor is stale.
      // A live matching lock means another process still owns this endpoint;
      // reuse it and let the requested operation apply its own deadline.
    }
    if (response?.outcome === "success") {
      const reportedEngineBuildId = response.payload && typeof response.payload === "object" && "engine_build_id" in response.payload && typeof response.payload.engine_build_id === "string"
        ? response.payload.engine_build_id
        : descriptor.engine_build_id;
      if (reportedEngineBuildId !== requiredEngineBuildId) {
        throw new DaemonError("core:daemon_restart_required", `Daemon process ${descriptor.pid} reported engine build ${reportedEngineBuildId}; ${requiredEngineBuildId} is required.`, {
          data_root_id: dataRoot,
          detected_engine_build_id: reportedEngineBuildId,
          required_engine_build_id: requiredEngineBuildId,
          blocking_reason: "restart_lease_denied",
          safe_automatic_restart: false,
        });
      }
      const compatibility = compatibilityDetails(response.payload, requiredCapabilities);
      if (!allowIncompatibleLifecycleCall && (compatibility.interface_version !== DAEMON_PRIVATE_INTERFACE_VERSION || compatibility.missing.length > 0)) {
        throw daemonCompatibilityError(dataRoot, reportedEngineBuildId, requiredEngineBuildId, compatibility.interface_version, compatibility.missing);
      }
      onProgress?.({ phase: "daemon_reuse", completed: 1, total: 1, message: `reusing daemon process ${descriptor.pid}` });
      return { endpoint: descriptor.endpoint };
    }
    if (matchingLiveOwner) {
      onProgress?.({ phase: "daemon_reuse", completed: 1, total: 1, message: `daemon process ${descriptor.pid} is alive but busy; waiting for it` });
      return { endpoint: descriptor.endpoint };
    }
  }
  if (!startIfMissing) return undefined;
  onProgress?.({ phase: "daemon_start", completed: 0, message: "no reusable daemon found; starting one" });
  const daemonOptions = options ?? (await defaultDaemonOptions(dataRoot));
  const configuredProgress = daemonOptions.on_startup_progress;
  const runtime = await DaemonRuntime.start({
    ...daemonOptions,
    ...((configuredProgress === undefined && onStartupProgress === undefined) ? {} : {
      on_startup_progress: (phase) => {
        configuredProgress?.(phase);
        if (onStartupProgress !== configuredProgress) onStartupProgress?.(phase);
      },
    }),
  });
  return { endpoint: runtime.endpoint, runtime };
}

async function waitForDaemonShutdown(dataRoot: string, onProgress?: (progress: IpcProgress["progress"]) => void): Promise<void> {
  const paths = await daemonPaths(dataRoot);
  onProgress?.({ phase: "daemon_shutdown_wait", completed: 0, message: "waiting for the previous daemon to release its lock" });
  const deadline = Date.now() + DAEMON_SHUTDOWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const owner = await ProcessLock.inspect(paths.process_lock);
    if (owner?.alive !== true) {
      onProgress?.({ phase: "daemon_shutdown_wait", completed: 1, total: 1, message: "previous daemon stopped and released its lock" });
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  const descriptor = await new EndpointDescriptorStore(paths).read().catch(() => undefined);
  throw new DaemonError("core:daemon_restart_required", "The previous daemon did not release its lock before the shutdown deadline.", {
    data_root_id: dataRoot,
    detected_engine_build_id: descriptor?.engine_build_id ?? "unknown",
    required_engine_build_id: URDIRA_ENGINE_BUILD_ID,
    blocking_reason: "restart_lease_timeout",
    safe_automatic_restart: false,
  });
}

export async function runUrdira(argv: ReadonlyArray<string>, options: UrdiraRunOptions): Promise<CliResult> {
  // Parse before daemon resolution. Invalid commands must never start the
  // expensive composed runtime merely to discover a local CLI error, and a
  // stop request must not create the daemon it intends to stop.
  const command = parseCliArgs(argv);
  const adminRequestTimeoutMs = options.admin_request_timeout_ms ?? CLI_ADMIN_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(adminRequestTimeoutMs) || adminRequestTimeoutMs < 1 || adminRequestTimeoutMs > 24 * 60 * 60 * 1_000) {
    throw new TypeError("admin_request_timeout_ms must be a positive integer no greater than 24 hours.");
  }
  if (command.options.debug_timing) {
    process.env["URDIRA_DEBUG_TIMING"] = "1";
    process.env["URDIRA_STORAGE_DEBUG_TIMING"] = "1";
  }
  const previewOnlyLifecycle = (command.name === "start" || command.name === "stop") && command.options.dry_run;
  const explicitLifecycleControl = command.name === "stop" || command.name === "restart";
  const daemon = command.name === "stop" || command.name === "restart" || previewOnlyLifecycle
    ? await resolveDaemon(options.daemon, options.endpoint, false, options.on_startup_progress, options.on_progress, explicitLifecycleControl, requiredRpcCapabilities(command))
    : await resolveDaemon(options.daemon, options.endpoint, true, options.on_startup_progress, options.on_progress, explicitLifecycleControl, requiredRpcCapabilities(command));
  const prompt = options.prompt ?? (process.stdin.isTTY && process.stdout.isTTY ? async (question: string) => {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try { return await readline.question(`${question} `); } finally { readline.close(); }
  } : undefined);
  const rawClient = daemon === undefined ? undefined : new DaemonClient(daemon.endpoint);
  const client = rawClient === undefined
    ? { call: async () => ({ outcome: "success" as const, payload: { state: "already_stopped" } }) }
    : { call: async (call: string, payload: unknown) => {
      if (call === "core:workspace_preview") options.on_progress?.({ phase: "workspace_preview", completed: 0, message: "inspecting workspace technologies and compatible plugins" });
      if (call === "core:workspace_add") options.on_progress?.({ phase: "workspace_registration", completed: 0, message: "registering the workspace and starting observation" });
      if (call === "core:daemon_stop") options.on_progress?.({ phase: "daemon_stop", completed: 0, message: "requesting graceful daemon shutdown" });
      if (call === "core:daemon_restart") options.on_progress?.({ phase: "daemon_restart", completed: 0, message: "requesting graceful daemon replacement" });
      const longRunning = call === "core:workspace_preview" || call === "core:workspace_add" || call === "core:workspace_configure" || call === "core:configuration_set" || call === "core:reindex" || call === "core:daemon_stop" || call === "core:daemon_restart";
      return rawClient.call(call, payload, {
        ...(longRunning ? { deadline_at: new Date(Date.now() + adminRequestTimeoutMs).toISOString() } : {}),
        ...(options.on_progress === undefined ? {} : { on_progress: options.on_progress }),
      });
    } };
  try {
    const result = await runCli(argv, {
      client,
      preview_admin: async (command) => {
        if (command.name !== "workspace-add") return { command: command.name, args: command.args, values: command.options.values };
        const response = await client.call("core:workspace_preview", { args: command.args, values: command.options.values });
        if (response.outcome === "error" && response.error !== undefined) {
          throw new DaemonError(response.error.code as DaemonErrorCode, response.error.message, response.error.details ?? {});
        }
        if (response.outcome !== "success") {
          throw new DaemonError("core:operation_cancelled", "Workspace preview was cancelled before a proposal was returned.");
        }
        if (!Object.hasOwn(response, "payload")) {
          throw new DaemonError("core:ipc_frame_invalid", "Workspace preview succeeded without a response payload.");
        }
        return response.payload;
      },
      ...(options.execute_admin === undefined ? {} : { execute_admin: options.execute_admin }),
      ...(prompt === undefined ? {} : { prompt }),
      read_stdin: async () => { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks).toString("utf8"); },
    });
    if ((command.name === "stop" || command.name === "restart") && rawClient !== undefined && options.endpoint === undefined) {
      const dataRoot = options.daemon?.data_root ?? process.env["URDIRA_DATA_ROOT"] ?? join(homedir(), ".urdira");
      await waitForDaemonShutdown(dataRoot, options.on_progress);
    }
    return result;
  }
  finally {
    // `daemon start` deliberately transfers ownership to the long-lived
    // process. Every other one-shot CLI call keeps the previous scoped
    // behavior and tears down a runtime it created only for that request.
    if (daemon?.runtime && command.name !== "start") await daemon.runtime.stop({ force: false });
  }
}

export async function runUrdiraMcp(options: UrdiraMcpRunOptions): Promise<{ readonly close: () => Promise<void> }> {
  const daemon = await resolveDaemon(options.daemon, options.endpoint, true, undefined, undefined, false, ["core:status", "core:index_status", "core:query", "core:query_continue"]);
  if (daemon === undefined) throw new Error("MCP daemon resolution unexpectedly returned no endpoint.");
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

export interface UrdiraWebRunOptions {
  readonly endpoint?: string;
  readonly daemon?: DaemonRuntimeOptions;
  readonly port?: number;
}

/** Owns the loopback web listener and, when needed, the private daemon it started. */
export async function runUrdiraWeb(options: UrdiraWebRunOptions = {}): Promise<UrdiraWebHandle> {
  const daemon = await resolveDaemon(options.daemon, options.endpoint, true, undefined, undefined, false, ["core:status", "core:index_status", "core:query", "core:query_continue", "core:workspace_admin_list", "core:codebase_list"]);
  if (daemon === undefined) throw new Error("Web daemon resolution unexpectedly returned no endpoint.");
  try {
    const client = new DaemonClient(daemon.endpoint);
    const handle = await startUrdiraWeb({
      client,
      run_cli: (argv: readonly string[], onProgress?: (progress: unknown) => void) => runUrdira(argv, { endpoint: daemon.endpoint, ...(onProgress === undefined ? {} : { on_progress: onProgress as (progress: IpcProgress["progress"]) => void }) }),
      ...(options.port === undefined ? {} : { port: options.port }),
    });
    return {
      ...handle,
      close: async () => { await handle.close(); if (daemon.runtime) await daemon.runtime.stop({ force: false }); },
    };
  } catch (error) {
    if (daemon.runtime) await daemon.runtime.stop({ force: true });
    throw error;
  }
}
