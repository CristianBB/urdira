# Playwright context gates v24-v28

Date: 2026-09-13

These are sequential Playwright-only gates on the frozen
`affected-tests-deterministic` task at commit
`1b44f5a441f391538c42c7ce36dd8ce779a5d6a1`. Every model invocation used
`gpt-5.6-luna`, complete structural readiness, and disabled semantic indexing.
The comparison retains failures and uses cumulative-thread token accounting for
the current Codex host.

| Gate | Strict grader | Agent ms | Total tokens | Direct MCP | Disposition |
| --- | ---: | ---: | ---: | ---: | --- |
| v24 | pass | 283,724 | 1,824,478 | 4 | Excluded: the reused checkout contained ignored `test-results` before the run. |
| v25 | pass | 288,931 | 2,118,286 | 4 | Rejected: a 9,000-character prompt budget caused repeated discovery. |
| v26 | fail | 286,324 | 2,515,222 | 9 | Retained failure; the agent selected the wrong focused test path. |
| v27 | pass | 200,086 | 1,527,823 | 5 | Accepted current gate; correct, but not more token-efficient than a comparator. |
| v28 | fail | 248,305 | 2,135,216 | 6 | Retained failure; one invalid `word_mode` query and redundant discovery. |

The 9,000-character prompt experiment was removed and the public client default
remains 40,000 characters, replaceable by the client. V27 is 143.2 percent
above baseline, 76.6 percent above CodeGraph, 40.3 percent above tgrep, and
10.8 percent above codebase-memory for the same frozen task. It therefore does
not support an efficiency-win claim.

V28 verifies that the prompt hook and command hooks must be included in the
tool attribution. Loading its content-free hook audit yields 25 hook
invocations, of which 8 were served, plus 6 direct MCP calls. Urdira supplied
90,032 of 92,504 observed repository-context characters before the first edit,
or 97.3 percent. Shell supplied a focused 2,472-character read. This satisfies
the integration objective that Urdira perform the bulk of discovery, while the
failed query and 2,135,216-token total show that context leadership alone has
not yet produced lower token use.

No pipeline was selected in v27 or v28: all `urdira_query` calls were direct
operations. That is recorded as an adoption result rather than a product
correctness failure. Pipelines remain available for dependent discovery-to-
source work and direct operations remain appropriate for independent or known-
path reads.

The v28 grader originally omitted the hook-audit sidecar and reported zero hook
uses. The runner, grader, and report generator now pass and load that sidecar;
focused regressions cover the attribution. Regrading v28 with the audit still
fails because the invalid closed-enum query is a real integration error.

Raw manifests, transcripts, host logs, hook audits, retained patches and the
invalid host-only launch are under
`/Users/Cristian/BenchmarkResults/urdira-context-density-20260913-v24` through
`/Users/Cristian/BenchmarkResults/urdira-context-density-20260913-v28`.

## Verification

The hook-attribution and cumulative-token regressions pass as 52 focused tests.
`CI=true pnpm verify` passes all architecture, native, lint, JavaScript coverage,
typecheck, coverage-gate, and publication checks. The darwin-arm64 release
archive has digest
`sha256:dbc8e32d32b6acef0ab79643108f6f3c38dcfe983e141fc36e8cdb6d1ece78e3`;
`URDIRA_RELEASE_TARGET=darwin-arm64 pnpm release:acceptance` passes every
install, unit, contract, integration, end-to-end, crash, corruption, security,
watcher, benchmark, and package-inspection gate against that archive.
