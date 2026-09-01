export type ExactVectorLane = "oracle" | "native";

export interface ExactVectorRequest {
  readonly query: Uint8Array;
  readonly candidates: Uint8Array;
  readonly projectionRecordIds: readonly string[];
  readonly dimensions: number;
  readonly elementType: "float32_le" | "float64_le";
  readonly k: number;
  readonly metric: "squared_l2" | "cosine";
}

export interface ExactVectorMatch {
  projection_record_id: string;
  rank: number;
}

export interface ExactVectorLaneSample {
  kernel_ms: number;
  end_to_end_ms: number;
  peak_rss_bytes: number;
  rss_before_bytes: number;
  rss_after_bytes: number;
  evaluated_candidates?: number;
  input_digest: string;
  result_digest: string;
  matches: ExactVectorMatch[];
}

export interface ExactVectorTopKDecision {
  readonly status: "activate" | "do_not_activate";
  readonly errors: readonly string[];
  readonly checks: {
    readonly evidence_checksum: boolean;
    readonly qualifying_scales: boolean;
    readonly sufficient_samples: boolean;
    readonly exact_ordered_equivalence: boolean;
    readonly deterministic_tie_breaking: boolean;
    readonly real_napi_addon: boolean;
    readonly real_query_attribution: boolean;
    readonly target_scale_kernel_gain: boolean;
    readonly large_end_to_end_improvement: boolean;
    readonly small_end_to_end_regression: boolean;
  };
  readonly metrics: Readonly<Record<string, unknown>>;
}

export interface ExactVectorTopKReport<TEvidence = unknown> {
  readonly schema_version: 1;
  evidence: TEvidence;
  readonly evidence_checksum: string;
  readonly decision: ExactVectorTopKDecision;
}

export interface UnitTestSeam {
  runSample(context: {
    readonly lane: ExactVectorLane;
    readonly workload: { readonly label: "small" | "large"; readonly candidateCount: number; readonly seed: number };
    readonly sampleIndex: number;
  }): Promise<ExactVectorLaneSample> | ExactVectorLaneSample;
  runTieCase(context: {
    readonly metric: "squared_l2" | "cosine";
    readonly request: ExactVectorRequest;
    readonly oracleMatches: readonly ExactVectorMatch[];
  }): Promise<readonly ExactVectorMatch[]> | readonly ExactVectorMatch[];
}

export interface ExactVectorTopKNativeBinding {
  nativeApiVersion(): number;
  nativeTargetTriple(): string;
  exactVectorTopKBatch(requests: readonly ExactVectorRequest[]): readonly (readonly ExactVectorMatch[])[];
}

export function exactVectorTopKOracle(request: ExactVectorRequest): readonly ExactVectorMatch[];
export function parseExactVectorTopKWorkerArguments(argv: readonly string[]): { readonly lane: ExactVectorLane; readonly label: string | undefined; readonly candidateCount: number; readonly seed: number; readonly addonPath: string | undefined };
export function runExactVectorTopKOracleSample(configuration: { readonly label: string; readonly candidateCount: number; readonly seed: number }): ExactVectorLaneSample & { readonly lane: "oracle" };
export function validateExactVectorTopKNativeBinding(binding: unknown): { readonly binding: ExactVectorTopKNativeBinding; readonly nativeApiVersion: number; readonly nativeTargetTriple: string };
export function evaluateExactVectorTopKGate(report: unknown): ExactVectorTopKDecision;
export function createExactVectorTopKReport<TEvidence>(evidence: TEvidence): ExactVectorTopKReport<TEvidence>;
export function runExactVectorTopKBenchmark(options: {
  readonly executionMode: "real_napi";
  readonly addonPath: string;
  readonly attributionPath?: string;
  readonly outputPath: string;
  readonly sampleCount?: number;
} | {
  readonly executionMode: "unit_test_seam";
  readonly outputPath: string;
  readonly sampleCount: number;
  readonly workloads: readonly [
    { readonly label: "small"; readonly candidateCount: number; readonly seed: number },
    { readonly label: "large"; readonly candidateCount: number; readonly seed: number },
  ];
  readonly unitTestSeam: UnitTestSeam;
  readonly attributionEvidence?: unknown;
}): Promise<ExactVectorTopKReport<Record<string, unknown>>>;
