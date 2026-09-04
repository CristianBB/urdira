import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import {
  candidateTargetRegistryFromSnapshot,
  createCanonicalPluginDigestAuthority,
  FactDeltaAcceptanceService,
  WorkspaceRegistry,
  type AcceptedFactDelta,
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
import { createIndexingCoreProcessTransport, type IndexingCoreProcessTransport } from "../packages/plugin-javascript-typescript/src/indexing-core-process-transport.js";
import { DaemonClient, DaemonRuntime, type DaemonRuntimeOptions } from "../packages/daemon/src/index.js";
import { hostNativeTarget, nativeArtifactNames } from "../scripts/native-release.mjs";

/**
 * `core:get_outline`'s additive `pending_sites` stream (task brief:
 * `docs/evidence/2026-09-04-v4-pending-sites-fold-and-member-entities.md`
 * §8, `docs/protocol/public-query-contract.md`'s `core:get_outline`
 * section) -- end-to-end coverage through a REAL daemon, the REAL
 * `urdira-indexing-worker` binary, and the REAL native structural-store
 * addon (no fake transport), modelled verbatim on
 * `tests/v4-daemon-e2e.test.ts`'s bootstrap (duplicated here rather than
 * imported -- none of it is exported from that file, and that file is
 * being edited concurrently by another task in this session; a NEW file
 * avoids merge contention on it, per this task's own instructions).
 *
 * Uses the SAME `tests/fixtures/codebases/typescript/task-planner/src/
 * domain/{task.ts,errors.ts}` fixture pair `v4-daemon-e2e.test.ts` scans.
 * `errors.ts` declares two classes that `extends Error` (a global/ambient
 * type this checker-free cold pipeline cannot see) with a constructor that
 * calls `super(...)` -- both the heritage clause and the `super` call are
 * therefore real, deterministic pending sites at cold (no residual/tsgo
 * pass runs in this file), confirmed live via `v4-daemon-e2e.test.ts`'s
 * own comparison assertions ("`extends Error`... `Error` is a global lib
 * type v4's checker-free resolver cannot see"). `task.ts` declares only
 * types/interfaces with no calls or heritage clauses, so it is expected to
 * have NO pending sites at all -- used as a negative control.
 *
 * Gated on the release artifacts existing, exactly like
 * `tests/v4-daemon-e2e.test.ts`.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const hostTarget = hostNativeTarget();
const workerPath = process.env["URDIRA_INDEXING_CORE_WORKER_PATH"]
  ?? (hostTarget === undefined ? undefined : resolve(repoRoot, "release/native", hostTarget, nativeArtifactNames(hostTarget).indexing_core_worker));
const nativeAddonPath = process.env["URDIRA_NATIVE_ADDON_PATH"]
  ?? (hostTarget === undefined ? undefined : resolve(repoRoot, "release/native", hostTarget, nativeArtifactNames(hostTarget).addon));
const hasReleaseArtifacts = workerPath !== undefined && existsSync(workerPath) && nativeAddonPath !== undefined && existsSync(nativeAddonPath);

if (nativeAddonPath !== undefined) process.env["URDIRA_NATIVE_ADDON_PATH"] ??= nativeAddonPath;

const fixtureRoot = resolve(repoRoot, "tests/fixtures/codebases/typescript/task-planner/src/domain");
const now = "2026-09-04T00:00:00.000Z";

function asDaemonWorkspaceRegistry(registry: WorkspaceRegistry): NonNullable<DaemonRuntimeOptions["workspace_registry"]> {
  return registry as unknown as NonNullable<DaemonRuntimeOptions["workspace_registry"]>;
}

type StreamPage = { readonly items: ReadonlyArray<{ readonly value: unknown }>; readonly next_cursor?: string; readonly has_next: boolean };

/** Runs one `core:query` operation and returns its RAW `streams` map, keyed by stream name -- see `tests/v4-daemon-e2e.test.ts`'s identical helper for why "the first stream" is the wrong default. */
async function queryStreams(client: DaemonClient, workspaceId: string, operation: string, args: Record<string, unknown>): Promise<Readonly<Record<string, StreamPage>>> {
  const queryOptions = {
    freshness: "current",
    wait_timeout_ms: 0,
    coverage_requirement: "accept_reported",
    evidence: { evidence: "summary", evidence_chain_depth: 1 },
    diagnostics: { diagnostics: "relevant", diagnostic_detail: true },
    snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 },
    registry: { registry: "used", include_payload_schemas: false },
    response_budget: { max_items: 1_000, max_characters: 4_000_000 },
  };
  const response = await client.call("core:query", {
    api_version: 3,
    scope: { scope_type: "single_workspace", workspace_id: workspaceId },
    expression: { expression_type: "operation", operation, arguments: args },
    options: queryOptions,
  });
  if (response.outcome !== "success") throw new Error(`core:query (${operation}) did not succeed: ${JSON.stringify(response)}`);
  const payload = response.payload as { readonly streams: Readonly<Record<string, StreamPage>> };
  return payload.streams;
}

async function queryOneStream(client: DaemonClient, workspaceId: string, operation: string, args: Record<string, unknown>, streamName: string): Promise<ReadonlyArray<Record<string, unknown>>> {
  const streams = await queryStreams(client, workspaceId, operation, args);
  return (streams[streamName]?.items ?? []).map((item) => item.value as Record<string, unknown>);
}

function recordName(value: Record<string, unknown>): string | undefined {
  const body = value["body"] as Record<string, unknown> | undefined;
  const name = body?.["name"];
  return typeof name === "string" ? name : undefined;
}

async function pollUntilStructuralReady(client: DaemonClient, workspaceId: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    const response = await client.call("core:index_status", { workspace_ids: [workspaceId] });
    if (response.outcome === "success") {
      const payload = response.payload as { readonly workspaces: ReadonlyArray<Record<string, unknown>> };
      last = payload.workspaces[0];
      if (last?.["structural_ready"] === true) return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Workspace ${workspaceId} did not reach structural_ready within ${timeoutMs}ms (last observed: ${JSON.stringify(last)}).`);
}

async function pollUntilReady(client: DaemonClient, workspaceId: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: { readonly workspace_status: string } | undefined;
  while (Date.now() < deadline) {
    const response = await client.call("core:index_status", { workspace_ids: [workspaceId] });
    if (response.outcome === "success") {
      const payload = response.payload as { readonly workspaces: ReadonlyArray<{ readonly workspace_status: string }> };
      last = payload.workspaces[0];
      if (last?.workspace_status === "ready" || last?.workspace_status === "degraded") return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Workspace ${workspaceId} did not leave "indexing" within ${timeoutMs}ms (last observed: ${JSON.stringify(last)}).`);
}

async function seedFixtureWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-v4-pending-sites-workspace-"));
  await mkdir(workspaceRoot, { recursive: true });
  for (const file of ["task.ts", "errors.ts"]) {
    await writeFile(join(workspaceRoot, file), await readFile(join(fixtureRoot, file), "utf8"), "utf8");
  }
  return workspaceRoot;
}

// --- plugin bootstrap: verbatim adaptation of `tests/v4-daemon-e2e.test.ts`'s
// own (itself adapted from `tests/phase-daemon-indexing-integration.test.ts`);
// duplicated rather than imported, since none of it is exported. ---

interface PreparedRegistry {
  readonly registry: AssembledPluginRegistry;
  readonly lock: SdkPluginResolutionLock;
  readonly plugin: DiscoveredPluginPackage;
}

async function prepareRegistry(workspaceId: string): Promise<PreparedRegistry> {
  const digests = createCanonicalPluginDigestAuthority();
  const encoder = new TextEncoder();
  const assets = [
    { normalized_relative_path: "dist/worker.mjs", bytes: encoder.encode("urdira v4-pending-sites-query jsts worker"), executable: true, role: "parser" as const },
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
          } satisfies ArtifactWorkItem & { readonly candidate_generation_id: string };
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

const resolveV3PluginProvider: NonNullable<DaemonRuntimeOptions["resolve_plugin_provider"]> = async (workspace) => {
  if (!(workspace.selected_plugin_ids ?? []).includes(JAVASCRIPT_TYPESCRIPT_PLUGIN_ID)) return undefined;
  const prepared = await prepareRegistry(workspace.workspace_id);
  const registrySnapshotId = prepared.registry.registry_snapshot_id;
  const configurationRevisionId = `configuration:${workspace.workspace_id}`;
  return buildPluginProvider(prepared, workspace.workspace_id, registrySnapshotId, configurationRevisionId);
};

const DAEMON_CLIENT_OPTIONS = { request_timeout_ms: 120_000 };

const KNOWN_SITE_KINDS = new Set(["call", "inherits", "implements"]);
const KNOWN_REASONS = new Set([
  "unspecified", "call_deferred_to_e3", "call_target_uncertain", "overload_ambiguous", "union_ambiguous",
  "target_not_interned", "heritage_unresolved", "heritage_deferred_to_e3", "heritage_target_uncertain",
  "heritage_clause_partially_pending",
]);

const describeIfBuilt = hasReleaseArtifacts ? describe : describe.skip;

it.skipIf(hasReleaseArtifacts)("v4 pending_sites query e2e is skipped: build the release artifacts first", () => {
  console.warn(
    `[urdira] tests/v4-pending-sites-query.test.ts skipped -- missing worker (${workerPath ?? "no host target"}) or native addon (${nativeAddonPath ?? "no host target"}). ` +
    "Build them with: node scripts/build-native.mjs",
  );
});

describeIfBuilt("core:get_outline pending_sites stream (real urdira-indexing-worker + native structural store)", () => {
  it("lists errors.ts's unresolved extends/super sites on the module, narrows to one class's sites on that entity, and resolves task.ts empty", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-v4-pending-sites-data-"));
    const workspaceRoot = await seedFixtureWorkspace();
    let runtime: DaemonRuntime | undefined;
    const sessions = new Map<string, IndexingCoreProcessTransport>();
    try {
      process.env["URDIRA_V4"] = "1";
      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-v4-pending-sites-query",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        resolve_plugin_provider: async () => { throw new Error("resolve_plugin_provider must not be called for a v4 workspace."); },
        resolve_workspace_scan_transport: async (workspace) => {
          let transport = sessions.get(workspace.workspace_id);
          if (transport === undefined) {
            transport = createIndexingCoreProcessTransport({ command: workerPath!, request_timeout_ms: 120_000 });
            sessions.set(workspace.workspace_id, transport);
          }
          return transport;
        },
        semantic_index: false,
        reconciliation_sweep_interval_ms: 0,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
      });
      const client = new DaemonClient(runtime.endpoint, DAEMON_CLIENT_OPTIONS);
      const added = await client.call("core:workspace_add", { args: [workspaceRoot], confirmed: true });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      await pollUntilStructuralReady(client, workspaceId);

      // --- module container: errors.ts must carry both a "call" site
      // (the constructors' `super(...)`) and an "inherits" site
      // (`extends Error`), both unresolved (`Error` is a global type this
      // checker-free cold pipeline cannot see -- confirmed live in
      // `tests/v4-daemon-e2e.test.ts`'s v3/v4 comparison for this exact
      // fixture). ---
      const errorsPending = await queryOneStream(client, workspaceId, "core:get_outline", { container: { subject_type: "artifact", path: "errors.ts" } }, "pending_sites");
      expect(errorsPending.length).toBeGreaterThan(0);
      for (const item of errorsPending) {
        expect(item["path"]).toBe("errors.ts");
        expect(KNOWN_SITE_KINDS.has(item["site_kind"] as string)).toBe(true);
        expect(KNOWN_REASONS.has(item["reason"] as string)).toBe(true);
        expect(typeof item["start"]).toBe("number");
        expect(typeof item["end"]).toBe("number");
        expect((item["end"] as number)).toBeGreaterThan(item["start"] as number);
      }
      expect(new Set(errorsPending.map((item) => item["site_kind"]))).toEqual(new Set(["call", "inherits"]));

      // At least one site's `source_id` resolves to a real entity via
      // `core:find_records` (this task's own e2e requirement).
      const sourceIds = errorsPending.map((item) => item["source_id"]).filter((id): id is string => typeof id === "string");
      expect(sourceIds.length).toBeGreaterThan(0);
      const entities = await queryOneStream(client, workspaceId, "core:find_records", { selector: { record_categories: ["entity"] } }, "records");
      const entityIdentityKeys = new Set(entities.map((record) => record["identity_key"]).filter((key): key is string => typeof key === "string"));
      expect(sourceIds.some((id) => entityIdentityKeys.has(id))).toBe(true);

      // --- negative control: task.ts has only type/interface
      // declarations, no calls and no heritage clauses. ---
      const taskPending = await queryOneStream(client, workspaceId, "core:get_outline", { container: { subject_type: "artifact", path: "task.ts" } }, "pending_sites");
      expect(taskPending).toEqual([]);

      // --- entity container: narrow to ONE of errors.ts's two classes
      // and confirm only ITS sites (not the other class's) come back. ---
      const resolvedStreams = await queryStreams(client, workspaceId, "core:resolve_symbol", { reference: "InvalidTaskTransitionError", resolution_scope: "exports" });
      const declarations = (resolvedStreams["declarations"]?.items ?? []).map((item) => item.value as Record<string, unknown>);
      expect(declarations.length).toBeGreaterThan(0);
      expect(recordName(declarations[0]!)).toBe("InvalidTaskTransitionError");
      const entityId = declarations[0]!["entity_id"];
      expect(typeof entityId).toBe("string");

      const classPending = await queryOneStream(client, workspaceId, "core:get_outline", { container: { subject_type: "entity", entity_id: entityId } }, "pending_sites");
      expect(classPending.length).toBeGreaterThan(0);
      expect(classPending.length).toBeLessThan(errorsPending.length);
      const errorsKeySet = new Set(errorsPending.map((item) => `${item["start"]}\0${item["end"]}\0${item["site_kind"]}`));
      for (const item of classPending) {
        expect(item["path"]).toBe("errors.ts");
        expect(errorsKeySet.has(`${item["start"]}\0${item["end"]}\0${item["site_kind"]}`)).toBe(true);
      }
    } finally {
      process.env["URDIRA_V4"] = "0";
      for (const transport of sessions.values()) {
        await transport.shutdown().catch(() => undefined);
        await transport.terminate().catch(() => undefined);
      }
      await runtime?.stop().catch(() => undefined);
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 180_000);

  it("returns an empty pending_sites stream (never an error) for a v3 (SQLite-only) workspace", async () => {
    process.env["URDIRA_V4"] = "0";
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-v3-pending-sites-data-"));
    const workspaceRoot = await seedFixtureWorkspace();
    let runtime: DaemonRuntime | undefined;
    try {
      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-v3-pending-sites-query",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        plugin_catalog: [{ ...bundledPluginCatalogEntry, capability_declarations: JAVASCRIPT_TYPESCRIPT_CAPABILITIES }],
        resolve_plugin_provider: resolveV3PluginProvider,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
      });
      const client = new DaemonClient(runtime.endpoint, DAEMON_CLIENT_OPTIONS);
      const added = await client.call("core:workspace_add", {
        args: [workspaceRoot], confirmed: true,
        selected_technology_ids: ["typescript"], selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      await pollUntilReady(client, workspaceId);

      const streams = await queryStreams(client, workspaceId, "core:get_outline", { container: { subject_type: "artifact", path: "errors.ts" } });
      expect(streams["pending_sites"]).toBeDefined();
      expect(streams["pending_sites"]!.items).toEqual([]);
    } finally {
      process.env["URDIRA_V4"] = "0";
      await runtime?.stop().catch(() => undefined);
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
