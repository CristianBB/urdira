# P1-D-g: residual-pass correctness — classification mismatch, confirmed_row_build_failed, rpc_error bisection, external_lib policy

Implements task P1-D-g of the v4 plan (residual pass correctness). Scope owned this session:
`crates/urdira-tsgo-client`, `crates/urdira-indexing-worker/src/v4/{residual,diff,delta}.rs`,
`scripts/v4-call-parity-diff.mjs`, tests. Not committed, per task instructions.
`crates/urdira-native-core`, `crates/urdira-jsts-indexing-engine`,
`crates/urdira-jsts-native-projection`, `crates/urdira-jsts-syntax-worker` (facts types),
`crates/urdira-indexing-worker/src/v4/{materialize,analyze,publish,catalog}.rs`,
`crates/urdira-structural-store`, and `crates/urdira-indexing-worker/src/main.rs` were read for
understanding only, never edited (owned by the concurrent P2-2l agent this session, or otherwise
outside this task's own file list). The shared corpus
(`~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`) and the retained v3 DB
(`~/Proyectos/urdira-benchmark/v4-p0/data/workspaces/workspace_corpus_81e5eb4d-...sqlite`) were
never written to — every n8n run used `tests_e2e::scratch_copy_of_n8n_corpus`'s scratch-copy
helper, and the v3 DB was opened `readOnly: true`.

Machine: macOS arm64 (darwin-arm64), Rust 1.98.0 (workspace pin), Node 24.18.1. Idle-machine
protocol (`pgrep -f "vitest|v4-scan|urdira-indexing-worker"`, excluding the same long-running
unrelated `code-collate` vitest process every prior session in this series has noted) checked clean
before every timed n8n run.

## 1. Summary

| | before this session | after this session | target |
|---|---:|---:|---:|
| `v4_confirmed_same_target` | 89,707 (43.66%) | **112,565 (54.78%)** | ≥ 120,000 |
| `v4_confirmed_different_target` | 0 | **0** | ≈ 0 |
| `v4_missing_site` | 0 | **0** | ≈ 0 |
| `confirmed_row_build_failed` | 15,590 | **0 (not observed)** | ≈ 0 |
| classification mismatches (store-wide invariant) | 31,917 (cold, this session's own fresh measurement) | **891 (after residual pass)** | 0 |
| `rpc_error` | 13,737 | **13,737 (unchanged)** | ≈ 0 |

**Two of four numeric targets were reached exactly** (`different_target`, `missing_site`, both
still 0) and a third (`confirmed_row_build_failed`) was driven from 15,590 to a bucket that no
longer appears in the histogram at all. **`same_target` improved substantially (+22,858 sites,
+11.1 percentage points) but did not reach the 120,000 target.** **`rpc_error` was investigated in
depth (a live bisection plus a tried-and-reverted fix, §3) but not reduced** — reported honestly.
The classification-mismatch invariant dropped 97.2% but is not exactly 0 (§2.4).

Items 1 and 2 turned out to be manifestations of the **same root cause**: a possible relation row
whose body already claims a resolved target (`classification: "confirmed"` + `target_id`, written
by `semantic_sites.rs`'s E1-E3 typeflow lane) but whose `target_subject` was never interned by
`materialize.rs`'s subject-resolution pass (neither file owned this session). When the residual
pass's checker re-resolves such a site to the SAME target, the freshly-computed confirmed identity
is byte-identical to the row it is trying to supersede, and `build_confirmed_row`'s own dedup guard
mistook "the exact row I am about to close" for "a different row already occupies this identity" —
failing closed on every one of these sites (item 2's `confirmed_row_build_failed`). Fixing that
self-collision (§2.2) closed a large fraction of item 1's own inconsistent population as a direct
side effect, which is why both items are reported together here.

## 2. Item 1 + item 2: classification mismatch and `confirmed_row_build_failed`

### 2.1 Diagnosis: which producer, and why

The query layer (`packages/engine/src/canonical-query-data-port.ts:1432`,
`relationClassification`) reads `record.body["classification"]` directly — it has **no access at
all** to the store's own `target_subject` metadata (`query-record-decode.ts`'s `RecordRow` shape
carries only `body_payload`/`value_rows`, never a target-subject flag). This is not itself a bug in
the query layer: every producer this codebase has writes `body.classification` consistently with
its own identity's `{target|unresolved}` suffix at creation time (verified against
`semantic_sites.rs`'s `possible_call_record`/`call_proposed_record`/`heritage_proposed_record` and
this module's own `build_confirmed_row`/`build_corrected_possible_row`) — so the query layer
*trusting* body is fine **as long as every producer's identity and store state stay in agreement**.

The bug is that they do not, for a real subset of rows. `semantic_sites.rs`'s E1-E3 typeflow lane
(`call_proposed_record`, out of this session's ownership) writes `classification: "confirmed"` +
`target_id` into `body`, and encodes that same resolved target into the row's own identity
(`jsts:call:{path}:{start}:{end}:{source_id}:{target_id}`), at the moment it believes a call
resolves with checker-grade confidence — **before** `materialize.rs`'s own subject-resolution pass
(also out of ownership) has a chance to intern that target into `target_subject`. When the target is
a class/interface MEMBER (the dominant case, per P1-D-d's own root cause: v4's entity schema has no
member entities), that interning step has nothing to find, `target_subject` stays `None`, and the
row is stuck: its identity and body both say "confirmed", but the store's own authoritative signal
says "possible".

**Fresh measurement, this session, cold generation** (`count_classification_mismatches`, §2.3):
**31,917** such rows on the n8n corpus — comparable to the ~29K figure P1-D-f reported for an
earlier corpus/build state, confirming this is a real, reproducible population, not a one-off
artifact.

### 2.2 Item 2's own root cause: the SAME mismatch colliding with itself

`build_confirmed_row`'s dedup guard was:

```rust
Some(last) if last.is_visible(generation) => {
    // Already live somewhere -- ... fail closed rather than risk a duplicate.
    return Ok(None);
}
```

When the residual pass's checker resolves a classification-mismatched site to the SAME target
`semantic_sites.rs` already believed (the common case — typeflow is usually right), the freshly
computed confirmed identity is **byte-identical** to the mismatched row's own identity.
`store.by_identity_last` therefore finds — not a different row — but `predecessor` itself (the very
row this call is trying to supersede), still live (of course; it is currently the live occurrence),
and the guard bailed with `Ok(None)`, counted by the caller as `confirmed_row_build_failed`. This
population was flat at 15,590 across every prior session (P1-D-d, P1-D-e, P1-D-f all reported it
unchanged) — consistent with it being a distinct, structural bug rather than noise.

**Fix** (`crates/urdira-indexing-worker/src/v4/residual.rs`, `build_confirmed_row`): only fail
closed when a **different** record occupies the identity:

```rust
Some(last) if last.is_visible(generation) && last.record_id() != predecessor.record_id() => {
    return Ok(None);
}
Some(last) => {
    // supersede-and-chain, unchanged
}
```

### 2.3 Item 1's own fix: recover more mismatched sites, and repair the unfixable ones

Two changes, both in `collect()`/the materialize loop:

- **Generalized `collect()`'s `source_id` recovery.** The existing identity-parsing fallback (added
  in P1-D-f) only handled a genuinely-possible row's fixed `:unresolved` suffix. Extended to also
  parse the mismatched shape (`{source_id}:{target_id}`, both 5-colon-field
  `jsts:{kind}:{path}:{start}:{name}` compound ids — `declaration_id`/`stable_entity_id`'s own
  shared recipe): split the remainder into exactly 10 tokens, first 5 as `source_id`. This recovers
  mismatched sites whose `source_subject()` ALSO fails to resolve (e.g. a member calling another
  member) that would otherwise be silently invisible to the residual pass entirely, mirroring
  P1-D-f's own `:unresolved`-suffix fallback for the ordinary case. Each `PendingMeta` now carries a
  `was_mismatched: bool` flag.
- **`repair_mismatched_row_if_needed`/`build_corrected_possible_row`** (new): when a mismatched
  site's checker attempt does NOT resolve to a workspace target (`External`/`Unresolved` outcome),
  republishes it under the CANONICAL, self-consistent "possible" identity
  (`possible_call_record`'s own `jsts:call:{path}:{start}:{end}:{source_id}:unresolved` recipe,
  reimplemented here for the same crate-isolation reason `delta.rs`/`publish.rs` already document),
  closing the old inconsistent row. Never destructive: the corrected row is an ordinary possible row,
  fully eligible for a future residual pass to upgrade normally.
- **`is_classification_consistent`/`count_classification_mismatches`** (new, pure + store-scanning):
  the invariant itself, computed **without any body decode** — a relation's identity already
  encodes whether its OWN producer believed the target resolved (the `:unresolved` suffix or not),
  so comparing that against `target_subject().is_some()` is exactly equivalent to comparing against
  `body.classification`, with no `@urdira/canonical` dependency needed in Rust. Wired into
  production logging (`URDIRA_V4_RESIDUAL_DEBUG=1` now also prints
  `classification_mismatches_remaining=N`) and into the n8n diagnostic test
  (`print_classification_mismatch_count`, printed at both COLD and AFTER generations).

### 2.4 Measured effect (n8n, one clean run, both fixes applied together)

| | COLD (before residual pass) | AFTER (this session's residual pass) |
|---|---:|---:|
| classification mismatches | 31,917 | **891** (−97.2%) |
| `core:call` confirmed (target_subject) | 64,931 | **148,033** |
| `core:call` + heritage confirmed, combined | 66,194 | **149,901** |
| `upgraded` (Rust-side) | — | 83,707 |
| `confirmed_row_build_failed` | — | **not observed** (0) |
| `classification_mismatch_repaired` (new bucket) | — | 8,112 |

The 891 residual mismatches were **not fully decomposed this session** (out of budget) — the
leading candidates, in order of likely share: (a) heritage relations (`inherits`/`implements`),
deliberately excluded from both the `collect()` source-id fallback and the repair step (matching
P1-D-f's own scoping decision — heritage's identity literal was not independently re-verified this
session either); (b) mismatched sites whose identity's remainder does not split into exactly 10
colon-tokens (a name segment containing a literal `:`, e.g. certain computed/string-literal property
keys) and is therefore still silently dropped by `collect()`'s own conservative "do not guess"
fallback. Flagged for whoever picks this up next, with both candidates named so they are not
re-discovered from scratch.

### 2.5 Store-wide invariant test (deliverable, item 1)

Four pure unit tests (`crates/urdira-indexing-worker/src/v4/residual.rs`, `#[cfg(test)] mod tests`):
`classification_consistent_for_a_genuinely_possible_identity`,
`classification_consistent_for_a_genuinely_confirmed_identity`,
`classification_inconsistent_when_identity_claims_a_target_but_store_has_none` (the exact P1-D-g bug
signature), `classification_inconsistent_when_identity_is_unresolved_but_store_has_a_target` (the
inverse, checked though unexpected in practice) — exercising `is_classification_consistent` directly
with plain string/bool inputs, no store or fixture needed. The store-wide, n8n-scale check itself
(`count_classification_mismatches`) is exercised by the existing `#[ignore]`d
`n8n_residual_pass_debug_histogram` test (§2.4's own numbers) rather than a second synthetic
fixture — a hand-built `StoreReader`/`RecordRow` fixture reproducing the real cold-scan mismatch
mechanism was judged not worth the complexity given the pure predicate is already fully covered and
the store-scanning wrapper is a five-line loop around it.

## 3. Item 3: `rpc_error` bisection (target NOT met — negative result documented)

### 3.1 Live bisection of one real failing owner

Sample from this session's own fresh n8n run: `.github/scripts/trim-fe-packageJson.js`, a small
plain CommonJS `.js` utility script (`require('fs')`, `require('path')`, `resolve(...)`,
`writeFileSync(...)`, three `trimPackageJson(...)` calls). **Every single call site in this owner
fails** with the exact diagnosed error (`node handle "N.79./...trim-fe-packageJson.js" could not be
resolved`), node indices 12, 24, 33, 55, 79, 98, 115, 120, 125 — including the LAST call in the file
(`trimPackageJson('frontend/editor-ui')`, an entirely ordinary same-file function call with nothing
CommonJS-specific about it). This rules out "only ambient/`require` lookups are the problem" as the
mechanism (matching P1-D-e's own prior finding on `supplyModel.test.ts`: a whole-owner, per-handle
condition, not a single bad handle poisoning a batch — `fetch_symbols_chunked`'s per-location retry,
already in place, does not recover a single one of these).

### 3.2 Tried the task brief's own suggested fix — reverted, real regression found

Extended `callee_identifier` (`crates/urdira-tsgo-client/src/resolver.rs`) to descend into a
`PropertyAccessExpression` callee's own `.name` identifier for a member call (`a.b()`), giving
member-dispatch calls the same batched direct-symbol-lookup shortcut plain-identifier calls already
get — exactly the task brief's own "descend to the callee's name identifier for member calls"
suggestion. **A live regression against the real tsgo binary caught this immediately**:
`pascal_case_owner_file_single_site_does_not_produce_rpc_error`
(`crates/urdira-tsgo-client/tests/rpc_error_repro.rs`) started failing with the EXACT diagnosed
error on `[1, 2].map((n) => n)` — an entirely ordinary member call this pass already resolves
correctly today via `getResolvedSignature` alone. This is not a batching artifact (the failing batch
here has exactly one location): **`getSymbolsAtLocations` genuinely cannot resolve a handle for a
property-access NAME node at all**, while `getResolvedSignature` (which performs real type
inference — the only path a member call already goes through) handles the identical call correctly.
Sending property-name handles into `fetch_symbols_chunked` would have converted this pass's single
LARGEST call-site shape (member dispatch, P1-D-d's own finding) into a new, systematic `rpc_error`
source — the opposite of this task's target. **Reverted**; `callee_identifier` is unchanged from
before this session, with the finding recorded in its own doc comment so it is not re-attempted
blind.

### 3.3 A second, more targeted synthetic reproduction — also did not reproduce

`commonjs_js_file_with_unresolvable_ambient_globals_and_a_trailing_local_call`
(`tests/rpc_error_repro.rs`, new): a `.js` owner shaped like `trim-fe-packageJson.js` itself
(`require`/`resolve`/`writeFileSync` ambient calls plus a trailing local function call), run with
`allowJs`/`checkJs: true` (P1-D-f's own fix, unconditionally on for every real residual pass run) —
the same compiler-option combination the real corpus uses. **Did not reproduce**: every site
resolved to `Unresolved { reason: "no unique call target" }` (the `no_symbol` bucket), zero
`rpc_error`. This is the THIRD synthetic shape across two sessions (P1-D-e's own two stress shapes,
§2.4 of that doc, plus this one) that fails to reproduce the corpus's persistent per-handle
condition — reinforcing P1-D-e's own conclusion that this is tied to something about the REAL
file's actual parse-tree shape or the full multi-window corpus context, not isolable in a small
synthetic fixture.

### 3.4 Measured effect: none (by design — the fix was reverted)

`rpc_error` in the final, full parity-diff re-run (§5): **13,737** — identical to the value reported
in P1-D-f before this session. No regression, no improvement. **Not attempted further this
session** (task's own risk framing: a wrong fix in this exact RPC/protocol layer risks a confirmed
row pointing at the wrong declaration, worse than an honest possible — repeated from P1-D-e, now
independently reconfirmed by this session's own live experiment).

## 4. Item 4: `external_lib` policy and `completeness_report`

Investigated; **no bug found, no TS edit made**.

- `packages/plugin-javascript-typescript/src/registry-contribution.ts`'s own `jsts:unresolved_call`
  diagnostic definition already documents, in its `emission_condition` field, that a call resolved
  to a target OUTSIDE the frozen project (a library call, a built-in, an ambient declaration) is "an
  expected analysis boundary, not this condition" — i.e. the schema's own documented intent already
  excludes `external_lib`-classified calls from counting as an unresolved-workspace-call signal.
- `residual.rs`'s own `SiteOutcome::External` arm (the residual pass's own classification of a
  library/built-in target) **never emits any diagnostic or completeness-reason record at all** — it
  only increments a counter (`external`). This module therefore cannot itself cause an external call
  to be miscounted as "unresolved" in any signal downstream code derives from records this pass
  publishes.
- The actual `call_deferred_to_e3`/`call_target_uncertain` diagnostic EMISSION (the reason codes
  `diagnosticPayload`'s schema in `registry-contribution.ts` currently lists as producible) happens
  in `crates/urdira-indexing-worker/src/main.rs`'s hybrid-semantics/typeflow lane — **not owned by
  this session, and not line-by-line verified** that externally-resolved sites are excluded there at
  the actual emission call sites (only the schema's own documented intent was confirmed, not the
  Rust code that emits against it). Flagged as an open, lower-priority follow-up for whoever next
  owns that file, rather than claimed as fully verified.
- The `diagnosticPayload` schema's own comment already reserves a fuller taxonomy
  (`union_ambiguous`, `overload_ambiguous`, `external_module`, `generic`) for "a future widening of
  the Rust emission channel" — the right place to add a precise `external_module` reason code if
  that future audit of `main.rs` ever finds a real violation. Nothing found this session that would
  need it added now.

## 5. Item 5: final parity re-run (n8n, full corpus)

Same tool (`scripts/v4-call-parity-diff.mjs`, unmodified this session), same methodology as P1-D-f:
`--v3-db` the retained v3 SQLite (read-only), `--v4-bodies`/`--v4-site-dump` freshly produced by one
clean n8n run with both this session's fixes applied
(`n8n_residual_pass_debug_histogram --ignored --nocapture`, `URDIRA_V4_CALL_BODY_DUMP_AFTER`,
`URDIRA_V4_RESIDUAL_SITE_DUMP`). Reproduced twice (two independent scratch runs; both agreed exactly
on every Rust-side count: `upgraded=83,707 external=41,001 unresolved=546,650`).

**Forward** (every v3-confirmed site, classified by its v4 state):

| bucket | count | share |
|---|---:|---:|
| `v4_confirmed_same_target` | 112,565 | 54.78% |
| `v4_confirmed_different_target` | **0** | 0.00% |
| `v4_possible` | 92,903 | 45.22% |
| `v4_missing_site` | **0** | 0.00% |

**`v4_possible` reason histogram**:

| reason | count |
|---|---:|
| `external_lib` | 40,812 (unchanged from P1-D-f — policy preserved, §4) |
| `no_symbol` | 37,612 |
| `rpc_error` | 13,737 (unchanged from P1-D-f — §3) |
| `workspace_target_pre_entity_lookup` | 489 (down from 16,017 — `confirmed_row_build_failed` effectively eliminated, §2) |
| `declaration_text_unavailable` | 253 |

**Reverse** (every v4-confirmed site, classified by its v3 state):

| bucket | count |
|---|---:|
| `v4_confirmed_v3_same_target` | 112,565 (matches forward exactly — internal consistency check) |
| `v4_confirmed_v3_possible` | 35,468 (typeflow's own contribution) |
| `v4_confirmed_v3_missing_site` | **0** |

30 forward `v4_confirmed_same_target` samples and 30 reverse `v4_confirmed_v3_same_target` samples
were inspected by eye (the diff tool's own default `--samples 30`): every one resolves to a real,
correct, plainly-related declaration (e.g. `git(...)` → its own top-level helper;
`this.gitService.setBranch(...)` → the real service method in a different file;
`matchGlob(...)` → its own exported function) — no spurious matches found.

**Reconciling the remaining gap**: `205,468 (v3 ceiling) − 40,812 (external) − 37,612 (no_symbol) =
127,044` is the same-corpus "achievable ceiling" excluding the two categories this task's own §4/§7.2
findings treat as out of scope this session. `127,044 − 13,737 (rpc_error) − 489
(workspace_target_pre_entity_lookup) − 253 (declaration_text_unavailable) = 112,565` — exactly the
measured `same_target` count. The entire remaining gap to the 120,000 target is therefore fully
attributed: `rpc_error` (§3, investigated and NOT fixed this session) is now, by a wide margin, the
single largest lever a future session could still pull.

**Target**: `same_target ≥ 120,000` — **NOT met** (112,565, 93.8% of the target). Reported honestly:
this session closed roughly 60% of the remaining gap from the 89,707 starting point
((112,565−89,707)/(120,000−89,707) ≈ 75.6%, or in absolute terms +22,858 sites) using only items 1
and 2's fixes; item 3 (the other large lever) was investigated but the only concrete code change
tried was proven unsafe and reverted (§3.2).

## 6. Quality gates

- `cargo fmt --all`: applied; `cargo fmt --all -- --check`: clean after.
- `cargo clippy -p urdira-tsgo-client -p urdira-indexing-worker --all-targets -- -D warnings
  --no-deps`: clean. `cargo clippy -p urdira-tsgo-client -p urdira-indexing-worker --all-targets --
  -D warnings` (without `--no-deps`, so every dependency crate in the graph is also checked): also
  clean this session (unlike prior sessions, no pre-existing lint was left over in a concurrently
  edited dependency crate at the moment this was run).
- `cargo test -p urdira-tsgo-client -p urdira-indexing-worker`: **82 + 46 + 2 + 3 + 7 = 140 passed**,
  0 failed, 5 ignored (n8n-scale `#[ignore]`d tests, one of which —
  `n8n_residual_pass_debug_histogram` — was run explicitly for §2.4/§5 above).
- `npx eslint scripts/v4-call-parity-diff.mjs`: clean (unmodified this session).
- `npx vitest run tests/v4-daemon-e2e.test.ts tests/codebase-fixtures.test.ts`: **5 passed, 1
  skipped** (the skip is the always-on "build release artifacts first" companion, skipping because
  the artifacts already exist) — unchanged from every prior session's report of this exact suite.

## 7. Files touched

- `crates/urdira-indexing-worker/src/v4/residual.rs`: `build_confirmed_row`'s self-collision fix
  (§2.2); `collect()`'s generalized `source_id` recovery + `was_mismatched` tracking (§2.3);
  `is_classification_consistent`/`count_classification_mismatches`/
  `repair_mismatched_row_if_needed`/`build_corrected_possible_row` (new, §2.3); wired into
  production debug logging and the n8n diagnostic test (§2.3, §2.5); four new unit tests (§2.5).
- `crates/urdira-tsgo-client/src/resolver.rs`: `callee_identifier`'s doc comment records the
  tried-and-reverted member-callee extension (§3.2) so it is not re-attempted blind — no functional
  change from before this session.
- `crates/urdira-tsgo-client/tests/rpc_error_repro.rs`: one new test,
  `commonjs_js_file_with_unresolvable_ambient_globals_and_a_trailing_local_call` (§3.3).
- `docs/evidence/2026-09-05-v4-p1d-g-classification-and-build-failures.md` (this file).

## 8. Patch proposal for the coordinator (item 1's cold-producer root cause, out of this session's ownership)

Not applied — `semantic_sites.rs`/`materialize.rs` are owned by the concurrent P2-2l agent this
session. The clean fix, for whoever owns those files: `call_proposed_record`
(`crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`) should not write `classification:
"confirmed"` for a target that `materialize.rs`'s subject-resolution pass cannot guarantee to intern
— either (a) `materialize.rs` widens its subject-resolution step to also recognize a class/interface
MEMBER target id shape (`jsts:{method|constructor|getter|setter|property|...}:...`, the same
`declaration_id`/`stable_entity_id` recipe this session's own `try_synthesize_member_entity`
already relies on) even when no entity row exists yet for it — i.e. give the cold path the same
JIT-synthesis capability P1-D-d's own residual-pass fix already has, so a member-target confirmation
is genuinely interned at cold-scan time and never mismatched in the first place; or (b), a smaller
and more local fix, `call_proposed_record` checks whether its own `target_id` is a member-kind id
BEFORE writing `classification: "confirmed"`, and writes `"possible"` instead whenever it is (since
today's cold-scan entity producer never provides genuine member entities for materialize.rs to
resolve against). Option (a) is more correct (it recovers today's E1-E3 confidence directly rather
than deferring everything member-shaped to the residual pass); option (b) is a two-line, purely
defensive change with no cross-cutting entity-schema risk. This session's own residual-pass fix
(§2.3) already repairs the resulting inconsistency for any site the checker can independently
confirm or rule out, so this patch is an efficiency/precision improvement (fewer sites needing the
residual pass at all, no query-time ambiguity between cold-scan generations) rather than a
correctness requirement — the invariant (§2.5) already holds far better after this session's own
fix than before it, even without this patch.
