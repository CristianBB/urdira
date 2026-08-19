import type { JsonValue, PluginCompatibilityIssue, PluginResolutionLock, ResolvedPlugin } from "@urdira/contracts";
import { canonicalJson, deepFreeze, hasExactKeys } from "./canonical.js";
import type { PluginDigestAuthority, PluginResolutionLockDigestInput } from "./digest-authority.js";
import { compareUtf8Bytes } from "./ordering.js";
import type { DiscoveredPluginPackage } from "./packages.js";
import { compareSemVerPrecedence, normalizeVersionRequirement, parseSemVer, parseVersionRequirementText, satisfiesVersionRequirement, type StructuredVersionRequirement } from "./semver.js";

export interface PluginResolutionRequirement {
  readonly plugin_id: string;
  readonly version_requirement: StructuredVersionRequirement;
  readonly required_capabilities?: readonly string[];
}
export interface PluginResolutionPin { readonly plugin_id: string; readonly plugin_version: string; readonly package_digest: string; }
export interface PluginResolutionInput {
  readonly packages: readonly DiscoveredPluginPackage[];
  readonly requirements: readonly PluginResolutionRequirement[];
  readonly pins: readonly PluginResolutionPin[];
  readonly supported_runtime_contract_versions: readonly number[];
  readonly supported_registry_contract_versions: readonly number[];
  readonly existing_lock?: SdkPluginResolutionLock;
  readonly workspace_id: string;
  readonly resolver_version: string;
  readonly clock: (() => string) | { now(): string };
  readonly id_source: (() => string) | { next(): string };
}

export type SdkResolvedPlugin = ResolvedPlugin;
export type SdkPluginResolutionLock = PluginResolutionLock;
export type PluginResolutionResult =
  | {
      readonly ok: true;
      readonly lock: SdkPluginResolutionLock;
      readonly packages: readonly DiscoveredPluginPackage[];
      /**
       * `true` when `lock` is the caller-supplied `existing_lock` returned
       * verbatim (byte-identical, including its original `created_at`);
       * absent/`false` when this is a freshly solved lock (either no
       * existing lock was supplied, or the supplied one was authentic but
       * no longer preservable against the current packages/input -- see
       * `preserveExistingLock`'s "stale" outcome below). Callers that mint
       * lock-derived downstream ids (registry snapshot, configuration
       * revision) need this to know whether those ids must also change.
       */
      readonly preserved_existing_lock?: boolean;
    }
  | { readonly ok: false; readonly issues: readonly PluginCompatibilityIssue[] };

type Constraint = { readonly requirement: StructuredVersionRequirement; readonly required_capabilities: readonly string[]; readonly namespace?: string; readonly declaring_plugin_id?: string };
type SearchFailure = { readonly code: "PLUGIN_NAMESPACE_CONFLICT" | "PLUGIN_VERSION_CONFLICT" | "PLUGIN_DEPENDENCY_CYCLE" | "PLUGIN_CAPABILITY_UNAVAILABLE" | "PLUGIN_CONTRACT_INCOMPATIBLE" | "REGISTRY_CONTRACT_INCOMPATIBLE"; readonly plugin_ids: readonly string[]; readonly payload: JsonValue };

const COMPATIBILITY_ISSUE_METADATA = {
  PLUGIN_NAMESPACE_CONFLICT: { phase: "resolution", severity: "error", required_action: "resolve_namespace_conflict", retryable: "false" },
  PLUGIN_VERSION_CONFLICT: { phase: "resolution", severity: "error", required_action: "select_compatible_version", retryable: "false" },
  PLUGIN_DEPENDENCY_CYCLE: { phase: "resolution", severity: "error", required_action: "remove_dependency_cycle", retryable: "false" },
  PLUGIN_CAPABILITY_UNAVAILABLE: { phase: "negotiation", severity: "error", required_action: "install_capability_provider", retryable: "false" },
  PLUGIN_CONTRACT_INCOMPATIBLE: { phase: "negotiation", severity: "error", required_action: "update_plugin_or_engine", retryable: "false" },
  REGISTRY_CONTRACT_INCOMPATIBLE: { phase: "negotiation", severity: "error", required_action: "update_plugin_or_engine", retryable: "false" },
} as const satisfies Readonly<Record<SearchFailure["code"], { readonly phase: string; readonly severity: "error"; readonly required_action: string; readonly retryable: "false" }>>;

function sourceValue(source: (() => string) | { now(): string } | { next(): string }): string {
  if (typeof source === "function") return source();
  if ("now" in source) return source.now();
  return source.next();
}
function positiveVersions(values: readonly number[]): number[] {
  return [...new Set(values.filter((item) => Number.isSafeInteger(item) && item > 0))].sort((left, right) => right - left);
}
function compatibilityIssue(input: PluginResolutionInput, failure: SearchFailure): PluginCompatibilityIssue {
  const metadata = COMPATIBILITY_ISSUE_METADATA[failure.code];
  return deepFreeze({ issue_id: sourceValue(input.id_source), code: failure.code, ...metadata,
    plugin_ids: [...failure.plugin_ids].sort(compareUtf8Bytes), definition_references: [], requirement_references: [],
    summary: "Plugin resolution could not produce one exact compatible graph.", payload: failure.payload,
    created_at: sourceValue(input.clock) });
}

function textRequirement(value: string): StructuredVersionRequirement {
  return parseVersionRequirementText(value);
}

function requiredCapability(value: string): { capability: string; requirement: StructuredVersionRequirement } {
  const separator = value.lastIndexOf("@");
  return separator > value.indexOf(":") ? { capability: value.slice(0, separator), requirement: textRequirement(value.slice(separator + 1)) } : { capability: value, requirement: textRequirement("*") };
}
function capabilityAvailable(candidate: DiscoveredPluginPackage, required: string): boolean {
  const parsed = requiredCapability(required);
  return candidate.compatibility.offered_capabilities.some((offered) => {
    if (offered.capability !== parsed.capability) return false;
    try {
      const offeredRequirement = textRequirement(offered.version_requirement);
      return requirementsIntersect(offeredRequirement, parsed.requirement);
    } catch { return false; }
  });
}
function requirementsIntersect(left: StructuredVersionRequirement, right: StructuredVersionRequirement): boolean {
  return left.alternatives.some((leftInterval) => right.alternatives.some((rightInterval) => {
    const lowerCandidates = [leftInterval.minimum === undefined ? undefined : { version: leftInterval.minimum, inclusive: leftInterval.minimum_inclusive === true }, rightInterval.minimum === undefined ? undefined : { version: rightInterval.minimum, inclusive: rightInterval.minimum_inclusive === true }].filter((item): item is { version: string; inclusive: boolean } => item !== undefined);
    const upperCandidates = [leftInterval.maximum === undefined ? undefined : { version: leftInterval.maximum, inclusive: leftInterval.maximum_inclusive === true }, rightInterval.maximum === undefined ? undefined : { version: rightInterval.maximum, inclusive: rightInterval.maximum_inclusive === true }].filter((item): item is { version: string; inclusive: boolean } => item !== undefined);
    const lowerValue = lowerCandidates.sort((a, b) => compareSemVerPrecedence(b.version, a.version))[0];
    const upperValue = upperCandidates.sort((a, b) => compareSemVerPrecedence(a.version, b.version))[0];
    const lower = lowerValue === undefined ? undefined : { version: lowerValue.version, inclusive: lowerCandidates.filter((item) => compareSemVerPrecedence(item.version, lowerValue.version) === 0).every((item) => item.inclusive) };
    const upper = upperValue === undefined ? undefined : { version: upperValue.version, inclusive: upperCandidates.filter((item) => compareSemVerPrecedence(item.version, upperValue.version) === 0).every((item) => item.inclusive) };
    if (lower && upper) {
      const order = compareSemVerPrecedence(lower.version, upper.version);
      if (order > 0 || order === 0 && (!lower.inclusive || !upper.inclusive)) return false;
    }
    const candidate = (() => {
      if (!lower) return "0.0.0";
      const parsedLower = parseSemVer(lower.version);
      const stable = `${String(parsedLower.major)}.${String(parsedLower.minor)}.${String(parsedLower.patch)}`;
      if (!(left.allow_prerelease && right.allow_prerelease)) {
        if (parsedLower.prerelease.length > 0 || lower.inclusive) return stable;
        return `${String(parsedLower.major)}.${String(parsedLower.minor)}.${BigInt(String(parsedLower.patch)) + 1n}`;
      }
      if (lower.inclusive) return lower.version;
      if (parsedLower.prerelease.length > 0) return `${lower.version.split("+")[0]!}.0`;
      return `${String(parsedLower.major)}.${String(parsedLower.minor)}.${BigInt(String(parsedLower.patch)) + 1n}-0`;
    })();
    if (!upper) return true;
    const order = compareSemVerPrecedence(candidate, upper.version);
    return order < 0 || order === 0 && upper.inclusive;
  }));
}
function compatibleBuilds(candidate: DiscoveredPluginPackage, contract: number) {
  return candidate.runtime_builds.filter((build) => candidate.contribution.runtime_component_definitions.some((definition) =>
    definition.component_id === build.component_id && definition.component_version === build.component_version && definition.component_contracts.some((binding) => Number(binding.contract_version) === contract),
  )).sort((left, right) => compareUtf8Bytes(left.runtime_component_build_id, right.runtime_component_build_id));
}
function detectCycle(selected: ReadonlyMap<string, DiscoveredPluginPackage>): SearchFailure | undefined {
  const visited = new Set<string>(); const active = new Set<string>();
  const visit = (pluginId: string): SearchFailure | undefined => {
    if (active.has(pluginId)) return { code: "PLUGIN_DEPENDENCY_CYCLE", plugin_ids: [...active, pluginId], payload: { repeated_endpoint: pluginId } };
    if (visited.has(pluginId)) return undefined;
    active.add(pluginId);
    for (const dependency of selected.get(pluginId)?.compatibility.dependencies ?? []) { const found = visit(dependency.plugin_id); if (found) return found; }
    active.delete(pluginId); visited.add(pluginId); return undefined;
  };
  for (const pluginId of [...selected.keys()].sort(compareUtf8Bytes)) { const found = visit(pluginId); if (found) return found; }
  return undefined;
}

function solveGraph(input: PluginResolutionInput, runtimeContract: number, registryContract: number): { selected?: Map<string, DiscoveredPluginPackage>; failure?: SearchFailure } {
  const available = new Map<string, DiscoveredPluginPackage[]>();
  for (const item of input.packages) available.set(item.plugin_id, [...(available.get(item.plugin_id) ?? []), item]);
  const constraints = new Map<string, Constraint[]>();
  for (const requirement of input.requirements) constraints.set(requirement.plugin_id, [...(constraints.get(requirement.plugin_id) ?? []), { requirement: normalizeVersionRequirement(requirement.version_requirement), required_capabilities: requirement.required_capabilities ?? [] }]);
  const selected = new Map<string, DiscoveredPluginPackage>(); let lastFailure: SearchFailure | undefined;
  const search = (current: Map<string, Constraint[]>): boolean => {
    const unresolved = [...current.keys()].filter((id) => !selected.has(id)).sort(compareUtf8Bytes)[0];
    if (unresolved === undefined) { const cycle = detectCycle(selected); if (cycle) { lastFailure = cycle; return false; } return true; }
    const requirements = current.get(unresolved)!; const pin = input.pins.find((item) => item.plugin_id === unresolved);
    const candidates = (available.get(unresolved) ?? []).filter((candidate) =>
      candidate.compatibility.supported_plugin_contract_versions.includes(runtimeContract) && candidate.compatibility.supported_registry_contract_versions.includes(registryContract) &&
      compatibleBuilds(candidate, runtimeContract).length > 0 && candidate.contribution.registry_contract_version === `${String(registryContract)}.0.0` &&
      requirements.every((constraint) => satisfiesVersionRequirement(candidate.plugin_version, constraint.requirement)) && (!pin || candidate.plugin_version === pin.plugin_version && candidate.package_digest === pin.package_digest));
    candidates.sort((left, right) => compareSemVerPrecedence(right.plugin_version, left.plugin_version) || compareUtf8Bytes(left.plugin_version, right.plugin_version) || compareUtf8Bytes(left.package_digest, right.package_digest));
    if (!pin && candidates.length > 1 && compareSemVerPrecedence(candidates[0]!.plugin_version, candidates[1]!.plugin_version) === 0) { lastFailure = { code: "PLUGIN_VERSION_CONFLICT", plugin_ids: [unresolved], payload: { plugin_id: unresolved, ambiguous: true } }; return false; }
    if (candidates.length === 0) { lastFailure = { code: "PLUGIN_VERSION_CONFLICT", plugin_ids: [unresolved], payload: { plugin_id: unresolved } }; return false; }
    for (const candidate of candidates) {
      const owner = [...selected.values()].find((item) => item.namespace === candidate.namespace && item.plugin_id !== candidate.plugin_id);
      if (owner) { lastFailure = { code: "PLUGIN_NAMESPACE_CONFLICT", plugin_ids: [owner.plugin_id, candidate.plugin_id], payload: { namespace: candidate.namespace } }; continue; }
      const mismatch = requirements.find((item) => item.namespace !== undefined && item.namespace !== candidate.namespace);
      if (mismatch) { lastFailure = { code: "PLUGIN_NAMESPACE_CONFLICT", plugin_ids: [mismatch.declaring_plugin_id ?? candidate.plugin_id, candidate.plugin_id], payload: { namespace: candidate.namespace } }; continue; }
      const missing = requirements.flatMap((item) => item.required_capabilities).find((capability) => !capabilityAvailable(candidate, capability));
      if (missing) { lastFailure = { code: "PLUGIN_CAPABILITY_UNAVAILABLE", plugin_ids: [candidate.plugin_id], payload: { capability: missing } }; continue; }
      selected.set(unresolved, candidate);
      const next = new Map([...current].map(([id, items]) => [id, [...items]])); let compatible = true;
      for (const dependency of candidate.compatibility.dependencies) {
        let requirement: StructuredVersionRequirement;
        try { requirement = textRequirement(dependency.version_requirement); } catch { lastFailure = { code: "PLUGIN_VERSION_CONFLICT", plugin_ids: [candidate.plugin_id, dependency.plugin_id], payload: { plugin_id: dependency.plugin_id } }; compatible = false; break; }
        const constraint = { requirement, required_capabilities: dependency.required_capabilities, namespace: dependency.namespace, declaring_plugin_id: candidate.plugin_id };
        next.set(dependency.plugin_id, [...(next.get(dependency.plugin_id) ?? []), constraint]);
        const existing = selected.get(dependency.plugin_id);
        if (existing && (existing.namespace !== dependency.namespace || !satisfiesVersionRequirement(existing.plugin_version, requirement) || dependency.required_capabilities.some((capability) => !capabilityAvailable(existing, capability)))) {
          compatible = false; lastFailure = { code: existing.namespace !== dependency.namespace ? "PLUGIN_NAMESPACE_CONFLICT" : dependency.required_capabilities.some((capability) => !capabilityAvailable(existing, capability)) ? "PLUGIN_CAPABILITY_UNAVAILABLE" : "PLUGIN_VERSION_CONFLICT", plugin_ids: [candidate.plugin_id, dependency.plugin_id], payload: { plugin_id: dependency.plugin_id } }; break;
        }
      }
      if (compatible && search(next)) return true;
      selected.delete(unresolved);
    }
    return false;
  };
  return search(constraints) ? { selected } : { failure: lastFailure ?? { code: "PLUGIN_VERSION_CONFLICT", plugin_ids: [], payload: {} } };
}

function lockDigestInput(lock: Pick<SdkPluginResolutionLock, "resolution_lock_id" | "workspace_id" | "resolver_version" | "resolved_plugins">): PluginResolutionLockDigestInput {
  return { resolution_lock_id: lock.resolution_lock_id, workspace_id: lock.workspace_id, resolver_version: lock.resolver_version, resolved_plugins: lock.resolved_plugins };
}

function contractNumber(value: string): number | undefined {
  const match = /^([1-9]\d*)\.0\.0$/u.exec(value);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

const LOCK_KEYS = ["resolution_lock_id", "workspace_id", "resolver_version", "resolved_plugins", "lock_digest", "created_at"] as const;
const RESOLVED_PLUGIN_KEYS = [
  "plugin_id", "plugin_version", "namespace", "package_digest", "declaration_digest", "contribution_digest", "analysis_digest",
  "analysis_configuration_digest", "plugin_contract_version", "registry_contract_version", "resolved_dependency_plugin_ids", "effective_capabilities",
] as const;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const NAMESPACED = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/u;
const NAMESPACE = /^[a-z][a-z0-9_]*$/u;

function validSemVer(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { parseSemVer(value); return true; } catch { return false; }
}

function materializeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const length = value.length;
  const keys = Object.keys(value);
  if (keys.length !== length || keys.some((key, index) => key !== String(index))) return undefined;
  const result: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = value[index];
    if (typeof item !== "string" || item.length === 0) return undefined;
    result.push(item);
  }
  return new Set(result).size === result.length ? result : undefined;
}

function materializeResolvedPlugin(value: unknown): ResolvedPlugin | undefined {
  if (!hasExactKeys(value, RESOLVED_PLUGIN_KEYS)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const pluginId = value["plugin_id"];
  const pluginVersion = value["plugin_version"];
  const namespace = value["namespace"];
  const packageDigest = value["package_digest"];
  const declarationDigest = value["declaration_digest"];
  const contributionDigest = value["contribution_digest"];
  const analysisDigest = value["analysis_digest"];
  const analysisConfigurationDigest = value["analysis_configuration_digest"];
  const pluginContractVersion = value["plugin_contract_version"];
  const registryContractVersion = value["registry_contract_version"];
  const dependencyIds = materializeStringArray(value["resolved_dependency_plugin_ids"]);
  const capabilities = materializeStringArray(value["effective_capabilities"]);
  if (typeof pluginId !== "string" || !NAMESPACED.test(pluginId) || !validSemVer(pluginVersion) || typeof namespace !== "string" || !NAMESPACE.test(namespace) || namespace === "core" ||
      typeof packageDigest !== "string" || !DIGEST.test(packageDigest) || typeof declarationDigest !== "string" || !DIGEST.test(declarationDigest) ||
      typeof contributionDigest !== "string" || !DIGEST.test(contributionDigest) || typeof analysisDigest !== "string" || !DIGEST.test(analysisDigest) ||
      typeof analysisConfigurationDigest !== "string" || !DIGEST.test(analysisConfigurationDigest) || typeof pluginContractVersion !== "string" || contractNumber(pluginContractVersion) === undefined ||
      typeof registryContractVersion !== "string" || contractNumber(registryContractVersion) === undefined || !dependencyIds || dependencyIds.some((item) => !NAMESPACED.test(item)) ||
      !capabilities || capabilities.some((item) => !NAMESPACED.test(item))) return undefined;
  return { plugin_id: pluginId, plugin_version: pluginVersion, namespace, package_digest: packageDigest, declaration_digest: declarationDigest,
    contribution_digest: contributionDigest, analysis_digest: analysisDigest, analysis_configuration_digest: analysisConfigurationDigest,
    plugin_contract_version: pluginContractVersion, registry_contract_version: registryContractVersion,
    resolved_dependency_plugin_ids: dependencyIds, effective_capabilities: capabilities };
}

function materializeExistingLock(value: unknown): SdkPluginResolutionLock | undefined {
  try {
    if (!hasExactKeys(value, LOCK_KEYS)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const resolutionLockId = value["resolution_lock_id"];
    const workspaceId = value["workspace_id"];
    const resolverVersion = value["resolver_version"];
    const rawPlugins = value["resolved_plugins"];
    const lockDigestValue = value["lock_digest"];
    const createdAt = value["created_at"];
    if (typeof resolutionLockId !== "string" || resolutionLockId.length === 0 || typeof workspaceId !== "string" || workspaceId.length === 0 ||
        !validSemVer(resolverVersion) || !Array.isArray(rawPlugins) || typeof lockDigestValue !== "string" || !DIGEST.test(lockDigestValue) ||
        typeof createdAt !== "string" || createdAt.length === 0) return undefined;
    const length = rawPlugins.length;
    if (length === 0) return undefined;
    const keys = Object.keys(rawPlugins);
    if (keys.length !== length || keys.some((key, index) => key !== String(index))) return undefined;
    const resolvedPlugins: ResolvedPlugin[] = [];
    for (let index = 0; index < length; index += 1) {
      const plugin = materializeResolvedPlugin(rawPlugins[index]);
      if (!plugin) return undefined;
      resolvedPlugins.push(plugin);
    }
    if (new Set(resolvedPlugins.map((item) => item.plugin_id)).size !== resolvedPlugins.length) return undefined;
    return { resolution_lock_id: resolutionLockId, workspace_id: workspaceId, resolver_version: resolverVersion, resolved_plugins: resolvedPlugins,
      lock_digest: lockDigestValue, created_at: createdAt };
  } catch {
    return undefined;
  }
}

function lockDigest(digests: PluginDigestAuthority, value: PluginResolutionLockDigestInput): string | undefined {
  try {
    const digest = digests.resolution_lock(value);
    return /^sha256:[0-9a-f]{64}$/u.test(digest) ? digest : undefined;
  } catch { return undefined; }
}

/**
 * `preserveExistingLock`'s outcome is one of three kinds, which
 * `PluginResolver.resolve` treats very differently:
 *
 *  - `"preserved"`: the supplied `existing_lock` is authentic (well-formed,
 *    correctly self-digested, scoped to this workspace, internally
 *    namespace-consistent) AND still matches the currently installed
 *    packages/input exactly -- returned verbatim, `created_at` included.
 *  - `"invalid"`: the supplied lock is NOT authentic -- malformed/unknown
 *    fields, a throwing getter, wrong workspace, a tampered `lock_digest`,
 *    duplicate `plugin_id`s, or a namespace collision *within the lock
 *    itself*. This can only happen via tampering, corruption, or a foreign
 *    lock, never as the natural result of a legitimate plugin upgrade --
 *    `PluginResolver.resolve` hard-fails closed on this, unchanged from
 *    before this type split existed.
 *  - `"stale"`: the supplied lock is authentic but no longer matches the
 *    CURRENT environment -- an unsupported contract version, an installed
 *    package whose id/version/digests moved out from under the lock (e.g. a
 *    plugin rebuild changing `analysis_digest`), a dependency/capability/pin
 *    mismatch, or a cycle. This is the expected shape of a plugin upgrade
 *    (docs/decisions/09's upgrade clause): `PluginResolver.resolve` falls
 *    through to fresh graph resolution instead of hard-failing.
 */
type PreserveExistingLockResult =
  | { readonly kind: "preserved"; readonly result: Extract<PluginResolutionResult, { readonly ok: true }> }
  | { readonly kind: "invalid" }
  | { readonly kind: "stale" };

function preserveExistingLock(input: PluginResolutionInput, digests: PluginDigestAuthority, lock: SdkPluginResolutionLock | undefined): PreserveExistingLockResult {
  if (!lock || lock.workspace_id !== input.workspace_id) return { kind: "invalid" };
  if (lockDigest(digests, lockDigestInput(lock)) !== lock.lock_digest || new Set(lock.resolved_plugins.map((item) => item.plugin_id)).size !== lock.resolved_plugins.length) return { kind: "invalid" };
  const namespaceOwners = new Map<string, string>();
  for (const locked of lock.resolved_plugins) {
    const owner = namespaceOwners.get(locked.namespace);
    if (owner !== undefined && owner !== locked.plugin_id) return { kind: "invalid" };
    namespaceOwners.set(locked.namespace, locked.plugin_id);
  }
  // Everything below validates the now-authenticated lock against the
  // CURRENT environment (installed packages, supported contracts,
  // requirements, pins). Failing any of these means the lock is merely
  // stale -- not tampered -- so a failure here falls through to fresh
  // resolution rather than hard-failing.
  const runtimeContracts = new Set(lock.resolved_plugins.map((item) => contractNumber(item.plugin_contract_version)));
  const registryContracts = new Set(lock.resolved_plugins.map((item) => contractNumber(item.registry_contract_version)));
  if (runtimeContracts.size !== 1 || registryContracts.size !== 1 || [...runtimeContracts].some((item) => item === undefined || !input.supported_runtime_contract_versions.includes(item)) ||
      [...registryContracts].some((item) => item === undefined || !input.supported_registry_contract_versions.includes(item))) return { kind: "stale" };
  const packages: DiscoveredPluginPackage[] = [];
  for (const locked of lock.resolved_plugins) {
    const item = input.packages.find((candidate) => candidate.plugin_id === locked.plugin_id && candidate.plugin_version === locked.plugin_version && candidate.package_digest === locked.package_digest);
    if (!item || item.namespace !== locked.namespace || item.declaration_digest !== locked.declaration_digest || item.contribution_digest !== locked.contribution_digest ||
        item.compatibility.analysis_digest !== locked.analysis_digest || item.analysis_configuration_digest !== locked.analysis_configuration_digest ||
        !item.compatibility.supported_plugin_contract_versions.includes(contractNumber(locked.plugin_contract_version) ?? -1) ||
        !item.compatibility.supported_registry_contract_versions.includes(contractNumber(locked.registry_contract_version) ?? -1) ||
        item.contribution.registry_contract_version !== locked.registry_contract_version ||
        canonicalJson([...item.compatibility.dependencies.map((dependency) => dependency.plugin_id)].sort(compareUtf8Bytes)) !== canonicalJson([...locked.resolved_dependency_plugin_ids].sort(compareUtf8Bytes)) ||
        canonicalJson([...item.compatibility.offered_capabilities.map((capability) => capability.capability)].sort(compareUtf8Bytes)) !== canonicalJson([...locked.effective_capabilities].sort(compareUtf8Bytes))) return { kind: "stale" };
    packages.push(item);
  }
  const selected = new Map(packages.map((item) => [item.plugin_id, item]));
  if (detectCycle(selected)) return { kind: "stale" };
  for (const item of packages) for (const dependency of item.compatibility.dependencies) {
    const dependencyPackage = selected.get(dependency.plugin_id);
    if (!dependencyPackage || dependencyPackage.namespace !== dependency.namespace || !satisfiesVersionRequirement(dependencyPackage.plugin_version, textRequirement(dependency.version_requirement)) || dependency.required_capabilities.some((capability) => !capabilityAvailable(dependencyPackage, capability))) return { kind: "stale" };
  }
  for (const requirement of input.requirements) {
    const item = selected.get(requirement.plugin_id);
    if (!item || !satisfiesVersionRequirement(item.plugin_version, normalizeVersionRequirement(requirement.version_requirement)) || (requirement.required_capabilities ?? []).some((capability) => !capabilityAvailable(item, capability))) return { kind: "stale" };
  }
  for (const pin of input.pins) {
    const item = selected.get(pin.plugin_id);
    const locked = lock.resolved_plugins.find((candidate) => candidate.plugin_id === pin.plugin_id);
    if (!item || !locked || item.plugin_version !== pin.plugin_version || item.package_digest !== pin.package_digest) return { kind: "stale" };
  }
  return { kind: "preserved", result: deepFreeze({ ok: true, lock, packages: packages.sort((left, right) => compareUtf8Bytes(left.plugin_id, right.plugin_id)), preserved_existing_lock: true }) };
}

export class PluginResolver {
  constructor(private readonly digests: PluginDigestAuthority) {}

  resolve(input: PluginResolutionInput): PluginResolutionResult {
    let rawExistingLock: unknown;
    try { rawExistingLock = input.existing_lock; } catch { rawExistingLock = null; }
    const hasExistingLock = rawExistingLock !== undefined;
    const existingLock = hasExistingLock ? materializeExistingLock(rawExistingLock) : undefined;
    const preservation = preserveExistingLock(input, this.digests, existingLock);
    if (preservation.kind === "preserved") return preservation.result;
    // "invalid" (tampered/foreign/malformed) hard-fails closed, but only
    // when a lock was actually supplied -- an absent `existing_lock`
    // trivially reaches `preserveExistingLock`'s `!lock` guard (also
    // categorized "invalid"), which must fall through to a genuine fresh
    // resolution below, not report a bogus tampering failure. "stale"
    // (authentic but no longer matches the current environment -- the
    // ordinary result of a plugin upgrade) always falls through, whether or
    // not a lock was supplied.
    if (hasExistingLock && preservation.kind === "invalid") return deepFreeze({ ok: false, issues: [compatibilityIssue(input, { code: "PLUGIN_VERSION_CONFLICT", plugin_ids: existingLock?.resolved_plugins.map((item) => item.plugin_id) ?? [], payload: { existing_lock_invalid: true } })] });
    const runtime = positiveVersions(input.supported_runtime_contract_versions); const registry = positiveVersions(input.supported_registry_contract_versions);
    const runtimeCandidates = runtime;
    const registryCandidates = registry;
    let failure: SearchFailure = runtimeCandidates.length === 0 ? { code: "PLUGIN_CONTRACT_INCOMPATIBLE", plugin_ids: [], payload: {} } : { code: "REGISTRY_CONTRACT_INCOMPATIBLE", plugin_ids: [], payload: {} };
    const failurePriority = (code: SearchFailure["code"]): number => code === "PLUGIN_DEPENDENCY_CYCLE" || code === "PLUGIN_NAMESPACE_CONFLICT" || code === "PLUGIN_CAPABILITY_UNAVAILABLE" ? 3 : code === "PLUGIN_VERSION_CONFLICT" ? 2 : 1;
    for (const runtimeContract of runtimeCandidates) for (const registryContract of registryCandidates) {
      const attempt = solveGraph(input, runtimeContract, registryContract);
      if (!attempt.selected) { if (attempt.failure && failurePriority(attempt.failure.code) > failurePriority(failure.code)) failure = attempt.failure; continue; }
      const packages = [...attempt.selected.values()].sort((left, right) => compareUtf8Bytes(left.plugin_id, right.plugin_id));
      const resolved_plugins: SdkResolvedPlugin[] = packages.map((item) => ({
          plugin_id: item.plugin_id, plugin_version: item.plugin_version, namespace: item.namespace, package_digest: item.package_digest,
          declaration_digest: item.declaration_digest, contribution_digest: item.contribution_digest, analysis_digest: item.compatibility.analysis_digest,
          analysis_configuration_digest: item.analysis_configuration_digest, plugin_contract_version: `${String(runtimeContract)}.0.0`, registry_contract_version: `${String(registryContract)}.0.0`,
          resolved_dependency_plugin_ids: item.compatibility.dependencies.map((dependency) => dependency.plugin_id).sort(compareUtf8Bytes), effective_capabilities: item.compatibility.offered_capabilities.map((entry) => entry.capability).sort(compareUtf8Bytes),
      }));
      const core = { resolution_lock_id: sourceValue(input.id_source), workspace_id: input.workspace_id, resolver_version: input.resolver_version, resolved_plugins };
      const digest = lockDigest(this.digests, lockDigestInput(core));
      if (digest === undefined) return deepFreeze({ ok: false, issues: [compatibilityIssue(input, { code: "PLUGIN_VERSION_CONFLICT", plugin_ids: packages.map((item) => item.plugin_id), payload: { lock_digest_unavailable: true } })] });
      const lock = deepFreeze({ ...core, lock_digest: digest, created_at: sourceValue(input.clock) });
      return deepFreeze({ ok: true, lock, packages, preserved_existing_lock: false });
    }
    return deepFreeze({ ok: false, issues: [compatibilityIssue(input, failure)] });
  }
}
