import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDurableStorage, type ContentAddressedStore, type WorkspaceDatabase } from "../packages/storage/src/index.js";
import { createLocalHashProvider } from "../packages/engine/src/index.js";
import { runSemanticReconcileInThread } from "../packages/daemon/src/semantic-thread.js";

// `runSemanticReconcileInThread` (`packages/daemon/src/semantic-thread.ts`)
// spawns a REAL `node:worker_threads` worker running compiled
// `packages/daemon/dist/semantic-worker-thread.js` -- resolved via
// `import.meta.resolve("@urdira/daemon")`, exactly like
// `tests/lexical-thread-transport.test.ts`'s equivalent for the lexical
// worker. This file mirrors that one almost line for line: same seeding
// harness shape (borrowed from `tests/semantic-maintenance.test.ts`'s
// in-process seeding, adapted to survive a REAL reopen -- see that file's
// comment on `PRAGMA foreign_keys = OFF` for why this file cannot reuse it
// as-is), same abort-mid-pass structure, same worker-failure-propagation
// check. The descriptor used throughout is `{ kind: "hash" }` -- hermetic,
// no model, no network -- so `buildSemanticProvider` inside the worker
// (`semantic-provider-runtime.ts`) resolves to a plain `createLocalHashProvider()`
// call, identical to what this file's own in-process comparison provider
// builds, letting every assertion below compare the worker's result against
// the exact values `createLocalHashProvider()` would have produced in-process.

const now = "2026-08-13T00:00:00.000Z";

function workspaceRegistration(workspaceId: string) {
  return { workspace_id: workspaceId, canonical_root: `/${workspaceId}`, display_root: `/${workspaceId}`, source_provider_bindings: [], status: "registered" as const, registered_at: now };
}

// See `tests/lexical-thread-transport.test.ts`'s identical helper's doc
// comment: a worker's own `DurableStorage.openWorkspace` (and this file's
// own follow-up reopens) always run a real, whole-database `PRAGMA
// foreign_key_check` regardless of what pragma was active at insert time,
// so every seeded row here is real and FK-satisfying rather than inserted
// under `PRAGMA foreign_keys = OFF` the way `tests/semantic-maintenance.test.ts`'s
// (never-reopened) seeding helper does.
async function seedObservationBatch(opened: WorkspaceDatabase, workspaceId: string, batchId: string): Promise<void> {
  await opened.database.run(
    `INSERT OR IGNORE INTO source_observation_batches (observation_batch_id, workspace_id, source_provider_binding_id, source_provider, source_provider_version, ordering_domain, observation_mode, coverage_scopes, coverage_completeness, deletion_authority, provider_cursor_before, provider_cursor_after, started_at, completed_at, observation_count, unavailable_count, batch_digest, observation_batch_payload)
     VALUES (?, ?, 'binding-1', 'filesystem', '1.0.0', 'path', 'full', 'workspace', 'complete', 'tombstone', NULL, NULL, ?, ?, 0, 0, ?, ?)`,
    [batchId, workspaceId, now, now, `digest:${batchId}`, new Uint8Array([1])],
  );
}

async function seedTextVersion(opened: WorkspaceDatabase, cas: ContentAddressedStore, workspaceId: string, batchId: string, options: { readonly artifactId: string; readonly artifactVersionId: string; readonly text: string; readonly validFromGeneration: number }): Promise<void> {
  await opened.database.run("INSERT OR IGNORE INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind, artifact_payload) VALUES (?, ?, ?, ?, ?, 'physical_file', ?)", [options.artifactId, workspaceId, options.artifactId, options.artifactId, options.artifactId, new Uint8Array([1])]);
  const observationId = `obs-${options.artifactId}`;
  await opened.database.run(
    `INSERT OR IGNORE INTO source_observations (source_observation_id, observation_batch_id, workspace_id, artifact_id, source_provider_binding_id, source_provider, source_provider_version, ordering_domain, observation_mode, observed_state, observed_content_hash, observed_metadata_digest, provider_event_token, provider_sequence, observed_at, received_at, observation_payload)
     VALUES (?, ?, ?, ?, 'binding-1', 'filesystem', '1.0.0', 'path', 'full', 'present', NULL, NULL, NULL, NULL, ?, ?, ?)`,
    [observationId, batchId, workspaceId, options.artifactId, now, now, new Uint8Array([1])],
  );
  const blob = await cas.put(new TextEncoder().encode(options.text), { media_type: "text/plain; charset=utf-8" });
  await opened.database.run("INSERT OR IGNORE INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)", [blob.content_blob_id, blob.content_hash, blob.byte_length, blob.storage_reference]);
  await opened.database.run(
    "INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation, artifact_version_payload) VALUES (?, ?, ?, ?, ?, ?, 'utf-8', 'text', 'digest', ?, ?, NULL, ?)",
    [options.artifactVersionId, workspaceId, options.artifactId, blob.content_blob_id, blob.content_hash, blob.byte_length, observationId, options.validFromGeneration, new Uint8Array([1])],
  );
}

async function seedCurrentGenerationChain(opened: WorkspaceDatabase, workspaceId: string): Promise<void> {
  await opened.database.run(
    `INSERT OR IGNORE INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest, registry_payload)
     VALUES ('registry-1', ?, '1.0.0', 'digest:core-registry', 'lock-1', 'digest:registry-1', ?)`,
    [workspaceId, new Uint8Array([1])],
  );
  await opened.database.run(
    `INSERT OR IGNORE INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest, snapshot_payload)
     VALUES ('snapshot-1', ?, 1, NULL, 'manifest-1', 'registry-1', 'lock-1', 'configuration-1', 'digest:source-state', '{}', 'digest:canonical-record-set', '{}', 'digest:capability-state', ?, 'digest:snapshot-1', ?)`,
    [workspaceId, now, new Uint8Array([1])],
  );
}

async function setCurrentGeneration(opened: WorkspaceDatabase, workspaceId: string, generation: number): Promise<void> {
  await seedCurrentGenerationChain(opened, workspaceId);
  await opened.database.run(
    `INSERT INTO workspace_current_state (workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id, current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision, updated_at, current_payload)
     VALUES (?, 'snapshot-1', ?, 'registry-1', 'lock-1', 'configuration-1', 'freshness-1', 1, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET current_generation = excluded.current_generation`,
    [workspaceId, generation, now, new Uint8Array([1])],
  );
}

async function withStorage(test: (root: string, storage: Awaited<ReturnType<typeof createDurableStorage>>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "urdira-semantic-thread-"));
  const storage = await createDurableStorage({ rootDir: root });
  try { await test(root, storage); } finally { await storage.close(); await rm(root, { recursive: true, force: true }); }
}

describe("runSemanticReconcileInThread", () => {
  it("reconciles a real workspace end to end over the worker thread, with the exact same result shape as the in-process reconciler, and the same vector rows land in the (shared) database file", async () => {
    const workspaceId = "ws-semantic-thread-parity";
    const provider = createLocalHashProvider();
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspaceRegistration(workspaceId));
      const opened = await storage.openWorkspace(workspaceId);
      await seedObservationBatch(opened, workspaceId, "batch-1");
      await seedTextVersion(opened, storage.cas, workspaceId, "batch-1", { artifactId: "art-1", artifactVersionId: "artv-1", text: "function parseAlphaContent() {}", validFromGeneration: 1 });
      await seedTextVersion(opened, storage.cas, workspaceId, "batch-1", { artifactId: "art-2", artifactVersionId: "artv-2", text: "class BetaContentManager {}", validFromGeneration: 1 });
      await setCurrentGeneration(opened, workspaceId, 1);
      // Close this handle before the worker opens its own `DurableStorage`
      // against the same `root`, matching production (`submitSemanticMaintenance`
      // never holds a workspace handle open across the worker run either).
      await opened.close();

      const run = runSemanticReconcileInThread({ data_root: root, workspace_id: workspaceId, descriptor: { kind: "hash" } });
      const result = await run.result;
      // Decision 17 (entity-grain semantic documents) added a second,
      // always-attempted pass to `reconcileSemanticProjection` -- neither
      // seeded artifact carries any `record_occurrences` row, so the entity
      // pass finds zero candidates and every entity-grain count is its zero
      // default; the marker (`document_grains`) still records both grains as
      // complete, since this reconciler always attempts both in one run.
      expect(result).toEqual({
        generation: 1, closed: 0, inserted: 2, skipped_oversized: 0, skipped_undecodable: 0, skipped_empty: 0, failed: 0,
        entity_inserted: 0, entity_closed: 0, entity_skipped_oversized: 0, entity_skipped_undecodable: 0, entity_skipped_ineligible: 0, entity_skipped_empty: 0, entity_failed: 0,
        marker_written: true,
      });

      const reopened = await storage.openWorkspace(workspaceId);
      try {
        expect(await reopened.projections.semanticIndexState()).toEqual({ completed_generation: 1, profile_id: provider.profile.embedding_profile_id, executable_binding_id: provider.binding.executable_binding_digest, document_grains: ["artifact", "entity"], entity_policy_digest: expect.stringMatching(/^sha256:/) });
        const row = await reopened.database.get<{ readonly projection_record_id: string; readonly profile_id: string; readonly dimensions: number }>(
          "SELECT projection_record_id, profile_id, dimensions FROM vector_projection_rows WHERE owner_artifact_version_id = ? AND valid_to_generation IS NULL",
          ["artv-1"],
        );
        expect(row?.profile_id).toBe(provider.profile.embedding_profile_id);
        expect(row?.dimensions).toBe(provider.profile.dimensions);
        const vectorBytes = await reopened.projections.readVector(row!.projection_record_id);
        expect(vectorBytes.byteLength).toBe(provider.profile.dimensions * 4);
      } finally { await reopened.close(); }
    });
  }, 30_000);

  it("propagates a worker-side storage error, with its original code and message, instead of silently resolving", async () => {
    await withStorage(async (root) => {
      // No workspace ever registered under this id: the worker's own
      // `storage.openWorkspace` call throws `storage:workspace_not_found`,
      // which must reach this side of the transport intact -- proof that a
      // genuine worker failure surfaces as a rejected run rather than
      // crashing the caller or silently resolving with a fake result.
      const run = runSemanticReconcileInThread({ data_root: root, workspace_id: "ws-never-registered", descriptor: { kind: "hash" } });
      await expect(run.result).rejects.toMatchObject({ code: "storage:workspace_not_found" });
    });
  }, 30_000);

  it("stops cleanly on abort without writing the completion marker, leaving already-committed vector rows intact -- a later run then completes reconciliation normally", async () => {
    const workspaceId = "ws-semantic-thread-abort";
    const totalDocuments = 150;
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspaceRegistration(workspaceId));
      const opened = await storage.openWorkspace(workspaceId);
      await seedObservationBatch(opened, workspaceId, "batch-1");
      // Enough documents that, even after this test waits for genuine
      // partial progress (below) before aborting, plenty of work remains --
      // this is what makes the abort a real "mid-build" stop rather than a
      // race against the pass finishing on its own.
      for (let index = 0; index < totalDocuments; index += 1) {
        await seedTextVersion(opened, storage.cas, workspaceId, "batch-1", { artifactId: `art-${index}`, artifactVersionId: `artv-${index}`, text: `function documentNumber${index}Content() { return ${index}; }`, validFromGeneration: 1 });
      }
      await setCurrentGeneration(opened, workspaceId, 1);
      await opened.close();

      const run = runSemanticReconcileInThread({ data_root: root, workspace_id: workspaceId, descriptor: { kind: "hash" } });
      // Wait for genuine partial progress before aborting, observed through
      // a SEPARATE reader connection against the same on-disk database:
      // `get`/`all` bypass `SerializedWriter` (see `packages/storage/src/storage.ts`),
      // so this safely reads rows the worker's own, independent
      // `DurableStorage` connection is committing document-by-document,
      // concurrently, on the same underlying SQLite file.
      const poller = await storage.openWorkspace(workspaceId);
      let observedProgress = false;
      const deadline = Date.now() + 20_000;
      try {
        while (Date.now() < deadline) {
          const rows = await poller.database.all<{ count: number }>("SELECT COUNT(*) AS count FROM vector_projection_rows WHERE workspace_id = ?", [workspaceId]);
          if ((rows[0]?.count ?? 0) >= 1) { observedProgress = true; break; }
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
        }
      } finally { await poller.close(); }
      expect(observedProgress).toBe(true);
      run.abort();

      const result = await run.result;
      expect(result.aborted).toBe(true);
      expect(result.marker_written).toBe(false);
      expect(result.inserted).toBeGreaterThan(0);
      expect(result.inserted).toBeLessThan(totalDocuments);

      const afterAbort = await storage.openWorkspace(workspaceId);
      let committedBeforeResume = 0;
      try {
        expect(await afterAbort.projections.semanticIndexState()).toBeUndefined();
        const rows = await afterAbort.database.all<{ count: number }>("SELECT COUNT(*) AS count FROM vector_projection_rows WHERE workspace_id = ? AND valid_to_generation IS NULL", [workspaceId]);
        committedBeforeResume = rows[0]?.count ?? 0;
        expect(committedBeforeResume).toBe(result.inserted);
      } finally { await afterAbort.close(); }

      // A fresh, un-aborted run resumes where the aborted one left off and
      // reaches full completion -- the abort discarded no committed work,
      // only the marker write and whatever hadn't been reached yet.
      const resumed = await runSemanticReconcileInThread({ data_root: root, workspace_id: workspaceId, descriptor: { kind: "hash" } }).result;
      expect(resumed.marker_written).toBe(true);
      expect(resumed.inserted).toBe(totalDocuments - committedBeforeResume);

      const afterResume = await storage.openWorkspace(workspaceId);
      try {
        expect(await afterResume.projections.semanticIndexState()).toMatchObject({ completed_generation: 1 });
        const rows = await afterResume.database.all<{ count: number }>("SELECT COUNT(*) AS count FROM vector_projection_rows WHERE workspace_id = ? AND valid_to_generation IS NULL", [workspaceId]);
        expect(rows[0]?.count).toBe(totalDocuments);
      } finally { await afterResume.close(); }
    });
  }, process.platform === "win32" && process.env["CI"] === "true" ? 120_000 : 45_000);
});
