import { LogicalDigestWriter, MerkleRadixSet } from "@urdira/canonical";

interface BatchDigestSource {
  readonly workspace_id: string;
  readonly source_provider_binding_id: string;
  readonly source_provider: string;
  readonly source_provider_version: string;
  readonly ordering_domain: string;
  readonly observation_mode: string;
  readonly coverage_scopes: string;
  readonly coverage_completeness: string;
  readonly deletion_authority: string;
  readonly provider_cursor_before: string;
  readonly provider_cursor_after: string;
  readonly observation_count: number;
  readonly unavailable_count: number;
}

interface ObservationDigestSource {
  readonly artifact_id: string;
  readonly observed_state: string;
  readonly observed_content_hash?: string;
  readonly observed_metadata_digest?: string;
  readonly provider_event_token?: string;
  readonly provider_sequence?: string;
}

function observationDigest(observation: ObservationDigestSource): string {
  const writer = new LogicalDigestWriter("urdira:source-observation:v3");
  const optional = (value: unknown): value is string => typeof value === "string";
  writer.field("artifact_id", true, () => writer.text(0, observation.artifact_id));
  writer.field("observed_state", true, () => writer.text(0, observation.observed_state));
  writer.field("observed_content_hash", optional(observation.observed_content_hash), () => writer.text(0, observation.observed_content_hash as string));
  writer.field("observed_metadata_digest", optional(observation.observed_metadata_digest), () => writer.text(0, observation.observed_metadata_digest as string));
  writer.field("provider_event_token", optional(observation.provider_event_token), () => writer.text(0, observation.provider_event_token as string));
  writer.field("provider_sequence", optional(observation.provider_sequence), () => writer.text(0, observation.provider_sequence as string));
  return writer.digest();
}

export function sourceObservationBatchDigest(
  batch: BatchDigestSource,
  observations: readonly ObservationDigestSource[],
): string {
  // Build the set bottom-up so a large provider page does not recompute 64
  // radix branches for every observation.
  const observationsRoot = MerkleRadixSet.from((function* () {
    for (const observation of observations) {
      const digest = observationDigest(observation);
      yield { member_digest: digest, logical_digest: digest };
    }
  })());
  const writer = new LogicalDigestWriter("urdira:source-observation-batch:v3");
  const required = (name: string, value: string): void => { writer.field(name, true, () => { writer.text(0, value); }); };
  required("workspace_id", batch.workspace_id);
  required("source_provider_binding_id", batch.source_provider_binding_id);
  required("source_provider", batch.source_provider);
  required("source_provider_version", batch.source_provider_version);
  required("ordering_domain", batch.ordering_domain);
  required("observation_mode", batch.observation_mode);
  required("coverage_scopes", batch.coverage_scopes);
  required("coverage_completeness", batch.coverage_completeness);
  required("deletion_authority", batch.deletion_authority);
  required("provider_cursor_before", batch.provider_cursor_before);
  required("provider_cursor_after", batch.provider_cursor_after);
  writer.field("observation_count", true, () => writer.integer(batch.observation_count));
  writer.field("unavailable_count", true, () => writer.integer(batch.unavailable_count));
  writer.field("observation_set", true, () => {
    writer.field("root", true, () => writer.text(0, observationsRoot.root()));
    writer.field("member_count", true, () => writer.integer(observationsRoot.size()));
  });
  return writer.digest();
}
