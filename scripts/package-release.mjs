/* c8 ignore file */
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { chmod, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORBIDDEN_PRODUCTION_PATTERNS,
  PRODUCTION_PACKAGE_NAMES,
  SUPPORTED_TARGETS,
  buildReleaseMetadata,
  readReleaseConfig,
  sha256,
  validateReleaseConfig,
} from "./release-contract.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const packagePath = (name) => name === "urdira"
  ? join("apps", "bootstrap")
  : name === "@urdira/runtime"
    ? join("apps", "urdira")
    : join("packages", name.replace(/^@[^/]+\//u, ""));
const packageNodePath = (name) => name.startsWith("@") ? join("node_modules", ...name.split("/")) : join("node_modules", name);
const unix = (value) => value.split(sep).join("/");
const compareNames = (left, right) => left < right ? -1 : left > right ? 1 : 0;

async function exists(path) { try { await lstat(path); return true; } catch { return false; } }

async function copyDereferenced(source, destination) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) return copyDereferenced(await realpath(source), destination);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) await copyDereferenced(join(source, entry), join(destination, entry));
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { dereference: true, force: true });
}

async function copyBuildPayload(source, destination) {
  const info = await lstat(source);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) {
      if (entry === "tsconfig.tsbuildinfo") continue;
      await copyBuildPayload(join(source, entry), join(destination, entry));
    }
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { dereference: true, force: true });
}

async function realpath(path) {
  const { realpath: resolveRealpath } = await import("node:fs/promises");
  return resolveRealpath(path);
}

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function writeJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
const DEVELOPMENT_DIRECTORY_NAMES = new Set(["test", "tests", "__tests__", "src", "example", "examples", "benchmark", "benchmarks"]);
const DEVELOPMENT_FILE_NAMES = new Set(["tsconfig.json", "tsconfig.tsbuildinfo"]);

async function copyDependencyPayload(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === "node_modules" || DEVELOPMENT_DIRECTORY_NAMES.has(entry.name.toLowerCase()) || DEVELOPMENT_FILE_NAMES.has(entry.name.toLowerCase())) continue;
    if (entry.isFile() && (/\.ts$/u.test(entry.name) || entry.name.endsWith(".test.js"))) continue;
    await copyDereferenced(join(source, entry.name), join(destination, entry.name));
  }
}

function internalPackage(name) { return PRODUCTION_PACKAGE_NAMES.includes(name); }

async function resolveExternalPackage(name, fromDir, rootDir) {
  let current = fromDir;
  while (true) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    if (await exists(join(candidate, "package.json"))) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const rootCandidate = join(rootDir, "node_modules", ...name.split("/"));
  if (await exists(join(rootCandidate, "package.json"))) return rootCandidate;
  const virtualStore = join(rootDir, "node_modules", ".pnpm");
  if (await exists(virtualStore)) {
    for (const entry of await readdir(virtualStore)) {
      const candidate = join(virtualStore, entry, "node_modules", ...name.split("/"));
      if (await exists(join(candidate, "package.json"))) return candidate;
    }
  }
  throw new Error(`Production dependency ${name} cannot be resolved from ${fromDir}.`);
}

function targetOptionalDependency(name, target) {
  // Native packages publish one optional coordinate per runtime platform. A
  // release archive is target-specific, so traversing every optional entry
  // makes packaging fail on hosts that intentionally do not install foreign
  // platform packages (for example sharp's linux-arm coordinate on macOS).
  // Keep non-native optional dependencies unchanged and retain only the
  // coordinate selected by the release target for @img/* packages.
  if (!name.startsWith("@img/")) return true;
  const platform = target.os === "linux"
    ? `linux${target.libc === "musl" ? "musl" : ""}-${target.architecture}`
    : `${target.os}-${target.architecture}`;
  return name.includes(`-${platform}`);
}

async function stageExternalDependency(name, fromDir, rootDir, stageRoot, copied, targetWatcher, target) {
  if (internalPackage(name)) return;
  if (copied.has(name)) return;
  const source = await resolveExternalPackage(name, fromDir, rootDir);
  const manifest = await readJson(join(source, "package.json"));
  copied.add(name);
  const destination = join(stageRoot, packageNodePath(name));
  await mkdir(destination, { recursive: true });
  await copyDependencyPayload(source, destination);
  const rewritten = { ...manifest };
  for (const section of ["dependencies", "optionalDependencies"]) {
    if (!rewritten[section]) continue;
    const next = {};
    for (const dependency of Object.keys(rewritten[section]).sort()) {
      if (section === "optionalDependencies" && !targetOptionalDependency(dependency, target)) continue;
      if (name === "typescript" && section === "optionalDependencies" && dependency.startsWith("@typescript/typescript-")) continue;
      if (name === "@parcel/watcher" && section === "optionalDependencies" && dependency !== targetWatcher.package_name) continue;
      const dependencyRoot = await resolveExternalPackage(dependency, source, rootDir);
      const dependencyManifest = await readJson(join(dependencyRoot, "package.json"));
      next[dependency] = dependencyManifest.version;
      await stageExternalDependency(dependency, source, rootDir, stageRoot, copied, targetWatcher, target);
    }
    rewritten[section] = next;
  }
  for (const section of ["peerDependencies", "devDependencies"]) if (rewritten[section]) delete rewritten[section];
  await writeJson(join(destination, "package.json"), rewritten);
}

async function stageProductionPackage(name, rootDir, stageRoot, copied, targetWatcher, target) {
  const source = join(rootDir, packagePath(name));
  const manifest = await readJson(join(source, "package.json"));
  const dist = join(source, "dist");
  if (!(await exists(dist))) throw new Error(`Missing production build for ${name}: ${dist}`);
  const destination = join(stageRoot, packageNodePath(name));
  await mkdir(destination, { recursive: true });
  await copyBuildPayload(dist, join(destination, "dist"));
  const rewritten = { ...manifest, private: false, dependencies: { ...(manifest.dependencies ?? {}) } };
  for (const dependency of Object.keys(rewritten.dependencies)) {
    if (internalPackage(dependency)) {
      const dependencyManifest = await readJson(join(rootDir, packagePath(dependency), "package.json"));
      rewritten.dependencies[dependency] = dependencyManifest.version;
    }
    else {
      const dependencyRoot = await resolveExternalPackage(dependency, source, rootDir);
      const dependencyManifest = await readJson(join(dependencyRoot, "package.json"));
      rewritten.dependencies[dependency] = dependencyManifest.version;
      await stageExternalDependency(dependency, source, rootDir, stageRoot, copied, targetWatcher, target);
    }
  }
  delete rewritten.devDependencies;
  await writeJson(join(destination, "package.json"), rewritten);
  await cp(join(rootDir, "LICENSE"), join(destination, "LICENSE"));
}

function targetRecord(config, targetId) {
  const target = config.targets.find((candidate) => candidate.id === targetId);
  if (!target) throw new Error(`Unsupported release target ${targetId}.`);
  const watcherName = target.watcher_package.slice(0, target.watcher_package.lastIndexOf("@"));
  return { ...target, watcher_package: target.watcher_package, watcher: { package_name: watcherName, version: "2.6.0" } };
}

async function listFiles(root, current = root) {
  const output = [];
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => compareNames(left.name, right.name))) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(root, path));
    else output.push({ path, relative_path: unix(relative(root, path)), mode: unix(relative(root, path)) === "bin/urdira.mjs" ? 0o755 : 0o644 });
  }
  return output;
}

export async function inspectProductionTree(root) {
  const files = await listFiles(root);
  const forbidden = files.filter((entry) => FORBIDDEN_PRODUCTION_PATTERNS.some((pattern) => pattern.test(entry.relative_path)));
  const symlinks = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) symlinks.push(unix(relative(root, path)));
      else if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(root);
  return { files: files.map((entry) => entry.relative_path).sort(compareNames), forbidden, symlinks };
}

function tarField(buffer, start, length) {
  return buffer.subarray(start, start + length).toString("utf8").replace(/\0.*$/u, "").trim();
}

export async function inspectReleaseArchive(archivePath) {
  const bytes = gunzipSync(await readFile(archivePath));
  const entries = new Map();
  const symlinks = [];
  const errors = [];
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      zeroBlocks += 1;
      offset += 512;
      if (zeroBlocks === 2) break;
      continue;
    }
    zeroBlocks = 0;
    const name = tarField(header, 0, 100);
    const prefix = tarField(header, 345, 155);
    const path = prefix.length > 0 ? `${prefix}/${name}` : name;
    const type = header[156];
    const size = Number.parseInt(tarField(header, 124, 12), 8);
    if (path.length === 0 || !Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.byteLength) {
      errors.push(`invalid tar entry at offset ${offset}`);
      break;
    }
    if (entries.has(path)) errors.push(`duplicate tar entry ${path}`);
    if (type !== 0 && type !== 48) symlinks.push(path);
    entries.set(path, Buffer.from(bytes.subarray(offset + 512, offset + 512 + size)));
    offset += 512 + size + ((512 - (size % 512)) % 512);
  }
  if (zeroBlocks < 2) errors.push("tar archive is missing its two-block terminator");
  const files = [...entries.keys()].sort(compareNames);
  const forbidden = files.filter((path) => FORBIDDEN_PRODUCTION_PATTERNS.some((pattern) => pattern.test(path)));
  const checksumFailures = [];
  const checksumFile = entries.get("checksums.sha256");
  if (!checksumFile) checksumFailures.push("checksums.sha256 is missing");
  else for (const line of checksumFile.toString("utf8").trimEnd().split("\n")) {
    const match = /^(sha256:[0-9a-f]{64})\x20{2}(.+)$/u.exec(line);
    if (!match || !entries.has(match[2]) || sha256(entries.get(match[2])) !== match[1]) checksumFailures.push(match[2] ?? line);
  }
  let platform;
  try { platform = JSON.parse(entries.get("platform.json")?.toString("utf8") ?? "null"); } catch { errors.push("platform.json is not valid JSON"); }
  return { files, forbidden, symlinks, errors, checksum_failures: checksumFailures, platform, entries };
}

async function lockfileDigest(rootDir) { return sha256(await readFile(join(rootDir, "pnpm-lock.yaml"))); }
async function gitCommit(rootDir) { return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: rootDir })).stdout.trim(); }

function tarHeader(path, size, mode, type = 0) {
  const buffer = Buffer.alloc(512, 0);
  let namePart = path;
  let prefixPart = "";
  if (Buffer.byteLength(namePart) > 100) {
    const slash = path.lastIndexOf("/");
    prefixPart = slash > 0 ? path.slice(0, slash) : "";
    namePart = slash > 0 ? path.slice(slash + 1) : path;
  }
  if (Buffer.byteLength(namePart) > 100 || Buffer.byteLength(prefixPart) > 155) throw new Error(`Archive path exceeds deterministic tar header capacity: ${path}`);
  Buffer.from(namePart).copy(buffer, 0);
  buffer.write(`000${mode.toString(8).padStart(4, "0")}`, 100, 8, "ascii");
  buffer.write("0000000", 108, 8, "ascii");
  buffer.write("0000000", 116, 8, "ascii");
  buffer.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  buffer.write("00000000000\0", 136, 12, "ascii");
  buffer[156] = type;
  Buffer.from("ustar\0").copy(buffer, 257);
  Buffer.from("00").copy(buffer, 263);
  buffer.write("urdira", 265, 32, "ascii");
  buffer.write("urdira", 297, 32, "ascii");
  Buffer.from(prefixPart).copy(buffer, 345);
  for (let index = 148; index < 156; index++) buffer[index] = 32;
  const checksum = [...buffer].reduce((sum, value) => sum + value, 0);
  buffer.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return buffer;
}

export async function writeDeterministicArchive(root, destination) {
  const files = await listFiles(root);
  const chunks = [];
  for (const entry of files.sort((left, right) => compareNames(left.relative_path, right.relative_path))) {
    const bytes = await readFile(entry.path);
    chunks.push(tarHeader(entry.relative_path, bytes.byteLength, entry.mode ?? 0o644), bytes);
    const padding = (512 - (bytes.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, archive);
  return { path: destination, digest: sha256(archive), byte_length: archive.byteLength };
}

export async function stageProductionTree({ rootDir = SCRIPT_ROOT, stageRoot, targetId, metadata }) {
  const config = await readReleaseConfig();
  const target = targetRecord(config, targetId);
  await mkdir(stageRoot, { recursive: true });
  const copied = new Set();
  for (const name of PRODUCTION_PACKAGE_NAMES) await stageProductionPackage(name, rootDir, stageRoot, copied, target.watcher, target);
  const appSource = join(rootDir, "apps", "urdira", "dist");
  await copyBuildPayload(appSource, join(stageRoot, "dist"));
  const productionVersions = new Map(await Promise.all(PRODUCTION_PACKAGE_NAMES.map(async (name) => [name, (await readJson(join(rootDir, packagePath(name), "package.json"))).version])));
  await writeJson(join(stageRoot, "package.json"), { name: "urdira", version: productionVersions.get("@urdira/runtime"), type: "module", license: "MIT", engines: { node: ">=24.18.1" }, main: "./dist/index.js", bin: { urdira: "./bin/urdira.mjs" }, dependencies: Object.fromEntries(PRODUCTION_PACKAGE_NAMES.filter((name) => name !== "urdira" && name !== "@urdira/runtime").map((name) => [name, productionVersions.get(name)])) });
  await cp(join(rootDir, "README.md"), join(stageRoot, "README.md"));
  await cp(join(rootDir, "LICENSE"), join(stageRoot, "LICENSE"));
  await mkdir(join(stageRoot, "bin"), { recursive: true });
  await writeFile(join(stageRoot, "bin/urdira.mjs"), "#!/usr/bin/env node\nconst { runUrdira, runUrdiraMcp } = await import('../dist/index.js');\nconst argv = process.argv.slice(2);\nconst endpoint = process.env.URDIRA_ENDPOINT;\nif (argv[0] === 'mcp') {\n  const handle = await runUrdiraMcp({ ...(endpoint === undefined ? {} : { endpoint }) });\n  process.stdin.resume();\n  await new Promise((resolve) => process.stdin.once('end', resolve));\n  await handle.close();\n} else {\n  const result = await runUrdira(argv, { ...(endpoint === undefined ? {} : { endpoint }) });\n  process.stdout.write(result.stdout);\n}\n");
  await chmod(join(stageRoot, "bin/urdira.mjs"), 0o755);
  await writeJson(join(stageRoot, "platform.json"), { target: target.id, os: target.os, architecture: target.architecture, ...(target.libc === undefined ? {} : { libc: target.libc, minimum_libc: target.minimum_libc }), ...(target.minimum_os === undefined ? {} : { minimum_os: target.minimum_os }), runtime: config.runtime, watcher: target.watcher_package });
  const contracts = await import("@urdira/contracts");
  await writeJson(join(stageRoot, "schemas", "registry.json"), {
    schema_registry: contracts.coreSchemaDefinitions.map((schema) => ({ schema_id: schema.schema_id, schema_version: schema.schema_version })).sort((left, right) => compareNames(left.schema_id, right.schema_id)),
    operation_registry: contracts.operationRegistry.map((operation) => ({ operation_id: operation.operation_id, operation_version: operation.operation_version })).sort((left, right) => compareNames(left.operation_id, right.operation_id)),
    recipe_registry: contracts.recipeRegistry.map((recipe) => ({ recipe_id: recipe.recipe_id, recipe_version: recipe.recipe_version })).sort((left, right) => compareNames(left.recipe_id, right.recipe_id)),
  });
  await writeJson(join(stageRoot, "release.json"), metadata);
  const inspection = await inspectProductionTree(stageRoot);
  if (inspection.symlinks.length > 0) throw new Error(`Production tree contains symlinks: ${inspection.symlinks.join(", ")}`);
  if (inspection.forbidden.length > 0) throw new Error(`Production tree contains forbidden members: ${inspection.forbidden.map((entry) => entry.relative_path).join(", ")}`);
  const checksums = [];
  for (const entry of (await listFiles(stageRoot)).filter((item) => item.relative_path !== "checksums.sha256").sort((left, right) => compareNames(left.relative_path, right.relative_path))) checksums.push(`${sha256(await readFile(entry.path))}  ${entry.relative_path}`);
  await writeFile(join(stageRoot, "checksums.sha256"), `${checksums.join("\n")}\n`);
  return { target, inspection: await inspectProductionTree(stageRoot), checksums };
}

export async function buildRelease({ rootDir = SCRIPT_ROOT, outputDir = join(rootDir, "release", "artifacts"), targets = SUPPORTED_TARGETS, clean = true, build = true } = {}) {
  const config = await readReleaseConfig();
  const configErrors = validateReleaseConfig(config);
  if (configErrors.length > 0) throw new Error(`Invalid release configuration: ${configErrors.join("; ")}`);
  if (clean) await rm(outputDir, { recursive: true, force: true });
  // The repository root also references the test project. Release builds must
  // compile only the production project graph; the test tsconfig intentionally
  // has source-only imports that are not a distributable package input.
  if (build) await execFileAsync("pnpm", ["exec", "tsc", "--build", "--force", "packages/contracts", "packages/canonical", "packages/security", "packages/storage", "packages/plugin-sdk", "packages/plugin-javascript-typescript", "packages/engine", "packages/embedding-local", "packages/daemon", "packages/mcp", "packages/cli", "apps/urdira", "apps/bootstrap"], { cwd: rootDir, env: { ...process.env, CI: "true" }, maxBuffer: 20 * 1024 * 1024 });
  const metadata = buildReleaseMetadata({ gitCommit: await gitCommit(rootDir), lockfileDigest: await lockfileDigest(rootDir) });
  const archives = [];
  const inspections = {};
  for (const targetId of targets) {
    const stageRoot = join(outputDir, "staging", targetId);
    const staged = await stageProductionTree({ rootDir, stageRoot, targetId, metadata });
    const archive = await writeDeterministicArchive(stageRoot, join(outputDir, `urdira-${targetId}-${metadata.engine_version}.tar.gz`));
    archives.push({ target: targetId, ...archive });
    inspections[targetId] = staged.inspection;
  }
  return { metadata, archives, inspection: inspections, output_dir: outputDir };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const result = await buildRelease({ targets: process.env.URDIRA_RELEASE_TARGET ? [process.env.URDIRA_RELEASE_TARGET] : SUPPORTED_TARGETS });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
