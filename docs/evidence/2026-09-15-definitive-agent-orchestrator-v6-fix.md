# Definitive agent orchestrator v6 failure-retention fix

This evidence records an offline correction after the retained v6 campaign
attempt. It does not report a new benchmark cell, model invocation, retry, or
readiness probe.

## Reproduced defects

The pre-fix focused run was executed with:

```text
CI=true pnpm exec vitest run tests/definitive-agent-campaign.test.ts tests/expanded-benchmark-smoke.test.ts --maxWorkers=2
```

Its tool transcript recorded 35 passing tests and two failures: the first
Codex failure did not expose `codex_invocations`, and the installed Urdira
preflight failure did not leave a durable manifest. No external log was
created for that transient run, so no SHA-256 is asserted for it.

The retained v6 Urdira stderr separately proves that the old runner invoked
the unregistered `urdira --version` command. The baseline cell's empty
transcript and absent host evidence do not prove that a provider model request
was made.

## Correction

`expanded-agent-benchmark-runner.mjs` now uses
`urdira-installed-cli-preflight.mjs` to validate the installed release parser
with the metadata-only `status --json` command. This validation records the
launcher digest and does not start a daemon or model. Each Codex invocation
now spools stdout and stderr from process start, records bytes and SHA-256,
and retains capture errors. A non-null spool error fails closed before parsing
or grading. Failure-manifest persistence runs after cleanup and retains the
original execution error separately from cleanup failure. If Codex has already
returned a process result, a later JSONL/parser failure records
`model_invoked:true`; a spawn failure remains unknown rather than being
coerced to false.

## Verification

- `CI=true pnpm exec vitest run tests/definitive-agent-campaign.test.ts tests/expanded-benchmark-smoke.test.ts --maxWorkers=2` — 58/58 passed after the capture-error and invocation-state regressions. Final log: `/Users/Cristian/BenchmarkResults/urdira-orchestrator-fix-20260915/focused-green-v3.log`, SHA-256 `639b7165e0584ce8bc049703d97b649868d485e44fcbef5bceaad26c42b667d6`.
- Direct ESLint and `node --check` over the four changed runner/helper/test paths — passed. Log SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- An initial `pnpm typecheck` passed before the metrics worker changed report files. The current rerun is blocked by that worker's incomplete row types in `tests/expanded-agent-report.test.ts` (lines 199–230); its retained log SHA-256 is `de5739aefb2ad8a4f0df5aafe106a52726017ae57f860ea88add38496b5b74f9`.
- A later `CI=true pnpm verify` was intentionally stopped after
  `check:architecture` began, pending an independent renderer correction.
  Partial log SHA-256 `60c4d5d36d39fe01b77968bbb4fa271e12fec9171cdb2667ebe87f740ec91b99`.

The final gate was rerun after the runner and renderer focused fixes were
stable. `CI=true pnpm verify` passed: 167 test files passed, 2 were skipped;
2,574 tests passed, 17 were skipped; coverage was 90.06% lines and the
publication hygiene gate passed. The final log is
`/Users/Cristian/BenchmarkResults/urdira-orchestrator-fix-20260915/verify-final.log`
with SHA-256
`de1e011a72c5a47320992df0dff175d5364b1805940e5ab5a8bba5a243fe3f35`; its
exit file contains `0` and has SHA-256
`9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa`.

The release gates also passed without starting an agent campaign:

- `URDIRA_RELEASE_TARGET=darwin-arm64 pnpm package:release` passed. The
  archive is retained externally at
  `/Users/Cristian/BenchmarkResults/urdira-orchestrator-fix-20260915/urdira-darwin-arm64-0.3.3.final-gate.tar.gz`,
  183,787,280 bytes, SHA-256
  `81ce6c95ce40b1515599f016f9dbeee2a93a17c8f514a6a1127e9740a7eb4428`.
- `URDIRA_RELEASE_TARGET=darwin-arm64 pnpm release:acceptance` passed all
  10/10 release gates. The retained report is
  `/Users/Cristian/BenchmarkResults/urdira-orchestrator-fix-20260915/phase-14-release.final-gate.json`,
  14,835 bytes, SHA-256
  `5c613726ca1bbc1ece7752f8b5a6ffc1ba33b3a83e0e2bfd535b01b29e08839d`.
  This is the deterministic release acceptance benchmark, not an agent
  campaign result.

The first full verify attempt exposed an intermittent CAS collision failure;
the bounded single-test and 46-test source-frontier suite subsequently passed
(the latter took 162.58 seconds), and the final full verify passed the same
stress test. No native source was changed. Final cleanup inventory recorded
184,709,357 bytes for the retained fix evidence root, 366,161,014,784 bytes
free on the filesystem, and no benchmark/model/cargo/vitest worker or Codex
process.
The final cleanup checkpoint is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v6/cleanup-checkpoint-post-gates-v11.json`,
with its final SHA-256 and retained-file inventory recorded in that checkpoint.
It records removal of the 2,478,406,181-byte source-clone tree, the
571,161,132-byte release extraction, the empty campaign worktree root, and
the workspace copies of the archive/report. The retained fix evidence root is
184,709,357 bytes; free space after cleanup is 366,161,014,784 bytes; the
process inventory has no benchmark, model, cargo, vitest, worker, or Codex
matches. Raw execution manifests/logs, freezes, plans, derived failure
reports, and the external archive/report remain retained.

The v6 external freeze and its raw artifacts remain historical and untouched.
The source change invalidates that measured freeze; no new campaign has been
started.
