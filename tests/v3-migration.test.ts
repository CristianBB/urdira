import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Workspace } from "@urdira/contracts";
import { createDurableStorage, inspectV3DataRoot, migrateToV3 } from "../packages/storage/src/index.js";

const workspace: Workspace = {
  workspace_id: "v3-migration-workspace",
  canonical_root: "/migration/v3-workspace",
  display_root: "/migration/v3-workspace",
  source_provider_bindings: [],
  status: "registered",
  registered_at: "2026-08-21T00:00:00.000000000Z",
};

describe("explicit v3 data-root migration", () => {
  it("inventories the v3 marker and prepares a recoverable sibling root", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-v3-migration-"));
    const destination = `${root}-destination`;
    try {
      const storage = await createDurableStorage({ rootDir: root, inlineThresholdBytes: 8 });
      await storage.catalog.registerWorkspace(workspace);
      await storage.close();

      const preview = await inspectV3DataRoot(root);
      expect(preview.data_format).toBe(3);
      expect(preview.v1_detected).toBe(false);
      expect(preview.workspaces).toHaveLength(1);
      expect(preview.confirmation_required).toBe(true);

      const dryRun = await migrateToV3({ data_root: root, destination_root: destination, confirm: false });
      expect(dryRun.destination_root).toBe(destination);
      await expect(access(join(destination, "migration-backup.json"))).rejects.toMatchObject({ code: "ENOENT" });

      const migrated = await migrateToV3({ data_root: root, destination_root: destination, confirm: true });
      expect(migrated.data_format).toBe(3);
      expect(migrated.cas_preserved).toBe(true);
      expect(JSON.parse(await readFile(join(destination, "data-format.json"), "utf8"))).toMatchObject({ data_format: 3, reindex_required: true });
      await expect(access(join(destination, "catalog-legacy-backup.sqlite"))).resolves.toBeUndefined();
      await expect(access(join(root, "catalog.sqlite"))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    }
  });
});
