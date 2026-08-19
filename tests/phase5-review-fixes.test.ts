import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { computeDigest, decodeCanonical, digestBytes, encodeCanonical } from "@urdira/canonical";
import type { ModelPackInstallation } from "@urdira/contracts";
import { createDurableStorage, createFaultInjector, MIGRATION_TABLE_ADAPTERS, openSqliteDatabase, StorageMaintenance, WorkspaceLifecycleRepository } from "../packages/storage/src/index.js";
import { lexicalTrigrams } from "../packages/storage/src/projections.js";

const workspaceA = {
  workspace_id: "ws-review-a", canonical_root: "/review/a", display_root: "/review/a", source_provider_bindings: [], status: "registered", registered_at: "2026-08-09T00:00:00.000000000Z",
};
const workspaceB = {
  workspace_id: "ws-review-b", canonical_root: "/review/b", display_root: "/review/b", source_provider_bindings: [], status: "registered", registered_at: "2026-08-09T00:00:00.000000000Z",
};
const testDigest = (value: string): string => `test-digest-${value}`;

async function seedSnapshot(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, workspaceId: string, snapshotId: string, generation = 1): Promise<void> {
  const registryId = `registry-${snapshotId}`;
  const registryDigest = computeDigest("core:registry_snapshot", "core:registry_snapshot_digest", 1, "core:RegistrySnapshotDigestPayload", 1, { registry_snapshot_id: registryId, registry_contract_version: "1", core_registry_digest: `core-${snapshotId}`, resolution_lock_id: `lock-${snapshotId}`, namespace_bindings: [] });
  await opened.database.run("INSERT OR IGNORE INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest, registry_payload) VALUES (?, ?, ?, ?, ?, ?, ?)", [registryId, workspaceId, "1", `core-${snapshotId}`, `lock-${snapshotId}`, registryDigest, encodeCanonical({ registry_snapshot_id: registryId, workspace_id: workspaceId, namespace_bindings: [] })]);
  const snapshot = { snapshot_id: snapshotId, workspace_id: workspaceId, generation, generation_manifest_id: `manifest-${snapshotId}`, registry_snapshot_id: registryId, resolution_lock_id: `lock-${snapshotId}`, configuration_revision_id: `config-${snapshotId}`, source_state_digest: `source-${snapshotId}`, source_observation_watermarks: "{}", canonical_record_set_digest: `records-${snapshotId}`, projection_set_digests: "{}", capability_state_digest: `capabilities-${snapshotId}`, published_at: "2026-08-09T00:00:00.000000000Z", snapshot_digest: `snapshot-digest-${snapshotId}` };
  await opened.database.run("INSERT OR IGNORE INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest, snapshot_payload) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [snapshot.snapshot_id, snapshot.workspace_id, snapshot.generation, snapshot.generation_manifest_id, snapshot.registry_snapshot_id, snapshot.resolution_lock_id, snapshot.configuration_revision_id, snapshot.source_state_digest, snapshot.source_observation_watermarks, snapshot.canonical_record_set_digest, snapshot.projection_set_digests, snapshot.capability_state_digest, snapshot.published_at, snapshot.snapshot_digest, encodeCanonical(snapshot)]);
}

async function withStorage(test: (root: string, storage: Awaited<ReturnType<typeof createDurableStorage>>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "urdira-phase5-review-"));
  const storage = await createDurableStorage({ rootDir: root, inlineThresholdBytes: 8 });
  try { await test(root, storage); } finally { await storage.close(); await rm(root, { recursive: true, force: true }); }
}

async function seedOwner(storage: Awaited<ReturnType<typeof createDurableStorage>>, opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, workspaceId: string, artifactId: string, versionId: string, text: string, generation = 1): Promise<void> {
  const sourceBytes = new TextEncoder().encode(text);
  const blob = await storage.cas.put(sourceBytes, { media_type: "text/plain; charset=utf-8" });
  const batchId = `batch-${workspaceId}-${versionId}`;
  const observationId = `observation-${workspaceId}-${versionId}`;
  await opened.repositories.sourceCatalog.putArtifact({ artifact_id: artifactId, workspace_id: workspaceId, normalized_uri: `file:///${workspaceId}/${artifactId}`, normalized_path: `/${artifactId}`, display_path: artifactId, artifact_kind: "file" });
  await opened.repositories.sourceCatalog.putContentBlob({ content_blob_id: `blob-${workspaceId}-${versionId}`, content_hash: blob.content_hash, byte_length: sourceBytes.byteLength, storage_reference: blob.storage_reference });
  await opened.repositories.sourceCatalog.putObservationBatch({ observation_batch_id: batchId, workspace_id: workspaceId, source_provider_binding_id: "provider-binding", source_provider: "test", source_provider_version: "1", ordering_domain: "test", observation_mode: "full", coverage_scopes: "all", coverage_completeness: "complete", deletion_authority: "test", provider_cursor_before: "", provider_cursor_after: "", started_at: "2026-08-09T00:00:00.000000000Z", completed_at: "2026-08-09T00:00:00.000000000Z", observation_count: 1, unavailable_count: 0, batch_digest: testDigest(batchId) });
  await opened.repositories.sourceCatalog.putObservation({ source_observation_id: observationId, observation_batch_id: batchId, workspace_id: workspaceId, artifact_id: artifactId, source_provider_binding_id: "provider-binding", source_provider: "test", source_provider_version: "1", ordering_domain: "test", observation_mode: "full", observed_state: "present", observed_content_hash: blob.content_hash, observed_metadata_digest: testDigest(`metadata-${versionId}`), provider_event_token: `event-${versionId}`, provider_sequence: "1", observed_at: "2026-08-09T00:00:00.000000000Z", received_at: "2026-08-09T00:00:00.000000000Z" });
  await opened.repositories.sourceCatalog.putArtifactVersion({ artifact_version_id: versionId, workspace_id: workspaceId, artifact_id: artifactId, content_blob_id: `blob-${workspaceId}-${versionId}`, content_hash: blob.content_hash, byte_length: sourceBytes.byteLength, encoding: "utf-8", language_hint: "text", analysis_metadata_digest: testDigest(`analysis-${versionId}`), created_from_observation_id: observationId, valid_from_generation: generation });
}

describe("Phase 5 independent-review regressions", { timeout: 30_000 }, () => {
  it("enforces snapshot existence and one valid lease per execution binding", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await expect(opened.lifecycle.acquireLease({ retention_lease_id: "missing-lease", snapshot_id: "missing-snapshot", holder_type: "query", holder_id: "query", now: "2026-08-09T00:00:00.000000000Z", idle_expires_at: "2026-08-09T00:10:00.000000000Z", absolute_expires_at: "2026-08-09T00:20:00.000000000Z" })).rejects.toMatchObject({ code: "storage:snapshot_not_found" });
      await expect(opened.lifecycle.pinSnapshot({ retention_pin_id: "missing-pin", snapshot_id: "missing-snapshot", pin_kind: "manual", reason_code: "test", source_reference: { artifact_id: "missing", artifact_version_id: "missing" }, created_at: "2026-08-09T00:00:00.000000000Z", expires_at: "2026-08-09T00:10:00.000000000Z" })).rejects.toMatchObject({ code: "storage:snapshot_not_found" });
      await seedSnapshot(opened, workspaceA.workspace_id, "bound-snapshot");
      const lease = await opened.lifecycle.acquireLease({ retention_lease_id: "bound-lease", snapshot_id: "bound-snapshot", holder_type: "query", holder_id: "bound-execution", now: "2026-08-09T00:00:00.000000000Z", idle_expires_at: "2026-08-09T00:10:00.000000000Z", absolute_expires_at: "2026-08-09T00:20:00.000000000Z" });
      await expect(opened.lifecycle.createExecution({ query_execution_id: "unleased-execution", workspace_snapshot_ids: ["bound-snapshot"], created_at: "2026-08-09T00:00:00.000000000Z", expires_at: "2026-08-09T00:05:00.000000000Z" })).rejects.toMatchObject({ code: "storage:execution_lease_mismatch" });
      await expect(opened.lifecycle.createExecution({ query_execution_id: "wrong-lease-execution", workspace_snapshot_ids: ["bound-snapshot"], retention_lease_ids: ["missing-lease"], created_at: "2026-08-09T00:00:00.000000000Z", expires_at: "2026-08-09T00:05:00.000000000Z" })).rejects.toMatchObject({ code: "storage:execution_lease_mismatch" });
      await expect(opened.lifecycle.createExecution({ query_execution_id: "bound-execution", workspace_snapshot_ids: ["bound-snapshot"], retention_lease_ids: [lease.retention_lease_id], created_at: "2026-08-09T00:00:00.000000000Z", expires_at: "2026-08-09T00:05:00.000000000Z" })).resolves.toBeUndefined();
      await expect(opened.lifecycle.createExecution({ query_execution_id: "bound-execution", workspace_snapshot_ids: ["bound-snapshot"], retention_lease_ids: [lease.retention_lease_id], created_at: "2026-08-09T00:00:00.000000000Z", expires_at: "2026-08-09T00:05:00.000000000Z" })).resolves.toBeUndefined();
      await opened.close();
    });
  });

  it("indexes UTF-8 byte trigrams for Unicode documents", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedOwner(storage, opened, workspaceA.workspace_id, "unicode-artifact", "unicode-version", "a😀b");
      await opened.projections.putLexicalDocument({ artifact_id: "unicode-artifact", artifact_version_id: "unicode-version", text: "a😀b", valid_from_generation: 1 });
      const rows = await opened.database.all<{ trigram: string }>("SELECT trigram FROM lexical_trigrams WHERE artifact_id = ? ORDER BY trigram", ["unicode-artifact"]);
      expect(rows.map((row) => row.trigram)).toEqual(["61f09f", "988062", "9f9880", "f09f98"]);
      expect(await opened.projections.searchLiteral("😀b")).toEqual([expect.objectContaining({ artifact_id: "unicode-artifact" })]);
      await opened.close();
    });
  });

  it("derives trigrams from NFKC-normalized UTF-8 bytes, composing combining characters", () => {
    // "e" + combining acute accent (U+0301) canonically composes to "\u00e9"
    // (U+00E9) under NFKC, so the normalized 2-character string "\u00e9x" yields a
    // single 3-byte trigram, not the two trigrams the raw "e"+combining-mark
    // byte sequence ("65 cc 81 78") would produce.
    expect(lexicalTrigrams("e\u0301x")).toEqual(["c3a978"]);
  });

  it("finds mixed-case matches via the normalized trigram prefilter in both case modes", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      // "Needle" only ever appears mixed-case in the document; the trigram
      // prefilter for a case-insensitive search must still be built from
      // normalizedTerm(pattern) ("needle"'s trigrams) to find it, and a
      // case-sensitive search for the exact mixed-case spelling must also
      // narrow via that same normalized prefilter (superset property) before
      // its exact-byte verification pass runs.
      await seedOwner(storage, opened, workspaceA.workspace_id, "mixed-case-artifact", "mixed-case-version", "a Needle in the haystack");
      await opened.projections.putLexicalDocument({ artifact_id: "mixed-case-artifact", artifact_version_id: "mixed-case-version", text: "a Needle in the haystack", valid_from_generation: 1 });
      expect(await opened.projections.searchLiteral("needle")).toEqual([expect.objectContaining({ artifact_id: "mixed-case-artifact" })]);
      expect(await opened.projections.searchLiteral("NEEDLE")).toEqual([expect.objectContaining({ artifact_id: "mixed-case-artifact" })]);
      expect(await opened.projections.searchLiteral("Needle", { case_sensitive: true })).toEqual([expect.objectContaining({ artifact_id: "mixed-case-artifact" })]);
      // A differently-cased exact pattern narrows to the same trigram
      // candidates (normalized prefilter) but must fail exact verification.
      expect(await opened.projections.searchLiteral("needle", { case_sensitive: true })).toEqual([]);
      await opened.close();
    });
  });

  it("tracks lexical maintenance completion as a per-workspace generation marker", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      expect(await opened.projections.lexicalCompletedGeneration()).toBeUndefined();
      await opened.projections.markLexicalComplete(3);
      expect(await opened.projections.lexicalCompletedGeneration()).toBe(3);
      // Replaces wholesale (one row per workspace): a later mark overwrites,
      // it does not accumulate history.
      await opened.projections.markLexicalComplete(5);
      expect(await opened.projections.lexicalCompletedGeneration()).toBe(5);
      await expect(opened.projections.markLexicalComplete(-1)).rejects.toMatchObject({ code: "storage:invalid_generation" });
      await opened.close();
    });
  });

  it("tracks semantic maintenance completion as a per-workspace generation+provider marker", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      expect(await opened.projections.semanticIndexState()).toBeUndefined();
      await opened.projections.markSemanticComplete({ completed_generation: 3, profile_id: "core:local-hash-256-v1", executable_binding_id: "binding-digest-1" });
      expect(await opened.projections.semanticIndexState()).toEqual({ completed_generation: 3, profile_id: "core:local-hash-256-v1", executable_binding_id: "binding-digest-1" });
      // Replaces wholesale (one row per workspace): a later mark overwrites,
      // it does not accumulate history -- including a provider swap, which
      // must replace the previously-recorded profile/binding identity too,
      // not just the generation.
      await opened.projections.markSemanticComplete({ completed_generation: 5, profile_id: "core:http-swapped-model-256", executable_binding_id: "binding-digest-2" });
      expect(await opened.projections.semanticIndexState()).toEqual({ completed_generation: 5, profile_id: "core:http-swapped-model-256", executable_binding_id: "binding-digest-2" });
      await expect(opened.projections.markSemanticComplete({ completed_generation: -1, profile_id: "core:local-hash-256-v1", executable_binding_id: "binding-digest-1" })).rejects.toMatchObject({ code: "storage:invalid_generation" });
      await expect(opened.projections.markSemanticComplete({ completed_generation: 1, profile_id: "", executable_binding_id: "binding-digest-1" })).rejects.toMatchObject({ code: "storage:invalid_semantic_index_state" });
      await expect(opened.projections.markSemanticComplete({ completed_generation: 1, profile_id: "core:local-hash-256-v1", executable_binding_id: "" })).rejects.toMatchObject({ code: "storage:invalid_semantic_index_state" });
      await opened.close();
    });
  });

  it("recomputes normative projection-set entries instead of hashing raw payload blobs", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedOwner(storage, opened, workspaceA.workspace_id, "projection-digest-artifact", "projection-digest-version", "projection digest source");
      await seedSnapshot(opened, workspaceA.workspace_id, "projection-digest-snapshot");
      await opened.projections.putGraphEdge({ edge_id: "projection-digest-edge", source_subject_id: "source", target_subject_id: "target", relation_record_id: "record", relation_kind: "calls", role: "callee", evidence_class: "confirmed", owner_artifact_id: "projection-digest-artifact", owner_artifact_version_id: "projection-digest-version", valid_from_generation: 1 });
      await opened.database.run("UPDATE snapshots SET projection_set_digests = ?, snapshot_payload = ? WHERE snapshot_id = ?", ["[]", encodeCanonical({ snapshot_id: "projection-digest-snapshot", workspace_id: workspaceA.workspace_id, generation: 1, generation_manifest_id: "manifest-projection-digest-snapshot", registry_snapshot_id: "registry-projection-digest-snapshot", resolution_lock_id: "lock-projection-digest-snapshot", configuration_revision_id: "config-projection-digest-snapshot", source_state_digest: "source-projection-digest-snapshot", source_observation_watermarks: "{}", canonical_record_set_digest: "records-projection-digest-snapshot", projection_set_digests: "[]", capability_state_digest: "capabilities-projection-digest-snapshot", published_at: "2026-08-09T00:00:00.000000000Z", snapshot_digest: "snapshot-digest-projection-digest-snapshot" }), "projection-digest-snapshot"]);
      expect((await opened.maintenance.verify()).failures).toEqual(expect.arrayContaining([expect.objectContaining({ component_kind: "snapshot", error_code: "storage:projection_set_digest_corrupt" })]));
      await opened.close();
    });
  });

  it("backs up and restores catalog metadata alongside the workspace database", async () => {
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      const backup = join(root, "portable-backup");
      await opened.maintenance.createBackup(backup);
      const catalogBackup = await openSqliteDatabase({ filename: join(backup, "catalog.sqlite"), read_only: true });
      try { expect((await catalogBackup.get<{ workspace_id: string }>("SELECT workspace_id FROM installation_workspaces WHERE workspace_id = ?", [workspaceA.workspace_id]))?.workspace_id).toBe(workspaceA.workspace_id); } finally { await catalogBackup.close(); }
      const restored = join(root, "portable-restore");
      const originalDatabase = (await storage.catalog.database.get<{ database_path: string }>("SELECT database_path FROM installation_workspaces WHERE workspace_id = ?", [workspaceA.workspace_id]))?.database_path;
      await opened.close();
      if (!originalDatabase) throw new Error("test workspace database path missing");
      await rm(originalDatabase, { force: true });
      await opened.maintenance.restoreBackup(backup, restored);
      const restoredCatalog = await openSqliteDatabase({ filename: join(restored, "catalog.sqlite"), read_only: true });
      try { expect((await restoredCatalog.get<{ workspace_id: string; database_path: string; canonical_root: string }>("SELECT workspace_id, database_path, canonical_root FROM installation_workspaces WHERE workspace_id = ?", [workspaceA.workspace_id]))).toEqual(expect.objectContaining({ workspace_id: workspaceA.workspace_id, database_path: join(restored, "workspace.sqlite"), canonical_root: restored })); } finally { await restoredCatalog.close(); }
    });
  });

  it("retains roots from a removed workspace registration", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      const retained = await storage.cas.put(new TextEncoder().encode("removed workspace retained"), { media_type: "text/plain" });
      await opened.lifecycle.pinCasObject(retained.content_hash);
      await storage.catalog.database.run("UPDATE installation_workspaces SET removed_at = ? WHERE workspace_id = ?", ["2026-08-09T00:00:00.000000000Z", workspaceA.workspace_id]);
      await opened.maintenance.collect({ epoch_id: "removed-workspace-roots", now: "2026-08-09T00:00:01.000000000Z", batch_size: 20 });
      expect(await storage.cas.has(retained.content_hash)).toBe(true);
      await opened.close();
    });
  });

  it("purges a removed workspace only after its recovery grace period", async () => {
    await withStorage(async (_root, storage) => {
      const registered = await storage.catalog.registerWorkspace(workspaceA);
      await storage.catalog.database.run("UPDATE installation_workspaces SET removed_at = ? WHERE workspace_id = ?", ["2026-08-09T00:00:00.000000000Z", workspaceA.workspace_id]);
      await writeFile(`${registered.database_path}-wal`, "stale wal sidecar");
      await writeFile(`${registered.database_path}-shm`, "stale shm sidecar");
      await expect(storage.catalog.purgeWorkspace(workspaceA.workspace_id, "2026-08-09T12:00:00.000000000Z")).rejects.toMatchObject({ code: "storage:workspace_purge_grace" });
      await expect(storage.catalog.purgeWorkspace(workspaceA.workspace_id, "2026-08-10T00:00:01.000000000Z")).resolves.toMatchObject({ workspace_id: workspaceA.workspace_id, purged: true });
      await expect(access(registered.database_path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(`${registered.database_path}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(`${registered.database_path}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await storage.catalog.database.get("SELECT workspace_id FROM installation_workspaces WHERE workspace_id = ?", [workspaceA.workspace_id])).toBeUndefined();
    });
  });

  it("refuses to purge while a snapshot lease is still protecting a reference", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedSnapshot(opened, workspaceA.workspace_id, "purge-protected-snapshot");
      await opened.lifecycle.acquireLease({
        retention_lease_id: "purge-protected-lease",
        snapshot_id: "purge-protected-snapshot",
        holder_type: "query",
        holder_id: "purge-protected-query",
        now: "2026-08-09T00:00:00.000000000Z",
        idle_expires_at: "2026-08-11T00:00:00.000000000Z",
        absolute_expires_at: "2026-08-12T00:00:00.000000000Z",
      });
      await opened.close();
      await storage.catalog.database.run("UPDATE installation_workspaces SET removed_at = ? WHERE workspace_id = ?", ["2026-08-09T00:00:00.000000000Z", workspaceA.workspace_id]);
      await expect(storage.catalog.purgeWorkspace(workspaceA.workspace_id, "2026-08-10T00:00:01.000000000Z")).rejects.toMatchObject({ code: "storage:workspace_references_active" });
    });
  });

  it("records removal without rewriting the immutable workspace registration payload", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      await expect(storage.catalog.markWorkspaceRemoved({
        ...workspaceA,
        status: "removed",
        removed_at: "2026-08-09T00:00:00.000000000Z",
        source_provider_bindings: [{
          source_provider_binding_id: "provider-a",
          source_provider: "core:test",
          source_provider_version: "1",
          provider_role: "primary",
          binding_identity: "identity-a",
          configuration_digest: "config-a",
        }],
      })).resolves.toBe(true);
      const row = await storage.catalog.database.get<{ removed_at: string | null; workspace_payload: unknown }>("SELECT removed_at, workspace_payload FROM installation_workspaces WHERE workspace_id = ?", [workspaceA.workspace_id]);
      expect(row?.removed_at).toBe("2026-08-09T00:00:00.000000000Z");
      expect(decodeCanonical(row?.workspace_payload as Uint8Array)).toMatchObject({ workspace_id: workspaceA.workspace_id, status: "removed" });
      expect(await storage.catalog.listWorkspaces()).toEqual([]);
    });
  });

  it("keeps a shared CAS object reachable when purging another workspace", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      await storage.catalog.registerWorkspace(workspaceB);
      const removed = await storage.openWorkspace(workspaceA.workspace_id);
      const survivor = await storage.openWorkspace(workspaceB.workspace_id);
      const shared = await storage.cas.put(new TextEncoder().encode("shared-cas-reference"), { media_type: "text/plain" });
      await survivor.lifecycle.pinCasObject(shared.content_hash);
      await removed.close();
      await storage.catalog.database.run("UPDATE installation_workspaces SET removed_at = ? WHERE workspace_id = ?", ["2026-08-09T00:00:00.000000000Z", workspaceA.workspace_id]);
      await expect(storage.catalog.purgeWorkspace(workspaceA.workspace_id, "2026-08-10T00:00:01.000000000Z")).resolves.toMatchObject({ purged: true });
      await survivor.maintenance.collect({ epoch_id: "shared-reference-gc", now: "2026-08-10T00:00:02.000000000Z", batch_size: 20 });
      expect(await storage.cas.has(shared.content_hash)).toBe(true);
      await survivor.close();
    });
  });

  it("migrates equivalent logical rows across a physical schema addition", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await opened.database.exec("ALTER TABLE workspace_meta ADD COLUMN physical_migration_note TEXT DEFAULT 'ignored'");
      await expect(opened.maintenance.migrate(2)).resolves.toBeUndefined();
      expect((await opened.database.get<{ value: unknown }>("SELECT value FROM workspace_meta WHERE key = 'storage_format_version'"))?.value).toBeInstanceOf(Uint8Array);
      await opened.close();
    });
  });

  it("recomputes projection typed rows from canonical payloads during migration", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedOwner(storage, opened, workspaceA.workspace_id, "migration-recompute-artifact", "migration-recompute-version", "migration recompute source");
      await opened.projections.putGraphEdge({ edge_id: "migration-recompute-edge", source_subject_id: "source", target_subject_id: "canonical-target", relation_record_id: "record", relation_kind: "calls", role: "callee", evidence_class: "confirmed", owner_artifact_id: "migration-recompute-artifact", owner_artifact_version_id: "migration-recompute-version", valid_from_generation: 1 });
      await opened.database.run("UPDATE graph_edges SET target_subject_id = 'tampered' WHERE edge_id = ?", ["migration-recompute-edge"]);
      await expect(opened.maintenance.migrate(2)).resolves.toBeUndefined();
      expect((await opened.database.get<{ target_subject_id: string }>("SELECT target_subject_id FROM graph_edges WHERE edge_id = ?", ["migration-recompute-edge"]))?.target_subject_id).toBe("canonical-target");
      await opened.close();
    });
  });

  it("recomputes lexical projections from authoritative content blobs during migration", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedOwner(storage, opened, workspaceA.workspace_id, "lexical-migration-artifact", "lexical-migration-version", "lexical migration source");
      await opened.projections.putLexicalDocument({ artifact_id: "lexical-migration-artifact", artifact_version_id: "lexical-migration-version", text: "lexical migration source", valid_from_generation: 1 });
      const expected = await opened.database.get<{ content_hash: string }>("SELECT content_hash FROM content_blobs WHERE content_blob_id = ?", ["blob-ws-review-a-lexical-migration-version"]);
      await expect(opened.maintenance.migrate(2)).resolves.toBeUndefined();
      const repaired = await opened.database.get<{ content_hash: string; byte_length: number }>("SELECT content_hash, byte_length FROM lexical_documents WHERE artifact_id = ?", ["lexical-migration-artifact"]);
      expect(repaired).toEqual({ content_hash: expected?.content_hash, byte_length: "lexical migration source".length });
      const trigramRows = await opened.database.all<{ trigram: string }>("SELECT trigram FROM lexical_trigrams WHERE artifact_id = ? ORDER BY trigram", ["lexical-migration-artifact"]);
      expect(trigramRows.map((row) => row.trigram)).toEqual([...lexicalTrigrams("lexical migration source")]);
      await opened.close();
    });
  });

  it("uses ordered per-record projection entries scoped to one generation", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedOwner(storage, opened, workspaceA.workspace_id, "digest-generation-artifact", "digest-generation-version", "generation source", 1);
      await opened.projections.putGraphEdge({ edge_id: "digest-generation-edge", source_subject_id: "source", target_subject_id: "target", relation_record_id: "record", relation_kind: "calls", role: "callee", evidence_class: "confirmed", owner_artifact_id: "digest-generation-artifact", owner_artifact_version_id: "digest-generation-version", valid_from_generation: 1 });
      const before = await opened.maintenance.getProjectionSetDigestEntries(1);
      await opened.database.run("INSERT INTO graph_edges (edge_id, workspace_id, source_subject_id, target_subject_id, relation_record_id, relation_kind, role, evidence_class, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation, edge_payload) SELECT ?, workspace_id, source_subject_id, 'future', relation_record_id, relation_kind, role, evidence_class, owner_artifact_id, owner_artifact_version_id, 9, NULL, edge_payload FROM graph_edges WHERE edge_id = ?", ["future-digest-edge", "digest-generation-edge"]);
      const after = await opened.maintenance.getProjectionSetDigestEntries(1);
      expect(after).toEqual(before);
      expect(after.every((entry) => entry.projection_set_digest.startsWith("sha256:"))).toBe(true);
      await opened.close();
    });
  });

  it("localizes canonical set and snapshot digest corruption", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedOwner(storage, opened, workspaceA.workspace_id, "digest-artifact", "digest-version", "digest source");
      await seedSnapshot(opened, workspaceA.workspace_id, "digest-snapshot");
      await opened.repositories.canonicalOccurrences.put({ record_id: "digest-record", category: "entity", kind: "test", universal_kind: "entity", facets: [], schema_version: 1, workspace_id: workspaceA.workspace_id, owner_artifact_id: "digest-artifact", owner_artifact_version_id: "digest-version", valid_from_generation: 1, producer_id: "test", producer_version: "1", analysis_digest: "analysis", analysis_configuration_digest: "configuration", artifact_dependency_digest: "dependencies", payload: { value: "canonical" }, record_digest: "record-digest" });
      await opened.database.run("UPDATE record_occurrences SET record_digest = ? WHERE record_id = ?", ["sha256:0000000000000000000000000000000000000000000000000000000000000000", "digest-record"]);
      await opened.database.run("UPDATE snapshots SET snapshot_digest = ? WHERE snapshot_id = ?", ["sha256:0000000000000000000000000000000000000000000000000000000000000000", "digest-snapshot"]);
      const report = await opened.maintenance.verify();
      expect(report.ok).toBe(false);
      expect(report.failures.map((failure) => failure.component_kind)).toEqual(expect.arrayContaining(["canonical", "snapshot"]));
      await opened.close();
    });
  });

  it("rejects registry payload omission and control-plane closure corruption", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedSnapshot(opened, workspaceA.workspace_id, "registry-control-corruption");
      await opened.database.run("UPDATE registry_snapshots SET registry_payload = ? WHERE registry_snapshot_id = ?", [encodeCanonical({ registry_snapshot_id: "registry-registry-control-corruption", workspace_id: workspaceA.workspace_id }), "registry-registry-control-corruption"]);
      await opened.database.run("INSERT INTO control_plane_state (state_key, workspace_id, state_kind, payload, reference_workspace_id, reference_snapshot_id, reference_source_state_digest, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["valid-control", workspaceA.workspace_id, "workspace_configuration_revision", encodeCanonical({ workspace_id: workspaceA.workspace_id, snapshot_id: "registry-control-corruption", source_state_digest: "source-registry-control-corruption" }), workspaceA.workspace_id, "registry-control-corruption", "source-registry-control-corruption", "2026-08-09T00:00:00.000Z"]);
      await opened.database.run("INSERT INTO control_plane_state (state_key, workspace_id, state_kind, payload, reference_workspace_id, reference_snapshot_id, reference_source_state_digest, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["corrupt-control", workspaceA.workspace_id, "workspace_configuration_revision", encodeCanonical({ workspace_id: workspaceA.workspace_id, source_state_digest: "payload-source" }), workspaceA.workspace_id, "registry-control-corruption", "row-source", "2026-08-09T00:00:00.000Z"]);
      const failures = (await opened.maintenance.verify()).failures;
      expect(failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ component_kind: "registry", error_code: "storage:registry_corrupt" }),
        expect.objectContaining({ component_kind: "control_plane", component_id: "corrupt-control" }),
      ]));
      await opened.close();
    });
  });

  it("restores canonical authoritative state from a verified backup", async () => {
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedOwner(storage, opened, workspaceA.workspace_id, "repair-canonical-artifact", "repair-canonical-version", "repair canonical source");
      await opened.repositories.canonicalOccurrences.put({ record_id: "repair-canonical-record", category: "entity", kind: "test", universal_kind: "entity", facets: [], schema_version: 1, workspace_id: workspaceA.workspace_id, owner_artifact_id: "repair-canonical-artifact", owner_artifact_version_id: "repair-canonical-version", valid_from_generation: 1, producer_id: "test", producer_version: "1", analysis_digest: "analysis", analysis_configuration_digest: "configuration", artifact_dependency_digest: "dependencies", payload: { value: "canonical" }, record_digest: "repair-record-digest" });
      const backup = join(root, "canonical-repair-backup");
      await opened.maintenance.createBackup(backup);
      await opened.database.run("UPDATE record_occurrences SET record_payload = ? WHERE record_id = ?", [encodeCanonical({ corrupted: true }), "repair-canonical-record"]);
      expect((await opened.maintenance.verify()).failures).toEqual(expect.arrayContaining([expect.objectContaining({ component_kind: "canonical" })]));
      await expect(opened.maintenance.repair({ component_kind: "canonical", component_id: "repair-canonical-record", backup_directory: backup })).resolves.toMatchObject({ action: "restore_authoritative_state" });
      expect(await opened.maintenance.verify()).toEqual({ ok: true, failures: [] });
      await opened.close();
    });
  });

  it("rejects unsupported persisted storage format metadata before migration", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await opened.database.run("INSERT INTO workspace_meta (key, value) VALUES ('storage_format_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [encodeCanonical({ format: "unknown" })]);
      await expect(opened.maintenance.migrate(2)).rejects.toMatchObject({ code: "storage:migration_format_invalid" });
      await opened.close();
    });
  });

  it("registers versioned typed adapters rather than one generic migration handler", () => {
    const entries = Object.values(MIGRATION_TABLE_ADAPTERS);
    expect(entries.length).toBeGreaterThan(20);
    expect(new Set(entries.map((entry) => entry.adapter)).size).toBeGreaterThan(1);
    expect(entries.every((entry) => entry.decoder_version === 1 && entry.adapter_version === 1 && typeof entry.validate === "function" && entry.validation_name.length > 0)).toBe(true);
  });

  it("covers lifecycle idempotency, missing-resource, and immutable-marker paths", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      await expect(storage.openWorkspace("missing-workspace")).rejects.toMatchObject({ code: "storage:workspace_not_found" });
      await expect(storage.catalog.registerWorkspace({ ...workspaceA, display_root: "/changed" }, join(_root, "alternate.sqlite"))).rejects.toMatchObject({ code: "storage:immutable_workspace" });
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedSnapshot(opened, workspaceA.workspace_id, "lifecycle-snapshot");
      expect(await opened.lifecycle.getExpirationMarker("none")).toBeUndefined();
      const lifecycleLease = await opened.lifecycle.acquireLease({ retention_lease_id: "lifecycle-lease", snapshot_id: "lifecycle-snapshot", holder_type: "query", holder_id: "lifecycle", now: "2026-08-09T00:00:00.000000000Z", idle_expires_at: "2026-08-09T00:10:00.000000000Z", absolute_expires_at: "2026-08-09T00:20:00.000000000Z" });
      await opened.lifecycle.renewLease(lifecycleLease.retention_lease_id, "2026-08-09T00:01:00.000000000Z", "2026-08-09T00:11:00.000000000Z");
      await expect(opened.lifecycle.getLease("missing")).resolves.toBeUndefined();
      await expect(opened.lifecycle.getPin("missing")).resolves.toBeUndefined();
      await expect(opened.lifecycle.renewLease("missing", "2026-08-09T00:00:00.000000000Z", "2026-08-09T00:01:00.000000000Z")).rejects.toMatchObject({ code: "storage:lease_expired" });
      await opened.lifecycle.pinCasObject("sha256:0000000000000000000000000000000000000000000000000000000000000000");
      await opened.lifecycle.addRetentionRoot("candidate", "candidate-1", "sha256:0000000000000000000000000000000000000000000000000000000000000000");
      const marker = { snapshot_expiration_id: "expiration-1", workspace_id: workspaceA.workspace_id, snapshot_id: "lifecycle-snapshot", generation: 1, expired_at: "2026-08-09T00:00:00.000000000Z", expiration_reason_code: "test", garbage_collection_epoch_id: "epoch-1", snapshot_digest: "digest" };
      await expect(opened.lifecycle.markSnapshotExpired(marker)).resolves.toEqual(marker);
      await expect(opened.lifecycle.markSnapshotExpired(marker)).resolves.toEqual(marker);
      expect(await opened.lifecycle.getExpirationMarker("lifecycle-snapshot")).toEqual(marker);
      await expect(opened.lifecycle.markSnapshotExpired({ ...marker, snapshot_digest: "different" })).rejects.toMatchObject({ code: "storage:expiration_conflict" });
      await opened.lifecycle.releaseLease("missing", "2026-08-09T00:00:00.000000000Z", "missing");
      await opened.lifecycle.releasePin("missing", "2026-08-09T00:00:00.000000000Z", "missing");
      await storage.cas.put(new TextEncoder().encode("gc-one"));
      await storage.cas.put(new TextEncoder().encode("gc-two"));
      const partial = await opened.maintenance.collect({ now: "2026-08-09T00:00:00.000000000Z", batch_size: 1, epoch_id: "coverage-gc" });
      expect(partial.remaining_candidates).toBeGreaterThanOrEqual(1);
      await opened.maintenance.collect({ now: "2026-08-09T00:00:01.000000000Z", batch_size: 10, epoch_id: partial.epoch_id });
      await opened.close();
      await opened.close();
    });
  });

  it("protects cross-workspace CAS roots and blocks new readers during the GC barrier", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      await storage.catalog.registerWorkspace(workspaceB);
      const first = await storage.openWorkspace(workspaceA.workspace_id);
      const second = await storage.openWorkspace(workspaceB.workspace_id);
      await seedSnapshot(second, workspaceB.workspace_id, "snapshot-b");
      const shared = await storage.cas.put(new TextEncoder().encode("workspace-b-root"));
      await second.lifecycle.pinCasObject(shared.content_hash);
      expect(await first.maintenance.collect({ now: "2026-08-09T00:00:00.000000000Z", batch_size: 10 })).toEqual(expect.objectContaining({ deleted_hashes: [] }));
      expect(await storage.cas.has(shared.content_hash)).toBe(true);

      const blockedMaintenance = new StorageMaintenance(first.database, storage.cas, storage.blobs, _root, workspaceA.workspace_id, createFaultInjector(["collection.before_sweep"]));
      await expect(blockedMaintenance.collect({ now: "2026-08-09T00:00:01.000000000Z", batch_size: 10, epoch_id: "epoch-reader-barrier" })).rejects.toMatchObject({ code: "storage:fault_injected" });
      await expect(second.lifecycle.acquireLease({ retention_lease_id: "reader-after-mark", snapshot_id: "snapshot-b", holder_type: "query", holder_id: "query-b", now: "2026-08-09T00:00:02.000000000Z", idle_expires_at: "2026-08-09T00:01:00.000000000Z", absolute_expires_at: "2026-08-09T00:02:00.000000000Z" })).resolves.toBeDefined();
      await first.close();
      await second.close();
    });
  }, 30000);

  it("reconciles a crashed shadow migration during startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase5-migration-crash-"));
    try {
      const childScript = `
        const { createDurableStorage, createFaultInjector } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "packages/storage/dist/index.js")).href)});
        const storage = await createDurableStorage({ rootDir: ${JSON.stringify(root)}, inlineThresholdBytes: 8, fault_injector: createFaultInjector(["migration.before_publish"]) });
        const workspace = ${JSON.stringify(workspaceA)};
        await storage.catalog.registerWorkspace(workspace);
        const opened = await storage.openWorkspace(workspace.workspace_id);
        try { await opened.maintenance.migrate(2); } catch {}
        process.kill(process.pid, "SIGKILL");
      `;
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
        const stderr: Buffer[] = [];
        child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.once("error", reject);
        child.once("exit", (code, signal) => signal === "SIGKILL" || (process.platform === "win32" && code === 1 && signal === null) ? resolve() : reject(new Error(`migration crash child exited with ${code}/${signal}: ${Buffer.concat(stderr).toString()}`)));
      });
      const storage = await createDurableStorage({ rootDir: root, inlineThresholdBytes: 8 });
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedSnapshot(opened, workspaceA.workspace_id, "snapshot-a");
      expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM storage_migrations WHERE state = 'running'"))?.count).toBe(0);
      expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM storage_migrations WHERE state = 'completed'"))?.count).toBe(1);
      await opened.close();
      await storage.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30000);

  it("creates a WAL-consistent backup and atomically restores verified contents", async () => {
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedSnapshot(opened, workspaceA.workspace_id, "snapshot-a");
      const walLease = await opened.lifecycle.acquireLease({ retention_lease_id: "wal-lease", snapshot_id: "snapshot-a", holder_type: "query", holder_id: "wal-execution", now: "2026-08-09T00:00:00.000000000Z", idle_expires_at: "2026-08-09T00:10:00.000000000Z", absolute_expires_at: "2026-08-09T00:20:00.000000000Z" });
      await opened.lifecycle.createExecution({ query_execution_id: "wal-execution", workspace_snapshot_ids: ["snapshot-a"], query_plan_hash: "plan", projection_digest: "projection", scope_digest: "scope", response_budget_ceiling: "budget", retention_lease_ids: [walLease.retention_lease_id], created_at: "2026-08-09T00:00:00.000000000Z", expires_at: "2026-08-09T00:05:00.000000000Z" });
      await opened.lifecycle.appendManifestSegment("wal-execution", "segment-1", Array.from({ length: 32 }, (_, ordinal) => ({ ordinal, value: `value-${ordinal}` })));
      const backup = join(root, "wal-backup");
      await opened.maintenance.createBackup(backup);
      const restored = join(root, "wal-restored");
      await opened.maintenance.restoreBackup(backup, restored);
      const restoredDb = await openSqliteDatabase({ filename: join(restored, "workspace.sqlite"), read_only: true });
      try {
        expect((await restoredDb.get<{ execution_status: string }>("SELECT execution_status FROM query_executions WHERE query_execution_id = ?", ["wal-execution"]))?.execution_status).toBe("ready");
        expect((await restoredDb.get<{ quick_check: string }>("PRAGMA quick_check"))?.quick_check).toBe("ok");
      } finally { await restoredDb.close(); }
      expect(await readFile(join(backup, "manifest.json"), "utf8")).toContain("wal-execution");
      const restoredBarriers = await openSqliteDatabase({ filename: join(restored, "workspace.sqlite"), read_only: true });
      try { expect((await restoredBarriers.get<{ count: number }>("SELECT COUNT(*) AS count FROM backup_barriers WHERE state = 'active'"))?.count).toBe(0); } finally { await restoredBarriers.close(); }
      await opened.close();
    });
  });

  it("reconciles a failed migration attempt and retries with a unique identity", async () => {
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      const failing = new StorageMaintenance(opened.database, storage.cas, storage.blobs, root, workspaceA.workspace_id, createFaultInjector(["migration.before_swap"]));
      await expect(failing.migrate(2)).rejects.toMatchObject({ code: "storage:fault_injected" });
      await expect(opened.maintenance.migrate(2)).resolves.toBeUndefined();
      expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM storage_migrations WHERE workspace_id = ? AND state = 'completed'", [workspaceA.workspace_id]))?.count).toBe(1);
      expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM storage_migrations WHERE workspace_id = ? AND state = 'aborted'", [workspaceA.workspace_id]))?.count).toBe(1);
      await opened.close();
    });
  });

  it("recovers physical migration publication faults and remains idempotent", async () => {
    for (const boundary of ["migration.before_publish", "migration.after_swap"] as const) {
      await withStorage(async (root, storage) => {
        await storage.catalog.registerWorkspace(workspaceA);
        const opened = await storage.openWorkspace(workspaceA.workspace_id);
        const failing = new StorageMaintenance(opened.database, storage.cas, storage.blobs, root, workspaceA.workspace_id, createFaultInjector([boundary]));
        await expect(failing.migrate(2)).rejects.toMatchObject({ code: "storage:fault_injected" });
        await opened.close();
        await storage.close();
        const restarted = await createDurableStorage({ rootDir: root, inlineThresholdBytes: 8 });
        const reopened = await restarted.openWorkspace(workspaceA.workspace_id);
        await expect(reopened.maintenance.migrate(2)).resolves.toBeUndefined();
        expect((await reopened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM storage_migrations WHERE state = 'completed'"))?.count).toBe(1);
        await reopened.close();
        await restarted.close();
      });
    }
  }, 30000);

  it("preserves canonical rows and CAS through a verified shadow migration and restart", async () => {
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedOwner(storage, opened, workspaceA.workspace_id, "migration-artifact", "migration-version", "migration source");
      const retained = await storage.cas.put(new TextEncoder().encode("migration-cas"));
      await opened.lifecycle.pinCasObject(retained.content_hash);
      const before = await opened.database.get<{ artifact_count: number; version_count: number; pin_count: number }>("SELECT (SELECT COUNT(*) FROM source_artifacts) AS artifact_count, (SELECT COUNT(*) FROM artifact_versions) AS version_count, (SELECT COUNT(*) FROM lifecycle_cas_pins) AS pin_count");
      const failing = new StorageMaintenance(opened.database, storage.cas, storage.blobs, root, workspaceA.workspace_id, createFaultInjector(["migration.after_shadow_copy"]));
      await expect(failing.migrate(3)).rejects.toMatchObject({ code: "storage:fault_injected" });
      await opened.close();
      await storage.close();
      const restarted = await createDurableStorage({ rootDir: root, inlineThresholdBytes: 8 });
      const reopened = await restarted.openWorkspace(workspaceA.workspace_id);
      const afterFailure = await reopened.database.get<{ artifact_count: number; version_count: number; pin_count: number }>("SELECT (SELECT COUNT(*) FROM source_artifacts) AS artifact_count, (SELECT COUNT(*) FROM artifact_versions) AS version_count, (SELECT COUNT(*) FROM lifecycle_cas_pins) AS pin_count");
      expect(afterFailure).toEqual(before);
      expect(await restarted.cas.has(retained.content_hash)).toBe(true);
      await expect(reopened.maintenance.migrate(3)).resolves.toBeUndefined();
      const migration = await reopened.database.get<{ shadow_database_path: string; shadow_database_digest: string; backup_path: string }>("SELECT shadow_database_path, shadow_database_digest, backup_path FROM storage_migrations WHERE state = 'completed' ORDER BY started_at DESC LIMIT 1");
      expect(migration?.shadow_database_path).toContain("migrations");
      expect(String(migration?.shadow_database_digest)).toMatch(/^sha256:[0-9a-f]{64}$/);
      const backupDb = await openSqliteDatabase({ filename: join(migration?.backup_path ?? "", "workspace.sqlite"), read_only: true });
      try { expect((await backupDb.get<{ count: number }>("SELECT COUNT(*) AS count FROM source_artifacts WHERE artifact_id = ?", ["migration-artifact"]))?.count).toBe(1); } finally { await backupDb.close(); }
      await reopened.close();
      await restarted.close();
    });
  });

  it("rejects unsupported vector encodings and packs a deterministic vector shard", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await expect(opened.projections.putVector({ projection_record_id: "unsupported", owner_artifact_id: "missing", owner_artifact_version_id: "missing", profile_id: "profile", executable_binding_id: "binding", dimensions: 1, element_type: "int16", vector: new Uint8Array([0, 0]) })).rejects.toMatchObject({ code: "storage:unsupported_vector_encoding" });
      await expect(opened.projections.putVectors([])).rejects.toMatchObject({ code: "storage:invalid_vector_batch" });
      await opened.close();
    });
  });

  it("keeps projection reads historical and rejects cross-workspace owners", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      await storage.catalog.registerWorkspace(workspaceB);
      const first = await storage.openWorkspace(workspaceA.workspace_id);
      const second = await storage.openWorkspace(workspaceB.workspace_id);
      await seedOwner(storage, first, workspaceA.workspace_id, "artifact-a", "version-1", "old text", 1);
      await seedOwner(storage, first, workspaceA.workspace_id, "artifact-a", "version-2", "new text", 2);
      await seedOwner(storage, second, workspaceB.workspace_id, "artifact-b", "version-b", "other text");
      await first.projections.putGraphEdge({ edge_id: "historical-edge", source_subject_id: "s", target_subject_id: "old", relation_record_id: "r1", relation_kind: "calls", role: "callee", evidence_class: "confirmed", owner_artifact_id: "artifact-a", owner_artifact_version_id: "version-1", valid_from_generation: 1, valid_to_generation: 2 });
      await first.projections.putGraphEdge({ edge_id: "historical-edge", source_subject_id: "s", target_subject_id: "new", relation_record_id: "r2", relation_kind: "calls", role: "callee", evidence_class: "confirmed", owner_artifact_id: "artifact-a", owner_artifact_version_id: "version-2", valid_from_generation: 2 });
      await first.projections.putLexicalDocument({ artifact_id: "artifact-a", artifact_version_id: "version-1", text: "old text", valid_from_generation: 1, valid_to_generation: 2 });
      await first.projections.putLexicalDocument({ artifact_id: "artifact-a", artifact_version_id: "version-2", text: "new text", valid_from_generation: 2 });
      await first.projections.putMetric({ metric_id: "historical-metric", projection_record_id: "r1", metric_kind: "fan_out", metric_value: 1, owner_artifact_id: "artifact-a", owner_artifact_version_id: "version-1", valid_from_generation: 1, valid_to_generation: 2 });
      await first.projections.putMetric({ metric_id: "historical-metric", projection_record_id: "r2", metric_kind: "fan_out", metric_value: 2, owner_artifact_id: "artifact-a", owner_artifact_version_id: "version-2", valid_from_generation: 2 });
      expect((await first.projections.neighbors("s", "outbound", { generation: 1 }))[0]?.target_subject_id).toBe("old");
      expect((await first.projections.neighbors("s", "outbound", { generation: 2 }))[0]?.target_subject_id).toBe("new");
      expect((await first.projections.searchLiteral("old", { generation: 1 }))).toHaveLength(1);
      expect(await first.projections.searchLiteral("old", { generation: 2 })).toEqual([]);
      expect((await first.projections.getMetric("historical-metric", 1))?.metric_value).toBe(1);
      expect((await first.projections.getMetric("historical-metric", 2))?.metric_value).toBe(2);
      expect((await first.projections.neighbors("s", "outbound"))[0]?.target_subject_id).toBe("new");
      expect(await first.projections.searchLiteral("old")).toEqual([]);
      expect((await first.projections.getMetric("historical-metric"))?.metric_value).toBe(2);
      await expect(first.projections.putGraphEdge({ edge_id: "cross-workspace", source_subject_id: "s", target_subject_id: "x", relation_record_id: "r", relation_kind: "calls", role: "callee", evidence_class: "confirmed", owner_artifact_id: "artifact-b", owner_artifact_version_id: "version-b", valid_from_generation: 1 })).rejects.toMatchObject({ code: "storage:projection_owner_missing" });
      await first.close();
      await second.close();
    });
  });

  it("packs exact vectors by profile with deterministic bytes and decodes declared distance", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedOwner(storage, opened, workspaceA.workspace_id, "artifact-a", "version-a", "vector owner");
      const vectorA = new Uint8Array([0, 0, 128, 63, 0, 0, 0, 64]);
      const vectorB = new Uint8Array([0, 0, 0, 64, 0, 0, 128, 63]);
      await opened.projections.putVectors([
        { projection_record_id: "vector-b", owner_artifact_id: "artifact-a", owner_artifact_version_id: "version-a", profile_id: "profile", executable_binding_id: "binding", dimensions: 2, element_type: "float32", vector: vectorB, normalization: "l2", distance_metric: "cosine" },
        { projection_record_id: "vector-a", owner_artifact_id: "artifact-a", owner_artifact_version_id: "version-a", profile_id: "profile", executable_binding_id: "binding", dimensions: 2, element_type: "float32", vector: vectorA, normalization: "l2", distance_metric: "cosine" },
      ]);
      expect((await opened.database.get<{ count: number; byte_length: number }>("SELECT COUNT(*) AS count, MAX(byte_length) AS byte_length FROM vector_shards WHERE workspace_id = ?", [workspaceA.workspace_id]))).toEqual({ count: 1, byte_length: 16 });
      expect((await opened.projections.exactVectorSearch(vectorA, { profile_id: "profile", executable_binding_id: "binding", dimensions: 2, element_type: "float32", normalization: "l2", distance_metric: "cosine", limit: 1 }))[0]?.projection_record_id).toBe("vector-a");
      await expect(opened.projections.putVector({ projection_record_id: "bad-profile", owner_artifact_id: "artifact-a", owner_artifact_version_id: "version-a", profile_id: "profile", executable_binding_id: "binding", dimensions: 2, element_type: "float32", vector: vectorA, vector_encoding: "float64-le" })).rejects.toMatchObject({ code: "storage:unsupported_vector_encoding" });
      await opened.close();
    });
  });

  // The semantic reconciler (packages/engine/src/semantic-reconciler.ts) calls
  // putVectors with exactly one row per call -- one embedded document at a
  // time, never a batch -- unlike this file's other putVectors coverage
  // above, which packs several rows into one call. Each single-row call
  // computes its own packed shard bytes and content_hash independently, so
  // two calls whose *single* vector happens to be byte-identical (two
  // different documents that embed to the same vector) produce the same
  // packed content_hash from two different putVectors invocations, not from
  // one batch that could de-duplicate in memory. This exercises that the
  // `vector_shards.content_hash UNIQUE` constraint is guarded by a fresh
  // `existingShard` lookup on every call (not just within one call's own
  // batch), so a second single-row call reusing an already-persisted shard's
  // exact bytes reuses that shard row instead of attempting a duplicate
  // INSERT.
  it("reuses an existing shard across separate single-row putVectors calls with identical vector bytes, and stays idempotent on exact re-submission", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedOwner(storage, opened, workspaceA.workspace_id, "artifact-a", "version-a", "vector owner");
      const sharedVector = new Uint8Array([0, 0, 128, 63, 0, 0, 0, 64]);
      const distinctVector = new Uint8Array([0, 0, 0, 64, 0, 0, 128, 63]);

      // Two different documents (different projection_record_id) that embed
      // to byte-identical vectors, each written via its own single-row call.
      await opened.projections.putVectors([{ projection_record_id: "shared-vector-1", owner_artifact_id: "artifact-a", owner_artifact_version_id: "version-a", profile_id: "profile", executable_binding_id: "binding", dimensions: 2, element_type: "float32", vector: sharedVector }]);
      await opened.projections.putVectors([{ projection_record_id: "shared-vector-2", owner_artifact_id: "artifact-a", owner_artifact_version_id: "version-a", profile_id: "profile", executable_binding_id: "binding", dimensions: 2, element_type: "float32", vector: sharedVector }]);
      // A third document with genuinely different vector bytes gets its own shard.
      await opened.projections.putVectors([{ projection_record_id: "distinct-vector", owner_artifact_id: "artifact-a", owner_artifact_version_id: "version-a", profile_id: "profile", executable_binding_id: "binding", dimensions: 2, element_type: "float32", vector: distinctVector }]);

      expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM vector_shards WHERE workspace_id = ?", [workspaceA.workspace_id]))?.count).toBe(2);
      const shardIds = await opened.database.all<{ projection_record_id: string; shard_id: string }>("SELECT projection_record_id, shard_id FROM vector_projection_rows WHERE workspace_id = ? ORDER BY projection_record_id", [workspaceA.workspace_id]);
      expect(shardIds.find((row) => row.projection_record_id === "shared-vector-1")?.shard_id).toBe(shardIds.find((row) => row.projection_record_id === "shared-vector-2")?.shard_id);
      expect(shardIds.find((row) => row.projection_record_id === "distinct-vector")?.shard_id).not.toBe(shardIds.find((row) => row.projection_record_id === "shared-vector-1")?.shard_id);
      expect(await opened.projections.readVector("shared-vector-1")).toEqual(sharedVector);
      expect(await opened.projections.readVector("shared-vector-2")).toEqual(sharedVector);
      expect(await opened.projections.readVector("distinct-vector")).toEqual(distinctVector);

      // Re-submitting the exact same single-row call (same projection_record_id,
      // same content) is the fast-path idempotent re-run the reconciler relies
      // on when a pass is retried -- must not throw and must not duplicate rows.
      await expect(opened.projections.putVectors([{ projection_record_id: "shared-vector-1", owner_artifact_id: "artifact-a", owner_artifact_version_id: "version-a", profile_id: "profile", executable_binding_id: "binding", dimensions: 2, element_type: "float32", vector: sharedVector }])).resolves.toBeUndefined();
      expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM vector_projection_rows WHERE workspace_id = ? AND projection_record_id = ?", [workspaceA.workspace_id, "shared-vector-1"]))?.count).toBe(1);
      await opened.close();
    });
  });

  it("expires every execution lease and repairs localized corruption in order", async () => {
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedSnapshot(opened, workspaceA.workspace_id, "snapshot");
      const lease = await opened.lifecycle.acquireLease({ retention_lease_id: "lease-manifest", snapshot_id: "snapshot", holder_type: "query", holder_id: "other-holder", now: "2026-08-09T00:00:00.000000000Z", idle_expires_at: "2026-08-09T00:10:00.000000000Z", absolute_expires_at: "2026-08-09T00:20:00.000000000Z" });
      await opened.lifecycle.createExecution({ query_execution_id: "execution-expiry", workspace_snapshot_ids: ["snapshot"], query_plan_hash: "plan", projection_digest: "projection", scope_digest: "scope", response_budget_ceiling: "budget", retention_lease_ids: [lease.retention_lease_id], created_at: "2026-08-09T00:00:00.000000000Z", expires_at: "2026-08-09T00:01:00.000000000Z" });
      await opened.lifecycle.appendManifestSegment("execution-expiry", "segment", [{ ordinal: 0, value: "ok" }, { ordinal: 1, value: "bounded" }]);
      expect(await opened.lifecycle.hydrateManifest("execution-expiry", 1, 1, "2026-08-09T00:00:30.000000000Z")).toEqual([{ ordinal: 1, value: "bounded" }]);
      expect(await opened.lifecycle.expireExecutions("2026-08-09T00:02:00.000000000Z")).toEqual(["execution-expiry"]);
      expect(await opened.lifecycle.getLease(lease.retention_lease_id)).toMatchObject({ released_at: "2026-08-09T00:02:00.000000000Z", release_reason: "execution_expired" });
      await expect(opened.lifecycle.hydrateManifest("execution-expiry", 0, 1)).rejects.toMatchObject({ code: "storage:execution_expired" });
      const blob = await storage.cas.put(new TextEncoder().encode("repairable"));
      await opened.lifecycle.pinCasObject(blob.content_hash);
      const backup = join(root, "repair-backup");
      await opened.maintenance.createBackup(backup);
      await rm(storage.cas.objectPath(blob.content_hash));
      expect((await opened.maintenance.verify()).failures).toEqual(expect.arrayContaining([expect.objectContaining({ component_kind: "pinned_cas_object", component_id: blob.content_hash })]));
      await expect(opened.maintenance.repair({ component_kind: "cas", component_id: blob.content_hash, backup_directory: backup })).resolves.toMatchObject({ action: "restore_exact_object" });
      expect((await opened.maintenance.verify()).ok).toBe(true);
      await opened.close();
    });
  });

  it("hydrates later manifest segments by ordinal and rejects expired reads immediately", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedSnapshot(opened, workspaceA.workspace_id, "snapshot");
      const pagedLease = await opened.lifecycle.acquireLease({ retention_lease_id: "paged-lease", snapshot_id: "snapshot", holder_type: "query", holder_id: "paged-execution", now: "2026-08-09T00:00:00.000000000Z", idle_expires_at: "2026-08-09T00:10:00.000000000Z", absolute_expires_at: "2026-08-09T00:20:00.000000000Z" });
      await opened.lifecycle.createExecution({ query_execution_id: "paged-execution", workspace_snapshot_ids: ["snapshot"], retention_lease_ids: [pagedLease.retention_lease_id], created_at: "2026-08-09T00:00:00.000000000Z", expires_at: "2999-01-01T00:00:00.000000000Z" });
      await opened.lifecycle.appendManifestSegment("paged-execution", "segment-a", [{ ordinal: 0, value: "a" }, { ordinal: 1, value: "b" }]);
      await opened.lifecycle.appendManifestSegment("paged-execution", "segment-b", [{ ordinal: 2, value: "c" }, { ordinal: 3, value: "d" }]);
      expect(await opened.lifecycle.hydrateManifest("paged-execution", 2, 2)).toEqual([{ ordinal: 2, value: "c" }, { ordinal: 3, value: "d" }]);
      const expiredLease = await opened.lifecycle.acquireLease({ retention_lease_id: "expired-lease", snapshot_id: "snapshot", holder_type: "query", holder_id: "expired-at-read", now: "1999-01-01T00:00:00.000000000Z", idle_expires_at: "2001-01-01T00:00:00.000000000Z", absolute_expires_at: "2002-01-01T00:00:00.000000000Z" });
      await opened.lifecycle.createExecution({ query_execution_id: "expired-at-read", workspace_snapshot_ids: ["snapshot"], retention_lease_ids: [expiredLease.retention_lease_id], created_at: "1999-01-01T00:00:00.000000000Z", expires_at: "2000-01-01T00:00:00.000000000Z" });
      await opened.lifecycle.appendManifestSegment("expired-at-read", "segment", [{ ordinal: 0, value: "expired" }]);
      await expect(opened.lifecycle.hydrateManifest("expired-at-read", 0, 1)).rejects.toMatchObject({ code: "storage:execution_expired" });
      await opened.close();
    });
  });

  it("retains catalog roots and clears GC barriers after mark failure and restart", async () => {
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedSnapshot(opened, workspaceA.workspace_id, "snapshot");
      const catalogRoot = await storage.cas.put(new TextEncoder().encode("catalog-root"));
      const garbage = await storage.cas.put(new TextEncoder().encode("gc-garbage"));
      await storage.catalog.database.run("INSERT INTO installation_gc_roots (root_kind, root_id, content_hash, created_at, root_payload) VALUES (?, ?, ?, ?, ?)", ["recovery", "recovery-1", catalogRoot.content_hash, "2026-08-09T00:00:00.000000000Z", new Uint8Array([1])]);
      const failing = new StorageMaintenance(opened.database, storage.cas, storage.blobs, root, workspaceA.workspace_id, createFaultInjector(["collection.before_mark"]));
      await expect(failing.collect({ epoch_id: "gc-mark-failure", now: "2026-08-09T00:00:00.000000000Z", batch_size: 10 })).rejects.toMatchObject({ code: "storage:fault_injected" });
      expect((await storage.catalog.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM installation_gc_barriers WHERE state IN ('marking', 'sweeping')"))?.count).toBe(0);
      await opened.close();
      await storage.close();
      const restarted = await createDurableStorage({ rootDir: root, inlineThresholdBytes: 8 });
      const reopened = await restarted.openWorkspace(workspaceA.workspace_id);
      await expect(reopened.lifecycle.acquireLease({ retention_lease_id: "after-restart", snapshot_id: "snapshot", holder_type: "query", holder_id: "reader", now: "2026-08-09T00:00:01.000000000Z", idle_expires_at: "2026-08-09T00:01:00.000000000Z", absolute_expires_at: "2026-08-09T00:02:00.000000000Z" })).resolves.toBeDefined();
      const result = await reopened.maintenance.collect({ epoch_id: "gc-mark-failure", now: "2026-08-09T00:00:02.000000000Z", batch_size: 10 });
      expect(result.deleted_hashes).toContain(garbage.content_hash);
      expect(await restarted.cas.has(catalogRoot.content_hash)).toBe(true);
      await reopened.close();
      await restarted.close();
    });
  });

  it("retains active model-pack roots and their transitive CAS closure", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      const asset = await storage.cas.put(new TextEncoder().encode("model-asset"));
      const manifest = await storage.cas.put(encodeCanonical({ assets: [{ content_digest: asset.content_hash }] }), { media_type: "application/urdira-model-pack-manifest" });
      const installation = {
        model_pack_installation_id: "active-model-pack",
        schema_version: 1,
        model_pack_id: "core:test-pack",
        model_pack_version: "1.0.0",
        manifest_digest: manifest.content_hash,
        installed_at: "2026-08-09T00:00:00.000000000Z",
      } as unknown as ModelPackInstallation;
      await storage.catalog.putModelPackInstallation(installation);
      expect((await opened.maintenance.verify()).failures.filter((failure) => failure.component_kind === "source_catalog")).toEqual([]);
      const garbage = await storage.cas.put(new TextEncoder().encode("unrooted"));
      const result = await opened.maintenance.collect({ epoch_id: "model-pack-roots", now: "2026-08-09T00:00:00.000000000Z", batch_size: 20 });
      expect(result.deleted_hashes).toContain(garbage.content_hash);
      expect(await storage.cas.has(manifest.content_hash)).toBe(true);
      expect(await storage.cas.has(asset.content_hash)).toBe(true);
      await opened.close();
    });
  });

  it("rejects backup while a workspace GC epoch is active", async () => {
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await opened.database.run("INSERT INTO garbage_collection_epochs (garbage_collection_epoch_id, workspace_id, state, started_at, retention_root_digest, candidate_object_count, deleted_object_count, epoch_payload) VALUES (?, ?, 'sweeping', ?, ?, 0, 0, ?)", ["active-gc", workspaceA.workspace_id, "2026-08-09T00:00:00.000000000Z", "sha256:0000000000000000000000000000000000000000000000000000000000000000", encodeCanonical({ state: "sweeping" })]);
      await expect(opened.maintenance.createBackup(join(root, "blocked-backup"))).rejects.toMatchObject({ code: "storage:gc_reader_barrier" });
      await opened.close();
    });
  });

  it("clears the global GC barrier after mark publication failure and resumes", async () => {
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      const garbage = await storage.cas.put(new TextEncoder().encode("after-mark-failure"));
      const failing = new StorageMaintenance(opened.database, storage.cas, storage.blobs, root, workspaceA.workspace_id, createFaultInjector(["collection.after_mark"]));
      await expect(failing.collect({ epoch_id: "gc-after-mark-failure", now: "2026-08-09T00:00:00.000000000Z", batch_size: 10 })).rejects.toMatchObject({ code: "storage:fault_injected" });
      expect((await storage.catalog.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM installation_gc_barriers WHERE state IN ('marking', 'sweeping')"))?.count).toBe(0);
      const resumed = await opened.maintenance.collect({ epoch_id: "gc-after-mark-failure", now: "2026-08-09T00:00:01.000000000Z", batch_size: 10 });
      expect(resumed.deleted_hashes).toContain(garbage.content_hash);
      await opened.close();
    });
  });

  it("clears backup barriers after every durable backup fault boundary", async () => {
    for (const boundary of ["backup.before_snapshot", "backup.after_snapshot", "backup.before_publish", "backup.after_publish"] as const) {
      await withStorage(async (root, storage) => {
        await storage.catalog.registerWorkspace(workspaceA);
        const opened = await storage.openWorkspace(workspaceA.workspace_id);
        const blob = await storage.cas.put(new TextEncoder().encode(`backup-${boundary}`));
        await opened.lifecycle.pinCasObject(blob.content_hash);
        const failing = new StorageMaintenance(opened.database, storage.cas, storage.blobs, root, workspaceA.workspace_id, createFaultInjector([boundary]));
        await expect(failing.createBackup(join(root, `backup-${boundary.replaceAll(".", "-")}`))).rejects.toMatchObject({ code: "storage:fault_injected" });
        expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM backup_barriers WHERE state = 'active'"))?.count).toBe(0);
        await opened.close();
      });
    }
  }, 30000);

  it("clears the global GC barrier after sweep failure and resumes after restart", async () => {
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      const garbage = await storage.cas.put(new TextEncoder().encode("sweep-failure"));
      const failing = new StorageMaintenance(opened.database, storage.cas, storage.blobs, root, workspaceA.workspace_id, createFaultInjector(["collection.after_sweep"]));
      await expect(failing.collect({ epoch_id: "gc-sweep-failure", now: "2026-08-09T00:00:00.000000000Z", batch_size: 10 })).rejects.toMatchObject({ code: "storage:fault_injected" });
      expect((await storage.catalog.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM installation_gc_barriers WHERE state IN ('marking', 'sweeping')"))?.count).toBe(0);
      await opened.close();
      await storage.close();
      const restarted = await createDurableStorage({ rootDir: root, inlineThresholdBytes: 8 });
      const reopened = await restarted.openWorkspace(workspaceA.workspace_id);
      expect(await restarted.cas.has(garbage.content_hash)).toBe(false);
      expect((await restarted.catalog.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM installation_gc_barriers WHERE state IN ('marking', 'sweeping')"))?.count).toBe(0);
      await reopened.close();
      await restarted.close();
    });
  });

  it("recovers workspace GC epochs after a child process crash", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase5-gc-crash-"));
    try {
      const childScript = `
        const { createDurableStorage } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "packages/storage/dist/index.js")).href)});
        const storage = await createDurableStorage({ rootDir: ${JSON.stringify(root)}, inlineThresholdBytes: 8 });
        const workspace = ${JSON.stringify(workspaceA)};
        await storage.catalog.registerWorkspace(workspace);
        const opened = await storage.openWorkspace(workspace.workspace_id);
        await opened.database.run("INSERT INTO garbage_collection_epochs (garbage_collection_epoch_id, workspace_id, state, started_at, retention_root_digest, candidate_object_count, deleted_object_count, epoch_payload) VALUES (?, ?, 'sweeping', ?, ?, 0, 0, ?)", ["crashed-gc", workspace.workspace_id, "2026-08-09T00:00:00.000000000Z", "sha256:0000000000000000000000000000000000000000000000000000000000000000", new Uint8Array([1])]);
        await storage.catalog.database.run("UPDATE installation_workspaces SET removed_at = ? WHERE workspace_id = ?", ["2026-08-09T00:00:00.000000000Z", workspace.workspace_id]);
        process.kill(process.pid, "SIGKILL");
      `;
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
        const stderr: Buffer[] = [];
        child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.once("error", reject);
        child.once("exit", (code, signal) => signal === "SIGKILL" || (process.platform === "win32" && code === 1 && signal === null) ? resolve() : reject(new Error(`GC crash child exited with ${code}/${signal}: ${Buffer.concat(stderr).toString()}`)));
      });
      const storage = await createDurableStorage({ rootDir: root, inlineThresholdBytes: 8 });
      const registration = await storage.catalog.database.get<{ database_path: string }>("SELECT database_path FROM installation_workspaces WHERE workspace_id = ?", [workspaceA.workspace_id]);
      if (!registration) throw new Error("removed workspace registration was lost");
      const recoveredDatabase = await openSqliteDatabase({ filename: registration.database_path, read_only: true });
      try { expect((await recoveredDatabase.get<{ state: string }>("SELECT state FROM garbage_collection_epochs WHERE garbage_collection_epoch_id = ?", ["crashed-gc"]))?.state).not.toBe("sweeping"); } finally { await recoveredDatabase.close(); }
      await storage.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30000);

  it("keeps vectors temporal and reads the requested generation", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedOwner(storage, opened, workspaceA.workspace_id, "temporal-vector-artifact", "temporal-vector-v1", "vector one", 1);
      await seedOwner(storage, opened, workspaceA.workspace_id, "temporal-vector-artifact", "temporal-vector-v2", "vector two", 2);
      const first = new Uint8Array([0, 0, 128, 63]);
      const second = new Uint8Array([0, 0, 0, 64]);
      await opened.projections.putVector({ projection_record_id: "temporal-vector", owner_artifact_id: "temporal-vector-artifact", owner_artifact_version_id: "temporal-vector-v1", profile_id: "temporal", executable_binding_id: "binding", dimensions: 1, element_type: "float32", vector: first, valid_from_generation: 1, valid_to_generation: 2 });
      await opened.projections.putVector({ projection_record_id: "temporal-vector", owner_artifact_id: "temporal-vector-artifact", owner_artifact_version_id: "temporal-vector-v2", profile_id: "temporal", executable_binding_id: "binding", dimensions: 1, element_type: "float32", vector: second, valid_from_generation: 2 });
      expect(await opened.projections.readVector("temporal-vector", { generation: 1 })).toEqual(first);
      expect(await opened.projections.readVector("temporal-vector", { generation: 2 })).toEqual(second);
      expect(await opened.projections.readVector("temporal-vector")).toEqual(second);
      expect((await opened.projections.exactVectorSearch(first, { profile_id: "temporal", executable_binding_id: "binding", dimensions: 1, generation: 1 }))[0]).toMatchObject({ projection_record_id: "temporal-vector", vector_digest: digestBytes(first) });
      expect((await opened.projections.exactVectorSearch(second, { profile_id: "temporal", executable_binding_id: "binding", dimensions: 1, generation: 2 }))[0]).toMatchObject({ projection_record_id: "temporal-vector", vector_digest: digestBytes(second) });
      expect((await opened.projections.exactVectorSearch(first, { profile_id: "temporal", executable_binding_id: "binding", dimensions: 1 }))).toHaveLength(1);
      await opened.close();
    });
  });

  it("preserves lease and pin audit rows and expires executions in place", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedSnapshot(opened, workspaceA.workspace_id, "snapshot");
      const lease = await opened.lifecycle.acquireLease({ retention_lease_id: "audit-lease", snapshot_id: "snapshot", holder_type: "query", holder_id: "audit-execution", now: "2026-08-09T00:00:00.000000000Z", idle_expires_at: "2026-08-09T00:01:00.000000000Z", absolute_expires_at: "2026-08-09T00:02:00.000000000Z" });
      await opened.lifecycle.pinSnapshot({ retention_pin_id: "audit-pin", snapshot_id: "snapshot", pin_kind: "manual", reason_code: "test", source_reference: { artifact_id: "artifact", artifact_version_id: "version" }, created_at: "2026-08-09T00:00:00.000000000Z", expires_at: "2026-08-09T00:01:00.000000000Z" });
      await opened.lifecycle.releaseLease(lease.retention_lease_id, "2026-08-09T00:00:30.000000000Z", "manual_release");
      await opened.lifecycle.releasePin("audit-pin", "2026-08-09T00:00:31.000000000Z", "manual_release");
      expect(await opened.lifecycle.getLease(lease.retention_lease_id)).toMatchObject({ released_at: "2026-08-09T00:00:30.000000000Z", release_reason: "manual_release" });
      expect(await opened.lifecycle.getPin("audit-pin")).toMatchObject({ released_at: "2026-08-09T00:00:31.000000000Z", release_reason: "manual_release" });
      const executionLease = await opened.lifecycle.acquireLease({ retention_lease_id: "audit-execution-lease", snapshot_id: "snapshot", holder_type: "query", holder_id: "audit-execution", now: "2026-08-09T00:00:00.000000000Z", idle_expires_at: "2026-08-09T00:01:00.000000000Z", absolute_expires_at: "2026-08-09T00:02:00.000000000Z" });
      await opened.lifecycle.createExecution({ query_execution_id: "audit-execution", workspace_snapshot_ids: ["snapshot"], retention_lease_ids: [executionLease.retention_lease_id], created_at: "2026-08-09T00:00:00.000000000Z", expires_at: "2026-08-09T00:01:00.000000000Z" });
      await opened.lifecycle.appendManifestSegment("audit-execution", "segment", [{ ordinal: 0, value: "retained" }]);
      const segment = await opened.database.get<{ content_digest: string }>("SELECT content_digest FROM query_manifest_segments WHERE query_execution_id = ?", ["audit-execution"]);
      if (!segment) throw new Error("manifest segment was not retained");
      await opened.lifecycle.expireExecutions("2026-08-09T00:02:00.000000000Z");
      expect((await opened.database.get<{ execution_status: string }>("SELECT execution_status FROM query_executions WHERE query_execution_id = ?", ["audit-execution"]))?.execution_status).toBe("expired");
      expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM query_manifest_segments WHERE query_execution_id = ?", ["audit-execution"]))?.count).toBe(0);
      expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM lifecycle_roots WHERE workspace_id = ? AND root_kind = 'query_manifest' AND root_id LIKE ?", [workspaceA.workspace_id, "audit-execution/%"]))?.count).toBe(0);
      await expect(opened.lifecycle.appendManifestSegment("audit-execution", "after-expiry", [{ ordinal: 1, value: "rejected" }])).rejects.toMatchObject({ code: "storage:execution_expired" });
      await expect(opened.lifecycle.hydrateManifest("audit-execution", 0, 1)).rejects.toMatchObject({ code: "storage:execution_expired" });
      await expect(opened.maintenance.collect({ now: "2026-08-09T00:02:01.000000000Z", batch_size: 10 })).resolves.toMatchObject({ deleted_hashes: [segment.content_digest] });
      expect(await storage.cas.has(segment.content_digest)).toBe(false);
      await opened.close();
    });
  });

  it("rebuilds a corrupt lexical projection and manifest segment from retained inputs", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedSnapshot(opened, workspaceA.workspace_id, "snapshot");
      await seedOwner(storage, opened, workspaceA.workspace_id, "repair-artifact", "repair-version", "repair source");
      await opened.projections.putLexicalDocument({ artifact_id: "repair-artifact", artifact_version_id: "repair-version", text: "repair source", valid_from_generation: 1 });
      await opened.database.run("UPDATE lexical_documents SET document_payload = ? WHERE artifact_id = ?", [new Uint8Array([0]), "repair-artifact"]);
      expect((await opened.maintenance.verify()).failures).toEqual(expect.arrayContaining([expect.objectContaining({ component_kind: "lexical", component_id: "repair-artifact/repair-version" })]));
      await expect(opened.maintenance.repair({ component_kind: "lexical", component_id: "repair-artifact/repair-version" })).resolves.toMatchObject({ action: "rebuild_derived_projection" });
      expect(await opened.projections.searchLiteral("repair")).toEqual([expect.objectContaining({ artifact_id: "repair-artifact" })]);
      const repairLease = await opened.lifecycle.acquireLease({ retention_lease_id: "repair-lease", snapshot_id: "snapshot", holder_type: "query", holder_id: "repair-execution", now: "2026-08-09T00:00:00.000000000Z", idle_expires_at: "2026-08-10T00:00:00.000000000Z", absolute_expires_at: "2026-08-11T00:00:00.000000000Z" });
      await opened.lifecycle.createExecution({ query_execution_id: "repair-execution", workspace_snapshot_ids: ["snapshot"], retention_lease_ids: [repairLease.retention_lease_id], created_at: "2026-08-09T00:00:00.000000000Z", expires_at: "2999-01-01T00:00:00.000000000Z" });
      await opened.lifecycle.appendManifestSegment("repair-execution", "segment", [{ ordinal: 0, value: "rebuild" }]);
      await opened.database.run("UPDATE query_manifest_segments SET content_digest = ? WHERE query_execution_id = ?", ["sha256:0000000000000000000000000000000000000000000000000000000000000000", "repair-execution"]);
      expect((await opened.maintenance.verify()).failures).toEqual(expect.arrayContaining([expect.objectContaining({ component_kind: "manifest", component_id: "repair-execution/segment" })]));
      await expect(opened.maintenance.repair({ component_kind: "manifest", component_id: "repair-execution/segment", rebuild_entries: [{ ordinal: 0, value: "rebuild" }] })).resolves.toMatchObject({ action: "rebuild_manifest_segment" });
      expect(await opened.lifecycle.hydrateManifest("repair-execution", 0, 1, "2026-08-09T00:00:01.000000000Z")).toEqual([{ ordinal: 0, value: "rebuild" }]);
      expect((await opened.maintenance.verify()).ok).toBe(true);
      await opened.close();
    });
  });

  it("localizes corruption across typed projections, snapshots, vectors, and manifests", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedOwner(storage, opened, workspaceA.workspace_id, "integrity-artifact", "integrity-version", "integrity source");
      await seedSnapshot(opened, workspaceA.workspace_id, "integrity-snapshot");
      await opened.projections.putGraphEdge({ edge_id: "integrity-edge", source_subject_id: "source", target_subject_id: "target", relation_record_id: "record", relation_kind: "calls", role: "callee", evidence_class: "confirmed", owner_artifact_id: "integrity-artifact", owner_artifact_version_id: "integrity-version", valid_from_generation: 1 });
      await opened.projections.putLexicalDocument({ artifact_id: "integrity-artifact", artifact_version_id: "integrity-version", text: "integrity source", valid_from_generation: 1 });
      await opened.projections.putDependency({ dependency_entry_id: "integrity-dependency", record_id: "record", owner_artifact_id: "integrity-artifact", owner_artifact_version_id: "integrity-version", dependency_artifact_id: "integrity-artifact", dependency_artifact_version_id: "integrity-version", dependency_role: "runtime", producer_id: "producer", producer_version: "1", valid_from_generation: 1 });
      await opened.projections.putMetric({ metric_id: "integrity-metric", projection_record_id: "record", metric_kind: "fan_out", metric_value: 1, owner_artifact_id: "integrity-artifact", owner_artifact_version_id: "integrity-version", valid_from_generation: 1 });
      await opened.projections.putVector({ projection_record_id: "integrity-vector", owner_artifact_id: "integrity-artifact", owner_artifact_version_id: "integrity-version", profile_id: "integrity-profile", executable_binding_id: "integrity-binding", dimensions: 1, element_type: "float32", vector: new Uint8Array([0, 0, 128, 63]), valid_from_generation: 1 });
      const integrityLease = await opened.lifecycle.acquireLease({ retention_lease_id: "integrity-lease", snapshot_id: "integrity-snapshot", holder_type: "query", holder_id: "integrity-execution", now: "2026-08-09T00:00:00.000000000Z", idle_expires_at: "2026-08-10T00:00:00.000000000Z", absolute_expires_at: "2026-08-11T00:00:00.000000000Z" });
      await opened.lifecycle.createExecution({ query_execution_id: "integrity-execution", workspace_snapshot_ids: ["integrity-snapshot"], retention_lease_ids: [integrityLease.retention_lease_id], created_at: "2026-08-09T00:00:00.000000000Z", expires_at: "2999-01-01T00:00:00.000000000Z" });
      await opened.lifecycle.appendManifestSegment("integrity-execution", "segment", [{ ordinal: 0, value: "integrity" }]);
      await opened.repositories.registries.putSnapshot({ registry_snapshot_id: "integrity-registry", registry_contract_version: "1", core_registry_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111", resolution_lock_id: "integrity-lock", namespace_bindings: [], registry_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222" });
      const snapshotPayload = { snapshot_id: "integrity-snapshot", workspace_id: workspaceA.workspace_id, generation: 1, generation_manifest_id: "integrity-manifest", registry_snapshot_id: "integrity-registry", resolution_lock_id: "integrity-lock", configuration_revision_id: "integrity-configuration", source_state_digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333", source_observation_watermarks: "sha256:4444444444444444444444444444444444444444444444444444444444444444", canonical_record_set_digest: "sha256:5555555555555555555555555555555555555555555555555555555555555555", projection_set_digests: "sha256:6666666666666666666666666666666666666666666666666666666666666666", capability_state_digest: "sha256:7777777777777777777777777777777777777777777777777777777777777777", published_at: "2026-08-09T00:00:00.000000000Z", snapshot_digest: "sha256:8888888888888888888888888888888888888888888888888888888888888888" };
      await opened.database.run("INSERT OR IGNORE INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest, snapshot_payload) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [snapshotPayload.snapshot_id, snapshotPayload.workspace_id, snapshotPayload.generation, snapshotPayload.generation_manifest_id, snapshotPayload.registry_snapshot_id, snapshotPayload.resolution_lock_id, snapshotPayload.configuration_revision_id, snapshotPayload.source_state_digest, snapshotPayload.source_observation_watermarks, snapshotPayload.canonical_record_set_digest, snapshotPayload.projection_set_digests, snapshotPayload.capability_state_digest, snapshotPayload.published_at, snapshotPayload.snapshot_digest, encodeCanonical(snapshotPayload)]);

      await opened.database.run("UPDATE graph_edges SET target_subject_id = 'tampered' WHERE workspace_id = ? AND edge_id = ?", [workspaceA.workspace_id, "integrity-edge"]);
      await opened.database.run("DELETE FROM lexical_trigrams WHERE workspace_id = ? AND artifact_id = ?", [workspaceA.workspace_id, "integrity-artifact"]);
      await opened.database.run("UPDATE artifact_dependencies SET producer_id = 'tampered' WHERE workspace_id = ? AND dependency_entry_id = ?", [workspaceA.workspace_id, "integrity-dependency"]);
      await opened.database.run("UPDATE metric_projections SET metric_value = 99 WHERE workspace_id = ? AND metric_id = ?", [workspaceA.workspace_id, "integrity-metric"]);
      await opened.database.run("UPDATE vector_shards SET distance_metric = 'euclidean' WHERE workspace_id = ?", [workspaceA.workspace_id]);
      await opened.database.run("UPDATE query_manifest_segments SET entry_count = 99 WHERE query_execution_id = ?", ["integrity-execution"]);
      await opened.database.run("UPDATE snapshots SET snapshot_digest = 'tampered-snapshot-digest' WHERE workspace_id = ? AND snapshot_id = ?", [workspaceA.workspace_id, "integrity-snapshot"]);

      const report = await opened.maintenance.verify();
      expect(report.ok).toBe(false);
      expect(new Set(report.failures.map((failure) => failure.component_kind))).toEqual(new Set(["graph", "lexical", "dependency", "metric", "vector", "manifest", "snapshot", "registry"]));
      await opened.close();
    });
  });

  it("repairs a corrupt vector from a verified backup source", async () => {
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedOwner(storage, opened, workspaceA.workspace_id, "vector-repair-artifact", "vector-repair-version", "vector repair source");
      await opened.projections.putVector({ projection_record_id: "vector-repair", owner_artifact_id: "vector-repair-artifact", owner_artifact_version_id: "vector-repair-version", profile_id: "repair-profile", executable_binding_id: "repair-binding", dimensions: 1, element_type: "float32", vector: new Uint8Array([0, 0, 128, 63]) });
      const backup = join(root, "vector-repair-backup");
      await opened.maintenance.createBackup(backup);
      await opened.database.run("UPDATE vector_shards SET distance_metric = 'euclidean' WHERE workspace_id = ?", [workspaceA.workspace_id]);
      expect((await opened.maintenance.verify()).failures).toEqual(expect.arrayContaining([expect.objectContaining({ component_kind: "vector" })]));
      await expect(opened.maintenance.repair({ component_kind: "vector", component_id: "vector-repair", backup_directory: backup })).resolves.toMatchObject({ action: "rebuild_derived_projection" });
      expect(await opened.maintenance.verify()).toEqual({ ok: true, failures: [] });
      await opened.close();
    });
  });

  it("repairs a corrupt graph projection from the verified backup row", async () => {
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedOwner(storage, opened, workspaceA.workspace_id, "graph-repair-artifact", "graph-repair-version", "graph repair source");
      await opened.projections.putGraphEdge({ edge_id: "graph-repair", source_subject_id: "source", target_subject_id: "original", relation_record_id: "record", relation_kind: "calls", role: "callee", evidence_class: "confirmed", owner_artifact_id: "graph-repair-artifact", owner_artifact_version_id: "graph-repair-version", valid_from_generation: 1 });
      const backup = join(root, "graph-repair-backup");
      await opened.maintenance.createBackup(backup);
      await opened.database.run("UPDATE graph_edges SET target_subject_id = 'tampered' WHERE workspace_id = ? AND edge_id = ?", [workspaceA.workspace_id, "graph-repair"]);
      expect((await opened.maintenance.verify()).failures).toEqual(expect.arrayContaining([expect.objectContaining({ component_kind: "graph" })]));
      await expect(opened.maintenance.repair({ component_kind: "graph", component_id: "graph-repair@1", backup_directory: backup })).resolves.toMatchObject({ action: "rebuild_derived_projection" });
      expect(await opened.maintenance.verify()).toEqual({ ok: true, failures: [] });
      await opened.close();
    });
  });

  it("rejects migration when a retained table has no lossless adapter", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await opened.database.exec("CREATE TABLE unregistered_migration_table (value TEXT) STRICT");
      await expect(opened.maintenance.migrate(2)).rejects.toMatchObject({ code: "storage:migration_adapter_missing" });
      await opened.close();
    });
  });

  it("rejects migration when shadow projections fail read-only verification", async () => {
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedOwner(storage, opened, workspaceA.workspace_id, "migration-verify-artifact", "migration-verify-version", "migration verify source");
      await opened.projections.putGraphEdge({ edge_id: "migration-verify-edge", source_subject_id: "source", target_subject_id: "target", relation_record_id: "record", relation_kind: "calls", role: "callee", evidence_class: "confirmed", owner_artifact_id: "migration-verify-artifact", owner_artifact_version_id: "migration-verify-version", valid_from_generation: 1 });
      await opened.database.run("UPDATE graph_edges SET edge_payload = ? WHERE workspace_id = ? AND edge_id = ?", [encodeCanonical({ corrupt: true }), workspaceA.workspace_id, "migration-verify-edge"]);
      await expect(opened.maintenance.migrate(2)).rejects.toMatchObject({ code: "storage:migration_projection_recompute_failed" });
      await opened.close();
    });
  });

  it("rebuilds a corrupt snapshot from a verified retained snapshot source", async () => {
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      const repairRegistryDigest = computeDigest("core:registry_snapshot", "core:registry_snapshot_digest", 1, "core:RegistrySnapshotDigestPayload", 1, { registry_snapshot_id: "repair-registry", registry_contract_version: "1", core_registry_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111", resolution_lock_id: "repair-lock", namespace_bindings: [] });
      await opened.repositories.registries.putSnapshot({ registry_snapshot_id: "repair-registry", registry_contract_version: "1", core_registry_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111", resolution_lock_id: "repair-lock", namespace_bindings: [], registry_digest: repairRegistryDigest });
      const snapshot = { snapshot_id: "repair-snapshot", workspace_id: workspaceA.workspace_id, generation: 1, generation_manifest_id: "repair-manifest", registry_snapshot_id: "repair-registry", resolution_lock_id: "repair-lock", configuration_revision_id: "repair-configuration", source_state_digest: "test-source", source_observation_watermarks: "test-watermarks", canonical_record_set_digest: "test-records", projection_set_digests: "test-projections", capability_state_digest: "test-capability", published_at: "2026-08-09T00:00:00.000000000Z", snapshot_digest: "test-snapshot" };
      await opened.database.run("INSERT INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest, snapshot_payload) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [snapshot.snapshot_id, snapshot.workspace_id, snapshot.generation, snapshot.generation_manifest_id, snapshot.registry_snapshot_id, snapshot.resolution_lock_id, snapshot.configuration_revision_id, snapshot.source_state_digest, snapshot.source_observation_watermarks, snapshot.canonical_record_set_digest, snapshot.projection_set_digests, snapshot.capability_state_digest, snapshot.published_at, snapshot.snapshot_digest, encodeCanonical(snapshot)]);
      const backup = join(root, "snapshot-repair-backup");
      await opened.maintenance.createBackup(backup);
      await opened.database.run("UPDATE snapshots SET snapshot_digest = 'tampered' WHERE workspace_id = ? AND snapshot_id = ?", [workspaceA.workspace_id, snapshot.snapshot_id]);
      expect((await opened.maintenance.verify()).failures).toEqual(expect.arrayContaining([expect.objectContaining({ component_kind: "snapshot", component_id: snapshot.snapshot_id })]));
      await expect(opened.maintenance.repair({ component_kind: "snapshot", component_id: snapshot.snapshot_id, backup_directory: backup })).resolves.toMatchObject({ action: "rebuild_queryable_snapshot" });
      expect(await opened.maintenance.verify()).toEqual({ ok: true, failures: [] });
      await opened.close();
    });
  });

  it("reindexes through the generic live-provider repair port and verifies the result", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedOwner(storage, opened, workspaceA.workspace_id, "provider-repair-artifact", "provider-repair-version", "provider repair source");
      await opened.projections.putMetric({ metric_id: "provider-repair-metric", projection_record_id: "record", metric_kind: "fan_out", metric_value: 1, owner_artifact_id: "provider-repair-artifact", owner_artifact_version_id: "provider-repair-version", valid_from_generation: 1 });
      await opened.database.run("UPDATE metric_projections SET metric_value = 99 WHERE workspace_id = ? AND metric_id = ?", [workspaceA.workspace_id, "provider-repair-metric"]);
      let called = false;
      const liveProvider = { reindex: async ({ database }: { database: typeof opened.database }) => { called = true; await database.run("UPDATE metric_projections SET metric_value = 1 WHERE workspace_id = ? AND metric_id = ?", [workspaceA.workspace_id, "provider-repair-metric"]); } };
      await expect(opened.maintenance.repair({ component_kind: "live_provider", component_id: workspaceA.workspace_id, acknowledge_historical_loss: true, live_provider: liveProvider })).resolves.toMatchObject({ action: "reindex_live_provider" });
      expect(called).toBe(true);
      expect(await opened.maintenance.verify()).toEqual({ ok: true, failures: [] });
      await opened.close();
    });
  });

  it("keeps release and expiry audit payloads atomic across retention faults", async () => {
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspaceA);
      const opened = await storage.openWorkspace(workspaceA.workspace_id);
      await seedSnapshot(opened, workspaceA.workspace_id, "snapshot");
      const lease = await opened.lifecycle.acquireLease({ retention_lease_id: "atomic-release-lease", snapshot_id: "snapshot", holder_type: "query", holder_id: "atomic-execution", now: "2026-08-09T00:00:00.000000000Z", idle_expires_at: "2026-08-09T00:01:00.000000000Z", absolute_expires_at: "2026-08-09T00:02:00.000000000Z" });
      const faulted = new WorkspaceLifecycleRepository(opened.database, workspaceA.workspace_id, createFaultInjector(["retention.before_release" as never, "retention.before_expiry_commit" as never]), storage.blobs, root);
      await expect(faulted.releaseLease(lease.retention_lease_id, "2026-08-09T00:00:30.000000000Z", "manual_release")).rejects.toMatchObject({ code: "storage:fault_injected" });
      expect((await opened.database.get<{ released_at: string | null; release_reason: string | null; lease_payload: unknown }>("SELECT released_at, release_reason, lease_payload FROM retention_leases WHERE retention_lease_id = ?", [lease.retention_lease_id]))).toMatchObject({ released_at: null, release_reason: null });
      expect(decodeCanonical((await opened.database.get<{ lease_payload: unknown }>("SELECT lease_payload FROM retention_leases WHERE retention_lease_id = ?", [lease.retention_lease_id]))?.lease_payload as Uint8Array)).not.toHaveProperty("released_at");
      await opened.lifecycle.pinSnapshot({ retention_pin_id: "atomic-release-pin", snapshot_id: "snapshot", pin_kind: "manual", reason_code: "test", source_reference: { artifact_id: "artifact", artifact_version_id: "version" }, created_at: "2026-08-09T00:00:00.000000000Z", expires_at: "2026-08-09T00:01:00.000000000Z" });
      const faultedPin = new WorkspaceLifecycleRepository(opened.database, workspaceA.workspace_id, createFaultInjector(["retention.before_release" as never]), storage.blobs, root);
      await expect(faultedPin.releasePin("atomic-release-pin", "2026-08-09T00:00:31.000000000Z", "manual_release")).rejects.toMatchObject({ code: "storage:fault_injected" });
      expect((await opened.database.get<{ released_at: string | null; release_reason: string | null }>("SELECT released_at, release_reason FROM retention_pins WHERE retention_pin_id = ?", ["atomic-release-pin"]))).toMatchObject({ released_at: null, release_reason: null });
      await opened.lifecycle.createExecution({ query_execution_id: "atomic-execution", workspace_snapshot_ids: ["snapshot"], retention_lease_ids: [lease.retention_lease_id], created_at: "2026-08-09T00:00:00.000000000Z", expires_at: "2026-08-09T00:01:00.000000000Z" });
      await expect(faulted.expireExecutions("2026-08-09T00:02:00.000000000Z")).rejects.toMatchObject({ code: "storage:fault_injected" });
      expect((await opened.database.get<{ execution_status: string }>("SELECT execution_status FROM query_executions WHERE query_execution_id = ?", ["atomic-execution"]))?.execution_status).toBe("ready");
      expect((await opened.database.get<{ released_at: string | null }>("SELECT released_at FROM retention_leases WHERE retention_lease_id = ?", [lease.retention_lease_id]))?.released_at).toBeNull();
      await opened.close();
    });
  });
});
