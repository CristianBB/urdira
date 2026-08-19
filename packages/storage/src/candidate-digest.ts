import { canonicalBytes, digestBytes, encodeCanonical } from "@urdira/canonical";
import { StorageError } from "./errors.js";
import type { FrozenCandidateBaseTuple } from "./candidates.js";

export function normalizeObservationBatchIds(values: readonly string[]): readonly string[] {
  if (values.some((value) => typeof value !== "string" || value.length === 0)) throw new StorageError("storage:publication_invalid", "Source observation batch IDs must be non-empty strings.");
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function canonicalFrozenCandidateBaseTuple(value: FrozenCandidateBaseTuple): Record<string, unknown> {
  return Object.fromEntries(Object.entries({
    snapshot_id: value.snapshot_id,
    generation: value.generation,
    registry_snapshot_id: value.registry_snapshot_id,
    resolution_lock_id: value.resolution_lock_id,
    configuration_revision_id: value.configuration_revision_id,
    source_state_digest: value.source_state_digest,
    source_observation_batch_ids: normalizeObservationBatchIds(value.source_observation_batch_ids),
  }).filter(([, entry]) => entry !== undefined));
}

export function frozenCandidateBaseTupleDigest(value: FrozenCandidateBaseTuple): string {
  return digestBytes(canonicalBytes(canonicalFrozenCandidateBaseTuple(value)));
}

export function sameFrozenCandidateBaseTuple(left: FrozenCandidateBaseTuple, right: FrozenCandidateBaseTuple): boolean {
  return left.tuple_digest === right.tuple_digest
    && sameBytes(encodeCanonical(canonicalFrozenCandidateBaseTuple(left)), encodeCanonical(canonicalFrozenCandidateBaseTuple(right)))
    && frozenCandidateBaseTupleDigest(left) === frozenCandidateBaseTupleDigest(right);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
