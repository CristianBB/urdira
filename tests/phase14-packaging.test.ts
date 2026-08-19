import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_PRODUCTION_PATTERNS,
  PRODUCTION_PACKAGE_NAMES,
  RELEASE_GATES,
  SUPPORTED_TARGETS,
  buildReleaseMetadata,
  readReleaseConfig,
  sha256,
  validateReleaseConfig,
} from "../scripts/release-contract.mjs";

describe("Phase 14 release contract", () => {
  it("declares the closed target matrix and production package allowlist", async () => {
    const config = await readReleaseConfig();
    expect(validateReleaseConfig(config)).toEqual([]);
    expect((config["targets"] as { id: string }[]).map((target) => target.id)).toEqual(SUPPORTED_TARGETS);
    expect(config["production_packages"]).toEqual(PRODUCTION_PACKAGE_NAMES);
    expect(config["gates"]).toEqual(RELEASE_GATES);
  });

  it("pins the runtime, watcher, dependency, and configure-time model policy", async () => {
    const config = await readReleaseConfig();
    expect(config["runtime"]).toMatchObject({ node: "24.18.1", pnpm: "11.20.0", sqlite: "node:sqlite", watcher: "@parcel/watcher@2.6.0" });
    expect(config["semantic_model"]).toMatchObject({ model_id: "Xenova/all-MiniLM-L6-v2", acquisition: "configure_time_download", bundled_assets: false });
    expect(Object.values(config["dependencies"] as Record<string, string>).every((value) => !/[~^*]|workspace:/u.test(value))).toBe(true);
  });

  it("rejects development and synthetic payloads while allowing the official analyzer/compiler closure", () => {
    for (const path of ["packages/testkit/dist/index.js", "tests/phase14.test.ts", "synthetic-workers.js", "plugins/example.urdira-plugin/manifest.json", "language-plugin/typescript/index.js"]) {
      expect(FORBIDDEN_PRODUCTION_PATTERNS.some((pattern) => pattern.test(path)), path).toBe(true);
    }
    expect(FORBIDDEN_PRODUCTION_PATTERNS.some((pattern) => pattern.test("node_modules/typescript/lib/tsc.js"))).toBe(false);
    expect(FORBIDDEN_PRODUCTION_PATTERNS.some((pattern) => pattern.test("packages/plugin-javascript-typescript/dist/index.js"))).toBe(false);
    expect(FORBIDDEN_PRODUCTION_PATTERNS.some((pattern) => pattern.test("packages/engine/dist/index.js"))).toBe(false);
  });

  it("builds stable release metadata and checksums", () => {
    const metadata = buildReleaseMetadata({ gitCommit: "abc123", lockfileDigest: sha256("lock") });
    expect(metadata).toMatchObject({ release_schema_version: 1, git_commit: "abc123", semantic_model: { model_id: "Xenova/all-MiniLM-L6-v2", bundled_assets: false }, gates: RELEASE_GATES });
    expect(sha256("same")).toBe(sha256("same"));
  });

});
