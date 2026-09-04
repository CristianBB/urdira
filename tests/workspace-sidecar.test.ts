import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDurableStorage } from "../packages/storage/src/index.js";
import type { Workspace } from "@urdira/contracts";

const workspace: Workspace = {
  workspace_id: "ws-sidecar",
  canonical_root: "/repositories/sidecar",
  display_root: "/repositories/sidecar",
  source_provider_bindings: [],
  status: "registered",
  registered_at: "2026-09-02T00:00:00.000000000Z",
};

describe("WorkspaceDatabase.openSidecar", () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("creates a lexical sidecar file next to the workspace database, initialized with the v4 lexical schema", async () => {
    root = await mkdtemp(join(tmpdir(), "urdira-sidecar-test-"));
    const storage = await createDurableStorage({ rootDir: root });
    try {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      try {
        const sidecar = await opened.openSidecar("lexical");
        expect(basename(sidecar.filename)).toBe(`${basename(opened.database.filename, ".sqlite")}.lexical.sqlite`);
        const tables = await sidecar.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
        // fts5 creates shadow tables (lexical_fts_*) alongside the virtual table itself.
        expect(tables.map((table) => table.name)).toEqual(["lexical_documents", "lexical_fts", "lexical_fts_config", "lexical_fts_content", "lexical_fts_data", "lexical_fts_docsize", "lexical_fts_idx", "lexical_index_state"]);

        await sidecar.run("INSERT INTO lexical_index_state (workspace_id, completed_generation) VALUES (?, ?)", [workspace.workspace_id, 3]);
        const row = await sidecar.get<{ completed_generation: number }>("SELECT completed_generation FROM lexical_index_state WHERE workspace_id = ?", [workspace.workspace_id]);
        expect(row?.completed_generation).toBe(3);

        // A second call for the same kind reuses the cached connection.
        const again = await opened.openSidecar("lexical");
        expect(again).toBe(sidecar);
      } finally { await opened.close(); }
    } finally { await storage.close(); }
  });

  it("creates a distinct semantic sidecar and persists rows across a reopen", async () => {
    root = await mkdtemp(join(tmpdir(), "urdira-sidecar-semantic-test-"));
    const storage = await createDurableStorage({ rootDir: root });
    try {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      try {
        const lexical = await opened.openSidecar("lexical");
        const semantic = await opened.openSidecar("semantic");
        expect(semantic.filename).not.toBe(lexical.filename);
        await semantic.run("INSERT INTO semantic_index_state (workspace_id, completed_generation, profile_id, executable_binding_id) VALUES (?, ?, ?, ?)", [workspace.workspace_id, 1, "profile-1", "binding-1"]);
      } finally { await opened.close(); }

      // Reopening the workspace and the sidecar re-reads the same file on disk.
      const reopened = await storage.openWorkspace(workspace.workspace_id);
      try {
        const semanticAgain = await reopened.openSidecar("semantic");
        const row = await semanticAgain.get<{ profile_id: string }>("SELECT profile_id FROM semantic_index_state WHERE workspace_id = ?", [workspace.workspace_id]);
        expect(row?.profile_id).toBe("profile-1");
      } finally { await reopened.close(); }
    } finally { await storage.close(); }
  });
});
