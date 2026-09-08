import { canonicalVectorBytes, type SemanticVectorConfiguration } from "./semantic-runtime.js";
import { nativeExactVectorTopK, nativeExactVectorTopKConfigured } from "./native-exact-vector.js";

export type SemanticMetadata = Readonly<Record<string, string | number | boolean | readonly string[]>>;

export interface ExactVectorCandidate {
  readonly projection_record_id: string;
  readonly profile_id: string;
  readonly executable_binding_id: string;
  readonly vector: readonly number[] | Uint8Array;
  readonly metadata?: SemanticMetadata;
}

export interface ExactVectorScanOptions {
  readonly profile_id: string;
  readonly executable_binding_id: string;
  readonly dimensions: number;
  readonly element_type?: "float32" | "float64";
  readonly distance_metric: "squared_l2" | "cosine";
  readonly normalization?: "none" | "l2";
  readonly filter?: SemanticMetadata;
  readonly limit?: number;
}

export interface ExactVectorMatch {
  readonly projection_record_id: string;
  readonly rank: number;
}

function values(value: readonly number[] | Uint8Array, dimensions: number, elementType: "float32" | "float64"): number[] {
  if (value instanceof Uint8Array) {
    const width = elementType === "float32" ? 4 : 8;
    if (value.byteLength !== dimensions * width) throw new Error("Exact semantic vector has invalid byte length.");
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    return Array.from({ length: dimensions }, (_, index) => elementType === "float32" ? view.getFloat32(index * width, true) : view.getFloat64(index * width, true));
  }
  if (value.length !== dimensions || value.some((item) => !Number.isFinite(item))) throw new Error("Exact semantic vector has invalid values.");
  return [...value];
}

function matchesFilter(metadata: SemanticMetadata | undefined, filter: SemanticMetadata | undefined): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([key, expected]) => {
    const actual = metadata?.[key];
    if (Array.isArray(actual)) return actual.includes(expected as string);
    return actual === expected;
  });
}

const textEncoder = new TextEncoder();

/** Exported (Frente S-I) so `canonical-query-data-port.ts` can sort a
 * resident lane buffer's rows into the SAME ascending order this module's
 * own tie-break already assumes, before registering it with the native
 * resident kernel (which tie-breaks by buffer INDEX, not by string -- see
 * `residentExactVectorScan`'s own doc comment) -- reusing this exact
 * function, rather than a second reimplementation, is what makes that
 * index tie-break provably equivalent to this one. */
export function utf8Compare(left: string, right: string): number {
  const leftBytes = textEncoder.encode(left.normalize("NFC"));
  const rightBytes = textEncoder.encode(right.normalize("NFC"));
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function distance(left: readonly number[], right: readonly number[], metric: ExactVectorScanOptions["distance_metric"]): number {
  if (metric === "squared_l2") return left.reduce((sum, value, index) => sum + ((value - (right[index] ?? 0)) ** 2), 0);
  const leftNorm = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0));
  const rightNorm = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0));
  if (leftNorm === 0 || rightNorm === 0) throw new Error("Cosine semantic scan does not accept zero vectors.");
  return 1 - left.reduce((sum, value, index) => sum + (value * (right[index] ?? 0)), 0) / (leftNorm * rightNorm);
}

/**
 * Frente S-D (2026-09-07, latency): `canonicalVectorBytes` for a Uint8Array
 * candidate whose byte length already matches `dimensions`/`element_type`
 * costs a full decode -> optional-renormalize -> re-encode round trip PER
 * CANDIDATE -- real, measured JS-side CPU proportional to candidate count x
 * dimensions on every query (`docs/evidence/2026-09-07-v4-semantic-wiring-and-embed-performance.md`
 * §3.3's own `rank-scan` cost center), independent of whether the native or
 * JS-fallback distance computation runs afterward. Every candidate reaching
 * this function has ALREADY been filtered (by `exactVectorScan`, just above
 * each call site) to share this exact call's `profile_id` AND
 * `executable_binding_id` -- the SAME vector-space identity that controlled
 * its OWN canonicalization the one time it was ever written
 * (`WorkspaceProjectionRepository.canonicalVectorBytes`, `@urdira/storage`'s
 * `putVectors`, the only writer of `vector_projection_rows`/its packed CAS
 * shards). A byte-length match against `dimensions`/`element_type` is
 * therefore sufficient proof this candidate's bytes are ALREADY exactly what
 * this function's own re-canonicalization would produce (already finite,
 * already normalized per this same profile's own `normalization` setting) --
 * skipping the redundant round trip relies on the WRITE path's own
 * guarantee, never on skipping validation the read path would otherwise be
 * the only place to enforce. A raw `readonly number[]` candidate (never
 * written by this codebase's own storage layer, but structurally accepted by
 * `ExactVectorCandidate.vector` for a caller/test that hands in un-encoded
 * values) or a length MISMATCH always falls through to the full
 * `canonicalVectorBytes` call, unchanged.
 */
function fastCandidateBytes(vector: readonly number[] | Uint8Array, dimensions: number, configuration: SemanticVectorConfiguration): Uint8Array {
  if (vector instanceof Uint8Array) {
    const width = configuration.element_type === "float32" ? 4 : 8;
    if (vector.byteLength === dimensions * width) return vector;
  }
  return canonicalVectorBytes(vector, configuration);
}

/**
 * Frente S-D (2026-09-07, latency): the native `exactVectorTopKBatch` port
 * enforces two generic batch limits shared by several unrelated native batch
 * operations (`crates/urdira-native-core/src/lib.rs`): `MAX_BATCH_RECORDS`
 * (4,096 candidates) and `MAX_BATCH_FRAMED_BYTES` (4MiB, computed there as
 * `(query_scalar_count + sum(candidate_scalar_counts)) * 8 +
 * sum(identifier_byte_lengths)` -- SCALAR counts, not raw wire bytes, since
 * the native side decodes every candidate to `f64` internally regardless of
 * the wire `element_type`). Discovered live: n8n-scale entity-grain
 * candidate counts (deliberately UNCAPPED before ranking, per decision 17's
 * own max-similarity aggregation) routinely exceed BOTH bounds for 384-dim
 * vectors (the byte bound alone caps out around ~1,300 candidates) -- the
 * native call previously received every eligible candidate in ONE batch and
 * threw outright ("Exact vector batch exceeds the ... byte bound"),
 * making `core:search_semantic` completely unusable on any real corpus past
 * that size (confirmed live on a 2,492-file corpus with ~11k open
 * entity-grain vectors).
 *
 * `NATIVE_BATCH_BYTE_BUDGET`/`NATIVE_BATCH_RECORD_BUDGET` below mirror the
 * native bounds (with headroom subtracted for this TS-side estimate's own
 * imprecision), and `nativeTopKChunked` recovers EXACTNESS (decision 06: no
 * ANN, no sampling) by chunking eligible candidates into native-sized
 * batches, computing each chunk's OWN top-`limit` natively, then recursively
 * merging and re-ranking the (much smaller) union of chunk winners. This is
 * provably exact, not an approximation: any candidate that could appear in
 * the GLOBAL top-`limit` must also appear in its OWN chunk's top-`limit`
 * (if it did not, at least `limit` OTHER candidates in that same chunk would
 * already outrank it, so at least `limit` candidates would outrank it
 * globally too) -- so no candidate is ever wrongly excluded, and the
 * recursion terminates because each merge round strictly shrinks the
 * candidate set (from `eligible.length` down to at most `chunk_count x
 * limit`) until it fits in a single native call.
 */
const NATIVE_BATCH_BYTE_BUDGET = 4 * 1024 * 1024 - 64 * 1024; // 64KiB headroom under the native 4MiB bound
const NATIVE_BATCH_RECORD_BUDGET = 4096 - 1; // headroom under the native 4,096-candidate bound

/**
 * Frente S-E (2026-09-07): a NEW, severe P0 found live -- `nativeTopKChunked`
 * never terminated (168.9s of real CPU, then `RangeError: Maximum call stack
 * size exceeded`) for the entity-grain lane's own real call shape:
 * `trySemanticSearch` (`canonical-query-data-port.ts`) calls `exactVectorScan`
 * for entities with NO `limit` at all -- deliberately uncapped before the
 * per-document max-similarity aggregation (decision 17: "cap 100 tras
 * agregar", not before). `exactVectorScan` then defaults `limit` to
 * `eligible.length` -- i.e., "give me the full sorted order of every single
 * candidate", not a true top-K query. The chunk-then-merge recursion's own
 * termination argument ("each merge round strictly shrinks the candidate set
 * ... until it fits in a single native call") is FALSE whenever `limit` is
 * not meaningfully smaller than a chunk's own size: `Math.min(limit,
 * chunkCandidates.length)` degenerates to `chunkCandidates.length` itself, so
 * EVERY candidate in EVERY chunk survives as a "winner" -- the recursive call
 * on `winners` receives the EXACT SAME SIZE as `eligible` (nothing was ever
 * filtered out), so the very same "chunk it again" branch runs again,
 * forever, until the JS call stack itself overflows. This made
 * `core:search_semantic`/`core:search_hybrid` completely unusable on ANY
 * real corpus whose entity-grain vector count exceeds the native per-call
 * bound (~1,300 for 384-dim vectors) -- exactly n8n scale, and the
 * `packages/cli` 2,492-file subset this session's own embed measurement
 * used (10,964 open entity vectors).
 *
 * Fix: this is a fundamental property, not a tunable -- chunking can only
 * ever REDUCE a candidate set when the requested `limit` is meaningfully
 * smaller than a chunk's own size; when it is not (a near-`eligible.length`
 * or fully uncapped request), NO chunk-then-merge strategy can shrink the
 * winner set at all, so the recursive descent must never be re-attempted
 * once a round demonstrably made no progress. `winners.length <
 * eligible.length` is checked after every round: on genuine progress,
 * recursion continues exactly as before (unchanged behavior, unchanged
 * exactness argument, for every REAL top-K query this shipped with -- the
 * existing 9,000-candidate/limit-10 test already covers this path). On NO
 * progress, this falls back to `exactDistanceSort` -- the SAME JS-side
 * exact distance computation and tie-break (`values`/`distance`/`utf8Compare`)
 * `exactVectorScan`'s own non-native branch already uses when no native
 * kernel is configured at all -- computed ONCE over the (already
 * native-chunk-sorted, but not yet globally merged) `winners`, which is
 * always finite and no larger than `eligible.length`. This is still EXACT
 * (identical distance formula and tie-break as the native path), always
 * terminates (a single O(N log N) JS sort, no further native calls), and
 * costs meaningfully less than the crash it replaces even at n8n's own
 * uncapped entity-candidate scale.
 */
function exactDistanceSort(candidates: readonly ExactVectorCandidate[], vectors: readonly Uint8Array[], queryValues: readonly number[], dimensions: number, elementType: "float32_le" | "float64_le", limit: number, metric: "cosine" | "squared_l2"): readonly ExactVectorMatch[] {
  const jsElementType = elementType === "float32_le" ? "float32" as const : "float64" as const;
  const ranked = candidates
    .map((candidate, index) => ({ id: candidate.projection_record_id, distance: distance(values(vectors[index]!, dimensions, jsElementType), queryValues, metric) }))
    .sort((left, right) => left.distance - right.distance || utf8Compare(left.id, right.id));
  return ranked.slice(0, Math.min(limit, ranked.length)).map((entry, index) => ({ projection_record_id: entry.id, rank: index + 1 }));
}

function nativeTopKChunked(eligible: readonly ExactVectorCandidate[], packedVectors: readonly Uint8Array[], identifiers: readonly string[], queryBytes: Uint8Array, dimensions: number, elementType: "float32_le" | "float64_le", limit: number, metric: "cosine" | "squared_l2"): readonly ExactVectorMatch[] {
  const idByteLengths = identifiers.map((id) => textEncoder.encode(id).length);
  const totalIdBytes = idByteLengths.reduce((sum, value) => sum + value, 0);
  const totalBytes = (dimensions + eligible.length * dimensions) * 8 + totalIdBytes;
  if (totalBytes <= NATIVE_BATCH_BYTE_BUDGET && eligible.length <= NATIVE_BATCH_RECORD_BUDGET) {
    const width = dimensions * (elementType === "float32_le" ? 4 : 8);
    const packedCandidates = new Uint8Array(eligible.length * width);
    packedVectors.forEach((bytes, index) => packedCandidates.set(bytes, index * width));
    const native = nativeExactVectorTopK({ query: queryBytes, candidates: packedCandidates, projectionRecordIds: identifiers, dimensions, elementType, k: Math.min(limit, eligible.length), metric });
    if (native === undefined) throw new Error("Native exact vector top-k configuration changed during the query.");
    return native;
  }
  // Chunk sizing: the byte bound's per-candidate cost is `dimensions * 8 +
  // this candidate's own identifier byte length` -- using the AVERAGE
  // identifier length here (not each one's exact length) is a conservative
  // estimate only for SIZING chunks; every chunk is re-measured exactly
  // (recursing back into this same function, which re-derives `totalBytes`
  // precisely for that chunk) before ever being sent to the native port, so
  // an unlucky distribution of identifier lengths can only make a chunk
  // smaller than strictly necessary, never one that still overflows.
  const averageIdBytes = eligible.length === 0 ? 0 : totalIdBytes / eligible.length;
  const byteBudgetForCandidates = Math.max(1, NATIVE_BATCH_BYTE_BUDGET - dimensions * 8);
  const maxPerChunkByBytes = Math.max(1, Math.floor(byteBudgetForCandidates / (dimensions * 8 + averageIdBytes)));
  const maxPerChunk = Math.max(1, Math.min(maxPerChunkByBytes, NATIVE_BATCH_RECORD_BUDGET));
  const winners: ExactVectorCandidate[] = [];
  const winnerVectors: Uint8Array[] = [];
  for (let start = 0; start < eligible.length; start += maxPerChunk) {
    const end = Math.min(start + maxPerChunk, eligible.length);
    const chunkCandidates = eligible.slice(start, end);
    const chunkVectors = packedVectors.slice(start, end);
    const chunkIds = identifiers.slice(start, end);
    const chunkMatches = nativeTopKChunked(chunkCandidates, chunkVectors, chunkIds, queryBytes, dimensions, elementType, Math.min(limit, chunkCandidates.length), metric);
    const idToIndex = new Map(chunkIds.map((id, index) => [id, index] as const));
    for (const match of chunkMatches) {
      const index = idToIndex.get(match.projection_record_id);
      if (index === undefined) throw new Error("Native exact vector top-k returned an identifier outside its own chunk.");
      winners.push(chunkCandidates[index]!);
      winnerVectors.push(chunkVectors[index]!);
    }
  }
  // Frente S-E (2026-09-07): see this function's own updated doc comment
  // above `exactDistanceSort` -- a round that made NO progress (every
  // candidate in every chunk survived) can never make progress on a further
  // recursive attempt either (the SAME `limit`/chunk-size relationship still
  // holds), so recursing again would loop forever. Fall back to an exact JS
  // merge instead of ever re-entering the native chunking branch with an
  // unchanged candidate count.
  if (winners.length >= eligible.length) {
    const queryValues = values(queryBytes, dimensions, elementType === "float32_le" ? "float32" : "float64");
    return exactDistanceSort(winners, winnerVectors, queryValues, dimensions, elementType, limit, metric);
  }
  return nativeTopKChunked(winners, winnerVectors, winners.map((candidate) => candidate.projection_record_id), queryBytes, dimensions, elementType, limit, metric);
}

export function exactVectorScan(candidates: readonly ExactVectorCandidate[], query: readonly number[] | Uint8Array, options: ExactVectorScanOptions): readonly ExactVectorMatch[] {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) throw new Error("Exact semantic scan limit must be positive.");
  const elementType = options.element_type ?? "float32";
  const configuration = { dimensions: options.dimensions, element_type: elementType, normalization: options.normalization ?? "none" } as const;
  const queryBytes = canonicalVectorBytes(query, configuration);
  const queryValues = values(queryBytes, options.dimensions, elementType);
  const eligible = candidates.filter((candidate) => candidate.profile_id === options.profile_id && candidate.executable_binding_id === options.executable_binding_id && matchesFilter(candidate.metadata, options.filter));
  if (eligible.length === 0) return [];
  const identifiers = eligible.map((candidate) => candidate.projection_record_id);
  if (new Set(identifiers).size !== identifiers.length) throw new Error("Exact semantic scan candidate identifiers must be unique.");
  const limit = Math.min(options.limit ?? eligible.length, eligible.length);
  if (nativeExactVectorTopKConfigured()) {
    const packedVectors = eligible.map((candidate) => fastCandidateBytes(candidate.vector, options.dimensions, configuration));
    return nativeTopKChunked(eligible, packedVectors, identifiers, queryBytes, options.dimensions, elementType === "float32" ? "float32_le" : "float64_le", limit, options.distance_metric);
  }
  const vectors = eligible.map((candidate) => fastCandidateBytes(candidate.vector, options.dimensions, configuration));
  const ranked = eligible
    .map((candidate, index) => ({ id: candidate.projection_record_id, distance: distance(values(vectors[index]!, options.dimensions, elementType), queryValues, options.distance_metric) }))
    .sort((left, right) => left.distance - right.distance || utf8Compare(left.id, right.id));
  const limited = options.limit === undefined ? ranked : ranked.slice(0, options.limit);
  return limited.map((candidate, index) => ({ projection_record_id: candidate.id, rank: index + 1 }));
}

export interface RankedSemanticCandidate {
  readonly projection_record_id: string;
  readonly rank: number;
}

export interface SemanticLaneRanks {
  readonly lane_id: string;
  readonly candidates: readonly RankedSemanticCandidate[];
}

export interface FusedSemanticCandidate {
  readonly projection_record_id: string;
  readonly lane_ranks: Readonly<Record<string, number>>;
}

export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export interface SemanticSearchResult {
  readonly projection_record_id: string;
  readonly rank: number;
  readonly lane_ranks: Readonly<Record<string, number>>;
}

function rational(value: Rational): Rational {
  if (value.denominator <= 0n) throw new Error("Rational denominators must be positive.");
  return value;
}

function add(left: Rational, right: Rational): Rational {
  return rational({ numerator: left.numerator * right.denominator + right.numerator * left.denominator, denominator: left.denominator * right.denominator });
}

function compare(left: Rational, right: Rational): number {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference > 0n ? 1 : difference < 0n ? -1 : 0;
}

export function fuseSemanticLanes(lanes: readonly SemanticLaneRanks[]): readonly FusedSemanticCandidate[] {
  const merged = new Map<string, Record<string, number>>();
  for (const lane of lanes) {
    const seen = new Set<string>();
    for (const candidate of lane.candidates) {
      if (!Number.isSafeInteger(candidate.rank) || candidate.rank <= 0 || seen.has(candidate.projection_record_id)) throw new Error("Semantic lane ranks must be unique positive integers.");
      seen.add(candidate.projection_record_id);
      const current = merged.get(candidate.projection_record_id) ?? {};
      current[lane.lane_id] = candidate.rank;
      merged.set(candidate.projection_record_id, current);
    }
  }
  return [...merged.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([projection_record_id, lane_ranks]) => ({ projection_record_id, lane_ranks }));
}

export interface SemanticRerankOptions {
  readonly lane_weights?: Readonly<Record<string, Rational>>;
}

/**
 * Frente S-I (2026-09-08, plan `generic-waddling-hartmanis.md` §0): a
 * SEPARATE port from `NativeExactVectorTopKPort` above -- that one is
 * deliberately call-owned/stateless ("The engine supplies call-owned packed
 * buffers and retains no native or JavaScript objects after the batch
 * call"), which is exactly the shape that forces `nativeTopKChunked` to
 * re-pack and re-cross the N-API boundary on every chunk of every query even
 * though the underlying candidate data (`canonical-query-data-port.ts`'s own
 * resident vector cache) does not change between queries at all. This port
 * is deliberately STATEFUL on the native side: `registerVectorBuffer` copies
 * a caller-owned `Float32Array` into native memory ONCE per `(handleId,
 * generation)`, and `exactTopKContiguous` scans that already-resident buffer
 * directly, with no per-query marshaling. See `crates/urdira-native-core/src/lib.rs`'s
 * own module-level doc comment (search "Frente S-I") for the full mechanism
 * and correctness argument (ascending-identifier registration order + an
 * index tie-break replacing a string tie-break exactly).
 */
export interface ResidentVectorTopKMatch {
  readonly index: number;
  readonly distance: number;
}

export interface ResidentVectorTopKPort {
  registerVectorBuffer(handleId: string, generation: number, dimensions: number, buffer: Float32Array): void;
  exactTopKContiguous(handleId: string, generation: number, query: Float32Array, k: number, metric: "cosine" | "squared_l2"): readonly ResidentVectorTopKMatch[];
}

let activeResidentPort: ResidentVectorTopKPort | undefined;

/** Mirrors `configureNativeExactVectorTopKPort`'s own contract: once
 * selected, a native failure propagates -- query execution never retries
 * through a TypeScript fallback for a handle this port itself is
 * responsible for. `undefined` disables the resident fast path entirely
 * (every caller falls back to `exactVectorScan`'s existing chunked path). */
export function configureResidentVectorTopKPort(port: ResidentVectorTopKPort | undefined): void {
  activeResidentPort = port;
}

export function residentVectorTopKPortConfigured(): boolean {
  return activeResidentPort !== undefined;
}

export interface ResidentExactVectorScanRequest {
  /** Stable identity for the native-side buffer slot -- typically
   * `${workspace_id}:${profile_id}:${executable_binding_id}:${lane}`. */
  readonly handleId: string;
  /** Caller-owned monotonic tag; opaque to this function -- see this
   * module's own header comment on `ResidentVectorTopKPort` for why it need
   * not be the workspace's own structural/semantic generation number. */
  readonly generationTag: number;
  /** `true` when the caller just (re)built `buffer`/`ids` (a cache miss on
   * the CALLER's own side) and the native buffer must be re-registered
   * before this call's scan; `false` to reuse whatever is already resident
   * for `handleId` at `generationTag` (the common case: same generation,
   * same lane, a later query). */
  readonly needsRegister: boolean;
  /** Row-major, `ids.length * dimensions` elements, row `i` at
   * `ids[i]` -- REQUIRED to be sorted by `ids` ascending (UTF-8 byte order)
   * for the native tie-break to reproduce `utf8Compare`'s own ordering.
   * Ignored (may be a zero-length placeholder) when `needsRegister` is
   * `false`. */
  readonly buffer: Float32Array;
  readonly dimensions: number;
  /** Index-aligned with the registered buffer's rows. */
  readonly ids: readonly string[];
  readonly query: Float32Array;
  readonly k: number;
  readonly metric: "cosine" | "squared_l2";
}

/**
 * Runs one resident-buffer exact top-k scan, returning `undefined` when no
 * resident port is configured (the caller falls back to `exactVectorScan`).
 * Defensively validates the native result's shape exactly as
 * `nativeExactVectorTopK` (`native-exact-vector.ts`) does for the
 * call-owned port -- a native/JS contract mismatch throws here rather than
 * silently returning a wrong ranking.
 */
export function residentExactVectorScan(request: ResidentExactVectorScanRequest): readonly ExactVectorMatch[] | undefined {
  const port = activeResidentPort;
  if (port === undefined) return undefined;
  if (request.ids.length === 0) return [];
  if (request.needsRegister) port.registerVectorBuffer(request.handleId, request.generationTag, request.dimensions, request.buffer);
  const k = Math.min(request.k, request.ids.length);
  const matches = port.exactTopKContiguous(request.handleId, request.generationTag, request.query, k, request.metric);
  if (matches.length !== k) throw new Error("Resident exact vector top-k returned a malformed result count.");
  const seenIndices = new Set<number>();
  return matches.map((match, order) => {
    if (!Number.isInteger(match.index) || match.index < 0 || match.index >= request.ids.length || seenIndices.has(match.index)) {
      throw new Error("Resident exact vector top-k returned a malformed result.");
    }
    seenIndices.add(match.index);
    return { projection_record_id: request.ids[match.index]!, rank: order + 1 };
  });
}

export function rerankSemanticMatches(candidates: readonly FusedSemanticCandidate[], options: SemanticRerankOptions = {}): readonly SemanticSearchResult[] {
  const defaultWeight: Rational = { numerator: 1n, denominator: 1n };
  const ranked = candidates.map((candidate) => {
    let value: Rational = { numerator: 0n, denominator: 1n };
    for (const [laneId, rank] of Object.entries(candidate.lane_ranks)) {
      if (!Number.isSafeInteger(rank) || rank <= 0) throw new Error("Semantic rerank ranks must be positive integers.");
      const weight = rational(options.lane_weights?.[laneId] ?? defaultWeight);
      value = add(value, { numerator: weight.numerator, denominator: weight.denominator * BigInt(rank) });
    }
    return { candidate, value };
  }).sort((left, right) => compare(right.value, left.value) || left.candidate.projection_record_id.localeCompare(right.candidate.projection_record_id));
  return ranked.map(({ candidate }, index) => ({ projection_record_id: candidate.projection_record_id, rank: index + 1, lane_ranks: candidate.lane_ranks }));
}
