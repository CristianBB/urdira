# Current Urdira context-density benchmark

Date: 2026-09-13

This record covers the final sequential Luna checks on the frozen Playwright,
Prisma and VS Code tasks after the context, hydration, presentation and Codex
hook changes. Every run used structural readiness with semantic indexing and
materialization disabled. Hook interceptions count as Urdira use, while any
native command that ultimately ran and its output remain in the shell account.
No competitor was rerun.

`CI=true pnpm verify` passed before the samples. The darwin-arm64 package and
release acceptance also passed. The release used for v48-v50 reported installed
CLI SHA-256 `59315e9d2545640f431484cd445f4e91960a271cbbb6d157dd75f7701cdb8ed5`.
After the v50 diagnosis, the Codex integration was changed again so an
explicitly paginated result is served with its continuation instead of falling
back merely because the page declares truncation. Its focused regression passes
30/30 and a new darwin-arm64 archive was built successfully.
The final installed-release acceptance passed every gate with archive digest
`sha256:c0e253a62116933b663325322c9b9893e7f5bb020c2732730603eb0fecb177f4`.

## Accepted current samples

Correctness and coverage are the acceptance boundary. Character and token
counts are comparative observations, not fixed success limits.

| Repository | Artifact | Grader | Focused tests | Readiness ms | Agent ms | Total tokens | Repository context chars | Direct MCP | Hook calls (served) | Shell source calls |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Playwright | v48 | pass | 3/3 | 6,945 | 213,352 | 1,138,415 | 46,995 | 1 | 33 (7) | 11 |
| Prisma | v49 | pass | 3/3 | 7,455 | 165,530 | 853,188 | 37,118 | 0 | 15 (5) | 2 |

Urdira was the first discovery source in both samples. Before the first edit,
Urdira supplied 87.8 percent of measured repository context characters in
Playwright and 36.5 percent in Prisma. Prisma still began from three hook
interceptions and needed only two focused shell source reads. These reads are
valid fallback activity under the campaign contract; they do not erase the 15
effective Urdira uses.

Playwright v47 is retained but rejected because the isolated checkout lacked
the nested stable test runner dependency. The corrected v48 setup ran all three
focused checks successfully. Its total token count is higher than baseline,
CodeGraph and tgrep but lower than codebase-memory. Prisma v49 is correct and
uses fewer total tokens than every retained comparator median.

## VS Code outcome and repair

VS Code v50 reached structural readiness in 49,648 ms, close to the earlier
49-second recovered gate and far below the 106-169 second regressed attempts.
The initial index covered 13,934 repository files; it did not include
`node_modules`. Later edits legitimately invalidated 2,360 dependent owners and
caused a large incremental rematerialization. This post-edit work must not be
reported as initial readiness.

The v50 grader passed its path-level checks, but the sample is rejected. Its
only focused test failed because `test-node` reads compiled files from `out/`
and the newly added test had not been compiled. The transcript also contains
two broad native search outputs of roughly 1.05 million characters each after
an `output_overflow` hook fallback. Total model usage was 2,402,221 tokens.

The production agent guidance now tells the agent to run the repository's
required compile step after editing when an exact-file test runner consumes
generated output. The hook now preserves declared pagination and emits the
continuation instead of opening an unbounded native search. A local replay of
the v50 implementation then exposed and corrected two test API errors and an
undisposed event listener. `npm run gulp compile-client` completed with zero
errors and the exact command
`npm run test-node -- --run src/vs/editor/test/common/languageFeatureRegistry.test.ts`
passed 3/3 tests in 11 ms.

The only post-repair Luna attempt, v51, is retained as a failure. It reached
durable structural readiness in 49,172 ms and the first three native searches
were served by the Urdira hook without fallback, but Luna stopped producing
events for approximately 16 minutes before any edit. The run was terminated;
it is not a benchmark result and was not retried.

## Retained comparator comparison

Comparator values are medians of three retained 2026-09-10 Luna samples for the
same task and frozen revision. Only accepted correct Urdira samples are ranked.

| Repository | Arm | Correct sample basis | Total tokens |
| --- | --- | ---: | ---: |
| Playwright | baseline | 3/3 | 628,159 |
| Playwright | CodeGraph | 3/3 | 864,960 |
| Playwright | tgrep | 2/3 | 1,089,350 |
| Playwright | Urdira v48 | 1/1 | 1,138,415 |
| Playwright | codebase-memory | 2/3 | 1,378,697 |
| Prisma | Urdira v49 | 1/1 | 853,188 |
| Prisma | baseline | 3/3 | 882,221 |
| Prisma | tgrep | 3/3 | 1,078,133 |
| Prisma | CodeGraph | 3/3 | 1,214,194 |
| Prisma | codebase-memory | 3/3 | 1,454,280 |
| VS Code | tgrep | 3/3 | 1,403,952 |
| VS Code | baseline | 3/3 | 1,547,403 |
| VS Code | CodeGraph | 3/3 | 1,893,638 |
| VS Code | codebase-memory | 3/3 | 2,855,078 |
| VS Code | Urdira current | no accepted post-repair sample | n/a |

These single Urdira samples are integration evidence, not a statistical claim.
The product changes remove the observed unbounded-search failure mode and make
the exact VS Code validation sequence executable, but a completed post-repair
Luna sample is still absent because v51 stalled in the model worker.

## Storage hygiene

Every benchmark dependency tree and data root was removed immediately after its
sample. Repeated residual-store tests previously leaked roughly 36 GiB under
`crates/urdira-indexing-worker/target/v4-residual-test`; the test scratch helper
now owns cleanup through `Drop`, and the ignored native residual suites leave
that directory empty. Old benchmark indexes, duplicate releases, obsolete
worktrees and generated outputs were also removed. The cleanup manifest is
retained as `BenchmarkResults/urdira-context-cleanup-20260913.json` outside the
repository.
After the final local VS Code validation, the Playwright, Prisma and VS Code
frozen worktrees were clean and dependency-free. A subsequent host-wide audit
found that earlier iterations had nevertheless retained 187 `urdira-*`
directories under the system temporary root, totaling 75.70 GiB, plus roughly 38 GiB of
old n8n and VS Code campaign workspaces. Those temporary indexes, obsolete
workspace copies, local Rust build output, corpus dependency trees, stale
installed-workspace state, and a leaked checkpoint-test daemon were removed.
The raw reports and transcripts remain available, while the reproducible v8
worktrees were removed. Physical free space increased from 113 GiB at the start
of the final audit to 237 GiB after cleanup.

Raw v48-v51 reports, transcripts, hook audits, timing sidecars and host logs are
retained under the external `BenchmarkResults` v48 through v51 directories.

A final post-validation cleanup removed the failed v52 checkout and dependencies, all duplicate Rust target output, generated typecheck and coverage output, an obsolete extracted release, and the Urdira installer cache (about 1.46 GiB logical). The final audit records 237 GiB free after cleanup, with no benchmark process left running.

## Playwright v53 diagnosis and bounded repair

The next accepted Playwright sample, v53, reached structural readiness in
5,467 ms and completed the requested edit with both changed paths, four focused
tests, ESLint, and `git diff --check` passing. It is retained as a correct
regression sample rather than an efficiency success. The three Codex turns
reported 2,556,029 input tokens and 19,097 output tokens, 22 executed command
cycles, 9,661 characters of prompt-hook context, and 52,368 further repository
context characters. The first packet found the implementation and related test
artifacts, but overlapping windows repeated part of the implementation and the
lexical test window ended before the complete assertion body. The agent then
listed and read broader test, package, export, and runner files.

The same run exposed a readiness-independent indexing defect after the edit.
Playwright created ignored `test-results/.playwright-artifacts-0` directories;
the watcher produced an empty authoritative source delta, but incremental
syntax analysis widened the empty changed-artifact set to 969 files and
materialized 877,955 records. The worker now treats an empty changed source
delta as a no-op, returning the current generation and roots without analysis
or publication. A focused end-to-end regression reproduces the directory event
and verifies that generation 1 remains generation 1.

The prompt projection now coalesces compatible partially overlapping byte
ranges from the same artifact version, while keeping every result association.
Lexical test evidence hydrates from the smallest containing indexed callable,
so an occurrence can return the complete test body. The public, replaceable
prompt default requests six items per result stream within the same client
character budget, and the persistent Codex guidance was shortened while
retaining direct deferred-tool names, continuation behavior, shell boundaries,
and exact-test guidance. These repairs passed 202 focused TypeScript tests and
the new Rust end-to-end regression. They have not yet been assigned an
accepted benchmark result; v53 remains the last measured sample.

After these checks, both Rust target directories, generated fixture output,
coverage output, and typecheck output were removed. No `urdira-*` directory
remained directly under the system temporary root; the repository occupied 1.3 GiB
(including its declared 978 MiB dependency tree), retained benchmark evidence
occupied 787 MiB, and the volume had 237 GiB free.

## Playwright v54 gate and v55 sample

The v54 focused context gate used the frozen Playwright revision with semantic
indexing disabled. Structural readiness took 5,085 ms and restart readiness
took 690 ms. After ranking containing lexical owners by structural role, the
23,109-character page contained five unique source blocks, one copy of each
affected-test implementation, its callers, and the complete 12,069-byte test
module with fixtures and assertions. Remaining results stayed available by
continuation.

The single v55 Luna sample was correct but failed the efficiency objective. It
reached readiness in 4,959 ms, edited both required files, passed the focused
test, ESLint, and `git diff --check`, then reported 3,105,801 input tokens and
20,456 output tokens across 21 command cycles. The transcript contained 95,212
characters of repository context: 2,000 from a direct MCP call, 23,776 from
hooks, and 69,436 from shell. Urdira supplied 55.2 percent of the repository
context before the first edit, but repeated cumulative context across many
model cycles dominated total token use. This sample is retained as correct
regression evidence, not an accepted efficiency result.

Two concrete causes were found. Codex loaded the managed
`urdira-discovery` skill before using context already injected by the prompt
hook, adding a redundant model cycle. The installer now removes that legacy
managed skill on upgrade and relies on prompt and pre-tool hooks plus the
optional explorer agent. Playwright also wrote source-shaped runtime files
under `test-results/**`; the watcher admitted them and widened a post-test
reconcile to 1,656 owners and roughly 1.27 million records. The shared default
inclusion policy now excludes that runtime tree in enumeration, watchers, the
TypeScript security boundary, and the Rust frontier, while preserving explicit
include opt-in. Focused verification passed 138 TypeScript tests plus the Rust
policy and indexing-worker end-to-end regressions.

The subsequent deep cleanup found older campaign roots that were not named
`urdira-*`: `<temporary-root>/u2d`, `<temporary-root>/u2b`, and
`<temporary-root>/u2v-*`,
copied dependency trees, and graph indexes. Removing those reproducible
artifacts and the regenerable campaign graph cache recovered another
110,143,619,072 physical bytes. Together with the previous audit, roughly 226
GiB has been recovered. The volume now has about 339 GiB free,
the system temporary root occupies 16 MiB, retained benchmark evidence occupies 789 MiB,
and no benchmark or indexing worker remains active.

A final hidden-state audit found a regenerable installed Urdira runtime and
semantic model under the user data root, release-package staging, empty
campaign scratch directories, and uncited intermediate context-density runs.
After their measurements had been consolidated, the later cleanup also
removed the obsolete v48-v55 gates, npm, pnpm, Electron, Playwright, and
node-gyp caches produced by repeated preparation. It recovered another
15,833,620,480 physical bytes before the v58 gate. The retained set keeps the
cited campaign evidence, the comparator campaign, v56, and v57. No benchmark
or indexing worker remained active, and the volume had about 353 GiB free.

The subsequent v56 prompt-only gate tested a 60,000-character client default.
Readiness remained 5,112 ms. The 34,137-character page added 12,002 characters
from `watch.spec.ts`, the file where the accepted v55 edit ultimately placed
the focused test after a broad shell-discovery cycle. The page also retained
the implementation, callers, directly related complete test module, explicit
incomplete-page status, and continuation. This qualifies the larger client
default for one measured agent sample; acceptance still depended on reducing
total context and command cycles rather than only enlarging the first packet.

The single v57 Luna sample passed the grader and the focused Playwright test.
It used 1,703,720 input tokens and 7,933 output tokens, down 45 percent from
v55's combined input and output count, but still above every retained
Playwright competitor median. It performed 25 command actions and observed
92,703 repository-context characters. Before the first edit, Urdira supplied
36,293 characters across the prompt hook, translated hooks, and one direct MCP
call, 71.0 percent of the observed repository context at that point. The
direct MCP call repeated `affectedTestFiles` even though the prompt packet
already contained its source. The populated packet no longer advertises that
tool; persistent instructions still retain named-detail and continuation
recovery.

Transcript review found that the extra 12,002-character `watch.spec.ts`
hydration introduced by the 60,000-character default did not contribute to the
v57 edit or validation. The product default therefore remains 40,000
characters. The result stays available through the page continuation, and
clients can still choose a larger budget when their task needs it.

The retained competitors did not execute a focused test because their old
checkouts lacked dependencies. v57 built the changed runtime, observed one
stale-build failure, then passed the focused test three times across the
required follow-up and final-review turns. Its stronger validation means the
token figures are useful for diagnosis but are not equal-verification proof
against those retained samples. The v57 checkout peaked at 572,850,176
physical bytes and its index at 1,572,954,112 bytes; both were removed by the
run trap. The retained result is 1.8 MiB.

## V58 focused context gate

V58 kept the public 40,000-character client budget and changed lexical test
hydration only when no declaration-like or callable record contains the exact
match. In that case `mode: relevant` now remains centered on the indexed match
instead of promoting hydration to the complete module. Full declaration
hydration remains unchanged when a containing callable exists, and the page
retains its continuation and projection metadata.

The first real gate exposed an application-routing regression before measuring
context: a complete Codex `UserPromptSubmit` payload was incorrectly treated
like an incomplete static hook probe and never connected to the running daemon.
A regression now keeps only payloads missing their prompt or working directory
on the static path; complete Claude and Codex prompt hooks resolve indexed
context.

After that repair, the frozen Playwright commit reached complete current
structural readiness in 4,930 ms with semantic indexing and materialization
disabled. The populated prompt packet was 12,034 characters, down 64.7 percent
from v56's 34,137 characters. It retained six sources, including the
implementation, both callers, and relevant windows from both test files. The
`test-server.spec.ts` source fell from 12,002 characters to 1,111 and the
`watch.spec.ts` source to 744 while retaining the affected-test assertions.
The page remained explicitly incomplete and provided its portable
continuation. The temporary checkout, index, and package-manager cache created
by the gate occupied 1,131,249,664 physical bytes and were removed immediately
afterward.

## V59 measured Playwright sample and next repair

The single v59 Luna sample used the same frozen Playwright commit and semantic
indexing remained fully disabled. Structural readiness completed in 6,991 ms.
The agent made the required two-file change, the runner and grader exited zero,
the agent ran the focused test twice successfully, and an independent focused
test passed after the run. Its final patch hash is
`675f1ccf6c667d612ecb93662dc02ff6d02d94e4cfdc9b06da453e2d4f480ae7`.

The host recorded 724,044 input tokens, 6,552 output tokens, and 2,771 reasoning
tokens. The host's input-plus-output total is 730,596; the campaign report's
comparison convention, which also includes reasoning tokens, is 733,367. On
that convention this is 57.2 percent below v57's 1,714,631, below every
successful retained Playwright codebase-memory, codegraph, and tgrep sample,
and 16.7 percent above the retained baseline median of 628,159. The comparison
is diagnostic rather than equal-validation proof: retained competitors ran no
focused tests, while v59 produced three successful focused-test observations.

V59 observed 57,789 repository-context characters: 12,706 from Urdira hooks
and 45,083 from shell. Before the first edit, the corresponding split was
12,706 versus 33,357, so Urdira supplied only 27.6 percent. The audit recorded
19 hook interceptions, of which five were served and fourteen fell back with
`unsupported_input`. Transcript inspection showed that the dominant fallback
shape was a faithfully separable `rg` or `sed -n` repository read embedded in
a command sequence joined with conditional `&&`.

The Codex bridge now parses top-level semicolon and `&&` sequences while
respecting quotes. It preserves every separator and native segment, replaces
each independently translatable repository read with Urdira output, and leaves
an unsupported or incomplete segment native. A failing regression derived from
the v59 command shape was added first; the repaired hook and MCP suites pass 73
tests.

The model-visible production MCP catalog was also measured independently. Its
three closed schemas, tool descriptions, and server instructions occupied
28,579 characters. Copy-ready context, source, and continuation requests
appeared in both tool descriptions and server instructions. Those examples now
have one authoritative advertised occurrence in the server instructions;
concise tool descriptions retain role and routing guidance, and the complete
closed schemas and registry-derived operation catalog remain unchanged. The
catalog now occupies 23,251 characters, a reduction of 5,328 characters or
18.6 percent per model iteration. This repair has focused verification but has
not yet received a measured agent sample.

The v59 checkout, dependency tree, index, npm cache, and regenerated pnpm cache
occupied 2,215,518,208 physical bytes and were removed immediately. Together
with the package/runtime and store cleanup performed before the sample, this
session recovered more than 18 GiB of attributable regenerable data. No
benchmark or indexing process remained active after cleanup.

## V60-V62 Playwright checks

V60 recorded 637,158 comparable tokens and passed the path-level grader, but
its agent-side focused test used an incompletely prepared checkout and failed.
It is therefore excluded from equal-correctness comparison. V61 used
1,361,364 comparable tokens and passed three agent-side focused tests, but the
strict grader rejected the run after a malformed direct query; it is retained
as a failed integration sample.

V62 restored the strict grader and independent focused validation. Its exact
two-test selector passed 2/2 and the retained patch hash is
`d0d4fd1e1d81837d37d6eff695e4ec3a0775e7ec4ee7d78e6a3fe3198b697689`.
Structural readiness completed in 6,965 ms with semantics disabled, so this
sample does not support an indexing-readiness regression. It used 1,264,535
input tokens, 10,013 output tokens, and 3,574 reasoning tokens: 1,278,122 by
the campaign comparison convention, about twice the retained baseline median
of 628,159. Correctness is accepted; efficiency is rejected.

The corrected offline replay attributes `PreToolUse` replacement-file bytes
to the serving Urdira hook and removes the same bytes and hook marker from
shell output. V62 contains 19,756 MCP characters, 16,384 hook characters, and
40,846 native-shell characters. Before the first edit, Urdira supplied 35,663
of 61,502 observed repository-context characters, or 58.0 percent. Original
transcripts, hook audit, patch, and hashes remain unchanged; the derived replay
is `transcript-metrics-corrected.json` in the v62 result directory.

The real prompt gate produced 12,110 model-visible characters and five source
fragments. Two authenticated v3 continuations occupied 514 and 513 characters,
approximately half the previous JSON-deflate/hex representation, and an exact
continuation succeeded against the same daemon. That gate predated the
architecture check: the accepted v3 framing keeps Brotli and compact claims but
uses hexadecimal bytes, as required by the native-pipeline boundary; v2 and
legacy references remain accepted. A restart test also confirmed the known runtime limitation:
the in-memory manifest and process-local authentication key are not durable.
Persisting only the key would decode a reference whose immutable manifest no
longer exists, so restart durability remains an explicit gap rather than a
misleading partial implementation.

The next bounded hypothesis is hook-first delivery. Codex prompt and pre-tool
hooks are the discovery surface, and their served bytes count as Urdira use.
The benchmark no longer injects the same Urdira MCP catalog into every model
turn. The prompt packet supplies the exact scope and default test sources and
asks the agent to begin the task before following `MORE`; when a concrete fact
is missing, the literal continuation envelope can be executed through
`urdira query --payload ... --json`. Competitor arms and non-hook MCP clients
retain their existing transports. Only one fresh Playwright sample is allowed
before reviewing this hypothesis.

## V63 hook-first Playwright sample

V63 passes the strict grader and an independent four-test selector covering
deterministic ordering plus existing changed-file, CJS dependency, and ESM
dependency behavior. The accepted patch updates the deterministic helper, its
live watcher caller, and the focused watch test. Structural readiness completed
in 6,978 ms with semantics disabled. The patch and independent test remain in
the v63 result directory.

The efficiency hypothesis is rejected. Final cumulative usage is 2,395,298
input tokens, 13,719 output tokens, and 5,310 reasoning tokens, or 2,414,327
comparable tokens. Urdira supplied 81.2 percent of repository context before
the first edit and 75,317 hook characters overall; native shell supplied
51,374. The first packet already contained the implementation, live watcher
caller, other production callers, and a relevant watch-test snippet. The agent
still inventoried test files, postponed the watcher wiring until the second
turn, and performed repeated build discovery. Removing the duplicate MCP
catalog therefore did not remove the dominant agent-action overhead.

V63 also exposed a concrete continuation failure. A login shell prepended the
host-native closure ahead of the isolated benchmark shim, so `urdira query`
resolved a release launcher outside an extracted release root and failed with
`No such file or directory`. The runner now places the isolated Urdira bin
before the Node/native directory in its generated `.zprofile`; an isolated
login-shell gate resolves that shim and reports version 0.3.3. The prompt packet
also provides a compact source guide separating production and test snippets
and asks the first implementation pass to inspect listed production snippets
for callers and public wiring. These are new hypotheses and are not attributed
to the v63 result.

V63 cleanup removed 2,275,569,664 logical bytes across its checkout, Urdira
data root, and npm cache. The pnpm store prune found no retained packages. Free
space remained 353 GiB and no benchmark or indexing process remained active.

## V64 source-guide Playwright sample

V64 again passes the strict grader and the same independent four-test selector.
Structural readiness was 6,983 ms. Its 1,629,266 input, 9,666 output, and 4,087
reasoning tokens total 1,643,019 on the comparison convention. This improves
31.9 percent over v63 but remains 161.6 percent above the retained baseline
median and above every retained competitor median.

Urdira supplied 83.5 percent of repository context before the first edit. The
complete run contained 40,395 hook characters and 35,832 native-shell
characters, with no MCP catalog and no consumed continuation. The source guide
did not stop the agent from inventorying paths and build configuration, and it
again deferred the already supplied watcher caller until the second turn. The
next hypothesis therefore makes the populated packet explicitly action-ready:
begin with an edit from its snippets, inspect supplied caller wiring in that
first pass, and avoid repository inventory before the edit. This guidance does
not prevent a later query or shell read for a named missing fact.

V64 cleanup removed 2,232,647,680 logical bytes across checkout, data root,
and npm cache; pnpm retained nothing and free space remained 353 GiB.

## V65 action-ready Playwright sample

V65 passes the strict grader and the independent four-test selector. It makes
the requested implementation and focused test change without the unnecessary
watcher-caller rewrite from v63 and v64. Structural readiness completed in
6,931 ms. Final usage is 977,038 input, 5,965 output, and 1,991 reasoning
tokens, or 984,994 comparable tokens. This is 40.0 percent below v64 and below
the retained successful tgrep samples, but remains 56.8 percent above the
retained baseline median.

The action-ready packet changes the work sequence materially. Before the first
edit, Urdira supplied all 13,760 observed repository-source characters and
shell supplied zero. The first turn used 521,568 comparable tokens, below the
retained baseline median, and nine commands instead of v64's eighteen. Across
the complete three-turn protocol, Urdira hooks supplied 25,434 characters.

The remaining dominant context is validation output rather than repository
discovery: a successful repository build emitted approximately 608,000 shell
characters. Production agent guidance now asks noisy successful builds to write
their full output to a temporary log and return one success line; failures must
retain a bounded diagnostic tail. This preserves validation and error evidence
without feeding routine progress output through every later model turn. V65
cleanup removed 2,235,174,912 logical bytes and left 353 GiB free.

## V66-V67 bounded shell-projection checks

V66 passes the strict grader and an independent four-test selector with the
same correct two-file change as v65. Structural readiness is 6,953 ms. Its
first turn uses 600,579 comparable tokens and its final cumulative usage is
1,072,528. The successful build is reduced to the intended 16-character
confirmation, proving the build-output guidance works. Before the first edit,
Urdira again supplies all 13,754 observed repository-context characters.

The remaining concrete leak in v66 is an `rg` command composed with both
`2>/dev/null` and `head -40`. It remains native and emits 22,874 characters
because a generated declaration is one very long line. A test derived from the
exact command now proves that the hook accepts the combined projection,
preserves all explicit paths and the requested line count, applies the
host-selected character budget, declares projection of an oversized source
line, and retains continuation or exact Urdira source recovery. V66 cleanup
removed 2,232,737,792 logical bytes and left 352.9 GiB free.

V67 also passes the strict grader and independent validation (4/4) and retains
the correct two-file patch with SHA-256
`dbeaffe9924ba90a3aeadcf1006e1338f2cfd37930c49d04e36ebe5374e61752`.
Structural readiness is 6,942 ms, so neither sample supports an indexing
readiness regression. The exact v66 search did not recur; the parser repair is
therefore evidenced by its regression, not inferred from this agent sample.

V67 uses 712,791 comparable tokens in the first turn and 1,238,986 cumulatively.
Before the first edit, Urdira supplies all 13,762 observed repository context.
Across the session it supplies 14,148 hook characters while native shell
supplies 52,789. The sample exposes different avoidable validation work: one
wrapper fails because it assigns zsh's reserved `status` parameter, then the
agent rediscovers build configuration and repeats successful build/test work in
later handoff turns without a relevant edit. Installed guidance now requires a
task-specific exit variable, explicit wrapper separators, and reuse of current
successful validation. V67 cleanup removes 2,235,768,832 logical bytes across
22 owned entries, including its checkout, index, npm cache, validation-log
directories, and hook-output files; 352.9 GiB remains free.

V68 validates the next integration hypothesis. The agent uses task-specific
`test_exit_code` and `build_exit_code` variables, so no zsh wrapper fails on the
reserved `status` parameter. After the build and focused deterministic test
pass, neither follow-up handoff repeats them without a relevant edit. The strict
grader passes with the same two-file implementation; the retained patch hash is
`c9b4dfe2b2b08b7bfb0ce1277761fa1b2b1e71290075bea033cc3ae0b76b092b`.
Readiness remains stable at 6,957 ms with semantics disabled.

The sample uses 283,771 comparable tokens in the first turn and 659,789
cumulatively. Urdira supplies all 13,962 observed repository context before the
first edit and 22,198 hook characters overall; native shell supplies 22,565.
This is 5.0 percent above the retained baseline median, but it is not eligible
for equal-correctness comparison: independent validation passes two selected
watcher cases and times out after 30 seconds in `should run on changed files`.
The failure is retained without retry. Cleanup removes 2,231,128,064 logical
bytes across the checkout, index, npm cache, validation logs, and hook outputs;
352.8 GiB remains free.

## Verification after the v55 repairs

The complete verification stages passed after correcting one test-only type
narrowing error: architecture, native release build, Rust formatting and
Clippy, all ordinary and ignored native tests, lint, 2,465 TypeScript tests,
coverage, typecheck, coverage policy, and publication hygiene. Repository
coverage was 90.47 percent of lines, with all 15 critical branches and all
semantic regions covered. The host-target production archive then passed the
release acceptance suite, including unit, contract, integration, end-to-end,
crash, corruption, security, watcher, benchmark, and package inspection gates.

Verification output was removed immediately afterward: Rust targets, release
staging and archive, coverage, typecheck output, and test scratch directories.
The retained host-native closure is approximately 134 MiB and supplies the
exact production worker for the next focused context gate. The repository is
again approximately 1.24 GiB, external benchmark evidence approximately 601
MiB, the system temporary root 16 MiB, and no verification, benchmark, or
indexing process remains active.

## Final product and release verification

After the v68 integration check, `CI=true pnpm verify` passed in full. This
covered architecture, native release builds, Rust formatting and Clippy, all
ordinary and ignored native tests, lint, 2,473 passing TypeScript tests with 17
skipped, typecheck, coverage policy, and publication hygiene. Repository line
coverage was 90.51 percent; all 15 critical branches and all semantic regions
were covered.

The documented host-target release commands also passed for `darwin-arm64`.
The generated 184,429,640-byte archive passed unit, contract, integration,
end-to-end, crash, corruption, security, watcher, deterministic benchmark and
package-inspection gates. The package digest was
`sha256:ffc55e2c2013281467dcd897e589c9f295b2bff2b7765a5eafb0be17b27b9a60`.
An earlier target-unspecified packaging invocation is not a product failure: it
requested all five release targets on a host that only contained the declared
`darwin-arm64` native closure.

Verification cleanup removed 5,012,748 KiB of regenerable Rust targets,
coverage data, release staging and the release archive. Available filesystem
space increased by 4,981,336 KiB, to approximately 352.7 GiB. No Urdira-owned
system temporary directory remained after the release suite.

## Current Prisma v69 and VS Code v70 samples

Prisma v69 passes the strict grader. After building the declared internal
package dependencies, independent validation passes 260 tests across 14 test
files and the package typecheck. Structural readiness is 7,424 ms. Urdira
supplies all 24,689 observed repository-context characters before the first
edit through three prompt hooks; shell supplies none in that interval. Final
usage is 655,001 input, 7,578 output and 3,848 reasoning tokens, or 666,427
comparable tokens. This improves on the accepted v49 sample at 853,188 and the
retained Prisma baseline median at 882,221. Cleanup removes 2,919,981,056
logical bytes from the checkout, index and hook output before the next sample.

VS Code v70 is retained as a failed integration sample without retry. The
agent's patch independently compiles with zero errors, passes its focused tests
4/4 and passes ESLint for both changed files, but the strict grader rejects IPC
errors. The initial prompt hook exceeds its 30-second host window; the model
then invokes `urdira index --json`, which times out behind the still-running
context query, and `urdira query --help`, which is not a registered option.
Only 882 Urdira hook characters reach the model before the first edit, compared
with 91,993 source characters read through shell. Final usage is 2,484,453
input, 12,755 output and 5,662 reasoning tokens, or 2,502,870 comparable
tokens. Structural readiness is 86,416 ms, but it is not comparable with
v50's 49,648 ms: v70 ran `compile-client` before indexing and therefore left
the generated `out/` tree in the source frontier. The initial catalog contains
27,589 rows; a later `clean-out`/compile cycle reduces the reconciled frontier
to 11,864 rows. The measurement is a preparation confound, not evidence that
the context changes regressed structural indexing.

The retained host trace identifies the expansion cause. The task names both
the precise `LanguageFeatureRegistry` class and the repository-wide member
`onDidChange`; context construction treated both task identifiers as equal
roots. The hook now sends its first code-shaped identifier as an explicit
symbol seed, and explicit seeds define context membership while the complete
task text only orders that context. Deterministic regressions cover the exact
`LanguageFeatureRegistry`/`onDidChange` shape and prove that incidental task
identifiers do not call the indexed name resolver. This repair postdates v70
and is not attributed to it. V70 cleanup removes 31,509,893,120 logical bytes
from its checkout, 21-GiB index, npm cache and validation logs; no retry is
performed.

## Verification after the v70 context-root repair

The repair was verified from the current working tree rather than inferred
from the failed sample. `CI=true pnpm verify` passed architecture, native
release builds, Rust formatting and Clippy, all ordinary and ignored native
tests, lint, 2,474 passing TypeScript tests with 17 skipped, typecheck,
coverage policy, and publication hygiene. Repository line coverage was 90.45
percent; all 15 critical branches and all semantic regions were covered.

The production `darwin-arm64` archive was then rebuilt from that tree. Its
size is 184,429,721 bytes and its SHA-256 digest is
`9746d60848d36f1d89f86f5b5c8a4d792914981e1e9cc50a91d3d36ece1f2b2e`.
The installed release acceptance suite passed unit, contract, integration,
end-to-end, crash, corruption, security, watcher, deterministic benchmark,
and package-inspection gates. These checks prove the context-root behavior and
the distributable integration. They do not turn v70 into an accepted agent
sample or provide a post-repair VS Code token measurement.
