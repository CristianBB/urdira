import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASE_GATES, runReleaseSuite, writeReleaseReport } from "../scripts/release-suite.mjs";

describe("Phase 14 release acceptance suite", () => {
  it("keeps the complete release gate set closed", () => {
    expect(RELEASE_GATES).toEqual(["unit", "contract", "integration", "e2e", "crash", "corruption", "security", "watcher", "benchmark", "package_inspection"]);
  });

  it("writes a digest-bound report and preserves gate status", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase14-report-"));
    const path = join(root, "release.json");
    const report = await writeReleaseReport({ release_schema_version: 1, status: "passed", gates: { unit: { status: "passed" } } }, path);
    expect(report).toMatchObject({ release_schema_version: 1, status: "passed", report_digest: expect.stringMatching(/^sha256:/u) });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(report);
  });

  it("runs the deterministic benchmark and focused acceptance gates on demand", async () => {
    const root = process.cwd();
    const report = await runReleaseSuite({ rootDir: root, outputDir: join(root, "release/artifacts-test"), reportPath: join(root, "release/reports/phase-14-test-report.json"), skipInstall: true });
    expect(report["status"]).toBe("passed");
    expect(report["gates"]).toMatchObject({ benchmark: { status: "passed" }, package_inspection: { status: "passed" } });
  }, 180_000);
});
