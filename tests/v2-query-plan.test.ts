import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDurableStorage } from "../packages/storage/src/index.js";
import type { Workspace } from "@urdira/contracts";

const workspace: Workspace = {
  workspace_id: "query-plan-workspace",
  canonical_root: "/tmp/query-plan-workspace",
  display_root: "/tmp/query-plan-workspace",
  source_provider_bindings: [],
  status: "registered",
  registered_at: "2026-08-20T00:00:00.000000000Z",
};

async function withWorkspace(test: (database: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>["database"]) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "urdira-query-plan-"));
  const storage = await createDurableStorage({ rootDir: root });
  try {
    await storage.catalog.registerWorkspace(workspace);
    const opened = await storage.openWorkspace(workspace.workspace_id);
    try {
      await test(opened.database);
    } finally {
      await opened.close();
    }
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe("v3 bounded query plans", () => {
  it("uses the workspace/generation indexes for critical paginated ports", async () => {
    await withWorkspace(async (database) => {
      const cases = [
        {
          name: "records",
          sql: "SELECT record_id, category, universal_kind, kind, owner_artifact_id, owner_artifact_version_id FROM record_occurrences WHERE workspace_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?) ORDER BY record_id LIMIT ?",
          index: "record_occurrences_visible_idx",
          params: [workspace.workspace_id, 1, 0, 50],
        },
        {
          name: "graph outbound",
          sql: "SELECT edge_id, target_subject_id, relation_kind FROM graph_edges WHERE workspace_id = ? AND source_subject_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?) ORDER BY edge_id LIMIT ?",
          index: "graph_edges_outbound_visible_idx",
          params: [workspace.workspace_id, "selector", 1, 0, 50],
        },
        {
          name: "graph inbound",
          sql: "SELECT edge_id, source_subject_id, relation_kind FROM graph_edges WHERE workspace_id = ? AND target_subject_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?) ORDER BY edge_id LIMIT ?",
          index: "graph_edges_inbound_visible_idx",
          params: [workspace.workspace_id, "selector", 1, 0, 50],
        },
        {
          name: "dependencies direct",
          sql: "SELECT dependency_entry_id, dependency_artifact_id, dependency_artifact_version_id FROM artifact_dependencies WHERE workspace_id = ? AND record_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?) ORDER BY dependency_entry_id LIMIT ?",
          index: "artifact_dependencies_direct_idx",
          params: [workspace.workspace_id, "record", 1, 0, 50],
        },
        {
          name: "dependencies reverse",
          sql: "SELECT dependency_entry_id, record_id FROM artifact_dependencies WHERE workspace_id = ? AND dependency_artifact_id = ? AND dependency_artifact_version_id = ? AND valid_from_generation <= ? ORDER BY dependency_entry_id LIMIT ?",
          index: "artifact_dependencies_reverse_idx",
          params: [workspace.workspace_id, "artifact", "version", 1, 50],
        },
        {
          name: "vectors",
          sql: "SELECT projection_record_id, vector_digest FROM vector_projection_rows WHERE workspace_id = ? AND profile_id = ? AND executable_binding_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?) ORDER BY projection_record_id LIMIT ?",
          index: "vector_projection_visible_idx",
          params: [workspace.workspace_id, "profile", "binding", 1, 0, 50],
        },
      ] as const;

      for (const query of cases) {
        const plan = await database.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${query.sql}`, query.params);
        const detail = plan.map((row) => row.detail).join(" | ");
        expect(detail, `${query.name} plan: ${detail}`).toContain(query.index);
      }
    });
  });
});
