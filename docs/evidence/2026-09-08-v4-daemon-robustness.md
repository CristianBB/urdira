# D-1: daemon robustness fixes from the VS Code campaign's live findings

Implements Frente **D-1** (plan `generic-waddling-hartmanis.md` §0) against the P0s reported live
in `docs/evidence/2026-09-07-v4-vscode-campaign.md` §4/§6/§9: (1) a failed scan leaving a workspace
reporting `status: "indexing"` forever with no visible error; (2) v3's cold-scan pipeline aborting
the entire scan on any one file whose JS/TS facts come back incomplete; (3) `core:index_pack_export`
timing out on a large export because it was never in the CLI transport's own long-running deadline
list; (4) no product-exposed `import_wall_ms` metric for a pack import; (5) a confirmation-only item,
the `KQUEUE_FILE_WATCH_BUDGET` EBADF fix already shipped in Frente S-E.

Base: `main` at `a07e379` (worktree reset to this commit per the task's own §0 instruction; the
worktree had drifted to a later, unrelated commit `7d04d49` before the reset). Branch renamed to
`frente-d1-daemon-robustness`.

---

## 0. Build

`CI=true pnpm install --offline --frozen-lockfile` in the worktree's own `node_modules` (never a
symlink), `packages/native/prebuilds`/`release`/`target/release` copied in from the shared checkout
per the task's own §0 instructions. `URDIRA_TSGO_BINARY` pinned to
`node_modules/.pnpm/@typescript+typescript-darwin-arm64@7.0.2/.../tsc` for the build chain (the
`test` script's own chain, minus `vitest run`). `cargo build --release -p urdira-indexing-worker`
rebuilt after the Rust fix (item 2) -- its output was copied over
`packages/native/prebuilds/aarch64-apple-darwin/urdira-indexing-worker` (the path
`apps/urdira/src/index.ts`'s `packagedIndexingCorePath` resolves to next to the jsts-syntax-worker
prebuild) so the daemon's own dev-mode native resolution picks up the fixed binary; the shared
checkout's own stale prebuild there would otherwise silently mask the fix for anything that exercises
the real binary (the EBADF confirmation in §5 below, and any future daemon-level v3 test).

`pnpm typecheck` and `pnpm lint` both green on this diff. `pnpm run typecheck` (`tsc --build
--force`) independently reproduces 5 pre-existing errors in `tests/fixtures/codebases/typescript/{
barrel-method-call,multi-hop-barrel-rename}` (relative-import-extension/module-resolution errors)
on a clean `git stash` of this session's own diff too -- confirmed pre-existing, unrelated to this
task's files.

---

## 1. P0: a failed scan leaves `status: "indexing"` forever (root cause, file:line)

**Root cause**, exact: `packages/engine/src/workspaces.ts`'s `WorkspaceRegistry#recordScanFailure`
(pre-fix, lines 473-476) only ever set `last_scan_error`/`last_scan_error_at` -- it never touched
`status`. `packages/daemon/src/runtime.ts`'s scan job terminal-failure handler (pre-fix, around line
3652-3655) called `recordScanFailure` unconditionally, then called `registry.markReady(workspaceId,
priorSnapshotId, "degraded")` **only `if (priorSnapshotId !== undefined)`** -- `markReady` itself
throws on an empty snapshot id (`workspaces.ts`, `if (snapshotId.length === 0) throw ...`), so a
workspace's very first-ever scan (`priorSnapshotId === undefined`, i.e. `workspace.current_snapshot_id`
was never set before this attempt) had literally no snapshot for that re-pin call to target. The
`if` guard simply skipped it, and `status` stayed at whatever `beginReconciliation` had set earlier:
`"indexing"`, forever. Confirmed as a DELIBERATE prior design choice, not an oversight:
`recordScanFailure`'s own pre-fix doc comment read "...(or leave the workspace `"indexing"` on a
first-ever-scan failure)".

Live evidence this reproduces exactly: `docs/evidence/2026-09-07-v4-vscode-campaign.md` §4.0 -- a
v3 scan against the unmodified 18,049-file VS Code tree failed at t=83.9s
(`core:engine_failed: JS/TS facts are incomplete for
extensions/copilot/.../fixtures/5710.selection.ts`), and `core:workspace_admin_show` reported
`status: "indexing"` for over 100 minutes afterward while `ps` confirmed the daemon process alive
with only a few seconds of *total* CPU time consumed -- genuinely idle, not slow.

**Important correction discovered while root-causing this**: `last_scan_error`/`last_scan_error_at`
were ALREADY being recorded correctly and were ALREADY visible in both `core:index_status`'s
`last_scan_error_code`/`last_scan_error_at` fields and `core:workspace_admin_show`'s raw
`last_scan_error`/`last_scan_error_at` (via `workspaceAdministrativeView`'s `...workspace` spread) --
and the MCP `urdira_index_status` renderer (`packages/mcp/src/index.ts`) already had a
`last_scan_error: <code> at <at>` line. The campaign's own harness simply keyed off `workspace_status`
alone and never inspected those fields, which is exactly the realistic failure mode this fix
closes: the fields were correct but easy to miss because the STATUS FIELD ITSELF never left
`"indexing"`.

**Fix** (see `docs/decisions/09-configuration-security-lifecycle.md`'s 2026-09-08 amendment for the
full mechanism writeup): `WorkspaceRegistry#recordScanFailure`
(`packages/engine/src/workspaces.ts`) now flips `status` straight to `"degraded"` itself whenever
`workspace.status === "indexing" && workspace.current_snapshot_id === undefined` (no prior
generation, and no intermediate structural stage published this same failed attempt either).
`packages/daemon/src/runtime.ts`'s catch block was separately hardened to re-pin against the
FRESHEST snapshot id (re-read from the registry after `recordScanFailure` runs), not just the
stale `priorSnapshotId` captured before the scan started -- covering the case where an intermediate
stage published mid-scan before a LATER failure. No new `WorkspaceStatus` enum member was added:
the existing `"degraded"` value plus `current_snapshot_id`'s presence/absence plus
`last_scan_error`/`last_scan_error_at` together already unambiguously distinguish "prior index still
usable" from "no index at all, last attempt failed" -- and every downstream consumer that gates on
`workspace.status` already treats `"degraded"` uniformly regardless of snapshot presence
(`beginReconciliation`, `core:reindex`, RPC admission, orphan-sweep classification), so no other call
site needed to change.

`core:reindex` needed NO change: it was already unconditional on the workspace's current status
(`beginReconciliation` is idempotent against `"indexing"` and otherwise transitions from any other
status). `urdira workspace show` (CLI) gained a small human-readable summary line
(`workspace: <id> (<root>)`, `status: <status>`, `last_scan_error: <code> at <at>` when set) ahead
of the raw JSON for non-`--json` output.

**Test**: `tests/phase-daemon-v4-scan.test.ts`'s existing `"records a diagnosable
last_scan_error_code when URDIRA_V4=1 but no resolve_workspace_scan_transport is configured"` test
previously asserted the OLD buggy behavior verbatim (a comment explained why `workspace_status`
stayed `"indexing"`) -- updated to assert `"degraded"`, and extended to call `core:reindex`
afterward and confirm the workspace re-enters `"indexing"` then settles back to a FRESH `"degraded"`
(a new `last_scan_error_at`), proving live recovery rather than by inspection. `11/11` tests in that
file pass.

---

## 2. P0: v3 aborts the whole scan on one file's incomplete facts (root cause, file:line)

**Root cause**, exact: `crates/urdira-indexing-worker/src/main.rs`'s `run_jsts_generation`
(pre-fix, lines 4095-4097):
```rust
if !parsed || !diagnostics.is_empty() {
    return Err(CoreError(format!("JS/TS facts are incomplete for {path}")));
}
```
inside a `for page in pages` loop consuming `WorkerMessage::FactsResult` pages for a whole BATCH of
files in one generation. The very first page whose oxc parse failed OR carried ANY non-empty
diagnostic list aborted the function with `Err`, which propagates via `?` to the IPC command handler
at `main.rs` line ~2402 (`let summary = run_jsts_generation(...)?;`), caught generically and turned
into `IndexingEvent::Error{code: "core:engine_failed", ...}` -- failing the ENTIRE candidate
generation, not just the one file. `mark_candidate_failed` (line 3869) is called on this path with
no per-file partial-result mechanism at all.

**Why v4 never hit this**: v4's own scan pipeline (`crates/urdira-indexing-worker/src/v4/analyze.rs`)
does not call `run_jsts_generation` at all -- it calls `syntax.facts_for_paths(...)` directly (line
~772), which returns a `FactsForPath` per file with no completeness check whatsoever. This confirms
the evidence doc's own observation (§4.1): v4 scanned the exact same 6 offending VS Code files
(5 intentionally-malformed test fixtures plus `scripts/xterm-update.js`, a legitimate CommonJS
build script using a bare top-level `return`) three times over with no issue, while v3's
`run_jsts_generation` is the ONE place in the whole codebase with this abort-on-incomplete check
(confirmed: `grep "facts are incomplete"` matches exactly once).

**Fix**: the abort was replaced with a per-file skip: the offending path's structural records are
not published for this generation (removed from `direct_files_by_path`/`imports_complete_by_path`/
`next_sequence_by_path`), logged clearly to stderr
(`[urdira-indexing-worker] JS/TS facts incomplete for <path> (parsed=<bool>, N diagnostic(s)); skipping
this file's structural records for this generation, continuing the scan`), recorded in a new
`incomplete_fact_paths: Vec<String>` field on `JstsGenerationSummary` (threaded through
`IndexingEvent::Progress`'s own new `incomplete_fact_paths: Option<Vec<String>>` field,
`crates/urdira-worker-protocol/src/lib.rs`, backward-compatible via `#[serde(default,
skip_serializing_if = "Option::is_none")]`), and marked in the file's own `dependency_graph` entry
as `{"direct_files": [], "complete": false, "incomplete_facts": true}` -- the existing
`isValidSyntaxDependencyGraph` validator on the TS side (`packages/plugin-javascript-typescript/src/
worker.ts`) only checks `direct_files`/`complete`'s presence/types, so the extra `incomplete_facts`
key round-trips through the gzip-cached dependency graph untouched, forward-compatible for a future
consumer. The `for page in pages` loop then `continue`s to the next page/file instead of returning --
every other file in the same batch (and every later batch) is unaffected.

**Scope note, stated plainly**: this pass stops at the Rust engine boundary plus the wire-protocol
field. Wiring `incomplete_fact_paths`'s count all the way into `core:index_status` as a structured,
per-workspace "N files with a diagnostic" surface would need the SAME information to also flow
through `packages/plugin-javascript-typescript`'s own generic plugin-sdk `analyze()` result contract
(which has no existing `diagnostics`/`limitations` free-form field to attach it to today) and then
through `packages/engine`'s `CandidateMaterializer`/completeness-claim machinery (the SAME
`CompletenessClaim`/`reason_codes: ["jsts:unsupported_syntax"]` shape already defined for exactly
this purpose in `packages/plugin-javascript-typescript/src/registry-contribution.ts`, but only ever
emitted today by a DIFFERENT, per-work-item semantic-checker function, not by the batched syntax-lane
loop this fix touches) before it could reach `core:index_status`'s
`structural_progress[].completeness` field. That is real, additional plumbing (4 more files/layers)
this pass's time budget did not include -- flagged as a follow-up, not implemented here. What IS
delivered and tested: the scan genuinely does not abort, the good files in the same batch DO publish
their records, and the exact skipped path IS reported in the wire protocol
(`incomplete_fact_paths`)/the dependency graph (`incomplete_facts: true`) for any caller already
consuming that data today or in the future.

**Test**: new Rust unit test
`run_jsts_generation_skips_a_file_with_incomplete_facts_instead_of_aborting`
(`crates/urdira-indexing-worker/src/main.rs`'s own `tests` module) -- two files, one genuinely
broken (`const x = ;`, the same class of syntax error as the VS Code fixtures) and one valid
(`export const answer = 42;`). Asserts: the generation returns `Ok` (previously `Err`, aborting);
`summary.incomplete_fact_paths == ["bad.ts"]`; `summary.owner_count >= 1` (the valid file's own
record still published); `summary.dependency_graph["bad.ts"].incomplete_facts == true`. `cargo test
-p urdira-indexing-worker` (the crate's full suite): **152 passed, 0 failed, 19 ignored** (the
ignored tests need `URDIRA_TSGO_BINARY`/an n8n corpus, unrelated to this fix).

---

## 3. `core:index_pack_export` RPC timeout — design and mechanism

See `docs/decisions/23-index-pack.md`'s 2026-09-08 amendment for the full writeup (rejected
alternative, exact mechanism, compatibility notes). Summary:

- **Root cause**: `core:index_pack_export` was never in `apps/urdira/src/index.ts`'s `longRunning`
  set, so a plain CLI call got the IPC transport's hardcoded 30s default deadline
  (`packages/daemon/src/protocol.ts`'s `LocalIpcClient`, `request_timeout_ms ?? 30_000`) instead of
  `adminRequestTimeoutMs` (300s) -- confirmed live in the campaign at exactly 30,002ms.
- **Fix, two independent parts**:
  1. `core:index_pack_export` now gets its OWN deadline, computed per-call in `apps/urdira/src/
     index.ts`: 24 hours by default (`INDEX_PACK_EXPORT_DEFAULT_TIMEOUT_MS`), or `--timeout
     <seconds>` (new CLI option on `index-pack-export`, `packages/cli/src/index.ts`) when the caller
     wants a real bound -- "sin límite de tiempo salvo `--timeout`".
  2. The daemon's own `core:index_pack_export` handler (`packages/daemon/src/runtime.ts`) now streams
     real progress over the SAME connection every 1s (`context.reportProgress`, the identical
     mechanism `core:workspace_preview`'s file-discovery progress already uses) -- `completed` is the
     output file's own growing byte size (`stat`), `total` a best-effort one-time estimate
     (`structural/` directory size + the sqlite catalog's own size, via a new
     `directorySizeBytesForProgressEstimate` helper, never fatal to the export on any I/O error).
- **Result shape**: `pack_path` (the design's own field name) added alongside the pre-existing
  `out_path` on both the v4 and v3 export branches (backward compatible); `export_wall_ms` added to
  both.
- **Rejected alternative, and why**: a detached `{operation_id, status: "running"}` + separate poll
  RPC (the shape this task's plan text first described) was considered and explicitly NOT
  implemented this pass -- it is a materially larger feature (a server-side operation registry with
  its own lifecycle/TTL/cleanup, and re-attach-by-id semantics for a NEW caller after the original
  one disconnects) that this task's time budget did not include. The mechanism shipped here closes
  the actual P0 (a legitimate large export aborting on an internal-only deadline) without that
  additional surface; flagged as a genuine follow-up for a caller that needs the export to survive
  its own process being killed.

**Test**: new test in `tests/app-runtime.test.ts` (`"gives core:index_pack_export an effectively
unbounded deadline by default, honors --timeout, and forwards progress"`) uses a fake
`LocalIpcServer` to observe the exact `deadline_at` sent -- confirms ~24h by default, confirms
`--timeout 5` overrides it to ~5s, confirms an `index_pack_export` progress phase reaches
`on_progress`.

---

## 4. `import_wall_ms`

`importPendingV4IndexPack` (`packages/daemon/src/runtime.ts`) now returns `{imported, import_wall_ms,
pack_bytes?}` instead of a bare `boolean`, measuring its own whole body (stat + native copy/verify +
atomic rename) regardless of outcome. `runV4WorkspaceScan` threads this into a new
`V4LastScanSummary.import` field (set only when the scan followed a pack import), surfaced as
`last_scan.import` in `core:index_status`'s v4 status fields and rendered as an extra clause on the
MCP `urdira_index_status` renderer's `last_scan:` line
(`import=ok|failed (<bytes> bytes, import_wall_ms=<ms>)`).

**Test**: `tests/phase-daemon-v4-index-pack.test.ts`'s existing byte-identical-tree import test
extended to assert `last_scan.import.{imported: true, import_wall_ms >= 0, pack_bytes > 0}` after a
real pack import against the real worker binary reaches `ready`. Also asserts the new
`pack_path`/`export_wall_ms` fields on the export test. `5/5` (1 skipped, environment-gated)
tests in that file pass.

---

## 5. EBADF confirmation (S-E fix, no code touched)

Per the task's own instruction, `packages/engine/src/semantic-*`/`packages/daemon/src/semantic-*`
were not touched -- this section only confirms `docs/evidence/2026-09-07-v4-semantic-close.md`'s
§2.1 fix (`KQUEUE_FILE_WATCH_BUDGET = 2000` fs-events fallback in
`packages/engine/src/watchers.ts`/`packages/daemon/src/runtime.ts`'s `startWorkspaceWatcher`) still
holds, live, on this session's own rebuilt binaries.

**Setup**: a real 2,295-file workspace (`packages/cli` from the `n8n-corpus-2026-09-02` benchmark
corpus, TS/JS files only, `node_modules` excluded, 24MB) -- above the 2,000-file kqueue budget, so
this exercises the fs-events fallback path, not kqueue. Real daemon (`apps/urdira/dist/cli.js`),
real worker binary (this session's own freshly rebuilt `target/release/urdira-indexing-worker`,
copied into `packages/native/prebuilds/aarch64-apple-darwin/` so the daemon's dev-mode native
resolution picks it up -- `URDIRA_INDEXING_CORE_WORKER_PATH` pointed at it directly, bypassing the
packaged-install-only `URDIRA_NATIVE_REQUIRED=1` path, which requires declared optional
dependencies this dev-tree layout does not have), `URDIRA_SEMANTIC_INDEX=1` (semantic maintenance
ON, specifically to confirm it starts without EBADF).

**Result: confirmed, live, fd count O(1).** `workspace-add --confirm` against the 2,295-file tree
(walker's own broader count: 2,492 files inspected, `[urdira] workspace discovery complete (2492
files inspected)`) reached `status: "ready"` on the FIRST poll (well under a minute). `lsof -p
<daemon pid>` immediately after `ready`: **32 total file descriptors** -- comfortably inside the
plan's own "< 200 + parcel watchers" target and matching S-E's own reported 29-33 range almost
exactly. Critically, **zero** `REG` (regular-file) descriptors matching a corpus source file were
present -- the full `lsof` listing shows only the daemon's own binaries/libraries (`node`, `dyld`,
`@parcel/watcher`'s native addon), the catalog sqlite files, `/dev/null`, a handful of `KQUEUE`
descriptors (the daemon's own internal event loops, not per-file watches), and unix-domain sockets
(the daemon's own RPC listener plus its worker-thread/child-process pipes) -- i.e. the fs-events
fallback (this workspace is 2,295 files, above the 2,000-file `KQUEUE_FILE_WATCH_BUDGET`) is
genuinely in effect and holds no per-corpus-file fd at all, exactly as S-E's fix intends.

**Semantic maintenance started cleanly, no EBADF.** `ps` confirmed the daemon (pid 59161) spawned
one `semantic-neural-process.js` child (62354) and TWO `semantic-maintenance-process.js` children
(62405, 62406) -- both accumulated real, continuous CPU time (1:16-1:17 `TIME` against ~1:18-1:24
wall `ELAPSED`, i.e. near-100%-CPU active embedding work) with the SAME pids persisting across
repeated checks (no crash-and-respawn loop, which is exactly what a `spawn EBADF` would produce).
`lsof` on each semantic-maintenance child: 54 fds each (ONNX runtime's own library file handles plus
a few IPC pipes/sockets) -- stable, non-growing across repeated checks. The real worker binary
(`target/release/urdira-indexing-worker`, this session's own rebuild with the Task 2 fix) was also
confirmed running (pid 62360) with no crash.

No EBADF, no crash, no fd growth observed anywhere in this live run -- S-E's fix holds on this
session's own rebuilt binaries.

---

## 6. Cleanup

Scratch under `~/Proyectos/urdira-benchmark/v4-fold/d1-fd-check/` deleted at the end of this
session. All daemons for this session's own data roots stopped.
