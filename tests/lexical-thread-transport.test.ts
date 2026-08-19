import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDurableStorage, type ContentAddressedStore, type WorkspaceDatabase } from "../packages/storage/src/index.js";
import { runLexicalReconcileInThread } from "../packages/daemon/src/lexical-thread.js";

// `runLexicalReconcileInThread` (`packages/daemon/src/lexical-thread.ts`)
// spawns a REAL `node:worker_threads` worker running compiled
// `packages/daemon/dist/lexical-worker-thread.js` -- resolved via
// `import.meta.resolve("@urdira/daemon")`, the exact same self-reference
// mechanism `packages/plugin-javascript-typescript/src/thread-transport.ts`
// uses for its own worker (see `tests/javascript-typescript-thread-transport.test.ts`
// for that package's equivalent test). That resolution works identically
// whether THIS test file runs from `src` (vitest, as here) or the built
// app, but it does require `packages/daemon/dist/lexical-worker-thread.js`
// to already exist -- guaranteed by `pnpm test`'s `pnpm exec tsc --build
// packages/daemon` step, which runs before `vitest run`.
//
// The seeding harness below (workspace registration, text-version seeding,
// generation bookkeeping) mirrors `tests/lexical-maintenance.test.ts`'s,
// which exercises `reconcileLexicalProjection` directly, in-process; this
// file instead drives the SAME reconciliation through the worker-thread
// transport, to verify the cross-thread wiring itself (result parity, error
// propagation, and cooperative abort) rather than the reconciler's own
// close/insert/skip logic, which the other file already covers.

const now = "2026-08-12T00:00:00.000Z";

function workspaceRegistration(workspaceId: string) {
  return { workspace_id: workspaceId, canonical_root: `/${workspaceId}`, display_root: `/${workspaceId}`, source_provider_bindings: [], status: "registered" as const, registered_at: now };
}

// Unlike `tests/lexical-maintenance.test.ts`'s equivalent helper (which
// leaves `artifact_versions.created_from_observation_id` dangling against a
// non-existent `source_observations` row, `PRAGMA foreign_keys = OFF` for
// the insert itself), THIS file's tests reopen the workspace after seeding
// (the worker's own `DurableStorage.openWorkspace`, plus this file's own
// assertion re-opens) -- every `openWorkspace` call runs `ensureWorkspaceSchemaCompatibility`,
// which runs a real `PRAGMA foreign_key_check` over the WHOLE database (see
// `packages/storage/src/schema.ts`'s `ensureCandidateForeignKeys`), and that
// check does not care whether enforcement was on or off at insert time -- it
// finds any dangling foreign key, seeded or not. So this helper seeds a
// real, FK-satisfying `source_observation_batches`/`source_observations`
// pair per artifact instead.
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

// `workspace_current_state.current_snapshot_id`/`current_registry_snapshot_id`
// are real foreign keys into `snapshots`/`registry_snapshots` (see
// `packages/storage/src/schema.ts`) -- unlike `tests/lexical-maintenance.test.ts`'s
// equivalent helper, which points them at non-existent rows under `PRAGMA
// foreign_keys = OFF` (safe there ONLY because that test never reopens the
// workspace). This file's tests always reopen (the worker's own open, this
// file's own follow-up assertions), and EVERY reopen runs a real, ALWAYS-ON,
// whole-database `PRAGMA foreign_key_check` (`ensureCandidateForeignKeys`,
// `packages/storage/src/schema.ts`) regardless of what pragma was active at
// insert time -- so this helper seeds real, minimal, FK-satisfying
// `registry_snapshots`/`snapshots` rows instead of skipping enforcement.
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
  const root = await mkdtemp(join(tmpdir(), "urdira-lexical-thread-"));
  const storage = await createDurableStorage({ rootDir: root });
  try { await test(root, storage); } finally { await storage.close(); await rm(root, { recursive: true, force: true }); }
}

describe("runLexicalReconcileInThread", () => {
  it("reconciles a real workspace end to end over the worker thread, with the exact same result shape as the in-process reconciler, and the same lexical rows land in the (shared) database file", async () => {
    const workspaceId = "ws-lexical-thread-parity";
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspaceRegistration(workspaceId));
      const opened = await storage.openWorkspace(workspaceId);
      await seedObservationBatch(opened, workspaceId, "batch-1");
      await seedTextVersion(opened, storage.cas, workspaceId, "batch-1", { artifactId: "art-1", artifactVersionId: "artv-1", text: "alpha content", validFromGeneration: 1 });
      await seedTextVersion(opened, storage.cas, workspaceId, "batch-1", { artifactId: "art-2", artifactVersionId: "artv-2", text: "beta content", validFromGeneration: 1 });
      await setCurrentGeneration(opened, workspaceId, 1);
      // Close this handle before the worker opens its own `DurableStorage`
      // against the same `root`, matching production (`submitLexicalMaintenance`
      // never holds a workspace handle open across the worker run either).
      await opened.close();

      const run = runLexicalReconcileInThread({ data_root: root, workspace_id: workspaceId });
      const result = await run.result;
      // Exact-shape parity with `tests/lexical-maintenance.test.ts`'s
      // in-process assertion for the equivalent seeded state: the worker
      // must produce the identical `ReconcileLexicalProjectionResult`.
      expect(result).toEqual({ generation: 1, closed: 0, inserted: 2, skipped_oversized: 0, skipped_undecodable: 0, marker_written: true });

      const reopened = await storage.openWorkspace(workspaceId);
      try {
        expect(await reopened.projections.lexicalCompletedGeneration()).toBe(1);
        const found = await reopened.projections.searchLiteral("alpha");
        expect(found.map((match) => match.artifact_version_id)).toEqual(["artv-1"]);
      } finally { await reopened.close(); }
    });
  }, 30_000);

  it("propagates a worker-side storage error, with its original code and message, instead of silently resolving", async () => {
    await withStorage(async (root) => {
      // No workspace ever registered under this id: the worker's own
      // `storage.openWorkspace` call throws `storage:workspace_not_found`,
      // which must reach this side of the transport intact.
      const run = runLexicalReconcileInThread({ data_root: root, workspace_id: "ws-never-registered" });
      await expect(run.result).rejects.toMatchObject({ code: "storage:workspace_not_found" });
    });
  }, 30_000);

  it("stops cleanly on abort without writing the completion marker, and resolves (not rejects) the job -- a later run then completes reconciliation normally", async () => {
    const workspaceId = "ws-lexical-thread-abort";
    const totalDocuments = 200;
    await withStorage(async (root, storage) => {
      await storage.catalog.registerWorkspace(workspaceRegistration(workspaceId));
      const opened = await storage.openWorkspace(workspaceId);
      await seedObservationBatch(opened, workspaceId, "batch-1");
      // Enough documents that, even after this test waits for genuine
      // partial progress (below) before aborting, plenty of work remains --
      // this is what makes the abort a real "mid-build" stop rather than a
      // race against the pass finishing on its own.
      for (let index = 0; index < totalDocuments; index += 1) {
        await seedTextVersion(opened, storage.cas, workspaceId, "batch-1", { artifactId: `art-${index}`, artifactVersionId: `artv-${index}`, text: `document number ${index} has some distinct trigram-bearing content in it`, validFromGeneration: 1 });
      }
      await setCurrentGeneration(opened, workspaceId, 1);
      await opened.close();

      const run = runLexicalReconcileInThread({ data_root: root, workspace_id: workspaceId });
      // Wait for genuine partial progress before aborting, observed through
      // a SEPARATE reader connection against the same on-disk database: `get`/`all`
      // bypass `SerializedWriter` (see `packages/storage/src/storage.ts`),
      // so this safely reads rows the worker's own, independent
      // `DurableStorage` connection is committing document-by-document,
      // concurrently, on the same underlying SQLite file. Each document's
      // `lexical_documents` row only appears once its own transaction fully
      // commits (trigrams-then-document ordering, see `putLexicalDocument`),
      // so observing at least one row here proves at least one full
      // document was durably written before this test calls `abort()`.
      const poller = await storage.openWorkspace(workspaceId);
      let observedProgress = false;
      const deadline = Date.now() + 20_000;
      try {
        while (Date.now() < deadline) {
          const rows = await poller.database.all<{ count: number }>("SELECT COUNT(*) AS count FROM lexical_documents WHERE workspace_id = ?", [workspaceId]);
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
      try {
        expect(await afterAbort.projections.lexicalCompletedGeneration()).toBeUndefined();
      } finally { await afterAbort.close(); }

      // A fresh, un-aborted run resumes where the aborted one left off and
      // reaches full completion -- the abort discarded no committed work,
      // only the marker write and whatever hadn't been reached yet.
      const resumed = await runLexicalReconcileInThread({ data_root: root, workspace_id: workspaceId }).result;
      expect(resumed.marker_written).toBe(true);
      expect(resumed.inserted).toBe(totalDocuments - result.inserted);

      const afterResume = await storage.openWorkspace(workspaceId);
      try {
        expect(await afterResume.projections.lexicalCompletedGeneration()).toBe(1);
        const rows = await afterResume.database.all<{ count: number }>("SELECT COUNT(*) AS count FROM lexical_documents WHERE workspace_id = ?", [workspaceId]);
        expect(rows[0]?.count).toBe(totalDocuments);
      } finally { await afterResume.close(); }
    });
  }, process.platform === "win32" && process.env["CI"] === "true" ? 120_000 : 45_000);
});
