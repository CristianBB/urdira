# Sibling-conformance optimization: TypeScript directed pass

Date: 2026-09-10  
Status: one effective structural readiness pass; no agent, MCP client, query,
or full benchmark campaign was run.

## Scope and frozen inputs

This pass exercised the current `sibling_conformance_overrides` implementation
against the TypeScript repository used by the expanded benchmark:

| Input | Value |
|---|---|
| Repository | `microsoft/TypeScript` |
| Commit | `b465fdbfe175304d9b977da137b2c178ae1091d3` |
| Source tree | GitHub archive for the exact commit, 81,354 tracked files in a local verification checkout |
| Urdira worker | `target/release/urdira-indexing-worker` |
| Worker SHA-256 | `667f404260a0d9343c96557eae92dba3b5a0bf1e600f93d62f48a0ffacd83b24` |
| Corpus config SHA-256 | `06e8bffa38a843e38fb4589eabe5bbb1bd57ac298d4169875c1f721e32b19d37` |
| Node | `v24.18.1` |
| Phase | `warm`, structural frontier |
| Semantic mode | `URDIRA_SEMANTIC_INDEX=0`, `URDIRA_SEMANTIC_MATERIALIZATION=0` |
| Concurrency | one analysis worker, one analysis-pool lane, one structural lane |
| Reconciliation sweep | disabled (`0`) |

The first host invocation stopped before workspace registration because the
direct `--host` path did not receive `URDIRA_INDEXING_CORE_WORKER_PATH`; its
single error is retained as `setup-failure.log`. It produced no index and no
readiness event. The effective pass exported the worker path explicitly and
completed once. This setup correction does not constitute a second indexing
pass.

## Command and attestation

The effective command was the existing runner in host-only mode, with
`--repository-id typescript`, `--task-id transpile-diagnostic-callback`,
`--arm urdira-typescript`, `--phase warm`, the frozen commit above, and the
current release worker. No coding-agent process was launched.

The worker emitted this attestation before readiness:

```text
current_exe=<release-worker>/urdira-indexing-worker
schema_version=1 semantic_perf_enabled=true debug_timing_enabled=false
```

The source tree reached `structural_completeness=complete`,
`freshness_status=current`, and `workspace_status=ready`. `BENCH_HOST_READY`
was emitted at **9,086 ms**. The host was terminated with `SIGTERM` immediately
after that marker. The captured host output is retained at:

`luna-sibling-typescript-20260910/host.log` in the benchmark archive

SHA-256: `ea929985cf55ec52933340c046c03653dd4be0248fca79291d82e55902717c9b`.

## Observed semantic and structural counters

The worker's semantic-performance line reported:

| Metric | Value |
|---|---:|
| affected paths / hybrid owners | 756 / 756 |
| semantic sites | 799,057 |
| sibling-conformance calls | 34,428 |
| sibling-conformance aggregate | 336,797 µs |
| typeflow lookups / elapsed | 180,665 / 3,321,189 µs |
| member walks / elapsed | 133,202 / 2,946,020 µs |
| heritage resolutions / elapsed | 2,609 / 9 µs |
| import resolutions / elapsed | 19,891 / 572,816 µs |
| reference resolutions | 410,434 / 0 µs |
| call resolutions | 99,191 / 0 µs |
| alias chasing / elapsed | 1,251 / 778 µs |

The persisted structural store provides these fixed-stride row counts:

| Structure | Rows |
|---|---:|
| source artifacts / observations | 852 / 852 |
| records | 722,761 |
| dependency rows | 2,586 |
| pending sites | 36,576 |
| entity index rows | 127,544 |
| outgoing / incoming adjacency rows | 591,033 / 594,879 |
| semantic SQLite bytes | 0 |
| Rust semantic sidecar bytes | 0 |

The worker's byte telemetry reported 31,602,643 bytes read and copied from
CAS, with zero transfer, decode, retained, hash, or reread bytes. Persisted
artifact sizes were 475,136 bytes catalog SQLite, 92,815,360 bytes lexical
SQLite, 642,510,741 bytes structural store, and 37,102,564 bytes CAS.

## Timing and resource limits

The direct host-only invocation did not enable `URDIRA_DEBUG_TIMING=1`, and it
did not use the benchmark driver's process-tree sampler. Consequently the
following requested phase values are **unavailable for this pass** and are not
reconstructed from wall-clock differences:

* `build_index` and reverse-index build time;
* `hybrid_semantics` and `run_cold_total`;
* queryable and completed-durable timestamps;
* peak/mean RSS, CPU, process count, and sample count through readiness.

The only valid end-to-end timing is the structural readiness marker at 9,086
ms. The catalog records publication at 7,568 ms after workspace registration,
but this is a derived persistence timestamp and is not labeled as
`run_cold_total` or queryable time.

No equivalent TypeScript sibling-conformance baseline with the same current
worker, commit, and measurement contract was available. Existing Prisma
profiles use a different corpus and are not used as a comparison here.

## Evidence retention and conclusion

Raw data and logs are retained outside the repository in the benchmark archive
under `luna-sibling-typescript-20260910/`.
The accidental in-repository `BenchmarkResults` directory was removed, and no
matching worker or host process remains. No production source file was changed
by this pass.

The optimization was exercised successfully on the frozen TypeScript corpus:
34,428 sibling-conformance calls completed with structural parity indicated by
the complete/current/ready frontier and persisted structural output. A numeric
speedup claim is not made because the required timing and resource telemetry
was not enabled in this one pass and no same-contract TypeScript baseline was
available.
