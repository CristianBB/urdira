# Current Urdira agent-arm verification

Date: 2026-09-13

This record retains one new Urdira/Luna sample for the frozen focused task in
Playwright, Prisma and VS Code. The samples ran sequentially with structural
readiness, `URDIRA_SEMANTIC_INDEX=0`, semantic materialization and sidecar off,
one analysis worker, no competitor execution and no model retry. The exact
darwin-arm64 release archive is
`sha256:8f396c627dd86010dbe164340b769eb76aa322eac1219a28a5ee3a8cf5a91c12`.
Its extracted native closure and indexing worker were required explicitly.

Fresh detached worktrees used the corpus revisions
`1b44f5a441f391538c42c7ce36dd8ce779a5d6a1`,
`0f37454eec96b193e8b20e8f569e453acd2af644` and
`038b9225c82c6b75172beda6081c64887692538c`. Dependencies, required generated
artifacts and unchanged focused baselines were prepared before model invocation.
One Playwright preparation command initially resolved its npm shebang with host
Node 11; it was corrected with an explicit Node 24 PATH before preflight. One VS
Code baseline attempt named the old path without `modes/`; the existing frozen
path then passed. Neither attempt invoked a model. All three final runner
preflights report Node 24.18.1, no missing declared dependencies and ready true.

The first Playwright runner launch also stopped before model invocation because
`URDIRA_NATIVE_REQUIRED=1` was set without `URDIRA_NATIVE_ROOT`. The failed
stderr is retained. The actual sample started only after a direct installed-CLI
probe verified the exact extracted native root. This is a runner-preflight gap,
not an additional model sample.

## Current Urdira results

| Repository | Strict grader | Independent validation | Agent ms | Total tokens | Repository context characters | Effective Urdira calls | Shell source calls | Urdira share before first edit |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Playwright | pass | fail, 0/1 | 219,247 | 1,733,185 | 120,472 | 6 | 11 | 56.4% |
| Prisma | fail | pass, 75/75 and typecheck | 213,071 | 2,032,013 | 186,921 | 20 | 3 | 100.0% |
| VS Code | pass | pass, transpile and 5/5 | 590,205 | 4,339,147 | 226,732 | 8 | 18 | 64.2% |

Urdira is the first repository-discovery source in all three samples. The mean
share of observed pre-edit repository-context characters is 73.5%. All 34
effective Urdira uses are direct MCP calls. Hook-served calls are zero: the
transcripts contain native search commands, but no response with the exact
`[urdira hook served]` marker, so no historical or implicit hook use is
invented. The 32 shell source calls remain valid supplemental work and are not
automatic failures.

All observed record identities are unique within each sample. Playwright
consumes one of three offered continuations. Prisma and VS Code consume none of
five and two offered continuations respectively. Exact repeated output is zero
for Playwright and Prisma and 1,065 characters for VS Code. Exact later shell
source overlap with MCP source is 3,650, 10,259 and 1,522 characters.

Correctness precedes efficiency. Playwright's static grader accepts the changed
paths and patterns, but its independent focused test proves the implementation
does not sort the returned paths: it receives checkbox then button while the
task requires button then checkbox. Prisma implements the requested boundary
and passes independent tests and typecheck, but its strict transcript grader
retains two Urdira failures: an explicit `core:snippet_budget_impossible`
diagnostic followed by a malformed `root.facets` request. VS Code passes both
the strict grader and independent source transpilation and focused Electron
tests. Its watcher reports dropped FSEvents after the first edit, forcing a
full 21,555-file reconciliation; this retained event materially increases the
590-second agent time.

## Retained comparator comparison

Competitors were not rerun. Comparator values below are medians of three
retained 2026-09-10 Luna samples for the same task and frozen revision. Their
reports record 9/9 strict grader passes for baseline and CodeGraph and 8/9 for
codebase-memory and tgrep across these selected tasks. Their independent tests
were not rerun here, so equal independent correctness is not established and
the efficiency rows do not identify a winner.

| Repository | Arm | Grader samples | Agent ms median | Total tokens median | Repository context characters median |
| --- | --- | ---: | ---: | ---: | ---: |
| Playwright | Urdira current | 1/1 | 219,247 | 1,733,185 | 120,472 |
| Playwright | baseline | 3/3 | 201,111 | 628,159 | 86,149 |
| Playwright | codebase-memory | 2/3 | 187,279 | 1,378,697 | 153,270 |
| Playwright | CodeGraph | 3/3 | 205,510 | 864,960 | 45,985 |
| Playwright | tgrep | 2/3 | 248,194 | 1,089,350 | 143 |
| Prisma | Urdira current | 0/1 | 213,071 | 2,032,013 | 186,921 |
| Prisma | baseline | 3/3 | 201,785 | 882,221 | 109,937 |
| Prisma | codebase-memory | 3/3 | 213,349 | 1,454,280 | 224,453 |
| Prisma | CodeGraph | 3/3 | 196,313 | 1,214,194 | 117,441 |
| Prisma | tgrep | 3/3 | 241,267 | 1,078,133 | 2,777 |
| VS Code | Urdira current | 1/1 | 590,205 | 4,339,147 | 226,732 |
| VS Code | baseline | 3/3 | 270,829 | 1,547,403 | 182,414 |
| VS Code | codebase-memory | 3/3 | 425,231 | 2,855,078 | 275,398 |
| VS Code | CodeGraph | 3/3 | 334,954 | 1,893,638 | 197,164 |
| VS Code | tgrep | 3/3 | 386,946 | 1,403,952 | 403 |

Tgrep's repository-context-character field covers assigned tgrep output while
its commands remain shell transport; it must not be interpreted as total model
or shell context. For every arm, token counts are the runner's comparable sum
of completed turn usage, including cached input. Full model-context characters,
subjective relevance, unused hydration and contribution remain null where the
transcript cannot prove them.

The current samples are materially more token-intensive than the retained
medians for every comparator on each task. The largest regression is VS Code,
where current Urdira uses 4.34 million total tokens and 590 seconds. The watcher
reconciliation explains part of the time but does not erase the token result.
Urdira returns less repository context than codebase-memory on all three tasks,
but more than baseline and CodeGraph on these samples. That reduction is not
enough to reduce total model tokens. Playwright also fails independent
correctness, and Prisma fails strict integration acceptance, so the current
three-sample result does not establish an efficiency improvement.

Raw manifests, transcripts, host logs, timing sidecars, retained host sessions,
preparation logs, independent validation logs, replay and comparison artifacts
are under `/Users/Cristian/BenchmarkResults/urdira-current-arm-20260912-v1`.
`comparison.json` hashes each current manifest/transcript and both retained
comparator reports. Worktrees and data roots remain retained for review.
