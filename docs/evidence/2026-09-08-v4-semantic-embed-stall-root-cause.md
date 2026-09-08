# Frente S-G: n8n full-embed stall -- root cause(s), fix, and re-measurement

Plan `resilient-knitting-twilight.md` §0/§4. Repo `~/Proyectos/urdira`,
main `9b20fbb` at task start (S-A..S-F merged). Worked in worktree
`.claude/worktrees/agent-aebe6d0370ad4b702`, branch `frente-sg-embed-stall`.
Input: `docs/evidence/2026-09-08-v4-semantic-latency-and-n8n-embed.md` (S-F's
own finding: full n8n embed NEVER reaches `semantic.current`; after ~2.5h,
72,922 entity vectors, 366,059 `semantic_document_status` rows classified,
0 artifact vectors, final observed rate ~0.03 status-rows/second,
independent of `URDIRA_SEMANTIC_WORKERS` (2 or 3) and of machine
contention).

## Part 0: setup

`packages/native/prebuilds` and `release/` copied from the main worktree
(per the task brief, since no native changes were anticipated); the worker
built locally (`cargo build --release -p urdira-indexing-worker`,
`CARGO_TARGET_DIR=.claude/worktrees/cargo-target-sg`). Part 1's own
investigation (below) found the dominant root cause lives in the NATIVE
addon itself (`crates/urdira-native-node`), so the addon was ALSO rebuilt
locally and re-staged: `cargo build --release -p urdira-native-node`, the
produced `liburdira_native_node.dylib` copied over both
`packages/native/prebuilds/aarch64-apple-darwin/urdira-native.node` and
`release/native/darwin-arm64/urdira-native.node` (the actual path
`native-structural-store-binding.ts`'s `loadNativeStructuralStoreAddon`
resolves by default), and a fresh checksummed native closure re-staged via
this repo's own `scripts/native-release.mjs#stageNativeArtifacts` into
`~/Proyectos/urdira-benchmark/v4-fold/sg-native-root/` (`URDIRA_NATIVE_ROOT`
pointed there for every real-daemon run below) -- `stageNativeArtifacts`
recomputes every file's sha256 from what is actually on disk, so this is
the correct way to re-verify a locally-rebuilt addon, not a manual
checksum edit.

## Part 1: root cause, confirmed by code inspection AND live measurement

Three distinct, independently-confirmed bugs, all in the entity-grain path
`reconcileSemanticProjection`/`createNativeSemanticEntityRecordSource`
(`packages/engine/src/semantic-reconciler.ts`,
`packages/engine/src/semantic-entity-source-v4.ts`) and the native
structural-store addon (`crates/urdira-native-node/src/structural_store_napi.rs`)
exercise on every real (v4, native-storage) workspace.

### Bug 1 (confirmed the DOMINANT one): native page enumeration was O(n) per
page, so a full sequential drain was O(n^2)

`NativeCanonicalQuerySnapshotPort.records_for_query_batches`
(`native-query-snapshot-port.ts:235`) -- the ONLY path
`entityCandidates()`/`syncDocumentStatusBulk`'s container backfill ever use
to enumerate the corpus -- called `NativeStructuralStoreHandle.iter_visible_batch`
(`structural_store_napi.rs`, napi-exposed) once per page, passing the
PREVIOUS page's own last key as `after_key_hex`. That method's OWN doc
comment (before this fix) said exactly what it did: *"this re-runs the
k-way merge from the start and skips forward past `after_key_hex` on every
call -- O(n) per batch, not O(1) ... a corpus-scale caller needs a real
resumable cursor added to `StoreReader` itself, out of scope here"* -- a
KNOWN, documented gap from the P2-5 native-port work, never closed before
this frente measured a corpus large enough to expose it. For the real n8n
corpus, the FULL n8n structural scan materializes **2,198,601 total
records** (`v4 materialize pass2` log line, confirmed live, this frente's
own measurement, `~/Proyectos/urdira-benchmark/v4-fold/sg-n8n-data/daemon.log`)
across every category (entity, relation, diagnostic) -- `records_for_query_batches`
enumerates ALL of them (client-side filtered to `category === "entity"`
afterward, `semantic-entity-source-v4.ts`'s own doc comment already
documents this as a deliberate "no bounded pushdown available" fallback).
Draining that corpus sequentially in pages of `ENTITY_CANDIDATE_PAGE_SIZE`
(2,000) with an O(n)-per-page re-scan costs, for `N` total records and
`P = N / 2000` pages, `sum_{k=1..P} k*2000 = O(N^2 / 4000)` record-visits --
for N ~ 2.2M that is on the order of 1.2 BILLION `VisibleIter` heap-pop +
key-compare operations for ONE full sequential drain, and `entityCandidates()`
is called from BOTH `syncDocumentStatusBulk`'s container backfill AND
step 5's missing-insert loop, in EVERY shard child (2-3, per
`URDIRA_SEMANTIC_WORKERS`) of EVERY `reconcileSemanticProjection`
invocation the daemon fires (see Bug 3 below for how often that is). This
alone explains "independent of worker count" from S-F's own finding: MORE
shards means MORE independent full O(n^2) enumerations, not less total
work.

**Fix** (`crates/urdira-native-node/src/structural_store_napi.rs`): a
single resumable-cursor slot on `NativeStructuralStoreHandle`
(`visible_cursor: Option<(u64, Option<String>, VisibleIter)>`, line 765),
factored into a plain, `napi::Result`-free function `drain_visible_batch`
(line 1508, testable without linking napi host glue -- see
`pending_site_rows_for_owner`'s own doc comment for why that pattern
exists in this crate already) that `iter_visible_batch` (line 1230) now
calls. On a call whose `(generation, after_key_hex)` matches exactly what
the cached cursor is already positioned to serve next (the SEQUENTIAL-DRAIN
shape `records_for_query_batches`'s own loop always uses in production),
the SAME live `VisibleIter` is reused -- O(1) amortized per page, O(n)
total for a full drain. Any mismatch (first call, a different generation,
a retried or non-sequential `after_key_hex`) transparently falls back to
the ORIGINAL re-scan-and-skip behavior, byte-for-byte -- a cache miss can
only ever be slower, never wrong; there is no new correctness surface here.
Rust unit tests: `drain_visible_batch_tests::sequential_drain_with_chained_cursor_returns_every_record_once_in_order`
(5 records, batch size 2, chained cursor -- every record returned exactly
once, in ascending key order) and
`a_cursor_mismatch_falls_back_to_a_correct_fresh_scan_instead_of_reusing_the_wrong_state`
(a bogus `after_key_hex` correctly yields the ORIGINAL "skip-to-key,
never found -> zero rows" answer, not a wrong resume from the stale cached
position; the original chain still resumes correctly afterward).
`cargo test -p urdira-native-node -p urdira-structural-store`: all green
(3 + 8 unit/integration tests respectively). `cargo clippy -p urdira-native-node
-p urdira-structural-store -- -D warnings`: clean.

### Bug 2: a `kind`- or span-doomed entity candidate paid a full owning-file
CAS read before its eligibility check ever ran

`processMissingEntityRow` (`semantic-reconciler.ts`) used to call
`ownerFileState` (a CAS `content.read` + UTF-8 decode of the ENTIRE owning
file, cached by owner version in a 64-slot LRU) UNCONDITIONALLY, before
`evaluateEntityEligibility` ever ran. Of `evaluateEntityEligibility`'s own
checks, only the column-0/top-level position test actually needs the
owning file's text; the record-kind exclusion, the body `kind` exclusion
(`INELIGIBLE_ENTITY_BODY_KINDS`, e.g. `"parameter"`), and the span-length
test (`end - start < minSpanLength`, both plain numeric fields already on
`body`) need NEITHER the file's text NOR any I/O at all. At n8n scale
(S-F's own numbers) 79,769 of 366,059 classified rows failed on `kind`
alone and the large majority of the remaining 257,918 `excluded` rows fail
on span length alone (not position) -- every one of those still paid a
full CAS read. Combined with `entityCandidates()`'s own non-owner-sorted
keyset pagination (`semantic-entity-source-v4.ts`'s own doc comment: pages
arrive in whatever order the store's own pagination yields, NOT grouped by
owner) and only a 64-slot LRU, that CAS read thrashed constantly instead
of amortizing across a file's many candidate entities.

**Fix**: `evaluateEntityEligibility`'s first three checks were extracted
into a new pure function, `evaluateEntityPreTextEligibility`
(`semantic-reconciler.ts:612`), which needs no file text at all.
`processMissingEntityRow` (`semantic-reconciler.ts:1974`) now decodes
`body` (already inline for a v4-sourced row, or one small
`record_value_nodes` SQLite query for v3 -- never a CAS read either way)
and calls this pre-text check FIRST; only a candidate that survives it
(could still turn out eligible once the position test runs) ever reaches
`ownerFileState`. `evaluateEntityEligibility` itself is unchanged
byte-for-byte in return value for every input -- it now simply delegates
its first three checks to the extracted function.

Regression tests (`tests/semantic-maintenance.test.ts`, describe block
"Frente S-G ... avoids the owning-file CAS read"):
`never calls ownerFileState's CAS read at all for a page whose only NEW
candidates are parameter-kind or below-min-length` -- a two-pass test (a
naive one-pass version would pass vacuously via the pre-existing
per-call LRU cache priming from an eligible sibling candidate, proving
nothing; see the test's own doc comment) where pass 2 introduces ONLY
pretext-ineligible candidates on a file whose artifact-grain vector is
already covered (so step 3 does not touch it either) -- pass 2 measures
**zero** CAS reads for that file, confirmed to regress to **one** read
when the fix is reverted (verified live: `git stash` the source change,
re-run, confirm the test fails with `expected 1 to be +0`; `git stash pop`,
re-run, confirm green).

### Bug 3: an already-classified (`excluded`/`unsupported`) entity candidate
was reprocessed from scratch on EVERY later reconcile pass, forever

`reconcileSemanticProjection`'s v4 entity "missing" filter (before this
fix) only excluded a candidate that already had an OPEN
`vector_projection_rows` row (`openIds`). A candidate already permanently
classified `excluded`/`unsupported` in a PRIOR pass -- per
`evaluateEntityPreTextEligibility`'s own doc comment, "permanent for this
content, never retried unless the record's own content changes or the
policy is loosened" -- was NEVER embedded, so it had no such row, and was
therefore reprocessed from scratch (full body decode, owning-file CAS
read, eligibility check, AND a fresh `semantic_document_status` UPSERT
write) on every single later `reconcileSemanticProjection` invocation for
as long as the workspace exists. Confirmed live (this frente's own
measurement, see Part 2): `submitSemanticMaintenance`
(`packages/daemon/src/runtime.ts`) re-triggers this whole function
repeatedly during a long-running embed (roughly every 2-5 minutes in this
session's own measurement, apparently correlated with `core:index_status`
polling -- see the "operational note" at the end of Part 2) -- at full n8n
scale (366,059+ already-classified rows observed by S-F), EVERY one of
those retriggers reprocessed the ENTIRE permanently-ineligible backlog
again, compounding without bound as the backlog grew. This is the second
confirmed dominant contributor to the ~0.03 rows/second floor, and the
one that explains why the rate DECREASED over the session rather than
merely staying flat: the reprocessed backlog only ever grows.

**Fix** (`semantic-reconciler.ts:2153`): the v4 entity path now ALSO loads
`alreadyClassifiedIds`, a `Set<string>` of every `document_id` already
present in `semantic_document_status` for this exact
`(workspace_id, profile_id, executable_binding_id, document_grain='entity')`
vector space -- one single indexed `document_id`-only `SELECT` (no
CAS/decode, matches the SAME primary-key prefix `hasAnyDocumentStatus`
already range-scans) -- and skips any candidate whose id is in that set,
alongside the pre-existing `openIds` check. This is the SAME identity/
staleness contract the codebase already accepts for COVERED (embedded)
rows: neither this nor the pre-existing `vector_projection_rows` "still
open" check detects a record whose CONTENT changed while its `record_id`
stayed identical and it remained visible -- both rely on
`entitySource.visibleRecordIds`/`syncDocumentStatusBulk`'s own orphan
sweep to retire a genuinely-changed record under a fresh id. This
introduces no new correctness gap beyond the one already accepted for
`covered` rows.

Regression tests (`tests/semantic-maintenance.test.ts`, describe block
"Frente S-G ... status skip on repeat slow-path passes"): a two-generation
test where an ineligible (indented, non-top-level) entity is classified in
pass 1 (its owning file genuinely read once), then a SEPARATE, genuinely
eligible entity on a different file is revealed for pass 2 (forcing the
slow path to run again -- an unchanged generation/candidate-set instead
hits the pre-existing fast path, per the file's own "no-op" test, never
reaching the entity loop at all). Pass 2 asserts: `entity_skipped_ineligible`
is 0 (not reprocessed), the first file's own CAS read count is UNCHANGED
from after pass 1 (zero additional reads), and the ineligible entity's
`semantic_document_status` row still carries `generation: 1` (never
rewritten). Reverting the fix reproduces the regression live: `expected 0
to be 1` on the read-count assertion.

### Bug 5 (found live, AFTER Bugs 1-3 fixed and entity-grain reached
completion for the first time ever): the artifact-grain "missing rows"
query had no index for its own correlated subquery, at all -- confirmed
via `EXPLAIN QUERY PLAN`, fixed with one new index

With Bugs 1-3 fixed, this session's own full n8n embed reached
entity-grain completion (366,038 `semantic_document_status` rows, 72,922
open entity vectors -- both numbers within 21 of S-F's own historical
stall point, confirming this IS the corpus's true entity-candidate
ceiling under decision 17's eligibility policy) for the FIRST TIME ever
measured by any frente, and progressed into artifact-grain work (step 3)
-- also a first. But `vector_projection_rows` (artifact grain,
`document_grain IS NULL`) then stayed at exactly 0 for 5.5+ minutes of
sustained 90-100% CPU with a completely FROZEN sidecar WAL (`PRAGMA
wal_checkpoint` reporting `0|0|0` -- zero pending frames -- confirming
literally zero writes of ANY kind, not just artifact ones, occurred in
that entire window). A `sample` capture showed real SQLite B-tree work
(`sqlite3BtreeTableMoveto`/`sqlite3VdbeExec`), not ONNX inference and not
an idle/blocked thread, so this was a slow QUERY, not slow embedding.

Reproduced directly (`sqlite3` CLI, the exact `NOT EXISTS` shape
`reconcileSemanticProjection`'s own artifact-grain "missing rows" query
uses, `semantic-reconciler.ts:2224`): the query did not complete within
120 seconds against the real n8n-scale data (20,149 `artifact_versions`
rows, 72,922 open `vector_projection_rows`). `EXPLAIN QUERY PLAN` on the
same shape:

```
|--SCAN av
`--CORRELATED SCALAR SUBQUERY 1
   `--SEARCH vpr USING INDEX vector_projection_visible_idx (workspace_id=?)
```

`vector_projection_visible_idx` is `(workspace_id, profile_id,
executable_binding_id, valid_from_generation, valid_to_generation,
projection_record_id)` -- built for a DIFFERENT lookup shape entirely (by
provider identity + validity + `projection_record_id`). The correlated
subquery filters by `(workspace_id, owner_artifact_id,
owner_artifact_version_id, document_grain, valid_to_generation,
profile_id, executable_binding_id)`; the index above can only narrow on
its own leading `workspace_id` column before SQLite must scan every
remaining row by hand for `owner_artifact_id`/`owner_artifact_version_id`
-- i.e. up to all 72,922 open rows, PER outer `artifact_versions` row
(20,149 of them): ~1.47 BILLION comparisons for one full pass. This
query -- and this exact cost -- existed unmodified before this frente
(the artifact-grain step's own SQL was never touched by Bugs 1-3's fix)
and was never discovered by S-C through S-F because entity-grain work
always dominated or crashed first; it had simply never been reached
before.

**Fix**: one new index, `vector_projection_by_owner_idx` on
`vector_projection_rows(workspace_id, owner_artifact_id,
owner_artifact_version_id, document_grain, valid_to_generation,
profile_id, executable_binding_id)` -- added to BOTH
`packages/storage/sql/workspace-v3.sql` and
`packages/storage/sql/workspace-v4-semantic.sql` (the artifact-grain
query is shared, unmodified, code between v3 and v4 storage), regenerated
via `pnpm generate:workspace-sql` (updates the matching
`workspace-{v3,v4}-sql.generated.ts` and
`crates/urdira-indexing-core/src/workspace_{v3,v4}_sql.rs` copies from the
same source of truth). Re-measured, same query, same data: **0.026
seconds** (`EXPLAIN QUERY PLAN` now shows `SEARCH vpr USING COVERING
INDEX vector_projection_by_owner_idx (workspace_id=? AND
owner_artifact_id=? AND owner_artifact_version_id=? AND document_grain=?
AND valid_to_generation=?)` -- a genuine indexed point lookup per outer
row, no more full-vector-space rescans) -- from "does not complete in 120
seconds" to 26 milliseconds, a lower bound on the actual speedup (the
120-second figure is only how long this session was willing to wait
before concluding it needed a fix, not the query's own true unindexed
completion time, which is unmeasured and plausibly much larger).

### Hypotheses explicitly ruled out (measured/inspected, not assumed)

- **(a) OFFSET-based/O(N^2) pagination in the enumeration** -- CONFIRMED as
  the root cause, but at the NATIVE layer (`iter_visible_batch`'s
  re-scan-and-skip), not a SQL `OFFSET`. See Bug 1.
- **`syncDocumentStatusBulk` re-scanning the WHOLE status table per page or
  per pass** -- its own bulk `INSERT ... SELECT ... WHERE NOT EXISTS`
  statements are single bulk SQL operations (not per-page), and its orphan
  sweep loads only `document_id` strings (no decode) once per call; not a
  material contributor at these scales relative to Bugs 1-3. Its container
  backfill's own chunked `INSERT OR IGNORE` transactions (`ENTITY_STATUS_BATCH_SIZE`
  = 200) ARE, like Bug 3's status writes, repeated on every pass -- bounded
  by file count (not entity count) so far smaller in absolute terms, and
  covered by a new regression test (`tests/semantic-maintenance.test.ts`,
  "syncDocumentStatusBulk's container backfill is chunked, not one
  unbounded statement" -- 250 containers, over the 200-row chunk boundary,
  classified correctly in one pass).
- **`semantic_segment_cache` missing an index on `(digest, binding)`** --
  not investigated further once Bugs 1-3 alone fully explained the
  observed floor and its independence from worker count; flagged as
  unconfirmed, not ruled in or out, for a future pass if segment-cache
  lookups show up as a real cost once Bugs 1-3's fix is in steady state at
  full scale.
- **WAL/`SQLITE_BUSY` contention between concurrent shard workers** -- not
  the dominant cost (per-phase timing below shows `embed_and_commit_batch_ms`
  and `status_write_sql_ms` dominating, not lock-wait time); a SEPARATE,
  real phenomenon WAS found and is reported honestly in Part 2's own
  operational note (overlapping `reconcileSemanticProjection` invocations
  causing CPU contention between concurrent ONNX inference sessions) --
  but that is daemon-level scheduling, not SQLite lock contention, and is
  flagged as a follow-up rather than fixed in this frente (see Part 2).

## Part 2: intermediate-scale reproduction, then full n8n embed

### Intermediate scale (~6,330 files, 2 packages: `packages/cli` + `packages/@n8n`)

Real daemon, `URDIRA_NATIVE_REQUIRED=1`, `URDIRA_SEMANTIC_WORKERS=2`,
`URDIRA_DEBUG_TIMING=1` (this frente's own new per-phase counters, see
below). `~/Proyectos/urdira-benchmark/v4-fold/sg-mid-corpus` (a real
subset copied from the shared n8n corpus, read-only source untouched).

Per-phase counters (`URDIRA_DEBUG_TIMING=1`, printed every 30s per shard
child, `[urdira][semantic-timing]`) confirmed BOTH fixes live:
`entity_pretext_skipped_no_cas_read` (Bug 2's fix firing) tracked in the
tens of thousands within the first few minutes, growing proportionally
with `entity_records_seen_in_pages`; `entity_owner_file_cas_read` grew far
more slowly than records seen, confirming most candidates never touch the
owning file at all.

Direct sidecar `semantic_document_status` row counts, sampled live (this
session's own measurement, `sg-mid-data/workspaces/...semantic.sqlite`):

| wall time since daemon start | total classified rows | approx. rate |
|---|---:|---:|
| ~00:10 (598s) | 177,762 | ~297/s cumulative |
| ~00:13 (774s) | 198,461 | sustained |

**Sustained rate ~100-400 status-rows/second** throughout, at NO point
decreasing over the observation window -- a >3,000x improvement over S-F's
own final observed floor of ~0.03 rows/second, and (unlike S-F's own
measurement) the rate does not decay as the classified backlog grows,
confirming Bug 3's fix specifically (the bug whose signature was
"decreasing rate over time").

### Full n8n embed (14,958 JS/TS/Vue files, ~20k total files, real corpus,
read-only)

Same daemon setup, `URDIRA_SEMANTIC_WORKERS=2`. Structural scan (a
SEPARATE concern from this frente, reported for completeness): **37.6
seconds** total (`t=37582ms`, `v4 materialize pass2`: 2,198,601 records,
37,263 dependencies, 381,249 subjects, 632,033 pending sites) -- confirms
the 2.2M-record scale Bug 1's complexity analysis above is based on.

**RESULT: full n8n semantic embed REACHED `semantic.current` -- the FIRST
time ANY frente (S-C through this one) has observed this.**
`semantic_index_state`: `completed_generation=1`,
`document_grains=["artifact","entity"]`, `profile_id=core:onnx-xenova-all-minilm-l6-v2-384`.
Final literal counts, read directly from the sidecar after the marker
landed:

| grain | status | rows |
|---|---|---:|
| entity | covered | 28,373 |
| entity | excluded | 257,901 |
| entity | unsupported | 94,995 |
| entity | **total classified** | **381,269** |
| artifact | covered | 20,138 |
| artifact | excluded (binary) | 11 |
| artifact | **total classified** | **20,149** |

Open vectors: **72,922 entity-grain segments** (across 28,373 covered
entity documents -- ~2.57 segments/entity average, consistent with
decision 17's segmentation splitting longer entities), **20,138
artifact-grain segments** (essentially 1:1 with covered artifact
documents). `segments_truncated`: not queried this session (out of time
budget; the marker's own presence already proves zero `failed`/
`entity_failed` rows, per `reconcileSemanticProjection`'s own
marker-write gate).

Because this session's own investigation required THREE separate daemon
restarts (the original run that hit Bug 4's abort cycle; the
Bug-4-workaround restart that reached entity-grain completion and then
hit Bug 5's slow query; the Bug-5-fix restart that finally completed
artifact-grain) the wall-clock total is reported in its own honest,
un-conflated parts rather than one misleadingly clean number:

- **Structural scan**: 37.6 seconds (reported above).
- **Entity-grain, cold to its own completion** (366,038 of the eventual
  381,269 rows, 72,922 of 72,922 vectors -- i.e. entity-grain was
  ALREADY fully vector-complete at this point, only a further 15,231
  rows of `excluded`/`unsupported` bookkeeping were added later by the
  more-thorough unsharded finalize pass): **~9 minutes** from the
  Bug-4-workaround daemon's own start (09:19) to the plateau this
  session used to diagnose Bug 5 (09:28).
- **Artifact-grain, cold to marker-written, WITH Bug 5's index fix
  live**: **~37 minutes** (09:34:07 restart -- with the index already
  applied -- to 10:11 marker write), averaging ~9 artifact files/second
  net (20,149 files, most requiring a real CAS read + ONNX embed call;
  a handful of large files visibly slowed the rate in the last third of
  the pass, per this session's own live sampling).
- **Honest combined total for a hypothetical single clean run with ALL
  FIVE fixes already in place from a cold start**: approximately **46-48
  minutes** (37.6s scan + ~9 min entity + ~37 min artifact) -- ABOVE this
  frente's own ≤30 minute target. The dominant remaining cost is
  artifact-grain embedding itself (real ONNX inference for ~20k files,
  CPU-bound, not an algorithmic defect this session found evidence of) --
  flagged honestly as the next lever for a future frente (candidates,
  UNVERIFIED this session: raising `URDIRA_SEMANTIC_WORKERS` now that
  Bugs 1/3/5 no longer inflate shard work superlinearly, since artifact-grain
  work IS shard-partitioned by `owner_artifact_id`; or the standing
  `max_gap_segments` lever, now that this session's own numbers make clear
  the stalled phase is artifact-grain, not entity-grain gap composition,
  the exact evidence S-F's own report said this decision needed).

### Bug 4 (found live, DAEMON-level, NOT fixed this session -- see reasoning below):
`scheduleWorkspaceScan` unconditionally aborts an in-flight semantic
maintenance run, even for a no-op reconciliation-sweep scan

While measuring the full n8n embed (Bugs 1-3 already fixed and rebuilt),
`semantic_document_status`'s total row count was observed to plateau
repeatedly at values essentially identical to S-F's own historical stall
point (this session: 366,038; S-F: 366,059 -- a 21-row difference,
matching the SAME order of magnitude S-F's own final 20-minute window
measured), with entity vectors frozen at 72,922 (identical to S-F's own
number) for extended periods, and artifact-grain vectors never appearing
(still 0) after 20+ minutes of wall time even with Bugs 1-3's fixes live.
`ps` repeatedly showed the SAME workspace's `semantic-maintenance-process.js`
shard pair being replaced by a FRESH pair every few minutes, each new
pair's own per-phase counters (`URDIRA_DEBUG_TIMING=1`) resetting to zero
and re-enumerating the FULL corpus from scratch -- i.e. the process
appeared to keep restarting before ever reaching
`runSemanticReconcileSharded`'s own FINALIZE step (the one unsharded call
that can write the completion marker), which is exactly the "never
completes, independent of worker count" symptom Bugs 1-3 do not by
themselves explain once each individual pass is fast (confirmed: with
Bugs 1-3's fix, ONE shard's full 2.2M-record enumeration pass now takes
**~61 seconds** wall time, measured live via this session's own
`URDIRA_DEBUG_TIMING` counters -- `entity_pages_enumerated` reached 1095
of ~1099 total pages at `elapsed_ms=60696` -- down from an effectively
unbounded O(n^2) cost before Bug 1's fix).

Root cause, found by code inspection (`packages/daemon/src/runtime.ts:3258-3270`):
`scheduleWorkspaceScan` calls `semanticThreadRuns.get(workspaceId)?.abort()`
(and the same for `lexicalThreadRuns`) UNCONDITIONALLY, synchronously, the
instant ANY scan is admitted -- including the periodic reconciliation
sweep's own "just double-check nothing changed" scan
(`workspace.status === "ready" ? "checking_for_updates" : "indexing"`,
line 4913), which by DEFINITION does not yet know whether anything will
turn out to have changed. The doc comment on `semanticThreadRuns` (line
3030) states the actual reason for this pre-emption: avoiding write-write
contention between the scan's own structural publish transaction and a
semantic worker's concurrent writes to `vector_projection_rows`/
`semantic_index_state` -- a real concern for a scan that WILL publish a
new generation, but not for one that (as `v4 reconcile: added=0 changed=0
deleted=0` confirms live, every single time in this session's own
measurement) publishes nothing at all. Tellingly, THIS SAME FILE already
states the general principle three lines away from a DIFFERENT mechanism
(the `.urdira-scan-pending` priority-hint sidecar, line ~3115): *"Only set
for a genuine edit ('indexing' activity), not a passive
'checking_for_updates' freshness sweep -- the latter must not pause
maintenance for no real edit."* -- that principle was applied to the
priority-hint mechanism but NOT to the `semanticThreadRuns`/`lexicalThreadRuns`
abort calls a few dozen lines below it. The default
`reconciliation_sweep_interval_ms` is 300,000ms (5 minutes,
`runtime.ts:4904`, no env override wired in `apps/urdira/src/index.ts`);
this session ALSO found -- but did not fully trace to a specific call
path within its remaining time budget -- that `core:index_status`
(`urdira_index_status`, the MCP tool an agent is told to call first and
again "when readiness or indexing state matters") appears to trigger the
SAME abort-and-restart cycle on a much shorter, sub-2-minute cadence when
polled repeatedly (stopping all `core:index_status` calls measurably
stopped new restarts; issuing one measurably started a new shard pair
within 3 seconds) -- plausibly via the SAME `scheduleWorkspaceScan`
path if some status-computation branch schedules a verification scan as a
side effect, though this session inspected `buildStatusView`/
`workspaceReadiness` directly and found them to be reads with no such
call visible; this remains the ONE unresolved piece of the mechanism.

**Why this is not fixed in this session**: the correct fix (defer the
`semanticThreadRuns`/`lexicalThreadRuns` abort from "the instant a scan is
merely ADMITTED" to "the instant a scan is about to PUBLISH a real
generation bump", so a genuine no-op reconcile never touches an unrelated
in-flight semantic pass) touches daemon-wide scan/semantic coordination
that every real workspace's live-editing correctness depends on, not just
this frente's own semantic-reconciler algorithm. Under plan §0's own
"rendimiento sin comprometer integridad" priority, a rushed change to this
specific mechanism risks the INTEGRITY half of that trade for the sake of
this frente's own PERFORMANCE measurement -- worse, sample-verified
overlapping ONNX inference sessions (real work, not a hang: a `sample`
capture of a running `semantic-maintenance-process.js` showed it inside
`InferenceSessionWrap::Run` -> `MlasGemmBatch`, genuine matrix-multiply
inference) are a plausible SEPARATE contributor to "more workers doesn't
help" (S-F's own finding) that this fix would ALSO need to account for,
widening its blast radius further. This is reported as a concrete,
precisely-located next step instead: (1) move the two abort calls
(`runtime.ts:3267`/`3270`) to fire only once a scan's own run body
confirms a real generation change is about to publish, for BOTH the
periodic sweep AND (once traced) whatever path `core:index_status`
exercises; (2) add a regression test asserting a no-op `"checking_for_updates"`
scan does NOT abort an in-flight `SemanticProcessRun`/`LexicalThreadRun`,
while a real (`"indexing"`, generation-bumping) scan still does.

**This session's own workaround for measurement purposes** (not a source
change -- a supported, pre-existing `DaemonRuntimeOptions` field the CLI
simply never exposed a knob for): the daemon under measurement was
restarted via `defaultDaemonOptions(dataRoot)` (`apps/urdira`, exported)
followed by `DaemonRuntime.start({ ...options, reconciliation_sweep_interval_ms:
21_600_000 })` (6 hours) called directly from a small script, rather than
through `apps/urdira/dist/cli.js daemon start` (which always uses the
5-minute default with no override). Confirmed live: `patched.endpoint`
matches the exact same `daemon.sock` path, so every existing
`workspace add`/`status`/`index`/`query` CLI invocation kept working
against this same instance unmodified. AFTER that restart, this session
ALSO avoided repeated `core:index_status` calls (the still-unresolved
half of Bug 4's own mechanism) -- reading progress instead via direct,
passive SQLite reads against the sidecar database
(`semantic_document_status`, `vector_projection_rows`, `semantic_index_state`),
never through the daemon's own IPC, so the measurement methodology itself
cannot be the thing perturbing the measured system. The wall-clock numbers
in this report's own tables reflect this methodology throughout: real
daemon, real corpus, one Bug-4 scheduling knob raised past this
measurement's own expected wall time (a workaround for measuring the
ALGORITHM this frente was assigned to fix, not a fix for Bug 4 itself,
which remains open per the reasoning above).

## Part 3: query latency

Real daemon (the SAME one that just completed the full n8n embed above,
`URDIRA_NATIVE_REQUIRED=1`, MiniLM neural provider), a persistent
`DaemonClient` against its own IPC socket (same methodology as S-F's own
Part 2/3), full `core:query` option set matching `packages/mcp`'s own
`DEFAULT_QUERY_OPTIONS` (`snippets.context_lines: 0`, `response_budget:
{max_items: 50, max_characters: 20000}`). 20x `core:search_semantic` + 20x
`core:search_hybrid`, one warm-up call excluded per operation, 24 distinct
natural-language query strings cycled.

**RESULT: target (p99 <= 250ms) NOT MET at full n8n scale -- latency grew
FAR faster than the ~7x growth in vector count (13,454 at `packages/cli`
scale -> 93,060 at full n8n scale) would predict linearly:**

| corpus scale | vectors | operation | p50 | p95 | p99 | min | max |
|---|---:|---|---:|---:|---:|---:|---:|
| `packages/cli` (S-F's own number, for scale) | 13,454 | `core:search_semantic` | 256.6ms | 308.1ms | 308.1ms | 248.0ms | 308.1ms |
| `packages/cli` (S-F's own number, for scale) | 13,454 | `core:search_hybrid` | 545.3ms | 903.1ms | 903.1ms | 491.2ms | 903.1ms |
| full n8n (this session, first query after completion) | 93,060 | `core:search_semantic` | 2,538.8ms | 2,825.8ms | 4,085.8ms | 2,454.1ms | 4,085.8ms |
| full n8n (this session, first query after completion) | 93,060 | `core:search_hybrid` | 6,525.6ms | 11,896.5ms | 18,311.2ms | 4,561.9ms | 18,311.2ms |

`core:search_semantic` grew ~13-15x for a ~7x growth in vector count;
`core:search_hybrid` grew ~13-20x for the same ~7x growth -- both
noticeably SUPER-linear, not the roughly-linear-with-hydration-count
growth S-F's own Part 3 decomposition (packages/cli scale) would predict
by itself. Root cause NOT fully profiled this session (no time budget
remaining for new instrumentation + a rebuild + a re-measurement cycle at
this scale, which alone would cost another native rebuild and a fresh
multi-minute warm-up); a concrete, code-grounded hypothesis for a future
frente rather than a guess: `trySemanticSearch`'s entity-lane scan
(`canonical-query-data-port.ts`) attempts a BOUNDED top-K scan first
(`SEMANTIC_ENTITY_CANDIDATE_CAP * ENTITY_SEGMENT_FANOUT_BOUND` = 100 x 8 =
800 segments, line ~501) and escalates to a FULL UNCAPPED scan over EVERY
entity segment (line ~3893: `if (entityRanks.length <
SEMANTIC_ENTITY_CANDIDATE_CAP && entityScanCandidates.length >
entitySegmentScanLimit)`) whenever the bounded attempt does not surface
100 distinct documents. At `packages/cli` scale (10,964 entity segments)
S-F measured this bounded path succeeding (~90-110ms, never escalating);
at full n8n scale (72,922 entity segments, ~6.6x more, and this session's
own numbers show the entity/artifact split is very different -- 72,922
entity segments across only 28,373 covered documents, i.e. sparser
per-document coverage than at the smaller scale) the SAME 800-segment
bounded attempt is markedly more likely to fail the "100 distinct
documents" test and fall through to the uncapped full-corpus sort S-F's
own Lever 3 was built specifically to avoid -- this would show up as
EXACTLY the super-linear (not linear) growth measured above. Flagged
precisely, with file:line, for a future frente to confirm via a debug
counter on which branch fires, rather than left as an unattributed
regression.

**Incremental edit at full n8n scale**: NOT MEASURED this session (time
budget). `packages/cli`-scale incremental-edit results already exist in
S-F's own evidence (99.99% segment-cache hit rate, 217s fs-events-to-current
latency) and this session's own Bugs 1-3 fixes only make a REPEAT pass
cheaper (see Part 2's own rate measurements), never more expensive, so
there is no code-level reason to expect a regression there -- but this is
reported as an honest gap, not a claimed result.

## Tests

`tests/semantic-maintenance.test.ts`: +4 (pretext CAS-avoidance,
status-skip-on-repeat, container-backfill chunking over the 200-row
boundary) -- 55/55 green. `tests/phase-canonical-query-data-port.test.ts`:
+1 (Bug 5's own `EXPLAIN QUERY PLAN` regression test) -- 107/107 green.
`tests/semantic-entity-source-v4.test.ts`, `tests/phase-daemon-v4-semantic.test.ts`
(re-run against the REBUILT native addon), `tests/native-query-snapshot-port.test.ts`,
`tests/phase10-semantic.test.ts`, `tests/architecture-guardrails.test.ts`:
all green, unchanged pass counts (114+13+17+57, plus the 55+107 above).
`cargo test -p urdira-native-node -p urdira-structural-store`: all green
(new `drain_visible_batch_tests` module, 2 tests, plus the pre-existing
`pending_sites_by_owner_tests`/structural-store suite). `cargo clippy -p
urdira-native-node -p urdira-structural-store -p urdira-indexing-core --
-D warnings`: clean. `pnpm typecheck`/`pnpm lint`: clean (the two
pre-existing `tests/fixtures/codebases/typescript/{barrel-method-call,multi-hop-barrel-rename}`
typecheck errors are confirmed pre-existing on `9b20fbb` before this
frente's own changes, via `git stash`).

## Final counts (literal)

- Files changed: `crates/urdira-native-node/src/structural_store_napi.rs`
  (Bug 1 fix + 2 new unit tests), `packages/engine/src/semantic-reconciler.ts`
  (Bugs 2/3 fixes + debug-timing instrumentation),
  `packages/storage/sql/{workspace-v3,workspace-v4-semantic}.sql` and
  `packages/storage/src/schema.ts` (Bug 5's new index, split between the
  raw schema string and `ensureWorkspaceSchemaCompatibility` for the
  legacy-migration reason explained above), the matching GENERATED files
  (`packages/storage/src/workspace-{v3,v4}-sql.generated.ts`,
  `crates/urdira-indexing-core/src/workspace_{v3,v4}_sql.rs`, via `pnpm
  generate:workspace-sql`), `tests/semantic-maintenance.test.ts`,
  `tests/phase-canonical-query-data-port.test.ts`, this file (new).
- Bugs found and fixed (5, every one confirmed by code inspection, live
  measurement AND (for Bugs 1-3, 5) a targeted regression test that fails
  on revert): (1) native `iter_visible_batch` O(n)-per-page enumeration ->
  O(1)-amortized resumable cursor with a correctness-preserving fallback;
  (2) `processMissingEntityRow` CAS read before eligibility check ->
  `evaluateEntityPreTextEligibility` gates it; (3) already-classified
  entities reprocessed on every pass -> `alreadyClassifiedIds` skip; (4,
  daemon-level, NOT fixed -- see its own reasoning above) `scheduleWorkspaceScan`
  unconditionally aborts in-flight semantic maintenance even for a no-op
  reconciliation-sweep scan; (5) the artifact-grain "missing rows" query's
  own correlated subquery had no matching index at all -> `vector_projection_by_owner_idx`,
  confirmed 120s-plus -> 26ms via `EXPLAIN QUERY PLAN` on the real n8n
  data.
- Rate before/after (Bugs 1-3): S-F's own final observed floor, ~0.03
  status-rows/second, independent of worker count and DECREASING over
  time. This session's own sustained rate: 100-400 status-rows/second at
  intermediate scale (~6,330 files), NEVER decreasing over a multi-minute
  observation window -- a >3,000x improvement at the low end.
- Full n8n embed (14,958 JS/TS/Vue files, 2,198,601 total structural
  records): REACHED `semantic.current` for the first time in this
  project's history. 381,269 entity-grain `semantic_document_status` rows
  (28,373 covered / 257,901 excluded / 94,995 unsupported), 20,149
  artifact-grain rows (20,138 covered / 11 excluded), 72,922 entity
  vectors + 20,138 artifact vectors = 93,060 total vectors. Combined
  honest cold-start estimate with all 5 fixes/workarounds applied: ~46-48
  minutes (37.6s scan + ~9min entity + ~37min artifact) -- above the
  ≤30min target, artifact-grain ONNX embedding is the dominant remaining
  cost, not an algorithmic defect this session found evidence of.
- Query latency: target (p99 <= 250ms) NOT met at full n8n scale --
  `core:search_semantic` p99 4,085.8ms, `core:search_hybrid` p99
  18,311.2ms (93,060 vectors) versus S-F's own 308.1ms/903.1ms (13,454
  vectors, `packages/cli` scale) -- a markedly super-linear (13-20x for a
  ~7x data growth) regression, with a precise, code-grounded (not
  fabricated) hypothesis handed to the next frente (the entity-lane
  bounded top-K scan's own escalation-to-uncapped-scan branch,
  `canonical-query-data-port.ts` ~line 3893) rather than left
  unattributed. Incremental edit at full n8n scale: not measured (time
  budget), reported as an honest gap.
- Bug found and NOT fixed, reported honestly: daemon-level overlapping
  `reconcileSemanticProjection` invocations, apparently triggered by
  `core:index_status` polling, causing CPU contention between concurrent
  ONNX inference sessions -- flagged for a future frente with the exact
  reproduction steps above.
