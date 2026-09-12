# Agent context completeness evidence

## Scope and raw evidence

This note records a read-only forensic review of the focused schema-gate pass. No benchmark was rerun and no new benchmark result is asserted here.

The raw directory is:

`/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-11-post-improvements/agent-integration-schema-gate-v2/`

The VS Code run is the single file set named `vscode-language-registry-change-notification-urdira-typescript-1`. The pass used commit `038b9225c82c6b75172beda6081c64887692538c`, structural readiness, and semantic index/materialization/sidecar disabled. The run reported `structural_completeness=complete`, `freshness_status=current`, and `workspace_status=ready`.

Recorded SHA-256 values:

| Artifact | SHA-256 |
|---|---|
| `audit.json` | `7e6e7531f7bd787ceb4aebf54ff41de5e9b14d0cdefe201466da96c95d15998a` |
| `post-measurements.json` | `27654f3fc738a21ea89eeedc953fd3ca7f139052d5d1116b95f2e3894a9e0ce3` |
| VS Code manifest JSON | `63e8d3d0600500bd6d792c3892bd824a5fb07e0e62bc8d5ce6163846cf34a7b1` |
| VS Code transcript JSONL | `1340d01d35ad034ef5856d0ae6440cea5dfe8299602a8f9b7b2753f0c9942fde` |
| VS Code host log | `a80e13d410b93edfd6a467bebe9b36e7f3583eef50373b2854a3dc32909dd1c6` |
| VS Code timing JSON | `ae2ade152ff62f21f9ef787c186231126227c6946d8f149277fe48d086d24c7f` |

## Character attribution

For the VS Code run, the actual response attribution in the manifest is:

- MCP/tool output: **12,901 characters**.
- Shell output: **2,565,496 characters**.
- Total target-attributed output: **2,565,013 characters**; 13,384 characters remained unattributed.
- Two shell `rg` outputs contributed **1,048,606 characters each**.

The MCP total is the model-visible serialized response count, not a claim that every byte was source text. The same record classifies 9,315 characters as source text and 3,268 as record/header material; hydration, evidence, and registry components were unavailable for this response. The shell total is therefore the dominant context source and must not be reported as Urdira response size.

## Forensic causes and completeness risks

The original integration issue was a mismatch between the broad `core:build_context` request and the implementation semantics. The operation accepts the closed facet set, but the implementation historically expanded only already-resolved seeds and did not expand every requested facet. The `tests` facet was therefore effectively ignored as a requested relation in the affected path. A result could still be rendered as complete for the returned records even though that did not prove that every requested facet had been fulfilled.

The readiness language also allowed an agent to treat `complete`, `more=no`, and `source_ready` as interchangeable. They are different signals: page coverage, query-scope completeness, and source availability. Ambiguous `complete`/`more`/`source_ready` signals can cause either premature stopping or defensive shell discovery.

`core:get_source` remains sensitive to mixed or missing selectors. A response can contain returned subjects while a requested selector is unresolved or omitted; without a per-subject status, the agent cannot distinguish `returned`, `not_found`, and `omitted/truncated`. That status distinction would require a versioned contract extension and is not implemented in this evidence update.

The resulting VS Code transcript shows the practical effect: a small MCP response was followed by very large shell discovery output. The two 1,048,606-character `rg` outputs are duplicate or overlapping discovery pressure relative to the declared target paths, although shell use for edits, tests, and repository state remains legitimate. This note does not claim that every shell character was unnecessary.

## Changes represented in the current diff

The current shared diff contains these related production and test changes:

- `packages/engine/src/canonical-query-data-port.ts` adds bounded indexed `tests` expansion through `core:contains`/`core:covers`, preserving scope and avoiding a corpus scan.
- `packages/mcp/src/index.ts` renders freshness and coverage explicitly, reports page counts and `more`, and emits complete continuation requests with the original scope and cursor.
- `docs/protocol/public-query-contract.md` and `docs/protocol/mcp-adapter-contract.md` clarify structural readiness, coverage, freshness, and the indexed tests pushdown.
- `tests/phase-canonical-query-data-port.test.ts` and `tests/mcp-response-deduplication.test.ts` cover the focused pushdown and response behavior.

These changes improve the signals available to the agent, but they do not implement per-facet expansion for all eleven accepted facets.

## Remaining limitations

Other facets still lack explicit expansion inside `core:build_context`. In particular, definitions, implementations, callers, callees, dependencies, contracts, effects, configuration, analogues, and extension points must be obtained through their dedicated indexed operations or approved recipes. `analogues` also requires a semantic lane; it cannot be inferred honestly with semantic indexing disabled.

Per-subject `core:get_source` status (`returned` versus `not_found` versus `omitted/truncated`) requires a versioned contract and is not implemented. No claim of full facet completeness should be made from a generic `complete` bundle status alone.

**Targeted validation pending.**

## Four validation passes

These are four existing, single-sample VS Code validations. They are retained
as evidence about the integration path and agent behavior, not as a campaign
or causal estimate.

| Pass | Success / grader | Structural readiness | Setup | Agent | Total / elapsed | MCP / shell | Reads | Context chars | Tokens / cost |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| single | yes / 0 | 39,682 ms | 39,956 ms | 278,550 ms | 318,506 ms | 0 / 12 | 12 | 1,193,344 | null / null |
| frontloaded-v3 | no / 1 | 37,574 ms | 38,754 ms | 416,019 ms | 454,773 ms | 3 / 15 | 18 | 1,207,605 | 2,630,779 / $5.350682 |
| batched-v4 | yes / 0 | 37,636 ms | 38,213 ms | n/a | 524,190 ms elapsed | 4 / 17 | 12 | 1,166,187 | 2,577,608 / $5.23882 |
| ranked-v5 | yes / 0 | 43,786 ms | 44,004 ms | n/a | 533,453 ms elapsed | 0 / 18 | 14 | 206,020 | 1,311,827 / $2.70180 |

All four runs used the Urdira TypeScript arm with structural readiness and
semantic index, materialization, and sidecar disabled. The batched raw timing
records `urdira_context` at **4,452.401791572571 ms** (`p95_duration_ms` has the
same value), replacing the frontloaded 90,007.15 ms context timeout. The
first-page result was still poorly useful when ordering was unchanged; the
ranked implementation moves definitions and tests ahead of lower-priority
resolved records without increasing hydration or response budget.

Tool selection is stochastic across these agent runs: the single and ranked
passes used zero MCP calls, frontloaded used three, and batched used four.
Therefore these rows show adoption variance as well as implementation
behavior. The runner also exposed a fidelity limitation: a grader-successful
cell can still report a focused test blocked by missing `node_modules`/`out`
and an unavailable Mocha runtime. Grader success must therefore be read with
the raw transcript and cleanup evidence, not as proof that the agent's local
verification ran.

## Implemented integration improvements

The final working tree includes the bounded indexed `tests` facet through the
contains/covers projection, a shared batched relation frontier, deterministic
context salience ordering, explicit result metadata and complete continuation
pagination envelopes, and a discovery-first MCP catalog with generic titles
and descriptions. The harness now accepts valid installed-integration Codex
artifacts and preserves the runner's raw output and cleanup evidence. These
changes are contract-driven and repository-generic; they do not require a
pipeline, semantic retrieval, or benchmark-specific route.

The Codex artifacts used by the four passes are valid retained manifest,
transcript, host-log, timing, audit, and post-measurement outputs under the
raw directories named above and in each pass's `post-measurements.md`.

## Installed-integration validation sequence

Three subsequent single-sample validation directories are retained under
`/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-11-post-improvements/`.
They are evidence about setup and tool selection, not a campaign or a causal
estimate.

| Pass | Runtime/setup result | Agent | MCP / shell | Reads | Context chars | Tokens / cost |
|---|---|---:|---:|---:|---:|---:|
| v6 | global 0.3.2, unprepared | ran | 0 / 0 | 0 | 0 | 1,671,319 / $3.41204 |
| v7 | 0.3.3 preflight failed before host/Codex startup | none | n/a | n/a | n/a | n/a |
| v8 | 0.3.3, socket endpoint available | ran | 0 / 18 | 13 | 157,171 | 1,249,685 / $2.574826 |

### v6: unprepared global runtime

The v6 raw evidence is retained at
`/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-11-post-improvements/agent-installed-integration-v6/`.
The runtime was the global 0.3.2 installation. Its transcript contained six
hook-trust/integration errors, nine completed `web_search` actions, and nine
completed `file_change` actions, with no MCP or shell actions. The agent
reported the discovery runtime as unavailable and chose web search and editing
actions. This explains the zero repository-read/context metrics under the
existing definitions.

### v7: preflight stopped before the agent

The v7 raw evidence is retained at
`/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-11-post-improvements/agent-installed-integration-v7/`.
The isolated 0.3.3 shim validated `daemon.sock` during `--version`, before the
runner started the daemon. It failed with `isolated urdira --version failed:
urdira benchmark daemon endpoint is unavailable`. The attempt ended before
host or Codex startup, so no agent, MCP, shell, web, file, readiness, token,
cost, or grader metric exists. The failure was retained and not retried.

### v8: socket-correct runtime with shell fallback

The v8 raw evidence is retained at
`/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-11-post-improvements/agent-installed-integration-v8/`.
The 0.3.3 shim and cell endpoint were available. Structural readiness was
41,712 ms and setup was 42,707 ms; the host duration was 330,916 ms, with peak
RSS 323,552 KiB and mean CPU 19.6050%. Semantic indexing, materialization, and
sidecar creation were disabled. The run completed with grader/runner `0/0`.
It used zero MCP calls, 18 shell commands, 13 repository reads, and 157,171
shell/context characters. The transcript recorded six hook warning/error
items, seven file changes, and no web searches. No `urdira_context` response,
MCP pagination, or MCP context coverage was observed.

The shell commands were emitted as compound `/bin/zsh -lc` invocations. The
conservative source-read hook classifies the command text as a fallback when a
compound invocation contains repository inspection, even when the command
also performs setup or validation. This preserves the safety boundary but can
make the observed shell fallback broader than an individual read operation.

The new product solution places the installed guidance in the isolated
`CODEX_HOME` and supplies `AGENTS.md` through the agent-visible prompt-input
path. A debug prompt-input validation confirmed that this guidance is visible
to the agent and describes the status/context/query sequence without requiring
a pipeline. This note records the validated setup correction only; it does not
assert a subsequent benchmark result.

## Cursor compactness follow-up

The v9 failure showed a complete `MORE` cursor of roughly 2 KB being reduced
to a malformed 198-character argument before the continuation call. The query
cursor wire representation now compresses and signs the complete immutable
claims, reducing copy length while retaining the execution, stream, position,
scope, snapshot, ordering, projection, budget, status, completeness, and
expiry bindings. Legacy hex cursors remain accepted during the compatibility
window. This change is covered by cache restart, legacy decode, tampering, and
MCP `MORE` round-trip tests; no benchmark result is claimed here.
