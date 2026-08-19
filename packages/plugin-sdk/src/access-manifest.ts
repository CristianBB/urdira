import type {
  BasePluginInputRecordEntry,
  BasePluginRecordView,
  CompletenessReport,
  JsonValue,
  PluginAnalysisView,
  PluginArtifactView,
  StagedPluginInputRecordEntry,
  StagedPluginRecordView,
} from "@urdira/contracts";
import { canonicalJson, canonicalSha256, deepFreeze } from "./canonical.js";
import type {
  AnalysisRecordView,
  DependencyClosureResult,
  PluginAnalysisSessionInput,
} from "./analysis-context.js";
import { sdkError } from "./errors.js";
import { compareCanonicalJson, compareUtf8Bytes } from "./ordering.js";

export type PluginLookupOperation = "artifact_list" | "artifact_find" | "record_get" | "record_query";
export type PluginArtifactAccessMode = PluginLookupOperation | "artifact_read";
export type PluginLookupCompleteness = "complete" | "policy_limited";

export interface PluginCapturedArtifactEntry {
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly content_hash: string;
  readonly access_modes: readonly PluginArtifactAccessMode[];
}

export interface PluginCapturedBaseRecordEntry extends BasePluginInputRecordEntry {
  readonly input_type: "base_record";
}

export interface PluginCapturedStagedRecordEntry extends StagedPluginInputRecordEntry {
  readonly input_type: "staged_record";
}

export type PluginCapturedRecordEntry = PluginCapturedBaseRecordEntry | PluginCapturedStagedRecordEntry;

export interface PluginCapturedLookupEntry {
  readonly operation: PluginLookupOperation;
  readonly normalized_selector_or_address: string;
  readonly analysis_view_digest: string;
  readonly result_set_digest: string;
  readonly result_count: number;
  readonly completeness: PluginLookupCompleteness;
}

export interface AutomaticPluginInputAccessManifest {
  readonly plugin_input_access_manifest_id: string;
  readonly request_id: string;
  readonly analysis_view_digest: string;
  readonly artifact_version_entries: readonly PluginCapturedArtifactEntry[];
  readonly record_entries: readonly PluginCapturedRecordEntry[];
  readonly lookup_entries: readonly PluginCapturedLookupEntry[];
  readonly transitive_artifact_version_ids: readonly string[];
  readonly manifest_digest: string;
}

export type PluginInputAccessManifestDigestInput = Omit<AutomaticPluginInputAccessManifest, "plugin_input_access_manifest_id" | "manifest_digest">;

export function pluginInputAccessManifestId(requestId: string, analysisViewDigest: string): string {
  return canonicalSha256({ request_id: requestId, analysis_view_digest: analysisViewDigest });
}

export function pluginInputAccessManifestDigest(input: PluginInputAccessManifestDigestInput): string {
  return canonicalSha256(input);
}

export interface PluginManifestBindingInput {
  readonly authorized_conservative_closure?: DependencyClosureResult;
}

export interface PluginAnalysisFinalizeResult {
  readonly manifest: AutomaticPluginInputAccessManifest;
  readonly input_artifact_version_ids: readonly string[];
  readonly input_record_ids: readonly string[];
  readonly analysis_input_digest: string;
}

interface MutableArtifactEntry {
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly content_hash: string;
  readonly access_modes: Set<PluginArtifactAccessMode>;
}

interface MutableBaseEntry {
  readonly input_type: "base_record";
  readonly record_id: string;
  readonly record_digest: string;
}

interface MutableStagedEntry {
  readonly input_type: "staged_record";
  readonly staged_record_id: string;
  readonly producing_work_item_id: string;
  readonly proposal_record_key: string;
  readonly validated_record_digest: string;
}

type MutableRecordEntry = MutableBaseEntry | MutableStagedEntry;

interface CapturedLookupSource {
  readonly operation: PluginLookupOperation;
  readonly address: string;
  readonly results: readonly JsonValue[];
  readonly completeness: PluginLookupCompleteness;
}

function orderedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareUtf8Bytes);
}

export function pluginLookupCompleteness(completeness: CompletenessReport): PluginLookupCompleteness {
  return completeness.overall_status === "complete" ? "complete" : "policy_limited";
}

export function pluginLookupResultSetDigest(
  operation: PluginLookupOperation,
  address: string,
  analysisViewDigest: string,
  completeness: PluginLookupCompleteness,
  results: readonly JsonValue[],
): string {
  const canonicalResults = [...new Map(results.map((result) => [canonicalJson(result), result])).values()]
    .sort(compareCanonicalJson);
  return canonicalSha256({
    operation,
    normalized_selector_or_address: address,
    analysis_view_digest: analysisViewDigest,
    completeness,
    results: canonicalResults,
  });
}

function artifactIdentity(artifact: PluginArtifactView): JsonValue {
  return {
    artifact_id: artifact.artifact_id,
    artifact_version_id: artifact.artifact_version_id,
    content_hash: artifact.content_hash,
  };
}

function recordIdentity(record: AnalysisRecordView): JsonValue {
  return record.view_type === "base"
    ? { input_type: "base_record", record_id: record.record_id, record_digest: record.record_digest }
    : {
        input_type: "staged_record",
        staged_record_id: record.staged_record_id,
        producing_work_item_id: record.producing_work_item_id,
        proposal_record_key: record.proposal_record_key,
        validated_record_digest: record.validated_record_digest,
      };
}

function validateClosure(value: DependencyClosureResult): boolean {
  if (value.proof !== "proven" || !Array.isArray(value.base_records) || !Array.isArray(value.staged_records) || !Array.isArray(value.artifact_version_ids)) return false;
  return value.base_records.every((entry) => entry.input_type === "base_record" && typeof entry.record_id === "string" && /^sha256:.+$/u.test(entry.record_digest)) &&
    value.staged_records.every((entry) => entry.input_type === "staged_record" && typeof entry.staged_record_id === "string" && typeof entry.producing_work_item_id === "string" &&
      typeof entry.proposal_record_key === "string" && /^sha256:.+$/u.test(entry.validated_record_digest)) &&
    value.artifact_version_ids.every((entry) => typeof entry === "string" && entry.length > 0);
}

export class PluginAccessManifestCapture {
  readonly #artifacts = new Map<string, MutableArtifactEntry>();
  readonly #records = new Map<string, MutableRecordEntry>();
  readonly #lookupSources = new Map<string, CapturedLookupSource>();
  readonly #directBaseRecords = new Map<string, BasePluginRecordView>();
  readonly #directStagedRecords = new Map<string, StagedPluginRecordView>();
  readonly #directArtifactVersionIds = new Set<string>();
  readonly #artifactDigests = new Map<string, string>();
  readonly #recordDigests = new Map<string, string>();

  constructor(private readonly input: PluginAnalysisSessionInput) {}

  captureArtifacts(operation: PluginArtifactAccessMode, address: string, artifacts: readonly PluginArtifactView[], completeness: CompletenessReport): void {
    const unique = new Map<string, PluginArtifactView>();
    for (const artifact of artifacts) {
      const identityKey = canonicalJson({ artifact_id: artifact.artifact_id, artifact_version_id: artifact.artifact_version_id });
      const knownDigest = this.#artifactDigests.get(identityKey);
      if (knownDigest !== undefined && knownDigest !== artifact.content_hash) {
        throw sdkError("plugin-sdk:analysis_view_invalid", "One artifact identity resolved to conflicting content digests.", { artifact_id: artifact.artifact_id });
      }
      this.#artifactDigests.set(identityKey, artifact.content_hash);
      unique.set(canonicalJson(artifactIdentity(artifact)), artifact);
    }
    for (const artifact of unique.values()) {
      const key = canonicalJson(artifactIdentity(artifact));
      const existing = this.#artifacts.get(key);
      if (existing) existing.access_modes.add(operation);
      else this.#artifacts.set(key, { ...artifactIdentity(artifact) as { artifact_id: string; artifact_version_id: string; content_hash: string }, access_modes: new Set([operation]) });
      this.#directArtifactVersionIds.add(artifact.artifact_version_id);
    }
    if (operation !== "artifact_read") this.#captureLookup(operation, address, [...unique.values()].map(artifactIdentity), completeness);
  }

  captureRecords(operation: PluginLookupOperation, address: string, records: readonly AnalysisRecordView[], completeness: CompletenessReport): void {
    const unique = new Map<string, AnalysisRecordView>();
    for (const record of records) {
      const identityKey = record.view_type === "base" ? `base_record\u0000${record.record_id}` : `staged_record\u0000${record.staged_record_id}`;
      const recordDigest = record.view_type === "base" ? record.record_digest : record.validated_record_digest;
      const knownDigest = this.#recordDigests.get(identityKey);
      if (knownDigest !== undefined && knownDigest !== recordDigest) {
        throw sdkError("plugin-sdk:analysis_view_invalid", "One record identity resolved to conflicting validated digests.");
      }
      this.#recordDigests.set(identityKey, recordDigest);
      unique.set(canonicalJson(recordIdentity(record)), record);
    }
    for (const record of unique.values()) {
      const identity = recordIdentity(record);
      const key = canonicalJson(identity);
      if (!this.#records.has(key)) this.#records.set(key, identity as unknown as MutableRecordEntry);
      this.#directArtifactVersionIds.add(record.owner_artifact_version_id);
      if (record.view_type === "base") this.#directBaseRecords.set(`${record.record_id}\u0000${record.record_digest}`, record);
      else this.#directStagedRecords.set(`${record.staged_record_id}\u0000${record.validated_record_digest}`, record);
    }
    this.#captureLookup(operation, address, [...unique.values()].map(recordIdentity), completeness);
  }

  #captureLookup(operation: PluginLookupOperation, address: string, results: readonly JsonValue[], completeness: CompletenessReport): void {
    const authoritativeCompleteness = pluginLookupCompleteness(completeness);
    const resultSetDigest = pluginLookupResultSetDigest(operation, address, this.input.analysis_view.analysis_view_digest, authoritativeCompleteness, results);
    this.#lookupSources.set(`${operation}\u0000${address}\u0000${resultSetDigest}`, deepFreeze({ operation, address, results: [...results], completeness: authoritativeCompleteness }));
  }

  async finalize(
    binding: PluginManifestBindingInput,
    closureCall: (call: () => Promise<DependencyClosureResult>) => Promise<DependencyClosureResult>,
  ): Promise<PluginAnalysisFinalizeResult> {
    const closureBase: BasePluginInputRecordEntry[] = [];
    const closureStaged: StagedPluginInputRecordEntry[] = [];
    const transitiveArtifacts = new Set<string>();
    const closureArtifactsByRecord = new Map<string, readonly string[]>();
    const unavailableRecordKeys: string[] = [];
    const mergeClosure = (recordKey: string, closure: DependencyClosureResult): void => {
      if (!validateClosure(closure)) { unavailableRecordKeys.push(recordKey); return; }
      closureBase.push(...closure.base_records);
      closureStaged.push(...closure.staged_records);
      closureArtifactsByRecord.set(recordKey, orderedUnique(closure.artifact_version_ids));
      for (const artifactVersionId of closure.artifact_version_ids) transitiveArtifacts.add(artifactVersionId);
    };

    for (const record of [...this.#directBaseRecords.values()].sort((left, right) => compareUtf8Bytes(left.record_id, right.record_id))) {
      mergeClosure(canonicalJson(recordIdentity(record as AnalysisRecordView)), await closureCall(() => this.input.dependency_closure_port.baseRecordClosure(record.record_id)));
    }
    for (const record of [...this.#directStagedRecords.values()].sort((left, right) => compareUtf8Bytes(left.staged_record_id, right.staged_record_id))) {
      mergeClosure(canonicalJson(recordIdentity(record as AnalysisRecordView)), await closureCall(() => this.input.dependency_closure_port.stagedRecordClosure(record.staged_record_id)));
    }
    if (unavailableRecordKeys.length > 0) {
      if (binding.authorized_conservative_closure === undefined || !validateClosure(binding.authorized_conservative_closure)) {
        throw sdkError("plugin-sdk:dependency_closure_unavailable", "A dependency closure proof was unavailable and no exact conservative fallback was authorized.");
      }
      closureBase.push(...binding.authorized_conservative_closure.base_records);
      closureStaged.push(...binding.authorized_conservative_closure.staged_records);
      for (const artifactVersionId of binding.authorized_conservative_closure.artifact_version_ids) transitiveArtifacts.add(artifactVersionId);
      const fallbackArtifacts = orderedUnique(binding.authorized_conservative_closure.artifact_version_ids);
      for (const recordKey of unavailableRecordKeys) closureArtifactsByRecord.set(recordKey, fallbackArtifacts);
    }

    for (const entry of closureBase) {
      const key = canonicalJson({ input_type: "base_record", record_id: entry.record_id, record_digest: entry.record_digest });
      if (!this.#records.has(key)) this.#records.set(key, { input_type: "base_record", record_id: entry.record_id, record_digest: entry.record_digest });
    }
    for (const entry of closureStaged) {
      const identity = {
        input_type: "staged_record" as const,
        staged_record_id: entry.staged_record_id,
        producing_work_item_id: entry.producing_work_item_id,
        proposal_record_key: entry.proposal_record_key,
        validated_record_digest: entry.validated_record_digest,
      };
      const key = canonicalJson(identity);
      if (!this.#records.has(key)) this.#records.set(key, identity);
    }

    const artifactEntries = [...this.#artifacts.values()].map((entry): PluginCapturedArtifactEntry => ({
      artifact_id: entry.artifact_id,
      artifact_version_id: entry.artifact_version_id,
      content_hash: entry.content_hash,
      access_modes: [...entry.access_modes].sort(compareUtf8Bytes),
    })).sort(compareCanonicalJson);
    const recordEntries = [...this.#records.values()].map((entry): PluginCapturedRecordEntry => entry.input_type === "base_record" ? {
      input_type: "base_record",
      record_id: entry.record_id,
      record_digest: entry.record_digest,
    } : {
      input_type: "staged_record",
      staged_record_id: entry.staged_record_id,
      producing_work_item_id: entry.producing_work_item_id,
      proposal_record_key: entry.proposal_record_key,
      validated_record_digest: entry.validated_record_digest,
    }).sort(compareCanonicalJson);
    const lookupMap = new Map<string, PluginCapturedLookupEntry>();
    for (const source of this.#lookupSources.values()) {
      const results = source.results.map((result): JsonValue => {
        if (result === null || typeof result !== "object" || Array.isArray(result) ||
            ((result as Record<string, JsonValue>)["input_type"] !== "base_record" && (result as Record<string, JsonValue>)["input_type"] !== "staged_record")) return result;
        const closureArtifacts = closureArtifactsByRecord.get(canonicalJson(result)) ?? [];
        return closureArtifacts.length === 0 ? result : { ...result, transitive_artifact_version_ids: closureArtifacts };
      });
      const resultSetDigest = pluginLookupResultSetDigest(source.operation, source.address, this.input.analysis_view.analysis_view_digest, source.completeness, results);
      const entry: PluginCapturedLookupEntry = deepFreeze({
        operation: source.operation,
        normalized_selector_or_address: source.address,
        analysis_view_digest: this.input.analysis_view.analysis_view_digest,
        result_set_digest: resultSetDigest,
        result_count: results.length,
        completeness: source.completeness,
      });
      lookupMap.set(`${source.operation}\u0000${source.address}\u0000${resultSetDigest}`, entry);
    }
    const lookupEntries = [...lookupMap.values()].sort((left, right) =>
      compareUtf8Bytes(left.operation, right.operation) || compareUtf8Bytes(left.normalized_selector_or_address, right.normalized_selector_or_address) || compareUtf8Bytes(left.result_set_digest, right.result_set_digest));
    const transitiveArtifactVersionIds = orderedUnique(transitiveArtifacts);
    const manifestDigestInput: PluginInputAccessManifestDigestInput = {
      request_id: this.input.request_id,
      analysis_view_digest: this.input.analysis_view.analysis_view_digest,
      artifact_version_entries: artifactEntries,
      record_entries: recordEntries,
      lookup_entries: lookupEntries,
      transitive_artifact_version_ids: transitiveArtifactVersionIds,
    };
    const manifest = deepFreeze({
      plugin_input_access_manifest_id: pluginInputAccessManifestId(this.input.request_id, this.input.analysis_view.analysis_view_digest),
      ...manifestDigestInput,
      manifest_digest: pluginInputAccessManifestDigest(manifestDigestInput),
    });
    const inputArtifactVersionIds = orderedUnique([...this.#directArtifactVersionIds, ...transitiveArtifacts]);
    const inputRecordIds = orderedUnique(recordEntries.filter((entry): entry is PluginCapturedBaseRecordEntry => entry.input_type === "base_record").map((entry) => entry.record_id));
    const analysisInputDigest = canonicalSha256({
      request_digest: this.input.request_digest,
      analysis_view_digest: this.input.analysis_view.analysis_view_digest,
      plugin_input_access_manifest_digest: manifest.manifest_digest,
      plugin_id: this.input.plugin_id,
      plugin_version: this.input.plugin_version,
      analysis_digest: this.input.analysis_digest,
      analysis_configuration_digest: this.input.analysis_configuration_digest,
      call: this.input.call,
      call_payload: this.input.call_payload,
    });
    return deepFreeze({ manifest, input_artifact_version_ids: inputArtifactVersionIds, input_record_ids: inputRecordIds, analysis_input_digest: analysisInputDigest });
  }
}
