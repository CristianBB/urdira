export type ArchitecturePackage = {
  name: string;
  path: string;
  layer: number;
  dependencies: string[];
  responsibilities?: string[];
};

export type ArchitectureManifest = {
  version: number;
  packages: ArchitecturePackage[];
  coverage?: Array<{ area: string; owner: string }>;
};

export type ArchitectureCheckResult = {
  errors: string[];
  checkedPackages: string[];
};

export declare function normalizeArchitecturePath(path: string): string;

export declare function loadArchitectureManifest(
  repositoryRoot: string,
): Promise<ArchitectureManifest>;

export declare function checkArchitecture(
  repositoryRoot: string,
  manifest: unknown,
): Promise<ArchitectureCheckResult>;
