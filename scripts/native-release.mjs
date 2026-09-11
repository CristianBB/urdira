import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const NATIVE_TARGETS = Object.freeze({
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64-gnu": "aarch64-unknown-linux-gnu",
  "linux-x64-gnu": "x86_64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
});

export function hostNativeTarget(platform = process.platform, architecture = process.arch) {
  const id = platform === "darwin"
    ? `darwin-${architecture}`
    : platform === "linux"
      ? `linux-${architecture}-gnu`
      : platform === "win32" && architecture === "x64"
        ? "win32-x64"
        : undefined;
  return id !== undefined && Object.hasOwn(NATIVE_TARGETS, id) ? id : undefined;
}

export function nativeArtifactNames(target) {
  if (!Object.hasOwn(NATIVE_TARGETS, target)) throw new Error(`Unsupported native target ${target}.`);
  const windows = target === "win32-x64";
  return Object.freeze({
    addon: "urdira-native.node",
    worker: `urdira-jsts-syntax-worker${windows ? ".exe" : ""}`,
    indexing_core_worker: `urdira-indexing-worker${windows ? ".exe" : ""}`,
    launcher: `urdira${windows ? ".exe" : ""}`,
    node: `node${windows ? ".exe" : ""}`,
  });
}

async function fileDigest(path) {
  return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function nativeBuildId(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(value))).digest("hex")}`;
}

export async function inspectNativeArtifacts(root, target) {
  const names = nativeArtifactNames(target);
  const expected = {
    addon: join(root, names.addon),
    worker: join(root, names.worker),
    launcher: join(root, names.launcher),
    node: join(root, names.node),
  };
  const optional = { indexing_core_worker: join(root, names.indexing_core_worker) };
  const errors = [];
  const digests = {};
  for (const [role, path] of Object.entries(expected)) {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) errors.push(`${role} is not a regular file`);
      else if (info.size === 0) errors.push(`${role} is empty`);
      else digests[role] = await fileDigest(path);
    } catch {
      errors.push(`${role} is missing`);
    }
  }
  try {
    const info = await lstat(optional.indexing_core_worker);
    if (info.isFile() && !info.isSymbolicLink() && info.size > 0) digests.indexing_core_worker = await fileDigest(optional.indexing_core_worker);
  } catch { /* older native closures predate the composition worker */ }
  return { target, rust_target: NATIVE_TARGETS[target], paths: { ...expected, ...optional }, digests, errors };
}

export async function stageNativeArtifacts({ artifactRoot, stageRoot, target }) {
  const inspection = await inspectNativeArtifacts(artifactRoot, target);
  if (inspection.errors.length > 0) throw new Error(`Native artifact closure for ${target} is invalid: ${inspection.errors.join(", ")}`);
  const destinations = {
    addon: join(stageRoot, "native", "urdira-native.node"),
    worker: join(stageRoot, "native", nativeArtifactNames(target).worker),
    launcher: join(stageRoot, "bin", nativeArtifactNames(target).launcher),
    node: join(stageRoot, "runtime", nativeArtifactNames(target).node),
  };
  for (const role of Object.keys(destinations)) {
    if (role === "indexing_core_worker" && inspection.digests.indexing_core_worker === undefined) continue;
    await mkdir(dirname(destinations[role]), { recursive: true });
    await copyFile(inspection.paths[role], destinations[role]);
    if (role !== "addon") await chmod(destinations[role], 0o755);
  }
  if (inspection.digests.indexing_core_worker !== undefined) {
    const destination = join(stageRoot, "native", nativeArtifactNames(target).indexing_core_worker);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(inspection.paths.indexing_core_worker, destination);
    await chmod(destination, 0o755);
  }
  const nativeIdentity = {
    schema_version: 1,
    target,
    rust_target: inspection.rust_target,
    // Must track NATIVE_API_VERSION in packages/native/src/loader.ts (and
    // crates/urdira-native-node/src/lib.rs) by hand: this script is plain
    // JS run outside the TS build, so it can't import that constant. S-I
    // bumped it 17 -> 18 (native selector pages and indexed semantic counts) and this literal was left behind, so every
    // freshly staged offline manifest still declared API 16 while the
    // staged addon itself reported 18 -- "Offline Urdira native manifest
    // API mismatch" in tests/v3-external-module-record-id-collision.test.ts
    // and tests/v4-mutation-harness.test.ts.
    binding_api: 18,
    node_api: 10,
    worker_protocol: "urdira.ipc.v2",
    files: {
      addon: { path: "native/urdira-native.node", digest: inspection.digests.addon },
      worker: { path: `native/${nativeArtifactNames(target).worker}`, digest: inspection.digests.worker },
    },
  };
  const manifest = {
    native_manifest_version: 1,
    target,
    rust_target: inspection.rust_target,
    binding_api: nativeIdentity.binding_api,
    node_api: 10,
    worker_protocol: "urdira.ipc.v2",
    build_id: nativeBuildId(nativeIdentity),
    files: {
      addon: { path: "native/urdira-native.node", digest: inspection.digests.addon },
      worker: { path: `native/${nativeArtifactNames(target).worker}`, digest: inspection.digests.worker },
      launcher: { path: `bin/${nativeArtifactNames(target).launcher}`, digest: inspection.digests.launcher },
      node: { path: `runtime/${nativeArtifactNames(target).node}`, digest: inspection.digests.node },
    },
  };
  await writeFile(join(stageRoot, "native", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
