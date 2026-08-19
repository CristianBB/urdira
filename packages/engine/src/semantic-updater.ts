import { canonicalBytes, digestBytes } from "@urdira/canonical";
import type { EmbeddingProfile } from "@urdira/contracts";
import type { SemanticDocument } from "./semantic-documents.js";
import type { SemanticGeneratedVector, SemanticRuntimeBinding } from "./semantic-runtime.js";

export type SemanticCoverageStatus = "complete" | "partial" | "pending" | "excluded" | "unsupported" | "failed";

export interface SemanticProfileLane {
  readonly profile: EmbeddingProfile;
  readonly executable_binding_digest: string;
  readonly runtime_binding_id: string;
}

export interface SemanticLaneVector {
  readonly document_id: string;
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly vector: Uint8Array;
  readonly vector_digest: string;
  readonly input_digest: string;
}

export interface SemanticLaneMaterialization {
  readonly embedding_profile_id: string;
  readonly embedding_profile_digest: string;
  readonly executable_binding_digest: string;
  readonly runtime_binding_id: string;
  readonly coverage_status: SemanticCoverageStatus;
  readonly artifact_count: number;
  readonly covered_artifact_count: number;
  readonly pending_artifact_count: number;
  readonly excluded_artifact_count: number;
  readonly unsupported_artifact_count: number;
  readonly failed_artifact_count: number;
  readonly vectors: readonly SemanticLaneVector[];
  readonly reason_codes: readonly string[];
}

export interface SemanticMaterialization {
  readonly semantic_materialization_id: string;
  readonly source_snapshot_id: string;
  readonly generation: number;
  readonly lanes: readonly SemanticLaneMaterialization[];
  readonly materialization_digest: string;
}

export interface SemanticMaterializationStore {
  read?(input?: { readonly source_snapshot_id?: string; readonly generation?: number }): Promise<SemanticMaterialization | undefined>;
  put(value: SemanticMaterialization): Promise<void>;
}

export interface SemanticUpdateInput {
  readonly source_snapshot_id: string;
  readonly generation: number;
  readonly documents: readonly SemanticDocument[];
  readonly lanes: readonly SemanticProfileLane[];
  readonly allow_partial?: boolean;
}

export interface SemanticRuntimeProvider {
  binding(runtimeBindingId: string, executableBindingDigest: string): SemanticRuntimeBinding;
}

function coverageFor(documents: readonly SemanticDocument[]): { status: SemanticCoverageStatus; eligible: readonly SemanticDocument[]; reasons: readonly string[]; counts: Pick<SemanticLaneMaterialization, "artifact_count" | "pending_artifact_count" | "excluded_artifact_count" | "unsupported_artifact_count"> } {
  const eligible = documents.filter((document) => document.eligibility_status === "eligible");
  const pending = documents.filter((document) => document.eligibility_status === "pending").length;
  const excluded = documents.filter((document) => document.eligibility_status === "excluded").length;
  const unsupported = documents.filter((document) => document.eligibility_status === "unsupported").length;
  const status: SemanticCoverageStatus = eligible.length === documents.length ? "complete" : eligible.length > 0 ? "partial" : pending > 0 ? "pending" : excluded > 0 ? "excluded" : "unsupported";
  const reasons = [
    ...(pending > 0 ? ["core:semantic_pending"] : []),
    ...(excluded > 0 ? ["core:semantic_excluded"] : []),
    ...(unsupported > 0 ? ["core:semantic_unsupported"] : []),
  ];
  return { status, eligible, reasons, counts: { artifact_count: documents.length, pending_artifact_count: pending, excluded_artifact_count: excluded, unsupported_artifact_count: unsupported } };
}

function semanticMaterializationId(snapshot: string, generation: number): string { return `semantic-materialization:${digestBytes(canonicalBytes({ source_snapshot_id: snapshot, generation }))}`; }

export class SemanticUpdater {
  constructor(private readonly store: SemanticMaterializationStore, private readonly runtime: SemanticRuntimeProvider) {}

  async update(input: SemanticUpdateInput): Promise<SemanticMaterialization> {
    if (!Number.isSafeInteger(input.generation) || input.generation < 0) throw new Error("Semantic update generation must be a non-negative safe integer.");
    const existing = await this.store.read?.({ source_snapshot_id: input.source_snapshot_id, generation: input.generation });
    const lanes: SemanticLaneMaterialization[] = [];
    for (const lane of [...input.lanes].sort((left, right) => left.profile.embedding_profile_id.localeCompare(right.profile.embedding_profile_id))) {
      const eligibleCoverage = coverageFor(input.documents);
      const vectors: SemanticLaneVector[] = [];
      let failed = 0;
      const binding = this.runtime.binding(lane.runtime_binding_id, lane.executable_binding_digest);
      for (const document of eligibleCoverage.eligible) {
        try {
          const generated: SemanticGeneratedVector = await binding.generateVector({ profile: lane.profile, purpose: "document", text: document.sections.map((section) => section.text).join("\n") });
          vectors.push({ document_id: document.document_id, artifact_id: document.artifact_id, artifact_version_id: document.artifact_version_id, vector: generated.vector, vector_digest: generated.vector_digest, input_digest: generated.input_digest });
        } catch {
          failed += 1;
        }
      }
      const coverageStatus: SemanticCoverageStatus = failed > 0 ? (vectors.length > 0 || eligibleCoverage.status !== "complete" ? "partial" : "failed") : eligibleCoverage.status;
      lanes.push({
        embedding_profile_id: lane.profile.embedding_profile_id,
        embedding_profile_digest: lane.profile.profile_digest,
        executable_binding_digest: lane.executable_binding_digest,
        runtime_binding_id: lane.runtime_binding_id,
        coverage_status: coverageStatus,
        ...eligibleCoverage.counts,
        covered_artifact_count: vectors.length,
        failed_artifact_count: failed,
        vectors: vectors.sort((left, right) => left.document_id.localeCompare(right.document_id)),
        reason_codes: [...eligibleCoverage.reasons, ...(failed > 0 ? ["core:semantic_runtime_failed"] : [])].sort(),
      });
    }
    const failedOrPartial = lanes.some((lane) => lane.coverage_status === "failed" || lane.coverage_status === "partial" || lane.coverage_status === "pending");
    if (failedOrPartial && !input.allow_partial) throw new Error("Semantic update does not satisfy complete coverage.");
    const materializationWithoutDigest = {
      semantic_materialization_id: semanticMaterializationId(input.source_snapshot_id, input.generation),
      source_snapshot_id: input.source_snapshot_id,
      generation: input.generation,
      lanes,
    };
    const materialization: SemanticMaterialization = { ...materializationWithoutDigest, materialization_digest: digestBytes(canonicalBytes(materializationWithoutDigest)) };
    if (existing) {
      if (existing.materialization_digest !== materialization.materialization_digest) throw new Error("Semantic materialization identity conflicts with immutable bytes.");
      return existing;
    }
    await this.store.put(materialization);
    return materialization;
  }
}
