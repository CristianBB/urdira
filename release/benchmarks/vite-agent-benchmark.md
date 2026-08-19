# Vite matched agent benchmark

This benchmark compares three discovery arms on the same frozen Vite checkout
and the same multi-iteration coding task:

1. `baseline`: the agent may use its ordinary shell/editor tools, but no
   code-intelligence MCP or symbol service.
2. `codebase-memory`: the agent uses a `codebase-memory-mcp` executable from
   `PATH` (or `CODEBASE_MEMORY_BIN`) for graph discovery,
   source snippets, and caller tracing.
3. `urdira`: the agent uses the benchmark Urdira MCP projection for explicit
   workspace-scoped discovery. It may not use grep/glob for the benchmark
   target.

“Sin ninguna tool” is recorded as “without any code-intelligence tool”; a
coding agent still needs its normal file-editing and command tools to complete
the task. A literal no-tools arm cannot edit or verify a repository and would
not be a meaningful completion comparison.

## Frozen project

- Repository: [vitejs/vite](https://github.com/vitejs/vite)
- Checkout: supplied with `--repository-root` or `VITE_BENCHMARK_REPOSITORY`
- Commit: `c0f2fc607ee97ee4499337b04826420c00654065`
- Languages/files observed: TypeScript-heavy monorepo, 1,442 indexed files
- Codebase-memory project: `vite-benchmark-c0f2fc6`

The checkout is never modified in place by the campaign. Each run gets a
detached worktree at the frozen commit.

## Coding task

Implement an opt-in `serverRequest` plugin hook for the Vite development
server. The feature must be useful to plugins that need request telemetry but
must not add request-level work when no plugin opts in.

The hook receives a stable record containing HTTP method, URL, final status,
duration, and whether the response closed before finishing. It must report
exactly once for normal responses and aborted responses, tolerate a plugin
callback throwing without breaking the response, and work in middleware mode
and after server restart. Existing `configureServer` ordering and behavior
must remain compatible.

The completed change must include the public TypeScript contract, the server
dispatch/lifecycle implementation, focused tests for finish/close/error,
middleware mode and restart/no-duplicate behavior, and concise plugin API
documentation. The working tree remains uncommitted for grading.

## Benchmark scope and interpretation

This is a deliberately specific workload, not a universal ranking of coding
tools. It combines:

- a large repository: the Vite TypeScript monorepo;
- a highly localized change: one development-server hook and its nearby tests;
- precise discovery needs: plugin ordering, request lifecycle, and a small set
  of public types and implementation symbols;
- few iterations: three agent instructions/resumes per run; and
- bounded expected evidence: a handful of source files, focused tests, and a
  concise API documentation update.

This shape is useful for measuring the overhead of code-intelligence discovery
when the task can be solved with targeted native repository tools. It should
not be generalized to tasks that require broad cross-repository caller
analysis, architectural exploration, or many distributed edits. The results
therefore answer: “which arm performs better for this large-repository,
localized-change workload under this agent protocol?” They do not establish a
universal ordering for every coding task.

## Iteration protocol

The same agent session receives three instructions. The next instruction is
sent only after the previous one has returned, so the benchmark measures the
actual number of outer turns and preserves the intermediate edit state.

### Iteration 1 — map and implement the core path

Trace the current plugin hook sorting and dev-server middleware lifecycle.
Add the public `serverRequest` type and the smallest opt-in dispatch path.
Cover a successful response and make sure the hook is not installed when no
plugin declares it. Do not install dependencies or run the full repository
suite yet; keep the diff focused.

### Iteration 2 — harden lifecycle semantics

Re-discover the changed symbols using the arm's assigned discovery method.
Complete finalization semantics for `finish`, `close`, and response errors;
guarantee one callback per request; preserve status and URL values; and cover
middleware mode and a server restart. Add focused tests for the edge cases and
keep callback failures isolated from the response pipeline.

### Iteration 3 — integration and handoff

Re-discover the final implementation and review the diff for public-contract
and compatibility drift. Add the concise plugin API documentation, run the
narrowest relevant Vite tests and typecheck available in the checkout, and
report the exact commands, changed files, and any remaining failure. Do not
commit.

## Acceptance grader

A run is successful only when all of these hold:

- the final worktree contains the public hook contract, implementation,
  focused lifecycle tests, and documentation;
- the focused tests and package typecheck pass (or the repository reports a
  deterministic, pre-existing blocker with evidence); and
- a static review confirms the hook is opt-in, reports once on finish/close,
  isolates callback errors, and does not regress middleware mode or restart
  behavior.

The grader records `completed_successfully` separately from process exit code.
Timeouts, tool failures, incomplete diffs, and unverified claims are failures,
not partial successes.

## Measurements

Every run records:

- `input_tokens`, `output_tokens`, `reasoning_tokens`, and `total_tokens`;
- `outer_turns` (the three Codex instructions/resumes) and observable agent
  iterations;
- code-intelligence MCP calls and ordinary command/file-change actions;
- estimated cost using one explicit input/output/reasoning price card;
- setup time and elapsed wall time from the first instruction through the
  final response; and
- `completed_successfully`, process/timeout status, grader evidence, and the
  full transcript and host log paths.

The smoke gate is three arms × two cache states (`cold`, `warm`) = six runs.
Only after all six smoke groups pass may the sequential campaign run ten
samples per arm/cache state (60 runs total). Failed runs remain in the audit
and are never silently discarded.
