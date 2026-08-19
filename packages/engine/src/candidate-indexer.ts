import { canonicalBytes, digestBytes } from "@urdira/canonical";
import type {
  CandidateIssue,
  CandidateMaterialization,
  CandidateWorkManifest,
  GenerationChangeManifest,
  IndexCandidate,
  PluginResolutionLock,
  RegistrySnapshot,
  WorkspaceConfigurationRevision,
  WorkspaceFreshnessCheckpoint,
} from "@urdira/contracts";
import { candidateIssueDefinitions } from "@urdira/contracts";
import { sameFrozenCandidateBaseTuple, type CandidatePublicationInput, type CandidateTemplateSets, type FrozenCandidateBaseTuple } from "@urdira/storage";
import {
  CandidateExecutor,
  type AcceptedWorkResult,
  type CandidateExecutionInput,
} from "./candidate-execution.js";
import {
  CandidateMaterializer,
  type CandidateMaterializationInput,
  type SealedCandidateMaterialization,
} from "./candidate-materialization.js";
import {
  CandidatePlanner,
  type CandidatePlan,
  type CandidatePlannerInput,
} from "./candidate-planning.js";
import type {
  SourceCandidateBase,
  SourceCandidateObservationSet,
  SourceCandidatePlan,
} from "./source-candidate-planning.js";
import { SourceCandidatePlanner } from "./source-candidate-planning.js";

export type CandidateState = "queued" | "planning" | "analyzing" | "validating" | "projecting" | "ready" | "publishing" | "published" | "stale" | "failed" | "cleaning" | "cleaned";

export type CandidateCleanupResource =
  | { readonly resource_type: "candidate_materialization"; readonly resource_id: string }
  | { readonly resource_type: "retention_lease"; readonly resource_id: string }
  | { readonly resource_type: "temporary_projection"; readonly resource_id: string }
  | { readonly resource_type: "temporary_blob"; readonly resource_id: string };

export interface CandidateStatePort {
  insert(candidate: IndexCandidate, frozenBase: FrozenCandidateBaseTuple): Promise<"inserted" | "already_present">;
  get(candidateId: string): Promise<IndexCandidate | undefined>;
  transition(candidateId: string, expected: IndexCandidate["state"], next: IndexCandidate["state"], patch: Readonly<Record<string, unknown>>): Promise<unknown>;
  selectManifest(candidateId: string, manifest: CandidateWorkManifest): Promise<unknown>;
  saveMaterialization(candidateId: string, materialization: CandidateMaterialization, templateSets: CandidateTemplateSets): Promise<"inserted" | "already_present" | unknown>;
  listRecoverable(): Promise<readonly IndexCandidate[]>;
  getFrozenBase?(candidateId: string): Promise<FrozenCandidateBaseTuple | undefined>;
  getMaterialization?(candidateId: string): Promise<CandidateMaterialization | undefined>;
  listRoots?(candidateId: string): Promise<readonly { resource_type: string; root_id: string }[]>;
  getLease?(candidateId: string): Promise<Record<string, unknown> | undefined>;
}

export interface CandidateIssuePort {
  append(issue: CandidateIssue): Promise<void>;
}

export interface CandidateWorkspacePort {
  readonly candidates: CandidateStatePort;
  readonly issues: CandidateIssuePort;
  acquireBaseLease(candidate: IndexCandidate): Promise<void>;
  renewBaseLease(candidateId: string): Promise<void>;
  releaseBaseLease(candidateId: string): Promise<"released" | "already_released">;
  publishCandidate(input: CandidatePublicationInput): Promise<CandidatePublicationResult>;
  committedPublication(candidateId: string): Promise<CandidatePublicationResult | undefined>;
  cleanupResource(candidateId: string, resource: CandidateCleanupResource): Promise<"cleaned" | "already_clean">;
  recordFreshness?(checkpoint: WorkspaceFreshnessCheckpoint): Promise<void>;
  currentBase?(candidateId: string): Promise<FrozenCandidateBaseTuple | undefined>;
}

export interface CandidatePublicationResult {
  readonly candidate_generation_id: string;
  readonly snapshot_id: string;
  readonly generation_manifest_id: string;
  readonly generation: number;
  readonly published_at: string;
  // `discarded_conflict`: a recovery replay's own `run()` call failed with a
  // CONFLICT-class storage error (`isPublicationConflict`, below) -- the
  // candidate was transitioned to `"stale"` and its base lease released
  // (inside `run`'s own catch), and `recover()` swallowed the throw instead
  // of propagating it, so this is a non-fatal recovery outcome, not a
  // publication.
  readonly status: "published" | "already_published" | "discarded_conflict";
}

export interface CandidatePublicationBuilderContext {
  readonly candidate: IndexCandidate;
  readonly frozen_base: FrozenCandidateBaseTuple;
  readonly materialization: CandidateMaterialization;
  readonly template_sets: CandidateTemplateSets;
}

export interface CandidateRunTrigger {
  readonly candidate: IndexCandidate;
  readonly frozen_base: FrozenCandidateBaseTuple;
  readonly source_plan?: SourceCandidatePlan;
  readonly equivalent?: boolean;
  readonly planInput?: Omit<CandidatePlannerInput, "candidate" | "frozen_base">;
  readonly buildPlan?: (candidate: IndexCandidate, frozenBase: FrozenCandidateBaseTuple) => Promise<CandidatePlan> | CandidatePlan;
  readonly executionInput?: Omit<CandidateExecutionInput, "candidate" | "plan">;
  readonly execute?: (candidate: IndexCandidate, plan: CandidatePlan) => Promise<readonly AcceptedWorkResult[]>;
  readonly materializationInput?: Omit<CandidateMaterializationInput, "candidate" | "manifest" | "source_plan">;
  readonly seal?: (context: { readonly candidate: IndexCandidate; readonly plan: CandidatePlan; readonly accepted: readonly AcceptedWorkResult[] }) => Promise<SealedCandidateMaterialization> | SealedCandidateMaterialization;
  readonly publication: CandidatePublicationInput | ((context: CandidatePublicationBuilderContext) => CandidatePublicationInput | Promise<CandidatePublicationInput>);
  readonly cleanup_resources?: readonly CandidateCleanupResource[];
  readonly replan?: (candidate: IndexCandidate, reason: unknown) => CandidateRunTrigger | Promise<CandidateRunTrigger>;
}

export interface CandidateRunResult extends CandidatePublicationResult {
  readonly state: CandidateState;
  readonly replanned_from_candidate_id?: string;
}

export interface CandidateIndexerOptions {
  readonly workspace: CandidateWorkspacePort;
  readonly planner?: CandidatePlanner;
  readonly executor?: CandidateExecutor;
  readonly materializer?: CandidateMaterializer;
  readonly clock?: () => string;
  readonly replan?: (candidate: IndexCandidate, reason: unknown) => CandidateRunTrigger | Promise<CandidateRunTrigger>;
  readonly resume?: (candidate: IndexCandidate) => CandidateRunTrigger | Promise<CandidateRunTrigger> | undefined;
}

export interface CandidateIssueInput {
  readonly candidate_generation_id: string;
  readonly issue_code: string;
  readonly phase: string;
  readonly scope: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly summary: string;
  readonly detail: string;
  readonly cause_references?: string;
  readonly severity?: string;
  readonly retryability?: string;
  readonly created_at?: string;
}

function digest(value: unknown): string { return digestBytes(canonicalBytes(value)); }

/**
 * Maps a sealed materialization's template arrays onto the shape storage
 * expects out-of-band (`CandidateTemplateSets`, `@urdira/storage`), so both
 * `saveMaterialization` (which persists them as CAS-backed segments) and
 * `publishCandidate` (which installs and verifies them against the
 * materialization's committed `OrderedSetDescriptor`s) see the identical
 * arrays this candidate actually sealed.
 */
function templateSetsFromSealed(sealed: SealedCandidateMaterialization): CandidateTemplateSets {
  return {
    source_transitions: sealed.source_transitions,
    record_opens: sealed.record_opens,
    record_closures: sealed.record_closures,
    identity_assignments: sealed.identity_assignments,
    artifact_dependencies: sealed.record_dependencies,
    lookup_dependencies: sealed.lookup_bindings,
    lookup_revalidations: sealed.lookup_revalidations,
  };
}

function now(clock: () => string): string { return clock(); }

function objectValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPayload(code: string, payload: Record<string, unknown>): void {
  const definition = candidateIssueDefinitions.find((entry) => entry.issue_code === code);
  if (!definition) throw new TypeError(`Unknown candidate issue code ${code}.`);
  const schema = definition.payload_schema as unknown as { properties?: Record<string, { type?: string; enum?: readonly unknown[]; minimum?: number }>; required?: readonly string[]; additionalProperties?: boolean };
  const properties = schema.properties ?? {};
  if (schema.additionalProperties === false && Object.keys(payload).some((key) => !(key in properties))) throw new TypeError(`Candidate issue ${code} payload contains an unknown field.`);
  for (const required of schema.required ?? []) if (!(required in payload)) throw new TypeError(`Candidate issue ${code} payload is missing ${required}.`);
  for (const [key, value] of Object.entries(payload)) {
    const property = properties[key];
    if (!property) continue;
    if (property.enum && !property.enum.includes(value)) throw new TypeError(`Candidate issue ${code} payload field ${key} is outside its closed enum.`);
    if (property.type === "string" && typeof value !== "string") throw new TypeError(`Candidate issue ${code} payload field ${key} must be a string.`);
    if (property.type === "integer" && (!Number.isSafeInteger(value) || (property.minimum !== undefined && (value as number) < property.minimum))) throw new TypeError(`Candidate issue ${code} payload field ${key} must be an integer.`);
    if (property.type === "boolean" && typeof value !== "boolean") throw new TypeError(`Candidate issue ${code} payload field ${key} must be boolean.`);
    if (property.type === "array" && !Array.isArray(value)) throw new TypeError(`Candidate issue ${code} payload field ${key} must be an array.`);
  }
}

export function createCandidateIssue(input: CandidateIssueInput): CandidateIssue {
  const definition = candidateIssueDefinitions.find((entry) => entry.issue_code === input.issue_code);
  if (!definition || definition.lifecycle_state === "retired") throw new TypeError(`Unknown or retired candidate issue code ${input.issue_code}.`);
  if (!definition.allowed_phases.includes(input.phase)) throw new TypeError(`Candidate issue ${input.issue_code} cannot be emitted during ${input.phase}.`);
  const severity = input.severity ?? definition.default_severity;
  const retryability = input.retryability ?? definition.default_retryability;
  if (!definition.allowed_severities.includes(severity as never)) throw new TypeError(`Candidate issue ${input.issue_code} severity ${severity} is not allowed.`);
  if (!definition.allowed_retryabilities.includes(retryability as never)) throw new TypeError(`Candidate issue ${input.issue_code} retryability ${retryability} is not allowed.`);
  if (!objectValue(input.scope) || typeof input.scope["scope_type"] !== "string") throw new TypeError("Candidate issue scope must be typed.");
  assertPayload(input.issue_code, input.payload);
  const createdAt = input.created_at ?? new Date().toISOString();
  const causeReferences = input.cause_references ?? "[]";
  let parsedCauses: unknown;
  try { parsedCauses = JSON.parse(causeReferences); } catch { throw new TypeError("Candidate issue cause references must be canonical JSON."); }
  if (!Array.isArray(parsedCauses)) throw new TypeError("Candidate issue cause references must be an array.");
  const issueId = `candidate-issue:${digest({ candidate_generation_id: input.candidate_generation_id, issue_code: input.issue_code, phase: input.phase, scope: input.scope, payload: input.payload })}`;
  return {
    candidate_issue_id: issueId,
    candidate_generation_id: input.candidate_generation_id,
    issue_code: input.issue_code,
    phase: input.phase,
    severity,
    scope: input.scope as unknown as CandidateIssue["scope"],
    retryability,
    summary: input.summary,
    detail: input.detail,
    cause_references: causeReferences,
    payload: input.payload as CandidateIssue["payload"],
    created_at: createdAt,
  };
}

function isPublicationConflict(error: unknown): boolean {
  return objectValue(error) && (error["code"] === "storage:publication_conflict" || error["code"] === "core:publication_conflict");
}

function publicationConflictIssue(candidate: IndexCandidate, error: unknown, clock: () => string): CandidateIssue {
  const details = objectValue(error) ? error : {};
  return createCandidateIssue({
    candidate_generation_id: candidate.candidate_generation_id,
    issue_code: "core:publication_conflict",
    phase: "publication",
    scope: { scope_type: "workspace", workspace_id: candidate.workspace_id },
    payload: {
      workspace_id: candidate.workspace_id,
      conflict_kind: "CURRENT_POINTER_CAS_FAILED",
      ...(typeof details["conflicting_id"] === "string" ? { conflicting_id: details["conflicting_id"] } : {}),
      ...(typeof candidate.base_snapshot_id === "string" ? { current_snapshot_id: candidate.base_snapshot_id } : {}),
    },
    summary: "Candidate publication conflicted with a newer workspace tuple.",
    detail: "The sealed materialization remains immutable and the candidate must be replanned from the current tuple.",
    retryability: "replan",
    created_at: now(clock),
  });
}

function cleanupIssue(candidate: IndexCandidate, resource: CandidateCleanupResource, error: unknown, clock: () => string): CandidateIssue {
  const code = objectValue(error) && typeof error["code"] === "string" ? error["code"] : "cleanup_failed";
  return createCandidateIssue({
    candidate_generation_id: candidate.candidate_generation_id,
    issue_code: "core:candidate_cleanup_failed",
    phase: "cleanup",
    scope: { scope_type: "workspace", workspace_id: candidate.workspace_id },
    payload: { resource_type: resource.resource_type, resource_id: resource.resource_id, cleanup_operation: "release_or_remove", cleanup_error_code: code },
    summary: "Candidate cleanup is incomplete.",
    detail: "Cleanup remains retryable and does not republish or alter the current workspace tuple.",
    retryability: "retry_same",
    created_at: now(clock),
  });
}

export interface StagedSourceBatch {
  readonly status: "pending" | "equivalent" | "degraded";
  readonly plan: SourceCandidatePlan;
  readonly publish: () => Promise<CandidateRunResult | { readonly status: "equivalent"; readonly generation: number }>;
}

export interface StageSourceBatchInput {
  readonly observations: SourceCandidateObservationSet;
  readonly base: SourceCandidateBase;
  readonly trigger: Omit<CandidateRunTrigger, "source_plan">;
  /**
   * When `true`, skip the `plan.equivalent` early-return below even though
   * the planner found no transitions against `base`, and instead fall
   * through to the normal `status: "pending"` path so `publish()` runs the
   * full candidate pipeline. A caller sets this when something OUTSIDE the
   * source tree changed in a way that must still force a new generation --
   * e.g. a plugin/analyzer upgrade (docs/decisions/14-plugin-upgrade-relock.md):
   * decision 09's upgrade clause requires an upgrade to flow through the
   * normal candidate plan and publication pipeline even when zero files
   * changed, and the equivalent short-circuit below never reaches
   * `publish()` at all.
   */
  readonly force_candidate?: boolean;
}

export class CandidateIndexer {
  private readonly planner: CandidatePlanner;
  private readonly executor: CandidateExecutor;
  private readonly materializer: CandidateMaterializer;
  private readonly clock: () => string;

  constructor(private readonly options: CandidateIndexerOptions) {
    this.planner = options.planner ?? new CandidatePlanner();
    this.executor = options.executor ?? new CandidateExecutor();
    this.materializer = options.materializer ?? new CandidateMaterializer();
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async run(trigger: CandidateRunTrigger): Promise<CandidateRunResult> {
    if (trigger.equivalent) {
      if (trigger.source_plan && this.options.workspace.recordFreshness) await this.options.workspace.recordFreshness(trigger.source_plan.next_freshness_checkpoint);
      const generation = trigger.frozen_base.generation ?? 0;
      return { candidate_generation_id: trigger.candidate.candidate_generation_id, snapshot_id: trigger.frozen_base.snapshot_id ?? "", generation_manifest_id: "", generation, published_at: now(this.clock), status: "already_published", state: "published" };
    }
    const candidate = { ...trigger.candidate, state: "queued" } as IndexCandidate;
    await this.options.workspace.candidates.insert(candidate, trigger.frozen_base);
    if (trigger.frozen_base.generation !== undefined) await this.options.workspace.acquireBaseLease(candidate);
    try {
      await this.transition(candidate, "queued", "planning");
      const plan = await this.buildPlan(trigger, candidate);
      await this.options.workspace.candidates.selectManifest(candidate.candidate_generation_id, plan.manifest);
      await this.transition(candidate, "planning", "analyzing", { analysis_started_at: now(this.clock) });
      const accepted = await this.execute(trigger, candidate, plan);
      await this.transition(candidate, "analyzing", "validating");
      await this.transition(candidate, "validating", "projecting");
      const sealed = await this.seal(trigger, candidate, plan, accepted);
      const templateSets = templateSetsFromSealed(sealed);
      await this.options.workspace.candidates.saveMaterialization(candidate.candidate_generation_id, sealed.materialization, templateSets);
      await this.transition(candidate, "projecting", "ready", { ready_at: now(this.clock), candidate_materialization_id: sealed.materialization.candidate_materialization_id, candidate_digest: sealed.materialization.materialization_digest });
      await this.transition(candidate, "ready", "publishing");
      const publicationInput = await this.publicationInput(trigger, candidate, trigger.frozen_base, sealed, templateSets);
      const publication = await this.options.workspace.publishCandidate(publicationInput);
      await this.options.workspace.releaseBaseLease(candidate.candidate_generation_id);
      return { ...publication, state: "published" };
    } catch (error) {
      if (isPublicationConflict(error)) {
        await this.options.workspace.issues.append(publicationConflictIssue(candidate, error, this.clock));
        await this.safeTransition(candidate, "publishing", "stale", { stale_against_snapshot_id: candidate.base_snapshot_id, failure_code: "core:publication_conflict" });
        await this.options.workspace.releaseBaseLease(candidate.candidate_generation_id);
        const replan = trigger.replan ?? this.options.replan;
        if (!replan) throw error;
        const replanned = await replan(candidate, error);
        const result = await this.run(replanned);
        return { ...result, replanned_from_candidate_id: candidate.candidate_generation_id };
      }
      const current = await this.options.workspace.candidates.get(candidate.candidate_generation_id);
      if (current && !["published", "stale", "cleaned"].includes(current.state)) await this.safeTransition(candidate, current.state, "failed", { failure_code: objectValue(error) && typeof error["code"] === "string" ? error["code"] : "core:atomic_publication_failed" });
      try { await this.options.workspace.releaseBaseLease(candidate.candidate_generation_id); } catch (releaseError) {
        await this.options.workspace.issues.append(cleanupIssue(candidate, { resource_type: "retention_lease", resource_id: candidate.retention_lease_id ?? `lease:${candidate.candidate_generation_id}` }, releaseError, this.clock));
      }
      throw error;
    }
  }

  async runBarrier(sequence: readonly CandidateRunTrigger[]): Promise<readonly CandidateRunResult[]> {
    const results: CandidateRunResult[] = [];
    for (const trigger of sequence) results.push(await this.run(trigger));
    return results;
  }

  async stageSourceBatch(input: StageSourceBatchInput): Promise<StagedSourceBatch> {
    const plan = new SourceCandidatePlanner().plan(input.observations, input.base);
    if (input.observations.outcome !== "success" || !input.observations.stable || input.observations.coverage_completeness !== "complete") {
      return { status: "degraded", plan, publish: async () => ({ status: "equivalent", generation: input.base.present.length + input.base.absent.length }) };
    }
    if (plan.equivalent && !input.force_candidate) {
      if (this.options.workspace.recordFreshness) await this.options.workspace.recordFreshness(plan.next_freshness_checkpoint);
      return { status: "equivalent", plan, publish: async () => ({ status: "equivalent", generation: input.base.present.length + input.base.absent.length }) };
    }
    // `force_candidate` with an equivalent (transition-less) plan: freshness
    // is intentionally NOT recorded here (unlike the branch above) -- it
    // will be recorded as part of the forced publish itself, via the same
    // `freshness_checkpoint` the caller's `publication` builder already
    // supplies to `CandidatePublicationInput` (see `runFullWorkspaceScan`'s
    // `staged.plan.next_freshness_checkpoint` usage).
    return { status: "pending", plan, publish: async () => await this.run({ ...input.trigger, source_plan: plan }) };
  }

  async recover(): Promise<readonly CandidateRunResult[]> {
    const recovered: CandidateRunResult[] = [];
    for (const candidate of await this.options.workspace.candidates.listRecoverable()) {
      const committed = await this.options.workspace.committedPublication(candidate.candidate_generation_id);
      if (committed) {
        const current = await this.options.workspace.candidates.get(candidate.candidate_generation_id);
        if (current && current.state !== "published") {
          if (current.state !== "publishing") await this.safeTransition(current, current.state, "publishing");
          await this.safeTransition(current, "publishing", "published", { published_snapshot_id: committed.snapshot_id, published_generation: committed.generation, generation_manifest_id: committed.generation_manifest_id, finished_at: committed.published_at });
        }
        await this.options.workspace.releaseBaseLease(candidate.candidate_generation_id);
        recovered.push({ ...committed, state: "published" });
        continue;
      }
      const frozen = this.options.workspace.candidates.getFrozenBase ? await this.options.workspace.candidates.getFrozenBase(candidate.candidate_generation_id) : undefined;
      const currentBase = this.options.workspace.currentBase ? await this.options.workspace.currentBase(candidate.candidate_generation_id) : frozen;
      if (frozen && currentBase && !sameFrozenCandidateBaseTuple(frozen, currentBase)) {
        // The workspace's live tuple has moved on since THIS candidate's own
        // base was frozen (a later scan published, or the tree changed
        // since this one sealed) -- replaying its sealed materialization
        // into `publishCandidate` is guaranteed to fail with
        // `storage:publication_conflict` (the identical tuple comparison
        // storage itself runs, `WorkspaceDatabase.publishCandidateSerialized`'s
        // `baseAgrees`, `packages/storage/src/storage.ts`). Discard outright
        // -- never `resume`, which would just reuse this now-stale sealed
        // work and hit that same guaranteed conflict; only a `replan` (a
        // brand-new plan built against CURRENT state) is safe here.
        await this.safeTransition(candidate, candidate.state, "stale", { stale_against_snapshot_id: currentBase.snapshot_id, failure_code: "core:publication_conflict" });
        await this.options.workspace.releaseBaseLease(candidate.candidate_generation_id);
        const replan = this.options.replan;
        if (replan) {
          const trigger = await replan(candidate, "recovery_stale");
          if (trigger) recovered.push(await this.replayRecovery(candidate, trigger));
        }
        continue;
      }
      const resume = this.options.resume ? await this.options.resume(candidate) : undefined;
      if (resume) recovered.push(await this.replayRecovery(candidate, resume));
    }
    return recovered;
  }

  /**
   * Runs a recovery replay (`resume`'s or `replan`'s trigger) and, if it
   * fails with a CONFLICT-class storage error, converts that into a
   * non-fatal recovery result instead of letting it escape `recover()`.
   * `run()`'s own `isPublicationConflict` catch already transitions the
   * candidate to `"stale"` and releases its base lease before re-throwing
   * (no `replan` is passed to `run` itself for a recovery attempt) -- a
   * discarded stale candidate is an ordinary, expected recovery outcome,
   * not a failure of recovery as a whole. Before this existed, that
   * re-thrown error propagated straight out of `recover()`'s `for` loop,
   * aborting recovery of every OTHER candidate `listRecoverable()` returned
   * in the same pass too, and (if a caller re-invoked `recover()` to make
   * progress) would throw again on the very next attempt, forever: the
   * "crashed candidate wedge" this method exists to fix.
   */
  private async replayRecovery(candidate: IndexCandidate, trigger: CandidateRunTrigger): Promise<CandidateRunResult> {
    try {
      return { ...(await this.run(trigger)), replanned_from_candidate_id: candidate.candidate_generation_id };
    } catch (error) {
      if (!isPublicationConflict(error)) throw error;
      return { candidate_generation_id: candidate.candidate_generation_id, snapshot_id: "", generation_manifest_id: "", generation: 0, published_at: now(this.clock), status: "discarded_conflict", state: "stale", replanned_from_candidate_id: candidate.candidate_generation_id };
    }
  }

  async cleanup(candidateId: string): Promise<void> {
    const candidate = await this.options.workspace.candidates.get(candidateId);
    if (!candidate) return;
    const resources: readonly CandidateCleanupResource[] = [
      ...(candidate.retention_lease_id ? [{ resource_type: "retention_lease" as const, resource_id: candidate.retention_lease_id }] : []),
      ...(candidate.candidate_materialization_id ? [{ resource_type: "candidate_materialization" as const, resource_id: candidate.candidate_materialization_id }] : []),
      ...((this.options.workspace.candidates.listRoots ? await this.options.workspace.candidates.listRoots(candidateId) : [])
        .flatMap((root): CandidateCleanupResource[] => {
          if (root.resource_type === "temporary_projection" || root.resource_type === "temporary_blob") {
            return [{ resource_type: root.resource_type, resource_id: root.root_id }];
          }
          return [];
        })),
    ];
    const cleanupResources = [...resources];
    if (candidate.state !== "cleaned" && candidate.state !== "cleaning") await this.safeTransition(candidate, candidate.state, "cleaning");
    let failed = false;
    try { await this.options.workspace.releaseBaseLease(candidateId); } catch (error) { failed = true; await this.options.workspace.issues.append(cleanupIssue(candidate, { resource_type: "retention_lease", resource_id: candidate.retention_lease_id ?? `lease:${candidateId}` }, error, this.clock)); }
    for (const resource of cleanupResources) {
      try { await this.options.workspace.cleanupResource(candidateId, resource); } catch (error) { failed = true; await this.options.workspace.issues.append(cleanupIssue(candidate, resource, error, this.clock)); }
    }
    if (!failed) await this.safeTransition(candidate, "cleaning", "cleaned", { finished_at: now(this.clock) });
  }

  private async buildPlan(trigger: CandidateRunTrigger, candidate: IndexCandidate): Promise<CandidatePlan> {
    if (trigger.buildPlan) return await trigger.buildPlan(candidate, trigger.frozen_base);
    if (!trigger.planInput) throw new TypeError("Candidate run is missing planner input.");
    return this.planner.plan({ ...trigger.planInput, candidate, frozen_base: trigger.frozen_base });
  }

  private async execute(trigger: CandidateRunTrigger, candidate: IndexCandidate, plan: CandidatePlan): Promise<readonly AcceptedWorkResult[]> {
    if (trigger.execute) return await trigger.execute(candidate, plan);
    if (!trigger.executionInput) return [];
    return await this.executor.execute({ ...trigger.executionInput, candidate, plan });
  }

  private async seal(trigger: CandidateRunTrigger, candidate: IndexCandidate, plan: CandidatePlan, accepted: readonly AcceptedWorkResult[]): Promise<SealedCandidateMaterialization> {
    if (trigger.seal) return await trigger.seal({ candidate, plan, accepted });
    if (!trigger.materializationInput || !trigger.source_plan) throw new TypeError("Candidate run is missing materialization input or source plan.");
    return this.materializer.seal({ ...trigger.materializationInput, candidate, manifest: plan.manifest, source_plan: trigger.source_plan });
  }

  private async publicationInput(trigger: CandidateRunTrigger, candidate: IndexCandidate, frozenBase: FrozenCandidateBaseTuple, sealed: SealedCandidateMaterialization, templateSets: CandidateTemplateSets): Promise<CandidatePublicationInput> {
    const materialization = sealed.materialization;
    const value = typeof trigger.publication === "function" ? await trigger.publication({ candidate, frozen_base: frozenBase, materialization, template_sets: templateSets }) : trigger.publication;
    return { ...value, candidate: { ...value.candidate, state: "publishing" }, frozen_base: frozenBase, materialization, template_sets: templateSets };
  }

  private async transition(candidate: IndexCandidate, expected: string, next: CandidateState, patch: Readonly<Record<string, unknown>> = {}): Promise<void> {
    await this.options.workspace.candidates.transition(candidate.candidate_generation_id, expected, next, patch);
  }

  private async safeTransition(candidate: IndexCandidate, expected: string, next: CandidateState, patch: Readonly<Record<string, unknown>> = {}): Promise<void> {
    try { await this.transition(candidate, expected, next, patch); } catch { /* recovery and cleanup are repeat-safe */ }
  }
}
