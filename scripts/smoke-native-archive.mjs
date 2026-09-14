import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function smokeNativeArchive(archivePath) {
  const archive = resolve(archivePath);
  const root = await mkdtemp(join(tmpdir(), "urdira-native-archive-smoke-"));
  try {
    await execFileAsync("tar", ["-xzf", archive, "-C", root]);
    const release = JSON.parse(await readFile(join(root, "release.json"), "utf8"));
    const windows = release.target === "win32-x64";
    const nativeFiles = (await readdir(join(root, "native"))).sort();
    const expectedNativeFiles = ["manifest.json", windows ? "urdira-indexing-worker.exe" : "urdira-indexing-worker", windows ? "urdira-jsts-syntax-worker.exe" : "urdira-jsts-syntax-worker", "urdira-native.node"].sort();
    if (JSON.stringify(nativeFiles) !== JSON.stringify(expectedNativeFiles)) {
      throw new Error(`Native archive must contain exactly one target closure; found ${nativeFiles.join(", ")}.`);
    }
    const hiddenPath = join(root, "system-node-hidden");
    await mkdir(hiddenPath);
    const launcher = join(root, "bin", windows ? "urdira.exe" : "urdira");
    const environment = {
      ...process.env,
      PATH: hiddenPath,
      Path: hiddenPath,
      URDIRA_DATA_ROOT: join(root, "data"),
    };
    const result = await execFileAsync(launcher, ["--version"], { cwd: root, env: environment, timeout: 30_000 });
    if (result.stdout.trim() !== release.engine_version) {
      throw new Error(`Private runtime returned ${JSON.stringify(result.stdout.trim())}; expected ${release.engine_version}.`);
    }
    const indexingWorker = execFileAsync(join(root, "native", windows ? "urdira-indexing-worker.exe" : "urdira-indexing-worker"), [], { cwd: root, env: environment, timeout: 30_000 });
    indexingWorker.child.stdin?.end();
    await indexingWorker;
    return { archive: basename(archive), target: release.target, version: release.engine_version, native_files: nativeFiles };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const archive = process.argv[2];
  if (archive === undefined) throw new Error("Usage: node scripts/smoke-native-archive.mjs <archive.tar.gz>");
  process.stdout.write(`${JSON.stringify(await smokeNativeArchive(archive), null, 2)}\n`);
}
