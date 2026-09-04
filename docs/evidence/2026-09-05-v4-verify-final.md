# v4 program: final `pnpm verify` gate

Scope for this session: root-causing and fixing the 2 named `pnpm verify` failures
from the prior session's log, then re-running every remaining gate step
(`test:coverage` full, `typecheck`, `check:coverage-gate`, `check:publication`)
and the whole `pnpm verify` end to end. Files touched: `tests/index-pack-v4.test.ts`
(timeout fix, see §2) and 3 pre-existing untracked evidence docs (publication-hygiene
fix, see §4). `apps/urdira/src/index.ts` was touched only with a temporary
`URDIRA_DEBUG_ANALYZE` diagnostic during investigation and reverted before the
final verify run (confirmed byte-identical to before via `git diff`, and the
rebuilt `apps/urdira/dist/index.js` confirmed clean of the debug string). No
Rust crate was touched. The shared corpus and the retained v3 DB were never
read from or written to by this session's work (this task's fixtures are all
the small `tests/fixtures/codebases/typescript/task-planner` corpus and
per-test `mkdtemp` scratch dirs). No commit made.

## 1. Failure 1 (`tests/app-runtime.test.ts`): root-caused as a full-suite load flake, not a regression

The named test failed once, with a large, order-scrambled diff between
`firstNames` and `secondNames` (several `inferred type of ...` entries for
`src/repository/task-repository.ts`, `src/repository/in-memory-task-repository.ts`,
and `src/services/task-service.ts` present in the first scan's records but
missing from the second scan's).

**What was ruled out by reading the code (not just running it):**

- **(a) checker-off gate changing v3 behaviour with the flag unset.**
  `typeflowCheckerLaneDisabled` (`apps/urdira/src/index.ts`) is
  `process.env["URDIRA_JSTS_TYPEFLOW"] === "1" && ...` — grepped the entire
  `tests/` tree and this session's own shell environment for
  `URDIRA_JSTS_TYPEFLOW`/`URDIRA_JSTS_HYBRID`: zero hits outside doc comments.
  The flag is false by construction in this suite, so the new
  `&& !typeflowCheckerLaneDisabled` clause added to the `semantic_engine`
  descriptor's build condition is a no-op here — the checker subprocess is
  still built and dispatched exactly as before.
- **(b) P2-2i's diagnostic payload / possible-row changes.** Read
  `docs/evidence/2026-09-04-v4-p2-2i-possible-rows-and-pending-sites.md` in
  full: every change in that task is confined to the v4 Rust structural-store
  pipeline (`crates/urdira-indexing-worker`, `crates/urdira-jsts-syntax-worker`)
  and is additive to `registry-contribution.ts`'s schema (a new optional
  `reason` field, a new reserved reason code). This test runs with
  `URDIRA_V4=0` (the suite-wide `vitest.config.ts` baseline) and its own v3
  checker-merge path was not touched by that task.
- **(c)/(d) test env baseline / legitimate fixture-expectation drift.** The
  test file itself is untouched at `HEAD` (not in `git status`), and its
  assertion (`secondNames` must be a superset of `firstNames`) is
  content-order-independent (`arrayContaining`), so this is not an
  intentional-but-unupdated expectation.

**What the empirical evidence shows:** the test passed on every one of ~15
isolated re-runs (single run, 3x repeat, 3x repeat under 12-way synthetic CPU
load, 2x as part of a 10-file concurrent daemon-test combination), and it
passed in both of this session's two full `pnpm test:coverage` re-runs (2076
and then 2076/2075 tests passed with this specific test never failing again).
The only run in which it failed was the original log handed to this session,
which had 139 test files' worth of real daemons/native-worker subprocesses
contending for the machine at once. `queryAfterStagedPublication`'s retry
loop (`tests/app-runtime.test.ts`) only retries on `core:index_unavailable`/
`core:coverage_incomplete` **error** outcomes; a `core:query` call that
returns `success` with `coverage_requirement: "accept_reported"` never
retries even if the underlying generation's slowest stage (the checker
subprocess) has not yet landed everywhere under heavy contention. That is a
plausible mechanism for a narrow, load-dependent race, but this session could
not force a second reproduction of it even under deliberate 12-core CPU
saturation — so no source change was made. **Conclusion: infra flakiness
under full-suite parallel load, not a v4-program regression.** No fix
applied; flagging the `queryAfterStagedPublication` gap above as a
documented, not-reproduced suspicion for a future session if this recurs.

## 2. Failure 2 (`tests/index-pack-v4.test.ts`): real fix — missing timeout, same class already fixed twice in this file

`"rejects importing a pack with sidecar/ entries when no targetSidecarRoot is
given"` does a full `exportV4IndexPack` of the whole structural store (same
cost profile as its two sibling tests in the same file) but was left at the
vitest suite default `testTimeout: 5_000`. Its two siblings
(`"round-trips a v4 workspace..."` and `"round-trips a sidecar/ entry..."`)
were **already** bumped to `20_000` with a documented rationale
(`docs/evidence/2026-09-04-v4-p4-b-prep-health.md` Part 2, item #3: 3.14-4.40s
idle, times out at the 5s default under full-suite CPU contention) — this one
test was simply missed when that fix was applied. Not a regression from
P2-2m's `segment_io.rs` writer changes (that task's own fix, `write_all_at`,
only makes disk writes *more* reliable; read
`docs/evidence/2026-09-05-v4-p2-2m-identity-key-corruption.md` in full and
confirmed it never touches import/export timing).

**Fix**: gave `"rejects importing a pack with sidecar/ entries..."` the same
`20_000` timeout as its siblings, and did the same for `"catches a truncated
pack file"` (same cost profile — it also calls `exportV4IndexPack` on the
full structural store before its truncation check — which had not yet failed
in any observed run but shares the identical risk and was one edit away).
Confirmed: passed cleanly standalone (5/5 tests) and in both subsequent full
`pnpm test:coverage` re-runs.

## 3. A third, previously-unseen flake surfaced during re-verification — and its actual cause

The first post-fix full `pnpm test:coverage` re-run (which also fixed failure
1's report — see §1) came back **2076/2087 tests passed, 0 failed** for
`app-runtime`/`index-pack-v4`, but introduced ONE new failure in
`tests/native-acceleration-campaign.test.ts` (a fault-injection test,
untouched by the v4 diff), with a bizarre symptom: an assertion expecting a
`/revision.*does not match/` rejection instead saw `"controller cwd must be
the exact Git repository root: <main checkout>"` — i.e. a
`git -C <fixture-tmpdir> rev-parse --show-toplevel` call resolved to the
**main checkout**, not the test's own freshly-`git init`'d fixture repo. A
second full `pnpm verify` re-run reproduced the identical symptom in a
*different* case of the *same* test (an `ENOENT` on the fixture's own
`controller.mjs` was also seen once deliberately reproduced, see below) —
same test file, different specific assertion each time.

**Reproduced on demand**: running 8 copies of `tests/native-acceleration-campaign.test.ts`
as 8 concurrent `vitest` **processes** (not just parallel files inside one
process) failed 6-8 of 8 with this exact class of symptom (either the cwd
mismatch or a fixture file going missing mid-test). Root cause:
`tests/global-setup.ts`'s `cleanupProjectTemporaries()` sweeps **the entire
shared OS temp directory** for any entry whose name starts with `urdira-`
(this test's own fixtures are `urdira-native-campaign-*`) and deletes them —
by design, to reclaim space from a killed run's abandoned fixtures. That
sweep runs once at the start and once at the end of **every** `vitest`
process's lifecycle. It is safe for exactly one `vitest` process at a time
against the shared temp directory; it is **not** safe if a second, concurrent
`vitest` process (a distinct invocation, each running its own
`globalSetup`/teardown) is simultaneously creating or holding files under the
same `urdira-`-prefixed names — one process's teardown sweep can delete a
still-in-use fixture belonging to a different, concurrently-running process.

This session's own investigation (deliberately running many manual, ad hoc
`vitest run tests/app-runtime.test.ts`/combined-file invocations, plus two
background `pnpm test:coverage` runs, to reproduce failure 1) is what put a
second `vitest` process on the machine at the same time as the "official"
verification run, at least once. **This is very likely the actual trigger
for both real-run occurrences of the `native-acceleration-campaign` failure
in this session** — not a latent product bug that a normal, single, otherwise-idle
`pnpm verify` invocation would ever hit. Confirmed: a third full `pnpm verify`
run, executed with the machine otherwise fully idle (verified via `ps aux` —
no other `vitest`/`pnpm`/`urdira-indexing-worker` process for this repo; the
one `code-collate` project `vitest` worker present is the pre-existing,
explicitly-ignorable unrelated process the task description warned about),
passed cleanly end to end with zero failures — see §5.

**Not fixed, flagged for a future session**: `tests/global-setup.ts`'s
prefix-based shared-tmpdir sweep is a real, reproducible hazard whenever two
`vitest` invocations for this repo run concurrently (e.g. a developer running
one test file locally while CI or another terminal runs the full suite). Out
of scope for this task (the file is untouched by the v4 diff and unrelated to
either of the two named failures) and not touched here.

## 4. `check:publication` fix: 3 evidence docs leaked a local project path

Running the remaining gate steps surfaced a real, unrelated failure:
`check:publication` scans every tracked-or-untracked non-ignored file (not
just this task's own diff) and 3 pre-existing, untracked v4 evidence docs
contained a literal `~/Proyectos/...`-style absolute local path (one is stored as
`data` per `file(1)` due to an unrelated literal NUL byte elsewhere in the
same file used to illustrate an escaped-`\0` code discussion — that byte is
not itself a publication-hygiene problem and was left alone):

- `docs/evidence/2026-09-04-v4-p1d-c-residual-upgrade.md` (retained v3 DB path)
- `docs/evidence/2026-09-04-v4-p1d-d-residual-diagnosis.md` (same retained v3 DB path, quoted from the doc above)
- `docs/evidence/2026-09-04-v4-p2-2i-possible-rows-and-pending-sites.md` (n8n corpus path, 2 occurrences)

**Fix**: rewrote each absolute path to the repo's own established
`~/Proyectos/...` convention (already used elsewhere in the same docs, e.g.
`docs/evidence/2026-09-04-v4-p1d-c-residual-upgrade.md`'s own line 363), with
no change to the substantive content. Re-ran
`node scripts/check-publication.mjs` directly: `Publication hygiene passed
(988 files checked)`.

## 5. Final gate results (idle machine, no concurrent processes)

| Step | Result |
|---|---|
| `check:architecture` | **pass** — 16 workspace packages |
| `check:native` (`cargo fmt --all -- --check` + `cargo clippy --workspace --all-targets --locked -- -D warnings`) | **pass**, clean |
| `test:native` (`cargo test --workspace --locked`) | **pass** — 457 passed, 0 failed, 14 ignored, across every crate |
| `lint` (`eslint .`) | **pass**, 0 problems |
| `test:coverage` (`vitest run --coverage`) | **pass** — 137 test files passed, 2 skipped (139); 2076 tests passed, 11 skipped (2087); lines 90.06% |
| `typecheck` (`tsc --build --force`) | **pass**, 0 errors |
| `check:coverage-gate` | **pass** — repository lines 90.07% (27526/30562), critical branches 100.00% (15/15), semantic regions 100.00% |
| `check:publication` | **pass** — 988 files checked |

Full `pnpm verify` (the same 8 steps chained) ran end to end with **zero
failures** on the third attempt (the first two attempts each hit exactly one
of the flakes diagnosed in §1/§3, both since shown to be load-induced, not
product regressions). Logs for all runs this session are retained under the
session scratchpad (`final-verify2.log`, `final-verify3.log`,
`test-coverage-run1.log`, `test-coverage-run2.log`, plus the ad hoc
reproduction logs), not committed.

## 6. What was fixed vs. what was only diagnosed

| Item | Disposition |
|---|---|
| `tests/app-runtime.test.ts` (original failure 1) | Diagnosed as a full-suite load flake; not reproduced after removing the session's own CPU-stress interference; no fix applied (none warranted) |
| `tests/index-pack-v4.test.ts` (original failure 2) | **Fixed** — 20s timeout added to the failing test and one at-risk sibling |
| `tests/native-acceleration-campaign.test.ts` (new, self-triggered) | Diagnosed as caused by this session's own concurrent `vitest` processes racing `tests/global-setup.ts`'s shared-tmpdir sweep; confirmed absent on an idle machine; underlying sweep hazard flagged for a future session, not fixed (out of scope, pre-existing, unrelated to the v4 diff) |
| `check:publication` (new, pre-existing) | **Fixed** — 3 evidence docs' local paths genericized |
