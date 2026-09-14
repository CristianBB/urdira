# Current Urdira arm v3

Date: 2026-09-13

This record retains one sequential Luna invocation for the frozen Playwright,
Prisma, and VS Code tasks after the Codex `updatedInput` hook repair. No
competitor was rerun and no failed sample was retried. The runs used structural
readiness, disabled every semantic lane, and pinned the accepted darwin-arm64
native closure.

Before execution, `CI=true pnpm verify` passed 161 test files and 2,438 tests
with 15 skipped tests, plus all native suites, coverage, typechecking, and
publication hygiene. Host-target packaging and release acceptance passed for
`sha256:6f1fcf5aa37f41a3aa0eb0d98ffbe0325b77bb1fb62cb5f2868dcb67db35a6b6`.

## Results

| Repository | Strict grader | Independent validation | Agent ms | Total tokens | Repository context characters | Direct MCP | Hook interceptions | Shell source calls |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Playwright | pass | fail, 1/2 | 294,322 | 2,131,247 | 141,850 | 7 | 20 | 16 |
| Prisma | pass | pass, 75/75 and typecheck | 239,202 | 1,874,264 | 112,841 | 11 | 14 | 5 |
| VS Code | fail | fail; lint and compile pass, test detects three leaked disposables | 323,823 | 2,896,790 | 1,228,552 | 6 | 23 | 16 |

Only Prisma has equal current correctness under both checks. Playwright's new
ordering test expected `m.spec.ts` before `a.spec.ts` and failed. VS Code's test
left three registered providers undisposed. Its strict grader also retained an
invalid `core:find_references` request whose artifact-shaped target is not
accepted by that operation. Efficiency values for Playwright and VS Code are
diagnostic and cannot support a winner claim.

The hook audit records 57 Codex `PreToolUse` interceptions. All 57 fell back as
`unsupported_input`; none served indexed output. Agents consistently composed
repository searches with `head`, another `rg`, `sed`, Git, or another shell
operation. The implemented simple-command rewrite was therefore correct in its
regression tests but ineffective in these live samples. The audit still counts
each interception once as effective Urdira use, while executed shell output
remains separately attributed.

VS Code again exposed a character-unbounded compound native search. One shell
result contributed 981,531 characters despite line-oriented limiting, and
shell supplied 1,169,166 of 1,228,552 repository-context characters. Urdira
was the first repository discovery source in all three samples, but it supplied
only about 4.7 percent of observed pre-edit VS Code repository context by
characters.

## Retained comparison

Comparator values remain the medians of three retained 2026-09-10 Luna samples.
Their independent validation was not rerun. Current Urdira total tokens exceed
every retained comparator median on all three tasks. The only fully correct
current row, Prisma, used 1,874,264 tokens versus 882,221 for baseline,
1,454,280 for codebase-memory, 1,214,194 for CodeGraph, and 1,078,133 for tgrep.

The complete table is in
`/Users/Cristian/BenchmarkResults/urdira-context-density-20260913-v3/comparison.md`.
Raw manifests, transcripts, host logs, timing sidecars, hook audits, independent
validation logs, offline replay, hashes, and the derived comparison are retained
under `/Users/Cristian/BenchmarkResults/urdira-context-density-20260913-v3`.

The next repair must address the command shapes agents actually emit, including
an explicitly bounded single-search `rg | head` form, without interpreting
arbitrary shell composition or hiding projection loss. Agent guidance and
operation diagnostics also need to prevent or recover from artifact-shaped
targets passed to entity-reference operations. A new benchmark is justified
only after focused regressions demonstrate those behaviors.
