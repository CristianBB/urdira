export const WORKER_STARTUP_ATTESTATION_PREFIX: "[urdira-indexing-worker] v4 startup_attestation ";

export interface WorkerStartupAttestation {
  readonly schema_version: 1;
  readonly pid: number;
  readonly current_exe: string | null;
  readonly debug_timing_enabled: boolean;
  readonly semantic_perf_enabled: boolean;
}

export function parseWorkerStartupAttestation(line: unknown): WorkerStartupAttestation | null;
export function findWorkerStartupAttestation(text: unknown): WorkerStartupAttestation | null;
