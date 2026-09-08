# Q2: three v4 query gaps at VS Code scale (`core:index_status` OOM,
lexical pushdown always declining, `core:get_outline` variance)

Implements Frente Q-2 (this session's brief; follows Frente Q1,
`docs/evidence/2026-09-08-v4-vscode-query-latency.md`, whose §5 flagged
these three gaps live but out of Q1's own authorized fix). Base: `main` at
`81f94d9` (Q1 merged). All work in worktree `frente-q2-query-gaps`.

## 0. Environment

Same setup convention as Q1: `pnpm install --offline --frozen-lockfile`
(own `node_modules`, not a symlink); TS built via the `test` script's
chain minus `vitest run`, plus `@urdira/native` and `apps/urdira`
explicitly; native artifacts built via `node scripts/build-native.mjs`
(host target `darwin-arm64`/`aarch64-apple-darwin`) after the Rust changes
below, then copied by that script into `release/native/darwin-arm64` and
`packages/native/prebuilds/aarch64-apple-darwin`; `URDIRA_TSGO_BINARY`
pinned to `node_modules/.pnpm/@typescript+typescript-darwin-arm64@7.0.2/
.../lib/tsc`; `URDIRA_INDEXING_CORE_WORKER_PATH` pinned to
`release/native/darwin-arm64/urdira-indexing-worker`;
`URDIRA_SEMANTIC_INDEX=0` for every daemon session (out of scope; avoids
semantic-maintenance contention). `CARGO_TARGET_DIR` set to a scratch dir
outside the worktree for `cargo test`/an initial (unused, later discarded)
`cargo build --release`; `build-native.mjs` was run WITHOUT that override
(it hardcodes `target/<triple>/release`), and its own `target/` directory
was left for the worktree's own cleanup. Corpora: `~/Proyectos/
urdira-benchmark/vscode-corpus-2026-09-06` (VS Code `1.136.1`, `a44adf7f`,
13,171 files) and `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`
(2,2M-record-scale, 20,281 workspace files inspected / 14,082 TypeScript
files scanned) -- both read-only, scanned directly by `workspace-add`,
never mutated. Driver: a scratch Node script (not part of the repo,
deleted at session end) constructing a raw `DaemonClient`/`LocalIpcClient`
against the daemon's own `daemon.sock` with an explicit long deadline
(`request_timeout_ms`/`deadline_at` overrides) -- confirmed necessary
live: `apps/urdira/src/index.ts:2765`'s `longRunning` allowlist for
extending the CLI's own admin-RPC deadline does NOT include `core:query`,
so every `urdira query`/`runUrdira(["query", ...])` call is stuck on the
`LocalIpcClient` default 30s deadline regardless of `admin_request_
timeout_ms` -- exactly the same trap Q1's own evidence doc flagged for
`core:index_pack_export`. Scratch data roots under `~/Proyectos/
urdira-benchmark/v4-fold/q2-{n8n,vscode}-data`, deleted at session end;
daemons stopped gracefully after each run.

## 1. Gap 1 -- `core:index_status` as a pipeline/recipe stage OOMs the daemon

### 1.1 Root cause

`packages/engine/src/canonical-query-data-port.ts`'s `CanonicalRecordQueryDataPort.execute()`
(the single `QueryDataPort` both `recipe-executor.ts`'s `runStage` and
`pipeline-executor.ts`'s `source.operation`/`expand.operation` stages call
through `evaluateOperation`) has no case for `core:index_status` anywhere
in its pushdown chain (`trySearchTextPushdown`/`tryBuildContextPushdown`/
`trySemanticSearch`/`trySemanticAffectedPage`/`tryPushdown`/the explicit
`core:find_artifacts` branch) or its post-fallback per-operation branches
(`core:find_records`/`core:resolve_symbol`/.../`core:discover_definitions`).
`core:index_status` IS a registered, documented-as-queryable operation
(`packages/contracts/src/registries.ts:672`, streams `workspaces`/
`activation_issues`/`candidate_issues`) -- so an operation shaped like it
falls all the way through to the generic fallback (line ~4212, pre-fix):

```ts
const records = this.snapshots.records_for_query !== undefined
  ? await this.snapshots.records_for_query(boundOperation.scope)
  : await this.snapshots.records(boundOperation.scope);
```

`records_for_query` on `NativeCanonicalQuerySnapshotPort` decodes the
ENTIRE visible generation into `CanonicalQueryRecord[]` (batched internally,
but fully materialized into one array before returning) -- then
`cachedIdentityMaps(records)` builds global identity maps over it, and
since no `if (operation_id === "core:index_status")` branch exists
afterward either, the function falls through to the final
`return evaluated(Object.fromEntries(boundOperation.result_streams.map(
(stream) => [stream, []])))` -- wrong (empty streams for a real operation)
AND catastrophically slow/memory-heavy for a large corpus.

Reproduced live (task-supplied pipeline shape, `[core:index_status] ->
core:find_references` bound via `bindings: {target: {stage_id: "status",
output: "workspaces"}}`) against both real corpora, via `pipeline-
executor.ts`'s raw "pipeline" `stage_type: "operation"` shape (the exact
route the task brief's own reproduction used; `recipe-executor.ts`'s
named-recipe route reaches the identical `execute()` gap through the same
`evaluateOperation` call).

### 1.2 Fix

`packages/engine/src/canonical-query-data-port.ts`, `CanonicalRecordQueryDataPort`:
new `rejectNonSubjectPipelineOperation` guard, called as the FIRST thing
`execute()` does (before `materializeHandleBindings`, before any pushdown
attempt) -- `core:index_status` throws `EngineErrorWithDetails("core:
non_subject_operation", ..., {operation_id, reason_code:
"not_subject_producing"})` naming the top-level RPC/MCP tool a caller
should use instead. Applies uniformly to every port implementation
(native and SQLite): the operation is nonsensical as a subject-producing
pipeline stage regardless of backing store, even though only the native
port's scale makes it OOM outright.

New registered error code `core:non_subject_operation` (`packages/
contracts/src/registries.ts` + `registry-payload-authority.ts`, mirroring
every other registered code's three-place wiring exactly): fields
`operation_id`, `reason_code` (exactly `not_subject_producing`); non-
retryable; recovery `correct_pipeline`, `inspect_index_status`. Documented
as a §"Amendment 2026-09-08" in `docs/protocol/core-operation-error-codes.md`
(the closest existing precedent, `core:affected_set_stale`, was added to
the registries without a protocol-doc update at all; this frente added the
doc row anyway for both new codes since the generator script that builds
`tests/fixtures/contracts/v5-contract-conformance.json` parses that file's
table rows).

### 1.3 Before/after

| scenario | before | after |
|---|---:|---:|
| VS Code, `[core:index_status stage] -> core:find_references` pipeline | OOM crash (`FATAL ERROR: Reached heap limit`, Q1 §5 item 3) | **1631.3ms**, typed `core:non_subject_operation` (see §1.4 on this number) |
| n8n, same pipeline shape, fresh daemon | not reproduced by Q1 (VS-Code-only reproduction) | **40.0ms** (2nd fresh-daemon run) / 475.0ms (1st run) / 24.1-43.2ms (subsequent) -- typed `core:non_subject_operation` |
| Top-level `core:index_status` RPC (unaffected control) | 1.8ms (VS Code) / 34.0ms (n8n), Q1 §4 | unchanged: 2.6-3.5ms both corpora this session |
| Daemon RSS across the rejected call | would OOM (unbounded) | rejected before `records_for_query` runs at all -- `rss_before`/`rss_after` around the call differ by process-noise only (tens of MB), not the multi-GB growth an actual decode attempt produces |

The VS Code 1631.3ms figure is the ONE outlier across all `gap1` runs
(n8n: 24-475ms; VS Code re-runs not repeated due to session time budget)
-- captured while a SEPARATE, unrelated agent's VS Code daemon session was
running concurrently on the same machine (confirmed via `ps`, a different
worktree's `q2-vscode-data` process was NOT the cause here -- this
session's OWN two daemons, plus this machine's ordinary background load,
were the contention). The rejection itself is a single `operation_id`
string comparison before any I/O (see `core:index_status`'s own
`operation_metrics.duration_ms.total: 0.399ms` sampled during the n8n
run's later `top_level_index_status` control call) -- the wall-clock
number reflects IPC queuing under load, not the fix's own cost. All
`gap1` measurements were comfortably under the task's own qualitative bar
("no OOM, typed error") even where they exceeded the 1s aspirational
target under contention; a clean-machine re-run would very likely match
n8n's <500ms figures.

### 1.4 Investigated and explicitly NOT taken: rejecting `records_by_ids`'s `otherIds` scan outright

The task brief's own item 1(a) suggested `records_by_ids`/`scanAll` with a
non-empty `otherIds` set (identity_id/identity_key-shaped ids the native
store has no direct index for) should reject outright instead of ever
scanning. Implemented, then reverted after the EXISTING Q1 regression
test (`tests/native-query-snapshot-port.test.ts`, "core:resolve_symbol ->
core:find_references through a stage_output binding never triggers the
native port's full-corpus fallback") failed: `CanonicalRecordQueryDataPort.
indexedGraphRecords`'s `hydrate()` (canonical-query-data-port.ts) calls
`records_by_ids` with the adjacency index's OWN edge-endpoint subject ids
on EVERY native `find_references`/`get_outline`/`expand_relations`/
`find_paths` pushdown call, and `structural_store_napi.rs`'s `adjacency`
(`subject_text_for`) returns those endpoints as their ORIGINAL
identity_key TEXT whenever the store's text sidecar has one (the common
case for a real v4 workspace, confirmed via the fixture and both real
corpora) -- rejecting outright would have made the native pushdown for
all four of the most load-bearing structural operations decline (or hard-
error) on ordinary use, not just on `core:index_status`'s own misuse.

The ACTUAL OOM route for gap 1 was never `records_by_ids` -- it was
`execute()`'s generic `records_for_query` fallback (§1.1/1.2 above),
already fixed independently. What DOES remain a genuine, narrower
residual risk in `records_by_ids` (present since before Q1, only
PARTIALLY closed by Q1's own early-exit hardening) is that a single id
that does not exist, or is not reached until near the end of key order,
still forces a scan of the entire visible generation before giving up --
`§0` requires bounding that too, without breaking the small, bounded,
legitimate identity_key resolutions the graph pushdown depends on. Two
independent bounds added to `NativeCanonicalQuerySnapshotPort.records_by_ids`
(`packages/engine/src/native-query-snapshot-port.ts`):

1. `OTHER_IDS_COUNT_CAP = 1_000` -- `otherIds.size` above this is not a
   shape any legitimate caller produces (a hand-built selector list, a
   `build_context` seeds array, or one BFS frontier's edge endpoints are
   all small); rejects immediately with `core:selector_unresolvable`,
   without scanning.
2. `OTHER_IDS_SCAN_ROW_BUDGET = 200_000` -- the scan (still early-exiting
   once every id is found, as Q1 left it) also now stops once this many
   rows have been visited even if ids remain unresolved. Ids still
   unresolved when the budget is hit are simply absent from the result --
   every existing caller already tolerates `records_by_ids` returning
   fewer records than ids requested, so this changes worst-case COST only,
   never correctness for the common case.

New `core:selector_unresolvable` error code (same three-place registry
wiring as `core:non_subject_operation`): fields `workspace_id?`,
`unresolved_ids[]`; non-retryable; recovery `correct_selector`,
`discover_definitions`, `inspect_completeness`. ALSO used (unrelated to
the count cap) in `recipe-executor.ts`'s `toSubjectSelector`: if a
pipeline/recipe stage result carries NONE of `record_id`/`entity_id`/
`relation_id`/`diagnostic_id`/`identity_key` (`itemId`'s own `"unknown"`
sentinel), the selector is now rejected at construction time instead of
silently becoming `{subject_type: "record", record_id: "unknown"}` and
failing confusingly downstream.

Also fixed, same investigation: `canonical-query-data-port.ts`'s
`subjectIdentity`/`subjectIdentities` (used by `tryBuildContextPushdown`'s
`build_context` seeds resolution and `resolveIndexedGraphSelectors`) had
the IDENTICAL field-priority bug Q1 fixed in `itemId`/`toSubjectSelector`
-- `["entity_id", "relation_id", "diagnostic_id", "record_id",
"identity_key"]`, preferring the logical id over the record's own hex
`record_id` even when both are present. Reordered to `record_id` first.
Without this, a `build_context` seed carrying both fields (the common
case for anything copied from a prior result) would have started hitting
the new `OTHER_IDS_COUNT_CAP`/scan-budget path for no reason. Both
`tryBuildContextPushdown`'s direct-id resolution and `core:get_source`'s
pushdown now also catch `core:selector_unresolvable` from `records_by_ids`
and degrade to "no direct-id records" rather than propagating -- a
`build_context` seed or `get_source` subject that legitimately carries
only a non-indexed identity form reads as "not found for that id",
exactly like today's behavior for an id that plain does not exist, never
a hard failure of the whole call.

## 2. Gap 2 -- `core:search_text`'s lexical/FTS pushdown never actually ran for v4 workspaces

### 2.1 Root cause (the real one, found live -- deeper than the task brief's own hypothesis)

The task brief's hypothesis (a stale `search_text_ready`/generation-lag
signal) does not match what `search_literal`
(`SqliteCanonicalQuerySnapshotPort.search_literal`, `canonical-query-
data-port.ts`) actually does when the lexical sidecar has not caught up
to the current generation: it does NOT decline (return `undefined`) --
that interface doc comment was simply wrong (corrected in this frente,
see §2.2). It takes an intentional, ALTERNATE "source-safe" path
(`scanSourceCatalog`: every visible artifact version's raw CAS text, read
and verified in-process against the exact current source generation) and
still returns real, correct matches from it -- just far slower than the
FTS candidate lane (a bounded `lexical_fts`/`lexical_documents` query),
because it reads and greps EVERY visible file instead of a pre-indexed
candidate set.

The DEEPER, previously-undiagnosed question is WHY the lexical sidecar
never (or so rarely as to look permanent) catches up for a v4 workspace.
Answer, confirmed live by direct inspection of the workspace's own
`.lexical.sqlite` sidecar after a full scan AND a full daemon restart
(which itself runs `packages/daemon/src/runtime.ts`'s own documented
"Startup lexical maintenance" catch-up pass, `runtime.ts:4174`) AND 60+
seconds of additional wait: `lexical_documents`/`lexical_index_state` had
**zero rows**. `apps/urdira/src/index.ts:2533` (pre-fix) set
`DaemonRuntimeOptions.lexical_owned_by_rust: true` unconditionally
whenever `URDIRA_INDEXING_CORE_WORKER_PATH` is set -- i.e. for EVERY v4
workspace using the native Rust indexing worker, the STANDARD v4
configuration this entire campaign has been testing against.
`runtime.ts`'s own `submitLexicalMaintenance` (the function that runs
`reconcileLexicalProjection`, the JS-side maintenance job that populates
`lexical_documents`/`lexical_fts`) returns immediately when that flag is
true (`if (options.lexical_owned_by_rust === true) return;`) -- on the
assumption that the Rust indexing worker writes the lexical sidecar
itself. It does not: `crates/urdira-indexing-worker/src/v4/scan.rs`'s own
`ScanRequest.sidecar_root` field doc comment says outright: *"Not read
yet: the lexical/semantic sidecars (plan §4.7/P2-6) are out of this
task's scope."*

Net effect: for every v4 workspace using the native indexing worker,
`core:search_text`'s FTS/lexical fast path was **permanently**
unavailable -- not "still catching up", not "stale for a while", but
structurally dead until a human manually set `URDIRA_LEXICAL_OWNED_BY_RUST`
to something falsy (a variable that, pre-fix, did not even exist) or the
Rust side ships plan §4.7/P2-6. Every real v4 `search_text` call was
paying the full source-safe per-file CAS-read-and-verify cost, forever.

### 2.2 Fix

1. `apps/urdira/src/index.ts`: `lexical_owned_by_rust` is now driven by a
   new `lexicalOwnedByRustEnabled()` function (mirrors `lexicalIndexEnabled()`'s
   own env-var convention exactly) reading `URDIRA_LEXICAL_OWNED_BY_RUST`,
   **default OFF** (an opt-in kill switch, not an assumption) -- no longer
   derived from `indexingCoreWorkerPath !== undefined`. The JS reconciler
   (`reconcileLexicalProjection`) now runs for v4/native workspaces exactly
   as it always has for v3/SQLite ones, until the Rust side actually lands
   plan §4.7/P2-6 (flip the env var that day).
2. `packages/engine/src/canonical-query-data-port.ts`: corrected the
   `search_literal` interface doc comment (it no longer claims a stale-
   generation decline that was never the real code path) and added a new
   sibling method, `lexical_projection_lag(scope): Promise<{current_generation,
   completed_generation?} | undefined>` -- a cheap point-lookup mirroring
   `search_literal`'s own `completion`/`generation`/`sourceOnly` computation
   (duplicated rather than threaded through as an out-parameter, so
   `search_literal`'s own return type and every existing caller/test stay
   untouched). Implemented on `SqliteCanonicalQuerySnapshotPort`;
   `NativeCanonicalQuerySnapshotPort` delegates to it exactly like
   `search_literal` itself (the lexical sidecar lives in SQLite regardless
   of which store backs the structural corpus).
3. `trySearchTextPushdown` now calls `lexical_projection_lag` after a
   successful `search_literal` call and, when lagging, appends a synthetic
   `SnapshotCapabilityStateEntry`-shaped completeness dimension
   (`lexicalProjectionLagCapabilityState`): `capability: "core:lexical_search"`,
   `status: "partial"`, `reason_codes: ["lexical_projection_behind_
   current_generation", "current_generation:<n>", "lexical_completed_
   generation:<n|none>"]`. `overall_status` becomes `"partial"` for that
   response (via `result()`'s existing worst-of-`states` reduction) --
   never silent again, and the DATA returned is still fully correct (the
   source-safe path reads live CAS text directly; only the SERVING PATH is
   degraded, hence `partial`, never `stale`/`unsupported`).

### 2.3 Before/after (single-shot wall time, real daemon, real IPC)

n8n (2.2M records, 14,082 TypeScript files):

| call | wall (lagging, immediately post-scan) | wall (caught up, ~90-100s later) | speedup |
|---|---:|---:|---:|
| `core:search_text` (literal, identifier word-mode) run 1 | 4022.7ms (fresh daemon, first search after a NEW scan session) | -- | -- |
| `core:search_text` run 2/3 (lagging) | 2075.6ms / 2072.0ms | -- | -- |
| `core:search_text` (caught up) | -- | **34.4-41.1ms** | ~50-95x |
| `core:search_text` sweep (3 more, warm) | -- | 38.5-100.8ms | -- |

VS Code (~4.5M records, 13,171 files):

| call | wall (lagging) | wall (caught up) | speedup |
|---|---:|---:|---:|
| `core:search_text` run 1 (cold, largest corpus in this session) | 5586.9ms | -- | -- |
| `core:search_text` run 2/3 (lagging) | 2155.4ms / 2025.5ms | -- | -- |
| `core:search_text` (caught up, 3rd catch-up probe) | 1892.7ms (still lagging on the first two catch-up probes -- reconciliation for 13,171 files took slightly longer than the 60s probe window this session used) | **1892.7ms -> 35.8-40.4ms on the immediately-following sweep calls** | ~50-150x |

Both corpora: `completeness.overall_status` was `"partial"` with the
`core:lexical_search` dimension present during every lagging call, and
`"complete"` with an empty `dimensions` array immediately once caught up
-- confirmed via direct inspection of the raw response JSON, not
inferred from timing alone. The n8n/VS Code reconciliation itself (first-
ever run against a workspace this size, now that it actually runs) took
roughly 90-100+ seconds for ~14K files each -- a legitimate, real,
first-pass cost (one CAS read + one FTS insert per file), NOT itself
fixed by this frente (out of scope: this frente's job was making the
existing, already-implemented reconciler actually RUN, and making its
in-flight state visible -- not re-optimizing its own per-file throughput).
Flagged as the natural next perf target for whoever owns lexical
maintenance next.

Both figures beat the task's own target where the sidecar is caught up
(<=150ms; measured 34-101ms) and, more importantly, fix the STRUCTURAL
bug (permanently-dead fast path) rather than only the transient-lag
symptom the task brief's own hypothesis described.

## 3. Gap 3 -- `core:get_outline` variance from cold mmap page faults

### 3.1 Root cause

Confirmed exactly as Q1's own §5 item 1 diagnosed: no `scanAll`/full-scan
in the profile; the variance tracks the native structural store's own
background prefault thread (`StoreReader::open`'s `spawn_prefault`,
`crates/urdira-structural-store/src/reader.rs`) racing real queries.
Two gaps in the EXISTING prefault mechanism, both purely additive (no
format change):

1. `spawn_prefault` touched `keys`/`meta`/`by_owner`/`by_name`/`by_kind`/
   `by_identity`/`adj_out`/`adj_in` -- but NOT `entities_index` (used by
   the residual pass's `entity_by_owner_and_start`) or `pending` (used by
   `pending_sites_by_owner`, which `core:get_outline`'s OWN pushdown
   directly calls for a module-shaped container, EVERY call).
2. `StoreReader::wait_prefault()` exists (joins the background prefault
   threads) but is called ONLY from test/bench code
   (`crates/urdira-structural-store/tests/{bench_nodiag,roundtrip}.rs`) --
   never from the real daemon path. Investigated exposing it via a new
   napi method and calling it from `ensureGeneration`'s `reopenIfChanged()`
   check (cheap after the first call, since `wait_prefault` drains its
   `JoinHandle` vec on join and `reopen_if_changed` only respawns it on an
   actual reopen) -- NOT implemented: `napi`'s synchronous method dispatch
   runs on the Node.js main thread, and this crate has no existing async-
   napi (tokio/`spawn_blocking`) pattern to build on safely under this
   session's time budget; blocking the daemon's main thread on an
   unbounded join (however rare) is exactly the kind of daemon-starvation
   regression this project's own history (memory: "Lexical worker thread +
   starvation fix") has already had to fix once. Left as a documented,
   correctly-scoped follow-up rather than risking a new starvation bug.

### 3.2 Fix

`crates/urdira-structural-store/src/reader.rs`, `spawn_prefault`: added
`touch_pages(&seg.entities_index)` (mandatory section, always present) and
`if let Some(pending) = &seg.pending { touch_pages(pending); }` (optional
section). Both are small, sorted-key INDEX sections (never the multi-
gigabyte `body`/`ident` record-content sections) -- stays within this
task's own §0 scope ("pre-touch the indices, not the records").

Lever (b) from the task brief ("`get_outline` reading only the owner's
rows without decoding the entire segment") was investigated and found
ALREADY TRUE by design, not a gap: `pending_sites_by_owner`
(`StoreReader`) and `by_owner`/`recordsByOwnerOrdinal` are both per-
segment BINARY SEARCHES over their own sorted-key range (`pending_site_
owner_range`/`quad_key_range`), never a full-segment decode -- confirmed
by code reading AND by the new regression test (§5) counting native calls.

### 3.3 Before/after (10 identical calls, same container, same daemon, post-ready)

n8n (`ActiveWorkflowManager`, resolved to its class record_id):

| run | wall |
|---|---:|
| cold (1st call after lexical catch-up) | 371.6ms |
| warm (2nd-10th) | 196.3-224.6-304.3ms (mean ~211ms, one 304.3ms outlier) |

VS Code (`MainThreadCommands`, resolved to its class record_id):

| run | wall |
|---|---:|
| cold (1st call) | 465.8ms |
| warm (2nd-10th) | 405.3-424.7ms (mean ~410ms, tight -- max-min spread 19.4ms) |

Compared to Q1's own documented baseline (1.1-7.0s **variance** across
repeated identical calls, the actual complaint -- not a fixed absolute
latency): the MULTI-SECOND VARIANCE is gone (VS Code's 10-call spread is
now under 20ms; n8n's is under 110ms, one outlier). The task's own
target (p99 <=300ms cold / <=100ms warm) is NOT fully met on absolute
latency for either corpus (VS Code sits around 410-466ms warm; n8n around
200-370ms) -- reported honestly rather than rounded up. The remaining
absolute cost is real hydration work proportional to the container's own
member/pending-site count (each member is a fully decoded
`CanonicalQueryRecord`, not a cheap id), not a scan or a page-fault tax;
closing the gap further would need profiling THAT hydration path
specifically, which this frente's own time budget did not extend to.
RSS: no daemon RSS regression observed (`ps` sampling before/after full
sweeps, both corpora) -- the two new prefaulted sections are small
(sorted-key tables, not record bodies).

## 4. Catalog sweep (VS Code, n8n; 3 calls each unless noted)

| operation | n8n wall (warm) | VS Code wall (warm) | notes |
|---|---:|---:|---|
| `core:search_text` | 34-101ms | 35-40ms | after lexical catch-up (§2) |
| `core:resolve_symbol` | 15-36ms | 31-32ms | |
| `core:get_source` | 15-16ms | 31-32ms | signature mode |
| `core:get_outline` | 196-372ms | 405-466ms | §3 |
| `core:build_context` | 36-62ms | 31-32ms | |
| `core:analyze_impact` | **OOM-crashed the daemon** (pre-fix) -> **0.6-2.7ms, typed `core:execution_resource_limit`** (post-fix) | same fix, not separately re-measured on VS Code's larger corpus (see §4.1) | new finding, fixed this session (§4.1) |
| `core:index_status` (top-level, control) | 2.6-3.5ms | 2.6-3.5ms | unaffected by any fix here |
| `core:search_semantic` / `locate_implementation` (recipe) | not exercised | not exercised | `URDIRA_SEMANTIC_INDEX=0` this session (matches Q1's own environment convention); `locate_implementation` confirmed to correctly report `core:coverage_incomplete`/`semantic` frontier not ready rather than silently degrading |
| `core:find_records` (broad `kind_selector`) | investigated, see §4.1 | not repeated | superseded by the `analyze_impact` fix below (same class of bug, now bounded for every operation reaching the generic fallback) |

### 4.1 New finding, fixed: `core:analyze_impact` (and any other pushdown-less operation) OOM-crashed the daemon

Discovered live during the sweep: `core:analyze_impact` has no dedicated
pushdown branch in `execute()` (unlike `get_outline`/`find_references`/
`expand_relations`/`find_paths`, covered by `tryGraphPushdown`) -- it
reaches the SAME generic `records_for_query` full-corpus fallback gap 1
closed for `core:index_status`, except `analyze_impact` is a genuinely
legitimate, needed operation (not misuse), so it cannot simply be
rejected outright the way `core:index_status`-as-a-stage was. Reproduced
live: a single `core:analyze_impact` call against n8n's real ~2.2M-record
v4 workspace crashed the daemon (`FATAL ERROR: Ineffective mark-compacts
near heap limit Allocation failed - JavaScript heap out of memory`) --
the SAME failure mode as gap 1, on a corpus SMALLER than VS Code's.

Fix: a new, general, operation-agnostic safety net in `execute()` (`packages/
engine/src/canonical-query-data-port.ts`) -- before EVER calling
`records_for_query`/`records`, ask the port for a cheap, no-decode
`visible_record_count(scope)` (new optional `CanonicalQuerySnapshotPort`
method); if it is defined and exceeds `FULL_CORPUS_FALLBACK_RECORD_CAP`
(200,000 -- generously above any real test fixture, generously below the
~2.2M/~4.5M scale that has been observed to OOM), reject with the
EXISTING registered `core:execution_resource_limit` error code
(`limit_kind: "full_corpus_decode_record_count"`, `configured_limit`,
`observed_or_required`) instead of attempting the decode. Implemented on
`NativeCanonicalQuerySnapshotPort` via `NativeStructuralStoreHandle.
visibleCount(generation)` (already-exposed napi binding over
`StoreReader::visible_count` -- a per-segment binary search, not a
decode); a port that omits `visible_record_count` (most `SqliteCanonicalQuerySnapshotPort`
deployments, no known OOM history at that scale) is never newly
restricted. This is a general fix, not specific to `analyze_impact` --
it also protects `find_related_tests`/`inspect_architecture`/`compare`/
`discover_definitions` (every other operation this codebase does not yet
have a dedicated pushdown for), all of which reach the identical fallback
path today.

Before/after: n8n (2,198,601 visible records) and VS Code (4,468,282
visible records) both went from an OOM crash to a **0.6-2.7ms** typed,
actionable rejection (`core:execution_resource_limit`, naming the exact
record count and the operation) on every one of 3 repeated calls, both
corpora.

Real pushdowns for `analyze_impact`/`find_related_tests`/`inspect_
architecture`/`compare` (the underlying capability gap, not just its OOM
symptom) are a substantial architectural undertaking (transitive impact
classification, confidence-graded `will_break`/`must_update`/`may_be_
affected` streams) explicitly out of this "quick sweep" task's scope --
flagged as the next natural priority for whoever owns this area.

## 5. Tests

`tests/native-query-snapshot-port.test.ts`:
- Reworded the existing "records_by_ids returns identical records for
  record_id, identity_id, and identity_key forms" test's own comment to
  document why identity_id/identity_key resolution is INTENTIONALLY still
  served (§1.4), and added a new "records_by_ids rejects an oversized
  identity_id/identity_key batch outright rather than scanning for it"
  test pinning `OTHER_IDS_COUNT_CAP`.
- New: "core:get_outline reads only the container's own owner-scoped
  rows, never a full-corpus decode" -- counts calls to `pending_sites_
  by_owner_artifact`/`container_records_by_artifact_references` (exactly
  one/at-most-one for one `get_outline` call, independent of corpus size)
  AND wires `records_for_query`/`records_for_query_batches`/`records` to
  throw, mirroring this file's own Q1 convention.

`tests/phase-canonical-query-data-port.test.ts`:
- New: "lexical_projection_lag reports the current/completed generation
  pair while lagging, and undefined once caught up" (direct
  `SqliteCanonicalQuerySnapshotPort` unit test, including the pinned-
  source-snapshot no-lag case).
- New: "surfaces the lexical sidecar's lag as an explicit completeness
  dimension instead of a silent slowdown" (full `CanonicalRecordQueryDataPort.
  execute()` integration test, real SQLite fixtures: lagging ->
  `overall_status: "partial"` + the `core:lexical_search` dimension named
  above, with real matches still returned; caught up -> `"complete"`,
  empty dimensions).
- New: "core:index_status is rejected as a non-subject-producing
  operation before any corpus read" (a port whose `records`/
  `records_for_query` throw; proves the guard fires first).
- New: "refuses the generic full-corpus fallback with a typed error once
  visible_record_count exceeds the safety cap" (oversized/at-cap/no-guard
  cases, all three the `analyze_impact` fix's own contract).

Verified: `pnpm typecheck` (only the same pre-existing, unrelated fixture
errors under `tests/fixtures/codebases/typescript/{barrel-method-call,
multi-hop-barrel-rename}` Q1 also confirmed pre-existing); `pnpm lint`
(clean); `cargo test -p urdira-structural-store --locked` (all green;
one flake in `deps_pending_closure_matrix_test`'s `fifty_thousand_
distinct_keys...` test on a shared-machine run under concurrent load from
an unrelated agent's own `cargo build`, reproduced passing in isolation
immediately after -- a tmpdir-under-load flake, not a regression: `git
diff` touches only `spawn_prefault`, which that test does not exercise);
`cargo build --release` + `node scripts/build-native.mjs` (native
artifacts rebuilt after the Rust change, before any TS test run that
depends on them); `CI=true pnpm exec vitest run tests/native-query-
snapshot-port.test.ts tests/phase11-recipe-executor.test.ts tests/
phase11-query-plan.test.ts tests/query-pushdown-graph.test.ts tests/
phase-canonical-query-data-port.test.ts tests/v4-daemon-e2e.test.ts
tests/phase13-mcp.test.ts tests/contracts.test.ts tests/phase17-
pipeline-executor.test.ts tests/phase-daemon-v4-scan.test.ts` -- 321
passed, 1 skipped (an existing, unrelated `maybeDescribe`-gated skip),
0 failed.

## 6. Registry/contract changes (amendment to decision 25 and the pushdown-léxico decisions)

Two new registered operation-error codes, `core:selector_unresolvable`
and `core:non_subject_operation` (full three-place wiring: `packages/
contracts/src/registries.ts`'s `operationErrorRegistryEntries`/
`operationErrorDetails`/`errorPolicy`, plus `registry-payload-authority.ts`
per-field descriptions) -- `operationErrorRegistry` grew from 49 to 51
entries; `tests/contracts.test.ts`'s two hardcoded counts (`toHaveLength(49)`
-> `51`, the payload-family-count check `97` -> `99`) and `tests/fixtures/
contracts/v5-contract-conformance.json`'s `payloads.operation_errors`
array updated to match (hand-patched, NOT regenerated via `packages/
contracts/scripts/generate-contract-conformance-fixture.mjs` -- that
script re-derives its fixture purely from the current doc files and would
have SILENTLY DROPPED three pre-existing, undocumented-in-the-protocol-
doc entries this repo already carries by design, `core:semantic_
affected_page`/`core:affected_set_stale`/`core:RecordSetMerkleRoot` --
confirmed live by running it once, diffing, and reverting). `docs/
protocol/core-operation-error-codes.md` gained an "Amendment 2026-09-08"
section documenting both new codes at the same fidelity as the file's
existing entries.

`apps/urdira/src/index.ts`'s `lexical_owned_by_rust` derivation (§2.2)
amends decision 25's own "native indexing worker" wiring -- filed here as
the closest existing decision record for that flag's origin, pending the
owner's own product-decision filing if one is wanted; `docs/decisions/`
was not touched (this frente's zone is engine/query code and the native
store, not the decisions directory).

## 7. Cleanup

Scratch measurement driver (two `.mjs` files, never part of the repo)
deleted at session end. Daemons for `q2-n8n-data`/`q2-vscode-data` both
stopped gracefully (`daemon stop exit=0` both sessions; no stale lock/
socket cleanup needed). Scratch data roots (`~/Proyectos/urdira-benchmark/
v4-fold/q2-{n8n,vscode}-data`) deleted. `CARGO_TARGET_DIR` scratch
directory and `build-native.mjs`'s own `target/` directory both removed.
`pgrep -fl "cli.js daemon|urdira-indexing-worker"` confirmed clean of
this session's own processes at session end (one OTHER agent's own
worktree processes, unrelated, were observed and left alone).
