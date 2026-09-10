import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureV4Workspace, sidecarDatabasePathFor } from "../packages/engine/src/index.js";
import { createDurableStorage } from "../packages/storage/src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("v4 semantic sidecar opt-out", () => {
  it("does not create a semantic database when semantic indexing is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-v4-no-semantic-"));
    roots.push(root);
    const storage = await createDurableStorage({ rootDir: root });
    try {
      const paths = await ensureV4Workspace({
        storage: storage as unknown as Parameters<typeof ensureV4Workspace>[0]["storage"],
        workspace_id: "workspace:no-semantic",
        create_semantic_sidecar: false,
      });
      expect(existsSync(sidecarDatabasePathFor(paths.database_path, "lexical"))).toBe(true);
      expect(existsSync(sidecarDatabasePathFor(paths.database_path, "semantic"))).toBe(false);

      await ensureV4Workspace({
        storage: storage as unknown as Parameters<typeof ensureV4Workspace>[0]["storage"],
        workspace_id: "workspace:no-semantic",
        create_semantic_sidecar: true,
      });
      expect(existsSync(sidecarDatabasePathFor(paths.database_path, "semantic"))).toBe(true);
    } finally {
      await storage.close();
    }
  });
});
