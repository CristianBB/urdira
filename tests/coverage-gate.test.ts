import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface CoverageGate {
  readonly version: number;
  readonly minimum_repository_line_percent: number;
  readonly critical_branch_percent: number;
  readonly critical_branch_regions?: ReadonlyArray<{ readonly module: string; readonly start_line: number; readonly end_line: number }>;
  readonly required_modules: ReadonlyArray<{ readonly module: string; readonly tests: ReadonlyArray<string>; readonly required_behaviors: ReadonlyArray<string> }>;
}

describe("machine-readable coverage gate", () => {
  it("declares every required Phase 5, Phase 7, and Phase 8 module behavior and its tests", async () => {
    const root = process.cwd();
    const gate = JSON.parse(await readFile(join(root, "architecture", "coverage-gate.json"), "utf8")) as CoverageGate;
    const expectedModules = [
      "packages/storage/src/lifecycle.ts",
      "packages/storage/src/projections.ts",
      "packages/storage/src/storage.ts",
      "packages/storage/src/faults.ts",
      "packages/engine/src/errors.ts",
      "packages/engine/src/workspaces.ts",
      "packages/engine/src/source-provider.ts",
      "packages/engine/src/directory-provider.ts",
      "packages/engine/src/git-providers.ts",
      "packages/engine/src/watchers.ts",
      "packages/engine/src/reconciliation.ts",
      "packages/engine/src/source-batch-digest.ts",
      "packages/engine/src/source-indexer.ts",
      "packages/storage/src/source-index.ts",
      "packages/plugin-sdk/src/errors.ts",
      "packages/plugin-sdk/src/canonical.ts",
      "packages/plugin-sdk/src/semver.ts",
      "packages/plugin-sdk/src/packages.ts",
      "packages/plugin-sdk/src/resolution.ts",
      "packages/plugin-sdk/src/registry.ts",
      "packages/plugin-sdk/src/analysis-context.ts",
      "packages/plugin-sdk/src/access-manifest.ts",
      "packages/plugin-sdk/src/invalidation.ts",
      "packages/plugin-sdk/src/protocol.ts",
      "packages/plugin-sdk/src/supervisor.ts",
      "packages/plugin-sdk/src/sandbox.ts",
      "packages/plugin-sdk/src/port-boundary.ts",
      "packages/plugin-sdk/src/index.ts",
      "packages/testkit/src/synthetic-workers.ts"
    ];
    expect(gate.version).toBe(1);
    expect(gate.minimum_repository_line_percent).toBeGreaterThanOrEqual(90);
    expect(gate.critical_branch_percent).toBe(100);
    expect(gate.required_modules.map((required) => required.module)).toEqual(expect.arrayContaining(expectedModules));
    for (const required of gate.required_modules) {
      const source = (await Promise.all(required.tests.map((test) => readFile(join(root, test), "utf8")))).join("\n");
      expect(required.module).toMatch(/^packages\/(?:engine|storage|plugin-sdk|testkit)\/src\//);
      for (const behavior of required.required_behaviors) expect(source).toContain(behavior);
    }
  });

  it("measures the whole repository source tree instead of a narrowed package subset", async () => {
    const root = process.cwd();
    const gate = JSON.parse(await readFile(join(root, "architecture", "coverage-gate.json"), "utf8")) as { coverage_scope?: ReadonlyArray<string> };
    expect(gate.coverage_scope).toContain("repository");
  });

  it("enforces the complete semantic publication-authority call graph", async () => {
    const root = process.cwd();
    const gate = JSON.parse(await readFile(join(root, "architecture", "coverage-gate.json"), "utf8")) as CoverageGate;
    const authorityRegion = gate.critical_branch_regions?.find((region) => region.module === "packages/storage/src/publication-authority.ts");
    expect(authorityRegion).toEqual(expect.objectContaining({ start_line: 55 }));
    expect(authorityRegion?.end_line).toBeGreaterThanOrEqual(771);
  });
});
