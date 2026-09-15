export const DEFINITIVE_ARMS: readonly string[];
export const DEFINITIVE_CELLS: readonly (readonly [string, string])[];
export const DEFINITIVE_READINESS_PHASES: readonly string[];

export interface DefinitiveCell {
  readonly run_id: string;
  readonly campaign: number;
  readonly repository_id: string;
  readonly task_id: string;
  readonly arm: string;
  readonly commit: string;
  readonly prompt_sha256: string;
  readonly phase: string;
  readonly worktree: string;
  readonly data_root: string;
  readonly output_root: string;
  [key: string]: unknown;
}

export interface DefinitiveCellManifest {
  readonly cells: readonly DefinitiveCell[];
  readonly expected_runs: number;
  readonly failure_policy: string;
  [key: string]: unknown;
}

export interface DefinitiveReadinessProbe {
  readonly probe_id: string;
  readonly campaign: number;
  readonly repository_id: string;
  readonly task_id: string;
  readonly phase: string;
  readonly commit: string;
  readonly prompt_sha256: string;
  readonly model_invoked: false;
  readonly passed: boolean | null;
  readonly failure: string | null;
  readonly timestamps: Record<string, number | null>;
  readonly [key: string]: unknown;
}

export interface DefinitiveReadinessManifest {
  readonly probes: readonly DefinitiveReadinessProbe[];
  readonly readiness_expected_probes: number;
  release_binding?: unknown;
  [key: string]: unknown;
}

export function buildCellManifest(options: Record<string, unknown>): DefinitiveCellManifest;
export function buildReadinessManifest(options: Record<string, unknown>): DefinitiveReadinessManifest;
export function retainableCellFailure(result: { readonly code?: number; readonly capture_error?: string | null } | null, manifest: Record<string, unknown> | null): boolean;
export function runCommand(command: string, args: readonly string[], options?: Record<string, unknown>): Promise<{
  readonly code: number;
  readonly timed_out: boolean;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdout_path?: string | null;
  readonly stdout_bytes?: number | null;
  readonly stdout_sha256?: string | null;
  readonly stderr_path?: string | null;
  readonly stderr_bytes?: number | null;
  readonly stderr_sha256?: string | null;
  readonly capture_error?: string | null;
}>;
export function runDefinitiveCells(options: Record<string, unknown>): Promise<{ readonly runs: readonly Record<string, unknown>[]; readonly [key: string]: unknown }>;
export function effectiveProcessOwner(table: readonly Record<string, unknown>[], currentPid?: number, fallback?: string): string;
export function isProcessInventoryProbe(command: unknown): boolean;
export function stopOwnedProcesses(roots: readonly string[], adapters?: Record<string, unknown>): Promise<{ stopped_processes: readonly Record<string, unknown>[]; unverified_processes: readonly Record<string, unknown>[] }>;
