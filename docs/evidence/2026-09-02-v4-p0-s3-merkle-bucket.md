# P0-S3: bucketed Merkle set digest (2026-09-02)

Implements the v4 `BucketedMerkleSet` contract (design doc: `project_v4_digest_design_2026-09-02` in memory) byte-identically in TypeScript and Rust, with shared test vectors, a persistence file format, and a microbenchmark. No commit made (per task instructions); all files below are new except the two `pub mod`/`export` lines noted.

Machine: macOS arm64, 10 cores, 32 GB RAM. Node 24.18.1. `rustc 1.98.0`.

## Why

`MerkleRadixSet` (`packages/canonical/src/merkle-radix.ts`, still used for v3 `source_state_digest`, untouched here) builds a node for every one of the 64 nibble-prefixes of a 256-bit key — ~58 useful chain nodes per leaf for random keys, i.e. ~190M SHA-256 for a 3.2M-member set. `BucketedMerkleSet` groups members into 16^5 = 1,048,576 fixed buckets by their top 20 bits; a single-key `set`/`delete` touches exactly one bucket digest plus 5 ancestor node digests, independent of set size.

## Spec recap (as implemented)

- Bucket = first 5 hex nibbles of the 32-byte key (top 20 bits) → 1,048,576 buckets.
- `bucket_digest = sha256("urdira:merkle-bucket:leafset\0" || u32le(count) || (key32||logical32)*, sorted by key)`. Empty bucket → 32 zero bytes, **not** hashed.
- Internal node at depth d (0..4): `sha256("urdira:merkle-bucket:node\0" || u8(d) || child_0..child_15)`. This is hashed **unconditionally** — even a node whose entire subtree is empty gets a real digest (only the bucket level has a "zero, not hashed" case). This was the one subtle point in the spec: it means a first insert under a previously-untouched sibling must not fall back to literal zero for that sibling's uncomputed ancestors, or the parent hash would be wrong. Fixed via:
  - **TS**: precomputed `EMPTY_NODE[0..4]` constants (canonical digest of an all-empty subtree at each depth), used as the fallback whenever a `nodeDigest` map lookup misses. This keeps `set`/`delete` sparse (only 5 slots touched per call) while staying correct for never-before-touched branches.
  - **Rust**: node/bucket arrays are always fully dense (1+16+256+4096+65536+1,048,576 slots), so there's no "missing slot" case — `BucketedMerkleSet::empty()` pre-fills every node slot with the same `EMPTY_NODE[d]` constant, and `from_sorted` computes every slot unconditionally.
- Root = depth-0 node; **empty set → literal 32 zero bytes** (not the hash of an all-zero-children root) — this is the one deliberate exception, mirrored by both `root()` accessors checking `count == 0` first.
- `record_set_digest = sha256("urdira:record-set:v4\0" || u64le(count) || root32)`.
- `projection_set_digest(kind) = sha256("urdira:projection-set:v4\0" || kind_utf8 || 0x00 || u64le(count) || root32)`.
- Duplicate key, differing logical → error (`from_sorted`/`fromSorted`, and within one `update`/`set` batch). Duplicate key, identical logical → no-op.

## Files

- `packages/canonical/src/merkle-bucket.ts` — `BucketedMerkleSet` (`fromSorted`, `set`, `delete`, `root`, `size`), `recordSetDigest`, `projectionSetDigest`. Exported from `packages/canonical/src/index.ts` (one new export line; `merkle-radix.ts` untouched).
- `crates/urdira-indexing-core/src/merkle_bucket.rs` — `BucketedMerkleSet` (`empty`, `from_sorted` — 16-way `std::thread::scope` parallel build, `update` with a `bucket_entries` callback, `root`, `len`, `record_set_digest`, `projection_set_digest`), `SetKind` enum, `write_to`/`read_from`/`write_slots` for the `structural/merkle/<set>.tree` format, `to_prefixed_hex`. `crates/urdira-indexing-core/src/lib.rs` got one new line: `pub mod merkle_bucket;`. No new crate dependencies (`sha2` was already a dependency).
- `scripts/generate-merkle-bucket-vectors.mjs` — builds `tests/fixtures/digests/merkle-bucket-v4.json` from the built TS package.
- `tests/merkle-bucket.test.ts` — vitest.
- Rust `#[cfg(test)] mod tests` inside `merkle_bucket.rs`, reading the same JSON via `include_str!`.

### Persistence format (`structural/merkle/<set>.tree`)

64-byte header: magic `URDM` (4B), format `u16`=1, `set_kind u16` (1=records, 2=graph, 3=dependency, 4=metric, 5=source_state), `generation u64`, `count u64`, `root` (32B), 8B reserved. Followed by all node/bucket slots, BFS order, levels 0..5 (level d = 16^d slots × 32B; level 5 = the bucket digests). Total slots 1+16+256+4096+65536+1,048,576 = 1,118,481 × 32B = 35,791,392 bytes; file size 35,791,456 bytes (≈35.8 MB), matching the target estimate exactly.

`write_to` writes a temp file then renames (atomic). `write_slots` positions-writes (via seek, not the raw `pwrite` syscall — kept portable across the crate's win32 release target) only the touched bucket + its 5 ancestor slots, then rewrites the header last, so a crash mid-write never leaves a header pointing at a root inconsistent with what's on disk.

**Known caveat**: the file persists digests, not leaves, so `bucket_count` (used internally to track `len()` deltas during `update`) is not persisted. A tree obtained via `read_from` starts with all-zero per-bucket counts; `update`-ing a bucket that already had members *before* that load (without an intervening `from_sorted`) will undercount that bucket's contribution to `len()`. `root()` is unaffected (bucket digests and node digests round-trip exactly — verified below). Flagged as a follow-up for whoever wires this into the real store: either have the caller also persist/pass counts, or have `update` re-derive a bucket's prior count from the store instead of trusting `bucket_count`.

## Test results

- `pnpm --filter @urdira/canonical build` — clean.
- `pnpm exec vitest run tests/merkle-bucket.test.ts` — **8 passed**: all 7 shared vectors (empty, one leaf, two-same-bucket, two-same-depth4-different-bucket, two-different-top-nibble, 1,000-random, delete-then-reinsert) each checked for `root`/`size`/`record_set_digest`/`projection_set_digest`, plus order-independence and incremental-`set`-equivalence per vector; the delete-then-reinsert vector replayed via `delete()`+`set()`; empty-root-is-literal-zero; duplicate no-op vs. conflict rejection (both `set()` and `fromSorted`); delete-of-absent-member is a no-op; 200-round randomized incremental-vs-`fromSorted` fuzz (insert/no-op-reset/change/delete); explicit byte-level check of the `record_set_digest`/`projection_set_digest` framing; malformed-digest rejection.
- `pnpm exec eslint` on all new/changed TS files (`merkle-bucket.ts`, `index.ts`, `generate-merkle-bucket-vectors.mjs`, `merkle-bucket.test.ts`) — clean.
- `cargo fmt --all` — applied (whitespace only), clean afterward.
- `cargo clippy -p urdira-indexing-core --all-targets -- -D warnings` — clean (two `sort_unstable_by` → `sort_unstable_by_key` lints fixed).
- `cargo test -p urdira-indexing-core merkle_bucket` — **7 passed, 1 ignored** (the bench): shared-vector match (same 7 cases, plus explicit order-independence check), delete-then-reinsert via `update()` against an external `HashMap`-backed `bucket_entries` store, empty-root, duplicate conflict/no-op (`from_sorted` and within one `update` batch), 200-round randomized incremental-`update`-vs-`from_sorted` fuzz driven by a from-scratch mulberry32 PRNG, and a persistence round-trip (`from_sorted` → `write_to` → `read_from` → `update` one key → `write_slots` → `read_from` → roots equal, and the changed root differs from the original).

Cross-language agreement: the Rust suite reads the exact same `tests/fixtures/digests/merkle-bucket-v4.json` the TS suite reads (via `include_str!`), so all 7 vectors are asserted byte-identical in both languages from one source of truth.

## Bench numbers (`cargo test -p urdira-indexing-core merkle_bucket -- --ignored --nocapture`, 3.2M synthetic members, 500-key `update`)

Release (`cargo test --release ... -- --ignored --nocapture`):

| Metric | Result | Target |
|---|---:|---:|
| `from_sorted`, 16-way `thread::scope` | **282.1 ms** | ≤ 300 ms |
| `from_sorted`, single-threaded reference | 360.8 ms | (comparison only) |
| `update()` of 500 keys (in-memory callback) | **1.603 ms** | ≤ 10 ms |

Both targets met in release. Debug build (the literal command in the task, no `--release`) is far slower as expected for SHA-256-bound code without optimizations — recorded for completeness, not a target: `from_sorted` parallel 2,933.8 ms / single-threaded 6,612.9 ms, `update()` of 500 keys 26.187 ms. Runs were reproducible within ~5% across repeats (272–282 ms parallel, release).

The single-threaded reference in the bench is asserted to produce the identical root as the parallel build (`assert_eq!`), so the 16-way parallelization is confirmed not to change the digest, only the wall time (272-282 ms vs. 361 ms, ~1.3x on 10 cores — dominated by the up-to-3.2M bucket-digest SHA-256 calls, which is I/O-light, memory-bandwidth/hash-bound work that doesn't scale linearly with thread count on this workload size).

## Traps avoided (double-checked)

- Domain strings and byte layout kept byte-for-byte identical between the two languages (verified structurally by the shared-vector cross-language test, not just by inspection).
- Lowercase hex throughout (`to_prefixed_hex` in Rust, `.toString("hex")` in TS — both lowercase by default).
- `u32le`/`u64le` little-endian in both (`writeUInt32LE`/`writeBigUInt64LE` in TS, `.to_le_bytes()` in Rust).
- Empty bucket and empty (whole-)set are the two zero-not-hashed special cases; every other internal node is always hashed, confirmed by the "two leaves under different top nibbles" vector (which requires the untouched middle levels of both branches to resolve to real, non-zero digests for the root to be correct) and by the 200-round fuzz test starting from a freshly-`empty()`/first-`set()` tree.
- `merkle-radix.ts` untouched; `lib.rs` touched only by the one `pub mod merkle_bucket;` line.
