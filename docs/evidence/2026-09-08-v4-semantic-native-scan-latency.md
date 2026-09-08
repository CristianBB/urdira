# Frente S-I: native resident-buffer top-K kernel and full-scale semantic
# query latency

Plan `resilient-knitting-twilight.md` §0 (performance without compromising
integrity; exactness intact per decision 06). Repo `/Users/Cristian/Proyectos/urdira`,
main `676bc84` at task start (S-H merged). Worked in worktree
`.claude/worktrees/agent-a2ebfed04feb69a34`, branch `frente-si-native-scan`.
Input: `docs/evidence/2026-09-08-v4-semantic-sweep-and-full-scale-latency.md`
(S-H's own final measurement and root-cause hypothesis: the entity-lane
exact scan costs 581.4ms even in its cheapest bounded form, attributed to
`nativeTopKChunked`'s own per-call marshaling/chunking overhead --
`packages/engine/src/semantic-retrieval.ts` -- rather than floating-point
compute).

## The problem, precisely

`exactVectorScan`'s native path (`nativeTopKChunked`) re-derives a fresh
packed candidate byte buffer, crosses the N-API boundary, and has
`crates/urdira-native-core`'s `exact_vector_top_k` decode every candidate
from wire bytes to a freshly allocated `Vec<f64>` and then fully SORT the
whole candidate list -- on EVERY query, even though the underlying vector
data (`canonical-query-data-port.ts`'s `residentVectorCache`) is already a
single contiguous, generation-stable buffer that does not change between
queries. At n8n's own scale (72,922 entity-grain candidates), the
4,095-candidate-per-call native batch bound forces ~18 chunks per query,
so this marshaling/decode/sort cost is paid 18 times per query, dominating
measured latency (581.4ms bounded, 1,415.9ms uncapped) despite the
underlying FLOP count (72,922 x 384-dim dot products) being sub-10ms
territory on this hardware.

## The fix: a resident-buffer, single-call kernel

### Rust (`crates/urdira-native-core/src/lib.rs`, "Frente S-I" section)

- `register_vector_buffer(handle_id, generation, dimensions, data: Vec<f32>)`
  -- copies a contiguous `f32` buffer into a global, mutex-guarded registry
  keyed by `handle_id`, tagged with an opaque `generation` counter. Called
  ONCE per generation (a cache miss on the JS side), never once per query.
- `exact_top_k_contiguous(handle_id, generation, query: &[f32], k, metric)`
  -- looks up the registered buffer, rejects (stale-generation error) if
  `generation` does not match, then computes distances for every candidate
  (upcasting each `f32` element to `f64` as it's read, matching this same
  file's pre-existing `vector_distance`'s precision -- an 8-lane chunked
  accumulation for auto-vectorization, `dot_f32_as_f64`/`squared_l2_f32_as_f64`),
  optionally in parallel via `rayon` when candidate count exceeds
  `RESIDENT_VECTOR_PARALLEL_THRESHOLD` (50,000 -- n8n's own 72,922-candidate
  entity lane crosses it), then partial-selects the k smallest via
  `select_nth_unstable_by` (expected O(n), never worse than the O(n log k) a
  binary-heap selection would cost) and sorts only that k-sized slice.
- Exactness: the caller registers `data` pre-sorted by candidate identifier
  ascending (`canonical-query-data-port.ts`'s own `packResidentLane`, reusing
  `semantic-retrieval.ts`'s `utf8Compare`) -- `exact_top_k_contiguous`
  tie-breaks by ascending buffer INDEX, which is therefore ascending
  identifier order too, exactly matching every other exact-vector path in
  this crate and the JS oracle.
- New napi bindings: `registerVectorBuffer`/`exactTopKContiguous`
  (`crates/urdira-native-node/src/lib.rs`), `NATIVE_API_VERSION` 16 -> 17.

### TypeScript wiring

- `packages/native`: `types.ts` (`NativeBinding.registerVectorBuffer`/
  `exactTopKContiguous`, `ResidentVectorTopKMatch`), `loader.ts` (version
  bump + required-function check), `index.ts`
  (`createNativeResidentVectorTopKPort`).
- `packages/engine/src/semantic-retrieval.ts`: a SEPARATE, deliberately
  STATEFUL port (`ResidentVectorTopKPort`/`configureResidentVectorTopKPort`)
  from the existing call-owned `NativeExactVectorTopKPort`, plus
  `residentExactVectorScan` -- the JS-side contract (register only when
  asked, map buffer index back to the caller's own id array, fail closed on
  a malformed native result).
- `packages/engine/src/canonical-query-data-port.ts` (`CanonicalRecordQueryDataPort`,
  `trySemanticSearch` only): `residentLaneBufferCache` (one entry per
  `${workspace_id}:${profile_id}:${executable_binding_id}:{artifact,entity}`
  handle) + `residentLaneScan`, gated on `pathPrefixes.length === 0` (a path
  filter narrows the per-query candidate set in a way a once-per-generation
  buffer cannot reflect -- falls back to `exactVectorScan` unchanged in that
  case) and this profile being plain `float32`. Freshness is keyed on the
  RAW `allVectors` array reference (stable across repeat queries at an
  unchanged generation, per `semantic_vectors`'s own resident-cache
  identity guarantee) -- NOT on the lane-derived `artifactVectorsForScan`/
  `entityVectorsForScan` arrays, which `dedupeVectorsByOwner`/`.filter(...)`
  reallocate on every single call; keying on those would re-register (a full
  buffer copy + native call) on every query, defeating the entire point.
- `apps/urdira/src/index.ts`: `configureResidentVectorTopKPort` wired
  alongside the pre-existing native ports in `defaultDaemonOptions`.
- `URDIRA_DEBUG_TIMING=1` phase decomposition added directly to
  `trySemanticSearch` (`snapshot_reads`, `embed_query`, `artifact_scan`,
  `entity_scan`, `lexical_lane`, `hydration`, `coverage_view`, `render`,
  `total`), mirroring `workspace-indexing-session.ts`'s existing convention.

## Tests

- `crates/urdira-native-core/src/lib.rs`, `resident_vector_tests` (7 new):
  squared-L2 ranking order; exact-tie break by ascending index; `k > N`
  caps to `N`; stale-generation rejection; unregistered-handle rejection;
  a 733-candidate/12-dim random corpus cross-checked against this file's
  own `exact_vector_top_k` oracle (sequential path); a 60,001-candidate/
  8-dim random corpus with cosine metric cross-checked against the same
  oracle, deliberately past `RESIDENT_VECTOR_PARALLEL_THRESHOLD` to exercise
  the `rayon` parallel path specifically.
- `tests/phase10-semantic.test.ts`, `Frente S-I: residentExactVectorScan`
  (7 new): undefined when unconfigured; empty-candidate short circuit
  touches the port zero times; registers only when `needsRegister`, maps
  index -> id correctly; skips registration on a cache hit; caps `k` to the
  candidate count; fails closed on a result-count mismatch; fails closed on
  an out-of-range or duplicate index.
- `tests/phase-canonical-query-data-port.test.ts` (+1): a real
  `SqliteCanonicalQuerySnapshotPort` + `createLocalHashProvider` workspace,
  with a byte-correct reference `ResidentVectorTopKPort` fake (computes real
  cosine/squared-L2 distances from the registered buffer on every call, no
  cached-ranking shortcut) -- proves `core:search_semantic`/
  `core:search_hybrid` return the IDENTICAL ranking as the default path,
  AND that a second identical query at the same generation triggers NO new
  buffer registration (the artifact-lane count is unchanged across a
  `core:search_hybrid` call too).
- `tests/native-loader.test.ts`, `tests/native-logical-digest-port.test.ts`:
  fake `NativeBinding` objects extended with the two new required methods.
- `tests/npm-packaging.test.ts`, `tests/rust-release-artifacts.test.ts`,
  `tests/native-acceleration-campaign.test.ts`: `binding_api: 16` ->
  `binding_api: 17`.

`pnpm typecheck`/`pnpm lint`: clean (three pre-existing fixture-path errors
and one pre-existing `phase-daemon-v4-scan.test.ts` error, confirmed
unrelated -- git status shows none of those files touched this session).
`cargo fmt`/`cargo clippy --workspace --all-targets`: clean, zero warnings.

## Measurement methodology

Real daemon (`DaemonRuntime.start`/`DaemonClient`, no CLI wrapper -- a
throwaway harness under `tests/_scratch-si-n8n-embed.test.ts`, NOT
committed, mirroring S-F's/S-G's/S-H's own ad-hoc methodology), real
`urdira-indexing-worker` binary, real native structural-store addon, MiniLM
neural provider (`core:onnx-xenova-all-minilm-l6-v2-384`, model already
resident under a local copy of `~/.urdira/models`, no download), all four
native ports explicitly wired (`configureNativeLogicalDigestPort`/
`configureNativeExactVectorTopKPort`/`configureResidentVectorTopKPort`/
`configureStructuralKernelPort` via `loadNativeBinding` -- `DaemonRuntime.start`
alone does not wire these; that is normally `apps/urdira/src/index.ts`'s
job, bypassed by a raw-`DaemonRuntime` harness unless done explicitly).
`semantic_shard_count: 3`, `reconciliation_sweep_interval_ms: 20_000`.
Three corpus scales, each a READ-ONLY working copy under
`~/Proyectos/urdira-benchmark/v4-fold/si-{n8n,cli,100}-scratch/corpus`:

- **n8n full** (184MB, the same corpus S-C through S-H measured against):
  `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`.
- **`packages/cli`** (the SAME named subset S-F/the embed-stall-root-cause
  doc measured against, 2,492 files): `n8n-corpus-2026-09-02/packages/cli`.
- **100 files**: the first 100 `.ts` files (by `find` order) under that same
  `packages/cli` subset.

`core:workspace_add` -> poll `structural_ready` -> poll `semantic.current`
-> 1 warm-up (excluded) + 20x `core:search_semantic` + 20x
`core:search_hybrid` (24 distinct natural-language query strings cycling,
`query_class: "natural_text"`, `filter: {}`, `snippets: {mode: "none"}`,
`response_budget: {max_items: 50, max_characters: 20000}` -- matching
S-F's/S-G's/S-H's own methodology exactly so the numbers are directly
comparable). Baselines cited below are this repo's own PUBLISHED prior
measurements (`docs/evidence/2026-09-08-v4-semantic-sweep-and-full-scale-latency.md`
for n8n full, `docs/evidence/2026-09-08-v4-semantic-embed-stall-root-cause.md`
for `packages/cli`), not re-measured from scratch this session -- a
same-repo, same-methodology, same-corpus comparison already exists for
both, and re-running the OLD code costs an entire second ~38-minute n8n
embed for no new information.

## A live methodology trap, found and fixed before any number below is
## trustworthy

The FIRST two full-scale runs this session (one full n8n embed, one
`packages/cli` embed) produced numbers statistically indistinguishable from
the pre-fix baseline -- `residentLaneScan`'s own new `URDIRA_DEBUG_TIMING`
diagnostic (added specifically to investigate this) printed
`SKIP: port not configured` on every single call. Root cause: the harness
imported `configureResidentVectorTopKPort`/`configureNativeExactVectorTopKPort`/
`configureNativeLogicalDigestPort` from `../packages/engine/src/index.js`
(a relative path into TS SOURCE, transformed on the fly by vitest's
vite-node), while `packages/daemon/src/runtime.ts` (also loaded via a
relative path, but itself importing `CanonicalRecordQueryDataPort` etc. via
the PACKAGE SPECIFIER `"@urdira/engine"`) resolves that specifier natively
to `packages/engine/dist/index.js` -- the ALREADY-BUILT output. These are
TWO DIFFERENT loaded module instances of `semantic-retrieval.js`, each with
its OWN module-level `activeResidentPort` variable -- configuring the
`src/` instance left the REAL runtime's `dist/` instance permanently
unconfigured, with no error (by design: `residentLaneScan` degrades
silently to `exactVectorScan` when the port is absent). `tests/app-native-runtime-binding.test.ts`
had already independently established the fix for this exact trap
(importing the configure functions from `../packages/engine/dist/index.js`
specifically); the harness was corrected to match, rebuilt, and re-verified
at the 100-file scale (`residentLaneScan(...) HIT`, `entity_scan`/
`artifact_scan` at 0-3ms) before re-running both full-scale corpora. All
numbers below are from the CORRECTED harness.

## Results

### n8n full scale (93,060 vectors: 72,922 entity, 20,138 artifact)

`semantic.current`: **2,118,328ms (35.3 minutes)** from `workspace_add`
(no restarts observed -- consistent with S-H's own 2,238,157ms/~37.3-minute
figure at the same corpus and settings; the small difference is normal
run-to-run variance on a shared machine, not a regression).

Phase decomposition (`URDIRA_DEBUG_TIMING=1`, warm, representative calls
after the resident buffers were built once):

| phase | before (S-H, `nativeTopKChunked`) | after (resident kernel) |
|---|---:|---:|
| entity-lane scan (bounded, `limit: 800` of 72,922) | 581.4ms | **2-3ms** |
| entity-lane scan (uncapped escalation, all 72,922) | 1,415.9ms | not triggered (800-segment fast path already yields 100 distinct documents at this scale) |
| artifact-lane scan (`limit: 100` of 20,138) | 54.0ms | **3ms** |
| `semantic_vectors` snapshot reads (5 combined port calls, warm) | ~10ms (S-H's own lever) | 20-24ms |
| `search_hybrid`'s lexical lane (`search_literal`) | not decomposed by S-H | 5-35ms |
| hydration (`records_by_ids`/`records_by_artifact_versions` + 1-line snippets) | not decomposed by S-H | 43-52ms |
| coverage view + render | not decomposed by S-H | 0-1ms |
| **this function's own internal total** (`trySemanticSearch`, before the IPC round trip) | -- | **113-163ms** |
| remainder (IPC/query-engine dispatch/envelope, outside `trySemanticSearch`) | ~640-1,050ms (S-H's own unattributed remainder, dominated by the scan cost this frente removed) | **~5-25ms** (end-to-end sample minus this function's own internal total) |

The scan itself (both lanes combined) went from 581.4-1,999.9ms to
**5-6ms** -- essentially eliminating the phase this frente targeted. The
n8n-scale physical estimate from this task's own brief (72,922 x 384-dim
dot products, tens of millions of MACs, "10-30ms on a core with SIMD") is
now the right order of magnitude for what is actually measured, confirming
S-H's own attribution (marshaling/chunking overhead, not FLOPs) was
correct.

p50/p95/p99 (20 samples each, full end-to-end `core:query` round trip):

| operation | metric | S-H baseline | this frente | improvement |
|---|---|---:|---:|---:|
| `core:search_semantic` | p50 | 1,588.3ms | **123.97ms** | **12.8x** |
| `core:search_semantic` | p95/p99 | 1,722.2ms | **134.99ms** | **12.8x** |
| `core:search_semantic` | min/max | 1,572.2 / 1,722.2ms | 117.87 / 134.99ms | -- |
| `core:search_hybrid` | p50 | 1,620.2ms | **154.94ms** | **10.5x** |
| `core:search_hybrid` | p95/p99 | 2,192.7ms | **178.33ms** | **12.3x** |
| `core:search_hybrid` | min/max | 1,576.4 / 2,192.7ms | 128.85 / 178.33ms | -- |

(p95 and p99 collapse to the sample max at n=20, same small-sample
percentile-index artifact S-H's own table noted.)

**Target (p99 <= 250ms): MET.** `core:search_semantic` p99 134.99ms,
`core:search_hybrid` p99 178.33ms -- both comfortably under the plan's
250ms n8n-scale ceiling, with headroom to spare. No approximation, no
sampling, no ANN: decision 06's exactness is unchanged (see Tests, above,
and the Rust-level oracle cross-checks) -- this is a pure latency fix.

### `packages/cli` scale (13,454 vectors: 10,964 entity, 2,490 artifact --
### exact match to S-F's own published counts, confirming corpus parity)

`semantic.current`: 294,398ms (4.9 minutes) from `workspace_add`.

Representative warm phase decomposition (`core:search_hybrid`):
`snapshot_reads=1ms, embed_query=1ms, artifact_scan=0ms, entity_scan=2ms,
lexical_lane=2ms, hydration=13-14ms, total=25-26ms`.

| operation | metric | S-F baseline | this frente | improvement |
|---|---|---:|---:|---:|
| `core:search_semantic` | p50 | 256.6ms | **29.67ms** | **8.6x** |
| `core:search_semantic` | p99 | 308.1ms | **33.06ms** | **9.3x** |
| `core:search_hybrid` | p50 | 545.3ms | **30.61ms** | **17.8x** |
| `core:search_hybrid` | p99 | 903.1ms | **32.38ms** | **27.9x** |

**Target (p99 <= 100ms for a small/medium corpus): MET** with over 3x
headroom on both operations.

### 100-file scale

No prior published baseline at exactly this scale; reported standalone.
`semantic.current`: 18,033ms. Representative warm phase decomposition
(`core:search_hybrid`, 457 entity candidates, 100 artifact candidates):
`snapshot_reads=0ms, embed_query=1ms, artifact_scan=0ms, entity_scan=0ms,
lexical_lane=0-1ms, hydration=4-6ms, total=7-9ms`.

| operation | metric | this frente |
|---|---|---:|
| `core:search_semantic` | p50 | **14.27ms** |
| `core:search_semantic` | p99 | **20.95ms** |
| `core:search_hybrid` | p50 | **13.85ms** |
| `core:search_hybrid` | p99 | **17.03ms** |

**Target (p99 <= 100ms): MET** with over 4x headroom.

### What's left above the scan floor (n8n scale)

The scan is no longer the dominant cost at any scale measured. At n8n
scale, the remaining ~113-178ms end-to-end budget splits roughly as:
hydration ~43-52ms (records_by_ids/records_by_artifact_versions batched
lookups + bounded-concurrency 1-line snippets -- already batched/bounded
per Frente S-D, not re-touched this session), `semantic_vectors` snapshot
reads ~20-24ms even WARM (five Promise.all-combined port calls -- worth a
future look at whether all five still need to run on every call), the
lexical lane ~5-35ms for hybrid only (`search_literal`, FTS-backed,
already pushed down), and an unattributed ~5-25ms gap between this
function's own internal `total` and the full IPC round trip (`DaemonClient.call`
-> IPC socket -> `QueryEngine` dispatch -> response envelope), not
decomposed further this session. None of these individually or combined
threaten the 250ms n8n target with 90-135ms of headroom remaining; the
plan's own performance floor for this frente is met without needing to
touch any of them.

## Final counts (literal)

- Files changed: `crates/urdira-native-core/src/lib.rs` (+~470 lines: the
  "Frente S-I" resident-kernel section + 7 new `resident_vector_tests`),
  `crates/urdira-native-core/Cargo.toml` (+`rayon` dependency),
  `crates/urdira-native-node/src/lib.rs` (+2 napi bindings,
  `NATIVE_API_VERSION` 16 -> 17), `packages/native/src/types.ts` (+`ResidentVectorTopKMatch`,
  `NativeBinding` +2 methods), `packages/native/src/loader.ts` (version
  bump + required-function check), `packages/native/src/index.ts`
  (+`createNativeResidentVectorTopKPort`), `packages/engine/src/semantic-retrieval.ts`
  (+`ResidentVectorTopKPort`/`configureResidentVectorTopKPort`/
  `residentExactVectorScan`, `utf8Compare` exported), `packages/engine/src/canonical-query-data-port.ts`
  (`CanonicalRecordQueryDataPort`: +`residentLaneBufferCache`/
  `residentLaneScan`/`packResidentLane`/`float32ViewOf` + `URDIRA_DEBUG_TIMING`
  phase instrumentation in `trySemanticSearch`), `packages/engine/src/index.ts`
  (+5 new re-exports), `apps/urdira/src/index.ts` (+1 wiring line),
  `tests/phase10-semantic.test.ts` (+7 tests), `tests/phase-canonical-query-data-port.test.ts`
  (+1 test), `tests/native-loader.test.ts`/`tests/native-logical-digest-port.test.ts`
  (fake `NativeBinding` +2 methods), this file (new),
  `docs/decisions/06-semantic-search-ranking.md` (amendment). Checked, NOT
  touched: `scripts/native-release.mjs`'s own `binding_api: 16` is a
  SEPARATE, independently-versioned release-manifest constant (release
  packaging/staging identity), not the same counter as `packages/native/src/loader.ts`'s
  `NATIVE_API_VERSION` -- `tests/npm-packaging.test.ts`/`tests/rust-release-artifacts.test.ts`/
  `tests/native-acceleration-campaign.test.ts` all still pass unchanged
  against it, confirmed live rather than assumed.
- Rust tests: `cargo test -p urdira-native-core --offline` -- 8 pre-existing
  + 7 new `resident_vector_tests` = 8 + existing suite green (see Tests
  section for names); `cargo test -p urdira-native-node --offline` -- 3/3
  green (unchanged). `cargo fmt --check`/`cargo clippy --workspace --all-targets`:
  zero warnings.
- TS tests (targeted, real native addon): `tests/native-api.test.ts` 6/6,
  `tests/architecture-guardrails.test.ts` unchanged, `tests/native-query-snapshot-port.test.ts` +
  `tests/phase-canonical-query-data-port.test.ts` 129/129 (113/113 for the
  latter alone, +1 new), `tests/exact-vector-top-k-benchmark.test.ts` +
  `tests/phase10-semantic.test.ts` 29/29 (24/24 for the latter alone, +7
  new), `tests/phase-daemon-v4-semantic.test.ts` 4/5 (1 skip-guard,
  re-confirmed green after an initial run-under-load flake unrelated to
  this frente's own change -- see `feedback_worktree_subagents_base_and_node_modules.md`'s
  documented "flakes under load" trap). `pnpm typecheck`/`pnpm lint`: clean
  (3 pre-existing fixture-path errors + 1 pre-existing `phase-daemon-v4-scan.test.ts`
  error, confirmed unrelated via `git status`).
- A live bug found and fixed mid-session (documented above in its own
  section): the measurement harness's own module-instance duplication
  trap, which silently made the first two full-scale runs measure the
  OLD code path with no error. Two commits worth of implementation code
  were correct from the start; only the (uncommitted, throwaway)
  measurement harness needed the fix.
- n8n query latency, full scale (93,060 vectors), S-H baseline -> this
  frente: `core:search_semantic` p50 1,588.3 -> 123.97ms (12.8x), p99
  1,722.2 -> 134.99ms (12.8x); `core:search_hybrid` p50 1,620.2 ->
  154.94ms (10.5x), p99 2,192.7 -> 178.33ms (12.3x). **Target (p99 <=
  250ms) MET** at n8n scale, and at `packages/cli` scale (13,454 vectors,
  p99 33.06ms/32.38ms) and the 100-file scale (p99 20.95ms/17.03ms), both
  against a 100ms target.
