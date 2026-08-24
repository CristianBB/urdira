// The one record-local integrity check behind every index-pack verify
// surface: the inline loop in `verifyCopiedRecordIntegrity`, the sqlite
// range shards AND the stream-time batch mode of
// `index-pack-verify-worker.ts` (`index-pack.ts` for the trust-model doc
// comment on what this defends against and what it deliberately does not).
// Extracted so the check exists exactly once -- three hand-copied loops
// drifted apart is precisely the failure mode a verify must not have.
import { decodeCanonical } from "@urdira/canonical";
import { digestRelationalValue } from "@urdira/storage";

export const RECORD_ID_PATTERN = /^record:[0-9a-f]{64}$/u;

/**
 * Returns the failure description for one record row, or undefined when the
 * row is internally consistent. Checks, in order (first failure wins, later
 * checks are skipped exactly like the historical loops did): (1) the id uses
 * the plain first-open form, (2) record_id restates record_digest, (3) when
 * a body is present, its recomputed digest matches the claimed body_digest.
 */
export function recordIntegrityFailure(recordId: string, recordDigest: string, bodyDigest: string, body: Uint8Array | null | undefined): string | undefined {
  if (!RECORD_ID_PATTERN.test(recordId)) return `record ${recordId} does not use the plain first-open id form (chain-salted or malformed ids are rejected)`;
  if (recordId !== `record:${recordDigest.slice("sha256:".length)}`) return `record ${recordId} id is not self-consistent with its own record_digest`;
  if (body !== null && body !== undefined) {
    try {
      const recomputed = digestRelationalValue(decodeCanonical(body));
      if (recomputed.digest !== bodyDigest) return `record ${recordId} body_digest does not match its recomputed body_payload content`;
    } catch { return `record ${recordId} body_payload is not a valid canonical payload`; }
  }
  return undefined;
}
