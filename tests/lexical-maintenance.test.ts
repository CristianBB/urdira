import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeCanonical } from "@urdira/canonical";
import { createDurableStorage, type ContentAddressedStore, type WorkspaceDatabase } from "../packages/storage/src/index.js";
import { reconcileLexicalProjection, type LexicalReconcilerContentReader } from "../packages/engine/src/index.js";

// `reconcileLexicalProjection` is typed against `@urdira/storage`'s published
// (dist) `WorkspaceDatabase` declaration, since that is the real dependency
// `packages/engine` declares. This test file, like the rest of `tests/`,
// imports storage directly from `src` for whitebox access. Within
// `tsconfig.tests.json`'s single flat program, those are two distinct
// declarations of the same runtime class, so a private field makes them
// nominally incompatible even though the object is identical at runtime.
// Per-package builds (what `apps/urdira`/`packages/daemon` actually use)
// don't hit this -- see `tests/phase-workspace-indexing-session.test.ts` for
// the same note against `runFullWorkspaceScan`.
function asEngineWorkspaceDatabase(database: WorkspaceDatabase): Parameters<typeof reconcileLexicalProjection>[0]["database"] {
  return database as unknown as Parameters<typeof reconcileLexicalProjection>[0]["database"];
}

// D4: `reconcileLexicalProjection` is the async, post-ready lexical
// maintenance pass (`packages/engine/src/lexical-reconciler.ts`) that the
// daemon submits after every successful scan (`packages/daemon/src/runtime.ts`'s
// `submitLexicalMaintenance`). It reads directly from `artifact_versions`/
// `lexical_documents` and writes through `WorkspaceProjectionRepository.putLexicalDocument`
// plus a raw `lexical_documents` UPDATE for closures -- these tests exercise
// it directly against a real `WorkspaceDatabase` and a real CAS (`storage.cas`),
// the same content-addressed reader production wiring supplies.

const now = "2026-08-12T00:00:00.000Z";

function workspaceRegistration(workspaceId: string) {
  return { workspace_id: workspaceId, canonical_root: `/${workspaceId}`, display_root: `/${workspaceId}`, source_provider_bindings: [], status: "registered" as const, registered_at: now };
}

async function withWorkspace(workspaceId: string, test: (opened: WorkspaceDatabase, cas: ContentAddressedStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "urdira-lexical-maintenance-"));
  const storage = await createDurableStorage({ rootDir: root });
  try {
    await storage.catalog.registerWorkspace(workspaceRegistration(workspaceId));
    const opened = await storage.openWorkspace(workspaceId);
    try { await test(opened, storage.cas); } finally { await opened.close(); }
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}

// Seeds `source_artifacts` (once per artifact_id), `content_blobs`, and
// `artifact_versions` rows directly -- with foreign keys off, matching
// `tests/phase-canonical-query-data-port.test.ts`'s established pattern for
// seeding the tables a read/reconcile path touches without also standing up
// the full source-catalog / candidate-publication chain. Text content is
// written through the REAL CAS (`storage.cas.put`), unlike that other file's
// stubbed `artifact_text` tests, because `reconcileLexicalProjection` reads
// bytes back through a real content reader and `putLexicalDocument` verifies
// them against the artifact version's declared `content_hash`/`byte_length`
// for real.
async function seedTextVersion(opened: WorkspaceDatabase, cas: ContentAddressedStore, workspaceId: string, options: { readonly artifactId: string; readonly artifactVersionId: string; readonly text: string; readonly validFromGeneration: number; readonly validToGeneration?: number }): Promise<void> {
  await opened.database.exec("PRAGMA foreign_keys = OFF");
  await opened.database.run("INSERT OR IGNORE INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind, artifact_payload) VALUES (?, ?, ?, ?, ?, 'physical_file', ?)", [options.artifactId, workspaceId, options.artifactId, options.artifactId, options.artifactId, new Uint8Array([1])]);
  // `media_type` must match what `WorkspaceProjectionRepository.putLexicalDocument`
  // (called later, by `reconcileLexicalProjection`) itself passes to `cas.put`
  // for the same bytes -- `InstallationCatalog`'s CAS metadata is immutable
  // per content_hash, keyed loosely enough that a second `put` for the same
  // hash with a DIFFERENT declared media_type is rejected as a conflict
  // (`storage:cas_metadata_conflict`), exactly like production's own scan
  // path already writes `text/plain; charset=utf-8` for every text file
  // before the reconciler ever touches it (`source-indexer.ts`'s `contents.push`).
  const blob = await cas.put(new TextEncoder().encode(options.text), { media_type: "text/plain; charset=utf-8" });
  await opened.database.run("INSERT OR IGNORE INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)", [blob.content_blob_id, blob.content_hash, blob.byte_length, blob.storage_reference]);
  await opened.database.run(
    "INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation, artifact_version_payload) VALUES (?, ?, ?, ?, ?, ?, 'utf-8', 'text', 'digest', 'obs-1', ?, ?, ?)",
    [options.artifactVersionId, workspaceId, options.artifactId, blob.content_blob_id, blob.content_hash, blob.byte_length, options.validFromGeneration, options.validToGeneration ?? null, new Uint8Array([1])],
  );
}

/** A version whose declared `encoding` is `binary` -- mirrors `source-indexer.ts`'s scan-time decision for a non-text observation; `reconcileLexicalProjection` must never insert a document for it. */
async function seedBinaryVersion(opened: WorkspaceDatabase, cas: ContentAddressedStore, workspaceId: string, artifactId: string, artifactVersionId: string, validFromGeneration: number): Promise<void> {
  await opened.database.exec("PRAGMA foreign_keys = OFF");
  await opened.database.run("INSERT OR IGNORE INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind, artifact_payload) VALUES (?, ?, ?, ?, ?, 'physical_file', ?)", [artifactId, workspaceId, artifactId, artifactId, artifactId, new Uint8Array([1])]);
  const blob = await cas.put(new Uint8Array([0, 1, 2, 3]));
  await opened.database.run("INSERT OR IGNORE INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)", [blob.content_blob_id, blob.content_hash, blob.byte_length, blob.storage_reference]);
  await opened.database.run(
    "INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation, artifact_version_payload) VALUES (?, ?, ?, ?, ?, ?, 'binary', NULL, 'digest', 'obs-1', ?, NULL, ?)",
    [artifactVersionId, workspaceId, artifactId, blob.content_blob_id, blob.content_hash, blob.byte_length, validFromGeneration, new Uint8Array([1])],
  );
}

async function setCurrentGeneration(opened: WorkspaceDatabase, workspaceId: string, generation: number): Promise<void> {
  await opened.database.run(
    `INSERT INTO workspace_current_state (workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id, current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision, updated_at, current_payload)
     VALUES (?, 'snapshot-1', ?, 'registry-1', 'lock-1', 'configuration-1', 'freshness-1', 1, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET current_generation = excluded.current_generation`,
    [workspaceId, generation, now, new Uint8Array([1])],
  );
}

async function closeVersion(opened: WorkspaceDatabase, artifactVersionId: string, validToGeneration: number): Promise<void> {
  await opened.database.run("UPDATE artifact_versions SET valid_to_generation = ? WHERE artifact_version_id = ?", [validToGeneration, artifactVersionId]);
}

async function lexicalDocumentRow(opened: WorkspaceDatabase, artifactVersionId: string): Promise<{ readonly valid_from_generation: number; readonly valid_to_generation: number | null; readonly document_payload: Uint8Array } | undefined> {
  return opened.database.get<{ valid_from_generation: number; valid_to_generation: number | null; document_payload: Uint8Array }>("SELECT valid_from_generation, valid_to_generation, document_payload FROM lexical_documents WHERE artifact_version_id = ?", [artifactVersionId]);
}

async function trigramCount(opened: WorkspaceDatabase, artifactVersionId: string): Promise<number> {
  const row = await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM lexical_trigrams WHERE artifact_version_id = ?", [artifactVersionId]);
  return row?.count ?? 0;
}

describe("reconcileLexicalProjection", () => {
  it("creates documents and trigrams for every visible text-decodable version, skips binary versions, marks the generation complete, and is idempotent on immediate re-run; then closes stale documents and inserts replacements after a generation bump", async () => {
    const workspaceId = "ws-lexical-reconcile";
    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-1", artifactVersionId: "artv-1", text: "alpha content", validFromGeneration: 1 });
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-2", artifactVersionId: "artv-2", text: "beta content", validFromGeneration: 1 });
      await seedBinaryVersion(opened, cas, workspaceId, "art-3", "artv-3", 1);
      await setCurrentGeneration(opened, workspaceId, 1);

      const first = await reconcileLexicalProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas });
      expect(first).toEqual({ generation: 1, closed: 0, inserted: 2, skipped_oversized: 0, skipped_undecodable: 0, marker_written: true });
      expect(await lexicalDocumentRow(opened, "artv-1")).toBeDefined();
      expect(await lexicalDocumentRow(opened, "artv-2")).toBeDefined();
      expect(await lexicalDocumentRow(opened, "artv-3")).toBeUndefined();
      expect(await trigramCount(opened, "artv-1")).toBeGreaterThan(0);
      expect(await opened.projections.lexicalCompletedGeneration()).toBe(1);
      const found = await opened.projections.searchLiteral("alpha");
      expect(found.map((match) => match.artifact_version_id)).toEqual(["artv-1"]);

      // Idempotent: re-running against the same generation inserts/closes nothing new.
      const second = await reconcileLexicalProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas });
      expect(second).toEqual({ generation: 1, closed: 0, inserted: 0, skipped_oversized: 0, skipped_undecodable: 0, marker_written: true });

      // Simulate a rescan that changed art-1's content: close its version,
      // publish a new one, and bump the workspace's current generation --
      // mirroring what `GenericSourceIndexer.applyBatch` does to
      // `artifact_versions` on a real content change.
      await closeVersion(opened, "artv-1", 2);
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-1", artifactVersionId: "artv-1-v2", text: "alpha content v2", validFromGeneration: 2 });
      await setCurrentGeneration(opened, workspaceId, 2);

      const third = await reconcileLexicalProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas });
      expect(third).toEqual({ generation: 2, closed: 1, inserted: 1, skipped_oversized: 0, skipped_undecodable: 0, marker_written: true });

      // The closed document's column AND its canonical payload must agree
      // (StorageMaintenance.verify's "lexical" check requires this).
      const closedRow = await lexicalDocumentRow(opened, "artv-1");
      expect(closedRow?.valid_to_generation).toBe(2);
      const closedPayload = decodeCanonical(closedRow!.document_payload) as { readonly valid_to_generation?: number; readonly text: string };
      expect(closedPayload.valid_to_generation).toBe(2);
      expect(closedPayload.text).toBe("alpha content");

      const replacementRow = await lexicalDocumentRow(opened, "artv-1-v2");
      expect(replacementRow).toEqual({ valid_from_generation: 2, valid_to_generation: null, document_payload: replacementRow!.document_payload });
      expect(await opened.projections.lexicalCompletedGeneration()).toBe(2);

      // artv-2 ("beta content") was untouched by the rescan and must still be
      // visible at generation 2; the closed artv-1 document must not be.
      const foundAtGen2 = await opened.projections.searchLiteral("content", { generation: 2 });
      expect(foundAtGen2.map((match) => match.artifact_version_id).sort()).toEqual(["artv-1-v2", "artv-2"]);
    });
  });

  it("does not write the completion marker when the workspace's current generation moves during the pass, but still commits whatever it found", async () => {
    const workspaceId = "ws-lexical-marker-race";
    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-race", artifactVersionId: "artv-race", text: "race condition text", validFromGeneration: 1 });
      await setCurrentGeneration(opened, workspaceId, 1);

      let reads = 0;
      const content: LexicalReconcilerContentReader = {
        async read(hash) {
          reads += 1;
          // Simulate a concurrent scan publishing a new generation while this
          // pass's CAS read for the one missing document is already in flight.
          if (reads === 1) await setCurrentGeneration(opened, workspaceId, 7);
          return cas.read(hash);
        },
      };

      const result = await reconcileLexicalProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content });
      expect(result.generation).toBe(1);
      expect(result.inserted).toBe(1);
      expect(result.marker_written).toBe(false);
      expect(await lexicalDocumentRow(opened, "artv-race")).toBeDefined();
      expect(await opened.projections.lexicalCompletedGeneration()).toBeUndefined();
    });
  });

  it("skips a version whose declared byte length exceeds max_document_bytes without ever reading its content, and skips a version whose declared encoding disagrees with its actual undecodable bytes", async () => {
    const workspaceId = "ws-lexical-skips";
    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-big", artifactVersionId: "artv-big", text: "this text is longer than the tiny cap used below", validFromGeneration: 1 });
      // Hand-crafted: `encoding = 'utf-8'` but the actual CAS bytes are not
      // valid UTF-8 -- the defensive re-check in `reconcileLexicalProjection`
      // (mirroring `source-indexer.ts`'s scan-time `decodeText`) must catch
      // this rather than throwing or inserting a corrupt document.
      await opened.database.exec("PRAGMA foreign_keys = OFF");
      await opened.database.run("INSERT OR IGNORE INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind, artifact_payload) VALUES ('art-corrupt', ?, 'art-corrupt', 'art-corrupt', 'art-corrupt', 'physical_file', ?)", [workspaceId, new Uint8Array([1])]);
      const corruptBytes = new Uint8Array([0xff, 0xfe, 0x00]);
      const corruptBlob = await cas.put(corruptBytes);
      await opened.database.run("INSERT OR IGNORE INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)", [corruptBlob.content_blob_id, corruptBlob.content_hash, corruptBlob.byte_length, corruptBlob.storage_reference]);
      await opened.database.run(
        "INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation, artifact_version_payload) VALUES ('artv-corrupt', ?, 'art-corrupt', ?, ?, ?, 'utf-8', 'text', 'digest', 'obs-1', 1, NULL, ?)",
        [workspaceId, corruptBlob.content_blob_id, corruptBlob.content_hash, corruptBlob.byte_length, new Uint8Array([1])],
      );
      await setCurrentGeneration(opened, workspaceId, 1);

      let readCalledForBigFile = false;
      const content: LexicalReconcilerContentReader = {
        async read(hash) {
          const bigRow = await opened.database.get<{ content_hash: string }>("SELECT content_hash FROM artifact_versions WHERE artifact_version_id = 'artv-big'");
          if (hash === bigRow?.content_hash) readCalledForBigFile = true;
          return cas.read(hash);
        },
      };

      const result = await reconcileLexicalProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content, max_document_bytes: 5 });
      expect(result.skipped_oversized).toBe(1);
      expect(result.skipped_undecodable).toBe(1);
      expect(result.inserted).toBe(0);
      expect(result.marker_written).toBe(true);
      expect(readCalledForBigFile).toBe(false);
      expect(await lexicalDocumentRow(opened, "artv-big")).toBeUndefined();
      expect(await lexicalDocumentRow(opened, "artv-corrupt")).toBeUndefined();
    });
  });

  it("is a no-op returning generation 0 for a workspace that has never published", async () => {
    const workspaceId = "ws-lexical-unpublished";
    await withWorkspace(workspaceId, async (opened, cas) => {
      const result = await reconcileLexicalProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas });
      expect(result).toEqual({ generation: 0, closed: 0, inserted: 0, skipped_oversized: 0, skipped_undecodable: 0, marker_written: false });
    });
  });
});
