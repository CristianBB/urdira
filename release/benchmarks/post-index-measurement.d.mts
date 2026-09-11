export interface MeasurementRepository {
  id: string;
  repository: string;
  commit: string;
}

export interface MeasurementOperation {
  operation: string;
  variants?: string[];
  paginated?: boolean;
  caps_and_completeness?: boolean;
  latency?: boolean;
}

export interface PostMeasurementPlan {
  schema_version: number;
  sample: number;
  repositories: MeasurementRepository[];
  environment: Record<string, unknown>;
  operations: MeasurementOperation[];
  accounting: Record<string, unknown>;
}

export function compactTextObject(text: string): Record<string, unknown>;
export function operationOf(item: unknown): string | null;
export function resultObject(item: unknown): Record<string, unknown>;
export function buildPostMeasurementPlan(options?: { corpus?: unknown; repositoryIds?: string[]; sample?: number }): PostMeasurementPlan;
export function analyzePostMeasurement(options?: { events?: unknown[]; plan?: PostMeasurementPlan; hostMetrics?: Record<string, unknown> | null }): any;
export function mergePostMeasurements(report: Record<string, unknown>, postReport: Record<string, unknown>): any;
