import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { promisify } from "node:util";
import { NATIVE_TARGETS, hostNativeTarget, nativeArtifactNames } from "./native-release.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function nativeLibraryName(target) {
  if (target.startsWith("darwin-")) return "liburdira_native_node.dylib";
  if (target.startsWith("linux-")) return "liburdira_native_node.so";
  return "urdira_native_node.dll";
}

export async function buildNativeArtifacts({ target = hostNativeTarget(), rootDir = ROOT, nodePath = process.execPath } = {}) {
  if (target === undefined) throw new Error(`Unsupported native build host ${process.platform}/${process.arch}.`);
  const rustTarget = NATIVE_TARGETS[target];
  const names = nativeArtifactNames(target);
  const cargoArgs = ["build", "--release", "--locked", "--target", rustTarget, "-p", "urdira-native-node", "-p", "urdira-jsts-syntax-worker", "-p", "urdira-indexing-core", "-p", "urdira-jsts-indexing-engine", "-p", "urdira-indexing-worker", "-p", "urdira-launcher"];
  const env = { ...process.env };
  if (target === "win32-x64") env.RUSTFLAGS = `${env.RUSTFLAGS ?? ""} -C target-feature=+crt-static`.trim();
  await execFileAsync("cargo", cargoArgs, { cwd: rootDir, env, maxBuffer: 16 * 1024 * 1024 });
  const output = join(rootDir, "release", "native", target);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const release = join(rootDir, "target", rustTarget, "release");
  const sources = {
    addon: join(release, nativeLibraryName(target)),
    worker: join(release, names.worker),
    indexing_core_worker: join(release, names.indexing_core_worker),
    launcher: join(release, target === "win32-x64" ? "urdira-launcher.exe" : "urdira-launcher"),
    node: nodePath,
  };
  const destinations = {
    addon: join(output, names.addon),
    worker: join(output, names.worker),
    indexing_core_worker: join(output, names.indexing_core_worker),
    launcher: join(output, names.launcher),
    node: join(output, names.node),
  };
  for (const role of Object.keys(destinations)) {
    if (role === "indexing_core_worker" && !(await stat(sources[role]).catch(() => undefined))) continue;
    await copyFile(sources[role], destinations[role]);
    if (role !== "addon") await chmod(destinations[role], 0o755);
  }
  const npmPrebuildDirectory = join(rootDir, "packages", "native", "prebuilds", rustTarget);
  await mkdir(npmPrebuildDirectory, { recursive: true });
  await copyFile(sources.addon, join(npmPrebuildDirectory, names.addon));
  await copyFile(sources.worker, join(npmPrebuildDirectory, names.worker));
  if (await stat(sources.indexing_core_worker).catch(() => undefined)) {
    await copyFile(sources.indexing_core_worker, join(npmPrebuildDirectory, names.indexing_core_worker));
    await chmod(join(npmPrebuildDirectory, names.indexing_core_worker), 0o755);
  }
  await chmod(join(npmPrebuildDirectory, names.worker), 0o755);
  return {
    target,
    rust_target: rustTarget,
    output,
    npm_prebuild_directory: npmPrebuildDirectory,
    files: Object.fromEntries(Object.entries(destinations).map(([role, path]) => [role, basename(path)])),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await buildNativeArtifacts({ target: process.env.URDIRA_RELEASE_TARGET ?? hostNativeTarget() });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
