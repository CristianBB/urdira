import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SparseMerkleSet } from "../packages/canonical/src/index.js";
import { PersistentSparseMerkleSet, createDurableStorage } from "../packages/storage/src/index.js";

describe("sparse logical set roots", () => {
  it("updates and verifies roots deterministically", () => {
    const trie = new SparseMerkleSet();
    trie.set(`sha256:${"1".repeat(64)}`, `sha256:${"a".repeat(64)}`);
    const first = trie.root();
    trie.set(`sha256:${"2".repeat(64)}`, `sha256:${"b".repeat(64)}`);
    expect(trie.root()).not.toBe(first);
    expect(trie.verify([{ member_digest: `sha256:${"1".repeat(64)}`, logical_digest: `sha256:${"a".repeat(64)}` }, { member_digest: `sha256:${"2".repeat(64)}`, logical_digest: `sha256:${"b".repeat(64)}` }])).toBe(true);
    trie.delete(`sha256:${"2".repeat(64)}`);
    expect(trie.verify([{ member_digest: `sha256:${"1".repeat(64)}`, logical_digest: `sha256:${"a".repeat(64)}` }])).toBe(true);
  });

  it("persists only the changed branches and reloads the root from SQLite", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-merkle-store-"));
    const storage = await createDurableStorage({ rootDir: root });
    try {
      const workspace = { workspace_id: "merkle-workspace", canonical_root: root, display_root: root, source_provider_bindings: [], status: "registered", registered_at: "2026-08-20T00:00:00.000000000Z" } as const;
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      const first = `sha256:${"1".repeat(64)}`;
      const second = `sha256:${"2".repeat(64)}`;
      const set = new PersistentSparseMerkleSet(opened.database, workspace.workspace_id, "records", 1);
      await set.set(first, `sha256:${"a".repeat(64)}`);
      await set.set(second, `sha256:${"b".repeat(64)}`);
      const beforeDelete = await set.root();
      await set.delete(second);
      expect(await set.root()).not.toBe(beforeDelete);
      const reloaded = new PersistentSparseMerkleSet(opened.database, workspace.workspace_id, "records", 1);
      expect(await reloaded.root()).toBe(await set.root());
      expect(await reloaded.verify()).toBe(true);
      const rows = await opened.database.all<{ node_prefix: string }>("SELECT node_prefix FROM set_merkle_nodes WHERE workspace_id = ? AND set_kind = ? AND generation = ?", [workspace.workspace_id, "records", 1]);
      expect(rows.some((row) => row.node_prefix.includes(second))).toBe(false);
      await opened.close();
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
