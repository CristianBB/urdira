# Workspace footprint verification — 2026-09-17

## Scope

This front adds read-only per-workspace storage accounting through
`core:workspace_footprint` and `urdira workspace footprint [<workspace-id>]`.
It does not change indexing, publication, retention, garbage collection, or
query behavior.

## Accounting boundary

- Workspace-exclusive files are measured from the canonical footprint list:
  catalog SQLite files and siblings, structural store, lexical and semantic
  sidecars, scan sidecar, and writer locks.
- Structural bytes are subdivided into base segments, deltas, Merkle data,
  reader markers, manifests, and other structural files.
- Indexed source bytes are derived from artifact versions visible at the
  current source generation.
- Installation CAS objects are deduplicated within each workspace and reported
  separately as referenced, not exclusive. Their bytes are excluded from the
  exclusive total and exclusive amplification ratio.
- Filesystem measurement does not follow symbolic links and returns no private
  storage-root paths.
- The result is explicitly live/best-effort. No checkpoint, scan pause, or
  index mutation is performed to make the reading atomic.

## Verification

Focused verification completed:

```text
CI=true pnpm exec vitest run tests/workspace-footprint.test.ts tests/phase12-cli.test.ts tests/phase-daemon-admin-integration.test.ts -t "workspace footprint|Phase 12 closed CLI"
3 files passed; 16 tests passed; 11 unrelated tests skipped

CI=true pnpm exec vitest run tests/phase-daemon-admin-integration.test.ts -t "workspace footprint accounting"
1 file passed; 1 test passed; 11 skipped

pnpm typecheck
passed
```

The first combined `CI=true pnpm verify` run passed architecture,
maintainability, native build/check/tests, and lint, then encountered two
unrelated temporary-directory races during the parallel coverage suite
(`app-runtime.test.ts` and `phase7-indexing.test.ts`). Both failed cases passed
when rerun individually (one test each). Repeating the complete coverage stage
then produced:

```text
CI=true pnpm test:coverage
169 files passed; 2 skipped
2591 tests passed; 17 skipped
Statements 84.44%; branches 74.32%; functions 81.16%; lines 90.08%

pnpm typecheck && pnpm check:coverage-gate && pnpm check:publication
passed; critical branches 100%; semantic regions 100%; 1199 publication files checked
```

The live local probe
`urdira workspace footprint --json` returned an empty `workspaces` array for
the default local data root: no active indexes are currently registered there.
Two historical benchmark catalogs remain in the isolated benchmark data root,
but their catalogued workspace database paths no longer exist, so they are not
presented as current footprint measurements.

## Fresh n8n benchmark-corpus measurement

A fresh v4 index was generated from the n8n benchmark corpus
(`b3a34fcd81659f6e33b5857a8c68816f7e105320`, dirty working tree) with the
JavaScript/TypeScript plugin enabled and semantic indexing disabled. The
isolated retained data root is the benchmark fixture's
`footprint-n8n-2026-09-17` directory.
The workspace reached a complete, current/equivalent source and structural
frontier before measurement.

The measured workspace contains 20,148 indexed artifacts and 126,106,438
indexed source bytes (120.26 MiB). Its exclusive footprint is 2,511,111,079
logical bytes (2,394.78 MiB), an amplification of 19.91x, and 3,451,043,840
allocated bytes (3,291.17 MiB), or 27.37x the indexed source bytes. Referenced
CAS adds 125,729,640 logical bytes (119.91 MiB) when conservatively charged in
full to this workspace, producing a 20.91x logical upper bound. CAS is not part
of the exclusive total because it is installation-shared and deduplicated.

The exclusive logical-byte breakdown is:

| Layer | Logical bytes | MiB | Share |
| --- | ---: | ---: | ---: |
| Structural | 1,971,531,983 | 1,880.20 | 78.51% |
| Lexical | 442,151,584 | 421.67 | 17.61% |
| Catalog | 97,427,512 | 92.91 | 3.88% |
| Semantic | 0 | 0 | 0% |
| Scan sidecar and locks | 0 | 0 | 0% |

Within the structural layer, the base is 1,828,364,083 logical bytes
(1,743.66 MiB; 72.81% of the complete exclusive footprint) and Merkle files
are 143,165,824 bytes. There were no retained deltas. The three largest base
files are `records.body` at 887,877,322 bytes, `records.digests` at 353,512,704
bytes, and `records.meta` at 212,107,648 bytes. Together they account for
57.89% of the complete exclusive logical footprint. The base consumes
2,749,833,216 allocated bytes despite containing 1,828,364,083 logical bytes;
that logical-to-allocated gap is material and should be separated from record
representation overhead in the optimization decision.

The base header reports 2,209,454 structural records, or 109.66 records per
indexed artifact. Each record currently pays 288 fixed bytes across
`records.keys` (32), `records.meta` (96), and `records.digests` (160), before
its variable body and secondary indexes. The body averages 401.85 bytes per
record. This identifies per-record representation and record multiplicity as
the first optimization front; workspace registry, CAS, and semantic storage
cannot explain the observed amplification.

For context, the complete checkout occupies about 675.31 MiB allocated,
including about 490.84 MiB for `.git`; the non-`.git` working tree is therefore
about 184.47 MiB allocated. The 120.26 MiB indexed-source denominator is the
more precise comparison because it excludes unindexed repository material.
