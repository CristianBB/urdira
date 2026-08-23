import { buildFactDeltaBatch, FACT_DELTA_BATCH_MAX_BYTES, FACT_DELTA_BATCH_MAX_ROWS, type FactDelta, type FactDeltaBatch } from "@urdira/contracts";

/** Iterate a FactDelta's bounded native projection without retaining all batches. */
export function* iterateNativeFactDeltaBatches(delta: FactDelta): Generator<FactDeltaBatch> {
  const recordProjections = (start: number, end: number) => {
    const records: { strings: string[]; presence: boolean[] }[] = [];
    const graph_edges: { strings: string[] }[] = [];
    const identities: { strings: string[] }[] = [];
    for (let index = start; index < end; index += 1) {
      const record = delta.proposed_records[index];
      if (record === undefined) continue;
      records.push({ strings: [record.proposal_record_key, record.category, record.kind, record.universal_kind, record.identity_key], presence: [record.facets.length > 0, record.source_span.length > 0, record.evidence_references.length > 0] });
      if (record.category === "relation") graph_edges.push({ strings: [record.proposal_record_key, record.kind, record.identity_key] });
      if (record.identity_key.length > 0) identities.push({ strings: [record.proposal_record_key, record.identity_key, record.kind] });
    }
    return { records, graph_edges, identities };
  };
  const dependencyRows = (start: number, end: number) => delta.proposed_dependencies.slice(start, end).map((dependency) => ({ strings: [dependency.proposed_dependency_id, dependency.proposal_record_key, dependency.dependency_artifact_id, dependency.dependency_artifact_version_id, dependency.dependency_role] }));
  const total = Math.max(delta.proposed_records.length, delta.proposed_dependencies.length);
  let chunkSize = FACT_DELTA_BATCH_MAX_ROWS;
  let start = 0;
  let sequence = 0;
  do {
    const end = Math.min(total, start + chunkSize);
    try {
      yield buildFactDeltaBatch({ sequence, final: end >= total, ...recordProjections(start, end), dependencies: dependencyRows(start, end) });
      start = end;
      sequence += 1;
    } catch (error) {
      if (!(error instanceof RangeError) || !String(error.message).includes("bytes") || chunkSize === 1) throw error;
      chunkSize = Math.max(1, Math.floor(chunkSize / 2));
    }
  } while (start < total || sequence === 0);
}

export function assertNativeFactDeltaBatchBudget(batch: FactDeltaBatch): void {
  if (batch.byte_length > FACT_DELTA_BATCH_MAX_BYTES || [batch.records, batch.graph_edges, batch.identities, batch.dependencies].some((section) => section.row_count > FACT_DELTA_BATCH_MAX_ROWS)) throw new RangeError("Native FactDelta batch exceeds its bounded memory budget.");
}
