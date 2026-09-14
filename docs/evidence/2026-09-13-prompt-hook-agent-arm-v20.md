# Prompt-hook agent arm v20

Date: 2026-09-13

This evidence records one sequential Luna sample for the frozen Playwright,
Prisma and VS Code tasks after adding dynamic Codex `UserPromptSubmit` context,
source deduplication in that context, a bounded freshness wait, and support for
simple searches whose only redirection is `2>/dev/null`. Semantic indexing and
materialization were disabled. No competitor was rerun and no Urdira sample was
retried. All three strict graders passed and every focused test recorded by the
agent passed; Prisma also contains one compound verification whose inner result
cannot be attributed and therefore remains unknown.

The installed darwin-arm64 archive used for these runs has digest
`sha256:51999096bc8d2f9a6bca2b8d4d9fd0b3cd3e8d6a27fa74f96bf97b0a13c2d095`.
The archive metadata names HEAD `c00e0eac4394222d925a15811338ad3a3876abf9`;
the authorized uncommitted product diff is part of the measured tree and is
preserved separately from that commit identity.

## Current samples

| Repository | Grader | Focused tests | Agent ms | Total tokens | Repository context chars | MCP chars | Prompt-hook chars | Shell chars | Direct MCP | Hook interceptions / served | Shell source calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Playwright | pass | 3/3 | 232,579 | 2,014,684 | 133,704 | 67,343 | 21,271 | 45,090 | 5 | 22 / 5 | 9 |
| Prisma | pass | 4/4, 1 unknown | 219,660 | 1,513,358 | 178,058 | 155,981 | 21,720 | 357 | 8 | 17 / 2 | 2 |
| VS Code | pass | 3/3 | 826,348 | 4,508,263 | 170,141 | 50,149 | 0 | 119,992 | 5 | 27 / 5 | 12 |

An audited `UserPromptSubmit` interception counts as Urdira use. The derived
replay additionally counts its `additionalContext` characters because those
bytes are model-visible even though Codex does not emit a transcript tool item
for them. `PreToolUse` output remains transcript-derived and is not counted
again from the audit sidecar. Fallthrough shell commands remain shell transport.

Playwright and Prisma received 21,271 and 21,720 prompt-hook characters before
the first model action. The resulting Urdira share of repository context before
the first edit is 66.3% and 100% respectively. VS Code received no prompt
context: both prompt hooks fell back with `stale_index`. Its five served hook
interceptions were narrower search substitutions, while seven other
interceptions fell back because of stale index state and fifteen because the
shell command was outside the faithful parser subset.

## Retained comparator comparison

Comparator values are the medians of the retained 2026-09-10 Luna samples for
the same frozen task and revision. They use the same three-turn campaign shape.
This is one current Urdira observation against historical medians, not a
same-day statistical comparison; the Codex host build may have changed.

| Repository | Arm | Correct samples | Total tokens | Current Urdira difference |
| --- | --- | ---: | ---: | ---: |
| Playwright | Urdira v20 | 1/1 | 2,014,684 | — |
| Playwright | baseline | 3/3 | 628,159 | +220.7% |
| Playwright | codebase-memory | 2/3 | 1,378,697 | +46.1% |
| Playwright | CodeGraph | 3/3 | 864,960 | +132.9% |
| Playwright | tgrep | 2/3 | 1,089,350 | +84.9% |
| Prisma | Urdira v20 | 1/1 | 1,513,358 | — |
| Prisma | baseline | 3/3 | 882,221 | +71.5% |
| Prisma | codebase-memory | 3/3 | 1,454,280 | +4.1% |
| Prisma | CodeGraph | 3/3 | 1,214,194 | +24.6% |
| Prisma | tgrep | 3/3 | 1,078,133 | +40.4% |
| VS Code | Urdira v20 | 1/1 | 4,508,263 | — |
| VS Code | baseline | 3/3 | 1,547,403 | +191.3% |
| VS Code | codebase-memory | 3/3 | 2,855,078 | +57.9% |
| VS Code | CodeGraph | 3/3 | 1,893,638 | +138.1% |
| VS Code | tgrep | 3/3 | 1,403,952 | +221.1% |

All current rows preserve correctness, but none beats a retained competitor on
total tokens. Compared with v18, Prisma improves from 2,168,368 to 1,513,358
tokens. Playwright improves from 2,384,385 to 2,014,684. VS Code regresses from
3,020,065 to 4,508,263 while prompt context is unavailable. The result supports
the prompt-hook approach for context leadership, but rejects an efficiency-win
claim for this revision.

The remaining product problems are observable rather than inferred: agents
still repeat prompt context with direct MCP calls; compound `rg --files`, `sed`,
`git grep`, and mixed Git/source commands fall through; and large-workspace
freshness can disappear at prompt time. VS Code reached 7,316,480 KiB peak RSS
and needed 169,269 ms for initial structural readiness. The next iteration must
make prompt context reliably current at the turn boundary and reduce redundant
agent actions without suppressing requested source or continuations.

Raw manifests, transcripts, host and timing logs, hook audits, retained patches,
and the hash-preserving offline replay are under
`/Users/Cristian/BenchmarkResults/urdira-context-density-20260913-v20`.
