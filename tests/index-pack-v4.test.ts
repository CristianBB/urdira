import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end gate for `packages/engine/src/index-pack.ts`'s v4 pack
 * container (task P2-4): cold-scans the small `tests/fixtures/codebases/
 * typescript/task-planner` fixture into a real v4 workspace, exports it to
 * a `.urdira-index-pack-v4` file, imports it into a fresh set of target
 * paths, and confirms the import is byte-faithful (root verification) and
 * independently passes `verifyV4Workspace`.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = resolve(repoRoot, "tests/fixtures/codebases/typescript/task-planner");
const workerPath = process.env["URDIRA_INDEXING_CORE_WORKER_PATH"] ?? resolve(repoRoot, "target/release/urdira-indexing-worker");

const hasWorkerBinary = existsSync(workerPath);
const describeIfBuilt = hasWorkerBinary ? describe : describe.skip;

describeIfBuilt("v4 index pack export/import (task-planner fixture)", () => {
  let dataDir: string;
  let workspaceId: string;
  let databasePath: string;
  let structuralRoot: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "urdira-v4-pack-test-"));
    workspaceId = `workspace:v4-pack-test:${dataDir}`;
    databasePath = resolve(dataDir, "donor", "workspace.sqlite");
    structuralRoot = resolve(dataDir, "donor", "structural");
    const casRoot = resolve(dataDir, "donor", "cas");
    const sidecarRoot = resolve(dataDir, "donor", "sidecar");

    const { createIndexingCoreProcessTransport } = await import(resolve(repoRoot, "packages/plugin-javascript-typescript/dist/indexing-core-process-transport.js"));
    const { runRustWorkspaceScan } = await import(resolve(repoRoot, "packages/engine/dist/rust-workspace-scan.js"));
    const { WORKSPACE_V4_SCHEMA } = await import(resolve(repoRoot, "packages/storage/dist/workspace-v4-sql.generated.js"));
    const { encodeCanonical } = await import(resolve(repoRoot, "packages/canonical/dist/index.js"));
    const { mkdir } = await import("node:fs/promises");

    await mkdir(resolve(dataDir, "donor"), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec(WORKSPACE_V4_SCHEMA);
    const insertMeta = db.prepare("INSERT INTO workspace_meta (key, value) VALUES (?, ?)");
    insertMeta.run("index_contract", Uint8Array.of(0x34));
    insertMeta.run("identity_format", encodeCanonical(3));
    insertMeta.run("structural_store", encodeCanonical("native"));
    db.close();

    const transport = createIndexingCoreProcessTransport({ command: workerPath, request_timeout_ms: 120_000 });
    try {
      await runRustWorkspaceScan(transport, {
        workspace_id: workspaceId,
        workspace_root: fixtureRoot,
        database_path: databasePath,
        structural_root: structuralRoot,
        cas_root: casRoot,
        sidecar_root: sidecarRoot,
        scope: { kind: "full" },
        registry_snapshot_id: "registry:v4-pack-test",
        configuration_revision_id: "configuration:v4-pack-test",
        resolution_lock_id: "resolution:v4-pack-test",
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

  // 60s, not the 5s default: this export+import+verify round trip measured
  // 3.14-4.40s on an idle machine (docs/evidence/2026-09-04-v4-p4-b-prep-
  // health.md Part 2, item #3) but timed out at the 5s default under
  // full-suite CPU load (19+ files' worth of real native-addon scans
  // running concurrently in the same vitest process). A prior fix bumped
  // this to 20s (~5x the idle max); widened further to an explicit 60_000
  // (plan 3.2) since this session runs under heavier-than-usual multi-agent
  // CPU contention (concurrent cargo builds from sibling worktrees).
  it("round-trips a v4 workspace through export -> import with verified roots", async () => {
    const { exportV4IndexPack, importV4IndexPack } = (await import(resolve(repoRoot, "packages/engine/dist/index-pack.js"))) as typeof import("../packages/engine/src/index-pack.js");
    const { verifyV4Workspace } = await import(resolve(repoRoot, "packages/engine/dist/v4-verify.js"));
    const { openSqliteDatabase } = await import(resolve(repoRoot, "packages/storage/dist/index.js"));

    const packPath = resolve(dataDir, "workspace.urdira-index-pack-v4");
    const exported = await exportV4IndexPack({ databasePath, structuralRoot, workspaceId, outputPath: packPath });
    expect(exported.manifest.generation).toBe(1);
    expect(exported.manifest.roots["records"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(exported.manifest.files.some((entry) => entry.path === "workspace.sqlite")).toBe(true);
    expect(exported.manifest.files.some((entry) => entry.path === "structural/merkle/records.tree")).toBe(true);

    const targetDatabasePath = resolve(dataDir, "target", "workspace.sqlite");
    const targetStructuralRoot = resolve(dataDir, "target", "structural");
    const imported = await importV4IndexPack({ packPath, targetDatabasePath, targetStructuralRoot });
    expect(imported.root_mismatches).toEqual([]);
    expect(imported.roots_verified).toBe(true);

    const database = await openSqliteDatabase({ filename: targetDatabasePath });
    try {
      const report = await verifyV4Workspace(database, targetStructuralRoot, workspaceId);
      expect(report.failures).toEqual([]);
      expect(report.ok).toBe(true);
    } finally {
      await database.close();
    }
  }, 60_000);

  // Same 60s rationale as the round-trip tests below: this exports the WHOLE
  // structural store before truncating it, so it carries the identical
  // full-suite CPU-contention risk under the 5s default.
  it("catches a truncated pack file", async () => {
    const { exportV4IndexPack, importV4IndexPack } = (await import(resolve(repoRoot, "packages/engine/dist/index-pack.js"))) as typeof import("../packages/engine/src/index-pack.js");
    const packPath = resolve(dataDir, "workspace-truncate.urdira-index-pack-v4");
    await exportV4IndexPack({ databasePath, structuralRoot, workspaceId, outputPath: packPath });
    const full = await readFile(packPath);
    const truncatedPath = resolve(dataDir, "workspace-truncated.urdira-index-pack-v4");
    await writeFile(truncatedPath, full.subarray(0, Math.floor(full.length / 2)));

    const targetDatabasePath = resolve(dataDir, "target-truncated", "workspace.sqlite");
    const targetStructuralRoot = resolve(dataDir, "target-truncated", "structural");
    await expect(importV4IndexPack({ packPath: truncatedPath, targetDatabasePath, targetStructuralRoot })).rejects.toThrow();
  }, 60_000);

  // Same 60s rationale as the main round-trip test above: this exports and
  // re-imports the WHOLE structural store (not just the sidecar file), so it
  // carries the identical full-suite CPU-contention risk under the 5s default.
  it("round-trips a sidecar/ entry when both sidecarRoot (export) and targetSidecarRoot (import) are given", async () => {
    const { exportV4IndexPack, importV4IndexPack } = (await import(resolve(repoRoot, "packages/engine/dist/index-pack.js"))) as typeof import("../packages/engine/src/index-pack.js");
    const sidecarRoot = resolve(dataDir, "donor-sidecar-populated");
    await mkdir(sidecarRoot, { recursive: true });
    await writeFile(resolve(sidecarRoot, "lexical.marker"), "lexical-fixture");

    const packPath = resolve(dataDir, "workspace-with-sidecar.urdira-index-pack-v4");
    const exported = await exportV4IndexPack({ databasePath, structuralRoot, sidecarRoot, workspaceId, outputPath: packPath });
    expect(exported.manifest.files.some((entry) => entry.path === "sidecar/lexical.marker")).toBe(true);

    const targetDatabasePath = resolve(dataDir, "target-with-sidecar", "workspace.sqlite");
    const targetStructuralRoot = resolve(dataDir, "target-with-sidecar", "structural");
    const targetSidecarRoot = resolve(dataDir, "target-with-sidecar", "sidecar");
    const imported = await importV4IndexPack({ packPath, targetDatabasePath, targetStructuralRoot, targetSidecarRoot });
    expect(imported.roots_verified).toBe(true);

    const copied = await readFile(resolve(targetSidecarRoot, "lexical.marker"), "utf8");
    expect(copied).toBe("lexical-fixture");
  }, 60_000);

  // Same 60s rationale as the round-trip tests above: this exports the
  // WHOLE structural store (plus a sidecar entry) before the import
  // rejection, so it carries the identical full-suite CPU-contention risk
  // under the 5s default -- measured flaking under `pnpm test:coverage`
  // (Test timed out in 5000ms) even though the siblings above were already
  // given headroom; this one was missed at the time.
  it("rejects importing a pack with sidecar/ entries when no targetSidecarRoot is given", async () => {
    const { exportV4IndexPack, importV4IndexPack } = (await import(resolve(repoRoot, "packages/engine/dist/index-pack.js"))) as typeof import("../packages/engine/src/index-pack.js");
    const sidecarRoot = resolve(dataDir, "donor-sidecar-for-rejection");
    await mkdir(sidecarRoot, { recursive: true });
    await writeFile(resolve(sidecarRoot, "semantic.marker"), "semantic-fixture");

    const packPath = resolve(dataDir, "workspace-with-sidecar-no-target.urdira-index-pack-v4");
    await exportV4IndexPack({ databasePath, structuralRoot, sidecarRoot, workspaceId, outputPath: packPath });

    const targetDatabasePath = resolve(dataDir, "target-sidecar-rejected", "workspace.sqlite");
    const targetStructuralRoot = resolve(dataDir, "target-sidecar-rejected", "structural");
    // No targetSidecarRoot in options -- v4PackDestinationPath must reject
    // the pack's own "sidecar/..." entries rather than silently dropping
    // them or writing them somewhere unintended.
    await expect(importV4IndexPack({ packPath, targetDatabasePath, targetStructuralRoot })).rejects.toThrow(/targetSidecarRoot/);
  }, 60_000);

  it("rejects an entry path outside the known workspace.sqlite/structural/sidecar roots (malformed or hand-crafted pack)", async () => {
    const { importV4IndexPack } = (await import(resolve(repoRoot, "packages/engine/dist/index-pack.js"))) as typeof import("../packages/engine/src/index-pack.js");
    const manifest = {
      format: "urdira-index-pack-v4",
      schema_version: 1,
      workspace_id: "workspace:bogus-entry-test",
      generation: 1,
      roots: {},
      canonical_record_set_digest: "",
      source_state_digest: "",
      files: [{ path: "not-a-known-root/file.txt", byte_length: 5 }],
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    const lengthPrefix = Buffer.alloc(4);
    lengthPrefix.writeUInt32LE(manifestBytes.length, 0);
    const fileBytes = Buffer.from("hello", "utf8");
    const raw = Buffer.concat([lengthPrefix, manifestBytes, fileBytes]);

    const packPath = resolve(dataDir, "bogus-entry.urdira-index-pack-v4");
    await writeFile(packPath, gzipSync(raw));

    const targetDatabasePath = resolve(dataDir, "target-bogus-entry", "workspace.sqlite");
    const targetStructuralRoot = resolve(dataDir, "target-bogus-entry", "structural");
    await expect(importV4IndexPack({ packPath, targetDatabasePath, targetStructuralRoot })).rejects.toThrow(/outside the known roots/);
  });
});
