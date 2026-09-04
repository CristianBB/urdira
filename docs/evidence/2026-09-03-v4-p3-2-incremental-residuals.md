# P3-2: closing the incremental-path residuals left by P3-1

Machine: macOS arm64 (Darwin 25.5.0), 10 cores, 32 GB RAM, NVMe. `rustc`
1.98.0 (release build), Node 24.18.1. Not committed, per task instructions.
Corpus: `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`
(20,148/20,281 files depending on symlink-loop handling, 14,082 JS/TS
owners), READ-ONLY throughout this session (§0).

## 0. Hard rule: the shared n8n corpus was never mutated

`.urdira-shared-corpus-readonly` was created at the corpus root (the one
allowed write). Guards added:

- `scripts/v4-mutation-harness.mjs`: `assertMutable()` refuses to apply a
  mutation inside any directory carrying the marker; `applyMutation()`
  calls it first. `run()` always copies `--corpus` into a scratch
  directory before anything else (pre-existing behavior, now load-bearing
  rather than incidental).
- **Two real bugs found and fixed in this guard work itself**, both via
  live failures, not inspection:
  1. `cp(options.corpus, corpusRoot, {recursive:true})` was copying the
     marker file itself into the fresh scratch corpus, making the
     legitimate mutable copy look protected to its own guard
     (`Refusing to apply mutation... it carries .urdira-shared-corpus-readonly`).
     Fixed with a `filter` excluding the marker's basename from the copy.
  2. Routing the scratch corpus copy through the mandated
     `~/Proyectos/urdira-benchmark/v4-p3/scratch-mutation-harness-<hex>/...`
     directory (instead of the OS temp dir) made the DAEMON's own
     `daemon.sock` Unix-domain-socket path exceed macOS's ~104-byte
     `sockaddr_un` limit (`Error: listen EINVAL`). Fixed by keeping
     `tmpRoot`/`dataRoot` (and therefore the socket) on the OS temp dir
     always, and routing ONLY the corpus copy itself
     (`corpusParent`/`corpusRoot`) through the mandated directory when the
     corpus is protected — the hard rule is about never mutating/copying
     the corpus into `/tmp`, not about the daemon's own transient
     data/socket directory, which holds no corpus content.
- `crates/urdira-indexing-worker/src/v4/tests_e2e.rs`: new
  `scratch_copy_of_n8n_corpus()` helper, used by BOTH n8n-scale tests
  (`n8n_incremental_measurement` and
  `n8n_incremental_create_delete_roots_match_oracle`). **This closed a
  live landmine**: `n8n_incremental_measurement` still called
  `std::fs::write`/`std::fs::remove_file` directly against
  `URDIRA_V4_N8N_CORPUS` (the exact mechanism that corrupted the corpus
  twice in the P3-1 session, per that task's own evidence doc) — it had
  been manually fixed once by hand after the incident but the CODE itself
  still had the bug. Now routes through the copy-first helper
  unconditionally, with a hard `assert_ne!` against aliasing the source
  path.

**Verification**: `diff -rq --exclude=.git --exclude=node_modules
~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02
~/Proyectos/n8n | grep -v docs/architecture | grep -v
"Directory loop"` → only `Only in .../n8n-corpus-2026-09-02:
.urdira-shared-corpus-readonly` (the one allowed write). Run once mid-session
and once at the very end (after every mutation, harness, and daemon run in
this document) — both times empty besides the marker. (The "Directory loop
detected" lines are `.claude/skills` symlink loops pre-existing in both
trees, unrelated to this session.)

## 1. O(corpus) `files`/`config_assets` build → O(delta)

**Before**: `analyze::run_scoped` rebuilt the FULL `Vec<SourceInput>`/
`Vec<ConfigAssetInput>` from `frontier.present` (a `HashMap`, 14,082+
entries) on EVERY call, cold or incremental — a genuine O(corpus) `HashMap`
walk plus one struct clone per entry, dominating `parse_ms` even for a
DELETE (0 owners' facts affected, yet ~O(corpus) parse_ms anyway, per
P3-1's own evidence doc §7.4).

**After**: `crates/urdira-indexing-worker/src/v4/state.rs`'s new
`SourceCache` — two `BTreeMap<String, _>`s kept in `WorkspaceState`,
built once (`build_full`, O(corpus), for a cold scan or the first
`Changed` scan after a worker restart) and updated incrementally
thereafter (`apply_delta`, O(delta): removes/reinserts exactly the paths
a catalog delta named). `analyze::run_scoped` no longer builds anything —
it takes `files`/`config_assets` as already-built parameters.
`scan::run_full` seeds `WorkspaceState.source_cache` on a successful cold
scan (so the FIRST `Changed` scan in the same process is warm too);
`delta::run` updates it from `source_delta.added`/`changed`/`deleted`
before calling `analyze::run_incremental`.

**Measured** (worker-only, `n8n_incremental_measurement`, steady-state
EDIT#2/#3, no daemon):

| | P3-1 baseline | P3-2 (this session) |
|---|---:|---:|
| `parse_ms` | 460 | 331–396 |

~14-28% reduction. Not the full sub-second target on its own (see §6's
deeper finding for what still dominates a wider-closure edit), but a real,
isolated, measured win for the narrow case it targets (a single-file edit
with a small closure).

**Residual, found but not fixed this session**: `analyze()` itself
(`urdira-jsts-syntax-worker`, NOT touched by this fix) still clones the
ENTIRE `prior.files` `BTreeMap` on every non-`path_membership_incremental`
call (`let mut next_files = ... prior.files.clone()`) — a SEPARATE
O(corpus) cost inside the shared syntax worker, orthogonal to the one this
item fixes. Also: `path_membership_incremental`'s own `reresolve_file`
sweep (`next_files.keys().filter(|path| !changed.contains(...))`) is
O(corpus) for every pure create/delete/rename — this is why DELETE/RENAME
still show `parse_ms` in the 570–850ms range even after this fix (see §8's
table). Both are flagged as the natural next targets, out of this
session's remaining time.

## 2. `write_delta` reader reuse

**Before**: `SegmentWriter::write_delta` opened a FRESH `StoreReader` (a
full `StoreInner::load`: every closure across every delta, every
dictionary segment, a full `subject_index` rebuild) on every call, even
though `delta.rs`'s caller already held an open, freshly-refreshed one.

**After**: `crates/urdira-structural-store/src/writer.rs` gained
`write_delta_with_reader(dir, current_reader: &StoreReader, ...)` —
identical body, but takes the manifest (`current_reader.manifest()`, an
in-memory clone) and generation (`current_reader.generation()`) from the
passed-in reader instead of opening a new one. `write_delta` itself is
now a thin backward-compatible wrapper (`StoreReader::open` + delegate),
so every existing test/call site (`delta_test.rs`, `merkle_test.rs`,
`concurrency_test.rs`, `compaction_test.rs`, `diff.rs`'s own unit tests)
is untouched. `delta::run` calls the new variant with its own
`workspace_state.store_reader`.

**Measured** (worker-only, steady-state edit):

| | P3-1 baseline | P3-2 |
|---|---:|---:|
| `write_ms` | 348 | 227–240 |

~31-35% reduction.

## 3. `dependency` root at n8n scale — root-caused and fixed (the major finding)

P3-1 left `dependency` mismatching a from-scratch oracle at n8n scale for
create+delete, hypothesizing an owner-granularity dependency-diffing gap
("an unaffected owner's dependency row targeting the deleted/created file
never gets closed/reopened"). **That hypothesis was wrong** — investigated
and disproved this session with hard data, then the REAL cause was found,
root-caused, and fixed.

### 3.1 v2 (P3-1's fix) still failed completely at n8n scale

`n8n_incremental_create_delete_roots_match_oracle` (unchanged test, just
re-run after items 1-2): **35,527 live dependency edges on each side, ZERO
overlap** — not a handful of stragglers from a missed-closure edge case, a
100% mismatch. This ruled out the owner-granularity hypothesis outright
(a missed-closure bug would leave the vast majority of edges matching)
and pointed at the KEY/VALUE recipe itself.

### 3.2 v3 attempt: string-based identity — also failed, same 100% mismatch

Hypothesis: `dependency_id`/`dependency_logical` (`deps.rs`, `merkle.rs`)
embedded raw `owner_artifact`/`dep_artifact` **ordinals**
(`OrdinalDict` positions) — not canonical across an incremental store's
append-only dictionary (which never renumbers existing entries and
appends new ones strictly at the end, in whatever order affected owners
happen to be processed) versus an independent from-scratch oracle's
freshly-numbered one (sorted by `owner_path`, over the mutated set only).
Fixed `dependency_id`/`dependency_logical`/`dependency_logical_view` to
hash the STRING `(artifact_id, artifact_version_id)` pairs instead of
ordinals (v3, `sha256("urdira:v4-dependency-id:v3\0" || ...)`). **This
also found and fixed a real bug along the way**: `merkle.rs` had TWO
independent copies of the "logical" hash formula
(`dependency_logical` for `DependencyRow`, `dependency_logical_view` for
`DependencyView`) — fixing only the first left `recompute_roots_from_scratch`
(used by `compact`'s own pre/post-compaction equality check) using the
STALE ordinal-based formula, caught immediately by
`cargo test -p urdira-structural-store`'s
`compact_matches_pre_compaction_state_and_respects_refcount` failing
(`dependency` root differed pre/post compaction). Both copies fixed
together.

**Re-ran the n8n oracle test with v3: STILL 35,527/35,527 mismatched, ZERO
overlap.** Ordinal-independence alone was not enough.

### 3.3 Root cause, found via a first-20-differing-edges dump

Added a diagnostic (`tests_e2e.rs::dump_dependency_set_diff`, kept
permanently) that resolves each side's `owner_artifact`/`dep_artifact`
ordinals back to `(artifact_id, artifact_version_id)` strings via that
SAME store's own dictionaries and prints the first 20 differing edges per
side. Every printed pair showed DIFFERENT `artifact_version_id` strings
for what should be the SAME file on both sides. Traced to
`urdira-source-frontier::ids`:

```
artifact_id(workspace_id, normalized_uri)                    -- salted by workspace_id
artifact_version_id(artifact_id, observation_id, content_hash) -- observation_id salted by (workspace_id, generation)
```

Both `artifact_id` (workspace-salted) and `artifact_version_id`
(additionally generation-salted, via `observation_batch_id(workspace_id,
generation)`) are **scan-specific**, not content-addressed. The
n8n-scale oracle test deliberately uses two DIFFERENT `workspace_id`
strings for the incremental run vs. the from-scratch oracle (to avoid
catalog/dictionary collision within one process) and the oracle always
runs at `generation = 1` while the incremental side is at generation ≥ 2
by the time it is compared — so EVERY file's `artifact_id`/
`artifact_version_id` differs between the two sides, even for files whose
CONTENT never changed. Records/graph roots were never affected by this
because `structural_record_digest_hash` (`urdira-native-core`) hashes
only `identity_key`/`body`/`kind`/`category`/etc. — string/content
fields, NEVER `artifact_id`/`artifact_version_id`/an ordinal — the exact
property that already made `records`/`graph` match at n8n scale for
create+delete. `dependency_id`/`dependency_logical` were the one place
in this pipeline that still leaked a scan-specific salt into supposedly
content-addressed identity.

### 3.4 v4 fix: raw paths, not artifact ids

- `urdira-jsts-syntax-worker`: `ProposedRecordDependency` gained an
  additive field, `dependency_target_path: String` (the raw path the
  import specifier resolved to — already available in
  `resolved_dependencies` as `target_path`, just not threaded out before).
- `urdira-indexing-worker::v4::materialize`: `pending_deps` now carries
  the owner's `owner_path` alongside its existing ordinals.
- `urdira-indexing-worker::v4::deps`: `dependency_id` (v4) hashes
  `sha256("urdira:v4-dependency-id:v4\0" || len(owner_path) ||
  owner_path || len(dep_path) || dep_path || role)` — the same raw-path
  primitive `jsts:entity_container`'s own module identity already uses
  (`stable_entity_id`), which is why it is neither workspace- nor
  generation-salted.
- `urdira-structural-store::merkle`: `dependency_logical`/
  `dependency_logical_view` derive from this now-fully-canonical
  `dependency_id` (a dependency row has no independent "content" beyond
  its own identity — `role` is already folded into the id).

**Result, re-run of the SAME n8n oracle test**:
```
n8n-scale root equality CONFIRMED for create+delete against a from-scratch oracle
```
`records`, `dependency`, AND `graph` all match exactly.
`v4::tests_e2e::n8n_incremental_create_delete_roots_match_oracle` passes
(release, ~59s wall including the ~25s from-scratch oracle scan).

**Files**: `crates/urdira-jsts-syntax-worker/src/lib.rs` (additive field
+ `resolved_dependencies` doc), `crates/urdira-indexing-worker/src/v4/{deps.rs,materialize.rs}`,
`crates/urdira-structural-store/src/merkle.rs`,
`crates/urdira-indexing-worker/src/v4/tests_e2e.rs` (diagnostic +
guard).

## 4. Rename via the daemon

### 4.1 The real drop bug (P3-1's stated symptom), found and fixed

`packages/daemon/src/runtime.ts`'s `flushScanAggregation` used to
dispatch a buffered rename/recreate batch as:
```js
scheduleWorkspaceScan(workspaceId, [], [...deletes], activity);          // starts the delete scan
if (presencesAfterDeletes.size > 0) scheduleWorkspaceScan(workspaceId, [...presences], [], activity); // (BUG)
```
The FIRST call's `scanInFlight.add`/`activeAuthoritativeDeletePhases.set`
run SYNCHRONOUSLY (no `await` before either) — so by the second line,
`scanInFlight` was already true and `activeAuthoritativeDeletePhases` was
already set FOR THE SCAN THIS SAME FLUSH JUST STARTED. The second call
therefore fell into the `pendingScans` MERGE branch with
`deletePhaseActive: true`, which reroutes its own uris into
`presencesAfterDeletes` AGAIN — and the post-scan `finally` block's
branch selection only ever reads `pending.uris` when
`pending.authoritativeDeletes` is empty (its own `else` branch), never
`pending.presencesAfterDeletes` in that case. **The created path's
presence silently vanished into a buffer field nothing downstream ever
reads** — this is the exact, previously-undiagnosed root cause of
`rename` being excluded from every P3-1 daemon-driven measurement run.

Fixed by seeding `pendingScans` directly (bypassing
`scheduleWorkspaceScan`/`mergeScanRequestIntoBuffer` a second time),
mirroring the ALREADY-CORRECT pattern the post-scan `finally` block uses
for the identical scenario a few dozen lines below.

### 4.2 Also implemented: one `Changed` call with both entries (the literal ask)

- `packages/engine/src/watchers.ts`: a cross-path rename (an
  authoritative absence of path A plus a presence of a DIFFERENT path B
  in the SAME watcher batch) now reaches `on_reconcile` as ONE combined
  call (`changedUris: [B], authoritativeDeletes: [A]`) instead of two
  sequential calls. A same-path delete-then-recreate (which
  `mapV4ChangedPaths`'s delete-wins dedup would otherwise silently
  collapse to just the delete) still correctly splits into two ordered
  calls — isolated via `samePathRecreates`/`combinableUris`.
- `packages/daemon/src/runtime.ts`: `mergeScanRequestIntoBuffer` no
  longer defers a call's own `changedUris` into `presencesAfterDeletes`
  just because THAT SAME call also carries `authoritativeDeletes` — only
  a PRE-EXISTING buffered delete phase or an ACTIVE in-flight one still
  defers. `flushScanAggregation` and the post-scan `pendingScans`
  follow-up both now dispatch `buffer.uris`/`pending.uris` ALONGSIDE the
  deletes in the delete-scan's own call (previously hardcoded `[]`,
  silently discarding them even after the drop-bug fix above).

### 4.3 Verification

New/updated tests, all passing, using a REAL `DaemonRuntime` + real
filesystem operations (not a fake watcher, per this task's own
instruction to add a daemon test with events split across the burst
boundary and out of order):

- `tests/phase15-workspace-control.test.ts`: `WorkspaceWatcherManager` +
  `DeterministicFakeWatcher` — a cross-path rename batch (absence+presence
  in one `emit()`) now produces exactly ONE `on_reconcile` call; a
  same-path recreate still produces two, in order.
- `tests/phase-daemon-scan-aggregation.test.ts`, new describe block
  "Daemon rename coalescing": (a) a CREATE arriving BEFORE its matching
  DELETE (out of order), both via real syscalls inside one aggregation
  window, collapses to 1-2 scans (never more, proving nothing extra
  leaked) with the create never dropped; (b) a delete's own scan
  SETTLING before a LATER, separate create (split across the burst
  boundary — the exact scenario the bug lived in) still eventually
  schedules a scan for the create — this is the direct regression test
  for §4.1's bug. Both pass stably across repeated runs.

### 4.4 Residual: the real end-to-end `fs.rename()` path still hangs

Running `scripts/v4-mutation-harness.mjs --mutation-kinds rename` against
the REAL n8n corpus (real `DaemonRuntime`, real `ParcelWatcherAdapter`,
an actual `fs.rename()` syscall) still times out (tried at 60s and 90s).
The log shows the DELETE half arriving and completing as its OWN
generation (`v4 delta DEBUG: changed_paths=[(...,"Deleted")]`) — but NO
subsequent scan for the create half EVER starts within the timeout. This
is **not** the bug fixed in §4.1 (that bug was about buffering/dispatch
AFTER both halves reach the daemon; here the create half appears to never
reach the daemon's `on_reconcile` at all). Not root-caused this session;
the most likely remaining suspect, based on what was ruled out, is
`ParcelWatcherAdapter`'s translation of a genuine OS-level `rename()`
(as opposed to the `writeFile`+`unlink` sequence §4.3's tests use, which
DOES work correctly through the identical `mergeScanRequestIntoBuffer`/
`flushScanAggregation` code) — `@parcel/watcher`'s own FSEvents backend
may coalesce a same-batch rename differently at a 20k-file directory
tree's scale, or may only report one half under some condition not yet
identified. Flagged honestly as the clearest remaining item 4 gap:
rename correctness at the `ScanScope::Changed` pipeline level itself
(both halves in one `Changed{paths}` call) IS proven deterministically at
n8n scale (worker-only, §8's `RENAME` row: 1,117-1,345ms, `dependency`/
`records`/`graph` self-consistent) — only the REAL watcher's event
delivery for a genuine rename at this scale remains unverified end to
end. `rename` was therefore excluded from this session's daemon-driven
`--repeat 3` table (§8.2) for the same reason P3-1 excluded it, but the
underlying cause is now understood to be different (and narrower) than
P3-1 believed.

## 5. Mixed bursts (edit + create/delete of a different path)

**Before**: `SyntaxWorkerState::analyze`'s `path_membership_incremental`
fast path requires every path present both before and after the batch to
have kept byte-identical content — a batch mixing a genuine edit with an
unrelated create/delete violates this and falls back to reparsing every
current root.

**Fix**: `crates/urdira-indexing-worker/src/v4/delta.rs`'s `run` (now a
thin dispatcher over the renamed `run_one`, which is the P3-1 pipeline
unchanged) detects a batch with BOTH `ChangeKind::Created`/`Deleted` AND
`ChangeKind::Modified` entries and splits it into TWO sequential internal
generations: structural changes (create/delete) first, then the edit —
each individually a PURE batch that hits `analyze()`'s cheap path on its
own. Both happen inside ONE `WorkspaceScan` command (the daemon/caller
never needs to know); `on_queryable` fires twice, once per generation.
Each pass gets its own fresh `ScanClock` so the reported `ScanTimings`
reflect one pass, not a blend.

**Verified**: new fixture-scale test,
`mixed_burst_edit_plus_create_delete_splits_into_two_generations_and_stays_self_consistent`
— a single `ScanScope::Changed` command naming an edit + a create + a
delete of three different paths consumes exactly 2 internal generations
(asserted `generation_of(&mixed) == 3` after a `generation 1` cold scan);
the incrementally-updated `records`/`dependency`/`graph` roots equal a
from-scratch rebuild of the merkle tree over the store's own final
visible key set (decision-11 self-consistency, same property the pure-edit
test verifies); the created file's records are visible and the deleted
file's are not, confirming both halves actually took effect exactly once
(no double-apply, no skip).

## 6. Hub edit — NOT narrowed via surface-hash; the TRUE bottleneck found instead

**Item 6 as scoped (surface-hash narrowing of the affected closure) was
NOT implemented this session** — judged too large a change to
`reverse_affected_closure`/`path_membership_incremental` (shared,
delicate, v3-and-v4-serving code in `urdira-jsts-syntax-worker`) to
implement and adequately test within this session's remaining time
without a real risk of a subtle correctness regression.

**What WAS done instead: root-caused hub-edit's actual dominant cost with
hard data**, which turned out to be something else entirely, found via
direct bisection instrumentation (kept permanently, `URDIRA_DEBUG_TIMING`-gated,
see `delta.rs`'s "DEBUG BISECT" lines) after profiling pointed away from
an obvious answer:

1. **First, a real, fixed bug**: `StoreReader::deps_by_owner` was an
   unindexed O(total corpus dependency count) linear scan (`for seg { for
   ord in 0..seg.deps_n { if view.owner_artifact() == owner_artifact ...
   } }`), called ONCE PER AFFECTED OWNER by `delta.rs`'s diff loop —
   O(affected_owners × total_deps), unlike `by_owner` (records), which
   already has a real sorted secondary index (`quad_key_range`). Fixed
   with a new IN-MEMORY-ONLY index (`StoreInner.dep_owner_index:
   HashMap<u32, Vec<(usize, usize)>>`, built once per load/reopen exactly
   like the existing `subject_index`) — no on-disk format change. Real
   fix, but **measured as NOT the dominant cost at this scale** (write_ms
   was ~6.0-6.6s before AND after this specific fix, run-to-run noise
   only) — kept because it is unambiguously correct and would matter more
   as deltas accumulate without compaction.
2. **The actual dominant cost, found by bisecting `write_ms` into three
   thirds** (diff loop / `write_delta` / graph merkle): for a hub edit of
   `packages/nodes-base/utils/utilities.ts` (841 transitively-affected
   owners, widened via `reverse_affected_closure`), `diff_owner`
   classifies **~100% of those 841 owners' OWN records as "replacement"
   (different digest), not "unchanged, keep"** — `opened_records`/
   `record_closures` both land around 107,000 (near 1:1), even though
   NONE of those 841 files' own source bytes changed. `record_digest` is
   supposed to be a pure function of `identity_key`/`body`/`kind`/etc.
   (`urdira-native-core::structural_record_digest_hash`) — never
   path-external — so a byte-identical file re-emitting a DIFFERENT
   digest through `facts_for_paths` means something order- or
   context-dependent in that extraction path differs between the original
   parse and this incremental re-extraction (candidates, not yet
   isolated: `evidence_references`/`proposal_record_key` sensitivity to
   which OTHER paths are in the same `facts_for_paths` batch, or a
   relative-index field). **This is the true dominant cost**: ~5.8s of a
   ~6.9s hub-edit total at 841 owners (graph-merkle-update time, itself
   downstream of `graph_changes` scaling with the same near-total churn:
   178,653 graph changes for 841 owners); ~17-24s of write time at 2,196
   owners (`migration-types.ts`, the daemon-driven table's own hub-edit
   candidate).
3. Item 6's ORIGINALLY-scoped fix (surface-hash-narrow-the-closure) would
   ALSO have sidestepped this bug by construction — if an importer whose
   referenced export didn't change were never included in the affected
   closure at all, its records would never reach `diff_owner` and this
   churn would never happen, regardless of its root cause. The two
   findings are complementary, not competing: #2 explains WHY the
   currently-included closure is so expensive per owner; the
   not-implemented surface-hash fix is what would shrink the closure size
   itself.

**Measured** (worker-only, `packages/nodes-base/utils/utilities.ts`, 841
affected owners after widening):

| Variant | diff loop | `write_delta` | graph merkle | total |
|---|---:|---:|---:|---:|
| surface-unchanged (append-only, matches `applyEditFile`) | 0.204s | 3.174s (3.378−0.204) | 2.486s (5.864−3.378) | 6.901s |
| surface-changed (renames an existing export) | 0.248s | 3.541s | 2.481s | 7.904s |

Both variants cost essentially the SAME — direct, quantitative proof that
no surface-hash distinction exists yet (as expected, since it was not
implemented).

**Not fixed this session**: the digest-churn root cause itself (needs
deeper tracing through `facts_for_paths`'s extraction order-sensitivity,
which touches shared `urdira-jsts-syntax-worker` code this session judged
too risky to modify blind); the surface-hash closure-narrowing item 6
itself asked for.

## 7. Harness hardening

- `execFileWithEbadfRetry`: retries `spawn EBADF` (P3-1's own §7.7
  finding) up to 3 attempts, 250ms backoff, wrapping `oracleVerify`'s
  subprocess spawn. Still hit `spawn EBADF` even after 3 retries once
  this session (during the FINAL oracle-verify step of a 15-mutation
  daemon-driven run, after ~6 minutes of sustained daemon/worker activity)
  — consistent with P3-1's own characterization ("session-wide
  process/fd-table pressure ... not a defect in this task's own code"),
  worked around (not fixed) by driving the harness's exported `run()`
  directly with `verify_roots: "skip"` for that specific run (same
  technique P3-1 used) rather than adding a fourth retry.
- `--warm N`: runs N throwaway edit mutations before the timed sequence,
  isolating cold-cache effects from steady-state numbers; used with
  `--warm 1` in every daemon-driven run in §8.2.
- §0's read-only-corpus guard (marker-file check + scratch-copy routing).

## 8. Measurement

Idle machine confirmed (`pgrep -f "v4-scan|urdira-indexing-worker|n8n-incremental-preflight"`
empty) before every run below.

### 8.1 Worker-only n8n table (`n8n_incremental_measurement`, release, in-process, no daemon/watcher)

| Phase | COLD | EDIT#1 (cold-cache) | EDIT#2 (steady) | CREATE | DELETE | EDIT#3 (steady) | RENAME | HUB surface-unchanged (841 owners) | HUB surface-changed (841 owners) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| catalog_ms | 5,398 | 11 | 3 | 5 | 1 | 3 | 9 | 5 | 6 |
| parse_ms | 1,036 | 2,006 | 396 | 565 | 574 | 268 | 854 | 301 | 1,080 |
| resolve_ms | 1,461 | 546 | 96 | 64 | 66 | 70 | 88 | 171 | 201 |
| materialize_ms | 8,850 | 69 | 29 | 20 | 20 | 24 | 24 | 281 | 306 |
| write_ms | 3,923 | 230 | 240 | 176 | 178 | 194 | 207 | 6,630 | 6,228 |
| **total_ms** | **21,402** | **3,457** | **918** | **976** | **989** | **703** | **1,345** | **7,564** | **8,068** |

(A second, independent full run — the one bisection instrumentation was
added and verified against — produced EDIT#2 918ms/EDIT#3 880ms/CREATE
976ms/DELETE 989ms/RENAME 1,117-1,345ms/HUB 6,901-7,904ms, all within run-
to-run noise of the table above; both are reported honestly rather than
picking the more flattering one.)

Gate comparison (plan §Gate P3, worker-only):

| Kind | Target | This session | P3-1 baseline | Verdict |
|---|---|---:|---:|---|
| Edit p50 (steady) | ≤ 500ms | 703-918ms | 1,144ms | Missed target; ~20-38% faster than P3-1 |
| Create/delete | ≤ 1s | 976-989ms | 1,153-1,178ms | **Met** (both ≤ 1s); ~15-16% faster |
| Rename | (n/a in P3-1's gate; new this session) | 1,117-1,345ms | not measured | New measurement |
| Hub edit | ≤ 1.5s | 6,901-8,068ms (841 owners) | not isolated | Missed by a wide margin — §6's digest-churn finding, not item 1/2/7's scope |

### 8.2 Daemon-driven table (`scripts/v4-mutation-harness.mjs`, real `DaemonRuntime` + real watcher, `--repeat 3 --warm 1`, `rename` excluded per §4.4)

Cold: queryable_ms = durable_ms = 26,481.1ms (generation 1). (P3-1's own
cold was 22,352.3ms daemon-driven — the ~4s difference here is judged
session/environment noise: this session's own WORKER-ONLY cold measured
21,402-21,971ms across all three of its own runs, consistent with P3-1's
number; cold was not a target of any P3-2 item.)

| Kind | This session median (ms) | This session range (ms) | P3-1 median (ms) | P3-1 range (ms) | Δ |
|---|---:|---:|---:|---:|---:|
| edit | 4,549.1 | 4,158.3 – 5,701.9 | 5,603.7 | 4,881.8 – 6,801.4 | ~19% faster |
| create | 5,218.0 | 5,005.1 – 5,420.1 | 5,610.3 | 5,358.9 – 5,805.3 | ~7% faster |
| delete_leaf | 4,903.0 | 4,664.8 – 5,450.4 | 5,619.9 | 4,799.0 – 5,619.9 | ~13% faster |
| delete_with_importers | 4,910.4 | 4,904.5 – 5,102.9 | 4,980.9 | 4,266.5 – 5,754.2 | ~1% faster (noise) |
| hub_edit (261-importer file) | 11,961.6 | 7,137.8 – 23,935.9 | 12,174.5 | 6,468.7 – 23,924.1 | ~2% faster (noise) — §6's finding dominates, unaddressed |

Gate targets (durable p50 ≤ 700ms, p95 ≤ 1,000ms for edit; create/delete/
rename ≤ 1s) are **not met** at the daemon level for any kind — as P3-1
already found and this session confirms is NOT the worker's own compute
(§8.1's worker-only numbers are all sub-2s except hub edit): the
daemon-driven numbers are dominated by the real filesystem watcher's own
detection latency plus the `scan_aggregation_window_ms` debounce window
(commit `88b07fa`, unchanged this session, outside this task's Rust
ownership), on top of the worker compute this session's items target.
This gap is inherited from P3-1's own §7.2 finding, not newly introduced.

### 8.3 Roots / correctness summary

- `records`/`dependency`/`graph` all match a from-scratch n8n-scale
  oracle EXACTLY for CREATE+DELETE (§3.4, `n8n_incremental_create_delete_roots_match_oracle`)
  — the dependency-root gap P3-1 left open is CLOSED.
- The "incremental Merkle == from-scratch rebuild of the SAME final key
  set" self-consistency property (decision 11's own gate language) is
  verified for: a pure edit (pre-existing P3-1 test, still passing), a
  mixed edit+create+delete burst (new, §5), and every fixture/n8n-scale
  create/delete/rename test already in the suite.
- The shared n8n corpus is confirmed byte-identical to its
  `~/Proyectos/n8n@b3a34fcd81` reference (§0) after every
  mutation/harness/daemon run performed in this document.

## 9. Quality gates

- `cargo fmt --all -- --check` — clean.
- `cargo clippy -p urdira-jsts-syntax-worker -p urdira-indexing-worker -p urdira-structural-store -p urdira-indexing-core -p urdira-worker-protocol -p urdira-source-frontier -p urdira-jsts-indexing-engine --all-targets -- -D warnings` — clean.
- `cargo test` on the same 7 crates — **all pass** (urdira-jsts-syntax-worker 33/33+2 ignored, urdira-indexing-worker 62/62+3 ignored [+1 net new test vs. P3-1's 61], urdira-jsts-indexing-engine 151/151, urdira-structural-store all integration files including the compaction test §3.2 caught and the fix confirmed, urdira-indexing-core 33/33+2 ignored, urdira-worker-protocol 8/8+4 fixture, urdira-source-frontier 33/33).
- `npx vitest run tests/phase-daemon-v4-scan.test.ts tests/v4-mutation-harness.test.ts tests/v4-daemon-e2e.test.ts tests/v4-scan.test.ts tests/native-query-snapshot-port.test.ts tests/phase-daemon-scan-aggregation.test.ts tests/phase15-workspace-control.test.ts` — **7 files, 61 passed, 2 skipped (expected: no release artifacts guard), 0 failed.** (`tests/phase15-workspace-control.test.ts` is this session's stand-in for "whatever covers watchers.ts" — no dedicated `phase7-watchers.test.ts` exists in this repo; `WorkspaceWatcherManager` coverage lives there.)
- `pnpm --filter @urdira/daemon exec tsc --noEmit` / `pnpm --filter @urdira/engine exec tsc --noEmit` — both clean.
- `npx eslint packages/daemon/src/runtime.ts packages/engine/src/watchers.ts scripts/v4-mutation-harness.mjs tests/phase15-workspace-control.test.ts tests/phase-daemon-scan-aggregation.test.ts tests/v4-mutation-harness.test.ts` — clean.
- Full-repository `pnpm verify` NOT run: same rationale as P3-1's own evidence doc (extensive concurrent uncommitted work from other in-flight sessions across unrelated packages/crates) — every gate above is scoped to exactly the files this task touched.

## 10. Files touched

Owned, modified:
- `crates/urdira-indexing-worker/src/v4/state.rs` — `SourceCache` (item 1).
- `crates/urdira-indexing-worker/src/v4/analyze.rs` — `run_scoped`/`run_cold`/`run_incremental` consume a pre-built cache instead of building one (item 1); `is_jsts_source_path`/`is_config_asset_path`/`blob_path` made `pub(crate)`.
- `crates/urdira-indexing-worker/src/v4/scan.rs` — `run_full` seeds `SourceCache` on success.
- `crates/urdira-indexing-worker/src/v4/delta.rs` — cache maintenance (item 1); `write_delta_with_reader` call (item 2); `run`/`run_one` split for mixed bursts (item 5); permanent DEBUG BISECT diagnostics (item 6).
- `crates/urdira-indexing-worker/src/v4/deps.rs` — `dependency_id` v3→v4 (item 3).
- `crates/urdira-indexing-worker/src/v4/materialize.rs` — `pending_deps` carries `owner_path` (item 3); removed unused `OrdinalDict::value_at` (added then found unnecessary once the path-based recipe landed).
- `crates/urdira-indexing-worker/src/v4/tests_e2e.rs` — read-only-corpus guard (item 0); `dump_dependency_set_diff` diagnostic (item 3); extended `n8n_incremental_measurement` with EDIT#3/RENAME/HUB_EDIT×2 (item 8); new `mixed_burst_edit_plus_create_delete_splits_into_two_generations_and_stays_self_consistent` test (item 5).
- `crates/urdira-structural-store/src/writer.rs` — `write_delta_with_reader` (item 2).
- `crates/urdira-structural-store/src/merkle.rs` — `dependency_logical`/`dependency_logical_view` derive from the now-canonical `dependency_id` (item 3).
- `crates/urdira-structural-store/src/reader.rs` — `StoreInner.dep_owner_index` + `deps_by_owner` O(1) rewrite (item 6/8).
- `crates/urdira-jsts-syntax-worker/src/lib.rs` — `ProposedRecordDependency.dependency_target_path` additive field; `resolved_dependencies` returns the target path (item 3).
- `packages/daemon/src/runtime.ts` — `mergeScanRequestIntoBuffer`, `flushScanAggregation`, post-scan `pendingScans` follow-up (item 4).
- `packages/engine/src/watchers.ts` — cross-path rename combining (item 4).
- `scripts/v4-mutation-harness.mjs` — read-only guard + two bugs found/fixed in it (item 0/7); EBADF retry + `--warm` (item 7).
- `tests/phase15-workspace-control.test.ts` — rename test rewritten for the new combined-call behavior + new same-path-recreate test (item 4).
- `tests/phase-daemon-scan-aggregation.test.ts` — two new real-`DaemonRuntime` rename-coalescing tests (item 4).

## 11. Deviations/residuals summary

1. **Item 6 (surface-hash closure narrowing) NOT implemented** — judged too large a change to shared `urdira-jsts-syntax-worker` machinery for this session's remaining time without real correctness risk. In its place, the TRUE dominant hub-edit cost was found and precisely quantified (§6): `diff_owner` treats ~100% of a transitively-affected-but-content-unchanged owner's records as "replacement," not "unchanged" — root cause (an order/context-dependent field in `facts_for_paths` extraction) not yet isolated. This is the clearest, most actionable open item for whoever continues, with an exact repro and bisection instrumentation already in the tree.
2. **Item 4's real end-to-end rename path (genuine `fs.rename()` through the real daemon watcher at n8n scale) still hangs** (§4.4) — a different, narrower, not-yet-root-caused issue than the one this session found and fixed (§4.1); most likely in `ParcelWatcherAdapter`'s translation of a real OS rename at this corpus scale. The underlying `ScanScope::Changed` pipeline handling of a rename (both halves in one call) IS proven correct and fast at n8n scale (worker-only).
3. Worker-only steady-state edit (703-918ms) still misses the ≤500ms target — item 1's fix measured a genuine 14-28% improvement but two further O(corpus) costs remain inside the shared syntax worker (`prior.files.clone()`, `reresolve_file`'s corpus-wide sweep for add/remove batches) that this session did not touch.
4. Daemon-driven numbers for every kind still miss their sub-second targets — inherited, unchanged root cause from P3-1 (watcher detection latency + debounce window, outside this task's Rust ownership); this session's worker-only improvements are real but diluted by that larger, untouched daemon-side cost.
5. `spawn EBADF` recurred once even with the new 3-attempt retry, during a long, high-load session — worked around via the harness's own `run()` export with `verify_roots: "skip"`, not fixed (same environment-level characterization as P3-1's own §7.7).
6. Two real, previously-undiagnosed bugs were found and fixed purely by attempting this task's own hard rule (§0): the harness's read-only guard triggering a false positive on its own scratch copy, and a Unix-socket path-length overflow from routing the daemon's data root through the (long) mandated scratch directory.
