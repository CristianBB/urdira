import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
// Same root-level-dependency situation documented in
// `tests/phase-daemon-indexing-integration.test.ts`: `@urdira/engine`,
// `@urdira/plugin-javascript-typescript`, and `@urdira/daemon` are imported
// from `src` by relative path (not bare specifiers), so this file exercises
// the actual edits made in `packages/daemon/src/runtime.ts`.
import {
  candidateTargetRegistryFromSnapshot,
  createCanonicalPluginDigestAuthority,
  FactDeltaAcceptanceService,
  WorkspaceRegistry,
  type AcceptedFactDelta,
  type WorkspaceRegistryPersistence,
  type WorkspaceRegistryState,
  type WorkspaceScanPluginProvider,
} from "../packages/engine/src/index.js";
import {
  JAVASCRIPT_TYPESCRIPT_CAPABILITIES,
  JAVASCRIPT_TYPESCRIPT_DEPENDENCY_ROLES,
  JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
  JAVASCRIPT_TYPESCRIPT_RECORD_KINDS,
  JAVASCRIPT_TYPESCRIPT_VERSION,
  bundledPluginCatalogEntry,
  createJavascriptTypescriptInstalledBundle,
  createJavascriptTypescriptWorker,
  languageForPath,
} from "../packages/plugin-javascript-typescript/src/index.js";
import { DaemonClient, DaemonRuntime, type DaemonRuntimeOptions } from "../packages/daemon/src/index.js";
import { createDurableStorage, type DurableStorage, type WorkspaceDatabase } from "../packages/storage/src/index.js";

// Same private-field/dist-vs-src type-branding workaround documented in
// `tests/phase-daemon-indexing-integration.test.ts`.
function asDaemonWorkspaceRegistry(registry: WorkspaceRegistry): NonNullable<DaemonRuntimeOptions["workspace_registry"]> {
  return registry as unknown as NonNullable<DaemonRuntimeOptions["workspace_registry"]>;
}

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(here, "fixtures", "codebases", "typescript", "task-planner", "src", "domain");
const now = "2026-08-11T12:00:00.000Z";

interface PreparedRegistry {
  readonly registry: AssembledPluginRegistry;
  readonly lock: SdkPluginResolutionLock;
  readonly plugin: DiscoveredPluginPackage;
}

// `runFullWorkspaceScan` hands *every* currently-cataloged artifact to
// `plugin.analyze` on every scan, not just the ones a rescan actually
// changed (see `tests/phase-workspace-indexing-session.test.ts` and the final
// report's "genuine new gap" note), so a real plugin provider must not
// redundantly re-emit facts for artifact versions it has already produced
// records for -- `record_occurrences`'s content-addressed identity
// (`packages/storage/src/publication-authority.ts`) correctly rejects a
// second, still-open authoritative record at a later generation as a
// conflicting rewrite. This tracks "already analyzed" `artifact_version_id`s
// per workspace across the real second scans this file's `core:reindex` and
// `core:configuration_set` tests trigger.
const analyzedArtifactVersionsByWorkspace = new Map<string, Set<string>>();

// Unlike `tests/phase-daemon-indexing-integration.test.ts` (which scans each
// workspace exactly once), this file's `core:reindex` and
// `core:configuration_set` tests deliberately trigger a *second* real scan
// of the same workspace. `id_source`/`registry_snapshot_id` must therefore
// be unique per `prepareRegistry` call (not deterministically derived from
// `workspaceId` alone as in the source file this is adapted from), or the
// second scan collides with the first scan's already-published registry
// snapshot id and throws, which `scheduleWorkspaceScan`'s catch clause
// (correctly) turns into a "degraded" fallback instead of "ready" -- a
// test-fixture bug, not a production one, since the real `resolve_plugin_provider`
// in `apps/urdira/src/index.ts` is not called twice with the same identity.
async function prepareRegistry(workspaceId: string): Promise<PreparedRegistry> {
  const callId = randomUUID();
  const digests = createCanonicalPluginDigestAuthority();
  const encoder = new TextEncoder();
  const assets = [
    { normalized_relative_path: "dist/worker.mjs", bytes: encoder.encode("urdira daemon-admin-integration jsts worker"), executable: true, role: "parser" as const },
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
    id_source: () => `lock:${workspaceId}:${callId}`,
  });
  if (!resolved.ok) throw new Error(`plugin resolution failed: ${JSON.stringify(resolved.issues)}`);
  const assembled = new PluginRegistryAssembler(digests).assemble({
    packages: resolved.packages,
    lock: resolved.lock,
    registry_snapshot_id: `registry:${workspaceId}:${callId}`,
    core_registry_digest: canonicalSha256("core-registry"),
    emission_valid_from_generation: "1",
    clock: () => now,
    id_source: () => `registry-issue:${workspaceId}:${callId}`,
  });
  if (!assembled.ok) throw new Error(`registry assembly failed: ${JSON.stringify(assembled.issues)}`);
  return { registry: assembled.registry as PreparedRegistry["registry"], lock: resolved.lock, plugin: resolved.packages[0]! };
}

function accessManifest(workItemId: string, analysisContextDigest: string, artifacts: readonly { readonly artifact_id: string; readonly artifact_version_id: string; readonly content_hash: string }[]): AutomaticPluginInputAccessManifest {
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

function buildPluginProvider(prepared: PreparedRegistry, workspaceId: string, registrySnapshotId: string, configurationRevisionId: string): WorkspaceScanPluginProvider {
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
      const artifactVersions = artifacts.map((artifact) => ({ artifact_id: artifact.artifact_id, artifact_version_id: artifact.artifact_version_id, content_hash: artifact.content_hash }));
      const targetRegistry = candidateTargetRegistryFromSnapshot({ registry: prepared.registry, artifact_versions: artifactVersions });
      const acceptance = new FactDeltaAcceptanceService();
      const worker = createJavascriptTypescriptWorker({
        compatibility_declaration_digest: prepared.plugin.compatibility.declaration_digest,
        registry_contribution_digest: prepared.plugin.contribution.contribution_digest,
        analysis_digest: prepared.plugin.compatibility.analysis_digest,
        analysis_configuration_digest: prepared.plugin.analysis_configuration_digest,
      });
      const analyzed = analyzedArtifactVersionsByWorkspace.get(workspace_id) ?? new Set<string>();
      analyzedArtifactVersionsByWorkspace.set(workspace_id, analyzed);
      const sourceArtifacts = artifacts.filter((artifact) => languageForPath(artifact.path) !== undefined && !analyzed.has(artifact.artifact_version_id));
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
            // `FactDeltaAcceptanceService`'s `validateIdentity` (`packages/engine/src/fact-delta.ts`)
            // rejects a delta whose `base_snapshot_id` disagrees with the candidate's
            // once the candidate has one (a rescan of an already-published workspace,
            // now that `runFullWorkspaceScan` sets it) -- the JS/TS worker's
            // `fact-delta.ts` reads this straight off the work item, so a real caller
            // (not just this test) must echo it here.
            ...(candidate.base_snapshot_id === undefined ? {} : { base_snapshot_id: candidate.base_snapshot_id }),
          } satisfies ArtifactWorkItem & { readonly candidate_generation_id: string; readonly base_snapshot_id?: string };
          const manifest = accessManifest(workItemId, contextDigest, artifacts);
          const analysisInputDigest = canonicalSha256({ owner: owner.path, inputs: manifest.artifact_version_entries });
          const response = await worker.invoke({
            protocol_version: "1.0.0", request_id: manifest.request_id, request_digest: analysisInputDigest, call: "analyze_artifact", deadline: "2030-01-01T00:00:00.000Z", cancellation_id: `cancel:${workItemId}`,
            payload: { files: artifacts, root_names: sourceArtifacts.map((artifact) => artifact.path), owner_path: owner.path, work_item: workItem, accepted_manifest: manifest, analysis_digest: prepared.plugin.compatibility.analysis_digest, analysis_configuration_digest: prepared.plugin.analysis_configuration_digest, analysis_input_digest: analysisInputDigest, created_at: now },
          }) as { readonly payload: { readonly validation_input: { readonly raw_delta: unknown } } };
          accepted.push(await acceptance.accept({ candidate, work_item: workItem, raw_delta: response.payload.validation_input.raw_delta, accepted_manifest: manifest, expected_replacement_scopes: [scope], target_registry: targetRegistry, base_records: [], base_record_dependencies: [], staged_records: [], analysis_context_digest: contextDigest }));
          analyzed.add(owner.artifact_version_id);
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

const resolvePluginProvider: NonNullable<DaemonRuntimeOptions["resolve_plugin_provider"]> = async (workspace) => {
  if (!(workspace.selected_plugin_ids ?? []).includes(JAVASCRIPT_TYPESCRIPT_PLUGIN_ID)) return undefined;
  const prepared = await prepareRegistry(workspace.workspace_id);
  const registrySnapshotId = prepared.registry.registry_snapshot_id;
  const configurationRevisionId = `configuration:${workspace.workspace_id}:${randomUUID()}`;
  return buildPluginProvider(prepared, workspace.workspace_id, registrySnapshotId, configurationRevisionId);
};

async function pollUntilReady(client: DaemonClient, workspaceId: string, timeoutMs = 30_000): Promise<{ readonly workspace_status: string; readonly current_snapshot_id?: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: { readonly workspace_id: string; readonly workspace_status: string } | undefined;
  while (Date.now() < deadline) {
    const response = await client.call("core:index_status", {});
    if (response.outcome !== "success") throw new Error(`core:index_status did not succeed: ${JSON.stringify(response)}`);
    const payload = response.payload as { readonly workspaces: ReadonlyArray<{ readonly workspace_id: string; readonly workspace_status: string }> };
    const workspace = payload.workspaces.find((entry) => entry.workspace_id === workspaceId);
    if (workspace === undefined) throw new Error(`core:index_status did not report workspace ${workspaceId}.`);
    last = workspace;
    if (workspace.workspace_status === "ready" || workspace.workspace_status === "degraded") {
      const detail = await client.call("core:index_status", { workspace_ids: [workspaceId] });
      if (detail.outcome !== "success") throw new Error(`core:index_status (detail) did not succeed: ${JSON.stringify(detail)}`);
      const detailPayload = detail.payload as { readonly workspaces: ReadonlyArray<{ readonly workspace_status: string; readonly current_snapshot_id?: string }> };
      const detailWorkspace = detailPayload.workspaces[0];
      if (detailWorkspace === undefined) throw new Error("core:index_status (detail) returned no workspace entry.");
      return detailWorkspace;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Workspace ${workspaceId} did not leave "indexing" within ${timeoutMs}ms (last observed: ${JSON.stringify(last)}).`);
}

async function seedFixtureFiles(workspaceRoot: string): Promise<void> {
  await mkdir(workspaceRoot, { recursive: true });
  for (const file of ["task.ts", "errors.ts"]) {
    await writeFile(join(workspaceRoot, file), await readFile(join(fixtureRoot, file), "utf8"), "utf8");
  }
}

describe("Daemon admin commands: core:reindex, core:repair, core:garbage_collect", () => {
  it("core:reindex, core:repair, core:garbage_collect and core:configuration_set fall through to core:unknown_call without a workspace_registry", async () => {
    // Permanent regression guard for the exact empirically observed symptom
    // described in the task ("urdira reindex <id> --dry-run --confirm --json
    // returns exactly core:unknown_call"): with no `workspace_registry`
    // supplied, all four admin calls that need one still fall through to the
    // generic `runtimeCalls` lookup and surface `core:unknown_call`, proving
    // the new branches are correctly gated rather than always matching.
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-admin-unknown-"));
    let runtime: DaemonRuntime | undefined;
    try {
      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-daemon-admin-unknown",
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
      });
      const client = new DaemonClient(runtime.endpoint);
      for (const call of ["core:reindex", "core:repair", "core:garbage_collect", "core:configuration_set"]) {
        const response = await client.call(call, { args: ["workspace-1"] });
        expect(response.outcome).toBe("error");
        expect(response.error?.code).toBe("core:unknown_call");
      }
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("core:reindex performs a real first scan via reindex, and core:repair/core:garbage_collect invoke real storage maintenance", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-admin-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-admin-workspace-"));
    let runtime: DaemonRuntime | undefined;
    try {
      await seedFixtureFiles(workspaceRoot);

      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-daemon-admin-integration",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        plugin_catalog: [{ ...bundledPluginCatalogEntry, capability_declarations: JAVASCRIPT_TYPESCRIPT_CAPABILITIES }],
        resolve_plugin_provider: resolvePluginProvider,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
      });
      const client = new DaemonClient(runtime.endpoint);

      // `confirmed: false` only registers the workspace (status stays
      // "registering") -- it deliberately does not start the real
      // filesystem watcher (`startWorkspaceWatcher` is gated on `confirmed`
      // in `packages/daemon/src/runtime.ts`). This test drives every scan
      // through explicit `core:reindex` calls instead, so the real watcher
      // never independently reconciles the workspace at the same time and
      // races the explicit rescan below (which would otherwise be a genuine,
      // separate concurrency scenario worth its own test, not this one).
      const added = await client.call("core:workspace_add", {
        args: [workspaceRoot],
        confirmed: false,
        selected_technology_ids: ["typescript"],
        selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;

      // The very first scan is itself driven by `core:reindex` (exercising
      // `beginReconciliation` from "registering", not just from "ready"/"degraded").
      const firstReindex = await client.call("core:reindex", { args: [workspaceId] });
      expect(firstReindex.outcome).toBe("success");
      expect((firstReindex.payload as { readonly reindex_started: boolean }).reindex_started).toBe(true);
      const firstReady = await pollUntilReady(client, workspaceId);
      expect(firstReady.workspace_status).toBe("ready");
      const firstSnapshotId = firstReady.current_snapshot_id;
      expect(firstSnapshotId).toBeTypeOf("string");

      // --- core:reindex on an already-"ready" workspace ---
      // Change the workspace's source content before forcing a rescan, so
      // this is not merely a no-op re-run of the exact same observation.
      await writeFile(join(workspaceRoot, "extra.ts"), "export class ExtraReindexMarker {}\n", "utf8");
      const reindexed = await client.call("core:reindex", { args: [workspaceId] });
      expect(reindexed.outcome).toBe("success");
      const reindexedPayload = reindexed.payload as { readonly status: string; readonly reindex_started: boolean };
      expect(reindexedPayload.reindex_started).toBe(true);
      expect(reindexedPayload.status).toBe("indexing");
      const secondSettled = await pollUntilReady(client, workspaceId);
      // FIXED (previously a GENUINE FINDING, see the final report):
      // `runFullWorkspaceScan` (`packages/engine/src/workspace-indexing-session.ts`)
      // used to always freeze its candidate's base tuple as an unconditional
      // from-scratch base (`state_revision: 0`, no `snapshot_id`/`generation`/
      // `registry_snapshot_id`/`resolution_lock_id`/`configuration_revision_id`),
      // never reading the workspace's actual current published tuple, so
      // `WorkspaceDatabase.publishCandidateSerialized`'s `baseAgrees` check
      // (`packages/storage/src/storage.ts`) deterministically rejected
      // publication with `storage:publication_conflict` for any scan run
      // after a workspace already had a published snapshot, and
      // `scheduleWorkspaceScan`'s catch-and-degrade fallback turned that into
      // "degraded". `runFullWorkspaceScan` now reads the workspace's current
      // published tuple (`database.repositories.snapshots.getCurrent()`/`.get(...)`)
      // and the source index's prior known content before rebuilding its
      // base, so a real content change reaches a new, strictly-incremented
      // generation instead. This also fixes the pre-existing watcher-driven
      // `on_reconcile` reconciliation path for any workspace change detected
      // after the first successful scan, not just `core:reindex`; see the
      // final report.
      expect(secondSettled.workspace_status).toBe("ready");
      expect(secondSettled.current_snapshot_id).toBeTypeOf("string");
      expect(secondSettled.current_snapshot_id).not.toBe(firstSnapshotId);

      // --- core:garbage_collect ---
      // The workspace has no orphaned CAS objects yet (nothing has been
      // repaired, migrated, or had content superseded in a way that orphans
      // bytes), so a real collection pass should complete immediately with
      // nothing to delete. This still proves `WorkspaceDatabase.maintenance.collect`
      // is really invoked (a real `CollectionResult` shape comes back), not
      // a stub.
      const collected = await client.call("core:garbage_collect", { args: [workspaceId], payload: { batch_size: 500 } });
      expect(collected.outcome).toBe("success");
      const collectedPayload = collected.payload as { readonly epoch_id: string; readonly state: string; readonly deleted_hashes: readonly string[]; readonly remaining_candidates: number };
      expect(collectedPayload.epoch_id).toBeTypeOf("string");
      expect(collectedPayload.state).toBe("completed");
      expect(collectedPayload.remaining_candidates).toBe(0);
      expect(Array.isArray(collectedPayload.deleted_hashes)).toBe(true);

      // --- core:repair ---
      // Exercises the real `WorkspaceDatabase.maintenance.repair` method
      // through a deterministic, setup-free failure path: "cas" component
      // repair requires a verified `backup_directory`, which this request
      // omits on purpose. The point is not this specific failure, it is that
      // the daemon reaches real repair code (`storage:repair_source_missing`)
      // instead of `core:unknown_call`.
      const repaired = await client.call("core:repair", { args: [workspaceId], payload: { component_kind: "cas", component_id: `sha256:${"0".repeat(64)}` } });
      expect(repaired.outcome).toBe("error");
      // `StorageError` is not a `DaemonError`, but it does carry a registered
      // namespaced code (`storage:repair_source_missing`), so the daemon's
      // IPC server (`packages/daemon/src/protocol.ts`) now preserves the
      // original code and details on the wire instead of flattening it to
      // `core:execution_failed` -- this proves real repair code ran (a
      // specific, real `storage:repair_source_missing` failure), not
      // `core:unknown_call`, and that the caller can act on the precise code.
      expect(repaired.error?.code).toBe("storage:repair_source_missing");
      expect(repaired.error?.message).toMatch(/verified backup directory/);
      expect(repaired.error?.details).toBeDefined();
      expect(repaired.error?.details).toEqual({});
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 90_000);
});

describe("Daemon admin commands: core:configuration_set", () => {
  it("applies a real configuration change and triggers reconciliation for a non-query_only impact", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-config-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-config-workspace-"));
    let runtime: DaemonRuntime | undefined;
    try {
      await seedFixtureFiles(workspaceRoot);

      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-daemon-config-integration",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        plugin_catalog: [{ ...bundledPluginCatalogEntry, capability_declarations: JAVASCRIPT_TYPESCRIPT_CAPABILITIES }],
        resolve_plugin_provider: resolvePluginProvider,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
      });
      const client = new DaemonClient(runtime.endpoint);

      // `confirmed: false` avoids starting the real filesystem watcher (see
      // the matching comment in the `core:reindex` test above), so the
      // explicit rescan this test triggers via `core:configuration_set`
      // never races an independent watcher-driven reconciliation of the same
      // workspace.
      const added = await client.call("core:workspace_add", {
        args: [workspaceRoot],
        confirmed: false,
        selected_technology_ids: ["typescript"],
        selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      const firstReindex = await client.call("core:reindex", { args: [workspaceId] });
      expect(firstReindex.outcome).toBe("success");
      const firstReady = await pollUntilReady(client, workspaceId);
      expect(firstReady.workspace_status).toBe("ready");
      const firstSnapshotId = firstReady.current_snapshot_id;
      expect(firstSnapshotId).toBeTypeOf("string");

      // Invalid JSON: the active configuration is left untouched and no
      // reconciliation is triggered, mirroring `WorkspaceConfigurationCoordinator.applyConfigDocument`'s
      // documented behavior (`tests/phase15-workspace-control.test.ts`).
      const invalid = await client.call("core:configuration_set", { args: [workspaceId], values: { value: '{"analysis":' } });
      expect(invalid.outcome).toBe("success");
      const invalidPayload = invalid.payload as { readonly configuration_applied: boolean; readonly reindex_required: boolean };
      expect(invalidPayload.configuration_applied).toBe(false);
      expect(invalidPayload.reindex_required).toBe(false);

      await writeFile(join(workspaceRoot, "extra.ts"), "export class ExtraConfigMarker {}\n", "utf8");

      // A real "analysis" configuration change: non-`query_only` impact, so
      // this must trigger a real reconciliation, not just a status flip.
      const changed = await client.call("core:configuration_set", { args: [workspaceId], values: { value: JSON.stringify({ analysis: { depth: 2 } }) } });
      expect(changed.outcome).toBe("success");
      const changedPayload = changed.payload as { readonly configuration_applied: boolean; readonly configuration_impact: string; readonly reindex_required: boolean; readonly workspace_status?: string };
      expect(changedPayload.configuration_applied).toBe(true);
      expect(changedPayload.configuration_impact).toBe("analysis");
      expect(changedPayload.reindex_required).toBe(true);
      expect(changedPayload.workspace_status).toBe("indexing");

      // FIXED (previously a GENUINE FINDING, see the matching comment in the
      // `core:reindex` test above and the final report): the real rescan this
      // reconfiguration triggers now completes for an already-published
      // workspace -- `runFullWorkspaceScan` reads the workspace's actual
      // current published tuple before rebuilding its candidate base, so the
      // real content change above reaches a new, strictly-incremented
      // generation instead of `storage:publication_conflict` degrading to the
      // unchanged prior snapshot.
      const secondSettled = await pollUntilReady(client, workspaceId);
      expect(secondSettled.workspace_status).toBe("ready");
      expect(secondSettled.current_snapshot_id).toBeTypeOf("string");
      expect(secondSettled.current_snapshot_id).not.toBe(firstSnapshotId);

      // Re-applying the exact same document is a `query_only` no-op diff:
      // no reconciliation this time.
      const repeated = await client.call("core:configuration_set", { args: [workspaceId], values: { value: JSON.stringify({ analysis: { depth: 2 } }) } });
      expect(repeated.outcome).toBe("success");
      const repeatedPayload = repeated.payload as { readonly configuration_impact: string; readonly reindex_required: boolean };
      expect(repeatedPayload.configuration_impact).toBe("query_only");
      expect(repeatedPayload.reindex_required).toBe(false);
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 90_000);
});

describe("Daemon admin commands: core:daemon_start / core:daemon_stop / core:daemon_restart", () => {
  it("acknowledges start as already-running, and stop/restart gracefully shut the runtime down after responding", async () => {
    const dataRootStart = await mkdtemp(join(tmpdir(), "urdira-daemon-lifecycle-start-"));
    let startRuntime: DaemonRuntime | undefined;
    try {
      startRuntime = await DaemonRuntime.start({
        data_root: dataRootStart,
        engine_build_id: "build-daemon-lifecycle-start",
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
      });
      const client = new DaemonClient(startRuntime.endpoint);
      const started = await client.call("core:daemon_start", {});
      expect(started.outcome).toBe("success");
      expect((started.payload as { readonly state: string }).state).toBe("already_running");
      // The daemon is still fully usable after acknowledging `daemon_start`.
      const status = await client.call("core:status", {});
      expect(status.outcome).toBe("success");
    } finally {
      if (startRuntime) await startRuntime.stop();
      await rm(dataRootStart, { recursive: true, force: true });
    }

    const dataRootStop = await mkdtemp(join(tmpdir(), "urdira-daemon-lifecycle-stop-"));
    let stopRuntime: DaemonRuntime | undefined;
    try {
      stopRuntime = await DaemonRuntime.start({
        data_root: dataRootStop,
        engine_build_id: "build-daemon-lifecycle-stop",
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
      });
      const client = new DaemonClient(stopRuntime.endpoint);
      const stopped = await client.call("core:daemon_stop", {});
      // The response for this exact request is delivered before the runtime
      // tears its own IPC server down -- the direct regression check that
      // `core:daemon_stop` schedules shutdown after responding instead of
      // racing the in-flight response.
      expect(stopped.outcome).toBe("success");
      expect((stopped.payload as { readonly state: string }).state).toBe("stopping");
      // The scheduled shutdown then actually happens: a fresh connection
      // eventually fails once the runtime has stopped and removed its
      // endpoint socket.
      const deadline = Date.now() + 10_000;
      let stoppedForReal = false;
      while (Date.now() < deadline && !stoppedForReal) {
        try { await new DaemonClient(stopRuntime.endpoint).call("core:status", {}); }
        catch { stoppedForReal = true; }
        if (!stoppedForReal) await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
      expect(stoppedForReal).toBe(true);
      // `stop()`'s own remaining teardown (checkpoint write, descriptor
      // removal, process-lock release) can still be finishing just after the
      // IPC socket itself becomes unreachable; give it a moment before this
      // test's `finally` block removes `dataRootStop` out from under it.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
      stopRuntime = undefined; // already stopped; do not call stop() again in `finally`
    } finally {
      if (stopRuntime) await stopRuntime.stop();
      await rm(dataRootStop, { recursive: true, force: true });
    }
  }, 30_000);
});

function syncFilePersistence(path: string): WorkspaceRegistryPersistence {
  return {
    load: () => {
      try { return JSON.parse(readFileSync(path, "utf8")) as WorkspaceRegistryState; }
      catch { return undefined; }
    },
    save: (state) => { writeFileSync(path, JSON.stringify(state), "utf8"); },
  };
}

describe("Daemon startup crash recovery for stuck \"indexing\" workspaces", () => {
  it("retries a workspace left \"indexing\" by a prior process life, reaching \"ready\" without any client action", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-recovery-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-recovery-workspace-"));
    const registryFile = join(dataRoot, "workspace-registry.json");
    let runtime: DaemonRuntime | undefined;
    try {
      await seedFixtureFiles(workspaceRoot);

      // Directly seed a workspace stuck "indexing" via a persisted registry,
      // simulating a daemon that crashed mid-scan: nothing here ever calls
      // `DaemonRuntime.start()`, `core:workspace_add`, or a plugin provider.
      const seedRegistry = new WorkspaceRegistry({ persistence: syncFilePersistence(registryFile) });
      const root = resolve(workspaceRoot);
      const identity = `sha256:${Buffer.from(root).toString("hex")}`;
      const seeded = seedRegistry.register({
        display_root: root,
        provider: {
          source_provider_binding_id: `binding:${identity.slice("sha256:".length)}`,
          source_provider: "core:directory_source_provider",
          source_provider_version: "1",
          provider_role: "primary",
          binding_identity: identity,
          configuration_digest: `sha256:${"1".repeat(64)}`,
        },
        description: {
          provider_kind: "core:directory_source_provider",
          immutable_binding_identity: identity,
          features: JSON.stringify({ supports_watch: true, supports_complete_enumeration: true, supports_stable_reconciliation: true, read_only: false }),
          source_state_fingerprint: identity,
        },
        selected_technology_ids: ["typescript"],
        selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      });
      seedRegistry.beginReconciliation(seeded.workspace_id);
      expect(seedRegistry.get(seeded.workspace_id)?.status).toBe("indexing");

      // A fresh `DaemonRuntime.start()` against the same persisted registry
      // and data root, as if the daemon process had been killed and
      // restarted (e.g. by a process manager). No client ever calls
      // `core:workspace_add` or `core:reindex` in this test.
      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-daemon-recovery",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry({ persistence: syncFilePersistence(registryFile) })),
        plugin_catalog: [{ ...bundledPluginCatalogEntry, capability_declarations: JAVASCRIPT_TYPESCRIPT_CAPABILITIES }],
        resolve_plugin_provider: resolvePluginProvider,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
      });
      const client = new DaemonClient(runtime.endpoint);
      const settled = await pollUntilReady(client, seeded.workspace_id);
      expect(settled.workspace_status).toBe("ready");
      expect(settled.current_snapshot_id).toBeTypeOf("string");
      expect(settled.current_snapshot_id?.length).toBeGreaterThan(0);
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 60_000);
});

// Deterministic replacement for a fixed real-time sleep: lets one side of a
// test block a specific async operation until the other side explicitly
// releases it, so a race between "operation X is still in flight" and "fire
// a concurrent request Y" never depends on wall-clock timing. See the
// concurrency-guard test below for why a fixed sleep here previously
// starved under heavy parallel test-suite load (the machine got busy enough
// that the artificial delay elapsed, and the scan attempt it was meant to
// keep "in flight" fully completed, before the test's own poll loop even
// noticed it had started).
function createLatch(): { readonly wait: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

describe("Daemon workspace scan concurrency guard (Phase 4.4)", () => {
  it("never runs two scans of the same workspace concurrently, even when reconfigured back-to-back with a raised structural pool concurrency", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-scan-guard-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-scan-guard-workspace-"));
    let runtime: DaemonRuntime | undefined;
    try {
      await seedFixtureFiles(workspaceRoot);

      // Tracks how many `plugin.analyze` calls are concurrently in flight
      // (across any scan of this workspace) and artificially slows each one
      // down, so a real scan stays "in flight" long enough for a second
      // `core:configuration_set` reconfiguration -- fired immediately after
      // the first one's response, well before its own real rescan can
      // possibly finish -- to land while the first scan is still running.
      let concurrentAnalyzeCalls = 0;
      let maxConcurrentAnalyzeCalls = 0;
      // `resolve_plugin_provider` is called once per attempted
      // `runFullWorkspaceScan` (`scheduleWorkspaceScan`'s scheduled `run`,
      // `packages/daemon/src/runtime.ts`), regardless of whether that scan's
      // source diff turns out `equivalent` (no file changes -- in which case
      // `analyze` is never reached at all, since `CandidateIndexer.stageSourceBatch`
      // short-circuits before `execute`). Counting it, not `analyze`, is what
      // actually counts "a scan was attempted for this workspace" here: a
      // `core:configuration_set` reconfiguration with no file changes stays
      // source-equivalent, so `analyze` alone would undercount attempted
      // (including coalesced) scans.
      let totalScanAttempts = 0;
      // Armed immediately before firing `changedFirst` (below) and consumed
      // by exactly the next `trackedResolvePluginProvider` call, whichever
      // attempt that turns out to be -- either `changedFirst`'s own fresh
      // scan, or (if `firstReady`'s "ready" became client-visible before the
      // first scan's own `scanInFlight` guard had actually cleared -- an
      // internal teardown tail that is not observable from the client) a
      // coalesced follow-up that already absorbed it. Either way, that
      // attempt blocks on `latch.wait` -- holding `scanInFlight` true for as
      // long as this test needs, not for a fixed duration -- until
      // `changedSecond` has been sent and its own `core:configuration_set`
      // handler has synchronously run `scheduleWorkspaceScan` (guaranteed
      // once `client.call` resolves: the handler calls it before responding,
      // see `packages/daemon/src/runtime.ts`), so `changedSecond` is
      // deterministically guaranteed to coalesce into this attempt instead
      // of racing a fixed sleep against however slow the machine happens to
      // be right now.
      let holdNextAttempt: ReturnType<typeof createLatch> | undefined;
      let resolveAttemptHeld: (() => void) | undefined;
      const trackedResolvePluginProvider: NonNullable<DaemonRuntimeOptions["resolve_plugin_provider"]> = async (workspace, database) => {
        totalScanAttempts += 1;
        if (holdNextAttempt) {
          const latch = holdNextAttempt;
          holdNextAttempt = undefined;
          resolveAttemptHeld?.();
          await latch.wait;
        }
        const base = await resolvePluginProvider(workspace, database);
        if (!base) return undefined;
        return {
          ...base,
          analyze: async (input: Parameters<WorkspaceScanPluginProvider["analyze"]>[0]) => {
            concurrentAnalyzeCalls += 1;
            maxConcurrentAnalyzeCalls = Math.max(maxConcurrentAnalyzeCalls, concurrentAnalyzeCalls);
            try {
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
              return await base.analyze(input);
            } finally {
              concurrentAnalyzeCalls -= 1;
            }
          },
        };
      };

      // `structural` raised well above the historical default of 1 (see
      // `apps/urdira/src/index.ts`'s `URDIRA_STRUCTURAL_CONCURRENCY`,
      // default 2): without the per-workspace `scanInFlight` guard in
      // `scheduleWorkspaceScan` (`packages/daemon/src/runtime.ts`), this
      // pool has enough headroom for two scans of the SAME workspace to run
      // at once.
      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-daemon-scan-guard",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        plugin_catalog: [{ ...bundledPluginCatalogEntry, capability_declarations: JAVASCRIPT_TYPESCRIPT_CAPABILITIES }],
        resolve_plugin_provider: trackedResolvePluginProvider,
        scheduler: { pool_concurrency: { source: 1, structural: 3, semantic: 1, query: 1 }, max_active: 8, client_quotas: {} },
      });
      const client = new DaemonClient(runtime.endpoint);

      const added = await client.call("core:workspace_add", {
        args: [workspaceRoot],
        confirmed: false,
        selected_technology_ids: ["typescript"],
        selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      const firstReindex = await client.call("core:reindex", { args: [workspaceId] });
      expect(firstReindex.outcome).toBe("success");
      const firstReady = await pollUntilReady(client, workspaceId);
      expect(firstReady.workspace_status).toBe("ready");
      expect(maxConcurrentAnalyzeCalls).toBe(1);

      // Two distinct non-`query_only` reconfigurations, fired back-to-back:
      // `core:configuration_set`'s handler calls `scheduleWorkspaceScan`
      // unconditionally on a non-`query_only` impact (unlike `core:reindex`,
      // it has no "already indexing" guard of its own), so this is the
      // most direct way to submit two scan requests for the same workspace
      // without waiting for the first to settle.
      const attemptsBeforeFirst = totalScanAttempts;
      const latch = createLatch();
      const heldSignal = new Promise<void>((resolve) => { resolveAttemptHeld = resolve; });
      holdNextAttempt = latch;
      const changedFirst = await client.call("core:configuration_set", { args: [workspaceId], values: { value: JSON.stringify({ analysis: { depth: 2 } }) } });
      expect(changedFirst.outcome).toBe("success");
      expect((changedFirst.payload as { readonly configuration_impact: string; readonly reindex_required: boolean })).toMatchObject({ configuration_impact: "analysis", reindex_required: true });
      // Deterministically wait until the scan attempt attributable to
      // `changedFirst` has actually started and is now blocked on `latch`
      // (see the comment above `holdNextAttempt`), instead of polling
      // `totalScanAttempts` and racing a fixed sleep to decide when it is
      // safe to fire the second reconfiguration -- no timeout, no busy-poll
      // interval that can starve under heavy parallel test-suite load.
      await heldSignal;
      expect(totalScanAttempts).toBeGreaterThan(attemptsBeforeFirst);
      const changedSecond = await client.call("core:configuration_set", { args: [workspaceId], values: { value: JSON.stringify({ analysis: { depth: 3 } }) } });
      expect(changedSecond.outcome).toBe("success");
      expect((changedSecond.payload as { readonly configuration_impact: string; readonly reindex_required: boolean })).toMatchObject({ configuration_impact: "analysis", reindex_required: true });
      // `changedSecond`'s `core:configuration_set` handler has, by now,
      // already run `scheduleWorkspaceScan` synchronously (it does so before
      // responding, see the comment above `holdNextAttempt`), and the held
      // attempt above is still blocked on `latch` -- so `changedSecond` is
      // guaranteed to have coalesced into it, not raced against it. Release
      // it now and let both the held attempt and its guaranteed coalesced
      // follow-up (Phase 5.4) actually run.
      latch.release();

      // `pollUntilReady`'s "ready" signal alone is not sufficient to know
      // the coalesced follow-up attempt for `changedSecond` has actually
      // run yet: `registry.markReady(...)` (what makes a workspace visible
      // as "ready" to `core:index_status`) runs for the just-released
      // attempt *before* that attempt's own async teardown
      // (`WorkspaceDatabase.close()`) completes and reschedules the
      // coalesced follow-up (see `packages/daemon/src/runtime.ts`'s
      // `scheduleWorkspaceScan` -- `finally { scanInFlight.delete(...); ...
      // }` runs after that `await`) -- so a client polling right then can
      // observe "ready" from the released attempt itself, before the
      // follow-up attempt this test actually cares about has even been
      // submitted. Wait for `totalScanAttempts` to grow past the released
      // attempt's own count first: no fixed timeout here (the follow-up's
      // submission is already synchronously guaranteed by the coalescing
      // above, this is purely "how soon does the scheduler get to it"), so
      // `pollUntilReady` below is guaranteed to observe the real, final
      // settlement instead of racing this gap.
      const attemptsAtRelease = totalScanAttempts;
      while (totalScanAttempts <= attemptsAtRelease) await new Promise((resolveWait) => setTimeout(resolveWait, 5));

      const settled = await pollUntilReady(client, workspaceId, 30_000);
      expect(settled.workspace_status).toBe("ready");
      // The real assertion: however many scans actually ran for this
      // workspace across the whole test, `plugin.analyze` was never called
      // while another call for the same workspace was still in flight.
      expect(maxConcurrentAnalyzeCalls).toBe(1);
      // Phase 5.4's coalescing upgrade: `changedSecond` landed while a scan
      // attempt was in flight, so it must have been coalesced into a
      // guaranteed follow-up scan (not silently dropped, the pre-Phase-5
      // behavior) -- at least 3 scan attempts total (the initial
      // `core:reindex`, `changedFirst`'s own attempt, and the coalesced
      // follow-up attempt for `changedSecond`).
      expect(totalScanAttempts).toBeGreaterThanOrEqual(3);
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * Seeds just enough of a workspace's own SQLite database for the daemon's
 * startup prewarm chain to open it without error -- `record_occurrences` is
 * deliberately left empty, since `core:index_status` (what this describe
 * block actually tests) never reads workspace-database content at all, only
 * the in-memory `WorkspaceRegistry` entry. Mirrors
 * `tests/phase-warm-records-budget.test.ts`'s `seedLargeReadyWorkspace`,
 * trimmed to zero records.
 */
async function seedEmptyReadyWorkspace(database: WorkspaceDatabase, workspaceId: string): Promise<void> {
  const db = database.database;
  await db.exec("PRAGMA foreign_keys = OFF");
  await db.run("INSERT INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest, registry_payload) VALUES (?, ?, ?, ?, ?, ?, ?)", [`registry:${workspaceId}`, workspaceId, "1", "core-digest", "lock-1", "registry-digest-1", new Uint8Array([1])]);
  await db.run("INSERT INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest, snapshot_payload) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [`snapshot:${workspaceId}`, workspaceId, 1, `manifest:${workspaceId}`, `registry:${workspaceId}`, "lock-1", "configuration-1", "source-digest", "[]", "records-digest", "projections-digest", "capabilities-digest", now, `snapshot-digest:${workspaceId}`, new Uint8Array([1])]);
  await db.run("INSERT INTO workspace_current_state (workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id, current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision, updated_at, current_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [workspaceId, `snapshot:${workspaceId}`, 1, `registry:${workspaceId}`, "lock-1", "configuration-1", "freshness-1", 1, now, new Uint8Array([1])]);
}

// P0 regression: the `publication_conflict` delete-then-restore wedge left a
// workspace re-serving a stale generation FOREVER while `core:index_status`
// kept reporting `freshness_status: "current"` -- no signal at all that the
// latest scan attempt had failed. This deliberately bypasses a real scan
// (no JS/TS plugin, no file fixture -- what's under test is
// `packages/daemon/src/runtime.ts`'s `core:index_status` wiring, not
// indexing itself): the workspace's registry state is driven directly
// through `WorkspaceRegistry.recordScanFailure`/`markReady`, exactly
// mirroring what `scheduleWorkspaceScan`'s catch block does on a real
// failure.
describe("Daemon core:index_status surfaces a failed scan as stale (P0 publication_conflict wedge staleness fix)", () => {
  it("reports freshness_status \"stale\" with the failure code/time while a scan keeps failing, and clears back to \"current\" once one succeeds", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-index-status-staleness-data-"));
    let seedStorage: DurableStorage | undefined;
    let runtime: DaemonRuntime | undefined;
    try {
      const registry = new WorkspaceRegistry({ create_id: (kind) => `${kind}:index-status-staleness` });
      const registered = registry.register({
        display_root: "/index-status-staleness",
        provider: { source_provider_binding_id: "binding:index-status-staleness", source_provider: "core:directory_source_provider", source_provider_version: "1", provider_role: "primary", binding_identity: "identity:index-status-staleness", configuration_digest: "digest:index-status-staleness" },
        description: { provider_kind: "core:directory_source_provider", immutable_binding_identity: "identity:index-status-staleness", features: "{}", source_state_fingerprint: "fingerprint:index-status-staleness" },
      });
      registry.beginReconciliation(registered.workspace_id);
      registry.markReady(registered.workspace_id, "snapshot:index-status-staleness", "ready");

      seedStorage = await createDurableStorage({ rootDir: dataRoot });
      await seedStorage.catalog.registerWorkspace({ workspace_id: registered.workspace_id, canonical_root: registered.canonical_root, display_root: registered.display_root, source_provider_bindings: [registered.provider], status: "registered", registered_at: registered.registered_at });
      const seededDatabase = await seedStorage.openWorkspace(registered.workspace_id);
      try { await seedEmptyReadyWorkspace(seededDatabase, registered.workspace_id); } finally { await seededDatabase.close(); }
      await seedStorage.close();
      seedStorage = undefined;

      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-index-status-staleness",
        workspace_registry: registry as unknown as NonNullable<DaemonRuntimeOptions["workspace_registry"]>,
        // Never actually invoked: the workspace is pre-marked "ready" above
        // and no scan is ever scheduled for it in this test.
        resolve_plugin_provider: async () => undefined,
        lexical_index: false,
        semantic_index: false,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
      });
      await runtime.debugFlushPendingWarms();

      const client = new DaemonClient(runtime.endpoint);
      type StatusPayload = { readonly workspaces: ReadonlyArray<{ readonly workspace_status: string; readonly freshness_status: string; readonly last_scan_error_code?: string; readonly last_scan_error_at?: string }> };
      const status = async (): Promise<StatusPayload["workspaces"][number] | undefined> => {
        const response = await client.call("core:index_status", { workspace_ids: [registered.workspace_id] });
        if (response.outcome !== "success") throw new Error(`core:index_status did not succeed: ${JSON.stringify(response)}`);
        return (response.payload as StatusPayload).workspaces[0];
      };

      const before = await status();
      expect(before?.workspace_status).toBe("ready");
      expect(before?.freshness_status).toBe("current");
      expect(before?.last_scan_error_code).toBeUndefined();
      expect(before?.last_scan_error_at).toBeUndefined();

      // Exactly the sequence `scheduleWorkspaceScan`'s catch block runs on a
      // real failure (`packages/daemon/src/runtime.ts`): record the
      // failure, then re-pin to "degraded" with the workspace's prior
      // (still perfectly valid) snapshot.
      registry.recordScanFailure(registered.workspace_id, "storage:publication_conflict");
      registry.markReady(registered.workspace_id, "snapshot:index-status-staleness", "degraded");

      const duringFailure = await status();
      expect(duringFailure?.workspace_status).toBe("degraded");
      // The core assertion: a workspace that is still queryable
      // ("degraded", serving its last-known-good snapshot) but whose latest
      // scan attempt failed must NOT report "current" -- before this fix it
      // always did, silently.
      expect(duringFailure?.freshness_status).toBe("stale");
      expect(duringFailure?.last_scan_error_code).toBe("storage:publication_conflict");
      expect(duringFailure?.last_scan_error_at).toBeDefined();

      // A later successful scan (`markReady(..., "ready")`) clears the
      // failure markers and freshness reports "current" again.
      registry.markReady(registered.workspace_id, "snapshot:index-status-staleness-recovered", "ready");
      const recovered = await status();
      expect(recovered?.workspace_status).toBe("ready");
      expect(recovered?.freshness_status).toBe("current");
      expect(recovered?.last_scan_error_code).toBeUndefined();
      expect(recovered?.last_scan_error_at).toBeUndefined();
    } finally {
      await seedStorage?.close().catch(() => undefined);
      await runtime?.stop().catch(() => undefined);
      await rm(dataRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
