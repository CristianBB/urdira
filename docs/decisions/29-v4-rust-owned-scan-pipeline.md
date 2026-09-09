# Decision 29: v4 Rust-owned worker scan pipeline (cold, incremental, and reconcile)

Status: **Accepted**
Last updated: 2026-09-09
Depends on: [v4 structural store](26-v4-structural-store.md), [v4 merkle bucket digests](27-v4-merkle-bucket-digests.md), [v4 Rust semantics and residual checker](28-v4-rust-semantics-and-residual-checker.md), [Native pipeline and relational storage](21-native-pipeline-relational-storage.md), [Content-derived record identity](11-content-derived-record-identity.md)
Campaign summary (Spanish, non-normative): `docs/evidence/2026-09-05-v4-campaign-summary.md`, `docs/evidence/2026-09-06-v4-reconcile-threshold.md`

## Current state (2026-09-09)

Cold (`Full`), incremental (`Changed`), git-aware catch-up (`Reconcile`,
added 2026-09-06), typeflow, pending sites with candidate discipline, and
the background residual-checker generation are all implemented and
daemon-wired. v4 is the default for newly added workspaces since
2026-09-04 (opt out with `URDIRA_V4=0`). Cold numeric gates (`Queryable` ≤
8 s, `ScanCompleted` ≤ 12 s, RSS ≤ 3 GiB) are **not met**: the current n8n
figure is `total_ms` median 23.4 s / wall 25.2 s / RSS median 6.11 GiB
(`docs/evidence/2026-09-07-v4-f3-cold-incremental-floors-parity-threshold.md`
§1.3, superseding the older 27-32 s / 6.56-8.16 GiB figure in "Measured
cold performance" below). The worker-only incremental gate is met for
every mutation kind; the daemon-observed edit gate ("durable < 1 s") is
**not met**. The P2-2m `identity_key`-zeroing
corruption reported as an open critical bug through 2026-09-05 is **fixed**
— see decision 26's changelog. `RECONCILE_DELTA_THRESHOLD` (below) is
**0.01**, not the 0.25 default the scope first shipped with — measured and
lowered the same week it landed (see "Historial de cambios").

## Decision

For a v4 workspace, the persistent per-workspace `urdira-indexing-worker`
process owns the entire scan — catalog, parse, semantic resolution
(E1-E3 + typeflow), materialization, segment write, Merkle maintenance,
SQLite snapshot publication, and, after `ScanCompleted`, an optional
background residual-checker generation — driven by a single new protocol
command, `IndexingCommand::WorkspaceScan`, replacing the
TypeScript-orchestrated, multi-message v3 generation protocol for every
workspace on v4. TypeScript's role is reduced to sending one command,
applying readiness from the resulting events, and serving the 18 query
operations from the native structural store (decision 26) plus the
unchanged SQLite catalog/lexical/semantic sidecars.

### Protocol

```rust
IndexingCommand::WorkspaceScan {
  request_id, workspace_id, workspace_root, database_path,
  structural_root, cas_root, sidecar_root,
  scope: ScanScope,  // Full | Changed { paths: Vec<{ path, kind: Created|Modified|Deleted }> } | Reconcile
  registry_snapshot_id, configuration_revision_id, resolution_lock_id,
  deadline_ms: Option<u64>, priority: Interactive | Background,
}
IndexingEvent::Queryable        { request_id, operation_id, generation, manifest_path, timings: ScanTimings }
IndexingEvent::ScanCompleted    { request_id, operation_id, generation, snapshot_id, roots: ScanRoots, timings: ScanTimings }
IndexingEvent::UpgradeCompleted { ... }   // residual-checker generation (decision 28), added by P1-D-c
```

`ScanTimings` (`catalog_ms`/`parse_ms`/`resolve_ms`/`materialize_ms`/
`write_ms`/`fsync_ms`/`snapshot_ms`/`lexical_ms`, all optional integers, plus
`total_ms`) and `ScanRoots` (`records`/`dependency`/`graph`/`metric`,
`sha256:`-prefixed hex) round-trip through a shared JSON fixture asserted
identical in Rust and TypeScript. A third `ScanScope` variant, `Reconcile`
(added 2026-09-06, Frente E — see "Reconcile: git-aware catch-up" below),
carries no path data at all: it always performs a fresh authoritative walk
before deciding anything, unlike `Changed`, which trusts the caller's own
path list. `Queryable`/`ScanCompleted` gain an optional `reconcile:
ReconcileSummary` field, present only for that scope. **Deviation from the
plan's own protocol sketch**: `workspace_root` was added — neither the plan
nor the task brief named a field for the source checkout the `Walker` must
scan. `request_id` doubles as `operation_id`. The v3 commands (`IndexGeneration`, `AcceptGroup`,
`AnalyzeSemanticGroup`, `InvokeSemantic`, `FinalizeGeneration`,
`SourceIndexCommit`/`Rollback`) are untouched and still serve v3 workspaces;
nothing in this decision removes them (that is the pending P4 deletion —
see "Open items"). One `WorkspaceScan` command can now produce **more than
one** `Queryable` event under the same `request_id` (a mixed-burst request
splits into two internal generations, P3-2 §5), so the TS transport keeps
its side-channel `queryable` handler registered until the terminal event —
a bug where the second `Queryable` was misread as terminal and threw was
found and fixed in `docs/evidence/2026-09-03-v4-p3-5-daemon-latency.md` §4.1.

### Cold pipeline stages

`crates/urdira-indexing-worker/src/v4/{catalog,analyze,typeflow,materialize,deps,publish,scan,residual}.rs`,
`crates/urdira-source-frontier` (catalog), `crates/urdira-jsts-syntax-worker`
(parse/facts, reused not reimplemented), `crates/urdira-jsts-typeflow`,
`crates/urdira-native-core` (kernel canonicalization, reused),
`crates/urdira-structural-store` (segment write, decision 26),
`crates/urdira-tsgo-client` (residual pass, decision 28):

1. **Catalog**: `ignore::WalkBuilder` parallel walk, per-file
   `lstat`→read→sha256, diffed against an in-memory `Frontier` loaded once
   from `artifact_versions`, committed in one SQLite transaction
   (`Catalog::apply`). CAS `put_if_absent` runs off the walker's hot path on
   a dedicated bounded `CasWriteQueue` (10 workers, capacity 8,192 — the
   original 5/512 sizing back-pressured the walker; bare walk 2.68-3.57 s →
   1.99-2.10 s, `docs/evidence/2026-09-02-v4-p2-2b-cold-pipeline.md` §15.2/§16.5).
   Multi-row `INSERT` batching for the catalog was measured neutral
   (`sql_exec` 2.00-2.94 s vs 2.16-2.49 s): the cost is B-tree insertion on
   TEXT primary keys, not statement dispatch (§15.3).
2. **Parse**: `oxc_parser` + `oxc_semantic::SemanticBuilder` per file
   (`SyntaxWorkerState::analyze`, shared with v3).
3. **Facts + semantics**: lane-1 entity/`contains`/`import`/`export`
   `ProposedRecord`s; the E1a-E3 hybrid resolver; and, since P2-2e,
   **typeflow unconditionally** (`v4/typeflow.rs`'s `TypeflowCache`, one
   `DeclSummary` per file, `ProgramIndex` built once cold and maintained
   incrementally since P3-8a). Sites neither lane resolves are recorded in
   the store's `pending.sites` table with a reason code, and any candidate
   target(s) are emitted as `possible` `core:call`/`core:inherits`/
   `core:implements`/`core:references` rows (always carrying a real
   `target_id`) bounded by `MAX_CANDIDATE_TARGETS = 8` — decision 28 owns
   the full contract and its history (the original P2-2i shape, a bare
   `possible` row with no target paired with a `jsts:unresolved_call`
   diagnostic, is superseded).
4. **Materialize**: `ProposedRecord` → `structural_kernel_rows_typed`
   (`urdira-native-core`; the same identity/digest recipe as v3's hybrid
   lane, plus P2-2k/P2-2l kernel work — §"Measured cold performance") →
   `RecordRow`/`DependencyRow`. Dictionary ordinals (kinds, universal
   kinds, relation kinds, names, artifacts, subjects, plus facet names and
   subject text since P2-2e) are collected in one rayon fold/reduce pass,
   sorted and interned once, then rows are built in parallel straight into
   16 nibble partitions (`materialize_cold_partitioned`, P2-2j). The
   cold-producer **classification repair** (P1-D-h) runs here: a
   `core:call`/`inherits`/`implements` row whose identity claims `confirmed`
   but whose target subject cannot be interned (a class/interface member —
   the cold entity producer only materializes module-level declarations) is
   downgraded to the canonical `possible` row (parallel read-only plan,
   sequential apply, then rebucket); 31,917 rows on n8n, 0.13-0.16 s
   (`docs/evidence/2026-09-05-v4-final-measurements.md` §2).
5. **Write**: `SegmentWriter::write_base_partitioned` (decision 26).
6. **Merkle**: `records`/`dependency` trees inside `urdira-structural-store`;
   `graph` and `metric` (always the canonical empty set) computed and
   persisted by `publish.rs` (decision 27).
7. **Snapshot**: one SQLite transaction (`registry_snapshots`, `snapshots`,
   `workspace_current_state`, `merkle_roots`, a placeholder
   `candidate_state` row required by a foreign key `generation_manifests`
   still carries, `generation_manifests`).
8. **Events**: `Queryable` then `ScanCompleted`. `write_base` still performs
   page-cache write, fsync pass, and manifest publish synchronously, so the
   two events fire back to back at cold (final §4.1: `queryable_at` 27.3-30.0 s,
   `completed_at` 29.6-32.3 s — the gap is the snapshot transaction and
   event delivery, not a live mid-write callback).
9. **Residual checker (optional, background)**: `scan::run_with_residual`
   calls `residual::schedule` after a successful `ScanCompleted` when
   `URDIRA_V4_RESIDUAL` is set; the pass publishes a `semantic_upgrade`
   generation and an `UpgradeCompleted` event (decision 28).

**New v4-only ground with no v3 recipe to mirror** (each documented at its
own definition): the facets bitmask's bit order (13 bits, `FACET_ORDER`,
concatenating the JS/TS registry's `entityFacets`/`relationFacets`); the
dictionary schemes; `dicts.artifacts` using one ordinal per owner; the
relation-subject key (the resolved entity's raw `record_id` bytes);
`dependency_id = sha256("urdira:v4-dependency-id:v4\0" || owner_path || dep_path || role)`
(P3-2 §3.3 — the two earlier recipes hashed workspace/generation-salted
artifact ids and could never match a from-scratch oracle, see "Central
correctness finding"); `chained_record_id = sha256("urdira:v4-record-chain:v1\0" || record_digest || predecessor_record_id)`;
`capability_state_digest`/`source_observation_watermarks` placeholders; and
`span_start_line`/`span_end_line` always `0`.

### Measured cold performance (n8n corpus, 14,082 JS/TS owners)

Record count changed twice during the campaign — 1,521,196 (through
P2-2h) → 1,553,019 (typeflow, P2-2e) → **2,831,264** (possible rows +
diagnostics, P2-2i) — so rounds are only comparable within a record-count
era. All figures are `ScanCompleted`/`total_ms` medians unless noted; every
listed round reproduced byte-identical `records`/`dependency`/`graph`/`metric`
roots across its own runs (decision 27 keeps the root history).

| Round (evidence) | records | what it fixed | cold total |
|---|---:|---|---:|
| v3 baseline (plan §0) | — | — | ~560 s |
| First v4 build (P2-2b §6) | 1,521,196 | reused v3 facts/kernel logic directly | 411-522 s |
| P2-2c (§11) | 1,521,196 | no per-blob fsync; parallel facts (50 s→8-11 s); O(1) subject interning; FxHashMap dictionaries | 40.0 s |
| P2-2f (§13) | 1,521,196 | bytes-native structural kernel | 35.2-37.4 s |
| P2-2g (§14) | 1,521,196 | in-process `facts_for_paths` (8-11 s→0.4-0.5 s); borrowed kernel input | 18.3-19.9 s |
| P2-2h round 5 (§15) | 1,521,196 | CAS off the critical path (walk 3.24→2.85-2.96 s); digest-keyed identity map; parallel subject resolution; `project_files` borrow (−57-70 ms per incremental call); SQL batching neutral | 22.1 / 24.8 s (min/median; §15.0 re-baselined before its own changes — the rise vs §14 is not explained in the evidence) |
| P2-2e + P2-2i (contract changes) | 1,553,019 → 2,831,264 | typeflow unconditional (+31,823 records, ~1.77 s); possible rows + `jsts:unresolved_call` (+1,276,972 records, +82%; +1.7-2.4 s materialize, +1.1-1.8 s write, §16.3) | — |
| P2-2j round 6 (§16) | 2,831,264 | partitioned parallel materialize + `write_base_partitioned` (materialize median 15,235→9,012 ms, write 5,230→4,075 ms); CAS queue resizing; single dictionary-collection pass | 27.9 / 31.6 / 32.2 s |
| P2-2k (§17) | 2,831,264 | kernel hot path: direct BTreeMap iteration, fused span parse, scratch buffers, LUT hex — pass 1 9.70→5.03 s (34.3→17.8 µs/record) | 28.0-28.9 s |
| P2-2l (§18) | 2,831,264 | `rayon::join` bisection + LPT owner order; typed `facets_list` (skips a provably-no-op JSON round trip); fused digest/body traversal; parallel `build_full` (1.31→0.27-0.37 s); write path profiled (decision 26) | 29.0 / 30.5 / 34.0 s |
| **P1-D-h final (final §4.1, production path `scripts/v4-scan.mjs`)** | **2,831,264** | cold-producer classification repair (0.13-0.16 s) | **27.27 / 27.70 / 29.42 s** (`total_ms`); `queryable_at` 27.3-30.0 s; `completed_at` 29.6 / 29.9 / 32.3 s |
| **F.3 re-measurement (`docs/evidence/2026-09-07-v4-f3-cold-incremental-floors-parity-threshold.md` §1, HEAD `d71669a`)** | 2,197,882 (NODIAG-set count changed with intervening entity/dependency work; not a regression — see §2's population floors) | catalog dropped 5.3 s → 2.9 s median from intervening pending-importer/type-alias work; no other stage regressed | **22,380-23,856 ms** (`total_ms`, median 23,369 ms); wall 23.90-25.85 s (median 25.22 s); RSS max 5.10-6.54 GiB (median 6.11 GiB) — the current authoritative n8n cold figure, superseding the P1-D-h final row above |

Final phase breakdown (final §4.1, min/median): catalog 5.04/5.27 s, parse
1.54/1.67 s, resolve 2.68/3.01 s, materialize 8.45/9.80 s, write
5.83/6.56 s, fsync 0.17/0.18 s, snapshot 4 ms. Max RSS 6.56 / 6.86 / 8.16 GB.
**Superseded by F.3** (same evidence, §1.2-1.3): catalog 2.89-2.99 s, parse
1.74-1.80 s, resolve 2.57-3.09 s, materialize 5.15-6.04 s, write
5.70-6.29 s, fsync 0.16-0.22 s — `total_ms` median 23,369 ms, RSS median
6.11 GiB (5.10-6.54 GiB across 3 runs).

**Cold gate table (plan targets vs the current F.3 figures):**

| gate | target | measured | met? |
|---|---:|---:|---|
| catalog | ≤ 1.5 s | 2.89-2.99 s | **no** |
| materialize | ≤ 4 s | 5.15-6.04 s | **no** |
| `Queryable` / `ScanCompleted` (`total_ms` as a proxy — F.3 measured `total_ms`, not the daemon-observed event pair) | ≤ 8 s / ≤ 12 s | 22.4-23.9 s | **no** (~1.9-3x) |
| RSS | ≤ 3 GiB | 5.10-6.54 GiB (median 6.11 GiB) | **no** (~1.7-2.2x) |
| determinism / thread-count independence | identical roots | identical across 3 runs (and dozens per round in §16-§18) | **met** |

None of the gates newly passes at the F.3 figures — the ~4-6 s improvement
since the P1-D-h final measurement (catalog work, mostly) narrows the
`Queryable`/`ScanCompleted` gap from 3.4-3.7x/2.5-2.7x to roughly 1.9-3x
and 3 GiB RSS makes VS Code diagnostic (2.0-2.3x n8n at the F.3 corpus size)
essentially the same 6-14 GiB range on the larger corpus that continued
tracking through the 2026-09-07 VS Code campaign (decision 26's "Current
state"). It does not change the pass/fail verdict.

The remaining cold cost is priced in the kernel rounds: pass 1 kernel
canonicalization (5.7-6.5 s, floor bounded by rayon tail on the single
largest owner, `max_task_ms` 280-527 ms vs mean 2.5-3.8 ms, §18.1, and by
`sha256::compress256` ~4% of samples, §17.5), the write path (~9 s, §18.4 —
a memory-bandwidth contention finding, decision 26), and record volume
(possible rows + diagnostics are 45% of all records; without them
materialize 6.8 s and write 2.9 s, §16.3 — an owner decision, see "Open
items"). RSS is an architectural tension between sorted-key dictionaries
(need the full owner set before any ordinal) and streaming (§16.4), made
worse by the typed `facets_list` memory-for-CPU trade (§18.6).

### Daemon wiring

v4 is the default for a newly added workspace (`isV4Enabled()` is
`URDIRA_V4 !== "0"`, P4-b-2); an existing workspace's database already
exists by the time this runs and is never migrated. Readiness for a v4
workspace is derived from an in-memory `v4ReadinessState` map;
`structural_ready` now flips at the live `Queryable` event (the
`onQueryable` transport hook was previously never passed a callback, so
readiness only updated at `ScanCompleted`; a second redundant gate on
`workspace.status !== "indexing"` was removed — P3-5 §2.3; readiness update
overhead 5-7 ms after the fix). The aggregation window for v4 workspaces
defaults to 100 ms / 500 ms (was 200 / 1,000; P3-5 §2.1). A
`ScanScope::Changed{paths:[]}` request is rejected by both worker and
daemon. Startup recovery (`recoverMigrations`/`recoverWorkspaceGcEpochs`)
routes on the index-contract byte and records outdated workspaces instead
of crashing the whole daemon (P4-b-prep §1); an outdated database is moved
aside to `*.v3.stale-<timestamp>/` and re-bootstrapped (P4-a §2). Status
surfaces (P4-d): `core:index_status` carries `storage_format`,
`structural{queryable_generation,durable_generation,queryable}`,
`lexical{completed_generation,current}`, `semantic{...,current}` (always
`false` for v4 — semantic maintenance is not wired), `last_scan{kind,
changed_paths,timings,timeline}`, `search_text_ready`, `search_semantic_ready`;
`core:status` exposes `daemon_epoch_ms_offset`; MCP/CLI/web render the lanes.

### Incremental path (`ScanScope::Changed`) as built

- **State model** (P3-1): one long-lived `WorkspaceState` per workspace —
  cached `Frontier`, cached `StoreReader` (`reopen_if_changed`), the same
  long-lived `SyntaxWorkerState` v3 keeps, under a `"v4:{workspace_id}"`
  project key; `generation` read from `workspace_current_state`. `SourceCache`
  (P3-2 §1) makes the `files`/`config_assets` rebuild O(delta); `write_delta_with_reader`
  (P3-2 §2) reuses the process's reader instead of reopening per call.
- **Per-owner diff** (`diff.rs`, decision 11's chaining recipe): `unchanged`,
  `replacement` (chained id), `owner migration`/`reopen` via `by_identity_last`,
  `first occurrence`; every unmatched previous row closes. The `graph` set
  is maintained by `diff.rs`'s own bucket callbacks. Dependencies diff at
  **owner granularity** (an affected owner's whole dependency set closes and
  reopens; 2,657 deps churn on an 841-owner hub edit, P3-3 §1.5) — a
  documented scope narrowing that does not affect root equality.
- **Digest-churn fix** (P3-3 §1): `old_owner_ordinal` only knew the
  request's literal `changed_paths`, so every transitively-affected but
  unchanged importer diffed against an empty `prev` and re-opened all its
  rows (~107,000 opens/closes on a hub edit). Fixed by falling back to the
  post-apply frontier; hub-edit `write_ms` 6,228-6,630 → 396 ms.
- **Closure narrowing by exported surface** (P3-3 §2): each edited path's
  exported surface is computed before/after; if the pre-edit surface is a
  subset of the post-edit surface (pure additions), the affected set narrows
  to the literal edited paths, otherwise the full reverse-import closure is
  kept. Accepted residual: an importer with an already-unresolved import that
  a new export now satisfies stays unresolved one generation longer.
- **`CandidateIndex`** (P3-6 §2): per-project reverse index `candidate path →
  importers whose specifier could resolve to it` (every extension/`index`
  variant of every relative/package/tsconfig strategy — deliberately an
  over-approximation), maintained incrementally, so create/delete/rename
  re-resolve only `importers_of(added ∪ removed)` instead of sweeping the
  corpus (CREATE 986→463 ms, RENAME 904→515 ms, DELETE 848→726 ms).
- **`ImportReverseIndex`** (P3-6 §3): a second incrementally-maintained
  index keyed by resolved `target_path`, replacing the O(corpus) rebuild of
  the reverse import map that `reverse_affected_closure` did on every call
  (`parse_ms` 177-183 → 148-191 ms; the ≤ 80 ms target is not met).
- **Delta container** (P3-6 §1): a delta generation is one `delta-<g>.seg`
  file with one fsync instead of up to 18 files each `F_FULLFSYNC`ed
  (decision 26; `container_fsync` flat at 6-9 ms).
- **Mixed bursts** (P3-2 §5): a `Changed` batch mixing an edit with an
  unrelated create/delete splits into two internal generations inside one
  command, each on the cheap path (previously a full reparse).
- **Incremental `ProgramIndex`** (P3-8a §2): `replace_file`/`add_file`/
  `remove_file` reflow only the edited file's transitive-importer component;
  `TypeflowCache` keeps a persistent index plus a dirty set. Typeflow cost
  per steady edit went from 0.165-0.35 s (a full rebuild) to under 0.5 ms
  for every mutation kind including the 841-owner hub edit; proven against
  a from-scratch index over 400 random edits × 6 seeds. Accepted gap: a
  `create` that satisfies a previously-broken import is not rediscovered by
  `add_file` alone.
- **Rename**: arrives as one `Changed` request with a `Deleted` and a
  `Created` entry (or as two generations in either order); all three
  orderings match a from-scratch scan at fixture scale (P3-8a §1).
- **Harness**: `scripts/v4-mutation-harness.mjs` (P3-4) drives edit/create/
  delete/rename/hub-edit against a real daemon, records a six-milestone
  `V4ScanTimeline` (`fs_event_at`, `aggregated_at`, `request_sent_at`,
  `queryable_at`, `completed_at`, `readiness_updated_at`; P3-5 §1), and runs
  a root-equality oracle. Two harness bugs were found: it timestamped the
  mutation before its own ~2-3.5 s corpus rescan, mis-attributing that time
  to the watcher (P3-7 §1), and after P3-6 it read delta rows from a
  directory path inside what is now a single `.seg` file, silently seeing
  only the base generation — the only cause of the "rename 50 vs 4 records"
  failure (P3-8a §1).

### Reconcile: git-aware catch-up (`ScanScope::Reconcile`)

A third `ScanScope`, alongside `Full` and `Changed` (added 2026-09-06,
Frente E; full mechanism and bug history in "Historial de cambios" below).
Where `Changed` trusts the caller's own path list, `Reconcile` carries no
data at all: `scan.rs::run_reconcile` always performs a fresh authoritative
walk (the same `catalog::enumerate`/`catalog::diff` primitives `Full`
itself composes from) before deciding anything. This is the event-driven
counterpart to a `git pull`/branch switch, a lost or coalesced watcher
batch, or a periodic reconciliation sweep — every signal the daemon cannot
attribute to a specific set of changed paths now triggers `Reconcile`
instead of an unconditional `Full`.

- The authoritative delta's measured size (`added + changed + deleted`
  against the frontier's total present count) decides only which pipeline
  republishes it: the cheaper `Changed`-shaped path (`delta::run`) below
  threshold `T` (`RECONCILE_DELTA_THRESHOLD = 0.01`, override
  `URDIRA_V4_RECONCILE_THRESHOLD`), the `Full`-shaped path (`run_full_from`,
  reusing the same walk, no second one) at or above it. `T = 0.01` was
  measured, not assumed: a fraction-sweep on n8n found the `Delta`/`Cold`
  crossover at p≈0.0164 of the frontier, and `T` is set to 80% of that
  crossover for a conservative margin (`docs/evidence/2026-09-06-v4-reconcile-threshold.md`
  §5) — n8n's own git history routinely touches more than 1.6% of the
  repository in one pull, so `T = 0.01` means most real `git pull`/branch
  switches route through the `Full`-shaped path, not the `Changed`-shaped
  one; both branches produce Merkle roots byte-identical to a from-scratch
  cold scan of the same mutated tree for create/delete/rename, at every
  measured fraction.
- An empty delta is a no-op: no new generation; `reconcile.mode == "noop"`.
- A failed `Delta` attempt falls back to `Cold` in-line (never a partial
  generation), re-walking rather than reusing a possibly-stale enumeration;
  `reconcile.fell_back_to_cold` distinguishes this from a size-driven `Cold`
  decision.
- **Content-hash equivalence** (2026-09-06 fix, in "Historial de cambios"):
  a uri is `equivalent` (never `changed`) based on `content_hash` alone,
  not also a metadata digest (mtime/ctime/inode/...) — a `touch`, a `git
  stash` round trip, or an index-pack import that copies an already-indexed
  tree onto a fresh filesystem all leave content-identical files with
  different metadata, and previously forced reconcile to treat the whole
  corpus as changed. `ReconcileSummary` reports `metadata_refreshed` for
  this case, which never counts toward the `Delta`-vs-`Cold` threshold.

### Central correctness finding: CREATE/DELETE/RENAME match a from-scratch oracle exactly; EDIT cannot, by design

Verified at fixture scale and at full n8n scale (20,148 files, 14,082
owners): a create, delete, or rename mutation's incrementally-updated
`records`, `dependency`, **and** `graph` roots are byte-identical to an
independent from-scratch cold scan of the mutated tree
(`n8n_incremental_create_delete_roots_match_oracle`, P3-2 §3.4, re-confirmed
after every later round: P3-3 §6, P3-6 §4.3, P3-8a §2.4). The `dependency`
mismatch decision 29 previously listed as open was **not** the owner-
granularity hypothesis: the oracle showed 35,527 live edges on each side
with zero overlap, and the cause was `dependency_id` hashing scan-specific
artifact ids (workspace- and generation-salted) — fixed by the raw-path
recipe above (P3-2 §3). An edit cannot match a fresh index of the mutated
source, because `jsts:entity_container`'s span includes the file's byte
length while its `identity_key` never changes, forcing a real replacement
chain (decision 11); what edit guarantees, and what is verified, is that
the incremental roots equal a from-scratch rebuild of the tree over the
store's own current visible key set (P3-1 §5).

### Measured incremental performance

**Worker-only** (`scan::run` in-process, n8n, `total_ms`, steady state; one
representative run per round — P3-2 §8.1, P3-3 §5, P3-6 §4.2, P2-2b §16.8/§18.7,
P3-8a §2.4, final §4.3):

| Kind | P3-1 | P3-2 | P3-3 | P3-6 | P2-2j | P2-2l | P3-8a | **final** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| edit (steady) | 1,060-1,144 | 703-918 | 614-686 | 502-519 | 463-691 | 446-621 | 515-595 | **447-584** |
| create | 1,153-1,264 | 976 | 986 | 463 | 499 | 464 | 503 | **496** |
| delete | 1,178-1,286 | 989 | 848 | 726 | 470 | 432 | 483 | **449** |
| rename | — | 1,117-1,345 | 904 | 515 | 531 | 482 | 632 | **513** |
| hub edit, surface unchanged | — | 6,901-7,564 | 571 | 495 | 471 | 457 | 545 | **473** |
| hub edit, surface changed (841 owners) | — | 8,068 | 1,236 | 1,078 | 1,500 | 1,316 | 1,155 | **1,425** |
| edit #1 after cold (cold cache) | 3,168-3,462 | 3,457 | 3,135 | 1,704 | — | 1,649 | 1,386 | **3,026** |

Against the plan's worker-only gate (edit p50 ≤ 500 ms / p95 ≤ 900 ms;
create/delete/rename ≤ 1 s; hub edit proportional to true dependents):
**met** for edit (0.45-0.6 s), create, delete, rename, and hub-surface-
unchanged; hub-surface-changed is 1.4 s for 841 genuinely re-diffed owners
(met on the proportional framing, over 1 s in absolute terms). The
cold-cache first edit pays a one-time catalog/parse cost (3.0 s in the
final run, 1.4-1.7 s in P3-6/P3-8a — run-to-run noise, not explained).
Sub-gates not met: `parse_ms` ≤ 80 ms (148-191 ms, P3-6 §3.2); steady-edit
`write_ms` ≤ 60 ms on the larger 341-record edit (71 ms) and on the hub
edit (126 ms, P3-6 §1.2). A DELETE `resolve_ms` regression P3-6 reported
(71 → 331 ms) could not be reproduced in three clean runs (64-66 ms, §15.7)
and is treated as noise.

**Daemon-observed** (real watcher + daemon + worker, `scripts/v4-mutation-harness.mjs`,
n8n, 22 non-cold cycles, final §4.4):

| | p50 | p95 | min | max |
|---|---:|---:|---:|---:|
| fs-write → `Queryable` | 1,326 ms | 3,745 ms | 585 ms | 5,789 ms |
| fs-write → `ScanCompleted` (durable) | 1,400 ms | 22,812 ms | 757 ms | 29,010 ms |

Against the plan's "durable < 1 s" (edit durable p50 ≤ 700 ms / p95 ≤ 1 s;
overhead outside the worker ≤ 250 ms p50): **not met**. Attribution, from
the P3-5/P3-7 timeline work: watcher detection is 7.7 ms p50 / 45.3 ms p95
on kqueue at 20,280 files (P3-7 §4 — the 2-3 s previously attributed to
the watcher in P3-5 §2.5 was the harness's own pre-write corpus rescan;
FSEvents was measured live at p50 12.0 s / p95 15.0 s with outright misses
and is kept off, reinforcing decision 04); aggregation debounce ~101-162 ms;
admission + IPC 26-92 ms; readiness update 5-7 ms (P3-7 §4). The remaining
gap is `worker_to_queryable` as observed through the daemon (1.4-1.7 s
medians in P3-5 §5.2, 0.8-3.7 s in P3-7 §4) versus 0.45-0.6 s in-process —
two candidate causes, neither isolated: genuine IPC/process-boundary cost,
and the harness hashing the whole corpus after every mutation, bleeding CPU
into the next cycle (P3-5 §5.3). The durable p95 is dominated by 2 of 22
cycles with an anomalous 23.7 s and 29.0 s gap between `queryable_at` and
`completed_at` (every other cycle lands within ~1.5 s); not investigated
(final §4.4). Earlier daemon-driven medians for comparison: edit 5.6 s (P3-1),
4.5 s (P3-2), 3.8 s (P3-5).

### Bugs found and fixed during the campaign (beyond P3-1's five)

`dependency_id` hashing scan-specific ids and a second stale copy of the
logical formula in `merkle.rs` caught by the compaction test (P3-2 §3);
a buffered rename batch's created path vanishing in `flushScanAggregation`
(P3-2 §4); `old_owner_ordinal` digest churn (P3-3 §1); a double full-corpus
clone of `ProjectState` per `analyze()` (P3-3 §3); up to 18 fsyncs per delta
(P3-6 §1); O(corpus) `reresolve_file` sweep and reverse-map rebuild (P3-6
§2-3); readiness never updated at live `Queryable` (P3-5 §2.3); one
`queryable` handler per `request_id` (P3-5 §4.1); harness pre-write
timestamp (P3-7 §1); unguarded `normalizedUri` losing FSEvents events under
a symlinked root (P3-7 §3.4); harness reading delta rows from a directory
path after the container change (P3-8a §1); `link_importer` dropping importer
edges and `remove_file` leaving dangling entity ids in the incremental
`ProgramIndex` (P3-8a §2.1); `category_byte` storing diagnostics as entities
(P2-2i); dictionary collection scanning 2.83M records four times (§16.6);
the classification-mismatch producer (final §2); and, in the first version
of that fix, a non-deterministic corruption under parallel mutation that
led to the two-phase plan/apply split (final §2.4) — which turned out not to
be the corruption's cause (see "Open items").

### Consequences

- Every one of the 18 public query operations that touches structural data
  is served from the native store for a v4 workspace once `structural_ready`;
  no v3 candidate-publication SQL path exists for v4 at all.
- Cold indexing at n8n scale is ~20x faster than the v3 baseline (560 s →
  27.7 s median) but 2.5-3.7x over the plan's own cold gates; this decision
  claims the trajectory, not the gate.
- Incremental compute is sub-second in the worker for every mutation kind;
  what a user observes through the daemon is 1.3 s p50 to queryable, with a
  long durable tail that is not yet explained.
- Create/delete/rename are provably equivalent to a from-scratch scan;
  edit is equivalent to a from-scratch rebuild over the store's visible
  keys, by design.
- v4 is the default for new workspaces; the v3 pipeline is still compiled,
  shipped, and serving existing v3 workspaces.

## Open items (reported, not resolved)

1. ~~**CRITICAL — `identity_key` zeroing corruption (P2-2m).**~~ **FIXED**
   2026-09-05 — see decision 26's changelog for the two root causes (a
   short `write_at` and a concurrent sparse-file allocation race) and the
   fix (`write_all_at` + up-front `materialize_real` allocation). Neither
   the classification invariant nor Merkle verification are needed to
   detect it any more, but neither would catch a future writer-level
   corruption of the same shape (decision 27's own limitation is
   unchanged).
2. **Harness `spawn EBADF`.** `scripts/v4-mutation-harness.mjs`'s
   `oracleVerify` crashed 2/2 at the final from-scratch oracle spawn, so
   `roots_equal` was not verified through that harness in the final run
   (root equality is covered by the pure-Rust n8n tests instead; final §4.4).
3. **`pending.sites`/`entities.index` segment export not built** — superseded:
   possible rows plus `jsts:unresolved_call` diagnostics deliver the same
   visibility, and the residual pass derives its pending sites from the
   possible rows themselves (P2-2i §10 records the remaining scope if the
   literal export is still wanted).
4. **Record volume — owner decision.** 637,530 possible `core:call` rows +
   637,531 `jsts:unresolved_call` diagnostics are +1,276,972 records (+82%
   over the 1,554,292 without them, 45% of the total). Removing them saves
   +1.7-2.4 s materialize, +1.1-1.8 s write, and 0.2-1.7 GB RSS (§16.3), at
   the cost of the query-visible "possible" relations and reason codes the
   uncertainty contract (decision 28) now relies on. Not decided here.
5. **`rpc_error` 13,737 parity-scoped (105,635 raw)** — decision 28.
6. **Daemon durable tail**: the two 23-29 s `queryable_at`→`completed_at`
   anomalies (final §4.4); and the 1.4-1.7 s daemon-observed vs 0.45-0.6 s
   in-process worker gap (P3-5 §5.3).
7. **Cold gates** (catalog, materialize, Queryable, ScanCompleted, RSS) — see
   the gate table; remaining levers priced in §16.3/§17.5/§18.4/§18.6.
8. **Existing-workspace migration** is unaddressed; **v3 deletion** (the v3
   commands, candidate-publication SQL path, `MerkleRadixSet` writers,
   `NativeStoreBuilder`, the Node semantic worker's checker lane) has not
   happened — decision 22's cutover pattern.
9. **Semantic maintenance is not wired for v4** (`semantic.current` is
   always `false`; decision 26).
10. Smaller: `parse_ms` ≤ 80 ms not met; `write_ms` > 60 ms on larger edits;
    a `create` satisfying a broken import not rediscovered by the incremental
    `ProgramIndex`; the first edit after cold pays 1.4-3.0 s; tsgo child RSS
    during a residual pass never collected; `tests/v4-daemon-e2e.test.ts`
    still uses `delete process.env.URDIRA_V4` to mean v3 (P4-b-2 §3);
    `cargo fmt`/`clippy -D warnings` findings in `semantic_sites.rs`
    (`PendingCallSite`/`PendingHeritageSite` unused fields, P4-b-2 §4) —
    the final session's own workspace `clippy` run is reported clean (final
    §5), so this may already be resolved.

## Historial de cambios

- **2026-09-05** (`docs/evidence/2026-09-04-v4-pending-sites-fold-and-member-entities.md`): the cold pipeline began materializing members, referenced parameters, catch/rest bindings, ambient-namespace and external entities directly, and unresolved call/heritage sites moved from a bare relation-plus-diagnostic pair into the `pending.sites` side table (decision 28 owns the semantics).
- **2026-09-06** (Frente E, plan `generic-waddling-hartmanis.md` §2, `docs/evidence/2026-09-06-v4-reconcile-threshold.md`): added the third `ScanScope::Reconcile` mode — an always-authoritative walk that routes to the cheaper `Changed`-shaped path below a measured delta threshold (shipped at `RECONCILE_DELTA_THRESHOLD = 0.25`) or to `Full` at or above it, with an in-line `Cold` fallback on a failed `Delta` attempt; verified byte-identical roots to a from-scratch scan at every measured fraction. The threshold was re-measured and lowered to the current `0.01` the same week (§5 of the same evidence) — see "Reconcile" above for the current mechanism and value.
- **2026-09-06** (same evidence, content-hash equivalence): fixed a reconcile false-positive where a `touch`, a `git stash` round trip, or an index-pack import onto a fresh filesystem — content-identical files with different metadata — forced a whole-corpus "changed" verdict; equivalence is now decided by `content_hash` alone, with a new `Catalog::refresh_metadata` path that persists the metadata refresh even on a `Noop` reconcile (no rows added/changed/deleted) so a second reconcile of the same tree reports zero refreshes.
- **2026-09-07** (Frente E-P0f, `docs/evidence/2026-09-06-v4-reconcile-threshold.md` §14.3): fixed a real dependency gap — a TypeScript script's top-level declarations are ambient globals with no `import`/`export` edge to derive a dependency from, so deleting/editing the declaring file left consumers' stale `core:references` rows undetected. `resolve_ambient_global` now records the proven cross-file dependency onto a new `jsts:ambient_global_input` role on the same `DependencyRow` channel ordinary imports use, so `deps_reverse`/the residual pass's dependency closure see it for free. Verified at n8n scale: `extra_untouched` phantom-row count 0 (was non-zero).
- **2026-09-07** (Frente E-P0g, same evidence §15.4/§16): closed three further stale-row root causes found at n8n scale (N=2015, N=5037) — a re-exporting barrel was never watched as a structural dependency (`link_importer` only registered the FINAL declaring file); `apply_import_target_updates` could not detect an owning path whose entire import set stopped resolving; and the reverse-import graph ignored re-export/barrel edges entirely. Also widened the owner-surface reflow criterion (`analyze.rs::exported_surface`) to a class/interface's own member and parameter names (position-independent, so a body-only edit that shifts a later sibling's byte offset never falsely trips it), and extended barrel-watching to multi-hop re-export chains. Verified: `extra_untouched=0`/`missing_untouched=0` at both N=2015 and N=5037 (25% of the frontier), full delta-path parity against an independent oracle.
- **2026-09-07** (Frente E-P0h, same evidence §16.5): widened the owner-surface criterion again to a declaration's own WRITTEN type — a normalized, position-independent `type_surface_digest` fingerprint (comments/whitespace stripped, sliced from the file's own source text with no semantic resolution) folded into `exported_surface` for a function/variable/type-alias's own type and each typed class/interface member, so a return-type or parameter-type edit with the declaration's name/parameter-names/member-list unchanged now correctly widens the reflow set for a typeflow-mediated caller. Verified at N=1008 and N=2015: `extra_untouched=0`/`missing_untouched=0`, roots match both the delta and cold oracles.
