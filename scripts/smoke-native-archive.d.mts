export function smokeNativeArchive(archivePath: string): Promise<{
  archive: string;
  target: string;
  version: string;
  native_files: string[];
}>;
