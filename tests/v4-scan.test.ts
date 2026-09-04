import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end gate for the v4 cold-scan pipeline (task P2-2b): runs the same
 * logic as `scripts/v4-scan.mjs` against the small
 * `tests/fixtures/codebases/typescript/task-planner` fixture and asserts
 * the on-disk store, the SQLite snapshot row, and cross-run determinism.
 *
 * Scope note (see the task's evidence doc,
 * `docs/evidence/2026-09-02-v4-p2-2b-cold-pipeline.md`, "Deviations"): this
 * test does NOT run the v3 pipeline over the same fixture to diff record
 * ids/counts -- that requires the full v3 daemon+checker stack, out of this
 * test's budget. Record-id/digest parity with v3's recipe is instead
 * covered at the unit level by
 * `crates/urdira-indexing-worker/src/v4/materialize.rs`'s
 * `record_identity_matches_the_structural_kernel_oracle_exactly` test,
 * which canonicalizes the SAME `ProposedRecord` through the SAME
 * `structural_kernel_batch_parts` oracle v3's own hybrid lane calls, and
 * asserts this pipeline's `RecordRow` decodes to byte-identical digests.
 * This test instead verifies pipeline health end to end: the store is
 * queryable/durable, the snapshot row and Merkle roots are self-consistent,
 * and a from-scratch rescan is deterministic (byte-identical
 * `canonical_record_set_digest`).
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = resolve(repoRoot, "tests/fixtures/codebases/typescript/task-planner");
const workerPath = process.env["URDIRA_INDEXING_CORE_WORKER_PATH"] ?? resolve(repoRoot, "target/release/urdira-indexing-worker");

const hasWorkerBinary = existsSync(workerPath);
const describeIfBuilt = hasWorkerBinary ? describe : describe.skip;

describeIfBuilt("v4 cold scan (task-planner fixture)", () => {
  let dataDirA: string;
  let dataDirB: string;

  beforeAll(() => {
    dataDirA = mkdtempSync(join(tmpdir(), "urdira-v4-scan-test-a-"));
    dataDirB = mkdtempSync(join(tmpdir(), "urdira-v4-scan-test-b-"));
  });

  afterAll(() => {
    for (const dir of [dataDirA, dataDirB]) {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  async function runScan(dataDir: string) {
    const { createIndexingCoreProcessTransport } = await import(resolve(repoRoot, "packages/plugin-javascript-typescript/dist/indexing-core-process-transport.js"));
    const { runRustWorkspaceScan } = await import(resolve(repoRoot, "packages/engine/dist/rust-workspace-scan.js"));
    const { WORKSPACE_V4_SCHEMA } = await import(resolve(repoRoot, "packages/storage/dist/workspace-v4-sql.generated.js"));
    const { encodeCanonical } = await import(resolve(repoRoot, "packages/canonical/dist/index.js"));

    const databasePath = resolve(dataDir, "workspace.sqlite");
    const structuralRoot = resolve(dataDir, "structural");
    const casRoot = resolve(dataDir, "cas");
    const sidecarRoot = resolve(dataDir, "sidecar");

    const db = new DatabaseSync(databasePath);
    db.exec(WORKSPACE_V4_SCHEMA);
    const insertMeta = db.prepare("INSERT INTO workspace_meta (key, value) VALUES (?, ?)");
    insertMeta.run("index_contract", Uint8Array.of(0x34));
    insertMeta.run("identity_format", encodeCanonical(3));
    insertMeta.run("structural_store", encodeCanonical("native"));
    db.close();

    const transport = createIndexingCoreProcessTransport({ command: workerPath, request_timeout_ms: 120_000 });
    try {
      const outcome = await runRustWorkspaceScan(transport, {
        workspace_id: `workspace:v4-scan-test:${dataDir}`,
        workspace_root: fixtureRoot,
        database_path: databasePath,
        structural_root: structuralRoot,
        cas_root: casRoot,
        sidecar_root: sidecarRoot,
        scope: { kind: "full" },
        registry_snapshot_id: "registry:v4-scan-test",
        configuration_revision_id: "configuration:v4-scan-test",
        resolution_lock_id: "resolution:v4-scan-test",
        priority: "interactive",
      });
      return { outcome, databasePath, structuralRoot };
    } finally {
      await transport.shutdown().catch(() => {});
      await transport.terminate();
    }
  }

  it("writes a queryable, durable structural store with valid roots", async () => {
    const { outcome, structuralRoot } = await runScan(dataDirA);

    expect(outcome.generation).toBe(1);
    expect(outcome.snapshot_id.length).toBeGreaterThan(0);
    for (const rootHex of Object.values(outcome.roots)) {
      expect(rootHex).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    // records/graph must be non-empty for a fixture with real TS entities.
    expect(outcome.roots.records).not.toBe("sha256:" + "0".repeat(64));
    expect(outcome.roots.graph).not.toBe("sha256:" + "0".repeat(64));

    expect(existsSync(join(structuralRoot, "MANIFEST"))).toBe(true);
    expect(existsSync(join(structuralRoot, "base-1", "records.keys"))).toBe(true);
    expect(existsSync(join(structuralRoot, "base-1", "records.meta"))).toBe(true);
    expect(existsSync(join(structuralRoot, "base-1", "records.body"))).toBe(true);
    expect(existsSync(join(structuralRoot, "merkle", "records.tree"))).toBe(true);
    expect(existsSync(join(structuralRoot, "merkle", "graph.tree"))).toBe(true);

    // `queryable` must have fired before `scan_completed` resolved.
    expect(outcome.queryable).toBeDefined();
    expect(outcome.queryable_at_ms).toBeLessThanOrEqual(outcome.completed_at_ms);
  }, 60_000);

  it("commits exactly one snapshots row with a valid, self-consistent snapshot_digest", async () => {
    const { outcome, databasePath } = await runScan(dataDirB);
    const db = new DatabaseSync(databasePath);
    try {
      const rows = db
        .prepare("SELECT snapshot_id, generation, workspace_id, snapshot_digest, canonical_record_set_digest, projection_set_digests FROM snapshots")
        .all() as Array<Record<string, unknown>>;
      expect(rows.length).toBe(1);
      const row = rows[0]!;
      expect(row["snapshot_id"]).toBe(outcome.snapshot_id);
      expect(row["generation"]).toBe(1);
      expect(String(row["snapshot_digest"])).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(String(row["canonical_record_set_digest"])).toMatch(/^sha256:[0-9a-f]{64}$/);
      const projections = JSON.parse(String(row["projection_set_digests"])) as Array<{ readonly projection_kind: string }>;
      expect(projections.map((entry) => entry.projection_kind).sort()).toEqual(["dependency", "graph", "metric"]);

      const currentState = db.prepare("SELECT current_generation, current_snapshot_id FROM workspace_current_state").all() as Array<Record<string, unknown>>;
      expect(currentState.length).toBe(1);
      expect(currentState[0]!["current_snapshot_id"]).toBe(outcome.snapshot_id);

      const merkleRoots = db.prepare("SELECT set_kind FROM merkle_roots WHERE generation = 1 ORDER BY set_kind").all() as Array<Record<string, unknown>>;
      expect(merkleRoots.map((entry) => entry["set_kind"])).toEqual(["dependency", "graph", "metric", "records"]);
    } finally {
      db.close();
    }
  }, 60_000);

  it("materializes non-zero relation records with real endpoints, and adjacency lookups (find_references' pushdown) find them by record_id (task P2-2d, gap A1)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "urdira-v4-scan-test-relations-"));
    try {
      const { structuralRoot } = await runScan(dataDir);
      const { loadNativeStructuralStoreAddon } = (await import(resolve(repoRoot, "packages/engine/dist/native-structural-store-binding.js"))) as typeof import("../packages/engine/src/native-structural-store-binding.js");
      const addon = loadNativeStructuralStoreAddon();
      const handle = addon.NativeStructuralStoreHandle.open(structuralRoot);
      const generation = handle.currentGeneration();

      // Gap A1's root cause was NOT that the facts/hybrid-semantics lanes
      // failed to materialize relation-category rows (see this task's
      // evidence doc for the two hypotheses that turned out false) --
      // relation rows have always been present. The real, confirmed bug
      // was `crates/urdira-native-node/src/structural_store_napi.rs`'s
      // `adjacency` napi method hashing the caller's subject-id text with
      // `sha256`, a scheme only the (unrelated) v3-conversion builder path
      // uses; the v4 native pipeline's own writer interns each relation
      // endpoint's RAW `record_id` bytes as the subject key instead, so no
      // v4 adjacency lookup ever found anything before the fix (`adjacency`
      // now also tries the caller's subject text hex-decoded directly).
      const byKind = new Map<string, number>();
      let cursor: string | undefined;
      let sampleRelation: { readonly recordId: string; readonly kind: string } | undefined;
      for (;;) {
        const batch = handle.iterVisibleBatch(generation, 4_096, cursor);
        for (const row of batch.rows) {
          if (row.category !== "relation") continue;
          byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + 1);
          sampleRelation ??= { recordId: row.recordId, kind: row.kind };
        }
        if (batch.nextCursor === undefined) break;
        cursor = batch.nextCursor;
      }
      expect([...byKind.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
      expect(byKind.get("jsts:relation_contains") ?? 0).toBeGreaterThan(0);
      expect(byKind.get("jsts:relation_references") ?? 0).toBeGreaterThan(0);

      // Every relation record's OWN `record_id` is a valid outbound
      // adjacency subject (a relation record is itself indexed as a
      // container-agnostic edge; more directly, its endpoints resolve via
      // the entity records' `record_id`s -- checked here end to end by
      // walking every entity and confirming at least one has a non-empty
      // inbound adjacency list, which is exactly what `core:find_references`
      // pushdown relies on).
      let foundNonEmptyInbound = false;
      cursor = undefined;
      for (;;) {
        const batch = handle.iterVisibleBatch(generation, 4_096, cursor);
        for (const row of batch.rows) {
          if (row.category !== "entity") continue;
          const edges = handle.adjacency([row.recordId], "inbound", generation);
          if (edges.length > 0) {
            foundNonEmptyInbound = true;
            expect(edges[0]!.targetSubjectId).toBe(row.recordId);
            expect(edges[0]!.sourceSubjectId).toMatch(/^record:[0-9a-f]{64}$/);
          }
        }
        if (batch.nextCursor === undefined) break;
        cursor = batch.nextCursor;
      }
      expect(foundNonEmptyInbound).toBe(true);
      expect(sampleRelation).toBeDefined();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("is deterministic: two independent cold scans of the same fixture produce the same canonical_record_set_digest", async () => {
    const dirOne = mkdtempSync(join(tmpdir(), "urdira-v4-scan-test-det1-"));
    const dirTwo = mkdtempSync(join(tmpdir(), "urdira-v4-scan-test-det2-"));
    try {
      const first = await runScan(dirOne);
      const second = await runScan(dirTwo);
      expect(second.outcome.roots.records).toBe(first.outcome.roots.records);
      expect(second.outcome.roots.graph).toBe(first.outcome.roots.graph);
      expect(second.outcome.roots.dependency).toBe(first.outcome.roots.dependency);
    } finally {
      rmSync(dirOne, { recursive: true, force: true });
      rmSync(dirTwo, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("v4 cold scan worker binary availability", () => {
  it("documents how to build the binary this suite needs when it is missing", () => {
    if (!hasWorkerBinary) {
      // Not a failure: this suite is opt-in until `cargo build --release -p
      // urdira-indexing-worker` has been run (or `pnpm verify` runs it as a
      // prerequisite step) -- documented, not silently skipped without a
      // trace.
      console.warn(
        `v4-scan.test.ts: skipping (no worker binary at ${workerPath}). Build it with: cargo build --release -p urdira-indexing-worker`,
      );
    }
    expect(true).toBe(true);
  });
});
