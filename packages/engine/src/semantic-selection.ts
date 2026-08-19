import type { EmbeddingProfile } from "@urdira/contracts";

export interface FrozenEvaluationGate {
  readonly gate_id: string;
  readonly gate_version: number;
  readonly evaluation_digest: string;
}

export interface BundledProfileCandidate {
  readonly profile: EmbeddingProfile;
  readonly evaluation_digest: string;
  readonly passed_gate_ids: readonly string[];
}

export function selectBundledProfile(candidates: readonly BundledProfileCandidate[], gates: readonly FrozenEvaluationGate[]): BundledProfileCandidate {
  if (gates.length === 0) throw new Error("At least one frozen evaluation gate is required.");
  const valid = candidates.filter((candidate) => gates.every((gate) => candidate.evaluation_digest === gate.evaluation_digest && candidate.passed_gate_ids.includes(gate.gate_id)));
  if (valid.length === 0) throw new Error("No bundled semantic profile satisfies the frozen evaluation gates.");
  return [...valid].sort((left, right) => left.profile.embedding_profile_id.localeCompare(right.profile.embedding_profile_id))[0]!;
}
