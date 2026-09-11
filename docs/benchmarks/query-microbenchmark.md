# Query microbenchmark

`release/benchmarks/query-microbenchmark.mjs` measures deterministic MCP query calls against one structural Urdira workspace at a time. It creates a detached worktree at the pinned repository commit, bootstraps the production daemon/MCP stdio entrypoint, waits for structural readiness, and records each call, continuation, stderr stream, and emitted query telemetry. Semantic indexing, materialization, and sidecars are disabled.

Use `--repositories` to select repositories and `--operations` to select a subset such as `resolve_symbol`, `find_records`, `search_text`, or `wide`. The harness runs repositories sequentially and preserves raw output for failures. Temporary worktrees and data roots are removed only after the child transport and runtime close.

The results are suitable for route, pagination, cursor, hydration, and query wall-time checks. They are not a natural agent benchmark: there is no agent, prompt selection, competitor, or grader. Readiness and indexing timings are measured separately from MCP call wall time, and results from different commits, worker builds, response budgets, or semantic settings are not comparable. A missing cursor means the operation returned no continuation; it must not be treated as evidence that the full corpus was examined unless the response completeness contract says `complete`.
