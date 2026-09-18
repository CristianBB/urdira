import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const baseExclusions = baseConfig.test?.exclude ?? [];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    // Campaigns, measurements, and corpus-scale harnesses are deliberately
    // local-only. CI still runs the product unit, contract, and small
    // integration suites through the base include pattern.
    exclude: [
      ...baseExclusions,
      "tests/*benchmark*.test.ts",
      "tests/*campaign*.test.ts",
      "tests/*measurement*.test.ts",
      "tests/analyze-agent-matched.test.ts",
      "tests/codex-host-evidence.test.ts",
      "tests/query-microbenchmark.test.ts",
      "tests/replay-agent-context.test.ts",
      "tests/v4-mutation-harness.test.ts",
    ],
  },
});
