# Investigation: v4 cold `records` root change (`cba95efc…` → `a281d6a5…03987`)

Investigation only. No production code changed. One permanent diagnostic
test added (`crates/urdira-indexing-worker/src/v4/tests_e2e.rs`). Corpus
`~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02` was read, never
written. Machine: macOS arm64, 10 cores, 32 GB RAM, NVMe. `rustc` 1.98.0,
Node 24.18.1.

## 1. Question

`docs/evidence/2026-09-02-v4-p2-2b-cold-pipeline.md` §14 pins the v4 COLD
`records` root at `sha256:cba95efc…` across every round through P2-2h round
4. §15.0 (P2-2h round 5's re-measured baseline, taken *after* the P3-1/
P3-2/P3-3/P3-6 incremental-work rounds ran on shared code) finds it changed
to `sha256:a281d6a5…03987`, with `dependency` also changed (separately and
fully explained by P3-2 §3: `dependency_id` moved from workspace/generation
-salted artifact ordinals to raw `(owner_path, dep_path, role)` strings) but
`graph` (`sha256:23089a90…52ac0`) unchanged. The task: find exactly what
changed in `records` and classify it as a legitimate contract fix or a
regression.

## 2. Method and what was actually available

The task's method assumed a runnable "v3 accept path" oracle to diff
against v4 on a small fixture. That already exists in spirit —
`crates/urdira-indexing-worker/src/v4/materialize.rs`'s
`record_identity_matches_the_structural_kernel_oracle_exactly` builds one
`ProposedRecord` and canonicalizes it directly through
`urdira_indexing_core::structural_kernel_batch_parts`, the *same* function
`main.rs`'s v3 hybrid lane calls (`canonicalize_structural_chunk`,
`main.rs:1139`) — v3 and v4 share the identical fact-extraction crate
(`urdira-jsts-syntax-worker`) and the identical digest kernel
(`urdira-native-core`); there is no separate "v3 materialize" pipeline to
build a from-scratch external oracle from. That test, and the fixture-scale
determinism test `cold_scan_is_deterministic_across_two_independent_runs`
(asserts every `record_id`/`record_digest`/`identity_key` matches, not just
the root, across two independent from-scratch cold scans of the fixture),
both pass today — confirmed by re-running the full suite (§6).

What was **not** available: any surviving artifact from the `cba95efc…`
measurement itself. All v4 work in this repo is uncommitted (`git status`
shows the entire `crates/urdira-indexing-worker/src/v4/` tree, `urdira-
structural-store`, `urdira-source-frontier`, etc. as untracked `??`), so
there is no git history to `diff` the pre-P3-x code against, and every
on-disk store under `~/Proyectos/urdira-benchmark/v4-p2/` already reflects
`a281d6a5…` (verified: every `p2-2h-*` and `p2-2h-baseline/*` `MANIFEST`
found on disk carries `records: sha256:a281d6a5…03987`; none carry
`cba95efc…`). The investigation therefore proceeded by (a) code-proving
which hypotheses are impossible given the current, still-in-place logic,
and (b) using the one surviving artifact — the P2-2b evidence doc's own
per-kind record-count table, captured *from the `cba95efc…`-rooted run* —
as a fixed point to compare the live store against.

## 3. Hypothesis 1 ("`jsts:relation_import` embeds a dependency reference,
graph excludes import relations") — disproved by reading the code

`v4/publish.rs`'s `graph_entries` filters `records` by
`category == CATEGORY_RELATION` only:

```rust
let graph_entries: Vec<([u8; 32], [u8; 32])> = records
    .iter()
    .filter(|record| record.category == CATEGORY_RELATION)
    .map(|record| (record.record_id, record.record_digest))
    .collect();
```

`urdira-jsts-syntax-worker::lib.rs::proposal_relation_record` sets
`category: "relation"` for **every** `RelationKind` — `Contains`, `Import`,
and `Export` alike (`kind: format!("jsts:relation_{}", relation.kind.
identity_name())`), and the hybrid lane's `references`/`covers`/`call`/
`inherits`/`implements` rows (`semantic_sites.rs`) are also all
`category: "relation"`. So `jsts:relation_import`/`_export` **are** members
of the `graph` set — the premise that graph excludes them is false.

A relation's body (`proposal_relation_record`) is `{source_id, target_id,
classification, path, start, end}` only — no `artifact_id`/
`artifact_version_id`/`dependency_id` field exists anywhere in it, for
import/export or any other relation kind. This channel cannot carry a
dependency-salt leak even in principle.

## 4. `graph` root invariance proves every relation record is unchanged

`merkle.rs`'s own doc comment: "the record-set root (key = `record_id`,
logical = `record_digest`...)". `graph_entries` (above) and `merkle::
record_entries` (used to build the `records` root) both draw the
`(record_id, record_digest)` pair from the **same** `Vec<RecordRow>` — no
transform, no derived "logical" value (unlike `dependency_logical`, which
*is* a derived hash of `dependency_id`; `records`/`graph` use the raw
`record_digest` directly). `BucketedMerkleSet::from_sorted` is a pure,
deterministic function of its sorted `(key, logical)` input list.

Since `graph` is bit-identical (`sha256:23089a90…52ac0`) at both
measurement points, and a SHA-256 Merkle root collision between two
genuinely different leaf sets is not a real possibility, **every one of the
1,266,655 relation-category `(record_id, record_digest)` pairs — lane-1
`contains`/`import`/`export` and the hybrid lane's `references`/`covers`/
`call`/`inherits`/`implements` alike — is proven byte-for-byte unchanged**
between the `cba95efc…` measurement and today. This is a stronger,
code-independent proof than reading `resolver.rs`/`semantic_sites.rs`'s
diffs by hand, and it rules out every "resolution/ordering regression"
hypothesis at once: if reference/call/inherits/implements resolution, or
import/export target resolution, had changed for even one record, `graph`
would not match.

This also rules out P3-6's `CandidateIndex`/`ImportReverseIndex` as a
cause: those structures are consulted only by `delta.rs`'s incremental
scoping heuristics (deciding which paths need reprocessing), never by
`analyze::run_cold`/`materialize::materialize_cold` — and even if they were
wrong, their effect would show up as a relation-content difference, which
`graph`'s invariance already excludes.

## 5. Per-kind record counts, live vs. the historical (`cba95efc…`) table

`urdira-benchmark/v4-p2/p2-2h-final-cold/run1/structural` (kept on disk,
`MANIFEST` confirmed `records: sha256:a281d6a5…03987`,
`dependency: sha256:d76ff317…0987`) inspected directly with the existing
`inspect_store_record_histogram` diagnostic (no new scan needed):

```
URDIRA_V4_INSPECT_STORE=<path>/structural cargo test -p urdira-indexing-worker --release \
  v4::tests_e2e::inspect_store_record_histogram -- --ignored --nocapture
```

| Category | Kind | `cba95efc…` (P2-2b §6.4) | `a281d6a5…` (live, this session) |
|---|---|---:|---:|
| entity | `jsts:entity_callable` | 15,879 | 15,879 |
| entity | `jsts:entity_container` | 14,082 | 14,082 |
| entity | `jsts:entity_type` | 12,671 | 12,671 |
| entity | `jsts:entity_variable` | 211,909 | 211,909 |
| relation | `jsts:relation_call` | 63,989 | 63,989 |
| relation | `jsts:relation_contains` | 240,459 | 240,459 |
| relation | `jsts:relation_covers` | 383 | 383 |
| relation | `jsts:relation_export` | 2,336 | 2,336 |
| relation | `jsts:relation_implements` | 477 | 477 |
| relation | `jsts:relation_import` | 58,302 | 58,302 |
| relation | `jsts:relation_inherits` | 549 | 549 |
| relation | `jsts:relation_references` | 900,160 | 900,160 |
| **total records** | | **1,521,196** | **1,521,196** |
| dependency rows (`deps_visible_count`) | | 36,621 | 36,621 |
| artifacts interned (owners) | | 14,082 | 14,082 |

Every count is identical, digit for digit — including `deps_visible_count`
(36,621 on both sides), which is exactly the signature P3-2's own
explanation predicts for `dependency`: **same edges, different identity
encoding** (count unchanged, root changed). No record was added, removed,
or reclassified between a kind and another; the corpus itself is confirmed
byte-identical throughout this window (P3-3 §7's own mid-session/end-of-
session check, plus this task's own read-only-corpus constraint).

## 6. Conclusion: confined to entity-record digest content, mechanism not
further isolable without the missing prior artifact

Combining §4 (every relation record's `(id, digest)` pair unchanged) with
§5 (every category/kind count unchanged, including the entity kinds): the
`records` root delta cannot be a membership change (§5) and cannot be a
relation-content change (§4). By elimination it is confined to a
**digest-content-only** difference within the 254,541 entity-category
records, with their kind distribution untouched.

Reading every file each of P3-1/P3-2/P3-3/P3-6's own evidence docs declares
as touched (`state.rs`, `diff.rs`, `delta.rs`, `catalog.rs`'s
`read_current_generation`, `analyze.rs`'s `run_scoped` sharing,
`materialize.rs`'s `materialize_generation`/`OrdinalDict::from_existing`,
`deps.rs`, `publish.rs`'s `publish_delta`, `scan.rs`, `writer.rs`'s
`group_changes_by_bucket` + empty-file skip, `merkle_bucket.rs`'s `update`
rewrite) found **no code path that constructs or touches an entity
`ProposedRecord`'s body** (`name`/`kind`/`language`/`path`/`start`/`end`/
`parent_id`/`qualified_name`/`is_test`) or its identity (`stable_entity_id`,
purely `jsts:{kind}:{path}:{start}:{name}`, content-derived, no ordinal).
That construction lives exclusively in `urdira-jsts-syntax-worker::lib.rs`'s
`proposal_entity_record`, which none of these four rounds' own file lists
name. `BucketedMerkleSet::update`'s O(N²)→O(N) rewrite (P3-1 §6 bug 5) is
the one candidate that touches the merkle layer, but it modifies `update`
(the **incremental delta** path, `write_delta`'s `apply_changes_in_bucket`)
— cold's `records`/`graph`/`dependency` roots are all built via
`from_sorted` (`merkle::build`, `v4/publish.rs`'s direct call), a
completely different, unaffected function.

A secondary, adjacent finding along the way, worth flagging even though it
does not resolve the above: both `docs/evidence/2026-09-02-v4-p2-2b-cold-
pipeline.md` §3.1 and the *current* `materialize.rs` module doc (line ~55)
assert `structural_record_digest` "hashes only `record.body`" — but reading
`crates/urdira-native-core/src/lib.rs::structural_record_digest_hash`
directly shows it UCE-hashes a 10-field object (`body`, `category`,
`evidence_references`, `facets`, `identity_key`, `kind`,
`proposal_record_key`, `schema_version`, `source_span`, `universal_kind`).
This is a stale/incorrect **comment**, not a functional difference across
the window under investigation: since this function has no branch on
`category`, if it had actually widened between the two measurement points
it would have changed relation digests too, which §4 already disproves. It
predates this investigation's window (present verbatim in P2-2b's own
evidence text, describing the `cba95efc…` run) and was left unfixed here
per this task's read-only mandate outside `v4/tests_e2e.rs` diagnostics.
Worth a follow-up doc fix, not a behavior fix.

**Verdict**: this is **not a resolution/ordering regression** — §4's
graph-root proof directly rules out any change to reference/call/
inherits/implements/contains/import/export resolution, which is where such
a regression would necessarily surface. It is **not a membership/count
regression** — §5 rules that out for every kind, entity or relation. Every
currently-specified correctness invariant already holds and was
reconfirmed this session (§7): `records`/`dependency`/`graph` all match a
from-scratch oracle for create/delete/rename at both fixture and n8n scale,
and the fixture-scale cold pipeline is deterministic across independent
runs, entity and relation counts and kinds alike. The residual — some
entity record's digest changed between `cba95efc…` and `a281d6a5…` while
staying in the same kind bucket — has no identified cause in the four
rounds' own declared scope and cannot be pinned further without either the
missing pre-change git history or a surviving pre-change store, neither of
which exists. Recommend treating it as a closed, low-risk provenance
question rather than an open regression: no test asserting a real
invariant fails today, and `a281d6a5…03987` is confirmed (§8) as the
current, live, reproducible cold root.

## 7. Regression-test / quality gates

```
cargo fmt --all -- --check                                         # clean
cargo clippy -p urdira-indexing-worker --all-targets -- -D warnings # clean
cargo test -p urdira-indexing-worker                                # 66 passed, 0 failed, 3 ignored
cargo test -p urdira-structural-store -p urdira-jsts-syntax-worker \
  -p urdira-indexing-core -p urdira-native-core -p urdira-source-frontier
                                                                     # all green
```

The 3 `#[ignore]`d tests in `urdira-indexing-worker` need a real corpus
(`inspect_store_record_histogram`, `n8n_incremental_create_delete_roots_
match_oracle`, `n8n_incremental_measurement`) and were run explicitly
against the live corpus/store during this investigation (§5, §8).

One new **permanent** (non-`#[ignore]`d) diagnostic test was added:
`v4::tests_e2e::cold_scan_record_histogram_matches_category_kind_prefix_
invariant` (`crates/urdira-indexing-worker/src/v4/tests_e2e.rs`) — a
fixture-scale counterpart to `inspect_store_record_histogram` that needs no
external corpus. It asserts the two structural invariants §6's argument
depends on (every record is `category=entity` with a `jsts:entity_`-
prefixed kind, or `category=relation` with a `jsts:relation_`-prefixed
kind; `total == entity_count + relation_count` exactly, no third bucket)
and prints the fixture's own per-kind histogram, so a future investigation
of this shape has a fixture-scale reference table without needing the real
corpus at all. No production code was changed — no regression was found to
fix.

## 8. Live n8n-scale confirmation (Method step 4)

A single fresh cold scan against the read-only corpus, current `HEAD`:

```
node scripts/v4-scan.mjs ~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02 <fresh-dir>
```

```
queryable_at_ms=21462 completed_at_ms=24466
roots={"records":"sha256:a281d6a51bd4fa7eb77faed483daab6d3f846840bfc8ffe294411da037e03987",
       "dependency":"sha256:d76ff317ab6214ab78fb06bc3ec7a3fca3899417aa0ed8cdbc3090cdd8fbf987",
       "graph":"sha256:23089a905fc93cdc9506f5c8d50b97655fd97a72af73ffc9d1fb1cc92152ac0a",
       "metric":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}
```

Reproduces §15.0's pinned baseline exactly. **Authoritative current cold
roots** (unchanged by this investigation, confirmed live):

```
records:    sha256:a281d6a51bd4fa7eb77faed483daab6d3f846840bfc8ffe294411da037e03987
dependency: sha256:d76ff317ab6214ab78fb06bc3ec7a3fca3899417aa0ed8cdbc3090cdd8fbf987
graph:      sha256:23089a905fc93cdc9506f5c8d50b97655fd97a72af73ffc9d1fb1cc92152ac0a
metric:     sha256:0000000000000000000000000000000000000000000000000000000000000000
```

The scratch data dir created for this confirmation run was deleted after
use. Per the task's disk-management instruction, every `~/Proyectos/
urdira-benchmark/v4-p2/p2-2h-*` directory except `p2-2h-final-cold` was
also deleted this session (freed ~29 GB; `v4-p2` is now 5.8 GB, all under
`p2-2h-final-cold`, which was used read-only for §5's histogram and left
untouched otherwise).
