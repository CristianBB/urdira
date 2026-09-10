# VS Code language registry host only pass

Date: 2026-09-10  
Status: one effective structural host only pass; no agent, MCP client, query,
or campaign execution was run.

## Scope and frozen inputs

This pass indexed `microsoft/vscode` at commit
`038b9225c82c6b75172beda6081c64887692538c` using the existing benchmark host
runner, task `language-registry-change-notification`, arm
`urdira-typescript`, and `target/release/urdira-indexing-worker`. The detached
checkout was clean, contained `package.json`, and had 18,001 tracked files.
No production source file was edited.

Semantic indexing and materialization were disabled. Analysis workers,
analysis-pool maximum, and structural concurrency were each `1`; the
reconciliation sweep interval was `0 ms`. Debug timing, storage timing, and
semantic performance diagnostics were enabled. The worker startup attestation
reported `schema_version=1`, `semantic_perf_enabled=true`, and
`debug_timing_enabled=true`.

## Readiness and timings

The host reached `structural_completeness=complete`,
`freshness_status=current`, and `workspace_status=ready`. `BENCH_HOST_READY`
was emitted at **57,859 ms**. The queryable frontier was at **55,051 ms** and
the completed durable frontier at **57,430 ms**.

The worker reported `hybrid_semantics=14.862 s` over 12,944 affected paths
and 12,944 hybrid owners. The scan orchestrator reported
`run_cold_total=21.564 s`, with `materialize_call=16.384 s` and
`publish_call=14.441 s`.

| Phase | Result |
|---|---:|
| catalog walk / apply | 1.733 s / 3.074 s |
| catalog observations | 17,675 |
| typeflow full extraction | 0.278 s over 12,944 files |
| facts extraction | 1.317 s; 1,349,115 lane-1 records |
| resolver setup | 0.009 s; clone 0.001 s |
| typeflow index | 0.571 s |
| hybrid semantics | 14.862 s |
| materialize pass 1 | 7.294 s; 5,447,239 records |
| materialize pass 2 | 8.992 s; 5,446,322 records |
| base write durable | 11.774 s |
| graph entries | 4,568,444 |
| run cold total | 21.564 s |

Pass 2 recorded 342,569 dependency rows, 877,798 subjects, 657,326 pending
sites, 916 non-interned targets, and one dropped candidate. The worker's
semantic counters were:

| Counter | Count | Elapsed |
|---|---:|---:|
| sibling conformance | 375,458 | 7,354,424 us |
| typeflow lookup | 2,493,632 | 112,102,245 us |
| member walk | 1,629,857 | 95,164,725 us |
| import resolution | 232,580 | 1,502,218 us |
| heritage resolution | 20,055 | 369 us |
| reference resolution | 2,628,521 | 0 us |
| call resolution | 1,026,907 | 0 us |
| reexport resolution | 1,694 | 7,743 us |
| union walk | 576 | 2,513,531 us |
| alias chasing | 4,830 | 11,406 us |
| semantic sites | 6,698,949 | — |

Worker RSS diagnostics were 244.6 MiB at start, 4,768.8 MiB after resolve,
and 7,858.4 MiB after materialization and at scan completion. Byte telemetry
reported 200,811,607 bytes read and copied, with zero transferred, decoded,
retained, or hashed bytes.

## Process sampling and evidence

The external sampler captured 240 records at the intended 500 ms cadence, but
the retained records contain only the runner root PID (`process_count=1`) due
to a sampler tree-closure defect. Their timestamps also contain a non-JSON
`N` suffix from the macOS `date` implementation. Accordingly, root-only
diagnostics are reported as observed: peak RSS **320,304 KiB**, peak CPU
**103.8%**, mean CPU **51.898%**, and one observed process. These values are
not process-tree metrics and no process-tree peak is claimed. The worker RSS
lines above are retained as internal diagnostics.

Raw artifacts are retained outside the repository in:
`/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-09/luna-sibling-vscode-20260910/`.

| Artifact | SHA-256 |
|---|---|
| `runner.stdout` | `6dbb602024a852fd78d310e0a44b27b372271112f8be6043edb88132108fec9d` |
| `runner.stderr` | `2b3e6d455150fe6cfb164e820a2db1389d83b5193e63b221cf47c9a04c23281e` |
| `process-tree.jsonl` | `c6da6ce3d6b0f39f051754f5c58df1abc2910b2b3f238e7c370903281ea62c48` |

The temporary checkout and data root were removed after the raw evidence and
this report were retained. No matching worker or host process remains.
