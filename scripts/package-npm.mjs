/* c8 ignore file */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  NATIVE_NPM_PACKAGE_NAMES,
  NATIVE_NPM_PACKAGES,
  NPM_PUBLIC_PACKAGE_NAMES,
  PRODUCTION_PACKAGE_NAMES,
  SUPPORTED_TARGETS,
} from "./release-contract.mjs";
import { NATIVE_TARGETS, hostNativeTarget, nativeArtifactNames } from "./native-release.mjs";

const execFileAsync = promisify(execFile);
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const packageDirectory = (name) => name === "urdira"
  ? join(ROOT, "apps", "bootstrap")
  : name === "@urdira/runtime"
    ? join(ROOT, "apps", "urdira")
    : join(ROOT, "packages", name.slice("@urdira/".length));
const safeName = (name) => name.replace("@urdira/", "urdira-");
const nativeTargetByPackage = new Map(Object.entries(NATIVE_NPM_PACKAGES).map(([target, name]) => [name, target]));

const descriptions = {
  urdira: "Local, deterministic code intelligence for coding agents.",
  "@urdira/runtime": "Composed local runtime for the Urdira bootstrap.",
  "@urdira/contracts": "Public models, Schema IR, and registries for Urdira.",
  "@urdira/canonical": "Canonical encoding and digest primitives for Urdira.",
  "@urdira/native": "Verified Rust acceleration and platform loader for Urdira.",
  "@urdira/security": "Security policy primitives for Urdira.",
  "@urdira/storage": "Durable SQLite, CAS, snapshot, and projection storage for Urdira.",
  "@urdira/plugin-sdk": "Language-neutral plugin contracts and supervision for Urdira.",
  "@urdira/plugin-javascript-typescript": "JavaScript and TypeScript analyzer plugin for Urdira.",
  "@urdira/engine": "Workspace indexing and deterministic query engine for Urdira.",
  "@urdira/embedding-local": "Local open-model embedding provider for Urdira.",
  "@urdira/daemon": "Local daemon, scheduling, and recovery for Urdira.",
  "@urdira/mcp": "Five-tool MCP adapter for Urdira.",
  "@urdira/web": "Secured loopback web interface for Urdira CLI and MCP.",
  "@urdira/cli": "Command-line parsing and administrative safety gates for Urdira.",
};

for (const [target, name] of Object.entries(NATIVE_NPM_PACKAGES)) descriptions[name] = `Verified Rust addon and syntax worker for Urdira on ${target}.`;

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function productionPackageVersions() {
  const versions = new Map(await Promise.all(PRODUCTION_PACKAGE_NAMES.map(async (name) => {
    const manifest = await readJson(join(packageDirectory(name), "package.json"));
    return [name, manifest.version];
  })));
  const nativeVersion = versions.get("@urdira/native");
  for (const name of NATIVE_NPM_PACKAGE_NAMES) versions.set(name, nativeVersion);
  return versions;
}

export function createPublishManifest(source, versions) {
  const dependencies = Object.fromEntries(Object.entries(source.dependencies ?? {}).map(([name, value]) => {
    if (versions.has(name)) return [name, versions.get(name)];
    if (String(value).startsWith("workspace:")) throw new Error(`${source.name} has a non-production workspace dependency on ${name}.`);
    return [name, value];
  }));
  return {
    name: source.name,
    version: source.version,
    description: descriptions[source.name],
    type: "module",
    license: "MIT",
    repository: { type: "git", url: "https://github.com/CristianBB/urdira" },
    keywords: ["code-intelligence", "coding-agents", "mcp", "typescript"],
    engines: { node: ">=24.18.1" },
    publishConfig: { access: "public" },
    files: ["dist", "README.md", "LICENSE"],
    main: source.main,
    ...(source.types === undefined ? {} : { types: source.types }),
    ...(source.exports === undefined ? {} : { exports: source.exports }),
    ...(source.bin === undefined ? {} : { bin: source.bin }),
    sideEffects: source.sideEffects ?? false,
    ...(Object.keys(dependencies).length === 0 ? {} : { dependencies }),
    ...(source.name === "@urdira/native" ? {
      optionalDependencies: Object.fromEntries(NATIVE_NPM_PACKAGE_NAMES.map((name) => [name, versions.get(name)])),
    } : {}),
    ...(source.name === "urdira" ? { urdiraRuntime: { package: "@urdira/runtime", version: versions.get("@urdira/runtime") } } : {}),
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function nativePlatform(target) {
  if (!SUPPORTED_TARGETS.includes(target)) throw new Error(`Unsupported native npm target ${target}.`);
  if (target === "darwin-arm64") return { os: "darwin", cpu: "arm64" };
  if (target === "darwin-x64") return { os: "darwin", cpu: "x64" };
  if (target === "linux-arm64-gnu") return { os: "linux", cpu: "arm64", libc: "glibc" };
  if (target === "linux-x64-gnu") return { os: "linux", cpu: "x64", libc: "glibc" };
  return { os: "win32", cpu: "x64" };
}

export function createNativePlatformPublishManifest({ target, version, addonDigest, workerDigest }) {
  const name = NATIVE_NPM_PACKAGES[target];
  const rustTarget = NATIVE_TARGETS[target];
  if (name === undefined || rustTarget === undefined) throw new Error(`Unsupported native npm target ${target}.`);
  const platform = nativePlatform(target);
  const workerName = nativeArtifactNames(target).worker;
  const buildIdentity = {
    schema_version: 1,
    target,
    rust_target: rustTarget,
    binding_api: 16,
    node_api: 10,
    worker_protocol: "urdira.ipc.v2",
    files: {
      addon: { path: "native/urdira-native.node", digest: addonDigest },
      worker: { path: `native/${workerName}`, digest: workerDigest },
    },
  };
  return {
    name,
    version,
    description: descriptions[name],
    license: "MIT",
    repository: { type: "git", url: "https://github.com/CristianBB/urdira" },
    keywords: ["code-intelligence", "coding-agents", "native", "rust"],
    engines: { node: ">=24.18.1" },
    publishConfig: { access: "public" },
    files: ["native", "README.md", "LICENSE"],
    os: [platform.os],
    cpu: [platform.cpu],
    ...(platform.libc === undefined ? {} : { libc: [platform.libc] }),
    exports: { "./package.json": "./package.json" },
    sideEffects: false,
    urdiraNative: { ...buildIdentity, build_id: sha256(JSON.stringify(stable(buildIdentity))) },
  };
}

export function validatePublishManifest(manifest, versions) {
  const errors = [];
  if (!NPM_PUBLIC_PACKAGE_NAMES.includes(manifest.name)) errors.push(`${manifest.name} is not in the npm production package allowlist`);
  if (manifest.private === true) errors.push(`${manifest.name} is private`);
  if (manifest.publishConfig?.access !== "public") errors.push(`${manifest.name} is not configured for public access`);
  if (manifest.license !== "MIT") errors.push(`${manifest.name} does not declare the MIT license`);
  if (manifest.engines?.node !== ">=24.18.1") errors.push(`${manifest.name} has the wrong Node engine floor`);
  if (manifest.name === "urdira") {
    if (Object.keys(manifest.dependencies ?? {}).length > 0) errors.push("urdira bootstrap must not have dependencies");
    if (manifest.urdiraRuntime?.package !== "@urdira/runtime" || manifest.urdiraRuntime?.version !== versions.get("@urdira/runtime")) errors.push("urdira bootstrap has the wrong runtime binding");
  }
  for (const [name, version] of Object.entries({ ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}) })) {
    if (String(version).startsWith("workspace:")) errors.push(`${manifest.name} retains workspace protocol dependency ${name}`);
    if (versions.has(name) && version !== versions.get(name)) errors.push(`${manifest.name} does not pin ${name} to ${versions.get(name)}`);
    if (name === "@urdira/testkit") errors.push(`${manifest.name} depends on testkit`);
  }
  if (manifest.name === "@urdira/native") {
    if (JSON.stringify(manifest.optionalDependencies) !== JSON.stringify(Object.fromEntries(NATIVE_NPM_PACKAGE_NAMES.map((name) => [name, versions.get(name)])))) errors.push("@urdira/native does not pin the closed native platform package set");
    if (manifest.files?.includes("prebuilds")) errors.push("@urdira/native must not contain platform artifacts");
  }
  const nativeTarget = nativeTargetByPackage.get(manifest.name);
  if (nativeTarget !== undefined) {
    const platform = nativePlatform(nativeTarget);
    if (manifest.version !== versions.get("@urdira/native")) errors.push(`${manifest.name} does not share the @urdira/native version`);
    if (JSON.stringify(manifest.os) !== JSON.stringify([platform.os]) || JSON.stringify(manifest.cpu) !== JSON.stringify([platform.cpu])) errors.push(`${manifest.name} has invalid platform constraints`);
    if (platform.libc === undefined ? manifest.libc !== undefined : JSON.stringify(manifest.libc) !== JSON.stringify([platform.libc])) errors.push(`${manifest.name} has invalid libc constraints`);
    if (manifest.private !== undefined || manifest.dependencies !== undefined || manifest.optionalDependencies !== undefined || manifest.scripts !== undefined) errors.push(`${manifest.name} staged manifest leaks private or executable package metadata`);
  }
  return errors;
}

export function publicationOrder(packages) {
  const byName = new Map(packages.map((entry) => [entry.name, entry.manifest]));
  const visiting = new Set();
  const visited = new Set();
  const order = [];
  const visit = (name) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Public package dependency cycle at ${name}.`);
    visiting.add(name);
    const runtimePackage = byName.get(name)?.urdiraRuntime?.package;
    if (typeof runtimePackage === "string" && byName.has(runtimePackage)) visit(runtimePackage);
    const dependencies = { ...(byName.get(name)?.dependencies ?? {}), ...(byName.get(name)?.optionalDependencies ?? {}) };
    for (const dependency of Object.keys(dependencies).filter((candidate) => byName.has(candidate)).sort()) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    order.push(name);
  };
  for (const { name } of packages) visit(name);
  return order;
}

async function packageReadme(manifest) {
  if (manifest.name === "urdira") return readFile(join(ROOT, "README.md"), "utf8");
  return `# ${manifest.name}\n\n${manifest.description}\n\nThis package is part of Urdira. Most users should install the top-level \`urdira\` package instead of depending on this package directly.\n\n## License\n\nMIT\n`;
}

async function stageSourcePackage(name, versions, stageRoot) {
  const sourceRoot = packageDirectory(name);
  const source = await readJson(join(sourceRoot, "package.json"));
  const manifest = createPublishManifest(source, versions);
  const errors = validatePublishManifest(manifest, versions);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const destination = join(stageRoot, safeName(name));
  await mkdir(destination, { recursive: true });
  await cp(join(sourceRoot, "dist"), join(destination, "dist"), { recursive: true, dereference: true });
  await rm(join(destination, "dist", "tsconfig.tsbuildinfo"), { force: true });
  await writeFile(join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(destination, "README.md"), await packageReadme(manifest));
  await cp(join(ROOT, "LICENSE"), join(destination, "LICENSE"));
  return { name, version: manifest.version, directory: destination, manifest };
}

async function stageNativePlatformPackage(target, versions, stageRoot, nativeArtifactRoot) {
  const name = NATIVE_NPM_PACKAGES[target];
  const version = versions.get("@urdira/native");
  const artifactNames = nativeArtifactNames(target);
  const sourceRoot = join(nativeArtifactRoot, target);
  let addon;
  let worker;
  try {
    addon = await readFile(join(sourceRoot, artifactNames.addon));
    worker = await readFile(join(sourceRoot, artifactNames.worker));
  } catch (error) {
    throw new Error(`Native npm package ${name} is missing its exact ${target} artifact closure at ${sourceRoot}.`, { cause: error });
  }
  const manifest = createNativePlatformPublishManifest({ target, version, addonDigest: sha256(addon), workerDigest: sha256(worker) });
  const errors = validatePublishManifest(manifest, versions);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const destination = join(stageRoot, safeName(name));
  await mkdir(join(destination, "native"), { recursive: true });
  await writeFile(join(destination, "native", artifactNames.addon), addon);
  await writeFile(join(destination, "native", artifactNames.worker), worker, { mode: target === "win32-x64" ? undefined : 0o755 });
  await writeFile(join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(destination, "README.md"), await packageReadme(manifest));
  await cp(join(ROOT, "LICENSE"), join(destination, "LICENSE"));
  return { name, version, directory: destination, manifest };
}

async function packPackage(staged, tarballRoot) {
  const { stdout } = await execFileAsync("npm", ["pack", "--json", "--pack-destination", tarballRoot], { cwd: staged.directory, maxBuffer: 10 * 1024 * 1024 });
  const result = JSON.parse(stdout)[0];
  const filenames = result.files.map((entry) => entry.path);
  for (const required of ["package.json", "README.md", "LICENSE"]) if (!filenames.includes(required)) throw new Error(`${staged.name} tarball is missing ${required}.`);
  const nativeTarget = nativeTargetByPackage.get(staged.name);
  if (nativeTarget === undefined && !filenames.some((path) => path.startsWith("dist/"))) throw new Error(`${staged.name} tarball has no dist payload.`);
  if (staged.name === "@urdira/native" && filenames.some((path) => path.startsWith("prebuilds/") || path.startsWith("native/"))) throw new Error("@urdira/native tarball contains platform artifacts.");
  if (nativeTarget !== undefined) {
    const expectedWorker = `native/${nativeArtifactNames(nativeTarget).worker}`;
    const nativeFiles = filenames.filter((path) => path.startsWith("native/")).sort();
    if (JSON.stringify(nativeFiles) !== JSON.stringify([expectedWorker, "native/urdira-native.node"].sort())) throw new Error(`${staged.name} tarball does not contain exactly one native target closure.`);
  }
  if (filenames.some((path) => /(?:^|\/)(?:src|tests?|fixtures|node_modules)(?:\/|$)|\.tsbuildinfo$/u.test(path))) throw new Error(`${staged.name} tarball contains development files.`);
  return { ...staged, tarball: join(tarballRoot, result.filename), files: filenames, size: result.size, integrity: result.integrity };
}

const productionProjects = ["packages/contracts", "packages/canonical", "packages/native", "packages/security", "packages/storage", "packages/plugin-sdk", "packages/plugin-javascript-typescript", "packages/engine", "packages/embedding-local", "packages/daemon", "packages/mcp", "packages/cli", "packages/web", "apps/urdira", "apps/bootstrap"];

export async function cleanProductionBuildOutputs(projectRoots = productionProjects.map((project) => join(ROOT, project))) {
  await Promise.all(projectRoots.map((projectRoot) => rm(join(projectRoot, "dist"), { recursive: true, force: true })));
}

async function buildProduction() {
  await cleanProductionBuildOutputs();
  for (const project of productionProjects) {
    if (project === "packages/web") await execFileAsync("pnpm", ["--filter", "@urdira/web", "build"], { cwd: ROOT, env: { ...process.env, CI: "true" }, maxBuffer: 20 * 1024 * 1024 });
    else await execFileAsync("pnpm", ["exec", "tsc", "--build", "--force", project], { cwd: ROOT, env: { ...process.env, CI: "true" }, maxBuffer: 20 * 1024 * 1024 });
  }
}

export async function buildNpmPackages({
  outputRoot = join(ROOT, "release", "npm"),
  build = true,
  nativeArtifactRoot = join(ROOT, "release", "native"),
  nativeTargets = SUPPORTED_TARGETS,
} = {}) {
  if (build) await buildProduction();
  await rm(outputRoot, { recursive: true, force: true });
  const stageRoot = join(outputRoot, "staging");
  const tarballRoot = join(outputRoot, "tarballs");
  await mkdir(tarballRoot, { recursive: true });
  const versions = await productionPackageVersions();
  const packed = [];
  for (const name of PRODUCTION_PACKAGE_NAMES) packed.push(await packPackage(await stageSourcePackage(name, versions, stageRoot), tarballRoot));
  for (const target of nativeTargets) packed.push(await packPackage(await stageNativePlatformPackage(target, versions, stageRoot, nativeArtifactRoot), tarballRoot));
  const report = {
    package_schema_version: 2,
    complete_native_target_set: nativeTargets.length === SUPPORTED_TARGETS.length && SUPPORTED_TARGETS.every((target) => nativeTargets.includes(target)),
    packages: packed.map(({ name, version, tarball, size, integrity, files }) => ({ name, version, tarball: basename(tarball), size, integrity, files })),
    publish_order: publicationOrder(packed),
  };
  await writeFile(join(outputRoot, "manifest.json"), `${JSON.stringify(report, null, 2)}\n`);
  return { outputRoot, packed, report };
}

export async function smokeInstallNpmPackages(packed) {
  const bootstrap = packed.find((entry) => entry.name === "urdira");
  if (bootstrap === undefined) throw new Error("npm package smoke is missing the urdira bootstrap tarball.");
  const npmEnvironment = {
    ...process.env,
    NPM_CONFIG_USERCONFIG: process.platform === "win32" ? "NUL" : "/dev/null",
    NPM_CONFIG_STRICT_ALLOW_SCRIPTS: "true",
  };
  const bootstrapRoot = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "urdira-bootstrap-smoke-")));
  try {
    const prefix = join(bootstrapRoot, "prefix");
    await mkdir(join(prefix, "lib"), { recursive: true });
    const bootstrapNpmEnvironment = { ...npmEnvironment, NPM_CONFIG_CACHE: join(bootstrapRoot, "npm-cache") };
    const installation = await execFileAsync("npm", ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", bootstrap.tarball], { env: bootstrapNpmEnvironment, maxBuffer: 20 * 1024 * 1024 });
    if (/npm warn/iu.test(installation.stderr)) throw new Error(`Dependency-free bootstrap installation emitted an npm warning:\n${installation.stderr}`);
    const npmRoot = (await execFileAsync("npm", ["root", "--global", "--prefix", prefix], { env: bootstrapNpmEnvironment })).stdout.trim();
    const installedManifest = await readJson(join(npmRoot, "urdira", "package.json"));
    if (Object.keys(installedManifest.dependencies ?? {}).length > 0) throw new Error("Installed urdira bootstrap has a dependency closure.");
    const cli = join(npmRoot, "urdira", "dist", "cli.js");
    const version = await execFileAsync(process.execPath, [cli, "--version"], { cwd: bootstrapRoot });
    const help = await execFileAsync(process.execPath, [cli, "--help"], { cwd: bootstrapRoot });
    if (version.stdout.trim() !== bootstrap.version || !help.stdout.includes("runtime prepare")) throw new Error("Dependency-free bootstrap smoke check failed.");
  } finally {
    await rm(bootstrapRoot, { recursive: true, force: true });
  }

  const smokeRoot = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "urdira-npm-smoke-")));
  try {
    const hostTarget = hostNativeTarget();
    if (hostTarget === undefined) throw new Error(`npm native smoke does not support ${process.platform}/${process.arch}.`);
    const hostPackageName = NATIVE_NPM_PACKAGES[hostTarget];
    const hostPackage = packed.find((entry) => entry.name === hostPackageName);
    if (hostPackage === undefined) throw new Error(`npm native smoke is missing ${hostPackageName}.`);
    const installable = packed.filter((entry) => !NATIVE_NPM_PACKAGE_NAMES.includes(entry.name) || entry.name === hostPackageName);
    await writeFile(join(smokeRoot, "package.json"), `${JSON.stringify({
      name: "urdira-npm-smoke",
      private: true,
      type: "module",
      overrides: { "adm-zip": "0.6.0", sharp: "0.35.3", protobufjs: "7.6.5" },
      allowScripts: {
        "onnxruntime-node@1.24.3": true,
        "sharp@0.35.3": true,
        "@parcel/watcher@2.6.0": true,
        "protobufjs@7.6.5": true,
      },
    }, null, 2)}\n`);
    const installation = await execFileAsync("npm", ["install", "--no-audit", "--no-fund", ...installable.map((entry) => entry.tarball)], { cwd: smokeRoot, env: { ...npmEnvironment, NPM_CONFIG_CACHE: join(smokeRoot, "npm-cache") }, maxBuffer: 20 * 1024 * 1024 });
    const warningLines = installation.stderr.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.startsWith("npm warn"));
    const unexpectedWarnings = warningLines.filter((line) => line !== "npm warn deprecated boolean@3.2.0: Package no longer supported. Contact Support at https://www.npmjs.com/support for more info.");
    if (unexpectedWarnings.length > 0) throw new Error(`npm runtime closure smoke found an undisclosed warning: ${unexpectedWarnings.join(" | ")}`);
    const runtimeCli = join(smokeRoot, "node_modules", "@urdira", "runtime", "dist", "cli.js");
    const version = await execFileAsync(process.execPath, [runtimeCli, "--version"], { cwd: smokeRoot });
    const help = await execFileAsync(process.execPath, [runtimeCli, "--help"], { cwd: smokeRoot });
    const runtimePackage = packed.find((entry) => entry.name === "@urdira/runtime");
    if (runtimePackage === undefined || version.stdout.trim() !== runtimePackage.version || !help.stdout.includes("urdira mcp")) throw new Error("Installed runtime CLI smoke check failed.");
    const nativeScope = join(smokeRoot, "node_modules", "@urdira");
    for (const name of NATIVE_NPM_PACKAGE_NAMES) {
      const installed = await import("node:fs").then(({ existsSync }) => existsSync(join(nativeScope, name.slice("@urdira/".length))));
      if (installed !== (name === hostPackageName)) throw new Error(`npm installed the wrong native platform closure: ${name}.`);
    }
    const nativePackageRoot = join(nativeScope, "native");
    const nativeCheck = await execFileAsync(process.execPath, ["--input-type=module", "--eval", "import { loadNativeBinding, resolveNativeWorkerPath } from '@urdira/native'; const binding = loadNativeBinding(); process.stdout.write(JSON.stringify({ target: binding.nativeTargetTriple(), worker: resolveNativeWorkerPath() }));"], { cwd: smokeRoot });
    const resolvedNative = JSON.parse(nativeCheck.stdout);
    if (!String(resolvedNative.worker).includes(join(hostPackageName.slice("@urdira/".length), "native"))) throw new Error("Installed @urdira/native did not resolve its exact host worker package.");
    return { version: version.stdout.trim(), help: true, bootstrap_warning_free: true, native_package: hostPackageName, native_package_root: nativePackageRoot };
  } finally {
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const smokeRequested = process.argv.includes("--smoke");
  const localTarget = smokeRequested ? hostNativeTarget() : undefined;
  if (smokeRequested && localTarget === undefined) throw new Error(`npm native smoke does not support ${process.platform}/${process.arch}.`);
  const result = await buildNpmPackages({ ...(localTarget === undefined ? {} : { nativeTargets: [localTarget] }) });
  const smoke = smokeRequested ? await smokeInstallNpmPackages(result.packed) : undefined;
  process.stdout.write(`${JSON.stringify({ output: result.outputRoot, packages: result.report.packages.length, ...(smoke === undefined ? {} : { smoke }) }, null, 2)}\n`);
}
