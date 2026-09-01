export interface NativeExactVectorTopKRequest {
  readonly query: Uint8Array;
  readonly candidates: Uint8Array;
  readonly projectionRecordIds: readonly string[];
  readonly dimensions: number;
  readonly elementType: "float32_le" | "float64_le";
  readonly k: number;
  readonly metric: "cosine" | "squared_l2";
}

export interface NativeExactVectorTopKMatch {
  readonly projection_record_id: string;
  readonly rank: number;
}

/** Composition-owned native port. The engine supplies call-owned packed
 * buffers and retains no native or JavaScript objects after the batch call. */
export interface NativeExactVectorTopKPort {
  exactVectorTopKBatch(requests: readonly NativeExactVectorTopKRequest[]): readonly (readonly NativeExactVectorTopKMatch[])[];
}

let activePort: NativeExactVectorTopKPort | undefined;

/** Selects the validated exact-vector kernel. Once selected, malformed native
 * output and native failures propagate; query execution never retries through
 * the TypeScript oracle. */
export function configureNativeExactVectorTopKPort(port: NativeExactVectorTopKPort | undefined): void {
  activePort = port;
}

export function nativeExactVectorTopKConfigured(): boolean {
  return activePort !== undefined;
}

export function nativeExactVectorTopK(
  request: NativeExactVectorTopKRequest,
): readonly NativeExactVectorTopKMatch[] | undefined {
  const port = activePort;
  if (port === undefined) return undefined;
  const batches = port.exactVectorTopKBatch([request]);
  if (batches.length !== 1 || !Array.isArray(batches[0])) {
    throw new Error("Native exact vector top-k returned a malformed result batch.");
  }
  const matches = batches[0];
  const expectedCount = Math.min(request.k, request.projectionRecordIds.length);
  const identifiers = new Set(request.projectionRecordIds);
  const seen = new Set<string>();
  if (matches.length !== expectedCount) throw new Error("Native exact vector top-k returned a malformed result count.");
  for (const [index, match] of matches.entries()) {
    if (typeof match?.projection_record_id !== "string"
      || !identifiers.has(match.projection_record_id)
      || seen.has(match.projection_record_id)
      || match.rank !== index + 1) {
      throw new Error("Native exact vector top-k returned a malformed result.");
    }
    seen.add(match.projection_record_id);
  }
  return matches;
}
