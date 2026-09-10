export interface ProcessTreeSnapshot {
  readonly rss_kib: number;
  readonly cpu_percent: number;
  readonly process_count: number;
}

export function sampleProcessTree(rootPid: number): ProcessTreeSnapshot | null;
