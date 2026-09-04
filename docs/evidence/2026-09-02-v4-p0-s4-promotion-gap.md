# P0-S4: instrumented promotion gap + n8n@14083 cold publish (2026-09-02)

Machine: macOS arm64 (MacBookPro18,2), 10 cores, 32 GB RAM. Node v24.18.1, `rustc` per `cargo --version` in this checkout. Commit at instrumentation time: `88b07fac08aef250eba69c96f16a644ae575d0e1` (working tree carries the uncommitted changes listed at the end of this doc; per task instructions nothing was committed).

Corpus: `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02` (14,083 owners, matches `docs/evidence/2026-09-02-edit-latency.md`'s corpus).

## What this closes and what it does not

Goal 1 (fine-grained `debug_publish_phase` instrumentation of the incremental-publish promotion gap) is **done and verified working**, including on the direct-publication branch mutations actually use (confirmed with a 60-owner/3-mutation smoke run, see below). Goal 2 (a retained, fully indexed n8n@14083 workspace database **plus** per-mutation timings) is **half done**: the database was obtained (run 1), but the 3 mutations never ran in either attempt — both runs hit a follow-up full rescan that crashes immediately after the cold publish, before mutation 0 starts. Steady-state mutation timings were **not** obtained in this campaign. The 2026-09-02 morning numbers in `docs/evidence/2026-09-02-edit-latency.md` remain the reference for the actual edit-latency picture: **publish ≈ 6.4 s steady-state**, of which `visible_record_digest` ≈ 2 s + projection digests ≈ 0.8 s (≈ 2.8 s of digest work) and closures 9–17 ms, leaving a **≈ 1.9 s promotion gap** this task set out to attribute. That gap is now attributable per-statement (see the cold table below, which exercises the identical direct-publication code path) but was never re-measured on an actual single-file edit this session.

## Commands run

```
pnpm -r build
node scripts/build-native.mjs
URDIRA_DEBUG_TIMING=1 node scripts/n8n-incremental-preflight.mjs \
  --corpus ~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02 \
  --native-root ~/Proyectos/urdira/release/native/darwin-arm64 \
  --owners 14083 --mutations 3 --readiness-timeout-ms 7200000 \
  --data-root ~/Proyectos/urdira-benchmark/v4-p0/data \
  --output ~/Proyectos/urdira-benchmark/v4-p0/preflight.json
```
Run 1 (log: `.../v4-p0/run.log`, retained data root: `.../v4-p0/data/`) — plugin-resolution/chunking fix not yet applied — failed after cold publish. Run 2 (log: `.../v4-p0/run2.log`, data root `.../v4-p0/data-run2/`, **deleted after this doc was written**, 13 GB) — same fix applied, same failure shape, more detail captured. Neither run produced `preflight.json`; both processes exited non-zero before the harness could write it.

## Cold publish, per-statement promotion table

Both runs exercise `request.direct_publication = true` (confirmed by the `direct structural record rows=N` log lines), the same branch a real single-file edit takes at this harness/scale — so this table is a structurally faithful (if not size-faithful) preview of what the promotion gap looks like broken down by statement, even though it was measured at cold-insert volume (14,235 records) rather than edit volume (1–2 records).

All times are per-statement deltas in ms, computed from the cumulative `publication phase=... elapsed_ms=` markers `debug_publish_phase` emits (new markers this task added, `crates/urdira-indexing-worker/src/main.rs`).

| Phase (marker) | Run 1 (ms) | Run 2 (ms) | What it is |
|---|---:|---:|---|
| source_transitions | 0 | 0 | derive_source_transitions |
| control_plane | 1 | 0 | lookup_revalidations upsert (none staged) |
| promo_descriptor_read | 0 | 0 | SELECT candidate_publication_descriptors |
| promo_update_cpro | 0 | 0 | UPDATE candidate_publication_record_occurrences valid_from_generation |
| promo_update_facets | 0 | 0 | UPDATE candidate_publication_record_facets valid_from_generation |
| promo_update_ident | 0 | 0 | UPDATE candidate_publication_identity_assignments valid_from_generation |
| promo_update_closures_vf | 0 | 0 | UPDATE candidate_publication_record_closures valid_to_generation |
| promo_update_descriptors | 0 | 1 | UPDATE candidate_publication_descriptors (digests, sealed_at) |
| promo_records_exist_probe | 0 | 1 | EXISTS probe + cold-only DROP INDEX (record_occurrences accelerators) |
| **promo_record_insert** | **51,212** | **51,191** | direct INSERT INTO record_occurrences ... SELECT FROM urdira_core_owner_rows (14,235 rows) |
| **promo_facet_insert** | **35,745** | **37,037** | direct INSERT INTO record_facets ... JOIN urdira_core_owner_facets |
| promo_closures_update | 1 | 0 | UPDATE record_occurrences SET valid_to_generation (no prior rows, no-op) |
| promo_identities_exist_probe | 2 | 2 | EXISTS probe + cold-only DROP INDEX (identity_assignments accelerators) |
| **promo_identity_insert** | **37,206** | **41,460** | direct INSERT INTO identity_assignments (cold branch, no previous-generation CTE) |
| record_and_identity_promotion (cumulative marker) | 0 | 0 | (same instant as promo_identity_insert) |
| dependency_promotion | 11,881 | 15,581 | artifact_dependencies promotion |
| visible_record_digest | 22,013 | 29,135 | streamed visible-record-set digest over 3,192,089 rows |
| projection_set_digest | 27 | 29 | empty projection set digest (n8n has 0 projections) |
| cold_index_rebuild (total) | 172,983 | 162,047 | sum of the 9 accelerator CREATE INDEX statements below |
| analyze_stats | 50,493 | 59,117 | ANALYZE record_occurrences; ANALYZE identity_assignments |
| snapshot_and_current_state | 1 | 1 | workspace_current_state upsert |
| commit_ms (SQLite commit, `urdira-indexing-core`) | 20,161 | 34,420 | transaction commit / WAL fsync |
| cold_checkpoint_ms | 79,701 | 88,240 | post-commit WAL checkpoint (writer-lease-held) |
| **rust core publish ms (total)** | **481,780** | **518,709** | whole `publish()` call in `urdira-indexing-core` |

### cold_index_rebuild, per accelerator index (ms)

| Index | Run 1 | Run 2 |
|---|---:|---:|
| record_occurrences_visible_idx | 7,679 | 8,824 |
| identity_assignments_owner_key_idx | 29,869 | 26,521 |
| record_occurrences_workspace_owner_idx | 18,560 | 14,018 |
| record_occurrences_workspace_owner_version_idx | 34,066 | 23,021 |
| identity_assignments_lookup_idx | 17,664 | 16,234 |
| identity_assignments_key_idx | 50,812 | 46,562 |
| identity_assignments_record_idx | 13,707 | 26,330 |
| artifact_dependencies_reverse_idx | 485 | 336 |
| artifact_dependencies_direct_idx | 130 | 193 |

### Cold scan totals (`scan timings ... status=published`)

| Field | Run 1 | Run 2 |
|---|---:|---:|
| enumerate | 7,132 ms | 7,144 ms |
| source_catalog | 30,053 ms | 29,706 ms |
| source_ready_ms | 37,194 ms | 36,859 ms |
| source_deferred_commit_count / version_count | 5 / 14,235 | 5 / 14,235 |
| stage_plan | 1,409 ms | 1,139 ms |
| plugin_analyze | 290,212 ms | 282,317 ms |
| publish | 483,022 ms | 519,990 ms |
| **structural_ready_ms / total** | **811,852 ms (≈ 13.5 min)** | **840,320 ms (≈ 14.0 min)** |

Run-to-run variance (≈4% on `total`, up to ≈20% on individual accelerator indexes) is consistent with ordinary machine noise on a 10-core box running a single-threaded SQLite writer at this scale; nothing here suggests either run was abnormal prior to the post-cold failure.

## What actually happened after cold (both runs) — root cause and why the retry/chunking fix did not save run 2

Both runs publish cold successfully (`scan timings ... status=published`), then almost immediately hit a **follow-up full workspace scan** that fails before mutation 0 is ever requested by the harness. Two independent problems compound:

1. **The follow-up scan should not exist at all, or should be a fast no-op.** `resolvePluginProvider` (`packages/daemon/src/runtime.ts`, guarding `apps/urdira/src/index.ts:1880`'s `selected_plugin_ids` check) returned nothing for this workspace in run 1, sending it down the `runSourceOnlyWorkspaceScan` fallback — a legitimately reachable path in the code, but not for a workspace whose `selected_plugin_ids` never changes after `workspace add`. A defensive bounded retry was added for this (`pluginResolutionMissingRetries`, mirroring `WORKSPACE_WRITER_BUSY_MAX_RETRIES`'s pattern) but the exact trigger for the missing-plugin resolution itself was not conclusively identified (leading theory: `createIndexingCoreProcessTransport` re-spawn failing transiently right after the cold publish's RSS/fd pressure — not proven).

2. **Run 2 (with the retry fix in place) took the plugin-backed path this time** (`runFullWorkspaceScan`, not the source-only fallback) but still crashed with the identical `Rust worker message exceeds its byte or in-flight budget.` error, this time from the **deferred watch-commit flush**: `packages/engine/src/workspace-indexing-session.ts` lines ~1013–1032 (`deferredWatchCommits` / `sourceCommit({ operation_id: "source-watch:...", commits: deferredWatchCommits })`), entered only when `authoritative_delete_events` is non-empty for this scan. `commit_source_index` rows logged just before the crash: `artifacts=14235 versions=14235 commits=1` — the entire corpus, as **one** commit object. My `chunkSourceIndexCommits` fix (`indexing-core-process-transport.ts`) only splits the **outer** `commits` array into several messages; it cannot help when the oversized payload is a **single** commit object whose own inner `versions` array already exceeds the 16 MiB ceiling by itself. That is exactly this case, and is explicitly called out as an unhandled edge case in that function's doc comment.

3. **Why did the watcher deliver an authoritative-delete batch for ~14k paths on a corpus nothing touched?** Concrete, code-verified facts:
   - The periodic reconciliation sweep (`runtime.ts` ~3244–3274, default every 300,000 ms) always calls `scheduleWorkspaceScan(id, undefined, [], ...)` with an **empty** `authoritativeDeletes` array, and additionally skips any workspace not already `"ready"`/`"degraded"` — it cannot be the trigger (it would never reach the watch-commit branch, and the workspace was still `"indexing"` for the ~13.5–14 minutes the sweep would have ticked during cold).
   - The only call site that ever passes a non-empty `authoritativeDeletes` array is the real filesystem watcher's `on_reconcile` callback (`runtime.ts:2712-2713`), fed by `WorkspaceWatcherManager` (`packages/engine/src/watchers.ts` ~140–160): a batch event is classified `authority: "authoritative_delete"` + `event_class: "absence"` by the watcher backend (FSEvents on this machine, via `@parcel/watcher`), then `on_reconcile` treats an authoritative-delete batch as its own generation before folding in any co-arriving presences.
   - The watcher subscribes at `core:workspace_add` time (`startWorkspaceWatcher`, called from the `workspace add` handler), i.e. **before** the ~13.5-minute cold scan even starts reading the corpus — so this is almost certainly a large, buffered watcher batch (FSEvents historical/coalesced replay over a 14k-file tree that was fully written moments before the subscription) that only got processed once the daemon's event loop had a turn again after the long CPU-bound cold scan released it, not a real filesystem change (nothing in the harness touches the corpus between `createSlice` and mutation 0). This was not proven live (would require another ~14-minute run with added logging in `watchers.ts` to capture the raw batch), but it is the only mechanism in the code that both (a) can produce a non-empty `authoritativeDeletes` array and (b) plausibly fires with total-corpus scope immediately post-cold on both runs.
   - Separately, why the resulting watch commit's `versions` array has 14,235 entries (i.e., looks like a full re-materialization, not just 14,235 tombstones) was not traced into `GenericSourceIndexer.apply()`/`authoritativeWatchResponse` this session; a plausible mechanism is that the prior-frontier read (`database.repositories.snapshots.getCurrent()` at the top of `runFullWorkspaceScan`) raced the just-committed cold generation's own visibility on this new scan's connection, making every path look "new" relative to an empty/stale frontier — not confirmed.

### Correct fix direction (described, not implemented — v4 deletes this path)

- **Chunk within a commit, not just across commits.** Extend the deferred-commit accumulation (`workspace-indexing-session.ts`'s `defer_commit`, or a wrapping layer before `sourceCommit(...)` is called) to split one oversized commit's `versions`/`artifacts`/`observations`/`content_blobs` arrays into several `commits` entries that all share the same `expected_state_revision`, matching how `apply_source_index_commits` (`crates/urdira-indexing-worker/src/main.rs`) already validates a shared frontier across multiple commit objects in one call — this generalizes the outer-array chunking already shipped this session (`chunkSourceIndexCommits`) down to the sub-array grain.
- **Or: make an all-paths "equivalent" watcher batch cheap.** If the true cause is a spurious full-tree replay, detect that the resulting delta is a no-op (every path's content digest matches what is already durably cataloged) before materializing 14k `versions`/absence rows, short-circuiting to "equivalent, nothing to commit" the way an ordinary no-change scan already does elsewhere in this pipeline.
- **Or, most targeted: don't let a workspace's own watcher compete with its own cold/full scan.** The scan's own enumeration is already the authoritative frontier the instant `markReady` runs; any watcher batch queued during that same scan (this one subscribed before cold started) is redundant by construction and could be dropped or coalesced into a no-op reconcile rather than replayed as a fresh full generation immediately after.

None of these were implemented: per the coordinator's decision, the TypeScript source-commit-over-IPC path this bug lives in is deleted entirely by the v4 migration, so investing further here is out of scope.

## Retained database (run 1 only — run 2's 13 GB data root was deleted after this doc was written)

`~/Proyectos/urdira-benchmark/v4-p0/data/workspaces/workspace_corpus_81e5eb4d-e69d-4931-b182-eea7005d20bb.sqlite` — **13,866,848,256 bytes (≈ 12.9 GiB)**. Workspace record in `data/workspaces.json`: `has_completed_first_scan: true`, `current_snapshot_id` set to a real published snapshot, `status: "degraded"` (from the post-cold scan failure above — the structural data itself is the valid, durable cold-publish result; only the *next* scan attempt failed). `data/catalog.sqlite` and `data/cas/` are the sibling catalog/CAS stores for the same run.

Row counts (`sqlite3` CLI):

| Table | Count |
|---|---:|
| record_occurrences | 3,192,089 |
| identity_assignments | 3,192,089 |
| record_facets | 3,505,282 |
| artifact_dependencies | 30,838 |
| graph_edges | 0 |
| record_value_nodes | 0 |
| metric_projections | 0 |

`body_byte_length`: SUM = 1,242,404,649 bytes (≈ 1.16 GiB), AVG ≈ 389.2 bytes/record.

Top `record_occurrences.kind` by count:

| kind | count |
|---|---:|
| jsts:relation_references | 1,110,576 |
| jsts:relation_call | 734,379 |
| jsts:diagnostic | 697,193 |
| jsts:relation_contains | 240,459 |
| jsts:entity_variable | 211,909 |
| jsts:relation_import | 58,302 |
| jsts:relation_type_of | 45,241 |
| jsts:entity_inferred_type | 45,241 |
| jsts:entity_callable | 15,879 |
| jsts:entity_container | 14,082 |
| jsts:entity_type | 12,671 |
| jsts:relation_export | 2,336 |
| jsts:relation_implements | 1,726 |
| jsts:relation_inherits | 1,447 |
| jsts:relation_covers | 648 |

`graph_edges`, `record_value_nodes`, and `metric_projections` are empty for this workspace (n8n's JS/TS plugin output does not populate them at this schema version / this corpus has no projections).

## Files changed this session (uncommitted)

- `crates/urdira-indexing-worker/src/main.rs` — 11 new `debug_publish_phase` markers between `control_plane` and `record_and_identity_promotion`/`dependency_promotion` (`promo_descriptor_read`, `promo_update_cpro`, `promo_update_facets`, `promo_update_ident`, `promo_update_closures_vf`, `promo_update_descriptors`, `promo_records_exist_probe`, `promo_record_insert`, `promo_facet_insert`, `promo_closures_update`, `promo_identities_exist_probe`, `promo_identity_insert`), all gated on `URDIRA_DEBUG_TIMING`, both direct- and non-direct-publication branches.
- `crates/urdira-indexing-core/src/lib.rs` — `temp_index_create_ms` timing around the TEMP accelerator index creation (`publish`, ~line 1857), and split `promote_direct_publication_metadata`'s single `descriptor_upsert_ms` into `candidate_descriptor_upsert_ms` + `projection_descriptor_upsert_ms`.
- `scripts/n8n-incremental-preflight.mjs` — new optional `--data-root <absolute path>` flag: when given, uses it as the controller's durable `data_root` (validated empty/absent and disjoint from `--corpus`) and never deletes it; default behavior (temp data root, deleted at the end) unchanged when omitted.
- `packages/daemon/src/runtime.ts` — a workspace whose `resolvePluginProvider` call returns nothing while it has a non-empty `selected_plugin_ids` now gets a bounded, delayed retry (`pluginResolutionMissingRetries`, 8 attempts, mirrors `WORKSPACE_WRITER_BUSY_MAX_RETRIES`) instead of immediately, permanently degrading to the generic source-only scan.
- `packages/plugin-javascript-typescript/src/indexing-core-process-transport.ts` — new exported `chunkSourceIndexCommits(commits, maxMessageBytes)` splits an oversized `commit_source_index` payload into several whole-commit-object messages (`finalize_state: false` on all but the last); `commitSourceIndex` now sends chunks in sequence instead of one unbounded message. Does not help when a single commit object is itself oversized (see failure analysis above).
- `tests/javascript-typescript-indexing-core-transport.test.ts` — new: 4 unit tests for `chunkSourceIndexCommits` (fits-in-one-chunk, empty/singleton, splits-preserving-order-under-budget, single-oversized-commit-emitted-alone).

## Test/build results

- `cargo fmt --all` clean.
- `cargo clippy -p urdira-indexing-worker -p urdira-indexing-core --all-targets -- -D warnings` clean. (Whole-workspace `cargo clippy`/`cargo test` currently fails on an unrelated, concurrently-mid-write crate, `crates/urdira-v4-spike`, missing `src/main.rs` — not part of this task, not touched.)
- `cargo test -p urdira-indexing-worker -p urdira-indexing-core`: 25 + 38 passed, 1 ignored (bench), 0 failed.
- `pnpm -r build`: clean, full (never filtered).
- `pnpm exec vitest run tests/javascript-typescript-indexing-core-transport.test.ts tests/javascript-typescript-rust-protocol.test.ts tests/phase-daemon-indexing-integration.test.ts tests/phase-daemon-scan-aggregation.test.ts tests/phase-workspace-indexing-session.test.ts`: 5 files / 58 tests passed.
- A 60-owner/3-mutation smoke run (temp data root, not retained) with the same rebuilt binaries completed cold + all 3 mutations successfully, with every new marker firing correctly on the direct-publication branch (confirms the instrumentation itself works; the n8n@14083 failure above is unrelated to it).

No commit was made, per task instructions.
