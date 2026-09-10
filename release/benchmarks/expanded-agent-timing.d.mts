export interface TimingLine {
  readonly line: number;
  readonly event_type: string | null;
  readonly item_id: string | null;
  readonly item_type: string | null;
  readonly received_monotonic_ms: number;
  readonly turn: number;
}

export interface TimingCall {
  readonly item_id: string;
  readonly kind: string | null;
  readonly server: string | null | undefined;
  readonly tool: string | null | undefined;
  readonly command: string | null | undefined;
  readonly status: string | null | undefined;
  readonly exit_code: number | null | undefined;
  readonly turn: number;
  readonly completed_turn: number | null;
  readonly started_monotonic_ms: number | null;
  readonly completed_monotonic_ms: number | null;
  readonly duration_ms: number | null;
  readonly pairing_status: "paired" | "completed_without_start" | "started_without_completion";
  readonly duplicate_starts: number;
}

export interface TimingCapture {
  readonly schema_version: 1;
  readonly label: string;
  readonly line_count: number;
  readonly malformed_lines: number;
  readonly lines: readonly TimingLine[];
  readonly calls: readonly TimingCall[];
}

export interface TimingAggregate {
  readonly calls: number;
  readonly paired_calls: number;
  readonly completed_calls: number;
  readonly failed_calls: number;
  readonly total_duration_ms: number | null;
  readonly mean_duration_ms: number | null;
  readonly p50_duration_ms: number | null;
  readonly p95_duration_ms: number | null;
}

export interface TimingSummary {
  readonly schema_version: 1;
  readonly clock: "process.hrtime.bigint";
  readonly turns: readonly TimingCapture[];
  readonly mcp_calls: readonly TimingCall[];
  readonly command_calls: readonly TimingCall[];
  readonly aggregates: {
    readonly mcp_by_tool: TimingAggregateMap;
    readonly commands_by_command: TimingAggregateMap;
  };
}

export interface TimingAggregateMap {
  readonly [group: string]: TimingAggregate | undefined;
  readonly urdira_query: TimingAggregate | undefined;
  readonly lookup: TimingAggregate | undefined;
}

export interface TimingCaptureOptions {
  readonly clock?: () => bigint | number;
  readonly label?: string;
}

export interface TimingCaptureObserver {
  ingest(chunk: string | Uint8Array): void;
  finish(): TimingCapture;
}

export function createTimingCapture(options?: TimingCaptureOptions): TimingCaptureObserver;
export function summarizeTimingCaptures(captures: readonly TimingCapture[]): TimingSummary;
