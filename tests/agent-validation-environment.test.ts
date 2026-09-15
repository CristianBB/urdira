import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assessAgentValidationEnvironment, inspectAgentValidationEnvironment, isCurrentStructuralFrontier, materializeAgentDependencyClosure } from "../release/benchmarks/agent-validation-environment.mjs";

describe("agent validation preflight", () => {
  it("rejects a stale login-shell runtime even if the driver has a valid runtime", () => {
    expect(assessAgentValidationEnvironment({ shell: "/bin/zsh", node_version: "v11.0.0", missing_dependencies: [] })).toMatchObject({ ready: false, reasons: ["agent_node_version_unsupported"] });
  });
  it("retains missing test prerequisites before any model invocation", () => {
    expect(assessAgentValidationEnvironment({ shell: "/bin/zsh", node_version: "v24.18.1", missing_dependencies: ["package.json:vitest"] })).toMatchObject({ ready: false, reasons: ["declared_dependencies_missing"] });
    expect(assessAgentValidationEnvironment({ shell: "/bin/zsh", node_version: null, missing_dependencies: [] }).ready).toBe(false);
  });
  it("accepts an observed supported runtime with available declared dependencies", () => {
    expect(assessAgentValidationEnvironment({ shell: "/bin/zsh", node_version: "v24.18.1", missing_dependencies: [] })).toMatchObject({ ready: true, reasons: [] });
  });
  it("rejects a missing executable referenced by a package validation script", () => {
    expect(assessAgentValidationEnvironment({ shell: "/bin/zsh", node_version: "v24.18.1", missing_dependencies: [], missing_runtime_artifacts: ["package.json:node_modules/@typescript/native/lib/tsc.js"] })).toMatchObject({ ready: false, reasons: ["script_runtime_artifacts_missing"] });
  });
  it("checks the runtime explicitly injected into the isolated agent shell", () => {
    const worktree = mkdtempSync(join(tmpdir(), "urdira-agent-validation-"));
    writeFileSync(join(worktree, "package.json"), "{}\n");
    const result = inspectAgentValidationEnvironment(worktree, [], "/bin/zsh", process.execPath);
    expect(result).toMatchObject({
      node_executable: process.execPath,
      node_version: process.version,
      ready: true,
      reasons: [],
    });
  });
  it("checks executable paths referenced by validation scripts after cleanup", () => {
    const worktree = mkdtempSync(join(tmpdir(), "urdira-agent-validation-script-"));
    writeFileSync(join(worktree, "package.json"), JSON.stringify({ scripts: { check: "node ./node_modules/@toolchain/compiler.js" } }));
    const result = inspectAgentValidationEnvironment(worktree, [], "/bin/zsh", process.execPath);
    expect(result.ready).toBe(false);
    expect(result.missing_runtime_artifacts).toContain("package.json:./node_modules/@toolchain/compiler.js");
    expect(result.reasons).toContain("script_runtime_artifacts_missing");
  });

  it("materializes each frozen dependency layout inside the fresh worktree", async () => {
    const source = mkdtempSync(join(tmpdir(), "urdira-dependency-source-"));
    const worktree = mkdtempSync(join(tmpdir(), "urdira-dependency-worktree-"));
    for (const repositoryId of ["playwright", "prisma", "vscode"]) {
      const repoSource = join(source, repositoryId);
      const repoWorktree = join(worktree, repositoryId);
      mkdirSync(repoSource, { recursive: true });
      mkdirSync(repoWorktree, { recursive: true });
      writeFileSync(join(repoSource, repositoryId === "prisma" ? "pnpm-lock.yaml" : "package-lock.json"), `lock-${repositoryId}\n`);
      writeFileSync(join(repoWorktree, repositoryId === "prisma" ? "pnpm-lock.yaml" : "package-lock.json"), `lock-${repositoryId}\n`);
      if (repositoryId === "vscode") {
        mkdirSync(join(repoSource, "extensions/node_modules"), { recursive: true });
        mkdirSync(join(repoWorktree, "extensions/typescript-language-features"), { recursive: true });
        writeFileSync(join(repoSource, "extensions/node_modules/.package-lock.json"), "snapshot-lock\n");
        writeFileSync(join(repoWorktree, "extensions/package-lock.json"), "committed-extension-lock\n");
        writeFileSync(join(repoWorktree, "package-lock.json"), "root-lock\n");
        writeFileSync(join(repoWorktree, "extensions/typescript-language-features/package-lock.json"), "nested-lock\n");
      }
      const calls: { command: string; args: string[]; cwd: string; env: Record<string, string> }[] = [];
      const setup = await materializeAgentDependencyClosure({ repositoryId, repositoryRoot: repoSource, worktree: repoWorktree, nodeExecutable: "/runtime/node", run: async (command, args, options) => { calls.push({ command, args, cwd: String(options?.["cwd"]), env: options?.["env"] as Record<string, string> }); return { code: 0, signal: null, stdout: args[0] === "pnpm@10.27.0" ? "10.27.0\n" : "11.16.0\n", stderr: "" }; } });
      expect(setup.prepared_roots).toHaveLength(repositoryId === "vscode" ? 3 : 1);
      expect(calls.every((call) => call.cwd.startsWith(repoWorktree))).toBe(true);
      expect(calls.every((call) => !call.cwd.startsWith(repoSource))).toBe(true);
      expect(calls.every((call) => Object.values(call.env).every((value) => value.startsWith(repoWorktree)))).toBe(true);
      if (repositoryId === "prisma") expect(calls.some((call) => call.args.includes("--frozen-lockfile") && !call.args.includes("--offline"))).toBe(true);
      const firstRoot = setup.prepared_roots[0];
      expect(firstRoot).toBeDefined();
      expect(readFileSync(firstRoot!.source_lockfile, "utf8")).toContain("lock");
      if (repositoryId === "vscode") expect(readFileSync(join(repoWorktree, "extensions/package-lock.json"), "utf8")).toBe("committed-extension-lock\n");
      expect(setup.commands).toHaveLength(calls.length);
    }
  });

  it("uses the generated snapshot only when the extension lockfile is absent", async () => {
    const source = mkdtempSync(join(tmpdir(), "urdira-dependency-snapshot-source-"));
    const worktree = mkdtempSync(join(tmpdir(), "urdira-dependency-snapshot-worktree-"));
    mkdirSync(join(source, "extensions/node_modules"), { recursive: true });
    mkdirSync(join(worktree, "extensions/typescript-language-features"), { recursive: true });
    writeFileSync(join(source, "package-lock.json"), "root-lock\n");
    writeFileSync(join(worktree, "package-lock.json"), "root-lock\n");
    writeFileSync(join(source, "extensions/node_modules/.package-lock.json"), "snapshot-lock\n");
    writeFileSync(join(worktree, "extensions/typescript-language-features/package-lock.json"), "nested-lock\n");
    const setup = await materializeAgentDependencyClosure({ repositoryId: "vscode", repositoryRoot: source, worktree, nodeExecutable: "/runtime/node", run: async (_command, args) => ({ code: 0, signal: null, stdout: args[0] === "pnpm@10.27.0" ? "10.27.0\n" : "11.16.0\n", stderr: "" }) });
    const extensionRoot = setup.prepared_roots.find((entry) => entry.relative_path === "extensions");
    expect(extensionRoot).toBeDefined();
    expect(extensionRoot!.source_lockfile).toBe(join(source, "extensions/node_modules/.package-lock.json"));
    expect(readFileSync(extensionRoot!.source_lockfile, "utf8")).toBe("snapshot-lock\n");
    expect(existsSync(join(worktree, "extensions/package-lock.json"))).toBe(false);
  });
});


describe("structural benchmark readiness", () => {
  const ready = {
    structural_ready: true, source_ready: true,
    source_completeness: "complete", structural_completeness: "complete",
    source_freshness: "equivalent", structural_freshness: "equivalent",
    source_snapshot_id: "source-snapshot:13", structural_source_snapshot_id: "source-snapshot:13",
    source_build_state: "idle", structural_build_state: "idle",
    freshness_status: "indexing", semantic_build_state: "building",
  };
  it("uses complete matching source and structural frontiers independently of semantics", () => {
    expect(isCurrentStructuralFrontier(ready)).toBe(true);
  });
  it("rejects missing, stale, building, incomplete or mismatched frontiers", () => {
    expect(isCurrentStructuralFrontier(undefined)).toBe(false);
    for (const change of [
      { source_freshness: "stale" }, { structural_freshness: "unknown" },
      { source_build_state: "building" }, { structural_build_state: "building" },
      { source_completeness: "partial" }, { structural_completeness: "partial" },
      { structural_source_snapshot_id: "source-snapshot:12" }, { source_snapshot_id: undefined },
    ]) expect(isCurrentStructuralFrontier({ ...ready, ...change })).toBe(false);
  });
});
