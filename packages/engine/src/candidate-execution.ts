import { canonicalSha256 } from "@urdira/plugin-sdk";
import type { ArtifactWorkItem, CandidateProjectionTemplate, IndexCandidate, ProjectionWorkItem } from "@urdira/contracts";
import type { PluginAnalysisSession } from "@urdira/plugin-sdk";
import type { AcceptedWorkResult, CandidatePlan, CandidatePlanningWorkItem } from "./candidate-planning.js";
import type { FactDeltaAcceptanceService, ValidatedStagedRecord } from "./fact-delta.js";

export interface CandidateAnalysisContextPort {
  open(workItem: ArtifactWorkItem, stagedEntries: readonly ValidatedStagedRecord[]): Promise<PluginAnalysisSession>;
}

export interface CandidateWorkerPort {
  execute(workItem: ArtifactWorkItem | ProjectionWorkItem, session: PluginAnalysisSession | undefined, signal: AbortSignal): Promise<unknown>;
}

export interface CandidateValidationPort {
  validate(candidate: IndexCandidate, acceptedStagedEntries: readonly ValidatedStagedRecord[]): Promise<void>;
}

export interface AcceptedManifestPersistenceKey {
  readonly fact_delta_id: string;
  readonly plugin_input_access_manifest_id: string;
  readonly manifest_digest: string;
}

export interface AcceptedManifestPersistenceRecord extends AcceptedManifestPersistenceKey {
  readonly manifest: unknown;
}

export interface AcceptedManifestPersistencePort {
  persist(record: AcceptedManifestPersistenceRecord): Promise<void>;
  discard(key: AcceptedManifestPersistenceKey): Promise<void>;
}

export interface CandidateProjectionValidationContext {
  readonly base_artifact_version_ids: readonly string[];
  readonly base_record_ids: readonly string[];
  readonly base_projection_record_ids: readonly string[];
}

export interface CandidateExecutionInput {
  readonly candidate: IndexCandidate;
  readonly plan: CandidatePlan;
  readonly context_port: CandidateAnalysisContextPort;
  readonly worker_port: CandidateWorkerPort;
  readonly acceptance: FactDeltaAcceptanceService;
  readonly cancellation_signal: AbortSignal;
  readonly candidate_validation_port: CandidateValidationPort;
  readonly accepted_manifest_persistence: AcceptedManifestPersistencePort;
  readonly projection_validation_context?: CandidateProjectionValidationContext;
}

export class CandidateExecutionError extends Error {
  readonly code: string;
  readonly phase: "planning" | "analysis" | "projection";
  readonly scope: Readonly<Record<string, unknown>>;

  constructor(code: string, phase: "planning" | "analysis" | "projection", message: string, scope: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "CandidateExecutionError";
    this.code = code;
    this.phase = phase;
    this.scope = scope;
  }
}

function digest(value: unknown): string { return canonicalSha256(value); }

function isProjection(item: CandidatePlanningWorkItem): item is ProjectionWorkItem & { readonly work_item_id: string } {
  return "projection_work_item_id" in item;
}

type AcceptedState = {
  readonly result: AcceptedWorkResult;
  readonly visible: boolean;
  readonly validated_staged_records: readonly ValidatedStagedRecord[];
  readonly fact_delta_id: string | undefined;
  readonly manifest_persistence_key: AcceptedManifestPersistenceKey | undefined;
  readonly validated_artifact_version_ids: readonly string[];
  readonly validated_projection_record_ids: readonly string[];
};

function itemId(item: CandidatePlanningWorkItem): string {
  return isProjection(item) ? item.projection_work_item_id : item.work_item_id;
}

function issueForOutcome(item: CandidatePlanningWorkItem, outcome: string): { readonly code: string; readonly phase: "analysis" | "projection" } {
  const phase = isProjection(item) ? "projection" : "analysis";
  if (outcome === "inputs_incomplete") return { code: "core:plugin_inputs_incomplete", phase };
  if (outcome === "unsupported") return { code: "core:plugin_unsupported", phase };
  if (outcome === "cancelled") return { code: "core:plugin_cancelled", phase };
  if (outcome === "resource_exhausted") return { code: "core:plugin_resource_exhausted", phase };
  if (outcome === "failed") return { code: isProjection(item) ? "core:projection_generator_failed" : "core:analyzer_failed", phase };
  return { code: isProjection(item) ? "core:projection_output_invalid" : "core:analyzer_failed", phase };
}

function executionError(item: CandidatePlanningWorkItem, code: string, message: string, extra: Readonly<Record<string, unknown>> = {}): CandidateExecutionError {
  const phase = isProjection(item) ? "projection" : "analysis";
  const scope = isProjection(item)
    ? { scope_type: "projection", projection_work_item_id: item.projection_work_item_id, ...extra }
    : { scope_type: "work_item", work_item_type: "artifact", work_item_id: item.work_item_id, ...extra };
  return new CandidateExecutionError(code, phase, message, scope);
}

function objectValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactShape(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key)) && keys.every((key) => key in value);
}

function projectionSuccess(
  item: ProjectionWorkItem & { readonly work_item_id: string },
  output: Record<string, unknown>,
  context: CandidateProjectionValidationContext,
): { readonly result: AcceptedWorkResult; readonly projection_record_ids: readonly string[] } {
  const invalid = (message: string, extra: Readonly<Record<string, unknown>> = {}): never => { throw executionError(item, "core:projection_output_invalid", message, extra); };
  if (!exactShape(output, ["outcome", "result_type", "work_item_id", "projection_set"]) || output["outcome"] !== "success" || output["result_type"] !== "projection_set" || output["work_item_id"] !== item.work_item_id || !objectValue(output["projection_set"])) invalid("Projection worker output is not an exact success shape.");
  const set = output["projection_set"] as Record<string, unknown>;
  if (!exactShape(set, ["projections", "projection_set_digest"])) invalid("Projection worker output contains an unknown projection-set field.");
  const projections = set["projections"];
  const projectionSetDigest = set["projection_set_digest"];
  if (!Array.isArray(projections) || typeof projectionSetDigest !== "string" || projectionSetDigest !== digest(projections)) throw executionError(item, "core:projection_digest_mismatch", "Projection set digest does not match its canonical projections.", { expected_digest: digest(projections), actual_digest: projectionSetDigest });
  const expectedFields = ["projection_record_id", "projection_kind", "projection_key", "workspace_id", "owner_artifact_id", "owner_artifact_version_id", "source_artifact_version_ids", "source_record_ids", "source_projection_record_ids", "generator", "generator_version", "generator_configuration_digest", "payload"].sort().join("\0");
  const artifactSources = new Set(context.base_artifact_version_ids);
  const recordSources = new Set(context.base_record_ids);
  const projectionSources = new Set(context.base_projection_record_ids);
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const raw of projections) {
    if (!objectValue(raw) || Object.keys(raw).sort().join("\0") !== expectedFields) invalid("Projection output object has an unknown or missing field.");
    const projection = raw as unknown as CandidateProjectionTemplate;
    for (const field of ["projection_record_id", "projection_kind", "projection_key", "workspace_id", "owner_artifact_id", "owner_artifact_version_id", "generator", "generator_version", "generator_configuration_digest"] as const) if (typeof projection[field] !== "string" || projection[field].length === 0) invalid("Projection identity fields are required.", { projection_record_id: projection.projection_record_id });
    if (projection.projection_kind !== item.projection_kind || projection.workspace_id !== item.workspace_id || projection.owner_artifact_id !== item.owner_artifact_id || projection.owner_artifact_version_id !== item.owner_artifact_version_id || projection.generator !== item.generator || projection.generator_version !== item.generator_version || projection.generator_configuration_digest !== item.generator_configuration_digest) invalid("Projection kind, ownership, or generator identity does not match its work item.", { projection_record_id: projection.projection_record_id, projection_kind: projection.projection_kind });
    const arrays: readonly [string, readonly string[], Set<string>][] = [["source_artifact_version_ids", projection.source_artifact_version_ids, artifactSources], ["source_record_ids", projection.source_record_ids, recordSources], ["source_projection_record_ids", projection.source_projection_record_ids, projectionSources]];
    let sourceCount = 0;
    for (const [field, value, visible] of arrays) {
      if (value.some((entry) => typeof entry !== "string" || entry.length === 0) || new Set(value).size !== value.length) invalid("Projection source bindings must be unique non-empty ID arrays.", { projection_record_id: projection.projection_record_id, validation_kind: field });
      sourceCount += value.length;
      if (value.some((entry) => !visible.has(entry))) invalid("Projection source binding is not visible in the accepted candidate context.", { projection_record_id: projection.projection_record_id, validation_kind: field });
    }
    if (typeof item.owner_artifact_version_id !== "string" || !projection.source_artifact_version_ids.includes(item.owner_artifact_version_id)) invalid("Projection source bindings must include the work-item owner artifact version.", { projection_record_id: projection.projection_record_id, validation_kind: "owner_artifact_version_id" });
    if (sourceCount === 0) invalid("Projection output has no source binding.", { projection_record_id: projection.projection_record_id });
    if (ids.has(projection.projection_record_id) || keys.has(projection.projection_key)) invalid("Projection IDs and keys must be unique across the projection set.", { projection_record_id: projection.projection_record_id });
    ids.add(projection.projection_record_id);
    keys.add(projection.projection_key);
  }
  return { result: { work_item_id: item.work_item_id, result_type: "projection_set", result_digest: projectionSetDigest }, projection_record_ids: [...ids] };
}

async function acceptedDeltaResult(item: ArtifactWorkItem, output: Record<string, unknown>, acceptance: FactDeltaAcceptanceService): Promise<AcceptedState> {
  if (!exactShape(output, ["outcome", "result_type", "work_item_id", "validation_input"]) || output["outcome"] !== "success" || output["result_type"] !== "fact_delta" || output["work_item_id"] !== item.work_item_id || !objectValue(output["validation_input"])) throw executionError(item, "core:analyzer_failed", "Analyzer output must carry an exact validation input.");
  const validationInput = output["validation_input"] as Record<string, unknown>;
  const accepted = await (acceptance as unknown as { accept(value: unknown): Promise<{ delta: { fact_delta_id?: string; delta_digest: string }; input_artifact_version_ids?: readonly string[]; transitive_artifact_version_ids?: readonly string[]; validated_staged_records: readonly ValidatedStagedRecord[] }> }).accept(validationInput);
  if (!objectValue(accepted) || !objectValue(accepted.delta) || typeof accepted.delta.delta_digest !== "string" || !Array.isArray(accepted.validated_staged_records)) throw executionError(item, "core:analyzer_failed", "Analyzer acceptance did not return a validated delta.");
  const rawDelta = objectValue(validationInput["raw_delta"]) ? validationInput["raw_delta"] as Record<string, unknown> : undefined;
  const factDeltaId = typeof accepted.delta.fact_delta_id === "string" ? accepted.delta.fact_delta_id : rawDelta && typeof rawDelta["fact_delta_id"] === "string" ? rawDelta["fact_delta_id"] : undefined;
  return { result: { work_item_id: item.work_item_id, result_type: "fact_delta", result_digest: accepted.delta.delta_digest }, visible: accepted.validated_staged_records.length > 0, validated_staged_records: accepted.validated_staged_records, fact_delta_id: factDeltaId, manifest_persistence_key: undefined, validated_artifact_version_ids: [...(accepted.input_artifact_version_ids ?? []), ...(accepted.transitive_artifact_version_ids ?? [])], validated_projection_record_ids: [] };
}

export class CandidateExecutor {
  async execute(input: CandidateExecutionInput): Promise<readonly AcceptedWorkResult[]> {
    const accepted = new Map<string, AcceptedState>();
    const results: AcceptedWorkResult[] = [];
    const rollback = async (item: CandidatePlanningWorkItem, state: AcceptedState): Promise<void> => {
      if (state.fact_delta_id !== undefined) {
        try {
          await input.acceptance.discard(state.fact_delta_id);
        } finally {
          if (state.manifest_persistence_key !== undefined) await input.accepted_manifest_persistence.discard(state.manifest_persistence_key);
        }
      }
    };
    const run = async (item: CandidatePlanningWorkItem): Promise<AcceptedState | undefined> => {
      if (input.cancellation_signal.aborted) return undefined;
      const prerequisites = input.plan.dag.prerequisites.get(itemId(item)) ?? [];
      const stagedEntries: ValidatedStagedRecord[] = [];
      for (const prerequisite of prerequisites) {
        const state = accepted.get(prerequisite);
        if (state === undefined) throw executionError(item, "core:plugin_inputs_incomplete", "A prerequisite did not produce an accepted result.", { prerequisite_work_item_id: prerequisite });
        if (!state.visible) throw executionError(item, "core:plugin_inputs_incomplete", "A prerequisite has no validated visible output.", { prerequisite_work_item_id: prerequisite });
        stagedEntries.push(...state.validated_staged_records);
      }
      if (item.operation === "close") return { result: { work_item_id: itemId(item), result_type: "closed", result_digest: digest({ work_item_id: itemId(item), operation: "close", work_item_digest: item.work_item_digest }) }, visible: false, validated_staged_records: [], fact_delta_id: undefined, manifest_persistence_key: undefined, validated_artifact_version_ids: [], validated_projection_record_ids: [] };
      const session = isProjection(item) ? undefined : await input.context_port.open(item, stagedEntries);
      const output = await input.worker_port.execute(item, session, input.cancellation_signal);
      if (input.cancellation_signal.aborted) return undefined;
      if (!objectValue(output)) throw executionError(item, issueForOutcome(item, "invalid").code, "Worker returned a non-object result.");
      const outcome = output["outcome"];
      if (typeof outcome !== "string") throw executionError(item, issueForOutcome(item, "invalid").code, "Worker result is missing its closed outcome.");
      if (outcome !== "success") {
        if (!exactShape(output, ["outcome"]) && !exactShape(output, ["outcome", "failure_code"]) && !exactShape(output, ["outcome", "failure_code", "details"])) throw executionError(item, issueForOutcome(item, "invalid").code, "Worker closed result has an unknown field.");
        const issue = issueForOutcome(item, outcome);
        throw executionError(item, issue.code, "Worker closed with " + outcome + ".", { worker_outcome: outcome });
      }
      if (isProjection(item)) {
        const baseContext = input.projection_validation_context;
        const context = {
          base_artifact_version_ids: [...(baseContext?.base_artifact_version_ids ?? []), ...[...accepted.values()].flatMap((state) => state.validated_artifact_version_ids)],
          base_record_ids: [...(baseContext?.base_record_ids ?? []), ...[...accepted.values()].flatMap((state) => state.validated_staged_records.flatMap((entry) => [entry.staged_record_id, entry.proposal_record_key]))],
          base_projection_record_ids: [...(baseContext?.base_projection_record_ids ?? []), ...[...accepted.values()].flatMap((state) => state.validated_projection_record_ids)],
        };
        const projection = projectionSuccess(item, output, context);
        return { result: projection.result, visible: objectValue(output["projection_set"]) && Array.isArray((output["projection_set"] as Record<string, unknown>)["projections"]) && ((output["projection_set"] as Record<string, unknown>)["projections"] as unknown[]).length > 0, validated_staged_records: [], fact_delta_id: undefined, manifest_persistence_key: undefined, validated_artifact_version_ids: [], validated_projection_record_ids: projection.projection_record_ids };
      }
      const state = await acceptedDeltaResult(item, output, input.acceptance);
      if (input.cancellation_signal.aborted) { await rollback(item, state); return undefined; }
      const manifest = (output["validation_input"] as Record<string, unknown>)["accepted_manifest"];
      if (!objectValue(manifest) || typeof manifest["plugin_input_access_manifest_id"] !== "string" || typeof manifest["manifest_digest"] !== "string") throw executionError(item, "core:analysis_context_unavailable", "Accepted FactDelta output must carry its manifest identity and digest.");
      if (state.fact_delta_id === undefined) throw executionError(item, "core:analysis_context_unavailable", "Accepted FactDelta output must carry a FactDelta identity for manifest persistence.");
      const manifestPersistenceKey: AcceptedManifestPersistenceKey = {
        fact_delta_id: state.fact_delta_id,
        plugin_input_access_manifest_id: manifest["plugin_input_access_manifest_id"],
        manifest_digest: manifest["manifest_digest"],
      };
      const stateWithManifest = { ...state, manifest_persistence_key: manifestPersistenceKey };
      try {
        await input.accepted_manifest_persistence.persist({ ...manifestPersistenceKey, manifest });
      } catch (error) {
        await rollback(item, stateWithManifest);
        throw executionError(item, "core:analysis_context_unavailable", "Accepted access manifest persistence failed.", { persistence_error: error instanceof Error ? error.name : "unknown" });
      }
      if (input.cancellation_signal.aborted) { await rollback(item, stateWithManifest); return undefined; }
      return stateWithManifest;
    };
    for (const level of input.plan.dag.levels) {
      const artifacts = level.map((id) => input.plan.dag.work_items.get(id)).filter((item): item is CandidatePlanningWorkItem => item !== undefined && !isProjection(item));
      const projections = level.map((id) => input.plan.dag.work_items.get(id)).filter((item): item is CandidatePlanningWorkItem => item !== undefined && isProjection(item));
      const consume = async (items: readonly CandidatePlanningWorkItem[]): Promise<void> => {
        const entries = await Promise.all(items.map(async (item) => ({ item, state: await run(item) })));
        for (const { item, state } of entries) if (state !== undefined) { accepted.set(itemId(item), state); results.push(Object.freeze(state.result)); }
      };
      await consume(artifacts);
      if (projections.length > 0) {
        await input.candidate_validation_port.validate(input.candidate, [...accepted.values()].flatMap((state) => state.validated_staged_records));
        await consume(projections);
      }
    }
    return Object.freeze(results);
  }
}

export type { AcceptedWorkResult, CandidatePlan };
