# Readiness campaign 2 — incremental levers: measured outcome

Date: 2026-08-24 (overnight session continuing docs/evidence/2026-08-23-readiness-from-zero-optimization.md)

## Summary

The second campaign's three incremental levers (P1 seal-digest streaming +
identity memoization, P2 windowed SQL bracketing, P3 catalog byte hand-off +
early import graph) were implemented, measured on the frozen
`microsoft/vscode` cell, and largely **invalidated by measurement**. Two of
the three were reverted the same night. The net committed state is
wall-clock-neutral on VS Code, with real but small wins (worker closure
cache pre-seed −3.7s, per-command instrumentation, a deadlock-hardened
bounded read-ahead), and the campaign's remaining large lever — the index
pack (P5) — is unaffected by these findings.

This document exists mostly for its negative results: three plausible,
carefully-argued attributions were wrong, and one measurement-methodology
trap (machine-state drift) nearly caused a false regression verdict.

## Machine-state calibration (the trap)

All prior evidence numbers were measured in one evening window. Tonight,
after ~7 hours of continuous load (five `pnpm verify` runs, eight VS Code
indexes), the **committed baseline itself** re-measured at **298.9s**
(stage-1 286.2s, catalog 74.7s) vs 278.6s/266.9s/67.2s the prior evening —
a ~7% whole-machine drift concentrated in I/O buckets (`cas_file_fsync`
summed 9s→17s). Every campaign-2 comparison below is therefore against the
same-night control, not the prior-evening numbers. Rule for future
campaigns: **any regression/improvement verdict requires a same-window
control run of the committed baseline.**

| Run (all 2 analysis shards) | Ready | Catalog | provider_read | Seal | SQL txn | RSS peak |
|---|---:|---:|---:|---:|---:|---:|
| Baseline, prior evening | 278.6s | 67.2s | 40.5s | 45.6s | 70.1s | 4.84GB |
| Baseline, same-night control | 298.9s | 74.7s | 39.4s | 47.6s | — | — |
| C2 full (P1+P2+P3) | 329.6s | 70.7s | 44.4s | 61.5s | 83.2s | **6.04GB** |
| C2 corrected (reverts + boundary reuse) | 303.3–305.6s | 74.6–75.0s | 5.8–6.0s | 47.7–49.8s | — | 4.86GB |

## What was invalidated

1. **P1b (UTF-8 byte cache for `canonical_record`): reverted.** Predicted to
   cut the seal's ordered-digest encode; measured: +~1.2GB RSS (6.04GB peak,
   above the 5GB guard — disqualifying on its own) and it moved encode cost
   into `seal_finish` (2.4→14.4s) and the accumulator (execute_non_analyze
   23.7→36.5s) without reducing `seal_ordered_digests`. The earlier claim
   that ~40 of the 42.8s was "allocate/GC" was wrong in the part that
   matters: the canonical encode CPU itself dominates, and pre-paying it
   elsewhere just relocates the bill while retaining corpus-scale bytes.
2. **P2 (windowed checkpoint/assert bracketing, 512-row multi-row INSERT):
   reverted.** Removed ~48k of 72k commands as designed, but native
   `exec_ms` rose 28.5→37.1s and `chunk_idle` 16.6→22.1s; transaction wall
   70.1→83.2s. This re-confirms the repository's historical "multi-row
   INSERT benched neutral" finding at full scale — the per-command dispatch
   saving is real but smaller than SQLite's cost of evaluating 512-row
   `VALUES` upserts with per-row conflict predicates. The replay-semantics
   analysis (windowed `expected:N` preserves conflict detection; per-row
   attribution loss) remains valid and is recorded here for any future
   attempt.
3. **P3a first design (budget-owned prefetch with release-at-consumption):
   deadlocked on the real corpus** — a structural circular wait (the only
   thing that could free the byte budget was the fragment commit that was
   itself waiting on the budget-holding reads) plus a FIFO-starvation bug in
   the budget gate. Both were reproduced at fixture scale post-hoc and fixed
   (release-on-claim ownership; strict-FIFO gate). The deadlock regression
   test is permanent.
4. **The "~40s of `source_provider_read` is boundary stats" attribution was
   half-wrong.** Reusing the pass-1 boundary token did move ~33s out of that
   bucket (39.4→5.8s) — but catalog wall did not improve: the cost was
   overlapping other catalog I/O at concurrency 16 all along. Kept (it is
   strictly less syscall work, with `after_read`'s fresh re-inspection
   unchanged as the single authoritative proof), but it is not a wall-clock
   lever.
5. **The "~45s catalog cost is the graph pre-seed's UTF-8 decode+regex"
   attribution was wrong too.** A/B same-night: catalog 75.0s with the scan
   vs 74.6s without — the scan is free (the unattributed catalog cost exists
   in the baseline control as well and tracks machine I/O state). The
   pre-seed therefore ships **default ON** (`URDIRA_GRAPH_PRESEED=0` kill
   switch): it saves the worker's ~3.7s closure cache miss on from-zero
   scans (closure 4.4s→0.7s measured).

## What shipped from the incremental levers

- Streaming canonical digest sink (`encodeCanonicalInto`; byte-identical by
  fuzz test) and the packed-identity triple memo + static packed-ness flag
  (micro-wins, zero retention).
- Boundary-token reuse in `readStream` (pass-1 token as the "before" check;
  `reuse_existing` deliberately excluded — its entry check is the only
  verification on that path and must always see a live stat).
- Deadlock-hardened bounded read-ahead prefetch (64MiB live budget,
  strict-FIFO gate, release-on-claim; `URDIRA_CATALOG_HANDOFF_BYTES=0` kill
  switch) with the multi-fragment deadlock repro as a permanent test.
- Host-side import-graph pre-seed, default ON (construction-shared regex +
  resolution primitives; the worker cache-hits under the identical manifest
  key; equivalence suite incl. CRLF/BOM/NUL/chunk-boundary fixtures).
- Instrumentation: `fact_delta_accept` / `accept_native_stage` (real path) /
  `template_accumulator_accept` buckets; the previously-dead engine-loop
  bucket root-caused (the native-batch acceptance happens inside the
  plugin's `analyze`, not the engine loop).

## P4 verdict

Not flipped: RSS at 2 shards measured 4.86GB same-night (budget requires
≤4.3GB). `URDIRA_ANALYSIS_LARGE_SHARDS` default stays 1.

## P5 — index pack: implemented, safety proven live, at-scale gaps open

The index pack (docs/decisions/23-index-pack.md) shipped end-to-end:
`core:index_pack_export` / CLI `index-pack-export`, `workspace-add
--index-pack <path>` import (gzip + tagged NDJSON carrier, per-entry
digests, scratch-donor SQLite reusing the fork's bulkCopy/publish/verify/
rollback machinery unmodified), tamper suite, and a 1M-row perf regression
gate (keyset pagination replaced O(n²) OFFSET pagination: fixture export
95.3s → 3.0s; scratch inserts batched, 11x).

Live VS Code round-trip (17,675 files, ~1,002,942 identity rows, pack
405MB, manifest-digest verified):

- **Safety: proven twice at real scale.** A truncated pack was detected
  ("unexpected end of file"), rolled back — including the already-committed
  source layer — and the fallback full scan published normally. A complete
  pack that failed the final fast verify (below) did the same. The
  workspace never wedged and never served bad data. A daemon crash on a
  missing pack file (unhandled ReadStream error) was found live and fixed
  with the error now surfacing as a clean skip.
- **Open bug:** the complete pack's import passed copy+publish and the
  untrusted checks, then failed fast verify on exactly one anchor:
  "capability-state digest differs from the pack's declared donor anchor".
  The fixture round-trip (6/6 tests) does not reproduce it; the divergence
  is in the 12 real capability_state entries' round-trip encoding
  (ordering/JSON canonicalization suspected). Diagnosable offline: the
  donor data root and the pack both survive in
  ~/Proyectos/urdira-benchmark/c2-2026-08-24/.
- **Open perf gap:** at VS Code scale, export took 865s and import ~868s
  before the verify verdict — far from the 60-100s target. The fixture-
  validated fixes (keyset pagination, batched scratch inserts) were
  necessary but insufficient; the remaining cost is in the per-line
  JSON/gzip streaming of ~1M record bodies on the daemon main thread.
  Next levers: CBOR/binary row batches, worker-thread pack codec, and
  profiling the import's copy phase.

Import is strictly opt-in (`--index-pack` per add; `URDIRA_INDEX_PACK=0`
kill switch) and falls back to the full scan on any failure, so shipping
the machinery with these gaps documented is safe.

## Verification

`pnpm verify` green on the final tree (one intermittent
`phase-workspace-fork.test.ts` readiness-poll flake under full-suite
parallel load, 11/11 in isolation, pre-existing and now recorded as a
de-flake TODO). Determinism gates held throughout: canonical fuzz
equivalence, golden snapshot digests, accumulator-vs-one-shot equality,
memo-vs-recompute identity.
