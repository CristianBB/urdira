# Agent context information preservation

## Scope

This change targets source hydration, exact indexed context neighborhoods,
MCP information preservation and transcript accounting. It does not change
structural indexing or enable semantic materialization.

Authorities: Decisions 01, 03 and 19, the public query and MCP adapter
contracts, the core taxonomy, and architecture/manifest.json.

## Reproduced evidence

Offline replay reproduced v13: 14 reads, 150,953 repository characters,
17,111 MCP characters and 133,842 shell characters. V14: 30 reads,
1,188,774 repository characters, 61,375 MCP characters and 1,127,399 shell
characters. No attempt was rerun or replaced.

The derived replay at
`/Users/Cristian/BenchmarkResults/urdira-context-replay-20260912-v2.json`
retains 98 transcript entries including historical comparator artifacts,
missing manifests and failed outcomes. It records raw hashes. Tgrep output
is included in shell transport and counted once in the repository total.

## Implementation

- Context source requests live in internal immutable manifests and hydrate
  per page from exact artifact versions with client-normalized source options.
- Explicit seed resolution uses the indexed selector path and fails visibly
  when unresolved; requested structural neighborhoods retain relation proof.
- Source sharing is page-local and requires an exact owned range. All source
  snippets, selected stream summaries, backward/forward continuations and
  diagnostics and snapshot/coverage metadata remain available. MCP no longer discards query bundles after
  the engine has generated a cursor.
- Agent guidance consumes continuations when needed and reuses supplied data.
- Literal duplicate-output and continuation observations are separate from
  subjective utility measures, which remain null without evidence.

## Validation status

Initial regressions failed for dropped summary streams, missing empty-page
diagnostics, duplicate/lost snippets, tgrep transport attribution, unresolved
seeds and eager source hydration. Focused suites and final gates are recorded
below after execution. The fresh three-repository validation remains gated on verification and release acceptance.

## Capability boundary

Structural context facets describe the direct neighborhoods specified in the
public contract. Semantic analogues use the semantic retrieval surface and
are rejected by the structural context path. Source projection may explicitly
truncate according to the caller's budget; it is never represented as complete
source. An oversized final query envelope fails with recovery instructions
instead of silently dropping content.

### Gate execution notes

- `CI=true pnpm verify`: architecture, native build/check/tests passed; lint
  found the missing Node URL import in the replay CLI. The import was fixed.
- The first coverage stage was invalidated by an overlapping focused Vitest
  run: global setup removes shared `urdira-*` temporary fixtures. It was
  interrupted and its failures are not treated as product evidence. All
  subsequent Vitest stages run without overlapping invocations.
- Focused engine and transcript suites: 175 tests passed before the final
  metadata-preservation regression.

- Clean coverage run: 154 test files passed, two failed (three tests),
  2,380 tests passed. All three failures exposed missing source readers in the
  shared legacy task-planner fixture; the fixture now supplies exact versioned
  text, and source assertions check the returned declaration. The four
  affected/focused suites then passed: 88 tests. Final coverage is rerun.

- Final coverage: 156 files passed, two skipped; 2,383 tests passed, 15
  skipped. Lines: 90.28% (30,060/33,295). Critical branches: 100% (15/15);
  semantic critical regions: 100%. Typecheck, lint, architecture, publication
  hygiene and diff whitespace checks passed. The metrics declaration file
  was extended to expose the new analyzer after typecheck caught the missing
  export; no runtime behavior changed in that correction.

## Release and installed integration

`CI=true URDIRA_RELEASE_TARGET=darwin-arm64 pnpm package:release` passed.
`CI=true URDIRA_RELEASE_TARGET=darwin-arm64 pnpm release:acceptance` passed
all gates (install, unit, contract, integration, e2e, crash, corruption,
security, watcher, benchmark, package inspection). Report digest:
`sha256:9f37fb188c767470c45b742e67ee06d8ff5f2ec86e693d350803d5a0455b65c8`.
This validates the host platform only.

Fresh evidence root:
`/Users/Cristian/BenchmarkResults/urdira-context-integration-20260912`.
The root retains the exact base commit, implementation patch and its digest,
untracked implementation files, release report, worker digest, frozen task
commits, raw transcripts, host/timing logs, and edited worktrees. No new
implementation commit was created; base commit alone does not identify the
modified build. The worker is the release artifact at
`release/native/darwin-arm64/urdira-indexing-worker`, SHA-256
`00648c73672f507c45f306bb88d2b3cf4bdc29d8c364483e9204d85313e1e567`.

The three samples are sequential, Luna, Urdira only, structural readiness,
semantic indexing/materialization/sidecar disabled, one attempt per task.
No sample failure is retried or replaced. The samples are integration
observations, not statistically representative efficiency estimates.

### Fresh sample results

| Repository | Target-path coverage | Grader | MCP discovery characters | Shell discovery characters | Repository discovery total | Unique typed record ratio |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Playwright | 2/2 | failed | 36,676 | 58,208 | 94,884 | 1.0 |
| Prisma | 2/2 | failed | 3,662 | 66,166 | 69,828 | null |
| VS Code | 2/2 | failed | 46,692 | 368,988 | 415,680 | 1.0 |

These discovery totals deliberately exclude status and verification output.
The derived `annotated-observations.json` also counts all observed MCP text
(including status) and shell output (including verification), once per
completed event. Their sums are 108,135 / 78,150 / 425,518 characters for
Playwright / Prisma / VS Code. These are observed tool-output totals, not
claims about hidden model context or total inference tokens.

Every run changed the required implementation/test paths and retained its
patch. None passed the frozen integration grader: tool/validation errors and
shell fallback were observed. A changed test file is not an executed test;
no successful focused test execution was established in the frozen tasks.
Playwright lacked installed test dependencies. Prisma reported an incompatible
shell Node version and missing dependencies. The root Urdira verification
above is independent of those task environments.

- Playwright: the first context page placed the edited implementation first
  and the edited runner caller fourth. At transcript event 15, the agent
  explicitly acknowledged Urdira's dependency-flow information; it then
  sought test context by shell. A continuation sent to `urdira_context` was
  rejected; the same literal reference succeeded through `urdira_query`.
- Prisma: empty initial context and oversized rendered pages did not provide
  the needed source. Four `core:snippet_budget_impossible` responses and
  malformed recovery requests were retained. Increasing a page budget can
  admit more engine rows while the rendered envelope still exceeds it. This
  needs a shared engine/presentation page-cost strategy; the explicit error
  preserves information but does not meet the first-response usability goal.
  The agent's claim that symbols were absent is not proof of index absence.
- VS Code: the implementation was first in context, and a subsequent direct
  `get_source` returned its body. A context-tool continuation was initially
  misrouted, then recovered through `urdira_query`. Shell reads still followed.
  Structural waits between turns were 256,413 ms and 25,596 ms; do not attribute
  that time to MCP rendering or semantic embedding work.

Observed distinct continuation references offered/consumed were 2/1, 0/0,
and 3/1. Offers include backward navigation; an unconsumed offer is not proof
of missing required coverage. The agent can issue a focused source query
instead of consuming the remaining broad page.

A separate exact-line comparison found 2,649 / 0 / 7,184 characters in shell
output matching earlier MCP snippet lines (trimmed, minimum 20 characters
per line). This includes diff/review output and is not a measurement of
avoidable reads. `shell_source_overlap` retains the exact command and event
index for assessment. The automated whole-output equality metric is narrower
and must not be interpreted as absence of repeated source. Subjective
relevance, hydration use and contribution ratios remain null unless explicitly
annotated from transcript evidence; absence of citations is not evidence of
non-use. Edited-artifact positions are resolved against each recorded worktree
in the derived report; unobserved test-file positions remain null.

### Acceptance conclusion

Functional and release gates pass, including exact source preservation and
pagination regressions. **The agent-integration objective is not accepted:**
0/3 frozen samples passed the grader and shell fallback remains. Do not claim
a general efficiency improvement or that agents can now reliably complete
these tasks using Urdira alone. No benchmark-specific product workaround,
competitor rerun, semantic lane, or failed-sample retry was introduced. The
measured product implementation was kept fixed across all three samples.

The retained failures identify the next hypotheses: align page costing with
agent rendering; make continuation tool routing unambiguous; and improve
focused discovery/recovery of test context before shell fallback. They are
not silently counted as completed capabilities in this evidence.
