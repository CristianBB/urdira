# Current Urdira arm v10

Date: 2026-09-13

This record retains one current Luna invocation for the frozen focused task in
Playwright, Prisma and VS Code. The runs were sequential, used structural
readiness with semantics fully disabled, pinned the darwin-arm64 native closure,
and did not rerun a competitor. Every current sample passes both the strict
trajectory grader and independent focused validation.

The package archive used to extract the benchmark closure was
`sha256:bf2de153aafc376631a8755f7c75dcd9c6c23bdc460490242f5700ac12cf316d`.
After the evidence and runner documentation were added, the final accepted
archive became
`sha256:7097175d636a75ed667b64d7608ff61379483cc86c51e7fd105132c8ee716f5c`.
The app CLI, native addon and indexing-worker bytes are identical between both
archives; their paired hashes are retained with the benchmark artifacts.
The benchmark driver used Node 24.18.1. The frozen repository revisions are
`1b44f5a441f391538c42c7ce36dd8ce779a5d6a1` for Playwright,
`0f37454eec96b193e8b20e8f569e453acd2af644` for Prisma and
`038b9225c82c6b75172beda6081c64887692538c` for VS Code.

One Playwright preflight attempt stopped before model invocation because the
validation helper checked the host login shell, which resolved Node 11, instead
of the Node 24.18.1 executable injected by the runner. The failure artifact is
retained. A failing regression reproduced the mismatch; the helper now checks
the exact injected executable, and 25 focused runner/preflight tests pass.

## Correctness and measurements

| Repository | Strict grader | Independent validation | Agent ms | Setup ms | Total tokens | Repository context characters | Direct MCP | Hook interceptions | Hook served | Shell source calls |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Playwright | pass | 1/1, ESLint, diff check | 234,586 | 10,102 | 1,881,643 | 116,659 | 10 | 11 | 0 | 4 |
| Prisma | pass | 80/80, typecheck, Biome, diff check | 280,992 | 9,795 | 2,523,181 | 107,132 | 9 | 18 | 1 | 2 |
| VS Code | pass | 5/5, ESLint, full compile, diff check | 502,728 | 148,607 | 4,050,987 | 208,525 | 11 | 25 | 1 | 15 |

Every `PreToolUse` interception counts once as Urdira usage under the campaign
contract. The replay therefore reports 21, 27 and 36 effective Urdira uses,
while retaining served and fallback outcomes separately. Urdira is the first
repository-discovery source in all three samples. Its share of observed pre-edit
repository source characters is 100 percent in Playwright, 100 percent in
Prisma and 65.6 percent in VS Code. Shell reads remain valid task actions and
are not treated as failures merely because they occurred.

The current pages offer two, one and five continuations respectively; none is
consumed because the agent already has enough context for each focused task.
No exact repeated output characters are observed. Subjective relevance,
hydration use and contribution remain `null` because the transcripts do not
support reliable annotation.

The broad VS Code search that previously emitted a generated source line of
1,048,606 characters no longer does so. The largest current discovery shell
output is 17,972 serialized characters, and total VS Code repository context
falls from 1,156,423 characters in v9 to 208,525. The hook serves one indexed
search, preserving subsequent native command segments, and pages high-cardinality
results instead of hiding them or falling back solely because more pages exist.

## Retained comparison

Comparator values are medians of three retained 2026-09-10 Luna samples for the
same task and frozen revision. Their independent validations were not rerun.
All current Urdira rows are correct, which permits the efficiency comparison,
but one sample per current row does not support a statistical claim.

| Repository | Arm | Grader samples | Agent ms | Total tokens | Repository context characters |
| --- | --- | ---: | ---: | ---: | ---: |
| Playwright | Urdira current | 1/1 | 234,586 | 1,881,643 | 116,659 |
| Playwright | baseline | 3/3 | 201,111 | 628,159 | 86,149 |
| Playwright | codebase-memory | 2/3 | 187,279 | 1,378,697 | 153,270 |
| Playwright | CodeGraph | 3/3 | 205,510 | 864,960 | 45,985 |
| Playwright | tgrep | 2/3 | 248,194 | 1,089,350 | 143 |
| Prisma | Urdira current | 1/1 | 280,992 | 2,523,181 | 107,132 |
| Prisma | baseline | 3/3 | 201,785 | 882,221 | 109,937 |
| Prisma | codebase-memory | 3/3 | 213,349 | 1,454,280 | 224,453 |
| Prisma | CodeGraph | 3/3 | 196,313 | 1,214,194 | 117,441 |
| Prisma | tgrep | 3/3 | 241,267 | 1,078,133 | 2,777 |
| VS Code | Urdira current | 1/1 | 502,728 | 4,050,987 | 208,525 |
| VS Code | baseline | 3/3 | 270,829 | 1,547,403 | 182,414 |
| VS Code | codebase-memory | 3/3 | 425,231 | 2,855,078 | 275,398 |
| VS Code | CodeGraph | 3/3 | 334,954 | 1,893,638 | 197,164 |
| VS Code | tgrep | 3/3 | 386,946 | 1,403,952 | 403 |

Urdira supplies fewer repository-context characters than codebase-memory in all
three tasks and fewer than baseline and CodeGraph in Prisma. It uses fewer shell
source calls than codebase-memory in all three tasks, and fewer than baseline in
Playwright and Prisma. Current total tokens remain above every retained
comparator median for every task, and current
agent time is slower than every retained median except Playwright tgrep. The
result demonstrates complete, usable context and removal of the VS Code output
pathology, while leaving token and latency efficiency as open product work.

The final repository state passes 55 focused tests and `CI=true pnpm verify`.
The full gate reports 90.48 percent line coverage, 100 percent critical branch
coverage, 100 percent semantic-region coverage and publication hygiene over
1,137 files. Host-target packaging and isolated `darwin-arm64` release
acceptance pass; the accepted release report digest is
`sha256:6a334554ced0d34c84c73315b0029e225d9c9a8dcab646fad01b911dbd776fa9`.

Raw manifests, transcripts, host logs, timing sidecars, hook audits, independent
validation logs, offline replay, hashes and the derived comparison are retained
under `/Users/Cristian/BenchmarkResults/urdira-context-density-20260913-v10`.
