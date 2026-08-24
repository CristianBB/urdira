import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runIndexPackExportInThread } from "../packages/daemon/src/index-pack-export-thread.js";
import { exportIndexPack, runFullWorkspaceScan, WorkspaceRegistry } from "../packages/engine/src/index.js";
import { createDurableStorage } from "../packages/storage/src/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  FORK_INCLUSION_RULES,
  asStorageDatabase,
  buildPluginProvider,
  now,
  openEngineWorkspace,
  prepareRegistry,
  registerEngineWorkspace,
  seedFixtureFiles,
} from "./helpers/fork-harness.js";

// `runIndexPackExportInThread` (`packages/daemon/src/index-pack-export-thread.ts`)
// spawns a REAL `node:worker_threads` worker running compiled
// `packages/daemon/dist/index-pack-export-worker-thread.js` (same
// `import.meta.resolve("@urdira/daemon")` self-reference as
// `lexical-thread.ts`; see `tests/lexical-thread-transport.test.ts`'s header
// for the dist-must-exist prerequisite). This file verifies the cross-thread
// wiring only -- result parity with a direct in-process `exportIndexPack`
// and in-worker error propagation; the export's own content/tamper behavior
// is `tests/phase-index-pack.test.ts`'s job.
describe("Index pack export worker-thread transport", () => {
  it("produces the same pack identity as a direct in-process export, and surfaces in-worker failures as rejections", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-index-pack-thread-data-"));
    const donorRoot = await mkdtemp(join(tmpdir(), "urdira-index-pack-thread-donor-"));
    const storage = await createDurableStorage({ rootDir: dataRoot });
    let closed = false;
    try {
      await seedFixtureFiles(donorRoot);
      const registry = new WorkspaceRegistry();
      const workspace = await registerEngineWorkspace(registry, donorRoot, "donor");
      const database = await openEngineWorkspace(storage, workspace);
      const prepared = await prepareRegistry(workspace.workspace_id);
      const plugin = buildPluginProvider(prepared, workspace.workspace_id, prepared.registry.registry_snapshot_id, `configuration:${workspace.workspace_id}`, new Set());
      const scan = await runFullWorkspaceScan({ root: donorRoot, database: asStorageDatabase(database), workspace_id: workspace.workspace_id, plugin, inclusion_rules: FORK_INCLUSION_RULES });
      expect(scan.status).toBe("published");

      const directPath = join(dataRoot, "direct.index-pack.gz");
      const direct = await exportIndexPack({ database: asStorageDatabase(database), workspace_id: workspace.workspace_id, out_path: directPath, now: () => now });
      await database.close();
      // The worker opens its own `DurableStorage` over the same data root
      // (exactly what the daemon does); close this file's handle first so
      // the test cannot accidentally depend on sharing one.
      await storage.close();
      closed = true;

      const threadPath = join(dataRoot, "thread.index-pack.gz");
      const threaded = await runIndexPackExportInThread({ data_root: dataRoot, workspace_id: workspace.workspace_id, out_path: threadPath });
      await access(threadPath);
      // `created_at` (and with it `manifest_digest`) legitimately differs
      // between the two runs; every content-identifying field must not.
      expect(threaded.manifest.pack_id).toBe(direct.manifest.pack_id);
      expect(threaded.manifest.row_counts).toEqual(direct.manifest.row_counts);
      expect(threaded.manifest.donor_snapshot_anchor).toEqual(direct.manifest.donor_snapshot_anchor);
      expect(threaded.manifest.multiset_digest).toBe(direct.manifest.multiset_digest);

      // In-worker failure (unknown workspace: no published generation) must
      // reject through the transport, not hang or exit uncaught.
      await expect(runIndexPackExportInThread({ data_root: dataRoot, workspace_id: "workspace:00000000-0000-4000-8000-000000000000", out_path: join(dataRoot, "never.index-pack.gz") })).rejects.toThrow();
    } finally {
      if (!closed) await storage.close();
      await rm(donorRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);
});
