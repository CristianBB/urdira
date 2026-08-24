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

### Extrapolation and the pending live validation

150k → 1M linear extrapolation: export ~48s, import ~67s — inside the
60-100s target, in fixture terms. The 865s→this-machine comparison is NOT
valid (different session, documented ~7% drift regime, 97%-full disk that
night, and larger real bodies). The live VS Code re-run (donor reindex →
export → import, with a same-window control) is still pending and is the
acceptance test for the target; it also revalidates the anchor fix, since
the surviving pack declares a pre-fix anchor.
