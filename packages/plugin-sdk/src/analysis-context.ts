import type {
  BasePluginInputRecordEntry,
  BasePluginRecordView,
  CompletenessReport,
  JsonValue,
  PluginAnalysisView,
  PluginArtifactView,
  PluginResourceBudget,
  StagedPluginInputRecordEntry,
  StagedPluginRecordView,
} from "@urdira/contracts";
import { canonicalJson, deepFreeze, hasExactKeys } from "./canonical.js";
import {
  PluginAccessManifestCapture,
  type PluginAnalysisFinalizeResult,
  type PluginManifestBindingInput,
} from "./access-manifest.js";
import { PluginSdkError, sdkError } from "./errors.js";
import { materializePortResult, type PortMaterializationLimits } from "./port-boundary.js";

export interface ArtifactFilter {
  readonly artifact_kind?: string;
  readonly language_id?: string;
  readonly normalized_uri_prefix?: string;
  readonly content_access?: "readable" | "metadata_only";
}

export type PluginRecordReference =
  | { readonly record_type: "base"; readonly record_id: string }
  | { readonly record_type: "staged"; readonly staged_record_id: string };

export interface PluginRecordSelector {
  readonly category?: string;
  readonly kind?: string;
  readonly universal_kind?: string;
  readonly facet?: string;
  readonly owner_artifact_id?: string;
}

export interface ArtifactLookupResult {
  readonly artifacts: readonly PluginArtifactView[];
  readonly completeness: CompletenessReport;
}

export interface ArtifactFindResult {
  readonly artifact?: PluginArtifactView;
  readonly completeness: CompletenessReport;
}

export interface ArtifactReadResult {
  readonly artifact: PluginArtifactView;
  readonly content?: string;
  readonly completeness: CompletenessReport;
}

export type BaseAnalysisRecordView = Omit<BasePluginRecordView, "view_type"> & { readonly view_type: "base" };
export type StagedAnalysisRecordView = Omit<StagedPluginRecordView, "view_type"> & { readonly view_type: "staged" };
export type AnalysisRecordView = BaseAnalysisRecordView | StagedAnalysisRecordView;

export interface RecordGetResult {
  readonly record?: AnalysisRecordView;
  readonly completeness: CompletenessReport;
}

export interface RecordQueryResult {
  readonly records: readonly AnalysisRecordView[];
  readonly completeness: CompletenessReport;
}

export interface PluginAnalysisViewPort {
  listArtifacts(filter: ArtifactFilter | undefined): Promise<ArtifactLookupResult>;
  findArtifact(normalized_uri: string): Promise<ArtifactFindResult>;
  readArtifact(artifact_id: string): Promise<ArtifactReadResult>;
  getRecord(reference: PluginRecordReference): Promise<RecordGetResult>;
  queryRecords(selector: PluginRecordSelector): Promise<RecordQueryResult>;
}

export interface DependencyClosureResult {
  readonly proof: "proven" | "unavailable";
  readonly base_records: readonly (Omit<BasePluginInputRecordEntry, "input_type"> & { readonly input_type: "base_record" })[];
  readonly staged_records: readonly (Omit<StagedPluginInputRecordEntry, "input_type"> & { readonly input_type: "staged_record" })[];
  readonly artifact_version_ids: readonly string[];
}

export interface PluginDependencyClosurePort {
  baseRecordClosure(record_id: string): Promise<DependencyClosureResult>;
  stagedRecordClosure(staged_record_id: string): Promise<DependencyClosureResult>;
}

export interface PluginAnalysisSessionInput {
  readonly analysis_view: PluginAnalysisView;
  readonly view_port: PluginAnalysisViewPort;
  readonly dependency_closure_port: PluginDependencyClosurePort;
  readonly cancellation_signal: AbortSignal;
  readonly budget: PluginResourceBudget;
  readonly request_id: string;
  readonly request_digest: string;
  readonly plugin_id: string;
  readonly plugin_version: string;
  readonly analysis_digest: string;
  readonly analysis_configuration_digest: string;
  readonly call: string;
  readonly call_payload: JsonValue;
}

export interface PluginArtifactContext {
  readonly list: (filter: ArtifactFilter | undefined) => Promise<readonly PluginArtifactView[]>;
  readonly find: (normalized_uri: string) => Promise<PluginArtifactView | undefined>;
  readonly read: (artifact_id: string) => Promise<string>;
}

export interface PluginRecordContext {
  readonly get: (reference: PluginRecordReference) => Promise<AnalysisRecordView | undefined>;
  readonly query: (selector: PluginRecordSelector) => Promise<readonly AnalysisRecordView[]>;
}

export interface PluginAnalysisSession {
  readonly analysis_view: PluginAnalysisView;
  readonly artifacts: PluginArtifactContext;
  readonly records: PluginRecordContext;
  readonly finalize: (binding: PluginManifestBindingInput) => Promise<PluginAnalysisFinalizeResult>;
}

const VIEW_KEYS = [
  "analysis_view_digest", "workspace_id", "candidate_generation_id", "source_overlay_digest", "prerequisite_stage_set_digest",
  "target_registry_snapshot_id", "resolution_lock_id", "configuration_revision_id",
] as const;
const VIEW_OPTIONAL_KEYS = ["base_snapshot_id"] as const;
const BUDGET_KEYS = [
  "deadline", "max_memory_bytes", "max_output_bytes", "max_records", "max_dependencies", "max_context_operations", "max_context_bytes", "max_recursion_depth",
] as const;
const FILTER_KEYS = ["artifact_kind", "language_id", "normalized_uri_prefix", "content_access"] as const;
const SELECTOR_KEYS = ["category", "kind", "universal_kind", "facet", "owner_artifact_id"] as const;
const ARTIFACT_KEYS = [
  "artifact_id", "artifact_version_id", "normalized_uri", "artifact_kind", "content_hash", "byte_length", "encoding", "language_ids", "content_access",
] as const;
const BASE_RECORD_KEYS = [
  "view_type", "record_id", "record_digest", "category", "kind", "universal_kind", "facets", "owner_artifact_id", "owner_artifact_version_id", "body",
] as const;
const STAGED_RECORD_KEYS = [
  "view_type", "staged_record_id", "producing_work_item_id", "proposal_record_key", "validated_record_digest", "category", "kind", "universal_kind", "facets",
  "owner_artifact_id", "owner_artifact_version_id", "body",
] as const;
const RECORD_OPTIONAL_KEYS = ["source_span"] as const;

function digest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:.+$/u.test(value);
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateView(view: PluginAnalysisView): void {
  if (!Object.isFrozen(view) || !hasExactKeys(view, VIEW_KEYS, VIEW_OPTIONAL_KEYS) || !digest(view.analysis_view_digest) ||
      !digest(view.source_overlay_digest) || !digest(view.prerequisite_stage_set_digest) ||
      VIEW_KEYS.filter((key) => !key.endsWith("digest")).some((key) => !nonEmptyText(view[key]))) {
    throw sdkError("plugin-sdk:analysis_view_invalid", "The plugin analysis view must be an exact frozen value with required identities and digests.");
  }
}

function safeLimit(value: bigint): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

function parseBudget(value: PluginResourceBudget): {
  readonly operations: bigint;
  readonly bytes: bigint;
  readonly deadline: number;
  readonly materialization: PortMaterializationLimits;
} {
  if (!hasExactKeys(value, BUDGET_KEYS) || !nonEmptyText(value.deadline) || new Date(value.deadline).toISOString() !== value.deadline) {
    throw sdkError("plugin-sdk:resource_budget_invalid", "The plugin resource budget must contain exactly eight valid fields.");
  }
  const numericKeys = BUDGET_KEYS.filter((key) => key !== "deadline");
  if (numericKeys.some((key) => typeof value[key] !== "string" || !/^\d+$/u.test(value[key]))) {
    throw sdkError("plugin-sdk:resource_budget_invalid", "Plugin resource budget limits must be unsigned decimal strings.");
  }
  const positiveKeys = numericKeys.filter((key) => key !== "max_context_operations" && key !== "max_context_bytes");
  if (positiveKeys.some((key) => BigInt(value[key]) <= 0n)) {
    throw sdkError("plugin-sdk:resource_budget_invalid", "Only context operation and byte limits may be zero.");
  }
  const memory = BigInt(value.max_memory_bytes);
  const materializationItems = BigInt(value.max_records) + BigInt(value.max_dependencies) + BigInt(value.max_context_operations);
  return {
    operations: BigInt(value.max_context_operations),
    bytes: BigInt(value.max_context_bytes),
    deadline: Date.parse(value.deadline),
    materialization: Object.freeze({
      max_items: safeLimit(materializationItems),
      max_depth: safeLimit(BigInt(value.max_recursion_depth)),
      max_nodes: safeLimit(memory),
      max_bytes: safeLimit(memory),
    }),
  };
}

function validateFilter(filter: ArtifactFilter | undefined): ArtifactFilter | undefined {
  if (filter === undefined) return undefined;
  if (!hasExactKeys(filter, [], FILTER_KEYS) || Object.values(filter).some((item) => !nonEmptyText(item)) ||
      (filter["content_access"] !== undefined && filter["content_access"] !== "readable" && filter["content_access"] !== "metadata_only")) {
    throw sdkError("plugin-sdk:analysis_view_invalid", "Artifact filters use a closed structural schema.");
  }
  return deepFreeze({ ...filter });
}

function validateReference(reference: PluginRecordReference): PluginRecordReference {
  const valid = reference.record_type === "base"
    ? hasExactKeys(reference, ["record_type", "record_id"]) && nonEmptyText(reference.record_id)
    : reference.record_type === "staged" && hasExactKeys(reference, ["record_type", "staged_record_id"]) && nonEmptyText(reference.staged_record_id);
  if (!valid) throw sdkError("plugin-sdk:analysis_view_invalid", "Record references use a closed base-or-staged address.");
  return deepFreeze({ ...reference });
}

function validateSelector(selector: PluginRecordSelector): PluginRecordSelector {
  if (!hasExactKeys(selector, [], SELECTOR_KEYS) || Object.values(selector).some((item) => !nonEmptyText(item))) {
    throw sdkError("plugin-sdk:analysis_view_invalid", "Record selectors use a closed structural schema.");
  }
  return deepFreeze({ ...selector });
}

function normalizedArtifact(value: PluginArtifactView): PluginArtifactView {
  if (!hasExactKeys(value, ARTIFACT_KEYS) || !nonEmptyText(value.artifact_id) || !nonEmptyText(value.artifact_version_id) ||
      !nonEmptyText(value.normalized_uri) || !nonEmptyText(value.artifact_kind) || !digest(value.content_hash) ||
      !Number.isSafeInteger(value.byte_length) || value.byte_length < 0 || !nonEmptyText(value.encoding) || !Array.isArray(value.language_ids) ||
      value.language_ids.some((item) => !nonEmptyText(item)) || (value.content_access !== "readable" && value.content_access !== "metadata_only")) {
    throw sdkError("plugin-sdk:analysis_view_invalid", "The analysis view port returned an invalid artifact.");
  }
  return deepFreeze({
    artifact_id: value.artifact_id,
    artifact_version_id: value.artifact_version_id,
    normalized_uri: value.normalized_uri,
    artifact_kind: value.artifact_kind,
    content_hash: value.content_hash,
    byte_length: value.byte_length,
    encoding: value.encoding,
    language_ids: [...value.language_ids],
    content_access: value.content_access,
  });
}

function normalizedRecord(value: AnalysisRecordView): AnalysisRecordView {
  const commonValid = nonEmptyText(value.category) && nonEmptyText(value.kind) && nonEmptyText(value.universal_kind) && Array.isArray(value.facets) &&
    value.facets.every(nonEmptyText) && nonEmptyText(value.owner_artifact_id) && nonEmptyText(value.owner_artifact_version_id);
  if (value.view_type === "base") {
    if (!commonValid || !hasExactKeys(value, BASE_RECORD_KEYS, RECORD_OPTIONAL_KEYS) || !nonEmptyText(value.record_id) || !digest(value.record_digest)) {
      throw sdkError("plugin-sdk:analysis_view_invalid", "The analysis view port returned an invalid base record.");
    }
    return deepFreeze({ ...value, facets: [...value.facets] });
  }
  if (value.view_type === "staged") {
    if (!commonValid || !hasExactKeys(value, STAGED_RECORD_KEYS, RECORD_OPTIONAL_KEYS) || !nonEmptyText(value.staged_record_id) ||
        !nonEmptyText(value.producing_work_item_id) || !nonEmptyText(value.proposal_record_key) || !digest(value.validated_record_digest)) {
      throw sdkError("plugin-sdk:analysis_view_invalid", "The analysis view port returned an invalid staged record.");
    }
    return deepFreeze({ ...value, facets: [...value.facets] });
  }
  throw sdkError("plugin-sdk:analysis_view_invalid", "The analysis view port returned an unknown record view type.");
}

function normalizedCompleteness(value: CompletenessReport): CompletenessReport {
  if (value === null || typeof value !== "object" || !Array.isArray(value.workspace_snapshot_binding_ids) || !Array.isArray(value.dimensions) ||
      !Array.isArray(value.diagnostic_record_ids) || !["complete", "partial", "unknown", "unsupported", "stale"].includes(value.overall_status)) {
    throw sdkError("plugin-sdk:analysis_view_invalid", "The analysis view port returned an invalid completeness report.");
  }
  return deepFreeze({ ...value, workspace_snapshot_binding_ids: [...value.workspace_snapshot_binding_ids], dimensions: [...value.dimensions], diagnostic_record_ids: [...value.diagnostic_record_ids] });
}

function snapshotJson(value: JsonValue): JsonValue {
  return deepFreeze(JSON.parse(canonicalJson(value)) as JsonValue);
}

function bindViewPort(port: PluginAnalysisViewPort): PluginAnalysisViewPort {
  return Object.freeze({
    listArtifacts: port.listArtifacts.bind(port),
    findArtifact: port.findArtifact.bind(port),
    readArtifact: port.readArtifact.bind(port),
    getRecord: port.getRecord.bind(port),
    queryRecords: port.queryRecords.bind(port),
  });
}

function bindClosurePort(port: PluginDependencyClosurePort): PluginDependencyClosurePort {
  return Object.freeze({
    baseRecordClosure: port.baseRecordClosure.bind(port),
    stagedRecordClosure: port.stagedRecordClosure.bind(port),
  });
}

export function createPluginAnalysisSession(input: PluginAnalysisSessionInput): PluginAnalysisSession {
  validateView(input.analysis_view);
  const limits = parseBudget(input.budget);
  const sessionInput: PluginAnalysisSessionInput = Object.freeze({
    analysis_view: input.analysis_view,
    view_port: bindViewPort(input.view_port),
    dependency_closure_port: bindClosurePort(input.dependency_closure_port),
    cancellation_signal: input.cancellation_signal,
    budget: input.budget,
    request_id: input.request_id,
    request_digest: input.request_digest,
    plugin_id: input.plugin_id,
    plugin_version: input.plugin_version,
    analysis_digest: input.analysis_digest,
    analysis_configuration_digest: input.analysis_configuration_digest,
    call: input.call,
    call_payload: snapshotJson(input.call_payload),
  });
  let usedOperations = 0n;
  let usedBytes = 0n;
  const capture = new PluginAccessManifestCapture(sessionInput);

  const cancelled = (): void => {
    if (sessionInput.cancellation_signal.aborted) throw sdkError("plugin-sdk:cancelled", "The plugin analysis call was cancelled.");
    if (Date.now() >= limits.deadline) throw sdkError("plugin-sdk:context_budget_exhausted", "The plugin analysis deadline was exhausted.");
  };
  const beforeCall = (): void => {
    cancelled();
    if (usedOperations >= limits.operations || usedBytes >= limits.bytes) {
      throw sdkError("plugin-sdk:context_budget_exhausted", "The independent plugin context budget was exhausted.");
    }
    usedOperations += 1n;
  };
  const afterCall = <T>(value: T): T => {
    cancelled();
    const bytes = BigInt(Buffer.byteLength(canonicalJson(value), "utf8"));
    if (usedBytes + bytes > limits.bytes) throw sdkError("plugin-sdk:context_budget_exhausted", "The plugin context byte budget was exhausted.");
    usedBytes += bytes;
    return value;
  };
  const invoke = async <T>(port: "analysis_view" | "dependency_closure", call: () => Promise<T>, normalize: (value: T) => T): Promise<T> => {
    beforeCall();
    let result: T;
    try {
      const foreignResult = await call();
      cancelled();
      result = materializePortResult(foreignResult, limits.materialization);
    }
    catch {
      cancelled();
      throw sdkError("plugin-sdk:port_failure", "A plugin SDK port call failed.", { port });
    }
    try {
      return afterCall(normalize(result));
    } catch (error) {
      if (error instanceof PluginSdkError) throw error;
      cancelled();
      throw sdkError("plugin-sdk:port_failure", "A plugin SDK port call failed.", { port });
    }
  };

  const artifacts: PluginArtifactContext = {
    list: async (filter) => {
      const normalizedFilter = validateFilter(filter);
      const result = await invoke(
      "analysis_view",
      () => sessionInput.view_port.listArtifacts(normalizedFilter),
      (result) => deepFreeze({ artifacts: result.artifacts.map(normalizedArtifact), completeness: normalizedCompleteness(result.completeness) }),
      );
      capture.captureArtifacts("artifact_list", canonicalJson(normalizedFilter ?? {}), result.artifacts, result.completeness);
      return result.artifacts;
    },
    find: async (normalizedUri) => {
      if (!nonEmptyText(normalizedUri)) throw sdkError("plugin-sdk:analysis_view_invalid", "Artifact lookup addresses must be non-empty normalized URI text.");
      const result = await invoke(
        "analysis_view",
        () => sessionInput.view_port.findArtifact(normalizedUri),
        (result) => deepFreeze({ ...(result.artifact === undefined ? {} : { artifact: normalizedArtifact(result.artifact) }), completeness: normalizedCompleteness(result.completeness) }),
      );
      capture.captureArtifacts("artifact_find", normalizedUri, result.artifact === undefined ? [] : [result.artifact], result.completeness);
      return result.artifact;
    },
    read: async (artifactId) => {
      if (!nonEmptyText(artifactId)) throw sdkError("plugin-sdk:analysis_view_invalid", "Artifact read addresses must be non-empty artifact IDs.");
      const result = await invoke(
        "analysis_view",
        () => sessionInput.view_port.readArtifact(artifactId),
        (raw) => {
          const artifact = normalizedArtifact(raw.artifact);
          if (artifact.content_access !== "readable" || typeof raw.content !== "string") {
            throw sdkError("plugin-sdk:content_unavailable", "Artifact content is metadata-only in this analysis view.", { artifact_id: artifact.artifact_id });
          }
          return deepFreeze({ artifact, content: raw.content, completeness: normalizedCompleteness(raw.completeness) });
        },
      );
      capture.captureArtifacts("artifact_read", artifactId, [result.artifact], result.completeness);
      return result.content!;
    },
  };
  const records: PluginRecordContext = {
    get: async (reference) => {
      const normalizedReference = validateReference(reference);
      const result = await invoke(
        "analysis_view",
        () => sessionInput.view_port.getRecord(normalizedReference),
        (result) => deepFreeze({ ...(result.record === undefined ? {} : { record: normalizedRecord(result.record) }), completeness: normalizedCompleteness(result.completeness) }),
      );
      capture.captureRecords("record_get", canonicalJson(normalizedReference), result.record === undefined ? [] : [result.record], result.completeness);
      return result.record;
    },
    query: async (selector) => {
      const normalizedSelector = validateSelector(selector);
      const result = await invoke(
        "analysis_view",
        () => sessionInput.view_port.queryRecords(normalizedSelector),
        (result) => deepFreeze({ records: result.records.map(normalizedRecord), completeness: normalizedCompleteness(result.completeness) }),
      );
      capture.captureRecords("record_query", canonicalJson(normalizedSelector), result.records, result.completeness);
      return result.records;
    },
  };

  const finalize = async (binding: PluginManifestBindingInput): Promise<PluginAnalysisFinalizeResult> =>
    capture.finalize(binding, (call) => invoke("dependency_closure", call, (value) => deepFreeze({ ...value, base_records: [...value.base_records], staged_records: [...value.staged_records], artifact_version_ids: [...value.artifact_version_ids] })));

  return deepFreeze({ analysis_view: sessionInput.analysis_view, artifacts, records, finalize });
}
