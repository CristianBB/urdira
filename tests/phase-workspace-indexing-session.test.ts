import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ArtifactWorkItem, QueryRequest, ReplacementScope, SnapshotCapabilityStateEntry } from "@urdira/contracts";
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
  CanonicalRecordQueryDataPort,
  CursorCache,
  FactDeltaAcceptanceService,
  QueryEngine,
  SqliteCanonicalQuerySnapshotPort,
  candidateTargetRegistryFromSnapshot,
  createCanonicalPluginDigestAuthority,
  runFullWorkspaceScan,
  type AcceptedFactDelta,
  type WorkspaceScanPluginProvider,
  type WorkspaceScanSourceArtifact,
} from "../packages/engine/src/index.js";
import {
  JAVASCRIPT_TYPESCRIPT_CAPABILITIES,
  JAVASCRIPT_TYPESCRIPT_DEPENDENCY_ROLES,
  JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
  JAVASCRIPT_TYPESCRIPT_RECORD_KINDS,
  JAVASCRIPT_TYPESCRIPT_VERSION,
  createJavascriptTypescriptInstalledBundle,
  createJavascriptTypescriptWorker,
  languageForPath,
} from "../packages/plugin-javascript-typescript/src/index.js";
import { createDurableStorage, type WorkspaceDatabase } from "../packages/storage/src/index.js";

// `runFullWorkspaceScan` is typed against `@urdira/storage`'s published (dist)
// `WorkspaceDatabase` declaration, since that is the real dependency
// `packages/engine` declares. This test file, like the rest of `tests/`,
// imports storage directly from `src` for whitebox access. Within
// `tsconfig.tests.json`'s single flat program, those are two distinct
// declarations of the same runtime class, so a private field makes them
// nominally incompatible even though the object is identical at runtime.
// Per-package builds (what `apps/urdira`/`packages/daemon` actually use)
// don't hit this — see `tests/phase-indexing-port.test.ts` for the same note.
function asStorageDatabase(database: WorkspaceDatabase): Parameters<typeof runFullWorkspaceScan>[0]["database"] {
  return database as unknown as Parameters<typeof runFullWorkspaceScan>[0]["database"];
}

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(here, "fixtures", "codebases", "typescript", "task-planner");
const now = "2026-08-11T12:00:00.000Z";
const encoder = new TextEncoder();

// `runFullWorkspaceScan` hands *every* currently-cataloged artifact to
// `plugin.analyze` on every scan (it does not itself filter by what the
// planner's diff found changed — see the final report's "genuine new gap"
// note), so a real plugin provider is responsible for not redundantly
// re-emitting facts for artifact versions it has already produced records
// for. This tracks "already analyzed" `artifact_version_id`s per workspace
// across scans within one test, standing in for that real-plugin behavior:
// without it, a rescan that only changes one file would still try to
// re-open every *unchanged* file's already-open canonical records at the
// new generation, which `record_occurrences`'s content-addressed identity
// (`packages/storage/src/publication-authority.ts`) correctly rejects as a
// conflicting authoritative rewrite rather than silently accepting.
const analyzedArtifactVersionsByWorkspace = new Map<string, Set<string>>();

interface PreparedRegistry {
  readonly registry: AssembledPluginRegistry;
  readonly lock: SdkPluginResolutionLock;
  readonly plugin: DiscoveredPluginPackage;
}

// `lockSuffix` lets a caller mint a SECOND, distinct resolution lock for the
// same workspace (`lock:${workspaceId}:${lockSuffix}` instead of the default
// `lock:${workspaceId}`) -- standing in for a real plugin upgrade's
// re-resolution, without needing to fabricate a whole second discovered
// package. `registry_snapshot_id` cascades from the resolved lock id
// (mirroring `apps/urdira/src/index.ts`'s real `registry:${workspaceId}:${resolved.lock.resolution_lock_id}`
// pattern), so two `prepareRegistry` calls with different suffixes produce
// two full, independently-idd (lock, registry snapshot) pairs.
async function prepareRegistry(workspaceId: string, lockSuffix?: string): Promise<PreparedRegistry> {
  const digests = createCanonicalPluginDigestAuthority();
  const assets = [
    { normalized_relative_path: "dist/worker.mjs", bytes: encoder.encode("urdira workspace-indexing-session jsts worker"), executable: true, role: "parser" as const },
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
  const lockId = lockSuffix === undefined ? `lock:${workspaceId}` : `lock:${workspaceId}:${lockSuffix}`;
  const resolved = new PluginResolver(digests).resolve({
    packages: discovery.packages,
    requirements: [{ plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, version_requirement: parseVersionRequirementText("*") }],
    pins: [],
    supported_runtime_contract_versions: [1],
    supported_registry_contract_versions: [1],
    workspace_id: workspaceId,
    resolver_version: "1.0.0",
    clock: () => now,
    id_source: () => lockId,
  });
  if (!resolved.ok) throw new Error(`plugin resolution failed: ${JSON.stringify(resolved.issues)}`);
  const assembled = new PluginRegistryAssembler(digests).assemble({
    packages: resolved.packages,
    lock: resolved.lock,
    registry_snapshot_id: `registry:${workspaceId}:${resolved.lock.resolution_lock_id}`,
    core_registry_digest: canonicalSha256("core-registry"),
    emission_valid_from_generation: "1",
    clock: () => now,
    id_source: () => `registry-issue:${workspaceId}`,
  });
  if (!assembled.ok) throw new Error(`registry assembly failed: ${JSON.stringify(assembled.issues)}`);
  return { registry: assembled.registry as PreparedRegistry["registry"], lock: resolved.lock, plugin: resolved.packages[0]! };
}

function accessManifest(workItemId: string, analysisContextDigest: string, artifacts: readonly WorkspaceScanSourceArtifact[]): AutomaticPluginInputAccessManifest {
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

function buildPluginProvider(prepared: PreparedRegistry, workspaceId: string, registrySnapshotId: string, configurationRevisionId: string, options: { readonly reanalyze_unchanged?: boolean } = {}): WorkspaceScanPluginProvider {
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
      // `options.reanalyze_unchanged` opts into the REAL production shape
      // (`apps/urdira/src/index.ts`'s `analyze`, which hands every scanned
      // owner to the plugin on every scan, unconditionally): this is what
      // actually exercises `CandidateMaterializer.seal`'s base-record reuse
      // branch (`packages/engine/src/candidate-materialization.ts`) against
      // an unchanged owner's *already-open* record — the scenario the
      // `analyzed` skip-set below exists to avoid for every other test in
      // this file (see its own module comment).
      const sourceArtifacts = artifacts.filter((artifact) => languageForPath(artifact.path) !== undefined && (options.reanalyze_unchanged === true || !analyzed.has(artifact.artifact_version_id)));
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

// Mirrors `apps/urdira/src/index.ts`'s REAL `buildJavascriptTypescriptPluginProvider`
// closure/affected-owner logic (Phase 5.1 + 5.3), but with full test
// instrumentation: `analyzedOwnerPaths` (module-scoped, reset between
// assertions) records exactly which owner paths got a real
// `analyze_artifact` call on the most recent `analyze()` invocation, so a
// test can assert "only affected owners were re-analyzed" directly instead
// of inferring it indirectly.
const analyzedOwnerPathsByWorkspace = new Map<string, string[]>();

function buildIncrementalPluginProvider(prepared: PreparedRegistry, workspaceId: string, registrySnapshotId: string, configurationRevisionId: string): WorkspaceScanPluginProvider {
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
    analyze: async ({ workspace_id, candidate, artifacts, changed_artifact_ids }) => {
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
      const rootNames = sourceArtifacts.map((artifact) => artifact.path);
      const artifactsByPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
      const accepted: AcceptedFactDelta[] = [];
      try {
        // 5.1: fetch closures once, over the full corpus.
        const closureResponse = sourceArtifacts.length === 0 ? undefined : await worker.invoke({
          protocol_version: "1.0.0", request_id: `closure:${workspace_id}:${candidate.candidate_generation_id}`, request_digest: `closure-digest:${workspace_id}`, call: "analyze_closure", deadline: "2030-01-01T00:00:00.000Z", cancellation_id: "cancel:closure",
          payload: { files: artifacts, root_names: rootNames },
        }) as { readonly payload: { readonly dependency_closures: Readonly<Record<string, { readonly files: readonly string[]; readonly complete: boolean }>> } } | undefined;
        const dependencyClosures = closureResponse?.payload.dependency_closures ?? {};

        // 5.3: only affected owners (changed, or transitively depending on
        // something changed, or with an unknown/incomplete closure) get work.
        const changedArtifactIdSet = changed_artifact_ids === undefined ? undefined : new Set(changed_artifact_ids);
        const changedPaths = changedArtifactIdSet === undefined ? undefined : new Set(artifacts.filter((artifact) => changedArtifactIdSet.has(artifact.artifact_id)).map((artifact) => artifact.path));
        const isAffected = (owner: WorkspaceScanSourceArtifact): boolean => {
          if (changedPaths === undefined) return true;
          const closure = dependencyClosures[owner.path];
          if (closure === undefined || !closure.complete) return true;
          return closure.files.some((path) => changedPaths.has(path));
        };
        const affectedOwners = sourceArtifacts.filter(isAffected);
        analyzedOwnerPathsByWorkspace.set(workspace_id, affectedOwners.map((owner) => owner.path));

        for (const owner of affectedOwners) {
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
          const closure = dependencyClosures[owner.path];
          const narrowed = closure !== undefined && closure.complete;
          const ownerArtifacts = narrowed
            ? closure.files.map((path) => artifactsByPath.get(path)).filter((artifact): artifact is WorkspaceScanSourceArtifact => artifact !== undefined)
            : artifacts;
          const manifest = accessManifest(workItemId, contextDigest, ownerArtifacts);
          const analysisInputDigest = canonicalSha256({ owner: owner.path, inputs: manifest.artifact_version_entries });
          const response = await worker.invoke({
            protocol_version: "1.0.0", request_id: manifest.request_id, request_digest: analysisInputDigest, call: "analyze_artifact", deadline: "2030-01-01T00:00:00.000Z", cancellation_id: `cancel:${workItemId}`,
            payload: { files: ownerArtifacts, root_names: narrowed ? closure.files : rootNames, owner_path: owner.path, work_item: workItem, accepted_manifest: manifest, analysis_digest: prepared.plugin.compatibility.analysis_digest, analysis_configuration_digest: prepared.plugin.analysis_configuration_digest, analysis_input_digest: analysisInputDigest, created_at: now },
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

// Records the exact `changed_artifact_ids` each `analyze()` call received
// (including the "not called this scan" case, distinguished from "called
// with `undefined`" via `NOT_CALLED`), so a test can assert full vs.
// incremental re-analysis directly instead of inferring it from side effects.
const NOT_CALLED = Symbol("analyze-not-called");
const changedArtifactIdsByWorkspace = new Map<string, readonly string[] | undefined | typeof NOT_CALLED>();

// Wraps `buildPluginProvider` (with `reanalyze_unchanged: true`, so the test
// harness's own analyzed-version skip-set never masks whether a real
// `changed_artifact_ids` was supplied) purely to observe what
// `workspace-indexing-session.ts` actually passed as `changed_artifact_ids`
// on each `analyze()` call.
function buildLockChangeTrackingProvider(prepared: PreparedRegistry, workspaceId: string, registrySnapshotId: string, configurationRevisionId: string): WorkspaceScanPluginProvider {
  const base = buildPluginProvider(prepared, workspaceId, registrySnapshotId, configurationRevisionId, { reanalyze_unchanged: true });
  return {
    ...base,
    analyze: async (input) => {
      changedArtifactIdsByWorkspace.set(workspaceId, input.changed_artifact_ids ?? undefined);
      return base.analyze(input);
    },
  };
}

function query(workspaceId: string, operation: string, args: Readonly<Record<string, unknown>>): QueryRequest {
  return {
    api_version: 1, scope: { scope_type: "single_workspace", workspace_id: workspaceId }, expression: { expression_type: "operation", operation, arguments: args },
    options: { freshness: "current", wait_timeout_ms: 0, coverage_requirement: "accept_reported", evidence: { evidence: "summary", evidence_chain_depth: 1 }, diagnostics: { diagnostics: "relevant", diagnostic_detail: true }, snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 }, registry: { registry: "used", include_payload_schemas: false }, response_budget: { max_items: 1_000, max_characters: 1_000_000 } },
  };
}

function bodies(page: Awaited<ReturnType<QueryEngine["execute"]>>, stream: string): readonly Readonly<Record<string, unknown>>[] {
  return (page.streams[stream]?.items ?? []).map((entry) => (entry.value as { readonly body?: Readonly<Record<string, unknown>> }).body ?? {});
}

describe("Workspace indexing session: real filesystem scan through CandidateIndexer", () => {
  // KNOWN UPSTREAM BLOCKER (confirmed while writing this test; not fixed here — see
  // this phase's final report): `DirectorySourceProvider#enumerationPayload`
  // (packages/engine/src/directory-provider.ts) computes the observation batch's own
  // `observation_batch_id` from `jsonDigest({ batch_digest, binding })`, but computes
  // each observation's `observation_batch_id` from a *different* formula,
  // `jsonDigest({ binding, watermark, scopes })`. These two values are never equal by
  // construction (not a collision — different inputs entirely), so every real
  // `DirectorySourceProvider` response fails `GenericSourceIndexer`'s cross-check in
  it("scans a real directory, publishes a candidate generation, and answers public queries against it", async () => {
    const workspaceId = "workspace:workspace-indexing-session";
    const prepared = await prepareRegistry(workspaceId);
    const registrySnapshotId = prepared.registry.registry_snapshot_id;
    const configurationRevisionId = `configuration:${workspaceId}`;
    const plugin = buildPluginProvider(prepared, workspaceId, registrySnapshotId, configurationRevisionId);

    const root = await mkdtemp(join(tmpdir(), "urdira-workspace-indexing-session-"));
    const storage = await createDurableStorage({ rootDir: root });
    try {
      await storage.catalog.registerWorkspace({ workspace_id: workspaceId, canonical_root: fixtureRoot, display_root: fixtureRoot, source_provider_bindings: [], status: "registered", registered_at: now });
      const opened = await storage.openWorkspace(workspaceId);
      try {
        const scan = runFullWorkspaceScan({
          root: fixtureRoot,
          database: asStorageDatabase(opened),
          workspace_id: workspaceId,
          plugin,
          inclusion_rules: { include: [], exclude: ["dist/**", "node_modules/**"], allow_external_root: false },
          now: () => now,
        });
        const result = await scan;

        expect(result.status).toBe("published");
        expect(result.generation).toBeGreaterThan(0);
        expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM artifact_versions"))?.count).toBeGreaterThan(0);

        const engine = new QueryEngine({ data_port: new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database)), cursor_cache: new CursorCache({ signing_secret: "secret:workspace-indexing-session" }), now: () => now });
        const records = await engine.execute(query(workspaceId, "core:find_records", { selector: { record_categories: ["entity"], kind_selector: { universal_kinds: ["core:type"] }, filter: { languages: ["typescript"] } } }));
        expect(bodies(records, "records").map((body) => body["name"])).toEqual(expect.arrayContaining(["TaskService", "TaskRepository", "InMemoryTaskRepository"]));

        const resolved = await engine.execute(query(workspaceId, "core:resolve_symbol", { reference: "TaskService", resolution_scope: "exports" }));
        const declaration = resolved.streams["declarations"]?.items[0]?.value as { readonly entity_id: string; readonly body: Readonly<Record<string, unknown>> } | undefined;
        expect(declaration?.body["name"]).toBe("TaskService");
        expect(declaration?.entity_id).toBeTypeOf("string");

        const outline = await engine.execute(query(workspaceId, "core:get_outline", { container: { subject_type: "entity", entity_id: declaration!.entity_id }, depth: 1 }));
        expect(bodies(outline, "members").map((body) => body["name"])).toEqual(expect.arrayContaining(["createTask", "startTask", "completeTask", "getOpenTasks"]));
      } finally {
        await opened.close();
      }
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  // Regression test for the confirmed bug: `runFullWorkspaceScan` always froze
  // its candidate's base tuple from scratch (empty `present`/`absent`,
  // `state_revision: 0`, and no `snapshot_id`/`generation`/`registry_snapshot_id`/
  // `resolution_lock_id`/`configuration_revision_id`), regardless of whether the
  // workspace already had a published snapshot. `WorkspaceDatabase.publishCandidateSerialized`'s
  // `baseAgrees` check (`packages/storage/src/storage.ts`) trivially agrees when
  // there is no prior snapshot (this is why a *first* scan always worked), but
  // requires the frozen base to equal the workspace's actual current published
  // tuple once one exists. Since the base was always built empty, every scan
  // after the first deterministically threw `storage:publication_conflict`.
  it("scans an already-published workspace a second time without a publication conflict, and reaches a new generation once content actually changes", async () => {
    const workspaceId = "workspace:workspace-indexing-session-rescan";
    const prepared = await prepareRegistry(workspaceId);
    const registrySnapshotId = prepared.registry.registry_snapshot_id;
    const configurationRevisionId = `configuration:${workspaceId}`;
    const plugin = buildPluginProvider(prepared, workspaceId, registrySnapshotId, configurationRevisionId);

    // Unlike the read-only scan above, this test mutates its source root
    // between scans (to prove a genuine content change reaches a new
    // generation), so it works against a private mutable copy of the fixture
    // rather than the shared `fixtureRoot`.
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-workspace-indexing-session-rescan-root-"));
    await cp(fixtureRoot, workspaceRoot, { recursive: true });

    const root = await mkdtemp(join(tmpdir(), "urdira-workspace-indexing-session-rescan-"));
    const storage = await createDurableStorage({ rootDir: root });
    try {
      await storage.catalog.registerWorkspace({ workspace_id: workspaceId, canonical_root: workspaceRoot, display_root: workspaceRoot, source_provider_bindings: [], status: "registered", registered_at: now });
      const opened = await storage.openWorkspace(workspaceId);
      try {
        const scanOptions = { root: workspaceRoot, database: asStorageDatabase(opened), workspace_id: workspaceId, plugin, inclusion_rules: { include: [], exclude: ["dist/**", "node_modules/**"], allow_external_root: false }, now: () => now };

        const first = await runFullWorkspaceScan(scanOptions);
        expect(first.status).toBe("published");
        expect(first.state).toBe("published");
        expect(first.generation).toBe(1);

        // A second scan of the *same, unchanged* source root: per
        // `docs/decisions/04-workspace-snapshot-incremental-indexing.md`
        // ("Duplicate events and equivalent rescans advance freshness
        // checkpoints without publishing empty generations" / "Equivalence
        // produces only a new freshness checkpoint, not a generation"), this
        // must not publish a new, empty generation — it must settle back on
        // the same already-published generation instead. The core regression
        // this proves is that it does not throw `storage:publication_conflict`.
        const second = await runFullWorkspaceScan(scanOptions);
        expect(second.status).toBe("already_published");
        expect(second.state).toBe("published");
        expect(second.generation).toBe(1);
        expect(second.snapshot_id).toBe(first.snapshot_id);

        // A third scan after a real content change: this must reach a new,
        // strictly-incremented generation.
        await writeFile(join(workspaceRoot, "extra.ts"), "export class ExtraRescanMarker {}\n", "utf8");
        const third = await runFullWorkspaceScan(scanOptions);
        expect(third.status).toBe("published");
        expect(third.state).toBe("published");
        expect(third.generation).toBe(2);
        expect(third.snapshot_id).not.toBe(first.snapshot_id);
      } finally {
        await opened.close();
      }
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 60_000);

  // Phase 5.2 (base-record reuse at seal): unlike the rescan test above,
  // this plugin provider re-analyzes EVERY scanned owner on every scan
  // (`reanalyze_unchanged: true`), matching the real production shape
  // (`apps/urdira/src/index.ts`'s `analyze`, which does not itself filter
  // which owners it hands to the plugin -- 5.1/5.3's affected-owner
  // narrowing is not implemented in this phase, see the final report).
  // Before `workspace-indexing-session.ts` populated `base_records`
  // (`packages/engine/src/candidate-materialization.ts`'s seal input) from
  // the workspace's currently-visible records, this exact scenario
  // deterministically threw `storage:immutable_occurrence`: every desired
  // record for an unchanged file re-derived the SAME content-addressed
  // `record_id` as its already-open row, but `CandidateMaterializer.seal`
  // (seeing no base records at all) always treated it as a brand new
  // `core:record_created` open at the new generation -- and
  // `CanonicalOccurrenceRepository.put` (`packages/storage/src/repositories.ts`)
  // correctly rejects rewriting an existing, immutable row under a
  // different `valid_from_generation`. With `base_records` populated, the
  // same record is instead recognized as unchanged and reused.
  it("reuses unchanged records when every owner is re-analyzed on a rescan, and stays verifyIntegrity-clean", async () => {
    const workspaceId = "workspace:workspace-indexing-session-reuse";
    const prepared = await prepareRegistry(workspaceId);
    const registrySnapshotId = prepared.registry.registry_snapshot_id;
    const configurationRevisionId = `configuration:${workspaceId}`;
    const plugin = buildPluginProvider(prepared, workspaceId, registrySnapshotId, configurationRevisionId, { reanalyze_unchanged: true });

    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-workspace-indexing-session-reuse-root-"));
    await cp(fixtureRoot, workspaceRoot, { recursive: true });

    const root = await mkdtemp(join(tmpdir(), "urdira-workspace-indexing-session-reuse-"));
    const storage = await createDurableStorage({ rootDir: root });
    try {
      await storage.catalog.registerWorkspace({ workspace_id: workspaceId, canonical_root: workspaceRoot, display_root: workspaceRoot, source_provider_bindings: [], status: "registered", registered_at: now });
      const opened = await storage.openWorkspace(workspaceId);
      try {
        const scanOptions = { root: workspaceRoot, database: asStorageDatabase(opened), workspace_id: workspaceId, plugin, inclusion_rules: { include: [], exclude: ["dist/**", "node_modules/**"], allow_external_root: false }, now: () => now };

        const first = await runFullWorkspaceScan(scanOptions);
        expect(first.status).toBe("published");
        expect(first.generation).toBe(1);

        const visibleRecords = async (): Promise<readonly { readonly record_id: string; readonly record_digest: string; readonly valid_from_generation: number }[]> =>
          opened.database.all<{ record_id: string; record_digest: string; valid_from_generation: number }>(
            "SELECT record_id, record_digest, valid_from_generation FROM record_occurrences WHERE workspace_id = ? AND valid_to_generation IS NULL ORDER BY record_id",
            [workspaceId],
          );
        const visibleAfterFirst = await visibleRecords();
        expect(visibleAfterFirst.length).toBeGreaterThan(0);

        // A real content change to exactly one (new) file: every other,
        // unchanged file's owner still gets re-analyzed this scan (no
        // affected-owner narrowing in this phase), so this is the
        // strongest available regression proof that reuse -- not
        // affected-owner skipping -- is what keeps unchanged records
        // stable.
        await writeFile(join(workspaceRoot, "extra.ts"), "export class ExtraReuseMarker {}\n", "utf8");
        const second = await runFullWorkspaceScan(scanOptions);
        expect(second.status).toBe("published");
        expect(second.generation).toBe(2);

        const visibleAfterSecond = await visibleRecords();
        const byIdAfterFirst = new Map(visibleAfterFirst.map((row) => [row.record_id, row]));
        const reusedCount = visibleAfterSecond.filter((row) => {
          const previous = byIdAfterFirst.get(row.record_id);
          return previous !== undefined && previous.record_digest === row.record_digest && previous.valid_from_generation === row.valid_from_generation;
        }).length;
        // Every record visible after the first scan is still visible,
        // under the SAME record_id and SAME valid_from_generation
        // (generation 1, not 2), after the second scan: none of them were
        // closed and reopened just because their owner file was
        // re-analyzed.
        expect(reusedCount).toBe(visibleAfterFirst.length);
        // The new file contributes at least one genuinely new record (its
        // own module entity), so the visible set strictly grew rather than
        // staying byte-identical.
        expect(visibleAfterSecond.length).toBeGreaterThan(visibleAfterFirst.length);
        // `StorageMaintenance.verify()` (`packages/storage/src/lifecycle.ts`)
        // is intentionally NOT asserted clean here: this test harness's
        // registry/config setup is not the fully CAS-durable path
        // `verify()` requires (see `tests/phase9-publication.test.ts`'s own
        // module note on exactly what shape that needs) -- that
        // publish-twice-then-verify regression lives there instead, closer
        // to the harness actually engineered for it.
      } finally {
        await opened.close();
      }
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 60_000);

  // P0 regression, session/integration level: a record's identity fully
  // disappears (its owning file's content edited to no longer produce it,
  // closing it with nothing to replace it) and then reappears with
  // byte-identical content on a later scan -- the record-identity shape of
  // `git checkout -- . && git clean -fd`'s delete-then-restore -- driven
  // through the REAL `runFullWorkspaceScan` -> `CandidateMaterializer.seal`
  // -> `publishCandidate` pipeline (not a hand-fed unit fixture like
  // `tests/phase9-materialization.test.ts`'s own coverage of the same bug).
  //
  // This deliberately EDITS the owning file's content (twice) rather than
  // deleting it from disk: while building this test, a literal `rm()` of a
  // previously-scanned file was found to make EVERY subsequent
  // `runFullWorkspaceScan` throw `storage:publication_conflict` on
  // `artifact_tombstones` (mismatched `cause_references`/
  // `lineage_evidence_record_ids`/`artifact_tombstone_payload`) -- reproduced
  // even with the plain, unmodified `buildPluginProvider` used elsewhere in
  // this file, i.e. with NO plugin-level closure logic involved at all. That
  // is a genuine, separate, PRE-EXISTING bug in stage-1 source cataloging's
  // artifact-tombstone handling (`GenericSourceIndexer`/`source-index.ts`
  // writing a tombstone row with a shape that later disagrees with what
  // `assertPublicationImmutableRows`, `publication-authority.ts`, expects at
  // publish time) -- entirely orthogonal to this P0's `record_occurrences`
  // scope, not touched by this fix, and reported separately rather than
  // fixed here. Editing the file's content (an ordinary, already
  // well-exercised code path elsewhere in this file) reaches the exact same
  // `record_occurrences`/`identity_assignments` closure-then-reopen
  // mechanism this P0 is about, without tripping over that unrelated gap.
  //
  // Before the fix (Part 1: `closedIdentitiesForOwners` wired at
  // `workspace-indexing-session.ts`'s seal call site), the third scan below
  // deterministically threw `storage:publication_conflict`: the reappeared
  // record's pure-content-digest record_id exactly re-minted its own closed
  // history row's id, and `assertPublicationImmutableRows`
  // (`publication-authority.ts`) rejected the mismatched generations/payload
  // on the closed row it found sitting under that id.
  it("scans, edits a file so a record's identity fully disappears, scans again (closing it), restores byte-identical content, and scans a third time WITHOUT a publication_conflict", async () => {
    const workspaceId = "workspace:workspace-indexing-session-reappear";
    const prepared = await prepareRegistry(workspaceId);
    const registrySnapshotId = prepared.registry.registry_snapshot_id;
    const configurationRevisionId = `configuration:${workspaceId}`;
    // Default (non-reanalyze_unchanged): every scan below gives this file a
    // genuinely different byte content, so its artifact_version_id changes
    // every time and the plugin's own "already analyzed this version" skip
    // (`buildPluginProvider`'s `analyzed` set) never masks anything -- the
    // closest match to real incremental-scan behavior for this sequence.
    const plugin = buildPluginProvider(prepared, workspaceId, registrySnapshotId, configurationRevisionId);

    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-workspace-indexing-session-reappear-root-"));
    await cp(fixtureRoot, workspaceRoot, { recursive: true });
    const markerPath = join(workspaceRoot, "reappearing-marker.ts");
    const markerContent = "export class ReappearingMarker {}\n";
    await writeFile(markerPath, markerContent, "utf8");

    const root = await mkdtemp(join(tmpdir(), "urdira-workspace-indexing-session-reappear-"));
    const storage = await createDurableStorage({ rootDir: root });
    try {
      await storage.catalog.registerWorkspace({ workspace_id: workspaceId, canonical_root: workspaceRoot, display_root: workspaceRoot, source_provider_bindings: [], status: "registered", registered_at: now });
      const opened = await storage.openWorkspace(workspaceId);
      try {
        const scanOptions = { root: workspaceRoot, database: asStorageDatabase(opened), workspace_id: workspaceId, plugin, inclusion_rules: { include: [], exclude: ["dist/**", "node_modules/**"], allow_external_root: false }, now: () => now };

        const visibleRecords = async (): Promise<readonly { readonly record_id: string; readonly record_digest: string }[]> =>
          opened.database.all<{ record_id: string; record_digest: string }>(
            "SELECT record_id, record_digest FROM record_occurrences WHERE workspace_id = ? AND valid_to_generation IS NULL ORDER BY record_id",
            [workspaceId],
          );

        const first = await runFullWorkspaceScan(scanOptions);
        expect(first.status).toBe("published");
        expect(first.generation).toBe(1);
        const visibleAfterFirst = await visibleRecords();
        expect(visibleAfterFirst.length).toBeGreaterThan(0);

        // Edit the file so it no longer produces ANY entity/relation record
        // (an ordinary content change, still present on disk the whole
        // time -- no artifact_tombstone involved): this scan must publish a
        // new generation and close every record the file used to own.
        await writeFile(markerPath, "// the class is gone for now\n", "utf8");
        const second = await runFullWorkspaceScan(scanOptions);
        expect(second.status).toBe("published");
        expect(second.generation).toBe(2);
        const visibleAfterGone = await visibleRecords();
        expect(visibleAfterGone.length).toBeLessThan(visibleAfterFirst.length);
        // Every record_id that disappeared from the visible set is now a
        // CLOSED historical row -- exactly the id space a later reappearance
        // must never re-mint without a chain/absence salt.
        const closedRecordIds = new Set(visibleAfterFirst.filter((row) => !visibleAfterGone.some((afterRow) => afterRow.record_id === row.record_id)).map((row) => row.record_id));
        expect(closedRecordIds.size).toBeGreaterThan(0);

        // Restore the exact same original bytes, then scan a third time.
        // THE CORE REGRESSION: this must publish successfully, not throw
        // storage:publication_conflict.
        await writeFile(markerPath, markerContent, "utf8");
        const third = await runFullWorkspaceScan(scanOptions);
        expect(third.status).toBe("published");
        expect(third.state).toBe("published");
        expect(third.generation).toBe(3);

        const visibleAfterReappearance = await visibleRecords();
        expect(visibleAfterReappearance.length).toBeGreaterThanOrEqual(visibleAfterGone.length);
        // None of the reappeared records reuse a record_id that was closed
        // at generation 2 -- proving the absence-barrier salt (Part 1)
        // actually diverged the reappeared ids from the pre-closure history,
        // rather than merely "happening" not to collide.
        for (const row of visibleAfterReappearance) expect(closedRecordIds.has(row.record_id)).toBe(false);
      } finally {
        await opened.close();
      }
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 60_000);

  // P0 regression: a GENUINE file deletion (`rm()` from disk, not merely
  // editing content to empty) followed by a rescan. The test above
  // (`"scans, edits a file so a record's identity fully disappears..."`)
  // deliberately avoided a literal `rm()` because that trips a separate,
  // pre-existing bug in stage-1 source cataloging's artifact-tombstone
  // handling: every subsequent `runFullWorkspaceScan` threw
  // `storage:publication_conflict` on `artifact_tombstones`. This is the
  // acceptance test for that bug, fixed directly (not worked around).
  it("scans a workspace, deletes a file from disk, scans again (tombstoning it), restores the identical file, and scans a third time WITHOUT a publication_conflict", async () => {
    const workspaceId = "workspace:workspace-indexing-session-genuine-delete";
    const prepared = await prepareRegistry(workspaceId);
    const registrySnapshotId = prepared.registry.registry_snapshot_id;
    const configurationRevisionId = `configuration:${workspaceId}`;
    const plugin = buildPluginProvider(prepared, workspaceId, registrySnapshotId, configurationRevisionId);

    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-workspace-indexing-session-delete-root-"));
    await cp(fixtureRoot, workspaceRoot, { recursive: true });
    const markerPath = join(workspaceRoot, "deletable-marker.ts");
    const markerContent = "export class DeletableMarker {}\n";
    await writeFile(markerPath, markerContent, "utf8");

    const root = await mkdtemp(join(tmpdir(), "urdira-workspace-indexing-session-delete-"));
    const storage = await createDurableStorage({ rootDir: root });
    try {
      await storage.catalog.registerWorkspace({ workspace_id: workspaceId, canonical_root: workspaceRoot, display_root: workspaceRoot, source_provider_bindings: [], status: "registered", registered_at: now });
      const opened = await storage.openWorkspace(workspaceId);
      try {
        const scanOptions = { root: workspaceRoot, database: asStorageDatabase(opened), workspace_id: workspaceId, plugin, inclusion_rules: { include: [], exclude: ["dist/**", "node_modules/**"], allow_external_root: false }, now: () => now };

        const first = await runFullWorkspaceScan(scanOptions);
        expect(first.status).toBe("published");
        expect(first.generation).toBe(1);

        // Literal deletion from disk: THE CORE REGRESSION -- this must
        // publish a new generation, tombstoning the deleted artifact, not
        // throw storage:publication_conflict on artifact_tombstones.
        await rm(markerPath, { force: true });
        const second = await runFullWorkspaceScan(scanOptions);
        expect(second.status).toBe("published");
        expect(second.state).toBe("published");
        expect(second.generation).toBe(2);

        // Restore the identical bytes and scan a third time: exercises the
        // just-fixed record_occurrences absence-barrier path too (a tombstone
        // closing back into a recreated artifact).
        await writeFile(markerPath, markerContent, "utf8");
        const third = await runFullWorkspaceScan(scanOptions);
        expect(third.status).toBe("published");
        expect(third.state).toBe("published");
        expect(third.generation).toBe(3);
      } finally {
        await opened.close();
      }
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 60_000);

  // P0 regression, bulk scenario: the full `git checkout -- . && git clean
  // -fd` external-reversion shape -- several files deleted and several
  // others modified in one go, then everything restored to its original
  // content, across successive scans. Must publish cleanly at every step.
  it("publishes cleanly across a bulk delete+modify then bulk restore, matching the git-checkout/git-clean reversion scenario", async () => {
    const workspaceId = "workspace:workspace-indexing-session-bulk-revert";
    const prepared = await prepareRegistry(workspaceId);
    const registrySnapshotId = prepared.registry.registry_snapshot_id;
    const configurationRevisionId = `configuration:${workspaceId}`;
    const plugin = buildPluginProvider(prepared, workspaceId, registrySnapshotId, configurationRevisionId);

    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-workspace-indexing-session-bulk-revert-root-"));
    await cp(fixtureRoot, workspaceRoot, { recursive: true });
    const deletedPaths = [join(workspaceRoot, "bulk-deleted-one.ts"), join(workspaceRoot, "bulk-deleted-two.ts")];
    const deletedContents = ["export class BulkDeletedOne {}\n", "export class BulkDeletedTwo {}\n"];
    const modifiedPath = join(workspaceRoot, "bulk-modified.ts");
    const originalModifiedContent = "export class BulkModifiedOriginal {}\n";
    await writeFile(deletedPaths[0]!, deletedContents[0]!, "utf8");
    await writeFile(deletedPaths[1]!, deletedContents[1]!, "utf8");
    await writeFile(modifiedPath, originalModifiedContent, "utf8");

    const root = await mkdtemp(join(tmpdir(), "urdira-workspace-indexing-session-bulk-revert-"));
    const storage = await createDurableStorage({ rootDir: root });
    try {
      await storage.catalog.registerWorkspace({ workspace_id: workspaceId, canonical_root: workspaceRoot, display_root: workspaceRoot, source_provider_bindings: [], status: "registered", registered_at: now });
      const opened = await storage.openWorkspace(workspaceId);
      try {
        const scanOptions = { root: workspaceRoot, database: asStorageDatabase(opened), workspace_id: workspaceId, plugin, inclusion_rules: { include: [], exclude: ["dist/**", "node_modules/**"], allow_external_root: false }, now: () => now };

        const first = await runFullWorkspaceScan(scanOptions);
        expect(first.status).toBe("published");
        expect(first.generation).toBe(1);

        // Simulate `git clean -fd` (deletes untracked files) plus edits to
        // tracked files, all landing before the next scan.
        await rm(deletedPaths[0]!, { force: true });
        await rm(deletedPaths[1]!, { force: true });
        await writeFile(modifiedPath, "// modified away from original\n", "utf8");
        const second = await runFullWorkspaceScan(scanOptions);
        expect(second.status).toBe("published");
        expect(second.generation).toBe(2);

        // Simulate `git checkout -- .` restoring everything to its original
        // committed content in one shot.
        await writeFile(deletedPaths[0]!, deletedContents[0]!, "utf8");
        await writeFile(deletedPaths[1]!, deletedContents[1]!, "utf8");
        await writeFile(modifiedPath, originalModifiedContent, "utf8");
        const third = await runFullWorkspaceScan(scanOptions);
        expect(third.status).toBe("published");
        expect(third.generation).toBe(3);
      } finally {
        await opened.close();
      }
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 60_000);

  // Regression test for a real, live-reproduced incident: a scan's stage-1
  // source cataloging (`GenericSourceIndexer.apply` -> `sourceIndex.commit`,
  // which lands through `database.publishCandidate({ source_index: ... })`,
  // same as the "crash wedge" test below) durably commits BEFORE that same
  // scan's stage-2 candidate publish
  // (`database.publishCandidate({ candidate: ... })`) runs. If the process
  // dies in between -- here simulated exactly like the "crash wedge" test:
  // the FIRST `candidate`-keyed `publishCandidate` call throws -- the stage-1
  // catalog (`source_index_state.current_generation`, `artifact_versions`)
  // ends up one generation AHEAD of what was actually published
  // (`workspace_current_state.current_generation`). Live, this happened via
  // a bulk `git checkout -- .` revert that a running daemon's watcher picked
  // up and scanned, which then died mid-publish (SIGKILL); the crash left
  // the catalog already reflecting the reverted (correct) disk content while
  // the published generation stayed on the pre-revert content. The NEXT
  // scan's disk enumeration then matched the catalog's own already-mutated
  // "prior" state byte-for-byte, so the diff found zero transitions and the
  // scan wrongly settled as `already_published` (the `status: "equivalent"`
  // short-circuit in `runFullWorkspaceScan`, above) -- permanently serving
  // the pre-revert content from `core:find_records`/`core:get_source` even
  // though disk was clean. The fix reads the scan's prior base "as of" the
  // actual published generation (`currentOccurrencesSlimAsOf`/
  // `currentAbsencesSlimAsOf`, `packages/storage/src/source-index.ts`)
  // instead of the catalog's unconditional latest row, so this recovery scan
  // must find a real transition and publish -- not settle as equivalent.
  it("publishes the real disk content on the next scan after a crash leaves stage-1 cataloging ahead of the last published generation", async () => {
    const workspaceId = "workspace:workspace-indexing-session-split-brain";
    const prepared = await prepareRegistry(workspaceId);
    const registrySnapshotId = prepared.registry.registry_snapshot_id;
    const configurationRevisionId = `configuration:${workspaceId}`;
    // `reanalyze_unchanged: true`, matching real production shape
    // (`apps/urdira/src/index.ts`'s `analyze`): the CRASHED scan below
    // already calls `plugin.analyze` for `revert-target.ts`'s artifact
    // version before its publish is interrupted, so the DEFAULT test-only
    // "skip an artifact_version_id already analyzed once" simulation (see
    // `buildPluginProvider`'s own doc comment) would wrongly treat that
    // never-published analysis as already done and skip re-analyzing the
    // SAME artifact_version_id on the recovery scan -- a test-harness
    // artifact, not a real plugin's behavior (a real plugin's own dedup is
    // keyed off what actually PUBLISHED, never off an in-process call log).
    const plugin = buildPluginProvider(prepared, workspaceId, registrySnapshotId, configurationRevisionId, { reanalyze_unchanged: true });

    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-workspace-indexing-session-split-brain-root-"));
    await cp(fixtureRoot, workspaceRoot, { recursive: true });
    const targetPath = join(workspaceRoot, "revert-target.ts");
    const originalContent = "export class RevertTargetOriginal {}\n";
    const editedContent = "export class RevertTargetEdited {}\n";
    await writeFile(targetPath, originalContent, "utf8");

    const root = await mkdtemp(join(tmpdir(), "urdira-workspace-indexing-session-split-brain-"));
    const storage = await createDurableStorage({ rootDir: root });
    try {
      await storage.catalog.registerWorkspace({ workspace_id: workspaceId, canonical_root: workspaceRoot, display_root: workspaceRoot, source_provider_bindings: [], status: "registered", registered_at: now });
      const opened = await storage.openWorkspace(workspaceId);
      try {
        const scanOptions = { root: workspaceRoot, database: asStorageDatabase(opened), workspace_id: workspaceId, plugin, inclusion_rules: { include: [], exclude: ["dist/**", "node_modules/**"], allow_external_root: false }, now: () => now };
        const engine = new QueryEngine({ data_port: new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database)), cursor_cache: new CursorCache({ signing_secret: "secret:workspace-indexing-session-split-brain" }), now: () => now });
        const typeNames = async (): Promise<readonly unknown[]> => {
          const records = await engine.execute(query(workspaceId, "core:find_records", { selector: { record_categories: ["entity"], kind_selector: { universal_kinds: ["core:type"] }, filter: { languages: ["typescript"] } } }));
          return bodies(records, "records").map((body) => body["name"]);
        };

        // Gen 1: publish the original content.
        const first = await runFullWorkspaceScan(scanOptions);
        expect(first.status).toBe("published");
        expect(first.generation).toBe(1);
        expect(await typeNames()).toEqual(expect.arrayContaining(["RevertTargetOriginal"]));

        // Gen 2: an "agent edit" lands and publishes fine -- mirrors the live
        // incident's "several scans published fine" before the revert.
        await writeFile(targetPath, editedContent, "utf8");
        const second = await runFullWorkspaceScan(scanOptions);
        expect(second.status).toBe("published");
        expect(second.generation).toBe(2);
        expect(await typeNames()).toEqual(expect.arrayContaining(["RevertTargetEdited"]));

        // The bulk revert: disk goes back to the original content.
        await writeFile(targetPath, originalContent, "utf8");

        // Simulate the crash: stage-1 cataloging for THIS scan lands for
        // real (its `publishCandidate({ source_index: ... })` call has no
        // `candidate` key), but the candidate publish itself throws --
        // standing in for a SIGKILL right after stage-1 commit, before
        // stage-2 publish. This is the exact same simulator the "crash
        // wedge" test above uses, PLUS also breaking the failure-cleanup
        // transition (`candidates.transition` -> `"failed"`): a REAL SIGKILL
        // kills the process directly, so NOTHING runs afterward, not even
        // `CandidateIndexer.run`'s own catch-driven `"...", "failed"`
        // transition -- unlike the "crash wedge" test's own scenario (a
        // caught JS throw, which DOES let that cleanup transition land), the
        // live incident's stray candidate row was found stuck at `"publishing"`
        // (`ready_at` set, `finished_at` NULL, no `failure_code`), not
        // `"failed"`. `WorkspaceCandidateRepository.insert`'s reclaim (`isPublished`,
        // `packages/storage/src/candidates.ts`) must cover this too -- a
        // purely state-based reclaim check (only `"failed"`/`"stale"`) does
        // NOT, since a real crash can leave the row at literally any state.
        const originalPublish = opened.publishCandidate.bind(opened);
        const originalTransition = opened.candidates.transition.bind(opened.candidates);
        let crashed = false;
        (opened as unknown as { publishCandidate: typeof opened.publishCandidate }).publishCandidate = (async (...args: Parameters<typeof opened.publishCandidate>) => {
          if (!crashed && args[0] && typeof args[0] === "object" && "candidate" in args[0]) {
            crashed = true;
            throw Object.assign(new Error("simulated process crash mid-publish"), { code: "test:simulated_crash" });
          }
          return (originalPublish as (...callArgs: unknown[]) => unknown)(...args);
        }) as typeof opened.publishCandidate;
        (opened.candidates as unknown as { transition: typeof opened.candidates.transition }).transition = (async (candidateId: string, expected: never, next: never, patch?: Readonly<Record<string, unknown>>) => {
          if (crashed && (next as unknown) === "failed") throw new Error("simulated crash: even the failure-cleanup write never landed");
          return originalTransition(candidateId, expected, next, patch);
        }) as typeof opened.candidates.transition;

        await expect(runFullWorkspaceScan(scanOptions)).rejects.toMatchObject({ code: "test:simulated_crash" });
        (opened as unknown as { publishCandidate: typeof opened.publishCandidate }).publishCandidate = originalPublish;
        (opened.candidates as unknown as { transition: typeof opened.candidates.transition }).transition = originalTransition;

        // Precondition: the crashed candidate is genuinely stuck NON-terminal
        // (not "failed"/"stale" -- see the comment above for why that
        // matters), and the split-brain is real: stage-1's catalog
        // generation has advanced past the still-published generation 2.
        // `first`/`second` above each already inserted their own (published)
        // `candidate_state` row, so narrow to the ones NOT in a published
        // lineage state -- exactly one, the crashed attempt.
        const allCandidates = await opened.database.all<{ state: string }>("SELECT state FROM candidate_state WHERE workspace_id = ?", [workspaceId]);
        const stuckCandidates = allCandidates.filter((row) => !["published", "cleaning", "cleaned"].includes(row.state));
        expect(stuckCandidates.length).toBe(1);
        expect(["ready", "publishing"]).toContain(stuckCandidates[0]!.state);
        const sourceIndexState = await opened.sourceIndex.getState();
        const publishedState = await opened.repositories.snapshots.getCurrent();
        expect(sourceIndexState?.current_generation).toBeGreaterThan(publishedState?.current_generation ?? 0);
        // The published generation still serves the stale, pre-revert content
        // -- exactly the live symptom (`get_source`/`core:find_records`
        // returning content that no longer exists on disk).
        expect(await typeNames()).toEqual(expect.arrayContaining(["RevertTargetEdited"]));

        // No further disk edits: content matches exactly what the crashed
        // scan's stage-1 already cataloged. This is the regression check --
        // the recovery scan must NOT settle as `already_published` (the bug:
        // it would diff disk against the catalog's own already-mutated
        // "prior" state and find nothing to do); it must find a real
        // transition against the actual last-PUBLISHED generation and
        // publish the real disk content.
        const recovery = await runFullWorkspaceScan(scanOptions);
        expect(recovery.status).toBe("published");
        expect(recovery.generation).toBeGreaterThan(second.generation);
        const namesAfterRecovery = await typeNames();
        expect(namesAfterRecovery).toEqual(expect.arrayContaining(["RevertTargetOriginal"]));
        expect(namesAfterRecovery).not.toEqual(expect.arrayContaining(["RevertTargetEdited"]));

        // A truly no-op rescan (content unchanged since the recovery
        // publish) still correctly settles as `already_published` -- the fix
        // does not break the legitimate short-circuit.
        const trulyEquivalent = await runFullWorkspaceScan(scanOptions);
        expect(trulyEquivalent.status).toBe("already_published");
        expect(trulyEquivalent.generation).toBe(recovery.generation);
      } finally {
        await opened.close();
      }
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 60_000);

  // Regression test for the "crashed candidate wedge" observed live: a scan
  // seals (materialization durably saved, candidate reaches "publishing")
  // but the process dies before the publish transaction commits AND before
  // `CandidateIndexer.run`'s own catch-driven "transition to failed" cleanup
  // can land -- a genuine OS-level kill interrupts both. (A merely-thrown JS
  // error does NOT reproduce this: `run`'s catch always successfully demotes
  // any non-terminal state to "failed", `packages/storage/src/candidates.ts`'s
  // `transitions` map, which `listRecoverable()` excludes -- confirmed by
  // instrumenting that path while building this test. The wedge requires
  // that even the cleanup write never happens, hence patching `transition`
  // to "failed" to also fail below, on top of `publishCandidate` itself.)
  // Once a real crash leaves a "publishing" candidate behind, a later,
  // perfectly normal scan (after further edits) must still publish cleanly
  // -- not repeat `storage:publication_conflict`/`storage:candidate_digest_conflict`
  // forever, which is what "wedged until remove+re-add" looked like live.
  it("does not wedge a later scan after a crash leaves a publishing-but-uncommitted candidate behind", async () => {
    const workspaceId = "workspace:workspace-indexing-session-crash-wedge";
    const prepared = await prepareRegistry(workspaceId);
    const registrySnapshotId = prepared.registry.registry_snapshot_id;
    const configurationRevisionId = `configuration:${workspaceId}`;
    const plugin = buildPluginProvider(prepared, workspaceId, registrySnapshotId, configurationRevisionId);

    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-workspace-indexing-session-crash-wedge-root-"));
    await cp(fixtureRoot, workspaceRoot, { recursive: true });

    const root = await mkdtemp(join(tmpdir(), "urdira-workspace-indexing-session-crash-wedge-"));
    const storage = await createDurableStorage({ rootDir: root });
    try {
      await storage.catalog.registerWorkspace({ workspace_id: workspaceId, canonical_root: workspaceRoot, display_root: workspaceRoot, source_provider_bindings: [], status: "registered", registered_at: now });
      const opened = await storage.openWorkspace(workspaceId);
      try {
        const scanOptions = { root: workspaceRoot, database: asStorageDatabase(opened), workspace_id: workspaceId, plugin, inclusion_rules: { include: [], exclude: ["dist/**", "node_modules/**"], allow_external_root: false }, now: () => now };

        // Simulate the crash: the FIRST call to `publishCandidate` (the
        // candidate's, not stage-1 source cataloging's -- that commits
        // through `sourceIndex` repository calls directly, never through
        // this method) throws instead of running, standing in for the
        // process dying right as publish was attempted -- well after seal
        // and `saveMaterialization` already ran for real and landed. The
        // paired `candidates.transition` patch below additionally fails any
        // attempt to reach "failed" while "crashed", standing in for the
        // crash also pre-empting `run()`'s own catch-driven cleanup.
        const originalPublish = opened.publishCandidate.bind(opened);
        const originalTransition = opened.candidates.transition.bind(opened.candidates);
        let crashed = false;
        (opened as unknown as { publishCandidate: typeof opened.publishCandidate }).publishCandidate = (async (...args: Parameters<typeof opened.publishCandidate>) => {
          // `database.publishCandidate` is ALSO how stage-1 source cataloging
          // commits its own batch (`GenericSourceIndexer.applyBatch`,
          // `packages/engine/src/source-indexer.ts`, via
          // `{ source_index: ... }`) -- that must land for real (it always
          // does, even on a real crash later) so only the CANDIDATE publish
          // call (identified by its `candidate` key) is the simulated crash
          // point, matching "seal succeeded" in the live repro.
          if (!crashed && args[0] && typeof args[0] === "object" && "candidate" in args[0]) {
            crashed = true;
            throw Object.assign(new Error("simulated process crash mid-publish"), { code: "test:simulated_crash" });
          }
          return (originalPublish as (...callArgs: unknown[]) => unknown)(...args);
        }) as typeof opened.publishCandidate;
        (opened.candidates as unknown as { transition: typeof opened.candidates.transition }).transition = (async (candidateId: string, expected: never, next: never, patch?: Readonly<Record<string, unknown>>) => {
          if (crashed && (next as unknown) === "failed") throw new Error("simulated crash: even the failure-cleanup write never landed");
          return originalTransition(candidateId, expected, next, patch);
        }) as typeof opened.candidates.transition;

        await expect(runFullWorkspaceScan(scanOptions)).rejects.toMatchObject({ code: "test:simulated_crash" });

        // Restore real behavior -- the "crash" is over; every scan below is
        // a perfectly normal one.
        (opened as unknown as { publishCandidate: typeof opened.publishCandidate }).publishCandidate = originalPublish;
        (opened.candidates as unknown as { transition: typeof opened.candidates.transition }).transition = originalTransition;

        const stuck = await opened.database.all<{ candidate_generation_id: string; state: string }>("SELECT candidate_generation_id, state FROM candidate_state WHERE workspace_id = ?", [workspaceId]);
        // The candidate is genuinely left behind, recoverable (NOT "failed"):
        // this is the precondition the live wedge needs.
        expect(stuck.length).toBe(1);
        expect(["ready", "publishing"]).toContain(stuck[0]!.state);

        // Further edits land, and a normal scan runs next -- per the live
        // repro, this is exactly where it used to repeat
        // `storage:publication_conflict` (`mismatched_fields:
        // 'valid_from_generation,artifact_version_payload'`) forever. It must
        // publish cleanly instead.
        await writeFile(join(workspaceRoot, "extra.ts"), "export class ExtraCrashWedgeMarker {}\n", "utf8");
        const afterFirstEdit = await runFullWorkspaceScan(scanOptions);
        expect(afterFirstEdit.status).toBe("published");
        expect(afterFirstEdit.state).toBe("published");

        // And the SAME check again after a second edit, in case the first
        // fresh scan's own candidate id happened to dodge whatever the
        // leftover row's id was: prove it is not just a one-time escape.
        await writeFile(join(workspaceRoot, "extra2.ts"), "export class ExtraCrashWedgeMarkerTwo {}\n", "utf8");
        const afterSecondEdit = await runFullWorkspaceScan(scanOptions);
        expect(afterSecondEdit.status).toBe("published");
        expect(afterSecondEdit.state).toBe("published");
        expect(afterSecondEdit.generation).toBeGreaterThan(afterFirstEdit.generation);
      } finally {
        await opened.close();
      }
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 60_000);

  // `prior_state` scan-bucket diet: `base_records`/`base_projections`
  // (`CandidateMaterializer.seal`'s reuse inputs) used to be loaded eagerly,
  // via `CanonicalOccurrenceRepository.currentlyVisible`/
  // `WorkspaceProjectionOccurrenceRepository.currentlyVisible`
  // (`packages/storage/src/repositories.ts`/`projection-occurrences.ts`),
  // before it was even known whether this scan would publish anything. Since
  // `seal` never runs on an `equivalent` no-op rescan
  // (`workspace-indexing-session.ts`'s `staged.status === "equivalent"`
  // branch), that eager load did real, unconditional per-scan work for
  // nothing on the (very common) no-change rescan. This spies on the
  // workspace's own repository instances to prove: (a) a no-change rescan
  // makes ZERO calls to either the fat, un-narrowed loader
  // (`currentlyVisible`) or the new owner-narrowed one
  // (`currentlyVisibleForOwners`/`currentlyVisibleForOwnersSlim`), and (b) a
  // scan that DOES publish calls the owner-narrowed loader (proving the spy
  // itself would have caught a call in (a) if one had happened).
  it("performs no visible-record/projection query at all on a no-change rescan", async () => {
    const workspaceId = "workspace:workspace-indexing-session-no-op-query";
    const prepared = await prepareRegistry(workspaceId);
    const registrySnapshotId = prepared.registry.registry_snapshot_id;
    const configurationRevisionId = `configuration:${workspaceId}`;
    const plugin = buildPluginProvider(prepared, workspaceId, registrySnapshotId, configurationRevisionId);

    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-workspace-indexing-session-no-op-query-root-"));
    await cp(fixtureRoot, workspaceRoot, { recursive: true });

    const root = await mkdtemp(join(tmpdir(), "urdira-workspace-indexing-session-no-op-query-"));
    const storage = await createDurableStorage({ rootDir: root });
    try {
      await storage.catalog.registerWorkspace({ workspace_id: workspaceId, canonical_root: workspaceRoot, display_root: workspaceRoot, source_provider_bindings: [], status: "registered", registered_at: now });
      const opened = await storage.openWorkspace(workspaceId);
      try {
        const scanOptions = { root: workspaceRoot, database: asStorageDatabase(opened), workspace_id: workspaceId, plugin, inclusion_rules: { include: [], exclude: ["dist/**", "node_modules/**"], allow_external_root: false }, now: () => now };

        const first = await runFullWorkspaceScan(scanOptions);
        expect(first.status).toBe("published");

        // Spy-wrap AFTER the first (necessarily non-equivalent, first-scan)
        // call, so only the second scan's calls are counted.
        const canonicalOccurrences = opened.repositories.canonicalOccurrences;
        const projectionOccurrences = opened.projectionOccurrences;
        let currentlyVisibleCalls = 0;
        let currentlyVisibleForOwnersCalls = 0;
        let currentlyVisibleForOwnersSlimCalls = 0;
        const originalCurrentlyVisible = canonicalOccurrences.currentlyVisible.bind(canonicalOccurrences);
        const originalCurrentlyVisibleForOwners = canonicalOccurrences.currentlyVisibleForOwners.bind(canonicalOccurrences);
        const originalCurrentlyVisibleForOwnersSlim = projectionOccurrences.currentlyVisibleForOwnersSlim.bind(projectionOccurrences);
        canonicalOccurrences.currentlyVisible = (generation) => { currentlyVisibleCalls += 1; return originalCurrentlyVisible(generation); };
        canonicalOccurrences.currentlyVisibleForOwners = (generation, ownerArtifactIds) => { currentlyVisibleForOwnersCalls += 1; return originalCurrentlyVisibleForOwners(generation, ownerArtifactIds); };
        projectionOccurrences.currentlyVisibleForOwnersSlim = (generation, ownerArtifactIds) => { currentlyVisibleForOwnersSlimCalls += 1; return originalCurrentlyVisibleForOwnersSlim(generation, ownerArtifactIds); };

        const second = await runFullWorkspaceScan(scanOptions);
        expect(second.status).toBe("already_published");
        expect(currentlyVisibleCalls).toBe(0);
        expect(currentlyVisibleForOwnersCalls).toBe(0);
        expect(currentlyVisibleForOwnersSlimCalls).toBe(0);

        // Positive control: a real content change reaches `seal`, so the
        // owner-narrowed loader DOES run.
        await writeFile(join(workspaceRoot, "extra.ts"), "export class NoOpQueryMarker {}\n", "utf8");
        const third = await runFullWorkspaceScan(scanOptions);
        expect(third.status).toBe("published");
        expect(currentlyVisibleForOwnersCalls).toBeGreaterThan(0);
        // The fat, un-narrowed loader is never called by `runFullWorkspaceScan`
        // at all anymore -- narrowing replaced it outright at both of this
        // file's call sites, it did not add a narrowed path alongside it.
        expect(currentlyVisibleCalls).toBe(0);
      } finally {
        await opened.close();
      }
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 60_000);

  // THE key Phase 5 integration test: index a small multi-file fixture with
  // real cross-file imports, publish, touch ONE file, rescan, and assert (a)
  // only the changed file + its reverse-dependents were analyzed, (b)
  // unchanged owners' records were reused (same record_ids, same
  // valid_from_generation), (c) the generation advanced to 2, and (d) a
  // further rescan of the now-unchanged repo still short-circuits
  // "equivalent" (no analysis at all).
  it("re-analyzes only affected owners on a targeted rescan, reuses everyone else's records, and still short-circuits an untouched repeat scan", async () => {
    const workspaceId = "workspace:workspace-indexing-session-incremental";
    const prepared = await prepareRegistry(workspaceId);
    const registrySnapshotId = prepared.registry.registry_snapshot_id;
    const configurationRevisionId = `configuration:${workspaceId}`;
    const plugin = buildIncrementalPluginProvider(prepared, workspaceId, registrySnapshotId, configurationRevisionId);

    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-workspace-indexing-session-incremental-root-"));
    await cp(fixtureRoot, workspaceRoot, { recursive: true });

    const root = await mkdtemp(join(tmpdir(), "urdira-workspace-indexing-session-incremental-"));
    const storage = await createDurableStorage({ rootDir: root });
    try {
      await storage.catalog.registerWorkspace({ workspace_id: workspaceId, canonical_root: workspaceRoot, display_root: workspaceRoot, source_provider_bindings: [], status: "registered", registered_at: now });
      const opened = await storage.openWorkspace(workspaceId);
      try {
        const scanOptions = { root: workspaceRoot, database: asStorageDatabase(opened), workspace_id: workspaceId, plugin, inclusion_rules: { include: [], exclude: ["dist/**", "node_modules/**"], allow_external_root: false }, now: () => now };

        const first = await runFullWorkspaceScan(scanOptions);
        expect(first.status).toBe("published");
        expect(first.generation).toBe(1);
        // First scan: no prior generation to reuse anything from, so every
        // source owner is affected.
        const analyzedOnFirstScan = analyzedOwnerPathsByWorkspace.get(workspaceId) ?? [];
        expect(analyzedOnFirstScan).toEqual(expect.arrayContaining(["src/domain/task.ts", "src/domain/errors.ts"]));
        analyzedOwnerPathsByWorkspace.delete(workspaceId);

        const visibleRecords = async (): Promise<readonly { readonly record_id: string; readonly record_digest: string; readonly valid_from_generation: number }[]> =>
          opened.database.all<{ record_id: string; record_digest: string; valid_from_generation: number }>(
            "SELECT record_id, record_digest, valid_from_generation FROM record_occurrences WHERE workspace_id = ? AND valid_to_generation IS NULL ORDER BY record_id",
            [workspaceId],
          );
        const visibleAfterFirst = await visibleRecords();
        expect(visibleAfterFirst.length).toBeGreaterThan(0);

        // Untouched-repo rescan: must still short-circuit "equivalent" (no
        // transitions at all), and therefore never even calls `analyze` --
        // `analyzedOwnerPathsByWorkspace` for this workspace stays deleted.
        const equivalentScan = await runFullWorkspaceScan(scanOptions);
        expect(equivalentScan.status).toBe("already_published");
        expect(equivalentScan.generation).toBe(1);
        expect(analyzedOwnerPathsByWorkspace.has(workspaceId)).toBe(false);

        // ONE real, targeted content change: `domain/task.ts` (whose direct
        // importers, per the fixture, are `repository/task-repository.ts`,
        // `repository/in-memory-task-repository.ts`, and (via re-export)
        // `src/index.ts`; `domain/errors.ts` neither imports nor is
        // imported by `task.ts`, so it is a genuine negative case).
        await writeFile(join(workspaceRoot, "src", "domain", "task.ts"), `${await readFile(join(workspaceRoot, "src", "domain", "task.ts"), "utf8")}\nexport type TaskPriority = "low" | "medium" | "high";\n`, "utf8");
        const second = await runFullWorkspaceScan(scanOptions);
        expect(second.status).toBe("published");
        expect(second.generation).toBe(2);

        const analyzedOnSecondScan = analyzedOwnerPathsByWorkspace.get(workspaceId) ?? [];
        // (a) Only the changed file and its reverse-dependents were
        // analyzed: the directly changed file itself, and its real
        // dependents (proving reverse-dependents were actually computed and
        // included, not just the changed file alone).
        expect(analyzedOnSecondScan).toContain("src/domain/task.ts");
        expect(analyzedOnSecondScan).toEqual(expect.arrayContaining(["src/repository/task-repository.ts", "src/repository/in-memory-task-repository.ts"]));
        // A genuinely unrelated file (no import relationship with task.ts
        // in either direction) must NOT have been re-analyzed.
        expect(analyzedOnSecondScan).not.toContain("src/domain/errors.ts");
        // And strictly fewer owners were analyzed than on the first scan --
        // the whole point of affected-owner narrowing.
        expect(analyzedOnSecondScan.length).toBeLessThan(analyzedOnFirstScan.length);

        // (b) Unaffected owners' records survive untouched: every record
        // owned by `domain/errors.ts` that was visible after the first scan
        // is STILL visible, under the identical record_id and
        // valid_from_generation (generation 1, never touched at generation
        // 2), even though the candidate that just published covered the
        // whole workspace.
        const visibleAfterSecond = await visibleRecords();
        // Records owned by `domain/errors.ts` specifically -- the file this
        // scan proved (above) was NOT re-analyzed -- via the canonical
        // occurrence repository, scoped to its real artifact id.
        const errorsArtifact = await opened.database.get<{ artifact_id: string }>("SELECT artifact_id FROM source_artifacts WHERE workspace_id = ? AND normalized_path = ?", [workspaceId, "src/domain/errors.ts"]);
        expect(errorsArtifact).toBeDefined();
        const errorsRecordsBefore = await opened.repositories.canonicalOccurrences.listByOwner(errorsArtifact!.artifact_id);
        expect(errorsRecordsBefore.length).toBeGreaterThan(0);
        const byIdAfterFirst = new Map(visibleAfterFirst.map((row) => [row.record_id, row]));
        for (const record of errorsRecordsBefore) {
          const before = byIdAfterFirst.get(record.record_id);
          const after = visibleAfterSecond.find((row) => row.record_id === record.record_id);
          expect(after).toBeDefined();
          expect(after!.valid_from_generation).toBe(before?.valid_from_generation);
          expect(after!.record_digest).toBe(before?.record_digest);
        }
      } finally {
        await opened.close();
      }
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 60_000);

  // docs/decisions/14-plugin-upgrade-relock.md: a rescan whose target
  // resolution lock differs from the workspace's currently published one
  // (standing in for a real plugin upgrade) must publish a NEW generation
  // even over a byte-identical tree, and must fully re-analyze (no
  // `changed_artifact_ids`) rather than trust the (empty) source diff --
  // an unchanged file's records under the OLD lock/analyzer must not
  // silently survive under the new one. A further rescan under the SAME
  // (now current) lock B, still over the unchanged tree, must settle back
  // to the ordinary equivalent/already_published short-circuit. Finally
  // (see the inline comment further down), a real content edit scanned
  // right after that no-source-change upgrade generation is the exact
  // reproduction of the generation-desync bug fixed alongside this test:
  // it must publish the next generation cleanly, not throw
  // `storage:publication_conflict`.
  it("forces a full republish under a new generation when the target resolution lock changes over an unchanged tree, then re-settles to equivalent, then publishes cleanly on the next real edit", async () => {
    const workspaceId = "workspace:workspace-indexing-session-relock";
    const preparedA = await prepareRegistry(workspaceId, "a");
    const pluginA = buildLockChangeTrackingProvider(preparedA, workspaceId, preparedA.registry.registry_snapshot_id, `configuration:${workspaceId}:${preparedA.lock.resolution_lock_id}`);

    const preparedB = await prepareRegistry(workspaceId, "b");
    const pluginB = buildLockChangeTrackingProvider(preparedB, workspaceId, preparedB.registry.registry_snapshot_id, `configuration:${workspaceId}:${preparedB.lock.resolution_lock_id}`);

    expect(preparedA.lock.resolution_lock_id).not.toBe(preparedB.lock.resolution_lock_id);
    expect(preparedA.registry.registry_snapshot_id).not.toBe(preparedB.registry.registry_snapshot_id);

    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-workspace-indexing-session-relock-root-"));
    await cp(fixtureRoot, workspaceRoot, { recursive: true });

    const root = await mkdtemp(join(tmpdir(), "urdira-workspace-indexing-session-relock-"));
    const storage = await createDurableStorage({ rootDir: root });
    try {
      await storage.catalog.registerWorkspace({ workspace_id: workspaceId, canonical_root: workspaceRoot, display_root: workspaceRoot, source_provider_bindings: [], status: "registered", registered_at: now });
      const opened = await storage.openWorkspace(workspaceId);
      try {
        const baseOptions = { root: workspaceRoot, database: asStorageDatabase(opened), workspace_id: workspaceId, inclusion_rules: { include: [], exclude: ["dist/**", "node_modules/**"], allow_external_root: false }, now: () => now };

        changedArtifactIdsByWorkspace.set(workspaceId, NOT_CALLED);
        const first = await runFullWorkspaceScan({ ...baseOptions, plugin: pluginA });
        expect(first.status).toBe("published");
        expect(first.generation).toBe(1);
        // First scan: no prior generation to reuse anything from, so
        // `changed_artifact_ids` is correctly omitted here too -- this just
        // establishes the baseline before the lock-change assertion below.
        expect(changedArtifactIdsByWorkspace.get(workspaceId)).toBeUndefined();

        // Same, byte-identical tree, but a DIFFERENT target resolution lock
        // (lock B instead of A): must still publish a genuinely new
        // generation, never settle on "equivalent"/"already_published".
        changedArtifactIdsByWorkspace.set(workspaceId, NOT_CALLED);
        const second = await runFullWorkspaceScan({ ...baseOptions, plugin: pluginB });
        expect(second.status).toBe("published");
        expect(second.state).toBe("published");
        expect(second.generation).toBe(2);
        expect(second.snapshot_id).not.toBe(first.snapshot_id);
        // Full re-analysis: `analyze` was actually called (not skipped) and
        // received no `changed_artifact_ids`, even though the source tree
        // itself produced zero transitions.
        expect(changedArtifactIdsByWorkspace.get(workspaceId)).not.toBe(NOT_CALLED);
        expect(changedArtifactIdsByWorkspace.get(workspaceId)).toBeUndefined();

        // A third scan again under lock B (now the workspace's own current
        // lock) over the still-unchanged tree: ordinary idempotence applies
        // again -- settles back to equivalent/already_published, and
        // `analyze` is not called at all.
        changedArtifactIdsByWorkspace.set(workspaceId, NOT_CALLED);
        const third = await runFullWorkspaceScan({ ...baseOptions, plugin: pluginB });
        expect(third.status).toBe("already_published");
        expect(third.state).toBe("published");
        expect(third.generation).toBe(2);
        expect(third.snapshot_id).toBe(second.snapshot_id);
        expect(changedArtifactIdsByWorkspace.get(workspaceId)).toBe(NOT_CALLED);

        // Generation-desync regression: the second scan (above) published a
        // new snapshot generation (2) with NO source change at all -- an
        // upgrade generation, exactly like a real plugin upgrade -- so the
        // stage-1 source index's own counter (`source_index_state.current_generation`)
        // never advanced past what the first scan left it at (1), while the
        // workspace's publication-side generation moved to 2. A real content
        // edit now, scanned under the SAME (already-current) lock B, is an
        // ordinary genuine change: `GenericSourceIndexer.applyBatch` must
        // stamp its new `artifact_versions` row with the generation this
        // scan's own publish will actually use (3), not one generation
        // behind it (2, `source_index_state`'s counter + 1) -- the latter is
        // exactly what used to make this scan's publish deterministically
        // throw `storage:publication_conflict` (`packages/storage/src/publication-authority.ts`'s
        // `assertPublicationImmutableRows`, `mismatched_fields:
        // 'valid_from_generation,artifact_version_payload'`) and leave the
        // workspace degraded, self-healing only on the NEXT edit after that.
        await writeFile(join(workspaceRoot, "extra.ts"), "export class ExtraPostUpgradeMarker {}\n", "utf8");
        changedArtifactIdsByWorkspace.set(workspaceId, NOT_CALLED);
        const fourth = await runFullWorkspaceScan({ ...baseOptions, plugin: pluginB });
        expect(fourth.status).toBe("published");
        expect(fourth.state).toBe("published");
        expect(fourth.generation).toBe(3);
        expect(fourth.snapshot_id).not.toBe(third.snapshot_id);
      } finally {
        await opened.close();
      }
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
