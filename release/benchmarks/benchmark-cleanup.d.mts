export const DEFINITIVE_MINIMUM_FREE_BYTES: number;

export interface CleanupProcessEntry {
  readonly pid?: number;
  readonly [key: string]: unknown;
}

export interface CleanupSnapshot {
  readonly paths: Record<string, { exists: boolean; bytes: number | null }>;
  readonly filesystem: { free_bytes: number | null; df_raw: string | null; [key: string]: unknown };
  readonly owned_processes: readonly CleanupProcessEntry[];
  readonly errors: readonly string[];
}

export interface CleanupCheckpointResult {
  readonly status: "passed" | "blocked";
  readonly blockers: readonly string[];
  readonly minimum_free_bytes: number | null;
  readonly before: CleanupSnapshot;
  readonly after: CleanupSnapshot;
  readonly [key: string]: unknown;
}

export function parseMinimumFreeBytes(value: unknown): number | null;
export function assertCleanupGateOpen(path: string): void;
export function measurePath(path: string, errors: string[]): number | null;
export function runCleanupCheckpoint(options: {
  manifestPath: string;
  registeredPaths: readonly string[];
  filesystemPath: string;
  minimumFreeBytes?: number | string | null;
  cleanup: () => Promise<unknown>;
  listOwnedProcesses: () => readonly CleanupProcessEntry[];
  metadata?: Record<string, unknown>;
}): Promise<CleanupCheckpointResult>;
