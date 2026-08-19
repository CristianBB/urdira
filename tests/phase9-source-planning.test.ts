import { describe, expect, it } from "vitest";
import { SourceCandidatePlanner, type SourceCandidateBase, type SourceCandidateObservationSet, type SourceCandidatePresentObservation } from "../packages/engine/src/index.js";

const workspaceId = "workspace:phase9-source";
const bindingId = "binding:phase9-source";

function emptySourceBase(): SourceCandidateBase {
  return {
    workspace_id: workspaceId,
    state_revision: 0,
    provider_watermarks: {},
    source_state_digest: "sha256:base-empty",
    present: [],
    absent: [],
  };
}

// `SourceCandidateBase.present`/`absent` entries are intentionally narrow
// (`SourceCandidateBaseOccurrence`/`SourceCandidateBaseAbsence`,
// `packages/engine/src/source-candidate-planning.ts`): they carry only the
// fields `SourceCandidatePlanner` actually reads off a prior occurrence/
// absence, not a full `SourceArtifact`/`ArtifactVersion`/`ArtifactTombstone`
// -- see that type's doc comment for why (it lets a caller build these from
// a typed-column-only storage read instead of decoding a full payload per
// row).
function presentSourceBase(contentHash = "sha256:old", metadataDigest = "sha256:metadata-old"): SourceCandidateBase {
  return {
    ...emptySourceBase(),
    state_revision: 1,
    present: [{
      artifact: { artifact_id: "artifact:one", normalized_uri: "src/one.ts" },
      version: {
        artifact_version_id: "version:old",
        content_hash: contentHash,
        analysis_metadata_digest: metadataDigest,
      },
    }],
    source_state_digest: "sha256:base-present",
  };
}

function absentSourceBase(kind: "deleted" | "excluded"): SourceCandidateBase {
  const present = presentSourceBase();
  return {
    ...present,
    present: [],
    absent: [{
      artifact: present.present[0]!.artifact,
      tombstone: {
        artifact_tombstone_id: `tombstone:${kind}`,
        absence_kind: kind,
      },
    }],
    source_state_digest: `sha256:base-${kind}`,
  };
}

function presentObservation(options: Partial<SourceCandidateObservationSet> = {}): SourceCandidateObservationSet {
  return {
    outcome: "success",
    stable: true,
    workspace_id: workspaceId,
    observation_batch_id: "batch:one",
    source_provider_binding_id: bindingId,
    source_provider: "core:directory_source_provider",
    source_provider_version: "1.0.0",
    watermark: "watermark:one",
    completed_at: "2026-08-10T00:00:00.000Z",
    coverage_completeness: "complete",
    deletion_authority: "authoritative",
    coverage_scopes: [{ scope_type: "source_root", normalized_scope_key: "" }],
    supports_authoritative_delete_events: false,
    observations: [{
      observed_state: "present",
      source_observation_id: "observation:one",
      artifact: { artifact_id: "artifact:one", workspace_id: workspaceId, normalized_uri: "src/one.ts", normalized_path: "src/one.ts", display_path: "src/one.ts", artifact_kind: "physical_file" },
      content_blob_id: "content:new",
      content_hash: "sha256:new",
      byte_length: 3,
      encoding: "utf-8",
      language_hint: "text",
      analysis_metadata_digest: "sha256:metadata-new",
    }],
    ...options,
  };
}

function presentObservationEntry(): SourceCandidatePresentObservation {
  return presentObservation().observations[0] as SourceCandidatePresentObservation;
}

describe("Phase 9 generation-neutral source candidate planning", () => {
  const planner = () => new SourceCandidatePlanner();

  it.each([
    ["created", emptySourceBase(), presentObservation(), "created"],
    ["updated", presentSourceBase(), presentObservation(), "updated"],
    ["deleted", presentSourceBase(), presentObservation({ observations: [] }), "deleted"],
    ["excluded", presentSourceBase(), presentObservation({ observations: [{ observed_state: "excluded", source_observation_id: "observation:excluded", artifact_id: "artifact:one", normalized_uri: "src/one.ts", authority: "authoritative_absence" }] }), "excluded"],
    ["recreated", absentSourceBase("deleted"), presentObservation(), "recreated"],
    ["reincluded", absentSourceBase("excluded"), presentObservation(), "reincluded"],
  ] as const)("plans the %s lifecycle transition", (_label, base, observations, expected) => {
    const plan = planner().plan(observations, base);
    expect(plan.transitions).toHaveLength(1);
    expect(plan.transitions[0]?.artifact_change.change_kind).toBe(expected);
    expect(plan.seeds[0]?.change_kind).toBe(expected);
    const opensPresence = ["created", "updated", "recreated", "reincluded"].includes(expected);
    const target = opensPresence
      ? plan.transitions[0]?.target_artifact_version_without_generation
      : plan.transitions[0]?.target_artifact_tombstone_without_generation;
    expect(target).toMatchObject({ workspace_id: workspaceId, artifact_id: "artifact:one" });
    expect(target).not.toHaveProperty("valid_from_generation");
    expect(target).not.toHaveProperty("valid_to_generation");
    expect(plan.transitions[0]?.target_artifact_version_without_generation === undefined).toBe(!opensPresence);
    expect(plan.transitions[0]?.target_artifact_tombstone_without_generation === undefined).toBe(opensPresence);
    expect(plan.seeds[0]?.lifecycle_barrier).toBe(!opensPresence);
  });

  it("plans source transitions without assigning publication fields", () => {
    const plan = planner().plan(presentObservation(), emptySourceBase());
    expect(JSON.stringify(plan)).not.toMatch(/valid_(?:from|to)_generation|published_at|snapshot_id|generation_manifest_id/u);
  });

  it.each([
    ["partial coverage", presentObservation({ coverage_completeness: "partial", observations: [] })],
    ["unstable read", presentObservation({ stable: false, observations: [] })],
    ["ordinary delete hint", presentObservation({ observation_mode: "watch", observations: [{ observed_state: "deleted", source_observation_id: "observation:hint", artifact_id: "artifact:one", normalized_uri: "src/one.ts", authority: "hint" }] })],
    ["unavailable outcome", presentObservation({ outcome: "unavailable", observations: [] })],
    ["source-changed outcome", presentObservation({ outcome: "source_changed", observations: [] })],
    ["cancelled outcome", presentObservation({ outcome: "cancelled", observations: [] })],
    ["failed outcome", presentObservation({ outcome: "failed", observations: [] })],
  ])("never converts %s into deletion", (_label, observations) => {
    expect(planner().plan(observations, presentSourceBase()).transitions).toEqual([]);
  });

  it("accepts only registered authoritative watch deletion", () => {
    const observation = presentObservation({
      observation_mode: "watch",
      deletion_authority: "none",
      supports_authoritative_delete_events: true,
      observations: [{ observed_state: "deleted", source_observation_id: "observation:watch-delete", artifact_id: "artifact:one", normalized_uri: "src/one.ts", authority: "authoritative_delete" }],
    });
    expect(planner().plan(observation, presentSourceBase()).transitions[0]?.artifact_change.change_kind).toBe("deleted");
  });

  it("advances freshness for equivalent complete input without publication", () => {
    const observations = presentObservation({ observations: [{
      ...presentObservationEntry(),
      content_blob_id: "content:old",
      content_hash: "sha256:old",
      analysis_metadata_digest: "sha256:metadata-old",
    }] });
    const plan = planner().plan(observations, presentSourceBase());
    expect(plan).toMatchObject({ equivalent: true, transitions: [] });
    expect(plan.next_freshness_checkpoint.verification_status).toBe("equivalent");
  });

  it("treats identical reappearance as a fresh lifecycle occurrence", () => {
    const observations = presentObservation({ observations: [{
      ...presentObservationEntry(),
      content_blob_id: "content:old",
      content_hash: "sha256:old",
      analysis_metadata_digest: "sha256:metadata-old",
    }] });
    expect(planner().plan(observations, absentSourceBase("deleted")).transitions[0]?.artifact_change.change_kind).toBe("recreated");
  });
});
