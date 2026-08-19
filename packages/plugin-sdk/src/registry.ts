import { canonicalSchemaRegistry, capabilityRegistry, facetRegistry, universalEntityKinds, universalRelationKinds, validateSchemaDefinition, validateSchemaReferenceGraph, type JsonValue, type LanguageDefinition, type PluginCompatibilityIssue, type PluginRegistryContribution, type PluginStructuralStageDeclaration, type RegistryNamespaceBindingEntry } from "@urdira/contracts";
import { canonicalJson, deepFreeze, hasExactKeys } from "./canonical.js";
import type { PluginDigestAuthority } from "./digest-authority.js";
import { compareCanonicalJsonUtf8, compareUtf8Bytes } from "./ordering.js";
import { validateAuthoritativeModel, type DiscoveredPluginPackage } from "./packages.js";
import type { SdkPluginResolutionLock } from "./resolution.js";

export interface SharedLanguageSupplier {
  readonly plugin_id: string;
  readonly plugin_version: string;
  readonly package_digest: string;
  readonly contribution_digest: string;
}

export interface SharedLanguageDefinition {
  readonly definition: LanguageDefinition;
  readonly canonical_bytes: string;
  readonly definition_digest: string;
  readonly suppliers: readonly SharedLanguageSupplier[];
}

export type RegistryNamespaceBinding = RegistryNamespaceBindingEntry;

export interface AssembledPluginRegistry {
  readonly registry_snapshot_id: string;
  readonly resolution_lock_id: string;
  readonly core_registry_digest: string;
  readonly runtime_contract_version: number;
  readonly registry_contract_version: string;
  readonly namespace_bindings: readonly RegistryNamespaceBinding[];
  readonly contributions: readonly PluginRegistryContribution[];
  readonly definitions: Readonly<Record<string, readonly unknown[]>>;
  readonly languages: readonly SharedLanguageDefinition[];
  readonly registry_digest: string;
}

export interface RegistryAssemblyInput {
  readonly packages: readonly DiscoveredPluginPackage[];
  readonly lock: SdkPluginResolutionLock;
  readonly registry_snapshot_id: string;
  readonly core_registry_digest: string;
  readonly emission_valid_from_generation: string;
  readonly clock: (() => string) | { now(): string };
  readonly id_source: (() => string) | { next(): string };
}

export type RegistryAssemblyResult =
  | { readonly ok: true; readonly registry: AssembledPluginRegistry }
  | { readonly ok: false; readonly issues: readonly PluginCompatibilityIssue[] };

const DEFINITION_FIELDS = {
  canonical_schema_definitions: "schema_id",
  digest_domain_definitions: "digest_domain",
  canonical_comparator_definitions: "comparator_id",
  external_verification_contract_definitions: "external_verification_contract_id",
  runtime_component_definitions: "component_id",
  digest_recipe_definitions: "digest_recipe_id",
  digest_reference_definitions: "digest_reference_id",
  capability_contract_definitions: "capability",
  construct_class_definitions: "construct_code",
  capability_limitation_definitions: "limitation_code",
  record_kind_definitions: "kind",
  facet_definitions: "facet",
  semantic_role_definitions: "role",
  metric_definitions: "metric",
  effect_definitions: "effect",
  diagnostic_code_definitions: "code",
  candidate_issue_code_definitions: "issue_code",
  dependency_role_definitions: "dependency_role",
  projection_kind_definitions: "projection_kind",
  lifecycle_reason_code_definitions: "reason_code",
  completeness_reason_definitions: "reason_code",
  semantic_section_kind_definitions: "section_kind",
  semantic_reason_definitions: "reason_code",
  evidence_assumption_definitions: "assumption_code",
  evidence_explanation_definitions: "explanation_code",
} as const satisfies Partial<Record<keyof PluginRegistryContribution, string>>;

const DEFINITION_MODELS: Readonly<Record<keyof typeof DEFINITION_FIELDS, string>> = {
  canonical_schema_definitions: "CanonicalSchemaDefinition", digest_domain_definitions: "DigestDomainDefinition",
  canonical_comparator_definitions: "CanonicalComparatorDefinition", external_verification_contract_definitions: "ExternalVerificationContractDefinition",
  runtime_component_definitions: "RuntimeComponentDefinition", digest_recipe_definitions: "DigestRecipeDefinition",
  digest_reference_definitions: "DigestReferenceDefinition", capability_contract_definitions: "CapabilityContractDefinition",
  construct_class_definitions: "ConstructClassDefinition", capability_limitation_definitions: "CapabilityLimitationDefinition",
  record_kind_definitions: "RecordKindDefinition", facet_definitions: "FacetDefinition", semantic_role_definitions: "SemanticRoleDefinition",
  metric_definitions: "MetricDefinition", effect_definitions: "EffectDefinition", diagnostic_code_definitions: "DiagnosticCodeDefinition",
  candidate_issue_code_definitions: "CandidateIssueCodeDefinition", dependency_role_definitions: "DependencyRoleDefinition",
  projection_kind_definitions: "ProjectionKindDefinition", lifecycle_reason_code_definitions: "LifecycleReasonCodeDefinition",
  completeness_reason_definitions: "CompletenessReasonDefinition", semantic_section_kind_definitions: "SemanticSectionKindDefinition",
  semantic_reason_definitions: "SemanticReasonDefinition", evidence_assumption_definitions: "EvidenceAssumptionDefinition",
  evidence_explanation_definitions: "EvidenceExplanationDefinition",
};

const LANGUAGE_KEYS = ["language_id", "definition_revision", "schema_version", "description", "display_name", "aliases", "lifecycle_state"] as const;
const LANGUAGE_OPTIONAL_KEYS = ["deprecated_since", "retired_since", "replacement_language_id"] as const;

type AssemblyFailure = { readonly reason_code: string; readonly plugin_ids: readonly string[]; readonly detail?: JsonValue };

function sourceValue(source: (() => string) | { now(): string } | { next(): string }): string {
  if (typeof source === "function") return source();
  if ("now" in source) return source.now();
  return source.next();
}

function issue(input: RegistryAssemblyInput, failure: AssemblyFailure): PluginCompatibilityIssue {
  const payload: JsonValue = { reason_code: failure.reason_code, ...(failure.detail === undefined ? {} : { detail: failure.detail }) };
  return deepFreeze({
    issue_id: sourceValue(input.id_source),
    code: "REGISTRY_CONTRIBUTION_INVALID",
    severity: "error",
    phase: "registry_validation",
    plugin_ids: [...failure.plugin_ids].sort(compareUtf8Bytes),
    definition_references: [],
    requirement_references: [],
    summary: "Plugin registry contributions could not be assembled atomically.",
    payload,
    required_action: "repair_registry_contribution",
    retryable: "false",
    created_at: sourceValue(input.clock),
  });
}

function failure(input: RegistryAssemblyInput, value: AssemblyFailure): RegistryAssemblyResult {
  return deepFreeze({ ok: false, issues: [issue(input, value)] });
}

function aliasKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function validLifecycle(record: Readonly<Record<string, unknown>>): boolean {
  const state = record["lifecycle_state"];
  if (state !== "active" && state !== "deprecated" && state !== "retired") return false;
  if (state === "active") return record["deprecated_since"] === undefined && record["retired_since"] === undefined;
  if (state === "deprecated") return record["deprecated_since"] !== undefined && record["retired_since"] === undefined;
  return record["retired_since"] !== undefined;
}

function validUniversalReferences(record: Readonly<Record<string, unknown>>): boolean {
  const authoritative = new Set<string>([...universalEntityKinds, ...universalRelationKinds]);
  for (const [key, value] of Object.entries(record)) {
    if (!key.includes("universal_kind")) continue;
    const values = Array.isArray(value) ? value : [value];
    if (values.some((item) => typeof item !== "string" || !authoritative.has(item))) return false;
  }
  return true;
}

function authorityIntegerVersion(value: string): string | undefined {
  const match = /^(0|[1-9]\d*)\.0\.0$/u.exec(value);
  return match?.[1];
}

function validDefinitionReferences(packages: readonly DiscoveredPluginPackage[], digests: PluginDigestAuthority): boolean {
  const contributions = packages.map((item) => item.contribution);
  const schemaCoordinates = new Set(canonicalSchemaRegistry.map((entry) => entry.id));
  for (const definition of contributions.flatMap((item) => item.canonical_schema_definitions)) schemaCoordinates.add(`${definition.schema_id}@${definition.schema_version}`);
  const schemaExists = (id: string, version: string): boolean => {
    const integerVersion = authorityIntegerVersion(version);
    return integerVersion !== undefined && schemaCoordinates.has(`${id}@${integerVersion}`);
  };
  const domainIds = new Set(contributions.flatMap((item) => item.digest_domain_definitions).map((item) => item.digest_domain));
  const recipeCoordinates = new Set(contributions.flatMap((item) => item.digest_recipe_definitions).map((item) => `${item.digest_recipe_id}@${item.recipe_version}`));
  const verifierCoordinates = new Set(contributions.flatMap((item) => item.external_verification_contract_definitions).map((item) => `${item.external_verification_contract_id}@${item.contract_version}`));
  const componentCoordinates = new Set(contributions.flatMap((item) => item.runtime_component_definitions).map((item) => `${item.component_id}@${item.component_version}`));
  const capabilityIds = new Set<string>([...capabilityRegistry, ...contributions.flatMap((item) => item.capability_contract_definitions).map((item) => item.capability)]);
  const facetIds = new Set<string>([...facetRegistry, ...contributions.flatMap((item) => item.facet_definitions).map((item) => item.facet)]);
  const roles = new Set(contributions.flatMap((item) => item.semantic_role_definitions).map((item) => item.role));
  const effects = new Set(contributions.flatMap((item) => item.effect_definitions).map((item) => item.effect));
  const universalKinds = new Set<string>([...universalEntityKinds, ...universalRelationKinds]);
  const ownedOrCore = (values: readonly string[], known: ReadonlySet<string>): boolean => values.every((value) => value.startsWith("core:") ? known.has(value) : known.has(value));
  const coreDomainExists = (id: string): boolean => { try { return digests.has_core_digest_domain(id); } catch { return false; } };
  const coreRecipeExists = (id: string, version: string): boolean => { try { return digests.has_core_digest_recipe(id, version); } catch { return false; } };
  const coreVerifierExists = (id: string, version: string): boolean => { try { return digests.has_core_external_verifier(id, version); } catch { return false; } };

  for (const contribution of contributions) {
    const stages = (contribution.structural_stage_definitions ?? []) as unknown as readonly PluginStructuralStageDeclaration[];
    if (stages.length > 0) {
      const ordered = [...stages].sort((left, right) => left.ordinal - right.ordinal || left.stage_id.localeCompare(right.stage_id));
      const stageIds = new Set<string>();
      const stageCount = stages[0]?.stage_count ?? 0;
      if (!Number.isSafeInteger(stageCount) || stageCount <= 0 || stageCount !== stages.length
        || ordered.some((stage, index) => stage.stage_count !== stageCount || stage.ordinal !== index + 1 || stage.stage_id.length === 0 || stageIds.has(stage.stage_id))) return false;
      for (const stage of ordered) {
        stageIds.add(stage.stage_id);
        if (stage.depends_on_stage_ids.some((dependency) => !stageIds.has(dependency) || dependency === stage.stage_id)
          || stage.capabilities.some((capability) => !capabilityIds.has(capability))) return false;
      }
      const declaredCapabilities = contribution.capability_contract_definitions.map((entry) => entry.capability);
      const stageCapabilities = ordered.flatMap((stage) => stage.capabilities);
      if (new Set(stageCapabilities).size !== stageCapabilities.length || declaredCapabilities.some((capability) => !stageCapabilities.includes(capability))) return false;
    }
    for (const recipe of contribution.digest_recipe_definitions) {
      if (!schemaExists(recipe.target_schema_id, recipe.target_schema_version) || !schemaExists(recipe.payload_schema_id, recipe.payload_schema_version) ||
          recipe.verified_input_schema_id !== undefined && !schemaExists(recipe.verified_input_schema_id, recipe.verified_input_schema_version!) ||
          (recipe.digest_domain.startsWith("core:") ? !coreDomainExists(recipe.digest_domain) : !domainIds.has(recipe.digest_domain))) return false;
    }
    for (const verifier of contribution.external_verification_contract_definitions) {
      if (!schemaExists(verifier.verified_input_schema_id, verifier.verified_input_schema_version) ||
          (verifier.terminal_digest_recipe_id.startsWith("core:") ? !authorityIntegerVersion(verifier.terminal_digest_recipe_version) || !coreRecipeExists(verifier.terminal_digest_recipe_id, authorityIntegerVersion(verifier.terminal_digest_recipe_version)!) : !recipeCoordinates.has(`${verifier.terminal_digest_recipe_id}@${verifier.terminal_digest_recipe_version}`))) return false;
    }
    for (const reference of contribution.digest_reference_definitions) {
      if (!schemaExists(reference.target_schema_id, reference.target_schema_version) ||
          (reference.source_digest_recipe_id.startsWith("core:") ? !authorityIntegerVersion(reference.source_digest_recipe_version) || !coreRecipeExists(reference.source_digest_recipe_id, authorityIntegerVersion(reference.source_digest_recipe_version)!) : !recipeCoordinates.has(`${reference.source_digest_recipe_id}@${reference.source_digest_recipe_version}`)) ||
          reference.external_verification_contract_id !== undefined && (reference.external_verification_contract_id.startsWith("core:") ? !authorityIntegerVersion(reference.external_verification_contract_version!) || !coreVerifierExists(reference.external_verification_contract_id, authorityIntegerVersion(reference.external_verification_contract_version!)!) : !verifierCoordinates.has(`${reference.external_verification_contract_id}@${reference.external_verification_contract_version}`))) return false;
    }
    for (const component of contribution.runtime_component_definitions) for (const binding of component.component_contracts) {
      if (binding.configuration_schema_id !== undefined && !schemaExists(binding.configuration_schema_id, binding.configuration_schema_version!)) return false;
    }
    for (const kind of contribution.record_kind_definitions) {
      if (!schemaCoordinates.has(`${kind.payload_schema}@1`) || !universalKinds.has(kind.universal_kind) || !ownedOrCore([...kind.required_facets, ...kind.allowed_facets], facetIds)) return false;
    }
    for (const facet of contribution.facet_definitions) if (!ownedOrCore(facet.applicable_universal_kinds, universalKinds) || !ownedOrCore([...facet.implied_facets, ...facet.incompatible_facets], facetIds)) return false;
    for (const role of contribution.semantic_role_definitions) if (!ownedOrCore(role.allowed_subject_universal_kinds, universalKinds) || !ownedOrCore(role.allowed_subject_facets, facetIds) || !ownedOrCore([...role.implied_roles, ...role.incompatible_roles], roles)) return false;
    for (const metric of contribution.metric_definitions) if (!ownedOrCore(metric.allowed_subject_universal_kinds, universalKinds)) return false;
    for (const effect of contribution.effect_definitions) if (!ownedOrCore(effect.allowed_subject_universal_kinds, universalKinds) || !ownedOrCore(effect.implied_effects, effects)) return false;
    for (const capability of contribution.capability_contract_definitions) if (!ownedOrCore(capability.allowed_universal_kinds, universalKinds)) return false;
    for (const construct of contribution.construct_class_definitions) if (!ownedOrCore(construct.applicable_capabilities, capabilityIds)) return false;
    for (const limitation of contribution.capability_limitation_definitions) if (!ownedOrCore(limitation.allowed_capabilities, capabilityIds)) return false;
    for (const projection of contribution.projection_kind_definitions) if (!schemaCoordinates.has(`${projection.payload_schema}@1`)) return false;
    for (const completeness of contribution.completeness_reason_definitions) if (!ownedOrCore(completeness.affected_capabilities, capabilityIds)) return false;
  }
  for (const item of packages) for (const build of item.runtime_builds) if (!componentCoordinates.has(`${build.component_id}@${build.component_version}`)) return false;
  return true;
}

export class PluginRegistryAssembler {
  constructor(private readonly digests: PluginDigestAuthority) {}

  assemble(input: RegistryAssemblyInput): RegistryAssemblyResult {
    let lockDigest: string | undefined;
    try {
      lockDigest = this.digests.resolution_lock({
        resolution_lock_id: input.lock.resolution_lock_id,
        workspace_id: input.lock.workspace_id,
        resolver_version: input.lock.resolver_version,
        resolved_plugins: input.lock.resolved_plugins,
      });
    } catch { lockDigest = undefined; }
    if (lockDigest !== input.lock.lock_digest || !/^sha256:[0-9a-f]{64}$/u.test(lockDigest ?? "")) {
      return failure(input, { reason_code: "LOCK_DIGEST_INVALID", plugin_ids: input.lock.resolved_plugins.map((item) => item.plugin_id) });
    }
    const packages = [...input.packages].sort((left, right) => compareUtf8Bytes(left.plugin_id, right.plugin_id) || compareUtf8Bytes(left.plugin_version, right.plugin_version));
    const selectedIds = new Set(packages.map((item) => item.plugin_id));
    const namespaceOwners = new Map<string, string>();
    const packageCoordinates = packages.map((item) => `${item.plugin_id}\u0000${item.plugin_version}\u0000${item.package_digest}`);
    const lockCoordinates = input.lock.resolved_plugins.map((item) => `${item.plugin_id}\u0000${item.plugin_version}\u0000${item.package_digest}`);
    if (new Set(packageCoordinates).size !== packageCoordinates.length || new Set(lockCoordinates).size !== lockCoordinates.length ||
        packageCoordinates.length !== lockCoordinates.length || [...packageCoordinates].sort(compareUtf8Bytes).some((coordinate, index) => coordinate !== [...lockCoordinates].sort(compareUtf8Bytes)[index])) {
      return failure(input, { reason_code: "LOCK_PACKAGE_SET_MISMATCH", plugin_ids: input.lock.resolved_plugins.map((item) => item.plugin_id) });
    }

    for (const item of packages) {
      const locked = input.lock.resolved_plugins.find((entry) => entry.plugin_id === item.plugin_id && entry.plugin_version === item.plugin_version && entry.package_digest === item.package_digest)!;
      const runtimeContract = authorityIntegerVersion(locked.plugin_contract_version);
      if (locked.namespace !== item.namespace || locked.declaration_digest !== item.declaration_digest || locked.package_digest !== item.package_digest ||
          locked.contribution_digest !== item.contribution_digest || locked.analysis_digest !== item.compatibility.analysis_digest ||
          locked.analysis_configuration_digest !== item.analysis_configuration_digest || runtimeContract === undefined ||
          !item.compatibility.supported_plugin_contract_versions.includes(Number(runtimeContract)) ||
          locked.registry_contract_version !== item.contribution.registry_contract_version) {
        return failure(input, { reason_code: "LOCK_PACKAGE_PIN_MISMATCH", plugin_ids: [item.plugin_id] });
      }
      if (item.contribution.plugin_id !== item.plugin_id || item.contribution.plugin_version !== item.plugin_version || item.contribution.namespace !== item.namespace) {
        return failure(input, { reason_code: "SELECTED_COORDINATE_MISMATCH", plugin_ids: [item.plugin_id] });
      }
      if (item.namespace === "core") return failure(input, { reason_code: "DEFINITION_NAMESPACE_INVALID", plugin_ids: [item.plugin_id], detail: { namespace: "core" } });
      const owner = namespaceOwners.get(item.namespace);
      if (owner !== undefined && owner !== item.plugin_id) return failure(input, { reason_code: "NAMESPACE_CONFLICT", plugin_ids: [owner, item.plugin_id], detail: { namespace: item.namespace } });
      namespaceOwners.set(item.namespace, item.plugin_id);
    }

    const lockedRuntimeContracts = new Set(input.lock.resolved_plugins.map((item) => item.plugin_contract_version));
    const lockedRegistryContracts = new Set(input.lock.resolved_plugins.map((item) => item.registry_contract_version));
    if (lockedRuntimeContracts.size !== 1 || lockedRegistryContracts.size !== 1) {
      return failure(input, { reason_code: "LOCK_PACKAGE_PIN_MISMATCH", plugin_ids: input.lock.resolved_plugins.map((item) => item.plugin_id) });
    }

    const definitions: Record<string, unknown[]> = Object.fromEntries(Object.keys(DEFINITION_FIELDS).map((field) => [field, []]));
    const coordinates = new Map<string, { value: unknown; plugin_id: string }>();
    for (const item of packages) {
      for (const dependency of item.contribution.dependencies) {
        if (!selectedIds.has(dependency.plugin_id)) return failure(input, { reason_code: "MANDATORY_DEPENDENCY_MISSING", plugin_ids: [item.plugin_id, dependency.plugin_id] });
        const selected = packages.find((candidate) => candidate.plugin_id === dependency.plugin_id);
        if (selected?.namespace !== dependency.namespace) return failure(input, { reason_code: "MANDATORY_DEPENDENCY_MISMATCH", plugin_ids: [item.plugin_id, dependency.plugin_id] });
      }
      for (const [field, identifierField] of Object.entries(DEFINITION_FIELDS)) {
        const values = item.contribution[field as keyof PluginRegistryContribution] as readonly unknown[];
        for (const value of values) {
          if (value === null || typeof value !== "object" || Array.isArray(value)) return failure(input, { reason_code: "DEFINITION_COORDINATE_INVALID", plugin_ids: [item.plugin_id] });
          const record = value as Record<string, unknown>;
          const identifier = record[identifierField];
          const revision = record["definition_revision"];
          if (typeof identifier !== "string" || !Number.isSafeInteger(revision) || Number(revision) <= 0) return failure(input, { reason_code: "DEFINITION_COORDINATE_INVALID", plugin_ids: [item.plugin_id] });
          if (identifier.startsWith("core:") || !identifier.startsWith(`${item.namespace}:`) || (record["plugin_owner"] !== undefined && record["plugin_owner"] !== item.plugin_id)) {
            return failure(input, { reason_code: "DEFINITION_NAMESPACE_INVALID", plugin_ids: [item.plugin_id], detail: { identifier } });
          }
          const modelName = DEFINITION_MODELS[field as keyof typeof DEFINITION_FIELDS];
          if (revision !== 1 || record["schema_version"] !== 1 || record["lifecycle_state"] !== "active" ||
              field !== "canonical_schema_definitions" && !validateAuthoritativeModel(modelName, value) || !validLifecycle(record) || !validUniversalReferences(record)) {
            return failure(input, { reason_code: "DEFINITION_SEMANTICS_INVALID", plugin_ids: [item.plugin_id], detail: { identifier } });
          }
          if (field === "runtime_component_definitions" && (record["component_contracts"] as readonly Record<string, unknown>[]).some((binding) => binding["component_kind"] !== "source_provider" && binding["component_kind"] !== "projection_generator")) {
            return failure(input, { reason_code: "RUNTIME_COMPONENT_KIND_FORBIDDEN", plugin_ids: [item.plugin_id], detail: { identifier } });
          }
          const coordinate = `${field}\u0000${identifier}\u0000${String(revision)}`;
          const existing = coordinates.get(coordinate);
          if (existing) {
            if (field === "runtime_component_definitions" && (existing.value as Record<string, unknown>)["behavior_digest"] !== record["behavior_digest"]) {
              return failure(input, { reason_code: "RUNTIME_COMPONENT_BEHAVIOR_CONFLICT", plugin_ids: [existing.plugin_id, item.plugin_id], detail: { identifier } });
            }
            if (canonicalJson(existing.value) !== canonicalJson(value)) return failure(input, { reason_code: "DEFINITION_COORDINATE_CONFLICT", plugin_ids: [existing.plugin_id, item.plugin_id], detail: { identifier } });
            return failure(input, { reason_code: "DEFINITION_COORDINATE_DUPLICATE", plugin_ids: [existing.plugin_id, item.plugin_id], detail: { identifier } });
          }
          coordinates.set(coordinate, { value, plugin_id: item.plugin_id });
          definitions[field]!.push(value);
        }
      }
    }

    if (!validDefinitionReferences(packages, this.digests)) {
      return failure(input, { reason_code: "DEFINITION_REFERENCE_INVALID", plugin_ids: packages.map((item) => item.plugin_id) });
    }

    try {
      const schemas = packages.flatMap((item) => item.contribution.canonical_schema_definitions);
      for (const schema of schemas) validateSchemaDefinition(schema);
      validateSchemaReferenceGraph(schemas);
    } catch {
      return failure(input, { reason_code: "DEFINITION_SEMANTICS_INVALID", plugin_ids: packages.map((item) => item.plugin_id) });
    }

    const languageMap = new Map<string, { definition: LanguageDefinition; bytes: string; digest: string; suppliers: SharedLanguageSupplier[] }>();
    for (const item of packages) {
      for (const language of item.contribution.language_definitions) {
        if (!hasExactKeys(language, LANGUAGE_KEYS, LANGUAGE_OPTIONAL_KEYS) || !validateAuthoritativeModel("LanguageDefinition", language) || !validLifecycle(language as unknown as Record<string, unknown>) || typeof language.language_id !== "string" || language.language_id.startsWith("core:") || !Number.isSafeInteger(language.definition_revision) || language.definition_revision <= 0 || !Array.isArray(language.aliases) || language.aliases.some((alias) => typeof alias !== "string")) {
          return failure(input, { reason_code: "LANGUAGE_DEFINITION_INVALID", plugin_ids: [item.plugin_id] });
        }
        const bytes = canonicalJson(language);
        let digest: string | undefined;
        try { digest = this.digests.language_definition(language); } catch { digest = undefined; }
        if (!/^sha256:[0-9a-f]{64}$/u.test(digest ?? "")) {
          return failure(input, { reason_code: "LANGUAGE_DEFINITION_DIGEST_INVALID", plugin_ids: [item.plugin_id] });
        }
        const authoritativeLanguageDigest = digest as string;
        const supplier = { plugin_id: item.plugin_id, plugin_version: item.plugin_version, package_digest: item.package_digest, contribution_digest: item.contribution.contribution_digest };
        const existing = languageMap.get(language.language_id);
        if (existing && (existing.bytes !== bytes || existing.digest !== authoritativeLanguageDigest)) return failure(input, { reason_code: "LANGUAGE_DEFINITION_CONFLICT", plugin_ids: [...existing.suppliers.map((entry) => entry.plugin_id), item.plugin_id], detail: { language_id: language.language_id } });
        if (existing) existing.suppliers.push(supplier);
        else languageMap.set(language.language_id, { definition: language, bytes, digest: authoritativeLanguageDigest, suppliers: [supplier] });
      }
    }

    for (const values of Object.values(definitions)) values.sort(compareCanonicalJsonUtf8);
    const languages = [...languageMap.values()].sort((left, right) => compareUtf8Bytes(left.definition.language_id, right.definition.language_id)).map((item) => ({
      definition: item.definition,
      canonical_bytes: item.bytes,
      definition_digest: item.digest,
      suppliers: item.suppliers.sort((left, right) => compareUtf8Bytes(left.plugin_id, right.plugin_id) || compareUtf8Bytes(left.plugin_version, right.plugin_version) || compareUtf8Bytes(left.package_digest, right.package_digest)),
    }));
    const namespace_bindings = packages.map((item) => ({
      namespace_binding_id: sourceValue(input.id_source),
      workspace_id: input.lock.workspace_id,
      namespace: item.namespace,
      plugin_id: item.plugin_id,
      plugin_version: item.plugin_version,
      contribution_digest: item.contribution.contribution_digest,
      emission_valid_from_generation: input.emission_valid_from_generation,
    }));
    const runtimeContractVersion = authorityIntegerVersion(input.lock.resolved_plugins[0]?.plugin_contract_version ?? "") ?? "0";
    const registryContractVersion = input.lock.resolved_plugins[0]?.registry_contract_version ?? "0.0.0";
    const core = {
      registry_snapshot_id: input.registry_snapshot_id,
      resolution_lock_id: input.lock.resolution_lock_id,
      core_registry_digest: input.core_registry_digest,
      runtime_contract_version: Number(runtimeContractVersion),
      registry_contract_version: registryContractVersion,
      namespace_bindings,
      contributions: packages.map((item) => item.contribution),
      definitions,
      languages,
    };
    let registryDigest: string | undefined;
    try {
      registryDigest = this.digests.registry_snapshot({
        registry_snapshot_id: core.registry_snapshot_id,
        registry_contract_version: core.registry_contract_version,
        core_registry_digest: core.core_registry_digest,
        resolution_lock_id: core.resolution_lock_id,
        namespace_bindings: core.namespace_bindings,
      });
    } catch { registryDigest = undefined; }
    if (!/^sha256:[0-9a-f]{64}$/u.test(registryDigest ?? "")) {
      return failure(input, { reason_code: "REGISTRY_DIGEST_INVALID", plugin_ids: packages.map((item) => item.plugin_id) });
    }
    return deepFreeze({ ok: true, registry: { ...core, registry_digest: registryDigest as string } });
  }

  findLanguagesByAlias(registry: AssembledPluginRegistry, alias: string): readonly SharedLanguageDefinition[] {
    const key = aliasKey(alias);
    return registry.languages.filter((item) => item.definition.aliases.some((candidate) => aliasKey(candidate) === key));
  }

  getLanguage(registry: AssembledPluginRegistry, language_id: string): SharedLanguageDefinition | undefined {
    return registry.languages.find((item) => item.definition.language_id === language_id);
  }
}
