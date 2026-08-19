import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    passWithNoTests: false,
    exclude: ["tests/phase14-release-suite.test.ts"],
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
