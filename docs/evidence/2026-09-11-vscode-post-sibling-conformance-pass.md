# VS Code post sibling conformance host only pass

Date: 2026-09-11  
Status: one effective host only pass; no agent, MCP client, query, or campaign
was run.

The pass used `microsoft/vscode` at commit
`038b9225c82c6b75172beda6081c64887692538c`, a clean detached checkout with
18,001 tracked files and `package.json`, the release indexing worker
(`6a098d60bb38e1acbaffc2cb51ed689ae630fd6a25749e7d908702b259b5e2b6`), and
task `language-registry-change-notification` on arm `urdira-typescript`.
Semantic indexing, semantic materialization, and semantic sidecar creation
were disabled. Analysis workers, analysis pool maximum, and structural
concurrency were `1`; reconciliation sweep was `0 ms`. Debug timing, storage
timing, and semantic performance diagnostics were enabled.

## Readiness and timings

The host reached `structural_completeness=complete`, `freshness_status=current`,
and `workspace_status=ready`. `BENCH_HOST_READY` was emitted at **46,066 ms**;
queryable was **41,533 ms** and completed durable was **43,870 ms**.

| Metric | This pass | Previous optimized pass | Change |
|---|---:|---:|---:|
| readiness | 46.066 s | 57.859 s | −20.38% |
| `hybrid_semantics` | 4.068 s | 14.862 s | −72.63% |
| `run_cold_total` | 9.775 s | 21.564 s | −54.67% |
| `member_walk` aggregate | 3.422220 s | 95.164725 s | −96.40% |
| `typeflow_lookup` aggregate | 6.856504 s | 112.102245 s | −93.88% |

The worker reported catalog walk/apply `1.905 s / 2.917 s`, typeflow full
extraction `0.244 s`, facts extraction `0.672 s`, typeflow index `0.499 s`,
materialize pass 1 `6.675 s`, materialize pass 2 `7.868 s`, and publish
`13.888 s` (`write_base=11.309 s`). Materialize pass 2 contained dictionary
`0.953 s`, subject resolution `1.905 s`, and assembly `3.433 s`.

## Counters and resources

The semantic performance line recorded 375,458 sibling conformance calls,
2,493,632 typeflow lookups, 1,629,857 member walks, 232,580 import
resolutions, 20,055 heritage resolutions, 2,628,521 reference resolutions,
1,026,907 call resolutions, 1,694 reexport resolutions, 576 union walks, and
6,698,949 semantic sites. Per-call aggregate averages were 15.252 us for
sibling conformance, 2.750 us for typeflow lookup, and 2.100 us for member
walk. These aggregate timers overlap the hybrid wall interval and must not be
added together.

Internal worker RSS was 244.9 MiB at start, 6,045.0 MiB after resolve, and
7,899.5 MiB after materialization/scan completion. CAS telemetry reported
200,811,607 bytes read and copied, with zero transferred, decoded, retained,
or hashed bytes.

The corrected external process tree captured 92 samples through readiness,
with peak RSS 11,507,392 KiB, peak CPU 817.2%, mean CPU 323.113%, and peak
process count 2. This tree metric includes the host and worker and is kept
separate from the worker's internal RSS diagnostic.

## Evidence

Raw artifacts are retained in:
`/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-09/luna-post-vscode-20260911/`.

| Artifact | SHA-256 |
|---|---|
| `runner.stdout` | `2f0f1ea1d27c723015b2e4f3b5b6ea0b87aaad37018b23ba400127d0a0e6bd77` |
| `runner.stderr` | `741a6d98bb6c96037026f6cc7061c15ff61f1b6281450f28f9a7ed6a45e73c7f` |
| `process-tree.jsonl` | `6a04ce51a193e6f44601636bb4597e455024fffb00f0781325901d06796d5d27` |
| `preflight.json` | `cc1846ad5d2ae04838e5bf4298a5aab062c9502dcc5786a67aca547bae1823b0` |

The pass was stopped after readiness with SIGTERM. The supervisor metadata
records the marker detection race (`ready=false`), while `runner.stdout` is
the authoritative readiness evidence. The temporary checkout and data root
were removed after raw retention; no worker or host process remains.
