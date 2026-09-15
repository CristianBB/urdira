# Definitive agent orchestrator correction

This evidence records the offline correction to the definitive benchmark
orchestrator. It does not report a new benchmark cell, model invocation, or
readiness probe.

## Defects and regressions

The focused regressions reproduced four failure classes before the fixes:

- cleanup exceptions masked the original cell failure and prevented the audit;
- readiness worktree/phase setup failures lost the cold and blocked-warm rows;
- invalid Codex first/resume arguments were not checked before worktree/cell
  creation;
- outer driver, runner, and readiness runtime or binding failures could exit
  before a durable manifest existed.

The regression suite also checks cleanup blocking, capture errors, signal and
timeout output retention, non-default timeout propagation, and the shared
first/resume argv builder. The focused result is **35/35 tests passed**.

## Correction

`expanded-agent-codex-argv.mjs` is now the single production builder for
Codex `exec`, `exec resume`, and arm-specific MCP arguments. The orchestrator
runs both generated argv forms with `--help` only before creating a cell
worktree. The diagnostic retains binary path, version, SHA-256, argv, stdout,
stderr, status, and parser failure. The effective per-cell supervisor timeout
is passed to the runner as `URDIRA_BENCHMARK_TIMEOUT_MS` and feeds MCP timeout
construction.

Cleanup is unconditional and records the original execution error separately
from a cleanup error. Readiness retains cold and blocked-warm rows for setup,
worktree, and phase failures. Runtime, release-binding, frozen-model, timeout,
and free-space preflight failures retain `model_invoked: false` envelopes
before a cell or probe starts.

## Verification

- `CI=true pnpm typecheck` — passed.
- Targeted ESLint over the changed benchmark modules and tests — passed.
- Related focused suites — 8 files, 123 tests passed.
- `CI=true pnpm verify` — passed. stdout log SHA-256:
  `193fddf320ba1be4eecb2e7c31caee5ca19f9230974f034a71ca0eb93dd710a4`;
  stderr log SHA-256:
  `862f9e5c5274e1db93d53a15ff538ed36d7ea3482fd3bf9f02bdd652abd4667e`.
- `URDIRA_RELEASE_TARGET=darwin-arm64 pnpm package:release` — passed. stdout
  SHA-256 `a702536bd7ebe25a1705a80ccb272af939131a12a354b4ba3502ffe07322ef75`;
  stderr SHA-256 `ea66be16e7e8d99813ccbe29de831ed1a434fa5ed0fe84885d5972795dd56d36`.
- `URDIRA_RELEASE_TARGET=darwin-arm64 pnpm release:acceptance` — passed. stdout
  SHA-256 `606ac36b84336d8f332da217a0276fb63bf6fa7f197d8e35e21d8677d9866696`;
  stderr SHA-256 `62ebcde7919e6bb90c422dad33e37186b824101f687188029ab75bc90f42580e`.
- `git diff --check` — passed. Log SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

Logs are retained under
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/` with
the `orchestrator-*-v9` names. No campaign, model, probe, retry, or historical
raw artifact was started or changed by this correction.

## Frozen dependency closure follow-up

The definitive source closure includes a committed VS Code
`extensions/package-lock.json` and a read-only generated snapshot at
`extensions/node_modules/.package-lock.json`. Dependency preparation uses the
committed lockfile when it is present in a fresh worktree and removes a
lockfile only when the helper created it as a snapshot fallback. This keeps
the lockfile available for agent validation and preserves the source checkout
contract.

The regression first failed because the helper removed the committed extension
lockfile during cleanup. The focused test passed after the minimal
fallback-only cleanup change. A production-path VS Code worktree using the
current helper passed dependency setup and validation with zero missing
dependencies, preserved the lockfile bytes and digest, and cleaned its
worktree and cache. No model, runner, or benchmark cell was started.
