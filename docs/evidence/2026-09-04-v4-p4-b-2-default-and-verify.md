# v4 P4-b-2: v4 default for new workspaces + full `pnpm verify` gate

Scope: TypeScript/docs only, as instructed. Did not touch
`crates/urdira-indexing-core/src/lib.rs` and other Rust source beyond what
`pnpm verify`'s own `check:native`/`test:native` steps read; did not touch
`packages/engine/src/native-structural-store-binding.ts`,
`packages/plugin-javascript-typescript/src/registry-contribution.ts`,
`tests/native-query-snapshot-port.test.ts`, or `tests/v4-daemon-e2e.test.ts`
(owned by the concurrent P2-2i task). No commit made. Every `cargo`
invocation was preceded by `pgrep -f "cargo|v4-scan|urdira-indexing-worker"`;
one wait (~9 minutes, bounded 30s polls) was needed mid-session while another
agent ran `cargo fmt`/`cargo clippy` on `urdira-jsts-syntax-worker` -- see
"Rust findings" below, which turned out to be investigating the exact same
spot this task's own `check:native` run had just flagged.

## 1. Decision points touched

### 1.1 The default flip itself

`isV4Enabled()` (`packages/daemon/src/runtime.ts`), previously:

```ts
function isV4Enabled(): boolean {
  return process.env["URDIRA_V4"] === "1";
}
```

now:

```ts
function isV4Enabled(): boolean {
  return process.env["URDIRA_V4"] !== "0";
}
```

This is the **only** place the decision is made. Every workspace-registration
path already funneled through `maybeBootstrapV4Workspace`/
`ensureWorkspaceCatalogRegistration`/`scheduleWorkspaceScan`'s own call to it
(confirmed by reading every call site -- `packages/daemon/src/runtime.ts`
lines ~1740-1754, ~2714, ~2992) before this task; the daemon's
`core:workspace_add` RPC, the CLI (`packages/cli`, which only ever calls that
RPC), and the web UI (`packages/web`, same RPC) all resolve through this one
function -- neither `packages/cli/src` nor `packages/web` reads
`process.env["URDIRA_V4"]` itself (grepped, zero matches). No new call site
was needed.

`URDIRA_V4=1` still selects v4 (redundant with the new default -- kept so
nothing that already sets it explicitly needs to change). The flag continues
to only affect a workspace whose database file does not exist yet;
`ensureV4Workspace` no-ops the instant that file is already present, so an
existing v3 (or v4) workspace's format is never touched by this flip -- no
migration, per the task brief.

### 1.2 Startup log line (v3 vs v4 workspace counts)

Added to `DurableStorage` (`packages/storage/src/storage.ts`):

- `v3WorkspaceCount`/`v4WorkspaceCount` private counters, incremented inside
  `recoverMigrations`'s existing per-workspace sweep (the one that already
  opens every catalogued, on-disk-present workspace at `DurableStorage.open()`
  and reads its `index_contract` byte to route schema/compatibility checks --
  see `docs/evidence/2026-09-04-v4-p4-b-prep-health.md`). Counting there
  reuses that sweep's own file opens; no new I/O. Counted only once (in
  `recoverMigrations`, not also in `recoverWorkspaceGcEpochs`, which iterates
  the identical workspace list -- counting in both would double-count every
  non-outdated workspace).
- Public getter `DurableStorage.workspaceFormatCounts: { v3: number; v4:
  number }`, alongside the existing `outdatedWorkspaces` getter.
- `DaemonRuntime.start` (`packages/daemon/src/runtime.ts`), right after the
  existing "reflect `outdatedWorkspaces` into the registry" block, logs:

  ```
  [urdira] startup: <N> v3 workspace(s), <M> v4 workspace(s) registered under <data_root> (new workspaces default to v4; set URDIRA_V4=0 to opt out)
  ```

  Only when `indexingStorage` was constructed at all (i.e. a real
  `workspace_registry` + `resolve_plugin_provider` were supplied -- the same
  condition that gates every other workspace-scanning feature in this
  function).

Verified live: this line appears once per `DaemonRuntime.start()` in the
`tests/v4-daemon-e2e.test.ts` background run (see §3), correctly reporting
`0 v3 workspace(s), 0 v4 workspace(s)` for a fresh data root in both of that
test's two daemons.

### 1.3 Test-suite-wide default, and why

The overwhelming majority of this repository's ~2,000 pre-existing tests
start a `DaemonRuntime`/`DurableStorage` to exercise v3-only behavior and
never wire `DaemonRuntimeOptions.resolve_workspace_scan_transport`. Under a
bare default flip, every one of those would try (and fail, with "No v4
workspace-scan transport is configured...") to bootstrap and scan a v4
workspace instead of the v3 behavior they actually test. Rather than editing
~100+ test files individually, `vitest.config.ts` gained one line:

```ts
env: { URDIRA_V4: "0" },
```

with a comment explaining the rationale. This sets the suite-wide baseline
back to v3 for every test file's `process.env` before that file's module
code runs (verified live: `tests/phase-daemon-v4-scan.test.ts`'s
`const originalFlag = process.env["URDIRA_V4"];`, captured at module load
time, now correctly reads `"0"`). A test that wants the v4 route -- or wants
to exercise the real production default -- still overrides
`process.env.URDIRA_V4` itself at runtime, exactly as it did before this
task (every existing v4 test already does this).

This is the mechanism called for by the task brief's "keep explicit v3 tests
by setting `URDIRA_V4=0` in them" -- applied once, centrally, instead of
per-file, since the number of files that need it is effectively "all of
them."

### 1.4 Tests updated because the assertion was literally about the default

`tests/phase-daemon-v4-scan.test.ts`:

- The pre-existing test "does not bootstrap v4 for a workspace added while
  URDIRA_V4 is unset (v3 stays untouched)" encoded the OLD default as
  correct behavior. Renamed to "does not bootstrap v4 for a workspace added
  with URDIRA_V4=0 (opt-out honored)" and changed its
  `delete process.env["URDIRA_V4"]` to `process.env["URDIRA_V4"] = "0"` --
  same assertions, now exercising the opt-out contract instead of a default
  that no longer exists.
- Added a new test, "bootstraps v4 by default when URDIRA_V4 is left unset
  (P4-b-2 default flip)": deletes the flag (not `startV4Daemon`'s helper,
  which always wires a transport regardless -- this test needs the bare
  `isV4Enabled()` default itself, with nothing else masking it), starts a
  real `DaemonRuntime` with a fake v4 transport wired, and asserts the
  workspace is bootstrapped as v4 (`structural/` directory present,
  `readStructuralStore(...) === "native"`, one `Full`-scope scan call) with
  no explicit `"1"` anywhere. This is the direct test of the new production
  default.
- Both tests, plus the file's pre-existing six, pass:
  `npx vitest run tests/phase-daemon-v4-scan.test.ts` -> 8/8.

No other test file was found (grepped for "default"/"v3 by default"/"v4
default" near `URDIRA_V4`) that asserted the flag's default value as its own
subject.

### 1.5 A real, pre-existing test bug the new log line exposed and fixed

`tests/phase-daemon-indexing-integration.test.ts`'s "creates the durable
workspace registration before readiness polling can observe indexing" had:

```ts
expect(errorSpy.mock.calls.flat().map((call) => call.map(String).join(" ")).join("\n")).not.toContain("workspace fork skipped");
```

`.mock.calls` is already an array of per-call argument arrays; the stray
`.flat()` merges every call's own arguments together, so each element of the
flattened array is a single argument (often a string), not a call -- and
`.map` was then invoked on that string, which has no `.map` method. This was
silently masked before this task because `errorSpy` (and the identical
`warnSpy` pattern one line above) never actually captured a call in this
test path, so `.flat()` produced `[]` and `.map()`'s callback never ran. This
task's new startup log line is `console.error(...)`, which is exactly what
`errorSpy` spies on -- the very first non-empty call this assertion ever saw
-- and the latent bug surfaced as `TypeError: call.map is not a function`.
Fixed by removing the erroneous `.flat()` from both the `warnSpy` and
`errorSpy` lines (the intended, and now correct, transform is
`.map((call) => call.map(String).join(" "))` directly over `.mock.calls`).
Re-ran the file: 16/16 pass.

## 2. Docs

- **`docs/versioning.md`**: replaced the closing "As of this note, v4 is
  opt-in... no default flip" sentence with a new "Default flip (2026-09-04,
  P4-b-2)" section stating the exact flag semantics, that this is a routing
  decision (not a migration), that a v3 workspace keeps working forever with
  no auto-conversion, the startup log line, the opt-out's one-release intent,
  and the test-suite baseline mechanism (§1.3).
- **`docs/README.md`**: both `URDIRA_V4=1` ("opt-in") mentions reworded to
  "the default for newly added workspaces; opt out with `URDIRA_V4=0`"; added
  one paragraph naming the four on-disk siblings a v4 workspace creates
  (`<safeId>.structural/`, `<safeId>.sidecar/`, `<safeId>.lexical.sqlite`,
  `<safeId>.semantic.sqlite`), sourced from `workspace-v4-bootstrap.ts`'s own
  path-builder functions (`structuralStoreDirFor`, `sidecarScanDirFor`,
  `sidecarDatabasePathFor`) and decision 26's directory-layout section.
- **`docs/decisions/26-v4-structural-store.md`** / **`29-v4-rust-owned-scan-pipeline.md`**:
  status lines updated to record the default flip (2026-09-04); decision 29's
  "Open items" bullet ("`URDIRA_V4=1` default-flip... unaddressed (P4)")
  replaced with "Default-flip is DONE... existing-workspace migration
  remains unaddressed."
- **`README.md`** (root, public-facing): added one paragraph after the
  semantic-search-download note, naming the v4 default, the `URDIRA_V4=0`
  opt-out (one release), the sidecar/structural files created, and that
  neither format auto-migrates into the other.
- **`AGENTS.md`**: read in full; grepped for `v3`/`v4`/`index`/`storage`/
  `format` -- it carries no storage-layout or index-format invariant to
  update (its four hits are unrelated: a decision-index pointer, a workspace/
  storage *behavior* inspection instruction, and one artifact-retention
  sentence). No change made.
- **CLI/web**: grepped `packages/cli/src`, `packages/web` for `URDIRA_V4` --
  no matches; both only ever call the daemon's `core:workspace_add` RPC, so
  they inherit the flip automatically via §1.1's single decision point. No
  code or doc change needed there.

## 3. `pnpm verify`, end to end

Machine confirmed idle (`pgrep -f "cargo|v4-scan|urdira-indexing-worker|v4-mutation-harness"`)
before every step; one step (`test:coverage`'s full vitest run) ran ~9
minutes wall, during which another agent's `cargo fmt`/`cargo clippy` on
`urdira-jsts-syntax-worker` was observed live and waited out (bounded 30s
polls) before re-running the two suspect test files in isolation (§3.1).

| Step | Command | Result |
| --- | --- | --- |
| `check:architecture` | `node scripts/check-architecture.mjs` | **PASS** -- "Architecture checks passed for 16 workspace packages." |
| `check:native` | `cargo fmt --all -- --check && cargo clippy --workspace --all-targets --locked -- -D warnings` | **FAIL** -- 2 Rust findings, not fixed (out of scope; reported precisely below) |
| `test:native` | `cargo test --workspace --locked` | **PASS** -- every crate reported `test result: ok`, 0 failures across the workspace (largest suites: 154, 71, 43, 39, 33x2 passed) |
| `lint` | `eslint .` | **PASS** -- 0 errors, 0 warnings |
| `test:coverage` | `pnpm --filter ... build ... && URDIRA_PACK_IDENTITY_BOUND_MS=60000 vitest run --coverage` | **3 failed \| 134 passed \| 2 skipped (139 files)**; **3 failed \| 2062 passed \| 11 skipped (2076 tests)** -- see §3.1 for each failure's disposition |
| `typecheck` | `tsc --build --force` | **PASS** -- 0 errors |
| `check:coverage-gate` | `node scripts/check-coverage-gate.mjs` | **PASS** -- "measured repository lines 90.02% (27435/30478), critical branches 100.00% (15/15), semantic regions 100.00%." |
| `check:publication` | `node scripts/check-publication.mjs` | **PASS** -- "Publication hygiene passed (973 files checked)." |

Coverage detail from the `test:coverage` run itself:

```
Statements   : 83.91% ( 42264/50363 )
Branches     : 73.67% ( 35609/48334 )
Functions    : 80.97% ( 8498/10495 )
Lines        : 90.01% ( 27435/30478 )
```

(The 90.01% vs. the gate script's 90.02% is the same fraction, 27435/30478,
rounded slightly differently by vitest's own reporter vs.
`check-coverage-gate.mjs`'s arithmetic -- not two different measurements.)

### 3.1 The three `test:coverage` failures

| # | File | Failure | Disposition |
| - | --- | --- | --- |
| 1 | `tests/index-pack-v4.test.ts` | "rejects importing a pack with sidecar/ entries when no targetSidecarRoot is given" -- `Test timed out in 5000ms` | **Pre-existing, unrelated flake.** Matches the documented full-suite-CPU-contention pattern (`docs/evidence/2026-09-04-v4-p4-b-prep-health.md` Part 2 #3 / P4-b-1 Item 3). Re-ran the file alone on a confirmed-idle machine: `5/5 passed in 8.01s`. |
| 2 | `tests/phase-canonical-query-data-port.test.ts` | "loadAllRecords round-trips a corpus spanning multiple SQL row-fetch batches..." -- `Test timed out in 60000ms` | **Pre-existing, unrelated flake**, same class. Re-ran the file alone on a confirmed-idle machine: `79/79 passed in 21.79s`. Nothing in this task touched this file or `canonical-query-data-port.ts`'s batching logic. |
| 3 | `tests/v4-daemon-e2e.test.ts` | "scans task-planner's task.ts/errors.ts through the real Rust worker..." -- `pollUntilReady` timed out after 120000ms, `last_scan_error_code: "core:workspace_scan_failed"` | **Real, precisely-diagnosed conflict with this task's own change -- NOT fixed, file is off-limits (owned by concurrent task P2-2i).** See below. |

**Finding #3 in detail.** This test (untracked, actively edited by the
concurrent P2-2i task this session -- native release artifacts under
`release/native/darwin-arm64` were rebuilt today, so `describeIfBuilt` runs
it for real rather than skipping) starts a v4 daemon
(`process.env["URDIRA_V4"] = "1"`, line 343), then, to get a v3 comparison
index of the identical fixture files, does:

```ts
// tests/v4-daemon-e2e.test.ts:447-453
// `maybeBootstrapV4Workspace` (`packages/daemon/src/runtime.ts`) checks
// `process.env.URDIRA_V4` globally, not per-`DaemonRuntime` -- it must
// be unset before the v3 comparison daemon below registers its own
// workspace, or that workspace would ALSO be v4-bootstrapped and its
// scan would fail (no `resolve_workspace_scan_transport` configured
// for this v3-only runtime).
delete process.env["URDIRA_V4"];
```

and again at line 571 in its outer `finally`. Before this task, `delete`
correctly forced v3 (the old default). After this task's flip
(`isV4Enabled()` now returns `true` whenever the flag is not the exact string
`"0"`), the same `delete` leaves the flag **unset**, which now means v4 --
so the "v3 comparison" `DaemonRuntime` (constructed with
`resolve_plugin_provider: resolveV3PluginProvider` and no
`resolve_workspace_scan_transport` at all) gets its workspace v4-bootstrapped
and then fails every scan with `"No v4 workspace-scan transport is
configured for workspace ... (URDIRA_V4 requires
DaemonRuntimeOptions.resolve_workspace_scan_transport to be wired by the
composing application)."` -- confirmed live, exact error reproduced twice
(once standalone, once inside the full `test:coverage` run).

**Fix (not applied -- file ownership, not correctness, is what blocks it)**:
replace both occurrences of `delete process.env["URDIRA_V4"];`
(`tests/v4-daemon-e2e.test.ts:453` and `:571`) with
`process.env["URDIRA_V4"] = "0";`. This is a two-line, purely mechanical
change with no other consequence: every other assertion in the file is
unaffected, and it makes the test's own stated intent ("must be unset before
the v3 comparison daemon...") literally true again under the new default
semantics. Flagging this precisely for whoever lands `tests/v4-daemon-e2e.test.ts`
next (task P2-2i or its successor) rather than silently working around it in
`runtime.ts` (which would mean re-introducing exactly the "unset means v3"
default the task explicitly asked to remove) or editing the forbidden file
myself.

## 4. Rust findings (`check:native`, not fixed -- reported per instructions)

`cargo fmt --all -- --check` (exit 1):

```
Diff in ~/Proyectos/urdira/crates/urdira-jsts-syntax-worker/src/semantic_sites.rs:3059:
                 )
             })
             .collect();
-        self.finish_heritage_clause_group("implements", implements_entries, self_class_id.as_deref());
+        self.finish_heritage_clause_group(
+            "implements",
+            implements_entries,
+            self_class_id.as_deref(),
+        );
```

`cargo clippy --workspace --all-targets --locked -- -D warnings` (run
standalone since the `&&` chain never reaches it once `fmt --check` fails;
exit 101, same file):

```
error: fields `start`, `end`, `source_id`, and `reason` are never read
   --> crates/urdira-jsts-syntax-worker/src/semantic_sites.rs:573:5
    |
572 | struct PendingCallSite {
    |        --------------- fields in this struct
573 |     start: u32,
574 |     end: u32,
575 |     source_id: String,
576 |     reason: &'static str,
    = note: `-D dead-code` implied by `-D warnings`

error: fields `start`, `end`, `source_id`, `relation_kind`, and `reason` are never read
   --> crates/urdira-jsts-syntax-worker/src/semantic_sites.rs:583:5
    |
582 | struct PendingHeritageSite {
    |        ------------------- fields in this struct
583 |     start: u32,
584 |     end: u32,
585 |     source_id: String,
586 |     relation_kind: &'static str,
587 |     reason: &'static str,

error: could not compile `urdira-jsts-syntax-worker` (lib) due to 2 previous errors
error: could not compile `urdira-jsts-syntax-worker` (lib test) due to 2 previous errors
```

Both findings are confined to `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`
(one formatting diff at line 3059, two dead-code struct-field errors at lines
573-576/583-587). Note `test:native` (`cargo test --workspace --locked`,
which does not pass `-D warnings`) compiles and passes this same crate fine
-- `dead_code` is a warning there, not a denied error -- so this is
specifically a `clippy -D warnings` (and `fmt --check`) gate failure, not a
build or test regression. Neither file nor crate was edited; this was
observed being actively worked on by another agent mid-session (§ intro).

## 5. What's left red

| Item | Owner | Why not fixed here |
| --- | --- | --- |
| `tests/v4-daemon-e2e.test.ts:453,571` -- `delete process.env["URDIRA_V4"]` needs to become `process.env["URDIRA_V4"] = "0"` | P2-2i (file owner) | Explicit do-not-touch file for this task |
| `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs:3059` -- `cargo fmt` diff | Rust owner (P2-2i / crate owner) | TS-only task scope; no Rust edits permitted |
| `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs:573-576,583-587` -- dead-code clippy errors (`PendingCallSite`/`PendingHeritageSite` fields never read) | Rust owner | Same |
| Existing-workspace v3->v4 migration | Unassigned (decision 29 "Open items") | Explicitly out of scope for this task -- the brief asked only for the default flip, not migration |

Everything else in `pnpm verify` (`check:architecture`, `test:native`,
`lint`, `test:coverage`'s TS results modulo the two confirmed pre-existing
flakes, `typecheck`, `check:coverage-gate`, `check:publication`) is green.

## 6. Files touched

- `packages/daemon/src/runtime.ts` -- `isV4Enabled()` flip + doc comment,
  startup log line, one comment-wording fix near the recreate-outdated
  branch.
- `packages/storage/src/storage.ts` -- `v3WorkspaceCount`/`v4WorkspaceCount`
  counters, `workspaceFormatCounts` getter.
- `vitest.config.ts` -- suite-wide `env: { URDIRA_V4: "0" }` baseline.
- `tests/phase-daemon-v4-scan.test.ts` -- renamed/adjusted the
  now-obsolete "unset means v3" test into an explicit opt-out test; added a
  new test for the true default.
- `tests/phase-daemon-indexing-integration.test.ts` -- fixed the pre-existing
  `.flat()` bug the new log line exposed.
- `docs/versioning.md`, `docs/README.md`, `docs/decisions/26-v4-structural-store.md`,
  `docs/decisions/29-v4-rust-owned-scan-pipeline.md`, `README.md` -- default-flip
  documentation (§2).

No commit made, per task instructions.
