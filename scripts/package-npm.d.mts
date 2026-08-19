export interface PublishManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly license: string;
  readonly private?: boolean;
  readonly engines: { readonly node: string };
  readonly publishConfig: { readonly access: string };
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

export const REPOSITORY_URL: string;
export const ROOT: string;
export function productionPackageVersions(): Promise<Map<string, string>>;
export function createPublishManifest(source: Record<string, unknown>, versions: ReadonlyMap<string, string>): PublishManifest;
export function validatePublishManifest(manifest: PublishManifest, versions: ReadonlyMap<string, string>): string[];
export function publicationOrder(packages: readonly { readonly name: string; readonly manifest: PublishManifest }[]): string[];
export function buildNpmPackages(options?: { readonly outputRoot?: string; readonly build?: boolean }): Promise<unknown>;
export function smokeInstallNpmPackages(packages: readonly unknown[]): Promise<{ readonly version: string; readonly help: true }>;
