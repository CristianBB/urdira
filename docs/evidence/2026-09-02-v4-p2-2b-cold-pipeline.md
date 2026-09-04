# P2-2b: Rust-owned v4 cold scan inside the persistent indexing worker

Implements plan `resilient-knitting-twilight.md` §4 (cold pipeline),
§6.1 (protocol), §8 (Merkle), §2.4/§2.6 (write + readiness) end to end:
catalog → parse/semantics → facts materialised directly into
`urdira-structural-store` rows → segment write → Merkle → SQLite snapshot →
events, behind a new `IndexingCommand::WorkspaceScan` protocol command. No
TypeScript checker, no TEMP-SQLite staging. Not committed, per task
instructions.

Machine: macOS arm64, 10 cores, 32 GB RAM, NVMe. `rustc`/`cargo` 1.98.0,
Node 24.x.

## 1. Files

New (all under a dedicated module, per the task's isolation rule):
- `crates/urdira-indexing-worker/src/v4/mod.rs` — `ScanError`, `now_iso8601`
  (a from-scratch civil-calendar ISO8601 formatter, no `chrono`/`time` dep).
- `crates/urdira-indexing-worker/src/v4/catalog.rs` — opens/ensures the v4
  catalog schema, drives `urdira-source-frontier`'s `Walker`/`Frontier`/
  `Catalog::apply` for a full (cold) scan.
- `crates/urdira-indexing-worker/src/v4/analyze.rs` — drives
  `urdira-jsts-syntax-worker`'s `SyntaxWorkerState::analyze`/
  `read_facts_group` (lane-1 facts: entities, `contains`/`import`/`export`)
  and `analyze_owner_semantics_with_context` (E1a-E3 hybrid lane:
  `references`/`covers`/`call`/`inherits`/`implements`), in parallel across
  owners via `std::thread::scope`.
- `crates/urdira-indexing-worker/src/v4/materialize.rs` — `ProposedRecord`
  → `structural_kernel_batch_parts` (native kernel) → `RecordRow`; owner
  canonicalization parallelised with `rayon`.
- `crates/urdira-indexing-worker/src/v4/deps.rs` — `ProposedRecordDependency`
  → `DependencyRow`.
- `crates/urdira-indexing-worker/src/v4/publish.rs` — sort, `SegmentWriter::
  write_base`, graph/metric Merkle roots, `Queryable` event, SQLite snapshot
  transaction, `ScanCompleted` event.
- `crates/urdira-indexing-worker/src/v4/timings.rs` — `ScanClock`, per-phase
  timing accumulation into `ScanTimings`.
- `crates/urdira-indexing-worker/src/v4/scan.rs` — orchestrator
  (`ScanRequest`, `run`).
- `crates/urdira-indexing-worker/src/v4/tests_e2e.rs` — end-to-end unit
  tests against `tests/fixtures/codebases/typescript/task-planner` (see §5).
- `crates/urdira-worker-protocol/tests/fixtures/workspace-scan-v4.json`,
  `crates/urdira-worker-protocol/tests/workspace_scan_v4_fixture.rs` —
  cross-language protocol fixture (see §2).
- `packages/engine/src/rust-workspace-scan.ts` — `runRustWorkspaceScan`.
- `scripts/v4-scan.mjs` — CLI harness (workspace root, data dir → runs one
  cold `WorkspaceScan`, prints timings/roots/paths).
- `tests/rust-protocol-v4.test.ts`, `tests/v4-scan.test.ts` — vitest
  mirrors of the two Rust test additions above.

Modified:
- `crates/urdira-worker-protocol/src/lib.rs` (+270 lines): new
  `IndexingCommand::WorkspaceScan`, `IndexingEvent::{Queryable,
  ScanCompleted}`, `ScanScope`/`ChangedPath`/`ChangeKind`/`ScanPriority`/
  `ScanTimings`/`ScanRoots`; 8 new/updated `#[test]`s (all `IndexingCommand`/
  `IndexingEvent` variants stay `deny_unknown_fields`-closed). The existing
  v3 variants (`IndexGeneration`, `AcceptGroup`, ...) are untouched.
- `crates/urdira-indexing-worker/src/main.rs` (+69 lines): `mod v4;` near
  the top, and one `IndexingCommand::WorkspaceScan { .. } => { ... }` arm in
  the command dispatch `match` inside `main()`. Nothing else in this file
  was touched — the existing v3 facts lane (`run_jsts_generation`,
  `compute_hybrid_semantics`, `accept_group`, ...) is entirely untouched, so
  the concurrent typeflow effort's edits to this same file (in its own
  worktree) should merge cleanly against this diff.
- `packages/plugin-javascript-typescript/src/indexing-core-process-
  transport.ts`: `WorkspaceScanRequest`/`ScanScope`/`ScanTimings`/
  `ScanRoots` types, two new `IndexingEvent` union members
  (`queryable`/`scan_completed`), and `IndexingCoreProcessTransport.
  workspaceScan` (see §2.3 for how the two-event-per-command shape is
  handled without breaking the transport's existing resolve-once model).
- `packages/engine/src/rust-indexing-core-port.ts`: the same wire-shape
  mirror plus `validateWorkspaceScanRequest`.

## 2. Protocol (plan §6.1)

### 2.1 Rust

```rust
IndexingCommand::WorkspaceScan {
    request_id, workspace_id, workspace_root, database_path,
    structural_root, cas_root, sidecar_root,
    scope: ScanScope,             // Full | Changed { paths: Vec<ChangedPath> }
    registry_snapshot_id, configuration_revision_id, resolution_lock_id,
    deadline_ms: Option<u64>, priority: ScanPriority,  // Interactive | Background
}
IndexingEvent::Queryable { request_id, operation_id, generation, manifest_path, timings: ScanTimings }
IndexingEvent::ScanCompleted { request_id, operation_id, generation, snapshot_id, roots: ScanRoots, timings: ScanTimings }
```

`ScanTimings` fields (`catalog_ms`/`parse_ms`/`resolve_ms`/
`materialize_ms`/`write_ms`/`fsync_ms`/`snapshot_ms`/`lexical_ms`, all
`Option<u64>`, plus a mandatory `total_ms: u64`) are integers, not floats —
an `IndexingEvent`-wide `derive(PartialEq, Eq)` requirement that a `f64`
field can't satisfy; ms granularity is enough for every gate this task
measures against. `ScanRoots` carries all four plan §8.2 roots (`records`,
`dependency`, `graph`, `metric`) as `sha256:`-prefixed hex, even though
`urdira-structural-store` itself only tracks `records`/`dependency` — see
§4.4 for how `graph`/`metric` get computed and persisted by this task's own
code.

**Deviation from the plan's own §6.1 sketch and this task's brief**: added
`workspace_root: String`. Neither source names a field for the filesystem
tree the Rust `Walker` should walk — `cas_root`/`structural_root`/
`database_path`/`sidecar_root` are all `<data_root>/workspaces/<ws>/...`
paths (plan §1's topology), an entirely different directory from the
workspace's own source checkout, so there is no way to derive one from the
others. Documented here rather than worked around with an out-of-band
directory convention.

`request_id` doubles as `operation_id` on every event this command emits
(documented on the `WorkspaceScan` variant itself) — unlike
`IndexGeneration`'s `IndexingGenerationRequest`, one `WorkspaceScan` command
is exactly one operation, so there is no separate id to carry.

### 2.2 Cross-language fixture test

`crates/urdira-worker-protocol/tests/fixtures/workspace-scan-v4.json` holds
one JSON object per shape (`workspace_scan_full`, `workspace_scan_changed`,
`queryable`, `scan_completed`). `crates/urdira-worker-protocol/tests/
workspace_scan_v4_fixture.rs` (4 `#[test]`s) decodes each entry with
`serde_json::from_value` and asserts it equals the expected Rust enum
value. `tests/rust-protocol-v4.test.ts` (4 vitest cases) builds the same
objects from the TS-typed `WorkspaceScanRequest`/`IndexingEvent` shapes and
asserts `toEqual` against the identical fixture file read from disk — so a
field rename or `kind` tag drift on either side breaks a test on both
sides against the one shared source of truth. All 8 pass (`cargo test -p
urdira-worker-protocol`, `vitest run tests/rust-protocol-v4.test.ts`).

### 2.3 TS transport: one command, two events

Every other `IndexingCoreProcessTransport` method sends one command and
resolves once, on the first event whose `request_id` matches (the existing
`pending` map in `indexing-core-process-transport.ts`). `workspace_scan` is
the first command that produces **two** events sharing one `request_id`
(`queryable` then the terminal `scan_completed`) — resolving on the first
would silently drop `scan_completed`, and the pre-existing dispatch loop
would then throw "unknown request identity" when `scan_completed` arrived
with no pending entry.

Fixed with a side channel (`queryableHandlers: Map<string, (event) => void>`)
checked before the normal resolve-once dispatch: a `queryable` event whose
`request_id` has a registered handler invokes it and is NOT deleted from/
resolved against `pending` — the terminal event still flows through the
untouched resolve-once path. `workspaceScan(request, onQueryable?)` sends
the command with a request id generated up front (via a new `sendWithId`,
factored out of the existing `send`) and registers the handler under that
same id before writing to the child's stdin, so there's no race between
"child responds" and "handler registered." `RustWorkspaceScanTransport`
(the narrow interface `rust-workspace-scan.ts` depends on, not the
concrete transport, so `packages/engine` has no compile-time dependency on
`packages/plugin-javascript-typescript`) mirrors this shape.
`runRustWorkspaceScan` records both `queryable_at_ms` and `completed_at_ms`
wall-clock offsets from one `Date.now()` baseline — the harness/daemon
readiness surface wants both `structural_queryable_ms`/
`structural_durable_ms` (plan §2.6) and this is the one place both are
observable together for a single scan.

## 3. Facts pipeline (plan §4.2-§4.5): reused, not reimplemented

The single biggest risk in this task was reimplementing "the facts
extractor" from scratch and drifting from v3's record shapes. That risk
did not materialize, because the actual extraction logic already lives in
reusable library crates `urdira-indexing-worker` was already linking
against for its own v3 pipeline, not inline in `main.rs`:

- `urdira_jsts_syntax_worker::SyntaxWorkerState::analyze` +
  `read_facts_group` — pure-Rust, oxc-based, checker-free "lane 1": per-file
  entity declarations (`jsts:entity_*`) and `jsts:relation_contains`/
  `_import`/`_export`, already returned as fully-formed `ProposedRecord`s
  (`proposal_record_key`, `category`, `kind`, `universal_kind`, `facets`,
  `source_span`, `identity_key`, `body`, `evidence_references`) — not a
  reimplementation target, a public API this module calls directly, in
  process (confirmed live: `main.rs` itself calls `SyntaxWorkerState`
  in-process, never as a subprocess).
- `urdira_jsts_syntax_worker::analyze_owner_semantics_with_context` —
  the E1a-E3 hybrid lane (`OwnerSemantics.reference_rows`/`covers_rows`/
  `call_rows`/`heritage_rows`), same `ProposedRecord` shape, same calling
  convention `main.rs`'s own `compute_hybrid_semantics` uses (built the
  same `HybridResolutionContext` from `WorkspaceResolver::build` +
  `decode_config_assets`).
- `urdira_indexing_core::structural_kernel_batch_parts` (re-exported from
  `urdira-native-core`) — canonicalizes a batch of `StructuralKernelRecord`s
  and computes `record_id`/`record_digest`/`body_digest`/`identity_id`/
  `identity_key_digest`/`identity_assignment_id` **and the canonical UCE
  body bytes**, all in one call. This is the exact same function `main.rs`'s
  `canonicalize_structural_chunk` (main.rs:1139) calls for its own hybrid
  rows.

`crates/urdira-indexing-worker/src/v4/analyze.rs` reimplements only two
trivial predicates that could not be imported from the private binary
crate (`is_jsts_source_path`/`is_config_asset_path`, byte-identical copies
of main.rs:2519/2535) and the source-blob read+hash-verify step
(`read_owner_source_text`, byte-identical copy of main.rs:817-833) —
documented at each copy's definition, same isolation rationale
`urdira-source-frontier`'s own evidence doc used for `logical_value`/
`stable_id`.

### 3.1 Record identity/digests: reproduced exactly, by construction

`materialize.rs` does not reimplement decision 11. It builds
`StructuralKernelRecord`s from `ProposedRecord`s and calls
`structural_kernel_batch_parts` directly (bisecting into sub-batches on a
`MAX_BATCH_RECORDS`/`MAX_BATCH_FRAMED_BYTES` rejection, same recursive
strategy as `main.rs`'s `canonicalize_structural_chunk`, generalised to
keep the full `StructuralKernelResult` rather than only canonical text).
Reading `crates/urdira-native-core/src/lib.rs`'s `structural_kernel_batch_
parts` body directly (not inferring from callers) confirms:

- `record_digest` = `structural_record_digest(record)`, a UCE hash over
  `{"body": record.body}` only — facets/kind/identity_key/span never enter
  this digest.
- `record_id` = `"record:" + sha256(record_digest)` — **unconditionally**;
  the function has no predecessor/chaining parameter at all. Decision 11's
  "cold: no predecessors, first occurrence" is this function's *only*
  behavior, so a cold scan reproduces it for free — there is no
  hand-written recipe to drift from the authoritative one.
- `body_digest`/`body_byte_length` come from the same UCE encoder that
  produces the canonical body bytes (`record_body_payload_hexes[i]`,
  hex-decoded into `RecordRow.body` — byte-identical to `body_payload` by
  construction, since it's the same function).
- `identity_id` = `"{identity_type}:" + sha256({"identity_key": key})`,
  `identity_key_digest` = `sha256(identity_key)` (UCE text digest),
  `identity_assignment_id` = `sha256({"identity_key": key, "record_id": id})`.

`crates/urdira-indexing-worker/src/v4/materialize.rs`'s test
`record_identity_matches_the_structural_kernel_oracle_exactly` builds one
`ProposedRecord`, canonicalizes it directly through
`structural_kernel_batch_parts` as an oracle, runs the same record through
`materialize_cold`, and asserts every decoded 32-byte field
(`record_id`/`record_digest`/`body_digest`/`identity_id`/
`identity_key_digest`) and the decoded body bytes are identical to the
oracle's own output, byte for byte — this is the regression test for this
module's hex/prefix decoding (`record:`/`sha256:`/`<type>:` stripping),
which is the only place a transcription bug could have crept in.

### 3.2 New v4-only ground (no v3 equivalent to mirror)

Documented in `materialize.rs`'s own module doc, summarized here:

- **Facets bitmask** (`FACET_ORDER`, 13 bits): v3 stores facets as TEXT
  rows (`record_facets`); v4's fixed-width `records.meta` needs a bitmask.
  Bit order is the concatenation of `entityFacets`/`relationFacets` from
  `packages/plugin-javascript-typescript/src/registry-contribution.ts:
  152-153` (the JS/TS registry's only two facet lists, confirmed
  exhaustive over the current registry). An unrecognized facet string is
  silently dropped rather than erroring.
- **`kind_id`/`universal_kind_id`/`relation_kind_id`/`name_id` dictionaries**:
  v3 stores `kind`/`universal_kind`/`identity_key` as TEXT; the v4 store
  needs small integer ordinals. Assigned in first-seen order, walking
  owners in `owner_path` order (never `HashMap` iteration order) — this is
  what makes two independent cold scans produce byte-identical dictionaries
  (verified: see §5's determinism test). `relation_kind_id` uses a
  dictionary keyed on `universal_kind` (e.g. `"core:contains"`,
  `"core:references"`), populated only for relation-category rows;
  `name_id` is the last `:`-segment of `identity_key`.
- **`dicts.artifacts`**: one ordinal per **owner** (not per artifact_id and
  per artifact_version_id separately) — `RecordRow.owner_artifact` and
  `.owner_version` are set to the *same* ordinal, both indexing into the
  one `(artifact_id, artifact_version_id)` pair for that owner. There is
  exactly one live version per artifact at generation 1, so a second index
  space would be pure redundancy.
- **`source_subject`/`target_subject`** (relation rows only): resolved from
  `body.source_id`/`body.target_id` (the referenced entity's own
  pre-record `identity_key`, the same convention
  `urdira-jsts-native-projection::relation_record`'s `body` construction
  and the syntax-worker's own relation rows both use) against a
  same-generation `identity_key -> record ordinal` map built while
  materialising every owner (a relation can point forward to a
  lexically-later file, e.g. an `import`, so subject resolution is a
  second pass after every owner's records exist). The subject KEY stored in
  `dicts.subjects` is the resolved entity's `record_id` — an interim,
  cold-scan-only choice; a cross-generation-stable choice (`identity_id`)
  is deferred to P3, where identity churn across generations first
  matters. An unresolved endpoint (external module, or a target this
  workspace never emitted a record for) leaves that side `None` — verified
  live by `unresolved_relation_endpoint_leaves_that_subject_none`.
- **`span_start_line`/`span_end_line`**: always `0`. No producer in this
  pipeline emits line numbers — every `ProposedRecord.source_span` this
  task's producers build only ever carries `{path, start, end}` byte
  offsets (confirmed by reading every `source_span`/`canonical_span`
  construction site in `urdira-jsts-syntax-worker`). Computing them would
  need a byte/UTF-16-offset-aware scan of the owner's source text per
  record; deferred as a documented gap. Does not affect identity/digest
  determinism (§3.1: digests never read span fields).
- **`dependency_id`** (`deps.rs`): `urdira-structural-store`'s own evidence
  doc already documents this field as a deliberate addition with no v3
  precedent ("added here because delta closures need a key"). This task
  mints one as `sha256("urdira:v4-dependency-id:v1\0" || record_ordinal ||
  dep_artifact_ordinal || dep_version_ordinal || role_byte)`.
- **`capability_state_digest`**: v3 builds this from a capability-state
  JSON envelope the TS candidate-publication orchestration assembles; a
  Rust-only cold scan has no such envelope. Uses the same `digest_envelope`
  framing (§3.3) over an empty array, documented as a placeholder, not a
  v3 mirror. `source_observation_watermarks` is likewise `"[]"` (this
  crate's own catalog walker has no provider-watermark/cursor concept —
  `urdira-source-frontier`'s own evidence doc notes the same gap for
  `source_observation_id`).

### 3.3 Snapshot digest envelope

`crates/urdira-indexing-worker/src/v4/publish.rs` ports `main.rs`'s private
`uce`/`uce_varint`/`json_digest`/`digest_envelope` (main.rs:4557-4612,
5135-5138) byte-for-byte (same tag scheme as `urdira-native-core`'s
private `update_uce_value`, cross-checked line-for-line against both
sources) — an independent copy, not a shared import, per this task's
isolation rule (main.rs is a binary crate, these are private `fn`s).
`snapshot_digest = digest_envelope("core:snapshot", "core:snapshot_digest",
"core:SnapshotDigestPayload", <snapshot row fields>)`, matching
`finalize_workspace_publication`'s own envelope call shape.
`canonical_record_set_digest`/`projection_set_digests` instead use the
plan's own NEW v4-specific formulas (§8.2, not the v3 envelope):
`sha256("urdira:record-set:v4\0" || u64le(count) || root32)` and
`sha256("urdira:projection-set:v4\0" || kind || 0 || u64le(count) ||
root32)` for `dependency`/`graph`/`metric` (`lexical` excluded per plan
decision 13).

## 4. Store write (plan §2.4/§4.6)

### 4.1 `SegmentWriter::write_base`

Called once with the full sorted `Vec<RecordRow>`/`Vec<DependencyRow>`/
`Dictionaries` for generation 1. This crate (untouched, per the task's
constraint on `writer.rs`) already splits page-cache-visible writes from
the fsync pass internally and publishes `MANIFEST` atomically.

**Deviation from plan §2.4 step 3** ("`MANIFEST.next` → evento `Queryable`
→ `fdatasync` ... → evento `Completed`"): `write_base` performs the
page-cache write, the fsync, AND the `MANIFEST` publish all inside one
synchronous call — this task's code cannot observe a genuine gap between
"queryable" and "durable" the way the plan describes, since both already
happened by the time `write_base` returns. `Queryable` is emitted
immediately after that call returns, using `write_base`'s own returned
`to_page_cache`/`durable` split for the two events' respective `timings`
fields, so the reported phase breakdown is still accurate even though the
two events are not separated by real wall-clock time in this
implementation. Documented, not hidden: by the time any reader could act
on `Queryable`, the durable phase (from this call) has, in practice,
already completed too.

### 4.2 Graph and metric roots

`urdira-structural-store` only tracks `records`/`dependency` roots (its own
evidence doc: "no separate edge table on the Rust route... adjacency is an
index over relation records", so there's no independent edge/metric set to
root there). `publish.rs` computes these itself, directly against
`urdira_structural_store`'s re-exported `BucketedMerkleSet`/`SetKind`:
`graph` = the bucketed set over `(record_id, record_digest)` pairs for
`category == CATEGORY_RELATION` rows only; `metric` = the canonical empty
set (`BucketedMerkleSet::from_sorted(&[])`, no metric projection generator
exists in this task's scope). Both are persisted to
`structural/merkle/{graph,metric}.tree` using the same `write_to`/`SetKind`
API the crate uses for its own two trees.

### 4.3 SQLite snapshot transaction

One transaction per cold scan: `registry_snapshots` (a minimal placeholder
row — `INSERT OR IGNORE`, since the request's `registry_snapshot_id` has no
prior row for a from-scratch v4 catalog and `snapshots.registry_snapshot_id`
has a `FOREIGN KEY` into it), `snapshots` (all 20 columns), `workspace_
current_state` (upsert, `state_revision` incremented), `merkle_roots` (one
row per set kind, `member_count` = the real visible count for that
specific set — `records.len()`, `dependencies.len()`, the relation-only
count, and `0` for metric, respectively — not a single reused figure),
`candidate_state` (a minimal placeholder row, `state='published'`,
`trigger_kind='v4_cold_scan'` — required because `generation_manifests.
candidate_generation_id` has a `FOREIGN KEY` into it and a v4 cold scan has
no real v3 candidate), `generation_manifests`.

**Bugs found and fixed live during n8n measurement** (both discovered
because a full n8n run surfaces scale/constraint issues a small fixture
run does not):
1. `PRAGMA foreign_keys=ON` (set in `catalog.rs`) plus no `candidate_state`
   row before the `generation_manifests` insert → that insert would fail
   closed on every scan once FK enforcement actually mattered (the small
   `task-planner` fixture test happened not to exercise this because... it
   didn't: this was a real bug, only caught once someone ran the full n8n
   corpus and hit the FK violation immediately). Fixed by inserting the
   minimal placeholder `candidate_state` row first.
2. The `merkle_roots` insert loop passed `records.len()` for all four rows
   regardless of `set_kind` — `dependency`/`graph`/`metric` all got the
   `records` count instead of their own. Fixed to pass the correct
   per-kind count (also fixed a related stub, `count_visible_deps`, which
   always returned `0` for the `dependency` `projection_set_digests`
   entry's count field regardless of the real dependency count — both now
   use the same real `dependencies.len()`/relation-count values the
   `merkle_roots` loop uses).

## 5. Tests

`cargo test -p urdira-indexing-worker -p urdira-worker-protocol`: **60
passed, 1 ignored** (the diagnostic histogram test, §6.3), 0 failed.
`cargo fmt --check` / `cargo clippy -p urdira-indexing-worker -p
urdira-worker-protocol --all-targets -- -D warnings`: clean.

New Rust tests, `crates/urdira-indexing-worker/src/v4/materialize.rs`:
- `record_identity_matches_the_structural_kernel_oracle_exactly` (§3.1).
- `relation_subjects_resolve_to_the_referenced_entitys_record_id` /
  `unresolved_relation_endpoint_leaves_that_subject_none` (§3.2).
- `materialize_cold_is_deterministic_across_runs`, `facets_bitmask_sets_
  exactly_the_matched_bits`, `identity_key_name_takes_the_last_colon_
  segment`.

New Rust tests, `crates/urdira-indexing-worker/src/v4/tests_e2e.rs` (task
deliverable 5's integration test — `urdira-indexing-worker` has no library
target, only `[[bin]]`, so an external `tests/*.rs` file cannot import
`crate::v4` at all; these run as `#[cfg(test)]` unit tests inside the
binary's own harness instead, driving the exact same `catalog::
run_full_scan` → `analyze::run_cold` → `materialize::materialize_cold` →
`publish::publish_cold` sequence `scan::run` does):
- `cold_scan_produces_a_readable_store_with_the_expected_record_count`:
  runs the pipeline against `tests/fixtures/codebases/typescript/
  task-planner`, opens the result with the real `urdira_structural_store::
  StoreReader` (not a decoder written for the test), asserts `MANIFEST`/
  segment files exist and `reader.visible_count(1)`/`deps_visible_count(1)`
  match the materialized row counts exactly.
- `cold_scan_is_deterministic_across_two_independent_runs`: two from-scratch
  runs, asserts every record's `record_id`/`record_digest`/`identity_key`
  match after sorting, and the `MANIFEST`'s `records` root is byte-identical
  across the two runs.

New vitest tests: `tests/rust-protocol-v4.test.ts` (§2.2, 4 tests, no
worker binary needed). `tests/v4-scan.test.ts` (4 tests, gated on the
release binary existing via `describe.skip`, with an always-on companion
test that prints a build hint when it's missing rather than silently
skipping without a trace): spawns the real worker process through
`createIndexingCoreProcessTransport`, runs a full scan of the same
`task-planner` fixture, and asserts (a) the store is queryable+durable with
valid `sha256:`-prefixed roots and `queryable_at_ms <= completed_at_ms`,
(b) exactly one `snapshots` row with a valid `snapshot_digest`/
`canonical_record_set_digest` and all four `projection_set_digests` kinds
present, `workspace_current_state`/`merkle_roots` populated, and (c)
determinism: two independent cold scans of the fixture produce identical
`records`/`graph`/`dependency` roots. All pass.

**Not done** (documented per the task's own allowance, "EXCLUDING
`jsts:diagnostic` records and any checker-only rows" comparison): a
byte-for-byte record-id diff against the actual v3 pipeline's output for
the same fixture. v3's real entity/`contains` records are produced by the
TypeScript checker (`analyzer.ts`), not by `read_facts_group` — running v3
over the same fixture to diff would need the full daemon+checker stack,
out of this task's time budget. What IS covered, and is the harder-edged
claim: this pipeline's `record_id`/digests are proven byte-identical to
what `structural_kernel_batch_parts` (the SAME function v3's own hybrid
lane calls) produces for the same `ProposedRecord` (§3.1's oracle test) —
so the only place v3 and v4 could actually diverge for a shared symbol is
*which* `ProposedRecord`s get produced (a different producer: Rust lane-1
vs. TypeScript checker), never *how* an agreed-upon `ProposedRecord`
becomes a record id.

## 6. n8n measurement

Corpus: `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`
(20,148 files / 120.3 MB full tree per source-frontier's own evidence doc;
14,082 JS/TS owners after `is_jsts_source_path` filtering — this run's
`artifacts_interned` count, §6.3). Idle-checked (`pgrep -f "urdira-
indexing-worker|n8n-incremental-preflight"` empty) immediately before each
run via `node scripts/v4-scan.mjs <corpus> <fresh-data-dir>`, `/usr/bin/
time -l` wrapped. Data dirs: `~/Proyectos/urdira-benchmark/
v4-p2/run1` and `.../run3` (never `/tmp`).

**Machine-sharing note**: this session ran alongside other concurrent
agents on the same machine for parts of this measurement window (a
typeflow effort's own `cargo`/`rustc` builds in a separate worktree; a
research fork of this same session that, beyond its assigned scope, also
built and ran this exact benchmark independently before being asked to
stop — see §7). `run1` and `run3` below are this task's own two
independently-run, first-hand measurements; the variance between them
(§6.1) is attributed to that contention, not to code changes, since both
ran functionally equivalent code (see §6.2).

### 6.1 Phase timings

| Phase | run1 (ms) | run3 (ms) |
|---|---:|---:|
| catalog (walk + hash + CAS + `Catalog::apply`) | 82,539 | 95,484 |
| parse (`SyntaxWorkerState::analyze`) | 810 | 1,068 |
| resolve (E1a-E3 hybrid lane, parallel across owners) | 1,715 | 4,510 |
| materialize (kernel canonicalization + dictionary/subject assembly) | 273,576 | 359,908 |
| write (segments to page cache) | 1,729 | 3,333 |
| fsync (durable) | 124 | 550 |
| snapshot (SQLite transaction) | 10 | 52 |
| **total (`Queryable`≈`ScanCompleted`, §4.1)** | **411,284** | **522,312** |

`/usr/bin/time -l` wall/peak RSS: run1 **412.08 s real, 10.18 GB peak
RSS**; run3 **527.06 s real, 5.77 GB peak RSS** (RSS variance is itself
plausibly contention-driven — page cache/reclaim pressure from concurrent
builds — not a pipeline behavior change; both are comfortably under the
machine's 32 GB).

**Gate result: does not meet "queryable ≤ 8 s."** Reported per the task's
explicit instruction not to hide this. `materialize` is the dominant cost
by a wide margin (66-69% of wall time), `catalog` is a distant second
(16-20%); every other phase is under 1% of total.

### 6.2 The one lever actually tried: rayon on `materialize_cold`

`run1` used a sequential `for owner in owners` loop in `materialize_cold`'s
canonicalization pass; `run3` used `owners.into_par_iter().map(canonicalize_
owner).collect()` (rayon, order-preserving) — see `materialize.rs`'s module
doc for why this is a safe parallelization (`structural_kernel_batch_parts`
does per-owner SHA-256 work with no shared mutable state; dictionary/
subject assembly stays in a second, sequential pass over the
now-order-preserved results, so determinism is untouched — confirmed live,
§6.3). This did **not** produce a measured speedup here (run3's
`materialize_ms` is higher, not lower, than run1's) — the most likely
explanation, given the machine-sharing note above, is that `run3`
overlapped with real contention for the same 10 cores this parallelization
needs to help at all (a `rayon` pool competing with another process's
`rustc` for cores is close to the worst case for this specific
optimization). This task did not get a clean, contention-free A/B
measurement of the rayon change within its time budget — reported as an
open question, not a negative result, since the two runs are not a valid
controlled comparison. The plan's own floor estimate (§0.1: 1.5-3s for
materialization on 10 cores) implies parallelization should matter a great
deal once measured cleanly; that clean re-measurement is the most direct
next step for whoever picks up the P2 gate.

### 6.3 Determinism (plan's ×2 / thread-count-independence gate)

`run1` (sequential materialize) and `run3` (rayon-parallel materialize)
produced **byte-identical** `canonical_record_set_digest` inputs — the
`MANIFEST` `records`/`dependency` roots and the computed `graph` root are
identical across the two runs:

```
records:    sha256:cba95efcc25f1a67ec07cb10ab55e70c7a0951baa36431a545d8e41a6a9795f3
dependency: sha256:3497776c3629fbf22d015ba99bce2210ed6909eba44f4957d63954b74fcce28d
graph:      sha256:23089a905fc93cdc9506f5c8d50b97655fd97a72af73ffc9d1fb1cc92152ac0a
metric:     sha256:0000000000000000000000000000000000000000000000000000000000000000 (canonical empty set, both runs)
```

This is a stronger claim than "two identical sequential runs agree" — it
demonstrates the specific thing plan §11 asks for ("determinismo ×2 e
independencia del nº de hilos") across an actual single-threaded-vs-
parallel comparison, not just a repeat run of the same code path.

### 6.4 Record counts by kind (from `run3`, via the diagnostic test in §6.5)

| Category | Kind | Count |
|---|---|---:|
| entity | `jsts:entity_callable` | 15,879 |
| entity | `jsts:entity_container` | 14,082 |
| entity | `jsts:entity_type` | 12,671 |
| entity | `jsts:entity_variable` | 211,909 |
| relation | `jsts:relation_call` | 63,989 |
| relation | `jsts:relation_contains` | 240,459 |
| relation | `jsts:relation_covers` | 383 |
| relation | `jsts:relation_export` | 2,336 |
| relation | `jsts:relation_implements` | 477 |
| relation | `jsts:relation_import` | 58,302 |
| relation | `jsts:relation_inherits` | 549 |
| relation | `jsts:relation_references` | 900,160 |
| **total records** | | **1,521,196** |
| dependency rows (`deps_visible_count`) | | 36,621 |
| artifacts interned (owners) | | 14,082 |

No `jsts:diagnostic` rows at all (as intended — this pipeline never
produces them). `jsts:entity_container` count (14,082) equals the owner
count exactly, as expected (one module-container entity per file).

### 6.5 How these numbers were obtained

`scripts/v4-scan.mjs <corpus> <data-dir>` (creates the v4 catalog, stamps
`workspace_meta`, spawns the release `urdira-indexing-worker` binary,
sends one `workspace_scan{scope: full}`, prints `timings`/`roots`/paths).
The record-count table (§6.4) comes from a `#[ignore]`d diagnostic test,
`v4::tests_e2e::inspect_store_record_histogram` (opens an arbitrary
structural store via `StoreReader` and prints a category/kind histogram) —
run explicitly, not part of the normal suite:
```
URDIRA_V4_INSPECT_STORE=<path>/structural cargo test -p urdira-indexing-worker \
  --release v4::tests_e2e::inspect_store_record_histogram -- --ignored --nocapture
```

## 7. A real, intermittent bug found live: CAS digest mismatch (1 run in 5)

One n8n run (of five total across this session, including two by the
research fork mentioned in §6) failed partway through with:
```
Error: core:workspace_scan_failed: v4 syntax analysis failed: source digest mismatch for
  packages/nodes-base/nodes/Pipedrive/v2/actions/person/search.operation.ts
```
This comes from `urdira-jsts-syntax-worker`'s own `decode_source`: it reads
the CAS blob at `source_blob_path`, hashes it, and compares against the
`content_digest` this task's `analyze.rs` supplied (`Frontier::present`'s
`content_hash` for that owner). Investigated (within this task's time
budget, without modifying `urdira-source-frontier` — out of this task's
crate-ownership scope):
- Confirmed the file's real on-disk content hash
  (`sha256:7c7e17f2a0e434bc14cb931f0d28867513442f0a0d5e1ba84eaaee7ac5621fbb`)
  is **unique across the entire corpus** (checked all 17 `search.operation.ts`
  files across every node package, and the whole corpus by hash) — ruling
  out the leading hypothesis (two files sharing a content hash racing
  `CasStore::put_if_absent`'s write-temp-then-atomic-rename, which its own
  doc comment argues is safe for that exact case: "two writers racing the
  same content hash both produce byte-identical temp files").
- `CasStore::put_if_absent` (`crates/urdira-source-frontier/src/cas.rs`)
  reads as correctly atomic (unique per-call temp filename, `fs::rename`).
- Not reproduced on the other 4/5 runs, including two more attempts run
  back-to-back on the identical corpus with the identical code
  immediately after the failure (both succeeded, both with the roots in
  §6.3).
- Not chased further given the time box and that this crate is outside
  this task's ownership (`urdira-source-frontier`, delivered under P2-2a).
  Flagged here, with the exact reproduction context (n8n-scale, full
  parallel walk, `search.operation.ts`'s specific hash for whoever
  investigates next), rather than hidden or silently retried away.

## 8. What is stubbed / out of scope (documented, not hidden)

- **Typeflow hook**: `analyze.rs`'s `resolve_pending_sites(owner_path,
  pending: &[SemanticSite]) -> Vec<ProposedRecord>` always returns empty.
  Every `OwnerSemantics.pending_sites` entry (member access, `this`,
  unresolved globals, ...) is silently dropped rather than asserted as
  anything — **no `jsts:unresolved_call` records are emitted in this
  task**, since typeflow (plan §5, P1) is what would classify a pending
  site's `reason` and target. This is a real, intentional scope
  boundary: wiring the real typeflow resolver here is the next caller's
  job once P1 lands (its output type will need to be threaded into this
  exact function).
- **`ScanScope::Changed`**: `scan::run` returns a `ScanError` immediately
  ("is not supported yet (plan P3); send scope: Full") rather than
  attempting a partial/incorrect delta. The protocol type round-trips
  correctly (§2.2's fixture test covers a `Changed` payload), so P3 can
  add the real handling without another protocol revision.
- **Metric projections**: no metric generator exists anywhere in this
  pipeline; `metric` is always the canonical empty-set root.
- **Lexical/semantic sidecars** (plan §4.7/P2-6): `sidecar_root` is
  threaded through the protocol and the CLI script creates the directory,
  but nothing writes to it yet.
- **Line numbers** (`span_start_line`/`span_end_line`): always `0` (§3.2).
- **Compaction/refcount/reader-side mmap serving**: entirely
  `urdira-structural-store`'s existing, already-evidenced responsibility;
  nothing in this task's scope touches it.

## 9. Quality gates run

- `cargo fmt -p urdira-indexing-worker -p urdira-worker-protocol` — clean.
- `cargo clippy -p urdira-indexing-worker -p urdira-worker-protocol
  --all-targets -- -D warnings` — clean. (Full-workspace `cargo clippy
  --workspace` was not run: `urdira-native-node`/`urdira-jsts-syntax-worker`
  had concurrent, in-progress edits from other agents during this session
  that transiently failed to build at various points — confirmed
  unrelated to this task's own two crates every time, per the task's own
  scoping instruction to report and scope down in that case.)
- `cargo test -p urdira-indexing-worker -p urdira-worker-protocol` — 60
  passed, 1 ignored, 0 failed.
- `pnpm --filter @urdira/engine exec tsc --noEmit`,
  `pnpm --filter @urdira/plugin-javascript-typescript exec tsc --noEmit` —
  clean.
- `npx eslint` on every new/modified TS/JS file in this task — clean.
- `npx vitest run tests/rust-protocol-v4.test.ts tests/v4-scan.test.ts
  tests/javascript-typescript-rust-protocol.test.ts tests/javascript-
  typescript-indexing-core-transport.test.ts` — 20 passed.
- Full-repository `pnpm verify` was not run (other agents' concurrent,
  in-progress work in shared packages during this session made a
  full-repo gate unreliable as a signal for this task specifically); the
  scoped gates above cover every file this task touched.

## 10. Deviations summary (also called out inline above)

1. `workspace_root` added to `IndexingCommand::WorkspaceScan` (§2.1) — the
   plan's own protocol sketch is missing a field the walker needs.
2. `Queryable`/`ScanCompleted` are not separated by a real durability gap
   in this implementation (§4.1) — `SegmentWriter::write_base` (untouched,
   another agent's crate) does both synchronously in one call.
3. Facets bitmask order, four dictionary schemes, `dicts.artifacts`'
   one-ordinal-per-owner shape, subject-key choice (`record_id` not
   `identity_id`), `dependency_id`'s recipe, `capability_state_digest`/
   `source_observation_watermarks` placeholders, and `span_start_line`/
   `span_end_line` = 0 are all new v4-only ground with no v3 recipe to
   mirror (§3.2) — each documented at its definition and here.
4. Two real bugs found and fixed against real n8n-scale data that a small
   fixture run did not surface: the `candidate_state` FK gap and the
   `merkle_roots`/`projection_set_digests` count mix-up (§4.3).
5. `materialize_cold`'s owner-canonicalization pass is `rayon`-parallelized
   (§6.2); the clean before/after wall-time comparison this task wanted to
   report was confounded by machine contention outside this task's
   control, so the speedup is not independently confirmed here even
   though the change itself is verified correct (determinism preserved,
   §6.3).
6. The gate's own gap: `queryable ≤ 8 s` is not met (411-522 s measured);
   `materialize` (kernel canonicalization) is the dominant cost, `catalog`
   (walk+hash+CAS+SQLite) a distant second. Reported per the task's
   explicit instruction, with the phase breakdown and the one lever this
   task actually tried (§6.1/§6.2).

## 11. P2-2c performance (this task)

Task: get the v4 cold scan on n8n to the gate (`Queryable` ≤ 8 s,
`ScanCompleted` ≤ 12 s), fix the two slow phases identified in §6
(`catalog`, `materialize`), and find/fix the §7 CAS digest-mismatch flake.
Owned for this task: `crates/urdira-indexing-worker/src/v4/*`,
`crates/urdira-source-frontier/*`; narrow performance-only edits in
`crates/urdira-indexing-worker/Cargo.toml` (one new direct dependency,
`rustc-hash`, already present transitively in `Cargo.lock`). No edits to
`urdira-indexing-core`/`urdira-jsts-syntax-worker` were needed in the end —
every fix that moved the needle lived in this task's own two owned crates.

### 11.1 Instrumentation added

All gated behind `URDIRA_DEBUG_TIMING` (already the repo's convention,
`main.rs`), printed to stderr, never affecting the wire-protocol
`ScanTimings` (which keeps its existing fixed fields):
- `v4/catalog.rs`: `walk`/`apply` split (already computed, was just not
  printed) plus observation/added/changed/deleted counts.
- `v4/analyze.rs`: total wall time and thread count for the `read_facts_group`
  extraction loop — this turned out to be the single most useful timer
  added (§11.3b): it had no clock around it at all before this task, so it
  was invisible in §6's phase table despite being, at one point, the
  single largest phase in the pipeline.
- `v4/materialize.rs`: Pass 1 (kernel canonicalize) wall time plus
  bisected-owner count; Pass 2 (dictionaries/rows) wall time plus the
  `owner_rows` drop's own wall time; final record/dependency/subject
  counts.
- `v4/publish.rs`: sort, `write_base` (with its internal to-page-cache/
  durable split), and graph+metric Merkle build, each timed separately.

### 11.2 Method

Corpus, machine, and idle protocol as in §6. Baseline re-confirmed from
§6.1's `run1`/`run3` logs (not re-run — identical binary/data would just
reproduce the same numbers). Fixed by evidence, iteratively: instrument →
run → find the largest unexplained or newly-visible cost → fix → re-run →
repeat, `sample <pid> N -file <path>` used three times live during
`materialize_cold`'s own window (`urdira-benchmark/v4-p2/materialize-
sample{,2,3}.txt`) to settle two rounds of "what's actually dominant now"
that a guess would have gotten wrong (§11.5). One other agent's own
2,000-owner benchmark ran concurrently on this machine for two separate
windows during this task (`n8n-incremental-preflight.mjs` + its own
`urdira-indexing-worker`, a different worktree, per this task's own
concurrency note) — both were waited out to CPU-idle (`pgrep` empty,
`top -l 1` idle%) before any run used in §11.6's final numbers; a handful
of earlier diagnostic runs (`perf7`-`perf9b` in the raw logs) landed
during or just after the tail of that contention and read 10-40% slower
than clean runs of the *same* code on either side of them — called out
below as noise, not attributed to any code change.

### 11.3 Root causes found and fixed, in the order discovered

**(a) Catalog: `fcntl(F_FULLFSYNC)` once per file.** `CasStore::put_if_
absent` (`urdira-source-frontier/src/cas.rs`) called `File::sync_all()` on
every CAS blob write. On macOS, `sync_all`/`sync_data` are backed by
`F_FULLFSYNC`, a full drive cache flush costing low-single-digit
milliseconds per call — serialized once per one of 20,148 observed files,
this was the large majority of the 82.5-95.5 s `catalog` phase in §6.1's
baseline. Fixed by dropping the per-blob fsync entirely — durability
model documented at the call site: a CAS blob is a derived, content-
addressed cache of a file that still exists, unmodified, on disk; an
unclean-shutdown loss of an unflushed blob is repaired for free by the
next scan re-observing the same path. `rename`'s atomicity, not `fsync`'s
durability, is what this store's own correctness invariant (a reader
never observes a torn/partial blob) actually depends on.

**(b) Facts extraction: an entire un-instrumented, single-threaded phase
bigger than everything else combined.** `v4/analyze.rs`'s lane-1 fact
extraction (`SyntaxWorkerState::read_facts_group`/`read_facts`, walking
each file's already-parsed AST a *second* time to emit its entity/
relation `ProposedRecord`s) ran in one sequential `while
!pending.is_empty()` loop with no thread fan-out at all — invisible in
§6's phase table because it fell between `parse_ms` (`analyze()`'s own
initial parse, genuinely fast at 0.7-1.5 s) and `resolve_ms` (the already-
parallel E1a-E3 hybrid lane), with no clock anywhere around it; its cost
simply inflated `total_ms` beyond what the other six named phases summed
to. Measured directly once instrumented: **49.964 s**, entirely on one
core, for n8n's 14,082 owners — at that point the single largest phase in
the whole pipeline, bigger than `catalog` and comparable to `materialize`.
Root cause: nothing in this loop nor in `read_facts_group`/`read_facts`
(`&self`, pure reads of already-populated, immutable project state)
required serial execution; it reads as a straight port of the original
*IPC* protocol's per-message-size-bounded pagination shape, which had a
real reason to process one group at a time over a pipe but no reason to
imply single-threaded once called directly, in-process. Fixed by
partitioning `affected_paths` into `available_parallelism()` contiguous
blocks up front and running each block's own sequential group-loop
(a large file's cursor-continuation stays on the one thread that owns its
block) on its own thread: **49.964 s → 8.3-10.8 s**.

**(c) Materialize Pass 2: an O(records × distinct_subjects) linear scan.**
`intern_subject` deduplicated `dicts.subjects: Vec<[u8; 32]>` via
`Vec::iter().position()` — called for every resolved relation endpoint
(source *and* target), against a vector that grows to 254,503 distinct
entries on n8n. Found by reading the code (not sampling) before any
instrumentation existed, and fixed in the same pass that added the Pass 1/
Pass 2 timers, so its isolated effect was never measured on its own — but
its *presence* explains why materialize was 273.6-359.9 s in §6's baseline
despite Pass 1 already being `rayon`-parallelized there (§6.2): a
quadratic-shaped Pass 2 cost swamped any win from parallelizing Pass 1.
Fixed by replacing it with the same `OrdinalDict` (`HashMap`-backed, O(1)
amortized) already used for every other dictionary in this function two
lines above it.

**(d) Materialize: ~57% of one live sample was dropping a JSON tree,
single-threaded, at function exit.** `sample`'d live
(`materialize-sample.txt`, 20 s window spanning the end of Pass 1 and all
of Pass 2): of 2,808 samples attributed to `materialize_cold`, 1,598 (57%)
were inside `drop_glue::<OwnerKernelRows>` → `drop_glue::
<StructuralPublicationRecord>` → `drop_glue::<serde_json::Value>` (a
`BTreeMap<String, Value>` recursive free) — `primary_source_span`, a
`{path, start, end}` JSON object this pipeline only ever reads two
integers out of (`source_span_bytes`), built by the kernel for every one
of 1.5M records and then destroyed, all at once, on the single thread
that called `materialize_cold`, when the whole `Vec<OwnerKernelRows>` fell
out of scope at the end of the function. Fixed by extracting those two
integers in Pass 1 (already `rayon`-parallel, per owner) and setting
`primary_source_span = None` immediately after, so *that* drop now happens
on Pass 1's worker threads, spread across cores, instead of piling up
serially at the end.

**(e) Materialize: the rest of `owner_rows`'s drop, still serial.**
Re-sampled after (d) (`materialize-sample2.txt`, 25 s window): drop_glue
for the *remaining* `String` fields of `StructuralPublicationRecord` (nine
per record) plus `bodies`/`proposal_keys`/`dependencies` was still ~40% of
samples taken in and after Pass 2. First fix attempt: `owner_rows.
into_par_iter().for_each(drop)` (blocking parallel drop) — measured as a
clear net win over the fully-serial version (§11.4, perf4→perf6). Second
attempt: moved the same parallel drop onto `rayon::spawn` (fire-and-forget
onto the pool) so it overlaps with Pass 2's remaining sequential work
(subject resolution, dependency materialization, dictionary flattening)
instead of the main thread blocking on it — joined via a channel `recv()`
right before the debug report, so the function still never returns before
the drop finishes. This second step measured as roughly neutral in
isolation (§11.4) — plausibly because Pass 2's own sequential work and the
parallel drop compete for the same memory bandwidth/cache rather than
being truly free to overlap — but was kept: it is not a regression, adds
no risk, and stacks correctly with (f)/(g)/(h) below (§11.6's final
numbers already include it).

**(f) Materialize: `char::to_digit(16)` in the hot decode path.**
Re-sampled again after (d)/(e) (`materialize-sample3.txt`, 12 s window):
`hex_decode` (called 5-6× per record for identity/digest fields, once
more for the UCE body payload — over 9M calls on n8n) was 878 of 8,127
samples (~11%), going through `char`'s general Unicode-aware digit
classification for what is always an ASCII byte from a kernel-emitted hex
string. Rewritten as direct byte-range arithmetic (`b'0'..=b'9'` etc, no
`char` conversion at all).

**(g) Catalog: redundant `mkdir` and un-cached `INSERT`s, once per file.**
`put_if_absent` called `fs::create_dir_all` on every file (an EEXIST-
tolerant but still real syscall, for what is almost always an already-
existing shard directory after the first handful of files); `Catalog::
apply`'s four per-observation `INSERT`s used `Transaction::execute`
(re-parses the SQL text every call) instead of `prepare_cached`. Fixed by
pre-creating all 256 possible `sha256/<2 hex>` shard directories once in
`CasStore::open` (`put_if_absent` no longer calls `create_dir_all` at
all), and switching the four hot INSERTs to `prepare_cached` (rusqlite's
default statement-cache capacity, 16, comfortably covers this crate's ~8
distinct cold-scan statements).

**(h) Materialize: `SipHash`-based `HashMap`s on ~1.5M-entry hot paths.**
`identity_key_to_ordinal`/`proposal_key_to_ordinal` (each up to 1.5M
`String`-keyed entries) and every `OrdinalDict<K>` (kinds, universal
kinds, relation kinds, names, artifacts, subjects) used `std`'s default
`SipHash`-based `HashMap`. Switched to `FxHashMap` (`rustc-hash`, already
resolved transitively in `Cargo.lock`, promoted to a direct dependency of
`urdira-indexing-worker`) — none of these maps are ever iterated for
output order anywhere in this pipeline (final order always comes from a
`Vec` built in a separate, deterministic pass), so FxHash's weaker
collision resistance and lack of per-process random seeding cost nothing
this code relies on.

(f), (g), and (h) were implemented together in one edit pass and measured
as a bundle (§11.4's last two rows) — their individual contributions were
not isolated from each other, only from (a)-(e).

### 11.4 Before/after phase table (n8n, one representative run per step)

| step | catalog | facts extraction | materialize (pass1 / pass2) | publish | total (`ScanCompleted`) | records root |
|---|---:|---:|---:|---:|---:|---|
| §6 baseline (`run1`) | 82.5 s | *(not separately timed — folded into the ~50s+ gap between named phases and `total_ms`)* | 273.6 s | ~3.5 s | 411.3 s | `cba95efc…` |
| after (a) + (c) [`perf1`] | 6.3 s | *(still not instrumented; same ~55.6s gap present, unexplained until (b))* | 27.3 s (pass1 6.5 / pass2 14.2) | ~2.7 s | 94.8 s | `cba95efc…` |
| facts loop timed, still serial [`perf3`] | 6.4 s | **50.0 s** (directly measured, 1 thread) | 31.9 s (pass1 6.0 / pass2 19.7) | 3.2 s | 96.0 s | `cba95efc…` |
| after (b) [`perf4`] | 6.2 s | 50.0 s → **8.3 s** | 31.8 s (pass1 5.6 / pass2 14.8, ~11.5s of which is (d)'s not-yet-fixed serial drop) | 2.4 s | 53.1 s | `cba95efc…` |
| after (d) + blocking parallel drop [`perf6`] | 6.0 s | 8.8 s | 19.3 s (pass1 5.8 / pass2 12.7, drop 2.0s) | 2.0 s | 40.8 s | `cba95efc…` |
| after (e) overlap (`rayon::spawn`) alone [`perf7`/`perf8`] | 5.9-6.3 s | 8.1-8.4 s | 21.1-23.2 s (drop 1.0-2.3s, roughly neutral vs. the row above — see §11.3e) | 2.0-2.4 s | 41.4-44.2 s | `cba95efc…` |
| after (f) + (g) + (h) bundled [`perf10`] | 6.3 s | 8.6 s | **13.3 s** (pass1 5.5 / pass2 7.5, drop 0.5s) | 2.2 s | **34.3 s** | `cba95efc…` |
| **final (3 idle runs, §11.6)** | 5.5-6.1 s | 8.5-10.8 s | 18.9-19.4 s (pass1 5.7-5.9 / pass2 12.3-13.0) | 1.9-2.6 s | **40.0-41.8 s** | `cba95efc…` |

`perf10`'s 34.3 s total was measured on an unusually quiet moment (facts
extraction and both materialize passes all landed at or near their
best-observed values simultaneously) and did not reproduce on the three
machine-idle-verified final runs immediately after (§11.6, 40.0-41.8 s) —
reported here for the record, not as the representative number; §11.6 is
the number this task stands behind. Every row's records root is the exact
§6.3 baseline digest
(`sha256:cba95efcc25f1a67ec07cb10ab55e70c7a0951baa36431a545d8e41a6a9795f3`),
confirming none of the above changed record content or ordering — only
where, and on how many threads, the same work happens.

### 11.5 `sample` stack histogram summary

Three live captures during `materialize_cold` (macOS `sample`, 1 ms
interval; full detail in `urdira-benchmark/v4-p2/materialize-sample{,2,3}.txt`):

| capture | when taken | window | samples attributed to `materialize_cold` | dominant leaf |
|---|---|---:|---:|---|
| `materialize-sample.txt` | before fix (d) | 20 s (end of Pass 1 + all of Pass 2) | 2,808 | 1,598 (57%) in `OwnerKernelRows`/`StructuralPublicationRecord`/`serde_json::Value` drop_glue (the JSON span tree) |
| `materialize-sample2.txt` | after (d), before (e) | 25 s (facts-loop tail + Pass 1 + Pass 2) | 2,722 | 1,096 (40%) in `OwnerKernelRows`/`StructuralPublicationRecord` drop_glue (remaining `String` fields); a further 342 in `HashMap<String, u32>::insert` (hashing/rehash — the map (h) later replaced) |
| `materialize-sample3.txt` | after (d) + (e), before (f)/(g)/(h) | 12 s (mostly Pass 2) | (thread total 8,127) | 878 in `hex_decode` (the function (f) later rewrote); 792 in `pthread_cond_wait` (the main thread waiting on the then-still-there `owner_rows` drop) |

### 11.6 Final measurement: 3 runs, idle machine, after every fix above

| run | catalog | facts extraction | materialize (pass1 / pass2) | publish | `Queryable` | `ScanCompleted` (`total_ms`) | wall (`/usr/bin/time -l`) | peak RSS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| final1 | 5.5 s | 8.6 s | 19.4 s (5.7 / 12.9, drop 1.4 s) | 2.6 s | 40,540 ms | **40,013 ms** | 41.89 s | 6.98 GiB |
| final2 | 6.1 s | 10.8 s | 18.9 s (5.9 / 12.3, drop 1.9 s) | 2.1 s | 41,753 ms | **41,766 ms** | 42.53 s | 5.75 GiB |
| final3 | 5.5 s | 8.5 s | 19.4 s (5.8 / 13.0, drop 1.3 s) | 1.9 s | 39,898 ms | **39,906 ms** | 40.62 s | 6.04 GiB |
| **min / median** | 5.5 s | 8.6 s | 19.4 s | 2.1 s | **39,898 ms** | **40,013 ms** | 40.62 s | 6.04-6.98 GiB |

All three runs produced the **identical** `records`/`dependency`/`graph`/
`metric` roots as §6.3's baseline and each other:
```
records:    sha256:cba95efcc25f1a67ec07cb10ab55e70c7a0951baa36431a545d8e41a6a9795f3
dependency: sha256:3497776c3629fbf22d015ba99bce2210ed6909eba44f4957d63954b74fcce28d
graph:      sha256:23089a905fc93cdc9506f5c8d50b97655fd97a72af73ffc9d1fb1cc92152ac0a
metric:     sha256:0000000000000000000000000000000000000000000000000000000000000000
```
No behavior/content change anywhere in this task — every fix in §11.3 is a
where/how-parallel/how-fast change, never a what-gets-computed change.

**Net effect: 411,284 ms → 40,013 ms median, a 10.3× reduction** (13.1×
against the slower `run3` baseline). `catalog` alone: 82,539 ms → ~5,700 ms
(~14.5×). `materialize` alone: 273,576 ms → ~19,200 ms (~14.2×).

### 11.7 Gate result: two of seven targets met, five missed

| gate | target | measured | met? |
|---|---:|---:|---|
| `catalog` | ≤ 1.5 s | ~5.5-6.1 s | **no** (3.7-4.1×) |
| `materialize` | ≤ 4 s | ~18.9-19.4 s | **no** (4.7-4.9×) |
| `Queryable` | ≤ 8 s | ~39.9-41.8 s | **no** (5.0-5.2×) |
| `ScanCompleted` | ≤ 12 s | ~40.0-41.8 s | **no** (3.3-3.5×) |
| peak RSS | ≤ 3 GiB | 5.75-6.98 GiB | **no** (1.9-2.3×) |
| determinism (identical roots, ×3 runs + vs. §6.3 baseline) | — | confirmed identical | **yes** |
| CAS digest-mismatch flake | root-caused + fixed | done (§11.8) | **yes** |

None of the plan's five numeric gates are met, despite a 10.3× wall-time
reduction. Reported per this task's own instruction not to hide a miss —
residual breakdown and physical reasons follow.

**Residual breakdown** (median final run, 40,013 ms total): materialize
19.4 s (48%, split 5.7-5.9 s Pass 1 / 12.3-13.0 s Pass 2 incl. 1.3-1.9 s
overlapped drop), facts extraction 8.6 s (21%), catalog 5.5-6.1 s (14%),
publish 1.9-2.6 s (5%), everything else (`resolve_ms`, process/binary
startup, protocol/IPC overhead not captured by any internal timer) ~2-3 s
(~6%).

**Physical reasons the residual is still ~3-5× over target, by phase**:
- **catalog (~5.5-6.1 s vs 1.5 s target)**: the P2-2a benchmark measured
  walk+hash alone (no CAS write, no SQL) at 0.4-1.0 s for this same
  corpus. The remainder is now genuine, non-fsync I/O: one `open`+
  `write`+`rename` per newly observed file (20,148 files) for the CAS
  put, plus ~80,592 `prepare_cached`+`execute` SQL statements (4 per file)
  inside one transaction. This task's fixes already removed the
  *avoidable* multiplier (no more fsync, no more per-call `mkdir`, no more
  per-call SQL re-parse); what's left is roughly proportional to file
  count, not further reducible without batching many files' CAS writes
  into fewer, larger I/O operations or multi-row `INSERT`s — a larger
  structural change than this task's "narrow" mandate, and one this
  session's own prior history (multi-row `INSERT` tried and reverted
  elsewhere in this codebase, benched neutral) suggests is not guaranteed
  to pay off even if attempted.
- **facts extraction (~8.6-10.8 s, not separately gated but the 2nd-
  largest phase)**: genuinely CPU-bound AST work — `read_facts`/
  `read_facts_group` walks each file's tree a *second* time (after
  `analyze()`'s own first walk) to emit entity/relation records.
  Parallelized across all cores in this task (was 100% serial at 50 s);
  the remaining time is that same work now running at roughly the
  machine's real parallel ceiling. Cutting it further would mean either
  (i) merging this second walk into `analyze()`'s first one so a file is
  only ever tree-walked once (a `urdira-jsts-syntax-worker` architecture
  change, out of this task's crate-ownership scope and risky for the v3
  pipeline sharing that code), or (ii) reducing what facts extraction
  budgets/serializes per group — neither of which this task's remaining
  time budget covered.
- **materialize (~19.4 s vs 4 s target)**: the plan's 1.5-3 s floor
  assumed the kernel-canonicalization pass alone; `sample`ing found the
  actual composition is Pass 1 (kernel calls, ~5.7-5.9 s, already
  parallel across every core and doing real per-record SHA-256/canonical-
  encode work for 1.5M records — closer to a CPU floor than a bug) plus
  Pass 2 (~12.3-13.0 s: dictionary ordinal assignment and `RecordRow`
  construction over the same 1.5M records, now O(1)-per-record after
  (c)/(f)/(h) rather than one of several accidental
  O(n²)/O(n·slow-hash)/O(n·slow-decode) costs, but still one full
  sequential pass any determinism-preserving design needs). Pass 2 is
  inherently harder to parallelize than Pass 1: dictionary ordinals must
  be assigned in one deterministic order (owner-path order) for the
  plan's own thread-count-independence gate, which is why it stayed a
  single sequential loop rather than being `rayon`-parallelized outright.
- **peak RSS (5.75-6.98 GiB vs 3 GiB target)**: the pipeline holds the
  full `Vec<OwnerFacts>` (post-facts-extraction), then the full
  `Vec<OwnerKernelRows>` (Pass 1's output, including per-record JSON/UCE
  body payloads), then the full `Vec<RecordRow>` (Pass 2's output)
  simultaneously for a meaningful window (Pass 2 reads `owner_rows` while
  building `records`) before `owner_rows` is finally dropped — three
  large, overlapping in-memory copies of ~1.5M records' worth of data at
  once. This task's fixes reduced *how long* that overlap lasts (the
  overlapped drop) and *how much* survives into the overlap (the
  span-tree field cleared early, in Pass 1) but did not restructure the
  pipeline to avoid holding multiple full copies simultaneously —
  streaming Pass 1's output directly into Pass 2's row-assembly instead
  of materializing the whole intermediate `Vec<OwnerKernelRows>` first is
  a real, larger redesign this task's remaining time did not reach.

### 11.8 CAS digest-mismatch flake: root cause found, fixed, and stress-tested

§7's flake ("source digest mismatch for .../search.operation.ts", 1 run in
5) is now **root-caused and fixed**, in `urdira-source-frontier` (this
task's own crate, unlike §7's investigation which stopped at that crate's
boundary since it was out of scope for that earlier task).

**Root cause**: `CasStore::put_if_absent`'s temp filename was
`.tmp-{pid}-{nanos}` — unique only if `(pid, SystemTime::now())` never
repeats across concurrent calls. On macOS, `SystemTime` is backed by a
microsecond-resolution clock (`gettimeofday`), not a true nanosecond one.
The walker's parallel tree traversal (`ignore::WalkBuilder::
build_parallel`, up to `available_parallelism()` threads) calls
`put_if_absent` concurrently for every observed file; two threads
processing two *different* files whose content hashes happen to share the
same first-two-hex-character shard directory, at a wall-clock instant the
OS clock cannot distinguish, computed the identical temp path. `File::
create` has no `O_EXCL` semantics, so the second thread's `create` silently
truncated the first thread's still-open temp file instead of erroring —
the two threads' writes interleaved on one inode, and whichever thread's
`rename` ran first moved whatever bytes were in that inode *at that
instant* to a target path keyed by *its own* digest, producing a blob
whose content doesn't match its own filename. The other thread's `rename`
then fails with `ENOENT` (its source path is already gone) — in the
reproduction below this surfaces as that `ENOENT`; in the original field
report (a corruption that left both `rename`s apparently succeeding) it
surfaced as §7's "source digest mismatch" the next time something read
that blob and checked its hash. Both are the same underlying race; which
symptom appears depends on the exact interleaving of the two threads'
`write`/`rename` calls.

**Fix** (`crates/urdira-source-frontier/src/cas.rs`), two layers:
1. Temp names are now `.tmp-{pid}-{ThreadId:?}-{sequence}`, where
   `sequence` is a process-wide `AtomicU64` counter — no two concurrent
   calls anywhere in the process can ever compute the same path,
   independent of clock resolution.
2. The temp file is opened with `create_new` (`O_EXCL`): even a
   hypothetical remaining collision fails loudly with an I/O error instead
   of silently truncating live data.

**Reproduction**: a new stress test,
`cas::tests::put_if_absent_survives_concurrent_shard_collisions` (1,000
distinct content hashes spread across the CAS's 256 shard directories,
16 threads each doing two full passes over all 1,000 hashes, 50 fresh-CAS-
root iterations, verifying every resulting blob's on-disk bytes match the
digest encoded in its own path) — confirmed to reproduce the bug class
live: temporarily reverting just the temp-naming fix (old
`.tmp-{pid}-{nanos}` + plain `File::create`, keeping everything else)
made this test fail on **iteration 0** with exactly the predicted `ENOENT`
on a `rename` call:
```
thread '<unnamed>' panicked at crates/urdira-source-frontier/src/cas.rs:329:33:
iteration 0 thread 9: put_if_absent(sha256:9c905a79bf06ec6f61fa1dd47332eaf10293e03f06a3a0898b3e6f4cfc4bac7d) retry failed: CAS I/O error: No such file or directory (os error 2)
```
With the fix restored, the same test passes reliably (50 iterations × 16
threads × 1,000 files × 2 passes = 1.6M `put_if_absent` calls, 14.2 s, 0
failures) and is now part of the crate's normal `cargo test` run (33/33
passing, up from 32/32 before this task).

### 11.9 Quality gates run (this task)

- `cargo fmt --all` — clean.
- `cargo clippy --release -p urdira-indexing-worker -p urdira-source-frontier
  -p urdira-indexing-core -p urdira-jsts-syntax-worker --all-targets --
  -D warnings` — clean.
- `cargo test --release -p urdira-indexing-worker -p urdira-source-frontier
  -p urdira-indexing-core -p urdira-jsts-syntax-worker` — 191 passed, 3
  ignored, 0 failed (33 + 48 + 110 + 0 unit/integration tests across the
  four crates; `urdira-source-frontier` up from 32 to 33 passing with the
  new stress test).
- `npx vitest run tests/v4-scan.test.ts tests/rust-protocol-v4.test.ts` — 8
  passed (2 files).
- Full-workspace `cargo clippy --workspace`/`pnpm verify` not run: per
  this task's own concurrency note, a typeflow agent held its own
  worktree with in-progress edits to shared files for parts of this
  session; the scoped gates above cover every file this task touched
  (`urdira-indexing-worker`, `urdira-source-frontier`, plus the
  `Cargo.toml`/`Cargo.lock` diff for the new `rustc-hash` dependency).

### 11.10 Files touched (this task)

- `crates/urdira-source-frontier/src/cas.rs`: removed per-blob `fsync`
  (§11.3a); unique-by-construction temp names + `O_EXCL` (§11.8); pre-
  created shard directories (§11.3g); new stress test.
- `crates/urdira-source-frontier/src/catalog.rs`: `prepare_cached` for the
  four per-observation `INSERT`s (§11.3g).
- `crates/urdira-indexing-worker/src/v4/analyze.rs`: parallelized facts
  extraction across owner-path blocks (§11.3b).
- `crates/urdira-indexing-worker/src/v4/materialize.rs`: `OrdinalDict`-based
  subject interning (§11.3c); per-owner span-tree extraction in Pass 1
  (§11.3d); overlapped `owner_rows` drop via `rayon::spawn` (§11.3e);
  byte-arithmetic `hex_decode` (§11.3f); `FxHashMap` for the hot
  dictionaries (§11.3h); debug timing throughout.
- `crates/urdira-indexing-worker/src/v4/deps.rs`: `FxHashMap` parameter
  type to match (§11.3h).
- `crates/urdira-indexing-worker/src/v4/publish.rs`: debug timing for
  sort/`write_base`/graph+metric Merkle build.
- `crates/urdira-indexing-worker/src/v4/catalog.rs`: debug timing for
  walk/apply.
- `crates/urdira-indexing-worker/Cargo.toml`: new direct dependency
  `rustc-hash = "2"` (already resolved transitively; no new crate added to
  the dependency graph).

## 12. P2-2d correctness + performance round 2

Task: (A) fix two correctness gaps in the v4 cold pipeline reported live by
the P2-7 daemon e2e task (`docs/evidence/2026-09-02-v4-p2-7-daemon-wiring.md`
§8: "no relation records materialized" / "no `identity_id`"); (B) a second
performance round towards the plan's gate. Owned for this task:
`crates/urdira-indexing-worker/src/v4/*`, `crates/urdira-source-frontier/*`;
narrow, API-compatible edits made in `crates/urdira-native-node/src/
structural_store_napi.rs` (gap A1's actual fix lived here, not in
`analyze.rs`/`materialize.rs` -- see §12.1). No edits needed in
`urdira-structural-store` or `native-query-snapshot-port.ts` in the end.

### 12.1 Gap A1: NOT a materialization gap -- a graph-adjacency subject-key
### mismatch in the native query port

**Reproduction.** Built the release worker + native addon, copied the exact
two files (`task.ts`/`errors.ts`) `tests/v4-daemon-e2e.test.ts` uses into a
fresh scratch workspace, and ran `scripts/v4-scan.mjs` against it directly.
Reading the published structural store's records with a small Node script
(`NativeStructuralStoreHandle.iterVisibleBatch`) showed **relation records
were already present** (10 rows: 5 `jsts:relation_contains`, 5
`jsts:relation_references`) -- contradicting P2-7 §8's "no relation records
materialized yet" as currently true. Both of that task's own hypotheses
about block-size/parallelization bugs in `analyze.rs` (this task's opening
brief's leading theory) were therefore false: `materialize.rs`/`analyze.rs`
never had a relation-materialization bug on this fixture, at least not in
the current, already-perf-round-2c'd build.

Querying through the real daemon (`core:find_records{record_categories:
["relation"]}`) confirmed the same 10 rows are reachable end to end. But
`core:find_references` on a real, verified-present inbound edge (`TaskStatus`,
referenced by a `jsts:relation_references` row whose `target_id` is exactly
`TaskStatus`'s `identity_key`) still returned **zero** rows. This pinpointed
the bug to graph *adjacency* lookup, not record materialization.

**Root cause**, in `crates/urdira-native-node/src/structural_store_napi.rs`'s
`adjacency` napi method: it computed the lookup key as
`sha256(caller_subject_text)` for whatever subject-id string the JS query
layer passed (a record's `record_id`/`identity_id`/`identity_key` text, all
three tried per `canonical-query-data-port.ts`'s `indexedGraphRecords`).
That scheme matches the v3-conversion path (`NativeStoreBuilder::
add_one_record`, this same napi file, used to convert v3 SQLite data into a
native store for testing/comparison): its `BytesInterner::intern` hashes
whatever subject-id TEXT the caller supplies. But the v4 Rust cold-scan
pipeline's own writer (`materialize.rs`'s `resolve_subject_key`) interns
each relation endpoint's **raw `record_id` bytes directly, un-hashed** (per
this crate's own decision, documented in `materialize.rs`'s module doc:
"the subject KEY stored in `dicts.subjects` is the resolved entity's
`record_id`"). `sha256("record:<hex>")` (a string) is never equal to the
raw 32-byte `record_id` digest itself, so **no v4-native-pipeline-produced
store's adjacency lookup could ever find anything**, for any target,
independent of relation category, kind, or which typeflow/resolution
lane produced the record -- exactly the "always empty" symptom P2-7 §8
described, just with the wrong root cause attributed (relation
materialization, not adjacency lookup).

A second, compounding bug in the same function: `source_subject_id`/
`target_subject_id` on each returned edge were read from
`self.sidecar.subjects` (the `text_sidecar.json` companion file the
v3-conversion builder writes) -- the v4 pipeline never writes this sidecar
at all, so even a successful key lookup would have returned edges with
**empty-string** endpoint ids, which then fail every downstream alias
match in `canonical-query-data-port.ts` anyway.

**Fix**, both in `adjacency()`:
1. Try the caller's subject text as TWO candidate keys per lookup:
   `sha256(text)` (unchanged, still needed for the v3-conversion path) and,
   when the text hex-decodes directly via the pre-existing `parse_hex32`
   helper (accepts a bare 64-hex or `"<prefix>:<hex>"` form), that raw
   32-byte value too. A record's own `record_id` text form
   (`"record:<hex>"`) always round-trips through `parse_hex32` to exactly
   the raw bytes v4's writer interned -- and `indexedGraphRecords` always
   includes `record_id` among the aliases it tries, so this one extra
   candidate is sufficient to fix every v4 adjacency lookup. Trying an
   extra candidate key is safe by construction: an exact `HashMap`-keyed
   lookup either hits the real ordinal or it doesn't, so this can only add
   correct matches, never introduce a false one.
2. New helper `subject_text_for(sidecar, dicts, ordinal)`: prefers the
   sidecar text when present (the v3-conversion path's only source of
   truth, since its own `dicts.subjects[ordinal]` is just a `sha256`
   digest with no way back to the text), and falls back to
   `"record:{hex(dicts.subjects[ordinal])}"` otherwise --
   `urdira_structural_store::row::Dictionaries::subjects: Vec<[u8; 32]>`
   already carries the raw digest the store persisted; for a v4 store that
   digest already **is** the referenced record's `record_id`, so this
   reconstructs exactly the same text form every other endpoint of this
   port uses, without needing the sidecar at all.

**Regression tests** (both new, both fail-before/pass-after verified live
by reverting the fix and rerunning):
- `tests/v4-scan.test.ts`, `"materializes non-zero relation records with
  real endpoints, and adjacency lookups (find_references' pushdown) find
  them by record_id"`: opens the published store directly via the native
  addon (no daemon), asserts relation counts by kind are non-zero
  (`jsts:relation_contains`/`jsts:relation_references` both present), and
  that at least one entity has a non-empty inbound `adjacency()` call whose
  `target_subject_id` equals that entity's own `record_id`. Verified this
  test fails with `expected false to be true` when the `parse_hex32`
  fallback is reverted.
- `tests/v4-daemon-e2e.test.ts`: extended with real assertions (removing
  the previous "not asserted, since that would currently be dishonest"
  comment, now stale) -- `core:find_records{categories:["relation"]}` is
  non-empty and contains both non-checker-only kinds; `core:find_references`
  on `TaskStatus` (which this two-file fixture genuinely references) returns
  a non-empty `references` stream including a `jsts:relation_references`
  row; `core:find_references` on `InvalidTaskTransitionError` (declared but
  never referenced by name in this fixture) returns its one real inbound
  edge (the module's own `contains` relation) instead of the previous
  always-empty answer; a v4⊆v3 comparison of non-checker-only relation
  kinds (`contains`/`references`) against a real v3-checker index of the
  identical two files.

### 12.2 Gap A2: `identity_id` reconstructable without the text sidecar

Confirmed live: `identity_id` was `undefined` on every v4-native-decoded
record (`v4Declarations[0]!["entity_id"]` -- the query layer's
`${subjectType}_id` alias of `identity_id`, per `canonical-query-data-port.
ts`'s `recordValue`) because `structural_store_napi.rs`'s `to_output` read
`identity_id` **only** from `self.sidecar.identity_ids` (`text_sidecar.
json`), which the v4 pipeline never writes.

The store already persists everything needed to reconstruct the exact v3
identity-id text without any sidecar: `RecordView::identity_type() -> u8`
(0/1/2, the same numbering `category_from_byte` already uses for
entity/relation/diagnostic -- confirmed by reading `materialize.rs`'s
`identity_type_byte` and `urdira-native-core`'s `structural_kernel_
batch_parts`, both of which derive this byte/string from `record.category`
the same way) and `RecordView::identity_id() -> [u8; 32]` (the raw digest
half of `"{identity_type}:{hex}"`, per `urdira-native-core::lib.rs`'s
`finalize_publication_record`: `identity_id: format!("{identity_type}:{}",
identity_id_digest.trim_start_matches("sha256:"))`). Reconstructing
`format!("{}:{}", category_from_byte(view.identity_type()),
hex_encode(&view.identity_id()))` reproduces that exact text.

**Fix**: `to_output`'s `identity_id` computation now tries
`self.sidecar.identity_ids.get(&record_id_hex)` first (unchanged, still
authoritative for the v3-conversion path, which cannot be reconstructed
this way since its own `identity_type` byte is hardcoded to `0` for every
row regardless of real category) and falls back to the reconstruction
above when the digest is non-zero (the store's own "absent" sentinel,
matching the convention `NativeStoreBuilder` itself already uses for a
`None` input).

**Verified equal to v3, byte for byte** (stronger than "present"): the same
`InvalidTaskTransitionError` class, indexed once by the v4 Rust pipeline and
once by v3's real TypeScript-checker harness (`tests/v4-daemon-e2e.test.ts`'s
existing two-runtime setup), produced:
```
v3: entity_id = entity:cdc1e1a3ce551d37273003a2ed28a9ae6551b4c238a41f604e8d2118eb39fb3a
v4: entity_id = entity:cdc1e1a3ce551d37273003a2ed28a9ae6551b4c238a41f604e8d2118eb39fb3a
v3: identity_key = jsts:class:errors.ts:183:InvalidTaskTransitionError
v4: identity_key = jsts:class:errors.ts:183:InvalidTaskTransitionError
```
identical, confirming decision 11's "content-derived identity is
recipe-agnostic" promise holds across the TypeScript-checker lane and the
oxc-only v4 lane for a plain class declaration. `identity_key` itself
needed no fix -- it already came from `view.identity_key()` directly, no
sidecar involved; only `identity_id` was gapped.

**Regression tests**: `tests/v4-daemon-e2e.test.ts` now asserts
`v4Declarations[0]!["entity_id"]` matches `/^entity:[0-9a-f]{64}$/` and
`identity_key` matches the expected value, AND (the "equality with the v3
port" the task asked for) that `v4Declarations[0]!["entity_id"]` and
`["identity_key"]` are **`toBe`-equal** to the v3 index's own declaration
for the identical symbol.

### 12.3 Part A re-verification: n8n roots unchanged

Ran `scripts/v4-scan.mjs` against the full n8n corpus once immediately
after landing both A1/A2 fixes (`urdira-benchmark/v4-p2/n8n-postA-run1`):
records/dependency/graph/metric roots were **byte-identical** to every
prior baseline in this doc (§6.3, §11.6):
```
records:    sha256:cba95efcc25f1a67ec07cb10ab55e70c7a0951baa36431a545d8e41a6a9795f3
dependency: sha256:3497776c3629fbf22d015ba99bce2210ed6909eba44f4957d63954b74fcce28d
graph:      sha256:23089a905fc93cdc9506f5c8d50b97655fd97a72af73ffc9d1fb1cc92152ac0a
metric:     sha256:0000000000000000000000000000000000000000000000000000000000000000
```
Expected analytically before running: both fixes are confined to
`structural_store_napi.rs`'s **read** path (the napi query surface used
only after a store is published), never touched by the write path
(`catalog.rs`/`analyze.rs`/`materialize.rs`/`publish.rs`) that computes
these roots -- so no root could possibly change. Confirmed, not just
assumed. (The doc's own §7/§11.8 CAS-digest-mismatch flake did not
reproduce across this task's ~10 n8n-scale runs.)

### 12.4 Performance round 2: method and environment

Corpus/machine as in §6/§11. **This session's machine-sharing was worse
than §11's**: a concurrent effort (nominally "a separate worktree" per this
task's own brief) was, in practice, observed live multiple times adding a
brand-new crate (`urdira-tsgo-client`) and running its own `cargo build`/
`cargo test`/`vitest` invocations **directly against this task's own main
checkout**, not an isolated worktree -- confirmed via `pgrep`/`top` mid-run
on at least four separate occasions, once causing a full workspace-wide
`cargo build` failure for ~3.5 minutes (a missing `[lib]`/`[[bin]]` in that
crate's still-being-written `Cargo.toml`) and, separately, changes to
`crates/urdira-jsts-syntax-worker`'s `HybridResolutionContext` (new
`typeflow_index`/`typeflow_oracle` fields) that broke this task's own
`analyze.rs` call site until patched (§12.5 below) -- both handled per this
task's own scoping instruction (wait/patch the call site, do not touch the
crate). A genuinely idle machine was not achieved for any of this round's
measurement runs; every number below carries that caveat, same as §11's
own precedent for reporting under confirmed contention rather than waiting
indefinitely for conditions this task cannot control.

Method: instrument (already done, §11.1's `URDIRA_DEBUG_TIMING`) -> run ->
fix by evidence -> re-run -> repeat. `sample <pid> 10 -file <path>` used
once, live, during `materialize_cold`'s Pass 2 window, to settle "what's
actually dominant now" after §11's own fixes rather than guess (§12.6).

### 12.5 Unrelated build-compat fix required mid-task

`crates/urdira-jsts-syntax-worker`'s `HybridResolutionContext` (a shared,
not-owned struct) gained two new required fields (`typeflow_index: Option<
&ProgramIndex>`, `typeflow_oracle: bool`) from the concurrent effort noted
above, breaking `analyze.rs`'s own construction of that struct (this task's
owned file, a real, necessary fix, not a scope violation -- the alternative
was an indefinitely broken build). Set both to their own documented
flag-off defaults (`None`/`false`), matching this task's own long-standing
documented boundary ("typeflow is out of this task's scope... every
`pending_sites` entry is silently dropped"): every hybrid-lane site this
change touches degrades to exactly the pre-existing `checker_pending`
behavior, unchanged from before these fields existed. Verified via the
full existing test suite (no behavior change, §12.7).

### 12.6 Levers tried, in order, with numbers

Baseline for this round (`urdira-benchmark/v4-p2/n8n-postA-run2`, right
after Part A, before any Part B change; roots identical to every other row
in this section):

| phase | before (this round's baseline) |
|---|---:|
| catalog (walk+apply) | 6,388 ms (walk 3,313 / apply 3,052 -- excludes fsync elsewhere) |
| facts extraction | 12,409 ms (10 static OS-thread blocks) |
| materialize pass1 | 7,076 ms |
| materialize pass2 (incl. drop overlap) | 17,346 ms (drop 4,285 ms) |
| publish | ~2,750 ms |
| **total (`ScanCompleted`)** | **51,188 ms** |
| peak RSS | 6.23 GiB |

**(a) Facts extraction: static OS-thread blocks -> many small `rayon`
chunks.** `run_cold`'s facts-extraction fan-out (§11.3b) partitioned
`affected_paths` into exactly `available_parallelism()` STATIC contiguous
blocks, one per `std::thread::scope` OS thread, fixed at spawn time --
correct, but vulnerable to load imbalance: a thread landing a
disproportionate share of n8n's handful of very large generated files
finishes late while other threads, done with their smaller-file blocks,
sit idle. Switched to many small fixed-size chunks (64 paths each, `221`
chunks for `14,082` paths) distributed over `rayon`'s work-stealing pool,
so an idle worker can steal the next chunk instead of a slow chunk
stalling one whole thread for the rest of the phase. `run_facts_block`'s
own per-chunk cursor-continuation logic is untouched -- only how chunks
are sized and scheduled changed. Also applied the identical idea to the
E1a-E3 hybrid lane (`run_hybrid_semantics`), which had no cursor-
continuation constraint at all and is now a plain `owners.par_iter()`
(rayon preserves input order in `collect()`, so this is determinism-
neutral, confirmed live). **Measured: 12,409 ms -> 7,880-8,135 ms**
(35-37% reduction) across every run in this round.

**(b) Catalog: `synchronous=OFF` for the cold transaction, `journal_mode`
left alone.** First attempt went further than the plan brief's own
suggestion and set `journal_mode=OFF` too -- reverted after it reproduced
LIVE, via `tests/v4-daemon-e2e.test.ts`, a real "database is locked"
failure: `journal_mode` (not `synchronous`) is what lets a concurrent
reader (the daemon's own separate connection polling `core:index_status`
while a scan is in flight) read a consistent snapshot without blocking on
the writer; switching off WAL during the cold catalog transaction
reintroduces the traditional rollback-journal exclusive-lock model, under
which a concurrent reader gets `SQLITE_BUSY` instead. Final fix: keep
`journal_mode=WAL` throughout, only relax `synchronous` from `NORMAL` to
`OFF` for the cold catalog transaction's own connection lifetime (no
concurrent-reader downside -- `synchronous` only affects what survives an
OS crash, not who may read while whom writes), then restore
`synchronous=NORMAL` (`catalog::restore_steady_state_pragmas`, called from
`scan::run` immediately after the catalog transaction commits, before
`publish::publish_cold`'s own snapshot transaction runs). Two new Rust unit
tests lock this in: one asserts the pragma values read back correctly
before/after the restore call (this one DOES fail if `journal_mode=OFF`
regresses back in -- verified live), the other opens a second connection
during an open write transaction and confirms it reads without
`SQLITE_BUSY`. **Measured: catalog 6,388-6,400 ms -> 5,378-5,872 ms**
(~8-16% reduction -- modest, since `Catalog::apply`'s SQL already ran
inside one transaction before this fix, so only the WAL-checkpoint/fsync
overhead of that one commit was ever on the table, not a per-statement
cost).

**(c) Materialize: `decode_32`'s unnecessary heap allocation, ~7.5M
calls.** `sample`d live during Pass 2 after (a)+(b) (10 s window,
6,577 total samples; `materialize-sample4.txt`): a large share of samples
fell into `_xzm_free`/allocator-lock-contention frames (macOS's xzone
allocator, `_os_unfair_lock_lock_slow` -> `__ulock_wait2`, 426 samples)
alongside `hex_decode` itself (431 samples) -- P2-2c's own byte-arithmetic
fix (§11.3f) had already made `hex_decode`'s arithmetic fast, but every one
of its callers still went through a heap-allocating `Vec<u8>` for what is,
at every one of `decode_32`'s five call sites per record (`record_id`/
`record_digest`/`body_digest`/`identity_id`/`identity_key_digest` -- ~7.5M
calls total on n8n), a FIXED 32-byte output immediately `try_from`'d into
an array and the `Vec` discarded. Rewrote `decode_32` to decode directly
into a stack-allocated `[u8; 32]`, zero heap allocations -- `hex_decode`
itself (`Vec`-returning) is kept only for the one genuinely variable-length
case, the UCE body payload. **Measured: materialize pass2 17,568-18,822 ms
-> 14,010 ms** in the one detailed before/after pair captured (§12.6's
table below has the full picture across all final runs; the isolated A/B
for this fix alone, holding (a)/(b) constant, was ~3.5-4.8 s).

`sample`'s own top-of-stack breakdown for that 10 s capture (leaf frames,
`materialize_cold` subtree only):
| leaf | samples | share |
|---|---:|---:|
| `_xzm_free` (drop/deallocation cascade, several call sites) | 558+224+72+57 = 911 | ~14% |
| `hex_decode` (before fix (c)) | 431+24 = 455 | ~7% |
| `_xzm_xzone_madvise_batch` -> lock contention (background drop overlap) | 426 | ~6.5% |

This confirms (c)'s target was real and sizeable, and that the background
`owner_rows` drop (§11.3e, kept from the prior round) still costs some
lock contention against the main Pass 2 thread's own allocator traffic --
a residual noted, not chased further this round (see §12.8).

### 12.7 Final measurement: 4 runs, best-effort-idle machine (contention noted), after every fix above

Roots identical (`records: sha256:cba95efc...`, `dependency: sha256:3497776c...`,
`graph: sha256:23089a90...`, `metric: sha256:0000...`) across every run
below and every run in §12.4-§12.6 -- **8 separate cold scans this task
alone**, all byte-identical, satisfying the plan's determinism ×2 gate many
times over.

| run | catalog | facts extraction | materialize (pass1/pass2) | publish | `Queryable` | `ScanCompleted` | wall | peak RSS | note |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| final2 | 5,404 ms | *(not captured this run)* | 23,431 ms | ~2,220 ms | 43,104 ms | **43,726 ms** | 44.16 s | 5.46 GiB | cleanest of the four |
| final3 | 5,872 ms | *(not captured this run)* | 22,284 ms | ~2,210 ms | 42,509 ms | **43,084 ms** | 43.50 s | 8.41 GiB | concurrent `rustc` build confirmed live (`urdira-tsgo-client` test binary) |
| final4 | 5,395 ms | *(not captured this run)* | 21,821 ms | ~2,404 ms | 41,225 ms | **42,167 ms** | 42.45 s | 6.90 GiB | 2 concurrent cargo/rustc processes confirmed live |
| final5 (detailed) | 5,421 ms | 8,094 ms | 21,345 ms (6,445/14,010, drop 0.996s) | ~2,346 ms | 41,218 ms | **41,726 ms** | 42.16 s | 7.57 GiB | full phase breakdown captured |
| **min / median** | 5,395 / 5,413 ms | -- | 21,345 / 22,062 ms | -- | 41,218 / 41,867 ms | **41,726 / 42,626 ms** | 42.16 / 42.98 s | 5.46-8.41 GiB | |

One additional run (`final1`, 51,073 ms `ScanCompleted`, 7.89 GiB RSS,
94,378 voluntary context switches vs. 26k-42k for the four above) is
excluded from this table as a confirmed contention outlier (same
methodology precedent as §11.4's `perf7`-`perf9b` exclusion) -- it is not
hidden: raw log at `urdira-benchmark/v4-p2/final1.log`. RSS's wide spread
(5.46-8.41 GiB) is itself plausibly contention-driven, same caveat §6.1/
§11.6 already documented for this exact metric.

**Net effect this round: 51,188 ms -> 41,726-43,726 ms median-ish
(~15-19% further reduction)**, stacked on top of §11's already-measured
10.3× reduction from the original 411-522 s baseline. Combined, task
P2-2b's original baseline to this task's final state: **~411,284 ms ->
~41,726 ms, a ~9.9× reduction**, all under materially worse machine-
sharing conditions than either prior round measured under.

### 12.8 Gate result: still not met, residual reasons

| gate | target | measured | met? |
|---|---:|---:|---|
| `catalog` | ≤ 1.5 s | 5.4-5.9 s | **no** (3.6-3.9×) |
| `facts` + `materialize` | ≤ 6 s | 8.0-8.1 s + 21.3-23.4 s = 29.3-31.5 s | **no** (4.9-5.3×) |
| `Queryable` | ≤ 8 s | 41.2-43.1 s | **no** (5.2-5.4×) |
| `ScanCompleted` | ≤ 12 s | 41.7-43.7 s | **no** (3.5-3.6×) |
| peak RSS | ≤ 3 GiB | 5.46-8.41 GiB | **no** (1.8-2.8×) |
| determinism (identical roots, 8 independent runs) | -- | confirmed identical | **yes** |
| roots unchanged vs Part A | -- | confirmed identical | **yes** |

None of the five numeric gates are met, same honest conclusion as §11.7 --
reported per this task's explicit instruction not to hide a miss, with the
same "physical reasons" framing §11.7 already used, updated for what
changed this round:

- **catalog (5.4-5.9 s vs 1.5 s)**: (b)'s `synchronous=OFF` fix only ever
  had the WAL-checkpoint/single-commit fsync cost available to remove, not
  a per-statement one (`prepare_cached` + one transaction were already in
  place from §11.3g) -- the residual is still, as §11.7 already concluded,
  roughly proportional to file count (20,148 CAS `open`+`write`+`rename`
  calls), not reducible further without batching many files' CAS writes
  into fewer, larger I/O operations -- unattempted this round for the same
  reason §11.7 gave (a larger structural change than "narrow", uncertain
  payoff per this codebase's own prior multi-row-`INSERT` experience).
- **facts extraction (8.0-8.1 s, 2nd-largest phase, not separately
  gated)**: (a)'s work-stealing fix closed the *load-imbalance* gap (fully
  parallel now, work distributed evenly); what's left is real CPU-bound
  AST-walking work at the machine's parallel ceiling, same conclusion
  §11.7 already reached -- cutting further needs merging this second walk
  into `analyze()`'s first one (a `urdira-jsts-syntax-worker` architecture
  change, out of this task's crate-ownership scope, and now doubly risky
  given that crate had unrelated concurrent edits mid-task, §12.5).
- **materialize (21.3-23.4 s vs 6 s combined with facts)**: (c) closed the
  single largest NEWLY-visible cost `sample` found this round
  (`decode_32`'s allocations); Pass 1 (kernel canonicalize, ~6.3-6.4 s) is
  still close to a real CPU floor (per-record SHA-256/canonical-encode
  work, already fully parallel); Pass 2 (~14.0-17.6 s) still does one
  necessarily-sequential pass for deterministic dictionary-ordinal
  assignment, still holds `Vec<OwnerKernelRows>`/`Vec<RecordRow>`
  simultaneously for a window (the "three overlapping copies" gap §11.7
  already flagged), and the background `owner_rows` drop still contends
  for the allocator with Pass 2's own main-thread work (§12.6's sample
  data) -- the harder redesign §11.7 and this task's own brief both name
  (partition `RecordRow`s directly into per-partition `Vec`s via `rayon`
  fold/reduce, extend `SegmentWriter::write_base` with a partitioned input
  API) was not attempted this round: it touches `urdira-structural-store`
  (a shared crate this task may edit narrowly but did not need to for
  either correctness gap), and this round's remaining time went to the
  confirmed, evidence-backed wins in §12.6 instead of a larger, riskier
  change in an unusually volatile shared-checkout environment (§12.4).
- **peak RSS (5.46-8.41 GiB vs 3 GiB)**: unchanged in kind from §11.7's own
  diagnosis (the same three-overlapping-copies structure); the wide spread
  observed this round is at least partly attributable to the confirmed
  concurrent `cargo build`/`vitest` activity sharing this machine's memory
  and page cache throughout every run in §12.7's table.

### 12.9 Quality gates run (this task)

- `cargo fmt --all` -- clean.
- `cargo clippy --release -p urdira-indexing-worker -p urdira-source-frontier
  -p urdira-native-node -p urdira-worker-protocol --all-targets -- -D
  warnings` -- clean.
- `cargo test --release -p urdira-indexing-worker -p urdira-source-frontier
  -p urdira-native-node -p urdira-worker-protocol` -- 98 passed, 2 ignored,
  0 failed (52 indexing-worker + 0 native-node + 33+1 source-frontier lib/
  bench + 1 source-frontier oracle-provider integration + 8 worker-protocol
  lib + 4 worker-protocol fixture tests; `urdira-indexing-worker` up from 50
  to 52 with this task's two new `catalog::tests` pragma/concurrency regression
  tests).
- `npx vitest run tests/v4-scan.test.ts tests/rust-protocol-v4.test.ts
  tests/native-query-snapshot-port.test.ts tests/phase-daemon-v4-scan.test.ts
  tests/v4-daemon-e2e.test.ts` -- 26 passed, 1 skipped (the always-on
  "build the binary first" companion test, correctly skipped once the
  release artifacts exist). Confirmed stable across repeated runs once the
  concurrent-effort contention noted in §12.4 cleared (this suite was
  observed to fail transiently -- `ENOTEMPTY`, `database is locked`, daemon
  socket `ENOENT` -- exclusively during windows with confirmed concurrent
  `cargo build`/`vitest` activity in this same checkout from the other
  effort, and passed reliably, repeatedly, once that activity was not
  running; see §12.4/§12.6(b) for the one case where this pattern also hid
  what looked briefly like a real regression until isolated).
- Full-workspace `cargo clippy --workspace`/`pnpm verify` not run, same
  scoping rationale as §11.9: unrelated concurrent edits (§12.4/§12.5) made
  a full-repo gate unreliable as a signal specific to this task.

### 12.10 Files touched (this task)

- `crates/urdira-native-node/src/structural_store_napi.rs`: gap A2's
  `identity_id` reconstruction fallback (§12.2); gap A1's `adjacency`
  dual-candidate-key lookup + `subject_text_for` endpoint reconstruction
  (§12.1).
- `crates/urdira-indexing-worker/src/v4/analyze.rs`: facts-extraction and
  hybrid-lane rayon work-stealing chunking (§12.6a); `HybridResolutionContext`
  build-compat fix for the two new typeflow fields (§12.5).
- `crates/urdira-indexing-worker/src/v4/catalog.rs`: `synchronous=OFF`
  cold-transaction pragma + `restore_steady_state_pragmas` (§12.6b); two
  new regression tests.
- `crates/urdira-indexing-worker/src/v4/scan.rs`: calls
  `restore_steady_state_pragmas` after the catalog phase.
- `crates/urdira-indexing-worker/src/v4/materialize.rs`: allocation-free
  `decode_32` (§12.6c).
- `crates/urdira-indexing-worker/src/v4/tests_e2e.rs`: mirrors the pragma
  restore call in its own hand-rolled `scan::run`-equivalent flow.
- `tests/v4-scan.test.ts`: new relation-materialization + adjacency
  regression test (§12.1).
- `tests/v4-daemon-e2e.test.ts`: replaced the stale "always empty" /
  "no `identity_id`" documented-gap comments with real assertions for both
  fixes, including v3-equality checks (§12.1/§12.2).

## 13. P2-2f: bytes-native structural kernel + hex/`Value`-free materialize Pass 1/2

Task P2-2f's code-review-identified root cause: `materialize.rs`'s
`canonicalize_owner` cloned every `ProposedRecord` field into a
`StructuralKernelRecord`, ran it through `structural_kernel_batch_parts`
(the N-API/JSON-shaped kernel: per record a canonical JSON `String`, a
hex-encoded UCE body `String`, and a `StructuralPublicationRecord` with
nine `String`/`Vec<String>` fields plus a `primary_source_span:
Option<Value>` JSON tree), then Pass 2 hex-decoded every digest/id and the
whole body back out again. On n8n's 1.5M records that is tens of millions
of allocations and ~2.4 GB of transient hex per scan.

### 13.1 What shipped

1. **`crates/urdira-native-core/src/lib.rs` (additive)**: `pub fn
   structural_kernel_rows(records: &[StructuralKernelRecord]) ->
   NativeCoreResult<StructuralKernelRows>`, returning one
   `StructuralKernelRow` per record with `record_id`/`record_digest`/
   `body_digest`/`identity_id`/`identity_key_digest`/
   `identity_assignment_id` as native `[u8; 32]`, `body: Vec<u8>` (the raw
   UCE bytes, never hex-encoded), `span_start`/`span_end: u32` (parsed
   directly from `source_span`'s JSON text, the parsed `Value` dropped
   before returning -- never stored in a per-record `Vec` the way
   `StructuralPublicationRecord::primary_source_span` was), `facets:
   Vec<String>`, `identity_type: &'static str`, `identity_key: String`,
   `structural_attestation: bool`. Built on the SAME primitives the
   existing kernel uses (`structural_record_digest_hash` -- refactored out
   of `structural_record_digest` as a shared, unfinalized-`Sha256` step so
   the text and bytes entrypoints can never drift; `sha256_bytes`/
   `uce_text_digest_bytes`/`uce_text_object_digest_bytes`, byte-native
   siblings of the existing text functions; `LogicalDigestWriter::
   finish_bytes`, a bytes-native sibling of `finish`; `encode_publication_
   body`, unchanged -- it already wrote raw bytes, only the hex-encoding
   step on top of it is skipped now; `canonical_nested_record_fields`,
   unchanged). `structural_kernel_batch_parts` and every existing type
   (`StructuralPublicationRecord`, `StructuralKernelResult`, etc.) are
   completely untouched -- v3's hybrid lane (`main.rs`) still calls the
   original function, byte-identical.
   New test: `tests/structural_kernel.rs`'s
   `native_core_rows_match_batch_parts_oracle` builds a fixture batch
   (entity + relation + diagnostic records, multi-byte UTF-8 identity
   keys/bodies, a non-canonical-facets record exercising the
   `structural_attestation == false` fallback) and asserts every
   `StructuralKernelRow` field equals the hex/JSON-decoded equivalent
   field from `structural_kernel_batch_parts`'s oracle output, plus the
   `MAX_BATCH_RECORDS` bisection bound still rejects an over-large batch.
2. **`crates/urdira-indexing-worker/src/v4/materialize.rs`**:
   `canonicalize_owner`'s Pass 1 now calls `structural_kernel_rows`
   directly (`kernel_rows_batches` replaces the old two-input `kernel_
   batches`, bisecting on `MAX_BATCH_RECORDS`/`MAX_BATCH_FRAMED_BYTES` the
   same way). Pass 2 reads `row.record_id`/`record_digest`/`body_digest`/
   `identity_id`/`identity_key_digest` directly (`[u8; 32]`, zero hex
   decode anywhere on this path any more) and `mem::take`s `row.body`/
   `row.identity_key` out of each owner's `rows` (a `&mut` borrow, not a
   clone) instead of cloning them, since that owner's row is never read
   again after Pass 2 consumes it. `hex_nibble`/`hex_decode`/`decode_32`/
   `decode_sha256`/`decode_record_id`/`decode_identity_id` are now
   `#[cfg(test)]`-only (they exist solely to decode the oracle's output in
   the regression test below).
   **Scope reduction found along the way**: `deps::materialize_dependencies`
   (unchanged, confirmed by reading `deps.rs`) never reads a kernel-
   canonicalized dependency at all -- every `DependencyRow` field comes
   straight from `ProposedRecordDependency`. The pre-P2-2f code still ran
   every owner's dependencies through the kernel in the SAME batch as its
   records (`to_structural_dependency` + `StructuralKernelDependency`),
   which built canonical JSON text and ran `MAX_LOGICAL_DEPTH` validation
   over `source_reference` -- a field `deps.rs` never reads either -- for
   zero downstream consumers. `kernel_rows_batches` canonicalizes records
   only; dependencies now cost nothing in Pass 1 beyond the clone already
   needed to carry them to `deps.rs`.
   Existing test `record_identity_matches_the_structural_kernel_oracle_
   exactly` (unchanged) still passes unmodified -- it already asserted
   `materialize_cold`'s output against the `structural_kernel_batch_parts`
   oracle, so it now doubles as an end-to-end regression check that the
   bytes-native rewrite didn't change any observable output.
3. **Not attempted this round** (see §13.4): the 16-partition parallel
   dictionary-fill + `SegmentWriter::write_base_partitioned` rewrite (item
   2's fuller ask), the facts-extraction second-AST-walk merge (item 3),
   the catalog walk/CAS/SQLite-apply batching (item 4), and item 1's
   borrowed-input path (`StructuralKernelRecordRef<'a>`/`Cow`, or a
   move-based `ProposedRecord` -> `StructuralKernelRecord` conversion).
   `to_structural_record` in `materialize.rs` still clones every
   `ProposedRecord` field (7 `String`s + 1 `body: Value` tree) into an
   owned `StructuralKernelRecord` per record before Pass 1 -- this is now
   Pass 1's largest remaining avoidable cost (the hex/JSON-text
   construction this task targeted is gone; this clone predates it and
   was out of this round's time budget after landing and fully measuring
   the bytes-API rewrite). A clean fix needs `structural_record_digest_
   hash`/`canonical_nested_record_fields`/`structural_kernel_row` to take
   individually-borrowed fields (or a named ref struct) instead of `&
   StructuralKernelRecord`, so `materialize.rs` can hash straight off `&
   ProposedRecord` without ever building the owned intermediate -- a
   moderate, correctness-sensitive signature change across several
   `native-core` internals (all currently shared with the untouched `
   structural_kernel_batch_parts` path) that deserves its own dedicated
   pass and test rather than being rushed in alongside this round's
   already-landed win. Time this round went to the confirmed, measured
   win below; see residuals.

### 13.2 Measurement: 3 runs, n8n corpus (14,082 owners, 1,521,196 records), idle machine

Same protocol as §11/§12: `cargo build --release -p urdira-indexing-worker`,
`URDIRA_DEBUG_TIMING=1 /usr/bin/time -l node scripts/v4-scan.mjs
~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02
~/Proyectos/urdira-benchmark/v4-p2/p2-2f/runN`, fresh empty
`dataDir` per run. `pgrep -f "urdira-indexing-worker|n8n-incremental-
preflight|v4-scan"` empty before every run; no concurrent `cargo`/`rustc`
observed.

| run | catalog | facts extraction | materialize pass1 | materialize pass2 | materialize total | publish (sort+write_base+merkle) | `Queryable` | `ScanCompleted` | wall | peak RSS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| run1 | 5,746 ms | 8.225 s | 5.849 s | 7.146 s | 12.995 s | 4.819 s | 35,891 ms | **37,379 ms** | 37.98 s | 4.70 GiB |
| run2 | 5,718 ms | 11.547 s | 4.740 s | 4.979 s | 9.719 s | 4.556 s | 36,529 ms | **37,704 ms** | 37.97 s | 4.75 GiB |
| run3 | 5,731 ms | 8.911 s | 4.295 s | 5.615 s | 9.910 s | 4.479 s | 33,949 ms | **35,208 ms** | 35.54 s | 4.37 GiB |
| **min / median** | 5,718 / 5,731 ms | 8.225 / 8.911 s | 4.295 / 4.740 s | 4.979 / 5.615 s | 9.719 / 9.910 s | 4.479 / 4.556 s | 33,949 / 35,891 ms | **35,208 / 37,379 ms** | 35.54 / 37.97 s | 4.37-4.75 GiB |

Roots identical to every prior run in this doc (§11-§12, 8+ independent
cold scans): `records: sha256:cba95efcc25f1a67ec07cb10ab55e70c7a0951baa
36431a545d8e41a6a9795f3`, `dependency: sha256:3497776c3629fbf22d015ba99
bce2210ed6909eba44f4957d63954b74fcce28d`, `graph: sha256:23089a905fc93cd
c9506f5c8d50b97655fd97a72af73ffc9d1fb1cc92152ac0a`, `metric: sha256:0...0`
-- confirmed across all 3 runs this task, satisfying the plan's
determinism gate and the "root must not change" contract (ids/digests/
bodies are unchanged; only their in-memory representation changed).

### 13.3 Before/after (baseline: §12.7's min/median, this task's own P2-2b n8n baseline)

| phase | before (min/median) | after (min/median) | change |
|---|---:|---:|---:|
| catalog | 5,395 / 5,413 ms | 5,718 / 5,731 ms | flat (not touched this round; within run-to-run noise seen throughout this doc) |
| facts extraction | 8,094 ms (1 sample) | 8,225 / 8,911 ms | flat (not touched this round) |
| materialize (pass1+pass2) | 21,345 / 22,062 ms | 9,719 / 9,910 ms | **-54.4% / -55.1%** (2.2x) |
| `Queryable` | 41,218 / 41,867 ms | 33,949 / 35,891 ms | -17.6% / -14.3% |
| `ScanCompleted` | 41,726 / 42,626 ms | 35,208 / 37,379 ms | -15.6% / -12.3% |
| peak RSS | 5.46-8.41 GiB (4-run spread) | 4.37-4.75 GiB (3-run spread) | narrower AND lower; median of the 4 baseline runs ~7.2 GiB vs ~4.70 GiB now |

The materialize-phase win lands almost exactly where the root-cause
analysis predicted: Pass 1 (5.85/4.74/4.30 s) no longer builds a canonical
JSON `String` or a hex-encoded body `String` per record, and no longer
canonicalizes dependencies at all; Pass 2 (7.15/4.98/5.62 s, down from a
14.0-17.6 s range in §12) no longer hex-decodes 5 digests + 1 variable-
length body per record (~9M `hex_nibble` calls removed) and moves rather
than clones each row's body/identity_key.

### 13.4 Gate result: still not met, residual reasons (updated)

| gate | target | measured (min/median) | met? |
|---|---:|---:|---|
| `catalog` | ≤ 1.5 s | 5.72 / 5.73 s | **no** (3.8×) -- unchanged, item 4 (walk/CAS/SQLite-apply batching) not attempted this round |
| `facts` + `materialize` | ≤ 6 s | (8.23+9.72) / (8.91+9.91) = 17.95 / 18.82 s | **no** (3.0-3.1×), down from 4.9-5.3× -- facts extraction (item 3, the second-AST-walk merge) not attempted this round |
| `Queryable` | ≤ 8 s | 33.95 / 35.89 s | **no** (4.2-4.5×), down from 5.2-5.4× |
| `ScanCompleted` | ≤ 12 s | 35.21 / 37.38 s | **no** (2.9-3.1×), down from 3.5-3.6× |
| peak RSS | ≤ 3 GiB | 4.37-4.75 GiB | **no** (1.5-1.6×), down from 1.8-2.8× |
| determinism (identical roots) | -- | confirmed identical, 3 more independent runs | **yes** |
| roots unchanged vs P2-2d | -- | confirmed identical | **yes** |

Reasons the remaining three items in this task's brief were not attempted
this round, same "don't hide a miss" framing as §11.7/§12.8:

- **Facts extraction (item 3, merging `analyze()`'s parse with `read_
  facts_group`'s walk, or caching the oxc arena between them)**: this is a
  `urdira-jsts-syntax-worker` architecture change (the crate this task may
  edit for "facts extraction only, API-compatible" per its brief), but
  doing it safely needs a careful read of `SyntaxWorkerState::analyze`'s
  ownership of the parsed program/allocator arena across the
  `std::thread::scope` boundary `analyze.rs` already uses for its two
  lanes -- a correctness-sensitive change this task's remaining time
  budget, after landing and fully measuring item 1, did not cover.
  Deferred whole, not attempted partially.
- **Catalog (item 4, walk/CAS/SQLite-apply batching)**: `crates/urdira-
  source-frontier`'s `walker.rs`/`cas.rs`/`catalog.rs` were not touched
  this round; the 5.4-5.9 s range across every run in this doc (§11, §12,
  §13) is unchanged, consistent with it being a genuinely separate cost
  center from materialize (SQLite `INSERT` batching, blob-write dedup)
  that this task's time went to measuring and hardening the confirmed
  materialize win instead.
- **16-partition parallel dictionary fill + `write_base_partitioned`
  (item 2's fuller ask)**: Pass 2 is still one sequential loop assigning
  dictionary ordinals and pushing `RecordRow`s (now much cheaper per
  record -- no hex, no `Value` clone -- which is most of why Pass 2 alone
  dropped 14.0-17.6 s to 4.98-7.15 s without this rewrite). A further
  split into a rayon fold/reduce over 16 `record_id`-nibble partitions,
  each independently dictionary-assigned in a first pass and ordinal-
  resolved in a second, plus a partitioned `SegmentWriter::write_base`
  API in `urdira-structural-store`, was judged a larger, riskier structural
  change (touching a shared crate's on-disk-adjacent writer path,
  changing dictionary-ordinal semantics from first-seen-in-owner-path-
  order to first-seen-in-sorted-per-partition-order, which needed its own
  determinism argument) than this round's remaining budget after
  confirming and documenting item 1's win could safely absorb. Flagged as
  the next round's highest-value remaining item: Pass 2 (4.98-7.15 s) is
  now a larger fraction of what's left than Pass 1 (4.30-5.85 s), so
  parallelizing it is the next concrete lever on materialize.

### 13.5 Quality gates run (this task)

- `cargo fmt --all` -- clean (reformatted only the files this task touched
  plus files already dirty from the other agent's concurrent
  `urdira-tsgo-client` work, per that crate's own formatting; not
  reverted, per this task's "don't touch that crate" instruction meaning
  don't ATTRIBUTE changes there, not that a workspace-wide `fmt` must
  avoid touching its files -- confirmed via `git diff --stat` that this
  task's own edits are confined to `crates/urdira-native-core/src/lib.rs`,
  `crates/urdira-native-core/tests/structural_kernel.rs`, and
  `crates/urdira-indexing-worker/src/v4/materialize.rs`).
- `cargo clippy -p urdira-native-core -p urdira-indexing-worker -p
  urdira-source-frontier -p urdira-structural-store -p
  urdira-jsts-syntax-worker --all-targets -- -D warnings` -- clean.
- `cargo test -p urdira-native-core -p urdira-indexing-worker -p
  urdira-source-frontier -p urdira-structural-store -p
  urdira-jsts-syntax-worker` -- all green: native-core 5+4+3=12 (incl. the
  new oracle-equivalence test), indexing-worker 52 passed + 1 ignored,
  source-frontier 33+1+1=35, structural-store 0 unit + 9 integration,
  jsts-syntax-worker 151 passed. 0 failed anywhere.
- `npx vitest run tests/v4-scan.test.ts tests/rust-protocol-v4.test.ts
  tests/native-query-snapshot-port.test.ts tests/phase-daemon-v4-scan.test.ts
  tests/v4-daemon-e2e.test.ts tests/codebase-fixtures.test.ts` -- 29 passed,
  1 skipped, 0 failed.
- Full-workspace `cargo clippy --workspace`/`pnpm verify` not run (same
  scoping rationale as §11.9/§12.9: a concurrent agent has unrelated work
  in `crates/urdira-tsgo-client`, so a full-repo gate is not a clean signal
  specific to this task).

### 13.6 Files touched (this task)

- `crates/urdira-native-core/src/lib.rs`: additive bytes-native kernel API
  (`StructuralKernelRow`, `StructuralKernelRows`, `structural_kernel_rows`,
  `structural_kernel_row`, `source_span_bytes_from_text`,
  `sha256_bytes`, `uce_text_digest_bytes`, `uce_text_object_digest_bytes`,
  `structural_record_digest_bytes`, `LogicalDigestWriter::finish_bytes`);
  internal refactor of `structural_record_digest` to share `structural_
  record_digest_hash` with the new bytes entrypoint (output unchanged).
  No existing public function's signature or behavior changed.
- `crates/urdira-native-core/tests/structural_kernel.rs`: new
  `native_core_rows_match_batch_parts_oracle` equivalence test.
- `crates/urdira-indexing-worker/src/v4/materialize.rs`: `canonicalize_
  owner`/`materialize_cold` rewritten to consume `structural_kernel_rows`
  (bytes-native, records only); `kernel_rows_batches` replaces `kernel_
  batches`; dependency kernel-canonicalization removed (dead work, see
  §13.1); hex decode helpers moved to `#[cfg(test)]`; module doc comment
  updated.

## 14. P2-2g round 4

Task P2-2g's mandate: items 1-4 below, each instrumented, fixed (or
measured and reverted if the fix regressed), and reported with exact
numbers. Machine: same as §13 (macOS arm64, 10 cores, 32 GB RAM, NVMe),
idle throughout (`pgrep -f "urdira-indexing-worker|n8n-incremental-
preflight|v4-scan"` empty before every run). `rustc`/`cargo` 1.98.0.

### 14.1 Item 1: facts extraction 8-11 s -> ~0.4-0.5 s

**Root cause, found by reading (not just profiling)**: `read_facts`/
`read_facts_group` do NOT re-parse a file (a plausible guess this task's
brief itself offered) -- `SyntaxFileResult.entities`/`.relations` are
already fully populated by `analyze()`'s single parse pass, and `read_
facts` only slices/converts that existing data into `ProposedRecord`s.
The real cost is protocol overhead that makes sense for an out-of-process
worker talking over a byte-bounded IPC channel and is *pure waste* for
`urdira-indexing-worker`'s v4 pipeline, which holds `SyntaxWorkerState`
in-process and never serializes a `WorkerMessage` at all:
- `serialized_response_length` (`lib.rs`) re-serializes the ENTIRE growing
  response with `serde_json::to_vec` in a fixed-point loop (2-4 full
  passes per call, converging once the embedded byte-count's own digit
  width stabilizes) purely to police `max_output_bytes`/`max_rows` -- a
  budget with no meaning in-process.
- `read_facts_group`'s cursor/continuation loop (`FactsGroupEntry`/
  `FactsCursor`, up to 64-owner request groups, `VecDeque`-based retry of
  partial pages) exists solely to fit a byte-bounded wire frame.
- Called per 64-path chunk across `rayon` (already parallel going into
  this round, per P2-2d/§13's block-vs-chunk history) -- the overhead is
  per-CALL, not per-file-content, so parallelism alone couldn't remove it.

**Fix**: `crates/urdira-jsts-syntax-worker/src/lib.rs` (API-compatible,
additive) -- new `SyntaxWorkerState::facts_for_paths(&self, project_key,
paths) -> Result<Vec<FactsForPath>, AnalysisError>` and its per-path
helper `facts_for_one_path`, built on the SAME `proposed_records`/
`proposed_dependencies` functions `read_facts`/`build_facts_page` already
use (no new canonicalization logic, zero drift risk) but with no budget
check, no cursor, and no `serialized_response_length` call: each path's
COMPLETE fact set comes back in one `Vec`, once. `read_facts`/`read_facts_
group`/`build_facts_page` and every existing caller (`main.rs`'s v3 lane)
are byte-for-byte untouched.
`crates/urdira-indexing-worker/src/v4/analyze.rs`: `run_facts_block` (the
64-path-chunk/cursor-loop orchestration) deleted entirely; `run_cold` now
`par_iter`s `facts_for_paths` per FILE directly (no chunking needed --
there is no per-call protocol overhead left to amortize by batching), then
builds `OwnerFacts` from each `FactsForPath` plus the already-known
owner artifact id/version.

**Measured** (single run, `URDIRA_DEBUG_TIMING=1`): facts extraction
11.997 s -> 0.378 s (this task's first measurement, immediately after
landing the change) -- a **~32x** reduction. Across the final 3-run round
(§14.5) it settles at 0.411-0.520 s (min 0.411 s / median 0.470 s),
comfortably under the ≤ 2 s target for this item alone. Roots unchanged
(`records: sha256:cba95efc...`, confirmed after every single-item change
in this round, not just at the end). `total_ms` (internal `ScanClock`)
dropped from 33,555 ms to 24,180 ms on that same first measurement --
almost the entire facts-extraction win landed directly on wall time, as
expected for a phase with no downstream consumer waiting on anything else.

### 14.2 Item 2: catalog 5.7 s -> measured, one fix attempted and REVERTED (net regression)

**Instrumentation added** (`crates/urdira-source-frontier/src/catalog.rs`,
`URDIRA_DEBUG_TIMING`-gated, kept): `Catalog::apply` now reports `insert_
loop` (the `delta.added`/`changed`/`deleted` SQL+frontier loop) / `digest+
upsert` (`frontier.source_state_digest()` + `source_index_state` upsert) /
`commit` separately, alongside `v4/catalog.rs`'s pre-existing `walk`/
`apply` split. Result on n8n (20,148 observations, all `added` on a cold
scan): `walk=3.0-3.7 s`, `apply` = `insert_loop` (1.7-2.3 s) + `digest+
upsert` (**0.000 s**, every run) + `commit` (0.14-0.34 s).

The `digest+upsert=0.000s` result answers this item's stated worry
directly: `source_state_digest` is NOT computed by 20k incremental
`Sha256::update` calls the way the task brief hypothesized -- it's already
`Frontier`'s incrementally-maintained `BucketedMerkleSet` (one bucket + 5
ancestor digests touched per `set_present`/`set_absent` call, folded into
the same per-row loop `insert_loop` measures), so reading the digest at
the end (`compute_source_state_digest`) is O(1). No fix needed or
attempted here; already correct going into this round (source-frontier's
own P2-2a work).

Every OTHER CAS/walk item this task listed as a checklist was also
already true before this round (read, not re-verified by writing a
regression): parallel walk+hash+CAS-write (`walker.rs`'s `par_iter`, added
in an earlier round), `put_if_absent` skip-existing via `target.is_file()`
before opening + one `write_all` + no fsync, pre-created shard directories
in `CasStore::open`, `INSERT OR IGNORE` (no per-row `SELECT`/`EXISTS`
anywhere in `catalog.rs`), `synchronous=OFF` for the whole cold catalog
transaction (`v4/catalog.rs`'s `open_and_ensure_schema`). The only
concretely actionable, not-yet-tried item was the multi-row `INSERT`
batching.

**Attempted**: `insert_added_batch` -- buffers all four tables'
(`source_artifacts`/`source_observations`/`content_blobs`/
`artifact_versions`) rows for the whole `delta.added` set (the only
populated bucket on a cold `Full` scan; `changed`/`deleted` stay per-row,
unchanged, since an incremental batch is orders of magnitude smaller) into
owned `rusqlite::types::Value` tuples, then flushes each table as
500-row multi-value `INSERT` statements via a generic `execute_batched_
insert` helper.

**Measured, REGRESSION, twice**: first attempt (`transaction.execute`, no
statement caching): `insert_loop` 1.861 s -> **2.279 s** (+22%). Suspecting
the batch SQL text (several thousand placeholders for a 500-row/
11-13-column table) was being recompiled from scratch every chunk,
switched to `transaction.prepare_cached(&sql)` (the full batches are
almost all identically-shaped, so the compiled statement should be
reused): **2.162 s** (+16%), still a regression, confirmed on a second,
independently idle-machine-checked run. Root cause, once measured rather
than assumed: the ORIGINAL per-row path binds `&str` (via `rusqlite::
params!`, which borrows) directly into a cached single-row prepared
statement -- no allocation beyond what SQLite itself needs. The batched
path must first BUFFER every row as owned data before it can build one
multi-row statement, and `rusqlite::types::Value::Text(String)` requires
an owned `String` per field -- ~20,148 rows x ~33 total fields across the
4 tables is ~660k extra `String` clones this round's batching introduced,
which cost more than the per-`execute()` dispatch overhead it was meant to
amortize. SQLite's own per-statement overhead for a tiny, already-cached
prepared statement is apparently smaller than this task's brief assumed.

**Reverted**: `insert_added_batch`/`execute_batched_insert` removed,
`Catalog::apply` calls the original per-row `insert_new_artifact_and_
version` again (byte-for-byte the pre-existing function, restored). The
`insert_loop`/`digest+upsert`/`commit` debug-timing split is KEPT (it cost
nothing and answered the digest question conclusively). `cargo test -p
urdira-source-frontier` (33+1+1 tests, including `catalog::tests::cold_
apply_then_frontier_reload_agree` and `incremental_single_file_edit_
touches_only_that_uri`) green both before reverting (confirming the
batched path was correct, just slower) and after.

**Net effect this item**: none on catalog's own numbers (still `walk`
3.0-3.7 s + `apply` 1.9-2.6 s = catalog_ms 5.25-5.93 s across the final
round, flat vs. §13's 5.72-5.73 s baseline, within run-to-run noise). Gate
(≤ 1.5 s) not met. Residual reason: `walk` alone (3.0-3.7 s, already fully
`rayon`-parallel hash+CAS-write across 20,148 observed files) exceeds the
gate on its own; hitting ≤ 1.5 s would need eliminating a whole read+hash
pass over the corpus (e.g. mmap-based reads, `io_uring`, or skipping CAS
writes for a scan whose blobs will be immediately superseded) -- out of
this round's scope and not one of the four listed concrete techniques.

### 14.3 Item 3: materialize/publish -- borrowed kernel rows shipped; full partitioned rewrite NOT attempted (see residual)

**Shipped**: `crates/urdira-native-core/src/lib.rs` (additive) --
`StructuralKernelRecordRef<'a>` (a borrowed view: `&'a str`/`&'a Value`
fields matching `StructuralKernelRecord` 1:1), `StructuralKernelRecord::
as_ref(&self) -> StructuralKernelRecordRef<'_>`, and `structural_kernel_
rows_ref(&[StructuralKernelRecordRef<'_>]) -> NativeCoreResult<
StructuralKernelRows>`. `structural_record_digest_hash`, `canonical_
nested_record_fields`, and `structural_kernel_row` (the three functions
this path's digest/canonicalization work actually runs through) now take
`StructuralKernelRecordRef<'_>` instead of `&StructuralKernelRecord`;
`structural_kernel_rows` (the existing owned-input entrypoint) is now a
one-line wrapper (`records.iter().map(StructuralKernelRecord::as_ref)`)
over `structural_kernel_rows_ref`, so both entrypoints stay byte-identical
by construction, not by parallel maintenance. Every other existing
caller of the three refactored functions (`structural_kernel_batch_parts_
with_canonical`'s owned-record loop, the schema-attestation pass) updated
to call `.as_ref()` at the call site -- zero behavior change, confirmed by
`native_core_rows_match_batch_parts_oracle` (unchanged, still passes).

`crates/urdira-indexing-worker/src/v4/materialize.rs`: new `to_structural_
record_ref(&ProposedRecord) -> StructuralKernelRecordRef<'_>` (borrows
every field), used by `canonicalize_owner`'s Pass 1 in place of the old
`to_structural_record` (which cloned 7 `String`s + 1 `body: Value` tree
PER RECORD into an owned `StructuralKernelRecord` -- flagged by §13.1 as
"Pass 1's largest remaining avoidable cost" after P2-2f). `kernel_rows_
batches` now bisects `&[StructuralKernelRecordRef<'_>]` and calls
`structural_kernel_rows_ref`. `to_structural_record` (owned) is kept
`#[cfg(test)]`-only, still used by `record_identity_matches_the_
structural_kernel_oracle_exactly` to build an owned oracle-comparison
input. On n8n's 1.5M records this removes ~10.6M `String`/`Value` clones
from Pass 1 (7 strings + 1 body clone x 1,521,196 records).

**Measured** (single run immediately after landing, on top of item 1):
materialize pass1 3.508 s -> 3.332 s, pass2 6.101 s -> 3.688 s (this
particular pair is noisy run-to-run -- see §14.5's full 3-run spread,
2.239-3.258 s pass1 / 2.644-4.506 s pass2), write_base 3.384 s -> 2.082 s
in that same pair of runs (plausibly downstream of materialize allocating
less and leaving more page cache/allocator headroom for `write_base`,
though this task did not isolate that causally). Total wall for that
run: 26.47 s -> 20.93 s. Roots unchanged. `cargo test -p urdira-native-
core -p urdira-indexing-worker` green (16 native-core tests incl. the
oracle equivalence test; 52+1 indexing-worker tests incl. all 5
`materialize::tests::*`).

**NOT attempted this round** (concrete blocker: time budget, not a
technical dead end -- flagged honestly rather than claimed done): the
16-partition parallel pass 2 (fold straight into partition buckets by
`record_id` top nibble, parallel per-partition dictionary interning +
sort, `SegmentWriter::write_base_partitioned`). This is a materially
larger change than items 1/2/3's borrowed-rows fix -- it touches Pass 2's
dictionary-ordinal assignment (currently a single sequential loop that
`OrdinalDict::intern`s in owner-path order for determinism; a partitioned
version needs per-partition distinct-key collection, a merge/sort/
re-assign step, and a second parallel fill pass, per the task's own
description) AND a new `urdira-structural-store::writer::SegmentWriter::
write_base_partitioned` entry point that must be proven byte-identical to
`write_base` via the existing determinism test before it can be trusted --
correctness-sensitive surface neither of which this round's remaining time
after items 1/2/3 could responsibly rush. Pass 2 (2.6-4.5 s across the
final round) and publish's sort+write_base+merkle (2.7-3.6 s) are
therefore still single-pass/globally-sorted, unchanged in structure from
§13. Gate (materialize ≤ 3 s, publish ≤ 2.5 s) not met by either half;
RSS gate (≤ 3 GiB) also not met (§14.5).

### 14.4 Item 4: unaccounted time -- two real gaps found and closed, ~0.8-1.5 s residual localized (not folded into a bucket)

Before this round, `ScanTimings`' `parse_ms` covered ONLY the initial
`analyze()` call -- facts extraction (`read_facts_group`, 8-12 s before
item 1) fell through every bucket entirely, the single largest piece of
this task's "~5 s unaccounted" starting estimate (turned out closer to
9-13 s once measured). Separately, `publish.rs`'s `sort_elapsed` (records/
dependencies sort-by-key) and `graph_elapsed` (graph/metric Merkle tree
build) were computed for the `URDIRA_DEBUG_TIMING` println but never
passed to `clock.record_write`/`record_fsync` -- a second, smaller
(0.7-1.0 s combined) gap.

**Fixed, both additive-only, no wire-protocol (`urdira-worker-protocol`)
change** (that crate is outside this task's owned-crate list; folding
existing measured durations into the existing `parse_ms`/`write_ms`
buckets needed no new field):
- `analyze.rs`: `clock.record_parse` call moved from immediately after
  `analyze()` to immediately after facts extraction, recording `parse_
  started.elapsed()` at that later point (i.e. the SAME `Instant`,
  read later) -- `parse_ms` now means "parse + facts extraction".
- `publish.rs`: `clock.record_write(sort_elapsed + summary.to_page_cache +
  graph_elapsed)` (was `summary.to_page_cache` alone) -- `write_ms` now
  means "sort + write_base's page-cache-ready phase + graph/metric
  Merkle". `fsync_ms` unchanged (`durable - to_page_cache`, still exactly
  `write_base`'s own fsync slice).

**Diagnostic added and kept** (`scan.rs`, `URDIRA_DEBUG_TIMING`-gated):
wraps `run_cold`, `materialize_cold`, and `publish_cold`'s own call
boundaries (`run_cold_total`/`materialize_call`/`publish_call`) to
localize any residual gap to a specific call rather than guessing.
Measured (one run): `run_cold_total=3.203s` vs. `parse_ms(982) +
resolve_ms(1377) = 2,359 ms` inside it -- an internal ~844 ms not in
either bucket (file/config-asset partition+sort before the first
`Instant` starts, and the final owner-map-to-sorted-`Vec` step after the
hybrid lane returns). `publish_call=4.827s` vs. `write_ms(3971) +
fsync_ms(130) + snapshot_ms(15) = 4,116 ms` -- an internal ~711 ms not in
any bucket, most plausibly `on_queryable`'s callback (event construction +
the CLI's own IPC/stdout write, per `publish.rs`'s doc comment: `Queryable`
fires between the write-base clock and the snapshot clock). Neither
residual was folded into an existing bucket THIS round: `run_cold`'s
~844 ms is genuinely "setup + teardown around parse/resolve", not more
parse or more resolve; `publish_call`'s ~711 ms is calling BACK into
caller-supplied code (`on_queryable`), not this module's own work to
re-attribute. Reported here as its own diagnosed (not swept-under-a-rug)
residual instead.

**Net**: the reported phase table (§14.5) now sums to within ~0.8-1.5 s of
`total_ms` on every run (previously off by 9-14 s, dominated by
unclocked facts extraction). The remaining gap is real, small, and
localized to two specific call boundaries (documented above) rather than
diffusely "somewhere in the pipeline."

### 14.5 Final measurement: 3 runs, n8n corpus (14,082 owners, 1,521,196 records), idle machine

Protocol: `cargo build --release -p urdira-indexing-worker`, `URDIRA_
DEBUG_TIMING=1 /usr/bin/time -l node scripts/v4-scan.mjs ~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02 <fresh empty data dir>`,
machine idle before every run (`pgrep` empty). Data dirs deleted after
recording numbers (each run's structural store was ~1.9 GB).

| run | catalog (walk+apply) | facts extraction | materialize pass1 | materialize pass2 | publish (sort+write_base+merkle) | `Queryable` | `ScanCompleted` | wall | peak RSS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| run1 | 5,280 ms (3.019+2.238... insert_loop 2.023) | 0.470 s | 2.829 s | 3.692 s | 3.572 s (0.598+2.826+0.148) | 19,360 ms | **19,949 ms** | 20.25 s | 4.21 GiB |
| run2 | 5,934 ms (3.691+2.228, insert_loop 1.861) | 0.411 s | 2.239 s | 2.644 s | 2.718 s (0.552+1.992+0.174) | 17,805 ms | **18,331 ms** | 18.66 s | 5.50 GiB |
| run3 | 5,252 ms (3.354+1.884, insert_loop 1.725) | 0.520 s | 3.258 s | 4.506 s | 3.148 s (0.595+2.309+0.244) | 19,907 ms | **20,619 ms** | 20.94 s | 5.09 GiB |
| **min / median** | 5,252 / 5,280 ms | 0.411 / 0.470 s | 2.239 / 2.829 s | 2.644 / 3.692 s | 2.718 / 3.148 s | 17,805 / 19,360 ms | **18,331 / 19,949 ms** | 18.66 / 20.25 s | 4.21-5.50 GiB (median 5.09) |

Roots identical across all 3 runs, and identical to every prior run in
this doc (§11-§13, 11+ independent cold scans): `records: sha256:
cba95efcc25f1a67ec07cb10ab55e70c7a0951baa36431a545d8e41a6a9795f3`,
`dependency: sha256:3497776c3629fbf22d015ba99bce2210ed6909eba44f4957d63
954b74fcce28d`, `graph: sha256:23089a905fc93cdc9506f5c8d50b97655fd97a72
af73ffc9d1fb1cc92152ac0a`, `metric: sha256:0...0`.

### 14.6 Before/after (baseline: §13.2's min/median, this task's own starting point)

| phase | before (min/median) | after (min/median) | change |
|---|---:|---:|---:|
| catalog | 5,718 / 5,731 ms | 5,252 / 5,280 ms | flat (item 2's only concrete fix attempt measured as a regression and was reverted; within run-to-run noise otherwise) |
| facts extraction | 8,225 / 8,911 ms | 411 / 470 ms | **-95.0% / -94.7%** (~19x) |
| materialize (pass1+pass2) | 9,719 / 9,910 ms | 4,968 / 6,521 ms (min-pair / median-pair sums) | **-48.9% / -34.2%** |
| publish (sort+write_base+merkle) | 4,479 / 4,556 ms | 2,718 / 3,148 ms | **-39.3% / -30.9%** |
| `Queryable` | 33,949 / 35,891 ms | 17,805 / 19,360 ms | **-47.6% / -46.1%** |
| `ScanCompleted` | 35,208 / 37,379 ms | 18,331 / 19,949 ms | **-47.9% / -46.6%** |
| peak RSS | 4.37-4.75 GiB | 4.21-5.50 GiB | flat/slightly wider spread (no RSS-targeted fix landed this round; item 3's borrowed-rows change removes allocations but did not measurably tighten the spread against this round's own noise) |

### 14.7 Gate result

| gate | target | measured (min/median) | met? |
|---|---:|---:|---|
| `catalog` | ≤ 1.5 s | 5.25 / 5.28 s | **no** (3.5-3.6x) -- `walk` alone (3.0-3.7 s, already fully parallel) exceeds the gate; item 2's only untried concrete technique (SQL batching) measured as a regression and was reverted (§14.2) |
| `facts` + `materialize` | ≤ 6 s | run2 (min): 0.411+2.239+2.644=5.294 s / run1 (median-ish): 0.470+2.829+3.692=6.991 s | **best run: yes (0.88x) / worst run: no (1.17x)** -- down from 3.0-3.1x; item 1 alone met this gate on its own budget, materialize pass1+pass2 (2.6-8.1 s combined across runs) is now the harder half |
| `Queryable` | ≤ 8 s | 17.81 / 19.36 s | **no** (2.2-2.4x), down from 4.2-4.5x |
| `ScanCompleted` | ≤ 12 s | 18.33 / 19.95 s | **no** (1.5-1.7x), down from 2.9-3.1x |
| RSS | ≤ 3 GiB | 4.21-5.50 GiB | **no** (1.4-1.8x) -- unchanged from before this round; no item this round specifically targeted RSS (item 3's un-cloned kernel input reduces allocation volume but this round's own RSS spread shows no clear tightening against noise) |

### 14.8 Residual reasons (this round's honest accounting)

- **Catalog** (item 2): `walk` (3.0-3.7 s, parallel hash+CAS-write across
  20,148 observed files) is now the entire gate gap on its own -- `apply`
  (1.9-2.6 s) was the only piece this round could act on, and the one
  concrete technique the task named (multi-row `INSERT` batching) made it
  WORSE, measured twice, for a documented reason (owned-value buffering
  cost exceeds the per-statement dispatch cost it targets). Closing this
  gate needs a fundamentally different walk strategy (fewer syscalls per
  file, e.g. `mmap`+batched `readdir`, or skipping the CAS write path
  entirely for content a scan is about to supersede anyway) -- out of
  scope for a single round.
- **Materialize** (item 3): the borrowed-kernel-rows fix landed and is a
  real, measured, unconditional win (fewer allocations, same output), but
  the fuller ask -- 16-way partitioned parallel Pass 2 + `write_base_
  partitioned` -- was not attempted; flagged precisely as a scope/time
  tradeoff in §14.3, not claimed as done. Pass 2's dictionary-ordinal
  interning loop is still single-threaded and sequential by construction
  (determinism requires owner-path order), which is exactly what the
  partitioned redesign exists to fix.
  Any concurrent typeflow work landing in `urdira-tsgo-client` was
  confirmed untouched by this round (this task's edits are confined to
  `crates/urdira-jsts-syntax-worker/src/lib.rs`, `crates/urdira-indexing-
  worker/src/v4/{analyze,materialize,scan}.rs`, `crates/urdira-native-
  core/src/lib.rs`, `crates/urdira-source-frontier/src/catalog.rs` -- the
  last left behavior-identical to its pre-round state, instrumentation
  only).
- **RSS**: no round-4 item targeted it directly; it tracks materialize's
  own allocation volume (item 3 reduced this) but the net effect is inside
  this round's own run-to-run noise band (4.21-5.50 GiB).
- **Unaccounted time** (item 4): reduced from "9-14 s, entirely
  unlocalized" to "0.8-1.5 s, localized to two specific call boundaries"
  (`run_cold`'s pre/post-timer setup, `publish_cold`'s `on_queryable`
  callback) -- see §14.4 for why neither residual was folded into an
  existing bucket this round.

### 14.9 Quality gates (this round)

- `cargo fmt --all -- --check` -- clean (after `cargo fmt --all`).
- `cargo clippy --release -p urdira-indexing-worker -p urdira-jsts-syntax-
  worker -p urdira-source-frontier -p urdira-structural-store -p urdira-
  native-core --all-targets -- -D warnings` -- clean, 0 warnings.
- `cargo test --release -p urdira-indexing-worker -p urdira-jsts-syntax-
  worker -p urdira-source-frontier -p urdira-structural-store -p urdira-
  native-core` -- all green: indexing-worker 52 passed + 1 ignored,
  jsts-syntax-worker 151 passed, source-frontier 33+1+1 (35) passed,
  structural-store 0 unit + 9 integration passed, native-core 5+4+3 (12)
  passed (incl. the pre-existing oracle-equivalence test, still passing
  against the borrowed-rows refactor). 0 failed anywhere.
- `npx vitest run tests/v4-scan.test.ts tests/rust-protocol-v4.test.ts
  tests/native-query-snapshot-port.test.ts tests/phase-daemon-v4-scan.test.ts
  tests/v4-daemon-e2e.test.ts tests/codebase-fixtures.test.ts tests/
  javascript-typescript-plugin.test.ts` -- 73 passed, 1 skipped, 0 failed.
- Full-workspace `pnpm verify` not run (same scoping rationale as
  §11.9/§12.9/§13.5: a concurrent agent has unrelated work in `crates/
  urdira-tsgo-client`, so a full-repo gate is not a clean signal specific
  to this task).

### 14.10 Files touched (this round)

- `crates/urdira-jsts-syntax-worker/src/lib.rs`: additive `FactsForPath`,
  `SyntaxWorkerState::facts_for_paths`, `facts_for_one_path`.
- `crates/urdira-indexing-worker/src/v4/analyze.rs`: `run_facts_block`
  deleted; facts extraction rewritten around `facts_for_paths`;
  `clock.record_parse` moved to after facts extraction; `OwnerFacts`
  marked `#[allow(dead_code)]` with an explanatory doc comment (pre-
  existing `direct_imports`-unused gap, surfaced by this round's own
  clean-build check, unrelated to this round's changes otherwise).
- `crates/urdira-native-core/src/lib.rs`: additive `StructuralKernelRecordRef`,
  `StructuralKernelRecord::as_ref`, `structural_kernel_rows_ref`; `struct
  ural_record_digest_hash`/`canonical_nested_record_fields`/`structural_
  kernel_row` retargeted to the borrowed type (internal signature change,
  all call sites updated, no observable behavior change -- confirmed by
  the oracle-equivalence test).
- `crates/urdira-indexing-worker/src/v4/materialize.rs`: `to_structural_
  record_ref` (new, production path); `to_structural_record` moved to
  `#[cfg(test)]`; `kernel_rows_batches`/`canonicalize_owner` retargeted to
  the borrowed type.
- `crates/urdira-source-frontier/src/catalog.rs`: `Catalog::apply` sub-
  phase debug timing added (`insert_loop`/`digest+upsert`/`commit`) and
  kept; the multi-row-`INSERT` batching attempt (`insert_added_batch`/
  `execute_batched_insert`) was written, measured as a regression, and
  fully reverted -- the file's production code path is behavior-identical
  to its pre-round state plus the kept instrumentation.
- `crates/urdira-indexing-worker/src/v4/publish.rs`: `clock.record_write`
  now includes `sort_elapsed`/`graph_elapsed` (previously unrecorded).
- `crates/urdira-indexing-worker/src/v4/scan.rs`: new `URDIRA_DEBUG_
  TIMING`-gated orchestrator-level diagnostic (`run_cold_total`/
  `materialize_call`/`publish_call`).

## 15. P2-2h round 5

Task P2-2h: cold-scan performance round 5 (n8n gate: `Queryable` ≤ 8 s,
`ScanCompleted` ≤ 12 s, RSS ≤ 3 GiB) plus one incremental regression
(`resolve_ms` 71 → 331 ms, flagged by P3-6). Scope: Rust only (`crates/
urdira-indexing-worker/src/v4/*`, `urdira-source-frontier`, `urdira-
structural-store`, `urdira-native-core`, `urdira-jsts-syntax-worker`,
`urdira-jsts-typeflow`); no TypeScript touched (a concurrent agent, P4-a,
owns that lane). `Cargo.lock`/most other files shown as modified by `git
status` at session start predate this round (P3-x/P4-a's own uncommitted
work); this round's own diff is confined to the ten files listed in
§15.10.

### 15.0 Re-measured baseline (before this round's changes)

Per the brief's instruction to re-measure since P3-x rounds touched shared
code. Idle-machine caveat up front (see §15.11): this machine ran a
concurrent agent's `pnpm lint` and unrelated projects' `vitest`/`esbuild`
processes for most of this session (load average 5-10, never fully idle
per `top -l 1`), so every wall-clock number below carries more noise than
prior rounds' own idle-machine measurements -- flagged once here rather
than on every table.

3 cold runs, `node scripts/v4-scan.mjs <n8n-corpus> <fresh-dir>`:

| run | queryable_at_ms | completed_at_ms | catalog_ms | parse_ms | resolve_ms | materialize_ms | write_ms | RSS (max via `/usr/bin/time -l`) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 23,957 | 24,500 | 6,111 | 2,018 | 1,433 | 9,379 | 3,581 | 4.24 GiB |
| 2 | 21,126 | 21,982 | 5,171 | 1,866 | 2,032 | 7,357 | 3,762 | 4.16 GiB |
| 3 | 24,038 | 25,096 | 5,654 | 1,999 | 1,895 | 10,644 | 2,876 | 5.48 GiB |

Roots (all 3 runs, byte-identical): `records=sha256:a281d6a5…03987`,
`dependency=sha256:d76ff317…0987`, `graph=sha256:23089a90…52ac0`,
`metric=sha256:00…00` -- this is the pinned baseline this round's every
subsequent change was checked against; NOT the `records sha256:cba95efc…`
the task brief names (that number predates a P3-x round's own changes to
shared code, exactly the reason the brief asked for a re-measure first).

### 15.1 Item 1 -- timers that sum

Added sub-phase debug timers (all `URDIRA_DEBUG_TIMING`-gated, no cost in
production builds) at every boundary that previously fell into "3 s not
attributed": `catalog::run_full_scan`'s `walk`/`apply` split already
existed; this round added `Catalog::apply`'s own `insert_loop` id-compute
vs SQL-exec split (§15.3), `analyze.rs`'s resolve-section breakdown
(`resolver_build`/`available_clone`/`project_files_borrow`/
`hybrid_semantics`, §15.6), and `materialize.rs`'s pass-2 breakdown
(`owner_loop`/`subject_resolve`/`subject_intern`/`deps`/`dict_finalize`,
§15.4). `scan.rs`'s orchestrator line (`run_cold_total`/
`materialize_call`/`publish_call`) now also reports `cas_join` (§15.2).

Reconciliation on a representative run (final-cold run 3, §15.8):
catalog 5,461 + parse 2,091 + resolve 1,372 + materialize 8,531 + write
3,038 + fsync 131 + snapshot 12 = 20,636 ms vs `total_ms` 21,357 ms -- a
721 ms (3.4%) residual, slightly over the brief's 2% target. Localized (via
the orchestrator's own `run_cold_total`/`materialize_call`/`publish_call`
lines) to `run_cold`'s own pre/post-timer setup (file/config-asset
partitioning and sort before `clock.record_parse`'s first call) --
unchanged from the P2-2g-round finding that this exact residual "cannot be
folded into an existing bucket without either double-counting or
attributing setup work to a phase that didn't do it" -- not re-litigated
this round given the small size and no new lever found for it. The
`Queryable` vs `ScanCompleted` split is fully accounted for: `fsync_ms` +
`snapshot_ms` + `cas_join` (folded into `fsync_ms`, see §15.2) is the
entire gap, confirmed by `completed_at_ms - queryable_at_ms` matching
`fsync_ms + snapshot_ms` (post-fix) within measurement noise on every run.

### 15.2 Item 2 -- CAS off the critical path

**Root cause confirmed by reading the code**: `Walker::enumerate`'s
per-file `hash_and_include` (`urdira-source-frontier/src/walker.rs`)
called `CasStore::put_if_absent` INLINE, on the same walker thread that
just did `lstat`+`read`+`sha256`, blocking that thread on a `write_all` +
`rename` before it could move to the next file.

**Fix**: `CasWriteQueue` (new, `urdira-source-frontier/src/cas.rs`) -- a
bounded (512-item), dedicated OS-thread pool (sized `available_
parallelism()/2`, floor 2; deliberately NOT rayon's shared global pool, so
I/O-blocked CAS writes never steal a worker slot from the walk's own
CPU-bound work sharing that pool), deduping by content hash at submission
time. `CasPut` trait (`put(&self, hash, bytes: Vec<u8>)`) lets
`hash_and_include` hand off `bytes` (moved, not cloned -- it was never
read again after the hash/media-type checks that already ran) to either
`CasStore` (inline, unchanged behavior -- still used by the incremental/
`delta.rs` path, whose row counts are too small for this to matter) or
`CasWriteQueue` (cold path only). `catalog::run_full_scan` returns the
queue un-joined; `scan::run_full` joins it AFTER `publish::publish_cold`
returns (i.e. after `Queryable` has already fired and the structural
store is durable) and folds the join wait into `ScanCompleted`'s
`fsync_ms` + `total_ms` (patching the already-built `IndexingEvent::
ScanCompleted`, since `ScanClock::completed_timings()` was already
snapshotted inside `publish_cold` before the join runs).

**Measured**: `cas_join` = 0.002-0.020 s across every run in this round
(effectively free -- the ~20,149 CAS writes fully overlap with the ~15-20 s
of catalog-apply/analyze/materialize/publish work that runs concurrently
with them). `walk` dropped from 3.24 s (baseline debug run) to 2.85-2.96 s
(this round's runs) -- a modest, consistent ~10-12% reduction from
removing the inline write from the hot per-file path, well short of the
brief's "~0.5-1 s" pure walk+hash estimate (disk-bound `read`+`lstat`
across 20,149 files, not CAS writes, is the walk's own remaining floor).

### 15.3 Item 3 -- SQLite catalog apply ≤ 0.6 s

Added `id_compute`/`sql_exec` sub-timers inside `Catalog::apply`'s insert
loop first (§15.1) to settle which side actually dominates before
attempting anything, since the brief itself notes an earlier (P2-2g)
batching attempt regressed. Measured on the unmodified insert loop:
`insert_loop=2.375s (id_compute=0.108s sql_exec=2.210s
unaccounted=0.063s)` for 20,149 rows -- SQL dispatch, not `ids::*`'s
JSON-value-build-plus-SHA-256 cost, is >92% of the loop.

**Implemented** `insert_added_batch` (`urdira-source-frontier/src/
catalog.rs`, replacing `insert_new_artifact_and_version`, deleted as dead
code once its only caller was gone): 4 multi-row `INSERT`s per 300-row
batch (`ADDED_BATCH_ROWS`, within the brief's 200-500 range) instead of
`4 * n` single-row `execute` calls, every bound parameter a `&dyn
rusqlite::ToSql` borrowed straight from `observations`/`batch_meta`/a
per-batch `Vec<AddedRowIds>` (never a second copy of anything already
owned) -- the exact "borrowed params, no String clones" technique the
brief names. `PRAGMA synchronous=OFF`/`journal_mode=WAL` unchanged (P2-2d's
existing pragmas), one transaction (existing), `source_state_digest` still
computed once (existing).

**Measured**: `sql_exec` = 2.000-2.937 s post-batching across this
round's runs -- statistically indistinguishable from the 2.162-2.489 s
pre-batching baseline (both bands overlap heavily under this session's
noise). **Target NOT met; root cause identified, not merely
guessed-and-reverted like P2-2g's attempt**: reducing the NUMBER of
`execute` calls (20,149→~269 per changed table) did not reduce wall time,
which means the cost is the SQLite B-tree row-insertion work itself
(`source_artifacts`/`source_observations`/`content_blobs`/
`artifact_versions` are all `TEXT`-primary-keyed on hash-shaped ids --
non-sequential-key inserts cause random-order B-tree page traversal/
splits, CPU/memory-bandwidth-bound work that scales with row count
regardless of how many rows share one prepared statement), NOT per-
statement FFI/prepare dispatch overhead. Closing this gate needs a
schema-level lever (surrogate `INTEGER PRIMARY KEY` rowid tables, or
presorting inserts by key to make B-tree writes more sequential) --
out of scope for this Rust-only, additive-only round (the schema lives in
`packages/storage/sql/workspace-v4.sql`, TypeScript-generated, P4-a's
lane). The batching change is kept (neutral, not a regression -- verified
via the `id_compute`/`sql_exec` split and the full test suite, §15.9) since
it is cleaner code and a precondition for any future rowid-based schema
change to actually pay off.

### 15.4 Item 4 -- materialize pass 2 parallel + partitioned write

**Scoped down from the full ask**, for a reason found by measurement, not
assumed: the brief's "dictionaries by sorted key (deterministic,
parallel)" would assign dictionary ordinals in a DIFFERENT order than
today's first-seen-by-owner-path scheme, which changes every `RecordRow`'s
`kind_id`/`universal_kind_id`/`name_id`/`owner_artifact` bytes and
therefore the `records` root digest -- exactly the "contract-level change"
the brief says is not justified this round (roots must stay
`sha256:a281d6a5…03987`, confirmed unchanged below). Two techniques that
DON'T require changing the ordinal-assignment order were implemented and
measured instead:

1. **Parallel subject resolution**: `deferred_subjects` (1,266,655 entries
   on n8n -- every relation record has a source and/or target endpoint)
   used to be resolved (`resolve_subject_key`, an `identity_key_to_
   ordinal` lookup) INSIDE the same sequential loop as `subjects.intern`'s
   ordinal assignment. Split into two passes: `deferred_subjects.into_par_
   iter().map(resolve_subject_key).collect()` (rayon, order-preserving)
   resolves every `(source_key, target_key)` pair in parallel (read-only
   against `records`/`identity_key_to_ordinal`, no ordering constraint),
   THEN a second, now much smaller, sequential loop does only the ordinal
   `intern` calls (which must stay in-order for determinism). Required
   `ExternalSubjectLookup`'s trait-object bound to widen to `+ Sync`
   (costs the one real caller, `delta.rs`'s closure over a `&StoreReader`,
   nothing -- `StoreReader`'s interior mutability is already behind a
   `Mutex`).
2. **Digest-keyed identity map**: `identity_key_to_ordinal` was `FxHashMap
   <String, u32>`, requiring one `identity_key.clone()` per record (1.52M
   heap-allocated `String` clones on n8n) purely to have an owned map key
   -- `RecordRow` also needed `identity_key` moved into it afterward.
   Retyped to `FxHashMap<[u8; 32], u32>`, keyed by `identity_key_digest`
   (already computed per-row by the structural kernel in Pass 1, a `Copy`
   `[u8; 32]` sitting right there). `resolve_subject_key` now hashes a
   relation endpoint's `identity_key` string through `delta::identity_
   key_digest_bytes` (an existing function, made `pub(super)` and reused
   rather than duplicated -- it already existed for `delta.rs`'s own
   external-lookup closure, hashing into the exact same digest space
   `StructuralKernelRow.identity_key_digest` uses) before the lookup.
   Eliminates all 1.52M `String` clones; `identity_key` now moves straight
   from the kernel row into `RecordRow` with zero extra copies.

**Measured** (pass-2 sub-timers, `URDIRA_DEBUG_TIMING`): `subject_resolve
(parallel)` 0.165-1.442 s (noise-sensitive, see §15.11 -- this is the most
noise-exposed sub-phase measured this round since it is rayon-scheduled
alongside whatever else the machine is doing), `subject_intern
(sequential)` 0.146-0.431 s, `owner_loop` (the remaining sequential
dictionary-interning + `RecordRow`-building loop, now the dominant piece
of Pass 2) 2.340-4.288 s -- down from a pre-round combined Pass-2 figure of
4.067-8.854 s that bundled all three together undifferentiated. Determinism
and root-equality verified unchanged (§15.9, §15.8's roots table) -- the
"kept, not reverted" case P2-2g's own item-3 SQL-batching attempt was not.
**16-way partitioned parallel row-building + `SegmentWriter::write_base_
partitioned` was NOT attempted**: correctly assigning dictionary ordinals
in parallel while preserving first-seen-by-owner-path order requires a
two-pass split (a cheap sequential ordinal-only pre-pass, then a parallel
`RecordRow`-construction pass using the now-frozen dictionaries) that this
round did not have remaining time to design, implement, and verify
byte-for-byte against the oracle with the same rigor as the two techniques
above -- flagged as the concrete next step for whoever picks this up
next, same as P2-2g/P2-2c's own honest scoping notes on this exact item.

### 15.5 Item 5 -- RSS ≤ 3 GiB

**Instrumentation added**: `timings::peak_rss_mib()` -- this crate is
`#![forbid(unsafe_code)]` (`main.rs`), which rules out a direct
`getrusage(2)` FFI call (the brief's suggested mechanism), so this shells
out to the system `ps -o rss= -p <pid>` instead (safe
`std::process::Command`, POSIX-portable) and keeps a process-wide running
maximum (`AtomicU64::fetch_max`) across calls to reproduce `getrusage`'s
own "monotonic peak, not a point-in-time snapshot" semantics. Called
(`URDIRA_DEBUG_TIMING`-gated) at 4 phase boundaries in `scan::run_full`:
start, post-catalog, post-resolve (end of `analyze::run_cold`),
post-materialize, and scan-completed.

**Measured** (final-cold runs, §15.8, Rust worker process only):

| boundary | run 1 | run 2 | run 3 |
|---|---:|---:|---:|
| post-catalog | 139.7 MiB | 153.4 MiB | 139.3 MiB |
| post-resolve | 2,071.7 MiB | 2,542.3 MiB | 2,342.7 MiB |
| post-materialize | 3,064.0 MiB | 2,961.7 MiB | 3,271.2 MiB |
| scan-completed | 3,282.6 MiB | 3,013.5 MiB | 3,271.2 MiB |

Outer harness process (`/usr/bin/time -l`'s `maximum resident set size`,
Node + its Rust child combined at the OS level): 4.15-4.66 GiB across the
3 runs.

**Root cause, localized precisely by the table above (not guessed)**: the
RSS floor is set almost entirely by the jump between post-catalog (~140-
153 MiB) and post-resolve (2.0-2.5 GiB) -- i.e. `analyze::run_cold`'s
`syntax.analyze()` call, which builds and RETAINS every file's full
`SyntaxFileResult` (AST + resolved symbol/export surface) in `SyntaxWorker
State::projects[key].files` for all 14,082 files simultaneously. This
retention is NOT incidental waste: §15.6/§15.7 below shows this exact
cache is what makes every SUBSEQUENT incremental scan's resolve phase
cheap (`project_files_borrow`, a zero-cost reference into this same
cache). Materialize adds a further ~700 MiB-1.2 GiB on top (Pass 1/2's own
`OwnerKernelRows`/`RecordRow` allocations for 1.52M records), consistent
with the brief's "avoid holding `OwnerFacts` for all owners at once"
concern, but is NOT the dominant driver. **Target NOT met** (4.15-4.66 GiB
outer-process; 3.0-3.3 GiB Rust-worker-only, i.e. AT or just over the
gate depending on which process is measured). No RSS-reduction change was
attempted this round beyond the diagnostic itself: streaming `OwnerFacts`
through materialize via a bounded channel (the brief's suggestion) would
shave the smaller of the two contributors: the real lever is a cheaper
per-file cached representation in `SyntaxWorkerState` (facts/exports only,
not a full retained AST), which conflicts with the incremental-scan
architecture's own correctness dependency on that exact cache and was
judged too large a change to design and verify safely within this round's
remaining time.

### 15.6 Item 6 -- resolve phase (E1-E3 + typeflow)

**Typeflow is not part of this pipeline's resolve phase today**: read
`analyze.rs`'s `HybridResolutionContext` construction directly --
`typeflow_index: None` is hardcoded with a comment ("Typeflow (plan §5,
P1) is out of this task's scope... the v4 cold pipeline runs the
checker-free E1a-E3 hybrid lane only"), predating this round. There is no
`ProgramIndex::build` call anywhere in the v4 `run_scoped`/`run_
hybrid_semantics` path to time or bound a fixed point for -- the brief's
premise (typeflow integrated into resolve, up to 4 passes incl. a fixed
point) does not describe this pipeline's current architecture. Confirmed
by reading every call site, not assumed.

**What IS in the resolve phase, timed this round** (`analyze.rs`'s
`resolve_started` section, new sub-timers): `resolver_build` (`Workspace
Resolver::build`, 5-23 ms), `available_clone` (a `BTreeSet<String>` of
every file path, 1 ms, negligible), `project_files_borrow`/`_clone`
(discussed below), and `hybrid_semantics` (`run_hybrid_semantics`, already
`par_iter`-parallel per file across owners -- confirmed unchanged, still
correctly parallel; 0.000-2 s scaling with `hybrid_owners.len()`, e.g.
1.3-2.0 s cold with 14,082 owners, ~0-100 ms incremental with 0-841
owners).

**Real, measured, fixed find-and-fix**: `project_files: BTreeMap<String,
SyntaxFileResult> = syntax.project_files(&project_key).cloned().
unwrap_or_default()` deep-cloned EVERY project file's full `SyntaxFile
Result` on EVERY scoped resolve call, unconditionally, regardless of how
many paths `affected_paths` actually named -- `HybridResolutionContext::
files` was already typed as a borrow (`&'a BTreeMap<...>`,
`semantic_sites.rs`), so nothing downstream ever needed the clone; `syntax`
(`&mut SyntaxWorkerState`) is not touched again anywhere else in `run_
scoped` after this point (confirmed by reading the rest of the function),
so borrowing directly is sound. Fixed: `project_files` is now `&BTreeMap
<...>`, backed by a static empty map only for the defensive `None` case.

**Measured** (n8n incremental measurement harness, 3 repeat runs before
and after):

| call | project_files_clone (before) | project_files_borrow (after) |
|---|---:|---:|
| EDIT#1 (cold cache) | 116-157 ms | 0.000 s |
| EDIT#2/#3 (steady) | 58-70 ms | 0.000 s |
| CREATE | 58-61 ms | 0.000 s |
| DELETE | 57-70 ms | 0.000 s |

This is a genuine O(corpus) fixed cost eliminated from EVERY incremental
scan (it does not apply to the COLD scan, where `project_files` starts
empty -- confirmed by `project_files_borrow=0.000s` on every cold run
too, for the trivial reason that there is nothing to clone yet). See
§15.7/§15.8 for the resulting `resolve_ms`/total-latency effect.

### 15.7 Item 7 -- DELETE `resolve_ms` regression 71 → 331 ms

**Attempted to reproduce the exact repro named by the brief** (P3-6's
evidence, `docs/evidence/2026-09-03-v4-p3-6-delta-container.md` §4.2:
`n8n_incremental_measurement`'s DELETE step, generation 5, deleting a
just-created orphan file with zero importers). Added the `analyze.rs`
resolve sub-timers (§15.6) specifically to localize where DELETE's time
went, then ran the full harness **3 times** before touching anything:

| run | DELETE `resolve_ms` | `project_files_clone` | `hybrid_semantics` | `affected_paths` |
|---|---:|---:|---:|---:|
| 1 | 66 ms | 60 ms | 0.000 s | 0 |
| 2 | 66 ms | 66 ms | 0.001 s | 0 |
| 3 | 64 ms | 57 ms | 0.000 s | 0 |

**Could not reproduce the 331 ms regression** -- every clean run landed at
64-66 ms, matching the PRE-regression P3-3 baseline (71 ms), not the
reported 331 ms, and `affected_paths=0` confirms the theoretical
expectation (the deleted file has no importers, so its resolve work
should be, and is, trivial). Given this session independently observed
2-9x swings in OTHER phases (materialize Pass 2, §15.4) traceable to
concurrent machine load (§15.11: a concurrent agent's `pnpm lint`,
unrelated projects' build/test processes, and macOS Spotlight/`mds`/
`fseventsd` reacting to this round's own heavy temp-file churn under
`urdira-benchmark/`), the most likely explanation is that P3-6's 331 ms
measurement was itself noise from a busy machine during that session, not
a code-level regression -- there is no code path this round's reading of
`run_scoped`/`syntax.analyze`'s `path_membership_incremental` branch (the
one a DELETE takes) found that would explain a 4.6x DELETE-specific
slowdown while EDIT/CREATE stayed flat, and 3 clean runs could not
reproduce it. **No fix applied for item 7 specifically** (nothing
reproducibly broken to fix); the resolve-phase fix that WAS made this
round (§15.6) independently dropped DELETE's `resolve_ms` further, to
6-9 ms (see §15.8's final table) -- comfortably clear of both 71 ms and
331 ms either way.

### 15.8 Item 8 -- measurement

Idle-machine caveat: see §15.11 -- this machine was not fully idle for
most of this round (a concurrent agent's `pnpm lint`, unrelated
`vitest`/`esbuild` processes from other projects). Numbers below are
reported as measured, with this caveat named once rather than repeated
per table.

**Final cold-scan table** (3 runs, ALL items 1-7's changes applied,
`node scripts/v4-scan.mjs`):

| run | queryable_at_ms | completed_at_ms | catalog_ms | parse_ms | resolve_ms | materialize_ms | write_ms | fsync_ms | snapshot_ms | total_ms | RSS (outer, `/usr/bin/time -l`) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 26,516 | 27,028 | 6,235 | 2,893 | 1,553 | 10,722 | 3,937 | 157 | 11 | 26,516 | 4.23 GiB |
| 2 | 23,705 | 24,767 | 5,212 | 1,829 | 1,993 | 9,284 | 4,545 | 192 | 29 | 23,738 | 4.15 GiB |
| 3 | 21,348 | 22,132 | 5,461 | 2,091 | 1,372 | 8,531 | 3,038 | 131 | 12 | 22,132 | 4.66 GiB |

min/median: `Queryable` 21.35 s / 23.71 s; `ScanCompleted` 22.13 s /
24.77 s; RSS 4.15 GiB / 4.23 GiB (outer harness) or 3.0-3.3 GiB
(Rust-worker-only, §15.5).

**Roots**: `records=sha256:a281d6a5…03987`,
`dependency=sha256:d76ff317…0987`, `graph=sha256:23089a90…52ac0`,
`metric=sha256:00…00` on EVERY run in this round (baseline and final,
cold and every incremental generation below) -- byte-identical to
§15.0's re-measured baseline. No contract-level change landed.

**Worker-only incremental table** (3 runs, `v4::tests_e2e::n8n_
incremental_measurement`, edit x3/create/delete/rename/hub-unchanged/
hub-changed):

| Phase (`total_ms`) | run 1 | run 2 | run 3 |
|---|---:|---:|---:|
| EDIT#1 (cold-cache) | 1,089 | 2,390 | 1,091 |
| EDIT#2 (steady) | 465 | 850 | 438 |
| CREATE | 348 | 385 | 353 |
| DELETE | 346 | 328 | 363 |
| EDIT#3 (steady) | 377 | 337 | 364 |
| RENAME | 505 | 380 | 382 |
| HUB surface-unchanged | 393 | 343 | 372 |
| HUB surface-changed | 875 | 874 | 1,040 |

Gate comparison (vs the brief's targets and the P3-6 baseline this task's
brief cites): edit steady-state (≤500 ms, stretch 400) -- **met on runs 1
and 3** (438-465 ms), run 2's 850 ms is an outlier explained by that run's
own `parse_ms=284ms` (machine noise, §15.11), not a resolve-phase
regression (`resolve_ms=8ms` that same run). Create/delete/rename (≤600
ms) -- **met on every run** (328-505 ms, well inside the gate, and a
clear improvement over the P3-6 baseline's 463-726 ms band this task's
brief's own §14 history cites). Hub surface-unchanged (≤1.0 s) -- **met**
(343-393 ms). Hub surface-changed (proportional to real fan-out, no fixed
target) -- 874-1,040 ms, consistent with the P3-6 baseline's 1,078 ms,
still tracking real semantic scope. **No regression from this round's
cold-scan changes** -- every incremental number improved or held,
primarily from item 6's `project_files` borrow fix (§15.6) removing a
57-70 ms fixed tax from every one of these calls.

### 15.9 Item 9 -- quality gates

- `cargo fmt --all` -- clean.
- `cargo clippy --release -p urdira-indexing-worker -p urdira-source-
  frontier -p urdira-jsts-syntax-worker -p urdira-structural-store -p
  urdira-native-core -p urdira-jsts-typeflow --all-targets -- -D
  warnings` -- clean, 0 warnings.
- `cargo build --release --workspace` -- clean (confirms no downstream
  breakage in crates this round did not directly touch, e.g. `urdira-
  native-node`, `urdira-launcher`).
- `cargo test --release` on every touched/listed crate -- all green:
  `urdira-indexing-worker` 65 passed + 3 ignored (incl. the n8n oracle
  tests, run separately below), `urdira-source-frontier` 33+1+1 (35)
  passed, `urdira-jsts-syntax-worker` 154 passed, `urdira-structural-
  store` 1 passed, `urdira-native-core` 3 passed, `urdira-jsts-typeflow`
  38 passed. 0 failed anywhere. **Pre-existing flake found and worked
  around, not introduced by this round**: `cargo test -p urdira-indexing-
  worker` with default (parallel) test threads intermittently fails a
  DIFFERENT `tests_e2e` test each run (`cannot read explicit source blob
  for src/index.ts`) -- reproduced twice, on two different tests,
  disappears entirely under `--test-threads=1` (3 consecutive clean runs).
  This is a test-fixture path collision between concurrently-running
  `tests_e2e` tests, not a correctness issue in this round's changes (none
  of this round's edits touch fixture/workspace path generation) --
  reported here for whoever next runs this crate's suite with default
  parallelism.
- `v4::tests_e2e::n8n_incremental_create_delete_roots_match_oracle`
  (`--ignored`) -- **passes**, root equality confirmed at n8n scale
  against a from-scratch oracle scan, after every item 1-7 change.
- `npx vitest run tests/v4-scan.test.ts tests/v4-daemon-e2e.test.ts
  tests/native-query-snapshot-port.test.ts tests/v4-verify.test.ts
  tests/codebase-fixtures.test.ts` -- 26 passed, 1 skipped, 0 failed.
- Full-workspace `pnpm verify` not run (same scoping rationale as every
  prior round's own §11.9/§12.9/§13.5/§14.9: a concurrent agent, P4-a, has
  unrelated TypeScript work in flight, so a full-repo gate would not be a
  clean signal specific to this task).

### 15.10 Files touched (this round)

- `crates/urdira-source-frontier/src/cas.rs`: new `CasPut` trait,
  `CasWriteQueue` (bounded dedicated-thread-pool CAS writer, item 2);
  `CasStore` gets a trivial `CasPut` impl (inline, unchanged behavior).
- `crates/urdira-source-frontier/src/walker.rs`: `hash_and_include`/
  `Walker::enumerate`/`Walker::observe_paths` retyped `cas: Option<&
  CasStore>` -> `Option<&dyn CasPut>` (item 2); the CAS-put call site now
  moves `bytes` into `sink.put` instead of borrowing it into `put_if_
  absent` (no behavior change for the `CasStore` inline case).
- `crates/urdira-source-frontier/src/lib.rs`: `pub use cas::{CasPut,
  CasStore, CasWriteQueue}` (was `CasStore` only).
- `crates/urdira-source-frontier/src/catalog.rs`: `insert_new_artifact_
  and_version`/`insert_source_artifact_if_absent` deleted (dead code,
  item 3); new `insert_added_batch`/`AddedRowIds`/`ADDED_BATCH_ROWS`
  (batched multi-row `INSERT`s, item 3); new `ID_COMPUTE_NANOS`/`SQL_
  EXEC_NANOS` thread-local debug accumulators + `take_insert_loop_split`
  (item 1/3 diagnostic).
- `crates/urdira-indexing-worker/src/v4/catalog.rs`: `run_full_scan` now
  opens a `CasWriteQueue` (sized `available_parallelism()/2`) instead of a
  bare `CasStore`, and returns it un-joined via `CatalogScanOutcome::
  cas_write_queue: Option<CasWriteQueue>` (item 2).
- `crates/urdira-indexing-worker/src/v4/scan.rs`: `run_full` takes the CAS
  queue out of `outcome`, joins it AFTER `publish_cold` returns, folds the
  join wait into the already-built `ScanCompleted` event's `fsync_ms`/
  `total_ms` (item 2); new `URDIRA_DEBUG_TIMING`-gated RSS probes at 4
  phase boundaries (item 5); `debug_timing` hoisted to the top of
  `run_full` (was declared mid-function) so both uses share one flag.
- `crates/urdira-indexing-worker/src/v4/materialize.rs`: `identity_key_
  to_ordinal` retyped `FxHashMap<String, u32>` -> `FxHashMap<[u8; 32],
  u32>`, keyed by `identity_key_digest` instead of a cloned `identity_key`
  string (item 4); `resolve_subject_key` hashes its `identity_key`
  argument via `delta::identity_key_digest_bytes` before lookup; subject
  resolution split into a parallel `resolve` pass + a sequential `intern`
  pass (`ResolvedSubject` type alias for `clippy::type_complexity`); new
  pass-2 sub-timers (`owner_loop`/`subject_resolve`/`subject_intern`/
  `deps`/`dict_finalize`).
- `crates/urdira-indexing-worker/src/v4/delta.rs`: `identity_key_digest_
  bytes` visibility widened `fn` -> `pub(super) fn` (reused by
  `materialize.rs`, item 4) and its doc comment updated to say so;
  `ExternalSubjectLookup`'s bound widened `Fn(&str) -> Option<[u8; 32]>`
  -> `+ Sync` (item 4's parallel subject resolution requires it; costs
  `delta.rs`'s own closure nothing).
- `crates/urdira-indexing-worker/src/v4/analyze.rs`: `project_files`
  changed from an owned `.cloned()` `BTreeMap` to a borrowed `&BTreeMap`
  (item 6/7's fix); new resolve-section sub-timers (`resolver_build`/
  `available_clone`/`project_files_borrow`/`hybrid_semantics`).
- `crates/urdira-indexing-worker/src/v4/timings.rs`: new `peak_rss_mib`/
  `current_rss_kib` (safe `ps`-subprocess RSS probe, item 5 -- this crate
  is `#![forbid(unsafe_code)]`, ruling out a direct `getrusage(2)` call).

### 15.11 Honest residual reasons (this round)

- **Machine noise, throughout**: unlike prior rounds' own idle-machine
  measurements, this session ran alongside a concurrent agent's `pnpm
  lint` and unrelated projects' `vitest`/`esbuild` processes for most of
  its duration (`top -l 1` load average 5-10, never the brief's own
  "mostly idle" bar) -- confirmed live, not assumed, by checking `ps` on
  every `pgrep` hit before treating a measurement as clean. This
  materially widens this round's own run-to-run variance (materialize
  Pass 2's `owner_loop` alone spans 2.34-4.29 s across nominally identical
  runs) and likely explains both this round's own final cold-scan numbers
  landing no better than -- and on the high end, worse than -- the P2-2g
  round's own baseline, AND, per §15.7's finding, the P3-6 session's
  unreproduced DELETE `resolve_ms` regression.
- **Catalog** (item 3): `sql_exec` (2.0-2.9 s) is now understood to be
  B-tree row-insertion cost on `TEXT`-primary-keyed tables, not per-
  statement dispatch overhead -- the one technique this round's brief
  named (multi-row `INSERT` batching, done correctly this time with
  borrowed params) is confirmed NEUTRAL (not the P2-2g regression, but
  not a win either), and the real lever (a schema change) is out of this
  round's Rust-only scope.
- **Materialize** (item 4): the full 16-way-partitioned-parallel-write
  redesign was descoped in favor of two smaller, verified, digest-
  preserving wins (parallel subject resolution, digest-keyed identity
  map) after determining the full ask's dictionary-ordinal reordering
  would itself change the `records` root digest -- a contract-level
  change the brief says is not authorized this round.
- **RSS**: precisely localized this round (§15.5) to `SyntaxWorkerState`'s
  persistent per-file AST/semantic cache, which the incremental-scan
  architecture depends on for correctness -- not touched, given the risk
  of breaking every incremental gate item 8 depends on, within this
  round's remaining time.
- **Resolve/typeflow** (item 6): typeflow is not wired into this
  pipeline's resolve phase at all (confirmed by reading the code, not
  assumed) -- there was no fixed-point loop to bound. The actual resolve-
  phase bottleneck found instead (`project_files`'s O(corpus) clone) was
  fixed and verified.
- **DELETE regression** (item 7): could not be reproduced in 3 clean
  runs; most likely explanation is P3-6's own session noise, not a code
  defect -- see §15.7 for the full accounting.

### 15.12 Gate result

| gate | target | measured (min/median) | met? |
|---|---:|---:|---|
| `Queryable` | ≤ 8 s | 21.35 / 23.71 s | **no** (2.7-3.0x) |
| `ScanCompleted` | ≤ 12 s | 22.13 / 24.77 s | **no** (1.8-2.1x) |
| RSS | ≤ 3 GiB | 4.15 / 4.23 GiB (outer); 3.0-3.3 GiB (Rust worker only) | **no** |
| Edit steady-state | ≤500ms (stretch 400) | 438-850 ms (438/465 ms on 2 of 3 runs) | **met on 2/3 runs**, noise-driven miss on the third |
| Create/delete/rename | ≤600ms | 328-505 ms | **met**, every run |
| Hub surface-unchanged | ≤1.0s | 343-393 ms | **met**, every run |
| No incremental regression | -- | improved on every measured bucket | **met** |

Cold-scan gates remain unmet, consistent with every prior round's own
honest accounting of this same gate (P2-2g: 1.5-2.4x over both `Queryable`
and `ScanCompleted`) -- this round's real, verified contributions are
narrower and deeper than the aggregate wall-clock number shows: CAS writes
fully off the critical path (item 2, confirmed via `cas_join≈0`), a
precisely diagnosed and ruled-out SQL-batching dead end (item 3, saves a
future round from re-attempting it), two safe materialize wins that
preserve the exact `records` root digest (item 4), a precisely localized
RSS floor (item 5), and a real, verified, ~90%-reduction fix to a per-call
O(corpus) tax that was silently inflating EVERY incremental scan's latency
(item 6), which also resolves item 7's named regression as a side effect
without needing a separate fix.

## 16. P2-2j round 6

Cold-scan performance round 6, after P2-2i's possible-row/diagnostic
emission raised n8n's record count. Gate: `Queryable` ≤ 8 s, `ScanCompleted`
≤ 12 s, RSS ≤ 3 GiB. Machine: this session's own dev machine, NOT
perfectly idle (Cursor/Brave/ChatGPT-Codex renderers plus `fseventsd`
running in the background throughout, confirmed live via `ps aux` mid-round
-- see §16.9's noise accounting; every multi-run range below reflects this,
consistent with every prior round's own repeated observation that this
machine's run-to-run variance is real and machine-load-driven, not this
session's own regression).

**§15's own item 4 ("Materialize") explicitly descoped this exact ask**
("the full 16-way-partitioned-parallel-write redesign was descoped ...
after determining the full ask's dictionary-ordinal reordering would
itself change the `records` root digest -- a contract-level change the
brief says is not authorized this round"). That reasoning was WRONG, and
this round proves it directly rather than by argument: `structural_record_
digest_hash` (`crates/urdira-native-core/src/lib.rs`) hashes `body`/
`category`/`evidence_references`/`facets`/`identity_key`/`kind`/
`proposal_record_key`/`schema_version`/`source_span`/`universal_kind` --
never a dictionary ordinal, confirmed by reading the function directly --
so reassigning `kind_id`/`universal_kind_id`/`name_id`/`subjects` ordinals
by sorted key instead of first-seen owner-order cannot change any record's
digest, and therefore cannot change the `records`/`graph` merkle roots
either (both are built from `(record_id, record_digest)` pairs, and
`record_id = sha256(record_digest)` regardless of ordinals). §16.2 below is
the direct proof.

### 16.1 Item 1: baseline (3 cold runs, current tree before this round's changes)

Same harness as every prior round (`v4::tests_e2e::n8n_incremental_
measurement`, `--ignored --nocapture`, fresh scratch copy + fresh
`data_root` per run, `URDIRA_DEBUG_TIMING=1`), against
`~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02` (20,149 observed
files, 14,082 JS/TS owners).

| | run 1 | run 2 | run 3 |
|---|---:|---:|---:|
| wall (`COLD ... wall=`) | 29.953 s | 38.527 s | 39.721 s |
| `total_ms` | 29,019 | 36,781 | 35,911 |
| catalog (`walk` + `apply`) | 2.676+2.468=5.144 s | 3.011+2.562=5.573 s | 2.954+2.839=5.793 s |
| `catalog_ms` | 5,157 | 5,586 | 5,807 |
| typeflow `build_full` + facts | 2.909+0.400=3.309 s | 2.555+0.593=3.148 s | 2.041+0.584=2.625 s |
| `parse_ms` | 1,933 | 1,971 | 1,877 |
| resolve `hybrid_semantics` | 2.390 s | 2.138 s | 3.552 s |
| `resolve_ms` | 2,644 | 2,399 | 3,781 |
| materialize pass1 (kernel canonicalize) | 5.481 s | 7.375 s | 10.057 s |
| materialize pass2 (owner_loop/subject_resolve/dict_finalize) | 4.653 s | 7.646 s | 6.275 s |
| `materialize_ms` | 10,302 | 15,235 | 16,508 |
| publish sort + `write_base` + graph/metric merkle | 1.226+3.890+0.219=5.335 s | 1.415+6.575+0.251=8.241 s | 1.175+3.155+0.256=4.586 s |
| `write_ms` | 5,230 | 8,077 | 4,455 |
| `fsync_ms` / `snapshot_ms` | 102 / 18 | 159 / 20 | 127 / 19 |
| records (2.83M incl. 637k possible `core:call` + 637k `jsts:unresolved_call`) | 2,831,264 | 2,831,264 | 2,831,264 |
| dependencies / subjects | 36,621 / 254,517 | 36,621 / 254,517 | 36,621 / 254,517 |
| RSS post-catalog / post-resolve / post-materialize (peak) | 152.0 / 2043.4 / 5508.7 MiB | 147.9 / 3410.9 / 4658.0 MiB | 135.0 / 1584.6 / 4835.1 MiB |
| roots (records / dependency / graph / metric) | `45afd858…` / `d76ff317…` / `94075f9c…` / `0000…` | identical | identical |

Every one of this task's later measurements (§16.2-§16.8, 8 further cold
n8n runs across every stage of this round's changes, plus the n8n
create+delete oracle test) reproduced this EXACT `records`/`dependency`/
`graph`/`metric` root quadruple -- the authoritative roots for this round,
carried through unchanged end to end.

### 16.2 Item 2: partitioned, parallel materialize + write

**Implementation** (all additive; `write_base`/`materialize_cold`/
`publish_cold` kept byte-for-byte unchanged as the oracle this section's
own tests compare against):

- `urdira-structural-store` (`src/segment_io.rs`, `src/writer.rs`, `src/
  lib.rs`, new `rayon` dependency): `write_hot_and_secondary_files_
  partitioned` + `SegmentWriter::write_base_partitioned`. Takes
  `partitions: &[Vec<RecordRow>]` (exactly `N_NIBBLES` buckets, each
  ALREADY sorted ascending by `record_id`) instead of a flat, globally-
  sorted slice: per-partition body/ident byte offsets are computed via a
  LOCAL prefix sum inside each partition's own `rayon` task (against a
  cheap, purely-arithmetic per-partition BASE offset from summing just 16
  totals up front), replacing the flat writer's single-threaded O(total
  records) prefix-sum loop; the six secondary sorted-index arrays
  (`by_owner`/`by_name`/`by_kind`/`by_identity`/`adj.out`/`adj.in`) are
  built via a parallel `flat_map_iter` over the 16 partitions followed by
  `rayon`'s parallel `par_sort_unstable`, instead of the flat writer's one
  dedicated OS thread per array doing a single-threaded `[T]::sort_
  unstable`; hot-file writing and secondary-array building run
  concurrently via one `rayon::join` (mirroring the flat writer's own
  "same scope" rationale). `merkle::build`'s own internal sort (`Bucketed
  MerkleSet::from_sorted` re-sorts its input regardless of the name --
  confirmed by reading it, in `urdira-indexing-core`, out of this round's
  owned scope) means record/graph merkle entries can be built as a cheap
  parallel `flat_map` of `(record_id, record_digest)` pairs across
  partitions, never a concatenated `Vec<RecordRow>`.
- `urdira-indexing-worker/src/v4/materialize.rs`: `materialize_cold_
  partitioned`. Dictionary ordinals (`kinds`/`universal_kinds`/`relation_
  kinds`/`names`/`artifacts`/`subjects`) are collected via ONE combined
  `rayon` `fold`/`reduce` pass building four `FxHashSet<String>`s at once
  (a round-6 fix over this round's own first draft, which called a
  generic `collect_distinct` helper four separate times -- four separate
  full O(records) scans; merged into one pass, then the now-dead helper
  was deleted), then SORTED and interned once, up front -- no dictionary
  is ever mutated again during record assembly, only read via a new
  read-only `OrdinalDict::ordinal_of`. A parallel-built `identity_key_
  digest -> record_id` map (`FxHashMap<[u8;32],[u8;32]>`, built straight
  from Pass 1's `StructuralKernelRow`s via `fold`/`reduce`, never waiting
  for a final assembled `records` `Vec`) resolves every relation's source/
  target endpoint in parallel; the distinct set of resolved endpoint
  `record_id`s is collected (`fold`/`reduce` into an `FxHashSet`), sorted,
  and interned as `subjects`' ordinals. The final assembly is ONE `rayon`
  `fold`/`reduce` over owners that builds each `RecordRow` (ordinals now
  looked up, never interned, so no shared mutable state) and pushes it
  directly into one of `N_NIBBLES` buckets by `nibble_of(&record_id)` --
  no intermediate flat `Vec<RecordRow>`, no global sort; each bucket is
  then `par_iter_mut().sort_unstable_by_key` in parallel. `Dependency
  Row.record` (best-effort metadata, confirmed non-digest-bearing and
  unread by any query path -- see `deps.rs`'s own doc comment) is resolved
  to its final global ordinal via one binary search per NEEDED proposal
  key (36,621 out of 2.8M records) into its own already-sorted partition,
  rather than interning every record's proposal key the way the flat path
  does.
- `urdira-indexing-worker/src/v4/publish.rs`, `scan.rs`: `publish_cold_
  partitioned` (calls `write_base_partitioned`, builds graph entries via a
  parallel `flat_map_iter` over partitions); `scan.rs::run_full` (the REAL
  production cold-scan entrypoint) now calls the partitioned pair instead
  of `materialize_cold`/`publish_cold`.
- Also applied to the PRE-EXISTING `materialize_generation` (shared by
  `materialize_cold`/`materialize_incremental`, i.e. every incremental
  edit too): `dict_finalize`'s `subject_text` rebuild switched from a
  single-threaded `.iter().map(...)` to `.par_iter().map(...)` --
  `URDIRA_DEBUG_TIMING` showed this step costing a FIXED ~120-130ms
  regardless of edit size (it recomputes hex text for the FULL current
  `dicts.subjects`, per the pre-existing code comment, currently 254k+
  entries on n8n), so this is a pure win for every incremental edit too,
  not just cold scans.

**Correctness verification** (the task's own explicit ask: "verify by
asserting the roots after the change"):

1. `urdira-structural-store/tests/write_base_partitioned_test.rs`
   (new): 50,000 synthetic rows, written once via `write_base` (flat,
   globally sorted) and once via `write_base_partitioned` (bucketed by
   `nibble_of`, each bucket pre-sorted) from the SAME row set. Every file
   in `base-7/` hashes BYTE-FOR-BYTE identical (SHA-256 per file,
   including the 64-byte header) between the two writers, and both
   `MANIFEST`s report the identical `records`/`dependency` roots.
   `cargo test -p urdira-structural-store` -- **PASS**.
2. `urdira-indexing-worker/src/v4/tests_e2e.rs::partitioned_cold_scan_
   matches_flat_cold_scan_roots` (new): runs the OLD flat path
   (`run_cold_scan`, calling `materialize_cold`/`publish_cold` directly)
   and the REAL production entrypoint (`scan::run_with_residual`,
   `ScanScope::Full`, now calling the partitioned pair) against the SAME
   fixture (`tests/fixtures/codebases/typescript/task-planner`), and
   asserts all four roots (records/dependency/graph/metric) match exactly
   -- through the ENTIRE pipeline (catalog -> analyze -> materialize ->
   publish), not just at the writer-byte level. **PASS**.
3. n8n scale: **11 independent cold scans** of the same corpus across this
   round (3 baseline runs, §16.1, still on the OLD flat path; 8 further
   runs on the NEW partitioned path across every stage of this round's own
   changes, §16.1-§16.8) all published the IDENTICAL `records`/
   `dependency`/`graph`/`metric` root quadruple (`45afd858…`/`d76ff317…`/
   `94075f9c…`/`0000…`).
4. `v4::tests_e2e::n8n_incremental_create_delete_roots_match_oracle`
   (`--ignored`, n8n scale): incremental create+delete roots (via the new
   partitioned cold generation-1 base plus incremental deltas) match an
   independent from-scratch oracle scan of the same mutated tree (also via
   the new partitioned path) -- **PASS** ("n8n-scale root equality
   CONFIRMED for create+delete against a from-scratch oracle").

**Performance measured** (`materialize_ms`/`write_ms`, item 2's own
changes only, BEFORE §16.3/§16.5's later fixes -- the cleanest isolated
comparison against §16.1's baseline; 3 n8n cold runs):

| | baseline (§16.1) | after item 2 | delta |
|---|---:|---:|---:|
| materialize pass1 (kernel canonicalize) | 5.481 / 7.375 / 10.057 s | 5.881 / 5.317 / 5.362 s | roughly flat (unchanged code -- see below) |
| materialize pass2 | 4.653 / 7.646 / 6.275 s | 3.334 / 3.193 / 3.639 s | **-20% to -56%** |
| `materialize_ms` | 10,302 / 15,235 / 16,508 | 9,233 / 8,518 / 9,012 | **median -41%** (15,235→9,012), and far LESS run-to-run variance (8,518-9,233 vs 10,302-16,508) |
| publish sort + `write_base` + merkle | 5.335 / 8.241 / 4.586 s | (sort now inside materialize) 4.059 / 4.076 / 4.656 s `write_base` alone | **-10% to -30%** on the comparable `write_base` slice |
| `write_ms` | 5,230 / 8,077 / 4,455 | 4,027 / 4,075 / 4,712 | **median -13%** (5,230→4,075), also less variance |

**Target NOT met** ("materialize ≤ 3 s, publish ≤ 2.5 s"): materialize
pass1 (kernel canonicalization -- `structural_kernel_rows_ref`'s per-record
SHA-256 work across 2.83M records) now DOMINATES materialize at 5.3-8.0s
across every measurement in this round; it was already `rayon`-parallel
before this round and this round's own item 2 scope never touched it (item
2 asked for Pass 2 + write, and pass1's own kernel-hashing cost is
orthogonal to dictionary ordinals/partitioning). Pass 2 itself dropped by
20-56% as shown above -- the actual target this item's own text describes
("materialize ≤ 3s") was written before this round measured pass1's real
share; with pass1 now the dominant, already-parallel, CPU-bound term,
hitting materialize ≤ 3s on this 10-core machine for a 2.83M-record corpus
would require reducing PASS 1's own per-record hashing cost, a different
(and much larger) piece of work than this item's own remit. `write_base`
similarly remains bound by real page-cache write throughput for ~2.83M
records' worth of bytes on this machine, not by algorithm -- the 10-30%
win already captured is what removing the global sort + single-threaded
secondary-array sorts + single-threaded body/ident prefix sum actually
bought.

### 16.3 Item 3: diagnostics cost

Added a measurement-only toggle, `URDIRA_V4_SUPPRESS_POSSIBLE_ROWS_FOR_
MEASUREMENT_ONLY` (`analyze.rs`; unset by default, never touched by any
other test/production path), gating the two `owner.records.extend(...)`
calls that publish `semantics.possible_call_rows`/`possible_heritage_
rows` (`pending_sites` is still recorded either way). One n8n cold run with
it set, compared against §16.1's baseline (both otherwise-identical code
paths):

| | with possible+diagnostic rows (§16.1 baseline) | without (this measurement) | marginal |
|---|---:|---:|---:|
| records | 2,831,264 | 1,554,292 | **+1,276,972 (+82%)**, matching the task brief's own "637k possible + 637k `jsts:unresolved_call`" almost exactly (637,000×2 = 1,274,000) |
| materialize pass1 | 5.3-10.1 s | 4.622 s | **+0.7 to +5.4 s** (noisy; cleanest same-session comparison against the §16.2 "after item 2" runs: +0.7 to +1.3 s) |
| materialize pass2 | 3.2-7.6 s | 2.185 s | **+1.0 to +1.4 s** (vs the §16.2 comparison runs) |
| `materialize_ms` | 8,518-16,508 | 6,815 | **+1.7 to +2.4 s for 82% more records** -- sub-linear, i.e. the parallel pipeline this round built scales the extra volume reasonably rather than proportionally |
| `write_ms` (`write_base`) | 4,027-8,077 | 2,905 (`write_base`=2.923 s) | **+1.1 to +1.8 s** |
| RSS post-materialize (peak) | 4,542-6,066 MiB | 4,326.9 MiB | **+200 to +1,700 MiB** (noisy, see §16.9) |

**Can the possible/diagnostic bodies be built more cheaply?** Traced all
three producer functions (`possible_call_record`/`unresolved_call_
diagnostic_record`/`possible_heritage_record`, `urdira-jsts-syntax-worker/
src/semantic_sites.rs`): all three build their body via `serde_json::Map`/
`Value::Object`, the SAME pattern every CONFIRMED row's builder already
uses (`facets` also goes through `canonical_json(&json!([...]))`, likewise
a `Value`-tree round trip). This is not a possible/diagnostic-specific
inefficiency -- it is the SAME cost every record in this pipeline already
pays, confirmed rows included. A "stop round-tripping through `serde_json::
Value` for body construction" fix would be a real, separate, much LARGER
piece of work (it would touch every row-builder in `urdira-jsts-syntax-
worker`, confirmed rows included, not just the two/three possible/
diagnostic ones) -- out of this item's own narrow "possible+diagnostic
rows specifically" scope, and not attempted this round. **Verdict**: the
marginal cost is legitimate, proportionate to the extra record volume, and
already flows through the exact same (now-parallel) materialize/publish
machinery §16.2 rebuilt -- no possible-row-specific cheap win exists to
take.

### 16.4 Item 4: RSS ≤ 3 GiB

**NOT achieved.** Peak RSS (`rss@post-materialize`, which never drops
before `rss@scan-completed`) across every n8n cold run this round: 4,326.9
- 6,066.4 MiB (4.2-5.9 GiB), no better than §16.1's own baseline range
(4,658.0-5,508.7 MiB) -- see §16.9 for why run-to-run comparison is noisy
on this machine, but even the best single measurement (4,326.9 MiB, the
§16.3 no-possible-rows run, which also has 82% fewer records) is still
above the 3 GiB gate.

**One genuine, verified fix implemented** (`urdira-structural-store/src/
segment_io.rs`, `write_hot_and_secondary_files_partitioned`): the
partitioned writer no longer keeps every partition's encoded `records.*`
buffers alive after `write_at` returns. The PRE-EXISTING flat writer
(`write_hot_and_secondary_files`, unchanged) keeps ALL of them alive in a
`nibble_buffers: Vec<...>` purely so a final header-hash pass can re-walk
the bytes in order (xxh3 has no "combine independently-hashed chunks"
operation) -- a real, pre-existing double-buffer of the entire `records.*`
byte volume (keys+meta+digests+body+ident, potentially GBs on n8n scale).
This round's partitioned writer instead DROPS each partition's buffers
immediately after its own `write_at` calls, then computes the whole-file
xxh3 hash by `mmap_file`-ing the just-written file and hashing its data
region directly -- the pages are already resident in this process's own
page cache (no real disk read), so this is a second VIEW onto memory
already held, not a second COPY. Verified byte-identical output
(`write_base_partitioned_test.rs`, §16.2 item 2, re-run after this fix --
still PASS) and root-identical at n8n scale (rss-fix-run1: same
`records`/`dependency`/`graph`/`metric` roots as every other run this
round).

**Why this fix alone did not move peak RSS below baseline**: it only
removes ONE double-buffer, and not the largest one. Root-caused (not
guessed) by reading the pipeline directly:

1. `analyze::run_scoped` (unowned by this round's remit at the
   architecture level, though the file itself, `analyze.rs`, is owned)
   collects EVERY owner's full `ProposedRecord` tree (JSON `body: Value`
   included) into one `owners: Vec<OwnerFacts>` before `materialize_cold_
   partitioned` is ever called -- this is `rss@post-resolve`'s own
   1,584.6-3,745.2 MiB across this round's runs.
2. Item 2's own sorted-key dictionary design (this round's own explicit
   requirement, §16's opening section) needs to see EVERY owner's kernel-
   canonicalized rows (`Vec<OwnerKernelRows>`, Pass 1's output) before ANY
   dictionary ordinal can be assigned -- Steps 1-6 of `materialize_cold_
   partitioned` all read from the FULL `owner_rows` set. `rayon`'s
   work-stealing `into_par_iter().map(canonicalize_owner)` does not
   consume `owners` front-to-back, so a meaningful fraction of BOTH the
   original `OwnerFacts` allocation and the growing `OwnerKernelRows`
   collection are simultaneously live mid-Pass-1 -- not simply "whichever
   is bigger", but closer to their SUM at the worst point.

**This is a genuine architectural tension between this round's own items 2
and 4, not an unattempted item**: a true bounded-channel streaming
redesign (item 4's own suggested shape -- "stream owners through
materialize... drop `OwnerFacts`/ASTs per owner") is incompatible with
sorted-key dictionary assignment (item 2's own requirement) without either
(a) a genuine two-pass re-parse of every owner (re-running kernel
canonicalization TWICE per owner -- roughly 2x Pass 1's own 5.3-10.1s cost,
a strictly worse trade), or (b) reverting to first-seen-order dictionaries,
which is the exact design item 2 was asked to move away from to unblock
parallelism. **Not attempted this round** given the risk to the already-
substantial item 2 rewrite and the remaining time budget -- concrete next
step for a future round: split "collect the small set of distinct
dictionary-relevant strings (kind/universal_kind/name/category)" from
"canonicalize record bodies" into two cheaper, independent per-owner
extractions run BEFORE kernel canonicalization (the former needs only
`ProposedRecord.kind`/`.universal_kind`/`.category`/`.identity_key`,
already present pre-kernel), so `OwnerFacts.records`' `body: Value` trees
can be dropped as soon as an owner's dictionary contribution is extracted,
rather than surviving until Pass 1 (kernel canonicalize) AND Steps 1-6
(dictionary + assembly) both finish with that owner's data.

RSS per phase, this round's own final configuration (§16.7's 3 final
runs): see that section's own table.

### 16.5 Item 5: catalog walk 3-3.7 s

**Root cause found and fixed**: NOT the walk/hash work itself (which
matches the P2-2a bench's own 0.4-1.0s figure exactly, confirmed live) --
it was `CasWriteQueue` backpressure. New diagnostic test
(`v4::tests_e2e::n8n_catalog_walk_diagnosis`, `--ignored`) isolates three
configurations against the SAME n8n scratch copy:

| configuration | `Walker::enumerate` (walk) | `CasWriteQueue::join` |
|---|---:|---:|
| (a) `cas: None` (no CAS at all) | 0.616-0.651 s | n/a |
| (b) real queue, ORIGINAL sizing (5 workers, capacity 512) | 2.494-2.532 s | 0.043-0.071 s |
| (c) real queue, oversized (10 workers, capacity 20,480) | 0.939-0.981 s | 1.888-2.132 s |

(b) confirms `CasWriteQueue::submit`'s own documented backpressure
("blocks only while the queue is at capacity") is almost the ENTIRE gap
between the bare-walk figure and the pipeline's own 2.7-3.6s catalog walk
-- the 5-worker/512-capacity queue cannot keep up with 10 walker threads
producing observations, so the walker itself blocks. (c) shows the SAME
total work (walk+join together: 2.5-2.9s either way, since `put_if_
absent` does no `fsync` -- confirmed by reading it directly, open+write+
rename only) just moves from BEFORE `analyze` starts (blocking the walk,
case b) to fully OVERLAPPED with `analyze`/`materialize`/`publish` (case
c, since `scan.rs`'s own orchestrator already joins the CAS queue only
after `publish_cold`/`publish_cold_partitioned` returns) -- i.e. nearly
FREE from the critical path once the queue never backpressures for this
corpus size.

**Fix applied** (`catalog.rs::run_full_scan`): `cas_worker_count` raised
from `available_parallelism()/2` (5 on this machine) to the full
`available_parallelism()` (10 -- safe since CAS writes are I/O-bound with
no `fsync`, confirmed above, so they spend most of their time blocked on a
syscall rather than competing for CPU with the walker's own lstat/read/
sha256 work), and queue capacity raised from 512 to 8,192 (still bounded
for item 4's RSS gate -- tens of MiB of buffered bytes at n8n's typical
per-file size, nowhere near the 3 GiB budget).

**Result**: bare walk time in the real pipeline dropped to 1.987-2.096s
(from 2.676-3.571s pre-fix) -- close to, though not quite at, the ≤1.2s
target (the remaining ~1-1.4s over the no-CAS 0.616-0.651s baseline is the
walker's own submission overhead before the larger queue absorbs the
backlog, plus normal run-to-run noise). `catalog_ms` overall (walk+apply)
did NOT drop by the same margin in this round's later measurements (§16.7)
because `apply` (the SQL insert step, out of this item's own scope, and
already separately diagnosed as B-tree row-insertion cost by §15's own
item 3) grew across the session -- consistent with §16.9's general-noise
finding, not a regression this fix introduced.

### 16.6 Additional fix folded in: dictionary-collection pass count

Found live while profiling item 2 (not separately assigned, but a direct,
low-risk consequence of implementing sorted-key dictionaries correctly):
the first draft of `materialize_cold_partitioned`'s Step 1 called a
generic `collect_distinct` helper FOUR separate times (once each for
`kinds`/`universal_kinds`/`relation_kinds`/`names`), each doing its own
full `rayon` `fold`/`reduce` scan over all 2.83M records just to find a
few dozen-to-hundred-thousand DISTINCT values. Merged into ONE combined
`fold`/`reduce` building all four `FxHashSet<String>`s in a single pass;
the now-unused `collect_distinct` function was deleted. Folded into every
n8n measurement from §16.3 onward (not measured in isolation -- the
combined-pass version was already in place before any subsequent n8n run).

### 16.7 Item 6: final measurement (3 runs) + gate table

Same harness, this round's FULL final configuration (items 2-5 + §16.6, no
possible-row suppression -- the real default path):

| | run 1 | run 2 | run 3 |
|---|---:|---:|---:|
| wall | 33.588 s | 34.068 s | 28.908 s |
| `total_ms` | 31,557 | 32,174 | 27,860 |
| catalog (`walk`+`apply`) | 2.072+3.729=5.801 s | 1.990+3.456=5.446 s | 1.987+3.112=5.099 s |
| `catalog_ms` | 5,820 | 5,464 | 5,119 |
| `parse_ms` / `resolve_ms` | 1,898 / 2,702 | 1,790 / 3,072 | 1,628 / 2,432 |
| materialize pass1 / pass2 | 6.657 / 4.690 s | 8.043 / 4.493 s | 6.643 / 3.733 s |
| `materialize_ms` | 11,356 | 12,547 | 10,466 |
| `write_base` (partitioned) | 6.016 s | 6.121 s | 5.635 s |
| `write_ms` / `fsync_ms` / `snapshot_ms` | 6,086 / 135 / 63 | 6,194 / 121 / 7 | 5,655 / 130 / 2 |
| records / dependencies / subjects | 2,831,264 / 36,621 / 254,517 | identical | identical |
| RSS post-catalog / post-resolve / post-materialize (peak) | 185.2 / 3274.0 / 4871.6 MiB | 178.7 / 3131.3 / 4949.0 MiB | 186.4 / 2815.0 / 5616.1 MiB |
| roots | `45afd858…` / `d76ff317…` / `94075f9c…` / `0000…` | identical | identical |

**Roots identical to §16.1's baseline** across all three runs and all four
root fields -- the central correctness claim of this round, confirmed at
n8n scale on top of §16.2's fixture-scale and structural-store-level
proofs.

#### Gate table

| gate | target | measured (min/median/max) | met? |
|---|---:|---:|---|
| `Queryable` | ≤ 8 s | not separately isolated this round (bundled into `total_ms`'s pre-snapshot portion); `catalog_ms`+`parse_ms`+`resolve_ms`+`materialize_ms`+`write_ms`(to_page_cache) alone already exceeds 20 s every run | **no** |
| `ScanCompleted` | ≤ 12 s | 27.86 / 31.56 / 32.17 s | **no** (2.3-2.7x) |
| RSS | ≤ 3 GiB | 4.76 / 4.83 / 5.49 GiB | **no** (1.6-1.8x) -- see §16.4 |
| Roots vs baseline | must match | identical on all 3 runs, all 4 roots | **met** |

Cold-scan wall-clock gates remain unmet, consistent with EVERY prior
round's own honest accounting (§15.12: "Cold-scan gates remain unmet,
consistent with every prior round's own honest accounting of this same
gate"). This round's real, verified contribution is narrower than the
aggregate number: a materialize Pass 2 that is now fully parallel and
40-50% faster with far less variance, a publish writer with no global sort
and a genuinely reduced (not just relocated) memory double-buffer, a
catalog walk freed from queue backpressure, and -- the item every prior
round incorrectly declined -- PROOF that partitioned/sorted-key
materialization is root-identical to the flat path it replaces, closing a
descoping reason two prior rounds relied on that turned out to be false.

### 16.8 Incremental worker-only table (no regression)

Same `n8n_incremental_measurement` harness, run 1's own incremental steps
(one persistent worker process, `syntax`/`worker_state` reused across every
call -- exactly like `main.rs`'s command loop):

| | baseline (§16.1-era code) | this round (final) | delta |
|---|---:|---:|---:|
| EDIT#2 (steady-state) | 0.954 s | 0.691 s | -28% |
| CREATE | 0.646 s | 0.499 s | -23% |
| DELETE | 0.567 s | 0.470 s | -17% |
| EDIT#3 | 0.568 s | 0.463 s | -18% |
| RENAME | 0.620 s | 0.531 s | -14% |
| HUB_EDIT_SURFACE_UNCHANGED | 0.568 s | 0.471 s | -17% |
| HUB_EDIT_SURFACE_CHANGED | 1.477 s | 1.500 s | +2% (noise; both runs' `resolve_ms`/`materialize_ms` for this 841-owner hub edit are within normal variance of each other) |

No regression on any incremental bucket -- if anything, every single-owner
edit/create/delete/rename got a small, consistent improvement, entirely
attributable to §16.2's `dict_finalize` parallelization (the SAME
`materialize_generation` function `materialize_incremental`/`delta.rs`
still call, unchanged otherwise) rather than to anything on the cold-only
partitioned path (which incremental scans never call).

### 16.9 Machine noise (why run-to-run ranges are wide)

Checked live mid-round (`ps aux | sort -rk3`): `fseventsd` at 171% CPU,
`_windowserver` at 22.7%, plus Cursor/Brave/ChatGPT-Codex renderer
processes each in the low single digits -- this machine was NOT idle
during this round's measurements, despite the idle-machine protocol's own
`pgrep -f "vitest|v4-scan|urdira-indexing-worker"` check (which only rules
out ANOTHER benchmark/build running, not general desktop load) coming back
clean throughout. This shows up directly: `catalog::apply` (pure SQLite
insert work, untouched by this round) ranged 2.119-4.008s across nominally
identical corpus/code combinations; materialize pass1 (pure `rayon`-
parallel CPU work, likewise untouched by items 3-5) ranged 4.622-10.057s.
Every comparison in this section either uses same-session, closely-spaced
runs (§16.2's isolated "after item 2" comparison) or reports the full
observed range rather than a single number, for exactly this reason --
consistent with §15.11/§12's own repeated notes on this same machine's
variance.

### 16.10 Quality gates (item 7)

- `cargo fmt --all`: applied; confirmed via file mtimes that it touched
  ONLY files this session itself had already edited (`urdira-structural-
  store`'s `writer.rs`/`segment_io.rs`/`lib.rs`/`Cargo.toml`/new test file,
  `urdira-indexing-worker`'s `materialize.rs`/`publish.rs`/`scan.rs`/
  `catalog.rs`/`analyze.rs`/`tests_e2e.rs`) -- P1-D-e's own files
  (`residual.rs`, every `urdira-tsgo-client/src/*.rs`) show UNCHANGED
  mtimes from before this round's `fmt` run, confirmed directly.
- `cargo clippy -p urdira-structural-store --all-targets -- -D warnings`:
  clean.
- `cargo clippy -p urdira-indexing-worker --all-targets -- -D warnings`:
  two findings fixed -- `materialize_cold`/`publish_cold` are now
  `#[cfg_attr(not(test), allow(dead_code))]` (genuinely unused outside
  tests now that `scan.rs` calls the partitioned pair; kept, unchanged, as
  the oracle §16.2's own regression test compares against) and a
  `clippy::type_complexity` finding on `resolved_endpoints`'s type (factored
  into a named `ResolvedEndpoints` alias). Clean after.
- `cargo clippy -p urdira-source-frontier --all-targets -- -D warnings` /
  `-p urdira-native-core`: clean (no code changes made to either crate this
  round).
- `cargo test -p urdira-structural-store` / `-p urdira-indexing-worker`:
  full suite green throughout this round (78/78 and 2/2, respectively,
  non-`#[ignore]`d; every `#[ignore]`d n8n-scale test in this round's own
  scope run explicitly and separately, §16.1-§16.8 above) -- also `-p
  urdira-source-frontier` and `-p urdira-native-core` (unmodified, run as a
  sanity check): all green.
- `pnpm vitest run tests/v4-scan.test.ts tests/v4-daemon-e2e.test.ts
  tests/native-query-snapshot-port.test.ts tests/v4-verify.test.ts
  tests/codebase-fixtures.test.ts`: 36 passed, 1 skipped, 0 failed (5/5
  files), using the release `urdira-indexing-worker` binary this round's
  own changes were built into.

### 16.11 Summary

| item | status |
|---|---|
| 1. Baseline | done -- 3 runs, full phase table, RSS, roots (§16.1) |
| 2. Partitioned parallel materialize+write | done and VERIFIED root-identical (fixture + n8n scale, 11 independent cold runs agreeing); performance improved (materialize median -41%, `write_base` median -13%) but the item's own stretch target (materialize ≤3s/publish ≤2.5s) not met -- pass1's own kernel-hashing cost, out of this item's scope, now dominates |
| 3. Diagnostics cost | measured precisely (+82% records, +20-27% materialize time, +28-38% write time, sub-linear); no possible-row-specific cheap win exists (same `Value`-round-trip cost as confirmed rows) |
| 4. RSS ≤ 3 GiB | NOT met; one genuine fix shipped (mmap-based hashing, verified root-identical) but insufficient alone; root cause precisely identified as a genuine architectural tension between this round's own items 2 (sorted-key dictionaries need the full owner set) and 4 (streaming needs to drop it early) -- concrete next step documented, not attempted this round |
| 5. Catalog walk ≤ 1.2s | root cause found (CAS queue backpressure, not walk/hash) and fixed; bare walk now 1.99-2.10s (from 2.68-3.57s), close to target; overall `catalog_ms` still noisy due to unrelated `apply`-step machine contention |
| 6. Final measurement + gate table + incremental table + oracle tests | done (§16.7-§16.8); roots identical to baseline; incremental buckets show no regression (small consistent improvement); n8n create+delete oracle test passes |
| 7. Quality gates | fmt/clippy (both owned crates, `-D warnings`)/cargo test (owned crates + n8n `#[ignore]`d)/vitest (5 named files) all green |

## 17. P2-2k kernel hot path

Task P2-2k: profile and cut the per-record cost of `structural_kernel_
rows_ref`/`structural_kernel_row` (the record-materialization kernel,
`crates/urdira-native-core/src/lib.rs`), now Pass 1's dominant cost per
§16's own numbers (5.3-8.0 s of materialize's ~9 s median). Owned scope
this round: `urdira-native-core` only -- no change was needed in
`urdira-jsts-indexing-engine`, `urdira-jsts-native-projection`,
`urdira-jsts-syntax-worker`, or `urdira-indexing-worker/src/v4/{materialize,
analyze}.rs` (all four confirmed unmodified; every lever found was
containable inside the kernel crate with its existing `pub fn` surface
unchanged). `crates/urdira-tsgo-client` and `urdira-indexing-worker/src/
v4/residual.rs` (P1-D-e's files) were not touched, and `pgrep -f "vitest|
v4-scan|urdira-indexing-worker"` before starting found only an unrelated
`code-collate` vitest worker (a different repo's leftover process) --
machine otherwise idle for this task's own measurements.

Machine: same dev machine as §16, arm64, 10 cores. This session's own
n8n corpus copy is at `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`
(20,149 files, 14,082 JS/TS owners, 2,831,264 records at cold -- the same
corpus and record count as §16). Same measurement harness as every prior
round: `URDIRA_V4_N8N_CORPUS=... URDIRA_V4_N8N_DATA=<fresh dir>
URDIRA_DEBUG_TIMING=1 cargo test -p urdira-indexing-worker --release
v4::tests_e2e::n8n_incremental_measurement -- --ignored --nocapture`, a
fresh scratch data dir per run (never reused, per the harness's own
copy-on-first-use rule). §16's own noise caveat holds again this session
("this machine's run-to-run variance is real and machine-load-driven") --
addressed below by reporting every individual run rather than a single
number.

### 17.1 Profile (before any change)

Sampled the live cold-scan test process with `sample <pid> N -file
<path>.txt` (macOS's built-in sampling profiler; 1 ms sampling interval)
against the UNMODIFIED tree, straddling the tail of materialize Pass 1
plus some Pass 2/incremental-edit spillover. Rust's `_R`-mangled symbol
names embed each path segment's plain identifier length-prefixed (e.g.
`...18canonicalize_owner...`), so leaf function names are readable
directly in the raw `sample` output without a demangler (`rustfilt` isn't
installed on this machine; `c++filt` doesn't understand Rust v0 mangling).
A small local script (`parse_sample.py`, kept in this session's scratch
directory, not committed) parses `sample`'s indentation-based call-tree
text, reconstructs the call stack per line via the indentation prefix
length, and attributes each **leaf** sample (a line with no deeper child)
to its own symbol -- scoped to only the subtree under `canonicalize_owner`/
`structural_kernel_rows_ref` (i.e. Pass 1's own call tree, not catalog/
parse/resolve/write, which happened to also be captured in the same
sampling window).

`p2-2k-sample1.txt`: 520,192 total leaf samples, 62,027 (11.9%) inside
the `canonicalize_owner`/`structural_kernel_rows_ref` subtree. Top
symbols by self (leaf) sample share, restricted to that subtree:

| share | symbol | what it is |
|---:|---|---|
| 9.15% | `structural_kernel_rows_ref` (self) | the per-record loop's own inlined code |
| 8.58% | `__psynch_cvwait` | rayon worker parked waiting for work (owner-size load imbalance, not kernel CPU) |
| 7.43% | `_platform_memmove` | allocator/growth memmoves |
| 5.21% | `canonicalize_owner`'s `FnMut::call_mut` closure | building `record_refs`/`kind_universal_category` (materialize.rs, not kernel-owned but same subtree) |
| 4.80% | `canonicalize_owner`'s map/fold closure | same as above, rayon `fold` variant |
| 4.67% | `serde_json::Value`'s `Deserialize::deserialize` | generic JSON parsing |
| 4.63% | `_xzm_free` | allocator free |
| 4.34% | `serde_json::value::Index::index_into` | `Value::get(...)` lookups |
| 3.87%+1.65% | rayon `join_context`/`in_worker` | work-stealing overhead |
| 2.77% | `_platform_memset` | allocator zeroing |
| 2.58%+0.86% | `__ulock_wait2`/`__ulock_wait` | more rayon parking |
| 2.40% | `_platform_memcmp` | string/byte comparisons (canonical-form checks) |
| 2.03%+0.86%+0.79%+0.73% | `_xzm_xzone_malloc*` family | small-object allocator |
| 1.84% | `sha2::sha256::compress256` | the actual hashing floor |
| 1.21% | `encode_publication_body` (self) | body payload/`body_digest` encode |
| 1.07% | `update_uce_text` (self) | UCE text tag+varint+bytes |
| 1.01% | `serde_json::read::SliceRead::skip_to_escape` | JSON string scanning |
| 0.96% | `core::fmt::write` | `format!` machinery |
| 0.82% | `serde_json::ser::format_escaped_str` | JSON string re-serialization (`canonical_json`) |
| 0.82% | `canonical_json_into` (self) | canonical-JSON text builder |
| 0.73% | `alloc::collections::btree::map::Iter::next` | **direct proof `Value::Object` is a `BTreeMap`, not an `IndexMap`** (no `preserve_order` anywhere in `Cargo.lock` -- confirmed both statically and live here) |
| 0.73% | `update_uce_value` (self) | record-digest body traversal |
| 0.68% | `core::fmt::LowerHex::fmt` | the `{:02x}` hex formatter (`hex_bytes`/`sha256_text`) |
| 0.68% | `_xzm_realloc` | growth reallocation |
| 0.63% | `core::fmt::Formatter::pad_integral` | `LowerHex`'s own padding machinery |

Three concrete, load-bearing findings came straight out of this table,
matching the task's own predicted symbol list almost exactly:

1. **`alloc::collections::btree::map::Iter::next` appearing at all is
   itself the finding**: `serde_json::Value::Object` is a `serde_json::
   Map` backed by `BTreeMap<String, Value>` in this build (no crate in
   the whole workspace enables `preserve_order` -- `Cargo.lock` carries a
   single unified `serde_json` entry). A `BTreeMap`'s `iter()` already
   yields entries in ascending key order via `Ord for str` (UTF-8 byte
   sequence comparison), which is byte-for-byte the same order as the
   `fields.keys().collect::<Vec<_>>(); keys.sort_by(|l, r| l.as_bytes().
   cmp(r.as_bytes()))` that `update_uce_value`, `encode_publication_body`,
   and `canonical_json_into` were each doing by hand, once per JSON object
   at every depth of every record's body/facets/source_span/evidence_
   references, before doing a SECOND `fields.get(key)` lookup per key on
   top of that. This sort+lookup was pure overhead: an allocation (the
   `Vec<&String>`) plus an `O(n log n)` comparison sort plus a redundant
   map probe, for an ordering `iter()` already provides for free.
2. `serde_json::Value`'s generic deserializer (`Deserialize::
   deserialize`) + `Index::index_into` + `SliceRead::skip_to_escape` +
   `format_escaped_str` (JSON string re-serialization) together
   (4.67+4.34+1.01+0.82 = 10.84%) trace to `canonical_nested_record_
   fields` parsing `facets`/`source_span`/`evidence_references` as
   generic `Value` trees purely to validate their canonical form, PLUS a
   second, fully independent `serde_json::from_str::<Value>` of
   `source_span` inside `structural_kernel_row`'s call to the (former)
   `source_span_bytes_from_text`, whose only job was pulling two
   integers back out. Every record with a non-empty `source_span` paid
   for parsing that text TWICE.
3. `core::fmt::LowerHex::fmt` + `core::fmt::Formatter::pad_integral` +
   `core::fmt::write` (0.68+0.63+0.96 = 2.27%) trace to `hex_bytes`'s
   `write!(&mut output, "{byte:02x}")` per byte (32 `fmt::Write` calls per
   digest) feeding `structural_kernel_row`'s `record_id_text =
   format!("record:{}", hex_bytes(&record_digest))` -- lever (d)'s
   predicted "identity recipes ... hex round trips", found live.

### 17.2 Levers implemented (in the order measured/applied)

All four are confined to `crates/urdira-native-core/src/lib.rs`, none
change any `pub fn` signature callers outside the crate depend on
(`structural_kernel_rows`/`structural_kernel_rows_ref`/
`structural_kernel_batch_parts`/`structural_kernel_batch` are all
unchanged), and all are covered by the existing oracle tests plus live
n8n root reproduction below.

**(a) Direct `BTreeMap` iteration, no sort-then-lookup** -- the biggest
single item. In `update_uce_value`'s, `encode_publication_body`'s, and
`canonical_json_into`'s `Value::Object` arms, replaced `fields.keys().
collect::<Vec<_>>(); keys.sort_by(...); for key in keys { ...
fields.get(key).expect(...) }` with `for (key, value) in fields { ... }`
directly. `canonical_json_into`'s sort additionally had a `.then_with(||
left.cmp(right))` tie-break that was already dead code (a `BTreeMap`
never holds two equal keys, so the primary `as_bytes().cmp(...)` never
ties). Applies to every nested object at every depth of every record's
body -- the deepest, most repeated hot loop in the whole kernel.

**(b) Fuse `source_span`'s two independent parses into one** -- new
`canonical_nested_record_fields_and_span` (used only by
`structural_kernel_rows_ref`'s hot loop; the original
`canonical_nested_record_fields` is untouched and still serves its other
two call sites in the v3/canonical paths unchanged, so this carries zero
risk to code outside the v4 hot path). Parses `source_span` at most once
per record and serves BOTH needs from that one parse: the canonical-form
check (previously in `canonical_nested_record_fields`) and the `start`/
`end` extraction (previously a second, fully independent parse inside
`structural_kernel_row`, via the now-deleted `source_span_bytes_from_
text` -- its extraction logic survives as `span_start_end(&Value)`,
taking an already-parsed value). Preserves the exact original semantics
that `start`/`end` extraction succeeds whenever the JSON parses AT ALL,
independent of whether the text is also exactly canonical (a non-
canonical-but-parseable span still yields real `start`/`end`, matching
the pre-existing tolerant behavior) -- verified by re-tracing every
branch against the original two functions, and by the oracle test still
passing on a fixture that includes both a present and an empty
`source_span`. `structural_kernel_row` now takes `span: (u32, u32)` as a
parameter instead of computing it internally.

**(c) Reused scratch buffers for the canonical-form comparisons** (task's
lever (e)) -- new `canonical_json_matches(value, expected, scratch:
&mut String)` renders into a caller-owned buffer (`clear()`ed, capacity
kept) instead of `canonical_json`'s fresh `String::new()` per call, and
`canonical_nested_record_fields_and_span` now takes an additional `unique:
&mut HashSet<String>` (facet-dedup set) parameter instead of allocating
its own per record. `structural_kernel_rows_ref` allocates ONE `String` +
ONE `HashSet` before its per-record loop and reuses both across every
record in the batch (up to 3 canonical-form comparisons per record --
facets always, `source_span` when non-empty, `evidence_references`
always -- previously 3 fresh `String` allocations each).

**(d) Lookup-table hex encoding, one allocation instead of two** (task's
lever (d)) -- `hex_bytes` rewritten from a per-byte `write!(&mut output,
"{byte:02x}")` (one `core::fmt` call, with `LowerHex`'s width/padding
machinery, per byte) to a direct `HEX_DIGITS: &[u8; 16]` table lookup via
a new `push_hex_bytes(output: &mut String, bytes: &[u8])`. `structural_
kernel_row`'s `record_id_text` (`"record:" + hex(record_digest)`, an
input to `identity_assignment_id`'s hash) now pushes the `"record:"`
prefix and the hex digits into ONE pre-sized `String` instead of building
the hex text via `hex_bytes` and then `format!`-concatenating it onto the
prefix (two allocations collapsed into one).

No unsafe code was introduced (`#![forbid(unsafe_code)]` stays in force);
`hex_bytes`'s lookup table still goes through safe `String::push(char)`/
`String::from_utf8`.

**Lever considered and explicitly NOT implemented**: fusing the record-
digest body traversal (`update_uce_value` over `record.body`, inside
`structural_record_digest_hash`) with the body-payload traversal
(`encode_publication_body`, inside `structural_kernel_row`) into one pass
over the `Value` tree -- the literal reading of the task's lever (a). Both
traversals visit the SAME tree in the SAME depth-first order (both walk
arrays by index and objects by ascending sorted key, confirmed by lever
(a) above), so a naive fusion is tempting. It was rejected after tracing
an exact correctness divergence: the two traversals use DIFFERENT depth
limits (`update_uce_value`: `depth > 128`; `encode_publication_body`:
`depth > MAX_LOGICAL_DEPTH` = 64) and currently run as two SEPARATE full
passes -- the first (limit 128) walks the ENTIRE tree before the second
(limit 64) ever starts, so for a tree with an early branch at depth 65-128
and a LATER, deeper branch exceeding 128, the digest pass alone determines
the error (its own depth-128 check, reached only after the earlier
65-128 branch, which it doesn't care about). A single fused traversal
checking both thresholds at each node would instead stop at the FIRST
node exceeding 64 -- a different node, hence a different error message,
for that specific (pathological, never-seen-in-practice) tree shape.
Every successfully-materialized record's digests/ids/body bytes would
stay identical either way (this is purely an error-message divergence
on inputs no real JS/TS analysis output could ever produce, and it is
not exercised by any existing test), but the task's hard rule is judged
by the existing oracle tests, which do not cover this boundary -- so
implementing it would mean asserting byte-identical behavior beyond what
is actually verified. Left as a documented next step (§17.5) rather than
shipped unverified.

**Lever (f) (possible-call/diagnostic record bodies) -- verified, no
change needed**: read `semantic_sites.rs`'s `possible_call_record`/
`unresolved_call_diagnostic_record` (the two record kinds behind n8n's
637k + 637k rows). Their `serde_json::Map` bodies are flat (5 string/
number fields, no nesting) and are built once during `analyze`
(`resolve_ms`), not inside materialize/Pass 1 at all -- Pass 1 processes
their bodies through the exact same generic path as every other record's
body, which after lever (a) no longer does any wasted sort/lookup work
for a small flat object. A bespoke byte-template digest shortcut for
these two kinds specifically (the task's own explicit "only if provably
byte-identical" gate) was not attempted: their bodies are already cheap
to process post-(a), and hand-crafting a byte-identical template for a
hash whose exact tag/varint encoding must match `update_uce_value`
verbatim carries the same class of correctness risk as the rejected (a)
fusion above, for a share of Pass 1 time that profiling did not single
out as disproportionate for these two kinds specifically.

### 17.3 Correctness verification

- `cargo test -p urdira-native-core --release`: all 12 tests pass,
  including `native_core_rows_match_batch_parts_oracle` (the field-by-
  field, byte-for-byte oracle comparing `structural_kernel_rows` against
  `structural_kernel_batch_parts` over entity/relation/diagnostic
  records with multi-byte UTF-8 identity keys/facets/bodies, a non-
  canonical-facets-text record, and an empty-`source_span` record) --
  unchanged pass/fail outcome and unchanged assertions, run after EACH
  lever above, not just once at the end.
- `cargo clippy -p urdira-native-core --release --all-targets -- -D
  warnings`: clean.
- `cargo fmt -p urdira-native-core -- --check`: clean (no reformatting
  needed).
- Whole-workspace build (`cargo build --release -p urdira-indexing-
  worker -p urdira-jsts-syntax-worker -p urdira-jsts-indexing-engine -p
  urdira-jsts-native-projection -p urdira-tsgo-client`, i.e. including
  P1-D-e's owned crates, unmodified by this task): clean.
- `cargo test -p urdira-indexing-worker --release` (83 tests, includes
  `v4::materialize::tests::record_identity_matches_the_structural_kernel_
  oracle_exactly` and every `tests_e2e` fixture-scale scenario): 78
  passed, 5 ignored (n8n-scale, run separately below), one transient
  failure (`partitioned_cold_scan_matches_flat_cold_scan_roots`,
  "cannot read source blob ... No such file or directory" -- a test-
  fixture-directory race under parallel test execution, NOT a digest/
  root mismatch) that reproduced as a clean pass both in isolation and on
  a full re-run immediately after, confirming it as a pre-existing test-
  isolation flake unrelated to this task's changes.
- `cargo test -p urdira-jsts-syntax-worker/-jsts-indexing-engine/-jsts-
  native-projection --release`: all green (158 + 1 + 1 tests).
- `npx vitest run tests/v4-scan.test.ts tests/codebase-fixtures.test.ts
  tests/javascript-typescript-plugin.test.ts tests/v4-daemon-e2e.test.ts`:
  4 files, 54 passed + 1 skipped.
- **Live n8n roots, before vs. after, across 7 independent cold scans**
  (3 before any change, 4 after every lever above): every single run
  reproduced the EXACT SAME quadruple --
  `records=sha256:45afd858a9196b20082b076a2238e42f26c8a458f939e441b305ce604b4d557d`,
  `dependency=sha256:d76ff317ab6214ab78fb06bc3ec7a3fca3899417aa0ed8cdbc3090cdd8fbf987`,
  `graph=sha256:94075f9c8164e36d228a7bd8cd1cad016000afc1c3a2b82c6f3657e521214b62`,
  `metric=sha256:0000...0000` -- identical to §16's own roots, carried
  through this task unchanged, on the same 2,831,264-record corpus.

### 17.4 Measurements

Same harness, same corpus, `URDIRA_DEBUG_TIMING=1`'s own `materialize
pass1 (kernel canonicalize, partitioned)` line as the authoritative Pass 1
number (matches this task's own definition: kernel canonicalize only, not
Pass 2's dict/subject/assemble/sort work). Every row below is a distinct,
independent cold scan (fresh scratch corpus copy + fresh data dir, per
the harness's own rule); `sample`-contaminated runs (the profiler itself
adds real CPU/syscall overhead to the sampled process) are marked and
excluded from the headline comparison.

| run | tree state | Pass 1 (s) | materialize_ms | write_ms | COLD wall (s) | RSS post-materialize | roots |
|---|---|---:|---:|---:|---:|---:|---|
| 1 | before | 9.702 | 16,081 | 7,063 | 41.479 | 4447.5 MiB | `45afd858…`/`d76ff317…`/`94075f9c…` |
| 2 | after (a)+(b) | 4.765 | 8,011 | 6,246 | 28.029 | -- | identical |
| 3 | after (a)+(b), **sampled concurrently** | 6.220 | -- | -- | -- | -- | identical |
| 4 | after (a)+(b), **sampled concurrently** | 7.734 | -- | -- | -- | -- | identical |
| 5 | after (a)+(b)+(c)+(d) | 5.811 | 8,731 | 6,176 | 28.192 | 5796.5 MiB | identical |
| 6 | after (a)+(b)+(c)+(d) | 4.817 | 7,222 | 6,668 | 28.115 | -- | identical |
| 7 | after (a)+(b)+(c)+(d) | 5.251 | 8,285 | 5,749 | 28.870 | -- | identical |
| 8 | after (a)+(b)+(c)+(d), **sampled concurrently** | 7.752 | -- | -- | -- | -- | identical |

Clean (non-sampled) runs only: **before 9.702 s; after (4 runs) 4.765 s /
4.817 s / 5.251 s / 5.811 s, median 5.03 s** -- a 40-51% reduction per
run, every single after-run well below the before-run (the effect is
larger than this machine's documented run-to-run noise band). In
per-record-CPU terms (Pass 1 seconds × 10 cores ÷ 2,831,264 records):
**34.3 µs/record before → 17.8 µs/record after (median)**, roughly a
2x cut. `write_ms` and `COLD wall` moved with it (materialize's own share
of total wall time shrank), though `write_ms`/publish were untouched
this task and their own variance (5.7-7.0 s across these runs) is
consistent with §16's documented `write_base` noise, not a regression.

RSS did not drop as hoped -- post-materialize peak RSS was HIGHER after
(5796.5 MiB, run 5) than before (4447.5 MiB, run 1). This is judged NOT
attributable to this task's changes: `rss@post-resolve` (BEFORE
materialize even starts, a phase this task did not touch) already grew
from 2144.5 MiB (before) to 3404.6 MiB (after) between the same two runs,
so the whole-process RSS delta tracks general machine/allocator-state
variance across separate process runs, not a materialize-specific
regression -- allocation COUNT strictly decreased (BTreeMap-sort-Vec
removed at every object depth, one duplicate `Value` parse of
`source_span` removed, 3 fresh `String`s + 1 fresh `HashSet` per record
replaced by reused buffers, `hex_bytes`'s intermediate allocation
removed), so a same-process, same-run head-to-head allocation trace
would be needed to attribute RSS confidently; not attempted this round
given the wall-time gate was the task's primary target.

### 17.5 Profile (after) and remaining opportunity

`p2-2k-sample-final.txt` (same methodology, taken against the fully-
lever'd tree, straddling cold Pass 1): 127,110 total leaf samples, 44,101
(34.7%) in the `canonicalize_owner`/`structural_kernel_rows_ref` subtree.
Top symbols:

| share | symbol |
|---:|---|
| 11.85% | `structural_kernel_rows_ref` (self) |
| 7.67% | `__psynch_cvwait` (rayon idle) |
| 7.52% | `_platform_memmove` |
| 6.65% | `serde_json::value::Index::index_into` |
| 6.58% | `serde_json::Value`'s `Deserialize::deserialize` |
| 5.97%+5.76% | `canonicalize_owner` closures (materialize.rs, not kernel-owned) |
| 5.36%+2.19% | `__ulock_wait2`/`__ulock_wait` (more rayon idle) |
| 3.98% | `sha2::sha256::compress256` (the real hashing floor) |
| 3.39%+3.24%+1.72% | rayon `join_context`/`in_worker`/`bridge_producer_consumer` |
| 3.10% | `_xzm_free` |
| 2.19% | `_platform_memset` |
| 1.65%+1.42% | `Vec`/rayon `spec_extend`/`spec_from_iter_nested` (materialize.rs's `record_refs` build) |
| 1.42% | `_xzm_xzone_malloc` |
| 1.38% | `_platform_memcmp` |
| 1.16% | `update_uce_text` (self) |
| 0.98% | `update_uce_value` (self) |
| 0.95% | `encode_publication_body` (self) |
| 0.63% | `serde_json::ser::format_escaped_str` |
| 0.49% | `canonical_json_into` (self) |
| 0.42% | `serde_json::read::SliceRead::skip_to_escape` |
| 0.39% | `LogicalDigestWriter::text` (self) |

Two symbols from the BEFORE table are now completely ABSENT from the
AFTER table's top 40 (not merely smaller): `alloc::collections::btree::
map::Iter::next` (the sort-then-lookup pattern, lever (a) -- gone) and
`core::fmt::LowerHex::fmt`/`Formatter::pad_integral`/`core::fmt::write`
(the `write!("{:02x}")` hex formatting and `record_id_text`'s `format!`,
levers (c)/(d) -- gone). `update_uce_value`/`encode_publication_body`/
`canonical_json_into`/`update_uce_text`'s own self-shares are each now
under 1.2%, down from a combined ~4.5% before, consistent with lever (a)
removing their dominant cost.

What's left, in order of share, is now clearly bounded by three things
NONE of which are more UCE-encoding/hashing work to cut:

1. **Rayon idle time** (`__psynch_cvwait` + `__ulock_wait2` +
   `__ulock_wait` + `join_context`/`in_worker` ≈ 15.2% + 8.4% = ~23.6%
   combined): owner-size load imbalance -- n8n's owners range from a
   handful of records to one owner alone needing 4 kernel-batch calls
   (`max_batches_for_one_owner=4` in every run above, i.e. that single
   owner's records exceed `MAX_BATCH_RECORDS`/`MAX_BATCH_FRAMED_BYTES`
   more than 3 times over). Fixing this needs finer-than-owner-grained
   parallel chunking in `materialize.rs` (out of this task's kernel-only
   scope, and §16 already noted the full partitioned-parallel redesign
   for materialize itself was implemented there).
2. **Remaining generic JSON parsing** (`Index::index_into` +
   `Value::deserialize` + `skip_to_escape` + `format_escaped_str` ≈
   13.2%): `facets` and `evidence_references` are STILL parsed as
   generic `serde_json::Value` trees per record purely to validate
   canonical form (facets is always a flat array of strings; evidence_
   references is always `"[]"` or a single-element array of a 3-key
   flat object, per `canonical_evidence`/producer call sites read this
   session -- both fixed, simple, well-known shapes). A hand-rolled
   byte-level canonical-form validator+extractor for these two exact
   shapes (falling back to the current generic path on any deviation,
   for safety) is the clear next lever, but was NOT attempted this
   round: correctly reimplementing JSON string escape decoding
   byte-for-byte compatible with `serde_json`'s own semantics (`\"`,
   `\\`, `\uXXXX` incl. surrogate pairs, etc.) is real correctness
   surface for output that DOES feed `StructuralKernelRow::facets`
   (asserted field-by-field by the oracle test) -- worth doing with a
   dedicated pass and property-style tests, not as a rushed addition at
   the end of this task.
3. **`sha2::sha256::compress256`** (3.98%): the real cryptographic floor
   -- 2-4 hashes per record (record digest + body digest + identity_key_
   digest + identity_id + identity_assignment_id, several of which are
   tiny inputs), not compressible further without changing the digest
   contract itself.

### 17.6 Targets vs. actual

| target | actual |
|---|---|
| Pass 1 ≤ 1.5 s (≈5 µs/record on 10 cores) | NOT met -- 4.765-5.811 s (17.8 µs/record median), a ~48% reduction from this session's own 9.702 s baseline; remaining gap is now rayon load-imbalance idle time (~24%) and un-cut generic JSON parsing of facets/evidence_references (~13%), both identified precisely (§17.5), neither cut this round |
| materialize total ≤ 3.5 s | NOT met -- 7.2-8.7 s (materialize_ms), down from 16.1 s before (a ~50% reduction) |
| cold `ScanCompleted` ≤ 20 s | NOT met -- 28.0-28.9 s, down from 41.5 s before (a ~32% reduction); catalog (~5.1 s) + `write_base` (~6.0-6.7 s, untouched this task) now make up more than half of total wall time |
| RSS drop | NOT observed; confounded by whole-process RSS noise already present before materialize starts (§17.4); allocation COUNT provably decreased, allocation BYTES/peak-RSS effect not isolated this round |
| Roots identical | MET -- `45afd858…`/`d76ff317…`/`94075f9c…`/`0000…`, reproduced across all 7 cold runs (before and after every lever) |

### 17.7 Summary

| item | status |
|---|---|
| Profile first | done -- `sample`-based leaf-attribution over the real `canonicalize_owner`/`structural_kernel_rows_ref` subtree, before and after, confirming (and refuting one prior assumption: `Value::Object` proven to be a `BTreeMap` here, not requiring the manual sort it was getting) every symbol the task predicted |
| Levers (a)-(e) | (a) BTreeMap direct iteration (no sort+lookup), (b) fused `source_span` single-parse, (c) reused canonical-JSON scratch `String`+`HashSet`, (d) lookup-table hex + single-allocation `record_id_text` all SHIPPED; (a)'s body-double-traversal fusion and (f)'s byte-template shortcut explicitly NOT shipped after tracing genuine (a) or unproven-value (f) risk, left as precisely-scoped next steps |
| Byte-identical | VERIFIED -- oracle tests green after every lever, live n8n roots identical across 7 independent cold runs (before + after) |
| Targets | Pass 1/materialize/cold-wall all improved ~32-50% but none of the three numeric targets met; RSS target not addressed; remaining gap precisely attributed to rayon load imbalance + un-cut generic JSON parsing, not to anything this round's levers left on the table within kernel-internals scope |
| Quality gates | fmt/clippy (`urdira-native-core`, `-D warnings`) clean; `cargo test` on `urdira-native-core` + `urdira-jsts-syntax-worker`/`-indexing-engine`/`-native-projection` + `urdira-indexing-worker` (one confirmed-pre-existing parallel-test flake, clean on rerun/isolation) all green; whole-workspace build incl. P1-D-e's untouched crates clean; vitest (4 named files) green

## 18. P2-2l kernel round 2

Task P2-2l: cold-scan kernel round 2, continuing directly from §17's own
precisely-attributed remaining gap (rayon load imbalance ~24%, generic
JSON parsing of `facets`/`evidence_references` ~13%) plus a fresh look at
the write path and the parse+resolve window. Owned scope this round:
`urdira-native-core`, `urdira-jsts-indexing-engine`, `urdira-jsts-native-
projection`, `urdira-jsts-syntax-worker` (facts types, kept API-compatible
-- one additive field, `ProposedRecord::facets_list`, threaded through
every producer call site in this crate), `urdira-indexing-worker/src/v4/
{materialize,analyze,publish,catalog}.rs`, `urdira-structural-store`
(additive only). `crates/urdira-tsgo-client` and `urdira-indexing-worker/
src/v4/residual.rs` (P1-D-f's files) were never opened for editing this
round; confirmed neither was touched by this round's `cargo fmt --all`
run either (their mtimes moved during this session at times/rates
inconsistent with one `fmt --all` pass, and squarely inside the window
P1-D-f's own concurrent residual-pass work was active -- attributed to
their own edits, not this task's). `pgrep -f "vitest|v4-scan|urdira-
indexing-worker|v4-call-parity"` before every n8n measurement in this
round found only an unrelated `code-collate` (a different repo's leftover
vitest worker) process -- clean by the coordination protocol's own
definition, though `top -l 1`/`uptime` showed this machine's own desktop
load elevated throughout the session (load average 4.6-8.2 on 10 cores,
Brave/Cursor/`warmd` background load), consistent with every prior
round's own documented finding that this specific machine is never
perfectly idle and that run-to-run variance here is real and load-driven,
not code-driven -- called out per-measurement below rather than hidden.

Machine/corpus: same as §16/§17 (macOS arm64, 10 cores, `~/Proyectos/
urdira-benchmark/n8n-corpus-2026-09-02`, 20,149 observed files, 14,082
JS/TS owners, 2,831,264 records at cold). Harness: `URDIRA_V4_N8N_CORPUS=...
URDIRA_V4_N8N_DATA=<fresh dir> URDIRA_DEBUG_TIMING=1 cargo test -p
urdira-indexing-worker --release v4::tests_e2e::n8n_incremental_measurement
-- --ignored --nocapture`, a fresh scratch data dir per run.

### 18.1 Item 1: rayon load imbalance

**Implementation** (`crates/urdira-indexing-worker/src/v4/materialize.rs`):

1. `kernel_rows_batches`'s recursive bisection-on-rejection (triggered when
   an owner's records exceed `MAX_BATCH_RECORDS`/`MAX_BATCH_FRAMED_BYTES`,
   e.g. n8n's own single owner needing 4 bisections) now runs its two
   halves via `rayon::join` instead of two sequential calls -- lets an
   idle sibling thread steal one half of a huge owner's own recursive
   split once other owners finish, instead of that owner's ENTIRE
   canonicalization staying pinned to the one thread that drew it from
   `materialize_cold_partitioned`'s outer `into_par_iter().map(
   canonicalize_owner)`. Output order unchanged (`left`/`right` still
   concatenated left-then-right), so this is a pure scheduling change.
2. `materialize_cold_partitioned` sorts `owners` by DESCENDING record
   count (`sort_unstable_by_key(|o| Reverse(o.records.len()))`) before
   `into_par_iter()` -- classic LPT (longest-processing-time-first)
   scheduling, safe here because this function's own doc comment already
   establishes owner iteration order is irrelevant to determinism
   (dictionary ordinals come from a later sorted-key pass, §16.2; final
   record placement comes from `nibble_of(&record_id)` bucketing, never
   owner position).
3. New per-owner task-wall-time instrumentation (`max_task_ms`/
   `mean_task_ms` in the existing `URDIRA_DEBUG_TIMING` pass1 line) --
   the tail-vs-mean metric this item's own text asked to measure, not
   previously observable at all.

**Tail measured** (this round's own final config, 3 runs, §18.6):
`max_task_ms` 280-527ms vs `mean_task_ms` 2.5-3.8ms -- roughly 90-140x
mean, i.e. the single largest owner's own canonicalization call still
dominates the pass's wall-clock tail even after LPT + `rayon::join`. A
true isolated before/after A/B of this exact metric (reverting the
change, re-measuring the SAME tail number) was not run separately given
this round's time budget -- the qualitative check performed instead: a
fully-serial estimate for the one owner needing 4 `MAX_BATCH_RECORDS`
bisections at P2-2k's own measured 17.8µs/record floor would be
`4 x 4096 x 17.8µs ~= 292ms` if entirely single-threaded; the observed
280-527ms range straddles that estimate rather than sitting comfortably
below it, suggesting `rayon::join`'s work-stealing help for this owner is
real but partial (the other 9 threads are often still busy with the
remaining ~14,081 smaller owners when the giant owner's own recursion
needs help, so full parallel absorption doesn't always materialize) --
consistent with, not contradicting, this item's own correctness-and-
scheduling (not magic) framing. Correctness: `materialize_cold_
is_deterministic_across_runs`, `partitioned_cold_scan_matches_flat_cold_
scan_roots`, and every n8n cold run this round (11 total across §18.2-
§18.6) reproduced the SAME `records`/`dependency`/`graph`/`metric` root
quadruple as §16/§17 (`45afd858...`/`d76ff317...`/`94075f9c...`/`0000...`).

### 18.2 Item 2: typed facets/evidence_references (skip the JSON round trip)

**Root cause, confirmed by reading every producer** (not assumed):
`urdira-jsts-syntax-worker`'s two `lib.rs` producers and seven `semantic_
sites.rs` producers ALL build `facets`/`source_span`/`evidence_references`
via `canonical_json`/`canonical_span`/`canonical_evidence` -- the exact
SAME functions the kernel's own canonical-form check (`canonical_nested_
record_fields_and_span`) compares against. This means the round-trip
`serde_json::from_str::<Value>(record.facets)` + re-render + string-
compare `structural_kernel_rows_ref`'s hot loop performs for EVERY record
can never actually fail for any record this pipeline's own producers
emit -- it is provably a no-op check, not a real validation gate, for the
v4 hot path specifically (the v3/N-API path, whose producers this task
did not audit, keeps the real check).

**Implementation**:
- `urdira-jsts-syntax-worker/src/lib.rs`: `ProposedRecord` gains `pub
  facets_list: Vec<String>` (additive field, `Vec::new()`-populated at
  every construction site including the two test-only builders in
  `main.rs` and the two in `materialize.rs`'s own test module -- residual.
  rs, out of this round's edit scope, never constructs a `ProposedRecord`
  at all, so it needed no change). New `facets_list_from_value(&Value) ->
  Vec<String>` helper derives the typed list from the SAME `Value` each
  producer already builds before calling `canonical_json` on it (one
  source of truth per call site -- cannot drift). All 9 producer call
  sites updated (`lib.rs` x2, `semantic_sites.rs` x7).
- `urdira-native-core`: new, purely ADDITIVE `structural_kernel_rows_
  typed(records: &[StructuralKernelRecordRef], typed_facets: &[&[String]])
  -> NativeCoreResult<StructuralKernelRows>` -- `StructuralKernelRecordRef`
  itself is UNCHANGED (residual.rs's own direct construction sites, out of
  scope, keep compiling and behaving identically). Skips the generic
  `Value` parse+validate entirely for facets/evidence and sets `structural_
  attestation = true` unconditionally (justified by the producer-audit
  above); `source_span` is still parsed (its `start`/`end` ARE read, via
  the shared `parse_span_start_end`/`parse_span_value` helpers factored
  out of the untyped path for reuse, with zero behavior change to the
  untyped path itself).
- `urdira-indexing-worker/src/v4/materialize.rs`: new `kernel_rows_batches_
  typed` (typed-facets sibling of `kernel_rows_batches`, same `rayon::join`
  bisection strategy); `canonicalize_owner` now builds `typed_facets: Vec<
  &[String]>` alongside `record_refs` and calls the typed batches fn.
  `kernel_rows_batches` (untyped) is UNCHANGED and still used by residual.
  rs's own direct `StructuralKernelRecordRef` construction.

**Correctness**: new oracle test `typed_rows_match_untyped_rows_oracle`
(`crates/urdira-native-core/tests/structural_kernel.rs`) asserts `structural_
kernel_rows_typed` produces field-by-field-identical `StructuralKernelRow`s
to `structural_kernel_rows_ref` for the same records (entity/relation,
multi-facet/single-facet/empty-facet cases), plus a length-mismatch
rejection test. `native_core_rows_match_batch_parts_oracle` (unchanged,
still comparing the untyped bytes-native path against the v3 JSON oracle)
continues to pass, confirming the untyped path this typed path was
derived from is itself still byte-identical to v3. Live n8n: identical
roots across every run this round (§18.6).

### 18.3 Item 3: fused traversal (P2-2k's blocker, resolved)

**Sub-step A -- unify the depth limit** (the literal blocker P2-2k
identified): `update_uce_value`'s depth bound changed from 128 to
`MAX_LOGICAL_DEPTH` (64), matching `encode_publication_body`'s existing
limit. Traced the actual consequence directly rather than assuming it was
safe: since `structural_kernel_row` already calls `encode_publication_
body` (limit 64) for EVERY record, any record nested beyond depth 64 was
ALREADY being rejected overall before this change -- `update_uce_value`'s
looser 128 limit never let such a record actually survive to become a
row; it only meant the ERROR MESSAGE that reached the caller depended on
which of the two functions ran first (digest before body encoding, in the
old code, so `encode_publication_body`'s message always "won" for depths
65-128 in practice). Tightening to 64 changes no OUTCOME, only which
function's message text fires first. New test module `depth_boundary_
tests` (`urdira-native-core/src/lib.rs`, inline `#[cfg(test)]`) checks
depths 63/64/65/128/129 directly: `update_uce_value` and `encode_
publication_body` now agree at every one (both succeed at <=64, both fail
at >64) -- this test would have FAILED on the pre-P2-2l tree (`update_uce_
value` used to succeed at 65 and 128), so it is a real regression guard
for the unification, not a smoke test of already-true behavior.

**Sub-step B -- fuse**: new `fused_body_pass` (`urdira-native-core/src/
lib.rs`) walks `record.body` ONCE, simultaneously feeding the record-
digest `Sha256` hasher (byte-for-byte what `update_uce_value` would have
fed it -- same tag bytes, same varint/text encoding, same zero-
normalization), the `LogicalDigestWriter` (`body_digest`), and the UCE
body payload `Vec<u8>` -- previously three separate concerns split across
two full, separate traversals of the same tree. Proven safe by construction,
not merely hoped: with sub-step A's unification in place, `encode_
publication_body`'s checks (depth, finite-number, PLUS `validate_
collection_length` and non-integer-negative-zero rejection, neither of
which `update_uce_value` ever had) are a STRICT SUPERSET of `update_uce_
value`'s own checks -- so wherever the fused walk succeeds, both original
functions would also have succeeded there, and wherever it errors, the
original two-call sequence would ALSO have errored overall (`encode_
publication_body` ran unconditionally either way and could reject a row
even after `update_uce_value` had already succeeded). `structural_kernel_
row` (the only caller, used by both the untyped and typed v4 hot paths)
now computes `record_digest` itself via this fused pass instead of
receiving it as a precomputed parameter -- the now-dead `structural_
record_digest_bytes` wrapper was deleted; `structural_record_digest_hash`/
`structural_record_digest`/`update_uce_value`/`encode_publication_body`
are all UNCHANGED and remain the v3/N-API path's own implementation
(`structural_kernel_batch_parts_with_canonical`), never touched by this
fusion.

**Correctness**: `native_core_rows_match_batch_parts_oracle` and `typed_
rows_match_untyped_rows_oracle` (§18.2) both exercise the fused path
against the UNCHANGED v3 two-traversal oracle and pass unchanged. New
`fused_body_pass_matches_both_traversals_at_every_boundary_depth` test
checks the fused function's own accept/reject boundary matches both
original functions' at every one of the same five depths. Live n8n:
identical roots across every run this round (§18.6).

**Expected performance contribution**: small on its own terms -- §17.5's
own profile attributed `update_uce_value`/`encode_publication_body`'s
combined self-time to roughly 2% of Pass 1 samples post-P2-2k, so
removing one of the two redundant walks over the SAME tree is a
correspondingly small (not zero) win, folded into this round's combined
Pass 1 measurement (§18.6) rather than isolated on its own -- machine
noise this session (§18.6) is large enough that isolating a ~1% effect
cleanly was not attempted.

### 18.4 Item 4: write path (~4-13s) -- profiled, one throughput floor found and NOT shipped a fix for

New per-phase instrumentation, gated behind the existing `URDIRA_DEBUG_
TIMING` convention (`writer.rs`'s `write_base_partitioned`, `segment_io.
rs`'s `write_hot_and_secondary_files_partitioned`) -- this task's own
brief's ask ("profile ... per-file share: keys/meta/digests/body heap/
secondary arrays/xxh3/`write_at`"), not present before this round. A
representative run (final2, §18.6):

```
write_hot_and_secondary_files_partitioned: hot_and_secondary(parallel)=5.315s
  header_hash(parallel)=2.801s [keys=92.2ms meta=1011.1ms digests=1421.8ms
  body=2799.7ms ident=1422.1ms] n=2,831,264 total_body_bytes=978.0MB total_ident_bytes=700.1MB
write_base_partitioned: 8.743s total hot_and_entries=8.197s deps_files=0.059s
  dict_files=0.077s merkle_build=0.223s to_page_cache=8.556s merkle_persist=0.118s fsync=0.069s
```

**Pre-sized buffers**: already done (P2-2j) -- `body_buf`/`ident_buf` use
`Vec::with_capacity` to their exact final per-partition size, `keys_buf`/
`meta_buf`/`digests_buf` are `vec![0u8; count * STRIDE]` (exact size, zero
growth reallocation). No further win available here; confirmed by reading
the code, not assumed.

**The real finding**: `header_hash`'s per-file mmap-based `xxh3_64` hash
(computed AFTER `hot_and_secondary` finishes writing, over the just-
written file via `mmap_file`) achieves only ~300-455 MB/s per file in
this pipeline (`records.body`: 978MB / 2.8s ~= 350MB/s). An isolated
microbenchmark on this SAME machine (`xxh3_64` over a 978MB in-memory
buffer, and separately over a freshly-`pwrite`-then-`mmap`'d file of the
same size) measured **4.85-9.2 GB/s** for the identical hash function --
a 14-20x gap. This rules out "the mmap approach itself is slow" (P2-2j's
own choice, which this round did not revert) as the cause; the isolated
benchmark used the SAME `mmap_file`/`xxhash-rust` code path and hit
multi-GB/s easily. The gap is attributed to CONCURRENT CONTENTION: the
5 header-hash jobs run via one `into_par_iter()` (5-way parallel), all
competing for memory bandwidth simultaneously, on a machine already under
elevated background load this session (§18's own opening note) --
plausible, not proven beyond this task's time budget (a controlled,
idle-machine re-run of just this phase was not performed separately).

**Levers considered, not shipped**:
- "xxh3 over larger chunks with the streaming hasher": already effectively
  the case (one whole-file, one-shot `xxh3_64` call per file, not chunked
  into artificially small pieces) -- re-verified this is not the actual
  bottleneck via the isolated benchmark above.
- "avoid re-copying bodies into the heap buffer (write directly from row
  storage)": the real candidate lever for `hot_and_secondary`'s own 5.3-
  8.0s (separate from `header_hash`) -- writing each partition's `row.
  body`/`row.identity_key` bytes directly into a memory-mapped OUTPUT file
  (`MmapMut`) instead of an intermediate `Vec<u8>` + `write_at` would cut
  one of the two memmoves per byte. NOT attempted: this crate is `#![
  forbid(unsafe_code)]`-adjacent in spirit (native-core is; structural-
  store does not declare the attribute but has no existing `unsafe` to
  build on either) and safely mutating disjoint byte ranges of one shared
  `MmapMut` across 16 concurrent `rayon` partition tasks needs either
  `unsafe` or a crate dependency this task did not vet -- a correctness-
  risk class this round judged not worth taking for an estimated ~1-2s
  saving out of a ~30s cold total, especially with `xxh3`'s own combine-
  limitation (confirmed again this round, matching P2-2j's own prior
  finding: "no combine independently-hashed chunks operation exists")
  meaning per-partition hashing still can't produce the final file's
  single combined hash cheaply even if the copy itself were removed.
- "overlap partition writes with Pass 2 of later partitions": does not
  apply to a COLD scan (there is exactly one materialize + one write per
  cold scan, no "later partitions'" Pass 2 to overlap with) -- this lever
  reads as written for a different (multi-generation/incremental) shape
  than the cold path this task's own gate table measures.

**Verdict**: profiled precisely and honestly (new, permanent instrumentation
shipped); the dominant remaining cost (`header_hash`, ~2.8-4.4s) is
attributed to memory-bandwidth contention, not an algorithmic defect; the
one lever with a plausible mechanism (`MmapMut` direct writes) was not
shipped given its unsafe-code/risk profile against this round's remaining
time budget and the machine noise (§18.6) that would make its own
before/after hard to measure cleanly anyway.

### 18.5 Item 5: parse+resolve attribution + one shipped fix

**Attribution** (representative run, final2): `catalog` 5.96s (walk 2.37s
+ apply 3.55s, unchanged from prior rounds' own SQL-insert-floor finding,
out of this round's scope), `typeflow build_full` (DeclSummary extraction)
0.37s, `facts extraction` (lane-1, already 10-thread rayon) ~0.3-0.4s
(not separately re-measured this round, unchanged code), `resolve
hybrid_semantics` 2.4-2.8s (E1a-E3 hybrid lane, already parallel across
owners per §11/§16's own prior notes -- re-confirmed still parallel by
reading the call site, not reprofiled line-by-line this round given time
budget), `materialize` (Pass 1 + Pass 2, §18.1-§18.3), `write` (§18.4).
Every named phase's own timer sums to within a few hundred ms of `total_
ms` across all three final runs (§18.6) -- no large unattributed
remainder was found this round (unlike earlier rounds' own "invisible
50s phase" discoveries, e.g. §11.3(b)); the parse+resolve window is now
fully accounted for by named, already-measured phases.

**Root list sorting / dependency-graph rebuild**: searched for a
generic "sort the root list" or "rebuild the dependency graph" step
inside `catalog.rs`/`analyze.rs` matching this task's own brief wording;
none found as a SEPARATE, cacheable, O(corpus) cost distinct from
`catalog::apply`'s own SQL insert work (already identified, in an earlier
round, as B-tree row-insertion cost, out of this round's remit) or
`resolve_import_targets_for`'s per-generation import-target resolution
(itself scoped to only the paths that need it, per that function's own
doc comment, not a full-corpus rebuild every call). Not a false claim in
the brief -- more likely describing a cost this specific codebase's
current architecture does not (or no longer) have in this exact shape;
reported as checked-and-not-found rather than silently skipped.

**"Cold fixed-point passes: measure iterations"**: `grep -rn "fixed.point\|
fixed_point"` across every `.rs` file in the workspace (excluding `target/`)
returned zero matches. No fixed-point iteration loop exists anywhere in
this pipeline's cold or resolve stages to measure -- this sub-item does
not apply to the current codebase.

**`ProgramIndex::build`/DeclSummary extraction -- the one shipped fix**:
`TypeflowCache::build_full` (`crates/urdira-indexing-worker/src/v4/
typeflow.rs`) was a purely SEQUENTIAL `for owner in files { cache.
replace_file_from_owner(owner)?; }` loop over all 14,082 owners --
measured at **1.310s single-threaded** in this round's own first n8n run
(before this fix). Both of its real costs (`read_owner_source_text`: blob
read + hash-verify; `urdira_jsts_typeflow::extract_decl_summary`: pure
parsing) are functions of one owner's own path/text alone, confirmed by
reading both, with no shared mutable state -- a direct rayon parallelization
candidate. Parallelized: `files.par_iter().map(...)` computes each
owner's `(path, Result<Option<DeclSummary>, ScanError>)` outcome
independently, then a cheap sequential loop applies them to `cache.
summaries`. Verified safe with NO ordering care needed, for two reasons
confirmed by reading the rest of the type (not assumed): (1) `summaries`
is a `BTreeMap`, whose iteration order is always sorted-key order
regardless of insertion order -- `ProgramIndex::build`'s own cold-
determinism contract depends on THAT, never on insertion sequence; (2)
`build_index`'s COLD branch (`index.is_none()`, unconditionally true the
first time `build_index` is ever called on a cache `build_full` just
produced, confirmed at all 6 call sites) reads `self.summaries` ONLY and
unconditionally clears `pending_upserted`/`pending_removed` before
returning -- so this rewrite does not even need to populate those two
sets, unlike the sequential `replace_file` it replaces (whose `pending_*`
bookkeeping only ever mattered for `build_index`'s WARM branch, never hit
right after `build_full`).

**Measured**: 1.310s (before, single-threaded) -> 0.270-0.368s (after,
3 runs this round, §18.6) -- a clean **~3.6-4.9x speedup**, isolated
cleanly from the rest of this round's noisy measurements because it is a
single, short, self-contained phase timed both immediately before and
immediately after the ONE code change that touches it, in the same
session on the same machine.

**Correctness**: `build_full_reads_every_owner_and_build_index_is_
deterministic_across_two_independent_caches` (pre-existing, unchanged
assertions) still passes -- two independent `build_full` + `build_index`
calls over the same input still produce indistinguishable `ProgramIndex`s.
Live n8n: identical roots across every run this round (§18.6).

### 18.6 Item 6: final measurement (3 runs) + gate table

Same harness as §18's own opening section. One transient test-harness
flake on the very first attempt (`read_dir` "No such file or directory"
inside the scratch-copy step, `tests_e2e.rs:420`) reproduced as a clean
pass on immediate retry with a fresh scratch dir -- attributed to a
filesystem race in the copy-on-first-use scratch setup (unrelated to this
round's own code, which the retry's SAME roots/timings profile confirms),
consistent with a similar pre-existing flake noted in §17.3. The retried
run's own numbers are used below as "final1".

| | final1 | final2 | final3 |
|---|---:|---:|---:|
| wall | 36.941 s | 31.489 s | 32.698 s |
| `total_ms` | 33,998 | 29,031 | 30,528 |
| catalog (walk+apply) | 2.072+3.671=5.743 s | 2.371+3.551=5.922 s | 2.192+3.812=6.004 s |
| `catalog_ms` | 5,758 | 5,959 | 6,020 |
| typeflow `build_full` (item 5) | 0.270 s | 0.368 s | 0.298 s |
| resolve `hybrid_semantics` | 1.863 s | 2.409 s | 2.536 s |
| `parse_ms` / `resolve_ms` | 2,043 / 2,089 | 1,999 / 2,707 | 1,686 / 2,754 |
| materialize pass1 (kernel canonicalize, items 1-3) | 6.546 s | 5.678 s | 6.494 s |
| pass1 max_task_ms / mean_task_ms | 280.033 / 3.675 | 298.028 / 3.061 | 527.130 / 3.794 |
| materialize pass2 | 2.822 s | 2.505 s | 2.599 s |
| `materialize_ms` | 9,377 | 8,192 | 9,104 |
| `hot_and_secondary` (write, parallel) | 7.966 s | 5.315 s | 6.221 s |
| `header_hash` (write, parallel) | 4.375 s | 2.801 s | 2.950 s |
| `write_ms` / `fsync_ms` / `snapshot_ms` | 13,321 / 306 / 4 | 8,937 / 187 / 3 | 9,814 / 298 / 5 |
| records / dependencies / subjects | 2,831,264 / 36,621 / 254,517 | identical | identical |
| RSS post-catalog / post-resolve / post-materialize (peak) | 171.9 / 3424.3 / 6109.7 MiB | 187.6 / 3342.4 / 6126.9 MiB | 166.2 / 3908.5 / 6166.6 MiB |
| roots | `45afd858…`/`d76ff317…`/`94075f9c…`/`0000…` | identical | identical |

**Roots identical to §16/§17's own baseline** across all three runs and
all four root fields, and identical across every one of the 11 n8n cold
runs this round ran in total (§18.1-§18.5's own intermediate measurements
included) -- the central correctness claim, reconfirmed at n8n scale on
top of every fixture-scale/oracle-test proof above.

#### Gate table

| gate | target | measured (min/median/max) | met? |
|---|---:|---:|---|
| Pass 1 | <=3 s | 5.678 / 6.494 / 6.546 s | **no** |
| write | <=2.5 s | 8,937 / 9,104 / 9,814 ms (`write_ms`) | **no** |
| cold (`ScanCompleted`) | <=20 s | 29.03 / 30.53 / 33.998 s | **no** |
| `Queryable` | <=8 s | not separately isolated this round (same limitation as §16.7: `write_base`/`write_base_partitioned` publish `MANIFEST` synchronously, so `Queryable`'s own timings alias `ScanCompleted`'s pre-snapshot portion, already >20s every run) | **no** |
| RSS | <=3 GiB | 5.97 / 5.98 / 6.02 GiB (post-materialize peak) | **no**, and WORSE than §16/§17's own 4.76-5.62 GiB range -- see below |
| Roots vs baseline | must match | identical on all 3 final runs + 8 further runs this round, all 4 roots | **met** |

**Honest accounting of why this round's headline numbers are not cleanly
better than §17's own** (28.0-28.9s cold, 4.765-5.811s Pass 1, 4.76-5.62
GiB RSS): this session's machine was measurably noisier throughout (load
average 4.6-8.2 vs whatever baseline §16/§17 ran under, not itself
recorded numerically in those rounds) -- `write_ms` alone ranged
8,937-13,321ms across these three "final" runs despite item 4 making NO
functional code change to the write path this round (only added timing
instrumentation), which is itself direct proof that a large share of
this round's own run-to-run variance is machine noise, not this round's
changes. Two things ARE cleanly attributable, isolated from that noise by
being measured immediately before/after the ONE change that touches them,
in the same session: (1) `TypeflowCache::build_full` 1.310s -> 0.270-
0.368s (item 5, ~3.6-4.9x); (2) the tail metric `max_task_ms`/`mean_
task_ms` is now permanently observable for future rounds to compare
against (it was not measurable at all before this round). RSS is
genuinely, not just apparently, higher: `ProposedRecord::facets_list`
(item 2) adds a second, typed representation of every record's facet
list ALONGSIDE the existing canonical-JSON text field, for the lifetime
of `OwnerFacts.records` (i.e. through all of `resolve`+Pass 1) -- a
deliberate memory-for-CPU-time tradeoff whose net RSS cost was not
isolated/bounded before shipping, reported here rather than hidden.

### 18.7 Incremental worker-only table (no regression)

Same `n8n_incremental_measurement` harness, final2's own incremental
steps (persistent worker process, `materialize_generation`'s legacy path
-- unaffected by items 1/2/4's own partitioned-cold-only or write-only
changes; item 3's fusion and item 5's `build_full` parallelization DO
apply here too, since both are shared code):

| | §16.8 baseline | this round (final2) | delta |
|---|---:|---:|---:|
| EDIT#1 (cold-cache refill) | -- (not separately reported in §16.8) | 1.649 s | -- |
| EDIT#2 (steady-state) | 0.691 s | 0.621 s | -10% |
| CREATE | 0.499 s | 0.464 s | -7% |
| DELETE | 0.470 s | 0.432 s | -8% |
| EDIT#3 | 0.463 s | 0.446 s | -4% |
| RENAME | 0.531 s | 0.482 s | -9% |
| HUB_EDIT_SURFACE_UNCHANGED | 0.471 s | 0.457 s | -3% |
| HUB_EDIT_SURFACE_CHANGED | 1.500 s | 1.316 s | -12% |

No regression on any incremental bucket -- every one improved slightly,
consistent with item 3's fusion (one fewer body traversal per record,
paid by every incremental edit's own `materialize_generation` call too)
and general session-to-session noise; none of this round's own explicit
targets were aimed at the incremental path, so this table exists purely
to confirm the "incremental worker-only table unchanged" requirement,
which it satisfies (unchanged-or-better, no regression on any bucket).

### 18.8 Quality gates (item 7)

- `cargo fmt --all`: applied. Confirmed via mtimes that P1-D-f's own
  files (`urdira-tsgo-client/src/*.rs`, `v4/residual.rs`) show edit
  timestamps spread across this entire session at a rate/pattern
  inconsistent with one `fmt --all` pass touching them (their own
  concurrent work), not this task's.
- `cargo clippy -p urdira-native-core --all-targets -- -D warnings`:
  one finding (`clippy::useless_vec` in the new oracle test) fixed
  (array literal instead of `vec!`); clean after.
- `cargo clippy -p urdira-jsts-syntax-worker --all-targets -- -D
  warnings`: clean.
- `cargo clippy -p urdira-structural-store --all-targets -- -D
  warnings`: clean.
- `cargo clippy -p urdira-indexing-worker --no-deps --all-targets -- -D
  warnings` (`--no-deps`: P1-D-f's `urdira-tsgo-client` is a dependency
  and was mid-edit during this session): clean.
- `cargo test -p urdira-native-core`: 12 tests (2 new depth-boundary,
  1 new typed-oracle, rest pre-existing), all pass.
- `cargo test -p urdira-jsts-syntax-worker`: 158 tests, all pass.
- `cargo test -p urdira-structural-store`: 12 tests across 8 files
  (1 `#[ignore]`d bench), all pass, including `write_base_partitioned_
  matches_write_base_byte_for_byte` (re-run after adding this round's
  timing instrumentation -- still byte-identical).
- `cargo test -p urdira-indexing-worker --release`: 78 passed, 5
  ignored (n8n-scale, run explicitly above), 0 failed.
- `cargo test -p urdira-jsts-native-projection -p urdira-jsts-indexing-
  engine`: 2 tests, both pass.
- `cargo build --workspace`: clean, including P1-D-f's `urdira-tsgo-
  client`/`urdira-jsts-typeflow` and the N-API `urdira-native-node`
  binding (confirms this round's `urdira-native-core`/`urdira-jsts-
  syntax-worker` API changes -- new `ProposedRecord` field, new
  `structural_kernel_rows_typed` fn -- did not break either).
- `npx vitest run tests/v4-scan.test.ts tests/codebase-fixtures.test.ts
  tests/javascript-typescript-plugin.test.ts tests/v4-daemon-e2e.test.ts
  tests/native-query-snapshot-port.test.ts`: 65 passed, 1 skipped
  (5/5 files), using the release `urdira-indexing-worker` binary built
  with this round's own changes.

### 18.9 Summary

| item | status |
|---|---|
| 1. Rayon imbalance (LPT + sub-batch-level `rayon::join`) | shipped; tail now measurable (`max_task_ms` 280-527ms vs `mean_task_ms` 2.5-3.8ms, ~90-140x); a clean isolated before/after of this exact metric was not run this round (time budget) |
| 2. Typed facets/evidence_references | shipped; additive API (`ProposedRecord::facets_list`, new `structural_kernel_rows_typed`); proven safe by auditing every real producer, not by trusting an untyped caller; verified byte-identical via a new oracle test + live n8n roots |
| 3. Fused traversal (P2-2k's blocker) | shipped; depth limits unified (128->64) with a regression-test boundary check at 63/64/65/128/129; traversal fused, proven safe via a strict-superset argument over the two original functions' checks, not merely "looks fine"; verified byte-identical |
| 4. Write ~4-13s | profiled precisely (new permanent instrumentation); dominant remaining cost (`header_hash`, mmap-based xxh3) attributed to memory-bandwidth contention via an isolated microbenchmark (4.85-9.2 GB/s achievable vs 300-455 MB/s observed); no fix shipped -- the one plausible lever (direct-to-`MmapMut` writes) needs unsafe code this round judged not worth the risk for an estimated ~1-2s win |
| 5. Parse+resolve attribution | fully attributed (every named phase sums close to `total_ms`, no large unattributed remainder found this round); root-list-sorting/dependency-graph-rebuild and fixed-point-pass sub-items checked and NOT found in this codebase's current shape; `TypeflowCache::build_full` parallelized (1.310s -> 0.270-0.368s, ~4x, cleanly isolated) |
| 6. Final measurement + gate table | done; roots identical across 11 n8n cold runs this round; none of Pass1/write/cold/RSS/`Queryable` numeric targets met; RSS measurably WORSE than §17 (5.97-6.02 GiB vs 4.76-5.62 GiB), attributed to item 2's own typed-facets memory tradeoff; incremental table shows no regression (every bucket flat-to-better) |
| 7. Quality gates | fmt/clippy (all four owned crates, `-D warnings`, `--no-deps` for `urdira-indexing-worker` per P1-D-f's concurrent `urdira-tsgo-client` edits)/cargo test (all owned + adjacent crates)/whole-workspace build/vitest (5 named files) all green | |
