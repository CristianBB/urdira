export const DEFAULT_RELEASE_COMPONENTS: Readonly<Record<string, string>>;

export interface ReleaseFileBinding {
  readonly path: string;
  readonly realpath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly relative_path?: string;
}

export interface ReleaseBinding {
  readonly schema_version: 1;
  readonly status: "passed";
  readonly archive: ReleaseFileBinding;
  readonly extracted_root: string;
  readonly components: Record<string, ReleaseFileBinding> & { readonly launcher: ReleaseFileBinding };
}

export function assertReleaseBinding(options: {
  archiveRoot: string;
  archivePath: string;
  components?: Readonly<Record<string, string>>;
}): ReleaseBinding;
