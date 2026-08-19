import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { digestBytes, encodeCanonical } from "@urdira/canonical";
import { ContentAddressedStore, createDurableStorage, createFaultInjector, openSqliteDatabase, SerializedWriter } from "../packages/storage/src/index.js";
import type { SqliteCommand } from "../packages/storage/src/index.js";
import type {
  ArtifactTombstone,
  ArtifactVersion,
  ContentBlob,
  EntityRecord,
  RegistrySnapshot,
  Snapshot,
  SourceArtifact,
  SourceObservationBatch,
  SourceObservation,
  Workspace,
  WorkspaceCurrentState,
  WorkspaceConfigurationRevision,
  WorkspaceFreshnessCheckpoint,
  PluginResolutionLock,
  ModelPackInstallation,
} from "@urdira/contracts";

async function withStorage(test: (root: string, storage: Awaited<ReturnType<typeof createDurableStorage>>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "urdira-storage-test-"));
  const storage = await createDurableStorage({ rootDir: root, inlineThresholdBytes: 8 });
  try {
    await test(root, storage);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}

const workspace: Workspace = {
  workspace_id: "ws-one",
  canonical_root: "/repositories/one",
  display_root: "/repositories/one",
  source_provider_bindings: [],
  status: "registered",
  registered_at: "2026-08-09T00:00:00.000000000Z",
};

const artifact: SourceArtifact = {
  artifact_id: "art-one",
  workspace_id: workspace.workspace_id,
  normalized_uri: "file:///repositories/one/src/index.ts",
  normalized_path: "src/index.ts",
  display_path: "src/index.ts",
  artifact_kind: "source_file",
};

const artifactVersion: Omit<ArtifactVersion, "valid_to_generation"> = {
  artifact_version_id: "artv-one",
  workspace_id: workspace.workspace_id,
  artifact_id: artifact.artifact_id,
  content_blob_id: "blob-one",
  content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  byte_length: 12,
  encoding: "utf-8",
  language_hint: "typescript",
  analysis_metadata_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  created_from_observation_id: "obs-one",
  valid_from_generation: 1,
};

const observation: SourceObservation = {
  source_observation_id: "obs-one",
  observation_batch_id: "batch-one",
  workspace_id: workspace.workspace_id,
  artifact_id: artifact.artifact_id,
  source_provider_binding_id: "provider-one",
  source_provider: "directory",
  source_provider_version: "1.0.0",
  ordering_domain: "filesystem",
  observation_mode: "full_scan",
  observed_state: "present",
  observed_content_hash: artifactVersion.content_hash,
  observed_metadata_digest: artifactVersion.analysis_metadata_digest,
  provider_event_token: "event-one",
  provider_sequence: "1",
  observed_at: "2026-08-09T00:00:00.000000000Z",
  received_at: "2026-08-09T00:00:00.000000000Z",
};

const observationBatch: SourceObservationBatch = {
  observation_batch_id: "batch-one",
  workspace_id: workspace.workspace_id,
  source_provider_binding_id: "provider-one",
  source_provider: "directory",
  source_provider_version: "1.0.0",
  ordering_domain: "filesystem",
  observation_mode: "full_scan",
  coverage_scopes: "all",
  coverage_completeness: "complete",
  deletion_authority: "authoritative",
  provider_cursor_before: "cursor-before",
  provider_cursor_after: "cursor-after",
  started_at: "2026-08-09T00:00:00.000000000Z",
  completed_at: "2026-08-09T00:00:01.000000000Z",
  observation_count: 1,
  unavailable_count: 0,
  batch_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999",
};

const contentBlob: ContentBlob = {
  content_blob_id: artifactVersion.content_blob_id,
  content_hash: artifactVersion.content_hash,
  byte_length: artifactVersion.byte_length,
  storage_reference: "cas:blob-one",
};

const tombstone: ArtifactTombstone = {
  artifact_tombstone_id: "tombstone-one",
  workspace_id: workspace.workspace_id,
  artifact_id: artifact.artifact_id,
  absence_kind: "deleted",
  absence_reason_code: "provider_deleted",
  last_artifact_version_id: artifactVersion.artifact_version_id,
  valid_from_generation: 2,
  valid_to_generation: 3,
  opening_artifact_change_id: "change-open",
  closing_artifact_change_id: "change-close",
  replacement_artifact_version_id: artifactVersion.artifact_version_id,
  cause_references: "[]",
  lineage_evidence_record_ids: "[]",
};

const { valid_to_generation: _tombstoneEnd, closing_artifact_change_id: _tombstoneClose, replacement_artifact_version_id: _tombstoneReplacement, ...openTombstone } = tombstone;

const record: EntityRecord = {
  record_id: "record-one",
  category: "entity",
  kind: "core:definition",
  universal_kind: "core:definition",
  facets: [],
  schema_version: 1,
  workspace_id: workspace.workspace_id,
  owner_artifact_id: artifact.artifact_id,
  owner_artifact_version_id: artifactVersion.artifact_version_id,
  valid_from_generation: 1,
  producer_id: "test",
  producer_version: "1.0.0",
  analysis_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  analysis_configuration_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  artifact_dependency_digest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  payload: { name: "main", exported: true },
  record_digest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
};

const registrySnapshot: RegistrySnapshot = {
  registry_snapshot_id: "registry-one",
  registry_contract_version: "1",
  core_registry_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  resolution_lock_id: "lock-one",
  namespace_bindings: [],
  registry_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
};

const snapshot: Omit<Snapshot, "parent_snapshot_id"> = {
  snapshot_id: "snapshot-one",
  workspace_id: workspace.workspace_id,
  generation: 1,
  generation_manifest_id: "manifest-one",
  registry_snapshot_id: registrySnapshot.registry_snapshot_id,
  resolution_lock_id: registrySnapshot.resolution_lock_id,
  configuration_revision_id: "configuration-one",
  source_state_digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
  source_observation_watermarks: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
  canonical_record_set_digest: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
  projection_set_digests: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
  capability_state_digest: "sha256:7777777777777777777777777777777777777777777777777777777777777777",
  published_at: "2026-08-09T00:00:01.000000000Z",
  snapshot_digest: "sha256:8888888888888888888888888888888888888888888888888888888888888888",
};

const currentState: WorkspaceCurrentState = {
  workspace_id: workspace.workspace_id,
  current_snapshot_id: snapshot.snapshot_id,
  current_generation: snapshot.generation,
  current_registry_snapshot_id: snapshot.registry_snapshot_id,
  current_resolution_lock_id: snapshot.resolution_lock_id,
  current_configuration_revision_id: snapshot.configuration_revision_id,
  current_freshness_checkpoint_id: "freshness-one",
  state_revision: 1,
  updated_at: snapshot.published_at,
};

const configurationRevision: WorkspaceConfigurationRevision = {
  configuration_revision_id: "configuration-one",
  schema_version: 1,
  workspace_id: workspace.workspace_id,
  effective_configuration_schema_id: "core:configuration",
  effective_configuration_schema_version: 1,
  effective_configuration: new Uint8Array([1, 2, 3]),
  installation_policy_digest: "sha256:1010101010101010101010101010101010101010101010101010101010101010",
  user_policy_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  workspace_file_digest: "sha256:1212121212121212121212121212121212121212121212121212121212121212",
  administrative_override_digest: "sha256:1313131313131313131313131313131313131313131313131313131313131313",
  analysis_configuration_digest: "sha256:1414141414141414141414141414141414141414141414141414141414141414",
  query_configuration_digest: "sha256:1515151515151515151515151515151515151515151515151515151515151515",
  resolved_embedding_binding_digests: [],
  created_at: "2026-08-09T00:00:00.000000000Z",
  reason_code: "initial_registration",
  revision_digest: "sha256:1616161616161616161616161616161616161616161616161616161616161616",
};

const resolutionLock: PluginResolutionLock = {
  resolution_lock_id: "lock-one",
  workspace_id: workspace.workspace_id,
  resolver_version: "1.0.0",
  resolved_plugins: [],
  lock_digest: "sha256:1717171717171717171717171717171717171717171717171717171717171717",
  created_at: "2026-08-09T00:00:00.000000000Z",
};

const freshnessCheckpoint: WorkspaceFreshnessCheckpoint = {
  freshness_checkpoint_id: "freshness-one",
  workspace_id: workspace.workspace_id,
  snapshot_id: snapshot.snapshot_id,
  source_state_digest: snapshot.source_state_digest,
  provider_watermarks: "[]",
  verification_status: "equivalent",
  unavailable_artifact_ids: "[]",
  verified_at: "2026-08-09T00:00:01.000000000Z",
  checkpoint_digest: "sha256:1818181818181818181818181818181818181818181818181818181818181818",
};

const modelPackInstallation = {
  model_pack_installation_id: "installation-one",
  schema_version: 1,
  model_pack_id: "core:generic-code",
  model_pack_version: "1.0.0",
  manifest_digest: "sha256:1919191919191919191919191919191919191919191919191919191919191919",
  installed_at: "2026-08-09T00:00:00.000000000Z",
} as unknown as ModelPackInstallation;

async function seedPublicationControls(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>): Promise<void> {
  await opened.repositories.controlPlane.putConfiguration(configurationRevision);
  await opened.repositories.controlPlane.putResolutionLock(resolutionLock);
  await opened.repositories.controlPlane.put("workspace_freshness_checkpoint", `workspace_freshness_checkpoint:${freshnessCheckpoint.freshness_checkpoint_id}`, freshnessCheckpoint);
}

const nextSnapshot = {
  ...snapshot,
  snapshot_id: "snapshot-two",
  generation: 2,
  parent_snapshot_id: snapshot.snapshot_id,
  generation_manifest_id: "manifest-two",
  source_state_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999",
  snapshot_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const nextCurrentState: WorkspaceCurrentState = {
  ...currentState,
  current_snapshot_id: nextSnapshot.snapshot_id,
  current_generation: nextSnapshot.generation,
  state_revision: 2,
  updated_at: "2026-08-09T00:00:02.000000000Z",
};

describe("Phase 4 durable storage", () => {
  it("prioritizes foreground writes between background projection transactions", async () => {
    const writer = new SerializedWriter();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const first = writer.run(async () => { order.push("background-1"); await held; }, "background");
    const second = writer.run(async () => { order.push("background-2"); }, "background");
    const foreground = writer.run(async () => { order.push("foreground"); }, "foreground");
    release();
    await Promise.all([first, second, foreground]);
    expect(order).toEqual(["background-1", "foreground", "background-2"]);
  });
  it("atomically migrates old candidate manifest and delta tables and enforces their foreign keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-candidate-schema-migration-"));
    const oldStorage = await createDurableStorage({ rootDir: root });
    const candidate = { candidate_generation_id: "candidate-old-schema", workspace_id: workspace.workspace_id, target_registry_snapshot_id: "registry-old", target_configuration_revision_id: "configuration-old", trigger_kind: "test", state: "queued", source_observation_batch_ids: [], created_at: "2026-08-09T00:00:00.000000000Z", issue_ids: [] } as Record<string, unknown>;
    try {
      await oldStorage.catalog.registerWorkspace(workspace);
      const opened = await oldStorage.openWorkspace(workspace.workspace_id);
      await opened.candidates.insert(candidate as never, { source_state_digest: "source", source_observation_batch_ids: [], tuple_digest: "sha256:old" } as never);
      await opened.database.exec(`DROP TABLE candidate_work_manifests; DROP TABLE candidate_fact_deltas;
        CREATE TABLE candidate_work_manifests (work_manifest_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, candidate_generation_id TEXT NOT NULL, supersedes_work_manifest_id TEXT, base_snapshot_id TEXT, invalidation_plan_id TEXT NOT NULL, target_registry_snapshot_id TEXT NOT NULL, target_configuration_revision_id TEXT NOT NULL, work_digest TEXT NOT NULL, work_manifest_payload BLOB NOT NULL, UNIQUE (workspace_id, work_digest));
        CREATE TABLE candidate_fact_deltas (fact_delta_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, candidate_generation_id TEXT NOT NULL, delta_digest TEXT NOT NULL, accepted_at TEXT NOT NULL, delta_payload BLOB NOT NULL, UNIQUE (workspace_id, candidate_generation_id, fact_delta_id));`);
      await opened.database.run("INSERT INTO candidate_work_manifests (work_manifest_id, workspace_id, candidate_generation_id, invalidation_plan_id, target_registry_snapshot_id, target_configuration_revision_id, work_digest, work_manifest_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["manifest-old", workspace.workspace_id, String(candidate["candidate_generation_id"]), "plan", "registry-old", "configuration-old", "digest-manifest-old", new Uint8Array([1])]);
      await opened.database.run("INSERT INTO candidate_fact_deltas (fact_delta_id, workspace_id, candidate_generation_id, delta_digest, accepted_at, delta_payload) VALUES (?, ?, ?, ?, ?, ?)", ["delta-old", workspace.workspace_id, String(candidate["candidate_generation_id"]), "digest-delta-old", "2026-08-09T00:00:00.000000000Z", new Uint8Array([2])]);
      await opened.close();
    } finally { await oldStorage.close(); }

    const databasePath = join(root, "workspaces", "ws-one.sqlite");
    await expect(createDurableStorage({ rootDir: root, fault_injector: createFaultInjector(["migration.candidate_fk_rebuild"]) })).rejects.toMatchObject({ code: "storage:fault_injected" });
    const beforeRecovery = await openSqliteDatabase({ filename: databasePath });
    expect(await beforeRecovery.all("PRAGMA foreign_key_list(candidate_work_manifests)")).toEqual([]);
    expect(await beforeRecovery.all("PRAGMA foreign_key_list(candidate_fact_deltas)")).toEqual([]);
    await beforeRecovery.close();
    const recoveredStorage = await createDurableStorage({ rootDir: root });
    try {
      const recovered = await recoveredStorage.openWorkspace(workspace.workspace_id);
      expect(await recovered.database.all<{ table: string; from: string; to: string }>("PRAGMA foreign_key_list(candidate_work_manifests)")).toEqual([expect.objectContaining({ table: "candidate_state", from: "candidate_generation_id", to: "candidate_generation_id" })]);
      expect(await recovered.database.all<{ table: string; from: string; to: string }>("PRAGMA foreign_key_list(candidate_fact_deltas)")).toEqual([expect.objectContaining({ table: "candidate_state", from: "candidate_generation_id", to: "candidate_generation_id" })]);
      expect(await recovered.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM candidate_work_manifests WHERE work_manifest_id = 'manifest-old'")).toEqual({ count: 1 });
      expect(await recovered.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM candidate_fact_deltas WHERE fact_delta_id = 'delta-old'")).toEqual({ count: 1 });
      await expect(recovered.database.run("INSERT INTO candidate_fact_deltas (fact_delta_id, workspace_id, candidate_generation_id, delta_digest, accepted_at, delta_payload) VALUES (?, ?, ?, ?, ?, ?)", ["delta-orphan", workspace.workspace_id, "missing-candidate", "digest", "2026-08-09T00:00:00.000000000Z", new Uint8Array([3])])).rejects.toMatchObject({ code: "ERR_SQLITE_ERROR" });
      await recovered.close();
    } finally { await recoveredStorage.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("opens SQLite with durable publication settings and strict tables", async () => {
    await withStorage(async (_root, storage) => {
      const catalog = storage.catalog.database;
      expect((await catalog.get<{ journal_mode: string }>("PRAGMA journal_mode"))?.journal_mode).toBe("wal");
      expect((await catalog.get<{ synchronous: number }>("PRAGMA synchronous"))?.synchronous).toBe(2);
      expect((await catalog.get<{ foreign_keys: number }>("PRAGMA foreign_keys"))?.foreign_keys).toBe(1);
      expect((await catalog.get<{ trusted_schema: number }>("PRAGMA trusted_schema"))?.trusted_schema).toBe(0);
      const schema = await catalog.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'installation_workspaces'");
      expect(schema?.sql).toMatch(/STRICT/i);
      expect(storage.sqliteCapabilities.defensive_mode).toBe(true);
    });
  });

  it("keeps workspace databases independently movable and durable across reopen", async () => {
    await withStorage(async (root, storage) => {
      const registered = await storage.catalog.registerWorkspace(workspace, join(root, "moved", "workspace.sqlite"));
      const first = await storage.openWorkspace(registered.workspace_id);
      await first.repositories.sourceCatalog.putArtifact(artifact);
      await first.repositories.sourceCatalog.putContentBlob(contentBlob);
      await first.repositories.sourceCatalog.putObservationBatch(observationBatch);
      await first.repositories.sourceCatalog.putObservation(observation);
      await first.repositories.sourceCatalog.putArtifactVersion(artifactVersion);
      await first.close();
      await storage.catalog.relocateWorkspace(workspace.workspace_id, join(root, "relocated", "workspace.sqlite"));
      const reopened = await storage.openWorkspace(workspace.workspace_id);
      expect(await reopened.repositories.sourceCatalog.getArtifact(artifact.artifact_id)).toEqual(artifact);
      expect(await reopened.repositories.sourceCatalog.getArtifactVersion(artifactVersion.artifact_version_id)).toEqual(artifactVersion);
      expect(await reopened.repositories.sourceCatalog.getObservation(observation.source_observation_id)).toEqual(observation);
      expect(await readFile(join(root, "relocated", "workspace.sqlite"))).toBeTruthy();
      await reopened.close();
    });
  });

  it("stores immutable CAS bytes and rejects a digest collision", async () => {
    await withStorage(async (_root, storage) => {
      const first = await storage.cas.put(new TextEncoder().encode("same bytes"), { media_type: "text/plain" });
      expect(first.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(await storage.cas.read(first.content_hash)).toEqual(new TextEncoder().encode("same bytes"));
      await expect(storage.cas.put(new TextEncoder().encode("different bytes"), { content_hash: first.content_hash })).rejects.toMatchObject({ code: "storage:cas_collision" });
    });
  });

  it("uses inline storage below the configured threshold and CAS above it", async () => {
    await withStorage(async (_root, storage) => {
      const inline = await storage.blobs.place(new Uint8Array([1, 2, 3]));
      const external = await storage.blobs.place(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
      expect(inline.storage).toBe("inline");
      expect(external.storage).toBe("cas");
      expect(await storage.blobs.read(inline)).toEqual(new Uint8Array([1, 2, 3]));
      expect(await storage.blobs.read(external)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    });
  });

  it("round-trips typed repositories and publishes a current snapshot atomically", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.sourceCatalog.putArtifact(artifact);
      await opened.repositories.sourceCatalog.putContentBlob(contentBlob);
      await opened.repositories.sourceCatalog.putObservationBatch(observationBatch);
      await opened.repositories.sourceCatalog.putObservation(observation);
      await opened.repositories.sourceCatalog.putArtifactVersion(artifactVersion);
      await opened.repositories.canonicalOccurrences.put(record);
      await opened.repositories.registries.putSnapshot(registrySnapshot);
      await seedPublicationControls(opened);
      await opened.publish({ snapshot, current_state: currentState });
      expect(await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM candidate_publication_journal"))?.toEqual({ count: 0 });
      expect(await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM generation_manifests"))?.toEqual({ count: 0 });
      expect(await opened.repositories.canonicalOccurrences.get(record.record_id)).toEqual(record);
      expect(await opened.repositories.registries.getSnapshot(registrySnapshot.registry_snapshot_id)).toEqual(registrySnapshot);
      expect(await opened.repositories.snapshots.get(snapshot.snapshot_id)).toEqual(snapshot);
      expect(await opened.repositories.snapshots.getCurrent()).toEqual(currentState);
      await expect(opened.publish({ snapshot: { ...snapshot, snapshot_id: "bad", generation: 3 }, current_state: { ...currentState, current_snapshot_id: "bad", current_generation: 3, state_revision: 2 } })).rejects.toMatchObject({ code: "storage:publication_invalid" });
      await opened.close();
    });
  });

  it("currentlyVisible resolves each record's identity assignment via an indexed lookup, not a workspace-wide scan", async () => {
    // Regression test for a real production incident: `currentlyVisible`
    // (used by every rescan to fetch `base_records` for candidate
    // materialization) joins `record_occurrences` to `identity_assignments`
    // by `(workspace_id, record_id)`, plus a correlated `MAX(...)` subquery
    // filtering the same pair. Without an index on `identity_assignments`
    // that has `record_id` as a searchable column, SQLite has no way to
    // satisfy either lookup except a full scan of every `identity_assignments`
    // row for the workspace, once per `record_occurrences` row -- an
    // O(records * assignments) nested-loop scan. On a workspace whose tables
    // have accumulated real size (tens of thousands of records, e.g. after a
    // few full scans of a real repository that were never garbage-collected),
    // this made every rescan effectively never return: a single SQLite call
    // pinning one CPU core doing native work, with small/flat process RSS
    // since nothing is materialized into the JS heap -- indistinguishable
    // from a hung/looping process from the outside (see this change's final
    // report for a reproduction and CPU profile). `identity_assignments_record_idx`
    // (packages/storage/src/schema.ts) fixes the query plan; this test
    // exercises both correctness of the join and, via EXPLAIN QUERY PLAN,
    // that the identity_assignments lookups stay index-driven so this class
    // of regression fails loudly instead of only showing up as a mysterious
    // hang at scale.
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.sourceCatalog.putArtifact(artifact);
      await opened.repositories.sourceCatalog.putContentBlob(contentBlob);
      await opened.repositories.sourceCatalog.putObservationBatch(observationBatch);
      await opened.repositories.sourceCatalog.putObservation(observation);
      await opened.repositories.sourceCatalog.putArtifactVersion(artifactVersion);

      const recordIds = ["record-a", "record-b", "record-c"];
      for (const recordId of recordIds) {
        await opened.repositories.canonicalOccurrences.put({ ...record, record_id: recordId, record_digest: `sha256:digest-${recordId}` });
        await opened.database.run(
          `INSERT INTO identity_assignments (identity_assignment_id, workspace_id, identity_type, identity_id, assignment_kind, identity_key, identity_key_digest, record_id, previous_record_id, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation, assignment_payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [`assignment-${recordId}`, workspace.workspace_id, "entity", `identity-${recordId}`, "created", `key-${recordId}`, `key-digest-${recordId}`, recordId, null, artifact.artifact_id, artifactVersion.artifact_version_id, 1, null, new Uint8Array([1])],
        );
      }

      const visible = await opened.repositories.canonicalOccurrences.currentlyVisible(1);
      expect(visible.map((row) => row.record_id).sort()).toEqual(recordIds);
      for (const row of visible) {
        expect(row.identity_type).toBe("entity");
        expect(row.identity_id).toBe(`identity-${row.record_id}`);
        expect(row.identity_key).toBe(`key-${row.record_id}`);
      }

      const plan = await opened.database.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT r.record_id, r.record_digest, r.workspace_id, r.owner_artifact_id, r.owner_artifact_version_id,
                r.category, r.kind, r.universal_kind, r.valid_from_generation,
                ia.identity_type, ia.identity_id, ia.identity_key
         FROM record_occurrences r
         LEFT JOIN identity_assignments ia ON ia.workspace_id = r.workspace_id AND ia.record_id = r.record_id
           AND ia.valid_from_generation = (
             SELECT MAX(ia2.valid_from_generation) FROM identity_assignments ia2
             WHERE ia2.workspace_id = r.workspace_id AND ia2.record_id = r.record_id
               AND ia2.valid_from_generation <= ? AND (ia2.valid_to_generation IS NULL OR ia2.valid_to_generation > ?)
           )
         WHERE r.workspace_id = ? AND r.valid_from_generation <= ? AND (r.valid_to_generation IS NULL OR r.valid_to_generation > ?)
         ORDER BY r.record_id`,
        [1, 1, workspace.workspace_id, 1, 1],
      );
      const identityAssignmentPlanRows = plan.filter((row) => row.detail.includes("identity_assignments") || row.detail.includes(" ia ") || row.detail.includes(" ia2 "));
      expect(identityAssignmentPlanRows.length).toBeGreaterThan(0);
      for (const row of identityAssignmentPlanRows) expect(row.detail).toMatch(/record_id/);

      await opened.close();
    });
  });

  // Regression/characterization test for the `prior_state` scan-bucket diet:
  // `currentlyVisibleForOwners` (`CanonicalOccurrenceRepository`,
  // `packages/storage/src/repositories.ts`) exists so `runFullWorkspaceScan`
  // (`packages/engine/src/workspace-indexing-session.ts`) can load only the
  // `base_records` a candidate seal's `matchingBaseRecords` filter would
  // actually keep, instead of a workspace's entire visible-record set on
  // every scan. This proves it returns EXACTLY what `currentlyVisible(gen)`
  // filtered by owner in JS would, ordering included, at a scale (620 owners,
  // one record each) that forces the `owner_artifact_id IN (...)` predicate
  // across more than one 500-id chunk -- so a caller passing a large,
  // scrambled owner-id list can't silently lose or duplicate rows at a chunk
  // boundary.
  it("currentlyVisibleForOwners matches currentlyVisible filtered by owner in JS, including >500-owner chunking", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);

      const ownerCount = 620;
      async function* seedCommands(): AsyncGenerator<SqliteCommand> {
        yield {
          kind: "run",
          sql: `INSERT INTO source_observation_batches (observation_batch_id, workspace_id, source_provider_binding_id, source_provider, source_provider_version,
            ordering_domain, observation_mode, coverage_scopes, coverage_completeness, deletion_authority, provider_cursor_before, provider_cursor_after,
            started_at, completed_at, observation_count, unavailable_count, batch_digest, observation_batch_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: ["batch:owners", workspace.workspace_id, "provider-one", "directory", "1.0.0", "filesystem", "full_scan", "all", "complete", "authoritative", null, null, "2026-08-09T00:00:00.000000000Z", "2026-08-09T00:00:01.000000000Z", ownerCount, 0, `sha256:${"0".repeat(64)}`, new Uint8Array([1])],
        };
        yield { kind: "run", sql: "INSERT INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)", params: ["blob:shared", `sha256:${"1".repeat(64)}`, 3, "cas:shared"] };
        for (let index = 0; index < ownerCount; index += 1) {
          const ownerId = `owner-${index}`;
          yield { kind: "run", sql: "INSERT INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind, artifact_payload) VALUES (?, ?, ?, ?, ?, ?, ?)", params: [ownerId, workspace.workspace_id, `file:///owner-${index}.ts`, `owner-${index}.ts`, `owner-${index}.ts`, "source_file", new Uint8Array([1])] };
          yield {
            kind: "run",
            sql: `INSERT INTO source_observations (source_observation_id, observation_batch_id, workspace_id, artifact_id, source_provider_binding_id, source_provider,
              source_provider_version, ordering_domain, observation_mode, observed_state, observed_content_hash, observed_metadata_digest, provider_event_token,
              provider_sequence, observed_at, received_at, observation_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [`obs-${index}`, "batch:owners", workspace.workspace_id, ownerId, "provider-one", "directory", "1.0.0", "filesystem", "full_scan", "present", null, null, null, null, "2026-08-09T00:00:00.000000000Z", "2026-08-09T00:00:00.000000000Z", new Uint8Array([1])],
          };
          yield {
            kind: "run",
            sql: `INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint,
              analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation, artifact_version_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [`version-${index}`, workspace.workspace_id, ownerId, "blob:shared", `sha256:${"1".repeat(64)}`, 3, "utf-8", null, `sha256:${"2".repeat(64)}`, `obs-${index}`, 1, null, new Uint8Array([1])],
          };
          yield {
            kind: "run",
            sql: `INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, owner_artifact_id, owner_artifact_version_id, schema_version,
              producer_id, producer_version, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte,
              primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, valid_to_generation, record_digest, payload_digest,
              payload_byte_length, payload_inline, payload_cas_digest, record_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [`record-${index}`, workspace.workspace_id, "entity", "core:definition", "core:definition", ownerId, `version-${index}`, 1, "test", "1.0.0", null, null, null, null, null, 1, null, `sha256:digest-${index}`, `sha256:payload-${index}`, 1, new Uint8Array([9]), null, new Uint8Array([1])],
          };
          yield {
            kind: "run",
            sql: `INSERT INTO identity_assignments (identity_assignment_id, workspace_id, identity_type, identity_id, assignment_kind, identity_key, identity_key_digest,
              record_id, previous_record_id, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation, assignment_payload)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [`assignment-${index}`, workspace.workspace_id, "entity", `identity-${index}`, "created", `key-${index}`, digestBytes(encodeCanonical(`key-${index}`)), `record-${index}`, null, ownerId, `version-${index}`, 1, null, new Uint8Array([1])],
          };
        }
      }
      await opened.database.transactionChunked(seedCommands(), 500);

      const allVisible = await opened.repositories.canonicalOccurrences.currentlyVisible(1);
      expect(allVisible).toHaveLength(ownerCount);
      for (const row of allVisible) expect(row.identity_id).toBe(`identity-${row.owner_artifact_id.slice("owner-".length)}`);

      // A non-contiguous, order-scrambled owner subset spanning both chunks,
      // so the assertion cannot pass by accident of chunk-boundary alignment.
      const selectedOwnerIds = allVisible.filter((_row, index) => index % 3 === 0).map((row) => row.owner_artifact_id);
      expect(selectedOwnerIds.length).toBeGreaterThan(200);
      const scrambledOwnerIds = [...selectedOwnerIds].reverse();

      const narrowed = await opened.repositories.canonicalOccurrences.currentlyVisibleForOwners(1, scrambledOwnerIds);
      const selectedOwnerIdSet = new Set(selectedOwnerIds);
      const expected = allVisible.filter((row) => selectedOwnerIdSet.has(row.owner_artifact_id));
      expect(narrowed).toEqual(expected);
      expect(narrowed.map((row) => row.record_id)).toEqual([...narrowed.map((row) => row.record_id)].sort());

      // A caller-supplied owner id that duplicates within the list, or that
      // never occurs in the table, changes nothing about the result.
      const withDuplicatesAndUnknown = [...scrambledOwnerIds, ...scrambledOwnerIds.slice(0, 5), "owner-does-not-exist"];
      expect(await opened.repositories.canonicalOccurrences.currentlyVisibleForOwners(1, withDuplicatesAndUnknown)).toEqual(expected);

      expect(await opened.repositories.canonicalOccurrences.currentlyVisibleForOwners(1, [])).toEqual([]);

      const byIdentity = await opened.repositories.canonicalOccurrences.currentlyVisibleForIdentityKeys(1, allVisible.flatMap((row) => row.identity_type === undefined ? [] : [{ identity_type: row.identity_type, identity_key: row.identity_key! }]));
      expect(byIdentity).toEqual(allVisible);

      await opened.close();
    });
  }, 60_000);

  // `WorkspaceSourceIndexRepository.currentOccurrencesSlim`/`currentAbsencesSlim`
  // (`packages/storage/src/source-index.ts`) run the same joins/predicates/
  // ordering as `currentOccurrences`/`currentAbsences` but read typed
  // columns instead of canonically decoding the artifact/version/tombstone
  // payload -- this proves the two variants agree on every field the slim
  // one carries, so the perf-only rewrite didn't quietly change what a
  // caller (e.g. `runFullWorkspaceScan`, `packages/engine/src/workspace-indexing-session.ts`)
  // sees.
  it("slim source-index reads agree with the fat ones on every shared field", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.sourceCatalog.putArtifact(artifact);
      await opened.repositories.sourceCatalog.putContentBlob(contentBlob);
      await opened.repositories.sourceCatalog.putObservationBatch(observationBatch);
      await opened.repositories.sourceCatalog.putObservation(observation);
      await opened.repositories.sourceCatalog.putArtifactVersion(artifactVersion);
      await opened.repositories.sourceCatalog.putTombstone(openTombstone);

      const fatOccurrences = await opened.sourceIndex.currentOccurrences(observation.source_provider_binding_id);
      const slimOccurrences = await opened.sourceIndex.currentOccurrencesSlim(observation.source_provider_binding_id);
      expect(fatOccurrences).toHaveLength(1);
      expect(slimOccurrences).toHaveLength(1);
      expect(slimOccurrences[0]!.artifact).toEqual(fatOccurrences[0]!.artifact);
      expect(slimOccurrences[0]!.version).toEqual({
        artifact_version_id: fatOccurrences[0]!.version.artifact_version_id,
        content_blob_id: fatOccurrences[0]!.version.content_blob_id,
        content_hash: fatOccurrences[0]!.version.content_hash,
        byte_length: fatOccurrences[0]!.version.byte_length,
        encoding: fatOccurrences[0]!.version.encoding,
        language_hint: fatOccurrences[0]!.version.language_hint,
        analysis_metadata_digest: fatOccurrences[0]!.version.analysis_metadata_digest,
        created_from_observation_id: fatOccurrences[0]!.version.created_from_observation_id,
      });

      const fatAbsences = await opened.sourceIndex.currentAbsences(observation.source_provider_binding_id);
      const slimAbsences = await opened.sourceIndex.currentAbsencesSlim(observation.source_provider_binding_id);
      expect(fatAbsences).toHaveLength(1);
      expect(slimAbsences).toHaveLength(1);
      expect(slimAbsences[0]).toEqual({
        artifact: { artifact_id: fatAbsences[0]!.artifact.artifact_id, normalized_uri: fatAbsences[0]!.artifact.normalized_uri },
        tombstone: { artifact_tombstone_id: fatAbsences[0]!.tombstone.artifact_tombstone_id, absence_kind: fatAbsences[0]!.tombstone.absence_kind },
      });

      await opened.close();
    });
  });

  // `WorkspaceProjectionOccurrenceRepository.currentlyVisibleForOwnersSlim`
  // (`packages/storage/src/projection-occurrences.ts`) is `currentlyVisible`
  // narrowed by owner AND without a `projection_payload` decode -- this
  // proves it agrees with the fat method on every field it carries (for a
  // narrowed owner subset) and never carries `payload` at all.
  it("currentlyVisibleForOwnersSlim narrows projections by owner and never decodes their payload", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      const owners = ["owner-a", "owner-b", "owner-c"];
      for (const [index, owner] of owners.entries()) {
        await opened.projectionOccurrences.put({
          projection_record_id: `projection-${owner}`,
          projection_kind: "generic",
          projection_key: `key-${owner}`,
          workspace_id: workspace.workspace_id,
          owner_artifact_id: owner,
          owner_artifact_version_id: `version-${owner}`,
          source_artifact_version_ids: [`version-${owner}`],
          source_record_ids: [],
          source_projection_record_ids: [],
          generator: "generator",
          generator_version: "1",
          generator_configuration_digest: `sha256:${"3".repeat(64)}`,
          valid_from_generation: 1,
          payload: { value: index },
        });
      }

      const fat = await opened.projectionOccurrences.currentlyVisible(1);
      expect(fat).toHaveLength(3);

      const narrowed = await opened.projectionOccurrences.currentlyVisibleForOwnersSlim(1, ["owner-c", "owner-a", "owner-a"]);
      expect(narrowed.map((row) => row.projection_record_id)).toEqual(["projection-owner-a", "projection-owner-c"]);
      for (const row of narrowed) {
        const matchingFat = fat.find((entry) => entry.projection_record_id === row.projection_record_id)!;
        expect(row).toEqual({
          projection_record_id: matchingFat.projection_record_id,
          projection_kind: matchingFat.projection_kind,
          projection_key: matchingFat.projection_key,
          owner_artifact_id: matchingFat.owner_artifact_id,
          owner_artifact_version_id: matchingFat.owner_artifact_version_id,
          content_digest: matchingFat.content_digest,
          source_artifact_version_ids: matchingFat.source_artifact_version_ids,
          source_record_ids: matchingFat.source_record_ids,
          source_projection_record_ids: matchingFat.source_projection_record_ids,
          generator: matchingFat.generator,
          generator_version: matchingFat.generator_version,
          generator_configuration_digest: matchingFat.generator_configuration_digest,
        });
        expect(row).not.toHaveProperty("payload");
      }
      expect(await opened.projectionOccurrences.currentlyVisibleForOwnersSlim(1, [])).toEqual([]);

      await opened.close();
    });
  });

  it("serializes concurrent writes within one workspace", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await Promise.all(Array.from({ length: 20 }, (_, index) => opened.repositories.controlPlane.put("test_state", `state-${index}`, { index })));
      const rows = await opened.database.all<{ state_key: string }>("SELECT state_key FROM control_plane_state ORDER BY state_key");
      expect(rows.map((row) => row.state_key)).toHaveLength(20);
      await opened.close();
    });
  });

  it("rolls back all commands after a mid-transaction failure", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await expect(opened.database.transaction([
        { kind: "run", sql: "INSERT INTO workspace_meta (key, value) VALUES (?, ?)", params: ["rollback-marker", new Uint8Array([1])] },
        { kind: "run", sql: "INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation, artifact_version_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", params: ["bad-version", workspace.workspace_id, "missing-artifact", "missing-blob", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1, "utf-8", null, "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", null, 1, null, new Uint8Array([1])] },
      ])).rejects.toMatchObject({ code: "ERR_SQLITE_ERROR" });
      expect(await opened.database.get("SELECT key FROM workspace_meta WHERE key = ?", ["rollback-marker"])).toBeUndefined();
      await opened.close();
    });
  });

  it("commits a chunked transaction spanning multiple worker round-trips", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      async function* commands() {
        for (let index = 0; index < 5; index += 1) {
          yield { kind: "run" as const, sql: "INSERT INTO workspace_meta (key, value) VALUES (?, ?)", params: [`chunked-commit-${index}`, new Uint8Array([index])] };
        }
      }
      // chunkSize 1 forces every command into its own worker `postMessage`
      // (`batch_chunk`), so this exercises the multi-round-trip path even
      // though `commitInternal`/`publishCandidateSerialized` default to 2000.
      await opened.database.transactionChunked(commands(), 1);
      const rows = await opened.database.all<{ key: string }>("SELECT key FROM workspace_meta WHERE key LIKE 'chunked-commit-%' ORDER BY key");
      expect(rows.map((row) => row.key)).toEqual(["chunked-commit-0", "chunked-commit-1", "chunked-commit-2", "chunked-commit-3", "chunked-commit-4"]);
      await opened.close();
    });
  });

  it("commits a chunked transaction with transfer_params enabled, and a later un-opted call still works", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      // Fresh, whole (byteOffset 0, fully covering their own buffer)
      // `Uint8Array` params, spread across multiple chunks (chunkSize 2 over
      // 5 commands) so this exercises transfer across more than one
      // `batch_chunk` `postMessage` round trip, not just a single message.
      async function* commands() {
        for (let index = 0; index < 5; index += 1) {
          yield { kind: "run" as const, sql: "INSERT INTO workspace_meta (key, value) VALUES (?, ?)", params: [`transfer-commit-${index}`, new Uint8Array([index, index + 1, index + 2])] };
        }
      }
      await opened.database.transactionChunked(commands(), 2, { transfer_params: true });
      const rows = await opened.database.all<{ key: string; value: Uint8Array }>("SELECT key, value FROM workspace_meta WHERE key LIKE 'transfer-commit-%' ORDER BY key");
      expect(rows.map((row) => row.key)).toEqual(["transfer-commit-0", "transfer-commit-1", "transfer-commit-2", "transfer-commit-3", "transfer-commit-4"]);
      rows.forEach((row, index) => expect(new Uint8Array(row.value)).toEqual(new Uint8Array([index, index + 1, index + 2])));
      // Regression: a later call that does NOT opt in still structured-clones
      // (rather than transfers) its params and commits correctly -- the
      // option existing does not change default behavior.
      async function* moreCommands() {
        yield { kind: "run" as const, sql: "INSERT INTO workspace_meta (key, value) VALUES (?, ?)", params: ["transfer-regression", new Uint8Array([9, 9, 9])] };
      }
      await opened.database.transactionChunked(moreCommands(), 1);
      const regressionRow = await opened.database.get<{ value: Uint8Array }>("SELECT value FROM workspace_meta WHERE key = ?", ["transfer-regression"]);
      expect(new Uint8Array(regressionRow!.value)).toEqual(new Uint8Array([9, 9, 9]));
      await opened.close();
    });
  });

  it("dedups repeated SQL text across a chunk mixing several distinct statements with checkpoint/assert commands, matching the non-chunked transaction path", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      // Three distinct SQL strings (INSERT, UPDATE, SELECT via "all"), each
      // repeated across several commands -- exercising the worker's `sqls`
      // dedup table -- interleaved with `transaction_checkpoint` /
      // `assert_transaction_changes` commands (which never carry `sql` and
      // must pass through untouched).
      // `transaction_checkpoint` RESETS the worker's change counter (it does
      // not snapshot it), so the correct pattern -- matching
      // `checkedPublicationCommand` elsewhere in this package -- is
      // checkpoint FIRST, then the commands whose change count it's
      // measuring, then the assert that checks the count accumulated SINCE
      // that checkpoint.
      function buildCommands(prefix: string): SqliteCommand[] {
        const commands: SqliteCommand[] = [];
        commands.push({ kind: "transaction_checkpoint" });
        for (let index = 0; index < 6; index += 1) {
          commands.push({ kind: "run", sql: "INSERT INTO workspace_meta (key, value) VALUES (?, ?)", params: [`${prefix}-insert-${index}`, new Uint8Array([index])] });
        }
        commands.push({ kind: "assert_transaction_changes", expected: 6 });
        commands.push({ kind: "transaction_checkpoint" });
        for (let index = 0; index < 3; index += 1) {
          commands.push({ kind: "run", sql: "UPDATE workspace_meta SET value = ? WHERE key = ?", params: [new Uint8Array([index + 100]), `${prefix}-insert-${index}`] });
        }
        commands.push({ kind: "assert_transaction_changes", expected: 3 });
        for (let index = 0; index < 6; index += 1) {
          commands.push({ kind: "all", sql: "SELECT value FROM workspace_meta WHERE key = ?", params: [`${prefix}-insert-${index}`] });
        }
        return commands;
      }
      const chunkedCommands = buildCommands("chunked-dedup");
      // chunkSize 4 splits these 21 commands across multiple `batch_chunk`
      // messages, so a command and the checkpoint/assert commands bracketing
      // it can land in different chunks (and different per-chunk `sqls`
      // dedup tables) -- proving checkpoint state still survives across
      // chunk boundaries with the dedup wire format, exactly as it did
      // before.
      const chunkedResults = await opened.database.transactionChunked((async function* (): AsyncGenerator<SqliteCommand> { for (const command of chunkedCommands) yield command; })(), 4);
      const nonChunkedCommands = buildCommands("nonchunked-dedup");
      const nonChunkedResults = await opened.database.transaction(nonChunkedCommands);
      const chunkedRows = await opened.database.all<{ key: string; value: Uint8Array }>("SELECT key, value FROM workspace_meta WHERE key LIKE 'chunked-dedup-insert-%' ORDER BY key");
      const nonChunkedRows = await opened.database.all<{ key: string; value: Uint8Array }>("SELECT key, value FROM workspace_meta WHERE key LIKE 'nonchunked-dedup-insert-%' ORDER BY key");
      expect(chunkedRows).toHaveLength(6);
      expect(chunkedRows.map((row) => new Uint8Array(row.value))).toEqual(nonChunkedRows.map((row) => new Uint8Array(row.value)));
      // The trailing six `all` ("SELECT ... WHERE key = ?") command results
      // (each an array of one row) must also match byte-for-byte between the
      // chunked (dedup-shape) and non-chunked (inline-`sql`-shape) paths.
      const chunkedSelectResults = chunkedResults.slice(-6) as { readonly value: Uint8Array }[][];
      const nonChunkedSelectResults = nonChunkedResults.slice(-6) as { readonly value: Uint8Array }[][];
      expect(chunkedSelectResults.map((rows) => new Uint8Array(rows[0]!.value))).toEqual(nonChunkedSelectResults.map((rows) => new Uint8Array(rows[0]!.value)));
      await opened.close();
    });
  });

  it("rolls back every already-sent chunk after a mid-transaction failure in a later chunk", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      async function* commands() {
        yield { kind: "run" as const, sql: "INSERT INTO workspace_meta (key, value) VALUES (?, ?)", params: ["chunked-marker-1", new Uint8Array([1])] };
        yield { kind: "run" as const, sql: "INSERT INTO workspace_meta (key, value) VALUES (?, ?)", params: ["chunked-marker-2", new Uint8Array([2])] };
        // Bad SQL, isolated in its own (later) chunk: a foreign-key violation,
        // same shape as the single-message rollback test above.
        yield {
          kind: "run" as const,
          sql: "INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation, artifact_version_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          params: ["bad-chunked-version", workspace.workspace_id, "missing-artifact", "missing-blob", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1, "utf-8", null, "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", null, 1, null, new Uint8Array([1])],
        };
      }
      // chunkSize 1 guarantees the first two INSERTs are each committed to the
      // worker's in-progress transaction (via separate `batch_chunk` messages)
      // before the failing chunk arrives, proving the rollback undoes chunks
      // that already round-tripped successfully, not just the failing one.
      await expect(opened.database.transactionChunked(commands(), 1)).rejects.toMatchObject({ code: "ERR_SQLITE_ERROR" });
      expect(await opened.database.get("SELECT key FROM workspace_meta WHERE key = ?", ["chunked-marker-1"])).toBeUndefined();
      expect(await opened.database.get("SELECT key FROM workspace_meta WHERE key = ?", ["chunked-marker-2"])).toBeUndefined();
      await opened.close();
    });
  });

  it("rolls back every already-sent chunk when assert_transaction_changes fails in a later chunk", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      async function* commands() {
        yield { kind: "run" as const, sql: "INSERT INTO workspace_meta (key, value) VALUES (?, ?)", params: ["chunked-assert-marker", new Uint8Array([3])] };
        // The checkpoint and the assertion each land in their own chunk
        // (chunkSize 1, below), proving the checkpoint's change counter
        // survives across worker round-trips instead of resetting per chunk.
        yield { kind: "transaction_checkpoint" as const };
        yield { kind: "assert_transaction_changes" as const, expected: 5 };
      }
      await expect(opened.database.transactionChunked(commands(), 1)).rejects.toMatchObject({ code: "storage:transaction_assertion_failed" });
      expect(await opened.database.get("SELECT key FROM workspace_meta WHERE key = ?", ["chunked-assert-marker"])).toBeUndefined();
      await opened.close();
    });
  });

  it("appends assert_transaction_changes' optional context to the failure message, on both the chunked and the plain transaction path", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      // `context` lets a caller scope an assertion failure to what it was
      // asserting (e.g. a table plus a row-id range -- multi-row publication
      // batching was prototyped against it and benched perf-neutral, so only
      // the field shipped). Optional and backwards-compatible: an `assert_transaction_changes`
      // command that omits it keeps the exact pre-existing message (covered
      // by the test above); this test covers the field itself, on both
      // execution paths the worker source implements it on
      // (`runChunkCommand`, for `batch_chunk`, and the inline `batch`
      // handler, for the plain non-chunked `transaction()` call).
      async function* chunkedCommands() {
        yield { kind: "transaction_checkpoint" as const };
        yield { kind: "assert_transaction_changes" as const, expected: 1, context: "widgets rows widget:aaa..widget:zzz" };
      }
      await expect(opened.database.transactionChunked(chunkedCommands(), 1)).rejects.toMatchObject({
        code: "storage:transaction_assertion_failed",
        message: expect.stringContaining("widgets rows widget:aaa..widget:zzz"),
      });
      await expect(opened.database.transaction([
        { kind: "transaction_checkpoint" },
        { kind: "assert_transaction_changes", expected: 1, context: "gadgets rows gadget:aaa..gadget:zzz" },
      ])).rejects.toMatchObject({
        code: "storage:transaction_assertion_failed",
        message: expect.stringContaining("gadgets rows gadget:aaa..gadget:zzz"),
      });
      await opened.close();
    });
  });

  it("keeps chunk results in send order under pipelining, including read-your-own-write across chunk boundaries", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      async function* commands(): AsyncGenerator<SqliteCommand> {
        for (let index = 0; index < 6; index += 1) {
          yield { kind: "run", sql: "INSERT INTO workspace_meta (key, value) VALUES (?, ?)", params: [`pipeline-rw-${index}`, new Uint8Array([index])] };
          yield { kind: "all", sql: "SELECT value FROM workspace_meta WHERE key = ?", params: [`pipeline-rw-${index}`] };
        }
      }
      // chunkSize 1 puts each `run`/`all` command in its own `batch_chunk`
      // message (12 chunks total, well past the adapter's 2-in-flight
      // pipeline cap), so a chunk's `all` reading back the immediately
      // preceding chunk's `run` only lines up if both (a) chunks reach the
      // worker in send order and (b) `results` is indexed by that same send
      // order rather than by whichever reply happens to settle first.
      const results = await opened.database.transactionChunked(commands(), 1);
      for (let index = 0; index < 6; index += 1) {
        const selectResult = results[index * 2 + 1] as { readonly value: Uint8Array }[];
        expect(selectResult).toHaveLength(1);
        expect(new Uint8Array(selectResult[0]!.value)).toEqual(new Uint8Array([index]));
      }
      await opened.close();
    });
  });

  it("keeps transaction_checkpoint/assert_transaction_changes correct across many pipelined chunk boundaries", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      async function* commands(): AsyncGenerator<SqliteCommand> {
        yield { kind: "transaction_checkpoint" };
        for (let index = 0; index < 5; index += 1) {
          yield { kind: "run", sql: "INSERT INTO workspace_meta (key, value) VALUES (?, ?)", params: [`pipeline-checkpoint-${index}`, new Uint8Array([index])] };
        }
        yield { kind: "assert_transaction_changes", expected: 5 };
      }
      // chunkSize 1 spreads the checkpoint, all 5 inserts, and the assertion
      // across 7 separate `batch_chunk` messages -- several more than the
      // adapter's 2-in-flight cap -- proving the worker's per-transaction
      // change counter still accumulates correctly across chunk boundaries
      // even while multiple chunks are outstanding at once.
      await opened.database.transactionChunked(commands(), 1);
      const rows = await opened.database.all<{ key: string }>("SELECT key FROM workspace_meta WHERE key LIKE 'pipeline-checkpoint-%' ORDER BY key");
      expect(rows).toHaveLength(5);
      await opened.close();
    });
  });

  it("surfaces the original error from an early pipelined chunk, absorbing later already-pipelined chunks' consequent transaction_not_open failures, with no unhandled rejections", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown): void => { unhandledRejections.push(reason); };
      process.on("unhandledRejection", onUnhandledRejection);
      try {
        async function* commands(): AsyncGenerator<SqliteCommand> {
          yield { kind: "run", sql: "INSERT INTO workspace_meta (key, value) VALUES (?, ?)", params: ["pipeline-fault-0", new Uint8Array([0])] };
          yield { kind: "fault", boundary: "pipelined-chunk-test" };
          yield { kind: "run", sql: "INSERT INTO workspace_meta (key, value) VALUES (?, ?)", params: ["pipeline-fault-2", new Uint8Array([2])] };
          yield { kind: "run", sql: "INSERT INTO workspace_meta (key, value) VALUES (?, ?)", params: ["pipeline-fault-3", new Uint8Array([3])] };
        }
        // chunkSize 1 puts the fault in its own chunk, with the adapter's
        // 2-in-flight cap guaranteeing at least one later chunk is already
        // sent (and, by the time it's drained, has already failed with
        // `storage:transaction_not_open` -- the worker rolled back and
        // cleared `activeTransaction` on the fault) before the caller's
        // promise settles. The caller must see the fault, not that
        // consequent failure.
        await expect(opened.database.transactionChunked(commands(), 1)).rejects.toMatchObject({ code: "storage:fault_injected" });
        expect(await opened.database.get("SELECT key FROM workspace_meta WHERE key = ?", ["pipeline-fault-0"])).toBeUndefined();
        expect(await opened.database.get("SELECT key FROM workspace_meta WHERE key = ?", ["pipeline-fault-2"])).toBeUndefined();
        expect(await opened.database.get("SELECT key FROM workspace_meta WHERE key = ?", ["pipeline-fault-3"])).toBeUndefined();
        // Let any stray unhandled rejection surface before asserting there
        // were none.
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandledRejections).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
        await opened.close();
      }
    });
  });

  it("rejects a second transactionChunked while one is already open on the same worker adapter", async () => {
    // Deliberately bypasses `storage.openWorkspace` / `withStorage`: its
    // `WorkspaceDatabase.database` is a `SerializedSqliteDatabase`
    // (storage.ts), which queues concurrent `transactionChunked` calls at
    // the JS level and only ever lets one reach the worker at a time -- so a
    // second call through that wrapper would simply wait its turn and
    // succeed, never actually exercising the worker's own `batch_open`
    // concurrency guard. Talking to a raw `SqliteWorkerAdapter` (via
    // `openSqliteDatabase`) is the only way to send two concurrent
    // `transactionChunked` calls at the protocol level this test needs.
    const root = await mkdtemp(join(tmpdir(), "urdira-sqlite-guard-"));
    const database = await openSqliteDatabase({ filename: join(root, "guard.sqlite") });
    try {
      await database.exec("CREATE TABLE guard_marker (key TEXT PRIMARY KEY, value BLOB NOT NULL)");
      async function* firstCommands(): AsyncGenerator<SqliteCommand> {
        yield { kind: "run", sql: "INSERT INTO guard_marker (key, value) VALUES (?, ?)", params: ["guard-marker-1", new Uint8Array([1])] };
        yield { kind: "run", sql: "INSERT INTO guard_marker (key, value) VALUES (?, ?)", params: ["guard-marker-2", new Uint8Array([2])] };
      }
      // Both calls' `batch_open` messages post synchronously (the `Promise`
      // executor inside the adapter's `requestWithId` runs before either
      // `await` suspends), and the worker processes its message queue in
      // post order -- so the second is guaranteed to find the first's
      // transaction already open, without needing an artificial delay here.
      const first = database.transactionChunked(firstCommands(), 1);
      await expect(database.transactionChunked([
        { kind: "run", sql: "INSERT INTO guard_marker (key, value) VALUES (?, ?)", params: ["guard-marker-3", new Uint8Array([3])] },
      ], 1)).rejects.toMatchObject({ code: "storage:transaction_already_open" });
      await first;
      const rows = await database.all<{ key: string }>("SELECT key FROM guard_marker ORDER BY key");
      expect(rows.map((row) => row.key)).toEqual(["guard-marker-1", "guard-marker-2"]);
    } finally {
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("commits a discard_results chunked transaction correctly and resolves with an empty result array", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      async function* commands(): AsyncGenerator<SqliteCommand> {
        for (let index = 0; index < 5; index += 1) {
          yield { kind: "run", sql: "INSERT INTO workspace_meta (key, value) VALUES (?, ?)", params: [`discard-commit-${index}`, new Uint8Array([index])] };
        }
      }
      // chunkSize 1 forces every command into its own `batch_chunk` message,
      // exercising the discard-mode worker reply (`{result: n}`, a command
      // count) across multiple round trips, not just a single message.
      const results = await opened.database.transactionChunked(commands(), 1, { discard_results: true });
      expect(results).toEqual([]);
      const rows = await opened.database.all<{ key: string }>("SELECT key FROM workspace_meta WHERE key LIKE 'discard-commit-%' ORDER BY key");
      expect(rows.map((row) => row.key)).toEqual(["discard-commit-0", "discard-commit-1", "discard-commit-2", "discard-commit-3", "discard-commit-4"]);
      await opened.close();
    });
  });

  it("commits the exact same rows under discard_results as the equivalent non-discard call, only the returned result array differs", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      function buildCommands(prefix: string): SqliteCommand[] {
        return Array.from({ length: 6 }, (_, index) => ({
          kind: "run" as const,
          sql: "INSERT INTO workspace_meta (key, value) VALUES (?, ?)",
          params: [`${prefix}-${index}`, new Uint8Array([index, index + 1])] as const,
        }));
      }
      const discardResults = await opened.database.transactionChunked(buildCommands("discard-parity"), 2, { discard_results: true });
      const plainResults = await opened.database.transactionChunked(buildCommands("plain-parity"), 2);
      expect(discardResults).toEqual([]);
      expect(plainResults).toHaveLength(6);
      const discardRows = await opened.database.all<{ key: string; value: Uint8Array }>("SELECT key, value FROM workspace_meta WHERE key LIKE 'discard-parity-%' ORDER BY key");
      const plainRows = await opened.database.all<{ key: string; value: Uint8Array }>("SELECT key, value FROM workspace_meta WHERE key LIKE 'plain-parity-%' ORDER BY key");
      expect(discardRows.map((row) => new Uint8Array(row.value))).toEqual(plainRows.map((row) => new Uint8Array(row.value)));
      await opened.close();
    });
  });

  it("still enforces assert_transaction_changes' expected count under discard_results, and rolls back on mismatch", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      async function* commands(): AsyncGenerator<SqliteCommand> {
        yield { kind: "run", sql: "INSERT INTO workspace_meta (key, value) VALUES (?, ?)", params: ["discard-assert-marker", new Uint8Array([3])] };
        // Checkpoint and assertion land in their own chunks (chunkSize 1),
        // proving the worker's change-counter accumulation (`state.changes`,
        // fed from `execute`'s raw-number return in discard mode) still
        // survives across `batch_chunk` round trips.
        yield { kind: "transaction_checkpoint" };
        yield { kind: "assert_transaction_changes", expected: 5 };
      }
      await expect(opened.database.transactionChunked(commands(), 1, { discard_results: true })).rejects.toMatchObject({ code: "storage:transaction_assertion_failed" });
      expect(await opened.database.get("SELECT key FROM workspace_meta WHERE key = ?", ["discard-assert-marker"])).toBeUndefined();
      await opened.close();
    });
  });

  it("still rolls back every already-sent chunk after fault injection under discard_results", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      async function* commands(): AsyncGenerator<SqliteCommand> {
        yield { kind: "run", sql: "INSERT INTO workspace_meta (key, value) VALUES (?, ?)", params: ["discard-fault-marker", new Uint8Array([1])] };
        yield { kind: "fault", boundary: "discard-results-test" };
      }
      await expect(opened.database.transactionChunked(commands(), 1, { discard_results: true })).rejects.toMatchObject({ code: "storage:fault_injected" });
      expect(await opened.database.get("SELECT key FROM workspace_meta WHERE key = ?", ["discard-fault-marker"])).toBeUndefined();
      await opened.close();
    });
  });

  it("rejects a get or all command under discard_results client-side, before any chunk reaches the worker, and rolls back", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      async function* getCommands(): AsyncGenerator<SqliteCommand> {
        yield { kind: "run", sql: "INSERT INTO workspace_meta (key, value) VALUES (?, ?)", params: ["discard-reject-get-marker", new Uint8Array([1])] };
        yield { kind: "get", sql: "SELECT key FROM workspace_meta WHERE key = ?", params: ["discard-reject-get-marker"] };
      }
      await expect(opened.database.transactionChunked(getCommands(), 1, { discard_results: true })).rejects.toBeInstanceOf(TypeError);
      expect(await opened.database.get("SELECT key FROM workspace_meta WHERE key = ?", ["discard-reject-get-marker"])).toBeUndefined();

      async function* allCommands(): AsyncGenerator<SqliteCommand> {
        yield { kind: "all", sql: "SELECT key FROM workspace_meta" };
      }
      await expect(opened.database.transactionChunked(allCommands(), 1, { discard_results: true })).rejects.toBeInstanceOf(TypeError);
      await opened.close();
    });
  });

  it("serializes publication across independently opened handles", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const first = await storage.openWorkspace(workspace.workspace_id);
      const second = await storage.openWorkspace(workspace.workspace_id);
      await first.repositories.registries.putSnapshot(registrySnapshot);
      await seedPublicationControls(first);
      const results = await Promise.allSettled([
        first.publish({ snapshot, current_state: currentState }),
        second.publish({ snapshot, current_state: currentState }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(await first.repositories.snapshots.getCurrent()).toEqual(currentState);
      await first.close();
      await second.close();
    });
  });

  it("rejects publication tuple mismatches and conflicting snapshot contents", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.registries.putSnapshot(registrySnapshot);
      await seedPublicationControls(opened);
      await expect(opened.publish({ snapshot, current_state: { ...currentState, current_snapshot_id: "other-snapshot" } })).rejects.toMatchObject({ code: "storage:publication_invalid" });
      await opened.repositories.registries.putSnapshot({ ...registrySnapshot, registry_snapshot_id: "registry-bad", resolution_lock_id: "lock-bad", registry_digest: "sha256:abababababababababababababababababababababababababababababababab" });
      await expect(opened.publish({ snapshot: { ...snapshot, registry_snapshot_id: "registry-bad" }, current_state: { ...currentState, current_registry_snapshot_id: "registry-bad" } })).rejects.toMatchObject({ code: "storage:publication_invalid" });
      await opened.publish({ snapshot, current_state: currentState });
      const conflictingSnapshot = { ...snapshot, generation: 2, parent_snapshot_id: snapshot.snapshot_id, snapshot_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
      const conflictingState = { ...currentState, current_snapshot_id: snapshot.snapshot_id, current_generation: 2, state_revision: 2 };
      await expect(opened.publish({ snapshot: conflictingSnapshot, current_state: conflictingState })).rejects.toMatchObject({ code: "storage:publication_conflict" });
      expect(await opened.repositories.snapshots.get(snapshot.snapshot_id)).toEqual(snapshot);
      expect(await opened.repositories.snapshots.getCurrent()).toEqual(currentState);
      await opened.close();
    });
  });

  it("rejects decreasing or equal state revisions without publishing a snapshot", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.registries.putSnapshot(registrySnapshot);
      await seedPublicationControls(opened);
      await opened.publish({ snapshot, current_state: currentState });
      for (const revision of [1, 0]) {
        await expect(opened.publish({ snapshot: nextSnapshot, current_state: { ...nextCurrentState, state_revision: revision } })).rejects.toMatchObject({ code: "storage:publication_invalid" });
        expect(await opened.repositories.snapshots.get(nextSnapshot.snapshot_id)).toBeUndefined();
        expect(await opened.repositories.snapshots.getCurrent()).toEqual(currentState);
      }
      await opened.close();
    });
  });

  it("rolls back a publication when its expected current tuple is stale", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.registries.putSnapshot(registrySnapshot);
      await seedPublicationControls(opened);
      await opened.publish({ snapshot, current_state: currentState });
      await expect(opened.publish({ snapshot: nextSnapshot, current_state: nextCurrentState, expected_current_state: { ...currentState, state_revision: 0 } })).rejects.toMatchObject({ code: "storage:publication_invalid" });
      expect(await opened.repositories.snapshots.get(nextSnapshot.snapshot_id)).toBeUndefined();
      expect(await opened.repositories.snapshots.getCurrent()).toEqual(currentState);
      await opened.close();
    });
  });

  it("retains the same registry binding in multiple snapshots", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      const binding = {
        namespace_binding_id: "binding-one",
        workspace_id: workspace.workspace_id,
        namespace: "namespace-one",
        plugin_id: "plugin-one",
        plugin_version: "1.0.0",
        contribution_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        emission_valid_from_generation: "1",
      };
      await opened.repositories.registries.putSnapshot({ ...registrySnapshot, namespace_bindings: [binding] });
      const retained = { ...registrySnapshot, registry_snapshot_id: "registry-two", registry_digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333", namespace_bindings: [binding] };
      await opened.repositories.registries.putSnapshot(retained);
      expect(await opened.repositories.registries.getSnapshot(retained.registry_snapshot_id)).toEqual(retained);
      await opened.close();
    });
  });

  it("stores observation batches, nullable current versions, tombstones, and content blobs", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.sourceCatalog.putArtifact(artifact);
      await opened.repositories.sourceCatalog.putContentBlob(contentBlob);
      await opened.repositories.sourceCatalog.putObservationBatch(observationBatch);
      await opened.repositories.sourceCatalog.putObservation(observation);
      const openVersion = artifactVersion;
      await opened.repositories.sourceCatalog.putArtifactVersion(openVersion);
      await opened.repositories.sourceCatalog.putTombstone(tombstone);
      expect(await opened.repositories.sourceCatalog.getObservationBatch(observationBatch.observation_batch_id)).toEqual(observationBatch);
      expect(await opened.repositories.sourceCatalog.getArtifactVersion(artifactVersion.artifact_version_id)).toEqual(openVersion);
      expect(await opened.repositories.sourceCatalog.getTombstone(tombstone.artifact_tombstone_id)).toEqual(tombstone);
      expect(await opened.repositories.sourceCatalog.getContentBlob(contentBlob.content_blob_id)).toEqual(contentBlob);
      await opened.close();
    });
  });

  it("enforces typed envelopes and foreign keys", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      const columns = await opened.database.all<{ name: string }>("PRAGMA table_info(record_occurrences)");
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "schema_version", "producer_id", "producer_version", "primary_source_span_artifact_version_id", "primary_source_span_start_byte", "primary_source_span_end_byte",
      ]));
      await expect(opened.database.run("INSERT INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind, artifact_payload) VALUES (?, ?, ?, ?, ?, ?, ?)", ["bad-artifact", workspace.workspace_id, "file:///bad", null, null, new Uint8Array([1]), new Uint8Array([1])])).rejects.toMatchObject({ code: "ERR_SQLITE_ERROR" });
      await expect(opened.database.run("INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation, artifact_version_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ["bad-version", workspace.workspace_id, "missing-artifact", "missing-blob", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1, "utf-8", null, "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", null, 1, null, new Uint8Array([1])])).rejects.toMatchObject({ code: "ERR_SQLITE_ERROR" });
      await opened.repositories.sourceCatalog.putArtifact(artifact);
      await opened.repositories.sourceCatalog.putContentBlob(contentBlob);
      await opened.repositories.sourceCatalog.putObservationBatch(observationBatch);
      await opened.repositories.sourceCatalog.putObservation(observation);
      await opened.repositories.sourceCatalog.putArtifactVersion(artifactVersion);
      await expect(opened.repositories.canonicalOccurrences.put({ ...record, owner_artifact_version_id: "missing-version" })).rejects.toMatchObject({ code: "ERR_SQLITE_ERROR" });
      await opened.close();
    });
  });

  it("surfaces CAS directory fsync failures and detects corruption", async () => {
    await withStorage(async (root, storage) => {
      const failing = new ContentAddressedStore(join(root, "fault-cas"), undefined, { sync_directory: async () => { throw new Error("fsync fault"); } });
      await expect(failing.put(new TextEncoder().encode("durability fault"))).rejects.toMatchObject({ code: "storage:cas_directory_sync_failed" });
      const blob = await storage.cas.put(new TextEncoder().encode("will corrupt"));
      await writeFile(storage.cas.objectPath(blob.content_hash), new TextEncoder().encode("corrupt"));
      await expect(storage.cas.read(blob.content_hash)).rejects.toMatchObject({ code: "storage:cas_corrupt" });
    });
  });

  it("flushes each newly installed CAS file on Windows instead of fsyncing its directory", async () => {
    await withStorage(async (root) => {
      const flushedFiles: string[] = [];
      const cas = new ContentAddressedStore(join(root, "windows-cas"), undefined, {
        platform: "win32",
        sync_directory: async () => { throw new Error("Windows must not use the POSIX directory fsync path"); },
        sync_file: async (path) => { flushedFiles.push(path); },
      });
      const bytes = new TextEncoder().encode("Windows CAS durability");
      const [first, duplicate] = await cas.putMany([{ bytes }, { bytes }]);

      expect(first?.content_hash).toBe(duplicate?.content_hash);
      expect(flushedFiles).toEqual([cas.objectPath(first!.content_hash)]);
    });
  });

  it("coalesces putMany's directory fsyncs: once per directory that received a fresh link, none for already-durable duplicates", async () => {
    await withStorage(async (root) => {
      const syncedDirectories: string[] = [];
      const counted = new ContentAddressedStore(join(root, "counted-cas"), undefined, { sync_directory: async (directory) => { syncedDirectories.push(directory); } });
      const first = new TextEncoder().encode("putMany fresh blob one");
      const second = new TextEncoder().encode("putMany fresh blob two");
      // Five entries: two distinct new blobs, `first` repeated three times
      // (duplicate content within one batch, sharing one destination
      // directory) -- every entry must still resolve to correct, byte-exact
      // content, but the directory hosting `first`'s three copies should be
      // fsync'd only once (its first fresh link), not three times, and the
      // digest-addressed layout means `first`/`second` almost always land in
      // different two-level prefix directories, so two directories total.
      const blobs = await counted.putMany([{ bytes: first }, { bytes: first }, { bytes: second }, { bytes: first }, { bytes: second }]);
      expect(blobs.map((blob) => blob.content_hash)).toEqual([
        blobs[0]?.content_hash, blobs[0]?.content_hash, blobs[2]?.content_hash, blobs[0]?.content_hash, blobs[2]?.content_hash,
      ]);
      expect(new Set(syncedDirectories).size).toBe(syncedDirectories.length); // each synced directory appears at most once
      expect(syncedDirectories.length).toBeLessThanOrEqual(2);
      expect(syncedDirectories.length).toBeGreaterThanOrEqual(1);
      await expect(counted.read(blobs[0]!.content_hash)).resolves.toEqual(first);
      await expect(counted.read(blobs[2]!.content_hash)).resolves.toEqual(second);
      // A second, separate `putMany` call against the same already-durable
      // content must fsync no directories at all: every entry hits EEXIST
      // and is verified, never freshly linked.
      syncedDirectories.length = 0;
      await counted.putMany([{ bytes: first }, { bytes: second }]);
      expect(syncedDirectories).toEqual([]);
    });
  });

  it("allows lifecycle closure only once and never reopens a closed version or tombstone", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.sourceCatalog.putArtifact(artifact);
      await opened.repositories.sourceCatalog.putContentBlob(contentBlob);
      await opened.repositories.sourceCatalog.putObservationBatch(observationBatch);
      await opened.repositories.sourceCatalog.putObservation(observation);
      const openVersion = artifactVersion;
      await opened.repositories.sourceCatalog.putArtifactVersion(openVersion);
      const closedVersion = { ...openVersion, valid_to_generation: 2 };
      await opened.repositories.sourceCatalog.putArtifactVersion(closedVersion);
      await expect(opened.repositories.sourceCatalog.putArtifactVersion(openVersion)).rejects.toMatchObject({ code: "storage:artifact_version_lifecycle" });
      expect(await opened.repositories.sourceCatalog.getArtifactVersion(artifactVersion.artifact_version_id)).toEqual(closedVersion);

      await opened.repositories.sourceCatalog.putTombstone(openTombstone);
      const closedTombstone = { ...openTombstone, valid_to_generation: 3, closing_artifact_change_id: "change-close", replacement_artifact_version_id: artifactVersion.artifact_version_id };
      await opened.repositories.sourceCatalog.putTombstone(closedTombstone);
      await expect(opened.repositories.sourceCatalog.putTombstone(openTombstone)).rejects.toMatchObject({ code: "storage:tombstone_lifecycle" });
      expect(await opened.repositories.sourceCatalog.getTombstone(tombstone.artifact_tombstone_id)).toEqual(closedTombstone);
      await opened.close();
    });
  });

  it("rejects tombstone closure without complete closure and replacement metadata", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.sourceCatalog.putArtifact(artifact);
      await opened.repositories.sourceCatalog.putContentBlob(contentBlob);
      await opened.repositories.sourceCatalog.putObservationBatch(observationBatch);
      await opened.repositories.sourceCatalog.putObservation(observation);
      await opened.repositories.sourceCatalog.putArtifactVersion(artifactVersion);
      await opened.repositories.sourceCatalog.putTombstone(openTombstone);
      await expect(opened.repositories.sourceCatalog.putTombstone({ ...openTombstone, valid_to_generation: 3 })).rejects.toMatchObject({ code: "storage:tombstone_closure_metadata" });
      await expect(opened.repositories.sourceCatalog.putTombstone({ ...openTombstone, valid_to_generation: 3, closing_artifact_change_id: "change-close" })).rejects.toMatchObject({ code: "storage:tombstone_closure_metadata" });
      expect(await opened.repositories.sourceCatalog.getTombstone(openTombstone.artifact_tombstone_id)).toEqual(openTombstone);
      await opened.close();
    });
  });

  it("rejects stale typed projections instead of overwriting only canonical payloads", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.sourceCatalog.putArtifact(artifact);
      await opened.repositories.sourceCatalog.putContentBlob(contentBlob);
      await opened.repositories.sourceCatalog.putObservationBatch(observationBatch);
      await opened.repositories.sourceCatalog.putObservation(observation);
      const openVersion = artifactVersion;
      await opened.repositories.sourceCatalog.putArtifactVersion(openVersion);
      await opened.repositories.sourceCatalog.putTombstone(openTombstone);

      await opened.database.run("UPDATE source_observation_batches SET coverage_scopes = ? WHERE observation_batch_id = ?", ["stale-typed-value", observationBatch.observation_batch_id]);
      await expect(opened.repositories.sourceCatalog.putObservationBatch(observationBatch)).rejects.toMatchObject({ code: "storage:source_observation_batch_immutable" });

      await opened.database.run("UPDATE artifact_versions SET language_hint = ? WHERE artifact_version_id = ?", ["stale-typed-value", artifactVersion.artifact_version_id]);
      await expect(opened.repositories.sourceCatalog.putArtifactVersion(openVersion)).rejects.toMatchObject({ code: "storage:artifact_version_immutable" });

      await opened.database.run("UPDATE artifact_tombstones SET absence_reason_code = ? WHERE artifact_tombstone_id = ?", ["stale-typed-value", tombstone.artifact_tombstone_id]);
      await expect(opened.repositories.sourceCatalog.putTombstone(openTombstone)).rejects.toMatchObject({ code: "storage:tombstone_immutable" });
      await opened.close();
    });
  });

  it("rejects dangling provenance and observation batches from another workspace", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.sourceCatalog.putArtifact(artifact);
      await opened.repositories.sourceCatalog.putContentBlob(contentBlob);
      const { created_from_observation_id: _createdFrom, ...withoutObservation } = artifactVersion;
      await expect(opened.repositories.sourceCatalog.putArtifactVersion({ ...withoutObservation, created_from_observation_id: "missing-observation" })).rejects.toMatchObject({ code: "ERR_SQLITE_ERROR" });
      await opened.repositories.sourceCatalog.putObservationBatch(observationBatch);
      const otherArtifact = { ...artifact, artifact_id: "art-two", workspace_id: "ws-two", normalized_uri: "file:///other" };
      await expect(opened.repositories.sourceCatalog.putArtifact(otherArtifact)).rejects.toMatchObject({ code: "storage:workspace_mismatch" });
      await expect(opened.repositories.sourceCatalog.putObservation({ ...observation, source_observation_id: "obs-two", workspace_id: "ws-two", artifact_id: otherArtifact.artifact_id })).rejects.toMatchObject({ code: "storage:workspace_mismatch" });
      await expect(opened.repositories.sourceCatalog.putObservation({ ...observation, source_observation_id: "obs-provider-mismatch", source_provider: "other-provider" })).rejects.toMatchObject({ code: "storage:observation_batch_mismatch" });
      await expect(opened.repositories.sourceCatalog.putObservation({ ...observation, source_observation_id: "obs-binding-mismatch", source_provider_binding_id: "other-binding" })).rejects.toMatchObject({ code: "storage:observation_batch_mismatch" });
      await opened.close();
    });
  });

  it("enforces workspace ownership for observation, tombstone, and record version references", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.sourceCatalog.putArtifact(artifact);
      await opened.repositories.sourceCatalog.putContentBlob(contentBlob);
      await opened.repositories.sourceCatalog.putObservationBatch(observationBatch);
      await opened.repositories.sourceCatalog.putObservation(observation);
      const otherArtifact = { ...artifact, artifact_id: "art-two", workspace_id: "ws-two", normalized_uri: "file:///other" };
      const otherBlob = { ...contentBlob, content_blob_id: "blob-two", content_hash: "sha256:1212121212121212121212121212121212121212121212121212121212121212" };
      const otherBatch = { ...observationBatch, observation_batch_id: "batch-two", workspace_id: "ws-two", batch_digest: "sha256:1313131313131313131313131313131313131313131313131313131313131313" };
      const otherObservation = { ...observation, source_observation_id: "obs-two", observation_batch_id: otherBatch.observation_batch_id, workspace_id: "ws-two", artifact_id: otherArtifact.artifact_id };
      const otherVersion = { ...artifactVersion, artifact_version_id: "artv-two", workspace_id: "ws-two", artifact_id: otherArtifact.artifact_id, content_blob_id: otherBlob.content_blob_id, content_hash: otherBlob.content_hash, created_from_observation_id: otherObservation.source_observation_id };
      await expect(opened.repositories.sourceCatalog.putArtifact(otherArtifact)).rejects.toMatchObject({ code: "storage:workspace_mismatch" });
      await opened.repositories.sourceCatalog.putContentBlob(otherBlob);
      await expect(opened.repositories.sourceCatalog.putObservationBatch(otherBatch)).rejects.toMatchObject({ code: "storage:workspace_mismatch" });
      await expect(opened.repositories.sourceCatalog.putObservation(otherObservation)).rejects.toMatchObject({ code: "storage:workspace_mismatch" });
      await expect(opened.repositories.sourceCatalog.putArtifactVersion(otherVersion)).rejects.toMatchObject({ code: "storage:workspace_mismatch" });
      await expect(opened.repositories.sourceCatalog.putTombstone({ ...openTombstone, workspace_id: "ws-two", last_artifact_version_id: otherVersion.artifact_version_id })).rejects.toMatchObject({ code: "storage:workspace_mismatch" });
      await expect(opened.repositories.canonicalOccurrences.put({ ...record, workspace_id: "ws-two", owner_artifact_version_id: otherVersion.artifact_version_id })).rejects.toMatchObject({ code: "storage:workspace_mismatch" });
      await opened.close();
    });
  });

  it("rejects rewrites of immutable artifact identities, content blobs, and observations", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.sourceCatalog.putArtifact(artifact);
      await expect(opened.repositories.sourceCatalog.putArtifact({ ...artifact, normalized_uri: "file:///rewritten" })).rejects.toMatchObject({ code: "storage:immutable_artifact" });
      await opened.repositories.sourceCatalog.putContentBlob(contentBlob);
      await expect(opened.repositories.sourceCatalog.putContentBlob({ ...contentBlob, storage_reference: "cas:replaced" })).rejects.toMatchObject({ code: "storage:immutable_content_blob" });
      await opened.repositories.sourceCatalog.putObservationBatch(observationBatch);
      await opened.repositories.sourceCatalog.putObservation(observation);
      await expect(opened.repositories.sourceCatalog.putObservation({ ...observation, observed_state: "deleted" })).rejects.toMatchObject({ code: "storage:immutable_observation" });
      await opened.close();
    });
  });

  it("rejects canonical payload conflicts during lifecycle closure", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.sourceCatalog.putArtifact(artifact);
      await opened.repositories.sourceCatalog.putContentBlob(contentBlob);
      await opened.repositories.sourceCatalog.putObservationBatch(observationBatch);
      await opened.repositories.sourceCatalog.putObservation(observation);
      await opened.repositories.sourceCatalog.putArtifactVersion(artifactVersion);
      const closedVersion = { ...artifactVersion, valid_to_generation: 2 };
      await opened.repositories.sourceCatalog.putArtifactVersion(closedVersion);
      await expect(opened.repositories.sourceCatalog.putArtifactVersion({ ...closedVersion, payload_conflict: true } as typeof closedVersion & { payload_conflict: boolean })).rejects.toMatchObject({ code: "storage:artifact_version_immutable" });
      await opened.repositories.sourceCatalog.putTombstone(openTombstone);
      const closedTombstone = { ...openTombstone, valid_to_generation: 3, closing_artifact_change_id: "change-close", replacement_artifact_version_id: artifactVersion.artifact_version_id };
      await opened.repositories.sourceCatalog.putTombstone(closedTombstone);
      await expect(opened.repositories.sourceCatalog.putTombstone({ ...closedTombstone, payload_conflict: true } as typeof closedTombstone & { payload_conflict: boolean })).rejects.toMatchObject({ code: "storage:tombstone_immutable" });
      await opened.close();
    });
  });

  it("rejects a record whose owner artifact and owner version disagree", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      const artifactB = { ...artifact, artifact_id: "art-two", normalized_uri: "file:///repositories/one/src/other.ts" };
      const versionB = { ...artifactVersion, artifact_version_id: "artv-two", artifact_id: artifactB.artifact_id };
      await opened.repositories.sourceCatalog.putArtifact(artifact);
      await opened.repositories.sourceCatalog.putArtifact(artifactB);
      await opened.repositories.sourceCatalog.putContentBlob(contentBlob);
      await opened.repositories.sourceCatalog.putObservationBatch(observationBatch);
      await opened.repositories.sourceCatalog.putObservation(observation);
      const observationB = { ...observation, source_observation_id: "obs-two", artifact_id: artifactB.artifact_id };
      await opened.repositories.sourceCatalog.putObservation(observationB);
      await opened.repositories.sourceCatalog.putArtifactVersion(artifactVersion);
      await opened.repositories.sourceCatalog.putArtifactVersion({ ...versionB, created_from_observation_id: observationB.source_observation_id });
      await expect(opened.repositories.sourceCatalog.putTombstone({ ...openTombstone, last_artifact_version_id: versionB.artifact_version_id })).rejects.toMatchObject({ code: "ERR_SQLITE_ERROR" });
      await expect(opened.repositories.canonicalOccurrences.put({ ...record, owner_artifact_id: artifact.artifact_id, owner_artifact_version_id: versionB.artifact_version_id })).rejects.toMatchObject({ code: "ERR_SQLITE_ERROR" });
      await opened.close();
    });
  });

  it("rejects canonical record payload conflicts under an existing record identity", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.sourceCatalog.putArtifact(artifact);
      await opened.repositories.sourceCatalog.putContentBlob(contentBlob);
      await opened.repositories.sourceCatalog.putObservationBatch(observationBatch);
      await opened.repositories.sourceCatalog.putObservation(observation);
      await opened.repositories.sourceCatalog.putArtifactVersion(artifactVersion);
      await opened.repositories.canonicalOccurrences.put(record);
      await expect(opened.repositories.canonicalOccurrences.put({ ...record, payload: { name: "tampered", exported: false } })).rejects.toMatchObject({ code: "storage:immutable_occurrence" });
      expect(await opened.repositories.canonicalOccurrences.get(record.record_id)).toEqual(record);
      await opened.close();
    });
  });

  it("rejects a tampered artifact typed projection during an otherwise identical re-upsert", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.sourceCatalog.putArtifact(artifact);
      await opened.database.run("UPDATE source_artifacts SET normalized_uri = ? WHERE artifact_id = ?", ["file:///tampered", artifact.artifact_id]);
      await expect(opened.repositories.sourceCatalog.putArtifact(artifact)).rejects.toMatchObject({ code: "storage:immutable_artifact" });
      await opened.close();
    });
  });

  it("permits exactly one monotonic record closure and rejects reopening", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.sourceCatalog.putArtifact(artifact);
      await opened.repositories.sourceCatalog.putContentBlob(contentBlob);
      await opened.repositories.sourceCatalog.putObservationBatch(observationBatch);
      await opened.repositories.sourceCatalog.putObservation(observation);
      await opened.repositories.sourceCatalog.putArtifactVersion(artifactVersion);
      await opened.repositories.canonicalOccurrences.put(record);
      const closed = { ...record, valid_to_generation: 2 };
      await opened.repositories.canonicalOccurrences.put(closed);
      expect(await opened.repositories.canonicalOccurrences.get(record.record_id)).toEqual(closed);
      await expect(opened.repositories.canonicalOccurrences.put(record)).rejects.toMatchObject({ code: "storage:occurrence_lifecycle" });
      await expect(opened.repositories.canonicalOccurrences.put({ ...closed, payload: { name: "changed", exported: false } })).rejects.toMatchObject({ code: "storage:immutable_occurrence" });
      await opened.close();
    });
  });

  it("rejects artifact versions whose content metadata disagrees with the content blob", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.sourceCatalog.putArtifact(artifact);
      await opened.repositories.sourceCatalog.putContentBlob(contentBlob);
      await opened.repositories.sourceCatalog.putObservationBatch(observationBatch);
      await opened.repositories.sourceCatalog.putObservation(observation);
      await expect(opened.repositories.sourceCatalog.putArtifactVersion({ ...artifactVersion, artifact_version_id: "bad-hash", content_hash: "sha256:abababababababababababababababababababababababababababababababab" })).rejects.toMatchObject({ code: "storage:artifact_version_content_blob_mismatch" });
      await expect(opened.repositories.sourceCatalog.putArtifactVersion({ ...artifactVersion, artifact_version_id: "bad-length", byte_length: 13 })).rejects.toMatchObject({ code: "storage:artifact_version_content_blob_mismatch" });
      await opened.close();
    });
  });

  it("rejects tampered observation projections on canonical re-upsert", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.sourceCatalog.putArtifact(artifact);
      await opened.repositories.sourceCatalog.putObservationBatch(observationBatch);
      await opened.repositories.sourceCatalog.putObservation(observation);
      await opened.database.run("UPDATE source_observations SET observed_state = ? WHERE source_observation_id = ?", ["deleted", observation.source_observation_id]);
      await expect(opened.repositories.sourceCatalog.putObservation(observation)).rejects.toMatchObject({ code: "storage:immutable_observation" });
      await opened.close();
    });
  });

  it("rejects tampered registry and snapshot projections on canonical re-upsert", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      const binding = {
        namespace_binding_id: "binding-tamper",
        workspace_id: workspace.workspace_id,
        namespace: "namespace-tamper",
        plugin_id: "plugin-tamper",
        plugin_version: "1.0.0",
        contribution_digest: "sha256:abababababababababababababababababababababababababababababababab",
        emission_valid_from_generation: "1",
      };
      const registryWithBinding = { ...registrySnapshot, namespace_bindings: [binding] };
      await opened.repositories.registries.putSnapshot(registryWithBinding);
      await opened.repositories.controlPlane.putConfiguration(configurationRevision);
      await opened.repositories.controlPlane.putResolutionLock(resolutionLock);
      await opened.database.run("UPDATE registry_snapshots SET registry_contract_version = ? WHERE registry_snapshot_id = ?", ["tampered", registrySnapshot.registry_snapshot_id]);
      await expect(opened.repositories.registries.putSnapshot(registryWithBinding)).rejects.toMatchObject({ code: "storage:immutable_registry_snapshot" });

      await opened.database.run("UPDATE registry_snapshots SET registry_contract_version = ? WHERE registry_snapshot_id = ?", [registrySnapshot.registry_contract_version, registrySnapshot.registry_snapshot_id]);
      await opened.database.run("UPDATE registry_namespace_bindings SET namespace = ? WHERE registry_snapshot_id = ? AND namespace_binding_id = ?", ["tampered", registrySnapshot.registry_snapshot_id, binding.namespace_binding_id]);
      await expect(opened.repositories.registries.putSnapshot(registryWithBinding)).rejects.toMatchObject({ code: "storage:immutable_registry_snapshot" });
      await opened.database.run("UPDATE registry_namespace_bindings SET namespace = ? WHERE registry_snapshot_id = ? AND namespace_binding_id = ?", [binding.namespace, registrySnapshot.registry_snapshot_id, binding.namespace_binding_id]);
      await opened.repositories.snapshots.put(snapshot);
      await opened.database.run("UPDATE snapshots SET generation_manifest_id = ? WHERE snapshot_id = ?", ["tampered", snapshot.snapshot_id]);
      await expect(opened.repositories.snapshots.put(snapshot)).rejects.toMatchObject({ code: "storage:immutable_snapshot" });
      await opened.close();
    });
  });

  it("binds repositories and publication to their workspace database identity", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      const foreignArtifact = { ...artifact, artifact_id: "foreign-artifact", workspace_id: "ws-two", normalized_uri: "file:///other" };
      await expect(opened.repositories.sourceCatalog.putArtifact(foreignArtifact)).rejects.toMatchObject({ code: "storage:workspace_mismatch" });
      await opened.database.run("INSERT INTO source_artifacts (artifact_id, workspace_id, normalized_uri, artifact_kind, artifact_payload) VALUES (?, ?, ?, ?, ?)", [foreignArtifact.artifact_id, foreignArtifact.workspace_id, foreignArtifact.normalized_uri, foreignArtifact.artifact_kind, new Uint8Array([1])]);
      expect(await opened.repositories.sourceCatalog.getArtifact(foreignArtifact.artifact_id)).toBeUndefined();
      expect((await opened.repositories.sourceCatalog.listArtifacts()).some((entry) => entry.artifact_id === foreignArtifact.artifact_id)).toBe(false);
      await expect(opened.repositories.canonicalOccurrences.put({ ...record, workspace_id: "ws-two" })).rejects.toMatchObject({ code: "storage:workspace_mismatch" });
      await expect(opened.repositories.snapshots.put({ ...snapshot, workspace_id: "ws-two" })).rejects.toMatchObject({ code: "storage:workspace_mismatch" });
      await expect(opened.publish({ snapshot: { ...snapshot, workspace_id: "ws-two" }, current_state: { ...currentState, workspace_id: "ws-two" } })).rejects.toMatchObject({ code: "storage:publication_invalid" });
      await opened.close();
      const rebound = await storage.openWorkspace(workspace.workspace_id);
      await rebound.database.run("UPDATE workspace_meta SET value = ? WHERE key = ?", [encodeCanonical("ws-two"), "workspace_id"]);
      await rebound.close();
      await expect(storage.openWorkspace(workspace.workspace_id)).rejects.toMatchObject({ code: "storage:workspace_binding_mismatch" });
    });
  });

  // decision 11 (content-derived record identity): a workspace database
  // predating the format bump has no `identity_format` marker in
  // `workspace_meta` -- opening it must fail cleanly instead of silently
  // mixing workspace-salted rows (minted by the old code) with the new
  // content-derived derivation.
  it("rejects opening a workspace database that predates content-derived record identity", async () => {
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      const stamped = await opened.database.get<{ value: unknown }>("SELECT value FROM workspace_meta WHERE key = 'identity_format'");
      expect(stamped).toBeDefined();
      await opened.database.run("DELETE FROM workspace_meta WHERE key = 'identity_format'");
      await opened.close();
      // The error must point at the actual remedy (remove + re-add, or
      // delete the database directory) rather than "rescan"/"reindex": those
      // reopen this same database and would hit this same gate again.
      await expect(storage.openWorkspace(workspace.workspace_id)).rejects.toMatchObject({
        code: "storage:workspace_format_outdated",
        message: expect.stringContaining("urdira workspace remove"),
        details: expect.objectContaining({ remediation: expect.stringContaining("urdira workspace add") }),
      });
      // Re-registering the same workspace (a no-op catalog call, since it
      // already exists) never re-stamps the marker -- only first creation does.
      await storage.catalog.registerWorkspace(workspace);
      await expect(storage.openWorkspace(workspace.workspace_id)).rejects.toMatchObject({ code: "storage:workspace_format_outdated" });
      // An unrecognized format value (neither absent nor current) is rejected the same way.
      const raw = await openSqliteDatabase({ filename: join(root, "workspaces", "ws-one.sqlite") });
      await raw.run("INSERT INTO workspace_meta (key, value) VALUES ('identity_format', ?)", [encodeCanonical(1)]);
      await raw.close();
      await expect(storage.openWorkspace(workspace.workspace_id)).rejects.toMatchObject({ code: "storage:workspace_format_outdated" });
    });
  });

  it("keeps workspace and model-pack registration identities immutable and lifecycles one-way", async () => {
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspace, join(root, "lifecycle", "workspace.sqlite"));
      await expect(storage.catalog.registerWorkspace({ ...workspace, canonical_root: "/repositories/rewritten" }, join(root, "lifecycle", "workspace.sqlite"))).rejects.toMatchObject({ code: "storage:immutable_workspace" });
      const removedWorkspace = { ...workspace, status: "removed", removed_at: "2026-08-09T00:00:02.000000000Z" };
      await storage.catalog.registerWorkspace(removedWorkspace, join(root, "lifecycle", "workspace.sqlite"));
      await expect(storage.catalog.registerWorkspace(workspace, join(root, "lifecycle", "workspace.sqlite"))).rejects.toMatchObject({ code: "storage:workspace_lifecycle" });

      await storage.catalog.putModelPackInstallation(modelPackInstallation);
      await expect(storage.catalog.putModelPackInstallation({ ...modelPackInstallation, model_pack_version: "2.0.0" })).rejects.toMatchObject({ code: "storage:immutable_model_pack_installation" });
      const removedInstallation = { ...modelPackInstallation, removed_at: "2026-08-09T00:00:03.000000000Z", removal_reason_code: "uninstalled" } as unknown as ModelPackInstallation;
      await storage.catalog.putModelPackInstallation(removedInstallation);
      await expect(storage.catalog.putModelPackInstallation(modelPackInstallation)).rejects.toMatchObject({ code: "storage:model_pack_lifecycle" });
    });
  });

  it("rejects CAS metadata conflicts under an existing immutable digest", async () => {
    await withStorage(async (_root, storage) => {
      const data = new TextEncoder().encode("metadata-bound bytes");
      const first = await storage.cas.put(data, { media_type: "text/plain" });
      await expect(storage.cas.put(data, { media_type: "application/json" })).rejects.toMatchObject({ code: "storage:cas_metadata_conflict" });
      await expect(storage.catalog.recordCasObject({ ...first, byte_length: first.byte_length + 1 }, "text/plain")).rejects.toMatchObject({ code: "storage:cas_metadata_conflict" });
      await expect(storage.cas.put(data, { media_type: "text/plain" })).resolves.toEqual(first);
    });
  });

  it("keeps control-plane payloads immutable and enforces workspace-aware references", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.controlPlane.putConfiguration(configurationRevision);
      await expect(opened.repositories.controlPlane.putConfiguration({ ...configurationRevision, effective_configuration: new Uint8Array([9]) })).rejects.toMatchObject({ code: "storage:immutable_configuration" });
      await expect(opened.repositories.controlPlane.putConfiguration({ ...configurationRevision, workspace_id: "ws-two" })).rejects.toMatchObject({ code: "storage:workspace_mismatch" });
      await opened.repositories.controlPlane.putResolutionLock(resolutionLock);
      await expect(opened.repositories.controlPlane.putResolutionLock({ ...resolutionLock, resolved_plugins: [{ plugin_id: "plugin", plugin_version: "1.0.0" }] as never })).rejects.toMatchObject({ code: "storage:immutable_resolution_lock" });
      await expect(opened.repositories.controlPlane.putResolutionLock({ ...resolutionLock, workspace_id: "ws-two" })).rejects.toMatchObject({ code: "storage:workspace_mismatch" });
      await opened.repositories.registries.putSnapshot(registrySnapshot);
      await opened.repositories.snapshots.put(snapshot);
      await opened.repositories.controlPlane.putFreshnessCheckpoint(freshnessCheckpoint);
      await expect(opened.repositories.controlPlane.putFreshnessCheckpoint({ ...freshnessCheckpoint, verification_status: "degraded" })).rejects.toMatchObject({ code: "storage:immutable_freshness_checkpoint" });
      await expect(opened.repositories.controlPlane.putFreshnessCheckpoint({ ...freshnessCheckpoint, workspace_id: "ws-two" })).rejects.toMatchObject({ code: "storage:workspace_mismatch" });
      await expect(opened.repositories.controlPlane.putFreshnessCheckpoint({ ...freshnessCheckpoint, freshness_checkpoint_id: "dangling", snapshot_id: "missing-snapshot" })).rejects.toMatchObject({ code: "storage:control_reference_missing" });
      await expect(opened.repositories.snapshots.put({ ...snapshot, snapshot_id: "dangling-lock", resolution_lock_id: "missing-lock", snapshot_digest: "sha256:abababababababababababababababababababababababababababababababab" })).rejects.toMatchObject({ code: "storage:control_reference_missing" });
      await expect(opened.repositories.snapshots.put({ ...snapshot, snapshot_id: "dangling-config", configuration_revision_id: "missing-configuration", snapshot_digest: "sha256:cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd" })).rejects.toMatchObject({ code: "storage:control_reference_missing" });
      await opened.close();
    });
  });

  it("rejects publication with dangling control-plane references before exposing any tuple", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.registries.putSnapshot(registrySnapshot);
      await expect(opened.publish({ snapshot, current_state: currentState })).rejects.toMatchObject({ code: "storage:publication_invalid" });
      expect(await opened.repositories.snapshots.get(snapshot.snapshot_id)).toBeUndefined();
      expect(await opened.repositories.snapshots.getCurrent()).toBeUndefined();
      await opened.close();
    });
  });

  it("rejects a freshness checkpoint for a different snapshot atomically", async () => {
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.registries.putSnapshot(registrySnapshot);
      await opened.repositories.controlPlane.putConfiguration(configurationRevision);
      await opened.repositories.controlPlane.putResolutionLock(resolutionLock);
      await opened.repositories.controlPlane.put(
        "workspace_freshness_checkpoint",
        "workspace_freshness_checkpoint:freshness-one",
        { workspace_id: workspace.workspace_id, freshness_checkpoint_id: "freshness-one", snapshot_id: "different-snapshot", source_state_digest: snapshot.source_state_digest },
      );
      await expect(opened.publish({ snapshot, current_state: currentState })).rejects.toMatchObject({ code: "storage:publication_invalid" });
      expect(await opened.repositories.snapshots.get(snapshot.snapshot_id)).toBeUndefined();
      expect(await opened.repositories.snapshots.getCurrent()).toBeUndefined();
      await opened.close();
    });
  });

  it("validates generic freshness control writes and rejects source-digest bypasses", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await expect(opened.repositories.controlPlane.put(
        "workspace_freshness_checkpoint",
        "workspace_freshness_checkpoint:unsafe",
        { workspace_id: workspace.workspace_id, snapshot_id: snapshot.snapshot_id },
      )).rejects.toMatchObject({ code: "storage:control_reference_mismatch" });
      await opened.repositories.registries.putSnapshot(registrySnapshot);
      await opened.repositories.controlPlane.putConfiguration(configurationRevision);
      await opened.repositories.controlPlane.putResolutionLock(resolutionLock);
      await opened.repositories.controlPlane.put(
        "workspace_freshness_checkpoint",
        "workspace_freshness_checkpoint:freshness-one",
        { workspace_id: workspace.workspace_id, freshness_checkpoint_id: "freshness-one", snapshot_id: snapshot.snapshot_id, source_state_digest: "sha256:bad" },
      );
      await expect(opened.publish({ snapshot, current_state: currentState })).rejects.toMatchObject({ code: "storage:publication_invalid" });
      expect(await opened.repositories.snapshots.get(snapshot.snapshot_id)).toBeUndefined();
      expect(await opened.repositories.snapshots.getCurrent()).toBeUndefined();
      await opened.close();
    });
  });

  it("honors an expected current-state CAS tuple on initial publication", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.registries.putSnapshot(registrySnapshot);
      await seedPublicationControls(opened);
      await expect(opened.publish({ snapshot, current_state: currentState, expected_current_state: { ...currentState, state_revision: 99 } })).rejects.toMatchObject({ code: "storage:publication_conflict" });
      expect(await opened.repositories.snapshots.get(snapshot.snapshot_id)).toBeUndefined();
      expect(await opened.repositories.snapshots.getCurrent()).toBeUndefined();
      await opened.close();
    });
  });

  it("applies an expected current-state CAS tuple to a valid subsequent publication", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await opened.repositories.registries.putSnapshot(registrySnapshot);
      await seedPublicationControls(opened);
      await opened.publish({ snapshot, current_state: currentState });
      await opened.repositories.controlPlane.put(
        "workspace_freshness_checkpoint",
        "workspace_freshness_checkpoint:freshness-two",
        {
          workspace_id: workspace.workspace_id,
          freshness_checkpoint_id: "freshness-two",
          snapshot_id: nextSnapshot.snapshot_id,
          source_state_digest: nextSnapshot.source_state_digest,
        },
      );

      const subsequentState = {
        ...nextCurrentState,
        current_freshness_checkpoint_id: "freshness-two",
      };
      await expect(opened.publish({ snapshot: nextSnapshot, current_state: subsequentState, expected_current_state: currentState })).resolves.toBeUndefined();
      expect(await opened.repositories.snapshots.get(nextSnapshot.snapshot_id)).toEqual(nextSnapshot);
      expect(await opened.repositories.snapshots.getCurrent()).toEqual(subsequentState);
      await opened.close();
    });
  });

  it("rejects registry snapshots carrying a foreign workspace identity", async () => {
    await withStorage(async (_root, storage) => {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      await expect(opened.repositories.registries.putSnapshot({ ...registrySnapshot, workspace_id: "ws-two" } as typeof registrySnapshot & { workspace_id: string })).rejects.toMatchObject({ code: "storage:workspace_mismatch" });
      await opened.close();
    });
  });

  it("serializes conflicting catalog, model-pack, control, and CAS metadata writes", async () => {
    await withStorage(async (root, storage) => {
      const workspacePath = join(root, "concurrent", "workspace.sqlite");
      const workspaceA = { ...workspace, canonical_root: "/repositories/concurrent-a" };
      const workspaceB = { ...workspace, canonical_root: "/repositories/concurrent-b" };
      const workspaceResults = await Promise.allSettled([
        storage.catalog.registerWorkspace(workspaceA, workspacePath),
        storage.catalog.registerWorkspace(workspaceB, workspacePath),
      ]);
      expect(workspaceResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(workspaceResults.filter((result) => result.status === "rejected")).toHaveLength(1);

      const modelA = { ...modelPackInstallation, manifest_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
      const modelB = { ...modelPackInstallation, manifest_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
      const modelResults = await Promise.allSettled([
        storage.catalog.putModelPackInstallation(modelA),
        storage.catalog.putModelPackInstallation(modelB),
      ]);
      expect(modelResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(modelResults.filter((result) => result.status === "rejected")).toHaveLength(1);

      const opened = await storage.openWorkspace(workspace.workspace_id);
      const controlResults = await Promise.allSettled([
        opened.repositories.controlPlane.put("concurrent_state", "same-key", { value: "a" }),
        opened.repositories.controlPlane.put("concurrent_state", "same-key", { value: "b" }),
      ]);
      expect(controlResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(controlResults.filter((result) => result.status === "rejected")).toHaveLength(1);
      await opened.close();

      const data = new TextEncoder().encode("concurrent metadata");
      const bareCas = new ContentAddressedStore(join(root, "bare-cas"));
      const hash = (await bareCas.put(data)).content_hash;
      const casResults = await Promise.allSettled([
        storage.catalog.recordCasObject({ content_blob_id: hash, content_hash: hash, byte_length: data.byteLength, storage_reference: `cas:${hash}` }, "text/plain"),
        storage.catalog.recordCasObject({ content_blob_id: hash, content_hash: hash, byte_length: data.byteLength, storage_reference: `cas:${hash}` }, "application/json"),
      ]);
      expect(casResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(casResults.filter((result) => result.status === "rejected")).toHaveLength(1);
    });
  });

  it("rejects relocation while a workspace handle is active and preserves state on failure", async () => {
    await withStorage(async (root, storage) => {
      const originalPath = join(root, "relocation", "workspace.sqlite");
      await storage.catalog.registerWorkspace(workspace, originalPath);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      const activeDestination = join(root, "relocation", "active-move.sqlite");
      await expect(storage.catalog.relocateWorkspace(workspace.workspace_id, activeDestination)).rejects.toMatchObject({ code: "storage:workspace_in_use" });
      expect((await storage.catalog.getWorkspace(workspace.workspace_id))?.database_path).toBe(originalPath);
      await opened.close();

      const blocker = join(root, "relocation-blocker");
      await writeFile(blocker, "not a directory");
      await expect(storage.catalog.relocateWorkspace(workspace.workspace_id, join(blocker, "workspace.sqlite"))).rejects.toBeDefined();
      expect((await storage.catalog.getWorkspace(workspace.workspace_id))?.database_path).toBe(originalPath);
      expect(await readFile(originalPath)).toBeTruthy();

      const rollbackDestination = join(root, "relocation", "rollback.sqlite");
      const catalogDatabase = storage.catalog.database;
      const originalRun = catalogDatabase.run.bind(catalogDatabase);
      catalogDatabase.run = async (sql, params) => {
        if (sql.includes("UPDATE installation_workspaces SET database_path")) throw new Error("injected catalog failure");
        return await originalRun(sql, params);
      };
      await expect(storage.catalog.relocateWorkspace(workspace.workspace_id, rollbackDestination)).rejects.toMatchObject({ code: "storage:relocation_failed" });
      expect((await storage.catalog.getWorkspace(workspace.workspace_id))?.database_path).toBe(originalPath);
      expect(await readFile(originalPath)).toBeTruthy();
      await expect(readFile(rollbackDestination)).rejects.toBeDefined();
    });
  });

  it("rejects relocation while another process holds a workspace lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-cross-process-lease-"));
    const storage = await createDurableStorage({ rootDir: root });
    let child: ReturnType<typeof spawn> | undefined;
    let relocationDestination: string | undefined;
    try {
      const originalPath = join(root, "lease", "workspace.sqlite");
      const destination = join(root, "lease", "moved.sqlite");
      relocationDestination = destination;
      await storage.catalog.registerWorkspace(workspace, originalPath);
      const childScript = `
        const { createDurableStorage } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "packages/storage/dist/index.js")).href)});
        const storage = await createDurableStorage({ rootDir: ${JSON.stringify(root)} });
        const opened = await storage.openWorkspace(${JSON.stringify(workspace.workspace_id)});
        process.stdout.write("ready\\n");
        process.on("SIGTERM", async () => { await opened.close(); await storage.close(); process.exit(0); });
        setInterval(() => {}, 1000);
      `;
      child = spawn(process.execPath, ["--input-type=module", "-e", childScript], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      await new Promise<void>((resolve, reject) => {
        let output = "";
        const onData = (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("ready\n")) resolve();
        };
        child?.stdout?.on("data", onData);
        child?.once("error", reject);
        child?.once("exit", (code) => reject(new Error(`lease child exited before readiness: ${code}`)));
      });
      await expect(storage.catalog.relocateWorkspace(workspace.workspace_id, destination)).rejects.toMatchObject({ code: "storage:workspace_in_use" });
      expect((await storage.catalog.getWorkspace(workspace.workspace_id))?.database_path).toBe(originalPath);
      expect(await readFile(originalPath)).toBeTruthy();
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => child?.once("exit", () => resolve()));
      }
      if (child?.exitCode !== null && relocationDestination) await expect(storage.catalog.relocateWorkspace(workspace.workspace_id, relocationDestination)).resolves.toBeUndefined();
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores the filesystem when relocation changes zero catalog rows", async () => {
    await withStorage(async (root, storage) => {
      const originalPath = join(root, "zero-row", "workspace.sqlite");
      const destination = join(root, "zero-row", "moved.sqlite");
      await storage.catalog.registerWorkspace(workspace, originalPath);
      const catalogDatabase = storage.catalog.database;
      const originalRun = catalogDatabase.run.bind(catalogDatabase);
      catalogDatabase.run = async (sql, params) => {
        if (sql.includes("UPDATE installation_workspaces SET database_path")) return { changes: 0, last_insert_rowid: 0 };
        return await originalRun(sql, params);
      };

      await expect(storage.catalog.relocateWorkspace(workspace.workspace_id, destination)).rejects.toMatchObject({ code: "storage:relocation_conflict" });
      expect((await storage.catalog.getWorkspace(workspace.workspace_id))?.database_path).toBe(originalPath);
      expect(await readFile(originalPath)).toBeTruthy();
      await expect(readFile(destination)).rejects.toBeDefined();
    });
  });

  it("keeps relocation safe when two catalog handles race", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-relocation-race-"));
    const first = await createDurableStorage({ rootDir: root });
    const second = await createDurableStorage({ rootDir: root });
    try {
      const originalPath = join(root, "race", "workspace.sqlite");
      const firstDestination = join(root, "race", "first.sqlite");
      const secondDestination = join(root, "race", "second.sqlite");
      await first.catalog.registerWorkspace(workspace, originalPath);
      const results = await Promise.allSettled([
        first.catalog.relocateWorkspace(workspace.workspace_id, firstDestination),
        second.catalog.relocateWorkspace(workspace.workspace_id, secondDestination),
      ]);
      expect(results.some((result) => result.status === "fulfilled")).toBe(true);
      const stored = await first.catalog.getWorkspace(workspace.workspace_id);
      expect(stored?.database_path === firstDestination || stored?.database_path === secondDestination).toBe(true);
      await expect(readFile(stored?.database_path ?? "missing")).resolves.toBeTruthy();
      await expect(readFile(originalPath)).rejects.toBeDefined();
    } finally {
      await first.close();
      await second.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects immutable catalog conflicts across independent storage workers", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-catalog-workers-"));
    const first = await createDurableStorage({ rootDir: root });
    const second = await createDurableStorage({ rootDir: root });
    try {
      const workspacePath = join(root, "workers", "workspace.sqlite");
      const workspaceA = { ...workspace, canonical_root: "/repositories/worker-a" };
      const workspaceB = { ...workspace, canonical_root: "/repositories/worker-b" };
      const workspaceResults = await Promise.allSettled([
        first.catalog.registerWorkspace(workspaceA, workspacePath),
        second.catalog.registerWorkspace(workspaceB, workspacePath),
      ]);
      expect(workspaceResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(workspaceResults.filter((result) => result.status === "rejected")).toHaveLength(1);
      const storedWorkspace = await first.catalog.getWorkspace(workspace.workspace_id);
      expect(storedWorkspace?.canonical_root === workspaceA.canonical_root || storedWorkspace?.canonical_root === workspaceB.canonical_root).toBe(true);

      const modelA = { ...modelPackInstallation, manifest_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
      const modelB = { ...modelPackInstallation, manifest_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
      const modelResults = await Promise.allSettled([
        first.catalog.putModelPackInstallation(modelA),
        second.catalog.putModelPackInstallation(modelB),
      ]);
      expect(modelResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(modelResults.filter((result) => result.status === "rejected")).toHaveLength(1);

      const hash = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
      const casResults = await Promise.allSettled([
        first.catalog.recordCasObject({ content_blob_id: hash, content_hash: hash, byte_length: 4, storage_reference: "cas:worker-a" }, "text/plain"),
        second.catalog.recordCasObject({ content_blob_id: hash, content_hash: hash, byte_length: 4, storage_reference: "cas:worker-b" }, "text/plain"),
      ]);
      expect(casResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(casResults.filter((result) => result.status === "rejected")).toHaveLength(1);
      const storedCas = await first.catalog.database.get<{ storage_reference: string }>("SELECT storage_reference FROM installation_cas_objects WHERE content_hash = ?", [hash]);
      expect(storedCas?.storage_reference === "cas:worker-a" || storedCas?.storage_reference === "cas:worker-b").toBe(true);
    } finally {
      await first.close();
      await second.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a relocation after a child crashes between rename and catalog update", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-relocation-recovery-"));
    const storage = await createDurableStorage({ rootDir: root });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const originalPath = join(root, "recovery", "workspace.sqlite");
      const destination = join(root, "recovery", "moved.sqlite");
      await storage.catalog.registerWorkspace(workspace, originalPath);
      const childScript = `
        const { createDurableStorage } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "packages/storage/dist/index.js")).href)});
        const storage = await createDurableStorage({ rootDir: ${JSON.stringify(root)} });
        const database = storage.catalog.database;
        const originalRun = database.run.bind(database);
        database.run = async (sql, params) => {
          if (sql.includes("UPDATE installation_workspaces SET database_path")) process.exit(0);
          return await originalRun(sql, params);
        };
        await storage.catalog.relocateWorkspace(${JSON.stringify(workspace.workspace_id)}, ${JSON.stringify(destination)});
      `;
      child = spawn(process.execPath, ["--input-type=module", "-e", childScript], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
      let childStderr = "";
      const exitCode = await new Promise<number>((resolve, reject) => {
        child?.stderr?.on("data", (chunk: Buffer) => { childStderr += chunk.toString(); });
        child?.once("error", reject);
        child?.once("exit", (code) => resolve(code ?? -1));
      });
      expect(exitCode, childStderr).toBe(0);

      const recoveredStorage = await createDurableStorage({ rootDir: root });
      try {
        expect((await recoveredStorage.catalog.getWorkspace(workspace.workspace_id))?.database_path).toBe(destination);
        await expect(readFile(destination)).resolves.toBeTruthy();
        await expect(readFile(originalPath)).rejects.toBeDefined();
        await recoveredStorage.catalog.relocateWorkspace(workspace.workspace_id, originalPath);
      } finally {
        await recoveredStorage.close();
      }
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deduplicates concurrent CAS installation races by verifying the winner", async () => {
    await withStorage(async (root, _storage) => {
      const first = new ContentAddressedStore(join(root, "race-cas"));
      const second = new ContentAddressedStore(join(root, "race-cas"));
      const bytes = new TextEncoder().encode("same concurrent bytes");
      const results = await Promise.all([first.put(bytes), second.put(bytes), first.put(bytes), second.put(bytes)]);
      expect(new Set(results.map((result) => result.content_hash)).size).toBe(1);
      await expect(first.read(results[0].content_hash)).resolves.toEqual(bytes);
    });
  });

  it("recovers the committed publication after worker-process exit and reopening storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-publication-recovery-"));
    try {
      const childScript = `
        const { createDurableStorage } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "packages/storage/dist/index.js")).href)});
        const storage = await createDurableStorage({ rootDir: ${JSON.stringify(root)}, inlineThresholdBytes: 8 });
        const workspace = ${JSON.stringify(workspace)};
        const registrySnapshot = ${JSON.stringify(registrySnapshot)};
        const snapshot = ${JSON.stringify(snapshot)};
        const currentState = ${JSON.stringify(currentState)};
        await storage.catalog.registerWorkspace(workspace);
        const opened = await storage.openWorkspace(workspace.workspace_id);
        await opened.repositories.registries.putSnapshot(registrySnapshot);
        await opened.repositories.controlPlane.put("workspace_configuration_revision", "workspace_configuration_revision:configuration-one", { workspace_id: workspace.workspace_id });
        await opened.repositories.controlPlane.put("plugin_resolution_lock", "plugin_resolution_lock:lock-one", { workspace_id: workspace.workspace_id });
        await opened.repositories.controlPlane.put("workspace_freshness_checkpoint", "workspace_freshness_checkpoint:freshness-one", { workspace_id: workspace.workspace_id, freshness_checkpoint_id: "freshness-one", snapshot_id: snapshot.snapshot_id, source_state_digest: snapshot.source_state_digest });
        await opened.publish({ snapshot, current_state: currentState });
        process.exit(0);
      `;
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
        const stderr: Buffer[] = [];
        child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`publication recovery child exited with ${code}: ${Buffer.concat(stderr).toString()}`)));
      });
      const reopenedStorage = await createDurableStorage({ rootDir: root, inlineThresholdBytes: 8 });
      try {
        const reopened = await reopenedStorage.openWorkspace(workspace.workspace_id);
        expect(await reopened.repositories.snapshots.get(snapshot.snapshot_id)).toEqual(snapshot);
        expect(await reopened.repositories.snapshots.getCurrent()).toEqual(currentState);
        await reopened.close();
      } finally {
        await reopenedStorage.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
