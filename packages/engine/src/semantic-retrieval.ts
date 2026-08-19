import { canonicalVectorBytes } from "./semantic-runtime.js";

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

function distance(left: readonly number[], right: readonly number[], metric: ExactVectorScanOptions["distance_metric"]): number {
  if (metric === "squared_l2") return left.reduce((sum, value, index) => sum + ((value - (right[index] ?? 0)) ** 2), 0);
  const leftNorm = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0));
  const rightNorm = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0));
  if (leftNorm === 0 || rightNorm === 0) throw new Error("Cosine semantic scan does not accept zero vectors.");
  return 1 - left.reduce((sum, value, index) => sum + (value * (right[index] ?? 0)), 0) / (leftNorm * rightNorm);
}

export function exactVectorScan(candidates: readonly ExactVectorCandidate[], query: readonly number[] | Uint8Array, options: ExactVectorScanOptions): readonly ExactVectorMatch[] {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) throw new Error("Exact semantic scan limit must be positive.");
  const elementType = options.element_type ?? "float32";
  const configuration = { dimensions: options.dimensions, element_type: elementType, normalization: options.normalization ?? "none" } as const;
  const queryValues = values(canonicalVectorBytes(query, configuration), options.dimensions, elementType);
  const ranked = candidates
    .filter((candidate) => candidate.profile_id === options.profile_id && candidate.executable_binding_id === options.executable_binding_id && matchesFilter(candidate.metadata, options.filter))
    .map((candidate) => ({ id: candidate.projection_record_id, distance: distance(values(canonicalVectorBytes(candidate.vector, configuration), options.dimensions, elementType), queryValues, options.distance_metric) }))
    .sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id));
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
