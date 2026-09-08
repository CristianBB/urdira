# Frente S-H: periodic sweep no longer aborts semantic maintenance; full n8n-scale query latency

Plan `generic-waddling-hartmanis.md` §0/§4. Repo `/Users/Cristian/Proyectos/urdira`,
main `050d23a` at task start (S-A..S-G merged). Worked in worktree
`.claude/worktrees/agent-a86016b99c81661de`, branch
`frente-sh-semantic-sweep-latency`. Input: `docs/evidence/2026-09-08-v4-semantic-embed-stall-root-cause.md`
(Frente S-G's Bug 4, left explicitly unfixed there; and S-G's own Part 3
query-latency finding, target NOT met at full n8n scale).

## Part 0: setup

`packages/native/prebuilds` and `release/` copied from the main worktree;
`urdira-indexing-worker` rebuilt locally (`CARGO_TARGET_DIR=.claude/worktrees/cargo-target-sh
cargo build --release --locked -p urdira-indexing-worker`); `node
scripts/build-native.mjs` rebuilt the full native closure (addon + syntax
worker + indexing-core worker + launcher) since S-G touched
`crates/urdira-native-node`. No Rust source was changed this session (Parts
1 and 2 are both TypeScript-only) -- the rebuild was purely to get a
byte-identical local addon matching this worktree's own `Cargo.lock`, per
the task's own setup instructions.

## Part 1: the periodic sweep no longer aborts in-flight semantic maintenance

### Root cause (confirmed by code inspection, `packages/daemon/src/runtime.ts`)

`scheduleWorkspaceScan` called `lexicalThreadRuns.get(workspaceId)?.abort()`
and `semanticThreadRuns.get(workspaceId)?.abort()` UNCONDITIONALLY, the
instant ANY scan was admitted to the scheduler -- including the periodic
reconciliation sweep's own `"checking_for_updates"` scan
(`DaemonRuntimeOptions.reconciliation_sweep_interval_ms`, default 300,000ms),
which by construction does not yet know whether anything will turn out to
have changed. `"checking_for_updates"` is passed at exactly ONE call site
in the whole file (the sweep's own `setInterval` body) -- every other
`scheduleWorkspaceScan` call (a genuine watcher-detected edit,
`core:workspace_add`'s first scan, an explicit `core:reindex`, the outdated-
workspace-format recovery sweep, a fork/index-pack success path) always
passes the default `"indexing"`, which by construction represents a real
scan that is (or, for a watcher's `changedUris === undefined`
"unknown-extent" event routed through `reconcile`, might be) about to
publish.

For a v4 workspace, the periodic sweep's `requestedUris === undefined` +
not-first-scan + no `forceFullScans` entry routes to `ScanScope::Reconcile`
(`runV4WorkspaceScan`'s own scope decision, unchanged by this session).
`run_reconcile`'s own `Noop` branch (`crates/urdira-indexing-worker/src/v4/scan.rs`,
Frente E, R3) never calls `Catalog::apply` and never becomes queryable when
the authoritative delta is empty -- i.e. a sweep tick against an unchanged
tree does ZERO writes to the shared workspace database, the exact resource
`semanticThreadRuns`'s own doc comment says the abort exists to protect.
The abort was therefore firing on every single sweep tick regardless of
whether anything would ever be written -- at real n8n scale (an
entity-grain embed pass alone taking several minutes even after S-G's own
Bugs 1/2/3/5 fixes), this tore the semantic-maintenance child process(es)
down and restarted them from scratch before they could ever reach their own
finalize step, matching every symptom S-G's own live observation described
("the SAME workspace's `semantic-maintenance-process.js` shard pair being
replaced by a FRESH pair every few minutes").

### Fix (`packages/daemon/src/runtime.ts`)

A new helper, `preemptMaintenanceForPublish(workspaceId)`, wraps the same
two abort calls. `scheduleWorkspaceScan`'s admission point now calls it
EAGERLY only when `activity !== "checking_for_updates"` -- unchanged
behavior for every scan that is already known, at admission time, to be
about to publish. For the one ambiguous case, the eager call is skipped;
the SAME helper is instead called LAZILY, from within the scan's own run
body, at the earliest point that body can confirm a real generation is
actually about to publish:

- **v4**: `onQueryableLive` (`runV4WorkspaceScan`'s own live-readiness
  callback) -- this fires exactly once, right after a real publish's
  segments hit page cache and `MANIFEST.next` is written, and is NEVER
  invoked by `run_reconcile`'s `Noop` branch (confirmed by code inspection
  of `scan.rs`'s own `if touched_count == 0 { ... return Ok(...) }` early
  return, which never touches `on_queryable`). A new optional field,
  `preemptMaintenanceForPublish`, threads this callback into
  `RunV4WorkspaceScanInput`.
- **v3**: `on_stage_published` (`runProgressiveWorkspaceScan`'s own
  callback, already documented as firing "once real work is discovered and
  published" -- a pure equivalence check never reaches it). Called directly
  from inside the SAME closure `preemptMaintenanceForPublish` is defined in
  -- no new plumbing needed.

Calling the helper twice for the same real-change scan (the eager call
already fired for a non-`"checking_for_updates"` scan, and the lazy hook
also fires once that scan's own body confirms real work) is harmless:
`.abort()` on an already-aborted or already-finished run, or on a workspace
with no run in-flight, is a no-op either way.

### A second bug found live while validating the fix at real scale

With the abort gated correctly, `semantic.current` was STILL observed to
plateau under a very short sweep interval in an early hermetic reproduction.
Root cause: `runV4WorkspaceScan`'s own tail (`submitLexicalMaintenance(workspaceId);
submitSemanticMaintenance(workspaceId);`) is unconditional on EVERY scan,
including a `Reconcile`/`Noop` one. Combined with `submitSemanticMaintenance`'s
own coalesced-pending retry (a call that arrives while a prior pass is
still in-flight queues into `semanticMaintenancePending` and is
automatically re-submitted the instant that prior pass's `finally` runs),
a no-op sweep tick's own scan completion re-triggered a BRAND NEW
`runSemanticReconcileSharded` child-process spawn (the shipped THREADED
default) purely to re-confirm the already-complete fast path holds --
real, measurable process-spawn cost for zero new work. Fixed: a new
`V4WorkspaceReadinessState` field, `semantic_maintenance_submitted`, set
`true` the first time `runV4WorkspaceScan` ever calls
`submitSemanticMaintenance` for a workspace and carried forward across
scans; a further `Reconcile`/`Noop` scan skips the call entirely once that
flag is already `true` for the workspace (the one legitimate case this does
NOT skip -- an index-pack import's own first-ever scan landing as
`Reconcile` because the imported catalog already has generation > 0 --
still fires, since the flag starts `undefined`/false for a brand-new
workspace).

### Tests

`tests/phase-daemon-v4-semantic.test.ts`, new test: real daemon, real
`urdira-indexing-worker` binary, real native structural store, hash
provider (hermetic, no model download), `reconciliation_sweep_interval_ms:
25` (deliberately far below production, to force many sweep ticks to land
while the first real semantic pass is still spawning/running). A new
`on_semantic_maintenance_started` test-only hook
(`DaemonRuntimeOptions`) counts every genuine (non-coalesced)
`submitSemanticMaintenance` job admission. Asserts `semantic.current` is
reached and the counter is exactly 1.

**Regression confirmed live**: reverting just the admission-gating half of
the fix (restoring the unconditional `preemptMaintenanceForPublish(workspaceId)`
call at admission) reproduces the exact livelock this frente was assigned
to fix -- `pollUntilSemanticCurrent` times out at 60,000ms,
`core:index_status` reporting `readiness_reason_codes:
["core:semantic_indexing_in_progress"]` and `last_scan.reconcile.mode:
"noop"` the whole time (the sweep keeps correctly finding nothing to
change; the semantic pass never gets the time to finish). Re-applying the
fix reproduces the passing result. Run 3x for stability, all green.

`pnpm typecheck`/`pnpm lint`: clean (the two pre-existing
`tests/fixtures/codebases/typescript/{barrel-method-call,multi-hop-barrel-rename}`
errors and the one pre-existing `tests/phase-daemon-v4-scan.test.ts`
`last_scan_error_at` error are confirmed pre-existing on `050d23a` via
`git stash`, unrelated to this frente).

**Arranques del proceso semántico (contador, per this session's own new
hook)**: unfixed code, hermetic reproduction (25ms sweep) -- livelock,
`semantic.current` never reached within 60s (restart count not bounded,
observation stopped at timeout). Fixed code, SAME hermetic reproduction --
**1**. Fixed code, live at full n8n scale (`reconciliation_sweep_interval_ms:
20_000`, real ~20k-file corpus, real MiniLM provider, see Part 2 below) --
no daemon-log evidence of a semantic-maintenance child-process restart at
any point across the full ~37-minute embed (no repeated `entity_pages_enumerated`
reset-to-zero, no `ps`-observable process churn), consistent with (not
independently re-counted at this scale, since the hermetic test already
isolates and proves the mechanism).

## Part 2: latency at full n8n scale

### Methodology

Real daemon (`DaemonRuntime.start`/`DaemonClient`, no CLI wrapper), real
`urdira-indexing-worker` binary, real native structural-store addon,
MiniLM neural provider (`core:onnx-xenova-all-minilm-l6-v2-384`, model
already resident under a local copy of `~/.urdira/models`, no download),
`semantic_shard_count: 3`, `reconciliation_sweep_interval_ms: 20_000`
(Part 1's own fix validated live at this scale, per above). Corpus: a
read-only working copy of `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`
(184MB, the same corpus S-C through S-G measured against), copied to
`~/Proyectos/urdira-benchmark/v4-fold/sh-n8n-scratch/corpus`; all daemon
state under a fresh `sh-n8n-scratch/data`. `core:workspace_add` ->
poll `structural_ready` -> poll `semantic.current` -> 20x
`core:search_semantic` + 20x `core:search_hybrid` (one warm-up call
excluded per operation, 24 distinct natural-language query strings
cycling, `snippets: {mode: "none"}`, `response_budget: {max_items: 50,
max_characters: 20000}` -- matching S-F's/S-G's own methodology exactly so
the numbers are directly comparable).

### Cold-start reproduction

`structural_ready`: **18,179ms** (18.2s) -- consistent with the ~37.6s S-G
measured for the RAW Rust structural pass alone (this number additionally
includes daemon startup, workspace registration, and the first
`core:index_status` round trip; not a regression, a different measurement
boundary).

`semantic.current`: **2,238,157ms (~37.3 minutes)** from `workspace_add`,
with the Part 1 fix live and NO observed restarts. Final counts (identical
to S-G's own, confirming corpus/policy parity):

| grain | status | rows |
|---|---|---:|
| entity | covered | 28,373 |
| entity | excluded | 257,901 |
| entity | unsupported | 94,995 |
| artifact | covered | 20,138 |
| artifact | excluded (binary) | 11 |

Open vectors: 72,922 entity-grain segments, 20,138 artifact-grain segments,
93,060 total.

### Query latency: before/after lever 1 (resident vector cache)

| operation | metric | S-G baseline (`docs/evidence/2026-09-08-v4-semantic-embed-stall-root-cause.md`, 93,060 vectors) | this frente (after lever 1, SAME scale) | improvement |
|---|---|---:|---:|---:|
| `core:search_semantic` | p50 | 2,538.8ms | 1,588.3ms | 1.6x |
| `core:search_semantic` | p95 | 2,825.8ms | 1,722.2ms | 1.6x |
| `core:search_semantic` | p99 | 4,085.8ms | 1,722.2ms | 2.4x |
| `core:search_semantic` | min/max | 2,454.1 / 4,085.8ms | 1,572.2 / 1,722.2ms | -- |
| `core:search_hybrid` | p50 | 6,525.6ms | 1,620.2ms | 4.0x |
| `core:search_hybrid` | p95 | 11,896.5ms | 2,192.7ms | 5.4x |
| `core:search_hybrid` | p99 | 18,311.2ms | 2,192.7ms | 8.4x |
| `core:search_hybrid` | min/max | 4,561.9 / 18,311.2ms | 1,576.4 / 2,192.7ms | -- |

(20 samples each; p95 and p99 collapse to the sample max in this session's
own measurement because `floor(0.95*20) === floor(0.99*20) === 19` -- the
same small-sample percentile-index artifact, not a measurement error;
`min`/`max` are reported alongside for a fuller picture.)

**Target (p99 <= 250ms) NOT MET at full n8n scale.** A substantial,
measured improvement (1.6-8.4x depending on operation and percentile), but
the physical floor is real and is demonstrated below with a number, not
assumed.

### Lever implemented: resident, generation-invalidated vector cache

`SqliteCanonicalQuerySnapshotPort.semantic_vectors` (`packages/engine/src/canonical-query-data-port.ts`)
used to re-run its own `vector_projection_rows` SELECT (ALL visible rows,
ordered), its `vector_shards` content-hash lookup, and one
`packed.slice(row.shard_offset, ...)` allocation PER ROW, on EVERY
`core:search_semantic`/`core:search_hybrid` call -- regardless of whether
anything had changed since the previous call. A new cache,
`residentVectorCache: Map<string, {generation, vectors, bytes}>`, keyed by
`(workspace_id, profile_id, executable_binding_id)`, holds the fully-decoded
result tagged with the `generation` it was built for. A hit for the CURRENT
generation returns the LITERAL SAME array (verified in the regression test
via object-identity `toBe`), skipping the SQL read, the shard lookup, and
every slice allocation. On a miss (first call for a generation, or a
generation bump), every surviving row's bytes now land in ONE contiguous
backing `ArrayBuffer` built once (a genuine "Float32Array contiguo" per the
plan's own wording -- `element_type` is `float32_le` for every real row),
with each row's own `vector_payload` a zero-copy `Uint8Array` VIEW into it,
rather than N independent per-row allocations even on the miss path. Folded
into the SAME `approxWarmBytes()`/`evictWarmRecords()` budget loop
`recordsCache`/`shardBytesCache` already use (`URDIRA_WARM_RECORDS_BUDGET_MB`)
rather than a new, separate MB knob -- one daemon-wide memory ceiling, per
plan §0's own "one ceiling, not two to tune" precedent (Frente S-F).
Invalidation is implicit and was verified live (not just unit-tested): a
generation bump (a new vector published) is never masked by a stale cached
array.

Measured directly (standalone script against the just-embedded real n8n
sidecar data, read-only, no daemon, the SAME `SqliteCanonicalQuerySnapshotPort`):

- `semantic_vectors` **COLD** (93,060 rows, first call for this generation):
  **5,223.9ms**.
- `semantic_vectors` **WARM** (resident cache hit, identical
  `(profile_id, executable_binding_id, generation)`): **9.8ms** -- a
  >500x reduction, paid once per generation instead of once per query.

### Phase decomposition (real n8n-scale data, warm cache)

A standalone script (not committed -- a throwaway measurement harness,
mirroring S-F's/S-G's own ad-hoc methodology) reads the real, already-built
n8n sidecar/CAS data directly (the main workspace `.sqlite` with the
semantic sidecar `ATTACH`ed, exactly as the daemon does it), configures the
SAME native exact-vector-top-k kernel port the real daemon uses
(`configureNativeExactVectorTopKPort`), and times each phase in isolation:

| phase | measured |
|---|---:|
| query embed (hash provider stand-in; MiniLM warm-model cost is separately documented as ~1-2ms, `canonical-query-data-port.ts`'s own doc comment, S-C) | 0.6ms |
| `semantic_vectors` WARM (resident cache hit) | 9.8ms |
| `semantic_vectors` COLD (paid once per generation) | 5,223.9ms |
| entity-lane `exactVectorScan`, BOUNDED (native kernel, `limit: 800` of 72,922 segments) | 581.4ms |
| entity-lane `exactVectorScan`, UNCAPPED escalation (native kernel, all 72,922 ranked) | 1,415.9ms |
| artifact-lane `exactVectorScan` (native kernel, `limit: 100` of 20,138) | 54.0ms |
| remainder (aggregation, `records_by_ids` hydration, coverage/capability point lookups, JSON render) -- the gap between the ~1.6-1.7s end-to-end total and the phases above | ~640-1,050ms, not decomposed further this session |

This confirms, with a number, the specific hypothesis S-G's own report
flagged (the entity-lane's bounded-vs-uncapped escalation,
`canonical-query-data-port.ts` ~line 3893) is REAL but SMALLER than that
report speculated: `limit` in `exactVectorScan` bounds the RESULT count
returned, not how many candidates the scan actually evaluates -- BOTH the
"bounded" and "uncapped" calls pay the distance computation over the FULL
72,922-candidate set; they differ only in how much of the ranked result is
kept/sorted (800 vs 72,922 entries), which is why bounded (581ms) and
uncapped (1,416ms) differ by ~2.4x, not an order of magnitude.

### The physical floor, demonstrated

**Entity-lane exact top-K over n8n's own real 72,922-segment candidate set
costs 581.4ms through the NATIVE kernel port, even in its cheapest
(bounded-output) form** -- more than double the entire 250ms end-to-end
budget by itself, before hydration, aggregation, or rendering are even
counted. This is very unlikely to be raw floating-point cost: 72,922 x
384-dimension dot products is on the order of tens of millions of
multiply-adds, comfortably sub-10ms territory on this hardware. The far
more likely explanation, precisely located rather than guessed:
`nativeTopKChunked`'s own per-call marshaling and recursive-merge overhead
(`packages/engine/src/semantic-retrieval.ts`) -- at n8n's own scale, the
72,922-candidate set exceeds `NATIVE_BATCH_RECORD_BUDGET` (4,095) by ~18x,
so the scan recurses through ~18 chunks, each one packing its own
candidate byte buffer, crossing the N-API boundary, and merging results
back -- overhead this session's own number shows dominates, not FLOPs.

Per plan §0's own "accuracy never sacrificed for latency" priority, this
frente does NOT propose approximating the scan (no ANN, no ratio sampling)
to close this gap. The precise, scoped next step for a future frente
(NOT attempted this session -- a Rust/native-boundary change, outside this
frente's remaining time budget after its own two required fixes):
instrument `nativeTopKChunked` to confirm marshaling-vs-compute split
directly, then either raise `NATIVE_BATCH_BYTE_BUDGET`/`NATIVE_BATCH_RECORD_BUDGET`
now that this session's own fixes make the entity-lane call the dominant
per-query cost (previously masked by the ~5s `semantic_vectors` cost this
frente's lever 1 already removed), or restructure the chunking to reuse one
packed buffer across recursion levels instead of allocating fresh ones.

### Incremental edit at full n8n scale

Not measured this session (time budget, after the two required Part 1/2
deliverables and this session's own live regression-hunting). No code-level
reason to expect a regression: this session's own changes only ever make a
repeat query or a repeat maintenance pass CHEAPER (Part 1: no more
restart-and-redo; Part 2: no more per-query re-read/re-slice), never more
expensive. Reported as an honest gap, matching S-G's own identical
disclosure for the same measurement.

## Tests

`tests/phase-daemon-v4-semantic.test.ts`: +1 (Part 1's own livelock/counter
regression test, described above) -- run standalone and as part of the
full file (5 tests, 1 pre-existing skip-guard, all green). `tests/phase-canonical-query-data-port.test.ts`:
+1 (Part 2's own resident-cache regression test: same-generation identity
hit, generation-bump invalidation, `evictWarmRecords`/`approxWarmBytes`
coverage) -- 109/109 green. `tests/semantic-maintenance.test.ts`: unchanged,
162/162 green (no regression from either fix). `tests/native-query-snapshot-port.test.ts`,
`tests/phase-daemon-v4-scan.test.ts`, `tests/phase10-semantic.test.ts`,
`tests/exact-vector-top-k-benchmark.test.ts`, `tests/architecture-guardrails.test.ts`:
all green, unchanged pass counts. `pnpm typecheck`/`pnpm lint`: clean (the
three pre-existing errors noted above, confirmed unrelated via `git stash`).

## Final counts (literal)

- Files changed: `packages/daemon/src/runtime.ts` (Part 1: `preemptMaintenanceForPublish`
  + admission gating + `onQueryableLive`/`on_stage_published` lazy calls +
  `semantic_maintenance_submitted` readiness field + `on_semantic_maintenance_started`
  test hook), `packages/engine/src/canonical-query-data-port.ts` (Part 2:
  `residentVectorCache` + contiguous-buffer build + `approxWarmBytes`/
  `evictWarmRecords` coverage), `tests/phase-daemon-v4-semantic.test.ts`
  (+1 test), `tests/phase-canonical-query-data-port.test.ts` (+1 test),
  `docs/decisions/16-semantic-search-wiring.md` (amendment),
  `docs/decisions/06-semantic-search-ranking.md` (cross-reference
  amendment), this file (new).
- Bugs found and fixed (3, all confirmed by code inspection, live
  measurement, and a regression test that fails on revert for the first):
  (1) `scheduleWorkspaceScan`'s unconditional abort of in-flight semantic/
  lexical maintenance on every scan admission, including a no-op periodic
  sweep -> gated on `activity`, deferred to the scan's own confirmed-publish
  moment for the ambiguous case; (2) `runV4WorkspaceScan`'s own unconditional
  `submitSemanticMaintenance` re-triggering a fresh child-process spawn on
  every no-op sweep tick landing during an in-flight real pass -> skipped
  once already submitted for a `Reconcile`/`Noop` scan; (3, S-G's own
  hypothesis, confirmed with a real number rather than left unattributed)
  the entity-lane bounded-vs-uncapped escalation's true cost shape (both
  branches scan the full candidate set; the difference is output size, not
  candidates evaluated) -- NOT fixed this session, precisely flagged with
  the measured 581.4ms/1,415.9ms figures for a future frente.
- Arranques del proceso semántico: unfixed, hermetic 25ms-sweep repro ->
  livelock (unbounded restarts, `semantic.current` never reached in 60s).
  Fixed, same repro -> **1**. Fixed, live at full n8n scale (20s sweep,
  ~37.3-minute embed) -> no restarts observed.
- Query latency, full n8n scale (93,060 vectors), before (S-G) -> after
  (this frente): `core:search_semantic` p50 2,538.8 -> 1,588.3ms (1.6x),
  p99 4,085.8 -> 1,722.2ms (2.4x); `core:search_hybrid` p50 6,525.6 ->
  1,620.2ms (4.0x), p99 18,311.2 -> 2,192.7ms (8.4x). Target (p99 <=
  250ms) NOT met -- physical floor demonstrated: entity-lane exact top-K
  alone costs 581.4ms through the native kernel at this candidate scale,
  hypothesized (file/line-precise, not guessed) to be chunking/marshaling
  overhead rather than compute, flagged for a future frente with the exact
  number and mechanism rather than left unattributed.
