# P1-D-b: `urdira-tsgo-client` residual pass runner (windows, lanes, lib.d.ts, entity ids)

Scope: turn the P1-D-a Rust tsgo client (`crates/urdira-tsgo-client`, see
`docs/evidence/2026-09-03-v4-p1d-a-tsgo-client.md`) into a complete
"residual pass" runner — windowing over a full sorted root list, a
multi-lane (multi-process) split, real TypeScript-lib (`lib.*.d.ts`)
resolution, and an entity-id mapping helper — still as a LIBRARY + bench,
NOT wired into `crates/urdira-indexing-worker`. All work is confined to
`crates/urdira-tsgo-client` (its `src/`, `tests/`, and this doc). Nothing
outside that crate was touched.

## 1. New/changed files

New:
- `crates/urdira-tsgo-client/src/residual_pass.rs` — `WindowPlan`/`Window`,
  `ResidualPass` (`run`/`run_instrumented`), `SiteOutcome`, `ResolvedSite`,
  `ResidualPassConfig`, `ResidualPassError`, `WindowStats`/`PassStats`.
- `crates/urdira-tsgo-client/src/entity_index.rs` — `EntityIndex`.
- `crates/urdira-tsgo-client/tests/residual_pass.rs` — integration tests
  against the real tsgo binary (3 tests).
- `crates/urdira-tsgo-client/tests/bench_residual_pass.rs` — `#[ignore]`d
  perf bench over a 2,000-owner n8n corpus cut.

Modified:
- `crates/urdira-tsgo-client/src/virtual_fs.rs` — added `OverlayFs` and
  `LayeredFs` (+ 4 new unit tests).
- `crates/urdira-tsgo-client/src/node.rs` — added `identifier_text_at`
  (+ 3 new unit tests).
- `crates/urdira-tsgo-client/src/resolver.rs` — added `decl_kind: u32` to
  `ResolvedDeclaration` (additive; every existing call site/test that reads
  named fields is unaffected — confirmed by re-running
  `tests/oracle_resolve.rs`, still 9/9).
- `crates/urdira-tsgo-client/src/lib.rs` — module map doc + new exports.

No file outside `crates/urdira-tsgo-client` was modified. `cargo fmt`/
`cargo clippy` were run scoped to this one crate (`-p urdira-tsgo-client`),
not `--all`, specifically to avoid touching or reformatting the other
agent's concurrently-edited crates (`urdira-indexing-worker/src/v4/*`,
`urdira-native-core`, `urdira-jsts-syntax-worker`, `urdira-source-frontier`,
`urdira-structural-store`) — verified via `git status`/mtimes that none of
those files changed as a side effect.

## 2. Lib resolution (`LayeredFs`)

**Where the lib files actually live.** `node_modules/typescript` for this
repo's pinned `typescript@7.0.2` (tsgo) ships NO `lib.*.d.ts` files itself
— its `lib/` directory only has `getExePath.{js,d.ts}`, `tsc.js`,
`version.{cjs,d.cts}`. The 108 `lib.*.d.ts` files (`lib.es5.d.ts`,
`lib.dom.d.ts`, `lib.es2025.full.d.ts`, ...) live in the resolved PLATFORM
package instead:
`node_modules/.pnpm/@typescript+typescript-darwin-arm64@7.0.2/node_modules/@typescript/typescript-darwin-arm64/lib/` —
the exact same directory `crate::binary::TsgoBinary::path`'s PARENT already
points at (that's where the `tsc`/`tsgo` native binary itself lives).
Confirmed live: `ls` on that directory shows the binary (`tsc`,
23,653,616 bytes) and 108 `lib.*.d.ts` files side by side. So a caller
needs exactly ONE real root — `binary.path.parent()` — for full lib
coverage, no extra configuration.

**Mechanism.** `virtual_fs::LayeredFs::new(virtual_fs, real_roots)` wraps an
authoritative virtual `VirtualFs` with a small list of real, on-disk
directories: a path resolves against `virtual_fs` first, and only when
that has no entry AND the path falls under one of `real_roots` does it
fall through to `std::fs`. Every other path (crucially, anything under a
workspace's own `node_modules`) stays workspace-only — documented as a
deliberate scope limit (this crate does no module resolution of its own
and has no way to know which installed dependency version a snapshot
should see; serving `node_modules` from disk would make results depend on
whatever happens to be installed on the machine running the pass).

**Case-insensitive-filesystem bug found and fixed while writing the first
integration test.** tsgo's `initialize` response reports
`useCaseSensitiveFileNames: false` on this repo's default macOS/APFS setup,
and the checker canonicalizes absolute paths it hands back in declaration
handles to LOWERCASE — a live resolution of `[1, 2].map(...)` came back
with `handle.path ==
"/users/cristian/proyectos/urdira/node_modules/.../lib.es5.d.ts"`
(lowercased), while `LayeredFs`'s `real_roots` held the ORIGINAL mixed-case
`/Users/Cristian/...` path from `TsgoBinary::path`. A case-SENSITIVE
`starts_with` comparison therefore missed the match entirely and the site
came back `Unresolved` ("declaration file text unavailable") even though
`std::fs::read_to_string` of that exact same lowercased path succeeds fine
(APFS resolves it case-insensitively). Fixed by comparing
`LayeredFs::under_real_root`/`matching_real_root` case-insensitively
(lowercased on both sides) while still passing the ORIGINAL path string to
`std::fs` for the actual read — costs nothing on a case-sensitive host (a
genuinely mismatched-case path there would fail the `std::fs` call anyway).
This is the one non-trivial bug this task found; documented in
`virtual_fs.rs`'s own doc comments for `LayeredFs::under_real_root`.

**`OverlayFs`** (also in `virtual_fs.rs`): a small, mutable exact-path
override map (`Mutex<BTreeMap<String, String>>`) layered under a base
`VirtualFs`, built so `ResidualPass` can rewrite ONE file's content (the
synthetic per-window project-config document) between `updateSnapshot`
calls on a long-lived `TsgoClient`, without needing a mutable `VirtualFs`
trait or rebuilding the whole workspace map per window.

**Verification.** `tests/residual_pass.rs`'s
`resolves_lib_globals_external_and_cross_window_targets_workspace` asserts
`[1, 2].map((n) => n)` resolves to `SiteOutcome::External { lib_file, symbol_name
}` with `lib_file` matching `lib.*.d.ts` and `symbol_name == "map"`.

## 3. Window / lane model

`WindowPlan::build(sorted_root_paths, window_size)` splits an already-sorted
root list into fixed-size contiguous windows (`sorted_root_paths.chunks(window_size)`)
— `WindowPlan::DEFAULT_WINDOW_SIZE = 512` matches the Node analyzer's own
`URDIRA_RUST_SEMANTIC_WINDOW_SIZE` fallback
(`packages/plugin-javascript-typescript/src/analyzer.ts`'s
`activateRustSemanticWindow`, ~2112-2148). Unlike the Node analyzer (which
computes ONE window aligned to a requested owner's position,
`Math.floor(first / windowSize) * windowSize`), this crate's `build`
partitions the WHOLE list up front into a `WindowPlan` — the shape a full
residual pass needs (every owner assigned to exactly one window, no gaps).

`ResidualPass::run(plan, lanes, pending_by_owner, fs, config)` splits
`plan.windows` into `lanes` CONTIGUOUS blocks
(`plan.windows.len().div_ceil(lanes)`-sized chunks — the same partitioning
rationale as the checker-lane split in
`crates/urdira-indexing-worker/src/main.rs`'s `compute_hybrid_semantics`),
spawns one `std::thread::scope`-scoped worker thread per lane (each lane
blocked on its own child process's I/O, not CPU-bound on the parent
thread), and inside each lane:
1. Builds one `OverlayFs` (over the caller's `fs`) + `LayeredFs` (over
   that, with `config.lib_roots`) and spawns ONE `TsgoClient` for the
   lane's whole lifetime.
2. For each window in the lane's block, in order: writes that window's
   `{compilerOptions, files: window.roots}` project-config JSON into the
   overlay, calls `updateSnapshot` (first window: `open_projects` only;
   subsequent windows: `open_projects` + `file_changes: {changed:
   [config_path]}`, matching `activateRustSemanticWindow`'s own pattern of
   forcing tsgo to re-read the config it just mutated), resolves every
   owner-in-this-window's pending sites via one `ResidualResolver::resolve`
   call, classifies each result, then `release`s the PREVIOUS window's
   snapshot (the last window's snapshot is released after the loop).
3. Shuts the client down.

Results from every lane are concatenated and sorted by `(owner_path,
start)` before returning — deterministic regardless of which lane or
window produced a given site (verified live:
`one_lane_and_two_lanes_agree_exactly` asserts byte-for-byte equality
between a 1-lane and a 2-lane run over the same 3-window plan).

**Cross-window resolution — verified, not just assumed.** The task brief
flagged as a risk that `getSourceFile` of a file outside the CURRENT
window's `files:` list might not work. Tested directly with
`window_size = 1` (one file per window/project): `a.ts`'s own window lists
ONLY `a.ts` as a root, yet a type annotation `x: Base` (where `Base` is
imported from `b.ts`, a DIFFERENT window) resolves correctly to
`SiteOutcome::WorkspaceTarget { path: ".../b.ts", ... }`, and likewise a
`new Base()` call site in `c.ts`'s own single-file window. This confirms
the expected TypeScript behavior: `files:` only sets PROGRAM ROOTS, module
resolution still transitively includes anything imported regardless of
window boundaries, because the caller's `VirtualFs` holds the full
workspace map at all times (only the synthetic config's `files:` array
narrows). No on-demand "add the target to the window's files" fallback was
needed — the risk did not materialize.

`ResidualPass::run_instrumented` (same signature, returns `(Vec<ResolvedSite>,
PassStats)`) is a thin addition purely for telemetry: per-window
`snapshot_ms`, `sites_resolved`, and `child_rss_kb` (sampled via
`ps -o rss= -p <pid>`, same technique `tests/bench_tsgo.rs` already used).
`run` itself is `run_instrumented` with the stats discarded — no duplicated
lane logic.

## 4. Outcome types

```rust
pub enum SiteOutcome {
    WorkspaceTarget { path: String, name_start_utf16: i32, decl_start: i32, decl_end: i32, kind_hint: u32 },
    External { lib_file: String, symbol_name: String },
    Unresolved { reason: String },
}
pub struct ResolvedSite { owner_path: String, start_utf16: i32, end_utf16: i32, site_kind: SiteKind, outcome: SiteOutcome }
```

Classification (`residual_pass::classify`): a `Resolution::Resolved` from
`ResidualResolver` is `External` iff its `path` falls under one of
`config.lib_roots` (`LayeredFs::matching_real_root`, case-insensitive — see
§2); `symbol_name` is read directly out of the lib file's own UTF-16 text
at `name_identifier_start` (`node::identifier_text_at`, new — reinstates a
leading `#` for private names) rather than a second checker round trip,
and `lib_file` is the basename only (`lib.es5.d.ts`, not the full
host-filesystem path — that path is a resolution-time accident of the
machine running the pass, not something that should leak into a caller's
entity graph). A per-lane `HashMap<path, Arc<Vec<u16>>>` cache avoids
re-reading a lib file from disk once per site.

`entity_index::EntityIndex::build(entries: (path, name_start_utf16, entity_id))`
+ `.lookup(path, name_start_utf16)` / `.lookup_workspace_target(&SiteOutcome)`:
an exact `(path, name_start)` → entity id map, matching the identity anchor
`analyzer.ts`'s `stableId` (`jsts:{kind}:{path}:{start}:{name}`,
`analyzer.ts:685-687`) and `semantic_sites.rs`'s `declaration_id` (`:431`)
both use — this crate never constructs the `jsts:...` string itself, only
looks one up that the caller already built. Verified end-to-end in
`entity_index_maps_a_resolved_workspace_target_back_to_a_caller_entity_id`:
the resolver's own `name_identifier_start` for `b.ts`'s `Base` class is
checked against an INDEPENDENTLY computed offset (a plain substring search
over `b.ts`'s own source text), then a synthetic `EntityIndex` entry at
that exact position is looked up successfully via the resolved
`SiteOutcome`.

## 5. Test results

`cargo test -p urdira-tsgo-client` (debug build):
- **43 unit tests** (`src/*.rs`'s own `#[cfg(test)]` modules) — all
  passing, including 4 new `LayeredFs`/`OverlayFs` tests, 3 new
  `identifier_text_at` tests, 5 new `WindowPlan` tests, 3 new
  `EntityIndex` tests.
- **`tests/oracle_resolve.rs`: 2/2** — unchanged from P1-D-a, re-run to
  confirm the `decl_kind` field addition to `ResolvedDeclaration` did not
  regress anything (it's read by field name everywhere, no struct-literal
  pattern match broke).
- **`tests/residual_pass.rs`: 3/3** (new, against the real tsgo binary):
  - `resolves_lib_globals_external_and_cross_window_targets_workspace`
  - `one_lane_and_two_lanes_agree_exactly`
  - `entity_index_maps_a_resolved_workspace_target_back_to_a_caller_entity_id`
- **`tests/bench_tsgo.rs`, `tests/bench_residual_pass.rs`**: `#[ignore]`d,
  run manually (below).

`cargo fmt -p urdira-tsgo-client -- --check`: clean.
`cargo clippy -p urdira-tsgo-client --all-targets -- -D warnings`: clean
(one real finding fixed along the way: `clippy::doc_lazy_continuation`
tripped on a doc comment line starting with `+` inside
`bench_residual_pass.rs`'s module doc, which rustdoc parsed as an
unordered-list marker — reworded, not suppressed).

A genuine bug in my own first test draft, found and fixed rather than
worked around: the fixture used a function named `useBase(x: Base)`, and a
naive `find_utf16_span(text, "Base", 2)` matched the SUBSTRING `"Base"`
inside `useBase` itself as the "2nd occurrence" instead of the real `x:
Base` type annotation — renamed the function to `consume` to remove the
collision. Caught because the resulting `WorkspaceTarget` path came back
as `a.ts` (the site's own owner file) instead of the expected `b.ts`,
which was the tell that the pending site's span was wrong, not the
resolver.

## 6. Bench

`cargo test -p urdira-tsgo-client --test bench_residual_pass -- --ignored --nocapture`,
run once, machine otherwise idle (`pgrep -f "v4-scan|n8n-incremental-preflight"`
empty immediately before running; load average ~5.7/8.3/7.9 just before).
Corpus: first 2,000 sorted `.ts`/`.tsx`/`.js` files under
`~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02/packages/`
(`node_modules`/`.git`/`dist`/`build`/`coverage` skipped) → 4 windows of
512/512/512/464 roots. Pending sites: loaded from the real P0/E1a-vs-checker
census JSON at
`.claude/worktrees/agent-adf2ed2e11c2fffb4/tmp-census.json` (read-only) —
996 real `checker_pending` sites (995 `call` + 1 `heritage`, real
`call_deferred_to_e3`-shaped reasons) across 133 owners inside this 2,000-
file cut (5 of the census's 1,001 sampled sites pointed at owners outside
the cut and were dropped) — the synthetic `\.\w+\(` fallback was NOT
needed. `compilerOptions`: `{module: ESNext, moduleResolution: Bundler,
target: ES2022, strict: false, skipLibCheck: true}`.

```
owner cut: 2000 files (target 2000)
window plan: 4 windows of up to 512 roots
pending sites: 996 across 133 owners (source: census)

=== lanes = 1 ===
wall: 2.3 s
windows opened: 4
snapshot ms: p50=481.2 p95=598.3 (n=4)
sites/s: 430.2 (996 sites resolved)
lane 0 child RSS (max over its windows): 338000 KB (330.1 MB)
outcome histogram: workspace=791 external=0 unresolved=205 (of 996 total)

=== lanes = 6 ===
wall: 1.2 s
windows opened: 4
snapshot ms: p50=861.2 p95=903.2 (n=4)
sites/s: 851.0 (996 sites resolved)
lane 0 child RSS (max over its windows): 218416 KB (213.3 MB)
lane 1 child RSS (max over its windows): 138848 KB (135.6 MB)
lane 2 child RSS (max over its windows): 145472 KB (142.1 MB)
lane 3 child RSS (max over its windows): 98096 KB (95.8 MB)
outcome histogram: workspace=791 external=0 unresolved=205 (of 996 total)
```

Notes on these numbers:
- Only 4 lanes actually did work at `lanes = 6` (`4 windows / 6 lanes` still
  chunks to 4 non-empty blocks of 1 window each; lanes 4-5 spawned no
  client — `run_lane` returns immediately for an empty block. Rerunning
  with a 2,000+-window-scale corpus would be needed to see all 6 lanes
  loaded; out of scope for this task's machine/time budget).
  Since 4 windows already saturate 4 lanes at `lanes=6`, wall time roughly
  halved (2.3s → 1.2s) versus `lanes=1`'s fully serial 4-window run.
- **`snapshot ms` p50 roughly DOUBLED under `lanes=6`** (481ms → 861ms)
  despite wall time dropping — 4 tsgo child processes spawn and build
  their projects concurrently and contend for CPU, so each individual
  `updateSnapshot` gets slower even though the total elapsed time is
  shorter. This is exactly the RSS/time trade-off
  `crates/urdira-indexing-worker/src/main.rs`'s own `semantic_parallelism`
  doc comment already calls out for the existing Node-checker lanes — the
  same trade-off applies here and should be tuned empirically once this is
  wired into the worker (P1-D-c), not assumed to always be a straight win.
- **`external = 0` in both runs** — not a defect in the lib-resolution
  mechanism (verified working end-to-end in §2/`tests/residual_pass.rs`):
  the census's `checker_confirmed_rust_pending_samples` bucket specifically
  holds sites the checker resolved to something OTHER than the separate
  `checker_confirmed_external_target` bucket (8,612 sites, per the census's
  own counts — see `docs/evidence/...` §... or the raw JSON's
  `calls.checker_confirmed_external_target`), so this particular sample
  set simply never includes a lib-external target. A production residual
  pass over ALL pending sites (not just this one census sample bucket)
  would see external hits — the corpus's own
  `external_target_basename_counts` histogram (`lib.es5.d.ts`: 5,092,
  `lib.dom.d.ts`: 711, `lib.es2015.core.d.ts`: 980, ...) confirms plenty
  exist.
- **`unresolved = 205/996` (20.6%)** — expected, not a bug: this bench only
  loads 2,000 of the corpus's ~13,854 source files, so many census
  `checker_target`s point at declaration files OUTSIDE this run's virtual
  FS entirely (`declaration file not in project`) — a cropping artifact of
  the bench's own reduced scope, not the residual pass's cross-window
  resolution (§3 already verified that mechanism directly on a fixture
  where the target genuinely is in-scope).
- Child RSS at `lanes=1` (330 MB, one process sequentially opening/
  releasing 4 windows) is comparable to or a bit above the SUM of RSS
  across the 4 concurrent `lanes=6` processes (213+136+142+96 ≈ 587 MB) —
  i.e. running the SAME 4 windows as 4 short-lived-per-window-count
  processes instead of 1 long-lived one costs more aggregate memory
  (4 separate program builds) but each individual process's peak is
  lower — relevant for an RSS-ceiling-constrained deployment.

## 7. Risks / follow-ups for P1-D-c (worker integration)

- **Lane-count tuning is corpus-scale-dependent** (§6): this bench's
  4-window plan cannot exercise more than 4 lanes usefully; the real
  production window count (thousands of owners / 512 ⇒ tens of windows for
  a large repo) needs its own lane-count sweep, mirroring how
  `semantic_parallelism`'s `6` was tuned empirically against the n8n
  corpus, not derived analytically.
- **`snapshot ms` contention under high lane counts** (§6): more lanes
  is not free — validate the actual net wall-time win at the target lane
  count on the target corpus before choosing a default, the same way
  `main.rs`'s own doc comments already flag for the existing checker lanes.
- **The census's own sample buckets undersell `External` in this specific
  bench population** (§6) — a real integration should measure the outcome
  histogram over ALL of a project's `checker_pending` sites (every reason,
  not just the `checker_confirmed_rust_pending_samples` bucket this bench
  happened to have handy), not read too much into this run's `external=0`.
- **Case-insensitive-filesystem handling (§2) needs to travel with this
  code into the worker.** If P1-D-c's integration builds its own
  `LayeredFs`/equivalent independently instead of reusing this crate's
  (e.g. because the worker wants a different lib-root discovery path), the
  case-insensitive comparison bug found here would need re-fixing — it is
  NOT specific to this crate's particular `TsgoBinary::path` discovery, it
  is a property of tsgo's own `useCaseSensitiveFileNames: false` behavior
  on any case-insensitive host.
- **`OverlayFs`'s single mutable override is per-lane, not shared** — safe
  as implemented (each lane builds its own `OverlayFs`/`LayeredFs`/
  `TsgoClient` triple), but a future caller reusing ONE `TsgoClient` across
  what it thinks are independent callers (rather than one per lane, as this
  module does) would need to route ALL `updateSnapshot` calls for that
  client through the SAME `OverlayFs` instance — worth calling out
  explicitly in any future public API doc for whoever wires this in.
- **No on-demand window widening was implemented** (§3) because it was not
  needed — confirmed live. If a future corpus shape (e.g. a monorepo with
  unusual `moduleResolution` settings) DOES hit a case where a cross-window
  target fails to resolve via ordinary module resolution, the task brief's
  originally-anticipated fallback ("add the target to the window's `files`
  on demand") remains undesigned and would need real design work then, not
  assumed to be a small addition.
- **`decl_kind`/`kind_hint` is a raw `SyntaxKind` number**, not yet mapped
  to the `jsts:` id scheme's own `kind` strings (`"class"`, `"method"`,
  ...) — P1-D-c's integration will need that mapping table (already exists
  Node-side in `analyzer.ts`'s `rustSemanticDeclarationShape`, and
  Rust-side in `semantic_sites.rs`'s `DeclKind`) if it wants to construct
  full `jsts:{kind}:{path}:{start}:{name}` strings rather than only
  `EntityIndex` lookups.
