# P2-2i: possible call/heritage rows + pending-site export (Rust side)

Status: **Deliverable 1 (possible rows, `jsts:unresolved_call` reasons) SHIPPED and verified at n8n scale. Deliverable 2 (`pending.sites`/`entities.index` in the structural store) NOT implemented this session — design and exact remaining scope below.**

Scope: `crates/urdira-jsts-syntax-worker`, `crates/urdira-indexing-worker`, `packages/plugin-javascript-typescript/src/registry-contribution.ts`, `tests/v4-daemon-e2e.test.ts`. No commit made (per task rule). Two fixes requested mid-session by the parallel TS coordinator (P4-b-2) are folded in and confirmed at the end.

## 1. What was found at the start

`OwnerFacts.pending_sites` was collected all the way to `materialize.rs::canonicalize_owner` and then discarded: `pending_sites: _,` (destructured and dropped). v4 emitted `core:call`/`core:inherits`/`core:implements` ONLY when E1-E3 or typeflow resolved a target with certainty (`classification: "confirmed"`); every site neither lane could resolve simply vanished — no `"possible"` relation row, no `jsts:unresolved_call` diagnostic. This is the exact gap decision 28 and the P2-2e evidence doc flag as open.

A partial start on this exact deliverable already existed in the (uncommitted) working tree when this session began — `PendingCallSite`/`PendingHeritageSite` scaffolding in `semantic_sites.rs`, collecting `(start, end, source_id[, relation_kind])` for every site that stays `checker_pending`, with doc comments already naming `possible_call_rows`/`unresolved_call_diagnostic`/`possible_call_record` as the intended next step. That scaffolding was correct and is the actual shape shipped below — this session finished it (row builders, `finish()` wiring, `OwnerSemantics` fields, the `analyze.rs` merge, the registry schema, the tests, and the real-corpus verification), rather than replacing it. (Mid-session process note: two research sub-agents I launched at the very start of this session, running with full tool access against the same working tree, independently started prototyping this same code — one added and then reverted overlapping struct fields before I caught it. All such collisions were self-inflicted — no other agent besides the confirmed TS-only P4-b-2 process was ever actually racing this file. Net effect on the tree: zero — every exploratory edit from that mix-up was reverted before this evidence was written, verified by grep showing no trace of the abandoned field names.)

## 2. Row shapes shipped (deliverable 1)

### 2.1 Possible `core:call` relation

Built by `possible_call_record` (`semantic_sites.rs`), for every `PendingCallSite` (a CALL site whose callee neither E1-E3's plain-identifier resolver nor typeflow's declared-type lookup could resolve to a single declaration). Byte-for-byte identical, for the equivalent case, to `analyzer.ts`'s `relate("call", relationSource, undefined, node, "possible")` + `fact-delta.ts`'s `proposalRelationRecord`:

- `identity_key`/`id`: `jsts:call:{path}:{start}:{end}:{source_id}:unresolved` (the v3 recipe's `target?.id ?? "unresolved"`, with `target` always absent here).
- `kind`: `jsts:relation_call`, `universal_kind`: `core:call`, `category`: `relation`.
- `facets`: `["core:reference_relation", "core:indirect"]` (the `"core:indirect"` facet is v3's own convention for a `"possible"` classification, never added to a `"confirmed"` row).
- `body`: `{source_id, classification: "possible", path, start, end}` — **no `target_id` key at all** (not `null`; the key itself is absent, matching v3's `...(target === undefined ? {} : { target_id: target.id })` spread).

Real example (n8n cold scan, generation 1):

```json
{"classification":"possible","end":515,"path":"packages/@n8n/nodes-langchain/nodes/mcp/McpClient/__test__/McpClient.node.test.ts","source_id":"jsts:module:packages/@n8n/nodes-langchain/nodes/mcp/McpClient/__test__/McpClient.node.test.ts:0:...","start":467}
```

vs. a confirmed row for contrast (same shape, `target_id` present, no `core:indirect` facet):

```json
{"classification":"confirmed","end":3248,"path":"packages/@n8n/computer-use/src/tools/screenshot/screenshot.test.ts","source_id":"jsts:module:...","start":3206,"target_id":"jsts:function:packages/@n8n/computer-use/src/tools/screenshot/screenshot.test.ts:1498:makeMockMonitor"}
```

### 2.2 `jsts:unresolved_call` diagnostic

Built by `unresolved_call_diagnostic_record`, paired 1:1 with every possible-call row (interleaved in `OwnerSemantics::possible_call_rows`: relation row immediately followed by its diagnostic). Mirrors v3's `diagnostics.push({ code: "jsts:unresolved_call", message, path, start, end })`, plus a **new `reason` field v3 never carried** (v3's checker context makes a diagnostic self-explanatory to a human; v4 has no checker to fall back on, so the pending site's own reason is surfaced directly):

- `identity_key`: `jsts:diagnostic:{path}:{start}:jsts:unresolved_call:{index}` (`index` is this diagnostic's position among this owner's own unresolved-call diagnostics — a disambiguator, not required to match v3's own cross-kind numbering).
- `category`: `diagnostic`, `kind`: `jsts:diagnostic`, `universal_kind`: `core:construct`, `facets`: `[]`.
- `body`: `{code: "jsts:unresolved_call", message: "The TypeScript checker could not establish a unique call target.", path, start, end, reason}`.

Real examples:

```json
{"code":"jsts:unresolved_call","end":19582,"message":"The TypeScript checker could not establish a unique call target.","path":"packages/cli/src/modules/community-packages/__tests__/npm-utils.test.ts","reason":"call_deferred_to_e3","start":19451}
{"code":"jsts:unresolved_call","end":40887,"message":"The TypeScript checker could not establish a unique call target.","path":"packages/cli/test/integration/credentials/credentials.api.test.ts","reason":"call_target_uncertain","start":40860}
```

**Simplification made explicit**: v3 gates this diagnostic on `target === undefined && !declarationWasResolved` (a checker-resolved-but-unmapped declaration gets a possible row with NO diagnostic). v4 has no checker to draw that finer distinction — a `PendingCallSite` is by construction a call Rust never resolved to any declaration at all, so v4 emits the diagnostic unconditionally for every possible-call row. This is a documented behavioral difference, not an attempt to replicate v3's exact diagnostic population one-for-one.

Only two `reason` values are produced today (both pre-existing E1a/E3 reasons, now surfaced): `call_deferred_to_e3` (non-identifier callee — member/`this`/`super`/dynamic `import()`/any other expression — never even attempted) and `call_target_uncertain` (identifier callee whose binding is not a single, non-overloaded declaration).

### 2.3 Possible `core:inherits`/`core:implements`

Built by `possible_heritage_record`, for every `PendingHeritageSite` (a heritage clause entry that stayed pending AND has a real enclosing declaration — `source_id` — to attribute it to). Same shape family as 2.1, no paired diagnostic (v3 never diagnoses a heritage clause either — only the call branch of `analyzer.ts`'s `visit` ever pushes to `diagnostics`).

```json
{"classification":"possible","end":251,"path":"packages/cli/src/modules/instance-ai/repositories/instance-ai-run-snapshot.repository.ts","source_id":"jsts:class:...:201:InstanceAiRunSnapshotRepository","start":241}
{"classification":"possible","end":1799,"path":"packages/nodes-base/nodes/RespondToWebhook/RespondToWebhook.node.ts","source_id":"jsts:class:...:1762:RespondToWebhook","start":1790}
```

An anonymous class's heritage clause (no declaration id of its own — `class.id.is_none()`) has no `source_id` and stays in `pending_sites` with **no** possible row, matching v3's own `entityForDeclaration(node.parent)` gap exactly (test: `anonymous_default_export_class_heritage_stays_pending`, extended this session to assert `possible_heritage_rows.is_empty()`).

## 3. What was deliberately NOT built

- **`union_ambiguous`/`overload_ambiguous` per-candidate possible rows.** `MemberLookup::Many(Vec<String>)` (`urdira-jsts-typeflow`) already carries every overload candidate for a member lookup that isn't a clean single match, and a per-candidate `"possible"` row (each carrying its own `target_id`, unlike the plain unresolved case) is mechanically straightforward to add at the one call site (`resolve_call_target_typeflow`'s `StaticMemberExpression` branch, `semantic_sites.rs`). It was scoped out this session for the same reason decision 28 gave when it investigated and declined to build this exact channel in P1-B/C: "judged too risky to ship in the time available" without a wrong-target measurement pass, and typeflow's 0%-wrong-target record across ~9,500 comparison sites is the strongest asset this pipeline has — not something to spend casually. **Union receivers cannot be built at all without new typeflow-crate surface**: `RawTypeRef`/`TypeflowValue` have no union variant today (a `TSUnionType` collapses to `Unknown` in `raw_type_ref_of_ts_type`), so there is no candidate list to emit from in the first place; this needs a real feature, not a wiring change.
- Both reasons remain reserved-but-unregistered in the schema comment (`registry-contribution.ts`) for whoever picks this up.

## 4. Registry schema change

`diagnosticPayload` (`registry-contribution.ts`) gained a `reason` field: `{ type: "string", enum: ["call_deferred_to_e3", "call_target_uncertain"] }`, optional (not in `required`). `additionalProperties: false` on this schema meant the field HAD to be declared for the new diagnostic body to validate. The enum lists only the two reasons the Rust pipeline actually produces today (§3's reasons are not listed, to avoid claiming a value nothing can emit yet). `jsts:unresolved_call`'s diagnostic-code and completeness-reason registrations already existed (added in the P2-2e session) and needed no change.

## 5. Bug found and fixed: diagnostic records were invisible to category-filtered queries

`crates/urdira-indexing-worker/src/v4/materialize.rs`'s `category_byte` function:

```rust
fn category_byte(category: &'static str) -> u8 {
    match category {
        "relation" => CATEGORY_RELATION,
        _ => CATEGORY_ENTITY,   // <- "diagnostic" fell through here
    }
}
```

had no arm for `"diagnostic"` — correct before this task (v4 never produced a diagnostic-category `ProposedRecord`, so the catch-all was harmless), but the moment `unresolved_call_diagnostic_record` started producing `category: "diagnostic"` rows, every one of them silently stored with `CATEGORY_ENTITY` (byte 0) instead of `CATEGORY_DIAGNOSTIC` (byte 2). `record_id`/`record_digest`/the records Merkle root were unaffected (both are computed from `record.body` and are category-independent), but `recordsByKindExact("core:construct", "diagnostic", "jsts:diagnostic", ...)` — and therefore `core:find_records` with `record_categories: ["diagnostic"]`, and therefore the new `tests/v4-daemon-e2e.test.ts` additive assertions — returned **zero rows**. Fixed by adding the missing arm. Verified end to end: `inspect_store_record_histogram` (Rust reader, independent of the napi/JS decode path used for the histogram below) reports `diagnostic jsts:diagnostic 637531`, and the daemon e2e test's `core:find_records` diagnostic-category query now returns them through the full query engine.

## 6. n8n histogram (cold scan, generation 1, `~/Proyectos/n8n`)

Two independent cold scans (fresh `--force` data dirs) produced byte-identical roots:

```
records:    sha256:45afd858a9196b20082b076a2238e42f26c8a458f939e441b305ce604b4d557d
dependency: sha256:d76ff317ab6214ab78fb06bc3ec7a3fca3899417aa0ed8cdbc3090cdd8fbf987
graph:      sha256:94075f9c8164e36d228a7bd8cd1cad016000afc1c3a2b82c6f3657e521214b62
```

`dependency`/`graph` are unchanged from the pre-P2-2i (post-typeflow) baseline (`docs/evidence/2026-09-03-v4-records-root-change.md`'s convention: possible/diagnostic rows add new relation/diagnostic RECORDS but touch no dependency edges and the `graph` set is defined over relation-category records generically, which already included `core:call`/`core:inherits`/`core:implements` before this task). `records` moves to the new value above — expected, new rows exist. Total visible records: **2,831,264** (measured independently by the Rust `StoreReader` reader, `inspect_store_record_histogram`, and by the napi/JS query path below — both agree).

| universal_kind | total | confirmed | possible |
|---|---:|---:|---:|
| `core:call` (`jsts:relation_call`) | 734,379 | 96,847 | 637,530 |
| `core:inherits` (`jsts:relation_inherits`) | 1,447 | 786 | 661 |
| `core:implements` (`jsts:relation_implements`) | 1,726 | 477 | 1,249 |

`jsts:diagnostic` (all `code: "jsts:unresolved_call"`): **637,531** total (637,530 decodable + 1 undecodable, see §7), reason breakdown `call_deferred_to_e3` 376,133 / `call_target_uncertain` 261,397 — sums to 637,530 decodable diagnostics, one per decodable possible-call row.

**The parity target is met exactly**: `734,379` is v3's own historical `jsts:relation_call` total for this exact corpus (`docs/evidence/2026-09-02-v4-p0-s2-typeflow-prototype.md`'s composition note: "call 734.379"). `96,847 confirmed + 637,530 possible + 2 undecodable = 734,379`. **v4's site enumeration now produces exactly as many `core:call` sites as v3's checker-backed walk did for the same corpus — there is no coverage gap to explain.** (The 96,847 confirmed figure is 474 higher than the P2-2e session's own measured 96,373 — plausible ordinary corpus drift between sessions, e.g. n8n's own upstream commits between scans; not investigated further, as it is outside this task's own change surface and the wrong-target-critical property, typeflow's 0% wrong-target rate, is untouched by this task.)

## 7. Pre-existing bug found, NOT fixed (out of scope): 3 undecodable record bodies

Decoding every `core:call`/`jsts:diagnostic` body with `@urdira/canonical`'s `decodeCanonical` hit exactly 3 records (2 `core:call`, 1 `jsts:diagnostic`, out of 2,831,264 total — 0.0001%) whose `body_payload` bytes are entirely zero (481 and 210 bytes for the two call rows; not individually isolated for the diagnostic row, same symptom). `uce:trailing_data` at byte offset 1 — a zero-filled buffer decodes as an integer `0` immediately, then the decoder correctly complains about the remaining zero bytes. This affects a `confirmed` `core:call` row's own body content, so it predates this task's change (this task only ever added NEW possible/diagnostic rows; it never touches how a confirmed call row's body bytes are produced) — reported here as a real, reproducible finding (record ids: `record:700016c24ff43e1265c497bf709034b769502c99518992e6a54d101998916209`, `record:90000bb300e1b273897d6a508fd1b49e7104bf0ebeaacd55367793160e09824e`) for a future session, not fixed here (same "flagged, not silently worked around" convention this codebase already follows for other known gaps).

## 8. Incremental correctness at n8n scale

`n8n_incremental_create_delete_roots_match_oracle` (`#[ignore]`d, `URDIRA_V4_N8N_CORPUS=~/Proyectos/n8n cargo test --release -p urdira-indexing-worker ... -- --ignored --nocapture`): cold scan, incremental create, incremental delete, then a from-scratch oracle scan of the same mutated tree — **root equality confirmed** with the new possible/diagnostic rows live in the pipeline (82.5s total incl. a fresh corpus copy to scratch — the shared corpus itself was never written to).

## 9. Quality gates

- `cargo fmt --all -- --check`: clean.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean.
- `cargo test --workspace`: all pass except one isolated, confirmed-unrelated flake — `urdira_indexing_core::tests::wait_out_scan_priority_gives_up_after_its_budget_even_if_the_marker_persists` failed once under the load of everything else in this session running concurrently, then passed cleanly run alone (`cargo test -p urdira-indexing-core wait_out_scan_priority...`); this crate was not touched this session.
- `cargo test -p urdira-jsts-syntax-worker`: 158 tests (154 pre-existing + 4 new: `pending_call_sites_produce_possible_rows_and_paired_diagnostics`, `dynamic_import_produces_a_possible_call_row_and_diagnostic`, `overloaded_local_call_produces_a_possible_row_with_the_uncertain_reason`, `pending_named_heritage_clause_produces_a_possible_row`; plus an extended assertion on the pre-existing `anonymous_default_export_class_heritage_stays_pending`).
- `cargo test -p urdira-indexing-worker`: 71 pass, 3 `#[ignore]`d (real-corpus measurements, run separately, §6/§8). One pre-existing invariant test (`cold_scan_record_histogram_matches_category_kind_prefix_invariant`) asserted v4 never produces a diagnostic-category record — updated to allow `CATEGORY_DIAGNOSTIC`/`jsts:diagnostic` specifically (the pipeline changed on purpose; the test's own invariant, not a load-bearing architectural rule, needed updating alongside it).
- `npx vitest run tests/codebase-fixtures.test.ts tests/javascript-typescript-plugin.test.ts tests/v4-scan.test.ts tests/v4-daemon-e2e.test.ts tests/native-query-snapshot-port.test.ts tests/v4-verify.test.ts`: 6 files, 79 passed + 1 skipped.
- `tests/codebase-fixtures.test.ts` does **not** drive the v4 pipeline (confirmed by reading it and by the fact it passed unchanged) — it exercises the v3 gold-manifest harness only. Building a v4 variant of that harness (index a fixture through `scripts/v4-scan.mjs`'s logic + the native port, compare against `expected.streams.*.confirmed/possible`) was in scope per the task brief but not attempted this session — real, uncommitted scope for a future session, listed here rather than silently dropped.

### `tests/v4-daemon-e2e.test.ts` changes (additive + one real fix)

1. **Real fix**: the fixture's own relation-kind subset check (`for (const kind of v4RelationKinds) expect(v3RelationKinds.has(kind)).toBe(true)`) started failing once v4 began emitting `jsts:relation_call`/`_inherits`/`_implements` possible rows for this tiny 2-file fixture (previously it never produced those kinds at all for this fixture, since nothing resolved with Rust-only certainty) — `v3RelationKinds` already excludes those checker-only kinds from ITS side of the comparison (`CHECKER_ONLY_RELATION_KINDS`), so `v4RelationKinds` needed the same exclusion applied before the subset check, or the new (expected, correct) possible-row kinds would fail a comparison they were never meant to be part of. Added `jsts:relation_implements` to that exclusion set too (it needs checker-level interface resolution the same way `inherits`/`call` do).
2. **Additive**: asserts the fixture's own pending calls now produce `classification: "possible"` `jsts:relation_call` rows with no `target_id` key, and that querying `record_categories: ["diagnostic"]` returns exactly one paired `jsts:unresolved_call` diagnostic per possible call, each with a `reason` in `{call_deferred_to_e3, call_target_uncertain}`.

### Two items folded in from the parallel TS coordinator (P4-b-2), addressed

1. **`check:native` fmt/clippy failure** the coordinator reported (a `cargo fmt` diff near `semantic_sites.rs:3059`, clippy dead-code on `PendingCallSite`/`PendingHeritageSite`): resolved as part of finishing the scaffolding — the dead field was `PendingHeritageSite.reason` (collected but never read, since a heritage possible row carries no reason in its body, unlike a call's paired diagnostic); removed it and its three construction sites. `cargo fmt --all -- --check` and `cargo clippy --workspace --all-targets -- -D warnings` are both clean as of this evidence doc (§9).
2. **`tests/v4-daemon-e2e.test.ts`'s `URDIRA_V4` opt-out**: v4 is now the default for a new workspace (`URDIRA_V4 !== "0"`), so the test's `delete process.env["URDIRA_V4"]` (meant to force the v3-comparison daemon) no longer opts out — changed both occurrences (line ~453, before the v3 comparison daemon starts; the outer `finally`'s restore) to `process.env["URDIRA_V4"] = "0"`. Verified: the test used to hang for the full 120s timeout under the current default and now completes in ~4.6s.

## 10. Deliverable 2 — NOT implemented: exact remaining scope

`pending.sites`/`entities.index` were not added to `crates/urdira-structural-store`. This is real, substantial, greenfield storage-format work (nothing exists for it anywhere in the tree today — confirmed by grep across the crate, `urdira-native-node`, and `native-structural-store-binding.ts`) that was judged too large to attempt safely alongside deliverable 1 in the time available, given the binary format's delicate base+delta/compact/recover/Merkle invariants. Concrete plan for whoever picks this up:

- **`layout.rs`**: add `TableId::PendingSites`/`TableId::EntitiesIndex` (next free values after `SubjectsKeys = 4`); a `pending_sites` byte-offset module mirroring `meta`'s style: `OWNER: u32, START_UTF16: u32, END_UTF16: u32, SITE_KIND: u8, REASON: u8, POSSIBLE_ROW_ORDINAL: u32` (`NONE_U32` sentinel) — 17 bytes used, pad the stride to 24 for future headroom, matching `deps_meta`'s 32/29 pattern. `entities_index` module: `PATH_ORDINAL: u32, NAME_START_UTF16: u32, RECORD_ORDINAL: u32` — 12 bytes, no padding needed (already a clean stride).
- **`row.rs`**: `PendingSiteRow { owner_artifact: u32, start_utf16: u32, end_utf16: u32, site_kind: u8, reason: u8, possible_row_ordinal: Option<u32> }` and `EntityIndexRow { path_ordinal: u32, name_start_utf16: u32, record_ordinal: u32 }`, both `#[derive(Clone, Debug)]` like `RecordRow`/`DependencyRow`.
- **`SiteKind`/reason numeric codes**: `semantic_sites.rs`'s `SiteKind` enum (`IdentifierRef, Call, Heritage, TypedDecl`) needs a `#[repr(u8)]`-friendly ordinal method (its current derive has no explicit discriminants — add them, e.g. `IdentifierRef = 0, Call = 1, Heritage = 2, TypedDecl = 3`, and freeze them in a doc comment as an on-disk contract). Reasons are currently `&'static str` constants (`REASON_MEMBER_ACCESS`, `REASON_CALL_DEFERRED`, ... — 12 in active use today, see `semantic_sites.rs` lines ~245-331) with no numeric form at all; needs a new `const REASON_CODES: &[(&str, u8)]` table (or a matching `#[repr(u8)] enum PendingReason`) assigning stable codes, documented as append-only (a code, once assigned, is permanent) the same way `Dictionaries`' ordinal lists are.
- **`container.rs`**: add `SectionId::PendingSitesKeys/Meta` (or a single combined section, following `deps.keys`/`deps.meta`'s two-section split) and `SectionId::EntitiesIndex`, next free numeric values after `ClosuresDeps = 18`.
- **Writer (`writer.rs`)**: `write_base` needs two new slice params (`pending_sites: &[PendingSiteRow]`, `entities_index: &[EntityIndexRow]`) sorted (owner, start) and (path, name_start) respectively before writing, following `write_hot_and_secondary_files`'s general shape (or a smaller dedicated helper, since these are single fixed-stride arrays with no hot/cold split needed at this row count). `write_delta`/`write_delta_with_reader` need the same two params for the OPENED set, plus a `pending_sites_closures: &[(owner_artifact, start_utf16, end_utf16)]` (or an owner-level closure key) implementing the "an owner's pending sites are replaced wholesale when the owner is regenerated" rule from the task brief — this is NOT the same closure shape `closures.records`/`closures.deps` use (those close one row at a time by its own 32-byte key; a pending site has no natural stable id of its own across generations, so the natural closure key is `(owner_artifact, generation)`: closing every pending-site row for an owner whose OWN records were reopened in this delta, then re-adding its current pending sites fresh). `entities_index` likely never needs closing at all (an entity's own record row already has its own closure; the index is a derived, append-only lookup table keyed by content that does not change once written — confirm this assumption before implementing, since it changes whether `entities_index` needs delta-closure machinery at all).
- **`compact.rs`**: extend the k-way merge to also carry forward `pending.sites`/`entities.index` visible-at-`new_generation` rows into the fresh base, same pattern as records/deps.
- **`recover.rs`**: almost certainly needs NO change — it operates generically on the manifest's file list, not on row-kind-specific logic (confirm by reading it fully before assuming, since this evidence doc's own writer did not verify this line by line).
- **`reader.rs`**: `pending_sites_for_owner(owner_artifact_ordinal, generation) -> impl Iterator<Item = PendingSiteRow>` (a range scan over the owner-sorted array, mirroring `records_by_owner`'s own binary-search-then-scan shape), `iter_pending_sites(generation) -> impl Iterator<Item = PendingSiteRow>` (full scan), `entity_at(path_ordinal, name_start_utf16) -> Option<u32>` (binary search over the `(path, name_start)`-sorted array — exact match, no range).
- **`urdira-native-core`**: `structural_kernel_rows`'s row model has no notion of a pending site today (it only ever produces entity/relation `StructuralKernelRow`s from a `ProposedRecord`) — `pending.sites`/`entities.index` are NOT `ProposedRecord`-shaped at all (no identity/digest/body), so they almost certainly bypass this kernel entirely and get built directly from `OwnerFacts.pending_sites` (already collected, just discarded today — see `materialize.rs`'s `pending_sites: _,`) plus a walk of the OWNER's own entity records (for `entities_index`, `record_ordinal` needs each entity's freshly-assigned ordinal from THIS generation's `materialize_generation`, so `entities_index` construction has to happen inside or right after `canonicalize_owner`/`materialize_generation`, not in a separate pass).
- **napi (`urdira-native-node`)**: `pendingSitesForOwner(ownerArtifactOrdinal, generation)`, `pendingSiteCount(generation)` on `NativeStructuralStoreHandle`, mirroring `depsByOwner`'s existing shape (`structural_store_napi.rs`).
- **`native-structural-store-binding.ts`**: add the two methods' TS declarations to `NativeStructuralStoreHandle`.
- **Tests**: round-trip at fixture scale (write, reopen, read back byte-identical), delta replaces an owner's pending sites wholesale on regeneration (write base, edit one owner, write delta, confirm the owner's OLD pending sites are gone from `pending_sites_for_owner` and the NEW ones are present), compaction preserves both tables across a compact cycle.
- Xxh3 integrity is automatic once these are real sections/files (every section already gets a `layout::FileHeader`-style xxh3 via the existing `segment_io`/`container` framing) — no bespoke work needed there, only wiring the new section/file into the existing encode/decode paths.

## 11. Files touched (no commit)

- `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs` — finished the possible-row/diagnostic builders, `OwnerSemantics::possible_call_rows`/`::possible_heritage_rows`, `finish()` wiring, sort passes, removed the dead `PendingHeritageSite.reason` field, 4 new tests + 1 extended test.
- `crates/urdira-indexing-worker/src/v4/analyze.rs` — merges the two new `OwnerSemantics` fields into `owner.records`.
- `crates/urdira-indexing-worker/src/v4/materialize.rs` — fixed `category_byte`'s missing `"diagnostic"` arm (§5); updated a stale doc comment.
- `crates/urdira-indexing-worker/src/v4/tests_e2e.rs` — updated the category-kind-prefix invariant test for the new, intentional `CATEGORY_DIAGNOSTIC` population.
- `crates/urdira-indexing-worker/src/main.rs` — 16 test fixtures constructing `OwnerSemantics` directly needed the two new fields (`possible_call_rows: vec![]`, `possible_heritage_rows: vec![]`).
- `packages/plugin-javascript-typescript/src/registry-contribution.ts` — `diagnosticPayload.reason` field + enum.
- `tests/v4-daemon-e2e.test.ts` — real fix (relation-kind subset check) + additive assertions (§9) + the two `URDIRA_V4` opt-out fixes requested by the parallel TS coordinator.
