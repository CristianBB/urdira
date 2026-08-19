export const RELEASE_GATES: readonly string[];
export function runBenchmark(rootDir?: string): Promise<Record<string, unknown>>;
export function writeReleaseReport(report: Record<string, unknown>, path: string): Promise<Record<string, unknown>>;
export function runReleaseSuite(options?: { rootDir?: string; outputDir?: string; reportPath?: string; skipInstall?: boolean }): Promise<Record<string, unknown>>;
