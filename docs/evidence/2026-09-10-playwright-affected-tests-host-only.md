# Playwright affected-tests host-only pass

Date: 2026-09-10

This report selects one fully instrumented structural host-only readiness pass
for `microsoft/playwright` at commit
`1b44f5a441f391538c42c7ce36dd8ce779a5d6a1`. No coding-agent turn, MCP query,
or benchmark task execution was performed.

An orchestration overlap caused an earlier host process to enter indexing
before its interruption became visible, while the replacement pass had already
been dispatched. Consequently two effective Playwright host-only passes exist
in the raw archive. This report uses only the fully instrumented replacement;
no further Playwright run was made.

The checkout was a clean detached worktree with 3,093 tracked files and a
present root `package.json`. The host used arm `urdira-typescript`, the
release indexing worker, and task label `affected-tests-deterministic`.

Configuration used:

- semantic indexing: disabled (`URDIRA_SEMANTIC_INDEX=0`)
- semantic materialization: disabled (`URDIRA_SEMANTIC_MATERIALIZATION=0`)
- semantic sidecar: not created
- analysis workers, analysis pool maximum, and structural concurrency: `1`
- reconciliation sweep interval: `0 ms`
- debug timing, storage timing, and semantic performance attestation: enabled

The host emitted `BENCH_HOST_READY` after 5,498 ms. Structural readiness was
current and complete. The worker startup attestation reported semantic
performance diagnostics enabled. The cold scan diagnostics reported 1.931 s
total, 0.630 s materialization, and 1.380 s publication; the partitioned
publication reported 1.127 s base writing and 0.072 s Merkle graph work.
The queryable frontier was recorded at 4,579 ms and the completed frontier at
4,764 ms. The selected evidence run reports `hybrid_semantics=1.516 s`.

Semantic performance counters covered 1,564 affected paths, 1,564 hybrid
owners, and 1,017,759 sites. They recorded 13,073 sibling-conformance calls
in 1,871 us, 359,585 typeflow lookups in 2,966,373 us, and 195,683 member
walks in 2,876,065 us. The typeflow diagnostics included 3,583 alias-chasing
operations in 1,776 us. The top affected-owner diagnostics reported 10
owners and 94,835 sites in their retained bounded sample; the complete owner
and site totals are the 1,564 owners and 1,017,759 sites above.

The external process-tree sampler ran every 500 ms and captured 84 samples
until orderly termination after readiness. Peak sampled RSS was 2,967,696 KiB,
with a peak process count of 2. Mean sampled CPU was 54.486 percent and the
maximum sample was 545.4 percent. Byte telemetry reported 31,192,245 bytes read
and copied, with zero transferred, decoded, and retained bytes.

Raw stdout, stderr, and process-tree samples are retained in the associated
private benchmark-results directory. Temporary checkout and data-root paths
are intentionally omitted from this public evidence.
