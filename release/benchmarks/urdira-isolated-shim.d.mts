export interface UrdiraIsolatedShimOptions {
  node: string;
  cli: string;
  dataRoot: string;
  worker: string;
  endpoint: string;
}

export function writeUrdiraIsolatedShim(path: string, options: UrdiraIsolatedShimOptions): string;
