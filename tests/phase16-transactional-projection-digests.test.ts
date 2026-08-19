import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeDigest, digestBytes, encodeCanonical } from "@urdira/canonical";
import { createDurableStorage, projectionSetDigestEntries } from "../packages/storage/src/index.js";
import type { EntityRecord, Workspace } from "@urdira/contracts";

// Regression coverage for docs/decisions/13-transactional-projection-digests.md
// (extended by docs/decisions/16-semantic-search-wiring.md for vector):
// `projectionSetDigestEntries` (packages/storage/src/lifecycle.ts) now covers
// only the transactional projection kinds (graph, dependency, metric)
// written inside the publish transaction; the two asynchronously maintained
// kinds -- "lexical" (lexical reconciler) and "vector" (semantic
// reconciler) -- are excluded, so a snapshot's stored `projection_set_digests`
// stays valid across post-publish lexical AND semantic reconciler rebuilds
// instead of going stale the moment either one runs.

const workspace: Workspace = {
  workspace_id: "ws-projection-digests",
  canonical_root: "/repositories/projection-digests",
  display_root: "/repositories/projection-digests",
  source_provider_bindings: [],
  status: "registered",
  registered_at: "2026-08-13T00:00:00.000000000Z",
};

async function withStorage(test: (storage: Awaited<ReturnType<typeof createDurableStorage>>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "urdira-phase16-projection-digests-"));
  const storage = await createDurableStorage({ rootDir: root, inlineThresholdBytes: 8 });
  try { await test(storage); } finally { await storage.close(); await rm(root, { recursive: true, force: true }); }
}

async function seedOwner(storage: Awaited<ReturnType<typeof createDurableStorage>>, opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, artifactId: string, versionId: string, text: string): Promise<void> {
  const sourceBytes = new TextEncoder().encode(text);
  const blob = await storage.cas.put(sourceBytes, { media_type: "text/plain; charset=utf-8" });
  const batchId = `batch-${versionId}`;
  const observationId = `observation-${versionId}`;
  await opened.repositories.sourceCatalog.putArtifact({ artifact_id: artifactId, workspace_id: workspace.workspace_id, normalized_uri: `file:///${workspace.workspace_id}/${artifactId}`, normalized_path: `/${artifactId}`, display_path: artifactId, artifact_kind: "file" });
  await opened.repositories.sourceCatalog.putContentBlob({ content_blob_id: `blob-${versionId}`, content_hash: blob.content_hash, byte_length: sourceBytes.byteLength, storage_reference: blob.storage_reference });
  await opened.repositories.sourceCatalog.putObservationBatch({ observation_batch_id: batchId, workspace_id: workspace.workspace_id, source_provider_binding_id: "provider-binding", source_provider: "test", source_provider_version: "1", ordering_domain: "test", observation_mode: "full", coverage_scopes: "all", coverage_completeness: "complete", deletion_authority: "test", provider_cursor_before: "", provider_cursor_after: "", started_at: "2026-08-13T00:00:00.000000000Z", completed_at: "2026-08-13T00:00:00.000000000Z", observation_count: 1, unavailable_count: 0, batch_digest: `test-digest-${batchId}` });
  await opened.repositories.sourceCatalog.putObservation({ source_observation_id: observationId, observation_batch_id: batchId, workspace_id: workspace.workspace_id, artifact_id: artifactId, source_provider_binding_id: "provider-binding", source_provider: "test", source_provider_version: "1", ordering_domain: "test", observation_mode: "full", observed_state: "present", observed_content_hash: blob.content_hash, observed_metadata_digest: `test-digest-metadata-${versionId}`, provider_event_token: `event-${versionId}`, provider_sequence: "1", observed_at: "2026-08-13T00:00:00.000000000Z", received_at: "2026-08-13T00:00:00.000000000Z" });
  await opened.repositories.sourceCatalog.putArtifactVersion({ artifact_version_id: versionId, workspace_id: workspace.workspace_id, artifact_id: artifactId, content_blob_id: `blob-${versionId}`, content_hash: blob.content_hash, byte_length: sourceBytes.byteLength, encoding: "utf-8", language_hint: "text", analysis_metadata_digest: `test-digest-analysis-${versionId}`, created_from_observation_id: observationId, valid_from_generation: 1 });
}

async function seedSnapshot(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, snapshotId: string, projectionSetDigests: string, generation = 1): Promise<void> {
  const registryId = `registry-${snapshotId}`;
  const registryDigest = computeDigest("core:registry_snapshot", "core:registry_snapshot_digest", 1, "core:RegistrySnapshotDigestPayload", 1, { registry_snapshot_id: registryId, registry_contract_version: "1", core_registry_digest: `core-${snapshotId}`, resolution_lock_id: `lock-${snapshotId}`, namespace_bindings: [] });
  await opened.database.run("INSERT OR IGNORE INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest, registry_payload) VALUES (?, ?, ?, ?, ?, ?, ?)", [registryId, workspace.workspace_id, "1", `core-${snapshotId}`, `lock-${snapshotId}`, registryDigest, encodeCanonical({ registry_snapshot_id: registryId, workspace_id: workspace.workspace_id, namespace_bindings: [] })]);
  const snapshot = { snapshot_id: snapshotId, workspace_id: workspace.workspace_id, generation, generation_manifest_id: `manifest-${snapshotId}`, registry_snapshot_id: registryId, resolution_lock_id: `lock-${snapshotId}`, configuration_revision_id: `config-${snapshotId}`, source_state_digest: `source-${snapshotId}`, source_observation_watermarks: "{}", canonical_record_set_digest: `records-${snapshotId}`, projection_set_digests: projectionSetDigests, capability_state_digest: `capabilities-${snapshotId}`, published_at: "2026-08-13T00:00:00.000000000Z", snapshot_digest: `snapshot-digest-${snapshotId}` };
  await opened.database.run("INSERT OR IGNORE INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest, snapshot_payload) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [snapshot.snapshot_id, snapshot.workspace_id, snapshot.generation, snapshot.generation_manifest_id, snapshot.registry_snapshot_id, snapshot.resolution_lock_id, snapshot.configuration_revision_id, snapshot.source_state_digest, snapshot.source_observation_watermarks, snapshot.canonical_record_set_digest, snapshot.projection_set_digests, snapshot.capability_state_digest, snapshot.published_at, snapshot.snapshot_digest, encodeCanonical(snapshot)]);
}

describe("Transactional projection digests (decision 13)", { timeout: 30_000 }, () => {
  it("computes exactly the three transactional projection kinds, excluding lexical and vector", async () => {
    await withStorage(async (storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await seedOwner(storage, opened, "kinds-artifact", "kinds-version", "some source text");
      await opened.projections.putGraphEdge({ edge_id: "kinds-edge", source_subject_id: "source", target_subject_id: "target", relation_record_id: "record", relation_kind: "calls", role: "callee", evidence_class: "confirmed", owner_artifact_id: "kinds-artifact", owner_artifact_version_id: "kinds-version", valid_from_generation: 1 });
      // Also write a lexical document and a vector -- if either leaked into
      // the digest computation, this test would catch a "lexical" or
      // "vector" entry reappearing.
      await opened.projections.putLexicalDocument({ artifact_id: "kinds-artifact", artifact_version_id: "kinds-version", text: "some source text", valid_from_generation: 1 });
      await opened.projections.putVector({ projection_record_id: "kinds-vector", owner_artifact_id: "kinds-artifact", owner_artifact_version_id: "kinds-version", profile_id: "profile", executable_binding_id: "binding", dimensions: 1, element_type: "float32", vector: new Uint8Array([0, 0, 128, 63]), valid_from_generation: 1 });

      const entries = await projectionSetDigestEntries(opened.database, workspace.workspace_id, 1);
      expect(entries.map((entry) => entry.projection_kind).sort()).toEqual(["dependency", "graph", "metric"]);
      expect(entries.some((entry) => entry.projection_kind === "lexical")).toBe(false);
      expect(entries.some((entry) => entry.projection_kind === "vector")).toBe(false);
      for (const entry of entries) {
        expect(entry.projection_set_digest.startsWith("sha256:")).toBe(true);
        expect(entry.generator_configuration_digest.startsWith("sha256:")).toBe(true);
      }
      await opened.close();
    });
  });

  it("keeps a published snapshot's projection-set digest valid across post-publish lexical and vector rebuilds", async () => {
    await withStorage(async (storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await seedOwner(storage, opened, "stable-artifact", "stable-version", "stable source text");
      await opened.projections.putGraphEdge({ edge_id: "stable-edge", source_subject_id: "source", target_subject_id: "target", relation_record_id: "record", relation_kind: "calls", role: "callee", evidence_class: "confirmed", owner_artifact_id: "stable-artifact", owner_artifact_version_id: "stable-version", valid_from_generation: 1 });

      // Compute and store the digest the way a real publish would --
      // BEFORE any lexical or vector row exists for this generation,
      // mirroring the real ordering (publish commits first; the lexical and
      // semantic reconcilers run only afterward, post-`ready`).
      const entries = await projectionSetDigestEntries(opened.database, workspace.workspace_id, 1);
      await seedSnapshot(opened, "stable-snapshot", JSON.stringify(entries));
      expect((await opened.maintenance.verify()).failures.filter((failure) => failure.component_id === "stable-snapshot" && failure.error_code === "storage:projection_set_digest_corrupt")).toEqual([]);

      // Simulate the post-`ready` lexical reconciler rewriting lexical rows,
      // and the post-`ready` semantic reconciler writing vector rows, both
      // for the same generation -- neither must retroactively invalidate the
      // already-published snapshot's projection-set digest.
      await opened.projections.putLexicalDocument({ artifact_id: "stable-artifact", artifact_version_id: "stable-version", text: "stable source text", valid_from_generation: 1 });
      await opened.projections.putVector({ projection_record_id: "stable-vector", owner_artifact_id: "stable-artifact", owner_artifact_version_id: "stable-version", profile_id: "profile", executable_binding_id: "binding", dimensions: 1, element_type: "float32", vector: new Uint8Array([0, 0, 128, 63]), valid_from_generation: 1 });

      const failures = (await opened.maintenance.verify()).failures.filter((failure) => failure.component_id === "stable-snapshot");
      expect(failures.filter((failure) => failure.error_code === "storage:projection_set_digest_corrupt")).toEqual([]);
      await opened.close();
    });
  });

  it("currentlyVisible attaches each record's newest visible identity assignment across generations, in record_id order", async () => {
    await withStorage(async (storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await seedOwner(storage, opened, "visible-artifact", "visible-version", "visible source text");

      const baseRecord: EntityRecord = {
        record_id: "record-a",
        category: "entity",
        kind: "core:definition",
        universal_kind: "core:definition",
        facets: [],
        schema_version: 1,
        workspace_id: workspace.workspace_id,
        owner_artifact_id: "visible-artifact",
        owner_artifact_version_id: "visible-version",
        valid_from_generation: 1,
        producer_id: "test",
        producer_version: "1.0.0",
        analysis_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        analysis_configuration_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        artifact_dependency_digest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        payload: { name: "main" },
        record_digest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      };
      // record-a: opens at generation 1 with an identity assignment that
      // closes at generation 2, then a second, still-open assignment opens
      // at generation 2 -- an "older closed" + "newer open" pair for the
      // same record, spanning generations.
      await opened.repositories.canonicalOccurrences.put(baseRecord);
      await opened.database.run(
        `INSERT INTO identity_assignments (identity_assignment_id, workspace_id, identity_type, identity_id, assignment_kind, identity_key, identity_key_digest, record_id, previous_record_id, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation, assignment_payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["assignment-a-old", workspace.workspace_id, "entity", "identity-a-old", "created", "key-a-old", "key-digest-a-old", "record-a", null, "visible-artifact", "visible-version", 1, 2, new Uint8Array([1])],
      );
      await opened.database.run(
        `INSERT INTO identity_assignments (identity_assignment_id, workspace_id, identity_type, identity_id, assignment_kind, identity_key, identity_key_digest, record_id, previous_record_id, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation, assignment_payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["assignment-a-new", workspace.workspace_id, "entity", "identity-a-new", "created", "key-a-new", "key-digest-a-new", "record-a", null, "visible-artifact", "visible-version", 2, null, new Uint8Array([1])],
      );
      // record-b: visible from generation 1, but never gets an identity
      // assignment -- must carry no identity fields at all.
      await opened.repositories.canonicalOccurrences.put({ ...baseRecord, record_id: "record-b", record_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });

      const atGenerationOne = await opened.repositories.canonicalOccurrences.currentlyVisible(1);
      expect(atGenerationOne.map((row) => row.record_id)).toEqual(["record-a", "record-b"]);
      const recordAAtOne = atGenerationOne.find((row) => row.record_id === "record-a")!;
      expect(recordAAtOne.identity_id).toBe("identity-a-old");
      expect(recordAAtOne.identity_key).toBe("key-a-old");
      const recordBAtOne = atGenerationOne.find((row) => row.record_id === "record-b")!;
      expect(recordBAtOne.identity_id).toBeUndefined();
      expect(recordBAtOne.identity_type).toBeUndefined();
      expect(recordBAtOne.identity_key).toBeUndefined();

      const atGenerationTwo = await opened.repositories.canonicalOccurrences.currentlyVisible(2);
      expect(atGenerationTwo.map((row) => row.record_id)).toEqual(["record-a", "record-b"]);
      const recordAAtTwo = atGenerationTwo.find((row) => row.record_id === "record-a")!;
      expect(recordAAtTwo.identity_id).toBe("identity-a-new");
      expect(recordAAtTwo.identity_key).toBe("key-a-new");

      await opened.close();
    });
  });
});

// Regression coverage for the `publish_projection_digests` perf change: a
// per-row `content_digest` column, populated at write time, lets the publish
// and fork-plan paths ask for `projectionSetDigestEntries(..., { digest_source:
// "stored" })` instead of re-hashing every transactional projection payload
// BLOB on every publish. The whole point is that "stored" and "recompute"
// are two ways of computing the exact same values -- these tests assert
// that equivalence directly, rather than just trusting the implementation.
describe("Stored projection content_digest (publish_projection_digests perf)", { timeout: 30_000 }, () => {
  it("computes byte-identical entries in stored and recompute mode across all three transactional kinds", async () => {
    await withStorage(async (storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await seedOwner(storage, opened, "digest-artifact", "digest-version", "digest source text");
      await opened.projections.putGraphEdge({ edge_id: "digest-edge", source_subject_id: "source", target_subject_id: "target", relation_record_id: "record", relation_kind: "calls", role: "callee", evidence_class: "confirmed", owner_artifact_id: "digest-artifact", owner_artifact_version_id: "digest-version", valid_from_generation: 1 });
      await opened.projections.putDependency({ dependency_entry_id: "digest-dependency", record_id: "record", owner_artifact_id: "digest-artifact", owner_artifact_version_id: "digest-version", dependency_artifact_id: "digest-artifact", dependency_artifact_version_id: "digest-version", dependency_role: "runtime", producer_id: "producer", producer_version: "1", valid_from_generation: 1 });
      await opened.projections.putMetric({ metric_id: "digest-metric", projection_record_id: "record", metric_kind: "fan_out", metric_value: 3, owner_artifact_id: "digest-artifact", owner_artifact_version_id: "digest-version", valid_from_generation: 1 });

      const stored = await projectionSetDigestEntries(opened.database, workspace.workspace_id, 1, { digest_source: "stored" });
      const recompute = await projectionSetDigestEntries(opened.database, workspace.workspace_id, 1, { digest_source: "recompute" });
      expect(stored).toEqual(recompute);
      expect(JSON.stringify(stored)).toBe(JSON.stringify(recompute));
      expect(stored.map((entry) => entry.projection_kind).sort()).toEqual(["dependency", "graph", "metric"]);

      // The "stored" read path exists specifically so this query never
      // touches a payload page -- confirm the planner actually answers it
      // from the covering index, not a table (or even index) scan that
      // still visits the base table for the payload column.
      const plan = await opened.database.all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT dependency_entry_id, valid_from_generation, content_digest FROM artifact_dependencies WHERE workspace_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)", [workspace.workspace_id, 1, 1]);
      const planText = plan.map((row) => row.detail).join(" ");
      expect(planText).toContain("artifact_dependencies_digest_scan_idx");
      expect(planText.toUpperCase()).toContain("COVERING INDEX");

      await opened.close();
    });
  });

  it("verify() passes after a stored-mode publish, catches a corrupted stored content_digest, and stored mode still matches recompute after a NULL fallback", async () => {
    await withStorage(async (storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await seedOwner(storage, opened, "corrupt-artifact", "corrupt-version", "corrupt source text");
      await opened.projections.putGraphEdge({ edge_id: "corrupt-edge", source_subject_id: "source", target_subject_id: "target", relation_record_id: "record", relation_kind: "calls", role: "callee", evidence_class: "confirmed", owner_artifact_id: "corrupt-artifact", owner_artifact_version_id: "corrupt-version", valid_from_generation: 1 });

      // Mirrors the real publish path: compute with { digest_source: "stored" }
      // and store exactly that array as the snapshot's projection_set_digests.
      const publishedEntries = await projectionSetDigestEntries(opened.database, workspace.workspace_id, 1, { digest_source: "stored" });
      await seedSnapshot(opened, "corrupt-snapshot", JSON.stringify(publishedEntries));
      const healthy = (await opened.maintenance.verify()).failures.filter((failure) => failure.component_id === "corrupt-snapshot");
      expect(healthy).toEqual([]);

      // Corrupt the persisted content_digest column directly (not the
      // payload) -- verify() always recomputes, so this must be caught as a
      // digest-column corruption distinct from payload corruption.
      const wrongDigest = `sha256:${"0".repeat(64)}`;
      await opened.database.run("UPDATE graph_edges SET content_digest = ? WHERE workspace_id = ? AND edge_id = ?", [wrongDigest, workspace.workspace_id, "corrupt-edge"]);
      const corrupted = (await opened.maintenance.verify()).failures.filter((failure) => failure.component_id === "corrupt-snapshot");
      expect(corrupted.map((failure) => failure.error_code)).toContain("storage:projection_content_digest_corrupt");

      // NULL-ing the stored column (rather than corrupting it) is not
      // corruption -- it is exactly the not-yet-backfilled state the
      // "stored" read path is defined to fall back on -- so both modes must
      // still agree.
      await opened.database.run("UPDATE graph_edges SET content_digest = NULL WHERE workspace_id = ? AND edge_id = ?", [workspace.workspace_id, "corrupt-edge"]);
      const storedAfterNull = await projectionSetDigestEntries(opened.database, workspace.workspace_id, 1, { digest_source: "stored" });
      const recomputeAfterNull = await projectionSetDigestEntries(opened.database, workspace.workspace_id, 1, { digest_source: "recompute" });
      expect(storedAfterNull).toEqual(recomputeAfterNull);

      await opened.close();
    });
  });

  it("re-adds and backfills content_digest for a database migrated from before this column existed", async () => {
    await withStorage(async (storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await seedOwner(storage, opened, "migration-artifact", "migration-version", "migration source text");
      await opened.projections.putGraphEdge({ edge_id: "migration-edge", source_subject_id: "source", target_subject_id: "target", relation_record_id: "record", relation_kind: "calls", role: "callee", evidence_class: "confirmed", owner_artifact_id: "migration-artifact", owner_artifact_version_id: "migration-version", valid_from_generation: 1 });

      // Simulate a database created before this change: no digest-scan index
      // (it references the column) and no content_digest column at all --
      // only the payload BLOB survives, exactly like a real pre-migration
      // database opened for the first time after this change ships.
      await opened.database.exec("DROP INDEX IF EXISTS graph_edges_digest_scan_idx");
      await opened.database.exec("ALTER TABLE graph_edges DROP COLUMN content_digest");
      const beforeMigration = await opened.database.get<Record<string, unknown>>("SELECT * FROM graph_edges WHERE workspace_id = ? AND edge_id = ?", [workspace.workspace_id, "migration-edge"]);
      expect(beforeMigration && "content_digest" in beforeMigration).toBe(false);
      await opened.close();

      // Reopening runs `ensureWorkspaceSchemaCompatibility`
      // (`packages/storage/src/schema.ts`), which re-adds the column via
      // `ALTER TABLE ... ADD COLUMN`, backfills every NULL row from its
      // still-present payload BLOB, and recreates the covering index --
      // idempotent and re-runnable by construction (it only ever selects
      // rows still NULL), so it is safe to run on every open, migrated
      // database or not.
      const reopened = await storage.openWorkspace(workspace.workspace_id);
      const migratedRow = await reopened.database.get<{ content_digest: string; edge_payload: Uint8Array }>("SELECT content_digest, edge_payload FROM graph_edges WHERE workspace_id = ? AND edge_id = ?", [workspace.workspace_id, "migration-edge"]);
      expect(migratedRow?.content_digest).toBe(digestBytes(new Uint8Array(migratedRow!.edge_payload)));

      const stored = await projectionSetDigestEntries(reopened.database, workspace.workspace_id, 1, { digest_source: "stored" });
      const recompute = await projectionSetDigestEntries(reopened.database, workspace.workspace_id, 1, { digest_source: "recompute" });
      expect(stored).toEqual(recompute);

      // Reopening again must find nothing left to backfill (idempotent) and
      // must not fail re-creating the already-present index.
      await reopened.close();
      const reopenedAgain = await storage.openWorkspace(workspace.workspace_id);
      await reopenedAgain.close();
    });
  });
});
