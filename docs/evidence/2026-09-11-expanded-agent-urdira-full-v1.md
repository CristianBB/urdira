# Expanded agent benchmark: refreshed Urdira arm

This record publishes the Urdira-only refresh requested after the comparator
campaign. It keeps the comparator executions frozen and derives a new
side-by-side table from their retained audits. Urdira ran on four repositories,
two tasks per repository, and three samples per task: 24 measured runs after an
8/8 smoke gate.

The result is 22/24 grader successes. Both failures are retained without retry.
All 24 cells reached current, complete structural readiness. Semantic indexing,
semantic materialization, and semantic-sidecar creation were disabled; semantic
bytes remained zero.

## Interpretation boundary

The new Urdira rows observe the agent's natural choice of configured tools. The
historical comparator rows used tool-assigned, prompt-directed protocols. The
numbers below answer the requested comparison, but they are descriptive rather
than a controlled estimate of the tool's causal effect. Readiness, MCP timing,
composition, Urdira host memory, and Urdira storage were not captured on the
historical comparator rows and are therefore reported only for Urdira.

For performance and usage, medians exclude failed rows and the success column
shows the retained denominator. No missing value is imputed. `Total` is setup
plus agent time. Cost is estimated from the report price card and is not a
provider invoice.

## Aggregate comparison

| Arm | Grader | Setup ms | Agent ms | Total ms | Tokens | Cost USD | Reads | Context chars | Peak RSS KiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline | 24/24 | 707 | 242,393 | 243,003 | 1,103,085 | 2.2978 | 12.5 | 127,297 | 291,032 |
| codebase-memory | 23/24 | 42,517 | 269,190 | 323,051 | 1,938,561 | 3.9362 | 36 | 290,227 | 7,031,840 |
| codegraph | 23/24 | 11,612 | 221,321 | 284,131 | 1,214,194 | 2.4985 | 11 | 163,489 | 2,918,192 |
| tgrep | 23/24 | 2,516 | 259,001 | 259,775 | 1,237,874 | 2.5786 | 16 | 58,955 | 310,704 |
| **Urdira refresh** | **22/24** | **7,517** | **245,552** | **265,627** | **1,378,482** | **2.8389** | **14** | **112,370** | **5,131,680** |

The following deltas use `(Urdira - comparator) / comparator`. Negative values
mean Urdira used less or finished sooner; positive values mean it used more or
finished later.

| Compared with | Setup | Agent | Total | Tokens | Cost | Reads | Context | Peak RSS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline | +963.9% | +1.3% | +9.3% | +25.0% | +23.5% | +12.0% | -11.7% | +1,663.3% |
| codebase-memory | -82.3% | -8.8% | -17.8% | -28.9% | -27.9% | -61.1% | -61.3% | -27.0% |
| codegraph | -35.3% | +10.9% | -6.5% | +13.5% | +13.6% | +27.3% | -31.3% | +75.9% |
| tgrep | +198.7% | -5.2% | +2.3% | +11.4% | +10.1% | -12.5% | +90.6% | +1,551.6% |

All arms requested three outer turns; their median is three. Median process
count/CPU was `9/2.6%` for baseline, `10/46.9%` for codebase-memory,
`14/24.9%` for codegraph, `10/3.5%` for tgrep, and `14/29.9%` for Urdira.

## Matched task comparison

Each cell is `grader; setup/agent/total ms; tokens; cost USD; reads; context
characters; peak RSS KiB`. These values are medians over successful samples.

| Task | baseline | codebase-memory | codegraph | tgrep | Urdira refresh |
|---|---|---|---|---|---|
| Playwright affected tests | 3/3; 831/201,111/201,278; 628,159; $1.3150; 15; 86,149; 258,608 | 2/3; 5,331/187,279/192,610; 1,378,697; $2.8218; 30; 166,023; 1,327,056 | 3/3; 10,203/205,510/215,459; 864,960; $1.7988; 12; 122,284; 2,559,920 | 2/3; 1,086/248,194/249,280; 1,089,350; $2.2684; 16; 29,899; 285,008 | **3/3; 5,856/204,620/210,493; 985,753; $2.0432; 16; 99,355; 3,926,064** |
| Playwright reporter isolation | 3/3; 204/267,721/267,925; 1,201,927; $2.5056; 11; 630,967; 310,176 | 3/3; 5,466/269,190/273,914; 1,731,180; $3.5539; 43; 171,511; 1,257,216 | 3/3; 10,760/217,863/228,397; 726,581; $1.5374; 9; 123,383; 2,525,888 | 3/3; 609/259,001/259,775; 1,038,725; $2.1919; 9; 17,868; 265,184 | **2/3; 5,857/258,522/264,379; 1,484,496; $3.0746; 12.5; 729,699; 3,312,480** |
| Prisma wire validation | 3/3; 403/201,785/201,898; 882,221; $1.8408; 10; 109,937; 287,744 | 3/3; 8,154/213,349/221,503; 1,454,280; $2.9860; 27; 239,490; 2,185,664 | 3/3; 10,988/196,313/207,660; 1,214,194; $2.4985; 7; 131,056; 2,857,856 | 3/3; 844/241,267/242,111; 1,078,133; $2.2528; 9; 20,731; 363,296 | **3/3; 5,806/237,718/243,033; 1,302,740; $2.6770; 11; 71,395; 5,429,760** |
| Prisma Mongo transform | 3/3; 739/164,314/165,064; 858,014; $1.7648; 12; 99,084; 278,688 | 3/3; 7,883/189,066/196,548; 1,465,084; $3.0002; 32; 188,262; 2,209,440 | 3/3; 11,505/168,474/180,086; 997,540; $2.0452; 11; 150,319; 2,902,448 | 3/3; 894/225,757/227,121; 1,204,650; $2.4756; 16; 66,257; 386,992 | **3/3; 5,621/181,607/187,144; 947,875; $1.9610; 9; 78,873; 5,419,904** |
| TypeScript transpile diagnostic | 3/3; 750/242,124/242,967; 1,299,610; $2.6789; 11; 105,169; 298,368 | 3/3; 42,625/317,760/360,277; 2,350,061; $4.7969; 54; 314,073; 9,989,552 | 3/3; 81,398/214,990/296,042; 1,299,633; $2.6664; 11; 191,025; 5,019,104 | 3/3; 5,004/268,730/273,544; 1,282,504; $2.6518; 19; 62,852; 290,112 | **2/3; 7,690/248,603/256,293; 1,419,537; $2.9215; 15; 117,421; 3,729,024** |
| TypeScript session hook | 3/3; 680/305,610/306,290; 1,588,548; $3.2777; 16; 162,183; 320,576 | 3/3; 42,767/396,178/441,990; 3,732,897; $7.5965; 46; 1,315,129; 8,057,008 | 3/3; 81,681/334,577/416,258; 3,193,125; $6.4959; 15; 293,911; 5,005,632 | 3/3; 5,289/349,535/354,824; 1,891,920; $3.9146; 23; 123,630; 303,920 | **3/3; 7,810/284,877/292,687; 2,039,046; $4.1685; 18; 112,586; 3,968,592** |
| VS Code registry notification | 3/3; 367/270,829/272,201; 1,547,403; $3.1971; 14; 182,414; 297,664 | 3/3; 78,404/425,231/503,635; 2,855,078; $5.8494; 36; 300,269; 7,146,960 | 3/3; 76,130/334,954/411,404; 1,893,638; $3.9139; 15; 217,990; 7,401,856 | 3/3; 2,749/386,946/390,520; 1,403,952; $2.9585; 10; 13,612; 5,018,320 | **3/3; 36,674/550,684/587,250; 2,608,178; $5.3467; 18; 1,258,854; 15,375,328** |
| VS Code provider registration | 3/3; 1,026/232,814/233,047; 1,193,155; $2.4753; 14; 167,517; 283,664 | 3/3; 75,043/262,273/337,316; 1,938,561; $3.9563; 46; 273,031; 9,038,928 | 2/3; 76,222/224,804/301,026; 1,131,777; $2.3376; 12.5; 205,610; 7,118,936 | 3/3; 3,158/243,555/246,967; 1,011,210; $2.1087; 16; 86,107; 282,192 | **3/3; 34,343/265,466/301,475; 1,355,825; $2.8081; 16; 140,041; 15,251,056** |

The strongest Urdira total-time results are against codebase-memory (-17.8%
aggregate) and codegraph (-6.5%). It is close to tgrep (+2.3%) and slower than
baseline (+9.3%). The VS Code registry task is the clear outlier: Urdira takes
587.3 seconds versus 272.2-503.6 seconds for the other arms. Urdira's process
tree memory is also substantially above baseline and tgrep, especially on VS
Code.

## Discovery, grading, and tests

These are campaign totals, including failed rows where their manifests exist.

| Arm | Evidence-grounded rows | Complete target coverage | Declared omissions | Repository reads | Context chars | MCP calls/failures | Tests A/P/F/? |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 24/24 | 24/24 | 0 | 317 | 5,769,685 | 0/0 | 4/2/2/0 |
| codebase-memory | 23/24 | 23/24 | 0 | 942 | 9,247,278 | 846/14 | 0/0/0/0 |
| codegraph | 23/24 | 24/24 | 0 | 293 | 4,221,688 | 169/0 | 4/2/2/0 |
| tgrep | 23/24 | 23/24 | 0 | 332 | 1,563,080 | 0/0 | 1/1/0/0 |
| **Urdira refresh** | **23/24** | **24/24** | **0** | **346** | **8,153,162** | **40/3** | **0/0/0/0** |

The grader and test command evidence are separate. Urdira changed the focused
test file and covered both declared targets in every row, but no Urdira run
executed a test command. The campaign therefore does not establish that those
patches pass repository tests.

## Urdira readiness, storage, and composition

Readiness ends when the current complete structural snapshot is queryable. The
table shows medians over all six runs for each repository because every setup
reached readiness.

| Repository | Readiness ms | Readiness RSS KiB | Catalog bytes | Lexical bytes | Structural bytes | CAS bytes | Semantic bytes |
|---|---:|---:|---:|---:|---:|---:|---:|
| Playwright | 4,939 | 240,544 | 20,528,788 | 105,992,428 | 601,609,901 | 29,173,337 | 0 |
| Prisma | 5,435 | 180,128 | 48,660,152 | 167,852,032 | 794,379,328 | 45,431,468 | 0 |
| TypeScript | 7,022 | 294,408 | 10,873,028 | 101,050,176 | 660,746,432 | 37,835,233 | 0 |
| VS Code | 35,607 | 192,200 | 112,928,428 | 658,345,984 | 4,602,681,584 | 222,653,536 | 0 |

Across 24 runs the agent made 40 MCP calls: 13 `urdira_context`, 12
`urdira_query`, and 15 `urdira_index_status`. Thirty-seven completed and three
failed. It issued 12 query calls: seven direct operations and five pipelines;
three pipelines were accepted, one pipeline was malformed, one structurally
valid pipeline failed at execution time, and no recipe was used. Tool choice
was observational: many rows correctly contain zero MCP calls.

The timing sidecars paired all 40 MCP calls, totaling 16,518.5 ms. They also
paired 448 command calls, totaling 101,655.3 ms; 404 completed and 44 failed.
Historical comparator sidecars do not expose equivalent timing, so no
cross-arm latency claim is made.

## Follow-up: pagination boundary and Urdira versus tgrep context

The 200,000-record limit observed in the failed Playwright pipeline is not a
page size or response limit. Query execution evaluates an operation before it
materializes the immutable result streams used by public pagination. The
failed request asked `core:resolve_symbol` for the simple name `Multiplexer`
with both `context_artifact` and workspace resolution. The current exact
`records_by_name` pushdown declines whenever `context_artifact` is present, so
execution reached the generic full-corpus fallback. That fallback rejected the
request before decoding all 612,496 visible records.

Raising the 200,000-record fuse would only permit a larger in-memory decode;
it would not make this request paginated. The appropriate optimization is an
exact indexed resolution path that supports `context_artifact`,
`kind_selector`, qualified names, and resolution scope. Public pagination can
then page the already bounded, ordered result manifest. The fuse should remain
as protection for query shapes that still cannot prove bounded execution.

The current report's `repository_context_characters` counts all observed
repository discovery responses, including Urdira/tgrep output and subsequent
shell reads. Re-rendering the retained tgrep transcripts with that same current
definition gives the following successful-sample medians:

| Task | Urdira grader | Urdira context chars | Urdira tokens | tgrep grader | tgrep context chars | tgrep tokens |
|---|---:|---:|---:|---:|---:|---:|
| Playwright affected tests | 3/3 | 99,355 | 985,753 | 2/3 | 29,899 | 1,089,350 |
| Playwright reporter isolation | 2/3 | 729,699 | 1,484,496 | 3/3 | 17,868 | 1,038,725 |
| Prisma wire validation | 3/3 | 71,395 | 1,302,740 | 3/3 | 20,731 | 1,078,133 |
| Prisma Mongo transform | 3/3 | 78,873 | 947,875 | 3/3 | 66,257 | 1,204,650 |
| TypeScript transpile diagnostic | 2/3 | 117,421 | 1,419,537 | 3/3 | 62,852 | 1,282,504 |
| TypeScript session hook | 3/3 | 112,586 | 2,039,046 | 3/3 | 123,630 | 1,891,920 |
| VS Code registry notification | 3/3 | 1,258,854 | 2,608,178 | 3/3 | 13,612 | 1,403,952 |
| VS Code provider registration | 3/3 | 140,041 | 1,355,825 | 3/3 | 86,107 | 1,011,210 |

Across all attempts, direct Urdira discovery responses contributed 110,946
characters over 25 calls; direct tgrep command output contributed 22,834
characters over 92 calls. Urdira therefore returned about 4.9 times as many
tool-output characters in total and about 17.9 times as many per configured
discovery call. The payloads serve different purposes: Urdira can return
structured relations and source snippets, while tgrep usually returns compact
locations or matching lines.

The larger campaign-level difference is mainly outside those direct tool
responses. Urdira rows recorded 8,153,162 repository-context characters in
total, versus 1,563,080 for tgrep. Approximately 8.04 million characters in
the Urdira transcripts came from shell discovery commands after or instead of
MCP use; direct Urdira payloads were only about 1.4% of the recorded discovery
context. Fourteen of 24 Urdira rows made no repository-reading MCP call at all,
whereas every tgrep row invoked tgrep.

This is evidence of an integration/adoption problem as well as a payload-size
problem. Urdira's direct responses are larger per call, but simply reducing
their page size cannot explain or remove the dominant shell context. The next
controlled campaign should use the same natural-selection protocol for both
arms and separately record tool-output characters, shell-output characters,
hydrated source characters, and target-attributed characters. The present
historical tgrep campaign was prompt-directed, so the success and context
figures remain descriptive rather than causal.

## Prioritized improvement backlog

The benchmark findings and the subsequent pushdown audit produce one combined
backlog. Each item needs an isolated measurement so indexing, response size,
and agent behavior are not conflated.

1. **Implement exact indexed symbol resolution.** Extend the native query
   surface beyond the current plain-name lookup so `core:resolve_symbol`
   remains indexed for `context_artifact`, `context_byte_offset`,
   `kind_selector`, qualified names, and every resolution scope. Reuse the
   same resolver for graph-operation selectors, `core:get_source`, and recipes
   that begin with symbol resolution. Acceptance requires exact parity with
   the reference evaluator and zero full-corpus fallback for these shapes.
2. **Reduce and measure snippets and hydration separately.** Record result
   metadata, source snippets, evidence, registry material, and hydration bytes
   as separate response components. Measure requested, produced, serialized,
   and model-visible characters. Tune defaults from those measurements while
   preserving explicit caller budgets and cursor completeness.
3. **Investigate agent adoption and shell fallback.** Determine why Luna made
   no repository-reading Urdira call in 14/24 rows and why it often returned
   to large shell reads after an MCP result. Measure discovery choice, first
   useful result, follow-up tool choice, duplicated source, target attribution,
   and shell bytes. Compare Urdira and tgrep under the same natural-selection
   protocol before attributing the behavior to either tool.
4. **Connect indexed streams directly to public pagination.** Let broad
   `core:find_records` and `core:search_text` executions build their immutable
   ordered manifests incrementally from indexed iterators. Crossing the
   current 5,000-record candidate boundary must issue cursors rather than
   abandon the index and decode the corpus.
5. **Complete lexical pushdown coverage.** Add indexed execution for
   `safe_regex` and structural filters including language, namespace, kind,
   and subject type. A large-workspace search must not change from source-text
   search to record-body scanning merely because one filter is present.
6. **Implement indexed comparison.** Evaluate `core:compare` as a deterministic
   merge over ordered participant streams, including the unselected full-scope
   form. Large comparisons must remain bounded without requiring a manually
   supplied `selection`.
7. **Audit every pre-pagination cap.** Review the search-text artifact/offset
   caps, the architecture-result cap, and impact/test traversal limits. Every
   exhaustive result must either continue through an immutable cursor or
   report explicit typed incompleteness; no internal cap may silently define
   the public result set.
8. **Remove full-corpus compatibility paths from production query execution.**
   Native v4 relation joins should always use subject-indexed relation pairs.
   Any unsupported selector or legacy adapter should fail with a typed,
   actionable error instead of building a corpus-wide JavaScript index.
9. **Expose pushdown telemetry.** Record the selected access path, index,
   candidate count, hydrated count, decline reason, fallback prevention, and
   page/materialization cost per operation. This is required to prove in the
   next campaign that an indexed repository is actually being queried through
   its indexes.

The 200,000-record safety fuse remains a last-resort guard. It is not a target
to raise and it is not the mechanism used to control response size.

## Implementation status of the nine improvements

This section records implementation evidence after the pushdown and measurement
work. It does not add a new benchmark result; the repository verification result
is recorded below. Structural cold indexing remains owned by the existing native
worker and readiness contract; the changes below are query, adapter, telemetry,
MCP presentation, and measurement capabilities. Structural readiness runs keep
`URDIRA_SEMANTIC_INDEX=0`, semantic materialization disabled, and no semantic
sidecar creation.

1. **Indexed symbol resolution.** `core:resolve_symbol` now uses indexed name,
   identity, qualified-name, context-artifact, byte-offset, kind-selector, and
   resolution-scope paths where the native snapshot exposes them. Cold/warm
   parity and unresolved-context tests are retained in
   `tests/phase-canonical-query-data-port.test.ts`.
2. **Response-component reduction and measurement.** The web MCP profile keeps
   the complete typed page in `structuredContent` and removes duplicated source
   snippets, source text, hydration, evidence, and registry payloads from its
   companion text block while retaining labels, completeness, and opaque cursors.
   The transcript harness measures tool-envelope, model-visible serialized,
   source-text, and record bytes from the real `content[].text` shape; hydration,
   evidence, and registry remain `null` unless a typed wire field exposes them.
3. **MCP adoption and shell fallback accounting.** Transcripts now report MCP
   before shell, shell after MCP, zero-MCP rows, method-specific output bytes,
   target-attributed bytes, and component classifications. This is measurement
   instrumentation; it does not claim to change an agent's tool choice.
4. **Indexed public pagination.** Selector and lexical lanes expose bounded
   pages and continuation cursors through lazy stream sources. `find_records`,
   `search_text`, and architecture streams retain immutable query pagination;
   the native selector path uses existing kind ranges and does not decode the
   visible corpus to form a page.
5. **Lexical pushdown coverage.** Literal search and structural filters use the
   lexical page capability when available, and unsupported requests fail with a
   typed capability error instead of silently switching to record-body search.
   `safe_regex` is deliberately documented as an exact artifact/CAS paged scan
   in the current native implementation: it is bounded and cursorable, but it
   is not yet a regex index. No stronger indexed-regex claim is made here.
6. **Indexed comparison.** `core:compare` performs an identity-key ordered
   merge over participant batches, retains only bounded working state, and
   rejects adapters without the declared ordering capability. The public
   `core:compare_workspaces` recipe maps to this stage without a second
   comparison count.
7. **Cap audit.** Selector, architecture, relation-closure, lexical legacy,
   and generic full-corpus safety bounds now report typed resource-limit or
   capability errors rather than presenting a truncated prefix as complete.
   Immutable page-capable lanes bypass the legacy non-paginated bounds.
8. **Compatibility-path removal.** Native relation predicates and joins use
   subject-indexed relation pairs or return an actionable capability error;
   they do not construct a corpus-wide JavaScript relation index. Identity and
   selector lookups likewise use native indexes where available.
9. **Pushdown telemetry.** Operation telemetry records route, selected index,
   candidates, hydrated rows, decline/fallback reasons, and page timing and
   serialized-byte metrics. The daemon preserves operation and page telemetry
   in its timing output for later publication.

Focused verification passed for the changed measurement and MCP surfaces: the
post-index measurement, transcript-metrics, expanded-report, MCP
response-separation, web-profile, and workspace-control test files passed their
targeted Vitest runs, with ESLint, MCP TypeScript checking, and `git diff
--check` also passing. `CI=true pnpm verify` subsequently passed end to end:
155 test files passed, 2,335 tests passed, 15 tests were skipped, and the
coverage gate and publication gate passed.

`pnpm package:release` remains limited on this host because the local
`darwin-x64` release closures are absent. This is a release-artifact
availability limitation, not a functional verification failure of the change.

## Post-improvement smoke diagnostic

The later single-arm smoke is retained at
`/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-11-post-improvements/smoke-urdira-v1`.
It covered all eight distinct tasks with seven successful graders and one
retained VS Code grader failure. The failed row reached structural
`current/ready` in 37.795 seconds with semantic index, materialization, and
sidecar creation all disabled. Its implementation evidence was complete: both
target files changed, the required pattern was present, and the focused test
file was added.

The grader failure was caused by the agent's first MCP call sending
`api_version`, `scope`, and `options` to `urdira_index_status`. The production
tool rejected that malformed request; the agent then sent a valid status call
and a successful `urdira_context` call. The grader marked `validation=true`
with no tool-call, coverage, or IPC error. This is an agent protocol error, not
a Urdira indexing, pagination, or readiness regression. The MCP production
description and server instructions now state the bootstrap contract
unambiguously: `{workspace_root:<repository root>}` with optional
`response_budget`, with query fields excluded.

The production MCP contract test covers the schema's rejection of
`api_version`, `scope`, and `options` as top-level index-status fields and the
published tool description/server instructions. The focused MCP suites pass
(35 tests), as does `pnpm typecheck`.

Because one of eight smoke rows failed validation, this 7/8 smoke does not
qualify or validate the full campaign. No rerun was performed.

## Retained failures

- `typescript/transpile-diagnostic-callback`, sample 1: the agent passed an
  invalid facet to `urdira_context`. The target coverage was complete and its
  two pipelines were valid, but the grader retained the tool-call validation
  failure.
- `playwright/reporter-error-isolation`, sample 3: the agent sent a malformed
  `urdira_context`, an invalid direct operation, and a pipeline whose unbounded
  `resolve_symbol` stage would decode 612,496 records, above the 200,000-record
  safety cap.

Both cell runners exited normally, both graders returned 1, and neither row was
retried. Their manifests, transcripts, host logs, and timing sidecars remain in
the raw campaign directory. The campaign gate is therefore false despite the
successful 8/8 smoke gate.

## Post-contract smoke v2

One fresh, single-sample Urdira-only smoke was run from HEAD
`41a4017514c320dbfc59da2aead779fca20b34a4` and retained at
`/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-11-post-improvements/smoke-urdira-v2`.
All eight distinct tasks reached structural `complete/current/ready`; semantic
indexing, semantic materialization, and sidecar creation were false for every
row. Five graders passed and three were retained as failures:
`typescript/transpile-diagnostic-callback`, `prisma/mongo-value-set-transform`,
and `vscode/language-registry-change-notification`.

The three failed transcripts share the same concrete protocol mistake: the
agent's first `urdira_index_status` call supplied `response_budget` as a number
(`4000`, `2000`, or `2000`) instead of an object. The schema correctly rejected
it with `data/response_budget must be object`; each transcript then contains a
valid object-shaped status call and reaches readiness. Target coverage and
focused-test evidence were complete, with no tool-call, coverage, or IPC error.
This is a caller protocol/grader validation failure, not a structural indexing
or semantic-off failure. No benchmark retry or competitor run was performed.

The production description and `MCP_SERVER_INSTRUCTIONS` now show the primary
bootstrap example without `response_budget`, a secondary object example with
only `max_items` and `max_characters`, and explicitly state that a numeric
`response_budget` is invalid. The schema remains authoritative with
`additionalProperties: false`. The v2 audit SHA-256 is
`908567b4fb37b99dcdb1a65e5679616967c852137ca851639a68a1d31d1782cd`.

## Post-index measurement v1

The post-improvement measurement is retained at
`/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-11-post-improvements/measurement-v1`.
It executed one Urdira sample for each of the eight directed tasks, with
semantic indexing/materialization/sidecar disabled and no competitor reruns.
The result was 7/8 successful rows. The retained
`prisma/mongo-value-set-transform` failure reached structural
`complete/current/ready`, but the agent sent a malformed `urdira_query`
continuation without the required nested `query` shape; the grader recorded a
tool-call and validation failure. `post-measurements.json` now propagates that
non-success state and grader exit code instead of leaving `failure` null.

The measurement audit SHA-256 is
`30657c5cfb6535e74d6cbbb3f7c818f3ab5d26054b8b647bc361c79916b45741`; the
post-measurements SHA-256 is
`b745666f4ab11d7c41df4500d49cb6af1cf3fc630b227f78e8e26b81b44fd7f8`.

## Reproducibility

- Urdira campaign ID: `expanded-typescript-agent-2026-09-11T00:30:59.441Z`.
- Urdira source: `91731b236ce04e85446c96d93b5ccad6e3590a62` with a clean tree.
- Model and runtime: `gpt-5.6-luna`, Node `v24.18.1`.
- Frozen repositories: TypeScript `b465fdbfe175304d9b977da137b2c178ae1091d3`,
  Playwright `1b44f5a441f391538c42c7ce36dd8ce779a5d6a1`, Prisma
  `0f37454eec96b193e8b20e8f569e453acd2af644`, and VS Code
  `038b9225c82c6b75172beda6081c64887692538c`.
- Runtime policy: one analysis worker, analysis pool maximum one, structural
  concurrency one, `URDIRA_SEMANTIC_INDEX=0`, structural readiness only.
- Indexing worker SHA-256:
  `7beed178ae600e71585d1003b235e52e846831c044f5e1066595c67dc46daa0a`.
- Urdira audit SHA-256:
  `8fba15303f434ff3b4a23917214485644556f14766047fe1ac93c532e0403b70`.
- Urdira report JSON SHA-256:
  `933f62ac8840fb0a95f652d1dd25e6013e971962bf4450a22f9fc65fb42512aa`.
- Urdira report Markdown SHA-256:
  `2ade4a1e9f3b885aa8cb86fb687509b727174d38d4b0dfb873e65c704fb74543`.
- Comparator S/M audit SHA-256:
  `fd7a0e98ac0c062e8f56492592338ef490d389966f3916a36a5fdb3796565ae7`.
- Comparator L audit SHA-256:
  `684c973e59e4f4adf8d99b62ddf92d078c6c77cf6ae37ae330c72a2b40d89945`.

The raw Urdira campaign is retained as
`luna-urdira-refresh-20260911/full-urdira-v1`; the qualifying smoke audit is
`luna-urdira-refresh-20260911/smoke-urdira-v2/audit.json`. The competitor audits
remain under `luna-campaign-20260910T0807/full-comparators-sm-v3` and
`full-comparators-l-v1`. See the
[campaign runbook](../benchmarks/expanded-agent-campaign.md) and the
[historical combined evidence](2026-09-10-expanded-agent-combined-comparators.md).

## Final post-improvement evidence from retained raw

This final section is calculated from retained raw only; it does not launch a
runner, query, competitor, or benchmark. The reproducibility inputs are the
measurement audit and post-measurements above, the historical Urdira report
`/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-09/luna-urdira-refresh-20260911/full-urdira-v1/report/urdira-full-v1.json`, and the comparator reports under
`/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-09/luna-campaign-20260910T0807/`.
The calculations were reproduced with `/tmp/recalc_final.js`, whose output
was retained at `/tmp/final_recalc_output.txt`; the intermediate per-task
comparison is `/tmp/compare3.json`. Missing values are kept as `null`.

### Smoke and measurement gates

Smoke v3 is the valid 8/8 structural smoke. Its retained audit is
`/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-11-post-improvements/smoke-urdira-v3/audit.json`, SHA-256
`d9e5e03ec6692fda41929e5fe08edb71ee8d268f113c4927b28a746ae2d67478`, from
HEAD `cc31b33b513213e268b01158d713a79d112ffa3c`. All eight rows passed, each
reported `complete/current/ready`, and semantic index, semantic materialization,
and sidecar were false. Readiness was TypeScript 7,027/7,006 ms, Playwright
4,950/4,936 ms, Prisma 5,431/5,445 ms, and VS Code 33,689/35,659 ms. Cleanup
reported zero processes and zero worktrees.

Measurement v1 is a separate single sample per task at
`/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-11-post-improvements/measurement-v1`:
7/8 successful, with the Prisma `mongo-value-set-transform` row retained as a
failure. Its audit SHA-256 is
`30657c5cfb6535e74d6cbbb3f7c818f3ab5d26054b8b647bc361c79916b45741`; the
post-measurements SHA-256 is
`b745666f4ab11d7c41df4500d49cb6af1cf3fc630b227f78e8e26b81b44fd7f8`. The
failure is the agent's malformed continuation payload; readiness still reached
structural `complete/current/ready`. The executor exited 1 to retain that
failure. No retry occurred. Host raw contains timing, semantic-perf, storage,
materialization/write/publish and byte telemetry, but no `operation_metrics` or
`page_metrics`; those metrics are therefore not reported.

### Current versus historical Urdira

The table uses milliseconds for setup, agent, total and readiness; RSS is KiB;
CPU is the captured mean percent; `reads` and `context` are repository reads and
returned context characters. “Previous” is the median across the three retained
historical samples for the same task. Tokens and cost are reconstructed below from raw `turn.completed.usage` records;
missing values remain `null`.

| repo/task | current success | setup / agent / total | previous total | delta total | reads / context | RSS / CPU / processes | readiness |
|---|---:|---:|---:|---:|---:|---:|---:|
| TypeScript transpile | 1 | 7,737 / 273,083 / 280,820 | 279,384 | +1,436 (+0.5%) | 14 / 94,296 | 4,176,880 / 40.6 / 11 | 7,071 |
| TypeScript session | 1 | 7,926 / 318,326 / 326,252 | 292,687 | +33,565 (+11.5%) | 15 / 136,754 | 4,084,704 / 56.5 / 16 | 7,005 |
| Playwright affected | 1 | 5,896 / 258,466 / 264,362 | 210,493 | +53,869 (+25.6%) | 13 / 90,843 | 3,788,720 / 11.1 / 12 | 4,952 |
| Playwright reporter | 1 | 5,189 / 273,882 / 279,071 | 258,389 | +20,682 (+8.0%) | 11 / 586,193 | 3,333,664 / 10.3 / 15 | 4,942 |
| Prisma wire | 1 | 6,158 / 205,590 / 211,748 | 243,033 | -31,285 (-12.9%) | 10 / 97,921 | 5,572,464 / 22.0 / 16 | 5,420 |
| Prisma mongo (failed) | 0 | 5,771 / 171,411 / 177,182 | 187,144 | -9,962 (-5.3%) | 9 / 62,097 | 5,782,080 / 28.9 / 8 | 4,939 |
| VS Code registry | 1 | 36,943 / 325,563 / 362,506 | 587,250 | -224,744 (-38.3%) | 18 / 175,340 | 15,668,944 / 62.0 / 17 | 35,578 |
| VS Code provider | 1 | 37,083 / 240,475 / 277,558 | 301,475 | -23,917 (-7.9%) | 25 / 279,776 | 15,415,136 / 78.2 / 16 | 35,640 |
| **median across rows** | **7/8** | **6,947.5 / 265,774.5 / 278,314.5** | **268,886.5** | **+9,428 (+3.5%)** | **13.5 / 117,337.5** | **4,874,672 / 34.7 / 15.5** | **6,212.5** |

The current aggregate versus historical median is: setup +149 ms (+2.2%),
agent +6,731 ms (+2.6%), total +9,428 ms (+3.5%), reads -2.5 (-15.6%), context
+9,615 (+8.9%), RSS +180,424 KiB (+3.8%), CPU +3.8 points (+12.3%), processes
+1.5 (+10.7%), and readiness -24 ms (-0.4%). Current token/cost medians are `1,451,522.5` / `$2.960645`; historical
medians are `1,357,931.5` / `$2.809460`, a delta of `+93,591` (+6.9%) and
`+$0.151185` (+5.4%). Current component medians are `tool_envelope=2,181`,
`model_visible_serialized=12,385.5`, `source_text=6,961.5`, and
`records=1,071.5`; hydration, evidence and registry remain `null`, as do the
historical component bytes. Current adoption is 14 MCP calls, 101 shell calls, and two
rows with zero MCP calls; historical MCP fields are not schema-equivalent to the
corrected transcript extraction and are not treated as a direct byte comparison.

### Tier comparison with frozen competitors

Current tier medians (S=Playwright, M=Prisma, L=TypeScript/VS Code) are shown
against the frozen comparator report medians. Comparator runs were not rerun.
The comparator report has no equivalent per-query component bytes, RSS/CPU/process
values in its published groups, or current Urdira component fields, so those
columns are `null`; total is setup plus agent. Values are
`setup/agent/total ms; tokens; cost USD; reads/context chars`.

| tier | current Urdira | baseline | codebase-memory | codegraph | tgrep |
|---|---|---|---|---|---|
| S (Playwright) | 2/2; 5,542.5 / 266,174 / 271,716.5 ms; 1,434,525 tokens; $2.938422 | 6/6; 403 / 201,111 / 201,514 ms; 858,014; $1.764802 | 5/6; 5,466 / 189,066 / 194,532 ms; 1,454,280; $2.985966 | 6/6; 10,760 / 196,313 / 207,073 ms; 864,960; $1.798770 | 5/6; 844 / 241,267 / 242,111 ms; 1,073,352; $2.241180 |
| M (Prisma) | 1/2; 5,964.5 / 188,500.5 / 194,465 ms; 1,272,912.5 tokens; $2.592109 | 6/6; 403 / 164,314 / 164,717 ms; 858,014; $1.764802 | 6/6; 7,883 / 189,066 / 196,949 ms; 1,454,280; $2.985966 | 6/6; 10,988 / 168,474 / 179,462 ms; 997,540; $2.045240 | 6/6; 844 / 225,757 / 226,601 ms; 1,078,133; $2.252758 |
| L (TypeScript + VS Code) | 4/4; 22,434.5 / 295,704.5 / 303,536 ms; 1,861,772.5 tokens; $3.801818 | 12/12; 680 / 242,124 / 242,804 ms; 1,299,610; $2.678930 | 12/12; 42,767 / 317,760 / 360,527 ms; 2,350,061; $4.796914 | 11/12; 76,472 / 241,448 / 317,920 ms; 1,430,741; $2.945608 | 12/12; 3,158 / 268,730 / 271,888 ms; 1,282,504; $2.651798 |

These are medians of the available task groups, not matched per-row causal
comparisons. Success, missing rows, host resource telemetry, and differing
setup/indexing contracts must be retained when using them; no competitor result
is silently imputed.

### Cold readiness and query micro evidence

Smoke v3 readiness is the fresh structural-only gate above. The fresh
measurement-v1 values were TypeScript 7,071/7,005, Playwright 4,952/4,942,
Prisma 5,420/4,939, and VS Code 35,578/35,640 ms. The older baseline `setup: none, indexed: false` rows are not used for this
readiness comparison. The directed structural baseline uses the equivalent
boundary: Playwright 6,706 ms, TypeScript 22,809 ms, Prisma 49,197 ms, and
VS Code 820,366 ms. Against smoke-v3 medians, deltas are respectively -1,763
ms (-26.3%), -15,802 ms (-69.3%), -43,758 ms (-89.0%), and -785,692 ms
(-95.8%).

Retained query-micro raw confirms semantic index/materialization off. The
Playwright `query-micro-v3/playwright-final` rows were
`find-records page 1=3,324 ms`, page 2=5 ms, literal page 1=797 ms, and
safe-regex page 1=695 ms. TypeScript `query-micro-v3/typescript` measured
resolve context/qualified/kind = 248/10/9 ms, find-records pages 1/2 =
2,952/4 ms, literal/safe-regex = 545/520 ms, and the boundedness test
`wide-continuation-error=15,559 ms`. Prisma and VS Code are in
`query-micro-v2`: Prisma resolve=280/10/9 ms, page 1=2,823 ms,
literal/safe-regex=2,026/1,898 ms, wide continuation=18,658 ms; VS Code
resolve=4,106/52/42 ms, page 1=2,220 ms, literal/safe-regex=13,426/9,626 ms,
wide continuation=19,419 ms. The micro v2 TypeScript row failed checkout
materialization and is retained as a failure, not as zero data. The large
selector page 1 and wide-continuation paths remain expensive.

The corrected safe-regex gate is evidenced by the bounded raw rows and their
responses; these rows only demonstrate measured cost and empty responses and did not exercise the 200,000-record cap.
`safe_regex` final routing is
`artifact_cas_paged/artifact_versions_keyset`; the measured rows demonstrate
latency and empty responses only. No operation-level
telemetry is fabricated where the raw host logs contain none. Competitor reports
have no equivalent per-query micro rows, so that comparison is unavailable.

The historical Urdira comparison and this section preserve the 7/8 measurement
failure, the 8/8 smoke gate, semantic-off invariants, raw hashes, and the fact
that competitors were not rerun. `CI=true pnpm verify` remains OK (155 files,
2,335 passed, 15 skipped, coverage and publication gates); local
`pnpm package:release` remains limited only by missing darwin-x64 closures.
