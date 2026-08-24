# Index pack: capability-state anchor fix + codec-path performance (2026-08-24)

Follow-up to the two open gaps documented in
`docs/evidence/2026-08-24-readiness-campaign-2-incremental.md` (P5).

## 1. Capability-state anchor bug: FIXED (separate commit)

Root cause diagnosed offline against the surviving 405MB VS Code pack:
`Snapshot.capability_state_digest` was computed without the
`ordered_set(SnapshotCapabilityStateEntry, core:capability_state_order@1)`
sort its own documented contract requires
(`docs/serialization/core-digest-field-contracts.md`). A staged donor
digests entries in stage-grouped emission order (verified byte-exact:
that order reproduces the pack's declared anchor), while every read-back
(`visibleCapabilityStateEntries`, `ORDER BY state_key` = per-entry hash)
yields a different order — so `fastPackVerify` (and, latently,
`fastForkVerify` for any staged donor) always failed. Fixed by sorting at
both digest sites in `publication-authority.ts`; regression test (a2) in
`tests/phase-index-pack.test.ts` fails on the pre-fix code and pins the
recipe itself against the pack's own rows.

## 2. Codec-path performance: profile first, then fix what was measured

### The 865s attribution was wrong

Campaign 2 recorded export 865s / import ~868s at VS Code scale and
attributed the cost to "per-line JSON/gzip streaming on the daemon main
thread". The existing 1M-row perf gate (test g) could not check that: it
pads only `identity_assignments` over ONE reused record, so the per-record
body path was never exercised at scale. A new gate (test g2) pads
`record_occurrences` itself with 150k distinct, digest-valid bodies (each
must survive `verifyCopiedRecordIntegrity`'s decode+digest recompute) plus
one identity per record, re-anchoring the donor snapshot's
`canonical_record_set_digest` after padding.

New timing buckets (engine `debug-timing.ts` shim,
`URDIRA_STORAGE_DEBUG_TIMING=1`) across export and import attributed the
150k-record baseline (v1 code, this machine, single run each):

| bucket | baseline | after | note |
| --- | --- | --- | --- |
| export total | 16.9s | **7.1s** | |
| export: records SQL pages | 13.3s | 4.9s | was 88ms/page: JOIN-per-page + worker structured-clone |
| export: identities SQL pages | 0.49s | 0.28s | always cheap — no JOINs, no BLOBs |
| export: JSON stringify | 0.24s | 0.25s | never the problem |
| export: gzip write | 1.44s | 0.74s | level 6 → level 1 |
| import total | 18.7s | **10.0s** | |
| import: untrusted verify | 11.6s | 3.9s | was paging at 1000 rows; CPU floor ~25µs/record |
| import: bulk copy | 3.7s | 2.9s | fork machinery, unmodified |
| import: scratch inserts | 0.8s | 0.8s | already batched |
| import: JSON parse | 0.23s | 0.22s | never the problem |

The dominant costs were (a) the records pagination query joining
`source_artifacts` twice per 1000-row page, (b) per-page
structured-clone/postMessage overhead through `SqliteWorkerAdapter` for
BLOB-bearing rows, and (c) small pages amplifying both. JSON/hex encode —
the presumed culprit — was ~3% of export wall time at this body-size
profile.

### What shipped

- **JOIN-free records pages**: the owner/span uri lookups are prefetched
  once (two workspace-bounded maps) and applied in JS.
- **Private read-only same-thread connection** for all export bulk reads
  (`DatabaseSync(filename, { readOnly: true })`, one deferred read
  transaction so the count pass and data pass see a single WAL snapshot).
  Removes the worker round-trip + clone entirely; measured floor is now
  node:sqlite row materialization itself (~33µs/row for 20-column
  BLOB-bearing rows vs ~2µs/row for identity rows).
- **`SQL_PAGE_ROWS` 1000 → 8000** (diminishing returns past 4000; also
  halves the import verify's own paging overhead, 11.6s → 4.3s before any
  other change).
- **gzip level 1** (2x compression CPU saved; a pack is transport, not an
  archive).
- **Daemon worker thread for export** (`index-pack-export-thread.ts` +
  `index-pack-export-worker-thread.ts`, one-shot lexical-thread pattern):
  required because the raw-connection reads are synchronous by design;
  `core:index_pack_export` no longer touches the runtime's event loop.
  Transport parity + in-worker error propagation covered by
  `tests/index-pack-export-thread.test.ts`.

### What was deliberately NOT built (gate on live numbers first)

- **Binary v2 framing (encodeCanonical frames, no hex)**: stringify+parse
  measured ~0.5s combined at 150k; hex only doubles pre-compression bytes
  and gzip is now 0.7s. Revisit only if live VS Code bodies (larger than
  the fixture's ~260B) move the codec share materially.
- **Import decode worker thread**: the import's synchronous main-thread
  bursts are the scratch inserts at ~2.5ms per 2000-row chunk — not an
  event-loop hazard; everything else already yields through the async
  adapter.
- **Sharded parallel `verifyCopiedRecordIntegrity`**: ~26s extrapolated at
  1M records single-threaded; within budget. It is the next lever if live
  import misses the target.

### Live VS Code validation (same day, after the fixes)

Fresh donor worktree (vscode @ 038b9225, 17,675 files), from-zero index
(324s ready, `URDIRA_ANALYSIS_LARGE_SHARDS=2`), then export, then
`workspace-add --index-pack` into a fresh data root + second worktree.
Artifacts: `~/Proyectos/urdira-benchmark/c3-2026-08-24/` (pack 440MB —
~9% larger than the level-6 c2 pack, the accepted level-1 trade). Row
counts byte-matched the c2 pack (1,002,942 records/identities).

- **Anchor fix validated live**: the import took the pack path (zero
  `analyze shard progress` lines), passed the fast verify — including the
  capability-state anchor that failed every c2 attempt — and went straight
  to `ready`/`current`.
- **Export: 865s → 89.7s (9.6x), target met.** Live buckets: records SQL
  pages 59.8s (real bodies cost ~6x the fixture's per-page floor), gzip
  12.0s, identities 8.3s, stringify 2.3s, row map 2.2s.
- **Import: ~868s → 647s to ready, target MISSED.** The costs the fixture
  under-predicted at real body sizes: `bulk_copy` **391.9s** (the fork's
  own machinery, unmodified by this work — fixture extrapolation said
  ~19s; now clearly the top import lever), untrusted `verify` 108.6s (the
  known sharding candidate), `source_provider_read` 170.8s (the target's
  own source cataloging — a cost every workspace-add pays, pack or not;
  overlaps the campaign-1 "double read" lever). The paths this change DID
  target stayed small exactly as measured: JSON parse 2.1s, scratch
  inserts 7.7s.

Extrapolation lesson recorded: the 150k fixture's ~260B bodies
under-predict real per-row costs ~6x for BLOB-bearing paths; the fixture
gate still guards regressions, but absolute targets need the live run.

Next import levers, in measured order: (1) `bulkCopyRecordsAndIdentities`/
`bulkCopyDependencies` internals at 1M-row scale (shared with local fork —
a fork of this workspace would pay the same), (2) sharded parallel
`verifyCopiedRecordIntegrity` (~108s → ~/cores), (3) the source-catalog
double-read (campaign-1 queue). Import remains strictly opt-in and
fallback-safe, so shipping with the export win and the correctness fix is
strictly better than before in every case.

## Import optimization round (same day): 647s → 280s, now faster than a scan

Levers (1) and (2) implemented and re-measured with real imports of the
same 440MB c3 pack (no donor rebuild — the pack is the reusable asset).

**Bulk copy: 391.9s → 60-74s (~6x).** Three standard bulk-load moves in
`bulkCopyRecordsAndIdentities` (`workspace-fork.ts`, shared with local
fork): (a) drop the secondary indexes on `record_occurrences`/
`identity_assignments` before the inserts and recreate them after, all
INSIDE the same transaction (SQLite DDL is transactional, so any failure
rolls the schema back with the rows; the DDL is captured verbatim from
`sqlite_master`, never hardcoded); (b) `ORDER BY` the big SELECTs by the
target PK prefix so the un-droppable PK autoindexes append instead of
splitting randomly; (c) one deliberate index on the scratch donor's
`record_occurrences(record_id)` after its bulk load, replacing the
per-statement ~1M-row automatic indexes the value_nodes/identities JOINs
were silently building.

**Sharded verify: 95.6s → 69.6s only (~1.4x) — parallelism hypothesis
REFUTED on this hardware.** The sharding itself is correct (8 contiguous
keyset ranges, 125,368/125,367 rows each, no gaps — regression-tested by
corrupting a mid-range row at (g2) scale and demanding detection), but
per-shard probes measured hard contention: one shard alone runs 125k rows
in 8.3s (66µs/row); at 2/4/8 concurrent shards the per-row cost degrades
to 103/195/360µs — aggregate throughput saturates at ~1.4x single-thread,
and the SAME saturation reproduces with separate OS processes, so it is
not a process-global SQLite mutex but a machine-level ceiling for this
read+decode+digest mix (allocation/memory-bound, not CPU-bound). Kept:
1.4x is still real, the fallback below 50k rows keeps small imports
worker-free, and the failure mode is fail-safe (a shard error throws →
skip+fallback, never a silently passed verify).

**Live import composition after this round** (`phase2-iterB.log`, clean
machine): total **280.2s** — `source_provider_read` 169.0s (60%; the
shared source-catalog cost, campaign-1's double-read lever),
`bulk_copy` 73.8s, `verify` 69.6s (overlaps SQL waits), scratch 8.0s,
parse 2.1s. Import now beats the 324s from-zero scan on the same machine;
the 60-100s target still stands as future work, and the highest-leverage
remaining ideas are the source-catalog double-read fix and moving the
per-record verify to STREAM time (during scratch build, overlapping the
source read entirely and rejecting a bad pack before any durable write —
a trust-boundary placement change that needs its own design pass).
