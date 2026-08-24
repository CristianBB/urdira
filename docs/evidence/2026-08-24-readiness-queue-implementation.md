# Readiness queue implementation — 2026-08-24 (afternoon session)

Executes the post-index-pack queue (see
`2026-08-24-index-pack-codec-performance.md` and
`2026-08-23-readiness-from-zero-optimization.md`): source-catalog
double-read, stream-time pack verify, seal digest offload, accept
pipelining, publish-window RSS. All numbers are same-window on the usual
machine (VS Code 17,675 files / ~1M records, Node 24.18.1,
`URDIRA_STORAGE_DEBUG_TIMING=1`). Same-window controls were re-measured at
session start because cross-session drift is ~7-17% (today's window ran
~17% slower than yesterday's evening window at baseline).

## Same-window results

| Measurement | Baseline (HEAD e6f0fc7) | After | Commit |
|---|---:|---:|---|
| Pack import (440MB reusable pack) | 334.8s | **193.6s** | f4995aa + 645c5ba |
| `source_provider_read` bucket (import) | 202.9s | 5.9s | f4995aa |
| `index_pack_import_verify` bucket | 75.6s | 6.1s | 645c5ba |
| From-zero scan, 2 shards | 332.0s | **262.9–272.6s** | 6c5e682 + (F3a) |
| `seal_ordered_digests` | 37.7s | 27.8–28.4s | 6c5e682 |
| `execute_non_analyze` | 24.6s | 0.3–0.6s | (F3a) |
| In-process RSS peak (sampler, 500ms) | 4.41GB | ~5.07GB (noisy, see below) | — |

## What shipped

1. **f4995aa — fork/import on the native catalog path.** `enumerateForkRoot`
   moved to `enumerateNativeBatches`; `commitForkSourceLayer` gained the
   scan's `read_stream` closure, so the CAS stream claims prefetched bytes
   instead of re-reading + re-hashing every file through legacy
   `provider.read`. New `DirectorySourceProvider.abortPrefetch()` returns
   the hand-off budget on every exit; also fixed the latent
   `runSourceOnlyWorkspaceScan` leak (prefetch started, never claimed).
2. **645c5ba — stream-time pack verify.** The untrusted per-record
   decode+digest runs during scratch-donor build on 1-2 batch workers,
   overlapped with the source-layer commit; corrupt packs are rejected
   BEFORE bulkCopy/publish. `fastPackVerify` keeps counts/anchors/ownership
   and skips the redundant target-side pass when the stream verified.
   Check extracted once into `index-pack-verify-core.ts`.
   `URDIRA_INDEX_PACK_STREAM_VERIFY=0` forces the old path.
3. **6c5e682 — seal digest offload + publish-window roots.** `sealAsync`
   hands the record-open and identity-assignment set digests to 2 worker
   threads (byte-identical incremental encode, acked batches, digests
   seeded into the frozen-array memo); `seal()` unchanged as the
   determinism gate; `URDIRA_SEAL_DIGEST_WORKERS=0` kill switch.
   `finish()` releases `identityRaw`/`acceptedDeltas` (post-finish
   `matchesAcceptedDeltas` throws); the session truncates
   `accepted_deltas` after seal (canonical_record strings 2x -> 1x roots).
4. **F3a — record-digest pipelining (this commit).** Optional
   `on_accepted_delta` analyze hook: batches of `canonical_record` strings
   go to a single small-heap (128MB cap) digest worker DURING
   `plugin_analyze`; only the digest strings are buffered (~70MB) and
   templates are assembled in the unchanged post-analysis pass
   (`acceptPrecomputed`). Fallback to plain `accept()` on any trouble.

## Attribution corrections discovered (important for future sessions)

- **`source_provider_read` is a concurrency-summed bucket, not wall.** The
  "169s double-read" in the queue was mostly an attribution artifact: the
  bucket sums per-observation times across 16-way read concurrency. Killing
  it (−197s of bucket) moved wall by ~27s. Real wins per phase: F1 −27.5s,
  F2 −113.7s (of which ~66-70s structural verify overlap; the rest of the
  bulk_copy delta was disk-pressure relief), F3 −26..36s attribution.
- **Building templates during analyze was an RSS trap.** The first F3a cut
  applied templates in worker-response continuations: −24s of
  execute_non_analyze but +0.5GB during analyze -> live mid-scan shard
  demotion (`rss_kib=4306848 > budget_kib=4300000`). Buffering only digests
  and assembling templates post-analysis kept the win (0.3-0.6s) without
  the demotion.
- **In-process RSS peaks are noisy run-to-run (±0.7GB).** Four
  2-shard runs peaked 4.41 / 5.13 / 5.36 / 5.07 GB with peaks mid-analyze,
  largely GC-timing variance. Consequence: the **2-shard default stays
  un-flipped** — the plan's flip criterion (two consecutive runs ≤4.2GB)
  is unreachable in today's terms; the mid-analyze peak, not the
  seal/publish window, is now the binding constraint. The in-product
  demotion guard works as designed (observed live, scan completed).

## Incident log

- First F2 measurement died on a full disk (1.3GiB free): bulk copy failed
  mid-import, **rollback executed cleanly live** (another real-world proof
  of the never-wedge path), the fallback full scan then OOM'd against the
  default Node heap in the measurement harness. Freed ~23GB (stale /tmp
  campaign data roots + leftover measurement data root) and re-ran.
  Measurement data roots now live under `~/Proyectos/urdira-benchmark/`
  and are deleted per run.

## Verification

`tsc --build` + `pnpm verify` green after every phase: 1693 (F1), 1697
(F2+F3b+F4), and the final run after F3a (see commit). New regression
tests: `abortPrefetch` budget-drain (phase7-providers), pack tamper with
stream verify off (b2) and in the last records line (b3)
(phase-index-pack), sealAsync byte-identity with real workers + kill
switch (3d), acceptPrecomputed worker-digest equivalence + mismatch
disqualification (3e) (phase9-materialization).

## Remaining levers (queue for a future session)

- Pack import 193.6s composition: bulk_copy ~56-87s (top; already 6x
  optimized — machine ceiling on wider parallelism proven), scratch+parse
  ~9s, source commit ~90s wall (I/O-bound; overlaps verify).
- `seal_ordered_digests` residual ~28s: the paced batch feed serializes
  clone + hash; the main thread cannot compute while feeding (single
  thread). Next ideas: cheaper transport for the element stream, or a
  fundamentally different encode-share (NOT heap-cached bytes — P1b).
- The official 8-cell campaign remains un-run (now four improvement rounds
  behind the committed campaign JSONs).
