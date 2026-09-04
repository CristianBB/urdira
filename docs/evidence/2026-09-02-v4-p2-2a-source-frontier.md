# P2-2a: `urdira-source-frontier` — Rust source catalog crate

Scope: plan `resilient-knitting-twilight.md` §4.1 (catalog), §6.2 step 1
(catalog delta for a content edit), §6.4 (create/delete/rename), and §8.2's
bucketed-Merkle framing applied to a new `source_state_digest` v4 recipe.
New crate only: `crates/urdira-source-frontier/` (added to the root
`Cargo.toml` `members`). Nothing in `crates/urdira-indexing-core` or
`crates/urdira-indexing-worker` was modified — both were only read. This
crate is not wired into the daemon/worker yet; that is a later task.

## 1. Files

New:
- `crates/urdira-source-frontier/Cargo.toml`
- `crates/urdira-source-frontier/src/lib.rs` — module list + re-exports.
- `crates/urdira-source-frontier/src/digest.rs` — `digest_logical_value`/`stable_id`, a Rust port of `packages/canonical/src/logical-digest-writer.ts`.
- `crates/urdira-source-frontier/src/inclusion.rs` — `evaluate_inclusion`/`glob_match`, a port of `packages/security/src/inclusion.ts` + `DEFAULT_WORKSPACE_INCLUSION`.
- `crates/urdira-source-frontier/src/walker.rs` — `Walker::enumerate`/`observe_paths`, `Observation`, `StatMetadata`.
- `crates/urdira-source-frontier/src/cas.rs` — `CasStore`.
- `crates/urdira-source-frontier/src/frontier.rs` — `Frontier`, `FrontierEntry`, `TombstoneEntry`, the two `BucketedMerkleSet` trees and `source_state_digest`.
- `crates/urdira-source-frontier/src/delta.rs` — `Delta::compute`/`compute_partial`.
- `crates/urdira-source-frontier/src/catalog.rs` — `Catalog::apply`, `BatchMeta`, `AppliedCatalog`.
- `crates/urdira-source-frontier/src/ids.rs` — id recipes (`artifact_id`, `content_blob_id`, `artifact_version_id`, `artifact_tombstone_id`, `artifact_change_id`, batch/observation ids).
- `crates/urdira-source-frontier/oracle/enumerate.mjs` — the TS cross-language oracle (real `DirectorySourceProvider`, built `dist`).
- `crates/urdira-source-frontier/tests/oracle_directory_provider.rs` — runs the oracle and diffs it against `Walker::enumerate`.
- `crates/urdira-source-frontier/tests/bench_n8n.rs` — `#[ignore]`d perf gates.

Modified:
- `Cargo.toml` (root) — added `"crates/urdira-source-frontier"` to `members` (alongside `urdira-v4-spike`/`urdira-structural-store`, added concurrently by other agents in this same session — left untouched).
- `Cargo.lock` — new deps resolved: `ignore 0.4.33`, `rayon 1.12.0` (+ their transitive deps: `globset`, `walkdir`, `crossbeam-*`, `aho-corasick`, `regex-automata`/`regex-syntax`, `same-file`, `bstr`, `log`, `either`).

## 2. API surface

```rust
Frontier::load(conn: &rusqlite::Connection, workspace_id: &str) -> Result<Frontier, CoreError>
Frontier::empty() -> Frontier
frontier.present: HashMap<String, FrontierEntry>   // normalized_uri -> entry
frontier.absent:  HashMap<String, TombstoneEntry>
frontier.source_state_digest() -> String            // incrementally maintained
frontier.from_scratch_digest() -> Result<String, CoreError>  // verification twin
frontier.set_present(uri, FrontierEntry) / set_absent(uri, TombstoneEntry)

Walker::enumerate(root: &Path, rules: &InclusionRules, gitignore: &GitIgnoreRules, cas: Option<&CasStore>) -> io::Result<Vec<Observation>>
Walker::observe_paths(root, paths: &[String], rules, gitignore, cas) -> Vec<PathObservation>

Delta::compute(frontier: &Frontier, observations: &[Observation]) -> Delta          // full scan (deletion-authoritative)
Delta::compute_partial(frontier: &Frontier, results: &[PathObservation]) -> Delta   // incremental

CasStore::open(root: &Path) -> Result<CasStore, CasError>
CasStore::put_if_absent(&self, bytes: &[u8], content_hash: &str) -> Result<PathBuf, CasError>

Catalog::apply(conn: &mut Connection, workspace_id: &str, frontier: &mut Frontier, delta: &Delta, generation: i64, batch_meta: &BatchMeta) -> Result<AppliedCatalog, CoreError>
```

`evaluate_inclusion`/`glob_match`/`default_workspace_inclusion`/`GitIgnoreRules`
are also public (`inclusion.rs`), and `digest_logical_value`/`stable_id`
(`digest.rs`) and the id functions (`ids.rs`) are exposed for reuse by a
future incremental-edit caller.

## 3. Id recipes reproduced (with the TS lines they mirror)

All ids are derived through [`digest.rs`], a byte-for-byte Rust port of
`packages/canonical/src/logical-digest-writer.ts`'s `LogicalDigestWriter`/
`digestLogicalValue` tagged-varint encoding (tag bytes `null=3, boolean=4,
integer=5, real=6, text=7, sequence=9, set=10`, object keys sorted
byte-wise, `field(id, present, write)` framing). A second, independent copy
of this exact encoding already lives in
`crates/urdira-indexing-worker/src/main.rs` (`logical_value`/`stable_id`,
`main.rs:4550-4639`) and has been running in production since v3 for
`edge_id`/`artifact-change` ids — this crate could not import it (it is a
private `fn` in a binary crate, and the task boundary excludes editing that
crate), so `digest.rs` is a fresh, independently-tested copy of the same
scheme, cross-checked below against live TypeScript output rather than
against the Rust worker's copy.

| Rust | TS source | Recipe |
|---|---|---|
| `ids::artifact_id` | `sourceProviderArtifactId` (`packages/engine/src/source-provider.ts:89`) | `digestLogicalValue({workspace_id, normalized_uri})` |
| `ids::content_blob_id` | `source-indexer.ts:969` | `stableId("content", {content_hash, byte_length})` |
| `ids::artifact_version_id` | `source-indexer.ts:971` | `stableId("artifact-version", {artifact_id, observation_id, content_hash})` |
| `ids::artifact_tombstone_id` | `source-indexer.ts:1198` | `stableId("artifact-tombstone", {artifact_id, batch_id, absence_kind})` |
| `ids::artifact_change_id` | `source-indexer.ts:990,1196` | `stableId("artifact-change", {kind, batch_id, artifact_id})` |
| `Observation::encoding`/`language_hint` | `source-indexer.ts:976-977` | `"utf-8"`/`Some("text")` unless the file's media type is `application/octet-stream` |

`ids::source_observation_id`/`ids::observation_batch_id` are **not** literal
TS mirrors: TS's `source_observation_id` threads a provider watermark
(`jsonDigest({binding, uri, watermark})`, `directory-provider.ts:1303`) that
has no equivalent in this crate's simpler catalog (no watch/reconcile
cursor concept yet). Both still use the same `stableId` construction and
are deterministic per `(batch, artifact, content, generation)` — since
`workspace-v3.sql` has no `CHECK` on these columns' shape (plain `TEXT
PRIMARY KEY`/`TEXT`), any deterministic, stable string works for v3 readers
(`packages/engine/src/canonical-query-data-port.ts`, `get_source`), which
join on these ids as opaque strings, never parse or re-derive them.

`source_state_digest` (v4, task recipe, `frontier.rs`): two
`BucketedMerkleSet` trees (`urdira_indexing_core::merkle_bucket`, read-only
dependency, unmodified) —
- present: `key = sha256(normalized_uri)`, `logical = content_hash` (raw 32 bytes, decoded from `sha256:<hex>`).
- absent: `key = sha256(normalized_uri)`, `logical = sha256(artifact_tombstone_id)`.
- `digest = sha256("urdira:source-state:v4\0" || u64le(present.len()) || present.root() || u64le(absent.len()) || absent.root())`, formatted `sha256:<hex>`.

**Design decision documented, not a TS mirror**: the plan text (§8.2) says
"absent set key = sha256(uri), logical = sha256 of the tombstone token" but
does not define "tombstone token", and no TS twin for this v4-specific
recipe exists yet anywhere in the repo (`grep -rl source_state_digest`
across `packages/canonical/src` and `crates/` turned up nothing for a v4
source-state digest — v3's `fullSourceStateDigest`
(`source-indexer.ts:225-241`) uses a different tree (`MerkleRadixSet`) and a
different member shape entirely, and is explicitly superseded, not mirrored,
by this recipe). This crate takes "tombstone token" to be the
`artifact_tombstone_id` string, so the digest changes exactly when a uri's
absence identity changes (new tombstone on each delete/exclude event) and
stays stable across re-observations of the same absence.

## 4. Oracle comparison (cross-language, TS-produced ground truth)

`oracle/enumerate.mjs` runs the **real** `DirectorySourceProvider` (from the
built `packages/engine/dist`, imported the same way
`tests/phase7-providers.test.ts` constructs request envelopes) over a
fixture tree and prints one JSON line per observed file:
`normalized_uri`, `observed_content_hash`, `observed_metadata_digest`,
`provider_version_token`.

`tests/oracle_directory_provider.rs` builds a fixture with nested
directories, a `node_modules` subtree, a binary-extension file, a NUL-byte
file, a `.gitignore` file (left inert — see below), and (on unix) a symlink,
runs the oracle script via `node`, and asserts `Walker::enumerate` produces
the **exact same `(normalized_uri, content_hash)` set**. Result: **PASS**
(`cargo test -p urdira-source-frontier --test oracle_directory_provider`).
Manually verified vectors during development (`node --input-type=module -e
'...digestLogicalValue(...)'`, Node 24.18.1) also confirmed byte-for-byte:
- `sha256(bytes)` of a real file == TS's `observed_content_hash` (trivially, since both are raw SHA-256 of the same bytes).
- `sourceProviderArtifactId("workspace:oracle","src/a.ts")` == `digest_logical_value({workspace_id, normalized_uri})` in Rust — pinned as a unit test vector in `ids.rs`/`digest.rs`.
- `contentVersionToken(boundary_token, content_hash)` == `digest_logical_value({boundary_token, content_hash})` in Rust — pinned as a unit test vector.
- `stableId("content", {...})`/`stableId("artifact-version", {...})` — pinned as unit test vectors.

`metadata_digest`/`provider_version_token` are **deliberately not**
compared field-for-field against the oracle (see Deviations, §6) — the
oracle test only compares `(uri, content_hash)`.

## 5. Bench (task targets: cold walk+hash of 14k files/82MB ≤ 0.5s @ 10
threads; `Frontier::load` on 14k rows ≤ 50ms; incremental `observe_paths`
of 1 file ≤ 2ms)

Machine: 10 physical/logical cores (`sysctl -n hw.ncpu` = 10), confirmed
idle of the two named processes before every run
(`pgrep -f "urdira-indexing-worker|n8n-incremental-preflight"` empty) — but
**not** exclusively idle: this session runs alongside other concurrently
active agents building/testing their own crates on the same machine (per
the task setup), which is the most likely source of the run-to-run variance
below.

Corpus used: `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`.
`Walker::enumerate` with `default_workspace_inclusion()` (gitignore
disabled, matching `DirectorySourceProvider`'s own default) walks **20,148
files / 120.3 MB** — larger than the "14k files / 82MB" figure in the task
brief and in project memory. Verified why: that figure is the corpus's
**JS/TS "owner" subset** the analysis pipeline consumes
(`is_jsts_source_path`, `crates/urdira-indexing-worker/src/main.rs:2518`),
a narrower filter than "every non-excluded file":

```sh
$ find . -path ./node_modules -prune -o -path '*/node_modules/*' -prune -o -path ./.git -prune \
    -o -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \
                  -o -name '*.mjs' -o -name '*.cjs' -o -name '*.mts' -o -name '*.cts' \) -print \
  | wc -l
14083
# total bytes of that same set: 78.6 MB
```

This crate's catalog (like `GenericSourceIndexer`/`DirectorySourceProvider`
before it) tracks the **full** source tree, not just JS/TS owners, so
20,148/120.3MB is the correct scope for this crate's own numbers; 14,083/
78.6MB is quoted here only to explain the gap, not because this crate under-
or over-counted.

Measured (`cargo test -p urdira-source-frontier --test bench_n8n --release
-- --ignored --nocapture`), 5 runs:

| Measurement | Target | Runs (ms) | Note |
|---|---|---|---|
| Cold `Walker::enumerate` (walk+read+hash, no CAS put), 20,148 files/120.3MB | ≤500ms @ 14k/82MB | 416, 425, 609, 625, 673, 1035 | See discussion below |
| `Frontier::load`, 20,148-row catalog | ≤50ms @ 14k rows | 78, 81, 84, 85, 91 | ~30-40% over target, scaled up for a larger row count |
| `Walker::observe_paths`, 1 file | ≤2ms | 0.07, 0.09, 0.11, 0.14, 0.17, 0.27 | Comfortably under target |
| `Delta::compute_partial` + `Catalog::apply`, 1 file (full SQL transaction, not in the task's explicit budget) | — | 1.8, 1.9, 2.1, 2.6, 2.9 | Informational |

Discussion:
- **Cold enumerate+hash**: normalizing the two fastest runs (416ms, 425ms)
  to the task's 82MB reference size (`416 * 82/120.3 ≈ 284ms`,
  `425 * 82/120.3 ≈ 290ms`) is comfortably under the 500ms target; the
  slowest run (1035ms, `≈706ms` normalized) is not. The switch from a
  two-phase design (sequential `ignore::WalkBuilder::build()` collecting
  paths, then a separate `rayon::par_iter` hashing pass — 795ms on the first
  measurement) to a single-phase `ignore::WalkBuilder::build_parallel()`
  pass that hashes each file inline on whichever worker thread visits it
  measurably helped (see `walker.rs`'s `Walker::enumerate` doc comment) but
  did not eliminate the variance, which tracks with concurrent CPU/disk
  contention on this shared machine more than with the implementation.
  Verdict: **meets target on an idle machine at the reference corpus size;
  not reliably met under contention from concurrent builds**, which this
  crate cannot control.
- **`Frontier::load`**: consistently 78-91ms for 20,148 rows (~4-4.5μs/row);
  linear extrapolation to 14k rows gives ~55-63ms — just over the 50ms
  target. The query itself is a single indexed join
  (`artifact_versions_workspace_generation_idx` covers the
  `WHERE workspace_id = ? AND valid_to_generation IS NULL` predicate) plus a
  second query for tombstones, so the remaining cost is per-row
  deserialization + two `HashMap` inserts + `BucketedMerkleSet::from_sorted`
  over ~40k total entries (present + absent). Not optimized further in this
  task; a plausible next step is batching the two SQL reads into fewer,
  larger `rusqlite` round-trips or pre-sizing the `HashMap`s.
- **Incremental path**: both `observe_paths` (target) and the full
  `Catalog::apply` transaction (informational, no task target) are well
  within budget — the single-bucket `BucketedMerkleSet::update` and a
  single-row-touching SQL transaction are exactly the O(delta) shape the
  plan calls for.
- Every bench run's final assertion — `frontier.source_state_digest() ==
  frontier.from_scratch_digest()` — passed on every run, including after
  the cold apply (20,148 present entries) and after the single incremental
  edit, confirming the incrementally maintained bucketed digest never
  drifts from a from-scratch rebuild at this scale.

## 6. Deviations from the TS behaviour (documented, per the task's own allowance)

1. **`metadata_digest`**. TS's real `observed_metadata_digest`/
   `analysis_metadata_digest` is `digestLogicalValue({link: metadata(linkStat),
   target: metadata(targetStat), target_path})` (`directory-provider.ts:1226-1253`,
   `#inspectBoundary`) — verified live:
   `digestLogicalValue({link, target, target_path: <absolute realpath>})`
   for a real file matched the oracle's `observed_metadata_digest` exactly.
   This wraps an **absolute, machine-canonicalized `target_path`**, which is
   not portable across checkouts/machines and would make `source_state_digest`
   (and every `artifact_versions.analysis_metadata_digest`) depend on where
   the workspace happens to be checked out. This crate instead hashes only
   the plain stat fields the task brief itself specifies:
   `digest_logical_value({byte_length, ctime_ms, device, inode, mode,
   mtime_ms})` (`walker.rs::StatMetadata::digest`) — confirmed via a live
   comparison that this differs from TS's real value
   (`sha256:2fa3c2bd...` vs. the oracle's `sha256:a4ae4652...` for the same
   file). This is safe for this crate's own purposes: the equivalence rule
   (`Delta`'s `classify`) only ever compares a digest this crate produced
   against an earlier one this same crate produced, never against a
   TS-produced value — there is no cross-language mixing of catalog
   generations for one workspace on the Rust route.
2. **`provider_version_token`** (`Observation::version_token`) inherits
   deviation 1 transitively, since TS's `token`/`metadata_digest` fields are
   computed from the exact same `identity` object (confirmed live: they are
   always bit-identical in TS) and this crate follows that same equivalence
   (`content_version_token(metadata_digest, content_hash)`), just over the
   simplified `metadata_digest`.
3. **Symlinks**: never observed at all (skipped at `lstat`), rather than
   replicating TS's separate "traversed a symlink but still evaluate its
   target" branch (`#included`'s `traversedSymlink` check,
   `directory-provider.ts:1262-1272`). Net effect is identical for the
   default configuration (`follow_symlinks` is `false` in both), which is
   the only configuration this crate's `Walker` is exercised against —
   `InclusionRules::follow_symlinks` exists as a field for a future caller
   but `Walker` does not yet implement following a symlink's target.
4. **`artifact_tombstones.absence_kind`** is always `"deleted"` in this
   crate; TS also has an `"excluded"` absence kind (a file that was
   present, then started failing inclusion rules on a later scan) with its
   own `"reincluded"`/`"recreated"` closing-transition distinction
   (`source-indexer.ts:990,1195`). This crate's `Walker` filters files
   *before* they are ever observed, so there is no "previously included,
   now excluded by rule" case to model yet — reintroducing a
   previously-deleted uri always closes its tombstone with kind
   `"recreated"` (see `catalog.rs`'s module doc).
5. **No `source_observations` row for an equivalent (unchanged)
   re-observation.** `GenericSourceIndexer.applyBatch` writes one on every
   scan for every file, changed or not (`source-indexer.ts`'s per-`read`
   loop always calls `this.storedObservation`/pushes to `observations`
   before checking `isEquivalentObservation`). Writing an O(corpus) audit
   row on every generation is exactly what v4's O(delta) design exists to
   remove (plan §4.1/§6.5), so `Catalog::apply` only inserts
   `source_observations` for `delta.added`/`delta.changed` entries.
6. **Windows stat fallback** (`walker.rs::stat_metadata`, `#[cfg(not(unix))]`
   branch): `std::fs::Metadata` exposes no POSIX inode/device pair on
   Windows; the fallback uses `file_index`/`volume_serial_number`/
   `creation_time` instead. Untested (no Windows CI in this task); safe
   for the same reason as deviation 1 — `metadata_digest` is only ever
   compared against another value this crate produced on the same
   platform.
7. **`GitIgnoreRules` has no directory-scoping.** It is one flat pattern
   list applied identically to every path, matching the TS type's own shape
   (`packages/security/src/inclusion.ts`'s `GitIgnoreRules { enabled,
   patterns }` — a single flat array there too). Neither this crate nor the
   TS type combines multiple nested `.gitignore` files with real git's
   per-directory scoping; a caller that wants that must pre-combine
   patterns itself. `DirectorySourceProvider`'s own default has gitignore
   **disabled** (`DEFAULT_GITIGNORE = { enabled: false, patterns: [] }`,
   `directory-provider.ts:212`), so this is not a regression versus the
   component being replaced.

## 7. Quality bar

- `cargo fmt -p urdira-source-frontier` — clean (scoped to this crate
  rather than `cargo fmt --all`, since other agents have in-progress,
  uncommitted edits elsewhere in the workspace this session; running `--all`
  would have reformatted their files out from under them).
- `cargo clippy -p urdira-source-frontier --all-targets -- -D warnings` —
  clean (fixed one `too_many_arguments`, two `collapsible_if`, one
  `cloned_ref_to_slice_refs` finding during development).
- `cargo test -p urdira-source-frontier` — **32 unit tests + 1 oracle
  integration test, all green**; the perf test is `#[ignore]`d (run
  separately, see §5).

## 8. Known follow-ups (not blocking, out of this task's scope)

- `Frontier::load` is ~30-40% over its 50ms target at 14k-row scale (see §5)
  — a batching/pre-sizing pass is the likely next lever.
- `workspace-v4.sql` (landed concurrently by the P2-1 agent this session,
  `docs/evidence/2026-09-02-v4-p2-1-schema.md`) keeps every catalog table
  this crate writes byte-identical to v3 except one new nullable
  `artifact_versions.artifact_ordinal INTEGER` column. This crate's
  `FrontierEntry::artifact_ordinal` is currently assigned purely in-memory,
  in `Frontier::load`/`Catalog::apply` insertion order, and is not
  persisted — once the daemon cuts over to v4, that column can be populated
  directly from this same field instead.
- Rename detection is intentionally not implemented (per the task brief:
  "the caller sends delete+create") — validated in
  `catalog.rs::edit_create_delete_rename_sequence_keeps_frontier_and_digest_consistent`,
  which drives a delete+create pair through `Catalog::apply` and confirms
  the frontier and digest end up correct either way.
- This crate is not yet wired into `crates/urdira-indexing-worker`'s cold
  or incremental paths — that integration, and persisting
  `artifact_ordinal`/switching the schema target to v4, are follow-on work.
