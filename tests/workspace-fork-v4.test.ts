import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SqliteDatabase } from "../packages/storage/src/index.js";

/**
 * End-to-end gate for `packages/engine/src/workspace-fork.ts`'s v4 section
 * (task P2-4): cold-scans the small `tests/fixtures/codebases/typescript/
 * task-planner` fixture into a real v4 workspace (donor), forks it via
 * `forkV4Workspace`, and confirms the fork is queryable, has its own
 * rewritten workspace_id everywhere, and passes both the fork's own root
 * verification and a full `verifyV4Workspace` pass.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = resolve(repoRoot, "tests/fixtures/codebases/typescript/task-planner");
const workerPath = process.env["URDIRA_INDEXING_CORE_WORKER_PATH"] ?? resolve(repoRoot, "target/release/urdira-indexing-worker");

const hasWorkerBinary = existsSync(workerPath);
const describeIfBuilt = hasWorkerBinary ? describe : describe.skip;

describeIfBuilt("forkV4Workspace (task-planner fixture)", () => {
  let dataDir: string;
  let donorWorkspaceId: string;
  let donorDatabasePath: string;
  let donorStructuralRoot: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "urdira-v4-fork-test-"));
    donorWorkspaceId = `workspace:v4-fork-donor:${dataDir}`;
    donorDatabasePath = resolve(dataDir, "donor", "workspace.sqlite");
    donorStructuralRoot = resolve(dataDir, "donor", "structural");
    const casRoot = resolve(dataDir, "donor", "cas");
    const sidecarRoot = resolve(dataDir, "donor", "sidecar");

    const { createIndexingCoreProcessTransport } = await import(resolve(repoRoot, "packages/plugin-javascript-typescript/dist/indexing-core-process-transport.js"));
    const { runRustWorkspaceScan } = await import(resolve(repoRoot, "packages/engine/dist/rust-workspace-scan.js"));
    const { WORKSPACE_V4_SCHEMA } = await import(resolve(repoRoot, "packages/storage/dist/workspace-v4-sql.generated.js"));
    const { encodeCanonical } = await import(resolve(repoRoot, "packages/canonical/dist/index.js"));
    const { mkdir } = await import("node:fs/promises");

    await mkdir(resolve(dataDir, "donor"), { recursive: true });
    const db = new DatabaseSync(donorDatabasePath);
    db.exec(WORKSPACE_V4_SCHEMA);
    const insertMeta = db.prepare("INSERT INTO workspace_meta (key, value) VALUES (?, ?)");
    insertMeta.run("index_contract", Uint8Array.of(0x34));
    insertMeta.run("identity_format", encodeCanonical(3));
    insertMeta.run("structural_store", encodeCanonical("native"));
    db.close();

    const transport = createIndexingCoreProcessTransport({ command: workerPath, request_timeout_ms: 120_000 });
    try {
      await runRustWorkspaceScan(transport, {
        workspace_id: donorWorkspaceId,
        workspace_root: fixtureRoot,
        database_path: donorDatabasePath,
        structural_root: donorStructuralRoot,
        cas_root: casRoot,
        sidecar_root: sidecarRoot,
        scope: { kind: "full" },
        registry_snapshot_id: "registry:v4-fork-test",
        configuration_revision_id: "configuration:v4-fork-test",
        resolution_lock_id: "resolution:v4-fork-test",
        priority: "interactive",
      });
    } finally {
      await transport.shutdown().catch(() => {});
      await transport.terminate();
    }
  }, 120_000);

  afterAll(() => {
    if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
  });

  it("copies the structural store and catalog, rewrites the workspace id, and both verifications pass", async () => {
    const { forkV4Workspace } = (await import(resolve(repoRoot, "packages/engine/dist/workspace-fork.js"))) as typeof import("../packages/engine/src/workspace-fork.js");
    const { verifyV4Workspace } = (await import(resolve(repoRoot, "packages/engine/dist/v4-verify.js"))) as typeof import("../packages/engine/src/v4-verify.js");
    const { openSqliteDatabase } = (await import(resolve(repoRoot, "packages/storage/dist/index.js"))) as typeof import("../packages/storage/src/index.js");

    const targetWorkspaceId = `workspace:v4-fork-target:${dataDir}`;
    const targetDatabasePath = resolve(dataDir, "target", "workspace.sqlite");
    const targetStructuralRoot = resolve(dataDir, "target", "structural");

    const forkResult = await forkV4Workspace({
      sourceStructuralRoot: donorStructuralRoot,
      targetStructuralRoot,
      sourceDatabasePath: donorDatabasePath,
      targetDatabasePath,
      sourceWorkspaceId: donorWorkspaceId,
      targetWorkspaceId,
    });
    expect(forkResult.mismatches).toEqual([]);
    expect(forkResult.ok).toBe(true);

    // The donor's own workspace_id must be gone from the fork's catalog --
    // every row (workspace_id columns AND workspace-id-templated ids like
    // snapshot_id) should now read the target id.
    const target = await openSqliteDatabase({ filename: targetDatabasePath });
    try {
      const donorLeftovers = await target.get<{ count: number }>(
        "SELECT (SELECT COUNT(*) FROM snapshots WHERE workspace_id = ? OR snapshot_id LIKE '%' || ? || '%') AS count",
        [donorWorkspaceId, donorWorkspaceId],
      );
      expect(donorLeftovers?.count).toBe(0);

      const forkedSnapshot = await target.get<{ workspace_id: string; snapshot_id: string }>("SELECT workspace_id, snapshot_id FROM snapshots WHERE workspace_id = ?", [targetWorkspaceId]);
      expect(forkedSnapshot).toBeDefined();
      expect(forkedSnapshot!.snapshot_id).toContain(targetWorkspaceId);

      const current = await target.get<{ current_generation: number }>("SELECT current_generation FROM workspace_current_state WHERE workspace_id = ?", [targetWorkspaceId]);
      expect(current?.current_generation).toBe(1);
    } finally {
      await target.close();
    }

    // The forked copy must independently pass the from-scratch v4 verify --
    // not just "the fork call said ok", but a fresh, unrelated check reading
    // the same on-disk bytes back.
    const report = await withDatabase(targetDatabasePath, (database) => verifyV4Workspace(database, targetStructuralRoot, targetWorkspaceId));
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);

    async function withDatabase<T>(path: string, fn: (database: SqliteDatabase) => Promise<T>): Promise<T> {
      const database = await openSqliteDatabase({ filename: path });
      try {
        return await fn(database);
      } finally {
        await database.close();
      }
    }
  });

  it("also copies the sidecar directory when sourceSidecarRoot/targetSidecarRoot are both provided and the source exists", async () => {
    const { forkV4Workspace } = (await import(resolve(repoRoot, "packages/engine/dist/workspace-fork.js"))) as typeof import("../packages/engine/src/workspace-fork.js");
    const { mkdir, readFile, writeFile } = await import("node:fs/promises");

    const sourceSidecarRoot = resolve(dataDir, "donor", "sidecar-populated");
    await mkdir(sourceSidecarRoot, { recursive: true });
    await writeFile(resolve(sourceSidecarRoot, "marker.txt"), "sidecar-fixture");

    const targetWorkspaceId = `workspace:v4-fork-sidecar-target:${dataDir}`;
    const targetDatabasePath = resolve(dataDir, "target-sidecar", "workspace.sqlite");
    const targetStructuralRoot = resolve(dataDir, "target-sidecar", "structural");
    const targetSidecarRoot = resolve(dataDir, "target-sidecar", "sidecar");

    const forkResult = await forkV4Workspace({
      sourceStructuralRoot: donorStructuralRoot,
      targetStructuralRoot,
      sourceDatabasePath: donorDatabasePath,
      targetDatabasePath,
      sourceWorkspaceId: donorWorkspaceId,
      targetWorkspaceId,
      sourceSidecarRoot,
      targetSidecarRoot,
    });
    expect(forkResult.ok).toBe(true);

    const copied = await readFile(resolve(targetSidecarRoot, "marker.txt"), "utf8");
    expect(copied).toBe("sidecar-fixture");
  });

  it("skips the sidecar copy when sourceSidecarRoot is provided but does not exist on disk", async () => {
    const { forkV4Workspace } = (await import(resolve(repoRoot, "packages/engine/dist/workspace-fork.js"))) as typeof import("../packages/engine/src/workspace-fork.js");
    const { existsSync: exists } = await import("node:fs");

    const targetWorkspaceId = `workspace:v4-fork-no-sidecar-target:${dataDir}`;
    const targetDatabasePath = resolve(dataDir, "target-no-sidecar", "workspace.sqlite");
    const targetStructuralRoot = resolve(dataDir, "target-no-sidecar", "structural");
    const targetSidecarRoot = resolve(dataDir, "target-no-sidecar", "sidecar");
    const sourceSidecarRoot = resolve(dataDir, "donor", "sidecar-that-does-not-exist");

    const forkResult = await forkV4Workspace({
      sourceStructuralRoot: donorStructuralRoot,
      targetStructuralRoot,
      sourceDatabasePath: donorDatabasePath,
      targetDatabasePath,
      sourceWorkspaceId: donorWorkspaceId,
      targetWorkspaceId,
      sourceSidecarRoot,
      targetSidecarRoot,
    });
    expect(forkResult.ok).toBe(true);
    expect(exists(targetSidecarRoot)).toBe(false);
  });

  it("is a no-op copy: forking a workspace onto itself (same id) leaves every row unchanged", async () => {
    const { rewriteV4WorkspaceIdentity } = (await import(resolve(repoRoot, "packages/engine/dist/workspace-fork.js"))) as typeof import("../packages/engine/src/workspace-fork.js");
    const { openSqliteDatabase } = (await import(resolve(repoRoot, "packages/storage/dist/index.js"))) as typeof import("../packages/storage/src/index.js");
    const database = await openSqliteDatabase({ filename: donorDatabasePath });
    try {
      const before = await database.get<{ snapshot_id: string }>("SELECT snapshot_id FROM snapshots WHERE workspace_id = ?", [donorWorkspaceId]);
      await rewriteV4WorkspaceIdentity(database, donorWorkspaceId, donorWorkspaceId);
      const after = await database.get<{ snapshot_id: string }>("SELECT snapshot_id FROM snapshots WHERE workspace_id = ?", [donorWorkspaceId]);
      expect(after?.snapshot_id).toBe(before?.snapshot_id);
    } finally {
      await database.close();
    }
  });
});
