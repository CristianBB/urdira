# Vite cross-cutting lifecycle-map benchmark

This is a second, independent benchmark workload for the same frozen Vite
checkout. It is intentionally shaped so repository-graph discovery should have
a plausible advantage over a localized shell search.

The three arms remain comparable:

1. `baseline`: ordinary shell/editor tools only; no code-intelligence MCP.
2. `codebase-memory`: the local `codebase-memory-mcp` graph, snippets, and
   caller tracing.
3. `urdira`: the benchmark Urdira MCP projection with explicit workspace scope.

## Task

Produce `docs/reports/2026-08-19-vite-plugin-lifecycle-map.md` without editing
production code. The report must map the public plugin contract, lifecycle
ordering and dispatch, important callers/consumers across build/serve/preview
and tests, relevant API documentation, and a safe staged migration plan for a
hypothetical new plugin lifecycle event. Every important claim must cite exact
file paths and line numbers. The report must distinguish verified repository
evidence from recommendations and risks.

This requires broad cross-cutting discovery rather than one localized edit:
the expected evidence spans many symbols, callers, tests, and documentation
paths. The acceptance grader checks for a non-empty report, an evidence table,
a contract/dispatch section, a caller or consumer matrix, test/documentation
coverage, migration risks/plan, at least eight file:line references, and a
clean diff.

## Iterations

The same agent session receives three instructions/resumes per run:

1. establish the contract, lifecycle dispatch, central symbols, and an initial
   evidence table;
2. broaden and validate caller/consumer tracing across the monorepo, including
   build/serve/preview and test paths; and
3. validate the final report and complete the staged plan, risks, tests, docs,
   and exact verification commands.

No dependencies are installed and no run commits changes. A successful run is
one whose report satisfies the grader; incomplete or unsupported claims fail.

## Campaign size and interpretation

The campaign uses two samples per arm and cache state (12 runs total), after a
fresh six-run smoke gate for this task. This is a smaller independent sample
than the 60-run localized implementation campaign because the prior campaign
showed stable arm ordering. It is evidence for this broad-discovery workload,
not a replacement for or overwrite of the localized benchmark results.

