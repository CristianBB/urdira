import { canonicalBytes, digestBytes } from "@urdira/canonical";
import type {
  ArtifactChange,
  CandidateArtifactTombstoneTemplate,
  CandidateArtifactVersionTemplate,
  CandidateSourceTransitionTemplate,
  SourceArtifact,
  WorkspaceFreshnessCheckpoint,
} from "@urdira/contracts";

export type SourceCandidateOutcome = "success" | "source_changed" | "unavailable" | "deadline_exceeded" | "resource_exhausted" | "cancelled" | "failed";

export interface SourceCandidateCoverageScope {
  readonly scope_type: "artifact" | "uri_prefix" | "source_root" | "virtual_collection";
  readonly normalized_scope_key: string;
}

export interface SourceCandidatePresentObservation {
  readonly observed_state: "present";
  readonly source_observation_id: string;
  readonly artifact: SourceArtifact;
  readonly content_blob_id: string;
  readonly content_hash: string;
  readonly byte_length: number;
  readonly encoding: string;
  readonly language_hint?: string;
  readonly analysis_metadata_digest: string;
}

export interface SourceCandidateAbsenceObservation {
  readonly observed_state: "deleted" | "excluded";
  readonly source_observation_id: string;
  readonly artifact_id: string;
  readonly normalized_uri: string;
  readonly authority: "hint" | "authoritative_delete" | "authoritative_absence";
}

export type SourceCandidateObservation = SourceCandidatePresentObservation | SourceCandidateAbsenceObservation;

export interface SourceCandidateObservationSet {
  readonly outcome: SourceCandidateOutcome;
  readonly stable: boolean;
  readonly workspace_id: string;
  readonly observation_batch_id: string;
  readonly source_provider_binding_id: string;
  readonly source_provider: string;
  readonly source_provider_version: string;
  readonly watermark: string;
  readonly completed_at: string;
  readonly observation_mode?: "event" | "scan" | "reconciliation" | "watch";
  readonly coverage_completeness: "complete" | "partial" | "failed";
  readonly deletion_authority: "authoritative" | "none";
  readonly coverage_scopes: readonly SourceCandidateCoverageScope[];
  readonly supports_authoritative_delete_events: boolean;
  readonly observations: readonly SourceCandidateObservation[];
}

/**
 * `base.present`/`base.absent` (below) restate the workspace's prior
 * (pre-this-scan) source-index state purely so this planner can diff a fresh
 * observation set against it -- see `SourceCandidatePlanner.plan`'s
 * `present`/`absent` maps and `addAbsence`. Every read of a `base.present`/
 * `base.absent` entry anywhere in this class touches only these fields (not
 * the rest of `SourceArtifact`/`CandidateArtifactVersionTemplate`/
 * `CandidateArtifactTombstoneTemplate`), so the type is scoped to exactly
 * that -- letting the caller (`runFullWorkspaceScan`,
 * `workspace-indexing-session.ts`) build `present`/`absent` from a
 * typed-column-only storage read (`WorkspaceSourceIndexRepository.currentOccurrencesSlim`/
 * `currentAbsencesSlim`, `packages/storage/src/source-index.ts`) instead of
 * canonically decoding a full artifact/version/tombstone payload per row.
 * The *fresh* transition templates this planner builds from the current
 * scan's own observations (`target_artifact_version_without_generation`/
 * `target_artifact_tombstone_without_generation`) are unrelated and stay
 * full `CandidateArtifactVersionTemplate`/`CandidateArtifactTombstoneTemplate`
 * values -- only the PRIOR-state read path is narrowed here.
 */
export interface SourceCandidateBaseArtifactIdentity {
  readonly artifact_id: string;
  readonly normalized_uri: string;
}

export interface SourceCandidateBaseOccurrence {
  readonly artifact: SourceCandidateBaseArtifactIdentity;
  readonly version: {
    readonly artifact_version_id: string;
    readonly content_hash: string;
    readonly analysis_metadata_digest: string;
  };
}

export interface SourceCandidateBaseAbsence {
  readonly artifact: SourceCandidateBaseArtifactIdentity;
  readonly tombstone: {
    readonly artifact_tombstone_id: string;
    readonly absence_kind: string;
  };
}

export interface SourceCandidateBase {
  readonly workspace_id: string;
  readonly state_revision: number;
  readonly provider_watermarks: Readonly<Record<string, string>>;
  readonly source_state_digest: string;
  readonly present: readonly SourceCandidateBaseOccurrence[];
  readonly absent: readonly SourceCandidateBaseAbsence[];
}

export interface CandidateSeedChange {
  readonly artifact_id: string;
  readonly change_kind: ArtifactChange["change_kind"];
  readonly source_observation_batch_id: string;
  readonly cause_references: ArtifactChange["cause_references"];
  readonly lifecycle_barrier: boolean;
}

export interface SourceCandidatePlan {
  readonly transitions: readonly CandidateSourceTransitionTemplate[];
  readonly seeds: readonly CandidateSeedChange[];
  readonly equivalent: boolean;
  readonly next_freshness_checkpoint: WorkspaceFreshnessCheckpoint;
}

function stableId(kind: string, value: unknown): string {
  return `${kind}:${digestBytes(canonicalBytes(value)).slice("sha256:".length)}`;
}

function scopeContainsUri(scope: SourceCandidateCoverageScope, uri: string): boolean {
  if (scope.scope_type === "virtual_collection") return false;
  if (scope.scope_type === "artifact") return uri === scope.normalized_scope_key;
  return scope.normalized_scope_key === "" || uri === scope.normalized_scope_key || uri.startsWith(`${scope.normalized_scope_key}/`);
}

function cause(sourceObservationId: string): ArtifactChange["cause_references"] {
  return [{ cause_type: "source_observation", cause_id: sourceObservationId }];
}

export class SourceCandidatePlanner {
  plan(observations: SourceCandidateObservationSet, base: SourceCandidateBase): SourceCandidatePlan {
    if (observations.workspace_id !== base.workspace_id) throw new TypeError("Source candidate workspace mismatch.");
    const transitions: CandidateSourceTransitionTemplate[] = [];
    const seeds: CandidateSeedChange[] = [];
    const complete = observations.coverage_completeness === "complete";
    const usable = observations.outcome === "success" && observations.stable;
    const present = new Map(base.present.map((entry) => [entry.artifact.normalized_uri, entry]));
    const absent = new Map(base.absent.map((entry) => [entry.artifact.normalized_uri, entry]));
    const observedPresentUris = new Set<string>();

    const add = (artifactChange: ArtifactChange, template: Omit<CandidateSourceTransitionTemplate, "artifact_change">): void => {
      transitions.push({ artifact_change: artifactChange, ...template });
      seeds.push({
        artifact_id: artifactChange.artifact_id,
        change_kind: artifactChange.change_kind,
        source_observation_batch_id: observations.observation_batch_id,
        cause_references: artifactChange.cause_references,
        lifecycle_barrier: artifactChange.change_kind === "deleted" || artifactChange.change_kind === "excluded",
      });
    };

    if (usable) {
      for (const observation of observations.observations) {
        if (observation.observed_state !== "present") continue;
        observedPresentUris.add(observation.artifact.normalized_uri);
        const previous = present.get(observation.artifact.normalized_uri);
        const previousAbsence = absent.get(observation.artifact.normalized_uri);
        const priorArtifact = previous?.artifact ?? previousAbsence?.artifact;
        if (priorArtifact !== undefined && priorArtifact.artifact_id !== observation.artifact.artifact_id) {
          throw new TypeError("Source provider changed artifact identity for an existing source address.");
        }
        if (previous?.version.content_hash === observation.content_hash
          && previous.version.analysis_metadata_digest === observation.analysis_metadata_digest) continue;
        const changeKind: ArtifactChange["change_kind"] = previousAbsence
          ? previousAbsence.tombstone.absence_kind === "excluded" ? "reincluded" : "recreated"
          : previous ? "updated" : "created";
        const version: CandidateArtifactVersionTemplate = {
          artifact_version_id: stableId("artifact-version", { artifact_id: observation.artifact.artifact_id, observation_id: observation.source_observation_id, content_hash: observation.content_hash }),
          workspace_id: observations.workspace_id,
          artifact_id: observation.artifact.artifact_id,
          content_blob_id: observation.content_blob_id,
          content_hash: observation.content_hash,
          byte_length: observation.byte_length,
          encoding: observation.encoding,
          ...(observation.language_hint === undefined ? {} : { language_hint: observation.language_hint }),
          analysis_metadata_digest: observation.analysis_metadata_digest,
          created_from_observation_id: observation.source_observation_id,
        };
        const references = cause(observation.source_observation_id);
        const artifactChange: ArtifactChange = {
          artifact_change_id: stableId("artifact-change", { kind: changeKind, batch_id: observations.observation_batch_id, artifact_id: observation.artifact.artifact_id }),
          workspace_id: observations.workspace_id,
          artifact_id: observation.artifact.artifact_id,
          change_kind: changeKind,
          ...(previous === undefined ? {} : { previous_artifact_version_id: previous.version.artifact_version_id }),
          new_artifact_version_id: version.artifact_version_id,
          ...(previousAbsence === undefined ? {} : { previous_tombstone_id: previousAbsence.tombstone.artifact_tombstone_id }),
          cause_references: references,
          lineage_evidence_record_ids: [],
        };
        add(artifactChange, { target_artifact_version_without_generation: version });
      }

      const explicitAbsences = observations.observations.filter((entry): entry is SourceCandidateAbsenceObservation => entry.observed_state !== "present");
      for (const observation of explicitAbsences) {
        const watchAuthorized = observations.observation_mode === "watch" && observations.supports_authoritative_delete_events && observation.authority === "authoritative_delete";
        const batchAuthorized = observations.observation_mode !== "watch" && complete && observations.deletion_authority === "authoritative" && observation.authority === "authoritative_absence";
        if (!watchAuthorized && !batchAuthorized) continue;
        const occurrence = present.get(observation.normalized_uri);
        if (occurrence === undefined) continue;
        this.addAbsence(observations, occurrence, observation.observed_state, { cause_type: "source_observation", cause_id: observation.source_observation_id }, add);
      }

      if (complete && observations.deletion_authority === "authoritative" && observations.observation_mode !== "watch") {
        for (const occurrence of base.present) {
          const uri = occurrence.artifact.normalized_uri;
          if (observedPresentUris.has(uri) || explicitAbsences.some((entry) => entry.normalized_uri === uri)
            || !observations.coverage_scopes.some((scope) => scopeContainsUri(scope, uri))) continue;
          this.addAbsence(observations, occurrence, "deleted", { cause_type: "artifact_version", cause_id: occurrence.version.artifact_version_id }, add);
        }
      }
    }

    const equivalent = usable && complete && transitions.length === 0;
    const verificationStatus = equivalent ? "equivalent" : usable && transitions.length > 0 ? "changes_pending" : "degraded";
    const providerWatermarks = { ...base.provider_watermarks, ...(usable ? { [observations.source_provider_binding_id]: observations.watermark } : {}) };
    const nextSourceStateDigest = transitions.length === 0 ? base.source_state_digest : digestBytes(canonicalBytes({ base: base.source_state_digest, transitions }));
    const checkpointPayload = {
      workspace_id: observations.workspace_id,
      source_state_digest: nextSourceStateDigest,
      provider_watermarks: JSON.stringify(providerWatermarks),
      verification_status: verificationStatus,
      unavailable_artifact_ids: "[]",
      verified_at: observations.completed_at,
    };
    const nextFreshnessCheckpoint = {
      freshness_checkpoint_id: stableId("freshness-checkpoint", { ...checkpointPayload, batch_id: observations.observation_batch_id }),
      ...checkpointPayload,
      checkpoint_digest: digestBytes(canonicalBytes(checkpointPayload)),
    } as unknown as WorkspaceFreshnessCheckpoint;
    return { transitions, seeds, equivalent, next_freshness_checkpoint: nextFreshnessCheckpoint };
  }

  private addAbsence(
    observations: SourceCandidateObservationSet,
    occurrence: SourceCandidateBaseOccurrence,
    absenceKind: "deleted" | "excluded",
    causeReference: { readonly cause_type: "source_observation" | "artifact_version"; readonly cause_id: string },
    add: (artifactChange: ArtifactChange, template: Omit<CandidateSourceTransitionTemplate, "artifact_change">) => void,
  ): void {
    const references: ArtifactChange["cause_references"] = [causeReference];
    const changeId = stableId("artifact-change", { kind: absenceKind, batch_id: observations.observation_batch_id, artifact_id: occurrence.artifact.artifact_id });
    const tombstone: CandidateArtifactTombstoneTemplate = {
      artifact_tombstone_id: stableId("artifact-tombstone", { artifact_id: occurrence.artifact.artifact_id, batch_id: observations.observation_batch_id, absence_kind: absenceKind }),
      workspace_id: observations.workspace_id,
      artifact_id: occurrence.artifact.artifact_id,
      absence_kind: absenceKind,
      absence_reason_code: absenceKind === "excluded" ? "core:source_excluded" : "core:source_deleted",
      last_artifact_version_id: occurrence.version.artifact_version_id,
      opening_artifact_change_id: changeId,
      cause_references: JSON.stringify(references),
      lineage_evidence_record_ids: "[]",
    };
    add({
      artifact_change_id: changeId,
      workspace_id: observations.workspace_id,
      artifact_id: occurrence.artifact.artifact_id,
      change_kind: absenceKind,
      previous_artifact_version_id: occurrence.version.artifact_version_id,
      new_tombstone_id: tombstone.artifact_tombstone_id,
      cause_references: references,
      lineage_evidence_record_ids: [],
    }, { target_artifact_tombstone_without_generation: tombstone });
  }
}
