import type { PostMeasurementPlan } from "./post-index-measurement.mjs";

export interface PostExecutionPlan {
  schema_version: number;
  execution: string;
  execute_flag: string;
  no_retries: boolean;
  model: string;
  repositories: PostMeasurementPlan["repositories"];
  sample: number;
  measurement_plan: PostMeasurementPlan;
  command: string[];
  environment: Record<string, string | boolean | number>;
  raw_artifacts: string[];
  comparison: { path: string | null; executed: boolean; sha256?: string };
}

export type CollectedPostRun = any;

export function buildPostExecutionPlan(options?: Record<string, unknown>): PostExecutionPlan;
export function collectPostMeasurements(options: { audit: Record<string, any>; output: string }): { schema_version: number; generated_at: string; rerun_competitors: boolean; runs: any[] };
