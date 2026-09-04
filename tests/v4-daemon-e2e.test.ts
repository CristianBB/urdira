import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
 * End-to-end coverage for task P2-7 (plan `resilient-knitting-twilight.md`
 * §1/§9): starts a REAL daemon runtime with `URDIRA_V4=1`, wired to the REAL
 * `urdira-indexing-worker` binary and the REAL native structural-store addon
 * (both built by `node scripts/build-native.mjs`, no fake transport), scans
 * the small `tests/fixtures/codebases/typescript/task-planner` fixture's
 * `task.ts`/`errors.ts` pair, waits for `structural_ready`, and runs
 * `core:find_records`/`core:resolve_symbol`/`core:find_references`/
 * `core:get_source`/`core:search_text` through the daemon's public IPC
 * surface -- then repeats the SAME two queries against a v3 index of the
 * IDENTICAL two files (the same TS-oracle harness
 * `tests/phase-daemon-indexing-integration.test.ts` already uses and
 * validates) and asserts the entity names/record ids the contract says must
 * match actually do.
 *
 * Gated on the release artifacts actually existing (`describe.skip` with an
 * always-on companion test that prints a build hint), per this task's own
 * instructions and `tests/v4-scan.test.ts`'s precedent -- CI/dev machines
 * without a Rust toolchain run this suite skipped, not broken.
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
const now = "2026-09-02T00:00:00.000Z";

function asDaemonWorkspaceRegistry(registry: WorkspaceRegistry): NonNullable<DaemonRuntimeOptions["workspace_registry"]> {
  return registry as unknown as NonNullable<DaemonRuntimeOptions["workspace_registry"]>;
}

async function pollUntil(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition did not become true within ${timeoutMs} ms.`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

type StreamPage = { readonly items: ReadonlyArray<{ readonly value: unknown }>; readonly next_cursor?: string; readonly has_next: boolean };

/** Runs one `core:query` operation and returns its RAW `streams` map (keyed by stream name, per `packages/contracts/src/registries.ts`'s per-operation `streams` list -- e.g. `core:resolve_symbol` has BOTH `declarations` and `candidates`; `core:find_references` has BOTH `references` and `owners`). Flattening to "the first stream" is wrong for any multi-stream operation: JSON key order is insertion order, not alphabetical or schema order, so the first key is not reliably the interesting one. */
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

/** Convenience wrapper for a single-stream operation (`core:find_records`/`core:get_source`) -- returns that one stream's decoded item values. */
async function queryOneStream(client: DaemonClient, workspaceId: string, operation: string, args: Record<string, unknown>, streamName: string): Promise<ReadonlyArray<Record<string, unknown>>> {
  const streams = await queryStreams(client, workspaceId, operation, args);
  return (streams[streamName]?.items ?? []).map((item) => item.value as Record<string, unknown>);
}

/**
 * P1-D-c: like `queryStreams`, but returns the FULL `core:query` payload
 * (streams AND `completeness`) -- `queryStreams` discards everything but
 * `streams`, which is fine for every other test in this file (none of them
 * assert on completeness), but this task's own deliverable 4 needs the
 * completeness report directly.
 */
async function queryFull(client: DaemonClient, workspaceId: string, operation: string, args: Record<string, unknown>): Promise<{ readonly streams: Readonly<Record<string, StreamPage>>; readonly completeness: { readonly overall_status: string; readonly dimensions: ReadonlyArray<{ readonly status: string; readonly reason_codes: ReadonlyArray<string> }> } }> {
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
  return response.payload as never;
}

function recordName(value: Record<string, unknown>): string | undefined {
  const body = value["body"] as Record<string, unknown> | undefined;
  const name = body?.["name"];
  return typeof name === "string" ? name : undefined;
}

async function pollUntilStructuralReady(client: DaemonClient, workspaceId: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    const response = await client.call("core:index_status", { workspace_ids: [workspaceId] });
    if (response.outcome === "success") {
      const payload = response.payload as { readonly workspaces: ReadonlyArray<Record<string, unknown>> };
      last = payload.workspaces[0];
      if (last?.["structural_ready"] === true) return last;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Workspace ${workspaceId} did not reach structural_ready within ${timeoutMs}ms (last observed: ${JSON.stringify(last)}).`);
}

async function seedFixtureWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-v4-e2e-workspace-"));
  await mkdir(workspaceRoot, { recursive: true });
  for (const file of ["task.ts", "errors.ts"]) {
    await writeFile(join(workspaceRoot, file), await readFile(join(fixtureRoot, file), "utf8"), "utf8");
  }
  return workspaceRoot;
}

// --- v3 comparison harness: verbatim adaptation of the real-analysis TS
// worker harness `tests/phase-daemon-indexing-integration.test.ts` already
// validates against this exact fixture pair; duplicated here (rather than
// imported, since none of it is exported from that file) so this file has
// no test-to-test import dependency. ---

interface PreparedRegistry {
  readonly registry: AssembledPluginRegistry;
  readonly lock: SdkPluginResolutionLock;
  readonly plugin: DiscoveredPluginPackage;
}

async function prepareRegistry(workspaceId: string): Promise<PreparedRegistry> {
  const digests = createCanonicalPluginDigestAuthority();
  const encoder = new TextEncoder();
  const assets = [
    { normalized_relative_path: "dist/worker.mjs", bytes: encoder.encode("urdira v4-daemon-e2e jsts worker"), executable: true, role: "parser" as const },
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

async function pollUntilReady(client: DaemonClient, workspaceId: string, timeoutMs = 120_000): Promise<{ readonly workspace_status: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: { readonly workspace_status: string } | undefined;
  while (Date.now() < deadline) {
    const response = await client.call("core:index_status", { workspace_ids: [workspaceId] });
    if (response.outcome === "success") {
      const payload = response.payload as { readonly workspaces: ReadonlyArray<{ readonly workspace_status: string }> };
      last = payload.workspaces[0];
      if (last?.workspace_status === "ready" || last?.workspace_status === "degraded") return last;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Workspace ${workspaceId} did not leave "indexing" within ${timeoutMs}ms (last observed: ${JSON.stringify(last)}).`);
}

const describeIfBuilt = hasReleaseArtifacts ? describe : describe.skip;

it.skipIf(hasReleaseArtifacts)("v4 daemon e2e is skipped: build the release artifacts first", () => {
  console.warn(
    `[urdira] tests/v4-daemon-e2e.test.ts skipped -- missing worker (${workerPath ?? "no host target"}) or native addon (${nativeAddonPath ?? "no host target"}). ` +
    "Build them with: node scripts/build-native.mjs",
  );
});

describeIfBuilt("v4 daemon end-to-end (real urdira-indexing-worker + native structural store)", () => {
  it("scans task-planner's task.ts/errors.ts through the real Rust worker and answers real queries, matching a v3 index of the same files", async () => {
    // --- v4 side: real worker, real native addon, real daemon RPC. ---
    const v4DataRoot = await mkdtemp(join(tmpdir(), "urdira-v4-e2e-data-"));
    const v4WorkspaceRoot = await seedFixtureWorkspace();
    let v4Runtime: DaemonRuntime | undefined;
    const v4Sessions = new Map<string, IndexingCoreProcessTransport>();
    try {
      process.env["URDIRA_V4"] = "1";
      v4Runtime = await DaemonRuntime.start({
        data_root: v4DataRoot,
        engine_build_id: "build-v4-daemon-e2e",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        resolve_plugin_provider: async () => { throw new Error("resolve_plugin_provider must not be called for a v4 workspace."); },
        resolve_workspace_scan_transport: async (workspace) => {
          let transport = v4Sessions.get(workspace.workspace_id);
          if (transport === undefined) {
            transport = createIndexingCoreProcessTransport({ command: workerPath!, request_timeout_ms: 120_000 });
            v4Sessions.set(workspace.workspace_id, transport);
          }
          return transport;
        },
        semantic_index: false,
        reconciliation_sweep_interval_ms: 0,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
      });
      const v4Client = new DaemonClient(v4Runtime.endpoint, DAEMON_CLIENT_OPTIONS);
      const v4Added = await v4Client.call("core:workspace_add", { args: [v4WorkspaceRoot], confirmed: true });
      expect(v4Added.outcome).toBe("success");
      const v4WorkspaceId = (v4Added.payload as { readonly workspace_id: string }).workspace_id;
      await pollUntilStructuralReady(v4Client, v4WorkspaceId);

      const v4Types = await queryOneStream(v4Client, v4WorkspaceId, "core:find_records", { selector: { record_categories: ["entity"], kind_selector: { universal_kinds: ["core:type"] }, filter: { languages: ["typescript"] } } }, "records");
      const v4TypeNames = v4Types.map(recordName).filter((name): name is string => name !== undefined);
      expect(v4TypeNames.length).toBeGreaterThan(0);
      expect(v4TypeNames).toEqual(expect.arrayContaining(["TaskNotFoundError", "InvalidTaskTransitionError"]));

      // `core:resolve_symbol` has TWO streams (`declarations`, `candidates`);
      // the confirmed declaration is what this test needs.
      const v4ResolvedStreams = await queryStreams(v4Client, v4WorkspaceId, "core:resolve_symbol", { reference: "InvalidTaskTransitionError", resolution_scope: "exports" });
      const v4Declarations = (v4ResolvedStreams["declarations"]?.items ?? []).map((item) => item.value as Record<string, unknown>);
      expect(v4Declarations.length).toBeGreaterThan(0);
      expect(recordName(v4Declarations[0]!)).toBe("InvalidTaskTransitionError");
      const v4EntityId = v4Declarations[0]!["record_id"];

      // Gap A2 (task P2-2d, fixed in `crates/urdira-native-node/src/
      // structural_store_napi.rs`'s `to_output`): the native port now
      // reconstructs `identity_id`/`identity_key` directly from the
      // store's own `identity_type`/`identity_id`/`identity_key` fields
      // (no `text_sidecar.json` needed -- the v4 Rust pipeline never
      // writes one), so a v4 declaration carries a real `entity_id`
      // (`canonical-query-data-port.ts`'s `${subjectType}_id` aliasing of
      // `identity_id`) exactly like a v3 one does.
      expect(v4Declarations[0]!["entity_id"]).toMatch(/^entity:[0-9a-f]{64}$/);
      expect(v4Declarations[0]!["identity_key"]).toBe("jsts:class:errors.ts:183:InvalidTaskTransitionError");

      // A4 (line numbers task, 2026-09-05): a declaration's own
      // `source_span` now carries a real 1-based `start_line`/`end_line`
      // (`urdira-jsts-syntax-worker`'s per-file `LineIndex`, threaded all
      // the way through the native store's `RecordRow.span_start_line`/
      // `span_end_line` to `recordValue`'s `source_span` here) -- verified
      // by independently counting newlines in the fixture's own text up to
      // the SAME `start_byte`/`end_byte` this span already carries, rather
      // than trusting the producer's own arithmetic.
      const v4DeclarationSpan = v4Declarations[0]!["source_span"] as
        | { readonly start_byte?: string; readonly end_byte?: string; readonly start_line?: string; readonly end_line?: string }
        | undefined;
      expect(v4DeclarationSpan?.start_line).toBeDefined();
      expect(v4DeclarationSpan?.end_line).toBeDefined();
      const errorsText = await readFile(join(fixtureRoot, "errors.ts"), "utf8");
      expect(v4DeclarationSpan!.start_line).toBe(String(errorsText.slice(0, Number(v4DeclarationSpan!.start_byte)).split("\n").length));
      expect(v4DeclarationSpan!.end_line).toBe(String(errorsText.slice(0, Number(v4DeclarationSpan!.end_byte)).split("\n").length));

      const v4Search = await queryOneStream(v4Client, v4WorkspaceId, "core:search_text", { pattern: "InvalidTaskTransitionError", syntax: "literal", case_sensitive: true, word_mode: "identifier", result_projection: "record" }, "matches");
      expect(v4Search.length).toBeGreaterThan(0);

      const v4Source = await queryOneStream(v4Client, v4WorkspaceId, "core:get_source", { subjects: [{ subject_type: "symbol", name: "InvalidTaskTransitionError", context_artifact: "errors.ts" }], source: { mode: "body", max_characters_per_snippet: 4_000, max_total_characters: 16_000, context_lines: 0 } }, "sources");
      expect(v4Source.length).toBeGreaterThan(0);

      // Gap A1 (task P2-2d): `core:find_records` with `record_categories:
      // ["relation"]` DOES materialize relation-category records for this
      // fixture (`jsts:relation_contains`/`jsts:relation_references`) --
      // the v4 Rust cold-scan pipeline's facts/hybrid-semantics lanes were
      // never the actual problem. The real bug was downstream, in
      // `crates/urdira-native-node/src/structural_store_napi.rs`'s
      // `adjacency` napi method: it looked up graph adjacency by
      // `sha256(caller_subject_text)`, a scheme only the v3-conversion
      // path's `NativeStoreBuilder` writer actually uses -- the v4 native
      // pipeline's own writer (`materialize.rs`'s `resolve_subject_key`)
      // interns each relation endpoint's RAW `record_id` bytes directly,
      // un-hashed, so no v4 adjacency lookup (and therefore no
      // `core:find_references`/`core:get_outline`/`core:expand_relations`/
      // `core:find_paths`) ever found anything. Fixed by also trying the
      // caller's subject text hex-decoded directly (`parse_hex32`) as a
      // second candidate key, and by reconstructing each edge's endpoint
      // subject-id text from the store's own `dicts.subjects` digest
      // (`"record:{hex}"`) instead of only the (for v4, always-empty)
      // text sidecar.
      const v4Relations = await queryOneStream(v4Client, v4WorkspaceId, "core:find_records", { selector: { record_categories: ["relation"] } }, "records");
      expect(v4Relations.length).toBeGreaterThan(0);
      const v4RelationKinds = new Set(v4Relations.map((record) => record["kind"]));
      expect(v4RelationKinds.has("jsts:relation_contains")).toBe(true);
      expect(v4RelationKinds.has("jsts:relation_references")).toBe(true);

      // A2 (pending.sites migration, additive): this fixture's non-
      // identifier-callee calls (e.g. a method call whose receiver v4's
      // checker-free lane never attempts) no longer publish ANY relation
      // record at all when they have no resolved target -- that population
      // moved out of `core:find_records` entirely, into the store's own
      // `pending.sites` side table (consumed by the residual tsgo pass, not
      // the query engine). So: every `jsts:relation_call` record this query
      // DOES return must carry a real `target_id` (confirmed, or a P2-2j
      // per-candidate `classification: "possible"` row for an overload/
      // union receiver -- the only kind of `"possible"` row that can still
      // exist as a record, and it always carries a `target_id` + `reason`).
      // v4 still emits NO diagnostic-category records at all (the paired
      // `jsts:unresolved_call` diagnostic was folded away 2026-09-04, before
      // its own record population was migrated out too).
      const v4CallRelations = v4Relations.filter((record) => record["kind"] === "jsts:relation_call");
      for (const record of v4CallRelations) {
        expect(record["body"]).toHaveProperty("target_id");
      }
      const v4CandidateCalls = v4CallRelations.filter((record) => (record["body"] as { classification?: string } | undefined)?.classification === "possible");
      for (const record of v4CandidateCalls) {
        const reason = (record["body"] as { reason?: string } | undefined)?.reason;
        expect(["overload_ambiguous", "union_ambiguous"]).toContain(reason);
      }
      const v4Diagnostics = await queryOneStream(v4Client, v4WorkspaceId, "core:find_records", { selector: { record_categories: ["diagnostic"] } }, "records");
      expect(v4Diagnostics).toEqual([]);

      // `TaskStatus` (task.ts) IS referenced elsewhere in task.ts (the
      // `Task.status` field's type annotation) -- a real inbound edge this
      // fixture actually has, unlike `InvalidTaskTransitionError` (declared
      // but never referenced by name within these two files).
      const v4TaskStatusStreams = await queryStreams(v4Client, v4WorkspaceId, "core:resolve_symbol", { reference: "TaskStatus", resolution_scope: "exports" });
      const v4TaskStatusDecl = (v4TaskStatusStreams["declarations"]?.items ?? []).map((item) => item.value as Record<string, unknown>);
      expect(v4TaskStatusDecl.length).toBeGreaterThan(0);
      const v4TaskStatusRefs = await queryStreams(v4Client, v4WorkspaceId, "core:find_references", { target: { subject_type: "entity", entity_id: v4TaskStatusDecl[0]!["entity_id"] }, include_declarations: true });
      expect(v4TaskStatusRefs["references"]!.items.length).toBeGreaterThan(0);
      expect(v4TaskStatusRefs["references"]!.items.some((entry) => (entry.value as Record<string, unknown>)["kind"] === "jsts:relation_references")).toBe(true);

      // A4 (line numbers task): same check as the declaration above, but
      // for a RELATION record (`jsts:relation_references`) -- confirms the
      // line-number producer is wired for both `semantic_sites.rs`'s
      // relation builders and `lib.rs`'s entity builder, not just one.
      const v4ReferenceRecord = v4TaskStatusRefs["references"]!.items
        .map((entry) => entry.value as Record<string, unknown>)
        .find((record) => record["kind"] === "jsts:relation_references");
      expect(v4ReferenceRecord).toBeDefined();
      const v4ReferenceSpan = v4ReferenceRecord!["source_span"] as
        | { readonly start_byte?: string; readonly end_byte?: string; readonly start_line?: string; readonly end_line?: string }
        | undefined;
      expect(v4ReferenceSpan?.start_line).toBeDefined();
      expect(v4ReferenceSpan?.end_line).toBeDefined();
      const v4ReferencePath = (v4ReferenceRecord!["body"] as Record<string, unknown> | undefined)?.["path"];
      expect(typeof v4ReferencePath).toBe("string");
      const v4ReferenceText = await readFile(join(fixtureRoot, v4ReferencePath as string), "utf8");
      expect(v4ReferenceSpan!.start_line).toBe(String(v4ReferenceText.slice(0, Number(v4ReferenceSpan!.start_byte)).split("\n").length));
      expect(v4ReferenceSpan!.end_line).toBe(String(v4ReferenceText.slice(0, Number(v4ReferenceSpan!.end_byte)).split("\n").length));

      expect(typeof v4EntityId).toBe("string");
      const v4ReferenceStreams = await queryStreams(v4Client, v4WorkspaceId, "core:find_references", { target: { subject_type: "entity", entity_id: v4EntityId }, include_declarations: true });
      expect(v4ReferenceStreams["references"]).toBeDefined();
      expect(v4ReferenceStreams["owners"]).toBeDefined();
      // `InvalidTaskTransitionError` is declared but not referenced by name
      // elsewhere in this two-file fixture -- its only inbound edge is the
      // module's own `contains` relation (a real, non-empty answer, not
      // the "always empty regardless of target" symptom gap A1 used to
      // produce).
      expect(v4ReferenceStreams["references"]!.items.length).toBeGreaterThan(0);

      // --- v3 side: the exact same two files, through the proven TS-oracle
      // harness (`tests/phase-daemon-indexing-integration.test.ts`'s own
      // pattern), for the "results must match" comparison. ---
      // `maybeBootstrapV4Workspace` (`packages/daemon/src/runtime.ts`) checks
      // `process.env.URDIRA_V4` globally, not per-`DaemonRuntime` -- it must
      // be explicitly disabled before the v3 comparison daemon below
      // registers its own workspace, or that workspace would ALSO be
      // v4-bootstrapped and its scan would fail (no
      // `resolve_workspace_scan_transport` configured for this v3-only
      // runtime). v4 is now the default for a new workspace (`URDIRA_V4 !==
      // "0"`, decision 29's cutover) -- merely deleting the variable no
      // longer opts out, so this must set it to `"0"` rather than unset it.
      process.env["URDIRA_V4"] = "0";
      const v3DataRoot = await mkdtemp(join(tmpdir(), "urdira-v4-e2e-v3-data-"));
      const v3WorkspaceRoot = await seedFixtureWorkspace();
      let v3Runtime: DaemonRuntime | undefined;
      try {
        v3Runtime = await DaemonRuntime.start({
          data_root: v3DataRoot,
          engine_build_id: "build-v4-daemon-e2e-v3-comparison",
          workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
          plugin_catalog: [{ ...bundledPluginCatalogEntry, capability_declarations: JAVASCRIPT_TYPESCRIPT_CAPABILITIES }],
          resolve_plugin_provider: resolveV3PluginProvider,
          scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
        });
        const v3Client = new DaemonClient(v3Runtime.endpoint, DAEMON_CLIENT_OPTIONS);
        const v3Added = await v3Client.call("core:workspace_add", {
          args: [v3WorkspaceRoot], confirmed: true,
          selected_technology_ids: ["typescript"], selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
        });
        expect(v3Added.outcome).toBe("success");
        const v3WorkspaceId = (v3Added.payload as { readonly workspace_id: string }).workspace_id;
        await pollUntilReady(v3Client, v3WorkspaceId);

        const v3Types = await queryOneStream(v3Client, v3WorkspaceId, "core:find_records", { selector: { record_categories: ["entity"], kind_selector: { universal_kinds: ["core:type"] }, filter: { languages: ["typescript"] } } }, "records");
        const v3TypeNames = v3Types.map(recordName).filter((name): name is string => name !== undefined);

        const v3ResolvedStreams = await queryStreams(v3Client, v3WorkspaceId, "core:resolve_symbol", { reference: "InvalidTaskTransitionError", resolution_scope: "exports" });
        const v3Declarations = (v3ResolvedStreams["declarations"]?.items ?? []).map((item) => item.value as Record<string, unknown>);

        // Gap A2 (task P2-2d): `entity_id`/`identity_key` are not just
        // PRESENT for a v4 declaration (checked above) -- decision 11's
        // content-derived identity recipe is recipe-agnostic, so the SAME
        // symbol's identity must be BYTE-IDENTICAL whether it was produced
        // by v3's TypeScript-checker lane or v4's oxc-only lane. Verified
        // live before writing this assertion: both pipelines independently
        // compute `identity_key = "jsts:class:errors.ts:183:
        // InvalidTaskTransitionError"` and therefore the same `entity_id`.
        expect(v4Declarations[0]!["entity_id"]).toBe(v3Declarations[0]!["entity_id"]);
        expect(v4Declarations[0]!["identity_key"]).toBe(v3Declarations[0]!["identity_key"]);

        // P2-2e deliverable 3: `facet_rows` for a REAL v4 scan (not the
        // `NativeStoreBuilder` converter -- this whole `describe` block
        // runs the real `urdira-indexing-worker` binary end to end).
        // Before this task, `structural_store_napi.rs`'s `to_output` read
        // `facet_rows` EXCLUSIVELY from `text_sidecar.json`, which the v4
        // native pipeline never writes -- so a v4 record's `facets`
        // silently came back `[]` regardless of what facets it actually
        // carried, for EVERY record, unconditionally. `dicts.facet_names`
        // (populated by `urdira-indexing-worker`'s `materialize_generation`,
        // ordered by bit index -- see `FACET_ORDER`) fixes this.
        //
        // NOT compared for equality against v3's own facets here: verified
        // live (via `core:find_records`, which for BOTH ports resolves
        // through a path that attaches `record_facets` --
        // `records_by_selector` -> `queryRecordRows` ->
        // `attachRelationalValues` on the SQLite side, `to_output` on the
        // native side) that v3's `SqliteCanonicalQuerySnapshotPort` returns
        // an EMPTY `record_facets` set for `InvalidTaskTransitionError` in
        // this fixture, while v4 correctly reports
        // `{core:declaration, core:definition, core:member}` from the
        // SAME `FACET_ORDER` vocabulary
        // (`packages/plugin-javascript-typescript/src/registry-
        // contribution.ts`'s `entityFacets`/`relationFacets`, the source
        // both pipelines' facet lists are drawn from). This is a genuine,
        // pre-existing difference in whether/how the v3 JS/TS plugin
        // persists `record_facets` for a container entity versus how v4's
        // Rust `facets_bitmask` computes it -- orthogonal to typeflow and
        // to this task's `Dictionaries` change, and out of scope to fix
        // here (same convention this file already uses for the
        // `records_by_name` primary-source-span gap noted above: flagged,
        // not silently worked around). The assertion below is therefore
        // v4's own regression fix ("no longer silently empty"), not a
        // cross-port equality claim.
        const v4ErrorRecord = v4Types.find((record) => recordName(record) === "InvalidTaskTransitionError");
        expect(v4ErrorRecord).toBeDefined();
        const v4Facets = v4ErrorRecord!["facets"];
        expect(Array.isArray(v4Facets)).toBe(true);
        expect(new Set(v4Facets as readonly string[])).toEqual(
          new Set(["core:declaration", "core:definition", "core:member"]),
        );

        // Gap A1 (task P2-2d): the relation KINDS this fixture's pipeline
        // can produce without a TypeScript checker (`contains`/`references`,
        // both from lexically-certain lanes) must match v3's own answer for
        // the identical files -- checked as v4 ⊆ v3 over the NON-checker
        // kinds, since v3's checker pass ALSO resolves `extends Error`
        // (`jsts:relation_inherits`, `Error` is a global lib type v4's
        // checker-free resolver cannot see), call targets requiring type
        // information (`jsts:relation_call`), and its own synthetic
        // `jsts:relation_type_of` rows -- none of which either pipeline's
        // structural (non-checker) facts lane is expected to produce
        // identically, so those three kinds are excluded from this
        // comparison, matching this task's own carve-out
        // ("excluding checker-only kinds and diagnostics").
        //
        // P2-2i: v4 now ALSO emits `jsts:relation_call`/`_inherits`/
        // `_implements` rows with `classification: "possible"` for every
        // pending call/heritage site (the v3 parity fix this task's brief
        // describes) -- `v4RelationKinds` therefore now legitimately
        // contains those checker-only kinds too, where before this task it
        // never did (this fixture's own calls/heritage never resolved with
        // Rust-only certainty). Excluded from `v4RelationKinds` here the
        // same way `v3RelationKinds` already excludes them from the other
        // side, so this loop keeps checking exactly what it always checked
        // (the lexically-certain, non-checker kinds) and is not defeated by
        // the new possible-row kinds it was never meant to cover.
        const v3Relations = await queryOneStream(v3Client, v3WorkspaceId, "core:find_records", { selector: { record_categories: ["relation"] } }, "records");
        const CHECKER_ONLY_RELATION_KINDS = new Set(["jsts:relation_type_of", "jsts:relation_inherits", "jsts:relation_call", "jsts:relation_implements"]);
        const v3RelationKinds = new Set(v3Relations.map((record) => record["kind"]).filter((kind): kind is string => typeof kind === "string" && !CHECKER_ONLY_RELATION_KINDS.has(kind)));
        expect(v3RelationKinds.size).toBeGreaterThan(0);
        for (const kind of v4RelationKinds) {
          if (CHECKER_ONLY_RELATION_KINDS.has(kind as string)) continue;
          expect(v3RelationKinds.has(kind as string)).toBe(true);
        }

        // The contract this task's brief calls out: v4 and v3 must find the
        // SAME named entities for the identical source files (decision 11's
        // content-derived identity is meant to be recipe-agnostic) --
        // checked as "every v4 finding is confirmed by v3" (v4 ⊆ v3) rather
        // than set equality, because v3's TS-oracle harness ALSO runs the
        // real TypeScript checker's type-inference pass (`precision: "typed"`,
        // `jsts:structural_stage_3`) and reports synthetic "inferred type of
        // X" entries for every class/interface -- v4's cold pipeline only
        // implements the syntax + hybrid-semantics lanes (plan §4; no
        // checker-based type inference yet), so it correctly has FEWER
        // `core:type` entries, not different ones. This is expected,
        // documented scope, not a defect (see this task's evidence doc).
        expect(v3TypeNames).toEqual(expect.arrayContaining(v4TypeNames));
      } finally {
        await v3Runtime?.stop().catch(() => undefined);
        await rm(v3DataRoot, { recursive: true, force: true });
        await rm(v3WorkspaceRoot, { recursive: true, force: true });
      }
    } finally {
      // v4 is now the default (`URDIRA_V4 !== "0"`) -- restore to explicitly
      // disabled rather than unset, so any test that runs later in this same
      // worker process does not silently pick up v4 bootstrapping just
      // because this test's own `"1"` assignment (above) was removed.
      process.env["URDIRA_V4"] = "0";
      for (const transport of v4Sessions.values()) {
        await transport.shutdown().catch(() => undefined);
        await transport.terminate().catch(() => undefined);
      }
      await v4Runtime?.stop().catch(() => undefined);
      await rm(v4DataRoot, { recursive: true, force: true });
      await rm(v4WorkspaceRoot, { recursive: true, force: true });
    }
  }, 180_000);

  /**
   * P1-D-c (decision 28) deliverable 4's fixture e2e: a real daemon, real
   * worker binary, `URDIRA_V4_RESIDUAL=1` -- unlike every test above (which
   * seeds only `task.ts`/`errors.ts`, self-contained, no checker-only
   * cross-file dispatch), this one copies the FULL `task-planner` tree
   * (HARD RULE: the shared fixture is read-only, this test copies it, same
   * as `seedFixtureWorkspace` above), whose `class InMemoryTaskRepository
   * implements TaskRepository` (`repository/in-memory-task-repository.ts`)
   * is a genuine cross-file heritage clause the E1a-E3 hybrid lane leaves
   * `possible` in this exact fixture+compiler-options combination (verified
   * live: a debug run logged `upgraded=1 external=3 unresolved=5`, and this
   * ONE upgraded site is exactly this `implements` edge -- confirmed via
   * `core:find_records`; the interface-typed member-call sites this task's
   * evidence docs describe as the harder case stayed `possible` for reasons
   * not fully isolated in the time available, most likely `moduleResolution:
   * "Bundler"` vs. this fixture's `.js`-suffixed relative imports -- see the
   * evidence doc's own "Known gaps" section). `TaskRepository` and
   * `InMemoryTaskRepository` are both TOP-LEVEL entities `core:find_records`
   * surfaces directly (unlike a class/interface MEMBER, which v4's lane-1
   * extraction does not materialize as its own queryable entity record --
   * also documented there), so this scenario is provable end-to-end through
   * `core:find_references` without relying on unverified schema assumptions.
   */
  it("the residual pass upgrades a possible `implements` heritage edge to confirmed, and find_references/completeness_report reflect it", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-v4-e2e-residual-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-v4-e2e-residual-workspace-"));
    await cp(resolve(repoRoot, "tests/fixtures/codebases/typescript/task-planner/src"), workspaceRoot, { recursive: true });
    const originalV4Flag = process.env["URDIRA_V4"];
    const originalResidualFlag = process.env["URDIRA_V4_RESIDUAL"];
    let runtime: DaemonRuntime | undefined;
    const sessions = new Map<string, IndexingCoreProcessTransport>();
    try {
      process.env["URDIRA_V4"] = "1";
      // Forwarded to the real worker child process by
      // `indexing-core-process-transport.ts`'s spawn `env` block -- see
      // that file's own P1-D-c comment.
      process.env["URDIRA_V4_RESIDUAL"] = "1";
      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-v4-daemon-e2e-residual",
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

      // `TaskRepository` (`repository/task-repository.ts`) -- the
      // `implements` clause's TARGET once the residual pass confirms it.
      const repositoryInterfaceStreams = await queryStreams(client, workspaceId, "core:resolve_symbol", { reference: "TaskRepository", resolution_scope: "exports" });
      const repositoryInterfaceDecl = (repositoryInterfaceStreams["declarations"]?.items ?? []).map((item) => item.value as Record<string, unknown>);
      expect(repositoryInterfaceDecl.length).toBeGreaterThan(0);
      const repositoryInterfaceEntityId = repositoryInterfaceDecl[0]!["entity_id"];
      expect(typeof repositoryInterfaceEntityId).toBe("string");

      // --- Before the upgrade: `implements TaskRepository` has no target
      // yet -- since A2 (pending.sites migration) that means it is not a
      // relation RECORD at all any more (it lives in the store's own
      // `pending.sites` side table, invisible to `core:find_records`), so
      // the precondition this test can still observe through the query
      // engine is simply "no CONFIRMED `core:implements` row for
      // `InMemoryTaskRepository` exists yet". `find_references` on the
      // interface has no inbound heritage edge through it either (adjacency
      // only ever indexes a RESOLVED target -- residual.rs's own module
      // doc, "Store access without a body decoder"). ---
      const relationsBefore = await queryOneStream(client, workspaceId, "core:find_records", { selector: { record_categories: ["relation"] } }, "records");
      const confirmedImplementsBefore = relationsBefore.filter((record) => record["kind"] === "jsts:relation_implements" && (record["body"] as { classification?: string; source_id?: string } | undefined)?.classification === "confirmed" && ((record["body"] as { source_id?: string } | undefined)?.source_id ?? "").includes("InMemoryTaskRepository"));
      expect(confirmedImplementsBefore.length).toBe(0);
      const beforeResult = await queryFull(client, workspaceId, "core:find_references", { target: { subject_type: "entity", entity_id: repositoryInterfaceEntityId }, include_declarations: true });
      const referencesBefore = beforeResult.streams["references"]?.items ?? [];
      expect(referencesBefore.some((entry) => (entry.value as Record<string, unknown>)["kind"] === "jsts:relation_implements")).toBe(false);

      // --- Wait for the residual pass (background, outside the critical
      // path -- structural readiness above already settled without it). ---
      const upgradeDeadline = Date.now() + 60_000;
      let status: Record<string, unknown> | undefined;
      while (Date.now() < upgradeDeadline) {
        const response = await client.call("core:index_status", { workspace_ids: [workspaceId] });
        if (response.outcome === "success") {
          const payload = response.payload as { readonly workspaces: ReadonlyArray<Record<string, unknown>> };
          status = payload.workspaces[0];
          if (status?.["calls_upgraded"] === true) break;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
      }
      expect(status?.["calls_upgraded"]).toBe(true);
      const semanticUpgrade = status?.["semantic_upgrade"] as { readonly completed_generation?: number; readonly pending_sites?: number; readonly running: boolean } | undefined;
      expect(semanticUpgrade?.completed_generation).toBeGreaterThan(1);
      expect(semanticUpgrade?.running).toBe(false);

      // --- After the upgrade: `find_references` now returns the heritage
      // edge (a caller that was only `possible` before), confirmed, with
      // `InMemoryTaskRepository` as its source and a real `target_id`. ---
      const afterResult = await queryFull(client, workspaceId, "core:find_references", { target: { subject_type: "entity", entity_id: repositoryInterfaceEntityId }, include_declarations: true });
      const referencesAfter = afterResult.streams["references"]?.items ?? [];
      const implementsReferences = referencesAfter.filter((entry) => (entry.value as Record<string, unknown>)["kind"] === "jsts:relation_implements");
      expect(implementsReferences.length).toBeGreaterThan(0);
      for (const entry of implementsReferences) {
        const body = (entry.value as Record<string, unknown>)["body"] as { classification?: string; source_id?: string; target_id?: string } | undefined;
        expect(body?.classification).toBe("confirmed");
        expect(body?.source_id).toContain("InMemoryTaskRepository");
        expect(body?.target_id).toBe(repositoryInterfaceDecl[0]!["identity_key"] as string);
      }

      // The SAME edge is gone from the `possible` bucket (closed, not
      // merely superseded -- decision 11: a confirmed row is a NEW record,
      // the possible row's identity does not continue).
      const relationsAfter = await queryOneStream(client, workspaceId, "core:find_records", { selector: { record_categories: ["relation"] } }, "records");
      const possibleImplementsAfter = relationsAfter.filter((record) => record["kind"] === "jsts:relation_implements" && (record["body"] as { classification?: string; source_id?: string } | undefined)?.classification === "possible" && ((record["body"] as { source_id?: string } | undefined)?.source_id ?? "").includes("InMemoryTaskRepository"));
      expect(possibleImplementsAfter.length).toBe(0);
      expect(afterResult.completeness.overall_status).not.toBe("unsupported");
    } finally {
      if (originalV4Flag === undefined) delete process.env["URDIRA_V4"]; else process.env["URDIRA_V4"] = originalV4Flag;
      if (originalResidualFlag === undefined) delete process.env["URDIRA_V4_RESIDUAL"]; else process.env["URDIRA_V4_RESIDUAL"] = originalResidualFlag;
      await runtime?.stop().catch(() => undefined);
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 120_000);

  /**
   * C task (member entities at cold): `core:find_references` on a class
   * METHOD entity must already return a confirmed caller right after the
   * cold scan (`structural_ready`) -- `URDIRA_V4_RESIDUAL` is explicitly
   * left UNSET here, so no residual pass is ever scheduled for this
   * workspace, proving the COLD entity producer (not the residual pass) is
   * what makes the target queryable. A purpose-built, self-contained
   * fixture is used rather than extending the shared `task-planner` one:
   * none of `task.ts`/`errors.ts`/`main.ts`'s own method-dispatch calls are
   * typeflow-certain against a WORKSPACE class/interface member without
   * also depending on the residual pass or a constructor-parameter
   * property typeflow does not index (`main.ts`'s own `this.repository.*`
   * calls resolve only via the real checker, see the residual-pass test
   * above) -- so this test seeds a tiny file exercising typeflow's own
   * "declared type parameter member call" rule instead (`urdira-jsts-
   * syntax-worker::semantic_sites::tests::typeflow_resolves_a_declared_
   * type_parameter_member_call`): `class Greeter { greet() {} }` +
   * `function use(g: Greeter) { g.greet(...); }`.
   */
  it("core:find_references on a class method returns a confirmed caller right after the cold scan, before any residual pass", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-v4-e2e-member-entity-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-v4-e2e-member-entity-workspace-"));
    await writeFile(
      join(workspaceRoot, "greeter.ts"),
      "export class Greeter {\n  greet(name: string): string {\n    return `hi ${name}`;\n  }\n}\n\nexport function use(g: Greeter): string {\n  return g.greet(\"world\");\n}\n",
      "utf8",
    );
    const originalV4Flag = process.env["URDIRA_V4"];
    const originalResidualFlag = process.env["URDIRA_V4_RESIDUAL"];
    let runtime: DaemonRuntime | undefined;
    const sessions = new Map<string, IndexingCoreProcessTransport>();
    try {
      process.env["URDIRA_V4"] = "1";
      // Explicitly NOT "1": this test's whole point is that the assertion
      // holds without a residual pass ever running.
      delete process.env["URDIRA_V4_RESIDUAL"];
      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-v4-daemon-e2e-member-entity",
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

      // No residual (semantic_upgrade) generation has run for this
      // workspace -- confirms the assertion below is genuinely a COLD-scan
      // fact, not an artifact of a background pass this test forgot to
      // wait out.
      const statusResponse = await client.call("core:index_status", { workspace_ids: [workspaceId] });
      expect(statusResponse.outcome).toBe("success");
      const status = (statusResponse.payload as { readonly workspaces: ReadonlyArray<Record<string, unknown>> }).workspaces[0];
      expect(status?.["calls_upgraded"]).not.toBe(true);

      // The `greet` method entity -- a `jsts:entity_callable` record whose
      // body carries kind word `"method"`, exactly the C task's own new
      // cold entity producer output (`push_member_entities`).
      const entities = await queryOneStream(client, workspaceId, "core:find_records", { selector: { record_categories: ["entity"] } }, "records");
      const greetEntity = entities.find((record) => {
        const body = record["body"] as Record<string, unknown> | undefined;
        return record["kind"] === "jsts:entity_callable" && body?.["kind"] === "method" && body?.["name"] === "greet";
      });
      expect(greetEntity).toBeDefined();
      expect(greetEntity!["identity_key"] as string).toMatch(/^jsts:method:greeter\.ts:\d+:greet$/);

      const refs = await queryStreams(client, workspaceId, "core:find_references", { target: { subject_type: "entity", entity_id: greetEntity!["entity_id"] }, include_declarations: true });
      const references = refs["references"]?.items ?? [];
      const confirmedCallers = references.filter((entry) => {
        const value = entry.value as Record<string, unknown>;
        const body = value["body"] as { classification?: string } | undefined;
        return value["kind"] === "jsts:relation_call" && body?.classification === "confirmed";
      });
      expect(confirmedCallers.length).toBeGreaterThan(0);
    } finally {
      if (originalV4Flag === undefined) delete process.env["URDIRA_V4"]; else process.env["URDIRA_V4"] = originalV4Flag;
      if (originalResidualFlag === undefined) delete process.env["URDIRA_V4_RESIDUAL"]; else process.env["URDIRA_V4_RESIDUAL"] = originalResidualFlag;
      await runtime?.stop().catch(() => undefined);
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 60_000);

  /**
   * Parameter entities, "referenced-only" variant (owner-approved,
   * 2026-09-04): `core:find_references` on a parameter entity must already
   * return its uses right after the cold scan (`structural_ready`) --
   * `URDIRA_V4_RESIDUAL` is explicitly left UNSET, same as the member-entity
   * test just above, so this is provably a COLD-scan fact. Before this task,
   * no entity was ever materialized for a parameter declaration at all, so
   * the `core:references` row `name` -> `greet`'s `name` parameter already
   * carried never interned a `target_subject` and `find_references` on that
   * parameter returned nothing. A minimal inline fixture is used (the shared
   * `task-planner` fixture is not altered): `export function greet(name:
   * string) { return \`hello ${name}\`; }` -- `name` is referenced once in
   * the template literal.
   */
  it("core:find_references on a parameter entity returns its uses right after the cold scan, before any residual pass", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-v4-e2e-parameter-entity-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-v4-e2e-parameter-entity-workspace-"));
    await writeFile(
      join(workspaceRoot, "greet.ts"),
      "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n",
      "utf8",
    );
    const originalV4Flag = process.env["URDIRA_V4"];
    const originalResidualFlag = process.env["URDIRA_V4_RESIDUAL"];
    let runtime: DaemonRuntime | undefined;
    const sessions = new Map<string, IndexingCoreProcessTransport>();
    try {
      process.env["URDIRA_V4"] = "1";
      // Explicitly NOT "1": this test's whole point is that the assertion
      // holds without a residual pass ever running.
      delete process.env["URDIRA_V4_RESIDUAL"];
      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-v4-daemon-e2e-parameter-entity",
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

      // No residual (semantic_upgrade) generation has run for this
      // workspace -- confirms the assertion below is genuinely a COLD-scan
      // fact.
      const statusResponse = await client.call("core:index_status", { workspace_ids: [workspaceId] });
      expect(statusResponse.outcome).toBe("success");
      const status = (statusResponse.payload as { readonly workspaces: ReadonlyArray<Record<string, unknown>> }).workspaces[0];
      expect(status?.["calls_upgraded"]).not.toBe(true);

      // The `name` parameter entity -- a `jsts:entity_parameter` record,
      // this task's own new cold entity producer output.
      const entities = await queryOneStream(client, workspaceId, "core:find_records", { selector: { record_categories: ["entity"] } }, "records");
      const nameEntity = entities.find((record) => {
        const body = record["body"] as Record<string, unknown> | undefined;
        return record["kind"] === "jsts:entity_parameter" && body?.["name"] === "name";
      });
      expect(nameEntity).toBeDefined();
      expect(nameEntity!["identity_key"] as string).toMatch(/^jsts:parameter:greet\.ts:\d+:name$/);

      const refs = await queryStreams(client, workspaceId, "core:find_references", { target: { subject_type: "entity", entity_id: nameEntity!["entity_id"] }, include_declarations: true });
      const references = refs["references"]?.items ?? [];
      const confirmedReferences = references.filter((entry) => {
        const value = entry.value as Record<string, unknown>;
        const body = value["body"] as { classification?: string } | undefined;
        return value["kind"] === "jsts:relation_references" && body?.classification === "confirmed";
      });
      expect(confirmedReferences.length).toBeGreaterThan(0);
    } finally {
      if (originalV4Flag === undefined) delete process.env["URDIRA_V4"]; else process.env["URDIRA_V4"] = originalV4Flag;
      if (originalResidualFlag === undefined) delete process.env["URDIRA_V4_RESIDUAL"]; else process.env["URDIRA_V4_RESIDUAL"] = originalResidualFlag;
      await runtime?.stop().catch(() => undefined);
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 60_000);

  /**
   * External package/symbol entities task (2026-09-04): a bare/scoped
   * import specifier that never resolves inside the workspace (`import {
   * get } from "lodash"`) now materializes `jsts:external_module:lodash`/
   * `jsts:external_symbol:lodash#get` entities at COLD scan time (no
   * checker, no residual pass -- `URDIRA_V4_RESIDUAL` is explicitly left
   * unset, same convention as the two tests just above), with a confirmed
   * `core:references` row from every use site. Verifies the three concrete
   * query-layer capabilities the task brief named: `core:find_references`
   * on the external symbol lists its use sites, `core:expand_relations`
   * outbound `core:import` from the importing module reaches the external
   * module entity, and `core:resolve_symbol` finds the module entity by its
   * bare name. A minimal inline fixture is used (the shared `task-planner`
   * fixture is not touched): `import { get } from "lodash"; export function
   * useGet(x) { return get(x); }` -- one import-site reference and one
   * usage-site reference to `lodash#get`.
   */
  it("external package entities: find_references/expand_relations/resolve_symbol all reach the external module/symbol right after the cold scan", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-v4-e2e-external-entity-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-v4-e2e-external-entity-workspace-"));
    await writeFile(
      join(workspaceRoot, "uses-lodash.ts"),
      "import { get } from \"lodash\";\n\nexport function useGet(x: unknown): unknown {\n  return get(x);\n}\n",
      "utf8",
    );
    const originalV4Flag = process.env["URDIRA_V4"];
    const originalResidualFlag = process.env["URDIRA_V4_RESIDUAL"];
    let runtime: DaemonRuntime | undefined;
    const sessions = new Map<string, IndexingCoreProcessTransport>();
    try {
      process.env["URDIRA_V4"] = "1";
      delete process.env["URDIRA_V4_RESIDUAL"];
      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-v4-daemon-e2e-external-entity",
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

      const statusResponse = await client.call("core:index_status", { workspace_ids: [workspaceId] });
      expect(statusResponse.outcome).toBe("success");
      const status = (statusResponse.payload as { readonly workspaces: ReadonlyArray<Record<string, unknown>> }).workspaces[0];
      expect(status?.["calls_upgraded"]).not.toBe(true);

      const entities = await queryOneStream(client, workspaceId, "core:find_records", { selector: { record_categories: ["entity"] } }, "records");

      const moduleEntity = entities.find((record) => record["identity_key"] === "jsts:module:uses-lodash.ts:0:uses-lodash.ts");
      expect(moduleEntity).toBeDefined();

      const externalModuleEntity = entities.find((record) => record["identity_key"] === "jsts:external_module:lodash");
      expect(externalModuleEntity).toBeDefined();
      expect(externalModuleEntity!["kind"]).toBe("jsts:entity_container");
      const moduleBody = externalModuleEntity!["body"] as Record<string, unknown>;
      expect(moduleBody["kind"]).toBe("external_module");
      expect(moduleBody["name"]).toBe("lodash");

      const externalSymbolEntity = entities.find((record) => record["identity_key"] === "jsts:external_symbol:lodash#get");
      expect(externalSymbolEntity).toBeDefined();
      const symbolBody = externalSymbolEntity!["body"] as Record<string, unknown>;
      expect(symbolBody["kind"]).toBe("external_symbol");
      expect(symbolBody["name"]).toBe("get");
      expect(symbolBody["parent_id"]).toBe(externalModuleEntity!["identity_key"]);

      // --- `core:find_references` on the external symbol lists its use
      // sites: the import specifier's own binding site AND the `get(x)`
      // call's callee identifier, both confirmed `core:references` rows
      // from `uses-lodash.ts`. ---
      const refs = await queryStreams(client, workspaceId, "core:find_references", {
        target: { subject_type: "entity", entity_id: externalSymbolEntity!["entity_id"] },
        include_declarations: true,
      });
      const references = refs["references"]?.items ?? [];
      const confirmedReferences = references.filter((entry) => {
        const value = entry.value as Record<string, unknown>;
        const body = value["body"] as { classification?: string } | undefined;
        return value["kind"] === "jsts:relation_references" && body?.classification === "confirmed";
      });
      expect(confirmedReferences.length).toBeGreaterThanOrEqual(2);

      // --- `core:expand_relations` outbound `core:import` from the
      // importing module reaches the external module entity. ---
      const expandedImports = await queryOneStream(client, workspaceId, "core:expand_relations", {
        subjects: [{ subject_type: "entity", entity_id: moduleEntity!["entity_id"] }],
        direction: "outbound",
        relations: { universal_kinds: ["core:import"] },
      }, "subjects");
      expect(expandedImports.some((reached) => reached["identity_key"] === "jsts:external_module:lodash")).toBe(true);

      // --- `core:resolve_symbol` finds the external module entity by its
      // bare name. ---
      const resolved = await queryOneStream(client, workspaceId, "core:resolve_symbol", { reference: "lodash", resolution_scope: "workspace" }, "declarations");
      expect(resolved.some((declaration) => declaration["identity_key"] === "jsts:external_module:lodash")).toBe(true);
    } finally {
      if (originalV4Flag === undefined) delete process.env["URDIRA_V4"]; else process.env["URDIRA_V4"] = originalV4Flag;
      if (originalResidualFlag === undefined) delete process.env["URDIRA_V4_RESIDUAL"]; else process.env["URDIRA_V4_RESIDUAL"] = originalResidualFlag;
      await runtime?.stop().catch(() => undefined);
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
