import { defineConfig } from "vitest/config";

const isCi = process.env["CI"] === "true";
const isWindowsCi = isCi && process.platform === "win32";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./tests/global-setup.ts"],
    passWithNoTests: false,
    exclude: ["tests/phase14-release-suite.test.ts"],
    maxWorkers: isCi ? 2 : undefined,
    testTimeout: isWindowsCi ? 120_000 : isCi ? 30_000 : 5_000,
    hookTimeout: isWindowsCi ? 120_000 : isCi ? 30_000 : 10_000,
    // v4 (P4-b-2, default flip): production default is now v4 unless
    // `URDIRA_V4=0` (`packages/daemon/src/runtime.ts`'s `isV4Enabled`). The
    // overwhelming majority of this suite's pre-existing daemon/storage
    // tests start a `DaemonRuntime`/`DurableStorage` to exercise unrelated
    // v3 behavior and never wire a `resolve_workspace_scan_transport` --
    // under the new production default those would try, and fail, to
    // bootstrap and scan a v4 workspace. Setting the suite-wide baseline
    // back to `"0"` here preserves every pre-existing test's original,
    // v4-unrelated behavior; a test that specifically wants the v4 route
    // (or wants to exercise the real production default) still sets
    // `process.env.URDIRA_V4` itself at runtime, exactly as before this
    // change (see e.g. tests/phase-daemon-v4-scan.test.ts).
    env: { URDIRA_V4: "0" },
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
      // v8's default only writes coverage/coverage-final.json when every test
      // passes. `pnpm test:coverage` -> `pnpm check:coverage-gate` needs that
      // file to exist even when an UNRELATED test fails elsewhere in the
      // suite (full-suite runs routinely carry a few pre-existing/flaky
      // failures at any given time; see
      // docs/evidence/2026-09-04-v4-p4-b-prep-health.md Part 3), otherwise
      // the gate script has nothing to read and the whole measurement is
      // silently skipped rather than reporting the real percentage.
      reportOnFailure: true,
    },
  },
});
