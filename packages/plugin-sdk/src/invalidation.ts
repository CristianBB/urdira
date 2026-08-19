import type { CompletenessReport, JsonValue, PluginLookupInvalidationDependency } from "@urdira/contracts";
import { canonicalJson, canonicalSha256, deepFreeze, hasExactKeys } from "./canonical.js";
import type {
  AutomaticPluginInputAccessManifest,
  PluginCapturedArtifactEntry,
  PluginCapturedLookupEntry,
  PluginCapturedRecordEntry,
  PluginInputAccessManifestDigestInput,
  PluginLookupOperation,
} from "./access-manifest.js";
import {
  pluginInputAccessManifestDigest,
  pluginInputAccessManifestId,
  pluginLookupCompleteness,
  pluginLookupResultSetDigest,
} from "./access-manifest.js";
import { PluginSdkError, sdkError } from "./errors.js";
import { compareCanonicalJson, compareUtf8Bytes } from "./ordering.js";
import { materializePortResult, type PortMaterializationLimits } from "./port-boundary.js";

export type { PortMaterializationLimits } from "./port-boundary.js";

export type PluginInvalidationConsumerType = "record_set" | "projection_set" | "partition_set";
export type ConservativeInvalidationScope = "plugin_partition" | "plugin" | "workspace";
export type PluginInvalidationScope = "exact_address" | "exact_selector" | ConservativeInvalidationScope;

export interface AuthorizedConservativeLookupScope {
  readonly operation: PluginLookupOperation;
  readonly scope: ConservativeInvalidationScope;
}

export interface BoundPluginLookupInvalidationDependency extends PluginLookupInvalidationDependency {
  readonly consumer_type: PluginInvalidationConsumerType;
  readonly operation: PluginLookupOperation;
  readonly invalidation_scope: PluginInvalidationScope;
}

export interface LookupJournalCoverageInput {
  readonly workspace_id: string;
  readonly operation: PluginLookupOperation;
  readonly normalized_selector: string;
  readonly selector_dimensions: readonly string[];
}

export interface LookupJournalCoverageResult {
  readonly journaled_dimensions: readonly string[];
}

export interface LookupRevalidationSnapshot {
  readonly analysis_view_digest: string;
  readonly completeness: CompletenessReport;
  readonly results: readonly JsonValue[];
}

export interface LookupInvalidationIndexPort {
  journalCoverage(input: LookupJournalCoverageInput): Promise<LookupJournalCoverageResult>;
  persistLookupDependencies(dependencies: readonly BoundPluginLookupInvalidationDependency[]): Promise<void>;
  currentLookupResult(dependency: BoundPluginLookupInvalidationDependency): Promise<LookupRevalidationSnapshot>;
}

export interface LookupBindingInput {
  readonly manifest: AutomaticPluginInputAccessManifest;
  readonly workspace_id: string;
  readonly consumer_type: PluginInvalidationConsumerType;
  readonly consumer_id: string;
  readonly owner_artifact_id?: string;
  readonly owner_artifact_version_id?: string;
  readonly valid_from_generation: number;
  readonly authorized_conservative_scopes: readonly AuthorizedConservativeLookupScope[];
  readonly cancellation_signal: AbortSignal;
}

export interface LookupRevalidationInput {
  readonly dependencies: readonly BoundPluginLookupInvalidationDependency[];
  readonly generation: number;
  readonly cancellation_signal: AbortSignal;
}

export interface LookupRevalidationResult {
  readonly invalidated_consumer_ids: readonly string[];
  readonly changed_lookup_dependency_ids: readonly string[];
}

const EXACT_ADDRESS_OPERATIONS = new Set<PluginLookupOperation>(["artifact_find", "record_get"]);
const SELECTOR_OPERATIONS = new Set<PluginLookupOperation>(["artifact_list", "record_query"]);
const CONSERVATIVE_SCOPES = new Set<ConservativeInvalidationScope>(["plugin_partition", "plugin", "workspace"]);
const ARTIFACT_ACCESS_MODES = new Set(["artifact_list", "artifact_find", "artifact_read"]);
const MANIFEST_KEYS = [
  "plugin_input_access_manifest_id", "request_id", "analysis_view_digest", "artifact_version_entries", "record_entries", "lookup_entries",
  "transitive_artifact_version_ids", "manifest_digest",
] as const;
const ARTIFACT_ENTRY_KEYS = ["artifact_id", "artifact_version_id", "content_hash", "access_modes"] as const;
const BASE_RECORD_ENTRY_KEYS = ["input_type", "record_id", "record_digest"] as const;
const STAGED_RECORD_ENTRY_KEYS = ["input_type", "staged_record_id", "producing_work_item_id", "proposal_record_key", "validated_record_digest"] as const;
const LOOKUP_ENTRY_KEYS = ["operation", "normalized_selector_or_address", "analysis_view_digest", "result_set_digest", "result_count", "completeness"] as const;

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw sdkError("plugin-sdk:cancelled", "The lookup invalidation operation was cancelled.");
}

async function portCall<T>(
  signal: AbortSignal,
  port: "lookup_journal" | "lookup_persistence" | "lookup_revalidation",
  limits: PortMaterializationLimits | undefined,
  call: () => Promise<T>,
  normalize: (value: T) => T = (value) => value,
): Promise<T> {
  cancelled(signal);
  let result: T;
  try {
    const foreignResult = await call();
    cancelled(signal);
    result = materializePortResult(foreignResult, limits);
  }
  catch {
    cancelled(signal);
    throw sdkError("plugin-sdk:port_failure", "A plugin SDK port call failed.", { port });
  }
  try {
    return normalize(result);
  } catch (error) {
    if (error instanceof PluginSdkError) throw error;
    cancelled(signal);
    throw sdkError("plugin-sdk:port_failure", "A plugin SDK port call failed.", { port });
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function selectorDimensions(entry: PluginCapturedLookupEntry): readonly string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(entry.normalized_selector_or_address); }
  catch { throw sdkError("plugin-sdk:lookup_binding_invalid", "A captured lookup selector is not canonical JSON."); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== "string")) {
    throw sdkError("plugin-sdk:lookup_binding_invalid", "A captured lookup selector is not a closed structural selector.");
  }
  const dimensions = Object.keys(parsed).sort(compareUtf8Bytes);
  return dimensions.length === 0 ? ["*"] : dimensions;
}

function validateConsumer(input: LookupBindingInput): void {
  if (!nonEmpty(input.workspace_id) || !nonEmpty(input.consumer_id) || !Number.isSafeInteger(input.valid_from_generation) || input.valid_from_generation < 0 ||
      !Array.isArray(input.authorized_conservative_scopes) || !["record_set", "projection_set", "partition_set"].includes(input.consumer_type)) {
    throw sdkError("plugin-sdk:lookup_binding_invalid", "Lookup binding identities and generation must be valid.");
  }
  const hasOwnerId = input.owner_artifact_id !== undefined;
  const hasOwnerVersion = input.owner_artifact_version_id !== undefined;
  if (input.consumer_type === "partition_set" ? hasOwnerId || hasOwnerVersion : !hasOwnerId || !hasOwnerVersion || !nonEmpty(input.owner_artifact_id) || !nonEmpty(input.owner_artifact_version_id)) {
    throw sdkError("plugin-sdk:lookup_binding_invalid", "Partition consumers omit owner fields while record and projection consumers require both owner fields.");
  }
  if (input.authorized_conservative_scopes.some((entry) =>
    (!SELECTOR_OPERATIONS.has(entry.operation) && !EXACT_ADDRESS_OPERATIONS.has(entry.operation)) || !CONSERVATIVE_SCOPES.has(entry.scope))) {
    throw sdkError("plugin-sdk:lookup_binding_invalid", "Authorized conservative lookup scopes must use known lookup operations and scopes.");
  }
}

function compareLookup(left: PluginCapturedLookupEntry, right: PluginCapturedLookupEntry): number {
  return compareUtf8Bytes(left.operation, right.operation) || compareUtf8Bytes(left.normalized_selector_or_address, right.normalized_selector_or_address) ||
    compareUtf8Bytes(left.result_set_digest, right.result_set_digest);
}

function strictlyOrdered<T>(values: readonly T[], compare: (left: T, right: T) => number): boolean {
  return values.every((value, index) => index === 0 || compare(values[index - 1]!, value) < 0);
}

function validateLookup(entry: unknown, analysisViewDigest: string): entry is PluginCapturedLookupEntry {
  if (!hasExactKeys(entry, LOOKUP_ENTRY_KEYS) || (!EXACT_ADDRESS_OPERATIONS.has(entry["operation"] as PluginLookupOperation) && !SELECTOR_OPERATIONS.has(entry["operation"] as PluginLookupOperation)) ||
      !nonEmpty(entry["normalized_selector_or_address"]) || entry["analysis_view_digest"] !== analysisViewDigest ||
      typeof entry["result_set_digest"] !== "string" || !/^sha256:.+$/u.test(entry["result_set_digest"]) ||
      !Number.isSafeInteger(entry["result_count"]) || (entry["result_count"] as number) < 0 ||
      (entry["completeness"] !== "complete" && entry["completeness"] !== "policy_limited")) {
    throw sdkError("plugin-sdk:lookup_binding_invalid", "The access manifest contains an invalid lookup entry.");
  }
  return true;
}

function validateRecord(entry: unknown): entry is PluginCapturedRecordEntry {
  if (hasExactKeys(entry, BASE_RECORD_ENTRY_KEYS) && entry["input_type"] === "base_record") {
    return nonEmpty(entry["record_id"]) && typeof entry["record_digest"] === "string" && /^sha256:.+$/u.test(entry["record_digest"]);
  }
  return hasExactKeys(entry, STAGED_RECORD_ENTRY_KEYS) && entry["input_type"] === "staged_record" && nonEmpty(entry["staged_record_id"]) &&
    nonEmpty(entry["producing_work_item_id"]) && nonEmpty(entry["proposal_record_key"]) &&
    typeof entry["validated_record_digest"] === "string" && /^sha256:.+$/u.test(entry["validated_record_digest"]);
}

function exactOwnedManifest(value: unknown, limits: PortMaterializationLimits | undefined): AutomaticPluginInputAccessManifest {
  let owned: unknown;
  try { owned = materializePortResult(value, limits); }
  catch { throw sdkError("plugin-sdk:lookup_binding_invalid", "Lookup binding requires a bounded exact automatic access manifest."); }
  if (!hasExactKeys(owned, MANIFEST_KEYS) || !nonEmpty(owned["request_id"]) || typeof owned["analysis_view_digest"] !== "string" ||
      !/^sha256:.+$/u.test(owned["analysis_view_digest"]) || typeof owned["plugin_input_access_manifest_id"] !== "string" ||
      typeof owned["manifest_digest"] !== "string" || !Array.isArray(owned["artifact_version_entries"]) || !Array.isArray(owned["record_entries"]) ||
      !Array.isArray(owned["lookup_entries"]) || !Array.isArray(owned["transitive_artifact_version_ids"])) {
    throw sdkError("plugin-sdk:lookup_binding_invalid", "Lookup binding requires a bounded exact automatic access manifest.");
  }

  const artifacts = owned["artifact_version_entries"];
  const records = owned["record_entries"];
  const lookups = owned["lookup_entries"];
  const transitiveIds = owned["transitive_artifact_version_ids"];
  const artifactIdentities = new Set<string>();
  const recordIdentities = new Set<string>();
  const lookupIdentities = new Set<string>();
  const validArtifacts = artifacts.every((entry) => {
    if (!hasExactKeys(entry, ARTIFACT_ENTRY_KEYS) || !nonEmpty(entry["artifact_id"]) || !nonEmpty(entry["artifact_version_id"]) ||
        typeof entry["content_hash"] !== "string" || !/^sha256:.+$/u.test(entry["content_hash"]) || !Array.isArray(entry["access_modes"]) || entry["access_modes"].length === 0 ||
        !entry["access_modes"].every((mode) => typeof mode === "string" && ARTIFACT_ACCESS_MODES.has(mode)) || !strictlyOrdered(entry["access_modes"] as string[], compareUtf8Bytes)) return false;
    const identity = `${entry["artifact_id"] as string}\0${entry["artifact_version_id"] as string}`;
    if (artifactIdentities.has(identity)) return false;
    artifactIdentities.add(identity);
    return true;
  });
  const validRecords = records.every((entry) => {
    if (!validateRecord(entry)) return false;
    const identity = entry.input_type === "base_record" ? `base_record\0${entry.record_id}` : `staged_record\0${entry.staged_record_id}`;
    if (recordIdentities.has(identity)) return false;
    recordIdentities.add(identity);
    return true;
  });
  const validLookups = lookups.every((entry) => {
    if (!validateLookup(entry, owned["analysis_view_digest"] as string)) return false;
    const identity = `${entry.operation}\0${entry.normalized_selector_or_address}`;
    if (lookupIdentities.has(identity)) return false;
    lookupIdentities.add(identity);
    return true;
  });
  if (!validArtifacts || !validRecords || !validLookups || !transitiveIds.every(nonEmpty) ||
      !strictlyOrdered(artifacts, compareCanonicalJson) || !strictlyOrdered(records, compareCanonicalJson) ||
      !strictlyOrdered(lookups as PluginCapturedLookupEntry[], compareLookup) || !strictlyOrdered(transitiveIds as string[], compareUtf8Bytes)) {
    throw sdkError("plugin-sdk:lookup_binding_invalid", "The access manifest entries must be exact, canonical, and duplicate-free.");
  }

  const manifest = owned as unknown as AutomaticPluginInputAccessManifest;
  const digestInput: PluginInputAccessManifestDigestInput = {
    request_id: manifest.request_id,
    analysis_view_digest: manifest.analysis_view_digest,
    artifact_version_entries: manifest.artifact_version_entries,
    record_entries: manifest.record_entries,
    lookup_entries: manifest.lookup_entries,
    transitive_artifact_version_ids: manifest.transitive_artifact_version_ids,
  };
  if (manifest.plugin_input_access_manifest_id !== pluginInputAccessManifestId(manifest.request_id, manifest.analysis_view_digest) ||
      manifest.manifest_digest !== pluginInputAccessManifestDigest(digestInput)) {
    throw sdkError("plugin-sdk:lookup_binding_invalid", "The access manifest identity or digest does not match its exact canonical contents.");
  }
  return deepFreeze(manifest);
}

export class PluginLookupInvalidationBinder {
  readonly #journalCoverage: LookupInvalidationIndexPort["journalCoverage"];
  readonly #persistLookupDependencies: LookupInvalidationIndexPort["persistLookupDependencies"];
  readonly #currentLookupResult: LookupInvalidationIndexPort["currentLookupResult"];
  readonly #materializationLimits: PortMaterializationLimits | undefined;

  constructor(port: LookupInvalidationIndexPort, materializationLimits?: PortMaterializationLimits) {
    this.#journalCoverage = port.journalCoverage.bind(port);
    this.#persistLookupDependencies = port.persistLookupDependencies.bind(port);
    this.#currentLookupResult = port.currentLookupResult.bind(port);
    this.#materializationLimits = materializationLimits;
  }

  async bind(input: LookupBindingInput): Promise<readonly BoundPluginLookupInvalidationDependency[]> {
    validateConsumer(input);
    const manifest = exactOwnedManifest(input.manifest, this.#materializationLimits);
    const dependencies: BoundPluginLookupInvalidationDependency[] = [];
    const lookups = [...manifest.lookup_entries].sort(compareLookup);
    for (const lookup of lookups) {
      let invalidationScope: PluginInvalidationScope;
      if (EXACT_ADDRESS_OPERATIONS.has(lookup.operation) && lookup.completeness === "complete") {
        invalidationScope = "exact_address";
      } else if (SELECTOR_OPERATIONS.has(lookup.operation) && lookup.completeness === "complete") {
        const dimensions = selectorDimensions(lookup);
        const request = deepFreeze({
          workspace_id: input.workspace_id,
          operation: lookup.operation,
          normalized_selector: lookup.normalized_selector_or_address,
          selector_dimensions: [...dimensions],
        });
        const coverage = await portCall(input.cancellation_signal, "lookup_journal", this.#materializationLimits, () => this.#journalCoverage(request), (value) => {
          if (!hasExactKeys(value, ["journaled_dimensions"]) || !Array.isArray(value.journaled_dimensions) || value.journaled_dimensions.some((item) => !nonEmpty(item))) {
            throw sdkError("plugin-sdk:lookup_binding_invalid", "The invalidation journal returned invalid selector coverage.");
          }
          return deepFreeze({ journaled_dimensions: [...value.journaled_dimensions] });
        });
        invalidationScope = dimensions.every((dimension) => coverage.journaled_dimensions.includes(dimension))
          ? "exact_selector"
          : this.#fallback(input, lookup.operation);
      } else {
        invalidationScope = this.#fallback(input, lookup.operation);
      }
      const core = {
        workspace_id: input.workspace_id,
        consumer_type: input.consumer_type,
        consumer_id: input.consumer_id,
        ...(input.owner_artifact_id === undefined ? {} : { owner_artifact_id: input.owner_artifact_id }),
        ...(input.owner_artifact_version_id === undefined ? {} : { owner_artifact_version_id: input.owner_artifact_version_id }),
        operation: lookup.operation,
        normalized_selector_or_address: lookup.normalized_selector_or_address,
        selector_digest: canonicalSha256({ operation: lookup.operation, normalized_selector_or_address: lookup.normalized_selector_or_address }),
        previous_result_set_digest: lookup.result_set_digest,
        invalidation_scope: invalidationScope,
        valid_from_generation: input.valid_from_generation,
      };
      dependencies.push(deepFreeze({ lookup_dependency_id: canonicalSha256(core), ...core }));
    }
    await portCall(input.cancellation_signal, "lookup_persistence", this.#materializationLimits, () => this.#persistLookupDependencies(dependencies));
    return deepFreeze(dependencies);
  }

  #fallback(input: LookupBindingInput, operation: PluginLookupOperation): ConservativeInvalidationScope {
    const authorization = input.authorized_conservative_scopes.find((entry) => entry.operation === operation);
    if (authorization === undefined) {
      throw sdkError("plugin-sdk:lookup_scope_unauthorized", "The lookup cannot bind exactly and no conservative invalidation scope was authorized.", { operation });
    }
    return authorization.scope;
  }

  async revalidate(input: LookupRevalidationInput): Promise<LookupRevalidationResult> {
    if (!Array.isArray(input.dependencies) || !Number.isSafeInteger(input.generation) || input.generation < 0) {
      throw sdkError("plugin-sdk:lookup_revalidation_invalid", "Lookup revalidation requires dependencies and a non-negative generation.");
    }
    const changed = new Set<string>();
    const consumers = new Set<string>();
    for (const dependency of [...input.dependencies].sort((left, right) => compareUtf8Bytes(left.lookup_dependency_id, right.lookup_dependency_id))) {
      if (input.generation < dependency.valid_from_generation || (dependency.valid_to_generation !== undefined && input.generation >= dependency.valid_to_generation)) continue;
      const snapshot = await portCall(input.cancellation_signal, "lookup_revalidation", this.#materializationLimits, () => this.#currentLookupResult(dependency), (value) => {
        if (!hasExactKeys(value, ["analysis_view_digest", "completeness", "results"]) || !/^sha256:.+$/u.test(value.analysis_view_digest) || !Array.isArray(value.results)) {
          throw sdkError("plugin-sdk:lookup_revalidation_invalid", "The invalidation index returned an invalid lookup snapshot.");
        }
        return deepFreeze({ analysis_view_digest: value.analysis_view_digest, completeness: value.completeness, results: [...value.results] });
      });
      const currentDigest = pluginLookupResultSetDigest(
        dependency.operation as PluginLookupOperation,
        dependency.normalized_selector_or_address,
        snapshot.analysis_view_digest,
        pluginLookupCompleteness(snapshot.completeness),
        snapshot.results,
      );
      if (currentDigest !== dependency.previous_result_set_digest) {
        changed.add(dependency.lookup_dependency_id);
        consumers.add(dependency.consumer_id);
      }
    }
    return deepFreeze({ invalidated_consumer_ids: [...consumers].sort(compareUtf8Bytes), changed_lookup_dependency_ids: [...changed].sort(compareUtf8Bytes) });
  }
}
