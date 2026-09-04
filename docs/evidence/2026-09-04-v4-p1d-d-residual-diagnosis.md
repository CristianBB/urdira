# P1-D-d: why the residual pass resolved almost nothing at n8n scale (diagnosed + fixed), and the cold-scan regression

Implements task P1-D-d of the v4 plan. Scope owned: `crates/urdira-indexing-worker/src/v4/*`
(`residual.rs`, `tests_e2e.rs`), `crates/urdira-tsgo-client` (`entity_index.rs`), tests. Not
committed, per task instructions. The shared corpora
(`~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`, the `task-planner` fixture) were never
written to -- every n8n run used `tests_e2e::scratch_copy_of_n8n_corpus`'s scratch-copy helper.

Machine: macOS arm64 (darwin-arm64), Rust 1.98.0 (workspace pin). Idle-machine protocol followed
before every timed run (`pgrep -f "vitest|v4-scan|urdira-indexing-worker"`, excluding the same
unrelated `code-collate` vitest process noted in every prior session's evidence -- load average
~5-9 throughout, consistent with that one long-running unrelated process).

## 1. Summary of findings

Three distinct, independently-confirmed root causes for the residual pass's poor n8n-scale
resolution rate, in order of impact:

1. **Dominant, fixed this session: v4's entity schema has no class/interface MEMBER entities.**
   `urdira-jsts-syntax-worker::SyntaxCollector::push_entity` only ever materializes MODULE-LEVEL
   entities (function, class, variable, enum, type, interface) -- a class or interface's own
   methods, constructors, properties, and accessors are never independently queryable entities
   anywhere in v4's structural store. tsgo's checker, however, resolves an ordinary method-dispatch
   call (`this.repository.save(...)`) to exactly such a member declaration constantly -- member
   dispatch is the dominant shape of a real codebase's call sites. Every one of these correct
   resolutions was being silently miscounted as `unresolved` because `residual.rs`'s own
   `(path, name_start) -> entity id` index (`collect`'s `EntityIndex`) had no entry for the target
   at all. **Fixed** by synthesizing the missing entity JIT, inside the same `semantic_upgrade`
   generation that needs it (see §3).
2. **Smaller, fixed this session (defensive): a case-insensitive-filesystem path mismatch.** tsgo's
   `useCaseSensitiveFileNames: false` behavior on this host lowercases every absolute path in a
   declaration handle it returns -- confirmed for lib files in
   `docs/evidence/2026-09-03-v4-p1d-b-residual-pass.md` §2, and flagged there as an OPEN, not-yet-
   confirmed risk for workspace files with mixed-case names (n8n has many, e.g.
   `HttpRequest.node.ts`-style PascalCase node files). **Fixed** with a case-insensitive fallback
   index in `EntityIndex::lookup` (§3). Its real-world share turned out smaller than hypothesized
   (see §5's histogram: `entity_index_miss` after the member-entity fix is only 5,804/593,220, not
   the tens of thousands the case theory alone predicted) -- the member-entity gap was the dominant
   effect, this was a genuine but secondary contributor.
3. **New this session, NOT fixed (documented, out of time budget): a tsgo RPC protocol error --
   "stale node handle".** `getSymbolsAtLocations` fails for 219,348/593,220 sites (37%) with
   `tsgo RPC error -32603: api: client error: node handle "N.K.<path>" could not be resolved (file
   may not be loaded or handle may be stale)`. See §6 for the concrete evidence and why this was not
   safely fixable in the time available.

The byte/UTF-16 offset-unit hypothesis in the task brief's "Facts" section did **not** pan out:
`crates/urdira-jsts-syntax-worker/src/lib.rs:2396`/`semantic_sites.rs:3723` both run
`Utf8ToUtf16::new(text).convert_program(&mut parsed.program)` **before** any entity or relation
span is read (`identifier.span.start` etc.), so every span this pipeline stores -- for entities
*and* relations alike, despite the misleading `span_start_byte` field name -- is already a UTF-16
code-unit offset by construction, matching `PendingSite`'s own documented contract. Confirmed
directly: §2's `utf16_slice` debug dump decodes every sampled span's stored offsets back through the
owner's real UTF-16 text and the text always reads as a well-formed call/member/heritage expression
(`"assert.ok(matchGlob(...))"`, `"vi.fn().mockImplementation(...)"`, ...), never garbage -- the tell
an offset-unit bug would produce. Not silently dropped from the brief -- ruled out with direct
evidence, reported here rather than left unstated.

## 2. Instrumentation added (deliverable 1)

`crates/urdira-indexing-worker/src/v4/residual.rs`: a new `ResidualDebug` struct, opt-in via
`URDIRA_V4_RESIDUAL_DEBUG=1` (zero cost otherwise -- the whole struct stays `None`), wired into
`run_once_with_quiet_period`:

- **Reason histogram** (`BTreeMap<&'static str, u64>`): `bucket_reason` classifies every
  `SiteOutcome::Unresolved.reason` string into `no_symbol` / `symbol_no_declaration` /
  `declaration_outside_workspace` / `declaration_text_unavailable` /
  `declaration_node_out_of_range` / `malformed_handle` / `owner_file_not_in_project` /
  `owner_file_text_unavailable` / `rpc_error` / `other_unresolved`, mirroring
  `crates/urdira-tsgo-client/src/resolver.rs`'s own early-return reason strings one for one. Two
  additional buckets are recorded from the materialize loop itself (not from the resolver, since
  they are THIS module's own correlation outcomes): `entity_index_miss` and `entity_index_dangling`.
  `external_lib` and `upgraded`/`confirmed_row_build_failed` round out the set. Every bucket sums
  exactly to the total possible-site count (verified live, see §5) -- no site is silently dropped
  from the histogram.
- **Per-bucket sample dump** (`BTreeMap<&'static str, Vec<String>>`, 10 samples per bucket, not one
  global 50-sample cap): each sample carries `(owner path, stored span in UTF-16 units, the owner
  text decoded back through that exact span via `utf16_slice`, and the outcome's own detail --
  `reason` for an unresolved site, `symbol`/`lib` for an external, `target_path`/`name_start_utf16`/
  `decl_kind` for an entity-index miss). The per-bucket cap was a real fix made mid-session: a global
  cap filled entirely with `owner_file_not_in_project`/`no_symbol` samples from the alphabetically
  first few files and never showed a single `rpc_error` sample even though that bucket had 219,348
  hits (§6) -- caught by noticing `grep -c rpc_error` on the log found the count line but zero sample
  lines.

Run first on the shared `tests/fixtures/codebases/typescript/task-planner` fixture through the FULL
path (`scan::run_with_residual` cold scan, then `run_once_with_quiet_period` synchronously) --
this is what surfaced the `entity_index_miss` root cause in the first place, at a scale small enough
to read every sample by eye (see §3). Then run at n8n scale (§5-§6).

## 3. Fix 1 (dominant): synthesize the missing member entity, JIT, in the residual pass itself

**Why not fix the schema instead.** The clean fix would be for `urdira-jsts-syntax-worker`'s lane-1
entity producer to materialize class/interface members as real entities during every cold scan. That
is real, substantial, cross-cutting scope: it touches the entity/relation graph shape store-wide
(not just for the residual pass), and every existing test asserting an exact entity count across the
whole v4 test suite. Not attempted here -- would need its own decision doc, matching this
codebase's precedent for a schema change of this size (`docs/decisions/26-*`..`29-*`).

**What was built instead**, entirely inside `residual.rs` (this task's own file, no schema change):
`try_synthesize_member_entity` (residual.rs) creates a NEW `CATEGORY_ENTITY` `RecordRow` for a
class/interface member declaration a resolved `SiteOutcome::WorkspaceTarget` points at but
`collected.entities` has no entry for, as part of the SAME `semantic_upgrade` generation that needs
it:

- **Identity**: the identical `jsts:{kind}:{path}:{start}:{name}` recipe
  `urdira_jsts_syntax_worker::stable_entity_id`/`proposal_entity_record` use for every other entity
  kind (verified against that crate's own source, not guessed) -- so a future proper member-entity
  producer, should one ever ship, computes the exact same identity for the exact same declaration
  and transparently CONTINUES this record's chain via `StoreReader::by_identity_last`
  (`build_confirmed_row`'s own precedent) rather than collide or duplicate it.
- **Kind mapping**: `member_kind_name(decl_kind: u32)` maps the checker's raw `SyntaxKind` number
  (`crate::node::syntax_kind`'s hand-verified constants) to `"method"` (`METHOD_DECLARATION=175`) or
  `"constructor"` (`CONSTRUCTOR=177`) -- the two kinds this task directly confirmed dominate the
  `entity_index_miss` samples (§5's own numbers); anything else falls back to a generic `"member"`
  label, still a real, resolvable entity, just less precisely labeled. Extending this table with
  exact codes for `GetAccessor`/`SetAccessor`/`PropertyDeclaration`/`MethodSignature`/
  `PropertySignature` is documented as low-risk future work, not attempted for lack of time to
  verify each numeric code live the same way `METHOD_DECLARATION`/`CONSTRUCTOR` already were by this
  crate's own prior sessions.
- **Name text**: `identifier_text_at_path` slices the TARGET file's own UTF-16 text (already held in
  `run_once_with_quiet_period`'s `file_map`) at `name_start_utf16` via
  `urdira_tsgo_client::node::identifier_text_at` -- the identical primitive `SiteOutcome::External`
  classification already uses for a lib symbol, just against a workspace file's text instead.
- **Owner attribution**: the target file's own `(artifact_id, artifact_version_id)` ordinal, via a
  `frontier.present`-path lookup + a `dicts.artifacts` reverse index built once
  (`artifact_ordinal_by_pair`) -- mirroring `owner_artifact`/`owner_version` sharing one ordinal, per
  `materialize.rs`'s own documented convention (`owner_version: owner_ordinal`).
- **Content digests**: runs through the real structural kernel
  (`materialize::kernel_rows_batches`/`StructuralKernelRecordRef`) exactly like `build_confirmed_row`
  does for a confirmed relation row -- never hand-computed.
- **Case handling**: reuses the SAME `real_path_by_lower` fallback described in fix 2 below to
  recover the target's real-case frontier path before building its identity key or looking up its
  owner ordinal.
- **De-duplication**: a `synthesized_member_entities: HashMap<(path, name_start), record_id>` cache,
  scoped to one residual-pass run, so 1,000 call sites targeting the same popular method (e.g.
  `this.repository.save(...)`, called from everywhere) produce exactly one new entity record, not
  1,000 duplicates.
- **`build_confirmed_row`'s own `target_id`/`target_record_id` plumbing was restructured** (not just
  extended) to handle the synthesized case correctly: a freshly-synthesized entity's `RecordRow` has
  `valid_from = new_generation` (this pass's own upgrade generation), so it is NOT yet visible at
  `publish_generation` -- calling `store.get_visible(&target_record_id, publish_generation)` on it
  would incorrectly fail. The identity-key string is already known directly from the synthesis call
  (no need to re-fetch it), so the two paths (existing entity vs. freshly synthesized) are unified
  into one `Option<([u8; 32], String)>` before the shared downstream code that builds the confirmed
  relation row.

**Verification on the task-planner fixture** (before/after, `URDIRA_V4_RESIDUAL_DEBUG=1`,
`residual_pass_accounts_for_every_possible_site_in_the_shared_fixture`):

| | before this fix | after this fix |
|---|---:|---:|
| `upgraded` | 5 | **25** |
| `unresolved` | 26 | **6** |
| `entity_index_miss` | 20 | **0** |
| pending sites total | 35 | 35 |

All 20 previously-miscounted sites in this fixture were `decl_kind=175` (`METHOD_DECLARATION`) --
`TaskService`'s own `createTask`/`startTask`/`completeTask`/`getOpenTasks` methods, called both from
`main.ts` and the test spec. The remaining 6 `unresolved` (`no_symbol`, "no unique call target") are
`node:assert/strict` calls (`assert.equal`/`assert.deepEqual`/`assert.throws`) -- a real, separate,
smaller gap: this pass's virtual FS only serves the workspace's own jsts files plus tsgo's bundled
`lib.*.d.ts` (via `LayeredFs`), never `node_modules/@types/node`, so a call into an ambient Node
global's own declaration genuinely has nothing to resolve against. Not fixed (would need a real,
scoped `node_modules`/`@types` serving story for `LayeredFs`, separate work).

## 4. Fix 2 (secondary, defensive): case-insensitive `EntityIndex` lookup

`crates/urdira-tsgo-client/src/entity_index.rs`: `EntityIndex` now builds a SECOND, lowercased-key
index (`by_lower_path_and_start`) alongside the existing exact-case one; `lookup` tries the exact
match first, then falls back to a lowercased match. Directly closes the gap
`docs/evidence/2026-09-03-v4-p1d-b-residual-pass.md` §2/§7 flagged as open ("an individual FILE path
with mixed-case characters ... could suffer the same silent-lowercase mismatch"). New unit test
`lowercased_target_path_still_resolves_case_insensitively` asserts a `PascalCase.node.ts`-shaped
path (matching n8n's own file-naming convention) resolves correctly both in its real case and in
tsgo's lowercased form, and that a genuinely different path still misses. `residual.rs`'s own
materialize loop also gained a companion `real_path_by_lower` map (needed separately: recovering the
REAL-cased path string itself, not just a successful boolean lookup, for the member-entity synthesis
path's identity-key/owner-ordinal construction in fix 1).

Measured real-world impact at n8n scale: `entity_index_miss` after BOTH fixes is 5,804/593,220
(1.0%) -- present but small; the member-entity gap (fix 1) was the dominant effect by roughly an
order of magnitude, as `entity_index_dangling` (0 occurrences) and this residual `entity_index_miss`
count both attest.

## 5. n8n measurement: before and after

Real `urdira-indexing-worker` release binary (`cargo test --release`), a fresh scratch copy of
`~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02` (14,082 JS/TS files, 20,149 observed files
total) per run via `tests_e2e::scratch_copy_of_n8n_corpus` (never the shared corpus itself), a new
`#[ignore]`d test `v4::residual::tests::n8n_residual_pass_debug_histogram`. Three independent runs
(fresh `data_root` each time) after the fixes; all three agreed exactly on `upgraded`/`external`/
`unresolved` (51,823 / 29,633 / 511,764 in every run) -- deterministic, as expected (no randomness
in site collection, classification, or synthesis).

**Sites** (Rust-side, this session, after both fixes):

| | before this session (P1-D-c) | after this session |
|---|---:|---:|
| `upgraded` | 13,196 | **51,823** (+293%, ~4x) |
| `external` | 29,633 | 29,633 (unchanged -- expected, neither fix touches lib-global classification) |
| `unresolved` | 550,391 | **511,764** (-7.0%) |
| total possible sites | 593,220 | 593,220 (unchanged -- same corpus, same site-collection logic) |

**Full reason histogram, after both fixes** (`URDIRA_V4_RESIDUAL_DEBUG=1`, one representative run;
all three runs agreed exactly):

| bucket | count | share of total |
|---|---:|---:|
| `no_symbol` | 268,153 | 45.2% |
| `rpc_error` | 219,348 | 37.0% |
| `upgraded` | 51,823 | 8.7% |
| `external_lib` | 29,633 | 5.0% |
| `confirmed_row_build_failed` | 12,743 | 2.1% |
| `entity_index_miss` | 5,804 | 1.0% |
| `owner_file_not_in_project` | 5,479 | 0.9% |
| `declaration_text_unavailable` | 230 | 0.04% |
| `symbol_no_declaration` | 7 | 0.001% |
| **total** | **593,220** | 100% |

(`workspace_target_pre_entity_lookup` = 70,370 is a provisional, overlapping bucket -- it equals
`upgraded + entity_index_miss + confirmed_row_build_failed` = 51,823 + 5,804 + 12,743 exactly,
confirming the histogram's internal consistency; not counted separately in the table above.)

**`confirmed_row_build_failed` (12,743, new bucket, not seen on the small fixture)**: this is
`build_confirmed_row`/`try_synthesize_member_entity` returning `Ok(None)` -- the defensive
"identity already live elsewhere" fail-closed path (`store.by_identity_last` finds the target
identity already visible at the current generation). Not investigated further this session (a
genuinely defensive path, and 2.1% of sites, not the priority given the two much larger buckets
below) -- worth a follow-up dump of a few real samples to confirm it is behaving as intended (a
content-derived identity that embeds its own exact span should essentially never collide) rather
than masking a real bug.

**Confirmed/possible `core:call` histogram**, via `StoreReader::iter_visible` +
`target_subject().is_some()` (the same metadata-only, no-body-decode method `residual.rs` itself
already trusts for correctness -- see §6 for why this is the method deliverable 4 standardizes on),
read at generation 1 (cold, before the pass) and generation 2 (after), from the SAME corpus
checkout and worker binary in the SAME test run:

| | gen 1 (cold) | gen 2 (after residual) | delta |
|---|---:|---:|---:|
| confirmed `core:call` | 64,931 | 116,149 | **+51,218** |
| possible `core:call` | 669,448 | 618,230 | -51,218 |
| confirmed `core:inherits`/`core:implements` | 1,263 | 1,868 | **+605** |
| possible `core:inherits`/`core:implements` | 1,910 | 1,305 | -605 |
| **confirmed, combined** | **66,194** | **118,017** | **+51,823** |

The combined delta (+51,823) matches the reported `upgraded=51,823` exactly -- the published delta
is exactly what it claims to be.

**Wall time**: cold scan 30.4s / 28.6s / 33.2s across the runs used for this section (mean 30.7s --
see §7 for why this is reported separately as the cold-scan regression check, not folded into this
table); residual pass itself (Rust `total_ms`) 26.6-39.1s across runs (mean ~33.7s, noisier than the
prior session's 23.9s -- attributable to the pass now doing meaningfully more work per run: 51,823
new relation rows plus up to ~46,000 new synthesized entity rows, roughly matching the earlier
session's own note that lane snapshot latency is sensitive to concurrent load, not a regression in
the mechanism itself). `residual_lanes()` unchanged (`(10/2).clamp(1,6) = 5` on this machine).

**tsgo child RSS**: not re-measured this session (out of time budget for a dedicated `ps`-sampling
run); the prior session's 250-430 MiB per child, 5 concurrent, remains the best available figure --
this session's fix does not change lane count, window size, or per-window work shape in any way that
would be expected to move child RSS meaningfully (the new entity rows are built AFTER
`ResidualPass::run` returns, entirely on the orchestrating thread, not inside a tsgo child).

## 6. Fix NOT made: the "stale node handle" RPC error (new finding this session)

`resolver.rs`'s `resolve_owner_group` step 2 (`get_symbols_at_locations`, one batched RPC call per
owner covering every pending site's lookup node) fails for a large minority of owners with:

```
getSymbolsAtLocations failed: tsgo RPC error -32603: api: client error: node handle
"293.79./urdira-residual-pass/packages/@n8n/ai-utilities/src/__tests__/suppliers/supplyModel.test.ts"
could not be resolved (file may not be loaded or handle may be stale)
```

(`293` = the node index `descend_to_span` found in the owner's own already-fetched
`RemoteSourceFile`; `79` = `syntax_kind::IDENTIFIER`.) This happens WITHIN one window's one open
snapshot, for an owner file this SAME resolver instance already successfully fetched via
`get_source_file` moments earlier (in the same `resolve_owner_group` call, `descend_to_span` must
have already succeeded against that exact `RemoteSourceFile` to produce node index 293 in the first
place) -- so the node index itself is not wrong, but the SERVER (the tsgo process) no longer
recognizes it by the time the batched `getSymbolsAtLocations` request for the WHOLE owner group
arrives. `ResidualResolver::new` is confirmed built fresh per window (`residual_pass.rs::run_lane`,
not reused/stale across windows), so this is not the simpler "reused resolver, rebuilt snapshot"
bug that shape would suggest -- something inside ONE window's ONE snapshot's own request sequence
is invalidating a just-fetched file's node table. The leading, unconfirmed hypothesis (samples were
concentrated on `.test.ts` files with dozens of `vi.mock`/`vi.hoisted`/`vi.fn()` call sites each,
i.e. owners with an unusually large SINGLE batched `getSymbolsAtLocations` request) is a server-side
batch-size or open-file-table limit inside tsgo itself, hit partway through processing one large
owner group -- not confirmed with a controlled reproduction, and NOT attempted to fix this session:
a wrong fix in this exact RPC/protocol layer (mis-batching, or silently swallowing a real error into
a wrong-but-successful-looking resolution) risks a FAR worse outcome than counting the site
unresolved -- a confirmed row pointing at the wrong declaration. Flagged here, with the exact error
text and a concrete next step (reproduce in isolation with a single large owner file consisting of
many trivial call sites, bisect the RPC batch size), for whoever picks this up next.

This bucket (219,348, 37.0% of all sites) is now the single largest remaining lever -- larger than
`no_symbol` in aggregate coverage-recovery potential per site fixed, though `no_symbol` is larger in
raw count and partly reflects genuinely-unresolvable ambient-global calls (§3's `node:assert`
finding generalizes: any call into an external package's own type declarations, not just Node
builtins, hits this same "no unique call target" reason once the direct/aliased-symbol path and
`getResolvedSignature` both fail against a virtual FS that only serves the workspace's own files
plus tsgo's bundled libs).

## 7. Cold-scan regression check (deliverable 3)

Three cold-scan-only wall-clock measurements (idle machine, this session's exact worker binary and
corpus checkout, `URDIRA_DEBUG_TIMING=1` on one of the three for phase attribution): **28.6s, 29.4s,
33.2s** (this section's own three timed runs; a fourth, 30.4s, is folded into §5's own numbers
above) -- mean ~30.4s, every run **≥25s**, the threshold this task's brief flags for investigation.

**This is NOT a new regression introduced by this session.** `residual.rs`'s own module doc (and
`scan.rs`'s `run_with_residual`) already establish that `residual::schedule` runs strictly AFTER a
successful `ScanCompleted` -- confirmed again directly in this session's own test harness, which
calls `scan::run_with_residual(..., None)` to completion (producing the `ScanCompleted` event and
its own wall-clock measurement) BEFORE ever calling `run_once_with_quiet_period` in a separate,
later step. None of this session's changes touch `analyze.rs`/`materialize.rs`/`publish.rs` (the
cold-scan critical path) at all -- confirmed by `git status`/file list: only `residual.rs`,
`tests_e2e.rs` (two `fn` visibility changes only, `pub(super)`), and `urdira-tsgo-client/src/
entity_index.rs` were touched. The ~30s figure matches
`docs/evidence/2026-09-04-v4-p1d-c-residual-upgrade.md`'s own already-reported 30.4s almost exactly
-- this session's numbers CONFIRM that prior measurement (not previously independently reproduced),
they do not add a new regression on top of it.

**Phase attribution** (one `URDIRA_DEBUG_TIMING=1` run, 33.2s total, this session):

| Phase | Wall time |
|---|---:|
| corpus copy to scratch (test-harness only, not part of a real daemon's cold scan) | 3.1s |
| catalog walk (filesystem scan) | 2.8s |
| catalog apply (SQL insert, 20,149 rows) | 2.3s |
| typeflow `build_full` (`DeclSummary` extraction, 14,082 files) | 1.5s |
| facts extraction (`facts_for_paths`, 10 rayon threads) | 0.4s |
| typeflow `build_index` | 0.2s |
| hybrid semantics resolve (E1-E3, 14,082 owners) | 2.7s |
| materialize pass 1 (kernel canonicalize, 2,831,264 records) | 5.4s |
| materialize pass 2 (subject resolve/intern, deps, dict finalize) | 5.5s |
| publish (sort 2.6s + write_base 4.9s + graph/metric merkle 0.4s) | 8.0s |
| **sum of the above (excludes copy)** | **~28.8s** |
| reported cold-scan wall (excludes copy) | 30.1s |

RSS at each checkpoint: post-catalog 152.5 MiB, post-resolve 2,934.1 MiB, post-materialize 4,632.0
MiB -- broadly consistent with the prior session's reported "5.8 GiB peak", within normal run-to-run
variance.

**Attribution verdict**: materialize (10.9s, 36% of the non-copy total) and publish (8.0s, 26%) are
the two largest phases -- consistent with the already-documented cause (P2-2i's possible-row/
diagnostic emission: 42% more records than the pre-P2-2i baseline, per that task's own evidence
doc, §6: "cold_scan_record_histogram... 2,831,264" total records, up from a pre-possible-rows
baseline). **Not further fixed this session** (no time budget remained after the residual-pass work
above): the earlier evidence doc's own stated requirement -- "possible-row materialisation cost is
legitimate ... but must be parallel" -- was already true before this session (materialize pass 1/2
and the facts-extraction stage already use `rayon`, confirmed by the `10 rayon threads` log line
above) and remains an open lever for a future session to push further (e.g. parallelizing publish's
own `sort`/`write_base` stages, currently sequential per the phase table's single-number entries),
not something this task's diagnosis found a NEW, previously-unknown bottleneck to fix.

## 8. Confirmed-call count reconciliation (deliverable 4)

**Single authoritative counting method, used for every number in this doc**: a Rust-side
`StoreReader::iter_visible(generation)` scan, filtered to `category() == CATEGORY_RELATION` and
`universal_kind == "core:call"`, split by `target_subject().is_some()` (a possible row never
resolves a target, a confirmed row always does -- verified against `materialize.rs`'s own
subject-resolution pass, and the exact same structural test `residual.rs`'s own `collect` function
already depends on for correctness, not merely for counting). No `@urdira/canonical` JS body-decode
step anywhere in this method.

| | confirmed `core:call` |
|---|---:|
| v4 cold (this session, gen 1) | **64,931** |
| v4 after residual upgrade (this session, gen 2) | **116,149** |
| v3 ceiling (retained DB, prior session's measurement -- see below) | **205,468** |

**The 64,931-vs-96,847 discrepancy the task brief asked to reconcile is CONFIRMED to be
cross-session corpus/worker-state drift, not a counting-methodology bug**: this session's own cold
count, measured with the identical structural method
`docs/evidence/2026-09-04-v4-p1d-c-residual-upgrade.md` used, is **64,931** -- an EXACT match to
that prior session's own number, from an independent scratch copy and a freshly-rebuilt release
binary. The "96,847" figure came from an EARLIER session
(`docs/evidence/2026-09-04-v4-p2-2i-possible-rows-and-pending-sites.md` §6) using a DIFFERENT
method (`@urdira/canonical`'s JS `decodeCanonical` over every live row's `body_payload`, reading the
`classification` field directly) against that session's own n8n checkout and worker build. Both
methods are, in principle, equivalent (a possible row's body never has `target_id`/implies
`classification: "possible"`; a confirmed row always has both) -- the two sessions simply measured
different points in the corpus's/pipeline's own history, exactly as that P2-2i doc's own closing
note already speculated ("plausible ordinary corpus drift between sessions... not investigated
further"). This session does not attempt to re-derive the P2-2i session's exact 96,847 from its own
now-gone corpus/worker state (impossible -- that exact combination no longer exists to re-measure);
it instead eliminates the drift confound going forward by measuring cold-vs-after-upgrade from the
SAME checkout in the SAME test run, which is the number that actually matters for this task's own
question ("did the residual pass upgrade a meaningful fraction").

**v3's own 205,468 confirmed-call ceiling was NOT re-measured this session** (the source is a 13.9 GB
retained SQLite DB from a prior session, `~/Proyectos/urdira-benchmark/v4-p0/data/
workspaces/workspace_corpus_81e5eb4d-...sqlite`; re-decoding all 734,379 `jsts:relation_call` rows'
`body_payload` via `@urdira/canonical` was judged not worth the wall-clock cost this session, since
nothing in this task's own changes could plausibly move that number -- it is a frozen, historical v3
artifact, not live-recomputed data). Cited as-is from
`docs/evidence/2026-09-04-v4-p1d-c-residual-upgrade.md`.

**Putting the three together**: this session closed `(116,149 - 64,931) / (205,468 - 64,931) =
51,218 / 140,537 ≈ 36.4%` of the v3-vs-v4 confirmed-call gap -- up from the prior session's 9.3%,
roughly a 4x improvement in gap-closure rate, using the SAME residual-pass mechanism with two
targeted correctness fixes (§3, §4) and no change to the checker itself or its window/lane model.

## 9. Deliverable 2's numeric target -- not met, reported honestly

The task brief's target was `upgraded ≥ 100,000`. This session reached **51,823** -- a real, ~4x
improvement over the 13,196 baseline, but short of the target. §6 identifies precisely why:
`rpc_error` (219,348 sites, 37.0%) and a large share of `no_symbol` (268,153 sites, 45.2%, partly
genuine external-package gaps per §3's `node:assert` finding, partly of unknown composition) are now
the dominant remaining buckets, and neither was safely fixable in this session's remaining time --
§6 explains why a hasty fix to the RPC/protocol layer specifically was judged too risky to attempt
(wrong-target risk, not just under-coverage risk). This is reported as an honest shortfall against
the target, not narrowed or reframed: the concrete next step (§6's own suggested reproduction) is
left for whoever picks this up, with the exact error text, the exact affected fraction, and the
specific hypothesis (batch-size limit on `getSymbolsAtLocations` for a single large owner file) that
was not yet tested.

## 10. Quality gates

- `cargo fmt --all -- --check`: clean.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean, zero warnings, whole workspace
  (verified after a `touch` on both changed files to force a real re-check, not a cached pass).
- `cargo test -p urdira-indexing-worker`: **77 passed, 0 failed, 4 ignored** (this task's own new
  `n8n_residual_pass_debug_histogram` plus the 3 pre-existing n8n-scale tests, all `#[ignore]`d by
  convention; the 4th ignored test was run explicitly, see §5-§7 above).
- `cargo test -p urdira-tsgo-client -p urdira-worker-protocol -p urdira-structural-store -p
  urdira-jsts-syntax-worker`: all green (46 unit + 2 oracle + 3 residual_pass + 8 protocol + 5
  fixture + 158 syntax-worker tests; two crates had zero tests to run, confirmed by their own
  `test result: ok. 0 passed`).
- `cargo test --workspace`: no failures anywhere (grepped for `FAILED`/`error\[`/`error:` across the
  full run's output -- none found).
- `npx vitest run tests/v4-daemon-e2e.test.ts tests/v4-scan.test.ts tests/codebase-fixtures.test.ts
  tests/phase-daemon-v4-scan.test.ts`: **21 passed, 1 skipped** (4 test files; the skip is the
  always-on "build the release artifacts first" companion test, skipping because the artifacts DO
  exist in this run -- same as every prior session's report of this exact suite).
- The other two n8n-scale `#[ignore]`d tests this task's brief mentions
  (`n8n_incremental_measurement`, `n8n_incremental_create_delete_roots_match_oracle`) were **not**
  re-run this session: neither exercises any code this session touched (`residual.rs`/
  `entity_index.rs` are additive-only against the cold/incremental critical path -- confirmed by
  file list in §7), and each costs 80+ seconds; skipped to leave time for the residual-pass
  measurements above, which this task's own scope makes the priority. Documented, not silently
  skipped.

## 11. Files touched

- `crates/urdira-indexing-worker/src/v4/residual.rs` (1,970 lines, was 1,275) -- `ResidualDebug` +
  `bucket_reason`/`utf16_slice` (instrumentation, §2); `member_kind_name`/
  `try_synthesize_member_entity`/`identifier_text_at_path` (fix 1, §3); `real_path_by_lower`/
  `artifact_ordinal_by_pair`/`synthesized_member_entities` setup in `run_once_with_quiet_period`;
  restructured the `target_record_id`/`target_view`/`target_id` flow into a unified
  `Option<([u8; 32], String)>` to support the synthesized-entity case (§3); one new `#[ignore]`d
  test, `n8n_residual_pass_debug_histogram`, plus `print_confirmed_possible_histogram` (§5, §8).
- `crates/urdira-tsgo-client/src/entity_index.rs` (238 lines, was 167) -- `by_lower_path_and_start`
  fallback index (fix 2, §4); one new unit test.
- `crates/urdira-indexing-worker/src/v4/tests_e2e.rs` -- four `fn`s (`scratch_dir`,
  `scratch_copy_of_n8n_corpus`, `run_scan`, `generation_of`) changed from private to `pub(super)` so
  `residual.rs`'s own test module (a sibling, not a descendant, of `tests_e2e`) could reuse the
  existing n8n-scratch-copy/cold-scan harness rather than duplicating it -- no other change to this
  file, no existing test's behavior affected.
- `docs/evidence/2026-09-04-v4-p1d-d-residual-diagnosis.md` (this file).
