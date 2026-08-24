import { createHash } from "node:crypto";
import { computeDigest, computeDigestOverArrayPayload, digestBytes, digestCanonicalArray, digestLogicalValue, digestMappedCanonicalArray, encodeArrayHeader, encodeCanonical as encodeCanonicalBytes, LogicalDigestWriter, memoizedCanonicalArrayDigest, memoizedPackedIdentityTriple, sortCanonicalValues } from "@urdira/canonical";
import type { CanonicalEncodingLimits } from "@urdira/canonical";
import { comparatorDefinitions } from "@urdira/contracts";
import type { ProjectionSetDigestEntry, Snapshot, WorkspaceCurrentState, IndexCandidate, PluginResolutionLock, RegistrySnapshot, WorkspaceConfigurationRevision, WorkspaceFreshnessCheckpoint } from "@urdira/contracts";
import { StorageError } from "./errors.js";
import type { FaultBoundary, FaultInjector } from "./faults.js";
import type { CandidatePublicationInput, CandidateTemplateSets } from "./candidates.js";
import { frozenCandidateBaseTupleDigest, normalizeObservationBatchIds } from "./candidate-digest.js";
import { timed, timedSync } from "./debug-timing.js";
import { projectionSetDigestEntries, projectionSetDigestRowsByKind, type ProjectionDigestKind, type ProjectionKindDigestRow } from "./lifecycle.js";
import { compactPublicationPhase } from "./publication-compaction.js";
import type { SqliteDatabase, SqliteValue } from "./sqlite.js";
import type { SqliteCommand } from "./sqlite.js";
import { digestRelationalValue, iterateRelationalValue, RelationalValueBatchWriter } from "./relational-values.js";

export type PublicationAuthorityMode = "compatibility" | "candidate";
export type PublicationCommandStream = () => Iterable<SqliteCommand>;

export interface PublicationCommandGroups {
  readonly mode: PublicationAuthorityMode;
  readonly candidateState: readonly SqliteCommand[];
  readonly targetControls: readonly SqliteCommand[];
  readonly source: readonly SqliteCommand[];
  readonly canonical: readonly SqliteCommand[];
  readonly projections: readonly SqliteCommand[];
  readonly manifest: readonly SqliteCommand[];
  readonly snapshot: readonly SqliteCommand[];
  readonly journal: readonly SqliteCommand[];
  readonly candidateFinalization: readonly SqliteCommand[];
  readonly current: readonly SqliteCommand[];
  /** Internal large-publication stream. When present, it replaces the corresponding array. */
  readonly canonicalStream?: PublicationCommandStream;
  readonly projectionsStream?: PublicationCommandStream;
  /**
   * Set only by `buildCandidatePublicationPlan`: this publish's `sortedVisible`
   * (`computeSnapshotDigestFields`'s own output, bit-identical by construction)
   * paired with the `(workspaceId, generation)` it is valid for. Not a
   * transaction command -- `buildPublicationTransactionCommands`/
   * `publicationTransactionCommands` never read it -- it exists purely so
   * `WorkspaceDatabase.publishCandidateSerialized` (`storage.ts`) can pick it
   * up and stash it as the workspace handle's next warm digest corpus, but
   * ONLY after the transaction below actually commits.
   */
  readonly recordSetDigestCorpusCandidate?: RecordSetDigestCorpusEntry;
  /**
   * Set only by `buildCandidatePublicationPlan`: this publish's post-merge
   * per-kind projection row sets (`ProjectionSetDigestCorpusEntry`'s doc
   * comment) paired with the `(workspaceId, generation)` they are valid for.
   * Not a transaction command, exactly like `recordSetDigestCorpusCandidate`
   * above -- `WorkspaceDatabase.publishCandidateSerialized` (`storage.ts`)
   * stashes it as the workspace handle's next warm projection-digest corpus
   * only after the transaction below actually commits.
   */
  readonly projectionSetDigestCorpusCandidate?: ProjectionSetDigestCorpusEntry;
}

/**
 * Per-workspace-handle warm cache of `computeSnapshotDigestFields`'s own
 * `sortedVisible` output (the post-publication visible `{record_id,
 * record_digest}` set, sorted by `record_id`) for one generation, so the NEXT
 * publish can reuse it instead of re-reading the entire visible set from
 * `record_occurrences`. Keyed by `(workspaceId, generation)` so a stale entry
 * -- wrong workspace, or a generation this handle never actually committed --
 * can never be served; the read side (`computeSnapshotDigestFields`) checks
 * both fields before trusting it, and the write side
 * (`WorkspaceDatabase.publishCandidateSerialized`, `storage.ts`) only installs
 * a new entry after its publication transaction commits, so a failed/rolled-
 * back publish leaves the prior (still valid) entry in place rather than
 * poisoning it with never-committed data.
 */
export interface RecordSetDigestCorpusEntry {
  readonly workspaceId: string;
  readonly generation: number;
  readonly sortedVisible: readonly { readonly record_id: string; readonly record_digest: string }[];
}

/**
 * Per-workspace-handle warm cache of the three transactional projection
 * kinds' (graph, dependency, metric) row sets `projectionSetDigestEntries`
 * digests over, mirroring `RecordSetDigestCorpusEntry` one field group per
 * kind instead of one flat array. Keyed by `(workspaceId, generation)` with
 * the identical staleness contract: a corpus entry is trusted only when its
 * `generation` equals the publish's own `oldGeneration` AND its `workspaceId`
 * matches, and is only installed by `WorkspaceDatabase.publishCandidateSerialized`
 * (`storage.ts`) after that publish's transaction actually commits.
 *
 * Exactly like the record corpus: `computeSnapshotDigestFields` merges this
 * publish's own `artifact_dependencies` opens (`artifactDependencyDigestOpens`)
 * into the old (pre-transaction) rows -- corpus-sourced or freshly read via
 * `projectionSetDigestRowsByKind` -- via `mergeProjectionKindRows`, and that
 * SAME merged row set is used BOTH for this publish's own
 * `projection_set_digests` field AND as the entry stashed here for the next
 * publish. This matters because the post-publication visible set genuinely
 * includes the rows this publish's own transaction is about to write --
 * `record_occurrences` gets the identical treatment for `canonical_record_set_digest`
 * (`recordOpens`/`recordClosures` folded into `sortedVisible`), and
 * `projection_set_digests` must describe the same "as of right after this
 * publish" state, not "as of strictly before it". (Before this discipline
 * was added, the dependency kind's digest here came from the pre-transaction
 * rows ALONE -- a real bug: stored dependency digests lagged one publish
 * behind, confirmed against a live bench workspace, where `verify()`
 * recomputing against currently-committed state disagreed with what an
 * earlier generation's snapshot had stored. Snapshots published under that
 * older code keep their lagging value permanently -- snapshots are immutable
 * -- so `verify()` can still report `storage:projection_set_digest_corrupt`
 * for a PRE-FIX historic generation; only snapshots published by the fixed
 * code are guaranteed to verify cleanly.)
 *
 * Only the "dependency" kind (`artifact_dependencies`) has a derivable delta
 * today: `buildCandidatePublicationPlan` writes it from
 * `CandidateTemplateSets.artifact_dependencies`, insert-only (this codebase
 * has no closure path for the table at all -- `CandidateTemplateSets` has no
 * closure-shaped field for it). "graph" (`graph_edges`) and "metric"
 * (`metric_projections`) have NO template input anywhere in
 * `CandidatePublicationInput`/`CandidateTemplateSets` -- structurally, an
 * ordinary candidate publish cannot write either table -- so their delta is
 * unconditionally empty and their corpus rows simply carry forward
 * unchanged. If a future change ever adds a template-driven write path for
 * either table, `computeSnapshotDigestFields`'s delta derivation for that
 * kind must be updated in the same change, or that kind's cache will go
 * silently stale.
 */
export interface ProjectionSetDigestCorpusEntry {
  readonly workspaceId: string;
  readonly generation: number;
  readonly sortedByKind: Readonly<Record<ProjectionDigestKind, readonly ProjectionKindDigestRow[]>>;
}

// Integrity escape hatch, mirroring the `URDIRA_*` kill-switch style in
// `apps/urdira/src/index.ts` (e.g. `workspaceForkEnabled`/`lexicalThreadEnabled`):
// default ON, and `URDIRA_DIGEST_CORPUS=0` (or `false`/`off`/`no`) forces every
// `computeSnapshotDigestFields` call back onto the unconditional SQL re-read,
// bypassing the warm corpus entirely -- e.g. to rule the corpus out when
// diagnosing a `canonical_record_set_digest` mismatch. Read per call (not
// cached at module load) so it composes with tests that flip it via
// `process.env` around a single call.
function digestCorpusEnabled(): boolean {
  const raw = process.env["URDIRA_DIGEST_CORPUS"];
  if (raw === undefined || raw === "") return true;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

export type PublicationPhaseBuilder = () => readonly SqliteCommand[];

export interface PublicationPhaseBuilders {
  readonly candidateState?: PublicationPhaseBuilder;
  readonly targetControls?: PublicationPhaseBuilder;
  readonly source?: PublicationPhaseBuilder;
  readonly canonical?: PublicationPhaseBuilder;
  readonly canonicalStream?: PublicationCommandStream;
  readonly projections?: PublicationPhaseBuilder;
  readonly projectionsStream?: PublicationCommandStream;
  readonly manifest?: PublicationPhaseBuilder;
  readonly snapshot?: PublicationPhaseBuilder;
  readonly journal?: PublicationPhaseBuilder;
  readonly candidateFinalization?: PublicationPhaseBuilder;
  readonly current: PublicationPhaseBuilder;
}

export interface PublicationPlanInput {
  readonly mode: PublicationAuthorityMode;
  readonly phases: PublicationPhaseBuilders;
}

export interface CompatibilityPublicationPlanInput {
  readonly workspaceId: string;
  readonly input: {
    readonly snapshot: Omit<Snapshot, "parent_snapshot_id"> & { readonly parent_snapshot_id?: string };
    readonly current_state: WorkspaceCurrentState;
    readonly expected_current_state?: WorkspaceCurrentState;
  };
}

export function buildCompatibilityPublicationPlan(planInput: CompatibilityPublicationPlanInput): PublicationCommandGroups {
  const { workspaceId, input } = planInput;
      const { snapshot, current_state: currentState } = input;
      const parentSnapshotId = snapshot.parent_snapshot_id ?? null;
      const expected = input.expected_current_state;
      const tupleAgreement = `
        AND ? IS ? AND ? IS ? AND ? IS ? AND ? IS ?
        AND ? IS ? AND ? IS ? AND ? IS ?`;
      const tupleAgreementParams: SqliteValue[] = [
        snapshot.workspace_id, currentState.workspace_id, snapshot.workspace_id, workspaceId,
        snapshot.generation, currentState.current_generation, currentState.current_snapshot_id, snapshot.snapshot_id,
        currentState.current_registry_snapshot_id, snapshot.registry_snapshot_id, currentState.current_resolution_lock_id, snapshot.resolution_lock_id,
        currentState.current_configuration_revision_id, snapshot.configuration_revision_id,
      ];
      const expectedClause = expected ? `
        AND current.current_snapshot_id IS ? AND current.current_generation IS ?
        AND current.current_registry_snapshot_id IS ? AND current.current_resolution_lock_id IS ?
        AND current.current_configuration_revision_id IS ? AND current.current_freshness_checkpoint_id IS ?
        AND current.state_revision IS ?` : "";
      const expectedParams: SqliteValue[] = expected ? [
        expected.current_snapshot_id, expected.current_generation, expected.current_registry_snapshot_id,
        expected.current_resolution_lock_id, expected.current_configuration_revision_id, expected.current_freshness_checkpoint_id,
        expected.state_revision,
      ] : [];
      const registryAgreement = `
        AND EXISTS (SELECT 1 FROM registry_snapshots AS registry
          WHERE registry.workspace_id IS ? AND registry.registry_snapshot_id IS ? AND registry.resolution_lock_id IS ?)`;
      const registryParams: SqliteValue[] = [workspaceId, snapshot.registry_snapshot_id, snapshot.resolution_lock_id];
      const controlAgreement = `
        AND EXISTS (SELECT 1 FROM control_plane_state AS lock_state
          WHERE lock_state.workspace_id IS ? AND lock_state.state_kind IS 'plugin_resolution_lock'
            AND lock_state.state_key IS ?)
        AND EXISTS (SELECT 1 FROM control_plane_state AS configuration_state
          WHERE configuration_state.workspace_id IS ? AND configuration_state.state_kind IS 'workspace_configuration_revision'
            AND configuration_state.state_key IS ?)
        AND EXISTS (SELECT 1 FROM control_plane_state AS freshness_state
          WHERE freshness_state.workspace_id IS ? AND freshness_state.state_kind IS 'workspace_freshness_checkpoint'
            AND freshness_state.state_key IS ?
            AND freshness_state.reference_workspace_id IS ?
            AND freshness_state.reference_snapshot_id IS ?
            AND freshness_state.reference_source_state_digest IS ?)`;
      const controlParams: SqliteValue[] = [
        workspaceId, `plugin_resolution_lock:${snapshot.resolution_lock_id}`,
        workspaceId, `workspace_configuration_revision:${snapshot.configuration_revision_id}`,
        workspaceId, `workspace_freshness_checkpoint:${currentState.current_freshness_checkpoint_id}`, workspaceId, currentState.current_snapshot_id, snapshot.source_state_digest,
      ];
      const snapshotExact = `
        AND EXISTS (SELECT 1 FROM snapshots AS stored
          WHERE stored.snapshot_id IS ? AND stored.workspace_id IS ? AND stored.generation IS ?
            AND stored.parent_snapshot_id IS ? AND stored.generation_manifest_id IS ?
            AND stored.registry_snapshot_id IS ? AND stored.resolution_lock_id IS ?
            AND stored.configuration_revision_id IS ? AND stored.source_state_digest IS ?
            AND stored.source_observation_watermarks IS ? AND stored.canonical_record_set_digest IS ?
            AND stored.projection_set_digests IS ? AND stored.capability_state_digest IS ?
            AND stored.published_at IS ? AND stored.snapshot_digest IS ?)`;
      const snapshotExactParams: SqliteValue[] = [
        snapshot.snapshot_id, snapshot.workspace_id, snapshot.generation, parentSnapshotId, snapshot.generation_manifest_id,
        snapshot.registry_snapshot_id, snapshot.resolution_lock_id, snapshot.configuration_revision_id, snapshot.source_state_digest,
        snapshot.source_observation_watermarks, snapshot.canonical_record_set_digest, snapshot.projection_set_digests,
        snapshot.capability_state_digest, snapshot.published_at, snapshot.snapshot_digest,
      ];
      const currentTransition = `
        AND (
          (NOT EXISTS (SELECT 1 FROM workspace_current_state WHERE workspace_id IS ?)
            AND ? IS 1 AND ? IS NULL AND ? > 0)
          OR EXISTS (SELECT 1 FROM workspace_current_state AS candidate_current
            WHERE candidate_current.workspace_id IS ?
              AND candidate_current.current_generation + 1 IS ?
              AND candidate_current.current_snapshot_id IS ?
              AND ? > candidate_current.state_revision
              ${expected ? `
              AND candidate_current.current_snapshot_id IS ? AND candidate_current.current_generation IS ?
              AND candidate_current.current_registry_snapshot_id IS ? AND candidate_current.current_resolution_lock_id IS ?
              AND candidate_current.current_configuration_revision_id IS ? AND candidate_current.current_freshness_checkpoint_id IS ?
              AND candidate_current.state_revision IS ?` : ""})
        )`;
      const currentTransitionParams: SqliteValue[] = [
        workspaceId, snapshot.generation, parentSnapshotId, currentState.state_revision,
        workspaceId, snapshot.generation, parentSnapshotId, currentState.state_revision,
        ...(expected ? [expected.current_snapshot_id, expected.current_generation, expected.current_registry_snapshot_id, expected.current_resolution_lock_id, expected.current_configuration_revision_id, expected.current_freshness_checkpoint_id, expected.state_revision] : []),
      ];
      const initialExpectedClause = expected ? " AND 0" : "";
      const legacyCommands = [
        {
          kind: "run" as const,
          sql: `INSERT INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id,
            resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest,
            source_snapshot_id, snapshot_contract_version, publication_stage_id, publication_stage_ordinal, publication_stage_count, projection_set_digests, capability_state_digest, published_at, snapshot_digest)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM snapshots WHERE snapshot_id IS ?)
            ${tupleAgreement}${registryAgreement}${controlAgreement}${currentTransition}`,
          params: [
            snapshot.snapshot_id, snapshot.workspace_id, snapshot.generation, parentSnapshotId, snapshot.generation_manifest_id,
            snapshot.registry_snapshot_id, snapshot.resolution_lock_id, snapshot.configuration_revision_id, snapshot.source_state_digest,
            snapshot.source_observation_watermarks, snapshot.canonical_record_set_digest, snapshot.source_snapshot_id ?? null, snapshot.snapshot_contract_version ?? null, snapshot.publication_stage_id ?? null, snapshot.publication_stage_ordinal ?? null, snapshot.publication_stage_count ?? null, snapshot.projection_set_digests,
            snapshot.capability_state_digest, snapshot.published_at, snapshot.snapshot_digest,
            snapshot.snapshot_id, ...tupleAgreementParams, ...registryParams, ...controlParams, ...currentTransitionParams,
          ] as readonly SqliteValue[],
        },
        { kind: "transaction_checkpoint" as const },
        {
          kind: "run" as const,
          sql: `UPDATE workspace_current_state AS current SET current_snapshot_id = ?, current_generation = ?, current_registry_snapshot_id = ?,
            current_resolution_lock_id = ?, current_configuration_revision_id = ?, current_freshness_checkpoint_id = ?, state_revision = ?,
            updated_at = ?
            WHERE current.workspace_id IS ? AND current.current_generation + 1 IS ? AND current.current_snapshot_id IS ?
              AND ? > current.state_revision${expectedClause}${tupleAgreement}${registryAgreement}${controlAgreement}${snapshotExact}`,
          params: [
            currentState.current_snapshot_id, currentState.current_generation, currentState.current_registry_snapshot_id,
            currentState.current_resolution_lock_id, currentState.current_configuration_revision_id, currentState.current_freshness_checkpoint_id,
            currentState.state_revision, currentState.updated_at, workspaceId, snapshot.generation, parentSnapshotId,
            currentState.state_revision, ...expectedParams, ...tupleAgreementParams, ...registryParams, ...controlParams, ...snapshotExactParams,
          ] as readonly SqliteValue[],
        },
        {
          kind: "run" as const,
          sql: `INSERT INTO workspace_current_state (workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id,
            current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM workspace_current_state WHERE workspace_id IS ?)
              AND ? IS 1 AND ? IS NULL AND ? > 0${initialExpectedClause}${tupleAgreement}${registryAgreement}${controlAgreement}${snapshotExact}`,
          params: [
            workspaceId, currentState.current_snapshot_id, currentState.current_generation, currentState.current_registry_snapshot_id,
            currentState.current_resolution_lock_id, currentState.current_configuration_revision_id, currentState.current_freshness_checkpoint_id,
            currentState.state_revision, currentState.updated_at, workspaceId, snapshot.generation, parentSnapshotId,
            currentState.state_revision, ...tupleAgreementParams, ...registryParams, ...controlParams, ...snapshotExactParams,
          ] as readonly SqliteValue[],
        },
        { kind: "assert_transaction_changes" as const, expected: 1 },
      ];
      return buildPublicationPlan({
        mode: "compatibility",
        phases: { snapshot: () => [legacyCommands[0]!], current: () => legacyCommands.slice(1) },
      });

}

export interface CandidatePublicationPlanInput {
  readonly input: CandidatePublicationInput;
  readonly storedCandidate: IndexCandidate;
  readonly current?: {
    readonly current_snapshot_id: string;
    readonly current_generation: number;
    readonly current_registry_snapshot_id: string;
    readonly current_resolution_lock_id: string;
    readonly current_configuration_revision_id: string;
    readonly current_freshness_checkpoint_id: string;
    readonly state_revision: number;
  };
  readonly workspaceId: string;
  readonly database: SqliteDatabase;
  readonly faults: FaultInjector;
  readonly generation: number;
  readonly publishedAt: string;
  /** The calling workspace handle's warm digest corpus, if it has one (see `RecordSetDigestCorpusEntry`). */
  readonly recordSetDigestCorpus?: RecordSetDigestCorpusEntry;
  /** The calling workspace handle's warm projection-digest corpus, if it has one (see `ProjectionSetDigestCorpusEntry`). */
  readonly projectionSetDigestCorpus?: ProjectionSetDigestCorpusEntry;
}

export async function buildCandidatePublicationPlan(planInput: CandidatePublicationPlanInput): Promise<PublicationCommandGroups> {
  const { input, storedCandidate, current, workspaceId, database, faults, generation, publishedAt, recordSetDigestCorpus, projectionSetDigestCorpus } = planInput;
  const expected = input.frozen_base;
  const candidateId = input.candidate.candidate_generation_id;
  const snapshotId = `snapshot:${candidateId}`;
  const generationManifestId = `generation-manifest:${candidateId}`;
  const snapshotParent = current?.current_snapshot_id;
  const normalizedExpectedObservations = normalizeObservationBatchIds(expected.source_observation_batch_ids);
    const materialization = input.materialization;
    const templateSets = input.template_sets;
    // Each verify call below already computes `digestCanonicalArray(entries)`
    // to check it against the sealed descriptor; the four sets that
    // `buildManifestDescriptors` also digests (source transitions, record
    // opens, record closures, identity assignments -- NOT artifact/lookup
    // dependencies or revalidations, which never feed a manifest change-set
    // descriptor) keep that verified digest here (Fix D) instead of letting
    // `buildManifestDescriptors` recompute it over the identical array a
    // second time.
    const sourceTransitionsDigest = verifyTemplateSetAgainstDescriptor(materialization.source_transition_template_set, templateSets.source_transitions, "source_transition_template_set");
    const recordOpensDigest = verifyTemplateSetAgainstDescriptor(materialization.record_open_template_set, templateSets.record_opens, "record_open_template_set");
    const recordClosuresDigest = verifyTemplateSetAgainstDescriptor(materialization.record_closure_template_set, templateSets.record_closures, "record_closure_template_set");
    const identityAssignmentsDigest = verifyTemplateSetAgainstDescriptor(materialization.identity_assignment_template_set, templateSets.identity_assignments, "identity_assignment_template_set");
    verifyTemplateSetAgainstDescriptor(materialization.artifact_dependency_template_set, templateSets.artifact_dependencies, "artifact_dependency_template_set");
    verifyTemplateSetAgainstDescriptor(materialization.lookup_dependency_template_set, templateSets.lookup_dependencies, "lookup_dependency_template_set");
    verifyTemplateSetAgainstDescriptor(materialization.lookup_revalidation_template_set, templateSets.lookup_revalidations, "lookup_revalidation_template_set");
    const sourceTransitions = templateSets.source_transitions;
    const recordOpens = templateSets.record_opens;
    const recordClosures = templateSets.record_closures;
    const identityAssignments = templateSets.identity_assignments;
    const projectionOpens = materialization.projection_open_template_sets.flatMap((value) => jsonArray(typeof value === "string" ? value : value.projection));
    const projectionClosures = materialization.projection_closure_template_sets as unknown as readonly Record<string, unknown>[];
    const artifactDependencies = templateSets.artifact_dependencies;
    const lookupDependencies = templateSets.lookup_dependencies;
    const lookupRevalidations = templateSets.lookup_revalidations;
    const persistedMaterialization = await database.get<{ sealed_at: string }>("SELECT sealed_at FROM candidate_materializations WHERE workspace_id = ? AND candidate_materialization_id = ?", [workspaceId, input.materialization.candidate_materialization_id]);
    const resolvedMaterializationSealedAt = persistedMaterialization?.sealed_at ?? publishedAt;
    // Computed once, up front (`parseRecordOpens`): each `record_open`
    // entry's `record_without_validity` is `JSON.parse`d exactly once here
    // (not once per consumer), producing both the id/digest memo every
    // consumer below needs (`computeSnapshotDigestFields`,
    // `assertPublicationImmutableRows`) and a cache of the parsed/unwrapped
    // record that `recordOpenCommands` reuses later -- see
    // `parseRecordOpens`'s doc comment for why the actual
    // `record_occurrences` command build stays a separate, later step
    // (after `assertPublicationImmutableRows`) rather than being fused into
    // this same pass.
    const useStreamingPublication = recordOpens.length >= STREAMING_PUBLICATION_RECORD_THRESHOLD || projectionOpens.length >= STREAMING_PUBLICATION_RECORD_THRESHOLD;
    // (3c) `input.record_open_memo`, when it covers every entry of
    // `recordOpens` by object identity, IS the exact id/digest this loop
    // would otherwise re-derive by JSON.parse-ing and re-hashing
    // `record_without_validity` -- `CandidateMaterializer.seal()` computed it
    // from the same source record, in this same process, moments ago. Using
    // it turns the dominant cost of a from-zero index's publish (measured:
    // ~27.5s over ~1M records) into a coverage check plus a Map lookup.
    // `verifyTemplateSetAgainstDescriptor` above (and every other digest
    // verification in this function) still independently recomputes its own
    // digest from `recordOpens` regardless of this memo -- decision 13 stays
    // intact; only the redundant per-record parse/hash is skipped.
    const trustedRecordOpenMemo = suppliedRecordOpenMemo(recordOpens, input.record_open_memo);
    const { memo: recordOpenMemo, parsedByEntry: recordOpenParsedByEntry } = await timed("publish_record_open_memo", async () => trustedRecordOpenMemo !== undefined
      ? { memo: trustedRecordOpenMemo, parsedByEntry: undefined }
      : useStreamingPublication
        ? { memo: await memoizeRecordOpens(recordOpens), parsedByEntry: undefined }
        : await parseRecordOpens(recordOpens));
    const snapshotDigests = await timed("publish_snapshot_digest_fields", () => computeSnapshotDigestFields(database, workspaceId, current, generation, recordOpens, recordClosures, recordOpenMemo, recordSetDigestCorpus, artifactDependencies, projectionSetDigestCorpus));
    const manifestDescriptors = timedSync("publish_manifest_descriptors", () => buildManifestDescriptors(sourceTransitions, recordOpens, recordClosures, identityAssignments, projectionOpens, projectionClosures, { sourceTransitions: sourceTransitionsDigest, recordOpens: recordOpensDigest, recordClosures: recordClosuresDigest, identityAssignments: identityAssignmentsDigest }));
    const sourceWatermarks = JSON.stringify({ watermarks: materialization.source_observation_watermarks, source_observation_batch_ids: normalizedExpectedObservations });
    const snapshot = {
      snapshot_id: snapshotId,
      workspace_id: workspaceId,
      generation,
      ...(snapshotParent === undefined ? {} : { parent_snapshot_id: snapshotParent }),
      generation_manifest_id: generationManifestId,
      registry_snapshot_id: input.target_registry.registry_snapshot_id,
      resolution_lock_id: input.target_resolution_lock.resolution_lock_id,
      configuration_revision_id: input.target_configuration.configuration_revision_id,
      source_state_digest: expected.source_state_digest,
      ...(input.source_snapshot_id === undefined ? {} : { source_snapshot_id: input.source_snapshot_id, snapshot_contract_version: 2 }),
      ...(input.publication_stage_id === undefined ? {} : { publication_stage_id: input.publication_stage_id, publication_stage_ordinal: input.publication_stage_ordinal, publication_stage_count: input.publication_stage_count }),
      source_observation_watermarks: sourceWatermarks,
      canonical_record_set_digest: snapshotDigests.canonical_record_set_digest,
      projection_set_digests: snapshotDigests.projection_set_digests,
      capability_state_digest: capabilityStateDigest(materialization.capability_state_entries),
      published_at: publishedAt,
      snapshot_digest: "",
    };
    const completedSnapshot = { ...snapshot, snapshot_digest: snapshotDigest(snapshot) };
    const manifest = manifestRow(generationManifestId, workspaceId, candidateId, generation, snapshotId, input.frozen_base.snapshot_id, input.target_registry.registry_snapshot_id, input.publication_kind, publishedAt, manifestDescriptors);
    await timed("publish_assert_immutable", () => assertPublicationImmutableRows(database, workspaceId, input, sourceTransitions, recordOpens, identityAssignments, projectionOpens, artifactDependencies, lookupDependencies, lookupRevalidations, materialization.capability_state_entries, generation, publishedAt, resolvedMaterializationSealedAt, manifest, completedSnapshot, recordOpenMemo));
    const nextState = {
      workspace_id: workspaceId,
      current_snapshot_id: snapshotId,
      current_generation: generation,
      current_registry_snapshot_id: input.target_registry.registry_snapshot_id,
      current_resolution_lock_id: input.target_resolution_lock.resolution_lock_id,
      current_configuration_revision_id: input.target_configuration.configuration_revision_id,
      current_freshness_checkpoint_id: input.freshness_checkpoint.freshness_checkpoint_id,
      state_revision: (current?.state_revision ?? 0) + 1,
      updated_at: publishedAt,
    } satisfies WorkspaceCurrentState;
    const publicationPayload = encodeCanonical({ candidate: input.candidate, frozen_base: input.frozen_base });
    const candidateStateCommands: TransactionCommand[] = [
      { kind: "run", sql: `INSERT INTO candidate_state (candidate_generation_id, workspace_id, base_snapshot_id, base_generation, base_registry_snapshot_id, target_registry_snapshot_id, base_configuration_revision_id, target_configuration_revision_id, trigger_kind, state, work_manifest_id, source_observation_batch_ids, retention_lease_id, candidate_materialization_id, candidate_digest, created_at, analysis_started_at, ready_at, finished_at, published_snapshot_id, published_generation, generation_manifest_id, stale_against_snapshot_id, failure_code, issue_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'publishing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(candidate_generation_id) DO UPDATE SET state = 'publishing' WHERE candidate_state.state IN ('queued', 'planning', 'analyzing', 'validating', 'projecting', 'ready', 'publishing')`, params: [candidateId, workspaceId, input.candidate.base_snapshot_id ?? null, input.candidate.base_generation ?? null, input.candidate.base_registry_snapshot_id ?? null, input.candidate.target_registry_snapshot_id, input.candidate.base_configuration_revision_id ?? null, input.candidate.target_configuration_revision_id, input.candidate.trigger_kind, null, JSON.stringify(input.candidate.source_observation_batch_ids), input.candidate.retention_lease_id ?? null, input.materialization.candidate_materialization_id, input.candidate.candidate_digest ?? null, input.candidate.created_at, input.candidate.analysis_started_at ?? null, input.candidate.ready_at ?? null, null, null, null, null, null, null, JSON.stringify(input.candidate.issue_ids)] },
      ...faultCommand(faults, "candidate_publication.after_validate_base"),
    ];
    const targetControlCommands: TransactionCommand[] = [
      ...checkedPublicationCommand({ kind: "run", sql: "INSERT INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(registry_snapshot_id) DO UPDATE SET registry_contract_version = excluded.registry_contract_version, core_registry_digest = excluded.core_registry_digest, resolution_lock_id = excluded.resolution_lock_id, registry_digest = excluded.registry_digest WHERE registry_snapshots.workspace_id IS excluded.workspace_id AND registry_snapshots.registry_contract_version IS excluded.registry_contract_version AND registry_snapshots.core_registry_digest IS excluded.core_registry_digest AND registry_snapshots.resolution_lock_id IS excluded.resolution_lock_id AND registry_snapshots.registry_digest IS excluded.registry_digest", params: [input.target_registry.registry_snapshot_id, workspaceId, input.target_registry.registry_contract_version, input.target_registry.core_registry_digest, input.target_resolution_lock.resolution_lock_id, input.target_registry.registry_digest] }),
      ...checkedPublicationCommand({ kind: "run", sql: "INSERT INTO control_plane_state (state_key, workspace_id, state_kind, state_json, reference_workspace_id, reference_snapshot_id, reference_source_state_digest, updated_at) VALUES (?, ?, 'plugin_resolution_lock', ?, NULL, NULL, NULL, ?) ON CONFLICT(state_key) DO NOTHING", params: [`plugin_resolution_lock:${input.target_resolution_lock.resolution_lock_id}`, workspaceId, JSON.stringify(input.target_resolution_lock), publishedAt] }),
      ...checkedPublicationCommand({ kind: "run", sql: "INSERT INTO control_plane_state (state_key, workspace_id, state_kind, state_json, reference_workspace_id, reference_snapshot_id, reference_source_state_digest, updated_at) VALUES (?, ?, 'workspace_configuration_revision', ?, NULL, NULL, NULL, ?) ON CONFLICT(state_key) DO NOTHING", params: [`workspace_configuration_revision:${input.target_configuration.configuration_revision_id}`, workspaceId, JSON.stringify(input.target_configuration), publishedAt] }),
      ...checkedPublicationCommand({ kind: "run", sql: "INSERT INTO control_plane_state (state_key, workspace_id, state_kind, state_json, reference_workspace_id, reference_snapshot_id, reference_source_state_digest, updated_at) VALUES (?, ?, 'workspace_freshness_checkpoint', ?, ?, ?, ?, ?) ON CONFLICT(state_key) DO NOTHING", params: [`workspace_freshness_checkpoint:${input.freshness_checkpoint.freshness_checkpoint_id}`, workspaceId, JSON.stringify(input.freshness_checkpoint), workspaceId, input.source_snapshot_id ?? input.freshness_checkpoint.snapshot_id ?? snapshotParent ?? snapshotId, expected.source_state_digest, publishedAt] }),
    ];
    const sourceCommands: TransactionCommand[] = [
      ...timedSync("publish_source_commands", () => sourceTransitionCommands(sourceTransitions, workspaceId, generation)),
      ...faultCommand(faults, "candidate_publication.after_install_source"),
    ];
    const candidateMaterializationCommands: TransactionCommand[] = checkedPublicationCommand({ kind: "run", sql: "INSERT INTO candidate_materializations (candidate_materialization_id, workspace_id, candidate_generation_id, materialization_digest, sealed_at, materialization_contract_text) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET candidate_materialization_id = excluded.candidate_materialization_id, workspace_id = excluded.workspace_id, candidate_generation_id = excluded.candidate_generation_id, materialization_digest = excluded.materialization_digest, sealed_at = excluded.sealed_at, materialization_contract_text = excluded.materialization_contract_text WHERE candidate_materializations.candidate_materialization_id = excluded.candidate_materialization_id AND candidate_materializations.workspace_id = excluded.workspace_id AND candidate_materializations.candidate_generation_id IS excluded.candidate_generation_id AND candidate_materializations.materialization_digest = excluded.materialization_digest AND candidate_materializations.sealed_at IS excluded.sealed_at AND candidate_materializations.materialization_contract_text = excluded.materialization_contract_text", params: [input.materialization.candidate_materialization_id, workspaceId, candidateId, input.materialization.materialization_digest, resolvedMaterializationSealedAt, JSON.stringify(input.materialization)] });
    const dependencyCommands: TransactionCommand[] = timedSync("publish_dependency_commands", () => [
      ...artifactDependencyCommands(artifactDependencies, workspaceId, generation),
      ...lookupDependencyCommands(lookupDependencies, lookupRevalidations, workspaceId, candidateId, generation, publishedAt),
      ...capabilityStateCommands(materialization.capability_state_entries, workspaceId, candidateId, publishedAt),
    ]);
    const recordClosureCommandList = useStreamingPublication ? [] : timedSync("publish_record_closure_commands", () => recordClosureCommands(recordClosures, workspaceId, generation));
    const identityCommandList = useStreamingPublication ? [] : timedSync("publish_identity_commands", () => identityCommands(identityAssignments, workspaceId, generation));
    const canonicalFaultCommands = faultCommand(faults, "candidate_publication.after_install_canonical");
    const projectionClosureCommandList = useStreamingPublication ? [] : timedSync("publish_projection_commands", () => projectionClosureCommands(projectionClosures, workspaceId, generation));
    const projectionFaultCommands = faultCommand(faults, "candidate_publication.after_install_projections");
    const canonicalCommands: TransactionCommand[] = useStreamingPublication ? [] : [
      ...candidateMaterializationCommands,
      ...dependencyCommands,
      ...timedSync("publish_record_open_commands", () => recordOpenCommands(recordOpens, workspaceId, generation, recordOpenMemo, recordOpenParsedByEntry)),
      ...recordClosureCommandList,
      ...identityCommandList,
      ...canonicalFaultCommands,
    ];
    const projectionCommandsForPublication: TransactionCommand[] = useStreamingPublication ? [] : [
      ...timedSync("publish_projection_commands", () => projectionCommands(projectionOpens, workspaceId, generation)),
      ...projectionClosureCommandList,
      ...projectionFaultCommands,
    ];
    // `coalesceAdjacentRuns` wraps the WHOLE composed stream (not each
    // sub-generator individually) so adjacency is judged across their real,
    // final concatenation order -- exactly what reaches the worker -- rather
    // than resetting at each `yield*` boundary for no reason. It is a no-op
    // pass-through wherever adjacency doesn't hold (e.g. every
    // `checkedPublicationCommand`-bracketed single row in `dependencyCommands`,
    // which transaction_checkpoint/assert_transaction_changes already isolate
    // from its neighbors) and only ever produces `run_batch` where genuinely
    // adjacent same-SQL `run` commands exist (record_facets inside
    // `recordOpenCommandStream`, the closure UPDATEs in
    // `recordClosureCommandStream`, and projection_occurrence_dependencies
    // inside `projectionCommandStream`, below).
    const canonicalStream = useStreamingPublication ? (): Iterable<TransactionCommand> => coalesceAdjacentRuns((function* (): Generator<TransactionCommand> {
      yield* candidateMaterializationCommands;
      yield* dependencyCommands;
      const rebuildInitialCanonicalIndexes = current === undefined && recordOpens.length >= STREAMING_PUBLICATION_RECORD_THRESHOLD;
      if (rebuildInitialCanonicalIndexes) yield { kind: "exec", sql: INITIAL_CANONICAL_INDEX_DROP_SQL };
      yield* recordOpenCommandStream(recordOpens, workspaceId, generation, recordOpenMemo, recordOpenParsedByEntry);
      yield* recordClosureCommandStream(recordClosures, workspaceId, generation);
      yield* identityCommandStream(identityAssignments, workspaceId, generation);
      if (rebuildInitialCanonicalIndexes) yield { kind: "exec", sql: INITIAL_CANONICAL_INDEX_BUILD_SQL };
      yield* canonicalFaultCommands;
    })()) : undefined;
    const projectionsStream = useStreamingPublication ? (): Iterable<TransactionCommand> => coalesceAdjacentRuns((function* (): Generator<TransactionCommand> {
      yield* projectionCommandStream(projectionOpens, workspaceId, generation);
      yield* projectionClosureCommandStream(projectionClosures, workspaceId, generation);
      yield* projectionFaultCommands;
    })()) : undefined;
    const manifestCommands: TransactionCommand[] = [
      ...checkedPublicationCommand({ kind: "run", sql: "INSERT INTO generation_manifests (generation_manifest_id, workspace_id, candidate_generation_id, generation, snapshot_id, base_snapshot_id, registry_snapshot_id, publication_kind, published_at, artifact_change_set, record_open_set, record_closure_set, identity_assignment_set, projection_change_sets, manifest_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", params: [generationManifestId, workspaceId, candidateId, generation, snapshotId, input.frozen_base.snapshot_id ?? null, manifest.registry_snapshot_id, manifest.publication_kind, publishedAt, manifest.artifact_change_set, manifest.record_open_set, manifest.record_closure_set, manifest.identity_assignment_set, manifest.projection_change_sets, manifest.manifest_digest] }),
    ];
    const snapshotCommands: TransactionCommand[] = [
      ...checkedPublicationCommand({ kind: "run", sql: "INSERT INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_snapshot_id, snapshot_contract_version, publication_stage_id, publication_stage_ordinal, publication_stage_count, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", params: [completedSnapshot.snapshot_id, completedSnapshot.workspace_id, completedSnapshot.generation, completedSnapshot.parent_snapshot_id ?? null, completedSnapshot.generation_manifest_id, completedSnapshot.registry_snapshot_id, completedSnapshot.resolution_lock_id, completedSnapshot.configuration_revision_id, completedSnapshot.source_state_digest, completedSnapshot.source_snapshot_id ?? null, completedSnapshot.snapshot_contract_version ?? null, completedSnapshot.publication_stage_id ?? null, completedSnapshot.publication_stage_ordinal ?? null, completedSnapshot.publication_stage_count ?? null, completedSnapshot.source_observation_watermarks, completedSnapshot.canonical_record_set_digest, completedSnapshot.projection_set_digests, completedSnapshot.capability_state_digest, completedSnapshot.published_at, completedSnapshot.snapshot_digest] }),
    ];
    const journalCommands: TransactionCommand[] = [
      ...checkedPublicationCommand({ kind: "run", sql: "INSERT INTO candidate_publication_journal (candidate_generation_id, workspace_id, status, snapshot_id, generation_manifest_id, generation, published_at, publication_digest) VALUES (?, ?, 'published', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", params: [candidateId, workspaceId, snapshotId, generationManifestId, generation, publishedAt, canonicalSha256(publicationPayload)] }),
    ];
    const candidateFinalizationCommands: TransactionCommand[] = [
      ...checkedPublicationCommand({ kind: "run", sql: "UPDATE candidate_state SET state = 'published', finished_at = ?, published_snapshot_id = ?, published_generation = ?, generation_manifest_id = ? WHERE workspace_id = ? AND candidate_generation_id = ? AND state = 'publishing'", params: [publishedAt, snapshotId, generation, generationManifestId, workspaceId, candidateId] }),
      ...faultCommand(faults, "candidate_publication.after_install_manifest"),
      ...faultCommand(faults, "candidate_publication.before_swap_current"),
    ];
    const currentCommands: TransactionCommand[] = [
      ...(current === undefined
        ? [{ kind: "transaction_checkpoint" as const }, { kind: "run" as const, sql: "INSERT INTO workspace_current_state (workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id, current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM workspace_current_state WHERE workspace_id = ?)", params: [workspaceId, nextState.current_snapshot_id, nextState.current_generation, nextState.current_registry_snapshot_id, nextState.current_resolution_lock_id, nextState.current_configuration_revision_id, nextState.current_freshness_checkpoint_id, nextState.state_revision, nextState.updated_at, workspaceId] }, { kind: "assert_transaction_changes" as const, expected: 1 }]
        : [{ kind: "transaction_checkpoint" as const }, { kind: "run" as const, sql: "UPDATE workspace_current_state SET current_snapshot_id = ?, current_generation = ?, current_registry_snapshot_id = ?, current_resolution_lock_id = ?, current_configuration_revision_id = ?, current_freshness_checkpoint_id = ?, state_revision = ?, updated_at = ? WHERE workspace_id = ? AND current_snapshot_id = ? AND current_generation = ? AND current_registry_snapshot_id = ? AND current_resolution_lock_id = ? AND current_configuration_revision_id = ? AND state_revision = ?", params: [nextState.current_snapshot_id, nextState.current_generation, nextState.current_registry_snapshot_id, nextState.current_resolution_lock_id, nextState.current_configuration_revision_id, nextState.current_freshness_checkpoint_id, nextState.state_revision, nextState.updated_at, workspaceId, current.current_snapshot_id, current.current_generation, current.current_registry_snapshot_id, current.current_resolution_lock_id, current.current_configuration_revision_id, current.state_revision] }, { kind: "assert_transaction_changes" as const, expected: 1 }]),
      ...faultCommand(faults, "candidate_publication.before_commit"),
    ];
    const plan = buildPublicationPlan({
      mode: "candidate",
      phases: {
        candidateState: () => candidateStateCommands,
        targetControls: () => targetControlCommands,
        source: () => sourceCommands,
        canonical: () => canonicalCommands,
        projections: () => projectionCommandsForPublication,
        ...(canonicalStream === undefined ? {} : { canonicalStream }),
        ...(projectionsStream === undefined ? {} : { projectionsStream }),
        manifest: () => manifestCommands,
        snapshot: () => snapshotCommands,
        journal: () => journalCommands,
        candidateFinalization: () => candidateFinalizationCommands,
        current: () => currentCommands,
      },
    });
    // See `PublicationCommandGroups.recordSetDigestCorpusCandidate`'s doc
    // comment: not a transaction command, just this publish's own
    // `computeSnapshotDigestFields` output riding along for the caller to
    // stash on the workspace handle once (and only if) the transaction below
    // actually commits. `projectionSetDigestCorpusCandidate` rides along the
    // same way, for the same reason -- see `ProjectionSetDigestCorpusEntry`'s
    // doc comment for why its rows already have this publish's own
    // artifact-dependency opens merged in even though this publish's OWN
    // `projection_set_digests` field (above, in `snapshot`) deliberately does
    // not.
    return {
      ...plan,
      ...(snapshotDigests.record_set_digest_corpus_complete ? { recordSetDigestCorpusCandidate: { workspaceId, generation, sortedVisible: snapshotDigests.sortedVisible } } : {}),
      projectionSetDigestCorpusCandidate: { workspaceId, generation, sortedByKind: snapshotDigests.sortedProjectionsByKind },
    };

}


/**
 * `canonical_record_set_digest`/`projection_set_digests` for a workspace
 * fork's generation-1 publish (docs/decisions/12-workspace-fork.md), computed
 * by a single SQL pass over the canonical rows a fork bulk-copies directly
 * (`workspace-fork.ts`'s `bulkCopyCanonicalRows`) -- NOT by re-digesting
 * payloads or diffing against a template array the way
 * `computeSnapshotDigestFields` does for an ordinary candidate publish.
 * `computeSnapshotDigestFields` is not reusable here: its `oldVisible` read
 * only fires when a *prior* generation exists (`current !== undefined`), and
 * a fork's rows exist without ever having been described by a `record_opens`
 * template at all -- there is no "diff" to compute, only "what's here now".
 * Uses `projectionSetDigestEntries` (below) in `{ digest_source: "stored" }`
 * mode -- the fork copy path (`bulkCopyDependencies`,
 * `packages/engine/src/workspace-fork.ts`) populates `content_digest` on
 * every row it writes, so this reads that column via the same index-only
 * scan an ordinary publish uses, rather than re-hashing the payloads it just
 * copied -- so a fork's `projection_set_digests` is byte-identical in shape
 * (and value) to what an ordinary scan's own snapshot would carry for the
 * same visible projection set.
 */
export async function computeForkSnapshotDigestFields(database: SqliteDatabase, workspaceId: string, generation: number): Promise<{ readonly canonical_record_set_digest: string; readonly projection_set_digests: string; readonly visible_records: readonly { readonly record_id: string; readonly record_digest: string }[] }> {
  const visible = await database.all<{ record_id: string; record_digest: string }>(
    "SELECT record_id, record_digest FROM record_occurrences WHERE workspace_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?) ORDER BY record_id",
    [workspaceId, generation, generation],
  );
  const canonicalRecordSetDigest = logicalRecordSetDigest(visible);
  const projectionEntries = await projectionSetDigestEntries(database, workspaceId, generation, { digest_source: "stored" });
  return { canonical_record_set_digest: canonicalRecordSetDigest, projection_set_digests: JSON.stringify(projectionEntries), visible_records: visible };
}

export function logicalRecordSetDigest(rows: readonly { readonly record_id: string; readonly record_digest: string }[]): string {
  const sorted = [...rows].sort((left, right) => left.record_id < right.record_id ? -1 : left.record_id > right.record_id ? 1 : 0);
  return digestSortedRecordSet(sorted, sorted.length);
}

/**
 * v3 is a destructive data format: the canonical record-set digest is the
 * canonical array digest of its record-id-ordered identity/digest pairs.
 * This is exact and order-independent at the API boundary (the exported
 * wrapper sorts), but unlike the previous in-memory Merkle radix builder it
 * needs O(1) auxiliary memory and O(n) hashes instead of materialising up to
 * 64 prefix maps per record.
 */
/** @internal Exported for exact streaming-invariant tests. */
export function digestSortedRecordSet(rows: Iterable<{ readonly record_id: string; readonly record_digest: string }>, count: number): string {
  const hash = createHash("sha256");
  hash.update(encodeArrayHeader(count));
  let seen = 0;
  let previous = "";
  for (const row of rows) {
    if (seen > 0 && row.record_id <= previous) throw new StorageError("storage:publication_invalid", "Canonical record-set rows must have unique ascending record ids.");
    hash.update(encodeCanonicalBytes(row));
    previous = row.record_id;
    seen += 1;
  }
  if (seen !== count) throw new StorageError("storage:publication_invalid", "Canonical record-set row count changed during digesting.");
  return `sha256:${hash.digest("hex")}`;
}

export interface ForkPublicationPlanInput {
  readonly workspaceId: string;
  readonly candidateId: string;
  readonly generation: number;
  readonly publishedAt: string;
  readonly sourceObservationBatchIds: readonly string[];
  readonly sourceStateDigest: string;
  readonly canonicalRecordSetDigest: string;
  readonly projectionSetDigests: string;
  /**
   * Lightweight entries for the `generation_manifests` audit descriptors
   * only (never the full row set) -- `changeSetDescriptor`/`buildManifestDescriptors`
   * just need *some* stable, ordered representation to count and digest;
   * `{record_id, record_digest}` pairs (already fetched for
   * `canonicalRecordSetDigest`, no extra query) serve exactly as well as the
   * full open-template objects an ordinary scan's manifest would digest,
   * since `manifest_digest` is self-referential (nothing external compares
   * `record_open_set.content_digest` against an independently recomputed
   * value the way `canonical_record_set_digest` is). A fork's per-generation
   * audit trail is therefore honest about *counts* and internally
   * consistent, but does not retain the full per-record open history the
   * way the staged template rows do (this change deliberately does
   * not write those, to avoid re-canonical-encoding every copied row just
   * to store it a second time) -- see docs/decisions/12-workspace-fork.md.
   */
  readonly recordOpenSetEntries: readonly unknown[];
  readonly identityAssignmentSetEntries: readonly unknown[];
  readonly targetRegistry: RegistrySnapshot;
  readonly targetResolutionLock: PluginResolutionLock;
  readonly targetConfiguration: WorkspaceConfigurationRevision;
  readonly freshnessCheckpoint: WorkspaceFreshnessCheckpoint;
  readonly capabilityStateEntries?: readonly unknown[];
  readonly sourceSnapshotId?: string;
  readonly publicationStageId?: string;
  readonly publicationStageOrdinal?: number;
  readonly publicationStageCount?: number;
  /**
   * `candidate_state.trigger_kind` / the publication journal's `trigger_kind`
   * field for this generation-1 publish. Defaults to `"core:workspace_fork"`
   * (every pre-existing caller). `docs/decisions/23-index-pack.md`'s import
   * path passes `"core:index_pack_import"` instead -- same O(1) publication
   * shape, distinct provenance so a snapshot's `candidate_state` row can
   * always be read back to tell a local same-machine fork apart from an
   * imported distributable pack.
   */
  readonly triggerKind?: string;
}

/**
 * The O(1) publication-layer half of a workspace fork's generation-1 publish
 * (docs/decisions/12-workspace-fork.md): candidate_state, registry snapshot +
 * control-plane rows, a materialization row (with empty/zero-entry template
 * descriptors -- the real canonical rows were already bulk-copied directly,
 * never passing through a template array at all), the generation manifest,
 * the snapshot (with digests the caller already computed over the copied
 * set via `computeForkSnapshotDigestFields`), the publication journal, and
 * the CAS-guarded `workspace_current_state` swap. Deliberately NOT a call
 * into `buildCandidatePublicationPlan`: that function's cost is dominated by
 * exactly the per-record work (`memoizeRecordOpens`, `assertPublicationImmutableRows`,
 * `recordOpenCommands`) a fork's bulk-copy design exists to skip, and it has
 * no way to treat "canonical rows already present in the database" as a
 * valid input -- it only ever *writes* rows from a template array. A fork
 * always mints a genuine first generation (no `current`/prior state, no
 * `parent_snapshot_id`, no fault-injection hooks -- forks don't use
 * `@urdira/storage`'s `FaultInjector`), which is what lets this be
 * considerably simpler than the general candidate-publish plan: no
 * queued/publishing state-machine dance (`candidate_state` is inserted
 * `'published'` directly), no source-transition phase (the fork's source
 * layer was already committed separately, before this plan is even built --
 * see `workspace-fork.ts`'s `commitForkSourceLayer`), no canonical/projection
 * template phases. Every immutable row still goes through
 * `checkedPublicationCommand`'s transaction_checkpoint + assert_transaction_changes
 * pattern and an `ON CONFLICT ... DO UPDATE ... WHERE (byte-identical)`
 * idempotent-replay guard, matching `buildCandidatePublicationPlan`'s own
 * robustness contract exactly; the final `workspace_current_state` swap
 * keeps the same "insert only if absent" CAS guard a genuine first
 * publish uses.
 */
export function buildForkPublicationPlan(input: ForkPublicationPlanInput): PublicationCommandGroups {
  const { workspaceId, candidateId, generation, publishedAt } = input;
  const snapshotId = `snapshot:${candidateId}`;
  const generationManifestId = `generation-manifest:${candidateId}`;
  const materializationId = `materialization:${candidateId}`;
  const normalizedBatchIds = normalizeObservationBatchIds(input.sourceObservationBatchIds);

  const triggerKind = input.triggerKind ?? "core:workspace_fork";
  const manifestDescriptors = buildManifestDescriptors([], input.recordOpenSetEntries, [], input.identityAssignmentSetEntries, [], []);
  const manifest = manifestRow(generationManifestId, workspaceId, candidateId, generation, snapshotId, undefined, input.targetRegistry.registry_snapshot_id, "activation", publishedAt, manifestDescriptors);

  const snapshot = {
    snapshot_id: snapshotId,
    workspace_id: workspaceId,
    generation,
    generation_manifest_id: generationManifestId,
    registry_snapshot_id: input.targetRegistry.registry_snapshot_id,
    resolution_lock_id: input.targetResolutionLock.resolution_lock_id,
    configuration_revision_id: input.targetConfiguration.configuration_revision_id,
    source_state_digest: input.sourceStateDigest,
    ...(input.sourceSnapshotId === undefined ? {} : { source_snapshot_id: input.sourceSnapshotId, snapshot_contract_version: 2 }),
    ...(input.publicationStageId === undefined ? {} : { publication_stage_id: input.publicationStageId, publication_stage_ordinal: input.publicationStageOrdinal, publication_stage_count: input.publicationStageCount }),
    source_observation_watermarks: JSON.stringify({ watermarks: [], source_observation_batch_ids: normalizedBatchIds }),
    canonical_record_set_digest: input.canonicalRecordSetDigest,
    projection_set_digests: input.projectionSetDigests,
    capability_state_digest: capabilityStateDigest(input.capabilityStateEntries ?? []),
    published_at: publishedAt,
    snapshot_digest: "",
  };
  const completedSnapshot = { ...snapshot, snapshot_digest: snapshotDigest(snapshot) };

  const nextState = {
    workspace_id: workspaceId,
    current_snapshot_id: snapshotId,
    current_generation: generation,
    current_registry_snapshot_id: input.targetRegistry.registry_snapshot_id,
    current_resolution_lock_id: input.targetResolutionLock.resolution_lock_id,
    current_configuration_revision_id: input.targetConfiguration.configuration_revision_id,
    current_freshness_checkpoint_id: input.freshnessCheckpoint.freshness_checkpoint_id,
    state_revision: 1,
    updated_at: publishedAt,
  } satisfies WorkspaceCurrentState;

  const materializationCore = {
    candidate_materialization_id: materializationId,
    workspace_id: workspaceId,
    candidate_generation_id: candidateId,
    // No template arrays: the canonical rows this generation actually
    // consists of were bulk-copied directly, not submitted as record_open/
    // identity_assignment/artifact_dependency/projection templates -- so
    // every descriptor here is honestly zero-entry rather than a
    // (mis)description of rows this plan never touched.
    fork_bulk_copy: true,
  };
  const materializationDigest = canonicalSha256(materializationCore);
  const materializationContractText = JSON.stringify({ ...materializationCore, materialization_digest: materializationDigest });

  // Deliberately a plain INSERT, not the `ON CONFLICT ... DO UPDATE` pattern
  // the other rows below use: a fork candidate id is always genuinely new
  // (this is the first and only publish this candidate id will ever see). If
  // it somehow already exists -- only reachable if a prior attempt's
  // rollback (`workspace-fork.ts`'s `rollbackForkPublication`) failed
  // partway -- this throws a plain constraint error, which the caller's
  // existing rollback-and-retry funnel already treats as "fall back to a
  // full scan", so failing loudly here is strictly better than silently
  // reusing a row that might not agree with this attempt's own generation.
  const candidateStateCommands: readonly SqliteCommand[] = [
    { kind: "run", sql: "INSERT INTO candidate_state (candidate_generation_id, workspace_id, base_snapshot_id, base_generation, base_registry_snapshot_id, target_registry_snapshot_id, base_configuration_revision_id, target_configuration_revision_id, trigger_kind, state, work_manifest_id, source_observation_batch_ids, retention_lease_id, candidate_materialization_id, candidate_digest, created_at, analysis_started_at, ready_at, finished_at, published_snapshot_id, published_generation, generation_manifest_id, stale_against_snapshot_id, failure_code, issue_ids, frozen_source_state_digest, frozen_source_observation_batch_ids, frozen_tuple_digest) VALUES (?, ?, NULL, NULL, NULL, ?, NULL, ?, ?, 'published', NULL, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)", params: [candidateId, workspaceId, input.targetRegistry.registry_snapshot_id, input.targetConfiguration.configuration_revision_id, triggerKind, JSON.stringify(normalizedBatchIds), materializationId, materializationDigest, publishedAt, publishedAt, snapshotId, generation, generationManifestId, JSON.stringify([]), input.sourceStateDigest, JSON.stringify(normalizedBatchIds), materializationDigest] },
  ];

  const targetControlCommands: readonly SqliteCommand[] = [
      ...checkedPublicationCommand({ kind: "run", sql: "INSERT INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(registry_snapshot_id) DO UPDATE SET registry_contract_version = excluded.registry_contract_version, core_registry_digest = excluded.core_registry_digest, resolution_lock_id = excluded.resolution_lock_id, registry_digest = excluded.registry_digest WHERE registry_snapshots.workspace_id IS excluded.workspace_id AND registry_snapshots.registry_contract_version IS excluded.registry_contract_version AND registry_snapshots.core_registry_digest IS excluded.core_registry_digest AND registry_snapshots.resolution_lock_id IS excluded.resolution_lock_id AND registry_snapshots.registry_digest IS excluded.registry_digest", params: [input.targetRegistry.registry_snapshot_id, workspaceId, input.targetRegistry.registry_contract_version, input.targetRegistry.core_registry_digest, input.targetResolutionLock.resolution_lock_id, input.targetRegistry.registry_digest] }),
    ...checkedPublicationCommand({ kind: "run", sql: "INSERT INTO control_plane_state (state_key, workspace_id, state_kind, state_json, reference_workspace_id, reference_snapshot_id, reference_source_state_digest, updated_at) VALUES (?, ?, 'plugin_resolution_lock', ?, NULL, NULL, NULL, ?) ON CONFLICT(state_key) DO NOTHING", params: [`plugin_resolution_lock:${input.targetResolutionLock.resolution_lock_id}`, workspaceId, JSON.stringify(input.targetResolutionLock), publishedAt] }),
    ...checkedPublicationCommand({ kind: "run", sql: "INSERT INTO control_plane_state (state_key, workspace_id, state_kind, state_json, reference_workspace_id, reference_snapshot_id, reference_source_state_digest, updated_at) VALUES (?, ?, 'workspace_configuration_revision', ?, NULL, NULL, NULL, ?) ON CONFLICT(state_key) DO NOTHING", params: [`workspace_configuration_revision:${input.targetConfiguration.configuration_revision_id}`, workspaceId, JSON.stringify(input.targetConfiguration), publishedAt] }),
    ...checkedPublicationCommand({ kind: "run", sql: "INSERT INTO control_plane_state (state_key, workspace_id, state_kind, state_json, reference_workspace_id, reference_snapshot_id, reference_source_state_digest, updated_at) VALUES (?, ?, 'workspace_freshness_checkpoint', ?, ?, ?, ?, ?) ON CONFLICT(state_key) DO NOTHING", params: [`workspace_freshness_checkpoint:${input.freshnessCheckpoint.freshness_checkpoint_id}`, workspaceId, JSON.stringify(input.freshnessCheckpoint), workspaceId, snapshotId, input.sourceStateDigest, publishedAt] }),
    ...capabilityStateCommands(input.capabilityStateEntries ?? [], workspaceId, candidateId, publishedAt),
  ];

  const canonicalCommands: readonly SqliteCommand[] = [
    ...checkedPublicationCommand({ kind: "run", sql: "INSERT INTO candidate_materializations (candidate_materialization_id, workspace_id, candidate_generation_id, materialization_digest, sealed_at, materialization_contract_text) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET materialization_digest = excluded.materialization_digest, sealed_at = excluded.sealed_at, materialization_contract_text = excluded.materialization_contract_text WHERE candidate_materializations.candidate_materialization_id = excluded.candidate_materialization_id AND candidate_materializations.workspace_id = excluded.workspace_id AND candidate_materializations.candidate_generation_id IS excluded.candidate_generation_id AND candidate_materializations.materialization_digest = excluded.materialization_digest AND candidate_materializations.sealed_at IS excluded.sealed_at AND candidate_materializations.materialization_contract_text = excluded.materialization_contract_text", params: [materializationId, workspaceId, candidateId, materializationDigest, publishedAt, materializationContractText] }),
  ];

  const manifestCommands: readonly SqliteCommand[] = [
    ...checkedPublicationCommand({ kind: "run", sql: "INSERT INTO generation_manifests (generation_manifest_id, workspace_id, candidate_generation_id, generation, snapshot_id, base_snapshot_id, registry_snapshot_id, publication_kind, published_at, artifact_change_set, record_open_set, record_closure_set, identity_assignment_set, projection_change_sets, manifest_digest) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", params: [generationManifestId, workspaceId, candidateId, generation, snapshotId, manifest.registry_snapshot_id, manifest.publication_kind, publishedAt, manifest.artifact_change_set, manifest.record_open_set, manifest.record_closure_set, manifest.identity_assignment_set, manifest.projection_change_sets, manifest.manifest_digest] }),
  ];

  const snapshotCommands: readonly SqliteCommand[] = [
    ...checkedPublicationCommand({ kind: "run", sql: "INSERT INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_snapshot_id, snapshot_contract_version, publication_stage_id, publication_stage_ordinal, publication_stage_count, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", params: [completedSnapshot.snapshot_id, completedSnapshot.workspace_id, completedSnapshot.generation, completedSnapshot.generation_manifest_id, completedSnapshot.registry_snapshot_id, completedSnapshot.resolution_lock_id, completedSnapshot.configuration_revision_id, completedSnapshot.source_state_digest, completedSnapshot.source_snapshot_id ?? null, completedSnapshot.snapshot_contract_version ?? null, completedSnapshot.publication_stage_id ?? null, completedSnapshot.publication_stage_ordinal ?? null, completedSnapshot.publication_stage_count ?? null, completedSnapshot.source_observation_watermarks, completedSnapshot.canonical_record_set_digest, completedSnapshot.projection_set_digests, completedSnapshot.capability_state_digest, completedSnapshot.published_at, completedSnapshot.snapshot_digest] }),
  ];

  const publicationPayload = encodeCanonical({ candidate_generation_id: candidateId, workspace_id: workspaceId, trigger_kind: triggerKind, snapshot_id: snapshotId });
  const journalCommands: readonly SqliteCommand[] = [
    ...checkedPublicationCommand({ kind: "run", sql: "INSERT INTO candidate_publication_journal (candidate_generation_id, workspace_id, status, snapshot_id, generation_manifest_id, generation, published_at, publication_digest) VALUES (?, ?, 'published', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", params: [candidateId, workspaceId, snapshotId, generationManifestId, generation, publishedAt, canonicalSha256(publicationPayload)] }),
  ];

  // A fork always mints workspace generation 1 -- `current` is always
  // undefined (there is no prior `workspace_current_state` row), so only the
  // "insert if absent" CAS branch of the ordinary candidate-publish
  // `currentCommands` applies; the "update if matches" branch never does.
  const currentCommands: readonly SqliteCommand[] = [
    { kind: "transaction_checkpoint" },
    { kind: "run", sql: "INSERT INTO workspace_current_state (workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id, current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM workspace_current_state WHERE workspace_id = ?)", params: [workspaceId, nextState.current_snapshot_id, nextState.current_generation, nextState.current_registry_snapshot_id, nextState.current_resolution_lock_id, nextState.current_configuration_revision_id, nextState.current_freshness_checkpoint_id, nextState.state_revision, nextState.updated_at, workspaceId] },
    { kind: "assert_transaction_changes", expected: 1 },
  ];

  return buildPublicationPlan({
    mode: "candidate",
    phases: {
      candidateState: () => candidateStateCommands,
      targetControls: () => targetControlCommands,
      canonical: () => canonicalCommands,
      manifest: () => manifestCommands,
      snapshot: () => snapshotCommands,
      journal: () => journalCommands,
      current: () => currentCommands,
    },
  });
}

/** Construct the semantic publication phases from typed phase builders. */
export function buildPublicationPlan(input: PublicationPlanInput): PublicationCommandGroups {
  const plan: PublicationCommandGroups = {
    mode: input.mode,
    candidateState: input.phases.candidateState?.() ?? [],
    targetControls: input.phases.targetControls?.() ?? [],
    source: input.phases.source?.() ?? [],
    canonical: input.phases.canonical?.() ?? [],
    projections: input.phases.projections?.() ?? [],
    manifest: input.phases.manifest?.() ?? [],
    snapshot: input.phases.snapshot?.() ?? [],
    journal: input.phases.journal?.() ?? [],
    candidateFinalization: input.phases.candidateFinalization?.() ?? [],
    current: input.phases.current(),
    ...(input.phases.canonicalStream === undefined ? {} : { canonicalStream: input.phases.canonicalStream }),
    ...(input.phases.projectionsStream === undefined ? {} : { projectionsStream: input.phases.projectionsStream }),
  };
  validatePublicationCommandGroups(plan);
  return plan;
}

/** Translate the legacy candidate-free call into the same publication phase model. */
export function translateCompatibilityPublication(snapshot: SqliteCommand, current: readonly SqliteCommand[]): PublicationCommandGroups {
  return buildPublicationPlan({
    mode: "compatibility",
    phases: { snapshot: () => [snapshot], current: () => current },
  });
}

export function buildPublicationTransactionCommands(plan: PublicationCommandGroups): readonly SqliteCommand[] {
  validatePublicationCommandGroups(plan);
  return publicationPhaseCommands(plan);
}

function publicationPhaseCommands(plan: PublicationCommandGroups): readonly SqliteCommand[] {
  return [
    ...compactPublicationPhase(plan.candidateState),
    ...compactPublicationPhase(plan.targetControls),
    ...compactPublicationPhase(plan.source),
    ...(plan.canonicalStream === undefined ? compactPublicationPhase(plan.canonical) : [...plan.canonicalStream()]),
    ...(plan.projectionsStream === undefined ? compactPublicationPhase(plan.projections) : [...plan.projectionsStream()]),
    ...compactPublicationPhase(plan.manifest),
    ...compactPublicationPhase(plan.snapshot),
    ...compactPublicationPhase(plan.journal),
    ...compactPublicationPhase(plan.candidateFinalization),
    ...compactPublicationPhase(plan.current),
  ];
}

/**
 * Same command order as {@link buildPublicationTransactionCommands}, without
 * materializing the concatenated array: `WorkspaceDatabase.publishCandidateSerialized`
 * (`packages/storage/src/storage.ts`) drives this through `SqliteDatabase.transactionChunked`
 * so a large candidate publication is streamed to the worker in bounded chunks
 * rather than structured-cloned as one array in a single `postMessage`.
 */
export function publicationTransactionCommands(plan: PublicationCommandGroups): Generator<SqliteCommand> {
  // Validated eagerly, here in the outer (non-generator) function, so an
  // invalid plan throws synchronously before the caller ever opens a worker
  // transaction -- a bare `function*` would defer this to the first
  // iteration (inside `transactionChunked`'s `for await`, after `batch_open`
  // already round-tripped), which is still safe (the open transaction rolls
  // back) but needlessly opens one.
  validatePublicationCommandGroups(plan);
  return (function* (): Generator<SqliteCommand> {
    yield* compactPublicationPhase(plan.candidateState);
    yield* compactPublicationPhase(plan.targetControls);
    yield* compactPublicationPhase(plan.source);
    if (plan.canonicalStream !== undefined) yield* plan.canonicalStream();
    else yield* compactPublicationPhase(plan.canonical);
    if (plan.projectionsStream !== undefined) yield* plan.projectionsStream();
    else yield* compactPublicationPhase(plan.projections);
    yield* compactPublicationPhase(plan.manifest);
    yield* compactPublicationPhase(plan.snapshot);
    yield* compactPublicationPhase(plan.journal);
    yield* compactPublicationPhase(plan.candidateFinalization);
    yield* compactPublicationPhase(plan.current);
  })();
}

/** Every immutable publication write is checkpointed so a false conflict predicate cannot be silent. */
export function checkedPublicationCommand(command: SqliteCommand): SqliteCommand[] {
  return [{ kind: "transaction_checkpoint" }, command, { kind: "assert_transaction_changes", expected: 1 }];
}

/** Fault boundaries are part of the shared publication protocol, not entry-point-specific behavior. */
export function publicationFaultCommand(faults: FaultInjector, boundary: FaultBoundary): SqliteCommand[] {
  return faults.isPending?.(boundary) === true ? [{ kind: "fault", boundary }] : [];
}

function validatePublicationCommandGroups(plan: PublicationCommandGroups): void {
  const candidateGroups = [plan.candidateState, plan.journal, plan.candidateFinalization, plan.manifest];
  const hasCandidateCommands = candidateGroups.some((group) => group.length > 0);
  if (plan.mode === "compatibility" && hasCandidateCommands) throw new Error("Compatibility publication cannot contain candidate commands.");
  if (plan.mode === "candidate" && (plan.candidateState.length === 0 || plan.journal.length === 0 || plan.current.length === 0)) throw new Error("Candidate publication requires candidate, journal, and current-state commands.");
}

const faultCommand = publicationFaultCommand;
type TransactionCommand = Parameters<SqliteDatabase["transaction"]>[0][number];

// This module builds and validates the *complete* write set for one candidate
// generation's publication. `CandidateMaterialization`'s template-set fields now hold
// only a small, bounded `OrderedSetDescriptor` (descriptor-as-text -- see
// `packages/engine/src/candidate-materialization.ts`); the actual template arrays travel
// out-of-band via `CandidatePublicationInput.template_sets`; the repository stores
// only the bounded descriptor and durable recovery replays confirmed FactDelta batches. No per-row
// payload this module encodes is expected to exceed `@urdira/canonical`'s shared default
// resource limits anymore, so every canonical encode and digest in this file uses those
// defaults.
function encodeCanonical(value: unknown, limits?: CanonicalEncodingLimits): Uint8Array {
  return encodeCanonicalBytes(value, limits);
}
function canonicalSha256(value: unknown): string { return digestBytes(encodeCanonical(value)); }

// `Snapshot.capability_state_digest` is contractually
// `input(ordered_set(SnapshotCapabilityStateEntry, core:capability_state_order@1))`
// (docs/serialization/core-digest-field-contracts.md): the comparator exists so the
// digest is independent of map or storage iteration order. Callers hand entries in
// whatever order they hold them (a staged publish's stage-grouped emission order, a
// fork/import's `ORDER BY state_key` read-back order), so the sort here is what makes
// the donor's declared digest and any copy's recomputed digest comparable at all.
const CAPABILITY_STATE_ORDER_COMPARATOR = (() => {
  const comparator = comparatorDefinitions.find((entry) => entry.comparator_id === "core:capability_state_order" && entry.comparator_version === 1);
  if (comparator === undefined) throw new StorageError("storage:publication_invalid", "The core:capability_state_order@1 comparator is missing from the contracts registry.");
  return comparator;
})();
function capabilityStateDigest(entries: readonly unknown[]): string {
  return canonicalSha256(sortCanonicalValues(entries, CAPABILITY_STATE_ORDER_COMPARATOR));
}

const PACKED_CREATED_IDENTITY_MARKER = "urdira:created-identity:v1";
type PackedCreatedIdentityAssignment = readonly [
  typeof PACKED_CREATED_IDENTITY_MARKER,
  workspace_id: string,
  identity_type: string,
  identity_key: string,
  record_id: string,
  owner_artifact_id: string,
  owner_artifact_version_id: string,
];

function isPackedCreatedIdentityAssignment(value: unknown): value is PackedCreatedIdentityAssignment {
  return Array.isArray(value)
    && value.length === 7
    && value[0] === PACKED_CREATED_IDENTITY_MARKER
    && value.every((entry) => typeof entry === "string");
}

function unpackCreatedIdentityAssignment(value: PackedCreatedIdentityAssignment): Record<string, unknown> {
  const [, workspaceId, identityType, identityKey, recordId, ownerArtifactId, ownerArtifactVersionId] = value;
  // `@urdira/engine`'s `candidate-materialization.ts` memoizes this exact
  // triple the moment it builds the packed tuple (same array identity,
  // threaded here out-of-band, uncloned); reuse it instead of recomputing
  // all three digests a second time during publish. A resumed/recovered
  // candidate's rehydrated tuples are a different array identity and simply
  // miss the memo, falling back to the recompute below -- never wrong.
  const memoized = memoizedPackedIdentityTriple(value);
  return {
    identity_assignment_id: memoized?.identity_assignment_id ?? canonicalSha256({ record_id: recordId, identity_key: identityKey }),
    workspace_id: workspaceId,
    identity_type: identityType,
    identity_id: `${identityType}:${memoized?.identity_id_suffix ?? canonicalSha256({ identity_key: identityKey }).slice("sha256:".length)}`,
    assignment_kind: "created",
    identity_key: identityKey,
    identity_key_digest: memoized?.identity_key_digest ?? canonicalSha256(identityKey),
    record_id: recordId,
    owner_artifact_id: ownerArtifactId,
    owner_artifact_version_id: ownerArtifactVersionId,
  };
}

function isPackedCandidateTemplate(value: unknown): boolean {
  return isPackedCreatedIdentityAssignment(value)
    || value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>)["canonical_template"] === "string";
}

function candidateTemplateValue(value: unknown): unknown {
  if (isPackedCreatedIdentityAssignment(value)) return unpackCreatedIdentityAssignment(value);
  if (value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>)["canonical_template"] === "string") {
    try { return JSON.parse(String((value as Record<string, unknown>)["canonical_template"])); }
    catch { throw new StorageError("storage:publication_invalid", "Packed candidate template is not valid JSON."); }
  }
  return value;
}

function digestCandidateTemplateArray(entries: readonly unknown[]): string {
  // LogicalDigestWriter has its own domain and therefore cannot provide the
  // byte-identical canonical-array digest. Use the ordinary canonical helper
  // for uncompressed sets and a bounded decoded view for packed identities.
  // `entries[0]` alone decides packed-vs-plain for the whole array: engine's
  // producers (`candidate-materialization.ts`) each make that call once, from
  // a single length/threshold check, and apply it to every entry uniformly --
  // see that file's `orderedSetDescriptor` doc comment for the full argument.
  // A recovery/direct caller's reconstructed array carries the same
  // (persisted, engine-authored) packed-or-not shape it was built with, so
  // this holds for those too. Avoids a full `.some()` scan whose answer is
  // always false for every template set except identity assignments --
  // including a from-scratch scan's 1,000,000-entry record-open set.
  if (entries.length === 0 || !isPackedCandidateTemplate(entries[0])) return digestCanonicalArray(entries);
  return digestMappedCanonicalArray(entries, "urdira:candidate-template-logical-value:v2", candidateTemplateValue);
}

/** @internal Exported for exact-path authority validation tests. */
export interface RecordOpenMemoEntry {
  readonly recordId: string;
  readonly recordDigest: string;
}

function promotedRecordOpen(entry: unknown): RecordOpenMemoEntry | undefined {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const value = entry as Record<string, unknown>;
  return typeof value["record_id_hint"] === "string" && typeof value["record_digest_hint"] === "string"
    ? { recordId: value["record_id_hint"], recordDigest: value["record_digest_hint"] }
    : undefined;
}

function recordOpenMemoEntry(entry: unknown, memo: ReadonlyMap<unknown, RecordOpenMemoEntry>): RecordOpenMemoEntry | undefined {
  return promotedRecordOpen(entry) ?? memo.get(entry);
}

/**
 * Parses and canonically digests each `record_open` template entry's
 * `record_without_validity` JSON exactly once, keyed by entry object
 * identity, so `computeSnapshotDigestFields`, `assertPublicationImmutableRows`,
 * and `recordOpenCommands` -- which each independently need this record's id
 * (`record:${sha256}`) and digest -- share one computation instead of each
 * re-parsing and re-hashing the same record (measured up to 5x per record
 * across those three call sites before this memo existed). Only the small
 * digest/id strings are retained per entry: the canonical-encoded byte array
 * used to compute the digest is never kept past the single `digestBytes`
 * call that consumes it (mirroring `digestCanonicalArray`'s per-element
 * streaming pattern in `@urdira/canonical`), and the parsed record object
 * itself is not retained here at all -- callers that need it (rare: only the
 * conflict-detection path in `assertPublicationImmutableRows`, and the
 * always-taken row-build path in `recordOpenCommands`) re-parse the same
 * already-in-memory `record_without_validity` string, which is cheap
 * (no canonical encoding or hashing) relative to what this memo eliminates.
 */
/**
 * (3c) Trusts a seal-supplied memo only when it has an entry for every
 * `recordOpens` template object it's checked against (by reference) -- the
 * exact array `CandidateMaterializer.seal()` built the memo from, in the
 * same process, moments earlier (`workspace-indexing-session.ts` threads
 * `sealed.record_open_memo` straight through `template_sets.record_opens`
 * without cloning). A memo from a different call (fork path, a recovery
 * replay that reloaded `record_opens` from storage, or simply omitted) won't
 * have every entry and is rejected wholesale here, falling back to nothing
 * -- never a partial/wrong substitution, only a lost optimization.
 */
function suppliedRecordOpenMemo(opens: readonly unknown[], supplied: ReadonlyMap<unknown, RecordOpenMemoEntry> | undefined): ReadonlyMap<unknown, RecordOpenMemoEntry> | undefined {
  if (supplied === undefined) return undefined;
  for (const entry of opens) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof (entry as Record<string, unknown>)["record_without_validity"] !== "string") continue;
    if (!supplied.has(entry)) return undefined;
  }
  return supplied;
}

// (3b) Every long, purely-synchronous loop below that scales with record
// count (~1M on a from-zero index of a large repository) yields the event
// loop periodically instead of blocking it for the loop's entire duration --
// status-poll and other daemon RPCs get a turn every `COOPERATIVE_YIELD_INTERVAL`
// entries. The interval is large enough that the yield overhead itself stays
// well under 1% of the loop's own cost (a `setImmediate` round trip is
// microseconds; the per-record work it's interleaved with is not).
const COOPERATIVE_YIELD_INTERVAL = 25_000;

function cooperativeYield(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve); });
}

async function memoizeRecordOpens(opens: readonly unknown[]): Promise<ReadonlyMap<unknown, RecordOpenMemoEntry>> {
  const memo = new Map<unknown, RecordOpenMemoEntry>();
  let index = 0;
  for (const entry of opens) {
    index += 1;
    if (index % COOPERATIVE_YIELD_INTERVAL === 0) await cooperativeYield();
    if (!entry || typeof entry !== "object") continue;
    const raw = (entry as Record<string, unknown>)["record_without_validity"];
    if (typeof raw !== "string") continue;
    let record: unknown;
    try { record = JSON.parse(raw); } catch { throw new StorageError("storage:publication_invalid", "Record open template is not valid JSON."); }
    // `record_without_validity` is the canonical JSON of exactly the id's
    // digest input (decision 11): the bare content-pure record on a first
    // open, or `{record, previous_record_id}` / `{record, absence_barrier}` /
    // their union on a replacement and/or absence-barrier reopen
    // (`recordTemplates`, packages/engine/src/candidate-materialization.ts).
    // Digesting the whole parsed value, wrapped or not, re-derives the
    // identical id byte-for-byte -- this mechanic is unchanged by the wrapper.
    const recordDigest = canonicalSha256(record);
    const promoted = promotedRecordOpen(entry);
    if (promoted !== undefined) {
      if (promoted.recordDigest !== recordDigest || promoted.recordId !== `record:${recordDigest.slice("sha256:".length)}`) {
        throw new StorageError("storage:publication_invalid", "Promoted record-open identity does not match its canonical record.");
      }
      continue;
    }
    memo.set(entry, { recordId: `record:${recordDigest.slice("sha256:".length)}`, recordDigest });
  }
  return memo;
}

/**
 * Eager replacement for `memoizeRecordOpens` that ALSO caches each entry's
 * parsed-and-unwrapped record (`unwrapRecordTemplate`'s result) for
 * `recordOpenCommands` to reuse, so `record_without_validity` is only ever
 * `JSON.parse`d once per entry across the whole publish -- not fused into a
 * single pass with `recordOpenCommands` itself, deliberately: `recordOpenCommands`
 * still has to run strictly AFTER `assertPublicationImmutableRows` (which
 * consumes this function's memo), because `assertPublicationImmutableRows`'s
 * per-field `rowMatches` comparison is what turns a sparse/conflicting
 * pre-existing row into the intended `storage:publication_conflict` --
 * building `recordOpenCommands`' SQL params (which touch fields
 * `rowMatches` never short-circuits past, like a missing
 * `owner_artifact_id`) any earlier would let a malformed/sparse template
 * entry throw a raw canonical-encoding error instead of that conflict, for
 * entries `assertPublicationImmutableRows` would otherwise have rejected
 * first. Splitting the parse from the command-build keeps that ordering
 * intact while still eliminating the double `JSON.parse` this file used to
 * pay per record open.
 */
async function parseRecordOpens(opens: readonly unknown[]): Promise<{ readonly memo: ReadonlyMap<unknown, RecordOpenMemoEntry>; readonly parsedByEntry: ReadonlyMap<unknown, Record<string, unknown>> }> {
  const memo = new Map<unknown, RecordOpenMemoEntry>();
  const parsedByEntry = new Map<unknown, Record<string, unknown>>();
  let index = 0;
  for (const entry of opens) {
    index += 1;
    if (index % COOPERATIVE_YIELD_INTERVAL === 0) await cooperativeYield();
    if (!entry || typeof entry !== "object") continue;
    const raw = (entry as Record<string, unknown>)["record_without_validity"];
    if (typeof raw !== "string") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new StorageError("storage:publication_invalid", "Record open template is not valid JSON."); }
    // See `memoizeRecordOpens`'s doc comment above: digest the whole parsed
    // value (wrapped or not), unchanged by this fusion.
    const recordDigest = canonicalSha256(parsed);
    memo.set(entry, { recordId: `record:${recordDigest.slice("sha256:".length)}`, recordDigest });
    parsedByEntry.set(entry, unwrapRecordTemplate(parsed));
  }
  return { memo, parsedByEntry };
}

/**
 * `record_without_validity`'s parsed JSON is the digest input, which may be
 * the bare content-pure record or a `{record, ...salt}` wrapper (decision
 * 05) -- unwrap to reach the record's own fields (`body`, `category`, ...).
 * A bare `ProposedRecord` never has a field literally named `record`, so
 * this is unambiguous.
 */
function unwrapRecordTemplate(parsed: unknown): Record<string, unknown> {
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const inner = (parsed as Record<string, unknown>)["record"];
    if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) return inner as Record<string, unknown>;
  }
  return parsed as Record<string, unknown>;
}
/** @internal Exported for exact-path authority validation tests. */
export function sqliteValue(value: unknown): SqliteValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return value;
  return encodeCanonical(value);
}
/** @internal Exported for exact-path authority validation tests. */
export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new StorageError("storage:invalid_blob", "SQLite returned a non-binary payload.");
}
/** @internal Exported for exact-path authority validation tests. */
export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
/** @internal Exported for exact-path authority validation tests. */
export function rowMatches(row: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => {
    const actual = row[key];
    if (value instanceof Uint8Array) return actual instanceof Uint8Array && sameBytes(actual, value);
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") return actual === value;
    return sameBytes(toBytes(actual), encodeCanonical(value));
  });
}
/**
 * The exact column-name subset of `rowMatches`'s own per-field comparison
 * that disagreed, for `assertPublicationImmutableRows`'s `conflict()` --
 * `storage:publication_conflict`'s `details` used to be empty (`{}`), making
 * every real conflict a from-scratch diagnostic exercise (reproduced via a
 * real 981-file repository's post-fork incremental publish once, tracing it
 * cost significant manual instrumentation). Recomputes the same
 * field-by-field logic `rowMatches` uses rather than threading a shared
 * accumulator through it, since `rowMatches` is also called from contexts
 * (e.g. this file's other exact-path checks) that only ever need the boolean
 * and are on a hot path; this function is only ever called once, right
 * before throwing.
 */
export function mismatchedFields(row: Record<string, unknown>, expected: Record<string, unknown>): readonly string[] {
  return Object.entries(expected).flatMap(([key, value]) => {
    const actual = row[key];
    // `rowMatches`'s own `.every()` short-circuits at the first mismatched
    // field, so it never evaluates comparisons past that point -- in
    // particular, `toBytes(actual)` (in the final branch below) throws
    // `storage:invalid_blob` for a genuinely absent/non-binary column,
    // which `rowMatches` never observes if an earlier field already
    // differed. This function deliberately evaluates every field (so it can
    // report all of them, not just the first), which means it CAN reach a
    // field `rowMatches` would have skipped -- caught here and treated as a
    // mismatch (an unsafe/throwing comparison is certainly not a match)
    // rather than letting this diagnostic-only helper itself crash the
    // conflict path it exists to make legible.
    let matches: boolean;
    try {
      matches = value instanceof Uint8Array ? actual instanceof Uint8Array && sameBytes(actual, value)
        : value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" ? actual === value
        : sameBytes(toBytes(actual), encodeCanonical(value));
    } catch { matches = false; }
    return matches ? [] : [key];
  });
}

/** @internal Exported for exact-path authority validation tests. */
export function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return [...value];
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new StorageError("storage:publication_invalid", "Candidate materialization template set is not valid JSON.");
  }
}

/**
 * Verifies that a template array the caller supplied out-of-band
 * (`CandidatePublicationInput.template_sets`) matches the `OrderedSetDescriptor`
 * committed inside the digested `CandidateMaterialization` field named `fieldName`. The
 * descriptor is the committed truth (it is inside `materialization_digest`); the array is
 * transport. A missing (`undefined`) descriptor field is only valid for an empty array.
 *
 * Returns the `digestCanonicalArray(entries)` this verification computed, so
 * a caller that also needs that exact digest (`buildManifestDescriptors`,
 * via `changeSetDescriptor`, for the four template sets that get both a
 * verify pass here AND a manifest change-set descriptor) can reuse it
 * instead of re-digesting the same array a second time -- see
 * `buildCandidatePublicationPlan`'s call site.
 */
function verifyTemplateSetAgainstDescriptor(descriptorText: string | undefined, entries: readonly unknown[], fieldName: string): string {
  // The engine computes the descriptor over deeply frozen arrays and passes
  // those exact identities to publication. Reuse the digest memoized by the
  // canonical module in that trusted in-process path. Direct/recovery callers
  // with reconstructed or mutable arrays still take the full fail-closed
  // canonical verification below.
  const expectedDigest = memoizedCanonicalArrayDigest(entries, "urdira:candidate-template-logical-value:v2")
    ?? memoizedCanonicalArrayDigest(entries)
    ?? digestCandidateTemplateArray(entries);
  if (descriptorText === undefined) {
    if (entries.length !== 0) throw new StorageError("storage:template_set_mismatch", `Template set ${fieldName} has no descriptor but ${entries.length} entries were supplied.`);
    return expectedDigest;
  }
  let descriptor: unknown;
  try { descriptor = JSON.parse(descriptorText); } catch { throw new StorageError("storage:template_set_mismatch", `Template set ${fieldName} descriptor is not valid JSON.`); }
  if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) throw new StorageError("storage:template_set_mismatch", `Template set ${fieldName} descriptor is not an object.`);
  const record = descriptor as Record<string, unknown>;
  if (typeof record["entry_count"] !== "number" || record["entry_count"] !== entries.length) throw new StorageError("storage:template_set_mismatch", `Template set ${fieldName} entry count ${entries.length} does not match its descriptor.`);
  if (record["content_digest"] !== expectedDigest) throw new StorageError("storage:template_set_mismatch", `Template set ${fieldName} content digest does not match its descriptor.`);
  return expectedDigest;
}

interface ChangeSetDescriptor {
  readonly change_set_kind: string;
  readonly entry_schema_version: string;
  readonly comparator_id: string;
  readonly comparator_version: string;
  readonly entry_count: number;
  readonly content_digest: string;
}

/**
 * `precomputedDigest`, when supplied, must be exactly
 * `digestCanonicalArray(entries)` for the same `entries` array -- callers
 * that already computed that digest for another purpose over the identical
 * array reference (`buildCandidatePublicationPlan`'s
 * `verifyTemplateSetAgainstDescriptor` calls, for the four template sets
 * that get both a verify pass and a manifest change-set descriptor) pass it
 * through here instead of paying for a second, redundant
 * `digestCanonicalArray` pass over the same entries.
 */
/** @internal Exported for exact-path authority validation tests. */
export function changeSetDescriptor(changeSetKind: string, entries: readonly unknown[], precomputedDigest?: string): ChangeSetDescriptor {
  return {
    change_set_kind: changeSetKind,
    entry_schema_version: "1",
    comparator_id: "core:lexicographic_uri",
    comparator_version: "1",
    entry_count: entries.length,
    content_digest: precomputedDigest ?? digestCandidateTemplateArray(entries),
  };
}

interface ManifestDescriptors {
  readonly artifact_change_set: ChangeSetDescriptor;
  readonly record_open_set: ChangeSetDescriptor;
  readonly record_closure_set: ChangeSetDescriptor;
  readonly identity_assignment_set: ChangeSetDescriptor;
  readonly projection_change_sets: ChangeSetDescriptor;
}

/** Precomputed `digestCanonicalArray` results `buildManifestDescriptors` can reuse -- see `changeSetDescriptor`'s doc comment. */
interface PrecomputedManifestDigests {
  readonly sourceTransitions?: string;
  readonly recordOpens?: string;
  readonly recordClosures?: string;
  readonly identityAssignments?: string;
}

/**
 * `GenerationChangeManifest`'s five giant TEXT change-set columns each hold a small
 * `ChangeSetDescriptor` JSON object (per
 * `docs/serialization/core-digest-field-contracts.md`'s `GenerationChangeManifest.manifest_digest`
 * row: "Descriptor values contain their exact content digests") instead of the full
 * change-set array, matching the same descriptor-as-text decision applied to
 * `CandidateMaterialization`.
 */
/** @internal Exported for exact-path authority validation tests. */
export function buildManifestDescriptors(sourceTransitions: readonly unknown[], recordOpens: readonly unknown[], recordClosures: readonly unknown[], identityAssignments: readonly unknown[], projectionOpens: readonly unknown[], projectionClosures: readonly unknown[], precomputedDigests?: PrecomputedManifestDigests): ManifestDescriptors {
  return {
    artifact_change_set: changeSetDescriptor("core:artifact_change_set", sourceTransitions, precomputedDigests?.sourceTransitions),
    record_open_set: changeSetDescriptor("core:record_open_set", recordOpens, precomputedDigests?.recordOpens),
    record_closure_set: changeSetDescriptor("core:record_closure_set", recordClosures, precomputedDigests?.recordClosures),
    identity_assignment_set: changeSetDescriptor("core:identity_assignment_set", identityAssignments, precomputedDigests?.identityAssignments),
    projection_change_sets: changeSetDescriptor("core:projection_change_set", [...projectionOpens, ...projectionClosures]),
  };
}

interface SnapshotRow {
  readonly snapshot_id: string;
  readonly workspace_id: string;
  readonly generation: number;
  readonly parent_snapshot_id?: string;
  readonly generation_manifest_id: string;
  readonly registry_snapshot_id: string;
  readonly resolution_lock_id: string;
  readonly configuration_revision_id: string;
  readonly source_state_digest: string;
  readonly source_observation_watermarks: string;
  readonly canonical_record_set_digest: string;
  readonly projection_set_digests: string;
  readonly capability_state_digest: string;
  readonly published_at: string;
  readonly snapshot_digest: string;
}

interface GenerationManifestRow {
  readonly generation_manifest_id: string;
  readonly workspace_id: string;
  readonly candidate_generation_id: string;
  readonly generation: number;
  readonly snapshot_id: string;
  readonly base_snapshot_id?: string;
  readonly registry_snapshot_id: string;
  readonly publication_kind: string;
  readonly published_at: string;
  readonly artifact_change_set: string;
  readonly record_open_set: string;
  readonly record_closure_set: string;
  readonly identity_assignment_set: string;
  readonly projection_change_sets: string;
  readonly manifest_digest: string;
}

/** @internal Exported for exact-path authority validation tests. */
export function manifestRow(generationManifestId: string, workspaceId: string, candidateId: string, generation: number, snapshotId: string, baseSnapshotId: string | undefined, registrySnapshotId: string, publicationKind: string, publishedAt: string, descriptors: ManifestDescriptors): GenerationManifestRow {
  const digestPayload = {
    generation_manifest_id: generationManifestId,
    workspace_id: workspaceId,
    candidate_generation_id: candidateId,
    generation,
    snapshot_id: snapshotId,
    base_snapshot_id: baseSnapshotId ?? null,
    registry_snapshot_id: registrySnapshotId,
    publication_kind: publicationKind,
    published_at: publishedAt,
    artifact_change_set: descriptors.artifact_change_set,
    record_open_set: descriptors.record_open_set,
    record_closure_set: descriptors.record_closure_set,
    identity_assignment_set: descriptors.identity_assignment_set,
    projection_change_sets: descriptors.projection_change_sets,
  };
  return {
    generation_manifest_id: generationManifestId,
    workspace_id: workspaceId,
    candidate_generation_id: candidateId,
    generation,
    snapshot_id: snapshotId,
    ...(baseSnapshotId === undefined ? {} : { base_snapshot_id: baseSnapshotId }),
    registry_snapshot_id: registrySnapshotId,
    publication_kind: publicationKind,
    published_at: publishedAt,
    artifact_change_set: JSON.stringify(descriptors.artifact_change_set),
    record_open_set: JSON.stringify(descriptors.record_open_set),
    record_closure_set: JSON.stringify(descriptors.record_closure_set),
    identity_assignment_set: JSON.stringify(descriptors.identity_assignment_set),
    projection_change_sets: JSON.stringify(descriptors.projection_change_sets),
    manifest_digest: canonicalSha256(digestPayload),
  };
}

/**
 * The exact positive-field shape `StorageMaintenance.verify()` recomputes and compares
 * `snapshots.snapshot_digest` against (`packages/storage/src/lifecycle.ts`): every
 * `Snapshot` field except `snapshot_digest` itself, via
 * `computeDigest("core:snapshot", "core:snapshot_digest", 1, "core:SnapshotDigestPayload", 1, ...)`.
 */
/** @internal Exported for exact-path authority validation tests. */
export function snapshotDigest(snapshot: Readonly<Record<string, unknown>>): string {
  const { snapshot_digest: _snapshotDigest, ...positive } = snapshot;
  return computeDigest("core:snapshot", "core:snapshot_digest", 1, "core:SnapshotDigestPayload", 1, positive);
}

/**
 * Computes `canonical_record_set_digest` and `projection_set_digests` in exactly the
 * shape `StorageMaintenance.verify()` (`packages/storage/src/lifecycle.ts`) recomputes and
 * checks them against, so a freshly published workspace passes `verifyIntegrity` with zero
 * issues:
 *
 * - `canonical_record_set_digest`: `computeDigest("core:canonical_record_set",
 *   "core:snapshot_record_set_digest", ...)` over the post-publication visible
 *   `{record_id, record_digest}` set, sorted by `record_id` ascending (matching the
 *   verifier's `ORDER BY record_id`). The post-publication visible set is this publish's
 *   pre-transaction visible set (queried live from `record_occurrences`, since this runs
 *   before the transaction commits -- or, when the calling workspace handle's warm
 *   `RecordSetDigestCorpusEntry` matches this exact `(workspaceId, oldGeneration)`, read
 *   from that corpus instead: it IS a prior call's own `sortedVisible` output for that
 *   generation, so the result is unchanged, only the SQL read is skipped -- see
 *   `RecordSetDigestCorpusEntry`'s doc comment) with this publish's closures removed and
 *   opens added, each record's id and digest derived exactly as `recordOpenCommands`
 *   derives them: `record:${canonicalSha256(JSON.parse(record_without_validity)).slice(...)}`
 *   / `canonicalSha256(JSON.parse(record_without_validity))`.
 * - `projection_set_digests`: the verifier rejects an aggregate digest string outright
 *   (`isDigest(row.projection_set_digests)` must be false) and instead parses a JSON array
 *   of `ProjectionSetDigestEntry` and compares it, canonically, against
 *   `getProjectionSetDigestEntries(generation)`. So the writer computes and stores exactly
 *   that array, via the same standalone `projectionSetDigestEntries` the verifier calls --
 *   this call site asks for `{ digest_source: "stored" }` (reads each row's
 *   precomputed `content_digest` column) where the verifier's always asks for
 *   `"recompute"` (recomputes from typed columns), but both modes are defined to
 *   produce byte-identical entries for the same visible rows, so the
 *   comparison still holds exactly. The three transactional kinds' row sets
 *   are this publish's pre-transaction visible rows (queried live, since this
 *   runs before the transaction commits -- same timing as the record set
 *   above -- or, when the calling workspace handle's warm
 *   `ProjectionSetDigestCorpusEntry` matches this exact `(workspaceId,
 *   oldGeneration)`, read from that corpus instead) WITH this publish's own
 *   `artifact_dependencies` opens (derived from `artifactDependencies`)
 *   merged in -- `artifactDependencyDigestOpens` + `mergeProjectionKindRows`,
 *   mirroring exactly the discipline `recordOpens`/`recordClosures` get
 *   folded into `sortedVisible` above, for the identical reason: the
 *   post-publication visible set genuinely includes the rows THIS
 *   transaction is about to write, and the stored digest must describe that,
 *   not the pre-transaction state alone. (An earlier version of this
 *   function computed `projection_set_digests` from the pre-transaction rows
 *   ALONE, unlike the record set -- a real bug, confirmed against a live
 *   bench workspace: stored dependency digests lagged one publish behind,
 *   verifiable only by `verify()` recomputing against currently-committed
 *   state. Snapshots published before this fix keep that lagging value
 *   forever -- snapshots are immutable and are never rewritten -- so
 *   `verify()` run against a pre-fix historic generation can still report
 *   `storage:projection_set_digest_corrupt` for it; only snapshots published
 *   by this fixed code are guaranteed clean.) The resulting merged row set is
 *   exactly what gets stashed as the corpus candidate for the next publish
 *   too (`ProjectionSetDigestCorpusEntry`'s doc comment) -- one merge serves
 *   both purposes, again mirroring `sortedVisible`.
 */
/** @internal Exported for exact-path authority validation tests. */
export async function computeSnapshotDigestFields(database: SqliteDatabase, workspaceId: string, current: CandidatePublicationPlanInput["current"], generation: number, recordOpens: readonly unknown[], recordClosures: readonly unknown[], recordOpenMemo?: ReadonlyMap<unknown, RecordOpenMemoEntry>, corpus?: RecordSetDigestCorpusEntry, artifactDependencies: readonly unknown[] = [], projectionCorpus?: ProjectionSetDigestCorpusEntry): Promise<{ readonly canonical_record_set_digest: string; readonly projection_set_digests: string; readonly sortedVisible: readonly { readonly record_id: string; readonly record_digest: string }[]; readonly record_set_digest_corpus_complete: boolean; readonly sortedProjectionsByKind: Readonly<Record<ProjectionDigestKind, readonly ProjectionKindDigestRow[]>> }> {
  const oldGeneration = current?.current_generation;
  let sortedVisible: readonly { readonly record_id: string; readonly record_digest: string }[] = [];
  let recordSetDigestCorpusComplete = true;
  const canonicalRecordSetDigest = await timed("publish_record_set_digest", async () => {
    const promotedFirstOpen = oldGeneration === undefined && recordClosures.length === 0 && recordOpens.every((entry) => promotedRecordOpen(entry) !== undefined);
    if (promotedFirstOpen) {
      const rows = function* (): Iterable<{ readonly record_id: string; readonly record_digest: string }> {
        for (const entry of recordOpens) {
          const opened = promotedRecordOpen(entry)!;
          yield { record_id: opened.recordId, record_digest: opened.recordDigest };
        }
      };
      if (recordOpens.length < STREAMING_PUBLICATION_RECORD_THRESHOLD) sortedVisible = [...rows()];
      else recordSetDigestCorpusComplete = false;
      return digestSortedRecordSet(rows(), recordOpens.length);
    }
    // Corpus hit only when it is both for this exact workspace and for this
    // exact prior generation (`RecordSetDigestCorpusEntry`'s doc comment) --
    // a generation mismatch (stale entry, or no entry yet: daemon restart,
    // first publish, fork) always falls back to the unconditional SQL read
    // below, exactly as before the corpus existed.
    const corpusHit = corpus !== undefined && oldGeneration !== undefined && corpus.workspaceId === workspaceId && corpus.generation === oldGeneration && digestCorpusEnabled() ? corpus : undefined;
    if (corpusHit !== undefined) timedSync("publish_record_set_digest_corpus_hit", () => undefined);
    // The corpus IS a prior call's own `sortedVisible` output (bit-identical
    // by construction), so building `visible` from it instead of `oldVisible`
    // rows read fresh from SQL cannot change the result -- only skip the read.
    const oldVisible = corpusHit !== undefined
      ? corpusHit.sortedVisible
      : oldGeneration === undefined
        ? []
        : await database.all<{ record_id: string; record_digest: string }>("SELECT record_id, record_digest FROM record_occurrences WHERE workspace_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)", [workspaceId, oldGeneration, oldGeneration]);
    const visible = new Map(oldVisible.map((row) => [row.record_id, row.record_digest] as const));
    let closureIndex = 0;
    for (const entry of recordClosures) {
      closureIndex += 1;
      if (closureIndex % COOPERATIVE_YIELD_INTERVAL === 0) await cooperativeYield();
      if (!entry || typeof entry !== "object") continue;
      const recordId = (entry as Record<string, unknown>)["record_id"];
      if (typeof recordId === "string") visible.delete(recordId);
    }
    const memo = recordOpenMemo ?? await memoizeRecordOpens(recordOpens);
    let openIndex = 0;
    for (const entry of recordOpens) {
      openIndex += 1;
      if (openIndex % COOPERATIVE_YIELD_INTERVAL === 0) await cooperativeYield();
      const opened = recordOpenMemoEntry(entry, memo);
      if (!opened) continue;
      visible.set(opened.recordId, opened.recordDigest);
    }
    sortedVisible = [...visible.entries()]
      .map(([record_id, record_digest]) => ({ record_id, record_digest }))
      .sort((left, right) => (left.record_id < right.record_id ? -1 : left.record_id > right.record_id ? 1 : 0));
    // Streamed per element: the visible record set scales with workspace size and
    // a single-call encode would trip the default aggregate canonical limits.
    return logicalRecordSetDigest(sortedVisible);
  });
  let sortedProjectionsByKind: Readonly<Record<ProjectionDigestKind, readonly ProjectionKindDigestRow[]>> = { graph: [], dependency: [], metric: [] };
  const projectionEntries: ReadonlyArray<ProjectionSetDigestEntry> = await timed("publish_projection_digests", async () => {
    const projectionCorpusHit = projectionCorpus !== undefined && oldGeneration !== undefined && projectionCorpus.workspaceId === workspaceId && projectionCorpus.generation === oldGeneration && digestCorpusEnabled() ? projectionCorpus : undefined;
    if (projectionCorpusHit !== undefined) timedSync("publish_projection_digest_corpus_hit", () => undefined);
    // `oldRowsByKind` -- whether corpus-sourced or a fresh SQL read -- is
    // exactly what a live `projectionSetDigestEntries` read at THIS
    // publish's own plan-build time already returns (see this function's
    // doc comment: its `valid_from_generation <= generation` filter can
    // never see rows THIS publish's own not-yet-committed transaction is
    // about to insert). A corpus miss still needs the RAW per-kind rows (not
    // just their aggregate digest) so the corpus can be seeded starting from
    // this publish, even though this publish itself gets no cache benefit --
    // `projectionSetDigestRowsByKind` is the same query
    // `projectionSetDigestEntries` runs internally, just exposed per-kind.
    const oldRowsByKind = projectionCorpusHit !== undefined ? projectionCorpusHit.sortedByKind : await projectionSetDigestRowsByKind(database, workspaceId, generation, "stored");
    // This publish's own `artifact_dependencies` opens are merged into the
    // old (pre-transaction) rows -- see this function's doc comment for why:
    // the post-publication visible set genuinely includes them, matching the
    // record-set discipline above exactly. The merged result serves BOTH as
    // this publish's own `projection_set_digests` source AND as the corpus
    // candidate stashed for the next publish -- one merge, two consumers,
    // same as `sortedVisible` above.
    const dependencyOpens = artifactDependencyDigestOpens(artifactDependencies, generation);
    sortedProjectionsByKind = {
      graph: oldRowsByKind.graph,
      dependency: mergeProjectionKindRows(oldRowsByKind.dependency, dependencyOpens),
      metric: oldRowsByKind.metric,
    };
    return await projectionSetDigestEntries(database, workspaceId, generation, { digest_source: "stored", row_overrides: sortedProjectionsByKind });
  });
  return { canonical_record_set_digest: canonicalRecordSetDigest, projection_set_digests: JSON.stringify(projectionEntries), sortedVisible, record_set_digest_corpus_complete: recordSetDigestCorpusComplete, sortedProjectionsByKind };
}

/**
 * The "dependency" kind's opens for THIS publish, derived from the exact
 * same typed input (`CandidateTemplateSets.artifact_dependencies`) and
 * filtering/digest recipe `artifactDependencyCommands` (below) uses to write
 * `artifact_dependencies` rows -- so a delta-merged corpus candidate and a
 * live SQL re-read of the same committed rows can only ever agree. Returns
 * one row per entry with a string `dependency_entry_id`, keyed
 * `${id}@${generation}` exactly as `projectionDigestRows`
 * (`./lifecycle.js`) keys a visible row by `${row_id}@${valid_from_generation}`.
 */
function artifactDependencyDigestOpens(artifactDependencies: readonly unknown[], generation: number): readonly ProjectionKindDigestRow[] {
  const rows: ProjectionKindDigestRow[] = [];
  for (const entry of artifactDependencies) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as Record<string, unknown>)["dependency_entry_id"];
    if (typeof id !== "string") continue;
    rows.push({ projection_record_id: `${id}@${generation}`, content_digest: digestLogicalValue(entry, "urdira:artifact-dependency:v2") });
  }
  return rows;
}

/**
 * Merges one kind's newly-opened rows into its prior row set, keyed by
 * `projection_record_id` (last write wins on a same-key collision, matching
 * `artifactDependencyCommands`'s `ON CONFLICT ... DO UPDATE`), and returns
 * the result sorted the same way `projectionSetDigestEntries` sorts before
 * digesting -- so a corpus candidate built from this is already in the
 * exact shape the next publish (or a direct inspection) expects, and
 * `projectionSetDigestEntries` re-sorting it again is a no-op.
 */
function mergeProjectionKindRows(oldRows: readonly ProjectionKindDigestRow[], opens: readonly ProjectionKindDigestRow[]): readonly ProjectionKindDigestRow[] {
  if (opens.length === 0) return oldRows;
  const byId = new Map(oldRows.map((row) => [row.projection_record_id, row] as const));
  for (const row of opens) byId.set(row.projection_record_id, row);
  return [...byId.values()].sort((left, right) => (left.projection_record_id < right.projection_record_id ? -1 : left.projection_record_id > right.projection_record_id ? 1 : 0));
}


// Batch size for `fetchExistingRowsById`/`fetchExistingProjectionDependencies`
// chunked `IN (...)` existence lookups. SQLite builds differ in their
// SQLITE_MAX_VARIABLE_NUMBER (the macOS build used by the release benchmark
// rejects the larger 2,000-row batch), so stay below the long-standing 999
// variable limit while leaving room for the fixed workspace/generation
// parameters used by these queries. A fixed size also keeps SQL text stable
// so the SQLite worker's prepared-statement cache can reuse it across chunks.
const EXISTENCE_CHECK_BATCH_ROWS = 900;

/**
 * Batches `assertPublicationImmutableRows`'s per-entry "does a row with this
 * id already exist" existence checks into chunked `id IN (...)` queries
 * instead of one `database.get` round trip per entry. This check exists to
 * detect and verify idempotent replay after a partial prior publication
 * attempt (docs/decisions/04-workspace-snapshot-incremental-indexing.md's
 * "Interrupted indexing recovery": a resumed candidate's already-committed
 * rows must match what this publication is about to write). On an ordinary,
 * non-resumed publication -- the overwhelming common case -- every one of
 * these lookups finds nothing, so the original per-entry version paid a full
 * SQLite-worker round trip per record/dependency/assignment/projection for a
 * result that is always "not found". Batching preserves the exact same
 * conflict semantics (a found row is still compared with `rowMatches`
 * exactly as before, decided entirely by whether the row exists and what it
 * contains, never by how the read was batched) while turning what was
 * O(entries) round trips into O(entries / batch size).
 */
async function fetchExistingRowsById(database: SqliteDatabase, table: string, workspaceId: string, idColumn: string, ids: readonly string[], extra?: { readonly column: string; readonly value: SqliteValue }): Promise<Map<string, Record<string, unknown>>> {
  const unique = [...new Set(ids)];
  const found = new Map<string, Record<string, unknown>>();
  for (let start = 0; start < unique.length; start += EXISTENCE_CHECK_BATCH_ROWS) {
    const chunk = unique.slice(start, start + EXISTENCE_CHECK_BATCH_ROWS);
    const params: SqliteValue[] = [workspaceId, ...chunk];
    let sql = `SELECT * FROM ${table} WHERE workspace_id = ? AND ${idColumn} IN (${chunk.map(() => "?").join(",")})`;
    if (extra) { sql += ` AND ${extra.column} = ?`; params.push(extra.value); }
    const rows = await database.all<Record<string, unknown>>(sql, params);
    for (const row of rows) found.set(String(row[idColumn]), row);
  }
  return found;
}

/**
 * Same batching idea as `fetchExistingRowsById`, specialized for
 * `projection_occurrence_dependencies`'s compound key (`projection_record_id`,
 * `valid_from_generation`, `source_type`, `source_id`): fetches every existing
 * dependency row for the touched projection ids and this generation in
 * chunked batches, keyed in JS by the full compound tuple so exact-match
 * lookup afterward is identical to the original per-tuple query's result.
 */
async function fetchExistingProjectionDependencies(database: SqliteDatabase, workspaceId: string, projectionRecordIds: readonly string[], generation: number): Promise<Map<string, Record<string, unknown>>> {
  const unique = [...new Set(projectionRecordIds)];
  const found = new Map<string, Record<string, unknown>>();
  for (let start = 0; start < unique.length; start += EXISTENCE_CHECK_BATCH_ROWS) {
    const chunk = unique.slice(start, start + EXISTENCE_CHECK_BATCH_ROWS);
    const rows = await database.all<Record<string, unknown>>(
      `SELECT * FROM projection_occurrence_dependencies WHERE workspace_id = ? AND valid_from_generation = ? AND projection_record_id IN (${chunk.map(() => "?").join(",")})`,
      [workspaceId, generation, ...chunk],
    );
    for (const row of rows) found.set(JSON.stringify([String(row["projection_record_id"]), String(row["source_type"]), String(row["source_id"])]), row);
  }
  return found;
}

async function assertPublicationImmutableRows(database: SqliteDatabase, workspaceId: string, input: CandidatePublicationInput, sourceTransitions: readonly unknown[], recordOpens: readonly unknown[], identityAssignments: readonly unknown[], projectionOpens: readonly unknown[], artifactDependencies: readonly unknown[], lookupDependencies: readonly unknown[], lookupRevalidations: readonly unknown[], capabilityStates: readonly unknown[], generation: number, publishedAt: string, materializationSealedAt: string, manifest: GenerationManifestRow, completedSnapshot: SnapshotRow, recordOpenMemo: ReadonlyMap<unknown, RecordOpenMemoEntry>): Promise<void> {
  const conflict = (kind: string, id: string, table: string, row: Record<string, unknown>, expected: Record<string, unknown>): never => { throw new StorageError("storage:publication_conflict", `Authoritative ${kind} ${id} differs from the sealed publication payload.`, { table, row_id: id, mismatched_fields: mismatchedFields(row, expected).join(",") }); };
  const registry = await database.get<Record<string, unknown>>("SELECT * FROM registry_snapshots WHERE workspace_id = ? AND registry_snapshot_id = ?", [workspaceId, input.target_registry.registry_snapshot_id]);
  {
    const expected = {
      registry_snapshot_id: input.target_registry.registry_snapshot_id,
      workspace_id: workspaceId,
      registry_contract_version: input.target_registry.registry_contract_version,
      core_registry_digest: input.target_registry.core_registry_digest,
      resolution_lock_id: input.target_resolution_lock.resolution_lock_id,
      registry_digest: input.target_registry.registry_digest,
    };
    if (registry && !rowMatches(registry, expected)) conflict("registry snapshot", input.target_registry.registry_snapshot_id, "registry_snapshots", registry, expected);
  }
  const controls: readonly [string, unknown, string | undefined][] = [
    [`plugin_resolution_lock:${input.target_resolution_lock.resolution_lock_id}`, input.target_resolution_lock, undefined],
    [`workspace_configuration_revision:${input.target_configuration.configuration_revision_id}`, input.target_configuration, undefined],
    [`workspace_freshness_checkpoint:${input.freshness_checkpoint.freshness_checkpoint_id}`, input.freshness_checkpoint, input.freshness_checkpoint.checkpoint_digest],
  ];
  for (const [key, value] of controls) {
    const row = await database.get<Record<string, unknown>>("SELECT * FROM control_plane_state WHERE workspace_id = ? AND state_key = ?", [workspaceId, key]);
    const isFreshness = key.startsWith("workspace_freshness");
    const expected = {
      state_key: key,
      workspace_id: workspaceId,
      state_kind: isFreshness ? "workspace_freshness_checkpoint" : key.startsWith("plugin_resolution") ? "plugin_resolution_lock" : "workspace_configuration_revision",
      state_json: JSON.stringify(value),
      ...(isFreshness ? { reference_workspace_id: workspaceId, reference_snapshot_id: input.source_snapshot_id ?? input.freshness_checkpoint.snapshot_id ?? input.frozen_base.snapshot_id ?? null, reference_source_state_digest: input.frozen_base.source_state_digest ?? null } : { reference_workspace_id: null, reference_snapshot_id: null, reference_source_state_digest: null }),
    };
    if (row && !rowMatches(row, expected)) conflict("control state", key, "control_plane_state", row, expected);
  }
  const materializationContractText = JSON.stringify(input.materialization);
  const materialization = await database.get<Record<string, unknown>>("SELECT * FROM candidate_materializations WHERE workspace_id = ? AND (candidate_materialization_id = ? OR materialization_digest = ?)", [workspaceId, input.materialization.candidate_materialization_id, input.materialization.materialization_digest]);
  {
    const expected = {
      candidate_materialization_id: input.materialization.candidate_materialization_id,
      workspace_id: workspaceId,
      candidate_generation_id: input.candidate.candidate_generation_id,
      materialization_digest: input.materialization.materialization_digest,
      sealed_at: materializationSealedAt,
      materialization_contract_text: materializationContractText,
    };
    if (materialization && !rowMatches(materialization, expected)) conflict("candidate materialization", input.materialization.candidate_materialization_id, "candidate_materializations", materialization, expected);
  }
  const versionIds: string[] = [];
  const tombstoneIds: string[] = [];
  for (const entry of sourceTransitions) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, any>;
    const version = value["target_artifact_version_without_generation"] as Record<string, any> | undefined;
    if (version && typeof version["artifact_version_id"] === "string") versionIds.push(version["artifact_version_id"]);
    const tombstone = value["target_artifact_tombstone_without_generation"] as Record<string, any> | undefined;
    if (tombstone && typeof tombstone["artifact_tombstone_id"] === "string") tombstoneIds.push(tombstone["artifact_tombstone_id"]);
  }
  const existingVersions = await fetchExistingRowsById(database, "artifact_versions", workspaceId, "artifact_version_id", versionIds);
  const existingTombstones = await fetchExistingRowsById(database, "artifact_tombstones", workspaceId, "artifact_tombstone_id", tombstoneIds);
  for (const entry of sourceTransitions) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, any>;
    const version = value["target_artifact_version_without_generation"] as Record<string, any> | undefined;
    if (version && typeof version["artifact_version_id"] === "string") {
      const row = existingVersions.get(version["artifact_version_id"]);
      const storedValidFrom = row === undefined ? generation : Number(row["valid_from_generation"]);
      const expected = {
        artifact_version_id: version["artifact_version_id"], workspace_id: workspaceId, artifact_id: version["artifact_id"], content_blob_id: version["content_blob_id"], content_hash: version["content_hash"], byte_length: version["byte_length"], encoding: version["encoding"], language_hint: version["language_hint"] ?? null, analysis_metadata_digest: version["analysis_metadata_digest"], created_from_observation_id: version["created_from_observation_id"], valid_from_generation: Number.isSafeInteger(storedValidFrom) && storedValidFrom <= generation ? storedValidFrom : generation, valid_to_generation: null,
      };
      // Stage-1 source cataloging commits independently before structural
      // publication. If several scans are cancelled in that gap, unchanged
      // current versions from earlier attempts legitimately carry an older
      // valid_from_generation than the final catch-up snapshot. No snapshot
      // was published at those intermediate generations, and the version is
      // open and visible at the catch-up generation, so its original start is
      // authoritative rather than a payload conflict. A future or closed row
      // remains invalid and is rejected by the same exact comparison.
      if (row && !rowMatches(row, expected)) conflict("artifact version", version["artifact_version_id"], "artifact_versions", row, expected);
    }
    const tombstone = value["target_artifact_tombstone_without_generation"] as Record<string, any> | undefined;
    if (tombstone && typeof tombstone["artifact_tombstone_id"] === "string") {
      const row = existingTombstones.get(tombstone["artifact_tombstone_id"]);
      // `tombstone["cause_references"]`/`["lineage_evidence_record_ids"]` are
      // ALREADY JSON-encoded strings here (`ArtifactTombstone.cause_references`/
      // `.lineage_evidence_record_ids` are typed `string`, not an array --
      // `packages/contracts/src/models.ts` -- and `SourceCandidatePlanner.addAbsence`,
      // `packages/engine/src/source-candidate-planning.ts`, sets them via
      // `JSON.stringify(...)` before this ever reaches `assertPublicationImmutableRows`).
      // Re-`JSON.stringify`-ing them here double-encoded the column, which
      // never matched the single-encoded value stage-1 source cataloging
      // (`GenericSourceIndexer`/`packages/storage/src/source-index.ts`'s
      // `tombstoneCommand`) had already written directly to this same row for
      // this same artifact earlier in the SAME scan -- deterministically
      // conflicting on every genuine deletion. Likewise, the payload must NOT
      // inject explicit `valid_to_generation`/`closing_artifact_change_id`/
      // `replacement_artifact_version_id: null` keys that stage-1's own
      // payload (`encodeCanonical` of its raw, key-omitting tombstone object)
      // never had -- an absent key and an explicit `null` value canonicalize
      // to different bytes (`canonicalize`, `packages/canonical/src/index.ts`,
      // only visits OWN enumerable keys). Mirrors the artifact_version
      // branch above, which already omits any such override.
      const storedValidFrom = row === undefined ? generation : Number(row["valid_from_generation"]);
      const expected = {
        artifact_tombstone_id: tombstone["artifact_tombstone_id"], workspace_id: workspaceId, artifact_id: tombstone["artifact_id"], absence_kind: tombstone["absence_kind"], absence_reason_code: tombstone["absence_reason_code"], last_artifact_version_id: tombstone["last_artifact_version_id"], valid_from_generation: Number.isSafeInteger(storedValidFrom) && storedValidFrom <= generation ? storedValidFrom : generation, valid_to_generation: null, opening_artifact_change_id: tombstone["opening_artifact_change_id"] ?? null, closing_artifact_change_id: null, replacement_artifact_version_id: null, cause_references: tombstone["cause_references"] ?? "[]", lineage_evidence_record_ids: tombstone["lineage_evidence_record_ids"] ?? "[]",
      };
      if (row && !rowMatches(row, expected)) conflict("artifact tombstone", tombstone["artifact_tombstone_id"], "artifact_tombstones", row, expected);
    }
  }
  const recordCount = await database.get<{ count: number }>("SELECT COUNT(*) AS count FROM record_occurrences WHERE workspace_id = ?", [workspaceId]);
  if (recordCount?.count !== 0) {
    // (3b) This branch only runs on a resumed/retried or otherwise non-fresh
    // publish (a real first publish takes the `recordCount?.count === 0`
    // fast path above and skips this whole block) -- but when it does run
    // over a repository-sized `recordOpens`, it's still ~1M synchronous
    // iterations with no other await in between; yield periodically so a
    // resumed large-workspace publish doesn't starve the daemon event loop
    // either.
    const recordIds: string[] = [];
    let recordIdIndex = 0;
    for (const entry of recordOpens) {
      recordIdIndex += 1;
      if (recordIdIndex % COOPERATIVE_YIELD_INTERVAL === 0) await cooperativeYield();
      const opened = recordOpenMemoEntry(entry, recordOpenMemo);
      if (opened) recordIds.push(opened.recordId);
    }
    const existingRecords = await fetchExistingRowsById(database, "record_occurrences", workspaceId, "record_id", recordIds);
    let recordCheckIndex = 0;
    for (const entry of recordOpens) {
      recordCheckIndex += 1;
      if (recordCheckIndex % COOPERATIVE_YIELD_INTERVAL === 0) await cooperativeYield();
      const opened = recordOpenMemoEntry(entry, recordOpenMemo);
      if (!opened) continue;
      const id = opened.recordId;
      const row = existingRecords.get(id);
    // The comparison record is only re-parsed here, in the rare (resumed
    // publication) branch where a row already exists -- on an ordinary,
    // non-resumed publication this whole block never runs, so `record` is
    // never reconstructed at all; `opened.recordId`/`recordDigest` (from
    // `memoizeRecordOpens`) already cover every other use in this loop.
      if (!row) continue;
      const wrapper = entry as Record<string, any>;
      const record = unwrapRecordTemplate(JSON.parse(String(wrapper["record_without_validity"])));
      const logicalPayload = digestRelationalValue(record["body"] ?? null);
      const expected = { record_id: id, workspace_id: workspaceId, category: record["category"] ?? "fact", kind: record["kind"] ?? "unknown", universal_kind: record["universal_kind"] ?? "unknown", schema_version: record["schema_version"] ?? 1, producer_id: "candidate", producer_version: "1", owner_artifact_id: wrapper["owner_artifact_id"], owner_artifact_version_id: wrapper["owner_artifact_version_id"], primary_source_span_artifact_version_id: recordPrimarySourceSpanValue(record, "artifact_version_id"), primary_source_span_start_byte: recordPrimarySourceSpanValue(record, "start_byte"), primary_source_span_end_byte: recordPrimarySourceSpanValue(record, "end_byte"), primary_source_span_start_line: recordPrimarySourceSpanValue(record, "start_line"), primary_source_span_end_line: recordPrimarySourceSpanValue(record, "end_line"), valid_from_generation: generation, valid_to_generation: null, record_digest: opened.recordDigest, body_digest: logicalPayload.digest, body_byte_length: logicalPayload.byte_length, analysis_digest: String(record["analysis_digest"] ?? opened.recordDigest), analysis_configuration_digest: String(record["analysis_configuration_digest"] ?? opened.recordDigest), artifact_dependency_digest: String(record["artifact_dependency_digest"] ?? opened.recordDigest) };
      if (!rowMatches(row, expected)) {
      // A row that already exists under this exact `record_id` but is a
      // CLOSED row (`valid_to_generation` set) opened in a strictly earlier
      // generation is not this publish replaying its own prior attempt (an
      // ordinary resumed-publication `conflict()` below) -- it is a fresh
      // open re-minting the id of a DIFFERENT, historical row. That can only
      // happen when the content-derived id salt (`previous_record_id` /
      // `absence_barrier`, `recordTemplates` in
      // `candidate-materialization.ts`) failed to diverge the new id from
      // closed history -- e.g. the identity's absence barrier was never
      // produced (see `closedIdentitiesForOwners`,
      // `packages/storage/src/repositories.ts`, and its wiring in
      // `workspace-indexing-session.ts`). Immutability still stands (the
      // closed row is never overwritten below), but this gets its own error
      // code so it is diagnosable and never masquerades as an ordinary
      // replay divergence, which `storage:publication_conflict` normally
      // means and which callers may treat as retry-safe.
      const closedValidTo = row["valid_to_generation"];
      const isClosedHistoricalRow = closedValidTo !== null && closedValidTo !== undefined && Number(row["valid_from_generation"]) < generation;
      if (isClosedHistoricalRow) {
        throw new StorageError(
          "storage:record_id_reuse",
          `Record occurrence ${id} re-mints the record_id of a closed historical row (generations ${row["valid_from_generation"]}-${closedValidTo}); this is an id-collision-with-closed-history from a failed identity salt, not a replay conflict.`,
          { table: "record_occurrences", row_id: id, closed_valid_from_generation: Number(row["valid_from_generation"]), closed_valid_to_generation: Number(closedValidTo), publishing_generation: generation },
        );
      }
        conflict("record occurrence", id, "record_occurrences", row, expected);
      }
    }
  }
  const identityCount = await database.get<{ count: number }>("SELECT COUNT(*) AS count FROM identity_assignments WHERE workspace_id = ? AND valid_from_generation = ?", [workspaceId, generation]);
  if (identityCount?.count !== 0) {
    // Decode and query bounded chunks. The former flatMap retained every id
    // (and packed identities would then be decoded a second time), adding a
    // project-sized array at publication. A real first generation takes the
    // count=0 fast path; retries/conflict tests retain exact validation.
    for (let offset = 0; offset < identityAssignments.length; offset += 4_096) {
      const chunk: { readonly value: Record<string, any>; readonly id: string }[] = [];
      for (const entry of identityAssignments.slice(offset, offset + 4_096)) {
        const unpacked = candidateTemplateValue(entry);
        if (!unpacked || typeof unpacked !== "object" || typeof (unpacked as Record<string, any>)["identity_assignment_id"] !== "string") continue;
        const value = unpacked as Record<string, any>;
        chunk.push({ value, id: String(value["identity_assignment_id"]) });
      }
      const existingIdentityAssignments = await fetchExistingRowsById(database, "identity_assignments", workspaceId, "identity_assignment_id", chunk.map((entry) => entry.id), { column: "valid_from_generation", value: generation });
      for (const { value, id } of chunk) {
        const row = existingIdentityAssignments.get(id);
        if (!row) continue;
        const expected = { identity_assignment_id: id, workspace_id: workspaceId, identity_type: value["identity_type"] ?? "entity", identity_id: value["identity_id"] ?? "", assignment_kind: value["assignment_kind"] ?? "created", identity_key: value["identity_key"] ?? "", identity_key_digest: value["identity_key_digest"] ?? canonicalSha256(value["identity_key"] ?? ""), record_id: value["record_id"] ?? "", previous_record_id: value["previous_record_id"] ?? null, owner_artifact_id: null, owner_artifact_version_id: null, valid_from_generation: generation, valid_to_generation: null };
        if (!rowMatches(row, expected)) conflict("identity assignment", id, "identity_assignments", row, expected);
      }
    }
  }
  const projectionIds = projectionOpens.flatMap((entry) => (entry && typeof entry === "object" && typeof (entry as Record<string, any>)["projection_record_id"] === "string" ? [String((entry as Record<string, any>)["projection_record_id"])] : []));
  const existingProjections = await fetchExistingRowsById(database, "projection_occurrences", workspaceId, "projection_record_id", projectionIds, { column: "valid_from_generation", value: generation });
  const existingProjectionDependencies = await fetchExistingProjectionDependencies(database, workspaceId, projectionIds, generation);
  for (const entry of projectionOpens) {
    if (!entry || typeof entry !== "object" || typeof (entry as Record<string, any>)["projection_record_id"] !== "string") continue;
    const value = entry as Record<string, any>;
    const id = String(value["projection_record_id"]);
    const row = existingProjections.get(id);
    // On a fresh generation both this row and its dependency rows below are
    // absent, so skip building `expected`/payloads for either until a
    // pre-existing row is actually found -- the sub-loop still has to run for
    // every source (its own dependency rows are independent of this one), so
    // this can't just `continue` the whole iteration the way the simpler
    // loops elsewhere in this function do.
    if (row) {
      const digest = canonicalSha256(projectionContentDigestInput(value));
      const expectedProjection = { projection_record_id: id, workspace_id: workspaceId, projection_kind: value["projection_kind"] ?? "unknown", projection_key: value["projection_key"] ?? id, owner_artifact_id: value["owner_artifact_id"] ?? "", owner_artifact_version_id: value["owner_artifact_version_id"] ?? "", source_artifact_version_ids: JSON.stringify(Array.isArray(value["source_artifact_version_ids"]) ? value["source_artifact_version_ids"] : []), source_record_ids: JSON.stringify(Array.isArray(value["source_record_ids"]) ? value["source_record_ids"] : []), source_projection_record_ids: JSON.stringify(Array.isArray(value["source_projection_record_ids"]) ? value["source_projection_record_ids"] : []), generator: value["generator"] ?? "", generator_version: value["generator_version"] ?? "", generator_configuration_digest: value["generator_configuration_digest"] ?? "", valid_from_generation: generation, valid_to_generation: null, content_digest: digest };
      if (!rowMatches(row, expectedProjection)) conflict("projection occurrence", id, "projection_occurrences", row, expectedProjection);
    }
    for (const [sourceType, sourceValues] of [["artifact_version", value["source_artifact_version_ids"]], ["record", value["source_record_ids"]], ["projection", value["source_projection_record_ids"]]] as const) {
      if (!Array.isArray(sourceValues)) continue;
      for (const sourceId of sourceValues) {
        const dependency = existingProjectionDependencies.get(JSON.stringify([id, sourceType, String(sourceId)]));
        if (!dependency) continue;
        const expectedDependency = { workspace_id: workspaceId, projection_record_id: id, valid_from_generation: generation, source_type: sourceType, source_id: String(sourceId) };
        if (!rowMatches(dependency, expectedDependency)) conflict("projection dependency", `${id}/${String(sourceId)}`, "projection_occurrence_dependencies", dependency, expectedDependency);
      }
    }
  }
  const artifactDependencyIds = artifactDependencies.flatMap((entry) => (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>)["dependency_entry_id"] === "string" ? [String((entry as Record<string, unknown>)["dependency_entry_id"])] : []));
  const existingArtifactDependencies = await fetchExistingRowsById(database, "artifact_dependencies", workspaceId, "dependency_entry_id", artifactDependencyIds, { column: "valid_from_generation", value: generation });
  for (const entry of artifactDependencies) {
    if (!entry || typeof entry !== "object" || typeof (entry as Record<string, unknown>)["dependency_entry_id"] !== "string") continue;
    const value = entry as Record<string, unknown>;
    const id = String(value["dependency_entry_id"]);
    const row = existingArtifactDependencies.get(id);
    // Same fresh-generation shortcut as the identity assignments loop above.
    if (!row) continue;
    const expected = { dependency_entry_id: id, workspace_id: workspaceId, record_id: value["record_id"] ?? "", owner_artifact_id: value["owner_artifact_id"] ?? "", owner_artifact_version_id: value["owner_artifact_version_id"] ?? "", dependency_artifact_id: value["dependency_artifact_id"] ?? "", dependency_artifact_version_id: value["dependency_artifact_version_id"] ?? "", dependency_role: value["dependency_role"] ?? "reference", producer_id: value["producer_id"] ?? "candidate", producer_version: value["producer_version"] ?? "1", valid_from_generation: generation, valid_to_generation: null, content_digest: digestLogicalValue(value, "urdira:artifact-dependency:v2") };
    if (!rowMatches(row, expected)) conflict("artifact dependency", id, "artifact_dependencies", row, expected);
  }
  const lookupDependencyIds = lookupDependencies.flatMap((entry) => (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>)["lookup_dependency_id"] === "string" ? [String((entry as Record<string, unknown>)["lookup_dependency_id"])] : []));
  const existingLookupDependencies = await fetchExistingRowsById(database, "candidate_lookup_dependencies", workspaceId, "lookup_dependency_id", lookupDependencyIds, { column: "candidate_generation_id", value: String(input.candidate.candidate_generation_id) });
  for (const entry of lookupDependencies) {
    if (!entry || typeof entry !== "object" || typeof (entry as Record<string, unknown>)["lookup_dependency_id"] !== "string") continue;
    const value = entry as Record<string, unknown>;
    const id = String(value["lookup_dependency_id"]);
    const row = existingLookupDependencies.get(id);
    // Same fresh-generation shortcut as the identity assignments loop above.
    if (!row) continue;
    const expected = { lookup_dependency_id: id, workspace_id: workspaceId, candidate_generation_id: input.candidate.candidate_generation_id, consumer_type: value["consumer_type"] ?? "unknown", consumer_id: value["consumer_id"] ?? "", owner_artifact_id: value["owner_artifact_id"] ?? null, owner_artifact_version_id: value["owner_artifact_version_id"] ?? null, operation: value["operation"] ?? "lookup", normalized_selector_or_address: value["normalized_selector_or_address"] ?? "", selector_digest: value["selector_digest"] ?? canonicalSha256(value["normalized_selector_or_address"] ?? ""), previous_result_set_digest: value["previous_result_set_digest"] ?? "", invalidation_scope: value["invalidation_scope"] ?? "candidate", valid_from_generation: generation, valid_to_generation: null, dependency_digest: typeof value["dependency_digest"] === "string" ? value["dependency_digest"] : digestLogicalValue(value, "urdira:lookup-dependency:v2") };
    if (!rowMatches(row, expected)) conflict("lookup dependency", id, "candidate_lookup_dependencies", row, expected);
  }
  const lookupRevalidationKeys = lookupRevalidations.map((entry) => `lookup_revalidation:${input.candidate.candidate_generation_id}:${entry && typeof entry === "object" ? String((entry as Record<string, unknown>)["lookup_dependency_id"] ?? canonicalSha256(entry)) : canonicalSha256(entry)}`);
  const capabilityStateKeys = capabilityStates.map((value) => `capability_state:${input.candidate.candidate_generation_id}:${canonicalSha256(value)}`);
  const existingControlState = await fetchExistingRowsById(database, "control_plane_state", workspaceId, "state_key", [...lookupRevalidationKeys, ...capabilityStateKeys]);
  for (const entry of lookupRevalidations) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const id = String(value["lookup_dependency_id"] ?? canonicalSha256(value));
    const key = `lookup_revalidation:${input.candidate.candidate_generation_id}:${id}`;
    const row = existingControlState.get(key);
    const expected = { state_key: key, workspace_id: workspaceId, state_kind: "lookup_revalidation", state_json: JSON.stringify({ ...value, candidate_generation_id: input.candidate.candidate_generation_id, valid_from_generation: generation }), reference_workspace_id: workspaceId, reference_snapshot_id: null, reference_source_state_digest: null };
    if (row && !rowMatches(row, expected)) conflict("lookup revalidation", id, "control_plane_state", row, expected);
  }
  for (const value of capabilityStates) {
    const digest = canonicalSha256(value);
    const key = `capability_state:${input.candidate.candidate_generation_id}:${digest}`;
    const row = existingControlState.get(key);
    const expected = { state_key: key, workspace_id: workspaceId, state_kind: "capability_state", state_json: JSON.stringify(value), reference_workspace_id: workspaceId, reference_snapshot_id: null, reference_source_state_digest: null };
    if (row && !rowMatches(row, expected)) conflict("capability state", key, "control_plane_state", row, expected);
  }
  const candidateId = input.candidate.candidate_generation_id;
  const snapshotId = `snapshot:${candidateId}`;
  const generationManifestId = `generation-manifest:${candidateId}`;
  const snapshotParent = input.frozen_base.snapshot_id ?? null;
  const publicationPayload = encodeCanonical({ candidate: input.candidate, frozen_base: input.frozen_base });
  const expectedManifest = { ...manifest, base_snapshot_id: input.frozen_base.snapshot_id ?? null };
  const manifestRows = await database.all<Record<string, unknown>>("SELECT * FROM generation_manifests WHERE (workspace_id = ? AND (generation_manifest_id = ? OR generation = ?)) OR manifest_digest = ?", [workspaceId, generationManifestId, generation, manifest.manifest_digest]);
  for (const manifestRow of manifestRows) if (!rowMatches(manifestRow, expectedManifest)) conflict("generation manifest", generationManifestId, "generation_manifests", manifestRow, expectedManifest);
  const expectedSnapshot = { ...completedSnapshot, parent_snapshot_id: snapshotParent };
  const snapshotRows = await database.all<Record<string, unknown>>("SELECT * FROM snapshots WHERE (workspace_id = ? AND (snapshot_id = ? OR generation = ?)) OR snapshot_digest = ?", [workspaceId, snapshotId, generation, completedSnapshot.snapshot_digest]);
  for (const snapshotRow of snapshotRows) if (!rowMatches(snapshotRow, expectedSnapshot)) conflict("snapshot", snapshotId, "snapshots", snapshotRow, expectedSnapshot);
  const expectedJournal = {
    candidate_generation_id: candidateId,
    workspace_id: workspaceId,
    status: "published",
    snapshot_id: snapshotId,
    generation_manifest_id: generationManifestId,
    generation,
    published_at: publishedAt,
    publication_digest: canonicalSha256(publicationPayload),
  };
  const journalRows = await database.all<Record<string, unknown>>("SELECT * FROM candidate_publication_journal WHERE workspace_id = ? AND (candidate_generation_id = ? OR snapshot_id = ? OR generation = ? OR publication_digest = ?)", [workspaceId, candidateId, snapshotId, generation, canonicalSha256(publicationPayload)]);
  for (const journalRow of journalRows) if (!rowMatches(journalRow, expectedJournal)) conflict("candidate publication journal", candidateId, "candidate_publication_journal", journalRow, expectedJournal);
}


function* artifactDependencyCommandStream(values: readonly unknown[], workspaceId: string, generation: number): Generator<TransactionCommand> {
  for (const entry of values) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, any>;
    const id = value["dependency_entry_id"];
    if (typeof id !== "string") continue;
    const contentDigest = digestLogicalValue(value, "urdira:artifact-dependency:v2");
    yield* checkedPublicationCommand({ kind: "run", sql: "INSERT INTO artifact_dependencies (dependency_entry_id, workspace_id, record_id, owner_artifact_id, owner_artifact_version_id, dependency_artifact_id, dependency_artifact_version_id, dependency_role, producer_id, producer_version, valid_from_generation, valid_to_generation, content_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(workspace_id, dependency_entry_id, valid_from_generation) DO UPDATE SET content_digest = excluded.content_digest WHERE artifact_dependencies.workspace_id = excluded.workspace_id AND artifact_dependencies.record_id = excluded.record_id AND artifact_dependencies.owner_artifact_id = excluded.owner_artifact_id AND artifact_dependencies.owner_artifact_version_id = excluded.owner_artifact_version_id AND artifact_dependencies.dependency_artifact_id = excluded.dependency_artifact_id AND artifact_dependencies.dependency_artifact_version_id = excluded.dependency_artifact_version_id AND artifact_dependencies.dependency_role = excluded.dependency_role AND artifact_dependencies.producer_id = excluded.producer_id AND artifact_dependencies.producer_version = excluded.producer_version AND artifact_dependencies.valid_to_generation IS excluded.valid_to_generation", params: [id, workspaceId, String(value["record_id"] ?? ""), String(value["owner_artifact_id"] ?? ""), String(value["owner_artifact_version_id"] ?? ""), String(value["dependency_artifact_id"] ?? ""), String(value["dependency_artifact_version_id"] ?? ""), String(value["dependency_role"] ?? "reference"), String(value["producer_id"] ?? "candidate"), String(value["producer_version"] ?? "1"), generation, contentDigest] });
  }
}

function artifactDependencyCommands(values: readonly unknown[], workspaceId: string, generation: number): TransactionCommand[] {
  return [...artifactDependencyCommandStream(values, workspaceId, generation)];
}

function lookupDependencyCommands(values: readonly unknown[], revalidations: readonly unknown[], workspaceId: string, candidateId: string, generation: number, publishedAt: string): TransactionCommand[] {
  const commands: TransactionCommand[] = [];
  for (const entry of values) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, any>;
    const id = value["lookup_dependency_id"];
    if (typeof id !== "string") continue;
    commands.push(...checkedPublicationCommand({ kind: "run", sql: "INSERT INTO candidate_lookup_dependencies (lookup_dependency_id, workspace_id, candidate_generation_id, consumer_type, consumer_id, owner_artifact_id, owner_artifact_version_id, operation, normalized_selector_or_address, selector_digest, previous_result_set_digest, invalidation_scope, valid_from_generation, valid_to_generation, dependency_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(lookup_dependency_id) DO UPDATE SET dependency_digest = excluded.dependency_digest WHERE candidate_lookup_dependencies.workspace_id = excluded.workspace_id AND candidate_lookup_dependencies.candidate_generation_id = excluded.candidate_generation_id AND candidate_lookup_dependencies.consumer_type = excluded.consumer_type AND candidate_lookup_dependencies.consumer_id = excluded.consumer_id AND candidate_lookup_dependencies.owner_artifact_id IS excluded.owner_artifact_id AND candidate_lookup_dependencies.owner_artifact_version_id IS excluded.owner_artifact_version_id AND candidate_lookup_dependencies.operation = excluded.operation AND candidate_lookup_dependencies.normalized_selector_or_address = excluded.normalized_selector_or_address AND candidate_lookup_dependencies.selector_digest = excluded.selector_digest AND candidate_lookup_dependencies.previous_result_set_digest = excluded.previous_result_set_digest AND candidate_lookup_dependencies.invalidation_scope = excluded.invalidation_scope AND candidate_lookup_dependencies.valid_from_generation = excluded.valid_from_generation AND candidate_lookup_dependencies.valid_to_generation IS excluded.valid_to_generation", params: [id, workspaceId, candidateId, String(value["consumer_type"] ?? "unknown"), String(value["consumer_id"] ?? ""), sqliteValue(value["owner_artifact_id"] ?? null), sqliteValue(value["owner_artifact_version_id"] ?? null), String(value["operation"] ?? "lookup"), String(value["normalized_selector_or_address"] ?? ""), String(value["selector_digest"] ?? canonicalSha256(value["normalized_selector_or_address"] ?? "")), String(value["previous_result_set_digest"] ?? ""), String(value["invalidation_scope"] ?? "candidate"), generation, String(value["dependency_digest"] ?? digestLogicalValue(value, "urdira:lookup-dependency:v2"))] }));
  }
  for (const entry of revalidations) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, any>;
    const id = String(value["lookup_dependency_id"] ?? canonicalSha256(value));
    commands.push(...checkedPublicationCommand({ kind: "run", sql: "INSERT INTO control_plane_state (state_key, workspace_id, state_kind, state_json, reference_workspace_id, reference_snapshot_id, reference_source_state_digest, updated_at) VALUES (?, ?, 'lookup_revalidation', ?, ?, NULL, NULL, ?) ON CONFLICT(state_key) DO NOTHING", params: [`lookup_revalidation:${candidateId}:${id}`, workspaceId, JSON.stringify({ ...value, candidate_generation_id: candidateId, valid_from_generation: generation }), workspaceId, publishedAt] }));
  }
  return commands;
}

function capabilityStateCommands(values: readonly unknown[], workspaceId: string, candidateId: string, publishedAt: string): TransactionCommand[] {
  return values.flatMap((value) => {
    const digest = canonicalSha256(value);
    return checkedPublicationCommand({ kind: "run", sql: "INSERT INTO control_plane_state (state_key, workspace_id, state_kind, state_json, reference_workspace_id, reference_snapshot_id, reference_source_state_digest, updated_at) VALUES (?, ?, 'capability_state', ?, ?, NULL, NULL, ?) ON CONFLICT(state_key) DO NOTHING", params: [`capability_state:${candidateId}:${digest}`, workspaceId, JSON.stringify(value), workspaceId, publishedAt] });
  });
}

function sourceTransitionCommands(transitions: readonly unknown[], workspaceId: string, generation: number): TransactionCommand[] {
  const commands: TransactionCommand[] = [];
  for (const entry of transitions) {
    if (!entry || typeof entry !== "object") continue;
    const transition = entry as Record<string, unknown>;
    const change = transition["artifact_change"] as Record<string, unknown> | undefined;
    const version = transition["target_artifact_version_without_generation"] as Record<string, unknown> | undefined;
    if (change && typeof change["previous_artifact_version_id"] === "string") commands.push({ kind: "run", sql: "UPDATE artifact_versions SET valid_to_generation = ? WHERE workspace_id = ? AND artifact_version_id = ? AND valid_to_generation IS NULL", params: [generation, workspaceId, change["previous_artifact_version_id"]] });
    if (change && typeof change["previous_tombstone_id"] === "string") commands.push({ kind: "run", sql: "UPDATE artifact_tombstones SET valid_to_generation = ?, closing_artifact_change_id = ? WHERE workspace_id = ? AND artifact_tombstone_id = ? AND valid_to_generation IS NULL", params: [generation, sqliteValue(change["artifact_change_id"] ?? null), workspaceId, change["previous_tombstone_id"]] });
    if (version) {
      commands.push(...checkedPublicationCommand({ kind: "run", sql: "INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(artifact_version_id) DO UPDATE SET valid_to_generation = excluded.valid_to_generation WHERE artifact_versions.workspace_id = excluded.workspace_id AND artifact_versions.artifact_id = excluded.artifact_id AND artifact_versions.content_blob_id = excluded.content_blob_id AND artifact_versions.content_hash = excluded.content_hash AND artifact_versions.byte_length = excluded.byte_length AND artifact_versions.encoding = excluded.encoding AND artifact_versions.language_hint IS excluded.language_hint AND artifact_versions.analysis_metadata_digest = excluded.analysis_metadata_digest AND artifact_versions.created_from_observation_id = excluded.created_from_observation_id AND artifact_versions.valid_from_generation <= excluded.valid_from_generation AND artifact_versions.valid_to_generation IS excluded.valid_to_generation", params: [sqliteValue(version["artifact_version_id"]), workspaceId, sqliteValue(version["artifact_id"]), sqliteValue(version["content_blob_id"]), sqliteValue(version["content_hash"]), sqliteValue(version["byte_length"]), sqliteValue(version["encoding"]), sqliteValue(version["language_hint"] ?? null), sqliteValue(version["analysis_metadata_digest"]), sqliteValue(version["created_from_observation_id"]), generation] }));
    }
    const tombstone = transition["target_artifact_tombstone_without_generation"] as Record<string, unknown> | undefined;
    if (tombstone) {
      // See the matching comment in `assertPublicationImmutableRows`'s
      // tombstone branch, above: `cause_references`/`lineage_evidence_record_ids`
      // are already-encoded JSON strings (not arrays) here, and the payload
      // must not introduce explicit-null keys stage-1's own committed payload
      // never had -- both must exactly match what that check compares against,
      // since it is what makes a resumed/already-committed tombstone row
      // idempotent instead of a guaranteed conflict.
      commands.push(...checkedPublicationCommand({ kind: "run", sql: "INSERT INTO artifact_tombstones (artifact_tombstone_id, workspace_id, artifact_id, absence_kind, absence_reason_code, last_artifact_version_id, valid_from_generation, valid_to_generation, opening_artifact_change_id, closing_artifact_change_id, replacement_artifact_version_id, cause_references, lineage_evidence_record_ids) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?) ON CONFLICT(artifact_tombstone_id) DO UPDATE SET closing_artifact_change_id = excluded.closing_artifact_change_id, replacement_artifact_version_id = excluded.replacement_artifact_version_id WHERE artifact_tombstones.workspace_id = excluded.workspace_id AND artifact_tombstones.artifact_id = excluded.artifact_id AND artifact_tombstones.absence_kind = excluded.absence_kind AND artifact_tombstones.absence_reason_code = excluded.absence_reason_code AND artifact_tombstones.last_artifact_version_id = excluded.last_artifact_version_id AND artifact_tombstones.valid_from_generation <= excluded.valid_from_generation AND artifact_tombstones.valid_to_generation IS excluded.valid_to_generation AND artifact_tombstones.opening_artifact_change_id = excluded.opening_artifact_change_id AND artifact_tombstones.closing_artifact_change_id IS excluded.closing_artifact_change_id AND artifact_tombstones.replacement_artifact_version_id IS excluded.replacement_artifact_version_id AND artifact_tombstones.cause_references = excluded.cause_references AND artifact_tombstones.lineage_evidence_record_ids = excluded.lineage_evidence_record_ids", params: [sqliteValue(tombstone["artifact_tombstone_id"]), workspaceId, sqliteValue(tombstone["artifact_id"]), sqliteValue(tombstone["absence_kind"]), sqliteValue(tombstone["absence_reason_code"]), sqliteValue(tombstone["last_artifact_version_id"]), generation, sqliteValue(tombstone["opening_artifact_change_id"] ?? change?.["artifact_change_id"]), sqliteValue(tombstone["cause_references"] ?? "[]"), sqliteValue(tombstone["lineage_evidence_record_ids"] ?? "[]")] }));
    }
  }
  return commands;
}

function recordPrimarySourceSpanValue(record: Record<string, unknown>, field: "artifact_version_id" | "start_byte" | "end_byte" | "start_line" | "end_line"): SqliteValue {
  const span = record["primary_source_span"];
  if (span === null || typeof span !== "object" || Array.isArray(span)) return null;
  const value = (span as Record<string, unknown>)[field];
  return value === undefined ? null : sqliteValue(value);
}

/**
 * `parsedByEntry` (from `parseRecordOpens`, called earlier in
 * `buildCandidatePublicationPlan`) supplies each entry's already-parsed,
 * already-unwrapped record, so this no longer re-`JSON.parse`s
 * `record_without_validity` a second time. `body_digest` is computed as
 * `digestBytes(bodyPayload)` rather than a second, independent
 * `canonicalSha256(record["body"] ?? null)` call: byte-identical, not merely
 * equivalent, because this file's own `canonicalSha256` IS
 * `digestBytes(encodeCanonical(value))` (see this file's `canonicalSha256`,
 * above) and `bodyPayload` already IS `encodeCanonical(record["body"] ??
 * null)` -- reusing it just skips re-running that same encode over the same
 * bytes a second time.
 */
const STREAMING_PUBLICATION_RECORD_THRESHOLD = 2_048;
const INITIAL_CANONICAL_INDEX_DROP_SQL = `
DROP INDEX IF EXISTS record_occurrences_visible_idx;
DROP INDEX IF EXISTS record_occurrences_workspace_owner_idx;
DROP INDEX IF EXISTS identity_assignments_lookup_idx;
DROP INDEX IF EXISTS identity_assignments_key_idx;
DROP INDEX IF EXISTS identity_assignments_record_idx;`;
const INITIAL_CANONICAL_INDEX_BUILD_SQL = `
CREATE INDEX record_occurrences_visible_idx ON record_occurrences(workspace_id, valid_from_generation, valid_to_generation);
CREATE INDEX record_occurrences_workspace_owner_idx ON record_occurrences(workspace_id, owner_artifact_id, valid_from_generation, valid_to_generation);
CREATE INDEX identity_assignments_lookup_idx ON identity_assignments(workspace_id, identity_type, identity_id, valid_from_generation, valid_to_generation);
CREATE INDEX identity_assignments_key_idx ON identity_assignments(workspace_id, identity_key_digest, valid_from_generation, identity_type, identity_key, record_id);
CREATE INDEX identity_assignments_record_idx ON identity_assignments(workspace_id, record_id, valid_from_generation, valid_to_generation);`;

// Fixed-width occurrence rows are batched at the producer, before commands
// enter the transaction worker. This keeps the high-cardinality publication
// path bounded without retaining or inspecting a corpus-sized command list.
const STREAMING_OCCURRENCE_BATCH_MAX_ROWS = 512;

// Rows per `run_batch` command `coalesceAdjacentRuns` emits (below). Chosen
// against the same per-chunk data-volume target `SqliteWorkerAdapter.PARAMS_PER_CHUNK`
// already sizes chunks to (packages/storage/src/sqlite.ts: ~2000 commands x
// ~14 params/command ~= 28,000 params/chunk), not an arbitrary constant: at
// this file's highest-arity coalesced site (artifact_dependencies, ~12
// params/row), 2048 rows is ~24,576 flattened params -- comfortably under
// one chunk's existing budget without needing arity-aware sizing. Lower-arity
// sites (record_facets, 5 params/row; projection_occurrence_dependencies, 5
// params/row) never come close to the cap and just get fewer, larger batches.
const RUN_BATCH_MAX_ROWS = 2_048;

/**
 * Coalesces ADJACENT `run` commands that share byte-identical SQL text into
 * `run_batch` commands (packages/storage/src/sqlite.ts) of up to
 * `RUN_BATCH_MAX_ROWS` rows each. Pure transport optimization: same rows,
 * same order, same constraint failures -- only how many worker round trips
 * and per-command dispatch/`postMessage` envelopes it costs to run them.
 *
 * Deliberately adjacency-only, never a cross-gap dedup or reorder: a `run`
 * command only ever joins the group immediately preceding it, and every
 * other command (`transaction_checkpoint`, `assert_transaction_changes`,
 * `fault`, `exec`, `get`, `all`, `staged_fact_delta_batch`, or a `run` whose
 * SQL text differs from the pending group's) flushes the pending group
 * first and passes through untouched, in the exact order it arrived --
 * `assert_transaction_changes`'s change-count bracketing of a checkpoint
 * still sees the same total, and command order across distinct SQL
 * statements is exactly preserved. Two adjacent `run` commands sharing SQL
 * text always share parameter arity too (the SQL text's placeholder count
 * fixes it), so `params.length` mismatch inside one pending group would
 * indicate a producer bug, not legitimate variation -- checked defensively
 * rather than assumed silently. A group of exactly one row is emitted as a
 * plain `run`, not a size-1 `run_batch`.
 */
export function* coalesceAdjacentRuns(commands: Iterable<SqliteCommand>): Generator<SqliteCommand> {
  let pendingSql: string | undefined;
  let pendingParams: SqliteValue[] = [];
  let pendingArity = 0;
  let pendingRows = 0;

  function* flushPending(): Generator<SqliteCommand> {
    if (pendingRows === 0) return;
    yield pendingRows === 1
      ? { kind: "run", sql: pendingSql!, params: pendingParams }
      : { kind: "run_batch", sql: pendingSql!, rows: pendingRows, params_flat: pendingParams };
    pendingSql = undefined;
    pendingParams = [];
    pendingArity = 0;
    pendingRows = 0;
  }

  for (const command of commands) {
    if (command.kind === "run") {
      const params = command.params ?? [];
      if (pendingRows > 0 && pendingSql === command.sql && pendingRows < RUN_BATCH_MAX_ROWS) {
        if (params.length !== pendingArity) throw new StorageError("storage:publication_invalid", `Adjacent run commands sharing SQL text carry different parameter counts (expected ${pendingArity}, got ${params.length}): "${command.sql}".`);
        pendingParams.push(...params);
        pendingRows += 1;
        continue;
      }
      yield* flushPending();
      pendingSql = command.sql;
      pendingParams = [...params];
      pendingArity = params.length;
      pendingRows = 1;
      continue;
    }
    yield* flushPending();
    yield command;
  }
  yield* flushPending();
}
const RECORD_OCCURRENCE_INSERT_SQL = "INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, valid_to_generation, record_digest, body_digest, body_byte_length, body_payload, analysis_digest, analysis_configuration_digest, artifact_dependency_digest) VALUES ";
const RECORD_OCCURRENCE_INSERT_SUFFIX = " ON CONFLICT(record_id) DO NOTHING";
const RECORD_OCCURRENCE_PLACEHOLDER = `(${Array.from({ length: 16 }, () => "?").join(", ")}, NULL, ${Array.from({ length: 7 }, () => "?").join(", ")})`;
const PROJECTION_OCCURRENCE_INSERT_SQL = "INSERT INTO projection_occurrences (projection_record_id, workspace_id, projection_kind, projection_key, owner_artifact_id, owner_artifact_version_id, source_artifact_version_ids, source_record_ids, source_projection_record_ids, generator, generator_version, generator_configuration_digest, valid_from_generation, valid_to_generation, content_digest) VALUES ";
const PROJECTION_OCCURRENCE_INSERT_SUFFIX = " ON CONFLICT DO UPDATE SET content_digest = excluded.content_digest WHERE projection_occurrences.workspace_id = excluded.workspace_id AND projection_occurrences.projection_kind = excluded.projection_kind AND projection_occurrences.projection_key = excluded.projection_key AND projection_occurrences.owner_artifact_id = excluded.owner_artifact_id AND projection_occurrences.owner_artifact_version_id = excluded.owner_artifact_version_id AND projection_occurrences.source_artifact_version_ids = excluded.source_artifact_version_ids AND projection_occurrences.source_record_ids = excluded.source_record_ids AND projection_occurrences.source_projection_record_ids = excluded.source_projection_record_ids AND projection_occurrences.generator = excluded.generator AND projection_occurrences.generator_version = excluded.generator_version AND projection_occurrences.generator_configuration_digest = excluded.generator_configuration_digest AND projection_occurrences.valid_from_generation = excluded.valid_from_generation AND projection_occurrences.valid_to_generation IS excluded.valid_to_generation";
const PROJECTION_OCCURRENCE_PLACEHOLDER = `(${Array.from({ length: 13 }, () => "?").join(", ")}, NULL, ?)`;

type RecordOpenStreamEntry = {
  readonly wrapper: Record<string, unknown>;
  readonly opened: RecordOpenMemoEntry;
  readonly record?: Record<string, unknown>;
  readonly params: readonly SqliteValue[];
};

function recordOpenParams(wrapper: Record<string, unknown>, record: Record<string, unknown>, opened: RecordOpenMemoEntry, workspaceId: string, generation: number): SqliteValue[] {
  const body = record["body"] ?? null;
  const logicalPayload = digestRelationalValue(body);
  return [opened.recordId, workspaceId, sqliteValue(record["category"] ?? "fact"), sqliteValue(record["kind"] ?? "unknown"), sqliteValue(record["universal_kind"] ?? "unknown"), sqliteValue(record["schema_version"] ?? 1), "candidate", "1", sqliteValue(wrapper["owner_artifact_id"]), sqliteValue(wrapper["owner_artifact_version_id"]), recordPrimarySourceSpanValue(record, "artifact_version_id"), recordPrimarySourceSpanValue(record, "start_byte"), recordPrimarySourceSpanValue(record, "end_byte"), recordPrimarySourceSpanValue(record, "start_line"), recordPrimarySourceSpanValue(record, "end_line"), generation, opened.recordDigest, logicalPayload.digest, logicalPayload.byte_length, encodeCanonical(body), String(record["analysis_digest"] ?? opened.recordDigest), String(record["analysis_configuration_digest"] ?? opened.recordDigest), String(record["artifact_dependency_digest"] ?? opened.recordDigest)];
}

function* flushRecordOpenWindow(entries: readonly RecordOpenStreamEntry[], workspaceId: string, generation: number): Generator<TransactionCommand> {
  if (entries.length === 0) return;
  yield { kind: "transaction_checkpoint" };
  yield { kind: "run", sql: `${RECORD_OCCURRENCE_INSERT_SQL}${entries.map(() => RECORD_OCCURRENCE_PLACEHOLDER).join(", ")}${RECORD_OCCURRENCE_INSERT_SUFFIX}`, params: entries.flatMap((entry) => entry.params) };
  yield { kind: "assert_transaction_changes", expected: entries.length };
  for (const entry of entries) {
    const record = entry.record ?? (() => {
      const raw = entry.wrapper["record_without_validity"];
      if (typeof raw !== "string") throw new StorageError("storage:publication_invalid", "Record open template is not valid JSON.");
      try { return unwrapRecordTemplate(JSON.parse(raw)); } catch { throw new StorageError("storage:publication_invalid", "Record open template is not valid JSON."); }
    })();
    const facets = Array.isArray(record["facets"]) ? record["facets"] : [];
    for (let facetOrdinal = 0; facetOrdinal < facets.length; facetOrdinal += 1) {
      const facet = facets[facetOrdinal];
      if (typeof facet !== "string") continue;
      yield { kind: "run", sql: "INSERT INTO record_facets (workspace_id, record_id, valid_from_generation, facet_ordinal, facet) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", params: [workspaceId, entry.opened.recordId, generation, facetOrdinal, facet] };
    }
  }
}

function* recordOpenCommandStream(opens: readonly unknown[], workspaceId: string, generation: number, recordOpenMemo: ReadonlyMap<unknown, RecordOpenMemoEntry>, parsedByEntry?: ReadonlyMap<unknown, Record<string, unknown>>, batch = true): Generator<TransactionCommand> {
  const window: RecordOpenStreamEntry[] = [];
  for (const entry of opens) {
    if (!entry || typeof entry !== "object") continue;
    const wrapper = entry as Record<string, unknown>;
    const raw = wrapper["record_without_validity"];
    if (typeof raw !== "string") continue;
    const opened = recordOpenMemoEntry(entry, recordOpenMemo);
    if (!opened) continue;
    const record = parsedByEntry?.get(entry) ?? (() => {
      try { return unwrapRecordTemplate(JSON.parse(raw)); } catch { throw new StorageError("storage:publication_invalid", "Record open template is not valid JSON."); }
    })();
    if (!record) continue;
    const cachedRecord = parsedByEntry?.get(entry);
    const streamEntry = { wrapper, opened, ...(cachedRecord === undefined ? {} : { record: cachedRecord }), params: recordOpenParams(wrapper, record, opened, workspaceId, generation) } satisfies RecordOpenStreamEntry;
    if (!batch) {
      yield* checkedPublicationCommand({ kind: "run", sql: `${RECORD_OCCURRENCE_INSERT_SQL}${RECORD_OCCURRENCE_PLACEHOLDER}${RECORD_OCCURRENCE_INSERT_SUFFIX}`, params: streamEntry.params });
      const facets = Array.isArray(record["facets"]) ? record["facets"] : [];
      for (let facetOrdinal = 0; facetOrdinal < facets.length; facetOrdinal += 1) {
        const facet = facets[facetOrdinal];
        if (typeof facet !== "string") continue;
        yield { kind: "run", sql: "INSERT INTO record_facets (workspace_id, record_id, valid_from_generation, facet_ordinal, facet) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", params: [workspaceId, opened.recordId, generation, facetOrdinal, facet] };
      }
      continue;
    }
    window.push(streamEntry);
    if (window.length >= STREAMING_OCCURRENCE_BATCH_MAX_ROWS) {
      yield* flushRecordOpenWindow(window, workspaceId, generation);
      window.length = 0;
    }
  }
  if (batch) yield* flushRecordOpenWindow(window, workspaceId, generation);
}

function recordOpenCommands(opens: readonly unknown[], workspaceId: string, generation: number, recordOpenMemo: ReadonlyMap<unknown, RecordOpenMemoEntry>, parsedByEntry?: ReadonlyMap<unknown, Record<string, unknown>>): TransactionCommand[] {
  return [...recordOpenCommandStream(opens, workspaceId, generation, recordOpenMemo, parsedByEntry, false)];
}

function* recordClosureCommandStream(closures: readonly unknown[], workspaceId: string, generation: number): Generator<TransactionCommand> {
  for (const entry of closures) {
    if (!entry || typeof entry !== "object") continue;
    const recordId = (entry as Record<string, unknown>)["record_id"];
    if (typeof recordId === "string") yield { kind: "run", sql: "UPDATE record_occurrences SET valid_to_generation = ? WHERE workspace_id = ? AND record_id = ? AND valid_to_generation IS NULL", params: [generation, workspaceId, recordId] } satisfies TransactionCommand;
  }
}

function recordClosureCommands(closures: readonly unknown[], workspaceId: string, generation: number): TransactionCommand[] {
  return [...recordClosureCommandStream(closures, workspaceId, generation)];
}

const IDENTITY_ASSIGNMENT_INSERT_SQL = "INSERT INTO identity_assignments (identity_assignment_id, workspace_id, identity_type, identity_id, assignment_kind, identity_key, identity_key_digest, record_id, previous_record_id, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation) VALUES ";
const IDENTITY_ASSIGNMENT_PLACEHOLDER = `(${Array.from({ length: 9 }, () => "?").join(", ")}, NULL, NULL, ?, NULL)`;

function identityAssignmentParams(value: Record<string, any>, workspaceId: string, generation: number): SqliteValue[] {
  return [sqliteValue(value["identity_assignment_id"]), workspaceId, sqliteValue(value["identity_type"] ?? "entity"), sqliteValue(value["identity_id"] ?? ""), sqliteValue(value["assignment_kind"] ?? "created"), sqliteValue(value["identity_key"] ?? ""), sqliteValue(value["identity_key_digest"] ?? canonicalSha256(value["identity_key"] ?? "")), sqliteValue(value["record_id"] ?? ""), sqliteValue(value["previous_record_id"] ?? null), generation];
}

function* flushIdentityWindow(params: readonly (readonly SqliteValue[])[]): Generator<TransactionCommand> {
  if (params.length === 0) return;
  yield { kind: "transaction_checkpoint" };
  yield { kind: "run", sql: `${IDENTITY_ASSIGNMENT_INSERT_SQL}${params.map(() => IDENTITY_ASSIGNMENT_PLACEHOLDER).join(", ")} ON CONFLICT DO NOTHING`, params: params.flat() };
  yield { kind: "assert_transaction_changes", expected: params.length };
}

function* identityCommandStream(assignments: readonly unknown[], workspaceId: string, generation: number): Generator<TransactionCommand> {
  const window: SqliteValue[][] = [];
  for (const entry of assignments) {
    const unpacked = candidateTemplateValue(entry);
    if (!unpacked || typeof unpacked !== "object") continue;
    const value = unpacked as Record<string, any>;
    if (typeof value["identity_assignment_id"] !== "string") continue;
    window.push(identityAssignmentParams(value, workspaceId, generation));
    if (window.length >= STREAMING_OCCURRENCE_BATCH_MAX_ROWS) {
      yield* flushIdentityWindow(window);
      window.length = 0;
    }
  }
  yield* flushIdentityWindow(window);
}

function identityCommands(assignments: readonly unknown[], workspaceId: string, generation: number): TransactionCommand[] {
  return [...identityCommandStream(assignments, workspaceId, generation)];
}

/**
 * The exact field set `candidate-materialization.ts`'s `projectionDigest`
 * digests (decision 11: excludes `workspace_id` -- the canonical layer's
 * digests stay workspace-free). `projection_occurrences.content_digest` and
 * every conflict check against it must be computed the same way, so a
 * fresh `content_digest` here matches what `projectionDigest` recomputes
 * from an identical projection on the next candidate generation (the reuse
 * comparison, candidate-materialization.ts ~330).
 */
const PROJECTION_CONTENT_DIGEST_FIELDS = ["projection_record_id", "projection_kind", "projection_key", "owner_artifact_id", "owner_artifact_version_id", "source_artifact_version_ids", "source_record_ids", "source_projection_record_ids", "generator", "generator_version", "generator_configuration_digest", "payload"] as const;

function projectionContentDigestInput(value: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  // Omit a field entirely rather than setting it `undefined`: canonical
  // logical encoding treats an explicit `undefined` value as unsupported
  // feature (there is no null-vs-absent distinction to preserve here, unlike
  // JSON), so a sparse/malformed projection template must produce the same
  // "missing key" shape a real one's absent optional field would.
  for (const field of PROJECTION_CONTENT_DIGEST_FIELDS) if (value[field] !== undefined) input[field] = value[field];
  return input;
}

type ProjectionOpenStreamEntry = {
  readonly projection: Record<string, unknown>;
  readonly id: string;
  readonly artifacts: readonly unknown[];
  readonly records: readonly unknown[];
  readonly projections: readonly unknown[];
  readonly params: readonly SqliteValue[];
};

function projectionOpenParams(projection: Record<string, unknown>, id: string, artifacts: readonly unknown[], records: readonly unknown[], projections: readonly unknown[], contentDigest: string, workspaceId: string, generation: number): SqliteValue[] {
  return [id, workspaceId, sqliteValue(projection["projection_kind"] ?? "unknown"), sqliteValue(projection["projection_key"] ?? id), sqliteValue(projection["owner_artifact_id"] ?? ""), sqliteValue(projection["owner_artifact_version_id"] ?? ""), JSON.stringify(artifacts), JSON.stringify(records), JSON.stringify(projections), sqliteValue(projection["generator"] ?? ""), sqliteValue(projection["generator_version"] ?? ""), sqliteValue(projection["generator_configuration_digest"] ?? ""), generation, contentDigest];
}

function* flushProjectionOpenWindow(entries: readonly ProjectionOpenStreamEntry[], workspaceId: string, generation: number): Generator<TransactionCommand> {
  if (entries.length === 0) return;
  yield { kind: "transaction_checkpoint" };
  yield { kind: "run", sql: `${PROJECTION_OCCURRENCE_INSERT_SQL}${entries.map(() => PROJECTION_OCCURRENCE_PLACEHOLDER).join(", ")}${PROJECTION_OCCURRENCE_INSERT_SUFFIX}`, params: entries.flatMap((entry) => entry.params) };
  yield { kind: "assert_transaction_changes", expected: entries.length };
  const valueBatches = new RelationalValueBatchWriter("projection_value_nodes");
  for (const entry of entries) {
    for (const [sourceType, sourceValues] of [["artifact_version", entry.artifacts], ["record", entry.records], ["projection", entry.projections]] as const) for (const sourceId of sourceValues) yield* checkedPublicationCommand({ kind: "run", sql: "INSERT OR IGNORE INTO projection_occurrence_dependencies (workspace_id, projection_record_id, valid_from_generation, source_type, source_id) VALUES (?, ?, ?, ?, ?)", params: [workspaceId, entry.id, generation, sourceType, String(sourceId)] });
    yield* valueBatches.push(iterateRelationalValue(workspaceId, entry.id, generation, entry.projection["payload"] ?? null));
  }
  yield* valueBatches.finish();
}

function* projectionCommandStream(opens: readonly unknown[], workspaceId: string, generation: number, batch = true): Generator<TransactionCommand> {
  const window: ProjectionOpenStreamEntry[] = [];
  const unbatchedValueBatches = batch ? undefined : new RelationalValueBatchWriter("projection_value_nodes");
  for (const value of opens) {
    if (!value || typeof value !== "object") continue;
    const projection = value as Record<string, unknown>;
    const id = projection["projection_record_id"];
    if (typeof id !== "string") continue;
    const contentDigest = canonicalSha256(projectionContentDigestInput(projection));
    const artifacts = Array.isArray(projection["source_artifact_version_ids"]) ? projection["source_artifact_version_ids"] : [];
    const records = Array.isArray(projection["source_record_ids"]) ? projection["source_record_ids"] : [];
    const projections = Array.isArray(projection["source_projection_record_ids"]) ? projection["source_projection_record_ids"] : [];
    const streamEntry = { projection, id, artifacts, records, projections, params: projectionOpenParams(projection, id, artifacts, records, projections, contentDigest, workspaceId, generation) } satisfies ProjectionOpenStreamEntry;
    if (!batch) {
      yield* checkedPublicationCommand({ kind: "run", sql: `${PROJECTION_OCCURRENCE_INSERT_SQL}${PROJECTION_OCCURRENCE_PLACEHOLDER}${PROJECTION_OCCURRENCE_INSERT_SUFFIX}`, params: streamEntry.params });
      for (const [sourceType, sourceValues] of [["artifact_version", artifacts], ["record", records], ["projection", projections]] as const) for (const sourceId of sourceValues) yield* checkedPublicationCommand({ kind: "run", sql: "INSERT OR IGNORE INTO projection_occurrence_dependencies (workspace_id, projection_record_id, valid_from_generation, source_type, source_id) VALUES (?, ?, ?, ?, ?)", params: [workspaceId, id, generation, sourceType, String(sourceId)] });
      yield* unbatchedValueBatches!.push(iterateRelationalValue(workspaceId, id, generation, projection["payload"] ?? null));
      continue;
    }
    window.push(streamEntry);
    if (window.length >= STREAMING_OCCURRENCE_BATCH_MAX_ROWS) {
      yield* flushProjectionOpenWindow(window, workspaceId, generation);
      window.length = 0;
    }
  }
  if (batch) yield* flushProjectionOpenWindow(window, workspaceId, generation);
  else yield* unbatchedValueBatches!.finish();
}

function projectionCommands(opens: readonly unknown[], workspaceId: string, generation: number): TransactionCommand[] {
  return [...projectionCommandStream(opens, workspaceId, generation, false)];
}

function* projectionClosureCommandStream(closures: readonly Record<string, unknown>[], workspaceId: string, generation: number): Generator<TransactionCommand> {
  for (const entry of closures) {
    if (typeof entry["projection_record_id"] !== "string") continue;
    yield { kind: "run", sql: "UPDATE projection_occurrences SET valid_to_generation = ? WHERE workspace_id = ? AND projection_record_id = ? AND valid_to_generation IS NULL", params: [generation, workspaceId, entry["projection_record_id"]] } satisfies TransactionCommand;
  }
}

function projectionClosureCommands(closures: readonly Record<string, unknown>[], workspaceId: string, generation: number): TransactionCommand[] {
  return [...projectionClosureCommandStream(closures, workspaceId, generation)];
}
