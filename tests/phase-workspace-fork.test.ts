import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodeCanonical } from "@urdira/canonical";
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
// are not root-level `devDependencies`, so (matching every other `tests/*.test.ts`
// file that touches them, e.g. `tests/phase-daemon-indexing-integration.test.ts`)
// this file imports them from `src` by relative path.
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
import { defaultDaemonOptions } from "../apps/urdira/src/index.js";
import { DaemonClient, DaemonRuntime, type DaemonRuntimeOptions } from "../packages/daemon/src/index.js";
import { createDurableStorage, type DurableStorage, type WorkspaceDatabase } from "../packages/storage/src/index.js";
// `rowMatches`/`mismatchedFields` are `assertPublicationImmutableRows`'s own
// exact-byte comparison primitives (`@internal`, not re-exported through the
// package's public `index.js` -- matching `tests/phase9-publication.test.ts`'s
// own direct-from-`publication-authority.js` import), reused below to assert
// the fork's own registry/control-plane rows are byte-identical to what the
// ordinary publication path would independently compute for the same plugin
// resolution -- the regression coverage for the `storage:publication_conflict`
// incident this file's "(bug 4)" test documents.
import { mismatchedFields, rowMatches } from "../packages/storage/src/publication-authority.js";

/**
 * `defaultDaemonOptions` (`apps/urdira/src/index.ts`) now resolves a REAL
 * embedding provider by default -- the bundled open-model local neural
 * provider, which downloads a model on first use -- per
 * `docs/decisions/16-semantic-search-wiring.md`'s open-model-default
 * addendum. The two real-`defaultDaemonOptions` uses below exist to exercise
 * the plugin-resolution-lock restart scenario, not embeddings, so this
 * forces the explicit `URDIRA_EMBEDDINGS_PROVIDER=hash` escape hatch for the
 * duration of the wrapped call, restoring whatever was there before --
 * keeping this suite hermetic (no network, no model download).
 */
async function withHashEmbeddingsProvider<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env["URDIRA_EMBEDDINGS_PROVIDER"];
  process.env["URDIRA_EMBEDDINGS_PROVIDER"] = "hash";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env["URDIRA_EMBEDDINGS_PROVIDER"];
    else process.env["URDIRA_EMBEDDINGS_PROVIDER"] = previous;
  }
}

function asDaemonWorkspaceRegistry(registry: WorkspaceRegistry): NonNullable<DaemonRuntimeOptions["workspace_registry"]> {
  return registry as unknown as NonNullable<DaemonRuntimeOptions["workspace_registry"]>;
}

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(here, "fixtures", "codebases", "typescript", "task-planner", "src", "domain");
// The full task-planner fixture (not just `src/domain`, which -- since
// `errors.ts`'s classes only `extends Error` and `task.ts`'s types never
// reference another file -- has zero real cross-file `artifact_dependencies`
// at all): needed for the dependency-owner regression below, which requires
// a file that genuinely owns an outgoing cross-file dependency.
const fullFixtureRoot = resolve(here, "fixtures", "codebases", "typescript", "task-planner");
const now = "2026-08-12T12:00:00.000Z";

interface PreparedRegistry {
  readonly registry: AssembledPluginRegistry;
  readonly lock: SdkPluginResolutionLock;
  readonly plugin: DiscoveredPluginPackage;
}

async function prepareRegistry(workspaceId: string): Promise<PreparedRegistry> {
  const digests = createCanonicalPluginDigestAuthority();
  const encoder = new TextEncoder();
  const assets = [
    { normalized_relative_path: "dist/worker.mjs", bytes: encoder.encode("urdira workspace-fork jsts worker"), executable: true, role: "parser" as const },
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

// `attemptWorkspaceFork`/`runFullWorkspaceScan` (and the daemon's
// `resolve_plugin_provider` signature) are typed against `@urdira/storage`'s
// published (dist) declarations, while this file imports storage from `src`
// for whitebox access -- two nominally distinct declarations of the same
// runtime class within `tsconfig.tests.json`'s flat program. Same bridge as
// `tests/phase-workspace-indexing-session.test.ts`'s `asStorageDatabase`
// (see the full note there and in `tests/phase-indexing-port.test.ts`).
function asStorageDatabase(database: WorkspaceDatabase): Parameters<typeof runFullWorkspaceScan>[0]["database"] {
  return database as unknown as Parameters<typeof runFullWorkspaceScan>[0]["database"];
}
function asDurableStorage(storage: DurableStorage): Parameters<typeof attemptWorkspaceFork>[0]["storage"] {
  return storage as unknown as Parameters<typeof attemptWorkspaceFork>[0]["storage"];
}

/** Tracks, across an entire test, which workspace ids `analyze()` was actually invoked for -- the direct proof that a fork skipped plugin analysis entirely (rather than merely producing output that happens to look the same, which decision 11's content-derived ids would do even under two independent full analyses). */
function buildPluginProviderResolver(analyzedWorkspaceIds: Set<string>): NonNullable<DaemonRuntimeOptions["resolve_plugin_provider"]> {
  return async (workspace) => {
    if (!(workspace.selected_plugin_ids ?? []).includes(JAVASCRIPT_TYPESCRIPT_PLUGIN_ID)) return undefined;
    const prepared = await prepareRegistry(workspace.workspace_id);
    const registrySnapshotId = prepared.registry.registry_snapshot_id;
    const configurationRevisionId = `configuration:${workspace.workspace_id}`;
    return buildPluginProvider(prepared, workspace.workspace_id, registrySnapshotId, configurationRevisionId, analyzedWorkspaceIds);
  };
}

function buildPluginProvider(prepared: PreparedRegistry, workspaceId: string, registrySnapshotId: string, configurationRevisionId: string, analyzedWorkspaceIds: Set<string>): WorkspaceScanPluginProvider {
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
            // Mirrors `apps/urdira/src/index.ts`'s real plugin-provider wiring
            // (`createResolveJavascriptTypescriptPluginProvider`): the JS/TS
            // worker only echoes `base_snapshot_id` back onto its raw delta
            // when the work item itself carries it
            // (`packages/plugin-javascript-typescript/src/fact-delta.ts`), and
            // `FactDeltaAcceptanceService.accept`'s `validateIdentity` then
            // requires that echoed value to equal the candidate's own
            // `base_snapshot_id` whenever the candidate has one (i.e. on any
            // scan after a workspace's first). Omitting this only ever
            // mattered once this test suite's own (e) incremental-publish
            // case exercised a second scan -- the daemon-indexing-integration
            // test this harness was adapted from never does.
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

async function pollUntilSettled(client: DaemonClient, workspaceId: string, timeoutMs = 120_000): Promise<{ readonly workspace_status: string; readonly current_snapshot_id?: string }> {
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
      // A staged rescan can transition from the list response's ready view to
      // indexing before the v1 detail request arrives. Retry that benign race;
      // v1 retains its historical unavailable-while-indexing contract.
      if (detail.outcome !== "success") {
        const errorCode = detail.error?.code;
        if (errorCode === "core:index_unavailable") {
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

async function seedFixtureFiles(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const file of ["task.ts", "errors.ts"]) {
    await writeFile(join(root, file), await readFile(join(fixtureRoot, file), "utf8"), "utf8");
  }
}

function git_(root: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

/** Initializes `root` as a git repo and commits whatever is already on disk there. Returns the commit sha. */
function commitAll(root: string): string {
  git_(root, "init", "-q");
  git_(root, "config", "user.email", "fork-test@example.com");
  git_(root, "config", "user.name", "fork-test");
  // The fixture's byte identity must not depend on the host Git client's
  // checkout conversion policy. Production correctly treats CRLF and LF as
  // different source bytes; these fork tests intentionally need identical
  // donor and worktree bytes.
  git_(root, "config", "core.autocrlf", "false");
  git_(root, "add", "-A");
  git_(root, "commit", "-q", "-m", "fork-test commit");
  return git_(root, "rev-parse", "HEAD");
}

/** Adds a real linked worktree of `mainRoot` (a repo produced by `commitAll`) at `worktreeRoot`, checked out (detached) at `sha`. */
function addWorktree(mainRoot: string, worktreeRoot: string, sha: string): void {
  git_(mainRoot, "worktree", "add", "-q", "--detach", worktreeRoot, sha);
}

const daemonScheduler: DaemonRuntimeOptions["scheduler"] = { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} };

interface Harness {
  readonly runtime: DaemonRuntime;
  readonly client: DaemonClient;
  readonly analyzedWorkspaceIds: Set<string>;
  readonly dataRoot: string;
  readonly workspaceRoots: string[];
}

async function startHarness(options: Partial<DaemonRuntimeOptions> = {}): Promise<Harness> {
  const dataRoot = await mkdtemp(join(tmpdir(), "urdira-fork-data-"));
  const analyzedWorkspaceIds = new Set<string>();
  const runtime = await DaemonRuntime.start({
    data_root: dataRoot,
    engine_build_id: "build-workspace-fork",
    workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
    plugin_catalog: [{ ...bundledPluginCatalogEntry, capability_declarations: JAVASCRIPT_TYPESCRIPT_CAPABILITIES }],
    resolve_plugin_provider: buildPluginProviderResolver(analyzedWorkspaceIds),
    scheduler: daemonScheduler,
    // This module's own tests always request the full `StorageMaintenance.verify()`
    // gate (`WorkspaceForkOptions.verify_mode: "full"`), not the fast default
    // production now uses -- see `DaemonRuntimeOptions.workspace_fork_verify`'s
    // doc comment. A test can still override this via `options`.
    workspace_fork_verify: "full",
    ...options,
  });
  // A loaded machine (all 5 heavy integration files running concurrently, no
  // `fileParallelism` isolation) can turn one slow-but-correct RPC into a
  // spurious `core:ipc_timeout` well before the operation itself would ever
  // fail -- the default 30s in `packages/daemon/src/protocol.ts` is sized for
  // an unloaded machine. `pollUntilSettled`'s own deadline above is the real
  // backstop for a genuinely stuck workspace.
  return { runtime, client: new DaemonClient(runtime.endpoint, { request_timeout_ms: 120_000 }), analyzedWorkspaceIds, dataRoot, workspaceRoots: [] };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.runtime.stop();
  await rm(harness.dataRoot, { recursive: true, force: true });
  for (const root of harness.workspaceRoots) await rm(root, { recursive: true, force: true });
}

async function addWorkspaceAndWait(harness: Harness, root: string): Promise<{ readonly workspace_id: string; readonly status: string }> {
  harness.workspaceRoots.push(root);
  const added = await harness.client.call("core:workspace_add", {
    args: [root],
    confirmed: true,
    selected_technology_ids: ["typescript"],
    selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
  });
  expect(added.outcome).toBe("success");
  const payload = added.payload as { readonly workspace_id: string; readonly status: string };
  const settled = await pollUntilSettled(harness.client, payload.workspace_id);
  return { workspace_id: payload.workspace_id, status: settled.workspace_status };
}

async function findRecordNames(client: DaemonClient, workspaceId: string): Promise<readonly string[]> {
  const query = {
    api_version: 1,
    scope: { scope_type: "single_workspace", workspace_id: workspaceId },
    expression: { expression_type: "operation", operation: "core:find_records", arguments: { selector: { record_categories: ["entity"], kind_selector: { universal_kinds: ["core:type"] }, filter: { languages: ["typescript"] } } } },
    options: {
      freshness: "current", wait_timeout_ms: 0, coverage_requirement: "accept_reported",
      evidence: { evidence: "summary", evidence_chain_depth: 1 }, diagnostics: { diagnostics: "relevant", diagnostic_detail: false },
      snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 },
      registry: { registry: "used", include_payload_schemas: false }, response_budget: { max_items: 1_000, max_characters: 1_000_000 },
    },
  } as const;
  const deadline = Date.now() + 30_000;
  let response = await client.call("core:query", query);
  while (response.outcome === "error" && (response.error?.code === "core:index_unavailable" || response.error?.code === "core:coverage_incomplete") && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    response = await client.call("core:query", query);
  }
  expect(response.outcome).toBe("success");
  type StreamPage = { readonly items: ReadonlyArray<{ readonly value: { readonly record_id: string; readonly body: Readonly<Record<string, unknown>> } }> };
  const payload = response.payload as { readonly streams: Readonly<Record<string, StreamPage>> };
  return (payload.streams["records"]?.items ?? []).map((entry) => `${entry.value.record_id}:${String(entry.value.body["name"])}`).sort();
}

const FORK_INCLUSION_RULES = { include: [], exclude: ["node_modules/**", ".git/**", "dist/**", ".urdira/**"], allow_external_root: false };

/** Engine-level (no daemon) workspace registration, mirroring what `packages/daemon/src/runtime.ts`'s `scheduleWorkspaceScan` does before calling `attemptWorkspaceFork`/`runFullWorkspaceScan`. */
async function registerEngineWorkspace(registry: WorkspaceRegistry, root: string, label: string): Promise<RegisteredWorkspace> {
  const workspace = registry.register({
    display_root: root,
    provider: { source_provider_binding_id: `binding:${label}`, source_provider: "core:directory_source_provider", source_provider_version: "1", provider_role: "primary", binding_identity: `identity:${label}`, configuration_digest: `digest:${label}` },
    description: { provider_kind: "core:directory_source_provider", immutable_binding_identity: `identity:${label}`, features: "{}", source_state_fingerprint: `fingerprint:${label}` },
    selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
  });
  registry.beginReconciliation(workspace.workspace_id);
  return registry.get(workspace.workspace_id)!;
}

async function openEngineWorkspace(storage: DurableStorage, workspace: RegisteredWorkspace): Promise<WorkspaceDatabase> {
  await storage.catalog.registerWorkspace({ workspace_id: workspace.workspace_id, canonical_root: workspace.canonical_root, display_root: workspace.display_root, source_provider_bindings: [workspace.provider], status: "registered", registered_at: workspace.registered_at });
  return storage.openWorkspace(workspace.workspace_id);
}

describe("Workspace fork (docs/decisions/12-workspace-fork.md)", () => {
  it("(a)+(b) forks a content-identical git worktree without invoking plugin analysis, with identical query results, and verify() passes on the forked database", async () => {
    const harness = await startHarness();
    try {
      const mainRoot = await mkdtemp(join(tmpdir(), "urdira-fork-main-"));
      await seedFixtureFiles(mainRoot);
      const sha = commitAll(mainRoot);
      const worktreeRoot = join(dirname(mainRoot), `urdira-fork-worktree-${randomUUID()}`);
      addWorktree(mainRoot, worktreeRoot, sha);

      const donor = await addWorkspaceAndWait(harness, mainRoot);
      expect(donor.status).toBe("ready");
      expect(harness.analyzedWorkspaceIds.has(donor.workspace_id)).toBe(true);

      const forkTarget = await addWorkspaceAndWait(harness, worktreeRoot);
      expect(forkTarget.status).toBe("ready");

      // The direct proof this was a fork, not a coincidentally-identical
      // independent analysis: `analyze()` was never invoked for the fork
      // target's own workspace id. If the fork's identity predicate, donor
      // matching, or `verify()` had failed for any reason, the daemon's
      // fallback would have run a real `runFullWorkspaceScan`, which would
      // have invoked `analyze()` for `forkTarget.workspace_id` too.
      expect(harness.analyzedWorkspaceIds.has(forkTarget.workspace_id)).toBe(false);

      const donorNames = await findRecordNames(harness.client, donor.workspace_id);
      const forkNames = await findRecordNames(harness.client, forkTarget.workspace_id);
      expect(forkNames.length).toBeGreaterThan(0);
      // Content-derived identity (decision 11) means these must be not just
      // equal in content but literally identical `record_id`s.
      expect(forkNames).toEqual(donorNames);
    } finally {
      await stopHarness(harness);
    }
  }, 120_000);

  it("(c) falls back to a full scan when the new worktree is dirty", async () => {
    const harness = await startHarness();
    try {
      const mainRoot = await mkdtemp(join(tmpdir(), "urdira-fork-dirty-main-"));
      await seedFixtureFiles(mainRoot);
      const sha = commitAll(mainRoot);
      const worktreeRoot = join(dirname(mainRoot), `urdira-fork-dirty-worktree-${randomUUID()}`);
      addWorktree(mainRoot, worktreeRoot, sha);
      // Dirty the worktree after checkout: an uncommitted edit to a tracked file.
      await writeFile(join(worktreeRoot, "task.ts"), `${await readFile(join(worktreeRoot, "task.ts"), "utf8")}\n// local edit\n`, "utf8");

      const donor = await addWorkspaceAndWait(harness, mainRoot);
      expect(donor.status).toBe("ready");

      const forkTarget = await addWorkspaceAndWait(harness, worktreeRoot);
      expect(forkTarget.status).toBe("ready");
      // A dirty worktree must never match the git fast path; the fallback
      // content-hash predicate also cannot match (the edited file's content
      // hash differs from the donor's), so this must fall back to a full,
      // real scan.
      expect(harness.analyzedWorkspaceIds.has(forkTarget.workspace_id)).toBe(true);
    } finally {
      await stopHarness(harness);
    }
  }, 120_000);

  it("(c) falls back to a full scan when the new worktree is at a different commit", async () => {
    const harness = await startHarness();
    try {
      const mainRoot = await mkdtemp(join(tmpdir(), "urdira-fork-diffcommit-main-"));
      await seedFixtureFiles(mainRoot);
      commitAll(mainRoot);
      // Second commit with different content, so the two roots are neither
      // git-identical (different HEAD) nor content-identical (different bytes).
      await writeFile(join(mainRoot, "task.ts"), `${await readFile(join(mainRoot, "task.ts"), "utf8")}\n// second commit\n`, "utf8");
      git_(mainRoot, "add", "-A");
      git_(mainRoot, "commit", "-q", "-m", "second commit");
      const firstSha = git_(mainRoot, "rev-list", "--max-parents=0", "HEAD");
      const worktreeRoot = join(dirname(mainRoot), `urdira-fork-diffcommit-worktree-${randomUUID()}`);
      addWorktree(mainRoot, worktreeRoot, firstSha);

      const donor = await addWorkspaceAndWait(harness, mainRoot);
      expect(donor.status).toBe("ready");

      const forkTarget = await addWorkspaceAndWait(harness, worktreeRoot);
      expect(forkTarget.status).toBe("ready");
      expect(harness.analyzedWorkspaceIds.has(forkTarget.workspace_id)).toBe(true);
    } finally {
      await stopHarness(harness);
    }
  }, 120_000);

  it("(c) donor discovery skips a ready workspace with a different plugin selection", async () => {
    const registry = new WorkspaceRegistry();
    const donor = registry.register({
      display_root: "/donor",
      provider: { source_provider_binding_id: "binding:donor", source_provider: "core:directory_source_provider", source_provider_version: "1", provider_role: "primary", binding_identity: "identity:donor", configuration_digest: "digest:donor" },
      description: { provider_kind: "core:directory_source_provider", immutable_binding_identity: "identity:donor", features: "{}", source_state_fingerprint: "fingerprint:donor" },
      selected_plugin_ids: ["core:some_other_plugin"],
    });
    registry.beginReconciliation(donor.workspace_id);
    registry.markReady(donor.workspace_id, "snapshot:donor-fake", "ready");
    const newWorkspace = registry.register({
      display_root: "/new",
      provider: { source_provider_binding_id: "binding:new", source_provider: "core:directory_source_provider", source_provider_version: "1", provider_role: "primary", binding_identity: "identity:new", configuration_digest: "digest:new" },
      description: { provider_kind: "core:directory_source_provider", immutable_binding_identity: "identity:new", features: "{}", source_state_fingerprint: "fingerprint:new" },
      selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
    });
    // `attemptWorkspaceFork` filters candidate donors by matching
    // `selected_plugin_ids` before it ever opens any workspace database, so
    // this negative case needs no real database/storage/plugin -- it never
    // reaches code that would dereference them.
    const outcome = await attemptWorkspaceFork({
      workspace: newWorkspace,
      registry,
      database: undefined as never,
      storage: undefined as never,
      plugin: undefined as never,
    });
    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") expect(outcome.reason).toContain("plugin selection");
  });

  it("(d) URDIRA_WORKSPACE_FORK kill switch (DaemonRuntimeOptions.workspace_fork: false) leaves a content-identical worktree on the full-scan path", async () => {
    const harness = await startHarness({ workspace_fork: false });
    try {
      const mainRoot = await mkdtemp(join(tmpdir(), "urdira-fork-killswitch-main-"));
      await seedFixtureFiles(mainRoot);
      const sha = commitAll(mainRoot);
      const worktreeRoot = join(dirname(mainRoot), `urdira-fork-killswitch-worktree-${randomUUID()}`);
      addWorktree(mainRoot, worktreeRoot, sha);

      const donor = await addWorkspaceAndWait(harness, mainRoot);
      expect(donor.status).toBe("ready");

      const forkTarget = await addWorkspaceAndWait(harness, worktreeRoot);
      expect(forkTarget.status).toBe("ready");
      // With the kill switch off, `attemptWorkspaceFork` must never even be
      // called: the fork target is analyzed exactly like any other first scan.
      expect(harness.analyzedWorkspaceIds.has(forkTarget.workspace_id)).toBe(true);
    } finally {
      await stopHarness(harness);
    }
  }, 120_000);

  it("(e) a real content edit after a fork triggers a correct incremental publish (base agrees from the fork's own source_state_digest)", async () => {
    const harness = await startHarness();
    try {
      const mainRoot = await mkdtemp(join(tmpdir(), "urdira-fork-incremental-main-"));
      await seedFixtureFiles(mainRoot);
      const sha = commitAll(mainRoot);
      const worktreeRoot = join(dirname(mainRoot), `urdira-fork-incremental-worktree-${randomUUID()}`);
      addWorktree(mainRoot, worktreeRoot, sha);

      const donor = await addWorkspaceAndWait(harness, mainRoot);
      expect(donor.status).toBe("ready");
      const forkTarget = await addWorkspaceAndWait(harness, worktreeRoot);
      expect(forkTarget.status).toBe("ready");
      expect(harness.analyzedWorkspaceIds.has(forkTarget.workspace_id)).toBe(false);

      const beforeNames = await findRecordNames(harness.client, forkTarget.workspace_id);
      expect(beforeNames.some((entry) => entry.includes("TaskNotFoundError"))).toBe(true);

      // A genuine content edit to the fork target's own worktree (not the
      // donor's), removing one declaration and adding a marker string.
      const errorsPath = join(worktreeRoot, "errors.ts");
      const original = await readFile(errorsPath, "utf8");
      await writeFile(errorsPath, `${original}\nexport class ForkIncrementalMarkerError extends Error {}\n`, "utf8");

      const reindexed = await harness.client.call("core:reindex", { args: [forkTarget.workspace_id] });
      expect(reindexed.outcome).toBe("success");
      const settled = await pollUntilSettled(harness.client, forkTarget.workspace_id);
      expect(settled.workspace_status).toBe("ready");
      // The incremental scan is a real scan (not another fork attempt --
      // forks only ever run on a workspace's genuine first scan), so it must
      // have invoked real plugin analysis this time.
      expect(harness.analyzedWorkspaceIds.has(forkTarget.workspace_id)).toBe(true);

      const afterNames = await findRecordNames(harness.client, forkTarget.workspace_id);
      // The pre-existing declarations survive (closed and reopened or
      // reused, depending on content-hash reuse), and the new declaration
      // this edit introduced is now present -- proving the incremental
      // publish correctly diffed against the fork's own published generation
      // 1, not e.g. treating everything as brand new or failing outright.
      expect(afterNames.some((entry) => entry.includes("ForkIncrementalMarkerError"))).toBe(true);
      expect(afterNames.some((entry) => entry.includes("TaskNotFoundError"))).toBe(true);
    } finally {
      await stopHarness(harness);
    }
  }, 120_000);
});

// Regression coverage for a real e2e incident (excalidraw donor + a same-commit
// detached `git worktree add` fork target): the git fast path's "clean + same
// peeled HEAD" premise turned out false in practice (a donor checkout can have
// scanned-but-untracked, gitignored generated files -- e.g. husky's
// `.husky/_/*` hook shims -- that a fresh worktree checkout never gets, since
// the scanner does not apply .gitignore and only excludes node_modules/.git/
// dist/.urdira), and the fork's rollback did not cover the failure path that
// mismatch actually took, leaving the workspace permanently stuck "indexing"
// on every retry. See docs/decisions/12-workspace-fork.md's "git fast path"
// and `commitSourceLayerAndPublish`'s doc comment for the full analysis.
describe("Workspace fork bug-1/bug-2 regression (real-world e2e findings)", () => {
  it("(bug 2) any failure after the source-layer commit rolls back so the immediate fallback full scan reaches ready with a real, non-empty snapshot", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-fork-bug2-data-"));
    const mainRoot = await mkdtemp(join(tmpdir(), "urdira-fork-bug2-main-"));
    let worktreeRoot: string | undefined;
    let storage: DurableStorage | undefined;
    let donorDatabase: WorkspaceDatabase | undefined;
    let forkDatabase: WorkspaceDatabase | undefined;
    try {
      await seedFixtureFiles(mainRoot);
      const sha = commitAll(mainRoot);
      worktreeRoot = join(dirname(mainRoot), `urdira-fork-bug2-worktree-${randomUUID()}`);
      addWorktree(mainRoot, worktreeRoot, sha);

      storage = await createDurableStorage({ rootDir: dataRoot });
      const registry = new WorkspaceRegistry();
      const analyzedWorkspaceIds = new Set<string>();
      const resolvePluginProvider = buildPluginProviderResolver(analyzedWorkspaceIds);

      // Donor: a real, normal full scan, published and marked ready.
      const donorWorkspace = await registerEngineWorkspace(registry, mainRoot, "donor");
      donorDatabase = await openEngineWorkspace(storage, donorWorkspace);
      const donorPlugin = await resolvePluginProvider(donorWorkspace, asStorageDatabase(donorDatabase));
      if (!donorPlugin) throw new Error("donor plugin resolution unexpectedly failed");
      const donorResult = await runFullWorkspaceScan({ root: mainRoot, database: asStorageDatabase(donorDatabase), workspace_id: donorWorkspace.workspace_id, plugin: donorPlugin, inclusion_rules: FORK_INCLUSION_RULES });
      registry.markReady(donorWorkspace.workspace_id, donorResult.snapshot_id, "ready");

      // Fork target: registered and opened, but not scanned yet -- the fork
      // attempt below is its first-ever indexing activity, exactly mirroring
      // `scheduleWorkspaceScan`'s job for a freshly added workspace.
      const forkWorkspace = await registerEngineWorkspace(registry, worktreeRoot, "fork-target");
      forkDatabase = await openEngineWorkspace(storage, forkWorkspace);
      const forkPlugin = await resolvePluginProvider(forkWorkspace, asStorageDatabase(forkDatabase));
      if (!forkPlugin) throw new Error("fork target plugin resolution unexpectedly failed");

      // Attempt the fork with a fault injected immediately after the source
      // layer is durably committed -- simulating ANY failure between that
      // commit and a successful publish, exactly the shape of the real
      // incident (a failure discovered several steps later, at the donor-row
      // copy stage).
      const forkOutcome = await attemptWorkspaceFork({
        workspace: forkWorkspace,
        database: asStorageDatabase(forkDatabase),
        storage: asDurableStorage(storage),
        registry,
        plugin: forkPlugin,
        fail_after_source_commit_for_test: "simulated post-commit failure for regression test",
      });
      expect(forkOutcome.status).toBe("skipped");
      if (forkOutcome.status === "skipped") expect(forkOutcome.reason).toBe("simulated post-commit failure for regression test");
      // The fork must never have reached plugin analysis.
      expect(analyzedWorkspaceIds.has(forkWorkspace.workspace_id)).toBe(false);

      // The same scheduler job's fallback: a normal full scan on the SAME
      // already-open database immediately afterward, exactly as
      // `packages/daemon/src/runtime.ts`'s `scheduleWorkspaceScan` runs it
      // right after a non-"forked" `attemptWorkspaceFork` result. Before this
      // fix, the rollback was never invoked for this failure path, so the
      // source layer stayed committed with no published snapshot; this
      // fallback's own stage-1 re-observation then found nothing changed
      // (content-identical) and took the "equivalent, nothing to publish"
      // path with no prior snapshot to fall back to -- producing an empty
      // `snapshot_id` and making `registry.markReady` throw
      // `engine:workspace_snapshot_required`, permanently, on every retry.
      const fallbackResult = await runFullWorkspaceScan({ root: worktreeRoot, database: asStorageDatabase(forkDatabase), workspace_id: forkWorkspace.workspace_id, plugin: forkPlugin, inclusion_rules: FORK_INCLUSION_RULES });
      expect(fallbackResult.status).toBe("published");
      expect(fallbackResult.snapshot_id).toBeTypeOf("string");
      expect(fallbackResult.snapshot_id.length).toBeGreaterThan(0);
      // The exact call that threw in the real incident; it must now succeed.
      expect(() => registry.markReady(forkWorkspace.workspace_id, fallbackResult.snapshot_id, "ready")).not.toThrow();
      expect(analyzedWorkspaceIds.has(forkWorkspace.workspace_id)).toBe(true);
    } finally {
      if (donorDatabase) await donorDatabase.close().catch(() => undefined);
      if (forkDatabase) await forkDatabase.close().catch(() => undefined);
      if (storage) await storage.close();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(mainRoot, { recursive: true, force: true });
      if (worktreeRoot) await rm(worktreeRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("(bug 1) a donor with an extra untracked, gitignored file the scanner still enumerates skips the fork cleanly before any commit, and the fallback full scan publishes normally", async () => {
    const harness = await startHarness();
    try {
      const mainRoot = await mkdtemp(join(tmpdir(), "urdira-fork-bug1-main-"));
      await seedFixtureFiles(mainRoot);
      // Reproduces the real incident's exact shape: a generated,
      // gitignored-but-present file under a directory the scanner's
      // hard-coded excludes (node_modules/.git/dist/.urdira) do not cover --
      // `.husky/_/.gitignore` is npm/husky's own real-world example. Written
      // *before* the commit so `.gitignore` genuinely excludes it from git
      // (a fresh `git worktree add` checkout below therefore never has it),
      // while the scanner (which does not apply .gitignore --
      // `DEFAULT_FORK_GITIGNORE.enabled` is `false`) still enumerates it for
      // the donor's own scan.
      await writeFile(join(mainRoot, ".gitignore"), ".husky/_\n", "utf8");
      await mkdir(join(mainRoot, ".husky", "_"), { recursive: true });
      await writeFile(join(mainRoot, ".husky", "_", ".gitignore"), "*\n", "utf8");
      const sha = commitAll(mainRoot);
      const worktreeRoot = join(dirname(mainRoot), `urdira-fork-bug1-worktree-${randomUUID()}`);
      addWorktree(mainRoot, worktreeRoot, sha);

      const donor = await addWorkspaceAndWait(harness, mainRoot);
      expect(donor.status).toBe("ready");

      const forkTarget = await addWorkspaceAndWait(harness, worktreeRoot);
      expect(forkTarget.status).toBe("ready");
      // The donor's own cataloged source layer has one more file than the
      // fresh worktree's; the content-hash multiset predicate -- now
      // unconditional, not bypassed for a git-clean-same-commit donor -- must
      // reject the match before any commit, so the fallback runs a real scan.
      expect(harness.analyzedWorkspaceIds.has(forkTarget.workspace_id)).toBe(true);
    } finally {
      await stopHarness(harness);
    }
  }, 120_000);
});

// Regression coverage for a second real e2e incident (excalidraw donor + a
// same-commit detached `git worktree add` fork target, real content edit
// after a successful fork): appending a new, unrelated declaration to
// `packages/math/src/angle.ts` -- a file that itself owns real cross-file
// dependencies -- made the fork target's very next incremental rescan throw
// `core:dependency_validation_failed`/`owner_mismatch` inside `seal()`,
// permanently losing the edit (the scan degrades to the fork's own prior
// snapshot, and a subsequent watcher-triggered reconcile then republishes
// that SAME prior generation via its "equivalent, nothing to publish" fast
// path, so the workspace looks healthy while the edit is silently gone).
// Root cause, confirmed by direct repro against both a forked AND a
// perfectly ordinary (non-forked) workspace: `candidate-materialization.ts`'s
// `validateBindings` builds `promotedDependencies`' `owner_artifact_id`/
// `owner_artifact_version_id` from the proposing record's *replacement scope*
// (`owners.get(dependency.proposal_record_key)`, this scan's fresh owner),
// but then validates every dependency's owner against `ownerOf(dependency.record_id)`,
// which prefers a *base* row's actual, immutable, stored owner when one
// exists. Those two disagree exactly when the record the dependency is
// attached to was *reused* this scan (decision 11: unchanged content keeps
// its existing `record_id`, and a record row's `owner_artifact_id`/
// `owner_artifact_version_id` are never rewritten once opened) while its
// *file* still changed enough to mint a new artifact_version_id -- e.g. a
// class whose own body is untouched, in a file that gained an unrelated
// sibling declaration. This is not fork-specific in root cause (any
// incremental scan, forked or not, can reuse a record while re-proposing its
// unchanged dependency), but no test before this one exercised a reused
// record with a re-proposed cross-file dependency at all -- this feature's
// own incremental-after-fork test (e), above, edited a file
// (`domain/errors.ts`) with zero outgoing cross-file dependencies, so it
// never stressed this path. Fixed by deriving `promotedDependencies`' owner
// from the same `ownerOf(recordId)` the validation itself uses, instead of
// from the scope's own (possibly stale-on-reuse) owner.
describe("Workspace fork dependency-owner regression (real-world e2e finding)", () => {
  it("(bug 3) an incremental scan after a fork correctly publishes an edit to a file that owns cross-file dependencies, even when one of its own declarations is reused unchanged", async () => {
    const harness = await startHarness();
    try {
      const mainRoot = await mkdtemp(join(tmpdir(), "urdira-fork-dep-owner-main-"));
      await cp(fullFixtureRoot, mainRoot, { recursive: true });
      const sha = commitAll(mainRoot);
      const worktreeRoot = join(dirname(mainRoot), `urdira-fork-dep-owner-worktree-${randomUUID()}`);
      addWorktree(mainRoot, worktreeRoot, sha);

      const donor = await addWorkspaceAndWait(harness, mainRoot);
      expect(donor.status).toBe("ready");
      const forkTarget = await addWorkspaceAndWait(harness, worktreeRoot);
      expect(forkTarget.status).toBe("ready");
      // Proof this really forked (mirrors test (a)+(b) above), not an
      // independent full analysis that happened to produce the same result.
      expect(harness.analyzedWorkspaceIds.has(forkTarget.workspace_id)).toBe(false);
      const beforeSettled = await pollUntilSettled(harness.client, forkTarget.workspace_id);
      const beforeNames = await findRecordNames(harness.client, forkTarget.workspace_id);

      // `InMemoryTaskRepository` (the class in this file) owns real
      // cross-file dependencies with cross-file spans: it `implements
      // TaskRepository` and uses `Task`/`CreateTaskInput`/`TaskStatus`, all
      // declared in `../domain/task.js`. Appending a sibling, unrelated
      // function to the SAME file is a real content change (the file's own
      // artifact_version_id bumps) that leaves `InMemoryTaskRepository`'s own
      // declaration byte-identical, so its record is reused while its
      // (unchanged) outgoing dependency is still re-proposed by the JS/TS
      // plugin as part of re-analyzing the file -- exactly the shape the
      // real-world incident hit.
      const repoPath = join(worktreeRoot, "src", "repository", "in-memory-task-repository.ts");
      const original = await readFile(repoPath, "utf8");
      await writeFile(repoPath, `${original}\nexport function describeRepository(): string { return "in-memory task repository"; }\n`, "utf8");

      const reindexed = await harness.client.call("core:reindex", { args: [forkTarget.workspace_id] });
      expect(reindexed.outcome).toBe("success");
      const settled = await pollUntilSettled(harness.client, forkTarget.workspace_id);
      expect(settled.workspace_status).toBe("ready");
      // The load-bearing assertion: `workspace_status: "ready"` alone does
      // NOT prove the edit published (see the file-level comment above for
      // why a failed seal can still leave the workspace looking "ready").
      // A genuinely new generation is the only real proof the incremental
      // scan actually succeeded rather than silently degrading and
      // re-confirming the fork's own prior snapshot.
      expect(settled.current_snapshot_id).not.toBe(beforeSettled.current_snapshot_id);
      expect(harness.analyzedWorkspaceIds.has(forkTarget.workspace_id)).toBe(true);

      // And the new declaration -- not merely "some new generation", but
      // this specific edit -- must actually be queryable, plus every
      // previously-published declaration (proving the reused, dependency-owning
      // record survived correctly, not merely that validation stopped
      // throwing).
      const afterNames = await findRecordNames(harness.client, forkTarget.workspace_id);
      expect(afterNames).toEqual(expect.arrayContaining([...beforeNames]));
      expect(afterNames.some((entry) => entry.endsWith(":InMemoryTaskRepository"))).toBe(true);
    } finally {
      await stopHarness(harness);
    }
  }, 120_000);
});

// Regression coverage for a third real e2e incident (excalidraw donor + a
// same-commit detached `git worktree add` fork target), one stage further
// than "(bug 3)" above: with that fix applied, the fork target's incremental
// `seal()` succeeded, but the *publish* immediately after it threw
// `storage:publication_conflict` from `assertPublicationImmutableRows`
// (`packages/storage/src/publication-authority.ts`) -- on every retry, so
// the edit never published. That function byte-compares every row an
// ordinary (non-fork) publish is about to write against whatever the SAME
// row already holds; a conflict there means *something* the fork's own
// generation-1 publish wrote for that row differs from what the ordinary
// path would independently compute for the same logical content.
//
// `assertPublicationImmutableRows`'s own `conflict()` used to throw with
// empty `details: {}`, making every real conflict a from-scratch diagnostic
// exercise -- fixed alongside this test to attach `{table, row_id,
// mismatched_fields}` (see `mismatchedFields`, exported next to `rowMatches`
// in `publication-authority.ts`), so any *future* divergence is
// diagnosable from the thrown error alone, not just from re-instrumenting
// the function by hand.
//
// This test could not reproduce the actual conflict by running a real
// second scan against this repository's own (much smaller) task-planner
// fixture -- confirmed by trying both the test-only, non-memoizing plugin
// resolver AND the real, memoizing one (`apps/urdira/src/index.ts`'s
// `createResolveJavascriptTypescriptPluginProvider`, which caches
// `{registry, resolution_lock, configuration}` per workspace id and reuses
// the identical object across every scan of that workspace) -- whatever
// excalidraw's own registry/plugin-resolution content does differently at
// scale was not reproducible from this fixture. So instead of asserting
// through a second scan (which would only catch a divergence if this
// fixture happened to trigger it), this test asserts the underlying
// invariant `assertPublicationImmutableRows` itself enforces, directly and
// unconditionally: every registry/control-plane row the fork wrote for its
// own generation 1 must be byte-identical to what a fresh, independent
// encoding of the SAME plugin-resolution values (`forkPlugin.registry`/
// `resolution_lock`/`configuration`) would produce -- exactly
// `assertPublicationImmutableRows`'s own "registry snapshot" and "control
// state" comparisons, reproduced here with `rowMatches` (the same function
// it calls). A byte-identical result here does not prove no future
// divergence is possible at excalidraw's scale, but it does mean ANY
// divergence introduced by a future change to the fork's own registry/
// control-plane writes (`copyDonorAndPublish`'s `putSnapshot` call,
// `buildForkPublicationPlan`'s `targetControlCommands`) fails this test
// immediately, rather than only surfacing on a real, hard-to-reproduce
// repository months later.
describe("Workspace fork publication-conflict regression (real-world e2e finding)", () => {
  it("(bug 4) the fork's own registry and control-plane rows are byte-identical to what an ordinary publish would independently compute for the same plugin resolution", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-fork-pubconflict-data-"));
    const mainRoot = await mkdtemp(join(tmpdir(), "urdira-fork-pubconflict-main-"));
    let worktreeRoot: string | undefined;
    let storage: DurableStorage | undefined;
    let donorDatabase: WorkspaceDatabase | undefined;
    let forkDatabase: WorkspaceDatabase | undefined;
    try {
      await cp(fullFixtureRoot, mainRoot, { recursive: true });
      const sha = commitAll(mainRoot);
      worktreeRoot = join(dirname(mainRoot), `urdira-fork-pubconflict-worktree-${randomUUID()}`);
      addWorktree(mainRoot, worktreeRoot, sha);

      storage = await createDurableStorage({ rootDir: dataRoot });
      const registry = new WorkspaceRegistry();
      const analyzedWorkspaceIds = new Set<string>();
      const resolvePluginProvider = buildPluginProviderResolver(analyzedWorkspaceIds);

      const donorWorkspace = await registerEngineWorkspace(registry, mainRoot, "donor");
      donorDatabase = await openEngineWorkspace(storage, donorWorkspace);
      const donorPlugin = await resolvePluginProvider(donorWorkspace, asStorageDatabase(donorDatabase));
      if (!donorPlugin) throw new Error("donor plugin resolution unexpectedly failed");
      const donorResult = await runFullWorkspaceScan({ root: mainRoot, database: asStorageDatabase(donorDatabase), workspace_id: donorWorkspace.workspace_id, plugin: donorPlugin, inclusion_rules: FORK_INCLUSION_RULES });
      registry.markReady(donorWorkspace.workspace_id, donorResult.snapshot_id, "ready");

      const forkWorkspace = await registerEngineWorkspace(registry, worktreeRoot, "fork-target");
      forkDatabase = await openEngineWorkspace(storage, forkWorkspace);
      const forkPlugin = await resolvePluginProvider(forkWorkspace, asStorageDatabase(forkDatabase));
      if (!forkPlugin) throw new Error("fork target plugin resolution unexpectedly failed");

      const forkOutcome = await attemptWorkspaceFork({ workspace: forkWorkspace, database: asStorageDatabase(forkDatabase), storage: asDurableStorage(storage), registry, plugin: forkPlugin, verify_mode: "full" });
      expect(forkOutcome.status).toBe("forked");
      expect(analyzedWorkspaceIds.has(forkWorkspace.workspace_id)).toBe(false);

      // Exactly `assertPublicationImmutableRows`'s own "registry snapshot"
      // comparison (`publication-authority.ts`), rebuilt here from
      // `forkPlugin`'s own values -- what an ordinary publish for this same
      // workspace, at this same plugin resolution, would independently
      // expect the stored row to equal.
      const workspaceId = forkWorkspace.workspace_id;
      const registryRow = await forkDatabase.database.get<Record<string, unknown>>("SELECT * FROM registry_snapshots WHERE workspace_id = ? AND registry_snapshot_id = ?", [workspaceId, forkPlugin.registry_snapshot_id]);
      expect(registryRow).toBeDefined();
      const expectedRegistry = {
        registry_snapshot_id: forkPlugin.registry.registry_snapshot_id,
        workspace_id: workspaceId,
        registry_contract_version: forkPlugin.registry.registry_contract_version,
        core_registry_digest: forkPlugin.registry.core_registry_digest,
        resolution_lock_id: forkPlugin.resolution_lock.resolution_lock_id,
        registry_digest: forkPlugin.registry.registry_digest,
        registry_payload: encodeCanonical(forkPlugin.registry),
      };
      if (registryRow !== undefined && !rowMatches(registryRow, expectedRegistry)) throw new Error(`registry_snapshots diverges from the ordinary path's own expected encoding: ${mismatchedFields(registryRow, expectedRegistry).join(",")}`);

      const controlChecks: readonly [string, string, unknown][] = [
        [`plugin_resolution_lock:${forkPlugin.resolution_lock.resolution_lock_id}`, "plugin_resolution_lock", forkPlugin.resolution_lock],
        [`workspace_configuration_revision:${forkPlugin.configuration.configuration_revision_id}`, "workspace_configuration_revision", forkPlugin.configuration],
      ];
      for (const [key, stateKind, value] of controlChecks) {
        const row = await forkDatabase.database.get<Record<string, unknown>>("SELECT * FROM control_plane_state WHERE workspace_id = ? AND state_key = ?", [workspaceId, key]);
        expect(row).toBeDefined();
        const expected = { state_key: key, workspace_id: workspaceId, state_kind: stateKind, payload: encodeCanonical(value), reference_workspace_id: null, reference_snapshot_id: null, reference_source_state_digest: null };
        if (row !== undefined && !rowMatches(row, expected)) throw new Error(`control_plane_state[${key}] diverges from the ordinary path's own expected encoding: ${mismatchedFields(row, expected).join(",")}`);
      }
    } finally {
      if (donorDatabase) await donorDatabase.close().catch(() => undefined);
      if (forkDatabase) await forkDatabase.close().catch(() => undefined);
      if (storage) await storage.close();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(mainRoot, { recursive: true, force: true });
      if (worktreeRoot) await rm(worktreeRoot, { recursive: true, force: true });
    }
  }, 120_000);

  // Direct end-to-end reproduction of the real e2e incident's exact shape --
  // "(bug 4)" above asserts the underlying byte-equality invariant
  // unconditionally, but this test reproduces the actual failure mode:
  // `apps/urdira/src/index.ts`'s real `resolve_plugin_provider`
  // (`createResolveJavascriptTypescriptPluginProvider`) memoizes
  // `{registry, resolution_lock, configuration}` only in an in-process `Map`
  // -- this test file's own `buildPluginProviderResolver` test helper uses a
  // module-level constant `now`, so it can never exercise the actual root
  // cause (a *fresh* `now = new Date().toISOString()` on every daemon
  // process start) at all, hence the real `defaultDaemonOptions` provider
  // and a genuine daemon restart here, not the lighter test-only harness the
  // other tests in this file use. Before the fix in
  // `apps/urdira/src/index.ts` (`prepareJavascriptTypescriptRegistry` reads
  // back any already-persisted `plugin_resolution_lock` via
  // `readPersistedControlState` and passes it as `existing_lock`, and the
  // configuration's own `created_at` is derived from the now-stable lock
  // instead of a fresh `now`), this reliably threw
  // `storage:publication_conflict` on the `plugin_resolution_lock`
  // control-plane row for ANY workspace rescanned in a different daemon
  // process than the one that first scanned it -- fork or not; reproduced
  // here specifically for a forked workspace, since that is what the real
  // e2e incident hit.
  it("(bug 5) an incremental scan after a fork still publishes correctly even when the daemon restarts between the fork and the rescan", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-fork-restart-data-"));
    const mainRoot = await mkdtemp(join(tmpdir(), "urdira-fork-restart-main-"));
    let runtime: DaemonRuntime | undefined;
    let worktreeRoot: string | undefined;
    try {
      await cp(fullFixtureRoot, mainRoot, { recursive: true });
      const sha = commitAll(mainRoot);
      worktreeRoot = join(dirname(mainRoot), `urdira-fork-restart-worktree-${randomUUID()}`);
      addWorktree(mainRoot, worktreeRoot, sha);

      runtime = await DaemonRuntime.start(await withHashEmbeddingsProvider(() => defaultDaemonOptions(dataRoot)));
      let client = new DaemonClient(runtime.endpoint, { request_timeout_ms: 120_000 });

      const donorAdd = await client.call("core:workspace_add", { args: [mainRoot], confirmed: true, selected_technology_ids: ["typescript"], selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID] });
      expect(donorAdd.outcome).toBe("success");
      const donorId = (donorAdd.payload as { readonly workspace_id: string }).workspace_id;
      expect((await pollUntilSettled(client, donorId)).workspace_status).toBe("ready");

      const forkAdd = await client.call("core:workspace_add", { args: [worktreeRoot], confirmed: true, selected_technology_ids: ["typescript"], selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID] });
      expect(forkAdd.outcome).toBe("success");
      const forkId = (forkAdd.payload as { readonly workspace_id: string }).workspace_id;
      const forkSettled = await pollUntilSettled(client, forkId);
      expect(forkSettled.workspace_status).toBe("ready");

      // The daemon restart: a fresh process, a fresh (empty) in-process
      // `resolvePluginProvider` memoization cache, but the SAME persistent
      // data_root -- exactly what separated the fork's own generation-1
      // publish from the incremental rescan's publish in the real incident.
      await runtime.stop();
      runtime = await DaemonRuntime.start(await withHashEmbeddingsProvider(() => defaultDaemonOptions(dataRoot)));
      client = new DaemonClient(runtime.endpoint, { request_timeout_ms: 120_000 });

      const repoPath = join(worktreeRoot, "src", "repository", "in-memory-task-repository.ts");
      const original = await readFile(repoPath, "utf8");
      await writeFile(repoPath, `${original}\nexport function describeRepository(): string { return "in-memory task repository"; }\n`, "utf8");
      const reindexed = await client.call("core:reindex", { args: [forkId] });
      expect(reindexed.outcome).toBe("success");
      const settled = await pollUntilSettled(client, forkId);
      expect(settled.workspace_status).toBe("ready");
      // The load-bearing assertion (see the "(bug 3)" test above for why
      // `workspace_status: "ready"` alone does not prove the edit
      // published): a genuinely new generation.
      expect(settled.current_snapshot_id).not.toBe(forkSettled.current_snapshot_id);
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(mainRoot, { recursive: true, force: true });
      if (worktreeRoot) await rm(worktreeRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
