# Fresh agent verification after context recovery

Date: 2026-09-12. The user explicitly authorized fresh live verification after
the [repair gates](2026-09-12-agent-context-recovery.md). These are three new
single samples, not replacements for the original retained failures. Execution
is sequential: Playwright, Prisma, then VS Code. No competitors or agent retries.

## Reproducible inputs

Artifacts: `/Users/Cristian/BenchmarkResults/urdira-context-live-20260912/`.
`environment.json` records preparation and runtime discrepancies;
`implementation.patch` captures the tracked implementation used for all cells.
The source base is `c00e0eac4394222d925a15811338ad3a3876abf9`, with tracked patch
SHA-256 `24c26a1b4a84db14e65e33e7fe37104b69ba8c335b48932f822bdce2d58e8340`.
Untracked repair sources and prior gate logs remain in the preceding
`urdira-context-integration-20260912/repair-attestation.json` artifact set.

Model: `gpt-5.6-luna`; Codex executable `0.153.4`; Node `v24.18.1`.
The runner installs the production Codex integration into an isolated home,
serves the current built CLI, and uses the packaged indexing worker at
`release/native/darwin-arm64/urdira-indexing-worker`, SHA-256
`00648c73672f507c45f306bb88d2b3cf4bdc29d8c364483e9204d85313e1e567`.
Structural readiness is required; semantic indexing and semantic performance
instrumentation are disabled. The agent samples use this runner installation;
the separate extracted archive probe remains documented in the repair evidence.

| Repository | Frozen revision | Task |
| --- | --- | --- |
| Playwright | `1b44f5a441f391538c42c7ce36dd8ce779a5d6a1` | `affected-tests-deterministic` |
| Prisma | `0f37454eec96b193e8b20e8f569e453acd2af644` | `wire-name-validation` |
| VS Code | `038b9225c82c6b75172beda6081c64887692538c` | `language-registry-change-notification` |

Fresh detached worktrees were prepared with frozen-lock dependencies before
model invocation. Playwright was built, Prisma's schema-ir dependency closure
was built, and VS Code build dependencies and client transpilation were prepared.
Generated build output can add indexed artifacts and symbol ambiguity; these
samples are not controlled causal comparisons with the earlier unbuilt worktrees.
The new preflight reports Node 24 and no missing declared prerequisites for all
three. Baselines passed: one Playwright watch test, 256 Prisma package tests, and
13 VS Code language-selector tests. Failed preparation commands are retained too.

## Integration findings

The isolated shell initially placed Node's directory before the runner shim.
Before Prisma, a revised isolated profile preserved the shim first; a direct
login-shell probe resolved the shim, Node 24 and Urdira 0.3.3. Nevertheless, actual
agent hook output in Prisma and VS Code still invokes an unprepared Urdira 0.3.2
runtime. The standalone PATH probe therefore did not validate the actual hook
execution environment. The exact remaining executable-resolution cause is not
established. No global installation was changed and no running sample was repaired.

The retained host-session snapshots contain actual `PreToolUse` rejections.
The ordinary runner action JSONL omits these blocked command executions, while
its `error` actions contain hook-trust warnings. Neither a zero completed-shell
count nor the analyzer's hook-error count proves absence or number of blocked
attempts. In particular, VS Code attempted shell discovery after Urdira queries.

Playwright issued three failed MCP requests: missing context `api_version`, an
unsupported recipe argument, and a scalar pipeline binding receiving two symbol
subjects. Prisma issued three explicit projection-budget failures; these report
the required size and recovery instead of silently dropping source. Such typed
failures are not evidence of hidden truncation, although the strict sample grader
retains them as failures. Agent recoveries remain in the original transcripts.

## Independent checks of completed agent edits

These checks are performed outside the agent after its edits and do not turn a
failed integration sample into a pass. Benchmark source edits are retained as
produced; they are not repaired by the supervising agent.

- Playwright: the new sorted/deduplicated affected-tests regression passes
  (`playwright-independent-test.log`, one test). The agent itself could not run it.
- Prisma: `CI=true pnpm --filter @internal/sql-schema-ir exec vitest run test/naming.test.ts`
  fails: 73 pass, one fails. The generated test nests `describe('isValidWireName')`
  inside another test at line 165. Structural source inspection did not catch
  that test-registration error. See `prisma-independent-test.log`.
- VS Code: `npm run transpile-client` succeeds, then
  `npm run test-node -- --run src/vs/editor/test/browser/languageFeatureRegistry.test.ts`
  fails before tests start. The test's relative URI import resolves to nonexistent
  `out/base/common/uri.js`, rather than `out/vs/base/common/uri.js`. See
  `vscode-independent-transpile.log` and `vscode-independent-test.log`.

## Final outcomes and offline replay

All three runner processes exit 1 with `completed_successfully: false`; their
model processes exit 0. Each strict grader records failed MCP calls. The agent
handoffs explicitly acknowledge tests were not executed. Changed target coverage
and a clean diff do not establish behavioral correctness.

`node release/benchmarks/replay-agent-context.mjs --output /Users/Cristian/BenchmarkResults/urdira-context-live-20260912/replay.json /Users/Cristian/BenchmarkResults/urdira-context-live-20260912/runs`
passes and retains all three failed outcomes and original hashes.

| Sample | Integration acceptance | Independent new-test result | Agent elapsed | MCP output characters | Completed MCP calls | Unique continuation references offered / attempted / consumed |
| --- | --- | --- | --- | --- | --- | --- |
| Playwright | Fail | 1 passed | 239,586 ms | 232,542 | 33 | 7 / 0 / 0 |
| Prisma | Fail | 73 passed, 1 failed | 288,953 ms | 152,470 | 19 | 4 / 0 / 0 |
| VS Code | Fail | Import failure before tests | 351,167 ms | 215,026 | 24 | 11 / 1 / 1 |

MCP characters are aggregate observed output across the session, not maximum page
sizes or a success threshold. Shell-output characters remain `null`; actual
blocked attempts make the public action transcript insufficient to establish
total host context or absence of fallback. The replay identifies 6/6, 22/22 and
6/6 unique record-ID occurrences respectively; this limited recognized subset
is not a complete inventory of all result identities. Literal whole-output
repetition is zero; that does not mean source fragments never repeat. Edited
artifact positions, hydration use, relevance, contribution and preserved global
completeness remain unestablished (`null`) under the current evidence parser.
The VS Code continuation succeeds, but this sample does not consume all pages
and cannot establish exhaustive broad-query completeness. VS Code also retains
a scalar pipeline failure with two upstream symbol subjects.

Raw outputs, timing, host logs, source patches, new test files and the modified
Playwright generated bundle are preserved. `evidence-sha256.json` hashes these
artifacts. Host-session snapshots supplement public action logs and may end just
before isolated-home cleanup; they are not represented as complete replacements.
All three final worktree `git diff --check` checks pass. No benchmark source was
repaired after the model handoff, and there were no sample retries.

## Acceptance and remaining work

This live verification does **not** accept the end-to-end integration. Repository
and archive gates from the repair evidence remain valid for their tested scope;
they did not exercise the actual host's executable resolution for hooks.

The next repair needs an actual-host hook probe that proves the same executable,
version and endpoint as MCP, followed by coverage for rejected shell commands in
measurement. API guidance should make context versioning, recipe arguments,
scalar symbol ambiguity and projection-versus-response budgets easier to use.
Agent test additions must be executable, including valid imports and suite
placement; source inspection alone failed to establish that here. These findings
do not justify silent truncation, hard success budgets or benchmark-specific
engine logic. No general efficiency improvement can be inferred from these three
failed and environment-confounded samples.
