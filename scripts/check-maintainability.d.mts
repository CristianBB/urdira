export interface MaintainabilitySummary {
  counts: Record<string, number>;
  byFile: Record<string, Record<string, number>>;
}

export interface MaintainabilityBaseline {
  version?: number;
  rules: Record<string, number>;
  files: Record<string, Record<string, number>>;
  exclusions?: string[];
}

export function collectSourceFiles(repositoryRoot: string): Promise<string[]>;
export function loadMaintainabilityBaseline(repositoryRoot: string): Promise<MaintainabilityBaseline>;
export function summarizeLintResults(results: Array<{ filePath: string; messages: Array<{ ruleId?: string | null }> }>, repositoryRoot: string): MaintainabilitySummary;
export function checkMaintainability(summary: MaintainabilitySummary, baseline: MaintainabilityBaseline): string[];
export function runMaintainabilityCheck(repositoryRoot: string): Promise<{
  files: string[];
  summary: MaintainabilitySummary;
  baseline: MaintainabilityBaseline;
  errors: string[];
}>;
