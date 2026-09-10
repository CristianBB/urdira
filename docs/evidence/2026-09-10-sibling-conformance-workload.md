# Sibling-conformance workload profile

Date: 2026-09-10  
Status: directed diagnostic over one existing Prisma structural pass; no full
Urdira campaign, agent session, MCP client, or query was run.

## Scope and provenance

The runtime sample reused the frozen `prisma/prisma` checkout at commit
`0f37454eec96b193e8b20e8f569e453acd2af644` and the structural-only contract
used by the final profiled pass (`URDIRA_SEMANTIC_INDEX=0`, semantic
materialization disabled, one analysis worker, one structural lane). The
production checkout was not edited. A temporary copy of the then-current
Urdira source was instrumented and built under a private temporary build root;
the instrumented worker was run once until the `warm` structural frontier
became current, then stopped.
The raw host log was copied to the retained evidence directory as `host.err`:

`sibling-conformance-profile-20260910/host.err` in the benchmark archive.

SHA-256: `c80811d90d55fb6738cd7cb3ca3a160571bdff272e22208413dd713479502305`.

The existing uninstrumented reference is
`urdira-prisma-final-profiled.host.log` in the retained profiled-pass evidence
archive.

## Commands

The temporary worker was built with:

```bash
RUSTUP_TOOLCHAIN=1.98.0 \
  CARGO_TARGET_DIR=<temporary-build-root> \
  cargo build --release --locked -p urdira-indexing-worker
```

The directed host pass used the existing benchmark host runner, the temporary
worker, and the Prisma checkout above. Its relevant environment was:

```bash
URDIRA_INDEXING_CORE_WORKER_PATH=<temporary-build-root>/release/urdira-indexing-worker \
URDIRA_SEMANTIC_INDEX=0 URDIRA_SEMANTIC_MATERIALIZATION=0 \
URDIRA_V4_DEBUG_SEMANTIC_PERF=1 URDIRA_ANALYSIS_WORKERS=1 \
URDIRA_ANALYSIS_POOL_MAX=1 URDIRA_STRUCTURAL_CONCURRENCY=1 \
URDIRA_RECONCILIATION_SWEEP_INTERVAL_MS=0 \
URDIRA_BENCHMARK_TIMEOUT_MS=1800000 URDIRA_INDEXING_CORE_TIMEOUT_MS=1800000 \
node release/benchmarks/expanded-agent-benchmark-runner.mjs --host \
  --repository-id prisma --task-id wire-name-validation \
  --arm urdira-typescript --phase warm --sample 1 \
  --commit 0f37454eec96b193e8b20e8f569e453acd2af644 \
  --worktree <prisma-checkout> \
  --data-root <temporary-data-root>/data \
  --indexing-worker <temporary-build-root>/release/urdira-indexing-worker
```

The static hierarchy pass reused the pinned `urdira-jsts-typeflow` parser in
the same temporary source copy:

```bash
RUSTUP_TOOLCHAIN=1.98.0 \
  CARGO_TARGET_DIR=<temporary-build-root> \
  cargo run --release --offline -- <prisma-checkout>
```

## Runtime key distribution

The temporary worker emitted one line for each call to
`ProgramIndex::sibling_conformance_overrides`, recording
`(entity_id, member_name, is_static, result_width)`. The pass produced:

| Metric | Result |
|---|---:|
| Calls | 18,685 |
| Distinct key triples | 4,003 |
| Repeated calls | 14,682 (78.58%) |
| Mean calls per distinct key | 4.67 |
| Distinct entity IDs | 1,200 |
| Distinct member names | 1,508 |
| Static calls | 0 |
| Result IDs across all calls | 1,055 |
| Result IDs across distinct keys | 157 |

Result width was stable for every repeated key (zero keys changed width
between calls), which makes per-index memoization a plausible diagnostic
alternative. Width distribution by call was `0: 17,892`, `1: 620`, `2: 161`,
`6: 3`, `9: 8`, and `23: 1`; only 793 calls returned a non-empty candidate
list. The most repeated keys were `exitCode` on
`EngineCommandResult` (628 calls), `setNextResults` on `MockRuntime` (260),
`stderr` on `EngineCommandResult` (184), and `initialize` on `Harness` (176).

The existing uninstrumented profile measured sibling-conformance aggregate
time as 369,946,570 microseconds for the same 18,685 calls, or 19.80 ms per
call on average. The instrumented run reported 389,622,448 microseconds
(20.85 ms per call); the difference is expected instrumentation/I/O overhead
and must not be treated as a speedup or regression measurement.

## Hierarchy shape

The static parser saw 4,511 source files and parsed all of them. It produced
54,210 member-bearing containers: 53,193 interfaces (including synthetic
interfaces produced by the typeflow extractor) and 1,017 classes/object
shapes, with 133,721 member rows. The locally resolved hierarchy contained
963 heritage edges; 2,332 heritage targets remained imported or unknown in
this standalone summary pass. Therefore the following depth/width values are
for the locally closed graph and are a lower-bound diagnostic for the full
worker index.

| Local graph metric | Result |
|---|---:|
| Maximum ancestor depth | 2 |
| Depth histogram | 53,319 at 0; 843 at 1; 48 at 2 |
| Maximum direct children of one container | 33 |
| Containers with at least one direct child | 705 |
| Direct-child width, nonzero p50 / p95 / p99 | 1 / 2 / 9 |
| Sum of direct-child links | 895 |
| Transitive local ancestor relations | 1,032 |

The worker's existing reference telemetry reported 982 heritage-resolution
operations. It does not expose the fully closed edge set, so no stronger
cross-file depth or width claim is made here.

## Potential index alternatives

The profiled baseline implementation scanned all 54,210 containers for every
query key and tested conformance reachability for each other container. This
gives an upper-bound outer scan count of approximately 1,012,913,850
container checks
for the 18,685 calls, or 217,002,630 checks if the 4,003 distinct keys were
memoized once per immutable `ProgramIndex`. A key-result cache could therefore
remove 78.58% of these repeated scans in this pass, with only 4,003 key entries
and 157 candidate IDs in the observed result sets.

A reverse posting index keyed by `(ancestor_container, member_name,
staticness)` could return descendant declarations directly and avoid the
corpus-wide container scan. Its exact memory cost cannot be claimed from this
standalone summary because 2,332 heritage targets were not closed across
imports. The local graph supplies a scale check: 1,032 transitive ancestor
relations over 54,210 containers, maximum depth two, and 133,721 member rows.
Any implementation would need invalidation/rebuild accounting on index changes;
the baseline code deliberately avoided maintaining another incremental index.

These figures are workload evidence for choosing a follow-up optimization
experiment. They do not authorize or implement an index change, and they do
not establish a full-corpus benchmark result.
