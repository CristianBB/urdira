import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hostNativeTarget, nativeArtifactNames } from "../scripts/native-release.mjs";
import { KIND_VARIANTS, expandKindSequence, run } from "../scripts/v4-mutation-harness.mjs";

/**
 * P3-4 (plan `resilient-knitting-twilight.md` §6/§10): end-to-end coverage
 * for the v4 incremental-mutation measurement harness. Drives a REAL
 * `urdira-indexing-worker` binary + native structural-store addon through
 * the same `scripts/v4-mutation-harness.mjs` code path the n8n gate run
 * uses.
 *
 * P3-1 (this session) landed the real `ScanScope::Changed` path server-side
 * (`crates/urdira-indexing-worker/src/v4/{delta,diff,state}.rs`): a second
 * scan of the same v4 workspace no longer hits the P2-2b generation-1-only
 * stub this file used to document as an open, executable regression
 * marker. Both tests below now exercise the REAL incremental path: a cold
 * scan with the root-equality oracle, and edit/create/delete/hub_edit
 * reaching durable with `roots_equal` matching decision 11's OWN
 * predicted outcome per kind (see the second test's own comments: `create`/
 * `delete` match a from-scratch oracle exactly; `edit`/`hub_edit` do NOT,
 * by design, since a content edit always re-chains the edited file's
 * `jsts:entity_container` row).
 *
 * `rename` used to be excluded from the second test's sequence (a real,
 * pre-existing daemon watcher bug, `docs/evidence/2026-09-03-v4-p3-1-incremental.md`
 * §8 / `docs/evidence/2026-09-03-v4-p3-2-incremental-residuals.md` §4.4). P3-5
 * (`docs/evidence/2026-09-03-v4-p3-5-daemon-latency.md`) re-investigated at
 * fixture scale and found the watcher/daemon side had ALREADY been fixed
 * (P3-2 item 4's cross-path rename combining, `packages/engine/src/watchers.ts`) --
 * a real `fs.rename()` correctly reaches `on_reconcile` as ONE combined
 * `Changed{Deleted old, Created new}` call. What actually still blocked a
 * real end-to-end rename was a SEPARATE, previously-undiagnosed bug in
 * `packages/plugin-javascript-typescript/src/indexing-core-process-transport.ts`:
 * a `workspace_scan` request_id whose mixed create+delete burst the Rust
 * worker splits into MULTIPLE internal generations (P3-2 item 5) emits one
 * `queryable` event PER internal generation sharing that same request_id --
 * the transport used to delete its `queryableHandlers` entry after the
 * FIRST such event, so the SECOND one fell through and was misread as the
 * terminal event, crashing with "Rust workspace scan returned an
 * unexpected terminal event: queryable". Fixed (P3-5) by keeping the
 * handler registered until the actual terminal event arrives. A real
 * rename now reaches durable end-to-end at fixture scale for BOTH
 * variants -- see the new `"reaches durable for a real fs.rename() ..."`
 * test below. `rename_rewrite` additionally rewrites its 4 importers' own
 * import specifiers (a genuine, separate content edit to those 4 files,
 * landing as its own later `Changed` scan in the log -- NOT part of the
 * rename's own mixed-generation burst); its `records` root therefore does
 * NOT match a from-scratch oracle, for the exact same reason `edit`/
 * `hub_edit` do not in the second test above (decision 11: a content edit
 * always re-chains that file's `jsts:entity_container` row) -- expected,
 * by design, not a new bug. `rename_no_rewrite` touches no other file's
 * content and matches the oracle exactly, like `create`/`delete`.
 *
 * Gated on the release artifacts existing, matching `tests/v4-daemon-e2e.test.ts`'s
 * precedent -- CI/dev machines without a Rust toolchain run this suite
 * skipped, not broken.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const hostTarget = hostNativeTarget();
const nativeRoot = hostTarget === undefined ? undefined : resolve(repoRoot, "release/native", hostTarget);
const workerPath = hostTarget === undefined || nativeRoot === undefined ? undefined : resolve(nativeRoot, nativeArtifactNames(hostTarget).indexing_core_worker);
const addonPath = hostTarget === undefined || nativeRoot === undefined ? undefined : resolve(nativeRoot, nativeArtifactNames(hostTarget).addon);
const hasReleaseArtifacts = workerPath !== undefined && existsSync(workerPath) && addonPath !== undefined && existsSync(addonPath);
const engineDistExists = existsSync(resolve(repoRoot, "packages/engine/dist/index.js"));
const runtimeDistExists = existsSync(resolve(repoRoot, "apps/urdira/dist/index.js"));
const canRun = hasReleaseArtifacts && engineDistExists && runtimeDistExists;

const fixtureRoot = resolve(repoRoot, "tests/fixtures/codebases/typescript/task-planner");

const describeIfBuilt = canRun ? describe : describe.skip;

it.skipIf(canRun)("v4 mutation harness e2e is skipped: build the release artifacts and TS packages first", () => {
  console.warn(
    `[urdira] tests/v4-mutation-harness.test.ts skipped -- missing worker (${workerPath ?? "no host target"}), ` +
    `native addon (${addonPath ?? "no host target"}), packages/engine/dist (${engineDistExists}), or apps/urdira/dist (${runtimeDistExists}). ` +
    "Build with: node scripts/build-native.mjs && pnpm -r build",
  );
});

describe("expandKindSequence", () => {
  it("expands every friendly kind into its concrete variants, in order, repeated N times", () => {
    const sequence = expandKindSequence(["edit", "delete"], 2);
    expect(sequence).toEqual([
      { kind: "edit", variant: "edit" },
      { kind: "delete", variant: "delete_leaf" },
      { kind: "delete", variant: "delete_with_importers" },
      { kind: "edit", variant: "edit" },
      { kind: "delete", variant: "delete_leaf" },
      { kind: "delete", variant: "delete_with_importers" },
    ]);
  });

  it("rejects an unknown kind", () => {
    expect(() => expandKindSequence(["not_a_kind"] as never, 1)).toThrow(/Unknown mutation kind/u);
  });
});

describe("KIND_VARIANTS", () => {
  it("covers exactly the five requested kinds with their documented variants", () => {
    expect(Object.keys(KIND_VARIANTS).sort()).toEqual(["create", "delete", "edit", "hub_edit", "rename"]);
    expect(KIND_VARIANTS.delete).toEqual(["delete_leaf", "delete_with_importers"]);
    expect(KIND_VARIANTS.rename).toEqual(["rename_no_rewrite", "rename_rewrite"]);
  });
});

describeIfBuilt("v4 mutation harness end-to-end (real urdira-indexing-worker + native structural store)", () => {
  it(
    "cold-scans the task-planner fixture, reaching queryable and durable with an equal-roots oracle",
    async () => {
      const outputDir = await mkdtemp(join(tmpdir(), "urdira-v4-mutation-harness-cold-test-"));
      const output = join(outputDir, "report.json");
      try {
        const report = await run({
          corpus: fixtureRoot,
          native_root: nativeRoot!,
          output,
          verify_roots: "each",
          mutation_kinds: [],
          repeat: 1,
          readiness_timeout_ms: 60_000,
          poll_interval_ms: 200,
          hub_min_importers: 50,
        });

        expect(report.schema_version).toBe(1);
        expect(report.mode).toBe("v4");
        expect(report.mutations).toHaveLength(0);
        expect(typeof report.cold.queryable_ms).toBe("number");
        expect(typeof report.cold.durable_ms).toBe("number");
        expect(report.cold.queryable_generation).toBeDefined();
        expect(report.cold.durable_generation).toBeDefined();
        expect(report.cold.roots_equal).toBeDefined();
        for (const [setKind, equal] of Object.entries(report.cold.roots_equal as Record<string, boolean>)) {
          expect(equal, `cold scan set ${setKind} mismatched a from-scratch scan of the SAME corpus`).toBe(true);
        }
        expect(report.changed_scope_unsupported_warning_seen).toBe(false);
      } finally {
        await rm(outputDir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it(
    "reaches durable for every mutation kind, with the equal-roots oracle holding exactly where decision 11 predicts it should (P3-1: ScanScope::Changed is real now)",
    async () => {
      // `rename` is deliberately EXCLUDED from this sequence: it exposes a
      // real, pre-existing daemon watcher bug, independently confirmed
      // (`docs/evidence/2026-09-03-v4-p3-1-incremental.md` §8) -- a rename
      // can arrive at the daemon as a `Deleted`-only watcher event (the
      // paired `Created` event for the new path is dropped/delayed by the
      // daemon's own event coalescing, upstream of anything this task
      // owns), so a workspace never republishes the created half and this
      // test would hang on `readiness_timeout_ms` for a reason that has
      // nothing to do with `ScanScope::Changed`'s own correctness. Rename
      // correctness IS proven, deterministically, by `crates/urdira-
      // indexing-worker/src/v4/tests_e2e.rs`'s `incremental_rename_roots_
      // match_a_from_scratch_scan_of_the_mutated_tree`, which drives
      // `scan::run` directly (no daemon, no watcher) with BOTH halves of
      // the rename in one `Changed` command, exactly as plan §6.4
      // specifies -- that test passes and its own oracle comparison is
      // exact (not merely "no error").
      const outputDir = await mkdtemp(join(tmpdir(), "urdira-v4-mutation-harness-mutation-test-"));
      const output = join(outputDir, "report.json");
      try {
        const report = await run({
          corpus: fixtureRoot,
          native_root: nativeRoot!,
          output,
          verify_roots: "each",
          // `create`/`delete` come FIRST, deliberately -- see the array
          // below for why order matters here.
          mutation_kinds: ["create", "delete", "edit", "hub_edit"],
          repeat: 1,
          readiness_timeout_ms: 20_000,
          poll_interval_ms: 200,
          hub_min_importers: 50,
        });
        expect(report.mutations).toHaveLength(5);
        const expectedKinds = ["create", "delete", "delete", "edit", "hub_edit"];
        // Decision 11 (`docs/decisions/11-content-derived-record-identity.md`):
        // a CONTENT edit to an existing file (`edit`, `hub_edit`) always
        // chains that file's `jsts:entity_container` row (its span's `end`
        // -- the file's own byte length -- is part of the hashed body, so
        // ANY edit changes that container's digest while its identity_key
        // never does -- "same identity, different digest" is decision 11's
        // own definition of "replacement", which MUST chain, never match a
        // from-scratch oracle's unconditional first-occurrence recipe).
        // `create`/`delete` never touch an existing record's identity at
        // all, so their `records` root matches the oracle exactly (a
        // brand-new/removed path never chains) -- AS LONG AS they run
        // BEFORE any content edit in the sequence: once ANY file has been
        // content-edited, its chained container row diverges from a
        // from-scratch oracle FOREVER after (the oracle always re-derives
        // the whole corpus fresh, including that file's CURRENT, already-
        // edited content, and always assigns it a first-occurrence id --
        // discovered live, this task's first version of this test put
        // `edit` first and saw the SUBSEQUENT `create` mutation's
        // `records` root also mismatch, purely as residual fallout from
        // the earlier edit, not from anything `create` itself did) --
        // hence `create`/`delete` are ordered first here. `dependency`
        // matches for every kind on this fixture (task-planner has no
        // cross-owner import dependency rows to begin with, so the
        // dependency set is empty and trivially stable) -- kept as a real
        // assertion, not dropped, so a future regression that DOES start
        // diffing dependencies incorrectly still fails this test.
        const expectRecordsEqual = [true, true, true, false, false];
        for (const [index, mutation] of report.mutations.entries()) {
          expect(mutation.kind).toBe(expectedKinds[index]);
          expect(typeof mutation.queryable_ms).toBe("number");
          expect(typeof mutation.durable_ms).toBe("number");
          const rootsEqual = mutation.roots_equal as Record<string, boolean>;
          expect(rootsEqual["dependency"], `mutation #${index} (${mutation.kind}) dependency root mismatched a from-scratch scan`).toBe(true);
          expect(
            rootsEqual["records"],
            `mutation #${index} (${mutation.kind}) records root ${expectRecordsEqual[index] ? "should" : "should NOT"} match a from-scratch scan (decision 11)`,
          ).toBe(expectRecordsEqual[index]);
        }
      } finally {
        await rm(outputDir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "reaches durable for a real fs.rename() through the real daemon+watcher, at fixture scale (P3-5 item 4)",
    async () => {
      const outputDir = await mkdtemp(join(tmpdir(), "urdira-v4-mutation-harness-rename-test-"));
      const output = join(outputDir, "report.json");
      try {
        const report = await run({
          corpus: fixtureRoot,
          native_root: nativeRoot!,
          output,
          verify_roots: "each",
          mutation_kinds: ["rename"],
          repeat: 1,
          readiness_timeout_ms: 20_000,
          poll_interval_ms: 200,
          hub_min_importers: 50,
        });
        expect(report.mutations).toHaveLength(2);
        // Both variants must reach a NEW durable generation -- the P3-5
        // fix's own core claim (no hang, no crash) -- regardless of the
        // documented `records`-root finding below.
        for (const mutation of report.mutations) {
          expect(typeof mutation.queryable_ms, `${mutation.mutation_id} never reached queryable`).toBe("number");
          expect(typeof mutation.durable_ms, `${mutation.mutation_id} never reached durable`).toBe("number");
        }
        const [noRewrite, rewrite] = report.mutations;
        expect(noRewrite!.variant).toBe("rename_no_rewrite");
        expect(rewrite!.variant).toBe("rename_rewrite");
        const noRewriteRoots = noRewrite!.roots_equal as Record<string, boolean>;
        // `rename_no_rewrite` touches no OTHER file's content (importer
        // specifiers are deliberately left dangling, plan §6.4) -- both
        // roots match a from-scratch oracle exactly.
        expect(noRewriteRoots["dependency"]).toBe(true);
        expect(noRewriteRoots["records"]).toBe(true);
        const rewriteRoots = rewrite!.roots_equal as Record<string, boolean>;
        expect(rewriteRoots["dependency"]).toBe(true);
        // Decision 11 (same rationale as the second test above's `edit`/
        // `hub_edit` rows): rewriting 4 importers' specifiers is a genuine
        // content edit to those 4 files, so their `jsts:entity_container`
        // rows chain and diverge from a from-scratch oracle by design --
        // exactly 4 mismatches, one per rewritten importer, asserted
        // precisely (not just "not equal") so an actual regression (a
        // DIFFERENT count, or a dependency-root mismatch) still fails this
        // test.
        expect(rewriteRoots["records"]).toBe(false);
        const rewriteMismatch = rewrite!.mismatches?.["records"];
        expect(rewriteMismatch).toBeDefined();
        expect(rewriteMismatch!.only_in_incremental).toHaveLength(4);
        expect(rewriteMismatch!.only_in_from_scratch).toHaveLength(4);
        expect(rewriteMismatch!.count_a).toBe(rewriteMismatch!.count_b);
      } finally {
        await rm(outputDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
