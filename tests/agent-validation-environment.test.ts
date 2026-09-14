import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assessAgentValidationEnvironment, inspectAgentValidationEnvironment, isCurrentStructuralFrontier } from "../release/benchmarks/agent-validation-environment.mjs";

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
