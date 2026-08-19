import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArtifactWorkItem, IndexCandidate, QueryRequest, ReplacementScope, SnapshotCapabilityStateEntry } from "@urdira/contracts";
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
  CandidateMaterializer,
  CanonicalRecordQueryDataPort,
  CursorCache,
  FactDeltaAcceptanceService,
  QueryEngine,
  SqliteCanonicalQuerySnapshotPort,
  candidateTargetRegistryFromSnapshot,
  createCanonicalPluginDigestAuthority,
  type AcceptedFactDelta,
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
  type AnalyzerFile,
} from "../../packages/plugin-javascript-typescript/src/index.js";
import {
  createDurableStorage,
  frozenCandidateBaseTupleDigest,
  type CandidatePublicationInput,
  type WorkspaceDatabase,
} from "../../packages/storage/src/index.js";

/**
 * A trimmed, reusable variant of `tests/javascript-typescript-production-e2e.test.ts`'s
 * publish pipeline: builds, materializes, and publishes the task-planner
 * fixture for the requested language, and hands back a live `QueryEngine`
 * plus the raw `opened` workspace handle (for tests that also want to reach
 * into storage directly, e.g. to build a warm/cold-pushdown pair). Callers
 * MUST call `close()` when done.
 */

const here = dirname(fileURLToPath(import.meta.url));
const now = "2026-08-11T12:00:00.000Z";
const encoder = new TextEncoder();

interface FixtureManifest {
  readonly fixture: { readonly id: string; readonly language: "javascript" | "typescript" };
  readonly artifacts: readonly string[];
}

interface FixtureFile extends AnalyzerFile {
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly content_hash: string;
}

interface PreparedRegistry {
  readonly registry: AssembledPluginRegistry;
  readonly lock: SdkPluginResolutionLock;
  readonly plugin: DiscoveredPluginPackage;
}

function fixturePaths(language: "javascript" | "typescript"): { readonly root: string; readonly manifest: string } {
  const root = resolve(here, "..", "fixtures", "codebases", language, "task-planner");
  return { root, manifest: resolve(root, "..", "task-planner.gold.json") };
}

async function loadFixture(language: "javascript" | "typescript"): Promise<{ readonly manifest: FixtureManifest; readonly files: readonly FixtureFile[] }> {
  const paths = fixturePaths(language);
  const manifest = JSON.parse(await readFile(paths.manifest, "utf8")) as FixtureManifest;
  const files = await Promise.all(manifest.artifacts.map(async (path): Promise<FixtureFile> => {
    const text = await readFile(join(paths.root, path), "utf8");
    const coordinate = `${manifest.fixture.id}:${path}`;
    return { path, text, artifact_id: `artifact:${coordinate}`, artifact_version_id: `version:${coordinate}`, content_hash: canonicalSha256(text) };
  }));
  return { manifest, files };
}

async function prepareRegistry(workspaceId: string): Promise<PreparedRegistry> {
  const digests = createCanonicalPluginDigestAuthority();
  const assets = [
    { normalized_relative_path: "dist/worker.mjs", bytes: encoder.encode("urdira production jsts worker"), executable: true, role: "parser" as const },
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

async function seedSource(opened: WorkspaceDatabase, workspaceId: string, fixtureId: string, files: readonly FixtureFile[]): Promise<string> {
  const batchId = `observation-batch:${fixtureId}`;
  await opened.repositories.sourceCatalog.putObservationBatch({
    observation_batch_id: batchId, workspace_id: workspaceId, source_provider_binding_id: "provider:fixture",
    source_provider: "core:filesystem", source_provider_version: "1.0.0", ordering_domain: fixtureId,
    observation_mode: "reconciliation", coverage_scopes: "[]", coverage_completeness: "complete", deletion_authority: "authoritative",
    started_at: now, completed_at: now, observation_count: files.length, unavailable_count: 0, batch_digest: canonicalSha256(files.map((file) => file.content_hash)),
  });
  for (const file of files) {
    const observationId = `observation:${fixtureId}:${file.path}`;
    await opened.repositories.sourceCatalog.putArtifact({ artifact_id: file.artifact_id, workspace_id: workspaceId, normalized_uri: `file:///${fixtureId}/${file.path}`, normalized_path: file.path, display_path: file.path, artifact_kind: "source_file" });
    await opened.repositories.sourceCatalog.putContentBlob({ content_blob_id: `blob:${fixtureId}:${file.path}`, content_hash: file.content_hash, byte_length: encoder.encode(file.text).byteLength, storage_reference: `fixture:${fixtureId}:${file.path}` });
    await opened.repositories.sourceCatalog.putObservation({
      source_observation_id: observationId, observation_batch_id: batchId, workspace_id: workspaceId, artifact_id: file.artifact_id,
      source_provider_binding_id: "provider:fixture", source_provider: "core:filesystem", source_provider_version: "1.0.0", ordering_domain: fixtureId,
      observation_mode: "reconciliation", observed_state: "present", observed_content_hash: file.content_hash, observed_metadata_digest: canonicalSha256({ path: file.path }), observed_at: now, received_at: now,
    });
    await opened.repositories.sourceCatalog.putArtifactVersion({
      artifact_version_id: file.artifact_version_id, workspace_id: workspaceId, artifact_id: file.artifact_id,
      content_blob_id: `blob:${fixtureId}:${file.path}`, content_hash: file.content_hash, byte_length: encoder.encode(file.text).byteLength,
      encoding: "utf-8", ...(languageForPath(file.path) === undefined ? {} : { language_hint: languageForPath(file.path)! }),
      analysis_metadata_digest: canonicalSha256({ path: file.path, language: languageForPath(file.path) ?? "configuration" }), created_from_observation_id: observationId, valid_from_generation: 1,
    });
  }
  return batchId;
}

function accessManifest(workItemId: string, analysisContextDigest: string, files: readonly FixtureFile[]): AutomaticPluginInputAccessManifest {
  const core = {
    request_id: `request:${workItemId}`,
    analysis_view_digest: analysisContextDigest,
    artifact_version_entries: files.map((file) => ({ artifact_id: file.artifact_id, artifact_version_id: file.artifact_version_id, content_hash: file.content_hash, access_modes: ["artifact_read" as const] })),
    record_entries: [], lookup_entries: [], transitive_artifact_version_ids: [],
  };
  return {
    plugin_input_access_manifest_id: pluginInputAccessManifestId(core.request_id, core.analysis_view_digest),
    ...core,
    manifest_digest: pluginInputAccessManifestDigest(core),
  };
}

async function acceptFixtureDeltas(input: {
  readonly workspace_id: string;
  readonly candidate: IndexCandidate;
  readonly files: readonly FixtureFile[];
  readonly prepared: PreparedRegistry;
}): Promise<readonly AcceptedFactDelta[]> {
  const artifactVersions = input.files.map((file) => ({ artifact_id: file.artifact_id, artifact_version_id: file.artifact_version_id, content_hash: file.content_hash }));
  const targetRegistry = candidateTargetRegistryFromSnapshot({ registry: input.prepared.registry, artifact_versions: artifactVersions });
  const acceptance = new FactDeltaAcceptanceService();
  const worker = createJavascriptTypescriptWorker({
    compatibility_declaration_digest: input.prepared.plugin.compatibility.declaration_digest,
    registry_contribution_digest: input.prepared.plugin.contribution.contribution_digest,
    analysis_digest: input.prepared.plugin.compatibility.analysis_digest,
    analysis_configuration_digest: input.prepared.plugin.analysis_configuration_digest,
  });
  const sourceFiles = input.files.filter((file) => languageForPath(file.path) !== undefined);
  const accepted: AcceptedFactDelta[] = [];
  try {
    for (const owner of sourceFiles) {
      const workItemId = `work:${owner.artifact_id}`;
      const contextDigest = canonicalSha256({ registry: input.prepared.registry.registry_digest, owner: owner.artifact_version_id, inputs: artifactVersions });
      const scope: ReplacementScope = {
        replacement_scope_id: `scope:${owner.artifact_id}`, owner_artifact_id: owner.artifact_id, owner_artifact_version_id: owner.artifact_version_id,
        capability: "core:call_relationships", record_categories: ["diagnostic", "entity", "relation"], record_kinds: [...JAVASCRIPT_TYPESCRIPT_RECORD_KINDS],
        base_record_set_digest: canonicalSha256([]), output_completeness: "accept_reported",
      };
      const workItem = {
        work_item_id: workItemId, workspace_id: input.workspace_id, artifact_id: owner.artifact_id, target_artifact_version_id: owner.artifact_version_id,
        operation: "full", plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, plugin_version: JAVASCRIPT_TYPESCRIPT_VERSION,
        capabilities: JAVASCRIPT_TYPESCRIPT_CAPABILITIES.map((entry) => entry.capability), expected_replacement_scopes: [scope], reason_codes: ["core:artifact_changed"], cause_references: [],
        analysis_context_digest: contextDigest, work_item_digest: canonicalSha256({ workItemId, contextDigest }), candidate_generation_id: input.candidate.candidate_generation_id,
      } satisfies ArtifactWorkItem & { readonly candidate_generation_id: string };
      const manifest = accessManifest(workItemId, contextDigest, input.files);
      const analysisInputDigest = canonicalSha256({ owner: owner.path, inputs: manifest.artifact_version_entries });
      const response = await worker.invoke({
        protocol_version: "1.0.0", request_id: manifest.request_id, request_digest: analysisInputDigest, call: "analyze_artifact", deadline: "2030-01-01T00:00:00.000Z", cancellation_id: `cancel:${workItemId}`,
        payload: { files: input.files, root_names: sourceFiles.map((file) => file.path), owner_path: owner.path, work_item: workItem, accepted_manifest: manifest, analysis_digest: input.prepared.plugin.compatibility.analysis_digest, analysis_configuration_digest: input.prepared.plugin.analysis_configuration_digest, analysis_input_digest: analysisInputDigest, created_at: now },
      }) as { readonly payload: { readonly validation_input: { readonly raw_delta: unknown } } };
      accepted.push(await acceptance.accept({ candidate: input.candidate, work_item: workItem, raw_delta: response.payload.validation_input.raw_delta, accepted_manifest: manifest, expected_replacement_scopes: [scope], target_registry: targetRegistry, base_records: [], base_record_dependencies: [], staged_records: [], analysis_context_digest: contextDigest }));
    }
  } finally {
    await worker.terminate();
  }
  return accepted;
}

export function taskPlannerQuery(workspaceId: string, operation: string, args: Readonly<Record<string, unknown>>): QueryRequest {
  return {
    api_version: 1, scope: { scope_type: "single_workspace", workspace_id: workspaceId }, expression: { expression_type: "operation", operation, arguments: args },
    options: { freshness: "current", wait_timeout_ms: 0, coverage_requirement: "accept_reported", evidence: { evidence: "summary", evidence_chain_depth: 1 }, diagnostics: { diagnostics: "relevant", diagnostic_detail: true }, snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 }, registry: { registry: "used", include_payload_schemas: false }, response_budget: { max_items: 1_000, max_characters: 1_000_000 } },
  };
}

export interface PublishedTaskPlannerWorkspace {
  readonly workspaceId: string;
  readonly engine: QueryEngine;
  readonly opened: WorkspaceDatabase;
  readonly close: () => Promise<void>;
}

/** Publishes the task-planner fixture and returns a live, queryable workspace. Callers MUST await `close()`. */
export async function buildTaskPlannerWorkspace(language: "javascript" | "typescript"): Promise<PublishedTaskPlannerWorkspace> {
  const fixture = await loadFixture(language);
  const workspaceId = `workspace:${fixture.manifest.fixture.id}:${Math.random().toString(36).slice(2)}`;
  const prepared = await prepareRegistry(workspaceId);
  const root = await mkdtemp(join(tmpdir(), `urdira-${language}-support-workspace-`));
  const storage = await createDurableStorage({ rootDir: root });
  await storage.catalog.registerWorkspace({ workspace_id: workspaceId, canonical_root: fixturePaths(language).root, display_root: fixturePaths(language).root, source_provider_bindings: [], status: "registered", registered_at: now });
  const opened = await storage.openWorkspace(workspaceId);
  const batchId = await seedSource(opened, workspaceId, fixture.manifest.fixture.id, fixture.files);
  const candidate: IndexCandidate = {
    candidate_generation_id: `candidate:${fixture.manifest.fixture.id}`, workspace_id: workspaceId, target_registry_snapshot_id: prepared.registry.registry_snapshot_id,
    target_configuration_revision_id: `configuration:${fixture.manifest.fixture.id}`, trigger_kind: "full_reconciliation", state: "ready", source_observation_batch_ids: [batchId], created_at: now, ready_at: now, issue_ids: [],
  };
  const accepted = await acceptFixtureDeltas({ workspace_id: workspaceId, candidate, files: fixture.files, prepared });
  const claims = accepted.flatMap((delta) => delta.delta.completeness_claims).filter((claim) => claim.capability === "core:call_relationships");
  const capabilityStates: readonly SnapshotCapabilityStateEntry[] = [{
    capability: "core:call_relationships",
    capability_contract_version: "1.0.0",
    provider_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
    provider_version: JAVASCRIPT_TYPESCRIPT_VERSION,
    status: claims.every((claim) => claim.status === "complete") ? "complete" : "partial",
    reason_codes: [...new Set(claims.flatMap((claim) => JSON.parse(claim.reason_codes) as string[]))].sort(),
    affected_artifact_ids: [...new Set(claims.flatMap((claim) => JSON.parse(claim.affected_artifact_ids) as string[]))].sort(),
    diagnostic_record_ids: [],
  }];
  const sealed = new CandidateMaterializer().seal({
    candidate, manifest: { work_manifest_id: `manifest:${fixture.manifest.fixture.id}` } as never,
    source_plan: { transitions: [], seeds: [], equivalent: true, next_freshness_checkpoint: {} as never }, accepted_deltas: accepted, accepted_projection_sets: [], base_records: [], base_projections: [], capability_state_entries: capabilityStates, source_observation_watermarks: [], created_at: now,
    known_artifact_versions: fixture.files.map((file) => ({ artifact_id: file.artifact_id, artifact_version_id: file.artifact_version_id, content_digest: file.content_hash })),
    known_dependency_roles: [...JAVASCRIPT_TYPESCRIPT_DEPENDENCY_ROLES], known_lookup_dependencies: [],
  });
  const frozenBaseCore = { source_state_digest: canonicalSha256({ fixture: fixture.manifest.fixture.id, batchId }), source_observation_batch_ids: [batchId] as readonly string[] };
  const frozenBase = { ...frozenBaseCore, tuple_digest: frozenCandidateBaseTupleDigest({ ...frozenBaseCore, tuple_digest: "" }) };
  const configuration = {
    configuration_revision_id: candidate.target_configuration_revision_id, schema_version: 1, workspace_id: workspaceId,
    effective_configuration_schema_id: "core:bytes", effective_configuration_schema_version: 1, effective_configuration: encoder.encode("jsts"),
    installation_policy_digest: canonicalSha256("installation"), user_policy_digest: canonicalSha256("user"), workspace_file_digest: canonicalSha256("workspace"), administrative_override_digest: canonicalSha256("admin"),
    analysis_configuration_digest: prepared.plugin.analysis_configuration_digest, query_configuration_digest: canonicalSha256("query"), resolved_embedding_binding_digests: [], created_at: now, reason_code: "core:plugin_activated", revision_digest: canonicalSha256({ workspaceId, plugin: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID }),
  };
  const publication: CandidatePublicationInput = {
    candidate: { ...candidate, candidate_materialization_id: sealed.materialization.candidate_materialization_id }, frozen_base: frozenBase,
    materialization: sealed.materialization, target_registry: prepared.registry as never, target_resolution_lock: prepared.lock,
    target_configuration: configuration, freshness_checkpoint: { freshness_checkpoint_id: `freshness:${fixture.manifest.fixture.id}`, workspace_id: workspaceId, snapshot_id: `snapshot:${candidate.candidate_generation_id}`, source_state_digest: frozenBase.source_state_digest, provider_watermarks: "[]", verification_status: "complete", unavailable_artifact_ids: "[]", verified_at: now, checkpoint_digest: canonicalSha256({ workspaceId, batchId }) }, publication_kind: "activation",
    template_sets: {
      source_transitions: sealed.source_transitions,
      record_opens: sealed.record_opens,
      record_closures: sealed.record_closures,
      identity_assignments: sealed.identity_assignments,
      artifact_dependencies: sealed.record_dependencies,
      lookup_dependencies: sealed.lookup_bindings,
      lookup_revalidations: sealed.lookup_revalidations,
    },
  };
  await opened.candidates.insert(publication.candidate, frozenBase);
  await opened.publishCandidate(publication);
  const engine = new QueryEngine({ data_port: new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database)), cursor_cache: new CursorCache({ signing_secret: `secret:${workspaceId}` }), now: () => now });
  return {
    workspaceId,
    engine,
    opened,
    close: async () => {
      await opened.close();
      await storage.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
