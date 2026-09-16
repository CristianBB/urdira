import { describe, expect, it } from "vitest";
import { checkMaintainability, collectSourceFiles, runMaintainabilityCheck, summarizeLintResults } from "../scripts/check-maintainability.mjs";
import { discoverDefinitions } from "../packages/engine/src/query-definition-discovery.js";
import { isTestArtifactPath, matchesArtifactGlob, matchesWordMode } from "../packages/engine/src/source-matching.js";

describe("maintainability gate", () => {
  it("counts only the measured rules and keeps file-level attribution", () => {
    const summary = summarizeLintResults(
      [
        {
          filePath: "/repo/packages/example.ts",
          messages: [
            { ruleId: "complexity" },
            { ruleId: "max-depth" },
            { ruleId: "no-undef" },
          ],
        },
      ],
      "/repo",
    );

    expect(summary).toEqual({
      counts: { complexity: 1, "max-depth": 1, "max-lines-per-function": 0 },
      byFile: { "packages/example.ts": { complexity: 1, "max-depth": 1 } },
    });
  });

  it("rejects new or worsened findings and stale debt entries", () => {
    const errors = checkMaintainability(
      {
        counts: { complexity: 2, "max-depth": 0, "max-lines-per-function": 0 },
        byFile: { "packages/new.ts": { complexity: 1 } },
      },
      {
        rules: { complexity: 1, "max-depth": 0, "max-lines-per-function": 0 },
        files: { "packages/removed.ts": { complexity: 1 } },
      },
    );

    expect(errors).toEqual([
      "complexity: 2 findings exceed baseline 1",
      "Baseline entry is stale or resolved: packages/removed.ts",
      "packages/new.ts complexity: 1 findings exceed baseline 0",
    ]);
  });

  it("keeps registry discovery exact and deterministic after extraction", () => {
    const result = discoverDefinitions({ matcher: { text: "call", mode: "exact" } });
    expect(result["definitions"]).toEqual([
      expect.objectContaining({
        value: expect.objectContaining({ definition_type: "record_kind", definition_id: "core:call" }),
        stable_sort_key: ["confirmed", "000000", "core:call"].join("\x00"),
      }),
    ]);
  });

  it("keeps source matching boundaries explicit", () => {
    expect(matchesArtifactGlob("src/domain/task.ts", "src/**/*.ts")).toBe(true);
    expect(matchesArtifactGlob("src/task.js", "src/**/*.ts")).toBe(false);
    expect(isTestArtifactPath("src/__tests__/task.ts")).toBe(true);
    expect(isTestArtifactPath("src/contest.ts")).toBe(false);
    expect(matchesWordMode("run runner", 0, 3, "token")).toBe(true);
    expect(matchesWordMode("run runner", 5, 3, "token")).toBe(false);
  });

  it("excludes generated contracts and fixture trees from the maintained scope", async () => {
    const files = await collectSourceFiles(process.cwd());
    expect(files.some((file) => file.includes("model-contract-source.ts"))).toBe(false);
    expect(files.some((file) => file.includes("/fixtures/") || file.includes("/fixture/"))).toBe(false);
    expect(files.every((file) => !file.includes("/node_modules/") && !file.includes("/dist/"))).toBe(true);
  });

  it("keeps the checked-in baseline synchronized with the current findings", async () => {
    const result = await runMaintainabilityCheck(process.cwd());
    expect(result.errors).toEqual([]);
    for (const [rule, count] of Object.entries(result.summary.counts)) {
      const baselineCount = result.baseline.rules[rule as keyof typeof result.baseline.rules];
      expect(baselineCount, `${rule} must have a ratchet baseline`).toBeDefined();
      expect(count, `${rule} must not exceed its ratchet baseline`).toBeLessThanOrEqual(baselineCount ?? 0);
    }
  });
});
