export interface BenchmarkProcessEntry {
  pid: number;
  ppid: number;
  pgid: number;
  user: string;
  command: string;
}

export interface InspectedBenchmarkProcessEntry extends BenchmarkProcessEntry {
  owner_verified: boolean;
  parent_chain_verified: boolean;
  owned_by_cell: boolean;
}

export declare function isProcessInventoryProbe(command: unknown): boolean;
export declare function parseProcessTable(output: string): BenchmarkProcessEntry[];
export declare function processTable(): BenchmarkProcessEntry[];
export declare function effectiveProcessOwner(table: BenchmarkProcessEntry[], currentPid?: number, fallback?: string): string;
export declare function inspectProcessInventory(roots: string[], table?: BenchmarkProcessEntry[], options?: { currentPid?: number; fallbackUser?: string }): InspectedBenchmarkProcessEntry[];
export declare function verifiedOwnedProcesses(entries: InspectedBenchmarkProcessEntry[]): InspectedBenchmarkProcessEntry[];
