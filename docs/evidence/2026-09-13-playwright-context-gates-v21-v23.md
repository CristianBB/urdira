# Playwright context gates v21-v23

Date: 2026-09-13

This evidence records three sequential, no-retry Playwright gates on the frozen
`affected-tests-deterministic` task at commit
`1b44f5a441f391538c42c7ce36dd8ce779a5d6a1`. Every run used Luna, structural
readiness, and `URDIRA_SEMANTIC_INDEX=0`. All strict graders passed.

| Gate | Agent ms | Total tokens | Direct MCP | Result |
| --- | ---: | ---: | ---: | --- |
| v21, source-first prompt rendering | 343,623 | 2,340,747 | 3 | Rejected: shell-first discovery and higher token use. |
| v22, simple indexed `sed` projection | 324,673 | 2,523,447 | 7 | Rejected: attribution improved but actions and tokens increased. |
| v23, follow-up continuity diagnostic | 200,049 | 1,470,687 | 1 | Best token result in this group; still above every retained comparator. |

The original derived report summed the cumulative usage counters emitted by
the resumed Codex thread and therefore overstated all three totals. The values
above use the final monotonic counter for that thread. Historical comparator
transcripts expose per-turn counters and continue to be summed.

The v23 prompt hook was served on all three turns. Follow-up prompts without a
new structural seed no longer caused repeated `index_status` and `context`
calls. Across the run the audit retained 3 served prompt hooks, 3 served search
hooks, and 1 served source hook. This establishes working interception and
continuity, but it does not establish token efficiency.

The retained same-task comparator medians remain: baseline 628,159,
CodeGraph 864,960, tgrep 1,089,350, and codebase-memory 1,378,697 total tokens.
V23 is respectively 134.1%, 70.0%, 35.0%, and 6.7% higher. The full Prisma
and VS Code campaign was not repeated after these gates because the runbook
requires a successful focused gate before spending the larger campaign budget.

An attempted follow-on expansion that searched every sibling symbol in the
resolved source artifact was removed after an installed-host probe exceeded the
30-second hook deadline. The timeout is retained as negative evidence; no
benchmark sample was started with that implementation.

Artifacts are under
`/Users/Cristian/BenchmarkResults/urdira-context-density-20260913-v21`,
`/Users/Cristian/BenchmarkResults/urdira-context-density-20260913-v22`, and
`/Users/Cristian/BenchmarkResults/urdira-context-density-20260913-v23`.
