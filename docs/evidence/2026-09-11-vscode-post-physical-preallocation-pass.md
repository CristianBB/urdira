# VS Code post physical preallocation host only pass

Date: 2026-09-11  
Status: one effective structural host only pass; no agent, MCP client, query,
or campaign was run.

The pass used `microsoft/vscode` at commit
`038b9225c82c6b75172beda6081c64887692538c`, a clean detached checkout with
18,001 tracked files and `package.json`. It used only the release worker whose
SHA-256 was `0fb85ff4c8c23d90f3347652810b38af276769bba41c15863c0b82cef9530a46`.
Semantic indexing, semantic materialization, and semantic sidecar creation
were disabled. Analysis workers, analysis pool maximum, and structural
concurrency were `1`; reconciliation sweep was `0 ms`. Debug timing, storage
timing, and semantic performance diagnostics were enabled. The startup
attestation reported `schema_version=1`, `semantic_perf_enabled=true`, and
`debug_timing_enabled=true`.

## Readiness and comparison

The host reached `structural_completeness=complete`, `freshness_status=current`,
and `workspace_status=ready`. `BENCH_HOST_READY` was emitted at **45,928 ms**;
queryable was **42,551 ms** and completed durable was **44,929 ms**.

| Metric | This pass | `luna-post-vscode-20260911` | `luna-post-vscode-merkle-20260911` |
|---|---:|---:|---:|
| readiness | 45.928 s | 46.066 s (−0.30%) | 45.971 s (−0.09%) |
| `hybrid_semantics` | 4.010 s | 4.068 s (−1.43%) | 4.016 s (−0.15%) |
| `run_cold_total` | 10.021 s | 9.775 s (+2.52%) | 10.020 s (+0.01%) |
| `member_walk` aggregate | 3.415612 s | 3.422220 s (−0.19%) | 3.323824 s (+2.76%) |
| `typeflow_lookup` aggregate | 6.791588 s | 6.856504 s (−0.95%) | 6.688071 s (+1.55%) |

## Materialization, physical preallocation, Merkle, and publication

The worker reported catalog walk/apply `1.788 s / 3.139 s`, typeflow full
extraction `0.372 s`, facts extraction `0.607 s`, resolver setup `0.009 s`,
and typeflow index `0.482 s`.

Materialize pass 1 took **7.353 s** for 12,944 owners and 5,447,239 records;
the maximum owner batch was 1,367.087 ms and the mean task was 4.382 ms.
Materialize pass 2 took **7.679 s** for 5,446,322 records, 342,569
dependencies, 877,798 subjects, and 657,326 pending sites. Its sub-timings
were dictionary `1.003 s`, subject resolution `1.923 s`, assembly `2.936 s`,
classification repair `0.047 s`, partition sort `0.468 s`, dependencies
`0.860 s`, and dictionary finalization `0.077 s`.

The physical-preallocation line was:

```text
partitioned prepare: batch_index=0.910s layouts=6.433s prefix=0.036s physical_preallocate=0.080s total=7.459s
```

Hot and secondary files took **3.171 s**. Base write took **11.577 s**:
hot/entries `10.633 s`, dependency files `0.068 s`, dictionary files
`0.126 s`, Merkle build `0.186 s`, page-cache write `11.443 s`, Merkle persist
`0.055 s`, and fsync `0.080 s`. The base-write breakdown was hot `1,995 ms`,
owner `2,133 ms`, name `88 ms`, kind `138 ms`, identity `535 ms`, outgoing
adjacency `137 ms`, incoming adjacency `123 ms`, and entity index `1,938 ms`.
Publish reported `write_base=11.618 s`, Merkle graph metric `0.227 s`, and
4,568,444 graph entries.

## Counters and resources

The semantic performance line recorded 375,458 sibling-conformance calls,
2,493,632 typeflow lookups, 1,629,857 member walks, 232,580 import
resolutions, 20,055 heritage resolutions, 2,628,521 reference resolutions,
1,026,907 call resolutions, 1,694 reexport resolutions, 576 union walks, and
6,698,949 semantic sites. Aggregate averages were 15.225 us per sibling call,
2.724 us per typeflow lookup, and 2.096 us per member walk. These timers
overlap the hybrid wall interval and must not be summed.

Worker RSS was 241.4 MiB at start, 5,729.4 MiB after resolve, and 7,447.1 MiB
after materialization/scan completion. CAS telemetry reported 1,598,569 bytes
read and copied, with zero transferred, decoded, retained, or hashed bytes.

The corrected external sampler captured 92 samples through readiness. Peak
process-tree RSS was **11,798,992 KiB**, peak CPU **860.9%**, mean CPU
**320.465%**, and peak process count **2**. This tree metric includes host and
worker and is separate from internal worker RSS. Compared with the Merkle pass,
tree peak RSS changed by `+0.83%`; internal worker RSS changed by `+7.27%`.

## Evidence and cleanup

Raw artifacts are retained in:
`/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-09/luna-post-vscode-preallocate-20260911/`.

| Artifact | SHA-256 |
|---|---|
| `runner.stdout` | `35ebaf86638f50a56164e94fb384318e8cedd0558220372da5ce336a6746d2d2` |
| `runner.stderr` | `655ad8ab2c8e3592be384d7aac4d384cfec6514334e598e702210d30a6720ac2` |
| `process-tree.jsonl` | `83002b32035c985e23ff4d6e2b0345dbc4657ad3e16b510c816a92516f064e42` |
| `preflight.json` | `b59ee326572d0234fcb0c59b094770f83052f695a929763245a7eeeebff0246c` |
| `supervisor.json` | `404cc243de10ad9c151da0a81f2b7a30a664bc6c60aad332ed035457e4f6aae7` |

The runner exited cleanly after readiness with SIGTERM. The temporary checkout
and data root were removed after raw retention, and no worker or host process
remains.
