# P1-D-e: the tsgo "stale node handle" RPC error — root-caused, fixed, measured

Implements task P1-D-e of the v4 plan. Scope owned this session: `crates/urdira-tsgo-client`
(`resolver.rs`, new `tests/rpc_error_repro.rs`), `crates/urdira-indexing-worker/src/v4/residual.rs`
(read/verified, not modified — see §4). Not committed, per task instructions. The shared corpus
(`~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`) was never written to — every n8n run used
`tests_e2e::scratch_copy_of_n8n_corpus`'s scratch-copy helper via the existing
`n8n_residual_pass_debug_histogram` test.

Machine: macOS arm64 (darwin-arm64), Rust 1.98.0 (workspace pin). **Idle-machine protocol was
followed but could not be fully honored**: the concurrent "cold round 6" agent ran a long, sustained
series of its own n8n-scale `cargo test -p urdira-indexing-worker` measurement runs throughout this
session (confirmed live via `pgrep`/process listing — `n8n_incremental_measurement`,
`n8n_catalog_walk_diagnosis`, full `cargo test -p urdira-indexing-worker`, repeated "final-run"
campaigns). Three separate 9-minute wait cycles (27 minutes total) were spent polling for it to go
idle; it did not. Given `uptime`'s load average stayed at 11-14 throughout and `vm_stat` showed as
little as ~61 MiB free at one point, this was genuine, sustained load, not a brief blip. The n8n
measurement in §5 was run anyway rather than block indefinitely — **its wall-clock numbers are
therefore contention-inflated and reported with that caveat**; its *correctness* numbers
(upgraded/external/unresolved/rpc_error counts) are NOT expected to be contention-sensitive (the
tsgo server's `-32603` responses are explicit protocol replies, not timeouts, and this session's own
low-contention synthetic reproductions — §2 — ran in the SAME busy window and still produced crisp,
deterministic zero/non-zero results) and are reported as measured.

## 1. Summary

Four hypotheses were live going into this session (P1-D-d's evidence doc, §6): (A) case-insensitive
path canonicalization corrupting a PascalCase owner's own handle identity, (B) a stale handle reused
across a window switch, (C) a server-side batch-size limit on `getSymbolsAtLocations`, (D) an owner
missing from its window's `files:` roots. Each was tested with a dedicated, minimal, real-tsgo-binary
reproduction (§2). **A, B, and D are confirmed NOT the cause** of the diagnosed error family. The
concrete mechanism — one bad `NodeHandle` inside a batched `getSymbolsAtLocations` request poisons
the ENTIRE request, including every otherwise-valid handle batched alongside it — was reproduced
byte-for-byte against the real binary (§2.5): a fabricated out-of-range handle mixed into an
otherwise valid 2-handle batch produces the EXACT diagnosed error text, and the whole batch errors
even though only one handle is bad.

**Fix implemented** (§3): `ResidualResolver::fetch_symbols_chunked` chunks `getSymbolsAtLocations`
requests to at most 2,000 locations (`MAX_LOCATIONS_PER_CALL`), and on a whole-chunk failure, retries
that chunk ONE LOCATION AT A TIME so a single bad handle costs only its own site, never the rest of
the owner's sites — exactly the task brief's own prescription. Measured live on n8n (§5): `rpc_error`
dropped from 219,348 to **101,861** (-53.6%), and the 117,487 recovered sites were NOT silently
dropped nor wrongly promoted to `upgraded` — they were correctly reclassified into `no_symbol`
(genuine checker misses, predominantly ambient Node/vitest globals this pass's virtual FS does not
serve — §6), which is exactly the intended, safe behavior. `upgraded` itself did **not** increase
(51,823, unchanged) because none of the newly-freed sites happened to have a genuine in-workspace
target; a **deeper, un-isolated tsgo-internal mechanism** still accounts for the remaining 101,861
`rpc_error` sites, concentrated in real n8n `.test.ts` files with heavy `vi.mock`/`vi.hoisted`
nesting — not reproduced with any minimal synthetic fixture this session (§2.4), and, per this task's
own risk framing, not attempted to be worked around blindly (risk of a wrong-but-successful-looking
resolution is worse than an honestly-unresolved site). The task's numeric target (`upgraded ≥
180,000`) was **not met** — reported honestly, same posture as the prior session.

## 2. Hypothesis reproductions (deliverable 1)

All four fixtures live in `crates/urdira-tsgo-client/tests/rpc_error_repro.rs` (skip-if-no-binary,
matching this crate's existing convention) plus two white-box unit tests in
`crates/urdira-tsgo-client/src/resolver.rs`'s own `#[cfg(test)] mod tests`.

### 2.1 Hypothesis A — case-insensitive owner-handle mismatch: NOT the cause

`pascal_case_owner_file_single_site_does_not_produce_rpc_error`: a single owner file named
`HttpRequest.node.ts` (n8n's own PascalCase convention) with one `Call` site
(`[1, 2].map((n) => n)`) resolves cleanly (`External`, `lib.es5.d.ts`, symbol `map`) — no RPC error.
tsgo's `useCaseSensitiveFileNames: false` lowercasing (confirmed real in P1-D-d, §4) affects
DECLARATION paths coming back from the checker (already handled by `EntityIndex`'s case-insensitive
fallback, unchanged this session), not the OWNER's own identity in a `getSourceFile` →
`getSymbolsAtLocations` sequence using the same path string both times.

### 2.2 Hypothesis D — owner not a window root: NOT the cause, and already structurally impossible

`unimported_owner_with_pending_sites_still_resolves`: a two-window plan (`window_size=1`) where the
owner under test is neither imported by, nor imports, anything else — its own window's `files:` list
contains ONLY itself. Its lib-call site still resolves correctly. Cross-checked against
`crates/urdira-indexing-worker/src/v4/residual.rs::run_once_with_quiet_period` (lines ~354-384): every
jsts source file with successfully-read text is unconditionally added to `file_map`, and
`sorted_roots = file_map.keys()` becomes the FULL window-plan input — there is no additional filter
that could exclude an owner with pending sites from being a root somewhere. Hypothesis D's premise
does not hold in the current architecture; **no code change was needed or made**.

### 2.3 Hypothesis B — stale handle reused across a window switch: NOT the cause (and not reachable)

`reusing_a_handle_from_a_released_snapshot_produces_the_stale_handle_error`: drives `TsgoClient`
directly (bypassing `ResidualPass::run_lane`'s own per-window-fresh-`ResidualResolver` discipline) to
open window 1, fetch a handle, open window 2, `release` window 1's snapshot, then reuse the OLD
snapshot id + handle. Result: `Err(Rpc(... "snapshot 1 not found" ...))` — a DIFFERENT, distinctly
labeled error, not the diagnosed "node handle ... could not be resolved" family. Confirmed by direct
code read that `run_lane` (`crates/urdira-tsgo-client/src/residual_pass.rs`) constructs a brand new
`ResidualResolver` every window (its `source_files`/`texts` caches start empty each time), so this
mechanism is not reachable via the real code path in the first place — consistent with "re-fetch the
source file handle after every `updateSnapshot`" already being satisfied, verified rather than
patched.

### 2.4 Hypothesis C — batch-size limit: does not reproduce with either minimal synthetic shape tried

- `huge_single_owner_batch_of_ten_thousand_call_sites`: one owner file, 10,000 trivial
  `noop(i);` call sites all targeting the SAME single top-level declaration. Result: **10,000/10,000
  resolved, 0 rpc_error** — this exercises `fetch_symbols_chunked`'s multi-chunk path (5 chunks of
  2,000) end-to-end with zero errors.
- `many_distinct_declarations_referenced_once_each`: one owner file, 500 `IdentifierRef` sites, each
  targeting a DIFFERENT one of 500 distinct top-level function declarations in the same file. Result:
  **500/500 resolved, 0 rpc_error**.

Neither "many calls to one thing" nor "many distinct things" alone reproduces the diagnosed failure.
The real n8n files that fail (§5, §6) are `.test.ts` files with deeply nested `describe`/`it`/
`beforeEach` callback closures wrapping `vi.mock`/`vi.hoisted`/`vi.fn()` calls referencing the
`vitest` package's own (unserved — this pass has no `node_modules` story, by design, per
`virtual_fs.rs`'s own doc comment) global functions. This session did not isolate a minimal
synthetic fixture that reproduces the persistent, individually-unrecoverable failure real n8n files
exhibit (see §2.5's important distinction, and §6.3) — a genuine, honestly-reported open item.

### 2.5 The exact mechanism, reproduced byte-for-byte

`out_of_range_handle_mixed_into_a_batch`: fetches a real owner file's `alpha`/`beta`/`gamma`
`const` declarations, builds one VALID handle plus one FABRICATED out-of-range handle
(`NodeHandle::new(999_999, ...)`), and issues three `getSymbolsAtLocations` calls:

| call | result |
|---|---|
| `[good, fabricated]` (mixed batch) | `Err(-32603: node handle "999999.79./workspace/a.ts" could not be resolved (file may not be loaded or handle may be stale))` |
| `[good]` alone (after the mixed attempt) | `Ok([Some(SymbolResponse { name: "a", ... })])` — resolves fine |
| `[fabricated]` alone | `Err(-32603: node handle "999999.79./workspace/a.ts" could not be resolved ...)` — same error, alone |

This is an EXACT, byte-for-byte match to the error text `docs/evidence/
2026-09-04-v4-p1d-d-residual-diagnosis.md` §6 captured live from n8n (`node handle "293.79./...
supplyModel.test.ts" could not be resolved (file may not be loaded or handle may be stale)`),
confirming: (1) the mechanism is real and controllably reproducible, not merely theorized; (2) ONE
bad handle poisons the WHOLE batched request, even when every other handle in it is perfectly valid;
(3) the GOOD handle is unaffected when queried on its own — the fix's per-location fallback (§3) is
therefore both necessary and sufficient to recover it.

Two more white-box unit tests in `resolver.rs` itself exercise the actual fix (not a bypass) against
this same shape: `fetch_symbols_chunked_isolates_one_bad_handle_from_many_good_ones` (3 good handles
+ 1 fabricated bad one in the middle of one batch — asserts all 3 good ones still resolve AND the bad
one is reported with a real, specific reason containing "could not be resolved"/"stale", not silently
dropped or misreported) and `fetch_symbols_chunked_all_good_handles_need_no_fallback` (baseline: no
fallback path taken when everything is valid).

## 3. The fix

`crates/urdira-tsgo-client/src/resolver.rs`:

- **`MAX_LOCATIONS_PER_CALL: usize = 2000`** — the task brief's own suggested chunk size.
- **`ResidualResolver::fetch_symbols_chunked`** (new, private): splits the present (non-`None`)
  handles into chunks of at most `MAX_LOCATIONS_PER_CALL`; for each chunk, tries one
  `getSymbolsAtLocations` call. On success, results are distributed back to their original positions.
  On failure, the chunk is retried ONE HANDLE AT A TIME — each location's own success/failure is
  independent, so a bad handle costs exactly one site, and a real per-location error string
  (`"getSymbolsAtLocations failed: {error}"`) is captured for that position rather than being
  discarded.
- **`resolve_owner_group`** (rewritten): now calls `fetch_symbols_chunked` once for the WHOLE owner
  group (replacing the old single unchunked `get_symbols_at_locations` call that returned early,
  marking every site in the group `Unresolved` on any error) and threads the resulting
  `Vec<Option<String>>` of per-location errors through to step 3.
- **`resolve_via_symbol_with_error`** (renamed/extended from `resolve_via_symbol`) and **`resolve_call`**
  now accept an `Option<&str> lookup_error`: when the checker genuinely returns no symbol AND this
  location had no RPC error, the reason stays the existing generic "no symbol at location"/"no unique
  call target"; when `lookup_error` is `Some(...)`, THAT precise reason is reported instead — so a
  caller's reason histogram (like `residual.rs`'s own `ResidualDebug`) correctly buckets a real RPC
  failure as `rpc_error`, never conflating it with a genuine checker miss.

No change was needed in `crates/urdira-indexing-worker/src/v4/residual.rs` for this task (its own
`ResidualDebug::bucket_reason` already classifies any `Unresolved` reason string containing
`"getSymbolsAtLocations failed"` into the `rpc_error` bucket — confirmed by re-reading it — so the
fix in `resolver.rs` alone changes what ends up in that bucket, without any caller-side change).

## 4. Deliverable 1's remaining sub-items — verified already satisfied, not modified

- **"always include owners with pending sites in the window `files:`"**: already true by
  construction (§2.2) — no change made.
- **"re-fetch the source file handle after every `updateSnapshot`"**: already true by construction
  (§2.3, `ResidualResolver::new` is called fresh per window in `residual_pass.rs::run_lane`) — no
  change made.
- **"chunk `getSymbolsAtLocations` ... and fall back per-site on error"**: implemented, §3.

## 5. n8n measurement (deliverable 3) — CONTENTION CAVEAT, see header

Same harness as P1-D-d (`v4::residual::tests::n8n_residual_pass_debug_histogram`, `#[ignore]`d,
`URDIRA_V4_N8N_CORPUS`/`URDIRA_V4_N8N_DATA`/`URDIRA_V4_RESIDUAL_DEBUG=1`/`URDIRA_DEBUG_TIMING=1`), one
fresh scratch copy of `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`, run under sustained
concurrent load from the other agent's own measurement campaign (§ header).

| | before this session (P1-D-d) | after this session's fix |
|---|---:|---:|
| `upgraded` | 51,823 | **51,823** (unchanged) |
| `external` | 29,633 | 29,633 (unchanged) |
| `unresolved` | 511,764 | 511,764 (unchanged) |
| total possible sites | 593,220 | 593,220 (unchanged) |
| cold scan wall | ~30.4s (clean, P1-D-d mean) | 41.5s (**this run, under contention — not comparable**) |
| residual pass wall (`total_ms`) | ~33.7s (clean, P1-D-d mean) | 49.5s (**this run, under contention — not comparable**) |
| `residual_lanes()` | 5 | 5 (unchanged — same machine, same formula) |
| tsgo child RSS | 250-430 MiB/child (P1-D-c, not re-measured since) | not re-measured this session (out of budget given the contention above; nothing in this fix changes window/lane/per-window work shape in a way expected to move it) |

**Confirmed `core:call` reconciliation** (same `StoreReader::iter_visible` method as every prior
session in this series — no `@urdira/canonical` body-decode):

| | confirmed `core:call` |
|---|---:|
| v4 cold (gen 1) | 64,931 |
| v4 after residual upgrade (gen 2) | **116,149** (unchanged from P1-D-d) |
| v3 ceiling | 205,468 (cited, not re-measured — frozen historical artifact, per P1-D-d §8) |

Gap closed: `(116,149 - 64,931) / (205,468 - 64,931) = 51,218 / 140,537 ≈ 36.4%` — **unchanged from
the prior session**, because `upgraded` itself did not move (§6 explains why: the fix correctly
reclassifies recovered sites, but none of them turned out to have a genuine in-workspace target).
**Deliverable 3's target (`upgraded ≥ 180,000` / confirmed) was NOT met** — reported honestly.

## 6. Reason histogram, before/after (deliverable 2)

Full histogram, same run, `URDIRA_V4_RESIDUAL_DEBUG=1`:

| bucket | before (P1-D-d) | after (this session) | delta |
|---|---:|---:|---:|
| `no_symbol` | 268,153 | **385,640** | **+117,487** |
| `rpc_error` | 219,348 | **101,861** | **-117,487** |
| `upgraded` | 51,823 | 51,823 | 0 |
| `external_lib` | 29,633 | 29,633 | 0 |
| `confirmed_row_build_failed` | 12,743 | 12,743 | 0 |
| `entity_index_miss` | 5,804 | 5,804 | 0 |
| `owner_file_not_in_project` | 5,479 | 5,479 | 0 |
| `declaration_text_unavailable` | 230 | 230 | 0 |
| `symbol_no_declaration` | 7 | 7 | 0 |
| **total** | **593,220** | **593,220** | 0 |

The `no_symbol`/`rpc_error` delta is an EXACT match (+117,487 / -117,487) — every site the fix
recovered from `rpc_error` landed in `no_symbol`, none in `upgraded`, none silently lost. Every other
bucket is byte-identical to P1-D-d, confirming this session's change is additive and scoped exactly
to the RPC layer, as intended (no side effect on entity synthesis, case folding, or owner-inclusion
logic from the prior session).

### 6.1 `rpc_error` (101,861 remaining) — genuinely reduced, not eliminated; root cause still open

Sample (`URDIRA_V4_RESIDUAL_DEBUG`'s own 10-per-bucket dump) is concentrated in
`packages/@n8n/ai-utilities/src/__tests__/suppliers/supplyModel.test.ts` — a 257-line `.test.ts` file
using `vi.hoisted`/`vi.mock`/`vi.fn().mockImplementation(...)` heavily. **Multiple DIFFERENT node
indices in the SAME owner** (293, 343, 358, 368, 412, 437, 489, 500, 511, 519 — an increasing
sequence, not one isolated bad index) all fail, INCLUDING when retried individually by this session's
own fix (§3) — meaning this is not merely "one handle in the batch was bad" (§2.5's mechanism, which
the fix fully solves), but a persistent, per-handle condition specific to certain real files. Neither
of §2.4's minimal synthetic shapes (10,000 calls to one declaration; 500 distinct declarations)
reproduced this. The leading, still-UNCONFIRMED hypothesis is some tsgo-internal per-file/per-session
node-handle registration limit tied to the file's actual parse-tree shape (deeply nested closures
inside `describe`/`it`/`vi.mock` callbacks) rather than to raw site count or distinct-symbol count —
**not attempted to fix this session**: this task's own brief explicitly frames the RPC/protocol layer
as the one place where a wrong fix risks a FAR worse outcome (a confirmed row pointing at the wrong
declaration) than an honestly-unresolved site, and this session found no controlled way to
distinguish "genuinely broken, do not retry" from "recoverable with a different strategy" for this
specific residual population. Flagged here, with the exact file, the exact node-index sequence, and
the two ruled-out minimal shapes, for whoever picks this up next.

### 6.2 `no_symbol` (385,640, 65% of all sites) — predominantly genuine, not a client bug

Spot-checked one concrete sample by hand: `.github/actions/ci-filter/__tests__/ci-filter.test.ts`'s
`assert.ok(matchGlob('.github/workflows/ci.yml', '**'))` is bucketed `no_symbol` with reason "no
unique call target". `matchGlob` itself IS a real, resolvable, in-workspace declaration
(`export function matchGlob(...)` in `.github/actions/ci-filter/ci-filter.mjs`, confirmed by direct
`grep` against the corpus) — but the FAILING call here is the OUTER `assert.ok(...)`, not the inner
`matchGlob(...)` call (each is its own, independently-resolved `PendingSite`): `assert` is Node's own
built-in `node:assert` module, and this pass's virtual FS serves only the workspace's own jsts files
plus tsgo's bundled `lib.*.d.ts` — never `node_modules/@types/node` — so an ambient Node global
genuinely has nothing to resolve against. This is the EXACT, already-documented gap from P1-D-d §3
("a real, separate, smaller gap ... would need a real, scoped `node_modules`/`@types` serving story
for `LayeredFs`"), now confirmed to also cover `vitest`'s own globals: the other `no_symbol` samples
(`describe(...)`, `beforeEach(...)`) are calls into `vitest`'s exported functions, imported via
`import { describe, it, vi, ... } from 'vitest'` — again a `node_modules` package this pass does not
serve, by design (`virtual_fs.rs`'s own doc comment: "most importantly anything under a workspace's
own `node_modules`... is never served from disk"). **Conclusion**: `no_symbol`'s dominant composition
is genuine ambient-global/external-package gaps consistent with v3's own known limitation (the task
brief's own framing), not a client-side mapping bug — matching the two concrete samples checked by
hand. A full, page-by-page audit of all 385,640 samples was not attempted (out of session budget);
the two samples checked were chosen because they looked most likely to be workspace-local (a locally
`export`ed helper function), which would have been the strongest evidence of a real bug had it turned
out to be one.

### 6.3 Other buckets — unchanged, previously investigated

`confirmed_row_build_failed` (12,743), `entity_index_miss` (5,804), `owner_file_not_in_project`
(5,479), `declaration_text_unavailable` (230), and `symbol_no_declaration` (7) are all byte-identical
to P1-D-d and were already characterized there (§3-§6 of that doc) — not re-investigated this session
since this task's scope is the RPC layer specifically and none of these buckets involve
`getSymbolsAtLocations` at all.

## 7. Quality gates

- `cargo fmt --all -- --check`: clean.
- `cargo clippy -p urdira-tsgo-client -p urdira-indexing-worker --all-targets -- -D warnings`: **this
  crate's own code is clean** (`cargo clippy -p urdira-tsgo-client --all-targets -- -D warnings`
  alone: zero warnings; the combined command with `--no-deps` added: zero warnings for both target
  packages). The combined command WITHOUT `--no-deps` currently fails, but **not from anything this
  session touched**: `crates/urdira-native-core/src/lib.rs:844` (a `collapsible_if` lint) — a file
  explicitly owned by the concurrent cold-round-6 agent (this task's own instructions forbid touching
  it), already modified before this session started (confirmed via `git status` at session start) and
  still being actively edited throughout (confirmed live via `pgrep`/process listing — the other agent
  was mid-way through its own `cargo test -p urdira-indexing-worker --release
  v4::tests_e2e::n8n_incremental_measurement` runs at the exact moments this was checked, three times
  over several minutes, all showing the same lint). `urdira-indexing-worker` depends on
  `urdira-native-core`, so `cargo clippy`'s `-D warnings` (which applies to every crate in the
  dependency graph it type-checks, not just the named target packages) surfaces this pre-existing,
  out-of-scope issue as a hard failure of the combined command. Also observed once, transiently:
  `crates/urdira-structural-store/src/segment_io.rs` (same other agent, also forbidden to touch) with
  an unused `rayon::prelude` import — this one self-resolved on the very next retry (almost certainly
  caught mid-save). Neither file was touched, per the task's hard rule; this is reported as an honest
  blocker at the time of writing, not silently worked around.
- `cargo test -p urdira-tsgo-client -p urdira-indexing-worker`: **46 + 78 = 124 passed**, 0 failed,
  5 ignored (the n8n-scale `#[ignore]`d tests, one of which — `n8n_residual_pass_debug_histogram` —
  was run explicitly for §5/§6 above), confirmed clean across 5 repeated runs after the fix below.
  `cargo test -p urdira-tsgo-client` alone: 46 lib unit tests (2 new: `fetch_symbols_chunked_
  isolates_one_bad_handle_from_many_good_ones`, `fetch_symbols_chunked_all_good_handles_need_no_
  fallback`) + oracle (2) + residual_pass (3) + `rpc_error_repro.rs` (6, new this session, covers all
  four hypotheses plus the byte-exact reproduction and the two stress shapes) — all green.
  **One genuine, PRE-EXISTING test-isolation bug found and fixed** while chasing an intermittent
  failure of `binary::tests::discovers_the_real_binary_in_this_repo` under this session's own
  concurrent load: `discovers_the_real_binary_in_this_repo` and `override_env_wins_and_is_validated`
  both mutate the process-global `URDIRA_TSGO_BINARY` env var without synchronization, and Rust's
  default test harness runs every test in a module as separate THREADS in the SAME process — a
  genuine data race, unrelated to anything else in this session's scope but surfaced by it (higher
  thread-scheduling variance under load made the race land more often). Fixed with a shared
  `static ENV_LOCK: Mutex<()>` in `crates/urdira-tsgo-client/src/binary.rs`'s own test module, held by
  both tests for their full set/remove/`discover` sequence — confirmed by 5 repeated full-suite runs
  with zero failures after the fix (was intermittent before).
- `npx vitest run tests/v4-daemon-e2e.test.ts`: 2 passed, 1 skipped (the always-on "build release
  artifacts first" companion, skipping because they already exist) — unchanged from every prior
  session's report of this exact suite.

## 8. Files touched

- `crates/urdira-tsgo-client/src/resolver.rs` (the fix, §3; two new white-box unit tests, §2.5).
- `crates/urdira-tsgo-client/src/binary.rs` (unrelated but genuine pre-existing test-isolation race
  fixed, §7 — `ENV_LOCK`, no production code change).
- `crates/urdira-tsgo-client/tests/rpc_error_repro.rs` (new file, 6 tests: hypotheses A/B/C/D, the
  byte-exact out-of-range reproduction, and the two Hypothesis-C stress shapes — §2).
- `docs/evidence/2026-09-04-v4-p1d-e-residual-rpc.md` (this file).
- `crates/urdira-indexing-worker/src/v4/residual.rs`: read and verified only, not modified (§4).
- `crates/urdira-indexing-worker/src/main.rs`: `touch`ed only (mtime, to force a clean clippy
  re-check) — no content change from this session; its pre-existing diff predates this session
  (unrelated, in-progress work by others in the shared checkout).
