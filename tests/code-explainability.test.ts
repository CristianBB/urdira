import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("code explainability guardrails", () => {
  it("keeps full JavaScript/TypeScript analysis as a small coordinator over shared phases", async () => {
    const source = await readFile("packages/plugin-javascript-typescript/src/analyzer.ts", "utf8");
    const start = source.indexOf("export function analyzeProject");
    const end = source.indexOf("// ---------------------------------------------------------------------------\n// Incremental analysis session", start);
    const coordinator = source.slice(start, end);

    expect(coordinator).toContain("walkFiles(");
    expect(coordinator).toContain("assembleAnalysis(");
    expect(coordinator.split("\n").length).toBeLessThan(80);
  });

  it("keeps streamed record materialization out of workspace scan orchestration", async () => {
    const source = await readFile("packages/engine/src/workspace-indexing-session.ts", "utf8");
    const start = source.indexOf("export async function runFullWorkspaceScan");
    const end = source.indexOf("export async function runProgressiveWorkspaceScan", start);
    const coordinator = source.slice(start, end);

    expect(coordinator).toContain("CandidateRecordTemplateAccumulator(");
    expect(coordinator).not.toContain(".digestRecords(");
  });
});
