export interface NativeAccelerationGateEvidence {
  readonly report_bytes: Uint8Array;
  readonly report_checksum: string;
  readonly artifacts: Readonly<Record<string, Uint8Array>>;
}

export interface NativeAccelerationMetricSummary {
  readonly baseline_p50: number | undefined;
  readonly candidate_p50: number | undefined;
  readonly p50_improvement: number | undefined;
  readonly baseline_p95: number | undefined;
  readonly candidate_p95: number | undefined;
  readonly p95_improvement: number | undefined;
}

export interface NativeAccelerationTargetGateResult {
  readonly campaigns: number;
  readonly cold: NativeAccelerationMetricSummary;
  readonly incremental: NativeAccelerationMetricSummary;
  readonly rss: NativeAccelerationMetricSummary;
}

export interface NativeAccelerationGateResult {
  readonly status: "passed" | "failed";
  readonly errors: readonly string[];
  readonly targets: Readonly<Record<string, NativeAccelerationTargetGateResult>>;
}

export function evaluateNativeAccelerationGate(
  report: unknown,
  evidence?: NativeAccelerationGateEvidence,
): NativeAccelerationGateResult;

export function evaluateNativeAccelerationGateFile(reportPath: string): Promise<NativeAccelerationGateResult>;
