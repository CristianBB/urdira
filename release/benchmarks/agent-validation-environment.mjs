/** Benchmark-only prerequisites; does not install dependencies or invoke a model. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

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
