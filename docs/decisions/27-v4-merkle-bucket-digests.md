# Decision 27: v4 bucketed Merkle digest contract

Status: **Accepted**
Last updated: 2026-09-09
Depends on: [Content-derived record identity](11-content-derived-record-identity.md), [Transactional projection digests](13-transactional-projection-digests.md), [v3 optimization](22-v3-optimization.md) (v3's incremental digest writers, unchanged), [v4 structural store](26-v4-structural-store.md)

## Current state (2026-09-09)

Implemented for v4 (`index_contract 0x34`). Leaf-level from-scratch
verification via napi digest iterators is in place for `records`/
`dependency`/`graph`; incremental roots for create/delete/rename match a
from-scratch oracle at n8n scale (the `dependency` gap is closed, P3-2). The
authoritative roots changed several times during the campaign as the record
contract changed (see "Authoritative roots history" below). The P2-2m
`identity_key` corruption this decision's own verification could not
detect is now **fixed** at the store-writer level (decision 26's changelog)
— a Merkle leaf is still `(record_id, record_digest)`, never `identity_key`
text, so leaf-recompute verification still cannot see an
`identity_key`-only corruption directly. Closing that particular writer bug
does not remove this verification limitation.

## Context

v3's canonical record-set and projection digests use `MerkleRadixSet`
(`packages/canonical/src/merkle-radix.ts`, decision 22): a node for every one
of the (up to) 64 nibble-prefixes of a 256-bit key. For random keys that is
roughly 58 useful chain nodes per leaf, i.e. approximately 190 million
SHA-256 calls for a 3.2M-member record set (minutes), and a persisted form
of that tree would be on the order of 200M rows — workable for the ~14k
source-artifact set decision 22 built it for (a v3 "A2" pattern), infeasible
at v4's cold-second and sub-second-incremental targets for a 1.5M+-record
set. `docs/evidence/2026-09-02-v4-p0-s3-merkle-bucket.md` designed and
measured a replacement, "bucketed Merkle," in both TypeScript and Rust
before any production wiring.

## Decision

For v4 workspaces, `canonical_record_set_digest`, each transactional
`projection_set_digest`, and `source_state_digest` are computed by a
**bucketed Merkle set** (`BucketedMerkleSet`, `packages/canonical/src/merkle-bucket.ts`
and `crates/urdira-indexing-core/src/merkle_bucket.rs`), not by
`MerkleRadixSet`. v3 workspaces are unaffected: decision 22's recipe and
`MerkleRadixSet` remain the v3 authority, unchanged, and the two recipes
never apply to the same workspace (`index_contract` selects one or the
other; there is no compatibility reader — see `docs/versioning.md`).

### Bucketed Merkle set

Members are grouped by the top 5 hex nibbles (20 bits) of their 32-byte key
into `16^5 = 1,048,576` fixed buckets — at 3.2M members, roughly 3 leaves
per bucket.

- `bucket_digest = sha256("urdira:merkle-bucket:leafset\0" || u32le(count) || (key32 || logical32)*, sorted by key)`.
  An empty bucket is the literal 32-byte-zero value — **not** hashed.
- `node(prefix, depth d < 5) = sha256("urdira:merkle-bucket:node\0" || u8(d) || child_0..child_15)`.
  Every internal node is hashed **unconditionally**, including a node whose
  entire subtree is empty — the one subtlety in the design: a first insert
  under a previously-untouched sibling must not fall back to a literal zero
  for that sibling's uncomputed ancestors, or the parent hash would be
  wrong. Both implementations precompute `EMPTY_NODE[0..4]` constants (the
  canonical digest of an all-empty subtree at each depth) as the fallback
  for a missing slot.
- The root is the depth-0 node, **except** that an empty set's root is the
  literal 32-byte-zero value (not the hash of an all-empty root) — the one
  deliberate exception, checked first by both `root()` accessors.
- `canonical_record_set_digest = sha256("urdira:record-set:v4\0" || u64le(count) || root32)`.
- `projection_set_digest(kind) = sha256("urdira:projection-set:v4\0" || kind_utf8 || 0x00 || u64le(count) || root32)`.
- `source_state_digest` uses **two** bucketed trees rather than one: a
  present-set (`key = sha256(normalized_uri)`, `logical = content_hash`) and
  an absent-set (`key = sha256(normalized_uri)`, `logical =
  sha256(artifact_tombstone_id)`), combined as `sha256("urdira:source-state:v4\0"
  || u64le(present.len) || present.root() || u64le(absent.len) ||
  absent.root())`. The plan's own text specified the present-set key/logical
  precisely but left "tombstone token" undefined for the absent set;
  `crates/urdira-source-frontier` (decision 29) defines it as the
  `artifact_tombstone_id` string, so the digest changes exactly when a URI's
  absence identity changes and stays stable across re-observations of the
  same absence (`docs/evidence/2026-09-02-v4-p2-2a-source-frontier.md` §3).

Duplicate key with a differing logical value is an error (both `from_sorted`
and within one incremental `set`/`update` batch); duplicate key with an
identical logical value is a no-op.

### What changed vs. decision 13's transactional set

Decision 13 defines `Snapshot.projection_set_digests` as always carrying
**four** entries for v3 — `graph`, `dependency`, `metric`, and `vector` —
each present even at zero rows, with lexical excluded (async, reconciled
separately). For v4, the shipped and tested entry set is **three**:
`dependency`, `graph`, `metric`, in that order — `vector` does not appear at
all (`docs/evidence/2026-09-03-v4-p2-4-digest-contract.md` §1.3: "confirming
lexical/vector are absent"; `crates/urdira-worker-protocol`'s
`ScanRoots`/`IndexingEvent::ScanCompleted` likewise carry exactly four root
fields — `records`, `dependency`, `graph`, `metric` — with no vector field
at all). Semantic vectors for v4 live entirely in the asynchronous
`semantic.sqlite` sidecar (decision 26), maintained outside any scan
transaction. For v4, this explicitly supersedes Decision 13's v3
four-entry requirement:
the structural snapshot commits to `dependency`, `graph`, and `metric`, while
semantic vectors use their own generation/provider-bound materialization and
coverage state. A structural root does not certify semantic completeness.

`canonical_record_set_digest`, every `projection_set_digest`, and
`source_state_digest` also use entirely new byte formulas (the
`urdira:*-set:v4`/`urdira:merkle-bucket:*` framings above) — **not**
decision 22's `urdira.logical-digest.v3` field/presence/type framing. A new
registry coordinate, `core:RecordSetMerkleRoot@1`, was added **additively**
to `packages/contracts/src/registries.ts` alongside the pre-existing
`core:RecordSetDigestEntry@1` (decision 22) rather than retiring the latter:
the two recipes never apply to the same workspace (mutually exclusive by
`index_contract`), and retiring the v3 coordinate would have broken several
*other* v3-only rows that still reference it
(`ReplacementScope.base_record_set_digest`, etc.). The contract rows in
`docs/serialization/core-digest-field-contracts.md` (89-91) and their
mirrors in `packages/canonical/src/documented-digest-contracts.ts` (48-50)
were edited **in place** — a `v4 (index_contract 0x34): ...` sentence
appended in plain prose (deliberately with zero backticks, so the
machine-parsed `input(...)` clause that drives generated JSON Schema
generation is untouched) — rather than swapped, after discovering live that
`digest-payload-schemas.ts` regex-parses each row's first clause to generate
a schema, and that a naive edit or a `RecordSetDigestEntry@1` retirement
would have cascaded into generated schemas for fields that never changed
(`docs/evidence/2026-09-03-v4-p2-4-digest-contract.md` §1.1).

### Persistence: `structural/merkle/<set>.tree`

64-byte header: magic `URDM` (4 B), `format u16 = 1`, `set_kind u16`
(`1=records, 2=graph, 3=dependency, 4=metric, 5=source_state`),
`generation u64`, `count u64`, `root` (32 B), 8 B reserved. Followed by all
node/bucket slots in BFS order across levels 0-5 (level 5 is the 1,048,576
bucket digests): `1 + 16 + 256 + 4096 + 65536 + 1,048,576 = 1,118,481` slots
× 32 B = 35,791,392 bytes of slots, 35,791,456 bytes total — matching the
design estimate exactly, and **independent of corpus size** (the dense
array is always this size, whether the workspace holds 10 records or 10
million). `records.tree`/`dependency.tree` are written and updated by
`urdira-structural-store` itself; `graph.tree`/`metric.tree` are computed
and persisted directly by the v4 scan pipeline (decision 29) using the same
`urdira-indexing-core::merkle_bucket` API, since `urdira-structural-store`
tracks only `records`/`dependency` (decision 26). `write_to` writes a temp
file then renames (atomic). Incremental updates position-write only the
touched bucket slot plus its 5 ancestor slots, rewriting the header last so
a crash mid-write never leaves a header pointing at a root inconsistent
with the bytes on disk. **Known caveat**: the file persists digests, not
member counts per bucket; a tree loaded via `read_from` starts with
all-zero per-bucket counts, so an `update()` against a freshly-loaded tree
(without an intervening `from_sorted`) can undercount that bucket's
contribution to `len()` — `root()` is unaffected, only `len()` bookkeeping
(`docs/evidence/2026-09-02-v4-p0-s3-merkle-bucket.md` §"Persistence format").

### Incremental update semantics

A single-key `set`/`delete` touches exactly one bucket digest plus 5
ancestor node digests — 6 hashes, independent of set size. Measured: cold
`from_sorted` over 3.2M synthetic members, 16-way `thread::scope` parallel,
282.1 ms (target ≤300 ms; single-threaded reference 360.8 ms, asserted to
produce the identical root); `update()` of 500 keys, 1.603 ms (target ≤10
ms) (`docs/evidence/2026-09-02-v4-p0-s3-merkle-bucket.md` §"Bench numbers").

Two real O(N²) bugs were found and fixed at real n8n hub-edit scale (2,196
affected owners, 356,905 records) during the incremental scan-pipeline work
(decision 29): `urdira-structural-store::writer::write_delta`'s
`bucket_entries` callback sites passed the **full** change list to a
closure invoked once per distinct touched bucket (effectively O(N²));
fixed by grouping changes by bucket once, O(N)
(`group_changes_by_bucket`). `BucketedMerkleSet::update`'s own
duplicate-conflict check used a `Vec` + linear scan re-scanned per change
(also O(N²)); fixed with a `HashMap`, O(N) amortized, identical conflict
semantics. A separate bug (not a complexity bug) had the `graph` set's
`bucket_entries` callback returning the **pre-delta** bucket contents
instead of the required post-change contents. Measured effect of the two
complexity fixes together: the same hub-edit mutation went from "still
running past 3.5 minutes wall time, killed" to completing end to end,
including daemon watcher/debounce overhead, in **23.9 s**
(`docs/evidence/2026-09-03-v4-p3-1-incremental.md` §6); the same mutation
is 1.1-1.5 s worker-only today, after the digest-churn fix in decision 29
(the churn — ~107,000 spurious opens/closes per hub edit — was a diff-input
bug, not a digest cost).

Since P3-6 (`docs/evidence/2026-09-03-v4-p3-6-delta-container.md` §1),
`BucketedMerkleSet::write_slots` collects the touched slots into a
`BTreeMap<byte_offset, digest>` and merges contiguous ranges into one
seek+write per range, and the `.tree` slot writes are ordered **after** the
delta container's own fsync so the data a root points at is durable before
the root is. Per-delta Merkle cost (`merkle_memory` + `persist_slots`) is a
few milliseconds of a 39-126 ms delta.

**Leaf identity recipes that changed during the campaign** (each change
moves the corresponding root without changing membership):
`dependency_id`/`dependency_logical` v1 embedded an ephemeral record
ordinal (`None` on the incremental path, a real value cold — an
n8n-scale oracle mismatch plus a cold "duplicate member has conflicting
logical digests" crash, P3-1); v2 dropped it; the next two attempts hashed
`OrdinalDict` positions and then `(artifact_id, artifact_version_id)`
strings, both workspace- and generation-salted, so no from-scratch oracle
run under another `workspace_id`/`generation` could ever match (35,527
edges per side, zero overlap); the shipped recipe is
`sha256("urdira:v4-dependency-id:v4\0" || owner_path || dep_path || role)`
(`docs/evidence/2026-09-03-v4-p3-2-incremental-residuals.md` §3). A second,
stale copy of the logical formula in `merkle.rs` (`dependency_logical_view`)
was caught by the compaction pre/post-equality test and fixed with it.

### Verification

`crates/urdira-jsts-typeflow`-independent, `packages/engine/src/v4-verify.ts`'s
`verifyV4Workspace(database, structuralRoot, workspaceId)` is a from-scratch
verifier with no native/Rust process dependency for the SQL-side checks
(`source_state_digest` recomputed from the same catalog tables
`Frontier::load` reads; `snapshot_digest` recomputed via the same envelope
recipe decision 22's `verify()` already uses). For the structural side it:
reads each `structural/merkle/<set>.tree` file directly (a from-scratch
binary parser cross-checked byte-for-byte against the Rust encoder),
recomputes that file's own root from its persisted bucket-level (level 5)
digests via `rootFromBucketDigests` (catching corruption of the file's
internal node levels even when the header's own claimed root would
otherwise hide it), and cross-checks that root against `merkle_roots`,
`MANIFEST.roots` (`records`/`dependency` only), the native handle's
`visibleCount`, and the snapshot's own digest fields for mutual consistency.
A follow-up (`docs/evidence/2026-09-03-v4-p2-4-digest-contract.md` §7) added
three batched napi digest iterators
(`iterVisibleDigests`/`iterVisibleGraphDigests`/`iterVisibleDependencyDigests`,
returning `(key, digest)` pairs as contiguous `N*32`-byte buffers) and
`BucketedMerkleSet.fromSortedBatches` (TS), so `verifyV4Workspace` now also
does a genuine **from-scratch leaf recompute** for `records`/`dependency`/
`graph` — streaming every leaf through the store's own napi surface and
comparing the independently-rebuilt root against the persisted authority,
not merely checking that the persisted node levels agree with the persisted
bucket level. `metric` has no native leaf source (it is always the
canonical empty set; no producer emits metric-projection rows) and remains
covered only by the tree-file/SQL/MANIFEST cross-checks. `pnpm exec vitest
run tests/v4-verify.test.ts`: 6/6, including corruption injections at the
SQL, tree-header, and tree-bucket-level layers, each producing the
documented typed error (`storage:source_state_digest_corrupt`,
`storage:snapshot_digest_corrupt`, `storage:canonical_set_digest_corrupt`,
`storage:projection_set_digest_corrupt`). A corrupted handle open is
reported as `storage:canonical_set_digest_corrupt` rather than swallowed as
"addon not built" (P2-4 §7). P4-b-1 added tests for the
`storage:current_tuple_corrupt` branch, `merkle_roots`/tree-file
disagreement, `MANIFEST` ENOENT vs unreadable, and `projection_set_digests`
tampering/invalid JSON, taking `v4-verify.ts` from 14 to 4 uncovered lines;
the 4 remaining are multi-batch pagination beyond 8,192 leaves, the
native-addon-unavailable catch, and the two leaf-recompute mismatch
branches, which need a corruption that survives the base segment's own
`xxh3` (`docs/evidence/2026-09-04-v4-p4-b-prep-health.md`).

**What this verification cannot see.** A Merkle leaf is `(record_id,
record_digest)`; `identity_key` text is not a leaf input. The P2-2m
corruption (fixed 2026-09-05, see decision 26's changelog) zeroed
`identity_key` bytes while leaving `record_digest` intact, so every check
above passed on a corrupted store while the bug was live — only the
classification invariant (decision 28) and a full-store diagnostic scan
could detect it (`docs/evidence/2026-09-05-v4-final-measurements.md` §2.5).
This structural gap in what a Merkle check can see is unchanged by the
fix — a future writer-level regression of the same shape would again be
invisible to this decision's own verification.

**Incremental == from-scratch, as verified.** Create, delete, and rename
mutations at full n8n scale produce `records`, `dependency`, and `graph`
roots byte-identical to a from-scratch cold scan of the mutated tree
(`n8n_incremental_create_delete_roots_match_oracle`, P3-2 §3.4, re-run after
every later round; rename in all three delete/create orderings at fixture
scale, P3-8a §1). Edit matches a from-scratch rebuild over the store's own
visible key set, by design (decision 29).

### Authoritative roots history

The cold n8n roots are the regression oracle for every round; they change
only when the record contract changes. Known values:

| era | records | dependency | graph | metric | why it changed |
|---|---|---|---|---|---|
| P2-2b … P2-2g round 4 (1,521,196 records) | `sha256:cba95efc…` | — | `sha256:23089a90…52ac0` | `0000…0000` | — |
| P2-2h round 5 (1,521,196) | `sha256:a281d6a5…03987` | `sha256:d76ff317…bf987` | `sha256:23089a90…52ac0` | `0000…0000` | `dependency`: the `dependency_id` recipe above (P3-2). `records`: a digest-content-only change confined to the 254,541 entity-category records, with identical per-kind counts and an unchanged `graph` root; the exact field could not be pinned because none of the P3 rounds' declared file lists touch entity construction and no pre-change artifact survives — closed as a low-risk provenance question, not a regression (`docs/evidence/2026-09-03-v4-records-root-change.md`) |
| P2-2e typeflow + P2-2i possible rows through P2-2l (2,831,264) | `sha256:45afd858a9196b20082b076a2238e42f26c8a458f939e441b305ce604b4d557d` | `sha256:d76ff317ab6214ab78fb06bc3ec7a3fca3899417aa0ed8cdbc3090cdd8fbf987` | `sha256:94075f9c8164e36d228a7bd8cd1cad016000afc1c3a2b82c6f3657e521214b62` | `0000…0000` | +31,823 typeflow-confirmed rows, +1,276,972 possible rows and diagnostics; held byte-identical across dozens of cold runs in §16-§18 |
| P1-D-h final (2,831,264) | not printed | not printed | not printed | `0000…0000` | the cold-producer classification repair rewrites 31,917 relation identities, so `records` (and `graph`) necessarily differ from the row above; `docs/evidence/2026-09-05-v4-final-measurements.md` §4.1 reports the three runs' roots byte-identical to each other but does not list the values — the current authoritative quadruple is therefore not recorded in any evidence document |

`metric` has been the literal zero root throughout (an empty set's root is
the zero value, not the hash of an empty tree).

### Cross-language vectors

`tests/fixtures/digests/merkle-bucket-v4.json` (empty, one leaf, two leaves
same bucket, two leaves same depth-4 node but different bucket, two leaves
under different top nibbles, 1,000 pseudo-random with a fixed seed, and a
delete-then-reinsert case) is read by both the TypeScript suite
(`tests/merkle-bucket.test.ts`) and the Rust suite
(`crates/urdira-indexing-core/src/merkle_bucket.rs`'s `#[cfg(test)]` module,
via `include_str!` of the same file) — one source of truth, asserted
byte-identical in both languages
(`docs/evidence/2026-09-02-v4-p0-s3-merkle-bucket.md` §"Test results").

## Consequences

- v4's digest cost is `O(1,048,576)` dense hashes from scratch (a small
  fraction of a second at 3.2M members, parallel) and `O(1)` (6 hashes) per
  incrementally-changed key, replacing an algorithm that was minutes-scale
  and hundreds-of-millions-of-rows at v4's target scale.
- **v3 snapshots are not verifiable under v4, and vice versa, by design.**
  The two digest recipes are keyed to disjoint `index_contract` values (v3
  `0x33`, v4 `0x34`); `lifecycle.verify()`'s v3 SQL-shaped checks are
  skipped entirely for a v4 catalog (`isV4` branch,
  `docs/evidence/2026-09-03-v4-p2-4-digest-contract.md` §2.1), and there is
  no compatibility reader in either direction. This matches decision 22's
  existing "no migration, destructive data-root boundary" policy, extended
  unchanged to the v4 contract byte (see `docs/versioning.md`).
- A workspace can never mix the two recipes; an operator upgrading a v3
  workspace to v4 gets a fresh reindex from scratch, not a converted digest
  history.

## Open items (reported, not resolved)

- **Semantic vectors are outside the structural snapshot digest.** Their
  independent materialization and coverage must be checked separately, as
  specified above and in Decision 16.
- **`MANIFEST.roots` tracks only two of the four sets** (`records`,
  `dependency`); `graph`/`metric` roots exist only in their own `.tree`
  files and in the `merkle_roots` SQL table — an asymmetry inherited from
  decision 26's structural store.
- **Fork's `registry_snapshots.registry_digest`/`generation_manifests.manifest_digest`
  envelopes are not recomputed after a workspace-identity rewrite**, and
  `verifyV4Workspace` does not check either field yet — inert today (the
  test fixtures happened not to embed workspace-id-templated substrings in
  those particular fields), but a real gap for a future verify extension
  covering them (`docs/evidence/2026-09-03-v4-p2-4-digest-contract.md`
  §3.2).
- **The `dependency` incremental gap is CLOSED** (P3-2 §3): it was a fourth
  identity-recipe leak (scan-salted artifact ids), not a diff-scope gap; the
  root now matches a from-scratch oracle at n8n scale for create and
  delete.
- **A P2-2m-shaped `identity_key` corruption would be invisible to every
  digest check** (see "What this verification cannot see") even now that
  the specific 2026-09-05 bug is fixed — a verify extension would need an
  identity-text-level invariant, not a Merkle one.
- **The current authoritative roots are not recorded** after the P1-D-h
  classification repair (see the roots history) — the next cold run should
  print and pin them.
- **`metric` is always empty**; no metric-projection generator exists, so
  the set is verified only by cross-checks, never by leaf recompute.
- **Disk-round-trip count repair is implemented.** Incremental bucket
  updates carry the pre-update membership count; regression tests cover
  count and root equality after reload. The earlier count-bookkeeping gap
  is no longer open.
