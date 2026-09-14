# Agent context recovery after retained integration failures

Date: 2026-09-12. This records repairs after the three retained integration
samples, not replacement benchmark results. The original evidence is
[information preservation](2026-09-12-agent-context-information-preservation.md).

## Repairs

- Actual MCP envelope size is fitted by reading a smaller prefix of the same
  signed execution. Private page bounds never change public budget bindings,
  source projection, snapshot or persisted ordering. Zero-row stream summaries
  keep their original continuation. An oversized individual projection remains
  an explicit error with a stable minimum and correctly located recovery options.
- The context tools accept the existing closed continuation request, including
  validation through the MCP SDK. Mixed initial/continuation requests are rejected.
  Backward-only links retain their direction. Diagnostics and selected registry
  metadata persist with new manifests; older manifest arrays remain readable.
- Unresolved structural task seeds fail with `core:selector_unresolvable` and
  exact-symbol/path or literal-search recovery guidance. This no longer implies
  absence of indexed source. Tests covering callers are retained even when tests
  also cover the seed directly; both retain relation evidence.
- Production guidance permits work from sufficient delivered context and uses
  continuations as needed. Directory glob guidance distinguishes final-component
  matching from descendant matching.
- Offline replay reconciles paths using explicit workspace scope and distinguishes
  failed continuation attempts. Exact source-line overlap is recorded without
  claiming semantic use or waste. Original transcripts are never rewritten.
- Benchmark validation prerequisites now check the agent's login-shell runtime
  and declared dependency availability before model invocation. Failure evidence
  is retained; no installation or benchmark retry is performed.

## Authority and ownership

Decisions 01, 03 and 19, the public-query and MCP adapter contracts, README and
runbook accompany the engine, daemon, MCP, CLI and measurement changes. Public
closed fields remain unchanged; page fitting uses private execution fields.
No new indexing engine or repository-specific query logic was introduced.

## Verification

Focused regressions first reproduced page overflow, backward navigation mistaken
for forward continuation, SDK routing, unresolved discovery, missing indirect
tests and metric attribution. The focused suite passed 262 tests before the final
JSON-envelope and private-boundary cases were added (those seven page tests pass).
Full verification and release acceptance results are recorded below when complete.

The prior Playwright, Prisma and VS Code samples remain failures and were not
rerun. These repairs do not establish a statistical efficiency improvement or
prove that structural relations discover tests reached only through dynamic data.

## Offline observations after instrumentation repair

New derived artifacts under
`/Users/Cristian/BenchmarkResults/urdira-context-integration-20260912/`:
`repair-replay-v2.json` and `repair-validation-environments.json`.
Historical replay: `/Users/Cristian/BenchmarkResults/urdira-context-replay-20260912-repair.json`
retains all 98 records, including v14 failures, with original transcript hashes.
The three transcript SHA-256 values remain:

- Playwright: `22d5fee0f0a4ac7cce788667f4895d48c5fb8720dcb042be1057357d91b02701`
- Prisma: `b66996b0c5641b9c8732551daddc4198eb25bac5feba6a5d40e84402e23176b5`
- VS Code: `6bcecbf61ee67d47104a3a8859f8dd1217c721fd5f963b5a971c9adf0055db6a`

Replay identifies the edited implementation at typed-context position 1 for
Playwright and VS Code, and Playwright's caller at position 4. The test files and
Prisma paths remain unobserved in typed context; these values are `null`.
Source-line overlap in later shell source reads is 1,565 characters for
Playwright and 7,281 for VS Code; Prisma is `null` because no typed source was
observed. These are exact-line observations, not attributable wasted context.

Read-only validation-environment inspection reports login-shell Node `v11.0.0`
for all three worktrees, with 110/31/174 missing declared dependencies respectively.
All fail the new prerequisites gate. No agent, host, indexing run or dependency
installation was launched by this inspection.

## Verification findings retained during repair

The initial `CI=true pnpm verify` passed architecture, native builds, formatting,
Clippy, Rust suites and lint. Coverage ran 2,398 active tests: 2,397 passed and one
assertion still expected the previous guidance wording. The corrected assertion
also requires that sufficient delivered context permits work to begin. Native
sources were unchanged; the remaining verification stages are rerun separately.

Archive smoke reproduced another stale check: it rejected the required
`urdira-indexing-worker` because its expected closure listed only the addon and
syntax worker. The smoke check and release inspection now require the indexing
worker too, as already mandated by Decision 10. A deterministic archive regression
first failed and then passed; the 52-test focused follow-up passed.

The extracted pre-repair archive also reproduces the budget bug through the MCP
SDK: a 40-record fixture returns `core:snippet_budget_impossible` at a 4,000-character
budget, requesting 5,089 characters. The retained `verify-installed-context.mjs`
checks the repaired archive with the identical fixture and launcher runtime.
This probe uses installed engine/MCP modules, not native indexing or an agent.

## Completed repository verification

- `CI=true pnpm verify`: native/architecture/lint stages passed; the first coverage
  run retained the stale guidance assertion described above.
- `pnpm check:architecture && pnpm lint && CI=true pnpm test:coverage`:
  passed; 158 test files passed, two skipped; 2,399 tests passed, 15 skipped.
- Typecheck then identified a missing declaration for the archive-smoke helper
  imported by its new regression; `scripts/smoke-native-archive.d.mts` supplies it.
- `pnpm typecheck && pnpm lint && pnpm check:architecture && pnpm check:coverage-gate && pnpm check:publication`:
  passed after that declaration was added. Measured lines: 90.31% (30,184/33,422);
  critical branches: 100% (15/15); semantic coverage regions: 100%. No runtime code
  changed after the successful coverage run.

Together these complete every `verify` stage. Native tests were not rerun after
changes confined to assertions, packaging verification and declarations.

## Packaged-module probe

`CI=true URDIRA_RELEASE_TARGET=darwin-arm64 pnpm package:release` passed.
`CI=true pnpm smoke:native-archive release/artifacts/urdira-darwin-arm64-0.3.3.tar.gz`
passed with the complete four-file native closure and system Node hidden.

The same extracted-package SDK fixture that failed before repair now returns all
40 distinct records, with complete fixture source, in 14 pages. Largest text page:
3,815 characters for the explicit 4,000-character fixture budget. The query was
executed exactly once; subsequent pages used `urdira_context` continuations.
These fixture values are assertions, not product or benchmark success thresholds.
The packaged launcher reports version `0.3.3` without Node in `PATH`.
Result: `repair-installed-context.json` beside the original sample artifacts.

The packaged indexing worker remains SHA-256
`00648c73672f507c45f306bb88d2b3cf4bdc29d8c364483e9204d85313e1e567`.
The tested archive SHA-256 is
`0b48ade7e531d5a0426ffde7dc3d7b676b442f40dc2a769e1209df0ada0d4a5a`.

## Release acceptance and handoff

`CI=true URDIRA_RELEASE_TARGET=darwin-arm64 pnpm release:acceptance` passed all
11 checks: install, unit, contract, integration, e2e, crash, corruption, security,
watcher, benchmark fixture, and package inspection. This release-suite benchmark
is its deterministic conformance fixture; it is not a repeated agent sample.
Report: `release/reports/phase-14-release.json`, digest
`sha256:2e9717c1a607781dbfa83b8dc2c350c58c76f412f183cf040f2f1b9df87f3c53`.
The archive rebuilt by acceptance has the same SHA-256 as the extracted-package
probe above, so that probe applies to the final archive too.

Source base remains commit `c00e0eac4394222d925a15811338ad3a3876abf9` on `main`.
The repair is uncommitted; exact tracked patch, untracked source copies, logs,
release report and hashes are retained in `repair-attestation.json` and its
referenced artifacts beside the retained samples. No original sample was rerun,
regraded as a success, or overwritten. Dynamic test relationships and validation
prerequisites remain explicit limits, not implied complete coverage.
