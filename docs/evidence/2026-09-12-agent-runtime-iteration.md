# Agent runtime iteration after live verification

Date: 2026-09-12. The user explicitly requested continued repairs and validation
until the integration works. This supersedes the previous no-retry execution
boundary; every failed attempt remains retained separately. Earlier evidence:
[live verification](2026-09-12-agent-live-verification.md).

## Launcher repair

Production installation previously wrote `urdira agent hook`, leaving executable
selection to the host PATH. The CLI now supplies its exact Node executable and
entry point to the integration installer. Hooks, MCP configurations and OpenCode
tools use that supplied launcher. Reinstallation refreshes managed hooks instead
of retaining an old PATH-based command; unrelated entries remain preserved.
The benchmark uses the same installer with its exact isolated launcher.
Decision 19 and README describe this behavior. No public Schema IR fields change.

The new regression first failed with exit 127 (`urdira: command not found`), then
passed using an empty host PATH, a quoted launcher path, and repeated installation.
The focused bridge and runner suites pass 30 tests. The actual Luna host probe
also passes: `node --version` executes through the managed hook and returns
`v24.18.1`, exit 0. This is an environment probe, not a repository task result.

Artifacts: `/Users/Cristian/BenchmarkResults/urdira-agent-iteration-20260912/`.
`hook-probe.jsonl` retains the real command result. The probe uses the production
CLI modules and an isolated configuration home, without changing global user
configuration or installing a different runtime.

The host environment settings were checked against the official
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
No unverified host environment override was needed for the successful probe.

## Agent guidance

Context instructions emphasize the required API version. Source guidance
distinguishes projection limits from response budget and tells the agent to keep
the requested projection stable when applying the returned minimum response size.
Symbol guidance distinguishes contextual resolution from an exact path filter;
scalar bindings still reject ambiguity. Test guidance requests enclosing suite
and import context and requires host execution for test-registration/module checks.
These changes do not weaken validation or alter pagination, coverage or source.

## Measurement and verification

Hook-trust notices no longer increment `hook_error_count`; real rejection/error
messages do. The regression first observed an incorrect count of one, then
passed with zero for the warning and one for an actual blocked hook. The runner
now preserves only raw session JSONL files before isolated-home cleanup, with
SHA-256 hashes and distinct rejected call IDs. It never copies authentication.
Host evidence stays separate from completed MCP/shell character accounting and
is retained in offline replay. Missing host evidence remains `null`.

`CI=true pnpm verify` passed the native stages and coverage: 2,401 tests passed,
15 skipped; measured lines 30,191/33,427. It then found an index-signature access
in the new metric test, corrected to bracket access. The follow-up typecheck
passed. Lint overlapped release staging cleanup and hit a disappearing generated
file; after packaging finished, sequential lint, architecture, coverage and
publication checks all passed. Coverage gate reports 90.32%, critical branches
and semantic regions both 100%. No native source was changed in this iteration.

The subsequent focused run passes 50 tests across the bridge, runner, metrics
and new host-evidence suites, including preservation of raw session bytes,
deduplicated rejections, missing-session handling and authentication exclusion.
`CI=true URDIRA_RELEASE_TARGET=darwin-arm64 pnpm package:release` passes.
Release acceptance and subsequent live outcomes are recorded below when complete.

## First repaired live sample and next hypothesis

Release acceptance passed. The archive SHA-256 at that gate is
`34389e9e7c07005a9cdb615123cc3f9f9c0c7e17d93d7f81492a879eb1b23eb8`;
the worker remains unchanged. The first new Playwright sample passes the strict
grader, executes the new deterministic-order and existing dependency-watch tests,
and records zero host-hook rejections. Its elapsed agent time is 310,766 ms.
However, it uses native source discovery after an empty indexed test search,
despite available indexed text/artifact/source operations. This does not satisfy
the user's source-reuse goal; the passing grader is not the final acceptance.

The next bounded repair clarifies that zero matches do not authorize a shell
fallback: vary indexed terms, find artifacts and request missing source through
Urdira before treating a capability or retrieval failure as a native fallback.
The instruction regression first failed, then passed. Measurement also previously
missed tests invoked as `node .../cli test` behind a login shell; its regression
now recognizes them and keeps outcomes unknown when a compound command can mask
the test's exit. The four focused suites pass 89 tests, followed by CLI/MCP/app
builds and lint. Subsequent samples use these updated instructions, rather than
claiming the earlier archive includes the later guidance changes.

## Additive Codex developer guidance

The second retained Playwright attempt completed the task and its regression,
but still read indexed source through shell after consuming three context pages.
The raw host transcript had Urdira guidance in AGENTS.md/skill content and no
Urdira retrieval rule in a developer-role message. The previous statement that
Codex global AGENTS.md itself was developer guidance was incorrect.

The production installer now patches a managed block in the additive
`developer_instructions` configuration using a TOML syntax-preserving adapter.
It retains existing instructions and comments, does not replace the host base
instructions, and rejects invalid configuration before writing integrations.
A failing installer regression preceded the fix; installation, idempotent
upgrade, removal and invalid-configuration cases pass. An isolated actual
Luna host probe confirmed the retrieval rule in a developer-role message. This
is a wiring observation, not yet evidence that a task avoids native retrieval.

The first and second task attempts, source patches, generated bundles and raw
host sessions remain under the iteration evidence root. Another attempt follows
this distinct configuration hypothesis under the user's authorization to keep
repairing and verifying.

## Native lexical false negatives

Attempt 3 retained the additive developer guidance but still used shell after
filtered lexical searches returned zero results. Inspection found a concrete
product bug: the native lexical path matcher replaced `**` with `.*`, then
replaced that inserted `*` again, preventing recursive directory matches.
The production native port now uses the engine's existing normalized glob
matcher. A failing native-store regression covers alternative patterns,
recursive and shallow paths, zero nested directories and cursor exhaustion.
The same port ignored the requested identifier/token word boundary mode;
a second failing regression now requires exact identifier boundaries. Both
repairs reuse existing engine predicates and add no index or benchmark rules.

The installer upgrade/removal regression also covers an unrelated command hook
sharing the same matcher group as a managed Urdira hook. Only the managed
command is removed or replaced; unrelated commands remain in their original
group. The previous group-level filter lost those commands.

## Inter-turn readiness correction

Prisma attempt 1 implemented the edit using Urdira source, passed the package
suite (262 tests) and then the focused naming suite (80 tests), but the driver
stalled after turn 1. The retained `prisma-interturn-stall.json` shows complete,
equivalent, idle source and structural frontiers bound to source snapshot 13,
while aggregate freshness remained `indexing` and the unavailable semantic lane
was marked `building`. The driver incorrectly gated on aggregate freshness.
The attempt was stopped through its own host; the failure manifest, original
transcript and host sessions are retained. It is not a completed sample.

Initial warm readiness and inter-turn readiness now share a predicate requiring
complete idle source/structural lanes, current/equivalent freshness and matching
source-snapshot bindings. Missing, stale, building or mismatched lanes are
rejected. Semantic readiness does not enter this structural-only gate. Failing
regressions used both a synthetic mixed-lane state and the captured live status.

Hook scope is now fail-open without an indexed query when neither explicit
`cwd` nor `working_directory` is supplied. It no longer substitutes the
integration process directory. The failing direct regression preceded the
change; the full TypeScript gate includes the persistent regression.

## Retained final-package samples and pipeline batch correction

The next full `CI=true pnpm verify` run passed native checks and 2,412 tests
(15 skipped), then failed typecheck on two newly added fixture objects. Removing
an extraneous `path` field fixed the fixtures; their 23 focused tests, typecheck,
lint, architecture, coverage and publication follow-ups passed. Coverage was
90.29% (30,231/33,481 lines), with critical branches and semantic regions at 100%.
The combined command itself did not exit successfully. Packaging and all eleven
release-acceptance gates subsequently passed for archive SHA-256
`ddeefb66e8925b4fd0a44b3e85ff1fa5ae916a97ef1e7d16080a9f40898ab8d8`.

Playwright attempt 5 retained a correct edit and passing focused test, but failed
the integration grader: two resolved declarations bound to
`find_references.target` raised a scalar cardinality error. Prisma attempt 2
completed all three turns without the structural-readiness stall and passed its
76 naming tests. Both still used native source reads. A passing task grader does
not establish source-reuse acceptance. Original manifests, host sessions and
patches are retained, and `replay-through-playwright5-prisma2.json` is a separate
derived report over all seven attempts.

The pipeline regression initially failed for zero, one and two declarations.
V3 normalization now consults `batchable_fields` and lowers scalar batch bindings
to the existing `expand.operation` port. The real-workspace examples then exposed
a second defect: the canonical reference adapter still wrapped every target as
one scalar selector. Its indexed and resident paths now evaluate the complete
set, preserve distinct reference records and deduplicate owners. Direct scalar
operation requests and existing persisted execution manifests are unchanged.
The four focused pipeline, planner, recipe and canonical suites pass 214 tests,
including duplicate targets and an indexed path that forbids corpus fallback.
The subsequent full gate and installed integration outcomes follow below.

The Prisma transcript additionally exposed unrecognized executable-path test
commands. A standalone before/after regression observed zero attempts before
and one afterwards for `node_modules/.bin/vitest`. The regression also rejects
`cat node_modules/.bin/vitest` as a test and keeps newline-masked exit status
unknown. The corrected replay is `replay-through-prisma2-corrected-test-paths.json`;
the earlier report and all source transcripts remain unchanged.

The follow-up combined verification passed native builds, formatting, Clippy and
native tests, then reported 2,416 passing TypeScript tests and two stale guidance
assertions (15 skipped). Both assertions were aligned with the new non-batchable
scalar wording; the three affected suites then passed all 98 tests. Typecheck,
lint, architecture, publication and the coverage gate passed. Measured lines are
90.33% (30,253/33,493); critical branches and semantic regions remain 100%.
`batch-final-verify.log` retains the failed combined exit, while separately named
follow-up logs retain the successful checks. No native code changed after its
successful gate.

## Installed archive failure discovered after unit gates

The installed-daemon probe discovered an actual archive-mode and failed-spawn
defect; see [installed worker execution](2026-09-12-installed-worker-execution.md).
Both regressions pass after repair. A fresh full verification was started, and
the defective archive and probe failures remain retained.

## Complete gate after installed-worker repairs

`CI=true pnpm verify` completed with exit 0 on the repaired tree. Coverage is
90.39% (30,279/33,498 lines), with critical branches and semantic regions at 100%.
Architecture, native builds/checks/tests, lint, TypeScript tests, typecheck,
coverage gate and publication all passed. The exact combined log is
`installed-worker-final-verify.log`; it supersedes no earlier failed evidence.

After the installed structural-loader repair, `CI=true pnpm verify` again
completed with exit 0: 160 test files passed, two skipped; 2,421 tests passed,
15 skipped. Measured coverage is 90.33% (30,262/33,502 lines), with critical
branches and semantic regions at 100%. The complete final-source log is
`final-installed-query-verify.log`. Packaging and installed acceptance use this
same source tree; earlier archive probes remain separate evidence.

## Accepted package and clean-sample preparation

Release acceptance passes all eleven gates. The accepted archive digest is
`516e6170fa717312b0f3406e9370a3774d467bd1d81c9c67d837035e634e638f`.
The worker digest remains
`00648c73672f507c45f306bb88d2b3cf4bdc29d8c364483e9204d85313e1e567`.
An attestation matches 219 composed JavaScript modules to the extracted archive.
The untouched installed MCP probe returns both declarations and references and
then two complete source bodies without truncation or shell source retrieval.
Those source results occupy 46,242 rendered characters; this is a requested
projection observation, not an absolute efficiency acceptance threshold.

Playwright attempt 6 passes its task grader and focused tests but is excluded
from comparison: its initial indexed search returned ignored `test-results`
from an earlier attempt in the reused worktree. The raw outcome is unchanged;
`playwright-iteration6-integrity.json` records the exclusion. Its build-script
`--help` invocation also ran nested dependency installation. It does not qualify
as a clean dependency-frozen agent sample.

The next three samples use newly created detached worktrees at the frozen
revisions. Dependencies and baseline builds are installed afresh; no previous
worktree directory is copied. The runtime build is unchanged, so this repairs
sample isolation rather than changing the product after qualification.


## Fresh samples on the qualified runtime

The frozen fresh worktrees are attested in `fresh-baseline-attestation.json`.
Playwright 7 passes its grader and ultimately its deterministic-order regression,
with no MCP/coverage/IPC errors. It still performs six shell discovery calls.
Those calls remain subject to purpose and overlap review; their existence alone
is not an integration failure.
Its `node utils/build/build.js --help` command actually rebuilt the project and
ran nested `npm ci`; the claim that no dependencies were installed is not valid
for the whole attempt. This remains a protocol caveat, not a clean acceptance.

Prisma 3 passes 81 focused naming tests and package typecheck. Its strict grader
fails because an initially malformed query and a continuation budget diagnostic
remain in the transcript. Both were recovered through Urdira: the latter by an
explicitly scoped source query with a larger client budget. The full source was
returned. Eight shell discovery calls remain; zero fallback is not established.
This count does not distinguish verification or new information from repeated
source and therefore is not an acceptance result by itself.

VS Code 1 fails on actual structural corruption before its first context result.
The separate [partition integrity evidence](2026-09-12-structural-partition-write-integrity.md)
records the data loss and repair. The agent's grep-only Electron test invocation
loads unrelated test modules and fails. Independent verification subsequently
rebuilt the changed source and ran `VSCODE_SKIP_PRELAUNCH=1 ./scripts/test.sh
--run src/vs/editor/test/common/languageFeatureRegistry.test.ts`: three checks
pass, but the log still has an unhandled missing native `@vscode/fs-copyfile`
error. This does not constitute a clean dependency-ready test environment.
The next fresh worktree prepares that existing declared native dependency
before invoking the model. It does not copy any prior attempted solution.

## Completed transport replay

Four new metric regressions fail before the repair and pass afterward. The
focused metric/report suites pass 27 tests. `completed_tool_output` includes all
completed MCP/shell text, retains missing values as null and counts tgrep only
within shell. Exact earlier custom-script evidence now identifies later identical
test invocations even without repeated npm command echo; ambiguous compound
failure exits stay unknown. Legacy discovery fields retain their original scope.

`replay-with-completed-transport.json` derives 112 retained transcripts, including
v13/v14 and historical competitors, without executing any model or competitor.
Original transcript and manifest hashes remain recorded. On the fresh samples:

| Sample | MCP text chars | Shell text chars | Combined tool text | Legacy discovery chars |
| --- | ---: | ---: | ---: | ---: |
| Playwright 7 | 103,343 | 72,580 | 175,923 | 142,023 |
| Prisma 3 | 82,980 | 54,412 | 137,392 | 122,534 |
| VS Code 1 | 27,116 | 103,398 | 130,514 | 106,074 |

These are UTF-16 text counts, not full model context, token counts or success
thresholds. Full model context and unsupported subjective contribution metrics
remain null. Playwright's corrected test attempts include one retained failure
before rebuilding and two passes afterward. Three samples do not establish a
statistical efficiency improvement, and these failed/caveated outcomes remain
part of the evidence after further repairs.


The new VS Code preparation explicitly runs `npm rebuild @vscode/fs-copyfile`
and `npm run electron`, then selects the unchanged `languageSelector.test.ts`
file with `--run`. All 13 baseline checks pass without the earlier uncaught
native-module error. These are preparation commands, outside the measured agent
phase; the task and frozen revision remain unchanged.

## Final VS Code iteration on the repaired runtime

VS Code 2 completes successfully with grader exit 0 on the runtime retained in
`integrity-repair/accepted-runtime-attestation.json`. Structural preparation
takes 86,388 ms and the agent phase takes 524,029 ms. Tool-call, validation,
coverage and IPC error flags are false. The original first-context request and
subsequent broad indexed searches complete without the former checksum error.
The installed full-corpus probe and independent store verification are recorded
in [partition integrity evidence](2026-09-12-structural-partition-write-integrity.md).

The changed registry passes its focused Node run (three checks, including the
runner's error guard). The agent's browser attempt cannot find Chromium in its
isolated home. This failed attempt remains in the original transcript. After
the sample ends, Chromium is prepared in the separate
`integrity-repair/browsers/` cache and the final changed source is rebuilt with
`npm run transpile-client`. Independent validation uses the explicit
`PLAYWRIGHT_BROWSERS_PATH` and runs:

```bash
npm run test-browser-no-install -- \
  --run src/vs/editor/test/common/languageFeatureRegistry.test.ts \
  --browser chromium
```

Both browser tests pass; the process exits 0. Logs are
`integrity-repair/browser-preparation.log`,
`integrity-repair/vscode-final-independent-transpile.log` and
`integrity-repair/vscode-final-browser-tests.log`. This independent result does
not replace the agent's failed browser attempt or mutate its manifest. Future
isolated browser runs need a prepared cache whose path is explicitly passed
into the host environment.

`integrity-repair/final-iteration-replay.json` retains a derived replay of all
12 iteration transcripts, with original hashes. It overlaps the earlier
112-transcript replay; their sizes must not be added as distinct observations.
VS Code 2 contributes 146,182 completed MCP text characters and 157,347 shell
text characters, or 303,529 combined. Legacy discovery-only text is 280,617.
These observations do not establish a reduction in full model context.

The agent makes ten MCP discovery calls and eleven shell discovery calls, with
MCP first. Nine continuations are offered and none is observed consumed. The
edited implementation appears at ordinal two in the first typed context. The
new test file has no observed prior typed context position. Six extracted
record identities are unique, while 5,226 shell source-line characters overlap
previous MCP source; this is an overlap observation, not proof that every such
read was unnecessary. Subjective usefulness and full model context remain null.
The host also emits a large tool catalog and the agent initially uses an
incorrect skill path before correcting it. These are retained host/adoption
limitations, not concealed Urdira source truncation.

An empty `find_related_tests` answer is not evidence that the repository has no
relevant test conventions. A bounded source review confirms this operation uses
registered `core:covers` edges through container ancestors; the existing
pushdown also retains older gaps around relationship-scope, filtering and the
fixture/helper streams. This iteration does not establish complete support for
those broader operation semantics or attribute all shell fallback to them.
The successful runtime result must not be read as certification of every
public query operation or elimination of native discovery.

## Primary-context criterion and host injection

The acceptance interpretation was corrected after the user clarified that
native reads are valid when Urdira still performs the bulk of repository
discovery. New regressions and replay metrics record the first repository
transport, configured-tool and shell volume before the first edit, and later
shell source reads with or without exact line overlap. They do not convert
character share into semantic usefulness or classify shell use as a failure.

The retained VS Code 2 transcript now replays with Urdira first, eight configured
calls and 104,619 configured characters before the first edit, versus three
shell source calls and 27,701 shell characters. Urdira therefore accounts for
79.1% of observed pre-edit repository-context characters. All eleven repository
shell reads occur after the first MCP result; six contain at least one exact
nonblank source line already returned through MCP and five do not. Manual review
shows the early native reads search test conventions after the indexed related-
tests result is empty, while later calls include changed-source review, test-
runner inspection and focused API-use checks. The overlap is a review signal,
not proof that six entire commands were unnecessary.

The integration guidance now says Urdira should supply the main context while
allowing focused shell reads for verification, generated/unindexed state and
identified gaps. Claude Code receives that guidance through a managed
`UserPromptSubmit` hook before prompt processing and retains its `PreToolUse`
search translation. Codex retains additive developer instructions and its
managed `PreToolUse` bridge. OpenCode's model-visible `grep` and `glob` tools
now pass `context.directory` as explicit workspace scope; previously their
generated payload omitted the working directory and could only fall back as an
unsupported request. Uninstalling Claude Code now removes its managed agent
file instead of rewriting that Markdown path as JSON.

The focused daemon-v4, agent-integration, transcript-metric, report and app
runtime suites pass 80 tests. The final corrected immutable replay is retained as
`integrity-repair/final-iteration-replay-context-lead-v3.json`; it covers 12
runs and preserves every transcript and manifest hash from v2. It records zero
hook-served calls because those retained transcripts predate the marker; their
103 direct Urdira uses remain effective Urdira calls. Earlier derived replays
remain unchanged.

The hook attribution contract now treats a successfully intercepted native
search as effective Urdira use. New served responses carry the exact
`[urdira hook served]` marker, and replay keeps their calls and characters in a
separate `hook` method while including them in configured Urdira context. The
native command denied by the hook is not counted as executed shell. Regressions
also prove that an ordinary blocked-hook error and a trust warning do not count,
and that one direct MCP call plus one hook-served call produces two effective
Urdira uses without changing the direct MCP count. Retained transcripts that
predate the marker are not reclassified from ambiguous host messages.

The final runtime passes `CI=true pnpm verify` (2,433 tests passed, 15 skipped),
with 90.40% measured line coverage, 100% critical branches, 100% semantic
regions and 1,132 publication files checked. The rebuilt darwin-arm64 archive
has digest
`sha256:8f396c627dd86010dbe164340b769eb76aa322eac1219a28a5ee3a8cf5a91c12`
and byte length 184,417,614.
Its target-scoped release report passes unit, contract, integration, E2E,
crash, corruption, security, watcher, benchmark and package inspection. A
preceding unscoped acceptance attempt is retained in
`host-integration-verification/release-acceptance-hook-attribution.log`; its ten
functional gates passed and package inspection correctly failed when it looked
for native artifacts for four targets that had not been built. The scoped rerun
is retained in
`host-integration-verification/release-acceptance-hook-attribution-darwin-arm64.log`.
The final package and acceptance runs are retained as
`host-integration-verification/package-release-hook-integration-final-v2.log`
and
`host-integration-verification/release-acceptance-hook-integration-final-v2.log`.

Installed-package testing exposed and fixed three integration failures that
unit-level mocks had not represented. Startup lexical maintenance for an
existing v4 workspace now probes the persisted structural store and routes
native workspaces to their lexical sidecar; persisted queryable and durable
generations are restored before readiness is evaluated. The hook bridge now
uses the closed v3 evidence, diagnostic, registry and snippet option shapes.
Its renderer reads actual paginated stream items and unwraps their values and
source spans instead of assuming the simplified test-array shape.

The final extracted-archive probe is retained under
`host-integration-verification/installed-hook-e2e-final-v3`. With semantics
disabled, the registered scratch workspace reaches current source, structural
and lexical readiness. A Codex `PreToolUse` request for `rg -n hookNeedle`
returns `permissionDecision: "deny"` with
`[urdira hook served]\nsrc/a.ts:1`, so the intercepted command is effective
Urdira use and is not executed or counted as shell. After a full daemon stop
and restart, readiness is restored at structural queryable and durable
generation 1 and the same hook request is served again with the same result.
All failed and caveated earlier samples remain retained.
This is limited integration evidence, not a statistical efficiency result.
