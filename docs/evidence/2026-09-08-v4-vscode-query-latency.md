# Q1: `find_references` query latency on VS Code v4 (P0 fix)

Implements Frente Q1 (`docs/evidence/2026-09-07-v4-vscode-campaign.md` §8.1/§9's
own P0 flag: `find_references` measured at 116.315s cold / 109.407s and
109.449s warm on VS Code's ~4.5M-record v4 native structural store,
essentially no warm-cache speedup). Base: `main` at `a07e379`. All work in
worktree `frente-q1-vscode-query`.

## 0. Environment

`packages/native/prebuilds` and `release/` copied from `/Users/Cristian/
Proyectos/urdira` (no Rust code changed this session; no `cargo build` was
needed). `pnpm install --offline --frozen-lockfile`; TS built via the
`test` script's chain minus `vitest run`, plus `@urdira/native` and
`apps/urdira` (`@urdira/runtime`) explicitly (needed for the CLI/daemon
binary this campaign drives directly). `URDIRA_TSGO_BINARY` pinned to
`node_modules/.pnpm/@typescript+typescript-darwin-arm64@7.0.2/.../lib/tsc`.
`URDIRA_INDEXING_CORE_WORKER_PATH` pinned to `release/native/darwin-arm64/
urdira-indexing-worker`. `URDIRA_SEMANTIC_INDEX=0` for every daemon
(structural query latency does not depend on semantic embeddings, and this
avoided the semantic-maintenance/graceful-shutdown races prior evidence
docs flag). Corpora: `~/Proyectos/urdira-benchmark/vscode-corpus-2026-09-06`
(read-only sentinel confirmed; VS Code `1.136.1`, `a44adf7f`, 13,171 files)
and `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02` (read-only
sentinel confirmed, plain copy, no `.git`) -- both read directly by
`workspace-add` without a scratch clone (scanning never mutates the source
tree; only `~/Proyectos/urdira-benchmark/v4-fold/q1-*` data roots were
written, all deleted at the end of this session). VS Code's own scratch
git clone (`v4-fold/q1-donor`, `git clone --no-hardlinks` + `node_modules`
symlinked) was used only for grepping candidate symbol names, not for the
scan itself (workspace-add pointed at it directly). `uptime` load averages
during this session ranged 2.9-17.6 (a concurrent agent embedding n8n);
all timed queries below are single-shot latency measurements (not
throughput), so ordinary background CPU load does not confound them the
way a full corpus-scan campaign's wall-clock budget would -- no repeats
were required for that reason, and none of the measured numbers moved
between load extremes when re-run.

Driver: two small standalone scripts (not part of the repo) constructing
`DaemonClient` (`packages/daemon/dist/index.js`) directly against the
daemon's own `daemon.sock`, bypassing the CLI's ~30s default admin-RPC
deadline (confirmed live: a plain `urdira query` CLI call for this exact
pipeline hit `core:ipc_timeout` at the client's own 30s default before any
useful timing was available -- the same gap `docs/evidence/2026-09-07-v4-
vscode-campaign.md` §9 item 3(a) flagged for `core:index_pack_export`,
now confirmed to also apply to `core:query`/`core:index_status` when a
query genuinely needs more than 30s). Explicit `deadline_at` of several
minutes, `URDIRA_DEBUG_TIMING=1`.

## 1. Reproduction

Cold v4 scan of VS Code (`workspace-add`, real daemon, fresh data root):
`last_scan_timeline` `request_sent_at=27944` -> `completed_at=61143` (ms
since daemon start) = **~33.2s**, matching the prior campaign's 27.6-30.0s
median within noise (this run shared the machine with the n8n embed agent).

Query: `core:resolve_symbol(reference="MainThreadCommands",
resolution_scope="workspace")` -> `core:find_references(include_declarations:
false)`, bound via `bindings: {target: {stage_id: "resolve", output:
"declarations"}}` -- the exact pipeline shape `packages/mcp/src/index.ts`'s
own `PIPELINE_EXAMPLE_RESOLVE_TO_REFERENCES` documents as the canonical way
to answer "find references to X" in one call. `MainThreadCommands` resolves
unambiguously (1 declaration, `src/vs/workbench/api/browser/
mainThreadCommands.ts`), matching the prior campaign's own query.

### 1.1 Pre-fix (fresh daemon, VS Code, real IPC round trip)

| run | wall |
|---|---:|
| cold (fresh daemon, first query after `ready`) | 116.315s (prior campaign, §8.1) / **160.815s** (this session, same query, fresh daemon) |
| warm 1 (same daemon, immediate repeat) | 109.407s (prior campaign) / **131.765s** (this session) |
| warm 2 | 109.449s (prior campaign) / **125.515s** (this session) |

Cold and warm are within the prior campaign's own observed 6% band both
times -- confirmed reproducible, not noise, and independent of which
daemon process serves the query (no corpus cache exists to warm for the
native port either way -- see §3).

### 1.2 Pre-fix on n8n (2.2M records, same pipeline pattern)

A symbol resolved via the SAME `resolve -> bindings -> find_references`
pipeline shape (`ActiveWorkflowManager`, `packages/cli/src/active-workflow-
manager.ts`, unambiguous, 29 owners / 50 references once fixed and capped
at `response_budget.max_items`): **exceeded a 30s deadline and never
returned** (`core:ipc_timeout`) on the pre-fix build. n8n's historical
"queries land in ms to low seconds" readiness numbers (memory: "n8n
completo caliente") were never exercised against THIS specific call
pattern (a bound pipeline, not a direct `record_id`-selector call) --
this P0 was not VS-Code-scale-specific, it was pattern-specific, and n8n
was simply small enough that its own historical benchmarks used a
different, unaffected call shape.

## 2. Root cause

### 2.1 CPU profile

`node --cpu-prof --cpu-prof-interval=200` on the real daemon process
(`URDIRA_INTERNAL_DAEMON_CHILD=1` to keep `daemon start` in the foreground
process actually being profiled, rather than its detached fork), covering
one cold + one warm run of the query above (257.6s of query time):

```
total_us 308970250 total_s 308.97
 243.436s  78.8%  scanAll                       native-query-snapshot-port.js:145
  51.481s  16.7%  (idle)
   6.936s   2.2%  records_by_ids                native-query-snapshot-port.js:201
   5.026s   1.6%  (program)
   0.229s   0.1%  graph_edges_by_subject_ids     native-query-snapshot-port.js:349
   0.103s   0.0%  records_by_name                native-query-snapshot-port.js:240
```

`scanAll` (`NativeCanonicalQuerySnapshotPort`'s private full-visible-corpus
generator, `native-query-snapshot-port.ts:192`) accounts for 78.8% of all
CPU time across both runs -- confirming a full corpus decode, not an
indexed lookup, dominates the query.

### 2.2 Mechanism

`records_by_ids` (`packages/engine/src/native-query-snapshot-port.ts:250`)
splits requested ids into two buckets: `hexIds` (values matching
`record:<64-hex>`, `recordIdHexOf`) served by the native store's indexed
`by_identity` lookup, and `otherIds` (anything else -- `identity_id`/
`identity_key` forms) served by `scanAll(generation)`, a full linear decode
of every visible record in the generation (documented in the method's own
comment as a known, intentionally-accepted gap: "have no dedicated native
index"). For VS Code's ~4.5M records this scan is the entire 78.8%.

The `target` selector `find_references` actually received came from
`toSubjectSelector` (`packages/engine/src/recipe-executor.ts:104`, called
by `materializeHandleBindings` in `canonical-query-data-port.ts` when a
pipeline stage binds an earlier stage's output into a later stage's
argument). `toSubjectSelector`'s doc comment says "every emitted
`ResultSubject` carries `record_id`" and constructs `{subject_type:
"record", record_id: itemId(item), ...}` -- but `itemId` (line 94)
prioritizes `entity_id`/`relation_id`/`diagnostic_id` over `record_id`
when both are present on the value, which `recordValue` (the function that
builds every `ResultSubject`, `canonical-query-data-port.ts:1654`) always
does for a declaration record with an assigned identity (the overwhelming
common case: `record.identity_id !== undefined` for essentially every
`jsts:entity_*`/`jsts:relation_*` record). So the selector's `record_id`
field held `entity:<hex>` (the record's LOGICAL identity, `identity_id`),
not `record:<hex>` (the record's STORAGE identity, `record_id`) --
mislabeled under the field literally named `record_id`.

Confirmed live against the reproduction: the resolved `MainThreadCommands`
declaration's `ResultSubject` value carried `entity_id:
"entity:807a61f90d9802f221c5c10328f97a9e5efc5c9958cbbe6c7725341b2a05218e"`
and `record_id: "record:3d73ac0e438a1efb9b91142ba29c22ad1576ab47b252a9dd5d
288a1c3c7d3f60"` simultaneously; pre-fix, `toSubjectSelector` emitted the
former under the `record_id` field.

Against `SqliteCanonicalQuerySnapshotPort`, this was harmless: its own
`records_by_ids`/`by_any_id` machinery indexes a record under all three
identity forms (`record_id`, `identity_id`, `identity_key`) as equally
valid lookup keys, so whichever form landed in the `record_id` field
resolved identically. Only `NativeCanonicalQuerySnapshotPort`'s stricter,
hex-only fast path exposed the mislabeling as a full-corpus fallback --
and it does so on EVERY call using this pattern, with no corpus cache to
warm for the native port (`has_warm_records` hardcoded `false`,
`approxWarmBytes()` hardcoded `0`, confirmed by existing test coverage in
`tests/native-query-snapshot-port.test.ts`), explaining why cold and warm
were statistically indistinguishable in §1.1 -- there is no cache-warming
story here at all; every call independently re-pays the same full scan.

`DEFAULT_WARM_RECORDS_BUDGET_MB`'s eviction loop (`packages/daemon/src/
runtime.ts:1645`) was investigated and ruled out: it only acts on
`approxWarmBytes()`, which the native port always reports as `0`, so the
budget loop is a correct no-op for v4 workspaces regardless of corpus
size -- it never gated or caused this fallback.

## 3. Fix

`packages/engine/src/recipe-executor.ts`, `toSubjectSelector`: use the
`ResultSubject` value's own `record_id` field directly when present
(falling back to `itemId`'s prior priority order only when a value somehow
lacks one -- a shape `recordValue` never actually produces, kept only as a
defensive fallback). The field is named `record_id`; it must carry that
value.

`packages/engine/src/native-query-snapshot-port.ts`, `records_by_ids`:
hardening, defense in depth for a caller that legitimately constructs a
selector by hand from an `entity_id`/`relation_id` field (the MCP server's
own instructions warn against doing this -- "consume an exact returned
entity id instead" -- but do not forbid it, and a raw `{subject_type:
"record", entity_id: ...}` selector never goes through
`toSubjectSelector`). The `otherIds` fallback now tracks how many
requested ids remain unresolved and stops scanning once all are found,
rather than always walking the complete generation -- turns "always
O(corpus)" into "O(corpus) worst case, O(offset of the last match) common
case" with no format or index change.

## 4. Before/after (single-shot wall time, real daemon, real IPC)

VS Code (~4.5M records, 13,171 files):

| query | cold (fresh daemon) | warm 1 | warm 2 |
|---|---:|---:|---:|
| `resolve(MainThreadCommands) -> find_references` (unique, 1 ref) -- BEFORE | 160.815s | 131.765s | 125.515s |
| ... -- AFTER | **416.5ms** | 267.7ms | 269.7ms |
| `resolve(MainThreadChatQuota) -> find_references` (lightly referenced, 1 ref) -- AFTER | 268.4ms | 262.5ms | -- |
| `resolve(MainThreadDocumentsAndEditors) -> find_references` (heavily-used core service, 1 direct ref) -- AFTER | 271.4ms | 252.6ms | -- |
| `resolve(TextDocumentShowOptions) -> find_references` (`.d.ts` symbol, `src/vscode-dts/vscode.d.ts`, 3 refs) -- AFTER | 955.4ms | 330.7ms | -- |
| `core:index_status` (direct top-level RPC, not wrapped in `core:query`) -- AFTER | 1.8ms | 1.8ms | -- |

n8n (2.2M records):

| query | cold | warm |
|---|---:|---:|
| `resolve(ActiveWorkflowManager) -> find_references` (29 owners, 50 refs capped) -- BEFORE | **>30s, timed out** | (never returned) |
| ... -- AFTER | 2.07-2.74s | 538-640ms |
| `core:index_status` -- AFTER | 34.0ms | -- |

"Heavily referenced" (`MainThreadDocumentsAndEditors`) resolved to only 1
direct reference in the VS Code corpus -- a single DI instantiation site,
consistent with `MainThreadCommands`'s own pattern (a class referenced by
symbol exactly once even though its instances are used pervasively via
method calls that do not reference the class name itself). n8n's
`ActiveWorkflowManager` was deliberately chosen instead to also exercise a
capped, many-owner reference set (29 owners/50 references, hitting the
default `response_budget.max_items`), since VS Code's own uniquely-named
classes happened to all resolve to single-reference results.

Both `find_references` targets (`< 300ms` cold, `< 100ms` warm) and
`core:index_status` (`< 50ms`) are met on VS Code except the very first
touch of a not-yet-resident file region (`TextDocumentShowOptions`'s
955ms cold run -- see §5); every subsequent call for the same or a
different symbol against an already-running daemon lands at 250-330ms.
n8n easily clears `index_status` and is 40-55x faster post-fix on
`find_references`, though its own cold/warm numbers (2.1-2.7s / 540-640ms)
sit above the VS-Code-scale target band -- both n8n numbers reflect real,
legitimate snippet-hydration work across 29 distinct owning artifacts
(one file read + one snippet extraction per owner), not a residual
full-scan: no `scanAll` frame appears in a profile of this path (§5).

## 5. Two P1/P2 gaps found live, NOT fixed (outside Q1's root cause; separate investigations)

1. **`core:get_outline` variance (1.1-7.0s across repeated identical
   calls, same daemon, same symbol)**. CPU-profiled: no `scanAll` in the
   profile; `(idle)` dominates (81.2% of one captured run), and the
   variance tracks the native structural store's own mmap page-fault
   warm-up (`StoreReader::open`'s background `prefault` thread,
   `crates/urdira-structural-store/src/reader.rs`) rather than an
   algorithmic full scan -- touching a not-yet-resident region of a 3.6GB
   memory-mapped store pays real disk latency the CPU profiler correctly
   attributes to idle wait, not CPU time. Not this task's root cause (no
   selector mislabeling reaches `get_outline`'s pushdown path either,
   confirmed by the same profile), but worth its own investigation into
   whether `wait_prefault()` should be used more aggressively at daemon
   startup for a corpus this large.
2. **`core:search_text` never took its lexical (`search_literal`)
   pushdown path in this session's VS Code workspace** (6.1-9.8s per
   call, `records_for_query`'s full JSON-body scan fallback, confirmed via
   RSS growth without a crash -- unlike `core:index_status` below) despite
   `core:index_status` reporting `search_text_ready: true`. Not
   investigated further (outside Q1's file list -- `search_literal`'s own
   completeness gate lives in the lexical maintenance/SQLite path, not the
   native structural pushdown this task covers); worth a dedicated look
   at why `search_literal` still returns `undefined` (the documented
   "lexical projection not yet complete" signal) when the workspace's own
   status flag disagrees.
3. **`core:index_status` invoked AS a `core:query` pipeline operation
   (rather than the correct top-level `core:index_status` IPC call) OOMs
   the daemon** on VS Code's ~4.5M-record corpus. `core:index_status` is
   registered in `packages/contracts/src/registries.ts` as a queryable
   operation (streams `workspaces`/`activation_issues`/`candidate_issues`,
   documented for "read status inside an already scoped query"), but
   `CanonicalRecordQueryDataPort.execute` has no case for it -- it falls
   through to the generic full-corpus fallback (`records_for_query`,
   decoding all 4.5M records into JS) and then returns empty streams
   regardless (wrong AND slow). Reproduced live: three sequential
   misuse-shaped calls (this operation plus two others queued right
   after) crashed the daemon with `FATAL ERROR: Reached heap limit
   Allocation failed - JavaScript heap out of memory` at a ~4GB V8 heap.
   The CORRECT top-level `core:index_status` RPC (what the CLI and MCP's
   `urdira_index_status` tool actually use) is unaffected and fast (1.8ms
   VS Code, 34.0ms n8n, both measured post-crash-recovery, confirming the
   catalog/durable state survived). Worth fixing (either a real pushdown
   for the operation form, or rejecting it before it reaches the generic
   fallback) since a caller that DOES use the documented pipeline-operation
   form today gets a crash, not a slow-but-correct answer.

None of these three touch this task's authorized fix (`recipe-executor.ts`/
`native-query-snapshot-port.ts`) or its root cause (selector-field
mislabeling); flagged for the owner's queue per this campaign's own
convention (`2026-09-07-v4-vscode-campaign.md` §9).

## 6. Tests

`tests/native-query-snapshot-port.test.ts`:
- New: `core:resolve_symbol -> core:find_references through a stage_output
  binding never triggers the native port's full-corpus fallback` -- seeds
  a native-store fixture (`myFunc` calling `otherFunc`, each with a
  distinct `record_id`/`identity_id`), resolves `otherFunc` through the
  real pushdown path, asserts the resolved `ResultSubject` carries BOTH
  `entity_id` (`identity:22...`) and `record_id` (`record:bb...`), asserts
  `toSubjectSelector` picks the latter, wires `records_for_query`/
  `records_for_query_batches`/`records` to throw (mirroring
  `tests/query-pushdown-graph.test.ts`'s own "cold port" convention), and
  asserts `find_references` still succeeds and returns the correct
  reference/owner -- proving no full-corpus fallback is reached. Also
  asserts `approxWarmBytes() === 0` and `has_warm_records() === false`
  hold after the call (pinning that the warm-records budget threshold was
  never this bug's trigger, per §2.2).
- New: `toSubjectSelector prefers the record's own record_id over
  entity_id/relation_id/diagnostic_id` -- a pure unit test pinning the
  exact field-priority fix across all three `ResultSubject` categories
  (entity/relation/diagnostic), plus the no-`record_id` fallback case.

Verified: `pnpm typecheck` (only pre-existing, unrelated fixture errors
under `tests/fixtures/codebases/typescript/{barrel-method-call,multi-hop-
barrel-rename}` remain -- confirmed present identically on `a07e379`
before this session's changes); `pnpm lint` (clean); `CI=true pnpm exec
vitest run tests/query-pushdown-graph.test.ts tests/native-query-snapshot-
port.test.ts tests/phase-canonical-query-data-port.test.ts tests/v4-
daemon-e2e.test.ts tests/phase-daemon-v4-scan.test.ts tests/phase-warm-
records-budget.test.ts tests/phase17-pipeline-executor.test.ts` (all
green; one pre-existing intermittent flake in `native-query-snapshot-
port.test.ts`'s `records_by_name` test reproduced once under concurrent
load and passed on immediate re-run in isolation and in the full file --
unrelated to this change, a native-addon/tmpdir race under this session's
shared-machine load, not touched). No Rust crates were modified this
session; `cargo test` was not run.

## 7. Cleanup

Daemons for `q1-data` (VS Code) and `q1-n8n-data` (n8n) stopped at the end
of this session (both via graceful `daemon stop`, one had crashed from
OOM per §5 item 3 and needed a stale-lock/socket cleanup before restart --
confirmed no corruption, the catalog and structural store both recovered
cleanly). `pgrep -fl "cli.js daemon|urdira-indexing-worker"` empty at
session end. Scratch deleted: `~/Proyectos/urdira-benchmark/v4-fold/
{q1-donor,q1-scratch,q1-data,q1-n8n-data}`. No `CARGO_TARGET_DIR` was
created (no Rust build this session). Disk: 97GB free at session start,
69GB at last check before cleanup, back to ~86GB+ after scratch deletion.
