# v4 rename-roots bug (P3-5 item 4) -- status update from P4-b-1

Task P4-b-1 (TypeScript/tests only) was asked to re-run the four previously
failing files documented in `docs/evidence/2026-09-04-v4-p4-b-prep-health.md`
Part 2, and -- for `tests/v4-mutation-harness.test.ts`'s "reaches durable for
a real fs.rename() through the real daemon+watcher, at fixture scale (P3-5
item 4)" test, documented there as a real, deterministic Rust-side bug,
out of this task's TS-only scope -- to capture the exact failing assertion
data into this file for the Rust follow-up.

**That test no longer fails.** Re-run in isolation, on a machine confirmed
idle via `pgrep -f "v4-scan|urdira-indexing-worker|cargo"` immediately
before each run, **3 times**, all green:

```
npx vitest run tests/v4-mutation-harness.test.ts --reporter=verbose
 ✓ ... reaches durable for a real fs.rename() through the real daemon+watcher, at fixture scale (P3-5 item 4)  4902ms
 ✓ ... (run 2)                                                                                                 4497ms
 ✓ ... (run 3)                                                                                                 4736ms
 Test Files  1 passed (1)
      Tests  6 passed | 1 skipped (7)
```

(The one skip is the unrelated `v4 mutation harness e2e` describe block,
which self-skips with "build the release artifacts and TS packages first"
-- a pre-existing, environment-gated skip, not this test.)

No TypeScript file this task touched (`tests/v4-mutation-harness.test.ts`
itself, `scripts/v4-mutation-harness.mjs`, or anything under
`packages/*/src`) was modified before this re-run -- the fix, whatever it
was, landed entirely on the Rust side, from the concurrently-running P2-2e
agent's work this same day (`git status` shows
`crates/urdira-indexing-worker/src/v4/` as untracked/in-flight, and
`target/release/urdira-indexing-worker` was rebuilt today before this
task's session started). Corroborating evidence from that agent's own
evidence doc, `docs/evidence/2026-09-04-v4-p2-2e-typeflow-in-v4.md` (section
1.3, "Determinism"): "Rename: covered by the pre-existing (smaller-fixture)
`incremental_rename_roots_match_a_from_scratch_scan_of_the_mutated_tree`,
still green" -- a Rust-side unit test distinct from this TS-side
daemon+watcher e2e test, but exercising the same rename-handling code path
(`crates/urdira-indexing-worker/src/v4/delta.rs`), and reported green as of
today's typeflow-in-v4 work landing.

## What P4-b-prep's session actually observed (for context, not reproduced here)

`docs/evidence/2026-09-04-v4-p4-b-prep-health.md` Part 2, item #4 reported
this same test failing identically 3/3 times on an idle machine, with
`only_in_incremental`/`only_in_from_scratch` (`packages/storage/src/
publication-authority.ts`-adjacent oracle comparison, actually
`scripts/v4-mutation-harness.mjs`'s `compareRootSets`) both reporting length
50 (the harness's own truncation cap -- see `compareRootSets`'s
`slice(0, 50)` -- meaning the TRUE mismatch count was at or above 50) where
the test asserts exactly 4 (one `jsts:entity_container` record per rewritten
importer, per decision 11 -- the documented, intentional divergence for a
content edit). That prior session's own root-cause note pointed at
`crates/urdira-indexing-worker/src/v4/delta.rs`'s rename handling. This
task did not have that failure available to re-capture (it did not
reproduce), so the specific record-id/kind/owner sample from that prior
run could not be captured here; see that evidence doc's own Part 2 table
for what was observed at the time.

## Caveat and recommendation

This task ran on a single machine, with whatever `target/release/
urdira-indexing-worker` binary happened to be on disk at the time (built by
the concurrently-running Rust agent, not by this task). Three consecutive
green runs on an idle machine is meaningful evidence the specific failure
mode from the prior session's report is gone, but this task did not (and,
being TS/tests-only, should not) inspect the Rust diff directly to confirm
a deliberate fix landed for exactly this path, versus the bug being
data/timing-dependent and not exercised by this particular binary/fixture
combination today. Recommend the Rust-owning agent (or whoever lands the
next commit touching `crates/urdira-indexing-worker/src/v4/delta.rs` or
`crates/urdira-indexing-core/src/merkle_bucket.rs`) confirm this test stays
green across a few more runs before treating P3-5 item 4 as closed, and
keep `tests/v4-mutation-harness.test.ts`'s rename test in the regular suite
either way -- it is exactly the regression detector this bug class needs.
