export interface N8nIncrementalPreflightOptions {
  readonly corpus: string;
  readonly native_root: string;
  readonly output: string;
  readonly owners?: number;
  readonly mutations?: number;
  readonly readiness_timeout_ms?: number;
}
