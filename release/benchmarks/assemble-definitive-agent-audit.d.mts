export interface DefinitiveAudit {
  readonly definitive_protocol: "selected-45";
  readonly expected_runs: 45;
  readonly readiness_expected_probes: 18;
  readonly runs: readonly Record<string, unknown>[];
  readonly readiness_probes: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

export function assembleDefinitiveAudit(options: {
  campaignAuditPaths: readonly string[];
  readinessManifestPaths: readonly string[];
  outputPath: string;
}): DefinitiveAudit;
