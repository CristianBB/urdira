# Expanded TypeScript agent benchmark results — latest all arms

This report contains only the latest Urdira campaign and the latest baseline, Codebase Memory, and CodeGraph campaign. No previous comparator result was reused. Each row is one task/option cell; values are not averaged across tasks.

The 32 cells use the same frozen repository commits, one sample per cell, model `gpt-5.6-luna`, and Node `v24.18.1`. Total elapsed time is setup plus measured agent elapsed time. Estimated cost uses the planning card and is not a provider invoice.

## Campaign status

| Option | Cells | Correct |
|---|---:|---:|
| baseline | 8 | 8 |
| urdira-typescript | 8 | 8 |
| codebase-memory | 8 | 8 |
| codegraph | 8 | 8 |

- Expected cells: 32
- Observed cells: 32
- Correct cells: 32
- Campaign gate: passed
- Previous comparator rows reused: no

## Frozen commits

| Repository | Tier | Commit |
|---|---|---|
| typescript | L | b465fdbfe175304d9b977da137b2c178ae1091d3 |
| playwright | S | 1b44f5a441f391538c42c7ce36dd8ce779a5d6a1 |
| prisma | M | 0f37454eec96b193e8b20e8f569e453acd2af644 |
| vscode | L | 038b9225c82c6b75172beda6081c64887692538c |

## Comparison by task and option

| Repository | Task | Scenario | Option | Correct | Setup ms | Agent elapsed ms | Total elapsed ms | Input tokens | Output tokens | Reasoning tokens | Cost USD | Turns | MCP calls | Readiness ms | Peak RSS KiB |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| typescript | transpile-diagnostic-callback | quick-local | baseline | yes | 1,163 | 247,952 | 249,115 | 1,700,349 | 10,853 | 4,484 | 3.5234 | 3 | 0 | — | — |
| typescript | transpile-diagnostic-callback | quick-local | urdira-typescript | yes | 32,332 | 276,495 | 308,827 | 1,811,289 | 11,842 | 3,389 | 3.7444 | 3 | 19 | 31,607 | 1,626,624 |
| typescript | transpile-diagnostic-callback | quick-local | codebase-memory | yes | 48,376 | 214,183 | 262,559 | 1,631,549 | 8,838 | 3,488 | 3.3617 | 3 | 56 | — | — |
| typescript | transpile-diagnostic-callback | quick-local | codegraph | yes | 130,955 | 283,043 | 413,998 | 1,154,861 | 7,511 | 3,077 | 2.3944 | 3 | 11 | — | — |
| typescript | session-project-event-hook | deep-cross-file | baseline | yes | 766 | 304,082 | 304,848 | 1,813,154 | 13,612 | 5,243 | 3.7771 | 3 | 0 | — | — |
| typescript | session-project-event-hook | deep-cross-file | urdira-typescript | yes | 32,066 | 525,201 | 557,267 | 3,866,316 | 22,769 | 8,397 | 7.9820 | 3 | 57 | 31,313 | 1,559,744 |
| typescript | session-project-event-hook | deep-cross-file | codebase-memory | yes | 46,554 | 303,859 | 350,413 | 3,705,115 | 13,290 | 5,473 | 7.5603 | 3 | 45 | — | — |
| typescript | session-project-event-hook | deep-cross-file | codegraph | yes | 128,221 | 364,033 | 492,254 | 3,383,248 | 13,980 | 5,804 | 6.9248 | 3 | 17 | — | — |
| playwright | affected-tests-deterministic | quick-local | baseline | yes | 593 | 206,605 | 207,198 | 914,683 | 9,135 | 3,346 | 1.9292 | 3 | 0 | — | — |
| playwright | affected-tests-deterministic | quick-local | urdira-typescript | yes | 43,689 | 217,941 | 261,630 | 1,222,685 | 9,224 | 3,123 | 2.5441 | 3 | 28 | 42,683 | 1,745,920 |
| playwright | affected-tests-deterministic | quick-local | codebase-memory | yes | 5,567 | 172,178 | 177,745 | 1,002,239 | 7,490 | 2,786 | 2.0867 | 3 | 25 | — | — |
| playwright | affected-tests-deterministic | quick-local | codegraph | yes | 22,496 | 179,938 | 202,434 | 932,470 | 7,727 | 3,404 | 1.9540 | 3 | 6 | — | — |
| playwright | reporter-error-isolation | deep-cross-file | baseline | yes | 858 | 223,239 | 224,097 | 1,209,379 | 9,887 | 4,462 | 2.5336 | 3 | 0 | — | — |
| playwright | reporter-error-isolation | deep-cross-file | urdira-typescript | yes | 43,281 | 276,670 | 319,951 | 2,223,883 | 11,920 | 4,081 | 4.5758 | 3 | 41 | 42,195 | 1,703,568 |
| playwright | reporter-error-isolation | deep-cross-file | codebase-memory | yes | 5,527 | 243,173 | 248,700 | 1,819,176 | 11,294 | 4,986 | 3.7686 | 3 | 44 | — | — |
| playwright | reporter-error-isolation | deep-cross-file | codegraph | yes | 22,588 | 224,887 | 247,475 | 1,317,333 | 10,042 | 5,102 | 2.7558 | 3 | 9 | — | — |
| prisma | wire-name-validation | quick-local | baseline | yes | 118 | 194,362 | 194,480 | 1,009,126 | 7,898 | 3,628 | 2.1105 | 3 | 0 | — | — |
| prisma | wire-name-validation | quick-local | urdira-typescript | yes | 72,662 | 319,897 | 392,559 | 2,080,167 | 11,493 | 3,038 | 4.2766 | 3 | 28 | 72,106 | 2,225,056 |
| prisma | wire-name-validation | quick-local | codebase-memory | yes | 7,989 | 222,889 | 230,878 | 1,748,987 | 9,828 | 3,492 | 3.6045 | 3 | 28 | — | — |
| prisma | wire-name-validation | quick-local | codegraph | yes | 25,588 | 161,754 | 187,342 | 691,798 | 7,045 | 3,667 | 1.4693 | 3 | 5 | — | — |
| prisma | mongo-value-set-transform | deep-cross-file | baseline | yes | 745 | 167,771 | 168,516 | 839,225 | 7,400 | 2,344 | 1.7564 | 3 | 0 | — | — |
| prisma | mongo-value-set-transform | deep-cross-file | urdira-typescript | yes | 73,162 | 239,746 | 312,908 | 1,411,444 | 8,452 | 1,949 | 2.9061 | 3 | 17 | 72,489 | 2,235,824 |
| prisma | mongo-value-set-transform | deep-cross-file | codebase-memory | yes | 8,116 | 188,183 | 196,299 | 1,672,711 | 8,170 | 2,526 | 3.4310 | 3 | 40 | — | — |
| prisma | mongo-value-set-transform | deep-cross-file | codegraph | yes | 25,152 | 153,499 | 178,651 | 774,065 | 6,329 | 2,735 | 1.6206 | 3 | 5 | — | — |
| vscode | language-registry-change-notification | quick-local | baseline | yes | 537 | 335,481 | 336,018 | 1,297,925 | 16,381 | 8,487 | 2.7948 | 3 | 0 | — | — |
| vscode | language-registry-change-notification | quick-local | urdira-typescript | yes | 363,916 | 427,632 | 791,548 | 1,984,517 | 11,425 | 3,998 | 4.0924 | 3 | 26 | 362,318 | 4,769,360 |
| vscode | language-registry-change-notification | quick-local | codebase-memory | yes | 79,947 | 303,157 | 383,104 | 2,589,404 | 12,845 | 6,312 | 5.3321 | 3 | 36 | — | — |
| vscode | language-registry-change-notification | quick-local | codegraph | yes | 146,716 | 345,017 | 491,733 | 1,661,825 | 11,945 | 5,424 | 3.4626 | 3 | 10 | — | — |
| vscode | language-provider-registration-idempotence | deep-cross-file | baseline | yes | 1,109 | 196,924 | 198,033 | 1,173,622 | 8,986 | 4,166 | 2.4525 | 3 | 0 | — | — |
| vscode | language-provider-registration-idempotence | deep-cross-file | urdira-typescript | yes | 364,440 | 407,461 | 771,901 | 2,274,243 | 12,725 | 4,605 | 4.6871 | 3 | 22 | 363,256 | 4,782,992 |
| vscode | language-provider-registration-idempotence | deep-cross-file | codebase-memory | yes | 81,624 | 264,061 | 345,685 | 1,785,830 | 11,783 | 5,505 | 3.7100 | 3 | 33 | — | — |
| vscode | language-provider-registration-idempotence | deep-cross-file | codegraph | yes | 154,897 | 321,135 | 476,032 | 1,481,697 | 9,165 | 4,447 | 3.0723 | 3 | 12 | — | — |

## Urdira discovery audit

Urdira completed 8/8 graders. It made 214 discovery calls, 213 completed directly, 1 returned the typed selector-ambiguity recovery signal, and 0 were unexpected failures. The current Urdira rows contain no native source-reading fallback.

## Failures

| typescript | session-project-event-hook | urdira-typescript | urdira_query: {"error":{"code":"core:selector_ambiguous","details":{"confirmed_candidate_ids":["entity:3a4d9bc8230e36688264df8292914151e97c56c0c2d32b07621b38fdea79b1b0","entity:6305bc42951cd173de9a7dcffcc96e1c4111abfa5339b1abc3cecfe9e0771559"],"possible_candidate_ids":[],"selector_pointer":"/target"},"message":"core:selector_ambiguous: Symbol \"Session\" resolved to 2 declarations; narrow with context_artifact or kind_selector.","recovery_action":"add_symbol_context","retryable":false}} |
| typescript | session-project-event-hook | codegraph | codegraph_explore: Error: Tool execution failed: no such table: unresolved_refs. This is an internal codegraph error — retry the call once; if it persists, continue without codegraph for this task.; codegraph_explore: Error: Tool execution failed: no such table: unresolved_refs. This is an internal codegraph error — retry the call once; if it persists, continue without codegraph for this task.; codegraph_explore: Error: Tool execution failed: no such table: unresolved_refs. This is an internal codegraph error — retry the call once; if it persists, continue without codegraph for this task. |
| prisma | wire-name-validation | codebase-memory | get_code_snippet: symbol not found. Use search_graph(name_pattern="...") first to discover the exact qualified_name, then pass it to get_code_snippet. |
| prisma | mongo-value-set-transform | codebase-memory | trace_path: {"error":"function not found","function_name":"prisma-mongo-value-set-transform-codebase-memory-1.packages.2-mongo-family.1-foundation.mongo-contract.src.ir.mongo-value-set.MongoValueSet.withValues","hint":"Use search_graph(name_pattern=\".*prisma-mongo-value-set-transform-codebase-memory-1.packages.2-mongo-family.1-foundation.mongo-contract.src.ir.mongo-value-set.MongoValueSet.withValues.*\") to find the exact name, then pass it to trace_path."} |

## Urdira readiness and host evidence

| Repository | Task | Readiness ms | Source ready ms | Structural ready ms | Source catalog ms | Plugin analysis ms | Publish ms | Acceptance ms | Peak RSS KiB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| typescript | transpile-diagnostic-callback | 31607 | 3044 | 31607 | 1674 | 9073 | 26539 | 8920 | 1626624 |
| typescript | session-project-event-hook | 31313 | 2944 | 31313 | 1654 | 9004 | 26345 | 8852 | 1559744 |
| playwright | affected-tests-deterministic | 42683 | 9042 | 42683 | 5837 | 11961 | 31955 | 11791 | 1745920 |
| playwright | reporter-error-isolation | 42195 | 9050 | 42195 | 5750 | 12043 | 31550 | 11870 | 1703568 |
| prisma | wire-name-validation | 72106 | 17538 | 71581 | 20032 | 16329 | 42184 | 16159 | 2225056 |
| prisma | mongo-value-set-transform | 72489 | 17603 | 71965 | 19957 | 16379 | 42635 | 16212 | 2235824 |
| vscode | language-registry-change-notification | 362318 | 26174 | 355563 | 77093 | 84890 | 256839 | 84002 | 4769360 |
| vscode | language-provider-registration-idempotence | 363256 | 21289 | 356586 | 77159 | 84788 | 257820 | 83925 | 4782992 |

## Cleanup verification

The comparator audit reported all 24 worktrees, all 24 data roots, and all 8 Codebase Memory projects removed. Its eight CodeGraph cleanup flags were conservative false values, but the final process check found 0 matching CodeGraph/benchmark processes and the comparator temporary directory was removed. The previous 4.3 GiB Urdira data root was also removed.

Raw transcripts and host logs were removed after extraction; the JSON report retains the derived metrics and grader evidence.
