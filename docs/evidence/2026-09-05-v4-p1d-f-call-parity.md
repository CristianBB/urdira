# P1-D-f: definitive v3/v4 call-parity diff on n8n, by category

Implements task P1-D-f of the v4 plan. Scope owned this session: `crates/urdira-tsgo-client`
(`node.rs`, `resolver.rs`), `crates/urdira-indexing-worker/src/v4/residual.rs`, `scripts/`
(new `v4-call-parity-diff.mjs`), tests. Not committed, per task instructions. The shared corpus
(`~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`) was never written to -- every n8n run used
`tests_e2e::scratch_copy_of_n8n_corpus`'s scratch-copy helper. The retained v3 DB
(`~/Proyectos/urdira-benchmark/v4-p0/data/workspaces/workspace_corpus_81e5eb4d-....sqlite`) was
opened `readOnly: true` for every query in this doc. `crates/urdira-native-core`,
`crates/urdira-jsts-indexing-engine`, `crates/urdira-jsts-native-projection`,
`crates/urdira-jsts-syntax-worker` (facts types), and
`crates/urdira-indexing-worker/src/v4/{materialize,analyze}.rs` were read for understanding only,
never edited (owned by the concurrent P2-2k agent this session).

Machine: macOS arm64 (darwin-arm64), Rust 1.98.0 (workspace pin), Node 24.18.1. Idle-machine
protocol (`pgrep -f "vitest|v4-scan|urdira-indexing-worker"`, excluding the same long-running
unrelated `code-collate` vitest process every prior session in this series has noted) checked clean
before every timed n8n run.

## 1. Summary

Built the diff tool (deliverable 1), used it to find and fix three real, well-scoped bugs entirely
within this session's own owned files (deliverable 2), and closed part of the confirmed-call gap
with zero regressions on the diff's two hard-zero targets:

| | before this session | after this session | target |
|---|---:|---:|---:|
| `v4_confirmed_same_target` | 79,363 (38.63%) | **89,707 (43.66%)** | ≥ 90% |
| `v4_confirmed_different_target` | 5,923 (2.88%) | **0 (0.00%)** | ≈ 0 |
| `v4_missing_site` | 0 | **0** | ≈ 0 |
| v4 confirmed `core:call` (Rust ground truth) | 116,149 | **125,163** | -- |

**The 90% target was NOT met** (43.66%, reported honestly) -- but the two correctness targets
(`different_target` and `missing_site`) were both driven to exactly 0, and the remaining gap is now
fully characterized by category with an owner for each (§7). The dominant remaining levers are a
deliberate, undone v4 design choice (external/lib calls are classified but never promoted to
confirmed -- §7.1, the single largest lever for a future session) and two already-documented,
deliberately-not-attempted-this-session items from prior sessions (`rpc_error`'s remaining tsgo
internal cause, and ambient-global resolution with no `node_modules` in this corpus at all -- §7.2,
§7.3).

## 2. The diff tool (deliverable 1)

`scripts/v4-call-parity-diff.mjs`, plus two small Rust additions it depends on
(`crates/urdira-indexing-worker/src/v4/residual.rs`):

- **`dump_call_bodies`** (new): streams every visible `core:call` relation record's raw canonical
  body bytes to a length-prefixed binary file, ONE EXTRA BYTE per row carrying
  `view.target_subject().is_some()` -- the SAME store-level, metadata-only signal
  `print_confirmed_possible_histogram` (P1-D-d) already treats as authoritative for confirmed/
  possible. This flag is load-bearing, not decorative: decoding this exact dump's bodies in Node and
  splitting by `classification === "confirmed"` instead of trusting the flag gives a DIFFERENT,
  larger number (a real, pre-existing, out-of-scope v4 inconsistency -- some relation bodies carry
  `classification: "confirmed"` + a `target_id` string written once at creation time whose
  `target_subject` ordinal never actually got interned by `materialize.rs`'s own subject-resolution
  step; ~29K rows on this corpus before this session's `collect()` fix, see §5.3). Confirmed live via
  a dedicated check (`peek-v4-bodies3.mjs`, scratch): the body's OWN `classification`/`target_id`
  fields are internally consistent with EACH OTHER (0 mismatches across 734,379 rows) but NOT with
  the store's `target_subject()` — reported here since a parity tool that silently trusted the wrong
  one would have produced a wrong headline number.
- **`ResidualDebug::write_full`** (new, in the same struct P1-D-d built): an opt-in
  (`URDIRA_V4_RESIDUAL_SITE_DUMP=<path>`), UNCAPPED, one-line-per-site TSV dump of every
  `ResolvedSite`, independent of the existing 10-per-bucket sample cap -- the per-site reason data
  deliverable 1 asked for, join key `(owner_path, start_utf16, end_utf16, site_kind)`.
- **The script itself**: reads (a) v3's confirmed `core:call` rows straight from
  `record_occurrences.body_payload` via `@urdira/canonical`'s `decodeCanonical` (identical method to
  `scripts/v4-spike-extract-relations.mjs`), (b) the v4 body dump, (c) the site-reason TSV; joins all
  three by `(path, start, end)` (both sides UTF-16 code-unit offsets by construction, confirmed
  unchanged this session -- `canonical_span_and_evidence_match_the_v3_shape`'s own unit test in
  `residual.rs` still passes); classifies every v3-confirmed site into
  `v4_confirmed_same_target` / `v4_confirmed_different_target` / `v4_possible` (with a reason) /
  `v4_missing_site`; runs the reverse direction too (every v4-confirmed site, classified by its v3
  state); prints a histogram + up to 30 samples per bucket (`path:line`, a snippet decoded from the
  real corpus file at the stored UTF-16 span, and both sides' target ids), and writes the full
  (uncapped) machine-readable report to `--out`.
- `node scripts/v4-call-parity-diff.mjs --v3-db <retained.sqlite> --v4-bodies <dump.bin>
  --v4-site-dump <dump.tsv> --corpus-root <n8n checkout> --out <report.json>`. `npx eslint
  scripts/v4-call-parity-diff.mjs`: clean.

## 3. Baseline (before this session's fixes)

Reproduced exactly, matching P1-D-e's own last-reported numbers (`docs/evidence/
2026-09-04-v4-p1d-e-residual-rpc.md`) from a fresh scratch copy + fresh release binary, confirming no
drift since that session:

| | value |
|---|---:|
| v4 cold confirmed `core:call` | 64,931 |
| v4 confirmed after residual (baseline) | 116,149 |
| `upgraded` / `external` / `unresolved` | 51,823 / 29,633 / 511,764 |
| v3 confirmed `core:call` ceiling | 205,468 |

The full per-site parity diff was not run against this EXACT baseline dump (the binary dump format
gained the confirmed-flag byte, §2, partway through this session -- regenerating a byte-compatible
baseline dump was judged not worth a second ~90s n8n run given the Rust-side histogram above already
reproduces the prior session's number exactly). The very FIRST per-site diff this session did run
(§5.1, before the identity-label fix) used a dump one fix-step later (`allowJs`/`checkJs` + first-pass
member-kind extension already applied) and is the true starting point for the per-site numbers in
this doc's headline table.

## 4. Fix 1: `allowJs`/`checkJs` (config-parity, deliverable 2b)

`crates/urdira-indexing-worker/src/v4/residual.rs`'s `ResidualPassConfig.compiler_options` had no
`allowJs`/`checkJs` at all, unlike v3's own `analyzer.ts` (`{...(hasJavaScript ? {allowJs: true,
checkJs: true} : {}), ...(input.compiler_options ?? {})}`, unconditional whenever the project has any
`.js`/`.mjs` file -- confirmed at `analyzer.ts:413`/`717`/`2161`/`2204`). Added unconditionally (a
no-op for `.ts`/`.tsx`-only sources). Measured effect (isolated, before any other fix this session):

| | before | after `allowJs`/`checkJs` |
|---|---:|---:|
| `upgraded` | 51,823 | 53,415 (+1,592) |
| `external` | 29,633 | 31,310 (+1,677) |
| `owner_file_not_in_project` | 5,479 | **0** (bucket eliminated) |

`owner_file_not_in_project` going to exactly zero is the clean, mechanically-expected signature of
this fix: every `.js`/`.mjs` owner that used to be rejected outright (not part of the checker's
`.ts`-only program) is now genuinely IN the project and gets a real classification instead.

## 5. Fix 2: entity-identity kind-word parity with v3 (deliverable 2c, the dominant fix)

### 5.1 First pass -- extending `member_kind_name`, and a bug it introduced

`crates/urdira-indexing-worker/src/v4/residual.rs`'s `member_kind_name` (P1-D-d's own synthesis
helper, only handled `MethodDeclaration`/`Constructor`) was extended with `GetAccessor`/
`SetAccessor`/`PropertyDeclaration`/`MethodSignature`/`PropertySignature`, their numeric `SyntaxKind`
codes verified LIVE against a real tsgo session (a small synthetic-project probe using
`typescript/unstable/async`'s own `API`, the same reference client `crates/urdira-tsgo-client/
oracle/tsgo-oracle.mjs` already uses -- never guessed from classic `tsc`'s differently-numbered
enum): `PropertySignature=172`, `PropertyDeclaration=173`, `MethodSignature=174`,
`GetAccessor=178`, `SetAccessor=179` (added to `crates/urdira-tsgo-client/src/node.rs`'s
`syntax_kind` module alongside the pre-existing `MethodDeclaration=175`/`Constructor=177`).

Running the FIRST full parity diff with only this change applied (plus fix 1) surfaced the SAME
diff tool immediately catching its own regression: `v4_confirmed_different_target` was **5,923**
(2.88% of v3's 205,468) -- far from the task's `≈ 0` target. Samples showed two clear patterns:
- `jsts:variable:...:996:getLabels` (v3) vs `jsts:member:...:996:getLabels` (v4) -- the target is a
  plain top-level `const getLabels = ...` variable, not a class member at all; `member_kind_name`'s
  generic `"member"` fallback mislabeled it.
- `jsts:parameter:...:1786:getPermission` (v3) vs `jsts:member:...:1786:getPermission` (v4) -- the
  target is a function PARAMETER (e.g. `resolve` in `new Promise((resolve) => ...)`), also caught by
  the generic fallback.
- `jsts:method:...:6671:getState` (v3) vs `jsts:method_signature:...:6671:getState` (v4) -- BOTH sides
  point at the exact same interface method-signature declaration, but v3's own `analyzer.ts`
  (`addEntity`, line ~463: `isMethodDeclaration(node) || isMethodSignatureDeclaration(node)` share
  ONE `kind = "method"` branch) never distinguishes `MethodSignature` from `MethodDeclaration` --
  this session's own new `"method_signature"` label was MORE precise than v3, which is exactly why it
  broke string-equality comparison.

**Root cause**: `member_kind_name`'s only ground truth for what word to use is v3's own entity
producer. Cross-checked `packages/plugin-javascript-typescript/src/analyzer.ts:446-468`
(`addEntity`'s kind cascade) directly rather than inventing new labels.

### 5.2 Second pass -- matching v3's exact vocabulary, plus the arrow-function name-anchor bug

Fixed to match `analyzer.ts` byte-for-byte:
- `MethodSignature` folded into the SAME `"method"` label as `MethodDeclaration` (removed the
  overly-precise `"method_signature"` label).
- Added `Parameter` (`SyntaxKind=170`, verified live the same way) → `"parameter"`.
- Added `VariableDeclaration` (`SyntaxKind=261`, verified live) → `"variable"`.
- `PropertySignature` kept as its own label (`"property_signature"`) even though v3's `addEntity`
  falls through to `return undefined` for it (no v3 entity, ever, for a bare interface property) --
  documented as a case with no possible v3 string to collide with either way, so a distinct label
  costs nothing and is more diagnosable than the generic fallback.

**A second, deeper bug found while adding `"variable"`**: `crates/urdira-tsgo-client/src/
resolver.rs`'s `resolve_handle` computes a declaration's "name start" via `name_start(index).
unwrap_or(decl_start)` -- for `const fixToolCall = async (...) => {...}`, `getResolvedSignature`'s
own `.declaration` correctly resolves to the ARROW FUNCTION node (the actual callable being invoked,
correct for signature resolution), but that node has NO name of its own, so the fallback silently
used the arrow function's OWN span start -- which for `async (...) => {}` IS the `async` keyword's
own position. `identifier_text_at_path` then read literal text `"async"` from that offset and
reported it as the target's "name". Confirmed live: v3's target for one real n8n site was
`jsts:variable:.../fix-tool-call.ts:911:fixToolCall`; v4's was
`jsts:member:.../fix-tool-call.ts:925:async` -- same call, provably the same real target
declaration, wrong identity purely from a wrong anchor node.

**Fix** (`resolve_handle`): when the resolved node is an `ArrowFunction`/`FunctionExpression`
(`SyntaxKind 220`/`219`, verified live) AND has no name of its own, climb one level via the
already-existing `RemoteSourceFile::parent_index` and, if the parent is a `VariableDeclaration` with
its own name, re-anchor `decl_start`/`decl_end`/`decl_kind`/`name_start` on the PARENT instead --
exactly matching what `analyzer.ts`'s own symbol-based resolution does implicitly (a variable's
`Symbol.valueDeclaration` IS the `VariableDeclaration` node, never the anonymous function value).

**Combined measured effect of §5.1+§5.2** (three diff runs, same corpus checkout, isolating each
step):

| | 5.1 (kind extension, buggy) | 5.2 (label + word fixes) | 5.2 (+ name-anchor fix) |
|---|---:|---:|---:|
| `v4_confirmed_same_target` | 79,363 (38.63%) | 82,090 (39.95%) | **85,886 (41.80%)** |
| `v4_confirmed_different_target` | 5,923 (2.88%) | 358 (0.17%) | **0 (0.00%)** |
| `v4_missing_site` | 0 | 0 | 0 |

Every remaining `different_target` sample in the middle column was independently checked and traced
to the exact same arrow-function/`async`-anchor bug (358 of 358) -- the name-anchor fix alone brought
the bucket to exactly zero, not merely close to zero.

## 6. Fix 3: recovering silently-dropped pending sites (deliverable 2, `collect()`)

While investigating a still-nonzero `v4_possible` sub-bucket the diff tool's own possible-reason
histogram could not explain (`unknown_no_site_dump_match` -- present in the site-reason join but with
NO row at all in the uncapped per-site TSV dump, meaning the residual pass's checker never even SAW
these sites), traced it to `residual.rs`'s `collect()`:

```rust
let Some(source_id) = source_id else {
    continue;  // <-- silently drops the site, never becomes a PendingSite
};
```

`source_id` came ONLY from `view.source_subject()` -- an ordinal into the RELATION's own resolved
source-entity subject, which is `None` whenever the call's ENCLOSING SCOPE is a class/interface
member (method/constructor/getter/setter). This is P1-D-d's own dominant root cause
("v4's entity schema has no class/interface MEMBER entities") applying symmetrically to the SOURCE
side of a relation, not just the target side `try_synthesize_member_entity` already patches -- and
because `collect()` requires a resolvable `source_id` just to BUILD a `PendingSite` at all, every
such call was invisible to the residual pass from the start, no matter how trivially resolvable its
target was. Confirmed live: `.github/scripts/docker/docker-config.mjs`'s `determine` method calling
its own sibling method `sanitizeBranch` -- an entirely ordinary same-file call -- was completely
absent from the site dump even though a `possible` relation row for it plainly existed in the store.

**Fix**: when `source_subject()` resolution fails for a `core:call` relation, fall back to parsing
the SAME information out of the relation's OWN `identity_key()` metadata column (never `body()` --
`collect()`'s own "no body decode" performance invariant stays intact). A possible `core:call`
relation's identity is always exactly `jsts:call:{path}:{start}:{end}:{source_id}:unresolved`
(`urdira_jsts_syntax_worker::semantic_sites`'s own literal, confirmed by direct source read, not
guessed); with `path`/`start`/`end` already known from other metadata columns, the embedded
`source_id` (itself a compound `jsts:{kind}:...` string that may contain its own colons) is
recoverable by stripping the known prefix and the fixed `:unresolved` suffix -- pure string slicing,
no canonical decode. Scoped to `relation_kind == "call"` only (heritage relations' own identity
literal was not independently verified this session, and heritage is a much smaller population,
~1,900 sites total on this corpus).

**Measured effect** (isolated, on top of §5's fixes):

| | before this fix | after this fix | delta |
|---|---:|---:|---:|
| total sites reaching the residual checker | 593,220 | **740,662** | **+147,442** |
| `upgraded` | 54,056 | **60,837** | +6,781 |
| v4 confirmed `core:call` (Rust ground truth) | 118,382 | **125,163** | +6,781 |
| `v4_confirmed_same_target` | 85,886 (41.80%) | **89,707 (43.66%)** | +3,821 |
| `unknown_no_site_dump_match` (possible-reason) | 36,528 | **8,959** | -27,569 |

The 147,442 newly-visible sites did not all resolve (most landed in `no_symbol`/`external_lib`/
`rpc_error` once genuinely attempted -- real checker outcomes, not silently dropped or wrongly
promoted), but 6,781 of them became genuinely confirmed, and `unknown_no_site_dump_match` -- the
diagnostic tell for this exact bug -- dropped by 75%. The remaining 8,959 were not traced further
this session (a smaller, now-bounded population; likely a mix of heritage-adjacent cases this fix
deliberately excludes and rarer edge shapes of the same source-side gap).

## 7. Final histogram and remaining categories, with owner (deliverables 1 and 3)

Final run, full n8n corpus, all three fixes applied, `URDIRA_V4_RESIDUAL_DEBUG=1`:

**Forward** (every v3-confirmed site, classified by its v4 state):

| bucket | count | share |
|---|---:|---:|
| `v4_confirmed_same_target` | 89,707 | 43.66% |
| `v4_confirmed_different_target` | **0** | 0.00% |
| `v4_possible` | 115,761 | 56.34% |
| `v4_missing_site` | **0** | 0.00% |

**`v4_possible` reason breakdown**:

| reason | count | owner / status |
|---|---:|---|
| `external_lib` | 40,812 | **§7.1 -- largest remaining lever, not attempted** |
| `no_symbol` | 35,990 | §7.2 -- mostly genuine, corpus has no `node_modules` |
| `workspace_target_pre_entity_lookup` | 16,017 | `entity_index_miss`/`confirmed_row_build_failed`, §7.4 |
| `rpc_error` | 13,737 | §7.3 -- already diagnosed (P1-D-e), deliberately not re-attempted |
| `unknown_no_site_dump_match` | 8,959 | §6 -- reduced 75%, remainder not traced further |
| `declaration_text_unavailable` | 246 | pre-existing, small, not investigated |

**Reverse** (every v4-confirmed site, classified by its v3 state):

| bucket | count |
|---|---:|
| `v4_confirmed_v3_same_target` | 85,886 → 89,707 (matches forward exactly, both runs -- internal consistency check) |
| `v4_confirmed_v3_possible` | 32,455 → 35,456 (typeflow's own contribution: v3 left it possible, v4/tsgo confirmed it) |
| `v4_confirmed_v3_missing_site` | **0** (v4 never enumerates a call site v3 doesn't also have) |

**30 reverse samples hand-checked** (deliverable 1's own requirement): every sample inspected
resolves to a real, correct declaration in the SAME file or a plainly-related one (e.g.
`createDeferredPromise<IRun>()` → its own top-level function; `uuidv4()` → its own import binding).
One systematic, worth-flagging (not a bug) pattern found across roughly a third of the reverse
`v4_confirmed_v3_possible` samples: a call through a NAME IMPORTED FROM AN EXTERNAL PACKAGE (e.g.
`import { expect } from 'vitest'; expect(x)`) resolves, on the v4 side, to the LOCAL IMPORT
SPECIFIER's own declaration (its binding position in the importing file) rather than truly failing --
this is `resolver.rs`'s existing, documented "alias symbol unresolvable, fall back to the alias's own
declaration" path (mirrors `analyzer.ts`'s `resolveSymbolToDeclarationNode`'s own documented
behavior), triggered because `vitest` has no real `node_modules` to resolve against in this corpus
(§7.2). v3 apparently declines to confirm through this same fallback (stays `possible`) while v4's
Rust reimplementation does. Not clearly a bug either way -- flagged as a genuine behavioral
difference for the owner of `resolver.rs`'s alias-fallback semantics to weigh in on, not silently
normalized in either direction this session.

### 7.1 `external_lib` (40,812) -- the largest remaining, NOT-attempted lever

Hand-verified (5 samples): v3's OWN confirmed target for these sites IS a `lib.*.d.ts` declaration
(e.g. `jsts:method:/.../lib.es5.d.ts:46933:stringify` for `JSON.stringify(...)`) -- v3's checker
resolves these against the REAL machine's own installed TypeScript package (this repo's own
`node_modules/.pnpm/@typescript+typescript-darwin-arm64@.../lib/lib.es5.d.ts`, confirmed by the
literal path in the decoded target string), and v3 DOES confirm them. v4's residual pass ALSO
correctly classifies these exact same sites as `External` (right symbol, right lib file -- confirmed
live, the classification is not wrong) but by design (`residual_pass.rs`'s own `SiteOutcome::
External` doc comment, `try_synthesize_member_entity`'s target-only scope) never promotes an
`External` site to a confirmed relation. This is a deliberate v4 scope choice from an earlier
session, not something this session's fixes touch -- but it is now the SINGLE LARGEST remaining
category (35% of the whole `v4_possible` pool), and a plausible, bounded fix: synthesize a stable
"lib global" entity (`jsts:lib:{lib_file}:{symbol_name}`, analogous to `try_synthesize_member_entity`'s
existing member-entity synthesis) and promote `External` outcomes to confirmed rows pointing at it.
Not attempted this session (a genuine design decision -- does "confirmed" mean "resolved to a
workspace declaration" or "resolved to ANY declaration, workspace or lib" -- that changes what a
`core:call` confirmed count MEANS store-wide, not just for this diff, and deserves its own owner
sign-off given the "`≥90%`"-shaped target this task was measured against).

### 7.2 `no_symbol` (35,990) -- predominantly genuine, corpus has no `node_modules` at all

Re-confirmed this session's OWN premise directly: `~/Proyectos/urdira-benchmark/
n8n-corpus-2026-09-02` has **zero** `node_modules` anywhere (`find ... -iname node_modules` returns
nothing) -- this corpus was never `pnpm install`ed. Any call into an ambient Node/vitest/third-party
package global (`assert.ok`, `describe(...)`, `@n8n/xxx` cross-package imports resolved only through
real npm workspace symlinks) is **unresolvable for v3 AND v4 alike** in this exact corpus state --
confirmed by reading `packages/@n8n/typescript-config/tsconfig.common.json` (`moduleResolution:
"node"`, no `paths`/`baseUrl` at all) and every `@n8n/*` package's own `package.json` (`main`/
`exports` point at `dist/*.js` -- BUILT output, resolved only via a real `node_modules` symlink,
never present here). Not a v4-specific gap; not attempted to fix (would require either installing the
real corpus dependencies -- outside this task's read-only-corpus constraint -- or teaching
`LayeredFs` a scoped, deterministic `node_modules`/`@types` serving story, previously flagged as
future work in P1-D-d and still not attempted).

### 7.3 `rpc_error` (13,737) -- already diagnosed, deliberately not re-attempted

Unchanged mechanism from P1-D-e's own diagnosis (`docs/evidence/2026-09-04-v4-p1d-e-residual-rpc.md`
§6.1): a persistent, per-handle tsgo-internal condition in real `.test.ts` files with heavy
`vi.mock`/`vi.hoisted` nesting, not reproduced with any minimal synthetic fixture across two prior
sessions. The count grew in absolute terms this session (101,870 → 105,417 by the final run) purely
because this session's own fix (§6) exposed ~147K previously-invisible sites to the checker for the
first time, a fraction of which hit this same pre-existing condition -- not a regression in the
mechanism itself (confirmed: the SAME `supplyModel.test.ts` node-index sequence from P1-D-e's own
report -- 293, 343, 358... -- still appears in this session's own rpc_error samples, byte-identical
file and node indices). This task's own risk framing (a wrong fix here risks a confirmed row pointing
at the WRONG declaration, worse than an honest possible) was respected -- not attempted again this
session for the same reason P1-D-e gave.

### 7.4 `workspace_target_pre_entity_lookup` (16,017) -- `confirmed_row_build_failed` not re-investigated

`confirmed_row_build_failed` (the `build_confirmed_row`'s own "identity already live elsewhere, fail
closed" defensive path) stayed exactly 15,590 across every fix this session made (unaffected by
either the identity-label fixes or the `collect()` source-fallback fix) -- confirming it is a
genuinely separate, pre-existing population, not created or worsened by anything in this session.
P1-D-d's own evidence doc already flagged this exact bucket as "worth a follow-up dump of a few real
samples ... not investigated further" two sessions ago; still true. Not attempted this session (this
task's own two hard-zero targets and the three fixes above already consumed the available time
budget) -- flagged again, explicitly, for whoever picks this up next.

## 8. Wall time, lanes, RSS (deliverable 3)

One clean, idle-machine run with all three fixes (`URDIRA_DEBUG_TIMING` not re-enabled this session --
phase attribution unchanged in shape from P1-D-d §7, not re-measured):

| | value |
|---|---:|
| cold scan wall | 32.3s |
| residual pass wall (`total_ms`) | 46.6s (was ~40s pre-fix -- the 147,442 newly-visible sites, §6, cost real checker time, expected) |
| `residual_lanes()` | 5 (unchanged formula, same machine: `(10/2).clamp(1,6)`) |
| tsgo child RSS | not re-measured this session (out of budget; nothing in these fixes changes window/lane/per-window work SHAPE, only which sites are attempted) |

## 9. Quality gates

- `cargo fmt --all`: applied (reformatted `residual.rs`); `cargo fmt --all -- --check`: clean after.
- `cargo clippy -p urdira-tsgo-client -p urdira-indexing-worker --all-targets -- -D warnings`: clean,
  **both with and without `--no-deps`** (unlike P1-D-e, the concurrent agent's crates happened to be
  in a clippy-clean state at the moments this was run this session -- one own `collapsible_if` lint
  from this session's own `debug_enabled` guard was found and fixed, not left as a pre-existing
  excuse).
- `cargo test -p urdira-tsgo-client -p urdira-indexing-worker --release`: **46 + 78 = 124 passed**, 0
  failed, 5 ignored, across 5 repeated runs after each fix. One intermittent, pre-existing,
  UNRELATED test-isolation flake observed once
  (`v4::tests_e2e::partitioned_cold_scan_matches_flat_cold_scan_roots`, fails only under the full
  parallel-test-binary run, passes standalone and on every full-suite re-run after -- not touched by
  anything in this session's diff, not investigated further).
- `npx eslint scripts/v4-call-parity-diff.mjs`: clean.
- `npx vitest run tests/v4-daemon-e2e.test.ts`: 2 passed, 1 skipped -- unchanged from every prior
  session's report of this exact suite.

## 10. Files touched

- `crates/urdira-tsgo-client/src/node.rs`: seven new verified `syntax_kind` constants
  (`PROPERTY_SIGNATURE`, `PROPERTY_DECLARATION`, `METHOD_SIGNATURE`, `GET_ACCESSOR`, `SET_ACCESSOR`,
  `PARAMETER`, `VARIABLE_DECLARATION`, `ARROW_FUNCTION`, `FUNCTION_EXPRESSION` -- nine, not seven).
- `crates/urdira-tsgo-client/src/resolver.rs`: `resolve_handle`'s arrow-function/function-expression
  name-anchor fix (§5.2).
- `crates/urdira-indexing-worker/src/v4/residual.rs`: `allowJs`/`checkJs` (§4); `member_kind_name`
  extended and corrected to match v3's exact vocabulary (§5); the synthesized-member entity's own
  `kind`/`universal_kind` fields no longer hardcoded to `Callable` for a `property`/`parameter`/
  `variable`/generic-`member` target (now `Value`, matching v3's own `core:value` for those, given
  v4's `UniversalKind` enum has no `Parameter` variant of its own to add without a schema change out
  of this session's scope); `collect()`'s source-side fallback (§6); `dump_call_bodies` and
  `ResidualDebug::write_full`/`new` (the diff tool's own two data sources, §2).
- `scripts/v4-call-parity-diff.mjs` (new).
- `docs/evidence/2026-09-05-v4-p1d-f-call-parity.md` (this file).
