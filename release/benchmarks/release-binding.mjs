import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

export const DEFAULT_RELEASE_COMPONENTS = Object.freeze({
  cli: "dist/index.js",
  mcp: "node_modules/@urdira/mcp/dist/index.js",
  app: "app/dist/index.js",
  plugin: "node_modules/@urdira/plugin-javascript-typescript/dist/index.js",
  hooks: "node_modules/@urdira/cli/dist/agent-integration.js",
  native_addon: "native/urdira-native.node",
  indexing_worker: "native/urdira-indexing-worker",
  syntax_worker: "native/urdira-jsts-syntax-worker",
  native_manifest: "native/manifest.json",
  launcher_binary: "bin/urdira",
  launcher: "bin/urdira.mjs",
  release_manifest: "release.json",
  checksums: "checksums.sha256",
});

const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const describeFile = (path) => {
  const info = statSync(path);
  return { path: resolve(path), realpath: realpathSync(path), bytes: info.size, sha256: digest(path) };
};

function tarEntries(archivePath) {
  let bytes;
  try { bytes = gunzipSync(readFileSync(archivePath)); }
  catch (error) { throw new Error(`Release archive is not a readable gzip tar: ${error instanceof Error ? error.message : String(error)}`); }
  const entries = new Map();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      zeroBlocks += 1; offset += 512;
      if (zeroBlocks === 2) break;
      continue;
    }
    zeroBlocks = 0;
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/u, "").trim();
    const name = field(0, 100); const prefix = field(345, 155); const path = prefix.length > 0 ? `${prefix}/${name}` : name;
    const size = Number.parseInt(field(124, 12), 8); const type = header[156];
    if (path.length === 0 || !Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.byteLength) throw new Error(`Release archive has an invalid tar entry at offset ${offset}`);
    if (type !== 0 && type !== 48) throw new Error(`Release archive contains a non-regular component ${path}`);
    if (entries.has(path)) throw new Error(`Release archive contains duplicate component ${path}`);
    entries.set(path, globalThis.Buffer.from(bytes.subarray(offset + 512, offset + 512 + size)));
    offset += 512 + size + ((512 - (size % 512)) % 512);
  }
  if (zeroBlocks < 2) throw new Error("Release archive is missing its two-block tar terminator");
  return entries;
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`Missing archive component ${label}: ${path}`);
  const info = statSync(path);
  if (!info.isFile()) throw new Error(`Archive component is not a regular file ${label}: ${path}`);
  return info;
}

function contained(root, candidate, label) {
  const rootRealpath = realpathSync(root);
  const candidateRealpath = realpathSync(candidate);
  const suffix = relative(rootRealpath, candidateRealpath);
  if (suffix === "" || suffix.startsWith(`..${sep}`) || suffix === ".." || suffix.startsWith(sep)) throw new Error(`Archive component escapes extracted root ${label}: ${candidate}`);
  return candidateRealpath;
}

/**
 * Bind the measured benchmark to the exact archive bytes and extracted files.
 * Missing, malformed, or escaping members throw so callers cannot continue
 * with a source checkout while claiming an installed release measurement.
 */
export function assertReleaseBinding({ archiveRoot, archivePath, components = DEFAULT_RELEASE_COMPONENTS }) {
  if (typeof archiveRoot !== "string" || archiveRoot.length === 0 || !existsSync(archiveRoot)) throw new Error(`Release archive root is unavailable: ${archiveRoot ?? "null"}`);
  if (typeof archivePath !== "string" || archivePath.length === 0) throw new Error("Release archive bytes path is required");
  if (!existsSync(archivePath)) throw new Error(`Release archive bytes are unavailable: ${archivePath}`);
  if (!statSync(archivePath).isFile()) throw new Error(`Release archive bytes path is not a regular file: ${archivePath}`);
  if (components === null || typeof components !== "object" || Array.isArray(components)) throw new Error("Release archive components must be an object");
  const rootRealpath = realpathSync(archiveRoot);
  const archive = describeFile(archivePath);
  const archiveEntries = tarEntries(archivePath);
  const boundComponents = {};
  for (const [label, relativePath] of Object.entries(components)) {
    if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.includes("\0") || relativePath.startsWith("/") || relativePath.startsWith("\\")) throw new Error(`Invalid archive component path ${label}`);
    const candidate = join(rootRealpath, relativePath);
    requireFile(candidate, label);
    const candidateRealpath = contained(rootRealpath, candidate, label);
    const archiveBytes = archiveEntries.get(relativePath);
    if (archiveBytes === undefined) throw new Error(`Missing archive component ${label} in archive bytes: ${relativePath}`);
    const extractedBytes = readFileSync(candidateRealpath);
    if (!globalThis.Buffer.from(extractedBytes).equals(archiveBytes)) throw new Error(`Archive component bytes do not match extracted root for ${label}: ${relativePath}`);
    boundComponents[label] = describeFile(candidateRealpath);
    boundComponents[label].relative_path = relativePath;
  }
  return { schema_version: 1, status: "passed", archive, extracted_root: rootRealpath, components: boundComponents };
}
