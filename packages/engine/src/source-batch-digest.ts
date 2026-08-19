import { canonicalBytes, digestBytes } from "@urdira/canonical";

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

interface CanonicalObservationDigestEntry {
  readonly artifact_id: string;
  readonly observed_state: string;
  readonly observed_content_hash?: string;
  readonly observed_metadata_digest?: string;
  readonly provider_event_token?: string;
  readonly provider_sequence?: string;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

export function sourceObservationBatchDigest(
  batch: BatchDigestSource,
  observations: readonly ObservationDigestSource[],
): string {
  const ordered = observations.map((observation): { readonly entry: CanonicalObservationDigestEntry; readonly bytes: Uint8Array } => {
    const entry: CanonicalObservationDigestEntry = {
      artifact_id: observation.artifact_id,
      observed_state: observation.observed_state,
      ...(observation.observed_content_hash === undefined ? {} : { observed_content_hash: observation.observed_content_hash }),
      ...(observation.observed_metadata_digest === undefined ? {} : { observed_metadata_digest: observation.observed_metadata_digest }),
      ...(observation.provider_event_token === undefined ? {} : { provider_event_token: observation.provider_event_token }),
      ...(observation.provider_sequence === undefined ? {} : { provider_sequence: observation.provider_sequence }),
    };
    return { entry, bytes: canonicalBytes(entry) };
  }).sort((left, right) => compareBytes(left.bytes, right.bytes));
  const deduplicated = ordered.filter((value, index) => index === 0 || compareBytes(value.bytes, ordered[index - 1]!.bytes) !== 0).map(({ entry }) => entry);
  return digestBytes(canonicalBytes({
    workspace_id: batch.workspace_id,
    source_provider_binding_id: batch.source_provider_binding_id,
    source_provider: batch.source_provider,
    source_provider_version: batch.source_provider_version,
    ordering_domain: batch.ordering_domain,
    observation_mode: batch.observation_mode,
    coverage_scopes: batch.coverage_scopes,
    coverage_completeness: batch.coverage_completeness,
    deletion_authority: batch.deletion_authority,
    provider_cursor_before: batch.provider_cursor_before,
    provider_cursor_after: batch.provider_cursor_after,
    observation_count: batch.observation_count,
    unavailable_count: batch.unavailable_count,
    observations: deduplicated,
  }));
}
