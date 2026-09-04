# v4 P4-a: repository-wide static gates + stale-v3-database recreation wiring

Scope: repo-wide static gates (build/lint/typecheck/architecture/publication/
coverage-gate manifest hygiene) across the v4 work landed by other agents this
week, plus wiring `packages/storage/src/recreate-outdated.ts` into the
daemon's workspace scan path. No Rust files touched. No commit made (per
task instructions).

## Part 1 -- static gates: before/after

| Gate | Before | After |
| --- | --- | --- |
| `pnpm -r build` | clean (16/16 packages) | clean (unchanged) |
| `pnpm lint` (`eslint .`) | 5 errors (1 file) at first pass; a later pass (once `crates/urdira-indexing-worker/target/v4-e2e-test/.../workspace/scripts/**` existed on disk from a concurrently-running n8n benchmark) surfaced 19,206 errors/696 warnings from that third-party scratch checkout | 0 errors, 0 warnings |
| `pnpm typecheck` (`tsc --build --force`) | 35 errors across 8 test files | 0 errors |
| `pnpm check:architecture` | clean (16/16 packages) | clean (unchanged -- see note) |
| `pnpm check:publication` | 18 findings (17 evidence docs + 1 script) | 0 findings (965 files checked) |
| `scripts/check-coverage-gate.mjs` required-behaviors check | 6 new v4 TS surfaces undeclared | 6 rows added, all verified (module exists, listed tests exist, every named behavior string is present in them) |

### `pnpm lint` -- 2 fixes

1. `scripts/v4-spike-extract-relations.mjs`: used `Buffer` without importing
   it (this repo's convention is an explicit `import { Buffer } from
   "node:buffer";`, not the ambient global -- see e.g.
   `scripts/n8n-incremental-preflight.mjs`). 5 `no-undef` errors -> 0.
2. `eslint.config.mjs`: added `"**/target/**"` to the root `ignores` array.
   Rust's `target/` directories are not just compiled output -- a Rust e2e
   test harness (`crates/urdira-indexing-worker`'s n8n incremental
   measurement, run by the concurrent P3-6 agent this session) checks out a
   full copy of the n8n repo's own build scripts under
   `target/v4-e2e-test/<run>/workspace/` while it runs, and that copy
   briefly existed on disk during one lint pass. None of that is this
   repo's own source; lint findings inside a third-party corpus's own
   scripts are not this repo's to fix, and the gate must not depend on
   whether some other process's scratch directory happens to exist at scan
   time. This is a config-only change to a root JS file; no Rust code was
   touched or read for content.

### `pnpm typecheck` -- 8 test files, 35 errors -> 0

All 35 errors were pre-existing (present before this task started) in test
files this task did not otherwise touch content-wise, all following one of
three recurring shapes under `tsgo` 7.0.2's stricter handling than the
`docs/evidence/2026-09-02-v4-p2-7-daemon-wiring.md` note anticipated ("THREE
pre-existing errors" -- the actual count in this session was 35, spread
wider):

- **Non-literal dynamic `import()` resolves to `unknown`/circular, not
  `any`.** Several test files load compiled dist modules via
  `import(resolve(repoRoot, "packages/.../dist/....js"))` (a *value* import,
  used for real cross-process behavior against the built artifact) while
  also needing the *type* from the package's own `src` declaration. Where
  that produced `unknown`/circularity errors (`v4-verify.test.ts`,
  `workspace-fork-v4.test.ts`, `v4-scan.test.ts`, `index-pack-v4.test.ts`),
  the fix is a type-only assertion alongside the runtime import, e.g.:
  ```ts
  const { verifyV4Workspace } = (await import(resolve(repoRoot, "packages/engine/dist/v4-verify.js"))) as typeof import("../packages/engine/src/v4-verify.js");
  ```
  This changes zero runtime behavior (the value still comes from `dist`);
  it only gives `tsc` a type to check callers against.
- **`import("@urdira/storage").SqliteDatabase` inline type queries
  (`v4-verify.test.ts`, `workspace-fork-v4.test.ts`).** `@urdira/storage` is
  not a root-level `devDependency` (only `@urdira/contracts`,
  `@urdira/canonical`, `@urdira/plugin-sdk`, `@urdira/security` are hoisted
  to root `node_modules/@urdira/`), so a bare-specifier type query from
  `tests/` cannot resolve at all -- confirmed by grepping every OTHER
  `tests/*.test.ts` file that mentions `"@urdira/storage"`: none of them
  actually import it that way, they all use the relative-`src` convention
  (`import type { SqliteDatabase } from "../packages/storage/src/index.js";`,
  same as `tests/byte-telemetry.test.ts`, `tests/cas-stream.test.ts`, etc.).
  Switched both files to that convention.
- **Small, independent gaps**, one per file: `chunk.reduce`'s accumulator
  needing an explicit `(total: number, ...)` annotation
  (`javascript-typescript-indexing-core-transport.test.ts`);
  `noUncheckedIndexedAccess` non-null assertions on two literal-index reads
  (`native-query-snapshot-port.test.ts`'s `relationIds[0]!`/`[1]!`,
  `phase7-reconciliation.test.ts`'s `errors[0]!.message`); an
  `exactOptionalPropertyTypes` violation from an explicit `deadline_ms:
  undefined` in an object literal, removed since the field is optional and
  the test already forces `deadline_ms: null` separately on the *wire*
  object it compares against a fixture (`rust-protocol-v4.test.ts`); and a
  call to `NativeCanonicalQuerySnapshotPort.has_warm_records` (which
  deliberately never takes a `scope` argument -- see its own doc comment)
  passed one anyway (`native-query-snapshot-port.test.ts`).

Full file:line list and fixes are in the diffs to: `tests/index-pack-v4.test.ts`,
`tests/javascript-typescript-indexing-core-transport.test.ts`,
`tests/native-query-snapshot-port.test.ts`, `tests/phase7-reconciliation.test.ts`,
`tests/rust-protocol-v4.test.ts`, `tests/v4-scan.test.ts`, `tests/v4-verify.test.ts`,
`tests/workspace-fork-v4.test.ts`.

### `pnpm check:architecture` -- no manifest changes needed

`architecture/manifest.json` declares layering at the **package** level
(`name`/`path`/`layer`/`dependencies`), not per-file. The new v4 TS surfaces
named in the task brief (`packages/engine/src/{native-query-snapshot-port,
native-store-convert, query-record-decode, rust-workspace-scan,
workspace-v4-bootstrap, v4-verify, native-structural-store-binding}.ts`,
`packages/storage/src/{recreate-outdated,workspace-v4-sql}.ts`) all live
inside packages (`@urdira/engine`, `@urdira/storage`) whose dependency edges
were already declared before this task, and none of them introduce a NEW
inter-package dependency the manifest doesn't already allow. `node
scripts/check-architecture.mjs` passed before and after this task's changes
with zero manifest edits required.

### `pnpm check:publication` -- 18 findings, 0 after

`scripts/check-publication.mjs` flagged 17 `docs/evidence/2026-09-0{2,3}-v4-*.md`
files and `scripts/v4-mutation-harness.mjs` for containing a literal home-
directory-rooted `Proyectos/`-or-`Projects/` path (its own regex: `` /Users/
`` or `` /home/ `` followed by a username segment then that directory name).

- **17 evidence docs**: pure prose (benchmark corpus paths, worktree paths,
  reproduction commands). Rewrote every occurrence (45 total, including one
  that spanned a markdown line-wrap) to the repo's existing redaction
  convention, `~/Proyectos/...` (already used by e.g.
  `docs/evidence/2026-08-24-readiness-queue-implementation.md`).
- **`scripts/v4-mutation-harness.mjs`**: one occurrence was in a comment
  (harmless to redact), but the OTHER was a live constant --
  `const MANDATED_SCRATCH_ROOT = "~/Proyectos/urdira-benchmark/v4-p3";` -- an
  actual filesystem path this script's own `join(MANDATED_SCRATCH_ROOT, ...)`
  call resolves at runtime. A literal `~` is never expanded by Node's
  `path.join`/`fs` APIs, so a naive text redaction here would have silently
  broken this script (used by the concurrently-running P3-6 benchmark work)
  the next time it ran. Caught before landing: fixed by resolving the path
  from `os.homedir()` at runtime instead of hardcoding it as a string
  literal --
  `const MANDATED_SCRATCH_ROOT = join(homedir(), "Proyectos", "urdira-benchmark", "v4-p3");`
  -- functionally identical (verified: resolves to the exact same absolute
  path on this machine) but the literal string is gone from the source, so
  the gate passes and the script's own behavior is unchanged.

### `scripts/check-coverage-gate.mjs` -- required_behaviors only (coverage % skipped, as instructed)

Ran the script directly rather than in a special "strings-only" mode (there
isn't one): its `required_modules` loop (module-exists / test-exists /
behavior-substring-present) runs unconditionally and independently of the
coverage-report load, so its errors are directly readable even though the
script goes on to also report the (irrelevant to this task) measured
coverage percentages against a stale `coverage/coverage-final.json` from a
previous `vitest run --coverage` (repository line coverage 48.12%, two
critical-branch regions below 100%). **Those percentage findings are
explicitly out of scope for this task** (P4-b's job, requires a fresh
`vitest run --coverage`, which this task's CPU-budget instructions rule
out running here) and were not acted on.

Added 6 `required_modules` rows (verified by grepping the named test files
for each named export before writing the row):

| Module | Tests | Behaviors (grep-verified) |
| --- | --- | --- |
| `packages/engine/src/rust-workspace-scan.ts` | `tests/v4-scan.test.ts`, `tests/index-pack-v4.test.ts` | `runRustWorkspaceScan` |
| `packages/engine/src/workspace-v4-bootstrap.ts` | `tests/phase-daemon-v4-scan.test.ts`, `tests/phase-daemon-recreate-outdated.test.ts` | `ensureV4Workspace` |
| `packages/engine/src/v4-verify.ts` | `tests/v4-verify.test.ts` | `verifyV4Workspace` |
| `packages/engine/src/native-query-snapshot-port.ts` | `tests/native-query-snapshot-port.test.ts` | `NativeCanonicalQuerySnapshotPort` |
| `packages/storage/src/recreate-outdated.ts` | `tests/recreate-outdated.test.ts`, `tests/phase-daemon-recreate-outdated.test.ts` | `recreateOutdatedWorkspaceDatabase`, `isOutdatedWorkspaceError` |
| `packages/canonical/src/merkle-bucket.ts` | `tests/merkle-bucket.test.ts` | `BucketedMerkleSet`, `rootFromBucketDigests` |

No existing rows removed (per the task brief -- P4-b decides deletions).
Re-ran `node scripts/check-coverage-gate.mjs` after the edit: zero "module
is missing" / "test is missing" / "behavior ... is not covered" errors for
any of the 6 new rows (or any pre-existing row).

## Part 2 -- `recreate-outdated.ts` wiring

### What was wired, and where

`packages/daemon/src/runtime.ts`'s `scheduleWorkspaceScan` closure (the
single scan-job path every scan attempt goes through, whether triggered by
`core:workspace_add`, a watcher event, `core:reindex`, or the daemon's own
startup "a workspace left `indexing` by a prior process life" crash-recovery
loop) already has one `try { await maybeBootstrapV4Workspace(...); await
durableStorage.catalog.registerWorkspace(...); database = await
durableStorage.openWorkspace(workspaceId); ... } catch (error) { ... }`
wrapping every scan. Added a new branch at the top of that `catch`, right
after the existing `core:operation_cancelled` check and before
`core:source_changed`/`WORKSPACE_WRITER_BUSY_CODE`:

```ts
if (isOutdatedWorkspaceError(error)) {
  const outdatedDatabasePath = durableStorage.defaultWorkspaceDatabasePath(workspaceId);
  try {
    const recreated = await recreateOutdatedWorkspaceDatabase({
      rootDir: options.data_root,
      workspaceId,
      databasePath: outdatedDatabasePath,
      reason: error instanceof Error ? error.message : String(error),
      logger: (line) => console.error(line),
    });
    await maybeBootstrapV4Workspace(workspaceId, durableStorage);
    console.error(`[urdira] workspace scan for ${workspaceId} recovered from an outdated-format database (moved ${recreated.movedPaths.length} file(s)/directory(ies) to ${recreated.staleDirectory}); scheduling a fresh Full scan`);
    pendingScans.set(workspaceId, { full: true, uris: new Set(), authoritativeDeletes: new Map(), presencesAfterDeletes: new Set(), activity: "indexing" });
    return undefined;
  } catch (recreateError) {
    console.error(`[urdira] workspace scan failed to recreate the outdated-format database for ${workspaceId}; falling back to the generic failure handling below:`, recreateError);
  }
}
```

Design notes:
- **Path resolution**: uses `durableStorage.defaultWorkspaceDatabasePath(id)`
  (a public, purely-deterministic-in-`(rootDir, workspaceId)` method,
  already used for exactly this purpose by `@urdira/engine`'s
  `ensureV4Workspace`), not a `catalog.getWorkspace(id)` lookup. The
  outdated-format throw can originate from EITHER
  `durableStorage.catalog.registerWorkspace` (a workspace's first touch this
  process life, when the on-disk file already exists at an outdated format
  -- `registerWorkspaceSerialized` validates schema compatibility BEFORE it
  ever inserts the catalog row) or `durableStorage.openWorkspace` (every
  later scan of an already-catalogued workspace) -- in the first case
  `catalog.getWorkspace` would still return `undefined`, so the
  deterministic path function is the only resolution that works for both.
- **One explicit log line**: `recreateOutdatedWorkspaceDatabase`'s own
  default logger already writes one line naming the moved paths; passed
  `logger: (line) => console.error(line)` so it goes through the same
  channel as every other daemon log line rather than a raw
  `process.stderr.write`, plus one additional summary line from the daemon
  itself confirming the reschedule.
- **Re-registration in the current format**: `maybeBootstrapV4Workspace`
  (already-existing, idempotent, `URDIRA_V4=1`-gated) is called again
  immediately after the move -- on the now-cleared path, it either stamps a
  fresh v4 database (flag on) or no-ops (flag off, the default), leaving the
  path clear for the rescheduled scan's own `registerWorkspace` call to
  stamp v3 (matching "v4 when `URDIRA_V4=1`, else v3 for now").
- **Scheduling the Full scan**: reuses the SAME `pendingScans.set(...,
  {full: true, ...})` + `return undefined` idiom the pre-existing
  `core:source_changed` branch just below it already uses -- the shared
  post-scan `finally` block picks this up and calls `scheduleWorkspaceScan`
  again once the current (failed) attempt settles. No new scheduling
  mechanism introduced.
- **Never deletes**: unchanged from `recreate-outdated.ts` itself -- only
  moves files into a sibling `*.v3.stale-<timestamp>/` directory.

### A real bug this wiring exposed and fixed (`packages/storage/src/storage.ts`)

Building the daemon-level integration test surfaced a genuine convergence
bug: `InstallationCatalog.registerWorkspaceSerialized`'s "already
registered" fast path (`if (existing) return await
this.resolveWorkspaceRegistration(...)`) never re-stamps the physical
`.sqlite` file -- it assumes a catalog row implies an already-initialized
file. That assumption breaks exactly in the scenario this task's recovery
exists for: once `recreateOutdatedWorkspaceDatabase` moves a workspace's
file aside, the immediately-following rescheduled scan's OWN
`registerWorkspace` call, for a workspace whose catalog row already existed
(i.e. one whose outdated-format error surfaced via `openWorkspace`, not
`registerWorkspace`), returned early via that fast path -- leaving
`openWorkspace` to create a brand-new, schema-only file with no
`identity_format` marker at all, and reject it again with the exact
`storage:workspace_format_outdated` error the recovery exists to clear. The
recovery would move the same workspace's database aside once, then loop on
the identical failure forever.

Fixed narrowly: extracted the existing "not yet registered" branch's
physical-stamping logic (open-or-create, contract-byte routing to v3 vs v4
schema/compat, `stampIdentityFormat` for v3) into a new private
`stampFreshWorkspaceDatabase(absolutePath)` method, and call it from BOTH
branches of `registerWorkspaceSerialized` -- the existing "not yet
registered" branch (unchanged behavior, just refactored), and the
"already registered" branch, but ONLY when `!(await
pathExists(absolutePath))` -- i.e. only when the file that SHOULD already
exist for a catalogued workspace has gone missing out from under it. This
never touches the catalog row (already correct; workspace identity has
nothing to do with the physical file's format) and never fires for the
overwhelming common case (a catalogued workspace whose file is present, as
every existing caller of `registerWorkspace` already assumes).

Verified live via a standalone Node repro before and after the fix
(`attempt 1: FAILED code=storage:workspace_format_outdated` ->
`recreated {...}` -> `attempt 2: openWorkspace SUCCEEDED` ->
`post-retry identity row: { value: Uint8Array(9) [...] }` populated), then
via the full test in-process.

### New test: `tests/phase-daemon-recreate-outdated.test.ts`

One test, matrix of three workspaces, matching the task brief:

- **(a)** v2-style: a real, freshly-stamped v3 file (via
  `storage.catalog.registerWorkspace`) whose `index_contract` row is then
  deleted while data already exists in `source_artifacts` -- schema.ts's
  exact "missing index_contract, with data" branch
  (`core:index_contract_unsupported`).
- **(b)** v3 with `identity_format` downgraded to `1`
  (`CURRENT_IDENTITY_FORMAT` is `2`) -- `storage:workspace_format_outdated`.
- **(c)** a genuine, current v4 database, stamped via `ensureV4Workspace`
  directly.

Deliberately does **not** pre-register any of the three in the daemon's own
durable catalog before startup (documented at length in the test file's own
top comment): `DurableStorage.open`'s unconditional startup recovery
(`recoverMigrations`/`recoverWorkspaceGcEpochs`) applies the v3
schema-compatibility check to EVERY already-catalogued workspace
regardless of its actual format -- unlike `openWorkspace`/
`registerWorkspaceSerialized`, it never consults `readIndexContractByte`
first -- so a v4 (or already-outdated) workspace already in the catalog at
construction time would reject `createDurableStorage` (and so
`DaemonRuntime.start()`) entirely, before the daemon ever starts. **This is
a real, separate, pre-existing gap** in `recoverMigrations`/
`recoverWorkspaceGcEpochs` (they should route through
`readIndexContractByte` the same way `openWorkspace` does, and probably
should tolerate/report a genuinely-outdated row rather than crashing
construction). It is explicitly **out of scope** for this task, which
scopes the wiring to `scheduleWorkspaceScan`'s own `openWorkspace`/
`registerWorkspace` call sites (`packages/daemon/src/runtime.ts`) -- flagged
here as a follow-up rather than silently worked around by weakening the
test. Instead, each workspace's `.sqlite` file is stamped directly on disk
at its deterministic default path and registered ONLY in the in-memory
`WorkspaceRegistry` at status `"indexing"` (for a/b) or `"ready"` (for c) --
mirroring the daemon's own documented "crash recovery" startup loop (`for
(const workspace of options.workspace_registry?.list() ?? []) if
(workspace.status === "indexing") scheduleWorkspaceScan(...)`), which is
the actual "at startup" trigger path.

Assertions, once the daemon settles:
- (a) and (b): a `*.v3.stale-<timestamp>/` sibling directory exists,
  containing the exact corrupted file (verified by re-reading its
  `workspace_meta` rows/`source_artifacts` count from the stale copy); a
  fresh, valid file (contract `0x33`, `identity_format` = `2`) exists at
  the original path; each workspace's `last_scan_error` settles on some
  LATER failure (`engine:workspace_scan_empty`, since the fixture root is
  an empty directory and `resolve_plugin_provider` always returns
  `undefined` in this test) rather than staying on the outdated-format
  code -- proving a real rescheduled scan attempt got past
  `registerWorkspace`/`openWorkspace` this time, not just that the move
  happened.
- (c): no stale directory ever appears next to it; the file is
  byte-for-byte and mtime-identical to before the daemon started; its
  registry status stays `"ready"`.

### Test results

```
npx vitest run tests/phase-daemon-recreate-outdated.test.ts tests/recreate-outdated.test.ts
 Test Files  2 passed (2)
      Tests  5 passed (5)
```

Broader regression sweep (everything touched by this task, plus the storage
package's own suite and the pre-existing recreate-outdated/v3-contract
tests the `storage.ts` fix is adjacent to):

```
npx vitest run tests/index-pack-v4.test.ts tests/javascript-typescript-indexing-core-transport.test.ts \
  tests/native-query-snapshot-port.test.ts tests/phase7-reconciliation.test.ts tests/rust-protocol-v4.test.ts \
  tests/v4-scan.test.ts tests/v4-verify.test.ts tests/workspace-fork-v4.test.ts tests/recreate-outdated.test.ts \
  tests/phase-daemon-recreate-outdated.test.ts tests/storage.test.ts tests/phase7-indexing.test.ts \
  tests/phase-daemon-indexing-integration.test.ts tests/phase-daemon-v4-scan.test.ts \
  tests/phase-daemon-admin-integration.test.ts tests/phase-daemon-scan-aggregation.test.ts \
  tests/workspace-v4-schema-gate.test.ts tests/phase-workspace-fork.test.ts tests/merkle-bucket.test.ts
 Test Files  1 failed | 18 passed (19)
      Tests  1 failed | 252 passed (253)
```

The one failure (`index-pack-v4.test.ts`'s "round-trips a v4 workspace
through export -> import with verified roots", `Test timed out in 5000ms`)
is a pre-existing default-vitest-timeout flake under the load of running 19
files' worth of real native-addon scans back-to-back in one process, not a
regression: re-ran that file alone immediately after and it passed cleanly
in 3.57s (2/2 tests). `tests/storage.test.ts` (88 tests, exercises
`registerWorkspace`/`resolveWorkspaceRegistration` extensively, including
the pre-existing "predates content-derived record identity"/"unsupported
pre-v3 index contract" tests the `stampFreshWorkspaceDatabase` refactor sits
directly next to) passed in full, confirming the refactor changed no
existing behavior.

## CPU-load discipline

Checked `pgrep -f "v4-scan|urdira-indexing-worker|v4-mutation-harness|cargo
test"` before every multi-file build/test/typecheck invocation. Two
multi-minute P3-6 n8n benchmark runs (a `cargo test --release`
compile-and-run, twice) were observed live during this session; waited them
out with bounded 30s-poll loops before running anything heavier than a
single-package `tsc --build`/`tsc --noEmit` check, and ran the full
`vitest` regression sweep only once both had exited. No Rust file was read
for content beyond `grep`ing crate names in this doc's own "target/
ignore" fix, and none was edited.

## Files touched

- `eslint.config.mjs` -- `**/target/**` added to root ignores.
- `scripts/v4-spike-extract-relations.mjs` -- explicit `Buffer` import.
- `scripts/v4-mutation-harness.mjs` -- `MANDATED_SCRATCH_ROOT` resolved via
  `os.homedir()` instead of a hardcoded absolute path / literal `~`.
- 17 `docs/evidence/2026-09-0{2,3}-v4-*.md` files -- local path redaction.
- `tests/index-pack-v4.test.ts`, `tests/javascript-typescript-indexing-core-transport.test.ts`,
  `tests/native-query-snapshot-port.test.ts`, `tests/phase7-reconciliation.test.ts`,
  `tests/rust-protocol-v4.test.ts`, `tests/v4-scan.test.ts`, `tests/v4-verify.test.ts`,
  `tests/workspace-fork-v4.test.ts` -- typecheck fixes (Part 1).
- `packages/daemon/src/runtime.ts` -- recreate-outdated wiring (Part 2).
- `packages/storage/src/storage.ts` -- `stampFreshWorkspaceDatabase`
  extraction + missing-file re-stamp fix (Part 2).
- `tests/phase-daemon-recreate-outdated.test.ts` -- new (Part 2).
- `architecture/coverage-gate.json` -- 6 new `required_modules` rows (Part 3).

No commit made. No Rust files edited.
