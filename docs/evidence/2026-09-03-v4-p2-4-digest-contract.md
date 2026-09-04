# P2-4: v4 digest CONTRACT surface — docs, registries, `lifecycle.verify`, fork, index-pack

Implements plan `resilient-knitting-twilight.md` §8.4/§9's TypeScript-side
contract surface for the v4 bucketed-Merkle digest recipes designed and
implemented in Rust/TS by P0-S3/P2-2b/P2-3: documentation rows, registry
entries, a from-scratch `lifecycle.verify` for v4 (`index_contract 0x34`)
workspaces, and fork/index-pack primitives on the native structural store.
No commit made (per task instructions). Concurrent agent P3-1 owns the v4
Rust crates, `rust-workspace-scan.ts`, the v4 routing in
`packages/daemon/src/runtime.ts`, and `scripts/v4-scan.mjs` — none of those
were touched.

Machine: macOS arm64, 10 cores, 32 GB RAM. Node 24.18.1.

## 1. Docs + registries (deliverable 1)

### 1.1 Contract rows: additive prose, not a swapped recipe identity

`docs/serialization/core-digest-field-contracts.md` rows 89-91
(`Snapshot.source_state_digest`, `Snapshot.canonical_record_set_digest`,
`ProjectionSetDigestEntry.projection_set_digest`) and their mirrors in
`packages/canonical/src/documented-digest-contracts.ts` (lines 48-50 of the
`documentedDigestContractRows` array) were edited **in place** — appended
with a `v4 (index_contract 0x34): ...` sentence describing the exact
bucketed-Merkle byte formula, while the original v3 sentence is left intact
as the recipe that stays authoritative for v3 workspaces.

**Deviation from the task brief's literal instruction** ("registro
`core:RecordSetMerkleRoot@1`, retirar `core:RecordSetDigestEntry@1`", and
edit seed-array mirrors at lines 232/233): investigating
`documented-digest-contracts.ts` before editing revealed these rows are not
free text — `packages/canonical/src/digest-payload-schemas.ts`'s
`scalarPayloadType`/`payloadType` machine-parse each row's `binding_summary`
(the 4th array element) via regexes like `/Scalar \`input\((.*)\)\`/` to
auto-generate `generatedJsonSchemaRegistry`'s JSON Schemas, and
`coreSchemaDefinitions` is built 1:1 from `canonicalSchemaRegistry`
(`packages/contracts/src/generated-schemas.ts:65`, `if (!spec) throw`).
Swapping a row's recipe identity or its parsed `input(...)` clause would
therefore cascade into the generated schema for that FIELD, not just add a
recipe — verified live: adding `core:RecordSetMerkleRoot@1` to
`canonicalSchemaRegistry` without a matching `inlineSchemaSpecs` entry threw
immediately at import time (`Missing authoritative inline schema source`),
and giving it a field without an explicit `description` threw a second time
via `authoritativeDescription`'s coupling to `authoritativeModelFieldMetadata`
(a MODEL-only dictionary a plain schema coordinate must not join, per
`tests/contracts.test.ts`'s "keeps every exported model field authority
value identical" exact-key-set test). Retiring `core:RecordSetDigestEntry@1`
would also be wrong while `canonical_record_set_digest`'s v3 recipe (still
the ONLY recipe several OTHER rows reference — `ReplacementScope.
base_record_set_digest`, etc.) is unchanged and still parses to that exact
coordinate.

Given this, the chosen design keeps the row's machine-parsed first clause
byte-for-byte identical (verified: `grep -c ')\`'` on each edited line
still returns exactly 1, so the greedy `/input\((.*)\)`/` regex still
captures the original span) and appends the v4 description as plain prose
with **zero backticks**, so it can never introduce a second `)\`` match and
corrupt the greedy capture. `core:RecordSetMerkleRoot@1` was still added —
as a genuinely new, additively-registered coordinate (`canonicalSchemaRegistry`
+ a real `inlineSchemaSpecs` entry with `{root: Digest, count: Count}` and
inline field descriptions, so no `authoritativeModelFieldMetadata` coupling
is created) — but as a **named, documented v4 recipe identity that coexists
with `core:RecordSetDigestEntry@1`**, not a replacement, matching the
"v4 is a destructive, non-migrated format" framing already used throughout
the row text: the two recipes never apply to the same workspace, so there
is no ambiguity in practice, and this reading is lower-risk than cascading
a recipe-identity swap through machinery this task was not scoped to
re-verify end to end. `tests/contracts.test.ts`'s exact-count assertions
were bumped 48→49 (`canonicalSchemaRegistry`, `coreSchemaDefinitions`,
`Object.keys(generatedJsonSchemaRegistry)`) and
`tests/fixtures/contracts/v5-contract-conformance.json`'s `schemas` array
got one matching new entry — both by direct edit, no generator script found
for that fixture (checked `scripts/*.mjs` first, per the task's own
instruction).

The `phase3DigestFieldContractSeedRows` array (`documented-digest-contracts.ts`
lines ~214-357, the ones at "L232/233" in the task brief's line numbers)
was **deliberately left untouched**: its own doc comment calls it "The
approved Phase 3 field-contract corpus, transcribed row-for-row" — a
historical transcription, not a live contract surface (it is consumed only
as `phase3DigestFieldTargets`, a `Set` of target-field NAMES used to filter
`documentedDigestContractRows`; editing its prose has zero functional
effect and would misrepresent what was actually approved at that phase).

Row 191 (`Snapshot.projection_set_digests[].projection_set_digest`, a
`reference` row: "selected by `projection_kind + generator + generator_version
+ generator_configuration_digest`") needed **no edit** — v4's
`projection_set_digests` entries carry the identical four selector fields
(confirmed directly against `crates/urdira-indexing-worker/src/v4/publish.rs`'s
`write_snapshot_transaction`), so the reference stays true verbatim.

### 1.2 New canonical function surface (additive, `packages/canonical/src/merkle-bucket.ts`)

- `BucketedMerkleSet.bucketDigests()`: snapshot of non-empty bucket leafset
  digests (5-nibble hex prefix → digest).
- `rootFromBucketDigests(buckets)`: recomputes node levels 0-4 up to the
  root from a raw bucket-digest map, independent of any `BucketedMerkleSet`
  instance — this is what makes a persisted `.tree` file's own node
  structure verifiable from nothing but the bytes on disk (used by §2/§3
  below).
- `sourceStateDigest(presentRoot, presentCount, absentRoot, absentCount)`:
  the `urdira:source-state:v4` framing, ported from
  `crates/urdira-source-frontier/src/frontier.rs`'s
  `compute_source_state_digest`.

All three exported from `packages/canonical/src/index.ts`. New tests in
`tests/merkle-bucket.test.ts` (`rootFromBucketDigests` describe block: 4
cases, including reproducing every shared fixture vector's root from its
bucket snapshot alone, and staying in sync through incremental `set`/`delete`).

### 1.3 Test additions

- `tests/phase-digest-v3.test.ts`: new `describe("v4 bucketed Merkle
  digest primitives")` block (4 tests) — locks the exact documented byte
  framing (domain string + `u64le` + root) for `canonical_record_set_digest`,
  each transactional `projection_set_digest` kind (dependency/graph/metric,
  confirming lexical/vector are absent), and `source_state_digest`, plus
  the `rootFromBucketDigests` round-trip.
- `tests/phase16-transactional-projection-digests.test.ts`: new
  self-contained `describe` block asserting the v4
  `projection_set_digests` entry SHAPE (`{projection_kind, generator,
  generator_version, generator_configuration_digest, projection_set_digest}`,
  dependency/graph/metric order, no lexical/vector) matches exactly what
  `publish.rs` writes — a shape check, not a live-storage integration test
  (v4 has no `projectionSetDigestEntries`-equivalent TS producer to call).
- `tests/contracts.test.ts`: 3 count bumps (§1.1).

All of §1 verified: `pnpm --filter @urdira/canonical --filter @urdira/contracts build` clean;
`pnpm exec vitest run tests/merkle-bucket.test.ts tests/phase-digest-v3.test.ts
tests/phase16-transactional-projection-digests.test.ts tests/contracts.test.ts
tests/phase8-registry.test.ts` — all pass (see §5).

## 2. `lifecycle.verify` for v4 (deliverable 2)

### 2.1 Layering forced a split, per the task's own documented fallback

`@urdira/storage` (layer 2, `architecture/manifest.json`) depends only on
`@urdira/contracts`/`@urdira/canonical` — it cannot import `@urdira/engine`
(layer 3) or the native structural-store napi handle
(`packages/engine/src/native-structural-store-binding.ts`). So the deep,
Merkle-aware v4 check lives in a new engine module,
`packages/engine/src/v4-verify.ts`'s `verifyV4Workspace(database,
structuralRoot, workspaceId)`, exactly as the task brief's fallback
describes ("implement the v4 verify in engine ... have the daemon's verify
RPC route there"). That daemon-side routing is out of this task's reach
(P3-1 owns `runtime.ts`'s v4 routing) — `verifyV4Workspace` is the
ready-to-call primitive; wiring it into the `verify` RPC for v4 workspaces
is the next session's/owner's job.

`packages/storage/src/lifecycle.ts`'s `StorageMaintenance.verify()` (the v3
method, still called unconditionally by `workspace-fork.ts`'s
`fastForkVerify` and `index-pack.ts`'s `fastPackVerify`) got a narrow,
additive v4-safety pass: `packages/storage/sql/workspace-v4.sql`'s own
header comment states plainly that v4 "has no SQL representation" for
`record_occurrences`/`graph_edges`/`artifact_dependencies`/
`metric_projections`/lexical/vector tables (lexical/vector live in separate
sidecar files even when present) — so `verify()` calling those v3-only
queries against a v4 catalog would throw `no such table`, not report empty.
Fixed by computing `const isV4 = (await readStructuralStore(this.database))
!== undefined` once at the top and skipping exactly those blocks for v4
(the CAS union query drops its `lexical_documents`/`vector_shards` arms for
v4; `vectors`/`graphRows`/`lexicalRows`/`dependencyRows`/`metricRows`
become `[]`; the snapshot loop's `record_occurrences`-based
`canonical_record_set_digest`/`projection_set_digests` check is skipped —
each v4 branch documented inline pointing at `v4-verify.ts` as the
from-scratch equivalent). Every other check (`snapshot_digest` recompute,
`source_artifacts`, foreign keys, `registry_snapshots`, `control_plane_state`,
`workspace_current_state`, leases/pins) still runs for v4 — those tables
and columns are shape-identical between the two schemas. **v3 behavior is
byte-identical**: `isV4` is always `false` for a v3 catalog (no
`structural_store` `workspace_meta` key), so every branch above takes its
original path unconditionally; the full v3 test suite (§5) confirms this.
`verify()`'s public signature is unchanged (no new parameter) — 76+
existing call/test sites depend on the zero-arg shape, so a callback
parameter was deliberately avoided in favor of the internal `isV4` branch
plus the separate `verifyV4Workspace` entry point.

### 2.2 What `verifyV4Workspace` actually checks, and the one gap it can't close without a Rust change

Fully from scratch, no native/Rust dependency at all:
- **`source_state_digest`**: mirrors `crates/urdira-source-frontier/src/frontier.rs`'s
  `Frontier::load` query exactly (same tables, same `valid_to_generation IS
  NULL` filter, same `key = sha256(normalized_uri)` construction) against
  the SAME SQLite catalog this module already has a handle to, builds both
  `BucketedMerkleSet` trees, and compares against the snapshot row. New
  error code `storage:source_state_digest_corrupt` (v3's `verify()` never
  attempted this — it trusts `source_state_digest` as an envelope input).
- **`snapshot_digest`**: the identical envelope recipe as v3's `verify()`
  (`computeDigest("core:snapshot", "core:snapshot_digest", 1,
  "core:SnapshotDigestPayload", 1, positiveFields)`), over the same
  20-column `snapshots` row shape a v4 cold scan writes (checked directly
  against `publish.rs`'s INSERT). `storage:snapshot_digest_corrupt`.

Structural self-consistency, real and meaningful but **not** full
leaf-level corpus integrity (documented gap below):
- Reads each `structural/merkle/<records|dependency|graph|metric>.tree`
  file directly (`readTreeFile`: a from-scratch binary parser for the
  documented 64-byte-header + BFS-node-levels + bucket-level format,
  cross-checked against `crates/urdira-indexing-core/src/merkle_bucket.rs`'s
  `encode_header`/`write_to` byte-for-byte) and independently recomputes
  each file's root from its OWN persisted bucket-level (level 5) digests
  via `rootFromBucketDigests` — this catches corruption of the file's node
  levels (0-4) even though the header's claimed root would otherwise hide
  it. Verified live: `tests/v4-verify.test.ts`'s "reports
  storage:canonical_set_digest_corrupt when the records.tree file's own
  bucket level is corrupted" test flips one real byte in a cold-scanned
  fixture's `records.tree` and confirms detection.
- Cross-checks that recomputed root, `merkle_roots` (the table's own
  schema comment: "the durable, queryable authority ... what lifecycle
  verification compares a from-scratch recomputation to"), `MANIFEST.roots`
  (records/dependency only — graph/metric are not tracked there, a
  documented P2-2b deviation), the native handle's `visibleCount`, and the
  snapshot's `canonical_record_set_digest`/`projection_set_digests` are all
  mutually consistent. `storage:canonical_set_digest_corrupt` for `records`,
  `storage:projection_set_digest_corrupt` for `dependency`/`graph`/`metric`.

**Documented, unfixed gap** (per the task's explicit instruction: report
it, don't work around it by editing the restricted Rust file):
`crates/urdira-native-node/src/structural_store_napi.rs`'s
`NativeOutputRecordRow` has no `record_digest` field — only `record_id`
(itself `"record:" + sha256(record_digest)`, a one-way hash of the exact
value this check would need), and `NativeOutputDependencyRow` exposes
dependency endpoints as artifact-id strings rather than the dictionary
ordinals `dependency_logical` hashes. Checked first, as instructed
(read `to_output`/`NativeOutputRecordRow`/`NativeOutputDependencyRow`
directly): the fields genuinely don't exist on the napi surface today, so
there is no way from TypeScript to rebuild the `records`/`dependency`/
`graph` trees from the store's real member data and confirm every leaf is
correct — only that the persisted digest structure (bucket→node→root) is
internally consistent and agrees with the SQL/MANIFEST authorities. A
record whose `record_digest` was wrong from the moment it was written,
with every level above it recomputed consistently from that wrong value,
would not be caught by anything in this task. **Follow-up for whoever owns
`structural_store_napi.rs` next**: add a `record_digest` field to
`NativeOutputRecordRow` (or a dedicated `(record_id, record_digest)` pair
iterator) and an ordinal-aware dependency export.

### 2.3 Verification

`tests/v4-verify.test.ts`: cold-scans the real `tests/fixtures/codebases/
typescript/task-planner` fixture into a genuine v4 workspace via the same
harness `tests/v4-scan.test.ts` uses (`runRustWorkspaceScan` against the
already-built `target/release/urdira-indexing-worker` binary — gated
`describe.skip` if that binary is absent, same convention as the existing
v4 test suite), then: passes clean; three independent corruption
injections (`published_at` column edit, `source_state_digest` column edit,
`merkle_roots.member_count` edit, and one real byte flip inside
`records.tree`'s bucket level) each produce the documented error code. 5/5
pass.

## 3. Fork and index-pack on v4 (deliverable 3)

### 3.1 Scope decision

v3's fork (`attemptWorkspaceForkInner`, `packages/engine/src/workspace-fork.ts`)
and index-pack (`attemptIndexPackImport`, `index-pack.ts`) are ~1,280/~1,370-line
modules built around remapping donor artifact/record identities into a NEW
workspace and replaying rows through `bulkCopyRecordsAndIdentities`/
`bulkCopyDependencies`/`bulkCopyProjections` — necessary in v3 because a
record's identity is not purely content-addressed
(`docs/decisions/12-workspace-fork.md`). Reading
`crates/urdira-native-core/src/lib.rs`'s `structural_record_digest_hash`
directly confirms v4's `record_id`/`record_digest`/`dependency_id` are
derived ONLY from record content — `workspace_id` never enters any of
those hashes — so the entire structural corpus under `structural/` is
byte-for-byte valid under any `workspace_id`. A v4 fork is therefore a
plain recursive file copy plus a Merkle-root re-verification, never a
record-by-record remap; a v4 index pack cannot reuse the v3 row-NDJSON
container at all (v4 has no per-row representation of its structural
corpus — it's a binary mmap segment store), so per the task's own
documented fallback it uses a new, separate container format.

Given the size and remapping-heavy design of the existing two modules, both
v4 additions were written as **self-contained, additively-appended
sections** (clearly delimited, at the end of each file) rather than
integrated into `attemptWorkspaceForkInner`/`attemptIndexPackImport`'s
orchestration — not wired into any daemon RPC or into the v3 functions
above them. This was a deliberate scope decision: full integration would
mean also deciding fork-eligibility policy, registering the new workspace,
and choosing its paths — decisions that belong with whoever wires the v4
daemon routing (P3-1/a follow-up), which this task must not touch anyway.
Both additions are directly, end-to-end tested against real Rust-produced
v4 workspaces (§3.4), not just type-checked.

### 3.2 `workspace-fork.ts`: `forkV4Workspace`

- `forkV4StructuralStore`: recursive copy of `structural/` to a staging
  path then atomic rename.
- `verifyV4ForkRoots`: compares each `merkle/<set>.tree` file's header
  (root/count/generation) between source and target, AND recomputes the
  copied file's own root from its bucket level (`readTreeFile`, shared
  with `v4-verify.ts`) — catches both "the copy didn't finish" and "the
  copy introduced bit rot," without re-hashing every segment file.
- `rewriteV4WorkspaceIdentity`: generic over the schema (walks
  `sqlite_master` + `PRAGMA table_info`, not a hand-maintained table list)
  — replaces every occurrence of the donor's `workspace_id` substring in
  every TEXT column with the target's, in ONE transaction with
  `PRAGMA defer_foreign_keys = ON` (needed live: a naive per-column pass
  tripped `FOREIGN KEY constraint failed` mid-batch, because rewriting a
  referenced primary key — e.g. `registry_snapshots.registry_snapshot_id`
  — ahead of the foreign key pointing at it — `registry_namespace_bindings.
  registry_snapshot_id` — violates immediate FK enforcement even though
  both end up consistent by commit). This single generic substring pass
  covers both plain `workspace_id` columns and the workspace-id-templated
  primary/foreign keys v4 mints at publish time (`snapshot_id =
  "snapshot:<workspace_id>:<generation>"`, etc.) in one step.
- `recomputeV4SnapshotDigestsAfterRewrite`: `snapshot_digest` is an
  envelope over the snapshot's own identity fields — every one of which
  the rewrite just changed — so it must be recomputed post-rewrite (the
  content digests `canonical_record_set_digest`/`projection_set_digests`/
  `source_state_digest`/`capability_state_digest` are untouched by the
  rewrite and stay byte-identical). Discovered live: without this step,
  `verifyV4Workspace` on the fork correctly reported
  `storage:snapshot_digest_corrupt` — this is the v4 analogue of v3's
  `computeForkSnapshotDigestFields`, scoped to exactly the one field
  identity rewriting invalidates.
- `forkV4Workspace`: composes all four — copy the catalog DB file, copy
  `structural/`, copy the sidecar directory if present, rewrite identity,
  recompute `snapshot_digest`, verify roots.

**Known gap, not fixed** (documented, not silently dropped):
`registry_snapshots.registry_digest`/`generation_manifests.manifest_digest`
are also envelopes that can embed workspace-id-templated substrings
(`generation_manifest_id` does; `registry_snapshot_id` in this task's own
tests happened not to, since it was a static test fixture string) and are
NOT recomputed by `forkV4Workspace` — `verifyV4Workspace` does not check
either of those fields today, so this gap is inert for now, but a future
verify extension covering them would need a matching recompute here.

### 3.3 `index-pack.ts`: `exportV4IndexPack`/`importV4IndexPack`

A new container (`V4_INDEX_PACK_FORMAT = "urdira-index-pack-v4"`,
`V4_INDEX_PACK_SCHEMA_VERSION = 1`), gzip-compressed: a `u32le` manifest
length, the manifest JSON (`workspace_id`, `generation`, `roots` from
`merkle_roots`, `canonical_record_set_digest`, `source_state_digest`, and
an ordered `files: [{path, byte_length}]` list), then every file's raw
bytes concatenated in that order (`workspace.sqlite`, everything under
`structural/`, everything under `sidecar/` if present). Both directions
stream (`node:stream/promises`'s `pipeline` for export; a small pull-based
`V4PackStreamReader` for import, `readExactly`/`pipeExactlyTo`) — never
buffering a whole file, which matters here because a `merkle/<set>.tree`
file is a fixed ~35.8 MB **regardless of corpus size** (P0-S3's dense
bucket array), so even the tiny `task-planner` fixture's pack is
~140 MB before compression (4 tree files) plus the catalog DB.
`importV4IndexPack` independently re-derives every set's root from the
just-written bytes (`readTreeFile` again) and compares against the
manifest's claimed roots — so a manifest that lied about its own roots
(or a truncated/corrupted transfer) is still caught on import, not merely
trusted.

### 3.4 Verification

- `tests/workspace-fork-v4.test.ts`: cold-scans the task-planner fixture,
  forks it, confirms (a) `forkV4Workspace`'s own root verification passes,
  (b) the donor's `workspace_id` is gone from every row of the fork's
  catalog (both plain columns and templated ids), (c) the forked
  `workspace_current_state`/`snapshots` rows are queryable and correct, and
  (d) a **fresh, independent** `verifyV4Workspace` call against the forked
  copy passes clean. 2/2 pass.
- `tests/index-pack-v4.test.ts`: exports a real v4 workspace, imports it
  into fresh target paths, confirms root verification passes AND an
  independent `verifyV4Workspace` on the imported copy passes clean; a
  second test truncates the pack file and confirms `importV4IndexPack`
  throws rather than silently importing a partial store. 2/2 pass.

## 4. Files touched

- `docs/serialization/core-digest-field-contracts.md` (rows 89-91, additive prose).
- `packages/canonical/src/merkle-bucket.ts` (additive: `bucketDigests`,
  `rootFromBucketDigests`, `sourceStateDigest`), `index.ts` (3 new exports),
  `documented-digest-contracts.ts` (rows 48-50, additive prose).
- `packages/contracts/src/registries.ts` (+1 `canonicalSchemaRegistry`
  entry), `inline-schema-specs.ts` (+1 matching spec).
- `packages/storage/src/lifecycle.ts` (`verify()`: `isV4` gating, additive
  only — v3 path unchanged).
- `packages/engine/src/v4-verify.ts` (new file), `workspace-fork.ts`
  (additive v4 section), `index-pack.ts` (additive v4 section).
- Tests: `tests/merkle-bucket.test.ts`, `tests/phase-digest-v3.test.ts`,
  `tests/phase16-transactional-projection-digests.test.ts`,
  `tests/contracts.test.ts`, `tests/v4-verify.test.ts` (new),
  `tests/workspace-fork-v4.test.ts` (new), `tests/index-pack-v4.test.ts` (new).
- `tests/fixtures/contracts/v5-contract-conformance.json` (+1 schema entry).

## 5. Quality gate results

- `pnpm -r build` (full monorepo, all 16 workspace packages including
  `packages/web`'s vite build): clean, exit 0.
- `node scripts/check-architecture.mjs`: "Architecture checks passed for
  16 workspace packages."
- `pnpm exec eslint` on every touched/new file listed in §4: clean, zero
  output.
- `pnpm exec vitest run tests/phase-digest-v3.test.ts
  tests/phase16-transactional-projection-digests.test.ts tests/contracts.test.ts
  tests/phase8-registry.test.ts tests/phase5.test.ts tests/phase5-review-fixes.test.ts
  tests/phase9-publication.test.ts tests/merkle-bucket.test.ts
  tests/v4-verify.test.ts tests/workspace-fork-v4.test.ts tests/index-pack-v4.test.ts`:
  all pass (406 tests across the 10 non-new files' worth of coverage plus
  the 3 new files' 9 tests, confirmed clean on a dedicated re-run).
- `pnpm exec vitest run tests/phase-workspace-fork.test.ts
  tests/phase-index-pack.test.ts`: `phase-workspace-fork.test.ts` 11/11
  clean. `phase-index-pack.test.ts`: 10/11 clean, one pre-existing,
  environment-only flake (see below) in a test this task never touches.

**Pre-existing flake, confirmed unrelated to this task's changes**: under
this session's heavy parallel load (multiple real Rust cold-scans running
concurrently, plus a concurrent agent (P3-1) independently running its own
tests on the same checkout), `tests/phase5-review-fixes.test.ts` and
`tests/phase-index-pack.test.ts`'s "(g2) ... stays fast at scale" test each
intermittently threw `ENOENT: ... catalog.sqlite.urdira-writer.lock` from
deep inside v3-only code this task never touched
(`acquireWorkspaceMutationLock`/`InstallationCatalog.close`/
`releaseWorkspaceLease`, `packages/storage/src/storage.ts`). Confirmed
pre-existing and unrelated by `git stash`-ing all three of this task's
engine-package changes (`index-pack.ts`, `workspace-fork.ts`,
`v4-verify.ts`) back to their committed baseline, rebuilding, and
reproducing the identical "(g2)" failure on the byte-for-byte original
code; both files pass 100% clean whenever run alone (no other test
processes contending for `os.tmpdir()`). Not something this task can or
should fix.

## 6. Rust-side gap to report (per the task's explicit instruction)

`crates/urdira-native-node/src/structural_store_napi.rs`'s
`NativeOutputRecordRow` has no `record_digest` field (checked directly:
`to_output`, lines ~720-792, never copies one from `RecordView` into the
napi struct even though `RecordRow.record_digest: [u8; 32]` is a genuine
persisted column, `crates/urdira-structural-store/src/row.rs:38`), and
`NativeOutputDependencyRow` exposes dependency endpoints as artifact-id
strings rather than the dictionary ordinals
`urdira-structural-store/src/merkle.rs`'s `dependency_logical` hashes. This
is the one thing that keeps `verifyV4Workspace`'s records/dependency/graph
checks at "structural self-consistency" rather than full from-scratch
leaf-level corpus integrity (§2.2). Per the task brief this was reported,
not worked around by editing that restricted file. Suggested follow-up:
add a `record_digest` field to `NativeOutputRecordRow` (or a dedicated
`(record_id, record_digest)` pair iterator method), and an ordinal-aware
dependency-logical export.

## 7. Follow-up (2026-09-03): raw digest iterator closes §6's gap -- leaf-level verify shipped

Small follow-up task, same digest-contract program. Closes the §6 gap by
adding exactly the export §6 suggested, then wiring `verifyV4Workspace` to
use it for a genuine from-scratch leaf recompute (not just internal-node
self-consistency).

### 7.1 `structural_store_napi.rs` (the only Rust file this follow-up touches)

- `NativeOutputRecordRow.record_digest: String` (`"sha256:<hex>"`) --
  additive field, populated in `to_output` from `RecordView.record_digest()`.
  Not consumed by `decodeRow`/any of the 18 query operations; verified this
  doesn't leak into `CanonicalQueryRecord` (the native/SQLite parity tests
  in `tests/native-query-snapshot-port.test.ts` compare `decodeRow`'s
  OUTPUT, which explicitly field-maps and drops it).
- Three new `NativeStructuralStoreHandle` methods, all returning a new
  `NativeDigestBatch { keys: Uint8Array, digests: Uint8Array, next_cursor:
  Option<String> }` (contiguous `N*32`-byte buffers, not per-row objects --
  see that struct's own doc comment for why: at corpus scale, one boxed
  napi object per leaf is real allocation/marshalling cost this avoids):
  - `iterVisibleDigests(generation, batchSize, afterKeyHex?)` --
    `(record_id, record_digest)`, ascending key order (a plain
    `StoreReader::iter_visible` scan -- already a real k-way merge across
    segments, per that method's own doc comment). Same cursor shape as the
    pre-existing `iterVisibleBatch` (`iter_visible_batch`): resuming skips
    forward from `afterKeyHex` on every call, O(n) per batch not O(1) --
    inherited, deliberately, from that method's own documented tradeoff at
    this store's target scale.
  - `iterVisibleGraphDigests(generation, batchSize, afterKeyHex?)` -- same
    scan, filtered to `category == CATEGORY_RELATION` (imported from
    `urdira_structural_store::row`) -- exactly the filter
    `crates/urdira-indexing-worker/src/v4/publish.rs`'s `publish_cold`
    already applies to build `graph_entries` for the `graph` set's root at
    publish time (read-only confirmation; that file was not touched).
  - `iterVisibleDependencyDigests(generation, batchSize, afterKeyHex?)` --
    `(dependency_id, dependency_logical_view(view))`, reusing
    `urdira_structural_store::merkle::dependency_logical_view` verbatim (the
    SAME content-digest recipe `merkle.rs`'s own `dependency_entries`
    uses -- there is no separate `dependency_digest` field on
    `DependencyRow`/`DependencyView`). One difference from the other two:
    `StoreReader::iter_visible_deps` returns segments concatenated, NOT
    globally merged by key (unlike `iter_visible`'s k-way merge), so this
    method collects and `sort_unstable_by_key`s once per call before
    paging. Acceptable at this store's scale (dependency counts run far
    below record counts in every workspace this port targets) and
    documented as such in the method's own doc comment.
- Quality: `cargo fmt -p urdira-native-node -- --check` clean;
  `cargo clippy --release -p urdira-native-node --all-targets -- -D
  warnings` clean, zero output; `cargo build --release -p
  urdira-native-node` clean (the only crate this task was scoped to build --
  the concurrent P3-1 agent's in-progress crates were not touched or
  rebuilt); `cargo test -p urdira-native-node` 0 tests, ok (this crate has
  none of its own; coverage is via the TS-side napi round-trip tests).
  Addon copied to `release/native/darwin-arm64/urdira-native.node` (same
  path `native-structural-store-binding.ts`'s `defaultAddonPath` resolves,
  matching what `scripts/build-native.mjs` would have produced).

### 7.2 `native-structural-store-binding.ts` (not explicitly named in the task's file list, edited anyway)

Necessary glue for the three new methods and the `record_digest` field to
be typed/callable from TypeScript at all, and not on the P3-1 agent's
restricted-file list -- added `NativeDigestBatch`, the `recordDigest`
field on `NativeOutputRecordRow`, and the three method declarations on
`NativeStructuralStoreHandle`, additive only.

### 7.3 `packages/canonical/src/merkle-bucket.ts`: `BucketedMerkleSet.fromSortedBatches`

Additive static method: consumes an `Iterable<Iterable<Entry>>` (one
inner iterable per raw batch) via a flattening generator, then delegates
to the existing `fromSorted`. Does NOT reduce this class's own memory
footprint (`membersByBucket` still ends up holding every member -- a
Merkle set inherently needs every leaf to compute its root); it only
avoids a caller-side intermediate flat array holding the same data twice
before the call. `fromSorted` itself already accepted an arbitrary
`Iterable` (entries "need not be pre-sorted... grouped by bucket and
sorted internally," per its own doc comment) -- `fromSortedBatches` exists
purely for callers naturally shaped as batches (a cursor-paginated napi
source), not because `fromSorted` required an array.

### 7.4 `v4-verify.ts`: genuine leaf-level recompute

Added `decodeDigestBatch`/`iterateNativeDigestBatches`/`leafTreeFor`
helpers: stream each of `records`/`dependency`/`graph`'s leaves through
the corresponding `iterVisible*Digests` method into
`BucketedMerkleSet.fromSortedBatches`, then compare the FROM-SCRATCH
`root()`/`size()` against whichever authority is available (the persisted
`.tree` file's header root/count, falling back to the `merkle_roots` SQL
row when no file exists yet). This is layered ON TOP of the pre-existing
tree-file self-consistency / SQL / MANIFEST cross-checks (§2.2), not a
replacement -- both still run. `metric` has no native leaf source (an
always-empty placeholder projection, no producer emits
`metric_projections`-equivalent rows today) and stays covered only by the
pre-existing checks.

Also hardened the native-handle-open error handling: previously, ANY
error opening `NativeStructuralStoreHandle` (including from a genuinely
corrupted structural store) was silently swallowed under the same catch
as "native addon not built in this process." Split these: addon-load
failure (`loadNativeStructuralStoreAddon()` throwing) is unchanged
(skip native-backed checks, keep the file/SQL/MANIFEST checks); a
subsequent `handle.open()`/`reopenIfChanged()`/etc. failure is now itself
reported as `storage:canonical_set_digest_corrupt` -- `StoreInner::load`
re-verifies each base segment's `records.keys`/`records.meta`/
`records.digests` xxh3 checksums on every open (a pre-existing,
`urdira-structural-store`-side check, not something this task added), so
a failure there already means the on-disk structural store is
unreadable/corrupt, which is exactly the class of failure this check
exists to surface.

Updated the module's top-of-file doc comment to describe the closed gap
(kept, not deleted, since it is genuinely useful context for why this
module is shaped this way) rather than continuing to say a from-scratch
leaf check is impossible.

### 7.5 Tests

- `tests/native-query-snapshot-port.test.ts` (additive): one new test
  builds a 5-record/2-dependency store directly via `NativeStoreBuilder`
  (3 entities, 2 relations, 2 dependencies) and exercises all three new
  methods at a batch size smaller than the corpus (forcing multiple
  pages): asserts ascending key order, no duplicate/dropped keys, that a
  full page never precedes a short one, that `iterVisibleGraphDigests`
  returns exactly the two relation records, that
  `iterVisibleDependencyDigests` returns both dependency rows (exercising
  the sort-then-page path, since `iter_visible_deps` is not itself
  globally sorted), and that every `iterVisibleDigests` leaf digest
  matches the SAME record's `recordDigest` as returned by `recordsByIds`.
  11/11 pass in this file (10 pre-existing + 1 new).
- `tests/v4-verify.test.ts` (additive): one new test flips a byte just
  past the 64-byte header in the base segment's `records.digests` file
  (inside the first row's `record_digest` field) and asserts
  `verifyV4Workspace` reports `storage:canonical_set_digest_corrupt`. As
  anticipated by the task brief ("the xxh3 header check... is either
  bypassed by the test or also reported"), this corruption is caught by
  `NativeStructuralStoreHandle.open`'s own per-open xxh3 re-verification
  (§7.4's hardened error handling reports it, rather than the deeper
  from-scratch-root-mismatch path a checksum-preserving corruption would
  hit) -- both paths report the identical error code, so the test does
  not need to distinguish them; this was a deliberate scope choice over
  implementing a JS-side xxh3 hasher (none exists in this repo) just to
  forge a checksum-valid corrupted file for the test. The pre-existing
  "clean workspace" test (unchanged) now also exercises the new
  leaf-level checks end-to-end with zero false positives, since it was
  never restricted to skip them. 6/6 pass in this file (5 pre-existing +
  1 new).
- `tests/merkle-bucket.test.ts`: unaffected, still 100% pass (`fromSorted`
  itself unchanged; `fromSortedBatches` is new, additive code with no
  existing test to break).

### 7.6 Quality gate results (this follow-up)

- `cargo build --release -p urdira-native-node`: clean.
- `cargo fmt -p urdira-native-node -- --check`: clean.
- `cargo clippy --release -p urdira-native-node --all-targets -- -D
  warnings`: clean, zero output.
- `cargo test -p urdira-native-node`: 0 tests, ok.
- `pnpm --filter @urdira/canonical build` then
  `pnpm --filter @urdira/canonical --filter @urdira/engine exec tsc
  --noEmit -p .`: clean, zero errors (had to rebuild `@urdira/canonical`'s
  `dist/` first -- `@urdira/engine`'s type-check resolves it via its built
  `.d.ts`, not source, under this repo's project-reference setup).
- `pnpm --filter @urdira/engine build`: clean (refreshed `packages/engine/
  dist/v4-verify.js` for the vitest e2e harness, which imports from `dist`).
- `pnpm exec eslint packages/canonical/src/merkle-bucket.ts
  packages/engine/src/v4-verify.ts
  packages/engine/src/native-structural-store-binding.ts
  tests/v4-verify.test.ts tests/native-query-snapshot-port.test.ts`: clean,
  zero output.
- `pnpm exec vitest run tests/native-query-snapshot-port.test.ts` (own run):
  11/11 (10 pre-existing + 1 new).
- `pnpm exec vitest run tests/v4-verify.test.ts` (own run): 6/6 (5
  pre-existing + 1 new).
- `pnpm exec vitest run tests/merkle-bucket.test.ts
  tests/workspace-fork-v4.test.ts tests/index-pack-v4.test.ts` (one run,
  regression check for files this follow-up's changes could plausibly
  affect but does not add tests to): 16/16.
- 33 tests total across the five files, all clean.

Not run: a full `pnpm -r build`/workspace-wide `cargo build` (the
concurrent P3-1 agent owns several in-progress crates/files this task was
explicitly told not to touch or assume buildable mid-session) and
`crates/urdira-structural-store`'s own test suite (read-only dependency
for this task; unmodified).

### 7.7 Files touched (this follow-up, beyond §4's list)

- `crates/urdira-native-node/src/structural_store_napi.rs` (additive:
  `NativeDigestBatch`, `NativeOutputRecordRow.record_digest`, three new
  `NativeStructuralStoreHandle` methods).
- `packages/engine/src/native-structural-store-binding.ts` (additive, not
  on the task's restricted list; necessary glue for the above).
- `packages/engine/src/v4-verify.ts` (leaf-level recompute wiring, handle-
  open error handling, doc comment update).
- `packages/canonical/src/merkle-bucket.ts` (additive:
  `BucketedMerkleSet.fromSortedBatches`).
- `tests/native-query-snapshot-port.test.ts`,
  `tests/v4-verify.test.ts` (both additive-only).
- `release/native/darwin-arm64/urdira-native.node` (rebuilt addon binary,
  not source -- copied from `target/release/liburdira_native_node.dylib`
  after the Rust build above; not committed by this task per the "DO NOT
  commit" instruction).
