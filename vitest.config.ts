import { defineConfig } from "vitest/config";

const isCi = process.env["CI"] === "true";
const isWindowsCi = isCi && process.platform === "win32";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    passWithNoTests: false,
    exclude: ["tests/phase14-release-suite.test.ts"],
    maxWorkers: isCi ? 2 : undefined,
    testTimeout: isWindowsCi ? 120_000 : isCi ? 30_000 : 5_000,
    hookTimeout: isWindowsCi ? 120_000 : isCi ? 30_000 : 10_000,
    // Coverage runs only under `vitest run --coverage` (pnpm test:coverage).
    // Thresholds are deliberately NOT set here: enforcement lives in
    // scripts/check-coverage-gate.mjs (pnpm check:coverage-gate), which reads
    // coverage/coverage-final.json with its own scoping semantics (repository
    // line floor + 100%-branch critical modules/regions). The measured file
    // set is left at vitest's defaults for the same reason.
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      reportsDirectory: "coverage",
    },
  },
});
