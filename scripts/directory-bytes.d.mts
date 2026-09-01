export function directoryBytes(
  root: string,
  relativePaths: readonly string[],
  statPath?: (path: string) => Promise<{ readonly size: number }>,
): Promise<number>;
