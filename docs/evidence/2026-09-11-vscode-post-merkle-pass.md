# VS Code post Merkle host only pass

Date: 2026-09-11  
Status: one effective structural host only pass; no agent, MCP client, query,
or campaign was run.

The pass used `microsoft/vscode` at commit
`038b9225c82c6b75172beda6081c64887692538c`, a clean detached checkout with
18,001 tracked files and `package.json`. It used only the release worker
`target/release/urdira-indexing-worker`, SHA-256
`5213b85a5243cf2b57bbb47300a288c5f87a344ee3f5df3e24de438259ae2821`.
Semantic indexing, semantic materialization, and semantic sidecar creation
were disabled. Analysis workers, analysis pool maximum, and structural
concurrency were `1`; reconciliation sweep was `0 ms`. Debug timing, storage
timing, and semantic performance diagnostics were enabled. The startup
attestation reported `schema_version=1`, `semantic_perf_enabled=true`, and
`debug_timing_enabled=true`.

## Readiness and comparison

The host reached `structural_completeness=complete`, `freshness_status=current`,
and `workspace_status=ready`. `BENCH_HOST_READY` was emitted at **45,971 ms**;
queryable was **42,558 ms** and completed durable was **44,884 ms**.

| Metric | This pass | Previous pass | Change |
|---|---:|---:|---:|
| readiness | 45.971 s | 46.066 s | −0.21% |
| `hybrid_semantics` | 4.016 s | 4.068 s | −1.28% |
| `run_cold_total` | 10.020 s | 9.775 s | +2.51% |
| `member_walk` aggregate | 3.323824 s | 3.422220 s | −2.88% |
| `typeflow_lookup` aggregate | 6.688071 s | 6.856504 s | −2.46% |
| internal RSS post materialize | 6,942.5 MiB | 7,899.5 MiB | −12.11% |

The worker reported catalog walk/apply `1.940 s / 3.009 s`, typeflow full
extraction `0.250 s`, facts extraction `0.637 s`, resolver setup `0.010 s`,
and typeflow index `0.463 s`.

## Materialization and publication

Materialize pass 1 took **7.209 s** for 12,944 owners and 5,447,239 records;
the maximum owner batch was 772.770 ms and the mean task was 4.189 ms.
Materialize pass 2 took **8.691 s** for 5,446,322 records, 342,569
dependencies, 877,798 subjects, and 657,326 pending sites. Its sub-timings
were dictionary `0.874 s`, subject resolution `2.731 s`, assembly `3.640 s`,
classification repair `0.045 s`, partition sort `0.550 s`, dependencies
`0.348 s`, and dictionary finalization `0.263 s`.

The structural store wrote hot and secondary files in **2.610 s**. Base write
took **10.665 s**: hot/entries and Merkle `10.033 s`, dependency files
`0.064 s`, dictionary files `0.118 s`, Merkle build `0.152 s`, page-cache
write `10.534 s`, Merkle persist `0.054 s`, and fsync `0.077 s`. The base-write
breakdown was hot `1,753 ms`, owner `1,866 ms`, name `80 ms`, kind `126 ms`,
identity `327 ms`, outgoing adjacency `102 ms`, incoming adjacency `100 ms`,
and entity index `1,815 ms`. Publish reported `write_base=10.708 s`, Merkle
graph metric `0.228 s`, and 4,568,444 graph entries.

## Semantic counters and resources

The semantic performance line recorded 375,458 sibling-conformance calls,
2,493,632 typeflow lookups, 1,629,857 member walks, 232,580 import
resolutions, 20,055 heritage resolutions, 2,628,521 reference resolutions,
1,026,907 call resolutions, 1,694 reexport resolutions, 576 union walks, and
6,698,949 semantic sites. Aggregate timer averages were 14.868 us per sibling
call, 2.682 us per typeflow lookup, and 2.039 us per member walk. These
timers overlap the hybrid wall interval and must not be summed.

Worker RSS was 243.8 MiB at start, 6,186.7 MiB after resolve, and 6,942.5 MiB
after materialization/scan completion. CAS telemetry reported 200,811,607 bytes
read and copied, with zero transferred, decoded, retained, or hashed bytes.

The corrected external sampler captured 92 samples through readiness. Peak
process-tree RSS was **11,701,360 KiB**, peak CPU **850.1%**, mean CPU
**321.639%**, and peak process count **2**. This tree metric includes host and
worker and is separate from internal worker RSS. The tree peak changed by
`+1.69%` from the previous pass's 11,507,392 KiB.

## Evidence and cleanup

Raw artifacts are retained in:
`/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-09/luna-post-vscode-merkle-20260911/`.

| Artifact | SHA-256 |
|---|---|
| `runner.stdout` | `050b5a30df1acbb2852c71da12571d967d9e4a1a997e2e38af54661c295a852d` |
| `runner.stderr` | `36a9db1d1501f31a77e8e336db18a7cecb8af63705f4351711513aad32eab0aa` |
| `process-tree.jsonl` | `91d4106af12f7333d93c70faecf43718baec187d2be43b58e88a2603368aa0c1` |
| `preflight.json` | `aa8920024e39ab880d139daabd405c856911b6e16724a466ac00a1de8d78f9f1` |
| `supervisor.json` | `8ed1f4b0f6b883f9a08d7d4cbcf220dd675da75b38e9b366b9747c3654d82c84` |

The runner host was terminated after readiness with `SIGTERM`; the supervisor
recorded a clean exit. The temporary checkout and data root were removed after
raw retention, and no worker or host process remains.

## Decision

The direct partitioned Merkle experiment was rejected and removed from the
working tree. It changed readiness by only `-0.21%`, while its own measured
tree construction was `0.152 s`. The approximately ten-second enclosing wait
remained and therefore could not have been caused by the eliminated flat
digest-pair allocation or sort. The retained pass instead exposed unmeasured
preparation inside `write_hot_and_secondary_files_partitioned`, before its
`hot_and_secondary` timer begins. No performance claim or production change is
carried forward from this experiment.
