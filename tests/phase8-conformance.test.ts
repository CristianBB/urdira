import { describe, expect, it } from "vitest";
import type {
  CompletenessReport,
  LanguageDefinition,
  PluginAnalysisView,
  PluginArtifactView,
  PluginResourceBudget,
  PluginRegistryContribution,
} from "@urdira/contracts";
import {
  computeDigest,
  digestDomainRegistry,
  digestRecipeDefinitions,
  externalVerificationContractDefinitions,
} from "@urdira/canonical";
import {
  canonicalSha256,
  createPluginAnalysisSession,
  hasExactKeys,
  pluginLookupResultSetDigest,
  PluginLookupInvalidationBinder,
  PluginRegistryAssembler,
  sha256Bytes,
  SupervisedPluginRuntime,
  workerRequestDigest,
  type AnalysisRecordView,
  type ArtifactFilter,
  type ArtifactFindResult,
  type ArtifactLookupResult,
  type ArtifactReadResult,
  type DependencyClosureResult,
  type PluginAnalysisViewPort,
  type PluginDependencyClosurePort,
  type PluginRecordReference,
  type PluginRecordSelector,
  type StagedAnalysisRecordView,
  type PluginWorkerCall,
  type PluginWorkerCallEnvelope,
  type PluginWorkerOutcome,
  type PortMaterializationLimits,
  type QuarantinePolicy,
  type QuarantineRecord,
  type QuarantineScope,
  type QuarantineStore,
  type RecordGetResult,
  type RecordQueryResult,
  type RegistryAssemblyInput,
  type InstalledPluginBundle,
  type PluginDigestAuthority,
  type SdkPluginResolutionLock,
  type WorkerKey,
  type WorkerPayloadValidator,
  type WorkerPoolPolicy,
  type WorkerRequestIdentityClaim,
  type WorkerRequestIdentityPort,
} from "@urdira/plugin-sdk";
import {
  createRustShapedWorker,
  createTypeScriptShapedWorker,
  type SyntheticPluginWorker,
  type SyntheticSessionRequest,
} from "../packages/testkit/src/index.js";

function registeredDigest(recipeId: string, value: unknown): string {
  const recipe = digestRecipeDefinitions.find((candidate) => candidate.digest_recipe_id === recipeId);
  if (!recipe) throw new Error(`missing recipe ${recipeId}`);
  const targetField = recipe.target_field.startsWith("/") ? recipe.target_field.slice(1) : undefined;
  const payload = targetField && value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== targetField))
    : value;
  return computeDigest(
    recipe.digest_domain,
    recipe.digest_recipe_id,
    Number(recipe.recipe_version),
    recipe.payload_schema_id,
    Number(recipe.payload_schema_version),
    payload,
  );
}

const pluginDigestAuthority: PluginDigestAuthority = {
  plugin_package: (value: unknown) => registeredDigest("core:plugin_package_digest", value),
  analyzer_implementation: (value: unknown) => registeredDigest("core:analyzer_implementation_digest", value),
  compatibility_declaration: (value: unknown) => registeredDigest("core:plugin_compatibility_declaration_digest", value),
  registry_contribution: (value) => registeredDigest("core:plugin_registry_contribution_digest", {
    ...value,
    runtime_component_definitions: value.runtime_component_definitions.map((definition) => ({
      ...definition,
      component_contracts: definition.component_contracts.map((binding) => ({
        ...binding,
        contract_version: Number(binding.contract_version),
        ...(binding.configuration_schema_version === undefined
          ? {}
          : { configuration_schema_version: Number(binding.configuration_schema_version) }),
      })),
    })),
  }),
  analysis_configuration: (value: unknown) => registeredDigest("core:analysis_configuration_digest", value),
  runtime_behavior: (value) => registeredDigest("core:runtime_component_behavior_digest", {
    ...value,
    contract_bindings: value.contract_bindings.map((binding) => ({
      ...binding,
      contract_version: Number(binding.contract_version),
      ...(binding.configuration_schema_version === undefined
        ? {}
        : { configuration_schema_version: Number(binding.configuration_schema_version) }),
    })),
  }),
  runtime_implementation: (value: unknown) => registeredDigest("core:runtime_component_implementation_digest", value),
  language_definition: (value: unknown) => registeredDigest("core:language_definition_digest", value),
  resolution_lock: (value) => registeredDigest("core:plugin_resolution_lock_digest", value),
  registry_snapshot: (value) => registeredDigest("core:registry_snapshot_digest", {
    ...value,
    namespace_bindings: value.namespace_bindings.map((binding) => ({
      ...binding,
      emission_valid_from_generation: Number(binding.emission_valid_from_generation),
      ...(binding.emission_valid_to_generation === undefined
        ? {}
        : { emission_valid_to_generation: Number(binding.emission_valid_to_generation) }),
    })),
  }),
  has_core_digest_domain: (value: string) => digestDomainRegistry.some((entry) => entry.digest_domain === value),
  has_core_digest_recipe: (id: string, version: string) => digestRecipeDefinitions
    .some((entry) => entry.digest_recipe_id === id && entry.recipe_version === version),
  has_core_external_verifier: (id: string, version: string) => externalVerificationContractDefinitions
    .some((entry) => entry.external_verification_contract_id === id && entry.contract_version === version),
};

const complete: CompletenessReport = {
  workspace_snapshot_binding_ids: ["binding-1"],
  overall_status: "complete",
  dimensions: [],
  diagnostic_record_ids: [],
};

const analysisView: PluginAnalysisView = Object.freeze({
  analysis_view_digest: canonicalSha256("phase8-view"),
  workspace_id: "workspace-conformance",
  candidate_generation_id: "candidate-conformance",
  base_snapshot_id: "snapshot-base",
  source_overlay_digest: canonicalSha256("overlay"),
  prerequisite_stage_set_digest: canonicalSha256("prerequisites"),
  target_registry_snapshot_id: "registry-target",
  resolution_lock_id: "resolution-lock",
  configuration_revision_id: "configuration-revision",
});

const contextBudget: PluginResourceBudget = {
  deadline: "2099-01-01T00:00:00.000Z",
  max_memory_bytes: "1048576",
  max_output_bytes: "1048576",
  max_records: "100",
  max_dependencies: "100",
  max_context_operations: "100",
  max_context_bytes: "1048576",
  max_recursion_depth: "10",
};

const workerKey: WorkerKey = {
  package_digest: canonicalSha256("synthetic-package"),
  runtime_contract_version: 1,
  executable_build_digest: canonicalSha256("synthetic-build"),
};

const protocolMaterializationLimits: PortMaterializationLimits = Object.freeze({
  max_items: 256,
  max_depth: 16,
  max_nodes: 2_048,
  max_bytes: 65_536,
});

const metadataMaterializationLimits: PortMaterializationLimits = Object.freeze({
  max_items: 256,
  max_depth: 8,
  max_nodes: 1_024,
  max_bytes: 16_384,
});

const workerPoolPolicy: WorkerPoolPolicy = Object.freeze({
  max_pooled_workers: 32,
  max_worker_keys: 32,
  max_workers_per_key: 8,
});

const emptyContribution = {
  plugin_id: "fixture:plugin",
  plugin_version: "1.0.0",
  namespace: "fixture",
  registry_contract_version: "1",
  dependencies: [],
  canonical_schema_definitions: [], digest_domain_definitions: [], canonical_comparator_definitions: [],
  external_verification_contract_definitions: [], runtime_component_definitions: [], digest_recipe_definitions: [],
  digest_reference_definitions: [], language_definitions: [], capability_contract_definitions: [],
  construct_class_definitions: [], capability_limitation_definitions: [], record_kind_definitions: [], facet_definitions: [],
  semantic_role_definitions: [], metric_definitions: [], effect_definitions: [], diagnostic_code_definitions: [],
  candidate_issue_code_definitions: [], dependency_role_definitions: [], projection_kind_definitions: [],
  lifecycle_reason_code_definitions: [], completeness_reason_definitions: [], semantic_section_kind_definitions: [],
  semantic_reason_definitions: [], evidence_assumption_definitions: [], evidence_explanation_definitions: [],
  contribution_digest: "sha256:contribution",
} satisfies PluginRegistryContribution;

const sharedLanguage: LanguageDefinition = {
  language_id: "languages:shared",
  definition_revision: 1,
  schema_version: 1,
  description: "Shared fixture language.",
  display_name: "Shared",
  aliases: ["shared"],
  lifecycle_state: "active",
};

function registryPackage(plugin_id: string, namespace: string, language: LanguageDefinition = sharedLanguage): InstalledPluginBundle {
  const runtimeComponentBuildId = `${namespace}:runtime_build`;
  const runtimeComponentId = `${namespace}:runtime`;
  const installedFileBytes = new TextEncoder().encode(`fixture:${plugin_id}`);
  const installedFileDigest = sha256Bytes(installedFileBytes);
  const runtimeBehavior = {
    component_id: runtimeComponentId,
    component_version: "1.0.0",
    component_kind: "source_provider" as const,
    contract_bindings: [{ component_kind: "source_provider" as const, contract_version: "1" }],
    configuration_schema_ids: [],
    algorithm_ids: [],
    supported_format_ids: [],
    deterministic_numeric_contract: "integer_only",
    portable_behavior_rules: [],
  };
  const runtimeImplementation = {
    runtime_component_build_id: runtimeComponentBuildId,
    component_id: runtimeComponentId,
    component_version: "1.0.0",
    behavior_digest: pluginDigestAuthority.runtime_behavior(runtimeBehavior),
    target_triple: "test",
    executable_asset_digests: [installedFileDigest],
    native_asset_digests: [],
    dependency_asset_digests: [],
  };
  const manifest = {
    package_format_id: "core:plugin",
    package_format_version: 1,
    plugin_id,
    plugin_version: "1.0.0",
    package_files: [{
      normalized_relative_path: "plugin.js",
      content_digest: installedFileDigest,
      byte_length: installedFileBytes.byteLength,
      executable: true,
    }],
  };
  const analysisManifest = {
    plugin_id,
    plugin_version: "1.0.0",
    analyzer_id: plugin_id,
    analyzer_version: "1.0.0",
    executable_asset_digests: [installedFileDigest],
    parser_asset_digests: [],
    rule_asset_digests: [],
    model_asset_digests: [],
    dependency_asset_digests: [],
    supported_capabilities: [],
  };
  const analysisConfiguration = {
    configuration_schema_id: "core:analysis_configuration",
    configuration_schema_version: 1,
    normalized_configuration: new Uint8Array(),
  };
  const { contribution_digest: _contributionDigest, ...emptyContributionCore } = emptyContribution;
  const contributionCore = {
    ...emptyContributionCore,
    plugin_id,
    namespace,
    registry_contract_version: "1.0.0",
    language_definitions: [language],
    runtime_component_definitions: [{
      component_id: runtimeComponentId,
      definition_revision: 1,
      schema_version: 1,
      component_version: "1.0.0",
      component_contracts: [{ component_kind: "source_provider", contract_version: "1" }],
      description: "Synthetic conformance runtime.",
      behavior_digest: pluginDigestAuthority.runtime_behavior(runtimeBehavior),
      plugin_owner: plugin_id,
      lifecycle_state: "active",
    }],
  };
  const compatibilityCore = {
    declaration_schema_version: "1.0.0",
    plugin_id,
    plugin_version: "1.0.0",
    namespace,
    supported_plugin_contract_versions: [1],
    supported_registry_contract_versions: [1],
    dependencies: [],
    offered_capabilities: [],
    recommended_embedding_profile_ids: [],
    package_digest: pluginDigestAuthority.plugin_package(manifest),
    analysis_digest: pluginDigestAuthority.analyzer_implementation(analysisManifest),
  };
  return {
    package_locator: `fixture:${plugin_id}`,
    manifest,
    compatibility: { ...compatibilityCore, declaration_digest: registeredDigest("core:plugin_compatibility_declaration_digest", compatibilityCore) },
    contribution: { ...contributionCore, contribution_digest: pluginDigestAuthority.registry_contribution(contributionCore as unknown as PluginRegistryContribution) },
    runtime_builds: [{
      runtime_component_build_id: runtimeComponentBuildId,
      schema_version: 1,
      component_id: runtimeComponentId,
      component_version: "1.0.0",
      behavior_digest: pluginDigestAuthority.runtime_behavior(runtimeBehavior),
      implementation_digest: pluginDigestAuthority.runtime_implementation(runtimeImplementation),
      available_from: "1.0.0",
      selectable_to: "",
      removed_at: "",
    }],
    analyzer_implementation_manifest: analysisManifest,
    analysis_configuration: analysisConfiguration,
    runtime_behavior_manifests: [runtimeBehavior],
    runtime_implementation_manifests: [runtimeImplementation],
  };
}

function authoritativeLockDigest(
  lock: Pick<SdkPluginResolutionLock, "resolution_lock_id" | "workspace_id" | "resolver_version" | "resolved_plugins">,
): string {
  return pluginDigestAuthority.resolution_lock({
    resolution_lock_id: lock.resolution_lock_id,
    workspace_id: lock.workspace_id,
    resolver_version: lock.resolver_version,
    resolved_plugins: lock.resolved_plugins,
  });
}

function registryInput(bundles: readonly InstalledPluginBundle[]): RegistryAssemblyInput {
  const packages = bundles.map((bundle) => ({
    ...bundle,
    plugin_id: bundle.manifest.plugin_id,
    plugin_version: bundle.manifest.plugin_version,
    namespace: bundle.compatibility.namespace,
    package_digest: bundle.compatibility.package_digest,
    declaration_digest: bundle.compatibility.declaration_digest,
    contribution_digest: bundle.contribution.contribution_digest,
    analysis_configuration_digest: pluginDigestAuthority.analysis_configuration(bundle.analysis_configuration),
  }));
  const lockCore = {
    resolution_lock_id: "lock-conformance", workspace_id: "workspace-conformance", resolver_version: "1.0.0",
    resolved_plugins: packages.map((item) => ({
      plugin_id: item.plugin_id, plugin_version: item.plugin_version, namespace: item.namespace,
      package_digest: item.package_digest, declaration_digest: item.declaration_digest,
      contribution_digest: item.contribution_digest,
      analysis_digest: item.compatibility.analysis_digest,
      analysis_configuration_digest: item.analysis_configuration_digest,
      plugin_contract_version: "1.0.0", registry_contract_version: "1.0.0", resolved_dependency_plugin_ids: [], effective_capabilities: [],
    })),
  };
  const lock: SdkPluginResolutionLock = {
    ...lockCore,
    lock_digest: authoritativeLockDigest(lockCore),
    created_at: "2026-08-09T00:00:00.000Z",
  };
  return {
    packages, lock, registry_snapshot_id: "registry-conformance", core_registry_digest: "sha256:core-registry",
    emission_valid_from_generation: "1",
    clock: () => "2026-08-09T00:00:00.000Z", id_source: () => "issue-conformance",
  };
}

const artifact = (
  artifact_id: string,
  normalized_uri: string,
  language_id: string,
  content: string,
): PluginArtifactView & { readonly fixture_content: string } => Object.freeze({
  artifact_id,
  artifact_version_id: `${artifact_id}-version`,
  normalized_uri,
  artifact_kind: "physical_file",
  content_hash: `sha256:${artifact_id}`,
  byte_length: Buffer.byteLength(content),
  encoding: "utf-8",
  language_ids: Object.freeze([language_id]),
  content_access: "readable",
  fixture_content: content,
});

const tsConfig = artifact("artifact-tsconfig", "tsconfig.json", "languages:typescript", "{\"files\":[\"src/a.ts\"]}");
const tsSource = artifact("artifact-ts-source", "src/a.ts", "languages:typescript", "export const answer = 42;");
const rustManifest = artifact("artifact-cargo", "Cargo.toml", "languages:rust", "[package]\nname='fixture'");
const rustModule = artifact("artifact-rust-module", "src/lib.rs", "languages:rust", "pub fn answer() -> u32 { 42 }");

const stagedRustModule: StagedAnalysisRecordView = Object.freeze({
  view_type: "staged",
  staged_record_id: "staged-rust-module",
  producing_work_item_id: "work-rust-prerequisite",
  proposal_record_key: "module:fixture",
  validated_record_digest: "sha256:staged-rust-module",
  category: "entity",
  kind: "fixture:rust_module",
  universal_kind: "core:module",
  facets: Object.freeze(["fixture:crate_member"]),
  owner_artifact_id: rustModule.artifact_id,
  owner_artifact_version_id: rustModule.artifact_version_id,
  body: Object.freeze({ module_name: "fixture" }),
});

class ReorderedViewPort implements PluginAnalysisViewPort {
  readonly #artifacts: readonly (PluginArtifactView & { readonly fixture_content: string })[];
  readonly #delay: Readonly<Record<string, number>>;

  constructor(
    artifacts: readonly (PluginArtifactView & { readonly fixture_content: string })[],
    delay: Readonly<Record<string, number>>,
  ) {
    this.#artifacts = artifacts;
    this.#delay = delay;
  }

  async #wait(operation: string): Promise<void> {
    const delay = this.#delay[operation] ?? 0;
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }

  async listArtifacts(filter: ArtifactFilter | undefined): Promise<ArtifactLookupResult> {
    await this.#wait("list");
    return {
      artifacts: this.#artifacts
        .filter((item) => filter?.language_id === undefined || item.language_ids.includes(filter.language_id))
        .map(({ fixture_content: _fixtureContent, ...item }) => item),
      completeness: complete,
    };
  }

  async findArtifact(normalized_uri: string): Promise<ArtifactFindResult> {
    await this.#wait(`find:${normalized_uri}`);
    const found = this.#artifacts.find((item) => item.normalized_uri === normalized_uri);
    if (found === undefined) return { completeness: complete };
    const { fixture_content: _fixtureContent, ...publicArtifact } = found;
    return { artifact: publicArtifact, completeness: complete };
  }

  async readArtifact(artifact_id: string): Promise<ArtifactReadResult> {
    await this.#wait(`read:${artifact_id}`);
    const item = this.#artifacts.find((candidate) => candidate.artifact_id === artifact_id);
    if (item === undefined) throw new Error("unknown fixture artifact");
    const { fixture_content, ...publicArtifact } = item;
    return { artifact: publicArtifact, content: fixture_content, completeness: complete };
  }

  async getRecord(reference: PluginRecordReference): Promise<RecordGetResult> {
    await this.#wait("get");
    return {
      ...(reference.record_type === "staged" && reference.staged_record_id === stagedRustModule.staged_record_id
        ? { record: stagedRustModule }
        : {}),
      completeness: complete,
    };
  }

  async queryRecords(_selector: PluginRecordSelector): Promise<RecordQueryResult> {
    await this.#wait("query");
    return { records: [], completeness: complete };
  }
}

class ConformanceClosurePort implements PluginDependencyClosurePort {
  async baseRecordClosure(_record_id: string): Promise<DependencyClosureResult> {
    return { proof: "proven", base_records: [], staged_records: [], artifact_version_ids: [] };
  }

  async stagedRecordClosure(staged_record_id: string): Promise<DependencyClosureResult> {
    return {
      proof: "proven",
      base_records: [],
      staged_records: [],
      artifact_version_ids: staged_record_id === stagedRustModule.staged_record_id ? [rustManifest.artifact_version_id] : [],
    };
  }
}

function sessionFactory(port: PluginAnalysisViewPort) {
  return (request: SyntheticSessionRequest) => createPluginAnalysisSession({
    analysis_view: analysisView,
    view_port: port,
    dependency_closure_port: new ConformanceClosurePort(),
    cancellation_signal: request.cancellation_signal,
    budget: contextBudget,
    request_id: request.request_id,
    request_digest: request.request_digest,
    plugin_id: request.plugin_id,
    plugin_version: request.plugin_version,
    analysis_digest: "sha256:fixture-analysis",
    analysis_configuration_digest: "sha256:fixture-configuration",
    call: request.call,
    call_payload: request.payload as never,
  });
}

class NeverQuarantinedStore implements QuarantineStore {
  async load(_scope: QuarantineScope): Promise<QuarantineRecord | undefined> { return undefined; }
  async record_crash(_scope: QuarantineScope, now_ms: number, policy: QuarantinePolicy): Promise<QuarantineRecord> {
    return policy.evaluate([now_ms], now_ms);
  }
}

class ConformanceWorkerRequestIdentityPort implements WorkerRequestIdentityPort {
  readonly #identities = new Map<string, string>();

  async claim(input: WorkerRequestIdentityClaim): Promise<"accepted" | "conflict"> {
    const prior = this.#identities.get(input.request_id);
    if (prior === undefined) {
      if (input.retry !== "new") return "conflict";
      this.#identities.set(input.request_id, input.identity_digest);
      return "accepted";
    }
    return input.retry === "retry_same" && prior === input.identity_digest ? "accepted" : "conflict";
  }
}

class ThresholdQuarantineStore implements QuarantineStore {
  readonly #records = new Map<string, QuarantineRecord>();

  #key(scope: QuarantineScope): string {
    return `${scope.workspace_id}:${scope.package_digest}:${scope.runtime_contract_version}:${scope.executable_build_digest}`;
  }

  async load(scope: QuarantineScope): Promise<QuarantineRecord | undefined> {
    return this.#records.get(this.#key(scope));
  }

  async record_crash(scope: QuarantineScope, now_ms: number, policy: QuarantinePolicy): Promise<QuarantineRecord> {
    const prior = this.#records.get(this.#key(scope));
    const next = policy.evaluate([...(prior?.crash_times_ms ?? []), now_ms], now_ms);
    this.#records.set(this.#key(scope), next);
    return next;
  }
}

const workerCalls = new Set<PluginWorkerCall>(["describe", "discover_partitions", "analyze_artifact", "generate_projection"]);

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 240 && !/[\0\r\n\t]/u.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString);
}

function isSafeMessage(value: unknown): value is string {
  return isString(value) && !/[\\/]/u.test(value) && !/\b(?:stack|token|password|secret|environment)\b/iu.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  return isString(value) && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function isResourceBudget(value: unknown): boolean {
  const keys = ["deadline", "max_memory_bytes", "max_output_bytes", "max_records", "max_dependencies", "max_context_operations", "max_context_bytes", "max_recursion_depth"];
  return hasExactKeys(value, keys)
    && isCanonicalTimestamp(value["deadline"])
    && keys.slice(1).every((key) => typeof value[key] === "string" && /^(?:0|[1-9]\d*)$/u.test(value[key]));
}

function isAnalysisView(value: unknown): boolean {
  if (!hasExactKeys(value, [
    "analysis_view_digest", "workspace_id", "candidate_generation_id", "source_overlay_digest",
    "prerequisite_stage_set_digest", "target_registry_snapshot_id", "resolution_lock_id", "configuration_revision_id",
  ], ["base_snapshot_id"])) return false;
  return ["analysis_view_digest", "source_overlay_digest", "prerequisite_stage_set_digest"].every((key) => isDigest(value[key]))
    && ["workspace_id", "candidate_generation_id", "target_registry_snapshot_id", "resolution_lock_id", "configuration_revision_id"]
      .every((key) => isString(value[key]))
    && (value["base_snapshot_id"] === undefined || isString(value["base_snapshot_id"]));
}

function isAnalysisContext(value: unknown): boolean {
  return hasExactKeys(value, ["analysis_view", "resource_budget"])
    && isAnalysisView(value["analysis_view"])
    && isResourceBudget(value["resource_budget"]);
}

function isArtifactWorkItem(value: unknown): boolean {
  if (!hasExactKeys(value, [
    "work_item_id", "workspace_id", "artifact_id", "operation", "plugin_id", "plugin_version", "capabilities",
    "expected_replacement_scopes", "reason_codes", "cause_references", "analysis_context_digest", "work_item_digest",
  ], ["base_artifact_version_id", "base_tombstone_id", "target_artifact_version_id", "target_tombstone_id"])) return false;
  return ["work_item_id", "workspace_id", "artifact_id", "plugin_id", "plugin_version"].every((key) => isString(value[key]))
    && (value["operation"] === "analyze" || value["operation"] === "close")
    && ["capabilities", "expected_replacement_scopes", "reason_codes"].every((key) => isStringArray(value[key]))
    && Array.isArray(value["cause_references"]) && value["cause_references"].length === 0
    && isDigest(value["analysis_context_digest"])
    && isDigest(value["work_item_digest"])
    && ["base_artifact_version_id", "base_tombstone_id", "target_artifact_version_id", "target_tombstone_id"]
      .every((key) => value[key] === undefined || isString(value[key]));
}

function isProjectionWorkItem(value: unknown): boolean {
  if (!hasExactKeys(value, [
    "projection_work_item_id", "workspace_id", "owner_artifact_id", "projection_kind", "operation", "generator",
    "generator_version", "generator_configuration_digest", "source_selection", "base_projection_set_digest", "reason_codes",
    "cause_references", "work_item_digest",
  ], ["owner_artifact_version_id", "target_tombstone_id"])) return false;
  return ["projection_work_item_id", "workspace_id", "owner_artifact_id", "projection_kind", "generator", "generator_version"]
    .every((key) => isString(value[key]))
    && (value["operation"] === "rebuild" || value["operation"] === "close")
    && ["generator_configuration_digest", "base_projection_set_digest", "work_item_digest"].every((key) => isDigest(value[key]))
    && hasExactKeys(value["source_selection"], ["owner_artifact_id"])
    && isString(value["source_selection"]["owner_artifact_id"])
    && isStringArray(value["reason_codes"])
    && Array.isArray(value["cause_references"]) && value["cause_references"].length === 0
    && ["owner_artifact_version_id", "target_tombstone_id"].every((key) => value[key] === undefined || isString(value[key]));
}

function isPartition(value: unknown): boolean {
  return hasExactKeys(value, [
    "partition_key", "language_ids", "member_artifact_ids", "configuration_artifact_ids", "resolution_roots", "capabilities",
  ]) && isString(value["partition_key"])
    && ["language_ids", "member_artifact_ids", "configuration_artifact_ids", "resolution_roots", "capabilities"]
      .every((key) => isStringArray(value[key]));
}

function isReplacementScope(value: unknown): boolean {
  return hasExactKeys(value, [
    "replacement_scope_id", "owner_artifact_id", "owner_artifact_version_id", "capability", "record_categories",
    "record_kinds", "base_record_set_digest", "output_completeness",
  ], ["partition_key"]) && ["replacement_scope_id", "owner_artifact_id", "owner_artifact_version_id", "capability"].every((key) => isString(value[key]))
    && isStringArray(value["record_categories"])
    && isStringArray(value["record_kinds"])
    && isDigest(value["base_record_set_digest"])
    && value["output_completeness"] === "complete";
}

function isProposedRecord(value: unknown): boolean {
  if (!hasExactKeys(value, [
    "proposal_record_key", "workspace_id", "owner_artifact_id", "owner_artifact_version_id", "category", "kind",
    "universal_kind", "facets", "schema_version", "body", "evidence_references",
  ], ["source_span", "identity_key"])) return false;
  const body = value["body"];
  const bodyValid = value["kind"] === "fixture:typescript_export"
    ? hasExactKeys(body, ["export_name", "declaration_form"]) && isString(body["export_name"]) && isString(body["declaration_form"])
    : value["kind"] === "fixture:rust_macro_expansion"
      ? hasExactKeys(body, ["module_path", "macro_expansion"]) && isString(body["module_path"]) && body["macro_expansion"] === true
      : false;
  return ["proposal_record_key", "workspace_id", "owner_artifact_id", "owner_artifact_version_id", "category", "kind", "universal_kind"]
    .every((key) => isString(value[key]))
    && isStringArray(value["facets"])
    && value["schema_version"] === 1
    && (value["source_span"] === undefined || isString(value["source_span"]))
    && (value["identity_key"] === undefined || isString(value["identity_key"]))
    && bodyValid
    && Array.isArray(value["evidence_references"]) && value["evidence_references"].length === 0;
}

function isProposedDependency(value: unknown): boolean {
  if (!hasExactKeys(value, [
    "proposed_dependency_id", "proposal_record_key", "dependency_artifact_id", "dependency_artifact_version_id",
    "dependency_role", "dependency_basis",
  ], ["source_reference"])) return false;
  return ["proposed_dependency_id", "proposal_record_key", "dependency_artifact_id", "dependency_artifact_version_id", "dependency_role", "dependency_basis"]
    .every((key) => isString(value[key]))
    && (value["source_reference"] === undefined
      || (value["source_reference"] !== null && typeof value["source_reference"] === "object"));
}

function isCompletenessClaim(value: unknown): boolean {
  return hasExactKeys(value, [
    "completeness_claim_id", "capability", "replacement_scope_ids", "status", "reason_codes", "affected_artifact_ids", "diagnostic_proposal_keys",
  ]) && isString(value["completeness_claim_id"])
    && isString(value["capability"])
    && value["status"] === "complete"
    && ["replacement_scope_ids", "reason_codes", "affected_artifact_ids", "diagnostic_proposal_keys"].every((key) => isStringArray(value[key]));
}

function isFactDelta(value: unknown): boolean {
  if (!hasExactKeys(value, [
    "fact_delta_id", "candidate_generation_id", "workspace_id", "work_item_id", "plugin_id", "plugin_version",
    "analysis_digest", "analysis_configuration_digest", "owner_artifact_id", "owner_artifact_version_id", "replacement_scopes",
    "input_artifact_version_ids", "input_record_ids", "plugin_input_access_manifest_id", "plugin_input_access_manifest_digest",
    "analysis_input_digest", "proposed_records", "proposed_dependencies", "completeness_claims", "created_at", "delta_digest",
  ], ["base_snapshot_id"])) return false;
  return [
    "fact_delta_id", "candidate_generation_id", "workspace_id", "work_item_id", "plugin_id", "plugin_version",
    "owner_artifact_id", "owner_artifact_version_id", "plugin_input_access_manifest_id",
  ].every((key) => isString(value[key]))
    && (value["base_snapshot_id"] === undefined || isString(value["base_snapshot_id"]))
    && ["analysis_digest", "analysis_configuration_digest", "plugin_input_access_manifest_digest", "analysis_input_digest", "delta_digest"]
      .every((key) => isDigest(value[key]))
    && Array.isArray(value["replacement_scopes"]) && value["replacement_scopes"].every(isReplacementScope)
    && isStringArray(value["input_artifact_version_ids"])
    && isStringArray(value["input_record_ids"])
    && Array.isArray(value["proposed_records"]) && value["proposed_records"].every(isProposedRecord)
    && Array.isArray(value["proposed_dependencies"]) && value["proposed_dependencies"].every(isProposedDependency)
    && Array.isArray(value["completeness_claims"]) && value["completeness_claims"].every(isCompletenessClaim)
    && isCanonicalTimestamp(value["created_at"]);
}

function isDerivedProjection(value: unknown): boolean {
  const coreKeys = [
    "projection_record_id", "projection_kind", "projection_key", "workspace_id", "owner_artifact_id", "owner_artifact_version_id",
    "source_artifact_version_ids", "source_record_ids", "source_projection_record_ids", "generator", "generator_version",
    "generator_configuration_digest", "created_from_snapshot_id", "valid_from_generation", "payload",
  ];
  if (!hasExactKeys(value, [...coreKeys, "content_digest"], ["valid_to_generation"])) return false;
  if (!["projection_record_id", "projection_kind", "projection_key", "workspace_id", "owner_artifact_id", "owner_artifact_version_id", "generator", "generator_version", "created_from_snapshot_id"]
    .every((key) => isString(value[key]))
    || !["source_artifact_version_ids", "source_record_ids", "source_projection_record_ids"].every((key) => isStringArray(value[key]))
    || !(value["source_artifact_version_ids"] as readonly string[]).includes(value["owner_artifact_version_id"] as string)
    || !isDigest(value["generator_configuration_digest"])
    || !Number.isSafeInteger(value["valid_from_generation"]) || (value["valid_from_generation"] as number) < 0
    || (value["valid_to_generation"] !== undefined
      && (!Number.isSafeInteger(value["valid_to_generation"]) || (value["valid_to_generation"] as number) <= (value["valid_from_generation"] as number)))
    || !hasExactKeys(value["payload"], ["summary"])
    || !isString(value["payload"]["summary"])
    || !isDigest(value["content_digest"])) return false;
  const core = Object.fromEntries(coreKeys.map((key) => [key, value[key]]));
  return value["content_digest"] === canonicalSha256(core);
}

function isProjectionReplacementSet(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isDerivedProjection)) return false;
  const ids = value.map((projection) => projection["projection_record_id"] as string);
  return new Set(ids).size === ids.length;
}

function factDeltaCore(delta: Record<string, unknown>): Record<string, unknown> {
  const { fact_delta_id: _factDeltaId, created_at: _createdAt, delta_digest: _deltaDigest, ...core } = delta;
  return core;
}

function sameStringList(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index])
    && new Set(value).size === value.length;
}

function validExecutionBindings(
  worker: SyntheticPluginWorker,
  request: PluginWorkerCallEnvelope,
  workspace_id: string,
  response: { readonly outcome: PluginWorkerOutcome; readonly payload: unknown },
): boolean {
  if (!hasExactKeys(response.payload, response.outcome === "success"
    ? request.call === "describe"
      ? ["compatibility_declaration_digest", "registry_contribution_digest", "supported_calls"]
      : request.call === "discover_partitions"
        ? ["partitions", "plugin_input_access_manifest_id", "plugin_input_access_manifest_digest", "analysis_input_digest"]
        : request.call === "analyze_artifact"
          ? ["fact_delta", "plugin_input_access_manifest_id", "plugin_input_access_manifest_digest", "analysis_input_digest"]
          : ["projection_replacement_set", "plugin_input_access_manifest_id", "plugin_input_access_manifest_digest", "analysis_input_digest"]
    : ["candidate_issue_code", "retryability", "message", "details"])) return false;
  const payload = response.payload;
  if (response.outcome !== "success") {
    return hasExactKeys(payload["details"], Object.keys(payload["details"] as object))
      && payload["details"]["request_id"] === request.request_id
      && payload["details"]["plugin_id"] === worker.plugin_id
      && payload["details"]["call"] === request.call
      && (response.outcome !== "cancelled" || payload["details"]["cancellation_id"] === request.cancellation_id);
  }
  if (request.call === "describe") {
    if (!hasExactKeys(request.payload, ["plugin_id", "plugin_version", "package_digest"])) return false;
    return request.payload["plugin_id"] === worker.plugin_id
      && request.payload["plugin_version"] === worker.plugin_version
      && payload["compatibility_declaration_digest"] === canonicalSha256({ plugin_id: worker.plugin_id, kind: "compatibility" })
      && payload["registry_contribution_digest"] === canonicalSha256({ plugin_id: worker.plugin_id, kind: "registry" });
  }
  const trace = worker.trace(request.request_id);
  if (trace === undefined
    || trace.plugin_id !== worker.plugin_id
    || trace.plugin_version !== worker.plugin_version
    || trace.manifest.request_id !== request.request_id
    || trace.manifest.plugin_input_access_manifest_id !== payload["plugin_input_access_manifest_id"]
    || trace.manifest.manifest_digest !== payload["plugin_input_access_manifest_digest"]
    || trace.analysis_input_digest !== payload["analysis_input_digest"]
    || !hasExactKeys(request.payload, request.call === "discover_partitions"
      ? ["candidate_generation_id", "context", "resource_budget"]
      : request.call === "analyze_artifact"
        ? ["candidate_generation_id", "work_item", "context", "resource_budget"]
        : ["candidate_generation_id", "projection_work_item", "context", "resource_budget"])
    || !hasExactKeys(request.payload["context"], ["analysis_view", "resource_budget"])
    || !hasExactKeys(request.payload["context"]["analysis_view"], [
      "analysis_view_digest", "workspace_id", "candidate_generation_id", "source_overlay_digest", "prerequisite_stage_set_digest",
      "target_registry_snapshot_id", "resolution_lock_id", "configuration_revision_id", "base_snapshot_id",
    ])
    || request.payload["context"]["analysis_view"]["workspace_id"] !== workspace_id
    || request.payload["context"]["analysis_view"]["candidate_generation_id"] !== request.payload["candidate_generation_id"]) return false;
  if (request.call === "discover_partitions") return true;
  if (request.call === "generate_projection") {
    const workItem = request.payload["projection_work_item"] as Record<string, unknown>;
    if (!hasExactKeys(request.payload["projection_work_item"], [
      "projection_work_item_id", "workspace_id", "owner_artifact_id", "owner_artifact_version_id", "projection_kind", "operation",
      "generator", "generator_version", "generator_configuration_digest", "source_selection", "base_projection_set_digest",
      "reason_codes", "cause_references", "work_item_digest",
    ]) || request.payload["projection_work_item"]["workspace_id"] !== workspace_id
      || request.payload["projection_work_item"]["generator"] !== worker.plugin_id
      || request.payload["projection_work_item"]["generator_version"] !== worker.plugin_version) return false;
    return hasExactKeys(workItem["source_selection"], ["owner_artifact_id"])
      && workItem["source_selection"]["owner_artifact_id"] === workItem["owner_artifact_id"]
      && (payload["projection_replacement_set"] as Array<Record<string, unknown>>).every((projection) =>
      projection["workspace_id"] === workspace_id
      && projection["generator"] === worker.plugin_id
      && projection["generator_version"] === worker.plugin_version
      && projection["owner_artifact_id"] === workItem["owner_artifact_id"]
      && projection["owner_artifact_version_id"] === workItem["owner_artifact_version_id"]
      && projection["projection_kind"] === workItem["projection_kind"]
      && projection["generator_configuration_digest"] === workItem["generator_configuration_digest"]
      && sameStringList(projection["source_artifact_version_ids"], trace.input_artifact_version_ids)
      && sameStringList(projection["source_record_ids"], trace.input_record_ids)
      && sameStringList(projection["source_projection_record_ids"], []));
  }
  if (!hasExactKeys(request.payload["work_item"], [
    "work_item_id", "workspace_id", "artifact_id", "target_artifact_version_id", "operation", "plugin_id", "plugin_version",
    "capabilities", "expected_replacement_scopes", "reason_codes", "cause_references", "analysis_context_digest", "work_item_digest",
  ]) || !hasExactKeys(payload["fact_delta"], [
    "fact_delta_id", "candidate_generation_id", "workspace_id", "base_snapshot_id", "work_item_id", "plugin_id", "plugin_version",
    "analysis_digest", "analysis_configuration_digest", "owner_artifact_id", "owner_artifact_version_id", "replacement_scopes",
    "input_artifact_version_ids", "input_record_ids", "plugin_input_access_manifest_id", "plugin_input_access_manifest_digest",
    "analysis_input_digest", "proposed_records", "proposed_dependencies", "completeness_claims", "created_at", "delta_digest",
  ])) return false;
  const workItem = request.payload["work_item"];
  const delta = payload["fact_delta"];
  return workItem["workspace_id"] === workspace_id
    && workItem["plugin_id"] === worker.plugin_id
    && workItem["plugin_version"] === worker.plugin_version
    && delta["candidate_generation_id"] === request.payload["candidate_generation_id"]
    && delta["workspace_id"] === workspace_id
    && delta["base_snapshot_id"] === request.payload["context"]["analysis_view"]["base_snapshot_id"]
    && delta["work_item_id"] === workItem["work_item_id"]
    && delta["plugin_id"] === worker.plugin_id
    && delta["plugin_version"] === worker.plugin_version
    && delta["owner_artifact_id"] === workItem["artifact_id"]
    && delta["owner_artifact_version_id"] === workItem["target_artifact_version_id"]
    && delta["plugin_input_access_manifest_id"] === payload["plugin_input_access_manifest_id"]
    && delta["plugin_input_access_manifest_digest"] === payload["plugin_input_access_manifest_digest"]
    && delta["analysis_input_digest"] === payload["analysis_input_digest"]
    && sameStringList(delta["input_artifact_version_ids"], trace.input_artifact_version_ids)
    && sameStringList(delta["input_record_ids"], trace.input_record_ids)
    && delta["delta_digest"] === canonicalSha256(factDeltaCore(delta))
    && (delta["proposed_records"] as Array<Record<string, unknown>>).every((record) =>
      record["workspace_id"] === workspace_id
      && record["owner_artifact_id"] === workItem["artifact_id"]
      && record["owner_artifact_version_id"] === workItem["target_artifact_version_id"])
    && (delta["replacement_scopes"] as Array<Record<string, unknown>>).every((scope) =>
      scope["owner_artifact_id"] === workItem["artifact_id"]
      && scope["owner_artifact_version_id"] === workItem["target_artifact_version_id"]);
}

function isManifestIdentity(value: Record<string, unknown>): boolean {
  return isString(value["plugin_input_access_manifest_id"])
    && isDigest(value["plugin_input_access_manifest_digest"])
    && isDigest(value["analysis_input_digest"]);
}

const failureAuthority = {
  inputs_incomplete: { code: "core:plugin_inputs_incomplete", retryability: "replan", required: ["request_id", "plugin_id", "call", "missing_input_kind"], optional: ["missing_input_reference"] },
  unsupported: { code: "core:plugin_unsupported", retryability: "not_retryable", required: ["request_id", "plugin_id", "call", "capability"], optional: ["provider_detail_code"] },
  cancelled: { code: "core:plugin_cancelled", retryability: "retry_same", required: ["request_id", "plugin_id", "call", "cancellation_id"], optional: [] },
  resource_exhausted: { code: "core:plugin_resource_exhausted", retryability: "reanalyze", required: ["request_id", "plugin_id", "call", "resource_kind", "configured_limit", "observed_or_required"], optional: [] },
  failed: { code: "core:plugin_failed", retryability: "retry_same", required: ["request_id", "plugin_id", "call", "failure_code"], optional: ["provider_detail_code"] },
} as const;

function isNonSuccess(call: PluginWorkerCall, outcome: Exclude<PluginWorkerOutcome, "success">, payload: unknown): boolean {
  const authority = failureAuthority[outcome];
  if (!hasExactKeys(payload, ["candidate_issue_code", "retryability", "message", "details"])
    || payload["candidate_issue_code"] !== authority.code
    || payload["retryability"] !== authority.retryability
    || !isSafeMessage(payload["message"])
    || !hasExactKeys(payload["details"], authority.required, authority.optional)) return false;
  const details = payload["details"];
  if (!isString(details["request_id"]) || !isString(details["plugin_id"]) || details["call"] !== call) return false;
  if (outcome === "inputs_incomplete") return (details["missing_input_kind"] === "source_root" || details["missing_input_kind"] === "provider_capability")
    && (details["missing_input_reference"] === undefined || isString(details["missing_input_reference"]));
  if (outcome === "unsupported") return isString(details["capability"])
    && (details["provider_detail_code"] === undefined || isString(details["provider_detail_code"]));
  if (outcome === "cancelled") return isString(details["cancellation_id"]);
  if (outcome === "resource_exhausted") return ["deadline", "memory_bytes", "output_bytes", "records", "dependencies", "context_operations", "context_bytes", "recursion_depth"].includes(details["resource_kind"] as string)
    && Number.isSafeInteger(details["configured_limit"]) && (details["configured_limit"] as number) > 0
    && Number.isSafeInteger(details["observed_or_required"]) && (details["observed_or_required"] as number) >= 0;
  return isString(details["failure_code"])
    && (details["provider_detail_code"] === undefined || isString(details["provider_detail_code"]));
}

const payloadValidator: WorkerPayloadValidator = {
  validate_call(call, payload) {
    const valid = call === "describe"
      ? hasExactKeys(payload, ["plugin_id", "plugin_version", "package_digest"])
        && isString(payload["plugin_id"]) && isString(payload["plugin_version"]) && isDigest(payload["package_digest"])
      : call === "discover_partitions"
        ? hasExactKeys(payload, ["candidate_generation_id", "context", "resource_budget"])
          && isString(payload["candidate_generation_id"]) && isAnalysisContext(payload["context"]) && isResourceBudget(payload["resource_budget"])
        : call === "analyze_artifact"
          ? hasExactKeys(payload, ["candidate_generation_id", "work_item", "context", "resource_budget"])
            && isString(payload["candidate_generation_id"]) && isArtifactWorkItem(payload["work_item"])
            && isAnalysisContext(payload["context"]) && isResourceBudget(payload["resource_budget"])
          : hasExactKeys(payload, ["candidate_generation_id", "projection_work_item", "context", "resource_budget"])
            && isString(payload["candidate_generation_id"]) && isProjectionWorkItem(payload["projection_work_item"])
            && isAnalysisContext(payload["context"]) && isResourceBudget(payload["resource_budget"]);
    if (!valid) throw new Error("invalid synthetic call payload");
    return payload;
  },
  validate_outcome(call, outcome, payload) {
    let valid: boolean;
    if (outcome !== "success") valid = isNonSuccess(call, outcome, payload);
    else if (call === "describe") valid = hasExactKeys(payload, ["compatibility_declaration_digest", "registry_contribution_digest", "supported_calls"])
      && isDigest(payload["compatibility_declaration_digest"])
      && isDigest(payload["registry_contribution_digest"])
      && Array.isArray(payload["supported_calls"])
      && payload["supported_calls"].every((item) => typeof item === "string" && workerCalls.has(item as PluginWorkerCall));
    else if (call === "discover_partitions") valid = hasExactKeys(payload, ["partitions", "plugin_input_access_manifest_id", "plugin_input_access_manifest_digest", "analysis_input_digest"])
      && Array.isArray(payload["partitions"]) && payload["partitions"].every(isPartition) && isManifestIdentity(payload);
    else if (call === "analyze_artifact") valid = hasExactKeys(payload, ["fact_delta", "plugin_input_access_manifest_id", "plugin_input_access_manifest_digest", "analysis_input_digest"])
      && isFactDelta(payload["fact_delta"]) && isManifestIdentity(payload);
    else valid = hasExactKeys(payload, ["projection_replacement_set", "plugin_input_access_manifest_id", "plugin_input_access_manifest_digest", "analysis_input_digest"])
      && isProjectionReplacementSet(payload["projection_replacement_set"]) && isManifestIdentity(payload);
    if (!valid) throw new Error("invalid synthetic outcome payload");
    return payload;
  },
};

function analysisContext(workspace_id = analysisView.workspace_id) {
  return { analysis_view: { ...analysisView, workspace_id }, resource_budget: contextBudget };
}

function describePayload(plugin_id = "fixture:typescript") {
  return { plugin_id, plugin_version: "1.0.0", package_digest: workerKey.package_digest };
}

function discoverPayload(workspace_id = analysisView.workspace_id) {
  return {
    candidate_generation_id: analysisView.candidate_generation_id,
    context: analysisContext(workspace_id),
    resource_budget: contextBudget,
  };
}

function analyzePayload(artifact_id: string, workspace_id = analysisView.workspace_id) {
  const plugin_id = artifact_id === rustModule.artifact_id ? "fixture:rust" : "fixture:typescript";
  return {
    candidate_generation_id: analysisView.candidate_generation_id,
    work_item: {
      work_item_id: `work:${artifact_id}`,
      workspace_id,
      artifact_id,
      target_artifact_version_id: `${artifact_id}-version`,
      operation: "analyze",
      plugin_id,
      plugin_version: "1.0.0",
      capabilities: ["core:syntax_structure"],
      expected_replacement_scopes: [`scope:${artifact_id}`],
      reason_codes: ["fixture:conformance"],
      cause_references: [],
      analysis_context_digest: canonicalSha256({ artifact_id, kind: "analysis-context" }),
      work_item_digest: canonicalSha256({ artifact_id, kind: "work-item" }),
    },
    context: analysisContext(workspace_id),
    resource_budget: contextBudget,
  };
}

function projectionPayload(workspace_id = analysisView.workspace_id) {
  return {
    candidate_generation_id: analysisView.candidate_generation_id,
    projection_work_item: {
      projection_work_item_id: "projection-work:unsupported",
      workspace_id,
      owner_artifact_id: tsSource.artifact_id,
      owner_artifact_version_id: tsSource.artifact_version_id,
      projection_kind: "fixture:unsupported",
      operation: "rebuild",
      generator: "fixture:typescript",
      generator_version: "1.0.0",
      generator_configuration_digest: canonicalSha256("projection-configuration"),
      source_selection: { owner_artifact_id: tsSource.artifact_id },
      base_projection_set_digest: canonicalSha256("empty-projection-set"),
      reason_codes: ["fixture:conformance"],
      cause_references: [],
      work_item_digest: canonicalSha256("projection-work-unsupported"),
    },
    context: analysisContext(workspace_id),
    resource_budget: contextBudget,
  };
}

function supportedProjectionPayload(workspace_id = analysisView.workspace_id) {
  const payload = projectionPayload(workspace_id);
  return {
    ...payload,
    projection_work_item: {
      ...payload.projection_work_item,
      projection_work_item_id: "projection-work:fixture-summary",
      projection_kind: "fixture:summary",
      work_item_digest: canonicalSha256("projection-work-fixture-summary"),
    },
  };
}

function projectionReplacementFixture() {
  const core = {
    projection_record_id: "projection:fixture-summary",
    projection_kind: "fixture:summary",
    projection_key: "summary:artifact-ts-source",
    workspace_id: analysisView.workspace_id,
    owner_artifact_id: tsSource.artifact_id,
    owner_artifact_version_id: tsSource.artifact_version_id,
    source_artifact_version_ids: [tsSource.artifact_version_id],
    source_record_ids: [],
    source_projection_record_ids: [],
    generator: "fixture:typescript",
    generator_version: "1.0.0",
    generator_configuration_digest: canonicalSha256("projection-configuration"),
    created_from_snapshot_id: "snapshot-base",
    valid_from_generation: 1,
    payload: { summary: "One exported declaration." },
  };
  return { ...core, content_digest: canonicalSha256(core) };
}

const nonSuccessFixtures: Readonly<Record<Exclude<PluginWorkerOutcome, "success">, {
  readonly candidate_issue_code: string;
  readonly retryability: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}>> = {
  inputs_incomplete: {
    candidate_issue_code: "core:plugin_inputs_incomplete",
    retryability: "replan",
    message: "A required source root is unavailable.",
    details: {
      request_id: "failure-fixture",
      plugin_id: "fixture:typescript",
      call: "analyze_artifact",
      missing_input_kind: "source_root",
    },
  },
  unsupported: {
    candidate_issue_code: "core:plugin_unsupported",
    retryability: "not_retryable",
    message: "The requested capability is unsupported.",
    details: {
      request_id: "failure-fixture",
      plugin_id: "fixture:typescript",
      call: "generate_projection",
      capability: "fixture:unsupported",
    },
  },
  cancelled: {
    candidate_issue_code: "core:plugin_cancelled",
    retryability: "retry_same",
    message: "The request was cancelled.",
    details: {
      request_id: "failure-fixture",
      plugin_id: "fixture:typescript",
      call: "analyze_artifact",
      cancellation_id: "cancel:failure-fixture",
    },
  },
  resource_exhausted: {
    candidate_issue_code: "core:plugin_resource_exhausted",
    retryability: "reanalyze",
    message: "The output limit was exceeded.",
    details: {
      request_id: "failure-fixture",
      plugin_id: "fixture:typescript",
      call: "analyze_artifact",
      resource_kind: "output_bytes",
      configured_limit: 1024,
      observed_or_required: 2048,
    },
  },
  failed: {
    candidate_issue_code: "core:plugin_failed",
    retryability: "retry_same",
    message: "The plugin call failed safely.",
    details: {
      request_id: "failure-fixture",
      plugin_id: "fixture:typescript",
      call: "analyze_artifact",
      failure_code: "fixture_failure",
    },
  },
};

function createRuntime(worker: SyntheticPluginWorker): SupervisedPluginRuntime {
  return createRuntimeFromFactory(() => worker, new NeverQuarantinedStore());
}

const runtimeWorker = new WeakMap<SupervisedPluginRuntime, () => SyntheticPluginWorker | undefined>();

function createRuntimeFromFactory(
  workerFactory: (worker_key: WorkerKey) => SyntheticPluginWorker,
  quarantineStore: QuarantineStore,
  onLaunch: () => void = () => {},
): SupervisedPluginRuntime {
  let currentWorker: SyntheticPluginWorker | undefined;
  const runtime = new SupervisedPluginRuntime({
    sandbox: { async launch(input) { onLaunch(); currentWorker = workerFactory(input.worker_key); return currentWorker; } },
    payload_validator: payloadValidator,
    clock: { now: () => Date.now() },
    timer: {
      set(delay_ms, callback) {
        const handle = setTimeout(callback, delay_ms);
        return { cancel: () => clearTimeout(handle) };
      },
    },
    quarantine_policy: {
      evaluate: (crash_times_ms, now_ms) => crash_times_ms.length >= 2
        ? { crash_times_ms, quarantine_until_ms: now_ms + 60_000 }
        : { crash_times_ms },
    },
    quarantine_store: quarantineStore,
    private_failure_sink: { async capture() { return "failure-conformance"; } },
    request_identity_port: new ConformanceWorkerRequestIdentityPort(),
    worker_pool_policy: workerPoolPolicy,
    protocol_materialization_limits: protocolMaterializationLimits,
    metadata_materialization_limits: metadataMaterializationLimits,
  });
  runtimeWorker.set(runtime, () => currentWorker);
  return runtime;
}

async function execute(
  worker: SyntheticPluginWorker,
  request_id: string,
  call: PluginWorkerCall,
  payload: unknown,
) {
  return executeWithRuntime(createRuntime(worker), request_id, call, payload);
}

async function executeWithRuntime(
  runtime: SupervisedPluginRuntime,
  request_id: string,
  call: PluginWorkerCall,
  payload: unknown,
  options: {
    readonly workspace_id?: string;
    readonly worker_key?: WorkerKey;
    readonly signal?: AbortSignal;
    readonly deadline_at_ms?: number;
  } = {},
) {
  const deadline_at_ms = options.deadline_at_ms ?? Date.now() + 60_000;
  const requestCore = {
    protocol_version: String((options.worker_key ?? workerKey).runtime_contract_version),
    request_id,
    call,
    deadline: new Date(deadline_at_ms).toISOString(),
    cancellation_id: `cancel:${request_id}`,
    payload,
  };
  const callEnvelope: PluginWorkerCallEnvelope = {
    request_digest: workerRequestDigest(requestCore),
    ...requestCore,
  };
  const result = await runtime.execute({
    request_envelope: callEnvelope,
    workspace_id: options.workspace_id ?? "workspace-conformance",
    worker_key: options.worker_key ?? workerKey,
    retry: "new",
    cancellation_signal: options.signal ?? new AbortController().signal,
    budget: {
      deadline_at_ms,
      max_memory_bytes: 1_048_576,
      max_output_bytes: 1_048_576,
      max_records: 100,
      max_dependencies: 100,
      max_context_operations: 100,
      max_context_bytes: 1_048_576,
      max_recursion_depth: 10,
    },
    max_response_bytes: 1_048_576,
  });
  if (result.accepted) {
    const worker = runtimeWorker.get(runtime)?.();
    if (worker === undefined || !validExecutionBindings(worker, callEnvelope, options.workspace_id ?? "workspace-conformance", result.response)) {
      return { accepted: false, code: "plugin-sdk:worker_protocol_invalid" } as const;
    }
  }
  return result;
}

function successPayload(result: Awaited<ReturnType<typeof execute>>): Record<string, unknown> {
  expect(result.accepted).toBe(true);
  if (!result.accepted) throw new Error(result.code);
  expect(result.response.outcome).toBe("success");
  return result.response.payload as Record<string, unknown>;
}

function rewriteWorkerResponse(
  worker: SyntheticPluginWorker,
  rewrite: (response: Record<string, unknown>) => Record<string, unknown>,
): SyntheticPluginWorker {
  return Object.freeze({
    worker_kind: worker.worker_kind,
    plugin_id: worker.plugin_id,
    plugin_version: worker.plugin_version,
    async invoke(request: PluginWorkerCallEnvelope): Promise<unknown> {
      const result = await worker.invoke(request);
      if (!hasExactKeys(result, ["response", "metrics"]) || !hasExactKeys(result["response"], [
        "protocol_version", "request_id", "request_digest", "call", "outcome", "payload",
      ])) return result;
      return { response: rewrite(result["response"]), metrics: result["metrics"] };
    },
    trace(request_id: string) { return worker.trace(request_id); },
    async cancel(input: { readonly cancellation_id: string }) { await worker.cancel(input); },
    async reset() { return worker.reset(); },
    async terminate() { await worker.terminate(); },
  });
}

function withFactDelta(
  response: Record<string, unknown>,
  change: (delta: Record<string, unknown>) => Record<string, unknown>,
  recompute = false,
): Record<string, unknown> {
  const payload = response["payload"] as Record<string, unknown>;
  const changed = change(payload["fact_delta"] as Record<string, unknown>);
  if (recompute) {
    const { fact_delta_id: _factDeltaId, created_at: _createdAt, delta_digest: _deltaDigest, ...core } = changed;
    changed["delta_digest"] = canonicalSha256(core);
  }
  return { ...response, payload: { ...payload, fact_delta: changed } };
}

function withProjectionReplacement(
  response: Record<string, unknown>,
  change: (projection: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const payload = response["payload"] as Record<string, unknown>;
  const [projection] = payload["projection_replacement_set"] as Array<Record<string, unknown>>;
  const changed = change(projection as Record<string, unknown>);
  const { content_digest: _contentDigest, ...core } = changed;
  changed["content_digest"] = canonicalSha256(core);
  return { ...response, payload: { ...payload, projection_replacement_set: [changed] } };
}

describe("Phase 8 testkit-only synthetic conformance workers", () => {
  it("strictly validates typed and nested call-specific success payloads", () => {
    expect(payloadValidator.validate_call("describe", describePayload())).toEqual(describePayload());
    expect(payloadValidator.validate_call("discover_partitions", discoverPayload())).toEqual(discoverPayload());
    expect(payloadValidator.validate_call("analyze_artifact", analyzePayload(tsSource.artifact_id))).toEqual(analyzePayload(tsSource.artifact_id));
    expect(payloadValidator.validate_call("generate_projection", projectionPayload())).toEqual(projectionPayload());
    expect(payloadValidator.validate_outcome("describe", "success", {
      compatibility_declaration_digest: canonicalSha256("compatibility-fixture:typescript"),
      registry_contribution_digest: canonicalSha256("registry-fixture:typescript"),
      supported_calls: ["describe", "discover_partitions", "analyze_artifact"],
    })).toBeDefined();
    expect(payloadValidator.validate_outcome("discover_partitions", "success", {
      partitions: [{
        partition_key: "project:root",
        language_ids: ["languages:typescript"],
        member_artifact_ids: [tsSource.artifact_id],
        configuration_artifact_ids: [tsConfig.artifact_id],
        resolution_roots: ["src"],
        capabilities: ["core:syntax_structure"],
      }],
      plugin_input_access_manifest_id: "manifest-success",
      plugin_input_access_manifest_digest: canonicalSha256("manifest-success"),
      analysis_input_digest: canonicalSha256("analysis-success"),
    })).toBeDefined();

    expect(() => payloadValidator.validate_call("describe", { ...describePayload(), plugin_id: 7 })).toThrow();
    expect(() => payloadValidator.validate_call("discover_partitions", {
      ...discoverPayload(),
      context: { ...analysisContext(), analysis_view: { ...analysisView, workspace_id: [] } },
    })).toThrow();
    expect(() => payloadValidator.validate_call("analyze_artifact", {
      ...analyzePayload(tsSource.artifact_id),
      work_item: { artifact_id: 7 },
    })).toThrow();
    const analyzeWithArbitraryCause = analyzePayload(tsSource.artifact_id);
    expect(() => payloadValidator.validate_call("analyze_artifact", {
      ...analyzeWithArbitraryCause,
      work_item: { ...analyzeWithArbitraryCause.work_item, cause_references: [{ command: "cargo build" }] },
    })).toThrow();
    expect(() => payloadValidator.validate_call("generate_projection", {
      ...projectionPayload(),
      projection_work_item: { projection_kind: "fixture:unsupported", command: "cargo build" },
    })).toThrow();
    const projectionWithArbitrarySelector = projectionPayload();
    expect(() => payloadValidator.validate_call("generate_projection", {
      ...projectionWithArbitrarySelector,
      projection_work_item: {
        ...projectionWithArbitrarySelector.projection_work_item,
        source_selection: { arbitrary_expression: "publish all" },
      },
    })).toThrow();
    expect(() => payloadValidator.validate_outcome("describe", "success", {
      compatibility_declaration_digest: 7,
      registry_contribution_digest: "sha256:registry",
      supported_calls: ["arbitrary_call"],
    })).toThrow();
    expect(() => payloadValidator.validate_outcome("describe", "success", {
      compatibility_declaration_digest: "sha256:not-a-digest",
      registry_contribution_digest: "sha256:also-not-a-digest",
      supported_calls: ["describe"],
    })).toThrow();
    expect(() => payloadValidator.validate_outcome("discover_partitions", "success", {
      partitions: [{
        partition_key: "project:root",
        language_ids: [7],
        member_artifact_ids: [],
        configuration_artifact_ids: [],
        resolution_roots: [],
        capabilities: [],
        hidden: true,
      }],
      plugin_input_access_manifest_id: "manifest-success",
      plugin_input_access_manifest_digest: "sha256:manifest-success",
      analysis_input_digest: "sha256:analysis-success",
    })).toThrow();
    expect(() => payloadValidator.validate_outcome("analyze_artifact", "success", {
      fact_delta: { fact_delta_id: 7 },
      plugin_input_access_manifest_id: "manifest-success",
      plugin_input_access_manifest_digest: "sha256:manifest-success",
      analysis_input_digest: "sha256:analysis-success",
    })).toThrow();
    expect(() => payloadValidator.validate_outcome("generate_projection", "success", {
      projection_replacement_set: { arbitrary_command: "cargo build" },
      plugin_input_access_manifest_id: "manifest-success",
      plugin_input_access_manifest_digest: "sha256:manifest-success",
      analysis_input_digest: "sha256:analysis-success",
    })).toThrow();
  });

  it("strictly validates every typed non-success payload and its closed details", () => {
    for (const [outcome, payload] of Object.entries(nonSuccessFixtures) as Array<[
      Exclude<PluginWorkerOutcome, "success">,
      (typeof nonSuccessFixtures)[Exclude<PluginWorkerOutcome, "success">],
    ]>) {
      expect(payloadValidator.validate_outcome(payload.details["call"] as PluginWorkerCall, outcome, payload)).toEqual(payload);
      expect(() => payloadValidator.validate_outcome(payload.details["call"] as PluginWorkerCall, outcome, {
        candidate_issue_code: 7,
        retryability: [],
        message: {},
        details: null,
      })).toThrow();
      expect(() => payloadValidator.validate_outcome(payload.details["call"] as PluginWorkerCall, outcome, {
        ...payload,
        details: { ...payload.details, command: "cargo build" },
      })).toThrow();
      expect(() => payloadValidator.validate_outcome(payload.details["call"] as PluginWorkerCall, outcome, {
        ...payload,
        unknown: true,
      })).toThrow();
    }
  });

  it("strictly validates a complete GenerateProjectionSuccess replacement set", () => {
    const valid = {
      projection_replacement_set: [projectionReplacementFixture()],
      plugin_input_access_manifest_id: "manifest-projection-success",
      plugin_input_access_manifest_digest: canonicalSha256("manifest-projection-success"),
      analysis_input_digest: canonicalSha256("analysis-projection-success"),
    };

    expect(payloadValidator.validate_outcome("generate_projection", "success", valid)).toEqual(valid);
    expect(() => payloadValidator.validate_outcome("generate_projection", "success", {
      ...valid,
      projection_replacement_set: [{
        ...projectionReplacementFixture(),
        payload: { summary: "One exported declaration.", command: "publish snapshot" },
      }],
    })).toThrow();
    expect(() => payloadValidator.validate_outcome("generate_projection", "success", {
      ...valid,
      projection_replacement_set: [{ ...projectionReplacementFixture(), content_digest: canonicalSha256("stale") }],
    })).toThrow();
    expect(() => payloadValidator.validate_outcome("generate_projection", "success", {
      ...valid,
      projection_replacement_set: [projectionReplacementFixture(), projectionReplacementFixture()],
    })).toThrow();
  });

  it("generates a projection replacement set through the public protocol and supervisor", async () => {
    const worker = createTypeScriptShapedWorker({
      create_session: sessionFactory(new ReorderedViewPort([tsConfig, tsSource], {})),
    });
    const request = supportedProjectionPayload();

    const projection = successPayload(await execute(
      worker,
      "typescript-projection",
      "generate_projection",
      request,
    ));

    expect(projection["projection_replacement_set"]).toEqual([expect.objectContaining({
      projection_kind: request.projection_work_item.projection_kind,
      generator_configuration_digest: request.projection_work_item.generator_configuration_digest,
      source_artifact_version_ids: [tsSource.artifact_version_id],
    })]);
    expect(worker.trace("typescript-projection")).toBeDefined();
  });

  it("accepts an authoritative PluginFailed payload through the public runtime", async () => {
    const requestId = "typescript-public-failure";
    const worker = rewriteWorkerResponse(createTypeScriptShapedWorker({
      create_session: sessionFactory(new ReorderedViewPort([tsConfig, tsSource], {})),
    }), (response) => ({
      ...response,
      outcome: "failed",
      payload: {
        candidate_issue_code: "core:plugin_failed",
        retryability: "retry_same",
        message: "The plugin call failed safely.",
        details: {
          request_id: requestId,
          plugin_id: "fixture:typescript",
          call: "analyze_artifact",
          failure_code: "fixture_failure",
        },
      },
    }));

    await expect(execute(worker, requestId, "analyze_artifact", analyzePayload(tsSource.artifact_id)))
      .resolves.toMatchObject({
        accepted: true,
        response: {
          outcome: "failed",
          payload: {
            candidate_issue_code: "core:plugin_failed",
            retryability: "retry_same",
            message: "The plugin call failed safely.",
            details: {
              request_id: requestId,
              plugin_id: "fixture:typescript",
              call: "analyze_artifact",
              failure_code: "fixture_failure",
            },
          },
        },
      });
  });

  it("rejects valid-looking projection output derived from another work item", async () => {
    const cases: Array<(projection: Record<string, unknown>) => Record<string, unknown>> = [
      (projection) => ({ ...projection, projection_kind: "fixture:other-summary" }),
      (projection) => ({
        ...projection,
        generator_configuration_digest: canonicalSha256("other-projection-configuration"),
      }),
      (projection) => ({
        ...projection,
        source_artifact_version_ids: [...(projection["source_artifact_version_ids"] as string[]), "artifact-version:other-source"],
      }),
      (projection) => ({ ...projection, source_record_ids: ["record:other-source"] }),
    ];

    for (const [index, change] of cases.entries()) {
      const worker = rewriteWorkerResponse(createTypeScriptShapedWorker({
        create_session: sessionFactory(new ReorderedViewPort([tsConfig, tsSource], {})),
      }), (response) => withProjectionReplacement(response, change));
      await expect(execute(worker, `hostile-projection-${index}`, "generate_projection", supportedProjectionPayload()))
        .resolves.toEqual({ accepted: false, code: "plugin-sdk:worker_protocol_invalid" });
    }
  });

  it("rejects stale and cross-bound valid-looking analysis identities after payload validation", async () => {
    const cases: Array<(response: Record<string, unknown>) => Record<string, unknown>> = [
      (response) => withFactDelta(response, (delta) => ({ ...delta, plugin_version: "9.9.9" }), true),
      (response) => withFactDelta(response, (delta) => ({ ...delta, work_item_id: "work:other" }), true),
      (response) => withFactDelta(response, (delta) => ({
        ...delta,
        workspace_id: "workspace-other",
        proposed_records: (delta["proposed_records"] as Array<Record<string, unknown>>)
          .map((record) => ({ ...record, workspace_id: "workspace-other" })),
      }), true),
      (response) => withFactDelta(response, (delta) => ({ ...delta, plugin_id: "fixture:other" }), true),
      (response) => {
        const payload = response["payload"] as Record<string, unknown>;
        return { ...response, payload: { ...payload, plugin_input_access_manifest_digest: canonicalSha256("stale-manifest") } };
      },
      (response) => {
        const payload = response["payload"] as Record<string, unknown>;
        return { ...response, payload: { ...payload, plugin_input_access_manifest_id: "manifest:other-request" } };
      },
      (response) => {
        const payload = response["payload"] as Record<string, unknown>;
        const delta = payload["fact_delta"] as Record<string, unknown>;
        const changed: Record<string, unknown> = { ...delta, analysis_input_digest: canonicalSha256("cross-request-input") };
        const { fact_delta_id: _factDeltaId, created_at: _createdAt, delta_digest: _deltaDigest, ...core } = changed;
        changed["delta_digest"] = canonicalSha256(core);
        return {
          ...response,
          payload: { ...payload, fact_delta: changed, analysis_input_digest: changed["analysis_input_digest"] },
        };
      },
    ];

    for (const [index, rewrite] of cases.entries()) {
      const worker = rewriteWorkerResponse(createTypeScriptShapedWorker({
        create_session: sessionFactory(new ReorderedViewPort([tsConfig, tsSource], {})),
      }), rewrite);
      await expect(execute(worker, `hostile-analysis-${index}`, "analyze_artifact", analyzePayload(tsSource.artifact_id)))
        .resolves.toEqual({ accepted: false, code: "plugin-sdk:worker_protocol_invalid" });
    }
  });

  it("rejects recomputed deltas whose derived input lists differ from the finalized manifest", async () => {
    const cases: Array<(delta: Record<string, unknown>) => Record<string, unknown>> = [
      (delta) => ({
        ...delta,
        input_artifact_version_ids: [...(delta["input_artifact_version_ids"] as string[]), "artifact-version:arbitrary"],
      }),
      (delta) => ({
        ...delta,
        input_artifact_version_ids: [
          ...(delta["input_artifact_version_ids"] as string[]),
          (delta["input_artifact_version_ids"] as string[])[0],
        ],
      }),
      (delta) => ({ ...delta, input_record_ids: ["record:arbitrary"] }),
      (delta) => ({ ...delta, input_record_ids: ["record:duplicate", "record:duplicate"] }),
    ];

    for (const [index, change] of cases.entries()) {
      const worker = rewriteWorkerResponse(createTypeScriptShapedWorker({
        create_session: sessionFactory(new ReorderedViewPort([tsConfig, tsSource], {})),
      }), (response) => withFactDelta(response, change, true));
      await expect(execute(worker, `hostile-input-list-${index}`, "analyze_artifact", analyzePayload(tsSource.artifact_id)))
        .resolves.toEqual({ accepted: false, code: "plugin-sdk:worker_protocol_invalid" });
    }

    const reorderedWorker = rewriteWorkerResponse(createRustShapedWorker({
      create_session: sessionFactory(new ReorderedViewPort([rustManifest, rustModule], {})),
    }), (response) => withFactDelta(response, (delta) => ({
      ...delta,
      input_artifact_version_ids: [...(delta["input_artifact_version_ids"] as string[])].reverse(),
    }), true));
    await expect(execute(reorderedWorker, "hostile-input-order", "analyze_artifact", analyzePayload(rustModule.artifact_id)))
      .resolves.toEqual({ accepted: false, code: "plugin-sdk:worker_protocol_invalid" });
  });

  it("binds every accepted non-success detail to the actual request and plugin", async () => {
    for (const [suffix, detailChange] of [
      ["request", { request_id: "request-other" }],
      ["plugin", { plugin_id: "fixture:other" }],
    ] as const) {
      const worker = rewriteWorkerResponse(createTypeScriptShapedWorker({
        create_session: sessionFactory(new ReorderedViewPort([tsConfig, tsSource], {})),
      }), (response) => {
        const payload = response["payload"] as Record<string, unknown>;
        return { ...response, payload: { ...payload, details: { ...(payload["details"] as object), ...detailChange } } };
      });
      await expect(execute(worker, `hostile-unsupported-${suffix}`, "generate_projection", projectionPayload()))
        .resolves.toEqual({ accepted: false, code: "plugin-sdk:worker_protocol_invalid" });
    }
  });

  it("rejects a valid-looking cancelled outcome carrying another cancellation identity", async () => {
    const requestId = "hostile-cancellation";
    const cancelledWorker = (cancellation_id: string) => rewriteWorkerResponse(
      createTypeScriptShapedWorker({
        create_session: sessionFactory(new ReorderedViewPort([tsConfig, tsSource], {})),
      }),
      (response) => ({
        ...response,
        outcome: "cancelled",
        payload: {
          candidate_issue_code: "core:plugin_cancelled",
          retryability: "retry_same",
          message: "The request was cancelled.",
          details: {
            request_id: requestId,
            plugin_id: "fixture:typescript",
            call: "analyze_artifact",
            cancellation_id,
          },
        },
      }),
    );

    await expect(execute(cancelledWorker(`cancel:${requestId}`), requestId, "analyze_artifact", analyzePayload(tsSource.artifact_id)))
      .resolves.toMatchObject({ accepted: true, response: { outcome: "cancelled" } });

    await expect(execute(cancelledWorker("cancel:another-request"), requestId, "analyze_artifact", analyzePayload(tsSource.artifact_id)))
      .resolves.toEqual({ accepted: false, code: "plugin-sdk:worker_protocol_invalid" });
  });

  it("TypeScript-shaped fixture reads configuration, records an empty declaration lookup, and emits overlapping complete output", async () => {
    const worker = createTypeScriptShapedWorker({
      create_session: sessionFactory(new ReorderedViewPort([tsConfig, tsSource], { query: 10, "read:artifact-tsconfig": 1 })),
    });

    const discovery = successPayload(await execute(worker, "typescript-discovery", "discover_partitions", discoverPayload()));
    const analysisRequest = analyzePayload(tsSource.artifact_id);
    const analysis = successPayload(await execute(worker, "typescript-analysis", "analyze_artifact", analysisRequest));
    const partitions = discovery["partitions"] as Array<{ member_artifact_ids: string[]; configuration_artifact_ids: string[] }>;
    const manifest = worker.trace("typescript-discovery")?.manifest;
    const delta = analysis["fact_delta"] as Record<string, unknown>;

    expect(partitions).toHaveLength(2);
    expect(partitions.every((partition) => partition.member_artifact_ids.includes(tsSource.artifact_id))).toBe(true);
    expect(partitions.every((partition) => partition.configuration_artifact_ids.includes(tsConfig.artifact_id))).toBe(true);
    expect(discovery).not.toHaveProperty("manifest");
    expect(manifest?.lookup_entries).toContainEqual(expect.objectContaining({ operation: "record_query", result_count: 0 }));
    expect(delta["replacement_scopes"]).toEqual([expect.objectContaining({ output_completeness: "complete" })]);
    expect(delta["proposed_records"]).toEqual([expect.objectContaining({ kind: "fixture:typescript_export" })]);
    expect(delta["work_item_id"]).toBe(analysisRequest.work_item.work_item_id);
    expect(worker.trace("typescript-analysis")).toMatchObject({
      plugin_id: delta["plugin_id"],
      plugin_version: delta["plugin_version"],
    });
  });

  it("Rust-shaped fixture reads manifest/module input and consumes a staged prerequisite without a canonical ID", async () => {
    const worker = createRustShapedWorker({
      create_session: sessionFactory(new ReorderedViewPort([rustManifest, rustModule], { get: 1, "read:artifact-rust-module": 10 })),
    });

    const discovery = successPayload(await execute(worker, "rust-discovery", "discover_partitions", discoverPayload()));
    const analysisRequest = analyzePayload(rustModule.artifact_id);
    const analysis = successPayload(await execute(worker, "rust-analysis", "analyze_artifact", analysisRequest));
    const partitions = discovery["partitions"] as Array<{ partition_key: string; member_artifact_ids: string[] }>;
    const manifest = worker.trace("rust-analysis")?.manifest;
    const delta = analysis["fact_delta"] as Record<string, unknown>;

    expect(partitions.map((partition) => partition.partition_key)).toEqual(["crate:fixture", "module:fixture"]);
    expect(partitions[0]?.member_artifact_ids).toContain(rustModule.artifact_id);
    expect(analysis).not.toHaveProperty("manifest");
    expect(manifest?.record_entries).toContainEqual(expect.objectContaining({ input_type: "staged_record", staged_record_id: "staged-rust-module" }));
    expect(manifest?.record_entries[0]).not.toHaveProperty("record_id");
    expect(manifest?.transitive_artifact_version_ids).toContain(rustManifest.artifact_version_id);
    expect(delta["input_record_ids"]).toEqual([]);
    expect(delta["proposed_dependencies"]).toEqual([expect.objectContaining({ dependency_role: "fixture:macro_input" })]);
    expect(delta["work_item_id"]).toBe(analysisRequest.work_item.work_item_id);
    expect(worker.trace("rust-analysis")).toMatchObject({
      plugin_id: delta["plugin_id"],
      plugin_version: delta["plugin_version"],
    });
  });

  it("language branch independence keeps manifests and digests deterministic when asynchronous reads complete in reverse order", async () => {
    const deadline_at_ms = Date.now() + 60_000;
    const run = async (delays: Readonly<Record<string, number>>) => {
      const worker = createTypeScriptShapedWorker({
        create_session: sessionFactory(new ReorderedViewPort([tsSource, tsConfig], delays)),
      });
      const payload = successPayload(await executeWithRuntime(
        createRuntime(worker),
        "typescript-order",
        "discover_partitions",
        discoverPayload(),
        { deadline_at_ms },
      ));
      return { manifest: worker.trace("typescript-order")?.manifest, analysis_input_digest: payload["analysis_input_digest"] };
    };

    const readsFirst = await run({ query: 10, list: 5, "read:artifact-tsconfig": 1 });
    const lookupsFirst = await run({ query: 1, list: 5, "read:artifact-tsconfig": 10 });

    expect(readsFirst).toEqual(lookupsFirst);
    const typeScriptWorker = createTypeScriptShapedWorker({ create_session: sessionFactory(new ReorderedViewPort([tsConfig, tsSource], {})) });
    const rustWorker = createRustShapedWorker({ create_session: sessionFactory(new ReorderedViewPort([rustManifest, rustModule], {})) });
    expect(typeScriptWorker.worker_kind).toBe("generic_script");
    expect(rustWorker.worker_kind).toBe("generic_script");
    expect(Object.keys(typeScriptWorker).sort()).toEqual(Object.keys(rustWorker).sort());
  });

  it("Rust-shaped manifests and digests remain deterministic when asynchronous reads complete in reverse order", async () => {
    const deadline_at_ms = Date.now() + 60_000;
    const run = async (delays: Readonly<Record<string, number>>) => {
      const worker = createRustShapedWorker({
        create_session: sessionFactory(new ReorderedViewPort([rustManifest, rustModule], delays)),
      });
      const payload = successPayload(await executeWithRuntime(
        createRuntime(worker),
        "rust-order",
        "analyze_artifact",
        analyzePayload(rustModule.artifact_id),
        { deadline_at_ms },
      ));
      return { manifest: worker.trace("rust-order")?.manifest, analysis_input_digest: payload["analysis_input_digest"] };
    };

    const recordFirst = await run({ get: 1, "read:artifact-rust-module": 10 });
    const artifactFirst = await run({ get: 10, "read:artifact-rust-module": 1 });

    expect(recordFirst).toEqual(artifactFirst);
  });

  it("contains cancellation and timeout while discarding delayed synthetic worker output", async () => {
    const cancelledController = new AbortController();
    const cancelledWorker = createTypeScriptShapedWorker({
      create_session: sessionFactory(new ReorderedViewPort([tsConfig, tsSource], {})),
      transport_script: { delay_ms: 50 },
    });
    const cancelledPromise = executeWithRuntime(
      createRuntime(cancelledWorker),
      "cancelled-synthetic",
      "discover_partitions",
      discoverPayload(),
      { signal: cancelledController.signal },
    );
    cancelledController.abort();
    await expect(cancelledPromise).resolves.toEqual({ accepted: false, code: "plugin-sdk:cancelled" });

    const timeoutWorker = createTypeScriptShapedWorker({
      create_session: sessionFactory(new ReorderedViewPort([tsConfig, tsSource], {})),
      transport_script: { delay_ms: 50 },
    });
    await expect(executeWithRuntime(
      createRuntime(timeoutWorker),
      "timeout-synthetic",
      "discover_partitions",
      discoverPayload(),
      { deadline_at_ms: Date.now() + 1 },
    )).resolves.toEqual({ accepted: false, code: "plugin-sdk:worker_resource_exhausted", resource: "deadline" });
  });

  it("rejects malformed synthetic output through the public closed protocol", async () => {
    const worker = createTypeScriptShapedWorker({
      create_session: sessionFactory(new ReorderedViewPort([tsConfig, tsSource], {})),
      transport_script: { response_mode: "malformed" },
    });

    await expect(execute(worker, "malformed-synthetic", "discover_partitions", discoverPayload())).resolves.toEqual({
      accepted: false,
      code: "plugin-sdk:worker_protocol_invalid",
    });
  });

  it("rejects fields outside the authoritative call and outcome payload schemas", async () => {
    const worker = createTypeScriptShapedWorker({
      create_session: sessionFactory(new ReorderedViewPort([tsConfig, tsSource], {})),
      transport_script: { response_mode: "invalid_payload" },
    });

    await expect(execute(worker, "invalid-payload-synthetic", "describe", describePayload())).resolves.toEqual({
      accepted: false,
      code: "plugin-sdk:worker_protocol_invalid",
    });
    await expect(execute(
      createTypeScriptShapedWorker({
        create_session: sessionFactory(new ReorderedViewPort([tsConfig, tsSource], {})),
      }),
      "invalid-call-payload-synthetic",
      "describe",
      { ...describePayload(), manifest: { forbidden: true } },
    )).resolves.toEqual({ accepted: false, code: "plugin-sdk:worker_protocol_invalid" });
  });

  it("emits the authoritative bounded non-success payload for an unsupported call", async () => {
    const worker = createTypeScriptShapedWorker({
      create_session: sessionFactory(new ReorderedViewPort([tsConfig, tsSource], {})),
    });

    const result = await execute(worker, "unsupported-projection", "generate_projection", projectionPayload());

    expect(result).toMatchObject({
      accepted: true,
      response: {
        outcome: "unsupported",
        payload: {
          candidate_issue_code: "core:plugin_unsupported",
          retryability: "not_retryable",
          message: "The synthetic fixture does not support this call.",
          details: {
            request_id: "unsupported-projection",
            plugin_id: "fixture:typescript",
            call: "generate_projection",
            capability: "fixture:unsupported",
          },
        },
      },
    });
  });

  it("relaunches after crashes and quarantines only the exact build in the affected workspace", async () => {
    const store = new ThresholdQuarantineStore();
    let launches = 0;
    const otherBuild: WorkerKey = { ...workerKey, executable_build_digest: "sha256:synthetic-build-other" };
    const factory = (key: WorkerKey) => createTypeScriptShapedWorker({
      create_session: sessionFactory(new ReorderedViewPort([tsConfig, tsSource], {})),
      transport_script: key.executable_build_digest === workerKey.executable_build_digest
        ? { crash_workspace_ids: ["workspace-a"] }
        : {},
    });
    const runtime = createRuntimeFromFactory(factory, store, () => { launches += 1; });

    await expect(executeWithRuntime(runtime, "crash-a-1", "discover_partitions", discoverPayload("workspace-a"), { workspace_id: "workspace-a" }))
      .resolves.toMatchObject({ accepted: false, code: "plugin-sdk:worker_lost" });
    await expect(executeWithRuntime(runtime, "crash-a-2", "discover_partitions", discoverPayload("workspace-a"), { workspace_id: "workspace-a" }))
      .resolves.toMatchObject({ accepted: false, code: "plugin-sdk:worker_lost" });
    expect(launches).toBe(2);
    await expect(executeWithRuntime(runtime, "quarantined-a", "discover_partitions", discoverPayload("workspace-a"), { workspace_id: "workspace-a" }))
      .resolves.toEqual({ accepted: false, code: "plugin-sdk:worker_quarantined" });
    expect(launches).toBe(2);
    await expect(executeWithRuntime(runtime, "other-build-a", "discover_partitions", discoverPayload("workspace-a"), {
      workspace_id: "workspace-a",
      worker_key: otherBuild,
    })).resolves.toMatchObject({ accepted: true });
    await expect(executeWithRuntime(runtime, "unaffected-b", "discover_partitions", discoverPayload("workspace-b"), { workspace_id: "workspace-b" }))
      .resolves.toMatchObject({ accepted: true });
    expect(launches).toBe(4);
  });

  it("rejects namespace collisions atomically through the public registry API", () => {
    const result = new PluginRegistryAssembler(pluginDigestAuthority).assemble(registryInput([
      registryPackage("one:plugin", "shared"),
      registryPackage("two:plugin", "shared"),
    ]));

    expect(result).toMatchObject({ ok: false, issues: [{ payload: { reason_code: "NAMESPACE_CONFLICT" } }] });
    expect(result).not.toHaveProperty("registry");
  });

  it("deduplicates identical shared language supplies and rejects conflicting supplies", () => {
    const assembler = new PluginRegistryAssembler(pluginDigestAuthority);
    const first = registryPackage("one:plugin", "one");
    const second = registryPackage("two:plugin", "two");
    const identical = assembler.assemble(registryInput([first, second]));
    expect(identical.ok).toBe(true);
    if (!identical.ok) throw new Error("expected shared language registry");
    expect(identical.registry.languages[0]?.suppliers.map((supplier) => supplier.plugin_id)).toEqual(["one:plugin", "two:plugin"]);

    const conflicting = assembler.assemble(registryInput([
      first,
      registryPackage("two:plugin", "two", { ...sharedLanguage, description: "Conflicting bytes." }),
    ]));
    expect(conflicting).toMatchObject({ ok: false, issues: [{ payload: { reason_code: "LANGUAGE_DEFINITION_CONFLICT" } }] });
  });

  it("invalidates a partition consumer when an empty lookup gains a matching record", async () => {
    const manifestSession = sessionFactory(new ReorderedViewPort([tsConfig, tsSource], {}))({
      request_id: "request-empty-lookup",
      request_digest: canonicalSha256("request-empty-lookup"),
      call: "discover_partitions",
      payload: discoverPayload(),
      plugin_id: "fixture:typescript",
      plugin_version: "1.0.0",
      cancellation_signal: new AbortController().signal,
    });
    await manifestSession.records.query({ kind: "fixture:typescript_declaration" });
    const manifest = (await manifestSession.finalize({})).manifest;
    const addedRecord = { input_type: "base_record", record_id: "record-added", record_digest: "sha256:record-added" } as const;
    const binder = new PluginLookupInvalidationBinder({
      async journalCoverage() { return { journaled_dimensions: ["kind"] }; },
      async persistLookupDependencies() {},
      async currentLookupResult() {
        return { analysis_view_digest: analysisView.analysis_view_digest, completeness: complete, results: [addedRecord] };
      },
    }, metadataMaterializationLimits);
    const dependencies = await binder.bind({
      manifest,
      workspace_id: "workspace-conformance",
      consumer_type: "partition_set",
      consumer_id: "partition-typescript",
      valid_from_generation: 1,
      authorized_conservative_scopes: [],
      cancellation_signal: new AbortController().signal,
    });

    await expect(binder.revalidate({ dependencies, generation: 2, cancellation_signal: new AbortController().signal }))
      .resolves.toEqual({
        invalidated_consumer_ids: ["partition-typescript"],
        changed_lookup_dependency_ids: [dependencies[0]?.lookup_dependency_id],
      });
  });

  it("changes a consumed base-record lookup digest when its transitive artifact changes", () => {
    const address = '{"kind":"fixture:base"}';
    const result = (artifactVersion: string) => [{
      input_type: "base_record",
      record_id: "record-base",
      record_digest: "sha256:record-base",
      transitive_artifact_version_ids: [artifactVersion],
    }] as const;

    expect(pluginLookupResultSetDigest("record_query", address, analysisView.analysis_view_digest, "complete", result("artifact-version-one")))
      .not.toBe(pluginLookupResultSetDigest("record_query", address, analysisView.analysis_view_digest, "complete", result("artifact-version-two")));
  });
});
