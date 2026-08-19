import { canonicalBytes, digestBytes } from "@urdira/canonical";
import type {
  ArtifactTombstone,
  ArtifactVersion,
  JsonValue,
  SourceArtifact,
  SourceProviderReadResult,
  SourceProviderResponseEnvelope,
  SourceProviderWatchEvent,
} from "@urdira/contracts";
import type {
  ArtifactTombstoneRecord,
  ArtifactVersionRecord,
  CurrentSourceAbsence,
  CurrentSourceOccurrence,
  SourceIndexCommitInput,
  SourceIndexPublicationInput,
  SourceIndexState,
  SourceObservationBatchRecord,
  SourceObservationRecord,
} from "@urdira/storage";
import { mapWithConcurrency } from "./concurrency.js";
import type { ProviderObservation } from "./directory-provider.js";
import { EngineError } from "./errors.js";
import { sourceObservationBatchDigest } from "./source-batch-digest.js";
import type { SourceProviderOutcome } from "./source-provider.js";

// Bounded I/O concurrency for `readAll`'s per-observation provider reads,
// overridable per call via `SourceIndexApplyInput.io_concurrency` (threaded
// from `apps/urdira`'s `URDIRA_SCAN_IO_CONCURRENCY`, see
// `workspace-indexing-session.ts`). 16 balances real filesystem/network
// providers' typical fd/connection limits against full utilization for large
// workspaces.
const DEFAULT_READ_CONCURRENCY = 16;

const CLOSED_OUTCOMES = new Set<SourceProviderOutcome>(["success", "source_changed", "unavailable", "deadline_exceeded", "resource_exhausted", "cancelled", "failed"]);
const AUTHORITATIVE_DELETE_EVENTS = new Set(["delete", "deleted"]);

type ArtifactVersionInput = Omit<ArtifactVersion, "language_hint" | "valid_to_generation"> & {
  readonly language_hint?: string;
  readonly valid_to_generation?: number;
};
type ArtifactTombstoneInput = Omit<ArtifactTombstone, "valid_to_generation" | "closing_artifact_change_id" | "replacement_artifact_version_id"> & {
  readonly valid_to_generation?: number;
  readonly closing_artifact_change_id?: string;
  readonly replacement_artifact_version_id?: string;
};

export interface SourceIndexApplyInput {
  readonly response: SourceProviderResponseEnvelope;
  readonly read?: (observation: ProviderObservation) => Promise<SourceProviderResponseEnvelope>;
  readonly supports_authoritative_delete_events?: boolean;
  /**
   * The caller may have already parsed `response.payload.observation_batch`
   * (e.g. to read its `batch`/`watermark` fields before calling `apply`).
   * When supplied, `parseBatch` uses it instead of parsing the same JSON
   * string again; digest verification against the batch's authoritative
   * fields still runs unchanged.
   */
  readonly parsed_batch?: unknown;
  /**
   * Maximum number of `read` provider calls in flight at once (default 16).
   * Purely a concurrency bound: the observations actually read, and the
   * result (or thrown error) `readAll` produces, are identical to what a
   * strictly sequential `for await` would have produced -- see `readAll`.
   */
  readonly io_concurrency?: number;
  /**
   * The workspace's current PUBLICATION generation (`workspace_current_state.current_generation`,
   * i.e. the last published snapshot's generation), 0 (or omitted) when the
   * workspace has never published. `applyBatch`/`applyWatch` stamp new
   * `artifact_versions`/`artifact_tombstones` rows with `valid_from_generation`
   * one past `max(this, the stage-1 source counter)` rather than the source
   * counter alone -- see the comment at that computation for why the source
   * counter alone is not a safe proxy for the generation the caller's own
   * upcoming publish will actually use.
   */
  readonly publication_current_generation?: number;
}

export interface SourceIndexApplyResult {
  readonly status: "published" | "equivalent" | "degraded";
  readonly generation: number;
  readonly checkpoint_id?: string;
  readonly retryable?: boolean;
  readonly error_code?: string;
}

export interface SourceIndexWorkspacePort {
  readonly workspaceId: string;
  readonly sourceIndex: {
    getState(): Promise<SourceIndexState | undefined>;
    currentOccurrences(sourceProviderBindingId: string): Promise<readonly CurrentSourceOccurrence[]>;
    currentAbsences(sourceProviderBindingId: string): Promise<readonly CurrentSourceAbsence[]>;
    commit(input: SourceIndexCommitInput): Promise<void>;
  };
  readonly publishCandidate?: (input: SourceIndexPublicationInput) => Promise<void>;
}

interface ValidatedRead {
  readonly observation: ProviderObservation;
  readonly bytes: Uint8Array;
  readonly text?: string;
}

interface PlannedState {
  readonly present: Map<string, CurrentSourceOccurrence>;
  readonly absent: Map<string, CurrentSourceAbsence>;
}

interface ValidatedCoverageScope {
  readonly scope_type: "artifact" | "uri_prefix" | "source_root" | "virtual_collection";
  readonly normalized_scope_key: string;
}

const COVERAGE_SCOPE_TYPES = new Set<ValidatedCoverageScope["scope_type"]>(["artifact", "uri_prefix", "source_root", "virtual_collection"]);

function objectValue(value: JsonValue | undefined, description: string): Record<string, JsonValue> {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EngineError("engine:source_index_result_invalid", `${description} must be an object.`);
  }
  return value as Record<string, JsonValue>;
}

function requiredString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) throw new EngineError("engine:source_index_result_invalid", `${description} must be a non-empty string.`);
  return value;
}

function requiredText(value: unknown, description: string): string {
  if (typeof value !== "string") throw new EngineError("engine:source_index_result_invalid", `${description} must be a string.`);
  return value;
}

function requiredCount(value: unknown, description: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new EngineError("engine:source_index_result_invalid", `${description} must be a non-negative safe integer.`);
  return value;
}

function stableId(kind: string, value: unknown): string {
  return `${kind}:${digestBytes(canonicalBytes(value)).slice("sha256:".length)}`;
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new EngineError("engine:source_index_read_invalid", "Provider content bytes are not canonical base64.");
  }
  // The caller (`readAll`, below) verifies `digestBytes(content) === value.content_hash`
  // immediately after decoding; that content-hash check subsumes a base64
  // round-trip re-encode-and-compare (which would otherwise allocate a second
  // full copy of the decoded bytes on every read for a check the hash already
  // makes redundant).
  return new Uint8Array(Buffer.from(value, "base64"));
}

function decodeText(value: Uint8Array): string | undefined {
  if (value.some((byte) => byte === 0)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
  catch { return undefined; }
}

function parseWatermarks(value: string | undefined): Record<string, string> {
  if (value === undefined) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(parsed)) if (typeof item === "string") result[key] = item;
    return result;
  } catch { return {}; }
}

function sourceStateDigest(state: PlannedState): string {
  const present = [...state.present.entries()].map(([normalized_uri, occurrence]) => ({
    normalized_uri,
    artifact_id: occurrence.artifact.artifact_id,
    artifact_version_id: occurrence.version.artifact_version_id,
    content_hash: occurrence.version.content_hash,
    analysis_metadata_digest: occurrence.version.analysis_metadata_digest,
  })).sort((left, right) => left.normalized_uri.localeCompare(right.normalized_uri));
  const absent = [...state.absent.entries()].map(([normalized_uri, occurrence]) => ({
    normalized_uri,
    artifact_id: occurrence.artifact.artifact_id,
    artifact_tombstone_id: occurrence.tombstone.artifact_tombstone_id,
    absence_kind: occurrence.tombstone.absence_kind,
  })).sort((left, right) => left.normalized_uri.localeCompare(right.normalized_uri));
  return digestBytes(canonicalBytes({ present, absent }));
}

function normalizedPath(uri: string): string | undefined {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri) ? undefined : uri;
}

function validateEnvelope(response: SourceProviderResponseEnvelope, workspaceId: string): SourceProviderOutcome {
  for (const field of ["protocol_version", "request_id", "request_digest", "call", "workspace_id", "source_provider_binding_id", "component_id", "component_version"] as const) requiredString(response[field], `Provider response ${field}`);
  if (response.protocol_version !== "1" || response.workspace_id !== workspaceId || !CLOSED_OUTCOMES.has(response.outcome as SourceProviderOutcome)) {
    throw new EngineError("engine:source_index_result_invalid", "Provider response coordinates or outcome are invalid.");
  }
  if (response.outcome === "success" && response.payload === undefined) throw new EngineError("engine:source_index_result_invalid", "Successful provider response is missing its payload.");
  if (response.outcome !== "success" && response.payload !== undefined) throw new EngineError("engine:source_index_result_invalid", "Failed provider response cannot carry a success payload.");
  return response.outcome as SourceProviderOutcome;
}

function parseObservation(value: unknown, batch: SourceObservationBatchRecord): ProviderObservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new EngineError("engine:source_index_result_invalid", "Provider observation must be an object.");
  const item = value as Record<string, unknown>;
  const observation = {
    source_observation_id: requiredString(item["source_observation_id"], "Observation ID"),
    observation_batch_id: requiredString(item["observation_batch_id"], "Observation batch ID"),
    workspace_id: requiredString(item["workspace_id"], "Observation workspace ID"),
    artifact_id: requiredString(item["artifact_id"], "Observation artifact ID"),
    source_provider_binding_id: requiredString(item["source_provider_binding_id"], "Observation provider binding"),
    source_provider: requiredString(item["source_provider"], "Observation provider"),
    source_provider_version: requiredString(item["source_provider_version"], "Observation provider version"),
    ordering_domain: requiredString(item["ordering_domain"], "Observation ordering domain"),
    observation_mode: requiredString(item["observation_mode"], "Observation mode"),
    observed_state: requiredString(item["observed_state"], "Observation state"),
    observed_content_hash: requiredString(item["observed_content_hash"], "Observation content hash"),
    observed_metadata_digest: requiredString(item["observed_metadata_digest"], "Observation metadata digest"),
    provider_event_token: requiredString(item["provider_event_token"], "Observation event token"),
    provider_sequence: requiredString(item["provider_sequence"], "Observation sequence"),
    observed_at: requiredString(item["observed_at"], "Observation time"),
    received_at: requiredString(item["received_at"], "Observation receipt time"),
    normalized_uri: requiredString(item["normalized_uri"], "Observation URI"),
    provider_version_token: requiredString(item["provider_version_token"], "Observation version token"),
  } satisfies ProviderObservation;
  if (observation.observed_state !== "present" || observation.observation_batch_id !== batch.observation_batch_id
    || observation.workspace_id !== batch.workspace_id || observation.source_provider_binding_id !== batch.source_provider_binding_id
    || observation.source_provider !== batch.source_provider || observation.source_provider_version !== batch.source_provider_version
    || observation.ordering_domain !== batch.ordering_domain || observation.observation_mode !== batch.observation_mode) {
    throw new EngineError("engine:source_index_result_invalid", "Provider observation does not agree with its authoritative batch.");
  }
  return observation;
}

function parseCoverageScopes(batch: SourceObservationBatchRecord): readonly ValidatedCoverageScope[] {
  let parsed: unknown;
  try { parsed = JSON.parse(batch.coverage_scopes); }
  catch { throw new EngineError("engine:source_index_result_invalid", "Batch coverage scopes are not valid JSON."); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new EngineError("engine:source_index_result_invalid", "Batch coverage scopes must be a non-empty array.");
  const scopes = parsed.map((value): ValidatedCoverageScope => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new EngineError("engine:source_index_result_invalid", "Batch coverage scope must be an object.");
    const item = value as Record<string, unknown>;
    if (Object.keys(item).some((key) => !["scope_type", "source_provider_binding_id", "source_provider", "normalized_scope_key"].includes(key))) {
      throw new EngineError("engine:source_index_result_invalid", "Batch coverage scope contains unknown fields.");
    }
    const scopeType = requiredString(item["scope_type"], "Coverage scope type");
    const binding = requiredString(item["source_provider_binding_id"], "Coverage scope provider binding");
    const provider = requiredString(item["source_provider"], "Coverage scope provider");
    const normalizedScopeKey = requiredText(item["normalized_scope_key"], "Coverage scope key");
    if (!COVERAGE_SCOPE_TYPES.has(scopeType as ValidatedCoverageScope["scope_type"]) || binding !== batch.source_provider_binding_id || provider !== batch.source_provider) {
      throw new EngineError("engine:source_index_result_invalid", "Batch coverage scope is unsupported or does not agree with its batch.");
    }
    return { scope_type: scopeType as ValidatedCoverageScope["scope_type"], normalized_scope_key: normalizedScopeKey };
  });
  if (new Set(scopes.map((scope) => `${scope.scope_type}\0${scope.normalized_scope_key}`)).size !== scopes.length) {
    throw new EngineError("engine:source_index_result_invalid", "Batch coverage scopes must be unique.");
  }
  return scopes;
}

function scopeContainsUri(scope: ValidatedCoverageScope, uri: string): boolean {
  if (scope.scope_type === "virtual_collection") return false;
  if (scope.scope_type === "artifact") return uri === scope.normalized_scope_key;
  return scope.normalized_scope_key === "" || uri === scope.normalized_scope_key || uri.startsWith(`${scope.normalized_scope_key}/`);
}

function parseBatch(response: SourceProviderResponseEnvelope, preParsed?: unknown): { readonly batch: SourceObservationBatchRecord; readonly observations: readonly ProviderObservation[]; readonly scopes: readonly ValidatedCoverageScope[]; readonly watermark: string; readonly stable: boolean } {
  if (response.call !== "enumerate" && response.call !== "reconcile") throw new EngineError("engine:source_index_result_invalid", "Batch indexing accepts only enumerate or reconcile responses.");
  const payload = objectValue(response.payload, "Provider batch payload");
  const encoded = requiredString(payload["observation_batch"], "Encoded observation batch");
  let parsed: unknown;
  if (preParsed !== undefined) {
    parsed = preParsed;
  } else {
    try { parsed = JSON.parse(encoded); }
    catch { throw new EngineError("engine:source_index_result_invalid", "Encoded observation batch is not valid JSON."); }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new EngineError("engine:source_index_result_invalid", "Encoded observation batch must be an object.");
  const record = parsed as Record<string, unknown>;
  if (record["batch"] === null || typeof record["batch"] !== "object" || Array.isArray(record["batch"]) || !Array.isArray(record["observations"])) {
    throw new EngineError("engine:source_index_result_invalid", "Encoded observation batch has an invalid shape.");
  }
  const batchValue = record["batch"] as Record<string, unknown>;
  const batch: SourceObservationBatchRecord = {
    observation_batch_id: requiredString(batchValue["observation_batch_id"], "Batch ID"),
    workspace_id: requiredString(batchValue["workspace_id"], "Batch workspace"),
    source_provider_binding_id: requiredString(batchValue["source_provider_binding_id"], "Batch provider binding"),
    source_provider: requiredString(batchValue["source_provider"], "Batch provider"),
    source_provider_version: requiredString(batchValue["source_provider_version"], "Batch provider version"),
    ordering_domain: requiredString(batchValue["ordering_domain"], "Batch ordering domain"),
    observation_mode: requiredString(batchValue["observation_mode"], "Batch observation mode"),
    coverage_scopes: requiredString(batchValue["coverage_scopes"], "Batch coverage scopes"),
    coverage_completeness: requiredString(batchValue["coverage_completeness"], "Batch coverage completeness"),
    deletion_authority: requiredString(batchValue["deletion_authority"], "Batch deletion authority"),
    provider_cursor_before: requiredText(batchValue["provider_cursor_before"], "Batch cursor before"),
    provider_cursor_after: requiredText(batchValue["provider_cursor_after"], "Batch cursor after"),
    started_at: requiredString(batchValue["started_at"], "Batch start time"),
    completed_at: requiredString(batchValue["completed_at"], "Batch completion time"),
    observation_count: requiredCount(batchValue["observation_count"], "Batch observation count"),
    unavailable_count: requiredCount(batchValue["unavailable_count"], "Batch unavailable count"),
    batch_digest: requiredString(batchValue["batch_digest"], "Batch digest"),
  };
  if (batch.workspace_id !== response.workspace_id || batch.source_provider_binding_id !== response.source_provider_binding_id
    || batch.source_provider !== response.component_id || batch.source_provider_version !== response.component_version) {
    throw new EngineError("engine:source_index_result_invalid", "Observation batch does not agree with its response envelope.");
  }
  const observations = (record["observations"] as unknown[]).map((value) => parseObservation(value, batch));
  if (observations.length !== batch.observation_count || new Set(observations.map((value) => value.normalized_uri)).size !== observations.length) {
    throw new EngineError("engine:source_index_result_invalid", "Observation batch count or URI uniqueness is invalid.");
  }
  if (!["complete", "partial", "failed"].includes(batch.coverage_completeness) || !["authoritative", "none"].includes(batch.deletion_authority)) {
    throw new EngineError("engine:source_index_result_invalid", "Observation batch coverage or deletion authority is invalid.");
  }
  if (!["event", "scan", "reconciliation"].includes(batch.observation_mode)) throw new EngineError("engine:source_index_result_invalid", "Observation batch mode is invalid.");
  const scopes = parseCoverageScopes(batch);
  const opaqueScope = scopes.some((scope) => scope.scope_type === "virtual_collection");
  if (!opaqueScope && observations.some((observation) => !scopes.some((scope) => scopeContainsUri(scope, observation.normalized_uri)))) {
    throw new EngineError("engine:source_index_result_invalid", "Observation URI lies outside its advertised coverage scopes.");
  }
  if (sourceObservationBatchDigest({
    workspace_id: batch.workspace_id,
    source_provider_binding_id: batch.source_provider_binding_id,
    source_provider: batch.source_provider,
    source_provider_version: batch.source_provider_version,
    ordering_domain: batch.ordering_domain,
    observation_mode: batch.observation_mode,
    coverage_scopes: batch.coverage_scopes,
    coverage_completeness: batch.coverage_completeness,
    deletion_authority: batch.deletion_authority,
    provider_cursor_before: requiredText(batch.provider_cursor_before, "Batch cursor before"),
    provider_cursor_after: requiredText(batch.provider_cursor_after, "Batch cursor after"),
    observation_count: batch.observation_count,
    unavailable_count: batch.unavailable_count,
  }, observations) !== batch.batch_digest) {
    throw new EngineError("engine:source_index_result_invalid", "Observation batch digest does not match its canonical contents.");
  }
  const start = requiredString(payload["capture_start_fingerprint"], "Capture start fingerprint");
  const end = requiredString(payload["capture_end_fingerprint"], "Capture end fingerprint");
  const stable = payload["stable"] !== false && start === end;
  return { batch, observations, scopes, watermark: requiredString(payload["watermark"], "Provider watermark"), stable };
}

function parseWatchEvents(response: SourceProviderResponseEnvelope): { readonly events: readonly SourceProviderWatchEvent[]; readonly watermark: string } {
  if (response.call !== "watch") throw new EngineError("engine:source_index_result_invalid", "Authoritative individual absence accepts only watch responses.");
  const payload = objectValue(response.payload, "Provider watch payload");
  if (!Array.isArray(payload["events"])) throw new EngineError("engine:source_index_result_invalid", "Provider watch events must be an array.");
  const events = payload["events"].map((value): SourceProviderWatchEvent => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new EngineError("engine:source_index_result_invalid", "Provider watch event must be an object.");
    const item = value as Record<string, JsonValue>;
    return {
      ordering_domain: requiredString(item["ordering_domain"], "Watch ordering domain"),
      event_class: requiredString(item["event_class"], "Watch event class"),
      normalized_uri: requiredString(item["normalized_uri"], "Watch event URI"),
      authority: requiredString(item["authority"], "Watch event authority"),
      ...(typeof item["event_token"] === "string" ? { event_token: item["event_token"] } : {}),
      ...(typeof item["provider_sequence"] === "string" ? { provider_sequence: item["provider_sequence"] } : {}),
    };
  });
  return { events, watermark: requiredString(payload["watermark"], "Watch watermark") };
}

export class GenericSourceIndexer {
  constructor(private readonly workspace: SourceIndexWorkspacePort) {}

  async apply(input: SourceIndexApplyInput): Promise<SourceIndexApplyResult> {
    const outcome = validateEnvelope(input.response, this.workspace.workspaceId);
    const priorState = await this.workspace.sourceIndex.getState();
    if (outcome !== "success") return this.degraded(priorState, `core:source_provider_${outcome}`);
    if (input.response.call === "watch") return await this.applyWatch(input, priorState);
    const result = parseBatch(input.response, input.parsed_batch);
    if (!result.stable) return this.degraded(priorState, "core:source_provider_source_changed");
    const reads = await this.readAll(result.observations, input.read, input.io_concurrency);
    if (reads === undefined) return this.degraded(priorState, "core:source_provider_read_incomplete");
    return await this.applyBatch(result.batch, reads, result.scopes, result.watermark, priorState, input.publication_current_generation ?? 0);
  }

  private degraded(state: SourceIndexState | undefined, errorCode: string): SourceIndexApplyResult {
    return { status: "degraded", generation: state?.current_generation ?? 0, retryable: true, error_code: errorCode };
  }

  // A per-observation outcome tag computed under bounded concurrency (below):
  // every observation is attempted regardless of an earlier one's outcome
  // (concurrency only bounds how many run at once), so the *decision* of
  // which outcome governs the whole batch -- undefined on the first
  // non-success outcome, or a thrown `EngineError` on the first invalid
  // correlation -- is made afterward by scanning the ordered results and
  // taking the FIRST non-"value" entry, exactly reproducing what a strictly
  // sequential `for await` (which stops at that same first failing index and
  // never even attempts later ones) would have returned or thrown.
  private async readAll(observations: readonly ProviderObservation[], read: SourceIndexApplyInput["read"], ioConcurrency = DEFAULT_READ_CONCURRENCY): Promise<readonly ValidatedRead[] | undefined> {
    if (observations.length > 0 && read === undefined) return undefined;
    type ReadOutcome =
      | { readonly kind: "value"; readonly read: ValidatedRead }
      | { readonly kind: "undefined" }
      | { readonly kind: "error"; readonly error: unknown };
    const outcomes = await mapWithConcurrency(observations, ioConcurrency, async (observation): Promise<ReadOutcome> => {
      try {
        const response = await read!(observation);
        const outcome = validateEnvelope(response, this.workspace.workspaceId);
        if (outcome !== "success") return { kind: "undefined" };
        if (response.call !== "read" || response.source_provider_binding_id !== observation.source_provider_binding_id
          || response.component_id !== observation.source_provider || response.component_version !== observation.source_provider_version) {
          throw new EngineError("engine:source_index_read_invalid", "Read response coordinates do not agree with the observation.");
        }
        const payload = objectValue(response.payload, "Provider read payload");
        const value: SourceProviderReadResult = {
          artifact_id: requiredString(payload["artifact_id"], "Read artifact ID"),
          provider_version_token: requiredString(payload["provider_version_token"], "Read provider token"),
          // `content_bytes` is the base64 encoding of the artifact's raw bytes,
          // which is the empty string for a legitimately empty (0-byte) file --
          // that is a valid observed occurrence, not a missing/invalid field, so
          // this must accept an empty string (`requiredText`) rather than reject
          // it (`requiredString`, which conflates "absent" with "empty").
          content_bytes: requiredText(payload["content_bytes"], "Read content bytes"),
          content_hash: requiredString(payload["content_hash"], "Read content hash"),
          byte_length: requiredCount(payload["byte_length"], "Read byte length"),
          metadata_digest: requiredString(payload["metadata_digest"], "Read metadata digest"),
        };
        const content = decodeBase64(value.content_bytes);
        if (value.artifact_id !== observation.artifact_id || value.provider_version_token !== observation.provider_version_token
          || value.content_hash !== observation.observed_content_hash || value.metadata_digest !== observation.observed_metadata_digest
          || value.byte_length !== content.byteLength || digestBytes(content) !== value.content_hash) {
          throw new EngineError("engine:source_index_read_invalid", "Read result does not match the stable observed occurrence.");
        }
        const text = decodeText(content);
        return { kind: "value", read: { observation, bytes: content, ...(text === undefined ? {} : { text }) } };
      } catch (error) {
        return { kind: "error", error };
      }
    });
    const results: ValidatedRead[] = [];
    for (const outcome of outcomes) {
      if (outcome.kind === "error") throw outcome.error;
      if (outcome.kind === "undefined") return undefined;
      results.push(outcome.read);
    }
    return results;
  }

  private async applyBatch(batch: SourceObservationBatchRecord, reads: readonly ValidatedRead[], scopes: readonly ValidatedCoverageScope[], watermark: string, priorState: SourceIndexState | undefined, publicationCurrentGeneration: number): Promise<SourceIndexApplyResult> {
    const current = await this.workspace.sourceIndex.currentOccurrences(batch.source_provider_binding_id);
    const absent = await this.workspace.sourceIndex.currentAbsences(batch.source_provider_binding_id);
    const planned: PlannedState = {
      present: new Map(current.map((value) => [value.artifact.normalized_uri, value])),
      absent: new Map(absent.map((value) => [value.artifact.normalized_uri, value])),
    };
    const complete = batch.coverage_completeness === "complete";
    const mayDelete = complete && batch.deletion_authority === "authoritative";
    // Stamping from the stage-1 source counter alone (`priorState?.current_generation`)
    // is only correct when every publish this workspace has ever made carried
    // a source change, so the two counters advance in lockstep. `publication-authority.ts`'s
    // `buildCandidatePublicationPlan` -> `assertPublicationImmutableRows` derives
    // the generation it actually seals `artifact_versions`/`artifact_tombstones`
    // rows under from the SNAPSHOT chain (last published generation + 1), and
    // conflicts (`storage:publication_conflict`, `mismatched_fields:
    // 'valid_from_generation,artifact_version_payload'`) if an already-durable
    // row's `valid_from_generation` disagrees with that. A plugin-upgrade
    // generation (25e0fd3, docs/decisions/14-plugin-upgrade-relock.md)
    // force-publishes a new snapshot generation over a byte-identical tree --
    // no source change, so the source counter does not advance -- which skews
    // the two counters apart; the NEXT edit's ingest would then stamp one
    // generation behind what its own publish is about to demand and
    // deterministically conflict. Taking the max of the two counters keeps
    // this scan's stamp aligned with whatever generation its own publish will
    // actually seal these rows under, however far that publish-only counter
    // has drifted ahead. A failed publish still self-heals on retry: an
    // equivalent re-ingest of the same content does not restamp existing rows
    // (see `equivalent` below), so nothing here can wedge a workspace twice.
    const generation = Math.max(priorState?.current_generation ?? 0, publicationCurrentGeneration) + 1;
    const artifacts: SourceArtifact[] = [];
    const contents: SourceIndexCommitInput["contents"][number][] = [];
    const observations: SourceObservationRecord[] = [];
    const versionClosures: ArtifactVersionRecord[] = [];
    const versions: ArtifactVersionRecord[] = [];
    const tombstoneClosures: ArtifactTombstoneRecord[] = [];
    const tombstones: ArtifactTombstoneRecord[] = [];
    let changed = false;

    for (const read of reads) {
      const existing = planned.present.get(read.observation.normalized_uri);
      const priorAbsence = planned.absent.get(read.observation.normalized_uri);
      const priorArtifact = existing?.artifact ?? priorAbsence?.artifact;
      if (priorArtifact !== undefined && priorArtifact.artifact_id !== read.observation.artifact_id) {
        throw new EngineError("engine:source_index_result_invalid", "Provider observation artifact identity changed for an existing source address.");
      }
      const equivalent = existing?.version.content_hash === read.observation.observed_content_hash
        && existing.version.analysis_metadata_digest === read.observation.observed_metadata_digest;
      const artifact = priorArtifact ?? this.newArtifact(batch, read.observation);
      if (priorArtifact === undefined) artifacts.push(artifact);
      const observation = this.storedObservation(read.observation, batch);
      observations.push(observation);
      if (equivalent) continue;
      changed = true;
      if (existing) versionClosures.push({ ...existing.version, valid_to_generation: generation });
      const contentBlobId = stableId("content", { content_hash: read.observation.observed_content_hash, byte_length: read.bytes.byteLength });
      const version: ArtifactVersionInput = {
        artifact_version_id: stableId("artifact-version", { artifact_id: artifact.artifact_id, observation_id: observation.source_observation_id, content_hash: read.observation.observed_content_hash }),
        workspace_id: batch.workspace_id,
        artifact_id: artifact.artifact_id,
        content_blob_id: contentBlobId,
        content_hash: read.observation.observed_content_hash,
        byte_length: read.bytes.byteLength,
        encoding: read.text === undefined ? "binary" : "utf-8",
        ...(read.text === undefined ? {} : { language_hint: "text" }),
        analysis_metadata_digest: read.observation.observed_metadata_digest,
        created_from_observation_id: observation.source_observation_id,
        valid_from_generation: generation,
      };
      contents.push({ content_blob_id: contentBlobId, bytes: read.bytes, media_type: read.text === undefined ? "application/octet-stream" : "text/plain; charset=utf-8" });
      versions.push(version);
      if (priorAbsence) {
        const closingChange = stableId("artifact-change", { kind: priorAbsence.tombstone.absence_kind === "excluded" ? "reincluded" : "recreated", batch_id: batch.observation_batch_id, artifact_id: artifact.artifact_id });
        tombstoneClosures.push({ ...priorAbsence.tombstone, valid_to_generation: generation, closing_artifact_change_id: closingChange, replacement_artifact_version_id: version.artifact_version_id });
        planned.absent.delete(read.observation.normalized_uri);
      }
      planned.present.set(read.observation.normalized_uri, { artifact, version });
    }

    if (mayDelete) {
      const observedUris = new Set(reads.map((read) => read.observation.normalized_uri));
      for (const [uri, occurrence] of [...planned.present]) {
        if (observedUris.has(uri) || !scopes.some((scope) => scopeContainsUri(scope, uri))) continue;
        changed = true;
        versionClosures.push({ ...occurrence.version, valid_to_generation: generation });
        const tombstone = this.newTombstone(occurrence, batch, generation, "deleted", { cause_type: "artifact_version", cause_id: occurrence.version.artifact_version_id });
        tombstones.push(tombstone);
        planned.present.delete(uri);
        planned.absent.set(uri, { artifact: occurrence.artifact, tombstone });
      }
    }

    const committedGeneration = changed ? generation : priorState?.current_generation ?? 0;
    const status = complete ? (changed ? "published" : "equivalent") : "degraded";
    const state = this.nextState(priorState, batch.source_provider_binding_id, watermark, committedGeneration, batch.completed_at, planned, batch.observation_batch_id);
    const commitInput: SourceIndexCommitInput = {
      expected_state_revision: priorState?.state_revision ?? 0,
      state,
      batch,
      observations,
      artifacts,
      contents,
      version_closures: versionClosures,
      versions,
      tombstone_closures: tombstoneClosures,
      tombstones,
    };
    if (this.workspace.publishCandidate) await this.workspace.publishCandidate({ source_index: commitInput });
    else await this.workspace.sourceIndex.commit(commitInput);
    return status === "degraded"
      ? { status, generation: committedGeneration, checkpoint_id: state.checkpoint_id, retryable: true, error_code: "core:source_provider_partial_coverage" }
      : { status, generation: committedGeneration, checkpoint_id: state.checkpoint_id };
  }

  private async applyWatch(input: SourceIndexApplyInput, priorState: SourceIndexState | undefined): Promise<SourceIndexApplyResult> {
    const parsed = parseWatchEvents(input.response);
    if (!input.supports_authoritative_delete_events) return this.degraded(priorState, "core:source_provider_delete_authority_unadvertised");
    if (parsed.events.some((event) => event.ordering_domain !== input.response.source_provider_binding_id)) {
      throw new EngineError("engine:source_index_result_invalid", "Watch event ordering domain does not agree with its response.");
    }
    const authoritative = parsed.events.filter((event) => event.authority === "authoritative_delete" && AUTHORITATIVE_DELETE_EVENTS.has(event.event_class));
    if (authoritative.length === 0) return this.degraded(priorState, "core:source_provider_non_authoritative_hint");
    const bindingId = input.response.source_provider_binding_id;
    const current = await this.workspace.sourceIndex.currentOccurrences(bindingId);
    const absences = await this.workspace.sourceIndex.currentAbsences(bindingId);
    const planned: PlannedState = { present: new Map(current.map((value) => [value.artifact.normalized_uri, value])), absent: new Map(absences.map((value) => [value.artifact.normalized_uri, value])) };
    // See `applyBatch`'s identical computation, above, for why the stage-1
    // source counter alone (`priorState?.current_generation`) can fall behind
    // the publish-side generation and why taking the max realigns them; a
    // watch-driven authoritative delete is just as capable of landing right
    // after an upgrade-only publish as a batch scan is.
    const generation = Math.max(priorState?.current_generation ?? 0, input.publication_current_generation ?? 0) + 1;
    const batchId = stableId("observation-batch", { response_id: input.response.request_id, watermark: parsed.watermark, events: authoritative });
    const eventTime = new Date(0).toISOString();
    const resolved = authoritative.flatMap((event) => {
      const occurrence = planned.present.get(event.normalized_uri);
      const absence = planned.absent.get(event.normalized_uri);
      const artifact = occurrence?.artifact ?? absence?.artifact;
      if (artifact === undefined) return [];
      const observation: SourceObservationRecord = {
        source_observation_id: stableId("source-observation", {
          batch_id: batchId,
          artifact_id: artifact.artifact_id,
          ...(event.event_token === undefined ? {} : { event_token: event.event_token }),
          ...(event.provider_sequence === undefined ? {} : { provider_sequence: event.provider_sequence }),
          observed_state: "deleted",
        }),
        observation_batch_id: batchId,
        workspace_id: input.response.workspace_id,
        artifact_id: artifact.artifact_id,
        source_provider_binding_id: bindingId,
        source_provider: input.response.component_id,
        source_provider_version: input.response.component_version,
        ordering_domain: event.ordering_domain,
        observation_mode: "event",
        observed_state: "deleted",
        ...(event.event_token === undefined ? {} : { provider_event_token: event.event_token }),
        ...(event.provider_sequence === undefined ? {} : { provider_sequence: event.provider_sequence }),
        observed_at: eventTime,
        received_at: eventTime,
      };
      return [{ event, occurrence, observation }];
    });
    const unique = [...new Map(resolved.map((value) => [value.observation.source_observation_id, value])).values()];
    if (unique.length === 0) return this.degraded(priorState, "core:source_provider_delete_target_unknown");
    const observations = unique.map(({ observation }) => observation);
    const batch = this.watchBatch(input.response, batchId, parsed.watermark, observations, unique.map(({ event }) => event.normalized_uri));
    const versionClosures: ArtifactVersionRecord[] = [];
    const tombstones: ArtifactTombstoneRecord[] = [];
    for (const { event, occurrence, observation } of unique) {
      if (!occurrence) continue;
      versionClosures.push({ ...occurrence.version, valid_to_generation: generation });
      const tombstone = this.newTombstone(occurrence, batch, generation, "deleted", { cause_type: "source_observation", cause_id: observation.source_observation_id });
      tombstones.push(tombstone);
      planned.present.delete(event.normalized_uri);
      planned.absent.set(event.normalized_uri, { artifact: occurrence.artifact, tombstone });
    }
    const committedGeneration = tombstones.length > 0 ? generation : priorState?.current_generation ?? 0;
    const state = this.nextState(priorState, bindingId, parsed.watermark, committedGeneration, batch.completed_at, planned, batchId);
    const commitInput: SourceIndexCommitInput = { expected_state_revision: priorState?.state_revision ?? 0, state, batch, observations, artifacts: [], contents: [], version_closures: versionClosures, versions: [], tombstone_closures: [], tombstones };
    if (this.workspace.publishCandidate) await this.workspace.publishCandidate({ source_index: commitInput });
    else await this.workspace.sourceIndex.commit(commitInput);
    return { status: tombstones.length > 0 ? "published" : "equivalent", generation: committedGeneration, checkpoint_id: state.checkpoint_id };
  }

  private storedObservation(value: ProviderObservation, batch: SourceObservationBatchRecord): SourceObservationRecord {
    return {
      source_observation_id: stableId("source-observation", { batch_id: batch.observation_batch_id, provider_observation_id: value.source_observation_id, artifact_id: value.artifact_id }),
      observation_batch_id: batch.observation_batch_id,
      workspace_id: batch.workspace_id,
      artifact_id: value.artifact_id,
      source_provider_binding_id: batch.source_provider_binding_id,
      source_provider: batch.source_provider,
      source_provider_version: batch.source_provider_version,
      ordering_domain: batch.ordering_domain,
      observation_mode: batch.observation_mode,
      observed_state: value.observed_state,
      observed_content_hash: value.observed_content_hash,
      observed_metadata_digest: value.observed_metadata_digest,
      provider_event_token: value.provider_event_token,
      provider_sequence: value.provider_sequence,
      observed_at: value.observed_at,
      received_at: value.received_at,
    };
  }

  private newArtifact(batch: SourceObservationBatchRecord, observation: ProviderObservation): SourceArtifact {
    const path = normalizedPath(observation.normalized_uri);
    return {
      artifact_id: observation.artifact_id,
      workspace_id: batch.workspace_id,
      normalized_uri: observation.normalized_uri,
      ...(path === undefined ? {} : { normalized_path: path, display_path: observation.normalized_uri }),
      artifact_kind: batch.source_provider === "core:git_reference_source_provider" ? "virtual_file" : "physical_file",
    };
  }

  private newTombstone(occurrence: CurrentSourceOccurrence, batch: SourceObservationBatchRecord, generation: number, absenceKind: "deleted" | "excluded", cause: { readonly cause_type: "source_observation" | "artifact_version"; readonly cause_id: string }): ArtifactTombstoneInput {
    const openingChange = stableId("artifact-change", { kind: absenceKind, batch_id: batch.observation_batch_id, artifact_id: occurrence.artifact.artifact_id });
    return {
      artifact_tombstone_id: stableId("artifact-tombstone", { artifact_id: occurrence.artifact.artifact_id, batch_id: batch.observation_batch_id, absence_kind: absenceKind }),
      workspace_id: batch.workspace_id,
      artifact_id: occurrence.artifact.artifact_id,
      absence_kind: absenceKind,
      absence_reason_code: absenceKind === "excluded" ? "core:source_excluded" : "core:source_deleted",
      last_artifact_version_id: occurrence.version.artifact_version_id,
      valid_from_generation: generation,
      opening_artifact_change_id: openingChange,
      cause_references: JSON.stringify([cause]),
      lineage_evidence_record_ids: "[]",
    };
  }

  private nextState(prior: SourceIndexState | undefined, bindingId: string, watermark: string, generation: number, updatedAt: string, planned: PlannedState, batchId: string): SourceIndexState {
    const watermarks = parseWatermarks(prior?.provider_watermarks);
    watermarks[bindingId] = watermark;
    const revision = (prior?.state_revision ?? 0) + 1;
    return {
      workspace_id: this.workspace.workspaceId,
      current_generation: generation,
      state_revision: revision,
      checkpoint_id: stableId("freshness-checkpoint", { workspace_id: this.workspace.workspaceId, binding_id: bindingId, watermark, batch_id: batchId, revision }),
      provider_watermarks: JSON.stringify(Object.fromEntries(Object.entries(watermarks).sort(([left], [right]) => left.localeCompare(right)))),
      source_state_digest: sourceStateDigest(planned),
      updated_at: updatedAt,
    };
  }

  private watchBatch(response: SourceProviderResponseEnvelope, batchId: string, watermark: string, observations: readonly SourceObservationRecord[], uris: readonly string[]): SourceObservationBatchRecord {
    const scopes = [...new Set(uris)].sort().map((normalized_scope_key) => ({ scope_type: "artifact", source_provider_binding_id: response.source_provider_binding_id, source_provider: response.component_id, normalized_scope_key }));
    const core = {
      observation_batch_id: batchId,
      workspace_id: response.workspace_id,
      source_provider_binding_id: response.source_provider_binding_id,
      source_provider: response.component_id,
      source_provider_version: response.component_version,
      ordering_domain: response.source_provider_binding_id,
      observation_mode: "event",
      coverage_scopes: JSON.stringify(scopes),
      coverage_completeness: "partial",
      deletion_authority: "none",
      provider_cursor_before: "",
      provider_cursor_after: watermark,
      started_at: new Date(0).toISOString(),
      completed_at: new Date(0).toISOString(),
      observation_count: observations.length,
      unavailable_count: 0,
    };
    return { ...core, batch_digest: sourceObservationBatchDigest(core, observations) };
  }
}
