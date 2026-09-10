# Expanded agent smoke scope — 2026-09-09

The campaign now derives smoke task requirements from `--repositories`.
Prisma alone needs its two Urdira smoke tasks; the full corpus still needs eight.
A successful broader audit can supply selected cells. Missing tasks, duplicates
within the selected scope, failed audits and failed required executions remain
rejected. Expected run totals now sum selected task counts instead of assuming
two tasks per repository. Arm selection and other admission rules are unchanged.

Authority: Decision 08 now explicitly scopes the expanded smoke to selected
repositories. README and the operational runbook include size-based selections.
The earlier preparation report's global eight-task limitation is historical and
superseded by this change. No benchmark campaign or indexing run was launched.

Regression tests invoke the real driver with synthetic audits and absent clone
roots, so admitted cases stop before creating a worktree or launching an agent.
Before the fix: four cases failed with expected=8; three cases passed.
Verification:

- `CI=true pnpm exec vitest run tests/expanded-benchmark-smoke.test.ts`: 7 passed.
- `pnpm exec eslint tests/expanded-benchmark-smoke.test.ts release/benchmarks/run-expanded-agent-benchmark.mjs`: passed.
- `pnpm check:publication`: passed.
- `CI=true pnpm verify`: passed end to end, including native build, fmt/clippy,
  workspace and ignored native suites, lint, coverage, typecheck and publication.
  Vitest: 148 files passed, 2 skipped; 2,276 tests passed, 15 skipped.
  Coverage gate: repository lines 90.16%, critical branches and semantic regions 100%.
- `git diff --check`: passed.

No production package or public API changed. Release archives and release
acceptance were not run: this is benchmark tooling, not a distribution change.
