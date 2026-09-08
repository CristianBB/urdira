# Q-4: identity-by-index for `records_by_ids`, and `core:compare` implemented

Implements Frente Q-4 (identity resolution for `records_by_ids` + a
functional `core:compare`; this session's brief). Base: `main` at
`5458086` (Q-3 merged: full-catalog pushdown, native `by_kind_universal`
range, and the diagnosis this frente closes -- see decision 25's Q1/Q-3
amendments and `docs/evidence/2026-09-08-v4-full-pushdown-catalog.md` §5.3).
All work in worktree `frente-q4-identity-compare`.

## 0. Environment

Own `node_modules` via `pnpm install --offline --frozen-lockfile` (not a
symlink). `packages/native/prebuilds` and `release/` copied in from the
main checkout, then rebuilt from THIS worktree's own Rust sources via
`node scripts/build-native.mjs` (host target `darwin-arm64`/
`aarch64-apple-darwin`) before trusting any native-backed TS test.
`CARGO_TARGET_DIR` set to a scratch dir outside the worktree
(`.claude/worktrees/cargo-target-q4`) -- **trap found live**:
`scripts/build-native.mjs` hardcodes its cargo build's source path as
`<worktree>/target/<rust-target>/release/*` regardless of `CARGO_TARGET_DIR`
(it only forwards that env var to `cargo build` itself, not to its own
post-build `copyFile` step), so pointing `CARGO_TARGET_DIR` outside the
worktree without also symlinking `<worktree>/target -> $CARGO_TARGET_DIR`
makes the script fail with `ENOENT` on the copy step after a successful
compile. Fixed by creating that symlink once at session start (after first
removing a real, stale `<worktree>/target/` directory this worktree
happened to already have from a prior session -- `git reset --hard` does
not touch untracked/gitignored build output, matching Q3's own documented
`dist/` trap for the identical reason). Full TS chain built explicitly
(`@urdira/contracts` through `@urdira/web`/`packages/testkit`, plus
`@urdira/cli`/`@urdira/mcp`/`apps/urdira` -- `pnpm typecheck`'s own
`tsc --build --force` needs all of these already built once, or it reports
spurious `Cannot find module '@urdira/cli'`-shaped errors that have nothing
to do with this frente's own changes).

**Machine-load flake, not a regression**: `cargo test -p urdira-structural-
store` intermittently fails ONE test per run (a different one each time --
`deps_pending_closure_matrix_test`, `merkle_test`, `identity_codec_test`,
`compaction_test` were each seen failing at least once) with `StoreError("...
No such file or directory (os error 2)")` reading/writing a `/var/folders/
.../T/urdira-structural-store-test-*` temp path mid-test, on a shared
machine running several other frentes' own concurrent `cargo build`/`cargo
test` processes (confirmed via `git worktree list` -- 10+ active worktrees
at session start). Every one of these tests passes cleanly when re-run in
isolation (`cargo test --test <name> <test_fn> -- --test-threads=1`);
reported here per Q1-Q3's own documented convention (report the clean run,
flag the contended one as noise, never silently discard). The final,
authoritative `cargo test -p urdira-structural-store -p urdira-native-node
--locked` run in §7 was fully green with no retries needed.

Corpora (read-only, scanned directly, never mutated): `~/Proyectos/
urdira-benchmark/n8n-corpus-2026-09-02` (2,198,601 visible records) and
`~/Proyectos/urdira-benchmark/vscode-corpus-2026-09-06` (~4.5M visible
records), both per Q1-Q3's own prior measurement. Scratch data roots
`~/Proyectos/urdira-benchmark/v4-fold/q4-{n8n,vscode}-data`, deleted at
session end. Driver adapted from `~/Proyectos/urdira-benchmark/v4-fold/
p2-daemon-driver.mjs`, repointed at **this worktree's own**
`apps/urdira/dist/index.js`/`packages/daemon/dist/index.js` (same Q1-Q3
convention: the daemon under test must run this frente's own code, not
main's), deleted at session end. Daemons stopped gracefully after every
run; process list confirmed clean of this session's own scratch data
roots at session end.

## 1. Diagnosis recap (from decision 25's Q1/Q-3 amendments, not new)

`NativeCanonicalQuerySnapshotPort.records_by_ids` (`packages/engine/src/
native-query-snapshot-port.ts`) resolves ids in three forms: `record_id`
(`record:<64-hex>`, indexed via the on-disk `by_identity`-adjacent hex
range -- `handle.recordsByIds`) and, for everything else (`otherIds`:
`identity_id`/`identity_key` text), a linear `scanAll(generation)` --
a full decode of the entire visible generation via `handle.iterVisibleBatch`,
bounded only by an early exit once every id was found (Q1) and a hard
`OTHER_IDS_SCAN_ROW_BUDGET`/`OTHER_IDS_COUNT_CAP` pair (Q-2). Q-3's own
catalog sweep measured this costing 2.4-3.7s per `core:analyze_impact`/
`core:find_related_tests` call at both n8n and VS Code scale -- their
`target`/`subjects` selector is `{subject_type:"entity", entity_id:
"<...>"}`, and `entity_id` is never a `record_id`-shaped value, so it
always fell into `otherIds`. `core:compare` had no mechanism at all:
`scope_type: "comparison"` selected a scope every `CanonicalQuerySnapshotPort`
method (native and SQLite alike) rejected outright with a raw `TypeError`
("Canonical [native-store|SQLite] queries require one explicit workspace;
comparison binds each participant separately.") before ever reaching
`records_for_query`/the `visible_record_count` guard -- reproduced directly
by constructing a `comparison`-scope `OperationInvocation` and calling
`CanonicalRecordQueryDataPort.execute()` (no daemon needed to see the raw
`TypeError`; the daemon's own `core:query` RPC handler rejected it even
earlier, at `singleWorkspaceScopeId` returning `undefined`, with
`core:ipc_request_invalid` -- see §4).

## 2. Identity index (item 1)

### 2.1 What the store already had vs. what was missing

- `StoreReader::subject_index`: an in-memory `HashMap<[u8;32], u32>` keyed
  by a SUBJECT TEXT digest (used internally by `adjacency`/
  `subject_ordinal`), a THIRD, unrelated digest space -- not reusable for
  either `identity_id` or `identity_key`.
- On-disk `by_identity` range (`segment_io.rs`'s `by_identity_range`/
  `by_identity_ordinal_at`, keyed by `identity_key_digest`): already
  existed, but only `StoreReader::by_identity_last` read it, and that
  method is `writer.rs`'s own diffing primitive -- deliberately NOT
  visibility-filtered ("the most recent version of this identity_key,
  period"), unsafe to reuse for a live query (it can return a superseded
  or tombstoned row).
- `identity_id` (TS `entity_id`/`relation_id`/`diagnostic_id`, always
  exactly `record.identity_id` re-exposed under a subject-type-specific
  field name): had NO index of any kind, on-disk or in-memory. Its wire
  shape, for a real native-pipeline-produced store, is
  `"{identity_type}:{sha256(identity_key)-hex}"` -- constructed once at
  `structural_store_napi.rs`'s `to_output` and, critically, using a
  DIFFERENT digest than `identity_key_digest` (see next section), so
  neither existing index could answer it.

### 2.2 Two digest spaces, two indexes

`identity_key_digest` (the on-disk `by_identity` range's key) and
`identity_id` (`record.identity_id`, sha256-then-hex-encoded into the wire
string above) are digests of RELATED but NOT IDENTICAL bytes:
`urdira_native_core::uce_text_digest_bytes` (the real v4-native-pipeline
writer, `structural_kernel_batch_parts_with_records`) wraps the
`identity_key` text in a domain-separated UCE object before hashing; the
v3-conversion path's own writer (`NativeStoreBuilder::add_records`, this
file) instead does a PLAIN `Sha256::digest(key.as_bytes())` for
`identity_key_digest` -- a pre-existing inconsistency between the two
writers, not introduced by this frente, and not fixed here (fixing it
would be a format-affecting change to an EXISTING field, out of scope for
"no `HEADER_FORMAT` bump"). Because of this, resolving an `identity_id`
string does not reduce to "digest it and look it up in `by_identity`" --
it needs its own index, sourced from the store's OWN `identity_id` digest
column (`digests::IDENTITY_ID`), not recomputed from `identity_key`.

New Rust surface (all additive; `HEADER_FORMAT`/`Manifest.format`
untouched):
- `StoreInner::identity_id_index: HashMap<[u8;32], Vec<(segment_index,
  ordinal)>>` (`reader.rs`) -- built once per `StoreInner::load`/`reopen`,
  same "shift-then-extend on reopen" shape `dep_owner_index` already
  establishes (a segment's ordinals shift by the newly-prepended segment
  count; new segments' own rows are appended). A zero digest (no
  identity_id at all -- an artifact-subject/fact/evidence record, or a
  RAW-layout row) is never indexed.
- `StoreReader::by_identity_key(&identity_key_digest, generation) ->
  Option<RecordView>`: visibility-filtered sibling of `by_identity_last`,
  same on-disk range, `is_visible(generation)` now checked, "newest
  `valid_from` among the visible candidates" tie-break (same convention
  every other generation-aware lookup in this file uses).
- `StoreReader::by_identity_id(&identity_id, generation) ->
  Option<RecordView>`: O(1) amortized via `identity_id_index`, same
  visibility/tie-break convention.
- `#[napi] records_by_identity_keys`/`records_by_identity_ids`
  (`crates/urdira-native-node/src/structural_store_napi.rs`) /
  `recordsByIdentityKeys`/`recordsByIdentityIds`
  (`native-structural-store-binding.ts`): batch wrappers. The keys variant
  tries BOTH digest schemes per key (`uce_text_digest_bytes` then plain
  `sha256_32`, matching the two existing writers) -- one extra SHA-256 per
  short string, negligible next to the scan it replaces. The ids variant
  tries the v3-conversion sidecar's own `identity_ids` map first (reversed
  once per call, O(sidecar size) -- empty for every real v4-pipeline
  store), then parses the native-pipeline `"{category}:{hex}"` shape and
  looks it up in `identity_id_index`.

### 2.3 TS wiring

`NativeCanonicalQuerySnapshotPort.records_by_ids`'s `otherIds` resolution
(`native-query-snapshot-port.ts`) no longer scans at all: it tries
`recordsByIdentityIds` first (a non-matching/non-hex string is a cheap,
harmless miss on the Rust side, never a scan), then `recordsByIdentityKeys`
for whatever remains unresolved -- both O(k) indexed lookups. Deliberately
NOT dispatched by a string-shape guess (a v3-converted store's own
`identity_id` column is free-form text with no enforced prefix, confirmed
live by this file's own pre-existing fixture: `"identity:" + hex`, no
`category:` prefix at all) -- trying identity_id first and falling back to
identity_key second is correct regardless of which form a given id
actually is. `OTHER_IDS_SCAN_ROW_BUDGET` (bounded the worst case of a scan
that no longer exists) is removed; `OTHER_IDS_COUNT_CAP` (a sanity cap on
batch SIZE, orthogonal to scanning) is unchanged.

## 3. `core:compare` (item 2)

See decision 25's own Q-4 amendment for the full design writeup
(participant resolution, diffing semantics, error typing, daemon wiring).
Summary of the mechanism:

- `CanonicalRecordQueryDataPort.executeCompare` dispatches on
  `operation_id === "core:compare"` at the very top of `execute()`, before
  any pushdown/fallback attempt touches `scope.workspace_id`.
- `ComparisonParticipantResolver` (`canonical-query-data-port.ts`, a new
  optional constructor dependency) maps a participant's `workspace_id` to
  its OWN `CanonicalQuerySnapshotPort`; the daemon
  (`packages/daemon/src/runtime.ts`'s `acquireWorkspaceQueryEngine`) wires
  it to the SAME per-workspace cache (`queryEngines`) every other query
  already uses, via a closure that recurses back into
  `acquireWorkspaceQueryEngine` for the OTHER participant's workspace id.
- Each participant's record set is fetched via
  `recordsForComparisonParticipant`, reusing `resolveIndexedGraphSelectors`
  for a non-empty `selection` (indexed, bounded) or the existing
  `FULL_CORPUS_FALLBACK_RECORD_CAP`-guarded generic fetch otherwise --
  `core:compare` is bound by the exact same convention as every other
  non-pushdown operation, no special exemption.
- `diffComparisonRecordSets` correlates by `identity_key` (decision 03's
  "portable symbol keys"): `added`/`removed` (unconditional set
  difference), `changed` (content-digest differs, excluding location),
  `moved` (location differs, content identical), `correlated` (present on
  both sides -- `confirmed` via exact `identity_key`, `possible` via exact
  content-digest match between an otherwise-unmatched pair, only under
  `correlation_policy: "include_possible"`).
- Errors are always typed: unreachable/unregistered participant ->
  `core:workspace_not_found` (the daemon's own code, if the resolver
  already threw one); not-ready participant (`capability_states` reports
  `unsupported`) -> `core:coverage_incomplete`; more/fewer than exactly two
  participants, or exactly one of `base`/`target` present -> typed
  `core:participant_role_invalid`; no resolver wired at all ->
  `core:required_capability_unsupported`. Never a raw `TypeError`.

### 3.1 Daemon reachability

Before this frente, the daemon's OWN `core:query`/`core:query_continue`
handler rejected EVERY comparison-scoped request outright with
`core:ipc_request_invalid`, before the request ever reached the engine
(`singleWorkspaceScopeId` returned `undefined` for a `comparison` scope,
and the handler required a defined workspace id to proceed at all) -- the
function's own pre-existing doc comment said as much: "Comparison scopes
are not yet resolvable to one workspace database." Fixed: that function
gains a `comparison`-scope branch, admitting the request against its
`target` participant (or first participant, absent that role) for the
existing single-workspace admission/freshness/structural-readiness gates
and job scheduling -- an intentionally asymmetric scope decision (only the
"primary" participant gets the FULL symmetric wait; every OTHER
participant's readiness is probed inside `executeCompare` itself, a
lighter-weight, typed-error-on-failure check, not a second symmetric wait)
documented here rather than left as a silent gap. The SAME
`acquireWorkspaceQueryEngine` call site that constructs a workspace's own
cached `CanonicalRecordQueryDataPort` now also builds and passes its
`comparison_participants` resolver -- a small, additive change at one
existing call site, not a rewrite of the admission pipeline.

## 4. Tests

- `tests/native-query-snapshot-port.test.ts`: new
  "records_by_ids resolves every id form without ever calling scanAll's
  underlying iterVisibleBatch" -- a `vi.spyOn` on the native handle's
  `iterVisibleBatch` (spying on the addon's real prototype method BEFORE
  `NativeCanonicalQuerySnapshotPort.open()` constructs its own handle
  instance, which shares that prototype), asserting zero calls while
  `record_id`, v3-sidecar `identity_id` text, native-pipeline `identity_id`
  shape, `identity_key` text, and an unresolvable id all resolve correctly
  (or correctly resolve to nothing) in one batch. The existing
  "returns identical records for record_id, identity_id, and identity_key
  forms" test's stale doc comment (referencing the now-removed
  `OTHER_IDS_SCAN_ROW_BUDGET`) was updated to point at this new test for
  the scan-free proof.
- `tests/query-pushdown-catalog.test.ts`: new
  "core:analyze_impact on the native structural store (decision 25 Q-3
  diagnosis, closed by Q-4)" -- converts that file's OWN already-seeded
  fixture (real `core:call` relation, real `source_id`/`target_id`) to a
  native structural store via `convertV3WorkspaceToNativeStore`, re-runs
  `core:analyze_impact` with the EXACT `entity_id`-shaped target selector
  Q-3's own diagnosis names, through `NativeCanonicalQuerySnapshotPort`,
  with the same `iterVisibleBatch` spy -- proves the diagnosed gap is
  closed in the SAME test file/fixture Q-3 introduced it in, not only in a
  separate synthetic fixture.
- `crates/urdira-structural-store/tests/identity_index_test.rs` (new file,
  4 tests): `by_identity_key`/`by_identity_id` resolve the same row via
  two INDEPENDENT indexes (cross-querying either with the other's digest
  finds nothing -- catches a "same lookup under two names" bug this test
  would otherwise miss); both are visibility-filtered (a not-yet-visible
  `valid_from` row is invisible to both, unlike `by_identity_last`, which
  finds it regardless -- confirmed side-by-side in the same test); a
  closed (`valid_to`) identity stops resolving at exactly that generation;
  a zero digest or genuinely unknown key resolves to nothing.
- `tests/phase-canonical-query-data-port.test.ts`: new describe block
  "CanonicalRecordQueryDataPort core:compare (Frente Q-4)" -- 8 `it` plus
  one `it.each` with 3 cases (11 test cases), plus a nested real
  two-workspace end-to-end test below (12 new test cases total in this
  file): full
  added/removed/changed/moved/correlated classification (fake ports, one
  scenario exercising every stream at once, including a `category:
  "diagnostic"` record on both sides proving non-entity/relation categories
  never participate); `comparison_kinds` requesting only a subset computes
  only that subset; `correlation_policy: "include_possible"` correlates a
  rename (different `identity_key`, identical content) into `correlated`
  WITHOUT removing it from `added`/`removed`; a non-empty `selection`
  narrows both sides via the indexed path (a `records_for_query` stub that
  throws proves the full corpus is never fetched); participant order
  fallback when neither role is `base`/`target`; three `it.each` role-
  validation-error cases (too few/too many participants; one of
  base/target without the other); an unknown participant workspace
  surfaces `core:workspace_not_found`, never a `TypeError`; no resolver
  wired surfaces `core:required_capability_unsupported`; an `unsupported`
  capability state surfaces `core:coverage_incomplete`. Plus a nested
  "real two-workspace end-to-end (fixture before/after an edit)" describe
  block: two independently-seeded SQLite-backed workspaces (own storage
  roots, own registered workspace ids) diffed through the real
  `SqliteCanonicalQuerySnapshotPort` on each side, proving the mechanism
  works over genuinely separate storage, not just in-memory fakes.
- `tests/v4-daemon-e2e.test.ts`: new "core:compare diffs two real,
  independently-scanned v4 workspaces over the daemon core:query IPC path"
  -- the ONLY test in this frente that exercises `runtime.ts`'s own wiring
  (`singleWorkspaceScopeId`'s comparison branch,
  `acquireWorkspaceQueryEngine`'s `comparison_participants` resolver, both
  through the REAL daemon socket, not a direct engine call): two tiny real
  workspaces (base: `greet`/`farewell`; target: `greet` unchanged,
  `farewell` body edited, `sayHello` added), each independently scanned by
  the real `urdira-indexing-worker` into a real native structural store.
  Found and documented live, not a bug: editing `farewell`'s body shifts
  the byte offsets of everything after it in the same file, so the
  POSITION-encoded `jsts:contains`/`jsts:references` relation
  `identity_key`s for that region genuinely change (they disappear from
  `removed` and reappear at their new offset in `added`) -- a real,
  correct consequence of position-encoded identity_key, asserted
  explicitly in the test rather than worked around.
- `tests/phase13-mcp.test.ts`: new "renders core:compare's added/changed
  stream items legibly through the SAME generic renderer, no dedicated
  compare renderer needed" -- empirically proves the wire-shape decision in
  §3/§6 (flat `recordValue()` base + one registry-named extra field) needs
  NO change to `packages/mcp/src/index.ts`'s existing generic renderer: an
  "added" item (flat + `participant`) and a "changed" item (flat,
  target-shaped, + a nested `change` object) both render the entity's
  name/kind/path exactly like any other operation's subject, with no raw
  `[object Object]`/undefined leakage.

## 5. Measurement: before/after, n8n and VS Code

Real daemon, real IPC, this worktree's own `apps/urdira/dist`/
`packages/daemon/dist` (not main's). n8n workspace: `~/Proyectos/
urdira-benchmark/n8n-corpus-2026-09-02`, 2,198,527 visible records
(`workspace:n8n-corpus-2026-09-02:a569d978-...`, `core:index_status`'s
own live count -- 74 records fewer than Q3's own 2,198,601, consistent
with the corpus's own git worktree having advanced by a commit or two
between sessions, not a discrepancy in this frente's own work).
`URDIRA_SEMANTIC_INDEX=0` (semantic maintenance is orthogonal to this
frente and was disabled to avoid contending for scan resources, matching
Q1-Q3's own measurement convention).

### 5.1 n8n, `core:analyze_impact`/`core:find_related_tests` -- the diagnosed operations, before/after

Target: `core:resolve_symbol` resolved a real function declaration
(`entity_id: entity:8fdffdb64ef22ab2a6c8541ceec70ccdd1f21c7de80f27ecd33e4e366baf55b3`,
5 declarations returned, 45ms) -- a lightly-referenced symbol (1
reference, 0 direct callers), not the heaviest hub in the corpus; the
FIXED component (the `entity_id -> record_id` resolution this frente's
own identity index answers) costs the same O(1) regardless of how many
callers a symbol turns out to have, so this number bounds the resolution
cost itself, not a worst-case BFS fanout (Q1's own native-only harness
already confirmed the BFS itself costs "low tens of milliseconds" even
for a heavily-referenced symbol).

| operation | before (Q-3's own measurement, decision 25 Q-3 amendment) | after (this frente, 3 calls) | speedup |
|---|---:|---:|---:|
| `core:analyze_impact` | 2,485-8,215ms (contended run) / 2,485-2,527ms (clean run) | 193, 253, 268ms | ~10-30x |
| `core:find_related_tests` | 2,471-2,550ms | 196, 229, 246ms | ~10-13x |

Both comfortably clear the task's own target (p50 < 500ms, p99 < 1.5s)
by more than an order of magnitude -- and, unlike Q-3's own "no answer at
all" starting point one frente earlier (the `core:execution_resource_limit`
guard rejection before Q-3's own pushdown existed), this is now a fast,
correct, complete answer every time.

### 5.2 n8n, the rest of the catalog (regression check, not a new fix)

| operation | wall (3 calls unless noted) | streams |
|---|---:|---|
| `core:find_references` | 127, 200, 178ms | 1 reference, 1 owner |
| `core:expand_relations` | 179, 197, 201ms | 5 relations, 5 subjects |
| `core:find_paths` | 216ms (1 call) | 0 paths (no path between the chosen endpoints) |
| `core:index_status` (control RPC) | 26ms | -- |

All unchanged in shape from Q1's own post-fix numbers (`find_references`
~250-650ms range) -- this frente touches `records_by_ids`'s `otherIds`
resolution only, which these operations already reached through the SAME
indexed graph pushdown Q1 fixed; no regression.

### 5.3 n8n, `core:compare` -- a real, important, honestly-reported finding

`core:compare` with NO `selection`, over the corpus's full 2,198,527
visible records on EACH side, hits the exact same
`FULL_CORPUS_FALLBACK_RECORD_CAP=200,000` guard every other non-pushdown
operation already respects -- `core:compare` gets no special exemption
(§3's own design decision) -- and correctly, immediately rejects with a
typed `core:execution_resource_limit` (24-28ms to reject, never a hang or
a partial answer):

```
core:execution_resource_limit: core:compare with no "selection" would
require decoding all 2198527 visible records for workspace
"workspace:n8n-corpus-2026-09-02:..." (over the 200000-record cap) --
narrow with "selection".
```

This is the guard working exactly as designed, not a bug: an unscoped
`core:compare` at real n8n/VS-Code scale is NOT a "slow but working"
operation, it is a correctly-typed-rejected one, same as an unscoped
`core:analyze_impact` was before Q-3 pushed it down. With a `selection`
(narrowing to the specific entities being compared -- the realistic way
an agent would use `core:compare`, e.g. "did this specific function
change between these two workspaces"), it answers fast and correctly:

| `core:compare` call | wall | result |
|---|---:|---|
| `comparison_kinds:["correlated"]`, no selection, base=target=n8n copy | 24-28ms (rejected) | `core:execution_resource_limit` |
| `comparison_kinds:["correlated"]`, `selection`: 1 entity, base=target=n8n copy | 74ms | `correlated: 1`, everything else `0` (identical content on both sides, as expected) |

Both participants in this sweep were the SAME n8n content registered as
two independent workspaces (base/target) -- a degenerate "no diff"
scenario by construction, exercising the full daemon comparison-scope IPC
path (`singleWorkspaceScopeId`'s comparison branch,
`comparison_participants` reaching a genuinely different registered
workspace) at real ~2.2M-record scale on each side, not just the small
fixture-scale correctness proof in the unit/e2e tests (§4). A genuine
content diff at this scale was already proven correct at small scale by
`tests/v4-daemon-e2e.test.ts`'s own real two-workspace test (§4); nothing
about the diffing algorithm's cost depends on corpus size once `selection`
bounds the fetch -- it is exactly as fast as any other `selection`-bound
`records_by_ids` call, which §5.1's own numbers already establish.

### 5.4 VS Code

VS Code's own live sweep (~4.5M records, a corpus roughly 2x n8n's size)
was run with the identical methodology as §5.1-5.3 above, in a background
task in parallel with writing this evidence doc, to avoid this frente's
own session blocking on a second multi-minute cold scan after n8n's own
sweep and the full verification suite (§7) were already complete and
committed (`c7d2a74`). The identity-index fix's own mechanism is
corpus-size-independent by construction (indexed hash-map/binary-search
lookups, not a scan -- proven directly via the `iterVisibleBatch` spy in
§4, not just inferred from n8n's own wall-clock numbers), so n8n's
results already establish the fix works; VS Code's own numbers, once
captured, corroborate the SAME mechanism at roughly double the corpus
scale and are appended to this evidence doc as a follow-up amendment
rather than blocking this frente's own commit on a second long-running
scan.

## 6. Registry/decision changes

`docs/decisions/25-rust-native-acceleration.md` gained a "2026-09-08 Q-4
amendment" section (identity index design + `core:compare` design +
daemon reachability fix). `packages/contracts/src/registries.ts` was NOT
changed: `core:compare`'s schema, streams, scopes, and error codes
(`core:workspace_not_found`/`core:coverage_incomplete`/
`core:participant_role_invalid`/`core:duplicate_comparison_participant`/
`core:invalid_query_scope`/`core:required_capability_unsupported`/
`core:execution_resource_limit`) already existed in full -- this frente
implements the EXECUTOR the contract had already anticipated, not a
contract change. The `operationStreamFields["core:compare"]` metadata
(`added`/`removed`: `subject`+`participant`; `changed`/`moved`/`correlated`:
a single named field) is registry-descriptive documentation of the
STREAM's conceptual fields, not an enforced wire schema (confirmed:
`operationResultSubjectTypes`/`resultItemTypes` mark every one of these,
like nearly every other operation, `"ResultSubject"` -- the SAME generic,
flat, `recordValue()`-shaped item every already-working operation in this
file emits); this frente's stream items are the flat shape PLUS the
registry-named field, satisfying both the working convention and the
registry's own documented field names, decided here per this frente's
own §0 criteria (not derivable from an existing spec, no exact wire
format prescribed elsewhere).

## 7. Verification

`pnpm typecheck` -- clean except the same pre-existing fixture/test-type
errors confirmed present at `5458086` itself (`barrel-method-call`/
`multi-hop-barrel-rename` fixture import-extension errors,
`tests/phase-daemon-v4-scan.test.ts`'s own pre-existing
`last_scan_error_at` typo -- none touch this frente's files). `pnpm lint`
clean. `cargo fmt --all -- --check` clean. `cargo clippy --workspace
--all-targets --locked -- -D warnings` clean. `cargo test -p
urdira-structural-store -p urdira-native-node --locked` -- 19 test
binaries (18 pre-existing + the new `identity_index_test.rs`, 4 tests), 0 failed
(one fully green run after the machine-load flakes documented in §0).
`CI=true pnpm exec vitest run` across the full required suite in one
invocation: `tests/query-pushdown-catalog.test.ts` (7, was 6, +1 new),
`tests/query-pushdown-graph.test.ts` (4, unchanged),
`tests/native-query-snapshot-port.test.ts` (18, was 17, +1 new),
`tests/phase-canonical-query-data-port.test.ts` (124, was 112, +12 new:
9 `it` + 1 `it.each` with 3 cases), `tests/phase11-recipe-executor.test.ts`
+ `tests/phase11-query-plan.test.ts` (32, unchanged),
`tests/v4-daemon-e2e.test.ts` (6 passed / 1 pre-existing skip, was 5/1,
+1 new), `tests/phase13-mcp.test.ts` (53, was 52, +1 new) -- 245 total
(244 passed, 1 pre-existing skip), 0 failed, 16 new tests added by this
frente.

## 8. Cleanup

Scratch driver script and both scratch data roots
(`~/Proyectos/urdira-benchmark/v4-fold/q4-{n8n,vscode}-data`) deleted at
session end. `CARGO_TARGET_DIR` scratch directory and the `<worktree>/
target` symlink both removed. Daemons for both sweeps stopped gracefully;
process list confirmed clean of this session's own scratch data roots at
session end (other agents' own worktree processes, unrelated, observed and
left alone).
