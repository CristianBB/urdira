# P2-5: native query port + v3→store converter (2026-09-02)

Implements plan §7 (method → store mapping) and the P2-5 task brief: a
second, independent implementation of `CanonicalQuerySnapshotPort` served
from `crates/urdira-structural-store` via napi, plus a v3→native-store
converter so the port can be exercised against real indexed fixtures today,
before the v4 Rust cold pipeline (P2-2/P2-3 production wiring) exists. Not
committed, per task instructions. Concurrent work in
`crates/urdira-indexing-worker` (v4 pipeline) and `crates/urdira-structural-store/src/writer.rs`
(perf) was left untouched — `writer.rs` was not modified at all, and every
new capability needed on the Rust side lives in a new module,
`crates/urdira-native-node/src/structural_store_napi.rs`.

## 1. napi surface (`crates/urdira-native-node/src/structural_store_napi.rs`)

New module, one `mod structural_store_napi;` line added to
`crates/urdira-native-node/src/lib.rs`. `Cargo.toml` gained
`urdira-structural-store` and `sha2` (workspace-pinned) as dependencies —
the only two files in `urdira-native-node` touched outside the new module.
`urdira-structural-store` itself was **not modified** (no `row.rs`/`dict.rs`
changes) — see §2 for why and how the gaps that would have needed such
changes were worked around instead.

### 1.1 `NativeStoreBuilder` (write side, cold-only)

`create(dir, generation)` → `addRecords(rows[])` / `addDependencies(rows[])`
(both batched) → `finish()`. Internally interns plain-text v3-shaped input
rows into the store's ordinal `Dictionaries` (kinds, universal_kinds,
relation_kinds, names, artifacts-as-`(artifact_id, artifact_version_id)`
pairs, subjects-as-sha256-digests) as they arrive, builds `RecordRow`/
`DependencyRow` vectors, and calls `SegmentWriter::new().write_base(...)`
once at `finish()`. No delta path — the converter (§3) only ever produces
one cold `base-<g>`.

### 1.2 `NativeStructuralStoreHandle` (read side)

`open(dir)` (factory), `reopenIfChanged()`, `currentGeneration()`,
`dictionaries()`, `recordsByIds(keysHex, g)`, `recordsByName(name, g)`,
`recordsByKindExact(universalKind, category, kind, g, limit, afterKeyHex?)`,
`recordsByOwnerOrdinal(ordinal, g)`, `adjacency(subjectIds, direction, g)`,
`changedBetween(g1, g2)`, `visibleCount(g)`,
`iterVisibleBatch(g, batchSize, afterKeyHex?)`, `depsByOwner(ordinal, g)`,
`depsReverse(ordinal, g)`. Every row-shaped return value is built directly
as a plain object in Rust (no JSON round trip) — `NativeOutputRecordRow`
fields map 1:1 onto the local `RecordRow` shape
`packages/engine/src/query-record-decode.ts`'s `decodeRow` expects, minus
`workspace_id` (filled in by the TS port from `scope`, since the store
itself has no notion of a workspace).

### 1.3 The text sidecar — the one real gap in the store's on-disk shape

Three pieces of text the query port needs have **no textual representation
on disk** in `urdira-structural-store` as built by P2-3:

- **`facets`** is a bare `u64` bitmask (`row.rs`/`layout.rs`) — there is no
  `Dictionaries.facets: Vec<String>` field at all, so a bit position cannot
  be mapped back to a facet name from the store alone.
- **Relation-record subject ids**: `Dictionaries.subjects: Vec<[u8; 32]>`
  only ever stores `sha256(subject_id_text)` (plan §2.2 "ordinales u32 en
  vez de ids textuales") — the original text is not kept anywhere.
- **`identity_id`**: `records.digests` stores a 32-byte digest of it, not
  the v3 `"identity:<hex>"`-shaped text `decodeRow` needs verbatim.

Rather than adding these fields to `urdira-structural-store` itself (which
would touch `row.rs`/`dict.rs`/`writer.rs`/`reader.rs` — files another
agent may be editing, and a real "store API addition" the task brief
scoped to new files only), `NativeStoreBuilder.finish()` writes a small
companion JSON file, `text_sidecar.json`, at the store root (sibling of
`MANIFEST`, entirely outside the store's own manifest/segment/generation
machinery): `{ facets: string[], subjects: string[], identity_ids: { <record_id_hex>: <text> }, dep_roles: string[], dep_record_ids: { <dependency_id_hex>: <record_id_hex> } }`.
`facets`/`subjects` are ordinal-indexed (built by the SAME interner calls,
in the same order, as the store's own bitmask/digest arrays, so a bit
index or subject ordinal indexes both arrays consistently); `identity_ids`/
`dep_record_ids` are small maps keyed by hex id, since those spaces are not
small dictionaries. `NativeStructuralStoreHandle.open`/`reopenIfChanged`
load/reload it alongside the manifest.

**Scale caveat, documented not hidden**: `identity_ids`/`dep_record_ids`
are per-record JSON maps, not compact binary dictionaries — fine at
fixture/gold-manifest scale (this task's target), but a real production
producer (a future P2-2/P2-3 successor) should replace this with a binary,
ordinal-indexed sidecar (or fold facets/subjects text into the store's own
format) before it is used at n8n scale.

### 1.4 `role`/`evidence_class`/`relation_kind` synthesis for `IndexedGraphEdge`

`RecordRow` (the store's on-disk relation-row shape) has `source_subject`/
`target_subject`/`relation_kind_id` but **no `role` or `evidence_class`
fields** — plan §2.2 never specified them, because on this route "there is
no separate edge table … adjacency is an index over relation records" (per
the task brief for `urdira-structural-store`, `row.rs`'s own doc comment).
Investigated where v3's `graph_edges.role`/`.evidence_class` actually come
from: **grepped the whole repository for an `INSERT INTO graph_edges`
producer and found none outside test fixtures** (`tests/phase-canonical-query-data-port.test.ts`,
`tests/phase5-review-fixes.test.ts`) — `packages/storage/src/projections.ts`'s
`putGraphEdge` exists but its only caller is `lifecycle.ts`'s restore path,
which re-writes an already-existing row, not a fresh producer. `graph_edges`
is therefore a **dead/legacy table in this repo's current production v3
pipeline**; `SqliteCanonicalQuerySnapshotPort.graph_edges_by_subject_ids`
normally returns `undefined` (no rows) in real usage, and
`relation_pairs_by_subject_ids` likewise. The real, live signal for a
relation's confidence is `record.body.classification` (`"confirmed"` /
`"possible"`, read directly off the decoded body — see
`canonical-query-data-port.ts`'s `relationClassification`), which the
in-memory fallback path already uses.

Given that, this converter's synthesis convention (used by both
`native-store-convert.ts` when building relation rows and the napi
`adjacency()` accessor when reading them back) is:

- `relation_kind` = the relation record's **`universal_kind`** (not the
  language-specific `kind`) — because the one place in the engine that
  filters an edge by "kind" (`relation_pairs_by_subject_ids`) does so
  against a selector's `universal_kinds` dimension, checked against
  `graph_edges.relation_kind`.
- `role` = the same value as `relation_kind` (no independent signal was
  found anywhere for what `role` should hold on this route).
- `evidence_class` = the fixed string `"confirmed"` (this converter does
  not carry `body.classification` through to the store as a queryable
  column).

This is a **documented modeling decision, not a discovered production
contract** — there is no real corpus with populated `graph_edges` to
validate it against. `tests/native-query-snapshot-port.test.ts`'s
`graph_edges_by_subject_ids`/`relation_pairs_by_subject_ids` test seeds
`graph_edges` manually with this SAME convention so the comparison is
meaningful rather than vacuous, and says so in its own comment.

### 1.5 Other modeling choices worth flagging

- **`owner_artifact`/`owner_version`** both reference the SAME interned
  `(artifact_id, artifact_version_id)` pair ordinal (`Dictionaries.artifacts`
  has no separate artifact-id-only ordinal space). Correct for this
  converter's single-generation-snapshot scope (an artifact_id has exactly
  one live version at any one converted generation, so `by_owner`
  aggregation is equivalent to per-artifact-id grouping); a real
  incremental producer (multiple versions of the same artifact_id
  coexisting across a store's generation history) would need a dedicated
  artifact_id-only ordinal space for `owner_artifact` — out of scope here,
  flagged for whoever builds the production P2-2/P2-3 write path.
- `identity_type`/`assignment_kind` are written as `0` always (the store
  keeps room for them, but `decodeRow`'s `RecordRow` output shape never
  reads either field, so there is nothing downstream to get wrong).
- `record_digest`/`previous_record_id` are not modeled meaningfully
  (`record_digest` = `sha256(record_id)`, a placeholder; `previous_record_id`
  = zero always) — neither is read by `decodeRow`, and this converter does
  one-shot cold conversion, not identity-chain replay.
- `dep_record_ids`/`dep_roles` sidecar entries exist so `depsByOwner`/
  `depsReverse` return a real `record_id`/`dependency_role`, even though
  no port method in the §7 mapping table actually calls them (kept for
  future use and exercised by the round-trip unit test).

## 2. Converter (`packages/engine/src/native-store-convert.ts`,
`scripts/convert-v3-to-native-store.mjs`)

`convertV3WorkspaceToNativeStore(database, workspaceId, generation, dir, options?)`
streams `record_occurrences` (LEFT JOINed with `identity_assignments`,
keyset-paginated on `record_id`, batch size 2,000) visible at `generation`,
groups `record_facets` per batch, decodes relation bodies via
`decodeCanonical` (`@urdira/canonical`) to pull `source_id`/`target_id` text
straight out of the record's own canonical body (mirrors the P0-S1 spike's
`scripts/v4-spike-extract-relations.mjs` approach, done here in TS instead
of a separate Node preprocessing pass since the converter is already TS),
and pushes batches into `NativeStoreBuilder`. `artifact_dependencies` are
read in one pass at the end. Every row is written with `valid_from = 1` at
the target store's own generation `1` (independent of the source
workspace's real generation number) — this converter's only job is "make
one v3 snapshot queryable through the native port," not incremental
replay (see the converter's own module doc for the full rationale).
`options.setStructuralStoreMeta` (default `false`) additionally flips
`workspace_meta.structural_store = "native"` via the (newly exported)
`writeStructuralStore` (`packages/storage/src/schema.ts`, now re-exported
from `packages/storage/src/index.ts` — a one-line addition).

CLI: `node scripts/convert-v3-to-native-store.mjs <db-path> <workspace-id> <out-dir> [generation] [--set-meta]`.

## 3. Port (`packages/engine/src/native-query-snapshot-port.ts`)

`NativeCanonicalQuerySnapshotPort implements CanonicalQuerySnapshotPort`.
`decodeRow` and its helpers (`recordBodyPayload`, `primarySourceSpan`,
`object`, the local `RecordRow` type) were extracted **verbatim** out of
`SqliteCanonicalQuerySnapshotPort` into `packages/engine/src/query-record-decode.ts`
— a pure refactor (`canonical-query-data-port.ts`'s own `decodeRow` is now
a one-line forward to the shared function; every one of that file's other
110+ `object(...)` call sites now imports the same shared helper). No
behaviour change: `tests/phase-canonical-query-data-port.test.ts` (98
tests), `tests/phase11-query-execution.test.ts`, and
`tests/phase17-pipeline-executor.test.ts` all still pass unmodified.

### 3.1 Method mapping (plan §7)

| Port method | Served from | Notes |
|---|---:|---|
| `records_by_ids` | native `recordsByIds` (record_id form) + one full-corpus scan for identity_id/identity_key forms | see §3.2 |
| `records_by_name` | native `recordsByName` | |
| `records_by_selector` | native `recordsByKindExact` per bounded `(universal_kind, category, kind)` combo, or a full-corpus scan+filter above `SELECTOR_COMBO_CAP` (512) | never declines — this method's return type has no `undefined` "decline" signal, so it must always answer correctly, just slower above the cap |
| `container_records_by_artifact_references` | catalog SQL (unchanged, same query shape as the SQLite port) → native `recordsByOwnerOrdinal` filtered to `universal_kind === 'core:container'` | |
| `graph_edges_by_subject_ids` | native `adjacency` | never `undefined` — adjacency is always authoritative on this route |
| `relation_pairs_by_subject_ids` | native `adjacency` + in-JS set intersection | never `undefined`, same reason |
| `records_for_query` / `records_for_query_batches` | native `iterVisibleBatch`, cursor-paginated | `records()` is just `records_for_query()` — this port has no warm cache to short-circuit through |
| `has_warm_records` | always `false` | |
| everything else (`records_by_artifact_versions`, `artifacts_by_filter`, `artifact_text`, `capability_states`, `search_literal`, `semantic_*`) | delegated to a wrapped `SqliteCanonicalQuerySnapshotPort` | catalog/FTS/vectors stay in SQLite per plan §9 |

`records_changed_between`/`changedBetween` is implemented and unit-tested
at the napi level but **not wired into the port** — `CanonicalQuerySnapshotPort`
has no such method slot today (`compare` is served through
`records_for_query`/`records_for_query_batches`, same as the SQLite port).

### 3.2 `records_by_ids`'s documented gap

The interface says `records_by_ids` resolves any of three id forms:
`record_id`, `identity_id`, `identity_key`. The native store has a fast
indexed path only for `record_id` (`recordsByIds`'s bsearch) — there is no
identity_id/identity_key index exposed by `StoreReader` that resolves to a
`record_id` by exact text (only `by_identity_last`, keyed by a raw digest,
used internally for future incremental-write predecessor resolution, not
exposed here). The port therefore does ONE full visible-corpus scan
(`iterVisibleBatch` to exhaustion) to resolve every non-record_id-shaped id
in a single call — correct, but O(corpus) instead of O(log n) for those
two forms. Flagged as a follow-up: a real production read path would want
`records.by_identity`-style exposure for exact identity_key lookup and a
reverse identity_id index.

### 3.3 Generation / staleness

`ensureGeneration` resolves the workspace's current generation exactly like
`SqliteCanonicalQuerySnapshotPort.currentGeneration`/`rejectSnapshotPin`
(duplicated intentionally — small, stable, catalog-only SQL; this class is
"a second, independent port implementation" per the task brief, not a
subclass), then calls `reopenIfChanged()` and requires
`handle.currentGeneration() >= workspaceGeneration`, else throws
`QueryPlanError("core:snapshot_expired", …)` — the honest failure mode
plan §7 asks for when the native store has not caught up, rather than
silently serving stale data.

## 4. Selection (`packages/daemon/src/runtime.ts`)

Single construction site, `acquireWorkspaceQueryEngine`: reads
`workspace_meta.structural_store` via `readStructuralStore(database.database)`
and checks the sibling `<db>.structural/` directory
(`structuralStoreDirFor`, mirroring `WorkspaceDatabase.openSidecar`'s own
"strip `.sqlite`, append a suffix" convention) actually exists on disk
before choosing `NativeCanonicalQuerySnapshotPort.open(...)` over the
default `SqliteCanonicalQuerySnapshotPort` — the meta flag alone is not
trusted, so a workspace whose catalog says "native" but whose structural
directory has not been materialized yet (e.g. mid-fork) never gets routed
into a nonexistent-directory error at query time; it falls back to SQLite
instead. `CachedWorkspaceQueryEngine.snapshot_port`'s type widened to
`SqliteCanonicalQuerySnapshotPort | NativeCanonicalQuerySnapshotPort`;
`NativeCanonicalQuerySnapshotPort` gained trivial `approxWarmBytes()` (→ 0)
/ `evictWarmRecords()` (no-op) methods so the daemon's
`URDIRA_WARM_RECORDS_BUDGET_MB` LRU loop can treat every cached workspace
uniformly regardless of which port backs it (the native route holds no
in-process record cache — its warm state is the OS page cache behind its
mmap segments, a different memory class this budget was never meant to
track).

## 5. Tests

`tests/native-query-snapshot-port.test.ts` (new file; local fixture helpers
mirroring — not importing, since the originals are module-private —
`tests/phase-canonical-query-data-port.test.ts`'s own patterns): 10 tests,
all green.

| Test | Covers |
|---|---|
| `NativeStoreBuilder`/`NativeStructuralStoreHandle` round trip | every implemented napi method against 2 records + 1 dependency: `finish` summary, `currentGeneration`, `reopenIfChanged`, `visibleCount`, `recordsByIds`, `recordsByName`, `recordsByKindExact`, `adjacency`, `iterVisibleBatch` pagination (incl. the "full page still carries a cursor" contract shared with the SQLite port), `recordsByOwnerOrdinal`, `depsReverse` |
| `records_by_ids` (record_id / identity_id / identity_key forms) | matches SQLite port exactly for all three id shapes |
| `records_by_name` | matches SQLite port, **modulo a discovered pre-existing SQLite-port bug** (§6) |
| `records_by_selector` (fully- and partially-specified selectors) | matches SQLite port |
| `container_records_by_artifact_references` | matches SQLite port |
| `graph_edges_by_subject_ids` + `relation_pairs_by_subject_ids` | matches SQLite port under the §1.4 convention (manually-seeded `graph_edges` for the comparison, since production never populates it) |
| `records()` / `records_for_query_batches()` full corpus | matches SQLite port |
| generation staleness | native store behind the workspace's current generation → `core:snapshot_expired` |
| delegation | `artifacts_by_filter`/`has_warm_records` correctly pass through to the wrapped SQLite port |
| `core:get_source` / `core:find_records` via `CanonicalRecordQueryDataPort`/`QueryEngine` | identical `evaluation.streams` on both ports, end to end through the real operation-execution path, not just the raw port methods |

`tests/phase-canonical-query-data-port.test.ts` (98 tests),
`tests/phase11-query-execution.test.ts`, `tests/phase17-pipeline-executor.test.ts`,
and `tests/codebase-fixtures.test.ts` all still pass unmodified — confirms
the `decodeRow` extraction is behaviour-neutral. A broader "run the gold
manifests / `codebase-fixtures` harness through the native port too" hook
was scoped by the task as "ideally" and was **not implemented** in this
session (the harness runs the real JS/TS indexing pipeline end to end,
which is a materially larger integration than the direct-port comparison
tests above) — flagged as a follow-up, not silently dropped.

## 6. Bug found, not hidden: `SqliteCanonicalQuerySnapshotPort.records_by_name` drops `primary_source_span`

`records_by_name`'s own SQL (`canonical-query-data-port.ts`) selects only
`record_id, workspace_id, category, kind, universal_kind, body_payload,
owner_artifact_id, owner_artifact_version_id, identity_id, identity_key` —
**it never selects the five `primary_source_span_*` columns** that every
other record-fetching method in the same class does
(`records_by_ids`/`records()`/`records_by_selector`/`container_records_by_artifact_references`
all go through `queryRecordRows`, which does select them). So
`SqliteCanonicalQuerySnapshotPort.records_by_name` silently omits
`primary_source_span` from every result, regardless of the underlying
data. This is a **pre-existing bug in production code, discovered while
building this port's test — not caused by, or specific to, the native
route** (the native port's `recordsByName` has no such gap; every one of
its methods returns the full row). Left unfixed in this session (fixing
shared SQLite-port SQL was out of this task's scope and carries its own
regression-testing burden against a 3,246-line file under active
concurrent use); `tests/native-query-snapshot-port.test.ts`'s
`records_by_name` test documents the gap explicitly and asserts equality
modulo the missing field, rather than silently loosening the native side
to match. Recommended follow-up: add the five span columns to
`records_by_name`'s `SELECT`.

## 7. Build / verification

- `cargo build -p urdira-native-node --release --target aarch64-apple-darwin`
  — succeeds. **`node scripts/build-native.mjs` (the full script, which
  also builds `urdira-indexing-worker`) currently fails** —
  `crates/urdira-indexing-worker/src/main.rs:1500` has a non-exhaustive
  match on `IndexingCommand::WorkspaceScan` (a variant added by the
  concurrent v4-pipeline work in `crates/urdira-indexing-worker/src/v4/*`,
  mid-edit, unrelated to this task). Worked around by building
  `urdira-native-node` alone and copying
  `target/aarch64-apple-darwin/release/liburdira_native_node.dylib` to
  `release/native/darwin-arm64/urdira-native.node` by hand — the exact
  artifact `scripts/build-native.mjs` would have produced for this crate.
  This blocker is **not fixable from this task's scope** (it is someone
  else's in-progress file); flagged for whoever lands the v4 pipeline work.
- `cargo clippy -p urdira-native-node --all-targets -- -D warnings` — clean.
- `cargo fmt -p urdira-native-node -- --check` — clean.
- `pnpm --filter @urdira/engine exec tsc --noEmit` — clean for every file
  this task touched. (One PRE-EXISTING error surfaced in
  `packages/engine/src/rust-workspace-scan.ts`, an untracked file from the
  concurrent v4-pipeline agent's own work-in-progress — not touched here,
  not caused by this task.)
- `pnpm --filter @urdira/daemon exec tsc --noEmit` — clean.
- `pnpm eslint` on every new/changed file — clean.
- `npx vitest run tests/native-query-snapshot-port.test.ts` — 10/10.
- `npx vitest run tests/phase-canonical-query-data-port.test.ts tests/phase11-query-execution.test.ts tests/phase17-pipeline-executor.test.ts tests/codebase-fixtures.test.ts` — 101/101.
- `npx vitest run tests/phase8-runtime.test.ts tests/phase-daemon-scan-aggregation.test.ts tests/query-pushdown-graph.test.ts tests/v3-query-admission.test.ts tests/phase-daemon-indexing-integration.test.ts tests/phase-daemon-admin-integration.test.ts` (daemon smoke around the `runtime.ts` edit) — 177/177.
- Full repo-wide `pnpm verify` was **not** run in this session (out of time
  budget for a task already spanning napi/Rust + 6 new/changed TS modules
  + a daemon wiring change); the targeted suites above cover every file
  this task touched plus its immediate daemon integration point. Flagged
  so the next session runs `pnpm verify` before this lands.

## 8. Perf (small-scale only — see caveat)

5,000 synthetic entity records, one artifact, cold conversion + two query
shapes, native vs SQLite, same process, same machine (macOS arm64):

| | SQLite port | Native port |
|---|---:|---:|
| Convert (v3 → native store) | — | 288 ms |
| `records()` full load | 37 ms | 25 ms |
| `records_by_ids` × 20 calls (100 ids/call) | 42 ms | 10 ms |

**Caveat**: 5,000 records is far below the scale (n8n: ~3.2M records) the
plan's P2 gate cares about, and this converter is explicitly NOT the
production write path (JSON sidecar, O(n) `iterVisibleBatch` pagination
per call — see §1.3/§3.1's own scale caveats). These numbers only show
"the native route is not slower even at small scale, and its per-id
lookup is meaningfully faster" — they are not a substitute for the P2
harness gate (`consultable ≤ 8s, durable ≤ 12s` etc. on real n8n data),
which requires the actual P2-2/P2-3 production cold pipeline, not this
converter.

## 9. Files

- `crates/urdira-native-node/Cargo.toml` (+ `urdira-structural-store`, `sha2` deps)
- `crates/urdira-native-node/src/lib.rs` (+1 line: `mod structural_store_napi;`)
- `crates/urdira-native-node/src/structural_store_napi.rs` (new)
- `packages/engine/src/query-record-decode.ts` (new — extracted from `canonical-query-data-port.ts`)
- `packages/engine/src/canonical-query-data-port.ts` (refactored to import the extracted helpers; no behaviour change)
- `packages/engine/src/native-structural-store-binding.ts` (new)
- `packages/engine/src/native-store-convert.ts` (new)
- `packages/engine/src/native-query-snapshot-port.ts` (new)
- `packages/engine/src/index.ts` (+ exports)
- `packages/storage/src/index.ts` (+1 line: re-export `readStructuralStore`/`writeStructuralStore`)
- `packages/daemon/src/runtime.ts` (port-selection at the single construction site + `structuralStoreDirFor` helper + `CachedWorkspaceQueryEngine.snapshot_port` type widened)
- `scripts/convert-v3-to-native-store.mjs` (new)
- `tests/native-query-snapshot-port.test.ts` (new)
- `release/native/darwin-arm64/urdira-native.node` (rebuilt artifact, not source — regeneratable via `cargo build -p urdira-native-node --release --target aarch64-apple-darwin` + copy, or the full `scripts/build-native.mjs` once the unrelated `urdira-indexing-worker` build is fixed)
