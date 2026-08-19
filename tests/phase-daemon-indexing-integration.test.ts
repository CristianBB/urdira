import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
// `@urdira/engine`, `@urdira/plugin-javascript-typescript`, and `@urdira/daemon`
// are not root-level `devDependencies` (only `@urdira/contracts`,
// `@urdira/canonical`, `@urdira/plugin-sdk`, and `@urdira/security` are), so
// this file imports them from `src` by relative path, like every other
// `tests/*.test.ts` file that touches those packages. `DaemonRuntime` in
// particular is imported from source (not a bare specifier) so this test
// exercises the actual edits made in this change.
import {
  candidateTargetRegistryFromSnapshot,
  createCanonicalPluginDigestAuthority,
  createLocalHashProvider,
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
import { DaemonClient, DaemonRuntime, type DaemonRuntimeOptions } from "../packages/daemon/src/index.js";
import { createDurableStorage } from "../packages/storage/src/index.js";

// `packages/daemon/src/runtime.ts` types `DaemonRuntimeOptions.workspace_registry`
// against `@urdira/engine`'s published (dist) `WorkspaceRegistry` declaration
// (its own real workspace dependency), which is nominally distinct from this
// file's `src` declaration of the same class within `tsconfig.tests.json`'s
// combined program -- the same private-field-branding situation documented in
// `tests/phase-workspace-indexing-session.test.ts` and
// `tests/phase-indexing-port.test.ts` for `WorkspaceDatabase`. Per-package
// builds (what `apps/urdira`/`packages/daemon` actually run) don't hit this.
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

async function prepareRegistry(workspaceId: string): Promise<PreparedRegistry> {
  const digests = createCanonicalPluginDigestAuthority();
  const encoder = new TextEncoder();
  const assets = [
    { normalized_relative_path: "dist/worker.mjs", bytes: encoder.encode("urdira daemon-indexing-integration jsts worker"), executable: true, role: "parser" as const },
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
    // Real analysis: this calls the compiled `@urdira/plugin-javascript-typescript`
    // worker's real `.invoke("analyze_artifact", ...)`, exactly like production
    // wiring in `apps/urdira/src/index.ts` does -- this is not a stub.
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

// Mirrors the design in `apps/urdira/src/index.ts`'s `resolve_plugin_provider`:
// only workspaces that activated the JavaScript/TypeScript plugin get a
// provider; everyone else is `undefined` (no compatible plugin).
const resolvePluginProvider: NonNullable<DaemonRuntimeOptions["resolve_plugin_provider"]> = async (workspace) => {
  if (!(workspace.selected_plugin_ids ?? []).includes(JAVASCRIPT_TYPESCRIPT_PLUGIN_ID)) return undefined;
  const prepared = await prepareRegistry(workspace.workspace_id);
  const registrySnapshotId = prepared.registry.registry_snapshot_id;
  const configurationRevisionId = `configuration:${workspace.workspace_id}`;
  return buildPluginProvider(prepared, workspace.workspace_id, registrySnapshotId, configurationRevisionId);
};

// A loaded machine (all 5 heavy integration files running concurrently, no
// `fileParallelism` isolation) can turn one slow-but-correct RPC into a
// spurious `core:ipc_timeout` well before the operation itself would ever
// fail -- the daemon-side default 30s (`packages/daemon/src/protocol.ts`)
// is sized for an unloaded machine. `pollUntilReady`/`pollForLexicalPushdownMatch`/
// `pollUntilSemanticGenerationCurrent`'s own deadlines below are the real
// backstops for something genuinely stuck.
const DAEMON_CLIENT_OPTIONS = { request_timeout_ms: 120_000 };

async function pollUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition did not become true within ${timeoutMs} ms.`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

async function pollUntilReady(client: DaemonClient, workspaceId: string, timeoutMs = 120_000): Promise<{ readonly workspace_status: string; readonly current_snapshot_id?: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: { readonly workspace_id: string; readonly workspace_status: string } | undefined;
  while (Date.now() < deadline) {
    // With an empty `workspace_ids` list, `core:index_status` returns every
    // registered workspace's status directly (including "indexing"), unlike
    // the single-workspace-id form used below, which -- by design -- rejects
    // non-ready/degraded workspaces with `core:index_unavailable`.
    const response = await client.call("core:index_status", {});
    if (response.outcome !== "success") throw new Error(`core:index_status did not succeed: ${JSON.stringify(response)}`);
    const payload = response.payload as { readonly workspaces: ReadonlyArray<{ readonly workspace_id: string; readonly workspace_status: string }> };
    const workspace = payload.workspaces.find((entry) => entry.workspace_id === workspaceId);
    if (workspace === undefined) throw new Error(`core:index_status did not report workspace ${workspaceId}.`);
    last = workspace;
    if (workspace.workspace_status === "ready" || workspace.workspace_status === "degraded") {
      // Now fetch the full single-workspace detail, which includes
      // `current_snapshot_id` (only available once queryable).
      const detail = await client.call("core:index_status", { workspace_ids: [workspaceId] });
      if (detail.outcome !== "success") {
        // A periodic reconciliation sweep can begin after the all-workspaces
        // status read and before this detail read. The detail contract then
        // correctly reports the transient workspace as unavailable, so retry
        // the pair of reads instead of turning a valid state transition into
        // a flaky test failure.
        if (detail.error?.code === "core:index_unavailable") {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
          continue;
        }
        throw new Error(`core:index_status (detail) did not succeed: ${JSON.stringify(detail)}`);
      }
      const detailPayload = detail.payload as { readonly workspaces: ReadonlyArray<{ readonly workspace_status: string; readonly current_snapshot_id?: string }> };
      const detailWorkspace = detailPayload.workspaces[0];
      if (detailWorkspace === undefined) throw new Error("core:index_status (detail) returned no workspace entry.");
      return detailWorkspace;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Workspace ${workspaceId} did not leave "indexing" within ${timeoutMs}ms (last observed: ${JSON.stringify(last)}).`);
}

describe("Daemon workspace indexing integration: core:workspace_add reaches status: ready", () => {
  it("scans a real directory end to end through the daemon's public IPC surface, with no manual candidate choreography", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-indexing-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-indexing-workspace-"));
    let runtime: DaemonRuntime | undefined;
    try {
      // Seed the workspace with two real, self-contained `.ts` files copied
      // from the task-planner fixture (no imports between them beyond their
      // own file, so a minimal directory scan is sufficient).
      await mkdir(workspaceRoot, { recursive: true });
      for (const file of ["task.ts", "errors.ts"]) {
        await writeFile(join(workspaceRoot, file), await readFile(join(fixtureRoot, file), "utf8"), "utf8");
      }

      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-daemon-indexing-integration",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        plugin_catalog: [{ ...bundledPluginCatalogEntry, capability_declarations: JAVASCRIPT_TYPESCRIPT_CAPABILITIES }],
        resolve_plugin_provider: resolvePluginProvider,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
      });
      const client = new DaemonClient(runtime.endpoint, DAEMON_CLIENT_OPTIONS);

      const added = await client.call("core:workspace_add", {
        args: [workspaceRoot],
        confirmed: true,
        selected_technology_ids: ["typescript"],
        selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      });
      expect(added.outcome).toBe("success");
      const addedPayload = added.payload as { readonly workspace_id: string; readonly status: string; readonly registered: boolean };
      expect(addedPayload.registered).toBe(true);
      // The IPC handler returns promptly with "indexing"; the scan itself
      // completes asynchronously in the background. This is the direct
      // regression check for the original symptom: without this change's
      // wiring, no workspace could ever leave "indexing".
      expect(addedPayload.status).toBe("indexing");

      const settled = await pollUntilReady(client, addedPayload.workspace_id);
      expect(settled.workspace_status).toBe("ready");
      expect(settled.current_snapshot_id).toBeTypeOf("string");
      expect(settled.current_snapshot_id?.length).toBeGreaterThan(0);
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 120_000);

  // Regression coverage for a second, equally severe symptom of the same
  // underlying bug class as the test above: even once a workspace reaches
  // "ready", `core:query` and `core:query_continue` were never registered as
  // daemon calls (every call -- from the CLI's `query` command and from
  // every MCP tool -- failed with `core:unknown_call`), so indexed data
  // could never actually be read back. This exercises the real daemon IPC
  // surface end to end: a real `core:query` against a real published
  // snapshot, followed by real `core:query_continue` cursor round-trips
  // until the result stream is exhausted.
  it("answers core:query and core:query_continue for a ready workspace through the daemon's public IPC surface", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-query-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-query-workspace-"));
    let runtime: DaemonRuntime | undefined;
    try {
      // Same two self-contained fixture files as the indexing test above:
      // `errors.ts` declares classes `TaskNotFoundError` and
      // `InvalidTaskTransitionError`; `task.ts` declares interfaces `Task`
      // and `CreateTaskInput` plus the `TaskStatus` type alias.
      await mkdir(workspaceRoot, { recursive: true });
      for (const file of ["task.ts", "errors.ts"]) {
        await writeFile(join(workspaceRoot, file), await readFile(join(fixtureRoot, file), "utf8"), "utf8");
      }

      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-daemon-query-integration",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        plugin_catalog: [{ ...bundledPluginCatalogEntry, capability_declarations: JAVASCRIPT_TYPESCRIPT_CAPABILITIES }],
        resolve_plugin_provider: resolvePluginProvider,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
      });
      const client = new DaemonClient(runtime.endpoint, DAEMON_CLIENT_OPTIONS);

      const added = await client.call("core:workspace_add", {
        args: [workspaceRoot],
        confirmed: true,
        selected_technology_ids: ["typescript"],
        selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      const settled = await pollUntilReady(client, workspaceId);
      expect(settled.workspace_status).toBe("ready");

      const queryOptions = {
        freshness: "current",
        wait_timeout_ms: 0,
        coverage_requirement: "accept_reported",
        evidence: { evidence: "summary", evidence_chain_depth: 1 },
        diagnostics: { diagnostics: "relevant", diagnostic_detail: true },
        snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 },
        registry: { registry: "used", include_payload_schemas: false },
        // `max_items: 1` deliberately forces the two (or more) matching
        // `core:type` declarations across a real `core:query_continue`
        // pagination boundary instead of fitting in one page.
        response_budget: { max_items: 1, max_characters: 1_000_000 },
      };

      const first = await client.call("core:query", {
        api_version: 1,
        scope: { scope_type: "single_workspace", workspace_id: workspaceId },
        expression: {
          expression_type: "operation",
          operation: "core:find_records",
          arguments: { selector: { record_categories: ["entity"], kind_selector: { universal_kinds: ["core:type"] }, filter: { languages: ["typescript"] } } },
        },
        options: queryOptions,
      });
      expect(first.outcome).toBe("success");
      type StreamPage = { readonly items: ReadonlyArray<{ readonly value: unknown }>; readonly next_cursor?: string; readonly has_next: boolean };
      const firstPayload = first.payload as { readonly streams: Readonly<Record<string, StreamPage>> };
      const recordsStream = firstPayload.streams["records"];
      expect(recordsStream).toBeDefined();
      expect(recordsStream!.items.length).toBe(1);
      // With a real `max_items: 1` budget and multiple real declarations
      // indexed from the two fixture files, this page must not be the last.
      expect(recordsStream!.has_next).toBe(true);
      expect(recordsStream!.next_cursor).toBeTypeOf("string");

      const bodyName = (entry: { readonly value: unknown }): string => String((entry.value as { readonly body: Readonly<Record<string, unknown>> }).body["name"]);
      const names = [bodyName(recordsStream!.items[0]!)];
      let cursor = recordsStream!.next_cursor!;
      let hasNext = true;
      let continuations = 0;
      while (hasNext) {
        const continued = await client.call("core:query_continue", {
          api_version: 1,
          scope: { scope_type: "single_workspace", workspace_id: workspaceId },
          cursor,
          response_budget: { max_items: 1, max_characters: 1_000_000 },
        });
        expect(continued.outcome).toBe("success");
        const continuedPayload = continued.payload as { readonly streams: Readonly<Record<string, StreamPage>> };
        const page = continuedPayload.streams["records"];
        expect(page).toBeDefined();
        for (const entry of page!.items) names.push(bodyName(entry));
        hasNext = page!.has_next;
        if (hasNext) cursor = page!.next_cursor!;
        continuations += 1;
        if (continuations > 20) throw new Error("core:query_continue did not terminate within a reasonable number of pages.");
      }
      // At least one real `core:query_continue` round-trip happened (the
      // direct regression check: before this change, this whole test failed
      // at the very first `core:query` call with `core:unknown_call`).
      expect(continuations).toBeGreaterThan(0);
      expect(names).toEqual(expect.arrayContaining(["TaskNotFoundError", "InvalidTaskTransitionError"]));

      const resolved = await client.call("core:query", {
        api_version: 1,
        scope: { scope_type: "single_workspace", workspace_id: workspaceId },
        expression: { expression_type: "operation", operation: "core:resolve_symbol", arguments: { reference: "InvalidTaskTransitionError", resolution_scope: "exports" } },
        options: { ...queryOptions, response_budget: { max_items: 1_000, max_characters: 1_000_000 } },
      });
      expect(resolved.outcome).toBe("success");
      const resolvedPayload = resolved.payload as { readonly streams: Readonly<Record<string, StreamPage>> };
      const declaration = resolvedPayload.streams["declarations"]?.items[0];
      expect(declaration).toBeDefined();
      expect(bodyName(declaration!)).toBe("InvalidTaskTransitionError");
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 120_000);
});

// Regression coverage for the "silently wedged daemon" incident (see
// `DaemonRuntimeOptions.reconciliation_sweep_interval_ms`'s doc comment,
// `packages/daemon/src/runtime.ts`): a running daemon whose watcher (or a
// prior scan) silently stops making progress must still eventually
// re-attempt reconciliation on its own, without any external trigger (a file
// edit, an explicit `core:reindex`, or a daemon restart). This drives a real
// `DaemonRuntime` with a very short sweep interval and confirms the sweep
// re-invokes the real scan pipeline (`resolve_plugin_provider`, and thus
// `runFullWorkspaceScan`) periodically for a `ready` workspace even though
// NOTHING on disk changes and NO watcher event ever fires -- the only thing
// that can be driving those extra scan attempts is the timer. Each of those
// extra scans is expected to be cheap and a no-op (the workspace stays
// `ready`, thanks to `runFullWorkspaceScan`'s `equivalent` short-circuit --
// this test is deliberately about the SCHEDULING wiring, not the
// content-divergence detection itself, which `tests/phase-workspace-indexing-session.test.ts`'s
// "publishes the real disk content on the next scan after a crash leaves
// stage-1 cataloging ahead of the last published generation" already covers
// end to end).
describe("Daemon periodic reconciliation sweep (Bug B backstop)", () => {
  it("re-triggers the real scan pipeline for a ready workspace on a timer, with no disk change and no watcher event", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-sweep-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-sweep-workspace-"));
    let runtime: DaemonRuntime | undefined;
    try {
      await mkdir(workspaceRoot, { recursive: true });
      for (const file of ["task.ts", "errors.ts"]) {
        await writeFile(join(workspaceRoot, file), await readFile(join(fixtureRoot, file), "utf8"), "utf8");
      }

      const resolveCalls: string[] = [];
      const countingResolvePluginProvider: NonNullable<DaemonRuntimeOptions["resolve_plugin_provider"]> = async (workspace, database) => {
        resolveCalls.push(workspace.workspace_id);
        return resolvePluginProvider(workspace, database);
      };

      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-daemon-sweep-integration",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        plugin_catalog: [{ ...bundledPluginCatalogEntry, capability_declarations: JAVASCRIPT_TYPESCRIPT_CAPABILITIES }],
        resolve_plugin_provider: countingResolvePluginProvider,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
        // Short enough that several ticks land comfortably within the test's
        // own timeout on an unloaded machine, long enough that each tick's
        // scan (an `equivalent` no-op here) has time to fully settle before
        // the next one fires.
        reconciliation_sweep_interval_ms: 150,
      });
      const client = new DaemonClient(runtime.endpoint, DAEMON_CLIENT_OPTIONS);

      const added = await client.call("core:workspace_add", {
        args: [workspaceRoot],
        confirmed: true,
        selected_technology_ids: ["typescript"],
        selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      const settled = await pollUntilReady(client, workspaceId);
      expect(settled.workspace_status).toBe("ready");
      const callsAtReady = resolveCalls.length;
      expect(callsAtReady).toBeGreaterThan(0);

      // Wait for a completed sweep instead of assuming a loaded CI host will
      // schedule one within a fixed wall-clock delay.
      await pollUntil(() => resolveCalls.length > callsAtReady, process.platform === "win32" ? 30_000 : 10_000);
      expect(resolveCalls.length).toBeGreaterThan(callsAtReady);
      // Every sweep-triggered scan was a genuine no-op: the workspace
      // settles back to `ready` (possibly caught mid-sweep as transiently
      // "indexing", hence polling again rather than a single snapshot read),
      // and its published generation never actually changed (nothing on
      // disk did).
      const final = await pollUntilReady(client, workspaceId);
      expect(final.workspace_status).toBe("ready");
      expect(final.current_snapshot_id).toBe(settled.current_snapshot_id);
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 120_000);
});

// D5: post-ready lexical maintenance wiring (`packages/daemon/src/runtime.ts`'s
// `submitLexicalMaintenance`, submitted right after `registry.markReady` on
// scan success) and D6: `core:search_text` pushdown activating once it
// completes. `"cannot transition from"` is a substring of `errors.ts`'s
// template-literal error message (see the fixture below) -- it appears
// nowhere in any record's body (names, kinds, signatures), so a match only
// surfaces once real FILE TEXT is searched, which is only possible via the
// lexical pushdown this wiring builds; the corpus-scan fallback (matching
// record bodies) could never find it. Maintenance runs asynchronously after
// the scan settles, so this polls `core:search_text` until a match carrying
// `source_span` appears (or times out).
describe("Daemon post-ready lexical maintenance (D5) and core:search_text pushdown (D6)", () => {
  const queryOptions = {
    freshness: "current",
    wait_timeout_ms: 0,
    coverage_requirement: "accept_reported",
    evidence: { evidence: "summary", evidence_chain_depth: 1 },
    diagnostics: { diagnostics: "relevant", diagnostic_detail: false },
    snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 },
    registry: { registry: "used", include_payload_schemas: false },
    response_budget: { max_items: 100, max_characters: 1_000_000 },
  };

  async function pollForLexicalPushdownMatch(client: DaemonClient, workspaceId: string, timeoutMs = 60_000): Promise<Readonly<Record<string, unknown>>> {
    const deadline = Date.now() + timeoutMs;
    let lastItemCount = -1;
    while (Date.now() < deadline) {
      const response = await client.call("core:query", {
        api_version: 1,
        scope: { scope_type: "single_workspace", workspace_id: workspaceId },
        expression: { expression_type: "operation", operation: "core:search_text", arguments: { pattern: "cannot transition from", syntax: "literal" } },
        options: queryOptions,
      });
      if (response.outcome !== "success") throw new Error(`core:query (core:search_text) did not succeed: ${JSON.stringify(response)}`);
      type StreamPage = { readonly items: ReadonlyArray<{ readonly value: Readonly<Record<string, unknown>> }> };
      const payload = response.payload as { readonly streams: Readonly<Record<string, StreamPage>> };
      const items = payload.streams["matches"]?.items ?? [];
      lastItemCount = items.length;
      const withSpan = items.find((entry) => typeof entry.value["source_span"] === "object" && entry.value["source_span"] !== null);
      if (withSpan) return withSpan.value;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(`core:search_text never produced a source_span-carrying (lexical-pushdown) match within ${timeoutMs}ms (last poll saw ${lastItemCount} match item(s)).`);
  }

  it("submits lexical maintenance after a successful scan, and core:search_text answers real file-text matches once it completes", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-lexical-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-lexical-workspace-"));
    let runtime: DaemonRuntime | undefined;
    try {
      await mkdir(workspaceRoot, { recursive: true });
      for (const file of ["task.ts", "errors.ts"]) {
        await writeFile(join(workspaceRoot, file), await readFile(join(fixtureRoot, file), "utf8"), "utf8");
      }

      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-daemon-lexical-integration",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        plugin_catalog: [{ ...bundledPluginCatalogEntry, capability_declarations: JAVASCRIPT_TYPESCRIPT_CAPABILITIES }],
        resolve_plugin_provider: resolvePluginProvider,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
        // Left at its default (ON) deliberately -- this test is the
        // regression check for that default, not an opt-in.
      });
      const client = new DaemonClient(runtime.endpoint, DAEMON_CLIENT_OPTIONS);

      const added = await client.call("core:workspace_add", {
        args: [workspaceRoot],
        confirmed: true,
        selected_technology_ids: ["typescript"],
        selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      const settled = await pollUntilReady(client, workspaceId);
      expect(settled.workspace_status).toBe("ready");

      // Before maintenance completes (or if it were disabled), `core:search_text`
      // falls back to the corpus scan, which cannot see this pattern at all --
      // this poll only ever succeeds once the lexical pushdown wiring genuinely
      // ran end to end.
      const match = await pollForLexicalPushdownMatch(client, workspaceId);
      const span = match["source_span"] as { readonly artifact_version_id: string; readonly start_byte: string; readonly end_byte: string };
      expect(span.artifact_version_id).toBeTypeOf("string");
      expect(Number(span.end_byte)).toBeGreaterThan(Number(span.start_byte));
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("URDIRA_LEXICAL_INDEX kill switch (DaemonRuntimeOptions.lexical_index: false) leaves core:search_text on the corpus-scan fallback forever", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-lexical-off-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-lexical-off-workspace-"));
    let runtime: DaemonRuntime | undefined;
    try {
      await mkdir(workspaceRoot, { recursive: true });
      for (const file of ["task.ts", "errors.ts"]) {
        await writeFile(join(workspaceRoot, file), await readFile(join(fixtureRoot, file), "utf8"), "utf8");
      }

      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-daemon-lexical-off-integration",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        plugin_catalog: [{ ...bundledPluginCatalogEntry, capability_declarations: JAVASCRIPT_TYPESCRIPT_CAPABILITIES }],
        resolve_plugin_provider: resolvePluginProvider,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
        lexical_index: false,
      });
      const client = new DaemonClient(runtime.endpoint, DAEMON_CLIENT_OPTIONS);

      const added = await client.call("core:workspace_add", {
        args: [workspaceRoot],
        confirmed: true,
        selected_technology_ids: ["typescript"],
        selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      });
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      const settled = await pollUntilReady(client, workspaceId);
      expect(settled.workspace_status).toBe("ready");

      // No sleep needed here (was a fixed 500ms guess at how long to wait
      // before checking nothing got submitted): `submitLexicalMaintenance`
      // (`packages/daemon/src/runtime.ts`) is a plain synchronous function
      // called directly after `registry.markReady`, with no `await` between
      // them -- when `lexical_index: false`, it returns immediately without
      // ever reaching `scheduler.submit`. Node's run-to-completion semantics
      // mean no other JS (including the RPC handling that could ever let
      // `pollUntilReady` above observe `workspace_status: "ready"`) can
      // interleave between `markReady` and that synchronous kill-switch
      // check, so by the time this test sees "ready" over the IPC socket,
      // the decision not to submit lexical maintenance for this scan has
      // already been made and is final -- there is no async job left in
      // flight to race against.
      const response = await client.call("core:query", {
        api_version: 1,
        scope: { scope_type: "single_workspace", workspace_id: workspaceId },
        expression: { expression_type: "operation", operation: "core:search_text", arguments: { pattern: "cannot transition from", syntax: "literal" } },
        options: queryOptions,
      });
      expect(response.outcome).toBe("success");
      type StreamPage = { readonly items: ReadonlyArray<{ readonly value: unknown }> };
      const payload = response.payload as { readonly streams: Readonly<Record<string, StreamPage>> };
      expect(payload.streams["matches"]?.items ?? []).toEqual([]);
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 120_000);

  // `DaemonRuntimeOptions.lexical_thread: false` (the `URDIRA_LEXICAL_THREAD`
  // kill switch's equivalent) forces the prior in-process `reconcileLexicalProjection`
  // call path instead of the `node:worker_threads`-backed one -- see
  // `submitLexicalMaintenance` in `packages/daemon/src/runtime.ts`. Unlike the
  // `lexical_index: false` test above (which proves the corpus-scan fallback
  // stays in permanent effect), this proves the OPPOSITE: with the thread
  // disabled but the job itself still enabled, `core:search_text` pushdown
  // must still activate exactly as it does on the (thread-enabled) default
  // path above.
  it("URDIRA_LEXICAL_THREAD kill switch (DaemonRuntimeOptions.lexical_thread: false) still builds the lexical index via the in-process path", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-lexical-nothread-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-lexical-nothread-workspace-"));
    let runtime: DaemonRuntime | undefined;
    try {
      await mkdir(workspaceRoot, { recursive: true });
      for (const file of ["task.ts", "errors.ts"]) {
        await writeFile(join(workspaceRoot, file), await readFile(join(fixtureRoot, file), "utf8"), "utf8");
      }

      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-daemon-lexical-nothread-integration",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        plugin_catalog: [{ ...bundledPluginCatalogEntry, capability_declarations: JAVASCRIPT_TYPESCRIPT_CAPABILITIES }],
        resolve_plugin_provider: resolvePluginProvider,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
        lexical_thread: false,
      });
      const client = new DaemonClient(runtime.endpoint, DAEMON_CLIENT_OPTIONS);

      const added = await client.call("core:workspace_add", {
        args: [workspaceRoot],
        confirmed: true,
        selected_technology_ids: ["typescript"],
        selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      const settled = await pollUntilReady(client, workspaceId);
      expect(settled.workspace_status).toBe("ready");

      const match = await pollForLexicalPushdownMatch(client, workspaceId);
      const span = match["source_span"] as { readonly artifact_version_id: string; readonly start_byte: string; readonly end_byte: string };
      expect(span.artifact_version_id).toBeTypeOf("string");
      expect(Number(span.end_byte)).toBeGreaterThan(Number(span.start_byte));
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 120_000);
});

// D-slice: post-ready semantic maintenance wiring
// (`packages/daemon/src/runtime.ts`'s `submitSemanticMaintenance`, submitted
// right after `registry.markReady` on scan success, mirroring D5's
// `submitLexicalMaintenance` one layer over) and `core:search_semantic`/
// `core:search_hybrid` activating once it completes, plus `core:index_status`
// serving a non-empty `semantic_materializations` entry. `"CreateTaskInput"`
// is an identifier that exists in exactly ONE fixture file (`task.ts`) --
// `errors.ts` never mentions "input" or "create" at all -- so a candidate
// naming `task.ts` only surfaces once real vectors have been embedded and
// scanned, never as an accident of the (identical, both-files) corpus-scan
// fallback the other two operations have and these two do not.
describe("Daemon post-ready semantic maintenance (D-slice) and core:search_semantic/core:search_hybrid pushdown", () => {
  const queryOptions = {
    freshness: "current",
    wait_timeout_ms: 0,
    coverage_requirement: "accept_reported",
    evidence: { evidence: "summary", evidence_chain_depth: 1 },
    diagnostics: { diagnostics: "relevant", diagnostic_detail: false },
    snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 },
    registry: { registry: "used", include_payload_schemas: false },
    response_budget: { max_items: 100, max_characters: 1_000_000 },
  };

  type StreamPage = { readonly items: ReadonlyArray<{ readonly value: Readonly<Record<string, unknown>> }> };
  function candidatePath(entry: { readonly value: Readonly<Record<string, unknown>> }): string {
    const body = entry.value["body"] as Readonly<Record<string, unknown>> | undefined;
    return String(body?.["path"] ?? "");
  }

  // Directly polls the workspace's own SQLite database for
  // `semantic_index_state.completed_generation` (via a SECOND, independent
  // `createDurableStorage` handle over the SAME `dataRoot` the daemon under
  // test already uses -- safe because `openWorkspace` only requires the
  // workspace already present in the shared on-disk installation catalog,
  // which the daemon's own scan already wrote, and SQLite's WAL mode
  // tolerates a second reader connection fine) until it reaches the
  // workspace's CURRENT generation -- the same completeness condition
  // `reconcileSemanticProjection`'s own fast path checks, and the most
  // direct way to know the async maintenance pass genuinely finished rather
  // than inferring it indirectly from a query response shape.
  async function pollUntilSemanticGenerationCurrent(dataRoot: string, workspaceId: string, timeoutMs = 120_000): Promise<void> {
    const pollStorage = await createDurableStorage({ rootDir: dataRoot });
    try {
      // Open the workspace database ONCE, outside the poll loop, instead of
      // on every iteration: re-opening a `DurableStorage`/`WorkspaceDatabase`
      // handle is itself real I/O that competes with the daemon's own
      // maintenance job for CPU/disk under a loaded machine, so polling this
      // way was adding load to the very thing it was waiting on. A single
      // `.get(...)`/`.projections.semanticIndexState()` call is a plain
      // autocommit read against SQLite's WAL file, so it still observes the
      // daemon's latest committed writes on every iteration.
      const database = await pollStorage.openWorkspace(workspaceId);
      try {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const currentRow = await database.database.get<{ readonly current_generation: number }>("SELECT current_generation FROM workspace_current_state WHERE workspace_id = ?", [workspaceId]);
          const state = await database.projections.semanticIndexState();
          if (currentRow !== undefined && state !== undefined && state.completed_generation === currentRow.current_generation) return;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        }
        throw new Error(`semantic_index_state never caught up to the current generation for workspace ${workspaceId} within ${timeoutMs}ms.`);
      } finally {
        await database.close().catch(() => undefined);
      }
    } finally {
      await pollStorage.close().catch(() => undefined);
    }
  }

  it("submits semantic maintenance after a successful scan, and core:search_semantic/core:search_hybrid answer real candidates once it completes", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-semantic-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-semantic-workspace-"));
    let runtime: DaemonRuntime | undefined;
    try {
      await mkdir(workspaceRoot, { recursive: true });
      for (const file of ["task.ts", "errors.ts"]) {
        await writeFile(join(workspaceRoot, file), await readFile(join(fixtureRoot, file), "utf8"), "utf8");
      }

      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-daemon-semantic-integration",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        plugin_catalog: [{ ...bundledPluginCatalogEntry, capability_declarations: JAVASCRIPT_TYPESCRIPT_CAPABILITIES }],
        resolve_plugin_provider: resolvePluginProvider,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
        // Left at its default (ON) deliberately -- this test is the
        // regression check for that default (`DaemonRuntimeOptions.semantic_index`
        // omitted, and no `semantic_provider` injected, so `DaemonRuntime.start`
        // constructs its own `createLocalHashProvider()`), not an opt-in.
      });
      const client = new DaemonClient(runtime.endpoint, DAEMON_CLIENT_OPTIONS);

      const added = await client.call("core:workspace_add", {
        args: [workspaceRoot],
        confirmed: true,
        selected_technology_ids: ["typescript"],
        selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      const settled = await pollUntilReady(client, workspaceId);
      expect(settled.workspace_status).toBe("ready");

      // Before semantic maintenance completes, `core:search_semantic` would
      // throw `core:semantic_index_unavailable` -- this poll only returns
      // once the async pass genuinely finished for this scan's generation.
      await pollUntilSemanticGenerationCurrent(dataRoot, workspaceId);

      const semanticResponse = await client.call("core:query", {
        api_version: 1,
        scope: { scope_type: "single_workspace", workspace_id: workspaceId },
        expression: { expression_type: "operation", operation: "core:search_semantic", arguments: { query_text: "CreateTaskInput", query_class: "identifier" } },
        options: queryOptions,
      });
      expect(semanticResponse.outcome).toBe("success");
      const semanticPayload = semanticResponse.payload as { readonly streams: Readonly<Record<string, StreamPage>> };
      const semanticCandidates = semanticPayload.streams["candidates"]?.items ?? [];
      expect(semanticCandidates.length).toBeGreaterThan(0);
      expect(semanticCandidates.every((entry) => entry.value["classification"] === "possible")).toBe(true);
      expect(semanticCandidates.some((entry) => candidatePath(entry).includes("task.ts"))).toBe(true);
      const semanticCoverage = semanticPayload.streams["semantic_coverage"]?.items ?? [];
      expect(semanticCoverage.length).toBe(1);
      expect((semanticCoverage[0]!.value as { readonly materialization_state: string }).materialization_state).toBe("complete");

      const hybridResponse = await client.call("core:query", {
        api_version: 1,
        scope: { scope_type: "single_workspace", workspace_id: workspaceId },
        expression: { expression_type: "operation", operation: "core:search_hybrid", arguments: { query_text: "CreateTaskInput", query_class: "identifier" } },
        options: queryOptions,
      });
      expect(hybridResponse.outcome).toBe("success");
      const hybridPayload = hybridResponse.payload as { readonly streams: Readonly<Record<string, StreamPage>> };
      const hybridCandidates = hybridPayload.streams["candidates"]?.items ?? [];
      expect(hybridCandidates.length).toBeGreaterThan(0);

      const statusResponse = await client.call("core:index_status", { workspace_ids: [workspaceId] });
      expect(statusResponse.outcome).toBe("success");
      type MaterializationView = { readonly coverage_status: string; readonly materialization_state: string };
      const statusPayload = statusResponse.payload as { readonly workspaces: ReadonlyArray<{ readonly semantic_materializations: ReadonlyArray<MaterializationView> }> };
      const materializations = statusPayload.workspaces[0]?.semantic_materializations ?? [];
      expect(materializations.length).toBeGreaterThan(0);
      expect(materializations[0]!.coverage_status).toBe("complete");
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 120_000);

  // Semantic worker thread (`packages/daemon/src/semantic-thread.ts`,
  // `submitSemanticMaintenance`'s `semanticThreadEligible` routing in
  // `runtime.ts`): UNLIKE the test above (which leaves `semantic_index`/
  // `semantic_descriptor` both at their defaults -- no descriptor at all, so
  // `submitSemanticMaintenance` always stays in-process regardless of
  // `semantic_thread`, per its own doc comment -- this test supplies an
  // explicit `semantic_descriptor: { kind: "hash" }` with no `semantic_provider`
  // instance override and no `semantic_runtime_hooks`, which is exactly the
  // combination that makes the threaded path eligible. `semantic_thread`
  // itself is left at its default (ON): this is the regression check for
  // that default, not an opt-in. The assertions mirror the in-process test
  // above exactly (poll `semantic_index_state`, then `core:search_semantic`)
  // to prove the threaded transport produces an identical, fully-working
  // outcome from the daemon's own IPC surface, not just from
  // `tests/semantic-thread-transport.test.ts`'s narrower transport-only
  // checks.
  it("with an explicit semantic_descriptor (thread-eligible) and semantic_thread at its default (ON), semantic maintenance runs through the worker thread, and core:search_semantic answers once it completes", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-semthread-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-semthread-workspace-"));
    let runtime: DaemonRuntime | undefined;
    try {
      await mkdir(workspaceRoot, { recursive: true });
      for (const file of ["task.ts", "errors.ts"]) {
        await writeFile(join(workspaceRoot, file), await readFile(join(fixtureRoot, file), "utf8"), "utf8");
      }

      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-daemon-semantic-thread-integration",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        plugin_catalog: [{ ...bundledPluginCatalogEntry, capability_declarations: JAVASCRIPT_TYPESCRIPT_CAPABILITIES }],
        resolve_plugin_provider: resolvePluginProvider,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
        semantic_descriptor: { kind: "hash" },
      });
      const client = new DaemonClient(runtime.endpoint, DAEMON_CLIENT_OPTIONS);

      const added = await client.call("core:workspace_add", {
        args: [workspaceRoot],
        confirmed: true,
        selected_technology_ids: ["typescript"],
        selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      const settled = await pollUntilReady(client, workspaceId);
      expect(settled.workspace_status).toBe("ready");

      // Before semantic maintenance completes, `core:search_semantic` would
      // throw `core:semantic_index_unavailable` -- this poll only returns
      // once the async, THREADED pass genuinely finished for this scan's
      // generation.
      await pollUntilSemanticGenerationCurrent(dataRoot, workspaceId);

      const semanticResponse = await client.call("core:query", {
        api_version: 1,
        scope: { scope_type: "single_workspace", workspace_id: workspaceId },
        expression: { expression_type: "operation", operation: "core:search_semantic", arguments: { query_text: "CreateTaskInput", query_class: "identifier" } },
        options: queryOptions,
      });
      expect(semanticResponse.outcome).toBe("success");
      const semanticPayload = semanticResponse.payload as { readonly streams: Readonly<Record<string, StreamPage>> };
      const semanticCandidates = semanticPayload.streams["candidates"]?.items ?? [];
      expect(semanticCandidates.length).toBeGreaterThan(0);
      expect(semanticCandidates.some((entry) => candidatePath(entry).includes("task.ts"))).toBe(true);

      const statusResponse = await client.call("core:index_status", { workspace_ids: [workspaceId] });
      expect(statusResponse.outcome).toBe("success");
      type MaterializationView = { readonly coverage_status: string; readonly materialization_state: string };
      const statusPayload = statusResponse.payload as { readonly workspaces: ReadonlyArray<{ readonly semantic_materializations: ReadonlyArray<MaterializationView> }> };
      const materializations = statusPayload.workspaces[0]?.semantic_materializations ?? [];
      expect(materializations.length).toBeGreaterThan(0);
      expect(materializations[0]!.coverage_status).toBe("complete");
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 120_000);

  // `DaemonRuntimeOptions.semantic_thread: false` (the `URDIRA_SEMANTIC_THREAD`
  // kill switch's equivalent) forces the in-process `reconcileSemanticProjection`
  // call path even though `semantic_descriptor` alone would otherwise make
  // the threaded path eligible -- see `submitSemanticMaintenance`'s
  // `semanticThreadEligible` in `packages/daemon/src/runtime.ts`. Mirrors
  // `tests/phase-daemon-indexing-integration.test.ts`'s `URDIRA_LEXICAL_THREAD`
  // kill-switch test one layer over: proves `core:search_semantic` still
  // activates exactly as it does on the (thread-eligible) default path
  // above, just via the in-process reconciler call instead.
  it("URDIRA_SEMANTIC_THREAD kill switch (DaemonRuntimeOptions.semantic_thread: false) still builds the semantic index via the in-process path", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-semnothread-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-semnothread-workspace-"));
    let runtime: DaemonRuntime | undefined;
    try {
      await mkdir(workspaceRoot, { recursive: true });
      for (const file of ["task.ts", "errors.ts"]) {
        await writeFile(join(workspaceRoot, file), await readFile(join(fixtureRoot, file), "utf8"), "utf8");
      }

      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-daemon-semantic-nothread-integration",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        plugin_catalog: [{ ...bundledPluginCatalogEntry, capability_declarations: JAVASCRIPT_TYPESCRIPT_CAPABILITIES }],
        resolve_plugin_provider: resolvePluginProvider,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
        semantic_descriptor: { kind: "hash" },
        semantic_thread: false,
      });
      const client = new DaemonClient(runtime.endpoint, DAEMON_CLIENT_OPTIONS);

      const added = await client.call("core:workspace_add", {
        args: [workspaceRoot],
        confirmed: true,
        selected_technology_ids: ["typescript"],
        selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      const settled = await pollUntilReady(client, workspaceId);
      expect(settled.workspace_status).toBe("ready");

      await pollUntilSemanticGenerationCurrent(dataRoot, workspaceId);

      const semanticResponse = await client.call("core:query", {
        api_version: 1,
        scope: { scope_type: "single_workspace", workspace_id: workspaceId },
        expression: { expression_type: "operation", operation: "core:search_semantic", arguments: { query_text: "CreateTaskInput", query_class: "identifier" } },
        options: queryOptions,
      });
      expect(semanticResponse.outcome).toBe("success");
      const semanticPayload = semanticResponse.payload as { readonly streams: Readonly<Record<string, StreamPage>> };
      const semanticCandidates = semanticPayload.streams["candidates"]?.items ?? [];
      expect(semanticCandidates.length).toBeGreaterThan(0);
      expect(semanticCandidates.some((entry) => candidatePath(entry).includes("task.ts"))).toBe(true);
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 120_000);

  // Configure-time model provisioning (USER DECISION, 2026-08-13): the open
  // embedding model is downloaded when urdira is CONFIGURED (`core:workspace_add`/
  // `core:workspace_configure`/`core:configuration_set`), never at daemon
  // start and never on an embed path -- see `packages/daemon/src/runtime.ts`'s
  // `ensureAndActivateSemanticProvider` and `DaemonRuntimeOptions.semantic_descriptor`/
  // `semantic_runtime_hooks`. This test drives that exact activation
  // sequence end to end through the daemon's real IPC surface, entirely
  // hermetically: `semantic_runtime_hooks` injects fakes for `build`/`ensure`
  // (never the real `@urdira/embedding-local`, never a real "neural"
  // descriptor construction), so "downloading the model" here is really just
  // the fake `ensure` reporting success and the fake `build`'s SECOND call
  // succeeding with a real, hermetic `createLocalHashProvider()` -- no
  // network, no ONNX runtime, ever.
  it("fresh-install activation: semantic search is unavailable at daemon start, core:workspace_add provisions it via the injected hooks seam, and the SAME daemon serves core:search_semantic with no restart", async () => {
    // Short prefixes deliberately: the resulting `<dataRoot>/daemon.sock`
    // path must stay under `AF_UNIX`'s ~104-byte `sun_path` limit (macOS is
    // the tightest), which a longer, more descriptive prefix here already
    // overflowed once.
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-sem-activate-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-sem-activate-ws-"));
    let runtime: DaemonRuntime | undefined;
    try {
      await mkdir(workspaceRoot, { recursive: true });
      for (const file of ["task.ts", "errors.ts"]) {
        await writeFile(join(workspaceRoot, file), await readFile(join(fixtureRoot, file), "utf8"), "utf8");
      }

      // The FIRST `build` attempt (daemon start, per
      // `ensureAndActivateSemanticProvider`'s own doc comment: start NEVER
      // downloads) fails -- simulating a real "neural" descriptor whose
      // model genuinely is not present offline yet. Every later attempt
      // (only ever reached from `ensureAndActivateSemanticProvider`, and
      // only after the fake `ensure` below reports success) succeeds with a
      // real, hermetic hash provider.
      let buildAttempts = 0;
      const semanticRuntimeHooks: NonNullable<DaemonRuntimeOptions["semantic_runtime_hooks"]> = {
        build: async () => {
          buildAttempts += 1;
          if (buildAttempts === 1) throw new Error("fake: local embedding model not present offline yet");
          return createLocalHashProvider();
        },
        ensure: async () => ({ status: "downloaded", model_id: "fake/hash-model" }),
      };

      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-daemon-semantic-activation-integration",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        plugin_catalog: [{ ...bundledPluginCatalogEntry, capability_declarations: JAVASCRIPT_TYPESCRIPT_CAPABILITIES }],
        resolve_plugin_provider: resolvePluginProvider,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
        // A real `"neural"` descriptor SHAPE -- only `build`/`ensure`'s
        // implementations are faked, via the test seam. `cache_dir` is never
        // read by either fake, so its value is irrelevant here.
        semantic_descriptor: { kind: "neural", cache_dir: join(dataRoot, "models") },
        semantic_runtime_hooks: semanticRuntimeHooks,
      });
      // Direct proof that daemon start attempted (and accepted the failure
      // of) exactly one OFFLINE build -- never a second, download-permitting
      // attempt. This is "absent at start".
      expect(buildAttempts).toBe(1);
      const client = new DaemonClient(runtime.endpoint, DAEMON_CLIENT_OPTIONS);

      const added = await client.call("core:workspace_add", {
        args: [workspaceRoot],
        confirmed: true,
        selected_technology_ids: ["typescript"],
        selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      // `core:workspace_add`'s handler `await`s `ensureAndActivateSemanticProvider`
      // after its own validation succeeds and before returning -- by the
      // time this response has landed, the fake `build`'s SECOND (successful)
      // attempt must already have run and activated the provider.
      expect(buildAttempts).toBe(2);
      // The visible download notice (owner decision 2026-08-13,
      // docs/decisions/18-semantic-model-pack.md Outcome): the fake `ensure`
      // above reports `"downloaded"`, so this same response -- the RPC that
      // triggered the download -- must carry it back verbatim.
      expect((added.payload as { readonly semantic_model?: unknown }).semantic_model).toEqual({ status: "downloaded", model_id: "fake/hash-model" });

      const settled = await pollUntilReady(client, workspaceId);
      expect(settled.workspace_status).toBe("ready");

      await pollUntilSemanticGenerationCurrent(dataRoot, workspaceId);

      // The direct regression check: without activation invalidating the
      // cached per-workspace query engine, or without activation running at
      // all, this would still throw `core:semantic_index_unavailable` --
      // exactly the kill-switch test's assertion below, but here proving the
      // OPPOSITE transition (unavailable -> available) within one daemon
      // process's lifetime, no restart.
      const semanticResponse = await client.call("core:query", {
        api_version: 1,
        scope: { scope_type: "single_workspace", workspace_id: workspaceId },
        expression: { expression_type: "operation", operation: "core:search_semantic", arguments: { query_text: "CreateTaskInput", query_class: "identifier" } },
        options: queryOptions,
      });
      expect(semanticResponse.outcome).toBe("success");
      const semanticPayload = semanticResponse.payload as { readonly streams: Readonly<Record<string, StreamPage>> };
      const semanticCandidates = semanticPayload.streams["candidates"]?.items ?? [];
      expect(semanticCandidates.length).toBeGreaterThan(0);
      expect(semanticCandidates.some((entry) => candidatePath(entry).includes("task.ts"))).toBe(true);

      // A second `core:workspace_add` (or `core:workspace_configure`/
      // `core:configuration_set`) call while ALREADY active must not attempt
      // a third `build`/download -- `ensureAndActivateSemanticProvider`'s
      // own early-return (`semanticProvider !== undefined`) makes this
      // idempotent.
      const readdConfirmed = await client.call("core:workspace_add", { args: [workspaceRoot], confirmed: true });
      expect(readdConfirmed.outcome).toBe("success");
      expect(buildAttempts).toBe(2);
      // Already active: `ensureAndActivateSemanticProvider`'s early return
      // provisions nothing this call, so the response carries no
      // `semantic_model` field at all (omitted, not a `"present"` value --
      // see `ensureAndActivateSemanticProvider`'s own doc comment on why).
      expect((readdConfirmed.payload as { readonly semantic_model?: unknown }).semantic_model).toBeUndefined();
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("URDIRA_SEMANTIC_INDEX kill switch (DaemonRuntimeOptions.semantic_index: false) never builds a semantic index, and core:search_semantic answers core:semantic_index_unavailable", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-semantic-off-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-daemon-semantic-off-workspace-"));
    let runtime: DaemonRuntime | undefined;
    try {
      await mkdir(workspaceRoot, { recursive: true });
      for (const file of ["task.ts", "errors.ts"]) {
        await writeFile(join(workspaceRoot, file), await readFile(join(fixtureRoot, file), "utf8"), "utf8");
      }

      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-daemon-semantic-off-integration",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        plugin_catalog: [{ ...bundledPluginCatalogEntry, capability_declarations: JAVASCRIPT_TYPESCRIPT_CAPABILITIES }],
        resolve_plugin_provider: resolvePluginProvider,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
        semantic_index: false,
      });
      const client = new DaemonClient(runtime.endpoint, DAEMON_CLIENT_OPTIONS);

      const added = await client.call("core:workspace_add", {
        args: [workspaceRoot],
        confirmed: true,
        selected_technology_ids: ["typescript"],
        selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      const settled = await pollUntilReady(client, workspaceId);
      expect(settled.workspace_status).toBe("ready");

      // No sleep needed here (was a fixed 500ms guess at how long to wait
      // before checking nothing got written): `submitSemanticMaintenance`
      // (`packages/daemon/src/runtime.ts`) is a plain synchronous function
      // called directly after `registry.markReady`, with no `await` between
      // them -- with `semantic_index: false`, no provider is ever
      // constructed, so `semanticProvider` stays `undefined` forever and
      // this call returns immediately without ever reaching
      // `scheduler.submit`. Node's run-to-completion semantics mean no other
      // JS (including the RPC handling that could ever let `pollUntilReady`
      // above observe `workspace_status: "ready"`) can interleave between
      // `markReady` and that synchronous kill-switch check, so by the time
      // this test sees "ready" over the IPC socket, the decision not to
      // submit semantic maintenance for this scan has already been made and
      // is final -- confirmed directly below, at the storage level, the same
      // proof the original sleep-then-check was reaching for, just without
      // the race.
      const pollStorage = await createDurableStorage({ rootDir: dataRoot });
      try {
        const database = await pollStorage.openWorkspace(workspaceId);
        try {
          const state = await database.projections.semanticIndexState();
          expect(state).toBeUndefined();
        } finally {
          await database.close().catch(() => undefined);
        }
      } finally {
        await pollStorage.close().catch(() => undefined);
      }

      const response = await client.call("core:query", {
        api_version: 1,
        scope: { scope_type: "single_workspace", workspace_id: workspaceId },
        expression: { expression_type: "operation", operation: "core:search_semantic", arguments: { query_text: "CreateTaskInput", query_class: "identifier" } },
        options: queryOptions,
      });
      expect(response.outcome).toBe("error");
      // `SemanticQueryError`/`EngineError` are not `DaemonError`s, but they
      // do carry a registered namespaced code (`core:semantic_index_unavailable`),
      // so the daemon's IPC server (`packages/daemon/src/protocol.ts`) now
      // preserves that code on the wire instead of flattening it to
      // `core:execution_failed` -- the same convention
      // `tests/phase-daemon-admin-integration.test.ts` exercises for a real
      // `core:repair` `StorageError`. `EngineError`'s own `message` is
      // always `${code}: ${message}`, so the message still contains the
      // code too.
      expect(response.error?.code).toBe("core:semantic_index_unavailable");
      expect(response.error?.message).toMatch(/core:semantic_index_unavailable/);
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 120_000);
});

// Owner decision 2026-08-13 (docs/decisions/18-semantic-model-pack.md
// Outcome): a configure RPC that needs to download the embedding model must
// carry a visible notice, never download silently. The "fresh-install
// activation" test above already covers the absent-model/"downloaded" case
// end-to-end (including a real first scan); these tests isolate the
// remaining two outcomes (`"present"`/`"failed"`) as cheaply as possible --
// `core:workspace_add` with `confirmed: false` still `await`s
// `ensureAndActivateSemanticProvider` (see `runtime.ts`) but never schedules
// a scan or touches `pluginCatalog`/`resolve_plugin_provider`, so no
// fixture files, plugin registry, or `pollUntilReady` polling is needed at
// all -- just the injected `semantic_runtime_hooks.ensure` fake.
describe("Semantic model provisioning notice on configure-time admin RPCs", () => {
  it("a model already present offline reports status: \"present\" on the SAME response, without a second (download) build attempt", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-sem-notice-present-"));
    let runtime: DaemonRuntime | undefined;
    try {
      let buildAttempts = 0;
      const hooks: NonNullable<DaemonRuntimeOptions["semantic_runtime_hooks"]> = {
        build: async () => {
          buildAttempts += 1;
          // Daemon start's own offline build fails (nothing active yet) --
          // mirrors the "fresh-install activation" test's own first attempt,
          // so this test also proves the notice is independent of whatever
          // daemon start itself managed to do.
          if (buildAttempts === 1) throw new Error("fake: not built at daemon start");
          return createLocalHashProvider();
        },
        // The offline (`allow_download: false`) attempt inside the real
        // `ensureLocalEmbeddingModel` already succeeded in this scenario --
        // the model was present all along -- so the fake reports "present"
        // directly, never "downloaded".
        ensure: async () => ({ status: "present", model_id: "fake/already-cached-model" }),
      };
      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-daemon-semantic-notice-present",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
        semantic_descriptor: { kind: "neural", cache_dir: join(dataRoot, "models") },
        semantic_runtime_hooks: hooks,
      });
      const client = new DaemonClient(runtime.endpoint, DAEMON_CLIENT_OPTIONS);
      const added = await client.call("core:workspace_add", { args: [join(dataRoot, "workspace")], confirmed: false });
      expect(added.outcome).toBe("success");
      expect((added.payload as { readonly semantic_model?: unknown }).semantic_model).toEqual({ status: "present", model_id: "fake/already-cached-model" });
      // "present" still activates the provider for the rest of this
      // process's lifetime (a build attempt now succeeds), just without
      // ever touching the network.
      expect(buildAttempts).toBe(2);
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("a failed provisioning attempt keeps the RPC successful and reports status: \"failed\", without ever attempting to build/activate a provider", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-sem-notice-failed-"));
    let runtime: DaemonRuntime | undefined;
    try {
      let buildAttempts = 0;
      const hooks: NonNullable<DaemonRuntimeOptions["semantic_runtime_hooks"]> = {
        build: async () => {
          buildAttempts += 1;
          throw new Error("fake: never built at daemon start");
        },
        // Both the offline and the download attempt failed inside the real
        // `ensureSemanticAssets` (still offline, no network, disk full,
        // etc.) -- reported back as DATA, not a rejection (see that
        // function's own doc comment).
        ensure: async () => ({ status: "failed", model_id: "fake/unreachable-model" }),
      };
      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-daemon-semantic-notice-failed",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
        semantic_descriptor: { kind: "neural", cache_dir: join(dataRoot, "models") },
        semantic_runtime_hooks: hooks,
      });
      const client = new DaemonClient(runtime.endpoint, DAEMON_CLIENT_OPTIONS);
      const added = await client.call("core:workspace_add", { args: [join(dataRoot, "workspace")], confirmed: false });
      // Decision 06: a provisioning failure never blocks this RPC's own
      // structural work -- the call still succeeds.
      expect(added.outcome).toBe("success");
      expect((added.payload as { readonly semantic_model?: unknown }).semantic_model).toEqual({ status: "failed", model_id: "fake/unreachable-model" });
      // `ensureAndActivateSemanticProvider` short-circuits on `status: "failed"`
      // before ever calling `buildProvider` a second time -- daemon start's
      // own single (failing) attempt is the only one that ran.
      expect(buildAttempts).toBe(1);
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
