/* c8 ignore file */
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PRODUCTION_PACKAGE_NAMES } from "./release-contract.mjs";

const execFileAsync = promisify(execFile);
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const packageDirectory = (name) => name === "urdira"
  ? join(ROOT, "apps", "bootstrap")
  : name === "@urdira/runtime"
    ? join(ROOT, "apps", "urdira")
    : join(ROOT, "packages", name.slice("@urdira/".length));
const safeName = (name) => name.replace("@urdira/", "urdira-");

const descriptions = {
  urdira: "Local, deterministic code intelligence for coding agents.",
  "@urdira/runtime": "Composed local runtime for the Urdira bootstrap.",
  "@urdira/contracts": "Public models, Schema IR, and registries for Urdira.",
  "@urdira/canonical": "Canonical encoding and digest primitives for Urdira.",
  "@urdira/security": "Security policy primitives for Urdira.",
  "@urdira/storage": "Durable SQLite, CAS, snapshot, and projection storage for Urdira.",
  "@urdira/plugin-sdk": "Language-neutral plugin contracts and supervision for Urdira.",
  "@urdira/plugin-javascript-typescript": "JavaScript and TypeScript analyzer plugin for Urdira.",
  "@urdira/engine": "Workspace indexing and deterministic query engine for Urdira.",
  "@urdira/embedding-local": "Local open-model embedding provider for Urdira.",
  "@urdira/daemon": "Local daemon, scheduling, and recovery for Urdira.",
  "@urdira/mcp": "Four-tool MCP adapter for Urdira.",
  "@urdira/cli": "Command-line parsing and administrative safety gates for Urdira.",
};

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function productionPackageVersions() {
  return new Map(await Promise.all(PRODUCTION_PACKAGE_NAMES.map(async (name) => {
    const manifest = await readJson(join(packageDirectory(name), "package.json"));
    return [name, manifest.version];
  })));
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
    ...(source.name === "urdira" ? { urdiraRuntime: { package: "@urdira/runtime", version: versions.get("@urdira/runtime") } } : {}),
  };
}

export function validatePublishManifest(manifest, versions) {
  const errors = [];
  if (!PRODUCTION_PACKAGE_NAMES.includes(manifest.name)) errors.push(`${manifest.name} is not in the production package allowlist`);
  if (manifest.private === true) errors.push(`${manifest.name} is private`);
  if (manifest.publishConfig?.access !== "public") errors.push(`${manifest.name} is not configured for public access`);
  if (manifest.license !== "MIT") errors.push(`${manifest.name} does not declare the MIT license`);
  if (manifest.engines?.node !== ">=24.18.1") errors.push(`${manifest.name} has the wrong Node engine floor`);
  if (manifest.name === "urdira") {
    if (Object.keys(manifest.dependencies ?? {}).length > 0) errors.push("urdira bootstrap must not have dependencies");
    if (manifest.urdiraRuntime?.package !== "@urdira/runtime" || manifest.urdiraRuntime?.version !== versions.get("@urdira/runtime")) errors.push("urdira bootstrap has the wrong runtime binding");
  }
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (String(version).startsWith("workspace:")) errors.push(`${manifest.name} retains workspace protocol dependency ${name}`);
    if (versions.has(name) && version !== versions.get(name)) errors.push(`${manifest.name} does not pin ${name} to ${versions.get(name)}`);
    if (name === "@urdira/testkit") errors.push(`${manifest.name} depends on testkit`);
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
    for (const dependency of Object.keys(byName.get(name)?.dependencies ?? {}).filter((candidate) => byName.has(candidate)).sort()) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    order.push(name);
  };
  for (const name of PRODUCTION_PACKAGE_NAMES) visit(name);
  return order;
}

async function packageReadme(manifest) {
  if (manifest.name === "urdira") return readFile(join(ROOT, "README.md"), "utf8");
  return `# ${manifest.name}\n\n${manifest.description}\n\nThis package is part of Urdira. Most users should install the top-level \`urdira\` package instead of depending on this package directly.\n\n## License\n\nMIT\n`;
}

async function stagePackage(name, versions, stageRoot) {
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

async function packPackage(staged, tarballRoot) {
  const { stdout } = await execFileAsync("npm", ["pack", "--json", "--pack-destination", tarballRoot], { cwd: staged.directory, maxBuffer: 10 * 1024 * 1024 });
  const result = JSON.parse(stdout)[0];
  const filenames = result.files.map((entry) => entry.path);
  for (const required of ["package.json", "README.md", "LICENSE"]) if (!filenames.includes(required)) throw new Error(`${staged.name} tarball is missing ${required}.`);
  if (!filenames.some((path) => path.startsWith("dist/"))) throw new Error(`${staged.name} tarball has no dist payload.`);
  if (filenames.some((path) => /(?:^|\/)(?:src|tests?|fixtures|node_modules)(?:\/|$)|\.tsbuildinfo$/u.test(path))) throw new Error(`${staged.name} tarball contains development files.`);
  return { ...staged, tarball: join(tarballRoot, result.filename), files: filenames, size: result.size, integrity: result.integrity };
}

async function buildProduction() {
  const projects = ["packages/contracts", "packages/canonical", "packages/security", "packages/storage", "packages/plugin-sdk", "packages/plugin-javascript-typescript", "packages/engine", "packages/embedding-local", "packages/daemon", "packages/mcp", "packages/cli", "apps/urdira", "apps/bootstrap"];
  await execFileAsync("pnpm", ["exec", "tsc", "--build", "--force", ...projects], { cwd: ROOT, env: { ...process.env, CI: "true" }, maxBuffer: 20 * 1024 * 1024 });
}

export async function buildNpmPackages({ outputRoot = join(ROOT, "release", "npm"), build = true } = {}) {
  if (build) await buildProduction();
  await rm(outputRoot, { recursive: true, force: true });
  const stageRoot = join(outputRoot, "staging");
  const tarballRoot = join(outputRoot, "tarballs");
  await mkdir(tarballRoot, { recursive: true });
  const versions = await productionPackageVersions();
  const packed = [];
  for (const name of PRODUCTION_PACKAGE_NAMES) packed.push(await packPackage(await stagePackage(name, versions, stageRoot), tarballRoot));
  const report = {
    package_schema_version: 1,
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
    await writeFile(join(smokeRoot, "package.json"), `${JSON.stringify({
      name: "urdira-npm-smoke",
      private: true,
      type: "module",
      overrides: { "adm-zip": "0.6.0", sharp: "0.35.3" },
      allowScripts: {
        "onnxruntime-node@1.24.3": true,
        "sharp@0.35.3": true,
        "@parcel/watcher@2.6.0": true,
        "protobufjs@7.6.5": true,
      },
    }, null, 2)}\n`);
    const installation = await execFileAsync("npm", ["install", "--no-audit", "--no-fund", ...packed.map((entry) => entry.tarball)], { cwd: smokeRoot, env: { ...npmEnvironment, NPM_CONFIG_CACHE: join(smokeRoot, "npm-cache") }, maxBuffer: 20 * 1024 * 1024 });
    const warningLines = installation.stderr.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.startsWith("npm warn"));
    const unexpectedWarnings = warningLines.filter((line) => line !== "npm warn deprecated boolean@3.2.0: Package no longer supported. Contact Support at https://www.npmjs.com/support for more info.");
    if (unexpectedWarnings.length > 0) throw new Error(`npm runtime closure smoke found an undisclosed warning: ${unexpectedWarnings.join(" | ")}`);
    const runtimeCli = join(smokeRoot, "node_modules", "@urdira", "runtime", "dist", "cli.js");
    const version = await execFileAsync(process.execPath, [runtimeCli, "--version"], { cwd: smokeRoot });
    const help = await execFileAsync(process.execPath, [runtimeCli, "--help"], { cwd: smokeRoot });
    const runtimePackage = packed.find((entry) => entry.name === "@urdira/runtime");
    if (runtimePackage === undefined || version.stdout.trim() !== runtimePackage.version || !help.stdout.includes("urdira mcp")) throw new Error("Installed runtime CLI smoke check failed.");
    return { version: version.stdout.trim(), help: true, bootstrap_warning_free: true };
  } finally {
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const result = await buildNpmPackages();
  const smoke = process.argv.includes("--smoke") ? await smokeInstallNpmPackages(result.packed) : undefined;
  process.stdout.write(`${JSON.stringify({ output: result.outputRoot, packages: result.report.packages.length, ...(smoke === undefined ? {} : { smoke }) }, null, 2)}\n`);
}
