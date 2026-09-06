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

  // Frente P-1 (plan `generic-waddling-hartmanis.md` §7.1, R17): the daemon
  // ALWAYS imports into a workspace id different from the donor's (two
  // installations mint independent ids for what may be the same canonical
  // root) -- `targetWorkspaceId` must re-pin `workspace_meta`'s BLOB
  // `workspace_id` row (skipped by `rewriteV4WorkspaceIdentity`, which is
  // generic over TEXT columns only) so `storage.openWorkspace` never sees a
  // foreign id and throws `storage:workspace_binding_mismatch`. 90s (not the
  // suite's usual 60s for a v4 pack round trip): this test does a FULL
  // export+import AND opens the result through the real `DurableStorage`
  // layer (schema stamping, identity binding, a catalog lease) on top of
  // the same CPU-contention risk the other round-trip tests already widen
  // their own timeout for.
  it("imports into a workspace_id different from the donor's: workspace_meta is re-pinned, snapshot digests recomputed, roots verified, and storage.openWorkspace opens without a binding_mismatch", async () => {
    const { exportV4IndexPack, importV4IndexPack } = (await import(resolve(repoRoot, "packages/engine/dist/index-pack.js"))) as typeof import("../packages/engine/src/index-pack.js");
    const { structuralStoreDirFor } = (await import(resolve(repoRoot, "packages/engine/dist/index.js"))) as typeof import("../packages/engine/src/index.js");
    const { createDurableStorage, openSqliteDatabase } = (await import(resolve(repoRoot, "packages/storage/dist/index.js"))) as typeof import("../packages/storage/src/index.js");
    const { encodeCanonical, decodeCanonical } = (await import(resolve(repoRoot, "packages/canonical/dist/index.js"))) as typeof import("../packages/canonical/src/index.js");

    // The donor fixture (`beforeAll`, via a real Rust cold scan) never went
    // through `storage.openWorkspace`, so it never got a `workspace_meta`
    // `workspace_id` row bound at all -- bind one by hand here, exactly the
    // way `bindWorkspaceIdentity` (`packages/storage/src/storage.ts`) would
    // on this workspace's first real open, so the re-pin below has a real
    // FOREIGN value to overwrite (the realistic case: any donor workspace a
    // daemon has actually served queries against already has this row).
    const donorDb = await openSqliteDatabase({ filename: databasePath });
    try {
      await donorDb.run("INSERT INTO workspace_meta (key, value) VALUES ('workspace_id', ?) ON CONFLICT(key) DO NOTHING", [encodeCanonical(workspaceId)]);
    } finally {
      await donorDb.close();
    }

    const packPath = resolve(dataDir, "workspace-repin.urdira-index-pack-v4");
    await exportV4IndexPack({ databasePath, structuralRoot, workspaceId, outputPath: packPath });

    const targetWorkspaceId = `workspace:v4-pack-repin-target:${dataDir}`;
    const dataRoot = resolve(dataDir, "repin-storage-root");
    const storage = await createDurableStorage({ rootDir: dataRoot });
    try {
      const targetDatabasePath = storage.defaultWorkspaceDatabasePath(targetWorkspaceId);
      const imported = await importV4IndexPack({
        packPath,
        targetDatabasePath,
        targetStructuralRoot: structuralStoreDirFor(targetDatabasePath),
        targetWorkspaceId,
      });
      expect(imported.root_mismatches).toEqual([]);
      expect(imported.roots_verified).toBe(true);

      // Directly assert `workspace_meta`'s BLOB row -- the one column
      // `rewriteV4WorkspaceIdentity` deliberately skips -- carries the NEW
      // id, not the donor's.
      const rewritten = await openSqliteDatabase({ filename: targetDatabasePath });
      try {
        const row = await rewritten.get<{ value: unknown }>("SELECT value FROM workspace_meta WHERE key = 'workspace_id'");
        expect(row).toBeDefined();
        expect(decodeCanonical(row!.value instanceof Uint8Array ? row!.value : new Uint8Array(row!.value as ArrayBuffer))).toBe(targetWorkspaceId);
        const snapshot = await rewritten.get<{ workspace_id: string; snapshot_digest: string }>("SELECT workspace_id, snapshot_digest FROM snapshots WHERE workspace_id = ?", [targetWorkspaceId]);
        expect(snapshot).toBeDefined();
        expect(snapshot!.workspace_id).toBe(targetWorkspaceId);
        expect(snapshot!.snapshot_digest.length).toBeGreaterThan(0);
      } finally {
        await rewritten.close();
      }

      await storage.catalog.registerWorkspace({
        workspace_id: targetWorkspaceId,
        canonical_root: "/index-pack-repin-target",
        display_root: "/index-pack-repin-target",
        source_provider_bindings: [],
        status: "registered",
        registered_at: new Date().toISOString(),
      });
      // The real acceptance criterion: opening the imported catalog through
      // the SAME production code path a daemon uses (`DurableStorage.openWorkspace`
      // -> `bindWorkspaceIdentity`) must succeed, not throw
      // `storage:workspace_binding_mismatch` -- proving the donor's id is
      // truly gone from the one column the generic rewrite cannot reach.
      const opened = await storage.openWorkspace(targetWorkspaceId);
      await opened.close();
    } finally {
      await storage.close();
    }
  }, 90_000);

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
