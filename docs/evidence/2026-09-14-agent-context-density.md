# Agent context density: Playwright v71/v72 and VS Code v75

## Scope

This evidence records two directed Urdira-only Playwright samples for
`affected-tests-deterministic` at frozen commit
`1b44f5a441f391538c42c7ce36dd8ce779a5d6a1`. Both used `gpt-5.6-luna`, the
production Codex prompt and pre-tool hooks, structural-only readiness,
`URDIRA_SEMANTIC_INDEX=0`, no competitor execution, and no retry of either
retained sample. A served hook is counted as Urdira use.

The raw evidence is retained outside the repository:

- v71: `/Users/Cristian/BenchmarkResults/urdira-context-density-20260914-v71`
- v72: `/Users/Cristian/BenchmarkResults/urdira-context-density-20260914-v72`

## Regression and repair

V71 passed the strict grader and independent focused Playwright validation, but
used 1,002,098 comparable tokens. The initial Urdira packet supplied the
production implementation and callers before the first edit. The agent then
ran a scoped `rg` containing `--glob '!packages/playwright/lib/**'`. The Codex
bridge incorrectly treated the negative glob as a positive
`StructuralFilter.paths` entry and served an empty complete result. The agent
therefore copied the page continuation; one truncated cursor failed and the
successful continuation added a raw response of more than 10,000 model-visible
tokens to the remaining turns.

The repair keeps exclusion globs on the native path. A focused regression first
demonstrated the incorrect replacement and now verifies that no Urdira query is
issued for a command whose exclusion cannot be represented exactly. The
context engine regression also recognizes `core:function`, `core:method`, and
`core:constructor` as executable containers when hydrating exact lexical test
matches, independently of plugin-specific kind spelling.

V72 removed generated Playwright `lib/` output after dependency and baseline
preparation, before indexing. This prevents source and generated bundles from
competing in the prompt packet. The agent made the production edit directly
from the injected Urdira source before any native repository read. A named test
wiring gap then used focused shell discovery; this is permitted by the product
contract and did not repeat the already supplied production source.

## Correctness and readiness

V72 passed the benchmark's strict grader. The retained patch changes
`packages/playwright/src/transform/compilationCache.ts` and
`tests/playwright-test/only-changed.spec.ts`, covers both declared target
classes, sorts the deduplicated final set, and adds duplicate/input-order
coverage.

The model attempted the focused test before rebuilding the deliberately cleaned
generated Playwright output and observed the expected missing-build failure.
Independent validation then ran the required build and passed:

- the new focused case: 1/1;
- the new case plus the neighboring dependency-semantics case: 2/2;
- `git diff --check`.

Structural readiness was 4,917 ms with 1,586 indexed source paths. The initial
edit frontier reconciled after the edit; semantic indexing and materialization
remained disabled. The worker used for the run was
`target/release/urdira-indexing-worker`, SHA-256
`2d4d981ec9f8fd5c7cbe38a08f8f3ff5f3eebedb0ea4b882167a5ee3792133c5`.

## Context and token comparison

V72 used 569,904 comparable cumulative tokens. Urdira supplied 14,746
characters before the first edit, with configured-context share 1.0. Across the
whole session, the corrected attribution records 19 effective Urdira hook
calls, 11 native shell calls, 18,047 hook characters, and 26,430 shell
characters. The shell calls cover the named test-location gap, diff inspection,
and validation; the implementation source needed for the first edit came from
Urdira.

| Arm | Retained correctness | Comparable tokens | V72 reduction |
|---|---:|---:|---:|
| Urdira v72 | strict grader + independent 2/2 | 569,904 | reference |
| baseline | 3/3 | 628,159 | 9.3% |
| CodeGraph | 3/3 | 864,960 | 34.1% |
| tgrep | 2/3 | 1,089,350 | 47.7% |
| codebase-memory | 2/3 | 1,378,697 | 58.7% |

Competitor values are retained medians from the frozen comparison campaign;
they were not rerun. Correctness and coverage were accepted before comparing
tokens. V72 is one directed sample, so it demonstrates that the current
integration can beat every retained comparator on this task; it is not a
statistical claim about all repositories or tasks.

## Retention and cleanup

Raw transcript SHA-256 is
`a32de8545755c90234913b6d042f6cc24b51ea3492c76f491a13984d7a4050a2`;
manifest SHA-256 is
`65faaebcfbc3271c7a4c67c181e169b929a1930f23948d7973449a00f7f9a20e`;
hook-audit SHA-256 is
`46fd8c5f679dfd78b824108c95531c51f6f184e25433200a195ab0d9dd188f28`.
The patch, patch hash, offline replay, independent validation, and cleanup
manifest are retained alongside them. Cleanup removed the v72 checkout, index,
build log, and exact hook-output directories immediately after validation,
freeing 1,503,841,434 bytes. V71 cleanup separately removed 2,115,940,352
bytes.

## Repository and release verification

The focused context, hook, and documentation regressions passed 213/213 tests.
The complete `CI=true pnpm verify` gate then passed architecture validation,
native builds and checks, native tests including the ignored production-worker
suites, lint, 2,475 TypeScript tests with 17 skips, type checking, the coverage
gate, and publication inspection. Line coverage was 90.44%; critical and
semantic branch regions remained at 100%.

Packaging all platform targets on the arm64 host correctly reported the absent
darwin-x64 native closure. Packaging the installed production target with
`URDIRA_RELEASE_TARGET=darwin-arm64 pnpm package:release` passed, producing the
archive digest
`sha256:a8ae200fc539387305b2faa772db679beb286bddf500c595fe23b363c63c5dcc`.
`URDIRA_RELEASE_TARGET=darwin-arm64 pnpm release:acceptance` also passed its
install, unit, contract, integration, end-to-end, crash, corruption, security,
watcher, benchmark, and package-inspection gates. The retained release report
digest is
`sha256:a5f0b031f00f95231e8249b0c0ebc8d5416f6a05b5a9d8e6ca272e5bf14433ba`.

After verification, exact generated paths were removed: the Rust target,
coverage and type-check outputs, release staging and archive, packaged native
closure, and package/application `dist` directories. This freed a further
5,878,816,586 bytes. The machine-readable cleanup manifest is retained as
`repository-verification-cleanup.json` in the v72 evidence directory; the
16 KiB release report and benchmark evidence remain available.

## VS Code v73, v74 and v75 integration closure

The VS Code sample uses commit `038b9225c82c6b75172beda6081c64887692538c`,
`gpt-5.6-luna`, the `urdira-typescript` arm, structural-only readiness and
`URDIRA_SEMANTIC_INDEX=0`. The two frozen tasks are
`language-registry-change-notification` and
`language-provider-registration-idempotence`. A served pre-tool hook counts as
Urdira use. No competitor or semantic run was executed.

V73 is retained as a preparation failure: both tasks stopped before model
invocation because fresh driver worktrees had no dependencies. V74 is the
post-preparation smoke gate and passed 2/2 with exit 0 and strict grader 0;
readiness was 33,556 ms and 43,860 ms. V75 is the single measurement sample
and also passed 2/2 with exit 0, `completed_successfully=true`, strict grader 0,
and no semantic sidecar. Its structural readiness was 29,537 ms for the
registry task and 43,880 ms for provider registration. The exact worker was
`release/native/darwin-arm64/urdira-indexing-worker`, SHA-256
`1a77ddd4be6b202fc6d1f97faa43c27652aff0636a9755c454c9330cb5070375`.

V75 used 1,248,648 comparable cumulative tokens for the registry task and
1,462,541 for provider registration, 2,711,189 combined. The hook served
56,034 and 30,148 characters respectively before shell fallback. It recorded
13/24 and 11/31 served/effective hook actions; unsupported commands remained
explicit shell fallbacks. The repository-context totals were 162,556 and
235,903 characters, with native shell reads retained in the accounting because
they answered facts the hook did not serve. These figures are observational;
the sample has no absolute context or token success threshold.

Independent validation reconstructed both Luna patches from the frozen
checkout. The provider patch passed its extension TypeScript check and emit,
the focused TypeScript integration suite (3 passing), targeted ESLint and
`git diff --check`. The registry patch passed client transpilation and its
focused Electron unit suite (2 passing), targeted ESLint and `git diff
--check`. The first registry test invocation exposed an incomplete test-only
`ITextModel` fixture (`isTooLargeForSyncing`); adding that method to the
independent fixture made the same focused test pass. The production patch was
unchanged. The strict benchmark result, this initial failure, the fixture
repair, and final checks are retained in `independent-validation.json` and
`independent-cleanup.json`.

Raw v75 transcript SHA-256 values are
`1d08c12badcbec75c2ac024fa88b953939c6238cbad53e646ef227512ac1bec9` and
`cbe73213439b09b46da2b67acd0c3feb7b6556de3f8be2487287d17aa6e8c206`; the
manifest values are `e46239a93e6672f696b649c328de96fd580e8e915212eef084eabc603c297662`
and `002e8ec8709b7e4f58d9913b32cf8ff02963e3ba49d63e7833bfb68102e9405f`.
The hook-audit values are
`8712e7a470cf33826f41028430c1b0bc5d87ad5278c5604733cf516614629f34` and
`4e4cc4779aa2e76d93eab9d4fdd584a365a7f3c6a3a9184d6910e19095646f47`.
The temporary VS Code checkout and validation worktrees were then removed,
freeing 9,032,040,448 bytes. Regenerated Urdira targets, native closure and
package `dist` directories were removed separately; the exact 923,837,963-byte
cleanup is recorded in `cleanup-root-generated.json`.
