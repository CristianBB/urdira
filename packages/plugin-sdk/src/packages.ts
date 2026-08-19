import {
  canonicalSchemaRegistry,
  modelContractRegistry,
  type AnalysisConfiguration,
  type AnalyzerImplementationManifest,
  type PluginCompatibilityDeclaration,
  type PluginPackageManifest,
  type PluginRegistryContribution,
  type RuntimeComponentBuild,
  type RuntimeComponentBehaviorManifest,
  type RuntimeComponentImplementationManifest,
} from "@urdira/contracts";
import { canonicalJson, deepFreeze, hasExactKeys, sha256Bytes } from "./canonical.js";
import type { PluginDigestAuthority } from "./digest-authority.js";
import { sdkError } from "./errors.js";
import { compareCanonicalJsonUtf8, compareUtf8Bytes } from "./ordering.js";
import { materializePortResult, type PortMaterializationLimits } from "./port-boundary.js";
import { parseSemVer, parseVersionRequirementText } from "./semver.js";

export type { AnalysisConfiguration, AnalyzerImplementationManifest, PluginCompatibilityDeclaration, RuntimeComponentBehaviorManifest, RuntimeComponentBuild, RuntimeComponentImplementationManifest } from "@urdira/contracts";

export interface InstalledPluginBundle {
  readonly package_locator: string;
  readonly manifest: PluginPackageManifest;
  readonly compatibility: PluginCompatibilityDeclaration;
  readonly contribution: PluginRegistryContribution;
  readonly runtime_builds: readonly RuntimeComponentBuild[];
  readonly analyzer_implementation_manifest: AnalyzerImplementationManifest;
  readonly analysis_configuration: AnalysisConfiguration;
  readonly runtime_behavior_manifests: readonly RuntimeComponentBehaviorManifest[];
  readonly runtime_implementation_manifests: readonly RuntimeComponentImplementationManifest[];
}

export interface DiscoveredPluginPackage extends Omit<InstalledPluginBundle, "package_locator"> {
  readonly plugin_id: string;
  readonly plugin_version: string;
  readonly namespace: string;
  readonly package_digest: string;
  readonly declaration_digest: string;
  readonly contribution_digest: string;
  readonly analysis_configuration_digest: string;
}

export interface PluginPackageCollisionCandidate {
  readonly plugin_id: string;
  readonly plugin_version: string;
  readonly package_digests: readonly string[];
}

export interface PluginDiscoveryResult {
  readonly packages: readonly DiscoveredPluginPackage[];
  readonly collision_candidates: readonly PluginPackageCollisionCandidate[];
}

export interface PluginPackageDiscoveryPort {
  list(root_id: string): Promise<readonly InstalledPluginBundle[]>;
  read_file(request: InstalledPackageFileReadRequest): Promise<InstalledPackageFileRead>;
}

export interface InstalledPackageFileReadRequest {
  readonly root_id: string;
  readonly package_locator: string;
  readonly normalized_relative_path: string;
  readonly expected_byte_length: number;
  readonly max_bytes: number;
}

export interface InstalledPackageFileRead { readonly bytes: Uint8Array; readonly byte_length: number; }
export interface PluginDiscoveryPolicy { readonly max_file_bytes: number; }

const BUNDLE_KEYS = ["package_locator", "manifest", "compatibility", "contribution", "runtime_builds", "analyzer_implementation_manifest", "analysis_configuration", "runtime_behavior_manifests", "runtime_implementation_manifests"] as const;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const NAMESPACED = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/u;
const NAMESPACE = /^[a-z][a-z0-9_]*$/u;
const CORE_SCHEMA_IDENTIFIERS = new Set(canonicalSchemaRegistry.map((entry) => entry.id.split("@")[0]!));

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function splitUnion(value: string): string[] {
  let depth = 0;
  let start = 0;
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "<") depth += 1;
    if (value[index] === ">") depth -= 1;
    if (value[index] === "|" && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function validLogicalType(value: unknown, logicalType: string): boolean {
  const sequence = logicalType.match(/^(?:Sequence|Set|OrderedSet)<(.+)>$/u);
  if (sequence) {
    if (!Array.isArray(value)) return false;
    const elementType = sequence[1]!.split(",")[0]!.trim();
    return value.every((item) => validLogicalType(item, elementType));
  }
  const alternatives = splitUnion(logicalType);
  if (alternatives.length > 1) return alternatives.some((item) => item === value || validLogicalType(value, item));
  if (logicalType === "Text" || logicalType === "Identifier" || logicalType === "URI" || logicalType === "Bytes") return typeof value === "string";
  if (logicalType === "NamespacedIdentifier") return typeof value === "string" && (NAMESPACED.test(value) || CORE_SCHEMA_IDENTIFIERS.has(value));
  if (logicalType === "Digest") return typeof value === "string" && DIGEST.test(value);
  if (logicalType === "Boolean") return typeof value === "boolean";
  if (logicalType === "Count") return Number.isSafeInteger(value) && Number(value) >= 0;
  if (logicalType === "PositiveInteger") return Number.isSafeInteger(value) && Number(value) > 0 || typeof value === "string" && /^[1-9]\d*$/u.test(value);
  if (logicalType === "SemVer") {
    if (typeof value !== "string") return false;
    try { parseSemVer(value); return true; } catch { return false; }
  }
  if (logicalType === "JsonValue") return isJsonValue(value);
  if (logicalType === "LifecycleState") return value === "active" || value === "deprecated" || value === "retired";
  if (logicalType === "ClosedPayloadSchema") {
    if (value === null || typeof value !== "object" || Array.isArray(value) || !hasExactKeys(value, ["type", "additionalProperties", "properties", "required"])) return false;
    const schema = value as Record<string, unknown>;
    if (schema["type"] !== "object" || schema["additionalProperties"] !== false || schema["properties"] === null || typeof schema["properties"] !== "object" || Array.isArray(schema["properties"]) || !Array.isArray(schema["required"]) || schema["required"].some((entry) => typeof entry !== "string")) return false;
    const property = (entry: unknown): boolean => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
      const record = entry as Record<string, unknown>;
      const allowed = new Set(["type", "description", "enum", "minimum", "maximum", "items", "properties", "required"]);
      if (Object.keys(record).some((key) => !allowed.has(key)) || !["string", "integer", "boolean", "array", "object"].includes(String(record["type"])) || typeof record["description"] !== "string") return false;
      if (record["enum"] !== undefined && (!Array.isArray(record["enum"]) || record["enum"].some((item) => typeof item !== "string"))) return false;
      if (record["minimum"] !== undefined && !Number.isSafeInteger(record["minimum"]) || record["maximum"] !== undefined && !Number.isSafeInteger(record["maximum"])) return false;
      if (record["items"] !== undefined && !property(record["items"])) return false;
      if (record["properties"] !== undefined && (record["properties"] === null || typeof record["properties"] !== "object" || Array.isArray(record["properties"]) || !Object.values(record["properties"] as Record<string, unknown>).every(property))) return false;
      return record["required"] === undefined || Array.isArray(record["required"]) && record["required"].every((item) => typeof item === "string");
    };
    return Object.values(schema["properties"] as Record<string, unknown>).every(property) && (schema["required"] as string[]).every((field) => field in (schema["properties"] as Record<string, unknown>));
  }
  if (logicalType === "SchemaBoundBytes") return value instanceof Uint8Array;
  if (logicalType === "CanonicalTypeExpression") return value !== null && typeof value === "object" && !Array.isArray(value) && isJsonValue(value);
  if (logicalType.startsWith("Map<")) return value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value as Record<string, unknown>).every(isJsonValue);
  return validateAuthoritativeModel(logicalType, value);
}

export function validateAuthoritativeModel(modelName: string, value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const model = modelContractRegistry.find((candidate) => candidate.name === modelName);
  if (!model) return false;
  const required = model.fields.filter((field) => field.presence === "required").map((field) => field.name);
  const optional = model.fields.filter((field) => field.presence === "optional").map((field) => field.name);
  if (!hasExactKeys(value, required, optional)) return false;
  const record = value as Record<string, unknown>;
  return model.fields.every((field) => field.presence === "optional" && record[field.name] === undefined || validLogicalType(record[field.name], field.logical_type));
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && new Set(right).size === right.length && [...left].sort(compareUtf8Bytes).every((value, index) => value === [...right].sort(compareUtf8Bytes)[index]);
}

function uniqueSubset(values: readonly string[], allowed: ReadonlySet<string>): boolean {
  return new Set(values).size === values.length && values.every((value) => allowed.has(value));
}

function canonicalDependencies(value: InstalledPluginBundle["compatibility"]["dependencies"]): string {
  return canonicalJson(value.map((dependency) => ({
    plugin_id: dependency.plugin_id,
    namespace: dependency.namespace,
    version_requirement: parseVersionRequirementText(dependency.version_requirement),
    required_capabilities: [...dependency.required_capabilities].sort(compareUtf8Bytes),
  })).sort((left, right) => compareUtf8Bytes(left.plugin_id, right.plugin_id) || compareUtf8Bytes(left.namespace, right.namespace) || compareCanonicalJsonUtf8(left.version_requirement, right.version_requirement)));
}

function authoritativeDigest(operation: () => string): string {
  let digest: unknown;
  try { digest = operation(); } catch { throw sdkError("plugin-sdk:package_digest_mismatch", "Plugin package canonical digest verification failed."); }
  if (typeof digest !== "string" || !DIGEST.test(digest)) throw sdkError("plugin-sdk:package_digest_mismatch", "Plugin package canonical digest authority returned an invalid digest.");
  return digest;
}

function validateBundle(value: unknown, digests: PluginDigestAuthority, policy: PluginDiscoveryPolicy): { readonly bundle: InstalledPluginBundle; readonly analysis_configuration_digest: string } {
  if (!hasExactKeys(value, BUNDLE_KEYS)) throw sdkError("plugin-sdk:package_declaration_invalid", "Plugin package bootstrap declarations must use their closed schema.");
  const bundle = value as unknown as InstalledPluginBundle;
  if (!validateAuthoritativeModel("PluginPackageManifest", bundle.manifest) ||
      !validateAuthoritativeModel("PluginCompatibilityDeclaration", bundle.compatibility) ||
      !validateAuthoritativeModel("PluginRegistryContribution", bundle.contribution) ||
      !Array.isArray(bundle.runtime_builds) || bundle.runtime_builds.length === 0 ||
      !bundle.runtime_builds.every((build) => validateAuthoritativeModel("RuntimeComponentBuild", build)) ||
      !validateAuthoritativeModel("AnalyzerImplementationManifest", bundle.analyzer_implementation_manifest) ||
      !validateAuthoritativeModel("AnalysisConfiguration", bundle.analysis_configuration) ||
      !Array.isArray(bundle.runtime_behavior_manifests) || !bundle.runtime_behavior_manifests.every((manifest) => validateAuthoritativeModel("RuntimeComponentBehaviorManifest", manifest)) ||
      !Array.isArray(bundle.runtime_implementation_manifests) || !bundle.runtime_implementation_manifests.every((manifest) => validateAuthoritativeModel("RuntimeComponentImplementationManifest", manifest))) {
    throw sdkError("plugin-sdk:package_declaration_invalid", "Plugin package bootstrap declarations contain invalid authoritative values.");
  }
  if (typeof bundle.package_locator !== "string" || bundle.package_locator.length === 0 || bundle.manifest.package_format_id !== "core:plugin" || bundle.manifest.package_format_version !== 1 ||
      !NAMESPACED.test(bundle.manifest.plugin_id) || !NAMESPACED.test(bundle.compatibility.plugin_id) ||
      !NAMESPACE.test(bundle.compatibility.namespace) || bundle.compatibility.namespace === "core" ||
      bundle.compatibility.supported_plugin_contract_versions.length === 0 || bundle.compatibility.supported_registry_contract_versions.length === 0 ||
      bundle.compatibility.supported_plugin_contract_versions.some((item) => !Number.isSafeInteger(item) || item <= 0) ||
      bundle.compatibility.supported_registry_contract_versions.some((item) => !Number.isSafeInteger(item) || item <= 0) ||
      new Set(bundle.compatibility.supported_plugin_contract_versions).size !== bundle.compatibility.supported_plugin_contract_versions.length ||
      new Set(bundle.compatibility.supported_registry_contract_versions).size !== bundle.compatibility.supported_registry_contract_versions.length ||
      bundle.compatibility.dependencies.some((dependency) => !NAMESPACED.test(dependency.plugin_id) || !NAMESPACE.test(dependency.namespace) || dependency.version_requirement.length === 0 || !Array.isArray(dependency.required_capabilities) || dependency.required_capabilities.some((capability) => typeof capability !== "string")) ||
      bundle.compatibility.offered_capabilities.some((capability) => !NAMESPACED.test(capability.capability) || capability.version_requirement.length === 0) ||
      canonicalDependencies(bundle.compatibility.dependencies) !== canonicalDependencies(bundle.contribution.dependencies)) {
    throw sdkError("plugin-sdk:package_declaration_invalid", "Plugin package bootstrap declarations contain invalid closed values.");
  }
  const packagePaths = bundle.manifest.package_files.map((entry) => entry.normalized_relative_path);
  if (new Set(packagePaths).size !== packagePaths.length || packagePaths.some((path) => path.length === 0 || path.startsWith("/") || path.includes("\\") || path.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))) {
    throw sdkError("plugin-sdk:package_declaration_invalid", "Plugin package file paths must be normalized, relative, and unique.");
  }
  if (bundle.manifest.package_files.some((entry) => entry.byte_length > policy.max_file_bytes)) throw sdkError("plugin-sdk:package_file_too_large", "Installed plugin package file exceeds the configured discovery byte limit.");
  const expectedPackageDigest = authoritativeDigest(() => digests.plugin_package(bundle.manifest));
  const expectedAnalysisDigest = authoritativeDigest(() => digests.analyzer_implementation(bundle.analyzer_implementation_manifest));
  const expectedDeclarationDigest = authoritativeDigest(() => digests.compatibility_declaration(bundle.compatibility));
  const expectedContributionDigest = authoritativeDigest(() => digests.registry_contribution(bundle.contribution));
  const analysisConfigurationDigest = authoritativeDigest(() => digests.analysis_configuration(bundle.analysis_configuration));
  if (bundle.compatibility.package_digest !== expectedPackageDigest || bundle.compatibility.analysis_digest !== expectedAnalysisDigest ||
      bundle.compatibility.declaration_digest !== expectedDeclarationDigest || bundle.contribution.contribution_digest !== expectedContributionDigest) {
    throw sdkError("plugin-sdk:package_digest_mismatch", "Plugin package registered digests do not match their canonical projections.");
  }
  const allAssetDigests = bundle.manifest.package_files.map((entry) => entry.content_digest);
  const executableAssetDigests = bundle.manifest.package_files.filter((entry) => entry.executable).map((entry) => entry.content_digest);
  const allAssetDigestSet = new Set(allAssetDigests);
  const executableAssetDigestSet = new Set(executableAssetDigests);
  const analyzerAssets = [...bundle.analyzer_implementation_manifest.executable_asset_digests, ...bundle.analyzer_implementation_manifest.parser_asset_digests,
    ...bundle.analyzer_implementation_manifest.rule_asset_digests, ...bundle.analyzer_implementation_manifest.model_asset_digests, ...bundle.analyzer_implementation_manifest.dependency_asset_digests];
  if (bundle.analyzer_implementation_manifest.plugin_id !== bundle.manifest.plugin_id || bundle.analyzer_implementation_manifest.plugin_version !== bundle.manifest.plugin_version ||
      !sameSet(bundle.analyzer_implementation_manifest.executable_asset_digests, executableAssetDigests) || !sameSet(analyzerAssets, allAssetDigests) ||
      !sameSet(bundle.analyzer_implementation_manifest.supported_capabilities, bundle.compatibility.offered_capabilities.map((capability) => capability.capability))) {
    throw sdkError("plugin-sdk:package_coordinate_mismatch", "Plugin analyzer implementation coordinates or asset closure do not match.");
  }
  const buildIds = new Set<string>();
  const behaviorKeys = bundle.runtime_behavior_manifests.map((manifest) => `${manifest.component_id}\u0000${manifest.component_version}`);
  const requiredBehaviorKeys = [...new Set(bundle.runtime_builds.map((build) => `${build.component_id}\u0000${build.component_version}`))];
  if (new Set(behaviorKeys).size !== behaviorKeys.length) {
    throw sdkError("plugin-sdk:package_declaration_invalid", "Plugin runtime behavior manifests must supply each built component release exactly once.");
  }
  if (!sameSet(behaviorKeys, requiredBehaviorKeys)) throw sdkError("plugin-sdk:package_coordinate_mismatch", "Plugin runtime behavior manifest coordinates must match built component releases.");
  for (const build of bundle.runtime_builds) {
    if (buildIds.has(build.runtime_component_build_id) || build.runtime_component_build_id.length === 0 || !NAMESPACED.test(build.component_id) || build.schema_version !== 1) throw sdkError("plugin-sdk:package_declaration_invalid", "Plugin runtime build identities must be unique and authoritative.");
    buildIds.add(build.runtime_component_build_id);
    const definition = bundle.contribution.runtime_component_definitions.find((candidate) => candidate.component_id === build.component_id && candidate.component_version === build.component_version);
    const behavior = bundle.runtime_behavior_manifests.find((candidate) => candidate.component_id === build.component_id && candidate.component_version === build.component_version);
    const implementation = bundle.runtime_implementation_manifests.find((candidate) => candidate.runtime_component_build_id === build.runtime_component_build_id);
    if (!definition || !behavior || !implementation || implementation.component_id !== build.component_id || implementation.component_version !== build.component_version) {
      throw sdkError("plugin-sdk:package_coordinate_mismatch", "Plugin runtime build coordinates do not match their authoritative manifests.");
    }
    const implementationAssets = [...implementation.executable_asset_digests, ...implementation.native_asset_digests, ...implementation.dependency_asset_digests];
    if (implementation.behavior_digest !== build.behavior_digest || authoritativeDigest(() => digests.runtime_behavior(behavior)) !== build.behavior_digest || authoritativeDigest(() => digests.runtime_implementation(implementation)) !== build.implementation_digest || definition.behavior_digest !== build.behavior_digest ||
        canonicalJson([...behavior.contract_bindings].sort(compareCanonicalJsonUtf8)) !== canonicalJson([...definition.component_contracts].sort(compareCanonicalJsonUtf8)) ||
        !definition.component_contracts.some((binding) => binding.component_kind === behavior.component_kind) ||
        implementation.executable_asset_digests.length === 0 || !uniqueSubset(implementation.executable_asset_digests, executableAssetDigestSet) ||
        !uniqueSubset(implementationAssets, allAssetDigestSet)) {
      throw sdkError("plugin-sdk:package_digest_mismatch", "Plugin runtime build digests or executable closure do not match their canonical projections.");
    }
  }
  if (bundle.runtime_implementation_manifests.length !== buildIds.size || bundle.runtime_implementation_manifests.some((manifest) => !buildIds.has(manifest.runtime_component_build_id)) ||
      bundle.runtime_behavior_manifests.some((manifest) => !bundle.contribution.runtime_component_definitions.some((definition) => definition.component_id === manifest.component_id && definition.component_version === manifest.component_version))) {
    throw sdkError("plugin-sdk:package_declaration_invalid", "Plugin runtime manifest identities must exactly match the declared builds.");
  }
  return { bundle, analysis_configuration_digest: analysisConfigurationDigest };
}

async function discovered(bundle: InstalledPluginBundle, analysisConfigurationDigest: string, rootId: string, port: PluginPackageDiscoveryPort, policy: PluginDiscoveryPolicy): Promise<DiscoveredPluginPackage> {
  const coordinate = `${bundle.manifest.plugin_id}@${bundle.manifest.plugin_version}`;
  if (bundle.compatibility.plugin_id !== bundle.manifest.plugin_id || bundle.compatibility.plugin_version !== bundle.manifest.plugin_version ||
      bundle.contribution.plugin_id !== bundle.manifest.plugin_id || bundle.contribution.plugin_version !== bundle.manifest.plugin_version ||
      bundle.compatibility.namespace !== bundle.contribution.namespace ||
      bundle.runtime_builds.some((build) => !bundle.contribution.runtime_component_definitions.some((definition) => definition.component_id === build.component_id && definition.component_version === build.component_version && definition.behavior_digest === build.behavior_digest))) {
    throw sdkError("plugin-sdk:package_coordinate_mismatch", "Plugin package bootstrap coordinates do not match.", { coordinate });
  }
  for (const entry of bundle.manifest.package_files) {
    let bytes: Uint8Array;
    try {
      const raw = await port.read_file({ root_id: rootId, package_locator: bundle.package_locator, normalized_relative_path: entry.normalized_relative_path, expected_byte_length: entry.byte_length, max_bytes: policy.max_file_bytes });
      if (!hasExactKeys(raw, ["bytes", "byte_length"])) throw new Error("invalid bounded read");
      const byteLength = raw.byte_length;
      const rawBytes = raw.bytes;
      if (!Number.isSafeInteger(byteLength) || byteLength !== entry.byte_length || byteLength > policy.max_file_bytes || !(rawBytes instanceof Uint8Array) || rawBytes.byteLength !== byteLength || rawBytes.byteLength > policy.max_file_bytes) throw new Error("invalid bounded read");
      bytes = new Uint8Array(rawBytes);
    } catch {
      throw sdkError("plugin-sdk:package_discovery_failed", "Installed plugin package bytes could not be read safely.");
    }
    if (sha256Bytes(bytes) !== entry.content_digest) {
      throw sdkError("plugin-sdk:package_digest_mismatch", "Installed plugin package bytes do not match the closed package manifest.");
    }
  }
  const { package_locator: _packageLocator, ...installed } = bundle;
  return deepFreeze({
    ...installed,
    plugin_id: bundle.manifest.plugin_id,
    plugin_version: bundle.manifest.plugin_version,
    namespace: bundle.compatibility.namespace,
    package_digest: bundle.compatibility.package_digest,
    declaration_digest: bundle.compatibility.declaration_digest,
    contribution_digest: bundle.contribution.contribution_digest,
    analysis_configuration_digest: analysisConfigurationDigest,
  });
}

export class PluginPackageDiscovery {
  constructor(
    private readonly port: PluginPackageDiscoveryPort,
    private readonly digests: PluginDigestAuthority,
    private readonly policy: PluginDiscoveryPolicy,
    private readonly materialization_limits: PortMaterializationLimits,
  ) {}

  async discover(root_ids: readonly string[]): Promise<PluginDiscoveryResult> {
    if (!Number.isSafeInteger(this.policy.max_file_bytes) || this.policy.max_file_bytes < 0) throw sdkError("plugin-sdk:package_declaration_invalid", "Plugin discovery byte policy must be a non-negative safe integer.");
    try { materializePortResult(null, this.materialization_limits); } catch { throw sdkError("plugin-sdk:package_declaration_invalid", "Plugin discovery materialization limits must be explicit and valid."); }
    if (!Array.isArray(root_ids) || root_ids.some((rootId) => typeof rootId !== "string")) throw sdkError("plugin-sdk:package_declaration_invalid", "Plugin discovery roots must be a text array.");
    const packages: DiscoveredPluginPackage[] = [];
    const exact = new Set<string>();
    for (const rootId of root_ids) {
      let rawBundles: unknown;
      try { rawBundles = await this.port.list(rootId); } catch (error) {
        throw sdkError("plugin-sdk:package_discovery_failed", "A configured plugin package root could not be read.");
      }
      let bundles: unknown;
      try { bundles = materializePortResult(rawBundles, this.materialization_limits); } catch { throw sdkError("plugin-sdk:package_declaration_invalid", "Plugin discovery port values could not be safely materialized."); }
      if (!Array.isArray(bundles)) throw sdkError("plugin-sdk:package_declaration_invalid", "Plugin discovery ports must return a bundle array.");
      for (const bundle of bundles) {
        const validated = validateBundle(bundle, this.digests, this.policy);
        const item = await discovered(validated.bundle, validated.analysis_configuration_digest, rootId, this.port, this.policy);
        const exactKey = `${item.plugin_id}\u0000${item.plugin_version}\u0000${item.package_digest}`;
        if (!exact.has(exactKey)) { exact.add(exactKey); packages.push(item); }
      }
    }
    packages.sort((left, right) => compareUtf8Bytes(left.plugin_id, right.plugin_id) || compareUtf8Bytes(left.plugin_version, right.plugin_version) || compareUtf8Bytes(left.package_digest, right.package_digest));
    const coordinates = new Map<string, DiscoveredPluginPackage[]>();
    for (const item of packages) {
      const key = `${item.plugin_id}\u0000${item.plugin_version}`;
      coordinates.set(key, [...(coordinates.get(key) ?? []), item]);
    }
    const collision_candidates = [...coordinates.values()].filter((items) => items.length > 1).map((items) => ({
      plugin_id: items[0]!.plugin_id,
      plugin_version: items[0]!.plugin_version,
      package_digests: items.map((item) => item.package_digest).sort(compareUtf8Bytes),
    }));
    return deepFreeze({ packages, collision_candidates });
  }
}
