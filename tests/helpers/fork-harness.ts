import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArtifactWorkItem, ReplacementScope, SnapshotCapabilityStateEntry } from "@urdira/contracts";
import {
  PluginPackageDiscovery,
  PluginRegistryAssembler,
  PluginResolver,
  canonicalSha256,
  parseVersionRequirementText,
  pluginInputAccessManifestDigest,
  pluginInputAccessManifestId,
  type AssembledPluginRegistry,
  type AutomaticPluginInputAccessManifest,
  type DiscoveredPluginPackage,
  type SdkPluginResolutionLock,
} from "@urdira/plugin-sdk";
// `@urdira/engine` and `@urdira/plugin-javascript-typescript` are not
// root-level devDependencies, so (matching every tests/*.test.ts file that
// touches them) this module imports them from `src` by relative path.
import {
  attemptWorkspaceFork,
  candidateTargetRegistryFromSnapshot,
  createCanonicalPluginDigestAuthority,
  FactDeltaAcceptanceService,
  runFullWorkspaceScan,
  WorkspaceRegistry,
  type AcceptedFactDelta,
  type RegisteredWorkspace,
  type WorkspaceScanPluginProvider,
} from "../../packages/engine/src/index.js";
import {
  JAVASCRIPT_TYPESCRIPT_CAPABILITIES,
  JAVASCRIPT_TYPESCRIPT_DEPENDENCY_ROLES,
  JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
  JAVASCRIPT_TYPESCRIPT_RECORD_KINDS,
  JAVASCRIPT_TYPESCRIPT_VERSION,
  createJavascriptTypescriptInstalledBundle,
  createJavascriptTypescriptWorker,
  languageForPath,
} from "../../packages/plugin-javascript-typescript/src/index.js";
import type { DurableStorage, WorkspaceDatabase } from "../../packages/storage/src/index.js";

/**
 * Shared engine-level test harness (plugin-registry preparation, the JS/TS
 * plugin provider stand-in, engine-level workspace registration) used by
 * both `tests/phase-workspace-fork.test.ts` and
 * `tests/phase-index-pack.test.ts`, extracted here rather than one importing
 * the other's `.test.ts` module -- importing a vitest test file for its
 * helper functions would also re-execute every `describe`/`it` it declares
 * as a side effect of module evaluation. This module declares no tests
 * itself. `tests/phase-workspace-fork.test.ts` keeps its own local copies
 * unchanged (this module was added alongside it, not extracted from it, to
 * avoid touching that file's already-passing test suite at all).
 */

const here = dirname(fileURLToPath(import.meta.url));
export const fixtureRoot = resolve(here, "..", "fixtures", "codebases", "typescript", "task-planner", "src", "domain");
export const now = "2026-08-12T12:00:00.000Z";

export interface PreparedRegistry {
  readonly registry: AssembledPluginRegistry;
  readonly lock: SdkPluginResolutionLock;
  readonly plugin: DiscoveredPluginPackage;
}

export async function prepareRegistry(workspaceId: string): Promise<PreparedRegistry> {
  const digests = createCanonicalPluginDigestAuthority();
  const encoder = new TextEncoder();
  const assets = [
    { normalized_relative_path: "dist/worker.mjs", bytes: encoder.encode("urdira harness jsts worker"), executable: true, role: "parser" as const },
    { normalized_relative_path: "node_modules/typescript/package.json", bytes: encoder.encode('{"name":"typescript","version":"7.0.2"}'), executable: false, role: "dependency" as const },
  ];
  const bundle = createJavascriptTypescriptInstalledBundle({ digests, package_locator: "bundled:jsts", target_triple: "test-node", assets });
  const bytesByPath = new Map(assets.map((asset) => [asset.normalized_relative_path, asset.bytes]));
  const discovery = await new PluginPackageDiscovery({
    list: async () => [bundle],
    read_file: async (request) => {
      const bytes = bytesByPath.get(request.normalized_relative_path);
      if (bytes === undefined) throw new Error("missing bundle asset");
      return { bytes, byte_length: bytes.byteLength };
    },
  }, digests, { max_file_bytes: 1_000_000 }, { max_items: 100, max_depth: 20, max_nodes: 10_000, max_bytes: 2_000_000 }).discover(["bundled"]);
  const resolved = new PluginResolver(digests).resolve({
    packages: discovery.packages,
    requirements: [{ plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, version_requirement: parseVersionRequirementText("*") }],
    pins: [],
    supported_runtime_contract_versions: [1],
    supported_registry_contract_versions: [1],
    workspace_id: workspaceId,
    resolver_version: "1.0.0",
    clock: () => now,
    id_source: () => `lock:${workspaceId}`,
  });
  if (!resolved.ok) throw new Error(`plugin resolution failed: ${JSON.stringify(resolved.issues)}`);
  const assembled = new PluginRegistryAssembler(digests).assemble({
    packages: resolved.packages,
    lock: resolved.lock,
    registry_snapshot_id: `registry:${workspaceId}`,
    core_registry_digest: canonicalSha256("core-registry"),
    emission_valid_from_generation: "1",
    clock: () => now,
    id_source: () => `registry-issue:${workspaceId}`,
  });
  if (!assembled.ok) throw new Error(`registry assembly failed: ${JSON.stringify(assembled.issues)}`);
  return { registry: assembled.registry as PreparedRegistry["registry"], lock: resolved.lock, plugin: resolved.packages[0]! };
}

export function accessManifest(workItemId: string, analysisContextDigest: string, artifacts: readonly { readonly artifact_id: string; readonly artifact_version_id: string; readonly content_hash: string }[]): AutomaticPluginInputAccessManifest {
  const core = {
    request_id: `request:${workItemId}`,
    analysis_view_digest: analysisContextDigest,
    artifact_version_entries: artifacts.map((artifact) => ({ artifact_id: artifact.artifact_id, artifact_version_id: artifact.artifact_version_id, content_hash: artifact.content_hash, access_modes: ["artifact_read" as const] })),
    record_entries: [], lookup_entries: [], transitive_artifact_version_ids: [],
  };
  return {
    plugin_input_access_manifest_id: pluginInputAccessManifestId(core.request_id, core.analysis_view_digest),
    ...core,
    manifest_digest: pluginInputAccessManifestDigest(core),
  };
}

/** Typed against `runFullWorkspaceScan`/`attemptWorkspaceFork`'s own (dist-resolved) `@urdira/storage` declarations -- see this module's header comment. `exportIndexPack`/`attemptIndexPackImport` resolve the identical `@urdira/storage` dist package, so their `database`/`storage` parameters accept these same bridged values too. */
export function asStorageDatabase(database: WorkspaceDatabase): Parameters<typeof runFullWorkspaceScan>[0]["database"] {
  return database as unknown as Parameters<typeof runFullWorkspaceScan>[0]["database"];
}
export function asDurableStorage(storage: DurableStorage): Parameters<typeof attemptWorkspaceFork>[0]["storage"] {
  return storage as unknown as Parameters<typeof attemptWorkspaceFork>[0]["storage"];
}

export function buildPluginProvider(prepared: PreparedRegistry, workspaceId: string, registrySnapshotId: string, configurationRevisionId: string, analyzedWorkspaceIds: Set<string>): WorkspaceScanPluginProvider {
  const encoder = new TextEncoder();
  const configuration: WorkspaceScanPluginProvider["configuration"] = {
    configuration_revision_id: configurationRevisionId,
    schema_version: 1,
    workspace_id: workspaceId,
    effective_configuration_schema_id: "core:bytes",
    effective_configuration_schema_version: 1,
    effective_configuration: encoder.encode("jsts"),
    installation_policy_digest: canonicalSha256("installation"),
    user_policy_digest: canonicalSha256("user"),
    workspace_file_digest: canonicalSha256("workspace"),
    administrative_override_digest: canonicalSha256("admin"),
    analysis_configuration_digest: prepared.plugin.analysis_configuration_digest,
    query_configuration_digest: canonicalSha256("query"),
    resolved_embedding_binding_digests: [],
    created_at: now,
    reason_code: "core:plugin_activated",
    revision_digest: canonicalSha256({ registrySnapshotId, plugin: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID }),
  };

  return {
    registry_snapshot_id: registrySnapshotId,
    configuration_revision_id: configurationRevisionId,
    registry: prepared.registry,
    resolution_lock: prepared.lock,
    configuration,
    dependency_roles: [...JAVASCRIPT_TYPESCRIPT_DEPENDENCY_ROLES],
    analyze: async ({ workspace_id, candidate, artifacts }) => {
      analyzedWorkspaceIds.add(workspace_id);
      const artifactVersions = artifacts.map((artifact) => ({ artifact_id: artifact.artifact_id, artifact_version_id: artifact.artifact_version_id, content_hash: artifact.content_hash }));
      const targetRegistry = candidateTargetRegistryFromSnapshot({ registry: prepared.registry, artifact_versions: artifactVersions });
      const acceptance = new FactDeltaAcceptanceService();
      const worker = createJavascriptTypescriptWorker({
        compatibility_declaration_digest: prepared.plugin.compatibility.declaration_digest,
        registry_contribution_digest: prepared.plugin.contribution.contribution_digest,
        analysis_digest: prepared.plugin.compatibility.analysis_digest,
        analysis_configuration_digest: prepared.plugin.analysis_configuration_digest,
      });
      const sourceArtifacts = artifacts.filter((artifact) => languageForPath(artifact.path) !== undefined);
      const accepted: AcceptedFactDelta[] = [];
      try {
        for (const owner of sourceArtifacts) {
          const workItemId = `work:${owner.artifact_id}`;
          const contextDigest = canonicalSha256({ registry: prepared.registry.registry_digest, owner: owner.artifact_version_id, inputs: artifactVersions });
          const scope: ReplacementScope = {
            replacement_scope_id: `scope:${owner.artifact_id}`, owner_artifact_id: owner.artifact_id, owner_artifact_version_id: owner.artifact_version_id,
            capability: "core:call_relationships", record_categories: ["diagnostic", "entity", "relation"], record_kinds: [...JAVASCRIPT_TYPESCRIPT_RECORD_KINDS],
            base_record_set_digest: canonicalSha256([]), output_completeness: "accept_reported",
          };
          const workItem = {
            work_item_id: workItemId, workspace_id, artifact_id: owner.artifact_id, target_artifact_version_id: owner.artifact_version_id,
            operation: "full", plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, plugin_version: JAVASCRIPT_TYPESCRIPT_VERSION,
            capabilities: JAVASCRIPT_TYPESCRIPT_CAPABILITIES.map((entry) => entry.capability), expected_replacement_scopes: [scope], reason_codes: ["core:artifact_changed"], cause_references: [],
            analysis_context_digest: contextDigest, work_item_digest: canonicalSha256({ workItemId, contextDigest }), candidate_generation_id: candidate.candidate_generation_id,
            ...(candidate.base_snapshot_id === undefined ? {} : { base_snapshot_id: candidate.base_snapshot_id }),
          } satisfies ArtifactWorkItem & { readonly candidate_generation_id: string; readonly base_snapshot_id?: string };
          const manifest = accessManifest(workItemId, contextDigest, artifacts);
          const analysisInputDigest = canonicalSha256({ owner: owner.path, inputs: manifest.artifact_version_entries });
          const response = await worker.invoke({
            protocol_version: "1.0.0", request_id: manifest.request_id, request_digest: analysisInputDigest, call: "analyze_artifact", deadline: "2030-01-01T00:00:00.000Z", cancellation_id: `cancel:${workItemId}`,
            payload: { files: artifacts, root_names: sourceArtifacts.map((artifact) => artifact.path), owner_path: owner.path, work_item: workItem, accepted_manifest: manifest, analysis_digest: prepared.plugin.compatibility.analysis_digest, analysis_configuration_digest: prepared.plugin.analysis_configuration_digest, analysis_input_digest: analysisInputDigest, created_at: now },
          }) as { readonly payload: { readonly validation_input: { readonly raw_delta: unknown } } };
          accepted.push(await acceptance.accept({ candidate, work_item: workItem, raw_delta: response.payload.validation_input.raw_delta, accepted_manifest: manifest, expected_replacement_scopes: [scope], target_registry: targetRegistry, base_records: [], base_record_dependencies: [], staged_records: [], analysis_context_digest: contextDigest }));
        }
      } finally {
        await worker.terminate();
      }
      const claims = accepted.flatMap((delta) => delta.delta.completeness_claims).filter((claim) => claim.capability === "core:call_relationships");
      const capability_state_entries: SnapshotCapabilityStateEntry[] = [{
        capability: "core:call_relationships",
        capability_contract_version: "1.0.0",
        provider_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
        provider_version: JAVASCRIPT_TYPESCRIPT_VERSION,
        status: claims.every((claim) => claim.status === "complete") ? "complete" : "partial",
        reason_codes: [...new Set(claims.flatMap((claim) => JSON.parse(claim.reason_codes) as string[]))].sort(),
        affected_artifact_ids: [...new Set(claims.flatMap((claim) => JSON.parse(claim.affected_artifact_ids) as string[]))].sort(),
        diagnostic_record_ids: [],
      }];
      return { accepted_deltas: accepted, capability_state_entries };
    },
  };
}

export async function seedFixtureFiles(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const file of ["task.ts", "errors.ts"]) await writeFile(join(root, file), await readFile(join(fixtureRoot, file), "utf8"), "utf8");
}

export const FORK_INCLUSION_RULES = { include: [], exclude: ["node_modules/**", ".git/**", "dist/**", ".urdira/**"], allow_external_root: false };

export async function registerEngineWorkspace(registry: WorkspaceRegistry, root: string, label: string): Promise<RegisteredWorkspace> {
  const workspace = registry.register({
    display_root: root,
    provider: { source_provider_binding_id: `binding:${label}`, source_provider: "core:directory_source_provider", source_provider_version: "1", provider_role: "primary", binding_identity: `identity:${label}`, configuration_digest: `digest:${label}` },
    description: { provider_kind: "core:directory_source_provider", immutable_binding_identity: `identity:${label}`, features: "{}", source_state_fingerprint: `fingerprint:${label}` },
    selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
  });
  registry.beginReconciliation(workspace.workspace_id);
  return registry.get(workspace.workspace_id)!;
}

export async function openEngineWorkspace(storage: DurableStorage, workspace: RegisteredWorkspace): Promise<WorkspaceDatabase> {
  await storage.catalog.registerWorkspace({ workspace_id: workspace.workspace_id, canonical_root: workspace.canonical_root, display_root: workspace.display_root, source_provider_bindings: [workspace.provider], status: "registered", registered_at: workspace.registered_at });
  return storage.openWorkspace(workspace.workspace_id);
}
