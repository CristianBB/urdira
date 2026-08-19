import { canonicalBytes, digestBytes } from "@urdira/canonical";
import type {
  AffectedArtifactEntry,
  AffectedProjectionEntry,
  AffectedRecordEntry,
  ArtifactWorkItem,
  CandidateWorkManifest,
  ChangeCauseReference,
  CompletenessReport,
  IndexCandidate,
  InvalidationPlan,
  JsonValue,
  OrderedSetDescriptor,
  PluginCapabilityDeclaration,
  ProjectionWorkItem,
  RecordArtifactDependency,
  ReplacementScope,
} from "@urdira/contracts";
import type {
  AuthorizedConservativeLookupScope,
  BoundPluginLookupInvalidationDependency,
  ConservativeInvalidationScope,
  PluginInvalidationScope,
} from "@urdira/plugin-sdk";

export interface FrozenCandidateBaseTuple {
  readonly snapshot_id?: string;
  readonly generation?: number;
  readonly registry_snapshot_id?: string;
  readonly resolution_lock_id?: string;
  readonly configuration_revision_id?: string;
  readonly source_state_digest: string;
  readonly source_observation_batch_ids: readonly string[];
  readonly tuple_digest: string;
}

export interface CandidatePlanningSeedChange {
  readonly reference_type: "artifact" | "artifact_version" | "artifact_tombstone" | "configuration_revision" | "registry_snapshot" | "source_observation";
  readonly reference_id: string;
  readonly change_kind: string;
  readonly cause_references: readonly ChangeCauseReference[];
  readonly artifact_id?: string;
  readonly base_artifact_version_id?: string;
  readonly base_tombstone_id?: string;
  readonly target_artifact_version_id?: string;
  readonly target_tombstone_id?: string;
}

export interface BaseCandidateRecord {
  readonly record_id: string;
  readonly record_digest: string;
  readonly workspace_id: string;
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly category: string;
  readonly kind: string;
  readonly universal_kind: string;
  readonly identity_type?: "entity" | "relation" | "diagnostic";
  readonly identity_id?: string;
  readonly identity_key?: string;
  readonly valid_from_generation: number;
}

export interface BaseCandidateProjection {
  readonly projection_record_id: string;
  readonly projection_kind: string;
  readonly projection_key: string;
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly content_digest: string;
  readonly source_artifact_version_ids: readonly string[];
  readonly source_record_ids: readonly string[];
  readonly source_projection_record_ids: readonly string[];
  readonly generator?: string;
  readonly generator_version?: string;
  readonly generator_configuration_digest?: string;
}

export interface ProjectionDependencyEntry {
  readonly projection_record_id: string;
  readonly source_type: "artifact_version" | "record" | "projection";
  readonly source_id: string;
}

export interface CandidateLookupRevalidationSnapshot {
  readonly lookup_dependency_id: string;
  readonly current_result_set_digest: string;
  readonly completeness: "complete" | "policy_limited";
  readonly journal_covers_membership_dimensions: boolean;
  readonly membership_change_kind: "addition" | "removal" | "mutation" | "none";
}

export interface WorkPrerequisite {
  readonly work_item_id: string;
  readonly prerequisite_work_item_id: string;
  readonly reason: "plugin_dependency" | "capability_input" | "staged_record_input" | "projection_source";
}

export interface CandidatePlannerInput {
  readonly candidate: IndexCandidate;
  readonly frozen_base: FrozenCandidateBaseTuple;
  readonly seeds: readonly CandidatePlanningSeedChange[];
  readonly owned_records: readonly BaseCandidateRecord[];
  readonly owned_projections: readonly BaseCandidateProjection[];
  readonly artifact_dependencies: readonly RecordArtifactDependency[];
  readonly projection_dependencies: readonly ProjectionDependencyEntry[];
  readonly lookup_dependencies: readonly BoundPluginLookupInvalidationDependency[];
  readonly lookup_results: readonly CandidateLookupRevalidationSnapshot[];
  readonly plugin_capabilities: readonly PluginCapabilityDeclaration[];
  readonly prerequisites: readonly WorkPrerequisite[];
  readonly fallback_authorizations: readonly AuthorizedConservativeLookupScope[];
  readonly target_registry_snapshot_id: string;
  readonly target_configuration_revision_id: string;
  readonly created_at: string;
  readonly analysis_discovered_scope?: boolean;
}

export interface LookupRevalidationDecision {
  readonly lookup_dependency_id: string;
  readonly consumer_id: string;
  readonly previous_result_set_digest: string;
  readonly current_result_set_digest: string;
  readonly changed: boolean;
  readonly selected_scope: PluginInvalidationScope;
}

export interface CandidateInvalidationPathStep {
  readonly ordinal: number;
  readonly step_type: "seed" | "owner" | "artifact_dependency" | "record_reference" | "projection_source" | "fallback_scope";
  readonly from_reference: { readonly reference_type: string; readonly reference_id: string };
  readonly to_reference: { readonly reference_type: string; readonly reference_id: string };
  readonly dependency_role?: string;
  readonly reason_code: string;
}

export type ExpandedAffectedArtifactEntry = Omit<AffectedArtifactEntry, "invalidation_path"> & { readonly invalidation_path: readonly CandidateInvalidationPathStep[] };
export type ExpandedAffectedRecordEntry = Omit<AffectedRecordEntry, "invalidation_path"> & { readonly invalidation_path: readonly CandidateInvalidationPathStep[] };
export type ExpandedAffectedProjectionEntry = Omit<AffectedProjectionEntry, "invalidation_path"> & { readonly invalidation_path: readonly CandidateInvalidationPathStep[] };

export interface ExpandedInvalidationPlan {
  readonly contract: InvalidationPlan;
  readonly seeds: readonly CandidatePlanningSeedChange[];
  readonly affected_artifacts: readonly ExpandedAffectedArtifactEntry[];
  readonly affected_records: readonly ExpandedAffectedRecordEntry[];
  readonly affected_projections: readonly ExpandedAffectedProjectionEntry[];
  readonly maximum_scope: "targeted" | "plugin" | "workspace";
}

export type CandidatePlanningWorkItem = ArtifactWorkItem | (ProjectionWorkItem & { readonly work_item_id: string });

export interface CandidateExecutionDag {
  readonly levels: readonly (readonly string[])[];
  readonly prerequisites: ReadonlyMap<string, readonly string[]>;
  readonly prerequisite_reasons?: ReadonlyMap<string, readonly WorkPrerequisite[]>;
  readonly dag_digest: string;
  readonly work_items: ReadonlyMap<string, CandidatePlanningWorkItem>;
}

export interface CandidatePlan {
  readonly invalidation: ExpandedInvalidationPlan;
  readonly manifest: CandidateWorkManifest;
  readonly artifact_work_items: readonly ArtifactWorkItem[];
  readonly projection_work_items: readonly ProjectionWorkItem[];
  readonly lookup_decisions: readonly LookupRevalidationDecision[];
  readonly dag: CandidateExecutionDag;
}

export interface AcceptedWorkResult {
  readonly work_item_id: string;
  readonly result_type: "fact_delta" | "projection_set" | "closed";
  readonly result_digest: string;
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function digest(value: unknown): string {
  return digestBytes(canonicalBytes(value));
}

function stableId(kind: string, value: unknown): string {
  return `${kind}:${digest(value).slice("sha256:".length)}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    if (value instanceof Map) {
      for (const [key, entry] of value) {
        deepFreeze(key);
        deepFreeze(entry);
      }
    } else {
      for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    }
  }
  return value;
}

function completeReport(): CompletenessReport {
  return { workspace_snapshot_binding_ids: [], overall_status: "complete", dimensions: [], diagnostic_record_ids: [] };
}

function descriptor(elementType: string, entries: readonly unknown[]): OrderedSetDescriptor {
  const contentDigest = digest(entries);
  return {
    descriptor_id: stableId("ordered-set", { element_type: elementType, content_digest: contentDigest }),
    element_type: elementType,
    element_schema_version: "1",
    comparator_id: "core:canonical_bytes",
    comparator_version: "1",
    entry_count: entries.length,
    content_digest: contentDigest,
  };
}

function seedArtifactId(seed: CandidatePlanningSeedChange): string | undefined {
  if (seed.artifact_id !== undefined) return seed.artifact_id;
  if (seed.reference_type === "artifact") return seed.reference_id;
  return undefined;
}

function reasonFor(changeKind: string, dependent = false): string {
  if (dependent) return changeKind === "deleted" || changeKind === "excluded" ? "core:dependency_deleted" : "core:dependency_updated";
  const reasons: Readonly<Record<string, string>> = {
    created: "core:owner_artifact_created",
    updated: "core:owner_artifact_updated",
    recreated: "core:owner_artifact_recreated",
    reincluded: "core:owner_artifact_reincluded",
    deleted: "core:owner_artifact_deleted",
    excluded: "core:owner_artifact_excluded",
    configuration_changed: "core:configuration_changed",
    registry_changed: "core:registry_changed",
  };
  return reasons[changeKind] ?? "core:dependency_updated";
}

function pathKey(path: readonly CandidateInvalidationPathStep[]): string {
  return JSON.stringify(path.map((step) => [step.step_type, step.from_reference.reference_id, step.to_reference.reference_id, step.dependency_role ?? ""]));
}

function choosePath(current: readonly CandidateInvalidationPathStep[] | undefined, candidate: readonly CandidateInvalidationPathStep[]): readonly CandidateInvalidationPathStep[] {
  if (current === undefined || candidate.length < current.length || (candidate.length === current.length && compareBytes(pathKey(candidate), pathKey(current)) < 0)) return candidate;
  return current;
}

function appendPath(path: readonly CandidateInvalidationPathStep[], step: Omit<CandidateInvalidationPathStep, "ordinal">): readonly CandidateInvalidationPathStep[] {
  return [...path, { ordinal: path.length, ...step }];
}

function assertPlannerContext(input: CandidatePlannerInput): void {
  const candidate = input.candidate;
  if (candidate.workspace_id.length === 0 || candidate.candidate_generation_id.length === 0) throw new TypeError("Candidate planning requires identities.");
  if (candidate.state !== "planning") throw new TypeError("Candidate scope changed after planning; replan is required.");
  if (input.analysis_discovered_scope === true) throw new TypeError("Analysis-time scope discovery requires replan; a manifest cannot widen after planning.");
  if (input.target_registry_snapshot_id !== candidate.target_registry_snapshot_id) throw new TypeError("Candidate target registry is not frozen.");
  if (input.target_configuration_revision_id !== candidate.target_configuration_revision_id) throw new TypeError("Candidate target configuration is not frozen.");
  if (input.frozen_base.snapshot_id !== candidate.base_snapshot_id || input.frozen_base.generation !== candidate.base_generation ||
      input.frozen_base.registry_snapshot_id !== candidate.base_registry_snapshot_id || input.frozen_base.configuration_revision_id !== candidate.base_configuration_revision_id) {
    throw new TypeError("Candidate frozen base does not match the planning base.");
  }
}

function normalizeWorkItem(item: ArtifactWorkItem | ProjectionWorkItem): CandidatePlanningWorkItem {
  if ("work_item_id" in item) return item;
  return { ...item, work_item_id: item.projection_work_item_id };
}

function workId(item: ArtifactWorkItem | ProjectionWorkItem): string {
  return "work_item_id" in item ? item.work_item_id : item.projection_work_item_id;
}

function isProjection(item: CandidatePlanningWorkItem): item is ProjectionWorkItem & { readonly work_item_id: string } {
  return "projection_work_item_id" in item;
}

export function buildCandidateExecutionDag(
  workItems: readonly (ArtifactWorkItem | ProjectionWorkItem)[],
  prerequisites: readonly WorkPrerequisite[],
): CandidateExecutionDag {
  const items = new Map<string, CandidatePlanningWorkItem>();
  for (const raw of workItems) {
    const id = workId(raw);
    if (items.has(id)) throw new TypeError(`Candidate DAG contains duplicate work identity ${id}.`);
    items.set(id, deepFreeze(normalizeWorkItem(raw)));
  }
  const artifactIds = [...items.entries()].filter(([, item]) => !isProjection(item)).map(([id]) => id).sort(compareBytes);
  const prerequisiteSets = new Map<string, Set<string>>([...items.keys()].map((id) => [id, new Set<string>()]));
  for (const edge of prerequisites) {
    if (!items.has(edge.work_item_id)) throw new TypeError(`Candidate DAG prerequisite names unknown work item ${edge.work_item_id}.`);
    if (!items.has(edge.prerequisite_work_item_id)) throw new TypeError(`Candidate DAG has unknown prerequisite ${edge.prerequisite_work_item_id}.`);
    if (edge.work_item_id === edge.prerequisite_work_item_id) throw new TypeError("Candidate DAG contains a cycle.");
    prerequisiteSets.get(edge.work_item_id)!.add(edge.prerequisite_work_item_id);
  }
  for (const [id, item] of items) {
    if (!isProjection(item)) continue;
    for (const artifactId of artifactIds) prerequisiteSets.get(id)!.add(artifactId);
  }

  const remaining = new Set(items.keys());
  const complete = new Set<string>();
  const levels: string[][] = [];
  while (remaining.size > 0) {
    const level = [...remaining].filter((id) => [...prerequisiteSets.get(id)!].every((entry) => complete.has(entry))).sort(compareBytes);
    if (level.length === 0) throw new TypeError("Candidate DAG contains a cycle.");
    levels.push(level);
    for (const id of level) {
      remaining.delete(id);
      complete.add(id);
    }
  }
  const normalizedPrerequisites = new Map([...prerequisiteSets.entries()].sort(([left], [right]) => compareBytes(left, right)).map(([id, values]) => [id, [...values].sort(compareBytes)]));
  const prerequisiteReasons = new Map([...items.keys()].sort(compareBytes).map((id) => [id, prerequisites.filter((edge) => edge.work_item_id === id).sort((left, right) => compareBytes(`${left.prerequisite_work_item_id}\0${left.reason}`, `${right.prerequisite_work_item_id}\0${right.reason}`))]));
  const dagDigest = digest({ levels, prerequisites: [...normalizedPrerequisites] });
  return deepFreeze({ levels, prerequisites: normalizedPrerequisites, prerequisite_reasons: prerequisiteReasons, dag_digest: dagDigest, work_items: new Map([...items.entries()].sort(([left], [right]) => compareBytes(left, right))) });
}

export async function executeCandidateDag(
  dag: CandidateExecutionDag,
  execute: (workItem: CandidatePlanningWorkItem) => Promise<AcceptedWorkResult>,
  accept: (result: AcceptedWorkResult) => Promise<void>,
): Promise<readonly AcceptedWorkResult[]> {
  const accepted: AcceptedWorkResult[] = [];
  for (const level of dag.levels) {
    const results = await Promise.all(level.map(async (id): Promise<AcceptedWorkResult> => {
      const item = dag.work_items.get(id);
      if (item === undefined) throw new TypeError(`Candidate DAG is missing work item ${id}.`);
      if (item.operation === "close") {
        return { work_item_id: id, result_type: "closed", result_digest: digest({ work_item_id: id, operation: "close", work_item_digest: item.work_item_digest }) };
      }
      return execute(item);
    }));
    for (const result of results) {
      if (!level.includes(result.work_item_id)) throw new TypeError(`Worker returned a result for unexpected work item ${result.work_item_id}.`);
      await accept(result);
      accepted.push(deepFreeze(result));
    }
  }
  return deepFreeze(accepted);
}

export class CandidatePlanner {
  plan(input: CandidatePlannerInput): CandidatePlan {
    assertPlannerContext(input);
    const seeds = [...input.seeds].sort((left, right) => compareBytes(`${left.reference_type}\0${left.reference_id}\0${left.change_kind}`, `${right.reference_type}\0${right.reference_id}\0${right.change_kind}`));
    const artifactPaths = new Map<string, readonly CandidateInvalidationPathStep[]>();
    const artifactCauses = new Map<string, readonly ChangeCauseReference[]>();
    const artifactChangeKinds = new Map<string, string>();
    const queue: string[] = [];
    let maximumScope: "targeted" | "plugin" | "workspace" = "targeted";
    for (const seed of seeds) {
      const artifactId = seedArtifactId(seed);
      if (artifactId === undefined) {
        if (seed.reference_type !== "configuration_revision" && seed.reference_type !== "registry_snapshot") continue;
        maximumScope = "workspace";
        const workspaceArtifactIds = new Set([
          ...input.owned_records.map((entry) => entry.owner_artifact_id),
          ...input.owned_projections.map((entry) => entry.owner_artifact_id),
          ...input.artifact_dependencies.flatMap((entry) => [entry.owner_artifact_id, entry.dependency_artifact_id]),
        ]);
        for (const workspaceArtifactId of [...workspaceArtifactIds].sort(compareBytes)) {
          const path: readonly CandidateInvalidationPathStep[] = [{ ordinal: 0, step_type: "seed", from_reference: { reference_type: seed.reference_type, reference_id: seed.reference_id }, to_reference: { reference_type: "artifact", reference_id: workspaceArtifactId }, reason_code: reasonFor(seed.change_kind) }];
          const chosen = choosePath(artifactPaths.get(workspaceArtifactId), path);
          if (chosen !== artifactPaths.get(workspaceArtifactId)) {
            artifactPaths.set(workspaceArtifactId, chosen);
            artifactCauses.set(workspaceArtifactId, seed.cause_references);
            artifactChangeKinds.set(workspaceArtifactId, seed.change_kind);
            queue.push(workspaceArtifactId);
          }
        }
        continue;
      }
      const reference = { reference_type: seed.reference_type, reference_id: seed.reference_id };
      const path: readonly CandidateInvalidationPathStep[] = [{ ordinal: 0, step_type: "seed", from_reference: reference, to_reference: { reference_type: "artifact", reference_id: artifactId }, reason_code: reasonFor(seed.change_kind) }];
      const chosen = choosePath(artifactPaths.get(artifactId), path);
      if (chosen !== artifactPaths.get(artifactId)) {
        artifactPaths.set(artifactId, chosen);
        artifactCauses.set(artifactId, seed.cause_references);
        artifactChangeKinds.set(artifactId, seed.change_kind);
        queue.push(artifactId);
      }
    }

    const dependencies = [...input.artifact_dependencies].sort((left, right) => compareBytes(`${left.dependency_artifact_id}\0${left.owner_artifact_id}\0${left.record_id}`, `${right.dependency_artifact_id}\0${right.owner_artifact_id}\0${right.record_id}`));
    while (queue.length > 0) {
      const dependencyArtifactId = queue.shift()!;
      const basePath = artifactPaths.get(dependencyArtifactId)!;
      for (const entry of dependencies) {
        if (entry.dependency_artifact_id !== dependencyArtifactId) continue;
        const path = appendPath(basePath, {
          step_type: "artifact_dependency",
          from_reference: { reference_type: "artifact", reference_id: dependencyArtifactId },
          to_reference: { reference_type: "artifact", reference_id: entry.owner_artifact_id },
          dependency_role: entry.dependency_role,
          reason_code: reasonFor(artifactChangeKinds.get(dependencyArtifactId) ?? "updated", true),
        });
        const chosen = choosePath(artifactPaths.get(entry.owner_artifact_id), path);
        if (chosen !== artifactPaths.get(entry.owner_artifact_id)) {
          artifactPaths.set(entry.owner_artifact_id, chosen);
          artifactCauses.set(entry.owner_artifact_id, artifactCauses.get(dependencyArtifactId) ?? []);
          artifactChangeKinds.set(entry.owner_artifact_id, "dependency_updated");
          queue.push(entry.owner_artifact_id);
        }
      }
    }

    const lookupResults = new Map(input.lookup_results.map((entry) => [entry.lookup_dependency_id, entry]));
    const fallbackScopes = new Set<ConservativeInvalidationScope>();
    const lookupDecisions: LookupRevalidationDecision[] = [];
    for (const dependency of [...input.lookup_dependencies].sort((left, right) => compareBytes(left.lookup_dependency_id, right.lookup_dependency_id))) {
      const result = lookupResults.get(dependency.lookup_dependency_id);
      if (result === undefined) throw new TypeError(`core:invalidation_plan_incomplete: missing lookup revalidation ${dependency.lookup_dependency_id}.`);
      const changed = result.current_result_set_digest !== dependency.previous_result_set_digest;
      let selectedScope = dependency.invalidation_scope;
      const exactIsProven = result.completeness === "complete" && result.journal_covers_membership_dimensions;
      if (!exactIsProven && (selectedScope === "exact_address" || selectedScope === "exact_selector")) {
        const authorization = input.fallback_authorizations.find((entry) => entry.operation === dependency.operation);
        if (authorization === undefined) throw new TypeError("core:invalidation_plan_incomplete: no authorized conservative lookup fallback.");
        selectedScope = authorization.scope;
      }
      if (selectedScope === "plugin_partition" || selectedScope === "plugin") maximumScope = maximumScope === "workspace" ? "workspace" : "plugin";
      if (selectedScope === "workspace") maximumScope = "workspace";
      if (selectedScope === "plugin_partition" || selectedScope === "plugin" || selectedScope === "workspace") fallbackScopes.add(selectedScope);
      lookupDecisions.push({
        lookup_dependency_id: dependency.lookup_dependency_id,
        consumer_id: dependency.consumer_id,
        previous_result_set_digest: dependency.previous_result_set_digest,
        current_result_set_digest: result.current_result_set_digest,
        changed,
        selected_scope: selectedScope,
      });
      if (changed && dependency.owner_artifact_id !== undefined && !artifactPaths.has(dependency.owner_artifact_id)) {
        const path: readonly CandidateInvalidationPathStep[] = [{
          ordinal: 0,
          step_type: selectedScope === "exact_address" || selectedScope === "exact_selector" ? "record_reference" : "fallback_scope",
          from_reference: { reference_type: "record", reference_id: dependency.consumer_id },
          to_reference: { reference_type: "artifact", reference_id: dependency.owner_artifact_id },
          reason_code: "core:resolution_changed",
        }];
        artifactPaths.set(dependency.owner_artifact_id, path);
        artifactCauses.set(dependency.owner_artifact_id, [{ cause_type: "lookup_dependency", cause_id: dependency.lookup_dependency_id }]);
        artifactChangeKinds.set(dependency.owner_artifact_id, "resolution_changed");
      }
    }

    if (maximumScope !== "targeted") {
      for (const record of input.owned_records) {
        if (artifactPaths.has(record.owner_artifact_id)) continue;
        artifactPaths.set(record.owner_artifact_id, [{ ordinal: 0, step_type: "fallback_scope", from_reference: { reference_type: "workspace", reference_id: input.candidate.workspace_id }, to_reference: { reference_type: "artifact", reference_id: record.owner_artifact_id }, reason_code: "core:resolution_changed" }]);
        artifactCauses.set(record.owner_artifact_id, []);
        artifactChangeKinds.set(record.owner_artifact_id, "resolution_changed");
      }
    }

    const affectedArtifacts: ExpandedAffectedArtifactEntry[] = [...artifactPaths.keys()].sort(compareBytes).map((artifactId) => {
      const kind = artifactChangeKinds.get(artifactId) ?? "updated";
      const directSeed = seeds.find((entry) => seedArtifactId(entry) === artifactId);
      return {
        artifact_id: artifactId,
        ...(directSeed?.target_artifact_version_id === undefined ? {} : { artifact_version_id: directSeed.target_artifact_version_id }),
        required_operation: kind === "deleted" || kind === "excluded" ? "close" : "analyze",
        cause_references: artifactCauses.get(artifactId) ?? [],
        invalidation_path: artifactPaths.get(artifactId)!,
      };
    });

    const affectedRecords: ExpandedAffectedRecordEntry[] = [...input.owned_records].filter((record) => artifactPaths.has(record.owner_artifact_id)).sort((left, right) => compareBytes(left.record_id, right.record_id)).map((record) => {
      const artifactPath = artifactPaths.get(record.owner_artifact_id)!;
      return {
        record_id: record.record_id,
        owner_artifact_id: record.owner_artifact_id,
        owner_artifact_version_id: record.owner_artifact_version_id,
        required_operation: affectedArtifacts.find((entry) => entry.artifact_id === record.owner_artifact_id)?.required_operation === "close" ? "close" : "recompute",
        cause_references: artifactCauses.get(record.owner_artifact_id) ?? [],
        invalidation_path: appendPath(artifactPath, { step_type: "owner", from_reference: { reference_type: "artifact", reference_id: record.owner_artifact_id }, to_reference: { reference_type: "record", reference_id: record.record_id }, reason_code: "core:owner_artifact_updated" }),
      };
    });
    const affectedRecordIds = new Set(affectedRecords.map((entry) => entry.record_id));
    const affectedProjectionIds = new Set<string>();
    for (const projection of input.owned_projections) {
      if (artifactPaths.has(projection.owner_artifact_id) || projection.source_record_ids.some((id) => affectedRecordIds.has(id)) ||
          projection.source_artifact_version_ids.some((id) => affectedArtifacts.some((artifact) => artifact.artifact_version_id === id))) affectedProjectionIds.add(projection.projection_record_id);
    }
    let projectionExpanded = true;
    while (projectionExpanded) {
      projectionExpanded = false;
      for (const entry of input.projection_dependencies) {
        if (entry.source_type === "projection" && affectedProjectionIds.has(entry.source_id) && !affectedProjectionIds.has(entry.projection_record_id)) {
          affectedProjectionIds.add(entry.projection_record_id);
          projectionExpanded = true;
        }
        if (entry.source_type === "record" && affectedRecordIds.has(entry.source_id)) affectedProjectionIds.add(entry.projection_record_id);
      }
    }
    const affectedProjections: ExpandedAffectedProjectionEntry[] = [...input.owned_projections].filter((entry) => affectedProjectionIds.has(entry.projection_record_id)).sort((left, right) => compareBytes(left.projection_record_id, right.projection_record_id)).map((projection) => {
      const basePath = artifactPaths.get(projection.owner_artifact_id) ?? [{ ordinal: 0, step_type: "projection_source" as const, from_reference: { reference_type: "record", reference_id: projection.source_record_ids.find((id) => affectedRecordIds.has(id)) ?? projection.projection_record_id }, to_reference: { reference_type: "projection", reference_id: projection.projection_record_id }, reason_code: "core:dependency_updated" }];
      return {
        projection_record_id: projection.projection_record_id,
        projection_kind: projection.projection_kind,
        owner_artifact_id: projection.owner_artifact_id,
        owner_artifact_version_id: projection.owner_artifact_version_id,
        required_operation: affectedArtifacts.find((entry) => entry.artifact_id === projection.owner_artifact_id)?.required_operation === "close" ? "close" : "rebuild",
        cause_references: artifactCauses.get(projection.owner_artifact_id) ?? [],
        invalidation_path: basePath[basePath.length - 1]?.to_reference.reference_id === projection.projection_record_id ? basePath : appendPath(basePath, { step_type: "projection_source", from_reference: basePath[basePath.length - 1]!.to_reference, to_reference: { reference_type: "projection", reference_id: projection.projection_record_id }, reason_code: "core:dependency_updated" }),
      };
    });

    const dependencyIndexDigest = digest([...dependencies, ...input.projection_dependencies].sort((left, right) => compareBytes(JSON.stringify(left), JSON.stringify(right))));
    const contractPayload = {
      workspace_id: input.candidate.workspace_id,
      candidate_generation_id: input.candidate.candidate_generation_id,
      ...(input.candidate.base_snapshot_id === undefined ? {} : { base_snapshot_id: input.candidate.base_snapshot_id }),
      seed_change_set: descriptor("CandidateSeedChange", seeds),
      affected_artifact_set: descriptor("AffectedArtifactEntry", affectedArtifacts),
      affected_record_set: descriptor("AffectedRecordEntry", affectedRecords),
      affected_projection_set: descriptor("AffectedProjectionEntry", affectedProjections),
      dependency_index_digest: dependencyIndexDigest,
      maximum_scope: maximumScope,
      fallback_scopes: [...fallbackScopes].sort(compareBytes),
      completeness: completeReport(),
      created_at: input.created_at,
    };
    const { created_at: _planCreatedAt, ...planDigestPayload } = contractPayload;
    const planDigest = digest(planDigestPayload);
    const invalidationContract: InvalidationPlan = {
      invalidation_plan_id: stableId("invalidation-plan", { candidate_generation_id: input.candidate.candidate_generation_id, plan_digest: planDigest }),
      ...contractPayload,
      plan_digest: planDigest,
    };

    const declaredPluginGroups = new Map<string, { readonly plugin_id: string; readonly plugin_version: string; readonly capabilities: Set<string> }>();
    for (const declaration of input.plugin_capabilities) {
      const key = `${declaration.plugin_id}\0${declaration.plugin_version}`;
      const group = declaredPluginGroups.get(key) ?? { plugin_id: declaration.plugin_id, plugin_version: declaration.plugin_version, capabilities: new Set<string>() };
      group.capabilities.add(declaration.capability);
      declaredPluginGroups.set(key, group);
    }
    const declaredPlugins = [...declaredPluginGroups.values()].sort((left, right) => compareBytes(`${left.plugin_id}\0${left.plugin_version}`, `${right.plugin_id}\0${right.plugin_version}`));
    const artifactWorkItems: ArtifactWorkItem[] = affectedArtifacts.flatMap((affected) => {
      const seedEntry = seeds.find((entry) => seedArtifactId(entry) === affected.artifact_id);
      const ownedRecord = input.owned_records.find((entry) => entry.owner_artifact_id === affected.artifact_id);
      const priorProducers = new Map<string, { readonly plugin_id: string; readonly plugin_version: string; readonly capabilities: Set<string> }>();
      for (const entry of input.artifact_dependencies.filter((dependency) => dependency.owner_artifact_id === affected.artifact_id)) {
        const key = `${entry.producer_id}\0${entry.producer_version}`;
        if (!priorProducers.has(key)) priorProducers.set(key, { plugin_id: entry.producer_id, plugin_version: entry.producer_version, capabilities: new Set<string>() });
      }
      const plugins = declaredPlugins.length > 0 ? declaredPlugins : [...priorProducers.values()].sort((left, right) => compareBytes(`${left.plugin_id}\0${left.plugin_version}`, `${right.plugin_id}\0${right.plugin_version}`));
      if (plugins.length === 0) throw new TypeError(`core:invalidation_plan_incomplete: no registered producer covers ${affected.artifact_id}.`);
      return plugins.map(({ plugin_id: pluginId, plugin_version: pluginVersion, capabilities: capabilitySet }) => {
        const capabilities = [...capabilitySet].sort(compareBytes);
        const expectedScopes: ReplacementScope[] = affected.required_operation === "close" ? [] : capabilities.map((capabilityName) => {
          const records = input.owned_records.filter((entry) => entry.owner_artifact_id === affected.artifact_id);
          return {
            replacement_scope_id: stableId("replacement-scope", { candidate: input.candidate.candidate_generation_id, artifact_id: affected.artifact_id, plugin_id: pluginId, capability: capabilityName }),
            owner_artifact_id: affected.artifact_id,
            owner_artifact_version_id: seedEntry?.target_artifact_version_id ?? ownedRecord?.owner_artifact_version_id ?? `candidate:${affected.artifact_id}`,
            capability: capabilityName,
            record_categories: [...new Set(records.map((entry) => entry.category))].sort(compareBytes),
            record_kinds: [...new Set(records.map((entry) => entry.kind))].sort(compareBytes),
            base_record_set_digest: digest(records.map((entry) => [entry.record_id, entry.record_digest]).sort((left, right) => compareBytes(String(left[0]), String(right[0])))),
            output_completeness: "complete",
          };
        });
        const payload = {
          workspace_id: input.candidate.workspace_id,
          artifact_id: affected.artifact_id,
          ...(seedEntry?.base_artifact_version_id === undefined && ownedRecord === undefined ? {} : { base_artifact_version_id: seedEntry?.base_artifact_version_id ?? ownedRecord!.owner_artifact_version_id }),
          ...(seedEntry?.base_tombstone_id === undefined ? {} : { base_tombstone_id: seedEntry.base_tombstone_id }),
          ...(affected.required_operation === "analyze" ? { target_artifact_version_id: seedEntry?.target_artifact_version_id ?? ownedRecord?.owner_artifact_version_id ?? `candidate:${affected.artifact_id}` } : { target_tombstone_id: seedEntry?.target_tombstone_id ?? `candidate-tombstone:${affected.artifact_id}` }),
          operation: affected.required_operation,
          plugin_id: pluginId,
          plugin_version: pluginVersion,
          capabilities,
          expected_replacement_scopes: expectedScopes,
          reason_codes: [...new Set(affected.invalidation_path.map((entry) => entry.reason_code))].sort(compareBytes),
          cause_references: affected.cause_references,
          analysis_context_digest: digest({ registry: input.target_registry_snapshot_id, configuration: input.target_configuration_revision_id, plugin_id: pluginId, plugin_version: pluginVersion, capabilities }),
        };
        const workItemDigest = digest(payload);
        return deepFreeze({ work_item_id: stableId("artifact-work", { candidate: input.candidate.candidate_generation_id, artifact_id: affected.artifact_id, plugin_id: pluginId, plugin_version: pluginVersion, work_item_digest: workItemDigest }), ...payload, work_item_digest: workItemDigest } as ArtifactWorkItem);
      });
    }).sort((left, right) => compareBytes(`${left.artifact_id}\0${left.plugin_id}\0${left.plugin_version}`, `${right.artifact_id}\0${right.plugin_id}\0${right.plugin_version}`));

    const projectionWorkItems: ProjectionWorkItem[] = affectedProjections.map((affected) => {
      const base = input.owned_projections.find((entry) => entry.projection_record_id === affected.projection_record_id)!;
      const payload = {
        workspace_id: input.candidate.workspace_id,
        owner_artifact_id: affected.owner_artifact_id,
        ...(affected.required_operation === "rebuild" ? { owner_artifact_version_id: affected.owner_artifact_version_id } : { target_tombstone_id: `candidate-tombstone:${affected.owner_artifact_id}` }),
        projection_kind: affected.projection_kind,
        operation: affected.required_operation,
        generator: base.generator ?? affected.projection_kind,
        generator_version: base.generator_version ?? "1",
        generator_configuration_digest: base.generator_configuration_digest ?? digest({ configuration: input.target_configuration_revision_id, projection_kind: affected.projection_kind }),
        source_selection: { projection_key: base.projection_key } as JsonValue,
        base_projection_set_digest: base.content_digest,
        reason_codes: [...new Set(affected.invalidation_path.map((entry) => entry.reason_code))].sort(compareBytes),
        cause_references: affected.cause_references,
      };
      const workItemDigest = digest(payload);
      return deepFreeze({ projection_work_item_id: stableId("projection-work", { candidate: input.candidate.candidate_generation_id, projection_record_id: affected.projection_record_id, work_item_digest: workItemDigest }), ...payload, work_item_digest: workItemDigest } as ProjectionWorkItem);
    }).sort((left, right) => compareBytes(left.projection_work_item_id, right.projection_work_item_id));

    const dag = buildCandidateExecutionDag([...artifactWorkItems, ...projectionWorkItems], input.prerequisites);
    const artifactWorkSet = descriptor("ArtifactWorkItem", artifactWorkItems);
    const projectionWorkSet = descriptor("ProjectionWorkItem", projectionWorkItems);
    const manifestPayload = {
      ...(input.candidate.work_manifest_id === undefined ? {} : { supersedes_work_manifest_id: input.candidate.work_manifest_id }),
      workspace_id: input.candidate.workspace_id,
      candidate_generation_id: input.candidate.candidate_generation_id,
      ...(input.candidate.base_snapshot_id === undefined ? {} : { base_snapshot_id: input.candidate.base_snapshot_id }),
      artifact_work_set: artifactWorkSet,
      projection_work_set: projectionWorkSet,
      invalidation_plan_id: invalidationContract.invalidation_plan_id,
      target_registry_snapshot_id: input.target_registry_snapshot_id,
      target_configuration_revision_id: input.target_configuration_revision_id,
      created_at: input.created_at,
    };
    const { created_at: _manifestCreatedAt, ...manifestDigestPayload } = manifestPayload;
    const workDigest = digest({ ...manifestDigestPayload, dag_digest: dag.dag_digest });
    const manifest: CandidateWorkManifest = deepFreeze({ work_manifest_id: stableId("work-manifest", { candidate: input.candidate.candidate_generation_id, work_digest: workDigest }), ...manifestPayload, work_digest: workDigest });
    const invalidation: ExpandedInvalidationPlan = deepFreeze({ contract: invalidationContract, seeds, affected_artifacts: affectedArtifacts, affected_records: affectedRecords, affected_projections: affectedProjections, maximum_scope: maximumScope });
    return deepFreeze({ invalidation, manifest, artifact_work_items: artifactWorkItems, projection_work_items: projectionWorkItems, lookup_decisions: lookupDecisions, dag });
  }
}
