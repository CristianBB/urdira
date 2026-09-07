# Frente S-C: v4 semantic wiring, embed-performance profile, and query-latency batching

Plan `resilient-knitting-twilight.md` §0/§4. Repo `/Users/Cristian/Proyectos/urdira`,
main `8ff1981` at task start. Worked in worktree
`.claude/worktrees/agent-af1bcdb8bd013415a`, branch `frente-sc-semantic-v4-perf`.
Machine: Apple Silicon, 10 physical/10 logical cores (`sysctl hw.physicalcpu
hw.logicalcpu` both report 10 -- no SMT).

Input: `docs/evidence/2026-09-07-v4-n8n-parity-and-semantic-segments.md` §B,
which found (1) semantic maintenance entirely unwired for v4-storage
workspaces, (2) a full n8n embed did not complete in 3h44m (artifact-grain
99.95% done, entity-grain 0.65% done, ETA bracket 10-27h), (3)
`core:search_semantic` p50=301/p99=324ms on a 187-file/1,300-vector-row
workspace (target <=250ms p99), (4) a token histogram showing 47% of
entities >256 tokens, p99=31 segments.

---

## Part 1: v4 semantic wiring (correctness fix)

### 1.1 What was missing

Confirmed by reading `packages/daemon/src/runtime.ts` before changing
anything:

- `runV4WorkspaceScan`'s success path called `submitLexicalMaintenance` but
  **never** `submitSemanticMaintenance`, with an explicit doc comment saying
  the entity-grain lane would fail outright against `record_occurrences`.
- `submitSemanticMaintenance` itself had `if (v4ReadinessState.has(workspaceId))
  return;` as its second line -- a hard, unconditional no-op for every v4
  workspace, from every call site (post-scan, post-fork, post-index-pack,
  startup prewarm).
- `v4WorkspaceReadinessFrom` hardcoded `semantic_ready: false`,
  `semantic_availability: "unavailable"`, `semantic_completeness: "unsupported"`,
  `semantic_build_state: "disabled"`, unconditionally, with `void semantic;`
  discarding the real `SemanticMaterializationStatusView` map it was handed.
- `v4StatusFields`'s `semanticCurrent` was `isV4 ? false : readiness.semantic_ready`
  -- always `false` for v4 regardless of anything else.
- `reconcileSemanticProjection` (`packages/engine/src/semantic-reconciler.ts`)
  had exactly four SQL sites hardcoded against `record_occurrences`/
  `record_value_nodes`: the entity stale-close query (step 4), the missing-
  entity-insert query + its `record_value_nodes` body-decode fallback (step
  5), and two `syncDocumentStatusBulk` statements (the ineligible-container
  status backfill, the entity orphan-status sweep). None of those four tables
  exist in the v4 catalog schema at all
  (`docs/evidence/2026-09-02-v4-p2-1-schema.md` §2, "Dropped, explicit per the
  task brief: `record_occurrences`, ... `record_value_nodes`" is not literally
  in that list by name but `record_occurrences`/`record_facets`/`record_value_nodes`
  are -- confirmed directly against `packages/storage/sql/workspace-v4.sql`,
  which has no such tables).
- Separately, on the READ side: `NativeCanonicalQuerySnapshotPort.semantic_entity_scope_counts`
  (`packages/engine/src/native-query-snapshot-port.ts`) delegated
  unconditionally to `this.sqlite.semantic_entity_scope_counts`, whose own
  SQL is `SELECT COUNT(*) FROM record_occurrences WHERE ...` -- the exact
  same gap, on the query path instead of the write path. This was NOT called
  out in the input evidence doc; found live while building the v4 e2e test
  (`core:search_semantic` threw `"no such table: record_occurrences"` even
  after the write-side fix landed).

Every other table `reconcileSemanticProjection` touches
(`artifact_versions`, `source_artifacts`, `vector_projection_rows`,
`semantic_document_status`, `semantic_index_state`, `workspace_current_state`)
is kept byte-identical between v3 and v4 catalog/sidecar schemas
(P2-1's own table-by-table decision), which is what makes a MINIMAL,
additive fix possible instead of a rewrite.

### 1.2 What was built

- `packages/engine/src/semantic-reconciler.ts`: new exported types
  `SemanticEntityCandidateRow`/`SemanticEntityRecordSource`, a new optional
  `ReconcileSemanticProjectionInput.entity_record_source` field. When
  `undefined` (every v3 caller, every pre-existing test), the four SQL sites
  above are byte-for-byte unmodified -- confirmed by re-running the full
  pre-existing `tests/semantic-maintenance.test.ts` suite unchanged (30/30
  pass). When provided, all four sites use the source instead.
- `packages/engine/src/semantic-entity-source-v4.ts` (new file):
  `createNativeSemanticEntityRecordSource(...)` -- a real v4-storage
  implementation on top of a minimal `EntityScanPort` interface (`records_for_query`/
  `records_by_ids`, satisfied structurally by `NativeCanonicalQuerySnapshotPort`
  without importing it, keeping this file decoupled from the native addon
  loader). `entityCandidates()` does one full visible-corpus scan filtered to
  `category === "entity"`, batch-joins `artifact_versions`/`source_artifacts`
  for owning-file CAS metadata (chunked at 200 ids/query), and drops any
  candidate whose owner is missing or binary. `visibleRecordIds(ids)` batches
  `records_by_ids` (chunked at 200) and returns the subset still visible.
- `packages/daemon/src/semantic-v4-wiring.ts` (new file):
  `resolveV4SemanticEntitySource(database, content, workspaceId)` -- `undefined`
  for a v3 (or not-yet-native) workspace; for a v4 workspace, ATTACHes the
  semantic sidecar directly onto the workspace's own catalog connection
  (idempotent via `PRAGMA database_list`, mirroring `warmWorkspaceQueryEngine`'s
  existing read-path ATTACH exactly, NOT `submitLexicalMaintenance`'s reversed
  ATTACH-catalog-onto-sidecar approach -- this means `database`/`database.projections`
  need zero wrapping, unlike the lexical v4 branch's duck-typed handle) and
  builds a `NativeCanonicalQuerySnapshotPort` + the entity source on top of it.
- `packages/daemon/src/semantic-maintenance-process.ts` (the forked child
  that runs the REAL, off-main-thread maintenance pass) and `packages/daemon/src/runtime.ts`'s
  in-process fallback branch both now call `resolveV4SemanticEntitySource`
  and pass its result through to `reconcileSemanticProjection`.
- `runtime.ts`: `submitSemanticMaintenance`'s `v4ReadinessState.has` early
  return is gone. `runV4WorkspaceScan` now takes `submitSemanticMaintenance`
  as an explicit parameter (mirroring `submitLexicalMaintenance`'s existing
  threading) and calls it right after `submitLexicalMaintenance` in the
  success path. `v4WorkspaceReadinessFrom` now computes `semanticReady`
  from the real `semanticMaterializationView`/current-snapshot comparison,
  the SAME formula v3's `workspaceReadiness` already used
  (`structuralReady && semanticView?.materialization_state === "complete" &&
  semanticView.source_snapshot_id === workspace.current_snapshot_id`).
  `v4StatusFields`'s `semanticCurrent` is now plain `readiness.semantic_ready`
  (no more `isV4 ? false : ...`). After a successful `submitSemanticMaintenance`
  run with `marker_written: true`, `v4ReadinessState`'s
  `semantic_completed_generation` is updated (mirroring how the lexical v4
  branch already updates `lexical_completed_generation`) -- a no-op for v3
  (`v4ReadinessState.has` is false there).
- `packages/engine/src/native-query-snapshot-port.ts`: `semantic_entity_scope_counts`
  no longer delegates to `this.sqlite` -- it scans the native store directly
  (`this.scanAll(generation)`, the SAME full-scan helper `records_by_selector`'s
  own fallback uses), filtering `category === "entity" && kind !== INELIGIBLE_ENTITY_RECORD_KIND`
  (imported from `semantic-reconciler.ts`) -- the identical candidate-entity
  definition on both the write side (embedding) and this read side (coverage
  counting).

### 1.3 P0 discovered live, reported, not fixed (out of scope)

`crates/urdira-jsts-syntax-worker/src/lib.rs`'s `push_entity_with_type_surface`
(and, transitively, `push_entity`, `push_namespace_entity`'s sibling logic for
every OTHER kind) publishes an entity's `start`/`end` fields as the
IDENTIFIER's own span (`identifier.span.start`/`identifier.span.end`), not
the whole declaration's span. v3's TS analyzer (`packages/plugin-javascript-typescript/src/analyzer.ts`,
`entityForDeclaration`) explicitly separates `identityStart` (name-anchored,
used ONLY for the stable id) from the published `start`/`end`
(`node.getStart(file)`/`node.getEnd()`, the FULL declaration) -- v4's Rust
producer conflates the two. Verified live, twice, against a real v4 scan
(`tests/phase-daemon-v4-semantic.test.ts`'s own fixture before the workaround
below was added): every real function/variable entity record's `status`
came back `"excluded"`/`["below_min_length"]` even for a multi-line function
body far longer than decision 17's 120-character threshold, because only the
~15-50-character NAME was ever measured. This makes v4's entity-grain
semantic lane effectively unable to embed any REAL callable/variable
declaration today (class/interface/enum entities are separately excluded by
KIND, `jsts:entity_container`, regardless of span). `tests/phase-daemon-v4-semantic.test.ts`
works around this with a deliberately >=120-character identifier name
(`summarizeTaskTransitionHistoryForAuditReportingAcrossAllWorkspaceMembersAndTeamsWithFullNotificationFanOutSupportEnabledNow`,
123 characters) so its own passing does not depend on this fix landing
first; once the producer bug is fixed, the SAME test keeps passing unchanged
(a longer real span only makes eligibility MORE certain).

### 1.4 Tests

New: `tests/semantic-entity-source-v4.test.ts` (3 tests, fake `EntityScanPort`
+ a real `artifact_versions`/`source_artifacts` catalog -- filters to
`category === "entity"`, joins owner CAS metadata, drops binary-owned/
missing-owner records, sorts deterministically, batches `visibleRecordIds`).
New: three cases appended to `tests/semantic-maintenance.test.ts`'s existing
suite (fake `SemanticEntityRecordSource`, no `record_occurrences` row ever
seeded in that describe block): eligible-vs-container-kind embedding via the
fake source; stale-close when the source reports a record no longer visible;
a reconcile no-op (unchanged generation/provider/policy) proven to call the
entity source exactly once for `entityCandidates()` and once for
`visibleRecordIds()` (the orphan sweep) on the FIRST pass, then ZERO
additional calls on the second, fast-path pass (`source.calls` object
identical before/after).
New: `tests/phase-daemon-v4-semantic.test.ts` -- real end-to-end coverage
against the REAL `urdira-indexing-worker` binary and REAL native structural-
store addon (mirrors `tests/v4-daemon-e2e.test.ts`'s own harness), hash
provider (hermetic, no model download): a v4 workspace reaches
`semantic.current: true` with a real `completed_generation > 0`,
`core:search_semantic` returns a real entity-grain candidate with
`semantic_evidence.matched_segment` populated (`{index, start_char, end_char}`,
all numbers), `semantic_coverage.materialization_state: "complete"` with a
real `affected_artifact_page`, and a `core:reindex` no-op leaves
`semantic.completed_generation` at the exact same value (proving the fast
path, not a re-embed).

Full required suite, run together:

```
tests/phase-daemon-v4-scan.test.ts tests/phase-daemon-v4-semantic.test.ts
tests/semantic-maintenance.test.ts tests/embedding-local.test.ts
tests/semantic-provider.test.ts tests/phase-canonical-query-data-port.test.ts
tests/phase10-semantic.test.ts tests/phase-daemon-indexing-integration.test.ts
tests/semantic-neural-host.test.ts tests/architecture-guardrails.test.ts
tests/semantic-entity-source-v4.test.ts
```

Result: **11 files passed, 306 tests passed, 1 skipped** (the companion
"build the release artifacts first" guard test in `phase-daemon-v4-semantic.test.ts`,
`it.skipIf(hasReleaseArtifacts)` -- inverted here since the artifacts WERE
present, so its sibling ran instead; the skip line itself is expected,
mirroring `v4-daemon-e2e.test.ts`'s identical pattern). `pnpm typecheck` and
`pnpm lint` both clean against every file this task touched (the repo's
`pnpm typecheck` also reports 6 pre-existing errors under
`tests/fixtures/codebases/typescript/{barrel-method-call,multi-hop-barrel-rename}`
-- verified present identically on a clean `git stash` back to `8ff1981`,
unrelated to this task).

---

## Part 2: embed-performance profile (n8n-scale embed)

Profiled BEFORE touching anything, per plan §4's "perfila primero", using
real TypeScript segments extracted from this repo's own sources (not
synthetic text), against the real bundled model (`Xenova/all-MiniLM-L6-v2`,
q8, provisioned offline at `~/.urdira/models`, never downloaded).

### 2.1 Batching (already real)

`createLocalNeuralProvider`'s `generateVectors` (`packages/embedding-local/src/index.ts`)
already flattens every input's own segments into one ordered list and issues
real multi-item `extractor(chunk)` calls, chunked at `max_segments` (64
default) -- confirmed by reading the code, not a regression to fix.

### 2.2 Thread count / execution provider

82-file corpus (`packages/daemon/src`+`packages/engine/src`, 2,601 ~1000-char
segments), single process:

| config | wall (embed only) | throughput |
|---|---:|---:|
| default (unconfigured) | 34,477 ms | 75.44 segs/s |
| `intraOpNumThreads: 10` (all physical cores), batch 64 | (16-file micro-bench) 7,946 ms / 608 segs | 76.52 segs/s |
| `intraOpNumThreads: 1` (forced single-thread) | 134,990 ms | 19.27 segs/s |
| `executionProviders: ["coreml", "cpu"]`, batch 32 | (16-file micro-bench) 85,629 ms / 608 segs | 7.10 segs/s |

`intraOpNumThreads: 10` vs. default: **statistically indistinguishable**
(75.44 vs. 76.52 segs/s) -- onnxruntime's own default already parallelizes to
roughly the same ceiling. `intraOpNumThreads: 1` vs. default confirms that
ceiling is real (~3.9x over single-thread). **Decision: not shipped** -- an
explicit thread-count override would bump `executable_binding_digest`
(forcing a full re-embed for every existing installation) for a measured
~0% throughput gain.

CoreML: **~10.6x SLOWER** than CPU default (7.10 vs. 75.44 segs/s) AND fails
the plan's own "same vector, tolerance 1e-4 cosine" bar -- measured cosine
similarity between CPU-default and CoreML vectors for the SAME text:
`0.9943935509426756`, `0.9942376839176698`, `0.9949506006190348` (3 samples)
-- a real ~0.5-0.6% divergence, not floating-point noise. **Decision: rejected
on both counts**, not shipped.

### 2.3 Process-level parallelism

82-file corpus, sharded across N concurrent Node processes (each with
default/unconfigured threading), wall-clock measured via `date +%s` around
the whole concurrent group:

| processes | total segments | wall | aggregate throughput |
|---:|---:|---:|---:|
| 1 | 2,601 | 34s (34,477ms embed-only) | 75.44 segs/s |
| 2 | 2,601 (1,379 + 1,222) | 24s | 108.4 segs/s (**1.44x**) |
| 4 | 2,601 (736+865+643+357) | 26s | 100.0 segs/s (regression vs. 2) |

2 concurrent processes give a real, reproducible ~1.44x; 4 regresses below 2
(thread oversubscription -- each process still runs its own multi-thread
pool internally, so 4 processes x ~4 threads each oversubscribes 10 physical
cores). **Decision: real lever, NOT shipped this session** -- realizing it
inside `reconcileSemanticProjection` means sharding one maintenance pass's
embedding work across multiple child processes and merging
counts/abort/generation bookkeeping back into one result, a genuine
architectural change to `semantic-process.ts`/`semantic-maintenance-process.ts`
beyond this session's remaining safe-change budget. Documented as the
concrete next lever (~1.44x, capped at 2 concurrent processes on this
10-core machine) for a follow-up frente.

### 2.4 Artifact-vector reuse from entity segments

Designed, not implemented. Requires reordering the entity pass (step 5)
before the artifact pass (step 3) for the same file, and redefines what an
artifact vector computationally IS (mean of covering entity segment vectors
plus embeds of only the uncovered text, instead of a fresh whole-file embed)
-- a real behavior change to a lane every workspace already depends on, with
its own new edge cases (zero eligible entities in a file; a file fully
covered by entities) needing dedicated tests. Out of this session's risk
budget; reported as the single largest designed-but-undone lever.

### 2.5 `max_segments`

Unchanged. No new evidence this session moved the input evidence doc's own
R8 decision (p99=31 segments measured on n8n, cap stays at 64).

### 2.6 Full n8n embed

**Not re-attempted this session.** The input evidence doc's own measurement
(3h44m elapsed, artifact-grain 99.95% done, entity-grain 0.65% done, bracket
ETA 10-27h) already established the order of magnitude on this same class of
hardware; none of the levers measured above (2.2-2.5) changes that order of
magnitude (best case ~1.44x from unshipped process-parallelism would still
leave a multi-hour-to-multi-day operation). Re-running it to the same
non-conclusion would have consumed the majority of this session's remaining
budget for no new decision-relevant number. The v4 wiring fix (Part 1) DOES
newly make a full n8n embed possible in v4-storage form at all (previously
impossible, forcing the input evidence doc onto v3 storage) -- that
capability is now real and tested end-to-end on a small workspace
(§1.4); a full n8n-scale v4 run remains multi-hour-to-multi-day, unchanged
from the v3 measurement's own order of magnitude.

---

## Part 3: query-latency

### 3.1 Model residency confirmed (the brief's own hypothesis disproved)

Measured directly against `startNeuralSemanticProviderHost`'s real persistent
child process (`packages/daemon/src/semantic-process.ts`), 5 real queries,
warm-up call excluded:

```
IPC generateVector "http request node": 1.71ms
IPC generateVector "workflow execution error handling": 1.75ms
IPC generateVector "credential encryption": 1.56ms
IPC generateVector "webhook trigger registration": 1.60ms
IPC generateVector "oauth2 token refresh": 1.69ms
```

In-process (no IPC), same warm model: ~1.0-1.4ms per query. **The model is
already resident/warm across queries and was never the bottleneck** the
plan's own brief speculated it might be ("¿el proceso semántico carga el
modelo por consulta?" -- no).

### 3.2 Real bottleneck found and partially fixed: sequential-await batching

Bisected with temporary `performance.now()` probes (removed before this
commit -- `git diff` against the final `canonical-query-data-port.ts` shows
none remain) around `trySemanticSearch`'s phases, run against a REAL daemon
+ REAL neural provider + a 45-real-file workspace (`packages/engine/src/*.ts`,
enough to exceed one `embed_batch_size` of 16 and produce multiple
`vector_shards` rows):

```
snapshot-batch=85.5ms   embedQuery=3.8ms   rank-scan=165.3ms   hydrate=99.6ms   total=354.2ms
snapshot-batch=104.8ms  embedQuery=2.4ms   rank-scan=193.1ms   hydrate=85.3ms   total=385.7ms
snapshot-batch=79.3ms   embedQuery=2.3ms   rank-scan=162.3ms   hydrate=92.6ms   total=336.5ms
```

`embedQuery` (~2-4ms) confirms §3.1 directly on the real query path. Two
sequential-await patterns fixed:

1. `trySemanticSearch` awaited seven independent snapshot-port reads
   (`capability_states`, `semantic_index_state`, `semantic_vectors`,
   `semantic_scope_counts`, `semantic_entity_scope_counts`,
   `semantic_document_status_counts`, `semantic_affected_documents`) ONE AT A
   TIME -- each pays its own `SqliteWorkerAdapter` worker-thread round trip
   (`packages/storage/src/sqlite.ts`'s `SqliteWorkerAdapter`, confirmed by
   reading its `postMessage`-based implementation). None of the seven
   consumes another's RESULT (`semantic_vectors` only ever gated on whether
   a marker existed AT ALL, never its value, and resolves its own current
   generation internally) -- now fired together via one `Promise.all`.
2. `semantic_vectors`'s own packed-shard CAS reads (`this.content.read(shard.content_hash)`,
   one per DISTINCT `vector_shards` row -- and a real workspace has many, one
   per embed-batch commit) ran in a plain sequential `for` loop -- now
   bounded-concurrency via `@urdira/engine`'s existing `mapWithConcurrency`
   helper (limit 16, same magnitude as `source-indexer.ts`'s
   `DEFAULT_READ_CONCURRENCY`/`directory-provider.ts`'s `DEFAULT_WALK_CONCURRENCY`).

Before/after, SAME 45-file workspace, 20x `core:search_semantic` + 20x
`core:search_hybrid` over a persistent `DaemonClient` connection (mirrors the
input evidence doc's own §B.4 methodology exactly):

| | p50 | p95 | p99 | min | max |
|---|---:|---:|---:|---:|---:|
| `search_semantic` BEFORE | 395.7ms | 446.5ms | 493.4ms | 384.3ms | 493.4ms |
| `search_semantic` AFTER | 328.4ms | 417.1ms | 444.7ms | 316.7ms | 444.7ms |
| `search_hybrid` AFTER | 322.8ms | 337.2ms | 337.4ms | -- | -- |

**p50 improved ~17% (395.7ms -> 328.4ms), p99 improved ~10% (493.4ms ->
444.7ms).** Target (<=250ms p99) **NOT met** on this corpus; small-workspace
target (<100ms) **was already met before this fix** -- a 2-3-file workspace
measured p50=42.7ms/p99=67.3ms even with the unfixed sequential code (only
one shard, only one meaningful round trip either way, so both fixes are
zero-risk/zero-effect there and the small-workspace bar was never actually
at risk).

### 3.3 Two remaining, larger cost centers -- identified, NOT fixed this session

From the same breakdown: `rank-scan` (107-193ms) and `hydrate` (85-100ms)
together dominate the remaining total, larger than the fixed `snapshot-batch`
overhead itself.

- **`rank-scan`** spans `exactVectorScan` (artifact lane), `exactVectorScan`
  (entity-segment lane, deliberately UNCAPPED per decision 17's max-similarity
  reduction), the entity-rank reduction loop, and (`core:search_hybrid` only)
  `rankedLexicalMatches`. `exactVectorScan` (`packages/engine/src/semantic-retrieval.ts`)
  calls `canonicalVectorBytes(candidate.vector, configuration)` PER CANDIDATE,
  in both its native-top-k-packing branch and its JS-fallback branch, with
  no cap on the entity-segment candidate count reaching it. This session's
  own test harness (`DaemonRuntime.start` called directly, not through
  `apps/urdira`) never calls `configureNativeExactVectorTopKPort` -- confirmed
  by grep: that wiring exists ONLY in `apps/urdira/src/index.ts`, never in
  `packages/daemon/src/runtime.ts` or any test helper -- so this session's
  `rank-scan` numbers reflect the JS fallback path, not necessarily what a
  real `apps/urdira`-launched daemon (which DOES wire the native port) would
  show for this specific sub-step. Not re-measured through the native path
  this session (would require building/loading that native addon inside the
  test harness); reported as an open question for whoever picks this up next,
  not asserted as a production number.
- **`hydrateSemanticCandidates`** (`canonical-query-data-port.ts`) fetches each
  final candidate's snippet in a sequential `for` loop with a SHARED,
  ORDER-DEPENDENT budget (`remainingCandidateSnippetBudget`, decremented after
  each candidate so later candidates see less budget than earlier ones) --
  genuinely not safe to blanket-parallelize without redesigning how that
  budget is allocated across candidates first. Not touched this session to
  avoid changing snippet-truncation behavior under time pressure; a real,
  scoped follow-up (e.g., pre-allocate a fixed per-candidate share, or fetch
  unconstrained then trim in one single-threaded pass afterward).

---

## Cleanup

- Scratch scripts (`packages/embedding-local/scratch-bench*.mjs`,
  `packages/daemon/scratch-host-latency.mjs`, `packages/embedding-local/scratch-query-latency.mjs`)
  and the temporary `tests/phase-daemon-indexing-integration.test.ts` SCRATCH
  benchmark block (added, measured before/after, then removed --
  `git diff` shows that file byte-identical to `8ff1981`) were all deleted
  before this commit.
- Temporary `performance.now()`/`appendFileSync` timing probes added to
  `canonical-query-data-port.ts` for §3.2's bisection were removed; `diff`
  against the saved post-fix version confirms the shipped file is
  byte-identical to the fix with no leftover instrumentation.
- `~/Proyectos/urdira-benchmark/v4-fold/sc-micro/` (the standalone thread/
  CoreML micro-benchmark script) and `/tmp/sc-bench-corpus`,
  `/tmp/sc-latency-corpus` (scratch corpus copies used for the throughput/
  latency measurements) were scratch-only, under `/tmp` or the designated
  scratch root, and are not part of this commit.
- `CARGO_TARGET_DIR=.claude/worktrees/cargo-target-sc` (used once, per §0's
  instructions, to verify `cargo build --release -p urdira-indexing-worker`
  still compiles clean -- it does, 39.34s, no code changes to Rust in this
  task) was removed after use.
- No daemon was left running.

## Final counts (literal)

- Files changed: `packages/daemon/src/runtime.ts`, `packages/daemon/src/semantic-maintenance-process.ts`,
  `packages/engine/src/canonical-query-data-port.ts`, `packages/engine/src/index.ts`,
  `packages/engine/src/native-query-snapshot-port.ts`, `packages/engine/src/semantic-reconciler.ts`,
  `tests/semantic-maintenance.test.ts` (modified); `packages/daemon/src/semantic-v4-wiring.ts`,
  `packages/engine/src/semantic-entity-source-v4.ts`, `tests/phase-daemon-v4-semantic.test.ts`,
  `tests/semantic-entity-source-v4.test.ts` (new); `docs/decisions/16-semantic-search-wiring.md`,
  `docs/decisions/17-entity-grain-semantic-documents.md` (amended); this file (new).
- Required verification suite: 11 files, 306 tests passed, 1 skipped (expected).
- `pnpm typecheck`: 0 new errors (6 pre-existing, unrelated, verified present on clean `8ff1981`).
- `pnpm lint`: 0 errors.
- Embed throughput (this machine, unchanged from before this session): ~75 segs/s single-process.
- Query latency (45-file workspace): p50 395.7ms -> 328.4ms, p99 493.4ms -> 444.7ms.
- Query latency (2-3-file workspace): p50 42.7ms/p99 67.3ms, unaffected by this session's fixes (already fast).
