import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDurableStorage, type WorkspaceDatabase } from "../packages/storage/src/index.js";
import { createNativeSemanticEntityRecordSource, type CanonicalQueryRecord, type EntityScanPort } from "../packages/engine/src/index.js";
import type { QueryScope } from "../packages/contracts/src/index.js";

/**
 * v4 storage wiring (2026-09-07): `createNativeSemanticEntityRecordSource`
 * (`packages/engine/src/semantic-entity-source-v4.ts`) is the REAL source
 * `resolveV4SemanticEntitySource` (`packages/daemon/src/semantic-v4-wiring.ts`)
 * builds for a v4 workspace. `tests/semantic-maintenance.test.ts` already
 * exercises `reconcileSemanticProjection`'s consuming side against a hand-
 * written fake `SemanticEntityRecordSource`; this file exercises the OTHER
 * side -- the adapter itself -- against a fake `EntityScanPort` (a minimal
 * stand-in for `NativeCanonicalQuerySnapshotPort`) plus a REAL
 * `artifact_versions`/`source_artifacts` catalog (both tables byte-identical
 * between v3 and v4), so the SQL join it runs is exercised for real.
 */

const now = "2026-09-07T00:00:00.000Z";
const WORKSPACE_ID = "ws-v4-entity-src";
const scope: QueryScope = { scope_type: "single_workspace", workspace_id: WORKSPACE_ID };

function record(input: { readonly record_id: string; readonly kind: string; readonly owner_artifact_id: string; readonly owner_artifact_version_id: string; readonly body: Readonly<Record<string, unknown>> }): CanonicalQueryRecord {
  return { record_id: input.record_id, workspace_id: WORKSPACE_ID, category: "entity", kind: input.kind, universal_kind: "core:construct", owner_artifact_id: input.owner_artifact_id, owner_artifact_version_id: input.owner_artifact_version_id, body: input.body };
}

function fakePort(records: readonly CanonicalQueryRecord[]): EntityScanPort {
  return {
    records_for_query: async (querScope: QueryScope): Promise<readonly CanonicalQueryRecord[]> => {
      expect(querScope).toEqual(scope);
      return records;
    },
    records_by_ids: async (_querScope: QueryScope, ids: readonly string[]): Promise<readonly CanonicalQueryRecord[]> => {
      const idSet = new Set(ids);
      return records.filter((row) => idSet.has(row.record_id));
    },
  };
}

async function withWorkspace(test: (opened: WorkspaceDatabase) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "urdira-semantic-v4-entity-source-"));
  const storage = await createDurableStorage({ rootDir: root });
  try {
    await storage.catalog.registerWorkspace({ workspace_id: WORKSPACE_ID, canonical_root: "/ws-v4-entity-src", display_root: "/ws-v4-entity-src", source_provider_bindings: [], status: "registered", registered_at: now });
    const opened = await storage.openWorkspace(WORKSPACE_ID);
    try { await test(opened); } finally { await opened.close(); }
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function seedArtifactVersion(opened: WorkspaceDatabase, input: { readonly artifactId: string; readonly artifactVersionId: string; readonly displayPath: string; readonly encoding: "utf-8" | "binary" }): Promise<void> {
  await opened.database.exec("PRAGMA foreign_keys = OFF");
  await opened.database.run("INSERT OR IGNORE INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind) VALUES (?, ?, ?, ?, ?, 'physical_file')", [input.artifactId, WORKSPACE_ID, input.artifactId, input.artifactId, input.displayPath]);
  await opened.database.run("INSERT OR IGNORE INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)", [`blob-${input.artifactVersionId}`, `hash-${input.artifactVersionId}`, 42, `ref-${input.artifactVersionId}`]);
  await opened.database.run(
    `INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'text', 'digest', 'obs-1', 1, NULL)`,
    [input.artifactVersionId, WORKSPACE_ID, input.artifactId, `blob-${input.artifactVersionId}`, `hash-${input.artifactVersionId}`, 42, input.encoding],
  );
}

describe("createNativeSemanticEntityRecordSource", () => {
  it("entityCandidates() filters to category='entity', joins owner CAS metadata, drops binary-owned records, and sorts by (owner_artifact_version_id, record_id)", async () => {
    await withWorkspace(async (opened) => {
      await seedArtifactVersion(opened, { artifactId: "art-b", artifactVersionId: "artv-b", displayPath: "src/b.ts", encoding: "utf-8" });
      await seedArtifactVersion(opened, { artifactId: "art-a", artifactVersionId: "artv-a", displayPath: "src/a.ts", encoding: "utf-8" });
      await seedArtifactVersion(opened, { artifactId: "art-bin", artifactVersionId: "artv-bin", displayPath: "src/bin.dat", encoding: "binary" });

      const records: readonly CanonicalQueryRecord[] = [
        record({ record_id: "rec-z", kind: "jsts:entity_callable", owner_artifact_id: "art-b", owner_artifact_version_id: "artv-b", body: { kind: "function", name: "z" } }),
        record({ record_id: "rec-a", kind: "jsts:entity_callable", owner_artifact_id: "art-a", owner_artifact_version_id: "artv-a", body: { kind: "function", name: "a" } }),
        record({ record_id: "rec-container", kind: "jsts:entity_container", owner_artifact_id: "art-a", owner_artifact_version_id: "artv-a", body: { kind: "module", name: "a.ts" } }),
        record({ record_id: "rec-in-binary", kind: "jsts:entity_callable", owner_artifact_id: "art-bin", owner_artifact_version_id: "artv-bin", body: { kind: "function", name: "b" } }),
        // Not category "entity" -- must never appear in the result.
        { ...record({ record_id: "rec-relation", kind: "jsts:relation_references", owner_artifact_id: "art-a", owner_artifact_version_id: "artv-a", body: {} }), category: "relation" },
      ];
      const source = createNativeSemanticEntityRecordSource({ database: opened.database, port: fakePort(records), workspace_id: WORKSPACE_ID });

      const candidates = await source.entityCandidates();
      expect(candidates.map((row) => row.record_id)).toEqual(["rec-a", "rec-container", "rec-z"]);
      const a = candidates.find((row) => row.record_id === "rec-a")!;
      expect(a).toMatchObject({ record_kind: "jsts:entity_callable", owner_artifact_id: "art-a", owner_artifact_version_id: "artv-a", content_hash: "hash-artv-a", byte_length: 42, display_path: "src/a.ts", body: { kind: "function", name: "a" } });
    });
  });

  it("entityCandidates() returns [] when there are no entity-category records at all", async () => {
    await withWorkspace(async (opened) => {
      const source = createNativeSemanticEntityRecordSource({ database: opened.database, port: fakePort([]), workspace_id: WORKSPACE_ID });
      expect(await source.entityCandidates()).toEqual([]);
    });
  });

  it("visibleRecordIds() returns exactly the subset the port still resolves, batched, de-duplicated implicitly by the returned Set", async () => {
    await withWorkspace(async (opened) => {
      const records: readonly CanonicalQueryRecord[] = [
        record({ record_id: "rec-1", kind: "jsts:entity_callable", owner_artifact_id: "art-a", owner_artifact_version_id: "artv-a", body: { kind: "function", name: "one" } }),
        record({ record_id: "rec-2", kind: "jsts:entity_callable", owner_artifact_id: "art-a", owner_artifact_version_id: "artv-a", body: { kind: "function", name: "two" } }),
      ];
      const source = createNativeSemanticEntityRecordSource({ database: opened.database, port: fakePort(records), workspace_id: WORKSPACE_ID });
      const visible = await source.visibleRecordIds(["rec-1", "rec-gone", "rec-2"]);
      expect(visible).toEqual(new Set(["rec-1", "rec-2"]));
      expect(await source.visibleRecordIds([])).toEqual(new Set());
    });
  });
});
