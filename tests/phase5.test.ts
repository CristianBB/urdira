import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeDigest, encodeCanonical } from "@urdira/canonical";
import { createDurableStorage, createFaultInjector, WorkspaceLifecycleRepository } from "../packages/storage/src/index.js";

async function withStorage(test: (root: string, storage: Awaited<ReturnType<typeof createDurableStorage>>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "urdira-phase5-test-"));
  const storage = await createDurableStorage({ rootDir: root, inlineThresholdBytes: 8 });
  try {
    await test(root, storage);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}

const workspace = {
  workspace_id: "ws-phase5",
  canonical_root: "/phase5",
  display_root: "/phase5",
  source_provider_bindings: [],
  status: "registered",
  registered_at: "2026-08-09T00:00:00.000000000Z",
};
const testDigest = (value: string): string => `test-digest-${value}`;

async function seedSnapshot(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, snapshotId: string): Promise<void> {
  const registryId = `registry-${snapshotId}`;
  const registryDigest = computeDigest("core:registry_snapshot", "core:registry_snapshot_digest", 1, "core:RegistrySnapshotDigestPayload", 1, { registry_snapshot_id: registryId, registry_contract_version: "1", core_registry_digest: `core-${snapshotId}`, resolution_lock_id: `lock-${snapshotId}`, namespace_bindings: [] });
  await opened.database.run("INSERT OR IGNORE INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest, registry_payload) VALUES (?, ?, ?, ?, ?, ?, ?)", [registryId, workspace.workspace_id, "1", `core-${snapshotId}`, `lock-${snapshotId}`, registryDigest, encodeCanonical({ registry_snapshot_id: registryId, workspace_id: workspace.workspace_id, namespace_bindings: [] })]);
  const snapshot = { snapshot_id: snapshotId, workspace_id: workspace.workspace_id, generation: 1, generation_manifest_id: `manifest-${snapshotId}`, registry_snapshot_id: registryId, resolution_lock_id: `lock-${snapshotId}`, configuration_revision_id: `config-${snapshotId}`, source_state_digest: `source-${snapshotId}`, source_observation_watermarks: "{}", canonical_record_set_digest: `records-${snapshotId}`, projection_set_digests: "{}", capability_state_digest: `capabilities-${snapshotId}`, published_at: "2026-08-09T00:00:00.000000000Z", snapshot_digest: `snapshot-digest-${snapshotId}` };
  await opened.database.run("INSERT OR IGNORE INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest, snapshot_payload) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [snapshot.snapshot_id, snapshot.workspace_id, snapshot.generation, snapshot.generation_manifest_id, snapshot.registry_snapshot_id, snapshot.resolution_lock_id, snapshot.configuration_revision_id, snapshot.source_state_digest, snapshot.source_observation_watermarks, snapshot.canonical_record_set_digest, snapshot.projection_set_digests, snapshot.capability_state_digest, snapshot.published_at, snapshot.snapshot_digest, encodeCanonical(snapshot)]);
}

async function seedOwner(storage: Awaited<ReturnType<typeof createDurableStorage>>, opened: Awaited<ReturnType<typeof storage.openWorkspace>>, artifactId: string, versionId: string, text: string): Promise<void> {
  const sourceBytes = new TextEncoder().encode(text);
  const blob = await storage.cas.put(sourceBytes, { media_type: "text/plain; charset=utf-8" });
  const batchId = `batch-${versionId}`;
  const observationId = `observation-${versionId}`;
  await opened.repositories.sourceCatalog.putArtifact({ artifact_id: artifactId, workspace_id: workspace.workspace_id, normalized_uri: `file:///${artifactId}`, normalized_path: `/${artifactId}`, display_path: artifactId, artifact_kind: "file" });
  await opened.repositories.sourceCatalog.putContentBlob({ content_blob_id: `blob-${versionId}`, content_hash: blob.content_hash, byte_length: sourceBytes.byteLength, storage_reference: blob.storage_reference });
  await opened.repositories.sourceCatalog.putObservationBatch({ observation_batch_id: batchId, workspace_id: workspace.workspace_id, source_provider_binding_id: "provider-binding", source_provider: "test", source_provider_version: "1", ordering_domain: "test", observation_mode: "full", coverage_scopes: "all", coverage_completeness: "complete", deletion_authority: "test", provider_cursor_before: "", provider_cursor_after: "", started_at: "2026-08-09T00:00:00.000000000Z", completed_at: "2026-08-09T00:00:00.000000Z", observation_count: 1, unavailable_count: 0, batch_digest: testDigest(batchId) });
  await opened.repositories.sourceCatalog.putObservation({ source_observation_id: observationId, observation_batch_id: batchId, workspace_id: workspace.workspace_id, artifact_id: artifactId, source_provider_binding_id: "provider-binding", source_provider: "test", source_provider_version: "1", ordering_domain: "test", observation_mode: "full", observed_state: "present", observed_content_hash: blob.content_hash, observed_metadata_digest: testDigest(`metadata-${versionId}`), provider_event_token: `event-${versionId}`, provider_sequence: "1", observed_at: "2026-08-09T00:00:00.000000000Z", received_at: "2026-08-09T00:00:00.000000000Z" });
  await opened.repositories.sourceCatalog.putArtifactVersion({ artifact_version_id: versionId, workspace_id: workspace.workspace_id, artifact_id: artifactId, content_blob_id: `blob-${versionId}`, content_hash: blob.content_hash, byte_length: sourceBytes.byteLength, encoding: "utf-8", language_hint: "text", analysis_metadata_digest: testDigest(`analysis-${versionId}`), created_from_observation_id: observationId, valid_from_generation: 1 });
}

describe("Phase 5 projections and lifecycle", () => {
  it("stores deterministic graph, lexical, dependency, metric, and exact vector projections", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await seedSnapshot(opened, "snapshot-1");
      await seedOwner(storage, opened, "artifact-a", "version-a", "alpha beta");
      await seedOwner(storage, opened, "artifact-b", "version-b", "beta");
      await opened.projections.putGraphEdge({
        edge_id: "edge-1", source_subject_id: "subject-a", target_subject_id: "subject-b", relation_record_id: "relation-1",
        relation_kind: "calls", role: "callee", evidence_class: "confirmed", owner_artifact_id: "artifact-a", owner_artifact_version_id: "version-a",
        valid_from_generation: 1,
      });
      await opened.projections.putLexicalDocument({ artifact_id: "artifact-a", artifact_version_id: "version-a", text: "alpha beta" });
      await opened.projections.putDependency({
        dependency_entry_id: "dependency-1", record_id: "record-1", owner_artifact_id: "artifact-a", owner_artifact_version_id: "version-a",
        dependency_artifact_id: "artifact-b", dependency_artifact_version_id: "version-b", dependency_role: "imports", producer_id: "core", producer_version: "1",
        valid_from_generation: 1,
      });
      await opened.projections.putMetric({ metric_id: "metric-1", projection_record_id: "record-1", metric_kind: "fan_out", metric_value: 2, owner_artifact_id: "artifact-a", owner_artifact_version_id: "version-a", valid_from_generation: 1 });
      const vector = new Uint8Array([0, 0, 128, 63, 0, 0, 0, 64]);
      await opened.projections.putVector({ projection_record_id: "vector-1", owner_artifact_id: "artifact-a", owner_artifact_version_id: "version-a", profile_id: "profile-1", executable_binding_id: "binding-1", dimensions: 2, element_type: "float32", vector });

      expect(await opened.projections.neighbors("subject-a", "outbound")).toEqual([expect.objectContaining({ edge_id: "edge-1", target_subject_id: "subject-b" })]);
      expect(await opened.projections.searchLiteral("alpha")).toEqual([expect.objectContaining({ artifact_id: "artifact-a" })]);
      expect(await opened.projections.dependents("artifact-b", "version-b")).toEqual([expect.objectContaining({ dependency_entry_id: "dependency-1" })]);
      expect(await opened.projections.getMetric("metric-1")).toEqual(expect.objectContaining({ metric_value: 2 }));
      expect(await opened.projections.readVector("vector-1")).toEqual(vector);
      await opened.close();
    });
  });

  it("keeps leases and pins as independent retention roots and expires query manifests atomically", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await seedSnapshot(opened, "snapshot-1");
      const lease = await opened.lifecycle.acquireLease({ retention_lease_id: "lease-1", snapshot_id: "snapshot-1", holder_type: "query", holder_id: "execution-1", now: "2026-08-09T00:00:00.000000000Z", idle_expires_at: "2026-08-09T00:01:00.000000000Z", absolute_expires_at: "2026-08-09T00:02:00.000000000Z" });
      await opened.lifecycle.pinSnapshot({ retention_pin_id: "pin-1", snapshot_id: "snapshot-1", pin_kind: "manual", reason_code: "test", source_reference: { artifact_id: "artifact-a", artifact_version_id: "version-a" }, created_at: "2026-08-09T00:00:00.000000000Z", expires_at: "2026-08-09T00:03:00.000000000Z" });
      await opened.lifecycle.createExecution({ query_execution_id: "execution-1", workspace_snapshot_ids: ["snapshot-1"], retention_lease_ids: [lease.retention_lease_id], created_at: "2026-08-09T00:00:00.000000000Z", expires_at: "2026-08-09T00:01:00.000000000Z" });
      await opened.lifecycle.appendManifestSegment("execution-1", "segment-1", [{ ordinal: 0, result: "record-1" }]);
      expect(await opened.lifecycle.hydrateManifest("execution-1", 0, 10, "2026-08-09T00:00:30.000000000Z")).toEqual([{ ordinal: 0, result: "record-1" }]);
      expect(lease.retention_lease_id).toBe("lease-1");
      expect(await opened.lifecycle.expireExecutions("2026-08-09T00:01:01.000000000Z")).toEqual(["execution-1"]);
      await expect(opened.lifecycle.hydrateManifest("execution-1", 0, 10)).rejects.toMatchObject({ code: "storage:execution_expired" });
      expect(await opened.lifecycle.getLease("lease-1")).toMatchObject({ released_at: "2026-08-09T00:01:01.000000000Z", release_reason: "execution_expired" });
      expect(await opened.lifecycle.getPin("pin-1")).toBeDefined();
      await opened.close();
    });
  });

  it("verifies, backs up, restores, and resumes collection without deleting pinned content", async () => {
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await seedSnapshot(opened, "snapshot-1");
      const blob = await storage.cas.put(new TextEncoder().encode("reachable"));
      await opened.lifecycle.pinCasObject(blob.content_hash);
      const backup = join(root, "backup");
      await opened.maintenance.createBackup(backup);
      expect((await opened.maintenance.verify()).ok).toBe(true);
      const restored = join(root, "restored");
      await opened.maintenance.restoreBackup(backup, restored);
      expect(new Uint8Array(await readFile(join(restored, "cas", "sha256", blob.content_hash.slice(7, 9), blob.content_hash.slice(9, 11), blob.content_hash.slice(11))))).toEqual(new TextEncoder().encode("reachable"));
      const first = await opened.maintenance.collect({ now: "2026-08-09T00:00:00.000000000Z", batch_size: 1 });
      const second = await opened.maintenance.collect({ now: "2026-08-09T00:00:00.000000000Z", batch_size: 1, epoch_id: first.epoch_id });
      expect(second.epoch_id).toBe(first.epoch_id);
      expect(second.deleted_hashes).not.toContain(blob.content_hash);
      await opened.close();
    });
  });

  it("makes migration and manifest publication faults recoverable and idempotent", async () => {
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await seedSnapshot(opened, "snapshot-1");
      const faultLease = await opened.lifecycle.acquireLease({ retention_lease_id: "fault-lease", snapshot_id: "snapshot-1", holder_type: "query", holder_id: "execution-fault", now: "2026-08-09T00:00:00.000000000Z", idle_expires_at: "2026-08-10T00:00:00.000000000Z", absolute_expires_at: "2026-08-11T00:00:00.000000000Z" });
      await expect(opened.lifecycle.createExecution({ query_execution_id: "execution-fault", workspace_snapshot_ids: ["snapshot-1"], retention_lease_ids: [faultLease.retention_lease_id], created_at: "2026-08-09T00:00:00.000000000Z", expires_at: "2026-08-09T00:01:00.000000000Z" })).resolves.toBeUndefined();
      const beforeManifestFaults = createFaultInjector(["manifest.before_append"]);
      const beforeFaultedLifecycle = new WorkspaceLifecycleRepository(opened.database, workspace.workspace_id, beforeManifestFaults, storage.blobs, root);
      await expect(beforeFaultedLifecycle.appendManifestSegment("execution-fault", "segment-1", [{ ordinal: 0 }])).rejects.toMatchObject({ code: "storage:fault_injected" });
      const afterManifestFaults = createFaultInjector(["manifest.after_append"]);
      const afterFaultedLifecycle = new WorkspaceLifecycleRepository(opened.database, workspace.workspace_id, afterManifestFaults, storage.blobs, root);
      await expect(afterFaultedLifecycle.appendManifestSegment("execution-fault", "segment-1", [{ ordinal: 0 }])).rejects.toMatchObject({ code: "storage:fault_injected" });
      await expect(opened.lifecycle.appendManifestSegment("execution-fault", "segment-1", [{ ordinal: 0 }])).resolves.toBeUndefined();
      await expect(opened.maintenance.migrate(2)).resolves.toBeUndefined();
      await expect(opened.maintenance.migrate(2)).resolves.toBeUndefined();
      const migration = await opened.database.get<{ backup_path: string }>("SELECT backup_path FROM storage_migrations WHERE state = 'completed' ORDER BY started_at DESC LIMIT 1");
      expect(migration).toBeDefined();
      expect(await readFile(join(migration?.backup_path ?? "", "manifest.json"), "utf8")).toContain("workspace_id");
      await opened.close();
    });
  });

  it("localizes corrupt vector shards and preserves idempotent collection epochs", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await seedOwner(storage, opened, "artifact-a", "version-a", "vector-owner");
      await opened.projections.putVector({ projection_record_id: "vector-corrupt", owner_artifact_id: "artifact-a", owner_artifact_version_id: "version-a", profile_id: "profile-1", executable_binding_id: "binding-1", dimensions: 1, element_type: "float32", vector: new Uint8Array([0, 0, 128, 63]) });
      const shard = await opened.database.get<{ content_hash: string }>("SELECT content_hash FROM vector_shards WHERE shard_id = (SELECT shard_id FROM vector_projection_rows WHERE projection_record_id = ?)", ["vector-corrupt"]);
      if (!shard) throw new Error("test vector shard was not created");
      const shardPath = storage.cas.objectPath(shard.content_hash);
      const original = await readFile(shardPath);
      await opened.database.run("UPDATE vector_projection_rows SET vector_digest = ? WHERE projection_record_id = ?", ["sha256:0000000000000000000000000000000000000000000000000000000000000000", "vector-corrupt"]);
      const report = await opened.maintenance.verify();
      expect(report.ok).toBe(false);
      expect(report.failures).toEqual(expect.arrayContaining([expect.objectContaining({ component_kind: "vector", component_id: "vector-corrupt" })]));
      await opened.database.run("UPDATE vector_projection_rows SET vector_digest = ? WHERE projection_record_id = ?", ["sha256:42a0d6a2f3d6c4a5f3f9a3d8f9f5e5c4d0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0", "vector-corrupt"]);
      await expect(opened.maintenance.collect({ now: "2026-08-09T00:00:00.000000000Z", batch_size: 1, epoch_id: "epoch-resume" })).resolves.toMatchObject({ epoch_id: "epoch-resume" });
      await expect(opened.maintenance.collect({ now: "2026-08-09T00:00:00.000000000Z", batch_size: 1, epoch_id: "epoch-resume" })).resolves.toMatchObject({ epoch_id: "epoch-resume" });
      expect(await readFile(shardPath)).toEqual(original);
      await opened.close();
    });
  });

  it("rolls back a publication when a durable publication boundary faults", async () => {
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      await storage.close();
      const faultedStorage = await createDurableStorage({ rootDir: root, fault_injector: createFaultInjector(["publication.before_current_update"]) });
      const opened = await faultedStorage.openWorkspace(workspace.workspace_id);
      await expect(opened.publish({ snapshot: { snapshot_id: "snapshot-fault", workspace_id: workspace.workspace_id, generation: 1, generation_manifest_id: "manifest", registry_snapshot_id: "registry", resolution_lock_id: "lock", configuration_revision_id: "configuration", source_state_digest: "source", source_observation_watermarks: "watermarks", canonical_record_set_digest: "records", projection_set_digests: "projections", capability_state_digest: "capability", published_at: "2026-08-09T00:00:00.000000000Z", snapshot_digest: "digest" }, current_state: {} as never })).rejects.toMatchObject({ code: "storage:fault_injected" });
      expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM snapshots"))?.count).toBe(0);
      await opened.close();
      await faultedStorage.close();
    });
  });
});
