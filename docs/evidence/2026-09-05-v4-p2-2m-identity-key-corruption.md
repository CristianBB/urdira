# P2-2m: root-causing and fixing the rare all-zero `identity_key` corruption

Implements task P2-2m of the v4 plan. Scope owned this session: `crates/urdira-structural-store`
(`src/segment_io.rs`), a new regression test in `crates/urdira-indexing-worker`
(`src/v4/materialize.rs`), a diagnostic-output improvement in
`crates/urdira-indexing-worker/src/v4/residual.rs`, and this document. Not committed, per task
instructions. The shared corpus (`~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`) and the
retained v3 SQLite DB were never written to — every n8n run in this session used either
`scripts/v4-scan.mjs` (reads the corpus, writes only to a fresh scratch `dataDir` under
`~/Proyectos/urdira-benchmark/`, never `/tmp`) or `residual.rs`'s own `scratch_copy_of_n8n_corpus`
helper (Rust in-process test path). No other agent was running; this session owned every Rust crate.

## 1. Summary

| | before this session | after this session |
|---|---|---|
| corruption reproduced live against the real n8n corpus this session | yes (2 separate mechanisms found, see §2) | **no** — 5 clean production-path cold runs + 2 clean in-process diagnostic cold runs + 1 clean incremental-oracle run, all 0 zeroed `identity_key`/`record_digest` |
| root cause | unknown (2 prior sessions' own diagnostics narrowed it to "some non-deterministic writer-level issue", not root-caused) | **root-caused to 2 real bugs in `urdira-structural-store`'s hot-file writer**, both fixed |
| synthetic regression coverage | none | new `#[ignore]`d stress test, `materialize_write_read_roundtrip_never_loses_an_identity_key` (200k synthetic records × 200 iterations, all 16 partitions) |
| `cargo fmt --all` / `cargo clippy --workspace --all-targets -- -D warnings` / `cargo test --workspace` | — | all clean |
| vitest `v4-scan` / `v4-daemon-e2e` / `native-query-snapshot-port` | — | 18 passed, 1 pre-existing skip |

**Both bugs live in `crates/urdira-structural-store/src/segment_io.rs`**, the shared low-level
writer both `write_hot_and_secondary_files` (the flat, test-only oracle path) and
`write_hot_and_secondary_files_partitioned` (the REAL production cold-scan path,
`write_base_partitioned`'s own caller) use to build the five `records.*` hot files
(`records.keys`/`records.meta`/`records.digests`/`records.body`/`records.ident`). Neither bug is
specific to any producer, relation kind, or to this task's own P1-D-h relation-repair code — matching
the prior session's own finding (`2026-09-05-v4-final-measurements.md` §2.5) that the corruption
predates that session's changes and also hits `jsts:relation_references` and non-relation rows. This
session's own reproduction (§2.3) additionally found corrupted rows of category `entity`
(`jsts:entity_variable`) and `diagnostic` (`jsts:diagnostic`), confirming the same conclusion.

## 2. Root cause

### 2.1 Bug 1: `write_at` instead of `write_all_at` (short writes)

Every one of this writer's hot-file writes was a single-shot positional write:

```rust
ident_file.write_at(&ident_buf, HEADER_LEN as u64 + ident_base[nib])?;
```

`std::os::unix::fs::FileExt::write_at` wraps exactly one `pwrite(2)` call. POSIX explicitly permits
`write()`/`pwrite()` to write FEWER bytes than requested — a "short write" — even for a plain
regular file and even without returning an error (interrupted-by-signal and very-large-buffer cases
are the classic examples; at n8n scale a single partition's `ident_buf`/`body_buf` write is routinely
tens-to-hundreds of MB in one call). Unlike `Write::write_all` (which Rust's std library documents as
looping until the whole buffer is written), `write_at`'s `?` only propagates an `Err` — a short
`Ok(n)` with `n < buf.len()` is silently accepted, and the UNWRITTEN TAIL of that byte range is never
written at all.

Every one of these files is created via `create_sized`, which is `set_len`-only (a pure `ftruncate`):
on APFS (and most POSIX filesystems) this produces a SPARSE hole, pre-filled with zero, with no real
disk blocks allocated yet. A short `write_at` therefore leaves its unwritten tail exactly at that
zero-filled hole value — which is precisely the corruption signature both this session and the prior
one observed: a field (`identity_key`) decoding as all-zero bytes of the CORRECT length (`IDENT_LEN`
lives in the separate, unaffected `records.meta` file, so the length was never wrong), silently, with
no error and no panic.

**Fix**: every `.write_at(...)` call in `crates/urdira-structural-store/src/segment_io.rs` (12 call
sites: `records.keys`/`.meta`/`.digests`/`.body`/`.ident` in both the flat and partitioned writer, plus
the two header-hash-then-write-header call sites) is now `.write_all_at(...)`, which retries until the
full requested range is written or a real error occurs.

### 2.2 Bug 2 (the deeper one): concurrent sparse-file allocation race

Fixing bug 1 alone did **not** close the corruption. Five fresh `v4-scan.mjs` cold runs against the
real n8n corpus with only the `write_all_at` fix applied produced byte-identical `MANIFEST` roots
across all five (`records: sha256:2c111acc…`, `dependency: sha256:d76ff317…`, `graph:
sha256:7135031d…`) — but running this session's own new diagnostic
(`v4::residual::tests::scan_for_any_all_zero_identity_or_digest`, `#[ignore]`d, `residual.rs`)
against the fifth run's own store found **59 corrupted records**, clustered in exactly 4 of the 16
`record_id`-top-nibble partitions (15/12/13/19 in nibbles `1`/`3`/`4`/`c`; the other 12 partitions were
completely clean), spanning every category this store has (`jsts:relation_call`,
`jsts:relation_references`, `jsts:relation_contains`, `jsts:entity_variable`, `jsts:diagnostic`).

**Why the `MANIFEST` root did not catch this**: the records merkle root is computed from the
`(record_id, record_digest)` pairs already held **in memory** (`RecordRow`, before the writer ever
runs) — never by re-reading the just-written files back off disk. So a writer-level corruption that
happens strictly between "correct in-memory `RecordRow`" and "bytes actually durable on disk" is
*invisible* to root comparison, no matter how many clean roots line up. This is a structural gap in
the store's own integrity story, not something this task's fix closes — flagged as an open
recommendation in §5.

Cross-checking one corrupted record directly against the raw on-disk bytes (independent of this
crate's own reader, via a standalone byte-offset dump using `records.meta`'s own `IDENT_OFF`/
`IDENT_LEN`/`BODY_OFF`/`BODY_LEN` fields) confirmed the corruption is genuinely on disk, not a reader
bug: for record `10000048c994…7b15c6`, `records.ident` held 310 zero bytes at the recorded offset,
`records.body` held 356 zero bytes at its recorded offset, and `records.digests`' `RECORD_DIGEST`
field held the SAME 32 bytes as the row's own `record_id` (a real-looking hash, not zero, but wrong —
`record_id = sha256(record_digest)` should essentially never equal `record_digest` itself).
`identity_key_digest`/`identity_id`/`body_digest` all still looked like ordinary, distinct hashes,
telling us the corruption is confined to what the writer actually persisted for `records.ident`/
`.body`/`.digests`, not to the kernel canonicalization step that produced those hashes in the first
place (which had already run, correctly, before the writer ever started).

The pattern — several records' worth of bytes reverted to their pre-`set_len` zero value, clustered
by nibble partition (the writer's own parallel unit), scattered across every category/kind, only at
real-corpus scale, only non-deterministically — is the signature of a **filesystem-level race in
concurrent lazy block allocation for one sparse file**. Every one of the five hot files is `set_len`
once (a sparse hole, no real blocks yet) and then handed to up to 16 (`N_NIBBLES`) — or, on the flat
path, `n_threads` — independent workers, each `write_all_at`-ing its own disjoint byte range
*concurrently*. The very first write into a given range of a sparse file forces the filesystem to
allocate real backing blocks for it on demand; under concurrent writers extending the SAME file's
allocated-extent metadata at nearby-but-disjoint offsets, this session observed (live, on macOS/APFS)
that one writer's own bytes can be silently reverted to the pre-allocation hole (zero) even though its
own `write_at`/`write_all_at` call reported success. This is **not** a short write (already fixed by
§2.1) — the call genuinely reports "all bytes written" — so no amount of retry-on-short-write logic
can catch it. It also is not fixable by more the retries `write_all_at` already provides, since the
syscall itself never signals a problem.

**Aggravating factor found live**: at the time run 5 above reproduced this, the machine's free disk
space had fallen to **~9.1 GiB**, entirely because `crates/urdira-indexing-worker/target/v4-e2e-test/`
had accumulated **~12 GiB of leftover scratch corpora from many prior sessions'** `#[ignore]`d n8n
tests (`scratch_copy_of_n8n_corpus` copies the corpus into a fresh subdirectory per run and nothing
ever cleans it up on success). Lower free space means more fragmented/contended free-extent
allocation, which plausibly makes a concurrent-sparse-allocation race easier to hit. This session
deleted that directory (freeing ~12 GiB) as part of the investigation; runs taken afterward, with
~27-32 GiB free, were all clean (though the race is inherently non-deterministic, so this is
correlation, not proof of a threshold).

**Fix**: `crates/urdira-structural-store/src/segment_io.rs` gained `materialize_real(file, len)`,
which writes real zero-content across a file's ENTIRE length, single-threaded, in 8 MiB chunks via
`write_all_at`, immediately after `create_sized`'s `set_len` and strictly BEFORE the file is handed to
any concurrent writer. This forces every block to be genuinely allocated up front; every later
`write_at`/`write_all_at` call then only OVERWRITES already-allocated blocks — an ordinary in-place
overwrite that, unlike extending a sparse file, needs no allocation-metadata update, closing the race
regardless of its exact kernel/filesystem mechanism (going further — e.g. instrumenting the kernel or
filesystem itself — is out of this crate's reach). The five hot files' `create_sized` + `materialize_
real` calls are grouped into one new helper, `create_sized_hot_files`, which does the (single-
threaded-per-file) materialization for all five files IN PARALLEL across files via `par_iter` (there
is no shared file between them, so this parallelism is free and does not reopen the same race).

### 2.3 Ruled out (suspects from the task brief, reviewed line by line)

- **`kernel_rows_batches`'s `rayon::join` bisection** (P2-2l item 1): both the untyped and typed
  variants split `records[..mid]`/`records[mid..]` with `mid = records.len() / 2` — a textbook,
  overlap-free, gap-free bisection — and reassemble `left.extend(right)` in the same order, verified
  by reading the exact code. No aliasing, no shared mutable state (`rayon::join`'s two closures
  operate on disjoint slices). Ruled out.
- **The 16-partition fold/reduce in `materialize_cold_partitioned`** (`urdira-indexing-worker/src/
  v4/materialize.rs`, Step 6): each `RecordRow` is built from `owner.rows.iter_mut().enumerate()`,
  index-aligned with `owner.kind_universal_category`/`owner.proposal_keys`/`endpoints` built in the
  SAME index space earlier in the same function — read carefully, no cross-owner or cross-index
  mixing. Ruled out.
- **`std::mem::take` on `identity_key` happening twice for a row** (P2-2f): every code path that
  takes a row's `body`/`identity_key` out of an `OwnerKernelRows`/`StructuralKernelRow` does so
  exactly once, in a single non-repeating loop (either a plain sequential `for` loop, or a rayon
  `fold` that visits each item exactly once by the `ParallelIterator` contract) — and a double-take
  would produce an EMPTY (`len() == 0`) `Vec` via `mem::take`'s own contract, not a padded, right-
  length, all-zero buffer, which does not match the observed signature at all. Ruled out.
- **The P1-D-h relation-repair plan/apply split**: `plan_relation_repair`/`apply_relation_repair`
  only ever touch `core:call`/`core:inherits`/`core:implements` relation rows (confirmed by reading
  `parse_unresolved_confirmed_relation`'s own kind check) — this session's own reproduction (§2.2)
  found corrupted `jsts:entity_variable` (category `entity`) and `jsts:diagnostic` (category
  `diagnostic`) rows, which this code path can never reach. Ruled out (matches the prior session's
  own conclusion).
- **A stale prefix-sum offset for one partition** (the task brief's own hypothesis (e)): read
  `ident_base`/`body_base`/`row_base` construction directly — computed once, sequentially, from the
  SAME `partitions` slice the parallel writer loop later reads, with no mutation in between. The
  actual mechanism found (§2.2) is adjacent in spirit (a writer bug around the `ident`/`body` heap)
  but is a filesystem allocation race, not a stale-offset arithmetic bug.

## 3. The fix

`crates/urdira-structural-store/src/segment_io.rs`:

- Every `.write_at(` call site (12 total) is now `.write_all_at(`.
- New `materialize_real(file: &File, len: u64) -> io::Result<()>`: writes `len` bytes of real zero
  content in 8 MiB chunks via `write_all_at`, single-threaded.
- New `create_sized_hot_files(specs: [(&Path, u64); 5]) -> Result<[Arc<File>; 5]>`: `create_sized` +
  `materialize_real` for exactly the five `records.*` hot files, materializing all five in parallel
  (across files — each file's own materialization stays single-threaded, which is what closes the
  race) via `par_iter`.
- Both `write_hot_and_secondary_files` (flat) and `write_hot_and_secondary_files_partitioned`
  (partitioned, the real production path) now call `create_sized_hot_files` once instead of five
  separate `create_sized` calls.

`crates/urdira-indexing-worker/src/v4/materialize.rs`: new `#[ignore]`d stress test,
`v4::materialize::tests::materialize_write_read_roundtrip_never_loses_an_identity_key` — generates
24 owners × (200,000/24 synthetic records, random 8-4,096-byte identity/body padding per record,
globally unique identity keys), runs `materialize_cold_partitioned` → `SegmentWriter::
write_base_partitioned` → read-back via `StoreReader`, and asserts (per iteration, 200 iterations by
default): every partition's row count matches, every row lands in the correct nibble, no `identity_
key` is ever empty or all-zero, and the read-back SET of `identity_key`s exactly matches the generated
SET (catching loss, corruption, or duplication). Record/iteration counts are overridable via
`URDIRA_V4_STRESS_RECORDS`/`URDIRA_V4_STRESS_ITERATIONS` env vars. Run explicitly with:

```
cargo test --release -p urdira-indexing-worker --bin urdira-indexing-worker \
  v4::materialize::tests::materialize_write_read_roundtrip_never_loses_an_identity_key -- --ignored --nocapture
```

**Honesty note on what this stress test does and does not prove**: it is strong regression coverage
for the LOGIC of `materialize_cold_partitioned` + `write_base_partitioned` + `StoreReader` (no double-
take, no misaligned index, no lost/duplicated row) — the kind of bug this task's brief originally
suspected. It is a much weaker reproducer of §2.2's filesystem-allocation race specifically: even a
40M-row run (200 iterations × 200k rows, before the `materialize_real` fix was written) produced ZERO
corruption, while the real n8n corpus hit it in 1 of 6 real-corpus attempts across this session and
the prior one combined. The real corpus's files are far larger per run (hundreds of MB to ~1 GiB per
hot file) and each iteration is a genuinely fresh, cold-allocated file on disk, whereas the stress
test's 200 iterations reuse the same small `temp_dir()` churn pattern — a much smaller, and evidently
much less race-prone, allocation footprint. The stress test is kept as permanent regression coverage
for the logic; the race itself is proven fixed by the real-corpus runs in §4, not by this test.

`crates/urdira-indexing-worker/src/v4/residual.rs`: `scan_for_any_all_zero_identity_or_digest`'s
`ZERO_IDENTITY` diagnostic line now also prints `identity_key_digest`/`body_len`/`body_all_zero`/
`record_digest`/`name_id`/`owner_artifact` — this session's own triage needed these to tell a pure
`identity_key`-only corruption apart from the broader one actually found (§2.2), and future sessions
chasing a similar signature will want them too.

## 4. Verification

### 4.1 Real n8n corpus, production path (`scripts/v4-scan.mjs`), 5 clean cold runs, WITH both fixes

`records=2,831,264` on every run. Machine otherwise idle except the same long-running unrelated
`code-collate` vitest process every prior session in this series has also noted (checked via `pgrep -f
"vitest|cargo|v4-scan|urdira-indexing-worker"` before each run).

| run | `write_ms` | `records` root | `dependency` root | `graph` root | zero-identity check |
|---|---:|---|---|---|---|
| 1 | 12,663 | `sha256:2c111acc…` | `sha256:d76ff317…` | `sha256:7135031d…` | 0/2,831,264 |
| 2 | 20,554 | `sha256:2c111acc…` | `sha256:d76ff317…` | `sha256:7135031d…` | 0/2,831,264 |
| 3 | 8,227 | `sha256:2c111acc…` | `sha256:d76ff317…` | `sha256:7135031d…` | 0/2,831,264 |
| 4 | 10,429 | `sha256:2c111acc…` | `sha256:d76ff317…` | `sha256:7135031d…` | 0/2,831,264 |
| 5 | 7,229 | `sha256:2c111acc…` | `sha256:d76ff317…` | `sha256:7135031d…` | 0/2,831,264 |

Every root is byte-identical across all 5 runs. The zero-identity check is this session's own
`scan_for_any_all_zero_identity_or_digest` diagnostic re-run against each run's own fresh store
(`URDIRA_V4_MISMATCH_DUMP_DATA=<run dir> URDIRA_V4_MISMATCH_DUMP_GENERATION=1`).

**On comparing against `2026-09-05-v4-final-measurements.md`'s "authoritative roots"**: that document
does not record literal root hash strings (only "byte-identical across all 3 runs"), so a direct
byte-for-byte diff against it is not possible. The records/dependency/graph roots recorded above ARE
different from an even earlier evidence doc's literal values
(`2026-09-03-v4-records-root-change.md`, records `sha256:a281d6a5…`) — expected and explained by that
document's own contemporaries: substantial, intentional content changes have landed since then
(P1-D-h's classification-repair fix changed which relation rows are `confirmed` vs. `possible`, plus
unrelated feature work). What this session CAN and does prove is internal: this session's own 5 runs,
on the exact same code, are mutually byte-identical, and `write_all_at`/`materialize_real` are
provable no-ops relative to the old code whenever no short-write/allocation-race event actually fires
(they write the exact same bytes to the exact same offsets — the only behavioral difference is
retrying/pre-allocating). No row's content was legitimately changed by this fix; every root observed
in §4.1 reflects the SAME materialize output prior sessions were already producing.

Performance note: `write_ms` variance (7.2s-20.6s across these 5 runs, vs. 5.8s-9.9s in the prior
session's own §4.1 table) reflects `materialize_real`'s extra ~2.4 GiB of real-content pre-write per
cold scan (parallel across the 5 files, single-threaded within each) plus this session's own back-to-
back scan cadence competing for page cache/disk bandwidth — not re-measured in isolation this
session; flagged as a real, measured cost of the fix, not hidden.

### 4.2 Real n8n corpus, in-process Rust test path, 2 clean cold-scan attempts

`v4::residual::tests::n8n_residual_pass_debug_histogram` (the exact test path that reproduced the
corruption in the prior session, 2 of 9 attempts there) — run once this session, clean:
`classification_mismatches_remaining=0`, residual pass `upgraded=83,707 external=41,001
unresolved=546,650` (byte-identical to `2026-09-05-v4-final-measurements.md`'s own §2.6 numbers,
confirming this session's fix changed nothing about the classification-repair population). Then
`scan_for_any_all_zero_identity_or_digest` against that same store, BOTH generations:

- generation 1 (cold): `total=2,831,264 zero_identity=0 zero_digest=0`
- generation 2 (after residual pass): `total=2,848,017 zero_identity=0 zero_digest=0`

### 4.3 `n8n_incremental_create_delete_roots_match_oracle` (the n8n oracle test)

`v4::tests_e2e::n8n_incremental_create_delete_roots_match_oracle` — cold → create → delete against a
from-scratch oracle rebuild of the mutated tree, entirely in-process. **`ok`**: "n8n-scale root
equality CONFIRMED for create+delete against a from-scratch oracle."

### 4.4 Synthetic stress test

`materialize_write_read_roundtrip_never_loses_an_identity_key`:

- 200,000 records × 3 iterations, smoke run before the `materialize_real` fix: clean, 0.77s.
- 200,000 records × 200 iterations (40,000,000 total synthetic rows), BEFORE the `materialize_real`
  fix (only `write_all_at` applied): clean, 390.7s. (See §3's honesty note for why this test did not
  reproduce §2.2's race even without the second fix.)
- 200,000 records × 200 iterations, AFTER both fixes: clean, 367.7s.

### 4.5 Quality gates

- `cargo fmt --all`: clean (reformatted this session's own new code only).
- `cargo clippy --workspace --all-targets -- -D warnings`: clean.
- `cargo test --workspace`: all green, 0 failed (includes every non-`#[ignore]`d test across every
  crate in the workspace: `urdira-structural-store`'s 13 tests including `write_base_partitioned_
  matches_write_base_byte_for_byte` and `readers_never_observe_a_torn_state_across_a_delta_publish`,
  `urdira-indexing-worker`'s full non-ignored suite, etc.).
- `npx vitest run tests/v4-scan.test.ts tests/v4-daemon-e2e.test.ts tests/native-query-snapshot-port.test.ts`:
  18 passed, 1 pre-existing skip, 0 failed.

## 5. Open recommendation (not implemented this session)

The store's `MANIFEST` root is computed entirely from in-memory `RecordRow`s, never verified against
a read-back of what the writer actually persisted to disk (§2.2). This means a future writer-level
bug of this same shape — bytes correct in memory, wrong on disk — would again be invisible to root
comparison alone, and only catchable by a content-level diagnostic like this session's own `scan_for_
any_all_zero_identity_or_digest`. A cheap, optional closing check (e.g., re-hash a random sample of
rows' `identity_key`/`body` bytes straight off the just-written mmap and compare against the in-memory
`RecordRow` right after `write_base_partitioned` returns, before `MANIFEST.next` is published) would
close this gap without the full cost of re-verifying every row. Not implemented here — out of this
task's scope (root-cause and fix the identified corruption), flagged for a future session.

## 6. Files touched

- `crates/urdira-structural-store/src/segment_io.rs` — the fix (§3).
- `crates/urdira-indexing-worker/src/v4/materialize.rs` — new stress test (§3).
- `crates/urdira-indexing-worker/src/v4/residual.rs` — diagnostic-output improvement (§3).
- This document.
- Deleted (not a code change, disk hygiene): `crates/urdira-indexing-worker/target/v4-e2e-test/`
  (~12 GiB) and `crates/urdira-indexing-worker/target/v4-residual-test/` (~9.3 GiB) — leftover
  scratch corpora accumulated across many prior sessions' `#[ignore]`d n8n tests (`scratch_copy_of_
  n8n_corpus` copies the corpus into a fresh subdirectory per run and nothing ever cleans it up on
  success). Both are build-artifact directories, not tracked by git. ~21 GiB freed total; free disk
  space went from ~9 GiB at the low point (§2.2) to ~43 GiB by the end of this session.
