/** Benchmark-only prerequisites; does not install dependencies or invoke a model. */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const FROZEN_DEPENDENCY_LAYOUTS = Object.freeze({
  playwright: Object.freeze([{ relative_path: ".", lockfile: "package-lock.json", manager: "npm" }]),
  prisma: Object.freeze([{ relative_path: ".", lockfile: "pnpm-lock.yaml", manager: "pnpm" }]),
  vscode: Object.freeze([
    { relative_path: ".", lockfile: "package-lock.json", manager: "npm" },
    // Keep a generated npm lock snapshot available for a checkout that lacks
    // the committed extension lockfile; it is used only as a fallback.
    { relative_path: "extensions", lockfile: "package-lock.json", snapshot_lockfile: "extensions/node_modules/.package-lock.json", manager: "npm" },
    { relative_path: "extensions/typescript-language-features", lockfile: "package-lock.json", manager: "npm" },
  ]),
});

const hashFile = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function defaultDependencyRunner(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, encoding: "utf8" });
  return { code: result.status ?? 1, signal: result.signal ?? null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function executableInNodeBin(nodeExecutable, name) {
  const candidate = join(dirname(resolve(nodeExecutable)), name);
  return existsSync(candidate) ? candidate : name;
}

function dependencyLinks(root, sourceRoot) {
  const links = [];
  const sourcePrefix = `${resolve(sourceRoot)}${String.fromCharCode(47)}`;
  const scan = (nodeModules) => {
    if (!existsSync(nodeModules)) return;
    for (const entry of readdirSync(nodeModules)) {
      const entryPath = join(nodeModules, entry);
      const stats = lstatSync(entryPath);
      if (stats.isSymbolicLink()) {
        const realpath = realpathSync(entryPath);
        if (realpath === resolve(sourceRoot) || realpath.startsWith(sourcePrefix)) throw new Error(`Dependency link escapes fresh worktree: ${entryPath} -> ${realpath}`);
        links.push({ path: entryPath, realpath });
        continue;
      }
      if (!stats.isDirectory()) continue;
      if (entry.startsWith("@")) { scan(entryPath); continue; }
      scan(join(entryPath, "node_modules"));
    }
  };
  scan(join(root, "node_modules"));
  return links;
}

function measureBytes(path) {
  if (!existsSync(path)) return 0;
  const stats = lstatSync(path);
  if (!stats.isDirectory()) return stats.size;
  return readdirSync(path).reduce((total, entry) => total + measureBytes(join(path, entry)), 0);
}

/**
 * Install the frozen dependency closure inside a newly-created worktree.
 * The source checkout is read only; no node_modules tree is linked or shared.
 * A generated npm lock snapshot is used only for VS Code's lockless
 * extensions package and is removed after npm ci completes.
 */
export async function materializeAgentDependencyClosure({ repositoryId, repositoryRoot, worktree, nodeExecutable = process.execPath, run = defaultDependencyRunner }) {
  const layouts = FROZEN_DEPENDENCY_LAYOUTS[repositoryId];
  if (!layouts) throw new Error(`No frozen dependency layout for ${repositoryId}`);
  const commands = [];
  const preparedRoots = [];
  const startedAt = performance.now();
  for (const layout of layouts) {
    const targetRoot = resolve(worktree, layout.relative_path);
    const lockfilePath = join(targetRoot, layout.lockfile);
    let temporaryLockfile = false;
    let sourceLockfile = lockfilePath;
    if (layout.snapshot_lockfile) {
      const snapshotLockfile = resolve(repositoryRoot, layout.snapshot_lockfile);
      if (existsSync(lockfilePath)) {
        // Prefer a committed lockfile in the fresh worktree. The generated
        // snapshot is only a fallback for the lockless layout it supports.
        sourceLockfile = lockfilePath;
      } else {
        if (!existsSync(snapshotLockfile)) throw new Error(`Frozen dependency snapshot is missing: ${snapshotLockfile}`);
        mkdirSync(targetRoot, { recursive: true });
        cpSync(snapshotLockfile, lockfilePath, { force: false });
        sourceLockfile = snapshotLockfile;
        temporaryLockfile = true;
      }
    }
    if (!existsSync(lockfilePath)) throw new Error(`Frozen dependency lockfile is missing: ${lockfilePath}`);
    const manager = layout.manager === "pnpm" ? executableInNodeBin(nodeExecutable, "corepack") : executableInNodeBin(nodeExecutable, "npm");
    const cacheRoot = join(worktree, ".bench-cache", layout.relative_path === "." ? "root" : layout.relative_path);
    const nodeBin = dirname(resolve(nodeExecutable));
    const cacheEnvironment = {
      PATH: [nodeBin, process.env.PATH].filter(Boolean).join(delimiter),
      npm_config_cache: join(cacheRoot, "npm-cache"),
      npm_config_store_dir: join(cacheRoot, "pnpm-store"),
      COREPACK_HOME: join(cacheRoot, "corepack"),
    };
    mkdirSync(cacheRoot, { recursive: true });
    const runOptions = { cwd: targetRoot, env: cacheEnvironment };
    const versionArgs = layout.manager === "pnpm" ? ["pnpm@10.27.0", "--version"] : ["--version"];
    const versionResult = await run(manager, versionArgs, { ...runOptions, phase: "dependency-setup-version" });
    commands.push({ cwd: targetRoot, command: manager, args: versionArgs, env: cacheEnvironment, code: versionResult.code, signal: versionResult.signal ?? null, stdout: versionResult.stdout ?? "", stderr: versionResult.stderr ?? "" });
    const managerVersion = String(versionResult.stdout ?? "").trim();
    if (versionResult.code !== 0 || (layout.manager === "pnpm" && managerVersion !== "10.27.0")) throw new Error(`Frozen dependency manager mismatch in ${targetRoot}: expected ${layout.manager === "pnpm" ? "pnpm 10.27.0" : "npm"}, received ${managerVersion || versionResult.stderr}`);
    const args = layout.manager === "pnpm"
      ? ["pnpm@10.27.0", "install", "--frozen-lockfile", "--ignore-scripts"]
      : ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];
    const result = await run(manager, args, { ...runOptions, phase: "dependency-setup" });
    commands.push({ cwd: targetRoot, command: manager, args, env: cacheEnvironment, code: result.code, signal: result.signal ?? null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
    try {
      if (result.code !== 0) throw new Error(`Dependency setup failed in ${targetRoot}: ${result.stderr || result.stdout}`);
    } finally {
      if (temporaryLockfile) rmSync(lockfilePath, { force: true });
    }
    const lockBytes = statSync(sourceLockfile).size;
    const links = dependencyLinks(targetRoot, repositoryRoot);
    preparedRoots.push({ relative_path: layout.relative_path, root: targetRoot, root_realpath: realpathSync(targetRoot), lockfile: lockfilePath, source_lockfile: sourceLockfile, lockfile_bytes: lockBytes, lockfile_sha256: hashFile(sourceLockfile), manager, manager_version: managerVersion, dependency_links: links, cache_root: cacheRoot, cache_environment: cacheEnvironment, cache_bytes: measureBytes(cacheRoot) });
  }
  const closure_sha256 = createHash("sha256").update(JSON.stringify(preparedRoots)).digest("hex");
  return { repository_id: repositoryId, source_root: resolve(repositoryRoot), worktree: resolve(worktree), prepared_roots: preparedRoots, closure_sha256, commands, setup_elapsed_ms: performance.now() - startedAt };
}

export function assessAgentValidationEnvironment(observation) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(observation.node_version ?? "");
  const [major, minor, patch] = match ? match.slice(1).map(Number) : [];
  const supported = match !== null && (major > 24 || major === 24 && (minor > 18 || minor === 18 && patch >= 1));
  const missingDependencies = observation.missing_dependencies ?? [];
  const missingRuntimeArtifacts = observation.missing_runtime_artifacts ?? [];
  const reasons = [
    ...(supported ? [] : ["agent_node_version_unsupported"]),
    ...(missingDependencies.length === 0 ? [] : ["declared_dependencies_missing"]),
    ...(missingRuntimeArtifacts.length === 0 ? [] : ["script_runtime_artifacts_missing"]),
  ];
  return { ...observation, missing_dependencies: missingDependencies, missing_runtime_artifacts: missingRuntimeArtifacts, ready: reasons.length === 0, reasons };
}

export function inspectAgentValidationEnvironment(worktree, targetPaths, shell = process.env.SHELL ?? "/bin/sh", nodeExecutable = "node") {
  const runtime = spawnSync(nodeExecutable, ["--version"], { cwd: worktree, encoding: "utf8", timeout: 10000 });
  const packageRoots = new Set([resolve(worktree)]);
  for (const path of targetPaths) {
    let directory = dirname(resolve(worktree, path));
    while (directory === resolve(worktree) || directory.startsWith(`${resolve(worktree)}/`)) {
      if (existsSync(join(directory, "package.json"))) packageRoots.add(directory);
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const missing = [];
  const missingRuntimeArtifacts = [];
  for (const directory of packageRoots) {
    const manifestPath = join(directory, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      let current = directory;
      let found = false;
      while (true) {
        if (existsSync(join(current, "node_modules", dependency))) { found = true; break; }
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
      if (!found) missing.push(`${relative(worktree, manifestPath)}:${dependency}`);
    }
    const scripts = Object.values(manifest.scripts ?? {}).filter((value) => typeof value === "string");
    for (const script of scripts) {
      const references = [...script.matchAll(/(?:^|[\s"'=])((?:\.\.?\/)*node_modules\/[^\s"';&|]+)/gu)].map((match) => match[1].replace(/[),]+$/u, ""));
      for (const reference of references) {
        if (reference.includes("*") || existsSync(resolve(directory, reference))) continue;
        missingRuntimeArtifacts.push(`${relative(worktree, manifestPath)}:${reference}`);
      }
    }
  }
  return assessAgentValidationEnvironment({ shell, node_executable: nodeExecutable, node_version: runtime.status === 0 ? runtime.stdout.trim() : null, missing_dependencies: missing.sort(), missing_runtime_artifacts: [...new Set(missingRuntimeArtifacts)].sort() });
}

export function isCurrentStructuralFrontier(entry) {
  const current = (value) => value === "current" || value === "equivalent";
  return entry?.source_ready === true && entry?.structural_ready === true
    && entry.source_completeness === "complete" && entry.structural_completeness === "complete"
    && entry.source_build_state === "idle" && entry.structural_build_state === "idle"
    && current(entry.source_freshness) && current(entry.structural_freshness)
    && typeof entry.source_snapshot_id === "string"
    && entry.source_snapshot_id === entry.structural_source_snapshot_id;
}
