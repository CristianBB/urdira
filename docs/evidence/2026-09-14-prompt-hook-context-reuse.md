# Prompt hook context reuse

Date: 2026-09-14

The v75 VS Code transcripts show that the Codex `UserPromptSubmit` hook served
the full prompt context again on later turns of the same resumed session. The
registry task served context packets of 441, 16,790, 441 and 29,276
characters; the provider task served 441, 441 and 29,266 characters. The
repeated packets were generated after the initial context had already entered
the conversation. This increases cumulative input without adding repository
facts. The same transcripts also contain valid native shell reads, including
one provider command with 132,742 characters of grouped discovery output, so
the hook change does not treat shell use as an error or attempt to suppress a
read that fills an identified gap.

The regression is `does not rehydrate unchanged successful prompt context in
the same host session` in `tests/agent-integration.test.ts`. It proves that a
second successful hook event with the same session, workspace snapshot and
prompt returns the existing-context continuation and issues no second
`core:query` call.

The implementation in `packages/cli/src/agent-integration.ts` stores only
session/workspace metadata, prompt hash, primary identifier and snapshot in a
small temporary cache. It never stores source bodies, continuation payloads or
workspace data. A changed snapshot or a prompt with a new code-shaped primary
identifier causes normal context hydration; a prompt without a new seed can
reuse the existing context. Cache entries expire after 24 hours and cache
failures fall back to the existing query path.

Focused validation passed:

- `CI=true pnpm exec vitest run tests/agent-integration.test.ts` (36 passing);
- `pnpm --filter @urdira/cli build`;
- targeted ESLint for the changed source and test;
- `git diff --check`.

The repository-wide `pnpm typecheck` invocation remains blocked by the
checkout's pre-existing unbuilt workspace package links (`@urdira/contracts`,
`@urdira/canonical`, `@urdira/plugin-sdk`, and dependent packages); the CLI
package itself builds successfully. Full VS Code remeasurement must use a
fresh no-retry sample after the production CLI/worker build.

The subsequent VS Code preparation attempts are retained independently. V76
and V77 stopped before model invocation because the fresh worktrees did not
have the required extension dependencies. V78 had a ready registry worktree:
the registry task passed the strict grader with 28,972 ms structural
readiness, while the provider task retained its preflight failure. V78's
registry hook audit recorded 56 fallback interceptions and no served prompt
context; every prompt boundary fell back because the index was stale. This is
valid correctness evidence, not an efficiency measurement of prompt reuse.

V79 was one fresh provider attempt after linking the extension dependencies.
It reached structural readiness in 29,525 ms and exited normally, but the
strict grader rejected it because the model's compile command could not find
`@typescript/native/lib/tsc.js` in its runtime environment. The attempt is
therefore retained as a failure and is not counted as an accepted sample.
Independent validation of the resulting patch passed the extension TypeScript
typecheck, targeted ESLint, `git diff --check`, and the focused
`onceAsync` unit test (1 passing under a temporary VS Code API stub). The
worker used for the attempt was the release worker at commit
`2d4d981ec9f8fd5c7cbe38a08f8f3ff5f3eebedb0ea4b882167a5ee3792133c5`.

The V79 transcript's final cumulative thread usage was 1,866,590 tokens,
distributed as 1,261,177, 375,555 and 229,858 across its three turns. Its
observed repository output was 96,363 shell characters from 15 source-read
commands; Urdira served zero prompt packets because all 56 audited hook calls
fell back (`stale_index` five times and `unsupported_input` 51 times). Those
facts explain the failed integration measurement and do not demonstrate that
the context-reuse cache is ineffective. The raw V79 transcript, hook audit and
grader outcome remain under the benchmark results directory.

Cleanup was performed only after checking that no process referenced the
validation paths. Before cleanup, `du -sk` measured 9,125,628 KiB for the V76
VS Code checkout, 8,543,528 KiB for the V79 Urdira data root and 295,736 KiB
for the retained V79 report. The V79 worktree was removed through Git's
worktree command, then the V79 data root and the V76 dependency checkout were
removed. The retained report directory and raw transcript artifacts were left
in place; all three temporary validation paths now report absent. The retained
V79 report contains 5,394,379 regular-file bytes after worktree cleanup.

V82 is the accepted provider follow-up after rebuilding the exact production
artifacts. Its preflight was run after dependency-preserving cleanup and
reported no missing dependencies or runtime artifacts. The stamp at
`/Users/Cristian/BenchmarkResults/urdira-context-density-20260914-v82/preflight-stamp.json`
records the CLI, MCP, app, native addon and indexing-worker hashes; the CLI
contains both the `equivalent` freshness acceptance and the source-search
prompt fallback.

The V81 diagnosis identified two independent causes. The old production CLI
accepted only global `current` freshness even when the scoped structural
status was validly `equivalent`. Separately, `core:build_context` is registered
at structural stage 3 while the benchmark's structural readiness boundary is
stage 1. A prompt hook therefore received the typed `core:coverage_incomplete`
diagnostic after readiness. The new hook preserves that diagnostic, marks the
context `coverage=partial`, and uses the operation's declared
`source_safe_fallback_operations` to run an explicitly scoped `core:search_text`
query. Its own completeness and continuation are reported separately, so the
hook never claims that the unavailable context facets were complete.

V82 reached structural readiness in 27,555 ms, completed both requested turns,
and passed the strict grader and independent validation. The audit recorded
three served `UserPromptSubmit` packets and five served `PreToolUse` packets;
the remaining fallbacks were retained with their reasons (`stale_index` 6,
`output_overflow` 3, `unsupported_input` 17). A served packet is therefore
counted as Urdira hook use even when later native shell reads fill an identified
validation gap. The exact V82 report, transcript, timing, host log and hook
audit remain under `/Users/Cristian/BenchmarkResults/urdira-context-density-20260914-v82`.

The final V82 `cumulative_thread` accounting is 1,655,594 comparable tokens
(1,644,005 input, 11,589 output, including 4,968 reasoning tokens), across
three turns of 795,331, 528,333 and 331,930 tokens. This is 13.2 percent above
the prior V75 provider observation at 1,462,541 tokens, so V82 is accepted as a
correctness and integration follow-up but is not an efficiency improvement.
The first prompt packet was only the 441-character
`core:selector_unresolvable` diagnostic; the useful 29,198-character prompt
packet arrived after the model had already made native shell discovery reads.
Native shell fallback is allowed by the protocol, but this sample therefore
does not demonstrate that Urdira supplied sufficient first-turn context.

V82 cleanup removed its temporary Urdira data root and validation checkout only
after the retained artifacts were written. The pre-cleanup regular-file totals
were 4,212,560,081 bytes for the validation checkout and 5,563,268,035 bytes
for the Urdira data root; both paths are now absent. The accepted sample is one
task-matched integration observation, not a general efficiency claim.

V83 tested the selector-recovery hypothesis as one fresh provider sample. The
hook delivered 14 Urdira packets (3 prompt and 11 pre-tool), and pre-edit
source output fell to 59,812 shell characters with 30,456 hook characters,
compared with V82's 81,145 and 38,661. The sample is retained as failed because
the agent mutated a served opaque continuation cursor during manual recovery;
the strict grader reported `validation=true` even though the patch shape was
complete. This is an agent continuation-use failure, not evidence to discard
the source-safe fallback. The raw report and transcript remain under the V83
results directory. Its temporary checkout and data root were removed after
retention (4,212,642,895 and 5,564,998,026 regular-file bytes respectively).

V84 was started after the copy-ready continuation guidance and reached the
model, but the benchmark process was interrupted before it wrote a manifest or
ran the grader. Its raw transcript, hook audit, host log and timing sidecar are
retained under `/Users/Cristian/BenchmarkResults/urdira-context-density-20260914-v84`;
the temporary checkout and data root were removed after recording 2,650,438,606
and 5,558,730,098 regular-file bytes respectively. V84 exposed a separate
prompt-seed problem: the exact task begins with `Make TypeScript
LanguageProvider...`, so the first code-shaped token selected `TypeScript` and
returned unrelated low-confidence matches. This attempt is not an efficiency
or correctness sample.

V85 is the single fresh provider sample for the generic seed-ranking fix. The
prompt adapter removes path-shaped metadata before selecting identifiers and
ranks remaining code-shaped candidates by occurrence, specificity and source
order; a regression containing a `BenchmarkResults` path and the exact
TypeScript task selects `LanguageProvider`. V85 used the frozen VS Code commit
`038b9225c82c6b75172beda6081c64887692538c`, Luna `gpt-5.6-luna`, structural
readiness and semantic indexing/materialization disabled. The strict grader and
independent checks passed (2/2 target paths, required patterns, focused
TypeScript compile, diff check); the worker hash was
`2d4d981ec9f8fd5c7cbe38a08f8f3ff5f3eebedb0ea4b882167a5ee3792133c5` and the
production CLI hash was recorded in the V85 preflight stamp.

V85 reached structural readiness in 29,520 ms. Its raw turn usage summed to
2,804,588 tokens, while the comparable Urdira value is the last cumulative
thread counter, 1,296,289 (1,286,069 input plus 10,220 output in turn 3).
That value is above the task-matched provider medians for baseline (1,193,155)
and tgrep (1,011,210), and below CodeGraph (1,430,741) and memory (1,938,561).
This is a correctness and integration pass, not an efficiency improvement.
Before the first edit the
hook supplied 43,656 characters and shell supplied zero; across the run the
hook served 57,188 characters and shell produced 73,410. The audit recorded
29 effective Urdira hook interceptions (9 served, 20 retained fallbacks:
`stale_index` 7, `output_overflow` 4, `unsupported_input` 9), and no opaque
cursor mutation. The independent replay and raw hashes are in
`/Users/Cristian/BenchmarkResults/urdira-context-density-20260914-v85`.
Cleanup removed the V85 checkout, data root and prompt cache after verifying no
benchmark process referenced them; their pre-cleanup regular-file totals were
2,650,438,997, 5,564,632,313 and 223 bytes respectively. The retained result
directory contains the manifest, transcript, hook audit, host log, timing,
replay and preflight stamp.

The post-V85 cache refinement is covered by two focused regressions. A follow-up
prompt with an incidental identifier reuses the successful packet when it is a
clear continuation in the same session and workspace snapshot; a follow-up
that explicitly asks for a missing caller/detail performs a new query. The
session key remains the existing hook identity (`session_id`, transcript,
thread or conversation) combined with the workspace id, so the optimization
does not cross scope or snapshot boundaries. The exact focused command
`CI=true pnpm exec vitest run tests/agent-integration.test.ts` passed 44/44
tests in the audited checkout. No retained artifact supports a 53-test count;
that figure is removed rather than attributed to this validation.

V86 is the single fresh provider sample for same-session prompt-context reuse.
It used commit `038b9225c82c6b75172beda6081c64887692538c`, Luna
`gpt-5.6-luna`, structural readiness and semantic indexing/materialization
turned off. The strict grader passed (`exit_code=0`, `grader_exit_code=0`), as
did independent preflight, required-path/pattern checks, Node 24.18.1
TypeScript `--noEmit`, and `git diff --check`. Structural readiness was 29,536
ms. The comparable last cumulative-thread value was 970,632 tokens (961,131
input plus 9,501 output), down 325,657 tokens (25.1 percent) from V85's
1,296,289; it is below the task-matched baseline median 1,193,155 and tgrep
median 1,011,210, and below CodeGraph 1,430,741 and memory 1,938,561.

V86 supplied 54,019 hook characters before the first edit and no shell source
characters. Across the run, hook output was 56,124 characters and shell output
was 60,946. The audit retained 22 effective hook interceptions: 6 served and
16 fallbacks (`stale_index` 5, `output_overflow` 2, `unsupported_input` 9).
The prompt packets were 20,037 characters initially, 4,785 characters with a
`core:selector_unresolvable` diagnostic, and 29,197 characters after the
workspace snapshot changed. The focused regressions separately prove that a
same-session continuation with an incidental identifier reuses its packet,
while an explicit missing-detail request performs a new query. V86 had no
cursor mutation, and its raw report, replay, stamp and hashes are retained in
`/Users/Cristian/BenchmarkResults/urdira-context-density-20260914-v86`.

V86 cleanup removed the temporary checkout, Urdira data root and prompt cache
only after process checks; their pre-cleanup regular-file totals were
2,651,389,828, 5,603,908,458 and 223 bytes respectively. The retained result
directory contains the manifest, transcript, hook audit, host log, timing,
replay and preflight stamp.

The V86 retained-file hashes were derived from the files in the result
directory, rather than copied from an earlier summary:

| File | SHA-256 |
|---|---|
| host session `runs/vscode-language-provider-registration-idempotence-urdira-typescript-1.host-sessions/2026/09/14/rollout-2026-09-14T12-23-00-01a09f71-0b48-74f2-bbad-74c5ae9d8532.jsonl` | `904c2bf44d4dbc58cb9a0f5437e63e2bbce258aa5385e63ae5df660bf23e659f` |
| transcript `runs/vscode-language-provider-registration-idempotence-urdira-typescript-1.jsonl` | `6266d36f69fba937583e7642b3be6dac81ceb281bc4f35ce7da1d1db699a438e` |
| manifest `runs/vscode-language-provider-registration-idempotence-urdira-typescript-1.json` | `953603d1f3baa47bc7b4d48bc745ada630ed93f40bd92dd36172e03fc8032312` |
| hook audit `runs/vscode-language-provider-registration-idempotence-urdira-typescript-1.hook-audit.jsonl` | `eb27073784bcca623f9d37dd2da245dbd45c34a48ff2fd86bd912fd94c535286` |
| preflight stamp `preflight-stamp.json` | `c755f6e15fa2f94e44abcf7bfb608a694d0894d54a5eafa88d33cd48f42da850` |

The stamp records the exact production artifact hashes: CLI
`13bbba397546be76ff8385879997fa1169d121b9d506af92a0e29d190d8ba0a1`, MCP
`1f8ac69ec0954f5e92f6ebdbebc33bba87145c990a3659dcd04a16cb67c5acf6`, app
`59315e9d2545640f431484cd445f4e91960a271cbbb6d157dd75f7701cdb8ed5`, indexing
worker
`2d4d981ec9f8fd5c7cbe38a08f8f3ff5f3eebedb0ea4b882167a5ee3792133c5`, and
native addon
`b1d845972b40d5270b97e719b1f03d0afd4e94c278556a3f223530e62b5f72eb`.
