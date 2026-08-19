import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export const BOOTSTRAP_VERSION = "0.1.1";
export const RUNTIME_PACKAGE_NAME = "@urdira/runtime";
export const RUNTIME_VERSION = "0.1.1";
export const RUNTIME_REGISTRY = "https://registry.npmjs.org/";
export const MINIMUM_NPM_VERSION = "11.16.0";
export const RUNTIME_INSTALL_SCRIPT_APPROVALS = Object.freeze({
  "onnxruntime-node@1.24.3": true,
  "sharp@0.35.3": true,
  "@parcel/watcher@2.6.0": true,
  "protobufjs@7.6.5": true,
});

const ACKNOWLEDGED_BOOLEAN_WARNING = "npm warn deprecated boolean@3.2.0: Package no longer supported. Contact Support at https://www.npmjs.com/support for more info.";
const RUNTIME_MANIFEST_NAME = "urdira-runtime.json";

export interface RuntimePaths {
  readonly runtime_parent: string;
  readonly active_root: string;
  readonly entrypoint: string;
  readonly manifest: string;
  readonly lock: string;
  readonly npm_cache: string;
}

export interface RuntimePreparationPlan {
  readonly bootstrap_version: string;
  readonly package_name: string;
  readonly package_version: string;
  readonly minimum_npm_version: string;
  readonly registry: string;
  readonly target_root: string;
  readonly install_scripts: readonly string[];
  readonly known_upstream_notices: readonly string[];
}

export interface RuntimeInstallerRequest {
  readonly staging_root: string;
  readonly npm_cache: string;
}

export interface RuntimeInstallerResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly npm_version: string;
}

export type RuntimeInstaller = (request: RuntimeInstallerRequest) => Promise<RuntimeInstallerResult>;

export interface PrepareRuntimeOptions {
  readonly data_root?: string;
  readonly confirm: boolean;
  readonly install?: RuntimeInstaller;
  readonly clock?: () => string;
}

export type PrepareRuntimeResult =
  | { readonly status: "preview"; readonly plan: RuntimePreparationPlan }
  | { readonly status: "prepared" | "already_prepared"; readonly plan: RuntimePreparationPlan; readonly entrypoint: string };

interface RuntimeManifest {
  readonly manifest_schema_version: 1;
  readonly bootstrap_version: string;
  readonly runtime_package: string;
  readonly runtime_version: string;
  readonly npm_version: string;
  readonly prepared_at: string;
  readonly package_lock_sha256: string;
  readonly acknowledged_npm_warnings: readonly string[];
}

export function defaultDataRoot(): string {
  return process.env["URDIRA_DATA_ROOT"] ?? join(homedir(), ".urdira");
}

export function runtimePaths(dataRoot = defaultDataRoot()): RuntimePaths {
  const normalizedRoot = resolve(dataRoot);
  const runtimeParent = join(normalizedRoot, "runtime");
  const activeRoot = join(runtimeParent, RUNTIME_VERSION);
  return {
    runtime_parent: runtimeParent,
    active_root: activeRoot,
    entrypoint: join(activeRoot, "node_modules", "@urdira", "runtime", "dist", "cli.js"),
    manifest: join(activeRoot, RUNTIME_MANIFEST_NAME),
    lock: join(runtimeParent, ".prepare.lock"),
    npm_cache: join(runtimeParent, ".npm-cache"),
  };
}

export function createRuntimePreparationPlan(dataRoot = defaultDataRoot()): RuntimePreparationPlan {
  const paths = runtimePaths(dataRoot);
  return {
    bootstrap_version: BOOTSTRAP_VERSION,
    package_name: RUNTIME_PACKAGE_NAME,
    package_version: RUNTIME_VERSION,
    minimum_npm_version: MINIMUM_NPM_VERSION,
    registry: RUNTIME_REGISTRY,
    target_root: paths.active_root,
    install_scripts: Object.keys(RUNTIME_INSTALL_SCRIPT_APPROVALS),
    known_upstream_notices: ["boolean@3.2.0 is deprecated through @huggingface/transformers@4.2.0 -> onnxruntime-node@1.24.3 -> global-agent@3.0.0."],
  };
}

export function classifyNpmWarnings(stderr: string): { readonly acknowledged: readonly string[]; readonly unknown: readonly string[] } {
  const warningLines = stderr.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.startsWith("npm warn"));
  return {
    acknowledged: warningLines.filter((line) => line === ACKNOWLEDGED_BOOLEAN_WARNING),
    unknown: warningLines.filter((line) => line !== ACKNOWLEDGED_BOOLEAN_WARNING),
  };
}

async function existingRuntime(paths: RuntimePaths): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(paths.manifest, "utf8")) as Partial<RuntimeManifest>;
    const entry = await lstat(paths.entrypoint);
    const packageLock = await readFile(join(paths.active_root, "package-lock.json"));
    return entry.isFile() && !entry.isSymbolicLink()
      && manifest.manifest_schema_version === 1
      && manifest.bootstrap_version === BOOTSTRAP_VERSION
      && manifest.runtime_package === RUNTIME_PACKAGE_NAME
      && manifest.runtime_version === RUNTIME_VERSION
      && manifest.package_lock_sha256 === sha256(packageLock);
  } catch {
    return false;
  }
}

async function locateNpmCli(): Promise<string> {
  const candidates = [
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.endsWith("npm-cli.js"));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return resolve(candidate);
    } catch {
      // Try the next location paired with this Node installation.
    }
  }
  throw new Error("Could not locate npm-cli.js for the active Node installation.");
}

function runtimeInstallEnvironment(npmCache: string, userConfig: string, globalConfig: string): NodeJS.ProcessEnv {
  const retained = ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of retained) if (process.env[name] !== undefined) environment[name] = process.env[name];
  environment["NPM_CONFIG_USERCONFIG"] = userConfig;
  environment["NPM_CONFIG_GLOBALCONFIG"] = globalConfig;
  environment["NPM_CONFIG_REGISTRY"] = RUNTIME_REGISTRY;
  environment["NPM_CONFIG_CACHE"] = npmCache;
  environment["NPM_CONFIG_AUDIT"] = "false";
  environment["NPM_CONFIG_FUND"] = "false";
  environment["NPM_CONFIG_UPDATE_NOTIFIER"] = "false";
  environment["NPM_CONFIG_COLOR"] = "false";
  environment["NPM_CONFIG_STRICT_ALLOW_SCRIPTS"] = "true";
  return environment;
}

async function runNpm(npmCli: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [npmCli, ...args], { cwd, env: environment, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`npm runtime preparation failed (${signal ?? `exit ${String(code)}`}): ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function defaultInstaller(request: RuntimeInstallerRequest): Promise<RuntimeInstallerResult> {
  const npmCli = await locateNpmCli();
  await mkdir(request.npm_cache, { recursive: true, mode: 0o700 });
  const userConfig = join(request.npm_cache, "empty-user.npmrc");
  const globalConfig = join(request.npm_cache, "empty-global.npmrc");
  await writeFile(userConfig, "", { mode: 0o600 });
  await writeFile(globalConfig, "", { mode: 0o600 });
  const environment = runtimeInstallEnvironment(request.npm_cache, userConfig, globalConfig);
  const version = await runNpm(npmCli, ["--version"], request.staging_root, environment);
  if (!minimumVersionSatisfied(version.stdout.trim(), MINIMUM_NPM_VERSION)) throw new Error(`Runtime preparation requires npm >=${MINIMUM_NPM_VERSION}; found ${version.stdout.trim() || "unknown"}.`);
  const installation = await runNpm(npmCli, ["install", "--package-lock=true", "--no-audit", "--no-fund"], request.staging_root, environment);
  const tree = await runNpm(npmCli, ["ls", "--all", "--json"], request.staging_root, environment);
  return { stdout: `${installation.stdout}${tree.stdout}`, stderr: `${installation.stderr}${tree.stderr}`, npm_version: version.stdout.trim() };
}

function minimumVersionSatisfied(actual: string, minimum: string): boolean {
  const parse = (value: string) => value.split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
  const actualParts = parse(actual);
  const minimumParts = parse(minimum);
  if (actualParts.length !== 3 || actualParts.some((part) => !Number.isSafeInteger(part))) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actualParts[index]! > minimumParts[index]!) return true;
    if (actualParts[index]! < minimumParts[index]!) return false;
  }
  return true;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function validateStagedRuntime(stagingRoot: string): Promise<string> {
  const packageRoot = join(stagingRoot, "node_modules", "@urdira", "runtime");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { readonly name?: string; readonly version?: string };
  if (manifest.name !== RUNTIME_PACKAGE_NAME || manifest.version !== RUNTIME_VERSION) throw new Error("Prepared runtime package identity does not match the bootstrap.");
  if (!(await stat(join(packageRoot, "dist", "cli.js"))).isFile()) throw new Error("Prepared runtime CLI entry point is missing.");
  const lockBytes = await readFile(join(stagingRoot, "package-lock.json"));
  const lock = JSON.parse(lockBytes.toString("utf8")) as { readonly lockfileVersion?: number };
  if (typeof lock.lockfileVersion !== "number" && Object.keys(lock).length !== 0) throw new Error("Prepared runtime lockfile is invalid.");
  return sha256(lockBytes);
}

function assertStagingPath(paths: RuntimePaths, stagingRoot: string): void {
  const prefix = `${resolve(paths.runtime_parent)}${sep}`;
  if (!resolve(stagingRoot).startsWith(prefix) || !stagingRoot.includes(".staging-")) throw new Error("Refusing unsafe runtime staging path.");
}

export async function prepareRuntime(options: PrepareRuntimeOptions): Promise<PrepareRuntimeResult> {
  const paths = runtimePaths(options.data_root);
  const plan = createRuntimePreparationPlan(options.data_root);
  if (await existingRuntime(paths)) return { status: "already_prepared", plan, entrypoint: paths.entrypoint };
  if (!options.confirm) return { status: "preview", plan };

  await mkdir(paths.runtime_parent, { recursive: true, mode: 0o700 });
  let lock: FileHandle | undefined;
  const stagingRoot = join(paths.runtime_parent, `.staging-${RUNTIME_VERSION}-${randomUUID()}`);
  assertStagingPath(paths, stagingRoot);
  try {
    lock = await open(paths.lock, "wx", 0o600);
  } catch (error) {
    throw new Error(`Another Urdira runtime preparation is active (${error instanceof Error ? error.message : String(error)}).`);
  }

  try {
    if (await existingRuntime(paths)) return { status: "already_prepared", plan, entrypoint: paths.entrypoint };
    try {
      await access(paths.active_root);
      throw new Error(`Runtime target already exists but is invalid: ${paths.active_root}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Runtime target already exists")) throw error;
    }

    await mkdir(stagingRoot, { recursive: false, mode: 0o700 });
    await writeFile(join(stagingRoot, "package.json"), `${JSON.stringify({
      name: "urdira-private-runtime",
      private: true,
      version: RUNTIME_VERSION,
      dependencies: { [RUNTIME_PACKAGE_NAME]: RUNTIME_VERSION },
      overrides: { "adm-zip": "0.6.0", sharp: "0.35.3" },
      allowScripts: RUNTIME_INSTALL_SCRIPT_APPROVALS,
    }, null, 2)}\n`, { mode: 0o600 });

    const installation = await (options.install ?? defaultInstaller)({ staging_root: stagingRoot, npm_cache: paths.npm_cache });
    const warnings = classifyNpmWarnings(installation.stderr);
    if (warnings.unknown.length > 0) throw new Error(`Runtime preparation reported an undisclosed npm warning: ${warnings.unknown.join(" | ")}`);
    const packageLockSha256 = await validateStagedRuntime(stagingRoot);
    const manifest: RuntimeManifest = {
      manifest_schema_version: 1,
      bootstrap_version: BOOTSTRAP_VERSION,
      runtime_package: RUNTIME_PACKAGE_NAME,
      runtime_version: RUNTIME_VERSION,
      npm_version: installation.npm_version,
      prepared_at: (options.clock ?? (() => new Date().toISOString()))(),
      package_lock_sha256: packageLockSha256,
      acknowledged_npm_warnings: warnings.acknowledged,
    };
    await writeFile(join(stagingRoot, RUNTIME_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(stagingRoot, paths.active_root);
    return { status: "prepared", plan, entrypoint: paths.entrypoint };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await lock.close();
    await rm(paths.lock, { force: true });
  }
}

export async function preparedRuntimeEntrypoint(dataRoot = defaultDataRoot()): Promise<string | undefined> {
  const paths = runtimePaths(dataRoot);
  return await existingRuntime(paths) ? paths.entrypoint : undefined;
}

export interface BootstrapResult {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunBootstrapOptions {
  readonly data_root?: string;
  readonly interactive?: boolean;
  readonly prompt?: (message: string) => Promise<boolean>;
  readonly resolve_entrypoint?: (dataRoot?: string) => Promise<string | undefined>;
  readonly prepare_runtime?: (options: PrepareRuntimeOptions) => Promise<PrepareRuntimeResult>;
  readonly execute_runtime?: (entrypoint: string, argv: readonly string[]) => Promise<number>;
}

export function formatRuntimePreparationPlan(plan: RuntimePreparationPlan): string {
  return [
    `Urdira runtime ${plan.package_version} is not prepared.`,
    `Target: ${plan.target_root}`,
    `Registry: ${plan.registry}`,
    `Package: ${plan.package_name}@${plan.package_version}`,
    `Required npm: >=${plan.minimum_npm_version}`,
    "Reviewed installation scripts:",
    ...plan.install_scripts.map((script) => `  - ${script}`),
    "Known upstream notice:",
    ...plan.known_upstream_notices.map((notice) => `  - ${notice}`),
  ].join("\n");
}

export function bootstrapHelp(): string {
  return `Urdira ${BOOTSTRAP_VERSION}\n\nUsage:\n  urdira --version\n  urdira --help\n  urdira runtime status\n  urdira runtime prepare --dry-run\n  urdira runtime prepare --confirm\n  urdira <runtime command>\n\nThe dependency-free bootstrap prepares the exact matching runtime only after explicit confirmation.\n`;
}

async function executeRuntimeProcess(entrypoint: string, argv: readonly string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...argv], { stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal !== null) reject(new Error(`Urdira runtime terminated by ${signal}.`));
      else resolvePromise(code ?? 1);
    });
  });
}

export async function runBootstrap(argv: readonly string[], options: RunBootstrapOptions = {}): Promise<BootstrapResult> {
  if (argv.length === 0 || (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h"))) return { exit_code: 0, stdout: bootstrapHelp(), stderr: "" };
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) return { exit_code: 0, stdout: `${BOOTSTRAP_VERSION}\n`, stderr: "" };

  const dataRoot = options.data_root ?? defaultDataRoot();
  const resolveEntrypoint = options.resolve_entrypoint ?? preparedRuntimeEntrypoint;
  const prepare = options.prepare_runtime ?? prepareRuntime;
  const execute = options.execute_runtime ?? executeRuntimeProcess;
  const plan = createRuntimePreparationPlan(dataRoot);

  if (argv[0] === "runtime") {
    if (argv.length === 2 && argv[1] === "status") {
      const entrypoint = await resolveEntrypoint(dataRoot);
      return entrypoint === undefined
        ? { exit_code: 1, stdout: `Urdira runtime ${RUNTIME_VERSION} is not prepared.\n`, stderr: "" }
        : { exit_code: 0, stdout: `Urdira runtime ${RUNTIME_VERSION} is prepared at ${entrypoint}.\n`, stderr: "" };
    }
    if (argv[1] === "prepare") {
      if (argv.length !== 3 || (argv[2] !== "--dry-run" && argv[2] !== "--confirm")) {
        return { exit_code: 2, stdout: "", stderr: "Usage: urdira runtime prepare --dry-run | --confirm\n" };
      }
      if (argv[2] === "--dry-run") return { exit_code: 0, stdout: `${formatRuntimePreparationPlan(plan)}\n`, stderr: "" };
      const prepared = await prepare({ data_root: dataRoot, confirm: true });
      return { exit_code: 0, stdout: `Urdira runtime ${RUNTIME_VERSION} ${prepared.status === "already_prepared" ? "was already prepared" : "is prepared"}.\n`, stderr: "" };
    }
    return { exit_code: 2, stdout: "", stderr: "Usage: urdira runtime status | runtime prepare --dry-run | --confirm\n" };
  }

  let entrypoint = await resolveEntrypoint(dataRoot);
  if (entrypoint === undefined) {
    if (!(options.interactive ?? false) || options.prompt === undefined) {
      return {
        exit_code: 2,
        stdout: "",
        stderr: `${formatRuntimePreparationPlan(plan)}\nRun 'urdira runtime prepare --dry-run', then 'urdira runtime prepare --confirm'.\n`,
      };
    }
    const confirmed = await options.prompt(`${formatRuntimePreparationPlan(plan)}\nPrepare this runtime now? [y/N] `);
    if (!confirmed) return { exit_code: 2, stdout: "", stderr: "Runtime preparation was not confirmed.\n" };
    const prepared = await prepare({ data_root: dataRoot, confirm: true });
    if (prepared.status === "preview") throw new Error("Confirmed runtime preparation returned a preview instead of an active runtime.");
    entrypoint = prepared.entrypoint;
  }

  if (entrypoint === undefined) throw new Error("Runtime preparation completed without an entry point.");
  return { exit_code: await execute(entrypoint, argv), stdout: "", stderr: "" };
}
