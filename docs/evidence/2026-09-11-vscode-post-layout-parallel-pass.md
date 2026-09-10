# VS Code post layout parallel host only pass

Date: 2026-09-11  
Status: one effective structural host only pass; no agent, MCP client, query,
or campaign was run.

The pass used `microsoft/vscode` at commit
`038b9225c82c6b75172beda6081c64887692538c`, a clean detached checkout with
18,001 tracked files and `package.json`. It used only the release worker whose
SHA-256 was `7beed178ae600e71585d1003b235e52e846831c044f5e1066595c67dc46daa0a`.
Semantic indexing, semantic materialization, and semantic sidecar creation
were disabled. Analysis workers, analysis pool maximum, and structural
concurrency were `1`; reconciliation sweep was `0 ms`. Debug timing, storage
timing, and semantic performance diagnostics were enabled. The startup
attestation reported `schema_version=1`, `semantic_perf_enabled=true`, and
`debug_timing_enabled=true`.

## Readiness and comparison

The host reached `structural_completeness=complete`, `freshness_status=current`,
and `workspace_status=ready`. `BENCH_HOST_READY` was emitted at **43,931 ms**;
queryable was **39,795 ms** and completed durable was **42,379 ms**.

| Metric | This pass | Physical preallocation pass | Change |
|---|---:|---:|---:|
| readiness | 43.931 s | 45.928 s | −4.35% |
| queryable | 39.795 s | 42.551 s | −6.48% |
| durable | 42.379 s | 44.929 s | −5.68% |
| `hybrid_semantics` | 4.000 s | 4.010 s | −0.25% |
| `run_cold_total` | 9.684 s | 10.021 s | −3.36% |
| `member_walk` aggregate | 3.184741 s | 3.415612 s | −6.76% |
| `typeflow_lookup` aggregate | 6.417231 s | 6.791588 s | −5.51% |

## Materialization, layout preparation, Merkle, and publication

The worker reported catalog walk/apply `1.748 s / 3.147 s`, typeflow full
extraction `0.248 s`, facts extraction `0.616 s`, resolver setup `0.010 s`,
and typeflow index `0.503 s`.

Materialize pass 1 took **7.266 s** for 12,944 owners and 5,447,239 records;
the maximum owner batch was 340.812 ms and the mean task was 4.567 ms.
Materialize pass 2 took **9.010 s** for 5,446,322 records, 342,569
dependencies, 877,798 subjects, and 657,326 pending sites. Its sub-timings
were dictionary `0.969 s`, subject resolution `2.091 s`, assembly `4.295 s`,
classification repair `0.046 s`, partition sort `0.683 s`, dependencies
`0.369 s`, and dictionary finalization `0.066 s`.

The layout preparation line was:

```text
partitioned prepare: batch_index=0.893s layouts=0.797s prefix=0.036s physical_preallocate=0.323s total=2.050s
```

Compared with the physical-preallocation pass, layout preparation fell from
`7.459 s` to `2.050 s`; the layout subphase fell from `6.433 s` to `0.797 s`.
The physical preallocation subphase itself was `0.323 s` versus `0.080 s`.

Hot and secondary files took **4.841 s**. Base write took **7.898 s**:
hot/entries `6.903 s`, dependency files `0.080 s`, dictionary files `0.167 s`,
Merkle build `0.258 s`, page-cache write `7.753 s`, Merkle persist `0.059 s`,
and fsync `0.086 s`. The base-write breakdown was hot `4,676 ms`, owner
`838 ms`, name `434 ms`, kind `606 ms`, identity `1,757 ms`, outgoing
adjacency `1,008 ms`, incoming adjacency `145 ms`, and entity index `1,924 ms`.
Publish reported `write_base=7.952 s`, Merkle graph metric `0.244 s`, and
4,568,444 graph entries.

## Counters and resources

The semantic performance line recorded 375,458 sibling-conformance calls,
2,493,632 typeflow lookups, 1,629,857 member walks, 232,580 import
resolutions, 20,055 heritage resolutions, 2,628,521 reference resolutions,
1,026,907 call resolutions, 1,694 reexport resolutions, 576 union walks, and
6,698,949 semantic sites. Aggregate averages were 14.298 us per sibling call,
2.573 us per typeflow lookup, and 1.954 us per member walk. These timers
overlap the hybrid wall interval and must not be summed.

Worker RSS was 243.8 MiB at start, 5,489.9 MiB after resolve, and 8,145.0 MiB
after materialization/scan completion. CAS telemetry reported 4,823,350 bytes
read and copied, with zero transferred, decoded, retained, or hashed bytes.

The corrected external sampler captured 88 samples through readiness. Peak
process-tree RSS was **11,597,792 KiB**, peak CPU **868.1%**, mean CPU
**355.672%**, and peak process count **2**. This tree metric includes host and
worker and is separate from internal worker RSS. Compared with the physical
preallocation pass, tree peak RSS changed by `−1.71%`, while internal worker
RSS changed by `+9.37%`.

## Evidence and cleanup

Raw artifacts are retained in:
`/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-09/luna-post-vscode-layout-parallel-20260911/`.

| Artifact | SHA-256 |
|---|---|
| `runner.stdout` | `be306a1230d67918418336ce16ffd4434575a59eff329797e3734c4aa605fa86` |
| `runner.stderr` | `c2eacd371f98d1e5e767b45286e7672ba5376388b34a42e1c5cf2229125501f0` |
| `process-tree.jsonl` | `c3497f409c05b5a89b02b0314a0909cab27aaedd893ca650841c37288c5edc12` |
| `preflight.json` | `8cddf3073e708bcdb8a946b88aa23c938efec69fd368443bb3842850ea1c6491` |
| `supervisor.json` | `b32ae8ad7d172e3b32e0ef7711ce26d8c5fffe43572583dc2e07da47dee489ef` |

The runner exited cleanly after readiness with SIGTERM. The temporary checkout
and data root were removed after raw retention, and no worker or host process
remains.

## Repository verification

`CI=true pnpm verify` passed after the measured change. This includes the full
Rust workspace and ignored tsgo integration suites, lint, 2,300 passing Vitest
tests (15 skipped), 90.18% line coverage, type checking, the coverage gate, and
publication hygiene. Structural-store tests also cover byte-identical output
across thread counts and between flat and partitioned writers, delta visibility,
incremental Merkle roots, compaction, recovery, and concurrent readers.
